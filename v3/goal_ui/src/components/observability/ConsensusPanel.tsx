import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SessionSnapshot } from "@/lib/observability-types";

interface ConsensusPanelProps {
  snapshot?: SessionSnapshot;
}

export function ConsensusPanel({ snapshot }: ConsensusPanelProps) {
  return (
    <Card className="border-fuchsia-500/20 bg-slate-950/70">
      <CardHeader>
        <CardTitle className="text-slate-100">Consensus Flow</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {(snapshot?.consensus.records ?? []).map((record) => (
          <div key={record.taskId} className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-100">{record.proposal}</p>
                <p className="text-xs text-slate-400">Task {record.taskId}</p>
              </div>
              <Badge
                variant="outline"
                className={record.accepted ? "border-emerald-500/40 text-emerald-300" : "border-rose-500/40 text-rose-300"}
              >
                {record.accepted ? "accepted" : record.state}
              </Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {record.votes.map((vote) => (
                <span
                  key={`${record.taskId}-${vote.agentId}`}
                  className="rounded-full border border-slate-700 px-2 py-1 text-[11px] text-slate-300"
                >
                  {vote.agentId}: {vote.choice}
                </span>
              ))}
            </div>
          </div>
        ))}
        {snapshot?.consensus.records.length === 0 && (
          <p className="text-sm text-slate-400">No consensus rounds have been observed yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
