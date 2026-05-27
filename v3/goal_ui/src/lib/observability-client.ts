import type { SessionSnapshot, VisualizerEvent } from "./observability-types";

const HTTP_URL = import.meta.env.VITE_VISUALIZER_HTTP_URL ?? "http://localhost:8787";
const WS_URL = import.meta.env.VITE_VISUALIZER_WS_URL ?? "ws://localhost:8787/ws/visualizer";

export async function fetchHealth() {
  const response = await fetch(`${HTTP_URL}/api/health`);
  return response.json() as Promise<{ ok: boolean; transport: string; sessionCount: number }>;
}

export async function fetchSessions() {
  const response = await fetch(`${HTTP_URL}/api/sessions`);
  return response.json() as Promise<{ sessions: Array<{ sessionId: string; title: string; updatedAt: string; eventCount: number }> }>;
}

export async function seedSession(sessionId?: string) {
  const response = await fetch(`${HTTP_URL}/api/dev/seed-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });
  return response.json() as Promise<{ snapshot: SessionSnapshot }>;
}

export function createObservabilitySocket(handlers: {
  onOpen?: () => void;
  onSnapshot?: (snapshot: SessionSnapshot, recentEvents: VisualizerEvent[]) => void;
  onEvents?: (events: VisualizerEvent[], replay: boolean) => void;
  onReplayComplete?: (sessionId: string) => void;
  onError?: (message: string) => void;
}) {
  const socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => handlers.onOpen?.());

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as
      | { type: "bootstrap"; snapshot: SessionSnapshot; recentEvents: VisualizerEvent[] }
      | { type: "event_batch"; events: VisualizerEvent[] }
      | { type: "replay_event_batch"; events: VisualizerEvent[]; sessionId: string }
      | { type: "replay_complete"; sessionId: string }
      | { type: "error"; message: string }
      | { type: "connection_ack"; clientId: string };

    switch (message.type) {
      case "bootstrap":
        handlers.onSnapshot?.(message.snapshot, message.recentEvents);
        break;
      case "event_batch":
        handlers.onEvents?.(message.events, false);
        break;
      case "replay_event_batch":
        handlers.onEvents?.(message.events, true);
        break;
      case "replay_complete":
        handlers.onReplayComplete?.(message.sessionId);
        break;
      case "error":
        handlers.onError?.(message.message);
        break;
      default:
        break;
    }
  });

  socket.addEventListener("error", () => handlers.onError?.("WebSocket connection failed"));

  return {
    socket,
    subscribeSession(sessionId: string) {
      socket.send(JSON.stringify({ type: "subscribe_session", sessionId }));
    },
    requestReplay(sessionId: string) {
      socket.send(JSON.stringify({ type: "replay_request", sessionId }));
    },
    close() {
      socket.close();
    }
  };
}
