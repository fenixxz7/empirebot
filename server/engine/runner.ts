import { query } from "../db/pool.js";
import { DiscordRest, type DiscordMessage } from "../discord/rest.js";
import { DiscoveryRateBudget, isPermanentAccessError } from "../discord/discovery.js";
import { ACTIVE_QUEUE_TTL_THREAD_MS, ACTIVE_QUEUE_TTL_PRIVATE_MS } from "../lib/timings.js";
import { recordGhostByType } from "../lib/orgDetection.js";

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
  timingIntraMinMs: number;
  timingIntraMaxMs: number;
  timingPauseMinMs: number;
  timingPauseMaxMs: number;
  timingClickMinMs: number;
  timingClickMaxMs: number;
  clicksPerOrg: number;
  hotOrgExtraClicks: number;
  entryCapWithPlayers: number;
  entryCapEmpty: number;
  entryCapTotal: number;
  refusalCheckDelayMs: number;
  enable60RpmMode: boolean;
  aqSoftLimit: number;
  aqHardLimit: number;
  optimizeForConversion: boolean;
}

const STARTUP_GRACE_MS = 5000;
const TICK_MIN_MS = 100;
const TICK_MAX_MS = 2500;
const NO_TOKEN_LOG_INTERVAL_MS = 30_000;
const NO_WORK_LOG_INTERVAL_MS = 60_000;
const PLAYER_CACHE_MS = 30_000;
const PLAYER_CACHE_403_MS = 10 * 60_000;
const MAX_FRESH_FETCH_PER_TICK = 6;

// Buffer de candidatos persistente — sobrevive a falhas de discovery
const CANDIDATE_TTL_MS = 7 * 60_000; // 7min: filas conhecidas permanecem no buffer

interface BufferedCandidate {
  ch: ChannelRow;
  players: number;
  lastSeenAt: number;
  expiresAt: number;
}

// === RATE WINDOW (janela de 60s — caps configuráveis via instance_configs) ===
const RATE_WINDOW_MS = 60_000;             // janela de 60s (fixa)
// Pausa e cooldown agora são carregados da DB (timing_*_ms em instance_configs)

// Backoff extra após rate limit (429)
const RATE_LIMIT_BACKOFF_MIN_MS = 120_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 240_000;

// Cooldown aplicado quando a org recusa entrada por limite real
const REAL_LIMIT_COOLDOWN_MS = 3 * 60_000;   // 3 min após recusa de limite real
const WAIT_DETECT_COOLDOWN_MS = 45_000;       // 45s para "aguarde Xs" genérico
// Delay default da verificação pós-clique — sobrescrito por refusal_check_delay_ms na DB
const DEFAULT_REFUSAL_CHECK_DELAY_MS = 800;

// Modo 60rpm experimental
const PENDING_CHECKS_MAX_NORMAL = 5;
const PENDING_CHECKS_MAX_60RPM = 15;
const PENDING_CHECKS_SKIP_THRESHOLD = 8;
const SAFE_MODE_DURATION_MS = 2 * 60_000;
const DIAG_INTERVAL_MS = 30_000;
const ACTIVE_CACHE_TTL_MS = 3_000;
const CHOOSE_WARN_STAGE_MS = 300;

// Rate limit por org/token: se retry_after <= esse limiar, espera localmente;
// se > limiar, aplica cooldown só na org/token e continua o scheduler normalmente.
const ORG_RATELIMIT_LOCAL_MAX_MS = 2_000;

interface PlayerInfo {
  count: number;
  ts: number;
}

export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private paused = false;
  private orgCursor = 0;
  private lastNoTokenLog = 0;
  private lastNoWorkLog = 0;
  private playerCache = new Map<string, PlayerInfo>();
  private extraDelayMs = 0;
  private lastSweepAt = 0;
  private nextJoinAt = 0;
  private orgModeCursor = new Map<number, number>();
  private tokenCursor = 0;
  private joinsOnCurrentToken = 0;
  // === Janela de rate (10 entradas / 60s) ===
  private windowStart = 0;
  private joinedWithPlayers = 0;
  private joinedWithoutPlayers = 0;
  // token_id → Set<org_id>: orgs inválidas por token (ban / acesso negado)
  private tokenOrgBlacklist = new Map<number, Set<number>>();
  private blacklistLoaded = false;
  // Contador de cliques por org (rate limit por org)
  private orgClickCounts = new Map<number, number>();
  // Cooldown por limite REAL da org (recusa após clique): orgId → timestamp "bloqueado até"
  private orgLimitCooldowns = new Map<number, number>();
  // Throttle de log de cooldown por org (evita spam a cada tick)
  private lastOrgLimitLog = new Map<number, number>();
  // Throughput e diagnóstico de ciclo
  private pendingRefusalChecks = 0;
  private recentJoinTs: number[] = [];
  private lastThroughputLog = 0;
  private lastClickAt = 0;
  private lastSchedulerLog = 0;
  // Cache de config e canais (evita queries DB a cada tick)
  private configCache: { cfg: CycleConfig; ts: number } | null = null;
  private readonly CONFIG_CACHE_MS = 8_000;
  private channelCache: { rows: ChannelRow[]; ts: number; key: string } | null = null;
  private readonly CHANNEL_CACHE_MS = 20_000;
  // Org scoring dinâmico (score = joins + matches*3 - recusas*5)
  private orgScores = new Map<number, number>();
  private orgJoinCounts = new Map<number, number>();   // total joins por org (sessão)
  private orgRefusalCounts = new Map<number, number>(); // total recusas por org (sessão)
  // Background refresh de player cache (não bloqueia o tick)
  private bgRefreshRunning = false;
  private bgRefreshQueue: ChannelRow[] = [];
  private bgRefreshToken: ActiveToken | null = null;
  private bgRefreshBlockedNames: string[] = [];
  // 60rpm: cache de active_queues em memória (evita query DB a cada tick, TTL 3s)
  private activeRowsCache: Array<{ channel_id: string; message_id: string; org_id: number; joined_with_players: boolean }> = [];
  private activeRowsCacheTs = 0;
  // 60rpm: janela de segurança (rastreia 429/403/recusas para modo seguro automático)
  // "ignored" = erro de org inválida/bloqueada (10004/50001) — não conta para safe mode
  private safetyEvents: Array<{ ts: number; type: "ok" | "429" | "403" | "refusal" | "ignored" }> = [];
  private safeModeSince = 0;
  // Timestamp do último buffer diag (para não logar todo tick)
  private lastBufDiagAt = 0;
  // 60rpm: latências de chooseQueue para cálculo de p50/p95
  private chooseLatencies: number[] = [];
  private lastDiagAt = 0;
  // 60rpm: motivos de bloqueio acumulados entre logs de 30s
  private blockedReasons = new Map<string, number>();
  // Buffer persistente de candidatos (sobrevive a falhas de discovery)
  private candidateBuffer = new Map<string, BufferedCandidate>();
  // Rate budget de discovery compartilhado entre auto-discovery e re-discovery
  readonly discoveryBudget = new DiscoveryRateBudget();
  // Cooldowns de rate limit por org+token (chave: `${orgId}:${tokenId}`, valor: blocked_until)
  // Isolado por org — não congela o scheduler inteiro
  private orgRateLimitCooldowns = new Map<string, number>();
  // Contador acumulado de sem_candidatos entre diags de 30s
  private semCandidatosTotal = 0;
  // Contador acumulado de erros 10004/ignorados (org inválida) — exposto no [60rpm diag]
  private ignoredCount10004 = 0;
  // Métricas de conversão por org (janela deslizante de 15min)
  private orgJoinTs = new Map<number, number[]>();
  private orgMatchTs = new Map<number, number[]>();
  private orgGhostTs = new Map<number, number[]>();
  // Orgs em penalidade cold (ghost_rate > 50% → pausa 5min)
  private coldOrgs = new Map<number, number>(); // orgId → thawAt
  private lastEfficiencyLog = 0;
  /** Limite de cliques comprometido no primeiro clique da sessão por org —
   *  evita o bug "clicks concluídos 9/5" causado por variação de isHotOrg entre ticks. */
  private orgClickLimits = new Map<number, number>();

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
    this.orgClickCounts.clear();
    this.orgLimitCooldowns.clear();
    this.lastOrgLimitLog.clear();
    this.pendingRefusalChecks = 0;
    this.recentJoinTs = [];
    this.lastThroughputLog = 0;
    this.lastClickAt = 0;
    this.configCache = null;
    this.channelCache = null;
    this.orgScores.clear();
    this.orgJoinCounts.clear();
    this.orgRefusalCounts.clear();
    this.bgRefreshRunning = false;
    this.bgRefreshQueue = [];
    this.bgRefreshToken = null;
    this.activeRowsCache = [];
    this.activeRowsCacheTs = 0;
    this.safetyEvents = [];
    this.safeModeSince = 0;
    this.chooseLatencies = [];
    this.lastDiagAt = 0;
    this.blockedReasons.clear();
    this.candidateBuffer.clear();
    this.discoveryBudget.resetStats();
    this.semCandidatosTotal = 0;
    this.lastBufDiagAt = 0;
    this.orgRateLimitCooldowns.clear();
    this.orgJoinTs.clear();
    this.orgMatchTs.clear();
    this.orgGhostTs.clear();
    this.coldOrgs.clear();
    this.lastEfficiencyLog = 0;
    this.orgClickLimits.clear();
    this.timer = setTimeout(() => this.tick(), STARTUP_GRACE_MS);
  }

  /** Verifica se a org está em cooldown de limite real. */
  private isOrgInLimitCooldown(orgId: number): { blocked: boolean; remainingMs: number } {
    const until = this.orgLimitCooldowns.get(orgId);
    if (!until) return { blocked: false, remainingMs: 0 };
    const remaining = until - Date.now();
    if (remaining <= 0) {
      this.orgLimitCooldowns.delete(orgId);
      return { blocked: false, remainingMs: 0 };
    }
    return { blocked: true, remainingMs: remaining };
  }

  /** Define cooldown de limite real para uma org (mantém o mais longo). */
  private setOrgLimitCooldown(orgId: number, ms: number): void {
    const newUntil = Date.now() + ms;
    const current = this.orgLimitCooldowns.get(orgId) ?? 0;
    if (newUntil > current) this.orgLimitCooldowns.set(orgId, newUntil);
  }

  /**
   * Verifica se a org está em cooldown de rate limit para um token específico.
   * Diferente do "limite real" (recusa de entrada), este é o 429 do Discord em cliques.
   */
  private isOrgTokenRateLimited(orgId: number, tokenId: number): { blocked: boolean; remainingMs: number } {
    const key = `${orgId}:${tokenId}`;
    const until = this.orgRateLimitCooldowns.get(key);
    if (!until) return { blocked: false, remainingMs: 0 };
    const remaining = until - Date.now();
    if (remaining <= 0) {
      this.orgRateLimitCooldowns.delete(key);
      return { blocked: false, remainingMs: 0 };
    }
    return { blocked: true, remainingMs: remaining };
  }

  /** Aplica cooldown de rate limit Discord para uma org+token específicos. */
  private setOrgTokenRateLimitCooldown(orgId: number, tokenId: number, ms: number): void {
    const key = `${orgId}:${tokenId}`;
    const newUntil = Date.now() + ms;
    const current = this.orgRateLimitCooldowns.get(key) ?? 0;
    if (newUntil > current) this.orgRateLimitCooldowns.set(key, newUntil);
  }

  // ─── Métricas de conversão por org (janela deslizante 15min) ─────────────

  /** Registra um join bem-sucedido para a org. */
  private recordJoin(orgId: number): void {
    const arr = this.orgJoinTs.get(orgId) ?? [];
    arr.push(Date.now());
    this.orgJoinTs.set(orgId, arr);
    this.pruneOrgMetric(this.orgJoinTs, orgId);
  }

  /** Registra um ghost (fila expirou sem match) para a org. */
  private recordGhost(orgId: number): void {
    const arr = this.orgGhostTs.get(orgId) ?? [];
    arr.push(Date.now());
    this.orgGhostTs.set(orgId, arr);
    this.pruneOrgMetric(this.orgGhostTs, orgId);
    // Verifica se org deve entrar em cold (ghost_rate > 50% na janela de 10min)
    this.maybeFreeze(orgId);
  }

  /** Registra uma conversão (match confirmado) para a org. Chamado pelo Manager. */
  recordMatchEvent(orgId: number): void {
    const arr = this.orgMatchTs.get(orgId) ?? [];
    arr.push(Date.now());
    this.orgMatchTs.set(orgId, arr);
    this.pruneOrgMetric(this.orgMatchTs, orgId);
  }

  /** Remove timestamps mais antigos que 20min (headroom acima da janela de 15min). */
  private pruneOrgMetric(map: Map<number, number[]>, orgId: number): void {
    const cutoff = Date.now() - 20 * 60_000;
    const arr = map.get(orgId);
    if (!arr) return;
    const pruned = arr.filter(t => t > cutoff);
    if (pruned.length === 0) map.delete(orgId);
    else map.set(orgId, pruned);
  }

  /** Retorna métricas de conversão por org na janela indicada. */
  private getOrgConversionMetrics(orgId: number, windowMs: number) {
    return calcConvMetrics(
      this.orgJoinTs.get(orgId) ?? [],
      this.orgMatchTs.get(orgId) ?? [],
      this.orgGhostTs.get(orgId) ?? [],
      windowMs,
    );
  }

  /** Verifica se a org deve entrar em cold (ghost_rate > 50% na janela de 10min). */
  private maybeFreeze(orgId: number): void {
    const m = calcConvMetrics(
      this.orgJoinTs.get(orgId) ?? [],
      this.orgMatchTs.get(orgId) ?? [],
      this.orgGhostTs.get(orgId) ?? [],
      10 * 60_000,
    );
    // Só aplica cold se há dados suficientes (≥10 joins na janela) e ghost_rate expressivo
    if (m.joins >= 10 && m.ghost_rate > 0.7) {
      const thawAt = Date.now() + 5 * 60_000;
      const existing = this.coldOrgs.get(orgId) ?? 0;
      if (thawAt > existing) {
        this.coldOrgs.set(orgId, thawAt);
        void this.manager.log(
          this.instanceId, "WARN", "engine",
          `Org ${orgId} em penalidade cold (ghost_rate=${Math.round(m.ghost_rate * 100)}% em 10min) — pausa 5min.`,
        );
      }
    }
  }

  /** Retorna true se a org está em penalidade cold (ghost_rate alta). */
  private isOrgCold(orgId: number): boolean {
    const thawAt = this.coldOrgs.get(orgId);
    if (!thawAt) return false;
    if (Date.now() >= thawAt) {
      this.coldOrgs.delete(orgId);
      return false;
    }
    return true;
  }

  /** Emite log de eficiência (conversão, ghosts) de todas as orgs a cada 60s. */
  private async emitEfficiencyLog(cfg: CycleConfig, activeCount: number): Promise<void> {
    const WINDOW_MS = 15 * 60_000;
    const lines: string[] = [];
    for (const orgId of this.orgJoinTs.keys()) {
      const m = this.getOrgConversionMetrics(orgId, WINDOW_MS);
      if (m.joins === 0) continue;
      const cold = this.isOrgCold(orgId) ? " [COLD]" : "";
      lines.push(
        `org${orgId}: joins=${m.joins} match=${m.matches} ghost=${m.ghosts} conv=${Math.round(m.conversion_rate * 100)}% ghost_rate=${Math.min(100, Math.round(m.ghost_rate * 100))}%${cold}`,
      );
    }
    const softLim = cfg.optimizeForConversion ? ` soft=${cfg.aqSoftLimit} hard=${cfg.aqHardLimit}` : "";
    const header = `[Eficiência 15min] active=${activeCount}${softLim} | ${lines.length > 0 ? lines.join(" | ") : "sem dados de joins ainda"}`;
    await this.manager.log(this.instanceId, "INFO", "engine", header);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Suspende o clique em filas sem parar o timer. Útil durante redescoberta. */
  pause(): void {
    this.paused = true;
  }

  /** Retoma o clique em filas após uma pausa. */
  resume(): void {
    this.paused = false;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      // Sweep de filas fantasmas a cada 30s (idempotente)
      await this.sweepGhostQueues();
      if (this.paused) {
        this.scheduleNextTick(TICK_MAX_MS);
        return;
      }
      const cfg = await this.loadConfig();
      await this.iterate(cfg);
    } catch (err) {
      void this.manager.log(
        this.instanceId,
        "ERROR",
        "engine",
        `tick falhou: ${(err as Error).message}`,
      );
    } finally {
      if (!this.stopped) this.scheduleNextTick();
    }
  }

  /**
   * Agenda o próximo tick dinamicamente com base em nextJoinAt.
   * Se nextJoinAt já passou → 100ms (quase imediato).
   * Se nextJoinAt está no futuro → aguarda exatamente o necessário (cap: 2500ms).
   * Isso elimina o teto artificial de 2500ms que limitava throughput a ~24/min.
   */
  private scheduleNextTick(forceMs?: number): void {
    if (this.stopped) return;
    const now = Date.now();
    let delay: number;
    if (forceMs !== undefined) {
      delay = forceMs;
    } else if (this.nextJoinAt > now) {
      delay = Math.min(this.nextJoinAt - now, TICK_MAX_MS);
    } else {
      delay = TICK_MIN_MS;
    }
    delay = Math.max(TICK_MIN_MS, delay);
    this.timer = setTimeout(() => this.tick(), delay);

    // Log periódico do scheduler (a cada 60s) para confirmar que o motor está respondendo
    if (now - this.lastSchedulerLog > 60_000) {
      this.lastSchedulerLog = now;
      const nextAt = this.nextJoinAt > now
        ? `+${delay}ms`
        : "imediato";
      void this.manager.log(
        this.instanceId, "INFO", "engine",
        `Scheduler: próximo tick em ${delay}ms | nextJoinAt=${nextAt} | pending_checks=${this.pendingRefusalChecks} | bg_refresh=${this.bgRefreshRunning}`,
      );
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
      `DELETE FROM active_queues aq
       USING orgs o
       WHERE aq.org_id = o.id
         AND aq.instance_id = $1
         AND aq.joined_at < NOW() - (
           CASE o.match_type
             WHEN 'private_channel' THEN ($2 || ' milliseconds')::interval
             ELSE ($3 || ' milliseconds')::interval
           END
         )
       RETURNING aq.id, aq.org_id, aq.channel_id`,
      [this.instanceId, String(ACTIVE_QUEUE_TTL_PRIVATE_MS), String(ACTIVE_QUEUE_TTL_THREAD_MS)],
    );
    if (removed.length > 0) {
      // Registra fantasmas por org para cálculo de ghost_rate
      for (const r of removed) {
        this.recordGhost(r.org_id);
      }
      this.activeRowsCacheTs = 0; // invalida cache — sweep removeu entradas

      // Busca nome + match_type das orgs varridas para log detalhado e métricas
      const sweepOrgIds = [...new Set(removed.map((r) => r.org_id))];
      const orgInfoRows = await query<{ id: number; name: string; match_type: string }>(
        `SELECT id, name, match_type FROM orgs WHERE id = ANY($1)`,
        [sweepOrgIds],
      ).catch(() => [] as Array<{ id: number; name: string; match_type: string }>);
      const orgInfoMap = new Map(orgInfoRows.map((o) => [o.id, o]));

      // Registra ghost por tipo no módulo de detecção (para métricas /type-metrics)
      for (const r of removed) {
        const mt = orgInfoMap.get(r.org_id)?.match_type ?? "thread";
        recordGhostByType(this.instanceId, mt);
      }

      // Log detalhado por entry varrida: org + tipo + fragmento do channel_id
      const TYPE_EMOJI: Record<string, string> = {
        thread: "📍", private_channel: "📺", mixed: "🔀",
      };
      const orgLines = removed.map((r) => {
        const info = orgInfoMap.get(r.org_id);
        const mt = info?.match_type ?? "thread";
        return `${info?.name ?? `org${r.org_id}`}[${TYPE_EMOJI[mt] ?? ""}${mt}]·ch…${r.channel_id.slice(-6)}`;
      });

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
        `Sweep: ${removed.length} ghost(s) — ${orgLines.join(" | ")}`,
      );
      // Força round-robin a recomeçar do topo e limpa cursores de modo
      this.orgCursor = 0;
      this.orgModeCursor.clear();
    }
  }

  private async loadConfig(): Promise<CycleConfig> {
    const now = Date.now();
    if (this.configCache && now - this.configCache.ts < this.CONFIG_CACHE_MS) {
      return this.configCache.cfg;
    }
    const cfgRows = await query<{
      delay_seconds: number;
      allowed_modes: string;
      allowed_categories: string;
      blocked_names: string;
      max_valor: number;
      token_strategy: string;
      token_strategy_n: number;
      timing_intra_min_ms: number;
      timing_intra_max_ms: number;
      timing_pause_min_ms: number;
      timing_pause_max_ms: number;
      timing_click_min_ms: number;
      timing_click_max_ms: number;
      clicks_per_org: number;
      hot_org_extra_clicks: number;
      entry_cap_with_players_per_60s: number;
      entry_cap_empty_per_60s: number;
      entry_cap_total_per_60s: number;
      refusal_check_delay_ms: number;
      enable_60rpm_mode: boolean;
      active_queue_soft_limit: number;
      active_queue_hard_limit: number;
      optimize_for_conversion: boolean;
    }>(
      `SELECT delay_seconds, allowed_modes, allowed_categories, blocked_names,
              max_valor, token_strategy, token_strategy_n,
              timing_intra_min_ms, timing_intra_max_ms,
              timing_pause_min_ms, timing_pause_max_ms,
              timing_click_min_ms, timing_click_max_ms,
              clicks_per_org, hot_org_extra_clicks,
              entry_cap_with_players_per_60s,
              entry_cap_empty_per_60s,
              entry_cap_total_per_60s,
              refusal_check_delay_ms,
              enable_60rpm_mode,
              active_queue_soft_limit,
              active_queue_hard_limit,
              optimize_for_conversion
       FROM instance_configs
       WHERE instance_id = $1`,
      [this.instanceId],
    );
    const orgRows = await query<{ org_id: number }>(
      `SELECT io.org_id
       FROM instance_orgs io
       JOIN orgs o ON o.id = io.org_id
       WHERE io.instance_id = $1 AND io.selected = TRUE
       ORDER BY o.priority DESC, o.id ASC`,
      [this.instanceId],
    );
    const r = cfgRows[0];
    const cfg: CycleConfig = {
      delay_seconds: r?.delay_seconds ?? 18,
      allowed_modes: parseList(r?.allowed_modes ?? "").map(normalizeMode).filter((m): m is string => m !== null),
      allowed_categories: parseList(r?.allowed_categories ?? ""),
      selected_org_ids: orgRows.map((row) => row.org_id),
      blockedNames: parseList(r?.blocked_names ?? "").map((n) => n.toLowerCase()),
      maxValor: Number(r?.max_valor ?? 0),
      tokenStrategy: (r?.token_strategy ?? "single") as TokenStrategy,
      tokenStrategyN: Math.max(1, r?.token_strategy_n ?? 5),
      timingIntraMinMs: r?.timing_intra_min_ms ?? 4000,
      timingIntraMaxMs: r?.timing_intra_max_ms ?? 7000,
      timingPauseMinMs: r?.timing_pause_min_ms ?? 25000,
      timingPauseMaxMs: r?.timing_pause_max_ms ?? 35000,
      timingClickMinMs: r?.timing_click_min_ms ?? 1000,
      timingClickMaxMs: r?.timing_click_max_ms ?? 2000,
      clicksPerOrg: r?.clicks_per_org ?? 10,
      hotOrgExtraClicks: Math.max(0, r?.hot_org_extra_clicks ?? 10),
      entryCapWithPlayers: Math.max(0, Math.min(200, r?.entry_cap_with_players_per_60s ?? 30)),
      entryCapEmpty: Math.max(0, Math.min(200, r?.entry_cap_empty_per_60s ?? 18)),
      entryCapTotal: Math.max(0, Math.min(200, r?.entry_cap_total_per_60s ?? 48)),
      refusalCheckDelayMs: Math.min(5000, Math.max(300, r?.refusal_check_delay_ms ?? DEFAULT_REFUSAL_CHECK_DELAY_MS)),
      enable60RpmMode: r?.enable_60rpm_mode ?? false,
      aqSoftLimit: Math.max(10, r?.active_queue_soft_limit ?? 120),
      aqHardLimit: Math.max(10, r?.active_queue_hard_limit ?? 180),
      optimizeForConversion: r?.optimize_for_conversion ?? false,
    };
    this.configCache = { cfg, ts: Date.now() };
    return cfg;
  }

  /** Invalida caches de config e canais (chamado quando discovery roda ou config muda). */
  invalidateCaches(): void {
    this.configCache = null;
    this.channelCache = null;
  }

  /**
   * Atualiza o buffer persistente de candidatos a partir de uma lista de canais recém-carregada.
   * Remove entradas expiradas. NÃO remove entradas que não apareceram (discovery parcial).
   */
  private updateCandidateBuffer(rows: ChannelRow[]): void {
    const now = Date.now();
    // Atualiza/renova TTL de entradas existentes
    for (const ch of rows) {
      const key = `${ch.channel_id}:${ch.message_id}`;
      const existing = this.candidateBuffer.get(key);
      const players = this.playerCache.get(key)?.count ?? (existing?.players ?? 0);
      this.candidateBuffer.set(key, {
        ch,
        players,
        lastSeenAt: now,
        expiresAt: now + CANDIDATE_TTL_MS,
      });
    }
    // Remove expirados (limpeza incremental)
    for (const [k, v] of this.candidateBuffer) {
      if (v.expiresAt <= now) this.candidateBuffer.delete(k);
    }
  }

  /** Remove um candidato do buffer (ex: 404 ao clicar, partida detectada). */
  private evictCandidate(channelId: string, messageId: string): void {
    this.candidateBuffer.delete(`${channelId}:${messageId}`);
  }

  private async loadChannelsCached(
    orgIds: number[],
    allowedModes: string[],
    allowedCategories: string[],
    maxValor: number,
  ): Promise<ChannelRow[]> {
    const key = `${orgIds.join(",")}|${allowedModes.join(",")}|${allowedCategories.join(",")}|${maxValor}`;
    const now = Date.now();
    if (this.channelCache && this.channelCache.key === key && now - this.channelCache.ts < this.CHANNEL_CACHE_MS) {
      return this.channelCache.rows;
    }
    const rows = await this.loadChannels(orgIds, allowedModes, allowedCategories, maxValor);
    this.channelCache = { rows, ts: Date.now(), key };
    // Popula o buffer com os canais recém-carregados (atualiza TTL)
    this.updateCandidateBuffer(rows);
    return rows;
  }

  private async iterate(cfg: CycleConfig): Promise<void> {
    const now = Date.now();
    if (now < this.nextJoinAt) return;

    // 60rpm: verifica expiração do modo seguro
    this.exitSafeMode();
    const inSafeMode = cfg.enable60RpmMode && this.safeModeSince > 0;

    // === Janela de rate: reseta se passou 60s ===
    if (now - this.windowStart > RATE_WINDOW_MS) {
      this.windowStart = now;
      this.joinedWithPlayers = 0;
      this.joinedWithoutPlayers = 0;
      void this.manager.log(
        this.instanceId, "INFO", "engine",
        `Velocidade de entrada: players=${cfg.entryCapWithPlayers}/60s, vazias=${cfg.entryCapEmpty}/60s, total=${cfg.entryCapTotal}/60s`,
      );
    }

    const totalJoined = this.joinedWithPlayers + this.joinedWithoutPlayers;
    const playersSlot = this.joinedWithPlayers < cfg.entryCapWithPlayers;
    const noPlayersSlotPreferred = this.joinedWithoutPlayers < cfg.entryCapEmpty;

    if (totalJoined >= cfg.entryCapTotal) {
      // Bateu o total — pausa configurável
      const pause = randInt(cfg.timingPauseMinMs, cfg.timingPauseMaxMs);
      this.nextJoinAt = now + pause;
      this.windowStart = 0;
      const wp = this.joinedWithPlayers;
      const np = this.joinedWithoutPlayers;
      this.joinedWithPlayers = 0;
      this.joinedWithoutPlayers = 0;
      void this.manager.log(
        this.instanceId, "INFO", "engine",
        `Cap de entrada atingido: total usado=${wp + np}/${cfg.entryCapTotal} janela=60s — pausando ${Math.round(pause / 1000)}s.`,
      );
      return;
    }

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

    const channels = await this.loadChannelsCached(
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

    // 60rpm: usa cache em memória (TTL 3s) para evitar query DB a cada tick
    const t_active = Date.now();
    let activeRows: Array<{ channel_id: string; message_id: string; org_id: number; joined_with_players: boolean }>;
    if (cfg.enable60RpmMode && !inSafeMode && (now - this.activeRowsCacheTs) < ACTIVE_CACHE_TTL_MS) {
      activeRows = this.activeRowsCache;
    } else {
      activeRows = await query<{ channel_id: string; message_id: string; org_id: number; joined_with_players: boolean }>(
        `SELECT channel_id, message_id, org_id, joined_with_players
         FROM active_queues WHERE instance_id = $1`,
        [this.instanceId],
      );
      if (cfg.enable60RpmMode) {
        this.activeRowsCache = activeRows;
        this.activeRowsCacheTs = now;
      }
    }
    const t_active_ms = Date.now() - t_active;
    const activeKeys = new Set(
      activeRows.map((r) => `${r.channel_id}:${r.message_id}`),
    );
    const activePerOrg = new Map<number, number>();
    const emptiesPerOrg = new Map<number, number>();
    for (const r of activeRows) {
      activePerOrg.set(r.org_id, (activePerOrg.get(r.org_id) ?? 0) + 1);
      if (!r.joined_with_players) {
        emptiesPerOrg.set(r.org_id, (emptiesPerOrg.get(r.org_id) ?? 0) + 1);
      }
    }
    await this.refreshNaFila(activeRows.length);

    // 60rpm: hard limit global — para tudo se active_queues >= aqHardLimit
    if (cfg.enable60RpmMode && !inSafeMode && activeRows.length >= cfg.aqHardLimit) {
      this.maybeLog("noWork", `60rpm: hard limit (${activeRows.length}/${cfg.aqHardLimit} active_queues) — aguardando sweep/partidas.`);
      this.nextJoinAt = now + 1_500;
      return;
    }
    // Eficiência: hard/soft limit mesmo sem 60rpm quando optimize_for_conversion
    const efficiencyActive = cfg.optimizeForConversion && !cfg.enable60RpmMode;
    if (efficiencyActive && activeRows.length >= cfg.aqHardLimit) {
      this.maybeLog("noWork", `Eficiência: hard limit (${activeRows.length}/${cfg.aqHardLimit} active_queues) — aguardando sweep/partidas.`);
      this.nextJoinAt = now + 2_000;
      return;
    }
    // 60rpm: soft limit — acima de aqSoftLimit, só aceita filas com players
    const above60Soft = cfg.enable60RpmMode && !inSafeMode && activeRows.length >= cfg.aqSoftLimit;
    const aboveEffSoft = efficiencyActive && activeRows.length >= cfg.aqSoftLimit;
    const aboveSoft = above60Soft || aboveEffSoft;
    const effectiveNoPlayersSlot = aboveSoft ? false : noPlayersSlotPreferred;

    // Eficiência: emite log de conversão a cada 60s
    if (cfg.optimizeForConversion) {
      const nowEff = Date.now();
      if (nowEff - this.lastEfficiencyLog >= 60_000) {
        this.lastEfficiencyLog = nowEff;
        void this.emitEfficiencyLog(cfg, activeRows.length);
      }
    }

    // 60rpm: diagnóstico periódico de 30s
    if (cfg.enable60RpmMode) {
      const nowDiag = Date.now();
      if (nowDiag - this.lastDiagAt > DIAG_INTERVAL_MS) {
        this.lastDiagAt = nowDiag;
        void this.emit30sDiag(cfg, activeRows.length);
      }
    }

    const orgIds = cfg.selected_org_ids;
    const totalOrgs = orgIds.length;
    let attempts = 0;
    let candidate: ChannelRow | null = null;
    let candidatePlayers = 0;
    let candidateEligibleCount = 0; // nº de filas elegíveis na org escolhida (para hot org mode)
    let advancedDueToFull = false;
    const cycleStart = Date.now();

    // ── Pre-pass: prioriza org com fila "com players" ────────────────────
    // O loop abaixo é round-robin por org e a preferência "com players"
    // só funciona DENTRO da org da vez. Se a org atual só tem filas vazias
    // mas outra tem fila com 3 players esperando, o bot entrava na vazia.
    // Aqui usamos APENAS o playerCache (sem chamar Discord) pra encontrar
    // a org com mais players visíveis e jogar o cursor pra ela.
    //
    // EXCEÇÃO: se clicksPerOrg > 0 e já começamos a sequência na org atual
    // (count > 0), NÃO deixamos o pre-pass redirecionar o cursor — a
    // sequência tem que completar na org atual antes de qualquer salto.
    const _prePassOrgId = orgIds[this.orgCursor % totalOrgs];
    const _midSequence =
      cfg.clicksPerOrg > 0 &&
      _prePassOrgId !== undefined &&
      (this.orgClickCounts.get(_prePassOrgId) ?? 0) > 0;

    if (playersSlot && !_midSequence) {
      let bestOrg: { idx: number; score: number } | null = null;
      for (let i = 0; i < totalOrgs; i++) {
        const orgId = orgIds[i]!;
        // Eficiência: skip orgs em cold na pre-pass
        if (cfg.optimizeForConversion && this.isOrgCold(orgId)) continue;
        const orgChs = channels.filter((c) => c.org_id === orgId);
        if (orgChs.length === 0) continue;
        const maxForOrg = orgChs[0]?.max_queues ?? 0;
        const activeForOrg = activePerOrg.get(orgId) ?? 0;
        if (maxForOrg > 0 && activeForOrg >= maxForOrg) continue;
        if (this.isOrgInLimitCooldown(orgId).blocked) continue;
        let maxPlayers = 0;
        for (const c of orgChs) {
          const key = `${c.channel_id}:${c.message_id}`;
          if (activeKeys.has(key)) continue;
          if (!c.guild_id || !c.message_id || !c.application_id) continue;
          if (pickEnterButton(c.buttons) === null) continue;
          const cached = this.playerCache.get(key);
          if (cached && cached.count > maxPlayers) maxPlayers = cached.count;
        }
        if (maxPlayers > 0) {
          let score = maxPlayers;
          if (cfg.optimizeForConversion) {
            const m = this.getOrgConversionMetrics(orgId, 15 * 60_000);
            score = maxPlayers * 100 + Math.round(m.conversion_rate * 100) * 3 - Math.round(m.ghost_rate * 100) * 2;
          }
          if (!bestOrg || score > bestOrg.score) {
            bestOrg = { idx: i, score };
          }
        }
      }
      if (bestOrg) {
        this.orgCursor = bestOrg.idx;
      }
    }

    while (attempts < totalOrgs) {
      const currentOrgId = orgIds[this.orgCursor % totalOrgs];
      const orgChannels = channels.filter((c) => c.org_id === currentOrgId);
      const maxForOrg = orgChannels[0]?.max_queues ?? 0;
      const activeForOrg = activePerOrg.get(currentOrgId) ?? 0;

      // Eficiência: pula orgs em cold (ghost_rate alta recentemente)
      if (cfg.optimizeForConversion && this.isOrgCold(currentOrgId)) {
        if (cfg.enable60RpmMode) this.blockedReasons.set("cold_org", (this.blockedReasons.get("cold_org") ?? 0) + 1);
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        advancedDueToFull = true;
        continue;
      }

      // Cooldown de limite real: org foi recusada pela própria plataforma recentemente
      const limitCd = this.isOrgInLimitCooldown(currentOrgId);
      if (limitCd.blocked) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        advancedDueToFull = true;
        if (cfg.enable60RpmMode) this.blockedReasons.set("cooldown", (this.blockedReasons.get("cooldown") ?? 0) + 1);
        const lastLog = this.lastOrgLimitLog.get(currentOrgId) ?? 0;
        if (Date.now() - lastLog > 60_000) {
          this.lastOrgLimitLog.set(currentOrgId, Date.now());
          const orgName = orgChannels[0]?.org_name ?? String(currentOrgId);
          await this.manager.log(this.instanceId, "INFO", "engine",
            `Org ${orgName} ignorada — cooldown de limite real (${Math.ceil(limitCd.remainingMs / 1000)}s restantes).`);
        }
        continue;
      }

      // max_queues por org — em 60rpm usa apenas os limites globais (soft/hard)
      if (!cfg.enable60RpmMode && maxForOrg > 0 && activeForOrg >= maxForOrg) {
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

      // Se a DB não tem candidatos, tenta recuperar do buffer persistente
      // (evita sem_candidatos quando o Discord rate-limita o discovery)
      let usingBufferedCandidates = false;
      if (eligible.length === 0) {
        const bufNow = Date.now();
        const buffered = [...this.candidateBuffer.values()].filter(bc =>
          bc.ch.org_id === currentOrgId &&
          bc.expiresAt > bufNow &&
          !activeKeys.has(`${bc.ch.channel_id}:${bc.ch.message_id}`) &&
          bc.ch.guild_id && bc.ch.message_id && bc.ch.application_id &&
          pickEnterButton(bc.ch.buttons) !== null,
        );
        if (buffered.length > 0) {
          eligible.push(...buffered.map(bc => bc.ch));
          usingBufferedCandidates = true;
        }
      }

      if (eligible.length === 0) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        this.semCandidatosTotal++;
        if (cfg.enable60RpmMode) this.blockedReasons.set("sem_candidatos", (this.blockedReasons.get("sem_candidatos") ?? 0) + 1);
        continue;
      }
      if (usingBufferedCandidates && cfg.enable60RpmMode) {
        this.blockedReasons.set("buffer_fallback", (this.blockedReasons.get("buffer_fallback") ?? 0) + 1);
      }

      // Seleciona token ativo com base na estratégia de rotação
      const activeTokenIdx = cfg.tokenStrategy === "single"
        ? 0
        : this.tokenCursor % tokens.length;
      const selectedToken = tokens[activeTokenIdx]!;

      // Filtra canais de orgs bloqueadas para este token específico
      const blacklistedForToken = this.tokenOrgBlacklist.get(selectedToken.tokenId) ?? new Set<number>();
      const candidatesForToken = eligible.filter(
        (c) => !blacklistedForToken.has(c.org_id),
      );
      if (candidatesForToken.length === 0) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }

      // Verifica cooldown de rate limit por org+token (429 com retry_after alto)
      const orgRlCheck = this.isOrgTokenRateLimited(currentOrgId, selectedToken.tokenId);
      if (orgRlCheck.blocked) {
        const remSec = Math.ceil(orgRlCheck.remainingMs / 1000);
        if (cfg.enable60RpmMode) {
          this.blockedReasons.set("rl_org", (this.blockedReasons.get("rl_org") ?? 0) + 1);
        }
        // Log periódico para não spam (só a cada ~30 ocorrências)
        const rlCount = (this.blockedReasons.get("rl_org") ?? 0);
        if (rlCount <= 1 || rlCount % 30 === 0) {
          void this.manager.log(this.instanceId, "INFO", "engine",
            `Org "${orgChannels[0]?.org_name ?? currentOrgId}" ignorada — cooldown rate limit ${remSec}s restantes (token #${selectedToken.position}).`);
        }
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }

      // Ranqueia TODAS as filas elegíveis da org (todos os modos juntos).
      // Assim a preferência "com players" funciona cross-mode: se a 1x1 tem
      // alguém esperando, a gente entra nela mesmo que o cursor de modo
      // estivesse na 4x4.
      const ranked = await this.rankCandidatesByPlayers(
        candidatesForToken,
        selectedToken,
        cfg.blockedNames,
      );

      // Round-robin de modos: aplica para AMBOS (com player e vazia).
      // Cada entrada bem-sucedida avança o cursor → próximo tick prefere o
      // próximo modo na sequência (1x1 → 2x2 → 3x3 → 4x4 → 1x1…).
      // Dentro de cada modo, a preferência é: com player primeiro, depois vazia.
      // Se o modo da vez não tem candidato útil, tenta o próximo modo.
      const modesPresent = [...new Set(candidatesForToken.map((c) => c.mode ?? ""))].sort();
      const modeCurIdx = this.orgModeCursor.get(currentOrgId) ?? 0;
      const orderedModes = modesPresent
        .map((_, i) => modesPresent[(modeCurIdx + i) % modesPresent.length]!);

      let pick: typeof ranked.candidates[number] | undefined;
      let pickedModeIdx = -1;

      // Passo 1: percorre os modos em rotação procurando fila COM player.
      if (playersSlot) {
        for (let i = 0; i < orderedModes.length; i++) {
          const m = orderedModes[i]!;
          const hit = ranked.candidates.find(
            (r) => r.players > 0 && (r.ch.mode ?? "") === m,
          );
          if (hit) { pick = hit; pickedModeIdx = i; break; }
        }
      }

      // Passo 2: nenhum modo tinha player → percorre os modos procurando vazia.
      // MAS: se a org já tem >=50% do max_queues ocupado por filas vazias paradas,
      // bloqueia novas vazias (só permite com player). Evita encher de fila vazia
      // que nunca vira partida e desperdiça os slots da org.
      // Preferência 70/30: filas vazias só são selecionadas aqui 30% das vezes;
      // nos outros 70% cai no Passo 3 (overflow) que prefere com-player se houver.
      const emptiesForOrg = emptiesPerOrg.get(currentOrgId) ?? 0;
      const emptyBlocked = maxForOrg > 0 && emptiesForOrg * 4 >= maxForOrg * 3;
      if (!pick && effectiveNoPlayersSlot && !emptyBlocked && Math.random() < 0.60) {
        for (let i = 0; i < orderedModes.length; i++) {
          const m = orderedModes[i]!;
          const hit = ranked.candidates.find(
            (r) => r.players === 0 && (r.ch.mode ?? "") === m,
          );
          if (hit) { pick = hit; pickedModeIdx = i; break; }
        }
      }

      // Se a org está bloqueada pra vazia mas existem candidatos com player,
      // pula (não desperdiça slots com vazia quando tem com-player disponível).
      // MAS se NÃO há nenhum candidato com player nesta org, libera entrada em
      // vazia mesmo bloqueada — melhor usar o slot do que deixar a org parada.
      const hasAnyWithPlayers = ranked.candidates.some((r) => r.players > 0);
      if (!pick && emptyBlocked && hasAnyWithPlayers) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }

      // Passo 3: overflow — total < 10 e nenhum match preferencial → melhor disponível.
      if (!pick) {
        pick = ranked.candidates[0];
        if (pick) {
          const m = pick.ch.mode ?? "";
          pickedModeIdx = orderedModes.indexOf(m);
        }
      }

      // Avança o cursor de modo: passa pra um além do modo escolhido,
      // garantindo que o próximo tick comece em outro modo.
      if (pick && modesPresent.length > 0 && pickedModeIdx >= 0) {
        this.orgModeCursor.set(
          currentOrgId,
          (modeCurIdx + pickedModeIdx + 1) % modesPresent.length,
        );
      }
      if (!pick) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        continue;
      }
      candidate = pick.ch;
      candidatePlayers = pick.players;
      candidateEligibleCount = candidatesForToken.length;

      // Avança o cursor de org para a próxima somente se a org já vai estar
      // cheia após esta entrada (activeForOrg + 1 >= maxForOrg).
      // Com max_queues = 0 (sem teto), nunca considera "cheia" pelo contador artificial.
      const willBeFull = maxForOrg > 0 && (activeForOrg + 1) >= maxForOrg;
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
        this.orgCursor = 0;
        if (cfg.enable60RpmMode) {
          const reasons: string[] = [];
          for (const orgId of orgIds) {
            const orgChs = channels.filter((c) => c.org_id === orgId);
            if (orgChs.length === 0) continue;
            const orgName = orgChs[0]?.org_name ?? String(orgId);
            const active = activePerOrg.get(orgId) ?? 0;
            const maxQ = orgChs[0]?.max_queues ?? 0;
            const cd = this.isOrgInLimitCooldown(orgId);
            if (cd.blocked) {
              reasons.push(`${orgName}:cooldown(${Math.ceil(cd.remainingMs / 1000)}s)`);
            } else if (!cfg.enable60RpmMode && maxQ > 0 && active >= maxQ) {
              reasons.push(`${orgName}:max_queues(${active}/${maxQ})`);
            } else {
              reasons.push(`${orgName}:sem_candidato`);
            }
          }
          this.maybeLog("noWork", `Todas as orgs no limite — ${activeRows.length} ativa(s) | ${reasons.slice(0, 8).join(", ")}`);
        } else {
          this.maybeLog("noWork", `Todas as orgs no limite — ${activeRows.length} fila(s) ativa(s).`);
        }
      } else {
        this.maybeLog("noWork", `Nada novo pra entrar — ${activeRows.length} fila(s) ativa(s).`);
      }
      return;
    }

    // Mede tempo de seleção AQUI — antes do sleep e do clique HTTP.
    // cycleStart inclui carregamento de active_queues/channels; o que importa
    // pro usuário é o tempo total de seleção até o ponto de ação.
    const chooseMs = Date.now() - cycleStart;

    // Token ativo para joinQueue
    const tokenIdx = cfg.tokenStrategy === "single" ? 0 : this.tokenCursor % tokens.length;
    const token = tokens[tokenIdx]!;

    // Pausa humanizada curta antes de clicar (configurável)
    await sleep(randInt(cfg.timingClickMinMs, cfg.timingClickMaxMs));

    const joined = await this.joinQueue(candidate, token, activeRows.length, candidatePlayers, cfg.refusalCheckDelayMs, cfg.enable60RpmMode);

    if (joined) {
      // Registra timestamp para cálculo de throughput
      this.recentJoinTs.push(Date.now());
      // Mantém apenas os últimos 120s de dados (buffer deslizante)
      const cutoffTs = Date.now() - 120_000;
      this.recentJoinTs = this.recentJoinTs.filter(t => t > cutoffTs);

      // ── Log periódico de throughput com diagnóstico de gargalo ──────────
      const nowLog = Date.now();
      if (nowLog - this.lastThroughputLog > 60_000) {
        this.lastThroughputLog = nowLog;
        const joinsPer60 = this.recentJoinTs.filter(t => nowLog - t < 60_000).length;
        const joinsPer30 = this.recentJoinTs.filter(t => nowLog - t < 30_000).length * 2;
        let bottleneck = "aguardando filas";
        if (this.pendingRefusalChecks > 0) bottleneck = `verificações pendentes (${this.pendingRefusalChecks})`;
        else if (this.nextJoinAt > nowLog) bottleneck = `cooldown intra (${Math.ceil((this.nextJoinAt - nowLog) / 1000)}s)`;
        else if (this.bgRefreshRunning) bottleneck = "bg player refresh (não bloqueia)";
        // Top 3 orgs por score
        const topOrgs = [...this.orgScores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([oid, sc]) => `org${oid}:${sc}`)
          .join(", ");
        const totalRefusals = [...this.orgRefusalCounts.values()].reduce((a, b) => a + b, 0);
        await this.manager.log(this.instanceId, "INFO", "engine",
          `Throughput: ${joinsPer60}/min (60s) | ${joinsPer30}/min (30s est) | cap=${cfg.entryCapTotal}/min | recusas=${totalRefusals} | gargalo: ${bottleneck}${topOrgs ? ` | top_orgs: ${topOrgs}` : ""}`);
      }

      // Incrementa contador da janela conforme tipo de fila
      if (candidatePlayers > 0) {
        this.joinedWithPlayers++;
      } else {
        this.joinedWithoutPlayers++;
      }

      // ── Métricas de eficiência: registra join por org ──────────────────
      this.recordJoin(candidate.org_id);

      // ── Org scoring: registra join ─────────────────────────────────────
      this.orgJoinCounts.set(candidate.org_id, (this.orgJoinCounts.get(candidate.org_id) ?? 0) + 1);
      this.orgScores.set(candidate.org_id, (this.orgScores.get(candidate.org_id) ?? 0) + 1);
      this.lastClickAt = Date.now();

      // ── Diagnóstico de ciclo (chooseMs já calculado antes do sleep) ─────
      if (cfg.enable60RpmMode) {
        this.chooseLatencies.push(chooseMs);
        if (this.chooseLatencies.length > 120) this.chooseLatencies.shift();
      }
      if (chooseMs > (cfg.enable60RpmMode ? CHOOSE_WARN_STAGE_MS : 500)) {
        void this.manager.log(this.instanceId, "INFO", "engine",
          `Diag chooseQueue: select=${chooseMs}ms | active_db=${t_active_ms}ms | bg_refresh=${this.bgRefreshRunning} | pending_checks=${this.pendingRefusalChecks} | elegíveis_org=${candidateEligibleCount}`);
      }

      // ── Rate limit por org: após N cliques na org atual, avança ─────────
      if (cfg.clicksPerOrg > 0) {
        const orgId = candidate.org_id;
        const prev = this.orgClickCounts.get(orgId) ?? 0;
        const count = prev + 1;
        this.orgClickCounts.set(orgId, count);

        // Committed limit: definido no 1º clique da sessão e mantido estável
        // até o reset. Evita o bug "clicks concluídos 9/5" causado pela condição
        // isHotOrg oscilar entre ticks enquanto o count acumula.
        if (count === 1) {
          const isHotFirst = cfg.hotOrgExtraClicks > 0
            && candidateEligibleCount >= 5
            && !this.isOrgInLimitCooldown(orgId).blocked;
          this.orgClickLimits.set(
            orgId,
            isHotFirst ? cfg.clicksPerOrg + cfg.hotOrgExtraClicks : cfg.clicksPerOrg,
          );
        }
        const effectiveLimit = this.orgClickLimits.get(orgId) ?? cfg.clicksPerOrg;

        if (count >= effectiveLimit) {
          this.orgClickCounts.set(orgId, 0);
          this.orgClickLimits.delete(orgId);
          const orgIdx = cfg.selected_org_ids.indexOf(orgId);
          if (orgIdx >= 0) {
            this.orgCursor = (orgIdx + 1) % totalOrgs;
          }
          const hotLabel = effectiveLimit > cfg.clicksPerOrg ? ` (modo quente +${cfg.hotOrgExtraClicks})` : "";
          void this.manager.log(this.instanceId, "INFO", "engine",
            `Próxima org — clicks concluídos ${count}/${effectiveLimit}${hotLabel} em "${candidate.org_name}".`);
        } else {
          const prefix = count === 1 ? `Iniciando org "${candidate.org_name}"` : `Org "${candidate.org_name}"`;
          void this.manager.log(this.instanceId, "INFO", "engine",
            `${prefix} — click ${count}/${effectiveLimit}.`);
        }
      }

      // per_n_orgs: conta entradas no token atual; ao atingir N, rotaciona
      if (cfg.tokenStrategy === "per_n_orgs" && tokens.length > 1) {
        this.joinsOnCurrentToken++;
        if (this.joinsOnCurrentToken >= cfg.tokenStrategyN) {
          this.joinsOnCurrentToken = 0;
          this.tokenCursor = (this.tokenCursor + 1) % tokens.length;
          void this.manager.log(this.instanceId, "INFO", "engine",
            `Rotacionando token após ${cfg.tokenStrategyN} entrada(s) — próximo: token #${tokens[this.tokenCursor % tokens.length]?.position ?? this.tokenCursor + 1}.`);
        }
      }

      // Log imediato quando cap individual é atingido (fire-and-forget)
      if (candidatePlayers > 0 && this.joinedWithPlayers === cfg.entryCapWithPlayers) {
        void this.manager.log(this.instanceId, "INFO", "engine",
          `Cap de entrada atingido: tipo=players usado=${this.joinedWithPlayers}/${cfg.entryCapWithPlayers} janela=60s`);
      } else if (candidatePlayers === 0 && this.joinedWithoutPlayers === cfg.entryCapEmpty) {
        void this.manager.log(this.instanceId, "INFO", "engine",
          `Cap de entrada atingido: tipo=vazias usado=${this.joinedWithoutPlayers}/${cfg.entryCapEmpty} janela=60s`);
      }

      // Se acabamos de bater o total, dispara a pausa já
      const totalNow = this.joinedWithPlayers + this.joinedWithoutPlayers;
      if (totalNow >= cfg.entryCapTotal) {
        const pause = randInt(cfg.timingPauseMinMs, cfg.timingPauseMaxMs);
        const wp = this.joinedWithPlayers;
        const np = this.joinedWithoutPlayers;
        this.joinedWithPlayers = 0;
        this.joinedWithoutPlayers = 0;
        this.windowStart = 0;
        let total = pause;
        if (this.extraDelayMs > 0) {
          total += this.extraDelayMs;
          this.extraDelayMs = 0;
        }
        this.nextJoinAt = Date.now() + total;
        void this.manager.log(this.instanceId, "INFO", "engine",
          `Cap de entrada atingido: total usado=${wp + np}/${cfg.entryCapTotal} janela=60s — pausando ${Math.round(pause / 1000)}s.`);
        return;
      }
    }

    // Cooldown curto entre entradas dentro da janela (configurável)
    let cooldown = randInt(cfg.timingIntraMinMs, cfg.timingIntraMaxMs);
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
    try {
      await query(
        `INSERT INTO token_org_blacklist (token_id, org_id, reason)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tokenId, orgId, reason],
      );
    } catch (fkErr: unknown) {
      // FK violation (23503): token_id foi deletado/recriado entre a leitura e o insert.
      // A blacklist em memória já está setada; ignoramos o erro de persistência.
      const code = (fkErr as any)?.code;
      if (code !== "23503") throw fkErr;
      void this.manager.log(this.instanceId, "WARN", "engine",
        `blacklistOrgForToken: FK violation — token_id=${tokenId} não existe mais no DB (org="${orgName}"). Blacklist mantida em memória.`);
      return;
    }
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

  /**
   * Rankeia candidatos por nº de players — NÃO BLOQUEANTE.
   * Retorna imediatamente com valores em cache; agenda refresh em background.
   * Isso elimina o principal gargalo anterior (~4s de waits seriais por tick).
   */
  private async rankCandidatesByPlayers(
    candidates: ChannelRow[],
    activeToken: ActiveToken,
    blockedNames: string[] = [],
  ): Promise<{ candidates: Array<{ ch: ChannelRow; players: number }> }> {
    const now = Date.now();
    const keyOf = (c: ChannelRow) => `${c.channel_id}:${c.message_id}`;

    // Identificar entradas stale para refresh em background
    const stale = candidates
      .filter((c) => {
        const cached = this.playerCache.get(keyOf(c));
        return !cached || now - cached.ts > PLAYER_CACHE_MS;
      })
      .slice(0, MAX_FRESH_FETCH_PER_TICK);

    // Agendar refresh em background (não bloqueia o tick)
    if (stale.length > 0 && !this.bgRefreshRunning) {
      this.bgRefreshQueue = stale;
      this.bgRefreshToken = activeToken;
      this.bgRefreshBlockedNames = blockedNames;
      void this.runBackgroundPlayerRefresh();
    }

    // Retorna IMEDIATAMENTE com valores em cache (0 = sem cache = assume vazia)
    const scored = candidates
      .map((c) => {
        const cached = this.playerCache.get(keyOf(c));
        return { ch: c, players: cached?.count ?? 0 };
      })
      .filter((s) => s.players >= 0);
    scored.sort((a, b) => b.players - a.players);

    return { candidates: scored };
  }

  /** Faz os fetches REST para atualizar o player cache em background, sem bloquear o tick. */
  private async runBackgroundPlayerRefresh(): Promise<void> {
    if (this.bgRefreshRunning) return;
    this.bgRefreshRunning = true;
    const token = this.bgRefreshToken;
    const toRefresh = [...this.bgRefreshQueue];
    const blockedNames = this.bgRefreshBlockedNames;
    this.bgRefreshQueue = [];

    if (!token) { this.bgRefreshRunning = false; return; }

    const rest = new DiscordRest(token.token);
    for (const c of toRefresh) {
      if (this.stopped) break;
      if (!c.message_id) continue;
      await sleep(300 + Math.floor(Math.random() * 500));
      try {
        const r = await rest.fetchMessage(c.channel_id, c.message_id);
        const key = `${c.channel_id}:${c.message_id}`;
        if (r.status === 200 && r.data) {
          const blocked = blockedNames.length > 0 && hasBlockedName(r.data, blockedNames);
          const playerCount = blocked ? -1 : countPlayers(r.data);
          this.playerCache.set(key, { count: playerCount, ts: Date.now() });
          if (blocked) {
            void this.manager.log(this.instanceId, "WARN", "engine",
              `Fila bloqueada em ${c.org_name} · #${c.channel_name ?? c.channel_id} — nome na lista de bloqueio.`);
            void query(`UPDATE stats SET bloqueadas = bloqueadas + 1 WHERE instance_id = $1`, [this.instanceId]);
          }
        } else if (r.status === 403) {
          this.playerCache.set(`${c.channel_id}:${c.message_id}`, {
            count: 0, ts: Date.now() - PLAYER_CACHE_MS + PLAYER_CACHE_403_MS,
          });
        } else if (r.status === 404) {
          // 404 na mensagem: canal provavelmente foi deletado — remove do buffer e agenda re-discovery
          this.evictCandidate(c.channel_id, c.message_id ?? "");
          this.scheduleOrgRediscovery(c.org_id, c.org_name, token.token, "mensagem 404 ao ler (bg)", token.tokenId, token.position);
          this.playerCache.set(`${c.channel_id}:${c.message_id}`, { count: 0, ts: Date.now() });
        }
      } catch {
        // Silencioso — refresh de background não pode travar o motor
      }
    }
    this.bgRefreshRunning = false;
  }

  /** Re-roda a discovery de uma única org (em background, deduplicado). */
  private rediscoveryQueued = new Set<number>();
  private scheduleOrgRediscovery(
    orgId: number,
    orgName: string,
    token: string,
    reason: string,
    tokenId?: number,
    tokenPos?: number,
  ): void {
    if (this.rediscoveryQueued.has(orgId)) return;
    this.rediscoveryQueued.add(orgId);
    void (async () => {
      try {
        const rows = await query<{ guild_id: string | null }>(
          `SELECT guild_id FROM orgs WHERE id = $1`,
          [orgId],
        );
        const guildId = rows[0]?.guild_id;
        if (!guildId) return;

        // Verifica cooldown por guild antes de re-descobrir
        if (this.discoveryBudget.isCoolingDown(guildId)) {
          const remSec = Math.ceil(this.discoveryBudget.remainingMs(guildId) / 1000);
          await this.manager.log(this.instanceId, "INFO", "discovery",
            `Re-discovery de ${orgName} adiada — cooldown de 429 ativo (${remSec}s restantes).`);
          return;
        }

        const { discoverOrg } = await import("../discord/discovery.js");
        const r = await discoverOrg(token, orgId, guildId);

        if (!r.ok && r.was_rate_limited) {
          // Aplica cooldown para evitar re-tentar imediatamente
          this.discoveryBudget.setCooldown429(guildId);
          this.discoveryBudget.failed429++;
          const remSec = Math.ceil(this.discoveryBudget.remainingMs(guildId) / 1000);
          await this.manager.log(this.instanceId, "WARN", "discovery",
            `Re-discovery de ${orgName} (${reason}): rate limit 429 — cooldown de ${remSec}s aplicado.`);
        } else if (!r.ok && isPermanentAccessError(r.error)) {
          // Erro permanente (50001): token não tem acesso à guild — adiciona à blacklist
          // para evitar re-tentativas infinitas a cada 30s.
          if (tokenId !== undefined && tokenPos !== undefined) {
            await this.blacklistOrgForToken(
              tokenId,
              tokenPos,
              orgId,
              orgName,
              `re-discovery: sem acesso permanente (50001) — ${reason}`,
            );
          } else {
            await this.manager.log(this.instanceId, "WARN", "discovery",
              `Re-discovery de ${orgName} falhou com 50001 mas tokenId não disponível — não foi possível blacklistar.`);
          }
        } else {
          await this.manager.log(
            this.instanceId,
            r.ok ? "INFO" : "WARN",
            "discovery",
            r.ok
              ? `Re-discovery de ${orgName} (${reason}): ${r.queues_saved} fila(s) atualizadas.`
              : `Re-discovery de ${orgName} falhou: ${r.error ?? "?"}`,
          );
          if (r.ok) {
            this.discoveryBudget.succeeded++;
            this.invalidateCaches();
          }
        }
      } catch (err) {
        await this.manager.log(
          this.instanceId,
          "WARN",
          "discovery",
          `Re-discovery de ${orgName} exceção: ${(err as Error).message}`,
        );
      } finally {
        // Libera após 30s pra permitir nova re-descoberta se voltar a falhar (erros não-permanentes)
        setTimeout(() => this.rediscoveryQueued.delete(orgId), 30_000);
      }
    })();
  }

  private async joinQueue(
    ch: ChannelRow,
    token: ActiveToken,
    activeCount: number,
    playersInQueue: number,
    refusalCheckDelayMs: number = DEFAULT_REFUSAL_CHECK_DELAY_MS,
    enable60Rpm = false,
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
      // ── Registro otimista imediato (CRÍTICO — awaited) ─────────────────
      // Deve ser síncrono para que o próximo tick veja essa fila como ativa
      // e não tente entrar nela de novo antes da verificação de recusa.
      await query(
        `INSERT INTO active_queues
           (instance_id, org_id, channel_id, message_id, mode, category, token_id, joined_with_players)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (instance_id, channel_id, message_id) DO NOTHING`,
        [
          this.instanceId,
          ch.org_id,
          ch.channel_id,
          ch.message_id,
          ch.mode,
          ch.category,
          token.tokenId,
          playersInQueue > 0,
        ],
      );
      this.recordSafetyEvent("ok");
      // 60rpm: atualiza cache local imediatamente (evita double-entry no próximo tick)
      if (enable60Rpm) {
        this.activeRowsCache = [...this.activeRowsCache, {
          channel_id: ch.channel_id,
          message_id: ch.message_id,
          org_id: ch.org_id,
          joined_with_players: playersInQueue > 0,
        }];
      }
      // ── Atualizações não-críticas (fire-and-forget — não bloqueiam próximo clique) ─
      void query(
        `UPDATE stats SET entradas = entradas + 1, na_fila = $2
         WHERE instance_id = $1`,
        [this.instanceId, activeCount + 1],
      );
      void query(
        `UPDATE tokens SET last_used_at = NOW() WHERE id = $1`,
        [token.tokenId],
      );
      void query(
        `INSERT INTO queue_joins (instance_id, org_id, org_name, mode, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.instanceId, ch.org_id, ch.org_name, ch.mode, ch.category],
      );
      this.playerCache.delete(`${ch.channel_id}:${ch.message_id}`);
      void this.manager.log(
        this.instanceId, "INFO", "engine",
        `Entrou em ${ch.org_name} · ${ch.category ?? "?"} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} (${tag}) · "${btn.label}" · token #${token.position}`,
      );

      // ── Verificação de recusa em background (não bloqueia próximo clique) ─
      // 60rpm: limite ampliado (15) e skip automático acima de 8 pendentes
      const pendingCap = enable60Rpm ? PENDING_CHECKS_MAX_60RPM : PENDING_CHECKS_MAX_NORMAL;
      const skipRefusalCheck = enable60Rpm && this.pendingRefusalChecks >= PENDING_CHECKS_SKIP_THRESHOLD;
      if (!skipRefusalCheck && this.pendingRefusalChecks < pendingCap) {
        this.pendingRefusalChecks++;
        void (async () => {
          try {
            const refusal = await this.detectRealLimitRefusal(ch, token, rest, refusalCheckDelayMs);
            if (refusal.type !== "none") {
              // Desfaz registro otimista
              await query(
                `DELETE FROM active_queues
                 WHERE instance_id = $1 AND channel_id = $2 AND message_id = $3`,
                [this.instanceId, ch.channel_id, ch.message_id],
              );
              await query(
                `UPDATE stats SET entradas = GREATEST(entradas - 1, 0), na_fila = GREATEST(na_fila - 1, 0)
                 WHERE instance_id = $1`,
                [this.instanceId],
              );
              // Scoring: recusa penaliza a org (-5 pts)
              this.orgRefusalCounts.set(ch.org_id, (this.orgRefusalCounts.get(ch.org_id) ?? 0) + 1);
              this.orgScores.set(ch.org_id, (this.orgScores.get(ch.org_id) ?? 0) - 5);
              this.recordSafetyEvent("refusal");
              this.checkEnterSafeMode(enable60Rpm);
              if (refusal.type === "wait") {
                const waitMs = Math.min(refusal.waitMs ?? WAIT_DETECT_COOLDOWN_MS, 120_000);
                this.setOrgLimitCooldown(ch.org_id, waitMs);
                await this.manager.log(this.instanceId, "WARN", "engine",
                  `Org ${ch.org_name} — recusa detectada (cooldown curto): "${refusal.text}" (aguardando ${Math.ceil(waitMs / 1000)}s). Entrada desfeita.`);
              } else {
                this.setOrgLimitCooldown(ch.org_id, REAL_LIMIT_COOLDOWN_MS);
                await this.manager.log(this.instanceId, "WARN", "engine",
                  `Org ${ch.org_name} — recusa detectada (limite real): "${refusal.text}". Org pausada por ${REAL_LIMIT_COOLDOWN_MS / 60_000}min. Entrada desfeita.`);
              }
            }
          } catch (err) {
            // Verificação falhou silenciosamente — mantém o registro otimista
            void this.manager.log(this.instanceId, "WARN", "engine",
              `Verificação de recusa falhou em ${ch.org_name}: ${(err as Error).message}`);
          } finally {
            this.pendingRefusalChecks--;
          }
        })();
      }

      return true;
    } else if (r.status === 429) {
      this.recordSafetyEvent("429");
      this.checkEnterSafeMode(enable60Rpm);

      // Extrai retry_after do corpo JSON do Discord
      let retryAfterMs = 0;
      try {
        const body = JSON.parse(r.error ?? "{}") as { retry_after?: number; global?: boolean };
        retryAfterMs = Math.round((body.retry_after ?? 0) * 1000);
      } catch { /* não é JSON — usa backoff padrão */ }

      if (retryAfterMs > ORG_RATELIMIT_LOCAL_MAX_MS) {
        // retry_after alto (ex: 172s) → cooldown POR ORG+TOKEN, NÃO global
        // O scheduler continua rodando nas demais orgs sem interrupção.
        this.setOrgTokenRateLimitCooldown(ch.org_id, token.tokenId, retryAfterMs);
        const pauseSec = Math.ceil(retryAfterMs / 1000);
        await this.manager.log(
          this.instanceId, "WARN", "engine",
          `Org "${ch.org_name}" pausada por ${pauseSec}s por rate limit (retry_after=${pauseSec}s) — token #${token.position}. Demais orgs continuam normais.`,
        );
      } else {
        // retry_after pequeno (≤2s) ou ausente → backoff local pontual
        const localWait = retryAfterMs > 0
          ? retryAfterMs + 200
          : randInt(1_500, 3_000);
        await sleep(localWait);
        await this.manager.log(
          this.instanceId, "WARN", "engine",
          `Rate-limited em ${ch.org_name} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} — aguardou ${Math.round(localWait / 1000)}s localmente.`,
        );
      }
      return false;
    } else if (r.status === 403 || isMissingAccess(r.status, r.error)) {
      // Erros de org inválida/sem acesso: se for 10004 (Unknown Guild) ou 50001 (Missing Access),
      // são erros de configuração — blacklista a org mas NÃO conta como erro crítico no safe mode.
      const rawError = r.error?.slice(0, 200) ?? "";
      if (isIgnorableOrgError(r.status, r.error)) {
        this.recordSafetyEvent("ignored");
        // Não chama checkEnterSafeMode — erro de org bloqueada/inválida não é instabilidade sistêmica
      } else {
        this.recordSafetyEvent("403");
        this.checkEnterSafeMode(enable60Rpm);
      }
      await this.blacklistOrgForToken(
        token.tokenId,
        token.position,
        ch.org_id,
        ch.org_name,
        `HTTP ${r.status} — acesso negado/banido (${rawError})`,
      );
      return false;
    } else if (r.status === 404 || (r.error ?? "").toLowerCase().includes("unknown message")) {
      // Mensagem da fila sumiu/mudou — agenda re-discovery dessa org
      this.scheduleOrgRediscovery(ch.org_id, ch.org_name, token.token, `clique HTTP ${r.status}`, token.tokenId, token.position);
      this.playerCache.delete(`${ch.channel_id}:${ch.message_id}`);
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

  /**
   * Após um clique bem-sucedido (HTTP 2xx), aguarda alguns segundos e lê
   * as mensagens recentes do canal para detectar respostas de recusa da org.
   *
   * Retorna:
   *  - { type: "none" }              → sem recusa detectada, entrada válida
   *  - { type: "limit", text }       → limite real atingido (3 min de cooldown)
   *  - { type: "wait", text, waitMs} → cooldown curto detectado ("aguarde Xs")
   */
  private async detectRealLimitRefusal(
    ch: ChannelRow,
    token: ActiveToken,
    rest: DiscordRest,
    delayMs: number = DEFAULT_REFUSAL_CHECK_DELAY_MS,
  ): Promise<{ type: "none" | "limit" | "wait"; text: string; waitMs?: number }> {
    const clickedAt = Date.now();
    await sleep(delayMs);

    const { data: msgs } = await rest.channelMessages(ch.channel_id, 8).catch(() => ({ data: null }));
    if (!msgs || msgs.length === 0) return { type: "none", text: "" };

    // Janela: mensagens postadas após o clique (com margem de 1s antes)
    const cutoff = clickedAt - 1_000;

    for (const msg of msgs) {
      const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
      if (ts < cutoff) break; // mensagens em ordem decrescente — para no primeiro antigo

      // Considera apenas mensagens que mencionam nosso userId OU do bot da org
      const mentionsUs =
        msg.content.includes(`<@${token.userId}>`) ||
        msg.content.includes(`<@!${token.userId}>`);
      const isOrgBot = msg.author?.bot === true || !!msg.application_id;
      if (!mentionsUs && !isOrgBot) continue;

      const embedText = (msg.embeds ?? [])
        .map((e) =>
          [e.title ?? "", e.description ?? "", ...(e.fields ?? []).map((f) => f.value)].join(" "),
        )
        .join(" ");
      const fullText = (msg.content + " " + embedText).toLowerCase();

      // ── Padrões de limite real ───────────────────────────────────────
      if (
        fullText.includes("atingiu o limite de filas") ||
        fullText.includes("limite de fila") ||
        fullText.includes("máximo de partidas possível") ||
        fullText.includes("maximo de partidas") ||
        fullText.includes("espere ela ser finalizada") ||
        fullText.includes("espere ser finalizada") ||
        fullText.includes("você está no máximo") ||
        fullText.includes("voce esta no maximo")
      ) {
        const preview = (msg.content || embedText).slice(0, 120).replace(/\n/g, " ");
        return { type: "limit", text: preview };
      }

      // ── Cooldown curto: "aguarde Xs" / "aguarde 4 segundos" ──────────
      const waitMatch = fullText.match(/aguarde[^\d]*(\d+)\s*s(?:egundo)?/);
      if (waitMatch) {
        const secs = parseInt(waitMatch[1] ?? "30", 10);
        const preview = (msg.content || embedText).slice(0, 120).replace(/\n/g, " ");
        return { type: "wait", text: preview, waitMs: secs * 1000 + 2_000 };
      }
    }

    return { type: "none", text: "" };
  }

  /** Registra evento de segurança na janela deslizante (120s).
   *  "ignored" = erros de org inválida/bloqueada que NÃO devem ativar safe mode. */
  private recordSafetyEvent(type: "ok" | "429" | "403" | "refusal" | "ignored"): void {
    const now = Date.now();
    this.safetyEvents.push({ ts: now, type });
    if (this.safetyEvents.length > 400) {
      this.safetyEvents = this.safetyEvents.filter(e => now - e.ts < 120_000);
    }
    if (type === "ignored") this.ignoredCount10004++;
  }

  /**
   * Ativa modo seguro apenas quando:
   *  - há amostra mínima de 50 eventos na janela de 60s (evita ativação prematura)
   *  - apenas erros CRÍTICOS contam: 429, 403, refusal
   *  - erros "ignored" (10004/50001/blacklist) NÃO contam
   *
   * Loga safe_mode_check a cada chamada para auditoria.
   */
  private checkEnterSafeMode(enable60Rpm: boolean): void {
    if (!enable60Rpm || this.safeModeSince > 0) return;
    const now = Date.now();
    const recent = this.safetyEvents.filter(e => now - e.ts < 60_000);
    const total = recent.length;
    const ignored = recent.filter(e => e.type === "ignored").length;
    const critical = recent.filter(e => e.type === "429" || e.type === "403" || e.type === "refusal").length;
    const rate = total > 0 ? critical / total : 0;

    // Log de auditoria (fire-and-forget) — aparece no console para análise
    void this.manager.log(
      this.instanceId, "INFO", "engine",
      `safe_mode_check: critical=${critical} total=${total} rate=${Math.round(rate * 100)}% ignored=${ignored}`,
    );

    // Amostra mínima de 50 eventos — não ativa com poucos dados
    if (total < 50) return;

    // Threshold: 8% de erros críticos (não conta "ignored")
    if (rate > 0.08) {
      this.safeModeSince = now;
      void this.manager.log(
        this.instanceId, "WARN", "engine",
        `[60rpm] Modo seguro ativado por 2min — erros críticos: ${Math.round(rate * 100)}% (${critical}/${total} eventos, ${ignored} ignorados) em 60s.`,
      );
    }
  }

  /** Verifica se o modo seguro expirou e o cancela. */
  private exitSafeMode(): void {
    if (this.safeModeSince > 0 && Date.now() - this.safeModeSince >= SAFE_MODE_DURATION_MS) {
      this.safeModeSince = 0;
      void this.manager.log(
        this.instanceId, "INFO", "engine",
        "[60rpm] Modo seguro encerrado — retomando throughput máximo.",
      );
    }
  }

  /** Log de diagnóstico a cada 30s com todas as métricas do modo 60rpm. */
  private emit30sDiag(cfg: CycleConfig, activeCount: number): void {
    const now = Date.now();
    const joinsPer60 = this.recentJoinTs.filter(t => now - t < 60_000).length;
    const joinsPer30 = this.recentJoinTs.filter(t => now - t < 30_000).length * 2;

    const sorted = [...this.chooseLatencies].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.50)] ?? 0) : 0;
    const p95 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.95)] ?? 0) : 0;

    const recentEvts = this.safetyEvents.filter(e => now - e.ts < 60_000);
    const okEvts = recentEvts.filter(e => e.type === "ok").length;
    const ignoredEvts = recentEvts.filter(e => e.type === "ignored").length;
    const criticalEvts = recentEvts.filter(e => e.type === "429" || e.type === "403" || e.type === "refusal").length;
    // send_ok exclui eventos "ignored" do denominador (org inválida não é falha de envio)
    const countable = recentEvts.length - ignoredEvts;
    const sendRate = countable > 0
      ? `${Math.round(okEvts / countable * 100)}%` + (ignoredEvts > 0 ? `(ign=${ignoredEvts})` : "")
      : "n/a";

    const reasons = [...this.blockedReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r, n]) => `${r}:${n}`)
      .join(", ");

    const inSafe = this.safeModeSince > 0 && now - this.safeModeSince < SAFE_MODE_DURATION_MS;
    const cooldownSec = this.nextJoinAt > now ? Math.ceil((this.nextJoinAt - now) / 1000) : 0;
    const softStr = above60SoftLabel(activeCount, cfg.aqSoftLimit, cfg.aqHardLimit);

    // Buffer de candidatos
    const bufTotal = this.candidateBuffer.size;
    const bufValid = [...this.candidateBuffer.values()].filter(bc => bc.expiresAt > now).length;

    // Discovery budget
    const disc429 = this.discoveryBudget.failed429;
    const discCooldowns = this.discoveryBudget.activeCooldowns();

    // sem_candidatos acumulado desde o último diag
    const semCand = this.semCandidatosTotal;
    this.semCandidatosTotal = 0;

    void this.manager.log(
      this.instanceId, "INFO", "engine",
      `[60rpm diag] thrpt=${joinsPer60}/min(60s) ${joinsPer30}/min(30s)` +
      ` | chooseQ p50=${p50}ms p95=${p95}ms` +
      ` | active_q=${activeCount}${softStr}` +
      ` | pending=${this.pendingRefusalChecks}` +
      ` | send_ok=${sendRate}` +
      ` | buf=${bufValid}/${bufTotal}` +
      ` | sem_cand=${semCand}` +
      ` | disc_429=${disc429} disc_10004=${this.ignoredCount10004} disc_cooldowns=${discCooldowns}` +
      (cooldownSec > 0 ? ` | cooldown=${cooldownSec}s` : "") +
      (criticalEvts > 0 ? ` | critical_err=${criticalEvts}` : "") +
      (reasons ? ` | blocked: ${reasons}` : "") +
      (inSafe ? " | ⚠️ SAFE_MODE" : ""),
    );

    this.blockedReasons.clear();

    // Buffer diag detalhado: a cada 60s (2 ciclos de 30s)
    if (now - this.lastBufDiagAt >= 60_000) {
      this.lastBufDiagAt = now;
      void this.emitBufferDiag(cfg);
    }
  }

  /**
   * Loga diagnóstico detalhado do buffer de candidatos para ajudar a entender
   * por que o buffer pode estar menor do que o esperado.
   * Inclui: orgs selecionadas, blacklisted, canais por org, candidatos por categoria.
   */
  private async emitBufferDiag(cfg: CycleConfig): Promise<void> {
    const now = Date.now();
    const cached = this.channelCache?.rows ?? [];

    // Orgs que estão na seleção vs quantas têm canais no cache
    const orgIds = cfg.selected_org_ids;
    const orgWithChannels = new Set(cached.map(c => c.org_id));
    const orgsWithChannels = orgIds.filter(id => orgWithChannels.has(id)).length;
    const orgIdsWithoutCh = orgIds.filter(id => !orgWithChannels.has(id));
    const orgsWithoutChannels = orgIdsWithoutCh.length;

    // Busca os nomes das orgs sem canais para facilitar diagnóstico
    let semChOrgNames = "";
    if (orgIdsWithoutCh.length > 0) {
      try {
        const nameRows = await query<{ id: number; name: string }>(
          `SELECT id, name FROM orgs WHERE id = ANY($1)`,
          [orgIdsWithoutCh],
        );
        const nameMap = new Map(nameRows.map(r => [r.id, r.name]));
        semChOrgNames = orgIdsWithoutCh.map(id => nameMap.get(id) ?? `#${id}`).join(" ");
      } catch { /* não bloqueia o diag se a query falhar */ }
    }

    // Orgs blacklistadas para qualquer token desta instância
    let totalBlacklistedOrgs = 0;
    for (const orgSet of this.tokenOrgBlacklist.values()) {
      totalBlacklistedOrgs += [...orgSet].filter(id => orgIds.includes(id)).length;
    }

    // Buffer: válido vs expirado
    const bufValid: BufferedCandidate[] = [];
    const bufExpired: BufferedCandidate[] = [];
    for (const bc of this.candidateBuffer.values()) {
      if (bc.expiresAt > now) bufValid.push(bc); else bufExpired.push(bc);
    }

    // Canais por org no cache (top 5 orgs)
    const chPerOrg = new Map<string, number>();
    for (const c of cached) {
      chPerOrg.set(c.org_name, (chPerOrg.get(c.org_name) ?? 0) + 1);
    }
    const topOrgs = [...chPerOrg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => `${name.slice(0, 12)}:${n}ch`)
      .join(" ");

    // Candidatos válidos do buffer por categoria
    const catCounts = new Map<string, number>();
    for (const bc of bufValid) {
      const cat = bc.ch.category ?? "sem_cat";
      catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    }
    const catStr = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `${cat}:${n}`)
      .join(" ");

    // TTL médio restante dos válidos (indica frescor do buffer)
    let ttlAvgSec = 0;
    if (bufValid.length > 0) {
      const sumTtl = bufValid.reduce((s, bc) => s + (bc.expiresAt - now), 0);
      ttlAvgSec = Math.round(sumTtl / bufValid.length / 1000);
    }

    void this.manager.log(
      this.instanceId, "INFO", "engine",
      `[buf diag] orgs_sel=${orgIds.length} com_ch=${orgsWithChannels} sem_ch=${orgsWithoutChannels}` +
      ` | blacklisted_org_token_pairs=${totalBlacklistedOrgs}` +
      ` | cache_ch=${cached.length} buf_valid=${bufValid.length} buf_exp=${bufExpired.length}` +
      ` | ttl_avg=${ttlAvgSec}s` +
      (semChOrgNames ? ` | sem_ch_orgs: ${semChOrgNames}` : "") +
      (catStr ? ` | por_cat: ${catStr}` : "") +
      (topOrgs ? ` | top_orgs: ${topOrgs}` : ""),
    );
  }
}

function above60SoftLabel(active: number, soft: number, hard: number): string {
  if (active >= hard) return ` [HARD_LIMIT]`;
  if (active >= soft) return ` [soft>${soft}]`;
  return "";
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
// ─── Métricas de conversão por org ──────────────────────────────────────────

/** Retorna métricas de conversão para uma org na janela deslizante indicada. */
function calcConvMetrics(joins: number[], matches: number[], ghosts: number[], windowMs: number) {
  const cutoff = Date.now() - windowMs;
  const j = joins.filter(t => t > cutoff).length;
  const m = matches.filter(t => t > cutoff).length;
  const g = ghosts.filter(t => t > cutoff).length;
  const conversion_rate = j > 0 ? m / j : 0;
  const ghost_rate = j > 0 ? g / j : 0;
  return { joins: j, matches: m, ghosts: g, conversion_rate, ghost_rate };
}

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

/**
 * Retorna true para erros de org inválida/bloqueada que NÃO devem contar como
 * falha crítica no safe mode. São erros de configuração/estado permanente:
 *   - 10004: Unknown Guild (token não está mais no servidor)
 *   - 50001: Missing Access (token sem permissão estrutural)
 *   - 40001: Unauthorized
 * Erros 403 puros (sem código Discord = ban dinâmico) ainda são críticos.
 */
function isIgnorableOrgError(status: number, error?: string): boolean {
  if (!error) return false;
  const body = error.toLowerCase();
  // Ignoráveis: org removida/inválida, token banido estruturalmente
  const IGNORABLE_CODES = ["10004", "50001", "40001", "10003"];
  const IGNORABLE_PHRASES = ["unknown guild", "servidor desconhecido"];
  // 403 puro sem código interno = possível ban dinâmico = crítico
  if (status === 403 && !IGNORABLE_CODES.some(c => body.includes(c)) &&
      !IGNORABLE_PHRASES.some(p => body.includes(p))) {
    return false;
  }
  return IGNORABLE_CODES.some(c => body.includes(c)) ||
         IGNORABLE_PHRASES.some(p => body.includes(p));
}
