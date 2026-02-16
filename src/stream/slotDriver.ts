import WebSocket from "ws";
import { loadConfig } from "../config.js";

export interface SlotListener {
  (slot: number): void;
}

export class SlotDriver {
  private ws?: WebSocket;
  private readonly listeners = new Set<SlotListener>();
  private readonly endpoint: string;

  constructor(endpoint?: string) {
    const cfg = loadConfig();
    this.endpoint = endpoint ?? cfg.rpc.wsPrimary ?? cfg.rpc.primary.replace("https://", "wss://");
  }

  start() {
    if (this.ws) return;
    this.ws = new WebSocket(this.endpoint);

    this.ws.on("open", () => {
      const msg = { jsonrpc: "2.0", id: 1, method: "slotsUpdatesSubscribe" };
      this.ws?.send(JSON.stringify(msg));
    });

    this.ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const slot = parsed?.params?.result?.slot as number | undefined;
        if (slot !== undefined) {
          this.listeners.forEach((l) => l(slot));
        }
      } catch (e) {
        // ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.ws = undefined;
      // simple reconnect
      setTimeout(() => this.start(), 1000);
    });

    this.ws.on("error", () => {
      this.ws?.close();
    });
  }

  stop() {
    this.ws?.close();
    this.ws = undefined;
  }

  onSlot(listener: SlotListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
