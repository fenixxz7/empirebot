import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdmin } from "./auth.js";

export const tokensRouter = Router();

function preview(token: string): string {
  if (!token || token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

tokensRouter.get("/", asyncHandler(async (req, res) => {
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

  let rows: { id: number; label: string | null; value: string; status: string; username: string | null }[];

  if (instanceId) {
    rows = await query<{ id: number; label: string | null; value: string; status: string; username: string | null }>(
      `SELECT tp.id, tp.label, tp.value, tp.status, tp.username
       FROM token_pool tp
       INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
       WHERE its.instance_id = $1
       ORDER BY its.position ASC`,
      [instanceId],
    );
  } else {
    rows = await query<{ id: number; label: string | null; value: string; status: string; username: string | null }>(
      `SELECT id, label, value, status, username FROM token_pool ORDER BY id ASC`,
    );
  }

  res.json(rows.map((t) => ({
    id: t.id,
    label: t.label,
    value_preview: preview(t.value),
    status: t.status,
    username: t.username,
  })));
}));

tokensRouter.post("/", asyncHandler(async (req, res) => {
  const { value, label, instance_id } = req.body as { value?: string; label?: string; instance_id?: number };
  if (!value?.trim()) {
    return res.status(400).json({ error: "Informe o valor do token." });
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO token_pool (value, label, status)
     VALUES ($1, $2, 'unknown')
     ON CONFLICT (value) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [value.trim(), label?.trim() || null]
  );
  const tokenId = rows[0]!.id;

  // Auto-seleciona o token na instância que o adicionou
  if (instance_id) {
    const posRows = await query<{ max_pos: number | null }>(
      `SELECT MAX(position) AS max_pos FROM instance_token_selection WHERE instance_id = $1`,
      [instance_id],
    );
    const nextPos = (posRows[0]?.max_pos ?? 0) + 1;
    await query(
      `INSERT INTO instance_token_selection (instance_id, token_pool_id, position)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [instance_id, tokenId, nextPos],
    );
  }

  res.json({ ok: true, id: tokenId });
}));

tokensRouter.get("/:id/value", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query<{ value: string }>(`SELECT value FROM token_pool WHERE id = $1`, [id]);
  if (!rows[0]) { res.status(404).json({ error: "Token não encontrado." }); return; }
  res.json({ value: rows[0].value });
}));

tokensRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM token_pool WHERE id = $1`, [id]);
  res.json({ ok: true });
}));
