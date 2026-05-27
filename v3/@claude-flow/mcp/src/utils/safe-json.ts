/**
 * Safe JSON Parsing Utilities
 *
 * Prevents prototype pollution attacks by stripping dangerous keys
 * (__proto__, constructor, prototype) during JSON.parse via a reviver.
 *
 * Mirror of @claude-flow/shared/utils/safe-json for packages that
 * cannot directly import from shared.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safeJsonParse<T = unknown>(content: string): T {
  return JSON.parse(content, (key, value) => {
    if (DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return value;
  }) as T;
}
