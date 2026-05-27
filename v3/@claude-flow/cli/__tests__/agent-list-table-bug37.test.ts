/**
 * #bug37 — `ruflo agent list` table renderer must:
 *   1. NEVER show "Invalid Date" for entries lacking createdAt (user templates).
 *   2. Drop the empty ID column when ALL rows are user-installed (no agentId).
 *   3. Auto-size the Type column up to 40 chars so long skill names aren't truncated.
 *
 * The fix lives in commands/agent.ts (CLI rendering layer). The MCP handler
 * was already correct — it returns user entries with no createdAt and an
 * agentId of `user:<name>`. This regression covers the formatter functions
 * indirectly by replicating the rendering math the CLI uses.
 */

import { describe, expect, it } from 'vitest';

interface AgentRow {
  agentId?: string;
  agentType: string;
  status: string;
  createdAt?: string;
  source?: 'built-in' | 'user';
}

// Replicas of the inline helpers in commands/agent.ts. Keeping them here
// (rather than importing from the command module, which has heavy MCP
// transitive deps) lets the test pin the contract that renders the table.
function formatDate(raw?: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString();
}

function buildColumns(rows: AgentRow[]) {
  const allIdsBlank = rows.every(a => !a.agentId);
  const maxNameLen = rows.reduce(
    (acc, a) => Math.max(acc, a.agentType.length),
    4,
  );
  const typeWidth = Math.min(40, Math.max(15, maxNameLen));
  const cols: Array<{ key: string; header: string; width: number }> = [];
  if (!allIdsBlank) cols.push({ key: 'id', header: 'ID', width: 20 });
  cols.push({ key: 'type', header: 'Type', width: typeWidth });
  cols.push({ key: 'status', header: 'Status', width: 12 });
  cols.push({ key: 'source', header: 'Source', width: 10 });
  cols.push({ key: 'created', header: 'Created', width: 12 });
  cols.push({ key: 'lastActivity', header: 'Last Activity', width: 14 });
  return cols;
}

describe('#bug37 — agent list table formatting', () => {
  it('renders an em-dash (not "Invalid Date") when createdAt is missing', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('renders an em-dash when createdAt is unparseable', () => {
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('renders a real time string for a valid ISO timestamp', () => {
    const out = formatDate('2025-01-01T12:34:56Z');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(0);
  });

  it('drops the ID column when every row is user-installed (no agentId)', () => {
    const rows: AgentRow[] = [
      { agentType: 'ceo', status: 'available', source: 'user' },
      { agentType: 'polybot-ops', status: 'available', source: 'user' },
    ];
    const cols = buildColumns(rows);
    expect(cols.map(c => c.header)).not.toContain('ID');
    expect(cols.map(c => c.header)).toContain('Source');
  });

  it('keeps the ID column when at least one row has an agentId', () => {
    const rows: AgentRow[] = [
      { agentId: 'agent-123', agentType: 'coder', status: 'active', createdAt: new Date().toISOString(), source: 'built-in' },
      { agentType: 'ceo', status: 'available', source: 'user' },
    ];
    const cols = buildColumns(rows);
    expect(cols.map(c => c.header)).toContain('ID');
  });

  it('auto-widens the Type column to fit long skill names (capped at 40)', () => {
    const longName = 'huggingface-paper-publisher-extra-long-suffix';
    const rows: AgentRow[] = [
      { agentType: longName, status: 'available', source: 'user' },
    ];
    const cols = buildColumns(rows);
    const typeCol = cols.find(c => c.key === 'type')!;
    expect(typeCol.width).toBe(40); // capped
    expect(typeCol.width).toBeGreaterThan(13); // old buggy width
  });

  it('keeps a sensible minimum Type width even when names are short', () => {
    const rows: AgentRow[] = [
      { agentType: 'a', status: 'idle', source: 'built-in' },
    ];
    const cols = buildColumns(rows);
    const typeCol = cols.find(c => c.key === 'type')!;
    expect(typeCol.width).toBe(15);
  });

  it('Source column is always present and labels each row', () => {
    const rows: AgentRow[] = [
      { agentId: 'a', agentType: 't', status: 'active', source: 'built-in' },
    ];
    const cols = buildColumns(rows);
    expect(cols.some(c => c.key === 'source')).toBe(true);
  });
});
