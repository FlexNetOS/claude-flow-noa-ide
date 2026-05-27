import type { ClaudeFlowPlugin, PluginContext } from '../../@claude-flow/shared/src/plugin-interface.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './index.js';

export interface TaskExecutionService {
  createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine;
}

export class TaskExecutionDomainPlugin implements ClaudeFlowPlugin {
  readonly name = 'task-execution';
  readonly version = '1.0.0';
  readonly dependencies: string[] = [];
  readonly description = 'Task execution — WorkflowEngine, dependency graph, parallel/rollback support';
  readonly trustLevel = 'official' as const;

  private service: TaskExecutionService | undefined;

  async initialize(context: PluginContext): Promise<void> {
    this.service = {
      createWorkflowEngine: (options: WorkflowEngineOptions) => new WorkflowEngine(options),
    };
    context.services.register<TaskExecutionService>('task-execution', this.service);
    context.logger.info('[TaskExecutionDomainPlugin] initialized');
  }

  async shutdown(): Promise<void> {
    this.service = undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.service !== undefined;
  }
}
