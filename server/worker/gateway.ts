import WebSocket from "ws";
import { EventEmitter } from "node:events";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export interface ReadyData {
  user_id: string;
  username: string;
  discriminator: string;
  global_name: string | null;
  display_handle: string;
  private_channels?: Array<{
    id: string;
    type: number;
    is_message_request?: boolean;
    is_message_request_timestamp?: string;
    recipients?: Array<{ id: string; username: string; global_name?: string | null }>;
  }>;
}

type GwEvents =
  | "ready"
  | "resumed"
  | "dispatch"
  | "close"
  | "fatal"
  | "debug";

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private firstHeartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval = 0;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private acked = true;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private userId: string | null = null;
  private ready = false;

  constructor(private readonly token: string, private readonly label = "token") {
    super();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getUserId(): string | null {
    return this.userId;
  }

  getToken(): string {
    return this.token;
  }

  isReady(): boolean {
    return this.ready && !!this.sessionId;
  }

  on(event: GwEvents, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000);
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    let url: string;
    if (this.resumeUrl) {
      url = this.resumeUrl.includes("?")
        ? this.resumeUrl
        : `${this.resumeUrl}/?v=10&encoding=json`;
    } else {
      url = GATEWAY_URL;
    }

    const ws = new WebSocket(url);
    this.ws = ws;
    this.acked = true;

    ws.on("open", () => this.emit("debug", `${this.label} ws open`));
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
    ws.on("error", (err) =>
      this.emit("debug", `${this.label} ws error: ${err.message}`),
    );
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.s !== null && msg.s !== undefined) this.lastSeq = msg.s;

    switch (msg.op) {
      case 10: {
        // HELLO
        this.heartbeatInterval = msg.d.heartbeat_interval;
        this.startHeartbeat();
        if (this.sessionId && this.resumeUrl) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }
      case 11:
        // HEARTBEAT ACK
        this.acked = true;
        break;
      case 1:
        // server requested heartbeat
        this.sendHeartbeat();
        break;
      case 7:
        // RECONNECT
        this.emit("debug", `${this.label} server asked reconnect`);
        this.softReconnect();
        break;
      case 9:
        // INVALID SESSION — start fresh after a small delay
        this.emit("debug", `${this.label} invalid session`);
        this.sessionId = null;
        this.resumeUrl = null;
        setTimeout(() => this.sendIdentify(), 1500 + Math.random() * 3500);
        break;
      case 0: {
        // DISPATCH
        if (msg.t === "READY") {
          this.sessionId = msg.d.session_id;
          this.resumeUrl = msg.d.resume_gateway_url;
          const user = msg.d.user ?? {};
          const discriminator = String(user.discriminator ?? "0");
          const handle =
            discriminator === "0"
              ? user.global_name
                ? `${user.username} (${user.global_name})`
                : user.username
              : `${user.username}#${discriminator}`;
          const ready: ReadyData = {
            user_id: String(user.id ?? ""),
            username: String(user.username ?? ""),
            discriminator,
            global_name: user.global_name ?? null,
            display_handle: handle,
            private_channels: msg.d.private_channels ?? [],
          };
          this.userId = ready.user_id;
          this.ready = true;
          // Assina eventos de thread em todas as guilds (OP 14)
          // Sem isso, Discord não envia CHANNEL_CREATE para threads privadas
          const guilds: Array<{ id: string }> = msg.d.guilds ?? [];
          for (const g of guilds) {
            if (g.id) {
              this.send({
                op: 14,
                d: {
                  guild_id: g.id,
                  typing: false,
                  threads: true,
                  activities: false,
                },
              });
            }
          }
          this.emit("ready", ready);
        } else if (msg.t === "RESUMED") {
          this.ready = true;
          this.emit("resumed");
        } else {
          // OP 14 também no GUILD_CREATE: guilds grandes chegam como unavailable
          // no READY e ficam disponíveis depois via GUILD_CREATE
          if (msg.t === "GUILD_CREATE" && msg.d?.id) {
            this.send({
              op: 14,
              d: {
                guild_id: msg.d.id,
                typing: false,
                threads: true,
                activities: false,
              },
            });
          }
          this.emit("dispatch", msg.t, msg.d);
        }
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const jitter = Math.random();
    this.firstHeartbeatTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.acked) {
          this.emit("debug", `${this.label} heartbeat not acked, reconnecting`);
          this.softReconnect();
          return;
        }
        this.sendHeartbeat();
      }, this.heartbeatInterval);
    }, this.heartbeatInterval * jitter);
  }

  private sendHeartbeat(): void {
    this.acked = false;
    this.send({ op: 1, d: this.lastSeq });
  }

  private sendIdentify(): void {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 16381,
        properties: {
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
          client_build_number: 310168,
          client_event_source: null,
        },
        presence: {
          status: "online",
          since: 0,
          activities: [],
          afk: false,
        },
        compress: false,
        client_state: {
          guild_versions: {},
          highest_last_message_id: "0",
          read_state_version: 0,
          user_guild_settings_version: -1,
          user_settings_version: -1,
          private_channels_version: "0",
          api_code_version: 0,
        },
      },
    });
  }

  private sendResume(): void {
    this.send({
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    });
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.emit("debug", `${this.label} send fail: ${(err as Error).message}`);
    }
  }

  private softReconnect(): void {
    if (this.ws) {
      try {
        this.ws.close(4000);
      } catch {
        /* noop */
      }
    }
  }

  private onClose(code: number, reason: string): void {
    this.ready = false;
    this.emit("close", code, reason);
    this.clearHeartbeat();
    this.ws = null;
    if (this.closed) return;

    // Codes that mean "do not reconnect"
    const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
    if (fatal.includes(code)) {
      // 4004 durante RESUME significa sessão expirada, não token inválido.
      // Nesse caso, limpa a sessão e tenta um IDENTIFY fresco antes de declarar fatal.
      // Só é verdadeiramente fatal se o 4004 ocorreu com sessionId=null (IDENTIFY novo).
      if (code === 4004 && this.sessionId !== null) {
        this.emit("debug", `${this.label} 4004 during resume — clearing session, retrying fresh identify`);
        this.sessionId = null;
        this.resumeUrl = null;
        const delay = 2000 + Math.random() * 3000;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        return;
      }
      this.emit("fatal", code);
      return;
    }

    const delay = 2000 + Math.random() * 3000;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.firstHeartbeatTimer) {
      clearTimeout(this.firstHeartbeatTimer);
      this.firstHeartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
