/**
 * V3 Consensus Engine Factory
 * Unified interface for different consensus algorithms
 */

import { EventEmitter } from 'events';
import {
  ConsensusAlgorithm,
  ConsensusConfig,
  ConsensusProposal,
  ConsensusVote,
  ConsensusResult,
  IConsensusEngine,
  SWARM_CONSTANTS,
} from '../types.js';
import { RaftConsensus, createRaftConsensus, RaftConfig } from './raft.js';
import { ByzantineConsensus, createByzantineConsensus, ByzantineConfig } from './byzantine.js';
import { GossipConsensus, createGossipConsensus, GossipConfig } from './gossip.js';
import type { ConsensusTransport } from './transport.js';

export { RaftConsensus, ByzantineConsensus, GossipConsensus };
export type { RaftConfig, ByzantineConfig, GossipConfig };

// ADR-095 G2 — pluggable consensus transport. Replaces the implicit
// single-process EventEmitter messaging in the consensus protocols.
// LocalTransport is the default (matches current behavior); FederationTransport
// (separate file, ADR-104 wire) is the multi-host one.
export {
  LocalTransport,
  LocalTransportRegistry,
  defaultLocalRegistry,
  generateNodeKeyPair,
  signMessage,
  verifyMessage,
  canonicalizeForSigning,
  messageDigest,
} from './transport.js';
export type {
  ConsensusTransport,
  ConsensusMessage,
  ConsensusReply,
  ConsensusMessageHandler,
  NodeKeyPair,
  LocalTransportOptions,
} from './transport.js';

// ADR-095 G2 — FederationTransport: ConsensusTransport over the federation
// plugin's ADR-104 WS wire (agentic-flow/transport/loader). Structural —
// swarm doesn't import agentic-flow; the caller passes a transport instance.
export { FederationTransport } from './federation-transport.js';
export type { AgenticFlowTransportLike, FederationTransportOptions } from './federation-transport.js';

type ConsensusImplementation = RaftConsensus | ByzantineConsensus | GossipConsensus;

export class ConsensusEngine extends EventEmitter implements IConsensusEngine {
  private config: ConsensusConfig;
  private nodeId: string;
  private implementation?: ConsensusImplementation;
  private proposals: Map<string, ConsensusProposal> = new Map();

  constructor(nodeId: string, config: Partial<ConsensusConfig> = {}) {
    super();
    this.nodeId = nodeId;
    this.config = {
      algorithm: config.algorithm ?? 'raft',
      threshold: config.threshold ?? SWARM_CONSTANTS.DEFAULT_CONSENSUS_THRESHOLD,
      timeoutMs: config.timeoutMs ?? SWARM_CONSTANTS.DEFAULT_CONSENSUS_TIMEOUT_MS,
      maxRounds: config.maxRounds ?? 10,
      requireQuorum: config.requireQuorum ?? true,
    };
  }

  async initialize(config?: ConsensusConfig): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // ADR-095 G2.2 — narrow the typed-as-unknown `transport` from
    // ConsensusConfig into the real ConsensusTransport so Raft / Byzantine /
    // Gossip get a working inter-node wire. Structural check, not
    // instanceof, so test mocks satisfy it without importing transport.ts.
    const transport = isConsensusTransport(this.config.transport)
      ? this.config.transport
      : undefined;

    // Create implementation based on algorithm
    switch (this.config.algorithm) {
      case 'raft':
        this.implementation = createRaftConsensus(this.nodeId, {
          threshold: this.config.threshold,
          timeoutMs: this.config.timeoutMs,
          maxRounds: this.config.maxRounds,
          requireQuorum: this.config.requireQuorum,
          transport,
        });
        break;

      case 'byzantine':
        this.implementation = createByzantineConsensus(this.nodeId, {
          threshold: this.config.threshold,
          timeoutMs: this.config.timeoutMs,
          maxRounds: this.config.maxRounds,
          requireQuorum: this.config.requireQuorum,
          transport,
        });
        break;

      case 'gossip':
        this.implementation = createGossipConsensus(this.nodeId, {
          threshold: this.config.threshold,
          timeoutMs: this.config.timeoutMs,
          maxRounds: this.config.maxRounds,
          requireQuorum: this.config.requireQuorum,
          transport,
        });
        break;

      case 'paxos':
        // Fall back to Raft for Paxos (similar guarantees)
        this.implementation = createRaftConsensus(this.nodeId, {
          threshold: this.config.threshold,
          timeoutMs: this.config.timeoutMs,
          maxRounds: this.config.maxRounds,
          requireQuorum: this.config.requireQuorum,
          transport,
        });
        break;

      default:
        throw new Error(`Unknown consensus algorithm: ${this.config.algorithm}`);
    }

    await this.implementation.initialize();

    // Forward events
    this.implementation.on('consensus.achieved', (data) => {
      this.emit('consensus.achieved', data);
    });

    this.implementation.on('leader.elected', (data) => {
      this.emit('leader.elected', data);
    });

    this.emit('initialized', {
      nodeId: this.nodeId,
      algorithm: this.config.algorithm
    });
  }

  async shutdown(): Promise<void> {
    if (this.implementation) {
      await this.implementation.shutdown();
    }
    this.emit('shutdown');
  }

  addNode(nodeId: string, options?: { isPrimary?: boolean }): void {
    if (!this.implementation) {
      throw new Error('Consensus engine not initialized');
    }

    if (this.implementation instanceof RaftConsensus) {
      this.implementation.addPeer(nodeId);
    } else if (this.implementation instanceof ByzantineConsensus) {
      this.implementation.addNode(nodeId, options?.isPrimary);
    } else if (this.implementation instanceof GossipConsensus) {
      this.implementation.addNode(nodeId);
    }
  }

  removeNode(nodeId: string): void {
    if (!this.implementation) {
      return;
    }

    if (this.implementation instanceof RaftConsensus) {
      this.implementation.removePeer(nodeId);
    } else if (this.implementation instanceof ByzantineConsensus) {
      this.implementation.removeNode(nodeId);
    } else if (this.implementation instanceof GossipConsensus) {
      this.implementation.removeNode(nodeId);
    }
  }

  async propose(value: unknown, proposerId?: string): Promise<ConsensusProposal> {
    if (!this.implementation) {
      throw new Error('Consensus engine not initialized');
    }

    const proposal = await this.implementation.propose(value);
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async vote(proposalId: string, vote: ConsensusVote): Promise<void> {
    if (!this.implementation) {
      throw new Error('Consensus engine not initialized');
    }

    await this.implementation.vote(proposalId, vote);
  }

  getProposal(proposalId: string): ConsensusProposal | undefined {
    return this.proposals.get(proposalId);
  }

  async awaitConsensus(proposalId: string): Promise<ConsensusResult> {
    if (!this.implementation) {
      throw new Error('Consensus engine not initialized');
    }

    return this.implementation.awaitConsensus(proposalId);
  }

  getActiveProposals(): ConsensusProposal[] {
    return Array.from(this.proposals.values()).filter(
      p => p.status === 'pending'
    );
  }

  // Algorithm-specific queries
  isLeader(): boolean {
    if (this.implementation instanceof RaftConsensus) {
      return this.implementation.isLeader();
    }
    if (this.implementation instanceof ByzantineConsensus) {
      return this.implementation.isPrimary();
    }
    return false; // Gossip has no leader
  }

  getLeaderId(): string | undefined {
    if (this.implementation instanceof RaftConsensus) {
      return this.implementation.getLeaderId();
    }
    return undefined;
  }

  getAlgorithm(): ConsensusAlgorithm {
    return this.config.algorithm;
  }

  getConfig(): ConsensusConfig {
    return { ...this.config };
  }

  // Metrics
  getStats(): {
    algorithm: ConsensusAlgorithm;
    totalProposals: number;
    pendingProposals: number;
    acceptedProposals: number;
    rejectedProposals: number;
    expiredProposals: number;
  } {
    const proposals = Array.from(this.proposals.values());

    return {
      algorithm: this.config.algorithm,
      totalProposals: proposals.length,
      pendingProposals: proposals.filter(p => p.status === 'pending').length,
      acceptedProposals: proposals.filter(p => p.status === 'accepted').length,
      rejectedProposals: proposals.filter(p => p.status === 'rejected').length,
      expiredProposals: proposals.filter(p => p.status === 'expired').length,
    };
  }
}

// Factory function
export function createConsensusEngine(
  nodeId: string,
  algorithm: ConsensusAlgorithm = 'raft',
  config?: Partial<ConsensusConfig>
): ConsensusEngine {
  return new ConsensusEngine(nodeId, { ...config, algorithm });
}

/**
 * ADR-095 G2.2 — structural check that an opaque value implements the
 * ConsensusTransport interface. Used by the engine to safely narrow the
 * `transport` field on `ConsensusConfig` (typed as `unknown` to keep
 * `types.ts` free of cross-module imports).
 */
function isConsensusTransport(value: unknown): value is ConsensusTransport {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.nodeId === 'string'
      && typeof t.send === 'function'
      && typeof t.broadcast === 'function'
      && typeof t.onMessage === 'function'
      && typeof t.peers === 'function'
      && typeof t.close === 'function';
}

// Helper to select optimal algorithm based on requirements
export function selectOptimalAlgorithm(requirements: {
  faultTolerance: 'crash' | 'byzantine';
  consistency: 'strong' | 'eventual';
  networkScale: 'small' | 'medium' | 'large';
  latencyPriority: 'low' | 'medium' | 'high';
}): ConsensusAlgorithm {
  const { faultTolerance, consistency, networkScale, latencyPriority } = requirements;

  // Byzantine fault tolerance required
  if (faultTolerance === 'byzantine') {
    return 'byzantine';
  }

  // Eventual consistency acceptable and large scale
  if (consistency === 'eventual' && networkScale === 'large') {
    return 'gossip';
  }

  // Low latency priority with medium scale
  if (latencyPriority === 'high' && networkScale !== 'large') {
    return 'raft';
  }

  // Strong consistency with small/medium scale
  if (consistency === 'strong') {
    return 'raft';
  }

  // Default to Raft
  return 'raft';
}
