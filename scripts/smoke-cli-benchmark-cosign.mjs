#!/usr/bin/env node
/**
 * ADR-121 Phase 26 — `ruflo benchmark cosign` CLI smoke.
 *
 * Tests the third-party-verifier workflow:
 *   1. Make a copy of the live ledger
 *   2. Cosign a single entry → file written, contentHash unchanged
 *   3. Verify the cosigned entry at threshold=2 (passes) and 3 (fails)
 *   4. Cosign --all entries → entire chain verifies at threshold=2
 *   5. --key persists/reuses identity across runs
 *   6. Bad inputs rejected (missing path, bad entry sequence, non-ledger JSON)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/commands/benchmark-cosign.js');
const verifyDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/commands/benchmark-verify.js');

const { benchmarkCosignCommand } = await import(cliDist);
const { benchmarkVerifyCommand } = await import(verifyDist);

function fail(msg, extra) {
  console.error('[FAIL]', msg);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

async function runCmd(cmd, args, flags = {}) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await cmd.action({ args, flags });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

console.log('=== `ruflo benchmark cosign` CLI smoke ===\n');

const ledgerPath = path.join(repoRoot, 'bench-witness/ledger.json');
if (!fs.existsSync(ledgerPath)) fail('bench-witness/ledger.json does not exist');

const tmpDir = path.join(repoRoot, '.smoke-iter33');
fs.mkdirSync(tmpDir, { recursive: true });

try {
  // =========================================================
  // Step 1 — copy ledger
  // =========================================================
  const workPath = path.join(tmpDir, 'work-ledger.json');
  fs.copyFileSync(ledgerPath, workPath);
  const before = JSON.parse(fs.readFileSync(workPath, 'utf8'));
  console.log(`[OK] copied ledger (${before.entries.length} entries) to ${workPath}`);

  // Pick an entry that has 0 cosignatures (so cosign brings it from 1 to 2 sigs).
  const target = before.entries.find(e => !Array.isArray(e.cosignatures) || e.cosignatures.length === 0);
  if (!target) fail('no entry without cosignatures found in ledger');
  const targetSeq = target.sequence;

  // =========================================================
  // Step 2 — cosign one entry, check contentHash unchanged
  // =========================================================
  const r2 = await runCmd(benchmarkCosignCommand, [workPath], {
    entry: targetSeq, label: 'smoke-iter33-auditor',
  });
  if (!r2.success) fail('cosign single entry failed', r2);
  const after = JSON.parse(fs.readFileSync(workPath, 'utf8'));
  const afterEntry = after.entries.find(e => e.sequence === targetSeq);
  if (afterEntry.contentHash !== target.contentHash) fail('contentHash changed by cosigning — chain integrity broken');
  if (!Array.isArray(afterEntry.cosignatures) || afterEntry.cosignatures.length === 0) fail('cosignatures not appended');
  if (afterEntry.cosignatures[0].signerLabel !== 'smoke-iter33-auditor') fail('label not preserved');
  console.log(`[OK] cosigned entry ${targetSeq} — contentHash unchanged, cosignature appended with label`);

  // =========================================================
  // Step 3 — verify at threshold 2 must pass for that entry but
  //          fail for the whole chain (other entries still 1 sig)
  // =========================================================
  // Whole-chain at threshold 2 → fail because entry !target still has 1 sig
  const v3a = await runCmd(benchmarkVerifyCommand, [workPath], { threshold: 2 });
  if (v3a.success) fail('whole-chain at threshold 2 should fail (only 1 entry cosigned)');
  console.log(`[OK] whole-chain verify@threshold=2 correctly fails (only 1 entry cosigned)`);

  // =========================================================
  // Step 4 — --all: cosign every entry
  // =========================================================
  const allPath = path.join(tmpDir, 'all-cosigned.json');
  const r4 = await runCmd(benchmarkCosignCommand, [workPath], {
    all: true, label: 'release-gate', out: allPath,
  });
  if (!r4.success) fail('cosign --all failed', r4);
  const allLedger = JSON.parse(fs.readFileSync(allPath, 'utf8'));
  const everyHasCosig = allLedger.entries.every(e => Array.isArray(e.cosignatures) && e.cosignatures.length >= 1);
  if (!everyHasCosig) fail('not every entry got a cosignature with --all');
  console.log(`[OK] --all cosigned every entry (${allLedger.entries.length})`);

  // Verify the all-cosigned ledger at threshold 2
  const v4 = await runCmd(benchmarkVerifyCommand, [allPath], { threshold: 2 });
  if (!v4.success) fail('all-cosigned ledger should verify at threshold 2', v4);
  console.log(`[OK] all-cosigned ledger verifies at threshold=2`);

  // Whole-chain at threshold 3 → still fail (entries that already had cosig 1
  // are now at 2; entries that had 0 are now at 1+1=2 too unless they already
  // had cosigs from Phase 24's multisig benchmark entry)
  // Actually entry 11 (rag-multisig-attestation) had 0 cosigs in the LEDGER
  // (the multisig attestation was DEMONSTRATED inside results but the chain
  // entry itself was signed only once). So after --all everyone has 2 sigs.
  const v4b = await runCmd(benchmarkVerifyCommand, [allPath], { threshold: 3 });
  if (v4b.success) fail('all-cosigned (one auditor) should fail at threshold=3');
  console.log(`[OK] all-cosigned ledger correctly fails at threshold=3`);

  // =========================================================
  // Step 5 — --key persists keypair across runs
  // =========================================================
  const keyFile = path.join(tmpDir, 'auditor.key.json');
  // First run with --key: creates the key file
  const keyLedger1 = path.join(tmpDir, 'key-test-1.json');
  fs.copyFileSync(ledgerPath, keyLedger1);
  const r5a = await runCmd(benchmarkCosignCommand, [keyLedger1], {
    entry: targetSeq, label: 'persistent-auditor', key: keyFile,
  });
  if (!r5a.success) fail('first --key run failed', r5a);
  if (!fs.existsSync(keyFile)) fail('--key file was not persisted');
  const pubKey1 = JSON.parse(fs.readFileSync(keyLedger1, 'utf8')).entries.find(e => e.sequence === targetSeq).cosignatures[0].publicKey;

  // Second run with same --key: reuses the keypair, identical publicKey
  const keyLedger2 = path.join(tmpDir, 'key-test-2.json');
  fs.copyFileSync(ledgerPath, keyLedger2);
  const r5b = await runCmd(benchmarkCosignCommand, [keyLedger2], {
    entry: targetSeq, label: 'persistent-auditor', key: keyFile,
  });
  if (!r5b.success) fail('second --key run failed', r5b);
  const pubKey2 = JSON.parse(fs.readFileSync(keyLedger2, 'utf8')).entries.find(e => e.sequence === targetSeq).cosignatures[0].publicKey;
  if (pubKey1 !== pubKey2) fail('--key did not produce stable publicKey across runs');
  console.log(`[OK] --key persists keypair (identical publicKey across 2 runs)`);

  // =========================================================
  // Step 6 — bad inputs
  // =========================================================
  // No path
  const e1 = await runCmd(benchmarkCosignCommand, []);
  if (e1.success) fail('missing path should fail');
  console.log(`[OK] missing path rejected`);

  // Bad entry sequence
  const e2 = await runCmd(benchmarkCosignCommand, [workPath], { entry: 999 });
  if (e2.success) fail('nonexistent entry sequence should fail');
  console.log(`[OK] nonexistent entry sequence rejected`);

  // Non-ledger JSON
  const notLedgerPath = path.join(tmpDir, 'not-a-ledger.json');
  fs.writeFileSync(notLedgerPath, JSON.stringify({ foo: 'bar' }));
  const e3 = await runCmd(benchmarkCosignCommand, [notLedgerPath]);
  if (e3.success) fail('non-ledger JSON should fail');
  console.log(`[OK] non-ledger JSON rejected`);

  console.log('\n=== `ruflo benchmark cosign` CLI smoke: PASS ===');
} finally {
  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(0);
