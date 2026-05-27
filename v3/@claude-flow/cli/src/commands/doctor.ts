/**
 * V3 CLI Doctor Command
 * System diagnostics, dependency checks, config validation
 *
 * Created with ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, readFileSync, statSync, chmodSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { decodeKey, isEncryptionEnabled } from '../encryption/vault.js';
import { isEncryptedBlob } from '../encryption/vault.js';

// Promisified exec with proper shell and env inheritance for cross-platform support
const execAsync = promisify(exec);

/**
 * Execute command asynchronously with proper environment inheritance
 * Critical for Windows where PATH may not be inherited properly
 */
async function runCommand(command: string, timeoutMs: number = 5000): Promise<string> {
  const { stdout } = await execAsync(command, {
    encoding: 'utf8' as BufferEncoding,
    timeout: timeoutMs,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', // Use proper shell per platform
    env: { ...process.env }, // Explicitly inherit full environment
    windowsHide: true, // Hide window on Windows
  });
  return (stdout as string).trim();
}

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

// Check Node.js version
async function checkNodeVersion(): Promise<HealthCheck> {
  const requiredMajor = 20;
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= requiredMajor) {
    return { name: 'Node.js Version', status: 'pass', message: `${version} (>= ${requiredMajor} required)` };
  } else if (major >= 18) {
    return { name: 'Node.js Version', status: 'warn', message: `${version} (>= ${requiredMajor} recommended)`, fix: 'nvm install 20 && nvm use 20' };
  } else {
    return { name: 'Node.js Version', status: 'fail', message: `${version} (>= ${requiredMajor} required)`, fix: 'nvm install 20 && nvm use 20' };
  }
}

// Check npm version (async with proper env inheritance)
async function checkNpmVersion(): Promise<HealthCheck> {
  try {
    const version = await runCommand('npm --version');
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 9) {
      return { name: 'npm Version', status: 'pass', message: `v${version}` };
    } else {
      return { name: 'npm Version', status: 'warn', message: `v${version} (>= 9 recommended)`, fix: 'npm install -g npm@latest' };
    }
  } catch {
    return { name: 'npm Version', status: 'fail', message: 'npm not found', fix: 'Install Node.js from https://nodejs.org' };
  }
}

// Check config file
async function checkConfigFile(): Promise<HealthCheck> {
  // JSON configs (parse-validated). The first three are LEGACY shapes from
  // pre-v3 init flows; v3 init writes only `.claude-flow/config.yaml`.
  const jsonPaths = [
    '.claude-flow/config.json',
    'claude-flow.config.json',
    '.claude-flow.json'
  ];
  // YAML configs (existence-checked only — no heavy yaml parser dependency).
  const yamlPaths = [
    '.claude-flow/config.yaml',
    '.claude-flow/config.yml',
    'claude-flow.config.yaml'
  ];

  // #1798 — collect ALL configs that exist instead of returning at the first
  // hit. The previous early-return masked silent collisions: if both a v2
  // JSON and a v3 YAML existed, doctor reported only the JSON while the
  // daemon was actually reading from the YAML. Surfacing both lets the user
  // see and resolve the disagreement.
  const foundJson: string[] = [];
  const invalidJson: string[] = [];
  for (const configPath of jsonPaths) {
    if (!existsSync(configPath)) continue;
    try {
      JSON.parse(readFileSync(configPath, 'utf8'));
      foundJson.push(configPath);
    } catch {
      invalidJson.push(configPath);
    }
  }
  const foundYaml = yamlPaths.filter(p => existsSync(p));

  // Hard failures first: malformed JSON wins.
  if (invalidJson.length > 0) {
    return { name: 'Config File', status: 'fail', message: `Invalid JSON: ${invalidJson.join(', ')}`, fix: 'Fix JSON syntax in config file' };
  }

  // #1798 — collision: legacy JSON + new YAML both present. Subsystems can
  // disagree on which to read; surface this as a warn with the recommended
  // resolution (keep the YAML, archive the JSON).
  if (foundJson.length > 0 && foundYaml.length > 0) {
    return {
      name: 'Config File',
      status: 'warn',
      message: `Config collision: legacy ${foundJson.join(', ')} + ${foundYaml.join(', ')} — subsystems may disagree silently`,
      fix: `Archive the legacy JSON (mv ${foundJson[0]} ${foundJson[0]}.bak) and keep ${foundYaml[0]} as the canonical config`,
    };
  }

  if (foundYaml.length > 0) {
    return { name: 'Config File', status: 'pass', message: `Found: ${foundYaml[0]}` };
  }
  if (foundJson.length > 0) {
    return { name: 'Config File', status: 'pass', message: `Found: ${foundJson[0]}` };
  }

  return { name: 'Config File', status: 'warn', message: 'No config file (using defaults)', fix: 'claude-flow config init' };
}

// Check daemon status
async function checkDaemonStatus(): Promise<HealthCheck> {
  try {
    const pidFile = '.claude-flow/daemon.pid';
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      try {
        process.kill(parseInt(pid, 10), 0); // Check if process exists
        return { name: 'Daemon Status', status: 'pass', message: `Running (PID: ${pid})` };
      } catch {
        return { name: 'Daemon Status', status: 'warn', message: 'Stale PID file', fix: 'rm .claude-flow/daemon.pid && claude-flow daemon start' };
      }
    }
    return { name: 'Daemon Status', status: 'warn', message: 'Not running', fix: 'claude-flow daemon start' };
  } catch {
    return { name: 'Daemon Status', status: 'warn', message: 'Unable to check', fix: 'claude-flow daemon status' };
  }
}

// Bug 47 + Bug 48 — detect a daemon whose binary path differs from the
// current SwarmOps install (e.g. an old npx-cached daemon hosting workers
// while the user's CLI now resolves to a different package). Imported
// lazily so doctor.ts doesn't pull in fork/spawn machinery just to render
// this row.
//
// Bug 48 widens the scan to BOTH valid state-file locations (cwd-local +
// global). When multiple stale daemons are detected, each appears on its
// own line in the message body — the doctor's HealthCheck contract is
// one-row-per-check, so we keep that and pack the multi-daemon detail
// into the message field rather than fanning out into the parallel
// allChecks pipeline (which would require restructuring how findings
// flow through summary aggregation).
async function checkStaleDaemonPath(): Promise<HealthCheck> {
  try {
    const { detectDaemonPathMismatches } = await import('./daemon.js');
    const mismatches = await detectDaemonPathMismatches();
    if (mismatches.length === 0) {
      return { name: 'Daemon Path', status: 'pass', message: 'Matches current install (or no daemon running)' };
    }

    // Single-line message for the common 1-daemon case (preserves Bug 47
    // formatting); multi-line listing when 2+ daemons are mismatched.
    const formatOne = (m: typeof mismatches[number]): string => {
      const ageLabel = m.ageDays > 0 ? `${m.ageDays}d old` : 'recently started';
      return `Stale daemon (PID ${m.pid}, ${ageLabel}) running from ${m.runningPath} [tracked at ${m.stateFilePath}]`;
    };

    let message: string;
    if (mismatches.length === 1) {
      message = `${formatOne(mismatches[0])} — workers are not running SwarmOps code`;
    } else {
      message = `${mismatches.length} stale daemons detected — workers are not running SwarmOps code:\n` +
        mismatches.map(m => `    - ${formatOne(m)}`).join('\n');
    }

    return {
      name: 'Daemon Path',
      status: 'warn',
      message,
      fix: 'swarmops daemon restart --force-path',
    };
  } catch (err) {
    return {
      name: 'Daemon Path',
      status: 'warn',
      message: `Unable to verify daemon path: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Check memory database
async function checkMemoryDatabase(): Promise<HealthCheck> {
  const dbPaths = [
    '.claude-flow/memory.db',
    '.swarm/memory.db',
    'data/memory.db'
  ];

  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) {
      try {
        const stats = statSync(dbPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return { name: 'Memory Database', status: 'pass', message: `${dbPath} (${sizeMB} MB)` };
      } catch {
        return { name: 'Memory Database', status: 'warn', message: `${dbPath} (unable to stat)` };
      }
    }
  }

  return { name: 'Memory Database', status: 'warn', message: 'Not initialized', fix: 'claude-flow memory configure --backend hybrid' };
}

// Check API keys
async function checkApiKeys(): Promise<HealthCheck> {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY'];
  const found: string[] = [];

  for (const key of keys) {
    if (process.env[key]) {
      found.push(key);
    }
  }

  // Detect Claude Code environment — API keys are managed internally
  const inClaudeCode = !!(process.env.CLAUDE_CODE || process.env.CLAUDE_PROJECT_DIR || process.env.MCP_SESSION_ID);

  if (found.includes('ANTHROPIC_API_KEY') || found.includes('CLAUDE_API_KEY')) {
    return { name: 'API Keys', status: 'pass', message: `Found: ${found.join(', ')}` };
  } else if (inClaudeCode) {
    return { name: 'API Keys', status: 'pass', message: 'Claude Code (managed internally)' };
  } else if (found.length > 0) {
    return { name: 'API Keys', status: 'warn', message: `Found: ${found.join(', ')} (no Claude key)`, fix: 'export ANTHROPIC_API_KEY=your_key' };
  } else {
    return { name: 'API Keys', status: 'warn', message: 'No API keys found', fix: 'export ANTHROPIC_API_KEY=your_key' };
  }
}

// Check git (async with proper env inheritance)
async function checkGit(): Promise<HealthCheck> {
  try {
    const version = await runCommand('git --version');
    return { name: 'Git', status: 'pass', message: version.replace('git version ', 'v') };
  } catch {
    return { name: 'Git', status: 'warn', message: 'Not installed', fix: 'Install git from https://git-scm.com' };
  }
}

// Check if in git repo (async with proper env inheritance)
//
// #1791.7 — `git rev-parse` was reported as failing on hosts where `.git`
// clearly exists in cwd (linux-arm64 daemon contexts). Treat the git binary
// as authoritative when it succeeds, but fall back to a `.git` walk-up so a
// present repository is recognized even when the git invocation fails for
// environment reasons (PATH, broken global config, EBADCWD, etc.).
async function checkGitRepo(): Promise<HealthCheck> {
  try {
    await runCommand('git rev-parse --is-inside-work-tree');
    return { name: 'Git Repository', status: 'pass', message: 'In a git repository' };
  } catch {
    // Walk parents of cwd for a .git directory before reporting "not a repo"
    let dir = process.cwd();
    while (true) {
      if (existsSync(join(dir, '.git'))) {
        return {
          name: 'Git Repository',
          status: 'warn',
          message: `Repo detected on disk (${join(dir, '.git')}) but \`git rev-parse\` failed — check git installation and PATH`,
          fix: 'Verify git is on PATH (try `git --version`) and that the working tree is not corrupted',
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { name: 'Git Repository', status: 'warn', message: 'Not a git repository', fix: 'git init' };
  }
}

// Check AIDefence package availability (#1807)
//
// `aidefence_*` MCP tools (scan, analyze, has_pii, stats, learn) require
// `@claude-flow/aidefence` to be installed and loadable. The package is an
// optional dependency — present in some installs (project-local) but
// missing in others (npm-global of `claude-flow`). Without it, every
// aidefence MCP call fails at runtime with "Cannot find module".
//
// Surface that state in `doctor` so operators know BEFORE they rely on
// AI-defence scanning. The probe is the same dynamic `import()` the MCP
// tool's handler uses, so a `pass` here means the actual tools will work.
async function checkAIDefence(): Promise<HealthCheck> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await import('@claude-flow/aidefence');
    return {
      name: 'AIDefence',
      status: 'pass',
      message: '@claude-flow/aidefence loadable — aidefence_* MCP tools functional',
    };
  } catch {
    return {
      name: 'AIDefence',
      status: 'warn',
      message: '@claude-flow/aidefence not loadable — aidefence_* MCP tools will fail (optional package)',
      fix: 'npm install --save @claude-flow/aidefence  (in your project), or run `claude-flow mcp start` from a directory that has it installed',
    };
  }
}

// Check MCP servers
async function checkMcpServers(): Promise<HealthCheck> {
  const mcpConfigPaths = [
    join(process.env.HOME || '', '.claude/claude_desktop_config.json'),
    join(process.env.HOME || '', '.config/claude/mcp.json'),
    '.mcp.json'
  ];

  for (const configPath of mcpConfigPaths) {
    if (existsSync(configPath)) {
      try {
        const content = JSON.parse(readFileSync(configPath, 'utf8'));
        const servers = content.mcpServers || content.servers || {};
        const count = Object.keys(servers).length;
        const hasClaudeFlow = 'claude-flow' in servers || 'claude-flow_alpha' in servers || 'ruflo' in servers || 'ruflo_alpha' in servers;
        if (hasClaudeFlow) {
          return { name: 'MCP Servers', status: 'pass', message: `${count} servers (ruflo configured)` };
        } else {
          return { name: 'MCP Servers', status: 'warn', message: `${count} servers (ruflo not found)`, fix: 'claude mcp add ruflo -- npx -y ruflo@latest mcp start' };
        }
      } catch {
        // continue to next path
      }
    }
  }

  return { name: 'MCP Servers', status: 'warn', message: 'No MCP config found', fix: 'claude mcp add claude-flow npx @claude-flow/cli@v3alpha mcp start' };
}

// Check disk space (async with proper env inheritance)
async function checkDiskSpace(): Promise<HealthCheck> {
  try {
    if (process.platform === 'win32') {
      return { name: 'Disk Space', status: 'pass', message: 'Check skipped on Windows' };
    }
    // Use df -Ph for POSIX mode (guarantees single-line output even with long device names)
    const output_str = await runCommand('df -Ph . | tail -1');
    const parts = output_str.split(/\s+/);
    // POSIX format: Filesystem Size Used Avail Capacity Mounted
    const available = parts[3];
    const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);
    if (isNaN(usePercent)) {
      return { name: 'Disk Space', status: 'warn', message: `${available || 'unknown'} available (unable to parse usage)` };
    }

    if (usePercent > 90) {
      return { name: 'Disk Space', status: 'fail', message: `${available} available (${usePercent}% used)`, fix: 'Free up disk space' };
    } else if (usePercent > 80) {
      return { name: 'Disk Space', status: 'warn', message: `${available} available (${usePercent}% used)` };
    }
    return { name: 'Disk Space', status: 'pass', message: `${available} available` };
  } catch {
    return { name: 'Disk Space', status: 'warn', message: 'Unable to check' };
  }
}

// Check TypeScript/build (async with proper env inheritance)
async function checkBuildTools(): Promise<HealthCheck> {
  try {
    const tscVersion = await runCommand('npx tsc --version', 10000); // tsc can be slow
    if (!tscVersion || tscVersion.includes('not found')) {
      return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
    }
    return { name: 'TypeScript', status: 'pass', message: tscVersion.replace('Version ', 'v') };
  } catch {
    return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
  }
}

// Check for stale npx cache (version freshness)
async function checkVersionFreshness(): Promise<HealthCheck> {
  try {
    // Get current CLI version from package.json
    // Use import.meta.url to reliably locate our own package.json,
    // regardless of how deep the compiled file sits (e.g. dist/src/commands/).
    let currentVersion = '0.0.0';
    try {
      const thisFile = fileURLToPath(import.meta.url);
      let dir = dirname(thisFile);

      // Walk up from the current file's directory until we find the
      // package.json that belongs to @claude-flow/cli (or claude-flow/cli).
      // Walk until dirname(dir) === dir (filesystem root on any platform).
      for (;;) {
        const candidate = join(dir, 'package.json');
        try {
          if (existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (
              pkg.version &&
              typeof pkg.name === 'string' &&
              (pkg.name === '@claude-flow/cli' || pkg.name === 'claude-flow' || pkg.name === 'ruflo')
            ) {
              currentVersion = pkg.version;
              break;
            }
          }
        } catch {
          // Unreadable/invalid JSON -- skip and keep walking up
        }
        const parent = dirname(dir);
        if (parent === dir) break; // reached root
        dir = parent;
      }
    } catch {
      // Fall back to a default
      currentVersion = '0.0.0';
    }

    // Check if running via npx (look for _npx in process path or argv)
    const isNpx = process.argv[1]?.includes('_npx') ||
                  process.env.npm_execpath?.includes('npx') ||
                  process.cwd().includes('_npx');

    // Query npm for latest version (using alpha tag since that's what we publish to)
    let latestVersion = currentVersion;
    try {
      const npmInfo = await runCommand('npm view @claude-flow/cli@alpha version', 5000);
      latestVersion = npmInfo.trim();
    } catch {
      // Can't reach npm registry - skip check
      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (cannot check registry)`
      };
    }

    // Parse version numbers for comparison (handle prerelease like 3.0.0-alpha.84)
    const parseVersion = (v: string): { major: number; minor: number; patch: number; prerelease: number } => {
      const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z]+\.(\d+))?/);
      if (!match) return { major: 0, minor: 0, patch: 0, prerelease: 0 };
      return {
        major: parseInt(match[1], 10) || 0,
        minor: parseInt(match[2], 10) || 0,
        patch: parseInt(match[3], 10) || 0,
        prerelease: parseInt(match[4], 10) || 0
      };
    };

    const current = parseVersion(currentVersion);
    const latest = parseVersion(latestVersion);

    // Compare versions (including prerelease number)
    const isOutdated = (
      latest.major > current.major ||
      (latest.major === current.major && latest.minor > current.minor) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch === current.patch && latest.prerelease > current.prerelease)
    );

    if (isOutdated) {
      const fix = isNpx
        ? 'rm -rf ~/.npm/_npx/* && npx -y @claude-flow/cli@latest'
        : 'npm update @claude-flow/cli';

      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (latest: v${latestVersion})${isNpx ? ' [npx cache stale]' : ''}`,
        fix
      };
    }

    return {
      name: 'Version Freshness',
      status: 'pass',
      message: `v${currentVersion} (up to date)`
    };
  } catch (error) {
    return {
      name: 'Version Freshness',
      status: 'warn',
      message: 'Unable to check version freshness'
    };
  }
}

// Check Claude Code CLI (async with proper env inheritance)
async function checkClaudeCode(): Promise<HealthCheck> {
  try {
    const version = await runCommand('claude --version');
    // Parse version from output like "claude 1.0.0" or "Claude Code v1.0.0"
    const versionMatch = version.match(/v?(\d+\.\d+\.\d+)/);
    const versionStr = versionMatch ? `v${versionMatch[1]}` : version;
    return { name: 'Claude Code CLI', status: 'pass', message: versionStr };
  } catch {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: 'Not installed',
      fix: 'npm install -g @anthropic-ai/claude-code'
    };
  }
}

// Install Claude Code CLI
async function installClaudeCode(): Promise<boolean> {
  try {
    output.writeln();
    output.writeln(output.bold('Installing Claude Code CLI...'));
    execSync('npm install -g @anthropic-ai/claude-code', {
      encoding: 'utf8',
      stdio: 'inherit'
    });
    output.writeln(output.success('Claude Code CLI installed successfully!'));
    return true;
  } catch (error) {
    output.writeln(output.error('Failed to install Claude Code CLI'));
    if (error instanceof Error) {
      output.writeln(output.dim(error.message));
    }
    return false;
  }
}

// Check agentic-flow v3 integration (filesystem-based to avoid slow WASM/DB init)
async function checkAgenticFlow(): Promise<HealthCheck> {
  try {
    // Walk common node_modules paths to find agentic-flow/package.json
    const candidates = [
      join(process.cwd(), 'node_modules', 'agentic-flow', 'package.json'),
      join(process.cwd(), '..', 'node_modules', 'agentic-flow', 'package.json'),
    ];
    let pkgJsonPath: string | null = null;
    for (const p of candidates) {
      if (existsSync(p)) { pkgJsonPath = p; break; }
    }
    if (!pkgJsonPath) {
      return {
        name: 'agentic-flow',
        status: 'warn',
        message: 'Not installed (optional — embeddings/routing will use fallbacks)',
        fix: 'npm install agentic-flow@latest'
      };
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const version = pkg.version || 'unknown';
    const exports = pkg.exports || {};
    const features = [
      exports['./reasoningbank'] ? 'ReasoningBank' : null,
      exports['./router'] ? 'Router' : null,
      exports['./transport/quic'] ? 'QUIC' : null,
    ].filter(Boolean);
    return {
      name: 'agentic-flow',
      status: 'pass',
      message: `v${version} (${features.join(', ')})`
    };
  } catch {
    return { name: 'agentic-flow', status: 'warn', message: 'Check failed' };
  }
}

// Check encryption-at-rest status (ADR-096 Phase 5)
//
// Reports four facets without disclosing the key itself:
//   1. Gate status — is CLAUDE_FLOW_ENCRYPT_AT_REST set?
//   2. Key resolution — does CLAUDE_FLOW_ENCRYPTION_KEY resolve to a valid
//      32-byte key (env-var path only; keychain/passphrase are deferred)?
//   3. Key fingerprint — first 16 hex chars of sha256(key) so users can
//      sanity-check across machines without ever logging the key bytes.
//   4. High-tier store presence — for sessions/, terminals/, .swarm/memory.db
//      report whether on-disk bytes carry the RFE1 magic (encrypted) or not.
async function checkEncryptionAtRest(): Promise<HealthCheck> {
  if (!isEncryptionEnabled()) {
    return {
      name: 'Encryption at Rest',
      status: 'warn',
      message: 'Off — session/terminal/memory stores are plaintext (mode 0600 only)',
      fix: 'export CLAUDE_FLOW_ENCRYPT_AT_REST=1 && export CLAUDE_FLOW_ENCRYPTION_KEY=<64-char-hex>',
    };
  }

  // Gate is on — try to resolve the key. Fail-closed if missing or malformed.
  const rawKey = process.env.CLAUDE_FLOW_ENCRYPTION_KEY;
  if (!rawKey) {
    return {
      name: 'Encryption at Rest',
      status: 'fail',
      message: 'Gate is on but CLAUDE_FLOW_ENCRYPTION_KEY is unset (fail-closed)',
      fix: 'Generate a key: openssl rand -hex 32 → export CLAUDE_FLOW_ENCRYPTION_KEY=<value>',
    };
  }
  let keyFingerprint: string;
  try {
    const key = decodeKey(rawKey);
    keyFingerprint = createHash('sha256').update(key).digest('hex').slice(0, 16);
  } catch (err) {
    return {
      name: 'Encryption at Rest',
      status: 'fail',
      message: `CLAUDE_FLOW_ENCRYPTION_KEY invalid: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Provide a 64-char hex or 44-char base64 key (32 bytes)',
    };
  }

  // Check the three high-tier store paths for RFE1 magic
  const cwd = process.cwd();
  const stores: Array<{ label: string; path: string }> = [
    { label: 'sessions/', path: join(cwd, '.claude-flow', 'sessions') },
    { label: 'terminals', path: join(cwd, '.claude-flow', 'terminals', 'store.json') },
    { label: 'memory.db', path: join(cwd, '.swarm', 'memory.db') },
  ];
  const status: string[] = [];
  for (const s of stores) {
    if (!existsSync(s.path)) {
      status.push(`${s.label}=∅`);
      continue;
    }
    try {
      const stat = statSync(s.path);
      if (stat.isDirectory()) {
        // Sessions: probe the first .json file
        const { readdirSync } = await import('fs');
        const files = readdirSync(s.path).filter(f => f.endsWith('.json'));
        if (files.length === 0) { status.push(`${s.label}=∅`); continue; }
        const first = readFileSync(join(s.path, files[0]));
        status.push(`${s.label}=${isEncryptedBlob(first) ? 'enc' : 'plain'}`);
      } else {
        const buf = readFileSync(s.path);
        status.push(`${s.label}=${isEncryptedBlob(buf) ? 'enc' : 'plain'}`);
      }
    } catch {
      status.push(`${s.label}=err`);
    }
  }

  return {
    name: 'Encryption at Rest',
    status: 'pass',
    message: `On — key fp:${keyFingerprint}… (${status.join(' ')})`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// #bug38 — hook-coexistence inspection.
//
// Other Claude Code addons (notably OpenIsland) install hooks with
// matcher:"*" so they fire on EVERY tool invocation, alongside ruflo's
// scoped (Bash|Write|Edit|MultiEdit|...) matchers. This causes
// double-handling, duplicate side-effects, and breaks user trust in the
// hook system. Surface the conflict so the user can scope or disable.
// ──────────────────────────────────────────────────────────────────────────

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ command?: string; type?: string }>;
}

interface HookCoexistenceRow {
  event: string;
  rufloCount: number;
  wildcardCount: number;
  wildcardSources: string[];
}

/**
 * Heuristic: a hook entry "looks like ruflo" if any of its commands
 * mention claude-flow, ruflo, or the v3 helpers path. The matcher list
 * is the standard scoped ruflo set.
 */
const RUFLO_MATCHER_RX = /^(Bash|Write|Edit|MultiEdit|Read|Glob|Grep|Task|manual|auto|null)/;
function looksLikeRufloHook(entry: HookEntry): boolean {
  if (entry.matcher && RUFLO_MATCHER_RX.test(entry.matcher)) return true;
  for (const h of entry.hooks ?? []) {
    const cmd = h.command ?? '';
    if (/claude-flow|ruflo|\.claude\/helpers/.test(cmd)) return true;
  }
  return false;
}

/**
 * Pull a friendly source label out of a wildcard hook command. We look
 * for known third-party signatures (OpenIsland) and fall back to "third-party".
 */
function inferWildcardSource(entry: HookEntry): string {
  for (const h of entry.hooks ?? []) {
    const cmd = h.command ?? '';
    if (/OpenIsland/i.test(cmd)) return 'OpenIsland';
    if (/RaycastClaudeHooks/i.test(cmd)) return 'Raycast';
  }
  return 'third-party';
}

export function inspectHookCoexistence(settingsPath?: string): HookCoexistenceRow[] {
  const path = settingsPath ?? join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return [];

  let parsed: { hooks?: Record<string, HookEntry[]> };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, HookEntry[]> };
  } catch {
    return [];
  }
  if (!parsed.hooks || typeof parsed.hooks !== 'object') return [];

  const rows: HookCoexistenceRow[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    let ruflo = 0;
    let wildcard = 0;
    const sources = new Set<string>();
    for (const entry of entries) {
      if (entry.matcher === '*') {
        wildcard += 1;
        sources.add(inferWildcardSource(entry));
      } else if (looksLikeRufloHook(entry)) {
        ruflo += 1;
      }
    }
    rows.push({
      event,
      rufloCount: ruflo,
      wildcardCount: wildcard,
      wildcardSources: [...sources],
    });
  }
  return rows;
}

/**
 * Format the coexistence map as a fixed-width table. Returns a list of
 * lines so the caller can pipe through output.writeln. Pure for testability.
 */
export function formatHookCoexistence(rows: HookCoexistenceRow[]): string[] {
  const headers = ['Hook Event', 'Ruflo', 'Wildcard (*)', 'Notes'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.event.length)),
    headers[1].length,
    headers[2].length,
    Math.max(
      headers[3].length,
      ...rows.map(r => r.wildcardSources.length > 0
        ? `Wildcard from: ${r.wildcardSources.join(', ')}`.length
        : 0)
    ),
  ];
  const fmt = (cells: string[]) => cells
    .map((c, i) => c.padEnd(widths[i]))
    .join('  ');
  const lines = [
    fmt(headers),
    fmt(widths.map(w => '─'.repeat(w))),
  ];
  for (const r of rows) {
    const note = r.wildcardSources.length > 0
      ? `Wildcard from: ${r.wildcardSources.join(', ')}`
      : '';
    lines.push(fmt([
      r.event,
      String(r.rufloCount),
      String(r.wildcardCount),
      note,
    ]));
  }
  return lines;
}

/**
 * Returns the consolidated check for the encryption summary block:
 * pass if no wildcard matchers anywhere, warn otherwise.
 */
export function checkHookCoexistence(rows?: HookCoexistenceRow[]): HealthCheck {
  const data = rows ?? inspectHookCoexistence();
  if (data.length === 0) {
    return { name: 'Hook Coexistence', status: 'pass', message: 'No hooks configured' };
  }
  const wildcardEvents = data.filter(r => r.wildcardCount > 0);
  if (wildcardEvents.length === 0) {
    return {
      name: 'Hook Coexistence',
      status: 'pass',
      message: `${data.length} event(s) inspected, no wildcard (*) matchers detected`,
    };
  }
  const sources = new Set<string>();
  for (const r of wildcardEvents) for (const s of r.wildcardSources) sources.add(s);
  return {
    name: 'Hook Coexistence',
    status: 'warn',
    message: `Wildcard (*) matchers detected on ${wildcardEvents.length} event(s) from: ${[...sources].join(', ')}`,
    fix: 'ruflo doctor --hooks  # inspect; consider scoping the wildcard hook to specific tools',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// #bug42 — data-file permission audit.
//
// Files like ~/.claude/.claude-flow/data/auto-memory-store.json and
// pending-insights.jsonl capture prompt and edit content. They must be
// 0600 (owner-only) so other local processes cannot read them.
// ──────────────────────────────────────────────────────────────────────────

interface PermIssue {
  path: string;
  mode: string; // octal as 4-char string
}

/** Recursively yield every regular file under `dir` (depth-limited). */
function walkFiles(dir: string, maxDepth = 4): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: Array<{ p: string; d: number }> = [{ p: dir, d: 0 }];
  while (stack.length > 0) {
    const { p, d } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        if (d < maxDepth) stack.push({ p: full, d: d + 1 });
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Inspect the well-known sensitive-data paths and return any file whose
 * mode is not 0600. Pure (returns paths instead of mutating fs) so the
 * --fix mode can iterate the same list.
 */
export function inspectDataFilePerms(home?: string): PermIssue[] {
  const root = home ?? homedir();
  const targets: string[] = [
    join(root, '.claude', '.claude-flow', 'data'),
    join(root, '.claude', '.claude-flow', 'sessions'),
    join(root, '.claude-flow', 'data'),
    join(root, '.claude-flow', 'sessions'),
  ];
  const candidates = new Set<string>();
  for (const t of targets) {
    for (const f of walkFiles(t)) {
      if (/\.(jsonl?|db)$/.test(f)) candidates.add(f);
    }
  }
  // Backups directory: pick up *.json.backup.* dotfiles that capture state.
  const backupsDir = join(root, '.claude', 'backups');
  if (existsSync(backupsDir)) {
    try {
      for (const f of readdirSync(backupsDir)) {
        if (/\.(json|jsonl)\.backup\./.test(f) || /\.(json|jsonl)$/.test(f)) {
          candidates.add(join(backupsDir, f));
        }
      }
    } catch {
      // ignore
    }
  }

  const issues: PermIssue[] = [];
  for (const path of candidates) {
    try {
      const st = statSync(path);
      // Mask off the file-type bits — we only care about permission bits.
      const mode = st.mode & 0o777;
      if (mode !== 0o600) {
        issues.push({ path, mode: mode.toString(8).padStart(4, '0') });
      }
    } catch {
      // unreadable — skip
    }
  }
  return issues;
}

/** chmod 0600 each issue. Returns the count successfully chmod'd. */
export function fixDataFilePerms(issues: PermIssue[]): number {
  let fixed = 0;
  for (const issue of issues) {
    try {
      chmodSync(issue.path, 0o600);
      fixed += 1;
    } catch {
      // best-effort
    }
  }
  return fixed;
}

export function checkDataFilePerms(issues?: PermIssue[]): HealthCheck {
  const data = issues ?? inspectDataFilePerms();
  if (data.length === 0) {
    return {
      name: 'Data File Permissions',
      status: 'pass',
      message: 'All sensitive data files are 0600',
    };
  }
  return {
    name: 'Data File Permissions',
    status: 'warn',
    message: `${data.length} file(s) with mode != 0600 (e.g. ${data[0].mode} on ${data[0].path})`,
    fix: 'ruflo doctor --fix-perms  # chmod 0600 all reported files',
  };
}

// Format health check result
function formatCheck(check: HealthCheck): string {
  const icon = check.status === 'pass' ? output.success('✓') :
               check.status === 'warn' ? output.warning('⚠') :
               output.error('✗');
  return `${icon} ${check.name}: ${check.message}`;
}

// Main doctor command
export const doctorCommand: Command = {
  name: 'doctor',
  description: 'System diagnostics and health checks',
  options: [
    {
      name: 'fix',
      short: 'f',
      // #1791.5 — flag name was misleading: it does NOT auto-apply fixes,
      // it only prints the suggested commands so the user can run them
      // themselves. Make that explicit in the help output.
      description: 'Print suggested fix commands (does not auto-apply — copy/paste them yourself)',
      type: 'boolean',
      default: false
    },
    {
      name: 'install',
      short: 'i',
      description: 'Auto-install missing dependencies (Claude Code CLI)',
      type: 'boolean',
      default: false
    },
    {
      name: 'component',
      short: 'c',
      description: 'Check specific component (version, node, npm, config, daemon, memory, api, git, mcp, claude, disk, typescript)',
      type: 'string'
    },
    {
      name: 'hooks',
      description: 'Inspect ~/.claude/settings.json hook coexistence (ruflo vs wildcard *) — detects conflicts with OpenIsland and similar addons (#bug38)',
      type: 'boolean',
      default: false
    },
    {
      name: 'fix-perms',
      description: 'chmod 0600 sensitive data files (auto-memory-store, pending-insights, sessions/, backups/) — fixes #bug42',
      type: 'boolean',
      default: false
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose output',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow doctor', description: 'Run full health check' },
    { command: 'claude-flow doctor --fix', description: 'Print suggested fix commands (does not auto-apply)' },
    { command: 'claude-flow doctor --hooks', description: 'Inspect hook coexistence (#bug38)' },
    { command: 'claude-flow doctor --fix-perms', description: 'chmod 0600 sensitive data files (#bug42)' },
    { command: 'claude-flow doctor --install', description: 'Auto-install missing dependencies' },
    { command: 'claude-flow doctor -c version', description: 'Check for stale npx cache' },
    { command: 'claude-flow doctor -c claude', description: 'Check Claude Code CLI only' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showFix = ctx.flags.fix as boolean;
    const autoInstall = ctx.flags.install as boolean;
    const component = ctx.flags.component as string;
    const verbose = ctx.flags.verbose as boolean;
    const hooksMode = ctx.flags.hooks as boolean; // #bug38
    const fixPerms = ctx.flags['fix-perms'] as boolean; // #bug42

    // #bug38 — dedicated --hooks subview prints the coexistence table and exits.
    if (hooksMode) {
      output.writeln();
      output.writeln(output.bold('Hook Coexistence Inspection'));
      output.writeln(output.dim('Source: ~/.claude/settings.json'));
      output.writeln(output.dim('─'.repeat(70)));
      const rows = inspectHookCoexistence();
      if (rows.length === 0) {
        output.writeln(output.warning('No hooks configured (or settings.json unreadable).'));
        return { success: true, data: { rows } };
      }
      for (const line of formatHookCoexistence(rows)) {
        output.writeln(line);
      }
      output.writeln();
      const wildcardRows = rows.filter(r => r.wildcardCount > 0);
      if (wildcardRows.length > 0) {
        output.writeln(output.warning(
          `${wildcardRows.length} event(s) have a wildcard (*) matcher — every tool invocation triggers it,`
        ));
        output.writeln(output.warning(
          'which double-handles ruflo\'s scoped hooks. Consider scoping or disabling.'
        ));
      } else {
        output.writeln(output.success('No wildcard matchers detected — clean.'));
      }
      return { success: true, data: { rows } };
    }

    // #bug42 — dedicated --fix-perms subview chmods the sensitive data files.
    if (fixPerms) {
      output.writeln();
      output.writeln(output.bold('Data File Permission Fix'));
      output.writeln(output.dim('Target mode: 0600 (owner read/write only)'));
      output.writeln(output.dim('─'.repeat(50)));
      const issues = inspectDataFilePerms();
      if (issues.length === 0) {
        output.writeln(output.success('All sensitive data files are already 0600.'));
        return { success: true, data: { fixed: 0, issues } };
      }
      output.writeln(`Found ${issues.length} file(s) with permissive modes:`);
      for (const issue of issues.slice(0, 20)) {
        output.writeln(output.dim(`  ${issue.mode}  ${issue.path}`));
      }
      if (issues.length > 20) output.writeln(output.dim(`  … and ${issues.length - 20} more`));
      const fixed = fixDataFilePerms(issues);
      output.writeln();
      output.writeln(output.success(`chmod 0600 applied to ${fixed}/${issues.length} file(s).`));
      return { success: true, data: { fixed, issues } };
    }

    output.writeln();
    output.writeln(output.bold('RuFlo Doctor'));
    output.writeln(output.dim('System diagnostics and health check'));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

    // #bug38 + #bug42 — adapt the synchronous helper checks to the async
    // pipeline by wrapping them in async closures.
    const checkHookCoexistenceAsync = async () => checkHookCoexistence();
    const checkDataFilePermsAsync = async () => checkDataFilePerms();

    const allChecks: (() => Promise<HealthCheck>)[] = [
      checkVersionFreshness,
      checkNodeVersion,
      checkNpmVersion,
      checkClaudeCode,
      checkGit,
      checkGitRepo,
      checkConfigFile,
      checkDaemonStatus,
      checkStaleDaemonPath, // Bug 47
      checkMemoryDatabase,
      checkApiKeys,
      checkMcpServers,
      checkAIDefence, // #1807
      checkDiskSpace,
      checkBuildTools,
      checkAgenticFlow,
      checkEncryptionAtRest, // ADR-096 Phase 5
      checkHookCoexistenceAsync, // #bug38
      checkDataFilePermsAsync, // #bug42
    ];

    const componentMap: Record<string, () => Promise<HealthCheck>> = {
      'version': checkVersionFreshness,
      'freshness': checkVersionFreshness,
      'node': checkNodeVersion,
      'npm': checkNpmVersion,
      'claude': checkClaudeCode,
      'config': checkConfigFile,
      'daemon': checkDaemonStatus,
      'daemon-path': checkStaleDaemonPath, // Bug 47
      'memory': checkMemoryDatabase,
      'api': checkApiKeys,
      'git': checkGit,
      'mcp': checkMcpServers,
      'aidefence': checkAIDefence, // #1807
      'disk': checkDiskSpace,
      'typescript': checkBuildTools,
      'agentic-flow': checkAgenticFlow,
      'encryption': checkEncryptionAtRest, // ADR-096 Phase 5
      'hooks': checkHookCoexistenceAsync, // #bug38
      'perms': checkDataFilePermsAsync, // #bug42
    };

    let checksToRun = allChecks;
    if (component && componentMap[component]) {
      checksToRun = [componentMap[component]];
    }

    const results: HealthCheck[] = [];
    const fixes: string[] = [];

    // OPTIMIZATION: Run all checks in parallel for 3-5x faster execution
    const spinner = output.createSpinner({ text: 'Running health checks in parallel...', spinner: 'dots' });
    spinner.start();

    try {
      // Execute all checks concurrently
      const checkResults = await Promise.allSettled(checksToRun.map(check => check()));
      spinner.stop();

      // Process results in order
      for (const settledResult of checkResults) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          results.push(result);
          output.writeln(formatCheck(result));

          if (result.fix && (result.status === 'fail' || result.status === 'warn')) {
            fixes.push(`${result.name}: ${result.fix}`);
          }
        } else {
          const errorResult: HealthCheck = {
            name: 'Check',
            status: 'fail',
            message: settledResult.reason?.message || 'Unknown error'
          };
          results.push(errorResult);
          output.writeln(formatCheck(errorResult));
        }
      }
    } catch (error) {
      spinner.stop();
      output.writeln(output.error('Failed to run health checks'));
    }

    // Auto-install missing dependencies if requested
    if (autoInstall) {
      const claudeCodeResult = results.find(r => r.name === 'Claude Code CLI');
      if (claudeCodeResult && claudeCodeResult.status !== 'pass') {
        const installed = await installClaudeCode();
        if (installed) {
          // Re-check Claude Code after installation
          const newCheck = await checkClaudeCode();
          const idx = results.findIndex(r => r.name === 'Claude Code CLI');
          if (idx !== -1) {
            results[idx] = newCheck;
            // Update fixes list
            const fixIdx = fixes.findIndex(f => f.startsWith('Claude Code CLI:'));
            if (fixIdx !== -1 && newCheck.status === 'pass') {
              fixes.splice(fixIdx, 1);
            }
          }
          output.writeln(formatCheck(newCheck));
        }
      }
    }

    // Summary
    const passed = results.filter(r => r.status === 'pass').length;
    const warnings = results.filter(r => r.status === 'warn').length;
    const failed = results.filter(r => r.status === 'fail').length;

    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

    const summaryParts = [
      output.success(`${passed} passed`),
      warnings > 0 ? output.warning(`${warnings} warnings`) : null,
      failed > 0 ? output.error(`${failed} failed`) : null
    ].filter(Boolean);

    output.writeln(`Summary: ${summaryParts.join(', ')}`);

    // Show fixes — #1791.5: header makes it explicit these are commands you
    // run yourself, not actions doctor took.
    if (showFix && fixes.length > 0) {
      output.writeln();
      output.writeln(output.bold('Suggested commands (run them yourself):'));
      output.writeln();
      for (const fix of fixes) {
        output.writeln(output.dim(`  ${fix}`));
      }
    } else if (fixes.length > 0 && !showFix) {
      output.writeln();
      output.writeln(output.dim(`Run with --fix to see ${fixes.length} suggested command${fixes.length > 1 ? 's' : ''} (does not auto-apply)`));
    }

    // Overall result
    if (failed > 0) {
      output.writeln();
      output.writeln(output.error('Some checks failed. Please address the issues above.'));
      return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
    } else if (warnings > 0) {
      output.writeln();
      output.writeln(output.warning('All checks passed with some warnings.'));
      return { success: true, data: { passed, warnings, failed, results } };
    } else {
      output.writeln();
      output.writeln(output.success('All checks passed! System is healthy.'));
      return { success: true, data: { passed, warnings, failed, results } };
    }
  }
};

export default doctorCommand;
