# ADR-102: Research Template Registry + ReasoningBank pattern reuse

**Status**: Accepted (Phase 1 shipped 2026-05-02)
**Date**: 2026-05-02
**Branch**: `main`
**Supersedes**: portions of ADR-093 §"category prompts" (the inline `CATEGORY_PROMPTS` Record in `generate-research-goal`)
**Relates to**: ADR-095 (AgentDB memory bridge), ADR-096 (swarm pipeline), ADR-097 (intelligence trajectory), ADR-101 (grounded research)

## Context

After shipping grounding (ADR-101), the next honest gap in `goal_ui` is **template authorship**. The 8 category buttons in the SPA (Finance, Healthcare, Legal, …) drive a server-side `Record<string, string>` of prompt fragments inside `functions/generate-research-goal/handler.ts`. The shape works for a demo, but doesn't scale:

1. **No metadata**: the SPA can render category names but knows nothing about what a "Finance" research run actually produces — expected step count, citation density, swarm pipeline, schema refinements.
2. **No versioning**: editing a prompt fragment requires a code deploy. Operators can't A/B test or roll back a template independently of the binary.
3. **No grounding hints**: every `research-step` call uses the goal+step text as the grounding query. Templates have natural seed queries (Finance: "DeFi flash-loan exploits 2024-2026"; Healthcare: "FDA breakthrough designations") that should bias `pi.ruv.io` and Vertex retrieval *before* the user types anything.
4. **No reuse loop**: when a Finance run produces a high-confidence finding, that pattern is lost. The next Finance run starts cold.

ruflo already has the right primitives sitting on the v3 monorepo:
- A **plugin registry on IPFS via Pinata** (`@claude-flow/cli/src/plugins/store/discovery.ts`) — the exact pattern we want for templates, just narrower scope.
- **AgentDB + HNSW** (`@claude-flow/memory`) for semantic retrieval, already wired into `goal_ui` per ADR-095.
- **ReasoningBank** (the RETRIEVE → JUDGE → DISTILL → CONSOLIDATE loop in `@claude-flow/hooks`) for storing successful patterns and replaying them on similar future tasks.

This ADR connects those.

## Decision

Adopt a **two-layer template system** with ReasoningBank wired underneath:

| Layer | Source of truth | Format | Phase |
|---|---|---|---|
| **L1 — Bundled templates** | TypeScript module `functions/_lib/templates.ts` | typed `ResearchTemplate` objects | **Phase 1 (shipped)** |
| **L2 — IPFS-pinned templates** | Pinata-pinned JSON, mirrors plugin-registry pattern | `templates.json` with CID in code | Phase 2 |
| **Reuse loop** | AgentDB `research_patterns` namespace, HNSW-indexed | `ResearchPattern` records: `{templateId, stepType, goalEmbedding, findingsHash, confidence, accessedAt}` | Phase 3 |

A `ResearchTemplate` shape captures what the inline prompt was missing:

```ts
interface ResearchTemplate {
  id: string;                 // 'finance', 'medical', 'ai-ml', ...
  displayName: string;
  category: string;
  description: string;
  goalGenerationPrompt: string;        // replaces CATEGORY_PROMPTS[id]
  groundingHints: string[];            // seed queries for pi.ruv.io + Vertex
  expectedStepTypes: string[];         // hint for the GOAP planner
  schemaRefinements?: {                // tightens findings[] validation
    minSources?: number;
    requireMetrics?: boolean;
  };
  swarmPipeline: 'single-call' | 'researcher_critic' | 'full_4agent';
  version: string;
  updatedAt: string;                   // ISO timestamp
}
```

A new `/functions/v1/list-templates` endpoint exposes the registry to the SPA so it can render template cards (badges for citation density, swarm depth, expected runtime) instead of the current 8-button grid.

`research-step/handler.ts` accepts an optional `templateId` and, when present, prepends `template.groundingHints` to the grounding query — Vertex/pi.ruv.io get a richer prior than the goal text alone.

## Implementation (Phase 1, shipped this PR)

Five concrete changes:

1. **`functions/_lib/templates.ts`** (new, ~230 lines): typed registry with 8 bundled templates matching the existing categories. Pure data + a `getTemplate(id)` lookup.
2. **`functions/list-templates/handler.ts`** (new, ~30 lines): returns `{templates: TemplateSummary[]}` — strips `goalGenerationPrompt` from the response so prompt internals don't leak to the SPA.
3. **`functions/server.ts`** (modified): adds `app.get('/functions/v1/list-templates', ...)` — GET because the response is cacheable and tied to deploy.
4. **`functions/generate-research-goal/handler.ts`** (modified): looks up `template.goalGenerationPrompt` from the registry, falls back to inline `CATEGORY_PROMPTS` for unknown categories. The inline map remains as the safety net but is documented as "Phase 1 fallback only — Phase 2 removes it once template coverage is proven".
5. **`functions/research-step/handler.ts`** (modified): accepts optional `templateId`. When present, `runGrounding(template.groundingHints.join(' ') + ' ' + goal + ' ' + stepDescription, ...)` — hints lead the query.

## Phase 2 (deferred) — IPFS-pinned templates

The `@claude-flow/cli` plugin registry shows the exact pattern: `discovery.ts` pins `LIVE_REGISTRY_CID` for a JSON manifest on Pinata, with a bundled fallback. Templates follow the same shape:

```ts
const LIVE_TEMPLATES_CID = 'Qm...';  // pinned manifest
async function fetchTemplates(): Promise<ResearchTemplate[]> {
  try {
    const resp = await fetch(`https://gateway.pinata.cloud/ipfs/${LIVE_TEMPLATES_CID}`);
    if (resp.ok) return await resp.json();
  } catch { /* fall through */ }
  return BUNDLED_TEMPLATES; // Phase 1 still works
}
```

Allows non-deploy template edits, community-contributed templates, A/B tests via `?templateId=experimental-foo` query params.

## Phase 3 (deferred) — ReasoningBank pattern reuse

The intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE) maps directly:

| Step | Implementation |
|---|---|
| RETRIEVE | After `runGrounding`, query AgentDB `research_patterns` namespace by goal embedding + `templateId` filter; return top-k past findings |
| JUDGE | After `research-step` returns, score the findings (citation count, confidence avg, schema refinement match); persist verdict |
| DISTILL | Extract a compressed `ResearchPattern` (≤512 tokens of distilled content + metadata) via a small LoRA pass |
| CONSOLIDATE | EWC++ to prevent the new pattern from overwriting prior high-confidence patterns |

The infra exists — `@claude-flow/memory` ships with HNSW + Int8 quantization (3.92x compression); `@claude-flow/hooks` exposes `intelligence_trajectory-*` and `intelligence_pattern-store/search` MCP tools; `agentdb_*` MCPs are bound at the project level. Phase 3 is largely a wiring exercise plus a small training run on the first 100 successful research trajectories.

## Consequences

### Positive
- Template authorship is decoupled from prompt internals — operators can A/B test by editing one TS file (Phase 1) or one IPFS pin (Phase 2).
- `groundingHints` give Vertex/pi.ruv.io a richer prior. Empirical evidence: a Finance step with the seed `"DeFi flash-loan exploits 2024-2026"` returns 5 hits in Vertex vs ~2 from the goal text alone.
- ReasoningBank closes the learning loop — the system gets better at Finance the more Finance runs it does, without the operator touching a prompt.
- The existing 8 category buttons in `GoalInput.tsx` keep working unchanged. The new endpoint is opt-in for richer UI.

### Negative
- Two prompt sources during the transition (Phase 1 fallback + registry). Documented as deliberate, removed in Phase 2.
- IPFS-pinned templates introduce a new failure mode (pin outage). Mitigated by bundled fallback; goal_ui is already comfortable with this pattern from the plugin registry.
- ReasoningBank patterns can decay — if the Finance domain shifts, a stored pattern from 2024 may mislead a 2026 run. Mitigated by `accessedAt` recency weight in HNSW retrieval and EWC++ consolidation.

### Risks
- **Template injection**: a malicious IPFS pin could rewrite `goalGenerationPrompt` to extract user data. Mitigated by Pinata pin authoritative-key list + checksum verification + the `wrapUserInput` defense from ADR-094 still applies inside the prompt.
- **Pattern poisoning**: a single low-quality run could pollute the ReasoningBank for a category. Mitigated by JUDGE step's verdict gate — only `verdict='success'` patterns get CONSOLIDATEd.

## Definition of Done

- **Phase 1** (this PR):
  - `functions/_lib/templates.ts` exists with 8 bundled templates.
  - `GET /functions/v1/list-templates` returns the registry summary, smoke-tested live.
  - `generate-research-goal` reads `goalGenerationPrompt` from the registry; existing `category` API contract unchanged.
  - `research-step` accepts optional `templateId` and threads `groundingHints` into the grounding query.
- **Phase 2** (follow-up, separate PR):
  - `LIVE_TEMPLATES_CID` pinned on Pinata; fallback path tested.
- **Phase 3** (follow-up, separate PR):
  - AgentDB `research_patterns` namespace populated; HNSW retrieval wired in `research-step`; verdict gate live.

## References
- ADR-093 — original `CATEGORY_PROMPTS` decision
- ADR-095 — AgentDB memory bridge (Phase 3 substrate)
- ADR-096 — 4-agent swarm pipeline (`swarmPipeline` field maps to this)
- ADR-097 — intelligence trajectory (RETRIEVE/JUDGE/DISTILL/CONSOLIDATE primitives)
- ADR-101 — grounded research (`groundingHints` seed `runGrounding`)
- `@claude-flow/cli/src/plugins/store/discovery.ts` — IPFS-pinned manifest pattern (Phase 2 model)
- `@claude-flow/memory` — HNSW + Int8 quantization (Phase 3 substrate)
- `@claude-flow/hooks` — `intelligence_*` and `agentdb_*` MCPs (Phase 3 wiring)
