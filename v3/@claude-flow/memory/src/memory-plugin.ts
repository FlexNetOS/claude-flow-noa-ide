import type { ClaudeFlowPlugin, PluginContext } from '../../shared/src/plugin-interface.js';
import {
  UnifiedMemoryService,
  createInMemoryService,
  createPersistentService,
  type UnifiedMemoryServiceConfig,
} from './index.js';

export class MemoryDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'memory';
  readonly version = '3.0.0-alpha.15';
  readonly dependencies: string[] = [];
  readonly description = 'Unified memory service — AgentDB, HNSW indexing, hybrid SQLite backend';
  readonly trustLevel = 'official' as const;
  readonly permissions = { filesystem: true as const, memory: true as const };

  private service: UnifiedMemoryService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const cfg = context.config as Partial<UnifiedMemoryServiceConfig & Record<string, unknown>>;
    const persistencePath = cfg.persistencePath as string | undefined;

    try {
      this.service = persistencePath
        ? createPersistentService(persistencePath)
        : createInMemoryService();

      await this.service.initialize();
    } catch (err) {
      context.logger.warn('[MemoryDomainPlugin] persistence init failed, falling back to in-memory', err);
      this.service = createInMemoryService();
      await this.service.initialize();
    }

    context.services.register<UnifiedMemoryService>('memory-service', this.service);
    context.logger.info('[MemoryDomainPlugin] initialized', {
      persistence: Boolean(persistencePath),
      path: persistencePath ?? '(in-memory)',
    });
  }

  async shutdown(): Promise<void> {
    if (this.service) {
      await this.service.shutdown();
      this.service = undefined;
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined && this.service.isInitialized();
  }
}
