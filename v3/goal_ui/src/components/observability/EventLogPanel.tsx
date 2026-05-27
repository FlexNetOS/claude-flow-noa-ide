import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VisualizerEvent } from "@/lib/observability-types";

interface EventLogPanelProps {
  events: VisualizerEvent[];
}

export function EventLogPanel({ events }: EventLogPanelProps) {
  return (
    <Card className="border-slate-700 bg-slate-950/70">
      <CardHeader>
        <CardTitle className="text-slate-100">Live Event Log</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[420px] rounded-xl border border-slate-800">
          <div className="space-y-2 p-3 font-mono text-xs">
            {events.slice().reverse().map((event) => (
              <div key={event.eventId} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Badge variant="outline" className="border-slate-700 text-slate-300">
                    {event.eventType}
                  </Badge>
                  <span className="text-slate-500">{new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-slate-300">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
