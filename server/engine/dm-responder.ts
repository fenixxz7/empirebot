import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

interface DmConfig {
  enabled: boolean;
  min_delay_msg: number;
  max_delay_msg: number;
  min_delay_user: number;
  max_delay_user: number;
}

interface DmMessage {
  id: number;
  position: number;
  body: string;
}

interface PendingUser {
  channelId: string;
  userId: string;
}

export class DmResponder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queue: PendingUser[] = [];
  private processing = false;

  constructor(private readonly instanceId: number) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(5_000);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().catch(() => {}).finally(() => {
        if (this.running) this.scheduleNext(60_000);
      });
    }, delayMs);
  }

  private async tick() {
    const cfg = await this.loadConfig();
    if (!cfg || !cfg.enabled) return;

    const tokens = await query<{ value: string }>(
      `SELECT value FROM tokens WHERE instance_id = $1 AND status = 'connected' ORDER BY position ASC`,
      [this.instanceId]
    );
    if (tokens.length === 0) return;

    const messages = await this.loadMessages();
    if (messages.length === 0) return;

    const allPending: PendingUser[] = [];

    for (const tok of tokens) {
      const rest = new DiscordRest(tok.value);
      const res = await rest.listMessageRequests();
      if (!res.data) continue;

      for (const ch of res.data) {
        if (!ch.is_message_request) continue;
        const recipient = ch.recipients?.[0];
        if (!recipient) continue;

        const alreadyDone = await query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
          [this.instanceId, recipient.id]
        );
        if (Number(alreadyDone[0]?.c ?? 0) > 0) continue;

        const alreadyQueued = allPending.some((p) => p.userId === recipient.id);
        if (alreadyQueued) continue;

        allPending.push({ channelId: ch.id, userId: recipient.id });
      }
    }

    for (const pending of allPending) {
      if (!this.queue.some((q) => q.userId === pending.userId)) {
        this.queue.push(pending);
      }
    }

    if (!this.processing && this.queue.length > 0) {
      this.processQueue(cfg, messages, tokens[0]!.value);
    }
  }

  private async processQueue(cfg: DmConfig, messages: DmMessage[], token: string) {
    this.processing = true;
    const rest = new DiscordRest(token);

    while (this.queue.length > 0 && this.running) {
      const pending = this.queue.shift()!;

      const alreadyDone = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
        [this.instanceId, pending.userId]
      );
      if (Number(alreadyDone[0]?.c ?? 0) > 0) continue;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (i > 0) {
          const delayMs = randBetween(cfg.min_delay_msg, cfg.max_delay_msg) * 1000;
          await sleep(delayMs);
        }
        await rest.triggerTyping(pending.channelId);
        await sleep(600 + Math.random() * 400);
        await rest.sendDM(pending.channelId, msg.body);
      }

      await query(
        `INSERT INTO dm_responded (instance_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [this.instanceId, pending.userId]
      );

      if (this.queue.length > 0 && this.running) {
        const userDelayMs = randBetween(cfg.min_delay_user, cfg.max_delay_user) * 1000;
        await sleep(userDelayMs);
      }
    }

    this.processing = false;
  }

  private async loadConfig(): Promise<DmConfig | null> {
    const rows = await query<DmConfig>(
      `SELECT enabled, min_delay_msg, max_delay_msg, min_delay_user, max_delay_user
       FROM dm_config WHERE instance_id = $1`,
      [this.instanceId]
    );
    return rows[0] ?? null;
  }

  private async loadMessages(): Promise<DmMessage[]> {
    return query<DmMessage>(
      `SELECT id, position, body FROM dm_messages WHERE instance_id = $1 ORDER BY position ASC`,
      [this.instanceId]
    );
  }
}
