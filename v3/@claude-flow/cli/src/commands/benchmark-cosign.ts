/**
 * ADR-121 Phase 26 — `ruflo benchmark cosign` CLI subcommand.
 *
 * Phase 24 shipped the M-of-N cryptographic primitive (`coSign()`).
 * Phase 25 shipped the consumer-facing verify command. This phase
 * closes the loop with the **third-party-verifier workflow**:
 *
 *   # vendor publishes ledger.json + a benchmark claim
 *   # third party reviews + co-signs
 *   npx ruflo benchmark cosign vendor-ledger.json \
 *       --entry 11 \
 *       --label "independent-auditor" \
 *       --out audited-ledger.json
 *
 *   # downstream consumers check the audited ledger requires
 *   # two signatures per entry
 *   npx ruflo benchmark verify audited-ledger.json --threshold 2
 *
 * Auto-generates an ephemeral Ed25519 keypair (writes the public
 * key alongside the cosignature in the output ledger; private key
 * not persisted by default). Pass `--key <path>` to persist the
 * keypair (or read from a previously-persisted file) so the same
 * signer can attest multiple entries / multiple ledgers with a
 * stable identity.
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

interface BenchmarkLedgerShape {
  version: number;
  entries: Array<{
    sequence: number;
    benchmark: string;
    contentHash: string;
    cosignatures?: unknown[];
    [k: string]: unknown;
  }>;
}

async function loadOrGenerateKeypair(keyPath: string | undefined): Promise<{ keypair: { privateKey: KeyObject; publicKey: KeyObject }; source: 'loaded' | 'generated' | 'persisted' }> {
  if (keyPath) {
    const abs = resolve(process.cwd(), keyPath);
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const parsed = JSON.parse(raw) as { privateKey: string; publicKey: string };
      const privateKey = createPrivateKey({ key: Buffer.from(parsed.privateKey, 'hex'), format: 'der', type: 'pkcs8' });
      const publicKey = createPublicKey({ key: Buffer.from(parsed.publicKey, 'hex'), format: 'der', type: 'spki' });
      return { keypair: { privateKey, publicKey }, source: 'loaded' };
    } catch (err) {
      // File doesn't exist yet — generate a fresh keypair and persist it.
      const kp = generateKeyPairSync('ed25519');
      const pkcs8 = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
      const spki = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
      await fs.writeFile(abs, JSON.stringify({ privateKey: pkcs8, publicKey: spki }, null, 2));
      return { keypair: kp, source: 'persisted' };
    }
  }
  return { keypair: generateKeyPairSync('ed25519'), source: 'generated' };
}

export const benchmarkCosignCommand: Command = {
  name: 'cosign',
  description: 'Add a third-party co-signature to an entry in a benchmark ledger (Phase 24 M-of-N attestation)',
  options: [
    {
      name: 'entry',
      short: 'e',
      type: 'number',
      description: 'Entry sequence number to co-sign (1-based). Default: last entry.',
    },
    {
      name: 'label',
      short: 'l',
      type: 'string',
      description: 'Human-readable label for this signer (e.g. "third-party-verifier")',
    },
    {
      name: 'out',
      short: 'o',
      type: 'string',
      description: 'Output path for the updated ledger. Default: overwrite the input.',
    },
    {
      name: 'key',
      short: 'k',
      type: 'string',
      description: 'Path to a JSON keypair file (pkcs8 + spki hex). If missing, a fresh ephemeral key is generated; if path doesn\'t exist, a new key is generated and persisted there.',
    },
    {
      name: 'all',
      type: 'boolean',
      description: 'Co-sign EVERY entry in the ledger (useful for batch attestation by a single signer).',
      default: 'false',
    },
    {
      name: 'json',
      type: 'boolean',
      description: 'Output JSON instead of human-readable',
      default: 'false',
    },
  ],
  examples: [
    { command: 'ruflo benchmark cosign ledger.json --entry 11 --label "auditor-A"', description: 'Co-sign entry 11 with an ephemeral key' },
    { command: 'ruflo benchmark cosign ledger.json --all --label "release-gate" --key ./auditor.key.json', description: 'Co-sign every entry with a persisted key' },
    { command: 'ruflo benchmark cosign ledger.json -e 11 -o audited.json', description: 'Write the cosigned ledger to a new file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const pathArg = ctx.args[0];
    const asJson = ctx.flags.json === true || ctx.flags.json === 'true';
    const all = ctx.flags.all === true || ctx.flags.all === 'true';
    const entryFlag = ctx.flags.entry !== undefined ? Number(ctx.flags.entry) : undefined;
    const label = ctx.flags.label as string | undefined;
    const outPath = ctx.flags.out as string | undefined;
    const keyPath = ctx.flags.key as string | undefined;

    if (!pathArg || typeof pathArg !== 'string') {
      const err = 'usage: ruflo benchmark cosign <path-to-ledger.json> [--entry N | --all] [--label "name"] [--out path] [--key path] [--json]';
      if (asJson) output.printJson({ ok: false, error: err });
      else output.printError(err);
      return { success: false, exitCode: 1 };
    }
    if (!all && entryFlag !== undefined && (!Number.isFinite(entryFlag) || entryFlag < 1)) {
      const err = `--entry must be a positive integer, got: ${ctx.flags.entry}`;
      if (asJson) output.printJson({ ok: false, error: err });
      else output.printError(err);
      return { success: false, exitCode: 1 };
    }

    const inPath = resolve(process.cwd(), pathArg);
    let raw: string;
    try {
      raw = await fs.readFile(inPath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (asJson) output.printJson({ ok: false, error: `cannot read ${inPath}: ${msg}` });
      else output.printError(`Cannot read ${inPath}: ${msg}`);
      return { success: false, exitCode: 1 };
    }

    let ledger: BenchmarkLedgerShape;
    try {
      ledger = JSON.parse(raw) as BenchmarkLedgerShape;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (asJson) output.printJson({ ok: false, error: `not valid JSON: ${msg}` });
      else output.printError(`Not valid JSON: ${msg}`);
      return { success: false, exitCode: 1 };
    }
    if (typeof ledger.version !== 'number' || !Array.isArray(ledger.entries) || ledger.entries.length === 0) {
      const err = `not a benchmark ledger — expected { version: number, entries: [non-empty] }`;
      if (asJson) output.printJson({ ok: false, error: err });
      else output.printError(err);
      return { success: false, exitCode: 1 };
    }

    // Load or generate the signing keypair.
    const { keypair, source: keypairSource } = await loadOrGenerateKeypair(keyPath);

    // Determine which entries to co-sign.
    let targetIndices: number[];
    if (all) {
      targetIndices = ledger.entries.map((_, i) => i);
    } else {
      const seq = entryFlag ?? ledger.entries[ledger.entries.length - 1]!.sequence;
      const idx = ledger.entries.findIndex(e => e.sequence === seq);
      if (idx === -1) {
        const err = `entry sequence ${seq} not found in ledger (chain has ${ledger.entries.length} entries with sequences 1..${ledger.entries.length})`;
        if (asJson) output.printJson({ ok: false, error: err });
        else output.printError(err);
        return { success: false, exitCode: 1 };
      }
      targetIndices = [idx];
    }

    // Lazy-load the cosign primitive from the published embeddings package.
    const { coSign } = await import('@claude-flow/embeddings/witness-ledger');

    // Mutate a copy of the ledger.
    const newEntries = ledger.entries.map((e, i) =>
      targetIndices.includes(i)
        ? coSign(e as never, keypair, label ? { signerLabel: label } : {})
        : e,
    );
    const newLedger = { ...ledger, entries: newEntries };

    // Write output.
    const writePath = resolve(process.cwd(), outPath ?? pathArg);
    await fs.writeFile(writePath, JSON.stringify(newLedger, null, 2));

    const publicKeyHex = keypair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

    if (asJson) {
      output.printJson({
        ok: true,
        inPath,
        outPath: writePath,
        entriesCosigned: targetIndices.length,
        targetSequences: targetIndices.map(i => ledger.entries[i]!.sequence),
        signerLabel: label ?? null,
        publicKey: publicKeyHex,
        keypairSource,
      });
      return { success: true, exitCode: 0 };
    }

    output.writeln();
    output.writeln(output.bold(`Co-signed ${targetIndices.length} entr${targetIndices.length === 1 ? 'y' : 'ies'}`));
    output.writeln(output.dim('─'.repeat(60)));
    output.writeln(`  input:        ${inPath}`);
    output.writeln(`  output:       ${writePath}`);
    output.writeln(`  signer label: ${label ?? '(unlabeled)'}`);
    output.writeln(`  signer pubkey: ${publicKeyHex.slice(0, 32)}...`);
    output.writeln(`  keypair:      ${keypairSource}${keyPath ? ` → ${keyPath}` : ''}`);
    output.writeln();
    output.writeln('  entries:');
    for (const i of targetIndices) {
      const e = newEntries[i]!;
      const cosigCount = Array.isArray(e.cosignatures) ? e.cosignatures.length : 0;
      const hashShort = (e.contentHash as string).slice(0, 12) + '…';
      output.writeln(`    [${String(e.sequence).padStart(2)}] ${(e.benchmark as string).padEnd(28)} now ${1 + cosigCount} sigs (${hashShort})`);
    }
    output.writeln();
    output.writeln(`Next: verify the cosigned ledger with the new threshold:`);
    output.writeln(output.dim(`  npx ruflo benchmark verify ${writePath} --threshold 2`));
    output.writeln();

    return { success: true, exitCode: 0 };
  },
};

export default benchmarkCosignCommand;
