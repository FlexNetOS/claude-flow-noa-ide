# ADR-099: goal_ui — Hive-mind consensus on contested findings

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-6 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-093, ADR-096 (swarm)

## Context

ADR-096's 4-agent swarm produces structured findings with per-claim confidence scores. When the analyst and critic disagree on a claim's confidence by more than 0.2, the current scribe-step has to make an arbitrary call: keep, drop, or rewrite. The single scribe is a bottleneck and a single point of bias. The platform already implements Byzantine fault-tolerant consensus (BFT, Raft, gossip, CRDT, quorum) via `@claude-flow/cli hive-mind`. Using it for high-divergence claims gets us a defensible "5-node vote with 1-faulty-tolerance" decision rather than "scribe said so."

## Decision

Add a consensus checkpoint after the swarm's critic step. Route logic:

1. **Convergent claims** (analyst-critic confidence delta ≤ 0.2) → pass through to scribe unchanged. Most claims; cheap path.
2. **Divergent claims** (delta > 0.2) → kick off a 5-node `npx @claude-flow/cli hive-mind` Byzantine quorum vote. Each node receives `{claim, source, analystConfidence, criticConfidence}` and must vote `keep` / `drop` / `rewrite`. Faulty tolerance: `f < n/3` (so 1 faulty node out of 5 is tolerable).

Vote outcomes:
- `keep` → finding survives with `consensusVerdict: "kept"` and the confidence reset to `min(analyst, critic)`.
- `drop` → finding excluded; `dissentRationale` recorded for audit.
- `rewrite` → re-prompt the scribe with both confidence scores + the dissent rationale, then ship.

Implementation: `functions/_lib/consensus.ts` shells out to `npx @claude-flow/cli hive-mind init --topology hierarchical-mesh --consensus byzantine --max-agents 5` and `hive-mind spawn` for the 5 voters. Vote tally + rationale persists into the trajectory record (per ADR-097).

## Consequences

### Positive
- Reproducible, audit-logged conflict resolution instead of arbitrary scribe decisions.
- High-divergence claims (the ones most likely to be hallucinated) get the most scrutiny.
- Surfaces a "%s of claims required quorum" health metric that's a leading indicator of model degradation.

### Negative
- 5-node BFT vote per contested claim adds 5x agent fan-out for a subset of findings. At expected ~10% divergent claims, net cost is ~+50% on top of ADR-096's swarm — bringing per-step cost to ~5× single-call.
- Adds the hive-mind consensus runtime (`@claude-flow/cli hive-mind` — already available, but new infra in goal_ui's deploy graph).

### Risks
- BFT termination is not guaranteed in finite rounds for adversarial adversaries — but our voters are non-adversarial agents (just LLMs with different prompts). Default 3-round cap; if no quorum, fall back to scribe's decision and flag the claim with `consensusVerdict: "indeterminate"`.
- Latency variance: a divergent claim adds ~3-5s. Mitigation: vote in parallel for independent claims; cap concurrent votes at 5 to avoid daemon thrash.

## Alternatives Considered

- **Use Raft instead of Byzantine** — Raft assumes non-faulty leaders. Our threat model includes "an LLM model occasionally returns garbage," which fits the Byzantine assumption better.
- **Skip consensus, weight by critic-confidence-only** — gives up the platform's hive-mind capability; back to single-decision-maker bias.
- **Use 3-node vote (`f < 2`)** — 1 faulty out of 3 means 2 voters decide; same as 2-of-2 majority. Loses the "1 faulty tolerated" property. 5 is the smallest n where Byzantine `f<n/3` lets `f=1`.

## Definition of Done

Plan steps R-6.1, R-6.2 in `.ruflo-integration-plan.md`:

- Dissent-rationale recorded with each kept/dropped finding.
- `scripts/check-consensus.mjs` runs 5 simulated swarms with 1 forced-faulty node; all 5 reach consensus within 3 rounds.

## References
- ADR-093 §"Phase R-6"
- ADR-096 — Swarm-driven research step (precondition)
- `@claude-flow/cli hive-mind` — Byzantine consensus
- CLAUDE.md "Hive-Mind Consensus" topology + strategy table
