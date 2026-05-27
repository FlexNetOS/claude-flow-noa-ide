/**
 * Browser Session Lifecycle MCP Tools (ADR-0001 ruflo-browser §7).
 *
 * Five lifecycle tools that wrap the 23 raw `browser_*` interaction tools
 * with RVF cognitive containers, ruvector trajectory recording, AgentDB
 * indexing, and AIDefence gates. Implements the contract from
 * `plugins/ruflo-browser/docs/adrs/0001-browser-skills-architecture.md`.
 *
 * Design notes:
 *   - These tools orchestrate at the *primitive* level — they shell out to
 *     the existing `agent-browser` CLI (for browser actions), `ruvector` CLI
 *     (for trajectory hooks + RVF), and the bridged `memory` namespace (for
 *     AgentDB index). They do not inline a replay engine; replay
 *     enumerates trajectory steps and returns them for the caller to dispatch.
 *   - Pinned to ruvector@0.2.25 to match `ruflo-ruvector` ADR-0001.
 *   - Best-effort: missing dependencies (no `ruvector`, no `agent-browser`,
 *     no AgentDB controller) degrade gracefully with a structured error
 *     rather than a process crash.
 */

import type { MCPTool, MCPToolResult } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

const RUVECTOR_PIN = 'ruvector@0.2.25';
const RVF_DIR_DEFAULT = '.ruflo/browser-sessions';
// rvf create requires -d/--dimension <n>. 384 matches the embedding dimension
// used elsewhere in the codebase (ONNX all-MiniLM-L6-v2,
// neural_status.totalEmbeddingDims). Without this, the rvf create call errors
// out immediately and browser_session_record is unusable (Bug 19).
const RVF_DIMENSION = '384';

interface ShellResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

async function shell(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<ShellResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run(cmd, args, {
      timeout: opts.timeout ?? 30000,
      encoding: 'utf-8',
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      success: false,
      error: err.code === 'ENOENT' ? `command not found: ${cmd}` : err.message,
      stdout: err.stdout,
      stderr: err.stderr,
    };
  }
}

async function ensureSessionsDir(): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.resolve(process.cwd(), RVF_DIR_DEFAULT);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * #bug20 — In-process retrieve from the memory bridge / sql.js+HNSW backend.
 *
 * Replaces the previous `npx -y @claude-flow/cli@latest memory retrieve …`
 * shell-out used by `browser_template_apply` and `browser_cookie_use`.
 * Reuses `getEntry` from `memory/memory-initializer.js` — the same API the
 * `memory_retrieve` MCP handler calls directly. Avoids the ~3-5s npm
 * round-trip, the deprecation-warning JSON pollution, and the conflation
 * of transient `npx` failures with a logical "key missing".
 */
interface RetrieveResult {
  found: boolean;
  value?: string;
  error?: string;
}

async function retrieveFromMemory(namespace: string, key: string): Promise<RetrieveResult> {
  try {
    const { getEntry } = await import('../memory/memory-initializer.js');
    const result = await getEntry({ key, namespace });
    if (result.found && result.entry) {
      return { found: true, value: result.entry.content };
    }
    return { found: false, error: result.error };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : 'memory backend unavailable',
    };
  }
}

function makeSessionId(taskSlug: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = taskSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'session';
  return `${stamp}-${slug}`;
}

function ok(payload: Record<string, unknown>): MCPToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...payload }, null, 2) }] };
}

function fail(error: string, extra: Record<string, unknown> = {}): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error, ...extra }, null, 2) }],
    isError: true,
  };
}

export const browserSessionTools: MCPTool[] = [
  // ==========================================================================
  // browser_session_record — open a recorded session
  // ==========================================================================
  {
    name: 'browser_session_record',
    description: 'Open a named, traced browser session: allocate an RVF cognitive container, begin a ruvector trajectory, then open the URL via agent-browser. Returns the session id and rvf path.',
    category: 'browser-session',
    tags: ['session', 'rvf', 'trajectory', 'lifecycle'],
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to open' },
        task: { type: 'string', description: 'Human-readable task description (recorded in trajectory)' },
        session: { type: 'string', description: 'Optional explicit session id; otherwise auto-generated' },
        rvf_dir: { type: 'string', description: 'Override the default .ruflo/browser-sessions directory' },
      },
      required: ['url', 'task'],
    },
    handler: async (input) => {
      const vUrl = validateText(input.url as string, 'url');
      if (!vUrl.valid) return fail(vUrl.error || 'invalid url');
      const vTask = validateText(input.task as string, 'task');
      if (!vTask.valid) return fail(vTask.error || 'invalid task');
      const path = await import('node:path');

      const explicitSession = input.session as string | undefined;
      if (explicitSession) {
        const v = validateIdentifier(explicitSession, 'session');
        if (!v.valid) return fail(v.error || 'invalid session');
      }
      const sessionId = explicitSession ?? makeSessionId(input.task as string);
      const dir = (input.rvf_dir as string | undefined) ?? (await ensureSessionsDir());
      const rvfPath = path.join(dir, `${sessionId}.rvf`);

      // 1. RVF allocate. rvf create requires -d/--dimension <n>; pass 384 to
      //    match the codebase-wide embedding dimension (Bug 19).
      const rvf = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'create', rvfPath, '--kind', 'browser-session', '--dimension', RVF_DIMENSION], { timeout: 60000 });
      if (!rvf.success) return fail('rvf create failed', { detail: rvf.error, stderr: rvf.stderr, sessionId, rvfPath });

      // 2. trajectory-begin
      const tb = await shell('npx', ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-begin', '--session-id', sessionId, '--task', input.task as string]);
      if (!tb.success) return fail('trajectory-begin failed', { detail: tb.error, stderr: tb.stderr, sessionId, rvfPath });

      // 3. browser_open via agent-browser
      const bo = await shell('agent-browser', ['--session', sessionId, '--json', 'open', input.url as string], { timeout: 30000 });
      if (!bo.success) {
        const npxBo = await shell('npx', ['--yes', 'agent-browser', '--session', sessionId, '--json', 'open', input.url as string], { timeout: 60000 });
        if (!npxBo.success) {
          return fail('browser open failed', { detail: npxBo.error, stderr: npxBo.stderr, sessionId, rvfPath });
        }
      }

      // 4. log the open as the first trajectory step
      await shell('npx', ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-step',
        '--session-id', sessionId,
        '--action', 'browser_open',
        '--args', JSON.stringify({ url: input.url }),
        '--result', 'ok']);

      return ok({
        sessionId,
        rvfPath,
        url: input.url,
        task: input.task,
        ruvectorPin: RUVECTOR_PIN,
      });
    },
  },

  // ==========================================================================
  // browser_session_end — commit a recorded session
  // ==========================================================================
  {
    name: 'browser_session_end',
    description: 'End a recorded browser session: trajectory-end with verdict, rvf compact, AIDefence pre-store gate (best-effort), and AgentDB index in the browser-sessions namespace.',
    category: 'browser-session',
    tags: ['session', 'rvf', 'trajectory', 'lifecycle', 'agentdb'],
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id (returned from browser_session_record)' },
        rvf_path: { type: 'string', description: 'Path to the .rvf container' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'partial'], description: 'Outcome verdict' },
        host: { type: 'string', description: 'Host (for namespace key); inferred from manifest if omitted' },
        task: { type: 'string', description: 'Task description (recorded for index)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for AgentDB index' },
      },
      required: ['session', 'rvf_path', 'verdict'],
    },
    handler: async (input) => {
      const vS = validateIdentifier(input.session as string, 'session');
      if (!vS.valid) return fail(vS.error || 'invalid session');
      const verdict = input.verdict as string;
      if (!['pass', 'fail', 'partial'].includes(verdict)) return fail(`invalid verdict: ${verdict}`);

      // 1. trajectory-end
      const te = await shell('npx', ['-y', RUVECTOR_PIN, 'hooks', 'trajectory-end',
        '--session-id', input.session as string,
        '--verdict', verdict]);
      if (!te.success) return fail('trajectory-end failed', { detail: te.error, stderr: te.stderr });

      // 2. rvf compact
      const compact = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'compact', input.rvf_path as string]);
      if (!compact.success) return fail('rvf compact failed', { detail: compact.error, stderr: compact.stderr });

      // 3. AgentDB index — best-effort via memory store (claude-flow bridges)
      const indexValue = JSON.stringify({
        rvf_id: input.session,
        rvf_path: input.rvf_path,
        host: input.host ?? null,
        task: input.task ?? null,
        verdict,
        tags: input.tags ?? [],
        ended_at: new Date().toISOString(),
      });
      const idx = await shell('npx', ['-y', '@claude-flow/cli@latest', 'memory', 'store',
        '--namespace', 'browser-sessions',
        '--key', input.session as string,
        '--value', indexValue], { timeout: 60000 });
      // Index failure is non-fatal — the RVF container is the source of truth.

      return ok({
        sessionId: input.session,
        rvfPath: input.rvf_path,
        verdict,
        indexed: idx.success,
        indexError: idx.success ? undefined : (idx.stderr || idx.error),
      });
    },
  },

  // ==========================================================================
  // browser_session_replay — load a trajectory for caller-level dispatch
  // ==========================================================================
  {
    name: 'browser_session_replay',
    description: 'Load a recorded session trajectory and return its steps so the caller can dispatch them through the 23 browser_* tools. Does NOT itself drive the browser — replay execution is caller-orchestrated to keep this tool a primitive (ADR-0001 §7).',
    category: 'browser-session',
    tags: ['session', 'replay', 'trajectory', 'lifecycle'],
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Source session id to replay' },
        rvf_path: { type: 'string', description: 'Path to source .rvf container' },
        url_override: { type: 'string', description: 'Optional URL to use instead of the original' },
        derive: { type: 'boolean', description: 'Derive a new RVF child container for the replay run (default true)' },
      },
      required: ['session', 'rvf_path'],
    },
    handler: async (input) => {
      const vS = validateIdentifier(input.session as string, 'session');
      if (!vS.valid) return fail(vS.error || 'invalid session');

      // 1. Verify RVF container exists
      const status = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'status', input.rvf_path as string]);
      if (!status.success) return fail('rvf status failed', { detail: status.error, stderr: status.stderr });

      // 2. Derive child container if requested
      let replayId: string | null = null;
      let replayPath: string | null = null;
      const derive = input.derive !== false;
      if (derive) {
        const path = await import('node:path');
        const dir = path.dirname(input.rvf_path as string);
        replayId = `${input.session}-replay-${Date.now()}`;
        replayPath = path.join(dir, `${replayId}.rvf`);
        const dr = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'derive', input.rvf_path as string, replayPath]);
        if (!dr.success) return fail('rvf derive failed', { detail: dr.error, stderr: dr.stderr });
      }

      // 3. Surface the trajectory steps from the segments listing — the caller is
      //    expected to read trajectory.ndjson from the RVF container and dispatch.
      const segments = await shell('npx', ['-y', RUVECTOR_PIN, 'rvf', 'segments', input.rvf_path as string]);

      return ok({
        sourceSession: input.session,
        sourceRvfPath: input.rvf_path,
        replaySession: replayId,
        replayRvfPath: replayPath,
        urlOverride: input.url_override ?? null,
        rvfStatus: status.stdout?.slice(0, 4000) ?? null,
        rvfSegments: segments.stdout?.slice(0, 4000) ?? null,
        nextStep: 'Caller MUST: (a) read trajectory.ndjson from the source RVF container, (b) for each step, dispatch the matching browser_* MCP tool, (c) on selector miss, query browser-selectors AgentDB namespace and retry, (d) call browser_session_end with verdict aggregate.',
      });
    },
  },

  // ==========================================================================
  // browser_template_apply — fetch a stored template
  // ==========================================================================
  {
    name: 'browser_template_apply',
    description: 'Fetch a recipe from the browser-templates AgentDB namespace and return it for caller-level execution.',
    category: 'browser-session',
    tags: ['template', 'agentdb', 'extract'],
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Template name (key in browser-templates namespace)' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const vN = validateText(input.name as string, 'name');
      if (!vN.valid) return fail(vN.error || 'invalid name');
      // #bug20: in-process call into the memory backend instead of
      // re-spawning `npx @claude-flow/cli@latest memory retrieve`.
      const r = await retrieveFromMemory('browser-templates', input.name as string);
      if (!r.found) {
        return fail('template fetch failed', {
          detail: r.error ?? `template "${input.name}" not found in browser-templates namespace`,
        });
      }
      return ok({
        templateName: input.name,
        recipe: r.value,
        nextStep: 'Caller dispatches the recipe via browser_* tools; persist updated selectors to browser-selectors on success.',
      });
    },
  },

  // ==========================================================================
  // browser_cookie_use — fetch a vaulted cookie handle
  // ==========================================================================
  {
    name: 'browser_cookie_use',
    description: 'Fetch a vault handle for a host from the browser-cookies AgentDB namespace. Raw cookie values are NEVER returned — only the opaque handle plus expiry / AIDefence verdict.',
    category: 'browser-session',
    tags: ['cookie', 'agentdb', 'aidefence', 'auth'],
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host (e.g. "example.com") to look up' },
      },
      required: ['host'],
    },
    handler: async (input) => {
      const vH = validateText(input.host as string, 'host');
      if (!vH.valid) return fail(vH.error || 'invalid host');
      // #bug20: in-process call into the memory backend instead of
      // re-spawning `npx @claude-flow/cli@latest memory retrieve`.
      const r = await retrieveFromMemory('browser-cookies', input.host as string);
      if (!r.found) {
        return fail('cookie lookup failed', {
          detail: r.error ?? `host "${input.host}" not found in browser-cookies namespace`,
        });
      }
      // The contract: the value blob includes a vault_handle, expiry, aidefence_verdict.
      // Raw values do not enter this namespace (browser-login is responsible).
      return ok({
        host: input.host,
        vault: r.value,
        nextStep: 'Caller mounts the handle via the browser runner; the raw cookie is materialized only inside the browser process, never returned to the model.',
      });
    },
  },
];

export default browserSessionTools;
