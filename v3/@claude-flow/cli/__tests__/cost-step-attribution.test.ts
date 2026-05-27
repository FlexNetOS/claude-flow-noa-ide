/**
 * Gap 4 v1.5 — end-to-end stepIndex plumbing tests.
 *
 * Verifies the active-step tracker exposed by hooks-tools.ts is populated by
 * the trajectory-{start,step,end} handlers, and that callAnthropicMessages
 * auto-attributes cost entries to the right stepIndex without the caller
 * having to plumb it explicitly.
 *
 * Mock pattern mirrors `cost-recorder-wire-in.test.ts` so we exercise the
 * real wire path through callAnthropicMessages — same code path that runs
 * in production. We never hit the real Anthropic API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks: stub the Claude Code OAuth keychain probe so it can't bleed in.
// ---------------------------------------------------------------------------

const fakeHome = mkdtempSync(join(tmpdir(), 'ruflo-cost-stepattr-home-'));
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
  process.env.ANTHROPIC_API_KEY = 'sk-ant-stepattr';

  tmpRoot = mkdtempSync(join(tmpdir(), 'ruflo-cost-stepattr-'));
  process.env.CLAUDE_FLOW_CWD = tmpRoot;
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

function stubFetch(opts?: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const model = opts?.model ?? 'claude-sonnet-4-6';
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      id: `msg_stepattr_${Math.random().toString(36).slice(2, 8)}`,
      model,
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: opts?.inputTokens ?? 100,
        output_tokens: opts?.outputTokens ?? 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests — getCurrentStepIndex behavior in isolation
// ---------------------------------------------------------------------------

describe('hooks-tools.getCurrentStepIndex (active-step tracker)', () => {
  it('returns null for an unknown sessionId', async () => {
    const { getCurrentStepIndex, _resetActiveSessionStepIndex } = await import(
      '../src/mcp-tools/hooks-tools.js'
    );
    _resetActiveSessionStepIndex();
    expect(getCurrentStepIndex('never-started')).toBeNull();
  });

  it('returns null right after trajectory-start (no step pushed yet)', async () => {
    const { hooksTrajectoryStart, getCurrentStepIndex, _resetActiveSessionStepIndex } = await import(
      '../src/mcp-tools/hooks-tools.js'
    );
    _resetActiveSessionStepIndex();
    const r = (await hooksTrajectoryStart.handler({ task: 'noop' })) as Record<string, unknown>;
    const trajectoryId = r.trajectoryId as string;
    // Pre-seed sentinel is -1; getter normalizes it to null so callers get a
    // clean "no step bound" signal.
    expect(getCurrentStepIndex(trajectoryId)).toBeNull();
  });

  it('returns the index of the last pushed step (0, 1, 2 progression)', async () => {
    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      getCurrentStepIndex,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const r = (await hooksTrajectoryStart.handler({ task: 'progression' })) as Record<string, unknown>;
    const trajectoryId = r.trajectoryId as string;

    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-0', result: 'ok' });
    expect(getCurrentStepIndex(trajectoryId)).toBe(0);

    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-1', result: 'ok' });
    expect(getCurrentStepIndex(trajectoryId)).toBe(1);

    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-2', result: 'ok' });
    expect(getCurrentStepIndex(trajectoryId)).toBe(2);
  });

  it('removes the entry on trajectory-end (returns null afterwards)', async () => {
    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      hooksTrajectoryEnd,
      getCurrentStepIndex,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const r = (await hooksTrajectoryStart.handler({ task: 'cleanup' })) as Record<string, unknown>;
    const trajectoryId = r.trajectoryId as string;
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'a', result: 'ok' });
    expect(getCurrentStepIndex(trajectoryId)).toBe(0);

    await hooksTrajectoryEnd.handler({ trajectoryId, success: true });
    expect(getCurrentStepIndex(trajectoryId)).toBeNull();
  });

  it('accepts an optional inline `cost` on trajectory-step and stores it on the step', async () => {
    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const r = (await hooksTrajectoryStart.handler({ task: 'inline-cost' })) as Record<string, unknown>;
    const trajectoryId = r.trajectoryId as string;

    const stepRes = (await hooksTrajectoryStep.handler({
      trajectoryId,
      action: 'cost-step',
      result: 'ok',
      cost: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0, total: 0.0036 },
    })) as Record<string, unknown>;
    expect(stepRes.recorded).toBe(true);
    expect(stepRes.totalSteps).toBe(1);
    // Cost field is internal to the trajectory record; the handler return
    // shape doesn't surface it. Coverage on the storage path is via the
    // trajectory-end persistence which is exercised in higher-level tests.
  });

  it('silently drops a malformed cost object (no throw, step still recorded)', async () => {
    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const r = (await hooksTrajectoryStart.handler({ task: 'bad-cost' })) as Record<string, unknown>;
    const trajectoryId = r.trajectoryId as string;

    // Missing `total` → coercion rejects, step still pushes without cost.
    const stepRes = (await hooksTrajectoryStep.handler({
      trajectoryId,
      action: 'no-total',
      result: 'ok',
      cost: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    })) as Record<string, unknown>;
    expect(stepRes.recorded).toBe(true);
    expect(stepRes.totalSteps).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — callAnthropicMessages auto-fallback to active stepIndex
// ---------------------------------------------------------------------------

describe('callAnthropicMessages → active stepIndex auto-attribution', () => {
  it('picks up the active stepIndex when none is passed explicitly', async () => {
    vi.stubGlobal('fetch', stubFetch());

    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const startRes = (await hooksTrajectoryStart.handler({
      task: 'auto-attr',
      agent: 'coder',
    })) as Record<string, unknown>;
    const trajectoryId = startRes.trajectoryId as string;

    // Push step 0, then dispatch.
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'plan', result: 'ok' });

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );
    const res = await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      sessionId: trajectoryId,
      // NOTE: stepIndex omitted — should auto-resolve to 0
      agentName: 'coder',
    });
    expect(res.success).toBe(true);

    expect(existsSync(costStatsPath())).toBe(true);
    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].sessionId).toBe(trajectoryId);
    expect(file.entries[0].stepIndex).toBe(0);
    expect(file.entries[0].agent).toBe('coder');
  });

  it('explicit input.stepIndex overrides the auto-fallback', async () => {
    vi.stubGlobal('fetch', stubFetch());

    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const startRes = (await hooksTrajectoryStart.handler({ task: 'override' })) as Record<string, unknown>;
    const trajectoryId = startRes.trajectoryId as string;

    // Push to index 0 in tracker, but caller passes stepIndex=99 — explicit wins.
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'one', result: 'ok' });

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );
    await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      sessionId: trajectoryId,
      stepIndex: 99,
      agentName: 'coder',
    });

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries[0].stepIndex).toBe(99);
  });

  it('records null stepIndex when sessionId is unknown to the tracker', async () => {
    vi.stubGlobal('fetch', stubFetch());

    const { _resetActiveSessionStepIndex } = await import(
      '../src/mcp-tools/hooks-tools.js'
    );
    _resetActiveSessionStepIndex();

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );
    await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      sessionId: 'never-started-trajectory',
      agentName: 'coder',
    });

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries[0].sessionId).toBe('never-started-trajectory');
    expect(file.entries[0].stepIndex).toBeNull();
  });

  it('records null stepIndex when sessionId is omitted entirely', async () => {
    vi.stubGlobal('fetch', stubFetch());

    const { _resetActiveSessionStepIndex } = await import(
      '../src/mcp-tools/hooks-tools.js'
    );
    _resetActiveSessionStepIndex();

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );
    await callAnthropicMessages({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
    });

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries[0].sessionId).toBeNull();
    expect(file.entries[0].stepIndex).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — end-to-end multi-step attribution
// ---------------------------------------------------------------------------

describe('end-to-end: multi-step trajectory with auto-attributed costs', () => {
  it('attributes 3 dispatches to stepIndex 0, 1, 2 in cost-stats.json', async () => {
    vi.stubGlobal('fetch', stubFetch({ inputTokens: 200, outputTokens: 50 }));

    const {
      hooksTrajectoryStart,
      hooksTrajectoryStep,
      hooksTrajectoryEnd,
      _resetActiveSessionStepIndex,
    } = await import('../src/mcp-tools/hooks-tools.js');
    _resetActiveSessionStepIndex();

    const startRes = (await hooksTrajectoryStart.handler({
      task: 'multi-step',
      agent: 'coder',
    })) as Record<string, unknown>;
    const trajectoryId = startRes.trajectoryId as string;

    const { callAnthropicMessages } = await import(
      '../src/mcp-tools/agent-execute-core.js'
    );

    // Step 0
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-0', result: 'ok' });
    await callAnthropicMessages({
      prompt: 'one',
      model: 'claude-sonnet-4-6',
      sessionId: trajectoryId,
      agentName: 'coder',
    });

    // Step 1
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-1', result: 'ok' });
    await callAnthropicMessages({
      prompt: 'two',
      model: 'claude-sonnet-4-6',
      sessionId: trajectoryId,
      agentName: 'coder',
    });

    // Step 2
    await hooksTrajectoryStep.handler({ trajectoryId, action: 'step-2', result: 'ok' });
    await callAnthropicMessages({
      prompt: 'three',
      model: 'claude-sonnet-4-6',
      sessionId: trajectoryId,
      agentName: 'coder',
    });

    // Wrap up — should clear active-step entry.
    await hooksTrajectoryEnd.handler({ trajectoryId, success: true });

    const file = JSON.parse(readFileSync(costStatsPath(), 'utf-8'));
    expect(file.entries).toHaveLength(3);

    // Entries are persisted newest-first; sort by stepIndex for deterministic
    // assertion that all three indices were attributed correctly.
    const indices = file.entries
      .map((e: { stepIndex: number | null }) => e.stepIndex)
      .sort();
    expect(indices).toEqual([0, 1, 2]);

    // Every entry must point at the right session.
    for (const e of file.entries) {
      expect(e.sessionId).toBe(trajectoryId);
      expect(e.agent).toBe('coder');
    }
  });
});
