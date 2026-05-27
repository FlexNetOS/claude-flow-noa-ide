import type { ClaudeFlowPlugin, PluginContext } from '../../@claude-flow/shared/src/plugin-interface.js';
import { Agent } from './index.js';
import type { AgentConfig } from '../shared/types.js';

export interface AgentLifecycleService {
  createAgent(config: AgentConfig): Agent;
}

export class AgentLifecycleDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'agent-lifecycle';
  readonly version = '1.0.0';
  readonly dependencies: string[] = [];
  readonly description = 'Agent lifecycle — Agent entity creation and management';
  readonly trustLevel = 'official' as const;

  private service: AgentLifecycleService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    this.service = {
      createAgent: (config: AgentConfig) => new Agent(config),
    };
    context.services.register<AgentLifecycleService>('agent-lifecycle', this.service);
    context.logger.info('[AgentLifecycleDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.service = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined;
  }
}
