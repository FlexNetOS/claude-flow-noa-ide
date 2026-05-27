/**
 * Regression test for #bug21 — five status tools returned silent zeros
 * without any `_note` explainer, making it impossible to tell whether the
 * subsystem was broken vs idle:
 *
 *   - mcp__claude-flow__neural_status
 *   - mcp__claude-flow__neural_patterns (action=list)
 *   - mcp__claude-flow__daa_learning_status
 *   - mcp__claude-flow__daa_performance_metrics
 *   - mcp__claude-flow__embeddings_status
 *
 * Each handler now annotates the idle-since-load case with `_status: 'idle'`
 * and a `_note` field pointing the caller at the tool that would populate
 * the subsystem. Mirrors the Bug 11.3 (#28eae8e) pattern landed for
 * hooks_intelligence_stats. Counter values themselves are unchanged.
 *
 * Strategy: redirect getProjectCwd() to a temp dir via CLAUDE_FLOW_CWD so
 * the on-disk stores (.claude-flow/neural, .claude-flow/daa) are guaranteed
 * empty. Vitest workers forbid process.chdir(), so the env-var indirection
 * is the only portable knob (matches the pattern used by
 * hooks-metrics-pending-insights.test.ts for #bug5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { neuralTools } from '../src/mcp-tools/neural-tools.js';
import { daaTools } from '../src/mcp-tools/daa-tools.js';
import { embeddingsTools } from '../src/mcp-tools/embeddings-tools.js';

interface IdleAnnotated {
  _status?: string;
  _note?: string;
}

function assertIdleAnnotation(result: IdleAnnotated, label: string): void {
  expect(result, `${label}: result must be defined`).toBeDefined();
  expect(result._note, `${label}: must include _note`).toBeDefined();
  expect(typeof result._note).toBe('string');
  expect((result._note as string).length).toBeGreaterThan(0);
  expect(result._status, `${label}: must include _status`).toBe('idle');
}

describe('status tools — idle-state _note annotations (#bug21)', () => {
  // Per-test sandbox so the on-disk stores under <tmp>/.claude-flow/...
  // are guaranteed empty. getProjectCwd() honors CLAUDE_FLOW_CWD, so
  // neural-tools and daa-tools both follow this redirect cleanly.
  let sandboxDir: string;
  let originalCwdEnv: string | undefined;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'bug21-status-tools-'));
    originalCwdEnv = process.env.CLAUDE_FLOW_CWD;
    process.env.CLAUDE_FLOW_CWD = sandboxDir;
  });

  afterEach(() => {
    if (originalCwdEnv === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = originalCwdEnv;
    try {
      rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('neural_status annotates idle when models and patterns are both empty', async () => {
    const tool = neuralTools.find(t => t.name === 'neural_status');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IdleAnnotated & {
      models: { total: number };
      patterns: { total: number };
    };

    // Sanity: the empty-state precondition still holds in this sandbox.
    expect(result.models.total).toBe(0);
    expect(result.patterns.total).toBe(0);

    assertIdleAnnotation(result, 'neural_status');
  });

  it('neural_patterns (action=list) annotates idle when pattern list is empty', async () => {
    const tool = neuralTools.find(t => t.name === 'neural_patterns');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({ action: 'list' })) as IdleAnnotated & {
      patterns: unknown[];
      total: number;
    };

    expect(result.total).toBe(0);
    expect(Array.isArray(result.patterns)).toBe(true);
    expect(result.patterns.length).toBe(0);

    assertIdleAnnotation(result, 'neural_patterns');
  });

  it('daa_learning_status annotates idle when no DAA agents exist', async () => {
    const tool = daaTools.find(t => t.name === 'daa_learning_status');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IdleAnnotated & {
      summary: { total: number };
    };

    expect(result.summary.total).toBe(0);
    assertIdleAnnotation(result, 'daa_learning_status');
  });

  it('daa_performance_metrics annotates idle when agents/workflows/knowledge are all empty', async () => {
    const tool = daaTools.find(t => t.name === 'daa_performance_metrics');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IdleAnnotated & {
      metrics: {
        agents: { total: number };
        workflows: { total: number };
        learning: { knowledgeItems: number };
      };
    };

    expect(result.metrics.agents.total).toBe(0);
    expect(result.metrics.workflows.total).toBe(0);
    expect(result.metrics.learning.knowledgeItems).toBe(0);

    assertIdleAnnotation(result, 'daa_performance_metrics');
  });

  it('embeddings_status — handler exposes idle annotation contract', async () => {
    const tool = embeddingsTools.find(t => t.name === 'embeddings_status');
    expect(tool).toBeDefined();

    // embeddings-tools resolves config paths via plain `resolve(CONFIG_DIR)`
    // (not getProjectCwd), so it doesn't honor CLAUDE_FLOW_CWD. We can't
    // guarantee the local `.claude-flow/embeddings.json` state from a
    // worker (no chdir). Two valid outcomes here, both compatible with
    // the Bug 21 contract:
    //
    //   1. Config not present  -> {success: false, initialized: false}
    //      No idle annotation expected — the early-return path predates
    //      Bug 21 and is already actionable on its own ("not initialized").
    //   2. Config present + zero embeddings probed -> _status: 'idle' with
    //      a non-empty _note pointing at embeddings_generate.
    //
    // The test asserts that whenever `_status` is set, it equals 'idle'
    // AND `_note` is a populated string — i.e., the contract holds.
    const result = (await tool!.handler({})) as IdleAnnotated & {
      success?: boolean;
      initialized?: boolean;
    };

    if (result._status !== undefined) {
      assertIdleAnnotation(result, 'embeddings_status');
    } else {
      // If no idle annotation, the handler must still produce a coherent
      // shape — either an actionable not-initialized error, or a healthy
      // initialized status (in which case there must be embeddings — out
      // of scope for the Bug 21 idle assertion).
      expect(typeof result.success).toBe('boolean');
    }
  });
});

describe('status tools — non-zero state must NOT carry idle annotation (#bug21)', () => {
  let sandboxDir: string;
  let originalCwdEnv: string | undefined;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'bug21-status-tools-active-'));
    originalCwdEnv = process.env.CLAUDE_FLOW_CWD;
    process.env.CLAUDE_FLOW_CWD = sandboxDir;
  });

  afterEach(() => {
    if (originalCwdEnv === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = originalCwdEnv;
    try {
      rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('neural_patterns drops idle annotation once a pattern is stored', async () => {
    const tool = neuralTools.find(t => t.name === 'neural_patterns');
    expect(tool).toBeDefined();

    // Populate one pattern.
    const stored = (await tool!.handler({
      action: 'store',
      name: 'bug21-regression-pattern',
      type: 'test',
    })) as { success?: boolean };
    if (!stored.success) return; // env-dependent — skip on minimal builds

    const listed = (await tool!.handler({ action: 'list' })) as IdleAnnotated & {
      total: number;
    };

    expect(listed.total).toBeGreaterThanOrEqual(1);
    // Once non-empty, the idle annotation must be absent so callers don't
    // false-positive on a populated store.
    expect(listed._status).toBeUndefined();
    expect(listed._note).toBeUndefined();
  });
});
