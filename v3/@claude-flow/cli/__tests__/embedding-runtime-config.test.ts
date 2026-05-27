import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { resolveEmbeddingRuntimeOptions } from '../src/memory/memory-initializer.js';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('embedding runtime config', () => {
  it('uses the model and cache directory written by embeddings init', () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-embedding-runtime-'));
    tempDirs.push(cwd);
    process.chdir(cwd);

    mkdirSync('.claude-flow', { recursive: true });
    writeFileSync(
      join('.claude-flow', 'embeddings.json'),
      JSON.stringify({
        model: 'all-MiniLM-L6-v2',
        modelPath: '.claude-flow/models',
        dimension: 384,
      }),
    );

    const runtime = resolveEmbeddingRuntimeOptions();

    expect(runtime.modelName).toBe('Xenova/all-MiniLM-L6-v2');
    expect(runtime.modelPath).toBe(resolve(cwd, '.claude-flow/models'));
    expect(runtime.dimensions).toBe(384);
  });

  it('lets explicit load options override persisted config', () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-embedding-runtime-'));
    tempDirs.push(cwd);
    process.chdir(cwd);

    mkdirSync('.claude-flow', { recursive: true });
    writeFileSync(
      join('.claude-flow', 'embeddings.json'),
      JSON.stringify({
        model: 'Xenova/all-MiniLM-L6-v2',
        modelPath: '.claude-flow/models',
        dimension: 384,
      }),
    );

    const runtime = resolveEmbeddingRuntimeOptions({
      modelName: 'Xenova/all-mpnet-base-v2',
      modelPath: 'custom-model-cache',
    });

    expect(runtime.modelName).toBe('Xenova/all-mpnet-base-v2');
    expect(runtime.modelPath).toBe(resolve(cwd, 'custom-model-cache'));
    expect(runtime.dimensions).toBe(768);
  });
});
