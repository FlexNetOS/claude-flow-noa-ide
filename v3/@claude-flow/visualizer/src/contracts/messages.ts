import type { SessionSnapshot, VisualizerEvent } from "./events.js";

export type ClientMessage =
  | { type: "subscribe_session"; sessionId: string }
  | { type: "unsubscribe_session"; sessionId: string }
  | { type: "replay_request"; sessionId: string; fromSequence?: number; speed?: number }
  | { type: "pause_replay" }
  | { type: "resume_replay" }
  | { type: "ping"; clientTime: string };

export type ServerMessage =
  | { type: "connection_ack"; clientId: string; serverTime: string }
  | { type: "bootstrap"; snapshot: SessionSnapshot; recentEvents: VisualizerEvent[] }
  | { type: "event_batch"; sessionId: string; events: VisualizerEvent[]; fromSequence: number; toSequence: number }
  | { type: "replay_event_batch"; sessionId: string; events: VisualizerEvent[]; fromSequence: number; toSequence: number }
  | { type: "replay_complete"; sessionId: string }
  | { type: "pong"; serverTime: string }
  | { type: "error"; code: string; message: string };
