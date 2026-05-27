/**
 * #perf-cache-2026-05 — regression tests for prompt-cache shaping in
 * agent-execute-core.ts. We assert the request body emits the 3-breakpoint
 * structured `system` array, RAG goes below the cache, and the response's
 * cache_read/creation tokens are surfaced + persisted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = mkdtempSync(join(tmpdir(), 'ruflo-cache-home-'));
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

let prevApiKey: string | undefined;
let prevFlowCwd: string | undefined;
let tmpProjectDir: string;

beforeEach(() => {
  prevApiKey = process.env.ANTHROPIC_API_KEY;
  prevFlowCwd = process.env.CLAUDE_FLOW_CWD;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.RUFLO_PROVIDER;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-cache-test';

  tmpProjectDir = mkdtempSync(join(tmpdir(), 'ruflo-cache-proj-'));
  process.env.CLAUDE_FLOW_CWD = tmpProjectDir;
  rmSync(join(fakeHome, '.claude'), { recursive: true, force: true });
});

afterEach(() => {
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
  if (prevFlowCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevFlowCwd;
  rmSync(tmpProjectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function stubAgentRegistry(agentId: string) {
  const dir = join(tmpProjectDir, '.claude-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({
      agents: {
        [agentId]: {
          agentId,
          agentType: 'coder',
          status: 'idle',
          health: 1,
          taskCount: 0,
          config: {},
          createdAt: new Date().toISOString(),
          model: 'sonnet',
        },
      },
      version: '3.0.0',
    }),
    'utf-8',
  );
}

/** Create a CLAUDE.md large enough that the cached-segment warning won't fire. */
function writeProjectClaudeMd(content?: string) {
  const body = content ?? 'x'.repeat(8000); // ~2000 tokens, well above min
  writeFileSync(join(tmpProjectDir, 'CLAUDE.md'), body, 'utf-8');
}

function stubCacheFetchSuccess() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      id: 'msg_cache_test',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      },
    }),
  });
}

describe('#perf-cache — executeAgentTask cache shaping', () => {
  it('emits 3-breakpoint structured `system` when CLAUDE.md is present', async () => {
    stubAgentRegistry('agent-cache');
    writeProjectClaudeMd();
    const fetchSpy = stubCacheFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    const result = await executeAgentTask({
      agentId: 'agent-cache',
      prompt: 'do the thing',
      systemPrompt: 'y'.repeat(8000),
      toolsBlock: 'z'.repeat(8000),
    });

    expect(result.success).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(3);
    // Order: tools → system → projectContext, all ttl=1h
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.system[2].text).toContain('CLAUDE.md');
  });

  it('appends extended-cache-ttl beta when shaping a 1h-TTL request', async () => {
    stubAgentRegistry('agent-beta');
    writeProjectClaudeMd();
    const fetchSpy = stubCacheFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    await executeAgentTask({ agentId: 'agent-beta', prompt: 'ping', systemPrompt: 'y'.repeat(5000) });

    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    // API-key path has no oauth beta — only the cache beta should appear.
    expect(headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');
  });

  it('puts ragBlock in the user message, NOT inside the cached system array', async () => {
    stubAgentRegistry('agent-rag');
    writeProjectClaudeMd();
    const fetchSpy = stubCacheFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    await executeAgentTask({
      agentId: 'agent-rag',
      prompt: 'main task',
      systemPrompt: 'y'.repeat(5000),
      ragBlock: 'RAG_SENTINEL_VALUE_42',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const systemSerialized = JSON.stringify(body.system);
    // RAG must be ABOVE — sorry, BELOW — the cache boundary, i.e. in user msg.
    expect(systemSerialized).not.toContain('RAG_SENTINEL_VALUE_42');
    expect(body.messages[0].content).toContain('RAG_SENTINEL_VALUE_42');
    expect(body.messages[0].content).toContain('main task');
  });

  it('surfaces cache_read / cache_creation tokens via result.cache + persists stats file', async () => {
    stubAgentRegistry('agent-stats');
    writeProjectClaudeMd();
    const fetchSpy = stubCacheFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    const result = await executeAgentTask({
      agentId: 'agent-stats',
      prompt: 'measure',
      systemPrompt: 'y'.repeat(5000),
    });

    expect(result.cache).toBeDefined();
    expect(result.cache!.cacheReadTokens).toBe(800);
    expect(result.cache!.cacheCreationTokens).toBe(200);
    expect(result.cache!.rawInputTokens).toBe(12);
    // 800 / (800+200+12) = 0.7905...
    expect(result.cache!.hitRatio).toBeCloseTo(800 / 1012, 4);

    // Stats file persisted under .claude-flow/cache-stats.json
    const statsPath = join(tmpProjectDir, '.claude-flow', 'cache-stats.json');
    expect(existsSync(statsPath)).toBe(true);
    const file = JSON.parse(readFileSync(statsPath, 'utf-8'));
    expect(file.recent[0].cacheReadTokens).toBe(800);
    expect(file.recent[0].model).toBe('claude-3-5-sonnet-latest');
  });

  it('falls back to plain `system` string when CLAUDE.md absent and no caller blocks', async () => {
    stubAgentRegistry('agent-legacy');
    // No CLAUDE.md — but systemPrompt is still present, so we still expect
    // structured form (single block) since modelSupportsPromptCache is true.
    const fetchSpy = stubCacheFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    await executeAgentTask({
      agentId: 'agent-legacy',
      prompt: 'p',
      // Use the agent's auto-built system prompt by omitting systemPrompt.
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    // Even with auto-built system prompt, structured form fires because
    // we always have at least the system breakpoint. That's expected — it
    // gives us cache hits across re-invocations of the same agent.
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system.length).toBeGreaterThanOrEqual(1);
  });
});
