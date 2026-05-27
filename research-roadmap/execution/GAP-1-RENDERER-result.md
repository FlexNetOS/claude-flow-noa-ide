# Gap 1 Renderer Result

## Files created

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/services/trace-renderer.ts` —
  pure-function transformer `LoadedTrajectory -> HTML5 string`. Exports
  `renderTrace(t)` (single-trajectory Gantt) and `renderTraceList(items)`
  (index page). Also re-exports `escapeHtml` for adjacent callers / tests.
- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/services/trace-template.ts` —
  internal asset module. Exports `INLINE_CSS`, `INLINE_JS`, `DETAIL_PANEL_HTML`,
  and a small `buildHead(escapedTitle)` helper. Not part of the public surface.
- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/__tests__/trace-renderer.test.ts` —
  16 vitest unit tests covering escaping, JSON embedding, `</script>`
  injection, empty trajectories, status badges, the no-external-resources
  invariant, the index page, and the bundle-size budget.

## HTML structure

- `<!DOCTYPE html>` + `<html lang="en">`.
- `<head>` with charset + viewport + escaped title + inline `<style>`
  carrying `INLINE_CSS`.
- `<header>` block: H1 task line, then a `meta` row with session id,
  started timestamp (formatted local-time `YYYY-MM-DD HH:MM:SS`),
  duration `m:ss` (or `—` for in-flight), agent, step count, and a
  status badge (`ok` / `failed` / `in-flight`).
- `<main>` containing `<div id="gantt">`:
  - axis row with the agent-label gutter (200px) + 5 evenly-spaced time
    ticks; tick units adapt (1-decimal seconds when total < 10s, else
    whole seconds).
  - one `<div class="row">` per step. Each row holds a label
    (`N. <action-truncated-to-24-chars>`) and an empty `<div class="lane">`
    that the runtime JS paints bars into.
  - Empty-state placeholder (`<div class="empty">No steps recorded…</div>`)
    when `t.steps.length === 0`.
- `<aside id="detail" hidden>` side panel: title row with close button,
  `<dl>` of action / time / duration / quality, full `result` `<pre>`,
  full step-JSON `<pre>`, and a "Copy step JSON" button.
- `<script id="trajectory-data" type="application/json">` block with the
  full trajectory serialized via the `safeJson` guard (escapes `<`, `>`,
  U+2028, U+2029 so a hostile `result` containing `</script>` cannot
  break out).
- Final `<script>` block carrying the inline runtime IIFE that reads the
  JSON, computes per-step left/width percentages, paints bars, and wires
  hover tooltips, click-to-detail, ESC-to-close, and clipboard copy.
- Color encoding follows the spec: `data-kind="tool"` (blue),
  `"mcp"` (purple), `"message"` (orange), `"error"` (red); quality < 0.3
  reduces opacity to 0.4.
- Light/dark theme via `prefers-color-scheme: dark` media query, all
  colors in CSS variables.

## Inline asset sizes

- CSS: 242 lines / 5660 bytes (~5.5 KB)
- JS: 173 lines / 7034 bytes (~6.9 KB)
- CSS + JS combined: ~12.4 KB (target was 10–15 KB ✓)
- Total HTML for 5-step trajectory: 15491 bytes (~15.1 KB; budget < 30 KB ✓)
- Source files: trace-renderer.ts 333 lines (11.4 KB),
  trace-template.ts 496 lines (15.5 KB), test file 271 lines (10.0 KB)

## Tests

- 16 unit tests, all passing.
- Coverage:
  - `escapeHtml`: escapes 5 metacharacters, handles non-string input,
    idempotent on already-escaped output (3 tests)
  - `renderTrace`: valid HTML5 doc shape, JSON embedding, one row per
    step, task-field XSS escape, `</script>` injection neutralised in
    embedded JSON, empty-state for zero-step trajectory, status badges
    for ok/failed/in-flight, no external `<script src=>`, 30 KB budget
    (9 tests)
  - `renderTraceList`: valid HTML5, one row per trajectory with link to
    `<id>.html`, empty-array placeholder, hostile-input escaping (4 tests)
- `npx tsc --noEmit -p .` runs clean for both new files (the only
  remaining tsc error is in `commands/trace.ts`, owned by
  `coder-trace-cli` — not in scope here).

## Notes

- **Locked contract honoured**: `renderTrace(t: LoadedTrajectory): string`
  and `renderTraceList(items: LoadedTrajectory[]): string`. Imports the
  type from `./trace-loader.js` (which `coder-trace-loader` has shipped).
  No other contact surface with `trace-loader.ts`.
- **`</script>` injection guard**: `JSON.stringify` does not escape `<` or
  `>`, so a `result` field containing the literal text `</script>` would
  prematurely terminate the embedded data block. `safeJson()` post-processes
  the JSON to escape `<`, `>`, U+2028, U+2029 with the standard `\u00xx`
  / `\u20xx` JSON escape forms — fully reversible by the runtime
  `JSON.parse`. Tested explicitly with a malicious-result fixture.
- **U+2028 / U+2029 in source**: TS lexer treats these as line
  terminators, so they cannot appear inside a regex literal in the
  source file. The regexes use ` ` / ` ` escapes; verified by
  running `tsc --noEmit` clean.
- **Bar rendering happens at runtime, not server-side**: the renderer
  emits empty `<div class="lane">` placeholders and the inline JS
  computes left/width percentages from timestamps. Single source of
  truth for layout math. The server-side axis-tick labels still reflect
  the same `computeTotalMs()` window logic so axis and bars line up.
- **Long task names + Unicode in actions**: rendered text is HTML-escaped
  but otherwise passed through verbatim; CSS `text-overflow: ellipsis`
  on the row label handles wide displays. The action gets truncated to
  24 chars in the row label but the full action is in the `title=""`
  attribute and in the side panel.
- **In-flight trajectories**: `endedAt`/`success` are optional. Renderer
  shows duration as `—` and the badge as `in-flight`. The runtime JS
  falls back to `lastStep.timestamp + 200ms` for the time-window upper
  bound so bars render correctly even mid-execution.
- **Single-trajectory v1 only**: the design notes multi-trajectory as
  Gap 1.5. `renderTraceList` covers the index/listing case (a separate
  entry point used by `swarmops trace list --html`), not multi-agent
  swimlane mode.
- **No external resources**: no `<link>`, no `<script src>`, no `fetch()`,
  no remote fonts. Tested via the regex `/<script\s+[^>]*src=/`. ADR-004
  intent preserved.
- **No commit / no push** (per task instructions). Lead reviews before
  push.
