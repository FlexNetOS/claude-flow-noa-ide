# Gap 1 Loader Result

## Files created

- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/src/services/trace-loader.ts` (300 lines)
- `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/cli/__tests__/trace-loader.test.ts` (300 lines, 19 tests)

No other files touched. `services/index.ts` was deliberately NOT modified — exporting from the barrel is left to `coder-trace-cli`/`coder-trace-renderer` if they need it; importing the file directly via `'../services/trace-loader.js'` works today (the contract path).

## API

### `listTrajectories(opts?)`

- Resolves store via `resolveInstallContext()` → `path.join(claudeRoot, '.claude-flow', 'memory', 'store.json')`.
- Returns `[]` when the store doesn't exist OR is malformed JSON OR is missing `.entries` — every failure path runs through `swallowError` so debug builds get a breadcrumb.
- Filter order: `since` → `agent` substring (case-insensitive) → sort newest-first → slice to `limit` (default 50).
- Trajectory detection mirrors `hooks-tools.ts`: `key.includes('trajectory')` OR `metadata.type === 'trajectory'`.
- Malformed entries are coerced through `coerceTrajectory()` and skipped (not crashed-on) when required fields are missing or wrong-typed; one `swallowError` call per skip with the entry key.
- `since` filter drops trajectories whose `startedAt` is unparseable — without a real timestamp we can't honour the bound.

### `loadTrajectory(sessionId)`

Resolution order, all on the SAME pre-loaded list:

1. Empty / non-string id → `null`.
2. `'latest'` → newest by `startedAt`.
3. **Exact match** on `t.id === sessionId` — wins regardless of length, including for short ids.
4. Length < 8 → `null` (no prefix lookup).
5. Length ≥ 8 → prefix match. Zero matches → `null`. Exactly one → return it. ≥ 2 → `null` + `swallowError('trace-loader.ambiguous-prefix', …)` with the comma-joined match list as the hint.

Sort comparator (`byStartedAtDesc`) is total-order safe: parses both timestamps, falls back to lexicographic compare if either is unparseable, never throws.

## Tests

- File: `__tests__/trace-loader.test.ts`
- Count: **19 tests, 19 passed, 0 failed** (vitest 1.6.1, ~12ms run)
- Strategy: each test seeds a temp `claudeRoot` via `mkdtempSync`, pins `RUFLO_INSTALL_CONTEXT_JSON` so `resolveInstallContext()` returns that root, writes a hand-crafted `store.json`. No `vi.mock`, no module-level state to reset.

Edge cases covered:
- Store missing → `[]` / `null` (no throw)
- Malformed JSON → `[]` / `null`
- Sort order (newest-first) on 3 + 4 + 75 entries
- `since` boundary (>= comparison)
- `agent` case-insensitive substring
- Default `limit` = 50 (75-entry stress test)
- `limit` applied AFTER sort (verified: top-2 are the two newest, not the two earliest)
- Mixed metadata-tagged entries (key without "trajectory") still detected
- Malformed entries skipped, good entries kept
- Exact-id wins over short prefix
- Prefix < 8 chars → null
- Prefix ≥ 8 chars unique match → returns it
- Prefix ambiguous → null (with `swallowError`)
- `'latest'` shorthand correctness
- `endedAt` + `success` preserved when present
- Malformed steps inside a valid trajectory are skipped (good steps still returned, default quality 0.5 applied)

## TypeScript

- `cd v3/@claude-flow/cli && npx tsc --noEmit -p .`
- Exit code: **0 errors from new code**
- Only diagnostic emitted: the pre-existing `Cannot find module '@ruvector/sona'` in `src/memory/sona-optimizer.ts:250` (explicitly excluded per the brief).

## Notes

- I picked `metadata: { type: 'trajectory' }` on the test fixtures by default so the `coerceTrajectory` path is exercised even when the key doesn't include "trajectory". The detection predicate is the OR of both signals to match `getIntelligenceStatsFromMemory()` in `hooks-tools.ts:501-504`.
- `coerceTrajectory` quietly applies `quality = 0.5` when missing on a step. Matches the existing default in `hooks-tools.ts` and the spec note that "quality defaults to 0.5; not yet a signal worth visualizing prominently".
- Module has zero side-effects on import — no module-level state, no daemons, no FS writes. Each call re-reads `store.json`, which is the right tradeoff at this scale (store.json is single-digit KB to single-digit MB; the renderer + CLI will call this at most a handful of times per invocation).
- Renderer + CLI agents can import from `'../services/trace-loader.js'` exactly as the brief specifies. The exported surface is intentionally minimal: `listTrajectories`, `loadTrajectory`, `LoadedTrajectory`, `ListOptions`. Internal helpers (`getStorePath`, `readStore`, `coerceTrajectory`, `collectTrajectories`, `byStartedAtDesc`, `isTrajectoryEntry`, `MIN_PREFIX_LENGTH`) are all non-exported.
- One stylistic deviation worth flagging for review: I used Node's `'node:fs'` / `'node:path'` import scheme to match the test file convention in `agent-execute-prompt-cache.test.ts`. The rest of `services/` is mixed but `'node:'` is what the recent code lands on.
