/**
 * V3 CLI MCP Client
 *
 * Thin wrapper for calling MCP tools from CLI commands.
 * Implements ADR-005: MCP-First API Design - CLI as thin wrapper around MCP tools
 *
 * This provides a simple interface for CLI commands to call MCP tools without
 * containing hardcoded business logic. All business logic lives in MCP tool handlers.
 *
 * BOOT PERFORMANCE NOTES (Bug #49)
 * --------------------------------
 * Importing this module must NOT transitively pull any of the 25+ MCP tool
 * packages. Those tool packages drag heavy native bindings — onnxruntime-node,
 * better-sqlite3, hnswlib-node, tiktoken, @xenova/transformers — that
 * collectively cost ~150ms+ on cold cache.
 *
 * Before Bug #49, every command that imported `mcp-client.js` (agent, swarm,
 * memory, hooks, status, task, session, start, mcp) eagerly registered all
 * 25+ tools at module load time. That meant `ruflo trace --help` paid for the
 * full MCP tool graph even though it only renders help text.
 *
 * The fix: tool packages are loaded lazily inside `loadAllTools()` via
 * dynamic `import()`. The TOOL_REGISTRY starts EMPTY at module load. Sync
 * APIs (`listMCPTools`, `hasTool`, …) read from it directly — they return
 * empty / false / undefined until `ensureMcpToolsLoaded()` has been awaited.
 *
 * The two MCP entry points (`bin/cli.js` MCP-stdio path and `bin/mcp-server.js`)
 * call `await ensureMcpToolsLoaded()` once at MCP server startup — well before
 * the first `tools/list` or `tools/call` arrives. `callMCPTool()` also calls
 * `ensureMcpToolsLoaded()` internally so any non-MCP-mode caller (e.g.
 * `ruflo agent spawn`) gets the registry populated transparently.
 *
 * The cli-bootstrap test asserts that `ruflo --version` / `ruflo --help` /
 * bare-TTY paths don't load mcp-client itself. The new mcp-client-lazy test
 * asserts that *importing* mcp-client doesn't load any heavy native binding.
 */

import type { MCPTool } from './mcp-tools/types.js';
import { swallowError } from '@claude-flow/shared';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Lazy tool-package loaders
// ---------------------------------------------------------------------------
// Each entry is a dynamic import + extractor for one MCP tool package. We
// deliberately keep them as a flat array of thunks rather than an object so
// `loadAllTools()` can `Promise.all` them in parallel — module evaluation is
// single-threaded but Node's module loader can interleave the binding-
// resolution work for cold modules across the loaders.
//
// IMPORTANT: do NOT add a static `import` for any of these packages to this
// module — that would defeat the entire lazy-load contract. If you need to
// reference an MCP tool's static type, import the type from `./mcp-tools/types.js`.

type ToolLoader = () => Promise<readonly MCPTool[]>;

const TOOL_LOADERS: ReadonlyArray<{ label: string; load: ToolLoader }> = [
  { label: 'agent', load: () => import('./mcp-tools/agent-tools.js').then(m => m.agentTools) },
  { label: 'swarm', load: () => import('./mcp-tools/swarm-tools.js').then(m => m.swarmTools) },
  { label: 'memory', load: () => import('./mcp-tools/memory-tools.js').then(m => m.memoryTools) },
  { label: 'config', load: () => import('./mcp-tools/config-tools.js').then(m => m.configTools) },
  { label: 'hooks', load: () => import('./mcp-tools/hooks-tools.js').then(m => m.hooksTools) },
  { label: 'task', load: () => import('./mcp-tools/task-tools.js').then(m => m.taskTools) },
  { label: 'session', load: () => import('./mcp-tools/session-tools.js').then(m => m.sessionTools) },
  { label: 'hive-mind', load: () => import('./mcp-tools/hive-mind-tools.js').then(m => m.hiveMindTools) },
  { label: 'workflow', load: () => import('./mcp-tools/workflow-tools.js').then(m => m.workflowTools) },
  { label: 'analyze', load: () => import('./mcp-tools/analyze-tools.js').then(m => m.analyzeTools) },
  { label: 'progress', load: () => import('./mcp-tools/progress-tools.js').then(m => m.progressTools) },
  { label: 'embeddings', load: () => import('./mcp-tools/embeddings-tools.js').then(m => m.embeddingsTools) },
  { label: 'claims', load: () => import('./mcp-tools/claims-tools.js').then(m => m.claimsTools) },
  { label: 'security', load: () => import('./mcp-tools/security-tools.js').then(m => m.securityTools) },
  { label: 'transfer', load: () => import('./mcp-tools/transfer-tools.js').then(m => m.transferTools) },
  // V2 Compatibility tools
  { label: 'system', load: () => import('./mcp-tools/system-tools.js').then(m => m.systemTools) },
  { label: 'terminal', load: () => import('./mcp-tools/terminal-tools.js').then(m => m.terminalTools) },
  { label: 'neural', load: () => import('./mcp-tools/neural-tools.js').then(m => m.neuralTools) },
  { label: 'performance', load: () => import('./mcp-tools/performance-tools.js').then(m => m.performanceTools) },
  { label: 'github', load: () => import('./mcp-tools/github-tools.js').then(m => m.githubTools) },
  { label: 'daa', load: () => import('./mcp-tools/daa-tools.js').then(m => m.daaTools) },
  { label: 'coordination', load: () => import('./mcp-tools/coordination-tools.js').then(m => m.coordinationTools) },
  // browser & browser-session — loaded with availability gating, see below
  { label: 'browser', load: () => loadBrowserTools() },
  { label: 'browser-session', load: () => import('./mcp-tools/browser-session-tools.js').then(m => m.browserSessionTools) },
  // Phase 6: AgentDB v3 controller tools
  { label: 'agentdb', load: () => import('./mcp-tools/agentdb-tools.js').then(m => m.agentdbTools) },
  // RuVector WASM tools
  { label: 'ruvllm-wasm', load: () => import('./mcp-tools/ruvllm-tools.js').then(m => m.ruvllmWasmTools) },
  { label: 'wasm-agent', load: () => import('./mcp-tools/wasm-agent-tools.js').then(m => m.wasmAgentTools) },
  // Guidance & discovery tools
  { label: 'guidance', load: () => import('./mcp-tools/guidance-tools.js').then(m => m.guidanceTools) },
  // Autopilot persistent completion tools
  { label: 'autopilot', load: () => import('./mcp-tools/autopilot-tools.js').then(m => m.autopilotTools) },
];

// #1605: Only register browser tools if agent-browser binary is available.
// We detect with a 3s timeout `agent-browser --version` probe — execFileSync
// is sync but only fires when this loader is invoked (i.e. inside MCP mode
// where the cost is amortised over the full server lifetime). The probe
// result is cached so a second call doesn't re-shell.
let _browserAvailable: boolean | null = null;
async function loadBrowserTools(): Promise<readonly MCPTool[]> {
  if (_browserAvailable === null) {
    try {
      execFileSync('agent-browser', ['--version'], { stdio: 'ignore', timeout: 3000 });
      _browserAvailable = true;
    } catch (err) {
      swallowError('mcp-client.loadBrowserTools.probe', err, 'agent-browser binary not found');
      _browserAvailable = false;
    }
  }
  if (!_browserAvailable) return [];
  const mod = await import('./mcp-tools/browser-tools.js');
  return mod.browserTools;
}

// ---------------------------------------------------------------------------
// Tool registry (populated lazily)
// ---------------------------------------------------------------------------
// Starts empty. Stays empty until the first `await ensureMcpToolsLoaded()` or
// `await callMCPTool(...)`. Sync APIs read from this map directly; they
// return empty / false / undefined when the registry is not yet populated.
//
// In practice the registry is populated in three places:
//   - bin/cli.js MCP-stdio mode: `await ensureMcpToolsLoaded()` before stdin handler
//   - bin/mcp-server.js: same boundary, before stdin handler
//   - commands/mcp.ts (`mcp tools`, `mcp exec`): `await ensureMcpToolsLoaded()` at action start
//   - src/mcp-server.ts startStdioServer(): same boundary
// Plus auto-load on the first `callMCPTool` from any code path (e.g.
// `ruflo agent spawn` calls `await callMCPTool('agent_spawn', …)`, which
// triggers the load on its own).
const TOOL_REGISTRY = new Map<string, MCPTool>();

let _loadPromise: Promise<void> | null = null;

/**
 * Populate the tool registry by lazily importing all 25+ MCP tool packages.
 *
 * Idempotent: subsequent calls await the same promise (no double-load). If
 * the load is in flight, concurrent callers all await the same in-flight
 * promise; if it's already resolved, this returns immediately.
 *
 * @example
 * ```ts
 * // At MCP server boot, before the first tools/list arrives:
 * await ensureMcpToolsLoaded();
 * ```
 */
export async function ensureMcpToolsLoaded(): Promise<void> {
  if (_loadPromise !== null) return _loadPromise;

  _loadPromise = (async () => {
    // Parallelise the imports — Node's module loader interleaves cold-binding
    // resolution work, so 28 parallel imports finish ~3-5x faster than serial.
    const settled = await Promise.allSettled(
      TOOL_LOADERS.map(async ({ label, load }) => {
        try {
          const tools = await load();
          return { label, tools };
        } catch (err) {
          // Swallow per-package failures so one bad tool group doesn't break
          // the whole MCP server. Surfaces in DEBUG/TRACE logs.
          swallowError(`mcp-client.loadAllTools.${label}`, err);
          return { label, tools: [] as readonly MCPTool[] };
        }
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        // Promise.allSettled never rejects, but TS narrows correctly only
        // when we branch — so this is a no-op safety net.
        swallowError('mcp-client.loadAllTools.settled', result.reason);
        continue;
      }
      for (const tool of result.value.tools) {
        TOOL_REGISTRY.set(tool.name, tool);
      }
    }
  })();

  return _loadPromise;
}

/**
 * Test-only: clear the registry and reset the load latch. Lets the lazy-load
 * test re-import a fresh module-graph slice without polluting the cache.
 * Not exported as part of the public CLI surface — use only from tests.
 *
 * @internal
 */
export function __resetForTests(): void {
  TOOL_REGISTRY.clear();
  _loadPromise = null;
  _browserAvailable = null;
}

/**
 * MCP Client Error
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public toolName: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'MCPClientError';
  }
}

/**
 * Call an MCP tool by name with input parameters
 *
 * Auto-loads the tool registry on first call so non-MCP-mode callers don't
 * need to manually `await ensureMcpToolsLoaded()`. The first call pays the
 * tool-graph init cost (~80-150ms cold); subsequent calls are free.
 *
 * @param toolName - Name of the MCP tool (e.g., 'agent_spawn', 'swarm_init')
 * @param input - Input parameters for the tool
 * @param context - Optional tool context
 * @returns Promise resolving to tool result
 * @throws {MCPClientError} If tool not found or execution fails
 *
 * @example
 * ```typescript
 * // Spawn an agent
 * const result = await callMCPTool('agent_spawn', {
 *   agentType: 'coder',
 *   priority: 'normal'
 * });
 *
 * // Initialize swarm
 * const swarm = await callMCPTool('swarm_init', {
 *   topology: 'hierarchical-mesh',
 *   maxAgents: 15
 * });
 * ```
 */
export async function callMCPTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown> = {},
  context?: Record<string, unknown>
): Promise<T> {
  // Auto-load on first call. No-op if already loaded.
  await ensureMcpToolsLoaded();

  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    throw new MCPClientError(
      `MCP tool not found: ${toolName}`,
      toolName
    );
  }

  try {
    const result = await tool.handler(input, context);
    return result as T;
  } catch (error) {
    throw new MCPClientError(
      `Failed to execute MCP tool '${toolName}': ${error instanceof Error ? error.message : String(error)}`,
      toolName,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get tool metadata by name.
 *
 * Sync façade: reads from the in-memory registry. Returns `undefined` when
 * the registry is not yet populated. Callers that need to guarantee the
 * registry is loaded should `await ensureMcpToolsLoaded()` first.
 *
 * @param toolName - Name of the MCP tool
 * @returns Tool metadata or undefined if not found / not loaded
 */
export function getToolMetadata(toolName: string): Omit<MCPTool, 'handler'> | undefined {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return undefined;
  }

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  };
}

/**
 * List all available MCP tools.
 *
 * Sync façade: reads from the in-memory registry. Returns `[]` when the
 * registry is not yet populated. Callers that depend on a complete list
 * (e.g. MCP `tools/list`) should `await ensureMcpToolsLoaded()` first.
 *
 * @param category - Optional category filter
 * @returns Array of tool metadata
 */
export function listMCPTools(category?: string): Array<Omit<MCPTool, 'handler'>> {
  const tools = Array.from(TOOL_REGISTRY.values());

  const filtered = category
    ? tools.filter(t => t.category === category)
    : tools;

  return filtered.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  }));
}

/**
 * Check if an MCP tool exists.
 *
 * Sync façade: returns `false` when the registry is not yet populated.
 *
 * @param toolName - Name of the MCP tool
 * @returns True if tool exists in the loaded registry
 */
export function hasTool(toolName: string): boolean {
  return TOOL_REGISTRY.has(toolName);
}

/**
 * Get all tool categories.
 *
 * Sync façade: returns `[]` when the registry is not yet populated.
 *
 * @returns Array of unique categories
 */
export function getToolCategories(): string[] {
  const categories = new Set<string>();

  TOOL_REGISTRY.forEach(tool => {
    if (tool.category) {
      categories.add(tool.category);
    }
  });

  return Array.from(categories).sort();
}

/**
 * Validate tool input against schema.
 *
 * Sync façade: returns `{ valid: false, errors: ["Tool '<name>' not found"] }`
 * when the registry is not yet populated.
 *
 * @param toolName - Name of the MCP tool
 * @param input - Input to validate
 * @returns Validation result with errors if any
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { valid: boolean; errors?: string[] } {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return {
      valid: false,
      errors: [`Tool '${toolName}' not found`],
    };
  }

  const schema = tool.inputSchema;
  const errors: string[] = [];

  if (schema.required && Array.isArray(schema.required)) {
    for (const requiredField of schema.required) {
      if (!(requiredField in input)) {
        errors.push(`Missing required field: ${requiredField}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  callMCPTool,
  ensureMcpToolsLoaded,
  getToolMetadata,
  listMCPTools,
  hasTool,
  getToolCategories,
  validateToolInput,
  MCPClientError,
};
