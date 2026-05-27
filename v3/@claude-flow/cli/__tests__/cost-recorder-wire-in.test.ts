/**
 * Wire-in tests for the agent-execute-core → cost-recorder integration
 * (Gap 4 v1).
 *
 * Coverage:
 *   - A successful Anthropic response triggers a cost-recorder write
 *   - An unknown-model response still records the entry (cost=null, no throw)
 *   - sessionId / stepIndex / agentName / cacheTtl propagate when passed
 *
 * Mirrors the mock-fetch pattern from agent-execute-prompt-cache.test.ts so
 * we test the real wire path through callAnthropicMessages — same code path
 * that runs in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks: stub the Claude Code OAuth keychain probe so it can't bleed in.
// ---------------------------------------------------------------------------

const fakeHome = mkdtempSync(join(tmpdir(), 'ruflo-cost-wirein-home-'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args?: readonly string[]) => {
      if (cmd === 'security' && args?.[0] === 'find-generic-password') {
        const err = new Error('test: keychain stubbed') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return actual.execFileSync(cmd, args ?? []);
    },
  };
});

// ---------------------------------------------------------------------------
// Per-test isolation: fresh tmp project + claudeRoot for every case.
// ---------------------------------------------------------------------------

let prevApiKey: string | undefined;
let prevFlowCwd: string | undefined;
let prevInstallCtx: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  prevApiKey = process.env.ANTHROPIC_API_KEY;
  prevFlowCwd = process.env.CLAUDE_FLOW_CWD;
  prevInstallCtx = process.env.RUFLO_INSTALL_CONTEXT_JSON;

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.RUFLO_PROVIDER;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-cost-wirein';

  tmpRoot = mkdtempSync(join(tmpdir(), 'ruflo-cost-wirein-'));
  process.env.CLAUDE_FLOW_CWD = tmpRoot;
  // Pin the install context to tmpRoot so cost-stats.json lands inside it.
  process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
    packageRoot: tmpRoot,
    claudeRoot: tmpRoot,
    dataDir: join(tmpRoot, '.claude-flow', 'data'),
    isGlobalInstall: true,
    projectRoot: null,
  });

  rmSync(join(fakeHome, '.claude'), { recursive: true, force: true });
});

afterEach(() => {
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
  if (prevFlowCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevFlowCwd;
  if (prevInstallCtx === undefined) delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
  else process.env.RUFLO_INSTALL_CONTEXT_JSON = prevInstallCtx;

  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function costStatsPath(): string {
  return join(tmpRoot, '.claude-flow', 'cost-stats.json');
}

/**
 * Build a fetch mock returning a typical Anthropic Messages success response
 * with the supplied model id + usage. Defaults match a small-but-cached call.
 */
function stubFetch(opts?: {
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}) {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  const usage = {
    input_tokens: opts?.usage?.input_tokens ?? 100,
    output_tokens: opts?.usage?.output_tokens ?? 50,
    cache_read_input_tokens: opts?.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: opts?.usage?.cache_creation_input_tokens ?? 0,
  };
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      id: 'msg_wirein_test',
      model,
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-execute-core → cost-recorder wire-in', () => {
  it('records a cost entry after a successful Anthropic call', async () => {
    const fetchSpy = stubFetch({
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );

    const res = await callAnthropicMessages({
      prompt: 'compute it',
      model: 'claude-sonnet-4-6',
      sessionId: 'wirein-1',
      stepIndex: 3,
      agentName: 'coder-bridge',
    });
    expect(res.success).toBe(true);

    expect(existsSync(costStatsPath())).toBe(true);
    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(1);
    const e = file.entries[0];
    expect(e.sessionId).toBe('wirein-1');
    expect(e.stepIndex).toBe(3);
    expect(e.agent).toBe('coder-bridge');
    expect(e.model).toBe('claude-sonnet-4-6');
    expect(e.usage.input).toBe(1_000_000);
    expect(e.usage.output).toBe(100_000);
    expect(e.costUsd).not.toBeNull();
    // 1M input @ $3 + 100k output @ $15 = $3 + $1.5 = $4.5
    expect(e.costUsd.total).toBeCloseTo(4.5, 4);
  });

  it('records the entry with cost=null when the model is unknown (no throw)', async () => {
    const fetchSpy = stubFetch({ model: 'claude-imaginary-99-9' });
    vi.stubGlobal('fetch', fetchSpy);

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );

    const res = await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-imaginary-99-9',
    });
    expect(res.success).toBe(true);

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].model).toBe('claude-imaginary-99-9');
    expect(file.entries[0].costUsd).toBeNull();
    // Defaults still applied since caller didn't pass them
    expect(file.entries[0].sessionId).toBeNull();
    expect(file.entries[0].stepIndex).toBeNull();
    expect(file.entries[0].agent).toBe('unknown');
  });

  it('falls back to per-dispatch attribution when sessionId / stepIndex omitted', async () => {
    const fetchSpy = stubFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );

    await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      // No sessionId/stepIndex/agentName — should still record.
    });

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].sessionId).toBeNull();
    expect(file.entries[0].stepIndex).toBeNull();
    expect(file.entries[0].agent).toBe('unknown');
    expect(file.entries[0].cacheTtl).toBe('1h');
  });

  it('does NOT regress cache-stats persistence (cache-stats.json still written when structured caching applies)', async () => {
    // Need a sufficiently-large systemPrompt for structured caching to fire.
    const fetchSpy = stubFetch({
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );

    await callAnthropicMessages({
      prompt: 'p',
      systemPrompt: 'y'.repeat(8000),
      toolsBlock: 'z'.repeat(8000),
      model: 'claude-sonnet-4-6',
    });

    // Cost-stats and cache-stats both land — separate files.
    expect(existsSync(costStatsPath())).toBe(true);
    // cache-stats.json sits next to cost-stats.json under the same install
    // root because getProjectCwd() === CLAUDE_FLOW_CWD === tmpRoot here.
    const cachePath = join(tmpRoot, '.claude-flow', 'cache-stats.json');
    expect(existsSync(cachePath)).toBe(true);
  });
});
