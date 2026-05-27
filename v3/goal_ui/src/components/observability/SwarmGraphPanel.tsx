import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionSnapshot } from "@/lib/observability-types";

interface SwarmGraphPanelProps {
  snapshot?: SessionSnapshot;
}

const statusColor: Record<string, string> = {
  idle: "#6b7280",
  queued: "#f59e0b",
  active: "#22d3ee",
  completed: "#22c55e",
  failed: "#ef4444",
  retrying: "#f97316"
};

export function SwarmGraphPanel({ snapshot }: SwarmGraphPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !snapshot) {
      return;
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...snapshot.graph.nodes.map((node) => ({
          data: { id: node.id, label: node.label, kind: node.kind, status: node.status },
        })),
        ...snapshot.graph.edges.map((edge) => ({
          data: { id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, status: edge.status }
        }))
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": (element) => statusColor[element.data("status")] ?? "#94a3b8",
            label: "data(label)",
            color: "#e5e7eb",
            "font-size": 11,
            "text-valign": "center",
            "text-halign": "center",
            "border-width": 1,
            "border-color": "#0f172a",
            width: 42,
            height: 42
          }
        },
        {
          selector: 'node[kind = "task"]',
          style: { shape: "round-rectangle", width: 68, height: 32 }
        },
        {
          selector: 'node[kind = "memory"]',
          style: { shape: "diamond", width: 34, height: 34 }
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            opacity: 0.8
          }
        }
      ],
      layout: {
        name: "breadthfirst",
        padding: 24,
        directed: true,
        spacingFactor: 1.5
      }
    });

    return () => cy.destroy();
  }, [snapshot]);

  return (
    <Card className="border-sky-500/20 bg-slate-950/70 shadow-[0_0_40px_rgba(14,165,233,0.08)]">
      <CardHeader>
        <CardTitle className="text-slate-100">Swarm Graph</CardTitle>
      </CardHeader>
      <CardContent>
        <motion.div
          initial={{ opacity: 0.4, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          ref={containerRef}
          className="h-[340px] rounded-xl border border-slate-800 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.12),_transparent_35%),linear-gradient(180deg,#020617,#0f172a)]"
        />
      </CardContent>
    </Card>
  );
}
