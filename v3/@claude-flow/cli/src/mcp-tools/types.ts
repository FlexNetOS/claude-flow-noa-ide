/**
 * MCP Tool Types — re-export shim (ADR-100, alpha.5).
 *
 * Authoritative source: @claude-flow/cli-core/mcp-tools/types. Was a 46-line
 * byte-identical copy. Re-exports MCPTool, MCPToolInputSchema, MCPToolResult.
 */

export * from '@claude-flow/cli-core/mcp-tools/types';
<<<<<<< HEAD

/**
 * Returns the effective project working directory.
 * Prefers project-scoped env vars exposed by the host runtime over the
 * installer fallback `CLAUDE_FLOW_CWD`, so globally registered MCP servers can
 * still isolate state per project when the host provides that context.
 */
export function getProjectCwd(): string {
  if (process.env.CLAUDE_FLOW_PROJECT_DIR) return process.env.CLAUDE_FLOW_PROJECT_DIR;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (process.env.INIT_CWD) return process.env.INIT_CWD;
  const envCwd = process.env.CLAUDE_FLOW_CWD;
  if (envCwd && envCwd !== '/' && envCwd !== process.env.HOME) {
    return envCwd;
  }
  return process.cwd();
}
=======
>>>>>>> pr-1936-head
