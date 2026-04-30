import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";
import type { MatchHandler, MatchToken } from "./match_handler.js";

const TICK_MS = 8_000;

const MATCH_PATTERNS = [
  /^fila-\d+$/i,
  /^partida-\d+$/i,
  /^sua[\s_-]partida[\s_-]\d+$/i,
];

const TEXT_TYPES = new Set([0]);
const THREAD_TYPES = new Set([10, 11, 12]);

function isMatchName(name: string | undefined | null): boolean {
  if (!name) return false;
  return MATCH_PATTERNS.some((r) => r.test(name));
}

export interface PollerHost {
  log(instanceId: number, level: string, source: string, message: string): Promise<void>;
  getMatchTokens(instanceId: number): MatchToken[];
}

interface CachedSeen {
  channelIds: Set<string>;
  expiresAt: number;
}

export class MatchPoller {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private seen = new Map<number, CachedSeen>();

  constructor(
    private readonly instanceId: number,
    private readonly host: PollerHost,
    private readonly handler: MatchHandler,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        this.host.log(
          this.instanceId,
          "WARN",
          "match",
          `Poller tick falhou: ${(err as Error).message}`,
        ).catch(() => {}),
      );
    }, TICK_MS);
    setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.seen.clear();
  }

  private getSeen(): Set<string> {
    const now = Date.now();
    const cached = this.seen.get(this.instanceId);
    if (cached && cached.expiresAt > now) return cached.channelIds;
    const fresh: CachedSeen = {
      channelIds: new Set<string>(),
      expiresAt: now + 30 * 60_000,
    };
    this.seen.set(this.instanceId, fresh);
    return fresh.channelIds;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const tokens = this.host.getMatchTokens(this.instanceId);
      if (tokens.length === 0) return;
      const sender = tokens[0]!;
      const myIds = new Set(tokens.map((t) => t.userId));

      const orgs = await query<{ id: number; name: string; guild_id: string | null }>(
        `SELECT o.id, o.name, o.guild_id
         FROM orgs o
         JOIN instance_orgs io ON io.org_id = o.id
         WHERE io.instance_id = $1 AND o.guild_id IS NOT NULL AND o.guild_id <> ''`,
        [this.instanceId],
      );
      if (orgs.length === 0) return;

      const seen = this.getSeen();
      const rest = new DiscordRest(sender.token);

      for (const o of orgs) {
        const gid = o.guild_id!;
        let foundChannels = 0;
        let foundThreads = 0;

        const chRes = await this.safe(() => rest.listGuildChannels(gid));
        if (chRes && chRes.status === 200 && Array.isArray(chRes.data)) {
          for (const c of chRes.data) {
            if (!TEXT_TYPES.has(c.type)) continue;
            if (!isMatchName(c.name)) continue;
            if (seen.has(c.id)) continue;
            const hasMe = (c.permission_overwrites ?? []).some(
              (ow) => ow.type === 1 && myIds.has(ow.id),
            );
            if (!hasMe) continue;
            seen.add(c.id);
            foundChannels += 1;
            await this.host.log(
              this.instanceId,
              "INFO",
              "match",
              `Poller achou canal #${c.name} em ${o.name}`,
            );
            await this.handler.onChannelCreate(
              {
                id: c.id,
                name: c.name,
                guild_id: gid,
                type: c.type,
                parent_id: c.parent_id,
                permission_overwrites: c.permission_overwrites,
              },
              tokens,
            );
          }
        }

        const thRes = await this.safe(() => rest.listGuildActiveThreads(gid));
        if (thRes && thRes.status === 200 && thRes.data?.threads) {
          // Não exigimos membership: o handler tem idempotência via DB e
          // a mensagem só sai se conseguirmos POST no canal. Se não somos
          // membros, o POST falha e o seen é "queimado" — sem efeito ruim.
          for (const t of thRes.data.threads) {
            if (!THREAD_TYPES.has(t.type)) continue;
            if (!isMatchName(t.name)) continue;
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            foundThreads += 1;
            await this.host.log(
              this.instanceId,
              "INFO",
              "match",
              `Poller achou thread #${t.name} em ${o.name}`,
            );
            await this.handler.onChannelCreate(
              {
                id: t.id,
                name: t.name,
                guild_id: gid,
                type: t.type,
                parent_id: t.parent_id,
                thread_metadata: t.thread_metadata,
              },
              tokens,
            );
          }
        }

        // Log diagnóstico — sempre logamos resumo do poller por org/tick
        const total = (chRes?.status === 200 && Array.isArray(chRes?.data)
          ? chRes.data.length
          : 0);
        const totalTh = thRes?.status === 200 && thRes?.data?.threads
          ? thRes.data.threads.length
          : 0;
        if (foundChannels > 0 || foundThreads > 0) {
          await this.host.log(
            this.instanceId,
            "INFO",
            "match",
            `Poller ${o.name}: canais=${total} threads=${totalTh} novos(canais=${foundChannels} threads=${foundThreads})`,
          );
        }

        await sleep(150 + Math.random() * 200);
      }
    } finally {
      this.busy = false;
    }
  }

  private async safe<T>(
    fn: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
