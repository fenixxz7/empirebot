import { Router } from "express";
import { query } from "../db/pool.js";
import { discoverOrg, type DiscoveryResult } from "../discord/discovery.js";

export const discoveryRouter = Router();

discoveryRouter.post("/:instanceId", async (req, res) => {
  const instanceId = Number(req.params.instanceId);
  const orgIds = Array.isArray(req.body?.org_ids)
    ? (req.body.org_ids as number[]).map(Number)
    : null;

  const tokens = await query<{ value: string }>(
    `SELECT value FROM tokens
     WHERE instance_id = $1 AND status = 'connected'
     ORDER BY position ASC LIMIT 1`,
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

  await log(
    instanceId,
    "INFO",
    "discovery",
    `Iniciando descoberta de ${orgs.length} org(s)…`,
  );

  const results: DiscoveryResult[] = [];
  for (const o of orgs) {
    try {
      const r = await discoverOrg(token, o.id, o.guild_id!);
      results.push(r);
      if (r.ok) {
        await log(
          instanceId,
          "INFO",
          "discovery",
          `${o.name}: ${r.channels_found} ${r.channels_found === 1 ? "canal" : "canais"} escaneado(s), ${r.queues_saved} fila(s) cadastradas`,
        );
      } else {
        await log(
          instanceId,
          "ERROR",
          "discovery",
          `${o.name}: falha (${r.error ?? "erro"})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        ok: false,
        org_id: o.id,
        guild_id: o.guild_id ?? "",
        channels_found: 0,
        queues_saved: 0,
        error: msg,
      });
      await log(
        instanceId,
        "ERROR",
        "discovery",
        `${o.name}: exceção — ${msg}`,
      );
    }
  }

  await log(instanceId, "INFO", "discovery", "Descoberta concluída");
  res.json({ ok: true, results });
});

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
