/**
 * Bug 46 regression — `resolveInstallContext()` must NOT descend into a
 * child `.claude/` when the cwd is itself a `.claude` directory.
 *
 * The original STRAT-1 hoist (Tier 1, 2026-05-08) was designed to eliminate
 * the double-`.claude` path bug PR-1828 patched in three separate places.
 * But the resolver itself reproduced the bug under a degenerate condition:
 * when CWD = `~/.claude` AND a stray `~/.claude/.claude/settings.local.json`
 * existed (Claude Code creates this when invoked from inside ~/.claude),
 * the resolver returned `claudeRoot: ~/.claude/.claude` — wrong.
 *
 * This regression locks the fix: when cwd basename === ".claude" OR cwd
 * === homeClaude, claudeRoot IS cwd; we never descend into a child `.claude`.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallContext } from '@claude-flow/shared';

describe('resolveInstallContext — Bug 46 (cwd-is-.claude degenerate case)', () => {
  it('returns claudeRoot=cwd when cwd basename is ".claude"', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rufloctx-'));
    try {
      const fakeClaudeDir = join(tmpHome, '.claude');
      mkdirSync(fakeClaudeDir, { recursive: true });
      // Plant the stray double-.claude that would have triggered the bug.
      const strayChild = join(fakeClaudeDir, '.claude');
      mkdirSync(strayChild, { recursive: true });
      writeFileSync(join(strayChild, 'settings.local.json'), '{}', 'utf-8');

      const ctx = resolveInstallContext({ cwd: fakeClaudeDir, home: tmpHome });

      expect(ctx.claudeRoot).toBe(fakeClaudeDir);
      expect(ctx.claudeRoot).not.toBe(strayChild);
      expect(ctx.isGlobalInstall).toBe(true);
      expect(ctx.projectRoot).toBe(null);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns claudeRoot=cwd when cwd === homeClaude (canonical "I am in ~/.claude")', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rufloctx-'));
    try {
      const homeClaude = join(tmpHome, '.claude');
      mkdirSync(homeClaude, { recursive: true });

      // No stray child this time — pure canonical case.
      const ctx = resolveInstallContext({ cwd: homeClaude, home: tmpHome });

      expect(ctx.claudeRoot).toBe(homeClaude);
      expect(ctx.isGlobalInstall).toBe(true);
      expect(ctx.projectRoot).toBe(null);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('still returns claudeRoot=cwd/.claude when cwd is a real project (no regression)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rufloctx-'));
    try {
      const homeClaude = join(tmpHome, '.claude');
      const projectDir = join(tmpHome, 'my-project');
      const projectClaude = join(projectDir, '.claude');
      mkdirSync(homeClaude, { recursive: true });
      mkdirSync(projectClaude, { recursive: true });

      const ctx = resolveInstallContext({ cwd: projectDir, home: tmpHome });

      expect(ctx.claudeRoot).toBe(projectClaude);
      expect(ctx.isGlobalInstall).toBe(false);
      expect(ctx.projectRoot).toBe(projectDir);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('falls back to homeClaude when cwd has no .claude AND home does (no regression)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'rufloctx-'));
    try {
      const homeClaude = join(tmpHome, '.claude');
      const projectDir = join(tmpHome, 'plain-dir');
      mkdirSync(homeClaude, { recursive: true });
      mkdirSync(projectDir, { recursive: true });

      const ctx = resolveInstallContext({ cwd: projectDir, home: tmpHome });

      expect(ctx.claudeRoot).toBe(homeClaude);
      expect(ctx.isGlobalInstall).toBe(true);
      expect(ctx.projectRoot).toBe(null);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('respects RUFLO_INSTALL_CONTEXT_JSON env override (no regression)', () => {
    const original = process.env.RUFLO_INSTALL_CONTEXT_JSON;
    try {
      process.env.RUFLO_INSTALL_CONTEXT_JSON = JSON.stringify({
        packageRoot: '/x/pkg',
        claudeRoot: '/x/claude',
        dataDir: '/x/data',
        isGlobalInstall: true,
      });
      const ctx = resolveInstallContext({});
      expect(ctx.claudeRoot).toBe('/x/claude');
      expect(ctx.dataDir).toBe('/x/data');
      expect(ctx.isGlobalInstall).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.RUFLO_INSTALL_CONTEXT_JSON;
      } else {
        process.env.RUFLO_INSTALL_CONTEXT_JSON = original;
      }
    }
  });
});
