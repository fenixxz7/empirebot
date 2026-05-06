import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const authRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any)?.is_admin) return next();
  res.status(403).json({ error: "Acesso restrito ao administrador." });
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
    (req.session as any).authenticated = true;
    (req.session as any).is_admin = false;
    res.json({ ok: true });
    return;
  }

  res.status(401).json({ error: "Usuário ou senha incorretos." });
}));

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

authRouter.get("/check", (req, res) => {
  const session = req.session as any;
  res.json({
    authenticated: !!session?.authenticated,
    is_admin: !!session?.is_admin,
  });
});

authRouter.get("/access-keys", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<{ id: number; label: string; created_at: string }>(
    `SELECT id, label, created_at FROM access_keys ORDER BY created_at DESC`
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
