/**
 * trace-renderer — `LoadedTrajectory` -> self-contained HTML5 string.
 *
 * Why this module exists
 * ----------------------
 * Gap 1 (replayable agent traces) ships a `swarmops trace replay` CLI that
 * writes a static HTML file the user opens in any browser — no server, no
 * CDN, no build step. This module is the pure-function transformer in the
 * middle: take a parsed trajectory from {@link ./trace-loader.ts}, return
 * a complete HTML5 document as a string. The CLI handles disk I/O.
 *
 * Contract (locked — coder-trace-cli imports `renderTrace`):
 *   - renderTrace(t)          -> single-trajectory Gantt swimlane HTML
 *   - renderTraceList(items)  -> index page listing many trajectories
 *
 * Implementation rules (from Gap-1 design + ADR-004):
 *   - Pure string concatenation. No JSX, no template engine.
 *   - All assets inline (CSS, JS, JSON). No external resources of any kind.
 *   - HTML-escape every interpolated user value. The trajectory JSON is
 *     embedded inside `<script type="application/json">` and is
 *     additionally guarded against `</script>` injection.
 *   - Indented + line-broken output so "view source" is comprehensible.
 *
 * @module v3/cli/services/trace-renderer
 */

import type { LoadedTrajectory } from './trace-loader.js';
import { INLINE_JS, DETAIL_PANEL_HTML, buildHead } from './trace-template.js';

// ============================================================================
// HTML escaping
// ============================================================================

/**
 * Escape the five HTML metacharacters. Used for any value that lands in
 * element text or attribute context. We do NOT use this for the embedded
 * trajectory JSON — that path uses {@link safeJson}, which is a stricter
 * guard against `</script>` injection.
 */
export function escapeHtml(str: string): string {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize a value for embedding in `<script type="application/json">`.
 * The JSON spec doesn't escape `<` or `>`, so a `result` field containing
 * the literal text `</script>` would prematurely terminate the script
 * block. We escape `<`, `>`, and U+2028 / U+2029 (which break some parsers
 * even though strict JSON allows them).
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ============================================================================
// Header summary helpers
// ============================================================================

/**
 * Format the trajectory header `started` field. Falls back to the raw
 * string if `Date.parse` can't parse it — we never throw on bad input.
 */
function formatStarted(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  // YYYY-MM-DD HH:MM:SS in local time. Avoids the noisy ISO Z suffix
  // while keeping the output sortable / unambiguous.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Compute trajectory duration in `m:ss` form. Returns `'—'` for in-flight
 * trajectories (no `endedAt`) or unparseable timestamps.
 */
function formatDuration(t: LoadedTrajectory): string {
  if (typeof t.endedAt !== 'string') return '—';
  const start = Date.parse(t.startedAt);
  const end = Date.parse(t.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * Render the success / failure / pending status as an inline span. Kept
 * separate so the markup is consistent across renderTrace and
 * renderTraceList.
 */
function renderStatusBadge(t: LoadedTrajectory): string {
  if (t.success === true) return '<span class="status-ok">ok</span>';
  if (t.success === false) return '<span class="status-fail">failed</span>';
  return '<span class="status-pending">in-flight</span>';
}

/**
 * Truncate long action labels for the swimlane row. Keeps the leading
 * tool / event name visible — that's the most useful identifying signal.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ============================================================================
// Cost formatting helpers (Gap 4)
// ============================================================================

/**
 * Format a USD value for the trace UI.
 *
 * Spec (from GAP-4-DESIGN.md / lead handoff):
 *   - <= $1.00  -> 4 decimal places ("$0.0042")
 *   - >  $1.00  -> 2 decimal places ("$1.23")
 *
 * Negative or NaN values fall through to the empty string so the renderer
 * can omit the field entirely without conditional plumbing at every site.
 */
export function formatCostUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value <= 1) return '$' + value.toFixed(4);
  return '$' + value.toFixed(2);
}

/**
 * Format a cache-hit ratio (0..1) as an integer percentage with the `%`
 * suffix, e.g. `0.84` -> `'84%'`. Returns the empty string for non-finite
 * or out-of-range inputs so the caller can omit the field cleanly.
 */
function formatCachePct(ratio: number | null | undefined): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) return '';
  return Math.round(ratio * 100) + '%';
}

// ============================================================================
// Gantt body
// ============================================================================

/**
 * Build the time-axis tick labels. Always 5 evenly-spaced ticks across
 * the lane (0 .. total). Uses seconds with a 1-decimal place when total
 * is under 10s, else whole seconds.
 *
 * @returns the inner HTML for `<div class="ticks">`
 */
function renderAxisTicks(totalMs: number): string {
  const ticks: string[] = [];
  const useDecimal = totalMs < 10_000;
  for (let i = 0; i < 5; i++) {
    const ms = (totalMs * i) / 4;
    const sec = ms / 1000;
    const label = useDecimal ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
    ticks.push(`<span>${escapeHtml(label)}</span>`);
  }
  return ticks.join('');
}

/**
 * Compute the total trajectory window in milliseconds. Mirrors the
 * runtime logic in trace-template.INLINE_JS so axis ticks line up with
 * the rendered bars.
 */
function computeTotalMs(t: LoadedTrajectory): number {
  let startMs = Date.parse(t.startedAt);
  if (!Number.isFinite(startMs) && t.steps.length > 0) {
    startMs = Date.parse(t.steps[0]!.timestamp);
  }
  if (!Number.isFinite(startMs)) startMs = 0;

  let endMs = typeof t.endedAt === 'string' ? Date.parse(t.endedAt) : NaN;
  if (!Number.isFinite(endMs)) {
    if (t.steps.length > 0) {
      const lastTs = Date.parse(t.steps[t.steps.length - 1]!.timestamp);
      endMs = Number.isFinite(lastTs) ? lastTs + 200 : startMs + 1000;
    } else {
      endMs = startMs + 1000;
    }
  }
  return Math.max(endMs - startMs, 1);
}

/**
 * Render the Gantt swimlane body — one `<div class="row">` per step.
 * Bars themselves are appended at runtime by INLINE_JS so the position /
 * width math lives in one place (the JS) and we don't duplicate it
 * server-side.
 */
function renderGantt(t: LoadedTrajectory): string {
  if (t.steps.length === 0) {
    return '<div id="gantt"><div class="empty">No steps recorded for this trajectory.</div></div>';
  }
  const totalMs = computeTotalMs(t);

  const rows: string[] = [];
  for (let i = 0; i < t.steps.length; i++) {
    const step = t.steps[i]!;
    const label = `${i + 1}. ${truncate(step.action, 24)}`;

    // Gap 4 — per-step cost overlay. Server-side we render the cost text
    // in a `<span class="cost-label">` inside the lane. INLINE_JS later
    // moves this span ONTO the bar (positioned at the bar's right edge)
    // once it has computed the bar geometry. Rendering server-side has
    // two wins: (1) `$` appears in the static HTML so screenshot/test
    // tooling sees it, (2) graceful degradation for `file://` opens with
    // JS disabled — the cost text is still visible in the row.
    let costFragment = '';
    if (step.cost) {
      const costText = formatCostUsd(step.cost.total);
      if (costText) {
        costFragment =
          `<span class="cost-label" data-step-cost="${i}">${escapeHtml(costText)}</span>`;
      }
    }

    rows.push(
      `      <div class="row" data-step="${i}">` +
        `<div class="label" title="${escapeHtml(step.action)}">${escapeHtml(label)}</div>` +
        `<div class="lane">${costFragment}</div>` +
        `</div>`,
    );
  }

  return [
    '<div id="gantt">',
    '  <div class="axis">',
    '    <div></div>',
    `    <div class="ticks">${renderAxisTicks(totalMs)}</div>`,
    '  </div>',
    '  <div class="rows">',
    rows.join('\n'),
    '  </div>',
    '</div>',
  ].join('\n');
}

// ============================================================================
// Header
// ============================================================================

function renderHeader(t: LoadedTrajectory): string {
  const lines: string[] = [
    '<header>',
    `  <h1>SwarmOps trace: ${escapeHtml(t.task || '(no task)')}</h1>`,
    '  <div class="meta">',
    `    <span>Session: <b>${escapeHtml(t.id)}</b></span>`,
    `    <span>Started <b>${escapeHtml(formatStarted(t.startedAt))}</b></span>`,
    `    <span>Duration <b>${escapeHtml(formatDuration(t))}</b></span>`,
    `    <span>Agent: <b>${escapeHtml(t.agent || '(unknown)')}</b></span>`,
    `    <span>Steps: <b>${t.steps.length}</b></span>`,
    `    <span>Status: ${renderStatusBadge(t)}</span>`,
  ];

  // Gap 4 — cost telemetry. Both fields are gated on data presence so
  // pre-Gap-4 trajectories render exactly as before.
  const costStr = formatCostUsd(t.totalCostUsd);
  if (costStr) {
    lines.push(`    <span>Total cost: <b class="cost-total">${escapeHtml(costStr)}</b></span>`);
  }
  const cachePct = formatCachePct(t.cacheHitRatio);
  if (cachePct) {
    lines.push(`    <span>Cache hit: <b>${escapeHtml(cachePct)}</b></span>`);
  }

  lines.push('  </div>', '</header>');
  return lines.join('\n');
}

// ============================================================================
// Public API — single trajectory
// ============================================================================

/**
 * Render a trajectory as a complete self-contained HTML5 document.
 * Pure function: same input -> same output. Safe to call repeatedly.
 *
 * The returned string starts with `<!DOCTYPE html>` and contains a single
 * top-level `<html>` element. Caller writes it to disk verbatim.
 */
export function renderTrace(t: LoadedTrajectory): string {
  const title = `SwarmOps trace: ${t.task || t.id}`;
  const head = buildHead(escapeHtml(title));
  const headerHtml = renderHeader(t);
  const ganttHtml = renderGantt(t);
  const dataJson = safeJson(t);

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    head,
    '<body>',
    headerHtml,
    '<main>',
    ganttHtml,
    '</main>',
    DETAIL_PANEL_HTML,
    '<script id="trajectory-data" type="application/json">',
    dataJson,
    '</script>',
    '<script>',
    INLINE_JS,
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ============================================================================
// Public API — index of many trajectories
// ============================================================================

/**
 * Render a sortable index page listing many trajectories. Each row links
 * to a sibling `<id>.html` file (the convention used by `swarmops trace
 * list --html`). Self-contained; reuses the same INLINE_CSS for visual
 * consistency with single-trajectory pages.
 *
 * Empty input is handled gracefully — the page renders with an
 * "(no trajectories)" placeholder.
 */
export function renderTraceList(items: LoadedTrajectory[]): string {
  const title = `SwarmOps traces (${items.length})`;
  const head = buildHead(escapeHtml(title));

  let body: string;
  if (items.length === 0) {
    body = '<div class="empty">No trajectories recorded yet.</div>';
  } else {
    const rows = items
      .map((t) => {
        const idCell = `<a href="${escapeHtml(t.id)}.html">${escapeHtml(t.id)}</a>`;
        return [
          '    <tr>',
          `      <td class="mono">${idCell}</td>`,
          `      <td>${escapeHtml(t.task || '(no task)')}</td>`,
          `      <td class="mono">${escapeHtml(t.agent || '(unknown)')}</td>`,
          `      <td class="mono">${escapeHtml(formatStarted(t.startedAt))}</td>`,
          `      <td class="mono">${escapeHtml(formatDuration(t))}</td>`,
          `      <td>${t.steps.length}</td>`,
          `      <td>${renderStatusBadge(t)}</td>`,
          '    </tr>',
        ].join('\n');
      })
      .join('\n');

    body = [
      '<table class="list-table">',
      '  <thead><tr>',
      '    <th>Session</th><th>Task</th><th>Agent</th>',
      '    <th>Started</th><th>Duration</th><th>Steps</th><th>Status</th>',
      '  </tr></thead>',
      '  <tbody>',
      rows,
      '  </tbody>',
      '</table>',
    ].join('\n');
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    head,
    '<body>',
    '<header>',
    `  <h1>${escapeHtml(title)}</h1>`,
    `  <div class="meta"><span><b>${items.length}</b> trajectories</span></div>`,
    '</header>',
    '<main style="padding: 16px 32px 32px;">',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
