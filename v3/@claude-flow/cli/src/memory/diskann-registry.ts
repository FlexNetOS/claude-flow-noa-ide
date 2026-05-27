/**
 * DiskANN registry stub — gates the optional @ruvector/diskann peer dep.
 * Provides the TypeScript shape so the CLI compiles without the peer dep.
 */

export interface DiskannEntry { id: string; vector: number[] }
export interface DiskannHit { id: string; distance: number }
export interface DiskannSnapshot { name: string; dimension: number; count: number; storagePath?: string }

interface DiskannRegistry {
  build(opts: { name: string; dimension: number; entries: DiskannEntry[]; storagePath?: string }): Promise<{ count: number; dimension: number }>;
  search(name: string, vector: Float32Array, k: number): Promise<DiskannHit[]>;
  list(): DiskannSnapshot[];
}

const _registry: DiskannRegistry = {
  async build() { throw new Error('@ruvector/diskann is not installed'); },
  async search() { throw new Error('@ruvector/diskann is not installed'); },
  list() { return []; },
};

export function getDiskannRegistry(): DiskannRegistry { return _registry; }
