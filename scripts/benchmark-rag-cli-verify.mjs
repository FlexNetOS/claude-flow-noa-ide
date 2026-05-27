#!/usr/bin/env node
/**
 * ADR-121 Phase 25 — witness the CLI verify capability itself.
 *
 * Drives `ruflo benchmark verify` against the live ledger + a single
 * witness manifest, captures the verification results, signs a
 * benchmark entry attesting "the CLI verify command works end-to-end
 * on this commit." Chained into the ledger.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/commands/benchmark-verify.js');

const { benchmarkVerifyCommand } = await import(cliDist);
const { witness, verify, canonicalHash } = await import(path.join(embDist, 'witness.js'));

const argJson = process.argv.includes('--json');
const skipWrite = process.argv.includes('--skip-write');

function getCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

async function runVerify(args, flags = {}) {
  // Silence console.log during the command so we can capture cleanly
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await benchmarkVerifyCommand.action({ args, flags });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const ledgerPath = path.join(repoRoot, 'bench-witness/ledger.json');
const witnessFiles = fs.existsSync(path.join(repoRoot, 'bench-witness'))
  ? fs.readdirSync(path.join(repoRoot, 'bench-witness')).filter(f => f.startsWith('rag-real-text-') && f.endsWith('.json'))
  : [];
const sampleWitnessPath = witnessFiles[0]
  ? path.join(repoRoot, 'bench-witness', witnessFiles[0])
  : null;

if (!argJson) {
  console.log('=== `ruflo benchmark verify` capability benchmark + witness ===\n');
}

const results = {
  ledgerVerifyDefault: null,
  ledgerVerifyThreshold1: null,
  ledgerVerifyThreshold2Expected: null,
  singleWitnessVerify: null,
  missingPathRejected: null,
  badThresholdRejected: null,
};

// 1. ledger verify (default)
{
  const r = await runVerify([ledgerPath]);
  results.ledgerVerifyDefault = { passed: r.success, exitCode: r.exitCode };
}

// 2. ledger verify (threshold=1)
{
  const r = await runVerify([ledgerPath], { threshold: 1 });
  results.ledgerVerifyThreshold1 = { passed: r.success, exitCode: r.exitCode };
}

// 3. ledger verify (threshold=2) — expected to FAIL
{
  const r = await runVerify([ledgerPath], { threshold: 2 });
  results.ledgerVerifyThreshold2Expected = { failedAsExpected: !r.success, exitCode: r.exitCode };
}

// 4. single witness verify
if (sampleWitnessPath) {
  const r = await runVerify([sampleWitnessPath]);
  results.singleWitnessVerify = { passed: r.success, exitCode: r.exitCode };
}

// 5. missing path — must be rejected
{
  const r = await runVerify([]);
  results.missingPathRejected = { rejected: !r.success, exitCode: r.exitCode };
}

// 6. bad threshold — must be rejected
{
  const r = await runVerify([ledgerPath], { threshold: 0 });
  results.badThresholdRejected = { rejected: !r.success, exitCode: r.exitCode };
}

const allPassed =
  results.ledgerVerifyDefault?.passed &&
  results.ledgerVerifyThreshold1?.passed &&
  results.ledgerVerifyThreshold2Expected?.failedAsExpected &&
  (sampleWitnessPath ? results.singleWitnessVerify?.passed : true) &&
  results.missingPathRejected?.rejected &&
  results.badThresholdRejected?.rejected;

const summary = {
  ledgerPath,
  sampleWitnessPath,
  ledgerEntryCount: fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries.length : 0,
  results,
  allPassed,
};

const manifest = witness({
  benchmark: 'rag-cli-verify-capability',
  timestamp: new Date().toISOString(),
  commit: getCommit(),
  model: 'cli-verify-driver',
  corpus: { id: canonicalHash([ledgerPath, sampleWitnessPath]), size: 2 },
  queries: { id: canonicalHash(Object.keys(results)), count: Object.keys(results).length },
  results: summary,
});
if (!verify(manifest)) { console.error('[FAIL] witness self-verify failed'); process.exit(2); }

if (argJson) {
  console.log(JSON.stringify({ summary, witness: manifest }, null, 2));
} else {
  console.log('### CLI verify capability matrix\n');
  console.log('| scenario | expected | got | verdict |');
  console.log('|---|---|---|:---:|');
  console.log(`| ledger verify (default threshold) | pass | ${results.ledgerVerifyDefault?.passed ? 'pass' : 'fail'} | ${results.ledgerVerifyDefault?.passed ? '✓' : '✗'} |`);
  console.log(`| ledger verify (threshold=1) | pass | ${results.ledgerVerifyThreshold1?.passed ? 'pass' : 'fail'} | ${results.ledgerVerifyThreshold1?.passed ? '✓' : '✗'} |`);
  console.log(`| ledger verify (threshold=2) | fail | ${results.ledgerVerifyThreshold2Expected?.failedAsExpected ? 'fail' : 'pass'} | ${results.ledgerVerifyThreshold2Expected?.failedAsExpected ? '✓' : '✗'} |`);
  console.log(`| single wrapped witness verify | pass | ${results.singleWitnessVerify?.passed ? 'pass' : 'fail'} | ${results.singleWitnessVerify?.passed ? '✓' : '✗'} |`);
  console.log(`| missing path rejected | fail | ${results.missingPathRejected?.rejected ? 'fail' : 'pass'} | ${results.missingPathRejected?.rejected ? '✓' : '✗'} |`);
  console.log(`| bad threshold rejected | fail | ${results.badThresholdRejected?.rejected ? 'fail' : 'pass'} | ${results.badThresholdRejected?.rejected ? '✓' : '✗'} |`);
  console.log();
  console.log('### Witness');
  console.log(`- commit:      ${manifest.commit ?? '(n/a)'}`);
  console.log(`- contentHash: ${manifest.contentHash}`);
  console.log(`- verify():    TRUE`);
}

if (!skipWrite) {
  const witnessDir = path.join(repoRoot, 'bench-witness');
  fs.mkdirSync(witnessDir, { recursive: true });
  const filename = `rag-cli-verify-capability-${manifest.timestamp.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(witnessDir, filename), JSON.stringify({ summary, witness: manifest }, null, 2));
  if (!argJson) console.log(`\nWitness manifest written to bench-witness/${filename}`);
}

process.exit(allPassed ? 0 : 1);
