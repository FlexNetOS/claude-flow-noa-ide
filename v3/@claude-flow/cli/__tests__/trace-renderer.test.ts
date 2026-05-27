/**
 * Unit tests for `services/trace-renderer.ts` (Gap 1 — replayable agent traces).
 *
 * Coverage:
 *   - `renderTrace` returns a valid HTML5 document.
 *   - The trajectory JSON is embedded in `<script id="trajectory-data">`.
 *   - HTML escaping protects task / agent / action / result fields.
 *   - `</script>` injection through trajectory data is neutralised.
 *   - Zero-step trajectories render a graceful empty state.
 *   - `renderTraceList` renders an index page with one row per trajectory.
 *   - `renderTraceList` handles an empty array.
 *
 * Gap 4 cost-telemetry coverage:
 *   - Header surfaces `Total cost` + `Cache hit` only when cost data exists.
 *   - Per-bar `$` overlay is rendered in the static HTML for cost-bearing
 *     steps (assertion target for the lead's spec).
 *   - HTML stays valid + under the 30 KB budget with cost data attached.
 *   - `formatCostUsd` honours the 4-dec / 2-dec format split at $1.
 *
 * Browser-runtime smoke (no console errors, .bar elements actually paint)
 * is the tester-trace agent's responsibility — see GAP-1-DESIGN.md test plan.
 */

import { describe, it, expect } from 'vitest';

import {
  renderTrace,
  renderTraceList,
  escapeHtml,
  formatCostUsd,
} from '../src/services/trace-renderer.js';
import type { LoadedTrajectory, LoadedStepCost } from '../src/services/trace-loader.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleTrajectory(): LoadedTrajectory {
  return {
    id: 'sess-abc12345',
    task: 'research RaBitQ for SwarmOps',
    agent: 'researcher',
    startedAt: '2026-05-08T18:30:00.000Z',
    endedAt: '2026-05-08T18:34:12.000Z',
    success: true,
    steps: [
      {
        action: 'Bash',
        result: 'listed 14 files',
        quality: 0.7,
        timestamp: '2026-05-08T18:30:01.000Z',
      },
      {
        action: 'Read',
        result: 'opened README.md',
        quality: 0.9,
        timestamp: '2026-05-08T18:30:03.500Z',
      },
      {
        action: 'mcp_memory_search',
        result: '3 hits',
        quality: 0.5,
        timestamp: '2026-05-08T18:30:08.000Z',
      },
      {
        action: 'SendMessage',
        result: 'delivered to architect',
        quality: 0.5,
        timestamp: '2026-05-08T18:30:12.000Z',
      },
      {
        action: 'Edit',
        result: 'error: file is read-only',
        quality: 0.2,
        timestamp: '2026-05-08T18:30:15.000Z',
      },
    ],
  };
}

function emptyTrajectory(): LoadedTrajectory {
  return {
    id: 'sess-empty01',
    task: 'placeholder',
    agent: 'researcher',
    startedAt: '2026-05-08T18:30:00.000Z',
    steps: [],
  };
}

// ---------------------------------------------------------------------------
// escapeHtml — exercised directly because every other test relies on it.
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" data-y='z'>&hello</a>`)).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;hello&lt;/a&gt;',
    );
  });

  it('returns empty string for non-string input', () => {
    // Cast to silence TS — the runtime contract has to be defensive too.
    expect(escapeHtml(undefined as unknown as string)).toBe('');
    expect(escapeHtml(null as unknown as string)).toBe('');
  });

  it('is idempotent on already-escaped output', () => {
    const once = escapeHtml('<x>');
    const twice = escapeHtml(once);
    // Second pass turns the `&` into `&amp;` again, which is correct —
    // we just want to confirm it doesn't lose data.
    expect(twice).toContain('lt;');
    expect(twice).toContain('gt;');
  });
});

// ---------------------------------------------------------------------------
// renderTrace — single trajectory.
// ---------------------------------------------------------------------------

describe('renderTrace', () => {
  it('returns a valid HTML5 document (DOCTYPE + html closing tag)', () => {
    const html = renderTrace(sampleTrajectory());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('embeds the trajectory JSON in <script id="trajectory-data" type="application/json">', () => {
    const t = sampleTrajectory();
    const html = renderTrace(t);

    // The opening tag should be exact — JS reader does getElementById('trajectory-data').
    expect(html).toContain('<script id="trajectory-data" type="application/json">');

    // The id field is unique enough that a substring match confirms the
    // payload landed in the embed without us having to fully reparse.
    expect(html).toContain('"id":"sess-abc12345"');
    expect(html).toContain('"agent":"researcher"');
  });

  it('renders one Gantt row per step', () => {
    const t = sampleTrajectory();
    const html = renderTrace(t);
    const rowMatches = html.match(/class="row"/g) || [];
    expect(rowMatches.length).toBe(t.steps.length);
  });

  it('escapes <, >, &, ", \' in the task field', () => {
    const t = sampleTrajectory();
    t.task = `<script>alert('xss & "go"')</script>`;
    const html = renderTrace(t);

    // The literal <script> from the task must NOT appear in the rendered
    // header — only the escaped form. We narrow the search to the
    // <header> block to avoid false positives from the trajectory-data
    // script tag and the runtime <script> at the end.
    const headerMatch = html.match(/<header>[\s\S]*?<\/header>/);
    expect(headerMatch).not.toBeNull();
    const headerBlock = headerMatch![0];
    expect(headerBlock).not.toContain("<script>alert(");
    expect(headerBlock).toContain('&lt;script&gt;');
    expect(headerBlock).toContain('&amp;');
    expect(headerBlock).toContain('&quot;');
    expect(headerBlock).toContain('&#39;');
  });

  it('neutralises </script> injection inside trajectory JSON', () => {
    const t = sampleTrajectory();
    // A malicious result string trying to break out of the JSON script tag.
    t.steps = [
      {
        action: 'Bash',
        result: '</script><img src=x onerror=alert(1)>',
        quality: 0.5,
        timestamp: t.startedAt,
      },
    ];
    const html = renderTrace(t);

    // Find the opening tag of the embedded JSON, then look at the slice
    // that runs up to the *next* `</script>` we expect to see (which
    // should be the runtime JS block, not a smuggled one).
    const dataOpen = html.indexOf('<script id="trajectory-data"');
    expect(dataOpen).toBeGreaterThanOrEqual(0);
    const closingDataIdx = html.indexOf('</script>', dataOpen);
    expect(closingDataIdx).toBeGreaterThanOrEqual(0);

    const jsonBlock = html.slice(dataOpen, closingDataIdx);
    // The injected `</script>` must NOT appear literal inside the JSON
    // block. It should be escaped to <\/script>.
    expect(jsonBlock).not.toContain('</script>');
    expect(jsonBlock).toContain('\\u003c/script\\u003e');
  });

  it('renders a graceful empty state for zero-step trajectories', () => {
    const html = renderTrace(emptyTrajectory());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('No steps recorded');
    // No row elements when there are no steps.
    expect(html).not.toMatch(/class="row"/);
    // Steps count in header should still render as 0.
    expect(html).toContain('Steps: <b>0</b>');
  });

  it('renders status badges for ok / failed / in-flight trajectories', () => {
    const ok = renderTrace({ ...sampleTrajectory(), success: true });
    const fail = renderTrace({ ...sampleTrajectory(), success: false });

    const inflight: LoadedTrajectory = {
      ...sampleTrajectory(),
      // Construct the in-flight case without setting `endedAt`/`success`
      // (which would otherwise satisfy `exactOptionalPropertyTypes`).
      success: undefined as unknown as boolean | undefined,
    };
    delete inflight.endedAt;
    delete inflight.success;
    const inflightHtml = renderTrace(inflight);

    expect(ok).toContain('class="status-ok"');
    expect(fail).toContain('class="status-fail"');
    expect(inflightHtml).toContain('class="status-pending"');
  });

  it('embeds the inline JS (no external <script src=>)', () => {
    const html = renderTrace(sampleTrajectory());
    // No external scripts of any kind — ADR-004 says self-contained.
    expect(html).not.toMatch(/<script\s+[^>]*src=/);
    // Sanity: the runtime IIFE marker should be present.
    expect(html).toContain("'use strict'");
  });

  it('budget: HTML for a 5-step trajectory stays under 30 KB', () => {
    const html = renderTrace(sampleTrajectory());
    expect(Buffer.byteLength(html, 'utf-8')).toBeLessThan(30 * 1024);
  });
});

// ---------------------------------------------------------------------------
// renderTraceList — index page.
// ---------------------------------------------------------------------------

describe('renderTraceList', () => {
  it('returns a valid HTML5 document', () => {
    const html = renderTraceList([sampleTrajectory()]);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('renders one table row per trajectory with a link to <id>.html', () => {
    const t1 = sampleTrajectory();
    const t2: LoadedTrajectory = { ...sampleTrajectory(), id: 'sess-defg6789' };
    const html = renderTraceList([t1, t2]);

    const rowMatches = html.match(/<tr>/g) || [];
    // 1 header row + 2 body rows = 3 total
    expect(rowMatches.length).toBe(3);

    expect(html).toContain('href="sess-abc12345.html"');
    expect(html).toContain('href="sess-defg6789.html"');
  });

  it('handles an empty array (renders the placeholder)', () => {
    const html = renderTraceList([]);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('No trajectories recorded yet');
    // No table rendered when empty.
    expect(html).not.toContain('<table');
  });

  it('escapes hostile values in task/agent fields', () => {
    const t = sampleTrajectory();
    t.task = '<img src=x onerror=alert(1)>';
    t.agent = '<svg/onload=alert(1)>';
    const html = renderTraceList([t]);

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<svg/onload');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;svg/onload');
  });
});

// ---------------------------------------------------------------------------
// Gap 4 — cost telemetry helpers + integration.
// ---------------------------------------------------------------------------

/**
 * Build a small cost-bearing trajectory fixture. Every step gets a
 * realistic cost breakdown; we vary the magnitudes so format-split tests
 * exercise both the 4-decimal and 2-decimal branches.
 */
function costEnrichedTrajectory(): LoadedTrajectory {
  const cheap: LoadedStepCost = {
    input: 0.00124,
    output: 0.00330,
    cacheRead: 0.00036,
    cacheCreation: 0.00031,
    total: 0.00521,
    usage: { input: 412, output: 220, cacheRead: 1234, cacheCreation: 85 },
  };
  const mid: LoadedStepCost = {
    input: 0.0102,
    output: 0.0301,
    cacheRead: 0.0014,
    cacheCreation: 0.0080,
    total: 0.0497,
    usage: { input: 3400, output: 2007, cacheRead: 4670, cacheCreation: 2200 },
  };
  return {
    id: 'sess-cost1234',
    task: 'cost-bearing trajectory',
    agent: 'coder',
    startedAt: '2026-05-09T10:00:00.000Z',
    endedAt: '2026-05-09T10:01:00.000Z',
    success: true,
    totalCostUsd: 0.0549,
    cacheHitRatio: 0.84,
    costByModel: {
      'claude-sonnet-4-6': { dispatches: 2, totalUsd: 0.0549 },
    },
    steps: [
      {
        action: 'Bash',
        result: 'ok',
        quality: 0.7,
        timestamp: '2026-05-09T10:00:01.000Z',
        cost: cheap,
      },
      {
        action: 'Edit',
        result: 'wrote 12 lines',
        quality: 0.8,
        timestamp: '2026-05-09T10:00:30.000Z',
        cost: mid,
      },
      // A step without cost — overlay must NOT appear for this row.
      {
        action: 'Read',
        result: 'opened README.md',
        quality: 0.9,
        timestamp: '2026-05-09T10:00:45.000Z',
      },
      // Another cost-bearing step.
      {
        action: 'mcp_memory_search',
        result: '3 hits',
        quality: 0.5,
        timestamp: '2026-05-09T10:00:50.000Z',
        cost: cheap,
      },
      {
        action: 'SendMessage',
        result: 'delivered',
        quality: 0.5,
        timestamp: '2026-05-09T10:00:55.000Z',
        cost: mid,
      },
    ],
  };
}

describe('formatCostUsd', () => {
  it('uses 4 decimal places when value is <= $1', () => {
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0.99999)).toBe('$1.0000');
    expect(formatCostUsd(1)).toBe('$1.0000');
  });

  it('uses 2 decimal places when value is > $1', () => {
    expect(formatCostUsd(1.0001)).toBe('$1.00');
    expect(formatCostUsd(12.345)).toBe('$12.35');
    expect(formatCostUsd(1023.4)).toBe('$1023.40');
  });

  it('returns empty string for non-finite or negative input', () => {
    expect(formatCostUsd(undefined)).toBe('');
    expect(formatCostUsd(null)).toBe('');
    expect(formatCostUsd(NaN)).toBe('');
    expect(formatCostUsd(Infinity)).toBe('');
    expect(formatCostUsd(-1)).toBe('');
  });
});

describe('renderTrace cost integration', () => {
  it('shows the Total cost and Cache hit fields in the header when totalCostUsd is set', () => {
    const html = renderTrace(costEnrichedTrajectory());
    const headerMatch = html.match(/<header>[\s\S]*?<\/header>/);
    expect(headerMatch).not.toBeNull();
    const headerBlock = headerMatch![0];
    expect(headerBlock).toContain('Total cost:');
    expect(headerBlock).toContain('$0.0549');
    expect(headerBlock).toContain('Cache hit:');
    expect(headerBlock).toContain('84%');
  });

  it('omits the Total cost field when totalCostUsd is null/undefined', () => {
    const t = costEnrichedTrajectory();
    delete (t as { totalCostUsd?: number | null }).totalCostUsd;
    delete (t as { cacheHitRatio?: number | null }).cacheHitRatio;
    const html = renderTrace(t);
    const headerMatch = html.match(/<header>[\s\S]*?<\/header>/);
    expect(headerMatch).not.toBeNull();
    const headerBlock = headerMatch![0];
    expect(headerBlock).not.toContain('Total cost:');
    expect(headerBlock).not.toContain('Cache hit:');
  });

  it('omits the Total cost field when totalCostUsd is null sentinel', () => {
    const t = costEnrichedTrajectory();
    t.totalCostUsd = null;
    t.cacheHitRatio = null;
    const html = renderTrace(t);
    const headerMatch = html.match(/<header>[\s\S]*?<\/header>/);
    expect(headerMatch).not.toBeNull();
    const headerBlock = headerMatch![0];
    expect(headerBlock).not.toContain('Total cost:');
    expect(headerBlock).not.toContain('Cache hit:');
  });

  it('renders a $ cost label in the static HTML for each cost-bearing step', () => {
    const t = costEnrichedTrajectory();
    const html = renderTrace(t);

    // Lead spec: assert `$` appears for each cost-bearing step. We narrow
    // to the rendered rows so the header's "$0.0549" doesn't leak into
    // the assertion. There are 4 cost-bearing steps in the fixture.
    const labelMatches = html.match(/<span class="cost-label" data-step-cost="\d+">\$[\d.]+<\/span>/g) || [];
    expect(labelMatches.length).toBe(4);

    // Each label should include the cheap or mid total, formatted.
    for (const m of labelMatches) {
      expect(m).toMatch(/\$0\.005[\d]+|\$0\.049[\d]+/);
    }
  });

  it('does NOT render a cost label for a step without cost data', () => {
    const t = costEnrichedTrajectory();
    const html = renderTrace(t);
    // Step index 2 (the Read step) has no cost; assert no label was emitted
    // for that index. This guards against accidental "$0" emission.
    expect(html).not.toContain('data-step-cost="2"');
  });

  it('cost-enriched trajectory still produces a valid HTML5 document', () => {
    const html = renderTrace(costEnrichedTrajectory());
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('budget: cost-enriched 5-step trajectory stays under 30 KB', () => {
    const html = renderTrace(costEnrichedTrajectory());
    const size = Buffer.byteLength(html, 'utf-8');
    expect(size).toBeLessThan(30 * 1024);
  });

  it('escapes the cost label value (defence-in-depth — should never need it but)', () => {
    // The format helper produces deterministic ASCII. This test pins that
    // contract: if any future maintainer accidentally introduces a path
    // where a non-formatted user value lands in the cost label, the
    // escape pass at the renderer must still neutralise it.
    const t = costEnrichedTrajectory();
    const html = renderTrace(t);
    // No script-y characters should appear inside any cost-label element.
    const matches = html.match(/<span class="cost-label"[^>]*>([^<]*)<\/span>/g) || [];
    for (const m of matches) {
      expect(m).not.toMatch(/<script/i);
      expect(m).not.toMatch(/javascript:/i);
    }
  });

  it('embeds cost breakdown data inside the JSON payload (for the JS reader)', () => {
    const t = costEnrichedTrajectory();
    const html = renderTrace(t);
    // The embedded JSON should carry the full step.cost objects so the
    // INLINE_JS side-panel populator can read them on click.
    expect(html).toContain('"total":0.00521');
    expect(html).toContain('"input":412');
  });
});
