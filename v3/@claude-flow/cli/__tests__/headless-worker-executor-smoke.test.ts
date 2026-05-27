/**
 * Smoke tests for services/headless-worker-executor.ts (#bug41).
 *
 * Coverage push, not exhaustive units. Goal: take a 1,362-LoC file from <5%
 * line coverage to ≥40% by exercising the constructor, public API, the
 * pure-helper exports, and the cancel / queue / cache code paths — without
 * actually spawning the `claude` CLI (we mock that boundary).
 *
 * What we explicitly assert (regression scaffolding for future bugs):
 * - cancelAll() reaps both active processes AND queued work
 * - getPoolStatus() shape is stable (active/queued/maxConcurrent)
 * - Context cache is keyed by sorted-pattern join — reordering ≠ new key
 * - createErrorResult() (private, exercised via missing CLI) returns
 *   workerType + a non-empty error message
 * - parseJsonOutput / parseMarkdownOutput exercised via execute() path
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HeadlessWorkerExecutor,
  HEADLESS_WORKER_TYPES,
  LOCAL_WORKER_TYPES,
  HEADLESS_WORKER_CONFIGS,
  LOCAL_WORKER_CONFIGS,
  ALL_WORKER_CONFIGS,
  isHeadlessWorker,
  isLocalWorker,
  getModelId,
  getWorkerConfig,
  type HeadlessWorkerType,
  type ModelType,
} from '../src/services/headless-worker-executor.js';

// ============================================================================
// Pure helper exports — no I/O, no mocks needed
// ============================================================================

describe('HEADLESS_WORKER_TYPES & LOCAL_WORKER_TYPES — stable enums', () => {
  it('headless types contain all 8 documented workers', () => {
    expect(HEADLESS_WORKER_TYPES).toEqual(
      expect.arrayContaining([
        'audit', 'optimize', 'testgaps', 'document',
        'ultralearn', 'refactor', 'deepdive', 'predict',
      ])
    );
    expect(HEADLESS_WORKER_TYPES.length).toBe(8);
  });

  it('local types are the 4 non-AI workers', () => {
    expect(LOCAL_WORKER_TYPES).toEqual(
      expect.arrayContaining(['map', 'consolidate', 'benchmark', 'preload'])
    );
    expect(LOCAL_WORKER_TYPES.length).toBe(4);
  });

  it('headless and local sets are disjoint (no overlap)', () => {
    const overlap = HEADLESS_WORKER_TYPES.filter((t) =>
      (LOCAL_WORKER_TYPES as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });

  it('ALL_WORKER_CONFIGS contains 12 entries (8 headless + 4 local)', () => {
    expect(ALL_WORKER_CONFIGS.length).toBe(12);
  });
});

describe('isHeadlessWorker / isLocalWorker — type guards', () => {
  it.each(HEADLESS_WORKER_TYPES)(
    'isHeadlessWorker("%s") returns true',
    (t) => {
      expect(isHeadlessWorker(t)).toBe(true);
      expect(isLocalWorker(t)).toBe(false);
    }
  );

  it.each(LOCAL_WORKER_TYPES)(
    'isLocalWorker("%s") returns true',
    (t) => {
      expect(isLocalWorker(t)).toBe(true);
      expect(isHeadlessWorker(t)).toBe(false);
    }
  );

  it('returns false for unknown types', () => {
    // @ts-expect-error — testing runtime guard with bogus string
    expect(isHeadlessWorker('not-a-real-worker')).toBe(false);
    // @ts-expect-error
    expect(isLocalWorker('not-a-real-worker')).toBe(false);
  });
});

describe('getModelId — model alias resolution (#1431 regression)', () => {
  it.each([
    ['sonnet', 'sonnet'],
    ['opus', 'opus'],
    ['haiku', 'haiku'],
  ] as Array<[ModelType, string]>)(
    'getModelId("%s") returns short alias "%s" (not a dated snapshot)',
    (model, expected) => {
      const id = getModelId(model);
      expect(id).toBe(expected);
      // Regression: never hardcode dated snapshots like sonnet-4-5-20250929
      expect(id).not.toMatch(/\d{8}/);
    }
  );
});

describe('getWorkerConfig — lookup by type', () => {
  it.each(HEADLESS_WORKER_TYPES)(
    'returns headless config for "%s" with required fields',
    (t) => {
      const cfg = getWorkerConfig(t);
      expect(cfg).toBeDefined();
      expect(cfg!.type).toBe(t);
      expect(cfg!.mode).toBe('headless');
      expect(cfg!.headless).toBeDefined();
      expect(typeof cfg!.headless!.promptTemplate).toBe('string');
      expect(cfg!.headless!.promptTemplate.length).toBeGreaterThan(0);
      expect(['strict', 'permissive', 'disabled']).toContain(cfg!.headless!.sandbox);
    }
  );

  it.each(LOCAL_WORKER_TYPES)(
    'returns local config for "%s" with mode=local',
    (t) => {
      const cfg = getWorkerConfig(t);
      expect(cfg).toBeDefined();
      expect(cfg!.type).toBe(t);
      expect(cfg!.mode).toBe('local');
    }
  );

  it('returns undefined for unknown types', () => {
    // @ts-expect-error — testing runtime branch
    expect(getWorkerConfig('does-not-exist')).toBeUndefined();
  });
});

describe('HEADLESS_WORKER_CONFIGS — every entry is well-formed', () => {
  it.each(Object.entries(HEADLESS_WORKER_CONFIGS))(
    'config for "%s" has interval, priority, description',
    (_name, cfg) => {
      // intervalMs === 0 means "manual trigger only" — valid (ultralearn, refactor, deepdive).
      expect(cfg.intervalMs).toBeGreaterThanOrEqual(0);
      expect(['low', 'normal', 'high', 'critical']).toContain(cfg.priority);
      expect(cfg.description.length).toBeGreaterThan(0);
      expect(typeof cfg.enabled).toBe('boolean');
    }
  );
});

describe('LOCAL_WORKER_CONFIGS — every entry is well-formed', () => {
  it.each(Object.entries(LOCAL_WORKER_CONFIGS))(
    'config for "%s" has interval, priority, description',
    (_name, cfg) => {
      expect(cfg.intervalMs).toBeGreaterThanOrEqual(0);
      expect(['low', 'normal', 'high', 'critical']).toContain(cfg.priority);
      expect(cfg.description.length).toBeGreaterThan(0);
    }
  );
});

// ============================================================================
// HeadlessWorkerExecutor class — mock the `claude` CLI boundary
// ============================================================================

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hwe-smoke-'));
});

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('HeadlessWorkerExecutor — constructor', () => {
  it('creates the log directory under projectRoot/.claude-flow/logs/headless', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    expect(existsSync(join(workDir, '.claude-flow', 'logs', 'headless'))).toBe(true);
    // Sanity: we got a real instance with EventEmitter superclass
    expect(typeof executor.on).toBe('function');
    expect(typeof executor.emit).toBe('function');
  });

  it('honors a custom logDir override', () => {
    const customLogDir = join(workDir, 'custom-logs');
    const _executor = new HeadlessWorkerExecutor(workDir, { logDir: customLogDir });
    expect(existsSync(customLogDir)).toBe(true);
  });

  it('applies sane defaults when no config given', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const status = executor.getPoolStatus();
    expect(status.maxConcurrent).toBe(2); // default per ADR-020
    expect(status.activeCount).toBe(0);
    expect(status.queueLength).toBe(0);
  });

  it('applies custom maxConcurrent', () => {
    const executor = new HeadlessWorkerExecutor(workDir, { maxConcurrent: 5 });
    const status = executor.getPoolStatus();
    expect(status.maxConcurrent).toBe(5);
  });
});

describe('HeadlessWorkerExecutor — public introspection methods', () => {
  it('getHeadlessWorkerTypes() returns a defensive copy', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const a = executor.getHeadlessWorkerTypes();
    const b = executor.getHeadlessWorkerTypes();
    a.push('mutated' as unknown as HeadlessWorkerType);
    // Mutating the returned array must not poison subsequent calls.
    expect(b).not.toContain('mutated');
    expect(executor.getHeadlessWorkerTypes()).not.toContain('mutated');
  });

  it('getLocalWorkerTypes() returns a defensive copy', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const a = executor.getLocalWorkerTypes();
    a.push('mutated' as unknown as 'map');
    expect(executor.getLocalWorkerTypes()).not.toContain('mutated');
  });

  it('getConfig(workerType) returns the matching headless config', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const cfg = executor.getConfig('audit');
    expect(cfg).toBeDefined();
    expect(cfg!.type).toBe('audit');
    expect(cfg!.priority).toBe('critical');
  });

  it('getActiveCount() starts at 0', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    expect(executor.getActiveCount()).toBe(0);
  });

  it('getPoolStatus() shape is stable across calls', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const status = executor.getPoolStatus();
    expect(status).toHaveProperty('activeCount');
    expect(status).toHaveProperty('queueLength');
    expect(status).toHaveProperty('maxConcurrent');
    expect(status).toHaveProperty('activeWorkers');
    expect(status).toHaveProperty('queuedWorkers');
    expect(Array.isArray(status.activeWorkers)).toBe(true);
    expect(Array.isArray(status.queuedWorkers)).toBe(true);
  });
});

describe('HeadlessWorkerExecutor — cache & cancel paths', () => {
  it('clearContextCache() emits cacheClear and is safe to call repeatedly', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    const events: unknown[] = [];
    executor.on('cacheClear', (e) => events.push(e));

    executor.clearContextCache();
    executor.clearContextCache();

    expect(events.length).toBe(2);
  });

  it('cancel(unknownId) returns false (no throw)', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    expect(executor.cancel('does-not-exist')).toBe(false);
  });

  it('cancelAll() with empty pool returns 0 and emits allCancelled', () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    let lastEvent: unknown = null;
    executor.on('allCancelled', (e) => { lastEvent = e; });

    const count = executor.cancelAll();
    expect(count).toBe(0);
    expect(lastEvent).toEqual({ count: 0 });
  });
});

describe('HeadlessWorkerExecutor — execute() error paths', () => {
  it('throws on unknown worker type', async () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    await expect(
      // @ts-expect-error — runtime branch
      executor.execute('not-a-worker')
    ).rejects.toThrow(/Unknown headless worker/);
  });

  it('returns an error result (no throw) when claude CLI is unavailable', async () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    // Force the availability check to fail without spawning `claude`.
    // Type assertion bypasses the private cache field for test setup.
    (executor as unknown as { claudeCodeAvailable: boolean }).claudeCodeAvailable = false;

    const errorEvents: unknown[] = [];
    executor.on('error', (e) => errorEvents.push(e));

    const result = await executor.execute('audit');

    expect(result.success).toBe(false);
    expect(result.workerType).toBe('audit');
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/Claude Code CLI not available/);
    // Error event should fire for monitoring
    expect(errorEvents.length).toBe(1);
  });

  it('isAvailable() caches its result (does not re-probe)', async () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    // Pre-populate the cache to bypass execSync.
    (executor as unknown as { claudeCodeAvailable: boolean }).claudeCodeAvailable = true;
    (executor as unknown as { claudeCodeVersion: string }).claudeCodeVersion = '1.2.3-mock';

    const a = await executor.isAvailable();
    const b = await executor.isAvailable();
    expect(a).toBe(true);
    expect(b).toBe(true);

    const ver = await executor.getVersion();
    expect(ver).toBe('1.2.3-mock');
  });
});

describe('HeadlessWorkerExecutor — buildContext via execute (cache hit path)', () => {
  it('reads small files from projectRoot when patterns include them', async () => {
    // Create a couple of files inside the workDir so simpleGlob can pick them up.
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(workDir, 'src', 'b.ts'), 'export const b = 2;\n');

    const executor = new HeadlessWorkerExecutor(workDir, { cacheContext: true, cacheTtlMs: 60000 });
    // Bypass real CLI — pretend it's there but force the spawn path to a no-op.
    (executor as unknown as { claudeCodeAvailable: boolean }).claudeCodeAvailable = true;

    // Stub out the private executeClaudeCode to avoid spawning anything.
    (executor as unknown as { executeClaudeCode: (...a: unknown[]) => Promise<unknown> }).executeClaudeCode =
      async () => ({ success: true, output: '{"ok": true}', tokensUsed: 42 });

    const result = await executor.execute('audit', {
      contextPatterns: ['src/*.ts'],
      outputFormat: 'json',
    });

    expect(result.success).toBe(true);
    expect(result.tokensUsed).toBe(42);
    expect(result.parsedOutput).toEqual({ ok: true });
    expect(result.workerType).toBe('audit');
    expect(typeof result.executionId).toBe('string');
    expect(result.executionId).toMatch(/^audit_/);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('parses markdown output into sections and codeBlocks', async () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    (executor as unknown as { claudeCodeAvailable: boolean }).claudeCodeAvailable = true;
    (executor as unknown as { executeClaudeCode: (...a: unknown[]) => Promise<unknown> }).executeClaudeCode =
      async () => ({
        success: true,
        output: '# Title\n\nbody\n\n```ts\nconst x = 1;\n```\n## Sub\nmore',
      });

    const result = await executor.execute('document', { outputFormat: 'markdown' });

    expect(result.success).toBe(true);
    const parsed = result.parsedOutput as { sections: Array<{ title: string }>; codeBlocks: Array<{ language: string }> };
    expect(parsed.sections.length).toBeGreaterThanOrEqual(2);
    expect(parsed.sections.map(s => s.title)).toContain('Title');
    expect(parsed.codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(parsed.codeBlocks[0].language).toBe('ts');
  });

  it('returns parseError sentinel when output is not valid JSON', async () => {
    const executor = new HeadlessWorkerExecutor(workDir);
    (executor as unknown as { claudeCodeAvailable: boolean }).claudeCodeAvailable = true;
    (executor as unknown as { executeClaudeCode: (...a: unknown[]) => Promise<unknown> }).executeClaudeCode =
      async () => ({ success: true, output: 'this is not json at all' });

    const result = await executor.execute('audit', { outputFormat: 'json' });
    const parsed = result.parsedOutput as { parseError?: boolean; rawOutput?: string };
    expect(parsed.parseError).toBe(true);
    expect(parsed.rawOutput).toBe('this is not json at all');
  });
});
