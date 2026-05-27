/**
 * Vector ops: Int8 quantization + Flash-Attention-style batch search.
 * Pure functions extracted from memory-initializer.ts during the bounded-context split.
 */

// ============================================================================
// INT8 VECTOR QUANTIZATION (4x memory reduction)
// ============================================================================

export function quantizeInt8(embedding: number[] | Float32Array): {
  quantized: Int8Array;
  scale: number;
  zeroPoint: number;
} {
  const arr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }

  const absMax = Math.max(Math.abs(min), Math.abs(max));
  const scale = absMax / 127 || 1e-10;
  const zeroPoint = 0;

  const quantized = new Int8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const q = Math.round(arr[i] / scale);
    quantized[i] = Math.max(-127, Math.min(127, q));
  }

  return { quantized, scale, zeroPoint };
}

export function dequantizeInt8(
  quantized: Int8Array,
  scale: number,
  zeroPoint: number = 0
): Float32Array {
  const result = new Float32Array(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    result[i] = (quantized[i] - zeroPoint) * scale;
  }
  return result;
}

export function quantizedCosineSim(
  a: Int8Array, aScale: number,
  b: Int8Array, bScale: number
): number {
  if (a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const mag = Math.sqrt(normA * normB);
  return mag === 0 ? 0 : dot / mag;
}

export function getQuantizationStats(embedding: number[] | Float32Array): {
  originalBytes: number;
  quantizedBytes: number;
  compressionRatio: number;
} {
  const len = embedding.length;
  const originalBytes = len * 4;
  const quantizedBytes = len + 8;
  const compressionRatio = originalBytes / quantizedBytes;

  return { originalBytes, quantizedBytes, compressionRatio };
}

// ============================================================================
// FLASH ATTENTION-STYLE BATCH OPERATIONS (V8-Optimized)
// ============================================================================

export function batchCosineSim(
  query: Float32Array | number[],
  vectors: (Float32Array | number[])[],
): Float32Array {
  const n = vectors.length;
  const scores = new Float32Array(n);

  if (n === 0 || query.length === 0) return scores;

  let queryNorm = 0;
  for (let i = 0; i < query.length; i++) {
    queryNorm += query[i] * query[i];
  }
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return scores;

  for (let v = 0; v < n; v++) {
    const vec = vectors[v];
    const len = Math.min(query.length, vec.length);
    let dot = 0, vecNorm = 0;

    for (let i = 0; i < len; i++) {
      dot += query[i] * vec[i];
      vecNorm += vec[i] * vec[i];
    }

    vecNorm = Math.sqrt(vecNorm);
    scores[v] = vecNorm === 0 ? 0 : dot / (queryNorm * vecNorm);
  }

  return scores;
}

export function softmaxAttention(scores: Float32Array, temperature: number = 1.0): Float32Array {
  const n = scores.length;
  const result = new Float32Array(n);
  if (n === 0) return result;

  let max = scores[0];
  for (let i = 1; i < n; i++) {
    if (scores[i] > max) max = scores[i];
  }

  let sum = 0;
  for (let i = 0; i < n; i++) {
    result[i] = Math.exp((scores[i] - max) / temperature);
    sum += result[i];
  }

  if (sum > 0) {
    for (let i = 0; i < n; i++) {
      result[i] /= sum;
    }
  }

  return result;
}

export function topKIndices(scores: Float32Array, k: number): number[] {
  const n = scores.length;
  if (k >= n) {
    return Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => scores[b] - scores[a]);
  }

  const heap: { idx: number; score: number }[] = [];

  for (let i = 0; i < n; i++) {
    if (heap.length < k) {
      heap.push({ idx: i, score: scores[i] });
      let j = heap.length - 1;
      while (j > 0) {
        const parent = Math.floor((j - 1) / 2);
        if (heap[j].score < heap[parent].score) {
          [heap[j], heap[parent]] = [heap[parent], heap[j]];
          j = parent;
        } else break;
      }
    } else if (scores[i] > heap[0].score) {
      heap[0] = { idx: i, score: scores[i] };
      let j = 0;
      while (true) {
        const left = 2 * j + 1, right = 2 * j + 2;
        let smallest = j;
        if (left < k && heap[left].score < heap[smallest].score) smallest = left;
        if (right < k && heap[right].score < heap[smallest].score) smallest = right;
        if (smallest === j) break;
        [heap[j], heap[smallest]] = [heap[smallest], heap[j]];
        j = smallest;
      }
    }
  }

  return heap.sort((a, b) => b.score - a.score).map(h => h.idx);
}

export function flashAttentionSearch(
  query: Float32Array | number[],
  vectors: (Float32Array | number[])[],
  options: {
    k?: number;
    temperature?: number;
    threshold?: number;
  } = {}
): { indices: number[]; scores: Float32Array; weights: Float32Array } {
  const { k = 10, temperature = 1.0, threshold = 0 } = options;

  const scores = batchCosineSim(query, vectors);
  const indices = topKIndices(scores, k);
  const filtered = indices.filter(i => scores[i] >= threshold);

  const topScores = new Float32Array(filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    topScores[i] = scores[filtered[i]];
  }

  const weights = softmaxAttention(topScores, temperature);

  return { indices: filtered, scores: topScores, weights };
}
