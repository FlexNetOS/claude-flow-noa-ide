import type { VisualizerEvent, VisualizerEventType } from "../contracts/events.js";

const agentRoles = ["architect-agent", "backend-agent", "websocket-agent", "frontend-agent", "graph-agent", "qa-agent"];

interface EventSeedInput {
  sessionId: string;
  sequenceStart?: number;
}

export function createSyntheticSessionEvents(input: EventSeedInput): VisualizerEvent[] {
  const sequenceStart = input.sequenceStart ?? 1;
  const baseTime = Date.now();
  const taskId = `task-${input.sessionId}`;
  const splitTaskIds = [`${taskId}-plan`, `${taskId}-build`, `${taskId}-verify`];
  const events: Array<Omit<VisualizerEvent, "eventId" | "sequence" | "timestamp" | "version" | "sourceRuntime"> & { offsetMs: number }> = [
    {
      offsetMs: 0,
      sourceEventType: "task:created",
      eventType: "task_received",
      sessionId: input.sessionId,
      taskId,
      payload: { title: "Visualize swarm execution", priority: "high" }
    },
    {
      offsetMs: 800,
      sourceEventType: "planner:decomposed",
      eventType: "task_split",
      sessionId: input.sessionId,
      taskId,
      payload: {
        childTaskIds: splitTaskIds,
        edges: [
          { source: taskId, target: splitTaskIds[0], kind: "split" },
          { source: splitTaskIds[0], target: splitTaskIds[1], kind: "depends_on" },
          { source: splitTaskIds[1], target: splitTaskIds[2], kind: "depends_on" }
        ],
        summary: "Decompose orchestration into planning, implementation, and verification"
      }
    }
  ];

  agentRoles.forEach((agentId, index) => {
    const assignedTaskId = splitTaskIds[index % splitTaskIds.length];
    events.push(
      {
        offsetMs: 1200 + index * 400,
        sourceEventType: "agent:spawned",
        eventType: "agent_spawned",
        sessionId: input.sessionId,
        agentId,
        taskId: assignedTaskId,
        payload: { agentName: agentId, agentRole: agentId, status: "idle" }
      },
      {
        offsetMs: 1600 + index * 550,
        sourceEventType: "task:assigned",
        eventType: "task_assigned",
        sessionId: input.sessionId,
        agentId,
        taskId: assignedTaskId,
        payload: { taskTitle: assignedTaskId, agentRole: agentId, priority: "high" }
      },
      {
        offsetMs: 2200 + index * 650,
        sourceEventType: "agent:busy",
        eventType: "agent_started",
        sessionId: input.sessionId,
        agentId,
        taskId: assignedTaskId,
        payload: { agentName: agentId, agentRole: agentId, status: "active", detail: "Executing assigned task" }
      }
    );
  });

  events.push(
    {
      offsetMs: 4200,
      sourceEventType: "memory:updated",
      eventType: "memory_updated",
      sessionId: input.sessionId,
      agentId: "architect-agent",
      taskId: splitTaskIds[0],
      payload: {
        namespace: "shared-memory",
        key: "execution-plan",
        operation: "store",
        propagatedTo: ["backend-agent", "frontend-agent"],
        summary: "Plan propagated through shared memory"
      }
    },
    {
      offsetMs: 5200,
      sourceEventType: "swarm:consensus:started",
      eventType: "consensus_started",
      sessionId: input.sessionId,
      taskId: splitTaskIds[1],
      payload: {
        proposal: "Accept graph schema and websocket contract",
        voters: ["architect-agent", "backend-agent", "websocket-agent", "frontend-agent"]
      }
    },
    {
      offsetMs: 6400,
      sourceEventType: "swarm:consensus:completed",
      eventType: "consensus_completed",
      sessionId: input.sessionId,
      taskId: splitTaskIds[1],
      payload: {
        proposal: "Accept graph schema and websocket contract",
        voters: ["architect-agent", "backend-agent", "websocket-agent", "frontend-agent"],
        votes: [
          { agentId: "architect-agent", choice: "accept", weight: 1 },
          { agentId: "backend-agent", choice: "accept", weight: 1 },
          { agentId: "websocket-agent", choice: "accept", weight: 1 },
          { agentId: "frontend-agent", choice: "reject", weight: 0.5 }
        ],
        accepted: true,
        decision: "accept",
        rejectedAlternatives: ["delay"],
        durationMs: 1200
      }
    }
  );

  agentRoles.forEach((agentId, index) => {
    const assignedTaskId = splitTaskIds[index % splitTaskIds.length];
    const failed = agentId === "qa-agent";
    const eventType: VisualizerEventType = failed ? "agent_failed" : "agent_completed";
    events.push({
      offsetMs: 7600 + index * 500,
      sourceEventType: failed ? "agent:error" : "task:completed",
      eventType,
      sessionId: input.sessionId,
      agentId,
      taskId: assignedTaskId,
      payload: failed
        ? {
            agentName: agentId,
            agentRole: agentId,
            status: "failed",
            errorMessage: "Validation suite exposed a replay cursor mismatch",
            retryScheduled: true,
            retryAttempt: 1
          }
        : {
            agentName: agentId,
            agentRole: agentId,
            status: "completed",
            detail: "Task completed successfully"
          }
    });
  });

  events.push(
    {
      offsetMs: 10400,
      sourceEventType: "synthesis:started",
      eventType: "synthesis_started",
      sessionId: input.sessionId,
      taskId,
      payload: { stage: "started", summary: "Synthesizing final operator-facing state" }
    },
    {
      offsetMs: 11600,
      sourceEventType: "synthesis:completed",
      eventType: "synthesis_completed",
      sessionId: input.sessionId,
      taskId,
      payload: { stage: "completed", summary: "Session ready for replay and inspection" }
    }
  );

  return events.map((event, index) => ({
    ...event,
    eventId: `${input.sessionId}-${sequenceStart + index}`,
    sequence: sequenceStart + index,
    timestamp: new Date(baseTime + event.offsetMs).toISOString(),
    version: 1,
    sourceRuntime: "ruflo"
  }));
}
