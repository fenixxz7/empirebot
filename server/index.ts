import "dotenv/config";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { initDatabase } from "./db/init.js";
import { mountApi } from "./routes/index.js";
import { query } from "./db/pool.js";
import { manager, setWsServer, dmResponders } from "./worker/manager.js";
import { DmResponder } from "./engine/dm-responder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5000);
const isProd = process.env.NODE_ENV === "production";

async function main() {
  await initDatabase();

  // Inicializa um DmResponder por instância (roda independente do bot principal)
  {
    const allInstances = await query<{ id: number }>(`SELECT id FROM instances`);
    for (const inst of allInstances) {
      const responder = new DmResponder(inst.id);
      dmResponders.set(inst.id, responder);
    }
    const enabledCfg = await query<{ instance_id: number }>(
      `SELECT instance_id FROM dm_config WHERE enabled = TRUE`
    );
    for (const cfg of enabledCfg) {
      dmResponders.get(cfg.instance_id)?.start();
    }
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Cache busting in dev so the user always sees fresh content
  if (!isProd) {
    app.use((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  }

  mountApi(app);

  const httpServer = createHttpServer(app);

  // WebSocket server — /ws/:instanceId
  const wss = new WebSocketServer({ noServer: true });
  setWsServer(wss);

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const m = url.match(/^\/ws\/(\d+)$/);
    if (!m) return; // Let Vite (HMR) handle other upgrade requests
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
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.join(__dirname, "..", "vite.config.ts"),
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: { server: httpServer },
      },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      try {
        const url = req.originalUrl;
        const indexPath = path.join(__dirname, "..", "index.html");
        const { readFileSync } = await import("node:fs");
        let html = readFileSync(indexPath, "utf8");
        html = await vite.transformIndexHtml(url, html);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (e) {
        next(e);
      }
    });
  }

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
  setInterval(rotateLogs, 6 * 60 * 60 * 1000);

  httpServer.listen(PORT, "0.0.0.0", async () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);

    // Se o servidor reiniciou enquanto alguma instância estava marcada como
    // "rodando", religa os workers automaticamente.
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
