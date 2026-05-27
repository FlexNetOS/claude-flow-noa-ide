/**
 * #bug7 — `memory_import_claude` and `memory_bridge_status` must agree on
 * the set of Claude Code memory files under `~/.claude/projects/`.
 *
 * Before the fix, the importer encoded `cwd` with `cwd.replace(/\//g, '-')`
 * which silently mismatched Claude Code's real on-disk encoding (which
 * additionally replaces `.` with `-`), causing `imported: 0` while
 * `memory_bridge_status` correctly reported the same files as
 * `memoryFiles: 2`.
 *
 * These tests run against a temp HOME so they're hermetic — no
 * dependency on what's actually in the user's real `~/.claude/projects/`.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock `os.homedir` BEFORE importing memory-tools so the helper resolves
// `~/.claude/projects/` against our temp directory rather than the real
// user home (which may already contain Claude Code project dirs that
// would contaminate the test).
const tmpHomeRef: { current: string } = { current: tmpdir() };
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => tmpHomeRef.current,
  };
});

const {
  encodeClaudeProjectId,
  getClaudeProjectMemoryFiles,
} = await import('../src/mcp-tools/memory-tools.js');

describe('Claude Code project memory enumeration (#bug7)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ruflo-bug7-'));
    tmpHomeRef.current = tmpHome;
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('encodeClaudeProjectId replaces both `/` and `.` with `-` (matches Claude Code)', () => {
    expect(encodeClaudeProjectId('/Users/h4ckm1n/.claude')).toBe('-Users-h4ckm1n--claude');
    expect(encodeClaudeProjectId('/Users/h4ckm1n/dev/ruflo')).toBe('-Users-h4ckm1n-dev-ruflo');
    expect(encodeClaudeProjectId('/tmp/foo.bar')).toBe('-tmp-foo-bar');
  });

  it('returns empty summary when ~/.claude/projects/ does not exist', () => {
    const summary = getClaudeProjectMemoryFiles({ allProjects: true });
    expect(summary.files).toEqual([]);
    expect(summary.projectsWithMemory).toBe(0);
    expect(summary.projectsScanned).toBe(0);
  });

  it('allProjects=true enumerates every project memory dir (matches bridge_status semantics)', () => {
    // Seed two projects with memory and one without
    const projectsRoot = join(tmpHome, '.claude', 'projects');
    mkdirSync(join(projectsRoot, '-tmp-projA', 'memory'), { recursive: true });
    mkdirSync(join(projectsRoot, '-tmp-projB', 'memory'), { recursive: true });
    mkdirSync(join(projectsRoot, '-tmp-projC'), { recursive: true }); // no memory dir
    writeFileSync(join(projectsRoot, '-tmp-projA', 'memory', 'a.md'), '# a');
    writeFileSync(join(projectsRoot, '-tmp-projA', 'memory', 'b.md'), '# b');
    writeFileSync(join(projectsRoot, '-tmp-projB', 'memory', 'c.md'), '# c');
    // README.md without .md extension or non-md sibling should be ignored
    writeFileSync(join(projectsRoot, '-tmp-projB', 'memory', 'ignore.txt'), 'nope');

    const summary = getClaudeProjectMemoryFiles({ allProjects: true });
    expect(summary.files.length).toBe(3);
    expect(summary.projectsWithMemory).toBe(2);
    expect(summary.projectsScanned).toBe(3);
    const filenames = summary.files.map((f) => f.file).sort();
    expect(filenames).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('single-project mode resolves cwd via the dot-and-slash encoding (#bug7 root cause)', () => {
    // Simulate: cwd = /Users/h4ckm1n/.claude  =>  -Users-h4ckm1n--claude
    const cwd = '/Users/h4ckm1n/.claude';
    const projectId = encodeClaudeProjectId(cwd);
    const projectsRoot = join(tmpHome, '.claude', 'projects');
    mkdirSync(join(projectsRoot, projectId, 'memory'), { recursive: true });
    writeFileSync(join(projectsRoot, projectId, 'memory', 'session.md'), '# session');

    // A second unrelated project must NOT be picked up.
    mkdirSync(join(projectsRoot, '-other-project', 'memory'), { recursive: true });
    writeFileSync(join(projectsRoot, '-other-project', 'memory', 'noise.md'), '# noise');

    const summary = getClaudeProjectMemoryFiles({ allProjects: false, cwd });
    expect(summary.files.length).toBe(1);
    expect(summary.files[0].file).toBe('session.md');
    expect(summary.files[0].project).toBe(projectId);
  });

  it('single-project mode tolerates the legacy slash-only encoding for back-compat', () => {
    // Older ruflo writes used `cwd.replace(/\//g, '-')` only — those
    // dirs (without dot replacement) must still be discoverable so
    // upgrades don't lose user data.
    const cwd = '/tmp/foo.bar';
    const legacyProjectId = cwd.replace(/\//g, '-'); // '-tmp-foo.bar'
    const projectsRoot = join(tmpHome, '.claude', 'projects');
    mkdirSync(join(projectsRoot, legacyProjectId, 'memory'), { recursive: true });
    writeFileSync(join(projectsRoot, legacyProjectId, 'memory', 'legacy.md'), '# legacy');

    const summary = getClaudeProjectMemoryFiles({ allProjects: false, cwd });
    expect(summary.files.length).toBe(1);
    expect(summary.files[0].file).toBe('legacy.md');
  });

  it('importer enumeration count equals bridge_status enumeration count (parity invariant)', () => {
    const projectsRoot = join(tmpHome, '.claude', 'projects');
    // Several projects, mixed contents.
    mkdirSync(join(projectsRoot, '-tmp-x', 'memory'), { recursive: true });
    mkdirSync(join(projectsRoot, '-tmp-y', 'memory'), { recursive: true });
    writeFileSync(join(projectsRoot, '-tmp-x', 'memory', '1.md'), '#');
    writeFileSync(join(projectsRoot, '-tmp-x', 'memory', '2.md'), '#');
    writeFileSync(join(projectsRoot, '-tmp-y', 'memory', '3.md'), '#');

    const importerView = getClaudeProjectMemoryFiles({ allProjects: true });
    const statusView = getClaudeProjectMemoryFiles({ allProjects: true });

    expect(importerView.files.length).toBe(statusView.files.length);
    expect(importerView.projectsWithMemory).toBe(statusView.projectsWithMemory);
    // And specifically: the count the importer would import must match
    // the count `memory_bridge_status` would advertise (the regression
    // the bug ticket calls out).
    expect(importerView.files.length).toBe(3);
    expect(statusView.projectsWithMemory).toBe(2);
  });
});
