import type { Express, Request, Response, NextFunction } from "express";
import { instancesRouter } from "./instances.js";
import { configRouter } from "./config.js";
import { orgsRouter } from "./orgs.js";
import { logsRouter } from "./logs.js";
import { discoveryRouter } from "./discovery.js";
import { statsRouter } from "./stats.js";
import { authRouter } from "./auth.js";
import { tokensRouter } from "./tokens.js";
import { blacklistRouter } from "./blacklist.js";
import { sendErrorsRouter } from "./send-errors.js";
import { messageOverridesRouter } from "./message-overrides.js";
import { accountsRouter } from "./accounts.js";
import { orgJoinerRouter } from "./org-joiner.js";
import { pool, query as dbQuery } from "../db/pool.js";
import { query } from "../db/pool.js";
import { requireAdmin } from "./auth.js";
import { asyncHandler } from "../lib/asyncHandler.js";

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

function requireApiKeyOrAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"];
  const adminPass = process.env.ADMIN_PASSWORD;
  if (apiKey && adminPass && apiKey === adminPass) {
    return next();
  }
  return requireAuth(req, res, next);
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

  // Rota para apps externos (ex: Empire DMS) — autenticada via X-API-Key ou sessão
  // Retorna tokens conectados com valor completo, opcionalmente filtrados por instância
  app.get("/api/tokens/connected", requireApiKeyOrAuth, asyncHandler(async (req, res) => {
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

    let rows: {
      id: number; label: string | null; value: string;
      status: string; username: string | null;
      instance_id: number | null; instance_name: string | null;
    }[];

    if (instanceId) {
      rows = await dbQuery<typeof rows[number]>(
        `SELECT tp.id, tp.label, tp.value, tp.status, tp.username,
                i.id AS instance_id, i.name AS instance_name
         FROM token_pool tp
         INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
         INNER JOIN instances i ON i.id = its.instance_id
         WHERE its.instance_id = $1
           AND tp.status = 'connected'
         ORDER BY its.position ASC`,
        [instanceId],
      );
    } else {
      rows = await dbQuery<typeof rows[number]>(
        `SELECT tp.id, tp.label, tp.value, tp.status, tp.username,
                i.id AS instance_id, i.name AS instance_name
         FROM token_pool tp
         INNER JOIN instance_token_selection its ON its.token_pool_id = tp.id
         INNER JOIN instances i ON i.id = its.instance_id
         WHERE tp.status = 'connected'
         ORDER BY i.id ASC, its.position ASC`,
      );
    }

    res.json(rows.map((t) => ({
      id: t.id,
      label: t.label,
      value: t.value,
      status: t.status,
      username: t.username,
      instance_id: t.instance_id,
      instance_name: t.instance_name,
    })));
  }));

  // Rota de revelar token — registrada diretamente antes do router genérico
  app.get("/api/tokens/:id/value", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rows = await dbQuery<{ value: string }>(`SELECT value FROM token_pool WHERE id = $1`, [id]);
    if (!rows[0]) { res.status(404).json({ error: "Token não encontrado." }); return; }
    res.json({ value: rows[0].value });
  }));

  // Todas as rotas abaixo exigem autenticação
  app.use("/api/instances", requireAuth, instancesRouter);
  app.use("/api/config", requireAuth, configRouter);
  app.use("/api/orgs", requireAuth, orgsRouter);
  app.use("/api/logs", requireAuth, logsRouter);
  app.use("/api/discovery", requireAuth, discoveryRouter);
  app.use("/api/stats", requireAuth, statsRouter);
  app.use("/api/tokens", requireAuth, tokensRouter);
  app.use("/api/instances/:id/blacklist", requireAuth, blacklistRouter);
  app.use("/api/instances/:id/send-errors", requireAuth, sendErrorsRouter);
  app.use("/api/instances/:id/message-overrides", requireAuth, messageOverridesRouter);
  app.use("/api/accounts", requireAuth, accountsRouter);
  app.use("/api/org-joiner", requireAuth, orgJoinerRouter);
}
