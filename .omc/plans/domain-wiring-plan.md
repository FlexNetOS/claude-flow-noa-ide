# Domain Wiring Plan — Microkernel Registration
**Status**: `pending approval`
**Date**: 2026-05-27
**Branch**: `pr-1712` (ruflo fork, FlexNetOS)
**Scope**: Register 13 pre-existing domains with the microkernel using thin, additive adapters.

---

## Critical Pre-Flight Findings

### Finding 1 — Kernel files were NOT committed

The prior session described building `ClaudeFlowKernel` at:
- `v3/@claude-flow/shared/src/core/kernel/claude-flow-kernel.ts`
- `v3/@claude-flow/shared/src/core/plugins/domain-plugin.interface.ts`

**These files do not exist in the repo.** They appear to have been written in a devfleet
worktree (`.devfleet-worktrees/session-*`) that was never committed.

**Plan impact**: The existing plugin system (`PluginRegistry` + `PluginLoader` +
`ClaudeFlowPlugin` interface) at `v3/@claude-flow/shared/src/` IS the microkernel. All
adapters below target this existing surface. If you intend to commit the `ClaudeFlowKernel`
class separately first, that must happen as an unnumbered prerequisite commit.

### Finding 2 — Domain 13 path confirmed

The originally specified `plugins/ruflo-graph-intelligence` does not exist. User confirmed
domain 13 is `plugins/ruflo-knowledge-graph` — a Claude Code meta-plugin (pure Markdown:
skills, commands, agent persona). It has no TypeScript, so the wiring approach is a
metadata registration adapter in a new additive `src/` subdirectory. See Domain 13 entry.

### Finding 3 — Two domains already implement ClaudeFlowPlugin

`plugin-agent-federation` and `plugin-iot-cognitum` already import and implement
`ClaudeFlowPlugin` from `@claude-flow/shared/src/plugin-interface.js`. No adapter class
is needed — only a registration shim in the bootstrap entry point.

---

## Requirements Summary

**Goal**: Wire 12 pre-existing domains into the kernel so they participate in the plugin
lifecycle (initialize, shutdown, health check) without breaking any currently working functionality.

**Constraints**:
1. **Additive only** — never remove existing direct imports until kernel route is proven
2. **Thin adapter** — wrap each domain's existing exports in `ClaudeFlowPlugin`; zero
   changes to domain internals
3. **Soft-fail** — each `pluginLoader.load()` wrapped in try/catch; one failure must not
   crash boot
4. **One domain per commit** — test between each commit
5. **TypeScript compiles clean** after each step (`tsc --noEmit --skipLibCheck` exits 0)

---

## The Microkernel Surface (what adapters must target)

```
v3/@claude-flow/shared/src/
├── plugin-interface.ts      ← ClaudeFlowPlugin interface + PluginContext
├── plugin-registry.ts       ← PluginRegistry (register, get, list, lifecycle)
├── plugin-loader.ts         ← PluginLoader (dependency resolution, sandboxing)
└── plugin-sandbox.ts        ← SandboxedPluginRunner
```

The adapter pattern for each domain:

```typescript
// Adapter file: <domain>/src/<domain>-plugin.ts
import type { ClaudeFlowPlugin, PluginContext }
  from '@claude-flow/shared/src/plugin-interface.js';

export class FooDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'foo';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];  // list names wired before this domain
  readonly description = 'Foo domain adapter';

  async initialize(context: PluginContext): Promise<void> {
    // 1. Instantiate domain service from existing exports
    // 2. Register into context.services so other plugins can consume
  }

  async shutdown(): Promise<void> { /* cleanup or no-op */ }

  async healthCheck(): Promise<boolean> { return true; }
}
```

---

## Dependency Graph

```
All 12 domains are self-contained at the static import level.
No @claude-flow/* cross-imports were found between packages (verified by grep).
v3/src/* domains import only from v3/src/shared/types (local, not @claude-flow/shared).

Wiring order is driven by boot semantics (who provides services others consume
at runtime via service container), NOT by TypeScript import constraints.

Cross-domain dependency matrix (verified by grep on actual import statements):
┌────────────────────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┐
│ Domain                 │security│memory  │neural  │defence │claims  │swarm   │browser │
├────────────────────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤
│ security               │  self  │   —    │   —    │   —    │   —    │   —    │   —    │
│ memory                 │   —    │  self  │   —    │   —    │   —    │   —    │   —    │
│ neural                 │   —    │   —    │  self  │   —    │   —    │   —    │   —    │
│ aidefence              │   —    │   —    │   —    │  self  │   —    │   —    │   —    │
│ claims                 │   —    │   —    │   —    │   —    │  self  │   —    │   —    │
│ swarm                  │   —    │   —    │   —    │   —    │   —    │  self  │   —    │
│ browser                │  inj*  │  inj*  │   —    │   —    │   —    │   —    │  self  │
│ plugin-agent-fed       │   —    │   —    │   —    │   —    │   —    │   —    │   —    │
│ plugin-iot-cognitum    │   —    │   —    │   —    │   —    │   —    │   —    │   —    │
│ v3/src/memory          │   —    │   —    │   —    │   —    │   —    │   —    │   —    │
│ v3/src/agent-lifecycle │   —    │   —    │   —    │   —    │   —    │   —    │   —    │
│ v3/src/task-execution  │   —    │   —    │   —    │   —    │   —    │   —    │   —    │
└────────────────────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘

* inj = browser uses service-container injection at runtime (not static @claude-flow/* imports).
  Browser infrastructure adapters are self-contained — safe to wire independently.

Additional edges discovered via package.json (not visible in source grep):
  neural  → memory  (@claude-flow/memory: ^3.0.0-alpha.16 declared in neural/package.json)
  browser → cli     (@claude-flow/cli: >=3.5.0 declared in browser/package.json)

Impact on wiring order:
  neural→memory: memory is already #2 and neural is #3 — order already correct. ✓
  browser→cli:   @claude-flow/cli is NOT one of the 13 domains being wired. It is a
                 pre-existing package in the monorepo that will be available in the
                 environment before any domain is wired. No order change needed. ✓
```

---

## Safe Wiring Order

### Tier 0 — Infrastructure foundations (boot-required or near-required)

---

#### Domain 1 — `v3/@claude-flow/security`

**Rationale**: Security primitives (password hashing, token generation, path validation)
are utilities any other domain may consume via the service container. Wire first.

**Required for boot**: YES (recommended) — other domains may call security at init time.

**Adapter file**: `v3/@claude-flow/security/src/security-plugin.ts`

**Imports from domain**:
```typescript
import { createSecurityModule, type SecurityModuleConfig } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('security-module', SecurityModule)` — full facade
  (PasswordHasher, TokenGenerator, CredentialGenerator, PathValidator, SafeExecutor)

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `new SecurityDomainPlugin().initialize(mockCtx)` no throw
- `mockCtx.services.get('security-module')` is non-null
- `createSecurityModule(...)` still importable directly from `@claude-flow/security`

---

#### Domain 2 — `v3/@claude-flow/memory`

**Rationale**: Persistence layer for agents, sessions, tasks. Wire second so backends
(SQLite, AgentDB, HybridBackend, UnifiedMemoryService, RVF store, LearningBridge) are
available before any consumer initializes.

**Required for boot**: YES — most domains need persistence.

**Adapter file**: `v3/@claude-flow/memory/src/memory-plugin.ts`

**Imports from domain**:
```typescript
import { createMemoryManager } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('memory-service', UnifiedMemoryService instance)`

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- Plugin initializes without throw
- `mockCtx.services.get('memory-service')` is non-null
- `store({ key:'smoke', value:'ok' })` roundtrip completes (runtime integration check)
- All existing `@claude-flow/memory` exports unchanged

---

#### Domain 3 — `v3/@claude-flow/neural`

**Rationale**: SONA, ReasoningBank, PatternLearner are consumed by browser's reasoningbank
adapter at runtime. No static peer imports — pure self-contained algorithms.

**Required for boot**: NO — system boots without neural; learning disabled.

**Adapter file**: `v3/@claude-flow/neural/src/neural-plugin.ts`

**Imports from domain**:
```typescript
import { createNeuralLearningSystem } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('neural-learning', NeuralLearningSystem instance)`

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- Plugin initializes with empty config
- `mockCtx.services.get('neural-learning')` is non-null

---

#### Domain 4 — `v3/@claude-flow/aidefence`

**Rationale**: Threat detection and PII scanning. Wire after security (#1), before browser
(#7) which may use the defence service at runtime.

**Required for boot**: NO — system boots without AI defence; threat detection disabled.

**Adapter file**: `v3/@claude-flow/aidefence/src/aidefence-plugin.ts`

**Imports from domain**:
```typescript
import { createAIDefence } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('ai-defence', AIDefence instance)`

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `createAIDefence({})` no throw (empty config is valid per interface)
- `mockCtx.services.get('ai-defence').isSafe('test string')` returns boolean

---

### Tier 1 — Domain logic

---

#### Domain 5 — `v3/@claude-flow/claims`

**Rationale**: Claims-based authorization. Logically downstream of security (#1). No
static import on security package — runtime service-container coupling only.

**Required for boot**: NO — degrades to no-ACL mode.

**Adapter file**: `v3/@claude-flow/claims/src/claims-plugin.ts`

**Imports from domain**:
```typescript
import { /* ClaimsService factory */ } from './application/index.js';
```

**Exposes to kernel**:
- `context.services.register('claims-service', ClaimsService instance)`
- `registerMCPTools()` — claims MCP tool wrappers
- `registerCLICommands()` — claims CLI commands

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `registerMCPTools()` returns array with length > 0
- `mockCtx.services.get('claims-service')` is non-null
- Existing claims imports unchanged

---

#### Domain 6 — `v3/@claude-flow/swarm`

**Rationale**: UnifiedSwarmCoordinator, consensus algorithms, topology management. Large
self-contained domain. Wire after memory (#2) and neural (#3) so coordinator can
optionally use them via service container.

**Required for boot**: NO — single-agent mode still works.

**Adapter file**: `v3/@claude-flow/swarm/src/swarm-plugin.ts`

**Imports from domain**:
```typescript
import { createUnifiedSwarmCoordinator } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('swarm-coordinator', UnifiedSwarmCoordinator instance)`
- `registerMCPTools()` — swarm MCP tools
- `registerAgentTypes()` — mesh-coordinator, hierarchical-coordinator, etc.

**Risk**: MEDIUM-HIGH. Largest domain (~330 exports). Check for `setInterval`/WebSocket
calls in `UnifiedSwarmCoordinator` constructor — must not start background work at init
time if the system isn't ready.

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- Plugin initializes without throw
- `mockCtx.services.get('swarm-coordinator')` is non-null
- `TOPOLOGY_TYPES`, `CONSENSUS_ALGORITHMS` still exportable directly

---

### Tier 2 — Composite domains

---

#### Domain 7 — `v3/@claude-flow/browser`

**Rationale**: Browser domain has infrastructure adapters for memory, security, and
reasoningbank that resolve from the service container at runtime. Wire after #1, #2, #3
so those services exist when browser's `initialize()` calls `context.services.get(...)`.

**Required for boot**: NO — optional web automation feature.

**Adapter file**: `v3/@claude-flow/browser/src/browser-plugin.ts`

**Imports from domain**:
```typescript
import { createBrowserService, browserTools } from './index.js';
```

**Exposes to kernel**:
- `context.services.register('browser-service', BrowserService instance)`
- `registerMCPTools()` — the `browserTools` array
- `registerAgentTypes()` — browser agent type

**Risk**: MEDIUM. Playwright may not be installed in CI. The adapter's `initialize()` must
wrap `createBrowserService()` in try/catch and degrade gracefully when Playwright is absent.

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- Plugin initializes even when neural and ai-defence services are absent from container
- Plugin initializes (with graceful degrade) even when Playwright is not installed
- `registerMCPTools()` returns `browserTools` array with length > 0

---

### Tier 3 — v3/src standalone domains

These three live in `v3/src/` (not `v3/@claude-flow/`), import only from
`v3/src/shared/types` (local path), and have no `@claude-flow/*` package dependencies.
Simplest to wire.

---

#### Domain 8 — `v3/src/agent-lifecycle`

**Rationale**: Agent domain entity — fundamental execution unit. Pure domain model, no
services, no external deps beyond local shared types.

**Required for boot**: YES (recommended) — agents are the core abstraction.

**Pre-requisite action**: Create `v3/src/agent-lifecycle/index.ts` barrel first
(currently only `domain/Agent.ts` exists — no barrel file).

**Adapter file**: `v3/src/agent-lifecycle/agent-lifecycle-plugin.ts`

**Imports from domain**:
```typescript
import { Agent } from './domain/Agent.js';
```

**Exposes to kernel**:
- `registerAgentTypes()` — base Agent entity type definition

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `registerAgentTypes()` returns array with length ≥ 1
- `Agent` class still importable directly from `v3/src/agent-lifecycle/domain/Agent.ts`

---

#### Domain 9 — `v3/src/task-execution`

**Rationale**: Task entity + WorkflowEngine — core task processing. Wire after
agent-lifecycle (#8) so task/agent types are coherent in the registry.

**Required for boot**: YES (recommended) — task execution is core functionality.

**Adapter file**: `v3/src/task-execution/task-execution-plugin.ts`

**Imports from domain**:
```typescript
import { WorkflowEngine } from './application/index.js';
import { Task } from './domain/Task.js';
```

**Exposes to kernel**:
- `context.services.register('workflow-engine', WorkflowEngine instance)`
- `registerTaskTypes()` — base Task type definition

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `mockCtx.services.get('workflow-engine')` is non-null
- `registerTaskTypes()` returns array with length ≥ 1
- `WorkflowEngine` and `Task` still importable directly

---

#### Domain 10 — `v3/src/memory` (infrastructure)

**Rationale**: SQLite, AgentDB, HybridBackend implementations that complement
`@claude-flow/memory` (#2) with additional backend options. Wire after #2.

**Required for boot**: NO — `@claude-flow/memory` handles persistence; this adds options.

**Adapter file**: `v3/src/memory/memory-infra-plugin.ts`

**Imports from domain**:
```typescript
import { HybridBackend, SQLiteBackend, AgentDBBackend }
  from './infrastructure/index.js';
```

**Exposes to kernel**:
- `context.services.register('memory-backends-v3src', { HybridBackend, SQLiteBackend, AgentDBBackend })`
  (namespaced to avoid collision with `@claude-flow/memory` backends)

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `mockCtx.services.get('memory-backends-v3src').SQLiteBackend` is defined
- In-memory instantiation of SQLiteBackend does not throw

---

### Tier 4 — Already-plugin domains (simplest wiring — no adapter class needed)

---

#### Domain 11 — `v3/@claude-flow/plugin-agent-federation`

**Rationale**: `AgentFederationPlugin` already implements `ClaudeFlowPlugin`. Only needs
registration in the bootstrap entry point. Wire after memory (#2) and security (#1).

**Required for boot**: NO — optional multi-node federation.

**Adapter file**: NONE — `AgentFederationPlugin` IS the adapter.

**Registration shim** (in bootstrap/init file):
```typescript
import { AgentFederationPlugin }
  from '@claude-flow/plugin-agent-federation';
// inside boot sequence, wrapped in try/catch:
await pluginLoader.load(new AgentFederationPlugin(), context);
```

**Risk**: HIGH. Most complex plugin: PIIPipelineService, DiscoveryService,
HandshakeService, RoutingService, AuditService. Read `plugin.ts` fully before executing.
Check for network calls or filesystem side effects in `initialize()`.

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `new AgentFederationPlugin().initialize(mockCtx)` no throw
- `healthCheck()` returns `true`
- All federation types still importable from `@claude-flow/plugin-agent-federation`

---

#### Domain 12 — `v3/@claude-flow/plugin-iot-cognitum`

**Rationale**: `IoTCognitumPlugin` already implements `ClaudeFlowPlugin`. Wire last among
concrete domains; its `AgentDBTelemetryRepository` depends on AgentDB being available
from memory domain (#2).

**Required for boot**: NO — optional IoT feature.

**Adapter file**: NONE — `IoTCognitumPlugin` IS the adapter.

**Registration shim** (in bootstrap/init file):
```typescript
import { IoTCognitumPlugin }
  from '@claude-flow/plugin-iot-cognitum';
// inside boot sequence, wrapped in try/catch:
await pluginLoader.load(new IoTCognitumPlugin(), context);
```

**Risk**: MEDIUM. AgentDB client type is an interface; initialization may require a real
DB connection. `initialize()` must not throw when DB is unavailable.

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `new IoTCognitumPlugin().initialize(mockCtx)` no throw even without AgentDB
- Graceful degrade logged (warning, not error) when DB unavailable
- `IoTCoordinator`, `SeedClientFactory` still importable directly

---

#### Domain 13 — `plugins/ruflo-knowledge-graph`

**Confirmed path**: `plugins/ruflo-knowledge-graph`

**Nature**: Claude Code meta-plugin — pure Markdown. Contents:
- `agents/graph-navigator.md` — agent persona
- `commands/kg.md` — slash command
- `skills/kg-extract/SKILL.md`, `skills/kg-traverse/SKILL.md` — skills
- `.claude-plugin/plugin.json` — Claude Code plugin manifest

**No TypeScript exists in this domain.** The `ClaudeFlowPlugin` interface cannot be
directly implemented against Markdown files.

**Wiring approach — metadata registration adapter**:
Create a minimal TypeScript adapter in `plugins/ruflo-knowledge-graph/src/` that registers
the domain's skill/agent catalog in the service container. Additive-only; existing Markdown
files are untouched.

```
plugins/ruflo-knowledge-graph/
├── .claude-plugin/plugin.json   ← unchanged
├── agents/…                     ← unchanged
├── commands/…                   ← unchanged
├── skills/…                     ← unchanged
└── src/                         ← NEW (additive only)
    └── knowledge-graph-plugin.ts
```

**Adapter file**: `plugins/ruflo-knowledge-graph/src/knowledge-graph-plugin.ts`

**Imports from domain**: None (domain is Markdown-only). Adapter registers static metadata.

**Exposes to kernel**:
- `context.services.register('knowledge-graph-manifest', { name, version, skills, agents, commands })`

**Required for boot**: NO — Claude Code loads skills/agents independently via
`.claude-plugin/plugin.json`; the microkernel registration adds discoverability only.

**Risk**: LOW — adapter registers static data only; no side effects.

**Note**: A minimal `package.json` with `"type": "module"` must be added alongside the
adapter so TypeScript resolves the module.

**Branch**:
```bash
git checkout -b feat/wire-knowledge-graph-plugin
# "feat(knowledge-graph): add metadata adapter — wires ruflo-knowledge-graph manifest into kernel"
```

**Acceptance criteria**:
- `tsc --noEmit --skipLibCheck` exits 0
- `new KnowledgeGraphPlugin().initialize(mockCtx)` no throw
- `mockCtx.services.get('knowledge-graph-manifest').skills` includes `'kg-extract'`
- All existing Markdown files under `plugins/ruflo-knowledge-graph/` unchanged

---

## Optional vs Required for Boot

| Domain | Required for boot | If missing at runtime |
|--------|------------------|-----------------------|
| security (#1) | YES (recommended) | Security services unavailable |
| memory (#2) | YES | No persistence |
| neural (#3) | NO | Learning disabled |
| aidefence (#4) | NO | No threat detection |
| claims (#5) | NO | No ACL; open access |
| swarm (#6) | NO | Single-agent mode only |
| browser (#7) | NO | No web automation |
| agent-lifecycle (#8) | YES (recommended) | Base Agent entity unavailable |
| task-execution (#9) | YES (recommended) | No workflow execution |
| v3/src/memory (#10) | NO | Extra backends unavailable |
| plugin-agent-federation (#11) | NO | No multi-node federation |
| plugin-iot-cognitum (#12) | NO | No IoT features |
| ruflo-knowledge-graph (#13) | NO | Skills/agents still loaded by Claude Code plugin system |

**Minimal boot set**: #1, #2, #8, #9 — security, memory, agent-lifecycle, task-execution.

---

## Risk Assessment

| Domain | Risk | Reason |
|--------|------|--------|
| plugin-agent-federation (#11) | HIGH | Most complex domain: 5 services initialize. Check `plugin.ts` for network/filesystem side effects. |
| swarm (#6) | MEDIUM-HIGH | Large domain (~330 exports). Check for `setInterval`/WebSocket in constructor — must not start background work prematurely. |
| browser (#7) | MEDIUM | Playwright may be absent in CI; must degrade gracefully. |
| plugin-iot-cognitum (#12) | MEDIUM | AgentDB connection required by telemetry repo; must soft-fail. |
| memory (#2) | LOW-MEDIUM | Rich domain (20+ exports). SQLite fails if no write permissions — use in-memory path for health check. |
| ruflo-knowledge-graph (#13) | LOW | Metadata-only adapter; registers static strings. No runtime side effects. |
| All others | LOW | Pure domain logic; no side effects at import/init time. |

---

## Branch Names and Commit Message Templates

```bash
# Prerequisite (if kernel files need committing from worktree)
git checkout -b feat/microkernel-commit
# "feat(kernel): commit ClaudeFlowKernel + DomainPlugin interface from devfleet worktree"

# Domain 1
git checkout -b feat/wire-security-plugin
# "feat(security): add SecurityDomainPlugin adapter — wires @claude-flow/security into kernel"

# Domain 2
git checkout -b feat/wire-memory-plugin
# "feat(memory): add MemoryDomainPlugin adapter — wires @claude-flow/memory into kernel"

# Domain 3
git checkout -b feat/wire-neural-plugin
# "feat(neural): add NeuralDomainPlugin adapter — wires @claude-flow/neural into kernel"

# Domain 4
git checkout -b feat/wire-aidefence-plugin
# "feat(aidefence): add AIDefenceDomainPlugin adapter — wires @claude-flow/aidefence into kernel"

# Domain 5
git checkout -b feat/wire-claims-plugin
# "feat(claims): add ClaimsDomainPlugin adapter — wires @claude-flow/claims into kernel"

# Domain 6
git checkout -b feat/wire-swarm-plugin
# "feat(swarm): add SwarmDomainPlugin adapter — wires @claude-flow/swarm into kernel"

# Domain 7
git checkout -b feat/wire-browser-plugin
# "feat(browser): add BrowserDomainPlugin adapter — wires @claude-flow/browser into kernel"

# Domain 8
git checkout -b feat/wire-agent-lifecycle-plugin
# "feat(agent-lifecycle): add barrel + AgentLifecyclePlugin — wires v3/src/agent-lifecycle into kernel"

# Domain 9
git checkout -b feat/wire-task-execution-plugin
# "feat(task-execution): add TaskExecutionPlugin — wires v3/src/task-execution into kernel"

# Domain 10
git checkout -b feat/wire-memory-infra-plugin
# "feat(memory-infra): add MemoryInfraPlugin — wires v3/src/memory backends into kernel"

# Domain 11
git checkout -b feat/wire-agent-federation-plugin
# "feat(plugin-agent-federation): register AgentFederationPlugin with kernel (no adapter needed)"

# Domain 12
git checkout -b feat/wire-iot-cognitum-plugin
# "feat(plugin-iot-cognitum): register IoTCognitumPlugin with kernel (no adapter needed)"

# Domain 13
git checkout -b feat/wire-knowledge-graph-plugin
# "feat(knowledge-graph): add metadata adapter — wires ruflo-knowledge-graph manifest into kernel"
```

---

## Verification Gate After Each Domain

Run this after every domain commit before moving to the next:

```bash
# 1. TypeScript compile check
npx tsc --noEmit --skipLibCheck

# 2. Existing tests
npm test

# 3. Smoke instantiation (adjust import path per domain)
node --input-type=module << 'EOF'
import { SecurityDomainPlugin } from
  './v3/@claude-flow/security/src/security-plugin.js';
const mockCtx = {
  config: {},
  services: {
    register: (k, v) => console.log('registered:', k),
    get: () => undefined,
    has: () => false,
    getServiceNames: () => [],
  },
  logger: console,
  eventBus: null,
};
const plugin = new SecurityDomainPlugin();
await plugin.initialize(mockCtx);
console.log('healthCheck:', await plugin.healthCheck());
console.log('OK');
EOF
```

If any step fails: **fix before proceeding to the next domain.**

---

## Execution Notes (for when "execute the plan" is given)

1. **Prerequisite check first**: Confirm whether `ClaudeFlowKernel` files need committing
   from the devfleet worktree. If yes, commit them as the unnumbered prerequisite before
   starting Domain 1.

2. **Mock context reuse**: The `mockCtx` object above satisfies the `PluginContext`
   interface; reuse it unchanged in every smoke test.

3. **Domains 11 and 12 need a bootstrap location**: Before executing #11 or #12, identify
   the file where `PluginLoader.load()` is called at boot (likely in
   `v3/@claude-flow/cli/src/` or a `main.ts` entry point). That file receives the
   registration shim, not a new adapter file.

4. **Domain 8 needs a barrel first**: `v3/src/agent-lifecycle/` has only
   `domain/Agent.ts` — create `index.ts` as the first change in that commit.

5. **Domain 13 is `plugins/ruflo-knowledge-graph`**: Metadata-only adapter; create
   `src/knowledge-graph-plugin.ts` and a minimal `package.json` with `"type": "module"`.

6. **Start with Domain 1 (security)** — it is the lowest-risk, zero-deps foundation.
