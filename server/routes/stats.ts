import { Router } from "express";
import { query } from "../db/pool.js";

export const statsRouter = Router();

function periodFilter(col: string, period: string): string {
  switch (period) {
    case "today": return `AND ${col} >= NOW() - INTERVAL '1 day'`;
    case "week":  return `AND ${col} >= NOW() - INTERVAL '7 days'`;
    case "month": return `AND ${col} >= NOW() - INTERVAL '30 days'`;
    default:      return "";
  }
}

statsRouter.get("/summary", async (req, res) => {
  try {
    const period = String(req.query.period ?? "week");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    const instF = instanceId ? `AND instance_id = ${instanceId}` : "";
    const joinF = periodFilter("joined_at", period);
    const matchF = periodFilter("detected_at", period);

    const [entriesRes, chatsRes, msgsRes, orgsRes] = await Promise.all([
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM queue_joins WHERE 1=1 ${instF} ${joinF}`, []
      ),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM matches WHERE 1=1 ${instF} ${matchF}`, []
      ),
      query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM matches WHERE msg_sent = TRUE ${instF} ${matchF}`, []
      ),
      query<{ n: string }>(
        `SELECT COUNT(DISTINCT COALESCE(org_name, 'Desconhecida'))::text AS n
         FROM matches WHERE 1=1 ${instF} ${matchF}`, []
      ),
    ]);

    res.json({
      entradas:           Number(entriesRes[0]?.n ?? 0),
      chats_abertos:      Number(chatsRes[0]?.n ?? 0),
      mensagens_enviadas: Number(msgsRes[0]?.n ?? 0),
      orgs_ativas:        Number(orgsRes[0]?.n ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

statsRouter.get("/orgs", async (req, res) => {
  try {
    const period = String(req.query.period ?? "week");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    const instF = instanceId ? `AND instance_id = ${instanceId}` : "";
    const joinF = periodFilter("joined_at", period);
    const matchF = periodFilter("detected_at", period);
    const sort = String(req.query.sort ?? "entradas");

    const [entriesRows, matchRows] = await Promise.all([
      query<{ org_name: string; entradas: string }>(
        `SELECT COALESCE(org_name, 'Desconhecida') AS org_name,
                COUNT(*)::text AS entradas
         FROM queue_joins WHERE 1=1 ${instF} ${joinF}
         GROUP BY org_name`, []
      ),
      query<{ org_name: string; chats_abertos: string; mensagens_enviadas: string }>(
        `SELECT COALESCE(org_name, 'Desconhecida') AS org_name,
                COUNT(*)::text AS chats_abertos,
                COUNT(*) FILTER (WHERE msg_sent = TRUE)::text AS mensagens_enviadas
         FROM matches WHERE 1=1 ${instF} ${matchF}
         GROUP BY org_name`, []
      ),
    ]);

    const map = new Map<string, {
      org_name: string;
      entradas: number;
      chats_abertos: number;
      mensagens_enviadas: number;
    }>();

    for (const r of entriesRows) {
      map.set(r.org_name, {
        org_name: r.org_name,
        entradas: Number(r.entradas),
        chats_abertos: 0,
        mensagens_enviadas: 0,
      });
    }
    for (const r of matchRows) {
      const ex = map.get(r.org_name);
      if (ex) {
        ex.chats_abertos = Number(r.chats_abertos);
        ex.mensagens_enviadas = Number(r.mensagens_enviadas);
      } else {
        map.set(r.org_name, {
          org_name: r.org_name,
          entradas: 0,
          chats_abertos: Number(r.chats_abertos),
          mensagens_enviadas: Number(r.mensagens_enviadas),
        });
      }
    }

    const result = [...map.values()].sort((a, b) => {
      if (sort === "chats")     return b.chats_abertos      - a.chats_abertos;
      if (sort === "mensagens") return b.mensagens_enviadas - a.mensagens_enviadas;
      return b.entradas - a.entradas;
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

statsRouter.get("/timeseries", async (req, res) => {
  try {
    const period = String(req.query.period ?? "today");
    const instanceId = req.query.instance_id ? Number(req.query.instance_id) : null;
    const instF = instanceId ? `AND instance_id = ${instanceId}` : "";

    const isHourly = period === "today";
    const trunc    = isHourly ? "hour" : "day";

    let joinWhere  = `WHERE 1=1 ${instF}`;
    let matchWhere = `WHERE 1=1 ${instF}`;
    if (period === "today") {
      joinWhere  += ` AND joined_at   >= NOW() - INTERVAL '24 hours'`;
      matchWhere += ` AND detected_at >= NOW() - INTERVAL '24 hours'`;
    } else if (period === "week") {
      joinWhere  += ` AND joined_at   >= NOW() - INTERVAL '7 days'`;
      matchWhere += ` AND detected_at >= NOW() - INTERVAL '7 days'`;
    } else if (period === "month") {
      joinWhere  += ` AND joined_at   >= NOW() - INTERVAL '30 days'`;
      matchWhere += ` AND detected_at >= NOW() - INTERVAL '30 days'`;
    }
    // "all" — sem filtro de data

    const [joinRows, matchRows] = await Promise.all([
      query<{ bucket: Date; entradas: string }>(
        `SELECT date_trunc('${trunc}', joined_at) AS bucket,
                COUNT(*)::text AS entradas
         FROM queue_joins ${joinWhere}
         GROUP BY 1 ORDER BY 1 ASC`, []
      ),
      query<{ bucket: Date; chats_abertos: string; mensagens_enviadas: string }>(
        `SELECT date_trunc('${trunc}', detected_at) AS bucket,
                COUNT(*)::text AS chats_abertos,
                COUNT(*) FILTER (WHERE msg_sent = TRUE)::text AS mensagens_enviadas
         FROM matches ${matchWhere}
         GROUP BY 1 ORDER BY 1 ASC`, []
      ),
    ]);

    // pg devolve colunas timestamp como Date — converter para ISO string como chave do Map
    const toKey = (b: Date) => (b instanceof Date ? b.toISOString() : String(b));

    const bucketMap = new Map<string, {
      ts: Date;
      entradas: number;
      chats_abertos: number;
      mensagens_enviadas: number;
    }>();

    for (const r of joinRows) {
      const key = toKey(r.bucket);
      bucketMap.set(key, {
        ts: r.bucket instanceof Date ? r.bucket : new Date(r.bucket),
        entradas: Number(r.entradas),
        chats_abertos: 0,
        mensagens_enviadas: 0,
      });
    }
    for (const r of matchRows) {
      const key = toKey(r.bucket);
      const ex = bucketMap.get(key);
      if (ex) {
        ex.chats_abertos      = Number(r.chats_abertos);
        ex.mensagens_enviadas = Number(r.mensagens_enviadas);
      } else {
        bucketMap.set(key, {
          ts: r.bucket instanceof Date ? r.bucket : new Date(r.bucket),
          entradas: 0,
          chats_abertos: Number(r.chats_abertos),
          mensagens_enviadas: Number(r.mensagens_enviadas),
        });
      }
    }

    const tz = "America/Sao_Paulo";
    const points = [...bucketMap.values()]
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map(({ ts, ...vals }) => {
        const label = isHourly
          ? ts.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: tz })
          : ts.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit",  timeZone: tz });
        return { label, ...vals };
      });

    res.json({ granularity: isHourly ? "hour" : "day", points });
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
        `UPDATE stats SET entradas = 0, partidas = 0, dms = 0, bloqueadas = 0, msgs_enviadas = 0
         WHERE instance_id = $1`,
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
