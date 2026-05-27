/**
 * Gap 4 v1.5 — smoke test for the per-bar cost overlay.
 *
 * NOT a unit test of any module. This is the validation criterion from the
 * mission brief: synthesize a 3-step trajectory + 3 matching cost entries
 * (stepIndex 0/1/2), run the trace loader's enrichWithCosts JOIN, render
 * to HTML, count the per-bar `<span class="cost-label" data-step-cost="...">`
 * elements. If we see 3 distinct ones, the per-bar overlay (added in Gap 4
 * but dormant for lack of step-attributed cost) is now active for new
 * trajectories.
 *
 * NOTE: kept in __tests__/ so it runs with the rest of the suite, but tagged
 * `smoke` in its describe label so it's easy to filter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot: string;
let prevFlowCwd: string | undefined;
let prevInstallCtx: string | undefined;

beforeEach(() => {
  prevFlowCwd = process.env.CLAUDE_FLOW_CWD;
  prevInstallCtx = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  tmpRoot = mkdtempSync(join(tmpdir(), 'gap4-v15-smoke-'));
  process.env.CLAUDE_FLOW_CWD = tmpRoot;
  process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
    packageRoot: tmpRoot,
    claudeRoot: tmpRoot,
    dataDir: join(tmpRoot, '.claude-flow', 'data'),
    isGlobalInstall: true,
    projectRoot: null,
  });
});

afterEach(() => {
  if (prevFlowCwd === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevFlowCwd;
  if (prevInstallCtx === undefined) delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
  else process.env.RUFLO_INSTALL_CONTEXT_JSON = prevInstallCtx;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('smoke (Gap 4 v1.5): per-bar cost overlay activates with stepIndex-attributed costs', () => {
  it('renders 3 distinct data-step-cost spans when 3 cost entries match 3 trajectory steps', async () => {
    const trajectoryId = 'traj-smoke-gap4v15';

    // 1. Synthesize cost-stats.json with 3 stepIndex-attributed entries.
    const costDir = join(tmpRoot, '.claude-flow');
    mkdirSync(costDir, { recursive: true });
    const costEntries = [0, 1, 2].map((i) => ({
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      sessionId: trajectoryId,
      stepIndex: i,
      agent: 'coder',
      model: 'claude-sonnet-4-6',
      cacheTtl: '1h',
      usage: { input: 100 + i * 50, output: 50, cacheRead: 0, cacheCreation: 0 },
      costUsd: {
        input: 0.0003,
        output: 0.00075,
        cacheRead: 0,
        cacheCreation: 0,
        total: 0.00105 + i * 0.0001,
      },
    }));
    writeFileSync(
      join(costDir, 'cost-stats.json'),
      JSON.stringify({ version: '1', rollingWindow: 100, entries: costEntries }, null, 2),
    );

    // 2. Synthesize a 3-step trajectory in store.json.
    const memDir = join(tmpRoot, '.claude-flow', 'memory');
    mkdirSync(memDir, { recursive: true });
    const trajectory = {
      id: trajectoryId,
      task: 'smoke',
      agent: 'coder',
      startedAt: new Date().toISOString(),
      endedAt: new Date(Date.now() + 5000).toISOString(),
      success: true,
      steps: [
        { action: 'plan', result: 'ok', quality: 0.9, timestamp: new Date().toISOString() },
        { action: 'edit', result: 'ok', quality: 0.85, timestamp: new Date(Date.now() + 1000).toISOString() },
        { action: 'verify', result: 'ok', quality: 0.95, timestamp: new Date(Date.now() + 2000).toISOString() },
      ],
    };
    writeFileSync(
      join(memDir, 'store.json'),
      JSON.stringify(
        {
          entries: {
            [`trajectory-${trajectoryId}`]: {
              key: `trajectory-${trajectoryId}`,
              value: trajectory,
              metadata: { type: 'trajectory' },
              storedAt: new Date().toISOString(),
              accessCount: 0,
              lastAccessed: new Date().toISOString(),
            },
          },
          version: '3.0.0',
        },
        null,
        2,
      ),
    );

    // 3. Load trajectory + JOIN costs + render HTML.
    const { loadTrajectory } = await import('../src/services/trace-loader.js');
    const { renderTrace } = await import('../src/services/trace-renderer.js');

    const loaded = await loadTrajectory(trajectoryId);
    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(3);
    // All 3 steps should have a cost JOINed by stepIndex.
    expect(loaded!.steps.filter((s) => s.cost).length).toBe(3);

    const html = renderTrace(loaded!);

    // The validation criterion: 3 distinct data-step-cost spans, one per bar.
    const matches = html.match(/data-step-cost="\d+"/g) || [];
    const distinct = new Set(matches);
    expect(distinct.size).toBe(3);
    expect([...distinct].sort()).toEqual([
      'data-step-cost="0"',
      'data-step-cost="1"',
      'data-step-cost="2"',
    ]);
  });
});
