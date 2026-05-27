# Gap 4 v1.5 — stepIndex plumbing result

## Files modified

- `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`
  - Added `activeSessionStepIndex: Map<string, number>` keyed by trajectoryId
    (which IS the sessionId, as confirmed by `trace-loader.enrichWithCosts` JOINing
    cost entries by `t.id` against `entry.sessionId`).
  - Added exported `getCurrentStepIndex(sessionId): number | null` —
    normalizes the -1 sentinel from trajectory-start back to `null` so callers
    see "no step bound yet" instead of accidentally writing -1 to disk.
  - Added test-only `_resetActiveSessionStepIndex()` to keep the map clean
    between test cases (underscore-prefix discipline keeps it out of the MCP
    surface even though it's an `export`).
  - Extended `hooksTrajectoryStep.inputSchema` with optional `cost` object
    field (input/output/cacheRead/cacheCreation/total). Defensive coercion in
    the handler — malformed cost objects are silently dropped, the step is
    still recorded.
  - `hooksTrajectoryStart` handler: pre-seeds `activeSessionStepIndex.set(id, -1)`.
  - `hooksTrajectoryStep` handler: writes optional cost onto the new step,
    then `activeSessionStepIndex.set(id, steps.length - 1)` AFTER push.
  - `hooksTrajectoryEnd` handler: `activeSessionStepIndex.delete(id)`.

- `v3/@claude-flow/cli/src/mcp-tools/agent-execute-core.ts`
  - Added lazy importer `loadGetCurrentStepIndex()` (memoized, swallows on
    failure → null) so we don't hard-require hooks-tools at module init time
    and keep the door open for future circular-import refactors.
  - Added `resolveEffectiveStepIndex(inputStepIndex, sessionId)` helper —
    the precedence rule lives in one place: explicit `input.stepIndex` wins,
    then active-tracker lookup by sessionId, then `null`.
  - `callAnthropicMessages`: replaced the explicit `input.stepIndex ?? null`
    with `await resolveEffectiveStepIndex(input.stepIndex, input.sessionId)`.
  - `executeAgentTask`: same wire. `sessionId` is null in this path today
    (workflow runtime hasn't been threaded through), so the lookup returns
    null — but the moment a caller starts passing sessionId on the input,
    attribution lights up automatically without further changes here.

## Files created

- `v3/@claude-flow/cli/__tests__/cost-step-attribution.test.ts` — **11 tests**
  - `getCurrentStepIndex` returns null for unknown sessionId
  - `getCurrentStepIndex` returns null right after trajectory-start (-1 normalized)
  - 3 step pushes drive the tracker through 0 → 1 → 2 deterministically
  - trajectory-end removes the entry (post-end lookup returns null)
  - Optional inline `cost` accepted, stored on the step
  - Malformed cost object silently dropped, step still recorded (no throw)
  - `callAnthropicMessages` auto-resolves stepIndex from active tracker when
    the caller omits it
  - Explicit `input.stepIndex` wins over the auto-fallback
  - Unknown sessionId → records null stepIndex (per-dispatch fallback)
  - No sessionId at all → records null sessionId + null stepIndex
  - **End-to-end**: 3 dispatches across 3 trajectory-step calls produce 3
    cost-stats.json entries with stepIndex 0/1/2 and the right sessionId/agent

- `v3/@claude-flow/cli/__tests__/smoke-gap4-v15-per-bar-overlay.test.ts` — **1 test**
  - The validation criterion from the brief, codified as a regression: synth
    a 3-step trajectory + 3 stepIndex-attributed cost entries, run the loader's
    JOIN, render to HTML, assert exactly 3 distinct `data-step-cost="N"` spans
    appear (one per Gantt bar). This is the per-bar overlay activation proof.

## Per-step attribution flow

```
hooks_intelligence_trajectory-start(task)
  → set activeTrajectories[traj-XYZ]
  → set activeSessionStepIndex[traj-XYZ] = -1
                       │
                       ▼
hooks_intelligence_trajectory-step(traj-XYZ, action="plan")
  → push step to trajectory.steps  (now length=1)
  → set activeSessionStepIndex[traj-XYZ] = 0   (steps.length - 1)
                       │
                       ▼
callAnthropicMessages({ sessionId: "traj-XYZ", agentName: "coder" })
  → recordCost called with...
    sessionId   = "traj-XYZ"            (passed through)
    stepIndex   = resolveEffectiveStepIndex(undefined, "traj-XYZ")
                = getCurrentStepIndex("traj-XYZ")
                = 0                     (auto-attributed!)
                       │
                       ▼
cost-stats.json gets {sessionId: "traj-XYZ", stepIndex: 0, ...}
                       │
   (repeat for steps 1, 2 with their own dispatches)
                       │
                       ▼
hooks_intelligence_trajectory-end(traj-XYZ)
  → activeSessionStepIndex.delete(traj-XYZ)
                       │
                       ▼
ruflo trace replay traj-XYZ
  → loadTrajectory("traj-XYZ") parses store.json
  → enrichWithCosts() reads cost-stats.json, JOINs by sessionId+stepIndex
  → for each step i: step.cost = byStepIndex.get(i)
                       │
                       ▼
renderTrace(loaded)
  → for each step with cost: emit <span class="cost-label" data-step-cost="i">$$$</span>
  → INLINE_JS positions each span over its corresponding Gantt bar
  → per-bar $$ overlay is now LIVE
```

The key change: explicit `input.stepIndex` is no longer required at the
callAnthropicMessages site. As long as a `sessionId` is passed (which the
agent execution loop already does per Gap 4), the active-tracker delivers
the right index automatically, and zero per-call wiring changes are needed
in 3 callers + the MCP tool surface.

Backwards-compat: explicit `input.stepIndex` still wins (verified by test).
Callers passing neither sessionId nor stepIndex still record `null/null`
— byte-identical to today's behavior.

## Tests

- **New**: 12 tests added (11 cost-step-attribution + 1 smoke per-bar overlay)
- **Result**: 12/12 PASS

Existing test stability — re-ran the full validation cohort:
| Suite | Tests | Result |
|---|---|---|
| `cost-recorder.test.ts` | 13 | PASS |
| `cost-recorder-wire-in.test.ts` | 4 | PASS |
| `agent-execute-prompt-cache.test.ts` | 5 | PASS |
| `agent-execute-oauth-fallback.test.ts` | 9 | PASS |
| `commands-cost.test.ts` | 23 | PASS |
| `trace-loader-cost-join.test.ts` | 9 | PASS |
| `trace-renderer.test.ts` | 28 | PASS |
| `cost-step-attribution.test.ts` (new) | 11 | PASS |
| `smoke-gap4-v15-per-bar-overlay.test.ts` (new) | 1 | PASS |
| **Total in cohort** | **103** | **103 PASS** |

Plus broader hooks surface re-validated:
| `commands-hooks-smoke.test.ts` | 124 | PASS |
| `hooks-intelligence-stats-hnsw.test.ts` | 1 | PASS |
| `hooks-intelligence-stats-unavailable.test.ts` | 7 | PASS |
| `hooks-metrics-pending-insights.test.ts` | 5 | PASS |

No regressions detected.

## TypeScript

`cd v3/@claude-flow/cli && npx tsc --noEmit -p .`

Exit code: `1` — sole error is the pre-existing baseline:
```
src/memory/sona-optimizer.ts(250,38): error TS2307: Cannot find module '@ruvector/sona' or its corresponding type declarations.
```
This is exactly the "excluding pre-existing `@ruvector/sona`" carve-out the
mission specified. All net-new code in `hooks-tools.ts` and
`agent-execute-core.ts` compiles cleanly under `--strict`.

## Smoke verification

The smoke regression in `__tests__/smoke-gap4-v15-per-bar-overlay.test.ts`
codifies the brief's validation criterion. It:

1. Synthesizes `cost-stats.json` with 3 entries: `stepIndex: 0/1/2`, all
   pointing at `traj-smoke-gap4v15`.
2. Synthesizes a 3-step trajectory in `store.json`.
3. Runs `loadTrajectory()` → asserts all 3 steps end up with `step.cost`
   populated by the JOIN.
4. Runs `renderTrace()` → asserts the resulting HTML contains exactly 3
   distinct `data-step-cost="N"` spans (`N` ∈ {0,1,2}).

Test passes. Per-bar `$$` overlay activation is now provable via
`grep -oE 'data-step-cost="[0-9]+"' on rendered HTML, with one span per
trajectory step.

## Notes

- **Lazy import of `getCurrentStepIndex` from hooks-tools**: chose lazy
  (memoized) over top-level for two reasons. (1) hooks-tools is 4.7k LOC and
  loading it during cold dispatches that don't need step-attribution would be
  wasteful. (2) hooks-tools doesn't currently import agent-execute-core, but
  if it ever does (the SONA learning loop is a candidate), lazy import keeps
  us safe from a Node ESM circular trap. Failure mode is benign: if hooks-tools
  fails to load (slim test envs), the helper returns null and behavior falls
  back to per-dispatch attribution.

- **Sentinel value -1 vs null in the Map**: pre-seeding with `-1` on
  trajectory-start lets us distinguish "trajectory active, no step pushed yet"
  from "no trajectory at all". The exported getter normalizes `-1 → null` so
  external callers never see the sentinel — they get a clean two-state signal
  (number for bound, null for not). Tests verify both states.

- **executeAgentTask wiring**: sessionId is currently null in this path. I
  threaded the resolver through anyway so when the workflow runtime starts
  passing sessionId (the Bet B follow-up), per-step attribution lights up
  with zero further code changes here. The current behavior is unchanged —
  resolver returns null when sessionId is null.

- **Defensive cost-object coercion**: chose to silently drop malformed cost
  objects on trajectory-step rather than reject the step entirely. Cost
  attribution is best-effort enrichment; an upstream bug in cost shaping
  shouldn't tank the underlying trajectory record. Test covers this.

- **No Edit tool available in this run**: applied 5 + 3 surgical patches via
  Python anchor-replace scripts (with explicit anchor-missing assertions).
  All anchors hit on first try; no manual fix-ups needed.

- **Did not commit / push** as instructed. Lead reviews and ships in one
  commit.
