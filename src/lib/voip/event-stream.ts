import { getClientId } from "./webrtc";

export type CallStatus =
  | "offering"
  | "answering"
  | "relay"
  | "active"
  | "ended"
  | "incoming";

type CallListRow = {
  sessionId: string;
  callId: string;
  owner: string | null;
  direction: "outbound" | "inbound";
  peer: string;
  startedAt: number;
  status: CallStatus;
  endedAt?: number;
  endReason?: string;
};

export type BrokerEvent =
  | { type: "session-list"; sessions: any[] }
  | { type: "session-qr"; sessionId: string; qr: string }
  | { type: "auth-state"; sessionId: string; paired: boolean; state: string; qr?: string }
  | { type: "call-list"; calls: CallListRow[] }
  | { type: "call-status"; sessionId: string; id: string; owner: string | null; status: CallStatus; peer: string; startedAt: number }
  | { type: "call-ended"; sessionId: string; id: string; owner: string | null; reason: string; endedAt: number }
  | { type: "incoming"; sessionId: string; id: string; peer: string; offeredAt: number }
  | { type: "incoming-claimed"; sessionId: string; id: string; owner: string };

type Listener = (ev: BrokerEvent) => void;

class EventStream {
  #es: EventSource | null = null;
  #listeners = new Set<Listener>();

  async connect(): Promise<void> {
    if (typeof window === "undefined" || this.#es) return;
    const clientId = getClientId();

    let baseUrl = "";
    try {
      const res = await apiFetch("/api/whatsapp/voip-url");
      const data = await res.json();
      baseUrl = data.url || "";
    } catch (err) {
      console.warn("[VoIP SSE] Failed to resolve VoIP URL, using fallback:", err);
    }

    if (!baseUrl) return;

    if (this.#es) return; // prevent race condition

    this.#es = new EventSource(`${baseUrl}/api/events?clientId=${encodeURIComponent(clientId)}`);
    this.#es.onmessage = (ev) => {
      try {
        const parsed: BrokerEvent = JSON.parse(ev.data);
        for (const l of this.#listeners) l(parsed);
      } catch {}
    };
    this.#es.onerror = () => {
      console.warn("[VoIP SSE] connection error, will retry...");
    };
  }

  on(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  close(): void {
    this.#es?.close();
    this.#es = null;
  }
}

export const voipEventStream = new EventStream();
import { apiFetch } from "@/lib/api-fetch";