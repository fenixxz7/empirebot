import { DiscordRest, type DiscordButton, type DiscordMessage } from "./rest.js";
import { query } from "../db/pool.js";

export interface ParsedButton {
  label: string;
  custom_id: string | null;
  style: number;
  disabled: boolean;
  action: "enter" | "leave" | "play" | "other" | null;
  variant: "normal" | "gel_normal" | "gel_inf" | "full_ump_xm8" | null;
}

export type GameMode = "1x1" | "2x2" | "3x3" | "4x4";
export type Category = "Mobile" | "Misto" | "Emulador" | "Tatico" | "Full-Soco";

const ALL_MODES: GameMode[] = ["1x1", "2x2", "3x3", "4x4"];

function detectMode(text: string): GameMode | null {
  const t = text.toLowerCase();
  for (const m of ALL_MODES) {
    const num = m[0];
    const re = new RegExp(`(?:^|[^0-9])(?:${num}\\s*[xv]\\s*${num}|x\\s*${num}|${num}v${num})(?:$|[^0-9])`);
    if (re.test(t)) return m;
  }
  return null;
}

/**
 * Detecta a categoria a partir do nome do canal pelo sufixo.
 * Exemplos:
 *   1x1-mob          → Mobile
 *   3x3-emu          → Emulador
 *   2x2-misto, 2x2-mis → Misto
 *   4x4-tatico       → Tatico
 *   1x1-full-soco    → Full-Soco
 *
 * Ordem importa: a checagem de "full-soco" vem antes de "soco" sozinho,
 * "misto" antes de "mis", etc.
 */
export function detectCategory(name: string): Category | null {
  const n = name.toLowerCase();
  if (/full[-_\s]?soco/.test(n)) return "Full-Soco";
  if (/\btatic[oa]\b|tatic[oa](?:[^a-z]|$)/.test(n)) return "Tatico";
  if (/\bmisto\b|misto(?:[^a-z]|$)|[-_\s]mis(?:[^a-z]|$)/.test(n)) return "Misto";
  if (/\bemulador\b|[-_\s]emu(?:[^a-z]|$)/.test(n)) return "Emulador";
  if (/\bmobile\b|[-_\s]mob(?:[^a-z]|$)/.test(n)) return "Mobile";
  return null;
}

export function classifyButton(label: string): {
  action: ParsedButton["action"];
  variant: ParsedButton["variant"];
} {
  const l = label.toLowerCase().trim();
  let action: ParsedButton["action"] = null;
  let variant: ParsedButton["variant"] = null;

  if (/\bsair\b/.test(l)) action = "leave";
  else if (/\bentrar\b/.test(l)) action = "enter";
  else if (/\bjogar\b/.test(l)) action = "play";
  else if (l.length > 0) action = "other";

  if (/gel\s*(infinit|inf)/.test(l)) variant = "gel_inf";
  else if (/\bgel\b/.test(l)) variant = "gel_normal";
  else if (/full[\s_-]*(ump|xm8|ump.*xm8|xm8.*ump)/.test(l)) variant = "full_ump_xm8";
  else if (/\bnormal\b/.test(l)) variant = "normal";

  return { action, variant };
}

function extractButtons(msg: DiscordMessage): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const row of msg.components ?? []) {
    for (const c of row.components ?? []) {
      const btn = c as DiscordButton;
      if (btn.type !== 2) continue;
      const label = (btn.label ?? "").trim();
      const { action, variant } = classifyButton(label);
      out.push({
        label,
        custom_id: btn.custom_id ?? null,
        style: btn.style ?? 0,
        disabled: !!btn.disabled,
        action,
        variant,
      });
    }
  }
  return out;
}

function extractEmbedTitle(msg: DiscordMessage): string | null {
  for (const e of msg.embeds ?? []) {
    if (e.title) return e.title.trim();
    if (e.description) {
      const first = e.description.split("\n").map((l) => l.trim()).find(Boolean);
      if (first) return first.slice(0, 120);
    }
  }
  return null;
}

function extractEmbedValor(msg: DiscordMessage): string | null {
  for (const e of msg.embeds ?? []) {
    const field = (e.fields ?? []).find(
      (f) => f.name.toLowerCase().includes("valor") || f.name.toLowerCase().includes("value"),
    );
    if (field) return field.value.trim();
  }
  return null;
}

export interface DiscoveryResult {
  ok: boolean;
  org_id: number;
  guild_id: string;
  channels_found: number;
  queues_saved: number;
  error?: string;
}

export async function discoverOrg(
  token: string,
  orgId: number,
  guildId: string,
): Promise<DiscoveryResult> {
  const rest = new DiscordRest(token);
  const { status, data: channels, error } = await rest.listGuildChannels(guildId);
  if (!channels) {
    return {
      ok: false,
      org_id: orgId,
      guild_id: guildId,
      channels_found: 0,
      queues_saved: 0,
      error: error ?? `HTTP ${status}`,
    };
  }

  let queuesSaved = 0;
  let candidatesScanned = 0;

  for (const ch of channels) {
    if (ch.type !== 0) continue; // só canal de texto

    const modeFromName = detectMode(ch.name);
    const looksLikeQueue = !!modeFromName || /\bfila\b/i.test(ch.name);
    if (!looksLikeQueue) continue;

    candidatesScanned++;
    const channelCategory = detectCategory(ch.name);

    await sleep(120);

    const { data: msgs } = await rest.channelMessages(ch.id, 50);
    if (!msgs || msgs.length === 0) continue;

    // TODAS as mensagens com botões viram filas (cada card de R$X é uma fila)
    const queueMsgs = msgs.filter(
      (m) => Array.isArray(m.components) && m.components.length > 0,
    );
    if (queueMsgs.length === 0) continue;

    const seenMsgIds: string[] = [];

    for (const queueMsg of queueMsgs) {
      const buttons = extractButtons(queueMsg);
      if (buttons.length === 0) continue;

      // Modo: prefere o do nome; senão, tenta detectar pelo embed/conteúdo
      let mode = modeFromName;
      if (!mode) {
        const titles = (queueMsg.embeds ?? [])
          .map((e) => `${e.title ?? ""} ${e.description ?? ""}`)
          .join(" ");
        mode = detectMode(`${queueMsg.content ?? ""} ${titles}`);
      }

      const applicationId = queueMsg.author?.id ?? null;
      const embedTitle = extractEmbedTitle(queueMsg);
      const embedValor = extractEmbedValor(queueMsg);

      await query(
        `INSERT INTO org_channels (org_id, channel_id, channel_name, category, mode,
                                   message_id, embed_title, embed_valor, application_id, buttons,
                                   last_scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
         ON CONFLICT (org_id, channel_id, message_id) DO UPDATE
           SET channel_name = EXCLUDED.channel_name,
               category = EXCLUDED.category,
               mode = EXCLUDED.mode,
               embed_title = EXCLUDED.embed_title,
               embed_valor = EXCLUDED.embed_valor,
               application_id = EXCLUDED.application_id,
               buttons = EXCLUDED.buttons,
               last_scanned_at = NOW()`,
        [
          orgId,
          ch.id,
          ch.name,
          channelCategory,
          mode,
          queueMsg.id,
          embedTitle,
          embedValor,
          applicationId,
          JSON.stringify(buttons),
        ],
      );
      seenMsgIds.push(queueMsg.id);
      queuesSaved++;
    }

    // Limpa filas antigas que não existem mais nesse canal (mensagens deletadas)
    if (seenMsgIds.length > 0) {
      await query(
        `DELETE FROM org_channels
         WHERE org_id = $1 AND channel_id = $2
           AND message_id <> ALL($3::text[])`,
        [orgId, ch.id, seenMsgIds],
      );
    }
  }

  return {
    ok: true,
    org_id: orgId,
    guild_id: guildId,
    channels_found: candidatesScanned,
    queues_saved: queuesSaved,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Roda a descoberta automática para todas as orgs selecionadas de uma
 * instância que tenham guild_id mas ainda não tenham canais cadastrados.
 * Reutilizado pelo PUT /api/config e pelo manager.start (após o token
 * conectar).
 */
/** Retorna true se o erro indica acesso negado permanente (código 50001 ou ban). */
function isPermanentAccessError(error: string | undefined): boolean {
  if (!error) return false;
  try {
    const parsed = JSON.parse(error);
    return parsed?.code === 50001;
  } catch {
    return error.includes("50001");
  }
}

export async function runAutoDiscoveryForInstance(
  instanceId: number,
  token: string,
): Promise<DiscoveryResult[]> {
  const toDiscover = await query<{
    id: number;
    name: string;
    guild_id: string | null;
  }>(
    `SELECT o.id, o.name, o.guild_id
     FROM orgs o
     JOIN instance_orgs io ON io.org_id = o.id AND io.instance_id = $1
     LEFT JOIN (
       SELECT org_id, COUNT(*)::int AS cnt
       FROM org_channels GROUP BY org_id
     ) c ON c.org_id = o.id
     WHERE o.guild_id IS NOT NULL
       AND o.guild_id <> ''
       AND COALESCE(c.cnt, 0) = 0
       AND NOT COALESCE(o.discovery_blocked, FALSE)`,
    [instanceId],
  );

  const results: DiscoveryResult[] = [];
  for (const o of toDiscover) {
    try {
      const r = await discoverOrg(token, o.id, o.guild_id!);
      results.push(r);

      if (!r.ok && isPermanentAccessError(r.error)) {
        // Marca a org como permanentemente inacessível — não tenta mais automaticamente
        await query(
          `UPDATE orgs SET discovery_blocked = TRUE WHERE id = $1`,
          [o.id],
        );
        await query(
          `INSERT INTO logs (instance_id, level, source, message)
           VALUES ($1, 'WARN', 'discovery', $2)`,
          [instanceId, `${o.name}: sem acesso (50001) — discovery bloqueada permanentemente`],
        );
      } else {
        await query(
          `INSERT INTO logs (instance_id, level, source, message)
           VALUES ($1, $2, $3, $4)`,
          [
            instanceId,
            r.ok ? "INFO" : "ERROR",
            "discovery",
            r.ok
              ? `${o.name}: ${r.channels_found} ${pluralCanal(r.channels_found)} escaneado(s), ${r.queues_saved} fila(s) cadastradas`
              : `${o.name}: falha (${r.error ?? "erro"})`,
          ],
        );
      }
    } catch (err) {
      await query(
        `INSERT INTO logs (instance_id, level, source, message)
         VALUES ($1, 'ERROR', 'discovery', $2)`,
        [instanceId, `${o.name}: exceção — ${(err as Error).message}`],
      );
    }
  }
  return results;
}

export function pluralCanal(n: number): string {
  return n === 1 ? "canal" : "canais";
}
