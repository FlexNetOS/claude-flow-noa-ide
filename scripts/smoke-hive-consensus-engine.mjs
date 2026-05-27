#!/usr/bin/env node
/**
 * ADR-095 G2.2 smoke — assert the hive-mind MCP layer wires the real
 * @claude-flow/swarm ConsensusEngine via the hive-consensus-runtime.
 *
 * Drives the same flow a Claude Code MCP client would:
 *   1. hive-mind_init returns runtime.engine: 'enabled' with transport: 'local'
 *      (and degraded:false in 'auto' mode when agentic-flow isn't installed).
 *   2. hive-mind_consensus { action: 'engine-stats' } returns initialized:true
 *      with a non-null engine block.
 *   3. hive-mind_consensus { action: 'propose', useEngine: true } accepts a
 *      gossip-algorithm proposal through the engine (proposerId == queen).
 *   4. hive-mind_shutdown reports runtimeShutdown: true.
 *
 * Any deviation = the wire-up regressed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const CLI_DIST = resolve(REPO_ROOT, 'v3/@claude-flow/cli/dist/src/mcp-tools/hive-mind-tools.js');
const RUNTIME_DIST = resolve(REPO_ROOT, 'v3/@claude-flow/cli/dist/src/mcp-tools/hive-consensus-runtime.js');

if (!existsSync(CLI_DIST)) {
  console.error(`smoke: not found: ${CLI_DIST}`);
  console.error('Run `npm run build -w @claude-flow/cli` first.');
  process.exit(1);
}
if (!existsSync(RUNTIME_DIST)) {
  console.error(`smoke: not found: ${RUNTIME_DIST}`);
  console.error('hive-consensus-runtime.js is missing from dist — ADR-095 G2.2 not built.');
  process.exit(1);
}

const failures = [];
function record(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
    failures.push(name);
  }
}

// Run the assertions in a temp cwd so the hive-mind state file doesn't
// pollute the repo.
const tmp = mkdtempSync(join(tmpdir(), 'hive-consensus-smoke-'));

// Driver uses dynamic ESM import (matches the cli package's "type": "module").
const driver = `
(async () => {
  const { hiveMindTools } = await import(${JSON.stringify(CLI_DIST)});
  const tools = Object.fromEntries(hiveMindTools.map(t => [t.name, t]));

  // 1. init in 'auto' mode (no peers) — should land on local, not degraded.
  const init = await tools['hive-mind_init'].handler({
    topology: 'mesh',
    consensus: 'gossip',
    queenId: 'queen-smoke',
    transport: 'auto',
  });
  console.log(JSON.stringify({ step: 'init', init }));

  // 2. engine-stats — runtime should be live.
  const stats = await tools['hive-mind_consensus'].handler({ action: 'engine-stats' });
  console.log(JSON.stringify({ step: 'stats', stats }));

  // 3. propose via the engine.
  const propose = await tools['hive-mind_consensus'].handler({
    action: 'propose',
    type: 'smoke',
    value: { op: 'smoke-test' },
    useEngine: true,
    voterId: 'queen-smoke',
  });
  console.log(JSON.stringify({ step: 'propose', propose }));

  // 4. shutdown — runtime should tear down.
  const shutdown = await tools['hive-mind_shutdown'].handler({ force: true });
  console.log(JSON.stringify({ step: 'shutdown', shutdown }));

  // Raft / Byzantine engines keep election timers alive; force-exit so
  // this driver doesn't hang the smoke (the engine.shutdown call above
  // clears its own timers, but a paranoid exit keeps CI clean).
  process.exit(0);
})().catch(err => { console.error('DRIVER_ERR:', err && err.stack || err); process.exit(2); });
`;

// Use --input-type=module so `node -e` parses dynamic import as ESM.
const out = spawnSync('node', ['--input-type=module', '-e', driver], { cwd: tmp, encoding: 'utf8' });
rmSync(tmp, { recursive: true, force: true });

if (out.status !== 0) {
  console.error(`smoke driver failed (exit ${out.status})`);
  console.error('STDOUT:', out.stdout);
  console.error('STDERR:', out.stderr);
  process.exit(1);
}

// Parse the driver's JSON lines.
const steps = {};
for (const line of out.stdout.split('\n')) {
  if (!line.trim()) continue;
  try {
    const parsed = JSON.parse(line);
    steps[parsed.step] = parsed;
  } catch { /* non-JSON noise from logs is fine */ }
}

// ── Assertions ──────────────────────────────────────────────────────
record(
  'init.runtime.engine === "enabled"',
  steps.init?.init?.runtime?.engine === 'enabled',
  `runtime=${JSON.stringify(steps.init?.init?.runtime)}`,
);
record(
  'init.runtime.transport is "local" (no agentic-flow in CI)',
  steps.init?.init?.runtime?.transport === 'local',
  `transport=${steps.init?.init?.runtime?.transport}`,
);
record(
  'init.runtime.algorithm === "gossip"',
  steps.init?.init?.runtime?.algorithm === 'gossip',
  `algorithm=${steps.init?.init?.runtime?.algorithm}`,
);
record(
  'init.runtime.degraded === false (auto mode is silent fallback)',
  steps.init?.init?.runtime?.degraded === false,
  `degraded=${steps.init?.init?.runtime?.degraded}`,
);

record(
  'engine-stats.initialized === true',
  steps.stats?.stats?.initialized === true,
  `stats=${JSON.stringify(steps.stats?.stats)}`,
);
record(
  'engine-stats.engine is non-null',
  steps.stats?.stats?.engine != null,
  `engine=${JSON.stringify(steps.stats?.stats?.engine)}`,
);
record(
  'engine-stats.transport === "local"',
  steps.stats?.stats?.transport === 'local',
  `transport=${steps.stats?.stats?.transport}`,
);

record(
  'propose.engine === "enabled" (real consensus engine routed)',
  steps.propose?.propose?.engine === 'enabled',
  `propose=${JSON.stringify(steps.propose?.propose)}`,
);
record(
  'propose.proposalId is a non-empty string',
  typeof steps.propose?.propose?.proposalId === 'string' && steps.propose.propose.proposalId.length > 0,
  `proposalId=${steps.propose?.propose?.proposalId}`,
);

record(
  'shutdown.runtimeShutdown === true',
  steps.shutdown?.shutdown?.runtimeShutdown === true,
  `shutdown=${JSON.stringify(steps.shutdown?.shutdown)}`,
);

console.log('');
if (failures.length > 0) {
  console.error(`smoke-hive-consensus-engine: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('smoke-hive-consensus-engine: all checks passed (ADR-095 G2.2 wire-up live)');
