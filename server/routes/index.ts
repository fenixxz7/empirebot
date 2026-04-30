import type { Express } from "express";
import { instancesRouter } from "./instances.js";
import { configRouter } from "./config.js";
import { orgsRouter } from "./orgs.js";
import { logsRouter } from "./logs.js";
import { discoveryRouter } from "./discovery.js";
import { statsRouter } from "./stats.js";
import { pool } from "../db/pool.js";

export function mountApi(app: Express): void {
  app.use("/api/instances", instancesRouter);
  app.use("/api/config", configRouter);
  app.use("/api/orgs", orgsRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/discovery", discoveryRouter);
  app.use("/api/stats", statsRouter);

  // Health check para monitoramento externo
  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: "ok", ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: "error", ts: new Date().toISOString() });
    }
  });
}
