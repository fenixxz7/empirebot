import { GatewayClient, type ReadyData } from "./gateway.js";
import { query } from "../db/pool.js";
import { QueueRunner, type ActiveToken } from "../engine/runner.js";
import { MatchHandler, type MatchToken } from "../engine/match_handler.js";
import { MatchPoller } from "../engine/match_poller.js";
import { runAutoDiscoveryForInstance } from "../discord/discovery.js";
import { DiscordRest } from "../discord/rest.js";
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

interface RotationState {
  index: number;
  startedAt: number;
  minutes: number;
}

const ROTATION_TICK_MS = 5_000;

class Manager {
  private workers = new Map<number, WorkerEntry[]>();
  private runners = new Map<number, QueueRunner>();
  private matchHandlers = new Map<number, MatchHandler>();
  private matchPollers = new Map<number, MatchPoller>();
  private discoveryRan = new Set<number>();
  private rotation = new Map<number, RotationState>();
  private rotationTimer: NodeJS.Timeout | null = null;

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

    // Carrega rotation_minutes da config para iniciar o ciclo de rotação
    const cfgRows = await query<{ rotation_minutes: number }>(
      `SELECT rotation_minutes FROM instance_configs WHERE instance_id = $1`,
      [instanceId],
    );
    const rotationMinutes = Math.max(1, cfgRows[0]?.rotation_minutes ?? 90);
    this.rotation.set(instanceId, {
      index: 0,
      startedAt: Date.now(),
      minutes: rotationMinutes,
    });
    this.ensureRotationLoop();

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

    // Captura de eventos de canal/thread do gateway
    const CHANNEL_EVENTS = new Set([
      "CHANNEL_CREATE",
      "THREAD_CREATE",
      "THREAD_LIST_SYNC",
    ]);

    for (const e of entries) {
      e.client.on("dispatch", (eventName: string, eventData: any) => {
        // Log diagnóstico: todos os eventos relevantes de canal/thread
        if (CHANNEL_EVENTS.has(eventName) || eventName.startsWith("THREAD")) {
          this.log(
            instanceId,
            "INFO",
            "match",
            `GW event: ${eventName} | ch=${eventData?.name ?? eventData?.id ?? "?"} type=${eventData?.type ?? "?"} guild=${eventData?.guild_id ?? "?"} | token#${e.position}`,
          ).catch(() => {});
        }

        // THREAD_LIST_SYNC: lista de threads ao reconectar
        if (eventName === "THREAD_LIST_SYNC") {
          const threads: any[] = eventData?.threads ?? [];
          const matchTokens = this.buildMatchTokens(instanceId, e.tokenId);
          for (const t of threads) {
            matchHandler.onChannelCreate(t, matchTokens).catch(() => {});
          }
          return;
        }

        // THREAD_MEMBERS_UPDATE: fallback quando o token é adicionado a uma thread
        // Discord nem sempre envia CHANNEL_CREATE para threads privadas em guilds grandes
        if (eventName === "THREAD_MEMBERS_UPDATE") {
          const addedMembers: Array<{ user_id?: string }> = eventData?.added_members ?? [];
          const myId = e.client.getUserId();
          const wasAdded = myId && addedMembers.some((m) => m.user_id === myId);
          if (wasAdded && eventData?.id) {
            const matchTokens = this.buildMatchTokens(instanceId, e.tokenId);
            // Busca os detalhes da thread via REST para pegar nome e tipo
            const rest = new DiscordRest(e.token);
            rest.request<{ id: string; name: string; type: number; guild_id?: string; parent_id?: string }>(
              "GET",
              `/channels/${eventData.id}`,
            ).then(({ data }) => {
              if (data) matchHandler.onChannelCreate(data, matchTokens).catch(() => {});
            }).catch(() => {});
          }
          return;
        }

        // GUILD_CREATE: log de quantas threads existem na guild no momento da conexão
        if (eventName === "GUILD_CREATE") {
          const threads: any[] = eventData?.threads ?? [];
          if (threads.length > 0) {
            const matchTokens = this.buildMatchTokens(instanceId, e.tokenId);
            for (const t of threads) {
              matchHandler.onChannelCreate(t, matchTokens).catch(() => {});
            }
          }
          return;
        }

        if (!CHANNEL_EVENTS.has(eventName)) return;

        // CHANNEL_CREATE / THREAD_CREATE: caminho principal
        const matchTokens = this.buildMatchTokens(instanceId, e.tokenId);
        matchHandler.onChannelCreate(eventData, matchTokens).catch(() => {});
      });
    }

    // Inicia o motor de filas
    const runner = new QueueRunner(instanceId, this);
    this.runners.set(instanceId, runner);
    runner.start();

    // Poller REST como fallback do gateway p/ detectar partidas/filas
    const poller = new MatchPoller(instanceId, {
      log: (id, level, source, message) => this.log(id, level, source, message),
      getMatchTokens: (id) => this.buildMatchTokens(id),
    }, matchHandler);
    this.matchPollers.set(instanceId, poller);
    poller.start();
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
    this.rotation.delete(instanceId);
    if (this.rotation.size === 0 && this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Para o motor de filas e o detector de partidas
    const runner = this.runners.get(instanceId);
    if (runner) {
      runner.stop();
      this.runners.delete(instanceId);
    }
    const poller = this.matchPollers.get(instanceId);
    if (poller) {
      poller.stop();
      this.matchPollers.delete(instanceId);
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

  private buildMatchTokens(instanceId: number, priorityTokenId?: number): MatchToken[] {
    const all = (this.workers.get(instanceId) ?? [])
      .filter((w) => w.client.isReady())
      .map((w) => ({
        tokenId: w.tokenId,
        position: w.position,
        token: w.token,
        userId: w.client.getUserId() ?? "",
      }))
      .filter((t) => t.userId !== "");

    if (priorityTokenId == null) return all;
    // Coloca o token que disparou o evento na frente — ele é quem está na thread
    const priority = all.filter((t) => t.tokenId === priorityTokenId);
    const rest = all.filter((t) => t.tokenId !== priorityTokenId);
    return [...priority, ...rest];
  }

  /**
   * Retorna a lista de tokens conectados (com session_id válido) para
   * uma instância — usado pelo motor de filas pra clicar nos botões.
   * A ordem começa pelo token "ativo" da rotação atual.
   */
  getActiveTokens(instanceId: number): ActiveToken[] {
    const entries = this.workers.get(instanceId) ?? [];
    const ready: ActiveToken[] = [];
    for (const e of entries) {
      if (!e.client.isReady()) continue;
      const sessionId = e.client.getSessionId();
      const userId = e.client.getUserId();
      if (!sessionId || !userId) continue;
      ready.push({
        tokenId: e.tokenId,
        position: e.position,
        token: e.token,
        sessionId,
        userId,
      });
    }
    if (ready.length === 0) return ready;
    const rot = this.rotation.get(instanceId);
    const idx = rot ? rot.index % ready.length : 0;
    if (idx === 0) return ready;
    return [...ready.slice(idx), ...ready.slice(0, idx)];
  }

  /** Segundos até o próximo swap de token na rotação. */
  getNextRotationSeconds(instanceId: number): number {
    const rot = this.rotation.get(instanceId);
    if (!rot) return 0;
    const total = rot.minutes * 60;
    const elapsed = (Date.now() - rot.startedAt) / 1000;
    return Math.max(0, Math.floor(total - elapsed));
  }

  /** Atualiza rotation_minutes em memória (chamado quando a config é salva). */
  updateRotationMinutes(instanceId: number, minutes: number): void {
    const rot = this.rotation.get(instanceId);
    if (!rot) return;
    rot.minutes = Math.max(1, minutes);
  }

  private ensureRotationLoop(): void {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => {
      for (const instanceId of this.rotation.keys()) {
        this.tickRotation(instanceId).catch((err) =>
          console.error("[rotation]", err),
        );
      }
    }, ROTATION_TICK_MS);
  }

  private async tickRotation(instanceId: number): Promise<void> {
    const rot = this.rotation.get(instanceId);
    if (!rot) return;
    const elapsed = Date.now() - rot.startedAt;
    if (elapsed < rot.minutes * 60_000) return;

    const ready = (this.workers.get(instanceId) ?? []).filter((w) =>
      w.client.isReady(),
    );
    rot.startedAt = Date.now();
    if (ready.length <= 1) return;

    rot.index = (rot.index + 1) % ready.length;
    const next = ready[rot.index]!;
    await this.log(
      instanceId,
      "INFO",
      "worker",
      `Rotação de tokens: agora usando token #${next.position}${next.client.getUserId() ? ` (${next.client.getUserId()})` : ""} — próximo swap em ${rot.minutes} min`,
    );
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
          next_rotation_seconds: this.getNextRotationSeconds(instanceId),
        },
      });
    } catch { /* noop */ }
  }

}

export type ManagerType = Manager;
export const manager = new Manager();
