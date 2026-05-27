/**
 * Unit tests for `services/cost-recorder.ts` (Gap 4 v1 — per-Anthropic-call
 * cost telemetry).
 *
 * Coverage:
 *   - recordCost writes a valid entry with computed costUsd
 *   - recordCost records cost=null for unknown models without throwing
 *   - Rolling window caps at 100 (oldest pruned, newest kept)
 *   - Concurrent recordCost calls don't corrupt the file (smoke race test)
 *   - listCosts returns [] when the file is missing
 *   - listCosts filters by sessionId
 *   - listCosts filters by agent
 *   - listCosts.limit applied AFTER newest-first sort
 *   - summarizeCosts aggregates totals + by-model + by-agent
 *   - summarizeCosts cacheHitRatio = sum(cacheRead) / sum(cacheRead+input+cacheCreation)
 *   - resetCostStats deletes the file (idempotent on missing)
 *
 * Persistence is tested against a temp `claudeRoot` provided via
 * RUFLO_INSTALL_CONTEXT_JSON — the env-override path resolveInstallContext()
 * already supports — so we never touch the user's real ~/.claude.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listCosts,
  recordCost,
  resetCostStats,
  summarizeCosts,
} from '../src/services/cost-recorder.js';

// ---------------------------------------------------------------------------
// Shared install-context override: each test runs against a fresh temp dir.
// ---------------------------------------------------------------------------

let tmpRoot: string;
let prevCtx: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ruflo-cost-recorder-'));
  prevCtx = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
    packageRoot: tmpRoot,
    claudeRoot: tmpRoot,
    dataDir: join(tmpRoot, '.claude-flow', 'data'),
    isGlobalInstall: true,
    projectRoot: null,
  });
});

afterEach(() => {
  if (prevCtx === undefined) delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
  else process.env.RUFLO_INSTALL_CONTEXT_JSON = prevCtx;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function statsPath(): string {
  return join(tmpRoot, '.claude-flow', 'cost-stats.json');
}

// ---------------------------------------------------------------------------
// recordCost — writes a valid entry
// ---------------------------------------------------------------------------

describe('recordCost', () => {
  it('writes a valid entry with computed costUsd for a known model', async () => {
    await recordCost({
      sessionId: 'sess-1',
      stepIndex: 0,
      agent: 'coder-bridge',
      model: 'claude-sonnet-4-6',
      cacheTtl: '1h',
      usage: {
        input: 1_000_000, // 1 MTok input @ $3 -> $3
        output: 100_000,  // 0.1 MTok output @ $15 -> $1.5
        cacheRead: 0,
        cacheCreation: 0,
      },
    });

    expect(existsSync(statsPath())).toBe(true);
    const file = JSON.parse(readFileSync(statsPath(), 'utf-8'));
    expect(file.version).toBe('1');
    expect(file.rollingWindow).toBe(100);
    expect(file.entries).toHaveLength(1);
    const e = file.entries[0];
    expect(e.sessionId).toBe('sess-1');
    expect(e.stepIndex).toBe(0);
    expect(e.agent).toBe('coder-bridge');
    expect(e.model).toBe('claude-sonnet-4-6');
    expect(e.cacheTtl).toBe('1h');
    expect(e.usage.input).toBe(1_000_000);
    expect(e.costUsd).not.toBeNull();
    expect(e.costUsd.input).toBeCloseTo(3.0, 5);
    expect(e.costUsd.output).toBeCloseTo(1.5, 5);
    expect(e.costUsd.total).toBeCloseTo(4.5, 5);
  });

  it('records cost=null for unknown models (no throw)', async () => {
    await recordCost({
      model: 'claude-imaginary-99-9',
      usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
    });

    const file = JSON.parse(readFileSync(statsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].costUsd).toBeNull();
    expect(file.entries[0].model).toBe('claude-imaginary-99-9');
    // Defaults applied
    expect(file.entries[0].sessionId).toBeNull();
    expect(file.entries[0].stepIndex).toBeNull();
    expect(file.entries[0].agent).toBe('unknown');
    expect(file.entries[0].cacheTtl).toBe('1h');
  });

  it('caps at the rolling window (100), pruning oldest', async () => {
    // Write 105 entries — sequentially so timestamps are monotone-ish.
    for (let i = 0; i < 105; i++) {
      await recordCost({
        sessionId: `sess-${i}`,
        agent: 'a',
        model: 'claude-sonnet-4-6',
        usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      });
    }
    const file = JSON.parse(readFileSync(statsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(100);
    // Newest-first means the most recent (sess-104) sits at index 0,
    // and the oldest survivors are sess-5..sess-104 (sess-0..sess-4 pruned).
    expect(file.entries[0].sessionId).toBe('sess-104');
    expect(file.entries[99].sessionId).toBe('sess-5');
  });

  it('handles concurrent calls without losing entries (race smoke test)', async () => {
    // Fire 20 concurrent records — the internal serialisation chain should
    // collapse contention so all 20 land. Without the chain, naive read +
    // unshift + write would lose all-but-one because they all read the same
    // pre-write state.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordCost({
          sessionId: `race-${i}`,
          agent: 'racer',
          model: 'claude-sonnet-4-6',
          usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
        }),
      ),
    );
    const file = JSON.parse(readFileSync(statsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(N);
    const seen = new Set(file.entries.map((e: { sessionId: string }) => e.sessionId));
    expect(seen.size).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// listCosts
// ---------------------------------------------------------------------------

describe('listCosts', () => {
  it('returns [] when the file is missing', async () => {
    expect(existsSync(statsPath())).toBe(false);
    const out = await listCosts();
    expect(out).toEqual([]);
  });

  it('filters by sessionId', async () => {
    await recordCost({ sessionId: 'A', agent: 'x', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ sessionId: 'B', agent: 'x', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ sessionId: 'A', agent: 'y', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });

    const a = await listCosts({ sessionId: 'A' });
    expect(a).toHaveLength(2);
    expect(a.every((e) => e.sessionId === 'A')).toBe(true);
  });

  it('filters by agent', async () => {
    await recordCost({ agent: 'alpha', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ agent: 'beta', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ agent: 'beta', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });

    const beta = await listCosts({ agent: 'beta' });
    expect(beta).toHaveLength(2);
    expect(beta.every((e) => e.agent === 'beta')).toBe(true);
  });

  it('applies limit AFTER newest-first sort', async () => {
    for (let i = 0; i < 10; i++) {
      await recordCost({
        sessionId: `s-${i}`,
        agent: 'a',
        model: 'claude-sonnet-4-6',
        usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      });
    }
    const out = await listCosts({ limit: 3 });
    expect(out).toHaveLength(3);
    // Newest-first means s-9, s-8, s-7 — sequential timestamps should resolve.
    expect(out[0].sessionId).toBe('s-9');
    expect(out[1].sessionId).toBe('s-8');
    expect(out[2].sessionId).toBe('s-7');
  });
});

// ---------------------------------------------------------------------------
// summarizeCosts
// ---------------------------------------------------------------------------

describe('summarizeCosts', () => {
  it('returns the empty summary when no entries', async () => {
    const s = await summarizeCosts();
    expect(s.totalEntries).toBe(0);
    expect(s.totalUsd).toBe(0);
    expect(s.byModel).toEqual({});
    expect(s.byAgent).toEqual({});
    expect(s.cacheHitRatio).toBe(0);
    expect(s.windowStartedAt).toBeNull();
    expect(s.windowEndedAt).toBeNull();
  });

  it('aggregates totalUsd, byModel, byAgent across entries', async () => {
    // Two sonnet calls (1 MTok input each = $3 each = $6), one haiku call
    // (1 MTok input = $1) — all from agent A; and one extra from agent B
    // (sonnet, 0.5 MTok input = $1.5).
    await recordCost({ agent: 'A', model: 'claude-sonnet-4-6',
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ agent: 'A', model: 'claude-sonnet-4-6',
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ agent: 'A', model: 'claude-haiku-4-5',
      usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 } });
    await recordCost({ agent: 'B', model: 'claude-sonnet-4-6',
      usage: { input: 500_000, output: 0, cacheRead: 0, cacheCreation: 0 } });

    const s = await summarizeCosts();
    expect(s.totalEntries).toBe(4);
    expect(s.totalUsd).toBeCloseTo(3 + 3 + 1 + 1.5, 4);

    expect(s.byModel['claude-sonnet-4-6'].entries).toBe(3);
    expect(s.byModel['claude-sonnet-4-6'].totalUsd).toBeCloseTo(3 + 3 + 1.5, 4);
    expect(s.byModel['claude-haiku-4-5'].entries).toBe(1);
    expect(s.byModel['claude-haiku-4-5'].totalUsd).toBeCloseTo(1, 4);

    expect(s.byAgent['A'].entries).toBe(3);
    expect(s.byAgent['A'].totalUsd).toBeCloseTo(3 + 3 + 1, 4);
    expect(s.byAgent['B'].entries).toBe(1);
    expect(s.byAgent['B'].totalUsd).toBeCloseTo(1.5, 4);

    expect(s.windowStartedAt).not.toBeNull();
    expect(s.windowEndedAt).not.toBeNull();
  });

  it('computes cacheHitRatio = sum(cacheRead) / sum(cacheRead + input + cacheCreation)', async () => {
    // Entry 1: 800 cache read, 200 input, 0 cache create -> contributes
    //   read=800, denom=800+200+0=1000.
    await recordCost({ agent: 'A', model: 'claude-sonnet-4-6',
      usage: { input: 200, output: 0, cacheRead: 800, cacheCreation: 0 } });
    // Entry 2: 0 cache read, 100 input, 100 cache create -> contributes
    //   read=0, denom=0+100+100=200.
    await recordCost({ agent: 'A', model: 'claude-sonnet-4-6',
      usage: { input: 100, output: 0, cacheRead: 0, cacheCreation: 100 } });
    // Total: 800 / (1000 + 200) = 800 / 1200 = 2/3.
    const s = await summarizeCosts();
    expect(s.cacheHitRatio).toBeCloseTo(2 / 3, 5);
  });
});

// ---------------------------------------------------------------------------
// resetCostStats
// ---------------------------------------------------------------------------

describe('resetCostStats', () => {
  it('deletes the cost-stats file', async () => {
    await recordCost({ agent: 'A', model: 'claude-sonnet-4-6',
      usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } });
    expect(existsSync(statsPath())).toBe(true);

    await resetCostStats();
    expect(existsSync(statsPath())).toBe(false);
  });

  it('is idempotent when the file is missing', async () => {
    expect(existsSync(statsPath())).toBe(false);
    await expect(resetCostStats()).resolves.toBeUndefined();
  });
});
