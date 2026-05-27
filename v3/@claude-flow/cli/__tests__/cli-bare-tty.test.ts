/**
 * Bug #28 regression: bare `ruflo` invocation in a TTY must print help and
 * exit, NOT silently launch the MCP-stdio server.
 *
 * The dispatch lives in bin/cli.js (a top-level await module that auto-runs
 * on import). We can't unit-test it by importing — the side effects fire
 * immediately. Instead we spawn the entry point as a child process with
 * controlled stdin and assert on the resulting stdout / exit code.
 *
 *   - TTY-stdin + no args → help printed, exit 0, NO MCP "Starting in
 *     stdio mode" log (which goes to stderr).
 *   - piped stdin + no args → MCP path taken (we send a minimal initialize
 *     request and verify a JSON-RPC response).
 *
 * Note: there's no portable way to allocate a real PTY from Node test code
 * without pulling in `node-pty`. We approximate by passing
 * `stdio: ['inherit', 'pipe', 'pipe']` for the TTY case (inherits the
 * vitest runner's TTY when present) and falling back to a feature check
 * that skips the test in non-interactive CI when the runner has no TTY.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'bin', 'cli.js');

function runCli(opts: {
  args?: string[];
  stdinPayload?: string | null; // null means inherit (TTY); string means pipe
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const stdinMode = opts.stdinPayload === null ? 'inherit' : 'pipe';
    const child = spawn('node', [CLI_ENTRY, ...(opts.args ?? [])], {
      stdio: [stdinMode, 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 15000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    if (typeof opts.stdinPayload === 'string') {
      child.stdin?.write(opts.stdinPayload);
      child.stdin?.end();
    }
  });
}

describe('Bug #28: bare-TTY ruflo prints help, piped stdin still serves MCP', () => {
  it('prints help and exits 0 when stdin is the inherited TTY and no args are given', async () => {
    // Skip if the test runner itself has no TTY (CI without pty allocation).
    // In that case `stdio: 'inherit'` inherits a non-TTY pipe and the test
    // becomes equivalent to the MCP-piped case, which is covered separately.
    if (!process.stdin.isTTY) {
      return;
    }

    const { stdout, stderr, code, timedOut } = await runCli({
      args: [],
      stdinPayload: null, // inherit parent's TTY
      timeoutMs: 10000,
    });

    expect(timedOut, `cli hung instead of printing help; stderr=${stderr}`).toBe(false);
    expect(code).toBe(0);
    // Help is written to stdout. MCP startup banner goes to stderr.
    expect(stdout).toMatch(/USAGE:/);
    expect(stdout).toMatch(/COMMANDS:/);
    expect(stderr).not.toMatch(/Starting in stdio mode/);
  }, 20000);

  it('enters MCP-stdio mode when stdin is piped (no args) and responds to initialize', async () => {
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }) + '\n';

    const { stdout, stderr, timedOut } = await runCli({
      args: [],
      stdinPayload: initReq,
      timeoutMs: 30000,
    });

    expect(timedOut, `cli hung; stderr=${stderr.slice(0, 500)}`).toBe(false);
    // MCP banner goes to stderr.
    expect(stderr).toMatch(/Starting in stdio mode/);
    // The initialize response is JSON-RPC on stdout.
    const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result?.protocolVersion).toBeDefined();
  }, 40000);

  it('still enters MCP mode for explicit `mcp start` over piped stdin', async () => {
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    }) + '\n';

    const { stdout, stderr, timedOut } = await runCli({
      args: ['mcp', 'start'],
      stdinPayload: initReq,
      timeoutMs: 30000,
    });

    expect(timedOut, `cli hung; stderr=${stderr.slice(0, 500)}`).toBe(false);
    expect(stderr).toMatch(/Starting in stdio mode/);
    const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe(2);
  }, 40000);
});
