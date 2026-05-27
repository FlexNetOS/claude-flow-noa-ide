import type { ClaudeFlowPlugin, PluginContext } from '../../shared/src/plugin-interface.js';
import { createAIDefence, type AIDefence, type AIDefenceConfig } from './index.js';

export class AIDefenceDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'ai-defence';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];
  readonly description = 'AI threat detection — prompt injection scanning, PII detection, learning';
  readonly trustLevel = 'official' as const;

  private defence: AIDefence | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const cfg = context.config as Partial<AIDefenceConfig>;
    this.defence = createAIDefence(cfg);
    context.services.register<AIDefence>('ai-defence', this.defence);
    context.logger.info('[AIDefenceDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.defence = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.defence !== undefined;
  }
}
