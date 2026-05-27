/**
 * ADR-121 Phase 25 — `ruflo benchmark verify` CLI subcommand.
 *
 * Makes the Phase 15-24 witness story end-user-accessible. Anyone
 * publishing benchmark numbers with a witness manifest (single
 * `.json`) or a chained ledger (`bench-witness/ledger.json`) can
 * tell consumers:
 *
 *   npx ruflo benchmark verify ./ledger.json
 *
 * The command auto-detects whether the input is a single witness or
 * a ledger (presence of `version` + `entries[]` → ledger), runs the
 * appropriate verifier, and prints a human-readable or JSON report.
 *
 * For Phase 24 multi-signer entries, pass `--threshold N` to require
 * N or more valid signatures per entry.
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

interface WitnessManifestShape {
  benchmark: string;
  contentHash: string;
  signature: string;
  publicKey: string;
  signatureAlgorithm: string;
  // ... other fields
}

interface BenchmarkLedgerShape {
  version: number;
  entries: ReadonlyArray<unknown>;
}

interface FileShape {
  witness?: WitnessManifestShape;        // wrapper shape from bench scripts
  version?: number;                       // raw-ledger shape
  entries?: ReadonlyArray<unknown>;       // raw-ledger shape
  contentHash?: string;                   // raw-witness shape (top-level fields)
  signature?: string;
}

function isLedger(parsed: FileShape): parsed is BenchmarkLedgerShape {
  return typeof parsed.version === 'number' && Array.isArray(parsed.entries);
}
function isWrappedWitness(parsed: FileShape): boolean {
  return parsed.witness !== undefined && typeof parsed.witness === 'object';
}
function isRawWitness(parsed: FileShape): boolean {
  return typeof parsed.contentHash === 'string' && typeof parsed.signature === 'string';
}

export const benchmarkVerifyCommand: Command = {
  name: 'verify',
  description: 'Verify a benchmark witness manifest or chained ledger via the published @claude-flow/embeddings cryptographic primitives',
  options: [
    {
      name: 'threshold',
      short: 't',
      type: 'number',
      description: 'Phase 24 M-of-N: minimum signatures required per entry. Default 1.',
      default: '1',
    },
    {
      name: 'json',
      type: 'boolean',
      description: 'Output JSON instead of human-readable',
      default: 'false',
    },
  ],
  examples: [
    { command: 'ruflo benchmark verify ./bench-witness/ledger.json', description: 'Verify a chained ledger' },
    { command: 'ruflo benchmark verify ./bench-witness/rag-real-text-*.json', description: 'Verify a single witness manifest' },
    { command: 'ruflo benchmark verify ledger.json --threshold 3', description: 'Require ≥3 signatures per entry (M-of-N)' },
    { command: 'ruflo benchmark verify ledger.json --json', description: 'Machine-readable output for CI gating' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const pathArg = ctx.args[0];
    const threshold = Number(ctx.flags.threshold ?? 1);
    const asJson = ctx.flags.json === true || ctx.flags.json === 'true';

    if (!pathArg || typeof pathArg !== 'string') {
      const err = 'usage: ruflo benchmark verify <path-to-ledger.json-or-witness.json> [--threshold N] [--json]';
      if (asJson) output.printJson({ ok: false, error: err });
      else output.printError(err);
      return { success: false, exitCode: 1 };
    }
    if (!Number.isFinite(threshold) || threshold < 1) {
      const err = `--threshold must be a positive integer, got: ${ctx.flags.threshold}`;
      if (asJson) output.printJson({ ok: false, error: err });
      else output.printError(err);
      return { success: false, exitCode: 1 };
    }

    const absPath = resolve(process.cwd(), pathArg);

    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (asJson) output.printJson({ ok: false, error: `cannot read ${absPath}: ${msg}` });
      else output.printError(`Cannot read ${absPath}: ${msg}`);
      return { success: false, exitCode: 1 };
    }

    let parsed: FileShape;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (asJson) output.printJson({ ok: false, error: `not valid JSON: ${msg}` });
      else output.printError(`Not valid JSON: ${msg}`);
      return { success: false, exitCode: 1 };
    }

    // Lazy-import the embeddings verifiers so the CLI startup stays fast
    // when this command isn't used.
    const { verify } = await import('@claude-flow/embeddings/witness');
    const { verifyLedger, verifyEntry } = await import('@claude-flow/embeddings/witness-ledger');

    // === Path 1: chained ledger ===
    if (isLedger(parsed)) {
      const ledger = parsed;
      const result = verifyLedger(ledger as never, { minSignatures: threshold });
      if (asJson) {
        output.printJson({
          ok: result.valid,
          kind: 'ledger',
          entryCount: result.entryCount,
          firstFailureAt: result.firstFailureAt,
          reason: result.reason,
          threshold,
          path: absPath,
        });
        return { success: result.valid, exitCode: result.valid ? 0 : 1 };
      }
      output.writeln();
      output.writeln(output.bold(`Ledger verification (${absPath})`));
      output.writeln(output.dim('─'.repeat(60)));
      output.writeln(`  entries:        ${result.entryCount}`);
      output.writeln(`  threshold:      minSignatures = ${threshold}`);
      output.writeln(`  verifyLedger(): ${result.valid ? output.success('TRUE') : output.error('FALSE')}`);
      if (!result.valid) {
        output.writeln(`  failure at:     entry ${result.firstFailureAt}`);
        output.writeln(`  reason:         ${result.reason}`);
      }
      // Per-entry summary table
      const entries = (ledger.entries as Array<{ sequence: number; benchmark: string; contentHash: string; cosignatures?: unknown[] }>);
      output.writeln();
      output.writeln('  per-entry:');
      for (const e of entries) {
        const cosigCount = Array.isArray(e.cosignatures) ? e.cosignatures.length : 0;
        const ok = verifyEntry(e as never, { minSignatures: threshold });
        const verdict = ok ? output.success('✓') : output.error('✗');
        const hashShort = e.contentHash.slice(0, 12) + '…';
        output.writeln(`    [${String(e.sequence).padStart(2)}] ${e.benchmark.padEnd(28)} sigs=${1 + cosigCount}  ${hashShort}  ${verdict}`);
      }
      output.writeln();
      return { success: result.valid, exitCode: result.valid ? 0 : 1 };
    }

    // === Path 2: wrapped single witness (the bench scripts' output shape) ===
    if (isWrappedWitness(parsed)) {
      const w = parsed.witness!;
      const ok = verify(w as never);
      if (asJson) {
        output.printJson({
          ok,
          kind: 'witness',
          benchmark: w.benchmark,
          contentHash: w.contentHash,
          path: absPath,
        });
        return { success: ok, exitCode: ok ? 0 : 1 };
      }
      output.writeln();
      output.writeln(output.bold(`Witness verification (${absPath})`));
      output.writeln(output.dim('─'.repeat(60)));
      output.writeln(`  benchmark:    ${w.benchmark}`);
      output.writeln(`  contentHash:  ${w.contentHash}`);
      output.writeln(`  signature:    ${w.signature.slice(0, 32)}...`);
      output.writeln(`  publicKey:    ${w.publicKey.slice(0, 32)}...`);
      output.writeln(`  algorithm:    ${w.signatureAlgorithm}`);
      output.writeln(`  verify():     ${ok ? output.success('TRUE') : output.error('FALSE')}`);
      output.writeln();
      return { success: ok, exitCode: ok ? 0 : 1 };
    }

    // === Path 3: raw single witness (top-level fields, no wrapper) ===
    if (isRawWitness(parsed)) {
      const w = parsed as unknown as WitnessManifestShape;
      const ok = verify(w as never);
      if (asJson) {
        output.printJson({
          ok,
          kind: 'witness-raw',
          benchmark: w.benchmark,
          contentHash: w.contentHash,
          path: absPath,
        });
        return { success: ok, exitCode: ok ? 0 : 1 };
      }
      output.writeln();
      output.writeln(output.bold(`Witness verification (${absPath})`));
      output.writeln(output.dim('─'.repeat(60)));
      output.writeln(`  benchmark:    ${w.benchmark}`);
      output.writeln(`  contentHash:  ${w.contentHash}`);
      output.writeln(`  verify():     ${ok ? output.success('TRUE') : output.error('FALSE')}`);
      output.writeln();
      return { success: ok, exitCode: ok ? 0 : 1 };
    }

    // === Path 4: unknown shape ===
    const err = `unrecognized file shape — expected a benchmark ledger ({version, entries}), a wrapped witness ({witness: {...}}), or a raw witness ({contentHash, signature, publicKey})`;
    if (asJson) output.printJson({ ok: false, error: err, path: absPath });
    else output.printError(err);
    return { success: false, exitCode: 1 };
  },
};

export default benchmarkVerifyCommand;
