# Custom worker manifest

Schema and conventions for the optional custom-worker manifest consumed by the [`register-custom-workers`](../skills/register-custom-workers/SKILL.md) skill. Introduced in v0.3.0 ([ADR-0002](./adrs/0002-custom-worker-manifest.md)).

## Purpose

The 12 built-in triggers (`audit`, `optimize`, etc.) dispatch through `mcp__claude-flow__hooks_worker-dispatch` and cover the common cross-plugin cases. A consumer plugin or downstream project sometimes needs to schedule its own recurring task that doesn't fit those triggers — e.g. AgentVille's L4 deterministic anomaly tick. The custom-worker manifest is the contract surface for that case: declare the worker once in YAML, register all entries through `CronCreate` via the skill.

## Schema

```yaml
version: 1
workers:
  - name: <kebab-case identifier, required>
    schedule: '<5-field cron expression, required>'
    command: [<arg0>, <arg1>, ...]   # non-empty list of strings, required
    cwd: '<absolute path>'           # optional
    env:                             # optional
      KEY: VALUE
    timeout_seconds: <positive int>  # optional, advisory
    token_budget: <non-negative int> # optional, advisory (0 = deterministic)
    description: '<one line>'        # optional
```

### Required fields

| Field      | Type   | Constraints                                                                                                      |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`     | string | Kebab-case identifier (`^[a-z][a-z0-9-]*$`). Must be unique within the manifest. Used in operator-facing reports |
| `schedule` | string | 5-field POSIX cron expression (`m h dom mon dow`). `CronCreate` is the executor; it accepts the standard syntax  |
| `command`  | list   | Non-empty list of strings. Joined by single spaces when the skill builds the `Bash:` invocation                  |

### Optional fields

| Field             | Type         | Default                | Notes                                                                                                                       |
| ----------------- | ------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cwd`             | string       | (operator's PWD)       | Absolute path. The skill prepends `cd <cwd> && ` to the command when set                                                    |
| `env`             | object       | (none)                 | Key→string map. The skill emits `KEY=VALUE` pairs before the command. Quote values that contain spaces                      |
| `timeout_seconds` | int          | (none)                 | Advisory. `CronCreate` does not enforce it. Surfaced in operator reports for the audit trail                                |
| `token_budget`    | int          | (none)                 | Advisory. `0` signals a deterministic worker (no LLM). Surfaced in operator reports                                         |
| `description`     | string       | (none)                 | One-line summary shown alongside the registered cron ID                                                                     |

## Example: AgentVille L4 deterministic anomaly tick

```yaml
# .ruflo/custom-workers.yaml in the AgentVille project root
version: 1
workers:
  - name: agentville-l4
    schedule: '*/15 * * * *'
    command: ['pnpm', 'auto-ops:l4-tick', '--', '--project-root', '.']
    cwd: '/var/lib/agentville'
    env:
      AGENTVILLE_AUTOOPS_ENABLED: 'true'
      AGENTVILLE_GRAFANA_URL: 'https://grafana.example.com'
      AGENTVILLE_GLAB_REPO: 'altitudes-cloud/ai/agentville'
    timeout_seconds: 60
    token_budget: 0
    description: 'AgentVille L4 anomaly detection (Grafana + GitLab + adapter log)'
```

Registering it:

```text
Skill: ruflo-loop-workers:register-custom-workers .ruflo/custom-workers.yaml
```

The skill reads the file, validates each entry, and calls `CronCreate({ schedule: '*/15 * * * *', prompt: "Bash: cd /var/lib/agentville && AGENTVILLE_AUTOOPS_ENABLED=true AGENTVILLE_GRAFANA_URL=https://grafana.example.com AGENTVILLE_GLAB_REPO=altitudes-cloud/ai/agentville pnpm auto-ops:l4-tick -- --project-root ." })` for each worker.

## What the skill does not do

- **Secret expansion.** Manifest values are written into the `CronCreate` prompt verbatim. Do not put plaintext secrets in the manifest. Reference a wrapper script that reads secrets from disk (`/etc/<project>/<env>`) and `chmod 0600` the file.
- **Timeout enforcement.** `CronCreate` runs each invocation as a normal session turn. `timeout_seconds` is informational; the consumer's command should self-terminate.
- **Update detection.** Re-running the skill on an updated manifest does not replace existing crons; it adds new ones. To update: `CronList` to find the old ID, `CronDelete({ id })`, then re-run the skill.
- **Cross-project deduplication.** Two manifests with the same worker name in different projects produce two cron entries. Worker names are namespacing-by-convention only.

## Versioning

The schema is `version: 1`. Future versions are additive; field additions land in the same major. A breaking change (field renamed, semantics shifted) bumps the schema major and the plugin's minor, with a migration note in the ADR for that release.
