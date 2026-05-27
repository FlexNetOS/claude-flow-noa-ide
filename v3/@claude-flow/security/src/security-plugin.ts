import type { ClaudeFlowPlugin, PluginContext } from '@claude-flow/shared/src/plugin-interface.js';
import { createSecurityModule, type SecurityModule, type SecurityModuleConfig } from './index.js';

export class SecurityDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'security';
  readonly version = '3.0.0-alpha.6';
  readonly dependencies: string[] = [];
  readonly description = 'Security primitives — CVE fixes, path validation, token generation';
  readonly trustLevel = 'official' as const;
  readonly permissions = { filesystem: true as const };

  private module: SecurityModule | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const cfg = context.config as Partial<SecurityModuleConfig & Record<string, unknown>>;

    const moduleConfig: SecurityModuleConfig = {
      projectRoot: (cfg.projectRoot as string | undefined) ?? process.cwd(),
      hmacSecret: (cfg.hmacSecret as string | undefined) ?? crypto.randomUUID(),
      bcryptRounds: (cfg.bcryptRounds as number | undefined) ?? 12,
      allowedCommands: (cfg.allowedCommands as string[] | undefined) ?? ['git', 'npm', 'node'],
    };

    this.module = createSecurityModule(moduleConfig);
    context.services.register<SecurityModule>('security-module', this.module);
    context.logger.info('[SecurityDomainPlugin] initialized', { projectRoot: moduleConfig.projectRoot });
  }

  async shutdown(): Promise<void> {
    this.module = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.module !== undefined;
  }
}
