/**
 * trace-loader — read-only query layer over the trajectory data already
 * persisted by hooks-tools.ts into `~/.claude/.claude-flow/memory/store.json`.
 *
 * Why this module exists
 * ----------------------
 * Gap 1 (replayable agent traces) needs to surface trajectory data to the
 * renderer + CLI without giving them direct knowledge of the on-disk shape
 * or the install-path resolution. Centralising the I/O here keeps the two
 * other Gap-1 coders (`coder-trace-renderer`, `coder-trace-cli`) decoupled
 * from store.json — they consume `LoadedTrajectory` only.
 *
 * Gap 4 cost-telemetry extension
 * ------------------------------
 * Once `services/cost-recorder.ts` has captured per-dispatch token costs
 * (keyed by sessionId + stepIndex), `loadTrajectory` JOINs that data into
 * the returned trajectory: each step gains an optional `cost` field, and
 * the trajectory gets `totalCostUsd` + `costByModel` aggregates. The join
 * is a soft dependency — if cost data is missing (older trajectory or
 * recorder hasn't shipped yet) the trajectory renders exactly as before.
 *
 * Contract (locked — do not change without updating Gap-1/Gap-4 design):
 *   - listTrajectories(opts?) -> sorted-newest-first, optional since/agent/limit
 *   - loadTrajectory(idOrLatest) -> exact id, ≥8-char unique prefix, or 'latest';
 *                                    enriched with cost data when available
 *
 * Design notes
 * ------------
 * - Pure reader — no writes, no mutation of the store.
 * - Uses `resolveInstallContext()` so we honour both global and per-project
 *   install layouts; never hardcodes `os.homedir()`.
 * - Each trajectory entry is parsed defensively. Malformed entries are
 *   skipped (via `swallowError`), never crashed-on, so one bad entry can't
 *   poison `swarmops trace list`.
 * - The cost-recorder import is dynamic — the module may not be present
 *   on every install (it ships in its own commit), and a missing import
 *   must NEVER block trajectory display.
 *
 * @module v3/cli/services/trace-loader
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { resolveInstallContext, swallowError } from '@claude-flow/shared';

// ============================================================================
// Public types — these are the locked contract surface.
// ============================================================================

/**
 * Per-step USD cost breakdown. Mirrors `CostBreakdown` from `pricing.ts` /
 * the `costUsd` field on `CostEntry` from `cost-recorder.ts`. Redeclared
 * here so consumers (renderer, CLI) don't have to take a hard dep on the
 * cost-recorder module — the loader is the single integration point.
 *
 * The optional `usage` field carries the raw token counts from the
 * recorder entry (only populated by `enrichWithCosts`, never by inline
 * step.cost). The side-panel breakdown needs both the USD and the token
 * counts to render `412 tokens · $0.00124` style rows.
 */
export interface LoadedStepCost {
  /** USD spent on raw input tokens. */
  input: number;
  /** USD spent on output tokens. */
  output: number;
  /** USD spent on cache reads. */
  cacheRead: number;
  /** USD spent on cache writes (5m or 1h rate, set by recorder). */
  cacheCreation: number;
  /** Sum of the four categories above. */
  total: number;
  /**
   * Optional raw token counts. Populated when this cost was JOINed from a
   * cost-recorder entry; absent when a step's cost was inlined without
   * usage data. Surfaces in the side-panel cost breakdown.
   */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
}

/**
 * Aggregate cost-by-model entry surfaced on `LoadedTrajectory.costByModel`.
 * `dispatches` counts the number of recorder entries for a given model in
 * this session — useful for spotting "this session burned 47 Opus calls"
 * patterns without re-walking the cost log.
 */
export interface LoadedTrajectoryModelCost {
  /** Number of cost-recorder entries for this model in this session. */
  dispatches: number;
  /** Sum of `costUsd.total` across those entries, USD. */
  totalUsd: number;
}

/**
 * A single step in a trajectory. Mirrors `TrajectoryStep` from hooks-tools.ts
 * but is redeclared here so consumers don't have to import internal types.
 *
 * The `cost` field is optional and populated by the cost-recorder JOIN in
 * `loadTrajectory`. When the cost-recorder writes its breakdown directly
 * onto the step at trajectory-end time, the inline value is preserved
 * (and takes priority over the joined entry — see `coerceTrajectory`).
 */
export interface LoadedTrajectoryStep {
  action: string;
  result: string;
  quality: number;
  timestamp: string;
  /** Optional cost breakdown — present when cost-recorder has data. */
  cost?: LoadedStepCost | null;
}

/**
 * A parsed trajectory ready for rendering. Mirrors `TrajectoryData` from
 * hooks-tools.ts. The `endedAt` and `success` fields are optional because
 * trajectories that are still in-flight (no `trajectory-end` fired yet)
 * legitimately don't have them.
 *
 * The `totalCostUsd` and `costByModel` aggregates are populated by the
 * cost JOIN performed by `loadTrajectory`. Both are absent when no cost
 * data exists for the session — older trajectories therefore render the
 * exact same way they did before Gap 4.
 */
export interface LoadedTrajectory {
  id: string;
  task: string;
  agent: string;
  steps: LoadedTrajectoryStep[];
  startedAt: string;
  endedAt?: string;
  success?: boolean;
  /** Aggregate session cost in USD. Absent when no cost data exists. */
  totalCostUsd?: number | null;
  /** Per-model cost aggregates. Absent when no cost data exists. */
  costByModel?: Record<string, LoadedTrajectoryModelCost>;
  /**
   * Aggregate cache-hit ratio across the session's cost entries, on
   * [0..1]. Computed as `cacheRead / (input + cacheRead + cacheCreation)`
   * over the joined token usage. Absent when no cost data exists.
   */
  cacheHitRatio?: number | null;
}

/**
 * Filter / pagination options for {@link listTrajectories}.
 */
export interface ListOptions {
  /** Filter by `startedAt >= since`. Strings are coerced via `new Date()`. */
  since?: Date;
  /** Substring match on agent name (case-insensitive). */
  agent?: string;
  /** Maximum number to return. Applied AFTER sort. Default 50. */
  limit?: number;
}

// ============================================================================
// Internal types — the on-disk shape we read.
// ============================================================================

interface MemoryStoreEntry {
  key: string;
  value: unknown;
  metadata?: Record<string, unknown>;
  storedAt: string;
  accessCount: number;
  lastAccessed: string;
}

interface MemoryStore {
  entries: Record<string, MemoryStoreEntry>;
  version: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const MIN_PREFIX_LENGTH = 8;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve the on-disk path of the memory store using the canonical install
 * context. Centralised so tests can override via RUFLO_INSTALL_CONTEXT_JSON
 * without touching this module.
 */
function getStorePath(): string {
  const ctx = resolveInstallContext();
  return path.join(ctx.claudeRoot, '.claude-flow', 'memory', 'store.json');
}

/**
 * Read + parse store.json. Returns an empty store on any failure
 * (file-not-found, permission denied, malformed JSON). The single failure
 * is logged via `swallowError` so debug builds get a breadcrumb.
 */
function readStore(storePath: string): MemoryStore {
  if (!existsSync(storePath)) {
    return { entries: {}, version: '0.0.0' };
  }

  let raw: string;
  try {
    raw = readFileSync(storePath, 'utf-8');
  } catch (err) {
    swallowError('trace-loader.readFile', err, storePath);
    return { entries: {}, version: '0.0.0' };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'entries' in parsed &&
      typeof (parsed as { entries: unknown }).entries === 'object' &&
      (parsed as { entries: unknown }).entries !== null
    ) {
      return parsed as MemoryStore;
    }
    swallowError('trace-loader.shape', new Error('store.json missing .entries'), storePath);
    return { entries: {}, version: '0.0.0' };
  } catch (err) {
    swallowError('trace-loader.parse', err, storePath);
    return { entries: {}, version: '0.0.0' };
  }
}

/**
 * Same trajectory-detection predicate the hooks-tools intel-stats uses.
 * Treat any entry that mentions "trajectory" in its key OR carries
 * `metadata.type === 'trajectory'` as a candidate. Keeping the predicate
 * loose means historical entries written before the metadata-type
 * convention still surface.
 */
function isTrajectoryEntry(entry: MemoryStoreEntry): boolean {
  if (entry.key.includes('trajectory')) return true;
  const metaType = entry.metadata?.type;
  return typeof metaType === 'string' && metaType === 'trajectory';
}

/**
 * Coerce an unknown `entry.value` into a `LoadedTrajectory`. Returns null
 * when required fields are missing or wrong-typed — caller is expected
 * to skip null results.
 *
 * We accept missing `steps` as an empty array (in-flight trajectories may
 * legitimately have no steps yet). `endedAt` and `success` are optional
 * by spec.
 */
function coerceTrajectory(value: unknown): LoadedTrajectory | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  if (typeof v.id !== 'string' || v.id.length === 0) return null;
  if (typeof v.task !== 'string') return null;
  if (typeof v.agent !== 'string') return null;
  if (typeof v.startedAt !== 'string') return null;

  const rawSteps = Array.isArray(v.steps) ? v.steps : [];
  const steps: LoadedTrajectoryStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const step = s as Record<string, unknown>;
    if (
      typeof step.action !== 'string' ||
      typeof step.result !== 'string' ||
      typeof step.timestamp !== 'string'
    ) {
      continue;
    }
    const quality = typeof step.quality === 'number' ? step.quality : 0.5;
    const out: LoadedTrajectoryStep = {
      action: step.action,
      result: step.result,
      quality,
      timestamp: step.timestamp,
    };
    // Preserve inline cost when the recorder has written it directly onto
    // the step at trajectory-end time. The JOIN in `enrichWithCosts`
    // honours this: inline cost wins over joined cost.
    const inlineCost = coerceStepCost(step.cost);
    if (inlineCost) out.cost = inlineCost;
    steps.push(out);
  }

  const trajectory: LoadedTrajectory = {
    id: v.id,
    task: v.task,
    agent: v.agent,
    steps,
    startedAt: v.startedAt,
  };
  if (typeof v.endedAt === 'string') trajectory.endedAt = v.endedAt;
  if (typeof v.success === 'boolean') trajectory.success = v.success;

  return trajectory;
}

/**
 * Coerce an unknown `step.cost` value into a `LoadedStepCost`. The five
 * fields must all be finite numbers; any non-conforming value resolves to
 * `null` so the caller can drop it without throwing. Used both for inline
 * cost preservation (in `coerceTrajectory`) and for joined entries (in
 * `enrichWithCosts`).
 */
function coerceStepCost(value: unknown): LoadedStepCost | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const fields = ['input', 'output', 'cacheRead', 'cacheCreation', 'total'] as const;
  for (const f of fields) {
    if (typeof c[f] !== 'number' || !Number.isFinite(c[f] as number)) return null;
  }
  const out: LoadedStepCost = {
    input: c.input as number,
    output: c.output as number,
    cacheRead: c.cacheRead as number,
    cacheCreation: c.cacheCreation as number,
    total: c.total as number,
  };
  // Inline-on-disk cost may carry token usage too — preserve it.
  const u = c.usage;
  if (
    u &&
    typeof u === 'object' &&
    typeof (u as Record<string, unknown>).input === 'number' &&
    typeof (u as Record<string, unknown>).output === 'number' &&
    typeof (u as Record<string, unknown>).cacheRead === 'number' &&
    typeof (u as Record<string, unknown>).cacheCreation === 'number'
  ) {
    const usageObj = u as { input: number; output: number; cacheRead: number; cacheCreation: number };
    out.usage = {
      input: usageObj.input,
      output: usageObj.output,
      cacheRead: usageObj.cacheRead,
      cacheCreation: usageObj.cacheCreation,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cost-recorder JOIN
// ---------------------------------------------------------------------------

/**
 * Subset of `CostEntry` from `services/cost-recorder.ts` we actually need
 * for the trajectory JOIN. Redeclared locally so this module compiles even
 * when cost-recorder hasn't shipped yet — we dynamic-import the function
 * and the structural types align at runtime.
 */
interface CostEntryLike {
  sessionId: string | null;
  stepIndex: number | null;
  agent: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number } | null;
}

type ListCostsFn = (opts?: {
  sessionId?: string;
  agent?: string;
  since?: Date;
  limit?: number;
}) => Promise<CostEntryLike[]>;

/**
 * Best-effort dynamic import of `cost-recorder.listCosts`. Returns null on
 * any failure (module not present, runtime export missing, throw at load).
 * The whole point is graceful degradation — older installs and pre-Gap-4
 * trajectories must still render.
 *
 * We use a string path rather than a literal so TypeScript's bundler
 * resolution doesn't refuse to compile when the file is missing during
 * parallel-coder development. The function signature is enforced by the
 * locked Gap-4 contract (see GAP-4-DESIGN.md).
 */
async function loadListCosts(): Promise<ListCostsFn | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('./cost-recorder.js' as string);
    if (mod && typeof mod.listCosts === 'function') {
      return mod.listCosts as ListCostsFn;
    }
    return null;
  } catch (err) {
    // Module not present (parallel coder hasn't shipped) OR import threw.
    // Either way, cost data is unavailable — we fall through silently.
    swallowError('trace-loader.cost-recorder-import', err, '');
    return null;
  }
}

/**
 * JOIN cost-recorder entries onto a trajectory in-place. Strategy:
 *   1. Each step at index `i` gets the cost entry whose `stepIndex === i`,
 *      ONLY when the step doesn't already have an inline `cost` (recorder
 *      may have written it directly at trajectory-end time, which wins).
 *   2. `totalCostUsd` sums every entry's `costUsd.total` for the session
 *      — this is the source of truth for the header, NOT a re-sum of
 *      step.cost (so dispatches that don't map to a step still count).
 *   3. `costByModel` aggregates by `entry.model`.
 *   4. `cacheHitRatio` derives from the joined token usage.
 *
 * If `listCosts` returns `[]` (no data for this session), the trajectory
 * is returned unchanged — no `totalCostUsd`, no `costByModel`. This is
 * the "older trajectory" path: existing UI just shows what it always did.
 */
async function enrichWithCosts(t: LoadedTrajectory): Promise<LoadedTrajectory> {
  const listCosts = await loadListCosts();
  if (!listCosts) return t;

  let entries: CostEntryLike[];
  try {
    entries = await listCosts({ sessionId: t.id });
  } catch (err) {
    swallowError('trace-loader.listCosts', err, t.id);
    return t;
  }

  if (!Array.isArray(entries) || entries.length === 0) return t;

  // (1) Per-step JOIN. Build an index → entry map first so multiple entries
  // for the same stepIndex (rare; would be a recorder bug) deterministically
  // resolve to the LAST written entry.
  const byStepIndex = new Map<number, CostEntryLike>();
  for (const entry of entries) {
    if (typeof entry.stepIndex === 'number' && Number.isFinite(entry.stepIndex)) {
      byStepIndex.set(entry.stepIndex, entry);
    }
  }
  for (let i = 0; i < t.steps.length; i++) {
    const step = t.steps[i]!;
    if (step.cost) continue; // inline cost wins
    const entry = byStepIndex.get(i);
    if (!entry) continue;
    const cost = coerceStepCost(entry.costUsd);
    if (cost) {
      // Attach the recorder's raw token usage so the side-panel can
      // render the per-category token counts alongside the USD figures.
      // Defensive coercion — entry.usage might be malformed.
      const u = entry.usage;
      if (
        u &&
        typeof u.input === 'number' &&
        typeof u.output === 'number' &&
        typeof u.cacheRead === 'number' &&
        typeof u.cacheCreation === 'number'
      ) {
        cost.usage = {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheCreation: u.cacheCreation,
        };
      }
      step.cost = cost;
    }
  }

  // (2) Aggregate session total. Sum across ALL entries — even ones that
  // didn't bind to a specific step still belong in the per-session figure.
  let totalUsd = 0;
  let haveAnyCost = false;
  for (const entry of entries) {
    const total = entry.costUsd?.total;
    if (typeof total === 'number' && Number.isFinite(total)) {
      totalUsd += total;
      haveAnyCost = true;
    }
  }
  // Round to 6 decimals to match pricing.ts convention; avoids tiny
  // floating-point drift surfacing in the rendered header.
  t.totalCostUsd = haveAnyCost ? Math.round(totalUsd * 1_000_000) / 1_000_000 : null;

  // (3) costByModel — count + sum.
  const byModel: Record<string, LoadedTrajectoryModelCost> = {};
  for (const entry of entries) {
    const model = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : 'unknown';
    const total = entry.costUsd?.total ?? 0;
    if (!byModel[model]) {
      byModel[model] = { dispatches: 0, totalUsd: 0 };
    }
    byModel[model].dispatches += 1;
    if (typeof total === 'number' && Number.isFinite(total)) {
      byModel[model].totalUsd = Math.round((byModel[model].totalUsd + total) * 1_000_000) / 1_000_000;
    }
  }
  t.costByModel = byModel;

  // (4) Cache-hit ratio across the session. Denominator is "tokens that
  // could conceivably have been served from cache" = input + cacheRead +
  // cacheCreation. Output tokens are excluded — they're never cacheable.
  let cacheRead = 0;
  let denom = 0;
  for (const entry of entries) {
    const u = entry.usage;
    if (!u) continue;
    if (typeof u.cacheRead === 'number' && Number.isFinite(u.cacheRead)) cacheRead += u.cacheRead;
    if (typeof u.input === 'number' && Number.isFinite(u.input)) denom += u.input;
    if (typeof u.cacheRead === 'number' && Number.isFinite(u.cacheRead)) denom += u.cacheRead;
    if (typeof u.cacheCreation === 'number' && Number.isFinite(u.cacheCreation)) denom += u.cacheCreation;
  }
  t.cacheHitRatio = denom > 0 ? cacheRead / denom : null;

  return t;
}

/**
 * Walk every entry in the store, keep the trajectory-shaped ones, return
 * them as `LoadedTrajectory[]`. Malformed entries are skipped (logged
 * once each via `swallowError`) so a single bad entry can't poison the
 * whole list.
 */
function collectTrajectories(store: MemoryStore): LoadedTrajectory[] {
  const out: LoadedTrajectory[] = [];
  for (const entry of Object.values(store.entries)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isTrajectoryEntry(entry)) continue;

    const trajectory = coerceTrajectory(entry.value);
    if (trajectory === null) {
      swallowError(
        'trace-loader.coerce',
        new Error(`malformed trajectory entry: ${entry.key}`),
        entry.key,
      );
      continue;
    }
    out.push(trajectory);
  }
  return out;
}

/**
 * Compare-fn for `Array.prototype.sort`. Newest-first by `startedAt`.
 * Invalid dates fall through to lexicographic compare which is still
 * deterministic — we never throw from the comparator.
 */
function byStartedAtDesc(a: LoadedTrajectory, b: LoadedTrajectory): number {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
  // Fallback — at least one date is unparseable; lexicographic on the raw
  // string keeps sort total-order without crashing.
  if (a.startedAt === b.startedAt) return 0;
  return a.startedAt < b.startedAt ? 1 : -1;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List recent trajectories, newest first by `startedAt`.
 *
 * Reads `~/.claude/.claude-flow/memory/store.json` (resolved via
 * `resolveInstallContext`). Returns `[]` if the store doesn't exist.
 *
 * @param opts.since — keep only trajectories with `startedAt >= since`
 * @param opts.agent — case-insensitive substring match on the agent name
 * @param opts.limit — applied AFTER sort. Defaults to 50.
 */
export async function listTrajectories(opts?: ListOptions): Promise<LoadedTrajectory[]> {
  const storePath = getStorePath();
  const store = readStore(storePath);

  let trajectories = collectTrajectories(store);

  if (opts?.since instanceof Date && !Number.isNaN(opts.since.getTime())) {
    const sinceMs = opts.since.getTime();
    trajectories = trajectories.filter((t) => {
      const ts = Date.parse(t.startedAt);
      // If the trajectory's startedAt is unparseable, drop it — we can't
      // honour a since-filter without a real timestamp.
      if (!Number.isFinite(ts)) return false;
      return ts >= sinceMs;
    });
  }

  if (typeof opts?.agent === 'string' && opts.agent.length > 0) {
    const needle = opts.agent.toLowerCase();
    trajectories = trajectories.filter((t) => t.agent.toLowerCase().includes(needle));
  }

  trajectories.sort(byStartedAtDesc);

  const limit =
    typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
      ? Math.floor(opts.limit)
      : DEFAULT_LIMIT;

  return trajectories.slice(0, limit);
}

/**
 * Load a single trajectory by id. Accepts:
 *   - full id (exact match — always tried first)
 *   - prefix (≥ 8 chars, must uniquely identify one trajectory)
 *   - 'latest' shorthand → the newest trajectory by `startedAt`
 *
 * Returns `null` if not found, prefix-too-short, ambiguous prefix, or the
 * store is missing/malformed. Ambiguous-prefix is logged via
 * `swallowError('trace-loader.ambiguous-prefix', ...)` so debug builds
 * can see why a lookup failed.
 */
export async function loadTrajectory(sessionId: string): Promise<LoadedTrajectory | null> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

  const storePath = getStorePath();
  const store = readStore(storePath);
  const trajectories = collectTrajectories(store);

  if (trajectories.length === 0) return null;

  // Resolve to a single trajectory first; cost JOIN happens once, on the
  // resolved match. This keeps the JOIN cost O(1 trajectory × N cost
  // entries) rather than O(all trajectories × N).
  const resolved = resolveTrajectory(trajectories, sessionId);
  if (!resolved) return null;

  // Best-effort cost JOIN. Returns the trajectory unchanged when no cost
  // data exists for the session — backwards compatible with pre-Gap-4
  // trajectories.
  return await enrichWithCosts(resolved);
}

/**
 * Resolve a sessionId to a single trajectory. Pure lookup logic factored
 * out of `loadTrajectory` so the cost-JOIN decoration can run on a single
 * resolved instance. Mirrors the contract:
 *   - 'latest' -> newest by startedAt
 *   - exact id -> that trajectory
 *   - >= 8-char prefix, unique match -> that trajectory
 *   - ambiguous / too-short / no-match -> null
 */
function resolveTrajectory(trajectories: LoadedTrajectory[], sessionId: string): LoadedTrajectory | null {
  // 'latest' shorthand — newest by startedAt
  if (sessionId === 'latest') {
    const sorted = [...trajectories].sort(byStartedAtDesc);
    return sorted[0] ?? null;
  }

  // Always try exact match first — even on short ids, exact wins.
  const exact = trajectories.find((t) => t.id === sessionId);
  if (exact) return exact;

  // Prefix match only when ≥ MIN_PREFIX_LENGTH chars.
  if (sessionId.length < MIN_PREFIX_LENGTH) return null;

  const matches = trajectories.filter((t) => t.id.startsWith(sessionId));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  // Ambiguous — refuse rather than guess.
  swallowError(
    'trace-loader.ambiguous-prefix',
    new Error(`prefix '${sessionId}' matches ${matches.length} trajectories`),
    matches.map((m) => m.id).join(','),
  );
  return null;
}
