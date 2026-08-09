/// <reference types="@webgpu/types" />
/**
 * The single enforceable home for glTF primitive-mode to WebGPU topology
 * realization on the model path.
 *
 * Topology is a two-field pipeline axis — `topology` and `stripIndexFormat` —
 * and the two are not independent: WebGPU bakes the strip restart value into
 * the pipeline, so a `triangle-strip` built for a `uint16` index buffer is not
 * interchangeable with one built for `uint32`. Were the fields writable
 * separately at the roughly eighteen model and shadow descriptor sites, one
 * site would eventually carry the topology without the format, and the two
 * logical pipelines would alias onto a single cache entry — a defect that
 * raises the hit rate, so no cache counter can report it.
 *
 * Both fields therefore travel together as one opaque
 * {@link ModelTopologyRealization}, and both the pipeline `primitive` block and
 * the pipeline cache key are derived from it by {@link modelPrimitiveState} and
 * {@link buildModelTopologyVariantKey}. No consumer spells either field out.
 *
 * Realization is preparation, never draw. {@link realizeModelPrimitiveTopology}
 * runs once per primitive, from the per-primitive cache build in
 * `WebGPUModelRenderer`, and its output is stored on the primitive's cache
 * record. LINE_LOOP closure and TRIANGLE_FAN expansion allocate and rewrite an
 * index list, which is a cost paid once at preparation rather than per draw.
 *
 * WebGPU has five topologies where glTF has seven modes. Three map natively
 * (POINTS to point-list, LINES to line-list, TRIANGLES to triangle-list); two
 * map natively but constrain the pipeline (LINE_STRIP to line-strip,
 * TRIANGLE_STRIP to triangle-strip, both of which require `stripIndexFormat`);
 * and two have no WebGPU counterpart:
 *
 *   - LINE_LOOP has no `"line-loop"`. Realized as `line-list` with the closing
 *     segment (last to first of each run) appended.
 *   - TRIANGLE_FAN has no `"triangle-fan"`. Realized as `triangle-list` by
 *     expanding each run `[c, v1, v2, v3, ...]` into `(c,v1,v2), (c,v2,v3), …`.
 *
 * Primitive restart is implicit and unconditional for strip topologies in
 * WebGPU, using the maximum value of the pipeline's `stripIndexFormat`
 * (`0xFFFF` for uint16, `0xFFFFFFFF` for uint32). That matches WebGL2's fixed
 * restart index, so LINE_STRIP and TRIANGLE_STRIP need no index rewriting —
 * only the correct `stripIndexFormat`.
 *
 * The backends genuinely diverge on UNSIGNED_BYTE indices. glTF allows them and
 * WebGPU has no `uint8` index format, so `ModelPrimitiveGeometry` upcasts
 * `Uint8Array` to `Uint16Array`. The upcast turns the uint8 restart sentinel
 * `0xFF` into the ordinary index `0x00FF`, which is not the uint16 sentinel, so
 * every restart in the asset would silently become a real vertex reference.
 * {@link realizeModelPrimitiveTopology} repairs that by mapping `0x00FF` to
 * `0xFFFF`, and only for the four modes `KHR_mesh_primitive_restart` declares
 * restart-capable: LINE_STRIP, LINE_LOOP, TRIANGLE_STRIP and TRIANGLE_FAN. See
 * `Scene/getMeshPrimitives.js`, which rejects any other mode outright. For
 * LINES, TRIANGLES and POINTS the value `255` is a legitimate vertex index and
 * translating it would corrupt the mesh, so those modes are never translated.
 * The caller signals the source width with `indexSourceComponentBytes`, which a
 * mode that is not restart-capable ignores.
 *
 * TRIANGLES yields {@link MODEL_TOPOLOGY_TRIANGLE_LIST}, whose variant key is
 * the base key unchanged, so every already-cached triangle pipeline keeps its
 * key; POINTS yields point-list plus sequential-index synthesis.
 *
 * @module WebGPUModelTopology
 */

import PrimitiveType from "../../Core/PrimitiveType.js";

/** How a glTF mode reaches its WebGPU topology. */
export type ModelTopologyConversion =
  /** Native: the index list is uploaded unchanged. */
  | "none"
  /** LINE_LOOP → line-list, closing segment appended per run. */
  | "line-loop-close"
  /** TRIANGLE_FAN → triangle-list, each run expanded around its hub. */
  | "triangle-fan-expand";

/** Static, asset-independent facts about one glTF draw mode. */
export interface ModelTopologyMapping {
  /** The GPUPrimitiveTopology the pipeline bakes in. */
  readonly topology: GPUPrimitiveTopology;
  /** What must happen to the index list to reach `topology`. */
  readonly conversion: ModelTopologyConversion;
  /**
   * True for `line-strip` / `triangle-strip`, the two topologies whose
   * pipelines MUST declare `stripIndexFormat` for an indexed draw.
   */
  readonly isStrip: boolean;
  /**
   * True for the four modes `KHR_mesh_primitive_restart` permits. Gates the
   * uint8 `0xFF` → uint16 `0xFFFF` translation; on every other mode the
   * sentinel value is an ordinary vertex index.
   */
  readonly restartCapable: boolean;
  /**
   * True when a NON-indexed primitive of this mode must be given synthesized
   * sequential indices before it can be drawn. False for TRIANGLES alone,
   * which keeps its historical non-indexed `draw(vertexCount)` path.
   */
  readonly synthesizesIndices: boolean;
}

/** The uint8 primitive-restart sentinel, as it survives the uint16 upcast. */
export const UINT8_RESTART_AS_UINT16 = 0x00ff;
/** The uint16 primitive-restart sentinel WebGPU uses for uint16 strips. */
export const UINT16_RESTART = 0xffff;
/** The uint32 primitive-restart sentinel WebGPU uses for uint32 strips. */
export const UINT32_RESTART = 0xffffffff;

const TRIANGLES_MAPPING: ModelTopologyMapping = Object.freeze({
  topology: "triangle-list" as GPUPrimitiveTopology,
  conversion: "none" as ModelTopologyConversion,
  isStrip: false,
  restartCapable: false,
  synthesizesIndices: false,
});

/**
 * EXHAUSTIVE over glTF's seven draw modes, keyed by `PrimitiveType` (which is
 * the WebGL enum, so POINTS === 0 — never test these with truthiness).
 *
 * This table is the ONLY place a glTF mode is turned into a topology. Adding a
 * mode means adding a row here; there is no `switch` anywhere else to forget.
 */
export const MODEL_TOPOLOGY_TABLE: Readonly<
  Record<number, ModelTopologyMapping>
> = Object.freeze({
  [PrimitiveType.POINTS]: Object.freeze({
    topology: "point-list" as GPUPrimitiveTopology,
    conversion: "none" as ModelTopologyConversion,
    isStrip: false,
    restartCapable: false,
    // GLTF-POINTS-MODE precedent: a non-indexed point cloud binds the pipeline
    // cache's 1-element default buffers for its absent attributes, which a
    // non-indexed `draw()` rejects CPU-side but `drawIndexed` tolerates via
    // robust access.
    synthesizesIndices: true,
  }),
  [PrimitiveType.LINES]: Object.freeze({
    topology: "line-list" as GPUPrimitiveTopology,
    conversion: "none" as ModelTopologyConversion,
    isStrip: false,
    // `KHR_mesh_primitive_restart` explicitly excludes list modes; 255 is a
    // real vertex index in a uint8 LINES asset.
    restartCapable: false,
    synthesizesIndices: true,
  }),
  [PrimitiveType.LINE_LOOP]: Object.freeze({
    // No WebGPU "line-loop" — realized by appending each run's closing segment.
    topology: "line-list" as GPUPrimitiveTopology,
    conversion: "line-loop-close" as ModelTopologyConversion,
    isStrip: false,
    restartCapable: true,
    synthesizesIndices: true,
  }),
  [PrimitiveType.LINE_STRIP]: Object.freeze({
    topology: "line-strip" as GPUPrimitiveTopology,
    conversion: "none" as ModelTopologyConversion,
    isStrip: true,
    restartCapable: true,
    synthesizesIndices: true,
  }),
  [PrimitiveType.TRIANGLES]: TRIANGLES_MAPPING,
  [PrimitiveType.TRIANGLE_STRIP]: Object.freeze({
    topology: "triangle-strip" as GPUPrimitiveTopology,
    conversion: "none" as ModelTopologyConversion,
    isStrip: true,
    restartCapable: true,
    synthesizesIndices: true,
  }),
  [PrimitiveType.TRIANGLE_FAN]: Object.freeze({
    // No WebGPU "triangle-fan" — realized by expanding each run around its hub.
    topology: "triangle-list" as GPUPrimitiveTopology,
    conversion: "triangle-fan-expand" as ModelTopologyConversion,
    isStrip: false,
    restartCapable: true,
    synthesizesIndices: true,
  }),
});

/**
 * The realized backend state for one primitive. Produced once in preparation,
 * stored on the primitive's cache record, and consumed unchanged by every
 * pipeline descriptor and cache key for the life of the primitive.
 */
export interface ModelTopologyRealization {
  /** Baked into every color / pick / velocity / capture / shadow pipeline. */
  readonly topology: GPUPrimitiveTopology;
  /**
   * REQUIRED by WebGPU for an indexed strip draw, and forbidden otherwise.
   * `undefined` for every non-strip topology. Part of the pipeline identity:
   * uint16 and uint32 strips are different pipelines because the implicit
   * restart value differs.
   */
  readonly stripIndexFormat: GPUIndexFormat | undefined;
  /** Which conversion produced `indexData`. */
  readonly conversion: ModelTopologyConversion;
  /** True when uint8 `0xFF` restarts were rewritten to uint16 `0xFFFF`. */
  readonly restartTranslated: boolean;
  /** True when a non-indexed primitive was given sequential indices. */
  readonly synthesizedIndices: boolean;
  /**
   * The index list to upload, or `null` when the primitive stays non-indexed
   * (TRIANGLES with no indices — the historical `draw()` path).
   */
  readonly indexData: Uint16Array | Uint32Array | null;
  /** Element count of `indexData`; `0` when non-indexed. */
  readonly indexCount: number;
  /** Index format of `indexData`. Meaningless when `indexData` is `null`. */
  readonly indexFormat: GPUIndexFormat;
  /**
   * CONVERSION COST MODEL. `0` means `indexData` is the caller's own array by
   * reference and preparation allocated nothing. Non-zero is the byte size of
   * the one array this realization allocated — paid once per primitive, in
   * preparation.
   */
  readonly allocatedIndexBytes: number;
}

/**
 * The realization every ordinary triangle primitive gets. Its variant key is the
 * base key unchanged and its `primitive` block is `{ topology, cullMode }` with
 * no `stripIndexFormat`, so triangle pipelines keep their exact keys and
 * descriptors.
 */
export const MODEL_TOPOLOGY_TRIANGLE_LIST: ModelTopologyRealization =
  Object.freeze({
    topology: "triangle-list" as GPUPrimitiveTopology,
    stripIndexFormat: undefined,
    conversion: "none" as ModelTopologyConversion,
    restartTranslated: false,
    synthesizedIndices: false,
    indexData: null,
    indexCount: 0,
    indexFormat: "uint16" as GPUIndexFormat,
    allocatedIndexBytes: 0,
  });

/** Input to {@link realizeModelPrimitiveTopology}. */
export interface ModelTopologySpec {
  /** `PrimitiveType` / WebGL draw mode. `undefined` falls back to TRIANGLES. */
  primitiveType: number | undefined;
  /** Extracted index list, already upcast off uint8 by the extractor. */
  indexData: Uint16Array | Uint32Array | null | undefined;
  /** Vertex count, used when synthesizing indices for a non-indexed mode. */
  vertexCount: number;
  /**
   * Byte width of the ORIGINAL glTF index accessor (1 / 2 / 4). `1` is the
   * only value that changes behavior: it tells the realization that
   * `0x00FF` entries were `0xFF` restarts before the extractor's upcast.
   */
  indexSourceComponentBytes?: number;
}

/** Looks up the static mapping for a glTF mode; TRIANGLES for anything else. */
export function getModelTopologyMapping(
  primitiveType: number | undefined,
): ModelTopologyMapping {
  if (primitiveType === undefined || primitiveType === null) {
    return TRIANGLES_MAPPING;
  }
  return MODEL_TOPOLOGY_TABLE[primitiveType] ?? TRIANGLES_MAPPING;
}

function indexFormatOf(data: Uint16Array | Uint32Array): GPUIndexFormat {
  return data instanceof Uint32Array ? "uint32" : "uint16";
}

function restartValueFor(data: Uint16Array | Uint32Array): number {
  return data instanceof Uint32Array ? UINT32_RESTART : UINT16_RESTART;
}

/**
 * Sequential `[0, 1, … n)` indices, in the narrowest format that addresses
 * every vertex.
 *
 * `n < 65536` is also exactly the restart-safe ceiling, which is why strips
 * need no separate rule: the largest index it can emit is `n - 1 = 65534`,
 * one below the uint16 restart sentinel. `n === 65536` would emit `0xFFFF`,
 * which every strip pipeline reads as a restart — and that case already falls
 * to uint32. The bound is unchanged from the GLTF-POINTS-MODE original.
 */
function synthesizeSequentialIndices(n: number): Uint16Array | Uint32Array {
  const out = n < 65536 ? new Uint16Array(n) : new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = i;
  }
  return out;
}

/**
 * Rewrites the post-upcast uint8 restart sentinel to the uint16 one. Returns
 * the SAME array reference when the asset contains no restarts, so a
 * restart-free uint8 strip allocates nothing.
 */
function translateUint8Restarts(data: Uint16Array | Uint32Array): {
  data: Uint16Array | Uint32Array;
  translated: boolean;
} {
  if (!(data instanceof Uint16Array)) {
    // A uint8 source is only ever upcast to Uint16Array; a Uint32Array here
    // means the caller mislabeled the source width. Leave it alone.
    return { data, translated: false };
  }
  let found = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === UINT8_RESTART_AS_UINT16) {
      found = true;
      break;
    }
  }
  if (!found) {
    return { data, translated: false };
  }
  // Copy rather than rewrite in place: `data` belongs to the cached immutable
  // base geometry descriptor, which other consumers still read.
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] === UINT8_RESTART_AS_UINT16 ? UINT16_RESTART : data[i];
  }
  return { data: out, translated: true };
}

/**
 * Splits an index list on its restart sentinel into contiguous `[start, end)`
 * runs, skipping empty runs. A list with no restarts yields exactly one run,
 * so the loop-close / fan-expand paths need no special case for the common
 * single-primitive asset.
 */
function splitRuns(
  data: Uint16Array | Uint32Array,
  restart: number,
): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i === data.length || data[i] === restart) {
      if (i > start) {
        runs.push([start, i]);
      }
      start = i + 1;
    }
  }
  return runs;
}

function allocateLike(
  source: Uint16Array | Uint32Array,
  length: number,
): Uint16Array | Uint32Array {
  return source instanceof Uint32Array
    ? new Uint32Array(length)
    : new Uint16Array(length);
}

/**
 * LINE_LOOP → line-list. Each run `[a, b, c, d]` becomes the segment pairs
 * `(a,b) (b,c) (c,d) (d,a)` — the trailing pair is the closing segment WebGPU
 * has no topology for. Runs shorter than two vertices emit nothing (a
 * degenerate single-vertex loop has no segment); a two-vertex run emits the
 * single segment `(a,b)` once rather than the degenerate `(a,b) (b,a)`, which
 * matches what a GL LINE_LOOP rasterizes.
 */
export function expandLineLoopToLineList(
  data: Uint16Array | Uint32Array,
  restart: number,
): Uint16Array | Uint32Array {
  const runs = splitRuns(data, restart);
  let total = 0;
  for (const [start, end] of runs) {
    const n = end - start;
    if (n >= 3) {
      total += n * 2;
    } else if (n === 2) {
      total += 2;
    }
  }
  const out = allocateLike(data, total);
  let w = 0;
  for (const [start, end] of runs) {
    const n = end - start;
    if (n < 2) {
      continue;
    }
    for (let i = 0; i < n - 1; i++) {
      out[w++] = data[start + i];
      out[w++] = data[start + i + 1];
    }
    if (n >= 3) {
      out[w++] = data[end - 1];
      out[w++] = data[start];
    }
  }
  return out;
}

/**
 * TRIANGLE_FAN → triangle-list. Each run `[c, v1, v2, v3, …]` becomes
 * `(c,v1,v2) (c,v2,v3) …`, preserving the fan's winding so backface culling is
 * unchanged. Runs shorter than three vertices emit nothing.
 */
export function expandTriangleFanToTriangleList(
  data: Uint16Array | Uint32Array,
  restart: number,
): Uint16Array | Uint32Array {
  const runs = splitRuns(data, restart);
  let total = 0;
  for (const [start, end] of runs) {
    const n = end - start;
    if (n >= 3) {
      total += (n - 2) * 3;
    }
  }
  const out = allocateLike(data, total);
  let w = 0;
  for (const [start, end] of runs) {
    const n = end - start;
    if (n < 3) {
      continue;
    }
    const hub = data[start];
    for (let i = 1; i < n - 1; i++) {
      out[w++] = hub;
      out[w++] = data[start + i];
      out[w++] = data[start + i + 1];
    }
  }
  return out;
}

/**
 * THE realization entry point. Pure, allocation-free on the TRIANGLES and
 * already-indexed native paths, and called exactly once per primitive from
 * preparation. Never call this from a draw path.
 *
 * @param {ModelTopologySpec} spec
 * @returns {ModelTopologyRealization}
 */
export function realizeModelPrimitiveTopology(
  spec: ModelTopologySpec,
): ModelTopologyRealization {
  const mapping = getModelTopologyMapping(spec.primitiveType);

  let data = spec.indexData ?? null;
  let synthesized = false;
  let allocatedIndexBytes = 0;

  // (d) Non-indexed primitives: every mode except TRIANGLES gets safe
  // sequential indices so the draw takes `drawIndexed`. TRIANGLES keeps its
  // historical non-indexed `draw(vertexCount)` path byte-identically.
  if (data === null && mapping.synthesizesIndices && spec.vertexCount > 0) {
    data = synthesizeSequentialIndices(spec.vertexCount);
    synthesized = true;
    allocatedIndexBytes = data.byteLength;
  }

  if (data === null) {
    // Non-indexed TRIANGLES (or a zero-vertex primitive of any mode — the
    // synthesis above needs at least one vertex). `stripIndexFormat` stays
    // undefined here and that is CORRECT even for a strip: WebGPU requires it
    // only for pipelines used with indexed draws, and forbids it otherwise.
    return mapping.topology === "triangle-list"
      ? MODEL_TOPOLOGY_TRIANGLE_LIST
      : Object.freeze({
          topology: mapping.topology,
          stripIndexFormat: undefined,
          conversion: mapping.conversion,
          restartTranslated: false,
          synthesizedIndices: false,
          indexData: null,
          indexCount: 0,
          indexFormat: "uint16" as GPUIndexFormat,
          allocatedIndexBytes: 0,
        });
  }

  // (c) uint8 restart repair — restart-capable modes only. A uint8 LINES or
  // TRIANGLES asset must NOT be touched: its `255` is a real vertex.
  let restartTranslated = false;
  if (mapping.restartCapable && spec.indexSourceComponentBytes === 1) {
    const translated = translateUint8Restarts(data);
    if (translated.translated) {
      allocatedIndexBytes = translated.data.byteLength;
      restartTranslated = true;
    }
    data = translated.data;
  }

  // (b) Conversions WebGPU cannot express as a topology.
  const restart = restartValueFor(data);
  if (mapping.conversion === "line-loop-close") {
    data = expandLineLoopToLineList(data, restart);
    allocatedIndexBytes = data.byteLength;
  } else if (mapping.conversion === "triangle-fan-expand") {
    data = expandTriangleFanToTriangleList(data, restart);
    allocatedIndexBytes = data.byteLength;
  }

  const indexFormat = indexFormatOf(data);
  return Object.freeze({
    topology: mapping.topology,
    // (a) A strip pipeline MUST declare the format whose max value is its
    // restart sentinel; a non-strip pipeline must NOT declare one at all.
    stripIndexFormat: mapping.isStrip ? indexFormat : undefined,
    conversion: mapping.conversion,
    restartTranslated,
    synthesizedIndices: synthesized,
    indexData: data,
    indexCount: data.length,
    indexFormat,
    allocatedIndexBytes,
  });
}

/**
 * Builds a realization from an already-decided topology pair. Used by the
 * pipeline cache's sticky-state setter, whose callers hand it the value that
 * `realizeModelPrimitiveTopology` produced in preparation.
 *
 * Anything that is not a known topology collapses to
 * {@link MODEL_TOPOLOGY_TRIANGLE_LIST}, so a stale or malformed value can never
 * leak a non-triangle pipeline into a triangle primitive.
 */
export function modelTopologyRealizationFrom(
  topology: string | undefined,
  stripIndexFormat: string | undefined,
): ModelTopologyRealization {
  if (topology === undefined || topology === "triangle-list") {
    return MODEL_TOPOLOGY_TRIANGLE_LIST;
  }
  if (
    topology !== "point-list" &&
    topology !== "line-list" &&
    topology !== "line-strip" &&
    topology !== "triangle-strip"
  ) {
    return MODEL_TOPOLOGY_TRIANGLE_LIST;
  }
  const isStrip = topology === "line-strip" || topology === "triangle-strip";
  if (
    isStrip &&
    stripIndexFormat !== "uint16" &&
    stripIndexFormat !== "uint32"
  ) {
    // A strip pipeline without a format is invalid WebGPU. Refusing to build
    // one is strictly better than creating an aliasing entry: the primitive
    // falls back to the historical triangle-list rather than corrupting the
    // cache for every other strip primitive.
    return MODEL_TOPOLOGY_TRIANGLE_LIST;
  }
  return Object.freeze({
    topology: topology as GPUPrimitiveTopology,
    stripIndexFormat: isStrip
      ? (stripIndexFormat as GPUIndexFormat)
      : undefined,
    conversion: "none" as ModelTopologyConversion,
    restartTranslated: false,
    synthesizedIndices: false,
    indexData: null,
    indexCount: 0,
    indexFormat: (stripIndexFormat === "uint32"
      ? "uint32"
      : "uint16") as GPUIndexFormat,
    allocatedIndexBytes: 0,
  });
}

/**
 * The pipeline `primitive` block for every model and model-shadow pipeline.
 * Both topology fields are emitted here or not at all, which is what makes it
 * impossible for a descriptor site to carry the topology without its format.
 *
 * For `triangle-list` the returned object is `{ topology, cullMode }`.
 */
export function modelPrimitiveState(
  realization: ModelTopologyRealization,
  cullMode: GPUCullMode,
): GPUPrimitiveState {
  if (realization.stripIndexFormat === undefined) {
    return { topology: realization.topology, cullMode };
  }
  return {
    topology: realization.topology,
    cullMode,
    stripIndexFormat: realization.stripIndexFormat,
  };
}

/** Closed set of topology tokens a variant key may carry. */
const TOPOLOGY_TOKENS: readonly string[] = Object.freeze([
  "point-list",
  "line-list",
  "line-strip",
  "triangle-list",
  "triangle-strip",
]);
/** Closed set of strip-index-format tokens a variant key may carry. */
const STRIP_FORMAT_TOKENS: readonly string[] = Object.freeze([
  "uint16",
  "uint32",
]);

/**
 * The complete topology axis as ONE token: `"<topology>"`, or
 * `"<topology>:<stripIndexFormat>"` for the two strip topologies whose
 * pipelines differ by index format. Every cache key that needs to distinguish
 * topologies — the model pipeline caches AND the shadow cast pipeline cache —
 * is built from this, so no key can carry a topology without its format.
 */
export function modelTopologyAxisToken(
  realization: ModelTopologyRealization,
): string {
  return realization.stripIndexFormat === undefined
    ? realization.topology
    : `${realization.topology}:${realization.stripIndexFormat}`;
}

/**
 * Folds the topology axis into a pipeline cache key. `triangle-list` returns the
 * key unchanged — numeric for the numeric-keyed caches, string for the
 * string-keyed ones — so a triangle pipeline keeps a byte-identical key and
 * nothing recompiles.
 *
 * Strips additionally carry their `stripIndexFormat`, which is what stops a
 * uint16 and a uint32 `triangle-strip` from aliasing onto one entry. The central
 * pipeline cache keys off `descriptor.name`, which embeds this key, so the
 * distinction propagates all the way down.
 */
export function buildModelTopologyVariantKey(
  key: number | string,
  realization: ModelTopologyRealization,
): number | string {
  if (realization.topology === "triangle-list") {
    return key;
  }
  return `${key}:${modelTopologyAxisToken(realization)}`;
}

/** Fields recovered from a variant key by {@link parseModelTopologyVariantKey}. */
export interface ModelTopologyKeyFields {
  /** Everything ahead of the topology segment. */
  baseKey: string;
  topology: GPUPrimitiveTopology;
  stripIndexFormat: GPUIndexFormat | undefined;
  /**
   * Anything appended AFTER the topology segment by a later wrapper (today
   * only the pipeline cache's `:m34` metadata-transport marker). Preserved so
   * build and parse stay exact inverses over composed keys.
   */
  trailing: string;
}

/**
 * Exact inverse of {@link buildModelTopologyVariantKey}. A key with no topology
 * segment parses as `triangle-list` — the meaning of an unchanged key — so the
 * two functions round-trip over every input, which is what prevents one side
 * from gaining a field the other does not know about.
 *
 * Returns `null` only for a structurally impossible key (a strip token with no
 * format, or a format token with no strip). Reporting that rather than guessing
 * is the honesty contract: an unparseable key is a visible signal that the
 * format moved.
 */
export function parseModelTopologyVariantKey(
  key: number | string,
): ModelTopologyKeyFields | null {
  const text = `${key}`;
  const parts = text.split(":");
  let topologyAt = -1;
  for (let i = 1; i < parts.length; i++) {
    if (TOPOLOGY_TOKENS.includes(parts[i])) {
      if (topologyAt !== -1) {
        return null;
      }
      topologyAt = i;
    }
  }
  if (topologyAt === -1) {
    // No topology segment: the byte-identical triangle-list key. A stray
    // format token with no topology is structurally impossible.
    for (let i = 1; i < parts.length; i++) {
      if (STRIP_FORMAT_TOKENS.includes(parts[i])) {
        return null;
      }
    }
    return {
      baseKey: text,
      topology: "triangle-list",
      stripIndexFormat: undefined,
      trailing: "",
    };
  }
  const topology = parts[topologyAt] as GPUPrimitiveTopology;
  const isStrip = topology === "line-strip" || topology === "triangle-strip";
  const next = parts[topologyAt + 1];
  const hasFormat = next !== undefined && STRIP_FORMAT_TOKENS.includes(next);
  if (isStrip !== hasFormat) {
    return null;
  }
  const tailAt = topologyAt + (hasFormat ? 2 : 1);
  return {
    baseKey: parts.slice(0, topologyAt).join(":"),
    topology,
    stripIndexFormat: hasFormat ? (next as GPUIndexFormat) : undefined,
    trailing: parts.slice(tailAt).join(":"),
  };
}

export default {
  MODEL_TOPOLOGY_TABLE,
  MODEL_TOPOLOGY_TRIANGLE_LIST,
  buildModelTopologyVariantKey,
  expandLineLoopToLineList,
  expandTriangleFanToTriangleList,
  getModelTopologyMapping,
  modelPrimitiveState,
  modelTopologyAxisToken,
  modelTopologyRealizationFrom,
  parseModelTopologyVariantKey,
  realizeModelPrimitiveTopology,
};
