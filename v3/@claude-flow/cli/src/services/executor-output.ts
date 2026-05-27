/**
 * Executor Output Normalization
 *
 * Both Claude Code and OpenCode produce stdout output, but their formats differ.
 * This module normalizes both into a consistent ExecutorOutput shape so downstream
 * consumers (worker daemon, memory hooks, statusline) are backend-agnostic.
 *
 * Key differences handled:
 * - Claude Code may emit ANSI control sequences; OpenCode uses plain text
 * - Claude Code wraps code in ``` blocks with language tags; OpenCode may not
 * - Tool call interleaving differs between the two CLIs
 * - Exit code semantics: Claude uses 0=success, OpenCode may use non-zero for tool failures
 */

export interface ExecutorOutput {
  text: string
  exitCode: number
  toolCalls?: ToolCallResult[]
  error?: string
}

export interface ToolCallResult {
  tool: string
  input: unknown
  output?: string
  error?: string
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000

/**
 * Remove ANSI escape sequences from raw CLI output.
 */
function stripAnsi(raw: string): string {
  return raw.replace(
    /\x1b\[[0-9;]*[a-zA-Z]/g, ''
  )
}

/**
 * Extract JSON from a raw string. Tries code blocks first, then bare JSON.
 */
function extractJson(raw: string): unknown | undefined {
  try {
    const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeMatch) return JSON.parse(codeMatch[1].trim())
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
    return JSON.parse(raw.trim())
  } catch {
    return undefined
  }
}

/**
 * Strip model-specific preamble lines that Claude Code emits
 * (e.g. "Claude Code v2.1.86", "Model: claude-sonnet-...", etc.)
 */
function stripPreamble(raw: string): string {
  return raw
    .replace(/^(Claude Code|OpenCode|Ruflo)\s+v?[\d.]+.*\n?/im, '')
    .replace(/^Model:\s+.+\n?/im, '')
    .replace(/^Using .+ backend\n?/im, '')
    .trim()
}

/**
 * Truncate output beyond a character limit to prevent runaway memory usage.
 * Appends a truncation note when content is cut.
 */
function truncate(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw
  const half = Math.floor(maxChars / 2)
  const head = raw.slice(0, half)
  const tail = raw.slice(raw.length - half)
  return `${head}\n\n... [truncated ${raw.length - maxChars} chars] ...\n\n${tail}`
}

/**
 * Normalize Claude Code stdout into ExecutorOutput.
 *
 * Claude Code exit codes:
 *   0 = success
 *   1 = general error
 *   2 = tool call error (content still usable)
 *
 * Claude Code stdout may include ANSI escapes, model info preamble,
 * and tool call output interleaved with text.
 */
export function normalizeClaudeOutput(
  raw: string,
  exitCode: number,
  options?: { maxChars?: number }
): ExecutorOutput {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const cleaned = stripPreamble(stripAnsi(raw))
  const text = truncate(cleaned, maxChars)

  // Non-zero exit code = error, but stderr may have more detail
  if (exitCode !== 0) {
    return {
      text: text || raw,
      exitCode,
      error: `Claude Code exited with code ${exitCode}`,
    }
  }

  return { text, exitCode }
}

/**
 * Normalize OpenCode stdout into ExecutorOutput.
 *
 * OpenCode exit codes:
 *   0 = success
 *   1 = general error
 *
 * OpenCode stdout is plain text (no ANSI escapes by default).
 * Tool call output is interleaved with text in the run command output stream.
 * OpenCode may emit permission prompts in non-headless mode, but
 * we pass --dangerously-skip-permissions to suppress them.
 */
export function normalizeOpenCodeOutput(
  raw: string,
  exitCode: number,
  options?: { maxChars?: number }
): ExecutorOutput {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const cleaned = stripPreamble(raw)
  const text = truncate(cleaned, maxChars)

  if (exitCode !== 0) {
    return {
      text: text || raw,
      exitCode,
      error: `OpenCode exited with code ${exitCode}`,
    }
  }

  return { text, exitCode }
}

/**
 * Normalize output from either backend.
 * Call this after the spawn completes to get a consistent ExecutorOutput.
 */
export function normalizeOutput(
  raw: string,
  exitCode: number,
  backend: 'claude' | 'opencode',
  options?: { maxChars?: number }
): ExecutorOutput {
  if (backend === 'opencode') {
    return normalizeOpenCodeOutput(raw, exitCode, options)
  }
  return normalizeClaudeOutput(raw, exitCode, options)
}

/**
 * Attempt to parse JSON from executor output.
 * Returns the parsed object or undefined if parse fails.
 */
export function parseJsonOutput(output: ExecutorOutput): unknown | undefined {
  return extractJson(output.text)
}
