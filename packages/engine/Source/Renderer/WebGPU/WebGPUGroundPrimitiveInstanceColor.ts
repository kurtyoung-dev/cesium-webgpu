/**
 * Resolves the flat colour a WebGPU classification primitive shades with, and
 * packs it into the ground-primitive uniform buffer.
 *
 * `GroundPrimitive` / `ClassificationPrimitive` carry that colour in one of two
 * mutually exclusive places, and the WebGL classifier reads both:
 *
 *   - a material-bearing appearance keeps it in
 *     `appearance.material.uniforms.color`;
 *   - `PerInstanceColorAppearance` — the appearance `GroundPrimitive` installs
 *     by default — has no material at all. Its colour is a per-instance
 *     `ColorGeometryInstanceAttribute`, which `ShadowVolumeAppearanceFS` reads
 *     through the `PER_INSTANCE_COLOR` varying.
 *
 * The WebGPU classifier shades from a uniform rather than from a vertex
 * attribute, so the per-instance value has to be resolved on the CPU. Reading
 * only the appearance material leaves every default `GroundPrimitive` shading
 * with the uniform's untouched fallback instead of its instance colour.
 *
 * Two per-instance sources are tried, in the order the primitive's own
 * lifecycle makes them available:
 *
 *   1. the inner primitive's `BatchTable`, which retains per-instance values
 *      after the becoming-ready flow releases `geometryInstances` (the usual
 *      state by the first WebGPU command build);
 *   2. the raw `geometryInstances`, for a primitive whose batch table has not
 *      been built yet.
 *
 * @private
 * @module WebGPUGroundPrimitiveInstanceColor
 */
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import defined from "../../Core/defined.js";

/** An RGBA colour in the [0, 1] range the classification uniform carries. */
export interface ClassificationColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** The subset of `BatchTable` this module reads. */
interface BatchTableLike {
  _attributes?: ReadonlyArray<{ componentDatatype?: number } | undefined>;
  _numberOfInstances?: number;
  getBatchedAttribute(
    instanceIndex: number,
    attributeIndex: number,
    result?: object,
  ): unknown;
}

/** The subset of `GeometryInstance` this module reads. */
interface GeometryInstanceLike {
  attributes?: Record<
    string,
    { value?: ArrayLike<number>; componentDatatype?: number } | undefined
  >;
}

/**
 * The subset of a `GroundPrimitive` / `ClassificationPrimitive` / `Primitive`
 * wrapper chain this module reads.
 */
export interface ClassificationColorSource {
  appearance?: {
    material?: { uniforms?: { color?: Partial<ClassificationColor> } };
  };
  geometryInstances?: GeometryInstanceLike | GeometryInstanceLike[];
  _batchTable?: BatchTableLike;
  _batchTableAttributeIndices?: Record<string, number | undefined>;
  _primitive?: ClassificationColorSource;
}

/**
 * Component defaults the uniform keeps when nothing resolves. Written per
 * component so a partially populated colour object still fills the rest.
 */
const COLOR_FALLBACK: ClassificationColor = Object.freeze({
  red: 1.0,
  green: 0.0,
  blue: 0.0,
  alpha: 0.5,
});

// A `GroundPrimitive` wraps a `ClassificationPrimitive`, which wraps a
// `Primitive`; the renderer is also invoked with either inner object directly.
// Bounded so a malformed cycle cannot spin here.
const MAX_WRAPPER_DEPTH = 4;

// `Cartesian4.clone` assigns onto whatever result object it is handed, so a
// module scratch keeps the per-frame read allocation-free without pulling the
// Cartesian4 constructor into this module.
const scratchBatchedColor = { x: 0.0, y: 0.0, z: 0.0, w: 0.0 };

/**
 * Walks the wrapper chain, yielding each link from the outermost inwards.
 *
 * @param {ClassificationColorSource} primitive The outermost object.
 * @returns {ClassificationColorSource[]} The chain, outermost first.
 */
function wrapperChain(
  primitive: ClassificationColorSource | undefined,
): ClassificationColorSource[] {
  const chain: ClassificationColorSource[] = [];
  let link = primitive;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && defined(link); depth++) {
    chain.push(link as ClassificationColorSource);
    link = (link as ClassificationColorSource)._primitive;
  }
  return chain;
}

/**
 * Reads the first instance's colour out of a batch table.
 *
 * `BatchTable.getBatchedAttribute` returns a `Cartesian4` for a 4-component
 * attribute, carrying the stored values unscaled — an `UNSIGNED_BYTE` colour
 * comes back in [0, 255]. The attribute's own component datatype is what says
 * which of the two ranges arrived.
 *
 * @param {ClassificationColorSource} owner The object owning the batch table.
 * @returns {ClassificationColor|undefined} The colour, or undefined.
 */
function colorFromBatchTable(
  owner: ClassificationColorSource,
): ClassificationColor | undefined {
  const batchTable = owner._batchTable;
  const index = owner._batchTableAttributeIndices?.color;
  if (!defined(batchTable) || !defined(index)) {
    return undefined;
  }
  if ((batchTable._numberOfInstances ?? 0) < 1) {
    return undefined;
  }
  const scale =
    batchTable._attributes?.[index]?.componentDatatype ===
    ComponentDatatype.UNSIGNED_BYTE
      ? 1.0 / 255.0
      : 1.0;
  const value = batchTable.getBatchedAttribute(0, index, scratchBatchedColor);
  const cartesian = value as Partial<{
    x: number;
    y: number;
    z: number;
    w: number;
  }>;
  if (typeof cartesian?.x === "number" && typeof cartesian?.w === "number") {
    return {
      red: cartesian.x * scale,
      green: (cartesian.y ?? 0.0) * scale,
      blue: (cartesian.z ?? 0.0) * scale,
      alpha: cartesian.w * scale,
    };
  }
  const color = value as Partial<ClassificationColor>;
  if (typeof color?.red === "number" && typeof color?.alpha === "number") {
    return {
      red: color.red,
      green: color.green ?? 0.0,
      blue: color.blue ?? 0.0,
      alpha: color.alpha,
    };
  }
  return undefined;
}

/**
 * Reads the first geometry instance's colour attribute.
 *
 * @param {ClassificationColorSource} primitive The object to read from.
 * @returns {ClassificationColor|undefined} The colour, or undefined.
 */
function colorFromGeometryInstances(
  primitive: ClassificationColorSource,
): ClassificationColor | undefined {
  const raw = primitive.geometryInstances;
  if (!defined(raw)) {
    return undefined;
  }
  const instance = Array.isArray(raw) ? raw[0] : raw;
  const attribute = instance?.attributes?.color;
  const value = attribute?.value;
  if (!defined(value) || value.length < 4) {
    return undefined;
  }
  const scale =
    attribute?.componentDatatype === ComponentDatatype.UNSIGNED_BYTE
      ? 1.0 / 255.0
      : 1.0;
  return {
    red: value[0] * scale,
    green: value[1] * scale,
    blue: value[2] * scale,
    alpha: value[3] * scale,
  };
}

/**
 * Resolves the colour the classification fragment shader shades with.
 *
 * The appearance material wins when one is present: that is the case in which
 * WebGL builds its shader without `PER_INSTANCE_COLOR`, so its colour is the
 * material's. Only a material-less appearance falls through to the per-instance
 * attribute.
 *
 * WebGL selects that branch on the appearance's type rather than on whether it
 * carries a material. The two agree for every appearance the engine ships:
 * `PerInstanceColorAppearance` is the only material-less one, and a
 * material-less appearance of any other type already throws in
 * `ShadowVolumeAppearance`. They part only if a caller assigns a material
 * onto a `PerInstanceColorAppearance`.
 *
 * Only the first instance is read. A primitive carrying several instances
 * with different colours therefore shades them all with the first one's; a
 * per-instance classification colour is a follow-up that needs the shading
 * value to move from the uniform to a vertex attribute, as WebGL already
 * carries it.
 *
 * @param {ClassificationColorSource} primitive The classification primitive.
 * @returns {Partial<ClassificationColor>|undefined} The colour, or undefined
 *   when the primitive carries neither source. A material uniform is returned
 *   as it stands, so a caller must supply its own component fallbacks.
 */
export function resolveClassificationColor(
  primitive: ClassificationColorSource | undefined,
): Partial<ClassificationColor> | undefined {
  const materialColor = primitive?.appearance?.material?.uniforms?.color;
  if (defined(materialColor)) {
    return materialColor;
  }
  const chain = wrapperChain(primitive);
  for (const link of chain) {
    const batched = colorFromBatchTable(link);
    if (defined(batched)) {
      return batched;
    }
  }
  for (const link of chain) {
    const instanced = colorFromGeometryInstances(link);
    if (defined(instanced)) {
      return instanced;
    }
  }
  return undefined;
}

/**
 * Writes the resolved colour into four consecutive uniform floats.
 *
 * @param {Float32Array} data The uniform staging array.
 * @param {number} offset Index of the first of the four floats.
 * @param {ClassificationColorSource} primitive The classification primitive.
 */
export function packClassificationColor(
  data: Float32Array,
  offset: number,
  primitive: ClassificationColorSource | undefined,
): void {
  const color = resolveClassificationColor(primitive);
  data[offset] = color?.red ?? COLOR_FALLBACK.red;
  data[offset + 1] = color?.green ?? COLOR_FALLBACK.green;
  data[offset + 2] = color?.blue ?? COLOR_FALLBACK.blue;
  data[offset + 3] = color?.alpha ?? COLOR_FALLBACK.alpha;
}
