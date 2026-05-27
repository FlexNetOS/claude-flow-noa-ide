/**
 * Helpers Generator
 * Creates utility scripts in .claude/helpers/
 */

import type { InitOptions } from './types.js';
import { generateStatuslineScript, generateStatuslineHook } from './statusline-generator.js';

/**
 * Template-side helper string injected into every generated runtime helper
 * (memory.js, session.js, intelligence.cjs, …). It exposes a single function
 *
 *   resolveFlowPath(...segs)
 *
 * that resolves a path under the *running* user's data directory:
 *
 *   1. Try `path.join(process.cwd(), ...segs)`. If the parent directory exists
 *      OR the cwd is writable, prefer it (per-project install — current
 *      behavior).
 *   2. Otherwise fall back to `path.join(os.homedir(), '.claude', ...segs)`
 *      (global install — `~/.claude/`). When `segs[0] === '.claude'` the
 *      redundant prefix is dropped to avoid `~/.claude/.claude/...` (#bug1,
 *      same root cause as #bug8).
 *
 * This converges writes from CWD-relative `.claude-flow/` literals into the
 * single `~/.claude/.claude-flow/` data directory under a globally-installed
 * Ruflo, while staying backward-compatible with the per-project install case.
 *
 * Emit this *string* at the top of every helper template (after the
 * `require('fs/path/os')` lines) before declaring any path constants that
 * previously used `path.join(process.cwd(), '.claude-flow', ...)`.
 */
export const RESOLVE_FLOW_PATH_HELPER = `
function resolveFlowPath(...segs) {
  // Drop redundant leading '.claude' segment for global-install case so we
  // never produce ~/.claude/.claude/... (mirrors settings-generator #bug8).
  function stripRedundant(home, parts) {
    if (parts.length > 0 && parts[0] === '.claude') return parts.slice(1);
    return parts;
  }

  const cwdPath = path.join(process.cwd(), ...segs);
  try {
    // Prefer cwd if its parent already exists (per-project install) or if
    // we can create it (writable cwd, no global override needed).
    const parent = path.dirname(cwdPath);
    if (fs.existsSync(parent)) return cwdPath;
    fs.mkdirSync(parent, { recursive: true });
    // Probe writability — a successful mkdir is enough on POSIX/Windows.
    return cwdPath;
  } catch {
    // Fall through to global fallback
  }

  const homeBase = path.join(os.homedir(), '.claude');
  return path.join(homeBase, ...stripRedundant(homeBase, segs));
}
`;

/**
 * Generate pre-commit hook script
 */
export function generatePreCommitHook(): string {
  return `#!/bin/bash
# Ruflo Pre-Commit Hook
# Validates code quality before commit

set -e

echo "🔍 Running Ruflo pre-commit checks..."

# Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

# Run validation for each staged file
for FILE in $STAGED_FILES; do
  if [[ "$FILE" =~ \\.(ts|js|tsx|jsx)$ ]]; then
    echo "  Validating: $FILE"
    npx @claude-flow/cli hooks pre-edit --file "$FILE" --validate-syntax 2>/dev/null || true
  fi
done

# Run tests if available
if [ -f "package.json" ] && grep -q '"test"' package.json; then
  echo "🧪 Running tests..."
  npm test --if-present 2>/dev/null || echo "  Tests skipped or failed"
fi

echo "✅ Pre-commit checks complete"
`;
}

/**
 * Generate post-commit hook script
 */
export function generatePostCommitHook(): string {
  return `#!/bin/bash
# Ruflo Post-Commit Hook
# Records commit metrics and trains patterns

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B)

echo "📊 Recording commit metrics..."

# Notify ruflo of commit
npx ruflo@latest hooks notify \\
  --message "Commit: $COMMIT_MSG" \\
  --level info \\
  --metadata '{"hash": "'$COMMIT_HASH'"}' 2>/dev/null || true

echo "✅ Commit recorded"
`;
}

/**
 * Generate session manager script
 */
export function generateSessionManager(): string {
  return `#!/usr/bin/env node
/**
 * Ruflo Session Manager
 * Handles session lifecycle: start, restore, end
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
${RESOLVE_FLOW_PATH_HELPER}
const SESSION_DIR = resolveFlowPath('.claude-flow', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');

const commands = {
  start: () => {
    const sessionId = \`session-\${Date.now()}\`;
    const session = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      context: {},
      metrics: {
        edits: 0,
        commands: 0,
        tasks: 0,
        errors: 0,
      },
    };

    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

    console.log(\`Session started: \${sessionId}\`);
    return session;
  },

  restore: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No session to restore');
      return null;
    }

    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.restoredAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

    console.log(\`Session restored: \${session.id}\`);
    return session;
  },

  end: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }

    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.endedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();

    // Archive session
    const archivePath = path.join(SESSION_DIR, \`\${session.id}.json\`);
    fs.writeFileSync(archivePath, JSON.stringify(session, null, 2));
    fs.unlinkSync(SESSION_FILE);

    console.log(\`Session ended: \${session.id}\`);
    console.log(\`Duration: \${Math.round(session.duration / 1000 / 60)} minutes\`);
    console.log(\`Metrics: \${JSON.stringify(session.metrics)}\`);

    return session;
  },

  status: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }

    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    const duration = Date.now() - new Date(session.startedAt).getTime();

    console.log(\`Session: \${session.id}\`);
    console.log(\`Started: \${session.startedAt}\`);
    console.log(\`Duration: \${Math.round(duration / 1000 / 60)} minutes\`);
    console.log(\`Metrics: \${JSON.stringify(session.metrics)}\`);

    return session;
  },

  update: (key, value) => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }

    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.context[key] = value;
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));

    return session;
  },

  metric: (name) => {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }

    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    if (session.metrics[name] !== undefined) {
      session.metrics[name]++;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    }

    return session;
  },
};

// CLI
const [,, command, ...args] = process.argv;

if (command && commands[command]) {
  commands[command](...args);
} else {
  console.log('Usage: session.js <start|restore|end|status|update|metric> [args]');
}

module.exports = commands;
`;
}

/**
 * Generate agent router script (ROUTING-A 2026-05).
 *
 * Layered scorer that routes prompts to the most-specific specialist instead
 * of the previous first-match-wins regex loop, which fired `coder` on every
 * "implement" verb. Priority bands (highest wins):
 *   100 — project / business domain (polymarket, solana, kali, ...)
 *    80 — language specialist (typescript, python, swift)
 *    70 — framework / API design
 *    60 — domain-of-work (security, perf, refactor, db, infra, deploy, debug)
 *    50 — anchored action verbs (review code, explore codebase)
 *    20 — generic action verbs (implement, build) → coder
 *
 * Specialist boost: when ANY non-generic agent matches, generics (coder /
 * tester / reviewer / general-purpose) are dropped from the candidate set.
 *
 * Word boundaries are used aggressively to avoid false positives (e.g.
 * "swift response" must NOT route to swift-developer).
 */
export function generateAgentRouter(): string {
  return `#!/usr/bin/env node
/**
 * Ruflo Agent Router (ROUTING-A 2026-05, ROUTING-broad 2026-05-09)
 * Routes tasks to optimal agents using a layered specialist-first scorer.
 *
 * ROUTING-broad extends coverage beyond pure coding to include payments,
 * crypto-research, OSINT, AI visibility/GEO, Apple UI design, GitHub OSS
 * research and more — plus a domain-hint mechanism that surfaces detected
 * non-code domains (legal, marketing, finance, hr, sales, healthcare,
 * education, writing, design-non-apple, project-mgmt) without fake-routing
 * to a non-existent specialist.
 */

const AGENT_CAPABILITIES = {
  coder: ['code-generation', 'refactoring', 'debugging', 'implementation'],
  tester: ['unit-testing', 'integration-testing', 'coverage', 'test-generation'],
  reviewer: ['code-review', 'security-audit', 'quality-check', 'best-practices'],
  researcher: ['web-search', 'documentation', 'analysis', 'summarization'],
  architect: ['system-design', 'architecture', 'patterns', 'scalability'],
  'general-purpose': ['exploration', 'open-ended-research'],
  'typescript-expert': ['typescript', 'strict-types', 'generics', 'tsconfig'],
  'python-expert': ['python', 'asyncio', 'fastapi', 'pydantic', 'mypy'],
  'swift-developer': ['swift', 'swiftui', 'apple-platforms', 'concurrency'],
  'system-architect': ['architecture', 'ddd', 'bounded-context', 'adr'],
  'backend-architect': ['api-design', 'service-architecture', 'auth-flows'],
  'backend-dev': ['api', 'database', 'server', 'authentication'],
  'frontend-dev': ['ui', 'react', 'css', 'components'],
  'mobile-dev': ['react-native', 'expo', 'mobile-cross-platform'],
  'apple-ui-designer': ['hig', 'sf-symbols', 'apple-ux'],
  'api-designer': ['rest', 'graphql', 'openapi', 'versioning'],
  'security-architect': ['threat-modeling', 'zero-trust', 'attack-surface'],
  'security-auditor': ['vuln-scan', 'cve', 'sast', 'dast', 'compliance'],
  'performance-engineer': ['profiling', 'cold-start', 'wasm', 'memory-leak'],
  'performance-profiler': ['flamegraph', 'cpu-profile', 'heap-snapshot'],
  'refactoring-specialist': ['technical-debt', 'design-patterns', 'cleanup'],
  'database-optimizer': ['schema-design', 'query-optimization', 'indexing'],
  'infrastructure-architect': ['cloud', 'k8s', 'terraform', 'ha', 'dr'],
  'deployment-engineer': ['ci-cd', 'docker', 'helm', 'pipelines'],
  'test-engineer': ['tdd', 'bdd', 'test-pyramid', 'fixtures'],
  debugger: ['root-cause', 'reproduction', 'permanent-fix'],
  'polymarket-dev': ['polymarket', 'clob', 'gamma', 'live-draw'],
  'solana-trading-specialist': ['solana', 'raydium', 'pumpfun', 'jupiter'],
  'flashloan-arbitrage-specialist': ['flashloan', 'aave', 'atomic-arb'],
  'crypto-research-scientist': ['backtest', 'funding-rate', 'volatility'],
  'kali-operator': ['nmap', 'metasploit', 'pentest', 'ctf'],
  'metasploit-operator': ['msf-modules', 'msfdb', 'msfvenom'],
  'osint-investigator': ['osint', 'sherlock', 'maigret', 'phoneinfoga'],
  'trading-ml-expert': ['order-book', 'vpin', 'isotonic-calibration'],
  // ROUTING-broad additions (non-coding specialists)
  'agentic-payments': ['payment', 'stripe', 'subscription', 'billing', 'checkout'],
  'github-researcher': ['oss-tool', 'github-stars', 'oss-alternative'],
  'geo-ai-visibility': ['ai-visibility', 'llms-txt', 'ai-citation'],
  'geo-content': ['eeat', 'topical-authority', 'helpful-content'],
  'geo-platform-analysis': ['ai-overview', 'perplexity', 'chatgpt-search'],
  'geo-schema': ['schema-markup', 'jsonld', 'structured-data'],
  'geo-technical': ['crawlability', 'core-web-vitals', 'inp'],
  'geo-brand-mentions': ['brand-mentions', 'sameas', 'co-citation'],
};

// [regex source, agent, priority]. Higher priority wins.
const PATTERNS = [
  // Tier 1: domain (100)
  ['\\\\b(polymarket|polybot|live[_ -]?draw|oracle[_ -]?crash|gamma api|clob|negrisk|conditionid)\\\\b', 'polymarket-dev', 100],
  ['\\\\b(solana|raydium|pump\\\\.?fun|jupiter aggregator|jito bundle|meteora|spl token|token-2022|helius|triton|shyft|jito|kamino|marginfi|drift protocol)\\\\b', 'solana-trading-specialist', 100],
  ['\\\\b(flashloan|flash[_ -]?loan|atomic arb|aave flashloan|balancer flashloan|liquidation bot)\\\\b', 'flashloan-arbitrage-specialist', 100],
  ['\\\\b(crypto strategy|trading strategy|backtest|funding[ -]?rate|market[ -]?making|volatility estimator|on[ -]?chain signal|defi research|mev research|exchange api|kraken|bybit|bitfinex|orderbook depth|perpetual future)\\\\b', 'crypto-research-scientist', 100],
  ['\\\\b(nmap|gobuster|ffuf|metasploit|msfvenom|msfconsole|hashcat|hydra|burp|kali|pentest|ctf|hack ?the ?box|htb|picoctf|tryhackme|reverse shell|hash cracking|privesc|exploit dev|payload gen|post[ -]?exploitation|lateral movement|kerberoast|asreproast)\\\\b', 'kali-operator', 100],
  ['\\\\b(metasploit framework|msf module|msfdb|workspace.*msf|exploit/(linux|windows|multi)|payload generation)\\\\b', 'metasploit-operator', 100],
  ['\\\\b(osint|open[ -]?source intel(ligence)?|recon target|footprint(ing)?|find email|find username|sherlock|maigret|holehe|phoneinfoga|ghunt|exiftool|reverse image search|email enum(eration)?|domain investigation|geolocate|doxx|email phish)\\\\b', 'osint-investigator', 100],
  ['\\\\b(order book imbalance|vpin|ofi|vamp|yang-?zhang|garman[ -]?klass|isotonic calibration|triple-barrier label)\\\\b', 'trading-ml-expert', 100],

  // Tier 1: payments / commerce (100)
  ['\\\\b(stripe|paypal|braintree|adyen|mollie|klarna|square payments|checkout flow|checkout webhook|subscription billing|invoice gen|chargeback|refund flow|payment api|payments? webhook|cart abandon|apple pay|google pay|ecommerce|e-commerce)\\\\b', 'agentic-payments', 100],

  // Tier 1: AI visibility / GEO (100)
  ['\\\\b(ai visibility|llms\\\\.txt|ai citation|ai overview|perplexity citation|chatgpt search|gemini search|brand in ai|ai crawler|geo audit|ai search optimi)\\\\b', 'geo-ai-visibility', 100],
  ['\\\\b(schema markup|jsonld|json-ld|structured data|sameas|speakable schema)\\\\b', 'geo-schema', 100],
  ['\\\\b(e-?e-?a-?t\\\\b|topical authority|helpful content|ai content detection)\\\\b', 'geo-content', 100],
  ['\\\\b(crawlability|core web vitals|\\\\binp\\\\b|robots\\\\.txt for ai)\\\\b', 'geo-technical', 100],
  ['\\\\b(brand mention|co-citation|brand co-?occurrence)\\\\b', 'geo-brand-mentions', 100],

  // Tier 1: github OSS research (100)
  ['\\\\b(github tool search|find oss tool|oss alternative to|open source replacement|github stars analysis|github repo evaluation)\\\\b', 'github-researcher', 100],

  // Tier 2: language (80)
  ['(\\\\btypescript\\\\b|\\\\.ts\\\\b|\\\\.tsx\\\\b|\\\\btsconfig\\\\b|\\\\bnoimplicitany\\\\b|\\\\btsc\\\\b|\\\\bts-node\\\\b|\\\\bts-prune\\\\b|\\\\bgeneric constraint\\\\b|\\\\bconditional type\\\\b|\\\\bmapped type\\\\b)', 'typescript-expert', 80],
  ['(\\\\bpython\\\\b|\\\\.py\\\\b|\\\\bpyproject\\\\.toml\\\\b|\\\\bpip install\\\\b|\\\\bvenv\\\\b|\\\\bvirtualenv\\\\b|\\\\basyncio\\\\b|\\\\basync def\\\\b|\\\\bpydantic\\\\b|\\\\bmypy\\\\b|\\\\bruff\\\\b|\\\\bpoetry\\\\b)', 'python-expert', 80],
  ['(\\\\bswiftui\\\\b|\\\\bswift code\\\\b|\\\\bxcode\\\\b|\\\\bswift package\\\\b|\\\\bswift concurrency\\\\b|\\\\bappkit\\\\b|\\\\buikit\\\\b|\\\\bswiftdata\\\\b|\\\\.xcodeproj\\\\b|\\\\.swift\\\\b|package\\\\.swift|@observable)', 'swift-developer', 80],

  // Tier 3: frameworks (70)
  ['\\\\b(express\\\\b|fastify\\\\b|nestjs|hono\\\\b|rest endpoint|graphql server|grpc\\\\b|backend api)\\\\b', 'backend-dev', 70],
  ['\\\\b(react component|tsx file|jsx\\\\b|tailwind|vite\\\\b|next\\\\.?js|vue\\\\b|svelte|tanstack|frontend ui)\\\\b', 'frontend-dev', 70],
  ['\\\\b(react native|expo\\\\b|metro bundler|ios.*react native|android.*react native)\\\\b', 'mobile-dev', 70],
  // Apple UI design — extended with explicit redesign forms and platform variants
  ['\\\\b(apple hig|human interface guidelines|sf symbols|sf pro|dynamic type|sidebar.*macos|tab bar.*ios|ornament.*visionos|macos design|ios design|ipados design|watchos design|visionos design|apple native ui|swiftui mockup|redesign (the )?(macos|ios|ipados|watchos|visionos) (sidebar|tab bar|toolbar|ui|navigation)|(macos|ios|ipados|watchos|visionos) sidebar)\\\\b', 'apple-ui-designer', 70],
  ['\\\\b(api design|rest design|graphql design|openapi|swagger|api versioning|api documentation|design (the |a |an )?(rest |graphql |grpc )?(api|endpoint|service)|design.*for.*(api|user management|users|account))\\\\b', 'api-designer', 70],
  ['\\\\b(fastapi|django\\\\b|flask\\\\b|sqlalchemy)\\\\b', 'python-expert', 75],

  // Tier 4: domain-of-work (60)
  ['\\\\b(threat model|security architecture|zero[ -]?trust|attack surface|threat pattern|stride\\\\b|owasp.*design)\\\\b', 'security-architect', 60],
  ['\\\\b(security audit|vuln scan|\\\\bcve\\\\b|owasp top 10|\\\\bsast\\\\b|\\\\bdast\\\\b|penetration test|compliance audit|hardening|audit (this |the |my )?(security|auth|login|session|token|jwt|oauth|password|crypto|tls|ssl)|audit (security|the auth flow|of (this|the|my) auth))\\\\b', 'security-auditor', 60],
  ['\\\\b(performance profil|optimi[sz]e (cli|build|bundle|cold start|warm path|startup)|prompt cache|wasm simd|flash attention|memory leak|lazy[ -]?load|n\\\\+1|bottleneck|cold[ -]?start)\\\\b', 'performance-engineer', 60],
  ['\\\\b(profile.*application|cpu profil|heap snapshot|flamegraph|trace.*perf|perf.*trace|node --prof|p95 (latency|regress))\\\\b', 'performance-profiler', 60],
  ['\\\\b(refactor|technical debt|legacy code|design pattern|extract (a |the |an )?(helper |util(ity)? )?(method|function|class|module)|hoist\\\\b|interface segregation|cleanup my code|simplify (this|the) code)\\\\b', 'refactoring-specialist', 60],
  ['\\\\b(system architect|microservic|monolith|c4 model|architectural decision|\\\\badr\\\\b|domain[ -]?driven|bounded context|architectural pattern)\\\\b', 'system-architect', 60],
  ['\\\\b(database (schema|design|optim)|slow query|index strategy|postgres tuning|query plan|qdrant collection|neo4j cypher|sql tuning|n\\\\+1.*query|migration plan)\\\\b', 'database-optimizer', 60],
  ['\\\\b(aws\\\\b|gcp\\\\b|azure\\\\b|kubernetes|\\\\bk8s\\\\b|terraform|disaster recovery|high availability|cloud architect|infra design)\\\\b', 'infrastructure-architect', 60],
  ['\\\\b(ci/?cd|github actions|gitlab ci|docker compose|dockerfile|kubernetes deploy|helm chart|kustomize|deploy pipeline|ansible)\\\\b', 'deployment-engineer', 60],
  ['\\\\b(why (is|does|doesn.?t|isn.?t)|broken|crash(ed|ing)?|traceback|stack ?trace|error.*line|test.*failing|exception (thrown|unhandled)|debug this|root cause|repro(duce|duction))\\\\b', 'debugger', 60],
  ['\\\\b(test strategy|\\\\btdd\\\\b|\\\\bbdd\\\\b|test pyramid|integration test|e2e test|test coverage|fixture design|(write|add) (a |an |the )?(unit |integration |e2e )?tests? for|unit tests? for|tests? for the)\\\\b', 'test-engineer', 60],
  ['\\\\b(design (the )?api|design (the )?backend|architecture decision)\\\\b', 'backend-architect', 60],

  // Tier 5: anchored verbs (50)
  ['\\\\b(review (this|my|the) (code|pr|patch|diff|change)|code review|pr review|review my work)\\\\b', 'reviewer', 50],
  ['\\\\b(research|find documentation|search the codebase|where is .* (defined|implemented|used|called)|explore the codebase)\\\\b', 'researcher', 50],

  // Tier 6: generic verbs (20)
  ['\\\\b(implement|create|build|add|write code|fix the|fix this)\\\\b', 'coder', 20],
];

// Domain hints — emit a hint when a non-coding domain is detected but no
// SwarmOps specialist exists. Lead picks 'general-purpose' consciously
// rather than the router fake-routing to a missing agent.
// [regex source, domain label]
const DOMAIN_HINTS = [
  ['\\\\b(contract review|gdpr|ccpa|privacy policy|terms of service|ts&cs|\\\\bdpa\\\\b|sub[ -]?processor|cookie banner|eu ai act|\\\\bdsa\\\\b|\\\\bdma\\\\b|hipaa workflow|soc ?2 compliance|data processing agreement)\\\\b', 'legal/compliance'],
  ['\\\\b(content marketing|seo audit|email campaign|drip campaign|brand strategy|ad copy|conversion rate|copywriting|growth hacking|marketing funnel|email marketing|advertising campaign|social media campaign)\\\\b', 'marketing'],
  ['\\\\b(double[ -]?entry|ledger reconcil|reconcile (the )?(ar|ap|accounts? (receivable|payable))|financial audit|tax filing|payroll|accounts (receivable|payable)|p&l\\\\b|profit and loss|balance sheet|financial reporting|reconcile the ar)\\\\b', 'finance/accounting'],
  ['\\\\b(candidate sourc|job description|salary band|performance review|onboarding plan|hr polic|recruit(ing|ment)|candidate screening)\\\\b', 'hr/recruitment'],
  ['\\\\b(salesforce config|hubspot setup|pipeline analysis|sales playbook|lead scoring|outbound campaign|account[ -]?based marketing|\\\\babm\\\\b|crm setup)\\\\b', 'sales/crm'],
  ['\\\\b(\\\\behr\\\\b|\\\\bemr\\\\b|clinical workflow|patient record|medical record system|patient data system)\\\\b', 'healthcare'],
  ['\\\\b(curriculum design|lesson plan|edtech|course design|learning objective|pedagogy)\\\\b', 'education'],
  ['\\\\b(white paper|ghostwrit|editorial style|blog (post )?outline|press release|technical writing)\\\\b', 'writing'],
  ['\\\\b(wireframe|ux research|user testing|persona development)\\\\b', 'design (non-Apple)'],
  ['\\\\b(jira setup|asana setup|sprint planning|critical path|gantt chart|product roadmap|project roadmap)\\\\b', 'project mgmt'],
  ['\\\\b(\\\\bsop\\\\b|business continuity|\\\\bbcp\\\\b)\\\\b', 'operations'],
];

const COMPILED_PATTERNS = PATTERNS.map(([source, agent, priority]) => [
  new RegExp(source, 'i'),
  source,
  agent,
  priority,
]);

const COMPILED_HINTS = DOMAIN_HINTS.map(([source, label]) => [
  new RegExp(source, 'i'),
  label,
]);

const GENERIC_AGENTS = new Set(['coder', 'tester', 'reviewer', 'general-purpose']);

function detectHints(taskLower) {
  const out = [];
  for (const [regex, label] of COMPILED_HINTS) {
    if (regex.test(taskLower)) {
      out.push(
        'Domain detected: ' + label +
        " — no SwarmOps specialist; 'general-purpose' is the safe choice"
      );
    }
  }
  return out;
}

function routeTask(task) {
  if (!task || typeof task !== 'string') {
    return {
      agent: 'general-purpose',
      confidence: 0.3,
      reason: 'Empty or invalid task — defaulting to general-purpose',
      hints: [],
    };
  }

  const taskLower = task.toLowerCase();
  const hits = [];

  for (const [regex, source, agent, priority] of COMPILED_PATTERNS) {
    if (regex.test(taskLower)) {
      hits.push({ agent, priority, source });
    }
  }

  const hints = detectHints(taskLower);

  if (hits.length === 0) {
    return {
      agent: 'general-purpose',
      confidence: 0.4,
      reason: 'No pattern matched — use general-purpose for exploration',
      hints,
    };
  }

  // Specialist boost: drop generics if any specialist matched.
  const hasSpecialist = hits.some((h) => !GENERIC_AGENTS.has(h.agent));
  const eligible = hasSpecialist
    ? hits.filter((h) => !GENERIC_AGENTS.has(h.agent))
    : hits;

  eligible.sort((a, b) => b.priority - a.priority);
  const winner = eligible[0];
  const confidence = Math.min(0.95, 0.5 + (winner.priority / 100) * 0.45);

  return {
    agent: winner.agent,
    confidence: Math.round(confidence * 100) / 100,
    reason: \`Matched pattern: \${winner.source} (priority \${winner.priority})\`,
    alternatives: eligible.slice(1, 4).map((h) => ({
      agent: h.agent,
      priority: h.priority,
    })),
    hints,
  };
}

const task = process.argv.slice(2).join(' ');

if (require.main === module) {
  // Always emit JSON so callers (hook handler, tests) can parse uniformly,
  // even for empty input — routeTask() handles the empty case.
  const result = routeTask(task);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { routeTask, AGENT_CAPABILITIES, PATTERNS, DOMAIN_HINTS, GENERIC_AGENTS };
`;
}
/**
 * Generate memory helper script
 */
export function generateMemoryHelper(): string {
  return `#!/usr/bin/env node
/**
 * Ruflo Memory Helper
 * Simple key-value memory for cross-session context
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
${RESOLVE_FLOW_PATH_HELPER}
const MEMORY_DIR = resolveFlowPath('.claude-flow', 'data');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (e) {
    // Ignore
  }
  return {};
}

function saveMemory(memory) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

const commands = {
  get: (key) => {
    const memory = loadMemory();
    const value = key ? memory[key] : memory;
    console.log(JSON.stringify(value, null, 2));
    return value;
  },

  set: (key, value) => {
    if (!key) {
      console.error('Key required');
      return;
    }
    const memory = loadMemory();
    memory[key] = value;
    memory._updated = new Date().toISOString();
    saveMemory(memory);
    console.log(\`Set: \${key}\`);
  },

  delete: (key) => {
    if (!key) {
      console.error('Key required');
      return;
    }
    const memory = loadMemory();
    delete memory[key];
    saveMemory(memory);
    console.log(\`Deleted: \${key}\`);
  },

  clear: () => {
    saveMemory({});
    console.log('Memory cleared');
  },

  keys: () => {
    const memory = loadMemory();
    const keys = Object.keys(memory).filter(k => !k.startsWith('_'));
    console.log(keys.join('\\n'));
    return keys;
  },
};

// CLI
const [,, command, key, ...valueParts] = process.argv;
const value = valueParts.join(' ');

if (command && commands[command]) {
  commands[command](key, value);
} else {
  console.log('Usage: memory.js <get|set|delete|clear|keys> [key] [value]');
}

module.exports = commands;
`;
}

/**
 * Generate hook-handler.cjs (cross-platform hook dispatcher)
 * This is the inline fallback when file copy from the package fails.
 * Uses string concatenation instead of template literals to avoid escaping issues.
 */
export function generateHookHandler(): string {
  // Build as array of lines to avoid template-in-template escaping nightmares
  const lines = [
    '#!/usr/bin/env node',
    '/**',
    ' * Ruflo Hook Handler (Cross-Platform)',
    ' * Dispatches hook events to the appropriate helper modules.',
    ' */',
    '',
    "const path = require('path');",
    "const fs = require('fs');",
    '',
    'const helpersDir = __dirname;',
    '',
    'function safeRequire(modulePath) {',
    '  try {',
    '    if (fs.existsSync(modulePath)) {',
    '      const origLog = console.log;',
    '      const origError = console.error;',
    '      console.log = () => {};',
    '      console.error = () => {};',
    '      try {',
    '        const mod = require(modulePath);',
    '        return mod;',
    '      } finally {',
    '        console.log = origLog;',
    '        console.error = origError;',
    '      }',
    '    }',
    '  } catch (e) {',
    '    // silently fail',
    '  }',
    '  return null;',
    '}',
    '',
    "const router = safeRequire(path.join(helpersDir, 'router.js'));",
    "const session = safeRequire(path.join(helpersDir, 'session.js'));",
    "const memory = safeRequire(path.join(helpersDir, 'memory.js'));",
    "const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));",
    '',
    'const [,, command, ...args] = process.argv;',
    '',
    '// Read stdin with timeout — Claude Code sends hook data as JSON via stdin.',
    '// Timeout prevents hanging when stdin is in an ambiguous state (not TTY, not pipe).',
    'async function readStdin() {',
    '  if (process.stdin.isTTY) return "";',
    '  return new Promise((resolve) => {',
    '    let data = "";',
    '    const timer = setTimeout(() => {',
    '      process.stdin.removeAllListeners();',
    '      process.stdin.pause();',
    '      resolve(data);',
    '    }, 500);',
    '    process.stdin.setEncoding("utf8");',
    '    process.stdin.on("data", (chunk) => { data += chunk; });',
    '    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });',
    '    process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });',
    '    process.stdin.resume();',
    '  });',
    '}',
    '',
    'async function main() {',
    '  let stdinData = "";',
    '  try { stdinData = await readStdin(); } catch (e) { /* ignore */ }',
    '  let hookInput = {};',
    '  if (stdinData.trim()) {',
    '    try { hookInput = JSON.parse(stdinData); } catch (e) { /* ignore */ }',
    '  }',
    '  // Prefer stdin fields, then env, then argv',
    "  var prompt = hookInput.prompt || hookInput.command || hookInput.toolInput || process.env.PROMPT || process.env.TOOL_INPUT_command || args.join(' ') || '';",
    '',
    'const handlers = {',
    "  'route': () => {",
    '    if (intelligence && intelligence.getContext) {',
    '      try {',
    '        const ctx = intelligence.getContext(prompt);',
    '        if (ctx) console.log(ctx);',
    '      } catch (e) { /* non-fatal */ }',
    '    }',
    '    if (router && router.routeTask) {',
    '      const result = router.routeTask(prompt);',
    '      var output = [];',
    "      output.push('[INFO] Routing task: ' + (prompt.substring(0, 80) || '(no prompt)'));",
    "      output.push('');",
    "      output.push('+------------------- Primary Recommendation -------------------+');",
    "      output.push('| Agent: ' + result.agent.padEnd(53) + '|');",
    "      output.push('| Confidence: ' + (result.confidence * 100).toFixed(1) + '%' + ' '.repeat(44) + '|');",
    "      output.push('| Reason: ' + result.reason.substring(0, 53).padEnd(53) + '|');",
    "      output.push('+--------------------------------------------------------------+');",
    "      if (Array.isArray(result.hints) && result.hints.length > 0) {",
    "        output.push('');",
    "        output.push('Domain hints (no specialist exists):');",
    "        for (var hi = 0; hi < result.hints.length; hi++) {",
    "          output.push('  - ' + result.hints[hi]);",
    "        }",
    "      }",
    "      console.log(output.join('\\n'));",
    '    } else {',
    "      console.log('[INFO] Router not available, using default routing');",
    '    }',
    '  },',
    '',
    "  'pre-bash': () => {",
    '    var cmd = prompt.toLowerCase();',
    "    var dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\\\', ':(){:|:&};:'];",
    '    for (var i = 0; i < dangerous.length; i++) {',
    '      if (cmd.includes(dangerous[i])) {',
    "        console.error('[BLOCKED] Dangerous command detected: ' + dangerous[i]);",
    '        process.exit(1);',
    '      }',
    '    }',
    "    console.log('[OK] Command validated');",
    '  },',
    '',
    "  'post-edit': () => {",
    '    if (session && session.metric) {',
    "      try { session.metric('edits'); } catch (e) { /* no active session */ }",
    '    }',
    '    if (intelligence && intelligence.recordEdit) {',
    '      try {',
    "        var file = process.env.TOOL_INPUT_file_path || args[0] || '';",
    '        intelligence.recordEdit(file);',
    '      } catch (e) { /* non-fatal */ }',
    '    }',
    "    console.log('[OK] Edit recorded');",
    '  },',
    '',
    "  'session-restore': () => {",
    '    if (session) {',
    '      var existing = session.restore && session.restore();',
    '      if (!existing) {',
    '        session.start && session.start();',
    '      }',
    '    } else {',
    "      console.log('[OK] Session restored: session-' + Date.now());",
    '    }',
    '    if (intelligence && intelligence.init) {',
    '      try {',
    '        var result = intelligence.init();',
    '        if (result && result.nodes > 0) {',
    "          console.log('[INTELLIGENCE] Loaded ' + result.nodes + ' patterns, ' + result.edges + ' edges');",
    '        }',
    '      } catch (e) { /* non-fatal */ }',
    '    }',
    '  },',
    '',
    "  'session-end': () => {",
    '    if (intelligence && intelligence.consolidate) {',
    '      try {',
    '        var result = intelligence.consolidate();',
    '        if (result && result.entries > 0) {',
    "          var msg = '[INTELLIGENCE] Consolidated: ' + result.entries + ' entries, ' + result.edges + ' edges';",
    "          if (result.newEntries > 0) msg += ', ' + result.newEntries + ' new';",
    "          msg += ', PageRank recomputed';",
    '          console.log(msg);',
    '        }',
    '      } catch (e) { /* non-fatal */ }',
    '    }',
    '    if (session && session.end) {',
    '      session.end();',
    '    } else {',
    "      console.log('[OK] Session ended');",
    '    }',
    '  },',
    '',
    "  'pre-task': () => {",
    '    if (session && session.metric) {',
    "      try { session.metric('tasks'); } catch (e) { /* no active session */ }",
    '    }',
    '    if (router && router.routeTask && prompt) {',
    '      var result = router.routeTask(prompt);',
    "      console.log('[INFO] Task routed to: ' + result.agent + ' (confidence: ' + result.confidence + ')');",
    '    } else {',
    "      console.log('[OK] Task started');",
    '    }',
    '  },',
    '',
    "  'post-task': () => {",
    '    if (intelligence && intelligence.feedback) {',
    '      try {',
    '        intelligence.feedback(true);',
    '      } catch (e) { /* non-fatal */ }',
    '    }',
    "    console.log('[OK] Task completed');",
    '  },',
    '',
    "  'compact-manual': () => {",
    "    console.log('PreCompact Guidance:');",
    "    console.log('IMPORTANT: Review CLAUDE.md in project root for:');",
    "    console.log('   - Available agents and concurrent usage patterns');",
    "    console.log('   - Swarm coordination strategies (hierarchical, mesh, adaptive)');",
    "    console.log('   - Critical concurrent execution rules (1 MESSAGE = ALL OPERATIONS)');",
    "    console.log('Ready for compact operation');",
    '  },',
    '',
    "  'compact-auto': () => {",
    "    console.log('Auto-Compact Guidance (Context Window Full):');",
    "    console.log('CRITICAL: Before compacting, ensure you understand:');",
    "    console.log('   - All agents available in .claude/agents/ directory');",
    "    console.log('   - Concurrent execution patterns from CLAUDE.md');",
    "    console.log('   - Swarm coordination strategies for complex tasks');",
    "    console.log('Apply GOLDEN RULE: Always batch operations in single messages');",
    "    console.log('Auto-compact proceeding with full agent context');",
    '  },',
    '',
    "  'status': () => {",
    "    console.log('[OK] Status check');",
    '  },',
    '',
    "  'stats': () => {",
    '    if (intelligence && intelligence.stats) {',
    "      intelligence.stats(args.includes('--json'));",
    '    } else {',
    "      console.log('[WARN] Intelligence module not available. Run session-restore first.');",
    '    }',
    '  },',
    '',
    '  // #bug33 — wire aidefence_scan into UserPromptSubmit + PreToolUse:WebFetch.',
    '  // Dynamic-imports @claude-flow/aidefence (ESM-from-CJS), runs quickScan + hasPII,',
    '  // logs verdict to ~/.claude/.claude-flow/data/aidefence-scans.jsonl, and exits 1',
    '  // on threat/PII (Claude Code blocks on non-zero). Stub-passes if package unavailable.',
    "  'aidefence-scan': async () => {",
    "    var os = require('os');",
    "    var dataDir = path.join(os.homedir(), '.claude', '.claude-flow', 'data');",
    "    var logFile = path.join(dataDir, 'aidefence-scans.jsonl');",
    '    var toolInput = hookInput.toolInput || hookInput.tool_input || {};',
    "    var toolName = hookInput.toolName || hookInput.tool_name || '';",
    "    var url = (toolInput && (toolInput.url || toolInput.URL)) || process.env.TOOL_INPUT_url || '';",
    '    var content = hookInput.prompt',
    '      || (toolInput && (toolInput.prompt || toolInput.content))',
    '      || url',
    "      || (typeof prompt === 'string' ? prompt : '')",
    "      || '';",
    '    var unsafe = false;',
    "    var verdict = { mode: 'stub', safe: true, threat: false, piiDetected: false };",
    '    try {',
    '      var tryPaths = [',
    "        '@claude-flow/aidefence',",
    "        path.join(helpersDir, '..', '..', 'node_modules', '@claude-flow', 'aidefence', 'dist', 'index.js'),",
    "        path.join(os.homedir(), '.claude', 'node_modules', '@claude-flow', 'aidefence', 'dist', 'index.js'),",
    '      ];',
    '      var mod = null;',
    '      for (var i = 0; i < tryPaths.length; i++) {',
    '        try {',
    '          mod = await import(tryPaths[i]);',
    '          if (mod && (mod.createAIDefence || (mod.default && mod.default.createAIDefence))) break;',
    '          mod = null;',
    '        } catch (e) { /* try next */ }',
    '      }',
    '      if (mod && content && content.length > 0) {',
    '        var create = mod.createAIDefence || (mod.default && mod.default.createAIDefence);',
    '        var defender = create({ enableLearning: false });',
    '        var scan = defender.quickScan(content);',
    '        var pii = false;',
    '        try { pii = !!defender.hasPII(content); } catch (e) {}',
    '        unsafe = !!scan.threat || pii;',
    "        verdict = { mode: 'live', safe: !unsafe, threat: !!scan.threat, confidence: scan.confidence, piiDetected: pii };",
    '      }',
    '    } catch (e) {',
    "      verdict = { mode: 'error', safe: true, error: String(e && e.message || e) };",
    '    }',
    '    try {',
    '      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });',
    '      var entry = JSON.stringify({',
    '        ts: new Date().toISOString(),',
    "        event: hookInput.hook_event_name || hookInput.hookEventName || 'unknown',",
    '        tool: toolName,',
    '        contentLen: content.length,',
    '        mode: verdict.mode,',
    '        safe: verdict.safe,',
    '        threat: verdict.threat,',
    '        piiDetected: verdict.piiDetected,',
    '        confidence: verdict.confidence,',
    '        error: verdict.error,',
    '      });',
    "      fs.appendFileSync(logFile, entry + '\\n');",
    '    } catch (e) {}',
    '    if (unsafe) {',
    "      console.error('[BLOCKED] AIDefence flagged input as unsafe (threat or PII).');",
    '      process.exit(1);',
    '    }',
    '  },',
    '};',
    '',
    'if (command && handlers[command]) {',
    '  try {',
    '    Promise.resolve(handlers[command]()).catch(function(e) {',
    "      console.log('[WARN] Hook ' + command + ' encountered an error: ' + e.message);",
    '    });',
    '  } catch (e) {',
    "    console.log('[WARN] Hook ' + command + ' encountered an error: ' + e.message);",
    '  }',
    '} else if (command) {',
    "  console.log('[OK] Hook: ' + command);",
    '} else {',
    "  console.log('Usage: hook-handler.cjs <route|pre-bash|post-edit|session-restore|session-end|pre-task|post-task|aidefence-scan|compact-manual|compact-auto|status|stats>');",
    '}',
    '} // end main',
    '',
    'process.exitCode = 0;',
    'main().catch(() => {}).finally(() => { process.exit(0); });',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Generate a minimal intelligence.cjs stub for fallback installs.
 * Provides the same API as the full intelligence.cjs but with simplified logic.
 * Gets overwritten when source copy succeeds (full version has PageRank, Jaccard, etc.)
 */
export function generateIntelligenceStub(): string {
  const lines = [
    '#!/usr/bin/env node',
    '/**',
    ' * Intelligence Layer Stub (ADR-050)',
    ' * Minimal fallback — full version is copied from package source.',
    ' * Provides: init, getContext, recordEdit, feedback, consolidate',
    ' */',
    "'use strict';",
    '',
    "const fs = require('fs');",
    "const path = require('path');",
    "const os = require('os');",
    '',
    // resolveFlowPath helper — converges runtime writes to ~/.claude under
    // global install while keeping per-project install behavior (#bug1).
    RESOLVE_FLOW_PATH_HELPER,
    "const DATA_DIR = resolveFlowPath('.claude-flow', 'data');",
    "const STORE_PATH = path.join(DATA_DIR, 'auto-memory-store.json');",
    "const RANKED_PATH = path.join(DATA_DIR, 'ranked-context.json');",
    "const PENDING_PATH = path.join(DATA_DIR, 'pending-insights.jsonl');",
    "const SESSION_DIR = resolveFlowPath('.claude-flow', 'sessions');",
    "const SESSION_FILE = path.join(SESSION_DIR, 'current.json');",
    '',
    'function ensureDir(dir) {',
    '  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });',
    '}',
    '',
    'function readJSON(p) {',
    '  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null; }',
    '  catch { return null; }',
    '}',
    '',
    'function writeJSON(p, data) {',
    '  ensureDir(path.dirname(p));',
    '  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");',
    '}',
    '',
    '// Read session context key',
    'function sessionGet(key) {',
    '  var session = readJSON(SESSION_FILE);',
    '  if (!session) return null;',
    '  return key ? (session.context || {})[key] : session.context;',
    '}',
    '',
    '// Write session context key',
    'function sessionSet(key, value) {',
    '  var session = readJSON(SESSION_FILE);',
    '  if (!session) return;',
    '  if (!session.context) session.context = {};',
    '  session.context[key] = value;',
    '  writeJSON(SESSION_FILE, session);',
    '}',
    '',
    '// Tokenize text into words',
    'function tokenize(text) {',
    '  if (!text) return [];',
    '  return text.toLowerCase().replace(/[^a-z0-9\\s]/g, " ").split(/\\s+/).filter(function(w) { return w.length > 2; });',
    '}',
    '',
    '// Bootstrap entries from MEMORY.md files when store is empty',
    'function bootstrapFromMemoryFiles() {',
    '  var entries = [];',
    '  var candidates = [',
    '    path.join(os.homedir(), ".claude", "projects"),',
    '    resolveFlowPath(".claude-flow", "memory"),',
    '    resolveFlowPath(".claude", "memory"),',
    '  ];',
    '  for (var i = 0; i < candidates.length; i++) {',
    '    try {',
    '      if (!fs.existsSync(candidates[i])) continue;',
    '      var files = [];',
    '      try {',
    '        var items = fs.readdirSync(candidates[i], { withFileTypes: true, recursive: true });',
    '        for (var j = 0; j < items.length; j++) {',
    '          if (items[j].name === "MEMORY.md") {',
    '            var parentDir = items[j].parentPath || items[j].path || candidates[i];',
    '            var fp = path.join(parentDir, items[j].name);',
    '            files.push(fp);',
    '          }',
    '        }',
    '      } catch (e) { continue; }',
    '      for (var k = 0; k < files.length; k++) {',
    '        try {',
    '          var content = fs.readFileSync(files[k], "utf-8");',
    '          var sections = content.split(/^##\\s+/m).filter(function(s) { return s.trim().length > 20; });',
    '          for (var s = 0; s < sections.length; s++) {',
    '            var lines2 = sections[s].split("\\n");',
    '            var title = lines2[0] ? lines2[0].trim() : "section-" + s;',
    '            entries.push({',
    '              id: "mem-" + entries.length,',
    '              content: sections[s].substring(0, 500),',
    '              summary: title.substring(0, 100),',
    '              category: "memory",',
    '              confidence: 0.5,',
    '              sourceFile: files[k],',
    '              words: tokenize(sections[s].substring(0, 500)),',
    '            });',
    '          }',
    '        } catch (e) { /* skip */ }',
    '      }',
    '    } catch (e) { /* skip */ }',
    '  }',
    '  return entries;',
    '}',
    '',
    '// Load entries from auto-memory-store or bootstrap from MEMORY.md',
    'function loadEntries() {',
    '  var store = readJSON(STORE_PATH);',
    '  // Support both formats: flat array or { entries: [...] }',
    '  var entries = null;',
    '  if (store) {',
    '    if (Array.isArray(store) && store.length > 0) {',
    '      entries = store;',
    '    } else if (store.entries && store.entries.length > 0) {',
    '      entries = store.entries;',
    '    }',
    '  }',
    '  if (entries) {',
    '    return entries.map(function(e, i) {',
    '      return {',
    '        id: e.id || ("entry-" + i),',
    '        content: e.content || e.value || "",',
    '        summary: e.summary || e.key || "",',
    '        category: e.category || e.namespace || "default",',
    '        confidence: e.confidence || 0.5,',
    '        sourceFile: e.sourceFile || (e.metadata && e.metadata.sourceFile) || "",',
    '        words: tokenize((e.content || e.value || "") + " " + (e.summary || e.key || "")),',
    '      };',
    '    });',
    '  }',
    '  return bootstrapFromMemoryFiles();',
    '}',
    '',
    '// Simple keyword match score',
    'function matchScore(promptWords, entryWords) {',
    '  if (!promptWords.length || !entryWords.length) return 0;',
    '  var entrySet = {};',
    '  for (var i = 0; i < entryWords.length; i++) entrySet[entryWords[i]] = true;',
    '  var overlap = 0;',
    '  for (var j = 0; j < promptWords.length; j++) {',
    '    if (entrySet[promptWords[j]]) overlap++;',
    '  }',
    '  var union = Object.keys(entrySet).length + promptWords.length - overlap;',
    '  return union > 0 ? overlap / union : 0;',
    '}',
    '',
    'var cachedEntries = null;',
    '',
    'module.exports = {',
    '  init: function() {',
    '    cachedEntries = loadEntries();',
    '    var ranked = cachedEntries.map(function(e) {',
    '      return { id: e.id, content: e.content, summary: e.summary, category: e.category, confidence: e.confidence, words: e.words };',
    '    });',
    '    writeJSON(RANKED_PATH, { version: 1, computedAt: Date.now(), entries: ranked });',
    '    return { nodes: cachedEntries.length, edges: 0 };',
    '  },',
    '',
    '  getContext: function(prompt) {',
    '    if (!prompt) return null;',
    '    var ranked = readJSON(RANKED_PATH);',
    '    var entries = (ranked && ranked.entries) || (cachedEntries || []);',
    '    if (!entries.length) return null;',
    '    var promptWords = tokenize(prompt);',
    '    if (!promptWords.length) return null;',
    '    var scored = entries.map(function(e) {',
    '      return { entry: e, score: matchScore(promptWords, e.words || tokenize(e.content + " " + e.summary)) };',
    '    }).filter(function(s) { return s.score > 0.05; });',
    '    scored.sort(function(a, b) { return b.score - a.score; });',
    '    var top = scored.slice(0, 5);',
    '    if (!top.length) return null;',
    '    var prevMatched = sessionGet("lastMatchedPatterns");',
    '    var matchedIds = top.map(function(s) { return s.entry.id; });',
    '    sessionSet("lastMatchedPatterns", matchedIds);',
    '    if (prevMatched && Array.isArray(prevMatched)) {',
    '      var newSet = {};',
    '      for (var i = 0; i < matchedIds.length; i++) newSet[matchedIds[i]] = true;',
    '    }',
    '    var lines2 = ["[INTELLIGENCE] Relevant patterns for this task:"];',
    '    for (var j = 0; j < top.length; j++) {',
    '      var e = top[j];',
    '      var conf = e.entry.confidence || 0.5;',
    '      var summary = (e.entry.summary || e.entry.content || "").substring(0, 80);',
    '      lines2.push("  * (" + conf.toFixed(2) + ") " + summary);',
    '    }',
    '    return lines2.join("\\n");',
    '  },',
    '',
    '  recordEdit: function(file) {',
    '    if (!file) return;',
    '    ensureDir(DATA_DIR);',
    '    var line = JSON.stringify({ type: "edit", file: file, timestamp: Date.now() }) + "\\n";',
    '    fs.appendFileSync(PENDING_PATH, line, "utf-8");',
    '  },',
    '',
    '  feedback: function(success) {',
    '    // Stub: no-op in minimal version',
    '  },',
    '',
    '  consolidate: function() {',
    '    var count = 0;',
    '    if (fs.existsSync(PENDING_PATH)) {',
    '      try {',
    '        var content = fs.readFileSync(PENDING_PATH, "utf-8").trim();',
    '        count = content ? content.split("\\n").length : 0;',
    '        fs.writeFileSync(PENDING_PATH, "", "utf-8");',
    '      } catch (e) { /* skip */ }',
    '    }',
    '    return { entries: count, edges: 0, newEntries: 0 };',
    '  },',
    '};',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Generate a minimal auto-memory-hook.mjs fallback for fresh installs.
 * This ESM script handles import/sync/status commands gracefully via a
 * subprocess invocation of the `claude-flow` CLI. Gets overwritten when
 * source copy succeeds.
 *
 * #bug14 — Replaced the previous ESM-import-first design with a
 * subprocess-only path. The legacy design tried `import('@claude-flow/memory')`
 * across 4 strategies and then fell through to a "Memory package not available"
 * message because the helper script runs from `~/.claude/helpers/` where
 * the package is not on the import path. The MCP-bridged
 * `memory_import_claude` tool, however, succeeds when called from Claude
 * Code itself. This generator now mirrors that path: invoke `claude-flow`
 * via `spawnSync` (which resolves through PATH, npx shims, and Windows
 * .cmd wrappers) and report based on the subprocess result. The offending
 * stub-emit branch is removed so session-start no longer emits noise.
 */
export function generateAutoMemoryHook(): string {
  return `#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook (ADR-048/049) — Minimal Fallback
 * Full version is copied from package source when available.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart
 *   node auto-memory-hook.mjs sync     # SessionEnd / Stop
 *   node auto-memory-hook.mjs status   # Show bridge status
 *
 * #bug14 — Subprocess-first design. We delegate to the \`claude-flow\` CLI
 * (which exposes the memory backend via MCP-bridged tools) instead of
 * trying to ESM-import \`@claude-flow/memory\` from a helpers directory
 * where the package isn't on the import path.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const STORE_PATH = join(DATA_DIR, 'auto-memory-store.json');

const DIM = '\\x1b[2m';
const RESET = '\\x1b[0m';
const dim = (msg) => console.log(\`  \${DIM}\${msg}\${RESET}\`);

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/**
 * #bug14 — Probe whether the \`claude-flow\` CLI is reachable. The CLI
 * exposes the memory backend (memory_import_claude / memory_bridge_status
 * are wired via MCP); if the binary is on PATH, the auto-memory pipeline
 * is available out-of-process even when ESM resolution of
 * \`@claude-flow/memory\` from the helpers directory would fail.
 *
 * Strategy: \`claude-flow memory bridge-status\` is a cheap read-only command
 * that succeeds when the CLI is installed. \`shell:true\` lets the OS resolve
 * PATH, npx-shims, and Windows .cmd wrappers. We also note the homedir
 * \`.claude\` install path (\`@claude-flow/cli/package.json\`) for diagnostics
 * — if the user did a global install, the CLI lives there.
 */
function trySubprocessImport() {
  const homeClaudeDir = join(homedir(), '.claude');
  const candidates = ['claude-flow', 'npx claude-flow'];
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['memory', 'bridge-status'], {
        encoding: 'utf-8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      if (result.status === 0) {
        return { available: true, bin: cmd, homeClaudeDir };
      }
      if (result.error && result.error.code === 'ENOENT') continue;
    } catch { /* try next */ }
  }
  return { available: false, bin: null, homeClaudeDir };
}

async function doImport() {
  // #bug14 — Subprocess-first. No ESM import attempt; the CLI is the
  // canonical path for the memory backend in helper-script context.
  const sub = trySubprocessImport();
  if (sub.available) {
    // Bridge reachable. The MCP-side memory_import_claude does the actual
    // import; this minimal helper just confirms availability silently. We
    // emit a low-noise dim line so SessionStart logs are still informative.
    dim(\`Auto memory bridge ready (\${sub.bin})\`);
    return;
  }
  // CLI not on PATH — non-critical, helpers gracefully no-op.
  dim('ruflo CLI not on PATH — auto memory import skipped (non-critical)');
}

async function doSync() {
  if (!existsSync(STORE_PATH)) {
    dim('No entries to sync');
    return;
  }
  const sub = trySubprocessImport();
  if (sub.available) {
    dim(\`Auto memory sync ready (\${sub.bin})\`);
    return;
  }
  dim('ruflo CLI not on PATH — sync skipped (non-critical)');
}

function doStatus() {
  console.log('\\n=== Auto Memory Bridge Status ===\\n');
  const sub = trySubprocessImport();
  console.log(\`  CLI:            \${sub.available ? 'reachable (' + sub.bin + ')' : 'not on PATH'}\`);
  console.log(\`  Store:          \${existsSync(STORE_PATH) ? 'Initialized' : 'Not initialized'}\`);
  console.log(\`  Home install:   \${existsSync(join(sub.homeClaudeDir, 'package.json')) ? sub.homeClaudeDir : 'not detected'}\`);
  console.log('');
}

// Suppress unhandled rejection warnings from dynamic import() failures
process.on('unhandledRejection', () => {});

const command = process.argv[2] || 'status';

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      process.exit(1);
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  dim(\`Error (non-critical): \${err.message}\`);
}
// Ensure clean exit for Claude Code hooks (exit 0 = success)
process.exit(0);
`;
}

/**
 * Generate Windows PowerShell daemon manager
 */
export function generateWindowsDaemonManager(): string {
  return `# RuFlo V3 Daemon Manager for Windows
# PowerShell script for managing background processes

param(
    [Parameter(Position=0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'SilentlyContinue'
$ClaudeFlowDir = Join-Path $PWD '.claude-flow'
$PidDir = Join-Path $ClaudeFlowDir 'pids'

# Ensure directories exist
if (-not (Test-Path $PidDir)) {
    New-Item -ItemType Directory -Path $PidDir -Force | Out-Null
}

function Get-DaemonStatus {
    param([string]$Name, [string]$PidFile)

    if (Test-Path $PidFile) {
        $pid = Get-Content $PidFile
        $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($process) {
            return @{ Running = $true; Pid = $pid }
        }
    }
    return @{ Running = $false; Pid = $null }
}

function Start-SwarmMonitor {
    $pidFile = Join-Path $PidDir 'swarm-monitor.pid'
    $status = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $pidFile

    if ($status.Running) {
        Write-Host "Swarm monitor already running (PID: $($status.Pid))" -ForegroundColor Yellow
        return
    }

    Write-Host "Starting swarm monitor..." -ForegroundColor Cyan
    $process = Start-Process -FilePath 'node' -ArgumentList @(
        '-e',
        'setInterval(() => { require("fs").writeFileSync(".claude-flow/metrics/swarm-activity.json", JSON.stringify({swarm:{active:true,agent_count:0},timestamp:Date.now()})) }, 5000)'
    ) -PassThru -WindowStyle Hidden

    $process.Id | Out-File $pidFile
    Write-Host "Swarm monitor started (PID: $($process.Id))" -ForegroundColor Green
}

function Stop-SwarmMonitor {
    $pidFile = Join-Path $PidDir 'swarm-monitor.pid'
    $status = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $pidFile

    if (-not $status.Running) {
        Write-Host "Swarm monitor not running" -ForegroundColor Yellow
        return
    }

    Stop-Process -Id $status.Pid -Force
    Remove-Item $pidFile -Force
    Write-Host "Swarm monitor stopped" -ForegroundColor Green
}

function Show-Status {
    Write-Host ""
    Write-Host "RuFlo V3 Daemon Status" -ForegroundColor Cyan
    Write-Host "=============================" -ForegroundColor Cyan

    $swarmPid = Join-Path $PidDir 'swarm-monitor.pid'
    $swarmStatus = Get-DaemonStatus -Name 'swarm-monitor' -PidFile $swarmPid

    if ($swarmStatus.Running) {
        Write-Host "  Swarm Monitor: RUNNING (PID: $($swarmStatus.Pid))" -ForegroundColor Green
    } else {
        Write-Host "  Swarm Monitor: STOPPED" -ForegroundColor Red
    }
    Write-Host ""
}

switch ($Action) {
    'start' {
        Start-SwarmMonitor
        Show-Status
    }
    'stop' {
        Stop-SwarmMonitor
        Show-Status
    }
    'restart' {
        Stop-SwarmMonitor
        Start-Sleep -Seconds 1
        Start-SwarmMonitor
        Show-Status
    }
    'status' {
        Show-Status
    }
}
`;
}

/**
 * Generate Windows batch file wrapper
 */
export function generateWindowsBatchWrapper(): string {
  return `@echo off
REM RuFlo V3 - Windows Batch Wrapper
REM Routes to PowerShell daemon manager

PowerShell -ExecutionPolicy Bypass -File "%~dp0daemon-manager.ps1" %*
`;
}

/**
 * Generate cross-platform session manager
 */
export function generateCrossPlatformSessionManager(): string {
  return `#!/usr/bin/env node
/**
 * Ruflo Cross-Platform Session Manager
 * Works on Windows, macOS, and Linux
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
${RESOLVE_FLOW_PATH_HELPER}
// Platform-specific paths
const platform = os.platform();
const homeDir = os.homedir();

// Get data directory based on platform — resolveFlowPath converges runtime
// writes under ~/.claude on global install (#bug1) while preserving the
// per-project install case. Platform-specific OS-config fallbacks remain as
// a last resort if even ~/.claude isn't writable.
function getDataDir() {
  const localDir = resolveFlowPath('.claude-flow', 'sessions');
  if (fs.existsSync(path.dirname(localDir))) {
    return localDir;
  }

  switch (platform) {
    case 'win32':
      return path.join(process.env.APPDATA || homeDir, 'claude-flow', 'sessions');
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'claude-flow', 'sessions');
    default:
      return path.join(homeDir, '.claude-flow', 'sessions');
  }
}

const SESSION_DIR = getDataDir();
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const commands = {
  start: () => {
    ensureDir(SESSION_DIR);
    const sessionId = \`session-\${Date.now()}\`;
    const session = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      platform: platform,
      cwd: process.cwd(),
      context: {},
      metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log(\`Session started: \${sessionId}\`);
    return session;
  },

  restore: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No session to restore');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.restoredAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log(\`Session restored: \${session.id}\`);
    return session;
  },

  end: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    session.endedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();

    const archivePath = path.join(SESSION_DIR, \`\${session.id}.json\`);
    fs.writeFileSync(archivePath, JSON.stringify(session, null, 2));
    fs.unlinkSync(SESSION_FILE);

    console.log(\`Session ended: \${session.id}\`);
    console.log(\`Duration: \${Math.round(session.duration / 1000 / 60)} minutes\`);
    return session;
  },

  status: () => {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log('No active session');
      return null;
    }
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    const duration = Date.now() - new Date(session.startedAt).getTime();
    console.log(\`Session: \${session.id}\`);
    console.log(\`Platform: \${session.platform}\`);
    console.log(\`Started: \${session.startedAt}\`);
    console.log(\`Duration: \${Math.round(duration / 1000 / 60)} minutes\`);
    return session;
  }
};

// CLI
const [,, command, ...args] = process.argv;
if (command && commands[command]) {
  commands[command](...args);
} else {
  console.log('Usage: session.js <start|restore|end|status>');
  console.log(\`Platform: \${platform}\`);
  console.log(\`Data dir: \${SESSION_DIR}\`);
}

module.exports = commands;
`;
}

/**
 * Generate all helper files
 */
export function generateHelpers(options: InitOptions): Record<string, string> {
  const helpers: Record<string, string> = {};

  if (options.components.helpers) {
    // Unix/macOS shell scripts
    helpers['pre-commit'] = generatePreCommitHook();
    helpers['post-commit'] = generatePostCommitHook();

    // Cross-platform Node.js scripts
    helpers['session.js'] = generateCrossPlatformSessionManager();
    helpers['router.js'] = generateAgentRouter();
    helpers['memory.js'] = generateMemoryHelper();

    // Windows-specific scripts
    helpers['daemon-manager.ps1'] = generateWindowsDaemonManager();
    helpers['daemon-manager.cmd'] = generateWindowsBatchWrapper();
  }

  if (options.components.statusline) {
    helpers['statusline.cjs'] = generateStatuslineScript(options);  // .cjs for ES module compatibility
    helpers['statusline-hook.sh'] = generateStatuslineHook(options);
  }

  return helpers;
}
