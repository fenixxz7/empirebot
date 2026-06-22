import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";
import { recordDetectedType, recordUncorrelated } from "../lib/orgDetection.js";

export interface MatchToken {
  tokenId: number;
  position: number;
  token: string;
  userId: string;
  sessionId: string;
}

export interface MatchHost {
  log(instanceId: number, level: string, source: string, message: string): Promise<void>;
  blacklistOrgForToken(instanceId: number, tokenId: number, tokenPos: number, orgId: number, orgName: string, reason: string): Promise<void>;
  onMatchConfirmed?(instanceId: number, orgId: number | null): void;
}

interface ChannelCreateEvent {
  id: string;
  name: string;
  guild_id?: string;
  type: number;
  parent_id?: string | null;
  permission_overwrites?: Array<{ id: string; type: number }>;
  thread_metadata?: { archived?: boolean; locked?: boolean };
  member?: { user_id?: string };
  /** ID da última mensagem no canal — usado para diferenciar partidas em canais reciclados */
  last_message_id?: string | null;
  /** ID da mensagem que disparou este match (alias de last_message_id, enviado pelo poller) */
  trigger_msg_id?: string | null;
}

const MATCH_PATTERNS = [
  /^fila-\d+$/i,
  /^partida-\d+$/i,
  /^sua[\s_-]partida[\s_-]\d+$/i,
  /^aguardando-\d+$/i,
  /^aguardando[\s_]\d+$/i,
  /^partida[\s]\d+$/i,
  /^aguardando\d+$/i,
];

/** Tipos Discord que correspondem a threads (não canal de texto simples/privado). */
const THREAD_EVENT_TYPES = new Set([10, 11, 12]);


// Discord channel types
// 0 = GUILD_TEXT, 10 = GUILD_NEWS_THREAD, 11 = GUILD_PUBLIC_THREAD, 12 = GUILD_PRIVATE_THREAD
const MATCH_CHANNEL_TYPES = new Set([0, 10, 11, 12]);

function isMatchChannel(name: string): boolean {
  return MATCH_PATTERNS.some((r) => r.test(name));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<@!?(\d+)>/g)) {
    out.push(m[1]);
  }
  return out;
}

function resolveTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function parsePerOrgMessages(raw: string): Array<{ key: string; msg: string }> {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Array<{ key: string; msg: string }> = [];
  for (const line of lines) {
    const sep = line.indexOf("|");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const msg = line.slice(sep + 1).trim();
    if (key && msg) out.push({ key, msg });
  }
  return out;
}

/**
 * Aplica pequenas variações na mensagem para reduzir cara de bot:
 * - Espaço extra aleatório no fim (zero ou um espaço)
 * - Capitalização aleatória da primeira letra
 * - Substitui ocasionalmente "vc" por "voce" e vice-versa, etc.
 * Mudanças sutis — não desfiguram a mensagem do user.
 */
function humanize(input: string): string {
  let s = input;
  // Trim duplicado e normaliza espaços, mas preserva quebras de linha
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
  // 50% das vezes: adiciona um espaço sutil no final ou um ponto extra
  const r = Math.random();
  if (r < 0.18) s = s + " ";
  else if (r < 0.28 && !/[.?!…]$/.test(s)) s = s + ".";
  return s;
}

/**
 * Tenta extrair o código e mensagem de erro do corpo JSON do Discord.
 * Discord retorna `{ "code": <int>, "message": "..." }` na maioria dos erros 4xx.
 * Para AutoMod e outras causas embutidas, pode incluir `errors`/`block_reason`.
 */
function parseDiscordError(rawError?: string): {
  code: number | null;
  message: string;
  raw: string;
  isAutoMod: boolean;
  isTimeout: boolean;
  isMissingPerm: boolean;
  isSendRestricted: boolean;
} {
  const raw = (rawError ?? "").trim();
  let code: number | null = null;
  let message = "";
  let isAutoMod = false;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        code?: number;
        message?: string;
        block_reason?: string;
        errors?: unknown;
      };
      if (typeof parsed.code === "number") code = parsed.code;
      if (typeof parsed.message === "string") message = parsed.message;
      // AutoMod pode aparecer como code 200000 ou block_reason no body
      if (parsed.block_reason || code === 200000) isAutoMod = true;
    } catch {
      message = raw;
    }
  } else {
    message = raw;
  }

  const lower = (message + " " + raw).toLowerCase();
  if (!isAutoMod && (lower.includes("automod") || lower.includes("blocked by"))) {
    isAutoMod = true;
  }
  // Discord 50013 = Missing Permissions; 50001 = Missing Access; 40005 = req too large
  // Códigos explícitos relacionados a timeout/mute do usuário (transitórios):
  //  - 40002: account verification required / unable to send (genérico)
  //  - 40005: request entity too large (não é timeout, mantido fora)
  //  - 50013 também pode aparecer em timeout — string heuristics confirma
  //  - 160002 / 220001 + variantes: communication disabled / member is timed out
  // Sempre que reconhecemos via code OU via texto, marcamos como transitório.
  const TIMEOUT_CODES = new Set<number>([40002, 160002, 220001]);
  const isTimeout =
    (code !== null && TIMEOUT_CODES.has(code)) ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("silenced") ||
    lower.includes("communication disabled") ||
    lower.includes("communication is disabled") ||
    lower.includes("communication has been disabled") ||
    lower.includes("member is timed out") ||
    lower.includes("você está silenciado");
  // Permissão "real" = código 50013/50001 SEM indício de timeout.
  // Nota: blacklist por isMissingPerm é gated por threshold de erros (>= 3)
  // no chamador, evitando que um único 50013 transitório derrube a org.
  const isMissingPerm =
    (code === 50013 || code === 50001) && !isTimeout;

  // Restrição de envio aplicada pelo servidor à conta (anti-spam, flag,
  // Discord rate-limit por servidor). Códigos observados:
  //  - 340013: "envio limitado para o usuário" (server-side throttle / flag)
  //  - 200004: account flagged for spam-like behavior (variantes)
  // Texto comum: "limited", "limitado", "restrict", "spam".
  // Tratado como AutoMod-like para acionar pipeline de mensagem alternativa.
  const SEND_RESTRICT_CODES = new Set<number>([340013, 200004]);
  const isSendRestricted =
    (code !== null && SEND_RESTRICT_CODES.has(code)) ||
    lower.includes("envio") && lower.includes("limitad") ||
    lower.includes("sending messages") && lower.includes("limited") ||
    lower.includes("rate limited") ||
    lower.includes("restrict");

  // isSendRestricted dispara o mesmo pipeline de override que AutoMod
  if (isSendRestricted) {
    isAutoMod = true;
  }

  return { code, message, raw, isAutoMod, isTimeout, isMissingPerm, isSendRestricted };
}

function describeDiscordError(parsed: ReturnType<typeof parseDiscordError>): string {
  if (parsed.isSendRestricted)
    return `envio restrito pelo servidor (code ${parsed.code ?? "?"}) — anti-spam/flag`;
  if (parsed.isAutoMod) return `AutoMod bloqueou (code ${parsed.code ?? "?"})`;
  if (parsed.isTimeout) return `usuário em timeout/silenciado (code ${parsed.code ?? "?"})`;
  if (parsed.isMissingPerm) return `sem permissão SEND_MESSAGES (code ${parsed.code})`;
  if (parsed.code) return `code ${parsed.code} — ${parsed.message}`;
  return parsed.message || "sem detalhe";
}

function pickMessageForOrg(
  perOrgRaw: string,
  orgName: string,
  guildId: string | null,
  globalMsg: string,
): string {
  const entries = parsePerOrgMessages(perOrgRaw);
  if (entries.length === 0) return globalMsg;
  const gid = (guildId ?? "").toLowerCase();
  const oname = orgName.toLowerCase();
  for (const e of entries) {
    if (e.key === gid || e.key === oname) return e.msg;
  }
  return globalMsg;
}


export class MatchHandler {
  private processing = new Set<string>();

  constructor(
    private readonly instanceId: number,
    private readonly host: MatchHost,
  ) {}

  async onChannelCreate(
    event: ChannelCreateEvent,
    tokens: MatchToken[],
  ): Promise<void> {
    if (!MATCH_CHANNEL_TYPES.has(event.type)) {
      // log apenas canais com nome de match para não poluir
      if (isMatchChannel(event.name)) {
        await this.host.log(this.instanceId, "WARN", "match",
          `#${event.name} ignorado — tipo de canal não suportado: ${event.type}`);
      }
      return;
    }
    if (!isMatchChannel(event.name)) return;

    // Ignora threads arquivadas ou travadas — são partidas antigas reutilizadas
    if (event.thread_metadata?.archived || event.thread_metadata?.locked) return;

    // Computa match_key: canais reciclados têm last_message_id diferente → nova match_key
    const triggerMsgId = event.trigger_msg_id ?? event.last_message_id ?? null;
    const matchKey = triggerMsgId && triggerMsgId !== event.id
      ? `${event.id}:${triggerMsgId}`
      : event.id;
    const key = `${this.instanceId}:${matchKey}`;
    // Chave de trava por canal (independe do match_key).
    // Evita que CHANNEL_CREATE (matchKey=channelId) e MESSAGE_CREATE
    // (matchKey=channelId:msgId) processem o MESMO canal em paralelo —
    // o que causava 2–3 POSTs simultâneos para o mesmo endpoint e 429 em cascata.
    const channelKey = `${this.instanceId}:ch:${event.id}`;

    // Nível 1 — deduplicação por match_key exato (lógica original).
    // Se já está processando esse match_key, aguarda até 12s para o primeiro
    // processamento terminar e depois verifica se precisa reenviar.
    if (this.processing.has(key)) {
      const waited = await this._waitForProcessing(key, 12_000);
      if (!waited) return; // ainda bloqueado após timeout — descarta

      // Verifica se o primeiro processamento enviou a mensagem (por match_key)
      const existing = await query<{ msg_sent: boolean }>(
        `SELECT msg_sent FROM matches WHERE instance_id = $1 AND match_key = $2`,
        [this.instanceId, matchKey],
      ).catch(() => [] as Array<{ msg_sent: boolean }>);
      if (existing[0]?.msg_sent) return; // já enviado — nada a fazer

      // Não foi enviado — tenta novamente com os tokens desta chamada
      await this.host.log(this.instanceId, "INFO", "match",
        `#${event.name} — reprocessando após primeiro ciclo (msg_sent=false) match_key=${matchKey}`);
    }

    // Nível 2 — deduplicação por channel_id (proteção extra).
    // Quando CHANNEL_CREATE e MESSAGE_CREATE chegam para o mesmo canal com
    // match_keys diferentes, o nível 1 não os trava entre si.
    // Aqui aguardamos qualquer processamento ativo deste canal antes de prosseguir.
    if (!this.processing.has(key) && this.processing.has(channelKey)) {
      const waited = await this._waitForProcessing(channelKey, 12_000);
      if (!waited) return; // timeout — descarta para não duplicar
      // Verifica se algum envio para esse channel_id já foi confirmado
      const sent = await query<{ msg_sent: boolean }>(
        `SELECT msg_sent FROM matches
         WHERE instance_id = $1 AND channel_id = $2 AND msg_sent = TRUE
         LIMIT 1`,
        [this.instanceId, event.id],
      ).catch(() => [] as Array<{ msg_sent: boolean }>);
      if (sent.length > 0) return; // já enviado por outro match_key do mesmo canal
    }

    if (this.processing.has(key)) return; // dupla checagem após await
    this.processing.add(key);
    this.processing.add(channelKey); // trava o canal para outros match_keys concorrentes

    try {
      await this.handleMatch(event, tokens);
    } catch (err) {
      await this.host.log(
        this.instanceId,
        "ERROR",
        "match",
        `Erro ao processar canal ${event.name}: ${(err as Error).message}`,
      );
    } finally {
      this.processing.delete(key);
      this.processing.delete(channelKey);
    }
  }

  /** Aguarda até `maxMs` para a chave sair do processing. Retorna true se saiu. */
  private _waitForProcessing(key: string, maxMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (!this.processing.has(key)) return resolve(true);
        if (Date.now() - start >= maxMs) return resolve(false);
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  private async handleMatch(
    event: ChannelCreateEvent,
    tokens: MatchToken[],
  ): Promise<void> {
    const guildId = event.guild_id ?? null;

    // Computa match_key (canais reciclados: mesmo channel_id, last_message_id diferente)
    const triggerMsgId = event.trigger_msg_id ?? event.last_message_id ?? null;
    const matchKey = triggerMsgId && triggerMsgId !== event.id
      ? `${event.id}:${triggerMsgId}`
      : event.id;
    const reusedChannel = matchKey !== event.id;

    // Idempotência: não reenvia se já foi enviado para esse match.
    //
    // Para canais RECICLADOS (match_key = channel_id:last_msg_id):
    //   Checa `match_key = $2 OR match_key = $3` onde $3 = event.id (channel_id puro).
    //   - `match_key = $2` → exato: esse reused-match já foi enviado. Bloqueia.
    //   - `match_key = $3` → o mesmo match foi detectado antes sem last_msg_id (gateway
    //     CHANNEL_CREATE puro) e já enviado. Bloqueia para evitar duplo envio.
    //   - match_key = "channel_id:OUTRO_msg_id" (partida anterior, sessão antiga) →
    //     NÃO casa em nenhum dos dois casos. NÃO bloqueia. ← isso corrige TOKYO/SHARK.
    //
    // Para canais NÃO reciclados (match_key = channel_id, gateway puro):
    //   Checa também channel_id para pegar o caso em que o poller chegou primeiro
    //   com match_key = channel_id:msg_id (reused=true) e já enviou.
    const existing = reusedChannel
      ? await query<{ match_key: string }>(
          `SELECT match_key FROM matches
           WHERE instance_id = $1 AND msg_sent = TRUE
             AND (match_key = $2 OR match_key = $3)
           LIMIT 1`,
          [this.instanceId, matchKey, event.id],
        )
      : await query<{ match_key: string }>(
          `SELECT match_key FROM matches
           WHERE instance_id = $1 AND msg_sent = TRUE
             AND (match_key = $2 OR channel_id = $3)
           LIMIT 1`,
          [this.instanceId, matchKey, event.id],
        );
    if (existing.length > 0) {
      await this.host.log(
        this.instanceId, "INFO", "match",
        `[diag] #${event.name} ignorado — ignored_reason=already_sent match_key=${matchKey} channel_id=${event.id} reused_channel=${reusedChannel}`,
      );
      return;
    }

    // Busca fila ativa nessa guild para pegar org/modo/valor.
    // NOTA: esta consulta busca por guild_id — NÃO depende da org atual do engine.
    // As active_queues permanecem na tabela até o sweep (6min private_channel, 8min thread),
    // então partidas chegando após o engine avançar AINDA encontram a linha correspondente
    // (desde que dentro do TTL do tipo da org).
    const activeQueue = await query<{
      aq_id: number;
      org_id: number;
      org_name: string;
      mode: string | null;
      category: string | null;
      embed_valor: string | null;
      match_type: string | null;
      age_seconds: number;
      candidate_count: number;
    }>(
      `SELECT aq.id AS aq_id, aq.org_id, o.name AS org_name, aq.mode, aq.category,
              oc.embed_valor, o.match_type,
              EXTRACT(EPOCH FROM (NOW() - aq.joined_at))::int AS age_seconds,
              COUNT(*) OVER () AS candidate_count
       FROM active_queues aq
       JOIN orgs o ON o.id = aq.org_id
       LEFT JOIN org_channels oc ON oc.org_id = aq.org_id AND oc.mode = aq.mode
       WHERE aq.instance_id = $1 AND o.guild_id = $2
         AND aq.joined_at > NOW() - INTERVAL '8 minutes'
       ORDER BY aq.joined_at DESC
       LIMIT 1`,
      [this.instanceId, guildId],
    );

    const orgCtx = activeQueue[0] ?? null;

    // === Detecção de tipo de partida em tempo real ===
    const detectedType = THREAD_EVENT_TYPES.has(event.type) ? "thread" : "private_channel";
    if (orgCtx) {
      recordDetectedType(this.instanceId, {
        orgId: orgCtx.org_id,
        orgName: orgCtx.org_name,
        detectedType,
        configuredType: orgCtx.match_type ?? "thread",
        channelId: event.id,
        channelName: event.name,
        detectedAt: Date.now(),
      });
      if (orgCtx.match_type && orgCtx.match_type !== "mixed" && orgCtx.match_type !== detectedType) {
        await this.host.log(this.instanceId, "WARN", "match",
          `[auto-fix] org "${orgCtx.org_name}" detectou ${detectedType} mas estava configurada como "${orgCtx.match_type}" — corrigindo automaticamente`);
        await query(
          `UPDATE orgs SET match_type = $1 WHERE id = $2`,
          [detectedType, orgCtx.org_id],
        ).catch((e) => console.warn("[match_handler] auto-fix match_type:", e instanceof Error ? e.message : e));
      }
    }
    const pipelineLabel = `[${orgCtx?.match_type ?? detectedType} pipeline]`;

    // Registra partida sem correlação (detectada mas sem activeQueue)
    if (!orgCtx) {
      recordUncorrelated(this.instanceId);
    }

    // Log diagnóstico: informa status da activeQueue e contexto da detecção.
    {
      let aqStatus: string;
      if (orgCtx) {
        aqStatus = `activeQueue=SIM (aq_id=${orgCtx.aq_id} org="${orgCtx.org_name}" org_id=${orgCtx.org_id} mode=${orgCtx.mode ?? "?"} category=${orgCtx.category ?? "?"} idade=${orgCtx.age_seconds}s candidatos=${orgCtx.candidate_count})`;
      } else if (guildId) {
        // Busca org aproximada + total de filas (sem filtro de TTL) para diagnóstico
        const orgFallback = await query<{ id: number; name: string; total_queues: string }>(
          `SELECT o.id, o.name, COUNT(aq.id)::text AS total_queues
           FROM orgs o
           JOIN instance_orgs io ON io.org_id = o.id AND io.instance_id = $1
           LEFT JOIN active_queues aq ON aq.org_id = o.id AND aq.instance_id = $1
           WHERE o.guild_id = $2
           GROUP BY o.id, o.name
           LIMIT 1`,
          [this.instanceId, guildId],
        ).catch(() => [] as Array<{ id: number; name: string; total_queues: string }>);
        const orgApprox = orgFallback[0];
        aqStatus = orgApprox
          ? `activeQueue=NÃO (guild=${guildId} org_aprox="${orgApprox.name}" id=${orgApprox.id} filas_total=${orgApprox.total_queues} — ignored_reason=no_active_queue fora do TTL 6min/8min)`
          : `activeQueue=NÃO (guild=${guildId} — ignored_reason=no_active_queue guild_id não encontrado nesta instância)`;
      } else {
        aqStatus = `activeQueue=NÃO (guild_id ausente — ignored_reason=no_active_queue)`;
      }
      await this.host.log(
        this.instanceId, "INFO", "match",
        `${pipelineLabel} [diag] #${event.name} ch=${event.id} match_key=${matchKey} reused=${reusedChannel} trigger_msg=${triggerMsgId ?? "none"} guild=${guildId ?? "?"} tipo=${event.type} — ${aqStatus}`,
      );
    }

    // Identifica adversário: 1) permission_overwrites tipo 1 (user), 2) primeira mensagem
    let adversaryId: string | null = null;

    // Token que vai enviar — primeiro disponível
    const sender = tokens[0] ?? null;
    if (!sender) {
      await this.host.log(this.instanceId, "WARN", "match",
        `[diag] #${event.name} IGNORADO — nenhum token disponível para enviar mensagem (motivo=no_sender guild=${guildId ?? "?"} activeQueue=${orgCtx ? "SIM" : "NÃO"})`);
      return;
    }

    const myIds = new Set(tokens.map((t) => t.userId));

    // Tentativa 1: permission_overwrites
    for (const ow of event.permission_overwrites ?? []) {
      if (ow.type === 1 && !myIds.has(ow.id)) {
        adversaryId = ow.id;
        break;
      }
    }

    // Tentativa 2: primeira mensagem no canal (aguarda 1s p/ bot da org postar)
    if (!adversaryId) {
      await sleep(1000);
      const rest = new DiscordRest(sender.token);
      const { data: msgs } = await rest.channelMessages(event.id, 5);
      if (msgs && msgs.length > 0) {
        for (const msg of msgs) {
          const mentions = extractMentions(
            `${msg.content} ${(msg.embeds ?? []).map((e) => `${e.description ?? ""} ${(e.fields ?? []).map((f) => f.value).join(" ")}`).join(" ")}`,
          );
          for (const uid of mentions) {
            if (!myIds.has(uid)) {
              adversaryId = uid;
              break;
            }
          }
          if (adversaryId) break;
        }
      }
    }

    // Registra o match (ou atualiza se já existia sem msg_sent)
    await query(
      `INSERT INTO matches
         (instance_id, channel_id, channel_name, guild_id,
          org_id, org_name, mode, category, embed_valor, adversary_id,
          match_key, trigger_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (instance_id, match_key) DO UPDATE
         SET adversary_id = EXCLUDED.adversary_id,
             org_id = COALESCE(EXCLUDED.org_id, matches.org_id),
             org_name = COALESCE(EXCLUDED.org_name, matches.org_name),
             mode = COALESCE(EXCLUDED.mode, matches.mode),
             category = COALESCE(EXCLUDED.category, matches.category),
             embed_valor = COALESCE(EXCLUDED.embed_valor, matches.embed_valor)`,
      [
        this.instanceId,
        event.id,
        event.name,
        guildId,
        orgCtx?.org_id ?? null,
        orgCtx?.org_name ?? null,
        orgCtx?.mode ?? null,
        orgCtx?.category ?? null,
        orgCtx?.embed_valor ?? null,
        adversaryId,
        matchKey,
        reusedChannel ? triggerMsgId : null,
      ],
    );

    await this.host.log(
      this.instanceId,
      "INFO",
      "match",
      `${pipelineLabel} Partida: #${event.name} · match_key=${matchKey} · reused=${reusedChannel} · corr=${orgCtx ? `SIM(aq_id=${orgCtx.aq_id} ${orgCtx.org_name}·${orgCtx.mode ?? "?"})` : "NÃO(sem activeQueue)"} · detected=${detectedType} · adversário=${adversaryId ? `<@${adversaryId}>` : "não identificado"}`,
    );

    // Incrementa contador de partidas
    await query(
      `UPDATE stats SET partidas = partidas + 1 WHERE instance_id = $1`,
      [this.instanceId],
    );

    // Notifica o runner para registrar conversão por org (métricas de eficiência)
    this.host.onMatchConfirmed?.(this.instanceId, orgCtx?.org_id ?? null);

    // Libera slot da fila ativa nessa guild (o match aconteceu, slot livre)
    if (guildId && orgCtx) {
      await query(
        `DELETE FROM active_queues WHERE instance_id = $1 AND id = $2`,
        [this.instanceId, orgCtx.aq_id],
      );
      // Atualiza na_fila
      const remaining = await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM active_queues WHERE instance_id = $1`,
        [this.instanceId],
      );
      await query(
        `UPDATE stats SET na_fila = $2 WHERE instance_id = $1`,
        [this.instanceId, Number(remaining[0]?.c ?? "0")],
      );
    }

    // Busca config de mensagem
    const cfg = await query<{
      message_main: string;
      message_per_org: string;
      image_url: string | null;
      match_msg_delay_ms: number;
      match_msg_delay_min_ms: number;
      match_msg_delay_max_ms: number;
    }>(
      `SELECT message_main, message_per_org, image_url,
              match_msg_delay_ms, match_msg_delay_min_ms, match_msg_delay_max_ms
       FROM instance_configs WHERE instance_id = $1`,
      [this.instanceId],
    );
    const config = cfg[0];
    if (!config || !config.message_main.trim()) {
      await this.host.log(
        this.instanceId,
        "WARN",
        "match",
        `Nenhuma mensagem configurada — pulando envio para #${event.name}`,
      );
      return;
    }

    // Resolve template: per-org tem precedência sobre o global
    const template = pickMessageForOrg(
      config.message_per_org,
      orgCtx?.org_name ?? "",
      guildId,
      config.message_main,
    );

    const vars: Record<string, string> = {
      adversary_mention: adversaryId ? `<@${adversaryId}>` : "(desconhecido)",
      adversary_id: adversaryId ?? "",
      channel_name: event.name,
      org_name: orgCtx?.org_name ?? "",
      mode: orgCtx?.mode ?? "",
      format: orgCtx?.category ?? "",
      value: orgCtx?.embed_valor ?? "",
    };

    const content = humanize(resolveTemplate(template, vars));

    // Delay aleatório antes de enviar — mais humano que um valor fixo.
    // Usa [min, max] se configurado; fallback para match_msg_delay_ms legado.
    const delayMin = Math.max(0, config.match_msg_delay_min_ms ?? config.match_msg_delay_ms ?? 0);
    const delayMax = Math.max(delayMin, config.match_msg_delay_max_ms ?? delayMin);
    const extraDelay = delayMax > delayMin
      ? Math.floor(delayMin + Math.random() * (delayMax - delayMin))
      : delayMin;
    if (extraDelay > 0) {
      const rangeLabel = delayMax > delayMin
        ? `${(delayMin / 1000).toFixed(1)}–${(delayMax / 1000).toFixed(1)}s → sorteado ${(extraDelay / 1000).toFixed(1)}s`
        : `${(extraDelay / 1000).toFixed(1)}s (fixo)`;
      await this.host.log(this.instanceId, "INFO", "match",
        `Aguardando ${rangeLabel} antes de enviar mensagem em #${event.name}…`);
      await sleep(extraDelay);
    }

    // Log diagnóstico: confirma que o envio vai ser tentado
    await this.host.log(this.instanceId, "INFO", "match",
      `Enviando mensagem em #${event.name} · org=${orgCtx?.org_name ?? "desconhecida"} · token #${sender.position}${adversaryId ? ` → <@${adversaryId}>` : " (sem adversário identificado)"}…`);

    // Envia mensagem (com imagem opcional, se configurada no painel)
    // Antes do POST: dispara "está digitando…" e espera um tempo
    // proporcional ao tamanho da mensagem para parecer humano (sem exagero).
    // O envio roda de forma assíncrona independente do loop de cliques do runner.
    const rest = new DiscordRest(sender.token);

    // triggerTyping: best-effort, apenas 20% dos envios, 1 tentativa, nunca bloqueia.
    // O endpoint /typing era responsável por muitos 429 — uso esporádico reduz esse risco.
    if (Math.random() < 0.20) {
      rest.triggerTyping(event.id).then((typingRes) => {
        if (typingRes.status !== 204 && typingRes.status !== 200) {
          this.host.log(this.instanceId, "INFO", "match",
            `[diag] triggerTyping → HTTP ${typingRes.status}${typingRes.error ? ` | ${typingRes.error.slice(0, 80)}` : ""}`
          ).catch(() => {});
        }
      }).catch((e) => {
        console.warn("[match_handler] triggerTyping:", e instanceof Error ? e.message : e);
      });
      // Pequena pausa humanizadora sem bloquear o envio na fila de typing
      await sleep(Math.floor(300 + Math.random() * 400));
    }

    await this.host.log(this.instanceId, "INFO", "match",
      `[diag] POST /channels/${event.id}/messages iniciado (content.length=${content.length}, image=${config.image_url ? "sim" : "não"})…`);
    let result = await rest.sendMessage(event.id, content, config.image_url);
    await this.host.log(this.instanceId, "INFO", "match",
      `[diag] sendMessage → HTTP ${result.status}${result.error ? ` | erro: ${result.error.slice(0, 200)}` : ""}${result.data ? " | ok" : ""}`);

    // Selfbots não suportam embeds — 400 com imagem: tenta novamente sem ela
    if (result.status === 400 && config.image_url) {
      await this.host.log(
        this.instanceId,
        "WARN",
        "match",
        `HTTP 400 com imagem em #${event.name} — reenviando sem embed`,
      );
      result = await rest.sendMessage(event.id, content, null);
    }

    if (result.status >= 200 && result.status < 300) {
      await query(
        `UPDATE matches SET msg_sent = TRUE WHERE instance_id = $1 AND channel_id = $2`,
        [this.instanceId, event.id],
      );
      await query(
        `UPDATE stats SET msgs_enviadas = msgs_enviadas + 1 WHERE instance_id = $1`,
        [this.instanceId],
      );
      const imgTag = config.image_url ? " · com imagem" : "";
      await this.host.log(
        this.instanceId,
        "INFO",
        "match",
        `Mensagem na partida enviada em #${event.name} · match_key=${matchKey} · reused=${reusedChannel} · org=${orgCtx?.org_name ?? "desconhecida"} · para ${adversaryId ? `<@${adversaryId}>` : "(sem adversário)"} · token #${sender.position}${imgTag}`,
      );
      return;
    }

    // ── Tratamento de falha ─────────────────────────────────────────────────
    const parsed = parseDiscordError(result.error);
    const orgLabel = orgCtx?.org_name ?? guildId ?? event.name;
    const reasonText = describeDiscordError(parsed);

    // Registra TODO erro em match_send_errors (com code Discord + mensagem)
    // e captura o error_count atualizado para gate de blacklist.
    const upsertRows = await query<{ error_count: number }>(
      `INSERT INTO match_send_errors
         (instance_id, org_label, error_count, last_status, last_error_code, last_message, last_seen)
       VALUES ($1, $2, 1, $3, $4, $5, NOW())
       ON CONFLICT (instance_id, org_label)
       DO UPDATE SET
         error_count     = match_send_errors.error_count + 1,
         last_status     = EXCLUDED.last_status,
         last_error_code = EXCLUDED.last_error_code,
         last_message    = EXCLUDED.last_message,
         last_seen       = NOW()
       RETURNING error_count`,
      [
        this.instanceId,
        orgLabel,
        result.status,
        parsed.code,
        parsed.message.slice(0, 500) || null,
      ],
    ).catch(() => [] as Array<{ error_count: number }>);
    const failureCount = upsertRows[0]?.error_count ?? 1;

    // Só blacklista a org no token quando for permissão "real":
    // EXATAMENTE code 50013 ou 50001 SEM indício de timeout.
    // E após pelo menos 3 falhas consecutivas — evita blacklist por 1 erro transitório.
    // Qualquer outro 403 (AutoMod, timeout, code desconhecido, sem code) NÃO blacklista.
    const BLACKLIST_THRESHOLD = 3;
    const isPermSignature = parsed.isMissingPerm;
    const shouldBlacklist =
      orgCtx && isPermSignature && failureCount >= BLACKLIST_THRESHOLD;

    if (shouldBlacklist && orgCtx) {
      const blReason = `HTTP ${result.status} ao enviar mensagem na partida #${event.name} — ${reasonText}`;
      await this.host.log(
        this.instanceId,
        "WARN",
        "match",
        `Token #${sender.position} sem acesso em ${orgLabel} — ${reasonText}. Org será ignorada por este token.`,
      );
      await this.host.blacklistOrgForToken(
        this.instanceId,
        sender.tokenId,
        sender.position,
        orgCtx.org_id,
        orgCtx.org_name,
        blReason,
      );
    } else {
      const level = parsed.isAutoMod || parsed.isTimeout ? "WARN" : "ERROR";
      const gateNote =
        isPermSignature && orgCtx && failureCount < BLACKLIST_THRESHOLD
          ? ` (${failureCount}/${BLACKLIST_THRESHOLD} antes de blacklist)`
          : "";
      await this.host.log(
        this.instanceId,
        level,
        "match",
        `Falha ao enviar em #${event.name} (${orgLabel}): HTTP ${result.status} — ${reasonText}${gateNote}`,
      );
    }
  }
}
