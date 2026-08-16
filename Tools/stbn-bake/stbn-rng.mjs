// stbn-rng.mjs — deterministic, license-clean pseudo-random stream for the
// STBN bake (C13-11, ruling R-2026-08-10-5).
// @purpose Deterministic license-clean random stream for the STBN bake: AES-256-CTR over zeros keyed by SHA-256(seed), byte-identical across machines.
// @status ACTIVE
//
// PROVENANCE DISCIPLINE. No PRNG implementation was copied from anywhere.
// The C16 audit flagged a verbatim `mulberry32` elsewhere in this repository;
// rather than trade one borrowed snippet for another, this module derives its
// stream from two things the project already ships and already trusts:
//
//   1. Node's built-in `node:crypto`, i.e. OpenSSL.
//   2. Two published NIST standards — AES (FIPS 197) in counter mode
//      (NIST SP 800-38A section 6.5) and SHA-256 (FIPS 180-4).
//
// The stream is `AES-256-CTR` applied to an all-zero plaintext, keyed by
// `SHA-256(seed)` with an all-zero IV. That is a standard, fully-specified
// construction: every byte is determined by the seed string alone, so two
// machines, two Node versions and two operating systems agree byte for byte.
// Reproducibility is the load-bearing property here (the bake's SHA-256 pin
// is worthless if the noise stream drifts), and a hand-rolled xorshift would
// have given us the same determinism with a worse provenance story and a
// worse equidistribution story.
//
// Speed is not a concern: AES-NI makes this faster than most scalar JS PRNGs
// once the output is buffered, and the bake draws its randomness in bulk.
//
// Linted by the `Tools/**` block in eslint.config.js.

import crypto from "node:crypto";

// 1 MiB refill. Large enough that the per-`createCipheriv` cost disappears
// into the noise, small enough that a short bake does not pay for megabytes
// it never reads.
const REFILL_BYTES = 1 << 20;

/**
 * A deterministic byte stream with the usual integer/float/shuffle helpers.
 *
 * Instances are NOT interchangeable across seeds by design — the bake gives
 * each stage its own labelled sub-stream (`"vc:slice:7"`, `"anneal"`, ...) so
 * that changing the number of annealing sweeps cannot perturb the void-and-
 * cluster stage's draws, and a re-bake of one stage stays comparable.
 */
export class StbnRandom {
  /**
   * @param {string} seed Any string. The full 32-byte AES key is
   *   `SHA-256(seed)`, so distinct seed strings give unrelated streams.
   */
  constructor(seed) {
    if (typeof seed !== "string" || seed.length === 0) {
      throw new Error("StbnRandom: seed must be a non-empty string");
    }
    this._seed = seed;
    this._key = crypto.createHash("sha256").update(seed, "utf8").digest();
    // A single cipher object encrypting a stream of zeros IS the counter-mode
    // keystream, so the counter advances implicitly and never repeats within
    // the 2^128-block period.
    this._cipher = crypto.createCipheriv(
      "aes-256-ctr",
      this._key,
      Buffer.alloc(16),
    );
    this._zeros = Buffer.alloc(REFILL_BYTES);
    this._buf = Buffer.alloc(0);
    this._pos = 0;
  }

  /** @returns {string} the seed string this stream was built from */
  get seed() {
    return this._seed;
  }

  _refill() {
    this._buf = this._cipher.update(this._zeros);
    this._pos = 0;
  }

  /**
   * Next uniform 32-bit unsigned integer.
   * @returns {number} an integer in [0, 2^32)
   */
  nextU32() {
    if (this._pos + 4 > this._buf.length) {
      this._refill();
    }
    const v = this._buf.readUInt32LE(this._pos);
    this._pos += 4;
    return v;
  }

  /**
   * Next uniform float in [0, 1). Uses 53 significant bits so the float grid
   * is the full double-precision one rather than a 2^-32 lattice — the
   * annealing's Metropolis test compares against very small probabilities and
   * a coarse grid would quantise the acceptance rate.
   * @returns {number} a float in [0, 1)
   */
  nextFloat() {
    const hi = this.nextU32() >>> 5; // 27 bits
    const lo = this.nextU32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /**
   * Uniform integer in [0, n) with rejection sampling, so the result is
   * exactly uniform rather than modulo-biased. The bake picks pixel indices
   * out of 16384 and slice indices out of 64 millions of times; a modulo bias
   * there would show up as a low-frequency artefact in the very spectrum the
   * tool exists to certify.
   * @param {number} n exclusive upper bound, a positive integer
   * @returns {number} an integer in [0, n)
   */
  nextInt(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `StbnRandom.nextInt: n must be a positive integer (${n})`,
      );
    }
    if (n === 1) {
      return 0;
    }
    // Largest multiple of n that fits in 2^32; draws at or above it are
    // rejected.
    const limit = 4294967296 - (4294967296 % n);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) {
        return v % n;
      }
    }
  }

  /**
   * In-place Fisher-Yates shuffle over a typed or plain array. Written out
   * rather than imported precisely because the algorithm is textbook and the
   * implementation should be ours.
   * @param {Int32Array|Uint32Array|Array<number>} arr array to permute
   * @returns {Int32Array|Uint32Array|Array<number>} the same array
   */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /**
   * A fresh permutation of `0 .. n-1`.
   * @param {number} n length
   * @returns {Int32Array} the permutation
   */
  permutation(n) {
    const a = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = i;
    }
    return /** @type {Int32Array} */ (this.shuffle(a));
  }
}

/**
 * Convenience constructor so call sites read as `rng("anneal")` rather than
 * `new StbnRandom("anneal")`.
 * @param {string} seed seed string
 * @returns {StbnRandom} the stream
 */
export function rng(seed) {
  return new StbnRandom(seed);
}
