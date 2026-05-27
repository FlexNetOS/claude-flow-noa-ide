/**
 * Regression tests for #bug22.2 — `agent_list` and `guidance_capabilities`
 * must surface user-installed Claude Code content alongside the built-in
 * Ruflo registry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { agentTools } from '../src/mcp-tools/agent-tools.js';
import { guidanceTools } from '../src/mcp-tools/guidance-tools.js';
import { clearRegistryCache } from '../src/registry/claude-code-registry.js';

let tmpDir: string;
let prevClaudeHome: string | undefined;

function findTool(tools: { name: string }[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t as { name: string; handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-22-2-test-'));
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

describe('#bug22.2 — agent_list merges user-installed agents', () => {
  it('returns user agents tagged with source="user" when ~/.claude/agents has content', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'polymarket-analyzer.md'),
      '---\nname: polymarket-analyzer\ndescription: Polymarket trading advisor\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'agents', 'ceo.md'),
      '---\nname: ceo\ndescription: CEO agent\n---\n',
    );

    const agentList = findTool(agentTools, 'agent_list');
    const result = await agentList.handler({ includeTerminated: true });

    const agents = result.agents as Array<Record<string, unknown>>;
    const userOnly = agents.filter((a) => a.source === 'user');
    expect(userOnly.length).toBeGreaterThanOrEqual(2);

    const names = userOnly.map((a) => a.agentType).sort();
    expect(names).toContain('polymarket-analyzer');
    expect(names).toContain('ceo');

    const poly = userOnly.find((a) => a.agentType === 'polymarket-analyzer');
    expect(poly?.description).toContain('Polymarket');
    expect(poly?.agentId).toBe('user:polymarket-analyzer');

    expect(result.userInstalledTotal).toBeGreaterThanOrEqual(2);
    expect(typeof result.builtInTotal).toBe('number');
  });

  it('respects includeUserInstalled=false to restrict to running agents only', async () => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'foo.md'),
      '---\nname: foo\n---\n',
    );

    const agentList = findTool(agentTools, 'agent_list');
    const result = await agentList.handler({ includeUserInstalled: false });

    const agents = result.agents as Array<Record<string, unknown>>;
    expect(agents.every((a) => a.source !== 'user')).toBe(true);
    expect(result.userInstalledTotal).toBe(0);
  });

  it('filters user agents by domain (matches their `category` subdir)', async () => {
    mkdirSync(join(tmpDir, 'agents', 'security'), { recursive: true });
    mkdirSync(join(tmpDir, 'agents', 'github'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'security', 'sec-a.md'),
      '---\nname: sec-a\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'agents', 'github', 'gh-a.md'),
      '---\nname: gh-a\n---\n',
    );

    const agentList = findTool(agentTools, 'agent_list');
    const result = await agentList.handler({ domain: 'security' });

    const userOnly = (result.agents as Array<Record<string, unknown>>).filter((a) => a.source === 'user');
    const names = userOnly.map((a) => a.agentType);
    expect(names).toContain('sec-a');
    expect(names).not.toContain('gh-a');
  });

  it('degrades gracefully if scan throws (no CLAUDE_HOME content at all)', async () => {
    // Empty tmp dir — no agents/ subdir — scan returns empty registry.
    const agentList = findTool(agentTools, 'agent_list');
    const result = await agentList.handler({});
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.userInstalledTotal).toBe(0);
  });
});

describe('#bug22.2 — guidance_capabilities surfaces user-installed area', () => {
  beforeEach(() => {
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills', 'polymarket'), { recursive: true });
    mkdirSync(join(tmpDir, 'commands'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'agents', 'ceo.md'),
      '---\nname: ceo\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'agents', 'polybot-ops.md'),
      '---\nname: polybot-ops\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'skills', 'polymarket', 'SKILL.md'),
      '---\nname: polymarket\ndescription: Polymarket skill\n---\n',
    );
    writeFileSync(
      join(tmpDir, 'commands', 'osint.md'),
      '# /osint\n',
    );
  });

  it('summary view appends a "user-installed" entry with accurate counts', async () => {
    const cap = findTool(guidanceTools, 'guidance_capabilities');
    const result = await cap.handler({});
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text);

    const userArea = (parsed.areas as Array<Record<string, unknown>>).find(
      (a) => a.area === 'user-installed',
    );
    expect(userArea).toBeDefined();
    expect(userArea?.agentCount).toBe(2);
    expect(userArea?.skillCount).toBe(1);
    expect(parsed.totalAreas).toBeGreaterThanOrEqual(17); // 16 built-in + user-installed
  });

  it('area="user-installed" returns the detailed list of agents/skills/commands/plugins', async () => {
    const cap = findTool(guidanceTools, 'guidance_capabilities');
    const result = await cap.handler({ area: 'user-installed' });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.agents).toContain('ceo');
    expect(parsed.agents).toContain('polybot-ops');
    expect(parsed.skills).toContain('polymarket');
    expect(parsed.commands).toContain('osint');
  });

  it('detailed format includes user-installed alongside built-in catalog', async () => {
    const cap = findTool(guidanceTools, 'guidance_capabilities');
    const result = await cap.handler({ format: 'detailed' });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed['user-installed']).toBeDefined();
    expect(parsed['user-installed'].agents).toContain('ceo');
    // Built-in areas still present.
    expect(parsed['agent-management']).toBeDefined();
  });
});
