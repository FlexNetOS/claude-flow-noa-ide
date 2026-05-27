/**
 * Install context resolver — single source of truth for SwarmOps install paths.
 *
 * Background
 * ----------
 * Several modules independently re-derive {projectRoot, claudeRoot, dataDir,
 * isGlobalInstall} from os.homedir() + process.cwd() + filesystem probes.
 * Drift between those derivations was the bug class PR-1828 patched in three
 * separate places. This module replaces ad-hoc derivation with one resolver.
 *
 * Resolution algorithm
 * --------------------
 * 1. If `process.env.RUFLO_INSTALL_CONTEXT_JSON` is set, parse and return.
 *    (Test harness override — lets a parent process pin the context for a
 *    spawned subprocess.)
 * 2. If `opts.forceGlobal` OR cwd has no `.claude/` dir but `$HOME/.claude/`
 *    exists → global mode.
 * 3. If cwd has `.claude/` → project mode.
 * 4. Default: global mode against `$HOME/.claude` (create if missing —
 *    keeping the install resolvable for first-run).
 * 5. `dataDir = path.join(claudeRoot, '.claude-flow', 'data')`.
 * 6. `packageRoot` is derived from this file's location via fileURLToPath.
 *
 * @module v3/shared/install-context
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

/**
 * The resolved install context — the canonical {project, claude, data} truth.
 */
export interface InstallContext {
  /** Where SwarmOps source/dist lives (the package itself). */
  packageRoot: string;
  /** Where Claude Code reads its config (~/.claude or <project>/.claude). */
  claudeRoot: string;
  /** Where SwarmOps runtime data lives (state.json, daemon.lock, …). */
  dataDir: string;
  /** True when invoked against ~/.claude vs a per-project tree. */
  isGlobalInstall: boolean;
  /** Project working directory if applicable (cwd at invocation). */
  projectRoot: string | null;
}

/**
 * Options for {@link resolveInstallContext}. All optional — sensible
 * defaults reduce to "look at the real cwd / homedir".
 */
export interface ResolveInstallContextOptions {
  /** Override cwd (for testing). */
  cwd?: string;
  /** Override homedir (for testing). */
  home?: string;
  /** Skip cwd-detection, force global mode. */
  forceGlobal?: boolean;
}

/**
 * Compute the package root from the URL of this file.
 *
 * In dist (`dist/install-context.js`) we go up one level from the file to
 * land on `dist/`, then up again to land on the package root. In source
 * (`src/install-context.ts`) we go up one level from the file to land on
 * `src/`, then up again to land on the package root. Either way, two
 * `path.dirname` calls puts us where package.json lives.
 */
function derivePackageRoot(): string {
  try {
    const fileUrl = import.meta.url;
    const filePath = fileURLToPath(fileUrl);
    // <root>/(src|dist)/install-context.(ts|js) → up two = <root>
    return path.dirname(path.dirname(filePath));
  } catch {
    // Best-effort fallback — caller most likely won't notice because
    // packageRoot is rarely used at runtime.
    return process.cwd();
  }
}

/**
 * Resolve the install context. See module-level docstring for the
 * resolution algorithm.
 *
 * @param opts  Optional overrides — useful in tests and for forcing
 *              global mode from an installer.
 * @returns     An immutable {@link InstallContext}.
 */
export function resolveInstallContext(
  opts: ResolveInstallContextOptions = {},
): InstallContext {
  // 1. Env override — JSON-encoded InstallContext.
  const envOverride = process.env.RUFLO_INSTALL_CONTEXT_JSON;
  if (envOverride) {
    try {
      const parsed = JSON.parse(envOverride) as Partial<InstallContext>;
      // Validate that the override has the required string fields. If
      // anything is missing or the wrong shape, fall through to normal
      // resolution rather than returning a malformed context.
      if (
        typeof parsed.packageRoot === 'string' &&
        typeof parsed.claudeRoot === 'string' &&
        typeof parsed.dataDir === 'string' &&
        typeof parsed.isGlobalInstall === 'boolean'
      ) {
        return {
          packageRoot: parsed.packageRoot,
          claudeRoot: parsed.claudeRoot,
          dataDir: parsed.dataDir,
          isGlobalInstall: parsed.isGlobalInstall,
          projectRoot: parsed.projectRoot ?? null,
        };
      }
    } catch {
      // Malformed env override — fall through to normal resolution.
    }
  }

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const homeClaude = path.join(home, '.claude');
  const cwdClaude = path.join(cwd, '.claude');

  // Bug 46: degenerate case — cwd IS itself a `.claude` directory (most
  // commonly: user invoked `ruflo` from inside `~/.claude` directly). In
  // that scenario, `cwd/.claude/` becomes the double-`.claude` path the
  // entire STRAT-1 hoist was meant to eliminate. Detect via:
  //   (a) cwd basename === ".claude" — covers any `*/.claude` parent
  //   (b) cwd === homeClaude — covers the canonical "I'm in ~/.claude" case
  // When detected, force global mode rooted at cwd itself (NOT cwd/.claude).
  // This handles the legitimate stray `~/.claude/.claude/settings.local.json`
  // that Claude Code creates without falling for it as a "project".
  const cwdIsClaudeDir = path.basename(cwd) === '.claude' || cwd === homeClaude;

  const cwdHasClaude = !cwdIsClaudeDir && safeExists(cwdClaude);
  const homeHasClaude = safeExists(homeClaude);

  let claudeRoot: string;
  let isGlobalInstall: boolean;
  let projectRoot: string | null;

  if (cwdIsClaudeDir) {
    // Bug 46: the user is already inside the .claude config dir.
    // claudeRoot IS cwd; never descend into a child .claude.
    claudeRoot = cwd;
    isGlobalInstall = true;
    projectRoot = null;
  } else if (opts.forceGlobal || (!cwdHasClaude && homeHasClaude)) {
    // Global mode — claudeRoot is ~/.claude, no project tree.
    claudeRoot = homeClaude;
    isGlobalInstall = true;
    projectRoot = null;
  } else if (cwdHasClaude) {
    // Project mode — claudeRoot is <cwd>/.claude.
    claudeRoot = cwdClaude;
    isGlobalInstall = false;
    projectRoot = cwd;
  } else {
    // Default to global — create ~/.claude if missing so downstream
    // consumers don't have to.
    claudeRoot = homeClaude;
    isGlobalInstall = true;
    projectRoot = null;
    try {
      if (!safeExists(homeClaude)) {
        fs.mkdirSync(homeClaude, { recursive: true });
      }
    } catch {
      // Non-fatal — caller may fail later but we shouldn't crash here.
    }
  }

  const dataDir = path.join(claudeRoot, '.claude-flow', 'data');
  const packageRoot = derivePackageRoot();

  return {
    packageRoot,
    claudeRoot,
    dataDir,
    isGlobalInstall,
    projectRoot,
  };
}

/** Cheap existsSync that never throws. */
function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
