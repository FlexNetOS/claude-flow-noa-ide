/**
 * Regression test for Bug 19: browser_session_record was invoking
 *   npx -y ruvector@0.2.25 rvf create <path> --kind browser-session
 * but rvf requires -d/--dimension <n>. The call errored out immediately and
 * the MCP tool was unusable. The fix is to pass --dimension 384 (matches the
 * codebase-wide ONNX all-MiniLM-L6-v2 embedding dimension reported by
 * neural_status.totalEmbeddingDims).
 *
 * Strategy:
 *   - source-text assertion: cheap, robust against runtime mock issues, and
 *     directly forces a future refactor to keep --dimension in the args.
 *   - behavioral assertion: mock node:child_process.execFile, invoke the
 *     handler, and assert --dimension and 384 appear in the args array on
 *     the rvf create call.
 *
 * Both assertions guard the same contract from different angles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock node:child_process before importing the tool module. The shell() helper
// in browser-session-tools.ts dynamic-imports node:child_process and wraps
// execFile via util.promisify, so we mock execFile to a function that calls
// its callback synchronously with a recorded-args result.
// =============================================================================

type ExecFileCall = { cmd: string; args: string[]; opts: unknown };
const execFileCalls: ExecFileCall[] = [];

vi.mock('node:child_process', () => {
  return {
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      execFileCalls.push({ cmd, args, opts });
      // Return success quickly so the handler proceeds past each shell() step.
      // For the agent-browser open call we also return success — the actual
      // browser does not need to be present for this regression check.
      cb(null, { stdout: 'ok', stderr: '' });
    },
  };
});

// fs/promises is used for ensureSessionsDir; partial-mock so mkdir is a no-op
// while readFile (used by the static-source-guard test below) keeps working.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn(async () => undefined),
  };
});

import { browserSessionTools } from '../src/mcp-tools/browser-session-tools.js';

describe('browser_session_record — Bug 19: rvf create must pass --dimension', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
  });

  it('passes --dimension 384 to rvf create (behavioral)', async () => {
    const tool = browserSessionTools.find((t) => t.name === 'browser_session_record');
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      url: 'https://example.com',
      task: 'bug19-regression',
      session: 'bug19-test',
    });

    // The handler must succeed end-to-end now that rvf create is well-formed.
    const parsed = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { success: boolean };
    expect(parsed.success).toBe(true);

    // Find the rvf create invocation. The shell() helper calls
    //   execFile('npx', ['-y', 'ruvector@0.2.25', 'rvf', 'create', <path>, ...])
    const rvfCreate = execFileCalls.find(
      (c) => c.cmd === 'npx' && c.args.includes('rvf') && c.args.includes('create'),
    );
    expect(rvfCreate, 'rvf create must be invoked').toBeDefined();

    // The contract: --dimension and 384 are in the args, in order.
    const args = rvfCreate!.args;
    expect(args).toContain('--dimension');
    expect(args).toContain('384');
    const dimIdx = args.indexOf('--dimension');
    expect(args[dimIdx + 1]).toBe('384');

    // Sanity: the existing args were not regressed.
    expect(args).toContain('--kind');
    expect(args[args.indexOf('--kind') + 1]).toBe('browser-session');
  });

  it('source contains --dimension flag for rvf create (static guard)', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    // Walk up from the compiled test file location to the cli package root.
    // __dirname isn't available in ESM tests; rely on the known repo layout.
    const here = url.fileURLToPath(new URL('.', import.meta.url));
    const src = path.resolve(here, '..', 'src', 'mcp-tools', 'browser-session-tools.ts');
    const text = await readFile(src, 'utf-8');

    // The literal arg list around 'rvf create' must include --dimension.
    expect(text).toMatch(/'rvf',\s*'create'[^\]]*'--dimension'/);
    expect(text).toContain("RVF_DIMENSION = '384'");
  });
});
