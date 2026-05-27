# Gap 1 CLI Result

## Files created
- `v3/@claude-flow/cli/src/commands/trace.ts` (~520 lines)
- `v3/@claude-flow/cli/__tests__/commands-trace.test.ts` (~370 lines, 25 tests)

## Files modified
- `v3/@claude-flow/cli/src/commands/index.ts` — three surgical edits
  - Added `trace: () => import('./trace.js')` to `commandLoaders`
  - Added `getTraceCommand()` async accessor next to `getCacheStatsCommand()`
  - Added `traceCmd` to `getCommandsByCategory()`'s analysis bucket
    (alongside `cacheStatsCmd`, matching the cache-stats-of-the-day pattern)

## Subcommands implemented

### `swarmops trace list`
- Flags: `--since <relative|iso>`, `--agent <substring>`, `--limit/-n <n>` (default 50), `--json`
- Default output: `output.printTable` with columns `id` (truncated to 12 char prefix), `agent`, `task` (50-char truncate), `steps`, `started` (relative — "2h ago"), `success` (✓/✗/—)
- Empty store path: prints a friendly "no trajectories — run an agent dispatch first" hint
- Unparseable `--since`: exits 1 with hint listing accepted formats; never reaches the loader

### `swarmops trace replay <id>`
- Flags: `--open`, `--json`
- Output path: `<claudeRoot>/.claude-flow/traces/<full-session-id>.html` (mkdir -p, full id used to avoid prefix-collision over-write)
- `--json`: emits raw `LoadedTrajectory` to stdout (parseable for shell pipelines), no HTML written
- `--open`: spawns `open` (darwin) or `xdg-open` (linux), `detached: true`, `stdio: 'ignore'`, `child.unref()`. On other platforms (Windows etc.), prints a warning and skips — does not fail the command.
- Error paths:
  - missing arg → exit 1, prints usage
  - id < 8 chars (and not 'latest') → exit 1, prints "too short" hint
  - not-found → exit 1, prints "no trajectory found" + "use trace list" hint
  - ambiguous prefix → exit 1, prints first 5 matches and "add more chars" hint. Disambiguation re-runs `listTrajectories({ limit: 1000 })` to surface the candidates (the loader returns null in both cases, so we re-derive matches in the CLI).

### `swarmops trace prune`
- Flags: `--older-than <relative|iso>` (default 30 days), `--dry-run`, `--json`
- Walks `<claudeRoot>/.claude-flow/traces`, only considers `*.html` files (non-html files like `NOTES.txt` are left alone — verified by test). Compares `mtime` to cutoff.
- `--dry-run`: lists what would be deleted, deletes nothing
- Default: deletes via `unlinkSync`; per-file `swallowError` on unlink failure so a single permission error doesn't abort the prune
- Missing `<traces>` directory: exits 0 with a benign "nothing to prune" message
- Unparseable `--older-than`: exit 1 with hint

## Relative-time parser (inline)
- ISO 8601 (lead with `\d{4}-\d{2}-\d{2}` → tries `new Date()` first)
- Shorthand: `15s`, `5m`, `2h`, `7d`, `1w`
- English phrases: `"30 days ago"`, `"1 hour ago"`, `"yesterday"`
- Fallback: tries `new Date(raw)` for things like `"2026-05-08 14:00"`
- Returns `null` on garbage (not a thrown error — the call sites surface friendly messages)
- Exposed via `__test` for unit testing without going through CLI parser

## Tests
- **Count**: 25 tests, all passing
- **Mocking strategy**:
  - `vi.mock('../src/services/trace-loader.js', ...)` with `mockListTrajectories` and `mockLoadTrajectory` vi.fns — fully decouples from real store.json
  - `vi.mock('../src/services/trace-renderer.js', ...)` with `mockRenderTrace` — we don't depend on the real renderer's HTML output, only that it gets called with the right trajectory and its return is written to disk
  - `vi.mock('node:child_process', ...)` for `spawn` — `vi.spyOn` fails on `node:child_process.spawn` because Node marks it non-configurable, so we mock the whole module up-front. The mock returns `{ unref: () => undefined }` so production's `child.unref()` doesn't throw.
  - `process.env.RUFLO_INSTALL_CONTEXT_JSON` per-test override → `claudeRoot` points at a `mkdtempSync` dir, so trace files get written into a per-test scratch space and torn down in `afterEach`. This avoids polluting the dev's real `~/.claude/.claude-flow/traces`.
  - Used `mockReset()` per-mock + `mockSpawn.mockClear()` in `beforeEach` rather than `vi.resetAllMocks()`, because resetAllMocks would wipe the spawn mock's `unref` implementation
- **Coverage breakdown**:
  - 5 tests for `parseRelativeTime` (shorthand, English, yesterday, ISO, garbage)
  - 2 tests for `formatRelative`
  - 4 tests for `trace list` (correct args passed, --json output, error path, empty store)
  - 6 tests for `trace replay` (writes HTML, --json bypass, --open spawn behaviour platform-aware, not-found, ambiguous, missing arg)
  - 7 tests for `trace prune` (--dry-run preserves, default 30d threshold, --older-than, --json, missing dir, unparseable threshold, only-touches-html)
  - 1 test for top-level command wiring (subcommands present)

## TypeScript
- `cd v3/@claude-flow/cli && npx tsc --noEmit -p .` → exit 1 with **only** the pre-existing `@ruvector/sona` error (excluded per task spec). Zero errors from `commands/trace.ts` or `commands/index.ts`.
- One minor fix during implementation: changed `unitToMs(unit) * n` → guard the null first (TS strictNullChecks).

## Notes for the integration tester
- The `__test` and `__testSubcommands` exports at the bottom of `trace.ts` are test-only escape hatches. Integration tests that go through the CLI parser (e.g. `swarmops trace list` via process spawning) do NOT need them. They exist to let unit tests invoke subcommand `action`s with a hand-built `CommandContext`. If you keep them, document them as `@internal` later — for now they're load-bearing for the test suite.
- The `findAmbiguousMatches` helper reruns `listTrajectories({ limit: 1000 })` on the not-found path. This is a small ~O(N) scan over the trajectory list and only fires when `loadTrajectory` already returned null, so the cost is negligible. If we ever push trajectory counts past ~10K we can add a dedicated `loader.findAmbiguousMatches()` API instead.
- I did NOT add a top-level `trace` accessor to `commandsByCategory.analysis` (the deprecated synchronous one) — only to `getCommandsByCategory()`. That matches the cache-stats integration. The deprecated sync export is empty for analysis anyway.
- All three `--json` modes emit valid stable JSON parseable by `jq`. The `replay --json` path has the cleanest shape (raw `LoadedTrajectory`); `list --json` wraps in `{count, trajectories}`; `prune --json` wraps in `{dryRun, olderThan, candidateCount, deletedCount, candidates, deleted}`.
- Files are NOT committed. Lead handles the commit/push.
