import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { query } from "../db/pool.js";
import { manager } from "../worker/manager.js";
import { requireAdmin } from "./auth.js";

export const orgJoinerRouter = Router();

function preview(token: string): string {
  if (!token || token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function getJoiner(instanceId: number) {
  return manager.getOrgJoiner(instanceId);
}

/* ── Config ─────────────────────────────────────────────────────────── */

orgJoinerRouter.get("/config/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  const cfgRows = await query<{
    nopecha_key: string | null;
    delay_min_ms: number;
    delay_max_ms: number;
    enabled: boolean;
  }>(
    `SELECT nopecha_key, delay_min_ms, delay_max_ms, enabled
     FROM org_joiner_config WHERE instance_id = $1`,
    [id],
  );
  const cfg = cfgRows[0] ?? { nopecha_key: null, delay_min_ms: 300000, delay_max_ms: 720000, enabled: false };

  const poolRows = await query<{
    id: number; label: string | null; value: string; status: string; username: string | null;
  }>(`SELECT id, label, value, status, username FROM token_pool WHERE type = 'org' ORDER BY id ASC`);

  const selRows = await query<{ token_pool_id: number }>(
    `SELECT token_pool_id FROM org_joiner_token_selection WHERE instance_id = $1`,
    [id],
  );
  const selected_token_id = selRows[0]?.token_pool_id ?? null;

  res.json({
    ...cfg,
    token_pool: poolRows.map(t => ({ id: t.id, label: t.label, value_preview: preview(t.value), status: t.status, username: t.username })),
    selected_token_id,
  });
}));

orgJoinerRouter.put("/config/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { nopecha_key, delay_min_ms, delay_max_ms, enabled } = req.body;
  await query(
    `INSERT INTO org_joiner_config (instance_id, nopecha_key, delay_min_ms, delay_max_ms, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (instance_id) DO UPDATE SET
       nopecha_key  = EXCLUDED.nopecha_key,
       delay_min_ms = EXCLUDED.delay_min_ms,
       delay_max_ms = EXCLUDED.delay_max_ms,
       enabled      = EXCLUDED.enabled`,
    [id, nopecha_key || null, delay_min_ms ?? 300000, delay_max_ms ?? 720000, !!enabled],
  );
  res.json({ ok: true });
}));

/* ── Token selection ─────────────────────────────────────────────────── */

orgJoinerRouter.post("/tokens/:id", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.id);
  const { value, label } = req.body as { value?: string; label?: string };
  if (!value?.trim()) {
    res.status(400).json({ error: "Informe o valor do token." });
    return;
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO token_pool (value, label, status, type)
     VALUES ($1, $2, 'unknown', 'org')
     ON CONFLICT (value) DO UPDATE SET label = COALESCE(EXCLUDED.label, token_pool.label)
     RETURNING id`,
    [value.trim(), label?.trim() || null],
  );
  const tokenPoolId = rows[0]!.id;
  await query(
    `INSERT INTO org_joiner_token_selection (instance_id, token_pool_id)
     VALUES ($1, $2)
     ON CONFLICT (instance_id) DO UPDATE SET token_pool_id = EXCLUDED.token_pool_id`,
    [instanceId, tokenPoolId],
  );
  res.json({ ok: true, id: tokenPoolId });
}));

orgJoinerRouter.put("/tokens/:id/select", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.id);
  const { token_pool_id } = req.body as { token_pool_id: number };
  await query(
    `INSERT INTO org_joiner_token_selection (instance_id, token_pool_id)
     VALUES ($1, $2)
     ON CONFLICT (instance_id) DO UPDATE SET token_pool_id = EXCLUDED.token_pool_id`,
    [instanceId, token_pool_id],
  );
  res.json({ ok: true });
}));

orgJoinerRouter.delete("/tokens/:id/deselect", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.id);
  await query(
    `DELETE FROM org_joiner_token_selection WHERE instance_id = $1`,
    [instanceId],
  );
  res.json({ ok: true });
}));

// Remove o token do pool global (apenas tokens type='org') e desseleciona da instância
orgJoinerRouter.delete("/tokens/:instanceId/pool/:tokenId", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const tokenId = Number(req.params.tokenId);
  await query(`DELETE FROM org_joiner_token_selection WHERE instance_id = $1 AND token_pool_id = $2`, [instanceId, tokenId]);
  await query(`DELETE FROM token_pool WHERE id = $1 AND type = 'org'`, [tokenId]);
  res.json({ ok: true });
}));

// Retorna o valor completo do token (apenas admin)
orgJoinerRouter.get("/tokens/:instanceId/pool/:tokenId/reveal", requireAdmin, asyncHandler(async (req, res) => {
  const tokenId = Number(req.params.tokenId);
  const rows = await query<{ value: string }>(
    `SELECT value FROM token_pool WHERE id = $1 AND type = 'org'`,
    [tokenId],
  );
  if (!rows[0]) { res.status(404).json({ error: "Token não encontrado." }); return; }
  res.json({ value: rows[0].value });
}));

/* ── Queue ───────────────────────────────────────────────────────────── */

orgJoinerRouter.get("/queue/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const limit = Math.min(200, Number(req.query.limit ?? 100));
  const rows = await query<any>(
    `SELECT id, invite_code, invite_raw, status, result_guild_id, result_guild_name,
            error_reason, added_at, processed_at
     FROM org_queue
     WHERE instance_id = $1
     ORDER BY added_at DESC
     LIMIT $2`,
    [id, limit],
  );
  res.json(rows);
}));

orgJoinerRouter.post("/queue/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  const body = req.body as { invites: string[] } | { invite: string };

  const links: string[] = "invites" in body
    ? body.invites
    : body.invite
      ? [body.invite]
      : [];

  if (!links.length) { res.status(400).json({ error: "Nenhum invite fornecido." }); return; }

  const results = [];
  for (const link of links) {
    const r = await joiner.addInvite(link);
    results.push(r);
  }
  res.json(results);
}));

orgJoinerRouter.delete("/queue/:id/:qid", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const qid = Number(req.params.qid);
  await query(
    `DELETE FROM org_queue WHERE id = $1 AND instance_id = $2 AND status = 'pending'`,
    [qid, id],
  );
  res.json({ ok: true });
}));

orgJoinerRouter.post("/queue/:id/retry-failed", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  const n = await joiner.retryFailed();
  res.json({ ok: true, retried: n });
}));

/* ── Engine control ──────────────────────────────────────────────────── */

orgJoinerRouter.post("/start/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  await joiner.start();
  await query(`UPDATE org_joiner_config SET enabled = TRUE WHERE instance_id = $1`, [id]);
  res.json({ ok: true });
}));

orgJoinerRouter.post("/stop/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  joiner.stop();
  await query(`UPDATE org_joiner_config SET enabled = FALSE WHERE instance_id = $1`, [id]);
  res.json({ ok: true });
}));

orgJoinerRouter.get("/snapshot/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  const snap = joiner.getSnapshot();

  const queueCount = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM org_queue WHERE instance_id = $1 AND status = 'pending'`,
    [id],
  );
  snap.queueSize = Number(queueCount[0]?.n ?? 0);

  res.json(snap);
}));

orgJoinerRouter.get("/logs/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  res.json(joiner.getLogs());
}));

orgJoinerRouter.delete("/logs/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const joiner = getJoiner(id);
  joiner.clearLogs();
  res.json({ ok: true });
}));
