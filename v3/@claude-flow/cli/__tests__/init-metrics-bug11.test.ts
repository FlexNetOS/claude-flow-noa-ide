/**
 * Regression tests for #bug11 — three metrics/sync defects:
 *
 * 11.1: hooks_metrics.patterns.total must reflect bridge-stored patterns
 *       (HNSW), not just the JSON memory store + drain delta.
 *
 * 11.2: generated auto-memory-hook.mjs must NOT terminate on the
 *       'Memory package not available' branch when the CLI bridge IS
 *       reachable — it must try a subprocess fallback first.
 *
 * 11.3: intelligence_stats must annotate loaded-but-idle subsystems
 *       with `status: 'idle-since-load'` so callers can distinguish
 *       failure (_unavailable) from idleness (loaded, awaiting first
 *       invocation).
 */

import { describe, it, expect } from 'vitest';

import { hooksTools } from '../src/mcp-tools/hooks-tools.js';
import { generateAutoMemoryHook } from '../src/init/helpers-generator.js';

interface MetricsResult {
  patterns: { total: number };
  _patternsBreakdown?: { bridgeHNSW: number; memoryStore: number; drainedEdits: number };
  _dataSource?: string;
}

interface IntelligenceStatsResult {
  sona?: { implementation?: string; status?: string; loadedSince?: string };
  ewc?: { implementation?: string; consolidations?: number; status?: string; loadedSince?: string };
  moe?: { implementation?: string; expertsActive?: number; routingDecisions?: number; status?: string; loadedSince?: string };
  flash?: { implementation?: string; speedup?: number; status?: string; loadedSince?: string };
  lora?: { implementation?: string; adaptations?: number; status?: string; loadedSince?: string };
  _unavailable?: string[];
}

describe('#bug11.1 — hooks_metrics includes bridge-stored HNSW pattern count', () => {
  it('exposes _patternsBreakdown and uses HNSW count as a floor', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_metrics');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as MetricsResult;

    // The breakdown is now part of the contract — it lets callers see
    // which source contributed to patterns.total.
    expect(result._patternsBreakdown).toBeDefined();
    expect(result._patternsBreakdown!).toHaveProperty('bridgeHNSW');
    expect(result._patternsBreakdown!).toHaveProperty('memoryStore');
    expect(result._patternsBreakdown!).toHaveProperty('drainedEdits');
    expect(typeof result._patternsBreakdown!.bridgeHNSW).toBe('number');

    // patterns.total must be >= max(bridgeHNSW, memoryStore + drainedEdits).
    const expectedFloor = Math.max(
      result._patternsBreakdown!.bridgeHNSW,
      result._patternsBreakdown!.memoryStore + result._patternsBreakdown!.drainedEdits,
    );
    expect(result.patterns.total).toBeGreaterThanOrEqual(expectedFloor);

    // _dataSource must mention the new HNSW source for transparency.
    expect(result._dataSource).toContain('hnsw-bridge');
  });

  it('reports patterns.total >= 1 after a pattern is stored via the bridge', async () => {
    let bridge: typeof import('../src/memory/memory-bridge.js');
    try {
      bridge = await import('../src/memory/memory-bridge.js');
    } catch {
      // Bridge module not available in this env — skip (matches behaviour of bug3 test).
      return;
    }

    let stored = false;
    try {
      const storeResult = await bridge.bridgeStorePattern({
        pattern: `regression test for #bug11.1 — bridge-stored pattern ${Date.now()}`,
        type: 'test-pattern',
        confidence: 0.9,
        metadata: { source: 'bug11.1-regression', sessionId: `test-${Date.now()}` },
      });
      stored = !!storeResult && storeResult.success === true;
    } catch {
      // SQLite backend may not be available in CI — skip.
      return;
    }

    if (!stored) return;

    const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
    const result = (await tool.handler({})) as MetricsResult;

    // The point of bug11.1: counter must reflect the bridge write, even
    // when the JSON memory store and pending-insights drain are both 0.
    expect(result.patterns.total).toBeGreaterThanOrEqual(1);
    expect(result._patternsBreakdown!.bridgeHNSW).toBeGreaterThanOrEqual(1);
  });
});

describe('#bug11.2 — auto-memory-hook template uses MCP-aligned resolution and subprocess fallback', () => {
  it('uses the subprocess path as the canonical loader (no ESM-import-first stub branch)', () => {
    const rendered = generateAutoMemoryHook();

    // The new loader must exist — the function name and the spawnSync
    // import are the load-bearing markers.
    expect(rendered).toContain('trySubprocessImport');
    expect(rendered).toContain("from 'child_process'");
    expect(rendered).toContain('spawnSync');

    // #bug14 — The legacy "Memory package not available" message has been
    // removed entirely. The subprocess path is now canonical (not a fallback
    // after a failing ESM-import attempt), so the offending stub-emit branch
    // no longer exists. doImport must call trySubprocessImport directly,
    // and the call must live AFTER the function header (i.e. inside doImport).
    const doImportIdx = rendered.indexOf('async function doImport()');
    expect(doImportIdx).toBeGreaterThan(0);
    const tryCallIdx = rendered.indexOf('trySubprocessImport()', doImportIdx);
    expect(tryCallIdx).toBeGreaterThan(doImportIdx);
  });

  it('emits the homedir/.claude resolution strategy aligned with memory_import_claude MCP path', () => {
    const rendered = generateAutoMemoryHook();

    // The homedir(), '.claude' anchors are still present — they're used
    // for diagnostic status output (so users can see whether a global
    // install lives at ~/.claude). The strategy is now subprocess-driven
    // rather than ESM-resolved, but the home-install awareness remains.
    expect(rendered).toContain("import { homedir } from 'os'");
    expect(rendered).toContain('homedir()');
    expect(rendered).toContain("'.claude'");
    // The MCP-aligned reference to the CLI package is preserved (in
    // diagnostics / comments) so future maintainers see the connection.
    expect(rendered).toContain('@claude-flow/cli/package.json');
  });

  it('subprocess fallback probes claude-flow with bridge-status (a known-working command)', () => {
    const rendered = generateAutoMemoryHook();

    // Probe must use bridge-status — it's the cheapest read-only command
    // that proves the CLI's memory backend is reachable.
    expect(rendered).toContain('memory');
    expect(rendered).toContain('bridge-status');
    // shell:true so PATH / npx-shims / Windows .cmd wrappers resolve.
    expect(rendered).toContain('shell: true');
  });
});

describe('#bug11.3 — intelligence_stats annotates idle-since-load for loaded-but-unused subsystems', () => {
  it('emits `status: "idle-since-load"` when a loaded subsystem has zero primary counter', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IntelligenceStatsResult;

    // For each of the four subsystems with a primary counter, when the
    // subsystem IS loaded (its key is in the result and implementation is
    // 'real-X') AND the primary counter is 0, status must be 'idle-since-load'
    // and loadedSince must be a valid ISO timestamp.
    const checks: Array<[string, IntelligenceStatsResult[keyof IntelligenceStatsResult] & {
      implementation?: string;
      status?: string;
      loadedSince?: string;
    } | undefined, number | undefined]> = [
      ['ewc', result.ewc, result.ewc?.consolidations],
      ['moe', result.moe, result.moe?.routingDecisions],
      ['flash', result.flash, result.flash?.speedup],
      ['lora', result.lora, result.lora?.adaptations],
    ];

    let observedAtLeastOneIdle = false;
    for (const [name, block, counter] of checks) {
      if (!block) continue; // unloaded — appears under _unavailable instead
      // Loaded subsystems must carry their `real-X` implementation tag (bug6).
      expect(block.implementation).toMatch(/^real-/);

      if (counter === 0) {
        expect(block.status).toBe('idle-since-load');
        expect(block.loadedSince).toBeDefined();
        // Valid ISO 8601 timestamp.
        expect(() => new Date(block.loadedSince!).toISOString()).not.toThrow();
        observedAtLeastOneIdle = true;
      } else {
        // Active subsystem must NOT carry the idle annotation.
        expect(block.status).toBeUndefined();
      }
    }

    // In a fresh test process, at least one of the four loaded subsystems
    // (if any are loaded at all) must be idle. If NONE loaded, all four
    // are in _unavailable and this assertion is vacuous — that's fine,
    // bug6 already covers the unavailable path.
    const anyLoaded = checks.some(([, block]) => block !== undefined);
    if (anyLoaded) {
      expect(observedAtLeastOneIdle).toBe(true);
    }
  });

  it('idle annotation distinguishes loaded-but-unused from unloaded', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats')!;
    const result = (await tool.handler({})) as IntelligenceStatsResult;

    // A subsystem cannot simultaneously be unavailable AND idle-since-load.
    // (Idle requires it loaded; unavailable requires it didn't.)
    const unavailable = new Set(result._unavailable ?? []);
    for (const name of ['ewc', 'moe', 'flash', 'lora'] as const) {
      const block = result[name] as { status?: string } | undefined;
      if (block?.status === 'idle-since-load') {
        expect(unavailable.has(name)).toBe(false);
      }
    }
  });
});
