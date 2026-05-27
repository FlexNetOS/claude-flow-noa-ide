# Gap 4 Cost CLI Result

## Files created
- `v3/@claude-flow/cli/src/commands/cost.ts` (628 lines) — `swarmops cost` command surface (stats, session, models, reset) with shared format helpers (`formatUsd`, `formatTokens`, `formatPct`, `summarizeFromEntries`).
- `v3/@claude-flow/cli/__tests__/commands-cost.test.ts` (468 lines) — 23 tests covering subcommand wiring, format helpers, JSON output, empty-state, and reset confirmation flow.

## Files modified
- `v3/@claude-flow/cli/src/commands/index.ts` — registered `cost` in three places:
  - `commandLoaders` (lazy import)
  - `getCostCommand()` async accessor (alongside `getCacheStatsCommand` and `getTraceCommand`)
  - `getCommandsByCategory()` Promise.all + `analysis` category list

Surgical edits only — no other parts of the file touched.

## Subcommands

### `cost stats`
- **Flags**: `--json`, `-n / --last <N>` (default 100, clamped to ≥1), `--agent <name>` (exact match)
- **Default output**: bold summary header with USD total + cache hit ratio + dispatch count, then by-model and by-agent breakdowns sorted by spend descending. Window range (`startedAt → endedAt`) shown when present.
- **Data flow**: with no `--agent`, calls `summarizeCosts({limit})` directly. With `--agent`, calls `listCosts({agent, limit})` and re-aggregates locally via the exported `summarizeFromEntries()` helper (since the recorder's `summarizeCosts` contract takes `sessionId` only, not `agent`).
- **JSON output**: emits the raw `CostSummary` shape from the recorder.

### `cost session <id|latest>`
- **Flags**: `--json`
- **`latest` resolution**: pulls full window with `listCosts({})`, sorts by timestamp descending, picks the newest entry with a non-null `sessionId`. Then re-queries with that resolved id.
- **Default output**: bold header with session id, dispatch count, and total USD. Followed by a 6-column table: Step / Agent / Model / Tokens / Cache / $$. Rows ordered by `stepIndex` (nulls last → fall through to timestamp).
- **JSON output**: `{ sessionId, count, totalUsd, entries }`.
- **Empty cases**: missing session id arg → exit 1 with usage hint. Unknown id → exit 0 with friendly "no cost data" message. `latest` with no sessions → exit 0 with friendly empty-state.

### `cost models`
- **Flags**: `--json`
- **Default output**: 6-column pricing table (Model / Input / Output / Cache R / Cache W (5m) / Cache W (1h)) for the merged `PRICING` ∪ `loadPricingOverride()` map. Sorted alphabetically by model id.
- **JSON output**: emits the merged pricing map directly.

### `cost reset`
- **Flags**: `--force / -f`
- **Behavior**: without `--force`, prints a yellow `[WARN]` line + dim hint, exits with `success: false / exitCode: 1`. With `--force`, calls `resetCostStats()`, prints `[OK]` on success, surfaces recorder errors via `printError` and exit 1.
- **Pattern source**: matches `route reset` convention exactly (no real readline prompt — keeps the command CI-safe and never hangs on a TTY). Spec said "confirm prompt" but the existing codebase has no prompt helper, so this convention is the closest fit and was already approved for `route reset`. Documented in code comments.

## Tests

- **Count**: 23 tests, all passing (159ms total).
- **Mocking strategy**: `vi.mock` on `../src/services/cost-recorder.js` (returns `mockListCosts`, `mockSummarizeCosts`, `mockResetCostStats` spies) and `../src/services/pricing.js` (inline `PRICING` literal + `mockLoadPricingOverride` spy). Each test re-imports the command module via dynamic `import()` so module-level imports go through the mocks. `mockReset()` in `beforeEach` to keep call history clean.
- **Coverage**:
  - Format helpers: `formatUsd` precision tiers (incl. NaN/negative clamping), `formatTokens` k/M suffixes, `formatPct` clamping, `summarizeFromEntries` shape + cache hit ratio math + empty input.
  - `cost stats`: calls `summarizeCosts` with parsed `--last`, `--json` round-trip, `--agent` filter routes through `listCosts` (NOT `summarizeCosts`), friendly empty-state, invalid `--last` clamps to default.
  - `cost session`: calls `listCosts({sessionId})`, `latest` resolves via two-phase query (full pull then filter), missing arg → exit 1, unknown id → friendly empty-state, `--json` shape verification.
  - `cost models`: prints PRICING entries (merged with empty override), `--json` round-trip, override key takes precedence over hard-coded entry of same name.
  - `cost reset`: refuses without `--force`, with `--force` calls recorder, recorder error surfaces gracefully.
  - Top-level `cost` command: prints help, subcommand list verified.

## TypeScript

- `cd v3/@claude-flow/cli && npx tsc --noEmit -p .` exit code: **2 pre-existing errors in `src/services/trace-template.ts:184`** (parser errors, not in our files). Zero errors in `commands/cost.ts`, `commands/index.ts`, or `__tests__/commands-cost.test.ts`.
- Both `services/pricing.ts` and `services/cost-recorder.ts` had landed by the time validation ran, so the locked contracts are confirmed compatible (no type drift between spec and implementation).

## Notes

- **Convention call on `cost reset`**: spec asked for a "confirm prompt" but the v3 CLI has no readline / inquirer helper. Followed `route reset` precedent: `--force` required, no real prompt. If a prompt helper lands later we can revisit; flagged in code comment.
- **`--agent` filter routing**: `summarizeCosts({sessionId, limit})` doesn't accept an agent filter per the contract, so the command falls back to `listCosts({agent, limit})` + local re-aggregation via the exported `summarizeFromEntries()` helper. Added test coverage to verify the dual code path.
- **`latest` resolution**: two-phase. Pull full window (no filter) → sort by timestamp descending → find newest entry with non-null `sessionId` → re-query `listCosts({sessionId})` with the resolved id. Defensive sort on the local copy because the recorder spec doesn't guarantee newest-first order.
- **Token counter `formatTokens`**: collapses to `k` / `M` once values cross 1000 / 1_000_000 — keeps the per-step table column under 8 chars even on long-context calls.
- **USD formatter `formatUsd`**: two precision tiers — 4 decimals for sub-$1 (where sub-cent precision matters for cache reads), 2 decimals for ≥$1. Clamps NaN/Infinity/negative to 0.
- **No commit, no push** — left to lead for review. Files are only `commands/cost.ts`, `__tests__/commands-cost.test.ts`, plus a 4-line surgical edit to `commands/index.ts`.
