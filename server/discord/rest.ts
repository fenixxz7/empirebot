const BASE = "https://discord.com/api/v10";
const BASE_V9 = "https://discord.com/api/v9";

// Headers que o cliente web do Discord envia — necessários para endpoints como /users/@me/message-requests
const SUPER_PROPERTIES = Buffer.from(
  JSON.stringify({
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: "pt-BR",
    browser_user_agent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    browser_version: "124.0.0.0",
    os_version: "10",
    referrer: "https://discord.com/",
    referring_domain: "discord.com",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: 312547,
    client_event_source: null,
  })
).toString("base64");

const DISCORD_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "x-super-properties": SUPER_PROPERTIES,
  "x-discord-locale": "pt-BR",
  "x-discord-timezone": "America/Sao_Paulo",
  "accept-language": "pt-BR,pt;q=0.9",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DiscordResponse<T = unknown> {
  status: number;
  data: T | null;
  error?: string;
}

export class DiscordRest {
  constructor(private readonly token: string) {}

  requestV9<T = unknown>(method: string, path: string, body?: unknown) {
    return this.requestBase<T>(BASE_V9, method, path, body);
  }

  request<T = unknown>(method: string, path: string, body?: unknown) {
    return this.requestBase<T>(BASE, method, path, body);
  }

  async requestBase<T = unknown>(
    base: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<DiscordResponse<T>> {
    const url = `${base}${path}`;
    let attempts = 0;
    let rateLimitRetries = 0;
    while (true) {
      attempts += 1;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          // Timeout de 10s por tentativa — evita promise pendurada
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: this.token,
            "content-type": "application/json",
            ...DISCORD_HEADERS,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        const name = (err as Error).name;
        // TimeoutError / AbortError — não retentar, retorna imediatamente
        if (name === "TimeoutError" || name === "AbortError") {
          return {
            status: 0,
            data: null,
            error: `fetch_timeout:${method}:${path}`,
          };
        }
        if (attempts >= 3) {
          return {
            status: 0,
            data: null,
            error: (err as Error).message,
          };
        }
        await sleep(750 * attempts);
        continue;
      }

      if (res.status === 429) {
        // Limita retries de rate-limit: máx 3 vezes, espera máx 8s por vez.
        // Antes não tinha limite → loop infinito travando a promise.
        if (rateLimitRetries >= 3) {
          return {
            status: 429,
            data: null,
            error: `rate_limited_after_${rateLimitRetries}_retries:${method}:${path}`,
          };
        }
        rateLimitRetries += 1;
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Math.min(8_000, Math.max(500, (j.retry_after ?? 1) * 1000));
        await sleep(wait + 200);
        continue;
      }

      // Retry em 5xx com backoff exponencial (máx 3 tentativas)
      if (res.status >= 500 && attempts < 3) {
        await sleep(Math.min(8_000, 1_000 * Math.pow(2, attempts - 1)));
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        return {
          status: res.status,
          data: null,
          error: text.slice(0, 2000),
        };
      }
      let data: T | null = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = null;
        }
      }
      return { status: res.status, data };
    }
  }

  listGuildChannels(guildId: string) {
    return this.request<DiscordChannel[]>("GET", `/guilds/${guildId}/channels`);
  }

  /** GET /channels/:id — usado para confirmar se um canal é DM ou guild
   *  quando o gateway entrega MESSAGE_CREATE ambíguo (sem guild_id/member). */
  getChannel(channelId: string) {
    return this.request<DiscordChannel & { guild_id?: string; type?: number }>(
      "GET",
      `/channels/${channelId}`,
    );
  }

  listGuildActiveThreads(guildId: string) {
    return this.request<{
      threads: DiscordChannel[];
      members: Array<{ id: string; user_id: string }>;
    }>("GET", `/guilds/${guildId}/threads/active`);
  }

  channelMessages(channelId: string, limit = 25) {
    return this.request<DiscordMessage[]>(
      "GET",
      `/channels/${channelId}/messages?limit=${limit}`,
    );
  }

  fetchMessage(channelId: string, messageId: string) {
    return this.request<DiscordMessage>(
      "GET",
      `/channels/${channelId}/messages/${messageId}`,
    );
  }

  channelPins(channelId: string) {
    return this.request<DiscordMessage[]>("GET", `/channels/${channelId}/pins`);
  }

  /** Dispara o "está digitando…" no canal (POST /channels/:id/typing). */
  triggerTyping(channelId: string) {
    return this.request<unknown>("POST", `/channels/${channelId}/typing`);
  }

  /** Lista os DM message requests pendentes do usuário autenticado.
   *  /users/@me/message-requests retorna 404 — usamos o endpoint de canais
   *  com include_non_channeled=true e filtramos por is_message_request=true.
   */
  listMessageRequests() {
    return this.requestV9<DiscordDMChannel[]>(
      "GET",
      `/users/@me/channels?include_non_channeled=true`,
    );
  }

  /** Retorna a resposta bruta (texto) de MÚLTIPLOS endpoints candidatos para diagnóstico. */
  async listMessageRequestsRaw(): Promise<Array<{ status: number; text: string; url: string }>> {
    const endpoints = [
      `https://discord.com/api/v9/users/@me/message-requests`,
      `https://discord.com/api/v9/users/@me/message-requests?limit=100`,
      `https://discord.com/api/v10/users/@me/message-requests`,
      `https://discord.com/api/v9/users/@me/channels?include_non_channeled=true`,
    ];
    const results: Array<{ status: number; text: string; url: string }> = [];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            authorization: this.token,
            "content-type": "application/json",
            ...DISCORD_HEADERS,
          },
        });
        const text = await res.text();
        results.push({ status: res.status, text: text.slice(0, 8000), url });
      } catch (err) {
        results.push({ status: 0, text: (err as Error).message, url });
      }
    }
    return results;
  }

  /** Envia uma mensagem numa DM (para selfbot, isso aceita o request implicitamente). */
  sendDM(channelId: string, content: string) {
    return this.request<{ id: string }>(
      "POST",
      `/channels/${channelId}/messages`,
      { content },
    );
  }

  sendMessage(channelId: string, content: string, imageUrl?: string | null) {
    const body: Record<string, unknown> = { content };
    if (imageUrl && imageUrl.trim()) {
      body.embeds = [{ image: { url: imageUrl.trim() } }];
    }
    return this.request<{ id: string }>(
      "POST",
      `/channels/${channelId}/messages`,
      body,
    );
  }

  /**
   * Clica num botão de mensagem como o usuário (selfbot).
   * Usa o endpoint genérico de interactions do Discord.
   */
  clickButton(opts: {
    guildId: string;
    channelId: string;
    messageId: string;
    applicationId: string;
    sessionId: string;
    customId: string;
  }) {
    const nonce = snowflake();
    return this.request<unknown>("POST", "/interactions", {
      type: 3,
      guild_id: opts.guildId,
      channel_id: opts.channelId,
      message_id: opts.messageId,
      message_flags: 0,
      application_id: opts.applicationId,
      session_id: opts.sessionId,
      data: {
        component_type: 2,
        custom_id: opts.customId,
      },
      nonce,
    });
  }
}

const DISCORD_EPOCH = 1420070400000;
function snowflake(): string {
  // 64-bit snowflake aproximado (suficiente como nonce)
  const ms = BigInt(Date.now() - DISCORD_EPOCH);
  return ((ms << 22n) | BigInt(Math.floor(Math.random() * 4096))).toString();
}

export interface DiscordDMChannel {
  id: string;
  type: number; // 1 = DM
  recipients?: Array<{ id: string; username: string; global_name?: string }>;
  is_message_request?: boolean;
  is_message_request_timestamp?: string;
  last_message_id?: string | null;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  parent_id: string | null;
  position?: number;
  guild_id?: string;
  permission_overwrites?: Array<{ id: string; type: number; allow?: string; deny?: string }>;
  thread_metadata?: { archived?: boolean; locked?: boolean };
  member?: { user_id?: string };
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
}

export interface DiscordButton {
  type: number; // 2 = button
  style?: number;
  label?: string;
  custom_id?: string;
  disabled?: boolean;
  url?: string;
}

export interface DiscordActionRow {
  type: number; // 1 = action row
  components?: DiscordButton[];
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; username: string; bot?: boolean };
  application_id?: string;
  content: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  pinned?: boolean;
  timestamp?: string;
}
