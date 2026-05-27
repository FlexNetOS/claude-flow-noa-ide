/**
 * cost-recorder — per-Anthropic-call cost telemetry persistence (Gap 4 v1).
 *
 * Why this module exists
 * ----------------------
 * Per-dispatch token usage already comes back from Anthropic's `usage`
 * field; cache-stats.json (commit cd44c55f8) records the cache portion.
 * Gap 4 layers USD attribution on top: same architecture, separate file
 * (`cost-stats.json`), one extra dimension (per-step granularity when
 * the caller threads stepIndex through).
 *
 * Three sibling coders consume this module:
 *   - `commands/cost.ts` reads via {@link listCosts} / {@link summarizeCosts}
 *   - `services/trace-renderer.ts` + `trace-loader.ts` re-walk cost-stats
 *     to enrich session/step views
 *   - `mcp-tools/agent-execute-core.ts` writes via {@link recordCost}
 *
 * Contract (locked — see research-roadmap/GAP-4-DESIGN.md):
 *   - recordCost(input)        — append-and-trim, swallow-on-failure
 *   - listCosts(opts?)         — newest-first, optional filters
 *   - summarizeCosts(opts?)    — aggregate window into CostSummary
 *   - resetCostStats()         — delete the file (used by `cost reset --force`)
 *
 * Failure mode
 * ------------
 * recordCost() never throws. Persistence failures (corrupt file,
 * permission denied, full disk) are absorbed via {@link swallowError}
 * and surface only when `RUFLO_LOG_LEVEL=debug`. A broken cost log
 * MUST NEVER break a dispatch — same contract as cache-stats.
 *
 * Atomicity
 * ---------
 * Writes go to `cost-stats.json.tmp` then `rename()` to `cost-stats.json`.
 * `rename()` is atomic on POSIX, so concurrent recordCost calls can't
 * leave a half-written file behind. The serialised in-flight queue
 * below also collapses contention so two callers never race the same
 * file: each call awaits the previous flush.
 *
 * @module v3/cli/services/cost-recorder
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { resolveInstallContext, swallowError } from '@claude-flow/shared';

import type { CacheTtl, CostBreakdown, TokenUsage } from './pricing.js';
import { computeCostUsd } from './pricing.js';

// ============================================================================
// Public types — locked contract surface (do not break without updating
// GAP-4-DESIGN.md and notifying coder-cost-cli + coder-trace-cost).
// ============================================================================

/**
 * One cost record. Persisted in `cost-stats.json` (newest-first).
 */
export interface CostEntry {
  /** ISO 8601 — when the underlying Anthropic call returned. */
  timestamp: string;
  /** Trajectory id if known; null when caller didn't pass one (per-dispatch). */
  sessionId: string | null;
  /** Step index inside the trajectory; null = no step attribution available. */
  stepIndex: number | null;
  /** Agent name (e.g. "coder-bridge"). 'unknown' is the wire-in fallback. */
  agent: string;
  /** Resolved Anthropic model id (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** Cache TTL in effect — affects which write-rate column priced this call. */
  cacheTtl: CacheTtl;
  /** Raw token counts straight from the Anthropic response. */
  usage: TokenUsage;
  /** USD breakdown; null when the model isn't in the pricing table. */
  costUsd: CostBreakdown | null;
}

/**
 * Input shape for {@link recordCost}. Optional fields default sensibly so
 * callers can opt into per-step granularity progressively.
 */
export interface RecordCostInput {
  sessionId?: string | null;
  /** Step index within trajectory (omit/null → per-dispatch only). */
  stepIndex?: number | null;
  agent?: string;
  model: string;
  /** TTL the cache was configured with on this call — defaults to '1h'. */
  cacheTtl?: CacheTtl;
  usage: TokenUsage;
}

/**
 * Filter / pagination options for {@link listCosts}.
 */
export interface ListCostsOptions {
  /** Exact-match session id. */
  sessionId?: string;
  /** Exact-match agent name. */
  agent?: string;
  /** Filter by `timestamp >= since`. */
  since?: Date;
  /** Maximum entries returned after sort. Default {@link DEFAULT_LIMIT}. */
  limit?: number;
}

/**
 * Aggregate shape for `swarmops cost stats`.
 */
export interface CostSummary {
  totalEntries: number;
  totalUsd: number;
  byModel: Record<string, { entries: number; totalUsd: number }>;
  byAgent: Record<string, { entries: number; totalUsd: number }>;
  /**
   * Cache hit ratio over the window:
   *   sum(cacheRead) / sum(cacheRead + input + cacheCreation).
   * 0 when the denominator is 0.
   */
  cacheHitRatio: number;
  /** Earliest timestamp in the window (oldest entry); null when empty. */
  windowStartedAt: string | null;
  /** Latest timestamp in the window (newest entry); null when empty. */
  windowEndedAt: string | null;
}

/** Options for {@link summarizeCosts}. */
export interface SummarizeCostsOptions {
  sessionId?: string;
  limit?: number;
}

// ============================================================================
// Internal types — on-disk shape.
// ============================================================================

interface CostStatsFile {
  version: string;
  rollingWindow: number;
  /** Newest-first; capped at {@link DEFAULT_ROLLING_WINDOW}. */
  entries: CostEntry[];
}

// ============================================================================
// Constants
// ============================================================================

const FILE_VERSION = '1';
const DEFAULT_ROLLING_WINDOW = 100;
const DEFAULT_LIMIT = 100;
const STORAGE_DIR = '.claude-flow';
const STATS_FILE = 'cost-stats.json';

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Resolve `cost-stats.json` path via the canonical install context, so we
 * honour both global (`~/.claude/.claude-flow/`) and per-project
 * (`<cwd>/.claude/.claude-flow/`) layouts. Tests override via
 * `RUFLO_INSTALL_CONTEXT_JSON`.
 */
function getStatsPath(): string {
  const ctx = resolveInstallContext();
  return path.join(ctx.claudeRoot, STORAGE_DIR, STATS_FILE);
}

function getStatsDir(): string {
  const ctx = resolveInstallContext();
  return path.join(ctx.claudeRoot, STORAGE_DIR);
}

// ============================================================================
// I/O — defensive read / atomic write
// ============================================================================

/**
 * Read the stats file. Returns an empty (but versioned) shell on any
 * failure — file missing, JSON parse error, schema drift. The single
 * failure is recorded via {@link swallowError} for debug builds.
 */
async function readStats(): Promise<CostStatsFile> {
  const p = getStatsPath();
  if (!existsSync(p)) {
    return emptyFile();
  }
  let raw: string;
  try {
    raw = await readFile(p, 'utf-8');
  } catch (err) {
    swallowError('cost-recorder.readFile', err, p);
    return emptyFile();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      const file = parsed as CostStatsFile;
      // Defensive: filter out anything that doesn't smell like a CostEntry,
      // so partial corruption (e.g. one bad entry from an older schema)
      // doesn't take down the whole file.
      const entries = file.entries.filter(isValidEntry);
      return {
        version: typeof file.version === 'string' ? file.version : FILE_VERSION,
        rollingWindow:
          typeof file.rollingWindow === 'number' && file.rollingWindow > 0
            ? file.rollingWindow
            : DEFAULT_ROLLING_WINDOW,
        entries,
      };
    }
    swallowError(
      'cost-recorder.shape',
      new Error('cost-stats.json missing .entries[]'),
      p,
    );
    return emptyFile();
  } catch (err) {
    swallowError('cost-recorder.parse', err, p);
    return emptyFile();
  }
}

function emptyFile(): CostStatsFile {
  return {
    version: FILE_VERSION,
    rollingWindow: DEFAULT_ROLLING_WINDOW,
    entries: [],
  };
}

/** Schema check used when loading entries from disk. */
function isValidEntry(e: unknown): e is CostEntry {
  if (!e || typeof e !== 'object') return false;
  const c = e as Partial<CostEntry>;
  return (
    typeof c.timestamp === 'string' &&
    typeof c.agent === 'string' &&
    typeof c.model === 'string' &&
    !!c.usage &&
    typeof c.usage === 'object'
  );
}

/**
 * Atomic write: serialise to temp file, fsync (implicit via writeFile),
 * then `rename()` over the target. POSIX guarantees rename is atomic on
 * the same filesystem, so concurrent readers always see either the old
 * file or the new — never a half-written one.
 */
async function writeStatsAtomically(file: CostStatsFile): Promise<void> {
  const dir = getStatsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalPath = getStatsPath();
  // Suffix with pid + timestamp so two processes can't collide on the
  // tmp filename; rename is the atomic step regardless.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmpPath, finalPath);
}

// ============================================================================
// Concurrency guard — collapse contention so two awaits don't both read
// the file before the other has written. Without this, two near-simultaneous
// recordCost calls each read N entries, each prepend their own, each write
// back N+1, and we lose one of the two new entries. Trivial mutex chain.
// ============================================================================

let writeChain: Promise<void> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Keep the chain alive even on failure — never let a thrown error from
  // one call poison the next caller. The chain itself swallows.
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Append a cost entry to `cost-stats.json`. Computes the USD breakdown via
 * {@link computeCostUsd}; unknown models record `costUsd = null` (still
 * useful for audit trails). Persistence failures are swallowed.
 *
 * Always returns successfully — never throws. Caller need not await; the
 * returned promise resolves once the file has been atomically replaced.
 */
export async function recordCost(input: RecordCostInput): Promise<void> {
  await serialised(async () => {
    try {
      const ttl: CacheTtl = input.cacheTtl ?? '1h';
      const entry: CostEntry = {
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId ?? null,
        stepIndex: input.stepIndex ?? null,
        agent: input.agent ?? 'unknown',
        model: input.model,
        cacheTtl: ttl,
        usage: input.usage,
        costUsd: safeComputeCost(input.usage, input.model, ttl),
      };

      const file = await readStats();
      // Newest-first: prepend, then trim from the tail.
      file.entries.unshift(entry);
      const cap = file.rollingWindow > 0 ? file.rollingWindow : DEFAULT_ROLLING_WINDOW;
      if (file.entries.length > cap) {
        file.entries.length = cap;
      }
      // Make sure we always write a sane envelope, even if the read
      // returned an older/missing one.
      file.version = FILE_VERSION;
      file.rollingWindow = cap;

      await writeStatsAtomically(file);
    } catch (err) {
      // Final safety net — any unexpected throw (e.g. rename collision
      // on Windows, full disk) gets absorbed. Cost telemetry is non-critical.
      swallowError('cost-recorder.recordCost', err);
    }
  });
}

/**
 * computeCostUsd may throw if the pricing module is mid-init or the
 * model id contains something unexpected; defend against that here so
 * recordCost stays infallible.
 */
function safeComputeCost(
  usage: TokenUsage,
  model: string,
  ttl: CacheTtl,
): CostBreakdown | null {
  try {
    return computeCostUsd(usage, model, ttl);
  } catch (err) {
    swallowError('cost-recorder.computeCostUsd', err, model);
    return null;
  }
}

/**
 * Read the cost log. Returns an empty array when the file is missing
 * or unreadable. Sorted newest-first by `timestamp`. Filters apply
 * BEFORE the limit cap.
 */
export async function listCosts(opts: ListCostsOptions = {}): Promise<CostEntry[]> {
  const file = await readStats();
  let entries = file.entries.slice();

  if (opts.sessionId) {
    entries = entries.filter((e) => e.sessionId === opts.sessionId);
  }
  if (opts.agent) {
    entries = entries.filter((e) => e.agent === opts.agent);
  }
  if (opts.since) {
    const sinceMs = opts.since.getTime();
    entries = entries.filter((e) => {
      const t = Date.parse(e.timestamp);
      // Skip unparseable timestamps rather than incorrectly including them.
      return Number.isFinite(t) && t >= sinceMs;
    });
  }

  // Sort newest-first. The on-disk order is already newest-first by
  // construction, but a defensive sort lets callers pre-mutate without
  // surprises and tolerates any out-of-order entries from legacy writes.
  entries.sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );

  const limit =
    typeof opts.limit === 'number' && opts.limit >= 0 ? opts.limit : DEFAULT_LIMIT;
  if (entries.length > limit) {
    entries.length = limit;
  }
  return entries;
}

/**
 * Aggregate cost entries into a {@link CostSummary} for the `swarmops cost
 * stats` command. Uses {@link listCosts} so the same filter semantics apply.
 */
export async function summarizeCosts(
  opts: SummarizeCostsOptions = {},
): Promise<CostSummary> {
  const entries = await listCosts({
    sessionId: opts.sessionId,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });

  const summary: CostSummary = {
    totalEntries: entries.length,
    totalUsd: 0,
    byModel: {},
    byAgent: {},
    cacheHitRatio: 0,
    windowStartedAt: null,
    windowEndedAt: null,
  };

  if (entries.length === 0) return summary;

  let cacheReadSum = 0;
  let cacheReadDenom = 0;
  let oldestTs: string | null = null;
  let newestTs: string | null = null;

  for (const e of entries) {
    const usd = e.costUsd?.total ?? 0;
    summary.totalUsd += usd;

    const m = (summary.byModel[e.model] ??= { entries: 0, totalUsd: 0 });
    m.entries += 1;
    m.totalUsd += usd;

    const a = (summary.byAgent[e.agent] ??= { entries: 0, totalUsd: 0 });
    a.entries += 1;
    a.totalUsd += usd;

    cacheReadSum += e.usage.cacheRead;
    cacheReadDenom += e.usage.cacheRead + e.usage.input + e.usage.cacheCreation;

    // Track window bounds. Entries are newest-first, so the first iter
    // gives us newest, the last iter gives us oldest — but we tolerate
    // any order because the defensive sort upstream may have rearranged.
    if (!newestTs || Date.parse(e.timestamp) > Date.parse(newestTs)) {
      newestTs = e.timestamp;
    }
    if (!oldestTs || Date.parse(e.timestamp) < Date.parse(oldestTs)) {
      oldestTs = e.timestamp;
    }
  }

  summary.cacheHitRatio = cacheReadDenom > 0 ? cacheReadSum / cacheReadDenom : 0;
  summary.windowStartedAt = oldestTs;
  summary.windowEndedAt = newestTs;
  return summary;
}

/**
 * Delete `cost-stats.json`. Used by `swarmops cost reset --force`. Idempotent
 * — missing file is treated as success. Other failures are swallowed so the
 * CLI command never crashes the user's terminal.
 */
export async function resetCostStats(): Promise<void> {
  await serialised(async () => {
    const p = getStatsPath();
    if (!existsSync(p)) return;
    try {
      await unlink(p);
    } catch (err) {
      swallowError('cost-recorder.reset', err, p);
    }
  });
}
