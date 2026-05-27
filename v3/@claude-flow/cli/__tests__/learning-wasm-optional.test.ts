/**
 * Regression test for #bug16c — `@ruvector/learning-wasm` must be a true
 * optionalDependency that doesn't break the build or runtime when missing.
 *
 * Before: static `import type { ... } from '@ruvector/learning-wasm'` and
 * literal `await import('@ruvector/learning-wasm')` calls caused TS2307
 * (`Cannot find module`) at compile time and unhandled rejections at
 * runtime when the package wasn't installed.
 *
 * After: WASM types are declared locally as `any`, dynamic imports go
 * through an indirect module name to bypass TS resolution, and the
 * runtime falls back to the pure-JS implementation (`JsMicroLoRA` etc.).
 *
 * This test runs in an environment where `@ruvector/learning-wasm` is NOT
 * installed (it lives in optionalDependencies), so it exercises the
 * fallback path end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_NODE_MODULES = resolve(__dirname, '../../../../node_modules/@ruvector/learning-wasm');

describe('@ruvector/learning-wasm optional dependency (#bug16c)', () => {
  it('is declared as an optionalDependency, not a hard dependency', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } }).then(m => m.default ?? m);
    const deps = (pkg as any).dependencies ?? {};
    const optDeps = (pkg as any).optionalDependencies ?? {};

    expect(deps['@ruvector/learning-wasm']).toBeUndefined();
    expect(optDeps['@ruvector/learning-wasm']).toBeDefined();
  });

  it('ruvector module loads without @ruvector/learning-wasm installed', async () => {
    // Sanity check: the package really isn't in node_modules for this run.
    // (If it ever gets installed by another test, we still expect the import
    // chain to work — the assertion below is the load-no-throw part.)
    const wasmInstalled = existsSync(REPO_NODE_MODULES);

    // Importing the ruvector index must not throw, even when the wasm
    // package is absent. Static type imports were removed in bug16c — if
    // they regressed, this `import()` would fail at module-evaluation time.
    const mod = await import('../src/ruvector/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod.isWasmBackendAvailable).toBe('function');

    // Cross-check: when wasm is genuinely missing, the availability probe
    // returns false (sensible feature-gate value, no throw).
    if (!wasmInstalled) {
      const available = await mod.isWasmBackendAvailable();
      expect(available).toBe(false);
    }
  });

  it('ruvector-training service loads and reports the JS-fallback backend', async () => {
    // Same property as above but for the training service: the static type
    // import on `@ruvector/learning-wasm` was the original source of the
    // build break. If anyone re-adds it, this import will throw at
    // module-evaluation time.
    const training = await import('../src/services/ruvector-training.js');
    expect(training).toBeDefined();
    expect(typeof training.initializeTraining).toBe('function');
    expect(typeof training.getActiveBackend).toBe('function');

    // Before initialize, backend defaults to js-fallback (no WASM bound yet).
    expect(training.getActiveBackend()).toBe('js-fallback');
  });
});
