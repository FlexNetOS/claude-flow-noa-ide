/**
 * Safe JSON Parsing Utilities
 *
 * Prevents prototype pollution attacks by stripping dangerous keys
 * (__proto__, constructor, prototype) during JSON.parse via a reviver.
 *
 * OWASP reference: Prototype Pollution
 * CVE examples: CVE-2019-10744 (lodash), CVE-2020-28469 (glob-parent)
 *
 * @module @claude-flow/shared/utils/safe-json
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse JSON with prototype-pollution protection.
 *
 * Uses a reviver function to drop any key in DANGEROUS_KEYS before
 * the resulting object is constructed, preventing an attacker from
 * injecting properties onto Object.prototype.
 */
export function safeJsonParse<T = unknown>(content: string): T {
  return JSON.parse(content, (key, value) => {
    if (DANGEROUS_KEYS.has(key)) {
      return undefined;
    }
    return value;
  }) as T;
}

/**
 * Check whether a key is a prototype-pollution vector.
 * Useful in manual object-merge loops (deepMerge, Object.assign wrappers).
 */
export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}
