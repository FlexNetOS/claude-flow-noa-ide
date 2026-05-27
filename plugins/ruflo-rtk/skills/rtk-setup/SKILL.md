---
name: rtk-setup
description: Install and configure RTK (Rust Token Killer) integration for this project — writes the PreToolUse hook into settings.local.json and verifies rtk binary availability
allowed-tools: Bash Read Write Edit
---

# RTK Setup

Integrate RTK into the current Ruflo project for 60-90% token savings on Bash command output.

## When to use

After `ruflo init` in a new project, run `/rtk-setup` once to wire the RTK hook into this project's `settings.local.json`.

## Steps

1. **Check RTK binary**

```bash
if ! command -v rtk &>/dev/null; then
  echo "RTK not found. Installing via brew..."
  brew install rtk
fi
rtk --version
```

2. **Verify version >= 0.23.0** (required for `rtk rewrite` subcommand)

3. **Locate the hook script** — resolve the plugin's `scripts/rtk-pre-bash.sh` path:
   - Global install: `~/.claude/plugins/ruflo-rtk/scripts/rtk-pre-bash.sh`
   - Local plugin dir: `${CLAUDE_PROJECT_DIR}/.claude/plugins/ruflo-rtk/scripts/rtk-pre-bash.sh`
   - Use whichever exists

4. **Read or create `.claude/settings.local.json`** in the current project. Merge in the RTK hook entry and permission — do NOT overwrite existing entries:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'exec \"<resolved-hook-script-path>\"'",
            "timeout": 3000
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": ["Bash(rtk *)"]
  }
}
```

5. **Check for per-project ignore list** at `.claude/rtk-ignore` — if present, show current ignored patterns.

6. **Report outcome**:
   - RTK version installed
   - Hook path registered
   - Estimated savings from `rtk gain` if history exists
   - How to add per-command exceptions: echo a pattern to `.claude/rtk-ignore`

## Config flag: disabling RTK per-command

For cases where the agent needs raw output (e.g. parsing a specific test failure line), add a pattern to `.claude/rtk-ignore`:

```bash
echo "cargo test" >> .claude/rtk-ignore
echo "pytest -v" >> .claude/rtk-ignore
```

The hook script checks this file and passes matching commands through unchanged.
