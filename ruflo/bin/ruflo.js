#!/usr/bin/env node
// Ruflo CLI - thin wrapper around @claude-flow/cli with ruflo branding
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Mirror suppression from @claude-flow/cli/bin/cli.js — ruflo imports dist/src/index.js
// directly so it bypasses the canonical entry's console.warn patch.
const _origWarn = console.warn;
console.warn = (...args) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('[AgentDB Patch]')) return;
  _origWarn.apply(console, args);
};
const _origLog = console.log;
console.log = (...args) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('[AgentDB Patch]')) return;
  _origLog.apply(console, args);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);

function getRufloVersion() {
  try {
    const packageJsonPath = resolve(__dirname, '../package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printRootHelp() {
  console.log(`Ruflo - AI Agent Orchestration Platform

Usage:
  ruflo [command] [options]

Options:
  -v, --version       Display version number
  -h, --help          Display help

Commands:
  init                Initialise Ruflo in a workspace
  mcp                 Run or inspect Ruflo MCP mode
  doctor              Check system health and dependencies
  status              Show Ruflo status
  help [command]      Display help for a command

Notes:
  Ruflo delegates full command execution to @claude-flow/cli.
  Lightweight help and version output are handled by this wrapper to avoid loading the full runtime for smoke checks.`);
}

function printMcpHelp() {
  console.log(`Ruflo MCP

Usage:
  ruflo mcp start      Start the MCP server
  ruflo mcp --help     Display this help

Options:
  -h, --help           Display help

Notes:
  Starting MCP delegates to @claude-flow/cli.
  Help output is handled by this wrapper to avoid loading the full runtime for smoke checks.`);
}

function isRootVersion(args) {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v');
}

function isRootHelp(args) {
  return args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'));
}

function isMcpHelp(args) {
  return args.length === 2 &&
    args[0] === 'mcp' &&
    (args[1] === '--help' || args[1] === '-h');
}

if (isRootVersion(cliArgs)) {
  console.log(getRufloVersion());
  process.exit(0);
}

if (isRootHelp(cliArgs)) {
  printRootHelp();
  process.exit(0);
}

if (isMcpHelp(cliArgs)) {
  printMcpHelp();
  process.exit(0);
}

// Walk up from ruflo/bin/ to find @claude-flow/cli in node_modules
function findCliPath() {
  let dir = resolve(__dirname, '..');
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', '@claude-flow', 'cli', 'bin', 'cli.js');
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Convert path to file:// URL for cross-platform ESM import (Windows requires this)
function toImportURL(filePath) {
  return pathToFileURL(filePath).href;
}

const pkgDir = findCliPath();
const cliBase = pkgDir
  ? join(pkgDir, 'node_modules', '@claude-flow', 'cli')
  : resolve(__dirname, '../../v3/@claude-flow/cli');

// MCP mode: delegate to cli.js directly (branding irrelevant for JSON-RPC)
const isExplicitMCP = cliArgs.length >= 1 && cliArgs[0] === 'mcp' && (cliArgs.length === 1 || cliArgs[1] === 'start');
const isMCPMode = !process.stdin.isTTY && (process.argv.length === 2 || isExplicitMCP);

if (isMCPMode) {
  await import(toImportURL(join(cliBase, 'bin', 'cli.js')));
} else {
  // CLI mode: use ruflo branding
  const { CLI } = await import(toImportURL(join(cliBase, 'dist', 'src', 'index.js')));
  const cli = new CLI({
    name: 'ruflo',
    description: 'Ruflo - AI Agent Orchestration Platform',
  });
  cli.run()
    .then(() => {
      // #1552/#1641/#1653: Exit cleanly after one-shot commands. Mirrors @claude-flow/cli/bin/cli.js.
      // HNSW VectorDb, sql.js WASM, and ONNX worker threads keep the event loop alive.
      // Long-running commands (daemon foreground, mcp, status --watch) never resolve.
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error.message);
      process.exit(1);
    });
}
