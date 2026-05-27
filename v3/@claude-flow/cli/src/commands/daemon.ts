/**
 * V3 CLI Daemon Command
 * Manages background worker daemon (Node.js-based, similar to shell helpers)
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { WorkerDaemon, getDaemon, startDaemon, stopDaemon, type WorkerType, type DaemonConfig } from '../services/worker-daemon.js';
import { spawn, execFile, execFileSync, fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { swallowError } from '@claude-flow/shared';

// ---------------------------------------------------------------------------
// Bug 47 — stale-daemon-path detection.
//
// Background: when SwarmOps was forked from claude-flow, users frequently end
// up with a long-lived background daemon that was started from a *different*
// installed binary than the one their shell now resolves to (e.g. an old
// `~/.npm/_npx/<hash>/.../bin/cli.js` from before the fork). The daemon keeps
// running 4+ days, schedules workers, and silently uses pre-fork code — none
// of the SwarmOps fixes ever reach the background workers.
//
// detectDaemonPathMismatch() compares the running daemon's binary path to the
// one we'd fork *now* (the canonical SwarmOps install). It returns null when
// there's no mismatch (or when no daemon is running) and a structured
// DaemonPathInfo when the paths differ — the consumer (status / doctor /
// restart) decides how loud to be about it.
// ---------------------------------------------------------------------------

/** Information about a detected daemon-path mismatch. */
export interface DaemonPathInfo {
  /** Binary path the running daemon was started from (from `ps` output). */
  runningPath: string;
  /** Binary path the current SwarmOps install would fork. */
  expectedPath: string;
  /** PID of the running daemon. */
  pid: number;
  /** When the daemon was started (ISO-8601 string), or 'unknown' if not in state. */
  startedAt: string;
  /** Floor((now - startedAt) / 1 day), or 0 when startedAt is unknown. */
  ageDays: number;
  /**
   * Bug 48 — which `daemon-state.json` (and adjacent `daemon.pid`) location
   * this daemon was found via. There are two valid roots:
   *   - `<cwd>/.claude-flow/daemon-state.json` (project-scoped install)
   *   - `<homedir>/.claude/.claude-flow/daemon-state.json` (global install)
   * Captured so callers (status / doctor / restart) can tell the user
   * exactly which file points at which dead/stale daemon, and so that
   * `restart --force-path` can clean up state files in the right places.
   */
  stateFilePath: string;
}

/**
 * Optional injection points for testing. Default behaviour reads the real
 * `daemon.pid` / `daemon-state.json` and shells out to `ps`. Tests pass
 * stubs that simulate the various states without touching real files or
 * processes.
 */
export interface DaemonPathDetectorOptions {
  /** Project root override (defaults to `process.cwd()`). */
  projectRoot?: string;
  /** Override the resolved expected bin path (defaults to derive from this file's URL). */
  expectedPath?: string;
  /** Stub the `ps -p <pid> -o command=` lookup. Returns the binary path token (no args), or null if PID is gone. */
  readRunningCommand?: (pid: number) => string | null;
  /** Stub `realpath` canonicalisation. Defaults to `fs.realpathSync` with a passthrough fallback. */
  canonicalize?: (p: string) => string;
  /**
   * Bug 48 — explicit override for the candidate state-file locations. When
   * present, replaces the default `getAllDaemonStatePaths()` enumeration.
   * Tests use this to point at a tmpdir without monkey-patching `os.homedir`.
   * For backwards compatibility with the singular `detectDaemonPathMismatch`,
   * if `projectRoot` is set and `stateFilePaths` is NOT, the singular helper
   * still scans only the cwd-local location (preserves Bug 47 semantics).
   */
  stateFilePaths?: string[];
  /**
   * Bug 48 — homedir override for default candidate enumeration. Defaults to
   * `os.homedir()`. Tests use this to deterministically locate the global
   * `<home>/.claude/.claude-flow/daemon-state.json` candidate.
   */
  homedir?: string;
}

/**
 * Compute the absolute path to `bin/cli.js` for the *currently-installed*
 * SwarmOps. The daemon command file lives at `dist/src/commands/daemon.js`
 * at runtime; from there, `../../../bin/cli.js` lands on the @claude-flow/cli
 * package's bin entry — this is the same calculation `startBackgroundDaemon`
 * already uses to fork the child, so the two will always agree.
 */
function deriveExpectedDaemonBin(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return resolve(join(__dirname, '..', '..', '..', 'bin', 'cli.js'));
}

/**
 * Best-effort `realpath` — falls back to the input when the path doesn't
 * exist (e.g. a stale daemon whose binary has been deleted). We never throw
 * here because the whole point is to *report* the mismatch, not crash.
 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    swallowError('detect-daemon-path-mismatch.realpath', err, p);
    return p;
  }
}

/**
 * Read the running daemon's command line via `ps -p <pid> -o command=`.
 * Returns the first whitespace-delimited token (the binary path), stripping
 * the `daemon start --foreground …` argv tail. Returns null if `ps` reports
 * the PID is gone or if the call fails for any reason.
 */
function defaultReadRunningCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    // ps may emit "node /path/to/cli.js daemon start --foreground …"
    // Strip the leading interpreter token if present so we're comparing
    // *script* paths, not "node" vs "/usr/local/bin/node".
    const tokens = out.split(/\s+/);
    if (tokens.length === 0) return null;
    // If first token is something like 'node' / a node binary, take the next
    // token as the script path. Otherwise the first token IS the script
    // (rare on macOS but possible if ps was invoked with -o args= elsewhere).
    const isNodeInterpreter = /(^|\/)node(\d+)?$/.test(tokens[0]);
    const scriptToken = isNodeInterpreter && tokens.length > 1 ? tokens[1] : tokens[0];
    return scriptToken;
  } catch (err) {
    // PID gone, ps unavailable, or permission denied — caller treats this
    // as "no mismatch detectable" rather than an error condition.
    swallowError('detect-daemon-path-mismatch.ps', err, String(pid));
    return null;
  }
}

/**
 * Bug 48 — return all locations a `daemon-state.json` could legitimately
 * live, in priority order. We enumerate BOTH (rather than picking one via
 * `resolveInstallContext().claudeRoot`) because a daemon may be running in
 * either location regardless of which install context the caller's cwd
 * resolves to. Callers filter by `existsSync` to ignore empty slots.
 *
 * Order:
 *   1. `<cwd>/.claude-flow/daemon-state.json` — project-scoped install
 *   2. `<homedir>/.claude/.claude-flow/daemon-state.json` — global install
 *
 * The PID file lives next to the state file; callers derive
 * `dirname(stateFilePath) + '/daemon.pid'` rather than enumerating both.
 */
function getAllDaemonStatePaths(cwd: string = process.cwd(), home: string = os.homedir()): string[] {
  const paths = [
    join(cwd, '.claude-flow', 'daemon-state.json'),
    join(home, '.claude', '.claude-flow', 'daemon-state.json'),
  ];
  // Deduplicate in the rare case where cwd is exactly `<home>/.claude` and
  // both candidates would resolve to the same file. We compare strings only
  // (no realpath) — symlink resolution happens later in `safeRealpath`.
  return Array.from(new Set(paths));
}

/**
 * Bug 48 — internal helper that probes ONE state-file location for a
 * mismatched daemon. Returns null when:
 *   - the adjacent `daemon.pid` doesn't exist or is malformed,
 *   - `ps` reports the PID gone,
 *   - the canonicalized running path matches expected.
 *
 * The state file itself is OPTIONAL — we read `startedAt` from it when
 * present, but the canonical "is this daemon mismatched?" signal comes
 * from `daemon.pid` + `ps`. This matches Bug 47's original semantics.
 */
function detectMismatchAtLocation(
  stateFilePath: string,
  expectedPathRaw: string,
  readRunningCommand: (pid: number) => string | null,
  canonicalize: (p: string) => string,
): DaemonPathInfo | null {
  const stateDir = dirname(stateFilePath);
  const pidFile = join(stateDir, 'daemon.pid');

  if (!fs.existsSync(pidFile)) return null;

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch (err) {
    swallowError('detect-daemon-path-mismatch.read-pid', err, pidFile);
    return null;
  }
  if (!pid || isNaN(pid) || pid <= 0) return null;

  const runningPathRaw = readRunningCommand(pid);
  if (!runningPathRaw) {
    // PID gone or not readable — caller treats as "no mismatch detectable".
    return null;
  }

  const runningPath = canonicalize(runningPathRaw);
  const expectedPath = canonicalize(expectedPathRaw);

  if (runningPath === expectedPath) return null;

  // Pull startedAt + age from daemon-state.json if available. Missing or
  // malformed state file → 'unknown' / 0 (graceful: we still report the
  // mismatch even if state metadata is gone).
  let startedAt = 'unknown';
  let ageDays = 0;
  if (fs.existsSync(stateFilePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as { startedAt?: string };
      if (state.startedAt) {
        startedAt = state.startedAt;
        const startMs = Date.parse(state.startedAt);
        if (!isNaN(startMs)) {
          ageDays = Math.floor((Date.now() - startMs) / 86_400_000);
        }
      }
    } catch (err) {
      swallowError('detect-daemon-path-mismatch.read-state', err, stateFilePath);
    }
  }

  return {
    runningPath: runningPathRaw,
    expectedPath: expectedPathRaw,
    pid,
    startedAt,
    ageDays,
    stateFilePath,
  };
}

/**
 * Bug 48 — detect ALL running daemons whose binary path doesn't match the
 * current install. Returns an array (may be empty).
 *
 * Why plural: Bug 47's `detectDaemonPathMismatch()` only checked the
 * cwd-local `.claude-flow/daemon-state.json`. During smoke testing the
 * lead found a real failure: when a daemon was running from
 * `~/.claude/.claude-flow/daemon-state.json` but the user invoked
 * `daemon restart --force-path` from a different cwd, the singular helper
 * returned null and the restart said "No running daemon to stop" — leaving
 * the stale daemon alive and forking a SECOND one. The plural variant
 * scans BOTH possible state-file locations.
 *
 * Same null-cases as the singular: missing/malformed pid file, dead PID,
 * matching canonical paths. PID files at locations that don't exist or
 * don't match are silently skipped.
 */
export async function detectDaemonPathMismatches(
  opts: DaemonPathDetectorOptions = {},
): Promise<DaemonPathInfo[]> {
  const cwd = opts.projectRoot ?? process.cwd();
  const home = opts.homedir ?? os.homedir();
  const stateFilePaths = opts.stateFilePaths ?? getAllDaemonStatePaths(cwd, home);
  const expectedPathRaw = opts.expectedPath ?? deriveExpectedDaemonBin();
  const readRunningCommand = opts.readRunningCommand ?? defaultReadRunningCommand;
  const canonicalize = opts.canonicalize ?? safeRealpath;

  // De-duplicate by PID — if both state-file candidates point at the same
  // running daemon (shouldn't happen in practice, but cheap to guard), we
  // only report it once.
  const results: DaemonPathInfo[] = [];
  const seenPids = new Set<number>();
  for (const stateFilePath of stateFilePaths) {
    const info = detectMismatchAtLocation(stateFilePath, expectedPathRaw, readRunningCommand, canonicalize);
    if (info && !seenPids.has(info.pid)) {
      seenPids.add(info.pid);
      results.push(info);
    }
  }
  return results;
}

/**
 * Bug 47 backwards-compatibility alias — returns the FIRST mismatched
 * daemon (or null if there are none). Existing callers (`daemon status`
 * and `doctor`) and the original Bug 47 tests rely on this signature, so
 * we keep it as a thin wrapper around `detectDaemonPathMismatches()`.
 *
 * Behaviour preserved when `opts.stateFilePaths` is NOT explicitly set
 * AND `opts.projectRoot` IS set: we scan ONLY the cwd-local location, the
 * same as the original implementation. This keeps Bug 47's tests (which
 * write a single tmpdir and never expected to enumerate $HOME) passing.
 * When neither is overridden, both default locations are scanned.
 */
export async function detectDaemonPathMismatch(
  opts: DaemonPathDetectorOptions = {},
): Promise<DaemonPathInfo | null> {
  // Bug 47 compat: if the caller pinned a projectRoot but didn't supply
  // explicit candidate paths, scan ONLY the cwd-local location. This
  // preserves the original tmpdir-based test semantics.
  let resolvedOpts = opts;
  if (opts.projectRoot && !opts.stateFilePaths) {
    resolvedOpts = {
      ...opts,
      stateFilePaths: [join(opts.projectRoot, '.claude-flow', 'daemon-state.json')],
    };
  }
  const results = await detectDaemonPathMismatches(resolvedOpts);
  return results.length > 0 ? results[0] : null;
}

// Start daemon subcommand
const startCommand: Command = {
  name: 'start',
  description: 'Start the worker daemon with all enabled background workers',
  options: [
    { name: 'workers', short: 'w', type: 'string', description: 'Comma-separated list of workers to enable (default: map,audit,optimize,consolidate,testgaps)' },
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
    { name: 'background', short: 'b', type: 'boolean', description: 'Run daemon in background (detached process)', default: true },
    { name: 'foreground', short: 'f', type: 'boolean', description: 'Run daemon in foreground (blocks terminal)' },
    { name: 'headless', type: 'boolean', description: 'Enable headless worker execution (E2B sandbox)' },
    { name: 'sandbox', type: 'string', description: 'Default sandbox mode for headless workers', choices: ['strict', 'permissive', 'disabled'] },
    { name: 'max-cpu-load', type: 'string', description: 'Override maxCpuLoad resource threshold (e.g. 4.0)' },
    { name: 'min-free-memory', type: 'string', description: 'Override minFreeMemoryPercent resource threshold (e.g. 15)' },
  ],
  examples: [
    { command: 'claude-flow daemon start', description: 'Start daemon in background (default)' },
    { command: 'claude-flow daemon start --foreground', description: 'Start in foreground (blocks terminal)' },
    { command: 'claude-flow daemon start -w map,audit,optimize', description: 'Start with specific workers' },
    { command: 'claude-flow daemon start --headless --sandbox strict', description: 'Start with headless workers in strict sandbox' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const foreground = ctx.flags.foreground as boolean;
    const projectRoot = process.cwd();
    const isDaemonProcess = process.env.CLAUDE_FLOW_DAEMON === '1';

    // Parse resource threshold overrides from CLI flags
    const config: Partial<DaemonConfig> = {};
    const rawMaxCpu = ctx.flags['max-cpu-load'] as string | undefined;
    const rawMinMem = ctx.flags['min-free-memory'] as string | undefined;

    // Strict numeric pattern to prevent command injection when forwarding to subprocess (S1)
    const NUMERIC_RE = /^\d+(\.\d+)?$/;
    const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

    if (rawMaxCpu || rawMinMem) {
      const thresholds: { maxCpuLoad?: number; minFreeMemoryPercent?: number } = {};
      if (rawMaxCpu) {
        const val = parseFloat(rawMaxCpu);
        if (NUMERIC_RE.test(rawMaxCpu) && isFinite(val) && val > 0 && val <= 1000) {
          thresholds.maxCpuLoad = val;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --max-cpu-load value: ${sanitize(rawMaxCpu)}`);
        }
      }
      if (rawMinMem) {
        const val = parseFloat(rawMinMem);
        if (NUMERIC_RE.test(rawMinMem) && isFinite(val) && val >= 0 && val <= 100) {
          thresholds.minFreeMemoryPercent = val;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --min-free-memory value: ${sanitize(rawMinMem)}`);
        }
      }
      if (thresholds.maxCpuLoad !== undefined || thresholds.minFreeMemoryPercent !== undefined) {
        config.resourceThresholds = thresholds as DaemonConfig['resourceThresholds'];
      }
    }

    // Check if background daemon already running (skip if we ARE the daemon process)
    if (!isDaemonProcess) {
      const bgPid = getBackgroundDaemonPid(projectRoot);
      if (bgPid && isProcessRunning(bgPid)) {
        if (!quiet) {
          output.printWarning(`Daemon already running in background (PID: ${bgPid}). Stop it first with: daemon stop`);
        }
        return { success: true };
      }
      // #1551: Kill any stale daemon processes that weren't tracked by PID file
      await killStaleDaemons(projectRoot, quiet);
    }

    // Background mode (default): fork a detached process
    if (!foreground) {
      return startBackgroundDaemon(projectRoot, quiet, rawMaxCpu, rawMinMem);
    }

    // Foreground mode: run in current process (blocks terminal)
    try {
      const stateDir = join(projectRoot, '.claude-flow');
      const pidFile = join(stateDir, 'daemon.pid');

      // Ensure state directory exists
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }

      // NOTE: Do NOT write PID file here — startDaemon() writes it internally.
      // Writing it before startDaemon() causes checkExistingDaemon() to detect
      // our own PID and return early, leaving no workers scheduled (#1478 Bug 1).

      // Clean up PID file on exit
      const cleanup = () => {
        try {
          if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
          }
        } catch { /* ignore */ }
      };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
      // Ignore SIGHUP on macOS/Linux — prevents daemon death when terminal closes (#1283)
      if (process.platform !== 'win32') {
        process.on('SIGHUP', () => { /* ignore — keep running */ });
      }

      if (!quiet) {
        const spinner = output.createSpinner({ text: 'Starting worker daemon...', spinner: 'dots' });
        spinner.start();

        const daemon = await startDaemon(projectRoot, config);
        const status = daemon.getStatus();

        spinner.succeed('Worker daemon started (foreground mode)');

        output.writeln();
        output.printBox(
          [
            `PID: ${status.pid}`,
            `Started: ${status.startedAt?.toISOString()}`,
            `Workers: ${status.config.workers.filter(w => w.enabled).length} enabled`,
            `Max Concurrent: ${status.config.maxConcurrent}`,
            `Max CPU Load: ${status.config.resourceThresholds.maxCpuLoad}`,
            `Min Free Memory: ${status.config.resourceThresholds.minFreeMemoryPercent}%`,
          ].join('\n'),
          'Daemon Status'
        );

        output.writeln();
        output.writeln(output.bold('Scheduled Workers'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Worker', width: 15 },
            { key: 'interval', header: 'Interval', width: 12 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'description', header: 'Description', width: 30 },
          ],
          data: status.config.workers
            .filter(w => w.enabled)
            .map(w => ({
              type: output.highlight(w.type),
              interval: `${Math.round(w.intervalMs / 60000)}min`,
              priority: w.priority === 'critical' ? output.error(w.priority) :
                       w.priority === 'high' ? output.warning(w.priority) :
                       output.dim(w.priority),
              description: w.description,
            })),
        });

        output.writeln();
        output.writeln(output.dim('Press Ctrl+C to stop daemon'));

        // Listen for worker events
        daemon.on('worker:start', ({ type }: { type: string }) => {
          output.writeln(output.dim(`[daemon] Worker starting: ${type}`));
        });

        daemon.on('worker:complete', ({ type, durationMs }: { type: string; durationMs: number }) => {
          output.writeln(output.success(`[daemon] Worker completed: ${type} (${durationMs}ms)`));
        });

        daemon.on('worker:error', ({ type, error }: { type: string; error: string }) => {
          output.writeln(output.error(`[daemon] Worker failed: ${type} - ${error}`));
        });

        // Keep process alive — setInterval creates a ref'd handle that prevents
        // Node.js from exiting even when startDaemon's timers are unref'd (#1478 Bug 2).
        setInterval(() => {}, 60_000);
        await new Promise(() => {}); // Never resolves - daemon runs until killed
      } else {
        await startDaemon(projectRoot, config);
        setInterval(() => {}, 60_000); // Keep alive with ref'd handle (#1478)
        await new Promise(() => {}); // Keep alive
      }

      return { success: true };
    } catch (error) {
      output.printError(`Failed to start daemon: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Validate path for security - prevents path traversal and injection
 */
function validatePath(path: string, label: string): void {
  // Must be absolute after resolution
  const resolved = resolve(path);

  // Check for null bytes (injection attack)
  if (path.includes('\0')) {
    throw new Error(`${label} contains null bytes`);
  }

  // Check for shell metacharacters in path components
  if (/[;&|`$<>]/.test(path)) {
    throw new Error(`${label} contains shell metacharacters`);
  }

  // Prevent path traversal outside expected directories
  if (!resolved.includes('.claude-flow') && !resolved.includes('bin')) {
    // Allow only paths within project structure
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd)) {
      throw new Error(`${label} escapes project directory`);
    }
  }
}

/**
 * Start daemon as a detached background process
 */
async function startBackgroundDaemon(projectRoot: string, quiet: boolean, maxCpuLoad?: string, minFreeMemory?: string): Promise<CommandResult> {
  // Validate and resolve project root
  const resolvedRoot = resolve(projectRoot);
  validatePath(resolvedRoot, 'Project root');

  const stateDir = join(resolvedRoot, '.claude-flow');
  const pidFile = join(stateDir, 'daemon.pid');
  const logFile = join(stateDir, 'daemon.log');

  // Validate all paths
  validatePath(stateDir, 'State directory');
  validatePath(pidFile, 'PID file');
  validatePath(logFile, 'Log file');

  // Ensure state directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Get path to CLI (from dist/src/commands/daemon.js -> bin/cli.js)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/src/commands -> dist/src -> dist -> package root -> bin/cli.js
  const cliPath = resolve(join(__dirname, '..', '..', '..', 'bin', 'cli.js'));
  validatePath(cliPath, 'CLI path');

  // Verify CLI path exists
  if (!fs.existsSync(cliPath)) {
    output.printError(`CLI not found at: ${cliPath}`);
    return { success: false, exitCode: 1 };
  }

  // Platform-aware spawn flags. We use child_process.fork() because the daemon
  // child is itself a Node script — fork() spawns Node directly and skips the
  // cmd.exe interpretation pass that broke Windows + Node 25 when
  // process.execPath contained a space (#1691). It also avoids the [DEP0190]
  // shell:true security warning.
  const isWin = process.platform === 'win32';
  const forkOpts: Record<string, unknown> = {
    cwd: resolvedRoot,
    // detached: true on every platform (#1766). On Windows, leaving detached:false
    // kept the child in the parent's process group AND the IPC pipe held the
    // child to npx — when npx exited, the IPC pipe tore down and the daemon
    // died within ~1s. detached:true + child.disconnect() (below) gives the
    // child its own session/pgid and breaks the IPC pipe so the daemon
    // genuinely survives parent exit. On POSIX, detached:true was already the
    // path; this just makes Windows match.
    detached: true,
    // Use 'ignore' for all stdio + 'ignore' for the IPC channel via silent:true off.
    // fork() defaults to creating an IPC channel; we don't need it here, so we
    // pass stdio explicitly. Passing fs.openSync() FDs causes the child to die
    // on Windows when the parent exits and closes the FDs (#1478 Bug 3) — the
    // daemon writes its own logs via appendFileSync to .claude-flow/logs/.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_FLOW_DAEMON: '1',
      // Prevent macOS SIGHUP kill when terminal closes
      ...(process.platform === 'darwin' ? { NOHUP: '1' } : {}),
    },
  };

  // Forward args to the foreground child. fork() resolves the script path
  // via Node's normal module resolution, so cliPath does not need to be
  // shell-quoted even when it contains spaces.
  const forkArgs = ['daemon', 'start', '--foreground', '--quiet'];
  // Validate with strict numeric pattern to prevent injection via crafted flags.
  const SPAWN_NUMERIC_RE = /^\d+(\.\d+)?$/;
  if (maxCpuLoad && SPAWN_NUMERIC_RE.test(maxCpuLoad)) {
    forkArgs.push('--max-cpu-load', maxCpuLoad);
  }
  if (minFreeMemory && SPAWN_NUMERIC_RE.test(minFreeMemory)) {
    forkArgs.push('--min-free-memory', minFreeMemory);
  }
  const child = fork(cliPath, forkArgs, forkOpts);

  // Get PID from spawned process directly (no shell echo needed)
  const pid = child.pid;

  if (!pid || pid <= 0) {
    output.printError('Failed to get daemon PID');
    return { success: false, exitCode: 1 };
  }

  // Unref BEFORE writing PID file — prevents race where parent exits
  // but child hasn't fully detached yet (fixes macOS daemon death #1283).
  child.unref();
  // #1766: also break the IPC pipe explicitly. unref() releases the libuv
  // handle but does NOT close the IPC channel; on Windows the open IPC
  // pipe keeps the daemon tied to its parent npx, and when npx exits the
  // pipe is torn down and the daemon exits with it. disconnect() severs
  // the IPC pipe so the daemon truly stands on its own. Wrapped in try
  // because disconnect() throws if the IPC channel is already gone.
  try { child.disconnect(); } catch { /* IPC channel already closed */ }

  // Longer delay to let the child process start and write its own PID file.
  // 100ms was too short on Windows; the child's checkExistingDaemon() would
  // find the parent-written PID and return early (#1478 Bug 1).
  await new Promise(resolve => setTimeout(resolve, 500));

  // Write PID file only if the child hasn't already written its own.
  // The foreground child calls writePidFile() internally, but on some platforms
  // it may not have started yet, so we write as a fallback.
  if (!fs.existsSync(pidFile)) {
    fs.writeFileSync(pidFile, String(pid));
  }

  if (!quiet) {
    output.printSuccess(`Daemon started in background (PID: ${pid})`);
    output.printInfo(`Logs: ${logFile}`);
    output.printInfo(`Stop with: claude-flow daemon stop`);
  }

  return { success: true };
}

// Stop daemon subcommand
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop the worker daemon and all background workers',
  options: [
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
  ],
  examples: [
    { command: 'claude-flow daemon stop', description: 'Stop the daemon' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const projectRoot = process.cwd();

    try {
      if (!quiet) {
        const spinner = output.createSpinner({ text: 'Stopping worker daemon...', spinner: 'dots' });
        spinner.start();

        // Try to stop in-process daemon first
        await stopDaemon();

        // Also kill any background daemon by PID
        const killed = await killBackgroundDaemon(projectRoot);

        // #1551: Also kill stale daemon processes not tracked by PID file
        await killStaleDaemons(projectRoot, true);

        spinner.succeed(killed ? 'Worker daemon stopped' : 'Worker daemon was not running');
      } else {
        await stopDaemon();
        await killBackgroundDaemon(projectRoot);
        await killStaleDaemons(projectRoot, true);
      }

      return { success: true };
    } catch (error) {
      output.printError(`Failed to stop daemon: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Process killer abstraction — allows tests to assert SIGTERM/SIGKILL flow
 * without actually shooting at real PIDs. Defaults to `process.kill`.
 */
export type ProcessKiller = (pid: number, signal: NodeJS.Signals | number) => boolean;
const defaultKiller: ProcessKiller = (pid, signal) => {
  process.kill(pid, signal);
  return true;
};

/**
 * Bug 47 — public restart helper. Sends SIGTERM, waits up to `graceMs`, then
 * SIGKILL if still alive. Cleans up PID/state files when `clearState` is set.
 * Returns true when something was killed (or a stale state file was wiped),
 * false when there was no daemon to deal with.
 *
 * Exposed for testing — the daemon `restart` subcommand calls this with
 * `killer = process.kill` and `sleep = setTimeout` defaults.
 *
 * Bug 48 — accepts an optional explicit `stateFilePath` so the caller can
 * target a daemon at either of the two valid locations (cwd-local or the
 * global `<homedir>/.claude/.claude-flow/`). When unset, defaults to the
 * cwd-local location, preserving Bug 47 behaviour.
 */
export async function restartBackgroundDaemon(opts: {
  projectRoot: string;
  clearState: boolean;
  graceMs?: number;
  killer?: ProcessKiller;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Bug 48 — explicit state-file path override. When set, the PID file is
   * derived as `dirname(stateFilePath) + '/daemon.pid'`. Otherwise we use
   * `<projectRoot>/.claude-flow/daemon-state.json` (Bug 47 default).
   */
  stateFilePath?: string;
}): Promise<{ killed: boolean; pid: number | null }> {
  const projectRoot = opts.projectRoot;
  const graceMs = opts.graceMs ?? 5000;
  const killer = opts.killer ?? defaultKiller;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stateFile = opts.stateFilePath ?? join(projectRoot, '.claude-flow', 'daemon-state.json');
  const pidFile = join(dirname(stateFile), 'daemon.pid');

  let pid: number | null = null;
  if (fs.existsSync(pidFile)) {
    try {
      const raw = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(raw) && raw > 0) pid = raw;
    } catch (err) {
      swallowError('restart-background-daemon.read-pid', err, pidFile);
    }
  }

  let killed = false;
  if (pid !== null) {
    // Check if alive — ENOENT/ESRCH means already dead.
    let alive = true;
    try {
      killer(pid, 0);
    } catch {
      alive = false;
    }

    if (alive) {
      try {
        killer(pid, 'SIGTERM');
        killed = true;
      } catch (err) {
        swallowError('restart-background-daemon.sigterm', err, String(pid));
      }
      // Poll up to graceMs for graceful shutdown.
      const pollMs = Math.max(50, Math.min(500, Math.floor(graceMs / 10)));
      const start = Date.now();
      while (Date.now() - start < graceMs) {
        try {
          killer(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await sleep(pollMs);
      }
      if (alive) {
        try {
          killer(pid, 'SIGKILL');
        } catch (err) {
          swallowError('restart-background-daemon.sigkill', err, String(pid));
        }
      }
    }
  }

  // Clean up PID file unconditionally (covers both real-kill and
  // already-dead-but-stale cases).
  if (fs.existsSync(pidFile)) {
    try { fs.unlinkSync(pidFile); } catch (err) { swallowError('restart-background-daemon.unlink-pid', err, pidFile); }
    if (pid === null) killed = true; // we did clear *something*
  }

  // --force-path also wipes daemon-state.json so the new daemon starts fresh
  // rather than restoring stale worker-config from disk.
  if (opts.clearState && fs.existsSync(stateFile)) {
    try { fs.unlinkSync(stateFile); } catch (err) { swallowError('restart-background-daemon.unlink-state', err, stateFile); }
  }

  return { killed, pid };
}

// Restart daemon subcommand — Bug 47.
const restartCommand: Command = {
  name: 'restart',
  description: 'Restart the worker daemon (graceful SIGTERM, then SIGKILL after 5s)',
  options: [
    { name: 'force-path', type: 'boolean', description: 'Override path-mismatch refusal and wipe daemon-state.json' },
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress non-error output' },
  ],
  examples: [
    { command: 'claude-flow daemon restart', description: 'Restart daemon (refuses if running binary differs from install)' },
    { command: 'claude-flow daemon restart --force-path', description: 'Kill stale-path daemon and start fresh' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const forcePath = ctx.flags['force-path'] as boolean;
    const projectRoot = process.cwd();

    // Bug 48 — scan ALL valid state-file locations (cwd-local + global).
    // The Bug 47 implementation only checked the cwd-local one and missed
    // daemons running from `~/.claude/.claude-flow/daemon-state.json`.
    const mismatches = await detectDaemonPathMismatches();
    if (mismatches.length > 0 && !forcePath) {
      const noun = mismatches.length === 1 ? 'daemon' : 'daemons';
      output.printError(
        `Existing ${noun} (${mismatches.length}) don't match SwarmOps install.`
      );
      for (const m of mismatches) {
        const ageLabel = m.ageDays > 0
          ? `${m.ageDays} day${m.ageDays === 1 ? '' : 's'}`
          : 'recently';
        output.writeln(output.dim(`  - PID ${m.pid} (started ${ageLabel} ago)`));
        output.writeln(output.dim(`      running:  ${m.runningPath}`));
        output.writeln(output.dim(`      expected: ${m.expectedPath}`));
        output.writeln(output.dim(`      tracked at: ${m.stateFilePath}`));
      }
      output.writeln(output.dim(`  Use --force-path to override. This will kill ${mismatches.length === 1 ? 'this PID' : 'these PIDs'} and clean up state.`));
      return { success: false, exitCode: 1 };
    }

    try {
      // Bug 48 — when --force-path is set with mismatches, kill EACH one
      // (was only killing the cwd-local PID before, leaving the global
      // one alive). Also targets the matching state-file path so we wipe
      // the right daemon-state.json per location.
      let totalKilled = 0;
      const killedPids: number[] = [];
      if (forcePath && mismatches.length > 0) {
        for (const m of mismatches) {
          const result = await restartBackgroundDaemon({
            projectRoot,
            clearState: true,
            stateFilePath: m.stateFilePath,
          });
          if (result.killed) {
            totalKilled++;
            if (result.pid !== null) killedPids.push(result.pid);
          }
        }
      } else {
        // No mismatches OR --force-path without mismatches: fall back to the
        // cwd-local restart path (Bug 47 behaviour for the no-mismatch case).
        const result = await restartBackgroundDaemon({
          projectRoot,
          clearState: !!forcePath,
        });
        if (result.killed) {
          totalKilled++;
          if (result.pid !== null) killedPids.push(result.pid);
        }
      }

      if (!quiet) {
        if (totalKilled > 0 && killedPids.length > 0) {
          output.printInfo(`Stopped existing daemon${killedPids.length === 1 ? '' : 's'} (PID${killedPids.length === 1 ? '' : 's'} ${killedPids.join(', ')})`);
        } else if (totalKilled > 0) {
          output.printInfo('Cleaned up stale daemon state');
        } else {
          output.printInfo('No running daemon to stop');
        }
      }

      // Hand off to the existing background-start path.
      return await startBackgroundDaemon(projectRoot, !!quiet);
    } catch (error) {
      output.printError(`Failed to restart daemon: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Kill background daemon process using PID file
 */
async function killBackgroundDaemon(projectRoot: string): Promise<boolean> {
  const pidFile = join(projectRoot, '.claude-flow', 'daemon.pid');

  if (!fs.existsSync(pidFile)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

    if (isNaN(pid)) {
      fs.unlinkSync(pidFile);
      return false;
    }

    // Check if process is running
    try {
      process.kill(pid, 0); // Signal 0 = check if alive
    } catch {
      // Process not running, clean up stale PID file
      fs.unlinkSync(pidFile);
      return false;
    }

    // Kill the process
    process.kill(pid, 'SIGTERM');

    // Wait a moment then force kill if needed
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      process.kill(pid, 0);
      // Still alive, force kill
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process terminated
    }

    // Clean up PID file
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    return true;
  } catch (error) {
    // Clean up PID file on any error
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    return false;
  }
}

/**
 * Kill stale daemon processes not tracked by the PID file (#1551).
 * Uses `ps` to find all daemon processes for this project and kills them.
 */
async function killStaleDaemons(projectRoot: string, quiet: boolean): Promise<void> {
  try {
    const { execFileSync } = await import('child_process');
    const psOutput = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8', timeout: 5000 });
    const lines = psOutput.split('\n');
    const currentPid = process.pid;
    const trackedPid = getBackgroundDaemonPid(projectRoot);
    let killed = 0;

    for (const line of lines) {
      if (!line.includes('daemon start --foreground')) continue;
      if (!line.includes('claude-flow') && !line.includes('@claude-flow/cli')) continue;
      const pidStr = line.trim().split(/\s+/)[0];
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid) || pid === currentPid || pid === trackedPid) continue;
      if (!isProcessRunning(pid)) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
        if (!quiet) {
          output.printWarning(`Killed stale daemon process (PID: ${pid})`);
        }
      } catch { /* ignore — may have exited between check and kill */ }
    }

    if (killed > 0 && !quiet) {
      output.printInfo(`Cleaned up ${killed} stale daemon process(es)`);
    }
  } catch {
    // ps not available or failed — skip stale cleanup
  }
}

/**
 * Get PID of background daemon from PID file
 */
function getBackgroundDaemonPid(projectRoot: string): number | null {
  const pidFile = join(projectRoot, '.claude-flow', 'daemon.pid');

  if (!fs.existsSync(pidFile)) {
    return null;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if alive
    return true;
  } catch {
    return false;
  }
}

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show daemon and worker status',
  options: [
    { name: 'verbose', short: 'v', type: 'boolean', description: 'Show detailed worker statistics' },
    { name: 'show-modes', type: 'boolean', description: 'Show worker execution modes (local/headless) and sandbox settings' },
  ],
  examples: [
    { command: 'claude-flow daemon status', description: 'Show daemon status' },
    { command: 'claude-flow daemon status -v', description: 'Show detailed status' },
    { command: 'claude-flow daemon status --show-modes', description: 'Show worker execution modes' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const verbose = ctx.flags.verbose as boolean;
    const showModes = ctx.flags['show-modes'] as boolean;
    const projectRoot = process.cwd();

    try {
      const daemon = getDaemon(projectRoot);
      const status = daemon.getStatus();

      // Also check for background daemon
      const bgPid = getBackgroundDaemonPid(projectRoot);
      const bgRunning = bgPid ? isProcessRunning(bgPid) : false;

      const isRunning = status.running || bgRunning;
      const displayPid = bgPid || status.pid;

      output.writeln();

      // Daemon status box
      const statusIcon = isRunning ? output.success('●') : output.error('○');
      const statusText = isRunning ? output.success('RUNNING') : output.error('STOPPED');
      const mode = bgRunning ? output.dim(' (background)') : status.running ? output.dim(' (foreground)') : '';

      output.printBox(
        [
          `Status: ${statusIcon} ${statusText}${mode}`,
          `PID: ${displayPid}`,
          status.startedAt ? `Started: ${status.startedAt.toISOString()}` : '',
          `Workers Enabled: ${status.config.workers.filter(w => w.enabled).length}`,
          `Max Concurrent: ${status.config.maxConcurrent}`,
          `Max CPU Load: ${status.config.resourceThresholds.maxCpuLoad}`,
          `Min Free Memory: ${status.config.resourceThresholds.minFreeMemoryPercent}%`,
        ].filter(Boolean).join('\n'),
        'RuFlo Daemon'
      );

      output.writeln();
      output.writeln(output.bold('Worker Status'));

      const workerData = status.config.workers.map(w => {
        const state = status.workers.get(w.type);
        // Check for headless mode from worker config or state
        const isHeadless = (w as unknown as Record<string, unknown>).headless || (state as unknown as Record<string, unknown> | undefined)?.headless || false;
        const sandboxMode = (w as unknown as Record<string, unknown>).sandbox || (state as unknown as Record<string, unknown> | undefined)?.sandbox || null;
        return {
          type: w.enabled ? output.highlight(w.type) : output.dim(w.type),
          enabled: w.enabled ? output.success('✓') : output.dim('○'),
          status: state?.isRunning ? output.warning('running') :
                  w.enabled ? output.success('idle') : output.dim('disabled'),
          runs: state?.runCount ?? 0,
          success: state ? `${Math.round((state.successCount / Math.max(state.runCount, 1)) * 100)}%` : '-',
          lastRun: state?.lastRun ? formatTimeAgo(state.lastRun) : output.dim('never'),
          nextRun: state?.nextRun && w.enabled ? formatTimeUntil(state.nextRun) : output.dim('-'),
          mode: isHeadless ? output.highlight('headless') : output.dim('local'),
          sandbox: isHeadless ? (sandboxMode || 'strict') : output.dim('-'),
        };
      });

      // Build columns based on --show-modes flag
      const baseColumns = [
        { key: 'type', header: 'Worker', width: 12 },
        { key: 'enabled', header: 'On', width: 4 },
        { key: 'status', header: 'Status', width: 10 },
        { key: 'runs', header: 'Runs', width: 6 },
        { key: 'success', header: 'Success', width: 8 },
        { key: 'lastRun', header: 'Last Run', width: 12 },
        { key: 'nextRun', header: 'Next Run', width: 12 },
      ];

      const modeColumns = showModes ? [
        { key: 'mode', header: 'Mode', width: 10 },
        { key: 'sandbox', header: 'Sandbox', width: 12 },
      ] : [];

      output.printTable({
        columns: [...baseColumns, ...modeColumns],
        data: workerData,
      });

      if (verbose) {
        output.writeln();
        output.writeln(output.bold('Worker Configuration'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Worker', width: 12 },
            { key: 'interval', header: 'Interval', width: 10 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'avgDuration', header: 'Avg Duration', width: 12 },
            { key: 'description', header: 'Description', width: 30 },
          ],
          data: status.config.workers.map(w => {
            const state = status.workers.get(w.type);
            return {
              type: w.type,
              interval: `${Math.round(w.intervalMs / 60000)}min`,
              priority: w.priority,
              avgDuration: state?.averageDurationMs ? `${Math.round(state.averageDurationMs)}ms` : '-',
              description: w.description,
            };
          }),
        });
      }

      // Bug 47 + Bug 48 — surface stale-daemon-path mismatch(es).
      //
      // Bug 48 widens the scan from just the cwd-local state file to BOTH
      // candidate locations (cwd-local + global `~/.claude/.claude-flow/`).
      // We always check (not gated on `isRunning`) because the local
      // `getDaemon(projectRoot)` may not see a daemon that's actually live
      // in the OTHER location. One warning block per detected stale daemon.
      const mismatches = await detectDaemonPathMismatches();
      for (const mismatch of mismatches) {
        output.writeln();
        output.printWarning('STALE DAEMON DETECTED');
        const ageLabel = mismatch.ageDays > 0
          ? `${mismatch.ageDays} day${mismatch.ageDays === 1 ? '' : 's'} ago`
          : 'recently';
        output.writeln(output.dim(`  Running daemon (PID ${mismatch.pid}, started ${ageLabel}) is from:`));
        output.writeln(output.dim(`    ${mismatch.runningPath}`));
        output.writeln(output.dim(`  But your current SwarmOps install is at:`));
        output.writeln(output.dim(`    ${mismatch.expectedPath}`));
        output.writeln(output.dim(`  Tracked in state file:`));
        output.writeln(output.dim(`    ${mismatch.stateFilePath}`));
        output.writeln(output.dim(`  Background workers are NOT running SwarmOps code.`));
        output.writeln(output.dim(`  Run \`swarmops daemon restart --force-path\` to fix.`));
      }

      return { success: true, data: status };
    } catch (error) {
      // Daemon not initialized
      output.writeln();
      output.printBox(
        [
          `Status: ${output.error('○')} ${output.error('NOT INITIALIZED')}`,
          '',
          'Run "claude-flow daemon start" to start the daemon',
        ].join('\n'),
        'RuFlo Daemon'
      );

      return { success: true };
    }
  },
};

// Trigger subcommand - manually run a worker
const triggerCommand: Command = {
  name: 'trigger',
  description: 'Manually trigger a specific worker',
  options: [
    { name: 'worker', short: 'w', type: 'string', description: 'Worker type to trigger', required: true },
    { name: 'headless', type: 'boolean', description: 'Run triggered worker in headless mode (E2B sandbox)' },
  ],
  examples: [
    { command: 'claude-flow daemon trigger -w map', description: 'Trigger the map worker' },
    { command: 'claude-flow daemon trigger -w audit', description: 'Trigger security audit' },
    { command: 'claude-flow daemon trigger -w audit --headless', description: 'Trigger audit in headless sandbox' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerType = ctx.flags.worker as WorkerType;

    if (!workerType) {
      output.printError('Worker type is required. Use --worker or -w flag.');
      output.writeln();
      output.writeln('Available workers: map, audit, optimize, consolidate, testgaps, predict, document, ultralearn, refactor, benchmark, deepdive, preload');
      return { success: false, exitCode: 1 };
    }

    try {
      const daemon = getDaemon(process.cwd());

      const spinner = output.createSpinner({ text: `Running ${workerType} worker...`, spinner: 'dots' });
      spinner.start();

      const result = await daemon.triggerWorker(workerType);

      if (result.success) {
        spinner.succeed(`Worker ${workerType} completed in ${result.durationMs}ms`);

        if (result.output) {
          output.writeln();
          output.writeln(output.bold('Output'));
          output.printJson(result.output);
        }
      } else {
        spinner.fail(`Worker ${workerType} failed: ${result.error}`);
      }

      return { success: result.success, data: result };
    } catch (error) {
      output.printError(`Failed to trigger worker: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Enable/disable worker subcommand
const enableCommand: Command = {
  name: 'enable',
  description: 'Enable or disable a specific worker',
  options: [
    { name: 'worker', short: 'w', type: 'string', description: 'Worker type', required: true },
    { name: 'disable', short: 'd', type: 'boolean', description: 'Disable instead of enable' },
  ],
  examples: [
    { command: 'claude-flow daemon enable -w predict', description: 'Enable predict worker' },
    { command: 'claude-flow daemon enable -w document --disable', description: 'Disable document worker' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerType = ctx.flags.worker as WorkerType;
    const disable = ctx.flags.disable as boolean;

    if (!workerType) {
      output.printError('Worker type is required. Use --worker or -w flag.');
      return { success: false, exitCode: 1 };
    }

    try {
      const daemon = getDaemon(process.cwd());
      daemon.setWorkerEnabled(workerType, !disable);

      output.printSuccess(`Worker ${workerType} ${disable ? 'disabled' : 'enabled'}`);

      return { success: true };
    } catch (error) {
      output.printError(`Failed to ${disable ? 'disable' : 'enable'} worker: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Helper functions for time formatting
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTimeUntil(date: Date): string {
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);

  if (seconds < 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86400)}d`;
}

// Main daemon command
export const daemonCommand: Command = {
  name: 'daemon',
  description: 'Manage background worker daemon (Node.js-based, auto-runs like shell helpers)',
  subcommands: [
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    triggerCommand,
    enableCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow daemon start', description: 'Start the daemon' },
    { command: 'claude-flow daemon start --headless', description: 'Start with headless workers (E2B sandbox)' },
    { command: 'claude-flow daemon status', description: 'Check daemon status' },
    { command: 'claude-flow daemon stop', description: 'Stop the daemon' },
    { command: 'claude-flow daemon restart --force-path', description: 'Restart daemon, overriding stale-path lock (Bug 47)' },
    { command: 'claude-flow daemon trigger -w audit', description: 'Run security audit' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('RuFlo Daemon - Background Task Management'));
    output.writeln();
    output.writeln('Node.js-based background worker system that auto-runs like shell daemons.');
    output.writeln('Manages 12 specialized workers for continuous optimization and monitoring.');
    output.writeln();
    output.writeln(output.bold('Headless Mode'));
    output.writeln('Workers can run in headless mode using E2B sandboxes for isolated execution.');
    output.writeln('Use --headless flag with start/trigger commands. Sandbox modes: strict, permissive, disabled.');
    output.writeln();

    output.writeln(output.bold('Available Workers'));
    output.printList([
      `${output.highlight('map')}         - Codebase mapping (5 min interval)`,
      `${output.highlight('audit')}       - Security analysis (10 min interval)`,
      `${output.highlight('optimize')}    - Performance optimization (15 min interval)`,
      `${output.highlight('consolidate')} - Memory consolidation (30 min interval)`,
      `${output.highlight('testgaps')}    - Test coverage analysis (20 min interval)`,
      `${output.highlight('predict')}     - Predictive preloading (2 min, disabled by default)`,
      `${output.highlight('document')}    - Auto-documentation (60 min, disabled by default)`,
      `${output.highlight('ultralearn')}  - Deep knowledge acquisition (manual trigger)`,
      `${output.highlight('refactor')}    - Code refactoring suggestions (manual trigger)`,
      `${output.highlight('benchmark')}   - Performance benchmarking (manual trigger)`,
      `${output.highlight('deepdive')}    - Deep code analysis (manual trigger)`,
      `${output.highlight('preload')}     - Resource preloading (manual trigger)`,
    ]);

    output.writeln();
    output.writeln(output.bold('Subcommands'));
    output.printList([
      `${output.highlight('start')}   - Start the daemon`,
      `${output.highlight('stop')}    - Stop the daemon`,
      `${output.highlight('restart')} - Restart the daemon (use --force-path for stale-path)`,
      `${output.highlight('status')}  - Show daemon status`,
      `${output.highlight('trigger')} - Manually run a worker`,
      `${output.highlight('enable')}  - Enable/disable a worker`,
    ]);

    output.writeln();
    output.writeln('Run "claude-flow daemon <subcommand> --help" for details');

    return { success: true };
  },
};

export default daemonCommand;
