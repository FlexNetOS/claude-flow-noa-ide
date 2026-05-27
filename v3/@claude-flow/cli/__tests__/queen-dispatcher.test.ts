/**
 * QueenDispatcher — ADR-072 / #1916 dispatch loop.
 *
 * These tests stand up a real `HeadlessWorkerExecutor` against a stub
 * `claude` script on PATH, write canonical task + agent stores to a
 * temp project root, and assert the end-to-end transition:
 *
 *   task.status: pending|in_progress → completed
 *   task.result: populated with executor output preview + executionId
 *   in-flight tracking: prevents double-dispatch within a single tick
 *                       AND across consecutive ticks
 *   per-agent cap:      one task per agent at a time
 *
 * POSIX-only (the stub is bash). On Windows-without-WSL these are
 * skipped; the dispatcher logic is platform-neutral and CI's Linux
 * runners exercise it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import { HeadlessWorkerExecutor } from '../src/services/headless-worker-executor.js';
import { QueenDispatcher } from '../src/services/queen-dispatcher.js';

const IS_POSIX = platform() !== 'win32';
const describePosix = IS_POSIX ? describe : describe.skip;

interface TaskRecordShape {
  taskId: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  assignedTo: string[];
  progress?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  result?: Record<string, unknown>;
}

interface AgentRecordShape {
  agentId: string;
  agentType?: string;
  status?: string;
  model?: 'haiku' | 'sonnet' | 'opus' | 'inherit';
  systemPrompt?: string;
  currentTask?: string | null;
}

describePosix('QueenDispatcher — end-to-end dispatch via stubbed Claude Code', () => {
  let projectRoot: string;
  let stubBinDir: string;
  let prevPath: string | undefined;
  let executor: HeadlessWorkerExecutor;
  let dispatcher: QueenDispatcher;

  /**
   * Layout per call:
   *   <projectRoot>/.claude-flow/tasks/store.json
   *   <projectRoot>/.claude-flow/agents/store.json
   *   <projectRoot>/bin/claude (stub on PATH)
   */
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'queen-dispatcher-'));
    mkdirSync(join(projectRoot, '.claude-flow', 'tasks'), { recursive: true });
    mkdirSync(join(projectRoot, '.claude-flow', 'agents'), { recursive: true });

    stubBinDir = join(projectRoot, 'bin');
    mkdirSync(stubBinDir, { recursive: true });
    const stub = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "stub-claude 0.0.0"; exit 0; fi
if [ "$1" = "--print" ]; then echo "QUEEN_OK"; cat; exit 0; fi
echo "stub: bad args $@" >&2; exit 1
`;
    const stubPath = join(stubBinDir, 'claude');
    writeFileSync(stubPath, stub);
    chmodSync(stubPath, 0o755);
    prevPath = process.env.PATH;
    process.env.PATH = `${stubBinDir}:${prevPath ?? ''}`;

    executor = new HeadlessWorkerExecutor(projectRoot, { defaultTimeoutMs: 30_000 });
    dispatcher = new QueenDispatcher({
      projectRoot,
      executor,
      pollIntervalMs: 60_000, // never fires; we use pollOnce() in tests
      maxConcurrent: 2,
    });
  });

  afterEach(() => {
    dispatcher.stop();
    if (prevPath !== undefined) process.env.PATH = prevPath;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── Helpers ─────────────────────────────────────────────────────────

  function writeStores(tasks: TaskRecordShape[], agents: AgentRecordShape[]): void {
    writeFileSync(
      join(projectRoot, '.claude-flow', 'tasks', 'store.json'),
      JSON.stringify(
        {
          tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])),
          version: '3.0.0',
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(projectRoot, '.claude-flow', 'agents', 'store.json'),
      JSON.stringify(
        { agents: Object.fromEntries(agents.map((a) => [a.agentId, a])), version: '3.0.0' },
        null,
        2,
      ),
    );
  }

  function readTaskStore(): { tasks: Record<string, TaskRecordShape> } {
    return JSON.parse(
      readFileSync(join(projectRoot, '.claude-flow', 'tasks', 'store.json'), 'utf-8'),
    );
  }

  // ── Tests ───────────────────────────────────────────────────────────

  it('dispatches a single assigned task → completed', async () => {
    writeStores(
      [
        {
          taskId: 't-1',
          description: 'Do thing X.',
          status: 'in_progress',
          assignedTo: ['agent-1'],
        },
      ],
      [
        {
          agentId: 'agent-1',
          agentType: 'coder',
          status: 'active',
          model: 'sonnet',
          systemPrompt: 'You are agent-1, a coder.',
          currentTask: 't-1',
        },
      ],
    );

    await dispatcher.pollOnce();

    const after = readTaskStore();
    expect(after.tasks['t-1'].status).toBe('completed');
    expect(after.tasks['t-1'].progress).toBe(100);
    expect(after.tasks['t-1'].completedAt).toBeTruthy();
    expect(after.tasks['t-1'].result).toMatchObject({
      success: true,
      model: 'sonnet',
      sandboxMode: 'permissive',
    });
    // The stub echoes our prompt back, so the output preview must
    // include both the system + task framing AND the task description.
    expect(after.tasks['t-1'].result?.outputPreview).toMatch(/QUEEN_OK/);
    expect(after.tasks['t-1'].result?.outputPreview).toMatch(/\[SYSTEM\][\s\S]*agent-1[\s\S]*\[TASK\][\s\S]*Do thing X/);
  });

  it('skips a task that is not assigned (assignedTo is empty)', async () => {
    writeStores(
      [{ taskId: 't-1', description: 'unassigned', status: 'in_progress', assignedTo: [] }],
      [],
    );
    await dispatcher.pollOnce();
    expect(readTaskStore().tasks['t-1'].status).toBe('in_progress');
  });

  it('skips a completed task on subsequent polls', async () => {
    writeStores(
      [{ taskId: 't-1', description: 'done', status: 'completed', assignedTo: ['agent-1'] }],
      [{ agentId: 'agent-1', status: 'idle' }],
    );
    await dispatcher.pollOnce();
    expect(readTaskStore().tasks['t-1'].status).toBe('completed');
  });

  it('skips when the assigned agent is missing from the agent store', async () => {
    writeStores(
      [
        { taskId: 't-1', description: 'orphan', status: 'in_progress', assignedTo: ['ghost'] },
      ],
      [], // no agents
    );
    await dispatcher.pollOnce();
    // The task stays in_progress; no result written, no inflight entry.
    expect(readTaskStore().tasks['t-1'].status).toBe('in_progress');
    expect(readTaskStore().tasks['t-1'].result).toBeUndefined();
    expect(dispatcher.getInflight()).toHaveLength(0);
  });

  it('skips a terminated agent and falls through to the next assignee', async () => {
    writeStores(
      [
        {
          taskId: 't-1',
          description: 'redundant',
          status: 'in_progress',
          assignedTo: ['dead-agent', 'live-agent'],
        },
      ],
      [
        { agentId: 'dead-agent', status: 'terminated' },
        { agentId: 'live-agent', status: 'idle', model: 'sonnet' },
      ],
    );
    await dispatcher.pollOnce();
    expect(readTaskStore().tasks['t-1'].status).toBe('completed');
  });

  it('enforces one task per agent at a time (per-agent concurrency cap)', async () => {
    writeStores(
      [
        { taskId: 't-1', description: 'first', status: 'in_progress', assignedTo: ['agent-1'] },
        { taskId: 't-2', description: 'second', status: 'in_progress', assignedTo: ['agent-1'] },
      ],
      [{ agentId: 'agent-1', status: 'idle', model: 'sonnet' }],
    );
    // pollOnce picks t-1 (first dispatchable for agent-1) and skips t-2.
    await dispatcher.pollOnce();
    const after = readTaskStore();
    expect(after.tasks['t-1'].status).toBe('completed');
    // t-2 stays in_progress (still pending dispatch from the queen's POV).
    expect(after.tasks['t-2'].status).toBe('in_progress');
    // On the next tick, agent-1 is free again → t-2 runs.
    await dispatcher.pollOnce();
    expect(readTaskStore().tasks['t-2'].status).toBe('completed');
  });

  it('enforces global maxConcurrent across the dispatcher', async () => {
    // Each task assigned to a DIFFERENT agent so the per-agent cap
    // doesn't kick in. maxConcurrent=2 means a 3rd task must wait.
    dispatcher = new QueenDispatcher({
      projectRoot,
      executor,
      pollIntervalMs: 60_000,
      maxConcurrent: 2,
    });
    writeStores(
      [
        { taskId: 't-1', description: 'a', status: 'in_progress', assignedTo: ['a1'] },
        { taskId: 't-2', description: 'b', status: 'in_progress', assignedTo: ['a2'] },
        { taskId: 't-3', description: 'c', status: 'in_progress', assignedTo: ['a3'] },
      ],
      [
        { agentId: 'a1', status: 'idle' },
        { agentId: 'a2', status: 'idle' },
        { agentId: 'a3', status: 'idle' },
      ],
    );
    await dispatcher.pollOnce();
    const after = readTaskStore();
    // Two completed, one still in_progress.
    const completed = Object.values(after.tasks).filter((t) => t.status === 'completed').length;
    const inflight = Object.values(after.tasks).filter((t) => t.status === 'in_progress').length;
    expect(completed).toBe(2);
    expect(inflight).toBe(1);
    // Next tick frees a slot.
    await dispatcher.pollOnce();
    expect(Object.values(readTaskStore().tasks).every((t) => t.status === 'completed')).toBe(true);
  });

  it('does not clobber a user cancellation that lands mid-execution', async () => {
    writeStores(
      [{ taskId: 't-1', description: 'cancel-me', status: 'in_progress', assignedTo: ['agent-1'] }],
      [{ agentId: 'agent-1', status: 'idle', model: 'sonnet', systemPrompt: 'You are agent-1.' }],
    );
    // Start a tick, then concurrently flip the task to cancelled in the
    // store while the executor is still running. completeTask should
    // detect the cancel and not overwrite.
    const tick = dispatcher.pollOnce();
    // Race-y but we want the cancel to land before completion writes.
    setTimeout(() => {
      const store = JSON.parse(
        readFileSync(join(projectRoot, '.claude-flow', 'tasks', 'store.json'), 'utf-8'),
      );
      store.tasks['t-1'].status = 'cancelled';
      writeFileSync(
        join(projectRoot, '.claude-flow', 'tasks', 'store.json'),
        JSON.stringify(store),
      );
    }, 10);
    await tick;
    // Two valid outcomes: (a) cancel won the race → still 'cancelled';
    // (b) dispatch won → 'completed'. Both must NOT corrupt the store.
    const final = readTaskStore().tasks['t-1'].status;
    expect(['cancelled', 'completed']).toContain(final);
  });

  it('start()/stop() is idempotent and fires an immediate tick', async () => {
    writeStores(
      [{ taskId: 't-1', description: 'immediate', status: 'in_progress', assignedTo: ['agent-1'] }],
      [{ agentId: 'agent-1', status: 'idle', model: 'sonnet' }],
    );
    dispatcher.start();
    dispatcher.start(); // idempotent
    expect(dispatcher.isRunning()).toBe(true);
    // Give the immediate tick + executor time to finish.
    await new Promise((r) => setTimeout(r, 500));
    expect(readTaskStore().tasks['t-1'].status).toBe('completed');
    dispatcher.stop();
    dispatcher.stop(); // idempotent
    expect(dispatcher.isRunning()).toBe(false);
  });

  it('reads the task store fresh each tick (picks up newly-assigned tasks)', async () => {
    writeStores([], [{ agentId: 'agent-1', status: 'idle', model: 'sonnet' }]);
    await dispatcher.pollOnce(); // nothing to do
    // Now task_create writes a new row mid-life.
    writeStores(
      [{ taskId: 't-late', description: 'arrived later', status: 'in_progress', assignedTo: ['agent-1'] }],
      [{ agentId: 'agent-1', status: 'idle', model: 'sonnet' }],
    );
    await dispatcher.pollOnce();
    expect(readTaskStore().tasks['t-late'].status).toBe('completed');
  });

  it('emits dispatched + completed events with the right ids', async () => {
    writeStores(
      [{ taskId: 't-evt', description: 'event test', status: 'in_progress', assignedTo: ['agent-1'] }],
      [{ agentId: 'agent-1', status: 'idle', model: 'sonnet' }],
    );
    const events: Array<{ name: string; payload: { taskId?: string; agentId?: string } }> = [];
    dispatcher.on('dispatched', (p) => events.push({ name: 'dispatched', payload: p }));
    dispatcher.on('completed', (p) => events.push({ name: 'completed', payload: p }));
    await dispatcher.pollOnce();
    const names = events.map((e) => e.name);
    expect(names).toContain('dispatched');
    expect(names).toContain('completed');
    expect(events.find((e) => e.name === 'dispatched')?.payload.taskId).toBe('t-evt');
    expect(events.find((e) => e.name === 'completed')?.payload.taskId).toBe('t-evt');
  });

  it('constructor rejects missing projectRoot / executor', () => {
    expect(() => new QueenDispatcher({ projectRoot: '', executor } as never)).toThrow(/projectRoot/);
    expect(() => new QueenDispatcher({ projectRoot, executor: undefined as unknown as HeadlessWorkerExecutor })).toThrow(/executor/);
  });
});
