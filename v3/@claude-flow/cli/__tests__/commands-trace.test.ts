/**
 * Gap 1 — `swarmops trace` CLI tests.
 *
 * Covers list / replay / prune subcommands plus the inline relative-time
 * parser and the disambiguation error path. Mocks the trace-loader and
 * trace-renderer modules so we don't depend on real on-disk store.json
 * data — keeps the test deterministic regardless of the dev's home dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock the loader + renderer first — must come before importing trace.ts.
// ---------------------------------------------------------------------------

const mockListTrajectories = vi.fn();
const mockLoadTrajectory = vi.fn();
const mockRenderTrace = vi.fn();

vi.mock('../src/services/trace-loader.js', () => ({
  listTrajectories: (...args: unknown[]) => mockListTrajectories(...args),
  loadTrajectory: (...args: unknown[]) => mockLoadTrajectory(...args),
}));

vi.mock('../src/services/trace-renderer.js', () => ({
  renderTrace: (...args: unknown[]) => mockRenderTrace(...args),
}));

// child_process.spawn is non-configurable on Node, so vi.spyOn fails. Mock
// the whole module up-front and assert on this `mockSpawn` from inside the
// test. We keep `unref` so the production code's `child.unref()` doesn't
// throw in the mock.
const mockSpawn = vi.fn(() => ({ unref: () => undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// Stub the install context via env override so getTracesDir() points at a
// throwaway tmp dir. This works because resolveInstallContext() honours
// RUFLO_INSTALL_CONTEXT_JSON before any other resolution path.
let fakeClaudeRoot: string;
let prevInstallEnv: string | undefined;

beforeEach(() => {
  // clearAllMocks (not resetAllMocks) — we want to wipe call history but
  // KEEP the implementations on `mockSpawn` and the loader/renderer mocks.
  // `resetAllMocks` would wipe `mockSpawn`'s `() => ({unref})` fallback and
  // make the production code crash on `child.unref()` in the next run.
  mockListTrajectories.mockReset();
  mockLoadTrajectory.mockReset();
  mockRenderTrace.mockReset();
  mockSpawn.mockClear();
  fakeClaudeRoot = mkdtempSync(join(tmpdir(), 'ruflo-trace-test-'));
  prevInstallEnv = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
    packageRoot: fakeClaudeRoot,
    claudeRoot: fakeClaudeRoot,
    dataDir: fakeClaudeRoot,
    isGlobalInstall: true,
  });
});

afterEach(() => {
  if (prevInstallEnv === undefined) {
    delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
  } else {
    process.env.RUFLO_INSTALL_CONTEXT_JSON = prevInstallEnv;
  }
  rmSync(fakeClaudeRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(args: string[] = [], flags: Record<string, unknown> = {}): {
  args: string[];
  flags: Record<string, unknown> & { _: string[] };
  cwd: string;
  interactive: boolean;
} {
  return {
    args,
    flags: { ...flags, _: args },
    cwd: fakeClaudeRoot,
    interactive: false,
  };
}

function sampleTrajectory(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1234567890abcdef',
    task: 'sample task',
    agent: 'coder-bridge',
    steps: [
      { action: 'Edit', result: 'wrote 1 file', quality: 0.9, timestamp: '2026-05-08T10:00:00Z' },
      { action: 'Bash', result: 'ok', quality: 0.7, timestamp: '2026-05-08T10:00:05Z' },
    ],
    startedAt: '2026-05-08T10:00:00Z',
    endedAt: '2026-05-08T10:01:00Z',
    success: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseRelativeTime — small inline parser, enough surface to be worth pinning.
// ---------------------------------------------------------------------------

describe('trace command — parseRelativeTime', () => {
  it('parses "Nh" / "Nd" shorthand into the past', async () => {
    const { __test } = await import('../src/commands/trace.js');
    const now = new Date('2026-05-08T12:00:00Z');
    const twoHoursAgo = __test.parseRelativeTime('2h', now);
    expect(twoHoursAgo).not.toBeNull();
    expect(twoHoursAgo!.toISOString()).toBe('2026-05-08T10:00:00.000Z');

    const sevenDaysAgo = __test.parseRelativeTime('7d', now);
    expect(sevenDaysAgo!.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it('parses "<n> <unit> ago" English phrases', async () => {
    const { __test } = await import('../src/commands/trace.js');
    const now = new Date('2026-05-08T12:00:00Z');
    const oneHourAgo = __test.parseRelativeTime('1 hour ago', now);
    expect(oneHourAgo!.toISOString()).toBe('2026-05-08T11:00:00.000Z');

    const thirtyDaysAgo = __test.parseRelativeTime('30 days ago', now);
    expect(thirtyDaysAgo!.toISOString()).toBe('2026-04-08T12:00:00.000Z');
  });

  it('parses "yesterday"', async () => {
    const { __test } = await import('../src/commands/trace.js');
    const now = new Date('2026-05-08T12:00:00Z');
    const yesterday = __test.parseRelativeTime('yesterday', now);
    expect(yesterday!.toISOString()).toBe('2026-05-07T12:00:00.000Z');
  });

  it('parses ISO date strings', async () => {
    const { __test } = await import('../src/commands/trace.js');
    const d = __test.parseRelativeTime('2026-01-01T00:00:00Z');
    expect(d!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null for garbage input', async () => {
    const { __test } = await import('../src/commands/trace.js');
    expect(__test.parseRelativeTime('whatever')).toBeNull();
    expect(__test.parseRelativeTime('')).toBeNull();
    expect(__test.parseRelativeTime(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatRelative — small but easy to break.
// ---------------------------------------------------------------------------

describe('trace command — formatRelative', () => {
  it('produces concise relative strings', async () => {
    const { __test } = await import('../src/commands/trace.js');
    const now = new Date('2026-05-08T12:00:00Z');
    expect(__test.formatRelative('2026-05-08T11:59:58Z', now)).toBe('just now');
    expect(__test.formatRelative('2026-05-08T11:59:00Z', now)).toBe('1m ago');
    expect(__test.formatRelative('2026-05-08T10:00:00Z', now)).toBe('2h ago');
    expect(__test.formatRelative('2026-05-01T12:00:00Z', now)).toBe('7d ago');
  });

  it('falls back to the raw string on unparseable timestamps', async () => {
    const { __test } = await import('../src/commands/trace.js');
    expect(__test.formatRelative('garbage')).toBe('garbage');
  });
});

// ---------------------------------------------------------------------------
// `trace list` — calls listTrajectories with the right options.
// ---------------------------------------------------------------------------

describe('trace list', () => {
  it('calls listTrajectories with parsed --since/--agent/--limit', async () => {
    mockListTrajectories.mockResolvedValueOnce([sampleTrajectory()]);
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const ctx = makeCtx([], { since: '2h', agent: 'coder', limit: 10 });
    const result = await __testSubcommands.list.action!(ctx as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockListTrajectories).toHaveBeenCalledTimes(1);
    const callArg = mockListTrajectories.mock.calls[0][0] as {
      since?: Date;
      agent?: string;
      limit?: number;
    };
    expect(callArg.agent).toBe('coder');
    expect(callArg.limit).toBe(10);
    expect(callArg.since).toBeInstanceOf(Date);
  });

  it('emits valid JSON with --json flag', async () => {
    const sample = sampleTrajectory();
    mockListTrajectories.mockResolvedValueOnce([sample]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.list.action!(makeCtx([], { json: true }) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });

    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    const parsed = JSON.parse(written);
    expect(parsed.count).toBe(1);
    expect(parsed.trajectories[0].id).toBe(sample.id);
  });

  it('returns exit 1 with friendly error on unparseable --since', async () => {
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.list.action!(makeCtx([], { since: 'never' }) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(mockListTrajectories).not.toHaveBeenCalled();
  });

  it('shows "no trajectories" message gracefully on empty store', async () => {
    mockListTrajectories.mockResolvedValueOnce([]);
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.list.action!(makeCtx() as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });
});

// ---------------------------------------------------------------------------
// `trace replay` — writes HTML, --json bypasses, --open is conditional.
// ---------------------------------------------------------------------------

describe('trace replay', () => {
  it('writes the renderer output to <claudeRoot>/.claude-flow/traces/<id>.html', async () => {
    const t = sampleTrajectory();
    mockLoadTrajectory.mockResolvedValueOnce(t);
    mockRenderTrace.mockReturnValueOnce('<!DOCTYPE html><html>FAKE TRACE</html>');

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.replay.action!(makeCtx([t.id]) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockLoadTrajectory).toHaveBeenCalledWith(t.id);
    expect(mockRenderTrace).toHaveBeenCalledWith(t);

    const expectedPath = join(fakeClaudeRoot, '.claude-flow', 'traces', `${t.id}.html`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('emits raw JSON to stdout with --json (no file written)', async () => {
    const t = sampleTrajectory();
    mockLoadTrajectory.mockResolvedValueOnce(t);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.replay.action!(makeCtx([t.id], { json: true }) as never);

    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockRenderTrace).not.toHaveBeenCalled();
    const expectedPath = join(fakeClaudeRoot, '.claude-flow', 'traces', `${t.id}.html`);
    expect(existsSync(expectedPath)).toBe(false);
    const parsed = JSON.parse(written);
    expect(parsed.id).toBe(t.id);
  });

  it('only spawns the browser when --open is set', async () => {
    const t = sampleTrajectory();
    mockSpawn.mockClear();

    const { __testSubcommands } = await import('../src/commands/trace.js');

    // Without --open: no spawn.
    mockLoadTrajectory.mockResolvedValueOnce(t);
    mockRenderTrace.mockReturnValueOnce('<html>x</html>');
    await __testSubcommands.replay.action!(makeCtx([t.id]) as never);
    const callsWithoutOpen = mockSpawn.mock.calls.length;

    // With --open: one spawn (on darwin/linux). Skip the assertion on
    // unsupported platforms since the code path silently no-ops there.
    mockLoadTrajectory.mockResolvedValueOnce(t);
    mockRenderTrace.mockReturnValueOnce('<html>x</html>');
    await __testSubcommands.replay.action!(makeCtx([t.id], { open: true }) as never);
    const callsWithOpen = mockSpawn.mock.calls.length;

    expect(callsWithoutOpen).toBe(0);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(callsWithOpen).toBe(1);
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd === 'open' || cmd === 'xdg-open').toBe(true);
      expect(args[0]).toContain(`${t.id}.html`);
    } else {
      expect(callsWithOpen).toBe(0);
    }
  });

  it('returns exit 1 with friendly error on not-found', async () => {
    mockLoadTrajectory.mockResolvedValueOnce(null);
    mockListTrajectories.mockResolvedValueOnce([]);

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.replay.action!(makeCtx(['session-doesnotexist']) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
  });

  it('returns exit 1 with disambiguation hint on ambiguous prefix', async () => {
    mockLoadTrajectory.mockResolvedValueOnce(null);
    // Two trajectories share the prefix the user passed.
    mockListTrajectories.mockResolvedValueOnce([
      sampleTrajectory({ id: 'session-aaaa-1111' }),
      sampleTrajectory({ id: 'session-aaaa-2222' }),
    ]);

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.replay.action!(makeCtx(['session-aaaa']) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
  });

  it('returns exit 1 when no session id is provided', async () => {
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.replay.action!(makeCtx([]) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(mockLoadTrajectory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `trace prune` — dry-run vs delete, threshold parsing, missing dir.
// ---------------------------------------------------------------------------

describe('trace prune', () => {
  function seedTracesDir(opts: { oldFiles: number; freshFiles: number }): {
    tracesDir: string;
    oldPaths: string[];
    freshPaths: string[];
  } {
    const tracesDir = join(fakeClaudeRoot, '.claude-flow', 'traces');
    mkdirSync(tracesDir, { recursive: true });

    const old = Date.now() / 1000 - 60 * 60 * 24 * 60; // 60 days ago in epoch-seconds
    const fresh = Date.now() / 1000 - 60; // 1 minute ago

    const oldPaths: string[] = [];
    for (let i = 0; i < opts.oldFiles; i++) {
      const p = join(tracesDir, `old-${i}.html`);
      writeFileSync(p, '<html>old</html>');
      utimesSync(p, old, old);
      oldPaths.push(p);
    }

    const freshPaths: string[] = [];
    for (let i = 0; i < opts.freshFiles; i++) {
      const p = join(tracesDir, `fresh-${i}.html`);
      writeFileSync(p, '<html>fresh</html>');
      utimesSync(p, fresh, fresh);
      freshPaths.push(p);
    }

    return { tracesDir, oldPaths, freshPaths };
  }

  it('lists files but does not delete them with --dry-run', async () => {
    const { tracesDir, oldPaths, freshPaths } = seedTracesDir({ oldFiles: 3, freshFiles: 2 });

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx([], { 'dry-run': true }) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    // Both old AND fresh files should still be on disk.
    for (const p of [...oldPaths, ...freshPaths]) expect(existsSync(p)).toBe(true);
    // Sanity: directory itself untouched.
    expect(readdirSync(tracesDir).length).toBe(5);
  });

  it('deletes files older than the default threshold (30 days)', async () => {
    const { oldPaths, freshPaths } = seedTracesDir({ oldFiles: 3, freshFiles: 2 });

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx() as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    for (const p of oldPaths) expect(existsSync(p)).toBe(false);
    for (const p of freshPaths) expect(existsSync(p)).toBe(true);
  });

  it('respects --older-than threshold', async () => {
    // All "old" files are 60 days old. With --older-than 90d, they should
    // survive (still newer than 90 days).
    const { oldPaths } = seedTracesDir({ oldFiles: 3, freshFiles: 0 });

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx([], { 'older-than': '90d' }) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    for (const p of oldPaths) expect(existsSync(p)).toBe(true);
  });

  it('emits valid JSON with --json', async () => {
    seedTracesDir({ oldFiles: 2, freshFiles: 1 });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(
      makeCtx([], { json: true, 'dry-run': true }) as never,
    );
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    const parsed = JSON.parse(written);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.candidateCount).toBe(2);
    expect(parsed.deletedCount).toBe(0);
  });

  it('handles a missing traces directory gracefully', async () => {
    // No seed — directory does not exist.
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx() as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });

  it('returns exit 1 on unparseable --older-than', async () => {
    seedTracesDir({ oldFiles: 1, freshFiles: 0 });
    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx([], { 'older-than': 'whenever' }) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
  });

  it('only touches .html files', async () => {
    const { tracesDir } = seedTracesDir({ oldFiles: 0, freshFiles: 0 });
    // Plant a non-html file with very-old mtime — must NOT be deleted.
    const stranger = join(tracesDir, 'NOTES.txt');
    writeFileSync(stranger, 'do not delete me');
    const old = Date.now() / 1000 - 60 * 60 * 24 * 365; // 1 year ago
    utimesSync(stranger, old, old);

    const { __testSubcommands } = await import('../src/commands/trace.js');
    const result = await __testSubcommands.prune.action!(makeCtx() as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(existsSync(stranger)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Top-level `trace` — sanity check that subcommands are wired in.
// ---------------------------------------------------------------------------

describe('trace command — top level wiring', () => {
  it('exposes list / replay / prune as subcommands', async () => {
    const { traceCommand } = await import('../src/commands/trace.js');
    const subNames = (traceCommand.subcommands ?? []).map((c) => c.name);
    expect(subNames).toEqual(expect.arrayContaining(['list', 'replay', 'prune']));
  });
});
