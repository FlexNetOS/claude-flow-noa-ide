# V3 Security Overhaul — 2026-05-25

Run target: `/home/ubuntu/ruflo` (claude-flow v3.10.1)
Skill: `/v3-security-overhaul`, mode: audit + fix

## Templated CVEs — status

| ID | Description | Status |
|----|-------------|--------|
| CVE-1 | Vulnerable dependencies | **N/A.** `npm audit` reports 0 vulnerabilities (info/low/moderate/high/critical all 0) across 761 deps. |
| CVE-2 | SHA-256 password hashing | **N/A.** Passwords use `scrypt` (`v3/@claude-flow/cli/src/appliance/rvfa-builder.ts`) and `pbkdf2` w/ 100k iters (`rvfa-runner.ts`). SHA-256 *is* used in `ruflo/src/ruvocal/src/lib/server/auth.ts` but only as a fingerprint over a high-entropy random sessionId/UUID — correct use, not a password hash. |
| CVE-3 | Hardcoded credentials | **Partial — fixed.** Real prod-secret hits: none. One validator test-fixture string in `v3/@claude-flow/guidance/src/manifest-validator.ts:984` is the validator's own detection sample, not a leaked secret. Insecure-default *fallback* pattern in 9 example files — fixed below. |

## Fixes applied

### 1. POSTGRES_PASSWORD insecure-default fallback (9 files)

Pattern `process.env.POSTGRES_PASSWORD || 'postgres'` silently connects with a known default when the env var is missing. These are example files that users copy, so the pattern propagates. Dropped the fallback — `pg` now errors clearly when the env var is unset.

Files:
- `v3/@claude-flow/plugins/examples/ruvector/basic-usage.ts`
- `v3/@claude-flow/plugins/examples/ruvector/semantic-search.ts`
- `v3/@claude-flow/plugins/examples/ruvector/attention-patterns.ts`
- `v3/@claude-flow/plugins/examples/ruvector/streaming-large-data.ts`
- `v3/@claude-flow/plugins/examples/ruvector/quantization.ts`
- `v3/@claude-flow/plugins/examples/ruvector/transactions.ts`
- `v3/@claude-flow/plugins/examples/ruvector/gnn-analysis.ts`
- `v3/@claude-flow/plugins/examples/ruvector/self-learning.ts`
- `v3/@claude-flow/plugins/examples/ruvector/hyperbolic-hierarchies.ts`

### 2. Admin token comparison — timing oracle

`ruflo/src/ruvocal/src/lib/server/adminToken.ts:22` used `token === this.token`. String `===` is **not** constant-time — early-out leaks token prefix length under repeated probes. Replaced with `crypto.timingSafeEqual` over length-checked Buffers.

### 3. Bearer-token cache — no TTL (HF revocation not honored)

`ruflo/src/ruvocal/src/lib/server/auth.ts:463` accepted any `tokenCaches` hit regardless of age. After the first whoami-v2 success, an HF token's hash was trusted indefinitely, so upstream revocation was ignored.

RVF (the file-backed store backing `tokenCaches`) has no native TTL index — `createIndex` is a no-op. Fix is enforced at the application layer instead:
- Added `TOKEN_CACHE_TTL_MS = 60 * 60 * 1000` (1h) module constant.
- On cache hit, check `Date.now() - cacheHit.createdAt.getTime() < TTL`. Stale entries fall through to a fresh whoami-v2 call and are evicted via `deleteOne`.

1h is a tradeoff: bounds the revocation window to ~1h while still saving the vast majority of HF roundtrips. Adjust via the constant if a tighter bound is needed.

## Verification

```
$ npm audit --audit-level high
# 0 vulnerabilities

$ grep -rE "POSTGRES_PASSWORD\s*\|\|\s*'postgres'" v3 --include="*.ts"
# ALL CLEAR

$ npx vitest run v3/@claude-flow/cli/__tests__/security-audit.test.ts
# 25 passed
```

`security-verification.test.ts` and `plugins/__tests__/security.test.ts` fail with `__vite_ssr_exportName__ is not defined` — pre-existing vitest/vite SSR-transform glitch in files this pass did not touch (`json-security.ts`, `pg-utils.ts`, `plugins/src/security/index.ts`). Unrelated to these fixes.
