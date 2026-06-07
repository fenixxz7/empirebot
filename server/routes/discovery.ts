import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { manager, broadcastRawLog } from "../worker/manager.js";
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

  // Pega qualquer token da instância — prefere 'connected', aceita qualquer um.
  // Isso permite rodar a discovery mesmo com o bot pausado/parado.
  const tokens = await query<{ value: string }>(
    `SELECT tp.value
     FROM instance_token_selection its
     JOIN token_pool tp ON tp.id = its.token_pool_id
     WHERE its.instance_id = $1
     ORDER BY
       CASE WHEN tp.status = 'connected' THEN 0 ELSE 1 END,
       its.position ASC
     LIMIT 1`,
    [instanceId],
  );
  const token = tokens[0]?.value;
  if (!token) {
    await log(
      instanceId,
      "ERROR",
      "discovery",
      "Nenhum token cadastrado — adicione ao menos um token antes de descobrir canais",
    );
    return res
      .status(400)
      .json({ error: "Nenhum token cadastrado para esta instância" });
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

  // Pausa o motor de cliques enquanto a varredura roda (se estiver rodando)
  const runnerRunning = manager.isRunning(instanceId);
  if (runnerRunning) {
    manager.pauseRunner(instanceId);
    await log(instanceId, "INFO", "discovery", "Cliques pausados durante redescoberta…");
  }

  await log(
    instanceId,
    "INFO",
    "discovery",
    `Iniciando descoberta de ${orgs.length} org(s)…`,
  );

  res.json({ ok: true, started: true, count: orgs.length });

  // Spawn do worker com limite de memória próprio (256 MB)
  const workerEnv = { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" };
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

  // Repassa cada linha JSON do worker diretamente para o WebSocket do painel
  let buf = "";
  worker.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const entry = JSON.parse(t) as {
          id: number; ts: string; level: string; source: string; message: string;
        };
        broadcastRawLog(instanceId, entry);
      } catch { /* linha não-JSON, ignora */ }
    }
  });

  worker.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error("[discovery-worker stderr]", text);
  });

  worker.on("close", async (code, signal) => {
    if (code !== 0) {
      const exitDesc = signal ? `sinal ${signal}` : `código ${code ?? "OOM"}`;
      await log(
        instanceId,
        "ERROR",
        "discovery",
        `Processo de descoberta encerrado inesperadamente (${exitDesc}).`,
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

async function log(instanceId: number, level: string, source: string, message: string) {
  try {
    const rows = await query<{ id: number; ts: string }>(
      `INSERT INTO logs (instance_id, level, source, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, to_char(ts AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS') AS ts`,
      [instanceId, level, source, message],
    );
    const row = rows[0];
    if (row) {
      broadcastRawLog(instanceId, { id: row.id, ts: row.ts, level, source, message });
    }
  } catch { /* noop */ }
}
