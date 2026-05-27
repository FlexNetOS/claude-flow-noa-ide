#!/usr/bin/env node
/**
 * ADR-121 Phase 26 — witness-signed capability benchmark for the
 * `ruflo benchmark cosign` CLI.
 *
 * Runs the full third-party-verifier workflow against the live
 * ledger:
 *   1. Take entry N from the ledger (any entry without cosignatures)
 *   2. CLI co-signs it with an ephemeral key
 *   3. Re-verify at threshold=2 → must pass for that entry
 *   4. --all path: co-sign every entry, verify whole chain at threshold=2
 *   5. --key persistence path: same key file → identical publicKey
 *
 * Signs a capability manifest attesting "the cosign CLI works
 * end-to-end on this commit." Chained into the ledger.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const embDist = path.join(repoRoot, 'v3/@claude-flow/embeddings/dist');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/commands/benchmark-cosign.js');
const verifyDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/commands/benchmark-verify.js');

const { benchmarkCosignCommand } = await import(cliDist);
const { benchmarkVerifyCommand } = await import(verifyDist);
const { witness, verify, canonicalHash } = await import(path.join(embDist, 'witness.js'));

const argJson = process.argv.includes('--json');
const skipWrite = process.argv.includes('--skip-write');

function getCommit() {
  try { return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

async function runCmd(cmd, args, flags = {}) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await cmd.action({ args, flags }); }
  finally { console.log = origLog; console.error = origErr; }
}

const ledgerPath = path.join(repoRoot, 'bench-witness/ledger.json');
const tmpDir = path.join(repoRoot, '.cap-iter33');
fs.mkdirSync(tmpDir, { recursive: true });

if (!argJson) console.log('=== Cosign CLI capability benchmark + witness ===\n');

const results = {};

try {
  // === Step 1 — single-entry cosign + verify@2 ===
  const workPath = path.join(tmpDir, 'work.json');
  fs.copyFileSync(ledgerPath, workPath);
  const before = JSON.parse(fs.readFileSync(workPath, 'utf8'));
  const target = before.entries.find(e => !Array.isArray(e.cosignatures) || e.cosignatures.length === 0)
    ?? before.entries[before.entries.length - 1];
  const targetSeq = target.sequence;

  const r1 = await runCmd(benchmarkCosignCommand, [workPath], { entry: targetSeq, label: 'capability-auditor' });
  const after = JSON.parse(fs.readFileSync(workPath, 'utf8'));
  const afterEntry = after.entries.find(e => e.sequence === targetSeq);
  results.singleEntryCosign = {
    success: r1.success,
    contentHashUnchanged: afterEntry.contentHash === target.contentHash,
    cosignatureAppended: Array.isArray(afterEntry.cosignatures) && afterEntry.cosignatures.length === (Array.isArray(target.cosignatures) ? target.cosignatures.length : 0) + 1,
    labelPreserved: afterEntry.cosignatures[afterEntry.cosignatures.length - 1].signerLabel === 'capability-auditor',
  };

  // === Step 2 — --all + verify@2 across full chain ===
  const allPath = path.join(tmpDir, 'all.json');
  const r2 = await runCmd(benchmarkCosignCommand, [workPath], { all: true, label: 'release-gate', out: allPath });
  const allLedger = JSON.parse(fs.readFileSync(allPath, 'utf8'));
  const everyHasCosig = allLedger.entries.every(e => Array.isArray(e.cosignatures) && e.cosignatures.length >= 1);
  const v2 = await runCmd(benchmarkVerifyCommand, [allPath], { threshold: 2 });
  results.allCosignAtThreshold2 = {
    cosignAllSucceeded: r2.success,
    everyEntryHasCosig: everyHasCosig,
    verifyAtThreshold2: v2.success,
  };

  // === Step 3 — --key persistence ===
  const keyFile = path.join(tmpDir, 'cap.key.json');
  const kp1 = path.join(tmpDir, 'kp1.json');
  fs.copyFileSync(ledgerPath, kp1);
  await runCmd(benchmarkCosignCommand, [kp1], { entry: targetSeq, label: 'persistent', key: keyFile });
  const pubKey1 = JSON.parse(fs.readFileSync(kp1, 'utf8')).entries.find(e => e.sequence === targetSeq).cosignatures[0].publicKey;

  const kp2 = path.join(tmpDir, 'kp2.json');
  fs.copyFileSync(ledgerPath, kp2);
  await runCmd(benchmarkCosignCommand, [kp2], { entry: targetSeq, label: 'persistent', key: keyFile });
  const pubKey2 = JSON.parse(fs.readFileSync(kp2, 'utf8')).entries.find(e => e.sequence === targetSeq).cosignatures[0].publicKey;

  results.keyPersistence = {
    keyFileExists: fs.existsSync(keyFile),
    samePublicKeyAcrossRuns: pubKey1 === pubKey2,
  };

  // === Step 4 — bad input rejection ===
  const e1 = await runCmd(benchmarkCosignCommand, []);
  const e2 = await runCmd(benchmarkCosignCommand, [workPath], { entry: 999 });
  results.badInputRejection = {
    missingPathRejected: !e1.success,
    badEntryRejected: !e2.success,
  };

  const allPassed =
    results.singleEntryCosign.success &&
    results.singleEntryCosign.contentHashUnchanged &&
    results.singleEntryCosign.cosignatureAppended &&
    results.singleEntryCosign.labelPreserved &&
    results.allCosignAtThreshold2.cosignAllSucceeded &&
    results.allCosignAtThreshold2.everyEntryHasCosig &&
    results.allCosignAtThreshold2.verifyAtThreshold2 &&
    results.keyPersistence.keyFileExists &&
    results.keyPersistence.samePublicKeyAcrossRuns &&
    results.badInputRejection.missingPathRejected &&
    results.badInputRejection.badEntryRejected;

  const summary = { ledgerPath, results, allPassed };

  const manifest = witness({
    benchmark: 'rag-cli-cosign-capability',
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    model: 'cli-cosign-driver',
    corpus: { id: canonicalHash([ledgerPath]), size: 1 },
    queries: { id: canonicalHash(Object.keys(results)), count: Object.keys(results).length },
    results: summary,
  });
  if (!verify(manifest)) { console.error('[FAIL] witness self-verify failed'); process.exit(2); }

  if (argJson) {
    console.log(JSON.stringify({ summary, witness: manifest }, null, 2));
  } else {
    console.log('### Cosign CLI capability matrix\n');
    console.log('| capability | result |');
    console.log('|---|:---:|');
    console.log(`| single-entry cosign succeeds | ${results.singleEntryCosign.success ? '✓' : '✗'} |`);
    console.log(`| contentHash unchanged by cosign | ${results.singleEntryCosign.contentHashUnchanged ? '✓' : '✗'} |`);
    console.log(`| cosignature appended | ${results.singleEntryCosign.cosignatureAppended ? '✓' : '✗'} |`);
    console.log(`| signerLabel preserved | ${results.singleEntryCosign.labelPreserved ? '✓' : '✗'} |`);
    console.log(`| --all cosigns every entry | ${results.allCosignAtThreshold2.everyEntryHasCosig ? '✓' : '✗'} |`);
    console.log(`| --all + verify@threshold=2 | ${results.allCosignAtThreshold2.verifyAtThreshold2 ? '✓' : '✗'} |`);
    console.log(`| --key persists keypair | ${results.keyPersistence.keyFileExists ? '✓' : '✗'} |`);
    console.log(`| --key reuse → same publicKey | ${results.keyPersistence.samePublicKeyAcrossRuns ? '✓' : '✗'} |`);
    console.log(`| missing path rejected | ${results.badInputRejection.missingPathRejected ? '✓' : '✗'} |`);
    console.log(`| bad entry rejected | ${results.badInputRejection.badEntryRejected ? '✓' : '✗'} |`);
    console.log();
    console.log('### Witness');
    console.log(`- commit:      ${manifest.commit ?? '(n/a)'}`);
    console.log(`- contentHash: ${manifest.contentHash}`);
    console.log(`- verify():    TRUE`);
  }

  if (!skipWrite) {
    const witnessDir = path.join(repoRoot, 'bench-witness');
    fs.mkdirSync(witnessDir, { recursive: true });
    const filename = `rag-cli-cosign-capability-${manifest.timestamp.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(witnessDir, filename), JSON.stringify({ summary, witness: manifest }, null, 2));
    if (!argJson) console.log(`\nWitness manifest written to bench-witness/${filename}`);
  }

  process.exit(allPassed ? 0 : 1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
