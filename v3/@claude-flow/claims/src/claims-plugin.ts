import type { ClaudeFlowPlugin, PluginContext } from '@claude-flow/shared/src/plugin-interface.js';
import {
  ClaimService,
  type IClaimService,
  type IIssueRepository,
  type IClaimantRepository,
} from './index.js';
import { createClaimRepository, createClaimEventStore } from './index.js';

export class ClaimsDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'claims';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];
  readonly description = 'Claims-based authorization — work claiming, handoff, load balancing';
  readonly trustLevel = 'official' as const;

  private service: IClaimService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const claimRepository = createClaimRepository();
    const eventStore = createClaimEventStore();

    // Minimal no-op stubs for optional repositories (no in-memory impl provided by the domain)
    const issueRepository = {
      findById: async () => null,
      findByFilters: async () => [],
      findAvailable: async () => [],
      exists: async () => false,
      initialize: async () => {},
      shutdown: async () => {},
    } as unknown as IIssueRepository;

    const claimantRepository = {
      findById: async () => null,
      findByType: async () => [],
      findByCapabilities: async () => [],
      findAvailable: async () => [],
      exists: async () => false,
      initialize: async () => {},
      shutdown: async () => {},
    } as unknown as IClaimantRepository;

    this.service = new ClaimService(
      claimRepository,
      issueRepository,
      claimantRepository,
      eventStore,
    );

    context.services.register<IClaimService>('claims-service', this.service);
    context.logger.info('[ClaimsDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.service = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined;
  }
}
