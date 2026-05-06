import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const authRouter = Router();

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any)?.is_admin) return next();
  res.status(403).json({ error: "Acesso restrito ao administrador." });
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return ip?.trim() ?? req.ip ?? "desconhecido";
  }
  return req.ip ?? "desconhecido";
}

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    res.status(500).json({ error: "ADMIN_PASSWORD não configurada no servidor." });
    return;
  }

  if (username === "admin" && password === adminPass) {
    (req.session as any).authenticated = true;
    (req.session as any).is_admin = true;
    res.json({ ok: true });
    return;
  }

  const keys = await query<{ id: number }>(
    `SELECT id FROM access_keys WHERE password = $1`,
    [password ?? ""]
  );
  if (keys.length > 0) {
    const keyId = keys[0]!.id;
    const now = new Date();
    (req.session as any).authenticated = true;
    (req.session as any).is_admin = false;
    (req.session as any).access_key_id = keyId;
    (req.session as any).logged_in_at = now.toISOString();

    const ip = getClientIp(req);
    await query(
      `INSERT INTO access_key_logins (access_key_id, ip) VALUES ($1, $2)`,
      [keyId, ip]
    );

    res.json({ ok: true });
    return;
  }

  res.status(401).json({ error: "Usuário ou senha incorretos." });
}));

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

authRouter.get("/check", asyncHandler(async (req, res) => {
  const session = req.session as any;
  if (!session?.authenticated) {
    res.json({ authenticated: false, is_admin: false });
    return;
  }

  if (session.access_key_id) {
    const rows = await query<{ force_logout_at: string | null }>(
      `SELECT force_logout_at FROM access_keys WHERE id = $1`,
      [session.access_key_id]
    );
    const key = rows[0];
    if (!key || (key.force_logout_at && new Date(key.force_logout_at) > new Date(session.logged_in_at))) {
      req.session.destroy(() => {});
      res.json({ authenticated: false, is_admin: false });
      return;
    }
  }

  res.json({
    authenticated: !!session?.authenticated,
    is_admin: !!session?.is_admin,
  });
}));

authRouter.get("/access-keys", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<{ id: number; label: string; created_at: string; force_logout_at: string | null }>(
    `SELECT id, label, created_at, force_logout_at FROM access_keys ORDER BY created_at DESC`
  );
  res.json(rows);
}));

authRouter.post("/access-keys", requireAdmin, asyncHandler(async (req, res) => {
  const { label, password } = req.body as { label?: string; password?: string };
  if (!label?.trim()) {
    res.status(400).json({ error: "Informe um rótulo para identificar o acesso." });
    return;
  }
  if (!password?.trim() || password.trim().length < 4) {
    res.status(400).json({ error: "A senha deve ter ao menos 4 caracteres." });
    return;
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO access_keys (label, password) VALUES ($1, $2) RETURNING id`,
    [label.trim(), password.trim()]
  );
  res.json({ ok: true, id: rows[0]!.id });
}));

authRouter.delete("/access-keys/:id", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM access_keys WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

authRouter.get("/access-keys/:id/logins", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query<{ ip: string; logged_in_at: string }>(
    `SELECT ip, logged_in_at FROM access_key_logins WHERE access_key_id = $1 ORDER BY logged_in_at DESC LIMIT 50`,
    [id]
  );
  res.json(rows);
}));

authRouter.post("/access-keys/:id/force-logout", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await query(`UPDATE access_keys SET force_logout_at = NOW() WHERE id = $1`, [id]);
  res.json({ ok: true });
}));
