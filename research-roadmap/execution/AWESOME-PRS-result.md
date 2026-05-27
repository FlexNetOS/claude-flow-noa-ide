# Awesome-list PR submissions

## Submitted

| Repo | PR URL | Section added to | Status |
|---|---|---|---|
| jqueryscript/awesome-claude-code | https://github.com/jqueryscript/awesome-claude-code/pull/260 | 🤖 Agents & Orchestration | open |
| punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers/pull/6066 | 🤖 Coding Agents | open |
| ComposioHQ/awesome-claude-plugins | https://github.com/ComposioHQ/awesome-claude-plugins/pull/220 | Backend & Architecture | open |

## Skipped

| Repo | Reason |
|---|---|
| hesreallyhim/awesome-claude-code | The maintainer explicitly forbids gh-CLI submissions. CONTRIBUTING.md states "It is **not** possible to submit a resource recommendation using the `gh` CLI" and the issue-form template requires a checkbox `I am primarily composed of human-y stuff and not electrical circuits` (i.e. no agent submissions allowed). The form also requires "Resources must be at least one week old" — SwarmOps was created 2026-05-06, only 2 days ago. PR-based submissions to this list are auto-closed by `close-resource-prs.yml` workflow. **Recommendation: have the user submit via web UI manually after 2026-05-13** (1-week mark), via https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml — Category: "Tooling", Sub-Category: "Tooling: Orchestrators". |

## Notes / followups

- **punkpeye PR title** includes the `🤖🤖🤖` token per their CONTRIBUTING.md to opt-in to the agent-PR fast-track. They have an explicit policy welcoming agent-submitted PRs.
- **ComposioHQ default branch is `master`** (not `main`) — used `--base master` flag.
- **jqueryscript fork was named `awesome-claude-code-1`** by GitHub due to name collision with the hesreallyhim fork already in h4ckm1n-dev's account; this is harmless and PRs are filed against the correct upstream.
- **PR placement strategy**:
  - jqueryscript: end of "🤖 Agents & Orchestration" (no star count yet — repo is brand new with 0 stars; honest entry without claiming a 🔥/🌟/✨ tier).
  - punkpeye: alphabetical between `SunflowersLwtech/mcp_creator_growth` and `tiianhk/MaxMSP-MCP-Server`. Tagged `📇 🏠 🍎 🪟 🐧` per the legend.
  - ComposioHQ: directly below `maestro-orchestrate` since both are multi-agent orchestration tools — this is the closest semantic neighbor.
- **All PRs confirm**: MIT-licensed, one entry one section, format matches existing entries, no unrelated edits.
- **All bodies lead with the same 3 concrete claims**: 46× memory_search, mxbai-embed-large semantic memory, AIDefence wired into hooks.
- **Maintainer responsiveness expectations** (best-guess from list activity):
  - punkpeye: very active, has agent-PR fast-track — likely fastest merge.
  - jqueryscript: list is auto-curated by stars; may need 1-2 weeks before SwarmOps gathers stars to justify retention.
  - ComposioHQ: corporate-backed (Composio), reviews are likely careful but consistent — expect ~1 week.
- **No CLA, no signed commits, no automated linter** required by any of the 3 viable repos. Compliance was straightforward.
- **Forks created** under h4ckm1n-dev:
  - `h4ckm1n-dev/awesome-claude-code` (hesreallyhim — unused, can be deleted)
  - `h4ckm1n-dev/awesome-claude-code-1` (jqueryscript)
  - `h4ckm1n-dev/awesome-mcp-servers` (punkpeye)
  - `h4ckm1n-dev/awesome-claude-plugins` (ComposioHQ)
  - All forks can be deleted after PRs merge if desired.
