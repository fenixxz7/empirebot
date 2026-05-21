import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

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
       WHERE its.instance_id = $1 AND tp.type = 'fila'
       ORDER BY its.position ASC`,
      [instanceId],
    );
  } else {
    rows = await query<{ id: number; label: string | null; value: string; status: string; username: string | null }>(
      `SELECT id, label, value, status, username FROM token_pool WHERE type = 'fila' ORDER BY id ASC`,
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
    `INSERT INTO token_pool (value, label, status, type)
     VALUES ($1, $2, 'unknown', 'fila')
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

// DELETE — remove apenas da seleção da instância informada.
// O registro global em token_pool NÃO é apagado para não afetar outras instâncias.
// Caso nenhuma instância use mais o token, limpeza opcional pode ser adicionada futuramente.
tokensRouter.delete("/:id", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

  if (instanceId) {
    // Remove APENAS da seleção desta instância — não afeta outras instâncias
    await query(
      `DELETE FROM instance_token_selection WHERE token_pool_id = $1 AND instance_id = $2`,
      [id, instanceId],
    );
  } else {
    // Sem instância informada: remove de todas as seleções e do pool global
    // (mantido para compatibilidade, mas não é mais usado pelo painel normal)
    await query(`DELETE FROM instance_token_selection WHERE token_pool_id = $1`, [id]);
    await query(`DELETE FROM token_pool WHERE id = $1`, [id]);
  }

  res.json({ ok: true });
}));
