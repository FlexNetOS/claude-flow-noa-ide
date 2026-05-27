/**
 * Regression tests for #bug22.3 — `hooks_route` must consider
 * user-installed skills/agents from ~/.claude/ when scoring routing
 * candidates, not just the hardcoded built-in pattern catalog.
 *
 * Repro from the bug brief: a task like "audit polymarket trading
 * positions" should NOT route blindly to swarm-specialist / coordinator
 * / architect when the user has `polymarket-analyzer`, `polymarket`,
 * and `polybot-ops` installed on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hooksRoute } from '../src/mcp-tools/hooks-tools.js';
import { clearRegistryCache } from '../src/registry/claude-code-registry.js';

let tmpDir: string;
let prevClaudeHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-22-3-test-'));
  prevClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = tmpDir;
  clearRegistryCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (prevClaudeHome === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = prevClaudeHome;
  }
  clearRegistryCache();
});

function setupPolymarketSkills() {
  mkdirSync(join(tmpDir, 'skills', 'polymarket'), { recursive: true });
  mkdirSync(join(tmpDir, 'skills', 'polymarket-analyzer'), { recursive: true });
  mkdirSync(join(tmpDir, 'agents'), { recursive: true });

  writeFileSync(
    join(tmpDir, 'skills', 'polymarket', 'SKILL.md'),
    [
      '---',
      'name: polymarket',
      'description: Polymarket prediction market trading bot, market making, CLOB API, conditional tokens, neg risk markets, position management',
      '---',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(tmpDir, 'skills', 'polymarket-analyzer', 'SKILL.md'),
    [
      '---',
      'name: polymarket-analyzer',
      'description: Polymarket trading advisor with 24h performance reports, news correlation, trend detection, position close, strategy toggles',
      '---',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(tmpDir, 'agents', 'polybot-ops.md'),
    [
      '---',
      'name: polybot-ops',
      'description: Polymarket bot operations — assign positions to strategies, check wallets, manage capital, query live markets',
      '---',
      '',
    ].join('\n'),
  );
}

describe('#bug22.3 — hooks_route surfaces user-installed skills as candidates', () => {
  it('the polymarket repro task returns user-installed matches in the response', async () => {
    setupPolymarketSkills();

    const result = (await hooksRoute.handler({
      task: 'audit polymarket trading positions and find high-EV bets',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const userMatches = result.userInstalledMatches as Array<{ name: string; score: number; type: string }>;
    expect(Array.isArray(userMatches)).toBe(true);
    expect(userMatches.length).toBeGreaterThan(0);

    const names = userMatches.map((m) => m.name);
    // At least one of the three obvious matches should appear.
    const expectedNames = ['polymarket', 'polymarket-analyzer', 'polybot-ops'];
    const overlap = names.filter((n) => expectedNames.includes(n));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('a strong polymarket user match is promoted to primaryAgent when above the threshold', async () => {
    setupPolymarketSkills();

    const result = (await hooksRoute.handler({
      task: 'polymarket trading positions polymarket-analyzer',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const primary = result.primaryAgent as { type: string; source?: string };
    // With multiple direct hits on `polymarket` (name token, weight 2×) we
    // exceed the threshold and the user match should win primary.
    expect(primary.source).toBe('user');
    expect(['polymarket', 'polymarket-analyzer', 'polybot-ops']).toContain(primary.type);
    expect(result.matchedPattern).toMatch(/^user-(skill|agent):/);
  });

  it('a weak/no user match keeps the primary agent built-in (does not corrupt routing)', async () => {
    // No user content at all — empty CLAUDE_HOME.
    const result = (await hooksRoute.handler({
      task: 'fix a bug in the validation logic',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const primary = result.primaryAgent as { type: string; source?: string };
    expect(primary.source ?? 'built-in').toBe('built-in');
    // Built-in routing should still produce a real agent type.
    expect(typeof primary.type).toBe('string');
    expect(primary.type.length).toBeGreaterThan(0);
    // userInstalledMatches must always be present, just empty.
    expect(result.userInstalledMatches).toEqual([]);
  });

  it('matches kali-osint skills against an osint-username task', async () => {
    mkdirSync(join(tmpDir, 'skills', 'kali-osint-username'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills', 'kali-osint-email'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'kali-osint-username', 'SKILL.md'),
      '---\nname: kali-osint-username\ndescription: Use when the OSINT target is a username/handle. Runs sherlock + maigret + blackbird.\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'skills', 'kali-osint-email', 'SKILL.md'),
      '---\nname: kali-osint-email\ndescription: Use when the OSINT target is an email address.\n---\n',
    );

    const result = (await hooksRoute.handler({
      task: 'run osint on the username @j_doe92',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const userMatches = result.userInstalledMatches as Array<{ name: string; score: number }>;
    const usernameMatch = userMatches.find((m) => m.name === 'kali-osint-username');
    expect(usernameMatch).toBeDefined();
    // The username-specific skill should outscore the email-specific one
    // because of the `username` token hit.
    const emailMatch = userMatches.find((m) => m.name === 'kali-osint-email');
    if (emailMatch) {
      expect(usernameMatch!.score).toBeGreaterThanOrEqual(emailMatch.score);
    }
  });

  it('does not throw when CLAUDE_HOME is set to a non-existent path', async () => {
    process.env.CLAUDE_HOME = join(tmpDir, 'nope');
    clearRegistryCache();

    const result = (await hooksRoute.handler({
      task: 'do something simple',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    // Routing should still work; user matches just empty.
    expect(result.userInstalledMatches).toEqual([]);
    expect(result.primaryAgent).toBeDefined();
  });
});
