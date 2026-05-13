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
  const rows = await query<Record<string, unknown>>(`
    SELECT
      a.*,
      tp.status  AS token_status,
      tp.username AS token_username,
      i.name     AS instance_name
    FROM accounts a
    LEFT JOIN token_pool tp ON tp.id = a.token_pool_id
    LEFT JOIN instances  i  ON i.id  = a.instance_id
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
    return {
      ...r,
      health_score: score,
      tier: calcTier(score),
      password: undefined,
    };
  });

  res.json(accounts);
}));

accountsRouter.post("/", asyncHandler(async (req, res) => {
  const b = req.body as {
    nickname?: string; email?: string; password?: string;
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
      nickname, email, password, token_pool_id, instance_id,
      state, auto_rotation, auto_refresh, auto_relogin,
      min_use_ms, max_use_ms, auto_time_mode, notes
    ) VALUES ($1,$2,$3,$4,$5,'STANDBY',$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    b.nickname.trim(),
    b.email?.trim() || null,
    b.password?.trim() || null,
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

  const current = await query<{ id: number }>(`SELECT id FROM accounts WHERE id = $1`, [id]);
  if (!current[0]) return res.status(404).json({ error: "Conta não encontrada." });

  await query(`
    UPDATE accounts SET
      nickname       = COALESCE($1, nickname),
      email          = $2,
      password       = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE password END,
      token_pool_id  = $4,
      instance_id    = $5,
      auto_rotation  = COALESCE($6, auto_rotation),
      auto_refresh   = COALESCE($7, auto_refresh),
      auto_relogin   = COALESCE($8, auto_relogin),
      min_use_ms     = $9,
      max_use_ms     = $10,
      auto_time_mode = COALESCE($11, auto_time_mode),
      notes          = $12
    WHERE id = $13
  `, [
    b.nickname ?? null,
    b.email ?? null,
    b.password ?? null,
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

  const detail = reason ? `${rows[0].state} → ${state}: ${reason}` : `${rows[0].state} → ${state}`;
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

  const rows = await query<{ instance_id: number | null; cooldown_until: string | null; quarantine_until: string | null }>(`
    SELECT instance_id, cooldown_until, quarantine_until FROM accounts WHERE id = $1
  `, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Conta não encontrada." });

  const now = new Date();
  if (rows[0].quarantine_until && new Date(rows[0].quarantine_until) > now) {
    return res.status(400).json({ error: "Conta em quarentena." });
  }

  await query(`
    UPDATE accounts SET
      state            = 'ACTIVE',
      activated_at     = NOW(),
      last_active_at   = NOW(),
      consecutive_failures = 0,
      cooldown_until   = NULL
    WHERE id = $1
  `, [id]);

  await query(`
    INSERT INTO account_logs (account_id, instance_id, event_type, detail)
    VALUES ($1, $2, 'activated', 'Conta ativada')
  `, [id, rows[0].instance_id]);

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
