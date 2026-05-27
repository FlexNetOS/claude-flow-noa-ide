---
name: setup-rtk
description: Wire RTK token compression into this project — installs rtk binary if needed and registers the PreToolUse hook in settings.local.json
---

Install and configure RTK (Rust Token Killer) for this Ruflo project.

Run this command once after `ruflo init` to enable 60-90% token savings on Bash command output.

**What it does:**
1. Checks for `rtk` binary (installs via brew if missing)
2. Resolves the hook script path from the installed plugin
3. Writes the `PreToolUse/Bash` hook into `.claude/settings.local.json` without touching `settings.json`
4. Adds `Bash(rtk *)` to the project's allow-list

**Per-command opt-out:**
Add patterns to `.claude/rtk-ignore` to pass commands through unmodified:
```
cargo test --nocapture
pytest -s -v
```
