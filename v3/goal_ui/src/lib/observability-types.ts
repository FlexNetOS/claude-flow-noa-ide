export type VisualizerEventType =
  | "task_received"
  | "task_split"
  | "task_assigned"
  | "agent_spawned"
  | "agent_started"
  | "agent_completed"
  | "agent_failed"
  | "consensus_started"
  | "consensus_completed"
  | "memory_updated"
  | "websocket_connected"
  | "synthesis_started"
  | "synthesis_completed";

export interface VisualizerEvent {
  eventId: string;
  sequence: number;
  timestamp: string;
  version: 1;
  sourceRuntime: "ruflo";
  sourceEventType: string;
  eventType: VisualizerEventType;
  sessionId: string;
  correlationId?: string;
  causationId?: string;
  taskId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
  metadata?: {
    severity?: "info" | "warn" | "error";
    tags?: string[];
  };
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  eventCount: number;
  startedAt: string;
  updatedAt: string;
  activeAgents: number;
  completedTasks: number;
  failedTasks: number;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "agent" | "task" | "memory";
  status?: "idle" | "queued" | "active" | "completed" | "failed" | "retrying";
  role?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "assignment" | "communication" | "dependency" | "split" | "memory_write" | "memory_propagation";
  status?: "idle" | "active" | "completed" | "failed";
}

export interface TimelineSpan {
  id: string;
  kind: "agent" | "consensus" | "synthesis";
  label: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "failed";
}

export interface ConsensusRecord {
  taskId: string;
  proposal: string;
  state: "open" | "closed";
  voters: string[];
  votes: Array<{ agentId: string; choice: string; weight?: number }>;
  accepted?: boolean;
  decision?: string | null;
  startedAt: string;
  completedAt?: string;
}

export interface MemoryRecord {
  eventId: string;
  timestamp: string;
  namespace: string;
  key: string;
  operation: "store" | "update" | "delete";
  writer?: string;
  propagatedTo: string[];
  taskId?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  summary: SessionSummary;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  timeline: {
    spans: TimelineSpan[];
    recentEvents: VisualizerEvent[];
  };
  consensus: {
    records: ConsensusRecord[];
  };
  memory: {
    operations: MemoryRecord[];
  };
  lastSequence: number;
  generatedAt: string;
}

export type ConnectionState = "idle" | "connecting" | "live" | "replaying" | "error";
