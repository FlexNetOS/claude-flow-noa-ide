/**
 * #bug38 + #bug42 — `ruflo doctor` hooks-coexistence and data-file-perms checks.
 *
 * Bug 38: Detect competing wildcard (*) matchers from third-party hook
 *         providers (OpenIsland, Raycast, …) that fire on every tool
 *         alongside ruflo's scoped Bash/Write/Edit hooks.
 *
 * Bug 42: Detect data files (auto-memory-store.json, pending-insights.jsonl,
 *         sessions/*) whose mode is more permissive than 0600 — those files
 *         capture prompt and edit content and must be owner-only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inspectHookCoexistence,
  formatHookCoexistence,
  checkHookCoexistence,
  inspectDataFilePerms,
  fixDataFilePerms,
  checkDataFilePerms,
} from '../src/commands/doctor.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-bug38-42-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('#bug38 — hook coexistence inspection', () => {
  it('returns [] when settings.json does not exist', () => {
    const rows = inspectHookCoexistence(join(tmp, 'missing-settings.json'));
    expect(rows).toEqual([]);
  });

  it('detects an OpenIsland-style wildcard hook on PostToolUse alongside ruflo hooks', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: 'node $HOME/.claude/helpers/hook-handler.cjs post-edit' }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'npx claude-flow hooks post-command' }],
          },
          {
            matcher: '*',
            hooks: [{ type: 'command', command: '/Users/x/Library/Application Support/OpenIsland/bin/OpenIslandHooks --source claude' }],
          },
        ],
        PreCompact: [
          {
            matcher: 'manual',
            hooks: [{ type: 'command', command: 'ruflo hooks pre-compact' }],
          },
          { matcher: '*', hooks: [{ type: 'command', command: '/path/OpenIslandHooks' }] },
        ],
      },
    };
    const path = join(tmp, 'settings.json');
    writeFileSync(path, JSON.stringify(settings, null, 2));

    const rows = inspectHookCoexistence(path);
    expect(rows).toHaveLength(2);

    const post = rows.find(r => r.event === 'PostToolUse')!;
    expect(post.rufloCount).toBe(2);
    expect(post.wildcardCount).toBe(1);
    expect(post.wildcardSources).toContain('OpenIsland');

    const pre = rows.find(r => r.event === 'PreCompact')!;
    expect(pre.rufloCount).toBe(1);
    expect(pre.wildcardCount).toBe(1);
  });

  it('reports zero wildcard counts when only ruflo hooks are present', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ command: 'npx claude-flow hooks post-command' }] },
        ],
      },
    };
    const path = join(tmp, 'settings.json');
    writeFileSync(path, JSON.stringify(settings));
    const rows = inspectHookCoexistence(path);
    expect(rows[0].wildcardCount).toBe(0);
  });

  it('formatHookCoexistence produces a header + separator + one row per event', () => {
    const lines = formatHookCoexistence([
      { event: 'PostToolUse', rufloCount: 2, wildcardCount: 1, wildcardSources: ['OpenIsland'] },
    ]);
    expect(lines.length).toBe(3); // header, sep, 1 row
    expect(lines[0]).toContain('Hook Event');
    expect(lines[0]).toContain('Wildcard');
    expect(lines[2]).toContain('PostToolUse');
    expect(lines[2]).toContain('OpenIsland');
  });

  it('checkHookCoexistence returns warn when wildcard matchers detected', () => {
    const result = checkHookCoexistence([
      { event: 'PostToolUse', rufloCount: 2, wildcardCount: 1, wildcardSources: ['OpenIsland'] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/OpenIsland/);
    expect(result.fix).toMatch(/--hooks/);
  });

  it('checkHookCoexistence returns pass when no wildcards present', () => {
    const result = checkHookCoexistence([
      { event: 'PostToolUse', rufloCount: 3, wildcardCount: 0, wildcardSources: [] },
    ]);
    expect(result.status).toBe('pass');
  });

  it('handles invalid JSON gracefully', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{not json');
    expect(inspectHookCoexistence(path)).toEqual([]);
  });
});

describe('#bug42 — data file permission audit', () => {
  it('returns no issues when no sensitive paths exist', () => {
    const issues = inspectDataFilePerms(tmp);
    expect(issues).toEqual([]);
  });

  it('flags a 0644 auto-memory-store.json file as needing chmod', () => {
    const dataDir = join(tmp, '.claude', '.claude-flow', 'data');
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'auto-memory-store.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);

    const issues = inspectDataFilePerms(tmp);
    expect(issues.length).toBe(1);
    expect(issues[0].path).toBe(file);
    expect(issues[0].mode).toBe('0644');
  });

  it('does NOT flag a file already at 0600', () => {
    const dataDir = join(tmp, '.claude', '.claude-flow', 'data');
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'pending-insights.jsonl');
    writeFileSync(file, '');
    chmodSync(file, 0o600);

    const issues = inspectDataFilePerms(tmp);
    expect(issues).toEqual([]);
  });

  it('walks sessions/ directory recursively', () => {
    const sessions = join(tmp, '.claude', '.claude-flow', 'sessions', 'sub');
    mkdirSync(sessions, { recursive: true });
    const f1 = join(sessions, 'session-a.json');
    writeFileSync(f1, '{}');
    chmodSync(f1, 0o644);

    const issues = inspectDataFilePerms(tmp);
    expect(issues.map(i => i.path)).toContain(f1);
  });

  it('fixDataFilePerms chmods reported files to 0600', () => {
    const dataDir = join(tmp, '.claude', '.claude-flow', 'data');
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'auto-memory-store.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);

    const issues = inspectDataFilePerms(tmp);
    const fixed = fixDataFilePerms(issues);
    expect(fixed).toBe(1);

    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    // Subsequent inspect should be clean.
    expect(inspectDataFilePerms(tmp)).toEqual([]);
  });

  it('checkDataFilePerms warns when issues exist, fixes are suggested', () => {
    const result = checkDataFilePerms([
      { path: '/tmp/foo.json', mode: '0644' },
    ]);
    expect(result.status).toBe('warn');
    expect(result.fix).toMatch(/fix-perms/);
  });

  it('checkDataFilePerms passes with no issues', () => {
    expect(checkDataFilePerms([]).status).toBe('pass');
  });
});
