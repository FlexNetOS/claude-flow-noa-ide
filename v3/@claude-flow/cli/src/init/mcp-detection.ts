/**
 * MCP detection helpers — shared between `init` (skip duplicate registration)
 * and `doctor` (report whether ruflo MCP is configured).
 *
 * Looks for both the canonical `ruflo` key and the legacy `claude-flow` key,
 * across:
 *   - parent directories' `.mcp.json` (project-local config)
 *   - `~/.claude.json` top-level `mcpServers` (Claude Code user-global)
 *   - `~/.claude.json` `projects[*].mcpServers` (Claude Code project-scoped)
 *   - `~/.claude/mcp.json`, `~/.config/claude/mcp.json`,
 *     `~/.claude/claude_desktop_config.json`
 *
 * Project keys in `~/.claude.json.projects` are matched case-insensitively
 * after normalizing path separators, because Claude stores them with forward
 * slashes while Node `path.resolve()` on Windows emits backslashes.
 */

import * as fs from 'fs';
import * as path from 'path';

export type MCPRegistrationKey = 'ruflo' | 'claude-flow';

export interface MCPRegistrationMatch {
  /** Path of the file where the registration was found. */
  configPath: string;
  /** Which key the registration used. */
  key: MCPRegistrationKey;
  /**
   * If found inside `~/.claude.json.projects[<projectKey>]`, the project key
   * that matched. Undefined for top-level / parent `.mcp.json` matches.
   */
  projectKey?: string;
}

const KEYS: MCPRegistrationKey[] = ['ruflo', 'claude-flow'];

function normalizeProjectKey(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function findInMcpServers(
  obj: unknown,
): MCPRegistrationKey | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const servers = (obj as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object') return undefined;
  for (const key of KEYS) {
    if (key in (servers as Record<string, unknown>)) return key;
  }
  return undefined;
}

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Find an existing MCP registration for ruflo (or its legacy `claude-flow`
 * alias) in any of the known config locations.
 *
 * @param targetDir - Directory we're about to write `.mcp.json` to. Its own
 *   `.mcp.json` is excluded so init can detect prior parent-level / global
 *   registrations without matching the file it's about to overwrite.
 * @returns Match details, or null if no registration found.
 */
export function findExistingMCPRegistration(
  targetDir: string,
): MCPRegistrationMatch | null {
  const home = (process.env.HOME ?? process.env.USERPROFILE) ?? '';
  const resolvedTarget = path.resolve(targetDir);
  const targetMcpPath = path.join(resolvedTarget, '.mcp.json');
  const normalizedTarget = normalizeProjectKey(resolvedTarget);

  // 1) ~/.claude.json — top-level + project-scoped
  if (home) {
    const claudeJsonPath = path.join(home, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const parsed = readJsonSafe(claudeJsonPath);
      if (parsed && typeof parsed === 'object') {
        // Top-level
        const topKey = findInMcpServers(parsed);
        if (topKey) return { configPath: claudeJsonPath, key: topKey };

        // Project-scoped: parsed.projects[<resolvedKey>].mcpServers
        const projects = (parsed as { projects?: Record<string, unknown> }).projects;
        if (projects && typeof projects === 'object') {
          for (const [projKey, projVal] of Object.entries(projects)) {
            if (normalizeProjectKey(projKey) !== normalizedTarget) continue;
            const matchedKey = findInMcpServers(projVal);
            if (matchedKey) {
              return {
                configPath: claudeJsonPath,
                key: matchedKey,
                projectKey: projKey,
              };
            }
          }
        }
      }
    }
  }

  // 2) Other Claude Code / Desktop config files
  const otherCandidates: string[] = [];
  if (home) {
    otherCandidates.push(path.join(home, '.claude', 'mcp.json'));
    otherCandidates.push(path.join(home, '.config', 'claude', 'mcp.json'));
    otherCandidates.push(path.join(home, '.claude', 'claude_desktop_config.json'));
  }
  for (const candidate of otherCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = readJsonSafe(candidate);
    const matchedKey = findInMcpServers(parsed);
    if (matchedKey) return { configPath: candidate, key: matchedKey };
  }

  // 3) Walk parents of targetDir looking for .mcp.json
  let dir = resolvedTarget;
  while (true) {
    const candidate = path.join(dir, '.mcp.json');
    if (candidate !== targetMcpPath && fs.existsSync(candidate)) {
      const parsed = readJsonSafe(candidate);
      const matchedKey = findInMcpServers(parsed);
      if (matchedKey) return { configPath: candidate, key: matchedKey };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
