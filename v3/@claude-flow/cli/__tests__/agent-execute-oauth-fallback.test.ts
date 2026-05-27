/**
 * Regression tests for #bug24 — agent_execute must reuse the Claude Code
 * OAuth token when one is available locally, instead of demanding a
 * separate ANTHROPIC_API_KEY env var.
 *
 * We exercise the credential resolver directly (no network) and the
 * executeAgentTask boundary using a stubbed `fetch` so we can assert the
 * outgoing headers and the `_credSource` returned to the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Re-route the home directory used by the resolver — the helper reads
// `homedir()/.claude/.credentials.json`. Mocking node:os homedir() lets us
// drop a fake credentials file under tmp.
const fakeHome = mkdtempSync(join(tmpdir(), 'ruflo-bug24-home-'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// Force-skip the macOS Keychain branch — even on darwin runners the
// `security` binary may have a real "Claude Code-credentials" item we
// must not leak into tests. Stubbing execFileSync to throw makes the
// keychain reader return null cleanly.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args?: readonly string[]) => {
      if (cmd === 'security' && args?.[0] === 'find-generic-password') {
        const err = new Error('test: keychain access stubbed out') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return actual.execFileSync(cmd, args ?? []);
    },
  };
});

let prevEnvOAuth: string | undefined;
let prevApiKey: string | undefined;
let prevOllamaKey: string | undefined;
let prevProvider: string | undefined;
let prevFlowCwd: string | undefined;
let tmpProjectDir: string;

beforeEach(() => {
  prevEnvOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  prevApiKey = process.env.ANTHROPIC_API_KEY;
  prevOllamaKey = process.env.OLLAMA_API_KEY;
  prevProvider = process.env.RUFLO_PROVIDER;
  prevFlowCwd = process.env.CLAUDE_FLOW_CWD;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.RUFLO_PROVIDER;

  tmpProjectDir = mkdtempSync(join(tmpdir(), 'ruflo-bug24-proj-'));
  // Vitest workers forbid process.chdir(); getProjectCwd() honors
  // CLAUDE_FLOW_CWD, so the env-var indirection is the right knob here.
  process.env.CLAUDE_FLOW_CWD = tmpProjectDir;

  // Reset fake home each run so credentials.json from a prior test doesn't
  // leak across cases.
  rmSync(join(fakeHome, '.claude'), { recursive: true, force: true });
});

afterEach(() => {
  if (prevEnvOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevEnvOAuth;
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
  if (prevOllamaKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = prevOllamaKey;
  if (prevProvider === undefined) delete process.env.RUFLO_PROVIDER;
  else process.env.RUFLO_PROVIDER = prevProvider;
  if (prevFlowCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevFlowCwd;

  rmSync(tmpProjectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeFakeCredentialsFile(token: string) {
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    'utf-8',
  );
}

describe('#bug24 — Claude Code OAuth credential resolver', () => {
  it('returns the OAuth token from ~/.claude/.credentials.json when no env var is set', async () => {
    writeFakeCredentialsFile('oauth-tok-from-file');
    const { resolveClaudeCredential, getClaudeCodeOAuthToken } = await import(
      '../src/auth/claude-code-token.js'
    );
    expect(getClaudeCodeOAuthToken()).toBe('oauth-tok-from-file');
    const cred = resolveClaudeCredential();
    expect(cred.source).toBe('file-oauth');
    expect(cred.token).toBe('oauth-tok-from-file');
  });

  it('CLAUDE_CODE_OAUTH_TOKEN env var wins over the credentials file', async () => {
    writeFakeCredentialsFile('oauth-from-file');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-from-env';
    const { resolveClaudeCredential } = await import('../src/auth/claude-code-token.js');
    const cred = resolveClaudeCredential();
    expect(cred.source).toBe('env-oauth');
    expect(cred.token).toBe('oauth-from-env');
  });

  it('falls back to ANTHROPIC_API_KEY when no OAuth token is available', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const { resolveClaudeCredential } = await import('../src/auth/claude-code-token.js');
    const cred = resolveClaudeCredential();
    expect(cred.source).toBe('api-key');
    expect(cred.token).toBe('sk-ant-test-key');
  });

  it('returns source="none" when neither credential is available', async () => {
    const { resolveClaudeCredential, getClaudeCodeOAuthToken } = await import(
      '../src/auth/claude-code-token.js'
    );
    expect(getClaudeCodeOAuthToken()).toBeNull();
    expect(resolveClaudeCredential().source).toBe('none');
  });

  it('builds OAuth-flavored headers (Authorization: Bearer + anthropic-beta) when source is *-oauth', async () => {
    const { buildAnthropicHeaders } = await import('../src/auth/claude-code-token.js');
    const headers = buildAnthropicHeaders({ token: 'tok123', source: 'file-oauth' });
    expect(headers.Authorization).toBe('Bearer tok123');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('builds API-key-flavored headers (x-api-key) when source is api-key', async () => {
    const { buildAnthropicHeaders } = await import('../src/auth/claude-code-token.js');
    const headers = buildAnthropicHeaders({ token: 'sk-ant-foo', source: 'api-key' });
    expect(headers['x-api-key']).toBe('sk-ant-foo');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });
});

describe('#bug24 — executeAgentTask end-to-end credential routing', () => {
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

  function stubFetchSuccess() {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        id: 'msg_test',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    });
  }

  it('works WITHOUT ANTHROPIC_API_KEY when ~/.claude/.credentials.json exists', async () => {
    writeFakeCredentialsFile('oauth-tok-e2e');
    stubAgentRegistry('agent-oauth');

    const fetchSpy = stubFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    const result = await executeAgentTask({ agentId: 'agent-oauth', prompt: 'ping' });

    expect(result.success).toBe(true);
    expect(result._credSource).toBe('file-oauth');
    expect(result.output).toBe('pong');

    // Outgoing headers must use OAuth wire format.
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer oauth-tok-e2e');
    // OAuth beta must remain (asserts wire format) but the call may also
    // append `extended-cache-ttl-2025-04-11` when prompt-cache shaping is
    // active (#perf-cache-2026-05). Tolerate both single and comma-joined.
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('falls back to ANTHROPIC_API_KEY when OAuth is unavailable', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fallback';
    stubAgentRegistry('agent-apikey');

    const fetchSpy = stubFetchSuccess();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    const result = await executeAgentTask({ agentId: 'agent-apikey', prompt: 'ping' });

    expect(result.success).toBe(true);
    expect(result._credSource).toBe('api-key');

    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-fallback');
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns a friendly error when neither credential is available', async () => {
    stubAgentRegistry('agent-no-creds');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { executeAgentTask } = await import('../src/mcp-tools/agent-execute-core.js');
    const result = await executeAgentTask({ agentId: 'agent-no-creds', prompt: 'ping' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Anthropic credentials/);
    expect(result.error).toMatch(/Claude Code/);
    expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.remediation).toBeDefined();
    // No HTTP request should be attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
