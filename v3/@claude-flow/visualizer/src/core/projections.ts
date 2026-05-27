import type {
  ConsensusProjection,
  ConsensusProjectionRecord,
  GraphEdge,
  GraphNode,
  MemoryProjection,
  MemoryProjectionRecord,
  SessionSnapshot,
  SessionSummary,
  TimelineProjection,
  TimelineSpan,
  VisualizerEvent
} from "../contracts/events.js";

export function buildSnapshot(sessionId: string, events: VisualizerEvent[]): SessionSnapshot {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const spans = new Map<string, TimelineSpan>();
  const consensusRecords = new Map<string, ConsensusProjectionRecord>();
  const memoryRecords: MemoryProjectionRecord[] = [];

  for (const event of events) {
    if (event.agentId) {
      ensureNode(nodes, {
        id: event.agentId,
        label: event.agentId,
        kind: "agent",
        status: "idle"
      });
    }

    if (event.taskId) {
      ensureNode(nodes, {
        id: event.taskId,
        label: event.taskId,
        kind: "task",
        status: "queued"
      });
    }

    switch (event.eventType) {
      case "task_split": {
        const payload = event.payload as { childTaskIds?: string[]; edges?: Array<{ source: string; target: string; kind: "split" | "depends_on" }> };
        for (const childTaskId of payload.childTaskIds ?? []) {
          ensureNode(nodes, {
            id: childTaskId,
            label: childTaskId,
            kind: "task",
            status: "queued"
          });
        }
        for (const edge of payload.edges ?? []) {
          edges.set(`${edge.source}:${edge.target}:${edge.kind}`, {
            id: `${edge.source}:${edge.target}:${edge.kind}`,
            source: edge.source,
            target: edge.target,
            kind: edge.kind === "split" ? "split" : "dependency",
            status: "completed"
          });
        }
        break;
      }
      case "task_assigned": {
        if (event.taskId && event.agentId) {
          edges.set(`${event.taskId}:${event.agentId}:assignment`, {
            id: `${event.taskId}:${event.agentId}:assignment`,
            source: event.taskId,
            target: event.agentId,
            kind: "assignment",
            status: "active"
          });
        }
        break;
      }
      case "agent_started": {
        if (event.agentId) {
          ensureNode(nodes, {
            id: event.agentId,
            label: event.agentId,
            kind: "agent",
            status: "active"
          }).status = "active";
          spans.set(event.agentId, {
            id: event.agentId,
            kind: "agent",
            label: event.agentId,
            startedAt: event.timestamp,
            status: "active"
          });
        }
        if (event.taskId) {
          ensureNode(nodes, {
            id: event.taskId,
            label: event.taskId,
            kind: "task",
            status: "active"
          }).status = "active";
        }
        break;
      }
      case "agent_completed": {
        if (event.agentId) {
          ensureNode(nodes, {
            id: event.agentId,
            label: event.agentId,
            kind: "agent",
            status: "completed"
          }).status = "completed";
          const span = spans.get(event.agentId);
          if (span) {
            span.endedAt = event.timestamp;
            span.status = "completed";
          }
        }
        if (event.taskId) {
          ensureNode(nodes, {
            id: event.taskId,
            label: event.taskId,
            kind: "task",
            status: "completed"
          }).status = "completed";
        }
        break;
      }
      case "agent_failed": {
        if (event.agentId) {
          ensureNode(nodes, {
            id: event.agentId,
            label: event.agentId,
            kind: "agent",
            status: "failed"
          }).status = "failed";
          const span = spans.get(event.agentId);
          if (span) {
            span.endedAt = event.timestamp;
            span.status = "failed";
          }
        }
        if (event.taskId) {
          ensureNode(nodes, {
            id: event.taskId,
            label: event.taskId,
            kind: "task",
            status: "failed"
          }).status = "failed";
        }
        break;
      }
      case "consensus_started": {
        if (!event.taskId) {
          break;
        }
        const payload = event.payload as { proposal?: string; voters?: string[] };
        consensusRecords.set(event.taskId, {
          taskId: event.taskId,
          proposal: payload.proposal ?? "Consensus proposal",
          state: "open",
          voters: payload.voters ?? [],
          votes: [],
          startedAt: event.timestamp
        });
        spans.set(`consensus:${event.taskId}`, {
          id: `consensus:${event.taskId}`,
          kind: "consensus",
          label: `Consensus ${event.taskId}`,
          startedAt: event.timestamp,
          status: "active"
        });
        break;
      }
      case "consensus_completed": {
        if (!event.taskId) {
          break;
        }
        const payload = event.payload as {
          votes?: Array<{ agentId: string; choice: string; weight?: number }>;
          accepted?: boolean;
          decision?: string | null;
        };
        const existing = consensusRecords.get(event.taskId);
        if (existing) {
          existing.state = "closed";
          existing.votes = payload.votes ?? [];
          existing.accepted = payload.accepted;
          existing.decision = payload.decision;
          existing.completedAt = event.timestamp;
        }
        const span = spans.get(`consensus:${event.taskId}`);
        if (span) {
          span.endedAt = event.timestamp;
          span.status = payload.accepted ? "completed" : "failed";
        }
        break;
      }
      case "memory_updated": {
        const payload = event.payload as {
          namespace?: string;
          key?: string;
          operation?: "store" | "update" | "delete";
          propagatedTo?: string[];
        };
        const memoryNodeId = `memory:${payload.namespace ?? "default"}:${payload.key ?? "key"}`;
        ensureNode(nodes, {
          id: memoryNodeId,
          label: payload.key ?? "memory",
          kind: "memory"
        });
        if (event.agentId) {
          edges.set(`${event.agentId}:${memoryNodeId}:write`, {
            id: `${event.agentId}:${memoryNodeId}:write`,
            source: event.agentId,
            target: memoryNodeId,
            kind: "memory_write",
            status: "completed"
          });
        }
        for (const target of payload.propagatedTo ?? []) {
          ensureNode(nodes, {
            id: target,
            label: target,
            kind: "agent",
            status: "idle"
          });
          edges.set(`${memoryNodeId}:${target}:propagation`, {
            id: `${memoryNodeId}:${target}:propagation`,
            source: memoryNodeId,
            target,
            kind: "memory_propagation",
            status: "completed"
          });
        }
        memoryRecords.push({
          eventId: event.eventId,
          timestamp: event.timestamp,
          namespace: payload.namespace ?? "default",
          key: payload.key ?? "memory",
          operation: payload.operation ?? "update",
          writer: event.agentId,
          propagatedTo: payload.propagatedTo ?? [],
          taskId: event.taskId
        });
        break;
      }
      case "synthesis_started": {
        spans.set("synthesis", {
          id: "synthesis",
          kind: "synthesis",
          label: "Final synthesis",
          startedAt: event.timestamp,
          status: "active"
        });
        break;
      }
      case "synthesis_completed": {
        const span = spans.get("synthesis");
        if (span) {
          span.endedAt = event.timestamp;
          span.status = "completed";
        }
        break;
      }
      default:
        break;
    }
  }

  const summary = createSummary(sessionId, events, nodes);
  const timeline: TimelineProjection = {
    spans: Array.from(spans.values()),
    recentEvents: events.slice(-150)
  };
  const consensus: ConsensusProjection = { records: Array.from(consensusRecords.values()) };
  const memory: MemoryProjection = { operations: memoryRecords.slice(-100) };

  return {
    sessionId,
    summary,
    graph: {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values())
    },
    timeline,
    consensus,
    memory,
    lastSequence: events.at(-1)?.sequence ?? 0,
    generatedAt: new Date().toISOString()
  };
}

function createSummary(sessionId: string, events: VisualizerEvent[], nodes: Map<string, GraphNode>): SessionSummary {
  const now = new Date().toISOString();
  const startedAt = events[0]?.timestamp ?? now;
  const updatedAt = events.at(-1)?.timestamp ?? now;
  return {
    sessionId,
    title: `Swarm session ${sessionId}`,
    eventCount: events.length,
    startedAt,
    updatedAt,
    activeAgents: Array.from(nodes.values()).filter((node) => node.kind === "agent" && node.status === "active").length,
    completedTasks: events.filter((event) => event.eventType === "agent_completed").length,
    failedTasks: events.filter((event) => event.eventType === "agent_failed").length
  };
}

function ensureNode(nodes: Map<string, GraphNode>, node: GraphNode): GraphNode {
  const existing = nodes.get(node.id);
  if (existing) {
    return existing;
  }
  nodes.set(node.id, node);
  return node;
}
