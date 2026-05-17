import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { validate } from "../lib/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { listDetectedTypes, getGhostsByType, getUncorrelatedCount } from "../lib/orgDetection.js";

export const orgsRouter = Router();

const VALID_CATEGORIES = ["Mobile", "Misto", "Emulador", "Tatico", "Full-Soco"] as const;
const VALID_MATCH_TYPES = ["thread", "private_channel", "mixed"] as const;

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
  match_type: z.enum(VALID_MATCH_TYPES).optional(),
});

// ─── GET /type-metrics — métricas por match_type ─────────────────────────────
// DEVE vir antes de /:id para não ser capturado por esse parâmetro
orgsRouter.get("/type-metrics", asyncHandler(async (req, res) => {
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

  // Active queues por tipo
  const aqRows = await query<{ match_type: string; count: string }>(
    `SELECT o.match_type, COUNT(*)::text AS count
     FROM active_queues aq
     JOIN orgs o ON o.id = aq.org_id
     ${instanceId ? "WHERE aq.instance_id = $1" : ""}
     GROUP BY o.match_type`,
    instanceId ? [instanceId] : [],
  );

  // Matches por tipo (histórico — tabela matches)
  const matchRows = await query<{ match_type: string; count: string }>(
    `SELECT o.match_type, COUNT(*)::text AS count
     FROM matches m
     JOIN orgs o ON o.guild_id = m.guild_id
     ${instanceId ? "WHERE m.instance_id = $1" : ""}
     GROUP BY o.match_type`,
    instanceId ? [instanceId] : [],
  );

  // Contagem de orgs por tipo
  const orgRows = await query<{ match_type: string; count: string }>(
    `SELECT match_type, COUNT(*)::text AS count
     FROM orgs
     ${instanceId
       ? "WHERE id IN (SELECT org_id FROM instance_orgs WHERE instance_id = $1)"
       : ""}
     GROUP BY match_type`,
    instanceId ? [instanceId] : [],
  );

  function toMap(rows: { match_type: string; count: string }[]) {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.match_type] = Number(r.count);
    return m;
  }

  // Dados em memória do módulo de detecção (sem custo de DB)
  const ghosts = instanceId ? getGhostsByType(instanceId) : {};
  const uncorrelated = instanceId ? getUncorrelatedCount(instanceId) : 0;

  res.json({
    active_queues: toMap(aqRows),
    matches: toMap(matchRows),
    orgs: toMap(orgRows),
    /** Ghosts (sweep TTL) acumulados desde o último restart, por match_type */
    ghosts,
    /** Partidas detectadas sem activeQueue correspondente (sem correlação de org) */
    uncorrelated,
  });
}));

// ─── GET /detected-types — tipos detectados em tempo real (memória) ───────────
orgsRouter.get("/detected-types", asyncHandler(async (_req, res) => {
  const items = listDetectedTypes();
  res.json(items.map((it) => ({
    instance_id: it.instance_id,
    org_id: it.org_id,
    org_name: it.orgName,
    detected_type: it.detectedType,
    configured_type: it.configuredType,
    channel_id: it.channelId,
    channel_name: it.channelName,
    detected_at: it.detectedAt,
    thread_count: it.threadCount,
    private_count: it.privateCount,
  })));
}));

// ─── GET / — lista orgs ───────────────────────────────────────────────────────
orgsRouter.get("/", asyncHandler(async (req, res) => {
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

  let rows;
  if (instanceId) {
    rows = await query(
      `SELECT o.id, o.guild_id, o.name, o.category, o.max_queues, o.enabled, o.priority,
              o.match_type,
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
              o.match_type,
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

// ─── POST / — cria org ────────────────────────────────────────────────────────
orgsRouter.post("/", validate({ body: CreateOrgBody }), asyncHandler(async (req, res) => {
  const { name, category, guild_id, max_queues, priority, enabled, instance_id } = req.body;
  const rows = await query<{ id: number }>(
    `INSERT INTO orgs (name, category, guild_id, max_queues, priority, enabled, instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [name, category, guild_id ?? null, max_queues, priority, enabled, instance_id ?? null],
  );
  const orgId = rows[0]?.id;
  if (orgId && instance_id) {
    await query(
      `INSERT INTO instance_orgs (instance_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [instance_id, orgId],
    );
  }
  res.json({ ok: true, id: orgId });
}));

// ─── DELETE /:id — apaga org ──────────────────────────────────────────────────
orgsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM orgs WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// ─── PATCH /:id — atualiza org ────────────────────────────────────────────────
orgsRouter.patch("/:id", validate({ body: UpdateOrgBody }), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { guild_id, name, max_queues, enabled, priority, match_type } = req.body;

  // Lê tipo antigo ANTES do UPDATE para garantir auditoria correta
  let oldMatchType: string | null = null;
  if (match_type !== undefined) {
    const prevRows = await query<{ match_type: string }>(
      `SELECT match_type FROM orgs WHERE id = $1`,
      [id],
    );
    oldMatchType = prevRows[0]?.match_type ?? null;
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (guild_id !== undefined) { sets.push(`guild_id = $${++i}`); vals.push(guild_id); }
  if (name !== undefined) { sets.push(`name = $${++i}`); vals.push(name); }
  if (max_queues !== undefined) { sets.push(`max_queues = $${++i}`); vals.push(Number(max_queues)); }
  if (enabled !== undefined) { sets.push(`enabled = $${++i}`); vals.push(!!enabled); }
  if (priority !== undefined) { sets.push(`priority = $${++i}`); vals.push(Number(priority)); }
  if (match_type !== undefined) { sets.push(`match_type = $${++i}`); vals.push(match_type); }

  if (sets.length === 0) return res.json({ ok: true });

  await query(`UPDATE orgs SET ${sets.join(", ")} WHERE id = $1`, [id, ...vals]);

  // Registra auditoria após confirmar a mudança
  if (match_type !== undefined) {
    await query(
      `INSERT INTO org_match_type_history (org_id, old_type, new_type, origin)
       VALUES ($1, $2, $3, 'panel')`,
      [id, oldMatchType, match_type],
    );
  }

  res.json({ ok: true });
}));

// ─── GET /:id/channels — canais descobertos da org ────────────────────────────
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

// ─── DELETE /:id/channels — limpa canais da org ───────────────────────────────
orgsRouter.delete("/:id/channels", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM org_channels WHERE org_id = $1`, [id]);
  await query(`UPDATE orgs SET last_discovered_at = NULL WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// ─── GET /:id/history — histórico de mudanças de match_type ──────────────────
orgsRouter.get("/:id/history", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT id, old_type, new_type, changed_at, origin
     FROM org_match_type_history
     WHERE org_id = $1
     ORDER BY changed_at DESC
     LIMIT 50`,
    [id],
  );
  res.json(rows);
}));
