import { query } from "../db/pool.js";
import { DiscordRest, type DiscordMessage } from "../discord/rest.js";

export interface ActiveToken {
  tokenId: number;
  position: number;
  token: string;
  sessionId: string;
  userId: string;
}

export interface RunnerHost {
  getActiveTokens(instanceId: number): ActiveToken[];
  log(instanceId: number, level: string, source: string, message: string): Promise<void>;
}

interface ChannelRow {
  channel_id: string;
  channel_name: string | null;
  category: string | null;
  mode: string | null;
  message_id: string;
  embed_title: string | null;
  embed_valor: string | null;
  application_id: string | null;
  buttons: Array<{
    label: string;
    custom_id: string | null;
    action: string | null;
    variant: string | null;
    disabled: boolean;
  }>;
  org_id: number;
  org_name: string;
  guild_id: string | null;
  max_queues: number;
}

interface CycleConfig {
  delay_seconds: number;
  allowed_modes: string[];
  allowed_categories: string[];
  selected_org_ids: number[];
}

const STARTUP_GRACE_MS = 5000;
const NO_TOKEN_LOG_INTERVAL_MS = 30_000;
const NO_WORK_LOG_INTERVAL_MS = 60_000;
const PLAYER_CACHE_MS = 25_000;
const MAX_FRESH_FETCH_PER_TICK = 6;

interface PlayerInfo {
  count: number;
  ts: number;
}

export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private orgCursor = 0;
  private tokenRotation = 0;
  private lastNoTokenLog = 0;
  private lastNoWorkLog = 0;
  private playerCache = new Map<string, PlayerInfo>();

  constructor(
    private readonly instanceId: number,
    private readonly manager: RunnerHost,
  ) {}

  start(): void {
    this.stopped = false;
    this.orgCursor = 0;
    this.tokenRotation = 0;
    this.timer = setTimeout(() => this.tick(), STARTUP_GRACE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let baseDelayMs = 12_000;
    try {
      const cfg = await this.loadConfig();
      baseDelayMs = Math.max(1000, cfg.delay_seconds * 1000);
      await this.iterate(cfg);
    } catch (err) {
      await this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `tick falhou: ${(err as Error).message}`,
      );
    } finally {
      if (!this.stopped) {
        const jitter = 0.7 + Math.random() * 0.6;
        const next = Math.max(800, Math.floor(baseDelayMs * jitter));
        this.timer = setTimeout(() => this.tick(), next);
      }
    }
  }

  private async loadConfig(): Promise<CycleConfig> {
    const cfgRows = await query<{
      delay_seconds: number;
      allowed_modes: string;
      allowed_categories: string;
    }>(
      `SELECT delay_seconds, allowed_modes, allowed_categories
       FROM instance_configs
       WHERE instance_id = $1`,
      [this.instanceId],
    );
    const orgRows = await query<{ org_id: number }>(
      `SELECT io.org_id
       FROM instance_orgs io
       JOIN orgs o ON o.id = io.org_id
       WHERE io.instance_id = $1
       ORDER BY o.priority DESC, o.id ASC`,
      [this.instanceId],
    );
    return {
      delay_seconds: cfgRows[0]?.delay_seconds ?? 12,
      allowed_modes: parseList(cfgRows[0]?.allowed_modes ?? "").map(normalizeMode).filter((m): m is string => m !== null),
      allowed_categories: parseList(cfgRows[0]?.allowed_categories ?? ""),
      selected_org_ids: orgRows.map((r) => r.org_id),
    };
  }

  private async iterate(cfg: CycleConfig): Promise<void> {
    const tokens = this.manager.getActiveTokens(this.instanceId);
    if (tokens.length === 0) {
      this.maybeLog("noToken", "Aguardando ao menos um token conectado…");
      return;
    }
    if (
      cfg.selected_org_ids.length === 0 ||
      cfg.allowed_modes.length === 0 ||
      cfg.allowed_categories.length === 0
    ) {
      this.maybeLog(
        "noWork",
        "Nada pra fazer — sem orgs, modos ou categorias selecionadas.",
      );
      return;
    }

    const channels = await this.loadChannels(
      cfg.selected_org_ids,
      cfg.allowed_modes,
      cfg.allowed_categories,
    );
    if (channels.length === 0) {
      this.maybeLog(
        "noWork",
        "Nenhuma fila encontrada pras orgs/modos/categorias atuais — salve a config pra descobrir.",
      );
      return;
    }

    const activeRows = await query<{
      channel_id: string;
      message_id: string;
      org_id: number;
    }>(
      `SELECT channel_id, message_id, org_id
       FROM active_queues WHERE instance_id = $1`,
      [this.instanceId],
    );
    const activeKeys = new Set(
      activeRows.map((r) => `${r.channel_id}:${r.message_id}`),
    );
    const activePerOrg = new Map<number, number>();
    for (const r of activeRows) {
      activePerOrg.set(r.org_id, (activePerOrg.get(r.org_id) ?? 0) + 1);
    }
    await this.refreshNaFila(activeRows.length);

    const orgIds = cfg.selected_org_ids;
    const totalOrgs = orgIds.length;
    let attempts = 0;
    let candidate: ChannelRow | null = null;
    let candidatePlayers = 0;
    let advancedDueToFull = false;

    while (attempts < totalOrgs) {
      const currentOrgId = orgIds[this.orgCursor % totalOrgs];
      const orgChannels = channels.filter((c) => c.org_id === currentOrgId);
      const maxForOrg = orgChannels[0]?.max_queues ?? 5;
      const activeForOrg = activePerOrg.get(currentOrgId) ?? 0;

      // max_queues é limite concorrente: se já tem o máximo de filas ativas, pula
      if (activeForOrg >= maxForOrg) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        advancedDueToFull = true;
        continue;
      }

      const eligible = orgChannels.filter((c) => {
        const key = `${c.channel_id}:${c.message_id}`;
        if (activeKeys.has(key)) return false;
        if (!c.guild_id || !c.message_id || !c.application_id) return false;
        return pickEnterButton(c.buttons) !== null;
      });

      if (eligible.length === 0) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }

      const token = tokens[this.tokenRotation % tokens.length];
      const ranked = await this.rankCandidatesByPlayers(eligible, token.token);
      candidate = ranked.choice;
      candidatePlayers = ranked.players;
      break;
    }

    if (!candidate) {
      const msg = advancedDueToFull
        ? `Todas as orgs no limite — ${activeRows.length} fila(s) ativa(s).`
        : `Nada novo pra entrar — ${activeRows.length} fila(s) ativa(s).`;
      this.maybeLog("noWork", msg);
      return;
    }

    const token = tokens[this.tokenRotation % tokens.length];
    this.tokenRotation = (this.tokenRotation + 1) % Math.max(1, tokens.length);

    await sleep(350 + Math.floor(Math.random() * 1150));

    await this.joinQueue(candidate, token, activeRows.length, candidatePlayers);
  }

  private async rankCandidatesByPlayers(
    candidates: ChannelRow[],
    token: string,
  ): Promise<{ choice: ChannelRow | null; players: number }> {
    const rest = new DiscordRest(token);
    const now = Date.now();
    const keyOf = (c: ChannelRow) => `${c.channel_id}:${c.message_id}`;

    const stale = candidates
      .filter((c) => {
        const cached = this.playerCache.get(keyOf(c));
        return !cached || now - cached.ts > PLAYER_CACHE_MS;
      })
      .slice(0, MAX_FRESH_FETCH_PER_TICK);

    for (const c of stale) {
      if (!c.message_id) continue;
      await sleep(120 + Math.floor(Math.random() * 200));
      const r = await rest.fetchMessage(c.channel_id, c.message_id);
      if (r.status === 200 && r.data) {
        const cnt = countPlayers(r.data);
        this.playerCache.set(keyOf(c), { count: cnt, ts: Date.now() });
      } else if (r.status === 404) {
        this.playerCache.set(keyOf(c), { count: 0, ts: Date.now() });
      }
    }

    const scored = candidates.map((c) => {
      const cached = this.playerCache.get(keyOf(c));
      return { ch: c, players: cached?.count ?? 0 };
    });
    scored.sort((a, b) => b.players - a.players);

    return {
      choice: scored[0]?.ch ?? null,
      players: scored[0]?.players ?? 0,
    };
  }

  private async joinQueue(
    ch: ChannelRow,
    token: ActiveToken,
    activeCount: number,
    playersInQueue: number,
  ): Promise<void> {
    const btn = pickEnterButton(ch.buttons);
    if (!btn || !btn.custom_id) return;

    const rest = new DiscordRest(token.token);
    const r = await rest.clickButton({
      guildId: ch.guild_id!,
      channelId: ch.channel_id,
      messageId: ch.message_id!,
      applicationId: ch.application_id!,
      sessionId: token.sessionId,
      customId: btn.custom_id,
    });

    const success = r.status >= 200 && r.status < 300;
    const tag = playersInQueue > 0 ? `🎯 com ${playersInQueue} player(s)` : "vazia (esperando)";
    const modeLabel = ch.embed_valor
      ? `${ch.mode ?? "?"} | ${ch.embed_valor}`
      : (ch.mode ?? "?");

    if (success) {
      await query(
        `INSERT INTO active_queues
           (instance_id, org_id, channel_id, message_id, mode, category, token_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (instance_id, channel_id, message_id) DO NOTHING`,
        [
          this.instanceId,
          ch.org_id,
          ch.channel_id,
          ch.message_id,
          ch.mode,
          ch.category,
          token.tokenId,
        ],
      );
      await query(
        `UPDATE stats SET entradas = entradas + 1, na_fila = $2
         WHERE instance_id = $1`,
        [this.instanceId, activeCount + 1],
      );
      await query(
        `UPDATE tokens SET last_used_at = NOW() WHERE id = $1`,
        [token.tokenId],
      );
      this.playerCache.delete(`${ch.channel_id}:${ch.message_id}`);
      await this.manager.log(
        this.instanceId,
        "INFO",
        "engine",
        `Entrou em ${ch.org_name} · ${ch.category ?? "?"} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} (${tag}) · "${btn.label}" · token #${token.position}`,
      );
    } else if (r.status === 429) {
      await this.manager.log(
        this.instanceId,
        "WARN",
        "engine",
        `Rate-limited ao tentar ${ch.org_name} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} — vou esperar.`,
      );
    } else {
      await this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `Falhou ${ch.org_name} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id}: HTTP ${r.status} ${r.error?.slice(0, 120) ?? ""}`,
      );
    }
  }

  private async loadChannels(
    orgIds: number[],
    allowedModes: string[],
    allowedCategories: string[],
  ): Promise<ChannelRow[]> {
    if (orgIds.length === 0 || allowedCategories.length === 0) return [];
    const rows = await query<{
      channel_id: string;
      channel_name: string | null;
      category: string | null;
      mode: string | null;
      message_id: string;
      embed_title: string | null;
      embed_valor: string | null;
      application_id: string | null;
      buttons: ChannelRow["buttons"];
      org_id: number;
      org_name: string;
      guild_id: string | null;
      max_queues: number;
    }>(
      `SELECT oc.channel_id, oc.channel_name, oc.category, oc.mode, oc.message_id,
              oc.embed_title, oc.embed_valor, oc.application_id, oc.buttons,
              o.id AS org_id, o.name AS org_name,
              o.guild_id, o.max_queues
       FROM org_channels oc
       JOIN orgs o ON o.id = oc.org_id
       WHERE oc.org_id = ANY($1::int[])
         AND oc.mode IS NOT NULL
         AND oc.mode = ANY($2::text[])
         AND oc.category IS NOT NULL
         AND oc.category = ANY($3::text[])
       ORDER BY o.priority DESC, o.id ASC, oc.mode ASC, oc.channel_id ASC, oc.id ASC`,
      [orgIds, allowedModes, allowedCategories],
    );
    return rows;
  }

  private async refreshNaFila(count: number): Promise<void> {
    await query(`UPDATE stats SET na_fila = $2 WHERE instance_id = $1`, [
      this.instanceId,
      count,
    ]);
  }

  private maybeLog(kind: "noToken" | "noWork", message: string): void {
    const now = Date.now();
    if (kind === "noToken") {
      if (now - this.lastNoTokenLog < NO_TOKEN_LOG_INTERVAL_MS) return;
      this.lastNoTokenLog = now;
    } else {
      if (now - this.lastNoWorkLog < NO_WORK_LOG_INTERVAL_MS) return;
      this.lastNoWorkLog = now;
    }
    void this.manager.log(this.instanceId, "INFO", "engine", message);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseList(raw: string): string[] {
  return raw
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeMode(s: string): string | null {
  const lower = s.toLowerCase();
  const m = lower.match(/(\d)\s*[xv]\s*(\d)/);
  if (m && m[1] === m[2]) return `${m[1]}x${m[1]}`;
  const m2 = lower.match(/^x?(\d)$/);
  if (m2) return `${m2[1]}x${m2[1]}`;
  return null;
}

/**
 * Escolhe o melhor botão de "entrar" disponível no card da fila.
 * Aceita action ∈ { enter, play, other } — exclui "leave" e desabilitados.
 *
 * Ordem de preferência:
 *   1. action=enter, variant=null/normal       (ex: "Entrar")
 *   2. action=play,  variant=null/normal       (ex: "Jogar Normal")
 *   3. action=other, variant=null/normal/gel_normal (ex: "Gel Normal", "1 Emu")
 *   4. action=enter|play, qualquer outro variant  (ex: "Jogar Full UMP & XM8")
 *   5. action=other, qualquer outro variant       (ex: "Gel Inf", "2 Emu")
 */
function pickEnterButton(buttons: ChannelRow["buttons"]) {
  const usable = buttons.filter(
    (b) =>
      !b.disabled &&
      b.custom_id &&
      b.action !== "leave" &&
      b.action !== null,
  );
  if (usable.length === 0) return null;

  const isNormalish = (v: string | null) =>
    v === null || v === "normal" || v === "gel_normal";

  const tiers: Array<(b: typeof usable[number]) => boolean> = [
    (b) => b.action === "enter" && (b.variant === null || b.variant === "normal"),
    (b) => b.action === "play" && (b.variant === null || b.variant === "normal"),
    (b) => b.action === "other" && isNormalish(b.variant),
    (b) => (b.action === "enter" || b.action === "play"),
    (b) => b.action === "other",
  ];

  for (const t of tiers) {
    const found = usable.find(t);
    if (found) return found;
  }
  return usable[0];
}

function countPlayers(msg: DiscordMessage): number {
  const parts: string[] = [];
  for (const e of msg.embeds ?? []) {
    if (e.description) parts.push(e.description);
    for (const f of e.fields ?? []) {
      if (f.value) parts.push(f.value);
    }
  }
  const text = parts.join("\n");
  if (!text) return 0;
  const matches = text.match(/<@!?\d+>/g);
  if (!matches) return 0;
  const unique = new Set(matches);
  return unique.size;
}
