/**
 * `swarmops cost` — per-agent / per-dispatch cost telemetry (Gap 4, Tier 2).
 *
 * Subcommands:
 *   - stats    — rolling-100 summary of recent dispatches (USD aggregate, by
 *                model, by agent, cache hit ratio). Default human table; --json
 *                emits the raw `summarizeCosts` payload for scripting.
 *   - session  — full per-step breakdown for a single session. `latest`
 *                resolves to the newest entry's session id.
 *   - models   — pretty-print the merged pricing table (PRICING +
 *                loadPricingOverride()).
 *   - reset    — clear cost-stats.json (interactive confirmation by default,
 *                --force skips). Mirrors `route reset` convention.
 *
 * The data layer (cost-recorder + pricing) is locked to the contracts
 * documented in services/cost-recorder.ts and services/pricing.ts. We never
 * reach into cost-stats.json directly — always through the recorder API.
 *
 * Design notes
 * ------------
 * - Two USD formats: 4 decimals for sub-dollar values (where the precision
 *   matters — a single cache-read can be < $0.0001), 2 decimals for ≥ $1
 *   (where we just want to read the number at a glance).
 * - Token counts are rendered with K-suffix collapse (`1.2k`, `12.4k`,
 *   `1.20M`) so the per-step table column doesn't blow up to 8+ chars on
 *   long-context calls.
 * - `cost reset` follows the route.ts convention: warn + require --force in
 *   interactive mode rather than spawning a real readline prompt. Keeps the
 *   command synchronous and CI-safe (no hung TTY waits).
 * - All four subcommands honour `--json` so the entire surface is pipe-able
 *   into `jq` for monitoring scripts.
 *
 * @module v3/cli/commands/cost
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import {
  listCosts,
  resetCostStats,
  summarizeCosts,
  type CostEntry,
  type CostSummary,
} from '../services/cost-recorder.js';
import {
  PRICING,
  loadPricingOverride,
  type ModelPricing,
} from '../services/pricing.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_STATS_LIMIT = 100;

// ============================================================================
// Format helpers — pure, easy to unit-test, reused across all four subcommands.
// ============================================================================

/**
 * USD formatter with two precision tiers:
 *   - < $1     → 4 decimals (`$0.0184`)  preserves sub-cent precision
 *   - ≥ $1     → 2 decimals (`$1.42`)    matches normal money formatting
 *
 * Always prefixed with `$`. Negative inputs are clamped to 0 — cost summaries
 * should never dip below zero, and a stray negative would mostly indicate a
 * data corruption we'd rather mask than panic on.
 */
function formatUsd(usd: number): string {
  const safe = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  if (safe >= 1) return `$${safe.toFixed(2)}`;
  return `$${safe.toFixed(4)}`;
}

/**
 * Token-count formatter — collapses to k/M suffixes once the absolute value
 * crosses 1000 / 1_000_000. Mirrors the convention used in the trace
 * renderer's per-step badge so the eye reads the columns the same way.
 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Percentage formatter — fixed 0 decimals (`84%`). */
function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

/**
 * Compute the per-entry cache hit ratio (read / (read + creation + raw input))
 * for the per-session table. We mirror the cache-stats.ts convention to keep
 * a consistent meaning across both surfaces.
 */
function entryCacheHitRatio(entry: CostEntry): number {
  const usage = entry.usage;
  const denom = usage.input + usage.cacheRead + usage.cacheCreation;
  if (denom <= 0) return 0;
  return usage.cacheRead / denom;
}

/**
 * Slice a long ISO timestamp down to `YYYY-MM-DDTHH:MM` for the summary
 * header. We don't want seconds in the rolling-window blurb — too noisy.
 */
function shortTs(iso: string | null): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  return iso.slice(0, 16);
}

/**
 * Truncate a long agent / model id so table columns stay legible. Adds an
 * ellipsis. For cost data we keep these wider than the trace command — model
 * ids like `claude-sonnet-4-6` are themselves 17 chars, so 24 is the floor.
 */
function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

/**
 * Total token count for a single entry — input + output + cacheRead +
 * cacheCreation. Used by the per-session table's `Tokens` column.
 */
function totalTokens(entry: CostEntry): number {
  const u = entry.usage;
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}

// ============================================================================
// `cost stats` — rolling-window summary.
// ============================================================================

const statsCommand: Command = {
  name: 'stats',
  description: 'Rolling-100 cost summary across recent agent dispatches',
  options: [
    {
      name: 'json',
      description: 'Emit raw JSON rather than the human-readable summary',
      type: 'boolean',
      default: false,
    },
    {
      name: 'last',
      short: 'n',
      description: `Limit to the last N entries (default ${DEFAULT_STATS_LIMIT})`,
      type: 'number',
      default: DEFAULT_STATS_LIMIT,
    },
    {
      name: 'agent',
      description: 'Filter the summary to a single agent name (exact match)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'swarmops cost stats', description: 'Rolling-100 summary, table format' },
    { command: 'swarmops cost stats --json', description: 'JSON output for scripting' },
    { command: 'swarmops cost stats -n 50', description: 'Last 50 dispatches only' },
    { command: 'swarmops cost stats --agent coder-bridge', description: 'Filter by agent name' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;
    const agent = typeof ctx.flags.agent === 'string' && ctx.flags.agent.length > 0
      ? ctx.flags.agent
      : undefined;
    const limitRaw = Number(ctx.flags.last);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_STATS_LIMIT;

    // For --agent we can't ask summarizeCosts() to filter (its contract takes
    // sessionId only), so we re-summarize from listCosts() when an agent
    // filter is in play. Same shape comes back either way — just two
    // different code paths to source the data.
    let summary: CostSummary;
    if (agent !== undefined) {
      const entries = await listCosts({ agent, limit });
      summary = summarizeFromEntries(entries);
    } else {
      summary = await summarizeCosts({ limit });
    }

    if (wantJson) {
      output.writeln(JSON.stringify(summary, null, 2));
      return { success: true, exitCode: 0 };
    }

    if (summary.totalEntries === 0) {
      output.writeln();
      output.writeln(output.warning('No cost data yet.'));
      output.writeln(
        output.dim(
          'Cost stats accumulate as agents dispatch — run a few `swarmops agent execute` calls and re-check.',
        ),
      );
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    const window =
      summary.windowStartedAt && summary.windowEndedAt
        ? ` (last ${summary.totalEntries} entries, ${shortTs(summary.windowStartedAt)} → ${shortTs(summary.windowEndedAt)})`
        : ` (last ${summary.totalEntries} entries)`;

    output.writeln();
    output.writeln(output.bold(`Cost summary${window}`));
    if (agent !== undefined) {
      output.writeln(output.dim(`  filtered: agent=${agent}`));
    }
    output.writeln();
    output.writeln(
      `  Total: ${output.bold(formatUsd(summary.totalUsd))}` +
        `  ·  Cache hit ratio: ${formatPct(summary.cacheHitRatio)}` +
        `  ·  ${summary.totalEntries} dispatch(es)`,
    );
    output.writeln();

    // By-model breakdown — sort by spend, descending. Empty-object guard for
    // the (unlikely) case that summarize returns 0 model groups.
    const modelRows = Object.entries(summary.byModel)
      .sort((a, b) => b[1].totalUsd - a[1].totalUsd);
    if (modelRows.length > 0) {
      output.writeln(output.bold('By model:'));
      const modelWidth = Math.min(
        24,
        Math.max(...modelRows.map(([m]) => m.length), 'model'.length),
      );
      for (const [model, stats] of modelRows) {
        output.writeln(
          `  ${truncate(model, modelWidth).padEnd(modelWidth)}  ` +
            `${String(stats.entries).padStart(4)} dispatches    ` +
            `${formatUsd(stats.totalUsd).padStart(10)}`,
        );
      }
      output.writeln();
    }

    // By-agent breakdown — same shape as by-model. Empty-object guard same.
    const agentRows = Object.entries(summary.byAgent)
      .sort((a, b) => b[1].totalUsd - a[1].totalUsd);
    if (agentRows.length > 0) {
      output.writeln(output.bold('By agent:'));
      const agentWidth = Math.min(
        24,
        Math.max(...agentRows.map(([a]) => a.length), 'agent'.length),
      );
      for (const [agentName, stats] of agentRows) {
        output.writeln(
          `  ${truncate(agentName, agentWidth).padEnd(agentWidth)}  ` +
            `${String(stats.entries).padStart(4)} dispatches    ` +
            `${formatUsd(stats.totalUsd).padStart(10)}`,
        );
      }
      output.writeln();
    }

    return { success: true, exitCode: 0 };
  },
};

/**
 * Re-aggregate a slice of `CostEntry` into the same shape `summarizeCosts`
 * returns. Used when an `--agent` filter is in play and we can't piggyback
 * on the recorder's built-in summarizer.
 */
function summarizeFromEntries(entries: CostEntry[]): CostSummary {
  const byModel: CostSummary['byModel'] = {};
  const byAgent: CostSummary['byAgent'] = {};
  let totalUsd = 0;
  let cacheReadTokens = 0;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let windowStartedAt: string | null = null;
  let windowEndedAt: string | null = null;

  for (const e of entries) {
    const usd = e.costUsd?.total ?? 0;
    totalUsd += usd;
    cacheReadTokens += e.usage.cacheRead;
    inputTokens += e.usage.input;
    cacheCreationTokens += e.usage.cacheCreation;

    const m = byModel[e.model] ?? { entries: 0, totalUsd: 0 };
    m.entries += 1;
    m.totalUsd += usd;
    byModel[e.model] = m;

    const a = byAgent[e.agent] ?? { entries: 0, totalUsd: 0 };
    a.entries += 1;
    a.totalUsd += usd;
    byAgent[e.agent] = a;

    if (windowStartedAt === null || e.timestamp < windowStartedAt) {
      windowStartedAt = e.timestamp;
    }
    if (windowEndedAt === null || e.timestamp > windowEndedAt) {
      windowEndedAt = e.timestamp;
    }
  }

  const denom = cacheReadTokens + inputTokens + cacheCreationTokens;
  const cacheHitRatio = denom > 0 ? cacheReadTokens / denom : 0;

  return {
    totalEntries: entries.length,
    totalUsd,
    byModel,
    byAgent,
    cacheHitRatio,
    windowStartedAt,
    windowEndedAt,
  };
}

// ============================================================================
// `cost session` — full per-step breakdown for a single session.
// ============================================================================

const sessionCommand: Command = {
  name: 'session',
  description: 'Per-step cost breakdown for a single session id',
  options: [
    {
      name: 'json',
      description: 'Emit raw JSON rather than the human-readable table',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops cost session abc123', description: 'Full breakdown for session abc123' },
    { command: 'swarmops cost session latest', description: 'Newest session by timestamp' },
    { command: 'swarmops cost session abc123 --json', description: 'JSON output for scripting' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;
    const arg = ctx.args[0];
    if (typeof arg !== 'string' || arg.length === 0) {
      output.printError('Session id required.');
      output.writeln(output.dim('  Usage: swarmops cost session <session-id|latest>'));
      return { success: false, exitCode: 1 };
    }

    // Resolve `latest` → newest entry's sessionId by walking the full
    // window once. Cheap (max 100 entries) and avoids leaking the alias
    // semantic into the recorder contract.
    let sessionId: string;
    if (arg === 'latest') {
      // Pull the entire rolling window (no sessionId filter), then take the
      // newest with a non-null sessionId. Returned-entries order is
      // implementation-defined (recorder spec doesn't guarantee newest
      // first), so we re-sort defensively.
      const all = await listCosts({});
      const ordered = [...all].sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
      );
      const newest = ordered.find((e) => typeof e.sessionId === 'string' && e.sessionId.length > 0);
      if (newest === undefined || newest.sessionId === null) {
        if (wantJson) {
          output.writeln(JSON.stringify({ sessionId: null, entries: [], message: 'no sessions yet' }));
          return { success: true, exitCode: 0 };
        }
        output.writeln();
        output.writeln(output.warning('No sessions found yet.'));
        output.writeln(output.dim('  Run an agent dispatch first, then re-try.'));
        output.writeln();
        return { success: true, exitCode: 0 };
      }
      sessionId = newest.sessionId;
    } else {
      sessionId = arg;
    }

    const entries = await listCosts({ sessionId });

    if (wantJson) {
      output.writeln(
        JSON.stringify(
          {
            sessionId,
            count: entries.length,
            totalUsd: entries.reduce((acc, e) => acc + (e.costUsd?.total ?? 0), 0),
            entries,
          },
          null,
          2,
        ),
      );
      return { success: true, exitCode: 0 };
    }

    if (entries.length === 0) {
      output.writeln();
      output.writeln(output.warning(`No cost data for session ${sessionId}.`));
      output.writeln(
        output.dim('  The session may pre-date cost telemetry, or the id may be wrong.'),
      );
      output.writeln(output.dim('  Try `swarmops cost stats` to see what sessions are available.'));
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    // Order by stepIndex when available, otherwise by timestamp. The
    // recorder writes entries in dispatch order but we don't want to rely
    // on that — null stepIndex sorts to the end so the table reads
    // top-to-bottom either way.
    const ordered = [...entries].sort((a, b) => {
      const ai = a.stepIndex;
      const bi = b.stepIndex;
      if (ai !== null && bi !== null) return ai - bi;
      if (ai !== null) return -1;
      if (bi !== null) return 1;
      return a.timestamp < b.timestamp ? -1 : 1;
    });

    const totalUsd = ordered.reduce((acc, e) => acc + (e.costUsd?.total ?? 0), 0);

    output.writeln();
    output.writeln(
      output.bold(
        `Session ${sessionId} — ${ordered.length} dispatch(es), ${formatUsd(totalUsd)} total`,
      ),
    );
    output.writeln();

    output.printTable({
      columns: [
        { key: 'step', header: 'Step', width: 6, align: 'right' },
        { key: 'agent', header: 'Agent', width: 22 },
        { key: 'model', header: 'Model', width: 24 },
        { key: 'tokens', header: 'Tokens', width: 8, align: 'right' },
        { key: 'cache', header: 'Cache', width: 6, align: 'right' },
        { key: 'cost', header: '$$', width: 10, align: 'right' },
      ],
      data: ordered.map((e) => ({
        step: e.stepIndex !== null ? String(e.stepIndex) : '—',
        agent: truncate(e.agent, 20),
        model: truncate(e.model, 22),
        tokens: formatTokens(totalTokens(e)),
        cache: formatPct(entryCacheHitRatio(e)),
        cost: e.costUsd === null ? 'n/a' : formatUsd(e.costUsd.total),
      })),
    });
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

// ============================================================================
// `cost models` — show the merged pricing table currently in use.
// ============================================================================

const modelsCommand: Command = {
  name: 'models',
  description: 'Print the merged pricing table currently in use',
  options: [
    {
      name: 'json',
      description: 'Emit raw JSON rather than the human-readable table',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops cost models', description: 'Print the active pricing table' },
    { command: 'swarmops cost models --json', description: 'JSON output for scripting' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;

    // Merge order: hard-coded PRICING is the floor, override wins for any
    // key that appears in both. Mirrors what priceFor() does at runtime.
    const merged: Record<string, ModelPricing> = { ...PRICING, ...loadPricingOverride() };

    if (wantJson) {
      output.writeln(JSON.stringify(merged, null, 2));
      return { success: true, exitCode: 0 };
    }

    const rows = Object.entries(merged).sort((a, b) => a[0].localeCompare(b[0]));
    if (rows.length === 0) {
      output.writeln();
      output.writeln(output.warning('No models in pricing table.'));
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    output.writeln();
    output.writeln(output.bold('Pricing table (USD per million tokens)'));
    output.writeln(output.dim('  Merged: hard-coded defaults + ~/.claude/.claude-flow/pricing-override.json'));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'model', header: 'Model', width: 28 },
        { key: 'input', header: 'Input', width: 8, align: 'right' },
        { key: 'output', header: 'Output', width: 8, align: 'right' },
        { key: 'cacheRead', header: 'Cache R', width: 8, align: 'right' },
        { key: 'cacheW5m', header: 'Cache W (5m)', width: 12, align: 'right' },
        { key: 'cacheW1h', header: 'Cache W (1h)', width: 12, align: 'right' },
      ],
      data: rows.map(([model, p]) => ({
        model: truncate(model, 26),
        input: `$${p.inputPerMTok.toFixed(2)}`,
        output: `$${p.outputPerMTok.toFixed(2)}`,
        cacheRead: `$${p.cacheReadPerMTok.toFixed(2)}`,
        cacheW5m: `$${p.cacheWrite5mPerMTok.toFixed(2)}`,
        cacheW1h: `$${p.cacheWrite1hPerMTok.toFixed(2)}`,
      })),
    });
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

// ============================================================================
// `cost reset` — clear cost-stats.json.
// ============================================================================

const resetCommand: Command = {
  name: 'reset',
  description: 'Clear all recorded cost stats (interactive confirmation by default)',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Skip the confirmation prompt and reset immediately',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'swarmops cost reset', description: 'Reset (interactive — requires --force)' },
    { command: 'swarmops cost reset --force', description: 'Reset without confirmation' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force === true;

    // Convention from `route reset`: in interactive mode without --force we
    // refuse and tell the user how to proceed. We don't spawn a real
    // readline prompt — keeps the command CI-safe and never blocks on a
    // hung TTY. Non-interactive (scripted) callers without --force also
    // get blocked with the same message — opt-in destructive semantics.
    if (!force) {
      output.writeln();
      output.printWarning('This will clear all recorded cost stats.');
      output.writeln(output.dim('  Use --force to skip this confirmation and reset.'));
      output.writeln();
      return { success: false, exitCode: 1 };
    }

    try {
      await resetCostStats();
      output.printSuccess('Cost stats have been reset.');
      return { success: true, exitCode: 0 };
    } catch (err) {
      output.printError(err instanceof Error ? err.message : String(err));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Top-level command
// ============================================================================

export const costCommand: Command = {
  name: 'cost',
  description: 'Per-agent cost telemetry — stats, session breakdowns, pricing, reset',
  subcommands: [statsCommand, sessionCommand, modelsCommand, resetCommand],
  examples: [
    { command: 'swarmops cost stats', description: 'Rolling-100 cost summary' },
    { command: 'swarmops cost session latest', description: 'Cost breakdown for the newest session' },
    { command: 'swarmops cost models', description: 'Show the active pricing table' },
    { command: 'swarmops cost reset --force', description: 'Wipe accumulated cost stats' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('SwarmOps Cost Telemetry'));
    output.writeln(output.dim('Per-agent / per-dispatch cost tracking — Gap 4.'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'stats    - Rolling-100 cost summary (USD aggregate, by model, by agent)',
      'session  - Per-step cost breakdown for a single session',
      'models   - Show the active pricing table',
      'reset    - Clear cost-stats.json (requires --force)',
    ]);
    output.writeln();
    output.writeln('Use `swarmops cost <subcommand> --help` for details.');
    output.writeln();
    return { success: true, exitCode: 0 };
  },
};

export default costCommand;

// ============================================================================
// Test-only re-exports — let __tests__/commands-cost.test.ts exercise the
// pure helpers without spinning up the full CLI surface. Not part of the
// public CLI contract — keep these import paths internal.
// ============================================================================

export const __test = {
  formatUsd,
  formatTokens,
  formatPct,
  truncate,
  shortTs,
  totalTokens,
  entryCacheHitRatio,
  summarizeFromEntries,
};

export const __testSubcommands = {
  stats: statsCommand,
  session: sessionCommand,
  models: modelsCommand,
  reset: resetCommand,
};
