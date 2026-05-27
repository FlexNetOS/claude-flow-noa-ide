/**
 * `swarmops cache` — Anthropic prompt-cache observability.
 *
 * Reads the rolling-100 cache stats file written by agent-execute-core.ts
 * (.claude-flow/cache-stats.json) and prints aggregate + per-call hit ratios.
 *
 * Why this matters: SwarmOps now shapes every Anthropic Messages call into
 * 3 cache breakpoints (tools / system / project context). Anthropic returns
 * `cache_read_input_tokens` and `cache_creation_input_tokens` in every
 * `usage` payload — we persist them so the operator can see whether the
 * cache is actually warming up. Healthy agent loops should hit >80% read
 * ratio after the first call. See PROMPT-CACHE-result.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

interface CacheStatsRecord {
  ts: string;
  model: string;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rawInputTokens: number;
  hitRatio: number;
}

interface CacheStatsFile {
  version: string;
  recent: CacheStatsRecord[];
}

function loadStats(cwd: string): CacheStatsFile | null {
  const p = join(cwd, '.claude-flow', 'cache-stats.json');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as CacheStatsFile;
    if (!data || !Array.isArray(data.recent)) return null;
    return data;
  } catch {
    return null;
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Format token counts with thousands separators for legibility. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export const cacheCommand: Command = {
  name: 'cache-stats',
  description: 'Report Anthropic prompt-cache hit ratio for recent agent dispatches',
  aliases: ['cache'],
  options: [
    {
      name: 'json',
      description: 'Emit raw JSON rather than the human-readable table',
      type: 'boolean',
      default: false,
    },
    {
      name: 'last',
      short: 'n',
      description: 'Limit to the last N records (default: all 100)',
      type: 'number',
      default: 100,
    },
  ],
  examples: [
    { command: 'swarmops cache-stats', description: 'Print rolling-100 cache hit ratio' },
    { command: 'swarmops cache-stats --json', description: 'Emit raw stats for scripting' },
    { command: 'swarmops cache-stats -n 20', description: 'Last 20 dispatches only' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const wantJson = ctx.flags.json === true;
    const limit = Math.max(1, Math.min(100, Number(ctx.flags.last) || 100));
    const stats = loadStats(ctx.cwd);

    if (!stats || stats.recent.length === 0) {
      if (wantJson) {
        output.writeln(JSON.stringify({ records: 0, message: 'no cache stats yet' }));
        return { success: true, exitCode: 0 };
      }
      output.writeln();
      output.writeln(output.warning('No cache stats recorded yet.'));
      output.writeln('Cache stats are written after each agent_execute / callAnthropicMessages call.');
      output.writeln('Run an agent dispatch first, then re-run this command.');
      output.writeln();
      return { success: true, exitCode: 0 };
    }

    const slice = stats.recent.slice(0, limit);
    const totalRead = slice.reduce((a, r) => a + r.cacheReadTokens, 0);
    const totalWrite = slice.reduce((a, r) => a + r.cacheCreationTokens, 0);
    const totalRaw = slice.reduce((a, r) => a + r.rawInputTokens, 0);
    const denom = totalRead + totalWrite + totalRaw;
    const aggRatio = denom > 0 ? totalRead / denom : 0;

    if (wantJson) {
      output.writeln(JSON.stringify({
        records: slice.length,
        aggregate: {
          cacheReadTokens: totalRead,
          cacheCreationTokens: totalWrite,
          rawInputTokens: totalRaw,
          hitRatio: aggRatio,
        },
        recent: slice,
      }, null, 2));
      return { success: true, exitCode: 0 };
    }

    output.writeln();
    output.writeln(output.bold('Anthropic Prompt-Cache Stats'));
    output.writeln(`Window: last ${slice.length} dispatch(es)`);
    output.writeln();
    output.writeln(`  Cache reads:      ${fmt(totalRead).padStart(12)} tokens`);
    output.writeln(`  Cache writes:     ${fmt(totalWrite).padStart(12)} tokens`);
    output.writeln(`  Raw input:        ${fmt(totalRaw).padStart(12)} tokens`);
    output.writeln(`  Aggregate ratio:  ${pct(aggRatio).padStart(12)}`);
    output.writeln();

    // Per-call table: ts (short), model, ratio, breakdown
    output.writeln(output.bold('Recent dispatches (newest first)'));
    output.writeln('  time(UTC)            model                              read    write     raw   ratio');
    output.writeln('  -------------------  ---------------------------------  ------  ------  ------  ------');
    for (const r of slice) {
      const t = r.ts.slice(0, 19).replace('T', ' ');
      const m = r.model.length > 33 ? r.model.slice(0, 30) + '...' : r.model.padEnd(33);
      output.writeln(
        `  ${t}  ${m}  ${fmt(r.cacheReadTokens).padStart(6)}  ${fmt(r.cacheCreationTokens).padStart(6)}  ${fmt(r.rawInputTokens).padStart(6)}  ${pct(r.hitRatio).padStart(6)}`,
      );
    }
    output.writeln();

    // Tip: warm-loop guidance
    if (aggRatio < 0.5 && slice.length >= 5) {
      output.writeln(output.warning(
        'Hit ratio below 50% over the last ' + slice.length + ' calls.',
      ));
      output.writeln('Possible causes:');
      output.writeln('  - System prompts vary across dispatches (timestamps, IDs in cached portion)');
      output.writeln('  - CLAUDE.md regenerated between calls (busts breakpoint 3)');
      output.writeln('  - First-of-session calls are expected to miss; warm up with 2-4 dispatches');
      output.writeln('  - Cached segments below 1024 tokens (Sonnet) / 2048 (Haiku) silently no-op');
    } else if (aggRatio >= 0.8) {
      output.writeln(output.success('Cache is warm — hit ratio above 80%. Token cost cut is active.'));
    }
    output.writeln();

    return { success: true, exitCode: 0 };
  },
};
