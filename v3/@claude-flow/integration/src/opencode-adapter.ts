/**
 * OpenCodeAdapter - Bridge between Claude Flow Agents and OpenCode
 *
 * Maps Ruflo agent types, configurations, and worker patterns
 * to OpenCode's agent/session model. Enables Ruflo swarms to
 * execute coding tasks via OpenCode instead of Claude Code.
 *
 * Key mappings:
 * - Ruflo agent type → OpenCode session config
 * - Ruflo worker type → OpenCode prompt template
 * - Ruflo model type → OpenCode provider/model string
 *
 * @module v3/integration/opencode-adapter
 * @version 3.0.0-beta.1
 */

import { EventEmitter } from 'events';

// ============================================
// Backend Type
// ============================================

export type BackendType = 'claude' | 'opencode';

// ============================================
// Model Mapping
// ============================================

/**
 * Map Ruflo model types to OpenCode model IDs.
 * OpenCode uses provider/model format (e.g., "anthropic/claude-sonnet-4-20250514").
 */
export const OPENCODE_MODEL_MAP: Record<string, string> = {
  // Claude models via Anthropic provider
  sonnet: 'anthropic/claude-sonnet-4-20250514',
  opus: 'anthropic/claude-opus-4-20250514',
  haiku: 'anthropic/claude-haiku-4-5-20251001',

  // GPT models via OpenAI provider
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  'gpt-4-turbo': 'openai/gpt-4-turbo',
  'gpt-3.5-turbo': 'openai/gpt-3.5-turbo',
  'o1-preview': 'openai/o1-preview',
  'o1-mini': 'openai/o1-mini',
  'o3-mini': 'openai/o3-mini',

  // Gemini models via Google provider
  'gemini-2.0-flash': 'google/gemini-2.0-flash',
  'gemini-1.5-pro': 'google/gemini-1.5-pro',
  'gemini-1.5-flash': 'google/gemini-1.5-flash',
  'gemini-pro': 'google/gemini-pro',

  // Local models via Ollama provider
  'llama3.2': 'ollama/llama3.2',
  'llama3.1': 'ollama/llama3.1',
  'mistral': 'ollama/mistral',
  'mixtral': 'ollama/mixtral',
  'codellama': 'ollama/codellama',
  'deepseek-coder': 'ollama/deepseek-coder',
};

/**
 * Resolve a Ruflo model type to an OpenCode model ID.
 * Falls back to the raw model string if no mapping found
 * (allows passing OpenCode model IDs directly).
 */
export function resolveOpenCodeModel(rufloModel: string): string {
  return OPENCODE_MODEL_MAP[rufloModel] || rufloModel;
}

// ============================================
// Agent Type Mapping
// ============================================

/**
 * Map Ruflo agent types to OpenCode agent configurations.
 * OpenCode agents have modes: "primary" (full access) or "subagent" (sandboxed).
 * All Ruflo headless workers map to "primary" mode since they need full tool access.
 */
export interface OpenCodeAgentConfig {
  /** OpenCode agent name */
  name: string;
  /** Agent mode: primary (full tools) or subagent (restricted) */
  mode: 'primary' | 'subagent';
  /** Model to use for this agent */
  model?: string;
  /** Custom instructions appended to system prompt */
  instructions?: string;
}

export const OPENCODE_AGENT_MAP: Record<string, OpenCodeAgentConfig> = {
  coder: {
    name: 'ruflo-coder',
    mode: 'primary',
    instructions: 'You are a coding agent in a Ruflo swarm. Write clean, well-tested code following the project conventions.',
  },
  tester: {
    name: 'ruflo-tester',
    mode: 'primary',
    instructions: 'You are a testing agent. Write comprehensive tests using the project testing framework. Focus on edge cases and error paths.',
  },
  reviewer: {
    name: 'ruflo-reviewer',
    mode: 'primary',
    instructions: 'You are a code review agent. Review code for correctness, security, performance, and best practices.',
  },
  researcher: {
    name: 'ruflo-researcher',
    mode: 'primary',
    instructions: 'You are a research agent. Analyze codebases, find patterns, and provide thorough analysis.',
  },
  architect: {
    name: 'ruflo-architect',
    mode: 'primary',
    instructions: 'You are a system architect. Design scalable, maintainable architectures following domain-driven design.',
  },
  coordinator: {
    name: 'ruflo-coordinator',
    mode: 'primary',
    instructions: 'You are a coordination agent. Orchestrate multi-agent workflows and track task progress.',
  },
  'security-architect': {
    name: 'ruflo-security',
    mode: 'primary',
    instructions: 'You are a security architect. Audit code for vulnerabilities, review auth patterns, and ensure secure coding practices.',
  },
  'security-auditor': {
    name: 'ruflo-security-auditor',
    mode: 'primary',
    instructions: 'You are a security auditor. Find CVEs, hardcoded secrets, injection risks, and insecure dependencies.',
  },
  'performance-engineer': {
    name: 'ruflo-perf',
    mode: 'primary',
    instructions: 'You are a performance engineer. Identify bottlenecks, optimize queries, reduce memory usage, and improve rendering.',
  },
};

/**
 * Resolve OpenCode agent config for a Ruflo agent type.
 * Falls back to a generic primary agent if no mapping found.
 */
export function resolveOpenCodeAgent(rufloAgentType: string): OpenCodeAgentConfig {
  return OPENCODE_AGENT_MAP[rufloAgentType] || {
    name: `ruflo-${rufloAgentType}`,
    mode: 'primary',
    instructions: `You are a ${rufloAgentType} agent in a Ruflo swarm. Complete your assigned task thoroughly.`,
  };
}

// ============================================
// Adapter Class
// ============================================

export interface OpenCodeAdapterConfig {
  /** Default model for OpenCode sessions */
  defaultModel?: string;
  /** OpenCode serve port */
  port?: number;
  /** Timeout for OpenCode operations */
  timeout?: number;
}

/**
 * OpenCodeAdapter — Converts Ruflo agent requests to OpenCode-compatible formats.
 *
 * This adapter handles:
 * - Model ID translation (Ruflo short names → OpenCode provider/model format)
 * - Agent configuration mapping
 * - Prompt template generation for headless execution
 */
export class OpenCodeAdapter extends EventEmitter {
  private config: Required<OpenCodeAdapterConfig>;

  constructor(config?: OpenCodeAdapterConfig) {
    super();
    this.config = {
      defaultModel: config?.defaultModel || 'anthropic/claude-sonnet-4-20250514',
      port: config?.port || 4096,
      timeout: config?.timeout || 5 * 60 * 1000,
    };
  }

  /**
   * Get the OpenCode model ID for a Ruflo model name.
   */
  getModel(rufloModel?: string): string {
    if (!rufloModel) return this.config.defaultModel;
    return resolveOpenCodeModel(rufloModel);
  }

  /**
   * Get OpenCode agent config for a given agent type.
   */
  getAgentConfig(agentType: string): OpenCodeAgentConfig {
    return resolveOpenCodeAgent(agentType);
  }

  /**
   * Build a headless execution command for `opencode run`.
   */
  buildRunCommand(prompt: string, model?: string): { cmd: string; args: string[] } {
    const args: string[] = ['run', '--dangerously-skip-permissions'];
    if (model) {
      args.push('--model', this.getModel(model));
    }
    args.push(prompt);
    return { cmd: 'opencode', args };
  }

  /**
   * Build the environment variables for an OpenCode process.
   */
  buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_PARENT_SESSION_ID;
    return env;
  }

  /**
   * Check if OpenCode CLI is available on the system.
   */
  async checkAvailability(): Promise<{ available: boolean; version?: string }> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync('opencode --version', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });
      const versionMatch = output.trim().match(/v?(\d+\.\d+\.\d+)/);
      return {
        available: true,
        version: versionMatch ? `v${versionMatch[1]}` : output.trim(),
      };
    } catch {
      return { available: false };
    }
  }

  /**
   * Get the recommended OpenCode model for a given Ruflo worker type.
   * Maps worker types to optimal model choices based on task complexity.
   */
  getRecommendedModel(workerType: string): string {
    const modelMap: Record<string, string> = {
      // Critical security work — use best model
      audit: this.getModel('sonnet'),

      // Performance analysis — balanced
      optimize: this.getModel('sonnet'),

      // Test gaps — balanced
      testgaps: this.getModel('sonnet'),

      // Documentation — cheap model OK
      document: this.getModel('gpt-4o-mini'),

      // Deep learning — best model
      ultralearn: this.getModel('opus'),
      deepdive: this.getModel('opus'),

      // Refactoring — balanced
      refactor: this.getModel('sonnet'),

      // Predictive — cheap model OK
      predict: this.getModel('gpt-4o-mini'),
    };

    return modelMap[workerType] || this.config.defaultModel;
  }
}

export default OpenCodeAdapter;
