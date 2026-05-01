import { Router } from "express";
import { manager } from "../worker/manager.js";

export const blacklistRouter = Router({ mergeParams: true });

// GET /api/instances/:id/blacklist
blacklistRouter.get("/", async (req, res) => {
  const instanceId = Number(req.params.id);
  try {
    const rows = await manager.getBlacklist(instanceId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// DELETE /api/instances/:id/blacklist — limpa tudo (ou só um token via ?token_id=)
blacklistRouter.delete("/", async (req, res) => {
  const instanceId = Number(req.params.id);
  const tokenId = req.query.token_id ? Number(req.query.token_id) : undefined;
  try {
    await manager.clearBlacklist(instanceId, tokenId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// DELETE /api/instances/:id/blacklist/:tokenId/:orgId — remove entrada específica
blacklistRouter.delete("/:tokenId/:orgId", async (req, res) => {
  const instanceId = Number(req.params.id);
  const tokenId = Number(req.params.tokenId);
  const orgId = Number(req.params.orgId);
  try {
    await manager.unblacklistOrg(instanceId, tokenId, orgId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
