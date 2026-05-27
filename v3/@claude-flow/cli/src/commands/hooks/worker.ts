/**
 * Hooks subcommand: worker (background worker management).
 * Extracted from hooks.ts during the bounded-context split.
 */

import type { Command, CommandContext, CommandResult } from '../../types.js';
import { output } from '../../output.js';
import { callMCPTool, MCPClientError } from '../../mcp-client.js';

const workerListCommand: Command = {
  name: 'list',
  description: 'List all 12 background workers with capabilities',
  options: [
    { name: 'status', short: 's', type: 'string', description: 'Filter by status (all, running, completed, pending)' },
    { name: 'active', short: 'a', type: 'boolean', description: 'Show active worker instances' },
  ],
  examples: [
    { command: 'claude-flow hooks worker list', description: 'List all workers' },
    { command: 'claude-flow hooks worker list --active', description: 'Show active instances' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const spinner = output.createSpinner({ text: 'Loading workers...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        workers: Array<{
          trigger: string;
          description: string;
          priority: string;
          estimatedDuration: string;
          capabilities: string[];
          patterns: number;
        }>;
        total: number;
        active: {
          instances: Array<{
            id: string;
            trigger: string;
            status: string;
            progress: number;
            phase: string;
          }>;
          count: number;
          byStatus: Record<string, number>;
        };
        performanceTargets: Record<string, string | number>;
      }>('hooks_worker-list', {
        status: ctx.flags['status'] || 'all',
        includeActive: ctx.flags['active'] !== false,
      });

      spinner.succeed('Workers loaded');

      output.writeln();
      output.writeln(output.bold('Background Workers (12 Total)'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'trigger', header: 'Worker', width: 14 },
          { key: 'priority', header: 'Priority', width: 10 },
          { key: 'estimatedDuration', header: 'Est. Time', width: 10 },
          { key: 'description', header: 'Description', width: 40 },
        ],
        data: result.workers.map(w => ({
          trigger: output.highlight(w.trigger),
          priority: w.priority === 'critical' ? output.error(w.priority) :
                   w.priority === 'high' ? output.warning(w.priority) :
                   w.priority,
          estimatedDuration: w.estimatedDuration,
          description: w.description,
        })),
      });

      if (ctx.flags['active'] && result.active.count > 0) {
        output.writeln();
        output.writeln(output.bold('Active Instances'));
        output.printTable({
          columns: [
            { key: 'id', header: 'Worker ID', width: 35 },
            { key: 'trigger', header: 'Type', width: 12 },
            { key: 'status', header: 'Status', width: 12 },
            { key: 'progress', header: 'Progress', width: 10 },
          ],
          data: result.active.instances.map(w => ({
            id: w.id,
            trigger: w.trigger,
            status: w.status === 'running' ? output.highlight(w.status) :
                   w.status === 'completed' ? output.success(w.status) :
                   w.status === 'failed' ? output.error(w.status) : w.status,
            progress: `${w.progress}%`,
          })),
        });
      }

      output.writeln();
      output.writeln(output.dim('Performance targets:'));
      output.writeln(output.dim(`  Trigger detection: ${result.performanceTargets.triggerDetection}`));
      output.writeln(output.dim(`  Worker spawn: ${result.performanceTargets.workerSpawn}`));
      output.writeln(output.dim(`  Max concurrent: ${result.performanceTargets.maxConcurrent}`));

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Failed to load workers');
      if (error instanceof MCPClientError) {
        output.printError(`Worker error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerDispatchCommand: Command = {
  name: 'dispatch',
  description: 'Dispatch a background worker for analysis/optimization',
  options: [
    { name: 'trigger', short: 't', type: 'string', description: 'Worker type (ultralearn, optimize, audit, map, etc.)', required: true },
    { name: 'context', short: 'c', type: 'string', description: 'Context for the worker (file path, topic)' },
    { name: 'priority', short: 'p', type: 'string', description: 'Priority (low, normal, high, critical)' },
    { name: 'sync', short: 's', type: 'boolean', description: 'Wait for completion (synchronous)' },
  ],
  examples: [
    { command: 'claude-flow hooks worker dispatch -t optimize -c src/', description: 'Dispatch optimize worker' },
    { command: 'claude-flow hooks worker dispatch -t audit -p critical', description: 'Security audit with critical priority' },
    { command: 'claude-flow hooks worker dispatch -t testgaps --sync', description: 'Test coverage analysis (sync)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const trigger = ctx.flags['trigger'] as string;
    const context = ctx.flags['context'] as string || 'default';
    const priority = ctx.flags['priority'] as string;
    const background = !ctx.flags['sync'];

    if (!trigger) {
      output.printError('--trigger is required');
      output.writeln('Available triggers: ultralearn, optimize, consolidate, predict, audit, map, preload, deepdive, document, refactor, benchmark, testgaps');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Dispatching ${trigger} worker...`, spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        workerId: string;
        trigger: string;
        context: string;
        priority: string;
        config: {
          description: string;
          estimatedDuration: string;
          capabilities: string[];
        };
        status: string;
        error?: string;
      }>('hooks_worker-dispatch', {
        trigger,
        context,
        priority,
        background,
      });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed(`Worker dispatched: ${result.workerId}`);

      output.writeln();
      output.printTable({
        columns: [
          { key: 'field', header: 'Field', width: 18 },
          { key: 'value', header: 'Value', width: 50 },
        ],
        data: [
          { field: 'Worker ID', value: output.highlight(result.workerId) },
          { field: 'Trigger', value: result.trigger },
          { field: 'Context', value: result.context },
          { field: 'Priority', value: result.priority },
          { field: 'Description', value: result.config.description },
          { field: 'Est. Duration', value: result.config.estimatedDuration },
          { field: 'Capabilities', value: result.config.capabilities.join(', ') },
          { field: 'Status', value: result.status === 'dispatched' ? output.highlight('dispatched (background)') : output.success('completed') },
        ],
      });

      if (background) {
        output.writeln();
        output.writeln(output.dim(`Check status: claude-flow hooks worker status --id ${result.workerId}`));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Worker dispatch failed');
      if (error instanceof MCPClientError) {
        output.printError(`Dispatch error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerStatusCommand: Command = {
  name: 'status',
  description: 'Get status of workers',
  options: [
    { name: 'id', type: 'string', description: 'Specific worker ID to check' },
    { name: 'all', short: 'a', type: 'boolean', description: 'Include completed workers' },
  ],
  examples: [
    { command: 'claude-flow hooks worker status', description: 'Show running workers' },
    { command: 'claude-flow hooks worker status --id worker_audit_1', description: 'Check specific worker' },
    { command: 'claude-flow hooks worker status --all', description: 'Include completed workers' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerId = ctx.flags['id'] as string;
    const includeCompleted = ctx.flags['all'] as boolean;

    const spinner = output.createSpinner({ text: 'Checking worker status...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        worker?: {
          id: string;
          trigger: string;
          context: string;
          status: string;
          progress: number;
          phase: string;
          duration: number;
        };
        workers?: Array<{
          id: string;
          trigger: string;
          status: string;
          progress: number;
          phase: string;
          duration: number;
        }>;
        summary?: {
          total: number;
          running: number;
          completed: number;
          failed: number;
        };
        error?: string;
      }>('hooks_worker-status', {
        workerId,
        includeCompleted,
      });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed('Status retrieved');

      if (result.worker) {
        output.writeln();
        output.writeln(output.bold(`Worker: ${result.worker.id}`));
        output.printTable({
          columns: [
            { key: 'field', header: 'Field', width: 15 },
            { key: 'value', header: 'Value', width: 40 },
          ],
          data: [
            { field: 'Trigger', value: result.worker.trigger },
            { field: 'Context', value: result.worker.context },
            { field: 'Status', value: formatWorkerStatus(result.worker.status) },
            { field: 'Progress', value: `${result.worker.progress}%` },
            { field: 'Phase', value: result.worker.phase },
            { field: 'Duration', value: `${result.worker.duration}ms` },
          ],
        });
      } else if (result.workers && result.workers.length > 0) {
        output.writeln();
        output.writeln(output.bold('Active Workers'));
        output.printTable({
          columns: [
            { key: 'id', header: 'Worker ID', width: 35 },
            { key: 'trigger', header: 'Type', width: 12 },
            { key: 'status', header: 'Status', width: 12 },
            { key: 'progress', header: 'Progress', width: 10 },
            { key: 'duration', header: 'Duration', width: 12 },
          ],
          data: result.workers.map(w => ({
            id: w.id,
            trigger: w.trigger,
            status: formatWorkerStatus(w.status),
            progress: `${w.progress}%`,
            duration: `${w.duration}ms`,
          })),
        });

        if (result.summary) {
          output.writeln();
          output.writeln(`Total: ${result.summary.total} | Running: ${output.highlight(String(result.summary.running))} | Completed: ${output.success(String(result.summary.completed))} | Failed: ${output.error(String(result.summary.failed))}`);
        }
      } else {
        output.writeln();
        output.writeln(output.dim('No active workers'));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Status check failed');
      if (error instanceof MCPClientError) {
        output.printError(`Status error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerDetectCommand: Command = {
  name: 'detect',
  description: 'Detect worker triggers from prompt text',
  options: [
    { name: 'prompt', short: 'p', type: 'string', description: 'Prompt text to analyze', required: true },
    { name: 'auto-dispatch', short: 'a', type: 'boolean', description: 'Automatically dispatch detected workers' },
    { name: 'min-confidence', short: 'm', type: 'string', description: 'Minimum confidence threshold (0-1)' },
  ],
  examples: [
    { command: 'claude-flow hooks worker detect -p "optimize performance"', description: 'Detect triggers in prompt' },
    { command: 'claude-flow hooks worker detect -p "security audit" --auto-dispatch', description: 'Detect and dispatch' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const prompt = ctx.flags['prompt'] as string;
    const autoDispatch = ctx.flags['auto-dispatch'] as boolean;
    const minConfidence = parseFloat(ctx.flags['min-confidence'] as string || '0.5');

    if (!prompt) {
      output.printError('--prompt is required');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: 'Analyzing prompt...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        prompt: string;
        detection: {
          detected: boolean;
          triggers: string[];
          confidence: number;
          context: string;
        };
        triggersFound: number;
        triggerDetails?: Array<{
          trigger: string;
          description: string;
          priority: string;
        }>;
        autoDispatched?: boolean;
        workerIds?: string[];
      }>('hooks_worker-detect', {
        prompt,
        autoDispatch,
        minConfidence,
      });

      if (result.detection.detected) {
        spinner.succeed(`Detected ${result.triggersFound} worker trigger(s)`);
      } else {
        spinner.succeed('No worker triggers detected');
      }

      output.writeln();
      output.writeln(output.bold('Detection Results'));
      output.writeln(`Prompt: ${output.dim(result.prompt)}`);
      output.writeln(`Confidence: ${(result.detection.confidence * 100).toFixed(0)}%`);

      if (result.triggerDetails && result.triggerDetails.length > 0) {
        output.writeln();
        output.printTable({
          columns: [
            { key: 'trigger', header: 'Trigger', width: 14 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'description', header: 'Description', width: 45 },
          ],
          data: result.triggerDetails.map(t => ({
            trigger: output.highlight(t.trigger),
            priority: t.priority,
            description: t.description,
          })),
        });
      }

      if (result.autoDispatched && result.workerIds) {
        output.writeln();
        output.writeln(output.success('Workers auto-dispatched:'));
        result.workerIds.forEach(id => {
          output.writeln(`  - ${id}`);
        });
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Detection failed');
      if (error instanceof MCPClientError) {
        output.printError(`Detection error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

const workerCancelCommand: Command = {
  name: 'cancel',
  description: 'Cancel a running worker',
  options: [
    { name: 'id', type: 'string', description: 'Worker ID to cancel', required: true },
  ],
  examples: [
    { command: 'claude-flow hooks worker cancel --id worker_audit_1', description: 'Cancel specific worker' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerId = ctx.flags['id'] as string;

    if (!workerId) {
      output.printError('--id is required');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Cancelling worker ${workerId}...`, spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        success: boolean;
        workerId: string;
        cancelled: boolean;
        error?: string;
      }>('hooks_worker-cancel', { workerId });

      if (!result.success) {
        spinner.fail(`Failed: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      spinner.succeed(`Worker ${workerId} cancelled`);
      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Cancel failed');
      if (error instanceof MCPClientError) {
        output.printError(`Cancel error: ${error.message}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

function formatWorkerStatus(status: string): string {
  switch (status) {
    case 'running':
      return output.highlight(status);
    case 'completed':
      return output.success(status);
    case 'failed':
      return output.error(status);
    case 'pending':
      return output.dim(status);
    default:
      return status;
  }
}

export const workerCommand: Command = {
  name: 'worker',
  description: 'Background worker management (12 workers for analysis/optimization)',
  subcommands: [
    workerListCommand,
    workerDispatchCommand,
    workerStatusCommand,
    workerDetectCommand,
    workerCancelCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow hooks worker list', description: 'List all workers' },
    { command: 'claude-flow hooks worker dispatch -t optimize', description: 'Dispatch optimizer' },
    { command: 'claude-flow hooks worker detect -p "test coverage"', description: 'Detect from prompt' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Background Worker System (12 Workers)'));
    output.writeln();
    output.writeln('Manage and dispatch background workers for analysis and optimization tasks.');
    output.writeln();
    output.writeln('Available Workers:');
    output.printList([
      `${output.highlight('ultralearn')}   - Deep knowledge acquisition`,
      `${output.highlight('optimize')}     - Performance optimization`,
      `${output.highlight('consolidate')} - Memory consolidation`,
      `${output.highlight('predict')}      - Predictive preloading`,
      `${output.highlight('audit')}        - Security analysis (critical)`,
      `${output.highlight('map')}          - Codebase mapping`,
      `${output.highlight('preload')}      - Resource preloading`,
      `${output.highlight('deepdive')}     - Deep code analysis`,
      `${output.highlight('document')}     - Auto-documentation`,
      `${output.highlight('refactor')}     - Refactoring suggestions`,
      `${output.highlight('benchmark')}    - Performance benchmarks`,
      `${output.highlight('testgaps')}     - Test coverage analysis`,
    ]);
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}     - List all workers with capabilities`,
      `${output.highlight('dispatch')} - Dispatch a worker`,
      `${output.highlight('status')}   - Check worker status`,
      `${output.highlight('detect')}   - Detect triggers from prompt`,
      `${output.highlight('cancel')}   - Cancel a running worker`,
    ]);
    output.writeln();
    output.writeln('Run "claude-flow hooks worker <subcommand> --help" for details');

    return { success: true };
  }
};
