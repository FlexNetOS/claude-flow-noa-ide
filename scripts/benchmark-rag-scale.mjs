#!/usr/bin/env node
/**
 * ADR-121 Phase 15 — RAG primitive scale benchmark.
 *
 * The topology benchmark (Phase 14) proved each primitive dominates
 * exactly one corpus shape on a 25-doc / 16-dim setup. This benchmark
 * asks: do those tradeoffs persist at production scale?
 *
 * Runs plain / MMR / RRF / HyDE-avg on three corpus sizes:
 *   - 1k docs (smoke)
 *   - 5k docs (medium)
 *   - 10k docs (production-ish)
 *
 * Uses 384-dim vectors (matching real-world embedding sizes) and the
 * deterministic buildSyntheticTopicCorpus from
 * @claude-flow/embeddings so the benchmark is bit-for-bit
 * reproducible.
 *
 * Per (primitive, scale) we collect across N=5 queries:
 *   - recall@5 (mean)
 *   - nDCG@5 (mean)
 *   - p50 latency (median)
 *   - p95 latency
 *   - latency growth: ratio of p50 at this scale vs the smallest scale
 *
 * Output: two cross-tabulations (recall + latency) showing how each
 * primitive scales.
 *
 * Run from repo root:
 *   node scripts/benchmark-rag-scale.mjs
 *   node scripts/benchmark-rag-scale.mjs --scales 1000,5000,10000
 *   node scripts/benchmark-rag-scale.mjs --scales 500       # CI mode
 *   node scripts/benchmark-rag-scale.mjs --json
 *
 * Exit 0 on success (every cell produces a finite metric).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const { mmrRerank } = await import(path.join(embDist, 'mmr.js'));
const { reciprocalRankFusion } = await import(path.join(embDist, 'rrf.js'));
const { averageEmbeddings } = await import(path.join(embDist, 'embedding-fusion.js'));
const { recallAtK, ndcgAtK } = await import(path.join(embDist, 'ir-metrics.js'));
const { buildSyntheticTopicCorpus } = await import(path.join(embDist, 'synthetic-corpus.js'));

const argv = process.argv.slice(2);
const argJson = argv.includes('--json');
const scalesArg = argv.find(a => a.startsWith('--scales='))?.split('=')[1]
  ?? argv[argv.indexOf('--scales') + 1];
const SCALES = scalesArg
  ? scalesArg.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0)
  : [1000, 5000, 10000];

const DIM = 384;
const TOPICS = 5;
const K = 5;
const NUM_QUERIES = 5; // average across this many queries per scale
const PERTURB_AMOUNT = 0.15; // noise added to query to make ranking non-trivial

if (SCALES.length === 0) {
  console.error('No valid scales');
  process.exit(1);
}

// =========================================================
// Pure cosine top-k (no library coupling)
// =========================================================
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function plainTopK(corpus, queryVec, k) {
  const scored = corpus.map(c => ({ id: c.id, vector: c.vector, score: cosine(queryVec, c.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function perturbVector(v, amount, rng) {
  const out = new Float32Array(v.length);
  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] + (rng() - 0.5) * 2 * amount;
    sq += out[i] * out[i];
  }
  const inv = sq > 0 ? 1 / Math.sqrt(sq) : 1;
  for (let i = 0; i < v.length; i++) out[i] *= inv;
  return out;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function nanos() {
  return Number(process.hrtime.bigint());
}

// =========================================================
// Primitives — each takes (corpus, query, hypothetical, variants)
// and returns hits (ordered ids) + elapsed ns
// =========================================================
const K_FETCH = 25; // wider fetch for MMR

function runPlain(corpus, q) {
  const t0 = nanos();
  const hits = plainTopK(corpus, q.queryVec, K).map(h => h.id);
  return { hits, ns: nanos() - t0 };
}

function runMmr(corpus, q) {
  const t0 = nanos();
  const cands = plainTopK(corpus, q.queryVec, K_FETCH);
  const picked = mmrRerank(
    cands.map(c => ({ id: c.id, vector: c.vector })),
    q.queryVec,
    { k: K, lambda: 0.5 },
  );
  return { hits: picked.map(p => p.id), ns: nanos() - t0 };
}

function runRrf(corpus, q) {
  const t0 = nanos();
  const lists = q.variants.map(v => plainTopK(corpus, v, K).map(h => ({ id: h.id })));
  const fused = reciprocalRankFusion(lists, { k: K });
  return { hits: fused.map(h => h.id), ns: nanos() - t0 };
}

function runHyde(corpus, q) {
  const t0 = nanos();
  const avg = averageEmbeddings(q.hypothetical, { normalizeInputs: true, normalizeOutput: true });
  const hits = plainTopK(corpus, avg, K).map(h => h.id);
  return { hits, ns: nanos() - t0 };
}

const primitives = { plain: runPlain, mmr: runMmr, rrf: runRrf, hyde: runHyde };

// =========================================================
// Query generator: for each topic, build a query plus 3 variants
// (slightly-perturbed copies of the topic-centroid query) and 3
// hypothetical-answer vectors (also perturbed).
// =========================================================
function buildQueries(corpus, count) {
  const rng = mulberry32(7);
  const qs = [];
  for (let i = 0; i < count; i++) {
    const topic = i % corpus.topicQueryVectors.length;
    const center = corpus.topicQueryVectors[topic];
    const queryVec = perturbVector(center, PERTURB_AMOUNT, rng);
    const variants = [queryVec,
      perturbVector(center, PERTURB_AMOUNT, rng),
      perturbVector(center, PERTURB_AMOUNT, rng)];
    const hypothetical = [
      perturbVector(center, PERTURB_AMOUNT * 0.5, rng),
      perturbVector(center, PERTURB_AMOUNT * 0.5, rng),
      perturbVector(center, PERTURB_AMOUNT * 0.5, rng),
    ];
    qs.push({
      label: `topic-${topic}-q${i}`,
      queryVec,
      variants,
      hypothetical,
      relevant: corpus.relevantByTopic[topic],
    });
  }
  return qs;
}

// =========================================================
// Run
// =========================================================
const allResults = {}; // scale → primitive → {meanRecall, meanNdcg, p50, p95, recalls, ndcgs, latenciesNs}

if (!argJson) {
  console.log('=== RAG primitive scale benchmark ===');
  console.log(`Scales: ${SCALES.join(', ')} docs`);
  console.log(`Topics: ${TOPICS}, dim: ${DIM}, k=${K}, queries per scale: ${NUM_QUERIES}`);
  console.log();
}

for (const N of SCALES) {
  const docsPerTopic = Math.ceil(N / TOPICS);
  const corpus = buildSyntheticTopicCorpus({
    topics: TOPICS,
    docsPerTopic,
    dim: DIM,
    duplicateRatio: 0.4,
    noiseLevel: 0.05,
    seed: 42,
  });
  if (!argJson) console.log(`Scale ${N}: built corpus with ${corpus.entries.length} docs (${docsPerTopic} per topic)`);

  const queries = buildQueries(corpus, NUM_QUERIES);
  allResults[N] = {};
  for (const [name, run] of Object.entries(primitives)) {
    const recalls = [];
    const ndcgs = [];
    const latencies = [];
    for (const q of queries) {
      const r = run(corpus.entries, q);
      recalls.push(recallAtK(r.hits, q.relevant, K));
      ndcgs.push(ndcgAtK(r.hits, q.relevant, K));
      latencies.push(r.ns / 1_000_000); // ms
    }
    allResults[N][name] = {
      meanRecall: recalls.reduce((s, v) => s + v, 0) / recalls.length,
      meanNdcg: ndcgs.reduce((s, v) => s + v, 0) / ndcgs.length,
      p50Ms: median(latencies),
      p95Ms: percentile(latencies, 95),
    };
  }
}

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ scales: SCALES, results: allResults, dim: DIM, topics: TOPICS, k: K }, null, 2));
} else {
  console.log();
  console.log('### Mean recall@5 (higher is better)');
  console.log();
  const cols = Object.keys(primitives);
  console.log('| scale | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const N of SCALES) {
    const row = cols.map(c => allResults[N][c].meanRecall.toFixed(3));
    console.log(`| ${N} | ` + row.join(' | ') + ' |');
  }
  console.log();

  console.log('### Mean nDCG@5 (higher is better)');
  console.log();
  console.log('| scale | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const N of SCALES) {
    const row = cols.map(c => allResults[N][c].meanNdcg.toFixed(3));
    console.log(`| ${N} | ` + row.join(' | ') + ' |');
  }
  console.log();

  console.log('### p50 latency (ms) — lower is better');
  console.log();
  console.log('| scale | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const N of SCALES) {
    const row = cols.map(c => allResults[N][c].p50Ms.toFixed(2));
    console.log(`| ${N} | ` + row.join(' | ') + ' |');
  }
  console.log();

  console.log('### p95 latency (ms)');
  console.log();
  console.log('| scale | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const N of SCALES) {
    const row = cols.map(c => allResults[N][c].p95Ms.toFixed(2));
    console.log(`| ${N} | ` + row.join(' | ') + ' |');
  }
  console.log();

  // Latency growth ratios (only if >1 scale)
  if (SCALES.length > 1) {
    const baseScale = SCALES[0];
    console.log(`### Latency growth (p50 ratio vs ${baseScale}-doc baseline)`);
    console.log();
    console.log('| scale | ' + cols.join(' | ') + ' |');
    console.log('|---|' + cols.map(() => '---:').join('|') + '|');
    for (const N of SCALES) {
      const row = cols.map(c => {
        const ratio = allResults[N][c].p50Ms / allResults[baseScale][c].p50Ms;
        return ratio.toFixed(2) + 'x';
      });
      console.log(`| ${N} | ` + row.join(' | ') + ' |');
    }
    console.log();
  }
}

// =========================================================
// Pass criterion
// =========================================================
let ok = true;
for (const N of SCALES) {
  for (const c of Object.keys(primitives)) {
    const m = allResults[N][c];
    for (const k of ['meanRecall', 'meanNdcg', 'p50Ms', 'p95Ms']) {
      const v = m[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        console.error(`[FAIL] scale=${N} ${c}/${k} = ${v} (not finite >= 0)`);
        ok = false;
      }
    }
  }
}
process.exit(ok ? 0 : 1);
