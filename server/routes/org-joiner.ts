import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { query } from "../db/pool.js";
import { manager } from "../worker/manager.js";

export const orgJoinerRouter = Router();

function getJoiner(instanceId: number) {
  return manager.getOrgJoiner(instanceId);
}

orgJoinerRouter.get("/config/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query<any>(
    `SELECT token_value, nopecha_key, delay_min_ms, delay_max_ms, enabled
     FROM org_joiner_config WHERE instance_id = $1`,
    [id],
  );
  if (!rows[0]) {
    res.json({ token_value: null, nopecha_key: null, delay_min_ms: 300000, delay_max_ms: 720000, enabled: false });
    return;
  }
  res.json(rows[0]);
}));

orgJoinerRouter.put("/config/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { token_value, nopecha_key, delay_min_ms, delay_max_ms, enabled } = req.body;
  await query(
    `INSERT INTO org_joiner_config (instance_id, token_value, nopecha_key, delay_min_ms, delay_max_ms, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (instance_id) DO UPDATE SET
       token_value  = EXCLUDED.token_value,
       nopecha_key  = EXCLUDED.nopecha_key,
       delay_min_ms = EXCLUDED.delay_min_ms,
       delay_max_ms = EXCLUDED.delay_max_ms,
       enabled      = EXCLUDED.enabled`,
    [id, token_value || null, nopecha_key || null, delay_min_ms ?? 300000, delay_max_ms ?? 720000, !!enabled],
  );
  res.json({ ok: true });
}));

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
