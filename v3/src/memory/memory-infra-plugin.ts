import type { ClaudeFlowPlugin, PluginContext } from '../../@claude-flow/shared/src/plugin-interface.js';
import { HybridBackend, SQLiteBackend, AgentDBBackend } from './index.js';
import type { AgentDBOptions } from './infrastructure/AgentDBBackend.js';

export interface MemoryInfraService {
  createSQLiteBackend(dbPath: string): SQLiteBackend;
  createAgentDBBackend(options: AgentDBOptions): AgentDBBackend;
  createHybridBackend(sqlite: SQLiteBackend, agentDb: AgentDBBackend): HybridBackend;
}

export class MemoryInfraDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'memory-infra';
  readonly version = '1.0.0';
  readonly dependencies: string[] = [];
  readonly description = 'Memory infrastructure — HybridBackend, SQLiteBackend, AgentDBBackend factories';
  readonly trustLevel = 'official' as const;
  readonly permissions = { filesystem: true as const };

  private service: MemoryInfraService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    this.service = {
      createSQLiteBackend: (dbPath: string) => new SQLiteBackend(dbPath),
      createAgentDBBackend: (options: AgentDBOptions) => new AgentDBBackend(options),
      createHybridBackend: (sqlite: SQLiteBackend, agentDb: AgentDBBackend) =>
        new HybridBackend(sqlite, agentDb),
    };
    context.services.register<MemoryInfraService>('memory-infra', this.service);
    context.logger.info('[MemoryInfraDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.service = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined;
  }
}
