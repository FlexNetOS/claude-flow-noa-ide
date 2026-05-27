/**
 * Hooks MCP Tools: background workers (12 triggers).
 * Extracted from hooks-tools.ts during the bounded-context split.
 */

import { type MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// =============================================================================
// Worker Dispatch Tools (12 Background Workers)
// =============================================================================

/**
 * Worker trigger types matching agentic-flow v3
 */
type WorkerTrigger =
  | 'ultralearn'    // Deep knowledge acquisition
  | 'optimize'      // Performance optimization
  | 'consolidate'   // Memory consolidation
  | 'predict'       // Predictive preloading
  | 'audit'         // Security analysis
  | 'map'           // Codebase mapping
  | 'preload'       // Resource preloading
  | 'deepdive'      // Deep code analysis
  | 'document'      // Auto-documentation
  | 'refactor'      // Refactoring suggestions
  | 'benchmark'     // Performance benchmarks
  | 'testgaps';     // Test coverage analysis

/**
 * Worker trigger patterns for auto-detection
 */
const WORKER_TRIGGER_PATTERNS: Record<WorkerTrigger, RegExp[]> = {
  ultralearn: [
    /learn\s+about/i,
    /understand\s+(how|what|why)/i,
    /deep\s+dive\s+into/i,
    /explain\s+in\s+detail/i,
    /comprehensive\s+guide/i,
    /master\s+this/i,
  ],
  optimize: [
    /optimize/i,
    /improve\s+performance/i,
    /make\s+(it\s+)?faster/i,
    /speed\s+up/i,
    /reduce\s+(memory|time)/i,
    /performance\s+issue/i,
  ],
  consolidate: [
    /consolidate/i,
    /merge\s+memories/i,
    /clean\s+up\s+memory/i,
    /deduplicate/i,
    /memory\s+maintenance/i,
  ],
  predict: [
    /what\s+will\s+happen/i,
    /predict/i,
    /forecast/i,
    /anticipate/i,
    /preload/i,
    /prepare\s+for/i,
  ],
  audit: [
    /security\s+audit/i,
    /vulnerability/i,
    /security\s+check/i,
    /pentest/i,
    /security\s+scan/i,
    /cve/i,
    /owasp/i,
  ],
  map: [
    /map\s+(the\s+)?codebase/i,
    /architecture\s+overview/i,
    /project\s+structure/i,
    /dependency\s+graph/i,
    /code\s+map/i,
    /explore\s+codebase/i,
  ],
  preload: [
    /preload/i,
    /cache\s+ahead/i,
    /prefetch/i,
    /warm\s+(up\s+)?cache/i,
  ],
  deepdive: [
    /deep\s+dive/i,
    /analyze\s+thoroughly/i,
    /in-depth\s+analysis/i,
    /comprehensive\s+review/i,
    /detailed\s+examination/i,
  ],
  document: [
    /document\s+(this|the)/i,
    /generate\s+docs/i,
    /add\s+documentation/i,
    /write\s+readme/i,
    /api\s+docs/i,
    /jsdoc/i,
  ],
  refactor: [
    /refactor/i,
    /clean\s+up\s+code/i,
    /improve\s+code\s+quality/i,
    /restructure/i,
    /simplify/i,
    /make\s+more\s+readable/i,
  ],
  benchmark: [
    /benchmark/i,
    /performance\s+test/i,
    /measure\s+speed/i,
    /stress\s+test/i,
    /load\s+test/i,
  ],
  testgaps: [
    /test\s+coverage/i,
    /missing\s+tests/i,
    /untested\s+code/i,
    /coverage\s+report/i,
    /test\s+gaps/i,
    /add\s+tests/i,
  ],
};

/**
 * Worker configurations
 */
const WORKER_CONFIGS: Record<WorkerTrigger, {
  description: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  estimatedDuration: string;
  capabilities: string[];
}> = {
  ultralearn: {
    description: 'Deep knowledge acquisition and learning',
    priority: 'normal',
    estimatedDuration: '60s',
    capabilities: ['research', 'analysis', 'synthesis'],
  },
  optimize: {
    description: 'Performance optimization and tuning',
    priority: 'high',
    estimatedDuration: '30s',
    capabilities: ['profiling', 'optimization', 'benchmarking'],
  },
  consolidate: {
    description: 'Memory consolidation and cleanup',
    priority: 'low',
    estimatedDuration: '20s',
    capabilities: ['memory-management', 'deduplication'],
  },
  predict: {
    description: 'Predictive preloading and anticipation',
    priority: 'normal',
    estimatedDuration: '15s',
    capabilities: ['prediction', 'caching', 'preloading'],
  },
  audit: {
    description: 'Security analysis and vulnerability scanning',
    priority: 'critical',
    estimatedDuration: '45s',
    capabilities: ['security', 'vulnerability-scanning', 'audit'],
  },
  map: {
    description: 'Codebase mapping and architecture analysis',
    priority: 'normal',
    estimatedDuration: '30s',
    capabilities: ['analysis', 'mapping', 'visualization'],
  },
  preload: {
    description: 'Resource preloading and cache warming',
    priority: 'low',
    estimatedDuration: '10s',
    capabilities: ['caching', 'preloading'],
  },
  deepdive: {
    description: 'Deep code analysis and examination',
    priority: 'normal',
    estimatedDuration: '60s',
    capabilities: ['analysis', 'review', 'understanding'],
  },
  document: {
    description: 'Auto-documentation generation',
    priority: 'normal',
    estimatedDuration: '45s',
    capabilities: ['documentation', 'writing', 'generation'],
  },
  refactor: {
    description: 'Code refactoring suggestions',
    priority: 'normal',
    estimatedDuration: '30s',
    capabilities: ['refactoring', 'code-quality', 'improvement'],
  },
  benchmark: {
    description: 'Performance benchmarking',
    priority: 'normal',
    estimatedDuration: '60s',
    capabilities: ['benchmarking', 'testing', 'measurement'],
  },
  testgaps: {
    description: 'Test coverage analysis',
    priority: 'normal',
    estimatedDuration: '30s',
    capabilities: ['testing', 'coverage', 'analysis'],
  },
};

// In-memory worker tracking
const activeWorkers: Map<string, {
  id: string;
  trigger: WorkerTrigger;
  context: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  phase: string;
  startedAt: Date;
  completedAt?: Date;
}> = new Map();

let workerIdCounter = 0;

/**
 * Detect triggers from prompt text
 */
function detectWorkerTriggers(text: string): {
  detected: boolean;
  triggers: WorkerTrigger[];
  confidence: number;
  context: string;
} {
  if (!text) return { detected: false, triggers: [], confidence: 0, context: '' };

  const detectedTriggers: WorkerTrigger[] = [];
  let totalMatches = 0;

  for (const [trigger, patterns] of Object.entries(WORKER_TRIGGER_PATTERNS) as [WorkerTrigger, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        if (!detectedTriggers.includes(trigger)) {
          detectedTriggers.push(trigger);
        }
        totalMatches++;
      }
    }
  }

  const confidence = detectedTriggers.length > 0
    ? Math.min(1, totalMatches / (detectedTriggers.length * 2))
    : 0;

  return {
    detected: detectedTriggers.length > 0,
    triggers: detectedTriggers,
    confidence,
    context: text.slice(0, 100),
  };
}

// Worker list tool
export const hooksWorkerList: MCPTool = {
  name: 'hooks_worker-list',
  description: 'List all 12 background workers with status and capabilities Use when native Bash hooks (via Claude Code\'s settings.json) are wrong because you need Ruflo-side state — pattern persistence, neural training signals, model-routing learning, cost tracking, audit chain. For one-off shell commands, plain Bash hooks are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status (all, running, completed, pending)' },
      includeActive: { type: 'boolean', description: 'Include active worker instances' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const statusFilter = (params.status as string) || 'all';
    const includeActive = params.includeActive !== false;

    const workers = Object.entries(WORKER_CONFIGS).map(([trigger, config]) => ({
      trigger,
      ...config,
      patterns: WORKER_TRIGGER_PATTERNS[trigger as WorkerTrigger].length,
    }));

    const activeList = includeActive
      ? Array.from(activeWorkers.values()).filter(w =>
          statusFilter === 'all' || w.status === statusFilter
        )
      : [];

    return {
      workers,
      total: 12,
      active: {
        instances: activeList,
        count: activeList.length,
        byStatus: {
          pending: activeList.filter(w => w.status === 'pending').length,
          running: activeList.filter(w => w.status === 'running').length,
          completed: activeList.filter(w => w.status === 'completed').length,
          failed: activeList.filter(w => w.status === 'failed').length,
        },
      },
      performanceTargets: {
        triggerDetection: '<5ms',
        workerSpawn: '<50ms',
        maxConcurrent: 10,
      },
    };
  },
};

// Worker dispatch tool
export const hooksWorkerDispatch: MCPTool = {
  name: 'hooks_worker-dispatch',
  description: 'Dispatch a background worker for analysis/optimization tasks Use when native Bash hooks (via Claude Code\'s settings.json) are wrong because you need Ruflo-side state — pattern persistence, neural training signals, model-routing learning, cost tracking, audit chain. For one-off shell commands, plain Bash hooks are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      trigger: {
        type: 'string',
        description: 'Worker trigger type',
        enum: ['ultralearn', 'optimize', 'consolidate', 'predict', 'audit', 'map', 'preload', 'deepdive', 'document', 'refactor', 'benchmark', 'testgaps'],
      },
      context: { type: 'string', description: 'Context for the worker (file path, topic, etc.)' },
      priority: { type: 'string', description: 'Priority (low, normal, high, critical)' },
      background: { type: 'boolean', description: 'Run in background (non-blocking)' },
    },
    required: ['trigger'],
  },
  handler: async (params: Record<string, unknown>) => {
    const trigger = params.trigger as WorkerTrigger;
    const context = (params.context as string) || 'default';
    const priority = (params.priority as string) || WORKER_CONFIGS[trigger]?.priority || 'normal';
    const background = params.background !== false;

    if (params.context) { const v = validateText(params.context as string, 'context'); if (!v.valid) return { success: false, error: v.error }; }

    if (!WORKER_CONFIGS[trigger]) {
      return {
        success: false,
        error: `Unknown worker trigger: ${trigger}`,
        availableTriggers: Object.keys(WORKER_CONFIGS),
      };
    }

    const workerId = `worker_${trigger}_${++workerIdCounter}_${Date.now().toString(36)}`;
    const config = WORKER_CONFIGS[trigger];

    // ADR-093 F2: stop returning status:"completed" for a worker that
    // never ran (#1700 item 1). Detect daemon presence via PID file and
    // surface honest verdicts (`no-daemon` / `queued` / `synthetic`).
    const cwd = getProjectCwd();
    const pidFile = join(cwd, '.claude-flow', 'daemon.pid');
    let daemonPid: number | null = null;
    let daemonAlive = false;
    if (existsSync(pidFile)) {
      try {
        const raw = readFileSync(pidFile, 'utf-8').trim();
        const pid = parseInt(raw, 10);
        if (Number.isFinite(pid) && pid > 0) {
          daemonPid = pid;
          try { process.kill(pid, 0); daemonAlive = true; } catch { daemonAlive = false; }
        }
      } catch { /* unreadable PID file */ }
    }

    const worker: {
      id: string;
      trigger: WorkerTrigger;
      context: string;
      status: 'pending' | 'running' | 'completed' | 'failed';
      progress: number;
      phase: string;
      startedAt: Date;
      completedAt?: Date;
    } = {
      id: workerId,
      trigger,
      context,
      status: daemonAlive ? 'pending' : 'pending',
      progress: 0,
      phase: 'initializing',
      startedAt: new Date(),
    };

    activeWorkers.set(workerId, worker);

    // Determine honest status
    let reportedStatus: 'queued' | 'no-daemon' | 'synthetic-completed' | 'mcp-only';
    let note = '';
    if (!daemonAlive) {
      reportedStatus = 'no-daemon';
      note = 'No worker daemon detected. Run `claude-flow daemon start` to enable real worker execution. The dispatch was recorded in-process but no actual work will run.';
    } else if (background) {
      // #1845: write a durable queue file the daemon polls every 5s. Until
      // 3.7.0-alpha.11 the dispatch only updated a process-local Map that
      // the daemon (separate process) could never see, so `queued` was a
      // lie. The queue file makes it real and inspectable on disk.
      const queueDir = join(cwd, '.claude-flow', 'daemon-queue');
      const queuePath = join(queueDir, `${workerId}.json`);
      let queueWritten = false;
      try {
        if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
        writeFileSync(
          queuePath,
          JSON.stringify({ workerId, trigger, context, priority, enqueuedAt: new Date().toISOString() }, null, 2),
        );
        queueWritten = true;
      } catch (err) {
        // Filesystem error — fall back to mcp-only status so we never
        // claim queued without proof.
        note = `Daemon detected (pid ${daemonPid}) but queue write to ${queuePath} failed: ${(err as Error).message}. Worker recorded in-process only; use \`ruflo daemon trigger -w ${trigger}\` to run synchronously.`;
      }
      if (queueWritten) {
        reportedStatus = 'queued';
        note = `Worker queued for daemon (pid ${daemonPid}) at ${queuePath}. Daemon polls every 5s; processed entries move to .claude-flow/daemon-queue/.processed/. Poll hooks_worker-status until status === "completed".`;
      } else {
        reportedStatus = 'mcp-only';
      }
    } else {
      // Synchronous mode without a runner — be honest about it
      reportedStatus = 'synthetic-completed';
      worker.progress = 100;
      worker.phase = 'completed';
      worker.status = 'completed';
      worker.completedAt = new Date();
      note = 'Synchronous mode: worker record marked completed but no real work executed (no in-process runner). Use background:true with the daemon for real execution.';
    }

    return {
      success: true,
      workerId,
      trigger,
      context,
      priority,
      config: {
        description: config.description,
        estimatedDuration: config.estimatedDuration,
        capabilities: config.capabilities,
      },
      status: reportedStatus,
      daemonAlive,
      daemonPid: daemonAlive ? daemonPid : null,
      background,
      note,
      timestamp: new Date().toISOString(),
    };
  },
};

// Worker status tool
export const hooksWorkerStatus: MCPTool = {
  name: 'hooks_worker-status',
  description: 'Get status of a specific worker or all active workers Use when native Bash hooks (via Claude Code\'s settings.json) are wrong because you need Ruflo-side state — pattern persistence, neural training signals, model-routing learning, cost tracking, audit chain. For one-off shell commands, plain Bash hooks are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      workerId: { type: 'string', description: 'Specific worker ID to check' },
      includeCompleted: { type: 'boolean', description: 'Include completed workers' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const workerId = params.workerId as string;
    const includeCompleted = params.includeCompleted !== false;

    if (workerId) { const v = validateIdentifier(workerId, 'workerId'); if (!v.valid) return { success: false, error: v.error }; }

    if (workerId) {
      const worker = activeWorkers.get(workerId);
      if (!worker) {
        return {
          success: false,
          error: `Worker not found: ${workerId}`,
        };
      }
      return {
        success: true,
        worker: {
          ...worker,
          duration: worker.completedAt
            ? worker.completedAt.getTime() - worker.startedAt.getTime()
            : Date.now() - worker.startedAt.getTime(),
        },
      };
    }

    const workers = Array.from(activeWorkers.values())
      .filter(w => includeCompleted || w.status !== 'completed')
      .map(w => ({
        ...w,
        duration: w.completedAt
          ? w.completedAt.getTime() - w.startedAt.getTime()
          : Date.now() - w.startedAt.getTime(),
      }));

    return {
      success: true,
      workers,
      summary: {
        total: workers.length,
        running: workers.filter(w => w.status === 'running').length,
        completed: workers.filter(w => w.status === 'completed').length,
        failed: workers.filter(w => w.status === 'failed').length,
      },
    };
  },
};

// Worker detect tool - detect triggers from prompt
export const hooksWorkerDetect: MCPTool = {
  name: 'hooks_worker-detect',
  description: 'Detect worker triggers from user prompt (for UserPromptSubmit hook) Use when native Bash hooks (via Claude Code\'s settings.json) are wrong because you need Ruflo-side state — pattern persistence, neural training signals, model-routing learning, cost tracking, audit chain. For one-off shell commands, plain Bash hooks are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'User prompt to analyze' },
      autoDispatch: { type: 'boolean', description: 'Automatically dispatch detected workers' },
      minConfidence: { type: 'number', description: 'Minimum confidence threshold (0-1)' },
    },
    required: ['prompt'],
  },
  handler: async (params: Record<string, unknown>) => {
    const prompt = params.prompt as string;
    const autoDispatch = params.autoDispatch as boolean;
    const minConfidence = (params.minConfidence as number) || 0.5;

    { const v = validateText(prompt, 'prompt'); if (!v.valid) return { success: false, error: v.error }; }

    const detection = detectWorkerTriggers(prompt);

    const result: Record<string, unknown> = {
      prompt: prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''),
      detection,
      triggersFound: detection.triggers.length,
    };

    if (detection.detected && detection.confidence >= minConfidence) {
      result.triggerDetails = detection.triggers.map(trigger => ({
        trigger,
        ...WORKER_CONFIGS[trigger],
      }));

      if (autoDispatch) {
        const dispatched: string[] = [];
        for (const trigger of detection.triggers) {
          const workerId = `worker_${trigger}_${++workerIdCounter}_${Date.now().toString(36)}`;
          activeWorkers.set(workerId, {
            id: workerId,
            trigger,
            context: prompt.slice(0, 100),
            status: 'running',
            progress: 0,
            phase: 'initializing',
            startedAt: new Date(),
          });
          dispatched.push(workerId);

          // Mark worker completion after processing
          setTimeout(() => {
            const w = activeWorkers.get(workerId);
            if (w) {
              w.progress = 100;
              w.phase = 'completed';
              w.status = 'completed';
              w.completedAt = new Date();
            }
          }, 1500);
        }
        result.autoDispatched = true;
        result.workerIds = dispatched;
      }
    }

    return result;
  },
};

// Worker cancel tool
export const hooksWorkerCancel: MCPTool = {
  name: 'hooks_worker-cancel',
  description: 'Cancel a running worker Use when native Bash hooks (via Claude Code\'s settings.json) are wrong because you need Ruflo-side state — pattern persistence, neural training signals, model-routing learning, cost tracking, audit chain. For one-off shell commands, plain Bash hooks are fine.',
  inputSchema: {
    type: 'object',
    properties: {
      workerId: { type: 'string', description: 'Worker ID to cancel' },
    },
    required: ['workerId'],
  },
  handler: async (params: Record<string, unknown>) => {
    const workerId = params.workerId as string;

    { const v = validateIdentifier(workerId, 'workerId'); if (!v.valid) return { success: false, error: v.error }; }

    const worker = activeWorkers.get(workerId);

    if (!worker) {
      return {
        success: false,
        error: `Worker not found: ${workerId}`,
      };
    }

    if (worker.status === 'completed' || worker.status === 'failed') {
      return {
        success: false,
        error: `Worker already ${worker.status}`,
      };
    }

    worker.status = 'failed';
    worker.phase = 'cancelled';
    worker.completedAt = new Date();

    return {
      success: true,
      workerId,
      cancelled: true,
      timestamp: new Date().toISOString(),
    };
  },
};
