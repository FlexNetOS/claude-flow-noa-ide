/**
 * #bug20 — `browser_template_apply` and `browser_cookie_use` previously
 * shelled out to `npx -y @claude-flow/cli@latest memory retrieve …` to
 * fetch their backing values. That had three problems:
 *
 *   1. ~3-5s npm-registry round-trip on every invocation;
 *   2. `npm warn deprecated` lines bled into the JSON response;
 *   3. transient `npx` failures were misreported as "key not found".
 *
 * The handlers run inside the same process that *also* exposes the
 * `memory_retrieve` MCP handler, so they can call the in-process backend
 * (`getEntry` from `memory/memory-initializer.js`) directly. That same
 * function is what `memory_retrieve` itself uses — no new bridge plumbing
 * is needed.
 *
 * These tests pin the contract:
 *   - the in-process API is invoked with the right (namespace, key);
 *   - no `child_process.execFile` / `npx` shell-out is fired;
 *   - the response shape matches the old behaviour (raw value passed
 *     through under the same keys: `recipe` / `vault`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock `memory-initializer` BEFORE importing browser-session-tools so the
// dynamic import inside `retrieveFromMemory` resolves to our spy and never
// touches sql.js / the real `.swarm/memory.db`.
const getEntryMock = vi.fn();
vi.mock('../src/memory/memory-initializer.js', () => ({
  getEntry: getEntryMock,
}));

// Spy on `child_process.execFile` so we can assert no shell-out happened.
const execFileSpy = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      execFileSpy(...args);
      // Forward to a stub that always errors — if any code path still
      // shells out, the test fails on either the spy assertion *or* the
      // unexpected error message.
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as (err: Error) => void)(new Error('execFile must not be called from refactored handlers (#bug20)'));
      }
    },
  };
});

const { browserSessionTools } = await import('../src/mcp-tools/browser-session-tools.js');

function getTool(name: string) {
  const t = browserSessionTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe('#bug20 — browser_template_apply / browser_cookie_use use in-process memory bridge', () => {
  beforeEach(() => {
    getEntryMock.mockReset();
    execFileSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('browser_template_apply', () => {
    it('calls in-process getEntry with namespace=browser-templates and the supplied key', async () => {
      getEntryMock.mockResolvedValueOnce({
        success: true,
        found: true,
        entry: {
          id: 'id-1',
          key: 'login-flow',
          namespace: 'browser-templates',
          content: '{"steps":["open","fill","click"]}',
          accessCount: 1,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          hasEmbedding: false,
          tags: [],
        },
      });

      const tool = getTool('browser_template_apply');
      const res = await tool.handler({ name: 'login-flow' });

      expect(getEntryMock).toHaveBeenCalledTimes(1);
      expect(getEntryMock).toHaveBeenCalledWith({
        key: 'login-flow',
        namespace: 'browser-templates',
      });

      // No shell-out fired.
      expect(execFileSpy).not.toHaveBeenCalled();

      // Response shape matches the old behaviour: the recipe blob is
      // passed through verbatim under the same `recipe` key.
      const payload = parseResult(res);
      expect(payload.success).toBe(true);
      expect(payload.templateName).toBe('login-flow');
      expect(payload.recipe).toBe('{"steps":["open","fill","click"]}');
      expect(payload.nextStep).toContain('Caller dispatches the recipe');
    });

    it('returns a structured failure when the key is missing (no exit-code conflation)', async () => {
      getEntryMock.mockResolvedValueOnce({ success: true, found: false });

      const tool = getTool('browser_template_apply');
      const res = await tool.handler({ name: 'does-not-exist' });

      expect(getEntryMock).toHaveBeenCalledTimes(1);
      expect(execFileSpy).not.toHaveBeenCalled();

      const payload = parseResult(res);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('template fetch failed');
      // The detail must clearly say "not found" — under the old shell-out
      // path this surfaced as `npx exit 1` + a deprecation warning.
      expect(payload.detail).toContain('not found');
    });

    it('surfaces backend errors as structured failures (not crashes)', async () => {
      getEntryMock.mockRejectedValueOnce(new Error('memory bridge unreachable'));

      const tool = getTool('browser_template_apply');
      const res = await tool.handler({ name: 'login-flow' });

      expect(execFileSpy).not.toHaveBeenCalled();

      const payload = parseResult(res);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('template fetch failed');
      expect(payload.detail).toContain('memory bridge unreachable');
    });
  });

  describe('browser_cookie_use', () => {
    it('calls in-process getEntry with namespace=browser-cookies and the supplied host', async () => {
      getEntryMock.mockResolvedValueOnce({
        success: true,
        found: true,
        entry: {
          id: 'id-2',
          key: 'example.com',
          namespace: 'browser-cookies',
          content: '{"vault_handle":"vh-abc","expiry":"2026-12-31","aidefence_verdict":"safe"}',
          accessCount: 0,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          hasEmbedding: false,
          tags: [],
        },
      });

      const tool = getTool('browser_cookie_use');
      const res = await tool.handler({ host: 'example.com' });

      expect(getEntryMock).toHaveBeenCalledTimes(1);
      expect(getEntryMock).toHaveBeenCalledWith({
        key: 'example.com',
        namespace: 'browser-cookies',
      });

      // No shell-out fired.
      expect(execFileSpy).not.toHaveBeenCalled();

      // Response shape: the vault descriptor is passed through under the
      // same `vault` key.
      const payload = parseResult(res);
      expect(payload.success).toBe(true);
      expect(payload.host).toBe('example.com');
      expect(payload.vault).toContain('vault_handle');
      expect(payload.vault).toContain('vh-abc');
      expect(payload.nextStep).toContain('raw cookie is materialized only inside the browser process');
    });

    it('returns a structured failure when the host has no stored cookie handle', async () => {
      getEntryMock.mockResolvedValueOnce({ success: true, found: false });

      const tool = getTool('browser_cookie_use');
      const res = await tool.handler({ host: 'unknown.example' });

      expect(getEntryMock).toHaveBeenCalledTimes(1);
      expect(execFileSpy).not.toHaveBeenCalled();

      const payload = parseResult(res);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('cookie lookup failed');
      expect(payload.detail).toContain('not found');
    });

    it('surfaces backend errors as structured failures (not crashes)', async () => {
      getEntryMock.mockRejectedValueOnce(new Error('sql.js backend offline'));

      const tool = getTool('browser_cookie_use');
      const res = await tool.handler({ host: 'example.com' });

      expect(execFileSpy).not.toHaveBeenCalled();

      const payload = parseResult(res);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('cookie lookup failed');
      expect(payload.detail).toContain('sql.js backend offline');
    });
  });
});
