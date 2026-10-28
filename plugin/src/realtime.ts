import { HEARTBEAT_INTERVAL_MS, WS_CLOSE_UNAUTHORIZED, type ClientMessage, type ServerEvent } from "@team-sync/shared";

export type ConnectionStatus = "offline" | "connecting" | "online" | "unauthorized";

export interface RealtimeOptions {
  serverUrl(): string;
  token(): string;
  onEvent(event: ServerEvent): void;
  onStatus(status: ConnectionStatus): void;
}

const MAX_BACKOFF_MS = 30_000;

/** WebSocket to the server: receives changes and lock events, renews our locks, reconnects on its own. */
export class Realtime {
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = true;

  constructor(private readonly options: RealtimeOptions) {}

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.options.onStatus("offline");
  }

  /** Reconnects now, e.g. after the settings changed. */
  restart(): void {
    this.stop();
    this.start();
  }

  private open(): void {
    const base = this.options.serverUrl().replace(/\/+$/, "");
    const token = this.options.token();
    if (!base || !token) {
      this.options.onStatus(token ? "offline" : "unauthorized");
      return;
    }
    this.options.onStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({ type: "auth", token });
    });
    socket.addEventListener("message", (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "ready") {
        this.attempts = 0;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
        this.options.onStatus("online");
      }
      this.options.onEvent(event);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.teardown();
      if (this.stopped) return;
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        this.options.onStatus("unauthorized");
        return;
      }
      this.options.onStatus("offline");
      this.scheduleReconnect();
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private teardown(): void {
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts) * (0.75 + Math.random() / 2);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
