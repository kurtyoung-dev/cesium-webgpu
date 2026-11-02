// Deterministic pseudo-random number generation shared by the weather pattern
// and the wind particle layer, so seeded fields (and probe captures taken at a
// fixed frame) are reproducible across runs and across consumers.

/**
 * Creates a mulberry32 generator. Each call of the returned function yields
 * the next value in [0, 1).
 *
 * @param seed A 32-bit seed; any other number is reduced modulo 2^32.
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a mulberry32 generator seeded from the FNV-1a hash of the seed's
 * string form, so a string and the number with the same text share a stream.
 */
export function seededRandom(seed: string | number): () => number {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return mulberry32(hash);
}
