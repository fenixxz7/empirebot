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

    const key = `${this.instanceId}:${event.id}`;
    if (this.processing.has(key)) return;
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
    if (existing.length > 0 && existing[0]!.msg_sent) return;

    // Busca fila ativa nessa guild para pegar org/modo/valor
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

    // Identifica adversário: 1) permission_overwrites tipo 1 (user), 2) primeira mensagem
    let adversaryId: string | null = null;

    // Token que vai enviar — primeiro disponível
    const sender = tokens[0] ?? null;
    if (!sender) {
      await this.host.log(this.instanceId, "WARN", "match",
        `#${event.name} — nenhum token disponível para enviar mensagem`);
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

    // Busca config de mensagem
    const cfg = await query<{
      message_main: string;
      message_per_org: string;
      image_url: string | null;
    }>(
      `SELECT message_main, message_per_org, image_url
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

    // Envia mensagem (com imagem opcional, se configurada no painel)
    // Antes do POST: dispara "está digitando…" e espera um tempo
    // proporcional ao tamanho da mensagem para parecer humano (sem exagero).
    const rest = new DiscordRest(sender.token);
    await rest.triggerTyping(event.id).catch(() => {});
    const typingMs = Math.min(
      2500,
      800 + content.length * (12 + Math.random() * 18),
    );
    await sleep(typingMs);
    let result = await rest.sendMessage(event.id, content, config.image_url);

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
      const imgTag = config.image_url ? " · com imagem" : "";
      await this.host.log(
        this.instanceId,
        "INFO",
        "match",
        `Mensagem na partida enviada em #${event.name}${adversaryId ? ` para <@${adversaryId}>` : ""} · token #${sender.position}${imgTag}`,
      );
    } else if (result.status === 403) {
      // 403 = token com castigo/timeout na guild — não consegue enviar mensagem na partida
      const orgLabel = orgCtx ? `${orgCtx.org_name}` : "guild desconhecida";
      const reason = `HTTP 403 ao enviar mensagem na partida #${event.name} — token com castigo/timeout em ${orgLabel}`;
      await this.host.log(
        this.instanceId,
        "WARN",
        "match",
        `Token #${sender.position} com castigo em ${orgLabel} — mensagem na partida bloqueada. Org será ignorada por este token.`,
      );
      if (orgCtx) {
        await this.host.blacklistOrgForToken(
          this.instanceId,
          sender.tokenId,
          sender.position,
          orgCtx.org_id,
          orgCtx.org_name,
          reason,
        );
      }
    } else {
      await this.host.log(
        this.instanceId,
        "ERROR",
        "match",
        `Falha ao enviar mensagem na partida em #${event.name}: HTTP ${result.status}`,
      );
      // Registra erro de envio por org (para o painel de erros)
      const orgLabel = orgCtx?.org_name ?? guildId ?? event.name;
      await query(
        `INSERT INTO match_send_errors (instance_id, org_label, error_count, last_status, last_seen)
         VALUES ($1, $2, 1, $3, NOW())
         ON CONFLICT (instance_id, org_label)
         DO UPDATE SET
           error_count = match_send_errors.error_count + 1,
           last_status = EXCLUDED.last_status,
           last_seen   = NOW()`,
        [this.instanceId, orgLabel, result.status],
      ).catch(() => {});
    }
  }
}
