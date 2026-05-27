# ADR-095: goal_ui — AgentDB memory bridge for browser persistence

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-2 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-076 (Memory Bridge), ADR-077 (DiskANN), ADR-088 (LongMemEval), ADR-093

## Context

Step 11/18 of the goal_ui migration moved persisted React-state slots (`widgetConfig`, `userGoal`, `researchConfig`) into a standalone IndexedDB store via `src/integrations/rvf/`. The store is RVF-format-compatible with the Node `RvfBackend` but is otherwise isolated — a write in one browser doesn't reach another, and there's no HNSW recall over saved goals. Meanwhile, `@claude-flow/memory` ships a sql.js-backed AgentDB adapter that already runs in the browser and exposes the full HNSW + ONNX-WASM stack. Continuing to maintain a parallel store loses the platform's 150x–12 500x recall speedup and the existing memory-bridge ergonomics.

## Decision

Migrate goal_ui's persistence layer to `@claude-flow/memory`'s browser-compatible AgentDB adapter, preserving the RVF on-disk format as the export/import wire format. Three distinct shifts:

1. **Storage backend** — `src/integrations/rvf/client.ts` keeps its public API (`get/put/list/searchByVector/exportRvf/importRvf`) but its underlying store becomes the `@claude-flow/memory` `AgentDBAdapter` configured with sql.js-WASM. IndexedDB stops being the source of truth; it becomes a browser-side persistence target managed by sql.js.
2. **HNSW recall** — adds `RvfClient.searchByText(query, k)` that lazy-loads the ruvector ONNX-WASM embedder, embeds the query (384d, L2-normalized), and runs the AgentDB HNSW index. Used by `goalRepo.searchPastGoals(q)` to surface prior research goals as autocomplete chips on GoalInput typing.
3. **Cross-device sync** — opt-in feature flag `VITE_RVF_SYNC=true` enables the memory-bridge's existing `auto-memory-bridge` path, which periodically reconciles browser AgentDB state with the user's per-account ruflo memory store via `@claude-flow/memory`'s controllers.

## Consequences

### Positive
- Past-goal HNSW recall (`<10ms p95` per ADR-088) without a custom search index.
- Cross-device persistence unlocks the "I started this research on my laptop" use case.
- Reduces v3/goal_ui-side maintenance: every AgentDB optimization (DiskANN per ADR-077, hyperbolic embeddings, RaBitQ) reaches goal_ui without porting.

### Negative
- sql.js-WASM bundle size: ~600 KB gzipped. Mitigation: lazy-load on first persistence write (already the pattern with ruvector ONNX-WASM).
- IndexedDB → sql.js migration is one-way for existing users; need a startup `importRvf` step that reads any pre-migration RVF blob and replays into the new backend.

### Risks
- sql.js cross-origin restrictions in the embeddable widget context — Step 24's CSP envelope must be re-verified once sql.js loads. If blocked, widget falls back to the standalone path until R-2 ships separately.
- Memory bridge's auto-sync may introduce conflict-resolution edge cases for concurrent edits. Mitigation: CRDT-backed last-write-wins on `updatedAt` for the simple slot writes; richer trajectory data uses the bridge's existing event-sourcing path.

## Alternatives Considered

- **Keep the standalone IndexedDB store, add a custom HNSW index on top** — duplicates work; doesn't unlock cross-device.
- **Use Supabase realtime channels for sync** — re-introduces the dependency we explicitly removed in Step 21b.
- **Embed AgentDB only as a server-side cache, keep browser local-only** — fails the "memory recall while typing" UX target.

## Definition of Done

Plan steps R-2.1 through R-2.4 in `.ruflo-integration-plan.md`:

- `docs/integration-r2-survey.md` documents the chosen browser adapter (sql.js).
- Smoke test from `page.evaluate` writes + reads via the new wrapper.
- `getWidgetConfig` + `saveWidgetConfig` shapes unchanged; reload preserves; perf p95 ≤ 5 ms.
- `searchPastGoals(q)` returns top-3 HNSW hits in <10 ms p95 over a 100-goal corpus.

## References
- ADR-076 — Memory Bridge (Claude Code → AgentDB ONNX)
- ADR-077 — DiskANN persistent index
- ADR-088 — LongMemEval benchmark
- `@claude-flow/memory` — `src/agentdb-adapter.ts`, `src/auto-memory-bridge.ts`
