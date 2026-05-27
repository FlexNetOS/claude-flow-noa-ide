# Gap 4 — Per-Agent Cost Telemetry (Design Spec)

**Status**: Design ready for review. No code yet.
**Effort estimate (v1)**: 5-7 dev-days, single-coder-or-2-coder swarm.
**Output when shipped**: `swarmops cost stats / session / models` CLI surface that records per-dispatch token usage, computes USD cost via a hard-coded pricing table (config-overridable), and surfaces it in both the trace viewer header and a standalone command. v1.5 (deferred): per-step cost annotations on the Gantt bars + predictive `swarmops cost estimate "<task>"`.

---

## Why this feature

Per `02-competitive-landscape.md` Gap 4 finding:

> A single 49-subagent run cost one user $8k–$15k; another team burned $47k in 3 days. Anthropic Agent Teams shows aggregate session cost but not per-agent or per-tool-call attribution. No competitor warns "this swarm topology will cost ~$X on Max-20x" before kicking off.

Pairs naturally with Gap 1 (replayable agent traces): the trace viewer already shows what each step did; cost telemetry tells you what each step COST. Same Gantt chart, two data dimensions. This is the marketing screenshot Bet B's blog post needs ("look at this 7-agent swarm — here's exactly which agent burned which $$").

Also defensible: every other Tier 2 alternative is invisible (perf wins, daemon hardening, local-model fallback). Cost telemetry is the most directly user-facing Tier 2 feature.

---

## What exists today (the inputs)

The Tier 0/1 prompt-cache work (commit `cd44c55f8`) already captures every piece of data we need from Anthropic's API:

```typescript
// v3/@claude-flow/cli/src/mcp-tools/agent-execute-core.ts:405-442
{
  usage: {
    input_tokens,                  // raw input tokens
    output_tokens,                 // raw output tokens
    cache_read_input_tokens,       // came from cache (cheaper)
    cache_creation_input_tokens,   // wrote to cache (more expensive)
  },
  model: 'claude-sonnet-4-6'       // resolved at dispatch
}
```

Plus persistence infrastructure already exists at `cache-stats.json` — exact same architecture, just records cache hit ratios. Gap 4 v1 = "cache-stats but for cost." We can clone the persistence pattern directly.

Trajectory data also exists (Gap 1 reads it back): each `TrajectoryStep` has `{ action, result, quality, timestamp }`. Adding `cost` to that schema unlocks per-step cost in the trace viewer (v1.5).

---

## v1 scope (5-7 days, ships as one feature commit)

### CLI surface

```bash
swarmops cost stats                      # rolling-100 summary (USD aggregate, by model, hit ratio)
swarmops cost stats --json               # machine-readable
swarmops cost stats -n 50                # last N dispatches

swarmops cost session <session-id>       # full cost breakdown for a session
swarmops cost session latest             # newest by startedAt

swarmops cost models                     # show pricing table currently in use
swarmops cost models --override <path>   # one-off use of custom pricing JSON

swarmops cost reset                      # clear cost-stats.json (with --force)
```

### Persistence

`~/.claude/.claude-flow/cost-stats.json` — same parent dir as `cache-stats.json`. Schema:

```json
{
  "rollingWindow": 100,
  "entries": [
    {
      "timestamp": "2026-05-08T22:00:00.000Z",
      "sessionId": "abc123",
      "agent": "coder-bridge",
      "model": "claude-sonnet-4-6",
      "tokens": {
        "input": 1532,
        "output": 482,
        "cacheRead": 8421,
        "cacheCreation": 2300
      },
      "costUsd": {
        "input": 0.00459,
        "output": 0.00723,
        "cacheRead": 0.00253,
        "cacheCreation": 0.01380,
        "total": 0.02815
      }
    }
    // ... up to 100 most recent
  ]
}
```

### Pricing table (hard-coded, config-overridable)

`v3/@claude-flow/cli/src/services/pricing.ts`:

```typescript
export interface ModelPricing {
  inputPerMTok: number;       // $/MTok input
  outputPerMTok: number;      // $/MTok output
  cacheReadPerMTok: number;   // $/MTok cache read (typically 10% of input)
  cacheWrite5mPerMTok: number;  // $/MTok cache write @ 5min TTL (1.25x input)
  cacheWrite1hPerMTok: number;  // $/MTok cache write @ 1h TTL (2x input)
}

// Anthropic pricing as of 2026-05-08
export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':       { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30.00 },
  'claude-sonnet-4-6':     { inputPerMTok:  3.00, outputPerMTok: 15.00, cacheReadPerMTok: 0.30, cacheWrite5mPerMTok:  3.75, cacheWrite1hPerMTok:  6.00 },
  'claude-haiku-4-5':      { inputPerMTok:  1.00, outputPerMTok:  5.00, cacheReadPerMTok: 0.10, cacheWrite5mPerMTok:  1.25, cacheWrite1hPerMTok:  2.00 },
  // (legacy 3.5 / 3-opus aliases kept for backward compat)
};

export function priceFor(model: string): ModelPricing | null;
export function computeCostUsd(usage: TokenUsage, model: string, ttl: '5m' | '1h'): CostBreakdown | null;
```

Override via `~/.claude/.claude-flow/pricing-override.json` — same key shape, missing models fall through to the hard-coded table.

### Instrumentation point

In `agent-execute-core.ts`, at the existing usage-parsing site (line 405-442), add:

```typescript
import { recordCost } from '../services/cost-recorder.js';

// inside callAnthropicMessages, after usage parsing:
await recordCost({
  sessionId: input.sessionId ?? null,
  agent: input.agentName ?? 'unknown',
  model: response.model,
  ttl: '1h', // currently always 1h via the cache_control beta
  usage: {
    input: data.usage.input_tokens,
    output: data.usage.output_tokens,
    cacheRead: data.usage.cache_read_input_tokens ?? 0,
    cacheCreation: data.usage.cache_creation_input_tokens ?? 0,
  },
});
```

`recordCost()` writes to `cost-stats.json`, computes USD via `pricing.ts`, swallows errors. Same failure-tolerance as `cache-stats` (broken persistence never breaks a dispatch).

### Trace viewer integration

In `services/trace-renderer.ts`, the existing header line that shows "Session: ... · Started ... · Duration ... · Steps: N" gets a new field:

```
Session: abc123 · Started 22:00 · Duration 4m12s · Steps: 47 · Cost: $0.18 · Cache hit: 84%
```

Cost is computed at render time by re-walking `cost-stats.json` and summing entries matching the trajectory's `sessionId`. If no cost data exists for the session (older traces, recording wasn't on), the field omits gracefully.

### Tests

`__tests__/cost-recorder.test.ts`:
- recordCost writes valid entry to cost-stats.json
- Rolling window caps at 100 entries (oldest pruned)
- Pricing-table override loads correctly
- Unknown model returns null cost (entry recorded with cost=null, never throws)
- Cache-write TTL routes to correct rate
- Persistence failure swallows (call returns successfully)

`__tests__/commands-cost.test.ts`:
- `cost stats` reads + aggregates correctly
- `cost session <id>` filters by sessionId
- `cost stats --json` emits valid JSON
- `cost models` prints the pricing table
- `cost reset --force` empties the file

---

## v1.5 scope (deferred to follow-up — 1-2 weeks)

Not in v1 to keep scope tight. Tracked here so the v1 design doesn't preclude:

- **Per-step cost annotations** in trace bars (requires adding `cost?: number` to TrajectoryStep schema + recording at the SendMessage / agent-dispatch granularity, not just per Anthropic call)
- **Predictive `swarmops cost estimate "<task>"`** — needs typical-token-usage modeling per task class (small/medium/large), or a quick ML lookup. Could leverage memory bridge's pattern store ("similar past tasks averaged $X").
- **Multi-model breakdown** in stats — group costs by model, show which model is burning the most
- **Cost budgeting / threshold warnings** — "swarm running into $5/min, 3x your average — abort?"

---

## Open design choices for user input

| Choice | Recommendation | Alternative |
|---|---|---|
| v1 granularity | **Per-dispatch (per Anthropic call)** | Per-step (cleaner UX in trace viewer but needs schema changes to TrajectoryStep) |
| Pricing source | **Hard-coded table + JSON override** | Pull from a remote endpoint (kills offline use) |
| Cost in trace HTML header | **Aggregate session cost** | Per-bar annotations (defer to v1.5) |
| Failure mode | **Silent (swallowError)** | Hard-fail dispatch on persistence error (kills resilience) |
| Default rolling window size | **100** (matches cache-stats) | 1000 (more data, larger file) |

---

## Effort breakdown

| Task | Effort |
|---|---|
| `services/pricing.ts` + override loader + tests | 0.5 day |
| `services/cost-recorder.ts` + persistence + tests | 1 day |
| Wire `recordCost` into `agent-execute-core.ts` (single call site) | 0.25 day |
| `commands/cost.ts` (stats / session / models / reset) + tests | 1.5 days |
| `commands/index.ts` registration | 0.25 day |
| Trace renderer header integration + tests | 0.5 day |
| Documentation (README section + `swarmops cost --help`) | 0.5 day |
| **Total** | **4.5 days** |

Add ~1 day buffer for integration discovery (e.g. existing `enhanced-model-router.ts:381,438` already has an `estimatedCost` field — does that conflict?). Realistic estimate: **5-7 dev-days wall-clock with parallel execution = ~3 hours actual time.**

---

## What I'd dispatch as a swarm

| Agent | Scope |
|---|---|
| `coder-pricing` | services/pricing.ts + tests; pricing override loader |
| `coder-cost-recorder` | services/cost-recorder.ts + persistence + tests; one-line wire-in to agent-execute-core.ts |
| `coder-cost-cli` | commands/cost.ts + commands/index.ts registration + tests |
| `coder-trace-cost` | trace-renderer.ts header field + tests |

Same coordination pattern as Gap 1: locked interface contracts in each prompt, fan-out, no cross-file overlap.

---

## Survives upstream merge?

Yes. Cost telemetry is a SwarmOps-only feature; not in PR #1828. If upstream eventually adds it, our schema stays compatible (or we adopt theirs in a follow-up commit). Either way, the work is portable IP — even if SwarmOps gets archived someday, the cost-recorder pattern is reusable across other Claude Code orchestration projects.
