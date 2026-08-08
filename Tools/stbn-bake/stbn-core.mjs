// stbn-core.mjs — spatiotemporal blue-noise (STBN) generation, implemented
// from the published algorithm descriptions. Campaign-13 row C13-11, unblocked
// by maintainer ruling R-2026-08-10-5 ("generate our own, ground up").
//
// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE DISCIPLINE — read this before changing anything below.
// ─────────────────────────────────────────────────────────────────────────────
// This file was written from PUBLISHED ALGORITHM DESCRIPTIONS in the open
// literature. No source code, and no generated texture, was taken from any
// third party. In particular NOTHING here derives from NVIDIA's STBN SDK or
// its shipped masks: that project's licence restricts use to research and
// evaluation and forces same-licence redistribution, which is incompatible
// with this Apache-2.0 fork, and the research lane R-STBN (2026-07-06) ruled
// both its textures AND its generator out of bounds — including blog and
// Shadertoy mirrors of the same PNGs. The methods implemented here are:
//
//   [1] R. A. Ulichney, "The void-and-cluster method for dither array
//       generation", Proc. SPIE 1913, Human Vision, Visual Processing, and
//       Digital Display IV, 1993, pp. 332-343. DOI 10.1117/12.152707.
//       -> `voidAndCluster()` below: the initial-binary-pattern refinement
//          loop, the Gaussian "void" filter, and the three ranking phases.
//
//   [2] I. Georgiev and M. Fajardo, "Blue-noise dithered sampling",
//       ACM SIGGRAPH 2016 Talks, article 35. DOI 10.1145/2897839.2927430.
//       -> the pairwise energy functional E = SUM exp(-||p-q||^2 / sigma_i^2
//          - |v_p - v_q|^(d/2) / sigma_v^2) minimised by random swaps, which
//          is what `anneal()` descends.
//
//   [3] A. Wolfe, N. Morrical, T. Akenine-Moller, R. Ramamoorthi,
//       "Spatiotemporal Blue Noise Masks", Eurographics Symposium on
//       Rendering 2022. DOI 10.2312/sr.20221161.
//       -> the SEPARABLE spatiotemporal criterion: a mask whose every 2D
//          slice is blue AND whose every per-pixel time series is blue, which
//          is explicitly NOT the same object as isotropic 3D blue noise
//          (3D-isotropic noise is blue in neither its slices nor its lines).
//          We implement that criterion as a separable energy — a spatial term
//          summed within each slice plus a temporal term summed along each
//          pixel's time line — and then CERTIFY the result against the
//          published spectral characterisation rather than against anyone's
//          reference texture. See `stbn-spectrum.mjs`.
//
// Where a published description leaves a free choice (the relative weight of
// the two energy terms, the kernel radii, the swap proposal distribution, the
// cooling schedule), we chose, wrote the choice down as a named parameter with
// its default, and let the spectrum gate decide whether the choice was good.
// That is the whole point of the validation script: correctness here is
// measured, not inherited.
//
// ─────────────────────────────────────────────────────────────────────────────
// REPRESENTATION
// ─────────────────────────────────────────────────────────────────────────────
// A volume is `{ width, height, frames, ranks: Int32Array }`. Every slice is a
// PERMUTATION of `0 .. width*height-1`, so each slice's value histogram is
// exactly uniform — the property a dither mask has to have and the property a
// per-slice-permutation representation gives us for free. The optimiser only
// ever SWAPS two ranks inside one slice, so uniformity is an invariant of the
// data structure rather than something the energy has to defend.
//
// `width`, `height` and `frames` must be powers of two: every neighbourhood is
// toroidal (so the mask tiles across the screen and loops in time with no
// seam), and a power-of-two extent turns the wrap into a mask-and.
//
// Linted by the `Tools/**` block in eslint.config.js.

import { StbnRandom } from "./stbn-rng.mjs";

/**
 * @typedef {object} StbnVolume
 * @property {number} width slice width in texels
 * @property {number} height slice height in texels
 * @property {number} frames number of temporal slices
 * @property {Int32Array} ranks per-slice permutations, `t*width*height + y*width + x`
 */

/**
 * @typedef {object} StbnParams
 * @property {number} width slice width (power of two)
 * @property {number} height slice height (power of two)
 * @property {number} frames temporal depth (power of two)
 * @property {string} seed seed string for every sub-stream
 * @property {number} vcSigma Gaussian sigma of the void-and-cluster filter, in texels
 * @property {number} vcRadius truncation radius of that filter, in texels
 * @property {number} vcInitialFraction fraction of pixels set in the initial binary pattern
 * @property {number} spatialSigma sigma_i of the annealing spatial kernel, in texels
 * @property {number} spatialRadius truncation radius of the annealing spatial kernel
 * @property {number} temporalSigma sigma_t of the annealing temporal kernel, in frames
 * @property {number} temporalRadius truncation radius of the temporal kernel, in frames
 * @property {number} valueSigma sigma_v of the value term
 * @property {number} temporalWeight relative weight of the temporal term (1 = equal)
 * @property {number} sweeps annealing sweeps over the volume
 * @property {number} proposalsPerVoxel swap proposals per voxel per sweep
 * @property {number} startTemperature Metropolis temperature at the first sweep
 * @property {number} endTemperature Metropolis temperature at the last sweep
 */

/** Defaults for every tunable. Recorded in the manifest with the bake. */
export const DEFAULT_PARAMS = Object.freeze({
  width: 128,
  height: 128,
  frames: 64,
  seed: "cesium-webgpu/C13-11/stbn/scalar/v1",
  // Ulichney recommends a Gaussian of sigma ~1.5 texels for the void filter;
  // the truncation radius is ours, set where the weight falls below ~3e-4.
  vcSigma: 1.5,
  vcRadius: 6,
  vcInitialFraction: 0.1,
  // Georgiev and Fajardo use sigma_i = 2.1 and sigma_v = 1.0 for 2D masks.
  // We narrow sigma_i to 1.9 purely for speed (the annealing cost is
  // quadratic in the radius) and record the change here rather than silently
  // citing 2.1.
  spatialSigma: 1.9,
  spatialRadius: 4,
  // A three-frame temporal support beat both a five- and an eight-frame one on
  // the measured spectrum at 64 frames (tHigh 1.486 vs 1.270 vs 1.148): the
  // wider kernels spread the suppression over more of the band instead of
  // pushing energy to the top of it. Recorded because the intuition runs the
  // other way.
  temporalSigma: 1.5,
  temporalRadius: 3,
  valueSigma: 1.0,
  // 0.5 measured as the knee of the spatial/temporal trade: at 40 sweeps,
  // 0.25 / 0.5 / 0.75 gave spatial-low 0.031 / 0.050 / 0.068 against
  // temporal-low 0.150 / 0.115 / 0.101. Half weight buys most of the temporal
  // gain for a third of the spatial cost.
  temporalWeight: 0.5,
  // Returns flatten after ~20 sweeps; 64 sits comfortably past the knee and
  // still finishes the full-size bake in about three minutes.
  sweeps: 64,
  proposalsPerVoxel: 1,
  startTemperature: 0,
  endTemperature: 0,
});

/**
 * Assert a power of two, with a message that names the offender.
 * @param {number} v value
 * @param {string} name parameter name
 */
function assertPow2(v, name) {
  if (!Number.isInteger(v) || v <= 0 || (v & (v - 1)) !== 0) {
    throw new Error(`${name} must be a positive power of two (got ${v})`);
  }
}

/**
 * Build a truncated, self-excluding 2D Gaussian neighbourhood.
 *
 * @param {number} sigma Gaussian sigma in texels
 * @param {number} radius truncation radius in texels
 * @returns {{dx: Int32Array, dy: Int32Array, w: Float32Array, sum: number}} taps
 */
function gaussianNeighbourhood2D(sigma, radius) {
  const dx = [];
  const dy = [];
  const w = [];
  const twoSigmaSq = 2 * sigma * sigma;
  for (let j = -radius; j <= radius; j++) {
    for (let i = -radius; i <= radius; i++) {
      if (i === 0 && j === 0) {
        continue;
      }
      const d2 = i * i + j * j;
      if (d2 > radius * radius) {
        continue;
      }
      dx.push(i);
      dy.push(j);
      w.push(Math.exp(-d2 / twoSigmaSq));
    }
  }
  let sum = 0;
  for (const v of w) {
    sum += v;
  }
  return {
    dx: Int32Array.from(dx),
    dy: Int32Array.from(dy),
    w: Float32Array.from(w),
    sum,
  };
}

/**
 * Ulichney's void-and-cluster, producing one spatially-blue dither mask.
 *
 * Returns a permutation of `0 .. width*height-1`: rank r sits at the position
 * chosen r-th by the procedure, so thresholding the mask at any level yields a
 * well-distributed binary pattern — which is exactly the property that makes
 * the radially-averaged power spectrum blue.
 *
 * IMPLEMENTATION NOTE — why there are two loops here and not three. The paper
 * presents three ranking phases, the third of which "reverses the roles of
 * minority and majority pixels" and inserts at the tightest cluster of ZEROS.
 * On a torus with a fixed kernel, `E_zeros(p) = C - E_ones(p)` for the
 * constant `C = SUM_{q != p} K(p,q)`, because every pixel is either a one or a
 * zero. So "the zero with the largest zero-density" and "the zero with the
 * smallest one-density" are the same pixel, and phase III's selection rule is
 * identical to phase II's. The two phases are therefore written as one loop.
 * They differ in the paper only in how the procedure is DESCRIBED (in terms of
 * whichever class is currently the minority), not in what it selects.
 *
 * @param {number} width slice width (power of two)
 * @param {number} height slice height (power of two)
 * @param {StbnRandom} rand deterministic stream
 * @param {StbnParams} params bake parameters
 * @returns {Int32Array} the rank of every pixel, row-major
 */
export function voidAndCluster(width, height, rand, params) {
  assertPow2(width, "width");
  assertPow2(height, "height");

  const n = width * height;
  const maskX = width - 1;
  const maskY = height - 1;
  const nb = gaussianNeighbourhood2D(params.vcSigma, params.vcRadius);
  const taps = nb.w.length;

  const bin = new Uint8Array(n);
  const energy = new Float64Array(n);

  // A fixed, tiny, per-pixel offset that breaks exact ties. Without it the
  // very first insertions of phase II run against a perfectly flat energy
  // field and `argmin` would resolve every tie to the lowest raster index,
  // seeding a directional bias that survives into the finished mask.
  const tie = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tie[i] = rand.nextFloat() * 1e-9;
  }

  // Masked mirrors of `energy + tie`, so the two hot scans are branch-free
  // reads over a Float64Array instead of a predicated compare.
  const NEG = -Infinity;
  const POS = Infinity;
  const onesEnergy = new Float64Array(n).fill(NEG);
  const zerosEnergy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    zerosEnergy[i] = tie[i];
  }

  /**
   * @param {number} i pixel index
   */
  const refresh = (i) => {
    if (bin[i] === 1) {
      onesEnergy[i] = energy[i] + tie[i];
      zerosEnergy[i] = POS;
    } else {
      onesEnergy[i] = NEG;
      zerosEnergy[i] = energy[i] + tie[i];
    }
  };

  /**
   * @param {number} p pixel index
   * @param {number} sign +1 to add a one, -1 to remove it
   */
  const splat = (p, sign) => {
    const px = p & maskX;
    const py = (p / width) | 0;
    for (let k = 0; k < taps; k++) {
      const nx = (px + nb.dx[k]) & maskX;
      const ny = (py + nb.dy[k]) & maskY;
      const idx = ny * width + nx;
      energy[idx] += sign * nb.w[k];
      refresh(idx);
    }
    refresh(p);
  };

  /**
   * @param {number} p pixel index
   */
  const addOne = (p) => {
    bin[p] = 1;
    splat(p, 1);
  };

  /**
   * @param {number} p pixel index
   */
  const removeOne = (p) => {
    bin[p] = 0;
    splat(p, -1);
  };

  /** @returns {number} index of the tightest cluster among the ones */
  const tightestCluster = () => {
    let best = NEG;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      if (onesEnergy[i] > best) {
        best = onesEnergy[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  /** @returns {number} index of the largest void among the zeros */
  const largestVoid = () => {
    let best = POS;
    let bestIdx = -1;
    for (let i = 0; i < n; i++) {
      if (zerosEnergy[i] < best) {
        best = zerosEnergy[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  // ── Initial binary pattern ────────────────────────────────────────────────
  const onesCount = Math.max(1, Math.round(n * params.vcInitialFraction));
  const order = rand.permutation(n);
  for (let i = 0; i < onesCount; i++) {
    addOne(order[i]);
  }

  // Refine: pull the tightest cluster apart into the largest void until the
  // procedure would put the pixel straight back where it came from.
  const maxRefine = 10 * n;
  for (let iter = 0; iter < maxRefine; iter++) {
    const cluster = tightestCluster();
    removeOne(cluster);
    const usedVoid = largestVoid();
    addOne(usedVoid);
    if (usedVoid === cluster) {
      break;
    }
  }

  const prototype = Uint8Array.from(bin);
  const ranks = new Int32Array(n).fill(-1);

  // ── Phase I — rank the prototype's ones downward from onesCount-1 ─────────
  for (let rank = onesCount - 1; rank >= 0; rank--) {
    const cluster = tightestCluster();
    removeOne(cluster);
    ranks[cluster] = rank;
  }

  // Restore the prototype from scratch. Re-splatting is cheaper than keeping a
  // second energy field alive through phase I, and it removes any chance of
  // float drift between the two reconstructions mattering.
  energy.fill(0);
  bin.fill(0);
  for (let i = 0; i < n; i++) {
    refresh(i);
  }
  for (let i = 0; i < n; i++) {
    if (prototype[i] === 1) {
      addOne(i);
    }
  }

  // ── Phases II and III — rank the remaining pixels upward ──────────────────
  for (let rank = onesCount; rank < n; rank++) {
    const target = largestVoid();
    addOne(target);
    ranks[target] = rank;
  }

  return ranks;
}

/**
 * Build the value-difference lookup `V(k) = exp(-(k/(n-1))^(d/2) / sigma_v^2)`.
 *
 * `d` is the dimensionality of the VALUE in the Georgiev-Fajardo energy, which
 * is 1 for a scalar mask, giving the exponent 1/2. Tabulating it against the
 * integer rank difference removes every `Math.exp` from the annealing inner
 * loop — the single change that makes a full-size bake finish in minutes
 * rather than hours.
 *
 * @param {number} n number of distinct ranks
 * @param {number} valueSigma sigma_v
 * @returns {Float32Array} the table, indexed by `|rank_a - rank_b|`
 */
function buildValueTable(n, valueSigma) {
  const table = new Float32Array(n);
  const inv = 1 / (n - 1);
  const denom = valueSigma * valueSigma;
  for (let k = 0; k < n; k++) {
    table[k] = Math.exp(-Math.sqrt(k * inv) / denom);
  }
  return table;
}

/**
 * Descend the separable spatiotemporal energy by swapping ranks within slices.
 *
 * Swapping WITHIN a slice is what keeps every slice an exact permutation, and
 * it is not a restriction on the reachable configurations that matters: a
 * pixel's time line is edited by moving values around inside the slices it
 * passes through, so both energy terms are reachable from the same move set.
 *
 * The energy delta is exact, not approximate. The one subtlety is that when
 * the two swapped pixels are inside each other's spatial neighbourhood their
 * mutual term must be EXCLUDED from all four partial sums: it is unchanged by
 * the swap (`|a-b| = |b-a|`) and evaluating it against the pre-swap array
 * would score it as `V(0)`, which is the largest value in the table and would
 * bias the optimiser against every nearby swap.
 *
 * @param {StbnVolume} volume volume to optimise in place
 * @param {StbnRandom} rand deterministic stream
 * @param {StbnParams} params bake parameters
 * @param {(progress: {sweep: number, sweeps: number, accepted: number, proposed: number}) => void} [onSweep] progress callback
 * @returns {{proposed: number, accepted: number}} move statistics
 */
export function anneal(volume, rand, params, onSweep) {
  const { width, height, frames, ranks } = volume;
  const sliceSize = width * height;
  const maskX = width - 1;
  const maskY = height - 1;
  const maskT = frames - 1;

  const nb = gaussianNeighbourhood2D(params.spatialSigma, params.spatialRadius);
  const taps = nb.w.length;
  const value = buildValueTable(sliceSize, params.valueSigma);

  // Temporal taps, self excluded, toroidal in t.
  const tOff = [];
  const tW = [];
  const twoTemporalSq = 2 * params.temporalSigma * params.temporalSigma;
  for (let d = -params.temporalRadius; d <= params.temporalRadius; d++) {
    if (d === 0) {
      continue;
    }
    tOff.push(d);
    tW.push(Math.exp(-(d * d) / twoTemporalSq));
  }
  const tOffsets = Int32Array.from(tOff);
  const tWeights = Float32Array.from(tW);
  const tTaps = tWeights.length;
  let temporalSum = 0;
  for (let k = 0; k < tTaps; k++) {
    temporalSum += tWeights[k];
  }

  // Normalise each term by its own kernel mass so that `temporalWeight` means
  // "how much does one frame of temporal neighbourhood count against one
  // ring of spatial neighbourhood" rather than "how many taps did each kernel
  // happen to have". Without this, changing a radius silently re-weights the
  // objective.
  const spatialScale = 1 / nb.sum;
  const temporalScale = params.temporalWeight / temporalSum;

  /**
   * Spatial partial sum for a candidate value at one pixel of one slice.
   * @param {number} base slice base offset
   * @param {number} px pixel x
   * @param {number} py pixel y
   * @param {number} val candidate rank
   * @param {number} skip local index to exclude (the swap partner), or -1
   * @returns {number} the partial energy
   */
  const spatialSum = (base, px, py, val, skip) => {
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const nx = (px + nb.dx[k]) & maskX;
      const ny = (py + nb.dy[k]) & maskY;
      const li = ny * width + nx;
      if (li === skip) {
        continue;
      }
      let d = val - ranks[base + li];
      if (d < 0) {
        d = -d;
      }
      sum += nb.w[k] * value[d];
    }
    return sum;
  };

  /**
   * Temporal partial sum for a candidate value on one pixel's time line.
   * @param {number} t slice index
   * @param {number} local pixel index within the slice
   * @param {number} val candidate rank
   * @returns {number} the partial energy
   */
  const temporalSumAt = (t, local, val) => {
    let sum = 0;
    for (let k = 0; k < tTaps; k++) {
      const tt = (t + tOffsets[k]) & maskT;
      let d = val - ranks[tt * sliceSize + local];
      if (d < 0) {
        d = -d;
      }
      sum += tWeights[k] * value[d];
    }
    return sum;
  };

  const proposalsPerSlice = Math.max(
    1,
    Math.round(sliceSize * params.proposalsPerVoxel),
  );
  let proposed = 0;
  let accepted = 0;

  const t0 = params.startTemperature;
  const t1 = params.endTemperature;

  for (let sweep = 0; sweep < params.sweeps; sweep++) {
    // Geometric cooling when both endpoints are positive, linear otherwise;
    // the default schedule is `0 -> 0`, i.e. pure greedy descent, because
    // void-and-cluster already hands us a good spatial configuration and the
    // job of this stage is to trade a little of it for temporal structure,
    // not to melt it.
    let temperature = t0;
    if (params.sweeps > 1 && (t0 > 0 || t1 > 0)) {
      const u = sweep / (params.sweeps - 1);
      temperature = t0 > 0 && t1 > 0 ? t0 * Math.pow(t1 / t0, u) : t0 * (1 - u);
    }

    const sliceOrder = rand.permutation(frames);
    for (let s = 0; s < frames; s++) {
      const t = sliceOrder[s];
      const base = t * sliceSize;
      for (let i = 0; i < proposalsPerSlice; i++) {
        const p = rand.nextInt(sliceSize);
        const q = rand.nextInt(sliceSize);
        if (p === q) {
          continue;
        }
        proposed++;

        const a = ranks[base + p];
        const b = ranks[base + q];
        const px = p & maskX;
        const py = (p / width) | 0;
        const qx = q & maskX;
        const qy = (q / width) | 0;

        const dSpatial =
          spatialSum(base, px, py, b, q) +
          spatialSum(base, qx, qy, a, p) -
          spatialSum(base, px, py, a, q) -
          spatialSum(base, qx, qy, b, p);

        const dTemporal =
          temporalSumAt(t, p, b) +
          temporalSumAt(t, q, a) -
          temporalSumAt(t, p, a) -
          temporalSumAt(t, q, b);

        const delta = spatialScale * dSpatial + temporalScale * dTemporal;

        let accept = delta < 0;
        if (!accept && temperature > 0) {
          accept = rand.nextFloat() < Math.exp(-delta / temperature);
        }
        if (accept) {
          ranks[base + p] = b;
          ranks[base + q] = a;
          accepted++;
        }
      }
    }

    if (onSweep) {
      onSweep({ sweep: sweep + 1, sweeps: params.sweeps, accepted, proposed });
    }
  }

  return { proposed, accepted };
}

/**
 * Total separable energy of a volume, per voxel. Reported before and after
 * annealing so the manifest records that the descent actually descended.
 *
 * @param {StbnVolume} volume the volume
 * @param {StbnParams} params bake parameters
 * @returns {{spatial: number, temporal: number, total: number}} mean energies
 */
export function measureEnergy(volume, params) {
  const { width, height, frames, ranks } = volume;
  const sliceSize = width * height;
  const maskX = width - 1;
  const maskY = height - 1;
  const maskT = frames - 1;
  const nb = gaussianNeighbourhood2D(params.spatialSigma, params.spatialRadius);
  const value = buildValueTable(sliceSize, params.valueSigma);

  let spatial = 0;
  for (let t = 0; t < frames; t++) {
    const base = t * sliceSize;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const val = ranks[base + y * width + x];
        for (let k = 0; k < nb.w.length; k++) {
          const nx = (x + nb.dx[k]) & maskX;
          const ny = (y + nb.dy[k]) & maskY;
          let d = val - ranks[base + ny * width + nx];
          if (d < 0) {
            d = -d;
          }
          spatial += nb.w[k] * value[d];
        }
      }
    }
  }

  let temporal = 0;
  const twoTemporalSq = 2 * params.temporalSigma * params.temporalSigma;
  for (let d = -params.temporalRadius; d <= params.temporalRadius; d++) {
    if (d === 0) {
      continue;
    }
    const w = Math.exp(-(d * d) / twoTemporalSq);
    for (let t = 0; t < frames; t++) {
      const base = t * sliceSize;
      const other = ((t + d) & maskT) * sliceSize;
      for (let i = 0; i < sliceSize; i++) {
        let k = ranks[base + i] - ranks[other + i];
        if (k < 0) {
          k = -k;
        }
        temporal += w * value[k];
      }
    }
  }

  const voxels = sliceSize * frames;
  const spatialMean = spatial / (voxels * nb.sum);
  const temporalMean = temporal / voxels;
  return {
    spatial: spatialMean,
    temporal: temporalMean,
    total: spatialMean + temporalMean,
  };
}

/**
 * Generate a full STBN volume: independent void-and-cluster slices, then the
 * separable spatiotemporal descent.
 *
 * The slices START independent on purpose. A far cheaper construction exists —
 * take one blue mask `M` and set slice `t` to `(M + c_t) mod n` for a
 * temporally-blue offset sequence `c_t` — and it scores beautifully on both
 * spectra, because every slice is a value-rotation of a blue mask and every
 * pixel's time line is the same blue sequence. It is nonetheless REJECTED
 * here: every pixel then shares one time line up to an offset, so the whole
 * screen's dither pattern marches coherently frame to frame, which is exactly
 * the correlated structure a temporal filter cannot break up. The manifest
 * records a cross-pixel temporal correlation figure so that this stays checked
 * rather than merely asserted.
 *
 * @param {Partial<StbnParams>} [overrides] parameter overrides
 * @param {(msg: string) => void} [log] progress sink
 * @returns {{volume: StbnVolume, params: StbnParams, stats: object}} result
 */
export function generateStbn(overrides = {}, log) {
  /** @type {StbnParams} */
  const params = { ...DEFAULT_PARAMS, ...overrides };
  assertPow2(params.width, "width");
  assertPow2(params.height, "height");
  assertPow2(params.frames, "frames");

  const sliceSize = params.width * params.height;
  const ranks = new Int32Array(sliceSize * params.frames);

  const vcStart = Date.now();
  for (let t = 0; t < params.frames; t++) {
    // Each slice gets its own labelled sub-stream, so changing `sweeps` or
    // `frames` cannot perturb an earlier slice's draws and a partial re-bake
    // stays comparable.
    const rand = new StbnRandom(`${params.seed}|void-and-cluster|slice=${t}`);
    const slice = voidAndCluster(params.width, params.height, rand, params);
    ranks.set(slice, t * sliceSize);
    if (log && (t + 1) % 8 === 0) {
      log(
        `  void-and-cluster ${t + 1}/${params.frames} slices ` +
          `(${((Date.now() - vcStart) / 1000).toFixed(1)}s)`,
      );
    }
  }
  const vcSeconds = (Date.now() - vcStart) / 1000;

  /** @type {StbnVolume} */
  const volume = {
    width: params.width,
    height: params.height,
    frames: params.frames,
    ranks,
  };

  const energyBefore = measureEnergy(volume, params);

  const annealStart = Date.now();
  const annealRand = new StbnRandom(`${params.seed}|anneal`);
  const moves = anneal(volume, annealRand, params, (p) => {
    if (log) {
      log(
        `  anneal sweep ${p.sweep}/${p.sweeps} ` +
          `accept ${((100 * p.accepted) / Math.max(1, p.proposed)).toFixed(2)}% ` +
          `(${((Date.now() - annealStart) / 1000).toFixed(1)}s)`,
      );
    }
  });
  const annealSeconds = (Date.now() - annealStart) / 1000;

  const energyAfter = measureEnergy(volume, params);

  return {
    volume,
    params,
    stats: {
      vcSeconds,
      annealSeconds,
      proposed: moves.proposed,
      accepted: moves.accepted,
      acceptRate: moves.accepted / Math.max(1, moves.proposed),
      energyBefore,
      energyAfter,
    },
  };
}

/**
 * Quantise ranks to the 8-bit texel values the GPU will read.
 *
 * `byte = floor(rank * 256 / sliceSize)` is exact and histogram-preserving
 * whenever `sliceSize` is a multiple of 256: every byte value then occurs
 * exactly `sliceSize / 256` times per slice, so the 8-bit mask is as uniform
 * as the rank mask it came from. The spectra are measured on THESE bytes, not
 * on the ranks, because these are what the shader samples.
 *
 * @param {StbnVolume} volume the volume
 * @returns {Uint8Array} `frames * height * width` bytes, slice-major
 */
export function quantiseToBytes(volume) {
  const { width, height, ranks } = volume;
  const sliceSize = width * height;
  if (sliceSize % 256 !== 0) {
    throw new Error(
      `quantiseToBytes: slice size ${sliceSize} is not a multiple of 256; ` +
        `the 8-bit histogram would not be uniform`,
    );
  }
  const ranksPerValue = sliceSize / 256;
  const out = new Uint8Array(ranks.length);
  for (let i = 0; i < ranks.length; i++) {
    out[i] = (ranks[i] / ranksPerValue) | 0;
  }
  return out;
}

/**
 * Pack the slice-major byte volume into the 2D atlas the engine loads.
 *
 * Layout: `atlasCols x atlasRows` tiles, slice `t` at tile column `t %
 * atlasCols`, tile row `floor(t / atlasCols)`, i.e. row-major tile order with
 * the origin at the top-left. `atlasCols` defaults to `sqrt(frames)` rounded
 * up to a power of two so the atlas stays square for the common 64-frame case
 * (8x8 tiles of 128x128 = 1024x1024).
 *
 * @param {Uint8Array} bytes slice-major volume bytes
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @param {number} [atlasCols] tiles per atlas row
 * @returns {{pixels: Uint8Array, width: number, height: number, cols: number, rows: number}} atlas
 */
export function packAtlas(bytes, width, height, frames, atlasCols) {
  const cols = atlasCols ?? 1 << Math.ceil(Math.log2(Math.sqrt(frames)));
  const rows = Math.ceil(frames / cols);
  const aw = cols * width;
  const ah = rows * height;
  const pixels = new Uint8Array(aw * ah);
  const sliceSize = width * height;
  for (let t = 0; t < frames; t++) {
    const tx = (t % cols) * width;
    const ty = Math.floor(t / cols) * height;
    for (let y = 0; y < height; y++) {
      const src = t * sliceSize + y * width;
      const dst = (ty + y) * aw + tx;
      pixels.set(bytes.subarray(src, src + width), dst);
    }
  }
  return { pixels, width: aw, height: ah, cols, rows };
}

/**
 * Inverse of {@link packAtlas} — recover the slice-major volume from an atlas.
 * The validation spec uses this to read the shipped PNG back.
 *
 * @param {Uint8Array} pixels atlas pixels
 * @param {number} atlasWidth atlas width
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @param {number} cols tiles per atlas row
 * @returns {Uint8Array} slice-major volume bytes
 */
export function unpackAtlas(pixels, atlasWidth, width, height, frames, cols) {
  const out = new Uint8Array(width * height * frames);
  const sliceSize = width * height;
  for (let t = 0; t < frames; t++) {
    const tx = (t % cols) * width;
    const ty = Math.floor(t / cols) * height;
    for (let y = 0; y < height; y++) {
      const src = (ty + y) * atlasWidth + tx;
      const dst = t * sliceSize + y * width;
      out.set(pixels.subarray(src, src + width), dst);
    }
  }
  return out;
}
