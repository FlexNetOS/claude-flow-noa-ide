# Intelligence SOTA Report — 2026-05-27

**TL;DR:** Self-regulated simulative planning (arXiv:2605.22138) lets 8B agents match 120–355B systems using 25.8–95.3% fewer reasoning tokens; Ruflo's flat chain-of-thought routing has no equivalent depth-allocation primitive — this is the highest-leverage intelligence improvement available in 2026.

## What's New in 2026

| Finding | Source | Confidence |
|---------|--------|------------|
| SR²AM: 8B model matches 120–355B at 25.8–95.3% fewer tokens via self-regulated simulative planning | arXiv:2605.22138 | A |
| MUSE-Autoskill: skill lifecycle (create→store→evaluate→refine) enables cross-agent knowledge transfer | arXiv:2605.27366 | A |
| SIA: harness optimization + weight updates yields 91.9% gain on GPU optimization tasks | arXiv:2605.27276 | A |
| Agent lifespan: long-lived agents degrade via 4 mechanisms (compression, interference, revision, maintenance) | arXiv:2605.26302 | A |
| ReasonOps: continuous reasoning monitoring as lifecycle enables adaptive correction | arXiv:2605.27014 | B |
| SWE-bench Verified SOTA: Claude Opus 4.7 @ 87.6%, GPT-5.3 Codex @ 85.0% | benchmarkingagents.com | B |
| GAIA SOTA: Claude Sonnet 4.5 @ 74.6% (Princeton HAL leaderboard) | benchmarkingagents.com | B |
| Mem0 LoCoMo benchmark: 92.5; LongMemEval: 94.4; BEAM degrades ~25% at 10M tokens | mem0.ai/blog/state-of-ai-agent-memory-2026 | A |

## Ruflo Current Capability

| Component | State | Gap |
|-----------|-------|-----|
| 3-tier model routing (ADR-026) | Complexity-based Tier 1/2/3 | No depth allocation within tier |
| 4-step intelligence pipeline | RETRIEVE→JUDGE→DISTILL→CONSOLIDATE | No simulative planning before tool calls |
| SONA | <0.05ms pattern matching | No skill lifecycle (create/evaluate/refine) |
| Graph intelligence | ADR-130 proposed, 5-layer fragmented | No semantic traversal from query string |
| Memory | HNSW + AgentDB hybrid | No temporal abstraction at 1M+ token scale |
| Benchmark harness | None | Cannot measure GAIA/SWE-bench regression |

## Competitor Comparison

| Framework | Adaptive Depth Planning | Skill Lifecycle | SWE-bench Score | Memory SOTA |
|-----------|------------------------|----------------|-----------------|------------|
| **Ruflo (claude-flow)** | No (flat tier routing) | No (static types) | Not measured | HNSW+AgentDB |
| **OpenAI Agents SDK** | Yes (o3 chain-of-thought orchestration) | Partial (handoff templates) | ~85% (GPT-5.3 Codex) | Platform-managed |
| **LangGraph v0.4** | No (static graph edges) | No | Not published | Checkpoint-based |
| **CrewAI Enterprise** | No (sequential/hierarchical fixed) | Partial (role templates) | Not published | Via mem0 integration |
| **AutoGen 1.0 GA** | Partial (GroupChat dynamic routing) | No | Not published | Basic session memory |

## Benchmarks

| Benchmark | SOTA Score | Model | Grade | Ruflo |
|-----------|-----------|-------|-------|-------|
| SWE-bench Verified | 87.6% | Claude Opus 4.7 | A | Not measured |
| GAIA (Princeton HAL) | 74.6% | Claude Sonnet 4.5 | B | Not measured |
| SR²AM token reduction | 95.3% fewer | SR²AM v1.0-30B vs 685B–1T | A | No equivalent |
| LoCoMo memory recall | 92.5 | Mem0 | A | No public score |
| BEAM@1M tokens | 64.1 | Mem0 | A | No public score |

## SOTA Proof & Witness

| Field | Value |
|-------|-------|
| **Session commit** | 733ada1b9aecd878418c88f0ae3e900523d59c37 |
| **Report SHA-256** | 20171013681d33297870fb922e666fc4bdef7ac07f65224f1a7f918e36a4c531 |
| **Witness stamp** | 96fc07c70df4d4fac0400031aa765583cb28e8940c80276602b4c124e65a4ed3 |
| **Verifier** | `sha256sum dream-gist-2026-05-27.md` → concat session commit → `sha256sum` → must equal witness stamp |

## Recommended Next Steps

1. **Implement `SimulativePlanningRouter` (ADR-132)** — add a selective-depth tier to ADR-026: for tasks with estimated horizon >5 steps, invoke a simulative forward pass before committing to tool calls. Target ≤30ms overhead, ≥20% token reduction on multi-step tasks. Architecture decision required (changes routing contract in `@claude-flow/hooks` route hook). _(Originally filed as ADR-131; renumbered after collision with ADR-131-tool-output-guardrail merged via #2149.)_

2. **Add skill lifecycle to SONA** — extend the SONA pattern store with MUSE-Autoskill evaluation gates: skills failing 3× consecutive invocations enter quarantine; 10× successes promote to `high-trust` with preloading. Extend `hooks post-task` worker. Implementation-level — no new ADR.

3. **Integrate GAIA subset benchmark harness** — add `npx claude-flow performance benchmark --suite agent` running a 10-question GAIA subset with score vs SOTA delta. Enables nightly regression detection. Implementation-level — no new ADR.
