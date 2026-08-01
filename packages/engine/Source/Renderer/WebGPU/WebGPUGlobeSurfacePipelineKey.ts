/// <reference types="@webgpu/types" />
/**
 * Single source of truth for the renderer-local globe pipeline cache keys —
 * both the BUILD side (what `select*Pipeline` stores) and the PARSE side (what
 * a diagnostic surface reports).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The globe surface renderer keys four renderer-local maps (`_pipelineCache`,
 * `_capturePipelineCache`, `_debugFragmentPipelineCache`,
 * `_wireframePipelineCache`) with a hand-built string. For ~15 months the four
 * public accessors on `WebGPUGlobeSurfaceRenderer` (`pipeline`,
 * `pipelineNoNormals`, `pipelineQuantized`, `pipelineQuantizedNoNormals`)
 * re-implemented that string from a stale copy of the format: they built
 * THREE-letter keys (`UNO_28|0`) against a format that gained a fourth letter —
 * the `M`/`G` webMercatorT marker — in `831e2f189b` (2026-04-04). No key of the
 * old shape can ever be stored again, so all four getters returned `null`
 * unconditionally. They were not scaffolding for unfinished work (a Principle-7
 * audit came back negative on all four sources); they were a consumer that
 * silently rotted because the format lived only inside the producer's template
 * literal, with nothing tying the two together.
 *
 * The structural fix is not "update the four literals" — that would rot again on
 * the next marker. It is to give the format ONE enforceable home. Every producer
 * calls {@link buildGlobePipelineCacheKey}; every consumer calls
 * {@link parseGlobePipelineCacheKey} or {@link listGlobePipelineVariants}. A
 * round-trip spec then pins builder and parser against each other, so a new
 * marker cannot be added to one side alone.
 *
 * HONESTY CONTRACT
 * ----------------
 * `parseGlobePipelineCacheKey` returns `null` for a key it does not understand,
 * and `listGlobePipelineVariants` surfaces that as `fields: null` rather than
 * dropping the row or guessing at its shape. A diagnostic that omits what it
 * cannot explain is how the original defect stayed invisible behind green
 * dashboards; an unparseable row is a visible signal that the format moved.
 *
 * KEY GRAMMAR (all four maps)
 * ---------------------------
 * ```
 *   [<debugMode> "_"]  Q|U  N|X  M|G  [B|O]  "_" <stride>
 *     ["_CD"] ["_NC"] ["_" PICK|TBF|DOB|DOF] ["_CAP_" <faceFormat>]
 *     "|" <defines-as-hex>
 * ```
 * - `Q`/`U` — quantized (BITS12) vs uncompressed terrain encoding
 * - `N`/`X` — vertex normals present vs absent
 * - `M`/`G` — webMercatorT present vs geographic-only (the marker the stale
 *   getters predated)
 * - `B`/`O` — blend vs opaque. ABSENT for wireframe keys, which is what
 *   distinguishes a wireframe key from a color key.
 * - `_CD` — hardware clip-distances variant; `_NC` — `cullMode: "none"`
 *   (underground / translucent globe). `_NC` is emitted for the color kind only.
 * - `_PICK` / `_TBF` / `_DOB` / `_DOF` — pick, translucent back-face,
 *   depth-only back-face, depth-only front-face. All share `_pipelineCache`
 *   with the color kind, which is why a listing API must report `kind`.
 * - `_CAP_<format>` — cube-face scene capture (its own map).
 * - The `|` tail is the `ShaderDefine` bitmask via `Number.toString(16)`,
 *   reproduced VERBATIM including the leading `-` a bit-31 define would
 *   produce. The parser accepts that sign so build/parse stay exact inverses.
 *
 * @module WebGPUGlobeSurfacePipelineKey
 */

/**
 * Which pipeline variant a key denotes. Finer-grained than the map it lives in:
 * `color`, `pick`, `translucentBackFace`, `depthOnlyBackFace` and
 * `depthOnlyFrontFace` all share the renderer's `_pipelineCache`.
 */
export type GlobePipelineVariantKind =
  | "color"
  | "pick"
  | "translucentBackFace"
  | "depthOnlyBackFace"
  | "depthOnlyFrontFace"
  | "capture"
  | "debugFragment"
  | "wireframe";

/**
 * Which renderer-local map an entry was read from. Reported by
 * {@link listGlobePipelineVariants} so a caller can tell a `_pipelineCache`
 * color entry from a `_wireframePipelineCache` entry that parses similarly.
 */
export type GlobePipelineCacheName =
  "pipeline" | "capture" | "debugFragment" | "wireframe";

/** Fully-resolved key fields — the output of a successful parse. */
export interface GlobePipelineKeyFields {
  kind: GlobePipelineVariantKind;
  isQuantized: boolean;
  hasNormals: boolean;
  hasWebMercatorT: boolean;
  /** Always `false` for the wireframe kind, which carries no blend marker. */
  isBlend: boolean;
  strideBytes: number;
  useClipDistances: boolean;
  disableCulling: boolean;
  /** `ShaderDefine` bitmask. */
  defines: number;
  /** Present for `capture` only. */
  captureFaceFormat?: string;
  /** Present for `debugFragment` only (the numeric `DebugFragmentMode`). */
  debugFragmentMode?: number;
}

/** Builder input. Optional members default to the historical literals. */
export interface GlobePipelineKeySpec {
  kind: GlobePipelineVariantKind;
  isQuantized: boolean;
  hasNormals: boolean;
  hasWebMercatorT: boolean;
  strideBytes: number;
  defines: number;
  isBlend?: boolean;
  useClipDistances?: boolean;
  disableCulling?: boolean;
  captureFaceFormat?: string;
  debugFragmentMode?: number;
}

/**
 * Structural shape of a `GlobePipelineEntry`. Declared locally rather than
 * imported so this module stays a dependency-free leaf that a pure-Node spec
 * can import directly (`WebGPUGlobeSurfaceTypes` carries a `const enum`, which
 * is not erasable TypeScript and therefore not loadable under Node's type
 * stripping).
 */
export interface GlobePipelineEntryLike {
  descriptor?: { name?: string };
  pipeline: GPURenderPipeline | null;
  pending?: boolean;
}

/** One row of {@link listGlobePipelineVariants}. */
export interface GlobePipelineVariantInfo {
  /** Which renderer-local map this row came from. */
  cache: GlobePipelineCacheName;
  /** The exact stored key. */
  key: string;
  /**
   * Parsed key fields, or `null` when the key does not match the grammar this
   * module defines — surfaced rather than hidden. See the honesty contract.
   */
  fields: GlobePipelineKeyFields | null;
  /**
   * `descriptor.name`, which is the leading segment of the CENTRAL cache key
   * (`WebGPURenderPipelineCache.generateCacheKey` starts from it). Two rows
   * with different `key`s but the same `descriptorName` are the shape that
   * aliases in the central cache.
   */
  descriptorName?: string;
  pipeline: GPURenderPipeline | null;
  /** An async creation is in flight through the central cache. */
  pending: boolean;
  /** The `GPURenderPipeline` has materialized and is usable this frame. */
  materialized: boolean;
}

/** Predicate for {@link findGlobePipelineVariant}: only stated fields are compared. */
export type GlobePipelineVariantCriteria = Partial<GlobePipelineKeyFields>;

/**
 * Suffix marker per kind. `color`, `capture`, `debugFragment` and `wireframe`
 * carry no suffix — their identity comes from the map plus the `_CAP_` segment
 * or the debug-mode prefix.
 */
const KIND_SUFFIX: Record<GlobePipelineVariantKind, string> = {
  color: "",
  pick: "_PICK",
  translucentBackFace: "_TBF",
  depthOnlyBackFace: "_DOB",
  depthOnlyFrontFace: "_DOF",
  capture: "",
  debugFragment: "",
  wireframe: "",
};

const SUFFIX_KIND: Record<string, GlobePipelineVariantKind> = {
  PICK: "pick",
  TBF: "translucentBackFace",
  DOB: "depthOnlyBackFace",
  DOF: "depthOnlyFrontFace",
};

/**
 * Grammar above as one expression. Written to be an exact inverse of
 * {@link buildGlobePipelineCacheKey}; the contract spec round-trips every
 * combination through both so the pair cannot drift apart.
 */
const KEY_PATTERN =
  /^(?:(\d+)_)?([QU])([NX])([MG])([BO])?_(\d+)(_CD)?(_NC)?(?:_(PICK|TBF|DOB|DOF))?(?:_CAP_([^|]+))?\|(-?[0-9a-f]+)$/;

/**
 * Build a renderer-local globe pipeline cache key.
 *
 * Output is byte-identical to the template literals this replaced — the
 * contract spec pins that against a verbatim copy of the originals, because a
 * silent key change would orphan every cached pipeline and re-compile the
 * globe on the frame it shipped.
 *
 * @param spec key fields
 * @returns the cache key
 */
export function buildGlobePipelineCacheKey(spec: GlobePipelineKeySpec): string {
  const quant = spec.isQuantized ? "Q" : "U";
  const norm = spec.hasNormals ? "N" : "X";
  const merc = spec.hasWebMercatorT ? "M" : "G";
  const definesHex = spec.defines.toString(16);

  // Wireframe predates the blend marker and never gained one: its overlay is
  // always drawn opaque over the color pass.
  if (spec.kind === "wireframe") {
    return `${quant}${norm}${merc}_${spec.strideBytes}|${definesHex}`;
  }

  const blend = spec.isBlend ? "B" : "O";

  if (spec.kind === "capture") {
    return `${quant}${norm}${merc}${blend}_${spec.strideBytes}_CAP_${spec.captureFaceFormat}|${definesHex}`;
  }

  if (spec.kind === "debugFragment") {
    return `${spec.debugFragmentMode}_${quant}${norm}${merc}${blend}_${spec.strideBytes}|${definesHex}`;
  }

  const cdSuffix = spec.useClipDistances ? "_CD" : "";
  // Only the color kind ever varied culling: the pick / translucent / depth-only
  // selectors each pin `cullMode` themselves and never emitted `_NC`.
  const ncSuffix =
    spec.kind === "color" && spec.disableCulling === true ? "_NC" : "";

  return `${quant}${norm}${merc}${blend}_${spec.strideBytes}${cdSuffix}${ncSuffix}${KIND_SUFFIX[spec.kind]}|${definesHex}`;
}

/**
 * Parse a renderer-local globe pipeline cache key.
 *
 * @param key the stored key
 * @returns the resolved fields, or `null` when `key` does not match the
 *   grammar — callers MUST surface that rather than substituting a guess.
 */
export function parseGlobePipelineCacheKey(
  key: string,
): GlobePipelineKeyFields | null {
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    return null;
  }
  const [
    ,
    debugMode,
    quant,
    norm,
    merc,
    blend,
    stride,
    cd,
    nc,
    suffix,
    captureFormat,
    definesHex,
  ] = match;

  // A key cannot be two kinds at once; ambiguity means the grammar moved.
  let kind: GlobePipelineVariantKind;
  if (debugMode !== undefined) {
    if (suffix !== undefined || captureFormat !== undefined) {
      return null;
    }
    kind = "debugFragment";
  } else if (captureFormat !== undefined) {
    if (suffix !== undefined) {
      return null;
    }
    kind = "capture";
  } else if (suffix !== undefined) {
    kind = SUFFIX_KIND[suffix];
  } else if (blend === undefined) {
    kind = "wireframe";
  } else {
    kind = "color";
  }

  // The blend marker is mandatory for every kind except wireframe.
  if (kind !== "wireframe" && blend === undefined) {
    return null;
  }

  const defines = Number.parseInt(definesHex, 16);
  if (!Number.isFinite(defines)) {
    return null;
  }

  const fields: GlobePipelineKeyFields = {
    kind,
    isQuantized: quant === "Q",
    hasNormals: norm === "N",
    hasWebMercatorT: merc === "M",
    isBlend: blend === "B",
    strideBytes: Number.parseInt(stride, 10),
    useClipDistances: cd !== undefined,
    disableCulling: nc !== undefined,
    defines,
  };
  if (kind === "capture") {
    fields.captureFaceFormat = captureFormat;
  }
  if (kind === "debugFragment") {
    fields.debugFragmentMode = Number.parseInt(debugMode, 10);
  }
  return fields;
}

/**
 * Enumerate one renderer-local pipeline map truthfully.
 *
 * Every stored entry produces exactly one row, in the map's own iteration
 * order, including entries whose key does not parse (`fields: null`) and
 * entries whose pipeline has not materialized yet (`materialized: false`).
 * The row count always equals `cache.size`.
 *
 * @param cache the renderer-local map
 * @param cacheName which map it is
 * @returns one row per stored entry
 */
export function listGlobePipelineVariants(
  cache: ReadonlyMap<string, GlobePipelineEntryLike>,
  cacheName: GlobePipelineCacheName,
): GlobePipelineVariantInfo[] {
  const rows: GlobePipelineVariantInfo[] = [];
  for (const [key, entry] of cache) {
    rows.push({
      cache: cacheName,
      key,
      fields: parseGlobePipelineCacheKey(key),
      descriptorName: entry.descriptor?.name,
      pipeline: entry.pipeline ?? null,
      pending: entry.pending === true,
      materialized: entry.pipeline !== null && entry.pipeline !== undefined,
    });
  }
  return rows;
}

/**
 * Look up a single MATERIALIZED pipeline by semantic criteria instead of by a
 * hardcoded key string. This is what the four legacy getters now call.
 *
 * Only the fields named in `criteria` are compared, so a caller constrains the
 * axes it actually means and stays correct when a new marker is added — the
 * failure mode that broke the original getters, which pinned the stride and
 * (implicitly, by omission) the webMercatorT axis they never meant to pin.
 *
 * When several variants match (the same logical pipeline built for different
 * strides or for both webMercatorT states), the lexicographically-smallest key
 * wins so the result is deterministic across runs rather than dependent on
 * which tile happened to load first. Callers that need every match should use
 * {@link listGlobePipelineVariants}.
 *
 * @param cache the renderer-local map
 * @param criteria fields that must match
 * @returns the matching pipeline, or `null` when no materialized variant matches
 */
export function findGlobePipelineVariant(
  cache: ReadonlyMap<string, GlobePipelineEntryLike>,
  criteria: GlobePipelineVariantCriteria,
): GPURenderPipeline | null {
  const keys = Object.keys(criteria) as (keyof GlobePipelineKeyFields)[];
  let bestKey: string | null = null;
  let bestPipeline: GPURenderPipeline | null = null;

  for (const [key, entry] of cache) {
    if (!entry.pipeline) {
      continue;
    }
    const fields = parseGlobePipelineCacheKey(key);
    if (!fields) {
      continue;
    }
    let matches = true;
    for (const field of keys) {
      if (fields[field] !== criteria[field]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }
    if (bestKey === null || key < bestKey) {
      bestKey = key;
      bestPipeline = entry.pipeline;
    }
  }
  return bestPipeline;
}
