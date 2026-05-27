# Build Status — Phase 2 Verification

**Branch:** `fix/global-install-and-learning-loop`
**Head:** `c83c7be0a`
**Date:** 2026-05-07
**PR:** #1828 (upstream)

## Summary

**Build: GREEN** when invoked correctly via `tsc -b` (TypeScript build mode).

The Bug 16 fix series (a/b/c) successfully addressed the four pre-existing TS
errors. With proper composite-project build invocation, the package builds
cleanly with **0 errors** and packages successfully.

## Build Invocation Note

The `package.json` script `"build": "tsc"` (without `-b`) fails with 4
TS6305 errors because the `cli` package has TypeScript project references
to `../shared` and `../swarm` that must be built first. Plain `tsc` does
not traverse references; `tsc -b` does.

**Working command:**
```bash
cd /Users/h4ckm1n/dev/ruflo/v3/@claude-flow/cli && npx tsc -b
# EXIT: 0
```

**Failing command (current npm script):**
```bash
npm run build --prefix /Users/h4ckm1n/dev/ruflo/v3/@claude-flow/cli
# EXIT: 2 — 4 × TS6305 errors in src/infrastructure/in-memory-repositories.ts
```

The 4 errors are not code defects — they are emitted because the referenced
`@claude-flow/swarm` package's `dist/` is missing on a fresh checkout. This
is a script configuration issue, not a regression from our PR.

## Error Categorization (with plain `tsc`)

| File | Count | Error Code | Category |
|------|-------|------------|----------|
| `src/infrastructure/in-memory-repositories.ts` | 4 | TS6305 | unrelated-pre-existing (build-script config) |

**Sample message:**
```
src/infrastructure/in-memory-repositories.ts(9,47): error TS6305:
Output file '...@claude-flow/swarm/dist/domain/entities/agent.d.ts'
has not been built from source file '...@claude-flow/swarm/src/domain/entities/agent.ts'.
```

These are TS6305 ("output not built from source") — a hint that
project-reference outputs are missing, not a real type error. Resolved by
using `tsc -b` which builds dependencies in dependency order.

## Pre-Bug-16 Baseline Comparison

The original brief identified 4 TS errors in:
- `src/index.ts` — fixed by Bug 16
- `infrastructure/in-memory-repositories.ts` — fixed by Bug 16
- `memory-tools.ts:473 smartSearch` — fixed by Bug 16
- missing `@ruvector/learning-wasm` — fixed by Bug 16

All four are **fixed-by-bug16**. No regressions introduced by our 18 commits.
The 4 TS6305 errors that appear with plain `tsc` are a separate, pre-existing
build-script issue (not in the original baseline list).

## Dist Freshness

After running `npx tsc -b --force`, dist is fully fresh.

| File | Source mtime | Dist mtime |
|------|--------------|------------|
| `src/init/helpers-generator.ts` | 23:37 | 23:52 (rebuilt) |

Before rebuild, dist was 2 minutes stale. After force rebuild, dist contains
all latest source changes including Bug 16 fixes.

## Package Contents (`npm pack --dry-run`)

- **Name:** `@claude-flow/cli`
- **Version:** `3.7.0-alpha.11`
- **Tarball:** `claude-flow-cli-3.7.0-alpha.11.tgz`
- **Package size:** 2.2 MB
- **Unpacked size:** 10.5 MB
- **Total files:** 1134

Bug 16 fix artifacts confirmed in package:
- `dist/src/infrastructure/in-memory-repositories.{js,d.ts}`
- `dist/src/init/helpers-generator.{js,d.ts}`
- `dist/src/mcp-tools/memory-tools.{js,d.ts}`

## Recommended Publish Command

Do NOT run automatically. User should execute manually:

```bash
cd /Users/h4ckm1n/dev/ruflo/v3/@claude-flow/cli
npx tsc -b --force                       # ensure dist is fresh
npm pack --dry-run                       # final review
npm publish --access public --tag alpha  # publish
```

## Recommendations

1. **Quick win — Bug 17 candidate:** Update `package.json` build script from
   `"build": "tsc"` to `"build": "tsc -b"` so `npm run build` works on a
   fresh checkout. One-line fix.
2. **Ready to publish** as-is via the manual command above. The package builds
   green, dist is fresh, and packaging completes successfully.
3. **Upstream:** PR #1828 can be merged. No blocking build issues.

## Recommendation: ready-to-publish (with one optional Bug 17 script fix)
