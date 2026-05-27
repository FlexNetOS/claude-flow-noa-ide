# Internal Technical Debt — Next Engineering Plays

*2026-05-08, post-86-commits + 4-upstream-merge. Audit scope: `/Users/h4ckm1n/dev/SwarmOps`*

## Ship next (5-bullet priority list)

1. **STRAT-1 `resolveInstallContext` hoist** — 1 day. The single highest-leverage change; kills the root cause of the same bugs (1/7/8) PR-1828 fixed locally in three places. None of it has shipped.
2. **STRAT-2 `ControllerCapabilities` interface** — 1.5 days. 22 `typeof x.foo === 'function'` probes still live in `memory-bridge.ts` lines 131-1949. Replaces them with a typed contract.
3. **Bug 26 — flip `skipDangerousModePermissionPrompt: true`** — 5 minutes. Still active at `~/.claude/settings.json:421`. CRITICAL prompt-injection-to-RCE risk; never shipped.
4. **Bug 12 — fix OpenIsland statusline shadow** — 30 minutes. `_openIslandStatusLine` is the active `statusLine` in settings.json; ruflo's statusline never runs. Shipped doctor detection (`--hooks`) but not the actual fix.
5. **N+1 collapse in `memory_search_unified`** — 4 hours. Confirmed at `memory-tools.ts:1006`: loops `searchEntries` per namespace. One round-trip per call would 5-10× the most-called search op.

---

## 1. STRAT-1/2/3 Status

**STRAT-1 (`resolveInstallContext`)** — **NOT shipped.** `grep -rn 'resolveInstallContext\|installContext' v3/` returns zero hits in source. The three local "where is my data dir?" approximations from Bugs 1/7/8 are still scattered: `helpers-generator.ts:55,636,652,787`, `settings-generator.ts:33`, `init/types.ts:250`, `statusline-generator.ts:168,588`, `executor.ts:331,388,1124-1126,2031-2048`, `mcp-server.ts:692`. **155 raw `os.homedir()` / `process.cwd()` references in `cli/src` alone.**

- **[STRAT-1]** Hoist `resolveInstallContext()` to `@claude-flow/shared/src/install-context.ts` — Effort: **1 day** — Payoff: **HIGH**. Single source of truth replaces ~12 stale call sites; eliminates the entire bug class. Ship `{ projectRoot, claudeRoot, dataDir, isGlobalInstall }` envelope + a `migrateFromLegacyPaths()` fallback for users on the cwd-relative tree.

**STRAT-2 (`ControllerCapabilities`)** — **NOT shipped.** `grep -rn 'ControllerCapabilities'` returns zero. The duck-typing pattern at `memory-bridge.ts:131-1949` is unchanged: **22 `if (typeof … === 'function')` probes** still gate every controller dispatch. Confirmed at lines 131, 139, 157, 171, 177, 185, 233, 236, 259, 262, 287, 289, 405, 419, 467, 469, 1621, 1687, 1690, 1773, plus several more.

- **[STRAT-2]** Add `ControllerCapabilities` interface to `@claude-flow/shared/src/types/controller-capabilities.ts` — Effort: **1.5 days** — Payoff: **HIGH**. Typed contract for `{ reasoningBank?, learningSystem?, skills?, semanticRouter?, attestationLog?, guardedVectorBackend?, cache? }`. Removes 22 untyped probes, gives the bridge a real registry interface, and unblocks STRAT-4 (hooks.ts split) — refactoring the giant before this exists just produces five smaller files with the same probes.

**STRAT-3 (`_schema` envelope)** — **PARTIALLY shipped.** `schemaVersion` is now used in `memory-initializer.ts:968,1231,1297,1360,1388` (4 writers, hardcoded `'3.0.0'`) and `neural/src/reasoning-bank.ts:832,857,869` (with `migrateIfNeeded`-style guard, schemaVersion 1, throws on mismatch). **No standardized `_schema: { version, migratedAt }` envelope exists**; no shared `migrateIfNeeded()` helper. Reads in `commands/memory.ts:1434` consume the field but other JSON state writers (`autopilot-state.ts`, the 28 empty `tmp.json` files, daemon-state.json, all `.claude-flow/data/*.json`) are still bare.

- **[STRAT-3]** Create `@claude-flow/shared/src/schema-envelope.ts` exporting `wrap(payload, version)` + `migrateIfNeeded(loaded, migrators)` + `unwrap()`. Adopt in 6 writers. Effort: **1 day** — Payoff: **MED**. Lower urgency than 1/2 because nothing is currently broken — it prevents the *next* migration disaster, doesn't fix today's. Save for the version-3.7.x → 3.8.x migration.

---

## 2. Top 5 Untouched Bug Classes

- **[CLASS-1] Silent catches with no logging** — 1207 `} catch` sites in `cli/src`. Only 2 are *truly* empty (both in `helpers-generator.ts:667,689` — code-generator template strings, OK), but a sample of 20 random catches in `mcp-server.ts`, `init/executor.ts`, `memory/memory-bridge.ts` shows the dominant pattern is `} catch { /* defensive */ }` or `} catch (e) { /* fall through */ }`. Effort: **2 days** to write a `swallowError(label, err)` helper that logs at `RUFLO_LOG_LEVEL=debug` and adopt in the 30 hottest paths — Payoff: **HIGH**. Right now, 3 of the 8 PR-1828 bugs were "swallowed-error → degraded silently" failure modes; the next 3 are still hiding here. Concrete first targets: `memory-bridge.ts:1949`, `rabitq-index.ts:200`, `embedder-resolver.ts:191`, `db-pool.ts:124,137,162,199,205`.

- **[CLASS-2] Unbounded module-level caches with no eviction** — 35 `Map<…> = new Map()` cache declarations in `cli/src` (excluding tests). The most dangerous: `db-pool.ts:_pool` (no eviction; per-path DB handles live forever), `embedder-resolver.ts:_resolverCache` (singleton, OK), the `_cache` in `ollama-embedder.ts:124` (mtime-keyed, OK). Effort: **1 day** to audit the remaining 32 and add `LRUMap(max=1000)` to the top 5 — Payoff: **MED**. The 352 MB RSS leak likely lives here, not in event-emitter listeners.

- **[CLASS-3] Timer creation without paired cleanup** — 67 `setInterval`/`setTimeout` calls in `cli/src` vs 27 `clearInterval`/`clearTimeout`. ~40 unbalanced timers across long-running paths (mcp-server, worker-daemon, container-worker-pool). Each unfreed timer pins its closure — a likely contributor to the 352 MB long-running RSS. Effort: **3 hours** for a `grep + visual audit + AbortController-style cleanup` pass — Payoff: **MED**.

- **[CLASS-4] Type-assertion escape hatches (`as any` / `as unknown`)** — 69 in `cli/src`, plus 178 raw `: any` annotations. Top offenders are `memory-bridge.ts` (34) and `mcp-tools/*` (~25). Each one is a future bug staging area. With `noImplicitAny: false` in `v3/tsconfig.base.json:18`, the compiler can't help. Effort: **2 days** to flip `noImplicitAny: true` and `noUncheckedIndexedAccess: true` in `tsconfig.base.json`, then triage the breakage — Payoff: **HIGH**. STRAT-7 in ANALYSIS.md, still on the strategic list.

- **[CLASS-5] Dead exports + leftover scaffolding** — 919 top-level `export` statements in `cli/src` against 24 in `index.ts`. The 28 empty `tmp.json` files scattered through `v3/@claude-flow/*/` (`v3/@claude-flow/cli/src/tmp.json`, `v3/@claude-flow/shared/tmp.json`, etc., all 0 bytes) are obvious leftover scaffolding. `services/` has 122 exports, `transfer/` has 163; ts-prune would surface 100+ unused. Effort: **4 hours** to run `npx ts-prune` + `find -name tmp.json -size 0 -delete` — Payoff: **LOW** (cosmetic), but cuts dead-code grep noise meaningfully.

---

## 3. Test Coverage Gap

**Source : test ratio in `cli/`** — 199 source `.ts` files vs 87 test files (counting all `.test.ts`); raw LOC ratio is **23,379 test : 118,660 source ≈ 1:5.1**. Ratio across all `v3/@claude-flow/*` packages: **238 tests : 837 sources ≈ 1:3.5** (the cli package is *worse* than the rest of the monorepo).

**Top untested-and-large modules** (untested = no test file with matching basename, source > 500 LoC):

| File | LoC | Why it matters |
|---|---|---|
| `memory/sona-optimizer.ts` | 985 | Trajectory consolidation; core to the learning loop. |
| `services/ruvector-training.ts` | 948 | Training pipeline; runs in headless-worker context. |
| `mcp-tools/claims-tools.ts` | 922 | Multi-agent coordination surface, 11 tools, 0 tests. |
| `init/statusline-generator.ts` | 898 | Generates the file that just got shadowed by OpenIsland. |
| `mcp-server.ts` | 859 | Top-level MCP entry; 1 smoke test only. |
| `mcp-tools/workflow-tools.ts` | 856 | 12 workflow tools, 0 tests. |
| `mcp-tools/neural-tools.ts` | 847 | 8 neural tools, 0 tests. |
| `ruvector/model-router.ts` | 827 | Model routing decisions; production-critical. |
| `mcp-tools/coordination-tools.ts` | 826 | Swarm coordination; 0 tests. |
| `memory/ewc-consolidation.ts` | 819 | EWC consolidation; 0 tests. |
| `mcp-tools/guidance-tools.ts` | 818 | Guidance surface, 0 tests. |

**Hooks.ts and headless-worker did get smoke tests** post-PR-1828 (`commands-hooks-smoke.test.ts` is 767 LoC, `headless-worker-executor-smoke.test.ts` is 389 LoC) — Bug 41 shipped. But the 11-file untested cluster above is **~9000 LoC of zero-coverage production code**, much of it on the daemon's hot path.

- **[COV-1]** Smoke tests for the 6 zero-coverage `mcp-tools/*-tools.ts` files (claims, workflow, neural, coordination, guidance, github) — Effort: **2 days** (~30 min/tool × 23 tools, smoke-only) — Payoff: **HIGH**. PR-1828's pattern of "smoke test catches 30% of regressions" applied to the surface MCP clients actually call.
- **[COV-2]** Targeted integration test for `memory/sona-optimizer.ts` + `memory/ewc-consolidation.ts` — Effort: **1 day** — Payoff: **MED**. Both are silent-degradation candidates: they "work" until they don't and you find out from corrupt embeddings.

---

## 4. Performance Carry-overs

- **[PERF-1] OpenIsland 352 MB RSS leak** — **Status: NOT addressed.** Investigation found no reconnect-on listener pattern in `cli/src/{memory-bridge,mcp-server}` or `v3/@claude-flow/swarm/src` (only 7 `.on` calls there, and ZERO `removeListener`/`removeAllListeners`/`.off()` cleanup in swarm — but volume is too low to explain 245 MB drift). The actual culprit is more likely **CLASS-3 (40 unbalanced timers)** + **CLASS-2 (32 unbounded module Maps)**, not EventEmitter listeners. Effort: **1 day** for a heap-snapshot diff (`node --inspect`, take snapshot at 107 MB, run for 30 min, take snapshot at 350 MB, diff) — Payoff: **HIGH**. The 352 MB number cited in `perf_swarmops_hotspots.md` is from prior audits and is likely the worst single resource issue in the product. Diagnose before patching.

- **[PERF-2] N+1 in `memory_search_unified`** — **Status: BUG STILL LIVE.** `mcp-tools/memory-tools.ts:1006-1021` literally loops `for (const searchNs of namespaces)` and runs `searchEntries({ query, namespace: searchNs, limit: limit*2 })` per ns. With 6 namespaces (the auto-enumeration default), that's **6× the work and 6× the embedding-vector reads**. Effort: **4 hours** to add a `searchEntriesMulti(namespaces, { query, limit })` to `memory-bridge` that does one cross-namespace HNSW pass — Payoff: **HIGH**. This is the most-called search op; even the previous 5-namespace allowlist was wasteful, and #bug4's "enumerate dynamically" change made it worse on multi-namespace stores.

- **[PERF-3] Embeddings deterministic LRU** — **Status: NOT shipped at the embeddings package layer.** `ollama-embedder.ts:124` has the mtime-keyed *file* cache (Bug 32, shipped), but `@claude-flow/embeddings/src/embedding-service.ts:455,545` and `rvf-embedding-service.ts:226` still do per-call computation without an in-memory sha1-keyed LRU. Effort: **3 hours** to add a `LRUMap<sha1, number[]>` (max 10k entries) keyed on `sha1(model + ':' + text)` — Payoff: **MED**. Wins compound on long-running daemon (hooks intelligence rev-tags every event) — easily 10-50% on the embedding-heavy paths.

- **[PERF-4] Regex hoisting** — **Status: 3 confirmed hot paths.** `init/helpers-generator.ts:291` (`new RegExp(pattern, 'i')` inside helper-template build), `production/error-handler.ts:354` (`new RegExp(`${key}[=:]?…`, 'gi')` inside log-redaction loop — runs per emitted log line), `ruvector/graph-analyzer.ts:358` (regex inside graph traversal). Effort: **1 hour** to hoist all three to module scope — Payoff: **LOW for 1+3, MED for 2** (error-handler runs on every log line, and we now have RUFLO_LOG_LEVEL gating that surfaces more lines).

- **[PERF-5] JSON.parse(readFileSync) re-reads** — **Status: 85 sites in `cli/src`** still re-parse JSON on every call. The hottest are settings.json (read by every hook, every doctor check, every helper). Effort: **1 day** to add a `mtime-keyed JSON cache` to `fs-secure.ts` (mirroring the `db-pool.ts:115-143` pattern) and adopt in the 5 hottest readers — Payoff: **MED**. Probably 30-80 ms per invocation on the doctor / helper paths.

---

## 5. Security Debt

**`npm audit` snapshot (run 2026-05-08):** **0 critical, 0 high, 4 moderate, 0 low.** All 4 moderates are transitive: `esbuild ≤0.24.2` → `vite ≤6.4.1` → `vite-node` → `vitest`. Single fix: bump `vitest` to 4.1.5 (semver-major). The 14 highs flagged in ANALYSIS.md (undici 7.x + yaml) **are resolved** — Bug 27 (`d627b8df6`) shipped. Confirmed clean.

- **[SEC-1] Bug 26 — `skipDangerousModePermissionPrompt: true`** — **Status: STILL ACTIVE at `~/.claude/settings.json:421`.** The single most critical open issue in the entire audit. Combined with the 14 prefix-wildcard `Bash(npx claude-flow * …)` allows still in the same file, this is a one-shot prompt-injection-to-RCE chain. Effort: **5 minutes** (set to `false`, restart Claude Code) — Payoff: **CRITICAL**. The reason it didn't ship is probably "I'm the only user, it's annoying." Ship it anyway and add a `doctor --strict` check that errors on this flag.
- **[SEC-2] `vitest` 4.1.5 bump** — Effort: **30 minutes** (semver major; check breaking changes in test runner config). Payoff: **LOW** (moderate sev, dev-dep only) but closes the audit cleanly so the only-failures-in-audit policy works.
- **[SEC-3] AIDefence runtime wiring** — **Status: SHIPPED (Bug 33).** `settings-generator.ts:389,432` wires `aidefence-scan` into `UserPromptSubmit` + `PreToolUse:WebFetch`. `permissions-template.test.ts` regression test exists. Effort: **0**. Listed for completeness.
- **[SEC-4] File perms `0600` on data files** — **Status: SHIPPED (Bug 42).** `66ad0a9a2 fix(security): 0600 perms on data files`. Effort: **0**.
- **[SEC-5] Permissions allow/deny** — **Status: SHIPPED (Bug 34).** Verified `~/.claude/settings.json` has 9 `permissions.deny` entries including `Bash(*--eval*)`, `Bash(*| sh*)`, `Read(**/.env*)`, `Read(**/.ssh/id_*)`. Allow list is now 19 specific entries (no longer raw prefix wildcards). Effort: **0**.

**What's left after Wave 2:** primarily **[SEC-1]** (the BIG one) + the 4 dev-dep moderates. After those, the audit surface is genuinely clean for shipping.

---

## 6. Dead Code / Dead Exports

- **[DEAD-1] 28 empty `tmp.json` files** scattered across `v3/@claude-flow/*` (one per package: `cli/src/tmp.json`, `shared/tmp.json`, `embeddings/tmp.json`, etc., all 0 bytes). Likely leftovers from a script that never finished. Effort: **2 minutes** (`find v3/@claude-flow -name 'tmp.json' -size 0 -delete`) — Payoff: **LOW** but cleans grep results.
- **[DEAD-2] `ts-prune` audit on `cli/src`** — 919 top-level exports against 24 re-exports in `index.ts`. Conservative estimate: 100-200 unused exports. Effort: **4 hours** to run `npx ts-prune` + manually verify the top 30 — Payoff: **LOW-MED**. Risk: false-positives on dynamic imports (the registry/skill system loads modules by path string).
- **[DEAD-3] `services/` and `transfer/` are export-heavy** — 122 + 163 exports. `services/index.ts` should re-export the public 5-10; everything else should be `internal` or directory-private. Effort: **1 day** to introduce a barrel-only public surface, mark the rest as `@internal`, and run TypeScript with `--declaration` to verify no consumer broke — Payoff: **LOW** (cosmetic) but materially helps STRAT-4 (knowing what's safe to break when splitting hooks.ts).
- **[DEAD-4] OpenIsland `_openIslandStatusLine` shadow** — **Status: STILL ACTIVE.** `~/.claude/settings.json` has `statusLine: { command: '/Users/h4ckm1n/.open-island/bin/open-island-statusline' }` — ruflo's statusline at line 427 is renamed to `_openIslandStatusLine` (i.e., dead). Effort: **30 minutes** to either (a) restore ruflo's statusline as primary, or (b) document that OpenIsland coexistence means accepting OpenIsland's version. The `doctor --hooks` check (Bug 38, shipped) detects this but doesn't suggest a fix — the CLI should print the suggested merge in `--fix` mode. Payoff: **MED** — every running session right now is missing ruflo's statusline data.

---

## Effort × payoff summary (one-line each)

| ID | Title | Effort | Payoff |
|---|---|---|---|
| STRAT-1 | `resolveInstallContext` hoist | 1d | HIGH |
| STRAT-2 | `ControllerCapabilities` interface | 1.5d | HIGH |
| STRAT-3 | `_schema` envelope helper | 1d | MED |
| CLASS-1 | `swallowError(label, err)` adoption | 2d | HIGH |
| CLASS-2 | LRU on top 5 unbounded module Maps | 1d | MED |
| CLASS-3 | Timer cleanup audit (40 unbalanced) | 3h | MED |
| CLASS-4 | Flip `noImplicitAny` + `noUncheckedIndexedAccess` | 2d | HIGH |
| CLASS-5 | `ts-prune` + delete `tmp.json` cleanup | 4h | LOW |
| COV-1 | Smoke tests for 6 zero-coverage `*-tools.ts` | 2d | HIGH |
| COV-2 | Tests for `sona-optimizer` + `ewc-consolidation` | 1d | MED |
| PERF-1 | Heap-snapshot diff + 352 MB leak fix | 1d | HIGH |
| PERF-2 | `searchEntriesMulti` collapse for `memory_search_unified` | 4h | HIGH |
| PERF-3 | sha1-keyed LRU on `embedding-service` | 3h | MED |
| PERF-4 | Regex hoist (3 sites) | 1h | LOW-MED |
| PERF-5 | mtime-keyed JSON cache in `fs-secure` | 1d | MED |
| SEC-1 | Disable `skipDangerousModePermissionPrompt` | 5m | CRIT |
| SEC-2 | Bump `vitest` to 4.1.5 | 30m | LOW |
| DEAD-1 | Delete 28 empty `tmp.json` | 2m | LOW |
| DEAD-4 | Restore ruflo statusline (or document OpenIsland coexistence) | 30m | MED |

**Single-day batch (~6h) recommended for next PR:** SEC-1 (5m) → DEAD-1 (2m) → DEAD-4 (30m) → PERF-2 (4h) → PERF-4 (1h). Pure wins, no architectural risk, ships immediately.

**Single-week sprint (~5d) for the strategic PR after that:** STRAT-1 (1d) → STRAT-2 (1.5d) → CLASS-1 adoption in the 30 hottest paths (2d) — this is the architectural deleveraging the senior reviewer in ANALYSIS.md asked for, and the prereq for STRAT-4 (hooks.ts split).

**Skip:** STRAT-3 until next minor release (no migration pain today); CLASS-5 ts-prune (low ROI vs risk of breaking dynamic imports); DEAD-2 / DEAD-3 unless STRAT-4 is being prepped.
