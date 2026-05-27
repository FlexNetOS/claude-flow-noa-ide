/**
 * MCP Tool Types for CLI
 *
 * Local type definitions to avoid external imports outside package boundary.
 */

export interface MCPToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Returns the effective project working directory.
 * Prefers project-scoped env vars exposed by the host runtime over the
 * installer fallback `CLAUDE_FLOW_CWD`, so globally registered MCP servers can
 * still isolate state per project when the host provides that context.
 */
export function getProjectCwd(): string {
  // Prefer project-scoped env vars (highest priority)
  if (process.env.CLAUDE_FLOW_PROJECT_DIR) return process.env.CLAUDE_FLOW_PROJECT_DIR;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (process.env.INIT_CWD) return process.env.INIT_CWD;
  // CLAUDE_FLOW_CWD is set by the install script; filter out '/' and $HOME which indicate
  // a global/MCP install context where no project has been set yet.
  const envCwd = process.env.CLAUDE_FLOW_CWD;
  if (envCwd && envCwd !== '/' && envCwd !== process.env.HOME) {
    return envCwd;
  }
  return process.cwd();
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
  category?: string;
  tags?: string[];
  version?: string;
  cacheable?: boolean;
  cacheTTL?: number;
  handler: (input: Record<string, unknown>, context?: Record<string, unknown>) => Promise<MCPToolResult | unknown>;
}
