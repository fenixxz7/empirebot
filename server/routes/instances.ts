import { Router } from "express";
import { query } from "../db/pool.js";
import { manager } from "../worker/manager.js";

export const instancesRouter = Router();

instancesRouter.get("/", async (_req, res) => {
  const rows = await query<{
    id: number;
    name: string;
    running: boolean;
    entradas: number;
    na_fila: number;
    partidas: number;
    dms: number;
    bloqueadas: number;
    msgs_enviadas: number;
    started_at: string | null;
    tokens_total: number;
    tokens_active: number;
    first_handle: string | null;
  }>(`
    SELECT i.id, i.name, i.running,
           s.entradas, s.na_fila, s.partidas, s.dms, s.bloqueadas, s.msgs_enviadas, s.started_at,
           COALESCE(t.total, 0)  AS tokens_total,
           COALESCE(t.active, 0) AS tokens_active,
           t.first_handle
    FROM instances i
    LEFT JOIN stats s ON s.instance_id = i.id
    LEFT JOIN (
      SELECT instance_id,
             COUNT(*)::int                                              AS total,
             COUNT(*) FILTER (WHERE status = 'connected')::int          AS active,
             (ARRAY_AGG(username ORDER BY position ASC)
                 FILTER (WHERE status = 'connected'))[1]                AS first_handle
      FROM tokens
      GROUP BY instance_id
    ) t ON t.instance_id = i.id
    ORDER BY i.id ASC
  `);

  const instances = rows.map((r) => {
    // Uptime só conta enquanto o bot está rodando. started_at é preservado
    // após /stop (pra não perder histórico ao reiniciar), mas o tempo
    // acumulado não deve continuar subindo com o bot pausado.
    const startedAt = r.started_at ? new Date(r.started_at).getTime() : null;
    const uptimeSec = r.running && startedAt
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0;
    return {
      id: r.id,
      name: r.name,
      running: r.running,
      connected: (r.tokens_active ?? 0) > 0,
      user_handle: r.first_handle ?? null,
      uptime_seconds: uptimeSec,
      stats: {
        entradas: r.entradas ?? 0,
        na_fila: r.na_fila ?? 0,
        partidas: r.partidas ?? 0,
        dms: r.dms ?? 0,
        bloqueadas: r.bloqueadas ?? 0,
        msgs_enviadas: r.msgs_enviadas ?? 0,
      },
      tokens_active: r.tokens_active ?? 0,
      tokens_total: r.tokens_total ?? 0,
      next_rotation_seconds: manager.getNextRotationSeconds(r.id),
    };
  });

  res.json(instances);
});

instancesRouter.post("/:id/start", async (req, res) => {
  const id = Number(req.params.id);
  await query(`UPDATE instances SET running = TRUE WHERE id = $1`, [id]);
  // Só define started_at se ainda não estiver definido — não reseta o uptime ao reiniciar
  await query(
    `UPDATE stats SET started_at = COALESCE(started_at, NOW()) WHERE instance_id = $1`,
    [id],
  );
  await query(
    `INSERT INTO logs (instance_id, level, source, message)
     VALUES ($1, 'INFO', 'control', 'Instância iniciada')`,
    [id],
  );
  // start workers (não bloqueante)
  manager.start(id).catch((err) => {
    console.error("[manager.start]", err);
  });
  res.json({ ok: true });
});

instancesRouter.post("/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  await query(`UPDATE instances SET running = FALSE WHERE id = $1`, [id]);
  // Não zera started_at ao parar — uptime só reseta via reset-stats ou troca de token
  await manager.stop(id);
  await query(
    `INSERT INTO logs (instance_id, level, source, message)
     VALUES ($1, 'INFO', 'control', 'Instância parada')`,
    [id],
  );
  res.json({ ok: true });
});

instancesRouter.post("/:id/reset-stats", async (req, res) => {
  const id = Number(req.params.id);
  await query(
    `UPDATE stats SET entradas = 0, na_fila = 0, partidas = 0, dms = 0,
                      bloqueadas = 0, msgs_enviadas = 0, started_at = NOW()
     WHERE instance_id = $1`,
    [id],
  );
  await query(
    `INSERT INTO logs (instance_id, level, source, message)
     VALUES ($1, 'INFO', 'control', 'Stats resetados')`,
    [id],
  );
  res.json({ ok: true });
});
