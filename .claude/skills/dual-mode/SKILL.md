---
name: dual-mode
description: Coordinate Claude Code with headless Codex workers using /dual-spawn, /dual-coordinate, and /dual-collect commands. Use when parallel worker orchestration, hybrid Claude+Codex workflows, or result collection from background workers is needed.
---

# Dual-Mode Skills (Claude Code + Codex)

Use this skill for hybrid orchestration where Claude Code coordinates and Codex workers execute tasks in parallel.

## Quick start

Spawn workers:

```bash
/dual-spawn "Implement auth module" --workers 3
```

Collect outputs:

```bash
/dual-collect --namespace results
```

Run full hybrid workflow:

```bash
/dual-coordinate --workflow hybrid_development --task "Build user API"
```

## Instructions

1. Use `/dual-spawn` to fan out independent tasks to headless Codex workers.
2. Use `/dual-coordinate` when a multi-step workflow needs explicit orchestration.
3. Use `/dual-collect` to aggregate worker outputs and validate completion.
4. Keep tasks small and bounded to reduce merge and coordination overhead.
5. If work depends on shared state, collect after each phase before spawning next phases.

## Command References

- [dual-spawn.md](dual-spawn.md)
- [dual-coordinate.md](dual-coordinate.md)
- [dual-collect.md](dual-collect.md)
- [README.md](README.md)

## Related Agents

- dual-orchestrator
- codex-coordinator
- codex-worker

See agent definitions in `.claude/agents/dual-mode/`.
