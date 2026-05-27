# ruflo-rtk

RTK shell-output compression adapter for Ruflo. Rewrites Bash commands through [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) for 60-90% token savings at the stdout layer, stacking with Ruflo's context-layer Token Optimizer.

## Install

```bash
/plugin install ruflo-rtk@ruflo
/setup-rtk
```

`/setup-rtk` registers the `PreToolUse/Bash` hook into `.claude/settings.local.json` (never touched by Ruflo's updater) and adds `Bash(rtk *)` to the project allow-list. Run once per project after `ruflo init`.

RTK binary: `brew install rtk` (requires >= 0.23.0).

## How it works

```
git status
  → PreToolUse hook → rtk rewrite "git status" → "rtk git status"
  → Claude Code executes rtk git status
  → ~200 tokens instead of ~2000
```

Four compression strategies applied per command type: smart filtering, grouping, truncation, deduplication.

| Layer | Savings | Mechanism |
|---|---|---|
| RTK (stdout) | 60–90% | Per-command output filter |
| Ruflo Token Optimizer | 30–50% | Context caching + routing |
| Combined (typical session) | ~85–90% | Stacks multiplicatively |

## Skills & Commands

- **`/setup-rtk`** — install RTK and wire the hook for this project
- **`/rtk-setup`** — same, invokable as a skill

## Per-command opt-out

RTK compression is lossy-by-design (it summarizes git/test output). For commands where the agent needs raw output, add patterns to `.claude/rtk-ignore`:

```
# .claude/rtk-ignore
cargo test --nocapture
pytest -s -v
```

The hook skips any command matching a pattern in this file.

## Compatibility

Requires `@claude-flow/cli` v3.6. Uses the `hookSpecificOutput` + `updatedInput` protocol for `PreToolUse` Bash rewriting.

## Namespace coordination

Plugin namespace: `ruflo-rtk-*`. Defers to ruflo-agentdb ADR-0001 §"Namespace convention". No MCP server registered.

## Verification

```bash
bash plugins/ruflo-rtk/scripts/smoke.sh
```

## Architecture Decisions

- [ADR-0001: Plugin Contract](docs/adrs/0001-ruflo-rtk-contract.md) — hook placement, registration target, opt-out mechanism, chain order

## Related

- [RTK issue #1892](https://github.com/ruvnet/ruflo/issues/1892) — version number mismatch (separate)
- [RTK integration proposal #1900](https://github.com/ruvnet/ruflo/issues/1900) — this plugin
