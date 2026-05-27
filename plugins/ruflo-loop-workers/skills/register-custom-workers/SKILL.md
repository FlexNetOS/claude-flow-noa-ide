---
name: register-custom-workers
description: Register consumer-defined background workers from a YAML manifest as CronCreate schedules
argument-hint: "<manifest-path>"
allowed-tools: Read CronCreate CronList CronDelete
---

Use this skill when a consumer plugin (or downstream project) ships its own recurring worker that doesn't map to one of the 12 built-in triggers (`audit`, `optimize`, ..., `testgaps`). The built-ins dispatch through `mcp__claude-flow__hooks_worker-dispatch`; custom workers run arbitrary `Bash` commands on a cron schedule via `CronCreate`.

## Manifest schema

Canonical schema at `docs/custom-worker-manifest.md` in this plugin. Minimal example:

```yaml
version: 1
workers:
  - name: agentville-l4
    schedule: '*/15 * * * *'
    command: ['pnpm', 'auto-ops:l4-tick', '--', '--project-root', '.']
    cwd: '/var/lib/agentville'
    env:
      AGENTVILLE_GLAB_REPO: 'org/repo'
    timeout_seconds: 60
```

## Workflow

1. Read the manifest file at the path supplied by the operator.
2. Validate top-to-bottom. Stop before any `CronCreate` if validation fails — registration is all-or-nothing:
   - `version` must be the integer `1`.
   - `workers` must be a non-empty list.
   - Each worker requires `name` (kebab-case identifier), `schedule` (5-field cron expression), and `command` (non-empty list of strings).
   - `cwd`, `env`, `timeout_seconds`, `token_budget`, `description` are optional.
   - Worker `name`s must be unique within the manifest.
3. For each worker, build a single-line shell command:
   - `cd <cwd> && <KEY=VAL ...> <command joined by spaces>`
   - Omit the `cd` clause when `cwd` is absent.
   - Omit the env prefix when `env` is empty.
4. Call `CronCreate({ schedule: <worker.schedule>, prompt: "Bash: " + <built command> })` for each worker, in manifest order.
5. After all registrations succeed, call `CronList` and report each registered cron ID alongside its worker name to the operator.

## Updating or removing a worker

`CronCreate` does not deduplicate. To update a worker:

1. `CronList` to find the existing cron ID by matching the prompt prefix.
2. `CronDelete({ id })` to drop it.
3. Re-run this skill against the updated manifest.

## Notes

- `timeout_seconds` and `token_budget` are advisory. `CronCreate` does not enforce them. Surface them in the operator-facing report so the audit trail is complete.
- The skill does not start, stop, or monitor running workers. For active worker management of the 12 built-in triggers, use `mcp__claude-flow__hooks_worker-status` and `mcp__claude-flow__hooks_worker-cancel` via the `loop-worker-coordinator` agent.
- Custom workers do not contribute to the `worker-history` namespace; that namespace is reserved for the 12 built-ins per ADR-0001.
