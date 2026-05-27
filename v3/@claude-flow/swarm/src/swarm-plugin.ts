import type { ClaudeFlowPlugin, PluginContext } from '@claude-flow/shared/src/plugin-interface.js';
import { createUnifiedSwarmCoordinator, type UnifiedSwarmCoordinator } from './index.js';

export class SwarmDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'swarm';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];
  readonly description = 'Swarm coordination — hierarchical, mesh, adaptive topologies';
  readonly trustLevel = 'official' as const;

  private coordinator: UnifiedSwarmCoordinator | undefined;

  async initialize(context: PluginContext): Promise<void> {
    this.coordinator = createUnifiedSwarmCoordinator();
    context.services.register<UnifiedSwarmCoordinator>('swarm-coordinator', this.coordinator);
    context.logger.info('[SwarmDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.coordinator = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.coordinator !== undefined;
  }
}
