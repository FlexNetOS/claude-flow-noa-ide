# Gap 4 Cost Recorder Result

## Files created

- `v3/@claude-flow/cli/src/services/cost-recorder.ts` (~370 lines)
  - Implements the locked contract: `recordCost`, `listCosts`, `summarizeCosts`,
    `resetCostStats`. Imports `CacheTtl`, `CostBreakdown`, `TokenUsage`, and
    `computeCostUsd` from `services/pricing.js` (coder-pricing's module).
  - Persists `cost-stats.json` next to `cache-stats.json` under
    `${claudeRoot}/.claude-flow/`. Uses `resolveInstallContext()` so global
    + per-project layouts both work; tests override via
    `RUFLO_INSTALL_CONTEXT_JSON`.
  - Atomic writes: serialise to `${path}.tmp.${pid}.${ts}` then `rename()`,
    matching the cache-stats persistence pattern but lifted into async I/O so
    the recorder doesn't block the dispatch event loop.
  - In-process serialisation chain prevents two concurrent `recordCost`
    callers from each reading the same pre-write state and clobbering one
    another's entry. Smoke-tested by the 20-concurrent-write race test.
  - All error paths flow through `swallowError()` — a broken cost log
    NEVER breaks a dispatch.
  - Defensive read: malformed JSON, missing `.entries[]`, individual bad
    entries are all skipped without poisoning the rest of the file.

- `v3/@claude-flow/cli/__tests__/cost-recorder.test.ts` (13 tests)
  - recordCost writes valid entry with computed costUsd
  - recordCost records cost=null for unknown models without throwing
  - Rolling window caps at 100 (oldest pruned, newest kept)
  - 20-concurrent recordCost calls don't lose entries (race smoke test)
  - listCosts returns [] when file missing
  - listCosts filters by sessionId
  - listCosts filters by agent
  - listCosts.limit applied AFTER newest-first sort
  - summarizeCosts returns the empty summary when no entries
  - summarizeCosts aggregates totalUsd / byModel / byAgent correctly
  - summarizeCosts cacheHitRatio = sum(cacheRead) / sum(cacheRead+input+cacheCreation)
  - resetCostStats deletes the file
  - resetCostStats is idempotent on missing file

- `v3/@claude-flow/cli/__tests__/cost-recorder-wire-in.test.ts` (4 tests)
  - A successful Anthropic response triggers a cost-recorder write with full
    attribution (sessionId, stepIndex, agent, model, cost)
  - An unknown-model response still records the entry (cost=null, no throw)
  - Per-dispatch fallback: when sessionId/stepIndex/agentName omitted,
    entry is recorded with `null` / `'unknown'` defaults
  - Cache-stats persistence (cd44c55f8) is NOT regressed — both
    `cache-stats.json` and `cost-stats.json` land in the same `.claude-flow/`
    dir, neither writes on top of the other.

## Files modified

- `v3/@claude-flow/cli/src/mcp-tools/agent-execute-core.ts`
  - Added 2 imports: `recordCost` from cost-recorder, `CacheTtl` type from
    pricing.
  - Added 4 OPTIONAL fields to `AnthropicCallInput`: `sessionId`,
    `stepIndex`, `agentName`, `cacheTtl`. Backwards-compatible — existing
    callers that don't pass them get the per-dispatch fallback.
  - Wired `await recordCost(...)` into `callAnthropicMessages` after the
    existing `logCacheUsage(...)` call (so cache-stats AND cost-stats both
    fire). Cost recording fires on EVERY successful call, not just
    structured-cache calls — per-dispatch USD attribution must work
    independently of cache shaping.
  - Wired a parallel `recordCost(...)` into `executeAgentTask` because that
    path has its own fetch — using `input.agentId` as the recorded agent
    name so trace consumers can group by named agent. sessionId/stepIndex
    not threaded here (per-dispatch only — see "Per-step granularity
    status" below).

- `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`
  - `interface TrajectoryStep` (line 433) gains an OPTIONAL `cost` field:
    ```typescript
    cost?: { input: number; output: number; cacheRead: number;
             cacheCreation: number; total: number } | null;
    ```
  - Optional preserves backwards compat — older trajectories without it
    parse fine. trace-loader (coder-trace-cost) and renderer (same coder)
    will pick up the field when present.
  - `hooksTrajectoryStep` MCP tool body NOT touched — the schema change
    is enough to unlock per-step cost; populating it requires the
    invasive plumbing change documented below.

## Per-step granularity status

**Per-dispatch granularity: WORKING.** Every Anthropic call recorded with
agent attribution. `sessionId`/`stepIndex` accepted by `callAnthropicMessages`
when callers thread them through (verified by wire-in test).

**Per-step granularity: NOT plumbed in v1 — deferred to v1.5.**

Reasoning: threading `stepIndex` from a "step is happening now" caller down
to `callAnthropicMessages` requires:

1. `AgentExecuteInput` to gain `sessionId`/`stepIndex` fields.
2. Three call sites to thread them through:
   - `mcp-tools/agent-tools.ts:309` (the `agent_execute` MCP tool handler)
   - `mcp-tools/workflow-tools.ts:357` (workflow runtime G3)
   - `ruvector/agent-wasm.ts:249` (WASM runtime fallback G4)
3. The `hooksTrajectoryStep` MCP tool (`hooks-tools.ts:2592`) to either:
   - record stepIndex+sessionId in a side-channel before each `agent_execute`
     dispatches, OR
   - have the agent execution loop know what trajectory step it's currently
     in and pass it on every subagent dispatch.

That cuts across at least 4 files and bumps the public MCP-tool input
schema for `agent_execute`, which the brief explicitly told me to avoid
("don't touch the rest of hooks-tools"). Per the design spec Open Choices
table, per-dispatch granularity is the v1 recommendation; per-step is
the v1.5 deferral. Doing it cleanly belongs in the v1.5 swarm — same time
as the trace-renderer per-bar annotation work.

The `cost?` field on `TrajectoryStep` is in place TODAY, so when v1.5 lands
the schema is already there — only the join helper (walk `cost-stats.json`
matching by `sessionId+stepIndex` at trajectory-write time) and the
plumbing-through changes need to ship.

## Tests

- 17 new tests, all passing (13 unit + 4 wire-in)
- 5 existing prompt-cache tests still pass (no regression)
- 9 existing OAuth-fallback tests still pass (no regression)
- Total cost-recorder + adjacent test runtime: ~360ms

## TypeScript

- `npx tsc --noEmit -p .` from `v3/@claude-flow/cli/` exits cleanly for ALL
  files I touched.
- Two pre-existing errors in `src/services/trace-template.ts` (lines
  184:44, 184:48 — CSS-in-template parser confusion in coder-trace-cost's
  in-flight work). Not in my scope; sibling coder will resolve.
- Excluding `trace-template.ts`, exit code is 0.

## Notes

- **Atomic write is real-POSIX-atomic, not best-effort.** `rename()` over
  the same filesystem is one of the few syscalls POSIX guarantees as
  atomic; the temp filename includes pid + millisecond to defend against
  two procs colliding on the temp path itself.

- **The serialisation chain catches a subtle race** that `cache-stats.json`'s
  sync `appendCacheStats` doesn't have to worry about (sync I/O is
  trivially serialised by Node's single thread). My recordCost is async
  because we need to do `readFile` + `writeFile` + `rename` without
  blocking the dispatch's event loop. Two near-simultaneous awaits would
  otherwise both read the same pre-write state and lose one entry — the
  race test catches this regression.

- **Pricing module is already shipped** (coder-pricing landed
  `services/pricing.ts` ~5min before this — I see `GAP-4-PRICING-result.md`
  in the execution dir). Contract types match exactly: `TokenUsage`,
  `CostBreakdown`, `CacheTtl`, `computeCostUsd(usage, model, ttl)` with
  the documented null-on-unknown-model behaviour. No coordination drift.

- **TrajectoryStep.cost is `cost?: {...} | null`** rather than `cost?: {...}`.
  This lets the join helper write `cost: null` to mark "we tried to find
  a cost match for this step but no entry existed in cost-stats.json"
  vs. `cost: undefined` meaning "we didn't try". Tiny semantic
  distinction but it'll matter for the v1.5 trace viewer rendering
  ("$0.00" vs. "—").

- **executeAgentTask wires sessionId=null deliberately.** That path runs
  the legacy agent-registry-backed dispatch (`agent_execute` MCP tool +
  workflow runtime), which doesn't have a trajectory context to
  attribute to. Per-agent attribution still works (we use `input.agentId`
  as the recorded `agent` field). When a workflow runs with hooks
  trajectory tracking enabled, the trajectory metadata hooks could
  enrich `cost-stats` post-hoc via the join helper — same v1.5 follow-up.

- **Did NOT touch:** services/pricing.ts (coder-pricing's territory),
  any commands/* file (coder-cost-cli's territory),
  services/trace-renderer.ts or services/trace-loader.ts
  (coder-trace-cost's territory). Only the line ranges explicitly
  authorised by the brief: cost-recorder.ts (new),
  agent-execute-core.ts (1 import + 1 type-import + 1 interface field
  block + 2 await calls), hooks-tools.ts (one optional schema field
  on `interface TrajectoryStep`).
