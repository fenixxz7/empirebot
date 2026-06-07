import "dotenv/config";
import express from "express";
import session from "express-session";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { initDatabase } from "./db/init.js";
import { mountApi } from "./routes/index.js";
import { query } from "./db/pool.js";
import { manager, setWsServer } from "./worker/manager.js";
import { errorMiddleware } from "./lib/asyncHandler.js";
import { SESSION_COOKIE_MAX_AGE_MS, LOG_ROTATION_INTERVAL_MS } from "./lib/timings.js";
import { startHealthMonitor } from "./engine/auto-rotator.js";
import { startWatchdog } from "./engine/watchdog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
// Em dev, Express roda na 5001 (Vite roda na 5000 e faz proxy para cá).
// Em produção, roda direto na 5000 servindo os arquivos buildados.
const PORT = isProd ? Number(process.env.PORT ?? 5000) : 5001;

async function main() {
  await initDatabase();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const SESSION_SECRET = process.env.SESSION_SECRET ?? "empirebotdev_secret_change_me";
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      sameSite: "lax",
    },
  }));

  if (!isProd) {
    app.use((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  }

  mountApi(app);

  app.use(errorMiddleware);

  const httpServer = createHttpServer(app);

  // WebSocket server — /ws/:instanceId
  const wss = new WebSocketServer({ noServer: true });
  setWsServer(wss);

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const m = url.match(/^\/ws\/(\d+)$/);
    if (!m) { socket.destroy(); return; }
    const instanceId = Number(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, instanceId);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: unknown, instanceId: number) => {
    (ws as any).__instanceId = instanceId;
    ws.on("error", () => {/* noop */});
  });

  if (isProd) {
    const distPath = path.join(__dirname, "..", "dist");
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  // Em dev, o Vite roda em processo separado e serve o frontend.
  // Não há middleware Vite aqui — isso libera ~250 MB de RAM para o servidor.

  // Rotação de logs: remove registros com mais de 7 dias, roda a cada 6h
  async function rotateLogs() {
    try {
      const r = await query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM logs WHERE ts < NOW() - INTERVAL '7 days' RETURNING id
         ) SELECT COUNT(*)::text AS count FROM deleted`
      );
      const n = Number(r[0]?.count ?? "0");
      if (n > 0) console.log(`[logs] rotação: ${n} registro(s) removido(s)`);
    } catch (err) {
      console.error("[logs] erro na rotação:", err);
    }
  }
  rotateLogs();
  setInterval(rotateLogs, LOG_ROTATION_INTERVAL_MS);

  startHealthMonitor(30_000);
  startWatchdog(60_000);

  httpServer.listen(PORT, "0.0.0.0", async () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);

    try {
      const running = await query<{ id: number }>(
        `SELECT id FROM instances WHERE running = TRUE`
      );
      for (const r of running) {
        manager.start(r.id).catch((err) =>
          console.error("[manager.start/boot]", err),
        );
      }
      if (running.length > 0) {
        console.log(`[server] reativando workers de ${running.length} instância(s)`);
      }
    } catch (err) {
      console.error("[server] erro ao reativar workers:", err);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
