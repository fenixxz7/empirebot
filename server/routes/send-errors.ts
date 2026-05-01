import { Router } from "express";
import { query } from "../db/pool.js";

export const sendErrorsRouter = Router({ mergeParams: true });

// GET /api/instances/:id/send-errors
sendErrorsRouter.get("/", async (req, res) => {
  const instanceId = Number(req.params.id);
  try {
    const rows = await query<{
      org_label: string;
      error_count: number;
      last_status: number | null;
      last_seen: string;
    }>(
      `SELECT org_label, error_count, last_status, last_seen
       FROM match_send_errors
       WHERE instance_id = $1
       ORDER BY error_count DESC, last_seen DESC`,
      [instanceId],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// DELETE /api/instances/:id/send-errors — limpa todos (ou uma org via ?org_label=)
sendErrorsRouter.delete("/", async (req, res) => {
  const instanceId = Number(req.params.id);
  const orgLabel = req.query.org_label ? String(req.query.org_label) : undefined;
  try {
    if (orgLabel) {
      await query(
        `DELETE FROM match_send_errors WHERE instance_id = $1 AND org_label = $2`,
        [instanceId, orgLabel],
      );
    } else {
      await query(
        `DELETE FROM match_send_errors WHERE instance_id = $1`,
        [instanceId],
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
