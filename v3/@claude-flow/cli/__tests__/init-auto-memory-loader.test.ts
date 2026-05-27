/**
 * Regression tests for #bug14 — session-start auto-memory loader emits
 * the misleading "Memory package not available — skipping auto memory
 * import" message even though the MCP-bridged memory_import_claude tool
 * succeeds when called from Claude Code itself.
 *
 * Root cause: the old `generateAutoMemoryHook()` template tried an ESM
 * `import('@claude-flow/memory')` first across 4 strategies, and only
 * fell through to a subprocess invocation of the `claude-flow` CLI as a
 * tail-end fallback. From `~/.claude/helpers/` (the global-install
 * location), the package is never on Node's import path, so the script
 * always landed on the offending stub-emit line at session start.
 *
 * Fix: the template is now subprocess-first. It probes `claude-flow
 * memory bridge-status` via `spawnSync` (which resolves through PATH /
 * npx shims / Windows .cmd wrappers thanks to `shell: true`) and reports
 * based on the subprocess result. The "Memory package not available"
 * branch has been removed entirely so SessionStart is silent on the
 * common path.
 */

import { describe, it, expect } from 'vitest';

import { generateAutoMemoryHook } from '../src/init/helpers-generator.js';

describe('#bug14 — auto-memory-hook session-start no longer emits "Memory package not available"', () => {
  it('does NOT contain the misleading "Memory package not available" stub-emit line', () => {
    const rendered = generateAutoMemoryHook();

    // Both legacy variants of the message must be gone. The first form
    // ("— skipping auto memory import") was in the deployed copy users
    // saw. The second ("— auto memory import skipped (non-critical)")
    // was in the bug11.2 generator. Bug 14 retires both.
    expect(rendered).not.toContain('Memory package not available — skipping auto memory import');
    expect(rendered).not.toContain('Memory package not available — auto memory import skipped');
    expect(rendered).not.toContain('Memory package not available — sync skipped');
    expect(rendered).not.toContain('Memory package not available — skipping sync');
  });

  it('uses subprocess invocation (spawnSync) as the canonical loader path', () => {
    const rendered = generateAutoMemoryHook();

    // spawnSync from child_process is the load-bearing primitive — without
    // it there is no out-of-process bridge to the CLI's memory backend.
    expect(rendered).toContain("import { spawnSync } from 'child_process'");
    expect(rendered).toContain('spawnSync(');

    // The subprocess probe must invoke `claude-flow memory bridge-status`
    // — a known-working read-only command that proves the CLI is reachable.
    expect(rendered).toContain("'memory'");
    expect(rendered).toContain("'bridge-status'");

    // shell:true is required so PATH, npx-shims, and Windows .cmd
    // wrappers all resolve correctly.
    expect(rendered).toContain('shell: true');
  });

  it('does NOT attempt an ESM import of @claude-flow/memory before subprocess (no stub branch)', () => {
    const rendered = generateAutoMemoryHook();

    // The legacy template called `import('@claude-flow/memory')` and only
    // fell through to spawnSync after that failed. We removed that path
    // entirely; the rendered helper must contain neither a dynamic import
    // of the memory package nor a `loadMemoryPackage` symbol.
    expect(rendered).not.toContain("await import('@claude-flow/memory')");
    expect(rendered).not.toContain("require('@claude-flow/memory')");
    expect(rendered).not.toContain('async function loadMemoryPackage');

    // Sanity: the subprocess path is the single canonical loader.
    expect(rendered).toContain('function trySubprocessImport');
  });

  it('emits a low-noise success line when the CLI is reachable (not the legacy stub)', () => {
    const rendered = generateAutoMemoryHook();

    // The success path must produce a dim diagnostic referencing the CLI
    // (not a "Memory package not available" stub). We assert the new
    // language explicitly so future regressions don't reintroduce the
    // misleading message under a different variable name.
    expect(rendered).toContain('Auto memory bridge ready');
  });
});
