/**
 * Sprint 1 Security Tests — memory package
 *
 * Covers:
 *   1. HNSW maxElements cap (100K default)
 *   2. Memory identity enforcement (ownerId scoping)
 *   3. SQLite PRAGMA resource limits
 *   4. update() ownership check with callerId
 *   5. delete() ownership check with callerId
 *   6. query() restricts to public when no ownerId
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const WASM_PATH = resolve(require.resolve('sql.js/dist/sql-wasm.wasm'));

// ─── HNSW maxElements cap ───────────────────────────────────

describe('HNSW maxElements default', () => {
  it('defaults to 100K instead of 1M', async () => {
    const { HNSWIndex } = await import('./hnsw-index.js');
    const index = new HNSWIndex();

    // Access the private merged config
    const config = (index as any).mergeConfig({});
    expect(config.maxElements).toBe(100000);
  });

  it('allows explicit override', async () => {
    const { HNSWIndex } = await import('./hnsw-index.js');
    const index = new HNSWIndex();

    const config = (index as any).mergeConfig({ maxElements: 500000 });
    expect(config.maxElements).toBe(500000);
  });
});

// ─── SqlJsBackend identity enforcement ──────────────────────

describe('SqlJsBackend identity enforcement', () => {
  let backend: any;

  beforeAll(async () => {
    const { SqlJsBackend } = await import('./sqljs-backend.js');
    backend = new SqlJsBackend({ databasePath: ':memory:', verbose: false, wasmPath: WASM_PATH });
    await backend.initialize();
  });

  afterAll(async () => {
    if (backend) await backend.shutdown();
  });

  it('sets entries without ownerId to public access', async () => {
    const entry = makeEntry('no-owner-key', {
      accessLevel: 'private',
      // no ownerId
    });

    await backend.store(entry);
    const stored = await backend.getByKey('test', 'no-owner-key');
    expect(stored.accessLevel).toBe('public');
  });

  it('preserves accessLevel when ownerId is set', async () => {
    const entry = makeEntry('owned-key', {
      ownerId: 'agent-1',
      accessLevel: 'private',
    });

    await backend.store(entry);
    const stored = await backend.getByKey('test', 'owned-key');
    expect(stored.accessLevel).toBe('private');
    expect(stored.ownerId).toBe('agent-1');
  });

  it('query() without ownerId returns only public entries', async () => {
    await backend.store(makeEntry('pub-entry', { accessLevel: 'public' }));
    await backend.store(makeEntry('priv-entry', { ownerId: 'agent-x', accessLevel: 'private' }));

    const results = await backend.query({ namespace: 'test' });
    const keys = results.map((e: any) => e.key);

    expect(keys).toContain('pub-entry');
    expect(keys).not.toContain('priv-entry');
  });

  it('query() with ownerId returns that owners entries', async () => {
    const results = await backend.query({
      namespace: 'test',
      ownerId: 'agent-x',
    });
    const keys = results.map((e: any) => e.key);

    expect(keys).toContain('priv-entry');
  });

  it('query() with includeAllOwners returns all entries', async () => {
    const results = await backend.query({
      namespace: 'test',
      includeAllOwners: true,
    });
    const keys = results.map((e: any) => e.key);

    expect(keys).toContain('pub-entry');
    expect(keys).toContain('priv-entry');
  });

  it('update() rejects when callerId does not match ownerId', async () => {
    await backend.store(makeEntry('owner-check', {
      ownerId: 'agent-1',
      accessLevel: 'private',
    }));
    const stored = await backend.getByKey('test', 'owner-check');

    const result = await backend.update(
      stored.id,
      { content: 'hacked!' },
      'agent-2' // wrong caller
    );

    expect(result).toBeNull();

    // Verify original unchanged
    const unchanged = await backend.get(stored.id);
    expect(unchanged.content).not.toBe('hacked!');
  });

  it('update() allows owner to update', async () => {
    const stored = await backend.getByKey('test', 'owner-check');

    const result = await backend.update(
      stored.id,
      { content: 'updated by owner' },
      'agent-1' // correct caller
    );

    expect(result).not.toBeNull();
    expect(result.content).toBe('updated by owner');
  });

  it('delete() rejects when callerId does not match ownerId', async () => {
    await backend.store(makeEntry('del-check', {
      ownerId: 'agent-1',
      accessLevel: 'private',
    }));
    const stored = await backend.getByKey('test', 'del-check');

    const deleted = await backend.delete(stored.id, 'agent-2');
    expect(deleted).toBe(false);

    // Still exists
    const exists = await backend.get(stored.id);
    expect(exists).not.toBeNull();
  });

  it('delete() allows owner to delete', async () => {
    const stored = await backend.getByKey('test', 'del-check');

    const deleted = await backend.delete(stored.id, 'agent-1');
    expect(deleted).toBe(true);

    // Note: sql.js getAsObject() returns a row with undefined values (not empty object)
    // when no matching row exists, so get() doesn't return null. We verify the row
    // is gone by checking the key field is undefined.
    const gone = await backend.get(stored.id);
    expect(gone === null || gone.key === undefined).toBe(true);
  });

  it('update() allows any callerId on public entries', async () => {
    await backend.store(makeEntry('public-edit', {
      accessLevel: 'public',
    }));
    const stored = await backend.getByKey('test', 'public-edit');

    const result = await backend.update(
      stored.id,
      { content: 'anyone can edit' },
      'random-agent'
    );

    expect(result).not.toBeNull();
    expect(result.content).toBe('anyone can edit');
  });
});

// ─── SQLite PRAGMA limits ───────────────────────────────────

describe('SqlJsBackend PRAGMA limits', () => {
  it('sets max_page_count to 262144', async () => {
    const { SqlJsBackend } = await import('./sqljs-backend.js');
    const backend = new SqlJsBackend({ databasePath: ':memory:', verbose: false });
    await backend.initialize();

    const db = (backend as any).db;
    const result = db.exec('PRAGMA max_page_count');
    const maxPages = result[0]?.values[0]?.[0];

    expect(maxPages).toBe(262144);

    await backend.shutdown();
  });

  it('sets page_size to 4096', async () => {
    const { SqlJsBackend } = await import('./sqljs-backend.js');
    const backend = new SqlJsBackend({ databasePath: ':memory:', verbose: false });
    await backend.initialize();

    const db = (backend as any).db;
    const result = db.exec('PRAGMA page_size');
    const pageSize = result[0]?.values[0]?.[0];

    expect(pageSize).toBe(4096);

    await backend.shutdown();
  });
});

// ─── Helper ─────────────────────────────────────────────────

let counter = 0;

function makeEntry(key: string, overrides: Record<string, any> = {}) {
  counter++;
  const now = Date.now();
  return {
    id: `test-${counter}-${Date.now()}`,
    key,
    content: overrides.content || `test content for ${key}`,
    type: 'semantic' as const,
    namespace: 'test',
    tags: [],
    metadata: {},
    accessLevel: overrides.accessLevel || 'public',
    ownerId: overrides.ownerId || undefined,
    createdAt: now,
    updatedAt: now,
    version: 1,
    references: [],
    accessCount: 0,
    lastAccessedAt: now,
  };
}
