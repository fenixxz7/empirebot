import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RotationReason =
  | "health_below_minimum"
  | "max_continuous_time"
  | "rate_limit"
  | "session_dead"
  | "token_invalid"
  | "shadow_limit"
  | "consecutive_failures"
  | "heartbeat_failed"
  | "quarantine"
  | "critical_state"
  | "manual"
  | "failover";

export const ROTATION_REASON_LABELS: Record<RotationReason, string> = {
  health_below_minimum:  "Health abaixo do mínimo",
  max_continuous_time:   "Tempo máximo atingido",
  rate_limit:            "Rate limit grave",
  session_dead:          "Sessão morreu",
  token_invalid:         "Token inválido",
  shadow_limit:          "Shadow limit",
  consecutive_failures:  "Falhas consecutivas",
  heartbeat_failed:      "Heartbeat falhou",
  quarantine:            "Entrou em quarentena",
  critical_state:        "Estado crítico",
  manual:                "Manual",
  failover:              "Failover",
};

interface AccountCandidate {
  id: number;
  nickname: string;
  token_value: string | null;
  health_score: number;
  state: string;
  consecutive_failures: number;
  failure_count: number;
  cooldown_until: string | null;
  quarantine_until: string | null;
  account_lock: boolean;
  locked_by_instance: number | null;
  lock_expires_at: string | null;
  instance_id: number | null;
  activated_at: string | null;
  last_active_at: string | null;
  last_rotation_at: string | null;
  auto_rotation: boolean;
  min_use_ms: number | null;
  max_use_ms: number | null;
  auto_time_mode: boolean;
}

export interface RotationStatus {
  instance_id: number;
  in_progress: boolean;
  last_reason: RotationReason | null;
  last_reason_label: string | null;
  last_rotated_at: string | null;
  active_account_id: number | null;
  active_account_nickname: string | null;
  next_eligible_at: string | null;
  cooldown_remaining_ms: number | null;
  failover_active: boolean;
  auto_rotation_enabled: boolean;
}

// ─── Anti-pingpong tracking (in-memory) ───────────────────────────────────────

const recentUsageByInstance = new Map<number, Map<number, number>>();
const ANTI_PINGPONG_WINDOW_MS = 30 * 60 * 1000;

function recordUsage(instanceId: number, accountId: number) {
  if (!recentUsageByInstance.has(instanceId)) {
    recentUsageByInstance.set(instanceId, new Map());
  }
  recentUsageByInstance.get(instanceId)!.set(accountId, Date.now());
}

function wasUsedRecently(instanceId: number, accountId: number): boolean {
  const map = recentUsageByInstance.get(instanceId);
  if (!map) return false;
  const lastUsed = map.get(accountId);
  if (!lastUsed) return false;
  return (Date.now() - lastUsed) < ANTI_PINGPONG_WINDOW_MS;
}

function pruneOldUsage() {
  const cutoff = Date.now() - ANTI_PINGPONG_WINDOW_MS;
  for (const [instId, map] of recentUsageByInstance) {
    for (const [accId, ts] of map) {
      if (ts < cutoff) map.delete(accId);
    }
    if (map.size === 0) recentUsageByInstance.delete(instId);
  }
}

// ─── Rotation Queue (serialized per instance) ─────────────────────────────────

const rotationQueues = new Map<number, Promise<void>>();
const rotationInProgress = new Set<number>();
const failoverActive = new Set<number>();
const lastRotationReason = new Map<number, RotationReason>();
const lastRotatedAt = new Map<number, string>();

function enqueueRotation(instanceId: number, fn: () => Promise<void>): Promise<void> {
  const prev = rotationQueues.get(instanceId) ?? Promise.resolve();
  const next = prev.then(() => fn()).catch((err) => {
    console.error(`[auto-rotator] instanceId=${instanceId} fila de rotação erro:`, err);
  });
  rotationQueues.set(instanceId, next);
  return next;
}

// ─── Health Score (mirrors routes/accounts.ts) ────────────────────────────────

function calcHealthScore(a: {
  state: string;
  consecutive_failures: number;
  failure_count: number;
  last_active_at: string | null;
  cooldown_until: string | null;
  quarantine_until: string | null;
}): number {
  let sessionScore = 100;
  if (["INVALID_TOKEN", "DEAD", "BANNED", "ERROR"].includes(a.state)) sessionScore = 0;
  else if (["REAUTH", "NEEDS_VERIFICATION", "LOGIN_CHALLENGE", "MANUAL_ACTION_REQUIRED"].includes(a.state)) sessionScore = 20;
  else if (a.state === "LIMITED") sessionScore = 40;
  else if (a.state === "COOLING") sessionScore = 60;
  else if (["IDLE", "STANDBY", "WAITING", "RESERVED"].includes(a.state)) sessionScore = 75;

  const consErrPenalty = Math.min(a.consecutive_failures * 12, 100);
  const totalErrPenalty = Math.min(a.failure_count * 2, 50);
  const errorScore = Math.max(0, 100 - consErrPenalty - totalErrPenalty);

  let ageScore = 80;
  if (a.last_active_at) {
    const ageMins = (Date.now() - new Date(a.last_active_at).getTime()) / 60000;
    if (ageMins < 5) ageScore = 100;
    else if (ageMins < 30) ageScore = 90;
    else if (ageMins < 120) ageScore = 75;
    else if (ageMins < 360) ageScore = 55;
    else ageScore = 30;
  }

  let availScore = 100;
  if (a.cooldown_until && new Date(a.cooldown_until) > new Date()) availScore = 30;
  if (a.quarantine_until && new Date(a.quarantine_until) > new Date()) availScore = 0;

  return Math.max(0, Math.min(100, Math.round(
    (sessionScore * 0.40) + (errorScore * 0.25) + (ageScore * 0.20) + (availScore * 0.10)
  )));
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

async function logAccount(accountId: number | null, instanceId: number | null, eventType: string, detail: string) {
  try {
    await query(
      `INSERT INTO account_logs (account_id, instance_id, event_type, detail) VALUES ($1,$2,$3,$4)`,
      [accountId, instanceId, eventType, detail]
    );
  } catch (err) {
    console.error("[auto-rotator] log error:", err);
  }
}

async function logRotationHistory(
  instanceId: number,
  oldAccountId: number | null,
  newAccountId: number | null,
  reason: string,
  result: "success" | "rollback" | "aborted" | "failover",
  detail: string
) {
  try {
    await query(
      `INSERT INTO rotation_history (instance_id, old_account_id, new_account_id, reason, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [instanceId, oldAccountId, newAccountId, reason, result, detail]
    );
  } catch (err) {
    console.error("[auto-rotator] rotation_history error:", err);
  }
}

// ─── Token Validation (Safe Rotation Mode) ────────────────────────────────────

async function validateToken(tokenValue: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const rest = new DiscordRest(tokenValue);
    const res = await rest.request<{ username?: string; global_name?: string; id?: string }>("GET", "/users/@me");
    if (res.data?.id) {
      return { ok: true, username: res.data.global_name ?? res.data.username ?? "?" };
    }
    return { ok: false, error: "Resposta inválida do Discord" };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Falha de validação" };
  }
}

// ─── Select Best Account ──────────────────────────────────────────────────────

async function selectBestAccount(
  instanceId: number,
  minHealth: number,
  excludeAccountId?: number
): Promise<AccountCandidate | null> {
  const now = new Date().toISOString();

  const rows = await query<Record<string, unknown>>(`
    SELECT
      a.id, a.nickname, a.token_value, a.state,
      a.consecutive_failures, a.failure_count,
      a.cooldown_until, a.quarantine_until,
      a.account_lock, a.locked_by_instance, a.lock_expires_at,
      a.instance_id, a.activated_at, a.last_active_at, a.last_rotation_at,
      a.auto_rotation, a.min_use_ms, a.max_use_ms, a.auto_time_mode
    FROM accounts a
    WHERE
      (a.instance_id = $1 OR a.instance_id IS NULL)
      AND a.state NOT IN ('DEAD','BANNED','INVALID_TOKEN','NEEDS_VERIFICATION',
                          'LOGIN_CHALLENGE','MANUAL_ACTION_REQUIRED','ERROR')
      AND (a.cooldown_until IS NULL    OR a.cooldown_until    < $2)
      AND (a.quarantine_until IS NULL  OR a.quarantine_until  < $2)
      AND (
        a.account_lock = FALSE
        OR a.lock_expires_at IS NULL
        OR a.lock_expires_at < $2
        OR a.locked_by_instance = $1
      )
  `, [instanceId, now]);

  const typed: AccountCandidate[] = rows.map(r => ({
    id: Number(r.id),
    nickname: String(r.nickname),
    token_value: r.token_value as string | null,
    state: String(r.state),
    consecutive_failures: Number(r.consecutive_failures ?? 0),
    failure_count: Number(r.failure_count ?? 0),
    cooldown_until: r.cooldown_until as string | null,
    quarantine_until: r.quarantine_until as string | null,
    account_lock: Boolean(r.account_lock),
    locked_by_instance: r.locked_by_instance != null ? Number(r.locked_by_instance) : null,
    lock_expires_at: r.lock_expires_at as string | null,
    instance_id: r.instance_id != null ? Number(r.instance_id) : null,
    activated_at: r.activated_at as string | null,
    last_active_at: r.last_active_at as string | null,
    last_rotation_at: r.last_rotation_at as string | null,
    auto_rotation: Boolean(r.auto_rotation),
    min_use_ms: r.min_use_ms != null ? Number(r.min_use_ms) : null,
    max_use_ms: r.max_use_ms != null ? Number(r.max_use_ms) : null,
    auto_time_mode: Boolean(r.auto_time_mode),
    health_score: 0,
  }));

  for (const a of typed) {
    a.health_score = calcHealthScore(a);
  }

  // Filtra por health mínimo e exclui conta atual
  let eligible = typed.filter(a =>
    a.health_score >= minHealth &&
    a.id !== excludeAccountId &&
    !wasUsedRecently(instanceId, a.id)
  );

  // Anti-pingpong eliminou tudo? Relaxa o filtro de uso recente
  if (eligible.length === 0) {
    eligible = typed.filter(a => a.health_score >= minHealth && a.id !== excludeAccountId);
    if (eligible.length > 0) {
      await logAccount(null, instanceId, "anti_pingpong_applied",
        "Anti-pingpong relaxado: nenhuma conta fora da janela disponível"
      );
    }
  }

  if (eligible.length === 0) return null;

  // Prioridade: exclusivas antes de globais, depois health score
  eligible.sort((a, b) => {
    const aEx = a.instance_id === instanceId ? 1 : 0;
    const bEx = b.instance_id === instanceId ? 1 : 0;
    if (aEx !== bEx) return bEx - aEx;
    return b.health_score - a.health_score;
  });

  return eligible[0] ?? null;
}

// ─── Transactional Rotation ───────────────────────────────────────────────────

async function executeRotation(
  instanceId: number,
  reason: RotationReason,
  oldAccountId: number | null,
  isFailover = false
): Promise<void> {
  if (rotationInProgress.has(instanceId)) {
    console.log(`[auto-rotator] inst=${instanceId} já em andamento, skip`);
    return;
  }

  rotationInProgress.add(instanceId);
  if (isFailover) failoverActive.add(instanceId);

  const cfgRows = await query<{
    min_health_score: number;
    cooldown_after_use_ms: number;
    cooldown_after_fail_ms: number;
    quarantine_ms: number;
  }>(`SELECT min_health_score, cooldown_after_use_ms, cooldown_after_fail_ms, quarantine_ms
      FROM accounts_config WHERE id = 1`);

  const cfg = cfgRows[0] ?? {
    min_health_score: 40,
    cooldown_after_use_ms: 2700000,
    cooldown_after_fail_ms: 1800000,
    quarantine_ms: 3600000,
  };

  await logAccount(oldAccountId, instanceId, "auto_rotation_started",
    `Auto-rotação iniciada. Motivo: ${ROTATION_REASON_LABELS[reason] ?? reason}${isFailover ? " [FAILOVER]" : ""}`
  );

  let candidate: AccountCandidate | null = null;

  try {
    // Passo 1: Seleciona a melhor conta
    candidate = await selectBestAccount(instanceId, cfg.min_health_score, oldAccountId ?? undefined);

    if (!candidate) {
      await logAccount(null, instanceId, "auto_rotation_aborted",
        "Sem conta saudável disponível para rotação"
      );
      await logRotationHistory(instanceId, oldAccountId, null, reason, "aborted", "Sem conta disponível");
      return;
    }

    await logAccount(candidate.id, instanceId, "account_selected",
      `Conta selecionada: ${candidate.nickname} (health ${candidate.health_score}%)`
    );

    // Passo 2: Cria lock temporário na candidata
    const tempLock = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await query(`
      UPDATE accounts SET
        account_lock = TRUE, locked_by_instance = $2,
        locked_at = NOW(), lock_expires_at = $3
      WHERE id = $1
    `, [candidate.id, instanceId, tempLock]);
    await logAccount(candidate.id, instanceId, "lock_created",
      `Lock temporário criado pela instância ${instanceId}`
    );

    // Passo 3: Safe Rotation Mode — valida token (skip em failover para velocidade)
    if (!isFailover && candidate.token_value) {
      const validation = await validateToken(candidate.token_value);

      if (!validation.ok) {
        // Rollback: libera lock, aborta
        await query(`
          UPDATE accounts SET account_lock = FALSE, locked_by_instance = NULL,
            locked_at = NULL, lock_expires_at = NULL WHERE id = $1
        `, [candidate.id]);
        await query(`
          UPDATE accounts SET consecutive_failures = consecutive_failures + 1 WHERE id = $1
        `, [candidate.id]);
        await logAccount(candidate.id, instanceId, "validation_failed",
          `Validação falhou: ${validation.error}. Rotação abortada (rollback).`
        );
        await logRotationHistory(instanceId, oldAccountId, candidate.id, reason, "rollback",
          `Validação falhou: ${validation.error}`
        );
        return;
      }

      await logAccount(candidate.id, instanceId, "validation_approved",
        `Validação aprovada (${validation.username})`
      );
      await logAccount(candidate.id, instanceId, "heartbeat_validated",
        `Heartbeat Discord OK: ${validation.username}`
      );
    }

    // Passo 4: Aplica token da candidata na instância
    if (candidate.token_value) {
      const existing = await query<{ id: number }>(
        `SELECT tp.id FROM token_pool tp
         INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
         WHERE its.instance_id = $1 AND tp.value = $2`,
        [instanceId, candidate.token_value]
      );

      if (existing.length === 0) {
        const poolRows = await query<{ id: number }>(
          `INSERT INTO token_pool (value, label, status) VALUES ($1, $2, 'unknown')
           ON CONFLICT (value) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
          [candidate.token_value, `Conta #${candidate.id}`]
        );
        const tokenId = poolRows[0]!.id;
        const posRows = await query<{ max_pos: number | null }>(
          `SELECT MAX(position) AS max_pos FROM instance_token_selection WHERE instance_id = $1`,
          [instanceId]
        );
        const nextPos = (posRows[0]?.max_pos ?? 0) + 1;
        await query(
          `INSERT INTO instance_token_selection (instance_id, token_pool_id, position)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [instanceId, tokenId, nextPos]
        );
        await query(`UPDATE accounts SET token_pool_id = $1 WHERE id = $2`, [tokenId, candidate.id]);
      }

      await logAccount(candidate.id, instanceId, "token_applied",
        `Token aplicado na instância ${instanceId}`
      );
    }

    // Passo 5: Marca nova conta como ACTIVE com lock definitivo
    const lockExpires = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await query(`
      UPDATE accounts SET
        state = 'ACTIVE',
        activated_at = NOW(),
        last_active_at = NOW(),
        consecutive_failures = 0,
        cooldown_until = NULL,
        account_lock = TRUE,
        locked_by_instance = $2,
        locked_at = NOW(),
        lock_expires_at = $3
      WHERE id = $1
    `, [candidate.id, instanceId, lockExpires]);

    // Passo 6: Libera conta antiga com cooldown inteligente
    if (oldAccountId) {
      const isFailureReason = [
        "rate_limit", "session_dead", "token_invalid", "shadow_limit",
        "consecutive_failures", "heartbeat_failed", "quarantine", "critical_state",
      ].includes(reason);

      const cooldownMs = isFailureReason
        ? cfg.cooldown_after_fail_ms + cfg.cooldown_after_use_ms
        : cfg.cooldown_after_use_ms;
      const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();

      await query(`
        UPDATE accounts SET
          state = 'COOLING',
          rotation_count = rotation_count + 1,
          last_rotation_at = NOW(),
          cooldown_until = $2,
          account_lock = FALSE,
          locked_by_instance = NULL,
          locked_at = NULL,
          lock_expires_at = NULL
        WHERE id = $1
      `, [oldAccountId, cooldownUntil]);

      await logAccount(oldAccountId, instanceId, "cooldown_applied",
        `Cooldown ${Math.round(cooldownMs / 60000)}min aplicado. Motivo: ${ROTATION_REASON_LABELS[reason] ?? reason}`
      );
      await logAccount(oldAccountId, instanceId, "lock_released", "Lock liberado após rotação");
    }

    // Passo 7: Registra anti-pingpong
    if (oldAccountId) recordUsage(instanceId, oldAccountId);
    recordUsage(instanceId, candidate.id);

    // Passo 8: Atualiza estado interno e loga histórico
    lastRotationReason.set(instanceId, reason);
    lastRotatedAt.set(instanceId, new Date().toISOString());
    failoverActive.delete(instanceId);

    const histResult = isFailover ? "failover" : "success";
    await logRotationHistory(instanceId, oldAccountId, candidate.id, reason, histResult,
      `${candidate.nickname} (health ${candidate.health_score}%)${isFailover ? " [FAILOVER]" : ""}`
    );

    if (isFailover) {
      await logAccount(candidate.id, instanceId, "failover_executed",
        `Auto-failover → ${candidate.nickname}`
      );
    }

    console.log(`[auto-rotator] inst=${instanceId} rotação ${isFailover ? "FAILOVER " : ""}OK → ${candidate.nickname}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Rollback: libera lock temporário se foi criado
    if (candidate) {
      await query(`
        UPDATE accounts SET account_lock = FALSE, locked_by_instance = NULL,
          locked_at = NULL, lock_expires_at = NULL WHERE id = $1
      `, [candidate.id]).catch(() => {});
    }

    await logAccount(null, instanceId, "rollback_executed",
      `Rollback executado: ${msg}`
    );
    await logRotationHistory(instanceId, oldAccountId, candidate?.id ?? null, reason, "rollback", msg);
    console.error(`[auto-rotator] inst=${instanceId} rollback:`, err);
  } finally {
    rotationInProgress.delete(instanceId);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function triggerRotation(
  instanceId: number,
  reason: RotationReason,
  oldAccountId?: number
): Promise<void> {
  pruneOldUsage();
  return enqueueRotation(instanceId, () =>
    executeRotation(instanceId, reason, oldAccountId ?? null, false)
  );
}

export async function triggerFailover(
  instanceId: number,
  oldAccountId?: number
): Promise<void> {
  pruneOldUsage();
  // Failover bypassa a fila para velocidade máxima
  return executeRotation(instanceId, "failover", oldAccountId ?? null, true);
}

export function getRotationStatus(instanceId: number): Omit<RotationStatus, "instance_id" | "active_account_id" | "active_account_nickname" | "next_eligible_at" | "cooldown_remaining_ms" | "auto_rotation_enabled"> {
  return {
    in_progress: rotationInProgress.has(instanceId),
    last_reason: lastRotationReason.get(instanceId) ?? null,
    last_reason_label: lastRotationReason.has(instanceId)
      ? (ROTATION_REASON_LABELS[lastRotationReason.get(instanceId)!] ?? null)
      : null,
    last_rotated_at: lastRotatedAt.get(instanceId) ?? null,
    failover_active: failoverActive.has(instanceId),
  };
}

// ─── Periodic Health Monitor ──────────────────────────────────────────────────

let healthCheckTimer: NodeJS.Timeout | null = null;

export function startHealthMonitor(intervalMs = 30_000): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    runHealthCheck().catch(err =>
      console.error("[auto-rotator] health check error:", err)
    );
  }, intervalMs);
  console.log("[auto-rotator] health monitor iniciado");
}

export function stopHealthMonitor(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

async function runHealthCheck(): Promise<void> {
  const cfgRows = await query<{
    auto_rotation: boolean;
    min_health_score: number;
    max_continuous_ms: number;
  }>(`SELECT auto_rotation, min_health_score, max_continuous_ms FROM accounts_config WHERE id = 1`);

  const cfg = cfgRows[0];
  if (!cfg?.auto_rotation) return;

  const activeAccounts = await query<Record<string, unknown>>(`
    SELECT
      a.id, a.nickname, a.state, a.instance_id,
      a.consecutive_failures, a.failure_count,
      a.cooldown_until, a.quarantine_until,
      a.activated_at, a.last_active_at, a.last_rotation_at,
      a.auto_rotation, a.min_use_ms, a.max_use_ms, a.auto_time_mode,
      tp.status AS token_status
    FROM accounts a
    LEFT JOIN token_pool tp ON tp.id = a.token_pool_id
    WHERE a.state = 'ACTIVE' AND a.instance_id IS NOT NULL AND a.auto_rotation = TRUE
  `);

  for (const raw of activeAccounts) {
    const account = {
      id: Number(raw.id),
      nickname: String(raw.nickname),
      state: String(raw.state),
      instance_id: Number(raw.instance_id),
      consecutive_failures: Number(raw.consecutive_failures ?? 0),
      failure_count: Number(raw.failure_count ?? 0),
      cooldown_until: raw.cooldown_until as string | null,
      quarantine_until: raw.quarantine_until as string | null,
      activated_at: raw.activated_at as string | null,
      last_active_at: raw.last_active_at as string | null,
      auto_time_mode: Boolean(raw.auto_time_mode),
      min_use_ms: raw.min_use_ms != null ? Number(raw.min_use_ms) : null,
      max_use_ms: raw.max_use_ms != null ? Number(raw.max_use_ms) : null,
      token_status: raw.token_status as string | null,
    };

    const healthScore = calcHealthScore(account);
    const instanceId = account.instance_id;

    if (rotationInProgress.has(instanceId)) continue;

    let rotationReason: RotationReason | null = null;

    // Gatilho: health abaixo do mínimo
    if (healthScore < cfg.min_health_score) {
      rotationReason = "health_below_minimum";
    }

    // Gatilho: token inválido
    if (!rotationReason && account.token_status === "invalid") {
      rotationReason = "token_invalid";
    }

    // Gatilho: tempo máximo de uso
    if (!rotationReason && account.activated_at) {
      const usedMs = Date.now() - new Date(account.activated_at).getTime();

      if (!account.auto_time_mode) {
        const maxMs = account.max_use_ms ?? cfg.max_continuous_ms;
        if (usedMs > maxMs) rotationReason = "max_continuous_time";
      } else {
        // Modo automático: decisão inteligente por pontuação de risco
        const poolRisk  = healthScore < 60 ? 1 : 0;
        const timeRisk  = usedMs > cfg.max_continuous_ms * 0.8 ? 1 : 0;
        const errorRisk = account.consecutive_failures > 2 ? 1 : 0;
        if (poolRisk + timeRisk + errorRisk >= 2) {
          rotationReason = "max_continuous_time";
        }
      }
    }

    // Gatilho: falhas consecutivas
    if (!rotationReason && account.consecutive_failures >= 5) {
      rotationReason = "consecutive_failures";
    }

    if (rotationReason) {
      console.log(`[auto-rotator] inst=${instanceId} trigger: ${rotationReason}`);
      triggerRotation(instanceId, rotationReason, account.id).catch(err =>
        console.error("[auto-rotator] trigger error:", err)
      );
    }
  }
}
