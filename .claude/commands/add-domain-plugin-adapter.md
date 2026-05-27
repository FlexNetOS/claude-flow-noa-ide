---
name: add-domain-plugin-adapter
description: Workflow command scaffold for add-domain-plugin-adapter in ruflo.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-domain-plugin-adapter

Use this workflow when working on **add-domain-plugin-adapter** in `ruflo`.

## Goal

Adds a new ClaudeFlowPlugin adapter to wire a domain/service into the kernel/service container.

## Common Files

- `v3/@claude-flow/*/src/*-plugin.ts`
- `v3/src/*/*-plugin.ts`
- `plugins/ruflo-*/src/*-plugin.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create a thin ClaudeFlowPlugin wrapper in the domain's src/ directory (e.g., memory-plugin.ts, security-plugin.ts).
- Register the service in the service container with a unique key.
- Ensure all required exports are re-exported via index.ts (barrel file) if needed.
- Verify with TypeScript (tsc --noEmit --skipLibCheck) for zero errors.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.