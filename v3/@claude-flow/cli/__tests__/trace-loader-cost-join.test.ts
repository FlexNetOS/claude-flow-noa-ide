/**
 * trace-loader cost-JOIN unit tests (Gap 4).
 *
 * Strategy
 * --------
 * The loader's cost-JOIN dynamic-imports `services/cost-recorder.js`. That
 * module is owned by `coder-cost-recorder` (parallel implementation) and
 * may not be present on disk in every test environment. We use Vitest's
 * `vi.mock` to provide an in-memory stub that returns whatever cost
 * entries the test fixture defines.
 *
 * Each test reseats the `cost-recorder` mock before re-importing the
 * loader so per-test fixtures take effect. Note: `vi.resetModules()` is
 * required because the loader's `await import(...)` resolves once and
 * is cached unless the module graph is reset.
 *
 * Coverage:
 *   - listCosts returning matching entries enriches steps with cost
 *   - listCosts returning [] leaves the trajectory unchanged (back-compat)
 *   - Inline cost on a step (preserved from store.json) wins over JOIN
 *   - totalCostUsd aggregates correctly across all entries
 *   - costByModel groups dispatches + sums per model
 *   - cacheHitRatio is computed from joined token usage
 *   - listCosts throwing is swallowed; trajectory still loads
 *   - Module-not-present is swallowed; trajectory still loads
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors trace-loader.test.ts so tests stay isolated).
// ---------------------------------------------------------------------------

let tmpClaudeRoot: string;
let prevInstallCtx: string | undefined;

function pinInstallContext(claudeRoot: string): void {
  process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
    packageRoot: claudeRoot,
    claudeRoot,
    dataDir: join(claudeRoot, '.claude-flow', 'data'),
    isGlobalInstall: true,
    projectRoot: null,
  });
}

function writeStore(entries: Record<string, unknown>): void {
  const dir = join(tmpClaudeRoot, '.claude-flow', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({ entries, version: '3.0.0' }),
    'utf-8',
  );
}

interface StepFixture {
  action: string;
  result: string;
  quality?: number;
  timestamp: string;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    };
  };
}

interface TrajectoryFixture {
  id: string;
  startedAt: string;
  agent?: string;
  task?: string;
  endedAt?: string;
  success?: boolean;
  steps?: StepFixture[];
}

function trajectoryEntry(opts: TrajectoryFixture) {
  const value: Record<string, unknown> = {
    id: opts.id,
    task: opts.task ?? `task-${opts.id}`,
    agent: opts.agent ?? 'coder',
    steps:
      opts.steps?.map((s) => {
        const out: Record<string, unknown> = {
          action: s.action,
          result: s.result,
          quality: s.quality ?? 0.5,
          timestamp: s.timestamp,
        };
        if (s.cost) out.cost = s.cost;
        return out;
      }) ?? [],
    startedAt: opts.startedAt,
  };
  if (opts.endedAt !== undefined) value.endedAt = opts.endedAt;
  if (opts.success !== undefined) value.success = opts.success;

  return {
    key: `trajectory-${opts.id}`,
    value,
    metadata: { type: 'trajectory' },
    storedAt: opts.startedAt,
    accessCount: 0,
    lastAccessed: opts.startedAt,
  };
}

// ---------------------------------------------------------------------------
// cost-recorder mock — installed at module-load via vi.mock with a factory
// that reads from a per-test mutable holder. Tests update the holder
// between runs; vi.resetModules() reseats the loader's cached import.
// ---------------------------------------------------------------------------

interface CostEntryFixture {
  timestamp: string;
  sessionId: string | null;
  stepIndex: number | null;
  agent: string;
  model: string;
  cacheTtl: '5m' | '1h';
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd:
    | { input: number; output: number; cacheRead: number; cacheCreation: number; total: number }
    | null;
}

// Mutable holder mutated by tests, read by the mocked listCosts.
let mockEntries: CostEntryFixture[] = [];
let mockShouldThrow = false;

vi.mock('../src/services/cost-recorder.js', () => ({
  listCosts: vi.fn(async (opts?: { sessionId?: string }) => {
    if (mockShouldThrow) throw new Error('listCosts boom');
    if (opts?.sessionId) {
      return mockEntries.filter((e) => e.sessionId === opts.sessionId);
    }
    return mockEntries.slice();
  }),
}));

// ---------------------------------------------------------------------------
// beforeEach / afterEach — fresh tmp dir + reset module graph + reset mocks.
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpClaudeRoot = mkdtempSync(join(tmpdir(), 'trace-loader-cost-'));
  prevInstallCtx = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  pinInstallContext(tmpClaudeRoot);
  mockEntries = [];
  mockShouldThrow = false;
  vi.resetModules();
});

afterEach(() => {
  if (prevInstallCtx === undefined) {
    delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
  } else {
    process.env.RUFLO_INSTALL_CONTEXT_JSON = prevInstallCtx;
  }
  rmSync(tmpClaudeRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JOIN — happy path + edge cases.
// ---------------------------------------------------------------------------

describe('loadTrajectory cost-JOIN', () => {
  it('enriches steps with cost when listCosts returns matching entries', async () => {
    writeStore({
      'trajectory-sess-12345678': trajectoryEntry({
        id: 'sess-12345678',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
          { action: 'Edit', result: 'ok', timestamp: '2026-05-09T10:00:02Z' },
        ],
      }),
    });

    mockEntries = [
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-12345678',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 100, output: 50, cacheRead: 200, cacheCreation: 0 },
        costUsd: { input: 0.0003, output: 0.00075, cacheRead: 0.00006, cacheCreation: 0, total: 0.00111 },
      },
      {
        timestamp: '2026-05-09T10:00:02Z',
        sessionId: 'sess-12345678',
        stepIndex: 1,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 200, output: 100, cacheRead: 400, cacheCreation: 0 },
        costUsd: { input: 0.0006, output: 0.0015, cacheRead: 0.00012, cacheCreation: 0, total: 0.00222 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-12345678');
    expect(result).not.toBeNull();
    expect(result!.steps[0].cost).toBeDefined();
    expect(result!.steps[0].cost!.total).toBeCloseTo(0.00111);
    expect(result!.steps[0].cost!.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheCreation: 0,
    });
    expect(result!.steps[1].cost!.total).toBeCloseTo(0.00222);
  });

  it('leaves steps unchanged when no cost data exists for the session', async () => {
    writeStore({
      'trajectory-sess-empty00': trajectoryEntry({
        id: 'sess-empty00',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
        ],
      }),
    });

    // listCosts returns []
    mockEntries = [];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-empty00');
    expect(result).not.toBeNull();
    expect(result!.steps[0].cost).toBeUndefined();
    // Aggregates absent for back-compat — older traces render exactly as before.
    expect(result!.totalCostUsd).toBeUndefined();
    expect(result!.costByModel).toBeUndefined();
    expect(result!.cacheHitRatio).toBeUndefined();
  });

  it('preserves inline step.cost over the joined entry', async () => {
    const inlineCost = {
      input: 9.9,
      output: 9.9,
      cacheRead: 9.9,
      cacheCreation: 9.9,
      total: 39.6,
      usage: { input: 99, output: 99, cacheRead: 99, cacheCreation: 99 },
    };

    writeStore({
      'trajectory-sess-inline00': trajectoryEntry({
        id: 'sess-inline00',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          {
            action: 'Edit',
            result: 'ok',
            timestamp: '2026-05-09T10:00:01Z',
            cost: inlineCost,
          },
        ],
      }),
    });

    // The recorder returns a DIFFERENT cost — inline must win.
    mockEntries = [
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-inline00',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
        costUsd: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheCreation: 0.001, total: 0.004 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-inline00');
    expect(result).not.toBeNull();
    // Inline values preserved verbatim.
    expect(result!.steps[0].cost!.total).toBeCloseTo(39.6);
    expect(result!.steps[0].cost!.input).toBeCloseTo(9.9);
    expect(result!.steps[0].cost!.usage).toEqual({
      input: 99,
      output: 99,
      cacheRead: 99,
      cacheCreation: 99,
    });
  });

  it('aggregates totalCostUsd across all entries (including ones without a stepIndex)', async () => {
    writeStore({
      'trajectory-sess-total000': trajectoryEntry({
        id: 'sess-total000',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
        ],
      }),
    });

    mockEntries = [
      // Bound to step 0
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-total000',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.0003, output: 0.00075, cacheRead: 0, cacheCreation: 0, total: 0.00105 },
      },
      // Floating dispatch with no stepIndex — should still count toward total.
      {
        timestamp: '2026-05-09T10:00:02Z',
        sessionId: 'sess-total000',
        stepIndex: null,
        agent: 'coder',
        model: 'claude-haiku-4-5',
        cacheTtl: '1h',
        usage: { input: 50, output: 20, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.00005, output: 0.0001, cacheRead: 0, cacheCreation: 0, total: 0.00015 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-total000');
    expect(result).not.toBeNull();
    expect(result!.totalCostUsd).toBeCloseTo(0.0012, 6);
  });

  it('aggregates costByModel grouping dispatches and totalUsd per model', async () => {
    writeStore({
      'trajectory-sess-bymodel0': trajectoryEntry({
        id: 'sess-bymodel0',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
        ],
      }),
    });

    mockEntries = [
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-bymodel0',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.0003, output: 0.00075, cacheRead: 0, cacheCreation: 0, total: 0.00105 },
      },
      {
        timestamp: '2026-05-09T10:00:02Z',
        sessionId: 'sess-bymodel0',
        stepIndex: null,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 200, output: 100, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.0006, output: 0.0015, cacheRead: 0, cacheCreation: 0, total: 0.0021 },
      },
      {
        timestamp: '2026-05-09T10:00:03Z',
        sessionId: 'sess-bymodel0',
        stepIndex: null,
        agent: 'coder',
        model: 'claude-haiku-4-5',
        cacheTtl: '1h',
        usage: { input: 50, output: 20, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.00005, output: 0.0001, cacheRead: 0, cacheCreation: 0, total: 0.00015 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-bymodel0');
    expect(result).not.toBeNull();
    expect(result!.costByModel).toBeDefined();
    expect(result!.costByModel!['claude-sonnet-4-6'].dispatches).toBe(2);
    expect(result!.costByModel!['claude-sonnet-4-6'].totalUsd).toBeCloseTo(0.00315, 6);
    expect(result!.costByModel!['claude-haiku-4-5'].dispatches).toBe(1);
    expect(result!.costByModel!['claude-haiku-4-5'].totalUsd).toBeCloseTo(0.00015, 6);
  });

  it('computes cacheHitRatio from joined token usage', async () => {
    writeStore({
      'trajectory-sess-cachehit': trajectoryEntry({
        id: 'sess-cachehit',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
        ],
      }),
    });

    mockEntries = [
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-cachehit',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        // input=100, cacheRead=400, cacheCreation=0
        // ratio = 400 / (100 + 400 + 0) = 0.8
        usage: { input: 100, output: 50, cacheRead: 400, cacheCreation: 0 },
        costUsd: { input: 0.0003, output: 0.00075, cacheRead: 0.00012, cacheCreation: 0, total: 0.00117 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-cachehit');
    expect(result).not.toBeNull();
    expect(result!.cacheHitRatio).toBeCloseTo(0.8, 6);
  });

  it('does not crash + returns trajectory unchanged when listCosts throws', async () => {
    writeStore({
      'trajectory-sess-throwit0': trajectoryEntry({
        id: 'sess-throwit0',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
        ],
      }),
    });

    mockShouldThrow = true;

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-throwit0');
    expect(result).not.toBeNull();
    // Cost fields untouched — back-compat behaviour after recorder failure.
    expect(result!.steps[0].cost).toBeUndefined();
    expect(result!.totalCostUsd).toBeUndefined();
  });

  it('skips a malformed costUsd payload without breaking other steps', async () => {
    writeStore({
      'trajectory-sess-malformd': trajectoryEntry({
        id: 'sess-malformd',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          { action: 'Bash', result: 'ok', timestamp: '2026-05-09T10:00:01Z' },
          { action: 'Edit', result: 'ok', timestamp: '2026-05-09T10:00:02Z' },
        ],
      }),
    });

    mockEntries = [
      {
        timestamp: '2026-05-09T10:00:01Z',
        sessionId: 'sess-malformd',
        stepIndex: 0,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 100, output: 50, cacheRead: 200, cacheCreation: 0 },
        costUsd: null, // pricing.priceFor returned null for this dispatch
      },
      {
        timestamp: '2026-05-09T10:00:02Z',
        sessionId: 'sess-malformd',
        stepIndex: 1,
        agent: 'coder',
        model: 'claude-sonnet-4-6',
        cacheTtl: '1h',
        usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
        costUsd: { input: 0.0003, output: 0.00075, cacheRead: 0, cacheCreation: 0, total: 0.00105 },
      },
    ];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-malformd');
    expect(result).not.toBeNull();
    // Step 0 has no cost (recorder couldn't price it).
    expect(result!.steps[0].cost).toBeUndefined();
    // Step 1 still gets its cost.
    expect(result!.steps[1].cost!.total).toBeCloseTo(0.00105);
  });

  it('round-trips inline cost on disk through the loader', async () => {
    // Simulates the recorder writing cost INTO the trajectory at end-time.
    const inlineCost = {
      input: 0.001,
      output: 0.002,
      cacheRead: 0.0005,
      cacheCreation: 0.0001,
      total: 0.0036,
      usage: { input: 100, output: 200, cacheRead: 50, cacheCreation: 10 },
    };

    writeStore({
      'trajectory-sess-roundtrp': trajectoryEntry({
        id: 'sess-roundtrp',
        startedAt: '2026-05-09T10:00:00Z',
        steps: [
          {
            action: 'Bash',
            result: 'ok',
            timestamp: '2026-05-09T10:00:01Z',
            cost: inlineCost,
          },
        ],
      }),
    });

    // No recorder data — we should still see the inline cost.
    mockEntries = [];

    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const result = await loadTrajectory('sess-roundtrp');
    expect(result).not.toBeNull();
    expect(result!.steps[0].cost).toBeDefined();
    expect(result!.steps[0].cost!.total).toBeCloseTo(0.0036);
    expect(result!.steps[0].cost!.usage).toEqual({
      input: 100,
      output: 200,
      cacheRead: 50,
      cacheCreation: 10,
    });
  });
});
