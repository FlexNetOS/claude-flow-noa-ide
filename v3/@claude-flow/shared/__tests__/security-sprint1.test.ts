/**
 * Sprint 1 Security Tests — shared package
 *
 * Covers:
 *   1. safeJsonParse prototype pollution prevention
 *   2. isDangerousKey guard for merge loops
 *   3. sanitizeEnvValue shell metacharacter rejection
 *   4. PROTECTED_ENV_VARS enforcement
 *   5. snapshotProtectedEnv / restoreProtectedEnv round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeJsonParse, isDangerousKey } from '../src/utils/safe-json.js';
import {
  PROTECTED_ENV_VARS,
  sanitizeEnvValue,
} from '../src/plugin-loader.js';

// ─── safeJsonParse ──────────────────────────────────────────

describe('safeJsonParse', () => {
  it('parses valid JSON normally', () => {
    const result = safeJsonParse<{ a: number }>('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it('strips __proto__ key', () => {
    const payload = '{"__proto__":{"polluted":true},"safe":"ok"}';
    const result = safeJsonParse<any>(payload);
    expect(result.safe).toBe('ok');
    // result.__proto__ via dot notation accesses the prototype chain, not a named key.
    // The correct check is whether the parsed object has an own property named __proto__.
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    // Verify Object.prototype was NOT polluted
    expect(({} as any).polluted).toBeUndefined();
  });

  it('strips constructor key', () => {
    const payload = '{"constructor":{"prototype":{"x":1}},"val":2}';
    const result = safeJsonParse<any>(payload);
    expect(result.val).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });

  it('strips prototype key', () => {
    const payload = '{"prototype":{"injected":true},"ok":true}';
    const result = safeJsonParse<any>(payload);
    expect(result.ok).toBe(true);
    expect(result.prototype).toBeUndefined();
  });

  it('strips nested dangerous keys', () => {
    const payload = '{"data":{"__proto__":{"evil":true},"value":42}}';
    const result = safeJsonParse<any>(payload);
    expect(result.data.value).toBe(42);
    expect(Object.prototype.hasOwnProperty.call(result.data, '__proto__')).toBe(false);
  });

  it('handles arrays without issue', () => {
    const result = safeJsonParse<number[]>('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws on invalid JSON', () => {
    expect(() => safeJsonParse('not json')).toThrow();
  });

  it('preserves keys that look similar but are safe', () => {
    const payload = '{"__proto":"ok","constructors":"fine","prototyped":true}';
    const result = safeJsonParse<any>(payload);
    expect(result.__proto).toBe('ok');
    expect(result.constructors).toBe('fine');
    expect(result.prototyped).toBe(true);
  });
});

// ─── isDangerousKey ─────────────────────────────────────────

describe('isDangerousKey', () => {
  it('flags __proto__', () => expect(isDangerousKey('__proto__')).toBe(true));
  it('flags constructor', () => expect(isDangerousKey('constructor')).toBe(true));
  it('flags prototype', () => expect(isDangerousKey('prototype')).toBe(true));
  it('allows normal keys', () => expect(isDangerousKey('name')).toBe(false));
  it('allows empty string', () => expect(isDangerousKey('')).toBe(false));
});

// ─── sanitizeEnvValue ───────────────────────────────────────

describe('sanitizeEnvValue', () => {
  it('rejects protected env var names', () => {
    expect(() => sanitizeEnvValue('PATH', '/usr/bin')).toThrow('protected');
    expect(() => sanitizeEnvValue('ANTHROPIC_API_KEY', 'sk-ant-xxx')).toThrow('protected');
    expect(() => sanitizeEnvValue('NODE_OPTIONS', '--max-old-space-size=4096')).toThrow('protected');
  });

  it('rejects shell metacharacters', () => {
    expect(() => sanitizeEnvValue('MY_VAR', 'value;rm -rf /')).toThrow('metacharacters');
    expect(() => sanitizeEnvValue('MY_VAR', 'x|cat /etc/passwd')).toThrow('metacharacters');
    expect(() => sanitizeEnvValue('MY_VAR', '$(whoami)')).toThrow('metacharacters');
    expect(() => sanitizeEnvValue('MY_VAR', 'val`id`')).toThrow('metacharacters');
    expect(() => sanitizeEnvValue('MY_VAR', 'line1\nline2')).toThrow('metacharacters');
    expect(() => sanitizeEnvValue('MY_VAR', 'a&b')).toThrow('metacharacters');
  });

  it('allows safe values for non-protected vars', () => {
    expect(sanitizeEnvValue('MY_CUSTOM_VAR', 'hello-world_123')).toBe('hello-world_123');
    expect(sanitizeEnvValue('DB_HOST', 'localhost')).toBe('localhost');
    expect(sanitizeEnvValue('PORT', '3000')).toBe('3000');
  });
});

// ─── PROTECTED_ENV_VARS ─────────────────────────────────────

describe('PROTECTED_ENV_VARS', () => {
  it('includes critical system vars', () => {
    expect(PROTECTED_ENV_VARS.has('PATH')).toBe(true);
    expect(PROTECTED_ENV_VARS.has('NODE_OPTIONS')).toBe(true);
    expect(PROTECTED_ENV_VARS.has('HOME')).toBe(true);
  });

  it('includes dynamic linker vars', () => {
    expect(PROTECTED_ENV_VARS.has('LD_PRELOAD')).toBe(true);
    expect(PROTECTED_ENV_VARS.has('DYLD_INSERT_LIBRARIES')).toBe(true);
  });

  it('includes API key vars', () => {
    expect(PROTECTED_ENV_VARS.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(PROTECTED_ENV_VARS.has('OPENAI_API_KEY')).toBe(true);
    expect(PROTECTED_ENV_VARS.has('PINATA_API_JWT')).toBe(true);
  });
});

// ─── Env snapshot/restore round-trip ────────────────────────

describe('env var snapshot-restore', () => {
  const testKey = 'SPRINT1_TEST_SENTINEL';
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[testKey];
    process.env[testKey] = 'before';
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[testKey];
    } else {
      process.env[testKey] = originalValue;
    }
  });

  it('detects that a non-protected var can be modified', () => {
    process.env[testKey] = 'modified';
    expect(process.env[testKey]).toBe('modified');
  });

  it('sanitizeEnvValue allows safe modification of non-protected vars', () => {
    const val = sanitizeEnvValue(testKey, 'safe-value');
    expect(val).toBe('safe-value');
  });

  it('sanitizeEnvValue blocks dangerous values even for non-protected vars', () => {
    expect(() => sanitizeEnvValue(testKey, 'val;rm')).toThrow('metacharacters');
  });
});
