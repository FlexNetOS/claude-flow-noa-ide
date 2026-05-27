/**
 * Regression test for #bug16a — `@claude-flow/memory@3.0.0-alpha.14` no
 * longer exports `smartSearch`, breaking `npm run build`.
 *
 * Mitigation: ported the SmartRetrieval pipeline into a local shim at
 * `src/memory/smart-search-shim.ts`. This test asserts that the shim:
 *   1. Returns the documented {results, stats} shape.
 *   2. Calls the underlying SearchFn once per expanded query variant
 *      (multi-query fan-out).
 *   3. Filters threshold through to the underlying SearchFn unchanged.
 *   4. Honors `multiQuery: false` to disable fan-out.
 *
 * If the upstream package re-exports `smartSearch` and the import in
 * `memory-tools.ts` is switched back, this test should still pass against
 * the upstream implementation since it uses the same public contract.
 */

import { describe, it, expect } from 'vitest';
import {
  smartSearch,
  defaultQueryExpansions,
  type SearchFn,
  type SearchCandidate,
} from '../src/memory/smart-search-shim.js';

function makeCandidate(overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    key: overrides.key ?? 'k',
    content: overrides.content ?? 'hello world',
    score: overrides.score ?? 0.9,
    namespace: overrides.namespace ?? 'default',
    metadata: overrides.metadata,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
  };
}

describe('smart-search-shim — #bug16a', () => {
  it('returns the documented {results, stats} shape', async () => {
    const search: SearchFn = async () => ({
      results: [
        makeCandidate({ id: '1', content: 'alpha' }),
        makeCandidate({ id: '2', content: 'beta' }),
      ],
    });

    const out = await smartSearch(search, { query: 'alpha beta', limit: 5 });

    expect(out).toHaveProperty('results');
    expect(out).toHaveProperty('stats');
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.stats).toMatchObject({
      variantCount: expect.any(Number),
      variants: expect.any(Array),
      rawCandidateCount: expect.any(Number),
      afterRrfCount: expect.any(Number),
      afterRecencyCount: expect.any(Number),
      afterMmrCount: expect.any(Number),
      afterSessionCount: expect.any(Number),
      durationMs: expect.any(Number),
    });
    // Each result keeps the candidate shape with a (potentially boosted) score.
    for (const r of out.results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('content');
      expect(typeof r.score).toBe('number');
    }
  });

  it('calls SearchFn once per expanded query variant', async () => {
    const calls: string[] = [];
    const search: SearchFn = async (req) => {
      calls.push(req.query);
      return { results: [makeCandidate({ content: req.query })] };
    };

    const expansions = defaultQueryExpansions('database connection pooling');
    expect(expansions.length).toBeGreaterThan(1);

    const out = await smartSearch(search, {
      query: 'database connection pooling',
      multiQuery: true,
      // Pin off recency/MMR/session to keep the assertion focused.
      recencyBoost: false,
      diversityMMR: false,
      sessionDiversity: false,
    });

    expect(calls).toHaveLength(expansions.length);
    expect(out.stats.variantCount).toBe(expansions.length);
    expect(out.stats.variants).toEqual(expansions);
  });

  it('passes the threshold through to the underlying SearchFn', async () => {
    const seen: number[] = [];
    const search: SearchFn = async (req) => {
      seen.push(req.threshold ?? -1);
      return { results: [] };
    };

    await smartSearch(search, { query: 'q', threshold: 0.42, multiQuery: false });

    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) expect(t).toBeCloseTo(0.42);
  });

  it('honors multiQuery:false to disable fan-out', async () => {
    const calls: string[] = [];
    const search: SearchFn = async (req) => {
      calls.push(req.query);
      return { results: [makeCandidate({ content: req.query })] };
    };

    await smartSearch(search, { query: 'just one query', multiQuery: false });

    expect(calls).toEqual(['just one query']);
  });
});
