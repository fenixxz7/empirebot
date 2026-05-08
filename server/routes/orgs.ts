import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { validate } from "../lib/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const orgsRouter = Router();

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"] as const;

const GuildIdField = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : String(v).trim() || null));

const CreateOrgBody = z.object({
  name: z.string().trim().min(1, "Nome obrigatório"),
  category: z.enum(VALID_CATEGORIES),
  guild_id: GuildIdField.optional(),
  max_queues: z.coerce.number().int().min(1).default(5),
  priority: z.coerce.number().int().default(0),
  enabled: z.coerce.boolean().default(true),
  instance_id: z.coerce.number().int().optional(),
});

const UpdateOrgBody = z.object({
  guild_id: GuildIdField.optional(),
  name: z.string().trim().min(1).optional(),
  max_queues: z.coerce.number().int().min(1).optional(),
  enabled: z.coerce.boolean().optional(),
  priority: z.coerce.number().int().optional(),
});

orgsRouter.get("/", asyncHandler(async (req, res) => {
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

  let rows;
  if (instanceId) {
    rows = await query(
      `SELECT o.id, o.guild_id, o.name, o.category, o.max_queues, o.enabled, o.priority,
              COALESCE(c.cnt, 0)::int AS channels_count,
              c.last_scanned_at
       FROM orgs o
       INNER JOIN instance_orgs io ON io.org_id = o.id AND io.instance_id = $1
       LEFT JOIN (
         SELECT org_id,
                COUNT(*)::int AS cnt,
                MAX(last_scanned_at) AS last_scanned_at
         FROM org_channels
         GROUP BY org_id
       ) c ON c.org_id = o.id
       ORDER BY o.name ASC`,
      [instanceId],
    );
  } else {
    rows = await query(
      `SELECT o.id, o.guild_id, o.name, o.category, o.max_queues, o.enabled, o.priority,
              COALESCE(c.cnt, 0)::int AS channels_count,
              c.last_scanned_at
       FROM orgs o
       LEFT JOIN (
         SELECT org_id,
                COUNT(*)::int AS cnt,
                MAX(last_scanned_at) AS last_scanned_at
         FROM org_channels
         GROUP BY org_id
       ) c ON c.org_id = o.id
       ORDER BY o.name ASC`,
    );
  }
  res.json(rows);
}));

orgsRouter.post("/", validate({ body: CreateOrgBody }), asyncHandler(async (req, res) => {
  const { name, category, guild_id, max_queues, priority, enabled, instance_id } = req.body;
  const rows = await query<{ id: number }>(
    `INSERT INTO orgs (name, category, guild_id, max_queues, priority, enabled, instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [name, category, guild_id ?? null, max_queues, priority, enabled, instance_id ?? null],
  );
  const orgId = rows[0]?.id;
  // Auto-seleciona a org na instância ao criar
  if (orgId && instance_id) {
    await query(
      `INSERT INTO instance_orgs (instance_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [instance_id, orgId],
    );
  }
  res.json({ ok: true, id: orgId });
}));

orgsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM orgs WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

orgsRouter.patch("/:id", validate({ body: UpdateOrgBody }), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { guild_id, name, max_queues, enabled, priority } = req.body;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (guild_id !== undefined) {
    sets.push(`guild_id = $${++i}`);
    vals.push(guild_id);
  }
  if (name !== undefined) {
    sets.push(`name = $${++i}`);
    vals.push(name);
  }
  if (max_queues !== undefined) {
    sets.push(`max_queues = $${++i}`);
    vals.push(Number(max_queues));
  }
  if (enabled !== undefined) {
    sets.push(`enabled = $${++i}`);
    vals.push(!!enabled);
  }
  if (priority !== undefined) {
    sets.push(`priority = $${++i}`);
    vals.push(Number(priority));
  }

  if (sets.length === 0) return res.json({ ok: true });

  await query(`UPDATE orgs SET ${sets.join(", ")} WHERE id = $1`, [id, ...vals]);
  res.json({ ok: true });
}));

orgsRouter.get("/:id/channels", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT id, channel_id, channel_name, category, mode, message_id, embed_title,
            buttons, last_scanned_at
     FROM org_channels
     WHERE org_id = $1
     ORDER BY category NULLS LAST, mode NULLS LAST, channel_name ASC, id ASC`,
    [id],
  );
  res.json(rows);
}));
