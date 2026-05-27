import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProjectCwd } from '../src/mcp-tools/types.js';

const ORIGINAL_ENV = {
  CLAUDE_FLOW_PROJECT_DIR: process.env.CLAUDE_FLOW_PROJECT_DIR,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  INIT_CWD: process.env.INIT_CWD,
  CLAUDE_FLOW_CWD: process.env.CLAUDE_FLOW_CWD,
};

const TEMP_DIRS: string[] = [];

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

function restoreEnvVar(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restoreEnvVar('CLAUDE_FLOW_PROJECT_DIR');
  restoreEnvVar('CLAUDE_PROJECT_DIR');
  restoreEnvVar('INIT_CWD');
  restoreEnvVar('CLAUDE_FLOW_CWD');

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('getProjectCwd', () => {
  it('prefers CLAUDE_FLOW_PROJECT_DIR over other env fallbacks', () => {
    const explicitProjectDir = makeTempDir('flow-project-dir');
    const claudeProjectDir = makeTempDir('claude-project-dir');
    const initDir = makeTempDir('init-dir');
    const fallbackDir = makeTempDir('fallback-dir');

    process.env.CLAUDE_FLOW_PROJECT_DIR = explicitProjectDir;
    process.env.CLAUDE_PROJECT_DIR = claudeProjectDir;
    process.env.INIT_CWD = initDir;
    process.env.CLAUDE_FLOW_CWD = fallbackDir;

    expect(getProjectCwd()).toBe(explicitProjectDir);
  });

  it('prefers CLAUDE_PROJECT_DIR over CLAUDE_FLOW_CWD fallback', () => {
    const projectDir = makeTempDir('project-dir');
    const fallbackDir = makeTempDir('fallback-dir');

    delete process.env.CLAUDE_FLOW_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CLAUDE_FLOW_CWD = fallbackDir;

    expect(getProjectCwd()).toBe(projectDir);
  });

  it('prefers INIT_CWD over CLAUDE_FLOW_CWD when project dir is absent', () => {
    const initDir = makeTempDir('init-dir');
    const fallbackDir = makeTempDir('fallback-dir');

    delete process.env.CLAUDE_FLOW_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.INIT_CWD = initDir;
    process.env.CLAUDE_FLOW_CWD = fallbackDir;

    expect(getProjectCwd()).toBe(initDir);
  });

  it('falls back to CLAUDE_FLOW_CWD when no project-scoped env is set', () => {
    const fallbackDir = makeTempDir('fallback-dir');

    delete process.env.CLAUDE_FLOW_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.INIT_CWD;
    process.env.CLAUDE_FLOW_CWD = fallbackDir;

    expect(getProjectCwd()).toBe(fallbackDir);
  });
});
