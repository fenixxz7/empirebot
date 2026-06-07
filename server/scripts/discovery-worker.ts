import "dotenv/config";
import { discoverOrg } from "../discord/discovery.js";
import { query, pool } from "../db/pool.js";

interface OrgInput {
  id: number;
  name: string;
  guild_id: string;
}

interface WorkerInput {
  token: string;
  instanceId: number;
  orgs: OrgInput[];
}

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
      // Emite JSON para o processo pai repassar via WebSocket
      process.stdout.write(
        JSON.stringify({ id: row.id, ts: row.ts, level, source, message }) + "\n",
      );
    }
  } catch { /* noop */ }
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let input: WorkerInput;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("[discovery-worker] invalid JSON input");
    process.exit(1);
  }

  const { token, instanceId, orgs } = input;

  for (const o of orgs) {
    try {
      const r = await discoverOrg(token, o.id, o.guild_id);
      if (r.ok) {
        await query(`UPDATE orgs SET last_discovered_at = NOW() WHERE id = $1`, [o.id]);
        await log(
          instanceId,
          "INFO",
          "discovery",
          `${o.name}: ${r.channels_found} ${r.channels_found === 1 ? "canal" : "canais"} escaneado(s), ${r.queues_saved} fila(s) cadastradas`,
        );
      } else {
        await log(instanceId, "ERROR", "discovery", `${o.name}: falha (${r.error ?? "erro"})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(instanceId, "ERROR", "discovery", `${o.name}: exceção — ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  try { await pool.end(); } catch { /* noop */ }
}

main().catch((err) => {
  console.error("[discovery-worker] fatal:", err);
  process.exit(1);
});
