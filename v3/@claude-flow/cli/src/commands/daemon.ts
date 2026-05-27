/**
 * V3 CLI Daemon Command
 * Manages background worker daemon (Node.js-based, similar to shell helpers)
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { WorkerDaemon, getDaemon, startDaemon, stopDaemon, type WorkerType, type DaemonConfig } from '../services/worker-daemon.js';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';
import * as fs from 'fs';

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
    // ADR-072 / #1916: queen-dispatcher opt-in via CLI flags. Mirrors
    // the config.{yaml,json} `daemon.queenDispatcher.*` keys for
    // operators who'd rather flip behaviour at start time than edit a
    // config file. Either source works; CLI wins.
    { name: 'queen-dispatcher', type: 'boolean', description: 'Enable the queen-dispatcher loop that drives assigned swarm tasks through HeadlessWorkerExecutor (ADR-072 / #1916)' },
    { name: 'queen-poll-ms', type: 'string', description: 'Queen-dispatcher poll interval in ms (default 5000)' },
    { name: 'queen-max-concurrent', type: 'string', description: 'Queen-dispatcher global max concurrent task executions (default 2)' },
    { name: 'queen-sandbox', type: 'string', description: 'Queen-dispatcher sandbox mode for spawned claude sessions', choices: ['strict', 'permissive', 'disabled'] },
    // #1914: workspace root for this daemon. Set automatically when the
    // background launcher forks the foreground child so the daemon process
    // carries its workspace path in argv — `killStaleDaemons` then only
    // reaps daemons belonging to the current workspace (ADR-014 scope).
    { name: 'workspace', type: 'string', description: 'Workspace root for this daemon (internal — set automatically when forking)' },
  ],
  examples: [
    { command: 'claude-flow daemon start', description: 'Start daemon in background (default)' },
    { command: 'claude-flow daemon start --foreground', description: 'Start in foreground (blocks terminal)' },
    { command: 'claude-flow daemon start -w map,audit,optimize', description: 'Start with specific workers' },
    { command: 'claude-flow daemon start --headless --sandbox strict', description: 'Start with headless workers in strict sandbox' },
    { command: 'claude-flow daemon start --queen-dispatcher', description: 'Start with the ADR-072 queen-dispatcher (drives assigned swarm tasks)' },
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

    // ADR-072 / #1916: parse queen-dispatcher flags. Re-uses the same
    // strict numeric pattern as the resource thresholds to prevent
    // command injection when forwarding to the forked background
    // subprocess.
    const queenEnabled = ctx.flags['queen-dispatcher'] as boolean | undefined;
    const rawQueenPoll = ctx.flags['queen-poll-ms'] as string | undefined;
    const rawQueenMax = ctx.flags['queen-max-concurrent'] as string | undefined;
    const rawQueenSandbox = ctx.flags['queen-sandbox'] as string | undefined;
    if (queenEnabled || rawQueenPoll || rawQueenMax || rawQueenSandbox) {
      const qd: DaemonConfig['queenDispatcher'] = { enabled: queenEnabled === true };
      if (rawQueenPoll) {
        const v = parseFloat(rawQueenPoll);
        if (NUMERIC_RE.test(rawQueenPoll) && isFinite(v) && v >= 100 && v <= 600_000) {
          qd.pollIntervalMs = v;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --queen-poll-ms value: ${sanitize(rawQueenPoll)}`);
        }
      }
      if (rawQueenMax) {
        const v = parseFloat(rawQueenMax);
        if (NUMERIC_RE.test(rawQueenMax) && isFinite(v) && v >= 1 && v <= 50) {
          qd.maxConcurrent = v;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --queen-max-concurrent value: ${sanitize(rawQueenMax)}`);
        }
      }
      if (rawQueenSandbox && ['strict', 'permissive', 'disabled'].includes(rawQueenSandbox)) {
        qd.sandbox = rawQueenSandbox as 'strict' | 'permissive' | 'disabled';
      } else if (rawQueenSandbox && !quiet) {
        output.printWarning(`Ignoring invalid --queen-sandbox value: ${sanitize(rawQueenSandbox)}`);
      }
      config.queenDispatcher = qd;
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
      return startBackgroundDaemon(projectRoot, quiet, {
        maxCpuLoad: rawMaxCpu,
        minFreeMemory: rawMinMem,
        workers: ctx.flags.workers as string | undefined,
        headless: ctx.flags.headless as boolean | undefined,
        sandbox: ctx.flags.sandbox as string | undefined,
        // ADR-072 / #1916: forward queen-dispatcher flags.
        queenDispatcher: ctx.flags['queen-dispatcher'] as boolean | undefined,
        queenPollMs: ctx.flags['queen-poll-ms'] as string | undefined,
        queenMaxConcurrent: ctx.flags['queen-max-concurrent'] as string | undefined,
        queenSandbox: ctx.flags['queen-sandbox'] as string | undefined,
      });
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
interface ForwardedDaemonFlags {
  maxCpuLoad?: string;
  minFreeMemory?: string;
  workers?: string;
  headless?: boolean;
  sandbox?: string;
  // ADR-072 / #1916 — queen-dispatcher opt-in. The launcher forwards
  // these to the foreground child so `daemon start --queen-dispatcher`
  // works without `--foreground`.
  queenDispatcher?: boolean;
  queenPollMs?: string;
  queenMaxConcurrent?: string;
  queenSandbox?: string;
}

async function startBackgroundDaemon(projectRoot: string, quiet: boolean, forwarded: ForwardedDaemonFlags = {}): Promise<CommandResult> {
  const { maxCpuLoad, minFreeMemory, workers, headless, sandbox, queenDispatcher, queenPollMs, queenMaxConcurrent, queenSandbox } = forwarded;
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

  // Platform-aware spawn flags
  const isWin = process.platform === 'win32';
  const spawnOpts: Record<string, unknown> = {
    cwd: resolvedRoot,
    detached: !isWin,  // detached is POSIX-only; Windows uses windowsHide
    // Use 'ignore' for all stdio — passing fs.openSync() FDs causes the child to
    // die on Windows when the parent exits and closes the FDs (#1478 Bug 3).
    // The daemon writes its own logs via appendFileSync to .claude-flow/logs/.
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      CLAUDE_FLOW_DAEMON: '1',
      // Prevent macOS SIGHUP kill when terminal closes
      ...(process.platform === 'darwin' ? { NOHUP: '1' } : {}),
    },
    // Avoid shell-mode spawn on Windows. Shell parsing can break quoted
    // executable paths like "C:\Program Files\..." and cause stale PID files.
    ...(isWin ? { windowsHide: true } : {}),
  };

  // Use spawn with explicit arguments instead of shell string interpolation
  // This prevents command injection via paths
  const spawnArgs = [
    cliPath,
    'daemon', 'start', '--foreground', '--quiet',
  ];
  // Forward resource threshold flags to the foreground child process
  // Validate with strict numeric pattern to prevent shell injection on Windows (S1)
  const SPAWN_NUMERIC_RE = /^\d+(\.\d+)?$/;
  if (maxCpuLoad && SPAWN_NUMERIC_RE.test(maxCpuLoad)) {
    spawnArgs.push('--max-cpu-load', maxCpuLoad);
  }
  if (minFreeMemory && SPAWN_NUMERIC_RE.test(minFreeMemory)) {
    spawnArgs.push('--min-free-memory', minFreeMemory);
  }
  if (typeof sandbox === 'string' && (sandbox === 'strict' || sandbox === 'permissive' || sandbox === 'disabled')) {
    forkArgs.push('--sandbox', sandbox);
  }
  // ADR-072 / #1916 — forward queen-dispatcher flags. Same numeric /
  // enum validation as the resource flags above so a crafted CLI
  // string can't smuggle anything into the forked child's argv.
  if (queenDispatcher === true) {
    forkArgs.push('--queen-dispatcher');
  }
  if (typeof queenPollMs === 'string' && SPAWN_NUMERIC_RE.test(queenPollMs)) {
    forkArgs.push('--queen-poll-ms', queenPollMs);
  }
  if (typeof queenMaxConcurrent === 'string' && SPAWN_NUMERIC_RE.test(queenMaxConcurrent)) {
    forkArgs.push('--queen-max-concurrent', queenMaxConcurrent);
  }
  if (typeof queenSandbox === 'string' && (queenSandbox === 'strict' || queenSandbox === 'permissive' || queenSandbox === 'disabled')) {
    forkArgs.push('--queen-sandbox', queenSandbox);
  }
  // #1914: stamp the workspace into argv (kept LAST) so the foreground daemon
  // process is self-identifying and `killStaleDaemons` only reaps daemons
  // belonging to this workspace. resolvedRoot was validatePath()'d above.
  forkArgs.push('--workspace', resolvedRoot);
  const child = fork(cliPath, forkArgs, forkOpts);

  // Get PID from spawned process directly (no shell echo needed)
  const pid = child.pid;

  if (!pid || pid <= 0) {
    output.printError('Failed to get daemon PID');
    return { success: false, exitCode: 1 };
  }

  // Unref immediately so parent can exit while child keeps running.
  child.unref();

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
 * Uses platform-appropriate commands to find all daemon processes for this project.
 */
async function killStaleDaemons(projectRoot: string, quiet: boolean): Promise<void> {
  try {
    const { execFileSync } = await import('child_process');
    const isWindows = process.platform === 'win32';
    
    let psOutput: string;
    if (isWindows) {
      psOutput = execFileSync('tasklist', ['/FI', 'IMAGENAME node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf-8', timeout: 5000 });
    } else {
      psOutput = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8', timeout: 5000 });
    }
    
    const lines = psOutput.split('\n');
    const currentPid = process.pid;
    const trackedPid = getBackgroundDaemonPid(projectRoot);
    let killed = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      
      let pid: number;
      try {
        if (isWindows) {
          const parts = line.split(',');
          if (parts.length < 2) continue;
          pid = parseInt(parts[1].replace(/[^0-9]/g, ''), 10);
        } else {
          const pidStr = line.trim().split(/\t/)[0];
          pid = parseInt(pidStr, 10);
        }
      } catch {
        continue;
      }
      
      if (isNaN(pid) || pid === currentPid || pid === trackedPid) continue;
      if (!line.includes('daemon') && !line.includes('claude-flow') && !line.includes('claude-flow')) continue;
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
    // Process listing not available or failed — skip stale cleanup
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
