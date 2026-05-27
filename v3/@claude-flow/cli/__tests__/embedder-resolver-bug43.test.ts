/**
 * #bug43.1 — embedder-resolver regression.
 *
 * Asserts the resolver picks the right embedder for the live conditions:
 *   1. Ollama up + `mxbai-embed-large` pulled → 1024-dim ollama backend.
 *   2. Ollama down (fetch returns null/throws) → 384-dim MiniLM fallback.
 *   3. Result is cached — second call doesn't re-probe (no extra fetch).
 *   4. `force: true` re-probes.
 *
 * We avoid touching a real Ollama daemon by injecting a `fetchImpl` —
 * the resolver delegates the probe to `embedTexts` which honors the
 * `fetchImpl` override (Bug 25 design).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { join } from 'path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'bug43-resolver-'));
const cachePath = join(tmpRoot, 'embedding-cache.json');

const {
  getActiveEmbedder,
  _resetEmbedderResolverForTests,
  peekActiveEmbedder,
} = await import('../src/memory/embedder-resolver.js');
const { _resetEmbeddingCacheForTests } = await import(
  '../src/registry/ollama-embedder.js'
);

/** A fetch that always 404s — simulates Ollama-down or model-missing. */
const fakeFetchDown: typeof fetch = (async () => ({
  ok: false,
  status: 404,
  json: async () => ({}),
})) as unknown as typeof fetch;

/**
 * A fetch that returns a 1024-dim mxbai response. Tracks call count so
 * we can assert that a second `getActiveEmbedder()` call doesn't re-probe.
 */
function makeFakeFetchUp() {
  let calls = 0;
  const f: typeof fetch = (async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [new Array(1024).fill(0).map((_, i) => Math.sin(i / 1024))],
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, getCalls: () => calls };
}

beforeEach(() => {
  _resetEmbedderResolverForTests();
  _resetEmbeddingCacheForTests();
});

describe('#bug43.1 embedder resolver', () => {
  it('falls back to MiniLM when Ollama is unreachable', async () => {
    const active = await getActiveEmbedder({
      fetchImpl: fakeFetchDown,
      cachePath,
    });
    expect(active.source).toBe('onnx-miniLM');
    expect(active.dim).toBe(384);
    expect(active.isFallback).toBe(true);
    expect(active.model).toContain('MiniLM');
  });

  it('picks Ollama mxbai-embed-large when probe succeeds', async () => {
    const { fetch: f } = makeFakeFetchUp();
    const active = await getActiveEmbedder({
      fetchImpl: f,
      cachePath,
    });
    expect(active.source).toBe('ollama');
    expect(active.dim).toBe(1024);
    expect(active.isFallback).toBe(false);
    expect(active.model).toBe('ollama/mxbai-embed-large');
  });

  it('caches the resolution — second call does not re-probe', async () => {
    const { fetch: f, getCalls } = makeFakeFetchUp();
    await getActiveEmbedder({ fetchImpl: f, cachePath });
    const firstCalls = getCalls();
    expect(firstCalls).toBeGreaterThan(0);

    // Second call must NOT increment fetch counter.
    await getActiveEmbedder({ fetchImpl: f, cachePath });
    expect(getCalls()).toBe(firstCalls);
  });

  it('force: true re-probes even when cached', async () => {
    const { fetch: f, getCalls } = makeFakeFetchUp();
    await getActiveEmbedder({ fetchImpl: f, cachePath });
    const firstCalls = getCalls();

    await getActiveEmbedder({ fetchImpl: f, cachePath, force: true });
    expect(getCalls()).toBeGreaterThan(firstCalls);
  });

  it('peekActiveEmbedder returns null before first resolve', () => {
    expect(peekActiveEmbedder()).toBeNull();
  });

  it('peekActiveEmbedder returns the cached embedder after resolve', async () => {
    await getActiveEmbedder({
      fetchImpl: fakeFetchDown,
      cachePath,
    });
    const peeked = peekActiveEmbedder();
    expect(peeked).not.toBeNull();
    expect(peeked?.source).toBe('onnx-miniLM');
  });

  it('preferredModel: "miniLM" pins the fallback without probing', async () => {
    const { fetch: f, getCalls } = makeFakeFetchUp();
    const active = await getActiveEmbedder({
      fetchImpl: f,
      cachePath,
      preferredModel: 'miniLM',
    });
    expect(active.source).toBe('onnx-miniLM');
    expect(active.dim).toBe(384);
    // No probe happened.
    expect(getCalls()).toBe(0);
  });

  it('rejects an Ollama response with the wrong dim', async () => {
    // Daemon returns 768-dim instead of 1024 — not mxbai-embed-large.
    const wrongDimFetch: typeof fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [new Array(768).fill(0.1)],
      }),
    })) as unknown as typeof fetch;
    const active = await getActiveEmbedder({
      fetchImpl: wrongDimFetch,
      cachePath,
    });
    // Should have fallen back to MiniLM since dim didn't match expected.
    expect(active.source).toBe('onnx-miniLM');
  });
});
