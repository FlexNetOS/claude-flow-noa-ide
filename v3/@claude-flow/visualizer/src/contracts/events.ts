export const visualizerEventTypes = [
  "task_received",
  "task_split",
  "task_assigned",
  "agent_spawned",
  "agent_started",
  "agent_completed",
  "agent_failed",
  "consensus_started",
  "consensus_completed",
  "memory_updated",
  "websocket_connected",
  "synthesis_started",
  "synthesis_completed"
] as const;

export type VisualizerEventType = (typeof visualizerEventTypes)[number];

export interface TaskSplitPayload {
  childTaskIds: string[];
  edges: Array<{ source: string; target: string; kind: "split" | "depends_on" }>;
  summary?: string;
}

export interface TaskAssignedPayload {
  taskTitle?: string;
  agentRole?: string;
  dependencyTaskIds?: string[];
  priority?: "low" | "normal" | "high" | "critical";
}

export interface AgentLifecyclePayload {
  agentName: string;
  agentRole: string;
  status?: "idle" | "active" | "completed" | "failed";
  detail?: string;
}

export interface AgentFailurePayload extends AgentLifecyclePayload {
  errorMessage: string;
  retryScheduled?: boolean;
  retryAttempt?: number;
}

export interface ConsensusPayload {
  proposal: string;
  voters: string[];
  votes?: Array<{ agentId: string; choice: string; weight?: number }>;
  decision?: string | null;
  accepted?: boolean;
  rejectedAlternatives?: string[];
  durationMs?: number;
}

export interface MemoryUpdatedPayload {
  namespace: string;
  key: string;
  operation: "store" | "update" | "delete";
  propagatedTo?: string[];
  summary?: string;
}

export interface SynthesisPayload {
  stage: "started" | "completed";
  summary?: string;
}

export type VisualizerPayload =
  | TaskSplitPayload
  | TaskAssignedPayload
  | AgentLifecyclePayload
  | AgentFailurePayload
  | ConsensusPayload
  | MemoryUpdatedPayload
  | SynthesisPayload
  | Record<string, unknown>;

export interface VisualizerEvent<TPayload = VisualizerPayload> {
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
  payload: TPayload;
  metadata?: {
    severity?: "info" | "warn" | "error";
    tags?: string[];
    raw?: unknown;
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

export interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TimelineSpan {
  id: string;
  kind: "agent" | "consensus" | "synthesis";
  label: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "failed";
}

export interface TimelineProjection {
  spans: TimelineSpan[];
  recentEvents: VisualizerEvent[];
}

export interface ConsensusProjectionRecord {
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

export interface ConsensusProjection {
  records: ConsensusProjectionRecord[];
}

export interface MemoryProjectionRecord {
  eventId: string;
  timestamp: string;
  namespace: string;
  key: string;
  operation: "store" | "update" | "delete";
  writer?: string;
  propagatedTo: string[];
  taskId?: string;
}

export interface MemoryProjection {
  operations: MemoryProjectionRecord[];
}

export interface SessionSnapshot {
  sessionId: string;
  summary: SessionSummary;
  graph: GraphProjection;
  timeline: TimelineProjection;
  consensus: ConsensusProjection;
  memory: MemoryProjection;
  lastSequence: number;
  generatedAt: string;
}
