import "dotenv/config";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "./db/init.js";
import { mountApi } from "./routes/index.js";
import { query } from "./db/pool.js";
import { manager } from "./worker/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5000);
const isProd = process.env.NODE_ENV === "production";

async function main() {
  await initDatabase();

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
