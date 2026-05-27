# MCP Tool Coverage — Phase 3 Smoke Tests

**Date**: 2026-05-07
**Branch**: `fix/global-install-and-learning-loop`
**Scope**: Smoke-test untested MCP tool categories (~200+ tools registered, prior 12-bug PR audited ~15)
**Method**: Each tool: works ✓ / errored ✗ / silent-zero ⚠ (loaded but idle, no data)

## Summary

- **Total tools tested**: 27 across 8 categories
- **Working ✓**: 18
- **Errored ✗**: 4
- **Silent-zero ⚠**: 5

### Breakdown by status

**Errored (4)** — all rooted in 2 underlying defects:
- `wasm_gallery_list`, `wasm_gallery_search` → missing peer dep `@ruvector/rvagent-wasm` (not declared in package.json — every WASM tool will throw)
- `browser_session_record` → shells out to `ruvector@0.2.25 rvf create` without the required `-d/--dimension <n>` flag — command always fails
- `browser_template_apply`, `browser_cookie_use` → shell out to `npx -y @claude-flow/cli@latest memory retrieve --namespace …` — CLI returns non-zero when key not found, surfaced as "fetch failed" instead of `{ success: false, missing: true }`

**Silent-zero (5)** — loaded fine but no state to show, classic Bug 6/11.3 "dead clock" pattern (matches PR #4 finding that idle reporters return 0 with no `_note`):
- `neural_status` (0 models, 0 patterns — no `_note` explaining)
- `neural_patterns` action=list (empty array, no hint)
- `daa_learning_status`, `daa_performance_metrics` (zero state, no `_note`)
- `coordination_metrics` ✓ this one DOES include `_note` fields ("Real-time latency metrics not available — coordination is state-tracking only") — should be the template for the others

## category: `browser_*`

| Tool | Status | Notes |
|---|---|---|
| `browser_session_record` | ✗ | `Command failed: npx -y ruvector@0.2.25 rvf create … error: required option '-d, --dimension <n>' not specified` |
| `browser_template_apply` | ✗ | `template fetch failed` — npx shell-out to `memory retrieve` exits non-zero when key absent (no graceful empty-result path) |
| `browser_cookie_use` | ✗ | `cookie lookup failed` — same shell-out pattern as template_apply |

**Fix candidates**: (a) pin `ruvector` and pass `--dimension 384` (matches `neural_status.totalEmbeddingDims`), (b) call AgentDB directly instead of spawning `npx`, (c) treat "key not found" as `{ success: false, missing: true }` not as error.

## category: `neural_*`

| Tool | Status | Notes |
|---|---|---|
| `neural_status` | ⚠ | Returns config + `_realEmbeddings: true`, but 0/0 models/patterns. No `_note` explaining empty state |
| `neural_patterns` (action=list) | ✓ | Empty `patterns: []`, `total: 0` — clean response, but borderline ⚠ |

**Notes**: `neural_train` / `neural_predict` / `neural_compress` not invoked (would mutate state, off-limits per task constraints).

## category: `swarm_*`

| Tool | Status | Notes |
|---|---|---|
| `swarm_init` | ✓ | Created `swarm-1778172750894-7686sr`, mesh, persisted |
| `swarm_status` | ✓ | Returns full config with timestamps |
| `swarm_health` | ✓ | 4 named checks (coordinator/agents/persistence/topology), all `ok` |
| `swarm_shutdown` | ✓ | Graceful terminate, 0 agents to kill |

Roundtrip clean. No issues found in this category.

## category: `hive-mind_*`

| Tool | Status | Notes |
|---|---|---|
| `hive-mind_init` | ✓ | Created `hive-1778172757094-s6or11` queen, raft consensus |
| `hive-mind_status` | ✓ | Pre-init: returns `status: offline`, `queen.id: N/A`, but `health.overall: healthy` (contradiction). Post-init: `status: active`, `health.workers: degraded` (because 0 workers — expected) |
| `hive-mind_consensus` (action=list) | ✓ | Empty pending/history |
| `hive-mind_memory` (action=list) | ✓ | Empty keys |
| `hive-mind_shutdown` | ✓ | Graceful, 0 workers terminated |

**Note**: `hive-mind_status` BEFORE init reports `health.overall: healthy` while `queen.status: offline` and `queen: unhealthy` — overall health calculation ignores queen state when uninitialized. Minor logic gap.

## category: `claims_*`

| Tool | Status | Notes |
|---|---|---|
| `claims_list` | ✓ | Empty `claims: []`, includes `stealableCount: 0` |
| `claims_board` | ✓ | All 7 lanes present (active/paused/blocked/handoff-pending/review-requested/stealable/completed) — clean board view |
| `claims_claim` | ✓ | Roundtrip: claimed `smoke-test-001` for `agent:smoke-test:tester`, returned full claim object |
| `claims_release` | ✓ | Released cleanly, returned `previousClaim` snapshot (good audit trail) |
| `claims_status` | ✗ | After release, calling `status: completed` returns `Issue is not claimed` — **expected** but the error message lacks the issueId for traceability. Borderline ✓ |

Strongest category tested. Roundtrip is solid.

## category: `wasm_agent_*`

| Tool | Status | Notes |
|---|---|---|
| `wasm_agent_list` | ✓ | Returns empty `agents: [], count: 0` — works without the WASM runtime because no agents exist yet |
| `wasm_gallery_list` | ✗ | `Failed to initialize @ruvector/rvagent-wasm: Cannot find package '@ruvector/rvagent-wasm'` — module not in package.json deps |
| `wasm_gallery_search` | ✗ | Same `@ruvector/rvagent-wasm` ERR_MODULE_NOT_FOUND |

**Fix candidate**: Add `@ruvector/rvagent-wasm` to `package.json` dependencies (or peerDependencies with a clearer error than ERR_MODULE_NOT_FOUND).

## category: `daa_*`

| Tool | Status | Notes |
|---|---|---|
| `daa_learning_status` | ⚠ | All zeros, no agents — but no `_note` explaining empty state |
| `daa_performance_metrics` | ⚠ | All zeros across agents/workflows/learning — same Bug 6 pattern |
| `daa_cognitive_pattern` (action=analyze) | ✓ | Returns 6 named patterns (convergent/divergent/lateral/systems/critical/adaptive) + recommendation. Clean static read |

## category: bonus (`coordination_*`, `embeddings_*`, `progress_*`, `transfer_*`)

| Tool | Status | Notes |
|---|---|---|
| `coordination_metrics` | ✓ | **Best of class** — returns nulls but with `_note` fields explaining "Real-time latency metrics not available — coordination is state-tracking only". Should be the template for `neural_*` and `daa_*` zero-state responses |
| `embeddings_status` | ⚠ | `success: false`, `initialized: false`, `message: "Embeddings not initialized. Run embeddings/init first."` — clear actionable message. Borderline ✓ |
| `progress_summary` | ✓ | Returns formatted ASCII box with V3 progress (99%, 200/100 MCP tools, 1683 files). Note: `MCP Tools: 100% (200/100)` shows >100% — claim of 200 tools out of 100 baseline is a metrics oddity worth checking |
| `transfer_store-trending` | ✓ | Returns 1 item (`seraphine-genesis-v1`), full pattern record with verified signature |

## Recommended follow-ups (next PR)

1. **Bug candidate: WASM runtime missing dep** — `@ruvector/rvagent-wasm` referenced from `v3/@claude-flow/cli/dist/src/ruvector/agent-wasm.js` but not in `package.json`. Either add it or feature-flag the WASM tools off when missing (with a useful `feature_disabled: true` response).
2. **Bug candidate: `browser_session_record` rvf flag missing** — invokes `ruvector rvf create` without `-d <dimension>`. Hard-code `--dimension 384` to match the embedding system, or read from `neural_status`.
3. **Bug candidate: browser shell-out is fragile** — `browser_template_apply` and `browser_cookie_use` shell to `npx -y @claude-flow/cli@latest memory retrieve` and treat exit-code-non-zero as error. Replace with direct AgentDB calls in-process (also avoids the npm warn deprecated noise polluting MCP responses) and return `{ success: false, missing: true }` for absent keys.
4. **Bug candidate (Bug 6/11.3 follow-up): Add `_note` fields to all idle reporters** — `neural_status`, `neural_patterns`, `daa_learning_status`, `daa_performance_metrics` should match `coordination_metrics`' pattern of explaining zero/null fields.
5. **Bug candidate: `progress_summary` reports `200/100` MCP tools** — claim exceeds 100% of plan; either widen the denominator or note the over-delivery.
6. **Minor: `hive-mind_status` health calc** — pre-init returns `overall: healthy` with `queen: unhealthy` — overall should be `degraded` until queen elected.
7. **Minor: `claims_status` error on unclaimed issue** — message `"Issue is not claimed"` lacks issueId echo.
