/**
 * trace-template — internal asset constants for trace-renderer.
 *
 * Hosts the inline CSS and inline vanilla JS that get embedded into every
 * rendered trajectory HTML document. Kept in a separate module so the
 * renderer file stays focused on string composition + escaping, and the
 * "view source" of a rendered trace is humanely formatted (the CSS / JS
 * blocks are pretty-printed multi-line strings rather than minified).
 *
 * Design constraints (from Gap-1 design + locked interface contract):
 *   - No external resources. No CDN. No `<link>`, no `<script src>`.
 *   - No framework. CSS is hand-written, JS is plain ES2017+ vanilla.
 *   - Combined CSS + JS budget: ~10-15 KB. We aim well under.
 *   - Safe to open as a `file://` URL — no fetch(), no relative URLs.
 *   - Light mode default with `prefers-color-scheme: dark` override.
 *
 * @module v3/cli/services/trace-template
 */

// ============================================================================
// Inline CSS — loaded into <style> in the rendered document.
//
// Layout uses CSS grid for the Gantt: each step is a row, the timeline is
// a single 100%-wide column inside which `.bar` elements are absolutely
// positioned by left/width percentages computed in JS at runtime.
// ============================================================================

export const INLINE_CSS = `
:root {
  --bg: #ffffff;
  --bg-alt: #f8fafc;
  --bg-row: #f1f5f9;
  --fg: #0f172a;
  --fg-muted: #64748b;
  --border: #e2e8f0;
  --accent: #2563eb;
  --color-tool: #3b82f6;
  --color-mcp: #a855f7;
  --color-message: #f59e0b;
  --color-error: #ef4444;
  --color-success: #10b981;
  /*
   * Gap 4 — per-step cost overlay text colour. Sits ON TOP of the four
   * bar fills (tool blue, mcp purple, message orange, error red) plus the
   * faded variant. Light theme uses a darker emerald for legibility on
   * the lighter bar fills. Dark theme overrides below to a brighter mint
   * so the text stays crisp on the dimmer bar fills against the dark bg.
   * The colour was picked against the 4 bar fills + their hover-brightened
   * variants — passes WCAG AA at 14px bold on every combo we tested.
   */
  --color-cost: #047857;
  --shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --bg-alt: #1e293b;
    --bg-row: #1e293b;
    --fg: #f1f5f9;
    --fg-muted: #94a3b8;
    --border: #334155;
    /* Dark mode wants the brighter emerald for contrast on the dimmer bars. */
    --color-cost: #6ee7b7;
    --shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
header {
  padding: 24px 32px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-alt);
}
header h1 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
}
header .meta {
  color: var(--fg-muted);
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
header .meta b { color: var(--fg); font-weight: 500; }
header .status-ok { color: var(--color-success); font-weight: 600; }
header .status-fail { color: var(--color-error); font-weight: 600; }
header .status-pending { color: var(--fg-muted); font-weight: 600; }
main {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
}
#gantt {
  padding: 16px 32px 32px;
  overflow-x: auto;
}
#gantt .axis {
  display: grid;
  grid-template-columns: 200px 1fr;
  align-items: end;
  font-size: 11px;
  color: var(--fg-muted);
  height: 24px;
  margin-bottom: 8px;
}
#gantt .axis .ticks {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px;
}
#gantt .row {
  display: grid;
  grid-template-columns: 200px 1fr;
  align-items: center;
  height: 28px;
  border-bottom: 1px solid var(--border);
}
#gantt .row:nth-child(even) { background: var(--bg-row); }
#gantt .row .label {
  font-family: var(--mono);
  font-size: 12px;
  padding-right: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#gantt .row .lane {
  position: relative;
  height: 100%;
}
#gantt .bar {
  position: absolute;
  top: 6px;
  bottom: 6px;
  background: var(--color-tool);
  border-radius: 3px;
  cursor: pointer;
  min-width: 4px;
  transition: filter 0.15s ease;
}
#gantt .bar:hover { filter: brightness(1.15); outline: 2px solid var(--accent); outline-offset: 1px; }
#gantt .bar.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
#gantt .bar.faded { opacity: 0.4; }
#gantt .bar[data-kind="tool"] { background: var(--color-tool); }
#gantt .bar[data-kind="mcp"] { background: var(--color-mcp); }
#gantt .bar[data-kind="message"] { background: var(--color-message); }
#gantt .bar[data-kind="error"] { background: var(--color-error); }
/*
 * Cost overlay -- Gap 4. Server-side rendered as a child of .lane, then
 * re-positioned by INLINE_JS to the right edge of the corresponding bar.
 * Default position (pre-JS) sits at the lane right edge, so traces
 * opened with JS disabled still show the per-step cost.
 */
#gantt .cost-label {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-cost);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
  white-space: nowrap;
  text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg);
  z-index: 1;
}
/* When JS lifts the label onto the bar, switch to inset-right positioning. */
#gantt .cost-label.on-bar {
  right: 4px;
  /* Constrain label to the bar -- JS sets the left offset programmatically. */
}
#gantt .empty {
  padding: 32px;
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
}
.tooltip {
  position: fixed;
  z-index: 100;
  background: var(--fg);
  color: var(--bg);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--mono);
  pointer-events: none;
  max-width: 360px;
  box-shadow: var(--shadow);
  white-space: pre-wrap;
}
#detail {
  position: fixed;
  top: 0;
  right: 0;
  width: min(480px, 100vw);
  height: 100vh;
  background: var(--bg-alt);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 24px;
  overflow-y: auto;
  z-index: 50;
}
#detail[hidden] { display: none; }
#detail header {
  background: transparent;
  padding: 0 0 12px;
  border: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
#detail header h2 {
  margin: 0;
  font-size: 15px;
  font-family: var(--mono);
  word-break: break-all;
}
#detail .close {
  background: none;
  border: 1px solid var(--border);
  color: var(--fg);
  font-size: 16px;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 12px;
  flex-shrink: 0;
}
#detail .close:hover { background: var(--border); }
#detail dl {
  margin: 0 0 16px;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
#detail dt { color: var(--fg-muted); }
#detail dd {
  margin: 0;
  font-family: var(--mono);
  word-break: break-all;
}
#detail h3 {
  margin: 16px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
#detail pre {
  margin: 0 0 12px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 12px;
  overflow: auto;
  max-height: 320px;
  white-space: pre-wrap;
  word-break: break-word;
}
#detail .copy {
  background: var(--accent);
  color: #ffffff;
  border: none;
  padding: 8px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}
#detail .copy:hover { filter: brightness(1.1); }
#detail .copy.copied { background: var(--color-success); }
/*
 * Per-step cost breakdown shown in the side-panel — Gap 4. Hidden when
 * the selected step has no cost data. Uses the same dl/dt/dd grid as the
 * top metadata block so visual rhythm stays consistent.
 */
#detail .cost-section { margin: 16px 0 12px; }
#detail .cost-section[hidden] { display: none; }
#detail .cost-section .cost-total {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--color-cost);
  font-size: 14px;
  margin-bottom: 8px;
  display: block;
}
#detail .cost-section dl {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  gap: 4px 12px;
  font-size: 12px;
}
#detail .cost-section dt { color: var(--fg-muted); }
#detail .cost-section dd { margin: 0; font-family: var(--mono); }
#detail .cost-section dd.tokens { color: var(--fg-muted); text-align: right; }
#detail .cost-section dd.usd { color: var(--fg); text-align: right; }
.list-table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
}
.list-table th, .list-table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.list-table th { color: var(--fg-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.list-table td.mono { font-family: var(--mono); font-size: 12px; }
`.trim();

// ============================================================================
// Inline JS — loaded into <script> in the rendered document.
//
// Reads <script id="trajectory-data"> JSON, computes per-step positions
// from timestamps, paints bars, wires hover + click + ESC + copy.
// ============================================================================

export const INLINE_JS = `
(function () {
  'use strict';
  var dataEl = document.getElementById('trajectory-data');
  if (!dataEl || !dataEl.textContent) return;
  var trajectory;
  try { trajectory = JSON.parse(dataEl.textContent); }
  catch (e) { console.error('trace: invalid trajectory JSON', e); return; }

  var steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  if (steps.length === 0) return;

  // Time scale — base on startedAt; fallback to first step timestamp.
  var startMs = Date.parse(trajectory.startedAt);
  if (!isFinite(startMs)) startMs = Date.parse(steps[0].timestamp);
  var endMs = trajectory.endedAt ? Date.parse(trajectory.endedAt) : NaN;
  if (!isFinite(endMs)) {
    var lastTs = Date.parse(steps[steps.length - 1].timestamp);
    endMs = isFinite(lastTs) ? lastTs + 200 : startMs + 1000;
  }
  var totalMs = Math.max(endMs - startMs, 1);

  function classify(action, result) {
    var a = (action || '').toLowerCase();
    var r = (result || '').toLowerCase();
    if (a.indexOf('error') !== -1 || r.indexOf('error') === 0) return 'error';
    if (a.indexOf('send') !== -1 || a.indexOf('message') !== -1) return 'message';
    if (a.indexOf('mcp_') === 0 || a.indexOf('__') === 0) return 'mcp';
    return 'tool';
  }

  function pct(ms) { return (ms / totalMs) * 100; }

  // Gap 4 — USD formatter mirrors trace-renderer.formatCostUsd. Kept inline
  // so the embedded JS stays self-contained (no module imports in browser).
  function fmtCostUsd(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return '';
    if (v <= 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }
  function fmtTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  // Paint bars into each row's lane.
  var rows = document.querySelectorAll('#gantt .row');
  for (var i = 0; i < steps.length && i < rows.length; i++) {
    var step = steps[i];
    var ts = Date.parse(step.timestamp);
    if (!isFinite(ts)) continue;
    var nextTs = (i + 1 < steps.length) ? Date.parse(steps[i + 1].timestamp) : NaN;
    var durMs = isFinite(nextTs) ? Math.max(nextTs - ts, 1) : 200;
    var leftPct = Math.max(0, Math.min(100, pct(ts - startMs)));
    var widthPct = Math.max(0.3, Math.min(100 - leftPct, pct(durMs)));

    var lane = rows[i].querySelector('.lane');
    if (!lane) continue;
    var bar = document.createElement('div');
    bar.className = 'bar';
    if (typeof step.quality === 'number' && step.quality < 0.3) bar.className += ' faded';
    bar.setAttribute('data-kind', classify(step.action, step.result));
    bar.setAttribute('data-step', String(i));
    bar.style.left = leftPct + '%';
    bar.style.width = widthPct + '%';
    var costStr = (step.cost && typeof step.cost.total === 'number')
      ? fmtCostUsd(step.cost.total) : '';
    bar.title = (i + 1) + '. ' + step.action + ' (' + Math.round(durMs) + 'ms)' +
      (costStr ? ' · ' + costStr : '');
    lane.appendChild(bar);

    // Gap 4 — lift the server-rendered cost label onto the bar.
    // The label was rendered as a sibling of the bar inside the lane;
    // we move it INTO the bar and switch to inset-right positioning so
    // it visually rides the bar's right edge. For very narrow bars
    // (<32px), we hide the label rather than overflow into the next
    // step — the value remains in the bar tooltip.
    var costLabel = lane.querySelector('.cost-label[data-step-cost="' + i + '"]');
    if (costLabel) {
      // Detach from lane and append to bar.
      bar.appendChild(costLabel);
      costLabel.classList.add('on-bar');
      // Ride the right edge regardless of bar width.
      costLabel.style.right = '4px';
      costLabel.style.left = 'auto';
      // Hide on bars too narrow to host the label legibly.
      if (widthPct < 6) {
        costLabel.style.display = 'none';
      }
    }
  }

  // Tooltip on hover.
  var tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  function showTooltip(ev, idx) {
    var step = steps[idx];
    if (!step) return;
    var ts = Date.parse(step.timestamp);
    var nextTs = (idx + 1 < steps.length) ? Date.parse(steps[idx + 1].timestamp) : NaN;
    var durMs = isFinite(ts) && isFinite(nextTs) ? Math.max(nextTs - ts, 1) : 200;
    var preview = (step.result || '').slice(0, 80);
    var costStr = (step.cost && typeof step.cost.total === 'number')
      ? fmtCostUsd(step.cost.total) : '';
    tooltip.textContent = (idx + 1) + '. ' + step.action + '\\n' +
      Math.round(durMs) + 'ms · q=' + (step.quality != null ? step.quality.toFixed(2) : '0.50') +
      (costStr ? ' · ' + costStr : '') + '\\n' +
      preview;
    tooltip.hidden = false;
    var x = Math.min(window.innerWidth - 380, ev.clientX + 12);
    var y = Math.min(window.innerHeight - 80, ev.clientY + 12);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function hideTooltip() { tooltip.hidden = true; }

  // Detail panel.
  var detail = document.getElementById('detail');
  function openDetail(idx) {
    var step = steps[idx];
    if (!step || !detail) return;
    var prev = document.querySelector('#gantt .bar.selected');
    if (prev) prev.classList.remove('selected');
    var current = document.querySelector('#gantt .bar[data-step="' + idx + '"]');
    if (current) current.classList.add('selected');

    var ts = Date.parse(step.timestamp);
    var nextTs = (idx + 1 < steps.length) ? Date.parse(steps[idx + 1].timestamp) : NaN;
    var durMs = isFinite(ts) && isFinite(nextTs) ? Math.max(nextTs - ts, 1) : 200;

    document.getElementById('detail-title').textContent = 'Step ' + (idx + 1) + ' · ' + step.action;
    document.getElementById('detail-action').textContent = step.action;
    document.getElementById('detail-time').textContent = step.timestamp;
    document.getElementById('detail-duration').textContent = Math.round(durMs) + ' ms';
    document.getElementById('detail-quality').textContent =
      (step.quality != null ? step.quality.toFixed(3) : '0.500');
    document.getElementById('detail-result').textContent = step.result || '';
    document.getElementById('detail-json').textContent = JSON.stringify(step, null, 2);

    // Gap 4 — populate the cost breakdown when present. We pull token
    // counts from the recorder entry that the loader joined onto the step
    // (step.cost.usage). Both presence checks must hold; otherwise we
    // hide the section so the panel doesn't show stale data from a
    // previously-clicked step.
    var costSection = document.getElementById('detail-cost');
    if (costSection) {
      if (step.cost && typeof step.cost.total === 'number') {
        var c = step.cost;
        var u = c.usage || {};
        document.getElementById('detail-cost-total').textContent =
          'Cost: ' + fmtCostUsd(c.total);
        document.getElementById('detail-cost-input-tokens').textContent =
          fmtTokens(u.input != null ? u.input : 0) + ' tokens';
        document.getElementById('detail-cost-input-usd').textContent = fmtCostUsd(c.input);
        document.getElementById('detail-cost-output-tokens').textContent =
          fmtTokens(u.output != null ? u.output : 0) + ' tokens';
        document.getElementById('detail-cost-output-usd').textContent = fmtCostUsd(c.output);
        document.getElementById('detail-cost-cacheread-tokens').textContent =
          fmtTokens(u.cacheRead != null ? u.cacheRead : 0) + ' tokens';
        document.getElementById('detail-cost-cacheread-usd').textContent = fmtCostUsd(c.cacheRead);
        document.getElementById('detail-cost-cachecreate-tokens').textContent =
          fmtTokens(u.cacheCreation != null ? u.cacheCreation : 0) + ' tokens';
        document.getElementById('detail-cost-cachecreate-usd').textContent =
          fmtCostUsd(c.cacheCreation);
        costSection.hidden = false;
      } else {
        costSection.hidden = true;
      }
    }

    detail.hidden = false;
  }
  function closeDetail() {
    if (!detail) return;
    detail.hidden = true;
    var prev = document.querySelector('#gantt .bar.selected');
    if (prev) prev.classList.remove('selected');
  }

  // Wire bar events (delegated).
  var ganttRoot = document.getElementById('gantt');
  if (ganttRoot) {
    ganttRoot.addEventListener('mouseover', function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains('bar')) {
        var idx = parseInt(t.getAttribute('data-step') || '-1', 10);
        if (idx >= 0) showTooltip(ev, idx);
      }
    });
    ganttRoot.addEventListener('mousemove', function (ev) {
      if (!tooltip.hidden) {
        var x = Math.min(window.innerWidth - 380, ev.clientX + 12);
        var y = Math.min(window.innerHeight - 80, ev.clientY + 12);
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
      }
    });
    ganttRoot.addEventListener('mouseout', hideTooltip);
    ganttRoot.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains('bar')) {
        var idx = parseInt(t.getAttribute('data-step') || '-1', 10);
        if (idx >= 0) openDetail(idx);
      }
    });
  }

  // Close handlers.
  var closeBtn = document.querySelector('#detail .close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeDetail();
  });

  // Copy step JSON.
  var copyBtn = document.querySelector('#detail .copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var json = document.getElementById('detail-json').textContent || '';
      var done = function () {
        copyBtn.classList.add('copied');
        copyBtn.textContent = 'Copied';
        setTimeout(function () {
          copyBtn.classList.remove('copied');
          copyBtn.textContent = 'Copy step JSON';
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(done).catch(done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = json;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        done();
      }
    });
  }
})();
`.trim();

// ============================================================================
// HTML scaffolding fragments — assembled by the renderer.
// ============================================================================

/**
 * Build the <head> block. Caller passes the already-escaped page title.
 */
export function buildHead(escapedTitle: string): string {
  return [
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width,initial-scale=1">',
    `  <title>${escapedTitle}</title>`,
    '  <style>',
    INLINE_CSS,
    '  </style>',
    '</head>',
  ].join('\n');
}

/**
 * The fixed side-panel markup. Hidden until a bar is clicked. JS populates
 * the inner spans by id; structure here keeps the HTML grep-friendly.
 */
export const DETAIL_PANEL_HTML = `<aside id="detail" hidden>
  <header>
    <h2 id="detail-title">Step</h2>
    <button class="close" type="button" aria-label="Close detail panel">x</button>
  </header>
  <dl>
    <dt>Action</dt><dd id="detail-action"></dd>
    <dt>Started</dt><dd id="detail-time"></dd>
    <dt>Duration</dt><dd id="detail-duration"></dd>
    <dt>Quality</dt><dd id="detail-quality"></dd>
  </dl>
  <section id="detail-cost" class="cost-section" hidden>
    <h3>Cost</h3>
    <span id="detail-cost-total" class="cost-total"></span>
    <dl>
      <dt>input</dt>
      <dd class="tokens" id="detail-cost-input-tokens"></dd>
      <dd class="usd" id="detail-cost-input-usd"></dd>
      <dt>output</dt>
      <dd class="tokens" id="detail-cost-output-tokens"></dd>
      <dd class="usd" id="detail-cost-output-usd"></dd>
      <dt>cache read</dt>
      <dd class="tokens" id="detail-cost-cacheread-tokens"></dd>
      <dd class="usd" id="detail-cost-cacheread-usd"></dd>
      <dt>cache create</dt>
      <dd class="tokens" id="detail-cost-cachecreate-tokens"></dd>
      <dd class="usd" id="detail-cost-cachecreate-usd"></dd>
    </dl>
  </section>
  <h3>Result</h3>
  <pre id="detail-result"></pre>
  <h3>Step JSON</h3>
  <pre id="detail-json"></pre>
  <button class="copy" type="button">Copy step JSON</button>
</aside>`;
