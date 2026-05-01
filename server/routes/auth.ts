import { Router } from "express";

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    res.status(500).json({ error: "ADMIN_PASSWORD não configurada no servidor." });
    return;
  }

  if (username === "admin" && password === adminPass) {
    (req.session as any).authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Usuário ou senha incorretos." });
  }
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

authRouter.get("/check", (req, res) => {
  res.json({ authenticated: !!(req.session as any)?.authenticated });
});
