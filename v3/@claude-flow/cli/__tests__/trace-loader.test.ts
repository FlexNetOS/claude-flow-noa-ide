/**
 * trace-loader unit tests.
 *
 * Strategy
 * --------
 * Each test seeds a temp `claudeRoot` with its own `store.json` fixture,
 * pins `RUFLO_INSTALL_CONTEXT_JSON` so `resolveInstallContext()` returns
 * that root, then exercises listTrajectories / loadTrajectory.
 *
 * vitest.resetModules() between tests is unnecessary — trace-loader has
 * no module-level state, every call re-reads the store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listTrajectories,
  loadTrajectory,
  type LoadedTrajectory,
} from '../src/services/trace-loader.js';

// ---------------------------------------------------------------------------
// Fixture helpers
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

function writeRawStore(raw: string): void {
  const dir = join(tmpClaudeRoot, '.claude-flow', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), raw, 'utf-8');
}

interface FixtureOptions {
  id: string;
  startedAt: string;
  agent?: string;
  task?: string;
  endedAt?: string;
  success?: boolean;
  steps?: Array<{ action: string; result: string; quality?: number; timestamp: string }>;
  metadataType?: string;
}

function trajectoryEntry(opts: FixtureOptions) {
  const value: Record<string, unknown> = {
    id: opts.id,
    task: opts.task ?? `task-${opts.id}`,
    agent: opts.agent ?? 'coder',
    steps:
      opts.steps?.map((s) => ({
        action: s.action,
        result: s.result,
        quality: s.quality ?? 0.5,
        timestamp: s.timestamp,
      })) ?? [],
    startedAt: opts.startedAt,
  };
  if (opts.endedAt !== undefined) value.endedAt = opts.endedAt;
  if (opts.success !== undefined) value.success = opts.success;

  return {
    key: `trajectory-${opts.id}`,
    value,
    metadata: opts.metadataType ? { type: opts.metadataType } : { type: 'trajectory' },
    storedAt: opts.startedAt,
    accessCount: 0,
    lastAccessed: opts.startedAt,
  };
}

beforeEach(() => {
  tmpClaudeRoot = mkdtempSync(join(tmpdir(), 'trace-loader-claude-'));
  prevInstallCtx = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  pinInstallContext(tmpClaudeRoot);
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
// listTrajectories
// ---------------------------------------------------------------------------

describe('listTrajectories', () => {
  it('returns [] when store.json does not exist (no throw)', async () => {
    // No writeStore — directory is empty.
    const result = await listTrajectories();
    expect(result).toEqual([]);
  });

  it('returns [] when store.json is malformed JSON', async () => {
    writeRawStore('{ this is not json');
    const result = await listTrajectories();
    expect(result).toEqual([]);
  });

  it('returns trajectories sorted newest-first by startedAt', async () => {
    writeStore({
      'trajectory-old': trajectoryEntry({ id: 'old', startedAt: '2026-05-01T10:00:00Z' }),
      'trajectory-new': trajectoryEntry({ id: 'new', startedAt: '2026-05-08T10:00:00Z' }),
      'trajectory-mid': trajectoryEntry({ id: 'mid', startedAt: '2026-05-04T10:00:00Z' }),
    });

    const result = await listTrajectories();
    expect(result.map((t: LoadedTrajectory) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('filters by since (>= comparison)', async () => {
    writeStore({
      'trajectory-old': trajectoryEntry({ id: 'old', startedAt: '2026-05-01T10:00:00Z' }),
      'trajectory-new': trajectoryEntry({ id: 'new', startedAt: '2026-05-08T10:00:00Z' }),
      'trajectory-mid': trajectoryEntry({ id: 'mid', startedAt: '2026-05-04T10:00:00Z' }),
    });

    const result = await listTrajectories({ since: new Date('2026-05-04T10:00:00Z') });
    expect(result.map((t) => t.id)).toEqual(['new', 'mid']);
  });

  it('applies limit AFTER sort', async () => {
    writeStore({
      'trajectory-a': trajectoryEntry({ id: 'a', startedAt: '2026-05-01T10:00:00Z' }),
      'trajectory-b': trajectoryEntry({ id: 'b', startedAt: '2026-05-08T10:00:00Z' }),
      'trajectory-c': trajectoryEntry({ id: 'c', startedAt: '2026-05-04T10:00:00Z' }),
      'trajectory-d': trajectoryEntry({ id: 'd', startedAt: '2026-05-06T10:00:00Z' }),
    });

    const result = await listTrajectories({ limit: 2 });
    // Should be the two newest: b (May 8), d (May 6).
    expect(result.map((t) => t.id)).toEqual(['b', 'd']);
  });

  it('filters by agent (case-insensitive substring match)', async () => {
    writeStore({
      't1': trajectoryEntry({ id: 't1', agent: 'coder-bridge', startedAt: '2026-05-08T10:00:00Z' }),
      't2': trajectoryEntry({ id: 't2', agent: 'tester', startedAt: '2026-05-08T11:00:00Z' }),
      't3': trajectoryEntry({ id: 't3', agent: 'coder-renderer', startedAt: '2026-05-08T12:00:00Z' }),
    });

    const result = await listTrajectories({ agent: 'CODER' });
    expect(result.map((t) => t.id).sort()).toEqual(['t1', 't3']);
  });

  it('skips malformed entries instead of crashing', async () => {
    writeStore({
      'trajectory-good': trajectoryEntry({ id: 'good', startedAt: '2026-05-08T10:00:00Z' }),
      'trajectory-bad-shape': {
        key: 'trajectory-bad-shape',
        value: { not: 'a trajectory' }, // missing id, task, agent, startedAt
        metadata: { type: 'trajectory' },
        storedAt: '2026-05-08T10:00:00Z',
        accessCount: 0,
        lastAccessed: '2026-05-08T10:00:00Z',
      },
      'trajectory-bad-value': {
        key: 'trajectory-bad-value',
        value: 'not even an object',
        metadata: { type: 'trajectory' },
        storedAt: '2026-05-08T10:00:00Z',
        accessCount: 0,
        lastAccessed: '2026-05-08T10:00:00Z',
      },
      'unrelated-key': {
        key: 'unrelated-key',
        value: { id: 'should-be-skipped' },
        metadata: { type: 'pattern' },
        storedAt: '2026-05-08T10:00:00Z',
        accessCount: 0,
        lastAccessed: '2026-05-08T10:00:00Z',
      },
    });

    const result = await listTrajectories();
    expect(result.map((t) => t.id)).toEqual(['good']);
  });

  it('detects trajectory entries by metadata.type even when key does not match', async () => {
    writeStore({
      'session-xyz': {
        key: 'session-xyz',
        value: {
          id: 'metadata-tagged',
          task: 'tagged via metadata',
          agent: 'coder',
          steps: [],
          startedAt: '2026-05-08T10:00:00Z',
        },
        metadata: { type: 'trajectory' },
        storedAt: '2026-05-08T10:00:00Z',
        accessCount: 0,
        lastAccessed: '2026-05-08T10:00:00Z',
      },
    });

    const result = await listTrajectories();
    expect(result.map((t) => t.id)).toEqual(['metadata-tagged']);
  });

  it('default limit is 50', async () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 75; i++) {
      const id = `traj-${String(i).padStart(3, '0')}`;
      // Make startedAt monotonically increasing so the newest 50 are the
      // last 50 we wrote.
      const startedAt = new Date(Date.UTC(2026, 4, 1) + i * 60_000).toISOString();
      entries[`trajectory-${id}`] = trajectoryEntry({ id, startedAt });
    }
    writeStore(entries);

    const result = await listTrajectories();
    expect(result.length).toBe(50);
    // Newest first → traj-074 first
    expect(result[0].id).toBe('traj-074');
  });
});

// ---------------------------------------------------------------------------
// loadTrajectory
// ---------------------------------------------------------------------------

describe('loadTrajectory', () => {
  it('returns null when store does not exist', async () => {
    const result = await loadTrajectory('any-id');
    expect(result).toBeNull();
  });

  it('returns null for empty / non-string id', async () => {
    writeStore({
      'trajectory-x': trajectoryEntry({ id: 'x', startedAt: '2026-05-08T10:00:00Z' }),
    });
    expect(await loadTrajectory('')).toBeNull();
  });

  it('exact-match by full id wins regardless of length', async () => {
    writeStore({
      'trajectory-abc': trajectoryEntry({ id: 'abc', startedAt: '2026-05-08T10:00:00Z' }),
    });
    const result = await loadTrajectory('abc');
    expect(result?.id).toBe('abc');
  });

  it('returns null on prefix shorter than 8 chars (no match)', async () => {
    writeStore({
      'trajectory-abc12345xyz': trajectoryEntry({
        id: 'abc12345xyz',
        startedAt: '2026-05-08T10:00:00Z',
      }),
    });
    const result = await loadTrajectory('abc12');
    expect(result).toBeNull();
  });

  it('prefix-match (>= 8 chars, unique) returns the trajectory', async () => {
    writeStore({
      'trajectory-abcd1234efgh': trajectoryEntry({
        id: 'abcd1234efgh',
        startedAt: '2026-05-08T10:00:00Z',
      }),
      'trajectory-zzzz9999wwww': trajectoryEntry({
        id: 'zzzz9999wwww',
        startedAt: '2026-05-08T11:00:00Z',
      }),
    });
    const result = await loadTrajectory('abcd1234');
    expect(result?.id).toBe('abcd1234efgh');
  });

  it('returns null on ambiguous prefix (multiple matches)', async () => {
    writeStore({
      'trajectory-abcd1234aaaa': trajectoryEntry({
        id: 'abcd1234aaaa',
        startedAt: '2026-05-08T10:00:00Z',
      }),
      'trajectory-abcd1234bbbb': trajectoryEntry({
        id: 'abcd1234bbbb',
        startedAt: '2026-05-08T11:00:00Z',
      }),
    });
    const result = await loadTrajectory('abcd1234');
    expect(result).toBeNull();
  });

  it('latest shorthand returns the newest by startedAt', async () => {
    writeStore({
      'trajectory-a': trajectoryEntry({ id: 'a', startedAt: '2026-05-01T10:00:00Z' }),
      'trajectory-b': trajectoryEntry({ id: 'b', startedAt: '2026-05-08T10:00:00Z' }),
      'trajectory-c': trajectoryEntry({ id: 'c', startedAt: '2026-05-04T10:00:00Z' }),
    });
    const result = await loadTrajectory('latest');
    expect(result?.id).toBe('b');
  });

  it('returns null when not found (exact id miss)', async () => {
    writeStore({
      'trajectory-x': trajectoryEntry({ id: 'x', startedAt: '2026-05-08T10:00:00Z' }),
    });
    const result = await loadTrajectory('does-not-exist-anywhere');
    expect(result).toBeNull();
  });

  it('preserves optional endedAt and success fields', async () => {
    writeStore({
      'trajectory-done': trajectoryEntry({
        id: 'done',
        startedAt: '2026-05-08T10:00:00Z',
        endedAt: '2026-05-08T10:05:00Z',
        success: true,
        steps: [
          {
            action: 'Edit',
            result: 'ok',
            quality: 0.9,
            timestamp: '2026-05-08T10:01:00Z',
          },
        ],
      }),
    });
    const result = await loadTrajectory('done');
    expect(result?.endedAt).toBe('2026-05-08T10:05:00Z');
    expect(result?.success).toBe(true);
    expect(result?.steps).toHaveLength(1);
    expect(result?.steps[0].quality).toBe(0.9);
  });

  it('skips malformed steps but keeps the trajectory', async () => {
    writeStore({
      'trajectory-mixed': {
        key: 'trajectory-mixed',
        value: {
          id: 'mixed',
          task: 't',
          agent: 'a',
          startedAt: '2026-05-08T10:00:00Z',
          steps: [
            { action: 'good', result: 'ok', quality: 0.8, timestamp: '2026-05-08T10:00:01Z' },
            { action: 'missing-result', timestamp: '2026-05-08T10:00:02Z' }, // dropped
            'not an object', // dropped
            { action: 'good2', result: 'ok2', timestamp: '2026-05-08T10:00:03Z' }, // quality defaults
          ],
        },
        metadata: { type: 'trajectory' },
        storedAt: '2026-05-08T10:00:00Z',
        accessCount: 0,
        lastAccessed: '2026-05-08T10:00:00Z',
      },
    });
    const result = await loadTrajectory('mixed');
    expect(result?.steps).toHaveLength(2);
    expect(result?.steps[0].action).toBe('good');
    expect(result?.steps[1].action).toBe('good2');
    expect(result?.steps[1].quality).toBe(0.5); // default
  });
});
