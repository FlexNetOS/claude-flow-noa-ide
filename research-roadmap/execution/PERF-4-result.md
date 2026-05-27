# PERF-4 Result

## Sites changed

- **`v3/@claude-flow/cli/src/ruvector/graph-analyzer.ts:358`** — old: `new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')` rebuilt per call to `shouldExclude(path)`; new: `getExcludeRegex(pattern)` reads from a module-scoped `excludePatternRegexCache: Map<string, RegExp>` (lazy build on first sight, then reused). Strategy: **Map cache** (the input pattern is dynamic per scan but bounded — typically 5-10 entries from the user-supplied `exclude` array). Cache lives at module scope alongside the existing `graphCache` / `analysisResultCache`. Pattern semantics preserved exactly: `*` -> `.*`, anchored with `^…$`, no flags.

- **`v3/@claude-flow/cli/src/production/error-handler.ts:354`** — old: `new RegExp(\`${key}[=:]?\\s*["']?[^\\s"']+["']?\`, 'gi')` constructed inside the per-key `for` loop on every `sanitizeMessage()` call (= every emitted log line × `SENSITIVE_KEYS.length`); new: `SENSITIVE_KEY_REGEX_CACHE: Map<string, RegExp>` pre-built **once at module load** by mapping over the static `SENSITIVE_KEYS` array. Strategy: **eager Map** (keys are static, fully knowable at module init). The `g` flag is preserved; verified via direct execution that `String.prototype.replace` resets `lastIndex` so reusing the cached `/g` regex is idempotent across calls (1st/2nd/3rd invocation produce identical output). Pattern, flags, and capture behavior preserved verbatim.

- **`v3/@claude-flow/cli/src/init/helpers-generator.ts:291`** — this site lives **inside a template-literal string** that is emitted as the generated `.claude/helpers/router.js` CJS file (`generateAgentRouter()`), not in the TypeScript module's own runtime. The hot path is therefore `routeTask()` *inside the generated script* (called from `router.js <task description>` CLI invocations). Old: `new RegExp(pattern, 'i')` rebuilt per pattern per call; new: a module-top `COMPILED_TASK_PATTERNS` array (`Object.entries(TASK_PATTERNS).map(([pattern, agent]) => [pattern, new RegExp(pattern, 'i'), agent])`) built **once at the generated script's load** and iterated as `[pattern, regex, agent]` tuples in the loop. Strategy: **eager pre-compilation** (patterns are baked into the template, fully static). Behavior preserved — same iteration order, same `i` flag, same `pattern` interpolation in the matched-reason string.

## Tests run

All run via `npx vitest run` from `v3/@claude-flow/cli`:

- `__tests__/ruvector/graph-analyzer.test.ts` — **29 passed | 1 skipped** (covers `shouldExclude` indirectly via dependency-graph build calls).
- `__tests__/init-generators-global-install.test.ts` — **8 passed** (imports from `helpers-generator`, exercises the emitted router template surface).
- `__tests__/init-auto-memory-loader.test.ts` — **4 passed** (other helpers-generator export, sanity).
- `__tests__/security-audit.test.ts` — **25 passed** (`ErrorHandler Sanitization` block; reproduces the redaction logic locally rather than importing, so it pins the pattern-spec my cached regex must satisfy — both code paths produce the same `[REDACTED]` output).

**Total: 65 passed | 1 skipped.**

Plus an out-of-band smoke test executed with `npx tsx`: imported `ErrorHandler`, called the private `sanitizeMessage` against four inputs (password, api_key, authorization, no-match) — confirmed correct redaction. Then ran the same input three times consecutively against the cached `/gi` regex — output identical each time, confirming `lastIndex` is reset by `String.prototype.replace` and the cache is safe for high-frequency reuse.

## TypeScript check

`cd v3/@claude-flow/cli && npx tsc --noEmit -p .` — **exit 0** (clean).

## Notes

- **Hot-path ranking confirmed**: `error-handler.ts` is the biggest win — `SENSITIVE_KEYS.length = 9`, so the old code paid 9 `RegExp` constructions × every emitted log line. The new code pays 9 *once* at module load and 0 per call. `graph-analyzer.ts` is second (one regex per non-glob exclude pattern per directory entry visited; previously rebuilt every traversal step, now built once per unique pattern and cached for the process lifetime). `helpers-generator.ts` is the smallest absolute win (router.js is invoked once per CLI command), but the fix is identically cheap and improves the generated artifact's quality, which is part of the user-facing surface.
- **Pre-existing quirk noted, not changed**: the smoke test surfaced that `'no secrets here'` becomes `'no secret=[REDACTED] here'` because `secret` matches as a substring of `secrets` and the `[=:]?` makes the separator optional. This behavior existed before my edit and is preserved verbatim — would be a separate ticket if false-positive redaction is undesirable. Out of scope for PERF-4.
- **Why eager-Map for `SENSITIVE_KEYS` over lazy**: the key set is statically knowable at module load (9 entries, no dynamic additions anywhere in the codebase per `grep -n "SENSITIVE_KEYS"`), so eager construction has zero downside (~9 RegExp objects allocated once vs. a `Map.get` + branch on first-call path). Keeps the call site to a single `Map.get(key)!` lookup.
- **Why lazy-Map for `graph-analyzer` exclude patterns**: the input set is user-controlled (`options.exclude`), so we can't enumerate it at module load. Lazy population keeps the cache scoped to actually-seen patterns.
- **No changes outside the three listed files.** `memory-bridge.ts` not touched.
- **Build still green** (TypeScript exit 0, all touched-area tests pass). Safe to land.
