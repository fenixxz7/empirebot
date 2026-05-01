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
  username: string;
  addedAt: number;
}

export interface QueueSnapshot {
  enabled: boolean;
  processing: { userId: string; username: string; msgIndex: number; totalMsgs: number } | null;
  waiting: { userId: string; username: string; position: number; addedAt: number }[];
  respondedToday: number;
  respondedTotal: number;
}

export class DmResponder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queue: PendingUser[] = [];
  private currentlyProcessing: PendingUser | null = null;
  private currentMsgIndex = 0;
  private totalMsgs = 0;
  private enabled = false;

  constructor(private readonly instanceId: number) {}

  private async log(level: "INFO" | "WARN" | "ERROR", message: string): Promise<void> {
    await query(
      `INSERT INTO logs (instance_id, level, source, message) VALUES ($1, $2, 'dm', $3)`,
      [this.instanceId, level, message],
    ).catch(() => {});
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.enabled = true;
    this.scheduleNext(5_000);
  }

  stop() {
    this.running = false;
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async getSnapshot(): Promise<QueueSnapshot> {
    const respondedRows = await query<{ total: string; today: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE responded_at >= NOW() - INTERVAL '24 hours')::text AS today
       FROM dm_responded WHERE instance_id = $1`,
      [this.instanceId]
    );

    return {
      enabled: this.enabled,
      processing: this.currentlyProcessing
        ? {
            userId: this.currentlyProcessing.userId,
            username: this.currentlyProcessing.username,
            msgIndex: this.currentMsgIndex,
            totalMsgs: this.totalMsgs,
          }
        : null,
      waiting: this.queue.map((u, i) => ({
        userId: u.userId,
        username: u.username,
        position: i + 1,
        addedAt: u.addedAt,
      })),
      respondedToday: Number(respondedRows[0]?.today ?? 0),
      respondedTotal: Number(respondedRows[0]?.total ?? 0),
    };
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

        const alreadyPending = allPending.some((p) => p.userId === recipient.id);
        if (alreadyPending) continue;

        allPending.push({
          channelId: ch.id,
          userId: recipient.id,
          username: recipient.global_name ?? recipient.username ?? recipient.id,
          addedAt: Date.now(),
        });
      }
    }

    // Adiciona só os novos — não substitui quem já está na fila aguardando
    for (const pending of allPending) {
      const alreadyQueued = this.queue.some((q) => q.userId === pending.userId);
      const isProcessingNow = this.currentlyProcessing?.userId === pending.userId;
      if (!alreadyQueued && !isProcessingNow) {
        this.queue.push(pending);
      }
    }

    if (!this.currentlyProcessing && this.queue.length > 0) {
      this.processQueue(cfg, messages, tokens[0]!.value);
    }
  }

  private async processQueue(cfg: DmConfig, messages: DmMessage[], token: string) {
    const rest = new DiscordRest(token);
    this.totalMsgs = messages.length;

    while (this.queue.length > 0 && this.running) {
      const pending = this.queue.shift()!;
      this.currentlyProcessing = pending;
      this.currentMsgIndex = 0;

      const alreadyDone = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
        [this.instanceId, pending.userId]
      );
      if (Number(alreadyDone[0]?.c ?? 0) > 0) {
        this.currentlyProcessing = null;
        continue;
      }

      // Recarrega mensagens em tempo real (respeita edições feitas enquanto processa)
      const freshMessages = await this.loadMessages();
      this.totalMsgs = freshMessages.length;

      for (let i = 0; i < freshMessages.length; i++) {
        this.currentMsgIndex = i;
        const msg = freshMessages[i]!;
        if (i > 0) {
          const delayMs = randBetween(cfg.min_delay_msg, cfg.max_delay_msg) * 1000;
          await sleep(delayMs);
        }
        await rest.triggerTyping(pending.channelId);
        await sleep(600 + Math.random() * 400);
        const dmResult = await rest.sendDM(pending.channelId, msg.body);
        if (dmResult.status === 403) {
          await this.log("WARN", `DM bloqueada para usuário ${pending.userId} — HTTP 403 (usuário bloqueou ou desativou DMs). Pulando.`);
          break;
        } else if (dmResult.status === 50007) {
          await this.log("WARN", `DM não permitida para usuário ${pending.userId} (código 50007 — cannot send messages to this user). Pulando.`);
          break;
        } else if (dmResult.status >= 400) {
          await this.log("ERROR", `Falha ao enviar DM para usuário ${pending.userId}: HTTP ${dmResult.status}`);
          break;
        }
      }

      await query(
        `INSERT INTO dm_responded (instance_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [this.instanceId, pending.userId]
      );

      this.currentlyProcessing = null;

      if (this.queue.length > 0 && this.running) {
        const userDelayMs = randBetween(cfg.min_delay_user, cfg.max_delay_user) * 1000;
        await sleep(userDelayMs);
      }
    }

    this.currentlyProcessing = null;
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
