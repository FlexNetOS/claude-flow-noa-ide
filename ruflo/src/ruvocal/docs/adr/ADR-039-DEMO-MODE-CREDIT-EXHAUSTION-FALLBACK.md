# ADR-039: Demo-mode fallback when LLM credits are exhausted

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm` (will land on `main` after PR #1695)
**Relates to**: ADR-029 (HuggingFace chat-ui on Cloud Run), ADR-033 (ruvector + ruflo MCP integration), ADR-037 (Autopilot chat mode), ADR-038 (Ruvocal fork)
**Supersedes**: parts of ADR-029 §"OPENAI_BASE_URL configuration" (single-provider, hard-fail-on-402 assumption)

## Context

Production ruvocal at `https://flo.ruv.io/` calls OpenRouter (`OPENAI_BASE_URL=https://openrouter.ai/api/v1`) with a single Secret-Manager-bound key (`OPENROUTER_API_KEY:latest`). When the key hits its credit ceiling, OpenRouter returns HTTP 402 on every chat completion. Today the user sees:

- Before PR #1695: a misleading **"Upgrade to Hugging Face PRO"** modal (a leftover from the upstream HuggingChat fork — wrong product, wrong upgrade path).
- After PR #1695: a correct but blocking inline error toast: *"AI provider returned 402 — credits exhausted."*

Both are **dead-end UX**. A new visitor at `flo.ruv.io` who lands while the key is dry sees a broken product. For an AI product whose primary value-prop is "try the agentic-tools chat", that's a hostile first impression — and it happens silently any time the key drains over a long evaluation period or unexpected traffic spike.

What we want: when credits are exhausted, the chat **stays demonstrable** in a clearly-labeled mode so the user can keep exploring the surface (MCP tools, autopilot, memory, swarm) without a credit card on file. The bar isn't "perfect responses" — it's "the demo doesn't go dark on a Saturday night and the user understands what they're seeing".

## Decision

When the upstream LLM returns 402 (credits exhausted), serve a **canned demo response** drawn from a pre-recorded library, plainly labeled. **No free-tier fallback layer** — the path is binary: real LLM (when paid credits exist) → canned demo (when they don't).

### Why canned-only, not a free-tier middle layer

A free-tier provider fallback (e.g., OpenRouter free models like `google/gemini-2.0-flash-exp:free`) was considered and rejected:

- **Quality cliff mid-session.** A conversation that flips from primary → free model in the middle of a session produces a jarring drop in coherence, tool-call fidelity, and latency. The banner would label it but couldn't undo the dissonance.
- **Free-tier flakiness compounds the failure.** Free models have their own rate limits and outage windows. The very moment we'd lean on them (a traffic spike that drained primary credits) is exactly when free tier is most likely to also throttle.
- **Tool-call schema drift.** Free-tier models often ignore or mangle the OpenAI tool-call format. ruvocal's value is the agentic-tools surface (MCP, autopilot, memory) — a fallback that breaks those silently is worse than no fallback.
- **Brand inconsistency.** Free-tier models inject their own personality, refusal patterns, and formatting quirks. Demo visitors infer product quality from response quality; we should not let an unaffiliated model speak for us.
- **Operational opacity.** Free-tier traffic doesn't appear in OpenRouter billing, complicating cost-attribution dashboards.

A canned library — small, hand-crafted, fully under our control — avoids every one of those failure modes. The trade-off is that canned responses don't react to off-script prompts; we mitigate that with good scenario coverage and an honest banner.

### What "demo mode" means in practice

When primary returns 402:
1. Server picks the closest scenario from a small library of pre-recorded exchanges keyed by similarity to the user's prompt.
2. Server fakes a stream, replaying the canned tokens with realistic per-token timing so the chat UX still feels live.
3. Each canned message carries a `demo: true` flag.
4. Client renders a persistent **"Demo mode — try the real model with credits"** banner above the chat input for the duration of the conversation.
5. Tool-call scenarios in the canned library include realistic `tool_use` blocks (memory store, swarm spawn, MCP tool invocation, web research) so the visitor sees the agentic surface, not just text.

If the user types a prompt that doesn't match any scenario, the matcher falls back to a **general-purpose canned response** that explicitly acknowledges the demo limit: *"This is a demo turn — the live model has run out of credits. The full version handles arbitrary prompts; here are the example scenarios you can try in demo mode: …"* with quick-pick buttons for each scenario.

## Implementation

Three changes:

1. **`src/lib/server/textGeneration/demoResponses.ts`** (new, ~400 lines)
   - Hand-crafted library of ~8-10 scenarios covering the highest-traffic demo paths:
     - **Memory** (`store`, `recall`, `search`)
     - **Swarm** (`spawn`, `status`, `coordinate`)
     - **MCP tools** (a representative tool_use + tool_result + assistant continuation)
     - **Autopilot** (a 3-step plan, with progress streaming)
     - **Web research** (a grounded answer with realistic citations)
     - **Tool selection** (router picks the right MCP server for a given prompt)
     - **"Explain"** (one-paragraph product description)
     - **General fallback** (the unmatched-prompt scenario described above)
   - Each scenario is `{ id, keywords[], promptHints[], cannedTurns: Array<{ role, content, toolCalls?, delayMs? }> }`.
   - A small keyword-similarity matcher (`pickScenario(prompt, history)`) returns the best-matching scenario id; ties broken by preferring the more visually-rich scenario (tool calls > plain text).

2. **`src/lib/server/textGeneration/withCannedFallback.ts`** (new, ~120 lines)
   - Async-generator wrapper around the existing OpenAI stream call:
     ```ts
     export async function* streamWithCannedFallback(client, args, prompt, history) {
       try {
         yield* client.chat.completions.stream(args);
       } catch (err) {
         if ((err as { status?: number })?.status !== 402) throw err;
         const scenario = pickScenario(prompt, history);
         yield {
           type: MessageUpdateType.Status,
           status: MessageUpdateStatus.DemoModeActivated,
           scenarioId: scenario.id,
         };
         yield* fakeStream(scenario);
       }
     }
     ```
   - `fakeStream(scenario)` yields message-update chunks at realistic per-token cadence (~30-80 ms/token jitter), preserving the streaming UX. Tool-call scenarios emit `tool_use` updates exactly as the real model would.
   - Single retry only. If the canned path itself fails (programming error), surface a normal error — we do NOT cascade further.

3. **Client banner** (`src/lib/components/chat/ChatWindow.svelte`)
   - When the latest assistant message carries an update of type `Status / DemoModeActivated`, render a sticky banner above the input:
     *"Demo mode — the live model has run out of credits. You're seeing pre-recorded responses. [Try the real model →](upgrade-or-contact-link)"*
   - Banner persists for the full conversation; clears on new conversation.
   - Banner copy is operator-tunable via env (`PUBLIC_DEMO_MODE_BANNER`) so the upgrade link can point at billing, contact form, or product roadmap depending on the deploy.

A new `MessageUpdateStatus.DemoModeActivated` enum entry is added to the message-update types so the client has a typed branch to render the banner. Cloud Logging emits a `severity=NOTICE` entry per activation with `{scenario_id, conversation_id, prompt_hash}` so operators can see which canned paths are being exercised and tune the library.

## Consequences

### Positive
- **Zero dead-end UX.** A first-time visitor never sees a broken product when credits are dry. They see a labeled demo and can keep exploring the agentic surface.
- **No quality cliff.** Each canned scenario is intentionally crafted to showcase a real product capability with real-looking tool calls. No silent degradation, no model-personality mismatch.
- **Predictable demos.** Sales/marketing/social-share contexts can rely on the demo path producing the same outputs every time. Canned scenarios are versioned alongside code.
- **No third-party dependency on the fallback path.** OpenRouter free-tier policy changes, free-model deprecations, and unauthenticated rate limits don't affect us.
- **Zero marginal cost.** Canned playback is local CPU; no per-token billing, no infrastructure.
- **Honest UX.** The banner is unambiguous. We don't pretend the canned response is a real LLM turn.

### Negative
- **Doesn't react to off-script prompts.** A user who types something the library doesn't cover gets the general-fallback scenario, which is honest but less satisfying than a real LLM. Mitigation: cover the top-8 demo intents well; the general-fallback explicitly lists scenario quick-picks.
- **Library maintenance burden.** Each new MCP tool group or major product feature should grow a corresponding canned scenario, or it won't be representable in demo mode. Mitigation: scenarios are small and live next to feature code; PRs that add new tools must add a demo scenario as part of the checklist.
- **Tool-call canned paths require careful crafting.** A tool_use block that references a non-existent tool will break the dispatcher. Mitigation: scenarios reference only the canonical tool ids that ship in the build; CI test asserts every referenced tool resolves.
- **No fallback for the canned path itself.** If the matcher or fakeStream throws, the user sees a normal error. Acceptable — the canned code is small enough to keep regression-free.

### Risks
- **Demo drift.** As the product evolves, canned scenarios silently grow stale (they reference outdated tool names, old preprompts, removed features). Mitigation: a `npm run check:demo-scenarios` script in CI verifies every tool reference resolves and every scenario keyword set is non-empty. Stale scenarios fail CI.
- **Visitor confusion if banner is missed.** A visitor who scrolls past the banner might assume the canned response is from the live model. Mitigation: each canned message itself includes a small *"(demo)"* prefix on the first line, complementing the persistent banner.
- **Trust loss if scenarios feel stilted.** Bad canned content reads as marketing copy, not a chat. Mitigation: scenarios are written in the same conversational voice as the live model's preprompts, including the same self-deprecating asides and tool-routing reasoning the live model uses.

## Definition of Done

- `src/lib/server/textGeneration/demoResponses.ts` exists with ≥8 scenarios + a general fallback.
- `src/lib/server/textGeneration/withCannedFallback.ts` wraps the streaming call and is wired into `index.ts`.
- `MessageUpdateStatus.DemoModeActivated` is in the union type; client renders the persistent banner.
- `PUBLIC_DEMO_MODE_BANNER` env var lets operators tune banner copy without a redeploy.
- `npm run check:demo-scenarios` validates every tool reference and runs in CI.
- Live integration: rotate `OPENROUTER_API_KEY` to a depleted key, smoke-test `flo.ruv.io` shows the demo banner and at least one realistic tool_use response from the canned library.
- Cloud Logging entry per demo activation with structured fields `{scenario_id, conversation_id, prompt_hash}`.

## Alternatives Considered

- **Free-tier OpenRouter fallback** — rejected per the "Why canned-only" section above. Quality cliff, flakiness, tool-call drift, brand mismatch, opaque cost.
- **"Show a credit-purchase modal."** This is what the upstream HuggingChat fork did, and it's exactly the dead-end UX this ADR replaces. It pushes a payment decision on a first-time visitor who hasn't yet experienced value.
- **Operator monitors credits and tops up before exhaustion.** Operationally fragile; one missed alert = degraded visitor experience. Doesn't address inevitable burst-traffic exhaustion.
- **Self-host an open-weights model on Cloud Run with a GPU.** Cost-prohibitive for a demo surface; latency unfavorable on GPU cold starts; introduces a new deploy pipeline and a model-tuning surface we don't want to own.
- **Skip the chat entirely when credits are dry and show a static product page.** Strictly worse — the user came for the chat; a marketing redirect is a bait-and-switch. The canned path lets them feel the product instead of reading about it.
- **Hybrid (free fallback first, then canned).** Combines the worst of both: the quality cliff exists AND the canned library still has to be maintained. Adopting either alone is cleaner; we picked canned for the reasons above.

## References

- ADR-029 §"OPENAI_BASE_URL configuration" — single-provider baseline being relaxed
- ADR-033 §"MCP tool-call streaming" — paths the canned scenarios must mirror exactly
- chat-ui upstream `MessageUpdateType` / `MessageUpdateStatus` enums — extension point for `DemoModeActivated`
- PR #1695 commit `0b62a74` — removed the misleading SubscribeModal that this ADR replaces with a real demo path
