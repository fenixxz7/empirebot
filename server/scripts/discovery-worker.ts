import "dotenv/config";
import { discoverOrg, isPermanentAccessError } from "../discord/discovery.js";
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

  // Resolve o token_id da tabela `tokens` pelo valor — necessário para a blacklist
  const tokenRows = await query<{ id: number }>(
    `SELECT id FROM tokens WHERE value = $1 LIMIT 1`,
    [token],
  );
  const tokenId = tokenRows[0]?.id ?? null;

  for (const o of orgs) {
    // Verifica se esta org já está na blacklist para este token
    if (tokenId !== null) {
      const bl = await query<{ blocked_at: string }>(
        `SELECT blocked_at FROM token_org_blacklist WHERE token_id = $1 AND org_id = $2`,
        [tokenId, o.id],
      );
      if (bl.length > 0) {
        await log(
          instanceId,
          "INFO",
          "discovery",
          `${o.name}: pulada — já na blacklist deste token`,
        );
        continue;
      }
    }

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
      } else if (isPermanentAccessError(r.error)) {
        // Sem acesso (50001) — adiciona à blacklist e NÃO seta last_discovered_at
        if (tokenId !== null) {
          try {
            await query(
              `INSERT INTO token_org_blacklist (token_id, org_id, reason)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [tokenId, o.id, "discovery: sem acesso (50001)"],
            );
          } catch { /* FK violation: token_id não existe mais */ }
        }
        await log(
          instanceId,
          "WARN",
          "discovery",
          `${o.name}: sem acesso (50001)${tokenId ? " — adicionada à blacklist do token atual" : ""}`,
        );
      } else if (r.was_rate_limited) {
        // Rate limit — não marca last_discovered_at, retry na próxima rodada
        await log(
          instanceId,
          "WARN",
          "discovery",
          `${o.name}: rate limit (429) — será tentada novamente`,
        );
      } else {
        await log(
          instanceId,
          "ERROR",
          "discovery",
          `${o.name}: falha (${r.error ?? "erro desconhecido"})`,
        );
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
