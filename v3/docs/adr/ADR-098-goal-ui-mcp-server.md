# ADR-098: goal_ui — Expose research workflows as an MCP server

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-5 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-093, ADR-094 (security), ADR-096 (swarm)

## Context

goal_ui currently exposes its research workflows only via a browser SPA + a thin LOCAL_FN/GCF HTTP backend. External claude-flow agents (the rest of the platform's swarm ecosystem) can't drive a research run programmatically — there's no MCP entry point. This makes goal_ui a dead-end consumer rather than a callable capability inside the broader RuFlo agent fabric.

## Decision

Wrap the four wired functions plus a new aggregate as MCP tools, exposed via a stdio MCP server runnable as `npm run mcp:start`:

| MCP tool | Underlying handler | Purpose |
|---|---|---|
| `generate_research_goal` | `functions/generate-research-goal/handler.ts` | Generate 3 goals for a category |
| `research_step` | `functions/research-step/handler.ts` | Execute one research step (single-call OR swarm per ADR-096) |
| `generate_action_items` | `functions/generate-action-items/handler.ts` | Synthesize action items from research findings |
| `optimize_research_config` | `functions/optimize-research-config/handler.ts` | Tune config for a preset |
| `run_full_research` | NEW orchestrator | End-to-end: goal → 7 steps → action items → final report |

`run_full_research` is the headline tool — it lets an external agent run the full GOAP planner pipeline with one MCP call:

```bash
npx @claude-flow/cli mcp call goal_ui-research run_full_research \
  --goal "Best family electric car under 50k" \
  --preset academic-deep
```

Server lives at `functions/mcp/server.ts` using `@modelcontextprotocol/sdk`. Each tool's input schema reuses the validators from ADR-094 (per the security primitive adoption). Each tool's output mirrors the existing HTTP wire shape so consumers don't need a separate parser.

Manifest at `functions/mcp/mcp-server.json` declares the server for discovery via `claude mcp list`.

## Consequences

### Positive
- goal_ui becomes a platform tool, not just a website. A claude-flow swarm can now use the research pipeline as a subroutine — e.g., a code-generation swarm that wants market research first.
- Reuses every primitive already in place (handlers, security, LLM adapter, secret manager). Net new code is small (~200 LOC for the MCP wrapper).
- Federation-ready: the same MCP server runs locally OR on a deployed goal_ui host.

### Negative
- Adds `@modelcontextprotocol/sdk` as a dependency.
- An MCP server running locally is another long-lived process; ops surface area grows.

### Risks
- MCP stdio protocol mismatches across SDK versions have surfaced in the platform before (ADR-092 documents 6 such bugs). Mitigation: pin SDK version exactly; add a round-trip integration test that exercises every tool's full request/response shape.
- Aggregate `run_full_research` can run for minutes; MCP clients may time out. Mitigation: support a streaming progress channel via the SDK's notification API.

## Alternatives Considered

- **Expose only individual tools, not the aggregate** — leaves the orchestration burden on every MCP consumer. The aggregate is the point.
- **Use HTTP+OpenAPI instead of MCP** — already exists (the LOCAL_FN/GCF endpoint). The whole point of this ADR is letting claude-flow agents discover and call goal_ui via the platform's standard protocol.
- **Generate the MCP manifest from the Zod schemas at runtime** — nice-to-have; defer to a polish ADR.

## Definition of Done

Plan steps R-5.1 through R-5.3 in `.ruflo-integration-plan.md`:

- `mcp-server.json` validates against MCP spec.
- `claude mcp call goal_ui-research run_full_research --goal "..."` returns structured output.
- Round-trip test using `@modelcontextprotocol/sdk` covers every tool.

## References
- ADR-093 §"Phase R-5"
- ADR-092 — MCP tool input validation bugfixes (precedent for testing pattern)
- `@modelcontextprotocol/sdk`
