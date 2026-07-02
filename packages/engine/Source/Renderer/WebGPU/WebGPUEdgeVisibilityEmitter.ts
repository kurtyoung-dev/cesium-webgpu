/// <reference types="@webgpu/types" />
/**
 * WebGPU Edge Visibility Emitter
 *
 * C-R8-EDGE-EMITTER (Batch 45) — Initial cut: native `line-list` thin
 * lines, no silhouette discard, no wide lines, no line pattern.
 *
 * C-R8-EDGE-{SILHOUETTE,WIDE-LINES,LINE-PATTERN} (Batch 46) — Upgraded
 * to feature-parity with WebGL's `EdgeVisibilityPipelineStage` for
 * everything except per-feature ID gating (which requires the inline
 * per-fragment edge-detection stage tracked separately as
 * `C-R8-EDGE-INLINE`):
 *   - **Silhouette discard** — type=1 silhouette edges are now dropped
 *     when both endpoints are non-silhouette (front/back face products
 *     positive at both endpoints). Discards by emitting clip-rejected
 *     positions (`w = 0`).
 *   - **Wide-line quad expansion** — every edge becomes 4 vertices /
 *     2 triangles. The VS offsets vertices in NDC perpendicular to
 *     the edge by `lineWidth * a_edgeOffset`, producing pixel-accurate
 *     widths regardless of the platform's native line-thickness limit.
 *   - **Line pattern (dashes)** — 16-bit pattern uniform; FS bit-tests
 *     `lineCoord` against the pattern and discards gap fragments.
 *     `lineCoord` is computed in screen space matching
 *     `EdgeVisibilityStageVS.glsl:51-63`.
 *
 * C-R8-EDGE-LINESTRINGS (NEW-EDGE-DISPLAY-MODE-WEBGPU, edge-data slice)
 * — `extractEdgeGeometry` now also consumes the explicit
 * `edgeVisibility.lineStrings` array (BENTLEY / styled-gltf-lines
 * assets). Previously the extractor early-returned when
 * `edgeVisibility.visibility` was absent, so lineStrings-only primitives
 * emitted ZERO WebGPU edges. Each lineString's primitive-restart-
 * delimited index list now produces one HARD edge per consecutive index
 * pair, deduped against the same edge set the visibility path uses
 * (matches WebGL `EdgeVisibilityPipelineStage.extractVisibleEdges`).
 *
 * **Still deferred** (`C-R8-EDGE-FEATURE-ID`): per-feature edge gating
 * needs the model fragment's current featureId at composite time,
 * which a post-process consumer can't see. Requires `C-R8-EDGE-INLINE`
 * (in-shader per-fragment edge detection in every Model FS) before
 * feature-ID gating becomes implementable.
 *
 * **Edge-data parity** (both gaps now closed):
 *   - per-edge / per-lineString `materialColor` overrides ride the
 *     `a_edgeColor`-equivalent location(7) vertex attribute
 *     (NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU, Batch 330);
 *   - authored `edgeVisibility.silhouetteNormals` signed-byte accessor
 *     (EDGE-AUTHORED-SILHOUETTE-NORMALS) — silhouette-edge face normals
 *     are now sourced from the accessor when the mesh authors it,
 *     matching WebGL `EdgeVisibilityPipelineStage.generateEdgeFaceNormals`
 *     exactly (sequential silhouette-edge pair indexing, signed-byte →
 *     unit-float decode, zero normals for out-of-range pairs). The
 *     adjacency-derived face normals remain the fallback when the
 *     accessor is absent.
 *
 * @module WebGPUEdgeVisibilityEmitter
 * @private
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

const EDGE_EMITTER_WGSL = /* wgsl */ `
struct CameraUniforms {
  modelViewProjection: mat4x4<f32>,
  modelView: mat4x4<f32>,
};

struct EdgeUniforms {
  // .rgb = fallback edge color (the surface / model base color), .a = 1.
  // Per-edge color comes from the location(7) vertex attribute; this
  // uniform is the surface-color fallback used when an edge writes the
  // a<0 "no override" sentinel (matches WebGL: the FS keeps the surface
  // color when a_edgeColor.a < 0 -- EdgeVisibilityStageFS.glsl:32-36).
  color: vec4<f32>,
  // .xy = viewport (px), .z = line width (px), .w = u32 pattern bits
  // packed as f32 (emitter writes Math.fround-safe int when pattern
  // == 0xffff i.e., solid; pattern values up to 16 bits round-trip
  // through f32 exactly).
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> edge: EdgeUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) edgeType: f32,
  @location(2) normalA: vec3<f32>,
  @location(3) normalB: vec3<f32>,
  @location(4) otherPos: vec3<f32>,
  @location(5) edgeOffset: f32,
  // C-R8-EDGE-FEATURE-ID — per-edge feature ID populated by
  // extractEdgeGeometry from glTF FEATURE_ID_0 (or 0.0 when the
  // primitive has no feature IDs). Both endpoints of an edge share
  // the same feature ID; the CPU-side code samples vertex 0 of each
  // edge so the value is consistent across the quad's four vertices.
  // Stored as a raw integer-valued float (clamped to 0..255 at FS
  // emit time so it fits in rgba8unorm's id.g channel — saturation
  // beyond 255 is the documented C-R8-EDGE-ID-FORMAT limit.
  @location(6) featureId: f32,
  // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU (Batch 330) -- per-edge color,
  // the WebGPU equivalent of WebGL's a_edgeColor vertex attribute.
  // .a >= 0 -> use this RGBA as the edge color (per-lineString /
  // per-feature materialColor override, or a per-vertex COLOR_0 value).
  // .a < 0 (the -1 sentinel) -> no override, fall back to edge.color
  // (the surface / model base color). Replicated across the quad's 4
  // vertices and interpolated flat.
  @location(7) edgeColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) edgeType: f32,
  @location(1) lineCoord: f32,
  @location(2) @interpolate(flat) featureId: f32,
  @location(3) @interpolate(flat) edgeColor: vec4<f32>,
};

const PERP_TOL: f32 = 2.5e-4;
const LINE_PATTERN_BASE: f32 = 8192.0;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  // C-R8-EDGE-SILHOUETTE — silhouette type=1 discard. Uses model-space
  // face normals transformed to eye space via the model-view matrix.
  // NB: this is direction-only; for non-uniformly-scaled meshes the
  // normalize() call after the transform compensates for the scale,
  // and the dot-product sign is what matters (not magnitude).
  let edgeTypeInt = input.edgeType * 255.0;
  var shouldDiscard = false;
  if (edgeTypeInt > 0.5 && edgeTypeInt < 1.5) {
    let normalAEye = normalize((camera.modelView * vec4<f32>(input.normalA, 0.0)).xyz);
    let normalBEye = normalize((camera.modelView * vec4<f32>(input.normalB, 0.0)).xyz);

    let curEye = (camera.modelView * vec4<f32>(input.position, 1.0)).xyz;
    let toEye1 = normalize(-curEye);
    let dotA1 = dot(normalAEye, toEye1);
    let dotB1 = dot(normalBEye, toEye1);

    let otherEye = (camera.modelView * vec4<f32>(input.otherPos, 1.0)).xyz;
    let toEye2 = normalize(-otherEye);
    let dotA2 = dot(normalAEye, toEye2);
    let dotB2 = dot(normalBEye, toEye2);

    if (dotA1 * dotB1 > PERP_TOL || dotA2 * dotB2 > PERP_TOL) {
      shouldDiscard = true;
    }
  }

  out.edgeType = input.edgeType;
  out.featureId = input.featureId;
  out.edgeColor = input.edgeColor;

  // Base clip-space position.
  let posClip = camera.modelViewProjection * vec4<f32>(input.position, 1.0);

  // C-R8-EDGE-WIDE-LINES — quad expansion. Each edge has 4 vertices;
  // edgeOffset is -1.0 / +1.0 (and zero for the central VS path).
  // Project the OTHER endpoint to clip space, derive perpendicular
  // direction in NDC, then convert to clip-space pixel offset.
  let otherClip = camera.modelViewProjection * vec4<f32>(input.otherPos, 1.0);
  let viewport = edge.params.xy;
  let lineWidth = edge.params.z;
  var posOut = posClip;
  if (abs(input.edgeOffset) > 0.0) {
    let curNDC = posClip.xy / posClip.w;
    let otherNDC = otherClip.xy / otherClip.w;
    var dirNDC = otherNDC - curNDC;
    // Stable orientation (matches WebGL VS:80-82) so opposite vertices
    // of the quad pick the same perpendicular sign.
    if (dirNDC.x < 0.0 || (abs(dirNDC.x) < 0.001 && dirNDC.y < 0.0)) {
      dirNDC = -dirNDC;
    }
    dirNDC = normalize(dirNDC);
    let perpNDC = vec2<f32>(-dirNDC.y, dirNDC.x);
    let clipPerPixel = (vec2<f32>(2.0, 2.0) / viewport) * posClip.w;
    let offsetClip = perpNDC * lineWidth * clipPerPixel * 0.5 * input.edgeOffset;
    posOut = vec4<f32>(posClip.x + offsetClip.x, posClip.y + offsetClip.y, posClip.z, posClip.w);
  }

  if (shouldDiscard) {
    // Clip-reject by collapsing to (0, 0, 0, 0) so the rasterizer
    // discards the entire degenerate triangle. Cheaper than a
    // fragment-side discard and folds across all 4 quad vertices when
    // any one signals discard (the vertex's own w being zero gives a
    // degenerate triangle regardless of the other 3).
    out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  } else {
    out.position = posOut;
  }

  // C-R8-EDGE-LINE-PATTERN — screen-space lineCoord (matches WebGL
  // VS:51-63). Pixels along the major-axis projection of the edge
  // get a monotonically-increasing coord; FS bit-tests this against
  // the pattern.
  let curScreen = (posClip.xy / posClip.w * 0.5 + vec2<f32>(0.5)) * viewport;
  let otherScreen = (otherClip.xy / otherClip.w * 0.5 + vec2<f32>(0.5)) * viewport;
  let windowDir = otherScreen - curScreen;
  if (abs(windowDir.x) > abs(windowDir.y)) {
    out.lineCoord = LINE_PATTERN_BASE + curScreen.x;
  } else {
    out.lineCoord = LINE_PATTERN_BASE + curScreen.y;
  }

  return out;
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @location(1) id: vec4<f32>,
  @location(2) depth: vec4<f32>,
};

fn packDepth(d: f32) -> vec4<f32> {
  let bits = vec4<f32>(1.0, 255.0, 65025.0, 16581375.0) * d;
  let floored = floor(bits);
  let shifted = vec4<f32>(
    floored.x,
    floored.y - floored.x * 255.0,
    floored.z - floored.y * 255.0,
    floored.w - floored.z * 255.0,
  );
  return shifted / 255.0;
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  // C-R8-EDGE-LINE-PATTERN — 16-bit dash mask. Pattern is stored as
  // a non-negative integer (0..65535) packed into a float. A pattern
  // of 0xffff means "all bits set" → solid line (no discards). 0x0000
  // means "all gaps" → entire edge invisible. Mid-range values
  // produce dashes.
  let pattern = u32(edge.params.w);
  if (pattern != 0xffffu) {
    let maskLength = 16.0;
    let dashPosition = fract(input.lineCoord / maskLength);
    let maskIndex = u32(floor(dashPosition * maskLength));
    if ((pattern & (1u << maskIndex)) == 0u) {
      discard;
    }
  }

  var out: FragmentOutput;
  // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — per-edge color override.
  // Matches WebGL EdgeVisibilityStageFS.glsl:32-36: use the per-edge
  // color when its alpha is non-negative, else keep the surface/model
  // base color carried in edge.color.
  var finalColor = edge.color;
  if (input.edgeColor.a >= 0.0) {
    finalColor = input.edgeColor;
  }
  out.color = finalColor;
  let edgeTypeInt = input.edgeType * 255.0;
  // C-R8-EDGE-ID-FORMAT (Batch 49) — 16-bit feature ID split across
  // id.g (low byte) + id.b (high byte) so tilesets with > 255
  // features per primitive round-trip exactly. Each channel stores
  // as 0..1 normalised; consumer recomposes via
  // low + high * 256.0 after denormalising both. Saturates at
  // 65535 (two-channel rgba8 ceiling) — practical only for
  // tilesets exceeding that count, where the GPU batch-table side
  // would also strain. Format kept as rgba8unorm so the existing
  // sampling path is untouched.
  let fidClamped = clamp(input.featureId, 0.0, 65535.0);
  let fidLowByte = floor(fidClamped) % 256.0;
  let fidHighByte = floor(fidClamped / 256.0);
  out.id = vec4<f32>(
    edgeTypeInt / 255.0,
    fidLowByte / 255.0,
    fidHighByte / 255.0,
    1.0,
  );
  out.depth = packDepth(input.position.z);
  return out;
}

// Scene-FB fragment entry — used when edges render directly into the SCENE
// framebuffer pass (the EDGES_ONLY CESIUM_3D_TILE_EDGES_DIRECT slot-12 pass,
// and the SURFACES_AND_EDGES fallback when the edge MRT FBO isn't allocated).
// That pass has 2 color attachments under MRT (slot 0 color + the rgba16float
// G-buffer at slot 1), NOT the 3 the dedicated edge FBO has. Running
// fragmentMain's 3-output FragmentOutput against the scene-FB pipeline leaves
// @location(2) (packed depth) with no color target → an INVALID pipeline →
// the draw silently renders nothing. That was the EDGES_ONLY non-render the
// 14-batch review surfaced (every other layer — VS, frustum binning, depth,
// discard, color — checked out; the pipeline itself was the problem). This
// variant emits only color (slot 0) + a slot-1 placeholder (writeMask 0 in
// makeSceneFBTargets) so the output count matches the scene-FB pipeline.
struct FragmentSceneFBOutput {
  @location(0) color: vec4<f32>,
  @location(1) gbuffer: vec4<f32>,
};

@fragment
fn fragmentSceneFB(input: VertexOutput) -> FragmentSceneFBOutput {
  let pattern = u32(edge.params.w);
  if (pattern != 0xffffu) {
    let maskLength = 16.0;
    let dashPosition = fract(input.lineCoord / maskLength);
    let maskIndex = u32(floor(dashPosition * maskLength));
    if ((pattern & (1u << maskIndex)) == 0u) {
      discard;
    }
  }
  var out: FragmentSceneFBOutput;
  // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — per-edge color override
  // (same semantics as fragmentMain).
  var finalColor = edge.color;
  if (input.edgeColor.a >= 0.0) {
    finalColor = input.edgeColor;
  }
  out.color = finalColor;
  out.gbuffer = vec4<f32>(0.0);
  return out;
}
`;

interface EdgeGeometry {
  /** Interleaved Float32Array per vertex: [pos.xyz, edgeType, normalA.xyz, normalB.xyz, otherPos.xyz, edgeOffset, featureId, edgeColor.rgba] (19 floats / 76 bytes). */
  vertices: Float32Array;
  /** Uint32Array of indices: 6 per edge (2 triangles). */
  indices: Uint32Array;
  /** Edge count for diagnostics; vertex count is `edgeCount * 4`. */
  edgeCount: number;
  /** Total index count (6 * edgeCount). Used as draw indexCount. */
  indexCount: number;
  /** True when at least one edge had a non-zero feature ID extracted —
   * lets the model renderer flip the consumer-side `hasFeatureId` flag
   * so the inline edge-detection stage actually gates on feature ID
   * instead of falling through to fail-open. False when no FEATURE_ID_0
   * attribute was present on the primitive. */
  hasFeatureIds: boolean;
}

// 19 floats per vertex. `featureId` (slot 14) was added after `edgeOffset`
// for the C-R8-EDGE-FEATURE-ID branch (stride 56 → 60). Then the per-edge
// `edgeColor` vec4 (slots 15..18) was added for
// NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU (Batch 330), bumping the stride
// 60 → 76 bytes; the pipeline's vertex buffer layout below picks up the
// new attribute at shaderLocation 7, offset 60.
const FLOATS_PER_VERTEX = 19;
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * 4;
const VERTICES_PER_EDGE = 4;
const INDICES_PER_EDGE = 6;

const _scratchA = new Cartesian3();
const _scratchB = new Cartesian3();
const _scratchC = new Cartesian3();
const _scratchE1 = new Cartesian3();
const _scratchE2 = new Cartesian3();
const _scratchN = new Cartesian3();

// NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — an edge `materialColor` override
// arrives either as a Cartesian4-like object (.x/.y/.z/.w) or a numeric
// array ([r,g,b,a]), matching WebGL `createQuadEdgeGeometry`'s
// `setColorFromOverride`, which reads both shapes.
type EdgeColorLike =
  | { x: number; y: number; z: number; w?: number }
  | ArrayLike<number>;

// Resolved per-edge color: [r, g, b, a] in 0..1, or null = no override.
type EdgeColorRGBA = [number, number, number, number];

// EDGE-AUTHORED-SILHOUETTE-NORMALS — the `silhouetteNormals` accessor is
// unpacked by `GltfLoader.loadAccessor` into an array of Cartesian3-like
// objects whose components are RAW signed bytes (-128..127), not
// pre-normalized floats. Entries may be undefined for malformed/sparse
// accessors.
type SilhouetteNormalLike = { x: number; y: number; z: number };

/**
 * EDGE-AUTHORED-SILHOUETTE-NORMALS — decode the authored signed-byte
 * `edgeVisibility.silhouetteNormals` accessor into packed unit-float
 * normals (3 floats per entry). Mirrors WebGL
 * `EdgeVisibilityPipelineStage.generateEdgeFaceNormals` exactly:
 * component map [-128, 127] → [-1, 1] via `2 * ((v + 128) / 255) - 1`,
 * normalize, and (0, 0, 1) for zero-length (or NaN/malformed) entries.
 * Returns null when the accessor is absent or empty so callers keep the
 * adjacency-derived fallback path byte-identical.
 */
function decodeAuthoredSilhouetteNormals(
  raw: ArrayLike<SilhouetteNormalLike | undefined> | undefined | null,
): Float32Array | null {
  if (raw === undefined || raw === null || raw.length === 0) {
    return null;
  }
  const out = new Float32Array(raw.length * 3);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    let x = 0;
    let y = 0;
    let z = 1;
    if (v !== undefined && v !== null) {
      x = 2 * ((v.x + 128) / 255) - 1;
      y = 2 * ((v.y + 128) / 255) - 1;
      z = 2 * ((v.z + 128) / 255) - 1;
      const magSq = x * x + y * y + z * z;
      // NaN components fail the > 0 test and fall to the (0,0,1)
      // default — same net result as WebGL's magnitudeSquared branch.
      if (magSq > 0) {
        const inv = 1 / Math.sqrt(magSq);
        x *= inv;
        y *= inv;
        z *= inv;
      } else {
        x = 0;
        y = 0;
        z = 1;
      }
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/**
 * Normalize an edge `materialColor` override (Cartesian4-like or numeric
 * array) to an `[r, g, b, a]` tuple. Returns null when undefined. Alpha
 * defaults to 1 when the source omits it (matching WebGL
 * `setColorFromOverride`).
 */
function normalizeEdgeColor(
  color: EdgeColorLike | undefined | null,
): EdgeColorRGBA | null {
  if (color === undefined || color === null) {
    return null;
  }
  const c = color as { x?: number; y?: number; z?: number; w?: number };
  const arr = color as ArrayLike<number>;
  const r = c.x !== undefined ? c.x : arr[0];
  const g = c.y !== undefined ? c.y : arr[1];
  const b = c.z !== undefined ? c.z : arr[2];
  const a = c.w !== undefined ? c.w : arr[3] !== undefined ? arr[3] : 1.0;
  if (r === undefined || g === undefined || b === undefined) {
    return null;
  }
  return [r, g, b, a];
}

/**
 * CPU-side build: face normals + edge adjacency + 4-vertex / 6-index
 * edge geometry. Returns null when the primitive has no edge data or
 * no usable position attribute.
 *
 * Two edge encodings are consumed, deduped against a single shared edge
 * set so an edge present in both is emitted once (matches WebGL
 * `EdgeVisibilityPipelineStage.extractVisibleEdges`):
 *   1. the per-triangle 2-bit `edgeVisibility.visibility` encoding
 *      (silhouette / hard / repeated-hard), which carries derived face
 *      normals for the silhouette test; and
 *   2. explicit `edgeVisibility.lineStrings` (C-R8-EDGE-LINESTRINGS) —
 *      primitive-restart-delimited polyline index lists. Every
 *      lineString edge is EdgeVisibilityType.HARD, so it carries no
 *      face normals (the silhouette branch in the VS skips type != 1).
 *
 * Layout per vertex (19 floats, 76 bytes):
 *   [0..2]  position.xyz       — endpoint position (model space)
 *   [3]     edgeType           — 1/2/3 normalized to /255
 *   [4..6]  normalA.xyz        — first triangle's face normal (0 for lineStrings)
 *   [7..9]  normalB.xyz        — second triangle's face normal (or -A for boundary; 0 for lineStrings)
 *   [10..12] otherPos.xyz       — the OTHER endpoint's position
 *   [13]    edgeOffset         — -1 (left) or +1 (right) for quad expansion
 *   [14]    featureId          — per-edge FEATURE_ID_0 (0 when absent)
 *   [15..18] edgeColor.rgba     — per-edge color override (a<0 = no override,
 *                                fall back to the uniform surface color)
 *
 * Quad layout per edge (4 vertices indexed 0..3 within the edge,
 * absolute index = edgeIdx*4 + local):
 *   v0: pos=A, otherPos=B, edgeOffset=-1
 *   v1: pos=A, otherPos=B, edgeOffset=+1
 *   v2: pos=B, otherPos=A, edgeOffset=-1
 *   v3: pos=B, otherPos=A, edgeOffset=+1
 *   indices: [v0,v1,v2,  v1,v3,v2]
 *
 * normalA / normalB / edgeType are the same across all 4 vertices of
 * the edge — they're per-edge attributes replicated per-vertex so the
 * shader doesn't need a separate per-edge lookup.
 *
 * NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU (Batch 330) — per-edge /
 * per-lineString `materialColor` overrides and per-vertex COLOR_0 are now
 * carried in slots [15..18] (the WebGPU equivalent of WebGL's
 * `a_edgeColor`). Color source priority per edge mirrors
 * `EdgeVisibilityPipelineStage.createQuadEdgeGeometry`:
 *   1. the edge's explicit override color (per-lineString `materialColor`,
 *      else the primitive-level `edgeVisibility.materialColor`), else
 *   2. the lower-index endpoint's per-vertex COLOR_0 (`vertexColors`), else
 *   3. the `-1` alpha sentinel → no override → the WGSL FS falls back to
 *      the uniform surface/model color.
 *
 * EDGE-AUTHORED-SILHOUETTE-NORMALS — when the primitive authors the
 * `edgeVisibility.silhouetteNormals` signed-byte accessor (per the
 * EXT_mesh_primitive_edge_visibility spec it MUST be present when the
 * primitive encodes at least one silhouette edge), silhouette-edge face
 * normals come from that accessor: silhouette edges are numbered
 * sequentially in dedupe order (matching WebGL
 * `EdgeVisibilityPipelineStage.extractVisibleEdges`), and edge N reads
 * decoded pair [N*2, N*2+1]. Out-of-range pairs leave zero normals (the
 * edge is then always drawn), matching WebGL
 * `generateEdgeFaceNormals`'s bounds skip. Only when the accessor is
 * ABSENT does the extractor fall back to re-deriving face normals from
 * triangle adjacency (WebGL uses zero normals in that out-of-spec case;
 * the derived fallback classifies real silhouettes instead of drawing
 * every silhouette edge unconditionally).
 */
export function extractEdgeGeometry(
  primitive: unknown,
  positionData: Float32Array | null,
  /**
   * Optional per-vertex feature IDs (typically from a glTF FEATURE_ID_0
   * attribute). Length is the vertex count. When supplied, each edge's
   * feature ID is sampled from the lower-index endpoint and replicated
   * across the quad's four vertices — both endpoints of an edge are
   * required to share a feature in glTF EXT_mesh_features semantics
   * for the edge to be valid for per-feature gating.
   * Pass `null` (or omit) when the primitive has no feature IDs; the
   * geometry falls back to writing 0 in the slot and `hasFeatureIds`
   * comes back false so callers know not to enable per-feature gating.
   */
  featureIds?: Float32Array | Uint8Array | Uint16Array | Uint32Array | null,
  /**
   * NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — optional per-vertex RGBA
   * colors (from a glTF COLOR_0 attribute), packed as 4 floats per vertex
   * in 0..1. Length is `vertexCount * 4`. Used as the per-edge color
   * source ONLY when the edge has no explicit `materialColor` override —
   * mirrors WebGL `createQuadEdgeGeometry`'s
   * override → vertexColor → no-color priority. Pass `null`/omit when the
   * primitive has no COLOR_0; edges without an override then write the
   * `-1` alpha "no override" sentinel and the FS falls back to the
   * surface color.
   */
  vertexColors?: Float32Array | null,
): EdgeGeometry | null {
  const p = primitive as {
    edgeVisibility?: {
      visibility?: Uint8Array;
      // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — primitive-level edge
      // color override (the `materialColor` global applied to every
      // visibility-path edge; matches WebGL `edgeVisibility.materialColor`
      // / `EdgeVisibilityPipelineStage.js:404`). Either a Cartesian4
      // (.x/.y/.z/.w) or a numeric array ([r,g,b,a]).
      materialColor?: EdgeColorLike;
      // EDGE-AUTHORED-SILHOUETTE-NORMALS — authored signed-byte face-
      // normal pairs for silhouette edges (2 entries per silhouette
      // edge, sequential in edge-extraction dedupe order). Loaded by
      // `GltfLoader.loadAccessor` as Cartesian3-like objects carrying
      // raw signed-byte components.
      silhouetteNormals?: ArrayLike<SilhouetteNormalLike | undefined>;
      // C-R8-EDGE-LINESTRINGS — explicit polyline edges from the
      // EXT_mesh_primitive_edge_visibility `lineStrings` array. Each
      // entry carries a primitive-restart-delimited index list into the
      // same vertex positions the triangle indices reference. Mirrors
      // the shape `GltfLoader.loadEdgeVisibilityLineStrings` produces.
      lineStrings?: Array<{
        indices?: Uint8Array | Uint16Array | Uint32Array;
        restartIndex?: number;
        // Per-lineString color override (BENTLEY styled-gltf-lines).
        // Takes precedence over the primitive-level `materialColor`.
        materialColor?: EdgeColorLike;
      }>;
    };
    indices?: { typedArray?: Uint8Array | Uint16Array | Uint32Array };
    attributes?: Array<{ count?: number }>;
  };
  const edgeVis = p?.edgeVisibility;
  if (!edgeVis) return null;
  const visibility = edgeVis.visibility;
  const lineStrings = edgeVis.lineStrings;
  // Primitive-level edge color override (visibility-path edges). When
  // present it wins over per-vertex COLOR_0; when absent those edges fall
  // back to vertex color, then to the -1 "no override" sentinel.
  const globalColor = normalizeEdgeColor(edgeVis.materialColor);
  const vertColors = vertexColors ?? null;
  const indices = p?.indices?.typedArray;
  const hasVisibilityData = !!visibility && !!indices && indices.length > 0;
  const hasLineStrings = !!lineStrings && lineStrings.length > 0;
  // Neither encoding present → nothing to emit.
  if (!hasVisibilityData && !hasLineStrings) return null;
  if (!positionData || positionData.length === 0) return null;
  const fidSource = featureIds ?? null;
  let sawNonZeroFeature = false;

  // Vertex count guard for the lineStrings path (mirrors WebGL
  // `extractVisibleEdges`: attributes[0].count). Used to reject
  // out-of-range lineString indices; 0 disables the range check.
  const attributes = p?.attributes;
  const vertexCount =
    attributes && attributes.length > 0 ? (attributes[0]?.count ?? 0) : 0;

  // Shared output buffers — both the per-triangle 2-bit `visibility`
  // path and the explicit `lineStrings` path append into these, and a
  // single `seen` set dedups across BOTH so an edge present in both
  // encodings is emitted once (matching WebGL `extractVisibleEdges`).
  const verts: number[] = [];
  const idx: number[] = [];
  const seen = new Set<string>();
  let outEdge = 0;

  // EDGE-AUTHORED-SILHOUETTE-NORMALS — authored signed-byte silhouette
  // normal pairs. When present, silhouette edges read the accessor and
  // the adjacency derivation below is skipped entirely (matching WebGL,
  // which NEVER derives — `generateEdgeFaceNormals` reads the accessor
  // or leaves zeros). When absent, the derived fallback is unchanged.
  const authoredNormals = decodeAuthoredSilhouetteNormals(
    edgeVis.silhouetteNormals,
  );

  // Build per-triangle face normals + edge adjacency. `edgeMap` maps
  // an edge key ("min,max") to a small array of triangle indices that
  // contain that edge. Boundary edges have one entry; interior edges
  // have two. Only meaningful for the silhouette/HARD `visibility`
  // path — `lineStrings` edges are always HARD and carry no face
  // normals, so this is skipped for lineStrings-only primitives (and
  // for primitives that author `silhouetteNormals`).
  const deriveFaceNormals = hasVisibilityData && authoredNormals === null;
  const triangleCount = deriveFaceNormals
    ? Math.floor((indices as Uint8Array | Uint16Array | Uint32Array).length / 3)
    : 0;
  const faceNormals = new Float32Array(triangleCount * 3);
  const edgeMap = new Map<string, number[]>();

  if (deriveFaceNormals) {
    const triIndices = indices as Uint8Array | Uint16Array | Uint32Array;
    for (let t = 0; t < triangleCount; t++) {
      const base = t * 3;
      const i0 = triIndices[base];
      const i1 = triIndices[base + 1];
      const i2 = triIndices[base + 2];

      const i0o = i0 * 3;
      const i1o = i1 * 3;
      const i2o = i2 * 3;
      if (
        i0o + 2 >= positionData.length ||
        i1o + 2 >= positionData.length ||
        i2o + 2 >= positionData.length
      ) {
        // Out-of-bounds index — skip this triangle but keep going.
        continue;
      }

      _scratchA.x = positionData[i0o];
      _scratchA.y = positionData[i0o + 1];
      _scratchA.z = positionData[i0o + 2];
      _scratchB.x = positionData[i1o];
      _scratchB.y = positionData[i1o + 1];
      _scratchB.z = positionData[i1o + 2];
      _scratchC.x = positionData[i2o];
      _scratchC.y = positionData[i2o + 1];
      _scratchC.z = positionData[i2o + 2];

      Cartesian3.subtract(_scratchB, _scratchA, _scratchE1);
      Cartesian3.subtract(_scratchC, _scratchA, _scratchE2);
      Cartesian3.cross(_scratchE1, _scratchE2, _scratchN);
      if (Cartesian3.magnitudeSquared(_scratchN) > 0) {
        Cartesian3.normalize(_scratchN, _scratchN);
      }
      faceNormals[base] = _scratchN.x;
      faceNormals[base + 1] = _scratchN.y;
      faceNormals[base + 2] = _scratchN.z;

      const registerEdge = (a: number, b: number) => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        let list = edgeMap.get(key);
        if (!list) {
          list = [];
          edgeMap.set(key, list);
        }
        if (list.length < 2) list.push(t);
      };
      registerEdge(i0, i1);
      registerEdge(i1, i2);
      registerEdge(i2, i0);
    }
  }

  // Helper used by both paths to push a single edge's 4-vertex quad +
  // 6 indices. `nA*/nB*` are the per-edge face normals (zeroed for the
  // lineStrings path, which is always HARD and skips the silhouette
  // branch). `typeNorm` is the edge type / 255.
  const emitEdgeQuad = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    nAx: number,
    nAy: number,
    nAz: number,
    nBx: number,
    nBy: number,
    nBz: number,
    typeNorm: number,
    edgeFeatureId: number,
    // Per-edge color [r,g,b,a]. a<0 = no override (FS falls back to the
    // uniform surface color). Replicated across the quad's 4 vertices.
    edgeColor: EdgeColorRGBA,
  ): void => {
    const cr = edgeColor[0];
    const cg = edgeColor[1];
    const cb = edgeColor[2];
    const ca = edgeColor[3];
    const pushVertex = (
      px: number,
      py: number,
      pz: number,
      ox: number,
      oy: number,
      oz: number,
      offset: number,
    ): void => {
      verts.push(
        px,
        py,
        pz,
        typeNorm,
        nAx,
        nAy,
        nAz,
        nBx,
        nBy,
        nBz,
        ox,
        oy,
        oz,
        offset,
        edgeFeatureId,
        cr,
        cg,
        cb,
        ca,
      );
    };
    pushVertex(ax, ay, az, bx, by, bz, -1.0); // v0 — endpoint A, left
    pushVertex(ax, ay, az, bx, by, bz, +1.0); // v1 — endpoint A, right
    pushVertex(bx, by, bz, ax, ay, az, -1.0); // v2 — endpoint B, left
    pushVertex(bx, by, bz, ax, ay, az, +1.0); // v3 — endpoint B, right

    const baseV = outEdge * VERTICES_PER_EDGE;
    idx.push(baseV + 0, baseV + 1, baseV + 2, baseV + 1, baseV + 3, baseV + 2);
    outEdge++;
  };

  // NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU — resolve a single edge's color
  // following WebGL `createQuadEdgeGeometry`'s priority: explicit override
  // (per-lineString / primitive `materialColor`) → lower-index endpoint's
  // per-vertex COLOR_0 → the -1 alpha "no override" sentinel. `lowIndex`
  // is the lower of the edge's two endpoint indices (the vertex WebGL
  // samples; both endpoints share a color for a single-feature edge).
  const _noColor: EdgeColorRGBA = [0.0, 0.0, 0.0, -1.0];
  const resolveEdgeColor = (
    override: EdgeColorRGBA | null,
    lowIndex: number,
  ): EdgeColorRGBA => {
    if (override !== null) {
      return override;
    }
    if (vertColors !== null) {
      const o = lowIndex * 4;
      if (o + 3 < vertColors.length) {
        return [
          vertColors[o],
          vertColors[o + 1],
          vertColors[o + 2],
          vertColors[o + 3],
        ];
      }
    }
    return _noColor;
  };

  // Decode visibility, dedupe, and emit 4 vertices + 6 indices per
  // visible edge. Mirrors WebGL's `extractVisibleEdges` ordering so
  // edge dedup is consistent across renderers.
  const triIndicesForEdges = hasVisibilityData
    ? (indices as Uint8Array | Uint16Array | Uint32Array)
    : undefined;
  const visibilityArr = hasVisibilityData
    ? (visibility as Uint8Array)
    : undefined;
  let edgeIndex = 0;
  // EDGE-AUTHORED-SILHOUETTE-NORMALS — sequential silhouette-edge counter.
  // Every newly-seen (post-dedupe) SILHOUETTE edge gets the next index
  // into the authored `silhouetteNormals` pair list, matching WebGL
  // `extractVisibleEdges`'s `silhouetteEdgeCount` numbering exactly.
  let silhouetteEdgeCount = 0;
  for (
    let i = 0;
    triIndicesForEdges !== undefined &&
    visibilityArr !== undefined &&
    i + 2 < triIndicesForEdges.length;
    i += 3
  ) {
    const v0 = triIndicesForEdges[i];
    const v1 = triIndicesForEdges[i + 1];
    const v2 = triIndicesForEdges[i + 2];
    for (let e = 0; e < 3; e++) {
      let a: number;
      let b: number;
      if (e === 0) {
        a = v0;
        b = v1;
      } else if (e === 1) {
        a = v1;
        b = v2;
      } else {
        a = v2;
        b = v0;
      }
      const byteIdx = Math.floor(edgeIndex / 4);
      const bitOff = (edgeIndex % 4) * 2;
      edgeIndex++;
      if (byteIdx >= visibilityArr.length) break;
      const v2bit = (visibilityArr[byteIdx] >> bitOff) & 0x3;
      if (v2bit === 0) continue;
      const small = Math.min(a, b);
      const big = Math.max(a, b);
      const key = `${small},${big}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Assign the sequential index into the authored silhouetteNormals
      // pair list for SILHOUETTE (type 1) edges. Counted for every
      // newly-seen silhouette edge — even ones later skipped by the
      // position-bounds guard — so the numbering stays aligned with
      // WebGL's `extractVisibleEdges` (which has no such guard).
      let silhouetteEdgeIndex = -1;
      if (v2bit === 1) {
        silhouetteEdgeIndex = silhouetteEdgeCount;
        silhouetteEdgeCount++;
      }

      let nAx = 0,
        nAy = 0,
        nAz = 0;
      let nBx = 0,
        nBy = 0,
        nBz = 0;
      if (authoredNormals !== null) {
        // EDGE-AUTHORED-SILHOUETTE-NORMALS — authored path. Silhouette
        // edge N reads decoded pair [N*2, N*2+1]; non-silhouette edges
        // and out-of-range pairs keep zero normals (inert for HARD
        // edges; a zero normal makes the silhouette dot products 0 →
        // the edge is always drawn — both match WebGL
        // `generateEdgeFaceNormals`, incl. its bounds skip).
        if (silhouetteEdgeIndex >= 0) {
          const pairBase = silhouetteEdgeIndex * 2;
          if ((pairBase + 1) * 3 + 2 < authoredNormals.length) {
            const baseA = pairBase * 3;
            const baseB = baseA + 3;
            nAx = authoredNormals[baseA];
            nAy = authoredNormals[baseA + 1];
            nAz = authoredNormals[baseA + 2];
            nBx = authoredNormals[baseB];
            nBy = authoredNormals[baseB + 1];
            nBz = authoredNormals[baseB + 2];
          }
        }
      } else {
        // Derived fallback — look up adjacent triangles for this edge
        // to recover faceA/B.
        const tris = edgeMap.get(key);
        if (tris && tris.length >= 1) {
          const tA = tris[0] * 3;
          nAx = faceNormals[tA];
          nAy = faceNormals[tA + 1];
          nAz = faceNormals[tA + 2];
          if (tris.length >= 2) {
            const tB = tris[1] * 3;
            nBx = faceNormals[tB];
            nBy = faceNormals[tB + 1];
            nBz = faceNormals[tB + 2];
          } else {
            // Boundary edge — synthesize -A so the dot products always
            // disagree (silhouette test treats this as "always visible").
            nBx = -nAx;
            nBy = -nAy;
            nBz = -nAz;
          }
        }
      }

      const ai = a * 3;
      const bi = b * 3;
      if (ai + 2 >= positionData.length || bi + 2 >= positionData.length) {
        continue;
      }
      const ax = positionData[ai];
      const ay = positionData[ai + 1];
      const az = positionData[ai + 2];
      const bx = positionData[bi];
      const by = positionData[bi + 1];
      const bz = positionData[bi + 2];
      const typeNorm = v2bit / 255.0;

      // Sample the edge's feature ID from the lower-index endpoint
      // (mirrors WebGL `EdgeVisibilityPipelineStage.js:1259-1264` which
      // also uses `edgeIndices[i*2]`). Both endpoints share the same
      // ID when the edge belongs to a single feature; when they differ
      // the edge straddles a feature boundary and per-feature gating
      // would be ambiguous anyway.
      let edgeFeatureId = 0;
      if (fidSource !== null) {
        const idxForFeature = a < b ? a : b;
        if (idxForFeature < fidSource.length) {
          edgeFeatureId = fidSource[idxForFeature];
          if (edgeFeatureId > 0) sawNonZeroFeature = true;
        }
      }

      // Per-edge color: visibility-path edges use the primitive-level
      // `materialColor` override when present, else per-vertex COLOR_0.
      const edgeColor = resolveEdgeColor(globalColor, Math.min(a, b));

      // Push 4 vertices + 6 indices for the quad.
      emitEdgeQuad(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        nAx,
        nAy,
        nAz,
        nBx,
        nBy,
        nBz,
        typeNorm,
        edgeFeatureId,
        edgeColor,
      );
    }
  }

  // C-R8-EDGE-LINESTRINGS — explicit polyline edges. The WebGL extractor
  // (`EdgeVisibilityPipelineStage.extractVisibleEdges`) walks each
  // lineString's primitive-restart-delimited index list and emits one
  // HARD edge per consecutive index pair, deduped against the same
  // `seen` set the visibility path uses. We mirror that here. These
  // edges are always EdgeVisibilityType.HARD (=2) — the silhouette
  // branch in the VS never runs for them, so the zeroed face normals
  // are inert (HARD edges are unconditionally drawn).
  const HARD_TYPE_NORM = 2 / 255.0;
  if (hasLineStrings && lineStrings) {
    for (let s = 0; s < lineStrings.length; s++) {
      const lineString = lineStrings[s];
      const lineIndices = lineString?.indices;
      if (!lineIndices || lineIndices.length < 2) continue;
      const restartValue = lineString.restartIndex;
      const hasRestart = restartValue !== undefined;

      // Per-lineString color override: the lineString's own `materialColor`
      // takes precedence over the primitive-level `globalColor` (matches
      // WebGL `EdgeVisibilityPipelineStage.js:490-492`). When both are
      // absent the edge falls back to per-vertex COLOR_0, then the
      // no-override sentinel.
      const lineColor =
        normalizeEdgeColor(lineString.materialColor) ?? globalColor;

      let previous: number | undefined;
      for (let j = 0; j < lineIndices.length; j++) {
        const currentIndex = lineIndices[j];
        if (hasRestart && currentIndex === restartValue) {
          previous = undefined;
          continue;
        }
        if (previous === undefined) {
          previous = currentIndex;
          continue;
        }
        const a = previous;
        const b = currentIndex;
        previous = currentIndex;

        if (a === b) continue;
        // Range check against the primitive's vertex count (mirrors
        // WebGL). 0 disables the upper-bound test when no attribute
        // count is available, but the position-bounds skip below still
        // catches any genuinely out-of-range index.
        if (
          vertexCount > 0 &&
          (a < 0 || a >= vertexCount || b < 0 || b >= vertexCount)
        ) {
          continue;
        }

        const small = Math.min(a, b);
        const big = Math.max(a, b);
        const key = `${small},${big}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ai = a * 3;
        const bi = b * 3;
        if (ai + 2 >= positionData.length || bi + 2 >= positionData.length) {
          continue;
        }
        const ax = positionData[ai];
        const ay = positionData[ai + 1];
        const az = positionData[ai + 2];
        const bx = positionData[bi];
        const by = positionData[bi + 1];
        const bz = positionData[bi + 2];

        // Sample feature ID from the lower-index endpoint, same as the
        // visibility path. lineStrings without a FEATURE_ID_0 attribute
        // leave this at 0.
        let edgeFeatureId = 0;
        if (fidSource !== null) {
          const idxForFeature = small;
          if (idxForFeature < fidSource.length) {
            edgeFeatureId = fidSource[idxForFeature];
            if (edgeFeatureId > 0) sawNonZeroFeature = true;
          }
        }

        const edgeColor = resolveEdgeColor(lineColor, small);

        emitEdgeQuad(
          ax,
          ay,
          az,
          bx,
          by,
          bz,
          0,
          0,
          0,
          0,
          0,
          0,
          HARD_TYPE_NORM,
          edgeFeatureId,
          edgeColor,
        );
      }
    }
  }

  if (outEdge === 0) return null;
  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    edgeCount: outEdge,
    indexCount: outEdge * INDICES_PER_EDGE,
    hasFeatureIds: sawNonZeroFeature,
  };
}

export interface EdgeEmitterCache {
  device: GPUDevice | null;
  // The MRT (3-target) pipeline used when `scene._enableEdgeVisibility`
  // is on and the edge MRT framebuffer is allocated. Writes color +
  // featureId + packed-depth.
  pipeline: GPURenderPipeline | null;
  // Single-target fallback pipeline used when the edge MRT FBO isn't
  // allocated (the demo opts-out of edge visibility, or the FBO hasn't
  // initialized yet). Writes only the color attachment — featureId +
  // packed-depth outputs are discarded. Matches the WebGL behavior of
  // executing edge commands in the regular scene FB pass when
  // `_enableEdgeVisibility` is off. Session 65 Batch 13.
  pipelineSingleTarget: GPURenderPipeline | null;
  cameraBGL: GPUBindGroupLayout | null;
  edgeBGL: GPUBindGroupLayout | null;
  shaderModule: GPUShaderModule | null;
  colorFormat: GPUTextureFormat;
  sampleCount: number;
}

export function createEdgeEmitterCache(): EdgeEmitterCache {
  return {
    device: null,
    pipeline: null,
    pipelineSingleTarget: null,
    cameraBGL: null,
    edgeBGL: null,
    shaderModule: null,
    colorFormat: "bgra8unorm",
    sampleCount: 1,
  };
}

export function destroyEdgeEmitterCache(cache: EdgeEmitterCache): void {
  cache.device = null;
  cache.pipeline = null;
  cache.pipelineSingleTarget = null;
  cache.cameraBGL = null;
  cache.edgeBGL = null;
  cache.shaderModule = null;
}

export function ensureEdgeEmitterPipeline(
  cache: EdgeEmitterCache,
  device: GPUDevice,
  colorFormat: GPUTextureFormat,
  sampleCount: number,
): void {
  const needsRebuild =
    !cache.pipeline ||
    !cache.pipelineSingleTarget ||
    cache.device !== device ||
    cache.colorFormat !== colorFormat ||
    cache.sampleCount !== sampleCount;
  if (!needsRebuild) return;

  cache.device = device;
  cache.colorFormat = colorFormat;
  cache.sampleCount = sampleCount;
  cache.pipeline = null;
  cache.pipelineSingleTarget = null;

  if (!cache.shaderModule) {
    cache.shaderModule = device.createShaderModule({
      label: "EdgeEmitter-Shader",
      code: EDGE_EMITTER_WGSL,
    });
  }

  cache.cameraBGL = device.createBindGroupLayout({
    label: "EdgeEmitter-CameraBGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  cache.edgeBGL = device.createBindGroupLayout({
    label: "EdgeEmitter-EdgeBGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({
    label: "EdgeEmitter-PipelineLayout",
    bindGroupLayouts: [cache.cameraBGL, cache.edgeBGL],
  });

  // Shared vertex + primitive + depth state. Only `fragment.targets`
  // and `label` differ between the MRT and single-target variants —
  // the fragment shader writes to @location 0/1/2 unconditionally, but
  // WebGPU silently drops writes to attachments that aren't present in
  // the pipeline's color-target array.
  const vertex: GPUVertexState = {
    module: cache.shaderModule,
    entryPoint: "vertexMain",
    buffers: [
      {
        arrayStride: VERTEX_STRIDE_BYTES,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, // position
          { shaderLocation: 1, offset: 12, format: "float32" }, // edgeType
          { shaderLocation: 2, offset: 16, format: "float32x3" }, // normalA
          { shaderLocation: 3, offset: 28, format: "float32x3" }, // normalB
          { shaderLocation: 4, offset: 40, format: "float32x3" }, // otherPos
          { shaderLocation: 5, offset: 52, format: "float32" }, // edgeOffset
          { shaderLocation: 6, offset: 56, format: "float32" }, // featureId (C-R8-EDGE-FEATURE-ID)
          { shaderLocation: 7, offset: 60, format: "float32x4" }, // edgeColor (NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU)
        ],
      },
    ],
  };
  const primitive: GPUPrimitiveState = {
    // C-R8-EDGE-WIDE-LINES — quad expansion lands as triangles, not
    // native lines. WebGPU has no native wide-line support.
    topology: "triangle-list",
    cullMode: "none",
  };
  const depthStencil: GPUDepthStencilState = {
    format: "depth24plus-stencil8",
    depthWriteEnabled: true,
    depthCompare: "less",
  };
  const multisample: GPUMultisampleState | undefined =
    sampleCount > 1 ? { count: sampleCount } : undefined;

  // MRT variant — color + featureId + packed-depth. Used when edges
  // are redirected into `_edgeFramebuffer` by the 3D-tile pass
  // dispatcher (`WebGPUSceneRenderer3DTilePasses.ts`).
  const mrtTargets: GPUColorTargetState[] = [
    { format: colorFormat },
    { format: "rgba8unorm" },
    { format: "rgba8unorm" },
  ];
  cache.pipeline = device.createRenderPipeline({
    label: "EdgeEmitter-Pipeline",
    layout: pipelineLayout,
    vertex,
    fragment: {
      module: cache.shaderModule,
      entryPoint: "fragmentMain",
      targets: mrtTargets,
    },
    primitive,
    depthStencil,
    multisample,
  });

  // Single-target variant — color only. Session 65 Batch 13
  // (NEW-VR-DEPTHPLANE-EDGEEMITTER-PIPELINE-FORMAT). Used when the
  // edge MRT FBO isn't allocated (the scene didn't request edge
  // visibility) so the edge commands fall back to the regular scene
  // framebuffer pass. The fragment shader's id + depth writes get
  // dropped silently — that matches the WebGL behavior where
  // edge-visibility-off scenes still draw the colored edge lines.
  cache.pipelineSingleTarget = device.createRenderPipeline({
    label: "EdgeEmitter-Pipeline-SingleTarget",
    layout: pipelineLayout,
    vertex,
    fragment: {
      module: cache.shaderModule,
      entryPoint: "fragmentSceneFB",
      targets: makeSceneFBTargets(colorFormat), // scene-FB MRT attachment count
    },
    primitive,
    depthStencil,
    multisample,
  });
}

export interface EdgePrimitiveResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  cameraBuffer: GPUBuffer;
  edgeBuffer: GPUBuffer;
  cameraBG: GPUBindGroup;
  edgeBG: GPUBindGroup;
  indexCount: number;
  /** C-R8-EDGE-FEATURE-ID — populated post-construction by the model
   * renderer once `extractEdgeGeometry` has reported whether any
   * edge in this primitive carried a non-zero feature ID. The model-
   * level rollup (`cache.hasEdgeFeatureIds`) gates the inline
   * detection's per-feature comparison in Model FS. */
  hasFeatureIds?: boolean;
}

export function createEdgePrimitiveResources(
  device: GPUDevice,
  cache: EdgeEmitterCache,
  geometry: EdgeGeometry,
): EdgePrimitiveResources | null {
  if (!cache.cameraBGL || !cache.edgeBGL) return null;

  const vertexBuffer = device.createBuffer({
    label: "EdgeEmitter-Vertices",
    size: geometry.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, geometry.vertices);

  const indexBuffer = device.createBuffer({
    label: "EdgeEmitter-Indices",
    size: geometry.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, geometry.indices);

  // Camera UB: 2 mat4 = 128 bytes (mvp + mv).
  const cameraBuffer = device.createBuffer({
    label: "EdgeEmitter-CameraUniforms",
    size: 128,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Edge UB: vec4 color + vec4 params = 32 bytes.
  const edgeBuffer = device.createBuffer({
    label: "EdgeEmitter-EdgeUniforms",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const cameraBG = device.createBindGroup({
    label: "EdgeEmitter-CameraBG",
    layout: cache.cameraBGL,
    entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
  });
  const edgeBG = device.createBindGroup({
    label: "EdgeEmitter-EdgeBG",
    layout: cache.edgeBGL,
    entries: [{ binding: 0, resource: { buffer: edgeBuffer } }],
  });

  return {
    vertexBuffer,
    indexBuffer,
    cameraBuffer,
    edgeBuffer,
    cameraBG,
    edgeBG,
    indexCount: geometry.indexCount,
  };
}

export function destroyEdgePrimitiveResources(
  resources: EdgePrimitiveResources | null | undefined,
): void {
  if (!resources) return;
  resources.vertexBuffer.destroy();
  resources.indexBuffer.destroy();
  resources.cameraBuffer.destroy();
  resources.edgeBuffer.destroy();
}

const _scratchCameraData = new Float32Array(32); // 2 mat4 = 32 floats

/**
 * Write per-frame camera + edge uniforms.
 *
 * @param mvp  4×4 column-major model-view-projection matrix
 * @param mv   4×4 column-major model-view matrix (for silhouette eye-space normal transform)
 * @param color  edge color (0..1 RGBA)
 * @param viewportWidth / viewportHeight  pixel dimensions for NDC→pixel offset math
 * @param lineWidth  pixel width for the quad expansion
 * @param linePattern  16-bit dash mask (0xffff = solid)
 */
export function writeEdgeEmitterUniforms(
  device: GPUDevice,
  resources: EdgePrimitiveResources,
  mvp: Float32Array,
  mv: Float32Array,
  color: { r: number; g: number; b: number; a: number },
  viewportWidth: number,
  viewportHeight: number,
  lineWidth: number,
  linePattern: number,
): void {
  // Camera UB: mvp[0..15], mv[16..31]
  _scratchCameraData.set(mvp, 0);
  _scratchCameraData.set(mv, 16);
  device.queue.writeBuffer(resources.cameraBuffer, 0, _scratchCameraData);

  const edgeData = new Float32Array(8);
  edgeData[0] = color.r;
  edgeData[1] = color.g;
  edgeData[2] = color.b;
  edgeData[3] = color.a;
  edgeData[4] = viewportWidth;
  edgeData[5] = viewportHeight;
  edgeData[6] = lineWidth;
  // Pattern packed as float — 0xffff fits in mantissa exactly, as do
  // any 16-bit pattern values used in practice.
  edgeData[7] = linePattern & 0xffff;
  device.queue.writeBuffer(resources.edgeBuffer, 0, edgeData);
}
