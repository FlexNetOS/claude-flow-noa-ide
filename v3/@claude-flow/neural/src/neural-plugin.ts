import type { ClaudeFlowPlugin, PluginContext } from '../../shared/src/plugin-interface.js';
import { NeuralLearningSystem, createNeuralLearningSystem } from './index.js';

export class NeuralDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'neural';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];
  readonly description = 'Neural learning system — SONA, ReasoningBank, PatternLearner';
  readonly trustLevel = 'official' as const;

  private system: NeuralLearningSystem | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const mode = (context.config.mode as string | undefined) ?? 'balanced';
    this.system = createNeuralLearningSystem(mode as Parameters<typeof createNeuralLearningSystem>[0]);
    context.services.register<NeuralLearningSystem>('neural-learning', this.system);
    context.logger.info('[NeuralDomainPlugin] initialized', { mode });
  }

  async shutdown(): Promise<void> {
    this.system = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.system !== undefined;
  }
}
