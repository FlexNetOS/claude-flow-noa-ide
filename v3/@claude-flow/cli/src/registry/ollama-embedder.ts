/**
 * #bug25.1 — Local Ollama HTTP embedder for the skill matcher.
 *
 * Talks to a locally running Ollama daemon via its HTTP API
 * (`POST /api/embed`) to turn arbitrary text into dense embedding vectors.
 *
 * Goals:
 *   - Zero npm deps. Uses Node 18+ built-in `fetch` and `crypto`.
 *   - Graceful fallback: if Ollama is unreachable / model missing /
 *     anything else goes wrong, return `{ vectors: [], backend: null }`.
 *     Callers degrade to keyword scoring instead of throwing.
 *   - Persistent on-disk cache keyed by `<model>:<sha256(text)>` so we
 *     never re-embed the same skill description twice across runs.
 *   - 5-second timeout per request — embedding is best-effort, not on
 *     the critical path; we will not block routing on a stuck daemon.
 *   - Model fallback chain: try `mxbai-embed-large` (MTEB 64.68, sweet
 *     spot for conceptual queries) first, then `nomic-embed-text` (MTEB
 *     62.39, much smaller — 137M vs 335M params). Whatever the user has
 *     pulled, we use.
 *
 * Pull instructions for end users:
 *   $ ollama pull mxbai-embed-large
 *   # or, lighter weight:
 *   $ ollama pull nomic-embed-text
 *
 * The matcher will pick whichever is available. If neither is pulled,
 * we fall back to keyword scoring transparently.
 *
 * @module @claude-flow/cli/registry/ollama-embedder
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Default model fallback chain. First entry wins if pulled; otherwise we
 * try the next. `mxbai-embed-large` outscores `nomic-embed-text` on
 * MTEB but is 2.5× larger; `nomic-embed-text` is the gentler default
 * and is what most users will already have pulled.
 */
export const DEFAULT_MODEL_CHAIN = ['mxbai-embed-large', 'nomic-embed-text'] as const;

/** Hardcoded request timeout — embedding is best-effort, never blocking. */
const REQUEST_TIMEOUT_MS = 5000;

/** Default Ollama HTTP endpoint. Override with `OLLAMA_HOST` env var. */
export const DEFAULT_BASE_URL = 'http://localhost:11434';

export interface EmbedOptions {
  /** Single model name. If omitted, the fallback chain is used. */
  model?: string;
  /** Override Ollama base URL. Default: $OLLAMA_HOST or localhost:11434. */
  baseUrl?: string;
  /** Disable on-disk caching (useful for tests). */
  noCache?: boolean;
  /**
   * Override fetch — exposed for tests so we don't need a live Ollama
   * daemon. Defaults to global `fetch` (Node 18+).
   */
  fetchImpl?: typeof fetch;
  /** Override cache file path (tests). */
  cachePath?: string;
}

export interface EmbedResult {
  /** One embedding vector per input text (parallel array). Empty on failure. */
  vectors: number[][];
  /** Model that actually produced the embeddings. `null` if all failed. */
  model: string | null;
  /** Backend that served the request. `null` means graceful fallback. */
  backend: 'ollama' | null;
}

interface CacheShape {
  /** Map of "<model>:<sha256(text)>" → embedding vector. */
  [key: string]: number[];
}

/**
 * Resolve where the embedding cache lives. Prefers
 * `~/.claude/.claude-flow/data/embedding-cache.json` (matches the global-install
 * convention used by other helpers). Honors the `RUFLO_EMBEDDING_CACHE_PATH`
 * env var for test overrides.
 */
export function resolveEmbeddingCachePath(): string {
  const override = process.env.RUFLO_EMBEDDING_CACHE_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), '.claude', '.claude-flow', 'data', 'embedding-cache.json');
}

/**
 * #bug32 — module-level cache + mtime watermark.
 *
 * Before this fix, every `embedTexts()` call did:
 *   readFileSync(CACHE_PATH, 'utf8')   // 4.9 MB → ~7 ms
 *   JSON.parse(raw)                    // ~3.5 ms
 * for a combined ~10.5 ms even when the cache was unchanged. That
 * was 41% of the 152 ms cache-load benchmark in ANALYSIS.md (Bug 32).
 *
 * Now we:
 *   1. Keep `_cache` and `_cacheMtime` at module scope, keyed by
 *      `_cachePath` so a test override busts the cache cleanly.
 *   2. On each call, do a cheap `statSync(CACHE_PATH).mtimeMs` (~µs).
 *   3. Reload from disk ONLY when the file's mtime is newer than
 *      what we last loaded. Otherwise reuse the in-memory map.
 *   4. On save, update `_cache` in place + bump `_cacheMtime` from
 *      the freshly-stat'd file so the next call short-circuits.
 *
 * Cross-process safety: writes from another process bump the mtime,
 * which we observe and reload. Concurrent writes from the same
 * process are safe — JSON.stringify is sync and we re-stat after.
 */
let _cache: CacheShape | null = null;
let _cacheMtime = 0;
let _cachePath = '';

/**
 * Load the on-disk cache (mtime-keyed). Returns an empty object on
 * any failure (missing file, corrupt JSON, etc.) — never throws.
 * Corrupt cache is not a fatal error; we just rebuild it.
 */
function loadCache(path: string): CacheShape {
  // Cheap stat probe — `statSync` on a 5 MB JSON file is ~µs vs
  // ~10 ms for the read+parse path. We always re-stat so concurrent
  // writers (other processes / tools) are picked up automatically.
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // File missing — clear cache and return empty.
    if (_cachePath === path) {
      _cache = {};
      _cacheMtime = 0;
    }
    return {};
  }

  // Same path + same mtime → in-memory hit (the hot path).
  if (_cache !== null && _cachePath === path && _cacheMtime === mtimeMs) {
    return _cache;
  }

  // Cold load (or stale): read+parse fresh and install.
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _cache = parsed as CacheShape;
      _cacheMtime = mtimeMs;
      _cachePath = path;
      return _cache;
    }
    _cache = {};
    _cacheMtime = mtimeMs;
    _cachePath = path;
    return _cache;
  } catch {
    // Corrupt cache file should never break the matcher.
    _cache = {};
    _cacheMtime = mtimeMs;
    _cachePath = path;
    return _cache;
  }
}

/**
 * Persist the cache. Best-effort — silently swallows write errors so a
 * read-only filesystem can't break embedding lookups.
 *
 * #bug32: also updates the module-level cache + mtime so the next
 * `loadCache(path)` short-circuits without going to disk.
 */
function saveCache(path: string, cache: CacheShape): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(cache), 'utf8');
    // Keep module-level cache hot — mirror the just-written contents
    // and bump the watermark from the freshly-stat'd file. Avoids the
    // need to read+parse on the very next call.
    _cache = cache;
    try {
      _cacheMtime = statSync(path).mtimeMs;
    } catch {
      _cacheMtime = Date.now();
    }
    _cachePath = path;
  } catch {
    // Persistence failed — keep going, in-memory cache still helps.
  }
}

/**
 * #bug32: test-only — wipe the module-level cache so unit tests can
 * exercise the cold-load path explicitly. Not exposed in the
 * public API surface (no JSDoc tag), but exported for the bench /
 * regression suite.
 */
export function _resetEmbeddingCacheForTests(): void {
  _cache = null;
  _cacheMtime = 0;
  _cachePath = '';
}

function cacheKey(model: string, text: string): string {
  const hash = createHash('sha256').update(text).digest('hex');
  return `${model}:${hash}`;
}

/**
 * Resolve which models to attempt. Single-model overrides bypass the
 * fallback chain so callers can pin a specific model in tests.
 */
function resolveModelChain(opts?: EmbedOptions): readonly string[] {
  if (opts?.model && opts.model.length > 0) return [opts.model];
  return DEFAULT_MODEL_CHAIN;
}

/**
 * Resolve the base URL with the documented precedence:
 *   opts.baseUrl > $OLLAMA_HOST > localhost default.
 */
function resolveBaseUrl(opts?: EmbedOptions): string {
  if (opts?.baseUrl && opts.baseUrl.length > 0) return opts.baseUrl;
  const env = process.env.OLLAMA_HOST;
  if (env && env.length > 0) {
    // OLLAMA_HOST may be `host:port` without scheme — normalize.
    if (/^https?:\/\//i.test(env)) return env;
    return `http://${env}`;
  }
  return DEFAULT_BASE_URL;
}

/**
 * Fetch a batch of embeddings from Ollama for a single model. Returns
 * `null` if the request fails for any reason (timeout, 404, malformed
 * response, network error). Never throws.
 */
async function tryEmbedWithModel(
  model: string,
  texts: string[],
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const url = `${baseUrl.replace(/\/+$/, '')}/api/embed`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { embeddings?: unknown };
    if (!body || !Array.isArray(body.embeddings)) return null;

    // Validate shape: each entry must be an array of finite numbers, and
    // we expect exactly one vector per input. Reject malformed responses
    // outright — easier to fall back than to ship NaN-laced vectors.
    const out: number[][] = [];
    for (const v of body.embeddings) {
      if (!Array.isArray(v)) return null;
      const vec: number[] = [];
      for (const n of v) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
        vec.push(n);
      }
      out.push(vec);
    }
    if (out.length !== texts.length) return null;
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed an array of texts, in order, returning one vector per text.
 *
 * - Cache hits short-circuit the HTTP call.
 * - Cache misses are batched into a single Ollama request.
 * - On any failure (no model pulled, daemon down, malformed response)
 *   returns `{ vectors: [], model: null, backend: null }` — callers
 *   should interpret this as "fall back to keyword".
 */
export async function embedTexts(
  texts: string[],
  opts?: EmbedOptions,
): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { vectors: [], model: null, backend: 'ollama' };
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { vectors: [], model: null, backend: null };
  }

  const baseUrl = resolveBaseUrl(opts);
  const chain = resolveModelChain(opts);
  const cachePath = opts?.cachePath ?? resolveEmbeddingCachePath();
  const useCache = opts?.noCache !== true;

  // #bug32: `loadCache` is now mtime-keyed at module scope. The hot
  // path (no concurrent writer) returns the same in-memory map for
  // free; only when another process bumps the file's mtime do we
  // re-read+re-parse. This drops the per-call overhead from ~10 ms
  // (read+parse 4.9 MB JSON) to ~µs (statSync + Map ref).
  const cache: CacheShape = useCache ? loadCache(cachePath) : {};

  for (const model of chain) {
    // Decide what's missing for this model and only fetch those.
    const vectors: (number[] | null)[] = new Array(texts.length).fill(null);
    const missingIdx: number[] = [];
    const missingTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const k = cacheKey(model, texts[i]);
      const hit = useCache ? cache[k] : undefined;
      if (Array.isArray(hit) && hit.length > 0) {
        vectors[i] = hit;
      } else {
        missingIdx.push(i);
        missingTexts.push(texts[i]);
      }
    }

    // Fully cached — short-circuit, no HTTP.
    if (missingTexts.length === 0) {
      return {
        vectors: vectors as number[][],
        model,
        backend: 'ollama',
      };
    }

    const fetched = await tryEmbedWithModel(model, missingTexts, baseUrl, fetchImpl);
    if (!fetched) {
      // This model failed (not pulled / 404 / etc.) — try the next
      // entry in the chain.
      continue;
    }

    // Splice fetched results into the right slots, persist cache.
    let dirty = false;
    for (let j = 0; j < missingIdx.length; j++) {
      const i = missingIdx[j];
      vectors[i] = fetched[j];
      if (useCache) {
        cache[cacheKey(model, texts[i])] = fetched[j];
        dirty = true;
      }
    }
    if (dirty) saveCache(cachePath, cache);

    return {
      vectors: vectors as number[][],
      model,
      backend: 'ollama',
    };
  }

  // No model in the chain succeeded — graceful fallback signal.
  return { vectors: [], model: null, backend: null };
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for
 * empty / mismatched inputs (defensive — caller may pass a fallback
 * empty vector and we don't want to crash routing).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
