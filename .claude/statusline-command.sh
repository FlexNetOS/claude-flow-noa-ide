#!/bin/bash
# Claude Code Status Line - Inspired by Starship configuration

# Read JSON input from stdin
input=$(cat)

# Extract data from JSON
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
model_name=$(echo "$input" | jq -r '.model.display_name')


# Directory display (truncated like Starship)
if [[ "$cwd" == "$HOME"* ]]; then
    display_dir="~${cwd#$HOME}"
else
    display_dir="$cwd"
fi

output=""

# Git info — ONE shell pipeline produces repo_root, branch, status (was 5 separate git invocations).
# Sections separated by ---SEP--- so we can split with bash parameter expansion (no awk fork).
repo_root=""
branch=""
git_status=""
if [[ "$(git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree 2>/dev/null)" == "true" ]]; then
    git_info=$({ git -C "$cwd" rev-parse --show-toplevel 2>/dev/null; \
                 echo "---SEP---"; \
                 git -C "$cwd" branch --show-current 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null; \
                 echo "---SEP---"; \
                 git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null; })
    repo_root="${git_info%%$'\n'---SEP---*}"
    rest="${git_info#*---SEP---$'\n'}"
    branch="${rest%%$'\n'---SEP---*}"
    git_status="${rest#*---SEP---}"
    git_status="${git_status#$'\n'}"
fi

if [[ -n "$repo_root" ]]; then
    repo_name=$(basename "$repo_root")
    relative_path="${cwd#$repo_root}"
    if [[ -z "$relative_path" ]]; then
        display_dir="$repo_name"
    else
        display_dir="$repo_name$relative_path"
    fi
fi

output+=$(printf "\033[1;34m%s\033[0m " "$display_dir")

# Git branch and status (uses pre-fetched data — no additional git invocations)
if [[ -n "$branch" ]]; then
    output+=$(printf "on \033[1;32m %s\033[0m " "$branch")

    # Bash-native pattern matching — replaces 4 echo|grep forks (~10-20ms saved).
    # `_NL_$git_status` ensures we can match leading-line patterns with `*$'\n'X*`.
    status_icons=""
    nl_status=$'\n'"$git_status"
    [[ "$nl_status" == *$'\n'\?\?* ]] && status_icons+=""
    [[ "$nl_status" == *$'\n'\ M* ]] && status_icons+=""
    [[ "$nl_status" == *$'\n'M\ * ]] && status_icons+="++"
    [[ "$nl_status" == *$'\n'D\ * ]] && status_icons+=""

    if [[ -n "$status_icons" ]]; then
        output+=$(printf "\033[1;32m(%s)\033[0m " "$status_icons")
    fi
fi

# Python
if [[ -f "$cwd/requirements.txt" ]] || [[ -f "$cwd/pyproject.toml" ]] || [[ -f "$cwd/setup.py" ]]; then
    py_version=$(python3 --version 2>/dev/null | cut -d' ' -f2)
    [[ -n "$py_version" ]] && output+=$(printf "via \033[1;33m %s\033[0m " "$py_version")
fi

# Node.js
if [[ -f "$cwd/package.json" ]]; then
    node_version=$(node --version 2>/dev/null | sed 's/v//')
    [[ -n "$node_version" ]] && output+=$(printf "via \033[1;32m󰎙 %s\033[0m " "$node_version")
fi


# Ruflo stats (read directly from state JSON files — no CLI overhead, ~5ms)
ruflo_state_dir="$HOME/.claude/.claude-flow"
if [[ -d "$ruflo_state_dir" ]]; then
    daemon_state="$ruflo_state_dir/daemon-state.json"
    swarm_state="$ruflo_state_dir/swarm/swarm-state.json"

    daemon_running="false"
    worker_count=0
    worker_runs=0
    if [[ -f "$daemon_state" ]]; then
        # ONE jq call extracts running/worker_count/worker_runs (was 3 separate forks).
        daemon_summary=$(jq -r '"\(.running // false)|\(.workers | length)|\([.workers[].runCount] | add // 0)"' "$daemon_state" 2>/dev/null)
        daemon_running="${daemon_summary%%|*}"
        rest_d="${daemon_summary#*|}"
        worker_count="${rest_d%%|*}"
        worker_runs="${rest_d##*|}"
        [[ -z "$daemon_running" ]] && daemon_running="false"
        [[ -z "$worker_count" ]] && worker_count=0
        [[ -z "$worker_runs" ]] && worker_runs=0
    fi

    swarm_count=0
    agent_total=0
    task_total=0
    if [[ -f "$swarm_state" ]]; then
        # ONE jq call extracts swarm_count/agent_total/task_total (was 3 separate forks).
        swarm_summary_top=$(jq -r '"\(.swarms | length)|\([.swarms[].agents | length] | add // 0)|\([.swarms[].tasks | length] | add // 0)"' "$swarm_state" 2>/dev/null)
        swarm_count="${swarm_summary_top%%|*}"
        rest_s="${swarm_summary_top#*|}"
        agent_total="${rest_s%%|*}"
        task_total="${rest_s##*|}"
        [[ -z "$swarm_count" ]] && swarm_count=0
        [[ -z "$agent_total" ]] && agent_total=0
        [[ -z "$task_total" ]] && task_total=0
    fi

    # Daemon dot — green ● if running, dim ○ if stopped
    if [[ "$daemon_running" == "true" ]]; then
        ruflo_segment=$(printf "\033[1;32m●\033[0m\033[1;35m %s\033[0m" "$worker_count")
    else
        ruflo_segment=$(printf "\033[2m○\033[0m\033[1;35m %s\033[0m" "$worker_count")
    fi
    # Swarm + agents
    ruflo_segment+=$(printf " \033[1;34m󰵅 %s\033[0m" "$swarm_count")
    [[ "$agent_total" -gt 0 ]] 2>/dev/null && ruflo_segment+=$(printf "\033[1;34m/%s\033[0m" "$agent_total")
    # Active tasks (only show when non-zero)
    [[ "$task_total" -gt 0 ]] 2>/dev/null && ruflo_segment+=$(printf " \033[1;33m %s\033[0m" "$task_total")
    # Worker activity badge (cumulative runs)
    [[ "$worker_runs" -gt 0 ]] 2>/dev/null && ruflo_segment+=$(printf " \033[1;36m⟳ %s\033[0m" "$worker_runs")

    output+=$(printf "| %s " "$ruflo_segment")
fi

# Model + context
# Calculate context tokens from current_usage (most accurate)
ctx_input=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0')
ctx_cache_create=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
ctx_cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
ctx_window=$(echo "$input" | jq -r '.context_window.context_window_size // 0')

if [[ "$ctx_window" -gt 0 ]] 2>/dev/null; then
    ctx_used_tokens=$((ctx_input + ctx_cache_create + ctx_cache_read))
    # Auto-compact triggers at ~80% of context window
    compact_threshold=$((ctx_window * 80 / 100))
    ctx_left=$((compact_threshold - ctx_used_tokens))
    [[ $ctx_left -lt 0 ]] && ctx_left=0
    ctx_left_pct=$((ctx_left * 100 / compact_threshold))

    # Human-readable token count (K)
    ctx_used_k=$((ctx_used_tokens / 1000))
    ctx_window_k=$((ctx_window / 1000))

    # Color code: green >50%, yellow 20-50%, red <20%
    if [[ "$ctx_left_pct" -lt 20 ]] 2>/dev/null; then
        ctx_color="\033[1;31m"
    elif [[ "$ctx_left_pct" -lt 50 ]] 2>/dev/null; then
        ctx_color="\033[1;33m"
    else
        ctx_color="\033[1;32m"
    fi
    output+=$(printf "| \033[1;36m󰧑 %s\033[0m " "$model_name")
    output+=$(printf "\033[0m| ${ctx_color}󰋊 %sK/%sK\033[0m" "$ctx_used_k" "$ctx_window_k")

    # Cache usage segment
    cache_read_k=$((ctx_cache_read / 1000))
    cache_create_k=$((ctx_cache_create / 1000))
    cache_total_k=$((cache_read_k + cache_create_k))
    if [[ "$cache_total_k" -gt 0 ]]; then
        # Cache hit ratio color: green >60%, yellow 30-60%, red <30%
        if [[ "$cache_total_k" -gt 0 ]]; then
            cache_hit_pct=$((cache_read_k * 100 / cache_total_k))
        else
            cache_hit_pct=0
        fi
        if [[ "$cache_hit_pct" -ge 60 ]]; then
            cache_color="\033[1;32m"
        elif [[ "$cache_hit_pct" -ge 30 ]]; then
            cache_color="\033[1;33m"
        else
            cache_color="\033[1;31m"
        fi
        output+=$(printf " \033[0m| ${cache_color}󰆼 %sK↓ %sK↑\033[0m" "$cache_read_k" "$cache_create_k")
    fi
elif [[ -n "$model_name" ]]; then
    output+=$(printf "| \033[1;36m󰧑 %s\033[0m" "$model_name")
fi

# ── Active Ruflo Agents / Tasks (read directly from swarm-state.json) ──
# Replaces the 2026-04 brain CEO/rustclaw process scan. Surfaces:
#   - running ruflo agents per swarm (count + first names)
#   - in-flight tasks across all swarms
#   - active session edits/commands (from sessions/current.json)
# All from JSON files — no `ps` calls, no log parsing, no /tmp writes.
if [[ -d "$ruflo_state_dir" ]]; then
    swarm_state="$ruflo_state_dir/swarm/swarm-state.json"
    session_state="$ruflo_state_dir/sessions/current.json"

    rufloA_names=""
    rufloA_count=0
    rufloA_tasks=0
    if [[ -f "$swarm_state" ]]; then
        # ONE jq call extracts count/tasks/names (was 3 separate forks against same file).
        rufloA_summary=$(jq -r '
            "\([.swarms[].agents | length] | add // 0)|\([.swarms[].tasks[] | select(.status != "completed" and .status != "failed")] | length)|\([.swarms[].agents[] | (.role // .type // .name // "agent")] | .[0:3] | join(","))"
        ' "$swarm_state" 2>/dev/null)
        rufloA_count="${rufloA_summary%%|*}"
        rest_a="${rufloA_summary#*|}"
        rufloA_tasks="${rest_a%%|*}"
        rufloA_names="${rest_a##*|}"
        [[ -z "$rufloA_count" ]] && rufloA_count=0
        [[ -z "$rufloA_tasks" ]] && rufloA_tasks=0
    fi

    sess_edits=0
    sess_cmds=0
    if [[ -f "$session_state" ]]; then
        # ONE jq call for both metrics (was 2 forks).
        sess_summary=$(jq -r '"\(.metrics.edits // 0)|\(.metrics.commands // 0)"' "$session_state" 2>/dev/null)
        sess_edits="${sess_summary%%|*}"
        sess_cmds="${sess_summary##*|}"
        [[ -z "$sess_edits" ]] && sess_edits=0
        [[ -z "$sess_cmds" ]] && sess_cmds=0
    fi

    # Build the segment only if there's something worth showing.
    agent_segment=""
    if [[ "$rufloA_count" -gt 0 ]] 2>/dev/null; then
        agent_segment+=$(printf "\033[1;36m🤖 %s\033[0m" "$rufloA_count")
        if [[ -n "$rufloA_names" ]]; then
            agent_segment+=$(printf " \033[2m%s\033[0m" "$rufloA_names")
        fi
    fi
    if [[ "$rufloA_tasks" -gt 0 ]] 2>/dev/null; then
        [[ -n "$agent_segment" ]] && agent_segment+="  "
        agent_segment+=$(printf "\033[1;33m %s task%s\033[0m" "$rufloA_tasks" "$([[ $rufloA_tasks -gt 1 ]] && echo s)")
    fi
    if [[ "$sess_edits" -gt 0 ]] 2>/dev/null || [[ "$sess_cmds" -gt 0 ]] 2>/dev/null; then
        [[ -n "$agent_segment" ]] && agent_segment+="  "
        agent_segment+=$(printf "\033[2msess: %se %sc\033[0m" "$sess_edits" "$sess_cmds")
    fi

    # Stash for the bottom-of-line append at line 383.
    agent_segment_rendered="$agent_segment"
fi

# ── Rate Limit Usage (cached, refreshes every 60s) ──────
# Cache check verified working — fresh cache (<60s) skips curl entirely
# (no fork for stat is needed when file is missing; -f short-circuits).
rate_cache="/tmp/claude/statusline-usage-cache.json"
rate_cache_age=999
[[ -f "$rate_cache" ]] && rate_cache_age=$(( $(date +%s) - $(stat -f%m "$rate_cache" 2>/dev/null || stat -c%Y "$rate_cache" 2>/dev/null || echo 0) ))

if [[ $rate_cache_age -gt 60 ]]; then
    # Only create the cache dir when we're actually about to refresh — saves an
    # mkdir fork on every render where the cache is fresh.
    mkdir -p /tmp/claude
    # Resolve OAuth token
    oauth_token=""
    if [[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]]; then
        oauth_token="$CLAUDE_CODE_OAUTH_TOKEN"
    elif command -v security >/dev/null 2>&1; then
        blob=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
        [[ -n "$blob" ]] && oauth_token=$(echo "$blob" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    fi
    if [[ -z "$oauth_token" ]] && [[ -f "$HOME/.claude/.credentials.json" ]]; then
        oauth_token=$(jq -r '.claudeAiOauth.accessToken // empty' "$HOME/.claude/.credentials.json" 2>/dev/null)
    fi

    if [[ -n "$oauth_token" && "$oauth_token" != "null" ]]; then
        usage_resp=$(curl -s --max-time 5 \
            -H "Accept: application/json" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $oauth_token" \
            -H "anthropic-beta: oauth-2025-04-20" \
            -H "User-Agent: claude-code/2.1.34" \
            "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)
        if [[ -n "$usage_resp" ]] && echo "$usage_resp" | jq -e '.five_hour' >/dev/null 2>&1; then
            echo "$usage_resp" > "$rate_cache"
        fi
    fi
fi

if [[ -f "$rate_cache" ]]; then
    usage_data=$(cat "$rate_cache" 2>/dev/null)
    if [[ -n "$usage_data" ]] && echo "$usage_data" | jq -e . >/dev/null 2>&1; then
        _bar() {
            local pct=$1 width=10
            [[ "$pct" -lt 0 ]] 2>/dev/null && pct=0
            [[ "$pct" -gt 100 ]] 2>/dev/null && pct=100
            local filled=$(( pct * width / 100 ))
            local empty=$(( width - filled ))
            local c
            if [[ "$pct" -ge 90 ]]; then c="\033[1;31m"
            elif [[ "$pct" -ge 70 ]]; then c="\033[1;33m"
            elif [[ "$pct" -ge 50 ]]; then c="\033[1;33m"
            else c="\033[1;32m"
            fi
            local f="" e=""
            for ((i=0;i<filled;i++)); do f+="●"; done
            for ((i=0;i<empty;i++)); do e+="○"; done
            printf "${c}${f}\033[2m${e}\033[0m"
        }
        _reset_time() {
            local iso="$1" style="$2"
            [[ -z "$iso" || "$iso" == "null" ]] && return
            local stripped="${iso%%.*}" ; stripped="${stripped%%Z}" ; stripped="${stripped%%+*}"
            local epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$stripped" +%s 2>/dev/null)
            [[ -z "$epoch" ]] && return
            case "$style" in
                time) date -j -r "$epoch" +"%l:%M%p" 2>/dev/null | sed 's/^ //; s/\.//g' | tr '[:upper:]' '[:lower:]' ;;
                datetime) date -j -r "$epoch" +"%b %-d, %l:%M%p" 2>/dev/null | sed 's/  / /g; s/^ //; s/\.//g' | tr '[:upper:]' '[:lower:]' ;;
            esac
        }
        _pct_color() {
            local p=$1
            if [[ "$p" -ge 90 ]]; then printf "\033[1;31m"
            elif [[ "$p" -ge 70 ]]; then printf "\033[1;33m"
            elif [[ "$p" -ge 50 ]]; then printf "\033[1;33m"
            else printf "\033[1;32m"
            fi
        }

        five_pct=$(echo "$usage_data" | jq -r '.five_hour.utilization // 0' | awk '{printf "%.0f", $1}')
        five_reset=$(_reset_time "$(echo "$usage_data" | jq -r '.five_hour.resets_at // empty')" "time")
        five_bar=$(_bar "$five_pct")

        seven_pct=$(echo "$usage_data" | jq -r '.seven_day.utilization // 0' | awk '{printf "%.0f", $1}')
        seven_reset=$(_reset_time "$(echo "$usage_data" | jq -r '.seven_day.resets_at // empty')" "datetime")
        seven_bar=$(_bar "$seven_pct")

        rate_segment=$(printf "\033[0m5h %s$(_pct_color $five_pct)%d%%\033[0m \033[2m⟳  %s\033[0m \033[2m│\033[0m 7d %s$(_pct_color $seven_pct)%d%%\033[0m \033[2m⟳  %s\033[0m" "$five_bar" "$five_pct" "$five_reset" "$seven_bar" "$seven_pct" "$seven_reset")

        output+="\n  ${rate_segment}"
    fi
fi

# Agents line last — always below path/cache and below rate bars.
if [[ -n "${agent_segment_rendered:-}" ]]; then
    output+=$(printf "\n  %s" "$agent_segment_rendered")
fi

# ── Ruflo deep-detail lines (daemon, swarm, learning, hot files) ──────
# Sourced entirely from ~/.claude/.claude-flow/ JSON files. Two lines max,
# each dropped if its data is empty. All jq calls are tiny (<5KB each).
if [[ -d "$ruflo_state_dir" ]]; then
    daemon_state="$ruflo_state_dir/daemon-state.json"
    swarm_state="$ruflo_state_dir/swarm/swarm-state.json"
    learning_metrics="$ruflo_state_dir/metrics/learning.json"
    insights_log="$ruflo_state_dir/data/pending-insights.jsonl"
    sessions_dir="$ruflo_state_dir/sessions"

    # ── Line A: daemon uptime · top workers · swarm topology · task list ──
    line_a=""

    # Daemon uptime
    if [[ -f "$daemon_state" ]]; then
        started_iso=$(jq -r '.startedAt // empty' "$daemon_state" 2>/dev/null)
        if [[ -n "$started_iso" ]]; then
            started_clean="${started_iso%%.*}"; started_clean="${started_clean%%Z}"
            started_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$started_clean" +%s 2>/dev/null)
            if [[ -n "$started_epoch" ]]; then
                up_s=$(( $(date +%s) - started_epoch ))
                if   [[ $up_s -ge 86400 ]]; then up_str="$((up_s/86400))d$(( (up_s%86400)/3600 ))h"
                elif [[ $up_s -ge 3600  ]]; then up_str="$((up_s/3600))h$(( (up_s%3600)/60 ))m"
                elif [[ $up_s -ge 60    ]]; then up_str="$((up_s/60))m"
                else                              up_str="${up_s}s"
                fi
                line_a+=$(printf "\033[2m⚙\033[0m \033[1;36mup %s\033[0m" "$up_str")
            fi
        fi

        # Top 3 workers by recent runs (role · runCount, dim if idle)
        worker_top=$(jq -r '
            .workers // {}
            | to_entries
            | sort_by(-(.value.runCount // 0))
            | .[0:3]
            | map(.key + "·" + ((.value.runCount // 0)|tostring))
            | join(" ")
        ' "$daemon_state" 2>/dev/null)
        if [[ -n "$worker_top" && "$worker_top" != "null" ]]; then
            [[ -n "$line_a" ]] && line_a+="\033[2m  │  \033[0m"
            line_a+=$(printf "\033[1;35m󰒋\033[0m \033[2m%s\033[0m" "$worker_top")
        fi
    fi

    # Swarm names + topology + capacity
    if [[ -f "$swarm_state" ]]; then
        swarm_summary=$(jq -r '
            (.swarms // {}) as $s
            | ($s | length) as $n
            | if $n == 0 then ""
              else
                ([$s | to_entries | .[] | (.value.name // .value.config.name // (.key | sub(".*-";"")))] | .[0:2] | join(",")) as $names
                | ([$s | to_entries | .[] | .value.topology // .value.config.topology // ""] | .[0]) as $topo
                | ([$s | to_entries | .[] | .value.maxAgents // .value.config.maxAgents // 0] | add) as $cap
                | ([$s | to_entries | .[] | (.value.agents // []) | length] | add) as $live
                | ($topo | sub("hierarchical";"hier")) as $tshort
                | "\($names)|\($tshort)|\($live)/\($cap)"
              end
        ' "$swarm_state" 2>/dev/null)
        if [[ -n "$swarm_summary" && "$swarm_summary" != "||0/0" ]]; then
            sw_names="${swarm_summary%%|*}"
            sw_rest="${swarm_summary#*|}"
            sw_topo="${sw_rest%%|*}"
            sw_cap="${sw_rest#*|}"
            [[ -n "$line_a" ]] && line_a+="\033[2m  │  \033[0m"
            line_a+=$(printf "\033[1;34m󰵅\033[0m \033[1;34m%s\033[0m" "$sw_names")
            [[ -n "$sw_topo" ]] && line_a+=$(printf " \033[2m%s\033[0m" "$sw_topo")
            [[ -n "$sw_cap" && "$sw_cap" != "0/0" ]] && line_a+=$(printf " \033[2m%s\033[0m" "$sw_cap")
        fi

        # In-flight task list (first 2 task names/types if any are non-completed)
        task_names=$(jq -r '
            [.swarms[]?.tasks[]? | select(.status != "completed" and .status != "failed")
             | (.name // .description // .type // "task")
             | (if length > 18 then .[0:16] + "…" else . end)
            ] | .[0:2] | join(", ")
        ' "$swarm_state" 2>/dev/null)
        if [[ -n "$task_names" && "$task_names" != "null" ]]; then
            [[ -n "$line_a" ]] && line_a+="\033[2m  │  \033[0m"
            line_a+=$(printf "\033[1;33m\033[0m \033[1;33m%s\033[0m" "$task_names")
        fi
    fi

    # ── Line B: learning · hooks fired · sessions · hot files ──
    line_b=""

    # Learning stats
    if [[ -f "$learning_metrics" ]]; then
        learn=$(jq -r '
            "\(.routing.accuracy // 0)|\(.routing.decisions // 0)|\(.patterns.shortTerm // 0)|\(.patterns.longTerm // 0)|\(.sessions.total // 0)"
        ' "$learning_metrics" 2>/dev/null)
        l_acc="${learn%%|*}"; rest="${learn#*|}"
        l_dec="${rest%%|*}"; rest="${rest#*|}"
        l_st="${rest%%|*}"; rest="${rest#*|}"
        l_lt="${rest%%|*}"; l_sess="${rest##*|}"
        if [[ "$l_dec" -gt 0 ]] 2>/dev/null || [[ "$l_lt" -gt 0 ]] 2>/dev/null; then
            line_b+=$(printf "\033[1;32m󰧠\033[0m \033[2mpat\033[0m \033[1;32m%s/%s\033[0m" "$l_st" "$l_lt")
            [[ "$l_dec" -gt 0 ]] 2>/dev/null && line_b+=$(printf " \033[2mroute\033[0m \033[1;32m%s%%\033[0m" "$l_acc")
        fi
    fi

    # Hooks fired (count of insight events) + recent rate
    if [[ -f "$insights_log" ]]; then
        hook_total=$(wc -l < "$insights_log" 2>/dev/null | tr -d ' ')
        if [[ "$hook_total" -gt 0 ]] 2>/dev/null; then
            [[ -n "$line_b" ]] && line_b+="\033[2m  │  \033[0m"
            line_b+=$(printf "\033[1;36m󰋙\033[0m \033[2mhooks\033[0m \033[1;36m%s\033[0m" "$hook_total")
        fi
    fi

    # Sessions + cumulative session count — disabled per user preference

    # Hot files (top 2 most-edited from pending-insights.jsonl)
    if [[ -f "$insights_log" ]]; then
        hot=$(jq -rs '
            [.[] | select(.type == "edit") | .file]
            | group_by(.) | map({f: .[0], c: length})
            | sort_by(-.c) | .[0:2]
            | map((.f | split("/") | .[-1]) + "×" + (.c|tostring))
            | join(" ")
        ' "$insights_log" 2>/dev/null)
        if [[ -n "$hot" && "$hot" != "null" ]]; then
            [[ -n "$line_b" ]] && line_b+="\033[2m  │  \033[0m"
            line_b+=$(printf "\033[1;31m\033[0m \033[2m%s\033[0m" "$hot")
        fi
    fi

    [[ -n "$line_b" ]] && output+=$(printf "\n  %b" "$line_b")
fi

# ── V3 dashboard lines (DDD/Swarm/Architecture/AgentDB) ─
# Reuse the cjs renderer; skip its header+separator (first 2 lines).
v3_lines=""
if command -v node >/dev/null 2>&1 && [ -f "$HOME/.claude/helpers/statusline.cjs" ]; then
    v3_lines=$(printf '%s' "$input" | node "$HOME/.claude/helpers/statusline.cjs" 2>/dev/null | tail -n +3)
fi

printf "%b\n" "$output"
[[ -n "$v3_lines" ]] && printf "%s\n" "$v3_lines"
