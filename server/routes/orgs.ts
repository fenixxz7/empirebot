import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { validate } from "../lib/validate.js";

export const orgsRouter = Router();

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"] as const;

// Schemas tolerantes: preservam o comportamento de coerção do código original
// (`Number(...)`, `.toString().trim()`, etc) pra não quebrar clientes legados.
// Limites largos servem só pra cortar lixo absurdo, não pra apertar contrato.
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
});

const UpdateOrgBody = z.object({
  guild_id: GuildIdField.optional(),
  name: z.string().trim().min(1).optional(),
  max_queues: z.coerce.number().int().min(1).optional(),
  enabled: z.coerce.boolean().optional(),
  priority: z.coerce.number().int().optional(),
});

orgsRouter.get("/", async (_req, res) => {
  // Listagem é sempre completa — a categoria por org é metadata informativa.
  // O que filtra o que o bot entra é `instance_configs.allowed_categories`
  // aplicado por canal (org_channels.category).
  const rows = await query(
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
  res.json(rows);
});

orgsRouter.post("/", validate({ body: CreateOrgBody }), async (req, res) => {
  const { name, category, guild_id, max_queues, priority, enabled } = req.body;
  // guild_id já vem normalizado (string|null) pelo transform do schema
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO orgs (name, category, guild_id, max_queues, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [name, category, guild_id ?? null, max_queues, priority, enabled],
    );
    res.json({ ok: true, id: rows[0]?.id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

orgsRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM orgs WHERE id = $1`, [id]);
  res.json({ ok: true });
});

orgsRouter.patch("/:id", validate({ body: UpdateOrgBody }), async (req, res) => {
  const id = Number(req.params.id);
  const { guild_id, name, max_queues, enabled, priority } = req.body;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (guild_id !== undefined) {
    // guild_id já vem normalizado (string|null) pelo transform do schema
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

  // SAFE: `sets` só contém strings hardcoded acima ("guild_id = $2", etc).
  // Nenhum input do usuário entra na string SQL — só vai como parâmetro
  // posicional no array `vals`. Falso positivo de scanners de SQLi.
  await query(`UPDATE orgs SET ${sets.join(", ")} WHERE id = $1`, [id, ...vals]);
  res.json({ ok: true });
});

orgsRouter.get("/:id/channels", async (req, res) => {
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
});
