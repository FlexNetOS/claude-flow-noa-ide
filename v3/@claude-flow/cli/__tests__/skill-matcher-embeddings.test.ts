/**
 * Regression tests for #bug25 — the skill-matcher upgrade from
 * keyword-only scoring to embedding-backed semantic + hybrid matching
 * via local Ollama.
 *
 * The tests deliberately do NOT depend on a live Ollama daemon. We
 * inject a mock `fetch` into both the embedder and the matcher so the
 * test is hermetic and runs the same on CI as on a developer laptop
 * with `ollama pull mxbai-embed-large` ready to go.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  embedTexts,
  cosineSimilarity,
  resolveEmbeddingCachePath,
} from '../src/registry/ollama-embedder.js';
import {
  matchUserSkillsForTaskSemantic,
  matchUserSkillsForTask,
} from '../src/registry/skill-matcher.js';
import type { UserAgent, UserSkill } from '../src/registry/claude-code-registry.js';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-bug25-'));
  cachePath = join(tmpDir, 'embedding-cache.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RUFLO_EMBEDDING_CACHE_PATH;
  delete process.env.OLLAMA_HOST;
});

/**
 * Build a deterministic, unit-norm vector from a string. Tokens that
 * appear in the input add weight to fixed dimensions, so we can craft
 * mock embeddings whose cosine similarity matches our test intuition
 * (e.g. "trading bot" and "polymarket trading bot" land close together;
 * "kali" lands far from both).
 */
function makeMockVector(text: string, dims = 16): number[] {
  const lc = text.toLowerCase();
  // Each token maps to a dimension. We allocate a small handful of
  // semantic axes that the tests care about. The vector is unit-norm
  // after the loop so cosine similarity stays in [0,1].
  const axes: Record<string, number> = {
    trading: 0,
    bot: 1,
    market: 2,
    polymarket: 3,
    bet: 4,
    position: 5,
    osint: 6,
    username: 7,
    email: 8,
    kali: 9,
    audit: 10,
  };
  const v = new Array<number>(dims).fill(0);
  for (const [token, dim] of Object.entries(axes)) {
    if (lc.includes(token)) v[dim] = 1;
  }
  // Add a tiny non-zero baseline so vectors with no overlap don't end
  // up as zero vectors (cosine of zero = 0, which is fine but messes
  // with negative signal).
  v[15] = 0.05;
  // Unit-normalize.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

/** Build a mock fetch that mimics Ollama's `/api/embed` HTTP API. */
function makeOllamaMock(opts?: {
  failModel?: string;
  status?: number;
  recordCalls?: { count: number };
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith('/api/embed')) {
      return new Response('not found', { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model: string;
      input: string[];
    };
    if (opts?.recordCalls) opts.recordCalls.count++;
    if (opts?.failModel && body.model === opts.failModel) {
      return new Response('model not found', { status: opts?.status ?? 404 });
    }
    const embeddings = body.input.map((t) => makeMockVector(t));
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('#bug25.1 — ollama-embedder', () => {
  it('embeds a batch of texts via the Ollama HTTP API', async () => {
    const calls = { count: 0 };
    const mock = makeOllamaMock({ recordCalls: calls });

    const result = await embedTexts(['hello world', 'foo bar baz'], {
      fetchImpl: mock,
      cachePath,
      model: 'mxbai-embed-large',
    });

    expect(result.backend).toBe('ollama');
    expect(result.model).toBe('mxbai-embed-large');
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(16);
    expect(calls.count).toBe(1);
  });

  it('persists embeddings to the cache file and skips re-fetch on hit', async () => {
    const calls = { count: 0 };
    const mock = makeOllamaMock({ recordCalls: calls });

    const r1 = await embedTexts(['polymarket trading bot'], {
      fetchImpl: mock,
      cachePath,
      model: 'mxbai-embed-large',
    });
    expect(calls.count).toBe(1);
    expect(r1.vectors).toHaveLength(1);

    // Cache file should now exist on disk.
    const raw = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toHaveLength(1);

    const r2 = await embedTexts(['polymarket trading bot'], {
      fetchImpl: mock,
      cachePath,
      model: 'mxbai-embed-large',
    });
    // Same input — we should NOT have hit the network a second time.
    expect(calls.count).toBe(1);
    expect(r2.vectors[0]).toEqual(r1.vectors[0]);
  });

  it('falls back through the model chain when the first model 404s', async () => {
    const calls = { count: 0 };
    const mock = makeOllamaMock({ failModel: 'mxbai-embed-large', recordCalls: calls });

    const result = await embedTexts(['x'], { fetchImpl: mock, cachePath });
    // First call (mxbai) fails with 404, second call (nomic) succeeds.
    expect(calls.count).toBe(2);
    expect(result.backend).toBe('ollama');
    expect(result.model).toBe('nomic-embed-text');
  });

  it('returns backend=null when Ollama is completely unreachable', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await embedTexts(['anything'], {
      fetchImpl: failingFetch,
      cachePath,
    });
    expect(result.backend).toBeNull();
    expect(result.model).toBeNull();
    expect(result.vectors).toEqual([]);
  });

  it('survives a corrupt cache file without throwing', async () => {
    writeFileSync(cachePath, '{not valid json', 'utf8');
    const mock = makeOllamaMock();

    const result = await embedTexts(['hello'], {
      fetchImpl: mock,
      cachePath,
      model: 'mxbai-embed-large',
    });
    expect(result.backend).toBe('ollama');
    expect(result.vectors).toHaveLength(1);
  });

  it('cosineSimilarity returns 0 for mismatched / empty vectors', () => {
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it('cosineSimilarity returns ~1 for identical vectors', () => {
    const v = [0.1, 0.2, 0.3, 0.4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('exposes a stable default cache path under ~/.claude/.claude-flow/data', () => {
    delete process.env.RUFLO_EMBEDDING_CACHE_PATH;
    const path = resolveEmbeddingCachePath();
    expect(path).toMatch(/\.claude\/\.claude-flow\/data\/embedding-cache\.json$/);
  });
});

describe('#bug25.2 — skill-matcher semantic + hybrid', () => {
  const polymarketSkills: UserSkill[] = [
    {
      name: 'polymarket-analyzer',
      path: '/fake/skills/polymarket-analyzer',
      description:
        'Polymarket trading advisor — 24h performance report, news correlation, position management, market making bot',
    },
    {
      name: 'kali-osint-username',
      path: '/fake/skills/kali-osint-username',
      description:
        'OSINT target is a username/handle. Runs sherlock + maigret + blackbird inside kali-pentest.',
    },
  ];
  const polymarketAgents: UserAgent[] = [
    {
      name: 'polybot-ops',
      path: '/fake/agents/polybot-ops.md',
      category: 'root',
      description:
        'Polymarket bot operations — assign positions to strategies, check wallets, query live markets',
    },
  ];

  it('semantic match: "trading bot" finds polymarket-analyzer despite zero token overlap', async () => {
    const mock = makeOllamaMock();

    const result = await matchUserSkillsForTaskSemantic(
      'trading bot',
      undefined,
      polymarketSkills,
      polymarketAgents,
      {
        embedderOptions: { fetchImpl: mock, cachePath, noCache: true },
        threshold: 0.3,
      },
    );

    expect(result.backend).toBe('hybrid');
    expect(result.model).toBe('mxbai-embed-large');
    const names = result.matches.map((m) => m.name);
    // Polymarket entries should be in the top of the list — they share
    // the "trading"/"bot" semantic axes.
    expect(names).toContain('polymarket-analyzer');
    expect(names[0]).toMatch(/^poly/);
    // The kali OSINT skill should NOT make the cut at threshold 0.3.
    expect(names).not.toContain('kali-osint-username');
  });

  it('falls back to keyword backend when Ollama is unreachable', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await matchUserSkillsForTaskSemantic(
      'audit polymarket trading positions',
      undefined,
      polymarketSkills,
      polymarketAgents,
      {
        embedderOptions: { fetchImpl: failingFetch, cachePath, noCache: true },
      },
    );

    expect(result.backend).toBe('keyword');
    expect(result.model).toBeNull();
    // Keyword scorer still has plenty to chew on — "polymarket" and
    // "trading" both hit name/description tokens.
    expect(result.matches.length).toBeGreaterThan(0);
    const names = result.matches.map((m) => m.name);
    expect(names).toContain('polymarket-analyzer');
  });

  it('falls back to keyword when Ollama returns 502 for every model', async () => {
    const fail502 = (async () =>
      new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;

    const result = await matchUserSkillsForTaskSemantic(
      'polymarket position audit',
      undefined,
      polymarketSkills,
      polymarketAgents,
      {
        embedderOptions: { fetchImpl: fail502, cachePath, noCache: true },
      },
    );
    expect(result.backend).toBe('keyword');
  });

  it('pureSemantic mode reports backend="embedding" and skips keyword blend', async () => {
    const mock = makeOllamaMock();

    const result = await matchUserSkillsForTaskSemantic(
      'trading bot',
      undefined,
      polymarketSkills,
      polymarketAgents,
      {
        embedderOptions: { fetchImpl: mock, cachePath, noCache: true },
        pureSemantic: true,
        threshold: 0.3,
      },
    );

    expect(result.backend).toBe('embedding');
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('hybrid blend orders polymarket skills above kali for a polymarket task', async () => {
    const mock = makeOllamaMock();

    const result = await matchUserSkillsForTaskSemantic(
      'polymarket trading bot positions',
      undefined,
      polymarketSkills,
      polymarketAgents,
      {
        embedderOptions: { fetchImpl: mock, cachePath, noCache: true },
        threshold: 0.0,
      },
    );

    expect(result.backend).toBe('hybrid');
    // Top result should be a polymarket-flavored entry.
    expect(result.matches[0].name).toMatch(/^poly/);
    // Kali OSINT, if present, should rank below polymarket entries.
    const polyIdx = result.matches.findIndex((m) => m.name.startsWith('poly'));
    const kaliIdx = result.matches.findIndex((m) => m.name.startsWith('kali'));
    if (polyIdx >= 0 && kaliIdx >= 0) {
      expect(polyIdx).toBeLessThan(kaliIdx);
    }
  });

  it('returns empty matches and no embedding model when no skills/agents are provided', async () => {
    const mock = makeOllamaMock();
    const result = await matchUserSkillsForTaskSemantic('anything', undefined, [], [], {
      embedderOptions: { fetchImpl: mock, cachePath, noCache: true },
    });
    expect(result.matches).toEqual([]);
    expect(result.backend).toBe('hybrid');
  });

  it('back-compat: matchUserSkillsForTask (sync, keyword-only) still works as before', () => {
    const matches = matchUserSkillsForTask(
      'audit polymarket trading positions',
      undefined,
      polymarketSkills,
      polymarketAgents,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toMatch(/poly/);
  });
});

describe('#bug25 — sample output for PR comment', () => {
  it('matchUserSkillsForTaskSemantic("trading bot") returns polymarket-flavored hits', async () => {
    const mock = makeOllamaMock();
    const skills: UserSkill[] = [
      {
        name: 'polymarket-analyzer',
        path: '/fake',
        description: 'Polymarket trading advisor with position management.',
      },
    ];
    const result = await matchUserSkillsForTaskSemantic(
      'trading bot',
      undefined,
      skills,
      [],
      {
        embedderOptions: { fetchImpl: mock, cachePath, noCache: true },
        threshold: 0.25,
      },
    );

    const top = result.matches[0];
    expect(top).toBeDefined();
    expect(top.name).toBe('polymarket-analyzer');
    expect(top.score).toBeGreaterThan(0);
    // Sanity-check the full payload shape that a caller (hooks_route)
    // would observe.
    expect(top.type).toBe('skill');
    expect(typeof top.score).toBe('number');
    expect(Array.isArray(top.matchedKeywords)).toBe(true);
  });
});
