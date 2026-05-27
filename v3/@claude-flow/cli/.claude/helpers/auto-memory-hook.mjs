#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook (ADR-048/049) — Minimal Fallback
 * Full version is copied from package source when available.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart
 *   node auto-memory-hook.mjs sync     # SessionEnd / Stop
 *   node auto-memory-hook.mjs status   # Show bridge status
 *
 * #bug14 — Subprocess-first design. We delegate to the `claude-flow` CLI
 * (which exposes the memory backend via MCP-bridged tools) instead of
 * trying to ESM-import `@claude-flow/memory` from a helpers directory
 * where the package isn't on the import path.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const STORE_PATH = join(DATA_DIR, 'auto-memory-store.json');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const dim = (msg) => console.log(`  ${DIM}${msg}${RESET}`);

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/**
 * #bug14 — Probe whether the `claude-flow` CLI is reachable. The CLI
 * exposes the memory backend (memory_import_claude / memory_bridge_status
 * are wired via MCP); if the binary is on PATH, the auto-memory pipeline
 * is available out-of-process even when ESM resolution of
 * `@claude-flow/memory` from the helpers directory would fail.
 *
 * Strategy: `claude-flow memory bridge-status` is a cheap read-only command
 * that succeeds when the CLI is installed. `shell:true` lets the OS resolve
 * PATH, npx-shims, and Windows .cmd wrappers. We also note the homedir
 * `.claude` install path (`@claude-flow/cli/package.json`) for diagnostics
 * — if the user did a global install, the CLI lives there.
 */
function trySubprocessImport() {
  const homeClaudeDir = join(homedir(), '.claude');
  const candidates = ['claude-flow', 'npx claude-flow'];
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['memory', 'bridge-status'], {
        encoding: 'utf-8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      if (result.status === 0) {
        return { available: true, bin: cmd, homeClaudeDir };
      }
      if (result.error && result.error.code === 'ENOENT') continue;
    } catch { /* try next */ }
  }
  return { available: false, bin: null, homeClaudeDir };
}

async function doImport() {
  // #bug14 — Subprocess-first. No ESM import attempt; the CLI is the
  // canonical path for the memory backend in helper-script context.
  const sub = trySubprocessImport();
  if (sub.available) {
    // Bridge reachable. The MCP-side memory_import_claude does the actual
    // import; this minimal helper just confirms availability silently. We
    // emit a low-noise dim line so SessionStart logs are still informative.
    dim(`Auto memory bridge ready (${sub.bin})`);
    return;
  }
  // CLI not on PATH — non-critical, helpers gracefully no-op.
  dim('claude-flow CLI not on PATH — auto memory import skipped (non-critical)');
}

async function doSync() {
  if (!existsSync(STORE_PATH)) {
    dim('No entries to sync');
    return;
  }
  const sub = trySubprocessImport();
  if (sub.available) {
    dim(`Auto memory sync ready (${sub.bin})`);
    return;
  }
  dim('claude-flow CLI not on PATH — sync skipped (non-critical)');
}

function doStatus() {
  console.log('\n=== Auto Memory Bridge Status ===\n');
  const sub = trySubprocessImport();
  console.log(`  CLI:            ${sub.available ? 'reachable (' + sub.bin + ')' : 'not on PATH'}`);
  console.log(`  Store:          ${existsSync(STORE_PATH) ? 'Initialized' : 'Not initialized'}`);
  console.log(`  Home install:   ${existsSync(join(sub.homeClaudeDir, 'package.json')) ? sub.homeClaudeDir : 'not detected'}`);
  console.log('');
}

// Suppress unhandled rejection warnings from dynamic import() failures
process.on('unhandledRejection', () => {});

const command = process.argv[2] || 'status';

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      process.exit(1);
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  dim(`Error (non-critical): ${err.message}`);
}
// Ensure clean exit for Claude Code hooks (exit 0 = success)
process.exit(0);
