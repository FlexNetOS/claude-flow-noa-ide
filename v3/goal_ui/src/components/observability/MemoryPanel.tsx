import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionSnapshot } from "@/lib/observability-types";

interface MemoryPanelProps {
  snapshot?: SessionSnapshot;
}

export function MemoryPanel({ snapshot }: MemoryPanelProps) {
  return (
    <Card className="border-emerald-500/20 bg-slate-950/70">
      <CardHeader>
        <CardTitle className="text-slate-100">Shared Memory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {(snapshot?.memory.operations ?? []).slice(-5).reverse().map((record) => (
          <div key={record.eventId} className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium text-slate-100">
                {record.namespace}/{record.key}
              </p>
              <span className="text-xs uppercase tracking-[0.2em] text-emerald-300">{record.operation}</span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              writer: {record.writer ?? "system"} {record.propagatedTo.length > 0 ? `-> ${record.propagatedTo.join(", ")}` : ""}
            </p>
          </div>
        ))}
        {snapshot?.memory.operations.length === 0 && (
          <p className="text-sm text-slate-400">No shared memory propagation has been observed yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
