/**
 * The slot layout of the cloud main uniform block (`CloudUniforms` in
 * `ProceduralClouds.wgsl`) and the rule it follows: R-2026-09-26-12, restated
 * for this layout under R-2026-10-22-11.
 *
 * 1. Every slot is named: here by range, and in the WGSL struct per field, with
 *    the slot number beside each field from slot 64 on.
 * 2. Slots are append-only at the tail. No slot is reordered, reused or
 *    resized.
 * 3. A withdrawn or re-cut unit's slots stay as named reserved pads that every
 *    writer fills with zero. The block never shrinks.
 * 4. The bits of the private word at slot 175 are add-only, like define bits.
 * 5. `cloud-uniform-layout.spec.mjs` pins the size and every named range, and
 *    a writer that puts a non-zero value into a reserved pad turns it red.
 *
 * @module WebGPUCloudUniformLayout
 */

/** One named, contiguous run of float slots. */
export interface CloudUniformRange {
  /** The block's name; for a single WGSL field, the field's own name. */
  readonly name: string;
  /** First float slot. */
  readonly offset: number;
  /** Number of float slots. */
  readonly floats: number;
  /** The WGSL struct field that starts the range. */
  readonly first: string;
  /** The WGSL struct field that ends it. */
  readonly last: string;
}

function range(
  name: string,
  offset: number,
  floats: number,
  first: string = name,
  last: string = first,
): CloudUniformRange {
  return Object.freeze({ name, offset, floats, first, last });
}

/**
 * The core range's quality-flags float (`qualityFlags`, slot 74): the bit
 * field the frame's writers OR their `CLOUD_QF_*` bits into.
 */
export const CLOUD_QUALITY_FLAGS_SLOT = 74;

/** The geographic material-flow tail (176-179): age, enable flag, two pads. */
export const CLOUD_MATERIAL_FLOW_OFFSET = 176;
export const CLOUD_MATERIAL_FLOW_FLOATS = 4;

/**
 * Every range of the block, in slot order and without a gap. The first block
 * spans the original fields, which the WGSL struct names one by one.
 */
export const CLOUD_UNIFORM_RANGES: readonly CloudUniformRange[] = Object.freeze(
  [
    range("core", 0, 148, "inverseProjection", "_padK"),
    range("densityPrimaryOrigin", 148, 20, "densityShapeOriginPhase", "_padP"),
    range("genusMorphology", 168, 4, "genusFibreStrength", "genusPhaseDelta"),
    range("tierLighting", 172, 3, "powderStrength", "ambientFloor"),
    range("_padQ", 175, 1),
    range("materialFlowAge", 176, 1),
    range("materialFlowEnabled", 177, 1),
    range("_padFlow0", 178, 1),
    range("_padFlow1", 179, 1),
  ],
);

/** Slots every writer fills with zero (rule 3); slot 175's bits are rule 4's. */
export const CLOUD_UNIFORM_RESERVED_SLOTS: readonly number[] = Object.freeze([
  175, 178, 179,
]);

/** Float count of the block, from the ranges. */
export const CLOUD_UNIFORM_LAYOUT_FLOATS = CLOUD_UNIFORM_RANGES.reduce(
  (end, r) => Math.max(end, r.offset + r.floats),
  0,
);

/**
 * Writes the material-flow tail at `offset`: the bounded flow age, the enable
 * flag, and zero into both reserved pads. Returns the next offset.
 */
export function writeCloudMaterialFlowUniforms(
  data: Float32Array,
  offset: number,
  ageSeconds: number,
  enabled: boolean,
): number {
  data[offset] = ageSeconds;
  data[offset + 1] = enabled ? 1 : 0;
  data[offset + 2] = 0;
  data[offset + 3] = 0;
  return offset + CLOUD_MATERIAL_FLOW_FLOATS;
}
