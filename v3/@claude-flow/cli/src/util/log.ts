/**
 * RuFlo CLI logging utility (Bug #35).
 *
 * Problem: subsystem packages (agentdb, @ruvector/*, agentic-flow) emit
 * `[LearningSystem] …`, `[GNNService] …`, `[SonaTrajectoryService] …`, etc.
 * directly via `console.log` / `console.warn`. Each `ruflo memory list`,
 * `ruflo route`, or `ruflo swarm status` invocation prints ~27 lines of
 * init noise, making piping impossible and dropping signal-to-noise to ~5%.
 *
 * Fix: a tiny level-gated logger that:
 *   - reads `RUFLO_LOG_LEVEL` (silent | error | warn | info | debug)
 *   - default is `warn` → init/info noise goes to file only
 *   - errors always go to stderr (and the file)
 *   - the log file lives in `~/.claude/logs/ruflo.log`
 *   - directory is lazy-created on first write so importing this module
 *     in a path that never logs (e.g. the bare `--version` path) costs
 *     ~zero filesystem syscalls.
 *
 * The CLI's `bin/cli.js` and `src/log-filters.ts` use this same level
 * threshold to decide whether to suppress matching subsystem-prefix lines
 * coming out of `console.log` from external packages we don't control.
 *
 * To debug a noisy run:
 *   RUFLO_LOG_LEVEL=debug ruflo memory list
 *
 * To go fully silent (e.g. for shell scripts that pipe stdout):
 *   RUFLO_LOG_LEVEL=silent ruflo memory list
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL: LogLevel = 'warn';

function readLevel(): LogLevel {
  const raw = String(process.env.RUFLO_LOG_LEVEL ?? DEFAULT_LEVEL).toLowerCase() as LogLevel;
  return raw in RANK ? raw : DEFAULT_LEVEL;
}

const LEVEL: LogLevel = readLevel();
const THRESHOLD = RANK[LEVEL];

const LOG_DIR = `${homedir()}/.claude/logs`;
const LOG_PATH = `${LOG_DIR}/ruflo.log`;

let dirReady = false;
function ensureDir(): void {
  if (dirReady) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    dirReady = true;
  } catch {
    // best-effort — never throw from a logger
  }
}

function appendToFile(level: LogLevel, msg: string): void {
  // Silent mode: write nothing anywhere, including the file. This lets
  // pipeline / cron users opt out of log growth entirely.
  if (LEVEL === 'silent') return;
  ensureDir();
  try {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    appendFileSync(LOG_PATH, line);
  } catch {
    // best-effort
  }
}

export function debug(msg: string): void {
  if (THRESHOLD >= RANK.debug) {
    process.stderr.write(`[debug] ${msg}\n`);
  }
  // Always file-log up to the configured threshold (debug level only writes
  // to the file when threshold permits — see appendToFile).
  if (THRESHOLD >= RANK.debug) appendToFile('debug', msg);
}

export function info(msg: string): void {
  if (THRESHOLD >= RANK.info) {
    process.stderr.write(`${msg}\n`);
  }
  // Default behaviour (threshold = warn) → file only, console silent. This is
  // exactly what "no-noise on stdout/stderr but I can grep the log later"
  // gives you.
  if (THRESHOLD >= RANK.info) appendToFile('info', msg);
  else if (THRESHOLD >= RANK.warn) appendToFile('info', msg);
}

export function warn(msg: string): void {
  if (THRESHOLD >= RANK.warn) {
    process.stderr.write(`${msg}\n`);
  }
  appendToFile('warn', msg);
}

export function error(msg: string): void {
  // Errors always surface to stderr regardless of level (unless silent).
  if (LEVEL !== 'silent') {
    process.stderr.write(`${msg}\n`);
  }
  appendToFile('error', msg);
}

/**
 * Returns true if the current log level allows surfacing the given subsystem
 * prefix (e.g. `[LearningSystem]`) to stdout/stderr. Used by log-filters.ts
 * to decide whether to swallow noisy `console.log` calls coming out of
 * external packages we can't modify.
 */
export function shouldSurfaceSubsystemNoise(): boolean {
  return THRESHOLD >= RANK.info;
}

/**
 * Append-only log writer for swallowed subsystem-noise lines. Bypasses the
 * stderr-write that `warn()` / `info()` do at their respective thresholds —
 * the caller has already decided that this particular line should NOT
 * surface to the user, only to the on-disk log. Used by log-filters.ts.
 */
export function fileOnly(level: LogLevel, msg: string): void {
  if (LEVEL === 'silent') return;
  appendToFile(level, msg);
}

export function getLogLevel(): LogLevel {
  return LEVEL;
}

export function getLogPath(): string {
  return LOG_PATH;
}
