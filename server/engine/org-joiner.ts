import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

// ── Discord error code catalogue ──────────────────────────────────────────────
const DISCORD_ERROR_MESSAGES: Record<number, string> = {
  10006: "convite inválido ou expirado",
  40007: "conta banida deste servidor",
  40002: "conta precisa de verificação (e-mail ou telefone)",
  40014: "conta desativada ou suspensa",
  40041: "servidor exige verificação de membro antes de entrar",
  50013: "sem permissão para entrar",
  20016: "ação bloqueada — conta muito nova ou suspeita para o Discord",
  30001: "número máximo de servidores atingido (conta no limite de guilds)",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function extractInviteCode(raw: string): string | null {
  const cleaned = raw.trim().replace(/\/$/, "");
  const m = cleaned.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9\-]+)/i);
  if (m) return m[1]!;
  if (/^[a-zA-Z0-9\-]{2,30}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Extracts the Discord error code from a response.
 * When the request fails (!res.ok), `res.data` is null and the raw body is
 * in `res.error` as a JSON string — we parse both to cover all cases.
 */
function parseErrorCode(res: { data: unknown; error?: string }): number | null {
  const fromData = (res.data as any)?.code;
  if (fromData != null) return Number(fromData);
  try {
    const parsed = JSON.parse(res.error ?? "");
    if (parsed?.code != null) return Number(parsed.code);
  } catch { /* not JSON */ }
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrgQueueItem {
  id: number;
  invite_code: string;
  invite_raw: string;
  status: "pending" | "processing" | "done" | "failed";
  result_guild_id: string | null;
  result_guild_name: string | null;
  error_reason: string | null;
  added_at: string;
  processed_at: string | null;
}

export interface OrgJoinerSnapshot {
  running: boolean;
  startedAt: string | null;
  uptimeMs: number;
  counter: number;
  currentItem: { id: number; invite_code: string; invite_raw: string } | null;
  queueSize: number;
}

interface OrgJoinerConfig {
  pool_id: number | null;
  token_value: string | null;
  nopecha_key: string | null;
  delay_min_ms: number;
  delay_max_ms: number;
  enabled: boolean;
}

// ── OrgJoiner class ───────────────────────────────────────────────────────────

export class OrgJoiner {
  private running = false;
  private startedAt: Date | null = null;
  private counter = 0;
  private currentItem: OrgQueueItem | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private logs: Array<{ ts: string; msg: string }> = [];

  constructor(private readonly instanceId: number) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.startedAt = new Date();
    await query(
      `UPDATE org_queue SET status = 'pending' WHERE instance_id = $1 AND status = 'processing'`,
      [this.instanceId],
    );
    this.addLog("Bot Org iniciado.");

    const cfg = await this.getConfig();
    const tokenVal = cfg.token_value?.trim() || null;
    if (tokenVal && cfg.pool_id) {
      const rest = new DiscordRest(tokenVal);
      const me = await rest.getMe();
      if (me.status === 200 && me.data) {
        const { username, discriminator, global_name } = me.data;
        const discrim = discriminator && discriminator !== "0" ? `#${discriminator}` : "";
        const display = global_name ?? username;
        const usernameStr = `${username}${discrim}`;
        this.addLog(`✓ Conectado · ${usernameStr} (${display})`);
        await query(
          `UPDATE token_pool SET status = 'ok', username = $2 WHERE id = $1`,
          [cfg.pool_id, `${usernameStr} (${display})`],
        );
      } else {
        this.addLog(`✗ Token inválido ou erro ao conectar (HTTP ${me.status})`);
        await query(
          `UPDATE token_pool SET status = 'invalid' WHERE id = $1`,
          [cfg.pool_id],
        );
      }
    } else if (!tokenVal) {
      this.addLog("⚠ Nenhum token configurado.");
    }

    this.scheduleTick(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.currentItem = null;
    this.addLog("Bot Org parado.");
  }

  isRunning(): boolean { return this.running; }

  getSnapshot(): OrgJoinerSnapshot {
    return {
      running: this.running,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      counter: this.counter,
      currentItem: this.currentItem
        ? { id: this.currentItem.id, invite_code: this.currentItem.invite_code, invite_raw: this.currentItem.invite_raw }
        : null,
      queueSize: 0,
    };
  }

  getLogs(): Array<{ ts: string; msg: string }> { return [...this.logs]; }
  clearLogs(): void { this.logs = []; }

  private addLog(msg: string) {
    this.logs.push({ ts: new Date().toISOString(), msg });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  async addInvite(inviteRaw: string): Promise<{ ok: boolean; error?: string; item?: OrgQueueItem }> {
    const code = extractInviteCode(inviteRaw);
    if (!code) return { ok: false, error: "Link de convite inválido." };

    const existing = await query<{ status: string }>(
      `SELECT status FROM org_queue WHERE instance_id = $1 AND invite_code = $2 AND status IN ('pending','processing')`,
      [this.instanceId, code],
    );
    if (existing.length > 0) return { ok: false, error: "Convite já está na fila." };

    const config = await this.getConfig();
    const token = config.token_value?.trim() || null;

    if (token) {
      const rest = new DiscordRest(token);

      // Validate the invite and get guild info
      const preview = await rest.getInvite(code);
      if (preview.status === 404 || parseErrorCode(preview) === 10006) {
        return { ok: false, error: "Convite inválido ou expirado." };
      }

      // Pre-check: if we already know the guild_id, verify membership before queuing
      const guildId = (preview.data as any)?.guild?.id as string | undefined;
      if (guildId) {
        const memberCheck = await rest.getGuildMember(guildId);
        if (memberCheck.status === 200) {
          const guildName = (preview.data as any)?.guild?.name as string | undefined ?? null;
          // Already a member — insert as done directly, no need to queue
          const rows = await query<OrgQueueItem>(
            `INSERT INTO org_queue (instance_id, invite_code, invite_raw, status, result_guild_id, result_guild_name, processed_at)
             VALUES ($1, $2, $3, 'done', $4, $5, NOW())
             RETURNING *`,
            [this.instanceId, code, inviteRaw.trim(), guildId, guildName],
          );
          this.addLog(`ℹ Conta já está no servidor: ${guildName ?? code} — marcado como concluído.`);
          return { ok: true, item: rows[0] };
        }
      }
    }

    const rows = await query<OrgQueueItem>(
      `INSERT INTO org_queue (instance_id, invite_code, invite_raw, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [this.instanceId, code, inviteRaw.trim()],
    );
    this.addLog(`Adicionado à fila: discord.gg/${code}`);
    if (this.running && !this.timer) this.scheduleTick(0);
    return { ok: true, item: rows[0] };
  }

  async retryFailed(): Promise<number> {
    const result = await query<{ count: string }>(
      `WITH updated AS (
         UPDATE org_queue SET status = 'pending', error_reason = NULL, processed_at = NULL
         WHERE instance_id = $1 AND status = 'failed'
         RETURNING id
       ) SELECT COUNT(*)::text AS count FROM updated`,
      [this.instanceId],
    );
    const n = Number(result[0]?.count ?? 0);
    if (n > 0) {
      this.addLog(`Reagendados ${n} item(s) com falha.`);
      if (this.running && !this.timer) this.scheduleTick(0);
    }
    return n;
  }

  private scheduleTick(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.tick().catch((e) => console.error("[org-joiner:tick]", e)); }, ms);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || !this.running) return;

    const next = await query<OrgQueueItem>(
      `UPDATE org_queue SET status = 'processing'
       WHERE id = (
         SELECT id FROM org_queue
         WHERE instance_id = $1 AND status = 'pending'
         ORDER BY added_at ASC LIMIT 1
       ) AND instance_id = $1
       RETURNING *`,
      [this.instanceId],
    );

    if (!next[0]) {
      this.currentItem = null;
      this.scheduleTick(10_000);
      return;
    }

    this.currentItem = next[0]!;
    await this.processInvite(this.currentItem);

    if (this.stopped) return;
    this.currentItem = null;

    const config = await this.getConfig();
    const minMs = Math.max(5_000, config.delay_min_ms ?? 300_000);
    const maxMs = Math.max(minMs, config.delay_max_ms ?? 720_000);
    const rawDelay = minMs + Math.random() * (maxMs - minMs);
    const jitter = rawDelay * 0.1 * (Math.random() * 2 - 1);
    const delay = Math.round(rawDelay + jitter);
    this.addLog(`Aguardando ${Math.round(delay / 1000)}s até próxima entrada…`);
    this.scheduleTick(delay);
  }

  private async processInvite(item: OrgQueueItem): Promise<void> {
    const config = await this.getConfig();
    const token = config.token_value?.trim() || null;

    if (!token) {
      await this.failItem(item.id, "token_não_configurado");
      this.addLog(`✗ Falhou: token não configurado.`);
      return;
    }

    const rest = new DiscordRest(token);
    this.addLog(`Processando: discord.gg/${item.invite_code}`);

    // ── Step 1: Resolve the invite to get guild info ──────────────────────────
    let guildId: string | null = null;
    let guildName: string | null = null;

    const preview = await rest.getInvite(item.invite_code);
    if (preview.status === 200 && (preview.data as any)?.guild) {
      guildId = (preview.data as any).guild.id ?? null;
      guildName = (preview.data as any).guild.name ?? null;
    } else if (preview.status === 404 || parseErrorCode(preview) === 10006) {
      await this.failItem(item.id, "convite_inválido");
      this.addLog(`✗ Convite inválido ou expirado: discord.gg/${item.invite_code}`);
      return;
    }
    // (if preview fails for other reason, continue anyway — don't abort)

    // ── Step 2: Pre-check membership ──────────────────────────────────────────
    if (guildId) {
      const memberCheck = await rest.getGuildMember(guildId);
      if (memberCheck.status === 200) {
        await this.doneItem(item.id, guildId, guildName);
        this.counter++;
        this.addLog(`✓ Conta já estava no servidor: ${guildName ?? item.invite_code}${guildId ? ` (${guildId})` : ""}`);
        return;
      }
    }

    // ── Step 3: Attempt to join ───────────────────────────────────────────────
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      const res = await rest.acceptInvite(item.invite_code);

      // ── Success ──────────────────────────────────────────────────────────────
      if (res.status === 200 || res.status === 204) {
        const finalGuildId = (res.data as any)?.guild?.id ?? guildId;
        const finalGuildName = (res.data as any)?.guild?.name ?? guildName;
        await this.doneItem(item.id, finalGuildId, finalGuildName);
        this.counter++;
        this.addLog(`✓ Entrou em: ${finalGuildName ?? item.invite_code}${finalGuildId ? ` (${finalGuildId})` : ""}`);
        return;
      }

      // ── Rate limit ───────────────────────────────────────────────────────────
      if (res.status === 429) {
        let waitMs = 5_000;
        try { waitMs = Math.min(30_000, ((res.data as any)?.retry_after ?? 5) * 1000 + 1000); } catch { /**/ }
        this.addLog(`⏳ Rate limit — aguardando ${Math.round(waitMs / 1000)}s… (tentativa ${attempts}/3)`);
        await sleep(waitMs);
        continue;
      }

      // ── CAPTCHA ──────────────────────────────────────────────────────────────
      if (res.status === 400) {
        const captchaKey = (res.data as any)?.captcha_key;
        if (captchaKey) {
          if (!config.nopecha_key?.trim()) {
            await this.failItem(item.id, "captcha_sem_chave_nopecha");
            this.addLog(`✗ CAPTCHA detectado mas sem chave NopeCHA configurada.`);
            return;
          }
          this.addLog(`🔒 CAPTCHA detectado — resolvendo via NopeCHA…`);
          const sitekey = (res.data as any)?.captcha_sitekey ?? "a9b5fb07-92ff-493f-86fe-352a2803b3df";
          const solved = await this.solveHCaptcha(config.nopecha_key.trim(), sitekey, "https://discord.com");
          if (!solved) {
            await this.failItem(item.id, "captcha_falhou");
            this.addLog(`✗ Falhou ao resolver CAPTCHA.`);
            return;
          }
          const res2 = await rest.acceptInviteWithCaptcha(item.invite_code, solved);
          if (res2.status === 200 || res2.status === 204) {
            const finalGuildId = (res2.data as any)?.guild?.id ?? guildId;
            const finalGuildName = (res2.data as any)?.guild?.name ?? guildName;
            await this.doneItem(item.id, finalGuildId, finalGuildName);
            this.counter++;
            this.addLog(`✓ Entrou (com CAPTCHA): ${finalGuildName ?? item.invite_code}`);
            return;
          }
          const errCode2 = parseErrorCode(res2);
          const reason2 = `HTTP_${res2.status}${errCode2 ? `_code_${errCode2}` : ""}`;
          await this.failItem(item.id, reason2);
          this.addLog(`✗ Falhou após resolver CAPTCHA (${reason2}): discord.gg/${item.invite_code}`);
          return;
        }
        // 400 sem captcha
        const errCode400 = parseErrorCode(res);
        await this.failItem(item.id, `HTTP_400${errCode400 ? `_code_${errCode400}` : ""}`);
        this.addLog(`✗ Requisição inválida (código ${errCode400 ?? "?"}): discord.gg/${item.invite_code}`);
        return;
      }

      // ── 403 — Ban / permission / detection ───────────────────────────────────
      if (res.status === 403) {
        const errCode = parseErrorCode(res);

        if (errCode === 40007) {
          // Before treating as ban, re-check membership.
          // Discord sometimes returns 40007 as a false positive from anti-bot
          // detection even when the join actually succeeded or the account is
          // already a member.
          if (guildId) {
            const recheck = await rest.getGuildMember(guildId);
            if (recheck.status === 200) {
              await this.doneItem(item.id, guildId, guildName);
              this.counter++;
              this.addLog(`✓ Entrou no servidor (40007 era falso positivo de detecção): ${guildName ?? item.invite_code}`);
              return;
            }
          }

          // First attempt: wait and retry once (transient anti-bot detection)
          if (attempts === 1) {
            this.addLog(`⚠ Erro 40007 (tentativa ${attempts}) — pode ser detecção temporária. Aguardando 4s e tentando novamente…`);
            await sleep(4_000);
            continue;
          }

          // Second attempt still 40007: re-check membership one last time
          if (guildId) {
            const finalCheck = await rest.getGuildMember(guildId);
            if (finalCheck.status === 200) {
              await this.doneItem(item.id, guildId, guildName);
              this.counter++;
              this.addLog(`✓ Conta está no servidor após retentativa (40007 era falso positivo): ${guildName ?? item.invite_code}`);
              return;
            }
          }

          // Confirmed: real ban or unrecoverable detection block
          await this.failItem(item.id, "HTTP_403_code_40007_banido");
          this.addLog(`✗ Conta banida deste servidor: ${guildName ?? item.invite_code}`);
          return;
        }

        // Other known 403 codes
        const friendly = DISCORD_ERROR_MESSAGES[errCode ?? -1] ?? null;
        const reason403 = `HTTP_403${errCode ? `_code_${errCode}` : ""}`;
        await this.failItem(item.id, reason403);
        this.addLog(
          `✗ Sem permissão${friendly ? ` — ${friendly}` : ` (código ${errCode ?? "?"})`}: discord.gg/${item.invite_code}`
        );
        return;
      }

      // ── Generic error ─────────────────────────────────────────────────────────
      const errCode = parseErrorCode(res);
      const reason = `HTTP_${res.status}${errCode ? `_code_${errCode}` : ""}`;
      const friendlyMsg = DISCORD_ERROR_MESSAGES[errCode ?? -1] ?? null;
      await this.failItem(item.id, reason);
      this.addLog(
        `✗ Falhou (${reason})${friendlyMsg ? ` — ${friendlyMsg}` : ""}: discord.gg/${item.invite_code}`
      );
      return;
    }

    await this.failItem(item.id, "rate_limit_esgotado");
    this.addLog(`✗ Rate limit esgotado após ${attempts} tentativas: discord.gg/${item.invite_code}`);
  }

  private async solveHCaptcha(apiKey: string, sitekey: string, url: string): Promise<string | null> {
    try {
      const res = await fetch("https://nopecha.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: apiKey, type: "hcaptcha", sitekey, url }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      return (data?.data as string) ?? null;
    } catch {
      return null;
    }
  }

  private async doneItem(id: number, guildId: string | null, guildName: string | null): Promise<void> {
    await query(
      `UPDATE org_queue SET status = 'done', result_guild_id = $2, result_guild_name = $3, processed_at = NOW()
       WHERE id = $1`,
      [id, guildId, guildName],
    );
  }

  private async failItem(id: number, reason: string): Promise<void> {
    await query(
      `UPDATE org_queue SET status = 'failed', error_reason = $2, processed_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  }

  private async getConfig(): Promise<OrgJoinerConfig> {
    const rows = await query<OrgJoinerConfig>(
      `SELECT ojc.nopecha_key, ojc.delay_min_ms, ojc.delay_max_ms, ojc.enabled,
              tp.value AS token_value, tp.id AS pool_id
       FROM org_joiner_config ojc
       LEFT JOIN org_joiner_token_selection ojts ON ojts.instance_id = ojc.instance_id
       LEFT JOIN token_pool tp ON tp.id = ojts.token_pool_id
       WHERE ojc.instance_id = $1`,
      [this.instanceId],
    );
    return rows[0] ?? { pool_id: null, token_value: null, nopecha_key: null, delay_min_ms: 300_000, delay_max_ms: 720_000, enabled: false };
  }
}
