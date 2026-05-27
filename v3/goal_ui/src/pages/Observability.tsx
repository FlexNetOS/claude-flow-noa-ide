import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Bot, RefreshCcw, Radar, TimerReset } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SwarmGraphPanel } from "@/components/observability/SwarmGraphPanel";
import { TimelinePanel } from "@/components/observability/TimelinePanel";
import { ConsensusPanel } from "@/components/observability/ConsensusPanel";
import { MemoryPanel } from "@/components/observability/MemoryPanel";
import { EventLogPanel } from "@/components/observability/EventLogPanel";
import { createObservabilitySocket, fetchHealth, fetchSessions, seedSession } from "@/lib/observability-client";
import { useObservabilityStore } from "@/store/useObservabilityStore";

export default function Observability() {
  const [serviceState, setServiceState] = useState<string>("checking");
  const [availableSessions, setAvailableSessions] = useState<Array<{ sessionId: string; title: string; updatedAt: string; eventCount: number }>>([]);
  const socketRef = useRef<ReturnType<typeof createObservabilitySocket> | null>(null);
  const {
    activeSessionId,
    connectionState,
    error,
    snapshot,
    liveEvents,
    replayEvents,
    setConnectionState,
    setError,
    setActiveSessionId,
    hydrate,
    appendEvents,
    resetReplay
  } = useObservabilityStore();

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [health, sessionsResponse] = await Promise.all([fetchHealth(), fetchSessions()]);
        if (cancelled) {
          return;
        }
        setServiceState(health.ok ? "online" : "offline");
        setAvailableSessions(sessionsResponse.sessions);
        const defaultSessionId = sessionsResponse.sessions[0]?.sessionId ?? "demo-ruflo-swarm";
        setActiveSessionId(defaultSessionId);
        setConnectionState("connecting");

        socketRef.current = createObservabilitySocket({
          onOpen: () => {
            setConnectionState("live");
            socketRef.current?.subscribeSession(defaultSessionId);
          },
          onSnapshot: (nextSnapshot, recentEvents) => hydrate(nextSnapshot, recentEvents),
          onEvents: (events, replay) => appendEvents(events, replay),
          onReplayComplete: () => setConnectionState("live"),
          onError: (message) => setError(message)
        });
      } catch (caughtError) {
        if (!cancelled) {
          setServiceState("offline");
          setError(caughtError instanceof Error ? caughtError.message : "Unable to reach visualizer service");
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
      socketRef.current?.close();
    };
  }, [appendEvents, hydrate, setActiveSessionId, setConnectionState, setError]);

  const visibleEvents = useMemo(() => (connectionState === "replaying" && replayEvents.length > 0 ? replayEvents : liveEvents), [
    connectionState,
    liveEvents,
    replayEvents
  ]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.18),_transparent_25%),radial-gradient(circle_at_bottom_right,_rgba(217,70,239,0.14),_transparent_30%),linear-gradient(180deg,#020617,#0f172a_60%,#020617)] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.35em] text-cyan-300">
                <Radar className="h-4 w-4" />
                Ruflo Swarm Visualizer
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
                Realtime orchestration visibility for local swarm sessions
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-slate-400 sm:text-base">
                Inspect task decomposition, agent execution, consensus, shared memory propagation, retries, and final synthesis as a live event stream.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                className="border-cyan-500/30 bg-slate-900/70 text-slate-100"
                onClick={async () => {
                  const seeded = await seedSession();
                  setAvailableSessions((sessions) => [
                    {
                      sessionId: seeded.snapshot.sessionId,
                      title: seeded.snapshot.summary.title,
                      updatedAt: seeded.snapshot.generatedAt,
                      eventCount: seeded.snapshot.summary.eventCount
                    },
                    ...sessions
                  ]);
                  setActiveSessionId(seeded.snapshot.sessionId);
                  socketRef.current?.subscribeSession(seeded.snapshot.sessionId);
                }}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                Seed Demo Session
              </Button>
              <Button
                variant="outline"
                className="border-fuchsia-500/30 bg-slate-900/70 text-slate-100"
                onClick={() => {
                  if (activeSessionId) {
                    resetReplay();
                    setConnectionState("replaying");
                    socketRef.current?.requestReplay(activeSessionId);
                  }
                }}
                disabled={!activeSessionId}
              >
                <TimerReset className="mr-2 h-4 w-4" />
                Replay Session
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard label="Service" value={serviceState} accent="cyan" icon={<Activity className="h-4 w-4" />} />
            <MetricCard label="Connection" value={connectionState} accent="violet" icon={<Radar className="h-4 w-4" />} />
            <MetricCard label="Sessions" value={String(availableSessions.length)} accent="emerald" icon={<Bot className="h-4 w-4" />} />
            <MetricCard label="Events" value={String(snapshot?.summary.eventCount ?? visibleEvents.length)} accent="amber" icon={<Activity className="h-4 w-4" />} />
          </div>

          {error && (
            <Card className="border-rose-500/20 bg-rose-950/20">
              <CardContent className="py-4 text-sm text-rose-200">{error}</CardContent>
            </Card>
          )}
        </motion.div>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <div className="space-y-6">
            <SwarmGraphPanel snapshot={snapshot} />
            <TimelinePanel snapshot={snapshot} events={visibleEvents} />
          </div>
          <div className="space-y-6">
            <Card className="border-slate-700 bg-slate-950/70">
              <CardContent className="space-y-3 py-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-100">Observed Sessions</h2>
                  <Badge variant="outline" className="border-slate-700 text-slate-300">
                    {activeSessionId ?? "none"}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {availableSessions.map((session) => (
                    <button
                      key={session.sessionId}
                      type="button"
                      className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                        session.sessionId === activeSessionId
                          ? "border-cyan-400/40 bg-cyan-500/10"
                          : "border-slate-800 bg-slate-900/70 hover:border-slate-700"
                      }`}
                      onClick={() => {
                        setActiveSessionId(session.sessionId);
                        socketRef.current?.subscribeSession(session.sessionId);
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm text-slate-100">{session.title}</span>
                        <span className="text-[11px] text-slate-500">{session.eventCount} events</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-400">{session.sessionId}</p>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
            <ConsensusPanel snapshot={snapshot} />
            <MemoryPanel snapshot={snapshot} />
          </div>
        </div>

        <EventLogPanel events={visibleEvents} />
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
  icon
}: {
  label: string;
  value: string;
  accent: "cyan" | "violet" | "emerald" | "amber";
  icon: ReactNode;
}) {
  const accentClass =
    accent === "cyan"
      ? "from-cyan-500/20 to-cyan-500/0 border-cyan-500/20 text-cyan-200"
      : accent === "violet"
        ? "from-violet-500/20 to-violet-500/0 border-violet-500/20 text-violet-200"
        : accent === "emerald"
          ? "from-emerald-500/20 to-emerald-500/0 border-emerald-500/20 text-emerald-200"
          : "from-amber-500/20 to-amber-500/0 border-amber-500/20 text-amber-200";

  return (
    <Card className={`border bg-gradient-to-br ${accentClass} bg-slate-950/60`}>
      <CardContent className="flex items-center justify-between py-5">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">{label}</p>
          <p className="mt-2 text-2xl font-semibold capitalize text-slate-50">{value}</p>
        </div>
        <div className="rounded-full border border-slate-800 bg-slate-900/80 p-3 text-slate-200">{icon}</div>
      </CardContent>
    </Card>
  );
}
