import { Router } from "express";
import { query } from "../db/pool.js";

export const messageOverridesRouter = Router({ mergeParams: true });

type OverrideRow = {
  org_key: string;
  message: string;
  source: string;
  automod_blocks: number;
  generated_at: string;
};

// GET /api/instances/:id/message-overrides
messageOverridesRouter.get("/", async (req, res) => {
  const instanceId = Number((req.params as { id: string }).id);
  try {
    const rows = await query<OverrideRow>(
      `SELECT org_key, message, source, automod_blocks, generated_at
         FROM org_message_overrides
        WHERE instance_id = $1
        ORDER BY generated_at DESC`,
      [instanceId],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// PUT /api/instances/:id/message-overrides — upsert manual
messageOverridesRouter.put("/", async (req, res) => {
  const instanceId = Number((req.params as { id: string }).id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) {
    res.status(400).json({ error: "instance id inválido" });
    return;
  }
  const body = (req.body ?? {}) as { org_key?: unknown; message?: unknown };
  const orgKeyRaw = typeof body.org_key === "string" ? body.org_key.trim() : "";
  const messageRaw = typeof body.message === "string" ? body.message.trim() : "";
  if (!orgKeyRaw || orgKeyRaw.length > 200) {
    res.status(400).json({ error: "org_key inválido (1-200 chars)" });
    return;
  }
  if (!messageRaw || messageRaw.length > 2000) {
    res.status(400).json({ error: "message inválido (1-2000 chars)" });
    return;
  }
  try {
    await query(
      `INSERT INTO org_message_overrides
         (instance_id, org_key, message, source, automod_blocks, generated_at)
       VALUES ($1, $2, $3, 'manual', 0, NOW())
       ON CONFLICT (instance_id, org_key)
       DO UPDATE SET
         message      = EXCLUDED.message,
         source       = 'manual',
         generated_at = NOW()`,
      [instanceId, orgKeyRaw.toLowerCase(), messageRaw],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// DELETE /api/instances/:id/message-overrides — limpa todos ou ?org_key=
messageOverridesRouter.delete("/", async (req, res) => {
  const instanceId = Number((req.params as { id: string }).id);
  const orgKey = req.query.org_key ? String(req.query.org_key) : undefined;
  try {
    if (orgKey) {
      await query(
        `DELETE FROM org_message_overrides
          WHERE instance_id = $1 AND org_key = $2`,
        [instanceId, orgKey.toLowerCase()],
      );
    } else {
      await query(
        `DELETE FROM org_message_overrides WHERE instance_id = $1`,
        [instanceId],
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/instances/:id/message-overrides/bulk-delete
// Body: { org_keys: string[] } — remove em lote numa única transação
messageOverridesRouter.post("/bulk-delete", async (req, res) => {
  const instanceId = Number((req.params as { id: string }).id);
  if (!Number.isInteger(instanceId) || instanceId <= 0) {
    res.status(400).json({ error: "instance id inválido" });
    return;
  }
  const body = (req.body ?? {}) as { org_keys?: unknown };
  if (!Array.isArray(body.org_keys)) {
    res.status(400).json({ error: "org_keys deve ser array de strings" });
    return;
  }
  const keys = body.org_keys
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    .map((k) => k.trim().toLowerCase());
  if (keys.length === 0) {
    res.json({ ok: true, deleted: 0 });
    return;
  }
  if (keys.length > 500) {
    res.status(400).json({ error: "máximo 500 org_keys por requisição" });
    return;
  }
  try {
    const result = await query<{ org_key: string }>(
      `DELETE FROM org_message_overrides
        WHERE instance_id = $1 AND org_key = ANY($2::text[])
        RETURNING org_key`,
      [instanceId, keys],
    );
    res.json({ ok: true, deleted: result.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
