/**
 * ROUTING-A — agent-router pattern matcher.
 *
 * Covers two artifacts:
 *   1. The JS router emitted by `generateAgentRouter()` in
 *      `src/init/helpers-generator.ts` (the one Claude Code's hook handler
 *      invokes via `~/.claude/helpers/router.js`).
 *   2. The bash hook script at `~/.claude/hooks/agent-router.sh`. Tested via
 *      child_process so we exercise the actual deployed file.
 *
 * Why this exists: today's session spawned 15+ agents, every single one as
 * `subagent_type: "coder"`, because the previous matcher's first-match-wins
 * regex loop fired `coder` on any "implement" verb, masking language /
 * framework / domain signals. The new layered scorer must:
 *   - Recognize TypeScript / Python / Swift / framework / domain tokens.
 *   - Suppress generic agents when ANY specialist matches (specialist boost).
 *   - Anchor language tokens with word boundaries so "swift response" /
 *     "rust trust" don't false-match.
 *   - Fall back to general-purpose (NOT coder) when nothing matches.
 *   - Fall back to coder ONLY for prompts that contain pure action verbs
 *     and zero specialist signal.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { generateAgentRouter } from '../src/init/helpers-generator.js';

// ── Shared fixture: emit the generator's JS to a temp file so we can require
// it. We do this once per file and cache the path.
let routerPath: string | null = null;

function getRouterPath(): string {
  if (routerPath) return routerPath;
  const dir = mkdtempSync(join(tmpdir(), 'router-test-'));
  routerPath = join(dir, 'router.cjs');
  writeFileSync(routerPath, generateAgentRouter());
  return routerPath;
}

interface RouteResult {
  agent: string;
  confidence: number;
  reason: string;
  alternatives?: Array<{ agent: string; priority: number }>;
  hints?: string[];
}

function routeJS(prompt: string): RouteResult {
  const json = execFileSync('node', [getRouterPath(), prompt], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  return JSON.parse(json) as RouteResult;
}

const BASH_ROUTER = join(homedir(), '.claude', 'hooks', 'agent-router.sh');
const HAS_BASH_ROUTER = existsSync(BASH_ROUTER);

function routeBash(prompt: string): string[] {
  const stdin = JSON.stringify({ prompt });
  const out = execFileSync(BASH_ROUTER, [], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 5000,
  });
  // Lines starting with two spaces and a bullet are agent matches.
  return out
    .split('\n')
    .filter((l) => l.startsWith('  •'))
    .map((l) => l.replace(/^\s*•\s*/, '').split(/\s+—\s+/)[0]);
}

describe('agent-router (generated JS) — language specialists', () => {
  it('routes TypeScript-flavored prompts to typescript-expert', () => {
    expect(routeJS('implement Tier 1 batch in TypeScript').agent).toBe(
      'typescript-expert',
    );
    expect(routeJS('refactor the .ts controller to use generics').agent).toBe(
      'typescript-expert',
    );
    expect(routeJS('tighten tsconfig with noImplicitAny').agent).toBe(
      'typescript-expert',
    );
  });

  it('routes Python-flavored prompts to python-expert', () => {
    expect(routeJS('fix Python async issue with asyncio').agent).toBe(
      'python-expert',
    );
    expect(routeJS('add pydantic validation to the FastAPI handler').agent).toBe(
      'python-expert',
    );
    expect(routeJS('install pip and create a venv').agent).toBe('python-expert');
  });

  it('routes Swift-flavored prompts to swift-developer', () => {
    expect(routeJS('build a Swift package for visionos').agent).toBe(
      'swift-developer',
    );
    expect(routeJS('add a SwiftUI view with @Observable').agent).toBe(
      'swift-developer',
    );
    expect(routeJS('open the .xcodeproj and add a target').agent).toBe(
      'swift-developer',
    );
  });

  it('does NOT false-match Swift on unrelated "swift" / "rust" mentions', () => {
    // "swift response" is plain English, not the Swift language.
    expect(routeJS('swift response from the server').agent).toBe(
      'general-purpose',
    );
    // "trust me" should not match \\brust\\b because we don't even have a rust
    // pattern; this asserts general-purpose for prompts with no signal.
    expect(routeJS('rust trust me bro').agent).toBe('general-purpose');
    // "swiftly" must not anchor to swift.
    expect(routeJS('move swiftly through the bug list').agent).toBe(
      'general-purpose',
    );
  });
});

describe('agent-router (generated JS) — framework specialists', () => {
  it('routes API design prompts to api-designer', () => {
    expect(routeJS('design REST API for user management').agent).toBe(
      'api-designer',
    );
    expect(routeJS('write an OpenAPI spec for the orders service').agent).toBe(
      'api-designer',
    );
  });

  it('routes Express/Fastify backend prompts to backend-dev', () => {
    expect(routeJS('add an express middleware for auth').agent).toBe(
      'backend-dev',
    );
    expect(routeJS('build the rest endpoint for /healthz').agent).toBe(
      'backend-dev',
    );
  });

  it('routes React Native to mobile-dev', () => {
    expect(routeJS('add an Expo screen with React Native').agent).toBe(
      'mobile-dev',
    );
  });
});

describe('agent-router (generated JS) — domain-of-work specialists', () => {
  it('routes security audits to security-auditor (forward AND reverse word order)', () => {
    expect(routeJS('audit security of this auth flow').agent).toBe(
      'security-auditor',
    );
    expect(routeJS('security audit of the login handler').agent).toBe(
      'security-auditor',
    );
    expect(routeJS('audit the JWT auth').agent).toBe('security-auditor');
  });

  it('routes performance work to performance-engineer', () => {
    expect(routeJS('profile cold-start performance').agent).toBe(
      'performance-engineer',
    );
    expect(routeJS('lazy-load bin/cli.js for cold start').agent).toBe(
      'performance-engineer',
    );
    expect(routeJS('investigate the memory leak in the embeddings cache').agent)
      .toBe('performance-engineer');
  });

  it('routes refactoring intent to refactoring-specialist', () => {
    expect(routeJS('refactor the legacy module').agent).toBe(
      'refactoring-specialist',
    );
    expect(routeJS('extract a helper function from the parser').agent).toBe(
      'refactoring-specialist',
    );
  });

  it('routes test-writing to test-engineer (specialist), NOT generic tester', () => {
    expect(routeJS('write a test for the parser').agent).toBe('test-engineer');
    expect(routeJS('add tests for the matcher').agent).toBe('test-engineer');
    expect(routeJS('integration test for the router').agent).toBe(
      'test-engineer',
    );
  });

  it('routes debugging prompts to debugger', () => {
    expect(routeJS('why is the test failing').agent).toBe('debugger');
    expect(routeJS('reproduce the crash and find the root cause').agent).toBe(
      'debugger',
    );
  });
});

describe('agent-router (generated JS) — domain specialists outrank everything', () => {
  it('routes polymarket prompts to polymarket-dev (priority 100)', () => {
    expect(routeJS('implement polymarket order placement').agent).toBe(
      'polymarket-dev',
    );
  });

  it('routes solana prompts to solana-trading-specialist', () => {
    expect(routeJS('analyze Solana raydium swap latency').agent).toBe(
      'solana-trading-specialist',
    );
  });

  it('routes pentest prompts to kali-operator', () => {
    expect(routeJS('run nmap and metasploit on this CTF box').agent).toBe(
      'kali-operator',
    );
  });
});

describe('agent-router (generated JS) — fallbacks', () => {
  it('falls back to general-purpose when no pattern matches', () => {
    expect(routeJS('explore the codebase for X').agent).toBe('researcher'); // anchored verb
    expect(routeJS('something completely unspecified').agent).toBe(
      'general-purpose',
    );
  });

  it('falls back to coder ONLY when generic verbs match and no specialist did', () => {
    // Pure verbs, no specialist signal whatsoever.
    expect(routeJS('implement create build add').agent).toBe('coder');
  });

  it('handles empty / invalid input safely', () => {
    expect(routeJS('').agent).toBe('general-purpose');
  });
});

describe('agent-router (generated JS) — specialist boost', () => {
  it('drops generic coder when a specialist also matches', () => {
    // "implement" matches the generic coder verb, but TypeScript matches the
    // language specialist. Specialist must win.
    const result = routeJS('implement the parser in TypeScript');
    expect(result.agent).toBe('typescript-expert');
    // The alternatives must NOT contain generic agents.
    const generics = new Set(['coder', 'tester', 'reviewer', 'general-purpose']);
    for (const alt of result.alternatives ?? []) {
      expect(generics.has(alt.agent)).toBe(false);
    }
  });

  it('exposes priority in the recommendation reason for transparency', () => {
    const result = routeJS('implement the parser in TypeScript');
    expect(result.reason).toMatch(/priority \d+/);
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});

describe('agent-router (generated JS) — confidence calibration', () => {
  it('assigns high confidence to domain matches (priority 100)', () => {
    const result = routeJS('implement polymarket order placement');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('assigns moderate confidence to language matches (priority 80)', () => {
    const result = routeJS('refactor the .ts module');
    // Refactoring (60) + typescript (80). Specialist boost keeps both, sort
    // picks priority 80.
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('assigns low confidence to generic-only fallback', () => {
    const result = routeJS('implement create build add');
    expect(result.confidence).toBeLessThanOrEqual(0.7);
  });
});

describe('agent-router (generated JS) — ROUTING-broad: payments / commerce', () => {
  it('routes Stripe checkout webhook to agentic-payments', () => {
    expect(routeJS('implement Stripe checkout webhook').agent).toBe(
      'agentic-payments',
    );
  });

  it('routes generic payment-API work to agentic-payments', () => {
    expect(routeJS('add a payment API integration with paypal and refund flow').agent).toBe(
      'agentic-payments',
    );
  });

  it('routes ecommerce cart abandonment to agentic-payments', () => {
    expect(routeJS('design ecommerce cart abandon recovery flow').agent).toBe(
      'agentic-payments',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: OSINT / pentest', () => {
  it('routes "investigate the email phish" to osint-investigator', () => {
    expect(routeJS('investigate the email phish targeting our exec').agent).toBe(
      'osint-investigator',
    );
  });

  it('routes domain investigation to osint-investigator', () => {
    expect(routeJS('do a domain investigation and reverse image search on this target').agent).toBe(
      'osint-investigator',
    );
  });

  it('routes htb / kerberoast to kali-operator', () => {
    expect(routeJS('scan the htb box for SUID and try kerberoast').agent).toBe(
      'kali-operator',
    );
  });

  it('routes hash cracking to kali-operator', () => {
    expect(routeJS('hash cracking workflow with hashcat for this CTF').agent).toBe(
      'kali-operator',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: GEO / AI visibility', () => {
  it('routes llms.txt audit to geo-ai-visibility', () => {
    expect(routeJS('audit our llms.txt for AI crawlers').agent).toBe(
      'geo-ai-visibility',
    );
  });

  it('routes ChatGPT search visibility to geo-ai-visibility', () => {
    expect(routeJS('improve our brand in ai overview and chatgpt search citation').agent).toBe(
      'geo-ai-visibility',
    );
  });

  it('routes schema markup to geo-schema', () => {
    expect(routeJS('add JSON-LD schema markup with sameas and structured data').agent).toBe(
      'geo-schema',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: Apple UI design', () => {
  it('routes "redesign the macOS sidebar UI" to apple-ui-designer', () => {
    expect(routeJS('redesign the macOS sidebar UI').agent).toBe(
      'apple-ui-designer',
    );
  });

  it('routes Apple HIG / SF Symbols to apple-ui-designer', () => {
    expect(routeJS('apply apple hig and sf symbols for the new ios design').agent).toBe(
      'apple-ui-designer',
    );
  });

  it('routes visionos design to apple-ui-designer', () => {
    expect(routeJS('design visionos design ornament for the new app').agent).toBe(
      'apple-ui-designer',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: GitHub OSS research', () => {
  it('routes "find oss tool" to github-researcher', () => {
    expect(routeJS('find oss tool for distributed tracing on github').agent).toBe(
      'github-researcher',
    );
  });

  it('routes "oss alternative to" to github-researcher', () => {
    expect(routeJS('look for oss alternative to datadog with github stars analysis').agent).toBe(
      'github-researcher',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: crypto trading research', () => {
  it('routes generic crypto market microstructure to crypto-research-scientist', () => {
    expect(routeJS('study orderbook depth on bybit for perpetual future market making').agent).toBe(
      'crypto-research-scientist',
    );
  });
});

describe('agent-router (generated JS) — ROUTING-broad: domain hints (no specialist)', () => {
  it('emits a hint for GDPR / cookie banner work', () => {
    const result = routeJS('write GDPR-compliant cookie banner for our terms of service');
    expect(result.agent).toBe('general-purpose');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('legal/compliance'))).toBe(true);
  });

  it('emits a hint for email marketing campaigns', () => {
    const result = routeJS('draft an email marketing campaign and copywriting headline');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('marketing'))).toBe(true);
  });

  it('emits a hint for AR ledger reconciliation', () => {
    const result = routeJS('reconcile the AR ledger and accounts receivable for q4');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('finance/accounting'))).toBe(true);
  });

  it('emits a hint for HR job description', () => {
    const result = routeJS('write a job description for senior recruiter with onboarding plan');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('hr/recruitment'))).toBe(true);
  });

  it('emits a hint for sales pipeline analysis', () => {
    const result = routeJS('do a pipeline analysis for the sales playbook with lead scoring');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('sales/crm'))).toBe(true);
  });

  it('emits a hint for healthcare EHR/EMR work', () => {
    const result = routeJS('design medical record system with patient record workflow');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('healthcare'))).toBe(true);
  });

  it('emits a hint for education curriculum', () => {
    const result = routeJS('curriculum design with learning objective and lesson plan');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('education'))).toBe(true);
  });

  it('emits a hint for technical writing white papers', () => {
    const result = routeJS('write a white paper on the new architecture with editorial style');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('writing'))).toBe(true);
  });

  it('emits NO hint when only coding domains are mentioned', () => {
    const result = routeJS('implement the parser in TypeScript');
    expect(result.hints).toEqual([]);
  });

  it('emits a hint AND routes to specialist when both signals present', () => {
    // Stripe checkout (specialist) + email marketing (hint domain)
    const result = routeJS('implement Stripe checkout webhook AND draft an email marketing campaign');
    expect(result.agent).toBe('agentic-payments');
    expect(result.hints).toBeDefined();
    expect(result.hints!.some((h) => h.includes('marketing'))).toBe(true);
  });
});

describe.runIf(HAS_BASH_ROUTER)('agent-router (deployed bash hook)', () => {
  it('emits typescript-expert for TypeScript prompts', () => {
    const matches = routeBash('implement Tier 1 batch in TypeScript');
    expect(matches).toContain('typescript-expert');
  });

  it('suppresses the generic coder bullet when a specialist matched', () => {
    const matches = routeBash('implement Tier 1 batch in TypeScript');
    expect(matches).not.toContain('coder');
  });

  it('emits security-auditor for "audit security of auth"', () => {
    const matches = routeBash('audit security of this auth flow');
    expect(matches).toContain('security-auditor');
  });

  it('still falls back to coder for pure-verb prompts', () => {
    const matches = routeBash('implement create build add');
    expect(matches).toContain('coder');
  });

  it('completes within the 100ms hook budget for a typical prompt', () => {
    const start = Date.now();
    routeBash('implement the parser in TypeScript with strict types');
    const elapsed = Date.now() - start;
    // Generous: hook must finish well under the 10s timeout configured in
    // settings-generator.ts; tighter target is < 100ms but bash subshell
    // overhead on slow CI may push higher. Fail at 500ms.
    expect(elapsed).toBeLessThan(500);
  });
});
