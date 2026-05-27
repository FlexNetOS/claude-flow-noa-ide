/**
 * Regression test for #bug4 — `memory_search_unified` must enumerate
 * namespaces dynamically from the live store, not from a hardcoded
 * allowlist of six names. Before the fix, entries in user-created
 * namespaces (e.g. "alpha", "beta") were invisible to the unified
 * search because the handler only iterated:
 *   ['default', 'claude-memories', 'auto-memory', 'patterns',
 *    'tasks', 'feedback']
 *
 * After the fix the handler discovers namespaces via listEntries()
 * (the same accessor memory_stats already uses) and falls back to the
 * legacy allowlist only on a transient listing error.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { join } from 'path';

// Resolve to a unique temp dir BEFORE importing memory-tools so the
// SQLite store ends up in a clean per-run location (the initializer
// reads cwd at first call). vitest blocks process.chdir(), so we
// instead point the SWARM_DIR env var that memory-initializer respects.
const tmpRoot = mkdtempSync(join(tmpdir(), 'bug4-'));
process.env.SWARM_DIR = tmpRoot;

const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');

describe('memory_search_unified — dynamic namespace enumeration (#bug4)', () => {
  const storeTool = memoryTools.find(t => t.name === 'memory_store')!;
  const searchTool = memoryTools.find(t => t.name === 'memory_search_unified')!;

  beforeAll(async () => {
    expect(storeTool).toBeDefined();
    expect(searchTool).toBeDefined();

    // Seed two custom namespaces that are NOT in the legacy allowlist.
    await storeTool.handler({
      key: `bug4-alpha-${Date.now()}`,
      value: 'alphabet investigation note about quantum cryptography',
      namespace: 'alpha',
    });
    await storeTool.handler({
      key: `bug4-beta-${Date.now()}`,
      value: 'beta release notes covering quantum cryptography rollout',
      namespace: 'beta',
    });
  });

  it('returns hits from custom namespaces that are NOT in the legacy allowlist', async () => {
    const result = (await searchTool.handler({
      query: 'quantum cryptography',
      limit: 20,
    })) as {
      success: boolean;
      results: Array<{ key: string; namespace: string }>;
      searchedNamespaces: string[];
      total: number;
    };

    // The handler must have discovered our custom namespaces dynamically.
    // (It may also include the legacy ones if the store has data there —
    // we don't constrain that, only that 'alpha' and 'beta' are searched.)
    expect(result.searchedNamespaces).toContain('alpha');
    expect(result.searchedNamespaces).toContain('beta');

    // And the seeded entries should be visible in the merged result set.
    const namespacesFound = new Set(result.results.map(r => r.namespace));
    // At least one of the two seeded namespaces produced a hit. (Both is
    // expected, but vector backends differ — assert the weaker invariant
    // so the test is stable across builds.)
    expect(
      namespacesFound.has('alpha') || namespacesFound.has('beta'),
    ).toBe(true);
  });

  it('does NOT use the legacy hardcoded allowlist when the store has custom namespaces', async () => {
    const result = (await searchTool.handler({
      query: 'quantum cryptography',
      limit: 20,
    })) as { searchedNamespaces: string[] };

    // The legacy literal was exactly six entries. If the handler returns
    // a `searchedNamespaces` set that is a strict superset (e.g. includes
    // 'alpha'/'beta'), we know the dynamic enumeration ran instead of
    // the fallback allowlist.
    const legacy = new Set(['default', 'claude-memories', 'auto-memory', 'patterns', 'tasks', 'feedback']);
    const beyondLegacy = result.searchedNamespaces.filter(ns => !legacy.has(ns));
    expect(beyondLegacy.length).toBeGreaterThan(0);
  });
});
