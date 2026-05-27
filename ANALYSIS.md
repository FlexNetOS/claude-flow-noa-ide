# SwarmOps Deep Audit — Executive Synthesis
*2026-05-08, post-PR-1828 (56 commits, 25 bugs, ~140 tests), 6-analyst parallel audit*

## TL;DR

The fork is structurally sound and well-tested in the patches it shipped, but three classes of architectural debt remain (no `resolveInstallContext` helper, duck-typed controllers, no schema-version envelope) that will keep producing the same kind of bugs PR-1828 just fixed. The single highest-leverage day of work is a 5-bug "Ship now" batch — disable `skipDangerousModePermissionPrompt`, `npm audit fix`, fix the silent-MCP hang on bare `ruflo`, sed `claude-flow` → `ruflo` in help text, and route `memory store/search` through the existing daemon — which together kill ~70% of security risk, fix the worst first-impression UX papercut, and cut the most-called CLI op by 98%. After that, the strategic move is **not more code** but **deleveraging**: hoist the three repeated truths into `@claude-flow/shared` so the next round of bugs never gets written.

## State of the fork

### Strengths (what we already nailed)
- **MCP-first architecture is real and clean** — one `MCPTool` contract, one registry, both stdio and intra-CLI consume the same map (ADR-005 actually implemented).
- **Memory-bridge centralization** at `memory-bridge.ts:60-280` — single resolution point for 8 controller slots with lazy-init lifecycle.
- **MCP tool descriptions are best-in-class** — UX analyst called them "the best on any MCP server"; `agent_spawn` cooperates with native `Task` instead of competing with it.
- **`ruflo doctor` is the strongest single thing in the product** — 16 parallel checks, color-coded, advisory `--fix`. The Config-collision check alone justifies the tool.
- **README's two-path Quick Start table** preempts the #1744 install-mode confusion.
- **PR-1828's regression tests cluster correctly** around `init/`, `memory/`, `mcp-tools/`, `validate-input-*` — exactly the bug-bearing surfaces.

### Real issues remaining (ranked severity × effort_inverse)

1. **`skipDangerousModePermissionPrompt: true`** in `~/.claude/settings.json:375` — CRIT, XS. Combined with prefix-wildcard allowlist, it's a one-shot prompt-injection-to-RCE chain.
2. **`npm audit`: 14 vulns (4 high) in undici 7.x + yaml** — CRIT, XS. CRLF/smuggling/DoS chain shipped in the tree.
3. **Bare `ruflo` silently launches MCP server** — HIGH, S. Hangs with one log line, no help, no exit. Worst first impression.
4. **27 lines of subsystem init noise on every memory/route/swarm command** — HIGH, M. Signal-to-noise ~5%; piping impossible.
5. **`memory store/search` 440 ms per call** (vs ~10 ms via daemon) — HIGH, S. Daemon exists at PID 64888; CLI just doesn't use it.
6. **CLI cold-start floor 210 ms** — MED, M. Eager top-level `await import()` of full v3 tree per invocation.
7. **`hooks.ts` 5,315 LoC + `hooks-tools.ts` 4,316 LoC, ~5% test coverage** — HIGH, M. 3 of 8 PR-1828 bugs lived here.
8. **Path-traversal via unvalidated `session_id`** in 3 hook files — HIGH, XS. `gsd-context-monitor.js:35,42`, `gsd-statusline.js:34`, `helpers/statusline.cjs:268`.
9. **`embedding-cache.json` (5 MB) parsed on every `embedTexts()` call** — MED, S. 41% of `bug25-verify.mjs` runtime.
10. **`agent list` shows "Invalid Date" + truncates names at 13 chars** — MED, S. Bug 22's win undermined by unusable table.
11. **All help text + CLAUDE.md still says `claude-flow`** — LOW, XS. README typo `npx ruvflo init` (line 30) breaks first-failure copy-paste.
12. **OpenIsland's `*`-matcher double-fires every PostToolUse**; `_openIslandStatusLine` silently shadowed ruflo's statusline.
13. **352 MB RSS on long-running MCP server** (vs 107 MB fresh) — MED, L. Probable unbounded embeddings cache.
14. **AIDefence shipped but never invoked at runtime** — HIGH, S. Exposed only as a tool the model can call itself.

### Architectural debt themes (META findings)

**META-A: Implicit truths replicated across boundaries.** Three questions get answered locally everywhere: "where is my data dir?" (Bugs 1/7/8 — three different cwd-vs-home approximations across `helpers-generator.ts`, `settings-generator.ts`, `memory-tools.ts`), "is this controller capable of X?" (Bug 2 — duck-typed `typeof x.foo === 'function'` in `memory-bridge.ts:1392-1438`), "what schema version is this file?" (mixed `version` vs `schemaVersion`, no envelope on live state files). **Single highest-leverage architectural fix**: hoist all three into `@claude-flow/shared` so the next round of bugs becomes literally impossible to write.

**META-B: Extension points exist on paper, not in code.** ADR-004 ships `plugin-interface.ts` + `plugin-registry.ts` but **nothing** in the CLI runtime invokes them. The 26 ruflo plugins in `marketplace.json` extend by shelling out to `npx claude-flow hooks` from `hooks.json` — bypassing every contract the registry was built to enforce.

**META-C: Three independent processes, no supervisor, shared SQLite.** `mcp-server.ts`, `worker-daemon.ts`, and the CLI all mutate `.swarm/memory.db` concurrently. `daemon-state.json` shows 96 audit + 82 map runs — concurrency is real production load.

**META-D: Test coverage map mirrors the bug map.** PR-1828's 140 tests cluster in `init/`, `memory/`, `mcp-tools/`. The two largest 0%-coverage surfaces — `commands/hooks.ts` (5,315 LoC, 1 test) and `services/headless-worker-executor.ts` (1,362 LoC, 0 tests) — are exactly where the daemon runs in production.

**META-E: Routing is bimodal — built-ins get HNSW, user-installed get bag-of-words.** Live test: `kali-metasploit` matched a JWT-auth-refactor task on tokens `module/multi/work`. The fork is half-solving the problem it shipped to solve.

## Roadmap

### Ship now (Bugs 26–32 — 1-day batch, ~6h total)

| # | Bug | File:Line | Effort | Impact |
|---|---|---|---|---|
| 26 | Disable `skipDangerousModePermissionPrompt` | `/Users/h4ckm1n/.claude/settings.json:375` | XS | CRIT |
| 27 | `npm audit fix` for undici / yaml CVEs | `/Users/h4ckm1n/dev/SwarmOps/package.json` lockfile | XS | CRIT |
| 28 | Bare `ruflo` should print help, not start MCP | `/Users/h4ckm1n/dev/SwarmOps/cli/bin/cli.js` | S | HIGH |
| 29 | `claude-flow` → `ruflo` in all help text + README | `*-generator.ts`, `README.md:30`, `CLAUDE.md` (12 occ.) | XS | HIGH |
| 30 | Validate `session_id` regex in 3 hook files | `~/.claude/hooks/gsd-context-monitor.js:35,42`, `gsd-statusline.js:34`, `helpers/statusline.cjs:268` | XS | HIGH |
| 31 | Route `memory store/search` through daemon socket | `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/commands/memory.ts` | S | HIGH |
| 32 | mtime-keyed LRU around `loadCache()` in `ollama-embedder.js` | `ollama-embedder.js:196` | S | MED |

**Total: ~6 hours. Eliminates ~70% of security risk + worst UX papercut + most-called CLI op latency.**

### Next sprint (1–2 weeks, structural)

- **Bug 33**: Wire `aidefence_scan` into `UserPromptSubmit` + `PreToolUse:WebFetch` hooks.
- **Bug 34**: Replace `permissions.allow` prefix-wildcards with exact subcommands; add `permissions.deny` for `--eval`, `| sh`, `curl`, `wget`.
- **Bug 35**: Strip init-noise to `~/.claude/logs/`, gate by `RUFLO_LOG_LEVEL`.
- **Bug 36**: Lazy command loading in `bin/cli.js`. Projected -80 to -120 ms on every CLI invocation.
- **Bug 37**: Fix `agent list` table (drop empty ID col, widen names to 30, `—` for missing dates).
- **Bug 38**: `ruflo doctor --hooks` to detect competing `*`-matchers (OpenIsland coexistence).
- **Bug 39**: Index plugin MCPs + claude.ai MCPs in `guidance_capabilities` (parse `~/.claude/.mcp.json` at startup).
- **Bug 40**: Semantic ranker on user-installed skills (same MiniLM HNSW as built-ins).
- **Bug 41**: Smoke tests for `commands/hooks.ts` + `services/headless-worker-executor.ts`.
- **Bug 42**: `chmod 0600` on `~/.claude/.claude-flow/data/*.json{,l}`, `sessions/*`, `settings.json*` backups; add to `doctor --fix`.

### Strategic (1-month+, architectural deleveraging)

- **STRAT-1 (META-A)**: Add `shared/src/install-context.ts` exporting `resolveInstallContext()`. Eliminates Bugs 1/7/8 root cause permanently. **Highest-leverage architectural change.**
- **STRAT-2 (META-A)**: Add `ControllerCapabilities` interface to `@claude-flow/shared`; replace every `typeof x.foo === 'function'` probe in `memory-bridge.ts:1392-1438`.
- **STRAT-3 (META-A)**: Standardize `_schema: { version, migratedAt }` envelope across all JSON state writers + `migrateIfNeeded()` in each loader.
- **STRAT-4 (META-D)**: Split `commands/hooks.ts` and `mcp-tools/hooks-tools.ts` along their 5 implicit subsystem axes (sona/ewc/moe/flash/lora + metrics + intelligence_stats). **Do this AFTER STRAT-1**, otherwise you get five smaller files with the same bugs.
- **STRAT-5 (META-C)**: `LifecycleSupervisor` + advisory file lock on `.swarm/memory.db`.
- **STRAT-6**: Wire Ollama into `embeddings_init` (`ollama:mxbai-embed-large`, 1024-dim). Write the migration tool **before** the corpus grows past 13 entries.
- **STRAT-7**: Enable `noUncheckedIndexedAccess` + `noImplicitAny: true` in `v3/tsconfig.base.json`; audit the 176 `: any`.
- **STRAT-8**: Either wire runtime `PluginRegistry` to `marketplace.json` (META-B) or rewrite ADR-004 honestly.
- **STRAT-9**: Memory-leak triage on long-running MCP server (352 MB vs 107 MB fresh).

### Won't fix (with reasoning)

- **Rewrite `statusline-command.sh` in Node** — perf analyst projected only -15 ms net (Node spawn ≈ 12× jq forks).
- **Build out HNSW over the 216-vector corpus** — at this scale linear cosine is <1 ms. Premature; revisit at 10k.
- **Replace 763 `console.log` with structured logger** — high churn, low ROI vs the targeted log-noise gating in Bug 35.
- **Wire `marketplace.json` plugins to runtime registry** — only if you commit to the microkernel; otherwise rewrite ADR-004 (cheaper, more honest).
- **Move all 27 `os.homedir()` calls behind `fs-secure.ts`** — STRAT-1 subsumes this.
- **Long-running Node hook daemon (Unix socket)** — too much surgery; rewrite `pre-bash` action as bash and keep Node only for stateful hooks gets 80% of the win.

## Per-analyst highlights

- **Architecture** (`/tmp/swarm-analysis/architecture.md`): hooks.ts/hooks-tools.ts giants are #1; microkernel exists on paper, never wired. → STRAT-1, STRAT-2, STRAT-4, STRAT-8.
- **Performance** (`/tmp/swarm-analysis/performance.md`): CLI floor 210ms, memory ops 440ms, embedding cache 10.5ms × N. HNSW claim in CLAUDE.md is unsubstantiated (no `*.hnsw*` files exist). → Bugs 31, 32; STRAT-6.
- **Security** (`/tmp/swarm-analysis/security.md`): risk score 48/100. Top-5 fixes total ~90 minutes and eliminate ~70% of risk. AIDefence shipped but inert.
- **Code quality** (`/tmp/swarm-analysis/code-quality.md`): hooks.ts 5,315 LoC with 1 test; headless-worker-executor 1,362 LoC with 0 tests. 678 silent `} catch {`. tsconfig opts out of strictest checks. → STRAT-4, STRAT-7; Bug 41.
- **UX/DX** (`/tmp/swarm-analysis/ux-dx.md`): MCP descriptions excellent; bare-invocation hang + log-noise + stale `claude-flow` references are the 3 papercuts. → Bugs 28, 29, 35, 37.
- **Integration** (`/tmp/swarm-analysis/integration.md`): Bugs 22/23/24 partial wins, Bug 25 still broken (Ollama unwired). 25 plugin MCPs invisible to routing. OpenIsland double-handling. → STRAT-6; Bugs 38, 39, 40.

## What a Senior Reviewer Would Say

Reading PR #1828 cold, an Anthropic platform-eng reviewer's gut would be: "This is a serious, careful piece of work — 56 commits with 140 regression tests means somebody actually shipped, not just refactored. The MCP-aggregation pattern is clean, the doctor check is the kind of thing I'd want in our own tooling, and the bug fixes show real understanding of the failure modes. **But the diff is symptom-treatment, not root-cause work.** The same `cwd.replace('/', '-')` confusion that caused Bug 7 lives in three more places I can grep for in 30 seconds; the same duck-typed controller dispatch that caused Bug 2 is the entire `memory-bridge.ts:60-280` design. I'd merge it — the tests are real and the bugs are real — but I'd open a follow-up issue titled 'Hoist install-context, controller-capabilities, and schema-version into shared' and tag it as blocking the next minor release. Without that, you'll be back here in three months fixing Bugs 26-50 from the same root causes." That's the honest take. The fork is **production-grade for what it touched** and **carrying real architectural debt for what it didn't**.

## Recommended dispatch

**RIGHT NOW**: open Bugs 26–32 as a single 1-day batch. Order: (26) flip `skipDangerousModePermissionPrompt` → (27) `npm audit fix` → (30) session_id regex (30 min total, kills the worst CRIT/HIGH security exposure). Then (29) the `claude-flow`→`ruflo` sed (15 min, fixes README copy-paste failure). Then (28) bare-`ruflo` TTY check (1-2h, biggest first-impression win). Then (31) daemon-routing for `memory store/search` (2-3h, biggest perf win on most-called op). End with (32) embedding-cache LRU (1h). **Swarm shape**: hierarchical, 3 agents — `security-architect` owns 26/27/30, `coder` owns 28/29/31/32, `tester` writes regression tests + runs `npm audit` and `bug25-verify.mjs`-style perf microbench. Skip strategic work this week; ship the batch, file Bugs 33-42 as a follow-up sprint, tag STRAT-1/2/3 as the architectural-deleveraging milestone for next month. **Do not touch hooks.ts splitting until install-context lands** — refactoring the giant before the shared abstraction exists just produces five smaller files with the same bugs.
