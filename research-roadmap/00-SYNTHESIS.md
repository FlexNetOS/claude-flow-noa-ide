# SwarmOps — Research Synthesis (2026-05-08)

5 research agents fanned out independently. This synthesizes their findings into action-ready buckets and surfaces the 1 strategic decision the user must make.

---

## CONVERGENCE — 6 themes all 5 agents (independently) point to

| # | Theme | Agents that flagged it |
|---|---|---|
| C1 | **`skipDangerousModePermissionPrompt: true` is a CRITICAL security flaw still live in `~/.claude/settings.json:421`. 5-minute fix.** | codebase-debt |
| C2 | **Search is solved; the next 10x is in (a) prompt-cache shaping and (b) daemon warm-mode** | perf-frontier, ecosystem-mapper, codebase-debt |
| C3 | **Differentiation is local infra (memory, vector search, hooks, real workers) — orchestration narrative is being commoditized by Anthropic Agent Teams** | upstream-watcher, ecosystem-mapper |
| C4 | **The marketing narrative is "I found a 46× perf bug in a 19k-star Claude tool" — engineering autobiography, NOT "fork pitch"** | adoption-strategy, upstream-watcher |
| C5 | **Don't Show HN now. Premature, weak narrative, burns the one-shot lever** | adoption-strategy, upstream-watcher |
| C6 | **Anthropic silently dropped prompt-cache TTL 1h→5min on March 6, 2026 — audit if SwarmOps explicitly sets `"ttl": "1h"` anywhere** | perf-frontier |

---

## CONFLICT — the 1 real strategic choice you have to make

| | Bet A: Credit Maximalist | Bet B: Functional Divergence |
|---|---|---|
| **Voiced by** | adoption-strategy | upstream-watcher |
| **Goal** | Optimize for PR #1828 merge | Be the fork burned devs switch to |
| **Bet** | Solo dev with no audience can't fight 19k-star upstream; bank reputation, not stars | Upstream is bus-factor 1, fast but unreviewed; window exists for "honest fork" |
| **Cost** | 1-3 months light PR follow-up | 6-12 months solo work, real burnout risk |
| **Survives upstream merge?** | ✅ Reputation portable | ❌ Loses raison d'être if PR merges |
| **Expected value (solo dev, no time)** | **High** | Medium with high variance |
| **Recommended for solo+spare-time** | YES (default) | Only if you'd build it as a hobby anyway |

**Hidden 3rd option (Bet C — what I recommend):** **Bet A + ship Tier 0/1 + ONE killer feature (Gap 1: replayable agent traces).** Replayable traces is a 2-week feature, no competitor has it, screenshottable for the eventual blog post, and survives an upstream merge as portable IP. Gives Bet A a backup story without committing to Bet B's burnout.

---

## TIER 0 — Ship now, regardless of strategic bet (~6 hours total)

Pure wins, zero architectural risk. None of these depend on which bet you pick.

| ID | Action | Effort | Why |
|---|---|---|---|
| **SEC-1** | Flip `skipDangerousModePermissionPrompt` to `false` in `~/.claude/settings.json:421` + add `doctor --strict` check | 5 min | **CRITICAL.** Prompt-injection-to-RCE chain currently open. |
| **DEAD-1** | Delete 28 empty `tmp.json` files: `find v3/@claude-flow -name 'tmp.json' -size 0 -delete` | 2 min | Cleans grep noise. |
| **DEAD-4** | Restore ruflo statusline OR document OpenIsland coexistence in `doctor --fix` output | 30 min | Currently every session is missing ruflo's statusline data. |
| **PERF-2** | Add `searchEntriesMulti(namespaces, ...)` to memory-bridge; collapse N+1 in `memory_search_unified` | 4 hours | Most-called search op currently does 6× the work. |
| **PERF-4** | Hoist 3 hot-path regexes to module scope (helpers-generator:291, error-handler:354, graph-analyzer:358) | 1 hour | Error-handler runs on every emitted log line. |
| **README-1** | Rewrite README hero (lines 1-30) with install command above benchmark table + recorded vhs/asciinema gif | 90 min | Current hero buries the lede; visitors close before scrolling. |
| **CACHE-AUDIT** | Grep SwarmOps for `"ttl"` and Anthropic API call sites; explicitly set `"ttl": "1h"` if absent | 1 hour | The March 6 silent regression may be costing us cache hits today. |
| **AWESOME-PR** | Submit PRs to 4 awesome-lists (hesreallyhim, jqueryscript, punkpeye, ComposioHQ) | 1 hour | Free, ~30+ stars over 6 months, zero downside. |

**Total: ~7 hours of work, gets immediate security/perf/positioning wins regardless of which bet you pick.**

---

## TIER 1 — Highest-ROI strategic plays (~5 days)

These are big enough to be a "release" and survive an upstream merge.

| ID | Action | Effort | Payoff |
|---|---|---|---|
| **STRAT-1** | Hoist `resolveInstallContext()` to `@claude-flow/shared/src/install-context.ts` | 1 day | Single source of truth replaces ~12 stale call sites; eliminates entire bug class. |
| **STRAT-2** | `ControllerCapabilities` interface; replace 22 duck-type probes in `memory-bridge.ts:131-1949` | 1.5 days | Typed contract; unblocks STRAT-4 (hooks.ts split). |
| **PROMPT-CACHE** | 3 explicit `cache_control` breakpoints (tools→system→CLAUDE.md), pin CLAUDE.md byte-for-byte, move RAG below cache, log usage ratio | 2-3 days | **50-90% input-token cost cut, 15-30% TTFT improvement, compounds on every dispatch.** |
| **CLASS-1** | Adopt `swallowError(label, err)` helper in 30 hottest catch blocks | 2 days | 3/8 PR-1828 bugs were swallowed-error degradations. The next 3 are still hiding. |

**Total: ~7 dev-days = a clear "v3.7.1-swarmops.1" release that's defensibly differentiated.**

---

## TIER 2 — Bet-dependent (pick AFTER you choose A/B/C)

### If Bet A (Credit Maximalist):
- Split PR #1828 into 5-8 single-concern PRs (rUv merges small surface area faster — see upstream-watcher's analysis of the 2026-03-17 batch)
- Polite weekly ping on each
- Write the bug-hunt blog post for distribution as portable career asset
- Calendar: June 7 reassessment

### If Bet B (Functional Divergence):
- **Gap 1 — Replayable agent traces**: Gantt-swimlane HTML viewer for swarm runs (2 weeks; no competitor has it)
- **Gap 4 — Cost telemetry**: instrument SendMessage + agent_execute with token counts; `swarmops cost estimate <task>` (2-4 weeks)
- **Local-model fallback**: harden Ollama path for the Pro/Max-blocked user segment after Anthropic's April 4 policy change (1-2 weeks)
- Daemon warm-mode hardening (1 week, perf-frontier P0)
- Risk: 200-500 hours over 6-12 months

### If Bet C (recommended hybrid):
- Tier 0 + Tier 1 (above)
- + ONLY Gap 1 (replayable traces) — the cheapest differentiation that survives an upstream merge
- + bug-hunt blog post drafted, held for trigger event
- Calendar: June 7 reassessment of A vs B based on PR signal

---

## SKIP / DEFER

- **WASM SIMD for cosine** — would be a regression vs current native NEON binding (perf-frontier section 6)
- **Cross-encoder reranking** — gains over-claimed; defer until measured need
- **Binary quantization** — defer until corpus crosses 5k entries
- **STRAT-3 schema envelope** — no migration pain today; save for v3.8.x
- **CLASS-5 ts-prune cleanup** — risk of breaking dynamic imports outweighs cosmetic gain
- **Discord / custom domain / Product Hunt** — premature for 0-star fork
- **Show HN** — wait for trigger (PR ignored 30+ days OR stronger narrative)

---

## OPEN QUESTIONS FOR THE USER

1. **Pick a strategic bet** (A / B / C-hybrid) — without this, Tier 2 is undefined
2. **Approve Tier 0 batch** (~7 hours of pure wins) — yes/no/cherry-pick which items
3. **Approve Tier 1 release plan** (~5 dev-days for v3.7.1-swarmops.1)
4. **If Bet C: greenlight Gap 1 replayable traces as the differentiation feature?**

Once these 4 are answered, I dispatch the execution swarm.
