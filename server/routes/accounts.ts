import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const accountsRouter = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

export type AccountState =
  | "ACTIVE" | "IDLE" | "STANDBY" | "COOLING" | "RESERVED" | "WAITING"
  | "REAUTH" | "INVALID_TOKEN" | "NEEDS_VERIFICATION" | "LOGIN_CHALLENGE"
  | "MANUAL_ACTION_REQUIRED" | "LIMITED" | "ERROR" | "DEAD" | "BANNED";

export type RotationStrategy = "sequential" | "random" | "weighted_health" | "least_recently_used";

// ─── Health Score Calculator ───────────────────────────────────────────────────

function calcHealthScore(account: {
  state: AccountState;
  consecutive_failures: number;
  failure_count: number;
  rotation_count: number;
  activated_at: string | null;
  last_active_at: string | null;
  token_status: string | null;
  cooldown_until: string | null;
  quarantine_until: string | null;
}): number {
  const now = Date.now();

  // Session stability (40%)
  let sessionScore = 100;
  if (["INVALID_TOKEN", "DEAD", "BANNED", "ERROR"].includes(account.state)) sessionScore = 0;
  else if (["REAUTH", "NEEDS_VERIFICATION", "LOGIN_CHALLENGE", "MANUAL_ACTION_REQUIRED"].includes(account.state)) sessionScore = 20;
  else if (["LIMITED"].includes(account.state)) sessionScore = 40;
  else if (["COOLING"].includes(account.state)) sessionScore = 60;
  else if (["IDLE", "STANDBY", "WAITING", "RESERVED"].includes(account.state)) sessionScore = 75;
  // ACTIVE stays at 100

  // Absence of errors (25%)
  const consErrPenalty = Math.min(account.consecutive_failures * 12, 100);
  const totalErrPenalty = Math.min(account.failure_count * 2, 50);
  const errorScore = Math.max(0, 100 - consErrPenalty - totalErrPenalty);

  // Session age health (20%) — fresh sessions score better, very old sessions score lower
  let ageScore = 80;
  if (account.last_active_at) {
    const ageMins = (now - new Date(account.last_active_at).getTime()) / 60000;
    if (ageMins < 5) ageScore = 100;
    else if (ageMins < 30) ageScore = 90;
    else if (ageMins < 120) ageScore = 75;
    else if (ageMins < 360) ageScore = 55;
    else ageScore = 30;
  }

  // Availability (10%)
  let availScore = 100;
  if (account.cooldown_until && new Date(account.cooldown_until) > new Date()) availScore = 30;
  if (account.quarantine_until && new Date(account.quarantine_until) > new Date()) availScore = 0;

  // Token status (5%)
  let tokenScore = 50;
  if (account.token_status === "connected") tokenScore = 100;
  else if (account.token_status === "rate_limited") tokenScore = 30;
  else if (account.token_status === "invalid") tokenScore = 0;
  else if (account.token_status === "disconnected") tokenScore = 10;

  const score = Math.round(
    (sessionScore * 0.40) +
    (errorScore  * 0.25) +
    (ageScore    * 0.20) +
    (availScore  * 0.10) +
    (tokenScore  * 0.05)
  );

  return Math.max(0, Math.min(100, score));
}

function calcTier(score: number): string {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

// ─── Pool por Instância ───────────────────────────────────────────────────────

const UNAVAILABLE_STATES: string[] = [
  "DEAD", "BANNED", "INVALID_TOKEN",
  "NEEDS_VERIFICATION", "LOGIN_CHALLENGE", "MANUAL_ACTION_REQUIRED",
];

accountsRouter.get("/pool-by-instance", asyncHandler(async (_req, res) => {
  const now = new Date();

  // Score mínimo configurado
  const cfgRows = await query<{ min_health_score: number }>(
    `SELECT min_health_score FROM accounts_config WHERE id = 1`,
  );
  const minHealth = Number(cfgRows[0]?.min_health_score ?? 40);

  // Todas as instâncias
  const instances = await query<{ id: number; name: string }>(
    `SELECT id, name FROM instances ORDER BY id ASC`,
  );

  // Todas as contas com dados de lock e token
  const rows = await query<Record<string, unknown>>(`
    SELECT
      a.id, a.nickname, a.email, a.state,
      a.instance_id,
      a.consecutive_failures, a.failure_count, a.rotation_count,
      a.activated_at, a.last_active_at, a.cooldown_until, a.quarantine_until,
      a.account_lock, a.locked_by_instance, a.lock_expires_at,
      tp.status   AS token_status,
      li.name     AS locked_by_instance_name
    FROM accounts a
    LEFT JOIN token_pool tp ON tp.id  = a.token_pool_id
    LEFT JOIN instances  li ON li.id  = a.locked_by_instance
    ORDER BY a.id ASC
  `);

  // Calcula health para cada conta
  type RawAccount = {
    id: number; nickname: string; email: string | null; state: string;
    instance_id: number | null;
    consecutive_failures: number; failure_count: number; rotation_count: number;
    activated_at: string | null; last_active_at: string | null;
    token_status: string | null; cooldown_until: string | null; quarantine_until: string | null;
    account_lock: boolean; locked_by_instance: number | null; lock_expires_at: string | null;
    locked_by_instance_name: string | null;
    health_score: number; tier: string;
  };

  const allAccounts: RawAccount[] = rows.map(r => {
    const score = calcHealthScore({
      state: r.state as AccountState,
      consecutive_failures: Number(r.consecutive_failures ?? 0),
      failure_count: Number(r.failure_count ?? 0),
      rotation_count: Number(r.rotation_count ?? 0),
      activated_at: r.activated_at as string | null,
      last_active_at: r.last_active_at as string | null,
      token_status: r.token_status as string | null,
      cooldown_until: r.cooldown_until as string | null,
      quarantine_until: r.quarantine_until as string | null,
    });
    return {
      id: Number(r.id),
      nickname: String(r.nickname),
      email: r.email as string | null,
      state: String(r.state),
      instance_id: r.instance_id != null ? Number(r.instance_id) : null,
      consecutive_failures: Number(r.consecutive_failures ?? 0),
      failure_count: Number(r.failure_count ?? 0),
      rotation_count: Number(r.rotation_count ?? 0),
      activated_at: r.activated_at as string | null,
      last_active_at: r.last_active_at as string | null,
      token_status: r.token_status as string | null,
      cooldown_until: r.cooldown_until as string | null,
      quarantine_until: r.quarantine_until as string | null,
      account_lock: Boolean(r.account_lock),
      locked_by_instance: r.locked_by_instance != null ? Number(r.locked_by_instance) : null,
      lock_expires_at: r.lock_expires_at as string | null,
      locked_by_instance_name: r.locked_by_instance_name as string | null,
      health_score: score,
      tier: calcTier(score),
    };
  });

  // Para cada instância, monta o pool
  const result = instances.map(inst => {
    // Contas do pool desta instância = exclusivas OU globais
    const poolAccounts = allAccounts.filter(a =>
      a.instance_id === inst.id || a.instance_id === null,
    );

    type DetailedAccount = RawAccount & {
      is_exclusive: boolean;
      is_global: boolean;
      is_available: boolean;
      unavailable_reasons: string[];
      is_active: boolean;
      in_cooldown: boolean;
      in_quarantine: boolean;
      locked_by_other: boolean;
    };

    const detailed: DetailedAccount[] = poolAccounts.map(a => {
      const reasons: string[] = [];

      const lockedByOther = a.account_lock
        && a.lock_expires_at != null
        && new Date(a.lock_expires_at) > now
        && a.locked_by_instance != null
        && a.locked_by_instance !== inst.id;

      const inCooldown = !!a.cooldown_until && new Date(a.cooldown_until) > now;
      const inQuarantine = !!a.quarantine_until && new Date(a.quarantine_until) > now;
      const badState = UNAVAILABLE_STATES.includes(a.state);
      const lowHealth = a.health_score < minHealth;

      if (lockedByOther) {
        reasons.push(`Bloqueada por ${a.locked_by_instance_name ?? "outra instância"}`);
      }
      if (inCooldown) {
        reasons.push(`Cooldown até ${new Date(a.cooldown_until!).toLocaleTimeString("pt-BR")}`);
      }
      if (inQuarantine) {
        reasons.push(`Quarentena até ${new Date(a.quarantine_until!).toLocaleTimeString("pt-BR")}`);
      }
      if (badState) {
        reasons.push(`Estado: ${a.state}`);
      }
      if (lowHealth && !badState) {
        reasons.push(`Health baixo (${a.health_score}%)`);
      }

      return {
        ...a,
        is_exclusive: a.instance_id === inst.id,
        is_global: a.instance_id === null,
        is_available: reasons.length === 0,
        unavailable_reasons: reasons,
        is_active: a.state === "ACTIVE",
        in_cooldown: inCooldown,
        in_quarantine: inQuarantine,
        locked_by_other: !!lockedByOther,
      };
    });

    const available = detailed.filter(a => a.is_available);
    const sorted = [...available].sort((a, b) => b.health_score - a.health_score);
    const best = sorted[0] ?? null;

    const avgHealth = detailed.length > 0
      ? Math.round(detailed.reduce((s, a) => s + a.health_score, 0) / detailed.length)
      : 0;

    // Resumo de motivos de indisponibilidade
    const unavailReasons: Record<string, number> = {};
    detailed.filter(a => !a.is_available).forEach(a => {
      a.unavailable_reasons.forEach(r => {
        const key = r.startsWith("Bloqueada") ? "Bloqueadas por outra instância"
          : r.startsWith("Cooldown") ? "Em cooldown"
          : r.startsWith("Quarentena") ? "Em quarentena"
          : r.startsWith("Estado") ? "Estado inválido"
          : "Health baixo";
        unavailReasons[key] = (unavailReasons[key] ?? 0) + 1;
      });
    });

    return {
      instance_id: inst.id,
      instance_name: inst.name,
      exclusive_accounts_count: detailed.filter(a => a.is_exclusive).length,
      global_available_count: detailed.filter(a => a.is_global && a.is_available).length,
      active_count: detailed.filter(a => a.is_active).length,
      cooldown_count: detailed.filter(a => a.in_cooldown).length,
      quarantine_count: detailed.filter(a => a.in_quarantine).length,
      locked_by_other_count: detailed.filter(a => a.locked_by_other).length,
      usable_count: available.length,
      average_health: avgHealth,
      best_available_account: best
        ? { id: best.id, nickname: best.nickname, health_score: best.health_score, tier: best.tier }
        : null,
      unavailable_reasons_summary: unavailReasons,
      accounts: detailed.map(a => ({
        id: a.id,
        nickname: a.nickname,
        email: a.email,
        state: a.state,
        health_score: a.health_score,
        tier: a.tier,
        is_exclusive: a.is_exclusive,
        is_global: a.is_global,
        is_available: a.is_available,
        unavailable_reasons: a.unavailable_reasons,
        is_active: a.is_active,
        in_cooldown: a.in_cooldown,
        in_quarantine: a.in_quarantine,
        locked_by_other: a.locked_by_other,
        locked_by_instance_name: a.locked_by_instance_name,
      })),
    };
  });

  res.json(result);
}));

// ─── Config ──────────────────────────────────────────────────────────────────

accountsRouter.get("/config", asyncHandler(async (_req, res) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM accounts_config WHERE id = 1`
  );
  res.json(rows[0] ?? {});
}));

accountsRouter.put("/config", asyncHandler(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  await query(`
    INSERT INTO accounts_config (
      id, max_active, min_health_score, max_continuous_ms, min_use_ms, max_use_ms,
      auto_time_mode, cooldown_after_use_ms, cooldown_after_fail_ms, quarantine_ms,
      health_check_interval_ms, session_validation_interval_ms,
      token_validation_interval_ms, reauth_preventive_ms,
      auto_rotation, auto_refresh, auto_relogin, rotation_strategy
    ) VALUES (
      1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )
    ON CONFLICT (id) DO UPDATE SET
      max_active                    = EXCLUDED.max_active,
      min_health_score              = EXCLUDED.min_health_score,
      max_continuous_ms             = EXCLUDED.max_continuous_ms,
      min_use_ms                    = EXCLUDED.min_use_ms,
      max_use_ms                    = EXCLUDED.max_use_ms,
      auto_time_mode                = EXCLUDED.auto_time_mode,
      cooldown_after_use_ms         = EXCLUDED.cooldown_after_use_ms,
      cooldown_after_fail_ms        = EXCLUDED.cooldown_after_fail_ms,
      quarantine_ms                 = EXCLUDED.quarantine_ms,
      health_check_interval_ms      = EXCLUDED.health_check_interval_ms,
      session_validation_interval_ms= EXCLUDED.session_validation_interval_ms,
      token_validation_interval_ms  = EXCLUDED.token_validation_interval_ms,
      reauth_preventive_ms          = EXCLUDED.reauth_preventive_ms,
      auto_rotation                 = EXCLUDED.auto_rotation,
      auto_refresh                  = EXCLUDED.auto_refresh,
      auto_relogin                  = EXCLUDED.auto_relogin,
      rotation_strategy             = EXCLUDED.rotation_strategy
  `, [
    b.max_active ?? 10,
    b.min_health_score ?? 40,
    b.max_continuous_ms ?? 7200000,
    b.min_use_ms ?? null,
    b.max_use_ms ?? null,
    b.auto_time_mode ?? true,
    b.cooldown_after_use_ms ?? 2700000,
    b.cooldown_after_fail_ms ?? 1800000,
    b.quarantine_ms ?? 3600000,
    b.health_check_interval_ms ?? 30000,
    b.session_validation_interval_ms ?? 120000,
    b.token_validation_interval_ms ?? 300000,
    b.reauth_preventive_ms ?? 21600000,
    b.auto_rotation ?? true,
    b.auto_refresh ?? true,
    b.auto_relogin ?? false,
    b.rotation_strategy ?? "weighted_health",
  ]);
  res.json({ ok: true });
}));

// ─── Accounts CRUD ────────────────────────────────────────────────────────────

accountsRouter.get("/", asyncHandler(async (_req, res) => {
  const now = new Date();
  // Auto-libera locks expirados
  await query(`
    UPDATE accounts SET account_lock = FALSE, locked_by_instance = NULL, locked_at = NULL, lock_expires_at = NULL
    WHERE account_lock = TRUE AND lock_expires_at IS NOT NULL AND lock_expires_at < $1
  `, [now.toISOString()]);

  const rows = await query<Record<string, unknown>>(`
    SELECT
      a.*,
      tp.status   AS token_status,
      tp.username AS token_username,
      i.name      AS instance_name,
      li.name     AS locked_by_instance_name
    FROM accounts a
    LEFT JOIN token_pool tp ON tp.id  = a.token_pool_id
    LEFT JOIN instances  i  ON i.id   = a.instance_id
    LEFT JOIN instances  li ON li.id  = a.locked_by_instance
    ORDER BY a.id ASC
  `);

  const accounts = rows.map((r) => {
    const score = calcHealthScore({
      state: r.state as AccountState,
      consecutive_failures: Number(r.consecutive_failures ?? 0),
      failure_count: Number(r.failure_count ?? 0),
      rotation_count: Number(r.rotation_count ?? 0),
      activated_at: r.activated_at as string | null,
      last_active_at: r.last_active_at as string | null,
      token_status: r.token_status as string | null,
      cooldown_until: r.cooldown_until as string | null,
      quarantine_until: r.quarantine_until as string | null,
    });
    const tokenPreview = r.token_value
      ? String(r.token_value).length <= 12
        ? String(r.token_value)
        : `${String(r.token_value).slice(0, 6)}…${String(r.token_value).slice(-4)}`
      : null;
    return {
      ...r,
      health_score: score,
      tier: calcTier(score),
      password: undefined,
      token_value: undefined,
      token_value_preview: tokenPreview,
      has_token: !!r.token_value,
    };
  });

  res.json(accounts);
}));

accountsRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body as {
    nickname?: string; email?: string; password?: string; token_value?: string;
    token_pool_id?: number | null; instance_id?: number | null;
    auto_rotation?: boolean; auto_refresh?: boolean; auto_relogin?: boolean;
    min_use_ms?: number | null; max_use_ms?: number | null; auto_time_mode?: boolean;
    notes?: string;
  };

  if (!b.nickname?.trim()) {
    return res.status(400).json({ error: "Nome/Nickname é obrigatório." });
  }

  const rows = await query<{ id: number }>(`
    INSERT INTO accounts (
      nickname, email, password, token_value, token_pool_id, instance_id,
      state, auto_rotation, auto_refresh, auto_relogin,
      min_use_ms, max_use_ms, auto_time_mode, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,'STANDBY',$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
  `, [
    b.nickname.trim(),
    b.email?.trim() || null,
    b.password?.trim() || null,
    b.token_value?.trim() || null,
    b.token_pool_id || null,
    b.instance_id || null,
    b.auto_rotation ?? true,
    b.auto_refresh ?? true,
    b.auto_relogin ?? false,
    b.min_use_ms || null,
    b.max_use_ms || null,
    b.auto_time_mode ?? true,
    b.notes?.trim() || null,
  ]);

  await query(`
    INSERT INTO account_logs (account_id, event_type, detail)
    VALUES ($1, 'created', 'Conta criada')
  `, [rows[0]!.id]);

  res.json({ ok: true, id: rows[0]!.id });
}));

accountsRouter.put("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;

  const current = await query<{ id: number; instance_id: number | null }>(`SELECT id, instance_id FROM accounts WHERE id = $1`, [id]);
  if (!current[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`
    UPDATE accounts SET
      nickname       = COALESCE($1, nickname),
      email          = $2,
      password       = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE password END,
      token_value    = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE token_value END,
      token_pool_id  = $5,
      instance_id    = $6,
      auto_rotation  = COALESCE($7, auto_rotation),
      auto_refresh   = COALESCE($8, auto_refresh),
      auto_relogin   = COALESCE($9, auto_relogin),
      min_use_ms     = $10,
      max_use_ms     = $11,
      auto_time_mode = COALESCE($12, auto_time_mode),
      notes          = $13
    WHERE id = $14
  `, [
    b.nickname ?? null,
    b.email ?? null,
    b.password ?? null,
    b.token_value ?? null,
    b.token_pool_id ?? null,
    b.instance_id ?? null,
    b.auto_rotation ?? null,
    b.auto_refresh ?? null,
    b.auto_relogin ?? null,
    b.min_use_ms ?? null,
    b.max_use_ms ?? null,
    b.auto_time_mode ?? null,
    b.notes ?? null,
    id,
  ]);

  const prevInstId = current[0].instance_id;
  const newInstId = b.instance_id != null ? Number(b.instance_id) || null : prevInstId;
  const logDetail = newInstId
    ? `Conta vinculada à instância ${newInstId}`
    : "Conta definida como global (sem instância vinculada)";

  if ((b.instance_id !== undefined) && (newInstId !== prevInstId)) {
    await query(`
      INSERT INTO account_logs (account_id, instance_id, event_type, detail)
      VALUES ($1, $2, 'instance_link', $3)
    `, [id, newInstId, logDetail]);
  }

  res.json({ ok: true });
}));

accountsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM accounts WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// ─── State management ─────────────────────────────────────────────────────────

accountsRouter.post("/:id/state", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { state, reason } = req.body as { state: AccountState; reason?: string };

  const valid: AccountState[] = [
    "ACTIVE","IDLE","STANDBY","COOLING","RESERVED","WAITING","REAUTH",
    "INVALID_TOKEN","NEEDS_VERIFICATION","LOGIN_CHALLENGE",
    "MANUAL_ACTION_REQUIRED","LIMITED","ERROR","DEAD","BANNED",
  ];
  if (!valid.includes(state)) {
    return res.status(400).json({ error: "Estado inválido." });
  }

  const rows = await query<{ state: string; instance_id: number | null }>(`
    SELECT state, instance_id FROM accounts WHERE id = $1
  `, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`UPDATE accounts SET state = $1 WHERE id = $2`, [state, id]);

  const prevState = rows[0].state;
  const detail = reason ? `${prevState} → ${state}: ${reason}` : `${prevState} → ${state}`;
  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'state_change', $3)
  `, [id, rows[0].instance_id, detail]);

  res.json({ ok: true });
}));

// ─── Manual rotation trigger ──────────────────────────────────────────────────

accountsRouter.post("/:id/rotate", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const rows = await query<{
    state: string; instance_id: number | null; consecutive_failures: number;
  }>(`SELECT state, instance_id, consecutive_failures FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  // Mark as COOLING, record rotation
  const now = new Date();
  const configRows = await query<{ cooldown_after_use_ms: number }>(`SELECT cooldown_after_use_ms FROM accounts_config WHERE id = 1`);
  const cooldownMs = configRows[0]?.cooldown_after_use_ms ?? 2700000;
  const cooldownUntil = new Date(now.getTime() + cooldownMs);

  await query(`
    UPDATE accounts SET
      state           = 'COOLING',
      rotation_count  = rotation_count + 1,
      last_rotation_at = NOW(),
      cooldown_until  = $1
    WHERE id = $2
  `, [cooldownUntil.toISOString(), id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'rotation', 'Rotação manual executada')
  `, [id, rows[0].instance_id]);

  res.json({ ok: true });
}));

// ─── Failure recording ────────────────────────────────────────────────────────

accountsRouter.post("/:id/failure", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { reason, critical } = req.body as { reason?: string; critical?: boolean };

  const rows = await query<{ instance_id: number | null; consecutive_failures: number }>(`
    SELECT instance_id, consecutive_failures FROM accounts WHERE id = $1
  `, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  const configRows = await query<{ cooldown_after_fail_ms: number; quarantine_ms: number }>(`
    SELECT cooldown_after_fail_ms, quarantine_ms FROM accounts_config WHERE id = 1
  `);
  const failCooldown = configRows[0]?.cooldown_after_fail_ms ?? 1800000;
  const quarantineMs = configRows[0]?.quarantine_ms ?? 3600000;

  const consFailures = (rows[0].consecutive_failures ?? 0) + 1;
  let newState: AccountState = "ERROR";
  let quarantineUntil: string | null = null;

  if (critical) {
    newState = "DEAD";
  } else if (consFailures >= 5) {
    newState = "ERROR";
    quarantineUntil = new Date(Date.now() + quarantineMs).toISOString();
  }

  const cooldownUntil = new Date(Date.now() + failCooldown).toISOString();

  await query(`
    UPDATE accounts SET
      state                = $1,
      failure_count        = failure_count + 1,
      consecutive_failures = $2,
      cooldown_until       = $3,
      quarantine_until     = $4
    WHERE id = $5
  `, [newState, consFailures, cooldownUntil, quarantineUntil, id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'failure', $3)
  `, [id, rows[0].instance_id, reason || `Falha consecutiva #${consFailures}`]);

  res.json({ ok: true });
}));

// ─── Activate account ─────────────────────────────────────────────────────────

accountsRouter.post("/:id/activate", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { target_instance_id } = req.body as { target_instance_id?: number };

  const rows = await query<{
    instance_id: number | null;
    token_value: string | null;
    cooldown_until: string | null;
    quarantine_until: string | null;
    account_lock: boolean;
    locked_by_instance: number | null;
    lock_expires_at: string | null;
  }>(`
    SELECT instance_id, token_value, cooldown_until, quarantine_until,
           account_lock, locked_by_instance, lock_expires_at
    FROM accounts WHERE id = $1
  `, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  const now = new Date();

  if (rows[0].quarantine_until && new Date(rows[0].quarantine_until) > now) {
    return res.status(400).json({ error: "Conta em quarentena." });
  }

  // Verifica lock ativo
  if (rows[0].account_lock && rows[0].lock_expires_at && new Date(rows[0].lock_expires_at) > now) {
    const lockedBy = rows[0].locked_by_instance;
    const reqInstance = target_instance_id ?? rows[0].instance_id;
    if (lockedBy && lockedBy !== reqInstance) {
      return res.status(409).json({ error: `Conta em uso pela instância ${lockedBy}.` });
    }
  }

  // Determina qual instância usará a conta
  const instanceId = rows[0].instance_id ?? target_instance_id ?? null;

  // Se a conta tem token próprio e está vinculada a uma instância, registra no pool da instância
  if (rows[0].token_value && instanceId) {
    const existing = await query<{ id: number }>(
      `SELECT tp.id FROM token_pool tp
       INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
       WHERE its.instance_id = $1 AND tp.value = $2`,
      [instanceId, rows[0].token_value]
    );

    if (existing.length === 0) {
      // Insere no pool global (sem ON CONFLICT para permitir duplicatas conceituais)
      const poolRows = await query<{ id: number }>(
        `INSERT INTO token_pool (value, label, status)
         VALUES ($1, $2, 'unknown')
         ON CONFLICT (value) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [rows[0].token_value, `Conta #${id}`]
      );
      const tokenId = poolRows[0]!.id;
      const posRows = await query<{ max_pos: number | null }>(
        `SELECT MAX(position) AS max_pos FROM instance_token_selection WHERE instance_id = $1`,
        [instanceId]
      );
      const nextPos = (posRows[0]?.max_pos ?? 0) + 1;
      await query(
        `INSERT INTO instance_token_selection (instance_id, token_pool_id, position)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [instanceId, tokenId, nextPos]
      );
      await query(`UPDATE accounts SET token_pool_id = $1 WHERE id = $2`, [tokenId, id]);
      await query(`
        INSERT INTO account_logs (account_id, instance_id, event_type, detail)
        VALUES ($1, $2, 'token_applied', $3)
      `, [id, instanceId, `Token aplicado na instância ${instanceId}`]);
    }
  }

  // Aplica lock por 2 horas
  const lockExpires = new Date(now.getTime() + 2 * 3600 * 1000);
  await query(`
    UPDATE accounts SET
      state                = 'ACTIVE',
      activated_at         = NOW(),
      last_active_at       = NOW(),
      consecutive_failures = 0,
      cooldown_until       = NULL,
      account_lock         = TRUE,
      locked_by_instance   = $2,
      locked_at            = NOW(),
      lock_expires_at      = $3
    WHERE id = $1
  `, [id, instanceId, lockExpires.toISOString()]);

  const detail = instanceId
    ? `Conta ativada e bloqueada pela instância ${instanceId}`
    : "Conta ativada (sem instância vinculada)";
  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'activated', $3)
  `, [id, instanceId, detail]);

  res.json({ ok: true });
}));

// ─── Lock / Unlock ────────────────────────────────────────────────────────────

accountsRouter.post("/:id/lock", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { instance_id, duration_ms } = req.body as { instance_id?: number; duration_ms?: number };

  const rows = await query<{ instance_id: number | null }>(`SELECT instance_id FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  const lockMs = duration_ms ?? 2 * 3600 * 1000;
  const lockExpires = new Date(Date.now() + lockMs);
  const instId = instance_id ?? rows[0].instance_id;

  await query(`
    UPDATE accounts SET
      account_lock       = TRUE,
      locked_by_instance = $2,
      locked_at          = NOW(),
      lock_expires_at    = $3
    WHERE id = $1
  `, [id, instId, lockExpires.toISOString()]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'lock_acquired', $3)
  `, [id, instId, `Lock adquirido pela instância ${instId}, expira em ${lockExpires.toISOString()}`]);

  res.json({ ok: true });
}));

accountsRouter.post("/:id/unlock", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const rows = await query<{ instance_id: number | null; locked_by_instance: number | null }>(`
    SELECT instance_id, locked_by_instance FROM accounts WHERE id = $1
  `, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`
    UPDATE accounts SET
      account_lock       = FALSE,
      locked_by_instance = NULL,
      locked_at          = NULL,
      lock_expires_at    = NULL
    WHERE id = $1
  `, [id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'lock_released', 'Lock liberado manualmente')
  `, [id, rows[0].locked_by_instance ?? rows[0].instance_id]);

  res.json({ ok: true });
}));

// ─── Deactivate / Reset ───────────────────────────────────────────────────────

accountsRouter.post("/:id/deactivate", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const rows = await query<{ instance_id: number | null }>(`SELECT instance_id FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`
    UPDATE accounts SET state = 'STANDBY', consecutive_failures = 0 WHERE id = $1
  `, [id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'deactivated', 'Conta desativada manualmente')
  `, [id, rows[0].instance_id]);

  res.json({ ok: true });
}));

accountsRouter.post("/:id/reset", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const rows = await query<{ instance_id: number | null }>(`SELECT instance_id FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`
    UPDATE accounts SET
      state                = 'STANDBY',
      consecutive_failures = 0,
      failure_count        = 0,
      cooldown_until       = NULL,
      quarantine_until     = NULL
    WHERE id = $1
  `, [id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'reset', 'Contadores e estado resetados')
  `, [id, rows[0].instance_id]);

  res.json({ ok: true });
}));

// ─── Auto-Rotation Status ─────────────────────────────────────────────────────

accountsRouter.get("/rotation-status", asyncHandler(async (_req, res) => {
  const { getRotationStatus, ROTATION_REASON_LABELS } = await import("../engine/auto-rotator.js");

  const instances = await query<{ id: number; name: string }>(
    `SELECT id, name FROM instances ORDER BY id ASC`
  );
  const cfgRow = await query<{ auto_rotation: boolean; min_health_score: number; cooldown_after_use_ms: number }>(
    `SELECT auto_rotation, min_health_score, cooldown_after_use_ms FROM accounts_config WHERE id = 1`
  );
  const cfg = cfgRow[0];

  const result = await Promise.all(instances.map(async (inst) => {
    const mem = getRotationStatus(inst.id);

    const activeRows = await query<{
      id: number; nickname: string; activated_at: string | null;
      cooldown_until: string | null; auto_rotation: boolean;
    }>(
      `SELECT id, nickname, activated_at, cooldown_until, auto_rotation
       FROM accounts WHERE state = 'ACTIVE' AND locked_by_instance = $1 LIMIT 1`,
      [inst.id]
    );
    const active = activeRows[0] ?? null;

    // Calcula next_eligible e cooldown_remaining
    let nextEligibleAt: string | null = null;
    let cooldownRemainingMs: number | null = null;
    if (active?.cooldown_until) {
      const until = new Date(active.cooldown_until);
      if (until > new Date()) {
        nextEligibleAt = until.toISOString();
        cooldownRemainingMs = until.getTime() - Date.now();
      }
    }

    // Pega a última rotação do DB também (para sobreviver a reinicializações)
    const lastRotRows = await query<{ reason: string; result: string; rotated_at: string }>(
      `SELECT reason, result, rotated_at FROM rotation_history
       WHERE instance_id = $1 ORDER BY rotated_at DESC LIMIT 1`,
      [inst.id]
    );
    const lastRotDb = lastRotRows[0] ?? null;

    const lastReason = (mem.last_reason ?? lastRotDb?.reason ?? null) as string | null;
    const lastRotatedAt = mem.last_rotated_at ?? lastRotDb?.rotated_at ?? null;

    return {
      instance_id: inst.id,
      instance_name: inst.name,
      in_progress: mem.in_progress,
      last_reason: lastReason,
      last_reason_label: lastReason
        ? (ROTATION_REASON_LABELS[lastReason as keyof typeof ROTATION_REASON_LABELS] ?? lastReason)
        : null,
      last_rotated_at: lastRotatedAt,
      active_account_id: active?.id ?? null,
      active_account_nickname: active?.nickname ?? null,
      next_eligible_at: nextEligibleAt,
      cooldown_remaining_ms: cooldownRemainingMs,
      failover_active: mem.failover_active,
      auto_rotation_enabled: cfg?.auto_rotation ?? false,
      active_account_auto_rotation: active?.auto_rotation ?? false,
    };
  }));

  res.json(result);
}));

// ─── Rotation History ─────────────────────────────────────────────────────────

accountsRouter.get("/rotation-history", asyncHandler(async (req, res) => {
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  let sql = `
    SELECT
      rh.id, rh.instance_id, rh.reason, rh.result, rh.detail, rh.rotated_at,
      oa.nickname AS old_account_name,
      na.nickname AS new_account_name,
      i.name      AS instance_name
    FROM rotation_history rh
    LEFT JOIN accounts  oa ON oa.id = rh.old_account_id
    LEFT JOIN accounts  na ON na.id = rh.new_account_id
    LEFT JOIN instances i  ON i.id  = rh.instance_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (instanceId) { params.push(instanceId); sql += ` AND rh.instance_id = $${params.length}`; }
  params.push(limit);
  sql += ` ORDER BY rh.rotated_at DESC LIMIT $${params.length}`;

  const rows = await query<Record<string, unknown>>(sql, params);
  res.json(rows);
}));

// ─── Manual Rotation Trigger ──────────────────────────────────────────────────

accountsRouter.post("/rotation-trigger/:instanceId", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const { triggerRotation } = await import("../engine/auto-rotator.js");

  const activeRows = await query<{ id: number }>(
    `SELECT id FROM accounts WHERE state = 'ACTIVE' AND locked_by_instance = $1 LIMIT 1`,
    [instanceId]
  );
  const oldAccountId = activeRows[0]?.id ?? undefined;

  triggerRotation(instanceId, "manual", oldAccountId).catch(err =>
    console.error("[rotation-trigger]", err)
  );

  res.json({ ok: true, queued: true });
}));

// ─── Logs ─────────────────────────────────────────────────────────────────────

accountsRouter.get("/logs", asyncHandler(async (req, res) => {
  const accountId = req.query.account_id ? Number(req.query.account_id) : null;
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
  const eventType = req.query.event_type as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);

  let sql = `
    SELECT al.*, a.nickname AS account_name, i.name AS instance_name
    FROM account_logs al
    LEFT JOIN accounts  a ON a.id = al.account_id
    LEFT JOIN instances i ON i.id = al.instance_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (accountId) { params.push(accountId); sql += ` AND al.account_id = $${params.length}`; }
  if (instanceId) { params.push(instanceId); sql += ` AND al.instance_id = $${params.length}`; }
  if (eventType) { params.push(eventType); sql += ` AND al.event_type = $${params.length}`; }

  params.push(limit);
  sql += ` ORDER BY al.ts DESC LIMIT $${params.length}`;

  const rows = await query<Record<string, unknown>>(sql, params);
  res.json(rows);
}));
