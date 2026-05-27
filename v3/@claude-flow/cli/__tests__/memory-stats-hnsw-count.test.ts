/**
 * Regression test for #1987 — `memory stats` reported HNSW
 * `active (0 entries)` in a fresh CLI process even when persisted rows had
 * embeddings, because `getHNSWStatus()` reads an in-process singleton that
 * is never hydrated on the stats code path.
 *
 * Fix exposes `countVectorEntries()` which queries `memory_entries` for
 * `embedding IS NOT NULL` directly. This test pins the contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetMemoryRootCache,
  countVectorEntries,
  getMemoryRoot,
} from '../src/memory/memory-initializer.js';

const SAVED_ENV: Record<string, string | undefined> = {};
function saveEnv(...names: string[]) {
  for (const n of names) SAVED_ENV[n] = process.env[n];
}
function restoreEnv() {
  for (const [n, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
}

// Minimal schema mirror of memory_entries — only the columns
// countVectorEntries actually queries. Keeps the test independent of
// future schema evolution while pinning the count contract.
const MEMORY_ENTRIES_MIN_SCHEMA = `
  CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT DEFAULT 'default',
    content TEXT NOT NULL,
    type TEXT DEFAULT 'semantic',
    embedding TEXT,
    embedding_dimensions INTEGER,
    embedding_model TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

async function loadSqlJs() {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const initSqlJs = req('sql.js') as typeof import('sql.js').default;
  return initSqlJs();
}

describe('#1987 memory stats HNSW count', () => {
  let workdir: string;
  let dbPath: string;

  beforeEach(() => {
    saveEnv('CLAUDE_FLOW_MEMORY_PATH', 'CLAUDE_FLOW_ENCRYPT_AT_REST');
    delete process.env.CLAUDE_FLOW_ENCRYPT_AT_REST;
    workdir = mkdtempSync(join(tmpdir(), 'mem-stats-hnsw-'));
    process.env.CLAUDE_FLOW_MEMORY_PATH = workdir;
    _resetMemoryRootCache();
    dbPath = join(workdir, 'memory.db');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    _resetMemoryRootCache();
    restoreEnv();
  });

  async function seedDb(rows: Array<{ id: string; key: string; embedding: string | null }>): Promise<void> {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.exec(MEMORY_ENTRIES_MIN_SCHEMA);
    const now = Date.now();
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, type, embedding, embedding_dimensions, embedding_model, created_at, updated_at)
         VALUES (?, ?, 'ns', ?, 'semantic', ?, ?, ?, ?, ?)`,
        [r.id, r.key, `content for ${r.key}`, r.embedding, r.embedding ? 384 : null, r.embedding ? 'test' : null, now, now]
      );
    }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
  }

  it('resolves to the tmpdir via CLAUDE_FLOW_MEMORY_PATH', () => {
    expect(getMemoryRoot()).toBe(workdir);
  });

  it('returns 0 when the DB file is missing', async () => {
    expect(await countVectorEntries(dbPath)).toBe(0);
  });

  it('returns 0 from a DB with no embedded rows', async () => {
    await seedDb([
      { id: 'a', key: 'no-vec', embedding: null },
      { id: 'b', key: 'also-no-vec', embedding: null },
    ]);
    expect(await countVectorEntries(dbPath)).toBe(0);
  });

  it('returns the count of rows with a non-empty embedding', async () => {
    const fakeEmbedding = JSON.stringify(new Array(384).fill(0).map(() => Math.random()));
    await seedDb([
      { id: 'a', key: 'has-vec-1', embedding: fakeEmbedding },
      { id: 'b', key: 'has-vec-2', embedding: fakeEmbedding },
      { id: 'c', key: 'has-vec-3', embedding: fakeEmbedding },
      { id: 'd', key: 'no-vec', embedding: null },
    ]);
    // Pre-fix the stats command read this number from an empty in-process
    // HNSW singleton and reported 0 every time. After the fix, it queries
    // SQLite and returns the durable count — independent of process state.
    expect(await countVectorEntries(dbPath)).toBe(3);
  });

  it('treats empty-string embeddings as missing', async () => {
    await seedDb([
      { id: 'a', key: 'empty-str', embedding: '' },
      { id: 'b', key: 'valid', embedding: JSON.stringify([0.1, 0.2]) },
    ]);
    expect(await countVectorEntries(dbPath)).toBe(1);
  });

  it('honors a custom dbPath argument over CLAUDE_FLOW_MEMORY_PATH', async () => {
    // No file at the default path — only at a custom one.
    const customDir = mkdtempSync(join(tmpdir(), 'mem-stats-custom-'));
    try {
      const customDb = join(customDir, 'memory.db');
      const SQL = await loadSqlJs();
      const db = new SQL.Database();
      db.exec(MEMORY_ENTRIES_MIN_SCHEMA);
      db.run(
        `INSERT INTO memory_entries (id, key, content, embedding, created_at, updated_at)
         VALUES ('a', 'k', 'c', ?, 0, 0)`,
        [JSON.stringify([1, 2, 3])]
      );
      const { writeFileSync } = await import('node:fs');
      writeFileSync(customDb, Buffer.from(db.export()));
      db.close();

      expect(await countVectorEntries(customDb)).toBe(1);
      // Default path is still empty.
      expect(await countVectorEntries(dbPath)).toBe(0);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});
