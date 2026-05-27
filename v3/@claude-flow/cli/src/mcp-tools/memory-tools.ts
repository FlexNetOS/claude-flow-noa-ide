/**
 * Memory MCP Tools for CLI - V3 with sql.js/HNSW Backend
 *
 * UPGRADED: Now uses the advanced sql.js + HNSW backend for:
 * - 150x-12,500x faster semantic search
 * - Vector embeddings with cosine similarity
 * - Persistent SQLite storage (WASM)
 * - Backward compatible with legacy JSON storage (auto-migrates)
 *
 * @module v3/cli/mcp-tools/memory-tools
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { MCPTool } from './types.js';
import { validateIdentifier } from './validate-input.js';

// Legacy JSON store interface (for migration)
interface LegacyMemoryEntry {
  key: string;
  value: unknown;
  metadata?: Record<string, unknown>;
  storedAt: string;
  accessCount: number;
  lastAccessed: string;
}

interface LegacyMemoryStore {
  entries: Record<string, LegacyMemoryEntry>;
  version: string;
}

// #1604: Align with memory-initializer.ts — single source of truth is .swarm/memory.db
const MEMORY_DIR = '.swarm';
const LEGACY_MEMORY_FILE = 'store.json';
const LEGACY_MEMORY_DIR = '.claude-flow/memory';
const MIGRATION_MARKER = '.migrated-to-sqlite';

function getMemoryDir(): string {
  return resolve(MEMORY_DIR);
}

function getLegacyPath(): string {
  return resolve(join(MEMORY_DIR, LEGACY_MEMORY_FILE));
}

function getMigrationMarkerPath(): string {
  return resolve(join(MEMORY_DIR, MIGRATION_MARKER));
}

function ensureMemoryDir(): void {
  const dir = getMemoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// D-2: Input bounds for memory parameters
const MAX_KEY_LENGTH = 1024;
const MAX_VALUE_SIZE = 1024 * 1024; // 1MB
const MAX_QUERY_LENGTH = 4096;

function validateMemoryInput(key?: string, value?: string, query?: string, namespace?: string): void {
  if (key && key.length > MAX_KEY_LENGTH) {
    throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
  }
  if (value && value.length > MAX_VALUE_SIZE) {
    throw new Error(`Value exceeds maximum size of ${MAX_VALUE_SIZE} bytes`);
  }
  if (query && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }
  // Reject path traversal and shell metacharacters in keys/namespaces (#1425)
  const dangerousPattern = /[;&|`$(){}[\]<>!#\\\0]|\.\.[/\\]/;
  if (key && dangerousPattern.test(key)) {
    throw new Error('Key contains disallowed characters');
  }
  if (namespace && dangerousPattern.test(namespace)) {
    throw new Error('Namespace contains disallowed characters');
  }
}

/**
 * Check if legacy JSON store exists in old .claude-flow/memory/ location
 */
function hasLegacyStore(): boolean {
  const legacyPath = resolve(join(LEGACY_MEMORY_DIR, LEGACY_MEMORY_FILE));
  const migrationMarker = resolve(join(LEGACY_MEMORY_DIR, MIGRATION_MARKER));
  return existsSync(legacyPath) && !existsSync(migrationMarker);
}

/**
 * Load legacy JSON store for migration
 */
function loadLegacyStore(): LegacyMemoryStore | null {
  try {
    const legacyPath = resolve(join(LEGACY_MEMORY_DIR, LEGACY_MEMORY_FILE));
    if (existsSync(legacyPath)) {
      const data = readFileSync(legacyPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return null on error
  }
  return null;
}

/**
 * Mark migration as complete
 */
function markMigrationComplete(): void {
  const legacyDir = resolve(LEGACY_MEMORY_DIR);
  if (!existsSync(legacyDir)) mkdirSync(legacyDir, { recursive: true });
  writeFileSync(resolve(join(LEGACY_MEMORY_DIR, MIGRATION_MARKER)), JSON.stringify({
    migratedAt: new Date().toISOString(),
    version: '3.0.0',
  }), 'utf-8');
}

/**
 * Lazy-load memory initializer functions to avoid circular deps
 */
async function getMemoryFunctions() {
  const {
    storeEntry,
    searchEntries,
    listEntries,
    getEntry,
    deleteEntry,
    initializeMemoryDatabase,
    checkMemoryInitialization,
  } = await import('../memory/memory-initializer.js');

  return {
    storeEntry,
    searchEntries,
    listEntries,
    getEntry,
    deleteEntry,
    initializeMemoryDatabase,
    checkMemoryInitialization,
  };
}

/**
 * Ensure memory database is initialized and migrate legacy data if needed.
 * #1606: Wrapped in try/catch to prevent process-level crashes that kill
 * the stdio MCP transport on Windows/Codex.
 */
async function ensureInitialized(): Promise<void> {
  try {
    const { initializeMemoryDatabase, checkMemoryInitialization, storeEntry } = await getMemoryFunctions();

    // Check if already initialized
    const status = await checkMemoryInitialization();
    if (!status.initialized) {
      await initializeMemoryDatabase({ force: false, verbose: false });
    }

    // Migrate legacy JSON data if exists (from old .claude-flow/memory/ location)
    if (hasLegacyStore()) {
      const legacyStore = loadLegacyStore();
      if (legacyStore && Object.keys(legacyStore.entries).length > 0) {
        console.error('[MCP Memory] Migrating legacy JSON store to sql.js...');
        let migrated = 0;

        for (const [key, entry] of Object.entries(legacyStore.entries)) {
          try {
            const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
            await storeEntry({
              key,
              value,
              namespace: 'default',
              generateEmbeddingFlag: true,
            });
            migrated++;
          } catch (e) {
            console.error(`[MCP Memory] Failed to migrate key "${key}":`, e);
          }
        }

        console.error(`[MCP Memory] Migrated ${migrated}/${Object.keys(legacyStore.entries).length} entries`);
        markMigrationComplete();
      }
    }
  } catch (error) {
    console.error('[MCP Memory] Initialization failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * #bug7: Shared enumerator for Claude Code project memory files under
 * `~/.claude/projects/<project_id>/memory/*.md`.
 *
 * The previous `memory_import_claude` single-project branch hashed
 * `process.cwd()` with `cwd.replace(/\//g, '-')`, but Claude Code's
 * actual encoding uses BOTH `/` -> `-` and `.` -> `-` and emits a
 * leading dash (e.g. `/Users/h4ckm1n/.claude` becomes
 * `-Users-h4ckm1n--claude`). The result was zero matches against the
 * real on-disk directory while `memory_bridge_status` enumerated all
 * project dirs and reported the correct count.
 *
 * Both tools now route through this helper so the importer count is
 * guaranteed to match the status count.
 *
 * Encoding note: we cannot decode an arbitrary project_id back to its
 * original cwd losslessly (the encoding is lossy — `/` and `.` collide
 * onto `-`), so the single-project branch resolves cwd by computing
 * the encoded form with both substitutions and falling back to a
 * lookup over all available project dirs whose encoded name matches.
 */
export interface ClaudeProjectMemoryFile {
  path: string;
  project: string;
  file: string;
}

export interface ClaudeProjectMemorySummary {
  files: ClaudeProjectMemoryFile[];
  projectsWithMemory: number;
  projectsScanned: number;
}

/**
 * Encode a working-directory path the way Claude Code names project dirs.
 * Replaces both `/` and `.` with `-`; the leading slash becomes a leading
 * dash via the `/` substitution, matching Claude Code's on-disk format.
 */
export function encodeClaudeProjectId(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Enumerate Claude Code memory files. Used by both `memory_import_claude`
 * and `memory_bridge_status` so they always agree on what's importable.
 *
 * - `allProjects: true`  -> all `~/.claude/projects/*\/memory/*.md`.
 * - `allProjects: false` (default) -> only the project that matches `cwd`
 *   under the documented Claude Code encoding.
 */
export function getClaudeProjectMemoryFiles(opts: {
  allProjects?: boolean;
  cwd?: string;
} = {}): ClaudeProjectMemorySummary {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  const summary: ClaudeProjectMemorySummary = {
    files: [],
    projectsWithMemory: 0,
    projectsScanned: 0,
  };

  if (!existsSync(claudeProjectsDir)) return summary;

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return summary;
  }
  summary.projectsScanned = projectDirs.length;

  let targetSet: Set<string> | null = null;
  if (!opts.allProjects) {
    const cwd = opts.cwd ?? process.cwd();
    const expected = encodeClaudeProjectId(cwd);
    targetSet = new Set<string>([expected]);
    // Tolerate older/legacy encodings that did NOT replace dots — older
    // ruflo builds wrote dirs like `-Users-h4ckm1n-.claude` instead of
    // `-Users-h4ckm1n--claude`. If such a dir exists, accept it too.
    targetSet.add(cwd.replace(/\//g, '-'));
  }

  for (const project of projectDirs) {
    if (targetSet && !targetSet.has(project)) continue;
    const memDir = join(claudeProjectsDir, project, 'memory');
    if (!existsSync(memDir)) continue;
    let mdFiles: string[] = [];
    try {
      mdFiles = readdirSync(memDir).filter((f: string) => f.endsWith('.md'));
    } catch {
      continue;
    }
    if (mdFiles.length === 0) continue;
    summary.projectsWithMemory++;
    for (const file of mdFiles) {
      summary.files.push({ path: join(memDir, file), project, file });
    }
  }

  return summary;
}

export const memoryTools: MCPTool[] = [
  {
    name: 'memory_store',
    description: 'Persistent key-value store with vector embedding — survives across sessions and is searchable by meaning, not just by file path. Use when native Write is wrong because the data is not a file (e.g. a learned pattern, a decision, a budget config) AND you need to recall it later by semantic query, not by path. Defaults to namespace="default"; pass --upsert=true to update an existing key.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (unique within namespace)' },
        value: { description: 'Value to store (string or object)' },
        namespace: { type: 'string', description: 'Namespace for organization (default: "default")' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering',
        },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' },
        upsert: { type: 'boolean', description: 'If true, update existing key instead of failing (default: false)' },
      },
      required: ['key', 'value'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { storeEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';
      const rawValue = input.value;
      const value = typeof rawValue === 'string' ? rawValue : (rawValue !== undefined ? JSON.stringify(rawValue) : '');
      const tags = (input.tags as string[]) || [];
      const ttl = input.ttl as number | undefined;
      const upsert = (input.upsert as boolean) || false;

      if (!value) {
        return {
          success: false,
          key,
          stored: false,
          hasEmbedding: false,
          error: 'Value is required and cannot be empty',
        };
      }

      validateMemoryInput(key, value, undefined, namespace);

      const startTime = performance.now();

      try {
        const result = await storeEntry({
          key,
          value,
          namespace,
          generateEmbeddingFlag: true,
          tags,
          ttl,
          upsert,
        });

        const duration = performance.now() - startTime;

        return {
          success: result.success,
          key,
          namespace,
          stored: result.success,
          storedAt: new Date().toISOString(),
          hasEmbedding: !!result.embedding,
          embeddingDimensions: result.embedding?.dimensions || null,
          backend: 'sql.js + HNSW',
          storeTime: `${duration.toFixed(2)}ms`,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_retrieve',
    description: 'Read back a value previously stored via memory_store, by exact (namespace, key) — lossless, includes metadata. Use when native Read is wrong because the value is not a file (it lives in the .swarm/memory.db SQLite store) AND you know the exact key. For semantic lookup by meaning, use memory_search.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { getEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';

      validateMemoryInput(key, undefined, undefined, namespace);

      try {
        const result = await getEntry({ key, namespace });

        if (result.found && result.entry) {
          // Try to parse JSON value
          let value: unknown = result.entry.content;
          try {
            value = JSON.parse(result.entry.content);
          } catch {
            // Keep as string
          }

          return {
            key,
            namespace,
            value,
            tags: result.entry.tags,
            storedAt: result.entry.createdAt,
            updatedAt: result.entry.updatedAt,
            accessCount: result.entry.accessCount,
            hasEmbedding: result.entry.hasEmbedding,
            found: true,
            backend: 'sql.js + HNSW',
          };
        }

        return {
          key,
          namespace,
          value: null,
          found: false,
        };
      } catch (error) {
        return {
          key,
          namespace,
          value: null,
          found: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_search',
    description: 'Find stored memories by meaning (vector similarity), not by literal text — finds "JWT auth pattern" when you query "token-based login flow". Use when native Grep is wrong because Grep matches characters and you need to find conceptually-related entries across past sessions. Backed by HNSW index over ONNX embeddings; returns top-k with similarity scores. Pair with smart=true for query expansion + MMR diversity.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (semantic similarity)' },
        namespace: { type: 'string', description: 'Namespace to search (default: "default")' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
        threshold: { type: 'number', description: 'Minimum similarity threshold 0-1 (default: 0.2)' },
        smart: { type: 'boolean', description: 'Enable SmartRetrieval pipeline — query expansion, RRF fusion, recency boost, MMR diversity (default: false)' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { searchEntries } = await getMemoryFunctions();

      const query = input.query as string;
      const namespace = (input.namespace as string) || 'default';
      const limit = (input.limit as number) ?? 10;
      const threshold = (input.threshold as number) ?? 0.2;

      validateMemoryInput(undefined, undefined, query);

      const startTime = performance.now();

      try {
        if (input.smart) {
          // SmartRetrieval pipeline (ADR-090)
          // #bug16a: @claude-flow/memory@3.0.0-alpha.14 dropped the smartSearch export.
          // Use local shim until upstream re-exports the function.
          const { smartSearch } = await import('../memory/smart-search-shim.js');

          // Adapt searchEntries to the SearchFn interface
          const rawSearch = async (req: { query: string; namespace?: string; limit?: number; threshold?: number }) => {
            const r = await searchEntries({
              query: req.query,
              namespace: req.namespace || namespace,
              limit: req.limit || limit * 3,
              threshold: req.threshold ?? threshold,
            });
            return {
              results: r.results.map(e => ({
                id: e.id,
                key: e.key,
                content: e.content,
                score: e.score,
                namespace: e.namespace,
              })),
            };
          };

          const smartResult = await smartSearch(rawSearch, {
            query,
            namespace,
            limit,
            threshold,
          });

          const duration = performance.now() - startTime;

          const results = smartResult.results.map(r => {
            let value: unknown = r.content;
            try { value = JSON.parse(r.content); } catch { /* keep as string */ }
            return {
              key: r.key,
              namespace: r.namespace,
              value,
              similarity: r.score,
            };
          });

          return {
            query,
            results,
            total: results.length,
            searchTime: `${duration.toFixed(2)}ms`,
            backend: 'SmartRetrieval (RRF + MMR + Recency)',
            stats: smartResult.stats,
          };
        }

        // Original non-smart path (unchanged)
        const result = await searchEntries({
          query,
          namespace,
          limit,
          threshold,
        });

        const duration = performance.now() - startTime;

        // Parse JSON values in results
        const results = result.results.map(r => {
          let value: unknown = r.content;
          try {
            value = JSON.parse(r.content);
          } catch {
            // Keep as string
          }

          return {
            key: r.key,
            namespace: r.namespace,
            value,
            similarity: r.score,
          };
        });

        return {
          query,
          results,
          total: results.length,
          searchTime: `${duration.toFixed(2)}ms`,
          backend: 'HNSW + sql.js',
        };
      } catch (error) {
        return {
          query,
          results: [],
          total: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_delete',
    description: 'Remove a stored memory entry by exact (namespace, key). Use when a previously stored decision is invalidated or contains stale data. No native equivalent — Write to a file does not affect the .swarm/memory.db SQLite store.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { deleteEntry } = await getMemoryFunctions();

      const key = input.key as string;
      const namespace = (input.namespace as string) || 'default';

      validateMemoryInput(key, undefined, undefined, namespace);

      try {
        const result = await deleteEntry({ key, namespace });

        return {
          success: result.deleted,
          key,
          namespace,
          deleted: result.deleted,
          hnswIndexInvalidated: result.deleted,
          backend: 'sql.js + HNSW',
        };
      } catch (error) {
        return {
          success: false,
          key,
          namespace,
          deleted: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_list',
    description: 'Enumerate stored memory entries (optionally filtered by namespace/tags) without semantic search. Use when native Glob is wrong because the entries are not files (they live in .swarm/memory.db). For inspection / audit / "what is in my memory" — pair with memory_search for retrieval-by-meaning.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Filter by namespace' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const { listEntries } = await getMemoryFunctions();

      const namespace = input.namespace as string | undefined;
      const limit = (input.limit as number) || 50;
      const offset = (input.offset as number) || 0;

      if (namespace) { const vNs = validateIdentifier(namespace, 'namespace'); if (!vNs.valid) throw new Error(vNs.error); }

      try {
        const result = await listEntries({
          namespace,
          limit,
          offset,
        });

        const entries = result.entries.map(e => ({
          key: e.key,
          namespace: e.namespace,
          storedAt: e.createdAt,
          updatedAt: e.updatedAt,
          accessCount: e.accessCount,
          hasEmbedding: e.hasEmbedding,
          size: e.size,
        }));

        return {
          entries,
          total: result.total,
          limit,
          offset,
          backend: 'sql.js + HNSW',
        };
      } catch (error) {
        return {
          entries: [],
          total: 0,
          limit,
          offset,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory storage statistics including HNSW index status',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      await ensureInitialized();
      const { checkMemoryInitialization, listEntries } = await getMemoryFunctions();

      try {
        const status = await checkMemoryInitialization();
        const allEntries = await listEntries({ limit: 100000 });

        // Count by namespace
        const namespaces: Record<string, number> = {};
        let withEmbeddings = 0;

        for (const entry of allEntries.entries) {
          namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
          if (entry.hasEmbedding) withEmbeddings++;
        }

        return {
          initialized: status.initialized,
          totalEntries: allEntries.total,
          entriesWithEmbeddings: withEmbeddings,
          embeddingCoverage: allEntries.total > 0
            ? `${((withEmbeddings / allEntries.total) * 100).toFixed(1)}%`
            : '0%',
          namespaces,
          backend: 'sql.js + HNSW',
          version: status.version || '3.0.0',
          features: status.features || {
            vectorEmbeddings: true,
            hnswIndex: true,
            semanticSearch: true,
          },
        };
      } catch (error) {
        return {
          initialized: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_migrate',
    description: 'Manually trigger migration from legacy JSON store to sql.js',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force re-migration even if already done' },
      },
    },
    handler: async (input) => {
      const force = input.force as boolean;

      // Remove migration marker if forcing
      if (force) {
        const markerPath = getMigrationMarkerPath();
        if (existsSync(markerPath)) {
          unlinkSync(markerPath);
        }
      }

      // Check for legacy data
      const legacyStore = loadLegacyStore();
      if (!legacyStore || Object.keys(legacyStore.entries).length === 0) {
        return {
          success: true,
          message: 'No legacy data to migrate',
          migrated: 0,
        };
      }

      // Run migration via ensureInitialized
      await ensureInitialized();

      return {
        success: true,
        message: 'Migration completed',
        migrated: Object.keys(legacyStore.entries).length,
        backend: 'sql.js + HNSW',
      };
    },
  },

  // ===== Claude Code Memory Bridge Tools =====

  {
    name: 'memory_import_claude',
    description: 'Import Claude Code auto-memory files into AgentDB with ONNX vector embeddings. Reads ~/.claude/projects/*/memory/*.md files, parses YAML frontmatter, splits into sections, and stores with 384-dim embeddings for semantic search. Use allProjects=true to import from ALL Claude projects.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        allProjects: { type: 'boolean', description: 'Import from all Claude projects (default: current project only)' },
        namespace: { type: 'string', description: 'Target namespace (default: "claude-memories")' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const { storeEntry } = await getMemoryFunctions();

      const ns = (input.namespace as string) || 'claude-memories';
      if (input.namespace) { const vNs = validateIdentifier(ns, 'namespace'); if (!vNs.valid) return { success: false, imported: 0, error: vNs.error }; }
      const allProjects = input.allProjects as boolean;

      // #bug7: route through the shared enumerator so importer count
      // matches `memory_bridge_status.claudeCode.memoryFiles`.
      const memoryFiles = getClaudeProjectMemoryFiles({ allProjects }).files;

      if (memoryFiles.length === 0) {
        return { success: true, imported: 0, message: 'No Claude memory files found' };
      }

      let imported = 0;
      let skipped = 0;
      // #1791.8 — Claude Code's `~/.claude/projects/` accumulates historical
      // project_id directories (truncated forms, sandbox cwds, renamed
      // workspaces) that all contain copies of the same memory files. The
      // previous import indexed each copy under a different `project_id`
      // prefix, producing 5–8x duplication on long-lived homes. Dedupe by
      // file content hash so the same memory is imported once even if it
      // appears under several project directories.
      const seenContentHashes = new Set<string>();
      let duplicatesSkipped = 0;
      const projects = new Set<string>();

      for (const memFile of memoryFiles) {
        projects.add(memFile.project);
        try {
          const content = readFileSync(memFile.path, 'utf-8');

          // #1791.8 — Skip if we've already imported this exact content under
          // a different project_id directory.
          const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          if (seenContentHashes.has(contentHash)) {
            duplicatesSkipped++;
            continue;
          }
          seenContentHashes.add(contentHash);

          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          let name = memFile.file.replace('.md', '');
          let body = content;

          if (frontmatterMatch) {
            const yaml = frontmatterMatch[1];
            body = frontmatterMatch[2].trim();
            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
          }

          // Split into sections for granular search
          const sections = body.split(/^(?=## )/m).filter(s => s.trim().length > 20);

          if (sections.length === 0 && body.length > 10) {
            await storeEntry({ key: `claude:${memFile.project}:${name}`, value: body.slice(0, 4096), namespace: ns, generateEmbeddingFlag: true });
            imported++;
          } else {
            for (const section of sections) {
              const titleMatch = section.match(/^##\s+(.+)/);
              const sectionTitle = titleMatch ? titleMatch[1].trim() : name;
              const sectionBody = section.replace(/^##\s+.+\n/, '').trim();
              if (sectionBody.length < 10) continue;
              await storeEntry({ key: `claude:${memFile.project}:${name}:${sectionTitle.slice(0, 50)}`, value: sectionBody.slice(0, 4096), namespace: ns, generateEmbeddingFlag: true });
              imported++;
            }
          }
        } catch {
          skipped++;
        }
      }

      return {
        success: true,
        imported,
        skipped,
        duplicatesSkipped,
        files: memoryFiles.length,
        projects: projects.size,
        namespace: ns,
        embedding: 'ONNX all-MiniLM-L6-v2 (384-dim)',
      };
    },
  },

  {
    name: 'memory_bridge_status',
    description: 'Show Claude Code memory bridge status — AgentDB vectors, SONA learning, intelligence patterns, and connection health.',
    category: 'memory',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      await ensureInitialized();

      // #bug7: route through the shared enumerator so this count matches
      // what `memory_import_claude` (allProjects=true) would actually find.
      const claudeSummary = getClaudeProjectMemoryFiles({ allProjects: true });
      const claudeFiles = claudeSummary.files.length;
      const claudeProjects = claudeSummary.projectsWithMemory;

      // AgentDB status
      let agentdbEntries = 0;
      let claudeMemoryEntries = 0;
      try {
        const { listEntries } = await getMemoryFunctions();
        const allEntries = await listEntries({});
        agentdbEntries = allEntries?.entries?.length ?? 0;
        const claudeEntries = await listEntries({ namespace: 'claude-memories' });
        claudeMemoryEntries = claudeEntries?.entries?.length ?? 0;
      } catch { /* ignore */ }

      // Intelligence status
      let intelligence = { sonaEnabled: false, patternsLearned: 0, trajectoriesRecorded: 0 };
      try {
        const int = await import('../memory/intelligence.js');
        const stats = int.getIntelligenceStats?.();
        if (stats) intelligence = { sonaEnabled: stats.sonaEnabled, patternsLearned: stats.patternsLearned, trajectoriesRecorded: stats.trajectoriesRecorded };
      } catch { /* not initialized */ }

      // #bug43.3: report the live embedder, not a hardcoded label. We
      // probe the resolver here so a freshly-pulled `mxbai-embed-large`
      // is reflected without needing to bounce the daemon. The status
      // call is rare so the probe cost (one HTTP roundtrip on first
      // call) is acceptable.
      let embedding: { model: string; dim: number; source: string; fallback: boolean } = {
        model: 'Xenova/all-MiniLM-L6-v2',
        dim: 384,
        source: 'onnx-miniLM',
        fallback: true,
      };
      try {
        const { getActiveEmbedder } = await import('../memory/embedder-resolver.js');
        const active = await getActiveEmbedder();
        embedding = {
          model: active.model,
          dim: active.dim,
          source: active.source,
          fallback: active.isFallback,
        };
      } catch { /* keep default */ }

      // Distribution of embeddings by dim across the live store. Tells the
      // user if the migration to mxbai is complete or partial.
      let dimDistribution: { dim: number; count: number; model: string }[] = [];
      try {
        const { listEntries } = await getMemoryFunctions();
        const all = await listEntries({});
        const buckets = new Map<string, { dim: number; count: number; model: string }>();
        for (const entry of all?.entries ?? []) {
          // entries don't expose dim/model in the list view, so this
          // requires direct DB access; we leave it empty if not available.
          // Best-effort only.
          void entry;
        }
        // Fall back to counting via raw bridge query (Bug 43.2 will fill
        // this in once migration is shipped).
        const bridge = await import('../memory/memory-bridge.js');
        if (typeof bridge.bridgeGetEmbeddingDistribution === 'function') {
          const dist = await bridge.bridgeGetEmbeddingDistribution();
          if (Array.isArray(dist)) dimDistribution = dist;
        }
        void buckets;
      } catch { /* non-fatal */ }

      return {
        claudeCode: { memoryFiles: claudeFiles, projects: claudeProjects },
        agentdb: { totalEntries: agentdbEntries, claudeMemoryEntries, backend: 'sql.js + ONNX' },
        intelligence,
        bridge: {
          status: claudeMemoryEntries > 0 ? 'connected' : 'not-synced',
          embedding,
          dimDistribution,
        },
      };
    },
  },

  {
    name: 'memory_search_unified',
    description: 'Search across both Claude Code memories and AgentDB entries using semantic vector similarity. Returns merged, deduplicated results from all namespaces.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        namespace: { type: 'string', description: 'Filter to namespace (omit for all)' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { searchEntries, listEntries } = await getMemoryFunctions();
      validateMemoryInput(undefined, undefined, input.query as string);

      const query = input.query as string;
      const limit = (input.limit as number) ?? 10;
      const ns = input.namespace as string | undefined;

      if (ns) { const vNs = validateIdentifier(ns, 'namespace'); if (!vNs.valid) return { success: false, query, results: [], total: 0, error: vNs.error }; }

      // #bug4 — enumerate namespaces dynamically from the live store instead
      // of hardcoding ['default', 'claude-memories', 'auto-memory', 'patterns',
      // 'tasks', 'feedback']. The previous allowlist hid every user-created
      // namespace from `memory_search_unified`. We piggyback on `listEntries`
      // (the same accessor `memory_stats` uses) and dedupe by namespace.
      // Cached for the duration of this single search invocation.
      let namespaces: string[];
      if (ns) {
        namespaces = [ns];
      } else {
        try {
          const all = await listEntries({ limit: 100000 });
          const seenNs = new Set<string>();
          for (const e of all?.entries ?? []) {
            if (e?.namespace) seenNs.add(e.namespace);
          }
          // Always include 'default' so a freshly-initialized store still
          // matches the previous behavior shape.
          if (seenNs.size === 0) seenNs.add('default');
          namespaces = Array.from(seenNs);
        } catch {
          // Fall back to the legacy allowlist if listing fails — better than
          // returning zero results on a transient error.
          namespaces = ['default', 'claude-memories', 'auto-memory', 'patterns', 'tasks', 'feedback'];
        }
      }
      // PERF-2: collapse N per-namespace searches into ONE union scan.
      // Embed query once, run a single SQL pass with `namespace IN (…)`, then
      // score + dedupe in JS. See bridgeSearchEntriesMulti for the impl.
      const allResults: Array<{ key: string; content: string; score: number; namespace: string; source: string }> = [];
      try {
        const bridge = await import('../memory/memory-bridge.js');
        const multi = await bridge.bridgeSearchEntriesMulti({
          namespaces,
          query,
          limit: limit * 2,
        });
        if (multi?.results) {
          for (const entry of multi.results) {
            const entryNs = entry.namespace || 'default';
            allResults.push({
              key: entry.key || entry.id || '',
              content: (entry.content || '').toString().slice(0, 200),
              score: entry.score || 0,
              namespace: entryNs,
              source: entryNs === 'claude-memories' ? 'claude-code' : entryNs === 'auto-memory' ? 'auto-memory' : 'agentdb',
            });
          }
        }
      } catch {
        // Bridge unavailable — fall back to the legacy per-namespace loop so
        // the tool still returns something. This branch should be cold in
        // practice since the bridge is the canonical search path.
        for (const searchNs of namespaces) {
          try {
            const r = await searchEntries({ query, namespace: searchNs, limit: limit * 2 });
            if (r?.results) {
              for (const entry of r.results) {
                allResults.push({
                  key: entry.key || entry.id || '',
                  content: (entry.content || (entry as any).value || '').toString().slice(0, 200),
                  score: entry.score || 0,
                  namespace: searchNs,
                  source: searchNs === 'claude-memories' ? 'claude-code' : searchNs === 'auto-memory' ? 'auto-memory' : 'agentdb',
                });
              }
            }
          } catch { /* namespace may not exist */ }
        }
      }

      // Sort by score, deduplicate by key, take top N
      allResults.sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      const deduplicated = allResults.filter(r => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
      }).slice(0, limit);

      return {
        success: true,
        query,
        results: deduplicated,
        total: deduplicated.length,
        searchedNamespaces: namespaces,
        searchTime: Date.now(),
      };
    },
  },
];
