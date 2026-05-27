# V3.10.1 Coordinated Swarm Audit — 2026-05-25

Run via `/v3-swarm-coordination`. 15 agents spawned (1 queen, 14 workers).
Target: `/home/ubuntu/ruflo` (claude-flow `v3.10.1`, already shipped — audit, not implementation).

> The skill's `SendMessage` coordination assumed a peer harness that isn't exposed to subagents in this environment. Workers reported back via task notifications and the lead synthesizes here in place of the queen.

## Top 5 Highest-Priority Items

1. **Plugin/IPFS signature verification is fake.** `v3/@claude-flow/cli/src/transfer/store/download.ts:287-317` claims Ed25519 but computes HMAC-SHA256 keyed with the "public" key — anyone with the published key can forge. The integrity falls back to `signature.length > 20 && publicKey.length > 20` on crypto exception (`:316`). Compounded by `int-arch`: registry-declared per-plugin `checksum`/`cid` are never verified at install — `manager.ts:134-209` shells out to `npm install` and trusts npm. Replace with real Ed25519 using the existing `RvfaSigner` and wire checksum validation into the install path.
2. **CI is structurally non-blocking.** `.github/workflows/ci.yml` has `continue-on-error: true` on every gate (audit, test, typecheck, coverage, smoke). No PR can fail. Combined with vitest@^4.0.16's `__vite_ssr_exportName__` ESM glitch (silent test failures in `json-security.ts`, `pg-utils.ts`, `plugins/src/security/index.ts`), the project has zero quality floor. 1-line per gate.
3. **EWC++ is a stub masquerading as a feature.** `sona-manager.ts:200-203` initializes `fisher`/`means` as empty `new Map()`; no code path ever populates them. `computeEWCPenalty` / `computeEWCLoss` / `consolidateEWC` all iterate empty maps and return 0. The "prevents catastrophic forgetting" claim is currently false. Either implement Fisher-info population or remove the claim from CLAUDE.md and ADRs.
4. **MCP HTTP transport defaults unsafe.** CORS `'*'` + `credentials:true` (`http.ts:220`), auth is opt-in (`enabled !== false` is the gate), `--host 0.0.0.0` accepted without forcing auth+TLS, TLS config (`tlsEnabled/tlsCert/tlsKey`) is dead code never read by `HttpTransport.start()`. 340 tools all share one bearer namespace with no per-tool scopes. Refuse non-loopback bind without auth+TLS; wire the TLS config.
5. **Pervasive documentation drift.** CLAUDE.md vs reality: 26 commands → **40**; 17 hooks → **33**; 12 workers documented vs **11 implemented (disjoint set names)**; Flash Attention "2.49x-7.47x" is a hardcoded string in `integration/src/index.ts:454`, not a measurement; SONA `<0.05ms` is fabricated downstream of upstream's `<1ms` claim; SECURITY.md still lists 3.5.x as supported (current is 3.10.x) with two conflicting contact emails. Reconcile or stop publishing the table.

---

## Security (3 agents)

### sec-arch
8 architectural gaps in v3.10.1: (1) inter-agent SendMessage trusts caller-supplied `fromId` with no signing (`SwarmCoordinator.sendMessage:283`, `teammate-bridge.ts:1075`); (2) mailbox is a shared-FS authority sink with no ACLs/audit; (3) MCP HTTP unsafe-by-default (CORS `'*'`, auth opt-out, no loopback enforcement); (4) MCP tool surface lacks capability scoping — token compromise = full RCE across 300+ tools; (5) plugin trust ends at registry signature — installed plugins run unsandboxed with `console.warn` only (`manager.ts:332`); (6) "community" + "official" registries share the same `publicKey`/`ipnsName` — tier separation is theater; (7) `TRUSTED_EMAIL_HEADER` auth (`auth.ts:409`) has no documented reverse-proxy requirement; (8) `AdminTokenManager.adminSessions` is in-memory, unbounded, non-distributed — admin auth silently breaks horizontally.

### sec-impl
**HIGH-1/2** broken sig verification in `transfer/store/download.ts` + `publish.ts` (HMAC-as-Ed25519, length-only fallback). **HIGH-3** path traversal in `download.ts:322` + `rvfa-distribution.ts:368` — `pattern.name` joined into cache dir with no traversal guard. **HIGH-4** `rvfa-runner.ts:149` executes attacker-controlled `boot.entrypoint` from RVFA header. **MED**: `execSync('...', { shell: true })` in builder (no injection today, switch to `execFileSync`); zip-bomb in `rvfa-format.ts:344` (no `originalSize` cap on gzip sections); CFP deserialization lacks schema validation; SSRF in `rvfa-distribution.ts:107` (redirect host not validated). Already-clean modules: `path-validator.ts`, `safe-executor.ts`, `input-validator.ts`, `rvfa-signing.ts` — the model `download.ts` should adopt.

### sec-test
Inventory: 8 security test files (security pkg has all 6 src modules covered; security-audit.test.ts passes 25/25). Gaps: DDD layer (`security-domain-service`, `security-application-service`, `security-context`) untested; `CVE-REMEDIATION.ts` no regression coverage; `shared/src/security/{input-validation,secure-random}.ts` zero tests; `mcp/src/oauth.ts` + `session-manager.ts` untested. **vitest@^4.0.16 ESM glitch** silently fails 5 tests via `__vite_ssr_exportName__ is not defined` — config fix (downgrade or `server.deps.inline`) is ~15min. `test:security` script points to a real workspace; the empty `v3/__tests__/security/` dir is unused and should be removed.

## Core (5 agents)

### core-arch
Bounded-context violation: `cli/src/infrastructure/in-memory-repositories.ts:9-20` imports `swarm/src/domain/*` via `'../../../swarm/...'`. Delta: re-export through `@claude-flow/shared/types`. **Files vastly over 500-LoC limit:** `commands/hooks.ts` (5329), `mcp-tools/hooks-tools.ts` (4188), `memory/memory-initializer.ts` (2991), `memory/memory-bridge.ts` (2424), `commands/analyze.ts` (2343). Memory-bridge ships 8 public `Promise<any>` returns — highest-leverage typing fix. No circular deps. `shared/src → cli/src` = 0 imports (clean but under-used).

### core-impl
Confirms file-size offenders (`hooks.ts` 5329, etc.); functions >100 lines in `init/executor.ts` (`writeCapabilitiesDoc` ~424) and `memory/memory-initializer.ts` (`initializeMemoryDatabase` ~218). 27 `as any` in non-test code (mostly WASM/ruvllm/agentic-flow boundary shims; `mcp-server.ts:634` `(this as any)._mcpServer = mcpServer` is internal). Zero real TODO/FIXME in scope. Dead exports: `_resetMemoryRootCache` (memory-initializer.ts:69), `v3ConfigToSystemConfig` (config-adapter.ts:74).

### mem-spec
HNSW exists twice: local `hnsw-index.ts` (in `agentdb-adapter`, `consolidator`) **and** AgentDB controller — no preflight check. `isHnswlibAvailable` imported but never called. **Quantization NOT wired through public API**: `QuantizationConfig` exists but no `UnifiedMemoryServiceConfig`/`AgentDBAdapterConfig`/`createDatabase()` accepts it. The "3.92x Int8" claim is unreachable from public surface. TTL is passive — only filtered at query time (`sqlite-backend.ts:410`); `MemoryConsolidator.sweepExpired` exists but `autoRun:true` is opt-in (6h interval). `safeJsonParse` covers row paths only — raw `JSON.parse` on disk-sourced JSON remains in `rvf-backend.ts:585,602`, `migration.ts:185,234,295,590`, `database-provider.ts:404`, `rvf-learning-store.ts:361`, `agentdb-adapter.ts:1144`, `rvf-migration.ts:107,185`. Proto-pollution guard bypassed on every file-backed load path.

### swarm-spec
**Unification incomplete: 5 coordinators.** `unified-coordinator.ts` (1844) + `queen-coordinator.ts` (2025, independent, no delegation) + `coordination/swarm-hub.ts` (776, deprecated facade) + `federation-hub.ts` (979) + `attention-coordinator.ts` (1000). `message-bus.ts`: no back-pressure (silent low-priority drop at `maxQueueSize` 10000, `:351-353`); no message size limit anywhere. **Consensus: 3 of 5 real.** `raft`/`byzantine`/`gossip` are real; `paxos` is a stub silently falling back to Raft (`consensus/index.ts:107`); `crdt` has zero matches under `src/`; `quorum` is a boolean config flag, not an algorithm. `CONSENSUS_ALGORITHMS` const only lists 4. "hierarchical-mesh" topology referenced in CLAUDE.md doesn't exist in `topology-manager.ts`. Zero `drift`/`antiDrift` code matches.

### mcp-spec
340 unique tool names across `mcp-tools/`. `ToolRegistry.execute()` enforces Ajv schema validation — but many schemas use loose `type: "string"` without `pattern`/`maxLength`. **2 tool files have no validation imports**: `managed-agent-tools.ts`, `progress-tools.ts`. `--host` flag accepts any string unchecked. Auth opt-in only. TLS config dead. CORS `'*'` + `credentials:true` (browsers reject combo, but signals lax defaults). Per-request metrics recorded; no p95/p99, no SLO gate behind the <100ms claim.

## Integration (3 agents)

### int-arch
ADR-001 ("eliminate 10,000+ duplicate lines via agentic-flow") **not met**. `agentic-flow` declared only as `optionalDependencies` on cli and `peerDependency` on integration; root pins `agentic-flow@^2.0.13`, cli `^3.0.0-alpha.1` — version split. Bridge code (`services/agentic-flow-bridge.ts`) delegates correctly, but `v3/@claude-flow/integration/src/` ships ~12,805 LOC including `multi-model-router.ts` (1079) + `provider-adapter.ts` (1168) that reimplement agentic-flow/router responsibilities and never import it. Registry Ed25519 verification of the registry JSON itself is correctly fail-closed against a pinned `publicKey` — but per-plugin `checksum`/`cid` are decorative; `installFromNpm` trusts npm. `community-plugins` shares `publicKey` with `claude-flow-official`.

### cli-hooks
Counts vs docs: **40 commands** (docs: 26), **33 hook subcommands** (docs: 17), **11 implemented workers** (docs: 12, disjoint name sets — documented `ultralearn/optimize/audit/map/...` vs implemented `performance/health/swarm/git/learning/adr/ddd/security/patterns/cache/v3progress`). Hook handler `.claude/helpers/hook-handler.cjs:285` forces `process.exit(0)` in `.finally()` → fail-open by design except `pre-bash`. `pre-bash` denylist is 4 literal-substring matches (`rm -rf /`, `format c:`, `del /s /q c:\`, `:(){:|:&};:`) — trivially bypassed by `rm -rf  /` (double space), `bash -c "rm -rf /"`, base64 piping, etc. CLI-invoked hooks return `exitCode 1` on MCP error (fail-closed), Claude-Code-invoked hooks swallow → opposite failure modes. `doctor --fix` is a misnomer — only prints suggestions; `--install` is the mutating flag. MCP "backend" is in-process; "unreachable backend" can't actually occur.

### neural-dev
**Shipped:** `FlashAttention` class (857 LoC, real benchmark method), SONA native binding via `@ruvector/sona`, ReasoningBank (AgentDB-backed, 1362 LoC), ONNX embeddings via `@huggingface/transformers`. **Claimed but not shipped:** SONA `<0.05ms` is fabricated (upstream claims `<1ms`; tests assert `<10ms`). **EWC++ is a stub** — empty Fisher/means maps; `computeEWCPenalty`/`computeEWCLoss`/`consolidateEWC` all iterate empty data → always 0. Flash Attention "2.49x-7.47x" is a hardcoded string in `integration/src/index.ts:454`, not measurement; `AttentionCoordinator` local path is `case 'flash': break;`. ONNX model downloaded from upstream HF with no checksum/signature verification in ruflo path.

## Quality / Performance / Release (3 agents)

### tdd-eng
250 test files / 25 v3 packages. **Coverage thresholds disabled globally** ("disabled for alpha" comment in `v3/vitest.config.ts`); only `performance/vitest.config.ts` has thresholds. Packages with effectively-zero tests: `cli-core` (0, but **published** as `^3.7.0-alpha.5` dep of root), `aidefence` (1 test / 876 LoC), `providers` (1 test / 4475 LoC — every LLM provider class untested), `deployment` (1 test / 963 LoC). 14+ files >1k LoC have no matching test (`hooks.ts` 5329, `analyze.ts` 2343, `memory-initializer.ts` 2991, `neural.ts` 1792, `unified-coordinator.ts` 1844). Only `security/` and `plugin-iot-cognitum/` separate `__tests__/{unit,integration}/` cleanly. **One** E2E test in the whole repo (browser).

### perf-eng
6 perf claims: **1 PROVEN** (CLI startup — `cli-core-cold-cache.json` records 671ms cold / 361ms warm against 500ms target). **3 PARTIAL** (HNSW 150x-12500x — bench caps at 10k vectors; Int8 3.92x — arithmetic test on synthetic vector, not workload; Flash Attention — harness exists, no committed result file). **2 NOT PROVEN** (MCP <100ms — bench is `setTimeout`-stubbed transport init, not real request latency; SONA <0.05ms — only a mocked `<10ms` assertion that explicitly says "actual SONA is <0.05ms"). End-to-end benches missing for the two latency-sensitive claims.

### release-eng
**P0:** `ruflo/package.json` at `3.10.2` while root + `@claude-flow/cli` are `3.10.1` (CLAUDE.md mandates uniform); `package-lock.json` still records `3.7.0-alpha.80`; root `package.json` `files[]` lists `v3/@claude-flow/guidance/dist/**` which **does not exist** (only `src/`) — `npm pack` will silently omit; root `main: "dist/index.js"` doesn't exist (programmatic import fails). **P1:** `ci.yml` has `continue-on-error: true` on every gate; no publish workflow despite three-package ritual in CLAUDE.md; `SECURITY.md` lists supported `3.5.x` (current 3.10.x) with two conflicting contact emails (`security@cognitum.one` vs `security@ruv.io`). **P2:** `ruflo/package.json` overrides diverge from root (missing pins for `vite`, `axios`, `fast-uri`, `ws`, `hono`, `express`, `qs`, `express-rate-limit`; `protobufjs` major mismatch) — exactly the #2112 regression the doc warns about.

## Agents that did not report

None — all 14 worker agents completed and returned punch lists. Queen subagent exited early after creating the output dir (no `SendMessage` mechanism to wait on); lead synthesized in its place.
