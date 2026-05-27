# Gap 4 Pricing Service Result

## Files created
- `v3/@claude-flow/cli/src/services/pricing.ts` (323 lines)
- `v3/@claude-flow/cli/__tests__/pricing.test.ts` (389 lines, 25 tests)

## Exports

All four locked-contract symbols, no extras:

| Symbol | Kind | Signature |
|---|---|---|
| `ModelPricing` | interface | `{ inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWrite5mPerMTok, cacheWrite1hPerMTok }` (all `number`) |
| `TokenUsage` | interface | `{ input, output, cacheRead, cacheCreation }` (all `number`) |
| `CostBreakdown` | interface | `{ input, output, cacheRead, cacheCreation, total }` (all `number`, USD) |
| `CacheTtl` | type | `'5m' \| '1h'` |
| `PRICING` | const | `Record<string, ModelPricing>` — 6 entries (3x 4.x + 3x legacy 3.x) |
| `priceFor` | fn | `(model: string) => ModelPricing \| null` |
| `computeCostUsd` | fn | `(usage: TokenUsage, model: string, cacheTtl: CacheTtl) => CostBreakdown \| null` |
| `loadPricingOverride` | fn | `() => Record<string, ModelPricing>` |

## Tests

- 25 tests, all pass.
- Runtime: 5ms.
- Coverage by section:
  - `PRICING table` — 4 tests (canonical 4.x, legacy 3.x, exact-value sonnet/opus)
  - `priceFor()` — 6 tests (exact, alias, date-suffix strip, unknown, empty, non-date suffix)
  - `computeCostUsd()` — 6 tests (happy path, ttl='1h' vs '5m', rounding, all-zero, unknown, dated snapshot)
  - `loadPricingOverride()` — 7 tests (missing file, malformed JSON, non-object, primitives, valid file, mixed valid+broken, partial overlay)
  - `install-context wiring` + `exports surface` — 2 sanity tests

## TypeScript

- `cd v3/@claude-flow/cli && npx tsc --noEmit -p .` exits with one error:
  `src/memory/sona-optimizer.ts(250,38): error TS2307: Cannot find module '@ruvector/sona'`
- This is the pre-existing `@ruvector/sona` optional-dep error called out in the task. No new errors introduced by `pricing.ts` or `pricing.test.ts`.

## Notes

- **Alias mapping divergence (intentional)**: `agent-execute-core.ts:84-88` maps `'sonnet'` → `'claude-3-5-sonnet-latest'` (legacy 3.x). The task explicitly required `'sonnet'` → `'claude-sonnet-4-6'` (current 4.x), so I implemented the new map locally as `SHORT_ALIASES` rather than importing the legacy one. Avoids the dependency cycle the task warned about, AND ships pricing semantics that match what users are actually billed today. The legacy 3.x ids still resolve via exact-match against `PRICING` for back-compat with older trajectories.
- **No I/O at module load**: confirmed — `loadPricingOverride()` is the only function that touches the filesystem, and it's only called when invoked explicitly. Cost-recorder and other consumers can call `priceFor` / `computeCostUsd` without paying for a stat() call.
- **Override partial-overlay semantics**: `loadPricingOverride()` returns ONLY the override entries (not a merge with `PRICING`). The actual `{ ...PRICING, ...override }` merge belongs in cost-recorder.ts so the raw hardcoded table stays inspectable for `swarmops cost models`. One test asserts the partial-overlay contract end-to-end.
- **Defensive shape validation in override loader**: malformed entries (missing fields, wrong types, primitives instead of objects) are dropped individually with `swallowError` breadcrumbs rather than poisoning the whole override. Tests cover this.
- **6-decimal rounding** uses the standard multiply-round-divide pattern. Test pins `1 input token @ $3/MTok` → exactly `0.000003` to lock the precision invariant.
- **Test isolation via `RUFLO_INSTALL_CONTEXT_JSON`**: test suite mkdtemps a fake claudeRoot and pins it via the env override BEFORE the dynamic `await import(...)` of pricing.ts. Real `~/.claude/.claude-flow/pricing-override.json` is never read or written. Cleanup via `afterAll(rmSync(..., recursive))`.
- **Test file location**: placed at `v3/@claude-flow/cli/__tests__/pricing.test.ts` to match the existing convention (vitest config pins `__tests__/**/*.test.ts` at package root, NOT `src/__tests__/`). Task spec said "Add `__tests__/pricing.test.ts`" — interpreted as the package-root tests dir.
