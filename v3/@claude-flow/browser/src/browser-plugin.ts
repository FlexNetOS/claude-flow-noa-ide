import type { ClaudeFlowPlugin, PluginContext } from '@claude-flow/shared/src/plugin-interface.js';
import { createBrowserService, type BrowserService, type BrowserServiceConfig } from './index.js';

export class BrowserDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'browser';
  readonly version = '3.0.0-alpha.1';
  readonly dependencies: string[] = [];
  readonly description = 'Browser automation — agent-browser integration, MCP tools, trajectory tracking';
  readonly trustLevel = 'official' as const;

  private service: BrowserService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    const cfg = context.config as Partial<BrowserServiceConfig & Record<string, unknown>>;
    this.service = createBrowserService(cfg as Partial<BrowserServiceConfig>);
    context.services.register<BrowserService>('browser-service', this.service);
    context.logger.info('[BrowserDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.service = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined;
  }
}
