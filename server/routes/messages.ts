import { Router } from "express";
import { query } from "../db/pool.js";
import { dmResponders } from "../worker/manager.js";
import { DiscordRest } from "../discord/rest.js";

export const messagesRouter = Router();

messagesRouter.get("/config/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);
  const rows = await query<{
    enabled: boolean;
    min_delay_msg: number; max_delay_msg: number;
    min_delay_user: number; max_delay_user: number;
  }>(
    `SELECT enabled, min_delay_msg, max_delay_msg, min_delay_user, max_delay_user
     FROM dm_config WHERE instance_id = $1`,
    [id]
  );
  res.json(rows[0] ?? { enabled: false, min_delay_msg: 1.5, max_delay_msg: 2.5, min_delay_user: 10, max_delay_user: 15 });
});

messagesRouter.put("/config/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);
  const { enabled, min_delay_msg, max_delay_msg, min_delay_user, max_delay_user } = req.body;

  await query(
    `INSERT INTO dm_config (instance_id, enabled, min_delay_msg, max_delay_msg, min_delay_user, max_delay_user)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (instance_id) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         min_delay_msg = EXCLUDED.min_delay_msg,
         max_delay_msg = EXCLUDED.max_delay_msg,
         min_delay_user = EXCLUDED.min_delay_user,
         max_delay_user = EXCLUDED.max_delay_user`,
    [id, !!enabled, min_delay_msg ?? 1.5, max_delay_msg ?? 2.5, min_delay_user ?? 10, max_delay_user ?? 15]
  );

  const responder = dmResponders.get(id);
  if (responder) {
    if (enabled) responder.start();
    else responder.stop();
  }

  res.json({ ok: true });
});

messagesRouter.get("/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);
  const rows = await query<{ id: number; position: number; name: string; body: string }>(
    `SELECT id, position, name, body FROM dm_messages WHERE instance_id = $1 ORDER BY position ASC`,
    [id]
  );
  res.json(rows);
});

messagesRouter.post("/:instanceId", async (req, res) => {
  const id = Number(req.params.instanceId);
  const { name, body } = req.body as { name: string; body: string };

  const maxPos = await query<{ m: number | null }>(
    `SELECT MAX(position) AS m FROM dm_messages WHERE instance_id = $1`,
    [id]
  );
  const nextPos = (maxPos[0]?.m ?? -1) + 1;

  const rows = await query<{ id: number; position: number; name: string; body: string }>(
    `INSERT INTO dm_messages (instance_id, position, name, body) VALUES ($1, $2, $3, $4) RETURNING id, position, name, body`,
    [id, nextPos, name ?? "", body ?? ""]
  );
  res.json(rows[0]);
});

messagesRouter.put("/:instanceId/:msgId", async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const msgId = Number(req.params.msgId);
  const { name, body, position } = req.body as { name?: string; body?: string; position?: number };

  const fields: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); vals.push(name); }
  if (body !== undefined) { fields.push(`body = $${i++}`); vals.push(body); }
  if (position !== undefined) { fields.push(`position = $${i++}`); vals.push(position); }

  if (fields.length === 0) { res.json({ ok: true }); return; }

  vals.push(msgId, instanceId);
  await query(
    `UPDATE dm_messages SET ${fields.join(", ")} WHERE id = $${i++} AND instance_id = $${i++}`,
    vals
  );
  res.json({ ok: true });
});

messagesRouter.delete("/:instanceId/:msgId", async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const msgId = Number(req.params.msgId);
  await query(`DELETE FROM dm_messages WHERE id = $1 AND instance_id = $2`, [msgId, instanceId]);
  res.json({ ok: true });
});

messagesRouter.get("/:instanceId/queue/snapshot", async (req, res) => {
  const id = Number(req.params.instanceId);
  const responder = dmResponders.get(id);
  if (!responder) {
    res.json({ enabled: false, processing: null, waiting: [], respondedToday: 0, respondedTotal: 0 });
    return;
  }
  const snapshot = await responder.getSnapshot();
  res.json(snapshot);
});

messagesRouter.delete("/:instanceId/responded/clear", async (req, res) => {
  const id = Number(req.params.instanceId);
  await query(`DELETE FROM dm_responded WHERE instance_id = $1`, [id]);
  res.json({ ok: true });
});

// Diagnóstico: busca requests raw direto do Discord para cada token conectado
messagesRouter.get("/:instanceId/debug/requests", async (req, res) => {
  const id = Number(req.params.instanceId);
  const tokens = await query<{ id: number; value: string; username: string | null; position: number }>(
    `SELECT id, value, username, position FROM tokens WHERE instance_id = $1 AND status = 'connected' ORDER BY position ASC`,
    [id]
  );
  const results: Array<{
    token_position: number;
    username: string | null;
    http_status: number;
    raw_response: string;
    parsed_type: string;
    parsed_keys?: string[];
    parsed_length?: number;
    responded_ids: string[];
  }> = [];

  for (const tok of tokens) {
    const rest = new DiscordRest(tok.value);
    const raw = await rest.listMessageRequestsRaw();
    const respondedRows = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_responded WHERE instance_id = $1`,
      [id]
    );
    let parsed: unknown;
    try { parsed = JSON.parse(raw.text); } catch { parsed = null; }
    results.push({
      token_position: tok.position,
      username: tok.username,
      http_status: raw.status,
      raw_response: raw.text.slice(0, 2000),
      parsed_type: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
      parsed_keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed as object) : undefined,
      parsed_length: Array.isArray(parsed) ? (parsed as unknown[]).length : undefined,
      responded_ids: respondedRows.map(row => row.user_id),
    });
  }
  res.json(results);
});

// Forçar varredura imediata do DM Responder
messagesRouter.post("/:instanceId/scan-now", async (req, res) => {
  const id = Number(req.params.instanceId);
  const responder = dmResponders.get(id);
  if (!responder) {
    res.status(404).json({ error: "Responder não encontrado para esta instância" });
    return;
  }
  await responder.tick();
  const snapshot = await responder.getSnapshot();
  res.json({ ok: true, snapshot });
});
