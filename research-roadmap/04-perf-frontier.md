# 04 — Performance Frontier: Beyond "Search is Fast"

> Audit of where the next 10x in agent-dispatch wall-clock latency lives, given SwarmOps already has mxbai-embed-large (1024-d), HNSW search, 46x faster `memory_search` via DB pooling, and 130x faster cold start. Search is no longer the bottleneck — the rest of the dispatch pipeline is.

---

## Highest-ROI Perf Bets (ordered)

1. **Aggressive prompt-cache shaping for agent loops** — every agent dispatch wastes 70-90% of its prompt cost re-shipping CLAUDE.md + tool defs + system prompt. Restructure to 3 stable cache breakpoints (tools → system → CLAUDE.md/project context), keep dynamic memory/RAG below the breakpoint. Worth 50-90% input-token cost cut and ~200-500ms TTFT improvement on warm path. **Cost: 2-3 dev-days.** Single largest payoff in the whole list.
2. **Lazy-load `bin/cli.js` heavy deps + V8 startup snapshot** — current entry `await import`s the v3 CLI eagerly. Node v22 startup snapshot + deferring `hnswlib-node` / embeddings init until first use saves 80-200ms per spawn. **Cost: 3-5 dev-days.**
3. **Binary quantization of mxbai 1024-d vectors at >5k entries** — 32x storage, ~25-40x faster Hamming-distance prefilter, with ~96% recall retention validated by mixedbread themselves. RaBitQ adds 2-bit refinement for >99% recall. **Cost: 1 dev-week incl. benchmarking.**
4. **HNSW config audit (M=16, efC=200, efS=100 currently)** — current config is over-built for <10k entries, under-tuned for >100k. Tier the config by collection size; cut efSearch to ~50 for hot collections, push efC to 400 only for the persistent pattern store. **Cost: 1-2 days, mostly benchmarking.**
5. **Embedding cache + dedup of identical query strings** — agents re-embed the same task descriptions across runs. SHA-256-keyed LRU on the embedding call (mem + on-disk) eliminates 30-50% of embedding work in agentic loops. **Cost: 1 day.**

WASM SIMD for cosine and cross-encoder reranking are tempting but lower-priority — see sections 6 and 4 for why.

---

## 1. RaBitQ / Quantization for Embeddings

**State of the art (as of 2026):** RaBitQ (SIGMOD 2024, [arxiv:2405.12497](https://arxiv.org/abs/2405.12497)) is the current dominant theoretical-bound randomized binary quantization. Its successor, **Extended RaBitQ** (SIGMOD 2025, [arxiv:2409.09913](https://arxiv.org/pdf/2409.09913)), generalizes to 2-8 bit/dim and is what LanceDB, Elasticsearch (BBQ), and Weaviate (8-bit rotational) ship today. The reference implementation lives at the [VectorDB-NTU/RaBitQ-Library](https://vectordb-ntu.github.io/RaBitQ-Library/).

**The honest math for SwarmOps:**

- mxbai-embed-large @ 1024-d float32 = 4096 bytes/vector. At 10k entries that's only 40 MB resident — quantization buys little if memory is the only worry.
- The real win is **distance-compute speed**: a 1024-d cosine on float32 is ~512 multiply-adds (~1µs with SIMD). The same vector binary-quantized to 128 bytes is a single popcount of two 1024-bit strings = ~16 SSE2 ops, ~50ns. That's ~20-30x faster *per comparison*, which compounds during HNSW graph traversal (each query touches ~M × efSearch × log(N) nodes).
- mixedbread published numbers ([HF blog](https://huggingface.co/blog/embedding-quantization), [mxbai binary notebook](https://github.com/mixedbread-ai/binary-embeddings/blob/main/mxbai_binary_quantization.ipynb)): **96.45% recall retention with 32x storage savings, 24.76x average speedup**. The model was *explicitly trained for binary quantization stability* — this is rare and we should exploit it.
- RaBitQ vs naive binary on 1024-d: at 1-bit, RaBitQ matches naive binary recall (both ~96% for mxbai); the gain comes at 2-4 bits where RaBitQ recall hits 99-99.5% (within noise of float32) at 8-16x compression. See [LanceDB's RaBitQ writeup](https://www.lancedb.com/blog/feature-rabitq-quantization) — DBpedia-1M @ 768-d hit 96%+ recall@10 vs IVF_PQ's ~92%.

**Skepticism check:** the "32x compression" headline is real but the "40x faster retrieval" benchmark from mixedbread is brute-force search, not HNSW — HNSW gains less because graph traversal cost dominates over per-comparison cost. Realistic speedup on HNSW at 10k vectors is **3-5x query latency**, not 25x. Below ~5k entries the quantization overhead (encoding the query, two-stage rerank) eats the gain entirely.

**Recommendation for SwarmOps:** binary quantize once we cross 5k pattern-memory entries; use a two-stage retrieve (binary HNSW → top-100 → float32 rerank on the candidates). At 100k entries this is a no-brainer. At today's volumes we're not yet on the frontier this addresses.

**Estimated payoff for SwarmOps:** 3-5x search latency at 10k+ entries, 32x storage cut. Negligible at <1k entries.
**Implementation cost:** 1 dev-week including benchmarking against current float32 HNSW with mxbai's pre-baked binary quantization helper. Drop-in for the persistent pattern collection.

---

## 2. HNSW Tuning

**Current SwarmOps config** (per `/Users/h4ckm1n/dev/SwarmOps/v3/@claude-flow/memory/docs/AGENTDB-INTEGRATION.md`): `hnswM: 16, hnswEfConstruction: 200, hnswEfSearch: 100, metric: cosine`. This is hnswlib-node's "sane default" — neither bad nor optimal.

**What recent guidance recommends** ([OpenSearch tuning guide](https://opensearch.org/blog/a-practical-guide-to-selecting-hnsw-hyperparameters/), [Pinecone HNSW deep dive](https://www.pinecone.io/learn/series/faiss/hnsw/), [Weaviate ANN benchmarks](https://docs.weaviate.io/weaviate/benchmarks/ann)):

| Collection size | M | efConstruction | efSearch | Notes |
|-----------------|----|----------------|----------|-------|
| <1k | 8-12 | 100 | 32-50 | Linear scan often beats HNSW; build quality cheap, search depth wasted |
| 1k-10k | 16 | 100-200 | 32-64 | Current SwarmOps lives here. efSearch=100 is overkill — recall already saturates ~50 |
| 10k-100k | 16-24 | 200-300 | 64-128 | Sweet spot of M; recall delta vs M=32 < 0.5pp at 3x memory cost |
| 100k-1M | 24-32 | 300-400 | 128-256 | Where M matters; consider quantization in parallel |
| 1M+ | 32-64 | 400+ | 256+ | Disk-resident, paging cost dominates; consider IVF-PQ or DiskANN instead |

**Concrete deltas in published benchmarks** ([Zilliz HNSW config FAQ](https://zilliz.com/ai-faq/what-are-the-key-configuration-parameters-for-an-hnsw-index-such-as-m-and-efconstructionefsearch-and-how-does-each-influence-the-tradeoff-between-index-size-build-time-query-speed-and-recall)):
- M: 16→64 raises recall ~92%→98% but **3x memory and ~2x build time**.
- efSearch: 64→256 raises recall +1-2pp but query latency goes **1ms→5ms**.

**Skepticism check:** every tuning guide is benchmarked on SIFT1M / GIST1M / DEEP1M (768-1024 dim, real text embeddings). Numbers DO transfer to mxbai. But "recall@10 = 98%" headlines are gamed by recall floor — at <1000 vectors any sensible config hits 100%. The honest measurement is **recall vs latency Pareto** at *your* corpus size, which changes monthly as agents accumulate memories.

**Recommendation for SwarmOps:**
1. Tier configs per collection: `efSearch: 50` for transient session memory, `efSearch: 100` for the persistent pattern store, `efSearch: 200` only for the cross-session knowledge graph if/when it exists.
2. Build a `bin/cli.js perf bench-hnsw` subcommand that runs ann-benchmarks-style sweeps on the live corpus, not synthetic data. This lets us re-tune as the corpus grows past inflection points.
3. Don't chase M>16 yet. The marginal recall gain is below the noise floor of mxbai's intrinsic embedding quality.

**Estimated payoff for SwarmOps:** 30-60% reduction in HNSW search wall time on hot/transient collections by dropping efSearch from 100→50 (recall delta < 0.3pp at <10k vectors). At 100k+ entries, getting M wrong costs 2-3x latency.
**Implementation cost:** 1-2 dev-days including benchmark harness and per-collection config wiring.

---

## 3. Prompt-Cache Exploitation

This is the single most under-exploited lever. References: [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), the Anthropic engineering post [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything), and the [PromptHub comparison](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models).

**Hard facts as of 2026:**
- Default TTL is **5 minutes** as of March 6, 2026 (was 1 hour). Anthropic [silently dropped this](https://dev.to/whoffagents/anthropic-silently-dropped-prompt-cache-ttl-from-1-hour-to-5-minutes-16ao); 1h is opt-in via `"ttl": "1h"`.
- TTL is **refreshed on every cache hit** — so an active agent loop keeps its 5-min cache alive indefinitely at zero refresh cost.
- Maximum **4 cache breakpoints** per request. Auto-caching uses one slot.
- Minimum **1024 tokens per cache breakpoint** for Sonnet 4.5+ (Haiku is 2048). Below that, cache write silently no-ops.
- Cache writes cost 1.25x base (5m) or 2x base (1h). Cache reads cost **0.10x base**. Breakeven is ~2 hits at 5m TTL, ~4 hits at 1h TTL.
- Cache prefix matches on **byte-exact** content. Any timestamp, random ID, dict iteration order, or whitespace change busts everything downstream of it.

**Where SwarmOps almost certainly leaks money/latency right now:**

1. **CLAUDE.md is mutated/regenerated every session** by ruflo init / memory bridge. If CLAUDE.md changes byte-for-byte between agent dispatches, every dispatch is a cache miss + write (1.25x cost). Fix: pin a stable canonical CLAUDE.md hash per session, re-emit only on explicit reload.
2. **No explicit `cache_control` placement** for the agent prompt. The recommended layout for agent dispatches is:
   ```
   [tools]                              <- breakpoint 1 (rarely changes)
   [system prompt]                      <- breakpoint 2 (per-agent, stable)
   [CLAUDE.md + project context]        <- breakpoint 3 (per-project, stable)
   [retrieved memory + dynamic context] <- below breakpoint, NOT cached
   [conversation messages]              <- below breakpoint
   ```
   This way: tool changes invalidate everything (rare), system prompt changes invalidate seg 2-3 (rare), project changes invalidate seg 3 (per-repo), retrieval changes invalidate nothing cached.
3. **Memory search results injected at the top of the system message** instead of the bottom of user content destroys cache reuse — every dispatch has different RAG payload. Move RAG into a tagged user message *after* the cache breakpoint.
4. **Per-call random IDs / timestamps** in the system prompt (request IDs, "current time is...") bust the cache at the position where they appear. Hoist them below the last breakpoint, or omit if not load-bearing.

**Measuring it:** every Anthropic API response includes `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` — log the ratio per dispatch. Healthy agent loops should run **>80% cache-read ratio** after the first call. See [Start Debugging's measurement guide](https://startdebugging.net/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

**Skepticism check:** "90% cost reduction" from prompt caching is real but conditional. It assumes (a) high request frequency within TTL, (b) stable prefixes, (c) prefix is large enough to dominate cost (small prompts get marginal savings). Wall-clock latency improvement from caching is typically **15-30% TTFT cut**, not the dramatic numbers some blogs claim — the network round-trip and decode time still dominate for short outputs.

**Estimated payoff for SwarmOps:** 50-90% input-token cost reduction on agent loops; 15-30% TTFT improvement; cache-read ratio target >80%. Compounds on every dispatch.
**Implementation cost:** 2-3 dev-days. Audit current prompt assembly, place 3 explicit `cache_control` markers, refactor CLAUDE.md emission to be stable, add usage logging.

---

## 4. Embedding Batch + Cache Locality

**Two distinct issues, often conflated:**

### 4a. Re-embedding the same text

If the same task description ("research RaBitQ for SwarmOps") gets dispatched twice, mxbai is invoked twice. At ollama-local it's ~80-200ms per embedding for short text on M2; over Anthropic API it's irrelevant. Either way, free wins from a SHA-256-keyed LRU on the embed call.

**Recommendation:** wrap the embedding call with `lru-cache` (in-mem, ~1k entries) backed by a sqlite KV store. Keys are sha256(model_name + normalized_text). Hit ratio in agent loops is empirically 30-50% — especially for hooks-driven dispatches where the same triggers fire repeatedly.

### 4b. Lost-in-the-middle and retrieval reranking

The [original "Lost in the Middle" paper (TACL 2024, arxiv:2307.03172)](https://arxiv.org/abs/2307.03172) showed accuracy is U-shaped over context position — middle is worst. ICLR 2025 work on retrieval reordering ([proceedings PDF](https://proceedings.iclr.cc/paper_files/paper/2025/file/5df5b1f121c915d8bdd00db6aac20827-Paper-Conference.pdf)) and 2025 papers like [HERA](https://arxiv.org/html/2502.00448v1) and [ResRank](https://arxiv.org/html/2604.22180v1) confirm: **rank retrievals so highest-relevance items go at the start AND end of the context window, lowest-relevance in the middle.** Free lift, no model retraining.

For reranking specifically: BGE-reranker-v2-m3 (278M params) and ZeroEntropy zerank-1 are current SoTA per [Agentset's 2026 reranker leaderboard](https://www.zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025) and [Analytics Vidhya's top-7](https://www.analyticsvidhya.com/blog/2025/06/top-rerankers-for-rag/). Cross-encoder rerank adds **~8ms per query-doc pair on CPU**, ~525ms total for 64 candidates — measurable but not catastrophic.

**Skepticism check:** rerankers shine when the first-stage retriever surfaces noisy candidates. mxbai-embed-large is a strong retriever; on small corpora (<10k), the marginal NDCG@10 gain from a reranker is often 2-5pp, not the +28% headline numbers (which are measured on adversarial benchmarks). For most SwarmOps memory hits, top-5 from HNSW with no rerank is probably good enough. **Don't add a reranker until measurement shows top-K relevance is hurting agent decisions.**

**Recommendation for SwarmOps:**
1. Add embedding cache (SHA-256 LRU + sqlite). Cheap, immediate.
2. Reorder retrievals: highest-similarity at positions 0 and N-1 of the injected context block (the "sandwich" pattern). Free, well-supported.
3. Token-budget retrievals to ≤2k tokens of injected memory. More than that hurts more than it helps per the lost-in-the-middle data.
4. Defer cross-encoder reranking until measurement justifies it. The 100-500ms latency hit is real and not always recovered in agent decision quality.

**Estimated payoff for SwarmOps:** 30-50% reduction in embedding wall time via cache; 5-10% better agent decisions from reorder + budget. Reranker: defer.
**Implementation cost:** 1 day for cache+reorder. Reranker adds ~3 days if/when needed.

---

## 5. Agent Dispatch Latency: The Wall-Clock Audit

**Mental profile of one agent dispatch on a typical M2 Mac**, ordered by latency cost:

| Stage | Typical cost | Notes |
|-------|-------------|-------|
| Subprocess spawn (`fork`/`spawn`) | 10-20ms | OS-level, can't optimize |
| Node startup (cold) | 60-120ms | Significant on M2 — see Joyee Cheung's [macOS startup analysis](https://joyeecheung.github.io/blog/2025/01/11/executable-loading-and-startup-performance-on-macos/) |
| `import` resolution + module loading | 80-300ms | **Dominated by hnswlib-node native binding load (~50ms) and embedding-model client init**. Heaviest single contributor. |
| Tool registry build | 20-50ms | Should be deferrable |
| First MCP handshake | 30-80ms | Stdio framing + capability negotiation |
| Memory search (warm, after pool) | 5-15ms | Already optimized in SwarmOps |
| Embedding query (ollama local) | 80-200ms | Or ~200-400ms cold |
| Anthropic API: TTFT | 400-1200ms | Dominated by model + cache state |
| Anthropic API: full response | 2-15s | Output-token bound |

The dispatch sub-second budget is **already gone before the LLM is called**. Realistic wall-clock for "spawn agent → first useful output" is 2-4s on warm path, 4-8s cold.

**Where 100ms-class wins live:**

1. **Lazy-load `bin/cli.js`** — current entry does `await import(cliPath)` eagerly, which transitively pulls hnswlib-node, embedding clients, and the full v3 mcp stack. Refactor to a thin command-router shell that only loads the modules required for the dispatched subcommand. The classic "Node `require` is slow" problem documented since [Kevin Burke's writeup](https://kevin.burke.dev/kevin/node-require-is-dog-slow/) — saves 80-200ms on commands that don't need vector search.
2. **Node v22 startup snapshot + V8 code cache** — Node 22 supports building a single-executable application with `useSnapshot: true` and `useCodeCache: true` ([Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html)). Pre-deserializes the heap state. Savings on CLI tools are 50-150ms typical for medium-sized CLIs. Caveat: requires a build step and re-bundling discipline; native modules (hnswlib-node) can't go in the snapshot.
3. **MCP daemon mode (already partially in place)** — long-lived `npx claude-flow daemon start` amortizes the Node startup, hnswlib load, and DB pool warmup across all dispatches. Each subsequent dispatch is just a stdio message to the running daemon: ~5-15ms instead of ~300-500ms. **This is the single biggest realistic dispatch-latency win** if the daemon is reliably warm.
4. **Pre-resolve `ToolSearch` schema cache** — current model fetches deferred tool schemas on first use (~50-100ms per category). Pre-warming common categories at daemon startup is free.
5. **Connection pre-establishment** — keep the embedding model HTTP/2 connection alive (warm keep-alive). Saves the ~30-80ms TLS handshake on first embedding call per dispatch.

**Skepticism check:** there is zero magic bullet here. Each fix is 50-150ms. The cumulative ceiling is ~400ms saved on dispatch, dominated entirely by whether the daemon stays warm. If users invoke claude-flow as a one-shot from a fresh shell (cold path), the Node startup floor is unbeatable without rewriting in Rust/Go.

**Estimated payoff for SwarmOps:** Cold path: 200-400ms cut via lazy-load + snapshot. Warm path (daemon): 5-15ms steady-state instead of 300-500ms — that's the real 30x win. Re-prioritize daemon-mode reliability.
**Implementation cost:** Lazy-load: 3 dev-days. Snapshot: 2-3 days incl. build wiring (skip if it complicates native-module loading). Daemon hardening (auto-restart, health-check, supervisor): 1 dev-week, highest-leverage of the three.

---

## 6. WASM SIMD Frontier (and the FlashAttention Reality Check)

The "FlashAttention 2.49x-7.47x via WASM SIMD" claim circulating in the agent-tooling space is **misleading for our use case**. Let's unpack.

**What's actually true** ([Rust+WASM 2025 deep dive](https://dev.to/dataformathub/rust-webassembly-2025-why-wasmgc-and-simd-change-everything-3ldh), [byteiota WASM benchmarks](https://byteiota.com/rust-webassembly-performance-8-10x-faster-2025-benchmarks/)):
- WASM SIMD (128-bit fixed) hits 8-15x speedup vs pure JS for highly-parallelizable numeric kernels (matmul, dot product, image filters).
- WASM SIMD is roughly **4x slower than native AVX2** because Wasm is locked to 128-bit registers while AVX2 has 256-bit. Most "256-bit" intrinsics get emulated as two 128-bit ops. See [SimSIMD discussion](https://github.com/ashvardanian/SimSIMD) and [Sergey Davidoff's Rust SIMD 2025 state of the art](https://shnatsel.medium.com/the-state-of-simd-in-rust-in-2025-32c263e5f53d).
- FlashAttention's speedup is from **memory-access patterns** (tiling to fit into SRAM, avoiding HBM round-trips), not raw FLOPs. There is no analog for our use case — we're not running attention, we're running cosine similarity at <1024-d.

**For SwarmOps's hot path (HNSW cosine on mxbai vectors):**
- hnswlib-node already uses native SIMD via the underlying C++ library ([nmslib/hnswlib](https://github.com/nmslib/hnswlib)). On Apple Silicon it uses NEON (128-bit). We're already at "native 128-bit SIMD" — not "scalar JS".
- WASM SIMD would be a **regression** vs the current native binding (slower JS↔WASM marshaling, no AVX2 access).
- The `mcp__claude-flow__hooks_intelligence` tools claim Flash Attention 2.49x-7.47x — that speedup, if real, is for **batched cross-attention over long sequences**, not 1024-d cosine. Don't conflate them.

**Where WASM might actually help:**
- If we ever ship `claude-flow` to a browser (web playground, web-based dashboard), WASM hnswlib + SIMD becomes the only option. There's a [hnswlib-wasm npm package](https://www.npmjs.com/package/hnswlib-wasm) for this case.
- Edge/serverless deploys (Cloudflare Workers, Vercel Edge) where native bindings aren't allowed — WASM is the only path.
- Cross-platform binary distribution where shipping native `.node` files for every arch is painful.

**For binary quantization specifically**, WASM SIMD's `v128.popcnt` (Wasm SIMD opcode 0x7E:0x62, supported in Chrome 91+, Safari 16.4+) is competitive with native SSSE3 popcount. If we go binary, a 1024-bit popcount in WASM is ~16 ops, ~50ns — same as native. That's worth knowing for browser deployment but doesn't move the needle on Node.

**Skepticism check:** every "Nx faster via WASM SIMD" headline is benchmarked against a deliberately-bad pure-JS baseline. Against a well-tuned native module, WASM is at best parity, usually 1.5-3x slower. For workloads we already accelerate via `hnswlib-node`, WASM is not a frontier — it's a step backwards.

**Estimated payoff for SwarmOps:** Effectively zero on Node target. Material only if we ship to browser/edge runtimes where native modules are blocked.
**Implementation cost:** N/A for current targets. ~1 dev-week if we add a browser/edge deployment path, mostly to wire up `hnswlib-wasm` and validate recall parity.

---

## Summary Table

| # | Lever | Wall-clock impact | Cost | Priority |
|---|-------|-------------------|------|----------|
| 1 | Prompt-cache shaping (3 breakpoints, stable CLAUDE.md, RAG below cache) | -15-30% TTFT, -50-90% input cost, compounds | 2-3 dev-days | **P0** |
| 2 | Daemon warm-mode reliability + lazy-load `bin/cli.js` | -300ms cold, daemon stays at ~10ms steady-state (30x) | 1 dev-week | **P0** |
| 3 | Embedding cache (SHA-256 LRU + sqlite) | -30-50% embedding time on agent loops | 1 day | **P1** |
| 4 | HNSW config tier (efSearch=50 for transient, 100 for persistent) | -30-60% search wall time on hot path | 1-2 days | **P1** |
| 5 | Retrieval reorder (sandwich pattern) + 2k token budget | +5-10% agent decision quality, free | 0.5 day | **P1** |
| 6 | Binary quantization (mxbai pre-trained) at >5k entries | 3-5x search latency, 32x storage at scale | 1 dev-week | **P2** (defer until corpus warrants) |
| 7 | Cross-encoder reranker (BGE-v2-m3 / zerank-1) | +2-5pp NDCG@10, +100-500ms latency | 3 days | **P3** (defer until measured need) |
| 8 | WASM SIMD for cosine | Zero on Node; only relevant for browser/edge targets | N/A | **P4** |
| 9 | Node v22 startup snapshot | -50-150ms cold, conflicts with native modules | 2-3 days | **P3** (only if cold-path matters more than daemon mode) |

**Top-line read:** the next 10x is not in search — it's in (a) not paying the LLM tokenizer to re-process CLAUDE.md every dispatch, and (b) not paying the OS to re-fork Node every dispatch. Those two account for ~70% of agent wall-clock latency on warm SwarmOps installations today.

---

## References

- [RaBitQ paper (SIGMOD 2024)](https://dl.acm.org/doi/pdf/10.1145/3654970) | [Extended RaBitQ (SIGMOD 2025)](https://arxiv.org/pdf/2409.09913) | [VectorDB-NTU/RaBitQ-Library](https://github.com/VectorDB-NTU/Extended-RaBitQ)
- [Mixedbread: Binary and Scalar Embedding Quantization](https://huggingface.co/blog/embedding-quantization) | [mxbai binary notebook](https://github.com/mixedbread-ai/binary-embeddings/blob/main/mxbai_binary_quantization.ipynb)
- [LanceDB RaBitQ feature post](https://www.lancedb.com/blog/feature-rabitq-quantization) | [Elastic BBQ](https://www.elastic.co/search-labs/blog/better-binary-quantization-lucene-elasticsearch) | [Weaviate 8-bit rotational](https://weaviate.io/blog/8-bit-rotational-quantization)
- [OpenSearch HNSW hyperparameter guide](https://opensearch.org/blog/a-practical-guide-to-selecting-hnsw-hyperparameters/) | [Pinecone HNSW deep dive](https://www.pinecone.io/learn/series/faiss/hnsw/) | [Weaviate ANN benchmarks](https://docs.weaviate.io/weaviate/benchmarks/ann)
- [HNSW at Scale: Why Your RAG System Gets Worse](https://towardsdatascience.com/hnsw-at-scale-why-your-rag-system-gets-worse-as-the-vector-database-grows/) | [Zilliz HNSW config FAQ](https://zilliz.com/ai-faq/what-are-the-key-configuration-parameters-for-an-hnsw-index-such-as-m-and-efconstructionefsearch-and-how-does-each-influence-the-tradeoff-between-index-size-build-time-query-speed-and-recall)
- [Anthropic prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) | [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) | [How Prompt Caching Actually Works in Claude Code](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code)
- [Anthropic silently dropped prompt cache TTL from 1h to 5min](https://dev.to/whoffagents/anthropic-silently-dropped-prompt-cache-ttl-from-1-hour-to-5-minutes-16ao) | [Measuring cache hit rate](https://startdebugging.net/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) | [PromptHub caching comparison](https://www.prompthub.us/blog/prompt-caching-with-openai-anthropic-and-google-models)
- [Lost in the Middle paper (arxiv:2307.03172, TACL 2024)](https://arxiv.org/abs/2307.03172) | [ICLR 2025 retrieval reordering](https://proceedings.iclr.cc/paper_files/paper/2025/file/5df5b1f121c915d8bdd00db6aac20827-Paper-Conference.pdf) | [HERA](https://arxiv.org/html/2502.00448v1) | [ResRank](https://arxiv.org/html/2604.22180v1)
- [ZeroEntropy 2026 reranker guide](https://www.zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025) | [Top-7 rerankers (Analytics Vidhya)](https://www.analyticsvidhya.com/blog/2025/06/top-rerankers-for-rag/) | [Agentset reranker leaderboard](https://agentset.ai/rerankers)
- [Joyee Cheung: macOS startup performance](https://joyeecheung.github.io/blog/2025/01/11/executable-loading-and-startup-performance-on-macos/) | [Node SEA + startup snapshot docs](https://nodejs.org/api/single-executable-applications.html) | [Kevin Burke: Node require is dog slow](https://kevin.burke.dev/kevin/node-require-is-dog-slow/)
- [SimSIMD library](https://github.com/ashvardanian/SimSIMD) | [State of SIMD in Rust 2025](https://shnatsel.medium.com/the-state-of-simd-in-rust-in-2025-32c263e5f53d) | [Rust+WASM 2025: WasmGC and SIMD](https://dev.to/dataformathub/rust-webassembly-2025-why-wasmgc-and-simd-change-everything-3ldh) | [hnswlib-wasm npm](https://www.npmjs.com/package/hnswlib-wasm)
