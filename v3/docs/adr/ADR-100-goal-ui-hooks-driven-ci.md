# ADR-100: goal_ui — Hooks-driven CI workers

**Status**: Proposed
**Date**: 2026-05-02
**Branch**: `feat/goal_ui-ruvector-wasm`
**Phase**: R-7 of ADR-093 RuFlo Platform Integration roadmap
**Relates to**: ADR-093

## Context

`@claude-flow/hooks` ships 12 background workers that already exist and run in the platform's CI for other packages: `audit` (security analysis), `testgaps` (coverage), `optimize` (perf), `document` (auto-doc regeneration), `consolidate`, `predict`, `map`, `preload`, `deepdive`, `refactor`, `benchmark`, `ultralearn`. goal_ui's CI today runs Playwright + the local `check:*` scripts. We're missing the platform's standardized cross-package quality signal.

## Decision

Three GitHub Actions workflows wire `@claude-flow/hooks` workers into goal_ui CI:

1. **`.github/workflows/goal_ui-pr.yml`** (on PR open / push): runs `audit` + `testgaps` workers via `npx @claude-flow/cli hooks worker dispatch --trigger <name>`. Output annotations attach to the PR.
2. **`.github/workflows/goal_ui-nightly.yml`** (cron 03:00 UTC): runs `document` worker — regenerates `docs/ui-inventory.md` and `docs/workflow-inventory.md` from the current component tree; auto-opens a PR if the diff is non-empty.
3. **`.github/workflows/goal_ui-bundle-watch.yml`** (on `dist/` size change >5%): fires `optimize` worker for refactoring suggestions; comments findings on the triggering PR.

All three workflows are scoped to `paths: v3/goal_ui/**` so unrelated changes don't pay the worker startup cost.

## Consequences

### Positive
- Same security + coverage + doc + perf signal that the rest of the platform's packages get — no goal_ui-specific tooling required.
- `audit` worker catches CVE-class regressions that the local `npm audit` gate (per ADR-093 §S5) doesn't (it does deeper static analysis).
- `document` worker keeps `docs/ui-inventory.md` and `docs/workflow-inventory.md` from rotting after component refactors — they were point-in-time snapshots otherwise.

### Negative
- Adds 3 workflow files + the `@claude-flow/cli` install step to CI. Per-PR runtime grows ~30-60s for the worker dispatch.
- Auto-PR from the nightly `document` run produces churn — if the workers' output is noisy or wrong, every night becomes a PR cleanup task.

### Risks
- Worker dispatch via `npx` against a remote package is sensitive to upstream availability. Mitigation: pin a specific `@claude-flow/cli` version per workflow; cache `~/.npm` between runs.
- `optimize` worker may suggest refactors that conflict with active feature work. Mitigation: it only comments; never auto-applies.

## Alternatives Considered

- **Continue with goal_ui-only `check:*` scripts** — duplicates the platform's hooks, doesn't benefit from cross-package learning.
- **Run all 12 workers on every PR** — overkill; latency ballooning. The 3 chosen here (audit + testgaps + document on different cadences) cover the highest-value signals.
- **Add a single mega-workflow that fans out** — harder to debug; explicit small workflows are easier to modify.

## Definition of Done

Plan steps R-7.1 through R-7.3 in `.ruflo-integration-plan.md`:

- `goal_ui-pr.yml` workflow runs `audit` + `testgaps` and passes on this branch's HEAD.
- `goal_ui-nightly.yml` first run produces a PR (or no-op if already in sync).
- Simulated 5%-bundle-growth commit triggers `optimize` worker comment.

## References
- ADR-093 §"Phase R-7"
- `@claude-flow/hooks` — 17 hooks + 12 background workers
- CLAUDE.md "12 Background Workers" table
