/**
 * Regression tests for #bug39 — `scanForeignMcpServers` discovers MCP
 * servers from `.mcp.json` files (plugin-bundled + claude.ai integrations)
 * and `guidance_capabilities` exposes them as a first-class capability area.
 *
 * Repro from the integration audit: plugin MCPs (chrome-devtools, mongodb,
 * pinecone, microsoft-learn, context7, playwright, prisma, …) and the
 * 12 claude.ai MCPs (HuggingFace, Notion, Gmail, Drive, Calendar, Canva)
 * were INVISIBLE to ruflo's routing — `guidance_capabilities` never
 * inspected the MCP registry. This bug surfaces them via a dedicated
 * `foreign-mcp-servers` area + a registry scanner with dedup + provenance
 * classification.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import {
  clearRegistryCache,
  scanClaudeCodeRegistry,
  scanForeignMcpServers,
} from '../src/registry/claude-code-registry.js';
import { guidanceCapabilities } from '../src/mcp-tools/guidance-tools.js';

let tmpClaudeRoot: string;
let tmpProjectCwd: string;
let tmpHomeOverride: string;
let prevClaudeHome: string | undefined;
let prevProjectCwd: string | undefined;
let prevHomeOverride: string | undefined;

beforeEach(() => {
  tmpClaudeRoot = mkdtempSync(join(tmpdir(), 'ruflo-bug39-claude-'));
  tmpProjectCwd = mkdtempSync(join(tmpdir(), 'ruflo-bug39-cwd-'));
  tmpHomeOverride = mkdtempSync(join(tmpdir(), 'ruflo-bug39-home-'));
  prevClaudeHome = process.env.CLAUDE_HOME;
  prevProjectCwd = process.env.RUFLO_MCP_PROJECT_CWD;
  prevHomeOverride = process.env.RUFLO_MCP_HOME_OVERRIDE;
  process.env.CLAUDE_HOME = tmpClaudeRoot;
  // Inject project cwd via env (vitest workers forbid process.chdir).
  process.env.RUFLO_MCP_PROJECT_CWD = tmpProjectCwd;
  // Redirect `~/.mcp.json` to an isolated path so the real user config
  // (which has dozens of plugin/claude.ai MCPs) doesn't pollute counts.
  process.env.RUFLO_MCP_HOME_OVERRIDE = tmpHomeOverride;
  clearRegistryCache();
});

afterEach(() => {
  rmSync(tmpClaudeRoot, { recursive: true, force: true });
  rmSync(tmpProjectCwd, { recursive: true, force: true });
  rmSync(tmpHomeOverride, { recursive: true, force: true });
  if (prevClaudeHome === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = prevClaudeHome;
  }
  if (prevProjectCwd === undefined) {
    delete process.env.RUFLO_MCP_PROJECT_CWD;
  } else {
    process.env.RUFLO_MCP_PROJECT_CWD = prevProjectCwd;
  }
  if (prevHomeOverride === undefined) {
    delete process.env.RUFLO_MCP_HOME_OVERRIDE;
  } else {
    process.env.RUFLO_MCP_HOME_OVERRIDE = prevHomeOverride;
  }
  clearRegistryCache();
});

describe('#bug39 — scanForeignMcpServers', () => {
  it('returns an empty list when no .mcp.json files exist', () => {
    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers).toEqual([]);
  });

  it('classifies ruflo / claude-flow / flow-nexus / ruv-swarm as source: "user"', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'claude-flow': { command: 'npx', args: ['-y', '@claude-flow/cli@latest'] },
          'ruflo': { command: 'npx', args: ['-y', 'ruflo'] },
          'flow-nexus': { command: 'npx', args: ['flow-nexus'] },
          'ruv-swarm': { command: 'node', args: ['ruv-swarm.js'] },
        },
      }),
    );

    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers).toHaveLength(4);
    for (const s of servers) {
      expect(s.source).toBe('user');
    }
  });

  it('classifies plugin MCPs (mongodb, pinecone, context7, chrome-devtools) as source: "plugin"', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          mongodb: { command: 'mongodb-mcp', args: [] },
          pinecone: { command: 'pinecone-mcp', args: [] },
          context7: { command: 'context7', args: [] },
          'chrome-devtools': { command: 'chrome-devtools-mcp', args: [] },
        },
      }),
    );

    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    const byName = Object.fromEntries(servers.map(s => [s.name, s.source]));
    expect(byName).toEqual({
      mongodb: 'plugin',
      pinecone: 'plugin',
      context7: 'plugin',
      'chrome-devtools': 'plugin',
    });
  });

  it('classifies claude.ai integrations as source: "claude-ai"', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          claude_ai_Gmail: { command: 'gmail-mcp', args: [] },
          claude_ai_Notion: { command: 'notion-mcp', args: [] },
          claude_ai_Hugging_Face: { command: 'hf-mcp', args: [] },
          'claude-ai-canva': { command: 'canva-mcp', args: [] },
        },
      }),
    );

    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers).toHaveLength(4);
    for (const s of servers) {
      expect(s.source).toBe('claude-ai');
    }
  });

  it('dedups across overlapping .mcp.json files (earlier file wins)', () => {
    // Three sources with overlapping names. Order: ~/.mcp.json,
    // ~/.claude/.mcp.json, project .mcp.json. We can't easily mock
    // ~/.mcp.json without polluting the real homedir, so we test the
    // ordering between claude-root and project-cwd which are both
    // controllable.
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          mongodb: { command: 'wins-claude-root' },
          pinecone: { command: 'wins-claude-root' },
        },
      }),
    );
    writeFileSync(
      join(tmpProjectCwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          // mongodb appears in both — claude-root should win.
          mongodb: { command: 'should-NOT-win-project' },
          // unique to project — should still be picked up.
          context7: { command: 'project-only' },
        },
      }),
    );

    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    const byName = Object.fromEntries(servers.map(s => [s.name, s.command]));
    expect(byName.mongodb).toBe('wins-claude-root');
    expect(byName.pinecone).toBe('wins-claude-root');
    expect(byName.context7).toBe('project-only');
    // Three unique names, no duplicates.
    expect(servers.length).toBe(3);
  });

  it('captures command + args fields raw (and never executes them)', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          mongodb: { command: 'docker', args: ['run', '-i', 'mongodb-mcp:latest'] },
        },
      }),
    );

    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers[0].command).toBe('docker');
    expect(servers[0].args).toEqual(['run', '-i', 'mongodb-mcp:latest']);
    expect(servers[0].origin).toBe(join(tmpClaudeRoot, '.mcp.json'));
  });

  it('does not throw on malformed .mcp.json', () => {
    writeFileSync(join(tmpClaudeRoot, '.mcp.json'), '{ invalid json');
    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers).toEqual([]);
  });

  it('does not throw when mcpServers field is missing', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({ unrelated: { foo: 'bar' } }),
    );
    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers).toEqual([]);
  });

  it('filters non-string args defensively', () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          x: { command: 'cmd', args: ['ok', 42, null, 'also-ok'] },
        },
      }),
    );
    const servers = scanForeignMcpServers(tmpClaudeRoot, tmpProjectCwd);
    expect(servers[0].args).toEqual(['ok', 'also-ok']);
  });
});

describe('#bug39 — scanClaudeCodeRegistry exposes foreignMcpServers', () => {
  it('includes foreignMcpServers field in the registry result', async () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'claude-flow': { command: 'cf' },
          mongodb: { command: 'mdb' },
          claude_ai_Gmail: { command: 'gm' },
        },
      }),
    );
    const reg = await scanClaudeCodeRegistry(tmpClaudeRoot);
    expect(Array.isArray(reg.foreignMcpServers)).toBe(true);
    expect(reg.foreignMcpServers.length).toBe(3);
    const sources = reg.foreignMcpServers.map(s => s.source).sort();
    expect(sources).toEqual(['claude-ai', 'plugin', 'user']);
  });

  it('still scans foreign MCPs even when the claude root does not exist', async () => {
    // Write a .mcp.json under the project cwd only; ~/.claude/ might be
    // entirely absent on a fresh install, but plugin MCPs should still
    // be discoverable.
    writeFileSync(
      join(tmpProjectCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { mongodb: { command: 'mdb' } } }),
    );
    const missingRoot = join(tmpClaudeRoot, 'does-not-exist-subdir');
    const reg = await scanClaudeCodeRegistry(missingRoot);
    expect(reg.agents).toEqual([]);
    expect(reg.foreignMcpServers.find(s => s.name === 'mongodb')).toBeDefined();
  });
});

describe('#bug39 — guidance_capabilities exposes foreign-mcp-servers area', () => {
  it('summary view includes foreign-mcp-servers area with serverNames preview', async () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          mongodb: { command: 'mdb' },
          pinecone: { command: 'pc' },
          context7: { command: 'c7' },
          claude_ai_Gmail: { command: 'gm' },
          // user's own — should NOT appear in foreign list.
          'claude-flow': { command: 'cf' },
        },
      }),
    );

    const result = await guidanceCapabilities.handler({}) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as {
      areas: Array<{ area: string; serverCount?: number; serverNames?: string[] }>;
    };

    const foreignArea = parsed.areas.find(a => a.area === 'foreign-mcp-servers');
    expect(foreignArea).toBeDefined();
    expect(foreignArea!.serverCount).toBe(4); // claude-flow excluded
    const names = foreignArea!.serverNames!;
    expect(names).toContain('mongodb');
    expect(names).toContain('pinecone');
    expect(names).toContain('context7');
    expect(names).toContain('claude_ai_Gmail');
    expect(names).not.toContain('claude-flow');
  });

  it('detailed view returns full server list with sources', async () => {
    writeFileSync(
      join(tmpClaudeRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          mongodb: { command: 'mdb' },
          claude_ai_Gmail: { command: 'gm' },
        },
      }),
    );

    const result = await guidanceCapabilities.handler({ area: 'foreign-mcp-servers' }) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as {
      servers: Array<{ name: string; source: string; command?: string }>;
      serverCount: number;
    };

    expect(parsed.serverCount).toBe(2);
    const byName = Object.fromEntries(parsed.servers.map(s => [s.name, s]));
    expect(byName.mongodb.source).toBe('plugin');
    expect(byName.claude_ai_Gmail.source).toBe('claude-ai');
  });

  it('returns an empty area gracefully when no foreign MCPs exist', async () => {
    const result = await guidanceCapabilities.handler({}) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as {
      areas: Array<{ area: string; serverCount?: number }>;
    };
    const foreignArea = parsed.areas.find(a => a.area === 'foreign-mcp-servers');
    expect(foreignArea).toBeDefined();
    expect(foreignArea!.serverCount).toBe(0);
  });

  it('lists foreign-mcp-servers in the available areas error message', async () => {
    const result = await guidanceCapabilities.handler({ area: 'definitely-not-real' }) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { available: string };
    expect(parsed.available).toContain('foreign-mcp-servers');
  });
});

// homedir is imported but only referenced inside the docstring of
// resolveMcpJsonPaths — silence "unused import" with a no-op assertion.
// (Tests can't easily mock ~/.mcp.json without polluting the real $HOME.)
void homedir;
