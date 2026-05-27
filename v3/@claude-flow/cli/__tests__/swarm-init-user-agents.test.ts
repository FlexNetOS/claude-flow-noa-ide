/**
 * Regression tests for #bug23 — `swarm_init` must consult the
 * claude-code-registry (~/.claude/agents, ~/.claude/skills) when a
 * `task` is provided, so the swarm can populate slots with
 * user-installed content (e.g. `polymarket-analyzer` for trading tasks)
 * rather than picking blindly from the built-in catalog.
 *
 * Repro from the bug brief: `swarm_init({task: "polymarket trading
 * audit", strategy: "specialized"})` must return `recommendedAgents`
 * that contains the user's polymarket-* entries.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { swarmTools } from '../src/mcp-tools/swarm-tools.js';
import { clearRegistryCache } from '../src/registry/claude-code-registry.js';

let tmpDir: string;
let prevClaudeHome: string | undefined;
let prevProjectCwd: string | undefined;
let projectDir: string;

function findTool(name: string) {
  const t = swarmTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t as {
    name: string;
    handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-23-test-'));
  prevClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = tmpDir;

  // Each test gets its own scratch project cwd so the persisted
  // swarm-state.json files don't collide between tests. We use
  // CLAUDE_FLOW_CWD (honored by getProjectCwd()) instead of
  // process.chdir() because vitest workers don't support chdir.
  prevProjectCwd = process.env.CLAUDE_FLOW_CWD;
  projectDir = mkdtempSync(join(tmpdir(), 'ruflo-23-proj-'));
  process.env.CLAUDE_FLOW_CWD = projectDir;

  clearRegistryCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  if (prevClaudeHome === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = prevClaudeHome;
  }
  if (prevProjectCwd === undefined) {
    delete process.env.CLAUDE_FLOW_CWD;
  } else {
    process.env.CLAUDE_FLOW_CWD = prevProjectCwd;
  }
  clearRegistryCache();
});

function setupPolymarketContent() {
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

describe('#bug23 — swarm_init consults user-installed registry for agent selection', () => {
  it('returns recommendedAgents containing polymarket-* user content for a polymarket trading audit task', async () => {
    setupPolymarketContent();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit and position review',
      strategy: 'specialized',
    });

    expect(result.success).toBe(true);
    expect(result.registryConsulted).toBe(true);
    expect(result.autoPickAgents).toBe(true);

    const recommended = result.recommendedAgents as Array<{ name: string; type: string; source: string; score: number }>;
    expect(Array.isArray(recommended)).toBe(true);
    expect(recommended.length).toBeGreaterThan(0);

    // All recommendations must be tagged source="user".
    expect(recommended.every((r) => r.source === 'user')).toBe(true);

    // At least one of the obvious polymarket matches must show up.
    const names = recommended.map((r) => r.name);
    const overlap = names.filter((n) =>
      ['polymarket', 'polymarket-analyzer', 'polybot-ops'].includes(n),
    );
    expect(overlap.length).toBeGreaterThan(0);

    // Recommendations should be sorted by descending score.
    for (let i = 1; i < recommended.length; i++) {
      expect(recommended[i - 1].score).toBeGreaterThanOrEqual(recommended[i].score);
    }
  });

  it('omits recommendedAgents (and skips registry scan) when no task is provided — backward-compatible', async () => {
    setupPolymarketContent();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({});

    expect(result.success).toBe(true);
    expect(result.registryConsulted).toBe(false);
    expect(result.autoPickAgents).toBe(false);
    expect(result.recommendedAgents).toEqual([]);

    // Existing fields callers depend on must still be present.
    expect(typeof result.swarmId).toBe('string');
    expect(result.topology).toBe('hierarchical-mesh');
    expect(result.strategy).toBe('specialized');
  });

  it('does not auto-pick when strategy is "balanced" by default (only specialized triggers it)', async () => {
    setupPolymarketContent();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit',
      strategy: 'balanced',
    });

    expect(result.success).toBe(true);
    expect(result.autoPickAgents).toBe(false);
    expect(result.registryConsulted).toBe(false);
    expect(result.recommendedAgents).toEqual([]);
  });

  it('auto-picks even with non-specialized strategy when autoPickAgents=true is explicit', async () => {
    setupPolymarketContent();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit',
      strategy: 'balanced',
      autoPickAgents: true,
    });

    expect(result.success).toBe(true);
    expect(result.autoPickAgents).toBe(true);
    expect(result.registryConsulted).toBe(true);
    const recommended = result.recommendedAgents as Array<{ name: string }>;
    expect(recommended.length).toBeGreaterThan(0);
  });

  it('respects autoPickAgents=false explicit opt-out, even when task+strategy=specialized', async () => {
    setupPolymarketContent();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit',
      strategy: 'specialized',
      autoPickAgents: false,
    });

    expect(result.success).toBe(true);
    expect(result.autoPickAgents).toBe(false);
    expect(result.registryConsulted).toBe(false);
    expect(result.recommendedAgents).toEqual([]);
  });

  it('returns an empty recommendedAgents (not crash) when the registry path is missing', async () => {
    process.env.CLAUDE_HOME = join(tmpDir, 'does-not-exist');
    clearRegistryCache();

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit',
      strategy: 'specialized',
    });

    expect(result.success).toBe(true);
    // We still attempted the scan (registryConsulted=true) — just nothing was found.
    expect(result.registryConsulted).toBe(true);
    expect(result.recommendedAgents).toEqual([]);
  });

  it('caps the number of recommendedAgents at maxAgents', async () => {
    // Spawn many user skills with a shared keyword so they all match.
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
    for (let i = 0; i < 10; i++) {
      mkdirSync(join(tmpDir, 'skills', `polymarket-skill-${i}`), { recursive: true });
      writeFileSync(
        join(tmpDir, 'skills', `polymarket-skill-${i}`, 'SKILL.md'),
        `---\nname: polymarket-skill-${i}\ndescription: Polymarket trading skill ${i}\n---\n`,
      );
    }

    const swarmInit = findTool('swarm_init');
    const result = await swarmInit.handler({
      task: 'polymarket trading audit',
      strategy: 'specialized',
      maxAgents: 3,
    });

    const recommended = result.recommendedAgents as Array<unknown>;
    expect(recommended.length).toBeLessThanOrEqual(3);
  });
});
