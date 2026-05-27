/**
 * Claude Code Registry — Filesystem scanner for user-installed content.
 *
 * Bug 22 (root cause): Ruflo's MCP server was blind to the user's actual
 * installed agents/skills/commands/plugins. `agent_list` returned an empty
 * set, `guidance_capabilities` listed only ~16 hardcoded built-ins, and
 * `hooks_route` could not see things like `polymarket-analyzer`,
 * `kali-osint-*`, `geo-*`, `ceo`, `polybot-ops`, etc. that live on disk.
 *
 * This module scans `~/.claude/` (overridable via `CLAUDE_HOME` env var)
 * for the four content types Claude Code natively supports:
 *
 *   - **Agents**: markdown files anywhere under `agents/`. Name = filename
 *     basename. `category` = first subdir under `agents/`. Optional
 *     `description` parsed from YAML frontmatter (`description: ...`).
 *
 *   - **Skills**: subdirectories of `skills/`. Each skill's `SKILL.md`
 *     (or `skill.md` fallback) frontmatter is parsed for `description`.
 *
 *   - **Commands**: markdown files anywhere under `commands/`. Just name +
 *     path; we don't need to read them to know they exist.
 *
 *   - **Plugins**: parsed from `plugins/installed_plugins.json` — the canonical
 *     source-of-truth Claude Code itself uses.
 *
 * Results are cached in-process for 60 seconds (`CACHE_TTL_MS`) keyed on
 * the absolute claudeRoot path. Subsequent calls within that window return
 * the cached snapshot — important because every MCP tool call would
 * otherwise re-scan ~350 files.
 *
 * NO new dependencies. Uses stdlib `fs` + a 20-line YAML frontmatter
 * extractor (the only field we ever need is `description`, which is
 * always a single string after the second `---`).
 *
 * @module @claude-flow/cli/registry/claude-code-registry
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface UserAgent {
  name: string;
  path: string;
  /** First subdirectory under `agents/`, or `'root'` if at the top level. */
  category: string;
  description?: string;
}

export interface UserSkill {
  name: string;
  path: string;
  description?: string;
}

export interface UserCommand {
  name: string;
  path: string;
}

export interface UserPlugin {
  name: string;
  version?: string;
}

/**
 * #bug39 — Foreign MCP server: an MCP entry from a `.mcp.json` file that is
 * NOT one of the user's own ruflo/claude-flow/flow-nexus/ruv-swarm servers.
 * These come from Claude Code plugins (`mcp__plugin_<...>__*`), claude.ai
 * integrations (`mcp__claude_ai_<...>__*`), or arbitrary user-added MCPs.
 *
 * Ruflo's routing was previously blind to these — `guidance_capabilities`
 * never inspected the MCP registry, so the router never knew that mongodb /
 * pinecone / context7 / chrome-devtools / Notion / Gmail / Drive existed.
 * This type lets `guidance_capabilities` surface them so the LLM can decide
 * to call `mcp__<server>__*` directly when the task matches.
 */
export interface ForeignMcpServer {
  /** The `mcpServers` key — also the prefix for `mcp__<name>__*` tool names. */
  name: string;
  /**
   * Provenance bucket:
   *   - `user`: the user's own ruflo/claude-flow/flow-nexus/ruv-swarm
   *     instances (NOT foreign — kept here for completeness so callers can
   *     filter them out cleanly).
   *   - `plugin`: bundled by a Claude Code plugin (typically prefixed
   *     `plugin_…` in the registry; may also live in `~/.claude/.mcp.json`).
   *   - `claude-ai`: a hosted claude.ai integration (HuggingFace, Notion,
   *     Gmail, Drive, Calendar, Canva, …) — usually prefixed `claude_ai_`.
   */
  source: 'user' | 'plugin' | 'claude-ai';
  /** The `command` field — useful to know what the server actually runs. */
  command?: string;
  /** Args array (if present). Captured raw — never executed. */
  args?: string[];
  /** Which `.mcp.json` file declared this server (absolute path). */
  origin: string;
}

export interface ClaudeCodeRegistry {
  agents: UserAgent[];
  skills: UserSkill[];
  commands: UserCommand[];
  plugins: UserPlugin[];
  /** #bug39 — MCP servers from Claude Code config (plugins + claude.ai). */
  foreignMcpServers: ForeignMcpServer[];
  /** Epoch millis when this snapshot was produced. */
  scannedAt: number;
  /** Absolute root path that was scanned. */
  root: string;
}

// ── Cache ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  registry: ClaudeCodeRegistry;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory scan cache. Exposed for tests so each test can start
 * from a clean slate without a 60-second wait.
 */
export function clearRegistryCache(): void {
  cache.clear();
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Resolve the Claude Code root. Precedence:
 *   1. Explicit arg (used by tests + power users).
 *   2. `CLAUDE_HOME` env var.
 *   3. `~/.claude/` (the default Claude Code install location).
 */
export function resolveClaudeRoot(claudeRoot?: string): string {
  if (claudeRoot && claudeRoot.length > 0) return claudeRoot;
  const env = process.env.CLAUDE_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), '.claude');
}

/**
 * Tiny YAML-frontmatter extractor. Reads a file's leading `---\n…\n---\n`
 * block and extracts simple `key: value` pairs. Sufficient for the
 * `description: ...` field on agents/skills — we don't need to parse
 * arrays, nested objects, or multi-line strings here.
 *
 * Returns `{}` if the file has no frontmatter or can't be read. NEVER
 * throws — a malformed agent file should not crash the scanner.
 */
function parseFrontmatter(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }

  // Frontmatter must start at the very beginning with `---\n`.
  if (!content.startsWith('---')) return {};

  // Find the closing `---` on its own line.
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return {};

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const result: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    // Match `key: value` — value may be quoted ('...' or "...").
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[m[1]] = value;
  }
  return result;
}

/** Recursive directory walker. Skips dotfiles and stops at non-existent paths. */
function walkDirectory(dir: string, predicate: (entry: string, fullPath: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;

  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip dotfiles/dotdirs (e.g. .git, .DS_Store).
      if (entry.name.startsWith('.')) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        out.push(full);
      }
    }
  }
  return out;
}

// ── Scanners ──────────────────────────────────────────────────

function scanAgents(claudeRoot: string): UserAgent[] {
  const agentsDir = join(claudeRoot, 'agents');
  if (!existsSync(agentsDir)) return [];

  const files = walkDirectory(agentsDir, (name) => name.endsWith('.md'));
  const agents: UserAgent[] = [];

  for (const path of files) {
    // Skip well-known non-agent docs.
    const fileName = path.split(/[\\/]/).pop() ?? '';
    if (fileName === 'MIGRATION_SUMMARY.md' || fileName === 'README.md') continue;

    const name = fileName.replace(/\.md$/, '');

    // Category = first subdir under agents/. If file is directly inside
    // agents/, category = 'root'.
    const rel = path.slice(agentsDir.length + 1);
    const parts = rel.split(/[\\/]/);
    const category = parts.length > 1 ? parts[0] : 'root';

    const fm = parseFrontmatter(path);
    // `name` field in frontmatter wins over filename when present.
    const agentName = fm.name && fm.name.length > 0 ? fm.name : name;

    agents.push({
      name: agentName,
      path,
      category,
      description: fm.description,
    });
  }
  return agents;
}

function scanSkills(claudeRoot: string): UserSkill[] {
  const skillsDir = join(claudeRoot, 'skills');
  if (!existsSync(skillsDir)) return [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: UserSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillDir = join(skillsDir, entry.name);
    // Look for SKILL.md (canonical) or skill.md (case-insensitive fallback).
    const candidates = ['SKILL.md', 'skill.md'];
    let skillFile: string | undefined;
    for (const c of candidates) {
      const p = join(skillDir, c);
      if (existsSync(p)) {
        skillFile = p;
        break;
      }
    }

    if (!skillFile) continue;

    const fm = parseFrontmatter(skillFile);
    skills.push({
      name: fm.name && fm.name.length > 0 ? fm.name : entry.name,
      path: skillFile,
      description: fm.description,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function scanCommands(claudeRoot: string): UserCommand[] {
  const commandsDir = join(claudeRoot, 'commands');
  if (!existsSync(commandsDir)) return [];

  const files = walkDirectory(commandsDir, (name) => name.endsWith('.md'));
  return files
    .map((path) => {
      const fileName = path.split(/[\\/]/).pop() ?? '';
      return { name: fileName.replace(/\.md$/, ''), path };
    })
    .filter((c) => c.name !== 'README')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function scanPlugins(claudeRoot: string): UserPlugin[] {
  const installedFile = join(claudeRoot, 'plugins', 'installed_plugins.json');
  if (!existsSync(installedFile)) return [];

  let raw: string;
  try {
    raw = readFileSync(installedFile, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  // installed_plugins.json schema varies. Common shapes:
  //   - { "plugins": [{ "name": ..., "version": ... }, ...] }
  //   - { "<plugin-name>": { "version": ... }, ... }
  //   - [ { "name": ..., "version": ... }, ... ]
  const plugins: UserPlugin[] = [];

  if (Array.isArray(parsed)) {
    for (const p of parsed) {
      if (p && typeof p === 'object' && 'name' in p && typeof (p as { name: unknown }).name === 'string') {
        plugins.push({
          name: (p as { name: string }).name,
          version:
            'version' in p && typeof (p as { version: unknown }).version === 'string'
              ? (p as { version: string }).version
              : undefined,
        });
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.plugins)) {
      for (const p of obj.plugins) {
        if (p && typeof p === 'object' && 'name' in p && typeof (p as { name: unknown }).name === 'string') {
          plugins.push({
            name: (p as { name: string }).name,
            version:
              'version' in p && typeof (p as { version: unknown }).version === 'string'
                ? (p as { version: string }).version
                : undefined,
          });
        }
      }
    } else {
      // Treat top-level keys as plugin names.
      for (const [key, val] of Object.entries(obj)) {
        if (key.startsWith('_') || key === 'plugins') continue;
        let version: string | undefined;
        if (val && typeof val === 'object' && 'version' in val) {
          const v = (val as { version: unknown }).version;
          if (typeof v === 'string') version = v;
        }
        plugins.push({ name: key, version });
      }
    }
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

// ── #bug39 — Foreign MCP server scanner ──────────────────────

/**
 * Server names that belong to the user's OWN ruflo stack, NOT a foreign
 * plugin or claude.ai integration. We classify these as `source: 'user'`
 * so callers can easily filter them out (or include them) without
 * needing to re-implement the same name list.
 *
 * NOTE: this is intentionally a small, conservative set. A user who
 * adds a *second* claude-flow instance under a different name would have
 * it classified as `plugin` — which is the safer default (foreign) than
 * silently treating it as one of ours.
 */
const RUFLO_OWN_MCP_NAMES = new Set([
  'claude-flow',
  'ruflo',
  'flow-nexus',
  'ruv-swarm',
]);

/**
 * Classify a single MCP server name into a provenance bucket. The
 * heuristic mirrors how Claude Code's tool prefixes are formed:
 *   - `mcp__plugin_*__*`     → plugin
 *   - `mcp__claude_ai_*__*`  → claude.ai integration
 *   - everything else        → either ours (RUFLO_OWN_MCP_NAMES) or
 *                              an arbitrary user-added foreign server
 *                              (which we still bucket as `plugin` —
 *                              "foreign-but-not-claude.ai" is the
 *                              cleanest fit for that bucket).
 */
function classifyMcpSource(name: string): 'user' | 'plugin' | 'claude-ai' {
  if (RUFLO_OWN_MCP_NAMES.has(name)) return 'user';
  if (name.startsWith('claude_ai_') || name.startsWith('claude-ai-')) {
    return 'claude-ai';
  }
  return 'plugin';
}

/**
 * Read + parse a single `.mcp.json` file. Returns `[]` when the file is
 * missing, unreadable, or malformed — never throws. The `mcpServers`
 * dict is the canonical shape Claude Code itself uses.
 */
function readMcpJson(path: string): Array<{ name: string; command?: string; args?: string[] }> {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  // Canonical shape: `{ mcpServers: { "<name>": { command, args, ... } } }`.
  const obj = parsed as Record<string, unknown>;
  const serversField = obj.mcpServers;
  if (!serversField || typeof serversField !== 'object') return [];

  const out: Array<{ name: string; command?: string; args?: string[] }> = [];
  for (const [name, val] of Object.entries(serversField as Record<string, unknown>)) {
    if (!name || typeof name !== 'string') continue;
    let command: string | undefined;
    let args: string[] | undefined;
    if (val && typeof val === 'object') {
      const cfg = val as Record<string, unknown>;
      if (typeof cfg.command === 'string') command = cfg.command;
      if (Array.isArray(cfg.args)) {
        // Filter to strings only — defensive against malformed configs.
        args = (cfg.args as unknown[]).filter((a): a is string => typeof a === 'string');
      }
    }
    out.push({ name, command, args });
  }
  return out;
}

/**
 * Resolve the list of `.mcp.json` paths to scan, in priority order.
 * Earlier entries win on duplicate server names — Claude Code itself
 * resolves user-level config before project-level, and we mirror that
 * so the scanner agrees with the runtime.
 *
 * Sources, in order:
 *   1. `~/.mcp.json` (legacy global location — some installs use this)
 *   2. `~/.claude/.mcp.json` (canonical Claude Code global location)
 *   3. `<cwd>/.mcp.json` (project-local override; only when cwd is set)
 */
function resolveMcpJsonPaths(claudeRoot: string, projectCwd?: string): string[] {
  // #bug39 — `RUFLO_MCP_HOME_OVERRIDE` lets tests redirect `~/.mcp.json`
  // to a controlled path so the scanner doesn't accidentally read the
  // real user's config. Empty string explicitly disables the home lookup.
  const homeOverride = process.env.RUFLO_MCP_HOME_OVERRIDE;
  const home = homeOverride !== undefined ? homeOverride : homedir();

  const paths: string[] = [];
  if (home.length > 0) {
    paths.push(join(home, '.mcp.json'));
  }
  paths.push(join(claudeRoot, '.mcp.json'));
  if (projectCwd && projectCwd !== home && projectCwd !== claudeRoot) {
    paths.push(join(projectCwd, '.mcp.json'));
  }
  return paths;
}

/**
 * Scan all `.mcp.json` files for MCP server entries and return a
 * deduplicated, classified list. The first occurrence of a given
 * server name wins — see `resolveMcpJsonPaths` for ordering.
 *
 * NEVER throws. Missing / unreadable / malformed files are silently
 * skipped — the registry must always return a well-formed result so
 * downstream MCP tools (`guidance_capabilities`, `agent_list`) keep
 * working even when the user's config is broken.
 */
export function scanForeignMcpServers(claudeRoot: string, projectCwd?: string): ForeignMcpServer[] {
  const paths = resolveMcpJsonPaths(claudeRoot, projectCwd);
  const seen = new Map<string, ForeignMcpServer>();

  for (const path of paths) {
    const entries = readMcpJson(path);
    for (const entry of entries) {
      // Earlier files win — skip if we've already recorded this name.
      if (seen.has(entry.name)) continue;
      seen.set(entry.name, {
        name: entry.name,
        source: classifyMcpSource(entry.name),
        command: entry.command,
        args: entry.args,
        origin: path,
      });
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Public API ────────────────────────────────────────────────

/**
 * Scan the Claude Code installation for user-installed content.
 *
 * Result is cached for 60s per `claudeRoot` to avoid re-scanning the
 * filesystem on every MCP call. Tests should call `clearRegistryCache()`
 * between cases.
 *
 * @param claudeRoot Optional override (defaults to `$CLAUDE_HOME` or `~/.claude/`).
 */
export async function scanClaudeCodeRegistry(claudeRoot?: string): Promise<ClaudeCodeRegistry> {
  const root = resolveClaudeRoot(claudeRoot);

  const now = Date.now();
  const cached = cache.get(root);
  if (cached && cached.expiresAt > now) {
    return cached.registry;
  }

  // Project cwd matters for the project-local `.mcp.json` lookup. We
  // probe `process.cwd()` here so foreign-MCP scanning works even when
  // the Claude Code root itself is empty/missing.
  // #bug39 — `RUFLO_MCP_PROJECT_CWD` lets tests inject a project cwd
  // without `process.chdir()` (unsupported in vitest workers).
  const projectCwd = (() => {
    const override = process.env.RUFLO_MCP_PROJECT_CWD;
    if (override && override.length > 0) return override;
    try {
      return process.cwd();
    } catch {
      return undefined;
    }
  })();

  // If the root doesn't exist, return an empty (but well-formed) registry.
  // Cache the empty result so we don't keep stat-ing a missing path. We
  // STILL run the foreign-MCP scan because `~/.mcp.json` and
  // `<cwd>/.mcp.json` can exist independently of the `~/.claude/` root.
  if (!existsSync(root)) {
    const empty: ClaudeCodeRegistry = {
      agents: [],
      skills: [],
      commands: [],
      plugins: [],
      foreignMcpServers: scanForeignMcpServers(root, projectCwd),
      scannedAt: now,
      root,
    };
    cache.set(root, { registry: empty, expiresAt: now + CACHE_TTL_MS });
    return empty;
  }

  // Defensive: confirm it's a directory (someone could symlink a file).
  try {
    if (!statSync(root).isDirectory()) {
      const empty: ClaudeCodeRegistry = {
        agents: [],
        skills: [],
        commands: [],
        plugins: [],
        foreignMcpServers: scanForeignMcpServers(root, projectCwd),
        scannedAt: now,
        root,
      };
      cache.set(root, { registry: empty, expiresAt: now + CACHE_TTL_MS });
      return empty;
    }
  } catch {
    // stat() can throw on permission denied. Treat as empty.
  }

  const registry: ClaudeCodeRegistry = {
    agents: scanAgents(root),
    skills: scanSkills(root),
    commands: scanCommands(root),
    plugins: scanPlugins(root),
    foreignMcpServers: scanForeignMcpServers(root, projectCwd),
    scannedAt: now,
    root,
  };

  cache.set(root, { registry, expiresAt: now + CACHE_TTL_MS });
  return registry;
}
