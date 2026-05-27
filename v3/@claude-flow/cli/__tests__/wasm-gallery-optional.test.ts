/**
 * Regression test for #bug18 — `@ruvector/rvagent-wasm` must be a true
 * optionalDependency that doesn't break the build or runtime when missing.
 *
 * Before: literal `await import('@ruvector/rvagent-wasm')` calls in
 * `src/ruvector/agent-wasm.ts` caused a runtime ERR_MODULE_NOT_FOUND
 * that bubbled out of every `wasm_gallery_*` (and `wasm_agent_*`) MCP
 * tool as a raw stack — the package isn't in the regular dependencies.
 *
 * After: dynamic imports go through an indirect module name to bypass
 * TS resolution, the runtime detects the missing-module error, and the
 * MCP handlers convert it to a friendly `{ error, _hint }` shape.
 *
 * This test runs in an environment where `@ruvector/rvagent-wasm` is
 * NOT installed (it lives in optionalDependencies), so it exercises the
 * missing-module path end-to-end. Same shape as bug16c.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_NODE_MODULES = resolve(__dirname, '../../../../node_modules/@ruvector/rvagent-wasm');

describe('@ruvector/rvagent-wasm optional dependency (#bug18)', () => {
  it('is declared as an optionalDependency, not a hard dependency', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } }).then(m => m.default ?? m);
    const deps = (pkg as any).dependencies ?? {};
    const optDeps = (pkg as any).optionalDependencies ?? {};

    expect(deps['@ruvector/rvagent-wasm']).toBeUndefined();
    expect(optDeps['@ruvector/rvagent-wasm']).toBeDefined();
  });

  it('agent-wasm module loads without @ruvector/rvagent-wasm installed', async () => {
    // Sanity check: the package really isn't in node_modules for this run.
    const wasmInstalled = existsSync(REPO_NODE_MODULES);

    // Importing must not throw, even when the wasm package is absent.
    // If anyone re-adds a literal `import('@ruvector/rvagent-wasm')` at
    // module-evaluation time (vs lazily inside a function), this would
    // start failing.
    const mod = await import('../src/ruvector/agent-wasm.js');
    expect(mod).toBeDefined();
    expect(typeof mod.isAgentWasmAvailable).toBe('function');
    expect(typeof mod.isRvagentWasmMissingError).toBe('function');

    // Cross-check: when wasm is genuinely missing, the availability
    // probe returns false (sensible feature-gate value, no throw).
    if (!wasmInstalled) {
      const available = await mod.isAgentWasmAvailable();
      expect(available).toBe(false);
    }
  });

  it('initAgentWasm throws a recognizable error when package is missing', async () => {
    const wasmInstalled = existsSync(REPO_NODE_MODULES);
    if (wasmInstalled) {
      // If the package somehow got installed, skip — we're testing the
      // missing-module branch.
      return;
    }

    const mod = await import('../src/ruvector/agent-wasm.js');
    let caught: unknown = null;
    try {
      await mod.initAgentWasm();
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // The detector should classify this as a missing-module error.
    expect(mod.isRvagentWasmMissingError(caught)).toBe(true);
    // And the message should include the install hint so users know what to do.
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/@ruvector\/rvagent-wasm/);
    expect(msg).toMatch(/npm install/);
  });

  it('wasm_gallery_list returns friendly { error, _hint } shape, not a raw stack', async () => {
    const wasmInstalled = existsSync(REPO_NODE_MODULES);
    if (wasmInstalled) {
      return; // not the path under test
    }

    const tools = await import('../src/mcp-tools/wasm-agent-tools.js');
    const galleryList = tools.wasmAgentTools.find(t => t.name === 'wasm_gallery_list');
    expect(galleryList).toBeDefined();

    // Handler must not throw — it must return the friendly shape.
    const result = await galleryList!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type).toBe('text');

    const parsed = JSON.parse(result.content![0]!.text as string);
    expect(parsed.error).toBe('WASM agent runtime not available');
    expect(parsed._hint).toMatch(/install @ruvector\/rvagent-wasm/);
  });

  it('wasm_gallery_search returns the same friendly shape', async () => {
    const wasmInstalled = existsSync(REPO_NODE_MODULES);
    if (wasmInstalled) {
      return;
    }

    const tools = await import('../src/mcp-tools/wasm-agent-tools.js');
    const gallerySearch = tools.wasmAgentTools.find(t => t.name === 'wasm_gallery_search');
    expect(gallerySearch).toBeDefined();

    const result = await gallerySearch!.handler({ query: 'coder' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content![0]!.text as string);
    expect(parsed.error).toBe('WASM agent runtime not available');
    expect(parsed._hint).toMatch(/install @ruvector\/rvagent-wasm/);
  });

  it('wasm_gallery_create returns the same friendly shape', async () => {
    const wasmInstalled = existsSync(REPO_NODE_MODULES);
    if (wasmInstalled) {
      return;
    }

    const tools = await import('../src/mcp-tools/wasm-agent-tools.js');
    const galleryCreate = tools.wasmAgentTools.find(t => t.name === 'wasm_gallery_create');
    expect(galleryCreate).toBeDefined();

    const result = await galleryCreate!.handler({ template: 'coder' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content![0]!.text as string);
    expect(parsed.error).toBe('WASM agent runtime not available');
    expect(parsed._hint).toMatch(/install @ruvector\/rvagent-wasm/);
  });
});
