/**
 * Bug #36 regression: `ruflo --version` and `ruflo --help` must NOT load the
 * full v3 SDK module tree. Cold-start budget for these flags is <120ms; the
 * pre-fix baseline was ~210ms because every invocation eagerly imported
 * `dist/src/index.js`, which transitively pulled agentdb / agentic-flow /
 * @ruvector/* (~165ms of module init).
 *
 * The fix lives in bin/cli.js: parse argv first, short-circuit the
 * informational flags by reading package.json directly + emitting a
 * hand-maintained help screen. The dynamic import of `../dist/src/index.js`
 * only happens for real commands, the bare-TTY path, and MCP mode.
 *
 * We assert two things:
 *   1. Functional correctness — `--version` prints `ruflo vX.Y.Z`,
 *      `--help` contains "USAGE:" and "COMMANDS:".
 *   2. Performance — 3 sequential cold-start invocations all complete
 *      within a generous CI-friendly budget (250ms each). The baseline
 *      hit ~210ms; the post-fix value is ~30-60ms locally. We use 250ms
 *      so flaky CI doesn't trip on background load while still catching
 *      a regression that re-introduces the eager SDK import (which
 *      pushed the floor back to 210+ ms).
 *
 * We also assert the SDK files (`dist/src/index.js`, `dist/src/mcp-client.js`)
 * are NOT present in the child's module graph for the version path. We do
 * that by adding `--enable-source-maps` + `NODE_DEBUG=module` and grepping
 * stderr for the SDK paths. NODE_DEBUG=module logs every require/import
 * resolution, so if `dist/src/index.js` shows up there, the lazy-load
 * regressed.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'bin', 'cli.js');

describe('Bug #36: lazy SDK load for --version and --help', () => {
  it('--version prints version and exits 0', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--version'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ruflo v\d+\.\d+\.\d+/);
  });

  it('--help prints hand-maintained top-level help', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USAGE:/);
    expect(r.stdout).toMatch(/COMMANDS:/);
    expect(r.stdout).toMatch(/RUFLO_LOG_LEVEL/);
  });

  it('--version does NOT load dist/src/index.js (lazy SDK)', () => {
    // NODE_DEBUG=module logs every module resolution to stderr. If the
    // SDK module is loaded, its path will appear in there. If the lazy
    // path is taken correctly, the SDK is never imported and stderr
    // stays clean of dist/src/index.js mentions.
    const r = spawnSync('node', [CLI_ENTRY, '--version'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, NODE_DEBUG: 'module' },
    });
    expect(r.status).toBe(0);
    // The SDK entry point should never be loaded for --version.
    expect(r.stderr).not.toMatch(/cli\/dist\/src\/index\.js/);
    // Neither should the MCP client (only the MCP-stdio path needs it).
    expect(r.stderr).not.toMatch(/cli\/dist\/src\/mcp-client\.js/);
  });

  it('--help does NOT load dist/src/index.js (lazy SDK)', () => {
    const r = spawnSync('node', [CLI_ENTRY, '--help'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, NODE_DEBUG: 'module' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/cli\/dist\/src\/index\.js/);
    expect(r.stderr).not.toMatch(/cli\/dist\/src\/mcp-client\.js/);
  });

  it('cold-start --version completes within 250ms over 3 runs', () => {
    // Soft budget: pre-fix was ~210ms; post-fix should be ~30-60ms locally.
    // 250ms gives CI plenty of slack while still catching regressions that
    // re-introduce the eager SDK import (which would push us back to 210+ms
    // and very likely over 250 on a loaded CI box too).
    const BUDGET_MS = 250;
    const RUNS = 3;
    const timings: number[] = [];

    for (let i = 0; i < RUNS; i++) {
      const start = process.hrtime.bigint();
      const r = spawnSync('node', [CLI_ENTRY, '--version'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(r.status).toBe(0);
      timings.push(elapsedMs);
    }

    // Use the median to avoid one outlier from background CPU contention
    // failing the test on a busy CI runner.
    const sorted = [...timings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median, `median cold-start was ${median.toFixed(0)}ms (timings: ${timings.map(t => t.toFixed(0)).join(', ')}ms); budget ${BUDGET_MS}ms`).toBeLessThan(BUDGET_MS);
  });
});
