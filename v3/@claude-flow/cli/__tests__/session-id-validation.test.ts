/**
 * Regression tests for #bug30 — `session_id` from stdin must be validated
 * against a strict regex before being concatenated into filesystem paths.
 *
 * Validates the `SAFE_SESSION_ID` regex used in:
 *   - ~/.claude/hooks/gsd-context-monitor.js (lines 35,42)
 *   - ~/.claude/hooks/gsd-statusline.js (line 34)
 *
 * Without this guard, an attacker controlling the session_id (e.g. via a
 * compromised stdin source) could write/read arbitrary files via path
 * traversal in `path.join(tmpdir(), `claude-ctx-${sessionId}.json`)`.
 */

import { describe, expect, it } from 'vitest';

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Mirrors the logic at the top of the hook handlers — validate before use.
 * Returns the sanitized id (or empty string if invalid). Null/undefined
 * passes through unchanged so existing callers' "no session" branches still
 * fire as before.
 */
function validateSessionId(sessionId: unknown): string | null | undefined {
  if (sessionId === null || sessionId === undefined) return sessionId as null | undefined;
  if (typeof sessionId !== 'string') return '';
  if (!SAFE_SESSION_ID.test(sessionId)) return '';
  return sessionId;
}

describe('SAFE_SESSION_ID regex (#bug30)', () => {
  describe('valid session ids pass', () => {
    const valid = [
      'abc123',
      'sess-2026-05-08-abc',
      'a',
      'A',
      '0',
      '_',
      '-',
      'A_B-C_123',
      'a'.repeat(128), // exact upper bound
      'session_id_with_underscores_and-dashes-2026',
    ];
    for (const id of valid) {
      it(`accepts ${JSON.stringify(id.slice(0, 40))}${id.length > 40 ? '...' : ''}`, () => {
        expect(SAFE_SESSION_ID.test(id)).toBe(true);
        expect(validateSessionId(id)).toBe(id);
      });
    }
  });

  describe('path traversal attempts are rejected', () => {
    const malicious = [
      '../etc/passwd',
      'foo/../bar',
      '../../root/.ssh/id_rsa',
      '..\\windows\\system32',
      '/absolute/path',
      './relative',
      'sess/with/slash',
      'sess\\with\\backslash',
      "' OR 1=1",
      "'; DROP TABLE--",
      'sess\x00null',
      'sess\nnewline',
      'sess\rcr',
      'sess with space',
      'sess.with.dots', // dots not in the allowlist (avoid `..` traversal entirely)
      '$(rm -rf /)',
      '`whoami`',
      'a'.repeat(129), // one past upper bound
      'a'.repeat(1024), // very long
      '', // empty string
      'café', // non-ASCII
      'emoji-🚨',
    ];
    for (const id of malicious) {
      it(`rejects ${JSON.stringify(id.length > 40 ? id.slice(0, 40) + '...' : id)}`, () => {
        expect(SAFE_SESSION_ID.test(id)).toBe(false);
        expect(validateSessionId(id)).toBe('');
      });
    }
  });

  describe('null/undefined return early without error', () => {
    it('passes null through unchanged', () => {
      expect(validateSessionId(null)).toBe(null);
    });
    it('passes undefined through unchanged', () => {
      expect(validateSessionId(undefined)).toBe(undefined);
    });
    it('non-string types are coerced to empty (rejected)', () => {
      expect(validateSessionId(123 as unknown)).toBe('');
      expect(validateSessionId({} as unknown)).toBe('');
      expect(validateSessionId([] as unknown)).toBe('');
      expect(validateSessionId(true as unknown)).toBe('');
    });
  });

  describe('integration: path.join is safe with validated input', () => {
    it('a validated id cannot escape tmpdir', async () => {
      const path = await import('node:path');
      const tmpdir = '/tmp';
      const inputs = ['abc123', 'sess-valid-2026'];
      for (const id of inputs) {
        const validated = validateSessionId(id);
        if (typeof validated === 'string' && validated.length > 0) {
          const p = path.join(tmpdir, `claude-ctx-${validated}.json`);
          expect(p.startsWith(tmpdir + '/')).toBe(true);
          expect(p.includes('..')).toBe(false);
        }
      }
    });

    it('rejected ids never reach path.join', async () => {
      const attempts = ['../../../etc/passwd', 'foo/../bar'];
      for (const id of attempts) {
        const validated = validateSessionId(id);
        // validateSessionId returns '' for invalid -> caller checks falsy
        expect(validated).toBe('');
      }
    });
  });
});
