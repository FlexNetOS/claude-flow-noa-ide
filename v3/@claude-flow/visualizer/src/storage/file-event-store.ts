import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary, VisualizerEvent } from "../contracts/events.js";

export class FileEventStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  append(event: VisualizerEvent): void {
    appendFileSync(this.getFilePath(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
  }

  loadSession(sessionId: string): VisualizerEvent[] {
    const filePath = this.getFilePath(sessionId);
    if (!existsSync(filePath)) {
      return [];
    }

    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VisualizerEvent)
      .sort((left, right) => left.sequence - right.sequence);
  }

  loadAfterSequence(sessionId: string, sequence: number): VisualizerEvent[] {
    return this.loadSession(sessionId).filter((event) => event.sequence > sequence);
  }

  listSessions(): SessionSummary[] {
    return readdirSync(this.baseDir)
      .filter((entry) => entry.endsWith(".ndjson"))
      .map((entry) => entry.replace(/\.ndjson$/, ""))
      .map((sessionId) => this.toSummary(sessionId))
      .filter((summary): summary is SessionSummary => summary !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private toSummary(sessionId: string): SessionSummary | null {
    const events = this.loadSession(sessionId);
    if (events.length === 0) {
      return null;
    }

    const activeAgents = new Set(
      events.filter((event) => event.eventType === "agent_started").map((event) => event.agentId).filter(Boolean)
    ).size;

    return {
      sessionId,
      title: `Session ${sessionId}`,
      eventCount: events.length,
      startedAt: events[0].timestamp,
      updatedAt: events[events.length - 1].timestamp,
      activeAgents,
      completedTasks: events.filter((event) => event.eventType === "agent_completed").length,
      failedTasks: events.filter((event) => event.eventType === "agent_failed").length
    };
  }

  private getFilePath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.ndjson`);
  }
}
