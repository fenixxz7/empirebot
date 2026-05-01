import { Router } from "express";
import { query } from "../db/pool.js";

export const tokensRouter = Router();

function preview(token: string): string {
  if (!token || token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// GET /api/tokens — lista todos os tokens do pool global
tokensRouter.get("/", async (_req, res) => {
  const rows = await query<{
    id: number; label: string | null; value: string;
    status: string; username: string | null;
  }>(
    `SELECT id, label, value, status, username FROM token_pool ORDER BY id ASC`
  );
  res.json(rows.map((t) => ({
    id: t.id,
    label: t.label,
    value_preview: preview(t.value),
    status: t.status,
    username: t.username,
  })));
});

// POST /api/tokens — adiciona token ao pool global
tokensRouter.post("/", async (req, res) => {
  const { value, label } = req.body as { value?: string; label?: string };
  if (!value?.trim()) {
    return res.status(400).json({ error: "Informe o valor do token." });
  }
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO token_pool (value, label, status)
       VALUES ($1, $2, 'unknown')
       ON CONFLICT (value) DO UPDATE SET label = EXCLUDED.label
       RETURNING id`,
      [value.trim(), label?.trim() || null]
    );
    res.json({ ok: true, id: rows[0]!.id });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// DELETE /api/tokens/:id — remove do pool global
tokensRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM token_pool WHERE id = $1`, [id]);
  res.json({ ok: true });
});
