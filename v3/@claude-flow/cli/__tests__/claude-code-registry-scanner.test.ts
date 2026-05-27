/**
 * Regression tests for #bug22.1 — the filesystem scanner that discovers
 * user-installed Claude Code content (`agents/`, `skills/`, `commands/`,
 * `plugins/installed_plugins.json`).
 *
 * These tests build a temp `$CLAUDE_HOME` with a representative mix of
 * content shapes (nested agents, frontmatter, plugin JSON variants) and
 * assert the scanner finds and parses each correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  clearRegistryCache,
  resolveClaudeRoot,
  scanClaudeCodeRegistry,
} from '../src/registry/claude-code-registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-registry-test-'));
  clearRegistryCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistryCache();
  delete process.env.CLAUDE_HOME;
});

describe('scanClaudeCodeRegistry — agents', () => {
  it('discovers a top-level agent with frontmatter description', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'ceo.md'),
      [
        '---',
        'name: ceo',
        'description: Chief Executive — high-level strategy and delegation',
        '---',
        '',
        '# CEO Agent',
      ].join('\n'),
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.agents).toHaveLength(1);
    expect(reg.agents[0].name).toBe('ceo');
    expect(reg.agents[0].category).toBe('root');
    expect(reg.agents[0].description).toContain('Chief Executive');
    expect(reg.agents[0].path).toContain('ceo.md');
  });

  it('discovers nested agents and uses the first subdirectory as category', async () => {
    mkdirSync(join(tmpDir, 'agents', 'security'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'security', 'security-auditor.md'),
      '---\nname: security-auditor\ndescription: Audit code for CVEs\n---\n',
    );
    mkdirSync(join(tmpDir, 'agents', 'github', 'pr'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'github', 'pr', 'pr-manager.md'),
      '# pr-manager\n',
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.agents).toHaveLength(2);

    const auditor = reg.agents.find((a) => a.name === 'security-auditor');
    expect(auditor?.category).toBe('security');
    expect(auditor?.description).toBe('Audit code for CVEs');

    // pr-manager has no frontmatter — should still be discovered, just no description.
    const prManager = reg.agents.find((a) => a.name === 'pr-manager');
    expect(prManager?.category).toBe('github');
    expect(prManager?.description).toBeUndefined();
  });

  it('handles single-quoted and double-quoted frontmatter values', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'a.md'),
      "---\nname: 'a'\ndescription: \"a quoted desc\"\n---\n",
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.agents[0].name).toBe('a');
    expect(reg.agents[0].description).toBe('a quoted desc');
  });

  it('skips MIGRATION_SUMMARY.md and README.md', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'README.md'), '# readme\n');
    writeFileSync(join(tmpDir, 'agents', 'MIGRATION_SUMMARY.md'), '# migration\n');
    writeFileSync(join(tmpDir, 'agents', 'real.md'), '---\nname: real\n---\n');

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.agents).toHaveLength(1);
    expect(reg.agents[0].name).toBe('real');
  });

  it('does not throw on malformed frontmatter', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'broken.md'),
      '---\nthis is not key:value\n: missing key\n---\n# body\n',
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.agents).toHaveLength(1);
    expect(reg.agents[0].name).toBe('broken');
  });
});

describe('scanClaudeCodeRegistry — skills', () => {
  it('discovers skills via SKILL.md frontmatter', async () => {
    mkdirSync(join(tmpDir, 'skills', 'polymarket'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'polymarket', 'SKILL.md'),
      '---\nname: polymarket\ndescription: Polymarket trading expert\n---\n',
    );
    mkdirSync(join(tmpDir, 'skills', 'geo-audit'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'geo-audit', 'skill.md'),
      '---\nname: geo-audit\ndescription: GEO+SEO audit\n---\n',
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.skills).toHaveLength(2);
    const poly = reg.skills.find((s) => s.name === 'polymarket');
    expect(poly?.description).toContain('Polymarket');
    const geo = reg.skills.find((s) => s.name === 'geo-audit');
    expect(geo?.description).toContain('GEO+SEO');
  });

  it('skips skill subdirectories with no SKILL.md', async () => {
    mkdirSync(join(tmpDir, 'skills', 'incomplete'), { recursive: true });
    writeFileSync(join(tmpDir, 'skills', 'incomplete', 'README.md'), '# nope\n');

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.skills).toHaveLength(0);
  });
});

describe('scanClaudeCodeRegistry — commands', () => {
  it('discovers all .md files under commands/, excluding README', async () => {
    mkdirSync(join(tmpDir, 'commands', 'github'), { recursive: true });
    writeFileSync(join(tmpDir, 'commands', 'init.md'), '# init\n');
    writeFileSync(join(tmpDir, 'commands', 'status.md'), '# status\n');
    writeFileSync(join(tmpDir, 'commands', 'README.md'), '# readme\n');
    writeFileSync(join(tmpDir, 'commands', 'github', 'pr-manager.md'), '# pr\n');

    const reg = await scanClaudeCodeRegistry(tmpDir);
    const names = reg.commands.map((c) => c.name).sort();
    expect(names).toEqual(['init', 'pr-manager', 'status']);
  });
});

describe('scanClaudeCodeRegistry — plugins', () => {
  it('parses { plugins: [{ name, version }] } shape', async () => {
    mkdirSync(join(tmpDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: [
          { name: 'plugin-a', version: '1.0.0' },
          { name: 'plugin-b' },
        ],
      }),
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.plugins).toEqual([
      { name: 'plugin-a', version: '1.0.0' },
      { name: 'plugin-b', version: undefined },
    ]);
  });

  it('parses an array shape', async () => {
    mkdirSync(join(tmpDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify([{ name: 'arr-plugin', version: '2.1.0' }]),
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.plugins).toEqual([{ name: 'arr-plugin', version: '2.1.0' }]);
  });

  it('parses a name-keyed object shape', async () => {
    mkdirSync(join(tmpDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        'plugin-x': { version: '0.5.0' },
        'plugin-y': {},
      }),
    );

    const reg = await scanClaudeCodeRegistry(tmpDir);
    const names = reg.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['plugin-x', 'plugin-y']);
  });

  it('does not throw on invalid JSON', async () => {
    mkdirSync(join(tmpDir, 'plugins'), { recursive: true });
    writeFileSync(join(tmpDir, 'plugins', 'installed_plugins.json'), '{ invalid json');

    const reg = await scanClaudeCodeRegistry(tmpDir);
    expect(reg.plugins).toEqual([]);
  });
});

describe('scanClaudeCodeRegistry — root resolution + caching', () => {
  it('returns an empty (well-formed) registry when root does not exist', async () => {
    const reg = await scanClaudeCodeRegistry(join(tmpDir, 'does-not-exist'));
    expect(reg.agents).toEqual([]);
    expect(reg.skills).toEqual([]);
    expect(reg.commands).toEqual([]);
    expect(reg.plugins).toEqual([]);
    expect(typeof reg.scannedAt).toBe('number');
  });

  it('honors CLAUDE_HOME env var', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'env-agent.md'), '---\nname: env-agent\n---\n');

    process.env.CLAUDE_HOME = tmpDir;
    const reg = await scanClaudeCodeRegistry();
    expect(reg.agents).toHaveLength(1);
    expect(reg.agents[0].name).toBe('env-agent');
    expect(resolveClaudeRoot()).toBe(tmpDir);
  });

  it('caches results within the 60s TTL', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'a.md'), '---\nname: a\n---\n');

    const r1 = await scanClaudeCodeRegistry(tmpDir);
    const ts = r1.scannedAt;

    // Add a new agent — it should NOT show up because the cache is still fresh.
    writeFileSync(join(tmpDir, 'agents', 'b.md'), '---\nname: b\n---\n');
    const r2 = await scanClaudeCodeRegistry(tmpDir);
    expect(r2.scannedAt).toBe(ts);
    expect(r2.agents).toHaveLength(1);

    // Clearing the cache forces a fresh scan.
    clearRegistryCache();
    const r3 = await scanClaudeCodeRegistry(tmpDir);
    expect(r3.agents).toHaveLength(2);
  });
});
