/**
 * Regression test for #bug15 — `memory_search` default similarity
 * threshold of 0.3 was too aggressive and silently dropped real
 * semantic matches that scored just below it (e.g. 0.31 vs. 0.3).
 *
 * Reproduction:
 *   - Stored: "PostgreSQL connection pooling with PgBouncer in
 *     transaction mode for high-concurrency Rails apps"
 *   - Searched: "database connection management at scale"
 *   - Returned 0 results because similarity ~0.31 was filtered.
 *
 * Fix: lower the default threshold from 0.3 to 0.2 in both the
 * schema description and the handler default. Callers that want
 * stricter filtering can still pass an explicit `threshold` (e.g.
 * 0.5) and that override must continue to filter results out — so
 * we assert the explicit-override path as well, to guard against a
 * future regression that ignores the caller's threshold.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { join } from 'path';

// Resolve to a unique temp dir BEFORE importing memory-tools so the
// SQLite store ends up in a clean per-run location. SWARM_DIR is the
// env var memory-initializer respects (vitest blocks process.chdir()).
const tmpRoot = mkdtempSync(join(tmpdir(), 'bug15-'));
process.env.SWARM_DIR = tmpRoot;

const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');

interface SearchHandlerResult {
  query: string;
  results: Array<{ key: string; namespace: string; value: unknown; similarity: number }>;
  total: number;
  searchTime?: string;
  backend?: string;
  error?: string;
}

describe('memory_search — default threshold lowered 0.3 -> 0.2 (#bug15)', () => {
  const storeTool = memoryTools.find(t => t.name === 'memory_store')!;
  const searchTool = memoryTools.find(t => t.name === 'memory_search')!;
  const seedKey = `bug15-pgbouncer-${Date.now()}`;
  const namespace = 'bug15';

  beforeAll(async () => {
    expect(storeTool).toBeDefined();
    expect(searchTool).toBeDefined();

    // Seed the exact reproduction entry from the bug report.
    await storeTool.handler({
      key: seedKey,
      value:
        'PostgreSQL connection pooling with PgBouncer in transaction mode for high-concurrency Rails apps',
      namespace,
    });
  });

  it('schema documents the new default of 0.2 (not the legacy 0.3)', () => {
    const props = (searchTool.inputSchema as {
      properties: Record<string, { description?: string }>;
    }).properties;
    const desc = props.threshold?.description ?? '';
    // Forward-looking assertion — the schema is part of the MCP contract
    // surfaced to clients, so it must reflect the actual handler default.
    expect(desc).toContain('0.2');
    expect(desc).not.toContain('0.3');
  });

  it('returns the seeded entry for a semantically-related but lexically-different query at the default threshold', async () => {
    const result = (await searchTool.handler({
      // Lexically different from the stored phrase — no shared keywords
      // with "PgBouncer", "transaction mode", or "Rails".
      query: 'database connection management at scale',
      namespace,
      // No `threshold` — exercise the default code path.
    })) as SearchHandlerResult;

    expect(result.error).toBeUndefined();
    // The whole point of the bug: at the default threshold, this
    // semantically-related query must surface the stored entry.
    expect(result.total).toBeGreaterThan(0);
    const keys = result.results.map(r => r.key);
    expect(keys).toContain(seedKey);
  });

  it('still filters out the entry when caller passes an explicit high threshold (0.5) — no regression to override behavior', async () => {
    const result = (await searchTool.handler({
      query: 'database connection management at scale',
      namespace,
      threshold: 0.5,
    })) as SearchHandlerResult;

    expect(result.error).toBeUndefined();
    // The bug15 reproduction reports similarity ~0.31 for this pair, so
    // 0.5 must still exclude it. If a future change accidentally drops
    // the threshold parameter, this assertion catches it.
    const keys = result.results.map(r => r.key);
    expect(keys).not.toContain(seedKey);
  });
});
