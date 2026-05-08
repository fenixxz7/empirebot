import { Router } from "express";
import { query } from "../db/pool.js";

export const statsRouter = Router();

function periodFilter(alias: string, period: string): string {
  switch (period) {
    case "today":
      return `AND ${alias} >= NOW() AT TIME ZONE 'America/Sao_Paulo' - INTERVAL '1 day'`;
    case "week":
      return `AND ${alias} >= NOW() - INTERVAL '7 days'`;
    case "month":
      return `AND ${alias} >= NOW() - INTERVAL '30 days'`;
    default:
      return "";
  }
}

statsRouter.get("/orgs", async (req, res) => {
  try {
    const period = String(req.query.period ?? "week");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;

    const instanceFilter = instanceId ? `AND instance_id = ${instanceId}` : "";
    const joinFilter = periodFilter("joined_at", period);
    const matchFilter = periodFilter("detected_at", period);

    const entriesRows = await query<{
      org_name: string;
      entradas: string;
    }>(
      `SELECT COALESCE(org_name, 'Desconhecida') AS org_name,
              COUNT(*)::text AS entradas
       FROM queue_joins
       WHERE 1=1 ${instanceFilter} ${joinFilter}
       GROUP BY org_name
       ORDER BY COUNT(*) DESC`,
      [],
    );

    const matchRows = await query<{
      org_name: string;
      partidas: string;
    }>(
      `SELECT COALESCE(org_name, 'Desconhecida') AS org_name,
              COUNT(*)::text AS partidas
       FROM matches
       WHERE msg_sent = TRUE ${instanceFilter} ${matchFilter}
       GROUP BY org_name
       ORDER BY COUNT(*) DESC`,
      [],
    );

    const map = new Map<string, { org_name: string; entradas: number; partidas: number }>();

    for (const r of entriesRows) {
      map.set(r.org_name, { org_name: r.org_name, entradas: Number(r.entradas), partidas: 0 });
    }
    for (const r of matchRows) {
      const existing = map.get(r.org_name);
      if (existing) {
        existing.partidas = Number(r.partidas);
      } else {
        map.set(r.org_name, { org_name: r.org_name, entradas: 0, partidas: Number(r.partidas) });
      }
    }

    const result = [...map.values()].sort((a, b) => b.entradas - a.entradas);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

statsRouter.get("/timeseries", async (req, res) => {
  try {
    const period = String(req.query.period ?? "today");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    const instanceFilter = instanceId ? `AND instance_id = ${instanceId}` : "";

    if (period === "today") {
      // Entradas por hora nas últimas 24h
      const rows = await query<{ hour: string; entradas: string; partidas: string }>(
        `SELECT
           date_trunc('hour', joined_at AT TIME ZONE 'America/Sao_Paulo') AS hour,
           COUNT(*)::text AS entradas
         FROM queue_joins
         WHERE joined_at >= NOW() - INTERVAL '24 hours' ${instanceFilter}
         GROUP BY 1
         ORDER BY 1 ASC`,
        [],
      );
      const matchRows = await query<{ hour: string; partidas: string }>(
        `SELECT
           date_trunc('hour', detected_at AT TIME ZONE 'America/Sao_Paulo') AS hour,
           COUNT(*)::text AS partidas
         FROM matches
         WHERE msg_sent = TRUE AND detected_at >= NOW() - INTERVAL '24 hours' ${instanceFilter}
         GROUP BY 1 ORDER BY 1 ASC`,
        [],
      );
      const matchMap = new Map(matchRows.map((r) => [r.hour, Number(r.partidas)]));
      res.json({
        granularity: "hour",
        points: rows.map((r) => ({
          label: new Date(r.hour).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }),
          entradas: Number(r.entradas),
          partidas: matchMap.get(r.hour) ?? 0,
        })),
      });
    } else {
      // Entradas por dia
      const days = period === "month" ? 30 : 7;
      const rows = await query<{ day: string; entradas: string }>(
        `SELECT
           date_trunc('day', joined_at AT TIME ZONE 'America/Sao_Paulo') AS day,
           COUNT(*)::text AS entradas
         FROM queue_joins
         WHERE joined_at >= NOW() - INTERVAL '${days} days' ${instanceFilter}
         GROUP BY 1 ORDER BY 1 ASC`,
        [],
      );
      const matchRows = await query<{ day: string; partidas: string }>(
        `SELECT
           date_trunc('day', detected_at AT TIME ZONE 'America/Sao_Paulo') AS day,
           COUNT(*)::text AS partidas
         FROM matches
         WHERE msg_sent = TRUE AND detected_at >= NOW() - INTERVAL '${days} days' ${instanceFilter}
         GROUP BY 1 ORDER BY 1 ASC`,
        [],
      );
      const matchMap = new Map(matchRows.map((r) => [r.day, Number(r.partidas)]));
      res.json({
        granularity: "day",
        points: rows.map((r) => ({
          label: new Date(r.day).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }),
          entradas: Number(r.entradas),
          partidas: matchMap.get(r.day) ?? 0,
        })),
      });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

statsRouter.delete("/reset", async (req, res) => {
  try {
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    if (instanceId) {
      await query(`DELETE FROM queue_joins WHERE instance_id = $1`, [instanceId]);
      await query(`DELETE FROM matches WHERE instance_id = $1`, [instanceId]);
      await query(
        `UPDATE stats SET entradas = 0, partidas = 0, dms = 0, bloqueadas = 0, msgs_enviadas = 0 WHERE instance_id = $1`,
        [instanceId],
      );
    } else {
      await query(`DELETE FROM queue_joins`, []);
      await query(`DELETE FROM matches`, []);
      await query(`UPDATE stats SET entradas = 0, partidas = 0, dms = 0, bloqueadas = 0, msgs_enviadas = 0`, []);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

statsRouter.get("/summary", async (req, res) => {
  try {
    const period = String(req.query.period ?? "week");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    const instanceFilter = instanceId ? `AND instance_id = ${instanceId}` : "";
    const joinFilter = periodFilter("joined_at", period);
    const matchFilter = periodFilter("detected_at", period);

    const [joinTotal, matchTotal, modeRows] = await Promise.all([
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM queue_joins WHERE 1=1 ${instanceFilter} ${joinFilter}`,
        [],
      ),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM matches WHERE msg_sent = TRUE ${instanceFilter} ${matchFilter}`,
        [],
      ),
      query<{ mode: string; n: string }>(
        `SELECT COALESCE(mode, '?') AS mode, COUNT(*)::text AS n
         FROM queue_joins
         WHERE 1=1 ${instanceFilter} ${joinFilter}
         GROUP BY mode ORDER BY COUNT(*) DESC`,
        [],
      ),
    ]);

    res.json({
      entradas: Number(joinTotal[0]?.n ?? 0),
      partidas: Number(matchTotal[0]?.n ?? 0),
      by_mode: modeRows.map((r) => ({ mode: r.mode, n: Number(r.n) })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
