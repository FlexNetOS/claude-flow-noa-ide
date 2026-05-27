/**
 * Regression tests for #bug10 — four secondary defects in the settings.json
 * template emitted by `ruflo init`. Each lives in
 * `src/init/settings-generator.ts` and is a literal in the generated
 * settings object:
 *
 *   10.1 — `mcp__claude-flow__:*` (stray colon, matches zero tools)
 *   10.2 — `Read(./.env)` / `Read(./.env.*)` (project-relative; doesn't
 *          block .env files outside cwd)
 *   10.3 — `claudeFlow.adr.directory: '/docs/adr'` (resolves to filesystem
 *          root; EACCES on write)
 *   10.4 — `claudeFlow.ddd.directory: '/docs/ddd'` (same root-path bug)
 */

import { describe, expect, it } from 'vitest';

import { generateSettings } from '../src/init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

type GeneratedSettings = {
  permissions?: { allow?: string[]; deny?: string[] };
  claudeFlow?: {
    adr?: { directory?: string };
    ddd?: { directory?: string };
  };
};

function makeOptions() {
  // Use a per-project install path so we exercise the standard template
  // (the global-install branch only affects hook command paths, which
  // #bug10 does not touch).
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir: '/tmp/some-project',
    components: {
      ...DEFAULT_INIT_OPTIONS.components,
      settings: true,
      helpers: true,
    },
  };
}

describe('#bug10 — settings.json template defaults', () => {
  describe('10.1 — MCP permission glob has no stray colon', () => {
    it('permissions.allow contains "mcp__claude-flow__*" (no colon)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.allow).toContain('mcp__claude-flow__*');
    });

    it('permissions.allow does NOT contain the broken "mcp__claude-flow__:*" literal', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.allow).not.toContain('mcp__claude-flow__:*');
    });
  });

  describe('10.2 — .env deny rule is repo-wide, not project-relative', () => {
    it('permissions.deny contains "Read(**/.env*)" (matches .env files anywhere)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.deny).toContain('Read(**/.env*)');
    });

    it('permissions.deny does NOT contain the project-relative "Read(./.env)" literal', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.deny).not.toContain('Read(./.env)');
    });

    it('permissions.deny does NOT contain the project-relative "Read(./.env.*)" literal', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.deny).not.toContain('Read(./.env.*)');
    });
  });

  describe('10.3 — ADR directory is repo-relative, not filesystem root', () => {
    it('claudeFlow.adr.directory === "docs/adr" (no leading slash)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.claudeFlow?.adr?.directory).toBe('docs/adr');
    });

    it('claudeFlow.adr.directory does not start with "/" (would resolve to fs root)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.claudeFlow?.adr?.directory?.startsWith('/')).toBe(false);
    });
  });

  describe('10.4 — DDD directory is repo-relative, not filesystem root', () => {
    it('claudeFlow.ddd.directory === "docs/ddd" (no leading slash)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.claudeFlow?.ddd?.directory).toBe('docs/ddd');
    });

    it('claudeFlow.ddd.directory does not start with "/" (would resolve to fs root)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.claudeFlow?.ddd?.directory?.startsWith('/')).toBe(false);
    });
  });
});
