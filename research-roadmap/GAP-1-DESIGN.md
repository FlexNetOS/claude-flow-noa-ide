# Gap 1 — Replayable Agent Traces (Design Spec)

**Status**: Design ready for review. No code yet.
**Effort estimate**: 5-8 dev-days, single-coder swarm.
**Output when shipped**: `swarmops trace replay <session-id>` CLI that opens a static HTML Gantt swimlane in the user's default browser. Static file, no server, no CDN deps. Works offline.

---

## Why this feature

From `02-competitive-landscape.md` Gap 1 finding: **no Claude Code orchestrator ships replayable concurrent-agent traces**. LangSmith does it for LangGraph, Braintrust does model-level only. Anthropic Agent Teams: nothing. Ruflo upstream: trajectory data is captured but never exposed.

This is the cheapest Tier 2 differentiation feature:
- **Data already exists** — `hooks-tools.ts:439` defines `TrajectoryData` and step events get written to `~/.claude/.claude-flow/memory/store.json` keyed `trajectory-*`
- **Zero competitor coverage** — LangSmith costs $39/seat, this would be free OSS
- **Screenshottable** — perfect asset for the eventual bug-hunt blog post
- **Survives upstream merge** — even if PR #1828 lands, this is a SwarmOps-only feature

---

## What exists today (the input)

Per `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`:

```typescript
interface TrajectoryStep {
  action: string;     // tool name OR event type ("hooks_pre-task", "Edit", "SendMessage")
  result: string;     // outcome string (success message OR error)
  quality: number;    // 0-1 quality score (currently mostly 0.5 default)
  timestamp: string;  // ISO 8601
}

interface TrajectoryData {
  id: string;             // unique session/trajectory id
  task: string;           // task description ("research RaBitQ for SwarmOps")
  agent: string;          // agent name ("coder-bridge", "researcher", ...)
  steps: TrajectoryStep[];
  startedAt: string;
  endedAt?: string;       // present once trajectory-end fires
  success?: boolean;      // present once trajectory-end fires
}
```

Storage: `~/.claude/.claude-flow/memory/store.json`, entries keyed `trajectory-*` OR with `metadata.type === 'trajectory'`.

**Gaps in current data** (worth noting for the implementation):
- No parent/child agent linkage — when `coder-bridge` SendMessages to `tester`, there's no edge in the trajectory data tying them. The current data is per-agent only.
- `quality` defaults to 0.5; not yet a signal worth visualizing prominently.
- Step `action` is a free string — no enum, no taxonomy.

We'll work with what exists; deferred enhancement = Gap 1.5 ("trajectory edges + typed actions").

---

## CLI surface

**New command**: `swarmops trace`

```
swarmops trace list                          # list available sessions, newest first
swarmops trace list --since "1 hour ago"    # date filter
swarmops trace replay <session-id>           # render HTML, print path
swarmops trace replay <session-id> --open    # render HTML + xdg-open / open
swarmops trace replay <session-id> --json    # emit raw trajectory JSON instead of HTML
swarmops trace prune --older-than "30 days" # cleanup old HTML renders
```

`<session-id>` accepts: full id, prefix (8+ chars), or `latest` shorthand.

Output paths:
- HTML: `~/.claude/.claude-flow/traces/<session-id>.html`
- JSON: stdout (for piping)

---

## HTML output structure

**One self-contained `<html>` document per session.** No external resources. CSS inline. JS inline (vanilla, no framework). Goal: opens in any browser, archivable, emailable.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ SwarmOps trace: <task>                                      │
│ Session: <id>  ·  Started 2026-05-08 21:30  ·  Duration 4m12s│
│ Agents: 3  ·  Steps: 47  ·  Success: ✅                     │
├─────────────────────────────────────────────────────────────┤
│         0:00     1:00      2:00      3:00      4:00         │
│         |        |         |         |         |            │
│ coder-1 ████░░░░░██████░░░░░██░░░██████░░██░░░░             │
│ coder-2 ░░░░██████████████░░░░██░░░░██████████░░             │
│ tester  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██████████░          │
└─────────────────────────────────────────────────────────────┘

[Hover over any bar shows: tool name, duration, result preview]
[Click expands: full action + full result, scrollable, copy-to-clipboard]
```

### Visual encoding

| Field | Encoding |
|---|---|
| Agent | swimlane row |
| Time (X axis) | absolute time, scaled to fit viewport |
| Step duration | bar width (next step's timestamp − this step's timestamp) |
| Step type | bar color: tool=blue, MCP=purple, SendMessage=orange, error=red |
| Quality | bar opacity (low quality = faded) |
| Success/failure | bar border (green=ok, red=error) |

### Interaction

- **Hover**: tooltip with `action`, `duration_ms`, `result_preview` (first 80 chars)
- **Click bar**: side panel slides in with full step JSON, syntax-highlighted
- **Click agent label**: filter to that agent only (toggle)
- **Top-right "Copy session JSON"** button for easy bug reports

---

## Implementation plan

### File layout

```
v3/@claude-flow/cli/src/commands/trace.ts        # new — CLI subcommand impl
v3/@claude-flow/cli/src/services/trace-loader.ts # new — query memory store
v3/@claude-flow/cli/src/services/trace-renderer.ts # new — TrajectoryData → HTML string
v3/@claude-flow/cli/src/services/trace-template.ts # new — HTML/CSS/JS template constants
v3/@claude-flow/cli/__tests__/commands-trace.test.ts # new — unit + golden-HTML tests
```

Existing files modified:
- `v3/@claude-flow/cli/src/commands/index.ts` — register the `trace` command
- (none in `mcp-tools/hooks-tools.ts` — we read from the existing memory store, no schema change needed)

### Renderer approach

Pure string concatenation. No JSX, no template engine. The HTML is ~200 lines of inline CSS + ~100 lines of vanilla JS + a `<script id="trajectory-data" type="application/json">` block holding the raw trajectory.

```typescript
function renderTrace(t: TrajectoryData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SwarmOps trace: ${escapeHtml(t.task)}</title>
  <style>${INLINE_CSS}</style>
</head>
<body>
  <header>...</header>
  <div id="gantt"></div>
  <aside id="detail-panel" hidden></aside>
  <script id="trajectory-data" type="application/json">
    ${JSON.stringify(t)}
  </script>
  <script>${INLINE_JS}</script>
</body>
</html>`;
}
```

JS reads the embedded JSON, computes positions, draws the SVG-inline Gantt. ~80 lines max.

### Multi-trajectory mode (stretch)

If `<session-id>` matches multiple trajectories (e.g. parent agent + spawned subagents share a session prefix), render all in one Gantt — one swimlane per agent. This is the "killer screenshot" version and what enables the screenshots for the blog post.

Detection: trajectories that started within ±2 min of each other AND share a `metadata.parentSessionId` field (which we'd add to the trajectory creation logic in `hooks-tools.ts`).

For v1: just render single-trajectory. Multi-trajectory = follow-up.

---

## Test plan

1. **Unit**: `renderTrace(sampleTrajectory)` returns a valid HTML5 document (parse via `htmlparser2`)
2. **Golden**: snapshot the HTML output against a known-good fixture (regenerate with explicit `--update-snapshots`)
3. **Integration**: `swarmops trace replay latest` exits 0, file exists at expected path, contains the trajectory JSON
4. **Browser smoke** (manual, documented in test): open the HTML in Chromium headless, assert no console errors, assert at least one `.bar` element rendered

---

## Open design choices for user input

| Choice | Recommendation | Alternative |
|---|---|---|
| Render in pure HTML or vendor a library (e.g. `vis-timeline`) | **Pure HTML** — keeps the artifact archivable, no version drift | Vendor library = prettier output, ~50KB extra |
| Single-trajectory or multi-trajectory v1 | **Single v1, multi as Gap 1.5** — ships faster, single is the 80% use case | Multi v1 = bigger demo but +3-5 days |
| `--open` default ON or OFF | **OFF (just print path)** — respects users on headless boxes | ON is more iPhone-y |
| Where to store rendered HTML | `~/.claude/.claude-flow/traces/<sid>.html` | Per-project `.claude-flow/traces/` |
| Color scheme | Light mode default with `prefers-color-scheme: dark` media query | Force dark, force light, or auto-detect terminal palette |

---

## Effort breakdown

| Task | Effort |
|---|---|
| Trace-loader (query memory store, parse JSON, return `TrajectoryData[]`) | 1 day |
| HTML/CSS/JS template (Gantt rendering logic) | 2 days |
| CLI subcommand wiring (`trace list`, `replay`, `prune`) | 1 day |
| Tests (unit + golden + integration) | 1 day |
| Documentation (README section + `swarmops trace --help`) | 0.5 day |
| **Total** | **5.5 days** |

---

## What I'd dispatch as a swarm

If approved, the execution swarm would be:

| Agent | Scope |
|---|---|
| `coder-trace-loader` | trace-loader.ts + golden test fixture |
| `coder-trace-renderer` | trace-renderer.ts + trace-template.ts + browser smoke test |
| `coder-trace-cli` | trace.ts CLI + commands/index.ts registration + integration test |
| `tester-trace` | wait for all 3 → run full suite → write swarmops-trace-replay.test.ts |

Same coordination pattern that worked for Tier 1: independent file ownership, no overlap, fan-out then aggregate. Estimated ~6-8 dev-days wall-clock with 4 agents in parallel = ~2 days actual time.
