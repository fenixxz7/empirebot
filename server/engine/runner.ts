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

type TokenStrategy = "single" | "per_n_orgs" | "full_cycle";

interface CycleConfig {
  delay_seconds: number;
  allowed_modes: string[];
  allowed_categories: string[];
  selected_org_ids: number[];
  blockedNames: string[];
  maxValor: number;
  tokenStrategy: TokenStrategy;
  tokenStrategyN: number;
}

const STARTUP_GRACE_MS = 5000;
// Intervalo fixo do tick — rápido para não atrasar reconhecimento e sweep.
// O cooldown entre entradas de fila é controlado separadamente por nextJoinAt.
const TICK_INTERVAL_MS = 2500;
const NO_TOKEN_LOG_INTERVAL_MS = 30_000;
const NO_WORK_LOG_INTERVAL_MS = 60_000;
const PLAYER_CACHE_MS = 45_000; // estendido — menos REST de leitura
const PLAYER_CACHE_403_MS = 10 * 60_000; // 10 min — não retentar REST 403 tão cedo
const MAX_FRESH_FETCH_PER_TICK = 4; // reduzido de 6 → 4
// Idade máxima de um active_queue antes de virar "fantasma" e ser removido.
const ACTIVE_QUEUE_TTL_MS = 12 * 60 * 1000;
// Long break: a cada 6-12 ações, pausa de ~75-150s (simula desatenção humana).
const LONG_BREAK_AFTER_MIN = 6;
const LONG_BREAK_AFTER_MAX = 12;
const LONG_BREAK_MS_MIN = 75_000;
const LONG_BREAK_MS_MAX = 150_000;
// Backoff extra após rate limit (429), por cima do cooldown de fila.
const RATE_LIMIT_BACKOFF_MIN_MS = 120_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 240_000;

interface PlayerInfo {
  count: number;
  ts: number;
}

export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private orgCursor = 0;
  private lastNoTokenLog = 0;
  private lastNoWorkLog = 0;
  private playerCache = new Map<string, PlayerInfo>();
  private actionsSinceBreak = 0;
  private nextBreakAt = randInt(LONG_BREAK_AFTER_MIN, LONG_BREAK_AFTER_MAX);
  private extraDelayMs = 0;
  private lastSweepAt = 0;
  private nextJoinAt = 0;
  private orgModeCursor = new Map<number, number>();
  private tokenCursor = 0;
  private joinsOnCurrentToken = 0;
  // token_id → Set<org_id>: orgs inválidas por token (ban / acesso negado)
  private tokenOrgBlacklist = new Map<number, Set<number>>();
  private blacklistLoaded = false;

  constructor(
    private readonly instanceId: number,
    private readonly manager: RunnerHost,
  ) {}

  start(): void {
    this.stopped = false;
    this.orgCursor = 0;
    this.tokenCursor = 0;
    this.joinsOnCurrentToken = 0;
    this.tokenOrgBlacklist.clear();
    this.blacklistLoaded = false;
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
    try {
      // Sweep de filas fantasmas a cada 30s (idempotente) — roda independente do cooldown de fila
      await this.sweepGhostQueues();
      const cfg = await this.loadConfig();
      await this.iterate(cfg);
    } catch (err) {
      await this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `tick falhou: ${(err as Error).message}`,
      );
    } finally {
      // Tick rápido e fixo — o cooldown entre entradas é gerenciado por nextJoinAt
      if (!this.stopped) {
        this.timer = setTimeout(() => this.tick(), TICK_INTERVAL_MS);
      }
    }
  }

  /**
   * Remove active_queues mais velhas que ACTIVE_QUEUE_TTL_MS.
   * Filas que não viram partida em ~12 minutos quase sempre foram
   * canceladas/resetadas pelo bot da org sem virar partida — ficam
   * como "fantasmas" travando o slot e impedindo novo round-robin.
   */
  private async sweepGhostQueues(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < 30_000) return;
    this.lastSweepAt = now;
    const removed = await query<{ id: number; org_id: number; channel_id: string }>(
      `DELETE FROM active_queues
       WHERE instance_id = $1
         AND joined_at < NOW() - ($2 || ' milliseconds')::interval
       RETURNING id, org_id, channel_id`,
      [this.instanceId, String(ACTIVE_QUEUE_TTL_MS)],
    );
    if (removed.length > 0) {
      const remaining = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM active_queues WHERE instance_id = $1`,
        [this.instanceId],
      );
      await query(`UPDATE stats SET na_fila = $2 WHERE instance_id = $1`, [
        this.instanceId,
        Number(remaining[0]?.c ?? "0"),
      ]);
      await this.manager.log(
        this.instanceId,
        "INFO",
        "engine",
        `Sweep: removidas ${removed.length} fila(s) fantasma (>12min sem virar partida).`,
      );
      // Força round-robin a recomeçar do topo e limpa cursores de modo
      this.orgCursor = 0;
      this.orgModeCursor.clear();
    }
  }

  private async loadConfig(): Promise<CycleConfig> {
    const cfgRows = await query<{
      delay_seconds: number;
      allowed_modes: string;
      allowed_categories: string;
      blocked_names: string;
      max_valor: number;
      token_strategy: string;
      token_strategy_n: number;
    }>(
      `SELECT delay_seconds, allowed_modes, allowed_categories, blocked_names,
              max_valor, token_strategy, token_strategy_n
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
      delay_seconds: cfgRows[0]?.delay_seconds ?? 18,
      allowed_modes: parseList(cfgRows[0]?.allowed_modes ?? "").map(normalizeMode).filter((m): m is string => m !== null),
      allowed_categories: parseList(cfgRows[0]?.allowed_categories ?? ""),
      selected_org_ids: orgRows.map((r) => r.org_id),
      blockedNames: parseList(cfgRows[0]?.blocked_names ?? "").map((n) => n.toLowerCase()),
      maxValor: Number(cfgRows[0]?.max_valor ?? 0),
      tokenStrategy: (cfgRows[0]?.token_strategy ?? "single") as TokenStrategy,
      tokenStrategyN: Math.max(1, cfgRows[0]?.token_strategy_n ?? 5),
    };
  }

  private async iterate(cfg: CycleConfig): Promise<void> {
    if (Date.now() < this.nextJoinAt) return;

    // Carrega blacklist de orgs por token na primeira execução
    if (!this.blacklistLoaded) await this.loadTokenBlacklist();

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
      cfg.maxValor,
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

      // Seleciona o modo da vez para esta org (round-robin entre modos disponíveis).
      // Ex: 1ª passagem → 1x1, 2ª passagem → 2x2, 3ª → volta pro 1x1, etc.
      const modesPresent = [...new Set(eligible.map((c) => c.mode ?? ""))].sort();
      const modeCurIdx = this.orgModeCursor.get(currentOrgId) ?? 0;
      const selectedMode = modesPresent[modeCurIdx % modesPresent.length];
      const modeEligible = eligible.filter((c) => (c.mode ?? "") === selectedMode);
      // Avança cursor de modo para a próxima passagem nesta org
      this.orgModeCursor.set(currentOrgId, modeCurIdx + 1);

      // Seleciona token ativo com base na estratégia de rotação
      const activeTokenIdx = cfg.tokenStrategy === "single"
        ? 0
        : this.tokenCursor % tokens.length;
      const selectedToken = tokens[activeTokenIdx]!;

      // Filtra canais de orgs bloqueadas para este token específico
      const blacklistedForToken = this.tokenOrgBlacklist.get(selectedToken.tokenId) ?? new Set<number>();
      const candidatesForToken = (modeEligible.length > 0 ? modeEligible : eligible).filter(
        (c) => !blacklistedForToken.has(c.org_id),
      );
      if (candidatesForToken.length === 0) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }

      const ranked = await this.rankCandidatesByPlayers(
        candidatesForToken,
        selectedToken,
        cfg.blockedNames,
      );
      candidate = ranked.choice;
      candidatePlayers = ranked.players;

      // Avança o cursor de org para a próxima somente se a org já vai estar
      // cheia após esta entrada (activeForOrg + 1 >= maxForOrg).
      // Caso ainda haja vagas, mantém o cursor na mesma org para que o próximo
      // tick tente entrar mais filas nela antes de passar adiante.
      const willBeFull = (activeForOrg + 1) >= maxForOrg;
      const prevOrgCursor = this.orgCursor;
      if (willBeFull) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
      }
      // else: cursor permanece na mesma org — próximo tick tenta nova vaga aqui

      // full_cycle: quando a lista de orgs fecha um ciclo completo, troca de token
      if (cfg.tokenStrategy === "full_cycle" && willBeFull && this.orgCursor < prevOrgCursor) {
        this.tokenCursor = (this.tokenCursor + 1) % tokens.length;
        this.joinsOnCurrentToken = 0;
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Ciclo completo — rotacionando para token #${tokens[this.tokenCursor % tokens.length]?.position ?? this.tokenCursor + 1}.`,
        );
      }
      break;
    }

    if (!candidate) {
      if (advancedDueToFull) {
        // Reseta cursor pra org 0: próximo tick já começa da primeira
        this.orgCursor = 0;
        this.maybeLog("noWork", `Todas as orgs no limite — ${activeRows.length} fila(s) ativa(s).`);
      } else {
        this.maybeLog("noWork", `Nada novo pra entrar — ${activeRows.length} fila(s) ativa(s).`);
      }
      return;
    }

    // Token ativo para joinQueue
    const tokenIdx = cfg.tokenStrategy === "single" ? 0 : this.tokenCursor % tokens.length;
    const token = tokens[tokenIdx]!;

    // Pausa humanizada antes de clicar (3s–8s)
    await sleep(3000 + Math.floor(Math.random() * 5000));

    const joined = await this.joinQueue(candidate, token, activeRows.length, candidatePlayers);

    // per_n_orgs: conta entradas no token atual; ao atingir N, rotaciona
    if (joined && cfg.tokenStrategy === "per_n_orgs" && tokens.length > 1) {
      this.joinsOnCurrentToken++;
      if (this.joinsOnCurrentToken >= cfg.tokenStrategyN) {
        this.joinsOnCurrentToken = 0;
        this.tokenCursor = (this.tokenCursor + 1) % tokens.length;
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Rotacionando token após ${cfg.tokenStrategyN} entrada(s) — próximo: token #${tokens[this.tokenCursor % tokens.length]?.position ?? this.tokenCursor + 1}.`,
        );
      }
    }

    // Define o próximo momento permitido para entrar em fila.
    // Jitter largo (1.2–3.5x) para parecer menos robótico.
    const baseDelayMs = Math.max(1000, cfg.delay_seconds * 1000);
    const jitter = 1.2 + Math.random() * 2.3;
    let cooldown = Math.max(8000, Math.floor(baseDelayMs * jitter));
    // Adiciona delay extra acumulado (rate limit / long break) e zera
    if (this.extraDelayMs > 0) {
      cooldown += this.extraDelayMs;
      this.extraDelayMs = 0;
    }
    this.nextJoinAt = Date.now() + cooldown;
  }

  private async loadTokenBlacklist(): Promise<void> {
    const rows = await query<{ token_id: number; org_id: number }>(
      `SELECT b.token_id, b.org_id
       FROM token_org_blacklist b
       JOIN tokens t ON t.id = b.token_id
       WHERE t.instance_id = $1`,
      [this.instanceId],
    );
    this.tokenOrgBlacklist.clear();
    for (const row of rows) {
      if (!this.tokenOrgBlacklist.has(row.token_id)) {
        this.tokenOrgBlacklist.set(row.token_id, new Set());
      }
      this.tokenOrgBlacklist.get(row.token_id)!.add(row.org_id);
    }
    this.blacklistLoaded = true;
  }

  async blacklistOrgForToken(
    tokenId: number,
    tokenPos: number,
    orgId: number,
    orgName: string,
    reason: string,
  ): Promise<void> {
    if (!this.tokenOrgBlacklist.has(tokenId)) {
      this.tokenOrgBlacklist.set(tokenId, new Set());
    }
    if (this.tokenOrgBlacklist.get(tokenId)!.has(orgId)) return; // já bloqueado
    this.tokenOrgBlacklist.get(tokenId)!.add(orgId);
    await query(
      `INSERT INTO token_org_blacklist (token_id, org_id, reason)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tokenId, orgId, reason],
    );
    await this.manager.log(
      this.instanceId,
      "WARN",
      "engine",
      `Org "${orgName}" bloqueada para token #${tokenPos} — ${reason}. Será ignorada neste token.`,
    );
  }

  /** Remove uma entrada da blacklist (em memória + DB). */
  async unblacklistOrgForToken(tokenId: number, orgId: number): Promise<void> {
    this.tokenOrgBlacklist.get(tokenId)?.delete(orgId);
    await query(
      `DELETE FROM token_org_blacklist WHERE token_id = $1 AND org_id = $2`,
      [tokenId, orgId],
    );
  }

  /** Remove toda a blacklist de um token (ou de todos os tokens desta instância). */
  async clearBlacklist(tokenId?: number): Promise<void> {
    if (tokenId !== undefined) {
      this.tokenOrgBlacklist.delete(tokenId);
      await query(
        `DELETE FROM token_org_blacklist WHERE token_id = $1`,
        [tokenId],
      );
    } else {
      // limpa todos os tokens desta instância
      for (const tid of this.tokenOrgBlacklist.keys()) {
        this.tokenOrgBlacklist.delete(tid);
      }
      await query(
        `DELETE FROM token_org_blacklist
         WHERE token_id IN (SELECT id FROM tokens WHERE instance_id = $1)`,
        [this.instanceId],
      );
    }
  }

  private async rankCandidatesByPlayers(
    candidates: ChannelRow[],
    activeToken: ActiveToken,
    blockedNames: string[] = [],
  ): Promise<{ choice: ChannelRow | null; players: number }> {
    // Se não há nomes a evitar, pula completamente as chamadas REST de leitura
    // de mensagem — evita spam de requisições e erros 403 nos logs.
    if (blockedNames.length === 0) {
      return { choice: candidates[0] ?? null, players: 0 };
    }

    const rest = new DiscordRest(activeToken.token);
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
      await sleep(900 + Math.floor(Math.random() * 1300));
      const r = await rest.fetchMessage(c.channel_id, c.message_id);
      if (r.status === 200 && r.data) {
        const blocked = hasBlockedName(r.data, blockedNames);
        this.playerCache.set(keyOf(c), {
          count: blocked ? -1 : 1,
          ts: Date.now(),
        });
        if (blocked) {
          await this.manager.log(
            this.instanceId,
            "WARN",
            "engine",
            `Fila bloqueada em ${c.org_name} · #${c.channel_name ?? c.channel_id} — nome na lista de bloqueio.`,
          );
          await query(
            `UPDATE stats SET bloqueadas = bloqueadas + 1 WHERE instance_id = $1`,
            [this.instanceId],
          );
        }
      } else if (r.status === 403) {
        // 403 ao LER mensagem = sem acesso REST, mas pode ainda clicar via gateway.
        // Cache longo para não repetir a chamada por 5 min.
        this.playerCache.set(keyOf(c), { count: 0, ts: Date.now() - PLAYER_CACHE_MS + PLAYER_CACHE_403_MS });
      } else if (r.status === 404) {
        this.playerCache.set(keyOf(c), { count: 0, ts: Date.now() });
      }
    }

    // Filtra canais com count negativo: -1 = nome bloqueado
    const scored = candidates
      .map((c) => {
        const cached = this.playerCache.get(keyOf(c));
        return { ch: c, players: cached?.count ?? 0 };
      })
      .filter((s) => s.players >= 0);
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
  ): Promise<boolean> {
    const btn = pickEnterButton(ch.buttons);
    if (!btn || !btn.custom_id) return false;

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
      // Grava histórico de entradas para estatísticas por org/período
      await query(
        `INSERT INTO queue_joins (instance_id, org_id, org_name, mode, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.instanceId, ch.org_id, ch.org_name, ch.mode, ch.category],
      );
      this.playerCache.delete(`${ch.channel_id}:${ch.message_id}`);
      await this.manager.log(
        this.instanceId,
        "INFO",
        "engine",
        `Entrou em ${ch.org_name} · ${ch.category ?? "?"} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} (${tag}) · "${btn.label}" · token #${token.position}`,
      );

      // Long break: a cada N ações, dorme 1-3 min para parecer humano.
      this.actionsSinceBreak += 1;
      if (this.actionsSinceBreak >= this.nextBreakAt) {
        const breakMs = randInt(LONG_BREAK_MS_MIN, LONG_BREAK_MS_MAX);
        this.extraDelayMs += breakMs;
        this.actionsSinceBreak = 0;
        this.nextBreakAt = randInt(LONG_BREAK_AFTER_MIN, LONG_BREAK_AFTER_MAX);
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Pausa de ${Math.round(breakMs / 1000)}s após ${this.nextBreakAt} entradas.`,
        );
      }
      return true;
    } else if (r.status === 429) {
      // Backoff agressivo em 429 — Discord não gosta nem um pouco
      const backoff = randInt(RATE_LIMIT_BACKOFF_MIN_MS, RATE_LIMIT_BACKOFF_MAX_MS);
      this.extraDelayMs += backoff;
      await this.manager.log(
        this.instanceId,
        "WARN",
        "engine",
        `Rate-limited em ${ch.org_name} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} — esperando ${Math.round(backoff / 1000)}s antes de continuar.`,
      );
      return false;
    } else if (r.status === 403 || isMissingAccess(r.status, r.error)) {
      // 403 ou 400/404 com "Missing Access"/"Missing Permissions" = banido/não membro
      const rawError = r.error?.slice(0, 200) ?? "";
      await this.blacklistOrgForToken(
        token.tokenId,
        token.position,
        ch.org_id,
        ch.org_name,
        `HTTP ${r.status} — acesso negado/banido (${rawError})`,
      );
      return false;
    } else if (r.status === 401) {
      // 401 = token inválido/expirado — loga mas não bloqueia org específica
      await this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `Token #${token.position} inválido/expirado (HTTP 401) — desconecte e reconecte o token.`,
      );
      return false;
    } else {
      await this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `Falhou ${ch.org_name} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id}: HTTP ${r.status} ${r.error?.slice(0, 120) ?? ""}`,
      );
      return false;
    }
  }

  private async loadChannels(
    orgIds: number[],
    allowedModes: string[],
    allowedCategories: string[],
    maxValor = 0,
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
    // Filtro de valor máximo — exclui filas acima do limite configurado
    if (maxValor > 0) {
      return rows.filter((r) => {
        const v = parseValor(r.embed_valor);
        return v === null || v <= maxValor;
      });
    }
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

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
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

/**
 * Extrai o valor numérico de uma string como "R$10,00" → 10.
 * Retorna null se não for possível converter.
 */
function parseValor(v: string | null): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^\d,.]/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Retorna true se o texto do embed contiver qualquer nome bloqueado.
 * Compara case-insensitive contra description e fields de todos os embeds.
 * Funciona para filas que mostram @nomes (1x1); ignora filas só com IDs.
 */
function hasBlockedName(msg: DiscordMessage, blockedNames: string[]): boolean {
  if (blockedNames.length === 0) return false;
  const parts: string[] = [];
  for (const e of msg.embeds ?? []) {
    if (e.description) parts.push(e.description);
    for (const f of e.fields ?? []) {
      if (f.value) parts.push(f.value);
      if (f.name) parts.push(f.name);
    }
    if (e.title) parts.push(e.title);
  }
  if (msg.content) parts.push(msg.content);
  const text = parts.join("\n").toLowerCase();
  return blockedNames.some((name) => text.includes(name));
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

/**
 * Retorna true se o status/body indicam que o token não tem acesso à guild
 * (banido, não é membro, sem permissão) mesmo que o código HTTP não seja 403.
 * Discord pode retornar 400 ou 404 com esses códigos de erro internos.
 */
function isMissingAccess(status: number, error?: string): boolean {
  if (!error) return false;
  const body = error.toLowerCase();
  // Códigos Discord internos de falta de acesso
  const MISSING_CODES = ["50013", "50001", "10004", "10003", "40001"];
  const MISSING_PHRASES = ["missing access", "missing permissions", "unknown guild", "unknown channel"];
  return (
    (status === 400 || status === 404) &&
    (MISSING_CODES.some((c) => body.includes(c)) || MISSING_PHRASES.some((p) => body.includes(p)))
  );
}
