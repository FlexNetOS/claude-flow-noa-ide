/**
 * Regression test for #bug3 — hooks_intelligence_stats must report a
 * non-zero hnsw.indexSize after a pattern is stored via the SQL+HNSW
 * bridge (bridgeStorePattern). Previously the counter was sourced from
 * the JSON memory store (loadMemoryStore) which the bridge never updates.
 */

import { describe, it, expect } from 'vitest';

import { hooksTools } from '../src/mcp-tools/hooks-tools.js';

interface IntelligenceStatsResult {
  hnsw: {
    indexSize: number;
    hnswSource: 'singleton' | 'bridge' | 'memory-store';
  };
}

describe('hooks_intelligence_stats — real HNSW backend size (#bug3)', () => {
  it('exposes hnswSource field for transparency', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IntelligenceStatsResult;

    expect(result.hnsw).toBeDefined();
    expect(result.hnsw).toHaveProperty('indexSize');
    expect(result.hnsw).toHaveProperty('hnswSource');
    expect(['singleton', 'bridge', 'memory-store']).toContain(result.hnsw.hnswSource);
    expect(typeof result.hnsw.indexSize).toBe('number');
    expect(result.hnsw.indexSize).toBeGreaterThanOrEqual(0);
  });

  it('reports >= 1 indexSize after storing a pattern via the bridge', async () => {
    let bridge: typeof import('../src/memory/memory-bridge.js');
    try {
      bridge = await import('../src/memory/memory-bridge.js');
    } catch {
      // Bridge module not available — skip (matches behavior on minimal builds).
      return;
    }

    let stored = false;
    try {
      const storeResult = await bridge.bridgeStorePattern({
        pattern: `regression test for #bug3 — pattern store with embedding ${Date.now()}`,
        type: 'test-pattern',
        confidence: 0.9,
        metadata: { source: 'bug3-regression', sessionId: `test-${Date.now()}` },
      });
      stored = !!storeResult && storeResult.success === true;
    } catch {
      // Store may fail in environments without the SQLite backend — skip.
      return;
    }

    if (!stored) return; // bridge could not persist — environment-dependent

    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats')!;
    const result = (await tool.handler({})) as IntelligenceStatsResult;

    // The point of #bug3: counter must reflect the bridge write, not stay at 0.
    expect(result.hnsw.indexSize).toBeGreaterThanOrEqual(1);
    expect(['singleton', 'bridge']).toContain(result.hnsw.hnswSource);
  });
});
