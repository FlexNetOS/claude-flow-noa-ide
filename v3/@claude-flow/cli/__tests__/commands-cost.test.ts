/**
 * Gap 4 — `swarmops cost` CLI tests.
 *
 * Covers stats / session / models / reset subcommands plus the inline
 * format helpers (formatUsd, formatTokens, formatPct, summarizeFromEntries).
 *
 * Mocks the cost-recorder + pricing modules so we don't depend on real
 * on-disk cost-stats.json data — keeps the test deterministic regardless
 * of dev's home dir or whether a recorder file exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the recorder + pricing modules first — must come before importing
// the command module under test.
// ---------------------------------------------------------------------------

const mockListCosts = vi.fn();
const mockSummarizeCosts = vi.fn();
const mockResetCostStats = vi.fn();

vi.mock('../src/services/cost-recorder.js', () => ({
  listCosts: (...args: unknown[]) => mockListCosts(...args),
  summarizeCosts: (...args: unknown[]) => mockSummarizeCosts(...args),
  resetCostStats: (...args: unknown[]) => mockResetCostStats(...args),
}));

const mockLoadPricingOverride = vi.fn();
vi.mock('../src/services/pricing.js', () => ({
  PRICING: {
    'claude-sonnet-4-6': {
      inputPerMTok: 3.00,
      outputPerMTok: 15.00,
      cacheReadPerMTok: 0.30,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6.00,
    },
    'claude-haiku-4-5': {
      inputPerMTok: 1.00,
      outputPerMTok: 5.00,
      cacheReadPerMTok: 0.10,
      cacheWrite5mPerMTok: 1.25,
      cacheWrite1hPerMTok: 2.00,
    },
  },
  loadPricingOverride: (...args: unknown[]) => mockLoadPricingOverride(...args),
}));

beforeEach(() => {
  mockListCosts.mockReset();
  mockSummarizeCosts.mockReset();
  mockResetCostStats.mockReset();
  mockLoadPricingOverride.mockReset();
  // Default: override is empty.
  mockLoadPricingOverride.mockReturnValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(args: string[] = [], flags: Record<string, unknown> = {}): {
  args: string[];
  flags: Record<string, unknown> & { _: string[] };
  cwd: string;
  interactive: boolean;
} {
  return {
    args,
    flags: { ...flags, _: args },
    cwd: process.cwd(),
    interactive: false,
  };
}

function sampleEntry(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-05-09T08:00:00.000Z',
    sessionId: 'session-abc',
    stepIndex: 0,
    agent: 'coder-bridge',
    model: 'claude-sonnet-4-6',
    cacheTtl: '1h' as const,
    usage: { input: 1000, output: 500, cacheRead: 8000, cacheCreation: 2000 },
    costUsd: { input: 0.003, output: 0.0075, cacheRead: 0.0024, cacheCreation: 0.012, total: 0.0249 },
    ...overrides,
  };
}

function sampleSummary(overrides: Record<string, unknown> = {}) {
  return {
    totalEntries: 100,
    totalUsd: 1.42,
    byModel: {
      'claude-sonnet-4-6': { entries: 78, totalUsd: 0.91 },
      'claude-haiku-4-5': { entries: 18, totalUsd: 0.04 },
      'claude-opus-4-7': { entries: 4, totalUsd: 0.47 },
    },
    byAgent: {
      'coder-bridge': { entries: 22, totalUsd: 0.42 },
      'coder-trace-loader': { entries: 18, totalUsd: 0.18 },
    },
    cacheHitRatio: 0.84,
    windowStartedAt: '2026-05-09T08:00:00.000Z',
    windowEndedAt: '2026-05-09T22:30:00.000Z',
    ...overrides,
  };
}

/** Capture all stdout writes during a test block. */
function captureStdout(): {
  spy: ReturnType<typeof vi.spyOn>;
  read: () => string;
  restore: () => void;
} {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    spy,
    read: () => spy.mock.calls.map((c) => String(c[0])).join(''),
    restore: () => spy.mockRestore(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — formatUsd / formatTokens / formatPct / summarizeFromEntries.
// ---------------------------------------------------------------------------

describe('cost — format helpers', () => {
  it('formatUsd switches precision at $1', async () => {
    const { __test } = await import('../src/commands/cost.js');
    expect(__test.formatUsd(0.0001)).toBe('$0.0001');
    expect(__test.formatUsd(0.5)).toBe('$0.5000');
    expect(__test.formatUsd(0.9999)).toBe('$0.9999');
    expect(__test.formatUsd(1)).toBe('$1.00');
    expect(__test.formatUsd(1.42)).toBe('$1.42');
    expect(__test.formatUsd(1234.5)).toBe('$1234.50');
    // negatives clamp to 0
    expect(__test.formatUsd(-1)).toBe('$0.0000');
    // NaN / Infinity → 0
    expect(__test.formatUsd(NaN)).toBe('$0.0000');
  });

  it('formatTokens collapses to k/M suffixes', async () => {
    const { __test } = await import('../src/commands/cost.js');
    expect(__test.formatTokens(0)).toBe('0');
    expect(__test.formatTokens(999)).toBe('999');
    expect(__test.formatTokens(1000)).toBe('1.0k');
    expect(__test.formatTokens(1234)).toBe('1.2k');
    expect(__test.formatTokens(12_400)).toBe('12.4k');
    expect(__test.formatTokens(1_000_000)).toBe('1.00M');
    expect(__test.formatTokens(2_345_678)).toBe('2.35M');
    expect(__test.formatTokens(-5)).toBe('0');
  });

  it('formatPct rounds and clamps to [0,1]', async () => {
    const { __test } = await import('../src/commands/cost.js');
    expect(__test.formatPct(0)).toBe('0%');
    expect(__test.formatPct(0.84)).toBe('84%');
    expect(__test.formatPct(1)).toBe('100%');
    expect(__test.formatPct(1.5)).toBe('100%'); // clamped
    expect(__test.formatPct(-0.5)).toBe('0%'); // clamped
  });

  it('summarizeFromEntries reproduces shape of summarizeCosts', async () => {
    const { __test } = await import('../src/commands/cost.js');
    const entries = [
      sampleEntry({ timestamp: '2026-05-09T08:00:00.000Z', agent: 'coder-bridge' }),
      sampleEntry({
        timestamp: '2026-05-09T09:00:00.000Z',
        agent: 'coder-bridge',
        stepIndex: 1,
      }),
      sampleEntry({
        timestamp: '2026-05-09T10:00:00.000Z',
        agent: 'tester',
        model: 'claude-haiku-4-5',
      }),
    ];

    const s = __test.summarizeFromEntries(entries);
    expect(s.totalEntries).toBe(3);
    expect(s.totalUsd).toBeCloseTo(0.0249 * 3, 6);
    expect(s.byModel['claude-sonnet-4-6'].entries).toBe(2);
    expect(s.byModel['claude-haiku-4-5'].entries).toBe(1);
    expect(s.byAgent['coder-bridge'].entries).toBe(2);
    expect(s.byAgent['tester'].entries).toBe(1);
    expect(s.windowStartedAt).toBe('2026-05-09T08:00:00.000Z');
    expect(s.windowEndedAt).toBe('2026-05-09T10:00:00.000Z');
    // 3 entries × 8000 cacheRead / (3 × (1000 input + 8000 cacheRead + 2000 cacheCreation))
    // = 24000 / 33000 = 0.7272…
    expect(s.cacheHitRatio).toBeCloseTo(24000 / 33000, 4);
  });

  it('summarizeFromEntries handles empty input', async () => {
    const { __test } = await import('../src/commands/cost.js');
    const s = __test.summarizeFromEntries([]);
    expect(s.totalEntries).toBe(0);
    expect(s.totalUsd).toBe(0);
    expect(s.byModel).toEqual({});
    expect(s.byAgent).toEqual({});
    expect(s.cacheHitRatio).toBe(0);
    expect(s.windowStartedAt).toBeNull();
    expect(s.windowEndedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `cost stats` — calls summarizeCosts, renders, --json, --agent filter,
// empty-state.
// ---------------------------------------------------------------------------

describe('cost stats', () => {
  it('calls summarizeCosts with parsed --last and renders the table', async () => {
    mockSummarizeCosts.mockResolvedValueOnce(sampleSummary());
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.stats.action!(makeCtx([], { last: 50 }) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockSummarizeCosts).toHaveBeenCalledWith({ limit: 50 });
  });

  it('emits valid JSON with --json flag', async () => {
    const summary = sampleSummary();
    mockSummarizeCosts.mockResolvedValueOnce(summary);
    const cap = captureStdout();

    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.stats.action!(makeCtx([], { json: true }) as never);
    const written = cap.read();
    cap.restore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    const parsed = JSON.parse(written);
    expect(parsed.totalEntries).toBe(100);
    expect(parsed.totalUsd).toBe(1.42);
    expect(parsed.byModel['claude-sonnet-4-6'].entries).toBe(78);
    expect(parsed.cacheHitRatio).toBe(0.84);
  });

  it('--agent filters by listing then re-summarizing locally', async () => {
    mockListCosts.mockResolvedValueOnce([
      sampleEntry({ agent: 'coder-bridge', timestamp: '2026-05-09T08:00:00.000Z' }),
      sampleEntry({ agent: 'coder-bridge', timestamp: '2026-05-09T09:00:00.000Z' }),
    ]);
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.stats.action!(
      makeCtx([], { agent: 'coder-bridge', json: true }) as never,
    );

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    // summarizeCosts must NOT be called when --agent is in play.
    expect(mockSummarizeCosts).not.toHaveBeenCalled();
    // listCosts must have been called with the agent filter.
    expect(mockListCosts).toHaveBeenCalledWith({ agent: 'coder-bridge', limit: 100 });
  });

  it('shows friendly empty-state message when no data', async () => {
    mockSummarizeCosts.mockResolvedValueOnce(
      sampleSummary({
        totalEntries: 0,
        totalUsd: 0,
        byModel: {},
        byAgent: {},
        windowStartedAt: null,
        windowEndedAt: null,
      }),
    );
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.stats.action!(makeCtx() as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });

  it('clamps invalid --last to default', async () => {
    mockSummarizeCosts.mockResolvedValueOnce(sampleSummary());
    const { __testSubcommands } = await import('../src/commands/cost.js');
    await __testSubcommands.stats.action!(makeCtx([], { last: -5 }) as never);
    expect(mockSummarizeCosts).toHaveBeenCalledWith({ limit: 100 });
  });
});

// ---------------------------------------------------------------------------
// `cost session` — calls listCosts({sessionId}), `latest` resolves, friendly
// empty-state for missing id, table rendering, --json.
// ---------------------------------------------------------------------------

describe('cost session', () => {
  it('calls listCosts({sessionId}) when given an explicit id', async () => {
    mockListCosts.mockResolvedValueOnce([
      sampleEntry({ stepIndex: 0 }),
      sampleEntry({ stepIndex: 1, timestamp: '2026-05-09T08:01:00.000Z' }),
    ]);
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(makeCtx(['session-abc']) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockListCosts).toHaveBeenCalledWith({ sessionId: 'session-abc' });
  });

  it('"latest" resolves to the newest entry sessionId', async () => {
    mockListCosts
      // First call: full window for resolving 'latest'
      .mockResolvedValueOnce([
        sampleEntry({ sessionId: 'session-OLD', timestamp: '2026-05-09T07:00:00.000Z' }),
        sampleEntry({ sessionId: 'session-NEW', timestamp: '2026-05-09T22:00:00.000Z' }),
        sampleEntry({ sessionId: 'session-MID', timestamp: '2026-05-09T15:00:00.000Z' }),
      ])
      // Second call: filter on resolved sessionId
      .mockResolvedValueOnce([
        sampleEntry({ sessionId: 'session-NEW', timestamp: '2026-05-09T22:00:00.000Z' }),
      ]);

    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(makeCtx(['latest']) as never);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockListCosts).toHaveBeenCalledTimes(2);
    expect(mockListCosts.mock.calls[0][0]).toEqual({});
    expect(mockListCosts.mock.calls[1][0]).toEqual({ sessionId: 'session-NEW' });
  });

  it('"latest" with no sessions returns friendly empty-state', async () => {
    mockListCosts.mockResolvedValueOnce([]);
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(makeCtx(['latest']) as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });

  it('friendly empty-state for unknown session id', async () => {
    mockListCosts.mockResolvedValueOnce([]);
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(
      makeCtx(['session-doesnotexist']) as never,
    );
    expect(result).toMatchObject({ success: true, exitCode: 0 });
  });

  it('returns exit 1 when no session id is provided', async () => {
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(makeCtx([]) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(mockListCosts).not.toHaveBeenCalled();
  });

  it('--json emits an object with sessionId, count, totalUsd, entries', async () => {
    const entries = [
      sampleEntry({ stepIndex: 0 }),
      sampleEntry({ stepIndex: 1, timestamp: '2026-05-09T08:01:00.000Z' }),
    ];
    mockListCosts.mockResolvedValueOnce(entries);

    const cap = captureStdout();
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.session.action!(
      makeCtx(['session-abc'], { json: true }) as never,
    );
    const written = cap.read();
    cap.restore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    const parsed = JSON.parse(written);
    expect(parsed.sessionId).toBe('session-abc');
    expect(parsed.count).toBe(2);
    expect(parsed.totalUsd).toBeCloseTo(0.0249 * 2, 6);
    expect(parsed.entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// `cost models` — prints PRICING merged with override, --json.
// ---------------------------------------------------------------------------

describe('cost models', () => {
  it('prints PRICING entries (merged with empty override)', async () => {
    mockLoadPricingOverride.mockReturnValueOnce({});
    const cap = captureStdout();
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.models.action!(makeCtx() as never);
    const written = cap.read();
    cap.restore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(written).toContain('claude-sonnet-4-6');
    expect(written).toContain('claude-haiku-4-5');
  });

  it('--json emits the merged pricing table', async () => {
    mockLoadPricingOverride.mockReturnValueOnce({});
    const cap = captureStdout();
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.models.action!(makeCtx([], { json: true }) as never);
    const written = cap.read();
    cap.restore();

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    const parsed = JSON.parse(written);
    expect(parsed['claude-sonnet-4-6']).toBeDefined();
    expect(parsed['claude-sonnet-4-6'].inputPerMTok).toBe(3.00);
    expect(parsed['claude-haiku-4-5']).toBeDefined();
  });

  it('override overrides hard-coded entries with the same key', async () => {
    mockLoadPricingOverride.mockReturnValueOnce({
      'claude-sonnet-4-6': {
        inputPerMTok: 99,
        outputPerMTok: 99,
        cacheReadPerMTok: 99,
        cacheWrite5mPerMTok: 99,
        cacheWrite1hPerMTok: 99,
      },
    });
    const cap = captureStdout();
    const { __testSubcommands } = await import('../src/commands/cost.js');
    await __testSubcommands.models.action!(makeCtx([], { json: true }) as never);
    const written = cap.read();
    cap.restore();

    const parsed = JSON.parse(written);
    expect(parsed['claude-sonnet-4-6'].inputPerMTok).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// `cost reset` — without --force refuses, with --force calls resetCostStats.
// ---------------------------------------------------------------------------

describe('cost reset', () => {
  it('refuses without --force and does NOT call resetCostStats', async () => {
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.reset.action!(makeCtx() as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(mockResetCostStats).not.toHaveBeenCalled();
  });

  it('with --force calls resetCostStats and returns success', async () => {
    mockResetCostStats.mockResolvedValueOnce(undefined);
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.reset.action!(makeCtx([], { force: true }) as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(mockResetCostStats).toHaveBeenCalledTimes(1);
  });

  it('with --force surfaces a recorder error gracefully', async () => {
    mockResetCostStats.mockRejectedValueOnce(new Error('disk full'));
    const { __testSubcommands } = await import('../src/commands/cost.js');
    const result = await __testSubcommands.reset.action!(makeCtx([], { force: true }) as never);
    expect(result).toMatchObject({ success: false, exitCode: 1 });
  });
});

// ---------------------------------------------------------------------------
// Top-level `cost` command — prints help when invoked without subcommand.
// ---------------------------------------------------------------------------

describe('cost (top-level)', () => {
  it('prints help when invoked without a subcommand', async () => {
    const { costCommand } = await import('../src/commands/cost.js');
    const result = await costCommand.action!(makeCtx() as never);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(costCommand.subcommands?.map((s) => s.name).sort()).toEqual(
      ['models', 'reset', 'session', 'stats'],
    );
  });
});
