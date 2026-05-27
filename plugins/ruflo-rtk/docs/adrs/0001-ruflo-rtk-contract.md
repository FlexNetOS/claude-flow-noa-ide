# ADR-0001: ruflo-rtk Plugin Contract

status: Proposed
date: 2026-05-11
author: dkarasev

## Context

RTK (Rust Token Killer) and Ruflo both install `PreToolUse/Bash` hooks into `settings.json`. When either tool updates, it can clobber the other's hook entry. This plugin resolves the conflict while enabling both tools' savings to stack.

RTK compresses shell command output (stdout layer, 60-90% savings). Ruflo's Token Optimizer works at the context/caching layer (30-50% savings). They are complementary and stack multiplicatively.

## Decision

1. **Hook script location**: `scripts/rtk-pre-bash.sh` inside the plugin directory (never touched by Ruflo's updater)
2. **Registration target**: `settings.local.json` only — Ruflo writes only to `settings.json`, so `settings.local.json` is safe from clobbering
3. **Setup mechanism**: `/setup-rtk` command writes the hook entry per-project; global install via `~/.claude/settings.json` is also supported for users with many projects
4. **Per-command opt-out**: `.claude/rtk-ignore` file with line-per-pattern for commands that need raw output (e.g. test failure parsing)
5. **Binary requirement**: RTK >= 0.23.0 (for `rtk rewrite` subcommand); hook exits 0 silently if RTK not installed

## Chain order

```
PreToolUse/Bash pipeline per project:
  1. settings.local.json → scripts/rtk-pre-bash.sh   (RTK: compress stdout)
  2. settings.json       → hook-handler.cjs pre-bash  (Ruflo: safety check)

PostToolUse/Bash:
  → hook-handler.cjs post-bash  (Ruflo: learning + metrics on already-compressed output)
```

## Compatibility

Pinned to `@claude-flow/cli` v3.6. The `hookSpecificOutput` + `updatedInput` protocol for `PreToolUse` rewriting is stable as of Claude Code 1.x.

## Namespace coordination

Plugin namespace: `ruflo-rtk-*`. Defers to ruflo-agentdb ADR-0001 §"Namespace convention". No MCP tools registered — this is a pure hook adapter with no server component.

## Consequences

- Ruflo updates do not remove the RTK hook
- RTK updates do not remove the Ruflo hook
- Combined savings: ~85-90% on typical dev sessions
- No MCP server overhead — hook is a thin shell script (<5ms overhead)
- Lossy compression by design: RTK summarizes git/test output — use `.claude/rtk-ignore` when exact output is needed
