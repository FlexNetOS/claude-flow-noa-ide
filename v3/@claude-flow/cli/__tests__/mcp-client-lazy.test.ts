/**
 * Bug #49: mcp-client lazy-load assertions
 *
 * Companion to cli-bootstrap.test.ts. That file proves the version/help fast
 * paths don't import mcp-client.js at all. This file proves the COMPLEMENT:
 * even when something DOES import mcp-client.js (any command that ends up
 * calling an MCP tool, e.g. `ruflo agent spawn`), importing mcp-client must
 * NOT transitively pull the heavy native bindings.
 *
 * Before Bug #49, mcp-client eagerly registered 25+ tool packages at module
 * top — those packages drag onnxruntime-node, better-sqlite3, hnswlib-node,
 * tiktoken, @xenova/transformers, costing ~150ms of native-binding load on
 * cold cache. The new contract: tool packages load lazily inside
 * `loadAllTools()` triggered by `await ensureMcpToolsLoaded()` (or auto-
 * triggered by `await callMCPTool(...)`).
 *
 * The grep-for-loaded-modules pattern is borrowed from cli-bootstrap.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(__dirname, '..');
const MCP_CLIENT_DIST = join(CLI_ROOT, 'dist', 'src', 'mcp-client.js');

/** Heavy native bindings + their transitive friends. None must load on a
 *  bare import of mcp-client.js. */
const HEAVY_MODULE_PATTERNS: readonly RegExp[] = [
  /onnxruntime-node/,
  /onnxruntime-common/,
  /better-sqlite3/,
  /@xenova[\\/]transformers/,
  /hnswlib-node/,
  /tiktoken/,
];

/** Tool package paths that must NOT load on import (only on first
 *  ensureMcpToolsLoaded() / callMCPTool() call). */
const TOOL_PACKAGE_PATTERNS: readonly RegExp[] = [
  /mcp-tools[\\/]agent-tools\.js/,
  /mcp-tools[\\/]swarm-tools\.js/,
  /mcp-tools[\\/]memory-tools\.js/,
  /mcp-tools[\\/]hooks-tools\.js/,
  /mcp-tools[\\/]embeddings-tools\.js/,
  /mcp-tools[\\/]task-tools\.js/,
  /mcp-tools[\\/]session-tools\.js/,
  /mcp-tools[\\/]hive-mind-tools\.js/,
  /mcp-tools[\\/]workflow-tools\.js/,
  /mcp-tools[\\/]analyze-tools\.js/,
  /mcp-tools[\\/]progress-tools\.js/,
  /mcp-tools[\\/]claims-tools\.js/,
  /mcp-tools[\\/]security-tools\.js/,
  /mcp-tools[\\/]transfer-tools\.js/,
  /mcp-tools[\\/]system-tools\.js/,
  /mcp-tools[\\/]terminal-tools\.js/,
  /mcp-tools[\\/]neural-tools\.js/,
  /mcp-tools[\\/]performance-tools\.js/,
  /mcp-tools[\\/]github-tools\.js/,
  /mcp-tools[\\/]daa-tools\.js/,
  /mcp-tools[\\/]coordination-tools\.js/,
  /mcp-tools[\\/]browser-tools\.js/,
  /mcp-tools[\\/]browser-session-tools\.js/,
  /mcp-tools[\\/]agentdb-tools\.js/,
  /mcp-tools[\\/]ruvllm-tools\.js/,
  /mcp-tools[\\/]wasm-agent-tools\.js/,
  /mcp-tools[\\/]guidance-tools\.js/,
  /mcp-tools[\\/]autopilot-tools\.js/,
  /mcp-tools[\\/]config-tools\.js/,
];

/**
 * Spawn a child Node process that imports mcp-client.js and runs a snippet,
 * with NODE_DEBUG=module so every module resolution lands in stderr. Return
 * stderr so the caller can grep for forbidden modules.
 */
function importMcpClientAndRun(snippet: string): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  // Use `data:` URL trick so we don't have to write a temp file. The script
  // imports mcp-client at the top — same module-eval cost as if a CLI
  // command did `import { callMCPTool } from '../mcp-client.js'`.
  const code = `
    import * as mcp from ${JSON.stringify(MCP_CLIENT_DIST)};
    ${snippet}
  `;
  const r = spawnSync('node', ['--input-type=module', '-e', code], {
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, NODE_DEBUG: 'module' },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('mcp-client: lazy-load contract (Bug #49)', () => {
  describe('top-level import surface', () => {
    it('exposes the documented public API (function/type signatures only)', async () => {
      const mod = await import('../src/mcp-client.js');
      // Public sync façades
      expect(typeof mod.listMCPTools).toBe('function');
      expect(typeof mod.hasTool).toBe('function');
      expect(typeof mod.getToolMetadata).toBe('function');
      expect(typeof mod.getToolCategories).toBe('function');
      expect(typeof mod.validateToolInput).toBe('function');
      // Async APIs
      expect(typeof mod.callMCPTool).toBe('function');
      expect(typeof mod.ensureMcpToolsLoaded).toBe('function');
      // Error class
      expect(typeof mod.MCPClientError).toBe('function');
    });
  });

  describe('importing mcp-client.js does NOT load heavy native bindings', () => {
    it('importing alone (no API call) loads zero heavy native modules', () => {
      const r = importMcpClientAndRun('/* import only */');
      expect(r.status).toBe(0);

      const loaded: string[] = [];
      for (const pattern of HEAVY_MODULE_PATTERNS) {
        if (pattern.test(r.stderr)) loaded.push(pattern.source);
      }
      expect(
        loaded,
        `Importing mcp-client.js eagerly loaded heavy modules: ${loaded.join(', ')}. ` +
        `These should be deferred until ensureMcpToolsLoaded() / callMCPTool() runs. ` +
        `See src/mcp-client.ts header for the lazy-load contract.`
      ).toEqual([]);
    });

    it('importing alone does NOT load any of the 25+ tool packages', () => {
      const r = importMcpClientAndRun('/* import only */');
      expect(r.status).toBe(0);

      const loaded: string[] = [];
      for (const pattern of TOOL_PACKAGE_PATTERNS) {
        if (pattern.test(r.stderr)) loaded.push(pattern.source);
      }
      expect(
        loaded,
        `Importing mcp-client.js eagerly loaded tool packages: ${loaded.join(', ')}. ` +
        `Tool packages must load lazily inside ensureMcpToolsLoaded().`
      ).toEqual([]);
    });

    it('the sync façades return empty/false/undefined before tools load', () => {
      // We call the sync APIs after import but before ensureMcpToolsLoaded.
      // They MUST gracefully return empty values rather than crash, so callers
      // who reach for them on the cold path don't blow up.
      const r = importMcpClientAndRun(`
        if (mcp.listMCPTools().length !== 0) {
          console.error('FAIL: listMCPTools returned non-empty before load');
          process.exit(2);
        }
        if (mcp.hasTool('agent_spawn') !== false) {
          console.error('FAIL: hasTool returned true before load');
          process.exit(2);
        }
        if (mcp.getToolMetadata('agent_spawn') !== undefined) {
          console.error('FAIL: getToolMetadata returned non-undefined before load');
          process.exit(2);
        }
        if (mcp.getToolCategories().length !== 0) {
          console.error('FAIL: getToolCategories returned non-empty before load');
          process.exit(2);
        }
        const validation = mcp.validateToolInput('agent_spawn', {});
        if (validation.valid !== false) {
          console.error('FAIL: validateToolInput.valid was not false before load');
          process.exit(2);
        }
        console.log('OK');
      `);
      expect(r.status, `stdout=${r.stdout}\nstderr-tail=${r.stderr.slice(-500)}`).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    });
  });

  describe('ensureMcpToolsLoaded() — explicit load boundary', () => {
    it('populates the registry with all 25+ tool groups when awaited', () => {
      const r = importMcpClientAndRun(`
        await mcp.ensureMcpToolsLoaded();
        const tools = mcp.listMCPTools();
        if (tools.length === 0) {
          console.error('FAIL: registry empty after ensureMcpToolsLoaded()');
          process.exit(2);
        }
        // We expect substantially more than the 28 top-level groups —
        // each group contributes 1-15 tools. 50 is a safe lower bound.
        if (tools.length < 50) {
          console.error('FAIL: only ' + tools.length + ' tools registered');
          process.exit(2);
        }
        console.log('TOOL_COUNT=' + tools.length);
        // Spot-check a representative tool from each major group.
        const required = ['agent_spawn', 'swarm_init', 'memory_store',
          'hooks_route', 'task_create', 'session_save'];
        for (const name of required) {
          if (!mcp.hasTool(name)) {
            console.error('FAIL: missing canonical tool ' + name);
            process.exit(2);
          }
        }
        console.log('REQUIRED_TOOLS_PRESENT');
      `);
      expect(r.status, `stdout=${r.stdout}\nstderr-tail=${r.stderr.slice(-500)}`).toBe(0);
      expect(r.stdout).toMatch(/TOOL_COUNT=\d+/);
      expect(r.stdout).toMatch(/REQUIRED_TOOLS_PRESENT/);
    });

    it('is idempotent — second call returns immediately', () => {
      const r = importMcpClientAndRun(`
        const t0 = process.hrtime.bigint();
        await mcp.ensureMcpToolsLoaded();
        const t1 = process.hrtime.bigint();
        await mcp.ensureMcpToolsLoaded();
        const t2 = process.hrtime.bigint();
        const firstMs = Number(t1 - t0) / 1e6;
        const secondMs = Number(t2 - t1) / 1e6;
        console.log('FIRST_MS=' + firstMs.toFixed(2));
        console.log('SECOND_MS=' + secondMs.toFixed(2));
        // Second call must be < 5ms (microtask roundtrip on cached promise).
        if (secondMs >= 5) {
          console.error('FAIL: second ensureMcpToolsLoaded took ' + secondMs + 'ms (not cached)');
          process.exit(2);
        }
      `);
      expect(r.status, `stdout=${r.stdout}\nstderr-tail=${r.stderr.slice(-500)}`).toBe(0);
      expect(r.stdout).toMatch(/FIRST_MS=/);
      expect(r.stdout).toMatch(/SECOND_MS=/);
    });

    it('listMCPTools returns the same array shape across calls', () => {
      const r = importMcpClientAndRun(`
        await mcp.ensureMcpToolsLoaded();
        const a = mcp.listMCPTools();
        const b = mcp.listMCPTools();
        if (a.length !== b.length) {
          console.error('FAIL: listMCPTools length mismatch');
          process.exit(2);
        }
        // Sample a few names to confirm content stability across calls.
        const aNames = a.slice(0, 10).map(t => t.name).join(',');
        const bNames = b.slice(0, 10).map(t => t.name).join(',');
        if (aNames !== bNames) {
          console.error('FAIL: listMCPTools returned different orderings');
          process.exit(2);
        }
        console.log('STABLE');
      `);
      expect(r.status, `stdout=${r.stdout}\nstderr-tail=${r.stderr.slice(-500)}`).toBe(0);
      expect(r.stdout).toMatch(/STABLE/);
    });
  });

  describe('callMCPTool auto-loads the registry', () => {
    it('triggers the lazy load on first invocation (no explicit ensure call needed)', () => {
      // This proves the contract for non-MCP-mode callers: code paths like
      // `ruflo agent spawn` that invoke callMCPTool directly should not need
      // to await ensureMcpToolsLoaded() themselves.
      const r = importMcpClientAndRun(`
        // Sanity: registry empty before call.
        if (mcp.listMCPTools().length !== 0) {
          console.error('FAIL: registry not empty before any call');
          process.exit(2);
        }
        // Use a known-bad tool name so we don't actually run a handler — the
        // lookup still loads the registry, then throws the expected error.
        try {
          await mcp.callMCPTool('definitely_not_a_real_tool', {});
          console.error('FAIL: expected throw for missing tool');
          process.exit(2);
        } catch (err) {
          if (!(err instanceof mcp.MCPClientError)) {
            console.error('FAIL: wrong error type ' + err.constructor.name);
            process.exit(2);
          }
        }
        // After the failed call, the registry must be populated (load
        // happened before the lookup).
        if (mcp.listMCPTools().length === 0) {
          console.error('FAIL: registry empty after callMCPTool');
          process.exit(2);
        }
        console.log('AUTO_LOADED');
      `);
      expect(r.status, `stdout=${r.stdout}\nstderr-tail=${r.stderr.slice(-500)}`).toBe(0);
      expect(r.stdout).toMatch(/AUTO_LOADED/);
    });
  });
});
