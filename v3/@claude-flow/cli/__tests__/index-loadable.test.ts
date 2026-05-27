/**
 * Regression test for bug16b — `src/index.ts` strict-undefined errors.
 *
 * Ensures the module loads cleanly after the type narrowing fix in
 * `showCommandHelp` (let command: Command initialised from a checked
 * `initial: Command | undefined`). If the file regresses to types that
 * widen `command` back to `Command | undefined`, this test still passes
 * at runtime, but the build will fail in CI — which is the intended
 * defence. The runtime check below verifies the exported surface.
 */

import { describe, it, expect } from 'vitest';

describe('src/index.ts module load', () => {
  it('loads without throwing', async () => {
    await expect(import('../src/index.js')).resolves.toBeDefined();
  });

  it('exports the expected public surface (CLI, VERSION)', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toHaveProperty('CLI');
    expect(mod).toHaveProperty('VERSION');
    expect(typeof mod.VERSION).toBe('string');
  });
});
