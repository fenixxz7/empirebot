import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { dmResponders } from "../worker/manager.js";
import { DiscordRest } from "../discord/rest.js";
import { validate } from "../lib/validate.js";

export const messagesRouter = Router();

const DmConfigBody = z.object({
  enabled: z.coerce.boolean(),
  min_delay_msg: z.coerce.number().min(0).default(1.5),
  max_delay_msg: z.coerce.number().min(0).default(2.5),
  min_delay_user: z.coerce.number().min(0).default(10),
  max_delay_user: z.coerce.number().min(0).default(15),
});

const CreateMessageBody = z.object({
  name: z.string().default(""),
  body: z.string().default(""),
});

const UpdateMessageBody = z.object({
  name: z.string().optional(),
  body: z.string().optional(),
  position: z.coerce.number().int().optional(),
});

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

messagesRouter.put("/config/:instanceId", validate({ body: DmConfigBody }), async (req, res) => {
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

messagesRouter.post("/:instanceId", validate({ body: CreateMessageBody }), async (req, res) => {
  const id = Number(req.params.instanceId);
  const { name, body } = req.body;

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

messagesRouter.put("/:instanceId/:msgId", validate({ body: UpdateMessageBody }), async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const msgId = Number(req.params.msgId);
  const { name, body, position } = req.body;

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
  const results = [];

  for (const tok of tokens) {
    const rest = new DiscordRest(tok.value);
    const endpointResults = await rest.listMessageRequestsRaw();
    const respondedRows = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_responded WHERE instance_id = $1`,
      [id]
    );

    const endpoints = endpointResults.map((raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.text); } catch { parsed = null; }

      // Para arrays, mostra um resumo dos campos de cada item e destaca os que têm is_message_request
      let summary: unknown = undefined;
      if (Array.isArray(parsed)) {
        const arr = parsed as Record<string, unknown>[];
        summary = {
          total: arr.length,
          message_requests: arr.filter(c => c.is_message_request).length,
          with_is_message_request_timestamp: arr.filter(c => c.is_message_request_timestamp).length,
          flags_nonzero: arr.filter(c => (c.flags as number) !== 0).map(c => ({ id: c.id, flags: c.flags })),
          recipient_flags_nonzero: arr.filter(c => (c.recipient_flags as number) !== 0).map(c => ({
            id: c.id,
            recipient_flags: c.recipient_flags,
            recipient: ((c.recipients as any[])?.[0]?.username) ?? "?",
          })),
          sample_fields: arr[0] ? Object.keys(arr[0]) : [],
          request_channels: arr.filter(c => c.is_message_request).slice(0, 3),
          // Lista TODOS os DMs com username para identificar manualmente o "fenixxz"
          all_dms: arr.filter(c => c.type === 1).map(c => {
            const r = (c.recipients as any[])?.[0];
            return {
              id: c.id,
              type: c.type,
              flags: c.flags,
              recipient_flags: c.recipient_flags,
              last_message_id: c.last_message_id,
              is_message_request: c.is_message_request,
              is_message_request_timestamp: c.is_message_request_timestamp,
              user: r ? { id: r.id, username: r.username, global_name: r.global_name } : null,
            };
          }),
        };
      }

      return {
        url: raw.url,
        http_status: raw.status,
        parsed_type: parsed === null ? "null/truncated" : Array.isArray(parsed) ? `array(${(parsed as unknown[]).length})` : typeof parsed,
        parsed_keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed as object) : undefined,
        summary,
        raw_response_truncated: raw.text.slice(0, 300),
      };
    });

    results.push({
      token_position: tok.position,
      username: tok.username,
      endpoints,
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
  const drained = await responder.forceDrainCache();
  await responder.tick();
  const snapshot = await responder.getSnapshot();
  res.json({ ok: true, drained, snapshot });
});
