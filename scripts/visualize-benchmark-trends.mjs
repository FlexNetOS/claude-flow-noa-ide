#!/usr/bin/env node
/**
 * ADR-121 Phase 23 — Benchmark trend visualization + drift detection.
 *
 * Reads the chained witness ledger from bench-witness/ledger.json
 * and renders an ASCII trend dashboard. For each tracked metric:
 *   - Sparkline of the metric's history (chain-ordered)
 *   - Drift verdict comparing the earliest-window mean to the
 *     latest-window mean (catches "death by a thousand cuts" where
 *     every single-step delta passes the per-step threshold but
 *     cumulative drift is large)
 *
 * Composable with Phase 22's check-benchmark-regression.mjs:
 *   - regression check: single-step deltas
 *   - drift check: rolling-window cumulative trends
 *
 * Both run in CI; both signed; both chained.
 *
 * Run:
 *   node scripts/visualize-benchmark-trends.mjs
 *   node scripts/visualize-benchmark-trends.mjs --json
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');

const { getMetricAtPath } = await import(path.join(embDist, 'ledger-analyzer.js'));
const { renderSparkline, detectDrift, summarizeBenchmarkTrend } = await import(path.join(embDist, 'ledger-trends.js'));
const { witness, verify, canonicalHash } = await import(path.join(embDist, 'witness.js'));

const argJson = process.argv.includes('--json');
const skipWrite = process.argv.includes('--skip-write');

const witnessDir = path.join(repoRoot, 'bench-witness');
const ledgerPath = path.join(witnessDir, 'ledger.json');

if (!fs.existsSync(ledgerPath)) {
  console.error('[FAIL] bench-witness/ledger.json does not exist — run scripts/build-benchmark-ledger.mjs first');
  process.exit(1);
}
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

// Same tracked metrics as Phase 22's regression check.
const TRACKED = [
  { benchmark: 'rag-real-text',         metricPath: 'results.results.compound.recallAt5',     direction: 'higher' },
  { benchmark: 'rag-real-text',         metricPath: 'results.results.hyde.recallAt5',         direction: 'higher' },
  { benchmark: 'rag-adaptive-router',   metricPath: 'results.results.accuracy',               direction: 'higher' },
  { benchmark: 'rag-router-ablation',   metricPath: 'results.results.adaptive.meanRecallAt5', direction: 'higher' },
  { benchmark: 'rag-lazy-router',       metricPath: 'results.results.embedsSavedPercent',     direction: 'higher' },
  { benchmark: 'rag-cached-router',     metricPath: 'results.results.cacheStats.hitRate',     direction: 'higher' },
  { benchmark: 'rag-cached-router',     metricPath: 'results.results.embedsSavedPercent',     direction: 'higher' },
];

// Build per-metric history from the chain.
function valuesForMetric(benchmark, metricPath) {
  const entries = ledger.entries.filter(e => e.benchmark === benchmark);
  return entries
    .map(e => getMetricAtPath(e, metricPath))
    .filter(v => typeof v === 'number' && Number.isFinite(v));
}

const trends = TRACKED.map(t => {
  const values = valuesForMetric(t.benchmark, t.metricPath);
  const summary = summarizeBenchmarkTrend(values, t.benchmark, t.metricPath, {
    direction: t.direction,
    windowSize: 2, // small windows because chain is still short
    threshold: 0.15,
  });
  return { ...summary, direction: t.direction };
});

const drifts = trends.filter(t => !t.drift.skipped);
const failures = drifts.filter(t => !t.drift.passed);

// =========================================================
// Witness
// =========================================================
function getCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const summary = {
  trackedCount: TRACKED.length,
  withDataCount: drifts.length,
  skippedCount: trends.length - drifts.length,
  driftFailures: failures.length,
  allPassed: failures.length === 0,
  trends: trends.map(t => ({
    benchmark: t.benchmark,
    metricPath: t.metricPath,
    direction: t.direction,
    sparkline: t.sparkline,
    sampleCount: t.sampleCount,
    latestValue: t.latestValue,
    drift: {
      earlyMean: t.drift.earlyMean,
      lateMean: t.drift.lateMean,
      drift: t.drift.drift,
      passed: t.drift.passed,
      skipped: t.drift.skipped,
    },
  })),
};

const manifest = witness({
  benchmark: 'rag-trend-visualization',
  timestamp: new Date().toISOString(),
  commit: getCommit(),
  model: 'ledger-derived',
  corpus: { id: canonicalHash(TRACKED), size: TRACKED.length },
  queries: { id: canonicalHash(ledger.entries.map(e => e.contentHash)), count: ledger.entries.length },
  results: summary,
});
if (!verify(manifest)) { console.error('[FAIL] witness self-verify failed'); process.exit(2); }

// =========================================================
// Report
// =========================================================
if (argJson) {
  console.log(JSON.stringify({ summary, witness: manifest }, null, 2));
} else {
  console.log('=== Benchmark trend dashboard ===\n');
  console.log(`Ledger entries:    ${ledger.entries.length}`);
  console.log(`Tracked metrics:   ${TRACKED.length}`);
  console.log(`With data:         ${drifts.length}`);
  console.log(`Drift failures:    ${failures.length}\n`);

  console.log('### Trends\n');
  console.log('| benchmark | metric | n | latest | sparkline | drift | verdict |');
  console.log('|---|---|---:|---:|:---:|---:|:---:|');
  for (const t of trends) {
    const latestStr = t.latestValue !== null ? t.latestValue.toFixed(4) : '—';
    const driftStr = t.drift.skipped
      ? '—'
      : `${t.drift.drift >= 0 ? '+' : ''}${(t.drift.drift * 100).toFixed(1)}%`;
    const verdict = t.drift.skipped ? '·' : (t.drift.passed ? '✓' : '✗ DRIFT');
    const spark = t.sparkline === '' ? '—' : `\`${t.sparkline}\``;
    const metricShort = t.metricPath.replace(/^results\.results\./, '');
    console.log(`| \`${t.benchmark}\` | \`${metricShort}\` | ${t.sampleCount} | ${latestStr} | ${spark} | ${driftStr} | ${verdict} |`);
  }
  console.log();

  if (failures.length > 0) {
    console.log('### Drift failures\n');
    for (const f of failures) {
      console.log(`- \`${f.benchmark}\` / \`${f.metricPath}\` — ${f.drift.reason}`);
    }
    console.log();
  }

  console.log('### Witness');
  console.log(`- commit:      ${manifest.commit ?? '(n/a)'}`);
  console.log(`- contentHash: ${manifest.contentHash}`);
  console.log(`- signature:   ${manifest.signature.slice(0, 32)}...`);
  console.log(`- verify():    TRUE`);
}

if (!skipWrite) {
  fs.mkdirSync(witnessDir, { recursive: true });
  const filename = `rag-trend-visualization-${manifest.timestamp.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(witnessDir, filename), JSON.stringify({ summary, witness: manifest }, null, 2));
  if (!argJson) console.log(`\nTrend report written to bench-witness/${filename}`);
}

process.exit(summary.allPassed ? 0 : 1);
