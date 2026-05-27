/**
 * Claude Code OAuth token resolver — Bug #24.
 *
 * Ruflo runs on the same machine as Claude Code, which already holds an
 * Anthropic OAuth credential. Forcing users to also set ANTHROPIC_API_KEY
 * is redundant: we should reuse the existing token whenever possible.
 *
 * Resolution order (matches `~/.claude/statusline-command.sh:258-268`):
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override)
 *   2. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w`
 *      → JSON-parse → `claudeAiOauth.accessToken`
 *   3. Fallback file: `~/.claude/.credentials.json`
 *      → `claudeAiOauth.accessToken`
 *
 * Returns `null` if none found. NEVER throws — credential resolution
 * failures must not break the calling tool.
 *
 * The OAuth token has a different wire shape than the API key:
 *   - API key:   header `x-api-key: <key>` + `anthropic-version: 2023-06-01`
 *   - OAuth:     header `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
 *
 * Callers must branch on the credential source returned here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CredentialSource = 'env-oauth' | 'keychain-oauth' | 'file-oauth' | 'api-key' | 'none';

export interface ResolvedClaudeCredential {
  /** OAuth access token (Bearer) when source is *-oauth, raw API key when api-key, null when none. */
  token: string | null;
  /** Where the credential came from — exposed in tool responses for transparency. */
  source: CredentialSource;
}

/**
 * Try to resolve a Claude Code OAuth token from the local environment.
 * Returns `null` if no token can be found. Never throws.
 */
export function getClaudeCodeOAuthToken(): string | null {
  // 1. Explicit env override.
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  // 2. macOS Keychain — only on darwin, and only if `security` exists.
  if (process.platform === 'darwin') {
    const keychainToken = readFromKeychain();
    if (keychainToken) return keychainToken;
  }

  // 3. ~/.claude/.credentials.json fallback (Linux + macOS).
  const fileToken = readFromCredentialsFile();
  if (fileToken) return fileToken;

  return null;
}

function readFromKeychain(): string | null {
  try {
    const blob = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    ).trim();
    if (!blob) return null;
    return parseAccessToken(blob);
  } catch {
    // `security` missing, item not in keychain, or user denied access — all fine.
    return null;
  }
}

function readFromCredentialsFile(): string | null {
  try {
    const path = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(path)) return null;
    const blob = readFileSync(path, 'utf-8');
    return parseAccessToken(blob);
  } catch {
    return null;
  }
}

function parseAccessToken(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) return token;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best Anthropic credential available, preferring Claude Code
 * OAuth over a plain API key. Returns `{ token: null, source: 'none' }`
 * when neither is configured — callers should produce a friendly error.
 */
export function resolveClaudeCredential(): ResolvedClaudeCredential {
  // 1. Prefer OAuth from Claude Code.
  const envOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envOAuth && envOAuth.trim().length > 0) {
    return { token: envOAuth.trim(), source: 'env-oauth' };
  }
  if (process.platform === 'darwin') {
    const kc = readFromKeychain();
    if (kc) return { token: kc, source: 'keychain-oauth' };
  }
  const fileTok = readFromCredentialsFile();
  if (fileTok) return { token: fileTok, source: 'file-oauth' };

  // 2. Fall back to API key.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return { token: apiKey.trim(), source: 'api-key' };
  }

  return { token: null, source: 'none' };
}

/**
 * Build the right HTTP headers for an Anthropic Messages call given a
 * resolved credential. OAuth and API key paths use different header sets.
 */
export function buildAnthropicHeaders(cred: ResolvedClaudeCredential): Record<string, string> {
  const base = { 'content-type': 'application/json' } as Record<string, string>;
  if (cred.source === 'api-key') {
    return {
      ...base,
      'x-api-key': cred.token ?? '',
      'anthropic-version': '2023-06-01',
    };
  }
  // OAuth flavors all use the same wire format.
  return {
    ...base,
    Authorization: `Bearer ${cred.token ?? ''}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  };
}
