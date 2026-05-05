import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const logsRouter = Router();

logsRouter.get("/:instanceId", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = await query(
    `SELECT id, ts, level, source, message
     FROM logs WHERE instance_id = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [id, limit]
  );
  res.json(rows);
}));

logsRouter.delete("/:instanceId", asyncHandler(async (req, res) => {
  const id = Number(req.params.instanceId);
  await query(`DELETE FROM logs WHERE instance_id = $1`, [id]);
  res.json({ ok: true });
}));
