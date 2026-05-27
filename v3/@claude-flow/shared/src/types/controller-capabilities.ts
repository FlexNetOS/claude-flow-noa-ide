/**
 * ControllerCapabilities — typed view over the duck-typed
 * ControllerRegistry that the memory bridge currently probes.
 *
 * Background
 * ----------
 * The memory bridge calls `registry.get('reasoningBank')` etc. and gets back
 * `any`. It then duck-type-probes each method (`typeof rb.store === 'function'`).
 * That works at runtime, but TS can't help us when a controller's API evolves
 * and the bridge's probe goes stale — exactly the bug class PR-1828 patched.
 *
 * This module declares the typed contract the bridge expects, plus
 * sub-interfaces that capture each controller's known method surface (across
 * agentdb alpha versions). Methods are marked optional because many
 * controllers ship multiple-name aliases (e.g. `searchPatterns` ↔ `search`,
 * `recordFeedback` ↔ `record`, `delete` ↔ `remove`) and the bridge wants to
 * try whichever is present. The probe pattern stays at the method level, but
 * the controller-existence check becomes typed.
 *
 * @module v3/shared/types/controller-capabilities
 */

// ---------------------------------------------------------------------------
// ReasoningBank (pattern store + recall + outcome recording)
// ---------------------------------------------------------------------------

export interface ReasoningBankPatternInput {
  id: string;
  content: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface ReasoningBankSearchOptsLegacy {
  topK?: number;
  minScore?: number;
}

export interface ReasoningBankSearchOptsAgentDB {
  task: string;
  k?: number;
  threshold?: number;
}

export interface ReasoningBankOutcome {
  taskId: string;
  verdict: 'success' | 'failure';
  score: number;
  timestamp?: number;
}

export interface ReasoningBankController {
  /** agentdb-style store. */
  store?: (input: ReasoningBankPatternInput) => Promise<unknown>;
  /** agentdb alpha.10+ — keyword + semantic search. */
  searchPatterns?: (opts: ReasoningBankSearchOptsAgentDB) => Promise<unknown>;
  /** legacy (alpha.9) search alias. */
  search?: (query: string, opts: ReasoningBankSearchOptsLegacy) => Promise<unknown>;
  /** Record a labelled outcome for an existing trajectory. */
  recordOutcome?: (outcome: ReasoningBankOutcome) => Promise<unknown>;
  /** Legacy outcome alias. */
  record?: (taskId: string, score: number) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// LearningSystem (SONA / nightly consolidation feedback)
// ---------------------------------------------------------------------------

export interface LearningFeedbackInput {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  timestamp: number;
}

export interface LearningSystemController {
  recordFeedback?: (input: LearningFeedbackInput) => Promise<unknown>;
  /** Legacy alias. */
  record?: (taskId: string, quality: number, label: 'success' | 'failure') => Promise<unknown>;
  recommendAlgorithm?: (task: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Skills (skill library — pattern → skill promotion)
// ---------------------------------------------------------------------------

export interface SkillsController {
  promote?: (pattern: string, quality: number) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// SemanticRouter (intent → tool / agent routing)
// ---------------------------------------------------------------------------

export interface SemanticRouterController {
  route?: (input: string, ctx?: { context?: unknown }) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// AttestationLog (audit trail for state mutations)
// ---------------------------------------------------------------------------

export interface AttestationRecord {
  operation: string;
  entryId: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface AttestationLogController {
  /** agentdb alpha.13+ canonical name. */
  record?: (entry: AttestationRecord) => unknown;
  /** Legacy alias. */
  log?: (operation: string, entryId: string, metadata?: Record<string, unknown>) => unknown;
  /** Returns the row count. */
  count?: () => number;
}

// ---------------------------------------------------------------------------
// GuardedVectorBackend (proof-gated state mutations)
// ---------------------------------------------------------------------------

export interface GuardedVectorController {
  // The bridge currently treats GVB as opaque — registers it and lets
  // downstream consumers call its methods. Surface left as a marker for
  // future tightening; intentionally sparse.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// TieredCache (read-through cache layer)
// ---------------------------------------------------------------------------

export interface CacheStats {
  size?: number;
  hits?: number;
  misses?: number;
  [key: string]: unknown;
}

export interface CacheController {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => unknown;
  delete?: (key: string) => unknown;
  stats?: () => CacheStats;
}

// ---------------------------------------------------------------------------
// MutationGuard (write validator)
// ---------------------------------------------------------------------------

export interface MutationGuardInput {
  operation: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export interface MutationGuardResult {
  allowed: boolean;
  reason?: string;
}

export interface MutationGuardController {
  validate?: (input: MutationGuardInput) => MutationGuardResult;
}

// ---------------------------------------------------------------------------
// HierarchicalMemory (tiered store: working / episodic / semantic / archival)
// ---------------------------------------------------------------------------

export interface HierarchicalMemoryRecallQuery {
  query?: string;
  k?: number;
  topK?: number;
}

export interface HierarchicalMemoryController {
  store?: (
    keyOrValue: string | Record<string, unknown>,
    importance?: number | string,
    tier?: string,
    metadata?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  recall?: (
    queryOrObj: string | HierarchicalMemoryRecallQuery,
    topK?: number,
  ) => Promise<unknown> | unknown;
  delete?: (key: string) => Promise<unknown> | unknown;
  remove?: (key: string) => Promise<unknown> | unknown;
  getStats?: () => unknown;
  promote?: (key: string) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// Reflexion / ReflexionMemory (episode lifecycle + delete)
// ---------------------------------------------------------------------------

export interface ReflexionStartInput {
  context?: unknown;
}

export interface ReflexionEndInput {
  outcome?: unknown;
  [key: string]: unknown;
}

export interface ReflexionMemoryController {
  startEpisode?: (sessionId: string, input?: ReflexionStartInput) => Promise<unknown> | unknown;
  endEpisode?: (sessionId: string, input?: ReflexionEndInput) => Promise<unknown> | unknown;
  deleteEpisode?: (key: string) => Promise<boolean | unknown>;
}

// ---------------------------------------------------------------------------
// CausalGraph / CausalMemoryGraph
// ---------------------------------------------------------------------------

export interface CausalGraphController {
  addEdge?: (sourceId: string, targetId: string, attrs?: Record<string, unknown>) => unknown;
  removeEdge?: (sourceId: string, targetId: string, relation?: string) => Promise<unknown> | unknown;
  deleteEdgesByEndpoints?: (
    sourceId: string,
    targetId: string,
    relation?: string,
  ) => Promise<unknown> | unknown;
  deleteNode?: (nodeId: string, opts?: { cascade?: boolean }) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// MemoryConsolidation / NightlyLearner
// ---------------------------------------------------------------------------

export interface MemoryConsolidationController {
  consolidate?: () => Promise<unknown> | unknown;
}

export interface NightlyLearnerController {
  consolidate?: (opts: { sessionId: string }) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// BatchOperations (bulk insert / update / delete)
// ---------------------------------------------------------------------------

export interface BatchOperationsController {
  insertEpisodes?: (episodes: unknown[]) => Promise<unknown> | unknown;
  bulkDelete?: (collection: string, where: Record<string, unknown>) => Promise<unknown> | unknown;
  bulkUpdate?: (
    collection: string,
    set: Record<string, unknown>,
    where: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// ContextSynthesizer
// ---------------------------------------------------------------------------

export interface ContextSynthesizerController {
  synthesize?: (memories: unknown[], opts: { includeRecommendations?: boolean }) => unknown;
}

// ---------------------------------------------------------------------------
// Aggregate ControllerCapabilities
// ---------------------------------------------------------------------------

/**
 * Typed view over the ControllerRegistry. Each slot is optional because
 * controllers register lazily and may be absent on slim installs.
 *
 * Bridges should resolve this once at the top of a function via
 * {@link getControllerCapabilities}, then read `caps.foo` instead of
 * `registry.get('foo')`. Method-level probes still apply because many
 * controllers ship dual-API aliases.
 */
export interface ControllerCapabilities {
  reasoningBank?: ReasoningBankController;
  learningSystem?: LearningSystemController;
  skills?: SkillsController;
  semanticRouter?: SemanticRouterController;
  attestationLog?: AttestationLogController;
  guardedVectorBackend?: GuardedVectorController;
  cache?: CacheController;
  mutationGuard?: MutationGuardController;
  hierarchicalMemory?: HierarchicalMemoryController;
  reflexion?: ReflexionMemoryController;
  reflexionMemory?: ReflexionMemoryController;
  causalGraph?: CausalGraphController;
  memoryConsolidation?: MemoryConsolidationController;
  nightlyLearner?: NightlyLearnerController;
  batchOperations?: BatchOperationsController;
  contextSynthesizer?: ContextSynthesizerController;
}

/**
 * Minimal shape of ControllerRegistry that {@link getControllerCapabilities}
 * needs. Defined locally so this module stays free of controller-package
 * imports (the registry's real type lives in `@claude-flow/memory`).
 */
export interface ControllerRegistryLike {
  get: (name: string) => unknown;
}

/**
 * Build a typed {@link ControllerCapabilities} view over a registry.
 *
 * This is a thin adapter — it just calls `registry.get(name)` for each
 * known slot and returns a single object with the typed slots populated.
 * No method-level probing happens here; that stays at the call sites
 * because the dual-API surface forces it.
 */
export function getControllerCapabilities(
  registry: ControllerRegistryLike,
): ControllerCapabilities {
  return {
    reasoningBank: (registry.get('reasoningBank') as ReasoningBankController) ?? undefined,
    learningSystem: (registry.get('learningSystem') as LearningSystemController) ?? undefined,
    skills: (registry.get('skills') as SkillsController) ?? undefined,
    semanticRouter: (registry.get('semanticRouter') as SemanticRouterController) ?? undefined,
    attestationLog: (registry.get('attestationLog') as AttestationLogController) ?? undefined,
    guardedVectorBackend:
      (registry.get('guardedVectorBackend') as GuardedVectorController) ?? undefined,
    cache: (registry.get('tieredCache') as CacheController) ?? undefined,
    mutationGuard: (registry.get('mutationGuard') as MutationGuardController) ?? undefined,
    hierarchicalMemory:
      (registry.get('hierarchicalMemory') as HierarchicalMemoryController) ?? undefined,
    reflexion: (registry.get('reflexion') as ReflexionMemoryController) ?? undefined,
    reflexionMemory: (registry.get('reflexionMemory') as ReflexionMemoryController) ?? undefined,
    causalGraph: (registry.get('causalGraph') as CausalGraphController) ?? undefined,
    memoryConsolidation:
      (registry.get('memoryConsolidation') as MemoryConsolidationController) ?? undefined,
    nightlyLearner: (registry.get('nightlyLearner') as NightlyLearnerController) ?? undefined,
    batchOperations: (registry.get('batchOperations') as BatchOperationsController) ?? undefined,
    contextSynthesizer:
      (registry.get('contextSynthesizer') as ContextSynthesizerController) ?? undefined,
  };
}
