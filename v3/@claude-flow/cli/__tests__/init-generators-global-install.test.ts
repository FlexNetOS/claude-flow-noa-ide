/**
 * Regression tests for #bug1 (helpers-generator emits resolveFlowPath) and
 * #bug8 (settings-generator emits absolute $HOME/.claude/helpers/ paths
 * under a global install).
 *
 * Both bugs only manifest when Ruflo is installed into `~/.claude` itself
 * (`ruflo init --global`). Per-project install behavior must remain
 * byte-identical to the previous baseline.
 */

import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';

import {
  generateMemoryHelper,
  generateSessionManager,
  generateIntelligenceStub,
  generateCrossPlatformSessionManager,
} from '../src/init/helpers-generator.js';
import { generateSettings, generateSettingsJson } from '../src/init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

describe('#bug1 — generated helpers use resolveFlowPath instead of cwd-relative literals', () => {
  it('memory helper injects resolveFlowPath and uses it for MEMORY_DIR', () => {
    const rendered = generateMemoryHelper();

    // Helper function definition is emitted (so the runtime helper can call it)
    expect(rendered).toContain('function resolveFlowPath');
    // MEMORY_DIR is computed via resolveFlowPath, not path.join(process.cwd(), …)
    expect(rendered).toContain("resolveFlowPath('.claude-flow', 'data')");
    // Old CWD-relative literal must be gone (would re-introduce the fragmentation bug)
    expect(rendered).not.toContain("path.join(process.cwd(), '.claude-flow', 'data')");
  });

  it('session manager injects resolveFlowPath and uses it for SESSION_DIR', () => {
    const rendered = generateSessionManager();
    expect(rendered).toContain('function resolveFlowPath');
    expect(rendered).toContain("resolveFlowPath('.claude-flow', 'sessions')");
    expect(rendered).not.toContain("path.join(process.cwd(), '.claude-flow', 'sessions')");
  });

  it('intelligence stub injects resolveFlowPath for DATA_DIR, SESSION_DIR, and bootstrap candidates', () => {
    const rendered = generateIntelligenceStub();
    expect(rendered).toContain('function resolveFlowPath');
    expect(rendered).toContain("resolveFlowPath('.claude-flow', 'data')");
    expect(rendered).toContain("resolveFlowPath('.claude-flow', 'sessions')");
    expect(rendered).toContain('resolveFlowPath(".claude-flow", "memory")');
    expect(rendered).toContain('resolveFlowPath(".claude", "memory")');
    // The PENDING_PATH must be derived from DATA_DIR (which now uses resolveFlowPath)
    expect(rendered).toContain("path.join(DATA_DIR, 'pending-insights.jsonl')");
    // No remaining CWD-relative .claude-flow literal
    expect(rendered).not.toContain("path.join(process.cwd(), '.claude-flow'");
  });

  it('cross-platform session manager prefers resolveFlowPath for localDir', () => {
    const rendered = generateCrossPlatformSessionManager();
    expect(rendered).toContain('function resolveFlowPath');
    expect(rendered).toContain("resolveFlowPath('.claude-flow', 'sessions')");
    // Old CWD-relative localDir literal must be gone
    expect(rendered).not.toContain(
      "const localDir = path.join(process.cwd(), '.claude-flow', 'sessions')",
    );
  });

  it('resolveFlowPath helper signature matches the documented contract', () => {
    // Spot-check: the helper signature is `function resolveFlowPath(...segs)`,
    // and it must reference both process.cwd() (for the per-project branch)
    // and os.homedir() (for the global-install fallback).
    const rendered = generateMemoryHelper();
    expect(rendered).toMatch(/function\s+resolveFlowPath\s*\(\.\.\.segs\)/);
    expect(rendered).toContain('process.cwd()');
    expect(rendered).toContain('os.homedir()');
    // Stripped redundant `.claude` segment for the global-install branch
    expect(rendered).toContain("parts[0] === '.claude'");
  });
});

describe('#bug8 — settings-generator emits absolute $HOME/.claude/helpers/ for global install', () => {
  function makeOptions(targetDir: string) {
    return {
      ...DEFAULT_INIT_OPTIONS,
      targetDir,
      // Explicitly enable hooks + statusline so they're emitted into settings
      components: {
        ...DEFAULT_INIT_OPTIONS.components,
        settings: true,
        helpers: true,
      },
      statusline: { ...DEFAULT_INIT_OPTIONS.statusline, enabled: true },
    };
  }

  it('per-project install keeps the historical ${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/ path', () => {
    const options = makeOptions('/tmp/some-project');
    const settings = generateSettings(options) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine?: { command: string };
    };

    expect(settings.hooks).toBeDefined();
    const sample = settings.hooks!.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    // eslint-disable-next-line no-template-curly-in-string
    expect(sample).toContain('${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/hook-handler.cjs');
    // Should NOT be using $HOME for per-project install
    expect(sample).not.toContain('$HOME/.claude/helpers/');

    expect(settings.statusLine?.command ?? '').toContain(
      // eslint-disable-next-line no-template-curly-in-string
      '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/statusline.cjs',
    );
  });

  it('global install (~/.claude) emits $HOME/.claude/helpers/ paths and drops env-var indirection', () => {
    const home = os.homedir();
    const options = makeOptions(path.join(home, '.claude'));
    const settings = generateSettings(options) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine?: { command: string };
    };

    // Sanity: settings.json string contains the absolute path marker
    const json = generateSettingsJson(options);
    expect(json).toContain('$HOME/.claude/helpers/');
    // No double-.claude path (the bug we're guarding against)
    expect(json).not.toContain('/.claude/.claude/helpers/');
    // No leftover ${CLAUDE_PROJECT_DIR:-.}/.claude prefix anywhere
    // eslint-disable-next-line no-template-curly-in-string
    expect(json).not.toContain('${CLAUDE_PROJECT_DIR:-.}/.claude/');

    // Spot-check a few hook commands
    const preBash = settings.hooks!.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    expect(preBash).toContain('$HOME/.claude/helpers/hook-handler.cjs');
    expect(preBash).toContain('pre-bash');

    const sessionStart = settings.hooks!.SessionStart?.[0]?.hooks ?? [];
    const restoreCmd = (sessionStart[0] as { command: string } | undefined)?.command ?? '';
    const importCmd = (sessionStart[1] as { command: string } | undefined)?.command ?? '';
    expect(restoreCmd).toContain('$HOME/.claude/helpers/hook-handler.cjs');
    expect(importCmd).toContain('$HOME/.claude/helpers/auto-memory-hook.mjs');

    // Statusline command also goes absolute
    expect(settings.statusLine?.command ?? '').toContain(
      '$HOME/.claude/helpers/statusline.cjs',
    );
  });

  it('a subdirectory under ~/.claude is also treated as global install', () => {
    const home = os.homedir();
    // Some installers may target ~/.claude/foo — still global-rooted
    const options = makeOptions(path.join(home, '.claude', 'foo'));
    const json = generateSettingsJson(options);
    expect(json).toContain('$HOME/.claude/helpers/');
    expect(json).not.toContain('/.claude/.claude/helpers/');
  });
});
