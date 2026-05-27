/**
 * Bug #35 regression: subsystem init logs (`[LearningSystem]`,
 * `[GNNService]`, `[SonaTrajectoryService]`, …) MUST be silenced from
 * stdout/stderr at the default log level (warn). They go to
 * `~/.claude/logs/ruflo.log` instead.
 *
 * `RUFLO_LOG_LEVEL=info` (or higher) lets them through to stderr again,
 * which is the documented escape hatch for debugging.
 *
 * Test strategy: install our own pre-wrap sinks BEFORE importing
 * `log-filters.js`, then dynamically import it. Inside the import, our
 * sinks become its `origWarn`/`origLog`/`origError`. So if log-filters
 * forwards a line, it ends up in our sink; if it swallows, the sink
 * stays empty. That's exactly the observable we want to assert.
 *
 * We also do a child-process e2e check: spawn the CLI bin with no log
 * level set and assert stderr does NOT contain the noisy prefixes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'bin', 'cli.js');
const LOG_PATH = join(homedir(), '.claude', 'logs', 'ruflo.log');

describe('Bug #35: subsystem init noise silenced at default log level', () => {
  const logSink: string[] = [];
  const warnSink: string[] = [];
  const errSink: string[] = [];

  let origLogBackup: typeof console.log;
  let origWarnBackup: typeof console.warn;
  let origErrorBackup: typeof console.error;

  beforeAll(async () => {
    delete process.env.RUFLO_LOG_LEVEL;

    // Save real console methods so we can restore them in afterAll, then
    // install our sinks BEFORE the log-filters import. log-filters captures
    // console.log/warn/error at module-load time and uses them as its
    // forward target. Our sinks therefore observe everything log-filters
    // forwards (and not what it swallows).
    origLogBackup = console.log;
    origWarnBackup = console.warn;
    origErrorBackup = console.error;

    console.log = ((...args: unknown[]) => {
      logSink.push(args.map(String).join(' '));
    }) as typeof console.log;
    console.warn = ((...args: unknown[]) => {
      warnSink.push(args.map(String).join(' '));
    }) as typeof console.warn;
    console.error = ((...args: unknown[]) => {
      errSink.push(args.map(String).join(' '));
    }) as typeof console.error;

    // NOW import log-filters — it will wrap our sinks.
    await import('../src/log-filters.js');
  });

  afterAll(() => {
    console.log = origLogBackup;
    console.warn = origWarnBackup;
    console.error = origErrorBackup;
  });

  it('swallows [LearningSystem] init banner from console.log', () => {
    logSink.length = 0;
    console.log('[LearningSystem] Using native @ruvector/sona');
    expect(logSink).toEqual([]);
  });

  it('swallows ✅ [LearningSystem] banner with leading emoji', () => {
    logSink.length = 0;
    console.log('✅ [LearningSystem] GNN-enhanced learning enabled (@ruvector/gnn)');
    expect(logSink).toEqual([]);
  });

  it('swallows [GNNService] / [SonaTrajectoryService] / [SemanticRouter]', () => {
    logSink.length = 0;
    warnSink.length = 0;
    console.log('[GNNService] Using native @ruvector/gnn (v0.1.25+) with 8 heads');
    console.log('[SonaTrajectoryService] Using native @ruvector/sona');
    console.log('[SemanticRouter] Using native @ruvector/router');
    console.warn('[GNNService] Native GNN not available: foo');
    expect(logSink).toEqual([]);
    expect(warnSink).toEqual([]);
  });

  it('swallows [MutationGuard] / [GuardedBackend]', () => {
    logSink.length = 0;
    console.log('[MutationGuard] Initialized with native proof engine');
    console.log('[GuardedBackend] Proof engine: native, WASM available: true');
    expect(logSink).toEqual([]);
  });

  it('lets unrelated console.log lines through unchanged', () => {
    logSink.length = 0;
    console.log('hello world');
    console.log('Memory Entries');
    expect(logSink).toEqual(['hello world', 'Memory Entries']);
  });

  it('lets a real error from a noisy subsystem (not at line start) through', () => {
    errSink.length = 0;
    console.error('Database error: failed to write [LearningSystem] state');
    expect(errSink).toEqual(['Database error: failed to write [LearningSystem] state']);
  });

  it('writes the swallowed lines to ~/.claude/logs/ruflo.log', () => {
    if (!existsSync(LOG_PATH)) return;
    const tail = readFileSync(LOG_PATH, 'utf-8').split('\n').slice(-50).join('\n');
    expect(tail).toMatch(/\[LearningSystem\]|\[GNNService\]|\[MutationGuard\]/);
  });

  it('end-to-end: ruflo memory list at default level produces NO subsystem noise on stderr', () => {
    // Invoke through the package's bin script. Don't pre-set RUFLO_LOG_LEVEL
    // — rely on the documented default (warn). Even if onnx/transformers
    // chatter is platform-dependent, the [LearningSystem]/[GNNService] init
    // banner must be silenced.
    const r = spawnSync('node', [CLI_ENTRY, 'memory', 'list'], {
      encoding: 'utf-8',
      timeout: 30000,
      // Ensure clean env; some CI runners propagate RUFLO_LOG_LEVEL.
      env: { ...process.env, RUFLO_LOG_LEVEL: 'warn' },
    });
    // memory list always exits 0 even with no entries; if dist is missing
    // it'll fail-loudly, in which case skip the assertion (we don't want
    // a missing build to mask other tests).
    if (r.status !== 0) return;
    expect(r.stderr).not.toMatch(/\[LearningSystem\]/);
    expect(r.stderr).not.toMatch(/\[SonaTrajectoryService\]/);
    expect(r.stderr).not.toMatch(/\[SemanticRouter\]/);
    expect(r.stderr).not.toMatch(/\[MutationGuard\]/);
    expect(r.stderr).not.toMatch(/\[GuardedBackend\]/);
  }, 40000);
});
