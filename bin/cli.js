#!/usr/bin/env node
/**
 * Claude Flow CLI - Umbrella entry point
 *
 * Thin shell — only Node builtins are imported here, then we delegate to
 * the v3 cli bin. Keeping this file minimal matters because it runs on
 * every `ruflo *` invocation; any heavy import added here is multiplied
 * across every command. The lazy-load contract for the v3 bin is
 * documented in v3/@claude-flow/cli/bin/cli.js header comment.
 *
 * Set `RUFLO_BOOT_TRACE=1` to see umbrella + v3-bin per-phase timings on
 * stderr (the v3 bin emits its own trace lines).
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.env.RUFLO_BOOT_TRACE === '1') {
  process.stderr.write(`[boot-trace] +   0.0ms  umbrella bin/cli.js entry\n`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'v3', '@claude-flow', 'cli', 'bin', 'cli.js');
await import(pathToFileURL(cliPath).href);
