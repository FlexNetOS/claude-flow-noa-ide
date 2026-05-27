/**
 * Regression tests for #bug5 — `hooks_metrics` must drain
 * pending-insights.jsonl into its counters between sessions, and the drain
 * must be idempotent across calls (offset tracking).
 *
 * Writer: helpers/intelligence.cjs:recordEdit() appends edit events.
 * Reader: hooks-tools.ts:hooksMetrics.handler now calls
 *         drainPendingInsights() on every invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { hooksTools } from '../src/mcp-tools/hooks-tools.js';

interface MetricsResult {
  patterns: { total: number };
  agents: { totalRoutes: number };
  commands: { totalExecuted: number };
  _pendingDrained?: { drained: number; edits: number; routes: number; trajectoriesEnded: number };
}

describe('hooks_metrics — drain pending-insights.jsonl (#bug5)', () => {
  // Use the RUFLO_PENDING_INSIGHTS_PATH env override added in
  // resolvePendingInsightsPath() — vitest workers forbid process.chdir() and
  // os.homedir() caching makes $HOME-overrides flaky.
  const originalOverride = process.env.RUFLO_PENDING_INSIGHTS_PATH;
  let workDir: string;
  let pendingPath: string;
  let offsetPath: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `hooks-metrics-bug5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
    pendingPath = join(workDir, 'pending-insights.jsonl');
    offsetPath = `${pendingPath}.consumed-offset`;
    process.env.RUFLO_PENDING_INSIGHTS_PATH = pendingPath;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.RUFLO_PENDING_INSIGHTS_PATH;
    else process.env.RUFLO_PENDING_INSIGHTS_PATH = originalOverride;
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('drains edit events into commands.totalExecuted, agents.totalRoutes, patterns.total', async () => {
    // Simulate three post-edit hook invocations writing to pending-insights.jsonl
    const writeEdit = (file: string) => {
      appendFileSync(pendingPath, JSON.stringify({ type: 'edit', file, timestamp: Date.now() }) + '\n', 'utf-8');
    };
    writeEdit('src/foo.ts');
    writeEdit('src/bar.ts');
    writeEdit('src/baz.ts');

    const tool = hooksTools.find(t => t.name === 'hooks_metrics');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as MetricsResult;

    expect(result._pendingDrained).toBeDefined();
    expect(result._pendingDrained!.drained).toBe(3);
    expect(result._pendingDrained!.edits).toBe(3);
    expect(result.commands.totalExecuted).toBeGreaterThanOrEqual(3);
    expect(result.patterns.total).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent — second call without new lines drains 0 (no double-count)', async () => {
    appendFileSync(pendingPath, JSON.stringify({ type: 'edit', file: 'a.ts' }) + '\n', 'utf-8');
    appendFileSync(pendingPath, JSON.stringify({ type: 'route', agent: 'coder' }) + '\n', 'utf-8');

    const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
    const first = (await tool.handler({})) as MetricsResult;
    expect(first._pendingDrained!.drained).toBe(2);
    expect(first._pendingDrained!.edits).toBe(1);
    expect(first._pendingDrained!.routes).toBe(1);

    // Second call without appending — should drain 0.
    const second = (await tool.handler({})) as MetricsResult;
    expect(second._pendingDrained!.drained).toBe(0);
    expect(second._pendingDrained!.edits).toBe(0);
    expect(second._pendingDrained!.routes).toBe(0);

    // Offset file must exist and equal full file size.
    expect(existsSync(offsetPath)).toBe(true);
    const offsetContents = parseInt(readFileSync(offsetPath, 'utf-8'), 10);
    const fullSize = readFileSync(pendingPath, 'utf-8').length;
    expect(offsetContents).toBe(fullSize);

    // Pending file must NOT have been truncated — consolidator still needs it.
    expect(readFileSync(pendingPath, 'utf-8').split('\n').filter(l => l.trim()).length).toBe(2);
  });

  it('only counts new lines appended after a previous drain', async () => {
    appendFileSync(pendingPath, JSON.stringify({ type: 'edit', file: 'a.ts' }) + '\n', 'utf-8');
    const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
    const first = (await tool.handler({})) as MetricsResult;
    expect(first._pendingDrained!.drained).toBe(1);

    // Append two more events
    appendFileSync(pendingPath, JSON.stringify({ type: 'edit', file: 'b.ts' }) + '\n', 'utf-8');
    appendFileSync(pendingPath, JSON.stringify({ type: 'trajectory-end' }) + '\n', 'utf-8');

    const second = (await tool.handler({})) as MetricsResult;
    expect(second._pendingDrained!.drained).toBe(2);
    expect(second._pendingDrained!.edits).toBe(1);
    expect(second._pendingDrained!.trajectoriesEnded).toBe(1);
  });

  it('recovers gracefully when offset file is corrupt (re-drain, no crash)', async () => {
    appendFileSync(pendingPath, JSON.stringify({ type: 'edit', file: 'a.ts' }) + '\n', 'utf-8');
    writeFileSync(offsetPath, 'not-a-number', 'utf-8');

    const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
    const result = (await tool.handler({})) as MetricsResult;
    expect(result._pendingDrained!.drained).toBe(1);
  });

  it('returns zeros when pending-insights.jsonl does not exist', async () => {
    // Point the override at a path that we deliberately do not create.
    const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
    const result = (await tool.handler({})) as MetricsResult;
    expect(result._pendingDrained).toBeDefined();
    expect(result._pendingDrained!.drained).toBe(0);
  });
});
