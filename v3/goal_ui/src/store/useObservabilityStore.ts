import { create } from "zustand";
import type { ConnectionState, SessionSnapshot, VisualizerEvent } from "@/lib/observability-types";

interface ObservabilityState {
  connectionState: ConnectionState;
  error?: string;
  activeSessionId?: string;
  snapshot?: SessionSnapshot;
  liveEvents: VisualizerEvent[];
  replayEvents: VisualizerEvent[];
  setConnectionState: (state: ConnectionState) => void;
  setError: (error?: string) => void;
  hydrate: (snapshot: SessionSnapshot, recentEvents: VisualizerEvent[]) => void;
  appendEvents: (events: VisualizerEvent[], replay: boolean) => void;
  setActiveSessionId: (sessionId: string) => void;
  resetReplay: () => void;
}

export const useObservabilityStore = create<ObservabilityState>((set) => ({
  connectionState: "idle",
  liveEvents: [],
  replayEvents: [],
  setConnectionState: (connectionState) => set({ connectionState }),
  setError: (error) => set({ error, connectionState: error ? "error" : "idle" }),
  hydrate: (snapshot, recentEvents) =>
    set({
      snapshot,
      activeSessionId: snapshot.sessionId,
      liveEvents: recentEvents,
      replayEvents: [],
      connectionState: "live",
      error: undefined
    }),
  appendEvents: (events, replay) =>
    set((state) => {
      if (!state.snapshot && events.length === 0) {
        return state;
      }
      const baseSnapshot = state.snapshot;
      const nextSnapshot = baseSnapshot
        ? {
            ...baseSnapshot,
            lastSequence: events.at(-1)?.sequence ?? baseSnapshot.lastSequence,
            summary: {
              ...baseSnapshot.summary,
              eventCount: baseSnapshot.summary.eventCount + events.length,
              updatedAt: events.at(-1)?.timestamp ?? baseSnapshot.summary.updatedAt
            },
            timeline: {
              ...baseSnapshot.timeline,
              recentEvents: [...baseSnapshot.timeline.recentEvents, ...events].slice(-150)
            }
          }
        : state.snapshot;
      return {
        snapshot: nextSnapshot,
        replayEvents: replay ? events : state.replayEvents,
        liveEvents: replay ? state.liveEvents : [...state.liveEvents, ...events].slice(-200),
        connectionState: replay ? "replaying" : "live",
        error: undefined
      };
    }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  resetReplay: () => set({ replayEvents: [], connectionState: "live" })
}));
