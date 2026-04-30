import { Router } from "express";
import { query } from "../db/pool.js";

export const orgsRouter = Router();

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"];

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

orgsRouter.post("/", async (req, res) => {
  const { name, category, guild_id, max_queues, priority, enabled } = req.body as {
    name: string;
    category: string;
    guild_id?: string | null;
    max_queues?: number;
    priority?: number;
    enabled?: boolean;
  };
  if (!name || !category || !VALID_CATEGORIES.includes(category)) {
    return res
      .status(400)
      .json({ error: `Informe um nome e uma categoria válida (${VALID_CATEGORIES.join(", ")})` });
  }
  const g = (guild_id ?? "").toString().trim();
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO orgs (name, category, guild_id, max_queues, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        name.trim(),
        category,
        g.length > 0 ? g : null,
        Number(max_queues ?? 5),
        Number(priority ?? 0),
        enabled === undefined ? true : !!enabled,
      ],
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

orgsRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { guild_id, name, max_queues, enabled, priority } = req.body as {
    guild_id?: string | null;
    name?: string;
    max_queues?: number;
    enabled?: boolean;
    priority?: number;
  };

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (guild_id !== undefined) {
    const g = (guild_id ?? "").toString().trim();
    sets.push(`guild_id = $${++i}`);
    vals.push(g.length > 0 ? g : null);
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
