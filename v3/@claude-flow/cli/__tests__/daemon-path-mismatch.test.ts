/**
 * Bug 47 — stale-daemon-path detection.
 *
 * The bug: a long-running daemon was forked from a different binary path
 * (e.g. an old `~/.npm/_npx/<hash>/...` cache from before the SwarmOps
 * fork). It keeps scheduling workers with PRE-FORK code while the user's
 * CLI now resolves to a different install. We need to:
 *   - detect the mismatch (detectDaemonPathMismatch),
 *   - refuse `daemon restart` without --force-path,
 *   - proceed with --force-path (graceful SIGTERM, SIGKILL fallback,
 *     state-file wipe).
 *
 * These tests build fake `.claude-flow/daemon.pid` + `daemon-state.json`
 * trees in tmpdir() and stub the `ps`-equivalent + the SIGTERM/SIGKILL
 * killer so nothing real is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectDaemonPathMismatch,
  detectDaemonPathMismatches,
  restartBackgroundDaemon,
  type DaemonPathInfo,
  type ProcessKiller,
} from '../src/commands/daemon.js';

let tmp: string;
let stateDir: string;
let pidFile: string;
let stateFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'daemon-path-mismatch-'));
  stateDir = join(tmp, '.claude-flow');
  mkdirSync(stateDir, { recursive: true });
  pidFile = join(stateDir, 'daemon.pid');
  stateFile = join(stateDir, 'daemon-state.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// detectDaemonPathMismatch
// ---------------------------------------------------------------------------

describe('detectDaemonPathMismatch', () => {
  it('returns null when no daemon.pid file exists', async () => {
    const result = await detectDaemonPathMismatch({ projectRoot: tmp });
    expect(result).toBeNull();
  });

  it('returns null when paths match (after canonicalization)', async () => {
    writeFileSync(pidFile, '12345');
    const expected = '/Users/dev/SwarmOps/v3/@claude-flow/cli/bin/cli.js';
    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: expected,
      // Both paths get the same canonical form — no mismatch.
      readRunningCommand: () => expected,
      canonicalize: (p) => p,
    });
    expect(result).toBeNull();
  });

  it('returns DaemonPathInfo when running path differs from expected', async () => {
    writeFileSync(pidFile, '64888');
    writeFileSync(
      stateFile,
      JSON.stringify({
        startedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      }),
    );
    const expected = '/Users/dev/SwarmOps/v3/@claude-flow/cli/bin/cli.js';
    const running = '/Users/dev/.npm/_npx/2ed56890c96f58f7/node_modules/@claude-flow/cli/bin/cli.js';

    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: expected,
      readRunningCommand: (pid) => {
        expect(pid).toBe(64888);
        return running;
      },
      canonicalize: (p) => p,
    });

    expect(result).not.toBeNull();
    expect(result!.pid).toBe(64888);
    expect(result!.runningPath).toBe(running);
    expect(result!.expectedPath).toBe(expected);
    expect(result!.ageDays).toBeGreaterThanOrEqual(3);
    expect(result!.startedAt).not.toBe('unknown');
  });

  it('handles PID-not-found gracefully (ps returns null)', async () => {
    writeFileSync(pidFile, '99999');
    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: '/x/bin/cli.js',
      readRunningCommand: () => null, // simulate `ps` reporting PID gone
      canonicalize: (p) => p,
    });
    expect(result).toBeNull();
  });

  it('returns null when daemon.pid contains a non-numeric value', async () => {
    writeFileSync(pidFile, 'not-a-pid');
    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: '/x/bin/cli.js',
      readRunningCommand: () => '/should/not/be/called',
      canonicalize: (p) => p,
    });
    expect(result).toBeNull();
  });

  it('reports startedAt="unknown" and ageDays=0 when no daemon-state.json', async () => {
    writeFileSync(pidFile, '12345');
    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: '/path/A',
      readRunningCommand: () => '/path/B',
      canonicalize: (p) => p,
    });
    expect(result).not.toBeNull();
    expect(result!.startedAt).toBe('unknown');
    expect(result!.ageDays).toBe(0);
  });

  it('matches paths after canonicalization even when raw strings differ', async () => {
    writeFileSync(pidFile, '12345');
    // Two different raw paths that canonicalize to the same target.
    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      expectedPath: '/var/symlinked/cli.js',
      readRunningCommand: () => '/private/var/symlinked/cli.js',
      canonicalize: () => '/canonical/cli.js',
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restartBackgroundDaemon — kill flow
// ---------------------------------------------------------------------------

describe('restartBackgroundDaemon', () => {
  it('returns {killed:false, pid:null} when no daemon.pid exists', async () => {
    const killer = vi.fn() as unknown as ProcessKiller;
    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: false,
      killer,
      sleep: () => Promise.resolve(),
    });
    expect(result.killed).toBe(false);
    expect(result.pid).toBeNull();
    expect(killer).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and exits early when process dies during grace period', async () => {
    writeFileSync(pidFile, '64888');
    let alive = true;
    const sigterms: number[] = [];
    const sigkills: number[] = [];

    const killer: ProcessKiller = (pid, signal) => {
      if (signal === 0) {
        if (!alive) {
          // ESRCH equivalent — throw to indicate process is gone.
          throw new Error('ESRCH');
        }
        return true;
      }
      if (signal === 'SIGTERM') {
        sigterms.push(pid);
        // Simulate graceful shutdown after first SIGTERM.
        alive = false;
        return true;
      }
      if (signal === 'SIGKILL') {
        sigkills.push(pid);
        return true;
      }
      return true;
    };

    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: false,
      killer,
      sleep: () => Promise.resolve(),
      graceMs: 100,
    });

    expect(result.killed).toBe(true);
    expect(result.pid).toBe(64888);
    expect(sigterms).toEqual([64888]);
    expect(sigkills).toEqual([]); // graceful shutdown — no SIGKILL needed
    expect(existsSync(pidFile)).toBe(false); // PID file cleaned up
  });

  it('escalates to SIGKILL when SIGTERM does not kill within grace period', async () => {
    writeFileSync(pidFile, '64888');
    const sigterms: number[] = [];
    const sigkills: number[] = [];

    // Process refuses to die — signal 0 always succeeds, SIGTERM is ignored.
    const killer: ProcessKiller = (pid, signal) => {
      if (signal === 0) return true; // always alive
      if (signal === 'SIGTERM') sigterms.push(pid);
      if (signal === 'SIGKILL') sigkills.push(pid);
      return true;
    };

    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: false,
      killer,
      sleep: () => Promise.resolve(),
      graceMs: 50,
    });

    expect(result.killed).toBe(true);
    expect(sigterms).toEqual([64888]);
    expect(sigkills).toEqual([64888]);
  });

  it('clears daemon-state.json when clearState=true (--force-path semantics)', async () => {
    writeFileSync(pidFile, '64888');
    writeFileSync(stateFile, JSON.stringify({ running: true, startedAt: new Date().toISOString() }));

    const killer: ProcessKiller = (_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH'); // already dead
      return true;
    };

    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: true,
      killer,
      sleep: () => Promise.resolve(),
    });

    expect(result.pid).toBe(64888);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('preserves daemon-state.json when clearState=false', async () => {
    writeFileSync(pidFile, '64888');
    writeFileSync(stateFile, JSON.stringify({ running: true }));

    const killer: ProcessKiller = (_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH');
      return true;
    };

    await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: false,
      killer,
      sleep: () => Promise.resolve(),
    });

    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('handles dead-PID + present-pidfile (cleans up state without raising signals)', async () => {
    writeFileSync(pidFile, '99999');
    const killer: ProcessKiller = (_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH'); // already dead
      throw new Error('should not signal a dead process');
    };

    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: false,
      killer,
      sleep: () => Promise.resolve(),
    });

    expect(result.pid).toBe(99999);
    // killed=false because we didn't actually send a signal — but pidfile is gone.
    expect(existsSync(pidFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug 48 — detectDaemonPathMismatches (plural) — scans BOTH valid
// `daemon-state.json` locations (cwd-local + global `~/.claude/.claude-flow/`)
// because Bug 47's singular helper only checked the cwd-local one and missed
// daemons running from the global location.
// ---------------------------------------------------------------------------

describe('detectDaemonPathMismatches (Bug 48)', () => {
  // Each test sets up an "cwd-local" tmp tree (from beforeEach above) PLUS
  // a separate "fake homedir" tmp tree so we can deterministically simulate
  // the `<home>/.claude/.claude-flow/daemon-state.json` location without
  // touching the real $HOME.
  let fakeHome: string;
  let globalStateDir: string;
  let globalPidFile: string;
  let globalStateFile: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'daemon-path-mismatch-home-'));
    globalStateDir = join(fakeHome, '.claude', '.claude-flow');
    mkdirSync(globalStateDir, { recursive: true });
    globalPidFile = join(globalStateDir, 'daemon.pid');
    globalStateFile = join(globalStateDir, 'daemon-state.json');
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const expected = '/install/swarmops/bin/cli.js';
  const stale = '/Users/dev/.npm/_npx/2ed56890c96f58f7/node_modules/@claude-flow/cli/bin/cli.js';

  it('returns [] when no daemon-state.json exists in either location', async () => {
    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: () => stale,
      canonicalize: (p) => p,
    });
    expect(result).toEqual([]);
  });

  it('returns 1 entry when only the GLOBAL location has a mismatched daemon', async () => {
    // Only the global tree has a daemon.pid — cwd-local tmp dir is empty.
    writeFileSync(globalPidFile, '64888');
    writeFileSync(
      globalStateFile,
      JSON.stringify({ startedAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
    );

    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: (pid) => {
        expect(pid).toBe(64888);
        return stale;
      },
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(64888);
    expect(result[0].runningPath).toBe(stale);
    expect(result[0].expectedPath).toBe(expected);
    expect(result[0].stateFilePath).toBe(globalStateFile);
    expect(result[0].ageDays).toBeGreaterThanOrEqual(3);
  });

  it('returns 1 entry when only the CWD location has a mismatched daemon', async () => {
    writeFileSync(pidFile, '12345');
    writeFileSync(stateFile, JSON.stringify({ startedAt: new Date().toISOString() }));

    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: () => stale,
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(12345);
    expect(result[0].stateFilePath).toBe(stateFile);
  });

  it('returns 2 entries when BOTH locations have mismatched daemons', async () => {
    writeFileSync(pidFile, '11111');
    writeFileSync(stateFile, JSON.stringify({ startedAt: new Date().toISOString() }));
    writeFileSync(globalPidFile, '22222');
    writeFileSync(
      globalStateFile,
      JSON.stringify({ startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    );

    // ps lookup returns the same stale path for both PIDs — both mismatch.
    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: (pid) => {
        // Only return a path for our two known PIDs; otherwise null.
        if (pid === 11111 || pid === 22222) return stale;
        return null;
      },
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(2);
    // First entry comes from cwd-local (priority order in getAllDaemonStatePaths).
    expect(result[0].pid).toBe(11111);
    expect(result[0].stateFilePath).toBe(stateFile);
    expect(result[1].pid).toBe(22222);
    expect(result[1].stateFilePath).toBe(globalStateFile);
  });

  it('returns [] when both daemons match the expected path (no mismatch)', async () => {
    writeFileSync(pidFile, '11111');
    writeFileSync(globalPidFile, '22222');

    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      // Both daemons return the same canonical path as expected.
      readRunningCommand: () => expected,
      canonicalize: (p) => p,
    });

    expect(result).toEqual([]);
  });

  it('de-duplicates by PID when both candidates somehow point at the same daemon', async () => {
    // Pathological case: both pid files happen to contain the same PID.
    // Realistically this would only occur if cwd === ~/.claude, but we
    // guard against double-reporting regardless.
    writeFileSync(pidFile, '64888');
    writeFileSync(globalPidFile, '64888');

    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: () => stale,
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(64888);
    // First wins — cwd-local takes priority in getAllDaemonStatePaths order.
    expect(result[0].stateFilePath).toBe(stateFile);
  });

  it('skips locations whose PID is dead (ps returns null)', async () => {
    writeFileSync(pidFile, '11111');         // alive
    writeFileSync(globalPidFile, '99999');   // dead

    const result = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: expected,
      readRunningCommand: (pid) => (pid === 11111 ? stale : null),
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(11111);
  });

  it('respects explicit stateFilePaths override (bypasses default enumeration)', async () => {
    // Caller can override candidate locations entirely — useful for tests
    // and for `swarmops doctor --component` flows that want to scan a
    // single specific path.
    writeFileSync(pidFile, '11111');
    writeFileSync(globalPidFile, '22222');

    const result = await detectDaemonPathMismatches({
      stateFilePaths: [globalStateFile],   // only check global
      expectedPath: expected,
      readRunningCommand: () => stale,
      canonicalize: (p) => p,
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(22222);
  });
});

// ---------------------------------------------------------------------------
// Bug 48 — detectDaemonPathMismatch (singular) — backwards-compat alias.
// Returns the FIRST element of the plural array, or null if empty. Existing
// callers (status warning, original Bug 47 tests) rely on this signature.
// ---------------------------------------------------------------------------

describe('detectDaemonPathMismatch backwards-compat (Bug 48)', () => {
  let fakeHome: string;
  let globalStateDir: string;
  let globalPidFile: string;
  let globalStateFile: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'daemon-path-mismatch-home-singular-'));
    globalStateDir = join(fakeHome, '.claude', '.claude-flow');
    mkdirSync(globalStateDir, { recursive: true });
    globalPidFile = join(globalStateDir, 'daemon.pid');
    globalStateFile = join(globalStateDir, 'daemon-state.json');
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns null when neither location has a mismatched daemon (no override)', async () => {
    // No projectRoot, no stateFilePaths → uses both default candidates.
    const result = await detectDaemonPathMismatch({
      homedir: fakeHome,
      expectedPath: '/install/cli.js',
      readRunningCommand: () => '/install/cli.js', // matches → no mismatch
      canonicalize: (p) => p,
    });
    expect(result).toBeNull();
  });

  it('returns the first element when multiple mismatches exist (no override)', async () => {
    writeFileSync(pidFile, '11111');
    writeFileSync(globalPidFile, '22222');

    const result = await detectDaemonPathMismatch({
      projectRoot: tmp,
      // explicit stateFilePaths so we scan both — the projectRoot-only
      // path goes through the Bug 47 compat shim that only checks cwd.
      stateFilePaths: [
        join(tmp, '.claude-flow', 'daemon-state.json'),
        globalStateFile,
      ],
      expectedPath: '/install/cli.js',
      readRunningCommand: () => '/stale/cli.js',
      canonicalize: (p) => p,
    });

    expect(result).not.toBeNull();
    expect(result!.pid).toBe(11111); // cwd-local wins (first in array)
  });
});

// ---------------------------------------------------------------------------
// Bug 48 — restartBackgroundDaemon with explicit stateFilePath — kills
// the daemon at the targeted location AND wipes its state file there
// (rather than the cwd-local default). Used by `daemon restart --force-path`
// to clean up daemons in BOTH locations.
// ---------------------------------------------------------------------------

describe('restartBackgroundDaemon stateFilePath override (Bug 48)', () => {
  let fakeHome: string;
  let globalStateDir: string;
  let globalPidFile: string;
  let globalStateFile: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'daemon-path-mismatch-restart-'));
    globalStateDir = join(fakeHome, '.claude', '.claude-flow');
    mkdirSync(globalStateDir, { recursive: true });
    globalPidFile = join(globalStateDir, 'daemon.pid');
    globalStateFile = join(globalStateDir, 'daemon-state.json');
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('targets the global location when stateFilePath is set, leaving cwd-local untouched', async () => {
    // Both locations have PID files; we only target the global one.
    writeFileSync(pidFile, '11111');
    writeFileSync(globalPidFile, '22222');
    writeFileSync(globalStateFile, JSON.stringify({ running: true }));

    const sigterms: number[] = [];
    const killer: ProcessKiller = (pid, signal) => {
      if (signal === 0) throw new Error('ESRCH'); // simulate process gone
      if (signal === 'SIGTERM') sigterms.push(pid);
      return true;
    };

    const result = await restartBackgroundDaemon({
      projectRoot: tmp,
      clearState: true,
      stateFilePath: globalStateFile,
      killer,
      sleep: () => Promise.resolve(),
    });

    // We targeted the global PID (22222), not the cwd-local one (11111).
    expect(result.pid).toBe(22222);
    // No SIGTERM because the killer says ESRCH on signal-0 — the daemon
    // was already dead by the time we checked. We DO unlink the pid+state.
    expect(existsSync(globalPidFile)).toBe(false);
    expect(existsSync(globalStateFile)).toBe(false);
    // CWD-local pid file MUST be untouched.
    expect(existsSync(pidFile)).toBe(true);
  });

  it('kills daemons in BOTH locations when called once per detected mismatch', async () => {
    // This mirrors what `daemon restart --force-path` does in the action:
    // call detectDaemonPathMismatches() then restartBackgroundDaemon() once
    // per result with the matching stateFilePath.
    writeFileSync(pidFile, '11111');
    writeFileSync(stateFile, JSON.stringify({ running: true }));
    writeFileSync(globalPidFile, '22222');
    writeFileSync(globalStateFile, JSON.stringify({ running: true }));

    const sigterms: number[] = [];
    let aliveSet = new Set([11111, 22222]);
    const killer: ProcessKiller = (pid, signal) => {
      if (signal === 0) {
        if (!aliveSet.has(pid)) throw new Error('ESRCH');
        return true;
      }
      if (signal === 'SIGTERM') {
        sigterms.push(pid);
        aliveSet.delete(pid); // simulate graceful shutdown
        return true;
      }
      return true;
    };

    const mismatches = await detectDaemonPathMismatches({
      projectRoot: tmp,
      homedir: fakeHome,
      expectedPath: '/install/cli.js',
      readRunningCommand: () => '/stale/cli.js',
      canonicalize: (p) => p,
    });
    expect(mismatches).toHaveLength(2);

    const killedPids: number[] = [];
    for (const m of mismatches) {
      const result = await restartBackgroundDaemon({
        projectRoot: tmp,
        clearState: true,
        stateFilePath: m.stateFilePath,
        killer,
        sleep: () => Promise.resolve(),
        graceMs: 100,
      });
      if (result.killed && result.pid !== null) killedPids.push(result.pid);
    }

    // Both daemons received SIGTERM and were cleaned up.
    expect(sigterms.sort()).toEqual([11111, 22222]);
    expect(killedPids.sort()).toEqual([11111, 22222]);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(globalPidFile)).toBe(false);
    expect(existsSync(globalStateFile)).toBe(false);
  });
});
