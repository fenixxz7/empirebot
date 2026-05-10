import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

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
}

const MATCH_PATTERNS = [
  /^fila-\d+$/i,
  /^partida-\d+$/i,
  /^sua[\s_-]partida[\s_-]\d+$/i,
  /^aguardando-\d+$/i,
];


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

/**
 * Pool de provocações limpas (sem $/repetições/leetspeak/menções) que
 * SEMPRE oferecem algo + pedem DM. Sem ping pra não disparar AutoMod nem
 * irritar a org. Usado quando o original está bloqueando e a sanitização
 * não rende texto útil. Valores em texto (sem $/dígitos+moeda) pra
 * sobreviver ao próprio sanitizador caso passem por ele.
 */
const SAFE_PROVOCATION_TEMPLATES: string[] = [
  "chama no privado quero pagar seu app te mando 2 real",
  "me manda msg quero te pagar 2 real pelo app",
  "fala comigo no pv quero pagar seu ap",
  "me chama no direct quero pagar seu ap te mando 2 real",
  "responde no privado quero pagar seu app",
  "manda dm quero pagar seu ap te mando uns trocados",
  "cola no pv quero pagar seu app",
  "chama no privado te mando 2 real quero pagar seu ap",
  "me chama no privado quero te pagar pelo app",
  "manda mensagem quero pagar seu ap te mando uma graninha",
];

/**
 * Sanitiza uma mensagem removendo gatilhos comuns de AutoMod:
 *  - símbolos de moeda e valores (R$, $, 2,00$, 5,50)
 *  - sequências repetidas de letras (vvvv → v, kkkkk → kkk)
 *  - sequências suspeitas de pontuação ("p,.vvv", ",,.,.")
 *  - emojis e símbolos não-ASCII raros
 * Mantém placeholders ({adversary_mention}, etc) intactos para o caller.
 */
export function sanitizeForAutoMod(input: string): string {
  let s = input;
  // Remove menções a usuários (<@123>, <@!123>) e o placeholder
  // {adversary_mention} — política: alternativa NUNCA pinga ninguém.
  s = s.replace(/<@!?\d+>/g, "");
  s = s.replace(/\{adversary_mention\}/g, "");
  // Preserva os demais placeholders trocando por marcadores temporários
  const placeholders: string[] = [];
  s = s.replace(/\{[a-z_]+\}/g, (m) => {
    placeholders.push(m);
    return `\u0001PH${placeholders.length - 1}\u0001`;
  });
  // Remove valores em dinheiro estilo "2,00$" "R$ 5" "$3" "5,50 reais"
  s = s.replace(/\b\d+[.,]?\d*\s*(?:reais|reai|conto|pila)\b/gi, "");
  s = s.replace(/(?:R\$|\$)\s*\d+[.,]?\d*/gi, "");
  s = s.replace(/\b\d+[.,]\d+\s*\$/g, "");
  // Tira símbolo $ solto
  s = s.replace(/\$+/g, "");
  // Normaliza leetspeak conservador: substitui dígitos por letras quando
  // estão DENTRO de palavras (evita estragar números soltos como horários).
  // Ex: "pr1vad0" → "privado", "dm4" → "dma" (raro mas seguro).
  const leetMap: Record<string, string> = {
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "@": "a",
  };
  s = s.replace(/[A-Za-zÀ-ÿ][0-9@]+[A-Za-zÀ-ÿ]?/g, (word) =>
    word.replace(/[0-9@]/g, (d) => leetMap[d] ?? d),
  );
  // Colapsa qualquer letra repetida 3+ vezes para no máx 2 (kkkkkk → kk, vvvv → vv)
  s = s.replace(/([a-zA-Z])\1{2,}/g, "$1$1");
  // Remove sequências esquisitas de pontuação tipo "p,.vvv" ou ",.,.,."
  s = s.replace(/[,.;:!?]{2,}/g, ".");
  // Remove qualquer caractere não-printável ou emoji exótico (mantém acentos PT)
  s = s.replace(/[^\x20-\x7E\u00C0-\u00FF\n\u0001]/g, "");
  // Normaliza espaços
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // Restaura placeholders
  s = s.replace(/\u0001PH(\d+)\u0001/g, (_, i) => placeholders[Number(i)] ?? "");
  return s;
}

/**
 * Gera uma provocação alternativa sanitizada para uma org cuja mensagem
 * original está sendo bloqueada por AutoMod. Mantém a intenção de fazer o
 * adversário mandar mensagem (DM/privado).
 */
export function generateSafeMessageFor(
  originalTemplate: string,
  excludeMessage?: string,
): string {
  const sanitized = sanitizeForAutoMod(originalTemplate);
  // Política: alternativa SEMPRE oferece algo + pede DM, sem menção.
  // Se a sanitização não inclui pedido claro de DM/privado ou ficou muito
  // curta, vai direto pro pool. Caso contrário usa o sanitizado.
  const lower = sanitized.toLowerCase();
  const hasDmAsk =
    lower.includes("privado") ||
    lower.includes("pv") ||
    lower.includes("dm") ||
    lower.includes("direct") ||
    lower.includes("msg") ||
    lower.includes("mensagem");
  const tooShort = sanitized.replace(/\{[a-z_]+\}/g, "").trim().length < 8;
  const sanitizedClashesWithExcluded =
    excludeMessage != null && sanitized.trim() === excludeMessage.trim();
  if (!hasDmAsk || tooShort || sanitizedClashesWithExcluded) {
    return pickRandomSafeTemplate(excludeMessage);
  }
  return sanitized;
}

/**
 * Escolhe um template do pool diferente de `excludeMessage` (se possível).
 * Usado para "rotacionar" a alternativa quando a atual já provou falhar.
 */
export function pickRandomSafeTemplate(excludeMessage?: string): string {
  const pool = SAFE_PROVOCATION_TEMPLATES;
  if (!excludeMessage) {
    return pool[Math.floor(Math.random() * pool.length)]!;
  }
  const norm = excludeMessage.trim().toLowerCase();
  const filtered = pool.filter((t) => t.trim().toLowerCase() !== norm);
  const candidates = filtered.length > 0 ? filtered : pool;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

/**
 * Cooldown global por org: quando uma org bate AutoMod múltiplas vezes
 * seguidas (mesmo após rotação de alternativa) ou volta com 340013
 * "envio limitado", colocamos a org em quarentena por X minutos. Durante
 * a quarentena, novos matches são detectados (canal registrado) mas o
 * envio é PULADO — evita queimar mais o token e dá tempo da flag passar.
 *
 * Compartilhado entre instâncias do MatchHandler (chave inclui instanceId).
 * `static` porque o handler é re-instanciado a cada reativação de worker.
 */
const ORG_COOLDOWNS = new Map<string, number>();

import { COOLDOWN_AUTOMOD_MS, COOLDOWN_RESTRICTED_MS } from "../lib/timings.js";

function cooldownKey(instanceId: number, orgKey: string): string {
  return `${instanceId}:${orgKey}`;
}

function getCooldownRemainingMs(instanceId: number, orgKey: string): number {
  if (!orgKey) return 0;
  const until = ORG_COOLDOWNS.get(cooldownKey(instanceId, orgKey));
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    ORG_COOLDOWNS.delete(cooldownKey(instanceId, orgKey));
    return 0;
  }
  return remaining;
}

function setOrgCooldown(
  instanceId: number,
  orgKey: string,
  ms: number,
): void {
  if (!orgKey || ms <= 0) return;
  const k = cooldownKey(instanceId, orgKey);
  const current = ORG_COOLDOWNS.get(k) ?? 0;
  const newUntil = Date.now() + ms;
  // Mantém o cooldown mais longo se já houver um em vigor.
  if (newUntil > current) ORG_COOLDOWNS.set(k, newUntil);
}

function formatCooldownRemaining(ms: number): string {
  const min = Math.ceil(ms / 60000);
  return min === 1 ? "1 min" : `${min} min`;
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

    const key = `${this.instanceId}:${event.id}`;

    // Se já está processando esse canal, aguarda até 12s para o primeiro
    // processamento terminar e depois verifica se precisa reenviar.
    // Antes retornava silenciosamente — isso causava perda do envio quando
    // CHANNEL_CREATE e MESSAGE_CREATE chegavam quase simultâneos.
    if (this.processing.has(key)) {
      const waited = await this._waitForProcessing(key, 12_000);
      if (!waited) return; // ainda bloqueado após timeout — descarta

      // Verifica se o primeiro processamento enviou a mensagem
      const existing = await query<{ msg_sent: boolean }>(
        `SELECT msg_sent FROM matches WHERE instance_id = $1 AND channel_id = $2`,
        [this.instanceId, event.id],
      ).catch(() => [] as Array<{ msg_sent: boolean }>);
      if (existing[0]?.msg_sent) return; // já enviado — nada a fazer

      // Não foi enviado — tenta novamente com os tokens desta chamada
      await this.host.log(this.instanceId, "INFO", "match",
        `#${event.name} — reprocessando após primeiro ciclo (msg_sent=false)`);
    }

    if (this.processing.has(key)) return; // dupla checagem após await
    this.processing.add(key);

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

    // Idempotência — já processamos?
    const existing = await query<{ id: string; msg_sent: boolean }>(
      `SELECT id, msg_sent FROM matches WHERE instance_id = $1 AND channel_id = $2`,
      [this.instanceId, event.id],
    );
    if (existing.length > 0 && existing[0]!.msg_sent) {
      // Log diagnóstico: idempotência — partida já foi processada
      await this.host.log(
        this.instanceId, "INFO", "match",
        `[diag] #${event.name} (ch=${event.id}) ignorado — msg_sent=TRUE (partida já processada anteriormente)`,
      );
      return;
    }

    // Busca fila ativa nessa guild para pegar org/modo/valor.
    // NOTA: esta consulta busca por guild_id — NÃO depende da org atual do engine.
    // As active_queues de orgs anteriores permanecem na tabela até o sweep de 4min,
    // então partidas de COROLLA chegando 2–3min após o engine avançar AINDA encontram
    // a linha correspondente aqui (desde que dentro do TTL de 4min).
    const activeQueue = await query<{
      org_id: number;
      org_name: string;
      mode: string | null;
      category: string | null;
      embed_valor: string | null;
    }>(
      `SELECT aq.org_id, o.name AS org_name, aq.mode, aq.category,
              oc.embed_valor
       FROM active_queues aq
       JOIN orgs o ON o.id = aq.org_id
       LEFT JOIN org_channels oc ON oc.org_id = aq.org_id AND oc.mode = aq.mode
       WHERE aq.instance_id = $1 AND o.guild_id = $2
       LIMIT 1`,
      [this.instanceId, guildId],
    );

    const orgCtx = activeQueue[0] ?? null;

    // Log diagnóstico: informa status da activeQueue e contexto da detecção.
    // Aparece em TODOS os matches para facilitar debugging pós-troca-de-org.
    {
      let aqStatus: string;
      if (orgCtx) {
        aqStatus = `activeQueue=SIM (org="${orgCtx.org_name}" org_id=${orgCtx.org_id} mode=${orgCtx.mode ?? "?"})`;
      } else if (guildId) {
        // Fallback: tenta encontrar a org pelo guild_id mesmo sem active_queue
        const orgFallback = await query<{ id: number; name: string }>(
          `SELECT o.id, o.name
           FROM orgs o
           JOIN instance_orgs io ON io.org_id = o.id AND io.instance_id = $1
           WHERE o.guild_id = $2
           LIMIT 1`,
          [this.instanceId, guildId],
        ).catch(() => [] as Array<{ id: number; name: string }>);
        const orgApprox = orgFallback[0];
        aqStatus = orgApprox
          ? `activeQueue=NÃO (guild=${guildId} — org aproximada="${orgApprox.name}" id=${orgApprox.id} — nenhuma active_queue dentro do TTL para essa org)`
          : `activeQueue=NÃO (guild=${guildId} — guild_id não encontrado em nenhuma org desta instância)`;
      } else {
        aqStatus = `activeQueue=NÃO (guild_id ausente no evento — canal possivelmente thread sem contexto de guild)`;
      }
      await this.host.log(
        this.instanceId, "INFO", "match",
        `[diag] #${event.name} ch=${event.id} guild=${guildId ?? "?"} tipo=${event.type} — ${aqStatus}`,
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
          org_id, org_name, mode, category, embed_valor, adversary_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (instance_id, channel_id) DO UPDATE
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
      ],
    );

    await this.host.log(
      this.instanceId,
      "INFO",
      "match",
      `Partida detectada: #${event.name}${orgCtx ? ` · ${orgCtx.org_name} · ${orgCtx.mode ?? "?"}` : ""}${adversaryId ? ` · adversário <@${adversaryId}>` : " · adversário não identificado"}`,
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
        `DELETE FROM active_queues
         WHERE id = (
           SELECT id FROM active_queues
           WHERE instance_id = $1 AND org_id = $2
           LIMIT 1
         )`,
        [this.instanceId, orgCtx.org_id],
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

    // ── Cooldown por org (apenas informativo aqui) ───────────────────────
    // O cooldown de entrada NÃO bloqueia o envio de mensagem em partidas já
    // abertas. Ele só deve afetar novas tentativas de entrar em filas
    // (responsabilidade do runner/engine). Se a org está em cooldown de
    // entrada, logamos mas continuamos o envio normalmente.
    const cooldownOrgKey =
      (orgCtx?.org_name ?? "").toLowerCase() ||
      (guildId ?? "").toLowerCase();
    if (cooldownOrgKey) {
      const remaining = getCooldownRemainingMs(this.instanceId, cooldownOrgKey);
      if (remaining > 0) {
        const orgLabelCooldown = orgCtx?.org_name ?? guildId ?? event.name;
        await this.host.log(
          this.instanceId,
          "INFO",
          "match",
          `Org ${orgLabelCooldown} está em cooldown de entrada (${formatCooldownRemaining(remaining)} restantes), mas partida #${event.name} será respondida normalmente`,
        );
      }
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

    // Override automático/manual por org tem precedência sobre per-org parsed
    // do config string e sobre o global. Chave = nome da org (lowercase) ou guild_id.
    let templateSource: "override" | "per_org" | "global" = "global";
    let template = config.message_main;
    const orgKey =
      (orgCtx?.org_name ?? "").toLowerCase() ||
      (guildId ?? "").toLowerCase();
    if (orgKey) {
      const ovr = await query<{ message: string; source: string }>(
        `SELECT message, source FROM org_message_overrides
          WHERE instance_id = $1 AND org_key = $2`,
        [this.instanceId, orgKey],
      );
      if (ovr[0]?.message?.trim()) {
        template = ovr[0].message;
        templateSource = "override";
      }
    }
    if (templateSource !== "override") {
      const picked = pickMessageForOrg(
        config.message_per_org,
        orgCtx?.org_name ?? "",
        guildId,
        config.message_main,
      );
      template = picked;
      templateSource = picked === config.message_main ? "global" : "per_org";
    }

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

    // Fallback AutoMod: 403 com code 200000 (ou block_reason) → tenta versão
    // mínima/sanitizada e auto-gera override pra próxima vez nessa org.
    if (result.status === 403 || result.status === 400) {
      const parsedFirst = parseDiscordError(result.error);
      if (parsedFirst.isAutoMod) {
        const orgLabelEarly = orgCtx?.org_name ?? guildId ?? event.name;
        // 340013 (envio limitado) é detectado como isAutoMod=true (mesmo
        // pipeline), mas merece cooldown imediato e LONGO — não adianta
        // tentar fallback porque a restrição é server-side. Aplica o
        // cooldown já aqui antes de tentar o fallback.
        if (parsedFirst.isSendRestricted && orgKey) {
          setOrgCooldown(this.instanceId, orgKey, COOLDOWN_RESTRICTED_MS);
          await this.host.log(
            this.instanceId,
            "WARN",
            "match",
            `Org ${orgLabelEarly} com envio restrito (code ${parsedFirst.code}) — cooldown ${formatCooldownRemaining(COOLDOWN_RESTRICTED_MS)}`,
          );
        }
        // Persiste a tentativa AutoMod ANTES de tentar o fallback, para que
        // mesmo se o fallback dê sucesso, o 403 inicial fique registrado.
        await query(
          `INSERT INTO match_send_errors
             (instance_id, org_label, error_count, last_status, last_error_code, last_message, last_seen)
           VALUES ($1, $2, 1, $3, $4, $5, NOW())
           ON CONFLICT (instance_id, org_label)
           DO UPDATE SET
             error_count     = match_send_errors.error_count + 1,
             last_status     = EXCLUDED.last_status,
             last_error_code = EXCLUDED.last_error_code,
             last_message    = EXCLUDED.last_message,
             last_seen       = NOW()`,
          [
            this.instanceId,
            orgLabelEarly,
            result.status,
            parsedFirst.code,
            (parsedFirst.message || "AutoMod").slice(0, 500),
          ],
        ).catch((e) => console.warn("[match_handler]", e instanceof Error ? e.message : e));

        // Incrementa contador AutoMod por org e dispara auto-geração quando
        // atinge o threshold. Override gerado mantém menção do adversário.
        // Threshold reduzido para 2: na primeira falha 'pending', na segunda
        // já gera a alternativa sanitizada. Reage mais rápido a orgs hostis.
        const AUTOMOD_OVERRIDE_THRESHOLD = 2;
        let blocks = 0;
        if (orgKey) {
          const blkRows = await query<{ automod_blocks: number; source: string }>(
            `INSERT INTO org_message_overrides
               (instance_id, org_key, message, source, automod_blocks, generated_at)
             VALUES ($1, $2, '', 'pending', 1, NOW())
             ON CONFLICT (instance_id, org_key)
             DO UPDATE SET
               automod_blocks = org_message_overrides.automod_blocks + 1
             RETURNING automod_blocks, source`,
            [this.instanceId, orgKey],
          ).catch(() => [] as Array<{ automod_blocks: number; source: string }>);
          blocks = blkRows[0]?.automod_blocks ?? 0;
          const existingSource = blkRows[0]?.source ?? "pending";
          // Gera/atualiza override sanitizado se ainda não existe e
          // bateu o threshold. Não sobrescreve override manual do usuário.
          if (
            blocks >= AUTOMOD_OVERRIDE_THRESHOLD &&
            (existingSource === "pending" || existingSource === "auto")
          ) {
            // Se o template original que falhou JÁ era um override salvo
            // (templateSource === "override"), rotaciona pra um diferente
            // do pool em vez de regenerar o mesmo. Caso contrário gera
            // partindo do template original.
            const safeTemplate =
              templateSource === "override"
                ? pickRandomSafeTemplate(template)
                : generateSafeMessageFor(template);
            await query(
              `UPDATE org_message_overrides
                  SET message = $3, source = 'auto', generated_at = NOW()
                WHERE instance_id = $1 AND org_key = $2
                  AND source IN ('pending', 'auto')`,
              [this.instanceId, orgKey, safeTemplate],
            ).catch((e) => console.warn("[match_handler]", e instanceof Error ? e.message : e));
            await this.host.log(
              this.instanceId,
              "WARN",
              "match",
              `AutoMod bloqueou ${blocks}× em ${orgLabelEarly} — mensagem alternativa ${templateSource === "override" ? "rotacionada" : "gerada"}: "${safeTemplate.slice(0, 80)}"`,
            );
          }
        }

        // Tentativa imediata: SEMPRE usa template alternativo seguro
        // (oferta + pedido de DM, sem menção). Política nova: nada de
        // ping no fallback. Se o template que falhou JÁ era override
        // salvo, escolhe um diferente do pool pra não bater o mesmo.
        const safeTemplate =
          templateSource === "override"
            ? pickRandomSafeTemplate(template)
            : generateSafeMessageFor(template);
        const fallbackContent = humanize(resolveTemplate(safeTemplate, vars));

        if (fallbackContent.trim()) {
          await this.host.log(
            this.instanceId,
            "WARN",
            "match",
            `AutoMod bloqueou em #${event.name} — tentando fallback: "${fallbackContent.slice(0, 60)}"`,
          );
          const r2 = await rest.sendMessage(event.id, fallbackContent, null);
          // Se r2 falhar, ele substitui o resultado para o tratamento de erro
          // capturar a causa REAL (ex: permissão real), em vez de continuar
          // achando que é AutoMod.
          result = r2;
          if (r2.status < 200 || r2.status >= 300) {
            const parsedSecond = parseDiscordError(r2.error);
            await this.host.log(
              this.instanceId,
              "WARN",
              "match",
              `Fallback AutoMod também falhou em #${event.name}: HTTP ${r2.status} — ${describeDiscordError(parsedSecond)}`,
            );
            // Fallback falhou também → coloca a org em cooldown para
            // parar de queimar o token e rotaciona o override pra um
            // template DIFERENTE do que acabou de falhar (pra próxima
            // tentativa quando o cooldown expirar).
            if (orgKey) {
              const cdMs =
                parsedSecond.isSendRestricted
                  ? COOLDOWN_RESTRICTED_MS
                  : COOLDOWN_AUTOMOD_MS;
              setOrgCooldown(this.instanceId, orgKey, cdMs);
              const rotated = pickRandomSafeTemplate(safeTemplate);
              await query(
                `UPDATE org_message_overrides
                    SET message = $3, source = 'auto', generated_at = NOW()
                  WHERE instance_id = $1 AND org_key = $2
                    AND source IN ('pending', 'auto')`,
                [this.instanceId, orgKey, rotated],
              ).catch((e) => console.warn("[match_handler]", e instanceof Error ? e.message : e));
              await this.host.log(
                this.instanceId,
                "WARN",
                "match",
                `Org ${orgLabelEarly} entra em cooldown ${formatCooldownRemaining(cdMs)} — alternativa rotacionada pra "${rotated.slice(0, 60)}"`,
              );
            }
          }
        }
      }
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
        `Mensagem na partida enviada em #${event.name} · org=${orgCtx?.org_name ?? "desconhecida"} · para ${adversaryId ? `<@${adversaryId}>` : "(sem adversário)"} · token #${sender.position}${imgTag}`,
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
