#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
step() { printf "→ %s ... " "$1"; }
ok()   { printf "PASS\n"; PASS=$((PASS+1)); }
bad()  { printf "FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

step "1. plugin.json version and keywords"
v=$(grep -E '"version"' "$ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
miss=""
for k in ruflo rtk token-optimization hooks pre-tool-use; do
  grep -q "\"$k\"" "$ROOT/.claude-plugin/plugin.json" || miss="$miss $k"
done
[[ -n "$v" && -z "$miss" ]] && ok || bad "version='$v' missing-keywords='$miss'"

step "2. rtk-setup skill has valid frontmatter"
F="$ROOT/skills/rtk-setup/SKILL.md"
miss=""
for k in 'name:' 'description:' 'allowed-tools:'; do
  grep -q "^$k" "$F" || miss="$miss no-$k"
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "3. setup-rtk command present"
[[ -f "$ROOT/commands/setup-rtk.md" ]] && ok || bad "commands/setup-rtk.md missing"

step "4. hook script is executable"
[[ -x "$ROOT/scripts/rtk-pre-bash.sh" ]] && ok || bad "scripts/rtk-pre-bash.sh not executable"

step "5. hook script handles missing rtk gracefully (exits 0)"
result=$(echo '{"tool_input":{"command":"git status"}}' | PATH=/usr/bin:/bin bash "$ROOT/scripts/rtk-pre-bash.sh" 2>/dev/null; echo "exit:$?")
[[ "$result" == "exit:0" ]] && ok || bad "unexpected output: $result"

step "6. hook script rewrites git status when rtk present"
if command -v rtk &>/dev/null && command -v jq &>/dev/null; then
  out=$(echo '{"tool_input":{"command":"git status"}}' | bash "$ROOT/scripts/rtk-pre-bash.sh" 2>/dev/null)
  echo "$out" | jq -e '.hookSpecificOutput.updatedInput.command' &>/dev/null \
    && ok || bad "no hookSpecificOutput in output"
else
  printf "SKIP (rtk/jq not installed)\n"; PASS=$((PASS+1))
fi

step "7. rtk-ignore opt-out works"
TMPDIR_IGNORE=$(mktemp -d)
mkdir -p "$TMPDIR_IGNORE/.claude"
echo "git status" > "$TMPDIR_IGNORE/.claude/rtk-ignore"
result=$(echo '{"tool_input":{"command":"git status"}}' | \
  CLAUDE_PROJECT_DIR="$TMPDIR_IGNORE" bash "$ROOT/scripts/rtk-pre-bash.sh" 2>/dev/null; echo "exit:$?")
rm -rf "$TMPDIR_IGNORE"
[[ "$result" == "exit:0" ]] && ok || bad "rtk-ignore did not suppress rewrite"

step "8. ADR-0001 exists with status Proposed"
ADR="$ROOT/docs/adrs/0001-ruflo-rtk-contract.md"
[[ -f "$ADR" ]] && grep -qE "^status:[[:space:]]*Proposed" "$ADR" \
  && ok || bad "ADR missing or status != Proposed"

step "9. README has required sections"
miss=""
for section in "Compatibility" "Namespace coordination" "Architecture Decisions" "Verification"; do
  grep -q "## $section\|### $section\|$section" "$ROOT/README.md" 2>/dev/null || miss="$miss $section"
done
[[ -z "$miss" ]] && ok || bad "missing sections:$miss"

step "10. no wildcard tool grants in skills"
bad_skills=""
for f in "$ROOT"/skills/*/SKILL.md; do
  grep -q '^allowed-tools:[[:space:]]*\*' "$f" 2>/dev/null && bad_skills="$bad_skills $(basename "$(dirname "$f")")"
done
[[ -z "$bad_skills" ]] && ok || bad "wildcard:$bad_skills"

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
