/**
 * Embedding quantization stub — encodes float32 embedding vectors as
 * base64 strings for compact storage in graph_edges rows.
 */

export function encodeEmbedding(embedding: number[] | Float32Array): string {
  const floats = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  const buf = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
  return buf.toString('base64');
}

export function decodeEmbedding(encoded: string): Float32Array {
  const buf = Buffer.from(encoded, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
