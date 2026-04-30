const BASE = "https://discord.com/api/v10";

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

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<DiscordResponse<T>> {
    const url = `${BASE}${path}`;
    let attempts = 0;
    while (true) {
      attempts += 1;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: this.token,
            "content-type": "application/json",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
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
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const wait = Math.min(15_000, Math.max(500, (j.retry_after ?? 1) * 1000));
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
          error: text.slice(0, 300),
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

  sendMessage(channelId: string, content: string, imageUrl?: string | null) {
    const body: Record<string, unknown> = {
      content,
      allowed_mentions: { parse: ["users"] },
    };
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
  content: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  pinned?: boolean;
  timestamp?: string;
}
