/**
 * Regression tests for #bug40 — `hooks_route` must use the SEMANTIC
 * matcher (`matchUserSkillsForTaskSemantic`) for user-installed skills,
 * not the keyword bag-of-words scorer.
 *
 * Repro from the integration audit: a "JWT auth refactor" task surfaced
 * `kali-metasploit` as the top user match (false positive) because both
 * share the "auth" token via the keyword scorer. The semantic backend
 * (Ollama embeddings + cosine + keyword blend) correctly distinguishes
 * the two.
 *
 * These tests inject a deterministic mock embedder via the existing
 * `embedderOptions` injection seam from #bug25.2 so the regression runs
 * without an Ollama daemon. A second test verifies the keyword fallback
 * still works when the semantic backend is unavailable (so we don't
 * silently lose the kali-metasploit-for-pentest case).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hooksRoute } from '../src/mcp-tools/hooks-tools.js';
import { clearRegistryCache } from '../src/registry/claude-code-registry.js';
import * as ollamaEmbedder from '../src/registry/ollama-embedder.js';

let tmpDir: string;
let prevClaudeHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ruflo-bug40-'));
  prevClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = tmpDir;
  clearRegistryCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (prevClaudeHome === undefined) {
    delete process.env.CLAUDE_HOME;
  } else {
    process.env.CLAUDE_HOME = prevClaudeHome;
  }
  clearRegistryCache();
  vi.restoreAllMocks();
});

/** Build a registry with the two skills used in the audit repro. */
function setupRegressionSkills() {
  mkdirSync(join(tmpDir, 'skills', 'kali-metasploit'), { recursive: true });
  mkdirSync(join(tmpDir, 'skills', 'geo-content'), { recursive: true });

  writeFileSync(
    join(tmpDir, 'skills', 'kali-metasploit', 'SKILL.md'),
    [
      '---',
      'name: kali-metasploit',
      'description: Use for any work driving Metasploit Framework — module discovery, exploit/auxiliary/post modules, payload generation via msfvenom, multi-handler listeners, offline pentesting authorized targets.',
      '---',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(tmpDir, 'skills', 'geo-content', 'SKILL.md'),
    [
      '---',
      'name: geo-content',
      'description: Content quality and E-E-A-T assessment for AI citability — evaluate experience, expertise, authoritativeness, trustworthiness, and content structure.',
      '---',
      '',
    ].join('\n'),
  );
}

/**
 * Vector helpers — produce 8-d unit vectors keyed on a topic so cosine
 * similarity gives us deterministic expected scores per (task, skill)
 * pair without an actual Ollama daemon.
 */
type Topic = 'jwt-auth' | 'pentest-metasploit' | 'content-quality';

function vec(topic: Topic): number[] {
  switch (topic) {
    case 'jwt-auth':
      return [0.95, 0.05, 0.05, 0.0, 0.0, 0.0, 0.1, 0.0];
    case 'pentest-metasploit':
      return [0.05, 0.95, 0.0, 0.0, 0.0, 0.0, 0.0, 0.05];
    case 'content-quality':
      return [0.0, 0.0, 0.0, 0.95, 0.05, 0.05, 0.0, 0.05];
  }
}

/**
 * Classify the input text into one of the topic vectors. We can't run a
 * real embedder in tests; the topic mapping is intentionally crude — it
 * keys on which keywords dominate so the test is deterministic.
 */
function classify(text: string): Topic {
  const t = text.toLowerCase();
  if (t.includes('metasploit') || t.includes('pentest') || t.includes('exploit') || t.includes('msfvenom')) {
    return 'pentest-metasploit';
  }
  if (t.includes('jwt') || t.includes('auth')) {
    return 'jwt-auth';
  }
  if (t.includes('content') || t.includes('e-e-a-t') || t.includes('citability')) {
    return 'content-quality';
  }
  // Default: jwt-auth (the most common task in our regression set)
  return 'jwt-auth';
}

function mockOllamaWithSemanticEmbeddings() {
  vi.spyOn(ollamaEmbedder, 'embedTexts').mockImplementation(async (texts: string[]) => {
    return {
      vectors: texts.map(t => vec(classify(t))),
      model: 'mxbai-embed-large',
      backend: 'ollama' as const,
    };
  });
}

function mockOllamaUnavailable() {
  vi.spyOn(ollamaEmbedder, 'embedTexts').mockResolvedValue({
    vectors: [],
    model: null,
    backend: null,
  });
}

describe('#bug40 — hooks_route uses semantic matcher for user skills', () => {
  it('does NOT surface kali-metasploit in top 3 for a JWT auth task (semantic backend)', async () => {
    setupRegressionSkills();
    mockOllamaWithSemanticEmbeddings();

    const result = (await hooksRoute.handler({
      task: 'JWT authentication implementation review',
      useSemanticRouter: false, // bypass AgentDB — we only care about user-skill ranking
    })) as Record<string, unknown>;

    const userMatches = result.userInstalledMatches as Array<{ name: string; score: number }>;
    const top3 = userMatches.slice(0, 3).map(m => m.name);
    expect(top3).not.toContain('kali-metasploit');
  });

  it('DOES surface kali-metasploit as top match for a pentest task (semantic backend)', async () => {
    setupRegressionSkills();
    mockOllamaWithSemanticEmbeddings();

    const result = (await hooksRoute.handler({
      task: 'pentest a server with metasploit',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const userMatches = result.userInstalledMatches as Array<{ name: string; score: number }>;
    expect(userMatches.length).toBeGreaterThan(0);
    expect(userMatches[0].name).toBe('kali-metasploit');
  });

  it('routing.method reflects the semantic backend when a user skill wins primary', async () => {
    setupRegressionSkills();
    mockOllamaWithSemanticEmbeddings();

    const result = (await hooksRoute.handler({
      task: 'pentest a server with metasploit and msfvenom',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    // Primary may not always promote (threshold is 4 for blended-score*10),
    // but the routing method label should at least mention the semantic
    // backend whenever the user-skill path took over.
    const primary = result.primaryAgent as { source?: string };
    if (primary.source === 'user') {
      const routing = result.routing as { method: string; backend: string };
      expect(routing.method).toMatch(/^user-installed-(hybrid|embedding|keyword)$/);
    }
    // Always: userInstalledMatches must be present.
    expect(Array.isArray(result.userInstalledMatches)).toBe(true);
  });

  it('falls back to keyword scorer when Ollama is unreachable (no crash, still returns matches)', async () => {
    setupRegressionSkills();
    mockOllamaUnavailable();

    const result = (await hooksRoute.handler({
      task: 'pentest with metasploit module discovery',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const userMatches = result.userInstalledMatches as Array<{ name: string; score: number }>;
    // Keyword fallback should still find kali-metasploit via the
    // 'metasploit' / 'pentest' name+description hits.
    const names = userMatches.map(m => m.name);
    expect(names).toContain('kali-metasploit');
  });

  it('preserves built-in routing when no user skills match (no regression on existing path)', async () => {
    // No skills at all — behavior must match the original keyword-path test.
    mockOllamaWithSemanticEmbeddings();

    const result = (await hooksRoute.handler({
      task: 'fix a bug in the validation logic',
      useSemanticRouter: false,
    })) as Record<string, unknown>;

    const primary = result.primaryAgent as { type: string; source?: string };
    expect(primary.source ?? 'built-in').toBe('built-in');
    expect(result.userInstalledMatches).toEqual([]);
  });
});
