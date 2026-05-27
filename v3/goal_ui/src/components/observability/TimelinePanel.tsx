import { formatDistanceStrict, parseISO } from "date-fns";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SessionSnapshot, VisualizerEvent } from "@/lib/observability-types";

interface TimelinePanelProps {
  snapshot?: SessionSnapshot;
  events: VisualizerEvent[];
}

export function TimelinePanel({ snapshot, events }: TimelinePanelProps) {
  return (
    <Card className="border-violet-500/20 bg-slate-950/70">
      <CardHeader>
        <CardTitle className="text-slate-100">Execution Timeline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          {snapshot?.timeline.spans.slice(0, 3).map((span) => (
            <motion.div
              key={span.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-slate-800 bg-slate-900/80 p-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-100">{span.label}</span>
                <Badge variant="outline" className="border-slate-700 text-slate-300">
                  {span.status}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {span.endedAt
                  ? formatDistanceStrict(parseISO(span.startedAt), parseISO(span.endedAt))
                  : "In progress"}
              </p>
            </motion.div>
          ))}
        </div>
        <div className="space-y-2">
          {events.slice(-8).reverse().map((event) => (
            <div key={event.eventId} className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
              <div className="mt-1 h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.7)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-slate-100">{event.eventType.replaceAll("_", " ")}</span>
                  <span className="text-[11px] text-slate-500">{new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="truncate text-xs text-slate-400">
                  {event.agentId ?? event.taskId ?? event.sourceEventType}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
