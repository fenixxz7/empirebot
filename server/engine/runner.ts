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
  timingIntraMinMs: number;
  timingIntraMaxMs: number;
  timingPauseMinMs: number;
  timingPauseMaxMs: number;
  timingClickMinMs: number;
  timingClickMaxMs: number;
  clicksPerOrg: number;
  entryCapWithPlayers: number;
  entryCapEmpty: number;
  entryCapTotal: number;
  refusalCheckDelayMs: number;
}

const STARTUP_GRACE_MS = 5000;
// Intervalo fixo do tick — rápido para não atrasar reconhecimento e sweep.
const TICK_INTERVAL_MS = 2500;
const NO_TOKEN_LOG_INTERVAL_MS = 30_000;
const NO_WORK_LOG_INTERVAL_MS = 60_000;
const PLAYER_CACHE_MS = 30_000;
const PLAYER_CACHE_403_MS = 10 * 60_000;
const MAX_FRESH_FETCH_PER_TICK = 6;
import { ACTIVE_QUEUE_TTL_MS } from "../lib/timings.js";

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
      // Sweep de filas fantasmas a cada 30s (idempotente) — roda independente do cooldown de fila
      await this.sweepGhostQueues();
      if (this.paused) return; // descobre canais primeiro, clica depois
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
        `Sweep: removidas ${removed.length} fila(s) fantasma (>4min sem virar partida).`,
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
      timing_intra_min_ms: number;
      timing_intra_max_ms: number;
      timing_pause_min_ms: number;
      timing_pause_max_ms: number;
      timing_click_min_ms: number;
      timing_click_max_ms: number;
      clicks_per_org: number;
      entry_cap_with_players_per_60s: number;
      entry_cap_empty_per_60s: number;
      entry_cap_total_per_60s: number;
      refusal_check_delay_ms: number;
    }>(
      `SELECT delay_seconds, allowed_modes, allowed_categories, blocked_names,
              max_valor, token_strategy, token_strategy_n,
              timing_intra_min_ms, timing_intra_max_ms,
              timing_pause_min_ms, timing_pause_max_ms,
              timing_click_min_ms, timing_click_max_ms,
              clicks_per_org,
              entry_cap_with_players_per_60s,
              entry_cap_empty_per_60s,
              entry_cap_total_per_60s,
              refusal_check_delay_ms
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
    return {
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
      entryCapWithPlayers: Math.max(0, Math.min(200, r?.entry_cap_with_players_per_60s ?? 30)),
      entryCapEmpty: Math.max(0, Math.min(200, r?.entry_cap_empty_per_60s ?? 18)),
      entryCapTotal: Math.max(0, Math.min(200, r?.entry_cap_total_per_60s ?? 48)),
      refusalCheckDelayMs: Math.min(5000, Math.max(300, r?.refusal_check_delay_ms ?? DEFAULT_REFUSAL_CHECK_DELAY_MS)),
    };
  }

  private async iterate(cfg: CycleConfig): Promise<void> {
    const now = Date.now();
    if (now < this.nextJoinAt) return;

    // === Janela de rate: reseta se passou 60s ===
    if (now - this.windowStart > RATE_WINDOW_MS) {
      this.windowStart = now;
      this.joinedWithPlayers = 0;
      this.joinedWithoutPlayers = 0;
      await this.manager.log(
        this.instanceId,
        "INFO",
        "engine",
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
      await this.manager.log(
        this.instanceId,
        "INFO",
        "engine",
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
      joined_with_players: boolean;
    }>(
      `SELECT channel_id, message_id, org_id, joined_with_players
       FROM active_queues WHERE instance_id = $1`,
      [this.instanceId],
    );
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

    const orgIds = cfg.selected_org_ids;
    const totalOrgs = orgIds.length;
    let attempts = 0;
    let candidate: ChannelRow | null = null;
    let candidatePlayers = 0;
    let advancedDueToFull = false;

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
      let bestOrg: { idx: number; players: number } | null = null;
      for (let i = 0; i < totalOrgs; i++) {
        const orgId = orgIds[i]!;
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
        if (maxPlayers > 0 && (!bestOrg || maxPlayers > bestOrg.players)) {
          bestOrg = { idx: i, players: maxPlayers };
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

      // Cooldown de limite real: org foi recusada pela própria plataforma recentemente
      const limitCd = this.isOrgInLimitCooldown(currentOrgId);
      if (limitCd.blocked) {
        this.orgCursor = (this.orgCursor + 1) % totalOrgs;
        attempts++;
        advancedDueToFull = true;
        const lastLog = this.lastOrgLimitLog.get(currentOrgId) ?? 0;
        if (Date.now() - lastLog > 60_000) {
          this.lastOrgLimitLog.set(currentOrgId, Date.now());
          const orgName = orgChannels[0]?.org_name ?? String(currentOrgId);
          await this.manager.log(this.instanceId, "INFO", "engine",
            `Org ${orgName} ignorada — cooldown de limite real (${Math.ceil(limitCd.remainingMs / 1000)}s restantes).`);
        }
        continue;
      }

      // max_queues como teto de segurança opcional (0 = sem limite artificial)
      if (maxForOrg > 0 && activeForOrg >= maxForOrg) {
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
      if (!pick && noPlayersSlotPreferred && !emptyBlocked && Math.random() < 0.60) {
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

    // Pausa humanizada curta antes de clicar (configurável)
    await sleep(randInt(cfg.timingClickMinMs, cfg.timingClickMaxMs));

    const joined = await this.joinQueue(candidate, token, activeRows.length, candidatePlayers, cfg.refusalCheckDelayMs);

    if (joined) {
      // Registra timestamp para cálculo de throughput
      this.recentJoinTs.push(Date.now());
      // Mantém apenas os últimos 120s de dados (buffer deslizante)
      const cutoffTs = Date.now() - 120_000;
      this.recentJoinTs = this.recentJoinTs.filter(t => t > cutoffTs);

      // Log periódico de throughput com diagnóstico de gargalo
      const nowLog = Date.now();
      if (nowLog - this.lastThroughputLog > 60_000) {
        this.lastThroughputLog = nowLog;
        const joinsPer60 = this.recentJoinTs.filter(t => nowLog - t < 60_000).length;
        let bottleneck = "aguardando filas";
        if (this.pendingRefusalChecks > 0) bottleneck = `verificações pendentes (${this.pendingRefusalChecks})`;
        else if (this.nextJoinAt > nowLog) bottleneck = `cooldown intra (${Math.ceil((this.nextJoinAt - nowLog) / 1000)}s)`;
        await this.manager.log(this.instanceId, "INFO", "engine",
          `Throughput: ${joinsPer60} entradas/min (últimos 60s), cap=${cfg.entryCapTotal}/min — gargalo: ${bottleneck}`);
      }

      // Incrementa contador da janela conforme tipo de fila
      if (candidatePlayers > 0) {
        this.joinedWithPlayers++;
      } else {
        this.joinedWithoutPlayers++;
      }

      // Rate limit por org: após N cliques na org atual, avança para próxima
      if (cfg.clicksPerOrg > 0) {
        const orgId = candidate.org_id;
        const prev = this.orgClickCounts.get(orgId) ?? 0;
        const count = prev + 1;
        this.orgClickCounts.set(orgId, count);
        if (count >= cfg.clicksPerOrg) {
          this.orgClickCounts.set(orgId, 0);
          const orgIdx = cfg.selected_org_ids.indexOf(orgId);
          if (orgIdx >= 0) {
            this.orgCursor = (orgIdx + 1) % totalOrgs;
          }
          await this.manager.log(
            this.instanceId,
            "INFO",
            "engine",
            `Próxima org — clicks concluídos ${count}/${cfg.clicksPerOrg} em "${candidate.org_name}".`,
          );
        } else {
          const prefix = count === 1 ? `Iniciando org "${candidate.org_name}"` : `Org "${candidate.org_name}"`;
          await this.manager.log(
            this.instanceId,
            "INFO",
            "engine",
            `${prefix} — click ${count}/${cfg.clicksPerOrg}.`,
          );
        }
      }

      // per_n_orgs: conta entradas no token atual; ao atingir N, rotaciona
      if (cfg.tokenStrategy === "per_n_orgs" && tokens.length > 1) {
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

      // Log imediato quando cap individual é atingido
      if (candidatePlayers > 0 && this.joinedWithPlayers === cfg.entryCapWithPlayers) {
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Cap de entrada atingido: tipo=players usado=${this.joinedWithPlayers}/${cfg.entryCapWithPlayers} janela=60s`,
        );
      } else if (candidatePlayers === 0 && this.joinedWithoutPlayers === cfg.entryCapEmpty) {
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Cap de entrada atingido: tipo=vazias usado=${this.joinedWithoutPlayers}/${cfg.entryCapEmpty} janela=60s`,
        );
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
        await this.manager.log(
          this.instanceId,
          "INFO",
          "engine",
          `Cap de entrada atingido: total usado=${wp + np}/${cfg.entryCapTotal} janela=60s — pausando ${Math.round(pause / 1000)}s.`,
        );
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
  ): Promise<{ candidates: Array<{ ch: ChannelRow; players: number }> }> {
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
      await sleep(350 + Math.floor(Math.random() * 650));
      const r = await rest.fetchMessage(c.channel_id, c.message_id);
      if (r.status === 200 && r.data) {
        const blocked = blockedNames.length > 0 && hasBlockedName(r.data, blockedNames);
        const playerCount = blocked ? -1 : countPlayers(r.data);
        this.playerCache.set(keyOf(c), { count: playerCount, ts: Date.now() });
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
        this.playerCache.set(keyOf(c), { count: 0, ts: Date.now() - PLAYER_CACHE_MS + PLAYER_CACHE_403_MS });
      } else if (r.status === 404) {
        // Mensagem sumiu — re-discovery para re-cadastrar essa org
        this.scheduleOrgRediscovery(c.org_id, c.org_name, activeToken.token, "mensagem 404 ao ler");
        this.playerCache.set(keyOf(c), { count: 0, ts: Date.now() });
      }
    }

    // Filtra blocked (-1); o resto entra ranqueado por nº de players desc
    const scored = candidates
      .map((c) => {
        const cached = this.playerCache.get(keyOf(c));
        return { ch: c, players: cached?.count ?? 0 };
      })
      .filter((s) => s.players >= 0);
    scored.sort((a, b) => b.players - a.players);

    return { candidates: scored };
  }

  /** Re-roda a discovery de uma única org (em background, deduplicado). */
  private rediscoveryQueued = new Set<number>();
  private scheduleOrgRediscovery(
    orgId: number,
    orgName: string,
    token: string,
    reason: string,
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
        const { discoverOrg } = await import("../discord/discovery.js");
        const r = await discoverOrg(token, orgId, guildId);
        await this.manager.log(
          this.instanceId,
          r.ok ? "INFO" : "WARN",
          "discovery",
          r.ok
            ? `Re-discovery de ${orgName} (${reason}): ${r.queues_saved} fila(s) atualizadas.`
            : `Re-discovery de ${orgName} falhou: ${r.error ?? "?"}`,
        );
      } catch (err) {
        await this.manager.log(
          this.instanceId,
          "WARN",
          "discovery",
          `Re-discovery de ${orgName} exceção: ${(err as Error).message}`,
        );
      } finally {
        // Libera após 30s pra permitir nova re-descoberta se voltar a falhar
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
      // ── Registro otimista imediato ─────────────────────────────────────
      // Registra a entrada ANTES de verificar a resposta da org, para que o
      // próximo clique comece imediatamente sem esperar o delay de verificação.
      // Se a org recusar, a tarefa em background desfaz o registro.
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
      await query(
        `UPDATE stats SET entradas = entradas + 1, na_fila = $2
         WHERE instance_id = $1`,
        [this.instanceId, activeCount + 1],
      );
      await query(
        `UPDATE tokens SET last_used_at = NOW() WHERE id = $1`,
        [token.tokenId],
      );
      await query(
        `INSERT INTO queue_joins (instance_id, org_id, org_name, mode, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [this.instanceId, ch.org_id, ch.org_name, ch.mode, ch.category],
      );
      this.playerCache.delete(`${ch.channel_id}:${ch.message_id}`);
      await this.manager.log(
        this.instanceId, "INFO", "engine",
        `Entrou em ${ch.org_name} · ${ch.category ?? "?"} · ${modeLabel} · #${ch.channel_name ?? ch.channel_id} (${tag}) · "${btn.label}" · token #${token.position}`,
      );

      // ── Verificação de recusa em background (não bloqueia próximo clique) ─
      // Limite de concorrência: no máximo 5 verificações simultâneas.
      if (this.pendingRefusalChecks < 5) {
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
    } else if (r.status === 404 || (r.error ?? "").toLowerCase().includes("unknown message")) {
      // Mensagem da fila sumiu/mudou — agenda re-discovery dessa org
      this.scheduleOrgRediscovery(ch.org_id, ch.org_name, token.token, `clique HTTP ${r.status}`);
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
