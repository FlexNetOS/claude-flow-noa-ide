/**
 * #bug31 — In-process pool for sql.js Database handles.
 *
 * Background
 * ----------
 * Every call to memory store/search/list/get/delete used to:
 *   1. Re-import sql.js (lazy ESM, but ~5–10 ms cold).
 *   2. Read the entire .swarm/memory.db file from disk
 *      (~963 KB → 5–10 ms).
 *   3. Parse it into a fresh `new SQL.Database(buffer)`
 *      (~30–80 ms depending on row count).
 *   4. Run `ensureSchemaColumns` which itself opened+closed the DB
 *      a second time even when no schema migration was needed.
 *
 * Net cost: ~440 ms baseline per memory_store / memory_search
 * (measured in ANALYSIS.md, Bug 31).
 *
 * Strategy
 * --------
 * We keep a process-wide map of `dbPath → { db, mtimeMs, schemaVerified }`.
 *
 * - **Reads** check the file's `mtimeMs` cheaply (`statSync`, ~µs). If
 *   the on-disk file hasn't changed since we cached the handle, we
 *   reuse it and skip readFile + Database parsing entirely. If it has
 *   changed (another process wrote), we transparently reload.
 *
 * - **Writes** still call `db.export()` + write file restricted on
 *   the path used to wrap the original. We then refresh our cached
 *   `mtimeMs` so the next read in the same process doesn't think the
 *   file is stale.
 *
 * - **Schema verification** (the second-DB-open inside
 *   `ensureSchemaColumns`) is memoized per `dbPath`. We only run the
 *   migration probe once per process per path, then short-circuit.
 *
 * Concurrency model
 * -----------------
 * sql.js is fully synchronous and single-threaded; concurrent JS
 * tasks awaiting different memory operations are interleaved by the
 * event loop, never truly parallel. So a single shared in-memory
 * `Database` instance is safe — we never have two `db.run()` calls
 * physically running at the same time.
 *
 * The cache is keyed by absolute path so distinct DBs (project DB
 * vs. global ~/.claude DB) get independent handles.
 *
 * IPC daemon endpoint?
 * --------------------
 * The existing `worker-daemon.ts` does NOT expose a Unix socket /
 * HTTP / named-pipe endpoint — it's a self-contained scheduler. A
 * proper daemon endpoint would be a much larger refactor (Bug 31b),
 * so we go with the in-process pool as the smaller / safer ship-now
 * win. Each pooled response is tagged with `_routedThrough:
 * 'in-process-pool' | 'cold' | 'daemon'` so callers (and benchmarks)
 * can see which path fired.
 *
 * @module v3/cli/memory/db-pool
 */

import * as fs from 'fs';
import { swallowError } from '@claude-flow/shared';
import { readFileMaybeEncrypted, writeFileRestricted } from '../fs-secure.js';

/**
 * The shape of a cached DB handle. We cannot import the sql.js
 * `Database` type at module load time (it's a lazy ESM), so we keep
 * the handle untyped here and cast at call sites.
 */
interface PooledDB {
  /** The live sql.js Database instance. */
  db: any;
  /** mtimeMs of the file when we last loaded it. */
  mtimeMs: number;
  /** Have we already run ensureSchemaColumns for this path? */
  schemaVerified: boolean;
}

/**
 * Pool indexed by absolute dbPath. Module-level so it survives
 * across MCP tool invocations within the same Node process.
 */
const _pool: Map<string, PooledDB> = new Map();

/** Lazy import / cache of the sql.js module factory. */
let _sqlJs: any = null;
async function getSqlJs(): Promise<any> {
  if (_sqlJs) return _sqlJs;
  const initSqlJs = (await import('sql.js')).default;
  _sqlJs = await initSqlJs();
  return _sqlJs;
}

/**
 * Where this DB handle was sourced from. Useful for benchmarks and
 * for the `_routedThrough` field on tool responses.
 */
export type RouteSource = 'in-process-pool' | 'cold' | 'daemon';

export interface PoolGetResult {
  /** The live database handle (cast at call sites). */
  db: any;
  /** Where the handle came from (cache vs cold reload). */
  source: RouteSource;
  /** mtimeMs we observed for the file. */
  mtimeMs: number;
}

/**
 * Get an open Database handle for `dbPath`. If the file's mtime
 * matches the cached entry, reuse the in-memory handle (fast path —
 * ~µs). Otherwise reload from disk and replace the cached entry
 * (slow path — same as cold).
 *
 * Returns `{ db, source, mtimeMs }` — `source === 'in-process-pool'`
 * means the cache was hit, `'cold'` means we had to reload.
 */
export async function getPooledDB(dbPath: string): Promise<PoolGetResult> {
  const SQL = await getSqlJs();

  // Cheap stat to detect external writes. If the file doesn't exist
  // we let the caller handle that — pool only serves existing DBs.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dbPath).mtimeMs;
  } catch (err) {
    // Fall through — treat as cold load; readFileMaybeEncrypted will
    // throw the real error if the file truly doesn't exist.
    swallowError('db-pool.statSync', err, dbPath);
  }

  const cached = _pool.get(dbPath);
  if (cached && cached.mtimeMs === mtimeMs && mtimeMs !== 0) {
    return { db: cached.db, source: 'in-process-pool', mtimeMs };
  }

  // Cold load (or stale): close the old handle (if any), read +
  // parse fresh, install in pool.
  if (cached) {
    try { cached.db.close(); } catch (err) { swallowError('db-pool.close-stale', err); }
  }
  const fileBuffer = readFileMaybeEncrypted(dbPath, null);
  const db = new SQL.Database(fileBuffer);
  _pool.set(dbPath, { db, mtimeMs, schemaVerified: false });
  return { db, source: 'cold', mtimeMs };
}

/**
 * Persist a write made to the pooled handle: serialise the in-memory
 * DB and write it to disk via the encrypted-aware writer. Then
 * refresh our cached `mtimeMs` so subsequent reads in this process
 * don't false-positive on the bump we just caused.
 *
 * Callers should invoke this exactly when they would have done
 * `db.export()` + `writeFileRestricted` themselves.
 */
export function persistPooledDB(dbPath: string): void {
  const cached = _pool.get(dbPath);
  if (!cached) return;
  const data = cached.db.export();
  writeFileRestricted(dbPath, Buffer.from(data), { encrypt: true });
  // Refresh observed mtime so we don't reload our own write.
  try {
    cached.mtimeMs = fs.statSync(dbPath).mtimeMs;
  } catch (err) {
    swallowError('db-pool.persist-statSync', err, dbPath);
    cached.mtimeMs = Date.now();
  }
}

/**
 * Has `ensureSchemaColumns` already been run for this path in this
 * process? Cached separately from the DB handle because the answer
 * is "yes, forever" — once the columns are added they stay added,
 * even if the DB is reloaded from disk.
 *
 * NOTE: We tie this to the (path, mtime) pair indirectly via the
 * pool entry. If the pool entry is evicted/reloaded the flag is
 * also reset, which is the conservative choice.
 */
export function isSchemaVerified(dbPath: string): boolean {
  const cached = _pool.get(dbPath);
  return !!cached?.schemaVerified;
}

/**
 * Mark the schema as verified (i.e., `ensureSchemaColumns` has run
 * and there were no missing columns / has applied the migration).
 */
export function markSchemaVerified(dbPath: string): void {
  const cached = _pool.get(dbPath);
  if (cached) cached.schemaVerified = true;
}

/**
 * Force-evict a cached entry. Used by tests and by code paths that
 * know they've changed the file out-of-band.
 */
export function invalidatePool(dbPath?: string): void {
  if (dbPath) {
    const cached = _pool.get(dbPath);
    if (cached) {
      try { cached.db.close(); } catch (err) { swallowError('db-pool.invalidate-close', err, dbPath); }
      _pool.delete(dbPath);
    }
    return;
  }
  for (const [p, entry] of _pool) {
    try { entry.db.close(); } catch (err) { swallowError('db-pool.invalidate-close-all', err, p); }
  }
  _pool.clear();
}

/**
 * Pool stats for benchmarks and `memory_stats` tool. Returns the
 * number of cached DB handles.
 */
export function getPoolStats(): { size: number; paths: string[] } {
  return { size: _pool.size, paths: Array.from(_pool.keys()) };
}
