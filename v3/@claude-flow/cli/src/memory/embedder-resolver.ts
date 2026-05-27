/**
 * #bug43.1 — Embedder resolver: unifies the memory bridge with the
 * Ollama-backed embedder used by the skill matcher (Bug 25). Picks
 * `mxbai-embed-large` (1024-dim) when a local Ollama daemon is reachable
 * with that model pulled; otherwise falls back to the bundled MiniLM
 * (384-dim) so memory ops never break.
 *
 * Goals:
 *   - Single source of truth for "which embedder is fired by memory_store
 *     / memory_search". `memory_bridge_status` reports whatever this
 *     module decided.
 *   - One-time probe at process startup, then cached for the rest of the
 *     run. We never re-probe on the hot path — embedding lookups must
 *     stay sub-millisecond once the resolver has decided.
 *   - Honest fallback: if `mxbai-embed-large` is not pulled or the
 *     daemon is down, we degrade to MiniLM rather than throwing. The
 *     existing bundled MiniLM path keeps working unchanged.
 *   - Dim mismatch is the caller's problem to handle (see
 *     `bridgeSearchEntries` — query embedding is generated with the
 *     active embedder, and rows are filtered by dim before scoring).
 *
 * Design note:
 *   This module is intentionally lazy + lock-free. The probe happens
 *   inside an async getter that races concurrent callers through a
 *   shared promise; first-caller-wins, everyone else awaits the same
 *   resolution. This avoids spawning N HTTP probes on a cold start where
 *   memory_store and memory_search land at the same time.
 *
 * @module memory/embedder-resolver
 */

import { swallowError } from '@claude-flow/shared';
import { embedTexts as ollamaEmbedTexts } from '../registry/ollama-embedder.js';

/** The active embedder selected by `getActiveEmbedder()`. */
export interface ActiveEmbedder {
  /** Embed a batch of texts. Each result is one vector per input text. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Output dimensionality (1024 for mxbai, 384 for MiniLM). */
  dim: number;
  /** Human-readable model identifier. */
  model: string;
  /** Which backend the embeddings actually came from. */
  source: 'ollama' | 'onnx-miniLM' | 'fallback-hash';
  /** True if this is the fallback path (Ollama unreachable). */
  isFallback: boolean;
}

/**
 * Probe options. Exposed for tests so we can simulate Ollama up/down
 * without needing a live daemon.
 */
export interface ResolverOptions {
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override Ollama base URL. */
  baseUrl?: string;
  /** Force re-probe. Default: false (cached singleton). */
  force?: boolean;
  /**
   * Pin a specific model. Skips probing when set — useful for tests.
   * "miniLM" forces the ONNX fallback without a network call.
   */
  preferredModel?: 'mxbai-embed-large' | 'nomic-embed-text' | 'miniLM';
  /** Override cache file path for ollama-embedder (tests). */
  cachePath?: string;
}

const PREFERRED_OLLAMA_MODEL = 'mxbai-embed-large';
const PREFERRED_OLLAMA_DIM = 1024;
const MINILM_DIM = 384;

let resolverPromise: Promise<ActiveEmbedder> | null = null;
let resolverCache: ActiveEmbedder | null = null;

/**
 * Probe Ollama once with a tiny test string. If a single embedding comes
 * back with the right shape we know the model is pulled and ready. Any
 * other outcome (timeout, 404, missing model, malformed response) falls
 * through to the MiniLM path.
 *
 * Returns `null` if Ollama can't serve `mxbai-embed-large` so the caller
 * knows to drop down a tier.
 */
async function probeOllama(
  opts: ResolverOptions,
): Promise<ActiveEmbedder | null> {
  const result = await ollamaEmbedTexts(['ruflo embedder probe'], {
    model: PREFERRED_OLLAMA_MODEL,
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.baseUrl,
    cachePath: opts.cachePath,
    // The probe MUST hit the network, otherwise a stale cached probe
    // entry would mask a real Ollama outage.
    noCache: true,
  });

  if (
    result.backend !== 'ollama' ||
    !result.vectors[0] ||
    result.vectors[0].length !== PREFERRED_OLLAMA_DIM
  ) {
    return null;
  }

  return {
    embed: async (texts: string[]) => {
      if (texts.length === 0) return [];
      // mxbai-embed-large advertises a 512-token context, but markdown +
      // code tokenizes denser (~3 chars/token worst case). A 1843-char
      // markdown blob with backticks + slashes still trips Ollama's
      // "the input length exceeds the context length" error. Hard-cap at
      // 1200 chars (≤400 tokens worst case) for safety. Truncation
      // preserves the lead — semantic search cares about gist not tail.
      const MAX_CHARS = 1200;
      const safeTexts = texts.map(t => (t && t.length > MAX_CHARS) ? t.slice(0, MAX_CHARS) : t);
      const r = await ollamaEmbedTexts(safeTexts, {
        model: PREFERRED_OLLAMA_MODEL,
        fetchImpl: opts.fetchImpl,
        baseUrl: opts.baseUrl,
        cachePath: opts.cachePath,
      });
      // Defensive: if Ollama still returned no usable vectors (transient
      // daemon error, model evicted, oversize-after-truncation edge), pad
      // a zero-length array per missing row instead of returning shorter
      // than requested — caller treats `[]` as a per-item failure.
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        out.push(r.vectors?.[i] ?? []);
      }
      return out;
    },
    dim: PREFERRED_OLLAMA_DIM,
    model: `ollama/${PREFERRED_OLLAMA_MODEL}`,
    source: 'ollama',
    isFallback: false,
  };
}

/**
 * Build the MiniLM (ONNX, 384-dim) fallback adapter. We don't load
 * the model here — that's the bridge's responsibility (it goes through
 * `getRegistry` → AgentDB → bundled embedder). This adapter is a thin
 * shim that lets callers ask "what dim should I assume?" without doing
 * the actual work.
 *
 * The actual embedding still flows through AgentDB's `embedder.embed()`
 * inside `bridgeStoreEntry` — we just record what the active model is.
 */
function buildMiniLMFallback(): ActiveEmbedder {
  return {
    embed: async (_texts: string[]) => {
      // The MiniLM path is wired through AgentDB's embedder, not via
      // this resolver. The bridge falls back to that when our
      // `getActiveEmbedder()` reports `source === 'onnx-miniLM'`. So
      // calling `.embed()` on this adapter directly is a no-op signal
      // that the caller should use AgentDB's embedder instead.
      return [];
    },
    dim: MINILM_DIM,
    model: 'Xenova/all-MiniLM-L6-v2',
    source: 'onnx-miniLM',
    isFallback: true,
  };
}

/**
 * Resolve which embedder is active for this process. First call probes
 * Ollama once; subsequent calls return the cached result. Pass
 * `{ force: true }` to re-probe (useful when the user just pulled a model
 * mid-session, or in tests).
 */
export async function getActiveEmbedder(
  opts: ResolverOptions = {},
): Promise<ActiveEmbedder> {
  if (!opts.force && resolverCache) return resolverCache;
  if (!opts.force && resolverPromise) return resolverPromise;

  // Test override — pin a specific model without probing.
  if (opts.preferredModel === 'miniLM') {
    resolverCache = buildMiniLMFallback();
    return resolverCache;
  }

  resolverPromise = (async () => {
    try {
      const ollama = await probeOllama(opts);
      if (ollama) {
        resolverCache = ollama;
        return ollama;
      }
    } catch (err) {
      // Swallow probe errors — never let probing crash the bridge.
      swallowError('embedder-resolver.probeOllama', err, 'falling back to MiniLM');
    }
    const miniLM = buildMiniLMFallback();
    resolverCache = miniLM;
    return miniLM;
  })();

  return resolverPromise;
}

/**
 * Reset the cached resolver. Tests use this to isolate between
 * scenarios (Ollama up vs down). Not part of the public surface.
 */
export function _resetEmbedderResolverForTests(): void {
  resolverCache = null;
  resolverPromise = null;
}

/**
 * Synchronous accessor for the last-resolved embedder. Returns `null`
 * if `getActiveEmbedder()` hasn't been awaited yet — callers that need
 * the dim before the first probe should `await getActiveEmbedder()`
 * instead.
 *
 * Exposed for `memory_bridge_status`, which is on a hot path and
 * shouldn't trigger a probe just to render a status line.
 */
export function peekActiveEmbedder(): ActiveEmbedder | null {
  return resolverCache;
}
