#!/usr/bin/env node
/**
 * ADR-121 Phase 13 — RAG primitive benchmark harness.
 *
 * Compares the five embeddings_search_text_* primitives on the same
 * controlled corpus + query set + relevance judgements:
 *
 *   - embeddings_search_text          (plain)
 *   - embeddings_search_text_batch    (multi-query)
 *   - embeddings_search_text_diverse  (MMR rerank)
 *   - embeddings_search_text_ensemble (RRF rank-level fusion)
 *   - embeddings_search_text_hyde     (HyDE embedding-level fusion)
 *
 * Metrics: recall@5, MRR, nDCG@5, mean latency.
 *
 * The corpus is deliberately small + deterministic so the benchmark
 * is reproducible across machines + CI runs. The real value here
 * is COMPARABILITY across the five primitives — every primitive runs
 * against the same corpus + queries, so the numbers expose the
 * tradeoffs between them.
 *
 * Outputs a markdown comparison table to stdout (plus structured
 * JSON if --json is passed).
 *
 * Run from repo root:
 *   node scripts/benchmark-rag-primitives.mjs
 *   node scripts/benchmark-rag-primitives.mjs --json
 *
 * Exit codes:
 *   0 — benchmark ran end-to-end; every primitive returned non-zero recall
 *   1 — at least one primitive failed contract (returned 0 recall on EVERY query)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/mcp-tools/embeddings-tools.js');

const { embeddingsTools } = await import(cliDist);
const { recallAtK, reciprocalRank, ndcgAtK } = await import(
  path.join(repoRoot, 'v3/@claude-flow/embeddings/dist/ir-metrics.js')
);

const argJson = process.argv.includes('--json');

function tool(n) {
  const t = embeddingsTools.find(t => t.name === n);
  if (!t) {
    console.error(`[FAIL] tool not registered: ${n}`);
    process.exit(1);
  }
  return t;
}

const initTool = tool('embeddings_init');
const buildTool = tool('embeddings_ann_router_build');
const generateTool = tool('embeddings_generate');
const searchText = tool('embeddings_search_text');
const searchBatch = tool('embeddings_search_text_batch');
const searchDiverse = tool('embeddings_search_text_diverse');
const searchEnsemble = tool('embeddings_search_text_ensemble');
const searchHyde = tool('embeddings_search_text_hyde');

// =========================================================
// Reproducible corpus (text-based — embedded via the same mock
// provider the queries use, so semantic similarity is comparable).
// =========================================================
// 20 docs across 4 topic clusters; each cluster has 5 paraphrased
// variants sharing the same topic keywords. The mock embedding
// provider is deterministic (hash-based), so identical wording →
// identical vectors; the cluster structure emerges from the shared
// keywords across each cluster's variants.
const DIM = 384;

const corpusTexts = {
  auth: [
    'authentication uses token-based credentials and OAuth flows',
    'login authentication issues a JWT token after credential check',
    'OAuth2 authentication flow with token refresh capability',
    'token authentication and JWT credential verification',
    'login flow with OAuth credentials and JWT token issuance',
  ],
  billing: [
    'billing calculates invoice charges from subscription usage',
    'invoice generation rules for subscription billing tiers',
    'subscription billing produces invoice charges per plan',
    'billing tiers determine invoice subscription charges',
    'subscription invoice with billing plan and usage charges',
  ],
  search: [
    'vector search retrieves semantic similarity via kNN lookup',
    'semantic vector search uses kNN for similarity retrieval',
    'kNN retrieval performs vector search by semantic similarity',
    'similarity retrieval through vector kNN semantic search',
    'vector semantic search with kNN similarity retrieval ranking',
  ],
  logging: [
    'logging configuration enables verbose debug log output',
    'verbose logging dumps debug output to structured logs',
    'structured logging with verbose debug configuration',
    'debug log verbose output with structured logging format',
    'verbose log configuration produces structured debug output',
  ],
};

let entries = []; // populated after we embed each doc via the same provider

// =========================================================
// Query set with binary relevance judgements
// =========================================================
// Each query has 5 known-relevant docs (its cluster). The benchmark
// measures how well each primitive recovers them in the top-5.
//
// For HyDE/ensemble, we give multiple variants per query so those
// primitives have something to fuse — represents the real-world
// LLM-rewriting / hypothetical-answer pattern.
const queries = [
  {
    label: 'auth question',
    text: 'authentication login flow with OAuth JWT token',
    variants: [
      'authentication login flow with OAuth JWT token',
      'OAuth JWT credential authentication flow',
      'login authentication using OAuth and JWT tokens',
    ],
    hypothetical: [
      'authentication uses tokens issued by the OAuth flow with JWT credential',
      'login flow returns a signed JWT token after OAuth credential check',
      'OAuth2 authentication issues JWT tokens with refresh credential flow',
    ],
    relevant: new Set(['auth-0', 'auth-1', 'auth-2', 'auth-3', 'auth-4']),
  },
  {
    label: 'billing question',
    text: 'billing invoice subscription charges',
    variants: [
      'billing invoice subscription charges',
      'subscription invoice billing calculation',
      'billing tiers subscription invoice charges',
    ],
    hypothetical: [
      'billing computes invoice subscription charges per plan tier',
      'invoice generation for subscription billing with tiered charges',
      'subscription plan determines invoice billing charges and tiers',
    ],
    relevant: new Set(['billing-0', 'billing-1', 'billing-2', 'billing-3', 'billing-4']),
  },
  {
    label: 'search question',
    text: 'vector semantic search kNN similarity retrieval',
    variants: [
      'vector semantic search kNN similarity retrieval',
      'semantic kNN vector similarity search retrieval',
      'vector retrieval search similarity kNN semantic',
    ],
    hypothetical: [
      'vector search retrieves results by semantic kNN similarity ranking',
      'semantic similarity search uses kNN vector retrieval techniques',
      'kNN vector search ranks results by semantic similarity retrieval',
    ],
    relevant: new Set(['search-0', 'search-1', 'search-2', 'search-3', 'search-4']),
  },
  {
    label: 'logging question',
    text: 'verbose logging debug structured output configuration',
    variants: [
      'verbose logging debug structured output configuration',
      'logging configuration verbose debug structured output',
      'structured debug logging verbose output configuration',
    ],
    hypothetical: [
      'verbose logging produces structured debug output via configuration',
      'logging configuration enables verbose structured debug output dumps',
      'structured logging with verbose configuration outputs debug logs',
    ],
    relevant: new Set(['logging-0', 'logging-1', 'logging-2', 'logging-3', 'logging-4']),
  },
];

console.log('=== RAG primitive benchmark ===');
console.log('Corpus:', entries.length, 'docs across 4 topic clusters');
console.log('Queries:', queries.length);
console.log('Metric @k =', 5);
console.log();

// =========================================================
// Setup
// =========================================================
const initRes = await initTool.handler({ provider: 'mock', dimension: DIM, force: true });
if (!initRes.success) {
  console.error('[FAIL] init', initRes);
  process.exit(1);
}

// Embed every corpus doc via embeddings_generate so the doc vectors
// and the query vectors share the same vector space (otherwise the
// benchmark is pointless — queries embed via the mock provider but
// docs would be arbitrary hand-rolled vectors).
console.log('Embedding corpus docs via embeddings_generate...');
for (const [prefix, texts] of Object.entries(corpusTexts)) {
  for (let i = 0; i < texts.length; i++) {
    const r = await generateTool.handler({ text: texts[i], normalize: true });
    if (!r.success) {
      console.error('[FAIL] embed corpus doc', prefix, i, r);
      process.exit(1);
    }
    entries.push({ id: `${prefix}-${i}`, vector: r.embedding });
  }
}
console.log(`Embedded ${entries.length} docs.`);

// Use a unique handle name to avoid stale-state contamination from
// prior smoke runs.
const handleName = `bench-rag-${Date.now()}`;
const buildRes = await buildTool.handler({
  name: handleName,
  workload: { corpusSize: entries.length, dimension: DIM, mutable: true },
  entries,
});
if (!buildRes.success) {
  console.error('[FAIL] build', buildRes);
  process.exit(1);
}
console.log(`Built ANN index '${handleName}' (backing=${buildRes.backing}, count=${buildRes.count})\n`);

// =========================================================
// Benchmark drivers — each returns { hits: string[], latencyMs: number }
// =========================================================
const K = 5;

const drivers = {
  search_text: async (q) => {
    const t0 = Date.now();
    const r = await searchText.handler({ text: q.text, name: handleName, k: K });
    return { hits: (r.hits ?? []).map(h => h.id), latencyMs: Date.now() - t0, ok: !!r.success };
  },
  search_text_batch: async (q) => {
    // Batch returns N lists. For a single-number metric we collapse to
    // the first list's results — this is the "naive batch use" baseline.
    const t0 = Date.now();
    const r = await searchBatch.handler({ texts: q.variants, name: handleName, k: K });
    const firstList = (r.results?.[0]?.hits ?? []).map(h => h.id);
    return { hits: firstList, latencyMs: Date.now() - t0, ok: !!r.success };
  },
  search_text_diverse: async (q) => {
    const t0 = Date.now();
    const r = await searchDiverse.handler({ text: q.text, name: handleName, k: K, lambda: 0.5 });
    return { hits: (r.hits ?? []).map(h => h.id), latencyMs: Date.now() - t0, ok: !!r.success };
  },
  search_text_ensemble: async (q) => {
    const t0 = Date.now();
    const r = await searchEnsemble.handler({ texts: q.variants, name: handleName, k: K });
    return { hits: (r.hits ?? []).map(h => h.id), latencyMs: Date.now() - t0, ok: !!r.success };
  },
  search_text_hyde: async (q) => {
    const t0 = Date.now();
    const r = await searchHyde.handler({ texts: q.hypothetical, name: handleName, k: K });
    return { hits: (r.hits ?? []).map(h => h.id), latencyMs: Date.now() - t0, ok: !!r.success };
  },
};

// =========================================================
// Run + score
// =========================================================
const results = {}; // tool → array of {query, hits, recall, rr, ndcg, latencyMs}

for (const [name, run] of Object.entries(drivers)) {
  results[name] = [];
  for (const q of queries) {
    const r = await run(q);
    if (!r.ok) {
      console.error(`[WARN] ${name} on "${q.label}" returned !ok`);
    }
    const recall = recallAtK(r.hits, q.relevant, K);
    const rr = reciprocalRank(r.hits, q.relevant);
    const ndcg = ndcgAtK(r.hits, q.relevant, K);
    results[name].push({ query: q.label, hits: r.hits, recall, rr, ndcg, latencyMs: r.latencyMs });
  }
}

// =========================================================
// Aggregate
// =========================================================
function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}
function round(n, d = 3) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

const summary = {};
for (const [name, runs] of Object.entries(results)) {
  summary[name] = {
    recallAt5: round(mean(runs.map(r => r.recall))),
    mrr: round(mean(runs.map(r => r.rr))),
    ndcgAt5: round(mean(runs.map(r => r.ndcg))),
    meanLatencyMs: round(mean(runs.map(r => r.latencyMs)), 1),
  };
}

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ corpus: entries.length, queries: queries.length, k: K, summary, perQuery: results }, null, 2));
} else {
  console.log('| primitive | recall@5 | MRR | nDCG@5 | mean latency (ms) |');
  console.log('|---|---:|---:|---:|---:|');
  for (const [name, s] of Object.entries(summary)) {
    console.log(`| \`${name}\` | ${s.recallAt5.toFixed(3)} | ${s.mrr.toFixed(3)} | ${s.ndcgAt5.toFixed(3)} | ${s.meanLatencyMs.toFixed(1)} |`);
  }
  console.log();
  console.log('Per-query breakdown:');
  for (const [name, runs] of Object.entries(results)) {
    console.log(`\n  ${name}:`);
    for (const r of runs) {
      console.log(`    ${r.query.padEnd(20)} recall=${r.recall.toFixed(2)} rr=${r.rr.toFixed(2)} ndcg=${r.ndcg.toFixed(2)} (${r.latencyMs}ms) hits=[${r.hits.slice(0, 3).join(', ')}...]`);
    }
  }
}

// =========================================================
// Exit code: fail only if a primitive returned ZERO recall on EVERY query
// (catastrophic failure — pipeline broken). Bad-but-nonzero recall is
// expected for some primitives on some queries; the goal here is
// pipeline-integrity verification + producing comparable numbers, not
// asserting a specific quality ordering.
// =========================================================
let exit = 0;
for (const [name, s] of Object.entries(summary)) {
  if (s.recallAt5 === 0) {
    console.error(`[FAIL] ${name} returned 0 recall on every query — pipeline broken`);
    exit = 1;
  }
}
process.exit(exit);
