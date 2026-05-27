# Swarm Brief — fix/global-install-and-learning-loop

8 bugs in ruflo v3.7.0-alpha.11 from in-depth testing of a globally-installed `~/.claude` setup. See `RESEARCH.md` for exact file:line locations and fix shapes.

## Bugs (priority order)

1. **CWD-relative paths in helpers** — generated `helpers/memory.js`/`session.js` write to `process.cwd()/.claude-flow/`. See `helpers-generator.ts:78,285` (+6 more sites).
2. **bridge-fallback vs reasoningBank fragmentation** — store and search hit different controllers. `memory-bridge.ts:1331-1438`. Make search additive.
3. **HNSW counter stuck at 0** — stats reads JSON store, not real backend. `hooks-tools.ts:558,2918`. Query real backend (memory-bridge.ts:1091 / memory-initializer.ts:611).
4. **memory_search_unified hardcoded namespace allowlist** — `memory-tools.ts:862`. Replace literal with `SELECT DISTINCT namespace`.
5. **Learning loop disconnect** — `intelligence.cjs:564` writes pending-insights.jsonl, `hooks-tools.ts:1063` (`hooks_metrics`) never reads it. Add drain (with offset tracking for idempotence).
6. **Subsystems "not-loaded"** — moe/flash/etc reported as features but stub responses. `hooks-tools.ts:2807,2829,2857,2874,2933-2937` + `agentdb-tools.ts:60`. Either load properly OR omit from output.
7. **memory_import_claude returns 0** — wrong cwd encoding at `memory-tools.ts:696-707`. Share enumerator with `memory_bridge_status` at line 786.
8. **settings.json hook template** — `init/settings-generator.ts:184,209` emits `${CLAUDE_PROJECT_DIR:-.}/.claude/...` which double-`.claude`s on global install. Branch on install mode.

## Branch / build / test
- Branch: `fix/global-install-and-learning-loop`
- Build: `npm install && npm run build`
- Tests: `npm test` (vitest)
- Source: `v3/@claude-flow/cli/src/`
- Templates emit runtime files into `.claude/helpers/`

## Commit message format
`fix(<area>): <name> (#bug<N>)` — atomic per bug, do NOT batch.

## Coordination
- 4 coders work in parallel on disjoint files (paths, controllers, counters, search)
- Each coder runs `npm run build` after their commits
- Tester runs the full suite + adds regression tests
- Reviewer pushes to user's fork and opens PR to ruvnet/ruflo
