/**
 * Regression test for #bug6 — hooks_intelligence_stats and agentdb_health
 * must not advertise subsystems that have no backing implementation.
 *
 * Before: the handler emitted stub blocks for ewc/moe/flash/lora with
 * `implementation: 'not-loaded'` and (for flash) `speedup: 1.0`, which
 * contradicted the README's 2.49x-7.47x claim and made it impossible to
 * tell which subsystems were live.
 *
 * After: unloaded subsystems are omitted from the stats payload entirely
 * and surfaced in `_unavailable: [...]`. `implementationStatus` only
 * lists loaded subsystems (no more `'not-loaded'` strings on the wire).
 */

import { describe, it, expect } from 'vitest';

import { hooksTools } from '../src/mcp-tools/hooks-tools.js';
import { agentdbHealth } from '../src/mcp-tools/agentdb-tools.js';

interface IntelligenceStatsResult {
  sona?: { implementation?: string };
  ewc?: { implementation?: string };
  moe?: { implementation?: string };
  flash?: { implementation?: string; speedup?: number };
  lora?: { implementation?: string };
  _unavailable?: string[];
  implementationStatus?: Record<string, string>;
  performance?: Record<string, number>;
}

interface AgentdbHealthResult {
  available?: boolean;
  controllers?: Array<{ name: string; enabled: boolean; level: number }>;
  _unavailable?: string[];
}

describe('hooks_intelligence_stats — unloaded subsystems honesty (#bug6)', () => {
  it('never reports `implementation: "not-loaded"` on any visible subsystem', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats');
    expect(tool).toBeDefined();
    const result = (await tool!.handler({})) as IntelligenceStatsResult;

    // For every subsystem key that DOES appear in the output, its
    // `implementation` field must NOT be the literal "not-loaded".
    // Unloaded subsystems are tracked under `_unavailable` instead.
    for (const key of ['sona', 'ewc', 'moe', 'flash', 'lora'] as const) {
      const block = result[key];
      if (!block) continue; // omitted as expected for unloaded subsystem
      expect(block.implementation).toBeDefined();
      expect(block.implementation).not.toBe('not-loaded');
    }
  });

  it('exposes `_unavailable` when at least one subsystem failed to load', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats')!;
    const result = (await tool.handler({})) as IntelligenceStatsResult;

    // The set of (visible subsystem keys) ∪ (_unavailable entries) must
    // cover the canonical advertised list. We don't assert which set the
    // entries fall into — that depends on the build env — only that the
    // accounting is total and that `_unavailable` is well-formed when
    // present.
    if (result._unavailable !== undefined) {
      expect(Array.isArray(result._unavailable)).toBe(true);
      for (const entry of result._unavailable) {
        expect(typeof entry).toBe('string');
        expect(['sona', 'ewc', 'moe', 'flash', 'lora']).toContain(entry);
      }
    }

    const advertised = new Set(['sona', 'ewc', 'moe', 'flash', 'lora']);
    const visible = new Set<string>();
    for (const key of advertised) {
      if ((result as Record<string, unknown>)[key] !== undefined) visible.add(key);
    }
    const unavailable = new Set(result._unavailable ?? []);
    const accounted = new Set([...visible, ...unavailable]);
    for (const a of advertised) {
      expect(accounted.has(a)).toBe(true);
    }
  });

  it('detailed mode omits unloaded subsystems from `implementationStatus`', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats')!;
    const result = (await tool.handler({ detailed: true })) as IntelligenceStatsResult;

    expect(result.implementationStatus).toBeDefined();
    // No status value should ever be the literal "not-loaded" — the field
    // either lists the subsystem with status 'loaded' OR omits it.
    for (const [, status] of Object.entries(result.implementationStatus!)) {
      expect(status).not.toBe('not-loaded');
    }
  });

  it('detailed mode omits flash speedup metric when flash is unavailable', async () => {
    const tool = hooksTools.find(t => t.name === 'hooks_intelligence_stats')!;
    const result = (await tool.handler({ detailed: true })) as IntelligenceStatsResult;

    expect(result.performance).toBeDefined();
    // Either flash is loaded AND speedup is reported (real value), OR
    // flash is unloaded AND `flashSpeedup` is absent. The previous bug
    // emitted `flashSpeedup: 1` even when flash didn't load — assert that
    // is no longer the case by cross-referencing `_unavailable`.
    const flashUnavailable = (result._unavailable ?? []).includes('flash');
    if (flashUnavailable) {
      expect(result.performance!).not.toHaveProperty('flashSpeedup');
    }
  });
});

describe('agentdb_health — disabled controllers under _unavailable (#bug6)', () => {
  it('only emits enabled controllers in the `controllers` array', async () => {
    const result = (await agentdbHealth.handler({})) as AgentdbHealthResult;

    // If the bridge is unavailable the handler returns `available: false`
    // without a controllers list — that's fine, just skip.
    if (!result.available) return;
    if (!Array.isArray(result.controllers)) return;

    for (const c of result.controllers) {
      expect(c.enabled).toBe(true);
    }
  });

  it('surfaces disabled controllers under `_unavailable` instead of faking them as enabled=false', async () => {
    const result = (await agentdbHealth.handler({})) as AgentdbHealthResult;
    if (!result.available) return;

    if (result._unavailable !== undefined) {
      expect(Array.isArray(result._unavailable)).toBe(true);
      for (const name of result._unavailable) {
        expect(typeof name).toBe('string');
      }
      // _unavailable entries must NOT also appear in the enabled controllers
      // list — that would be double-counting.
      const enabledNames = new Set((result.controllers ?? []).map(c => c.name));
      for (const name of result._unavailable) {
        expect(enabledNames.has(name)).toBe(false);
      }
    }
  });
});
