/**
 * Campaign 13 C13-37 — planet-stable cloud-density domains.
 *
 * The baked cloud textures are periodic. Sampling every texture from aligned,
 * axis-aligned multiples of raw ECEF exposes that periodicity as a planetary
 * lattice. These campaign-fixed rotations, offsets, and non-harmonic scales
 * decorrelate the shape, slow-warp, and detail domains without adding a texture
 * tap.
 *
 * Provenance: the shape and detail transforms retain the original xorshift32 +
 * Shoemake draws (seeds 0xc1337001/0xc1337003). The WARP transform was
 * re-drawn from a splitmix32 stream (state = the exported generation seed
 * XOR 0x5eed7a3b; 16 warm-up draws, one Shoemake uniform-quaternion draw,
 * one phase-offset draw) because the original adjacent per-domain seeds
 * produced correlated draws — all three rotations shared m22 ≈ -0.427
 * (Shoemake's m22 = 2*u1 - 1) — and the correlated warp orientation left a
 * warp-texel-lattice combination (the 32-texel granularity of the warp vector
 * field, ~1.03 km world period at default puff size) within 3 degrees of
 * screen-horizontal at the C13-37 grazing acceptance camera. That projection
 * read as coherent horizontal tiling: the measured 0-degree/40-52px
 * baked-periodicity regression tracked the warp draw across probe A/B trials,
 * not the shape or detail draws. The replacement warp minimizes a documented
 * suppression penalty — the pair-mass of visible distance rows where any
 * low-order warp-texel lattice combination lands an in-range screen repeat
 * within 8px of a metric-aligned direction — at BOTH acceptance cameras
 * simultaneously. All matrices are stored row-major and rounded to f32 so CPU
 * origin phases use the exact coefficients visible to WGSL. They are data,
 * not regenerated at runtime.
 */

/** Nominally 0.0003 noise units per world-space metre, rounded to WGSL f32. */
export const CLOUD_DENSITY_WORLD_TO_NOISE = 0.0003000000142492354;

/** Replaces the harmonic 0.32 slow-warp ratio with f32(1 / pi). */
export const CLOUD_DENSITY_WARP_RATIO = 0.31830987334251404;

/** Replaces the integer 5x detail ratio with f32(3.5 * sqrt(2)). */
export const CLOUD_DENSITY_DETAIL_RATIO = 4.949747562408447;

export const CLOUD_DENSITY_SHAPE_ROTATION_SEED = 0xc1337001;
export const CLOUD_DENSITY_WARP_GENERATION_SEED = 45296;
export const CLOUD_DENSITY_DETAIL_ROTATION_SEED = 0xc1337003;

/** Row-major SO(3) rotation for the primary baked-shape domain. */
export const CLOUD_DENSITY_SHAPE_ROTATION = Object.freeze([
  0.6481302976608276, -0.7509533762931824, 0.1264757513999939,
  -0.25138190388679504, -0.36774903535842896, -0.8953031897544861,
  0.7188422679901123, 0.548479437828064, -0.42712539434432983,
]);

/** Row-major SO(3) rotation for the slow shape-warp domain. */
export const CLOUD_DENSITY_WARP_ROTATION = Object.freeze([
  0.9397907257080078, 0.019768714904785156, 0.341178297996521,
  0.33879518508911133, 0.07711493223905563, -0.9376945495605469,
  -0.04484695941209793, 0.9968262314796448, 0.0657743513584137,
]);

/** Row-major SO(3) rotation for the high-frequency erosion/detail domain. */
export const CLOUD_DENSITY_DETAIL_ROTATION = Object.freeze([
  0.37974730134010315, -0.32391443848609924, 0.8665283918380737,
  -0.21341197192668915, -0.9421044588088989, -0.25863969326019287,
  0.9001373648643494, -0.08670981228351593, -0.4268888533115387,
]);

/** Fixed phase offsets; the warp offset comes from the warp re-draw. */
export const CLOUD_DENSITY_SHAPE_OFFSET = Object.freeze([
  0.6620869040489197, 0.2922023832798004, 0.697387158870697,
]);
export const CLOUD_DENSITY_WARP_OFFSET = Object.freeze([
  0.45028430223464966, 0.19357918202877045, 0.45167380571365356,
]);
export const CLOUD_DENSITY_DETAIL_OFFSET = Object.freeze([
  0.7925757169723511, 0.662077784538269, 0.5091480016708374,
]);

/**
 * Uniform layout: three vec3 phases, each padded to a vec4 boundary.
 *
 *   0..3  shape.xyz, pad
 *   4..7  warp.xyz, pad
 *   8..11 detail.xyz, pad
 */
export const CLOUD_DENSITY_ORIGIN_PHASE_FLOATS = 12;
export const CLOUD_DENSITY_ORIGIN_PHASE_STRIDE = 4;
export const CLOUD_DENSITY_SHAPE_ORIGIN_PHASE_OFFSET = 0;
export const CLOUD_DENSITY_WARP_ORIGIN_PHASE_OFFSET = 4;
export const CLOUD_DENSITY_DETAIL_ORIGIN_PHASE_OFFSET = 8;

/**
 * The primary visible march additionally carries an unwrapped, unrotated
 * morphology origin as encoded high/low vec3 rows. Optional analytic cloud
 * species interpret x/z as the historical wind plane, so they must not consume
 * the wrapped and arbitrarily rotated texture domains.
 */
export const CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS = 8;
export const CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET = 0;
export const CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET = 4;
export const CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS =
  CLOUD_DENSITY_ORIGIN_PHASE_FLOATS + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_FLOATS;

/**
 * Coverage anchor at and above which the cloud density gate is bit-identical to
 * its historical `1 - coverage` threshold. See `cloudEffectiveCoverage`.
 */
export const CLOUD_COVERAGE_ANCHOR = 0.55;

/**
 * Constant-elasticity exponent of the sub-anchor coverage response. Derived,
 * not tuned: it is the exponent that places the 0.15 threshold at the baked
 * base field's ~98th percentile given the anchor. See `cloudEffectiveCoverage`.
 */
export const CLOUD_COVERAGE_EXPONENT = 0.25;

/**
 * CPU twin of `cloudEffectiveCoverage` in CloudDensityDomain.wgsl (the chunk is
 * prepended to both ProceduralClouds.wgsl and ProceduralSkyCubemap.wgsl, so one
 * definition serves the visible march, the beer-shadow producer, and the IBL
 * cube).
 *
 * The cloud density gate is `smoothstep(1 - cEff, 1, base)`. Feeding it
 * `cEff = coverage` assumes the base noise is uniform over [0, 1]; the baked
 * shape channel is a 4-octave value-fBM measuring mean 0.4307 / sigma 0.0896 /
 * max 0.7176, so the historical threshold left the field's support entirely
 * below coverage 0.283 and rendered every fair-weather sky clear
 * (CLOUD-LOW-COVERAGE-CUTOFF). The re-derived response makes the cloudy volume
 * fraction a constant-elasticity function of coverage below the anchor while
 * reproducing the historical response exactly at and above it.
 *
 * f32-faithful: every intermediate is rounded the way WGSL evaluates it, so a
 * spec can compare this against the shader's arithmetic rather than against an
 * f64 idealisation. `Math.pow` is evaluated in f64 and then rounded, which can
 * differ from a driver's `exp2(y * log2(x))` decomposition by an ULP for a
 * general argument — but not at the anchor, where the ratio is exactly 1 and
 * both spellings return exactly 1.
 *
 * @param {number} coverage Requested cloud coverage in [0, 1].
 * @returns {number} The effective coverage the density gate should use.
 */
export function cloudEffectiveCoverage(coverage: number): number {
  const requested = Math.fround(coverage);
  if (!(requested > 0.0)) {
    return 0.0;
  }
  // The shader's constants are f32; round them here too so `c === anchor`
  // divides to exactly 1 and the anchor reproduces itself bit-for-bit.
  const anchor = Math.fround(CLOUD_COVERAGE_ANCHOR);
  const exponent = Math.fround(CLOUD_COVERAGE_EXPONENT);
  const c = Math.min(requested, 1.0);
  const ratio = Math.fround(c / anchor);
  const lifted = Math.fround(anchor * Math.fround(Math.pow(ratio, exponent)));
  return Math.max(c, lifted);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * Write one periodic domain phase without allocating temporary vectors.
 *
 * `worldX/Y/Z` stay as JavaScript f64 numbers through the dot products. Matrix,
 * scale, and offset constants are already rounded to the values WGSL consumes;
 * only the final periodic phases are down-cast for uniform storage.
 */
function writeDomainOriginPhase(
  target: Float32Array,
  targetOffset: number,
  worldX: number,
  worldY: number,
  worldZ: number,
  scale: number,
  rotation: readonly number[],
  phaseOffset: readonly number[],
): void {
  const noiseScale = CLOUD_DENSITY_WORLD_TO_NOISE * scale;
  const x = worldX * noiseScale;
  const y = worldY * noiseScale;
  const z = worldZ * noiseScale;

  target[targetOffset] = Math.fround(
    fract(rotation[0] * x + rotation[1] * y + rotation[2] * z + phaseOffset[0]),
  );
  target[targetOffset + 1] = Math.fround(
    fract(rotation[3] * x + rotation[4] * y + rotation[5] * z + phaseOffset[1]),
  );
  target[targetOffset + 2] = Math.fround(
    fract(rotation[6] * x + rotation[7] * y + rotation[8] * z + phaseOffset[2]),
  );
  target[targetOffset + 3] = 0.0;
}

/**
 * Write the three periodic noise-domain phases for a world-space f64 origin.
 *
 * This is intended for the existing per-frame cloud-uniform packer. The caller
 * supplies storage and a starting float offset; this hot helper creates no
 * arrays, objects, or typed-array views. `puffSize` is rounded once to the f32
 * value the shader receives, and the warp's composite scale is rounded like a
 * WGSL f32 multiply.
 */
export function writeCloudDensityOriginPhases(
  target: Float32Array,
  targetOffset: number,
  worldX: number,
  worldY: number,
  worldZ: number,
  puffSize: number,
): void {
  const puffSizeF32 = Math.fround(puffSize);
  const warpScale = Math.fround(puffSizeF32 * CLOUD_DENSITY_WARP_RATIO);

  writeDomainOriginPhase(
    target,
    targetOffset + CLOUD_DENSITY_SHAPE_ORIGIN_PHASE_OFFSET,
    worldX,
    worldY,
    worldZ,
    puffSizeF32,
    CLOUD_DENSITY_SHAPE_ROTATION,
    CLOUD_DENSITY_SHAPE_OFFSET,
  );
  writeDomainOriginPhase(
    target,
    targetOffset + CLOUD_DENSITY_WARP_ORIGIN_PHASE_OFFSET,
    worldX,
    worldY,
    worldZ,
    warpScale,
    CLOUD_DENSITY_WARP_ROTATION,
    CLOUD_DENSITY_WARP_OFFSET,
  );
  writeDomainOriginPhase(
    target,
    targetOffset + CLOUD_DENSITY_DETAIL_ORIGIN_PHASE_OFFSET,
    worldX,
    worldY,
    worldZ,
    CLOUD_DENSITY_DETAIL_RATIO,
    CLOUD_DENSITY_DETAIL_ROTATION,
    CLOUD_DENSITY_DETAIL_OFFSET,
  );
}

/**
 * Write texture-domain phases after applying cloud advection in CPU f64.
 *
 * Keeping `windSpeed * timeSeconds` out of WGSL prevents long timeline scrubs
 * from quantizing a planet-scale displacement to f32 before the periodic phase
 * is taken. The historical LIVE route still receives its original f32 time
 * uniform; this helper is for the new baked planet-domain route only.
 */
export function writeCloudDensityAdvectedOriginPhases(
  target: Float32Array,
  targetOffset: number,
  worldX: number,
  worldY: number,
  worldZ: number,
  puffSize: number,
  windDirectionX: number,
  windDirectionY: number,
  windSpeed: number,
  timeSeconds: number,
): void {
  const advectionMeters = windSpeed * timeSeconds;
  writeCloudDensityOriginPhases(
    target,
    targetOffset,
    worldX + windDirectionX * advectionMeters,
    worldY,
    worldZ + windDirectionY * advectionMeters,
    puffSize,
  );
}

/**
 * Encode the advected, unrotated morphology origin in canonical noise units.
 *
 * The shader evaluates `high + (low + cameraRelativeNoise)`. This preserves
 * the historical ECEF x/y/z orientation needed by analytic morphology while
 * avoiding wrapped-domain seams and camera-relative swimming. The two vec3
 * rows are written in place without temporary vectors or typed-array views.
 */
export function writeCloudMorphologyOriginHighLow(
  target: Float32Array,
  targetOffset: number,
  worldX: number,
  worldY: number,
  worldZ: number,
  windDirectionX: number,
  windDirectionY: number,
  windSpeed: number,
  timeSeconds: number,
): void {
  const advectionMeters = windSpeed * timeSeconds;
  const noiseX =
    (worldX + windDirectionX * advectionMeters) * CLOUD_DENSITY_WORLD_TO_NOISE;
  const noiseY = worldY * CLOUD_DENSITY_WORLD_TO_NOISE;
  const noiseZ =
    (worldZ + windDirectionY * advectionMeters) * CLOUD_DENSITY_WORLD_TO_NOISE;
  const highX = Math.fround(noiseX);
  const highY = Math.fround(noiseY);
  const highZ = Math.fround(noiseZ);

  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET] = highX;
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET + 1] =
    highY;
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET + 2] =
    highZ;
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_HIGH_OFFSET + 3] = 0.0;
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET] =
    Math.fround(noiseX - highX);
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET + 1] =
    Math.fround(noiseY - highY);
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET + 2] =
    Math.fround(noiseZ - highZ);
  target[targetOffset + CLOUD_DENSITY_MORPHOLOGY_ORIGIN_LOW_OFFSET + 3] = 0.0;
}
