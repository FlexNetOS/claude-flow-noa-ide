#!/usr/bin/env node
/**
 * ADR-121 Phase 14 — Topology benchmark suite for RAG primitives.
 *
 * The Phase 13 benchmark used the deterministic mock embedding
 * provider, which produces essentially random vectors — so on a
 * trivial 20-doc corpus all primitives hit 1.0 recall and the
 * tradeoffs that motivated each primitive (MMR's diversity,
 * RRF's intent boundaries, HyDE's centroid-finding) don't show up.
 *
 * This benchmark fixes that by operating DIRECTLY on hand-crafted
 * vector topologies designed to expose each primitive's strength.
 * Calls the underlying algorithms (mmrRerank, reciprocalRankFusion,
 * averageEmbeddings, plain cosine top-k) — no MCP tool layer, no
 * mock provider — pure algorithmic comparison.
 *
 * Topologies:
 *   1. easy             — clean clusters, every primitive does well
 *   2. duplicate-heavy  — 5 near-dup relevant + 5 distinct relevant
 *                         exposes MMR's diversity value
 *   3. multi-intent     — query has 2 distinct intent variants, each
 *                         with 3 relevant docs; exposes RRF's
 *                         intent-boundary preservation vs HyDE's
 *                         intent-blurring centroid
 *   4. q-a-gap          — query vector is OFFSET from relevant docs
 *                         along a known axis; multiple hypothetical
 *                         answers correct the offset on average →
 *                         exposes HyDE's value over plain search
 *
 * For each topology, we run:
 *   - plain         (cosine top-k against the single query vector)
 *   - mmr           (plain top-(3k), then mmrRerank to k)
 *   - rrf           (top-k per query variant, RRF-fuse)
 *   - hyde          (avg query variants → single vector, plain top-k)
 *
 * Output: cross-tabulation of recall@5 and nDCG@5 across (primitive,
 * topology). The CI guard's pass criterion is "non-NaN, in [0,1]"
 * — the table exposes the tradeoffs without asserting a winner.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const { mmrRerank } = await import(path.join(embDist, 'mmr.js'));
const { reciprocalRankFusion } = await import(path.join(embDist, 'rrf.js'));
const { averageEmbeddings } = await import(path.join(embDist, 'embedding-fusion.js'));
const { recallAtK, ndcgAtK, reciprocalRank } = await import(path.join(embDist, 'ir-metrics.js'));

const argJson = process.argv.includes('--json');

// =========================================================
// Plain cosine top-k (no library — we own the math here so the
// benchmark has no hidden coupling).
// =========================================================
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function plainTopK(corpus, queryVec, k) {
  const scored = corpus.map(c => ({ id: c.id, vector: c.vector, score: cosine(queryVec, c.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// =========================================================
// Topology builders. Each returns:
//   { corpus, queryVec, queryVariants, relevant, label }
// =========================================================
const DIM = 16;

function vec(values) {
  if (values.length !== DIM) throw new Error(`expected dim=${DIM}, got ${values.length}`);
  return new Float32Array(values);
}
function unit(values) {
  const v = vec(values);
  let sq = 0;
  for (const x of v) sq += x * x;
  if (sq === 0) return v;
  const n = Math.sqrt(sq);
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = v[i] / n;
  return out;
}
function rand(n, scale = 0.05, seed = 1) {
  // Deterministic pseudo-random for reproducibility.
  const out = new Array(DIM).fill(0);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    out[i] = ((s / 233280) - 0.5) * scale * 2;
  }
  return out;
}

// --- Topology 1: easy clusters ---
// 5 relevant docs near (1, 0, ...), 15 distractors elsewhere.
function topologyEasy() {
  const corpus = [];
  for (let i = 0; i < 5; i++) {
    const v = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // tiny noise on other axes
    const noise = rand(DIM, 0.02, i + 100);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `rel-${i}`, vector: unit(v) });
  }
  for (let i = 0; i < 15; i++) {
    const v = rand(DIM, 1.0, i + 200);
    corpus.push({ id: `dist-${i}`, vector: unit(v) });
  }
  const queryVec = unit([1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return {
    label: 'easy',
    corpus,
    queryVec,
    queryVariants: [queryVec],
    hypothetical: [queryVec],
    relevant: new Set(['rel-0', 'rel-1', 'rel-2', 'rel-3', 'rel-4']),
  };
}

// --- Topology 2: duplicate-heavy ---
// 5 near-duplicate relevant docs near (1, 0, ...), all almost identical.
// Plus 5 MORE distinct relevant docs spread along other axes (we want
// diverse top-5 to span the relevant set). 10 distractors.
function topologyDuplicateHeavy() {
  const corpus = [];
  // 5 near-dups on axis 0
  for (let i = 0; i < 5; i++) {
    const v = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const noise = rand(DIM, 0.01, i + 300);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `dup-${i}`, vector: unit(v) });
  }
  // 5 distinct relevant on neighboring axes (1..5), still somewhat
  // similar to the query but spread across different directions
  for (let i = 0; i < 5; i++) {
    const v = new Array(DIM).fill(0);
    v[0] = 0.5; // share some query alignment
    v[i + 1] = 0.7; // distinct direction each
    const noise = rand(DIM, 0.01, i + 400);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `distinct-${i}`, vector: unit(v) });
  }
  // distractors
  for (let i = 0; i < 10; i++) {
    corpus.push({ id: `dist-${i}`, vector: unit(rand(DIM, 1.0, i + 500)) });
  }
  const queryVec = unit([1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // Relevant set = all 10 (5 dups + 5 distinct). Recall@5 caps both
  // plain and MMR at 5/10 = 0.5 — MMR's diversification doesn't
  // appear in recall when there are >k relevant docs. To expose MMR's
  // value we ALSO measure subtopic coverage: the 5 dups all share
  // subtopic 'A', each distinct gets its own subtopic 'B'..'F'.
  // Plain top-5 covers 1 subtopic; MMR top-5 covers ~5.
  const relevant = new Set([
    ...Array.from({ length: 5 }, (_, i) => `dup-${i}`),
    ...Array.from({ length: 5 }, (_, i) => `distinct-${i}`),
  ]);
  const subtopics = new Map();
  for (let i = 0; i < 5; i++) subtopics.set(`dup-${i}`, 'A');
  for (let i = 0; i < 5; i++) subtopics.set(`distinct-${i}`, String.fromCharCode(66 + i));
  return { label: 'duplicate-heavy', corpus, queryVec, queryVariants: [queryVec], hypothetical: [queryVec], relevant, subtopics };
}

// --- Topology 3: multi-intent ---
// Query has two intent directions: axis 0 + axis 1. Each has 3
// relevant docs. Plain search with the SUM-of-intents vector picks
// some from each but suboptimally. RRF (with one query per intent)
// recovers all 6 relevant. HyDE-avg lands in between (centroid finds
// the intersection — fewer perfect matches per intent).
function topologyMultiIntent() {
  const corpus = [];
  // Intent A: axis 0
  for (let i = 0; i < 3; i++) {
    const v = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const noise = rand(DIM, 0.02, i + 600);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `intent-a-${i}`, vector: unit(v) });
  }
  // Intent B: axis 1
  for (let i = 0; i < 3; i++) {
    const v = [0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const noise = rand(DIM, 0.02, i + 700);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `intent-b-${i}`, vector: unit(v) });
  }
  // Distractors near the CENTROID (axis 0 + axis 1 mixed) — these
  // beat the single-intent docs on the combined-query vector
  for (let i = 0; i < 5; i++) {
    const v = [0.7, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const noise = rand(DIM, 0.05, i + 800);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `centroid-dist-${i}`, vector: unit(v) });
  }
  // Pure noise
  for (let i = 0; i < 9; i++) {
    corpus.push({ id: `dist-${i}`, vector: unit(rand(DIM, 1.0, i + 900)) });
  }
  // Single combined-intent query vector
  const queryVec = unit([0.7, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // Two intent-specific query variants for RRF
  const queryVariants = [
    unit([1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    unit([0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ];
  return {
    label: 'multi-intent',
    corpus,
    queryVec,
    queryVariants,
    hypothetical: queryVariants,
    relevant: new Set([
      'intent-a-0', 'intent-a-1', 'intent-a-2',
      'intent-b-0', 'intent-b-1', 'intent-b-2',
    ]),
  };
}

// --- Topology 4: question/answer gap ---
// Query lives in "question space" (offset along axis 8) while docs
// live in "answer space" (axis 0). Plain search ranks anything
// that touches axis 8. HyDE's hypothetical answers all live in
// answer space → averaged vector pulls toward axis 0 → finds the
// real docs.
function topologyQAGap() {
  const corpus = [];
  // 5 relevant docs on axis 0 (answer space)
  for (let i = 0; i < 5; i++) {
    const v = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const noise = rand(DIM, 0.02, i + 1000);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `answer-${i}`, vector: unit(v) });
  }
  // 5 distractors that DO touch axis 8 (question-ish space) — these
  // will rank above the real answers under plain search.
  for (let i = 0; i < 5; i++) {
    const v = new Array(DIM).fill(0);
    v[8] = 0.9;
    v[i % 7] = 0.1; // tiny touch elsewhere
    const noise = rand(DIM, 0.02, i + 1100);
    for (let j = 0; j < DIM; j++) v[j] += noise[j];
    corpus.push({ id: `q-space-dist-${i}`, vector: unit(v) });
  }
  // Other distractors
  for (let i = 0; i < 10; i++) {
    corpus.push({ id: `dist-${i}`, vector: unit(rand(DIM, 1.0, i + 1200)) });
  }
  // Question lives in question space (axis 8)
  const queryVec = unit([0, 0, 0, 0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0]);
  // Hypothetical answers all live in answer space (axis 0) — HyDE
  // averages them and lands near the real answer docs.
  const hypothetical = [
    unit([1.0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    unit([1.0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    unit([1.0, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ];
  const queryVariants = [queryVec]; // RRF has no extra variants here
  return {
    label: 'q-a-gap',
    corpus,
    queryVec,
    queryVariants,
    hypothetical,
    relevant: new Set(['answer-0', 'answer-1', 'answer-2', 'answer-3', 'answer-4']),
  };
}

// =========================================================
// Primitive drivers — each takes a topology, returns an ordered
// list of doc IDs (top-K with K large enough for the metrics).
// =========================================================
const K_REPORT = 5;
const K_FETCH = 20; // wide enough for MMR rerank

function runPlain(topo) {
  return plainTopK(topo.corpus, topo.queryVec, K_REPORT).map(h => h.id);
}

function runMmr(topo) {
  const candidates = plainTopK(topo.corpus, topo.queryVec, K_FETCH);
  const picked = mmrRerank(
    candidates.map(c => ({ id: c.id, vector: c.vector })),
    topo.queryVec,
    { k: K_REPORT, lambda: 0.5 },
  );
  return picked.map(p => p.id);
}

function runRrf(topo) {
  const lists = topo.queryVariants.map(q =>
    plainTopK(topo.corpus, q, K_REPORT).map(h => ({ id: h.id })),
  );
  return reciprocalRankFusion(lists, { k: K_REPORT }).map(h => h.id);
}

function runHyde(topo) {
  const avg = averageEmbeddings(topo.hypothetical, { normalizeInputs: true, normalizeOutput: true });
  return plainTopK(topo.corpus, avg, K_REPORT).map(h => h.id);
}

const primitives = {
  plain: runPlain,
  mmr: runMmr,
  rrf: runRrf,
  hyde: runHyde,
};
const topologies = [topologyEasy(), topologyDuplicateHeavy(), topologyMultiIntent(), topologyQAGap()];

// =========================================================
// Run + score
// =========================================================
// Subtopic coverage: fraction of distinct subtopics covered in top-k
// (relative to the total number of subtopics in the relevant set).
// Reveals MMR's diversification when recall@k is saturated.
function subtopicCoverage(hits, subtopics) {
  if (!subtopics) return null;
  const totalSubtopics = new Set(subtopics.values()).size;
  if (totalSubtopics === 0) return 0;
  const seen = new Set();
  for (const id of hits) {
    const s = subtopics.get(id);
    if (s !== undefined) seen.add(s);
  }
  return seen.size / totalSubtopics;
}

const results = {};
for (const topo of topologies) {
  results[topo.label] = {};
  for (const [name, run] of Object.entries(primitives)) {
    const t0 = Date.now();
    const hits = run(topo);
    const ms = Date.now() - t0;
    const recall = recallAtK(hits, topo.relevant, K_REPORT);
    const ndcg = ndcgAtK(hits, topo.relevant, K_REPORT);
    const rr = reciprocalRank(hits, topo.relevant);
    const subCov = subtopicCoverage(hits, topo.subtopics);
    results[topo.label][name] = { recall, ndcg, rr, ms, hits, subCov };
  }
}

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ k: K_REPORT, topologies: topologies.map(t => t.label), results }, null, 2));
} else {
  console.log('=== RAG topology benchmark ===');
  console.log(`Metric @k = ${K_REPORT}`);
  console.log();

  // recall@5 cross-tab
  console.log('### recall@5 (higher is better)');
  console.log();
  const cols = Object.keys(primitives);
  console.log('| topology | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const topo of topologies) {
    const row = cols.map(c => results[topo.label][c].recall.toFixed(3));
    console.log(`| \`${topo.label}\` | ` + row.join(' | ') + ' |');
  }
  console.log();

  // nDCG@5 cross-tab
  console.log('### nDCG@5 (higher is better)');
  console.log();
  console.log('| topology | ' + cols.join(' | ') + ' |');
  console.log('|---|' + cols.map(() => '---:').join('|') + '|');
  for (const topo of topologies) {
    const row = cols.map(c => results[topo.label][c].ndcg.toFixed(3));
    console.log(`| \`${topo.label}\` | ` + row.join(' | ') + ' |');
  }
  console.log();

  // Subtopic coverage (only meaningful for topologies that define subtopics)
  const subTopos = topologies.filter(t => t.subtopics);
  if (subTopos.length > 0) {
    console.log('### Subtopic coverage @5 (diversity — higher means more distinct subtopics in top-k)');
    console.log();
    console.log('| topology | ' + cols.join(' | ') + ' |');
    console.log('|---|' + cols.map(() => '---:').join('|') + '|');
    for (const topo of subTopos) {
      const row = cols.map(c => {
        const v = results[topo.label][c].subCov;
        return v === null ? '—' : v.toFixed(3);
      });
      console.log(`| \`${topo.label}\` | ` + row.join(' | ') + ' |');
    }
    console.log();
  }

  // Winners — show which primitive wins each topology
  console.log('### Winner per topology (by recall@5)');
  console.log();
  for (const topo of topologies) {
    const ranked = cols
      .map(c => ({ c, r: results[topo.label][c].recall }))
      .sort((a, b) => b.r - a.r);
    const best = ranked[0];
    const ties = ranked.filter(x => Math.abs(x.r - best.r) < 1e-9).map(x => x.c).join(', ');
    console.log(`  \`${topo.label}\` → **${ties}** (recall=${best.r.toFixed(3)})`);
  }
  console.log();
}

// =========================================================
// Pass criterion: every (topology, primitive) cell must produce
// a finite metric in [0, 1]. The cross-tab is the value — we
// don't assert a quality ordering because the whole point is to
// SHOW the tradeoffs.
// =========================================================
let ok = true;
for (const topo of topologies) {
  for (const [name, m] of Object.entries(results[topo.label])) {
    for (const k of ['recall', 'ndcg', 'rr']) {
      const v = m[k];
      if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1.000001) {
        console.error(`[FAIL] ${topo.label}/${name}/${k} = ${v} (not in [0, 1])`);
        ok = false;
      }
    }
  }
}
process.exit(ok ? 0 : 1);
