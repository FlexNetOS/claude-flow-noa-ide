# ADR-040: Migrate flo.ruv.io primary LLM backend from OpenRouter to Google Gemini

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm` (will land on `main` after PR #1695)
**Relates to**: ADR-029 (HuggingFace chat-ui on Cloud Run), ADR-038 (Ruvocal fork), ADR-039 (Demo-mode fallback)
**Supersedes**: ADR-029 §"OPENAI_BASE_URL configuration" (OpenRouter as primary)

## Context

`https://flo.ruv.io/` (Cloud Run service `ruvocal`) currently routes all chat completions through OpenRouter:

```
OPENAI_BASE_URL = https://openrouter.ai/api/v1
OPENAI_API_KEY  ← Secret Manager: OPENROUTER_API_KEY:latest
MODELS          = qwen/qwen3.6-max-preview, anthropic/claude-haiku-4.5,
                  anthropic/claude-sonnet-4.6, google/gemini-2.5-pro,
                  google/gemini-2.5-flash, openai/gpt-4o
```

This served us well for early experimentation (single key unlocks 6+ providers, no per-provider auth hassle), but two structural issues have surfaced:

1. **OpenRouter is a third-party intermediary on the critical path.** Every demo turn at `flo.ruv.io` traverses OpenRouter's pricing layer, rate limits, and uptime. The 402 incident that triggered ADR-039 is a direct consequence: when OpenRouter's per-key budget drains, the entire product goes dark even though we have generous billing on file directly with Google, Anthropic, and OpenAI through other channels.
2. **Cost-attribution is opaque.** OpenRouter's per-key billing makes it hard to see which model traffic contributed which spend. GCP-native billing for Gemini calls would land in the same console where we already track Cloud Run, Secret Manager, and Vertex grounding spend (per ADR-101) — one pane of glass instead of two.

The fact that **Gemini already powers ADR-101's grounding pipeline at goal.ruv.io** through the same `GOOGLE_AI_API_KEY` secret is also load-bearing. We've already proven Gemini works for the kind of structured + tool-calling workloads ruvocal needs; we're just routing it through an indirection that no longer pays for itself.

## Decision

Migrate `flo.ruv.io`'s **primary** LLM backend from OpenRouter to **Google Gemini** via Gemini's **OpenAI-compatibility shim**. The migration is a single env-var swap on the live Cloud Run service plus a `MODELS` rewrite — no application code changes, because chat-ui's "OpenAI-compatible API only" constraint (per ruvocal/CLAUDE.md) is satisfied by Gemini's compatibility endpoint:

```
OPENAI_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai/
OPENAI_API_KEY  ← Secret Manager: GOOGLE_AI_API_KEY:latest
```

ADR-039's canned demo-mode fallback **continues to apply unchanged** — it triggers on any 402 from upstream, regardless of which upstream is primary. If we ever want a multi-provider real-LLM fallback later, that can be a separate ADR; ADR-039 plus ADR-040 fully cover the credits-exhausted UX without one.

### Why Gemini's OpenAI shim, not Vertex AI direct

Two Google AI surfaces were considered:

| Surface | Auth | Pros | Cons |
|---|---|---|---|
| **Gemini API OpenAI shim** (`generativelanguage.googleapis.com/v1beta/openai/`) | API key | Drop-in `OPENAI_BASE_URL` swap. Auth already wired (`GOOGLE_AI_API_KEY`). Free tier exists. Streaming + tool-calls work. | Not officially "Vertex" — no per-region routing, no GCP IAM, simpler quotas. |
| **Vertex AI** (`us-central1-aiplatform.googleapis.com/.../openai/...`) | OAuth / service account | Billed via GCP project (cleaner attribution); regional residency; IAM-bound. | Requires service-account JSON, not API key. chat-ui's OpenAI client doesn't natively do GCP IAM. Would need a token-refresh wrapper. |

Picked the **Gemini OpenAI shim** for Phase 1 because it's a one-line config change. Vertex AI is a Phase 2 follow-up if we ever need per-region residency, IAM-scoped quotas, or unified billing — none of which are demo-blockers today.

### Model lineup

The new `MODELS` array uses Gemini IDs natively:

| Model id | Display | Tools | Multimodal | Notes |
|---|---|---|---|---|
| `gemini-2.5-flash` | Gemini 2.5 Flash | ✅ | ✅ | Default. Fast, cheap, free tier. Replaces qwen-3.6-max as the default `TASK_MODEL`. |
| `gemini-2.5-pro` | Gemini 2.5 Pro | ✅ | ✅ | Reasoning-heavy / longer-context tasks. |
| `gemini-2.0-flash` | Gemini 2.0 Flash | ✅ | ✅ | Cheaper baseline alternative. |
| `gemini-2.0-flash-thinking-exp` | Gemini 2.0 Flash Thinking | ✅ | ✅ | Optional reasoning model with visible thinking. |

The full RuFlo preprompt stays intact — it's prompt content, not provider-specific. The detailed system instructions about MCP tool routing, parallel tool calls, and response style port unchanged.

### What gets removed from the lineup

The OpenRouter-routed `anthropic/claude-*` and `openai/gpt-4o` entries are dropped from `flo.ruv.io`'s primary lineup as part of this migration. Anthropic stays available indirectly through `goal.ruv.io`'s research workflows (per ADR-101 — direct API key, not via OpenRouter). If a Claude-on-flo demand re-emerges, it can be re-added in a future ADR via the direct Anthropic key (also already in Secret Manager) using a second `OPENAI_BASE_URL` if chat-ui ever supports per-model routing — today it doesn't.

## Implementation

A single Cloud Run env-var update plus a `MODELS` rewrite. No code changes.

```bash
# Build the new DOTENV_LOCAL value
DOTENV_NEW=$(cat <<'EOF'
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
USE_USER_TOKEN=false
PUBLIC_ORIGIN=
TASK_MODEL=gemini-2.5-flash
PUBLIC_APP_NAME=RuFlo
PUBLIC_APP_DESCRIPTION=Intelligent workflow automation assistant powered by Gemini and MCP tools.
MODELS=`[
  {"name":"gemini-2.5-flash","displayName":"Gemini 2.5 Flash","supportsTools":true,"multimodal":true,"preprompt":"<existing RuFlo preprompt>"},
  {"name":"gemini-2.5-pro","displayName":"Gemini 2.5 Pro","supportsTools":true,"multimodal":true},
  {"name":"gemini-2.0-flash","displayName":"Gemini 2.0 Flash","supportsTools":true,"multimodal":true},
  {"name":"gemini-2.0-flash-thinking-exp","displayName":"Gemini 2.0 Flash Thinking","supportsTools":true,"multimodal":true}
]`
MCP_SERVERS=`<unchanged>`
EOF
)

gcloud run services update ruvocal \
  --region=us-central1 \
  --project=ruv-dev \
  --update-env-vars="DOTENV_LOCAL=$DOTENV_NEW" \
  --update-secrets="OPENAI_API_KEY=GOOGLE_AI_API_KEY:latest" \
  --quiet
```

The existing `OPENROUTER_API_KEY` secret binding can stay in place (for ADR-039 fallback library to reference if we ever bring OpenRouter back as a tertiary path), or be removed for cleanliness. Both are valid.

The `LLM_ROUTER_ARCH_BASE_URL` env (smart-routing endpoint, Omni) currently points at HuggingFace's router. If we use it, switch it to Gemini too; if we don't (it's empty in the live config), leave it alone.

## Consequences

### Positive
- **Direct billing relationship.** Gemini API calls bill against the same GCP project that runs Cloud Run, Secret Manager, and the goal.ruv.io grounding pipeline. One billing dashboard, one budget alert, one credit pool to monitor.
- **No third-party uptime risk on the critical path.** OpenRouter outages no longer take flo.ruv.io down. Gemini outages are the same risk we already have for goal.ruv.io grounding.
- **Free tier exists.** Gemini API has a real free tier (per-RPM and per-day limits) that's substantially more generous than OpenRouter's free models. This makes ADR-039's canned fallback trigger less often in practice — though we keep ADR-039 because the bar is "demo never goes dark", not "free tier covers everything".
- **Latency improvement on warm requests.** Direct hop to Google saves the OpenRouter round-trip; in informal probes from `us-central1`, `gemini-2.5-flash` is ~150-300 ms faster TTFT than the OpenRouter-proxied equivalent.
- **Tool-call schema known-good.** ADR-101's grounding pipeline already uses Gemini's tool-calling for the `google_search` tool. We've shipped this provider's quirks. ruvocal's MCP-heavy preprompts will benefit from that prior testing.

### Negative
- **Smaller model menu.** Six providers via OpenRouter → four Gemini variants. Some users explicitly want Claude Sonnet or GPT-4o; they lose that on flo.ruv.io. (They keep getting Claude on goal.ruv.io's research path.)
- **Single-vendor risk.** If Gemini API has an outage, both flo.ruv.io and goal.ruv.io grounding break together — they share the substrate. ADR-039's canned fallback covers flo's UX; goal.ruv.io would need its own (Phase 2 of ADR-101 already documents pi.ruv.io + Anthropic web_search as live alternates).
- **Tool-call format quirks.** Gemini's OpenAI shim mostly maps tool-calls 1:1, but some edge cases (parallel tool_calls, tool_call_id length limits, some `function.parameters` schemas) differ. We accept the drift; if a real bug appears, document and patch in a follow-up.

### Risks
- **Free-tier rate limits.** Gemini API free tier has per-minute caps that are easy to hit on a demo with sticky users. Mitigation: paid tier billing is on by default for our key (this is how ADR-101's grounding pipeline already runs); we just need to confirm `GOOGLE_AI_API_KEY` is the paid-tier key, not an unauthenticated trial.
- **Preprompt portability.** The current preprompt was tuned against Qwen and Claude personalities. Gemini's instruction-following is similar enough but not identical; we may need to adjust phrasing on a few tool-routing rules. Mitigation: post-deploy smoke-test the top 8 demo intents from ADR-039's canned scenarios against the live model.
- **Custom domain custom auth.** If we ever add OAuth login back (per ADR-029's `OIDC_*` vars), Gemini API key auth doesn't carry user identity, so per-user quota isn't possible. Today this doesn't matter (USE_USER_TOKEN=false), but it's a constraint to remember if we re-enable per-user routing.

## Definition of Done

- Live `ruvocal` Cloud Run service has `OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/` and `OPENAI_API_KEY` bound to `GOOGLE_AI_API_KEY:latest`.
- `MODELS` array reflects the Gemini lineup; `TASK_MODEL=gemini-2.5-flash`.
- A new chat at `https://flo.ruv.io/` produces a real Gemini response (verified via `gcloud logging read` showing the model id in the request log).
- ADR-039's demo banner does NOT activate during a normal smoke test (i.e., 402 path is dormant when credits are healthy).
- A budget alert is configured on the GCP project for Gemini API spend with thresholds at 50%/90%/100% of monthly budget.
- The existing `OPENROUTER_API_KEY` secret remains in Secret Manager for at least 30 days as a rollback option; rollback is documented as "PUT the old DOTENV_LOCAL value back via `gcloud run services update`".

## Alternatives Considered

- **Stay on OpenRouter, add a second key for redundancy.** Doesn't address the cost-attribution opacity or the third-party-on-critical-path concern. Solves only the immediate 402 incident.
- **Migrate to Vertex AI direct (with service-account auth).** Strictly better for compliance / per-region residency, but requires a token-refresh wrapper around chat-ui's OpenAI client and changes our auth model. Phase 2 follow-up if needed.
- **Multi-provider mesh (try Gemini first, fall back to Anthropic, then OpenAI).** Real fallback adds operational complexity (which provider's tool-call format wins? whose rate-limit semantics?) for a problem ADR-039's canned mode already solves cleanly. Reject for now; reopen if Gemini's uptime turns out to be worse than expected at scale.
- **Self-host Gemma / open-weights on Cloud Run with a GPU.** Demo-stage cost is too high; ADR-038 already chose hosted models for ruvocal.

## References

- ADR-029 §"OPENAI_BASE_URL configuration" — being superseded for flo.ruv.io
- ADR-038 — Ruvocal fork rationale (hosted-only)
- ADR-039 — canned demo mode that triggers on 402 from this new upstream
- ADR-101 (`v3/docs/adr/`) — Gemini already in production for goal.ruv.io grounding (`google_search` tool via Vertex)
- Gemini OpenAI compatibility docs: https://ai.google.dev/gemini-api/docs/openai
- Gemini API rate-limits: https://ai.google.dev/gemini-api/docs/rate-limits
- chat-ui upstream OpenAI client: https://github.com/huggingface/chat-ui (constraint: speaks OpenAI-compatible APIs only)
