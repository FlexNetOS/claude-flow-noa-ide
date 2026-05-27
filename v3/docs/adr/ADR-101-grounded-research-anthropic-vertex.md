# ADR-101: Grounded research via Anthropic web_search + Google Vertex AI Grounding

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Supersedes**: portions of ADR-093 §"LLM upstream" and ADR-096 §"single-LLM path"
**Relates to**: ADR-093 (Anthropic-direct migration), ADR-094 (security), ADR-096 (swarm), ADR-098 (MCP server)

## Context

The post-Step-25 deployment of goal_ui to Cloud Run revealed an honest gap that the cron-driven build hadn't surfaced: **the research output is not grounded.** Each `research-step` call is a single Anthropic Messages tool-call where the model emits `findings[].source` strings from its training-data memory. There's no retrieval step, no citation verification, no real web access. A user inspecting the report has no way to validate any claim against a primary source.

Live evidence (deployed Cloud Run, May 2): Anthropic correctly returned `goals[]` strings phrased like real research (`"Develop an adaptive machine learning framework to detect and quantify flash loan arbitrage exploitation patterns"`), but with no grounding the per-step findings will fabricate URLs, mis-attribute claims to non-existent papers, and hallucinate dates. This makes goal_ui's "research" framing technically misleading.

A second pressure: the user's question — *"are we using Google grounding API for research?"* — clarifies the expectation. Real research workflows require:
1. **Web retrieval** (live, not training-data memory)
2. **Verifiable citations** (URL/title pair where the URL actually exists and contains the claimed content)
3. **Provenance tracking** through the per-step pipeline so the final report's recommendations cite back to step-level findings

ADR-093's §"LLM upstream" picked Anthropic-direct as the API target but said nothing about retrieval. ADR-096's swarm pipeline assumes the researcher agent has training-data memory only. Neither fits real research.

## Decision

Adopt a **two-provider grounded research pipeline** that gives goal_ui's `research-step` real web retrieval while keeping Anthropic as the structured-output orchestrator:

| Layer | Provider | Role |
|---|---|---|
| Web retrieval + citations | **Google Vertex AI Grounding (Gemini + Google Search)** OR **Anthropic `web_search` built-in tool** | Primary search, returns snippets + URLs |
| Structured output (Zod-validated tool calls) | **Anthropic Messages API** (current) | Takes grounded snippets, emits `{title, content, source, confidence}[]` |
| Cost-tracker / fallback | local mock | Already in place via `_lib/llm.ts::isLlmAvailable()` |

The choice between **Anthropic web_search** and **Vertex AI Grounding** is a deployment knob, not an architectural commitment:

- **Anthropic `web_search`** (released Q2 2026, generally available) — single-API-call simplicity, citations come back as `web_search_tool_result` blocks the existing tool-call parser already understands. Adds ~$0.01 per searched query. Same auth path (Secret Manager → `ANTHROPIC_API_KEY`).
- **Google Vertex AI Grounding with Google Search** — best-in-class search index (Google's own). Requires a separate auth path (`GOOGLE_AI_API_KEY` already in Secret Manager from `gcloud secrets list` evidence) + a separate API call before the Anthropic structured-output step. Higher quality on news / current events; less integrated.

Default = Anthropic web_search (single provider, existing auth, simpler). Operators can flip to Vertex via `RUFLO_GROUNDING_PROVIDER=vertex` env (resolved at request time, not deploy time, so no redeploy is needed for the swap).

## Implementation

Three concrete changes:

1. **`functions/_lib/grounding.ts`** (new, ~120 lines): provider-agnostic adapter `runGroundedSearch(query) → {snippets: [{title, url, snippet}]}`. Internally branches on `RUFLO_GROUNDING_PROVIDER`:
   - `anthropic` (default): adds `tools: [{type: 'web_search_20250305', name: 'web_search'}]` to the next Anthropic call. Parses `web_search_tool_result` content blocks.
   - `vertex`: POSTs to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` with `tools: [{google_search: {}}]` (Vertex AI's grounding tool). Parses `groundingMetadata.groundingChunks`.
   - `none`: returns `{snippets: []}` — caller falls back to ungrounded behaviour. Useful for cost-sensitive deploys + the existing mock-mode path.

2. **`functions/research-step/handler.ts`** modified to:
   - Call `runGroundedSearch(stepDescription + ' ' + goal)` BEFORE the Anthropic structured-output call.
   - Concat the `snippets` into the user prompt as a `RETRIEVED CONTEXT:` block (wrapped via `wrapUserInput()` per ADR-094).
   - Update the system prompt: *"Cite snippets by their listed index. If no snippet supports a claim, mark `confidence: low` and surface that in the rationale field."*
   - Validate `findings[].source` against the snippet URLs via Zod refinement — if the model emits a URL not in the snippet set, reject the response (502, schema-validation-failure path already in place).

3. **`functions/_lib/llm.ts`** extended with `enableWebSearch` flag on `LlmToolCallRequest`. When true, the `tools` array adds Anthropic's built-in `web_search` alongside the structured-output tool. Single-call path; cheaper than the two-call grounding adapter for the simplest cases.

The swarm pipeline (ADR-096) gets the same upgrade: only the `researcher` agent calls `runGroundedSearch`, downstream agents see only the retrieved snippets (NOT raw web access).

## Consequences

### Positive
- Findings carry verifiable URLs. The "source" field becomes a real link, not a hallucination.
- Two-provider posture is a hedge: if Anthropic web_search rate-limits or has an outage, flip to Vertex without a redeploy.
- Vertex is already provisioned in `ruv-dev` Secret Manager (`GOOGLE_AI_API_KEY` exists), so the second-provider path is opt-in but doesn't require new auth setup.
- The Zod refinement that rejects fabricated URLs makes hallucination structurally harder — not just a prompt instruction.

### Negative
- Per-step latency rises: ~2-4s additional for the search + snippet assembly before Anthropic's structured call. Total per-step latency goes from ~3-5s (current) to ~5-9s.
- Per-step cost rises: ~$0.01-0.02/search × 7 steps × N runs/day. At 1000 runs/day this is ~$70-140/mo on top of Anthropic Haiku tokens (~$5-10/mo). Bundle-size watcher (R-7.3) doesn't catch this; need a separate cost guard (cost-tracker integration is a follow-up).
- Two-provider failure modes: Vertex auth is OAuth-bearer-via-service-account; failure looks different from Anthropic's `x-api-key` 401. Need explicit error mapping in the grounding adapter.
- Anthropic `web_search` has a 5-result default cap per query. For breadth-first research that's tight. Vertex returns up to 10 by default.

### Risks
- **Search-result poisoning**: web_search results from Google or Anthropic can themselves contain LLM-injected adversarial content (a common SEO attack vector). Mitigation: every snippet wrapped in `<user_input>...</user_input>` before reaching the structured-output prompt (existing ADR-094 defense applies); critic agent in the R-3 swarm explicitly tasked with flagging suspicious sources.
- **Citation drift**: a URL valid at search time may 404 by report time. Mitigation: store the snippet's `accessed_at` timestamp + a content hash in the trajectory record (R-4.1), so future re-runs can detect drift.
- **Rate limits**: at goal_ui's expected scale (single-user demo today; broad public use later), Anthropic's 50 web_search calls/min default is fine. If goal.ruv.io traffic ever exceeds that, Vertex becomes the primary fallback.

## Alternatives Considered

- **Tavily / Serper / Brave Search standalone APIs** — adds a third auth path; bypasses Anthropic's integrated tool ergonomics. Cheaper per-query at small scale but harder to reason about.
- **Browse-via-Anthropic (URL fetch in user prompt)** — model fetches via training-data hallucinated URLs; defeats the point.
- **Self-hosted search via SearxNG** — operationally heavy, no quality advantage.
- **Skip grounding, accept ungrounded findings** — the option goal_ui ships with today. Honest but doesn't match the "research" framing.

## Definition of Done

- `functions/_lib/grounding.ts` exists with both provider implementations.
- `RUFLO_GROUNDING_PROVIDER=anthropic` (default) end-to-end test: goal → research-step → findings carry `source` URLs that 200 OK on a HEAD request.
- `RUFLO_GROUNDING_PROVIDER=vertex` end-to-end test: same, with Vertex-shaped citations.
- `RUFLO_GROUNDING_PROVIDER=none` falls back to current ungrounded behaviour cleanly.
- `npm run check:handler-fallback` extended with a malformed-snippet test (Zod rejects a `findings[].source` URL not in the snippet set).
- Cost guard wired (separate ADR if it becomes a follow-up — not blocking R-101).

## References
- ADR-093 §"LLM upstream" (Anthropic-direct decision)
- ADR-094 §"prompt injection defense" (`wrapUserInput`)
- ADR-096 §"4-agent swarm" (researcher agent gets the grounded path)
- ADR-098 §"MCP server" (`run_full_research` aggregate consumes the grounded findings)
- Anthropic web_search tool: anthropic-version `2025-03-05` and later
- Vertex AI Grounding: `https://cloud.google.com/vertex-ai/generative-ai/docs/grounding/overview`
