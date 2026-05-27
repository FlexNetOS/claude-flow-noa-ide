# ADR-132 — Simulative Planning Router: Selective Depth Allocation for Agent Intelligence

> **Renumbered 2026-05-27**: originally filed as ADR-131 by the dream-cycle agent. ADR-131 was concurrently taken by the ToolOutputGuardrail work (#2149, merged commit `0f5b8fe7f`); this ADR was bumped to 132 to resolve the collision.

**Status**: Proposed
**Date**: 2026-05-27
**Authors**: claude (dream-cycle agent, 2026-05-27)
**Related**: ADR-026 (3-tier model routing), ADR-130 (graph intelligence integration), ADR-131 (tool-output guardrail), ADR-049 (AgentDB memory)
**Dream Cycle**: Issue #2156, Gist SHA-256 `20171013681d33297870fb922e666fc4bdef7ac07f65224f1a7f918e36a4c531`

---

## Context

Ruflo's current intelligence routing (ADR-026) dispatches tasks across three tiers by *complexity score* alone: Tier 1 (WASM booster, <1ms), Tier 2 (Haiku, ~500ms), Tier 3 (Sonnet/Opus, 2–5s). Within each tier, the model receives a flat chain-of-thought prompt with no mechanism to selectively deepen reasoning for multi-step planning horizons.

The 2026 SOTA paper SR²AM (arXiv:2605.22138, Grade A) demonstrates that **self-regulated simulative planning** — where an agent explicitly forecasts future states before committing to tool calls — allows an 8B-parameter model to match 120–355B systems at 25.8–95.3% fewer reasoning tokens. The key mechanism: the model decides *when* to plan deeply (low frequency, +2% overhead) vs. when to execute reactively, increasing planning depth by 22.8% only where needed.

Ruflo has no equivalent depth-allocation primitive. Every Tier 3 call commits to tool execution without a simulative forward pass. This wastes tokens on simple subtasks within complex workflows and underinvests in planning for tasks that genuinely require multi-step lookahead.

---

## Decision

Add a **SimulativePlanningRouter** as a conditional pre-execution layer in the `route` hook pipeline, activated only when:
- Estimated task horizon > 5 steps (determined by the existing `route` hook complexity scorer), OR
- The task involves ≥2 MCP tool calls in its predicted execution path.

The SimulativePlanningRouter performs a lightweight "shadow" forward pass — using the Tier 2 (Haiku) model as a world model — to generate a candidate action sequence before the Tier 3 model commits to execution. The shadow result is stored in SONA short-term memory and surfaced to the primary model via a compressed `[PLAN_CONTEXT]` prefix.

**Interfaces changed:**
- `@claude-flow/hooks` `route` hook: receives optional `simulativePlan` field in resolved routing context
- ADR-026 tier table gains a Tier 3-S (simulative) variant alongside existing Tier 3

**Interfaces unchanged:**
- MCP tool signatures
- Agent type definitions
- Memory backend schema

---

## Consequences

**Positive:**
- ≥20% token reduction on multi-step Tier 3 tasks (based on SR²AM 25.8–95.3% range, conservative estimate for partial adoption)
- Enables graph-backbone integration (ADR-130): the simulative pass can query the causal graph before committing, surfacing relevant prior trajectories
- Haiku as world model costs ~$0.0002 per shadow pass — net saving positive once task is >8 Tier 3 tokens

**Negative:**
- Adds ~20–50ms latency to tasks that trigger simulative depth (the route hook adds a Haiku call before Tier 3 dispatch)
- Requires SONA to cache shadow plans (short TTL: 60s); adds ~5MB working memory per active session
- If shadow plan is wrong, primary model must recover — need a `planMismatch` metric to detect divergence

**Neutral:**
- Tier 1 and Tier 2 tasks are unaffected (no shadow pass for fast/simple tasks)
- WASM booster path (Tier 1) bypasses the new layer entirely

---

## Implementation Sketch

```typescript
// v3/@claude-flow/hooks/src/route/simulative-planning-router.ts
export interface SimulativePlanResult {
  candidateSteps: string[];
  estimatedTokens: number;
  confidence: number; // 0–1
}

export async function maybeSimulatePlan(
  task: RouteContext,
  haiku: ModelClient,
  sona: SonaMemory,
): Promise<SimulativePlanResult | null> {
  if (task.estimatedHorizon <= 5 && task.predictedMcpCalls < 2) return null;
  // Shadow pass: ask Haiku to outline 3–7 steps without executing
  const shadow = await haiku.complete(buildShadowPrompt(task), { maxTokens: 256 });
  const plan = parseCandidateSteps(shadow);
  await sona.storeShortTerm(`plan:${task.id}`, plan, { ttlSeconds: 60 });
  return plan;
}
```

File target: `v3/@claude-flow/hooks/src/route/simulative-planning-router.ts` (new file, ≤200 lines)
Route hook integration: `v3/@claude-flow/hooks/src/route/index.ts` (edit, ~15 lines)

---

## Alternatives Considered

1. **Always use deep chain-of-thought (o3-style)**: Adds full reasoning overhead to every task. Benchmarks show this wastes 25–95% of tokens on tasks that don't need it. Rejected.

2. **Static step-count threshold only**: Simpler but ignores MCP call count as a planning trigger. Misses tool-heavy tasks with shallow nominal depth. Rejected.

3. **Defer until ADR-130 graph backbone lands**: SR²AM's gains are independent of the graph layer. Waiting delays a high-leverage improvement. Rejected — implement in parallel.

---

## References

- arXiv:2605.22138 — "Efficient Agentic Reasoning Through Self-Regulated Simulative Planning" (SR²AM)
- arXiv:2605.27276 — "SIA: Self Improving AI with Harness & Weight Updates"
- arXiv:2605.26302 — "Your Agents Are Aging Too: Agent Lifespan Engineering for Deployed Systems"
- ADR-026 — 3-Tier Model Routing
- ADR-130 — Graph Intelligence Integration
