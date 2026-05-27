# ADR-097: goal_ui — Intelligence trajectory recording

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-4 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-093, ADR-095 (memory bridge), ADR-096 (swarm)

## Context

A completed goal_ui research run is rich training data: a `(goal, configHash, perStepFindings, finalReport, userVerdict)` tuple. Today, we throw it away on page reload. The platform's RuVector intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE) is built precisely for this signal — SONA can learn which preset/prompt combinations produce reports the user keeps vs discards, then reroute future similar goals to the better-performing config in <0.05ms adaptation time.

## Decision

Wire the existing `mcp__claude-flow__hooks_intelligence_trajectory-{start,step,end}` MCP tools into `Index.tsx::executeResearch()`. Every research run becomes a recorded trajectory:

1. **`trajectory-start`** at goal-input submission. Payload: `{goalHash, goalText, presetId, configHash, timestamp}`.
2. **`trajectory-step`** at each per-step completion. Payload: `{stepId, stepTitle, findingCount, avgConfidence, latencyMs}`.
3. **`trajectory-end`** at final-report dismissal. Payload: `{verdict: "kept" | "edited" | "discarded", editsCount, finalRecCount, totalLatencyMs}`.

Verdict comes from explicit user action: clicking "Save Report" → `kept`; closing the modal without saving → `discarded`; using the "Revise" form → `edited`.

On goal-input change in `GoalInput.tsx`, query `mcp__claude-flow__hooks_intelligence_pattern-search` with the in-progress goal text. Top-3 similar past trajectories where the verdict was `kept` → surface the originating preset+config as autocomplete chips. Click prefills the form.

## Consequences

### Positive
- SONA layer learns "this kind of goal works best with the academic-deep preset" from real outcomes, not heuristics.
- Closes the loop between user behavior and configuration recommendations — the system actually improves with use.
- Provides a measurable success metric ("% of suggested presets that survive without edit").

### Negative
- Every research run now writes ~5-10 KB of trajectory data. Over a year of heavy use this is non-trivial. Mitigation: AgentDB consolidation (per ADR-076) compresses old trajectories.
- Pattern-search on every keystroke would saturate the bridge. Mitigation: debounce input change to 300ms, cap top-3.

### Risks
- "Kept" is a noisy signal — a user may save a low-quality report just to reference later. Long-term fix: secondary signal from R-3's critic agent (whose own confidence scoring is a quality proxy).
- Cold-start: a new browser has no trajectories, so suggestions are empty. Acceptable; the chips just don't appear until the user runs ≥1 research session.

## Alternatives Considered

- **Roll a goal_ui-specific suggestion engine** — duplicates SONA; doesn't benefit from cross-installation knowledge that a future federation phase could provide.
- **Send trajectories to a centralized analytics endpoint** — privacy trade-off; defeats the point of the local-first stance taken in Step 21b.
- **Only record on `kept`** — sparse signal; SONA needs the negative examples (`discarded` / heavy `edited`) to discriminate.

## Definition of Done

Plan steps R-4.1 through R-4.3 in `.ruflo-integration-plan.md`:

- 5 trajectories stored end-to-end, schema-validated.
- `npx @claude-flow/cli hooks intelligence stats` shows the trajectory event log.
- Goal-input chip-click prefills the form with the prior preset+config.

## References
- ADR-076 — Memory Bridge
- ADR-086 — RuVLLM (intelligence backend context)
- RuVector intelligence pipeline (CLAUDE.md "Intelligence System")
- `mcp__claude-flow__hooks_intelligence_*` tool family
