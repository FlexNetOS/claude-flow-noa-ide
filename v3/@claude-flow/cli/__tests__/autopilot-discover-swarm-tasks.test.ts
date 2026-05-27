/**
 * Regression guard for the autopilot ↔ swarm-tasks dispatch gap.
 *
 * Symptom (pre-fix): autopilot_enable accepted `taskSources: [...,
 * 'swarm-tasks', ...]` and echoed it back, but autopilot_progress.bySource
 * never reported any swarm tasks even when `task_list` (MCP) returned
 * dozens. Root cause: `discoverTasks('swarm-tasks')` read from
 * `.claude-flow/swarm-tasks.json` — a file no MCP tool ever writes.
 * The canonical task store written by task_create / task_assign in
 * mcp-tools/task-tools.ts is `.claude-flow/tasks/store.json` with shape
 * `{ tasks: { <taskId>: TaskRecord } }`.
 *
 * Fix: `discoverTasks` now reads the canonical store + still falls back to
 * the legacy path so a downstream tool writing the old shape isn't dropped
 * on the floor mid-migration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverTasks } from '../src/autopilot-state.js';

describe('autopilot discoverTasks(swarm-tasks) — storage location fix', () => {
  let tmpRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'autopilot-swarm-tasks-'));
    mkdirSync(join(tmpRoot, '.claude-flow', 'tasks'), { recursive: true });
    // `discoverTasks` uses `resolve('.claude-flow/...')` which is
    // cwd-relative. vitest runs test files in worker threads where
    // `process.chdir()` is forbidden, so we spy on `process.cwd()`
    // instead — same effect for `path.resolve`.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Canonical case — `.claude-flow/tasks/store.json` shape matches what
   * task-tools.ts:saveTaskStore writes. This is the bug this PR fixes.
   */
  it('reads canonical .claude-flow/tasks/store.json written by task_create', () => {
    const store = {
      tasks: {
        'task-1779658721501-a0fjes': {
          taskId: 'task-1779658721501-a0fjes',
          type: 'feature',
          description: 'Add vitest harness to frontend',
          status: 'in_progress',
          priority: 'high',
          progress: 0,
          assignedTo: ['gg-coder-1779658711922-zzf1'],
          tags: [],
          createdAt: '2026-05-24T21:38:41.501Z',
          startedAt: '2026-05-24T21:39:30.000Z',
          completedAt: null,
        },
        'task-1779658729410-r82xnf': {
          taskId: 'task-1779658729410-r82xnf',
          type: 'bugfix',
          description: 'SKU-prefix category override',
          status: 'completed',
          priority: 'high',
          progress: 100,
          assignedTo: ['gg-coder-1779658711922-y9lo'],
          tags: [],
          createdAt: '2026-05-24T21:38:49.410Z',
          startedAt: '2026-05-24T21:39:35.000Z',
          completedAt: '2026-05-24T21:45:00.000Z',
        },
      },
      version: '3.0.0',
    };
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'tasks', 'store.json'),
      JSON.stringify(store, null, 2),
    );

    const tasks = discoverTasks(['swarm-tasks']);
    expect(tasks).toHaveLength(2);

    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(byId['task-1779658721501-a0fjes']).toMatchObject({
      id: 'task-1779658721501-a0fjes',
      subject: 'Add vitest harness to frontend',
      status: 'in_progress',
      source: 'swarm-tasks',
    });
    expect(byId['task-1779658729410-r82xnf']).toMatchObject({
      status: 'completed',
      source: 'swarm-tasks',
    });
  });

  it('autopilot progress now sees in_progress + completed swarm tasks', () => {
    const store = {
      tasks: {
        a: { taskId: 'a', description: 'A', status: 'pending' },
        b: { taskId: 'b', description: 'B', status: 'in_progress' },
        c: { taskId: 'c', description: 'C', status: 'completed' },
        d: { taskId: 'd', description: 'D', status: 'failed' },
      },
      version: '3.0.0',
    };
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'tasks', 'store.json'),
      JSON.stringify(store),
    );

    const tasks = discoverTasks(['swarm-tasks']);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.source === 'swarm-tasks')).toBe(true);
    expect(tasks.map((t) => t.status).sort()).toEqual(
      ['completed', 'failed', 'in_progress', 'pending'],
    );
  });

  /**
   * Back-compat — the legacy file path is still honored so a downstream
   * tool/script writing the old shape isn't silently dropped while the
   * canonical store is gradually adopted.
   */
  it('legacy .claude-flow/swarm-tasks.json (array shape) still works', () => {
    const legacy = [
      { id: 'legacy-1', subject: 'Legacy 1', status: 'pending' },
      { taskId: 'legacy-2', description: 'Legacy 2', status: 'completed' },
    ];
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'swarm-tasks.json'),
      JSON.stringify(legacy),
    );

    const tasks = discoverTasks(['swarm-tasks']);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id).sort()).toEqual(['legacy-1', 'legacy-2']);
  });

  it('legacy .claude-flow/swarm-tasks.json (object-with-tasks-array shape) still works', () => {
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'swarm-tasks.json'),
      JSON.stringify({ tasks: [{ id: 'x', description: 'X', status: 'pending' }] }),
    );

    const tasks = discoverTasks(['swarm-tasks']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'x', subject: 'X' });
  });

  it('returns empty when neither file exists (no throw)', () => {
    expect(discoverTasks(['swarm-tasks'])).toEqual([]);
  });

  it('returns empty when canonical store is malformed (no throw, no leak across sources)', () => {
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'tasks', 'store.json'),
      '{ malformed json',
    );
    expect(discoverTasks(['swarm-tasks'])).toEqual([]);
  });

  /**
   * #1916 dispatch-gap regression — before this fix, configuring
   * taskSources: ['swarm-tasks'] and writing tasks via task_create
   * resulted in autopilot enumerating zero tasks. This asserts the
   * autopilot loop now sees them as soon as task_create writes them.
   */
  it('#1916 — autopilot taskSources:[swarm-tasks] enumerates task_create output', () => {
    // Simulate what task-tools.ts:saveTaskStore writes when task_create
    // is called with two tasks.
    const store = {
      tasks: {
        't1': { taskId: 't1', description: 'first', status: 'pending', assignedTo: ['agent-1'] },
        't2': { taskId: 't2', description: 'second', status: 'in_progress', assignedTo: ['agent-2'] },
      },
      version: '3.0.0',
    };
    writeFileSync(
      join(tmpRoot, '.claude-flow', 'tasks', 'store.json'),
      JSON.stringify(store),
    );

    const tasks = discoverTasks(['team-tasks', 'swarm-tasks']);
    const swarmOnly = tasks.filter((t) => t.source === 'swarm-tasks');
    expect(swarmOnly).toHaveLength(2);
    expect(swarmOnly.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });
});
