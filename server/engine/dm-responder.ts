import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

interface DmConfig {
  enabled: boolean;
  min_delay_msg: number;
  max_delay_msg: number;
  min_delay_user: number;
  max_delay_user: number;
}

interface DmMessage {
  id: number;
  position: number;
  body: string;
}

interface PendingUser {
  channelId: string;
  userId: string;
  username: string;
  addedAt: number;
}

export interface QueueSnapshot {
  enabled: boolean;
  processing: { userId: string; username: string; msgIndex: number; totalMsgs: number } | null;
  waiting: { userId: string; username: string; position: number; addedAt: number }[];
  respondedToday: number;
  respondedTotal: number;
}

export class DmResponder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queue: PendingUser[] = [];
  private currentlyProcessing: PendingUser | null = null;
  private currentMsgIndex = 0;
  private totalMsgs = 0;
  private enabled = false;

  constructor(private readonly instanceId: number) {}

  private async log(level: "INFO" | "WARN" | "ERROR", message: string): Promise<void> {
    await query(
      `INSERT INTO logs (instance_id, level, source, message) VALUES ($1, $2, 'dm', $3)`,
      [this.instanceId, level, message],
    ).catch(() => {});
  }

  /**
   * Chamado pelo manager quando o Gateway envia CHANNEL_CREATE com is_message_request=true.
   * Adiciona o request direto à fila sem precisar de polling REST.
   */
  async pushFromGateway(channelId: string, userId: string, username: string): Promise<void> {
    if (!this.enabled) return;

    const alreadyDone = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
      [this.instanceId, userId]
    );
    if (Number(alreadyDone[0]?.c ?? 0) > 0) {
      await this.log("INFO", `Gateway: request de ${username} ignorado — já respondido anteriormente.`);
      return;
    }

    const alreadyQueued = this.queue.some((q) => q.userId === userId)
      || this.currentlyProcessing?.userId === userId;
    if (alreadyQueued) return;

    this.queue.push({ channelId, userId, username, addedAt: Date.now() });
    await this.log("INFO", `Gateway: request de ${username} (<@${userId}>) adicionado à fila via evento.`);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.enabled = true;
    // Drena cache de requests vistos via Gateway antes do responder iniciar
    this.drainCachedFromManager().catch(() => {});
    this.scheduleNext(5_000);
  }

  private async drainCachedFromManager(): Promise<void> {
    try {
      const { manager } = await import("../worker/manager.js");
      const cached = manager.drainPendingMessageRequests(this.instanceId);
      if (cached.length === 0) return;
      await this.log("INFO", `Drenando ${cached.length} request(s) cacheado(s) do Gateway.`);
      for (const r of cached) {
        await this.pushFromGateway(r.channelId, r.userId, r.username);
      }
    } catch (err) {
      await this.log("WARN", `Falha ao drenar cache: ${(err as Error).message}`);
    }
  }

  /** Força drenar o cache do manager (usado pelo botão Varrer Agora) */
  async forceDrainCache(): Promise<number> {
    const { manager } = await import("../worker/manager.js");
    const cached = manager.drainPendingMessageRequests(this.instanceId);
    let added = 0;
    for (const r of cached) {
      const before = this.queue.length;
      await this.pushFromGateway(r.channelId, r.userId, r.username);
      if (this.queue.length > before) added++;
    }
    return added;
  }

  stop() {
    this.running = false;
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async getSnapshot(): Promise<QueueSnapshot> {
    const respondedRows = await query<{ total: string; today: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE responded_at >= NOW() - INTERVAL '24 hours')::text AS today
       FROM dm_responded WHERE instance_id = $1`,
      [this.instanceId]
    );

    return {
      enabled: this.enabled,
      processing: this.currentlyProcessing
        ? {
            userId: this.currentlyProcessing.userId,
            username: this.currentlyProcessing.username,
            msgIndex: this.currentMsgIndex,
            totalMsgs: this.totalMsgs,
          }
        : null,
      waiting: this.queue.map((u, i) => ({
        userId: u.userId,
        username: u.username,
        position: i + 1,
        addedAt: u.addedAt,
      })),
      respondedToday: Number(respondedRows[0]?.today ?? 0),
      respondedTotal: Number(respondedRows[0]?.total ?? 0),
    };
  }

  private scheduleNext(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().catch(() => {}).finally(() => {
        if (this.running) this.scheduleNext(60_000);
      });
    }, delayMs);
  }

  async tick() {
    const cfg = await this.loadConfig();
    if (!cfg || !cfg.enabled) return;

    const tokens = await query<{ value: string }>(
      `SELECT value FROM tokens WHERE instance_id = $1 AND status = 'connected' ORDER BY position ASC`,
      [this.instanceId]
    );
    if (tokens.length === 0) return;

    // Busca requests SEMPRE — independente de ter mensagens configuradas
    // para que a fila mostre na UI mesmo que o usuário ainda não configurou as msgs
    const allPending: PendingUser[] = [];

    // Pega user_ids de todos os tokens conectados — pra ignorar DMs onde o bot já enviou algo
    const { manager } = await import("../worker/manager.js");
    const myUserIds = new Set(manager.getConnectedUserIds(this.instanceId));

    for (const tok of tokens) {
      const rest = new DiscordRest(tok.value);
      const res = await rest.listMessageRequests();

      if (res.status !== 200 || !res.data) {
        await this.log("WARN", `Falha ao listar canais: HTTP ${res.status} ${res.error?.slice(0, 80) ?? ""}`);
        continue;
      }

      let dataArr: import("../discord/rest.js").DiscordDMChannel[] = [];
      if (Array.isArray(res.data)) {
        dataArr = res.data as import("../discord/rest.js").DiscordDMChannel[];
      } else {
        const obj = res.data as Record<string, unknown>;
        const nested = obj.message_requests ?? obj.channels ?? obj.data ?? obj.items;
        if (Array.isArray(nested)) dataArr = nested as import("../discord/rest.js").DiscordDMChannel[];
      }

      // Filtra DMs (type=1) com last_message_id e exclui os já respondidos
      const dmCandidates = dataArr.filter(
        (c) => (c as any).type === 1 && c.last_message_id && c.recipients?.[0],
      );

      let detected = 0;
      let skippedBots = 0;
      let skippedCached = 0;
      for (const ch of dmCandidates) {
        const recipient = ch.recipients![0]!;

        // Ignora bots — não respondemos a contas automatizadas
        if ((recipient as any).bot === true) {
          skippedBots++;
          continue;
        }

        // Já respondido alguma vez? pula (truth source autoritativa)
        const alreadyDone = await query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
          [this.instanceId, recipient.id],
        );
        if (Number(alreadyDone[0]?.c ?? 0) > 0) continue;

        // Já está na fila? pula
        if (allPending.some((p) => p.userId === recipient.id)) continue;
        if (this.queue.some((q) => q.userId === recipient.id)) continue;
        if (this.currentlyProcessing?.userId === recipient.id) continue;

        // OTIMIZAÇÃO: se last_message_id não mudou desde a última varredura,
        // o canal já foi avaliado e descartado — pula o fetch
        const cachedLastMsgId = manager.getCachedLastMessageId(this.instanceId, ch.id);
        if (cachedLastMsgId && cachedLastMsgId === ch.last_message_id) {
          skippedCached++;
          continue;
        }

        // HEURÍSTICA: busca as últimas mensagens do canal — se NENHUMA é do bot,
        // é uma conversa onde ele nunca respondeu = request pendente
        const msgsRes = await rest.channelMessages(ch.id, 10);
        // Marca este last_message_id como "já avaliado" (mesmo se for falso/erro,
        // pra não martelar canais sem permissão a cada scan)
        if (ch.last_message_id) {
          manager.setCachedLastMessageId(this.instanceId, ch.id, ch.last_message_id);
        }

        if (msgsRes.status !== 200 || !Array.isArray(msgsRes.data) || msgsRes.data.length === 0) {
          continue;
        }
        const botEverReplied = msgsRes.data.some(
          (m: any) => m?.author?.id && myUserIds.has(String(m.author.id)),
        );
        if (botEverReplied) continue;

        const lastMsg = msgsRes.data[0] as any;
        if (!lastMsg?.author?.id) continue;
        if (myUserIds.has(String(lastMsg.author.id))) continue;

        allPending.push({
          channelId: ch.id,
          userId: recipient.id,
          username: recipient.global_name ?? recipient.username ?? recipient.id,
          addedAt: Date.now(),
        });
        detected++;
      }

      await this.log(
        "INFO",
        `Varredura: ${dmCandidates.length} DM(s), ${detected} pendente(s)${skippedBots > 0 ? `, ${skippedBots} bot(s)` : ""}${skippedCached > 0 ? `, ${skippedCached} cacheado(s)` : ""}.`,
      );
    }

    // Adiciona só os novos — não substitui quem já está na fila aguardando
    for (const pending of allPending) {
      const alreadyQueued = this.queue.some((q) => q.userId === pending.userId);
      const isProcessingNow = this.currentlyProcessing?.userId === pending.userId;
      if (!alreadyQueued && !isProcessingNow) {
        this.queue.push(pending);
      }
    }

    // Só processa (envia mensagens) se houver mensagens configuradas
    const messages = await this.loadMessages();
    if (messages.length === 0) {
      if (this.queue.length > 0) {
        await this.log("WARN", `${this.queue.length} request(s) na fila mas nenhuma mensagem configurada — configure mensagens na aba abaixo para responder.`);
      }
      return;
    }

    if (!this.currentlyProcessing && this.queue.length > 0) {
      this.processQueue(cfg, messages, tokens[0]!.value);
    }
  }

  private async processQueue(cfg: DmConfig, messages: DmMessage[], token: string) {
    const rest = new DiscordRest(token);
    this.totalMsgs = messages.length;

    while (this.queue.length > 0 && this.running) {
      const pending = this.queue.shift()!;
      this.currentlyProcessing = pending;
      this.currentMsgIndex = 0;

      const alreadyDone = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM dm_responded WHERE instance_id = $1 AND user_id = $2`,
        [this.instanceId, pending.userId]
      );
      if (Number(alreadyDone[0]?.c ?? 0) > 0) {
        this.currentlyProcessing = null;
        continue;
      }

      // Recarrega mensagens em tempo real (respeita edições feitas enquanto processa)
      const freshMessages = await this.loadMessages();
      this.totalMsgs = freshMessages.length;

      for (let i = 0; i < freshMessages.length; i++) {
        this.currentMsgIndex = i;
        const msg = freshMessages[i]!;
        if (i > 0) {
          const delayMs = randBetween(cfg.min_delay_msg, cfg.max_delay_msg) * 1000;
          await sleep(delayMs);
        }
        await rest.triggerTyping(pending.channelId);
        await sleep(600 + Math.random() * 400);
        const dmResult = await rest.sendDM(pending.channelId, msg.body);
        if (dmResult.status === 403) {
          await this.log("WARN", `DM bloqueada para usuário ${pending.userId} — HTTP 403 (usuário bloqueou ou desativou DMs). Pulando.`);
          break;
        } else if (dmResult.status === 50007) {
          await this.log("WARN", `DM não permitida para usuário ${pending.userId} (código 50007 — cannot send messages to this user). Pulando.`);
          break;
        } else if (dmResult.status >= 400) {
          await this.log("ERROR", `Falha ao enviar DM para usuário ${pending.userId}: HTTP ${dmResult.status}`);
          break;
        }
      }

      await query(
        `INSERT INTO dm_responded (instance_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [this.instanceId, pending.userId]
      );

      this.currentlyProcessing = null;

      if (this.queue.length > 0 && this.running) {
        const userDelayMs = randBetween(cfg.min_delay_user, cfg.max_delay_user) * 1000;
        await sleep(userDelayMs);
      }
    }

    this.currentlyProcessing = null;
  }

  private async loadConfig(): Promise<DmConfig | null> {
    const rows = await query<DmConfig>(
      `SELECT enabled, min_delay_msg, max_delay_msg, min_delay_user, max_delay_user
       FROM dm_config WHERE instance_id = $1`,
      [this.instanceId]
    );
    return rows[0] ?? null;
  }

  private async loadMessages(): Promise<DmMessage[]> {
    return query<DmMessage>(
      `SELECT id, position, body FROM dm_messages WHERE instance_id = $1 ORDER BY position ASC`,
      [this.instanceId]
    );
  }
}
