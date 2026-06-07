import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { manager } from "../worker/manager.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "..", "scripts", "discovery-worker.ts");
const TSX_BIN = path.join(__dirname, "..", "..", "node_modules", ".bin", "tsx");

export const discoveryRouter = Router();

discoveryRouter.post("/:instanceId", asyncHandler(async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const orgIds = Array.isArray(req.body?.org_ids)
    ? (req.body.org_ids as number[]).map(Number)
    : null;

  const tokens = await query<{ value: string }>(
    `SELECT tp.value
     FROM instance_token_selection its
     JOIN token_pool tp ON tp.id = its.token_pool_id
     WHERE its.instance_id = $1 AND tp.status = 'connected'
     ORDER BY its.position ASC LIMIT 1`,
    [instanceId],
  );
  const token = tokens[0]?.value;
  if (!token) {
    await log(
      instanceId,
      "ERROR",
      "discovery",
      "Nenhum token conectado — inicie o bot antes de descobrir canais",
    );
    return res
      .status(400)
      .json({ error: "Nenhum token conectado para fazer a descoberta" });
  }

  const orgs = await query<{ id: number; name: string; guild_id: string | null }>(
    orgIds && orgIds.length > 0
      ? `SELECT o.id, o.name, o.guild_id FROM orgs o
         JOIN UNNEST($1::int[]) u(id) ON u.id = o.id
         WHERE o.guild_id IS NOT NULL AND o.guild_id <> ''`
      : `SELECT o.id, o.name, o.guild_id FROM orgs o
         JOIN instance_orgs io ON io.org_id = o.id
         WHERE io.instance_id = $1
           AND o.guild_id IS NOT NULL AND o.guild_id <> ''`,
    orgIds && orgIds.length > 0 ? [orgIds] : [instanceId],
  );

  if (orgs.length === 0) {
    await log(
      instanceId,
      "WARN",
      "discovery",
      "Nenhuma org com guild_id preenchido para descobrir",
    );
    return res
      .status(400)
      .json({ error: "Nenhuma org selecionada tem guild_id preenchido" });
  }

  // Reseta last_discovered_at das orgs que serão varridas
  await query(
    `UPDATE orgs SET last_discovered_at = NULL WHERE id = ANY($1::int[])`,
    [orgs.map((o) => o.id)],
  );

  // Pausa o motor de cliques enquanto a varredura roda
  const runnerRunning = manager.isRunning(instanceId);
  if (runnerRunning) {
    manager.pauseRunner(instanceId);
    await log(instanceId, "INFO", "discovery", "Cliques pausados durante redescoberta…");
  }

  await log(
    instanceId,
    "INFO",
    "discovery",
    `Iniciando descoberta de ${orgs.length} org(s) em processo separado…`,
  );

  // Responde imediatamente — discovery roda em processo filho para não travar o servidor
  res.json({ ok: true, started: true, count: orgs.length });

  // Spawn do worker com limite de memória próprio (256 MB), isolado do servidor principal
  const workerEnv = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=256",
  };

  const worker = spawn(TSX_BIN, [WORKER_PATH], {
    env: workerEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const payload = JSON.stringify({
    token,
    instanceId,
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, guild_id: o.guild_id! })),
  });

  worker.stdin.write(payload);
  worker.stdin.end();

  worker.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error("[discovery-worker stderr]", text);
  });

  worker.on("close", async (code, signal) => {
    const exitDesc = signal ? `sinal ${signal}` : `código ${code ?? "?"}`;
    if (code !== 0) {
      await log(
        instanceId,
        "ERROR",
        "discovery",
        `Processo de descoberta encerrado inesperadamente (${exitDesc}). Verifique os logs acima.`,
      );
    } else {
      await log(instanceId, "INFO", "discovery", "Descoberta concluída.");
    }

    if (runnerRunning) {
      manager.resumeRunner(instanceId);
      await log(instanceId, "INFO", "discovery", "Cliques retomados.");
    }
  });

  worker.on("error", async (err) => {
    console.error("[discovery-worker] erro ao iniciar:", err);
    await log(instanceId, "ERROR", "discovery", `Falha ao iniciar worker: ${err.message}`);
    if (runnerRunning) manager.resumeRunner(instanceId);
  });
}));

async function log(
  instanceId: number,
  level: string,
  source: string,
  message: string,
) {
  try {
    await query(
      `INSERT INTO logs (instance_id, level, source, message)
       VALUES ($1, $2, $3, $4)`,
      [instanceId, level, source, message],
    );
  } catch {
    /* noop */
  }
}
