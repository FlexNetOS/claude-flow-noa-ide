# ROUTING-B Result

## Files modified
- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`
  - Added `hooksRouteSpecialist` MCP tool (~390 LOC) directly after `hooksRoute` (lines 1163–1551).
  - Added registration in the `hooksTools` array (line 4717, immediately after `hooksRoute,`).
  - Also exports a helper `rankSpecialistAgents` (pure ranker) for unit testing without going through the MCP handler.

## Files created
- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/__tests__/hooks-route-specialist.test.ts`
  - 23 tests across 3 describe blocks (contract, ranker behavior, handler integration).

## API
```typescript
hooks_route_specialist({
  task: string;              // required — task description
  limit?: number;            // default 5, clamped to [1, 15]
  includeGenerics?: boolean; // default false — hide coder/tester/reviewer/general-purpose unless they're the only matches
}) => {
  candidates: Array<{
    agentType: string;       // canonical Agent tool subagent_type
    confidence: number;      // 0.0–1.0 (score / 10, capped)
    matchedTokens: string[]; // de-duplicated input tokens that triggered the match
    reason: string;          // human-readable explanation (description + matched signals)
  }>;
  fallback: string | null;       // 'general-purpose' when nothing scored, else null
  detectedLanguages: string[];   // e.g. ['typescript', 'python']
  detectedFrameworks: string[];  // e.g. ['react', 'next']
  detectedDomains: string[];     // e.g. ['security', 'performance', 'refactor']
}
```

Validation: `task` runs through `validateText` (same gate as `hooksRoute`). Empty/whitespace-only input bypasses the ranker and returns `{ candidates: [], fallback: 'general-purpose', ... }`.

## AGENT_REGISTRY entries
- **29 canonical agents indexed** (25 specialists + 4 generics).
- **Languages (9)**: typescript-expert, python-expert, rust-expert, golang-expert, swift-developer, apple-ui-designer, java-expert, csharp-expert, ruby-expert.
- **Frameworks (3)**: backend-dev (express/fastapi/nestjs), mobile-dev (react-native/expo), react-expert (react/next).
- **Domains (13)**: security-auditor, security-architect, performance-engineer, performance-profiler, refactoring-specialist, system-architect, database-optimizer, api-designer, infrastructure-architect, deployment-engineer, debugger, test-engineer, researcher.
- **Generics (4)**: general-purpose, coder, tester, reviewer (each tagged `isGeneric: true`, get a `-1` score penalty so specialists win ties).
- **Excluded**: coordinators (hierarchical-coordinator, mesh-coordinator, adaptive-coordinator), GitHub workflow agents (pr-manager, code-review-swarm, issue-tracker, release-manager), and hive-mind orchestrators — they coordinate other agents rather than ranking against task content. They can be added to the registry later without changing the contract; the ranker is data-driven.

## Token detection
- **8 language families**: typescript, python, swift, rust, go, java, csharp, ruby.
- **11 framework tokens**: react, next, fastapi, express, nestjs, swiftui, uikit, appkit, react-native, expo, rails.
- **46 domain tokens** spread across performance/security/refactor/architecture/database/api/test/cloud/debug/research/ui/design/mobile/backend families.
- All matching is **case-insensitive substring** on the lowercased task. Multi-word tokens like `"memory leak"`, `"cold start"`, `"prompt-cache"`, `"system design"`, `"threat model"` work without needing a real tokenizer — by design, since the contract requires "All token detection is case-insensitive" and gives examples that include phrases.

## Scoring (per spec)
- `+3` per matched language token
- `+2` per matched framework token
- `+1` per matched domain token
- `-1` if `isGeneric` (only applied when the agent already scored > 0, so generics with no signal stay at 0 and are filtered out)
- `+5` boost if the agent's name appears literally in the task description
- `confidence = min(1.0, max(0, score / 10))`
- Sort: descending score, alphabetical tiebreak on `agentType` for deterministic ordering.

## Tests
- **23 tests, all passing.**
  - 3 contract tests (schema shape, validation rejection)
  - 17 ranker behavior tests (typescript task, python task, multi-language, security, performance, refactor/architecture, generic filtering both ways, limit clamping, confidence range, detection arrays, name boost, case insensitivity, generic penalty, deterministic ordering, includeGenerics override, whitespace input)
  - 3 handler integration tests (parity with pure ranker, limit via tool, includeGenerics via tool)
- **Existing hooks tests**: re-ran 5 hooks-related test files (`hooks-route-semantic-bug40`, `hooks-route-user-skills`, `hooks-intelligence-stats-hnsw`, `hooks-intelligence-stats-unavailable`, `hooks-metrics-pending-insights`) — all 23 still green. No regressions.

## TypeScript
- `cd v3/@claude-flow/cli && npx tsc --noEmit -p .` exits with **only** the pre-existing `src/memory/sona-optimizer.ts(250,38): error TS2307: Cannot find module '@ruvector/sona'` — exactly the carve-out the spec called out. Zero new type errors introduced.

## Notes
- **Pure function design**: `rankSpecialistAgents` is exported alongside the MCP tool so tests can hit the ranker directly without faking MCP handler context. The handler is a thin wrapper that does input validation + parameter coercion, then delegates.
- **No I/O**: the registry and three token tables are static `const` arrays/records, embedded inline as the spec required (the Agent tool's catalog isn't queryable from inside CLI code).
- **Deterministic ordering**: tied scores break alphabetically on `agentType`. Two identical inputs always return identical orderings — important for caller-side caching.
- **Generic filter semantics**: `includeGenerics=false` (default) only suppresses generics *when at least one specialist scored > 0*. If no specialist matched (e.g. "render Gantt SVG in pure HTML"), generics surface so the caller still gets a usable answer rather than an empty list. When literally nothing scored — including generics — `fallback` returns `'general-purpose'` per the locked pseudocode.
- **Locked contract preserved**: input shape (`task`, `limit`, `includeGenerics`) and output shape (`candidates`, `fallback`, `detectedLanguages`, `detectedFrameworks`, `detectedDomains`) match the spec byte-for-byte. The single accepted divergence: `validateText` may short-circuit empty `task` into a `{ success: false, error }` shape (same convention as `hooksRoute`), which the test suite explicitly accepts as one of two valid empty-input responses.
- **Did not touch**: `services/trace-*`, `init/helpers-generator.ts`, `agent-router.sh` — strict adherence to the file allowlist.
- **No commit / no push**: as instructed, lead reviews.
