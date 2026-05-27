import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import cors from "cors";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { buildSnapshot } from "../core/projections.js";
import { SessionEventBus } from "../core/session-event-bus.js";
import { createSyntheticSessionEvents } from "../core/simulator.js";
import type { ClientMessage, ServerMessage } from "../contracts/messages.js";
import type { SessionSnapshot, VisualizerEvent } from "../contracts/events.js";
import { FileEventStore } from "../storage/file-event-store.js";

const ingestSchema = z.object({
  sessionId: z.string(),
  sourceEventType: z.string(),
  eventType: z.string(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
});

export interface VisualizerServerOptions {
  host?: string;
  port?: number;
  storageDir?: string;
}

export function createVisualizerServer(options: VisualizerServerOptions = {}) {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  const storageDir = options.storageDir ?? join(process.cwd(), ".claude-flow", "visualizer");
  mkdirSync(storageDir, { recursive: true });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const eventBus = new SessionEventBus();
  const eventStore = new FileEventStore(storageDir);
  const sessionSequence = new Map<string, number>();
  const sessionSnapshots = new Map<string, SessionSnapshot>();
  const subscriptions = new Map<string, Set<string>>();

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws/visualizer" });

  function rebuildSnapshot(sessionId: string): SessionSnapshot {
    const snapshot = buildSnapshot(sessionId, eventStore.loadSession(sessionId));
    sessionSnapshots.set(sessionId, snapshot);
    return snapshot;
  }

  function appendEvent(event: Omit<VisualizerEvent, "eventId" | "sequence" | "timestamp" | "version" | "sourceRuntime">): VisualizerEvent {
    const nextSequence = (sessionSequence.get(event.sessionId) ?? 0) + 1;
    sessionSequence.set(event.sessionId, nextSequence);

    const normalized: VisualizerEvent = {
      ...event,
      eventId: `${event.sessionId}-${nextSequence}`,
      sequence: nextSequence,
      timestamp: new Date().toISOString(),
      version: 1,
      sourceRuntime: "ruflo"
    };

    eventStore.append(normalized);
    rebuildSnapshot(event.sessionId);
    eventBus.publish(normalized);

    const message: ServerMessage = {
      type: "event_batch",
      sessionId: event.sessionId,
      events: [normalized],
      fromSequence: normalized.sequence,
      toSequence: normalized.sequence
    };

    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) {
        return;
      }
      const clientId = (client as typeof client & { clientId?: string }).clientId;
      if (!clientId) {
        return;
      }
      const activeSessions = subscriptions.get(clientId);
      if (!activeSessions || !activeSessions.has(event.sessionId)) {
        return;
      }
      client.send(JSON.stringify(message));
    });

    return normalized;
  }

  function seedSession(sessionId = `session-${Date.now()}`): SessionSnapshot {
    const events = createSyntheticSessionEvents({
      sessionId,
      sequenceStart: (sessionSequence.get(sessionId) ?? 0) + 1
    });
    for (const event of events) {
      sessionSequence.set(sessionId, event.sequence);
      eventStore.append(event);
    }
    return rebuildSnapshot(sessionId);
  }

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      transport: `ws://${host}:${port}/ws/visualizer`,
      sessionCount: eventStore.listSessions().length
    });
  });

  app.get("/api/sessions", (_request, response) => {
    response.json({ sessions: eventStore.listSessions() });
  });

  app.get("/api/sessions/:sessionId/snapshot", (request, response) => {
    response.json({ snapshot: sessionSnapshots.get(request.params.sessionId) ?? rebuildSnapshot(request.params.sessionId) });
  });

  app.get("/api/sessions/:sessionId/events", (request, response) => {
    const afterSequence = Number(request.query.afterSequence ?? 0);
    const sessionId = request.params.sessionId;
    const events = afterSequence > 0 ? eventStore.loadAfterSequence(sessionId, afterSequence) : eventStore.loadSession(sessionId);
    response.json({ events });
  });

  app.post("/api/dev/seed-session", (request, response) => {
    const sessionId = typeof request.body?.sessionId === "string" ? request.body.sessionId : `session-${Date.now()}`;
    response.status(201).json({ snapshot: seedSession(sessionId) });
  });

  app.post("/api/ingest/runtime-event", (request, response) => {
    const payload = ingestSchema.safeParse(request.body);
    if (!payload.success) {
      response.status(400).json({ error: payload.error.flatten() });
      return;
    }

    const event = appendEvent({
      sessionId: payload.data.sessionId,
      sourceEventType: payload.data.sourceEventType,
      eventType: payload.data.eventType as VisualizerEvent["eventType"],
      taskId: payload.data.taskId,
      agentId: payload.data.agentId,
      payload: payload.data.payload
    });

    response.status(202).json({ event });
  });

  wss.on("connection", (socket) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    (socket as typeof socket & { clientId?: string }).clientId = clientId;
    subscriptions.set(clientId, new Set());
    socket.send(JSON.stringify({ type: "connection_ack", clientId, serverTime: new Date().toISOString() } satisfies ServerMessage));

    socket.on("message", (rawMessage) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(rawMessage.toString()) as ClientMessage;
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "invalid_json", message: "Invalid websocket message" } satisfies ServerMessage));
        return;
      }

      switch (message.type) {
        case "subscribe_session": {
          subscriptions.get(clientId)?.add(message.sessionId);
          const snapshot = sessionSnapshots.get(message.sessionId) ?? rebuildSnapshot(message.sessionId);
          const recentEvents = eventStore.loadSession(message.sessionId).slice(-50);
          socket.send(JSON.stringify({ type: "bootstrap", snapshot, recentEvents } satisfies ServerMessage));
          break;
        }
        case "unsubscribe_session": {
          subscriptions.get(clientId)?.delete(message.sessionId);
          break;
        }
        case "replay_request": {
          const replayEvents = eventStore
            .loadSession(message.sessionId)
            .filter((event) => event.sequence >= (message.fromSequence ?? 1));
          socket.send(
            JSON.stringify({
              type: "replay_event_batch",
              sessionId: message.sessionId,
              events: replayEvents,
              fromSequence: replayEvents[0]?.sequence ?? 0,
              toSequence: replayEvents.at(-1)?.sequence ?? 0
            } satisfies ServerMessage)
          );
          socket.send(JSON.stringify({ type: "replay_complete", sessionId: message.sessionId } satisfies ServerMessage));
          break;
        }
        case "pause_replay":
        case "resume_replay":
          break;
        case "ping":
          socket.send(JSON.stringify({ type: "pong", serverTime: new Date().toISOString() } satisfies ServerMessage));
          break;
      }
    });

    socket.on("close", () => {
      subscriptions.delete(clientId);
    });
  });

  return {
    app,
    server,
    eventBus,
    eventStore,
    appendEvent,
    seedSession,
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(port, host, () => resolve());
      });
    }
  };
}
