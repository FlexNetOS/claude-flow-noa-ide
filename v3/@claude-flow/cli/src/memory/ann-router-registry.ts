/**
 * AnnRouter registry stub — gates the optional ANN routing peer deps.
 * Provides the TypeScript shape so the CLI compiles without the peer deps.
 */

export type AnnBacking = 'hnsw' | 'rabitq' | 'diskann';

export interface AnnRouterWorkload { corpusSize?: number; persistent?: boolean; mutable?: boolean }
export interface AnnRouterEntry { id: string; vector: number[] }
export interface AnnRouterBuildResult { backing: AnnBacking; reason: string; count: number }
export interface AnnRouterHit { id: string; score: number }
export interface AnnRouterHandle { name: string; backing: AnnBacking; reason: string; count: number }

interface AnnRouterRegistry {
  build(opts: { name: string; workload: AnnRouterWorkload; entries: AnnRouterEntry[] }): Promise<AnnRouterBuildResult>;
  search(name: string, vector: Float32Array, k: number): Promise<AnnRouterHit[]>;
  list(): AnnRouterHandle[];
}

const _registry: AnnRouterRegistry = {
  async build() { throw new Error('AnnRouter peer deps are not installed'); },
  async search() { throw new Error('AnnRouter peer deps are not installed'); },
  list() { return []; },
};

export function getAnnRouterRegistry(): AnnRouterRegistry { return _registry; }
