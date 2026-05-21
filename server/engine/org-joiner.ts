import { query } from "../db/pool.js";
import { DiscordRest } from "../discord/rest.js";

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
  token_value: string | null;
  nopecha_key: string | null;
  delay_min_ms: number;
  delay_max_ms: number;
  enabled: boolean;
}

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
      const preview = await rest.getInvite(code);
      if (preview.status === 404 || (preview.data as any)?.code === 10006) {
        return { ok: false, error: "Convite inválido ou expirado." };
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

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      const res = await rest.acceptInvite(item.invite_code);

      if (res.status === 200 || res.status === 204) {
        const guildId = (res.data as any)?.guild?.id ?? null;
        const guildName = (res.data as any)?.guild?.name ?? null;
        await query(
          `UPDATE org_queue SET status = 'done', result_guild_id = $2, result_guild_name = $3, processed_at = NOW()
           WHERE id = $1`,
          [item.id, guildId, guildName],
        );
        this.counter++;
        this.addLog(`✓ Entrou em: ${guildName ?? item.invite_code}${guildId ? ` (${guildId})` : ""}`);
        return;
      }

      if (res.status === 429) {
        let waitMs = 5_000;
        try { waitMs = Math.min(30_000, ((res.data as any)?.retry_after ?? 5) * 1000 + 1000); } catch { /**/ }
        this.addLog(`Rate limit — aguardando ${Math.round(waitMs / 1000)}s… (tentativa ${attempts}/3)`);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 400) {
        const captchaKey = (res.data as any)?.captcha_key;
        if (captchaKey) {
          if (!config.nopecha_key?.trim()) {
            await this.failItem(item.id, "captcha_sem_chave_nopecha");
            this.addLog(`✗ CAPTCHA detectado mas sem chave NopeCHA configurada.`);
            return;
          }
          this.addLog(`CAPTCHA detectado — resolvendo via NopeCHA…`);
          const sitekey = (res.data as any)?.captcha_sitekey ?? "a9b5fb07-92ff-493f-86fe-352a2803b3df";
          const solved = await this.solveHCaptcha(config.nopecha_key.trim(), sitekey, "https://discord.com");
          if (!solved) {
            await this.failItem(item.id, "captcha_falhou");
            this.addLog(`✗ Falhou ao resolver CAPTCHA.`);
            return;
          }
          const res2 = await rest.acceptInviteWithCaptcha(item.invite_code, solved);
          if (res2.status === 200 || res2.status === 204) {
            const guildId = (res2.data as any)?.guild?.id ?? null;
            const guildName = (res2.data as any)?.guild?.name ?? null;
            await query(
              `UPDATE org_queue SET status = 'done', result_guild_id = $2, result_guild_name = $3, processed_at = NOW()
               WHERE id = $1`,
              [item.id, guildId, guildName],
            );
            this.counter++;
            this.addLog(`✓ Entrou (com captcha): ${guildName ?? item.invite_code}`);
            return;
          }
          const errCode2 = (res2.data as any)?.code;
          await this.failItem(item.id, `HTTP_${res2.status}${errCode2 ? `_code_${errCode2}` : ""}`);
          this.addLog(`✗ Falhou após resolver captcha: HTTP ${res2.status}`);
          return;
        }
      }

      const errCode = (res.data as any)?.code;
      const reason = `HTTP_${res.status}${errCode ? `_code_${errCode}` : ""}`;
      await this.failItem(item.id, reason);
      this.addLog(`✗ Falhou (${reason}): discord.gg/${item.invite_code}`);
      return;
    }

    await this.failItem(item.id, "rate_limit_esgotado");
    this.addLog(`✗ Rate limit esgotado após 3 tentativas: discord.gg/${item.invite_code}`);
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

  private async failItem(id: number, reason: string): Promise<void> {
    await query(
      `UPDATE org_queue SET status = 'failed', error_reason = $2, processed_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  }

  private async getConfig(): Promise<OrgJoinerConfig> {
    const rows = await query<OrgJoinerConfig>(
      `SELECT token_value, nopecha_key, delay_min_ms, delay_max_ms, enabled
       FROM org_joiner_config WHERE instance_id = $1`,
      [this.instanceId],
    );
    return rows[0] ?? { token_value: null, nopecha_key: null, delay_min_ms: 300_000, delay_max_ms: 720_000, enabled: false };
  }
}
