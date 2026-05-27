#!/usr/bin/env node
/**
 * Regression guard for ruvnet/ruflo#1880.
 *
 * The 12-hour scheduled witness verification runs `verify.mjs` in a
 * source-only checkout (no `npm ci`, no `npm run build`) and conflates
 * two completely different failure modes:
 *
 *   1. `@noble/ed25519` not installed       → precondition (install needed)
 *   2. dist files referenced by manifest    → precondition (build needed)
 *      not present on disk
 *   3. signature actually doesn't verify    → real failure
 *   4. specific dist file regressed         → real failure
 *
 * Before this guard, all four exited with code 1, so the scheduled
 * runner filed a duplicate "verification failed" issue every 12 hours
 * even though nothing was actually wrong with the manifest.
 *
 * verify.mjs now reserves exit 2 for preconditions (cases 1 and 2) and
 * keeps exit 1 strictly for real failures (cases 3 and 4). This smoke
 * drives both shapes through the script and asserts the contract holds.
 *
 * Fails CI if any of:
 *   - missing @noble/ed25519        exit code is anything other than 2
 *   - all-files-missing manifest    exit code is anything other than 2
 *   - precondition output missing the operator-facing fix hint
 *   - precondition output missing the machine-parseable `reason` / `precondition` field
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const VERIFY = resolve(REPO_ROOT, 'plugins/ruflo-core/scripts/witness/verify.mjs');
const REAL_MANIFEST = resolve(REPO_ROOT, 'verification/macos/manifest.md.json');
const ROOT_PKG = resolve(REPO_ROOT, 'package.json');

if (!existsSync(VERIFY)) {
  console.error(`smoke: not found: ${VERIFY}`);
  process.exit(1);
}
if (!existsSync(REAL_MANIFEST)) {
  console.error(`smoke: not found: ${REAL_MANIFEST}`);
  process.exit(1);
}

const failures = [];

function record(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
    failures.push(name);
  }
}

// ── Case 0: @noble/ed25519 stays declared at the repo root ──────────
// Regression guard for ruvnet/ruflo#2027. The 12h scheduled witness
// runner installs root deps before calling verify.mjs. If a future
// dep-cleanup PR drops @noble/ed25519 from the root package.json,
// `npm ci` will silently stop installing it and the scheduled runner
// will start re-filing the same precondition-miss issue every cycle.
// Catch the silent drop here, in PRs, before it ships.
console.log('Case 0: @noble/ed25519 declared at repo root (regression guard #2027)');
{
  const pkg = JSON.parse(readFileSync(ROOT_PKG, 'utf8'));
  const declared = pkg.dependencies?.['@noble/ed25519']
                ?? pkg.devDependencies?.['@noble/ed25519'];
  record(
    '@noble/ed25519 declared in root package.json',
    typeof declared === 'string' && declared.length > 0,
    `root package.json does not declare @noble/ed25519 — verify.mjs would exit 2 ` +
    `on every scheduled run. See ruvnet/ruflo#1880 + #2027.`,
  );
  // verify.mjs uses the v2 API (ed.etc.sha512Sync, ed.getPublicKey, ed.verify).
  // Pinning to ^2 prevents a major bump from breaking the verifier silently.
  record(
    '@noble/ed25519 pinned to ^2 (matches API verify.mjs uses)',
    typeof declared === 'string' && /^[~^]?2\./.test(declared),
    `declared=${declared} — verify.mjs uses the v2 API; a major bump must be ` +
    `audited (see verifySignature in plugins/ruflo-core/scripts/witness/verify.mjs).`,
  );
}

// ── Case 1: @noble/ed25519 missing → exit 2 (precondition) ──────────
// Drop verify.mjs into an empty root with no node_modules anywhere up
// the tree, so the ed25519 probe fails on every candidate.
console.log('\nCase 1: @noble/ed25519 not installed (source-only)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'witness-smoke-nodep-'));
  // verify.mjs's probes use createRequire(join(root, 'noop.js')) which
  // walks up from `root`. Putting `root` deep under tmp ensures Node
  // walks /tmp/.../node_modules (absent) then /tmp/node_modules (absent)
  // then /node_modules (absent on CI) — no resolution.
  const isolatedRoot = join(tmp, 'isolated', 'repo');
  mkdirSync(isolatedRoot, { recursive: true });
  // Stub node_modules to mask any system-level @noble/ed25519 install.
  mkdirSync(join(isolatedRoot, 'node_modules'), { recursive: true });

  const out = spawnSync('node', [VERIFY, '--manifest', REAL_MANIFEST, '--root', isolatedRoot, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });

  record(
    'exit code is 2 (precondition), not 1',
    out.status === 2,
    `got exit=${out.status}, stdout=${out.stdout?.slice(0, 200)}, stderr=${out.stderr?.slice(0, 200)}`,
  );
  record(
    'stderr names @noble/ed25519 and the fix command',
    /@noble\/ed25519/.test(out.stderr) && /npm (ci|install)/.test(out.stderr),
    `stderr=${out.stderr?.slice(0, 400)}`,
  );
  record(
    'JSON output carries machine-parseable precondition tag',
    /noble-ed25519-not-installed/.test(out.stdout),
    `stdout=${out.stdout?.slice(0, 200)}`,
  );

  rmSync(tmp, { recursive: true, force: true });
}

// ── Case 2: all manifest files missing → exit 2 (precondition) ──────
// Point verify.mjs at an isolated root that DOES have @noble/ed25519
// reachable (symlinked from the real install) but has none of the
// manifest's dist/ files — mimicking a clean clone with no build run.
console.log('\nCase 2: all manifest files missing (source-only, deps installed)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'witness-smoke-nobuild-'));
  // Make @noble/ed25519 reachable by symlinking node_modules.
  const realNodeModules = resolve(REPO_ROOT, 'node_modules');
  if (existsSync(join(realNodeModules, '@noble', 'ed25519'))) {
    mkdirSync(join(tmp, 'node_modules', '@noble'), { recursive: true });
    // Use a relative symlink that survives the spawn.
    const src = join(realNodeModules, '@noble', 'ed25519');
    const dst = join(tmp, 'node_modules', '@noble', 'ed25519');
    try {
      // fs.symlinkSync via spawnSync to avoid extra import for the rare-path branch.
      spawnSync('ln', ['-s', src, dst]);
    } catch { /* best-effort */ }
  }

  const out = spawnSync('node', [VERIFY, '--manifest', REAL_MANIFEST, '--root', tmp, '--json'], {
    encoding: 'utf8',
  });

  // We accept either:
  //   - exit 2 with precondition=dist-not-built (the new behavior)
  //   - exit 2 with precondition=noble-ed25519-not-installed (if the
  //     symlink trick didn't satisfy the probe on this runner — also a
  //     precondition, still not a real failure)
  // We do NOT accept exit 1 — that's the bug this guard exists to catch.
  record(
    'exit code is 2 (precondition), not 1',
    out.status === 2,
    `got exit=${out.status}, stdout head=${out.stdout?.slice(0, 200)}, stderr head=${out.stderr?.slice(0, 200)}`,
  );
  record(
    'output carries a precondition tag',
    /noble-ed25519-not-installed|dist-not-built/.test(out.stdout + out.stderr),
    `combined output=${(out.stdout + out.stderr).slice(0, 400)}`,
  );

  rmSync(tmp, { recursive: true, force: true });
}

// ── Case 3: built tree → never exit 2 (precondition is one-way) ─────
// On a built tree the verifier may produce 0 (clean) or 1 (some real
// regression caught) — both mean verification actually ran. What it
// must NEVER produce here is exit 2, because that would mean a built
// tree was mis-classified as "needs install/build" and the scheduled
// runner would silently skip filing real regressions.
console.log('\nCase 3: built tree never reports precondition');
{
  const out = spawnSync('node', [VERIFY, '--manifest', REAL_MANIFEST], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  record(
    'exit code is NOT 2 (built tree should never be flagged as a precondition miss)',
    out.status !== 2,
    `got exit=${out.status}, tail=${(out.stdout + out.stderr).slice(-300)}`,
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`smoke-witness-verify-precondition: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('smoke-witness-verify-precondition: all checks passed');
