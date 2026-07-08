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

async function recordAudit(action: string, opts: {
  access_key_label?: string;
  access_key_id?: number;
  ip?: string;
  detail?: string;
}) {
  await query(
    `INSERT INTO audit_logs (action, access_key_label, access_key_id, ip, detail) VALUES ($1,$2,$3,$4,$5)`,
    [action, opts.access_key_label ?? null, opts.access_key_id ?? null, opts.ip ?? null, opts.detail ?? null]
  );
}

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const adminPass = process.env.ADMIN_PASSWORD;
  const ip = getClientIp(req);

  if (!adminPass) {
    res.status(500).json({ error: "ADMIN_PASSWORD não configurada no servidor." });
    return;
  }

  if (username === "admin" && password === adminPass) {
    (req.session as any).authenticated = true;
    (req.session as any).is_admin = true;
    await recordAudit("login_admin", { ip });
    res.json({ ok: true });
    return;
  }

  const keys = await query<{ id: number; label: string; expires_at: string | null; allowed_instance_ids: number[] | null }>(
    `SELECT id, label, expires_at, allowed_instance_ids FROM access_keys WHERE password = $1`,
    [password ?? ""]
  );

  if (keys.length > 0) {
    const key = keys[0]!;

    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      await recordAudit("login_expired", { access_key_id: key.id, access_key_label: key.label, ip });
      res.status(401).json({ error: "Este acesso expirou." });
      return;
    }

    const now = new Date();
    (req.session as any).authenticated = true;
    (req.session as any).is_admin = false;
    (req.session as any).access_key_id = key.id;
    (req.session as any).logged_in_at = now.toISOString();
    (req.session as any).allowedInstanceIds = key.allowed_instance_ids ?? null;

    await query(`INSERT INTO access_key_logins (access_key_id, ip) VALUES ($1, $2)`, [key.id, ip]);
    await recordAudit("login", { access_key_id: key.id, access_key_label: key.label, ip });

    res.json({ ok: true });
    return;
  }

  await recordAudit("login_failed", { ip, detail: `username: ${username ?? ""}` });
  res.status(401).json({ error: "Usuário ou senha incorretos." });
}));

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

authRouter.get("/check", asyncHandler(async (req, res) => {
  const session = req.session as any;
  if (!session?.authenticated) {
    res.json({ authenticated: false, is_admin: false, restricted: false });
    return;
  }

  if (session.access_key_id) {
    const rows = await query<{ force_logout_at: string | null; expires_at: string | null; allowed_instance_ids: number[] | null }>(
      `SELECT force_logout_at, expires_at, allowed_instance_ids FROM access_keys WHERE id = $1`,
      [session.access_key_id]
    );
    const key = rows[0];
    const loggedInAt = new Date(session.logged_in_at);
    const isForceLoggedOut = key && key.force_logout_at && new Date(key.force_logout_at) > loggedInAt;
    const isExpired = key && key.expires_at && new Date(key.expires_at) < new Date();

    if (!key || isForceLoggedOut || isExpired) {
      req.session.destroy(() => {});
      res.json({ authenticated: false, is_admin: false, restricted: false });
      return;
    }

    // restricted = true quando o acesso tem instâncias limitadas (ex: usuário morcego)
    const restricted = Array.isArray(key.allowed_instance_ids) && key.allowed_instance_ids.length > 0;
    res.json({ authenticated: true, is_admin: false, restricted });
    return;
  }

  res.json({ authenticated: !!session?.authenticated, is_admin: !!session?.is_admin, restricted: false });
}));

authRouter.get("/access-keys", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<{
    id: number; label: string; created_at: string;
    force_logout_at: string | null; expires_at: string | null;
    allowed_instance_ids: number[] | null; is_permanent: boolean;
  }>(
    `SELECT id, label, created_at, force_logout_at, expires_at, allowed_instance_ids, is_permanent
     FROM access_keys ORDER BY created_at DESC`
  );
  res.json(rows);
}));

authRouter.post("/access-keys", requireAdmin, asyncHandler(async (req, res) => {
  const { label, password, expires_at, allowed_instance_ids } = req.body as {
    label?: string; password?: string; expires_at?: string | null;
    allowed_instance_ids?: number[] | null;
  };
  const ip = getClientIp(req);

  if (!label?.trim()) {
    res.status(400).json({ error: "Informe um rótulo para identificar o acesso." });
    return;
  }
  if (!password?.trim() || password.trim().length < 4) {
    res.status(400).json({ error: "A senha deve ter ao menos 4 caracteres." });
    return;
  }

  const expiresAt = expires_at ? new Date(expires_at) : null;
  if (expiresAt && isNaN(expiresAt.getTime())) {
    res.status(400).json({ error: "Data de expiração inválida." });
    return;
  }

  const allowedIds = Array.isArray(allowed_instance_ids) && allowed_instance_ids.length > 0
    ? allowed_instance_ids
    : null;

  const rows = await query<{ id: number }>(
    `INSERT INTO access_keys (label, password, expires_at, allowed_instance_ids)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [label.trim(), password.trim(), expiresAt ?? null, allowedIds]
  );

  const newId = rows[0]!.id;
  await recordAudit("create", {
    access_key_id: newId,
    access_key_label: label.trim(),
    ip,
    detail: expiresAt ? `expira em ${expiresAt.toISOString()}` : "sem expiração",
  });

  res.json({ ok: true, id: newId });
}));

authRouter.patch("/access-keys/:id", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const ip = getClientIp(req);
  const { password, allowed_instance_ids } = req.body as {
    password?: string; allowed_instance_ids?: number[] | null;
  };

  const existing = await query<{ label: string; is_permanent: boolean }>(
    `SELECT label, is_permanent FROM access_keys WHERE id = $1`, [id]
  );
  if (!existing[0]) { res.status(404).json({ error: "Acesso não encontrado." }); return; }

  const fields: string[] = [];
  const params: unknown[] = [];

  if (password !== undefined) {
    if (!password.trim() || password.trim().length < 4) {
      res.status(400).json({ error: "A senha deve ter ao menos 4 caracteres." }); return;
    }
    params.push(password.trim());
    fields.push(`password = ${params.length}`);
  }

  if (allowed_instance_ids !== undefined) {
    const allowedIds = Array.isArray(allowed_instance_ids) && allowed_instance_ids.length > 0
      ? allowed_instance_ids
      : null;
    params.push(allowedIds);
    fields.push(`allowed_instance_ids = ${params.length}`);
  }

  if (fields.length === 0) {
    res.status(400).json({ error: "Nenhum campo para atualizar." }); return;
  }

  params.push(id);
  await query(`UPDATE access_keys SET ${fields.join(", ")} WHERE id = ${params.length}`, params);
  await recordAudit("update", { access_key_id: id, access_key_label: existing[0].label, ip });
  res.json({ ok: true });
}));

authRouter.delete("/access-keys/:id", requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const ip = getClientIp(req);
  const rows = await query<{ label: string; is_permanent: boolean }>(
    `SELECT label, is_permanent FROM access_keys WHERE id = $1`, [id]
  );
  if (!rows[0]) { res.status(404).json({ error: "Acesso não encontrado." }); return; }
  if (rows[0].is_permanent) {
    res.status(403).json({ error: "Este acesso é permanente e não pode ser removido." });
    return;
  }
  const label = rows[0].label;
  await query(`DELETE FROM access_keys WHERE id = $1`, [id]);
  await recordAudit("revoke", { access_key_id: id, access_key_label: label, ip });
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
  const ip = getClientIp(req);
  const rows = await query<{ label: string }>(`SELECT label FROM access_keys WHERE id = $1`, [id]);
  const label = rows[0]?.label ?? "desconhecido";
  await query(`UPDATE access_keys SET force_logout_at = NOW() WHERE id = $1`, [id]);
  await recordAudit("force_logout", { access_key_id: id, access_key_label: label, ip });
  res.json({ ok: true });
}));

authRouter.get("/audit-logs", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<{
    id: number;
    action: string;
    access_key_label: string | null;
    access_key_id: number | null;
    ip: string | null;
    detail: string | null;
    performed_at: string;
  }>(
    `SELECT id, action, access_key_label, access_key_id, ip, detail, performed_at
     FROM audit_logs ORDER BY performed_at DESC LIMIT 200`
  );
  res.json(rows);
}));
