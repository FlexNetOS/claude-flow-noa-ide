#!/usr/bin/env bash
# ruflo-rtk PreToolUse/Bash hook.
# Rewrites Bash commands through RTK for token savings.
# Registered in settings.local.json by /setup-rtk; never written by Ruflo updater.
#
# Per-command opt-out: add patterns to .claude/rtk-ignore in the project root.
# The hook exits 0 silently for any command matching an ignore pattern.
#
# rtk rewrite exit codes:
#   0  Rewrite found, auto-allow
#   1  No RTK equivalent — pass through unchanged
#   2  Deny rule — pass through (Claude Code native deny handles it)
#   3  Ask rule — rewrite but omit permissionDecision (permissions.allow covers it)

if ! command -v jq &>/dev/null || ! command -v rtk &>/dev/null; then
  exit 0
fi

# Version cache: avoids spawning rtk on every hook call
CACHE_DIR=${XDG_CACHE_HOME:-$HOME/.cache}
CACHE_FILE="$CACHE_DIR/rtk-ruflo-version-ok"
if [ ! -f "$CACHE_FILE" ]; then
  RTK_RAW=$(rtk --version 2>/dev/null)
  RTK_VER=${RTK_RAW#rtk }; RTK_VER=${RTK_VER%% *}
  if [ -n "$RTK_VER" ]; then
    IFS=. read -r MAJOR MINOR PATCH <<<"$RTK_VER"
    [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 23 ] && exit 0
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null && touch "$CACHE_FILE" 2>/dev/null
fi

INPUT=$(cat)
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
[ -z "$CMD" ] && exit 0

# Per-project ignore list
IGNORE_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/rtk-ignore"
if [ -f "$IGNORE_FILE" ]; then
  while IFS= read -r pattern || [ -n "$pattern" ]; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    [[ "$CMD" == *"$pattern"* ]] && exit 0
  done < "$IGNORE_FILE"
fi

REWRITTEN=$(rtk rewrite "$CMD" 2>/dev/null)
EXIT_CODE=$?

case $EXIT_CODE in
  0)
    [ "$CMD" = "$REWRITTEN" ] && exit 0
    jq -c --arg cmd "$REWRITTEN" \
      '.tool_input.command = $cmd | {
        "hookSpecificOutput": {
          "hookEventName": "PreToolUse",
          "permissionDecision": "allow",
          "permissionDecisionReason": "RTK auto-rewrite",
          "updatedInput": .tool_input
        }
      }' <<<"$INPUT"
    ;;
  3)
    jq -c --arg cmd "$REWRITTEN" \
      '.tool_input.command = $cmd | {
        "hookSpecificOutput": {
          "hookEventName": "PreToolUse",
          "permissionDecision": "allow",
          "permissionDecisionReason": "RTK auto-rewrite (user installed)",
          "updatedInput": .tool_input
        }
      }' <<<"$INPUT"
    ;;
  *)
    exit 0
    ;;
esac
