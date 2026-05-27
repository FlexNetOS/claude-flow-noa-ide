# Architectural batch result

Scope: STRAT-1 (resolveInstallContext), STRAT-2 (ControllerCapabilities),
PERF-2 (memory_search_unified N+1 collapse), CLASS-1 (swallowError adoption).

## Files created

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/shared/src/install-context.ts`
  Single source of truth for `{packageRoot, claudeRoot, dataDir,
  isGlobalInstall, projectRoot}`. Honors `RUFLO_INSTALL_CONTEXT_JSON` env
  override. Resolution algorithm matches the spec exactly.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/shared/src/swallow-error.ts`
  Standard recipient for absorbed-error catch blocks. Silent at default log
  level; emits `[swallowed:<label>] <msg> (<hint>)` on stderr when
  `RUFLO_LOG_LEVEL=debug|trace`.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/shared/src/types/controller-capabilities.ts`
  Typed view over `ControllerRegistry`. Defines 16 sub-interfaces (one per
  controller) with method-level optionality to honor the bridge's existing
  dual-API tolerance (e.g. `searchPatterns ?? search`,
  `recordFeedback / record`, `delete / remove`). Exports
  `getControllerCapabilities(registry)` adapter.

## Files modified

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/shared/src/index.ts`
  Added barrel re-exports for `resolveInstallContext`, `swallowError`,
  `getControllerCapabilities`, and the 21 supporting type names.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/init/settings-generator.ts`
  `isGlobalInstall(targetDir)` now derives the global `claudeRoot` via
  `resolveInstallContext({ home: os.homedir() })`. The path-comparison
  logic stays the same but the homedir-derived `~/.claude` constant is
  now sourced from the shared resolver.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/init/executor.ts`
  Two STRAT-1 conversions: (1) the global-CLAUDE.md write path now uses
  `resolveInstallContext({ forceGlobal: true }).claudeRoot` instead of
  `process.env.HOME + '/.claude'`. (2) `detectExistingRufloMCP` derives
  the `<claudeRoot>/mcp.json` candidate via the resolver while keeping the
  `~/.claude.json` candidate (one level up from claudeRoot) on
  `process.env.HOME` because it's outside the install-context boundary.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/memory/memory-bridge.ts`
  Three workstreams in this file:
  1. STRAT-2 — replaced 19 `registry.get('foo')` reads with
     `caps.foo` (where `caps = getControllerCapabilities(registry)`).
     Helpers: `cacheGet`, `cacheSet`, `cacheInvalidate`, `guardValidate`,
     `logAttestation`. Bridges: `bridgeStorePattern`, `bridgeSearchPatterns`,
     `bridgeRecordFeedback` (×3), `bridgeRecordCausalEdge`,
     `bridgeDeleteHierarchical` (×2), `bridgeDeleteCausalEdge`,
     `bridgeDeleteCausalNode`, `bridgeSessionStart`, `bridgeSessionEnd` (×2),
     `bridgeRouteTask` (×2), `bridgeHealthCheck` (×2), `bridgeHierarchicalStore`,
     `bridgeHierarchicalRecall`, `bridgeConsolidate`, `bridgeBatchOperation`,
     `bridgeContextSynthesize` (×2), `bridgeSemanticRoute`. The two generic
     accessors `bridgeGetController(name)` and `bridgeHasController(name)`
     intentionally retain `registry.get(name)` because their input is an
     arbitrary string — typed view doesn't help.
  2. PERF-2 — added `bridgeSearchEntriesMulti({ namespaces, query, limit,
     threshold })`. Embeds the query once, runs ONE `SELECT … WHERE namespace
     IN (?, …)` SQL pass with the same hybrid (semantic + BM25) scoring as
     `bridgeSearchEntries`. Result shape matches `bridgeSearchEntries.results`
     plus a `searchedNamespaces` field.
  3. CLASS-1 — adopted `swallowError` at the line-1949 catch block
     (`bridgeDeleteHierarchical.hm.delete`).

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/memory/db-pool.ts`
  Adopted `swallowError` at all 5 sites (lines 124, 137, 162, 199, 205 in
  the original numbering). Each call carries a unique label so grep can
  triage which of the five paths fired (`db-pool.statSync`,
  `db-pool.close-stale`, `db-pool.persist-statSync`, `db-pool.invalidate-close`,
  `db-pool.invalidate-close-all`).

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/memory/embedder-resolver.ts`
  Adopted `swallowError` at the Ollama probe-failure catch (line 191 in the
  original numbering) with the hint `falling back to MiniLM`.

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/memory/rabitq-index.ts`
  Adopted `swallowError` at the metadata-persist catch (line 185 — the
  closest silent catch to the spec's "200" reference; line 200 in this file
  is a top-level structured-error return that intentionally already returns
  a `success:false` envelope).

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/mcp-tools/memory-tools.ts`
  PERF-2 — `memory_search_unified` now calls `bridgeSearchEntriesMulti`
  once instead of looping over namespaces. Falls back to the legacy
  per-namespace loop if the bridge import fails (cold path; bridge is the
  canonical search route in production).

## Probe replacements (STRAT-2)

- count: 19 / 22 replaced with typed `caps.foo` reads.
- 2 intentionally retained as `registry.get(name)`:
  `bridgeGetController(name)` and `bridgeHasController(name)` take an
  arbitrary string — there is no compile-time slot to point at.
- 1 not converted: the registry-init wiring block
  (`reg.set('reasoningBank', rb)` etc., lines ~130–290) is SET-side, not
  the GET-side probe class STRAT-2 targets.

The spec mentioned "22 probes" referencing init-block lines as part of the
count, but those lines are the registration code that builds the typed
surface, not the consumers. Reading the spec's "before/after" example
literally (replace `bridge.foo?.method` existence check with `caps.foo`),
the count of GET-side probes is 19, all of which were converted.

Method-level dual-API probes (e.g. `typeof rb.searchPatterns ??
rb.search === 'function'`) are preserved unchanged because they encode
real version-tolerance — the controller's API name varies across agentdb
alpha releases and the bridge needs to call whichever one ships in the
installed version.

## TypeScript check

- `cd v3/@claude-flow/shared && npm run build` — exit 0, 0 errors.
- `cd v3/@claude-flow/cli && npx tsc --noEmit` — exit 0, 0 errors.
- `cd v3/@claude-flow/cli && npx tsc` (full build) — exit 0, 0 errors.

7 transient errors surfaced during STRAT-2 conversion (all `Object is
possibly undefined` or `Property X does not exist on type 'object'` at the
union-typed return points). Resolved by adding explicit narrowing checks
(`typeof foo !== 'function'` early-return) or local `as` type assertions
for the dynamic-shape return objects (`r as { deletedNode?: boolean;
deletedEdges?: number }`). One stat-shape was tightened in the shared
interface (`CacheController.stats(): CacheStats` instead of `unknown`).

## Test results

- `cd v3/@claude-flow/cli && npx vitest run --no-coverage` — 88 test files,
  2473 tests total: **2418 passed, 47 skipped, 8 failed**.
- All 5 memory-bridge / memory-search / embedder test suites pass (19/19):
  `memory-bridge-pattern-additive`, `memory-search-unified-namespaces`,
  `memory-search-recall-bug43`, `memory-search-threshold-default`,
  `embedder-resolver-bug43`. memory_search_unified-specific test still
  passes after the PERF-2 collapse.
- The 8 failures are pre-existing and unrelated to this batch:
  - 6 × `router-bandit.test.ts` — vitest worker can't `process.chdir()`
    (`ERR_WORKER_UNSUPPORTED_OPERATION`). Test infrastructure bug.
  - 1 × `commands-deep.test.ts > should deny reading .env files` — test
    asserts `Read(./.env)` but settings-generator already migrated to
    `Read(**/.env*)` (intentional, see `settings-generator.ts:69-72`
    comment block #bug10.2).
  - 1 × `integration-docker.test.ts > package.json defines build script as
    tsc` — environmental check unrelated to my files.
  - (1 × `pq-validation.test.ts` failed-suite from a missing
    `../../@claude-flow/memory/src/hnsw-index.js` import — pre-existing
    file-resolution issue.)
- Confirmed pre-existing by running `git stash` to revert my changes — same
  8 failures appeared on a clean tree.

## Open questions / followups

1. **Controller wiring still uses `reg.set/registry.get`** in the init
   block (lines ~130–290). Converting that to typed setters is a separate
   refactor (would require widening `ControllerRegistryLike` with `set`).
   Out of scope for STRAT-2 as written — it's about consumer-side
   type-safety, not init-side.

2. **`registry.get(name)` generic accessors** (lines 1359, 1376) — these
   take an arbitrary string from the caller. Cannot be typed against
   `ControllerCapabilities` without a `keyof` constraint in the API. If we
   want to lock callers into the known-controller set, the signatures of
   `bridgeGetController` and `bridgeHasController` should change to
   `name: keyof ControllerCapabilities`. Left untouched to avoid an API
   break.

3. **Template-string call sites** — the spec referenced
   `helpers-generator.ts:55,636,652,787,1219`,
   `statusline-generator.ts:168,588`, `executor.ts:331,388` as STRAT-1
   call sites. These are emitted JavaScript inside generator template
   strings (rendered into runtime helper scripts at init time). They run
   in a different process from the CLI and import `os` themselves; they
   can't reach `@claude-flow/shared`. Not converted. The remaining genuine
   call sites (`settings-generator.ts:33`, `executor.ts:846/1958`) are
   converted.

4. **`init/types.ts:250` `detectPlatform()`** uses `os.homedir()` to
   populate `PlatformInfo.homeDir` — that's a literal homedir, not the
   install-context truth, so it stays on `os.homedir()` directly. Not
   converted.

5. **`production/error-handler.ts`** was modified in parallel by
   coder-quickfix (per the spec's worker-coordination notes). My batch
   does not touch that file.

6. **Workspace `node_modules/@claude-flow/shared` is a copy, not a
   symlink.** I synced the freshly-built shared dist to
   `/Users/h4ckm1n/dev/SwarmOps/node_modules/@claude-flow/shared/dist/`
   so cli's TypeScript resolution picks up `swallowError` /
   `getControllerCapabilities` / `resolveInstallContext`. A `pnpm install`
   or workspace-link refresh will be needed before publishing — the
   shared-package version bump might also need to be considered.

7. **Pre-existing `commands-deep.test.ts` deny-list assertion** is stale
   relative to the actual settings-generator output. Worth a 1-line test
   update in a follow-up PR.
