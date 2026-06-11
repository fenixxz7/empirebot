import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";
import type { MatchHandler, MatchToken } from "./match_handler.js";

const TICK_MS = 12_000;
const SEEN_TTL_MS = 120_000;      // 2 min — TTL curto para não bloquear canais reciclados
const MAX_CHANNEL_AGE_MS = 180_000; // 3 min — ignora canais/threads sem atividade recente

const MATCH_PATTERNS = [
  /^fila-\d+$/i,
  /^partida-\d+$/i,
  /^sua[\s_-]partida[\s_-]\d+$/i,
  /^aguardando-\d+$/i,
  /^aguardando[\s_]\d+$/i,
  /^partida[\s]\d+$/i,
  /^aguardando\d+$/i,
];

const TEXT_TYPES = new Set([0]);
const THREAD_TYPES = new Set([10, 11, 12]);

/** Converte snowflake Discord → timestamp Unix (ms). Usado para filtro de idade. */
function snowflakeToTimestamp(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

function isMatchName(name: string | undefined | null): boolean {
  if (!name) return false;
  return MATCH_PATTERNS.some((r) => r.test(name));
}

export interface PollerHost {
  log(instanceId: number, level: string, source: string, message: string): Promise<void>;
  getMatchTokens(instanceId: number): MatchToken[];
}

interface CachedSeen {
  keys: Set<string>;   // chave = match_key (channel_id ou channel_id:last_message_id)
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
    if (cached && cached.expiresAt > now) return cached.keys;
    const fresh: CachedSeen = {
      keys: new Set<string>(),
      expiresAt: now + SEEN_TTL_MS,
    };
    this.seen.set(this.instanceId, fresh);
    return fresh.keys;
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

        interface Candidate {
          id: string;
          name: string;
          type: number;
          last_message_id: string | null;
          parent_id?: string | null;
          permission_overwrites?: Array<{ id: string; type: number }>;
          thread_metadata?: { archived?: boolean; locked?: boolean };
        }
        const candidates: Candidate[] = [];

        // ── Canais de texto ──────────────────────────────────────────────────
        const chRes = await this.safe(() => rest.listGuildChannels(gid));
        if (chRes && chRes.status === 200 && Array.isArray(chRes.data)) {
          for (const c of chRes.data) {
            if (!TEXT_TYPES.has(c.type)) continue;
            if (!isMatchName(c.name)) continue;
            const hasMe = (c.permission_overwrites ?? []).some(
              (ow: { id: string; type: number }) => ow.type === 1 && myIds.has(ow.id),
            );
            if (!hasMe) continue;
            // Filtro de idade: last_message_id indica atividade recente; fallback = criação do canal
            const refId: string = c.last_message_id ?? c.id;
            const ageMs = Date.now() - snowflakeToTimestamp(refId);
            if (ageMs > MAX_CHANNEL_AGE_MS) {
              await this.host.log(this.instanceId, "INFO", "match",
                `[poller] #${c.name} ignorado — ignored_reason=too_old_poll ageMs=${ageMs} last_msg=${c.last_message_id ?? "none"} channel_id=${c.id}`);
              continue;
            }
            candidates.push({
              id: c.id,
              name: c.name,
              type: c.type,
              last_message_id: c.last_message_id ?? null,
              parent_id: c.parent_id ?? null,
              permission_overwrites: c.permission_overwrites,
            });
          }
        }

        // ── Threads ativas ────────────────────────────────────────────────────
        const thRes = await this.safe(() => rest.listGuildActiveThreads(gid));
        if (thRes && thRes.status === 200 && thRes.data?.threads) {
          for (const t of thRes.data.threads) {
            if (!THREAD_TYPES.has(t.type)) continue;
            if (!isMatchName(t.name)) {
              // Log diagnóstico: thread com nome inesperado — ajuda a identificar orgs
              // cujos canais de partida usam padrão diferente (ex: SURF, WURF).
              const refId2: string = t.last_message_id ?? t.id;
              const age2 = Date.now() - snowflakeToTimestamp(refId2);
              if (age2 < MAX_CHANNEL_AGE_MS) {
                await this.host.log(this.instanceId, "INFO", "match",
                  `[poller] ${o.name}: thread ativa ignorada — nome_sem_match="${t.name}" type=${t.type} channel_id=${t.id} age=${Math.round(age2 / 1000)}s`);
              }
              continue;
            }
            if (t.thread_metadata?.archived || t.thread_metadata?.locked) continue;
            const refId: string = t.last_message_id ?? t.id;
            const ageMs = Date.now() - snowflakeToTimestamp(refId);
            if (ageMs > MAX_CHANNEL_AGE_MS) {
              await this.host.log(this.instanceId, "INFO", "match",
                `[poller] #${t.name} ignorado — ignored_reason=too_old_poll ageMs=${ageMs} last_msg=${t.last_message_id ?? "none"} channel_id=${t.id}`);
              continue;
            }
            candidates.push({
              id: t.id,
              name: t.name,
              type: t.type,
              last_message_id: t.last_message_id ?? null,
              parent_id: t.parent_id ?? null,
              thread_metadata: t.thread_metadata,
            });
          }
        }

        // ── Checagem batch de já-enviados no DB (uma query por org/tick) ─────
        let sentMatchKeys = new Set<string>();
        if (candidates.length > 0) {
          const channelIds = candidates.map((c) => c.id);
          const sentRows = await query<{ match_key: string }>(
            `SELECT match_key FROM matches
             WHERE instance_id = $1 AND channel_id = ANY($2) AND msg_sent = true`,
            [this.instanceId, channelIds],
          ).catch(() => [] as Array<{ match_key: string }>);
          sentMatchKeys = new Set(sentRows.map((r) => r.match_key));
        }

        // ── Processa candidatos ───────────────────────────────────────────────
        let processed = 0;
        let skippedSent = 0;
        let skippedSeen = 0;

        for (const c of candidates) {
          // match_key consistente com a lógica do handler
          const lmid = c.last_message_id;
          const matchKey = lmid && lmid !== c.id ? `${c.id}:${lmid}` : c.id;

          // 1) Já tem msg_sent=true no DB para esta match_key
          if (sentMatchKeys.has(matchKey)) {
            seen.add(matchKey);
            skippedSent++;
            await this.host.log(this.instanceId, "INFO", "match",
              `[poller] #${c.name} ignorado — ignored_reason=already_sent match_key=${matchKey} channel_id=${c.id} last_msg=${lmid ?? "none"}`);
            continue;
          }

          // 2) Já visto nesta sessão (within SEEN_TTL_MS)
          if (seen.has(matchKey)) {
            skippedSeen++;
            continue;
          }
          seen.add(matchKey);

          const isThread = THREAD_TYPES.has(c.type);
          processed++;
          await this.host.log(this.instanceId, "INFO", "match",
            `[poller] achou ${isThread ? "thread" : "canal"} #${c.name} em ${o.name} channel_id=${c.id} last_msg=${lmid ?? "none"} match_key=${matchKey}`);

          await this.handler.onChannelCreate(
            {
              id: c.id,
              name: c.name,
              guild_id: gid,
              type: c.type,
              parent_id: c.parent_id,
              permission_overwrites: c.permission_overwrites,
              thread_metadata: c.thread_metadata,
              last_message_id: lmid,
            },
            tokens,
          );
        }

        // Log de resumo só quando há algo para reportar
        if (processed > 0 || skippedSent > 0) {
          await this.host.log(this.instanceId, "INFO", "match",
            `[poller] ${o.name}: candidatos=${candidates.length} processados=${processed} skip_sent=${skippedSent} skip_seen=${skippedSeen}`);
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
