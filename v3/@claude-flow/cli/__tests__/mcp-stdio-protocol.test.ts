import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER = join(__dirname, '..', 'bin', 'mcp-server.js');
const CLI = join(__dirname, '..', 'bin', 'cli.js');

let server: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  server = null;
});

function readJsonLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC stdout line. Buffer: ${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Non-JSON stdout line: ${line}`));
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`MCP server exited before response: code=${code} signal=${signal}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe('stdio MCP protocol', () => {
  it.each([
    ['direct MCP server bin', MCP_SERVER, []],
    ['CLI mcp start auto-detect path', CLI, ['mcp', 'start']],
  ])('keeps stdout JSON-RPC-only for %s when hook tools log diagnostics', async (_name, bin, args) => {
    server = spawn(process.execPath, [bin, ...args], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, CLAUDE_FLOW_CWD: join(__dirname, '..') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    send(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const init = await readJsonLine(server);
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1 });

    send(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'hooks_route',
        arguments: {
          task: 'MCP stdio smoke route validation',
          context: 'protocol stdout must remain JSON only',
          useSemanticRouter: true,
        },
      },
    });

    const route = await readJsonLine(server);
    expect(route).toMatchObject({ jsonrpc: '2.0', id: 2 });
    expect(route).toHaveProperty('result');

    send(server, { jsonrpc: '2.0', id: 3, method: 'ping' });
    const ping = await readJsonLine(server);
    expect(ping).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});
