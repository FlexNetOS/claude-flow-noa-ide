/**
 * QueenDispatcher — the loop that closes the ADR-072 / #1916 dispatch gap.
 *
 * Background. `task_assign` (mcp-tools/task-tools.ts) is a pure registry
 * write: it sets `assignedTo` + flips `status` to `in_progress` and that's
 * it. Nothing was previously polling the registry to actually RUN the
 * assigned tasks. `autopilot_enable` exists but its loop only counts tasks
 * for termination (now that L1 makes it SEE swarm tasks) — it never
 * dispatched.
 *
 * This module owns the dispatch. Once a tick:
 *   1. Read `.claude-flow/tasks/store.json` for tasks where
 *      `status ∈ {pending, in_progress}` AND `assignedTo.length > 0`.
 *   2. For each, look up the assigned agent in
 *      `.claude-flow/agents/store.json`.
 *   3. If neither the task nor the agent is currently in-flight, hand it
 *      to `HeadlessWorkerExecutor.executeArbitrary()` with the agent's
 *      system prompt + the task's description as the user prompt.
 *   4. On completion, write back to the task store (`status=completed`
 *      on success, `failed` on non-zero exit, `result` carries the
 *      executor output preview + executionId + durationMs).
 *
 * Concurrency model: one task per agent at any time (mirrors
 * task_assign's invariant of setting `agent.currentTask = taskId`).
 * Cross-agent concurrency is bounded by `maxConcurrent` (default 2 —
 * matches the executor pool default).
 *
 * The dispatcher is opt-in: WorkerDaemon constructs one only when
 * `daemon.queenDispatcher.enabled` is set. Tests can drive it directly.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { HeadlessWorkerExecutor, ArbitraryExecutionResult, SandboxMode } from './headless-worker-executor.js';

// ── Storage shapes (mirror what task-tools.ts + agent-execute-core.ts write) ──

interface TaskRecord {
  taskId: string;
  type?: string;
  description: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  assignedTo: string[];
  tags?: string[];
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  result?: Record<string, unknown>;
}

interface TaskStore {
  tasks: Record<string, TaskRecord>;
  version: string;
}

interface AgentRecord {
  agentId: string;
  agentType?: string;
  status?: 'idle' | 'busy' | 'active' | 'terminated';
  model?: 'haiku' | 'sonnet' | 'opus' | 'inherit';
  domain?: string;
  currentTask?: string | null;
  systemPrompt?: string;
  config?: Record<string, unknown>;
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version?: string;
}

// ── Public types ──────────────────────────────────────────────────────────

export interface QueenDispatcherConfig {
  /** Absolute path to the project root (where `.claude-flow/` lives). */
  projectRoot: string;
  /** The shared HeadlessWorkerExecutor instance. Required. */
  executor: HeadlessWorkerExecutor;
  /** Poll interval in ms. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Max concurrent dispatcher executions. Defaults to 2. */
  maxConcurrent?: number;
  /** Sandbox mode passed through to executeArbitrary. Defaults to 'permissive'. */
  sandbox?: SandboxMode;
  /** Per-execution timeout in ms passed through to executeArbitrary. */
  timeoutMs?: number;
}

export interface InflightEntry {
  taskId: string;
  agentId: string;
  startedAt: Date;
  executionId?: string;
}

// ── Implementation ────────────────────────────────────────────────────────

export class QueenDispatcher extends EventEmitter {
  private readonly cfg: Required<Omit<QueenDispatcherConfig, 'executor' | 'projectRoot' | 'timeoutMs'>> & {
    projectRoot: string;
    executor: HeadlessWorkerExecutor;
    timeoutMs: number | undefined;
  };
  private timer?: NodeJS.Timeout;
  private running = false;
  /** taskId → in-flight metadata. Prevents double-dispatch. */
  private inflightByTask: Map<string, InflightEntry> = new Map();
  /** agentId → taskId currently held. Enforces one-task-per-agent. */
  private inflightByAgent: Map<string, string> = new Map();

  constructor(config: QueenDispatcherConfig) {
    super();
    if (!config?.projectRoot) throw new Error('QueenDispatcher: projectRoot is required');
    if (!config?.executor) throw new Error('QueenDispatcher: executor is required');
    this.cfg = {
      projectRoot: config.projectRoot,
      executor: config.executor,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      maxConcurrent: config.maxConcurrent ?? 2,
      sandbox: config.sandbox ?? 'permissive',
      timeoutMs: config.timeoutMs,
    };
  }

  /** Start the periodic poll loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire one tick immediately so a freshly-started daemon doesn't make
    // the user wait pollIntervalMs for the first dispatch.
    void this.pollOnce().catch((err) => this.emit('error', err));
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err) => this.emit('error', err));
    }, this.cfg.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.emit('started', { pollIntervalMs: this.cfg.pollIntervalMs, maxConcurrent: this.cfg.maxConcurrent });
  }

  /** Stop the poll loop. Does NOT cancel in-flight executions. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.emit('stopped', { inflight: this.inflightByTask.size });
  }

  isRunning(): boolean {
    return this.running;
  }

  getInflight(): InflightEntry[] {
    return Array.from(this.inflightByTask.values());
  }

  /**
   * One scan of the task store. Each call:
   *   1. enumerates dispatchable (task, agent) pairs not already in-flight
   *   2. takes up to (maxConcurrent - inflight) of them
   *   3. fires them via executeArbitrary in parallel and awaits all
   *
   * Test entry point — production callers go through start().
   */
  async pollOnce(): Promise<void> {
    const taskStore = this.loadTaskStore();
    const agentStore = this.loadAgentStore();

    const candidates = this.pickDispatchable(taskStore, agentStore);
    if (candidates.length === 0) return;

    // Mark all selected pairs as in-flight BEFORE awaiting any execution
    // — otherwise a concurrent pollOnce() (or the next interval tick)
    // could re-dispatch the same row.
    const toFire: Array<{ task: TaskRecord; agent: AgentRecord }> = [];
    for (const c of candidates) {
      this.inflightByTask.set(c.task.taskId, {
        taskId: c.task.taskId,
        agentId: c.agent.agentId,
        startedAt: new Date(),
      });
      this.inflightByAgent.set(c.agent.agentId, c.task.taskId);
      toFire.push(c);
    }

    // Persist the in_progress + startedAt transition immediately so a
    // crashed/restarted dispatcher doesn't re-fire from `pending`.
    for (const { task } of toFire) {
      task.status = 'in_progress';
      if (!task.startedAt) task.startedAt = new Date().toISOString();
    }
    this.saveTaskStore(taskStore);

    // Fire all selected in parallel; the executor's own pool/queue
    // throttles to its maxConcurrent.
    await Promise.all(
      toFire.map(({ task, agent }) => this.runOne(task, agent)),
    );
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private pickDispatchable(taskStore: TaskStore, agentStore: AgentStore): Array<{ task: TaskRecord; agent: AgentRecord }> {
    const out: Array<{ task: TaskRecord; agent: AgentRecord }> = [];
    const headroom = Math.max(0, this.cfg.maxConcurrent - this.inflightByTask.size);
    if (headroom === 0) return out;

    for (const task of Object.values(taskStore.tasks)) {
      if (out.length >= headroom) break;
      if (task.status !== 'pending' && task.status !== 'in_progress') continue;
      if (!Array.isArray(task.assignedTo) || task.assignedTo.length === 0) continue;
      if (this.inflightByTask.has(task.taskId)) continue;

      // Pick the first assigned agent that exists in the registry and
      // isn't currently busy with another dispatched task.
      const agentId = task.assignedTo.find((id) => {
        const agent = agentStore.agents[id];
        if (!agent) return false;
        if (agent.status === 'terminated') return false;
        if (this.inflightByAgent.has(id)) return false;
        return true;
      });
      if (!agentId) continue;

      const agent = agentStore.agents[agentId];
      out.push({ task, agent });
    }
    return out;
  }

  private async runOne(task: TaskRecord, agent: AgentRecord): Promise<void> {
    const systemPrompt = this.buildSystemPrompt(agent);
    this.emit('dispatched', { taskId: task.taskId, agentId: agent.agentId });

    let result: ArbitraryExecutionResult;
    try {
      result = await this.cfg.executor.executeArbitrary({
        prompt: task.description,
        systemPrompt,
        sandbox: this.cfg.sandbox,
        model: this.normalizeModel(agent.model),
        timeoutMs: this.cfg.timeoutMs,
        label: `queen:${task.taskId}`,
      });
    } catch (err) {
      // Defensive — executeArbitrary normally returns an error result
      // rather than throwing, but a malformed input or a programmer
      // error could throw. Treat as a failed dispatch.
      const message = err instanceof Error ? err.message : String(err);
      this.completeTask(task, false, { error: message, label: `queen:${task.taskId}` });
      this.clearInflight(task.taskId, agent.agentId);
      this.emit('failed', { taskId: task.taskId, agentId: agent.agentId, error: message });
      return;
    }

    const success = result.success === true;
    this.completeTask(task, success, {
      success,
      executionId: result.executionId,
      durationMs: result.durationMs,
      model: result.model,
      sandboxMode: result.sandboxMode,
      // Preserve a short output preview — full transcript already lives
      // in `.claude-flow/logs/headless/<executionId>_result.log`.
      outputPreview: typeof result.output === 'string' ? result.output.slice(0, 4000) : '',
      outputLength: typeof result.output === 'string' ? result.output.length : 0,
      ...(result.error ? { error: result.error } : {}),
    });
    this.clearInflight(task.taskId, agent.agentId);
    this.emit(success ? 'completed' : 'failed', {
      taskId: task.taskId,
      agentId: agent.agentId,
      executionId: result.executionId,
      durationMs: result.durationMs,
    });
  }

  private buildSystemPrompt(agent: AgentRecord): string {
    if (typeof agent.systemPrompt === 'string' && agent.systemPrompt.length > 0) {
      return agent.systemPrompt;
    }
    // Mirror executeAgentTask's default when an agent record doesn't
    // carry an explicit prompt — keeps the two execution paths
    // (agent_execute / queen dispatch) producing the same default
    // identity for an agent.
    return (
      `You are a ${agent.agentType ?? 'worker'} agent operating as part of a Ruflo swarm. ` +
      `Agent ID: ${agent.agentId}. Domain: ${agent.domain ?? 'general'}. ` +
      `Respond directly and stay focused on the task. If you need information you don't have, state that explicitly.`
    );
  }

  private normalizeModel(model: AgentRecord['model']): 'haiku' | 'sonnet' | 'opus' {
    if (model === 'haiku' || model === 'opus') return model;
    // 'inherit', undefined, and anything else collapse to sonnet (matches
    // executeAgentTask + HEADLESS_WORKER_CONFIGS defaults).
    return 'sonnet';
  }

  private completeTask(task: TaskRecord, success: boolean, result: Record<string, unknown>): void {
    // Re-load the store rather than mutating the snapshot we took at
    // pollOnce() start — another writer (task_update, task_cancel) may
    // have moved the task. We re-find the row and patch it.
    const store = this.loadTaskStore();
    const live = store.tasks[task.taskId];
    if (!live) return;
    // Don't clobber a user cancel.
    if (live.status === 'cancelled') return;
    live.status = success ? 'completed' : 'failed';
    live.completedAt = new Date().toISOString();
    live.progress = success ? 100 : (live.progress ?? 0);
    live.result = result;
    this.saveTaskStore(store);
  }

  private clearInflight(taskId: string, agentId: string): void {
    this.inflightByTask.delete(taskId);
    if (this.inflightByAgent.get(agentId) === taskId) {
      this.inflightByAgent.delete(agentId);
    }
  }

  // ── File-store helpers (mirror task-tools.ts + agent-execute-core.ts) ──

  private taskStorePath(): string {
    return join(this.cfg.projectRoot, '.claude-flow', 'tasks', 'store.json');
  }
  private agentStorePath(): string {
    return join(this.cfg.projectRoot, '.claude-flow', 'agents', 'store.json');
  }

  private loadTaskStore(): TaskStore {
    try {
      const p = this.taskStorePath();
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as TaskStore;
    } catch { /* corrupt store → empty */ }
    return { tasks: {}, version: '3.0.0' };
  }

  private loadAgentStore(): AgentStore {
    try {
      const p = this.agentStorePath();
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as AgentStore;
    } catch { /* corrupt store → empty */ }
    return { agents: {} };
  }

  private saveTaskStore(store: TaskStore): void {
    const dir = join(this.cfg.projectRoot, '.claude-flow', 'tasks');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const target = this.taskStorePath();
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, target);
  }
}

export default QueenDispatcher;
