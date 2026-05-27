/**
 * RuVector Agent WASM Integration
 *
 * Wraps @ruvector/rvagent-wasm for sandboxed AI agent execution.
 * Provides WasmAgent lifecycle, gallery templates, RVF container building,
 * and MCP server bridge — all running in WASM without OS access.
 *
 * Published API (v0.1.0): WasmAgent, WasmGallery, WasmMcpServer,
 * WasmRvfBuilder, JsModelProvider, initSync.
 *
 * @module @claude-flow/cli/ruvector/agent-wasm
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// ── Types ────────────────────────────────────────────────────

export interface WasmAgentConfig {
  model?: string;
  instructions?: string;
  maxTurns?: number;
}

export interface WasmAgentInfo {
  id: string;
  state: 'idle' | 'running' | 'error';
  config: WasmAgentConfig;
  model: string;
  turnCount: number;
  fileCount: number;
  isStopped: boolean;
  createdAt: string;
}

export interface GalleryTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  author: string;
  builtin: boolean;
}

export interface GalleryTemplateDetail extends GalleryTemplate {
  tools: Array<{ name: string; description: string; parameters: unknown[]; returns: string }>;
  prompts: Array<{ name: string; system_prompt: string; version: string }>;
  skills: Array<{ name: string; description: string; trigger: string; content: string }>;
  mcp_tools: Array<{ name: string; description: string; input_schema: unknown; group: string }>;
  capabilities: Array<{ name: string; rights: string[]; scope: string; delegation_depth: number }>;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

// ── WASM Module Detection & Init ─────────────────────────────

let _wasmReady = false;

// #bug18 — `@ruvector/rvagent-wasm` is an optionalDependency that may not
// be installed at runtime. Routing dynamic imports through an indirect
// module name keeps TypeScript from trying to resolve the package at
// compile time and lets us catch the runtime ERR_MODULE_NOT_FOUND in one
// place. Same pattern as bug16c (`@ruvector/learning-wasm`).
const RVAGENT_WASM_MODULE = '@ruvector/rvagent-wasm';

/**
 * Sentinel string included in error messages so MCP / CLI handlers can
 * detect "WASM runtime missing" vs other failures and emit a friendly
 * `_hint` to the user instead of a raw `ERR_MODULE_NOT_FOUND` stack.
 */
export const RVAGENT_WASM_NOT_INSTALLED = '@ruvector/rvagent-wasm not installed';

/**
 * Best-effort detection of "module not found" errors. Node throws
 * `ERR_MODULE_NOT_FOUND` (ESM) or `MODULE_NOT_FOUND` (CJS) depending on
 * the resolver path; both surface as either `err.code` or in the message.
 */
export function isRvagentWasmMissingError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find package '@ruvector\/rvagent-wasm'/.test(msg)
    || /Cannot find module '@ruvector\/rvagent-wasm'/.test(msg)
    // Vite/Vitest resolver phrasing — different wording, same root cause.
    || /Failed to load url @ruvector\/rvagent-wasm/.test(msg)
    || msg.includes(RVAGENT_WASM_NOT_INSTALLED);
}

/**
 * Load the optional @ruvector/rvagent-wasm module via an indirect module
 * name so TS doesn't resolve it at compile time. Returns `null` when the
 * package is not installed (the typical case — it's an optionalDependency).
 */
async function loadRvagentWasmModule(): Promise<any | null> {
  try {
    return await import(/* @vite-ignore */ RVAGENT_WASM_MODULE);
  } catch (err) {
    if (isRvagentWasmMissingError(err)) return null;
    throw err;
  }
}

/**
 * Internal helper — call after `initAgentWasm()` succeeded to grab the
 * loaded module. Throws a recognizable error if the package is missing
 * (callers should already have gated on `isAgentWasmAvailable()` /
 * `initAgentWasm()`).
 */
async function requireRvagentWasm(): Promise<any> {
  const mod = await loadRvagentWasmModule();
  if (mod === null) {
    throw new Error(
      `${RVAGENT_WASM_NOT_INSTALLED}. Install it with: npm install @ruvector/rvagent-wasm`
    );
  }
  return mod;
}

/**
 * Check if @ruvector/rvagent-wasm is installed and loadable.
 */
export async function isAgentWasmAvailable(): Promise<boolean> {
  const mod = await loadRvagentWasmModule();
  return mod !== null && typeof mod.WasmAgent === 'function';
}

/**
 * Initialize the WASM module for Node.js. Safe to call multiple times.
 * Uses initSync with file-loaded WASM bytes (browser fetch doesn't work in Node).
 *
 * Throws an error containing `RVAGENT_WASM_NOT_INSTALLED` when the
 * optional package is missing — handlers should detect this via
 * `isRvagentWasmMissingError` and return a friendly `{ error, _hint }`
 * shape instead of a raw stack trace.
 */
export async function initAgentWasm(): Promise<void> {
  if (_wasmReady) return;
  const mod = await loadRvagentWasmModule();
  if (mod === null) {
    throw new Error(
      `${RVAGENT_WASM_NOT_INSTALLED}. Install it with: npm install @ruvector/rvagent-wasm`
    );
  }
  try {
    // In Node.js, load WASM bytes from disk and use initSync
    const require_ = createRequire(import.meta.url);
    // Indirect module name keeps TS from attempting compile-time resolution.
    const wasmPath = require_.resolve(`${RVAGENT_WASM_MODULE}/rvagent_wasm_bg.wasm`);
    const wasmBytes = readFileSync(wasmPath);
    mod.initSync(wasmBytes);
    _wasmReady = true;
  } catch (err) {
    throw new Error(`Failed to initialize @ruvector/rvagent-wasm: ${err}`);
  }
}

// ── Agent Registry ───────────────────────────────────────────

const agents = new Map<string, { agent: any; info: WasmAgentInfo }>();
let nextId = 1;

function generateId(): string {
  return `wasm-agent-${nextId++}-${Date.now().toString(36)}`;
}

// ── Agent Lifecycle ──────────────────────────────────────────

/**
 * Create a new sandboxed WASM agent.
 */
export async function createWasmAgent(config: WasmAgentConfig = {}): Promise<WasmAgentInfo> {
  await initAgentWasm();
  const mod = await requireRvagentWasm();

  // #1810 — was hardcoded `anthropic:claude-sonnet-4-20250514`. Updated to
  // current Sonnet (4.6) so new gallery agents don't silently inherit a
  // year-old model. Callers can still override via `config.model`.
  const configJson = JSON.stringify({
    model: config.model ?? 'anthropic:claude-sonnet-4-6',
    instructions: config.instructions ?? 'You are a helpful coding assistant.',
    max_turns: config.maxTurns ?? 50,
  });

  const agent = new mod.WasmAgent(configJson);
  const id = generateId();

  const info: WasmAgentInfo = {
    id,
    state: 'idle',
    config,
    model: agent.model(),
    turnCount: agent.turn_count(),
    fileCount: agent.file_count(),
    isStopped: agent.is_stopped(),
    createdAt: new Date().toISOString(),
  };

  agents.set(id, { agent, info });
  return info;
}

/**
 * Send a prompt to a WASM agent.
 *
 * ADR-095 G4: the bundled @ruvector/rvagent-wasm doesn't actually run an
 * LLM — its prompt() method echoes input back as `"echo: <input>"`. We
 * detect that stub output and route the prompt through Anthropic's
 * Messages API so users get a real response. The WASM agent's sandbox
 * (virtual filesystem, tool execution) still works for non-LLM ops via
 * executeWasmTool — we're just patching the "talk to a model" hole.
 *
 * If ANTHROPIC_API_KEY is not set, returns the stub output verbatim so
 * the failure mode is obvious to the caller (matches the previous
 * behaviour rather than throwing for users without keys configured).
 */
export async function promptWasmAgent(agentId: string, input: string): Promise<string> {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);

  entry.info.state = 'running';
  try {
    const wasmResult = await entry.agent.prompt(input);
    entry.info.state = 'idle';
    syncAgentInfo(entry);

    // Detect the WASM echo stub.
    const isEchoStub = typeof wasmResult === 'string' &&
      (wasmResult === `echo: ${input}` || /^echo: /.test(wasmResult.slice(0, 12)));

    if (!isEchoStub) {
      return wasmResult;
    }

    // Echo stub detected — route through a real LLM call.
    if (!process.env.ANTHROPIC_API_KEY) {
      // No key configured; surface the stub honestly with a hint.
      return `${wasmResult}\n[NOTE: bundled WASM agent has no LLM; set ANTHROPIC_API_KEY to enable real responses via Anthropic Messages API]`;
    }

    const { callAnthropicMessages, resolveAnthropicModel } = await import('../mcp-tools/agent-execute-core.js');
    const model = resolveAnthropicModel(entry.info.config.model);
    const systemPrompt = entry.info.config.instructions || 'You are a helpful coding assistant running in a Ruflo WASM agent sandbox.';
    const result = await callAnthropicMessages({
      prompt: input,
      systemPrompt,
      model,
      maxTokens: 2048,
    });
    if (!result.success) {
      return `${wasmResult}\n[NOTE: bundled WASM agent has no LLM; Anthropic fallback failed: ${result.error}]`;
    }
    // Return the real LLM output, not the echo stub.
    return result.output ?? '';
  } catch (err) {
    entry.info.state = 'error';
    throw err;
  }
}

/**
 * Execute a tool directly on a WASM agent's sandbox.
 * Tool format: {tool: 'write_file', path: '...', content: '...'} (flat, snake_case).
 * Available tools: read_file, write_file, edit_file, write_todos, list_files.
 */
const VALID_WASM_TOOLS = ['read_file', 'write_file', 'edit_file', 'write_todos', 'list_files'];

export async function executeWasmTool(agentId: string, toolCall: Record<string, unknown>): Promise<ToolResult> {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);
  // Validate tool name to prevent WASM panics on unknown tools
  const toolName = toolCall.tool as string;
  if (toolName && !VALID_WASM_TOOLS.includes(toolName)) {
    return { success: false, output: `Unknown tool: ${toolName}. Available: ${VALID_WASM_TOOLS.join(', ')}` };
  }
  const result = await entry.agent.execute_tool(JSON.stringify(toolCall));
  syncAgentInfo(entry);
  return result as ToolResult;
}

function syncAgentInfo(entry: { agent: any; info: WasmAgentInfo }): void {
  try {
    entry.info.turnCount = entry.agent.turn_count();
    entry.info.fileCount = entry.agent.file_count();
    entry.info.isStopped = entry.agent.is_stopped();
  } catch { /* best-effort */ }
}

/**
 * Get agent info.
 */
export function getWasmAgent(agentId: string): WasmAgentInfo | null {
  const entry = agents.get(agentId);
  if (!entry) return null;
  syncAgentInfo(entry);
  return entry.info;
}

/**
 * List all active WASM agents.
 */
export function listWasmAgents(): WasmAgentInfo[] {
  return Array.from(agents.values()).map(e => {
    syncAgentInfo(e);
    return e.info;
  });
}

/**
 * Terminate a WASM agent and free resources.
 */
export function terminateWasmAgent(agentId: string): boolean {
  const entry = agents.get(agentId);
  if (!entry) return false;
  try { entry.agent.free(); } catch { /* already freed */ }
  agents.delete(agentId);
  return true;
}

/**
 * Get agent state (messages, turn count, etc.)
 */
export function getWasmAgentState(agentId: string): unknown {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);
  return entry.agent.get_state();
}

/**
 * Get agent tools list.
 */
export function getWasmAgentTools(agentId: string): string[] {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);
  return entry.agent.get_tools();
}

/**
 * Get agent todos.
 */
export function getWasmAgentTodos(agentId: string): unknown[] {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);
  return entry.agent.get_todos();
}

/**
 * Export the full agent state as JSON (for persistence).
 */
export function exportWasmState(agentId: string): string {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);
  return JSON.stringify({
    agentState: entry.agent.get_state(),
    tools: entry.agent.get_tools(),
    todos: entry.agent.get_todos(),
    info: entry.info,
  });
}

// ── MCP Server Bridge ────────────────────────────────────────

/**
 * Create a WASM-based MCP server for an agent.
 * Returns a handler function for JSON-RPC requests.
 *
 * Note: WasmMcpServer may have stability issues in v0.1.0 for
 * certain agent configurations. Use with a fully configured agent.
 */
export async function createWasmMcpServer(agentId: string): Promise<(jsonRpc: string) => Promise<string>> {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`WASM agent not found: ${agentId}`);

  const mod = await requireRvagentWasm();
  const server = new mod.WasmMcpServer(entry.agent);

  return (jsonRpc: string) => server.handle_request(jsonRpc);
}

// ── Gallery Templates ────────────────────────────────────────

let _gallery: any | null = null;

async function getGallery(): Promise<any> {
  if (_gallery) return _gallery;
  await initAgentWasm();
  const mod = await requireRvagentWasm();
  _gallery = new mod.WasmGallery();
  return _gallery;
}

/**
 * List all available gallery templates.
 * Returns objects directly (Gallery.list() returns parsed objects in v0.1.0).
 */
export async function listGalleryTemplates(): Promise<GalleryTemplate[]> {
  const gallery = await getGallery();
  return gallery.list();
}

/**
 * Get gallery template count.
 */
export async function getGalleryCount(): Promise<number> {
  const gallery = await getGallery();
  return gallery.count();
}

/**
 * Get gallery categories with counts.
 */
export async function getGalleryCategories(): Promise<Record<string, number>> {
  const gallery = await getGallery();
  return gallery.getCategories();
}

/**
 * Search gallery templates by query. Returns results with relevance scores.
 */
export async function searchGalleryTemplates(query: string): Promise<Array<GalleryTemplate & { relevance: number }>> {
  const gallery = await getGallery();
  return gallery.search(query);
}

/**
 * Get a gallery template by id.
 * Wraps in try/catch because WasmGallery.get() panics on unknown IDs in v0.1.0.
 */
export async function getGalleryTemplate(id: string): Promise<GalleryTemplateDetail | null> {
  const gallery = await getGallery();
  try {
    return gallery.get(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Create an agent from a gallery template.
 */
export async function createAgentFromTemplate(templateId: string): Promise<WasmAgentInfo> {
  const template = await getGalleryTemplate(templateId);
  if (!template) throw new Error(`Gallery template not found: ${templateId}`);

  const systemPrompt = template.prompts?.[0]?.system_prompt;
  return createWasmAgent({
    instructions: systemPrompt ?? `You are a ${template.name}.`,
    model: undefined, // Use default
  });
}

// ── RVF Container Operations ─────────────────────────────────

/**
 * Build an RVF container with prompts, tools, and skills.
 * Uses the high-level RVF builder API (addPrompt, addTool, addSkill).
 */
export async function buildRvfContainer(opts: {
  prompts?: Array<{ name: string; system_prompt: string; version: string }>;
  tools?: Array<{ name: string; description: string; parameters: unknown[]; returns: string }>;
  skills?: Array<{ name: string; description: string; trigger: string; content: string }>;
}): Promise<Uint8Array> {
  await initAgentWasm();
  const mod = await requireRvagentWasm();
  const builder = new mod.WasmRvfBuilder();

  for (const p of opts.prompts ?? []) {
    builder.addPrompt(JSON.stringify(p));
  }
  for (const t of opts.tools ?? []) {
    builder.addTool(JSON.stringify(t));
  }
  for (const s of opts.skills ?? []) {
    builder.addSkill(JSON.stringify(s));
  }

  return builder.build();
}

/**
 * Build an RVF container from a gallery template.
 */
export async function buildRvfFromTemplate(templateId: string): Promise<Uint8Array> {
  const template = await getGalleryTemplate(templateId);
  if (!template) throw new Error(`Gallery template not found: ${templateId}`);

  return buildRvfContainer({
    prompts: template.prompts,
    tools: template.tools,
    skills: template.skills,
  });
}
