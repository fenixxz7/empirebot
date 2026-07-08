import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

import { instanceAccessGuard } from "../lib/instanceAccess.js";

export const logsRouter = Router();

// Guard: restringe acesso às instâncias permitidas para o usuário atual
logsRouter.use("/:instanceId", instanceAccessGuard("instanceId"));

logsRouter.get("/:instanceId", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const afterId = req.query.after_id !== undefined ? Number(req.query.after_id) : null;

  let rows;
  if (afterId !== null) {
    rows = await query(
      `SELECT id, ts, level, source, message
       FROM logs WHERE instance_id = $1 AND id > $2
       ORDER BY id DESC LIMIT $3`,
      [id, afterId, limit],
    );
  } else {
    rows = await query(
      `SELECT id, ts, level, source, message
       FROM logs WHERE instance_id = $1
       ORDER BY id DESC LIMIT $2`,
      [id, limit],
    );
  }
  res.json(rows);
}));

logsRouter.get("/:instanceId/export", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  const minutesRaw = req.query.minutes;
  const all = minutesRaw === "all";
  const minutes = all ? null : Math.min(Math.max(1, Number(minutesRaw ?? 10)), 1440);

  const rows = await query<{ ts: string; level: string; source: string | null; message: string }>(
    all
      ? `SELECT to_char(ts AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS ts,
                level, source, message
         FROM logs WHERE instance_id = $1
         ORDER BY id ASC`
      : `SELECT to_char(ts AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS ts,
                level, source, message
         FROM logs WHERE instance_id = $1
           AND ts > NOW() - ($2 || ' minutes')::interval
         ORDER BY id ASC`,
    all ? [id] : [id, String(minutes)],
  );

  const lines = rows
    .map((r) => `[${r.ts}] ${r.level.padEnd(5)} ${(r.source ?? "").padEnd(12)} ${r.message}`)
    .join("\n");

  const label = all ? "todos" : `${minutes}min`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="logs-instance${id}-${label}.txt"`,
  );
  res.send(lines || "(sem logs no período)");
}));

logsRouter.delete("/:instanceId", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  await query(`DELETE FROM logs WHERE instance_id = $1`, [id]);
  res.json({ ok: true });
}));
