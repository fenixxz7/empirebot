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

// ── Discovery Rate Budget ──────────────────────────────────────────────────────
// Controla concorrência e cooldowns por guild para evitar rate limit em
// GET /guilds/:id/channels. Compartilhado entre chamadas simultâneas de discovery.

const DISCOVERY_COOLDOWN_429_MIN_MS = 2 * 60_000; // 2 min após 429
const DISCOVERY_COOLDOWN_429_MAX_MS = 5 * 60_000; // 5 min (jitter)
const DISCOVERY_MAX_CONCURRENT = 2;               // max simultâneos por token

export class DiscoveryRateBudget {
  private guildCooldowns = new Map<string, number>(); // guild_id → blocked_until
  private _active = 0;

  // Estatísticas da sessão (acumuladas, resetadas ao ser chamado por runner diag)
  skippedByCooldown = 0;
  succeeded = 0;
  failed429 = 0;

  get active(): number { return this._active; }

  isCoolingDown(guildId: string): boolean {
    const until = this.guildCooldowns.get(guildId);
    if (!until) return false;
    if (Date.now() >= until) { this.guildCooldowns.delete(guildId); return false; }
    return true;
  }

  remainingMs(guildId: string): number {
    const until = this.guildCooldowns.get(guildId);
    if (!until) return 0;
    return Math.max(0, until - Date.now());
  }

  canAcquire(): boolean {
    return this._active < DISCOVERY_MAX_CONCURRENT;
  }

  acquire(): boolean {
    if (!this.canAcquire()) return false;
    this._active++;
    return true;
  }

  release(): void {
    this._active = Math.max(0, this._active - 1);
  }

  setCooldown429(guildId: string): void {
    // jitter entre min e max
    const ms = DISCOVERY_COOLDOWN_429_MIN_MS +
      Math.floor(Math.random() * (DISCOVERY_COOLDOWN_429_MAX_MS - DISCOVERY_COOLDOWN_429_MIN_MS));
    const newUntil = Date.now() + ms;
    const current = this.guildCooldowns.get(guildId) ?? 0;
    if (newUntil > current) this.guildCooldowns.set(guildId, newUntil);
  }

  activeCooldowns(): number {
    const now = Date.now();
    let n = 0;
    for (const until of this.guildCooldowns.values()) {
      if (until > now) n++;
    }
    return n;
  }

  resetStats(): void {
    this.skippedByCooldown = 0;
    this.succeeded = 0;
    this.failed429 = 0;
  }
}

// ── discoverOrg ───────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  ok: boolean;
  org_id: number;
  guild_id: string;
  channels_found: number;
  queues_saved: number;
  error?: string;
  was_rate_limited?: boolean;
}

export async function discoverOrg(
  token: string,
  orgId: number,
  guildId: string,
): Promise<DiscoveryResult> {
  const rest = new DiscordRest(token);
  const { status, data: channels, error } = await rest.listGuildChannels(guildId);
  if (!channels) {
    const was_rate_limited = status === 429 ||
      (error ?? "").includes("rate_limited");
    return {
      ok: false,
      org_id: orgId,
      guild_id: guildId,
      channels_found: 0,
      queues_saved: 0,
      error: error ?? `HTTP ${status}`,
      was_rate_limited,
    };
  }

  let queuesSaved = 0;
  let candidatesScanned = 0;

  for (const ch of channels) {
    if (ch.type !== 0) continue;

    const modeFromName = detectMode(ch.name);
    const looksLikeQueue = !!modeFromName || /\bfila\b/i.test(ch.name);
    if (!looksLikeQueue) continue;

    candidatesScanned++;
    const channelCategory = detectCategory(ch.name);

    await sleep(120);

    const { data: msgs } = await rest.channelMessages(ch.id, 50);
    if (!msgs || msgs.length === 0) continue;

    const queueMsgs = msgs.filter(
      (m) => Array.isArray(m.components) && m.components.length > 0,
    );
    if (queueMsgs.length === 0) continue;

    const seenMsgIds: string[] = [];

    for (const queueMsg of queueMsgs) {
      const buttons = extractButtons(queueMsg);
      if (buttons.length === 0) continue;

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

/** Retorna true se o erro indica acesso negado permanente (código 50001 ou ban). */
export function isPermanentAccessError(error: string | undefined): boolean {
  if (!error) return false;
  try {
    const parsed = JSON.parse(error);
    return parsed?.code === 50001;
  } catch {
    return error.includes("50001");
  }
}

/**
 * Roda a descoberta automática para todas as orgs selecionadas de uma instância
 * que tenham guild_id mas ainda não tenham sido varridas (last_discovered_at IS NULL)
 * e não estejam na blacklist do token atual.
 *
 * Usa DiscoveryRateBudget para:
 *  - Limitar concorrência (max DISCOVERY_MAX_CONCURRENT simultâneos)
 *  - Aplicar cooldown por guild quando recebe 429
 *  - Pular guilds em cooldown
 */
export async function runAutoDiscoveryForInstance(
  instanceId: number,
  tokenId: number,
  token: string,
  budget?: DiscoveryRateBudget,
): Promise<DiscoveryResult[]> {
  const toDiscover = await query<{
    id: number;
    name: string;
    guild_id: string | null;
  }>(
    `SELECT o.id, o.name, o.guild_id
     FROM orgs o
     JOIN instance_orgs io ON io.org_id = o.id AND io.instance_id = $1
     WHERE o.guild_id IS NOT NULL
       AND o.guild_id <> ''
       AND o.last_discovered_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM token_org_blacklist b
         WHERE b.org_id = o.id AND b.token_id = $2
       )`,
    [instanceId, tokenId],
  );

  const results: DiscoveryResult[] = [];
  let skipped = 0;
  let succeeded = 0;
  let failed429 = 0;

  for (const o of toDiscover) {
    const guildId = o.guild_id!;

    // Verifica cooldown por guild
    if (budget && budget.isCoolingDown(guildId)) {
      const rem = Math.ceil(budget.remainingMs(guildId) / 1000);
      await query(
        `INSERT INTO logs (instance_id, level, source, message)
         VALUES ($1, 'INFO', 'discovery', $2)`,
        [instanceId, `${o.name}: discovery pulada — cooldown de 429 ativo (${rem}s restantes)`],
      );
      skipped++;
      budget.skippedByCooldown++;
      continue;
    }

    // Limita concorrência — aguarda slot disponível (com timeout para não travar)
    if (budget) {
      let waited = 0;
      while (!budget.canAcquire() && waited < 30_000) {
        await sleep(500);
        waited += 500;
      }
      budget.acquire();
    }

    try {
      const r = await discoverOrg(token, o.id, guildId);
      results.push(r);

      if (!r.ok && r.was_rate_limited) {
        // 429 no GET /guilds/:id/channels — aplica cooldown na guild
        failed429++;
        if (budget) {
          budget.failed429++;
          budget.setCooldown429(guildId);
          const coolMs = budget.remainingMs(guildId);
          await query(
            `INSERT INTO logs (instance_id, level, source, message)
             VALUES ($1, 'WARN', 'discovery', $2)`,
            [instanceId, `${o.name}: rate limit (429) em GET /channels — cooldown de ${Math.ceil(coolMs / 1000)}s aplicado`],
          );
        }
        // Não seta last_discovered_at → retry no próximo start
      } else if (!r.ok && isPermanentAccessError(r.error)) {
        // Erro permanente: entra na blacklist por token
        try {
          await query(
            `INSERT INTO token_org_blacklist (token_id, org_id, reason)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [tokenId, o.id, "discovery: sem acesso (50001)"],
          );
        } catch (fkErr: unknown) {
          // FK violation: token_id não existe mais — ignora silenciosamente
          const code = (fkErr as any)?.code;
          if (code !== "23503") throw fkErr;
          await query(
            `INSERT INTO logs (instance_id, level, source, message)
             VALUES ($1, 'WARN', 'discovery', $2)`,
            [instanceId, `${o.name}: blacklist não inserida — token_id=${tokenId} não existe mais (FK)`],
          );
        }
        await query(
          `INSERT INTO logs (instance_id, level, source, message)
           VALUES ($1, 'WARN', 'discovery', $2)`,
          [instanceId, `${o.name}: sem acesso (50001) — adicionada à blacklist do token atual`],
        );
      } else if (r.ok) {
        succeeded++;
        if (budget) budget.succeeded++;
        await query(
          `UPDATE orgs SET last_discovered_at = NOW() WHERE id = $1`,
          [o.id],
        );
        await query(
          `INSERT INTO logs (instance_id, level, source, message)
           VALUES ($1, 'INFO', 'discovery', $2)`,
          [instanceId, `${o.name}: ${r.channels_found} ${pluralCanal(r.channels_found)} escaneado(s), ${r.queues_saved} fila(s) cadastradas`],
        );
      } else {
        await query(
          `INSERT INTO logs (instance_id, level, source, message)
           VALUES ($1, 'ERROR', 'discovery', $2)`,
          [instanceId, `${o.name}: falha (${r.error ?? "erro"}) — tentará novamente no próximo start`],
        );
      }
    } catch (err) {
      await query(
        `INSERT INTO logs (instance_id, level, source, message)
         VALUES ($1, 'ERROR', 'discovery', $2)`,
        [instanceId, `${o.name}: exceção — ${(err as Error).message}`],
      );
    } finally {
      if (budget) budget.release();
    }
  }

  // Log de sumário do budget
  if (budget && toDiscover.length > 0) {
    await query(
      `INSERT INTO logs (instance_id, level, source, message)
       VALUES ($1, 'INFO', 'discovery', $2)`,
      [instanceId,
        `discovery_budget: total=${toDiscover.length} guilds_success=${succeeded} guilds_failed_429=${failed429} guilds_skipped_by_cooldown=${skipped} cooldowns_ativos=${budget.activeCooldowns()}`],
    );
  }

  return results;
}

export function pluralCanal(n: number): string {
  return n === 1 ? "canal" : "canais";
}

/**
 * Força um re-discovery COMPLETO para todas as orgs de uma instância, incluindo
 * as que já foram descobertas antes (last_discovered_at IS NOT NULL).
 * Usado após rotação de token para garantir que o novo token consegue ver todas as orgs.
 */
export async function forceFullRediscovery(instanceId: number): Promise<void> {
  const resetResult = await query<{ count: string }>(
    `WITH updated AS (
       UPDATE orgs SET last_discovered_at = NULL
       WHERE last_discovered_at IS NOT NULL
         AND id IN (SELECT org_id FROM instance_orgs WHERE instance_id = $1)
       RETURNING id
     ) SELECT COUNT(*)::text AS count FROM updated`,
    [instanceId],
  );
  const resetCount = Number(resetResult[0]?.count ?? 0);

  await query(
    `INSERT INTO logs (instance_id, level, source, message) VALUES ($1, 'INFO', 'discovery', $2)`,
    [instanceId, `[re-discovery] pós-rotação: ${resetCount} org(s) resetadas para re-scan com novo token`],
  );

  if (resetCount === 0) return;

  const tokenRows = await query<{ id: number; value: string }>(
    `SELECT tp.id, tp.value
     FROM instance_token_selection its
     JOIN token_pool tp ON tp.id = its.token_pool_id
     WHERE its.instance_id = $1
     ORDER BY its.position ASC
     LIMIT 1`,
    [instanceId],
  );

  if (tokenRows.length === 0) {
    await query(
      `INSERT INTO logs (instance_id, level, source, message) VALUES ($1, 'WARN', 'discovery', $2)`,
      [instanceId, `[re-discovery] nenhum token selecionado para a instância — re-scan adiado`],
    );
    return;
  }

  const { id: tokenId, value: token } = tokenRows[0]!;
  await runAutoDiscoveryForInstance(instanceId, tokenId, token);
}
