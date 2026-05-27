/**
 * Regression tests for #bug33 (AIDefence wiring) and #bug34 (permissions
 * tightening) in `src/init/settings-generator.ts`.
 *
 * Bug 33 — `aidefence_scan` was a registered MCP tool but never invoked at
 * runtime (the model could call it but no hook fired it). The fix adds a
 * `aidefence-scan` hook entry to UserPromptSubmit AND PreToolUse:WebFetch
 * matchers so every prompt and every fetched URL is screened before reaching
 * the model.
 *
 * Bug 34 — the historical `permissions.allow` used bare prefix wildcards
 * (`Bash(npx claude-flow*)`) wide enough that `npx claude-flow-anything --eval`
 * slipped through. Replaced with exact-subcommand grants. Deny list also
 * extended to cover universally dangerous patterns (eval bypass, pipe-to-shell,
 * download-and-exec, total wipe, fork bomb) and broader credential globs.
 */

import { describe, expect, it } from 'vitest';

import { generateSettings } from '../src/init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};

type GeneratedSettings = {
  permissions?: { allow?: string[]; deny?: string[] };
  hooks?: {
    UserPromptSubmit?: HookEntry[];
    PreToolUse?: HookEntry[];
  };
};

function makeOptions() {
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

describe('#bug34 — permissions template tightening', () => {
  describe('allow list uses exact-subcommand grants (no bare prefix wildcards)', () => {
    it('drops the dangerous "Bash(npx claude-flow*)" prefix wildcard', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.allow).not.toContain('Bash(npx claude-flow*)');
      expect(settings.permissions?.allow).not.toContain('Bash(npx @claude-flow*)');
      expect(settings.permissions?.allow).not.toContain('Bash(npx ruflo*)');
    });

    it('contains exact-subcommand grants for ruflo doctor / init / memory / swarm / daemon / hooks', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const allow = settings.permissions?.allow ?? [];
      expect(allow).toContain('Bash(npx ruflo doctor)');
      expect(allow).toContain('Bash(npx ruflo doctor --fix)');
      expect(allow).toContain('Bash(npx ruflo init)');
      expect(allow).toContain('Bash(npx ruflo init --*)');
      expect(allow).toContain('Bash(npx ruflo memory *)');
      expect(allow).toContain('Bash(npx ruflo swarm *)');
      expect(allow).toContain('Bash(npx ruflo daemon *)');
      expect(allow).toContain('Bash(npx ruflo hooks *)');
    });

    it('contains the same exact-subcommand grants for the legacy claude-flow CLI', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const allow = settings.permissions?.allow ?? [];
      expect(allow).toContain('Bash(npx claude-flow doctor)');
      expect(allow).toContain('Bash(npx claude-flow init)');
      expect(allow).toContain('Bash(npx claude-flow memory *)');
      expect(allow).toContain('Bash(npx claude-flow swarm *)');
    });

    it('scopes node script execution to ~/.claude/helpers/ (not arbitrary .claude/* paths)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const allow = settings.permissions?.allow ?? [];
      expect(allow).toContain('Bash(node $HOME/.claude/helpers/*)');
      // The old permissive `Bash(node .claude/*)` wildcard is gone — it
      // allowed running any *.js file in any project's .claude dir.
      expect(allow).not.toContain('Bash(node .claude/*)');
    });

    it('keeps the corrected MCP allow glob from #bug10.1', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.allow).toContain('mcp__claude-flow__*');
    });
  });

  describe('deny list covers universally dangerous patterns', () => {
    it('blocks .env files (existing) plus credentials.json and .ssh keys', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const deny = settings.permissions?.deny ?? [];
      expect(deny).toContain('Read(**/.env*)');
      expect(deny).toContain('Read(**/credentials.json)');
      expect(deny).toContain('Read(**/.ssh/id_*)');
    });

    it('blocks --eval bypass (Node, Ruby, etc. arbitrary code execution)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      expect(settings.permissions?.deny).toContain('Bash(*--eval*)');
    });

    it('blocks pipe-to-shell patterns (curl|sh, wget|sh, generic |sh / |bash)', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const deny = settings.permissions?.deny ?? [];
      expect(deny).toContain('Bash(*| sh*)');
      expect(deny).toContain('Bash(*| bash*)');
      expect(deny).toContain('Bash(curl *| sh*)');
      expect(deny).toContain('Bash(wget *| sh*)');
    });

    it('blocks the "rm -rf /" total wipe and the classic fork bomb', () => {
      const settings = generateSettings(makeOptions()) as GeneratedSettings;
      const deny = settings.permissions?.deny ?? [];
      expect(deny).toContain('Bash(rm -rf /*)');
      expect(deny).toContain('Bash(:(){ :|:& };:*)');
    });
  });
});

describe('#bug33 — aidefence_scan wired into hooks', () => {
  it('UserPromptSubmit fires aidefence-scan before the routing hook', () => {
    const settings = generateSettings(makeOptions()) as GeneratedSettings;
    const ups = settings.hooks?.UserPromptSubmit ?? [];
    expect(ups.length).toBeGreaterThan(0);
    const commands = ups[0]?.hooks?.map(h => h.command) ?? [];
    // The scan hook MUST exist and MUST run before the route hook so a flagged
    // prompt blocks before token-spend on routing.
    const scanIdx = commands.findIndex(c => c.includes('aidefence-scan'));
    const routeIdx = commands.findIndex(c => c.includes(' route'));
    expect(scanIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(scanIdx);
  });

  it('PreToolUse contains a WebFetch matcher that fires aidefence-scan', () => {
    const settings = generateSettings(makeOptions()) as GeneratedSettings;
    const pre = settings.hooks?.PreToolUse ?? [];
    const webFetchEntry = pre.find(e => e.matcher === 'WebFetch');
    expect(webFetchEntry).toBeDefined();
    const cmd = webFetchEntry?.hooks?.[0]?.command ?? '';
    expect(cmd).toContain('aidefence-scan');
    // Tight 5s timeout — the scan is local + sync via quickScan().
    expect(webFetchEntry?.hooks?.[0]?.timeout).toBeLessThanOrEqual(5000);
  });

  it('aidefence-scan command points at the hook-handler.cjs (not a stub binary)', () => {
    const settings = generateSettings(makeOptions()) as GeneratedSettings;
    const ups = settings.hooks?.UserPromptSubmit ?? [];
    const scanCmd = ups[0]?.hooks?.find(h => h.command.includes('aidefence-scan'))?.command ?? '';
    expect(scanCmd).toContain('hook-handler.cjs');
    expect(scanCmd).toContain('aidefence-scan');
  });
});
