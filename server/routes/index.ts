import type { Express, Request, Response, NextFunction } from "express";
import { instancesRouter } from "./instances.js";
import { configRouter } from "./config.js";
import { orgsRouter } from "./orgs.js";
import { logsRouter } from "./logs.js";
import { discoveryRouter } from "./discovery.js";
import { statsRouter } from "./stats.js";
import { messagesRouter } from "./messages.js";
import { authRouter } from "./auth.js";
import { tokensRouter } from "./tokens.js";
import { blacklistRouter } from "./blacklist.js";
import { sendErrorsRouter } from "./send-errors.js";
import { messageOverridesRouter } from "./message-overrides.js";
import { pool } from "../db/pool.js";
import { query } from "../db/pool.js";

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = req.session as any;
  if (!session?.authenticated) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  if (session.access_key_id) {
    query<{ force_logout_at: string | null; expires_at: string | null }>(
      `SELECT force_logout_at, expires_at FROM access_keys WHERE id = $1`,
      [session.access_key_id]
    ).then(rows => {
      const key = rows[0];
      const loggedInAt = new Date(session.logged_in_at);
      const isForceLoggedOut = key && key.force_logout_at && new Date(key.force_logout_at) > loggedInAt;
      const isExpired = key && key.expires_at && new Date(key.expires_at) < new Date();
      if (!key || isForceLoggedOut || isExpired) {
        req.session.destroy(() => {});
        res.status(401).json({ error: "Sessão encerrada pelo administrador." });
        return;
      }
      next();
    }).catch(() => next());
    return;
  }

  next();
}

export function mountApi(app: Express): void {
  // Auth routes — públicas, sem proteção
  app.use("/api/auth", authRouter);

  // Health check — público
  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: "ok", ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: "error", ts: new Date().toISOString() });
    }
  });

  // Todas as rotas abaixo exigem autenticação
  app.use("/api/instances", requireAuth, instancesRouter);
  app.use("/api/config", requireAuth, configRouter);
  app.use("/api/orgs", requireAuth, orgsRouter);
  app.use("/api/logs", requireAuth, logsRouter);
  app.use("/api/discovery", requireAuth, discoveryRouter);
  app.use("/api/stats", requireAuth, statsRouter);
  app.use("/api/messages", requireAuth, messagesRouter);
  app.use("/api/tokens", requireAuth, tokensRouter);
  app.use("/api/instances/:id/blacklist", requireAuth, blacklistRouter);
  app.use("/api/instances/:id/send-errors", requireAuth, sendErrorsRouter);
  app.use("/api/instances/:id/message-overrides", requireAuth, messageOverridesRouter);
}
