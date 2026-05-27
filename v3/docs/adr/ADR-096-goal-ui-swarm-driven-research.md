# ADR-096: goal_ui — Swarm-driven research step

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-3 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-093, ADR-094 (security), ADR-095 (memory)

## Context

`functions/research-step/handler.ts` runs each of the 7 research phases as a single Anthropic Messages tool-call. One model, one prompt, one structured response. This is the lowest-cost path but gives up the platform's signature capability: specialized multi-agent reasoning. Hallucination rate is unmeasured; no critic challenges low-confidence claims; coverage breadth depends entirely on a single context window.

## Decision

Add an optional swarm path behind `RUFLO_USE_SWARM=true`. When enabled, each research step spawns a 4-agent specialized swarm via `npx @claude-flow/cli` (topology `hierarchical`, max-agents 4, strategy `specialized`, consensus `raft`):

| Agent | Role | System prompt focus |
|---|---|---|
| `researcher` | Gather raw findings | Breadth-first; cite sources; flag uncertainty |
| `analyst` | Extract structured claims | Reduce researcher output to `{claim, source, confidence}` triples |
| `critic` | Challenge claims | Re-grade confidence; flag contradictions; demand citations |
| `scribe` | Final structured output | Produce the `findings[]` array the UI consumes |

Coordination: `researcher` → `analyst` → `critic` → `scribe`, each receiving the prior output via `SendMessage` (per the project's Agent Teams convention in CLAUDE.md). Scribe's output is the same `{title, content, source, confidence}[]` shape the current handler returns — wire-compatible with `Index.tsx::executeResearch()`.

Implementation lives in a new `functions/_lib/swarm.ts` adapter that shells out to the CLI; the handler at `functions/research-step/handler.ts` checks `RUFLO_USE_SWARM` and dispatches to either the existing single-call path or the new swarm path. Failure of any agent surfaces as 502 with the agent name in the error.

A/B harness `scripts/check-swarm-quality.mjs` drives 3 seed goals through both paths; reports unique-citation-count delta + Anthropic-Opus-judged hallucination delta.

## Consequences

### Positive
- Self-critiqued findings: every claim crosses the critic before reaching the user.
- Measurably broader coverage: 4 specialized contexts > 1 general context (target: ≥30% more unique citations).
- Aligns goal_ui with the rest of the platform's "swarm-first" stance from `CLAUDE.md`.

### Negative
- ~3.5× tokens per research step (4 agents vs 1). At default 7 steps × 3 items per step the per-research-run cost rises proportionally. Mitigation: swarm path is opt-in; cost-tracker (per `@claude-flow/cli cost-tracker`) surfaces the delta.
- ~2-4× latency per step (sequential pipeline). Mitigation: researcher + analyst can run in parallel where the analyst doesn't strictly need final researcher output; pipeline depth becomes 3 not 4.

### Risks
- `npx @claude-flow/cli` invocation from a Hono server has cold-start cost (~500ms first-fire). Mitigation: keep a CLI daemon process via `daemon start` if R-3 ships at scale.
- Anthropic-Opus as A/B judge introduces evaluator bias — disclose in the report.

## Alternatives Considered

- **Run the swarm in-process via the @claude-flow/cli SDK** — depends on a programmatic SDK that isn't a stable export today. Revisit when one lands.
- **Use only researcher + critic (skip analyst + scribe)** — analyst's structuring step is what makes the output Zod-validatable; skipping it pushes the work into the critic and dilutes critique quality.
- **Run the swarm in the browser via WASM agents** — bundle-size and execution-time blow-out; not viable for 7 sequential steps.

## Definition of Done

Plan steps R-3.1 through R-3.3 in `.ruflo-integration-plan.md`:

- `functions/_lib/swarm.ts` smoke test in mock mode returns merged structured findings.
- `RUFLO_USE_SWARM=true` e2e test exercises both paths.
- `docs/swarm-ab-results.md` reports ≥30% more unique citations + ≥20% lower hallucination rate (Opus-judged) over 3 seed goals.

## References
- ADR-093 §"RuFlo Platform Integration" §"Phase R-3"
- `@claude-flow/cli` swarm topology + agent specialization (CLAUDE.md)
- Anthropic Messages tool-use shape (already adopted in `_lib/llm.ts`)
