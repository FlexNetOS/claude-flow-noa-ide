/**
 * Unit tests for `services/pricing.ts` (Gap 4 — per-agent cost telemetry).
 *
 * Coverage:
 *   - PRICING contains the expected canonical 4.x + legacy 3.x entries.
 *   - priceFor exact match.
 *   - priceFor short-alias resolution ('sonnet' -> 'claude-sonnet-4-6', etc.).
 *   - priceFor strips a trailing -YYYYMMDD suffix and matches the canonical entry.
 *   - priceFor returns null on unknown / empty input.
 *   - computeCostUsd happy path with all four token categories.
 *   - computeCostUsd respects the cacheTtl='1h' branch (uses 1h rate, not 5m).
 *   - computeCostUsd returns null on unknown model.
 *   - loadPricingOverride returns {} when the override file is missing.
 *   - loadPricingOverride returns {} on malformed JSON (and writes via swallowError).
 *   - loadPricingOverride returns {} when the parsed value is not an object.
 *   - loadPricingOverride parses a valid override file.
 *   - loadPricingOverride is a partial overlay — keys not in the override
 *     do NOT get evicted from PRICING when callers spread.
 *   - loadPricingOverride drops malformed entries but keeps valid ones.
 *
 * The override-file tests use mkdtempSync + RUFLO_INSTALL_CONTEXT_JSON to
 * pin the install context to a per-test tmpdir; nothing in the real
 * ~/.claude tree is read or written.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Install-context override ----------------------------------------------
//
// Pin claudeRoot to a per-suite tmpdir BEFORE importing pricing.ts so the
// module's getOverridePath() resolves under our control. Each test that
// needs a different override-file state writes / removes the file under
// `${claudeRoot}/.claude-flow/pricing-override.json`.

const tmpRoot = mkdtempSync(join(tmpdir(), 'pricing-test-'));
const fakeClaudeRoot = join(tmpRoot, '.claude');
const fakeDataDir = join(fakeClaudeRoot, '.claude-flow', 'data');
const fakeFlowDir = join(fakeClaudeRoot, '.claude-flow');
mkdirSync(fakeFlowDir, { recursive: true });
mkdirSync(fakeDataDir, { recursive: true });

process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
  packageRoot: tmpRoot,
  claudeRoot: fakeClaudeRoot,
  dataDir: fakeDataDir,
  isGlobalInstall: true,
  projectRoot: null,
});

const overridePath = join(fakeFlowDir, 'pricing-override.json');

const {
  PRICING,
  priceFor,
  computeCostUsd,
  loadPricingOverride,
} = await import('../src/services/pricing.js');

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// PRICING table
// ---------------------------------------------------------------------------

describe('PRICING table', () => {
  it('contains the canonical 4.x entries', () => {
    expect(PRICING['claude-opus-4-7']).toBeDefined();
    expect(PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING['claude-haiku-4-5']).toBeDefined();
  });

  it('contains the legacy 3.x aliases for back-compat', () => {
    expect(PRICING['claude-3-5-sonnet-latest']).toBeDefined();
    expect(PRICING['claude-3-5-haiku-latest']).toBeDefined();
    expect(PRICING['claude-3-opus-latest']).toBeDefined();
  });

  it('uses the 2026-05-09 list-price values for sonnet-4-6', () => {
    expect(PRICING['claude-sonnet-4-6']).toEqual({
      inputPerMTok: 3.00,
      outputPerMTok: 15.00,
      cacheReadPerMTok: 0.30,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6.00,
    });
  });

  it('uses the 2026-05-09 list-price values for opus-4-7', () => {
    expect(PRICING['claude-opus-4-7']).toEqual({
      inputPerMTok: 15.00,
      outputPerMTok: 75.00,
      cacheReadPerMTok: 1.50,
      cacheWrite5mPerMTok: 18.75,
      cacheWrite1hPerMTok: 30.00,
    });
  });
});

// ---------------------------------------------------------------------------
// priceFor()
// ---------------------------------------------------------------------------

describe('priceFor()', () => {
  it('exact match against PRICING returns the same object', () => {
    expect(priceFor('claude-sonnet-4-6')).toBe(PRICING['claude-sonnet-4-6']);
    expect(priceFor('claude-haiku-4-5')).toBe(PRICING['claude-haiku-4-5']);
    expect(priceFor('claude-opus-4-7')).toBe(PRICING['claude-opus-4-7']);
  });

  it('resolves short aliases to the canonical 4.x model', () => {
    expect(priceFor('sonnet')).toBe(PRICING['claude-sonnet-4-6']);
    expect(priceFor('haiku')).toBe(PRICING['claude-haiku-4-5']);
    expect(priceFor('opus')).toBe(PRICING['claude-opus-4-7']);
  });

  it('strips a trailing -YYYYMMDD date suffix and re-tries the lookup', () => {
    // Dated snapshots must price-match their canonical un-suffixed entry.
    expect(priceFor('claude-sonnet-4-6-20251022')).toBe(PRICING['claude-sonnet-4-6']);
    expect(priceFor('claude-opus-4-7-20260301')).toBe(PRICING['claude-opus-4-7']);
    expect(priceFor('claude-haiku-4-5-20260515')).toBe(PRICING['claude-haiku-4-5']);
  });

  it('returns null for unknown models', () => {
    expect(priceFor('gpt-4o')).toBeNull();
    expect(priceFor('claude-99-mythical')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(priceFor('')).toBeNull();
  });

  it('does NOT strip a non-date suffix', () => {
    // Looks like a date but isn't 8 digits; must not match.
    expect(priceFor('claude-sonnet-4-6-2025')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeCostUsd()
// ---------------------------------------------------------------------------

describe('computeCostUsd()', () => {
  it('happy path — all four categories sum correctly at the 5m rate', () => {
    // 1M input @ $3      = $3.000000
    // 1M output @ $15    = $15.000000
    // 1M cacheRead @0.30 = $0.300000
    // 1M cacheCreation @ 5m rate ($3.75) = $3.750000
    // total              = $22.050000
    const cost = computeCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 },
      'claude-sonnet-4-6',
      '5m',
    );
    expect(cost).not.toBeNull();
    expect(cost!.input).toBeCloseTo(3.0, 6);
    expect(cost!.output).toBeCloseTo(15.0, 6);
    expect(cost!.cacheRead).toBeCloseTo(0.3, 6);
    expect(cost!.cacheCreation).toBeCloseTo(3.75, 6);
    expect(cost!.total).toBeCloseTo(22.05, 6);
  });

  it('cacheTtl=\'1h\' uses the 1h cache-write rate, not the 5m rate', () => {
    // cacheCreation: 1M tokens @ 1h rate ($6) = $6.000000
    const costAt1h = computeCostUsd(
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 },
      'claude-sonnet-4-6',
      '1h',
    );
    const costAt5m = computeCostUsd(
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 },
      'claude-sonnet-4-6',
      '5m',
    );
    expect(costAt1h!.cacheCreation).toBeCloseTo(6.0, 6);
    expect(costAt5m!.cacheCreation).toBeCloseTo(3.75, 6);
    expect(costAt1h!.total).toBeCloseTo(6.0, 6);
    expect(costAt5m!.total).toBeCloseTo(3.75, 6);
  });

  it('rounds each category to 6 decimal places (sub-cent precision)', () => {
    // 1 input token @ $3/MTok = 0.000003 — exactly representable when rounded.
    const cost = computeCostUsd(
      { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4-6',
      '1h',
    );
    expect(cost!.input).toBe(0.000003);
    expect(cost!.total).toBe(0.000003);
  });

  it('handles all-zero usage with a known model (returns zero-cost breakdown)', () => {
    const cost = computeCostUsd(
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4-6',
      '1h',
    );
    expect(cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    });
  });

  it('returns null when the model is unknown', () => {
    const cost = computeCostUsd(
      { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      'gpt-4o',
      '1h',
    );
    expect(cost).toBeNull();
  });

  it('resolves dated snapshots through priceFor', () => {
    // Same usage, dated snapshot must produce same cost as the canonical id.
    const dated = computeCostUsd(
      { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4-6-20251022',
      '1h',
    );
    const canonical = computeCostUsd(
      { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
      'claude-sonnet-4-6',
      '1h',
    );
    expect(dated).toEqual(canonical);
  });
});

// ---------------------------------------------------------------------------
// loadPricingOverride()
// ---------------------------------------------------------------------------

describe('loadPricingOverride()', () => {
  beforeEach(() => {
    // Each test starts with no override file. Tests that need one write it
    // explicitly to keep the contract under test crisp.
    try {
      rmSync(overridePath, { force: true });
    } catch {
      /* nothing to clean */
    }
  });

  it('returns {} when the override file is missing', () => {
    const overrides = loadPricingOverride();
    expect(overrides).toEqual({});
  });

  it('returns {} when the override file is malformed JSON (swallowed)', () => {
    writeFileSync(overridePath, '{ this is not json', 'utf-8');
    // Should NOT throw — failure must be silent except for the swallowError
    // breadcrumb, which only emits at debug log level. We assert no throw +
    // empty result.
    const overrides = loadPricingOverride();
    expect(overrides).toEqual({});
  });

  it('returns {} when the parsed value is not an object (e.g. an array)', () => {
    writeFileSync(overridePath, '[1, 2, 3]', 'utf-8');
    const overrides = loadPricingOverride();
    expect(overrides).toEqual({});
  });

  it('returns {} when the parsed value is null / a primitive', () => {
    writeFileSync(overridePath, 'null', 'utf-8');
    expect(loadPricingOverride()).toEqual({});

    writeFileSync(overridePath, '"sonnet"', 'utf-8');
    expect(loadPricingOverride()).toEqual({});

    writeFileSync(overridePath, '42', 'utf-8');
    expect(loadPricingOverride()).toEqual({});
  });

  it('parses a valid override file', () => {
    const valid = {
      'claude-sonnet-4-6': {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
        cacheReadPerMTok: 0.2,
        cacheWrite5mPerMTok: 2.5,
        cacheWrite1hPerMTok: 4.0,
      },
    };
    writeFileSync(overridePath, JSON.stringify(valid), 'utf-8');

    const overrides = loadPricingOverride();
    expect(overrides).toEqual(valid);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const mixed = {
      'claude-sonnet-4-6': {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
        cacheReadPerMTok: 0.2,
        cacheWrite5mPerMTok: 2.5,
        cacheWrite1hPerMTok: 4.0,
      },
      'claude-broken-entry': {
        // Missing required fields — must be dropped.
        inputPerMTok: 1.0,
      },
      'claude-also-broken': 'not-an-object',
    };
    writeFileSync(overridePath, JSON.stringify(mixed), 'utf-8');

    const overrides = loadPricingOverride();
    expect(Object.keys(overrides)).toEqual(['claude-sonnet-4-6']);
    expect(overrides['claude-sonnet-4-6']).toEqual(mixed['claude-sonnet-4-6']);
  });

  it('is a partial overlay — callers spreading it on PRICING preserve untouched keys', () => {
    // Override only sonnet — opus/haiku must still appear in the merged
    // table (the merge happens in cost-recorder.ts, not here, but we assert
    // the override semantics are partial-by-design).
    const partial = {
      'claude-sonnet-4-6': {
        inputPerMTok: 99.0,
        outputPerMTok: 99.0,
        cacheReadPerMTok: 99.0,
        cacheWrite5mPerMTok: 99.0,
        cacheWrite1hPerMTok: 99.0,
      },
    };
    writeFileSync(overridePath, JSON.stringify(partial), 'utf-8');

    const overrides = loadPricingOverride();
    const merged = { ...PRICING, ...overrides };

    // Sonnet replaced.
    expect(merged['claude-sonnet-4-6'].inputPerMTok).toBe(99.0);
    // Opus + haiku untouched.
    expect(merged['claude-opus-4-7']).toBe(PRICING['claude-opus-4-7']);
    expect(merged['claude-haiku-4-5']).toBe(PRICING['claude-haiku-4-5']);
  });
});

// ---------------------------------------------------------------------------
// Sanity: install-context override actually wired through
// ---------------------------------------------------------------------------

describe('install-context wiring', () => {
  it('reads from the env-pinned tmpdir, NOT the real ~/.claude', () => {
    // If the env override weren't honoured the test suite would either
    // read the real user's pricing-override.json (polluting results) or
    // fail to write at all. Assert we can write + read a sentinel file
    // through the same code path.
    const sentinel = {
      'claude-sentinel-model': {
        inputPerMTok: 1.23,
        outputPerMTok: 4.56,
        cacheReadPerMTok: 0.1,
        cacheWrite5mPerMTok: 0.2,
        cacheWrite1hPerMTok: 0.3,
      },
    };
    writeFileSync(overridePath, JSON.stringify(sentinel), 'utf-8');
    expect(loadPricingOverride()).toEqual(sentinel);
  });
});

// Marker so an empty PRICING export would be caught by an "exports exist" smoke.
describe('exports surface', () => {
  beforeAll(() => {
    expect(typeof PRICING).toBe('object');
    expect(typeof priceFor).toBe('function');
    expect(typeof computeCostUsd).toBe('function');
    expect(typeof loadPricingOverride).toBe('function');
  });

  it('exposes all four locked exports', () => {
    expect(PRICING).toBeDefined();
    expect(priceFor).toBeDefined();
    expect(computeCostUsd).toBeDefined();
    expect(loadPricingOverride).toBeDefined();
  });
});
