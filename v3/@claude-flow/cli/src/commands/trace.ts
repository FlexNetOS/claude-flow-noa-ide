/**
 * `swarmops trace` — replayable agent traces (Gap 1, Tier 2 differentiation).
 *
 * Subcommands:
 *   - list    — show recent trajectories (default 50, newest first), with --since/--agent/--limit/--json filters
 *   - replay  — render a single trajectory to a self-contained HTML file (or JSON to stdout)
 *   - prune   — delete rendered HTML files older than a threshold (default 30 days)
 *
 * The data layer (trace-loader) is locked to the contract documented in
 * services/trace-loader.ts. The rendering layer (trace-renderer) returns a
 * full HTML document — we never assemble HTML in this file.
 *
 * Design notes
 * ------------
 * - `--open` spawns the OS's default browser opener (`open` on macOS,
 *   `xdg-open` on Linux). Detached + stdio:'ignore' so the browser process
 *   doesn't keep the CLI alive. On other platforms we silently print the
 *   path and skip the open — better than failing on Windows.
 * - `--since` and `--older-than` accept either an ISO date OR a relative
 *   phrase like "2h", "30 days ago", "yesterday". Tiny inline parser, no
 *   date library — matches the lightweight CLI ethos elsewhere in v3.
 * - `--json` on `list` emits an array; on `replay` it emits the raw
 *   trajectory. Both are stable shapes for shell-piping into `jq`.
 *
 * @module v3/cli/commands/trace
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { resolveInstallContext, swallowError } from '@claude-flow/shared';

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import {
  listTrajectories,
  loadTrajectory,
  type LoadedTrajectory,
} from '../services/trace-loader.js';
import { renderTrace } from '../services/trace-renderer.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_PRUNE_OLDER_THAN_DAYS = 30;
const TRACES_SUBDIR = path.join('.claude-flow', 'traces');

// ============================================================================
// Path / IO helpers
// ============================================================================

/**
 * Resolve `<claudeRoot>/.claude-flow/traces`. Centralised so both the
 * `replay` writer and `prune` reader agree on one location.
 */
function getTracesDir(): string {
  const ctx = resolveInstallContext();
  return path.join(ctx.claudeRoot, TRACES_SUBDIR);
}

/**
 * Compute the on-disk HTML path for a session id. We use the full id as
 * the filename so prefix-collisions across renders never clobber.
 */
function getTraceHtmlPath(sessionId: string): string {
  return path.join(getTracesDir(), `${sessionId}.html`);
}

/**
 * Open a file in the OS default browser. Best-effort and non-blocking —
 * detached so the spawned process doesn't keep the Node event loop alive,
 * stdio:'ignore' so its output doesn't pollute our stdout/stderr.
 *
 * Returns true if we attempted an open, false if the platform isn't
 * supported. Callers should fall back to "just print the path" on false.
 */
function openInBrowser(filePath: string): boolean {
  let cmd: string | null = null;
  if (process.platform === 'darwin') cmd = 'open';
  else if (process.platform === 'linux') cmd = 'xdg-open';
  // Windows / unsupported platforms intentionally fall through — there's
  // no single reliable opener (`start` is a cmd.exe builtin, not an exe).
  if (cmd === null) return false;

  try {
    const child = spawn(cmd, [filePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch (err) {
    swallowError('trace.openInBrowser', err, filePath);
    return false;
  }
}

// ============================================================================
// Date / duration parsing
// ============================================================================

/**
 * Parse a relative-time phrase into a `Date` representing "now − duration".
 * Accepts:
 *   - ISO 8601 date strings (passed straight to `Date`)
 *   - shorthand: `2h`, `30d`, `1w`, `15m`, `5s` (with optional whitespace)
 *   - English phrases: `"30 days ago"`, `"1 hour ago"`, `"yesterday"`
 *
 * Returns null when the input can't be parsed — caller decides whether to
 * fall back to a default or surface an error.
 */
function parseRelativeTime(raw: string | undefined, now: Date = new Date()): Date | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const input = raw.trim().toLowerCase();

  if (input === 'yesterday') {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  // ISO date — `Date` parses these natively. Fast-path: try this first
  // when the string starts with a digit + dash (typical ISO lead-in).
  if (/^\d{4}-\d{2}-\d{2}/.test(input)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Shorthand or "<n> <unit> [ago]"
  const match = input.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n >= 0) {
      const unit = match[2];
      const unitMs = unitToMs(unit);
      if (unitMs !== null) return new Date(now.getTime() - unitMs * n);
    }
  }

  // Last-ditch — let `Date` try (handles things like "2026-05-08 14:00").
  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) return fallback;

  return null;
}

/** Map unit token → milliseconds. Returns null for unknown units. */
function unitToMs(unit: string): number | null {
  switch (unit) {
    case 's': case 'sec': case 'secs': case 'second': case 'seconds':
      return 1000;
    case 'm': case 'min': case 'mins': case 'minute': case 'minutes':
      return 60 * 1000;
    case 'h': case 'hr': case 'hrs': case 'hour': case 'hours':
      return 60 * 60 * 1000;
    case 'd': case 'day': case 'days':
      return 24 * 60 * 60 * 1000;
    case 'w': case 'week': case 'weeks':
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

// ============================================================================
// Display helpers
// ============================================================================

/**
 * Format a timestamp as a short human-readable relative string ("2h ago",
 * "3d ago", "just now"). Falls back to the raw string if unparseable.
 * Used in the table column — keeps rows scannable.
 */
function formatRelative(timestamp: string, now: Date = new Date()): string {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return timestamp;
  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return 'in future';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return seconds <= 5 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** ASCII success indicator — terminals render this everywhere. */
function formatSuccess(success: boolean | undefined): string {
  if (success === true) return '✓';
  if (success === false) return '✗';
  return '—';
}

/** Truncate without breaking visible width too much. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

// ============================================================================
// Subcommands
// ============================================================================

const listCommand: Command = {
  name: 'list',
  description: 'List recent agent trajectories (newest first)',
  options: [
    {
      name: 'since',
      description: 'Show only trajectories newer than this (e.g. "1 hour ago", "30d", ISO date)',
      type: 'string',
    },
    {
      name: 'agent',
      description: 'Filter by agent name (substring match, case-insensitive)',
      type: 'string',
    },
    {
      name: 'limit',
      short: 'n',
      description: `Maximum trajectories to return (default ${DEFAULT_LIST_LIMIT})`,
      type: 'number',
      default: DEFAULT_LIST_LIMIT,
    },
    {
      name: 'json',
      description: 'Emit JSON instead of the human-readable table',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops trace list', description: 'Latest 50 trajectories, table format' },
    { command: 'swarmops trace list --since "1 hour ago"', description: 'Only the last hour' },
    { command: 'swarmops trace list --agent coder-bridge', description: 'Filter by agent name' },
    { command: 'swarmops trace list --json', description: 'JSON output for scripting' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;
    const sinceRaw = ctx.flags.since as string | undefined;
    const agent = typeof ctx.flags.agent === 'string' ? ctx.flags.agent : undefined;
    const limitRaw = Number(ctx.flags.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_LIST_LIMIT;

    let since: Date | undefined;
    if (typeof sinceRaw === 'string' && sinceRaw.length > 0) {
      const parsed = parseRelativeTime(sinceRaw);
      if (parsed === null) {
        if (wantJson) {
          output.writeln(JSON.stringify({ error: `unrecognised --since value: ${sinceRaw}` }));
        } else {
          output.printError(`Could not parse --since value: ${sinceRaw}`);
          output.writeln(output.dim('  Try: "1 hour ago", "30d", "yesterday", or an ISO date.'));
        }
        return { success: false, exitCode: 1 };
      }
      since = parsed;
    }

    const items = await listTrajectories({ since, agent, limit });

    if (wantJson) {
      output.writeln(JSON.stringify({ count: items.length, trajectories: items }, null, 2));
      return { success: true, exitCode: 0 };
    }

    if (items.length === 0) {
      output.writeln();
      output.writeln(output.warning('No trajectories found.'));
      output.writeln(output.dim('Trajectories are written automatically by hooks-tools as agents run.'));
      output.writeln(output.dim('Run an agent dispatch first, then re-run this command.'));
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    const now = new Date();
    output.writeln();
    output.writeln(output.bold(`Agent trajectories (${items.length})`));
    output.writeln();
    output.printTable({
      columns: [
        { key: 'id', header: 'ID', width: 14 },
        { key: 'agent', header: 'Agent', width: 18 },
        { key: 'task', header: 'Task', width: 52 },
        { key: 'steps', header: 'Steps', width: 6, align: 'right' },
        { key: 'started', header: 'Started', width: 12 },
        { key: 'success', header: 'Ok', width: 4, align: 'center' },
      ],
      data: items.map((t) => ({
        id: truncate(t.id, 12),
        agent: truncate(t.agent, 16),
        task: truncate(t.task, 50),
        steps: String(t.steps.length),
        started: formatRelative(t.startedAt, now),
        success: formatSuccess(t.success),
      })),
    });
    output.writeln();
    output.writeln(output.dim('Use `swarmops trace replay <id>` to render a session as HTML.'));
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

const replayCommand: Command = {
  name: 'replay',
  description: 'Render a trajectory as a self-contained HTML file (or JSON)',
  options: [
    {
      name: 'open',
      description: "Open the rendered HTML in the system's default browser",
      type: 'boolean',
      default: false,
    },
    {
      name: 'json',
      description: 'Emit raw trajectory JSON to stdout instead of writing HTML',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops trace replay latest', description: 'Render the newest trajectory' },
    { command: 'swarmops trace replay <id> --open', description: 'Render and open in browser' },
    { command: 'swarmops trace replay <id> --json', description: 'Emit raw JSON for piping' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = ctx.args[0];
    if (!sessionId || sessionId.length === 0) {
      output.printError('Session id required.');
      output.writeln(output.dim('  Usage: swarmops trace replay <session-id|latest>'));
      return { success: false, exitCode: 1 };
    }

    const wantJson = ctx.flags.json === true;
    const wantOpen = ctx.flags.open === true;

    const trajectory = await loadTrajectory(sessionId);
    if (trajectory === null) {
      // The loader returns null for both not-found and ambiguous-prefix.
      // We can disambiguate here by checking for similar matches.
      const allMatches = await findAmbiguousMatches(sessionId);
      if (allMatches.length > 1) {
        output.printError(
          `Ambiguous session prefix '${sessionId}' — matches ${allMatches.length} trajectories.`,
        );
        output.writeln(output.dim('  Disambiguate by adding more characters. First few matches:'));
        for (const id of allMatches.slice(0, 5)) {
          output.writeln(output.dim(`    ${id}`));
        }
      } else if (sessionId.length < 8 && sessionId !== 'latest') {
        output.printError(`Session id too short — provide ≥ 8 characters or use 'latest'.`);
      } else {
        output.printError(`No trajectory found for '${sessionId}'.`);
        output.writeln(output.dim("  Run `swarmops trace list` to see available sessions."));
      }
      return { success: false, exitCode: 1 };
    }

    if (wantJson) {
      output.writeln(JSON.stringify(trajectory, null, 2));
      return { success: true, exitCode: 0 };
    }

    // Render to HTML and write to <claudeRoot>/.claude-flow/traces/<id>.html.
    const html = renderTrace(trajectory);
    const tracesDir = getTracesDir();
    const filePath = getTraceHtmlPath(trajectory.id);

    try {
      await mkdir(tracesDir, { recursive: true });
      await writeFile(filePath, html, 'utf-8');
    } catch (err) {
      swallowError('trace.replay.write', err, filePath);
      output.printError(`Failed to write trace HTML to ${filePath}`);
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.success(`Trace rendered: ${filePath}`));
    output.writeln(
      output.dim(
        `  Session ${trajectory.id} · ${trajectory.steps.length} steps · agent ${trajectory.agent}`,
      ),
    );

    if (wantOpen) {
      const opened = openInBrowser(filePath);
      if (opened) {
        output.writeln(output.dim('  Opening in default browser…'));
      } else {
        output.writeln(
          output.warning(`  --open is unsupported on this platform (${process.platform}). Path printed above.`),
        );
      }
    }
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

/**
 * Helper for the replay error path — surface human-readable disambiguation
 * data when `loadTrajectory` returns null due to an ambiguous prefix. We
 * pull the full list and re-run the prefix match here rather than expose
 * this through the loader contract.
 */
async function findAmbiguousMatches(sessionId: string): Promise<string[]> {
  if (sessionId === 'latest') return [];
  // Use a high limit so we don't miss matches buried beyond the default 50.
  const all = await listTrajectories({ limit: 1000 });
  return all
    .filter((t) => t.id === sessionId || t.id.startsWith(sessionId))
    .map((t) => t.id);
}

const pruneCommand: Command = {
  name: 'prune',
  description: 'Delete rendered trace HTML files older than a threshold (default 30 days)',
  options: [
    {
      name: 'older-than',
      description: 'Delete files older than this (e.g. "7d", "30 days ago"). Default 30 days.',
      type: 'string',
    },
    {
      name: 'dry-run',
      description: "Show what would be deleted, but don't delete",
      type: 'boolean',
      default: false,
    },
    {
      name: 'json',
      description: 'Emit machine-readable JSON instead of human output',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops trace prune', description: 'Delete renders older than 30 days' },
    { command: 'swarmops trace prune --older-than 7d', description: 'Delete renders older than 7 days' },
    { command: 'swarmops trace prune --dry-run', description: 'List what would be deleted' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;
    const dryRun = ctx.flags['dry-run'] === true;
    const olderThanRaw = ctx.flags['older-than'] as string | undefined;

    const now = new Date();
    let cutoff: Date;
    if (typeof olderThanRaw === 'string' && olderThanRaw.length > 0) {
      const parsed = parseRelativeTime(olderThanRaw, now);
      if (parsed === null) {
        if (wantJson) {
          output.writeln(JSON.stringify({ error: `unrecognised --older-than value: ${olderThanRaw}` }));
        } else {
          output.printError(`Could not parse --older-than value: ${olderThanRaw}`);
          output.writeln(output.dim('  Try: "30 days ago", "7d", or an ISO date.'));
        }
        return { success: false, exitCode: 1 };
      }
      cutoff = parsed;
    } else {
      cutoff = new Date(now.getTime() - DEFAULT_PRUNE_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000);
    }

    const tracesDir = getTracesDir();
    if (!existsSync(tracesDir)) {
      if (wantJson) {
        output.writeln(JSON.stringify({ deleted: [], skipped: 0, message: 'no traces directory' }));
        return { success: true, exitCode: 0 };
      }
      output.writeln();
      output.writeln(output.dim(`No traces directory at ${tracesDir} — nothing to prune.`));
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    let entries: string[];
    try {
      entries = readdirSync(tracesDir);
    } catch (err) {
      swallowError('trace.prune.readdir', err, tracesDir);
      if (wantJson) {
        output.writeln(JSON.stringify({ error: 'could not read traces directory' }));
      } else {
        output.printError(`Could not read traces directory: ${tracesDir}`);
      }
      return { success: false, exitCode: 1 };
    }

    const candidates: Array<{ path: string; mtime: Date }> = [];
    for (const name of entries) {
      // Only touch our own .html renders. Anything else (subdirs, stray
      // files) is left alone — keeps prune safe to re-run.
      if (!name.endsWith('.html')) continue;
      const full = path.join(tracesDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (st.mtime <= cutoff) {
          candidates.push({ path: full, mtime: st.mtime });
        }
      } catch (err) {
        swallowError('trace.prune.stat', err, full);
      }
    }

    const deleted: string[] = [];
    if (!dryRun) {
      for (const c of candidates) {
        try {
          unlinkSync(c.path);
          deleted.push(c.path);
        } catch (err) {
          swallowError('trace.prune.unlink', err, c.path);
        }
      }
    }

    if (wantJson) {
      output.writeln(
        JSON.stringify({
          dryRun,
          olderThan: cutoff.toISOString(),
          candidateCount: candidates.length,
          deletedCount: deleted.length,
          candidates: candidates.map((c) => ({ path: c.path, mtime: c.mtime.toISOString() })),
          deleted,
        }, null, 2),
      );
      return { success: true, exitCode: 0 };
    }

    output.writeln();
    if (candidates.length === 0) {
      output.writeln(output.dim(`No HTML renders older than ${cutoff.toISOString()}.`));
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    if (dryRun) {
      output.writeln(output.bold(`Would delete ${candidates.length} file(s) older than ${cutoff.toISOString()}:`));
      for (const c of candidates) {
        output.writeln(`  ${c.path}  (mtime ${c.mtime.toISOString()})`);
      }
      output.writeln();
      output.writeln(output.dim('Re-run without --dry-run to actually delete.'));
    } else {
      output.writeln(output.success(`Deleted ${deleted.length} of ${candidates.length} file(s).`));
      if (deleted.length < candidates.length) {
        output.writeln(
          output.warning(`  ${candidates.length - deleted.length} file(s) failed to delete (see DEBUG logs).`),
        );
      }
    }
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

// ============================================================================
// Top-level command
// ============================================================================

export const traceCommand: Command = {
  name: 'trace',
  description: 'Replayable agent traces — list, replay, and prune trajectory renders',
  subcommands: [listCommand, replayCommand, pruneCommand],
  examples: [
    { command: 'swarmops trace list', description: 'Show recent trajectories' },
    { command: 'swarmops trace replay latest --open', description: 'Render and open the newest trace' },
    { command: 'swarmops trace prune --dry-run', description: 'Preview the prune-old-renders cleanup' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('SwarmOps Trace'));
    output.writeln(output.dim('Replayable agent trajectories — list, render, prune.'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'list    - Show recent trajectories (newest first)',
      'replay  - Render a trajectory to a self-contained HTML file',
      'prune   - Delete old HTML renders',
    ]);
    output.writeln();
    output.writeln('Use `swarmops trace <subcommand> --help` for details.');
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

export default traceCommand;

// Test-only re-exports so __tests__/commands-trace.test.ts can exercise the
// pure helpers without spinning up the full CLI surface. Not part of the
// public CLI contract — keep these import paths internal.
export const __test = {
  parseRelativeTime,
  formatRelative,
  formatSuccess,
  truncate,
  unitToMs,
  getTraceHtmlPath,
  getTracesDir,
  listCommand,
  replayCommand,
  pruneCommand,
};

// Used by tests only — exposes the subcommand actions directly so we can
// invoke them without going through the CLI parser. Cleaner than bolting
// onto __test above.
export const __testSubcommands = {
  list: listCommand,
  replay: replayCommand,
  prune: pruneCommand,
};
