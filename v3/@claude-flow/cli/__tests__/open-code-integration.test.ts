/**
 * OpenCode Integration Tests
 *
 * Tests backend routing, configuration, type system, and output normalization
 * without mocking child_process (vitest ESM mocks are unreliable for spawn).
 * Integration-level spawn testing happens via manual test scripts in /testing/.
 */
import { describe, it, expect } from 'vitest'

import {
  normalizeOutput,
  normalizeClaudeOutput,
  normalizeOpenCodeOutput,
} from '../src/services/executor-output.js'

describe('ExecutorOutput normalization', () => {
  describe('normalizeClaudeOutput', () => {
    it('returns text and exitCode for success', () => {
      const result = normalizeClaudeOutput('function add(a,b){return a+b}', 0)
      expect(result.text).toContain('function add')
      expect(result.exitCode).toBe(0)
      expect(result.error).toBeUndefined()
    })

    it('strips ANSI escape sequences', () => {
      const raw = '\x1b[32mfunction add(a,b){return a+b}\x1b[0m'
      const result = normalizeClaudeOutput(raw, 0)
      expect(result.text).not.toContain('\x1b')
      expect(result.text).toContain('function add')
    })

    it('strips preamble lines (Claude Code version banner)', () => {
      const raw = 'Claude Code v2.1.86\nfunction add(a,b){return a+b}'
      const result = normalizeClaudeOutput(raw, 0)
      expect(result.text).not.toContain('Claude Code')
      expect(result.text).toContain('function add')
    })

    it('returns error for non-zero exit code', () => {
      const result = normalizeClaudeOutput('', 1)
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain('Claude Code exited with code 1')
    })

    it('truncates long output and includes truncation note', () => {
      const long = 'x'.repeat(200_000)
      const result = normalizeClaudeOutput(long, 0, { maxChars: 1000 })
      expect(result.text.length).toBeLessThan(long.length)
      expect(result.text).toContain('truncated')
    })
  })

  describe('normalizeOpenCodeOutput', () => {
    it('returns text and exitCode for success', () => {
      const result = normalizeOpenCodeOutput('def add(a,b): return a+b', 0)
      expect(result.text).toContain('def add')
      expect(result.exitCode).toBe(0)
    })

    it('returns error for non-zero exit code', () => {
      const result = normalizeOpenCodeOutput('traceback...', 1)
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain('OpenCode exited with code 1')
    })

    it('preserves content on error exit', () => {
      const result = normalizeOpenCodeOutput('some error output', 1)
      expect(result.text).toContain('some error output')
    })
  })

  describe('normalizeOutput (unified dispatcher)', () => {
    it('routes to claude normalizer when backend is claude', () => {
      const result = normalizeOutput('code from claude', 0, 'claude')
      expect(result.exitCode).toBe(0)
      expect(result.text).toBe('code from claude')
    })

    it('routes to opencode normalizer when backend is opencode', () => {
      const result = normalizeOutput('code from opencode', 0, 'opencode')
      expect(result.exitCode).toBe(0)
      expect(result.text).toBe('code from opencode')
    })

    it('preserves error info for claude', () => {
      const result = normalizeOutput('', 2, 'claude')
      expect(result.error).toContain('Claude Code')
    })

    it('preserves error info for opencode', () => {
      const result = normalizeOutput('', 2, 'opencode')
      expect(result.error).toContain('OpenCode')
    })
  })

  describe('real-world output samples', () => {
    it('handles opencode run output with markdown code blocks', () => {
      const raw = [
        '> build \u00b7 qwen3.6-plus',
        '',
        '```python',
        'def add(a, b):',
        '    return a + b',
        '```',
      ].join('\n')
      const result = normalizeOpenCodeOutput(raw, 0)
      expect(result.text).toContain('def add')
      expect(result.text).toContain('```python')
      expect(result.exitCode).toBe(0)
    })
  })
})
