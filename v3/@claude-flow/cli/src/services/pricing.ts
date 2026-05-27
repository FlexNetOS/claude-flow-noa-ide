/**
 * pricing — Anthropic model pricing table + cost computation utilities.
 *
 * Why this module exists
 * ----------------------
 * Gap 4 (per-agent cost telemetry) needs to convert raw token usage from the
 * Anthropic API response into USD costs. This module is the single source of
 * truth for "what does a token cost?" — both the hardcoded table baked into
 * the binary and the optional per-install JSON override.
 *
 * Contract (locked — do not change without updating Gap-4 design):
 *   - PRICING               — frozen table of canonical model id → ModelPricing
 *   - priceFor(model)       — exact / alias / date-suffix-stripped lookup
 *   - computeCostUsd(...)   — USD CostBreakdown for a single API call
 *   - loadPricingOverride() — best-effort read of ${claudeRoot}/.claude-flow/pricing-override.json
 *
 * Design notes
 * ------------
 * - Pure utility — the ONLY I/O is `loadPricingOverride()`. The override file
 *   is NEVER read on module load; callers ask for it explicitly. This keeps
 *   the module fast to import and side-effect-free for tooling that only
 *   needs `priceFor` / `computeCostUsd`.
 * - Failure-tolerant override loader: missing file -> {}, malformed JSON ->
 *   {}, both swallowed via `swallowError`. Cost telemetry must never break a
 *   dispatch.
 * - Short aliases (`'sonnet'`, `'haiku'`, `'opus'`) resolve to the current
 *   4.x canonical models. The legacy 3.x → 'claude-3-5-sonnet-latest' map
 *   in `mcp-tools/agent-execute-core.ts:84-88` is intentionally NOT imported
 *   here (avoids dependency cycle); we pin the convention to today's
 *   pricing reality instead.
 * - Date-suffixed model strings (e.g. `claude-sonnet-4-6-20251022`) fall
 *   back to the un-suffixed canonical entry by stripping a trailing
 *   `-YYYYMMDD`.
 * - All USD outputs round to 6 decimal places — sub-cent precision is
 *   needed because individual cache-read tokens cost fractions of a
 *   millicent and per-dispatch sums need to stay accurate.
 *
 * @module v3/cli/services/pricing
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { resolveInstallContext, swallowError } from '@claude-flow/shared';

// ============================================================================
// Public types — locked contract surface.
// ============================================================================

/**
 * USD-per-million-tokens pricing for one Anthropic model. All five fields
 * are required so the table stays comparable across models; cache writes
 * always have separate 5m and 1h rates because Anthropic prices them
 * differently.
 */
export interface ModelPricing {
  /** Plain input tokens (not yet cached). $/MTok. */
  inputPerMTok: number;
  /** Output tokens. $/MTok. */
  outputPerMTok: number;
  /** Tokens served from prompt cache (typically 10% of input). $/MTok. */
  cacheReadPerMTok: number;
  /** Tokens written to cache @ 5-minute TTL (1.25x input). $/MTok. */
  cacheWrite5mPerMTok: number;
  /** Tokens written to cache @ 1-hour TTL (2x input). $/MTok. */
  cacheWrite1hPerMTok: number;
}

/**
 * Token counts as reported by the Anthropic API for a single call.
 * Mirrors the four fields the SDK exposes on `response.usage`.
 */
export interface TokenUsage {
  /** Raw input tokens (not yet cached). */
  input: number;
  /** Output tokens. */
  output: number;
  /** Tokens served from cache on this call. */
  cacheRead: number;
  /** Tokens written to cache on this call. */
  cacheCreation: number;
}

/**
 * Per-category USD breakdown plus the summed total. All values are
 * pre-rounded to 6 decimal places so downstream sums stay accurate.
 */
export interface CostBreakdown {
  /** USD spent on raw input tokens. */
  input: number;
  /** USD spent on output tokens. */
  output: number;
  /** USD spent on cache reads. */
  cacheRead: number;
  /** USD spent on cache writes (at the 5m or 1h rate per `cacheTtl`). */
  cacheCreation: number;
  /** Sum of the four categories above. */
  total: number;
}

/** Cache TTL determines whether `cacheCreation` is billed at the 5m or 1h rate. */
export type CacheTtl = '5m' | '1h';

// ============================================================================
// The pricing table — Anthropic public list prices as of 2026-05-09.
// ============================================================================

/**
 * Hardcoded model → pricing map. Keys are the canonical Anthropic model ids.
 * Per-install overrides via {@link loadPricingOverride} take precedence
 * when callers merge them in (see `cost-recorder.ts`).
 */
export const PRICING: Record<string, ModelPricing> = {
  // Claude 4.x — current flagship line.
  'claude-opus-4-7':           { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00 },
  'claude-sonnet-4-6':         { inputPerMTok:  3.00, outputPerMTok: 15.00, cacheReadPerMTok: 0.30, cacheWrite5mPerMTok:  3.75, cacheWrite1hPerMTok:  6.00 },
  'claude-haiku-4-5':          { inputPerMTok:  1.00, outputPerMTok:  5.00, cacheReadPerMTok: 0.10, cacheWrite5mPerMTok:  1.25, cacheWrite1hPerMTok:  2.00 },

  // Claude 3.x — legacy aliases retained for backward compatibility with
  // older trajectories whose `model` field was captured before the 4.x
  // rollout. Costs match the 3.x list-price archive.
  'claude-3-5-sonnet-latest':  { inputPerMTok:  3.00, outputPerMTok: 15.00, cacheReadPerMTok: 0.30, cacheWrite5mPerMTok:  3.75, cacheWrite1hPerMTok:  6.00 },
  'claude-3-5-haiku-latest':   { inputPerMTok:  0.80, outputPerMTok:  4.00, cacheReadPerMTok: 0.08, cacheWrite5mPerMTok:  1.00, cacheWrite1hPerMTok:  1.60 },
  'claude-3-opus-latest':      { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00 },
};

// ============================================================================
// Internal: alias map + lookup helpers.
// ============================================================================

/**
 * Short-alias → canonical-model map. Pinned to the current 4.x line because
 * Gap 4 cost telemetry should reflect what users are actually billed today
 * when they request `'sonnet'`. The legacy 3.x alias map in
 * `agent-execute-core.ts:84-88` exists for runtime model selection
 * compatibility; pricing semantics are different.
 */
const SHORT_ALIASES: Record<string, string> = {
  haiku:   'claude-haiku-4-5',
  sonnet:  'claude-sonnet-4-6',
  opus:    'claude-opus-4-7',
};

/**
 * Trailing `-YYYYMMDD` suffix matcher. Anthropic publishes dated snapshots
 * (e.g. `claude-sonnet-4-6-20251022`) that are pricing-equivalent to the
 * un-suffixed canonical entry, so we strip and retry on miss.
 */
const DATE_SUFFIX_RE = /-\d{8}$/;

// ============================================================================
// Public lookup API.
// ============================================================================

/**
 * Look up pricing for a model. Resolution order:
 *   1. Exact key match against {@link PRICING}.
 *   2. Short-alias resolution (`'sonnet'` -> `'claude-sonnet-4-6'`).
 *   3. Strip trailing `-YYYYMMDD` and re-try exact match.
 * Returns `null` when none of the above succeed — callers (cost-recorder)
 * surface this as "unknown model, cost not computed" rather than throwing.
 */
export function priceFor(model: string): ModelPricing | null {
  if (!model) return null;

  // 1. Exact match.
  const exact = PRICING[model];
  if (exact) return exact;

  // 2. Short alias (e.g. 'sonnet').
  const aliased = SHORT_ALIASES[model];
  if (aliased) {
    const viaAlias = PRICING[aliased];
    if (viaAlias) return viaAlias;
  }

  // 3. Strip dated snapshot suffix and re-try.
  if (DATE_SUFFIX_RE.test(model)) {
    const stripped = model.replace(DATE_SUFFIX_RE, '');
    const viaStrip = PRICING[stripped];
    if (viaStrip) return viaStrip;
  }

  return null;
}

/**
 * Compute USD cost for a single Anthropic API call.
 *
 * @param usage    Token counts from `response.usage`.
 * @param model    Model id from `response.model` (or short alias / dated snapshot).
 * @param cacheTtl `'5m'` or `'1h'` — selects which cache-write rate applies.
 *                 Currently the codebase always uses `'1h'` via the
 *                 cache_control beta, but the parameter is locked into the
 *                 contract so the deprecated `'5m'` path stays computable.
 * @returns        A {@link CostBreakdown} with per-category and total USD,
 *                 each rounded to 6 decimal places. Returns `null` when no
 *                 pricing entry exists for the model.
 */
export function computeCostUsd(
  usage: TokenUsage,
  model: string,
  cacheTtl: CacheTtl,
): CostBreakdown | null {
  const pricing = priceFor(model);
  if (!pricing) return null;

  const cacheWriteRate =
    cacheTtl === '1h' ? pricing.cacheWrite1hPerMTok : pricing.cacheWrite5mPerMTok;

  const input = round6((usage.input         / 1_000_000) * pricing.inputPerMTok);
  const output = round6((usage.output       / 1_000_000) * pricing.outputPerMTok);
  const cacheRead = round6((usage.cacheRead / 1_000_000) * pricing.cacheReadPerMTok);
  const cacheCreation = round6((usage.cacheCreation / 1_000_000) * cacheWriteRate);
  const total = round6(input + output + cacheRead + cacheCreation);

  return { input, output, cacheRead, cacheCreation, total };
}

// ============================================================================
// Override loader — the only I/O in this module.
// ============================================================================

/**
 * Resolve the override file path. Centralised so tests can pin it via
 * `RUFLO_INSTALL_CONTEXT_JSON` without touching this module's internals.
 */
function getOverridePath(): string {
  const ctx = resolveInstallContext();
  return path.join(ctx.claudeRoot, '.claude-flow', 'pricing-override.json');
}

/**
 * Best-effort read of `${claudeRoot}/.claude-flow/pricing-override.json`.
 * Returns the parsed `Record<string, ModelPricing>` when the file exists
 * and is valid JSON of the right shape; returns `{}` otherwise.
 *
 * Callers are expected to spread this on top of {@link PRICING} when they
 * want override-aware pricing — this module deliberately does NOT mutate
 * the exported `PRICING` table so consumers can still see the raw
 * hardcoded values.
 *
 * Failure modes (all swallowed via `swallowError`):
 *   - file missing            -> {}
 *   - read error / EACCES     -> {}
 *   - malformed JSON          -> {}
 *   - parsed value not object -> {}
 */
export function loadPricingOverride(): Record<string, ModelPricing> {
  const overridePath = getOverridePath();

  if (!existsSync(overridePath)) {
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(overridePath, 'utf-8');
  } catch (err) {
    swallowError('pricing.loadOverride', err, overridePath);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    swallowError('pricing.loadOverride', err, overridePath);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    swallowError(
      'pricing.loadOverride',
      new Error('override file is not a JSON object'),
      overridePath,
    );
    return {};
  }

  // Shape-validate each entry. Anything that doesn't look like a
  // ModelPricing is dropped with a swallowed warning rather than letting
  // a malformed record corrupt the merged table.
  const out: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isModelPricing(value)) {
      out[model] = value;
    } else {
      swallowError(
        'pricing.loadOverride',
        new Error(`override entry "${model}" has wrong shape`),
        overridePath,
      );
    }
  }
  return out;
}

/**
 * Type guard — returns true when `value` has all five numeric fields of
 * {@link ModelPricing}.
 */
function isModelPricing(value: unknown): value is ModelPricing {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.inputPerMTok === 'number' &&
    typeof v.outputPerMTok === 'number' &&
    typeof v.cacheReadPerMTok === 'number' &&
    typeof v.cacheWrite5mPerMTok === 'number' &&
    typeof v.cacheWrite1hPerMTok === 'number'
  );
}

/**
 * Round to 6 decimal places. JavaScript floats can't represent every
 * decimal exactly so the multiply-round-divide pattern is the standard
 * way to keep cost sums from accumulating rounding drift across many
 * dispatches.
 */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
