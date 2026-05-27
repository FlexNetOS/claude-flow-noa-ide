---
id: ADR-0002
title: ruflo-loop-workers custom-worker manifest schema and registration skill
status: Proposed
date: 2026-05-16
authors:
  - contributor (AgentVille / Sebastiaan)
tags: [plugin, loop-workers, cron, custom-workers, manifest, schema]
---

## Context

ADR-0001 anchors `ruflo-loop-workers` around 12 built-in triggers (`audit`, `optimize`, ..., `testgaps`) dispatched through `mcp__claude-flow__hooks_worker-dispatch`. The trigger list is closed — each new trigger requires a consumer-plugin commit naming the trigger and a documentation update here.

Downstream projects with their own deterministic recurring work (e.g. AgentVille's L4 anomaly-detection tick: `docs/superpowers/specs/2026-05-16-auto-ops-l4-loop-worker-design.md` §7.5) hit two friction points:

1. The 12-trigger contract has no slot for project-specific workers, so the natural path is to bypass the plugin entirely and call `CronCreate` directly from the consumer's operator runbook. Every consumer reinvents the same wrapper-script + cron-prompt boilerplate.
2. The plugin's value-add for those bypass cases is purely social (discovery, audit trail). Without a contract surface for custom workers, that value isn't expressed in code.

## Decision

Add a thin, additive surface for custom workers. The plugin stays markdown-only; the schema lives in `docs/custom-worker-manifest.md`; a new skill `register-custom-workers` reads a manifest path and registers each worker via `CronCreate`.

Concrete additions in v0.3.0:

1. `skills/register-custom-workers/SKILL.md` — skill definition with `allowed-tools: Read CronCreate CronList CronDelete`. Tells the model to read the manifest, validate, build a `Bash:` invocation per worker, call `CronCreate`, and report back. All-or-nothing validation.
2. `docs/custom-worker-manifest.md` — canonical schema. Required: `name`, `schedule`, `command`. Optional: `cwd`, `env`, `timeout_seconds`, `token_budget`, `description`. Version pinned at `1`.
3. README "Custom workers" section linking to the schema and skill, explicitly noting the contract is complementary to (not a replacement for) the 12 built-in triggers.
4. `plugin.json` keywords gain `custom-workers`; version bumps `0.2.0 → 0.3.0`.
5. `scripts/smoke.sh` adds structural checks (custom-worker skill exists with valid frontmatter, schema doc exists with required-field section, ADR-0002 status `Proposed`, plugin.json version bumped, `custom-workers` keyword present). Drive-by fix: check 11 accepts `Proposed|Accepted` (ADR-0001 drifted to `Accepted` upstream without a smoke update).

## What this is not

- Not a generic job runner. `CronCreate` is the executor; the skill is a registration helper.
- Not secret management. Manifests must not carry plaintext secrets; they reference wrapper scripts that read from disk.
- Not lifecycle. No update / delete from the skill itself — that's `CronList` + `CronDelete` on the operator side.
- Not a competitor to the 12 built-in triggers. Custom workers run alongside, in a separate namespace, with separate observability.

## Consequences

**Positive:**

- Consumer plugins (AgentVille L4 first, others later) have a canonical place to declare their cron workers instead of duplicating wrapper-script + `CronCreate` boilerplate.
- The skill makes operator workflow auditable: every custom worker registered through this surface goes through one validation path and one `CronList` discovery.
- Additive change. Existing 12-trigger workflow is untouched.

**Negative:**

- Two parallel surfaces (12 fixed triggers + custom manifest). README needs to clarify which to use when, otherwise newcomers will pick wrong.
- Manifest validation lives in the skill (model-interpreted), not in a runnable validator. A future hardening could add a JSON Schema + validator script; deferred per minimal-surface principle.

## Verification

```bash
bash plugins/ruflo-loop-workers/scripts/smoke.sh
# Expected after this PR: "16 passed, 0 failed"
```

End-to-end smoke that exercises the skill against a fixture manifest is out of scope for this contract PR; the schema doc + skill prompt are the verification artifacts.

## Related

- ADR-0001 — 12-trigger contract (this ADR is additive; the trigger map is unchanged)
- AgentVille L4 design spec §7.5 — the motivating consumer (out-of-repo)
- AgentVille L4 deployment runbook — the bridge before this manifest schema existed; documents three concrete `CronCreate` / cron / systemd recipes that the manifest schema now generalises

## Implementation status

Proposed in PR #(TBD) to `ruvnet/ruflo`. Plugin version bumps `0.2.0 → 0.3.0` in the same PR.
