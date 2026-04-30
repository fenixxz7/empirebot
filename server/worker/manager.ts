import { GatewayClient, type ReadyData } from "./gateway.js";
import { query } from "../db/pool.js";
import { QueueRunner, type ActiveToken } from "../engine/runner.js";
import { MatchHandler, type MatchToken } from "../engine/match_handler.js";
import { runAutoDiscoveryForInstance } from "../discord/discovery.js";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";

let _wss: WebSocketServer | null = null;

export function setWsServer(wss: WebSocketServer) {
  _wss = wss;
}

function broadcast(instanceId: number, payload: unknown) {
  if (!_wss) return;
  const msg = JSON.stringify(payload);
  for (const client of _wss.clients) {
    if (
      (client as any).__instanceId === instanceId &&
      client.readyState === WebSocket.OPEN
    ) {
      try { client.send(msg); } catch { /* noop */ }
    }
  }
}

interface WorkerEntry {
  tokenId: number;
  position: number;
  token: string;
  client: GatewayClient;
}

class Manager {
  private workers = new Map<number, WorkerEntry[]>();
  private runners = new Map<number, QueueRunner>();
  private matchHandlers = new Map<number, MatchHandler>();
  private discoveryRan = new Set<number>();

  private async runAutoDiscovery(
    instanceId: number,
    token: string,
  ): Promise<void> {
    try {
      const r = await runAutoDiscoveryForInstance(instanceId, token);
      if (r.length > 0) {
        const totalQ = r.reduce((acc, x) => acc + (x.queues_saved ?? 0), 0);
        const totalCh = r.reduce((acc, x) => acc + (x.channels_found ?? 0), 0);
        await this.log(
          instanceId,
          "INFO",
          "discovery",
          `Descoberta automática: ${r.length} org(s), ${totalCh} ${totalCh === 1 ? "canal" : "canais"}, ${totalQ} fila(s) cadastradas.`,
        );
      }
    } catch (err) {
      await this.log(
        instanceId,
        "ERROR",
        "discovery",
        `Falha na descoberta automática: ${(err as Error).message}`,
      );
    }
  }

  async start(instanceId: number): Promise<void> {
    await this.stopInternal(instanceId, /* logStop */ false);

    const tokens = await query<{ id: number; value: string; position: number }>(
      `SELECT id, value, position FROM tokens
       WHERE instance_id = $1
       ORDER BY position ASC`,
      [instanceId],
    );

    if (tokens.length === 0) {
      await this.log(
        instanceId,
        "WARN",
        "worker",
        "Nenhum token configurado — adicione tokens em Configuração",
      );
      return;
    }

    const entries: WorkerEntry[] = [];
    for (const t of tokens) {
      const label = `BOT${instanceId}.t${t.position}`;
      const client = new GatewayClient(t.value, label);

      client.on("ready", async (data: ReadyData) => {
        await query(
          `UPDATE tokens SET status = 'connected', username = $2 WHERE id = $1`,
          [t.id, data.display_handle],
        );
        await this.log(
          instanceId,
          "INFO",
          "gateway",
          `Token #${t.position} conectado como ${data.display_handle}`,
        );
        // Dispara descoberta automática só uma vez por start, com o
        // primeiro token que ficar pronto.
        if (!this.discoveryRan.has(instanceId)) {
          this.discoveryRan.add(instanceId);
          this.runAutoDiscovery(instanceId, t.value).catch((err) =>
            console.error("[autoDiscovery]", err),
          );
        }
      });

      client.on("resumed", async () => {
        await query(`UPDATE tokens SET status = 'connected' WHERE id = $1`, [
          t.id,
        ]);
        await this.log(
          instanceId,
          "INFO",
          "gateway",
          `Token #${t.position} sessão retomada`,
        );
      });

      client.on("close", async (code: number) => {
        await query(
          `UPDATE tokens SET status = 'disconnected' WHERE id = $1
           AND status <> 'invalid'`,
          [t.id],
        );
        await this.log(
          instanceId,
          "WARN",
          "gateway",
          `Token #${t.position} desconectado (code ${code})`,
        );
      });

      client.on("fatal", async (code: number) => {
        await query(`UPDATE tokens SET status = 'invalid' WHERE id = $1`, [
          t.id,
        ]);
        await this.log(
          instanceId,
          "ERROR",
          "gateway",
          `Token #${t.position} inválido / não autorizado (code ${code})`,
        );
      });

      client.on("debug", (m: string) => {
        // mantém limpo no console — só descomente se precisar depurar
        // console.log("[worker]", m);
        void m;
      });

      client.start();
      entries.push({ tokenId: t.id, position: t.position, token: t.value, client });
    }

    this.workers.set(instanceId, entries);
    await this.log(
      instanceId,
      "INFO",
      "worker",
      `Iniciados ${entries.length} worker(s) — conectando ao Discord…`,
    );

    // Inicia o detector de partidas
    const matchHandler = new MatchHandler(instanceId, this);
    this.matchHandlers.set(instanceId, matchHandler);

    // Escuta CHANNEL_CREATE em todos os tokens
    for (const e of entries) {
      e.client.on("dispatch", (eventName: string, eventData: any) => {
        if (eventName !== "CHANNEL_CREATE") return;
        const matchTokens: MatchToken[] = (this.workers.get(instanceId) ?? [])
          .filter((w) => w.client.isReady())
          .map((w) => ({
            tokenId: w.tokenId,
            position: w.position,
            token: w.token,
            userId: w.client.getUserId() ?? "",
          }))
          .filter((t) => t.userId !== "");
        matchHandler.onChannelCreate(eventData, matchTokens).catch(() => {});
      });
    }

    // Inicia o motor de filas
    const runner = new QueueRunner(instanceId, this);
    this.runners.set(instanceId, runner);
    runner.start();
  }

  async stop(instanceId: number): Promise<void> {
    await this.stopInternal(instanceId, true);
  }

  private async stopInternal(
    instanceId: number,
    logStop: boolean,
  ): Promise<void> {
    // Limpa flag de descoberta para o próximo start poder rodar de novo
    this.discoveryRan.delete(instanceId);

    // Para o motor de filas e o detector de partidas
    const runner = this.runners.get(instanceId);
    if (runner) {
      runner.stop();
      this.runners.delete(instanceId);
    }
    this.matchHandlers.delete(instanceId);
    await query(`DELETE FROM active_queues WHERE instance_id = $1`, [
      instanceId,
    ]);
    await query(
      `UPDATE stats SET na_fila = 0 WHERE instance_id = $1`,
      [instanceId],
    );

    const entries = this.workers.get(instanceId);
    if (!entries || entries.length === 0) {
      // Mesmo sem workers em memória, garante que tokens fiquem como 'unknown'
      await query(
        `UPDATE tokens SET status = 'unknown', username = NULL
         WHERE instance_id = $1 AND status <> 'invalid'`,
        [instanceId],
      );
      return;
    }

    for (const e of entries) {
      try {
        e.client.removeAllListeners();
        e.client.stop();
      } catch {
        /* noop */
      }
    }
    await query(
      `UPDATE tokens SET status = 'unknown', username = NULL
       WHERE instance_id = $1 AND status <> 'invalid'`,
      [instanceId],
    );
    this.workers.delete(instanceId);

    if (logStop) {
      await this.log(instanceId, "INFO", "worker", "Workers parados");
    }
  }

  isRunning(instanceId: number): boolean {
    return (this.workers.get(instanceId)?.length ?? 0) > 0;
  }

  /**
   * Retorna a lista de tokens conectados (com session_id válido) para
   * uma instância — usado pelo motor de filas pra clicar nos botões.
   */
  getActiveTokens(instanceId: number): ActiveToken[] {
    const entries = this.workers.get(instanceId) ?? [];
    const out: ActiveToken[] = [];
    for (const e of entries) {
      if (!e.client.isReady()) continue;
      const sessionId = e.client.getSessionId();
      const userId = e.client.getUserId();
      if (!sessionId || !userId) continue;
      out.push({
        tokenId: e.tokenId,
        position: e.position,
        token: e.token,
        sessionId,
        userId,
      });
    }
    return out;
  }

  log = async (
    instanceId: number,
    level: string,
    source: string,
    message: string,
  ): Promise<void> => {
    try {
      const rows = await query<{ id: number; ts: string }>(
        `INSERT INTO logs (instance_id, level, source, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, to_char(ts AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS') AS ts`,
        [instanceId, level, source, message],
      );
      const row = rows[0];
      if (row) {
        broadcast(instanceId, {
          type: "log",
          payload: { id: row.id, ts: row.ts, level, source, message },
        });
      }
    } catch {
      /* noop */
    }
    // Broadcast stats snapshot after every log entry
    this.broadcastStats(instanceId).catch(() => {});
  };

  private async broadcastStats(instanceId: number): Promise<void> {
    try {
      const rows = await query<{
        running: boolean; entradas: number; na_fila: number;
        partidas: number; dms: number; started_at: string | null;
        tokens_active: number; first_handle: string | null;
      }>(`
        SELECT i.running,
               s.entradas, s.na_fila, s.partidas, s.dms, s.started_at,
               COALESCE(t.active, 0) AS tokens_active,
               t.first_handle
        FROM instances i
        LEFT JOIN stats s ON s.instance_id = i.id
        LEFT JOIN (
          SELECT instance_id,
                 COUNT(*) FILTER (WHERE status = 'connected')::int AS active,
                 (ARRAY_AGG(username ORDER BY position ASC)
                   FILTER (WHERE status = 'connected'))[1] AS first_handle
          FROM tokens GROUP BY instance_id
        ) t ON t.instance_id = i.id
        WHERE i.id = $1
      `, [instanceId]);
      const r = rows[0];
      if (!r) return;
      const startedAt = r.started_at ? new Date(r.started_at).getTime() : null;
      const uptime = r.running && startedAt
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
      broadcast(instanceId, {
        type: "stats",
        payload: {
          running: r.running,
          connected: (r.tokens_active ?? 0) > 0,
          user_handle: r.first_handle ?? null,
          uptime_seconds: uptime,
          entradas: r.entradas ?? 0,
          na_fila: r.na_fila ?? 0,
          partidas: r.partidas ?? 0,
          dms: r.dms ?? 0,
        },
      });
    } catch { /* noop */ }
  }

}

export type ManagerType = Manager;
export const manager = new Manager();
