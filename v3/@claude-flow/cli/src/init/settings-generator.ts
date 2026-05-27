/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import os from 'os';
import path from 'path';

import { resolveInstallContext } from '@claude-flow/shared';

import type { InitOptions, HooksConfig, PlatformInfo } from './types.js';
import { detectPlatform } from './types.js';

/**
 * Detect a global install — when init writes into `~/.claude` itself
 * (rather than a per-project `<project>/.claude`). Under a global install,
 * Claude Code sets `CLAUDE_PROJECT_DIR=/Users/<u>/.claude`, and the historical
 * hook command `${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/...` resolves to
 * `~/.claude/.claude/helpers/...` (double `.claude`) → MODULE_NOT_FOUND
 * (#bug8). We instead emit `$HOME/.claude/helpers/...` directly so the path
 * is correct regardless of CLAUDE_PROJECT_DIR.
 *
 * Per-project installs are unaffected: hookCmd keeps its previous shape.
 *
 * Exported because the init executor (#bug9) also needs to detect this case
 * to avoid joining a redundant `.claude/` segment on top of `targetDir` when
 * `targetDir` already *is* `~/.claude`. Without this guard, every re-init of
 * the global install writes to a phantom `~/.claude/.claude/...` tree while
 * the real `~/.claude/helpers/` (where Claude Code reads from) is never
 * updated.
 */
export function isGlobalInstall(targetDir: string | undefined): boolean {
  if (!targetDir) return false;
  try {
    // STRAT-1: route through the shared resolver so this stays in sync with
    // every other site that asks the same question. The resolver returns
    // claudeRoot = ~/.claude when global; we then check whether targetDir
    // sits inside it.
    const ctx = resolveInstallContext({ home: os.homedir() });
    const homeClaude = ctx.isGlobalInstall ? ctx.claudeRoot : path.join(os.homedir(), '.claude');
    const resolvedTarget = path.resolve(targetDir);
    return resolvedTarget === homeClaude || resolvedTarget.startsWith(homeClaude + path.sep);
  } catch {
    return false;
  }
}

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Detect global vs per-project install for hook-command path emission (#bug8).
  const globalInstall = isGlobalInstall(options.targetDir);

  // Add hooks if enabled. CRITICAL (#1744 #3): only emit the hooks block when
  // the helpers directory will also be bundled. The hook commands point at
  // .claude/helpers/hook-handler.cjs; if that file isn't created (as in
  // --minimal where components.helpers=false), every hook fires and silently
  // fails to find its handler. Either bundle the helpers OR drop the hooks —
  // the option this fix takes is the latter (minimal stays minimal).
  if (options.components.settings && options.components.helpers) {
    settings.hooks = generateHooksConfig(options.hooks, { globalInstall });
  }

  // Add statusLine configuration if enabled
  if (options.statusline.enabled) {
    settings.statusLine = generateStatusLineConfig(options, { globalInstall });
  }

  // Add permissions
  // #bug10.1 — MCP permission glob is `mcp__<server>__<tool>` (no colon). The
  // historical literal `mcp__claude-flow__:*` matched zero tools and was dead.
  // #bug10.2 — `.env` deny rules must be repo-wide globs, not project-relative.
  // `Read(./.env)` only blocks when cwd is the same dir as the file; switching
  // to `Read(**/.env*)` catches `.env`, `.env.local`, `.env.production`, … in
  // any subdirectory.
  // #bug34 — replace bare `Bash(npx claude-flow*)` prefix-wildcards with exact-
  // subcommand grants. The old patterns were wide enough that
  // `npx claude-flow-anything --eval` slipped through the allow list and ran
  // without prompting. Audit also flagged the deny list as too thin — added
  // the universally dangerous patterns (eval bypass, pipe-to-shell,
  // download-and-exec, total wipe, fork bomb) and broader credential globs.
  settings.permissions = {
    allow: [
      'Bash(npx @claude-flow/cli * mcp start)',
      'Bash(npx claude-flow doctor)',
      'Bash(npx claude-flow doctor --fix)',
      'Bash(npx claude-flow init)',
      'Bash(npx claude-flow init --*)',
      'Bash(npx claude-flow memory *)',
      'Bash(npx claude-flow swarm *)',
      'Bash(npx claude-flow daemon *)',
      'Bash(npx claude-flow hooks *)',
      'Bash(npx ruflo doctor)',
      'Bash(npx ruflo doctor --fix)',
      'Bash(npx ruflo init)',
      'Bash(npx ruflo init --*)',
      'Bash(npx ruflo memory *)',
      'Bash(npx ruflo swarm *)',
      'Bash(npx ruflo daemon *)',
      'Bash(npx ruflo hooks *)',
      'Bash(node $HOME/.claude/helpers/*)',
      'mcp__claude-flow__*',
    ],
    deny: [
      'Read(**/.env*)',
      'Read(**/credentials.json)',
      'Read(**/.ssh/id_*)',
      'Bash(*--eval*)',
      'Bash(*| sh*)',
      'Bash(*| bash*)',
      'Bash(curl *| sh*)',
      'Bash(wget *| sh*)',
      'Bash(rm -rf /*)',
      'Bash(:(){ :|:& };:*)',
    ],
  };

  // #1670 — RuFlo attribution (Co-Authored-By trailer + PR footer) is now
  // OPT-IN. Default behavior no longer injects a third-party Co-Authored-By
  // line into the user's commits — that pattern silently inflated GitHub
  // contributor graphs and was hard to undo without rewriting history. Pass
  // `--attribution` (or `attribution: true` in InitOptions) to enable.
  if (options.attribution === true) {
    settings.attribution = {
      commit: 'Co-Authored-By: RuFlo <ruv@ruv.net>',
      pr: '🤖 Generated with [RuFlo](https://github.com/ruvnet/ruflo)',
    };
  }

  // Note: Claude Code expects 'model' to be a string, not an object
  // Model preferences are stored in claudeFlow settings instead
  // settings.model = 'claude-sonnet-4-5-20250929'; // Uncomment if you want to set a default model

  // Add Agent Teams configuration (experimental feature)
  settings.env = {
    // Enable Claude Code Agent Teams for multi-agent coordination
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Claude Flow specific environment
    CLAUDE_FLOW_V3_ENABLED: 'true',
    CLAUDE_FLOW_HOOKS_ENABLED: 'true',
  };

  // Detect platform for platform-aware configuration
  const platform = detectPlatform();

  // Add V3-specific settings
  settings.claudeFlow = {
    version: '3.0.0',
    enabled: true,
    platform: {
      os: platform.os,
      arch: platform.arch,
      shell: platform.shell,
    },
    modelPreferences: {
      default: 'claude-opus-4-7',
      routing: 'claude-haiku-4-5-20251001',
    },
    agentTeams: {
      enabled: true,
      teammateMode: 'auto', // 'auto' | 'in-process' | 'tmux'
      taskListEnabled: true,
      mailboxEnabled: true,
      coordination: {
        autoAssignOnIdle: true,       // Auto-assign pending tasks when teammate is idle
        trainPatternsOnComplete: true, // Train neural patterns when tasks complete
        notifyLeadOnComplete: true,   // Notify team lead when tasks complete
        sharedMemoryNamespace: 'agent-teams', // Memory namespace for team coordination
      },
      hooks: {
        teammateIdle: {
          enabled: true,
          autoAssign: true,
          checkTaskList: true,
        },
        taskCompleted: {
          enabled: true,
          trainPatterns: true,
          notifyLead: true,
        },
      },
    },
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
      learningBridge: { enabled: options.runtime.enableLearningBridge ?? true },
      memoryGraph: { enabled: options.runtime.enableMemoryGraph ?? true },
      agentScopes: { enabled: options.runtime.enableAgentScopes ?? true },
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
    daemon: {
      autoStart: false,  // Opt-in only — prevents unintended token consumption (#1427, #1330)
      workers: [
        'map',           // Codebase mapping
        'audit',         // Security auditing (critical priority)
        'optimize',      // Performance optimization (high priority)
      ],
      schedules: {
        audit: { interval: '4h', priority: 'critical' },
        optimize: { interval: '2h', priority: 'high' },
      },
    },
    learning: {
      enabled: true,
      autoTrain: true,
      patterns: ['coordination', 'optimization', 'prediction'],
      retention: {
        shortTerm: '24h',
        longTerm: '30d',
      },
    },
    adr: {
      autoGenerate: true,
      // #bug10.3 — must be repo-relative. `/docs/adr` resolves to filesystem
      // root and ADR auto-generation fails with EACCES.
      directory: 'docs/adr',
      template: 'madr',
    },
    ddd: {
      trackDomains: true,
      validateBoundedContexts: true,
      // #bug10.4 — same root-path bug as #bug10.3.
      directory: 'docs/ddd',
    },
    security: {
      autoScan: true,
      scanOnEdit: true,
      cveCheck: true,
      threatModel: true,
    },
  };

  return settings;
}

/**
 * Detect if we're on Windows for platform-aware hook commands.
 */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Build a hook command with reliable $CLAUDE_PROJECT_DIR expansion.
 * Wraps in `sh -c` to guarantee shell expansion on all platforms (macOS zsh,
 * Linux bash). Falls back to "." if CLAUDE_PROJECT_DIR is unset, since
 * Claude Code runs hooks from the project root.
 * On Windows, uses `cmd /c` with %CLAUDE_PROJECT_DIR%.
 *
 * #bug8 — under a global install (`targetDir === ~/.claude`), Claude Code
 * sets `CLAUDE_PROJECT_DIR=~/.claude`, so the historical
 * `${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/...` path doubles the `.claude`
 * segment and produces `~/.claude/.claude/helpers/...` (MODULE_NOT_FOUND).
 * When `globalInstall=true` we emit `$HOME/.claude/helpers/...` (POSIX) or
 * `%USERPROFILE%\\.claude\\helpers\\...` (Windows) directly, dropping the
 * env-var indirection. The caller passes `script` as `.claude/helpers/<basename>`
 * for compatibility — we strip the leading `.claude/` segment for the global
 * branch since the install root *is* `.claude`.
 */
function hookCmd(
  script: string,
  subcommand: string,
  opts: { globalInstall?: boolean } = {},
): string {
  const globalInstall = opts.globalInstall === true;

  // Strip leading ".claude/" when going to global install — install root is
  // already ~/.claude, so the helpers path under it is simply `helpers/...`.
  const stripLeadingClaude = (s: string): string =>
    s.startsWith('.claude/') ? s.slice('.claude/'.length) : s;

  if (IS_WINDOWS) {
    if (globalInstall) {
      const tail = stripLeadingClaude(script).replace(/\//g, '\\');
      return `cmd /c node %USERPROFILE%\\.claude\\${tail} ${subcommand}`.trim();
    }
    return `cmd /c node %CLAUDE_PROJECT_DIR%/${script} ${subcommand}`.trim();
  }

  if (globalInstall) {
    const tail = stripLeadingClaude(script);
    // $HOME is universally exported on POSIX; no env-var indirection issue.
    return `sh -c 'exec node "$HOME/.claude/${tail}" ${subcommand}'`;
  }

  // Per-project install (current behavior). Use sh -c to ensure
  // $CLAUDE_PROJECT_DIR is expanded by a real shell, even if Claude Code
  // doesn't invoke hooks through a shell on macOS.
  // eslint-disable-next-line no-template-curly-in-string
  const dir = '${CLAUDE_PROJECT_DIR:-.}';
  return `sh -c 'exec node "${dir}/${script}" ${subcommand}'`;
}

/** Shorthand for CJS hook-handler commands */
function hookHandlerCmd(subcommand: string, opts: { globalInstall?: boolean } = {}): string {
  return hookCmd('.claude/helpers/hook-handler.cjs', subcommand, opts);
}

/** Shorthand for ESM auto-memory-hook commands */
function autoMemoryCmd(subcommand: string, opts: { globalInstall?: boolean } = {}): string {
  return hookCmd('.claude/helpers/auto-memory-hook.mjs', subcommand, opts);
}

/**
 * Generate statusLine configuration for Claude Code
 * Uses local helper script for cross-platform compatibility (no npx cold-start)
 *
 * #bug8 — same global-install path-doubling fix as `hookCmd`. When
 * `globalInstall=true`, emit `$HOME/.claude/helpers/statusline.cjs`
 * directly to bypass the `${CLAUDE_PROJECT_DIR}/.claude` doubling.
 */
function generateStatusLineConfig(
  _options: InitOptions,
  opts: { globalInstall?: boolean } = {},
): object {
  // Claude Code pipes JSON session data to the script via stdin.
  // Valid fields: type, command, padding (optional).
  // The script runs after each assistant message (debounced 300ms).
  // NOTE: statusline must NOT use `cmd /c` — Claude Code manages its stdin
  // directly for statusline commands, and `cmd /c` blocks stdin forwarding.
  if (opts.globalInstall === true) {
    return {
      type: 'command',
      command: `sh -c 'exec node "$HOME/.claude/helpers/statusline.cjs"'`,
    };
  }
  // eslint-disable-next-line no-template-curly-in-string
  const dir = '${CLAUDE_PROJECT_DIR:-.}';
  return {
    type: 'command',
    command: `sh -c 'exec node "${dir}/.claude/helpers/statusline.cjs"'`,
  };
}

/**
 * Generate hooks configuration
 * Uses local hook-handler.cjs for cross-platform compatibility.
 * All hooks invoke scripts directly via `node <script> <subcommand>`,
 * working identically on Windows, macOS, and Linux.
 *
 * `opts.globalInstall` switches all emitted commands to absolute
 * `$HOME/.claude/helpers/...` paths to fix the global-install path-doubling
 * regression (#bug8).
 */
function generateHooksConfig(
  config: HooksConfig,
  opts: { globalInstall?: boolean } = {},
): object {
  const hooks: Record<string, unknown[]> = {};
  const hh = (sub: string): string => hookHandlerCmd(sub, opts);
  const am = (sub: string): string => autoMemoryCmd(sub, opts);

  // Node.js scripts handle errors internally via try/catch.
  // No shell-level error suppression needed (2>/dev/null || true breaks Windows).

  // PreToolUse — validate commands and edits before execution
  if (config.preToolUse) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: hh('pre-bash'),
            timeout: config.timeout,
          },
        ],
      },
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: hh('pre-edit'),
            timeout: config.timeout,
          },
        ],
      },
      // #bug33 — scan content fetched from the web for prompt injection or
      // PII before the model sees it. WebFetch is the highest-risk surface
      // for indirect prompt injection (a poisoned URL can carry hidden
      // instructions back into context).
      {
        matcher: 'WebFetch',
        hooks: [
          {
            type: 'command',
            command: hh('aidefence-scan'),
            timeout: 5000,
          },
        ],
      },
    ];
  }

  // PostToolUse — record edits and commands for session metrics / learning
  if (config.postToolUse) {
    hooks.PostToolUse = [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: hh('post-edit'),
            timeout: 10000,
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: hh('post-bash'),
            timeout: config.timeout,
          },
        ],
      },
    ];
  }

  // UserPromptSubmit — intelligent task routing + AIDefence pre-scan (#bug33)
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          // #bug33 — runs FIRST so a flagged prompt blocks before routing
          // wastes tokens on an injection attempt. Exits non-zero on threat.
          {
            type: 'command',
            command: hh('aidefence-scan'),
            timeout: 5000,
          },
          {
            type: 'command',
            command: hh('route'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // SessionStart — restore session state + import auto memory
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: hh('session-restore'),
            timeout: 15000,
          },
          {
            type: 'command',
            command: am('import'),
            timeout: 8000,
          },
        ],
      },
    ];
  }

  // SessionEnd — persist session state
  if (config.sessionStart) {
    hooks.SessionEnd = [
      {
        hooks: [
          {
            type: 'command',
            command: hh('session-end'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // Stop — sync auto memory on exit
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: 'command',
            command: am('sync'),
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // PreCompact — preserve context before compaction
  if (config.preCompact) {
    hooks.PreCompact = [
      {
        matcher: 'manual',
        hooks: [
          {
            type: 'command',
            command: hh('compact-manual'),
          },
          {
            type: 'command',
            command: hh('session-end'),
            timeout: 5000,
          },
        ],
      },
      {
        matcher: 'auto',
        hooks: [
          {
            type: 'command',
            command: hh('compact-auto'),
          },
          {
            type: 'command',
            command: hh('session-end'),
            timeout: 6000,
          },
        ],
      },
    ];
  }

  // SubagentStart — status update when a sub-agent is spawned
  hooks.SubagentStart = [
    {
      hooks: [
        {
          type: 'command',
          command: hh('status'),
          timeout: 3000,
        },
      ],
    },
  ];

  // SubagentStop — track agent completion for metrics
  // NOTE: The valid event is "SubagentStop" (not "SubagentEnd")
  hooks.SubagentStop = [
    {
      hooks: [
        {
          type: 'command',
          command: hh('post-task'),
          timeout: 5000,
        },
      ],
    },
  ];

  // Notification — capture Claude Code notifications for logging
  if (config.notification) {
    hooks.Notification = [
      {
        hooks: [
          {
            type: 'command',
            command: hh('notify'),
            timeout: 3000,
          },
        ],
      },
    ];
  }

  // NOTE: TeammateIdle, TaskCompleted, and PostCompact are NOT accepted by
  // Claude Code's settings.json validator (rejected as "Invalid key in record").
  // Agent Teams coordination lives in claudeFlow.agentTeams.hooks instead.

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
