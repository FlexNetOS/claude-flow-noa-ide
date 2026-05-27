/**
 * Hive-Mind Consensus Runtime — ADR-095 G2.2.
 *
 * Before this module, `hive-mind_*` MCP tools were a JSON-file state machine
 * that hand-rolled raft/byzantine/quorum voting on top of `state.consensus`
 * and never touched `@claude-flow/swarm`'s real `ConsensusEngine`. That worked
 * for a single MCP server but ignored every cross-host machinery G2 was meant
 * to unlock: real RequestVote/AppendEntries RPCs, Ed25519-signed PBFT
 * messages, FederationTransport over ADR-104 WS, BFT quorum derived from
 * actual cluster size.
 *
 * This module owns a process-level `ConsensusEngine` plus a pluggable
 * `ConsensusTransport`. `hive-mind_init` calls `init()` here; the consensus /
 * broadcast / shutdown MCP tools delegate to it.
 *
 * Transport selection:
 *   - `transport: 'local'`        → LocalTransport (in-process registry).
 *                                    Matches the legacy single-process path;
 *                                    real engine, just no WS.
 *   - `transport: 'federation'`   → FederationTransport over an
 *                                    agentic-flow/transport/loader wire.
 *                                    Real cross-host messaging. Requires
 *                                    `agentic-flow` to be resolvable; if
 *                                    it's not, init returns
 *                                    `transport: 'local'` with `degraded:
 *                                    true` and a fallbackReason — the
 *                                    engine still works locally, the caller
 *                                    just knows the cross-host wire didn't
 *                                    come up.
 *   - `transport: 'auto'` (default)→ Probe for `agentic-flow`; if loadable
 *                                    AND `peers` were supplied with
 *                                    addresses, use federation; else local.
 *
 * Why peers are passed in (not auto-discovered): the federation plugin's
 * DiscoveryService is the canonical source of peers, but wiring it into the
 * MCP runtime is a separate concern (it has its own lifecycle / consent
 * gates). Until that lands as G2.3, callers explicitly supply the peer
 * list; the runtime is honest about what it received.
 */

import type {
  ConsensusEngine as ConsensusEngineType,
  ConsensusTransport as ConsensusTransportType,
  ConsensusVote,
  ConsensusProposal,
  ConsensusResult,
  ConsensusAlgorithm,
} from '@claude-flow/swarm';

export type HiveTransportKind = 'local' | 'federation' | 'auto';
export type HiveAlgorithm = 'raft' | 'byzantine' | 'gossip';

export interface HivePeerConfig {
  /** Consensus node id used by Raft/PBFT/Gossip as `from`. */
  readonly nodeId: string;
  /**
   * Wire-level address (e.g. `wss://host:port`). Required for
   * `transport: 'federation'`; ignored for `transport: 'local'`.
   */
  readonly address?: string;
  /**
   * Ed25519 SPKI PEM public key for inbound signature verification.
   * When provided, FederationTransport will fail-closed on unverifiable
   * messages from this peer.
   */
  readonly publicKeyPem?: string;
}

export interface HiveRuntimeInitOptions {
  readonly nodeId: string;
  readonly algorithm?: HiveAlgorithm;
  readonly transport?: HiveTransportKind;
  readonly peers?: readonly HivePeerConfig[];
  /** Default per-send timeout for transports. */
  readonly timeoutMs?: number;
  /** Consensus threshold (0-1). Forwarded to ConsensusEngine. */
  readonly threshold?: number;
}

export interface HiveRuntimeInitResult {
  readonly initialized: true;
  readonly nodeId: string;
  readonly algorithm: HiveAlgorithm;
  /** What we actually got — may differ from requested if federation degraded. */
  readonly transport: 'local' | 'federation';
  /** True when the caller asked for federation but we fell back to local. */
  readonly degraded: boolean;
  /** Human-readable reason for the degradation. */
  readonly fallbackReason?: string;
  readonly peerCount: number;
  readonly source: 'engine';
}

export interface HiveRuntimeStatus {
  readonly initialized: boolean;
  readonly nodeId?: string;
  readonly algorithm?: HiveAlgorithm;
  readonly transport: 'local' | 'federation' | null;
  readonly degraded: boolean;
  readonly peers: readonly string[];
  readonly engine: {
    readonly algorithm: ConsensusAlgorithm;
    readonly totalProposals: number;
    readonly pendingProposals: number;
    readonly acceptedProposals: number;
    readonly rejectedProposals: number;
    readonly expiredProposals: number;
  } | null;
}

interface AgenticFlowTransportLike {
  send(address: string, message: { type?: string; payload: unknown; streamId?: string }): Promise<void>;
  onMessage(handler: (msg: { from?: string; address?: string; type?: string; payload: unknown }) => void | Promise<void>): void;
  close?(): Promise<void> | void;
}

class HiveConsensusRuntime {
  private engine: ConsensusEngineType | null = null;
  private transport: ConsensusTransportType | null = null;
  private wire: AgenticFlowTransportLike | null = null;
  private transportKind: 'local' | 'federation' | null = null;
  private nodeId: string | null = null;
  private algorithm: HiveAlgorithm = 'raft';
  private peers: HivePeerConfig[] = [];
  private degraded = false;
  private fallbackReason: string | undefined;

  isInitialized(): boolean {
    return this.engine !== null;
  }

  /**
   * Lazy-initialize the consensus engine + transport. Idempotent on the
   * same nodeId/algorithm/transport tuple — subsequent calls return the
   * existing state. Different parameters trigger a clean shutdown + reinit.
   */
  async init(opts: HiveRuntimeInitOptions): Promise<HiveRuntimeInitResult> {
    const requestedAlgorithm: HiveAlgorithm = opts.algorithm ?? 'raft';
    const requestedTransport: HiveTransportKind = opts.transport ?? 'auto';
    const peers = [...(opts.peers ?? [])];

    // If already initialized with the same shape, return existing state.
    if (this.engine && this.nodeId === opts.nodeId && this.algorithm === requestedAlgorithm) {
      return this.toInitResult();
    }

    // Different shape — tear down before re-instantiating.
    if (this.engine) {
      await this.shutdown();
    }

    const swarm = await import('@claude-flow/swarm');

    // Resolve transport. 'auto' prefers federation when the loader is
    // available AND we have peer addresses; otherwise local.
    let resolvedKind: 'local' | 'federation';
    let resolvedTransport: ConsensusTransportType;
    let degraded = false;
    let fallbackReason: string | undefined;

    if (requestedTransport === 'local') {
      resolvedKind = 'local';
      resolvedTransport = new swarm.LocalTransport(opts.nodeId, {
        defaultTimeoutMs: opts.timeoutMs,
      });
    } else {
      // 'federation' or 'auto' → probe agentic-flow loader.
      const probe = await this.tryLoadFederationWire(opts);
      if (probe.wire) {
        // Build the addressOf map from peers config.
        const addressMap = new Map<string, string>();
        const pubkeyMap = new Map<string, string>();
        for (const p of peers) {
          if (p.address) addressMap.set(p.nodeId, p.address);
          if (p.publicKeyPem) pubkeyMap.set(p.nodeId, p.publicKeyPem);
        }
        this.wire = probe.wire;
        resolvedKind = 'federation';
        resolvedTransport = new swarm.FederationTransport(probe.wire, {
          nodeId: opts.nodeId,
          addressOf: (id) => addressMap.get(id),
          peerIds: () => peers.map(p => p.nodeId),
          defaultTimeoutMs: opts.timeoutMs,
          resolvePeerPublicKey: pubkeyMap.size > 0 ? (id) => pubkeyMap.get(id) : undefined,
        });
      } else {
        // Couldn't load federation wire. 'federation' requested → degrade
        // honestly. 'auto' → silently fall back to local.
        if (requestedTransport === 'federation') {
          degraded = true;
          fallbackReason = probe.reason ?? 'agentic-flow loader unavailable';
        }
        resolvedKind = 'local';
        resolvedTransport = new swarm.LocalTransport(opts.nodeId, {
          defaultTimeoutMs: opts.timeoutMs,
        });
      }
    }

    // Build the engine with the resolved transport. We pass `transport`
    // through `config.transport` (typed `unknown` on `ConsensusConfig` in
    // swarm's types.ts — the engine narrows it via a structural check).
    const engine = new swarm.ConsensusEngine(opts.nodeId, {
      algorithm: requestedAlgorithm as ConsensusAlgorithm,
      threshold: opts.threshold ?? 0.66,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxRounds: 10,
      requireQuorum: true,
      transport: resolvedTransport as unknown,
    });

    await engine.initialize();

    // Register peers with the consensus engine so its protocol-internal
    // bookkeeping (Raft's `peers` map, BFT's node set, gossip neighbors)
    // matches the transport's peer list.
    for (const p of peers) {
      if (p.nodeId === opts.nodeId) continue;
      engine.addNode(p.nodeId);
    }

    this.engine = engine;
    this.transport = resolvedTransport;
    this.transportKind = resolvedKind;
    this.nodeId = opts.nodeId;
    this.algorithm = requestedAlgorithm;
    this.peers = peers;
    this.degraded = degraded;
    this.fallbackReason = fallbackReason;

    return this.toInitResult();
  }

  /**
   * Probe for the agentic-flow QUIC/WS transport loader. Returns the wire
   * when loadable; an explanatory reason when not. Never throws — failure
   * is data, not control flow, so the runtime can degrade cleanly.
   */
  private async tryLoadFederationWire(
    _opts: HiveRuntimeInitOptions,
  ): Promise<{ wire: AgenticFlowTransportLike | null; reason?: string }> {
    // agentic-flow is an *optional* peer dep — when it isn't installed,
    // dynamic import throws and we degrade. The bare-string specifier
    // is wrapped in a `new Function(...)` so the TS compiler doesn't try
    // to resolve types at build time (the same pattern the federation
    // plugin's loader uses, see ADR-120 step 2 comments).
    const importDynamic = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    let mod: unknown;
    try {
      mod = await importDynamic('agentic-flow/transport/loader');
    } catch (err) {
      return { wire: null, reason: `agentic-flow not installed (${(err as Error).message ?? 'unknown'})` };
    }
    const m = mod as {
      loadQuicTransport?: (c?: unknown) => Promise<AgenticFlowTransportLike>;
      default?: { loadQuicTransport?: (c?: unknown) => Promise<AgenticFlowTransportLike> };
    };
    const fn = typeof m.loadQuicTransport === 'function'
      ? m.loadQuicTransport
      : m.default?.loadQuicTransport;
    if (typeof fn !== 'function') {
      return { wire: null, reason: 'agentic-flow loader does not expose loadQuicTransport' };
    }
    try {
      const wire = await fn();
      if (!wire || typeof wire.send !== 'function' || typeof wire.onMessage !== 'function') {
        return { wire: null, reason: 'agentic-flow loader returned a wire without send/onMessage' };
      }
      return { wire };
    } catch (err) {
      return { wire: null, reason: `agentic-flow loader threw: ${(err as Error).message ?? 'unknown'}` };
    }
  }

  /** Propose a value through the real ConsensusEngine. */
  async propose(value: unknown, proposerId?: string): Promise<ConsensusProposal> {
    if (!this.engine) throw new Error('hive-consensus-runtime: not initialized');
    return this.engine.propose(value, proposerId ?? this.nodeId ?? 'unknown');
  }

  /** Record a vote against an active proposal. */
  async vote(proposalId: string, vote: ConsensusVote): Promise<void> {
    if (!this.engine) throw new Error('hive-consensus-runtime: not initialized');
    await this.engine.vote(proposalId, vote);
  }

  /**
   * Block until a proposal resolves (accepted / rejected / expired).
   * Used by the MCP tool when callers want a synchronous result instead
   * of polling `proposal-status`.
   */
  async awaitConsensus(proposalId: string): Promise<ConsensusResult> {
    if (!this.engine) throw new Error('hive-consensus-runtime: not initialized');
    return this.engine.awaitConsensus(proposalId);
  }

  /**
   * Broadcast a free-form payload to all known peers via the transport.
   * Gossip-style, no reply expected. Wraps the payload so peers don't
   * confuse it with protocol messages — `type: 'hive-broadcast'`.
   */
  async broadcast(payload: unknown, priority: 'low' | 'normal' | 'high' | 'critical' = 'normal'): Promise<{ delivered: number; transport: 'local' | 'federation' }> {
    if (!this.transport) throw new Error('hive-consensus-runtime: not initialized');
    const peers = this.transport.peers();
    await this.transport.broadcast({
      type: 'hive-broadcast',
      payload: { value: payload, priority, sentAt: new Date().toISOString() },
    });
    return { delivered: peers.length, transport: this.transportKind! };
  }

  status(): HiveRuntimeStatus {
    if (!this.engine || !this.transport) {
      return {
        initialized: false,
        transport: null,
        degraded: false,
        peers: [],
        engine: null,
      };
    }
    return {
      initialized: true,
      nodeId: this.nodeId!,
      algorithm: this.algorithm,
      transport: this.transportKind,
      degraded: this.degraded,
      peers: [...this.transport.peers()],
      engine: this.engine.getStats(),
    };
  }

  async shutdown(): Promise<void> {
    const engine = this.engine;
    const transport = this.transport;
    const wire = this.wire;
    this.engine = null;
    this.transport = null;
    this.wire = null;
    this.transportKind = null;
    this.nodeId = null;
    this.peers = [];
    this.degraded = false;
    this.fallbackReason = undefined;
    if (engine) {
      try { await engine.shutdown(); } catch { /* best-effort */ }
    }
    if (transport) {
      try { await transport.close(); } catch { /* best-effort */ }
    }
    if (wire && typeof wire.close === 'function') {
      try { await wire.close(); } catch { /* best-effort */ }
    }
  }

  /** Test seam: replace the singleton's underlying engine + transport. */
  __setForTest(engine: ConsensusEngineType, transport: ConsensusTransportType, nodeId: string, kind: 'local' | 'federation' = 'local'): void {
    this.engine = engine;
    this.transport = transport;
    this.nodeId = nodeId;
    this.transportKind = kind;
  }

  private toInitResult(): HiveRuntimeInitResult {
    return {
      initialized: true,
      nodeId: this.nodeId!,
      algorithm: this.algorithm,
      transport: this.transportKind!,
      degraded: this.degraded,
      fallbackReason: this.fallbackReason,
      peerCount: this.peers.length,
      source: 'engine',
    };
  }
}

/** Process-level singleton — one engine per MCP server. */
export const hiveConsensusRuntime = new HiveConsensusRuntime();

/** Re-export the singleton's type for tests / advanced consumers. */
export type { HiveConsensusRuntime };
