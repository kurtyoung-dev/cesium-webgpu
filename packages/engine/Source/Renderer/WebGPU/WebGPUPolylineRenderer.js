/**
 * @module WebGPUPolylineRenderer
 *
 * Handles WebGPU rendering of PolylineCollection with material support.
 * Polylines are rendered as instanced screen-space quads per line segment.
 *
 * Supports material types: Color (default), PolylineArrow, PolylineDash,
 * PolylineGlow, PolylineOutline.
 *
 * Instance data per segment (112 bytes, 7 x vec4 = 28 floats):
 *   startPosHighAndWidth(4) + startPosLow(3)+sStart(1) +
 *   endPosHighAndMiter(4) + endPosLow(3)+sEnd(1) + color(4) +
 *   perInstanceFlags(4 = disableDepthTestDistance, splitDirection,
 *                    distanceDisplayConditionNearSq, distanceDisplayConditionFarSq) +
 *   translucencyByDistance(4 = near, nearAlpha, far, farAlpha)
 *
 * The .w padding slots of startPosLow and endPosLow carry normalized
 * texture coordinates (sStart/sEnd) along the polyline for material shaders.
 * The base PolylineCollection.wgsl ignores these via .xyz access, so RTE
 * precision is unaffected.
 *
 * Batch 22 appended `perInstanceFlags` at @location(5) carrying DP-H42's
 * per-polyline `disableDepthTestDistance` and DP-H40's `splitDirection`.
 * Batch 136 (Audit A.14) added DDC near^2/far^2 to perInstanceFlags.zw
 * (previously _pad/_pad) and translucencyByDistance at @location(6).
 * Polyline does not have pixelOffset or quad-scale, so the
 * EYE_DISTANCE_PIXEL_OFFSET / EYE_DISTANCE_SCALING gates are not
 * consumed here. All 6 polyline shaders (base color + pick + 4 material
 * variants) read the same slots so switching materials doesn't require
 * re-packing.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// Instance buffer: 7 × vec4 = 28 floats (112 bytes).
// Was 24 floats (Batch 22); bumped in Batch 136 to add the
// translucencyByDistance gate.
const FLOATS_PER_SEGMENT = 28;
const BYTES_PER_SEGMENT = FLOATS_PER_SEGMENT * 4;
const VERTICES_PER_SEGMENT = 6;

/**
 * AUDIT_2026_05_02 A.14 (Batch 136) — pack a CesiumJS NearFarScalar
 * (near, nearValue, far, farValue) into 4 contiguous floats. Mirrors
 * `WebGPUBillboardRenderer.packNearFarScalar`. Identity-NFS written
 * when `scalar` is undefined so the shader's gate produces the
 * unchanged baseline for polylines with no `translucencyByDistance`
 * configured.
 */
function packNearFarScalar(out, offset, scalar, identity) {
  if (scalar) {
    out[offset + 0] = typeof scalar.near === "number" ? scalar.near : 0.0;
    out[offset + 1] =
      typeof scalar.nearValue === "number" ? scalar.nearValue : identity;
    out[offset + 2] = typeof scalar.far === "number" ? scalar.far : 1.0e8;
    out[offset + 3] =
      typeof scalar.farValue === "number" ? scalar.farValue : identity;
  } else {
    out[offset + 0] = 0.0;
    out[offset + 1] = identity;
    out[offset + 2] = 1.0e8;
    out[offset + 3] = identity;
  }
}

// Camera UBO: mvpRTE(64) + camHigh(16) + camLow(16) + viewport(8) + pad(8)
//   + minimumDisableDepthTestDistance(4) + splitPosition(4) + pad(8)
//   + previousViewProjection(64)  = 192 bytes (48 floats).
// DP-H41 (Batch 27) — previousViewProjection appended for TAA / motion
// vectors. Offset 128..191 = slots 32..47.
const CAMERA_BUFFER_SIZE = 192;
const CAMERA_FLOATS = CAMERA_BUFFER_SIZE / 4; // 48

// Placeholder material UBO (16 bytes minimum for WebGPU)
const PLACEHOLDER_MATERIAL_BYTES = 16;

const scratchModelView = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedStart = new EncodedCartesian3();
const scratchEncodedEnd = new EncodedCartesian3();

// =========================================================================
// Material type → shader key mapping
// =========================================================================

/**
 * Maps CesiumJS material type strings to WebGPUCollectionShaders keys.
 * Unsupported types fall back to "polylineColor" (solid color).
 * @private
 */
const MATERIAL_SHADER_KEYS = {
  Color: "polylineColor",
  PolylineArrow: "polylineArrow",
  PolylineDash: "polylineDash",
  PolylineGlow: "polylineGlow",
  PolylineOutline: "polylineOutline",
};

function selectShaderKey(materialType) {
  return MATERIAL_SHADER_KEYS[materialType] || "polylineColor";
}

/**
 * Returns true if the material type requires st texture coordinates.
 * The Color shader uses per-instance color, not st coords.
 * @private
 */
function materialNeedsST(materialType) {
  return (
    materialType === "PolylineArrow" ||
    materialType === "PolylineGlow" ||
    materialType === "PolylineOutline"
  );
}

// =========================================================================
// Cumulative distance computation for st.s coordinate
// =========================================================================

/**
 * Computes normalized cumulative distances along a polyline's positions.
 * Returns an array where distances[i] ∈ [0, 1] represents how far along
 * the polyline position[i] is (0 at start, 1 at end).
 * @private
 */
function computeNormalizedDistances(positions) {
  const count = positions.length;
  const distances = new Float64Array(count);
  distances[0] = 0;
  for (let i = 1; i < count; i++) {
    const prev = positions[i - 1];
    const curr = positions[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dz = curr.z - prev.z;
    distances[i] = distances[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const totalLength = distances[count - 1];
  if (totalLength > 0) {
    for (let i = 1; i < count; i++) {
      distances[i] /= totalLength;
    }
  }
  return distances;
}

// =========================================================================
// Segment data builders
// =========================================================================

/**
 * Groups polylines by material type and returns a Map of
 * materialType → { polylines, material }.
 * @private
 */
function groupByMaterialType(collection) {
  const polylines = collection._polylines;
  const length = collection._polylinesLength;
  const groups = new Map();

  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }
    const positions = polyline.positions;
    if (positions.length < 2) {
      continue;
    }

    const material = polyline.material;
    const materialType = material ? material.type : "Color";

    let group = groups.get(materialType);
    if (!defined(group)) {
      group = { polylines: [], material };
      groups.set(materialType, group);
    }
    group.polylines.push(polyline);
  }
  return groups;
}

/**
 * Build segment instance data for a group of polylines sharing one material.
 * Packs RTE-encoded positions, line width, and optional st coordinates
 * into the padding slots (startPosLow.w = sStart, endPosLow.w = sEnd).
 * @private
 */
function buildSegmentDataForGroup(polylineGroup, computeST) {
  const polylines = polylineGroup.polylines;

  // Count total segments. When a polyline has `loop: true`, it also emits
  // one extra closing segment from positions[last] → positions[0].
  let totalSegments = 0;
  for (let i = 0; i < polylines.length; i++) {
    const pl = polylines[i];
    const baseSegments = pl.positions.length - 1;
    totalSegments +=
      baseSegments + (pl.loop && pl.positions.length >= 2 ? 1 : 0);
  }

  const segmentData = new Float32Array(totalSegments * FLOATS_PER_SEGMENT);
  let segmentCount = 0;

  for (let i = 0; i < polylines.length; i++) {
    const polyline = polylines[i];
    const positions = polyline.positions;
    const width = polyline.width || 1.0;
    const loopClose = polyline.loop === true && positions.length >= 2;

    // Extract color from polyline (used as instance attribute for Color shader,
    // ignored by material shaders which use uniform color instead)
    const color = polyline._color || polyline.material?.uniforms?.color;
    const r = color ? color.red : 1.0;
    const g = color ? color.green : 1.0;
    const b = color ? color.blue : 1.0;
    const a = color ? color.alpha : 1.0;

    // Compute normalized distances for st.s if needed
    let distances = null;
    if (computeST) {
      distances = computeNormalizedDistances(positions);
    }

    // Emit (positions.length - 1) base segments, plus one closing segment
    // from last→first when `loop: true`. segLimit is positions.length - 1
    // for open polylines and positions.length for loops.
    const segLimit = loopClose ? positions.length : positions.length - 1;
    for (let j = 0; j < segLimit; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      const start = positions[j];
      // Wrap to positions[0] for the final closing segment of a loop.
      const end = positions[(j + 1) % positions.length];

      EncodedCartesian3.fromCartesian(start, scratchEncodedStart);
      EncodedCartesian3.fromCartesian(end, scratchEncodedEnd);

      // startPosHighAndWidth — RTE high component + line width
      segmentData[offset + 0] = scratchEncodedStart.high.x;
      segmentData[offset + 1] = scratchEncodedStart.high.y;
      segmentData[offset + 2] = scratchEncodedStart.high.z;
      segmentData[offset + 3] = width;

      // startPosLow — RTE low component + sStart in .w padding
      segmentData[offset + 4] = scratchEncodedStart.low.x;
      segmentData[offset + 5] = scratchEncodedStart.low.y;
      segmentData[offset + 6] = scratchEncodedStart.low.z;
      segmentData[offset + 7] = distances ? distances[j] : 0.0;

      // endPosHighAndMiter — RTE high component + miter limit
      segmentData[offset + 8] = scratchEncodedEnd.high.x;
      segmentData[offset + 9] = scratchEncodedEnd.high.y;
      segmentData[offset + 10] = scratchEncodedEnd.high.z;
      segmentData[offset + 11] = 2.0; // miterLimit

      // endPosLow — RTE low component + sEnd in .w padding.
      // For the loop-closing segment the "end distance" wraps to 1.0 (the
      // final total length) rather than indexing past the distances array.
      const endDistIdx = j + 1;
      const endDist = distances
        ? endDistIdx < distances.length
          ? distances[endDistIdx]
          : 1.0
        : 0.0;
      segmentData[offset + 12] = scratchEncodedEnd.low.x;
      segmentData[offset + 13] = scratchEncodedEnd.low.y;
      segmentData[offset + 14] = scratchEncodedEnd.low.z;
      segmentData[offset + 15] = endDist;

      // color — per-instance RGBA
      segmentData[offset + 16] = r;
      segmentData[offset + 17] = g;
      segmentData[offset + 18] = b;
      segmentData[offset + 19] = a;

      // perInstanceFlags — DP-H42 / DP-H40 / A.14 per-polyline state,
      // shared by every segment of that polyline so the depth override,
      // split direction, and DDC window are coherent across the line.
      //   x: disableDepthTestDistance (raw meters; squared in shader)
      //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
      //   z: distanceDisplayCondition.near^2 (Batch 136)
      //   w: distanceDisplayCondition.far^2 (Batch 136)
      const d = polyline._disableDepthTestDistance;
      segmentData[offset + 20] = typeof d === "number" && isFinite(d) ? d : 0.0;
      segmentData[offset + 21] = polyline._splitDirection ?? 0.0;
      const ddc = polyline._distanceDisplayCondition;
      if (ddc) {
        const ddcNear = typeof ddc.near === "number" ? ddc.near : 0.0;
        const ddcFar =
          typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
        segmentData[offset + 22] = ddcNear * ddcNear;
        segmentData[offset + 23] = isFinite(ddcFar)
          ? ddcFar * ddcFar
          : Number.MAX_VALUE;
      } else {
        segmentData[offset + 22] = 0.0;
        segmentData[offset + 23] = Number.MAX_VALUE;
      }

      // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance.
      // Identity = 1.0 (multiplicative onto alpha). Polyline doesn't
      // expose pixelOffset or per-quad scale, so the other two
      // NearFarScalar gates aren't packed.
      packNearFarScalar(
        segmentData,
        offset + 24,
        polyline._translucencyByDistance,
        1.0,
      );

      segmentCount++;
    }
  }

  return { segmentData, segmentCount };
}

/**
 * Builds pick-variant segment data. Same layout but @location(4) holds
 * pick color instead of display color. Each polyline gets one pick ID;
 * all its segments share that pick color.
 * @private
 */
function buildPickSegmentData(collection, context) {
  const polylines = collection._polylines;
  const length = collection._polylinesLength;

  let totalSegments = 0;
  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }
    const positions = polyline.positions;
    if (positions.length >= 2) {
      totalSegments += positions.length - 1;
      if (polyline.loop === true) {
        totalSegments += 1; // Closing segment last→first for loop polylines.
      }
    }
  }

  const segmentData = new Float32Array(totalSegments * FLOATS_PER_SEGMENT);
  let segmentCount = 0;

  for (let i = 0; i < length; i++) {
    const polyline = polylines[i];
    if (!defined(polyline) || !polyline.show) {
      continue;
    }

    const positions = polyline.positions;
    const width = polyline.width || 1.0;
    const loopClose = polyline.loop === true && positions.length >= 2;

    // One pick ID per polyline (all segments share it)
    if (!defined(polyline._pickId)) {
      polyline._pickId = context.createPickId(polyline, "polyline");
    }
    const pc = polyline._pickId.color;

    const segLimit = loopClose ? positions.length : positions.length - 1;
    for (let j = 0; j < segLimit; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      EncodedCartesian3.fromCartesian(positions[j], scratchEncodedStart);
      EncodedCartesian3.fromCartesian(
        positions[(j + 1) % positions.length],
        scratchEncodedEnd,
      );

      segmentData[offset + 0] = scratchEncodedStart.high.x;
      segmentData[offset + 1] = scratchEncodedStart.high.y;
      segmentData[offset + 2] = scratchEncodedStart.high.z;
      segmentData[offset + 3] = width;
      segmentData[offset + 4] = scratchEncodedStart.low.x;
      segmentData[offset + 5] = scratchEncodedStart.low.y;
      segmentData[offset + 6] = scratchEncodedStart.low.z;
      segmentData[offset + 7] = 0.0;
      segmentData[offset + 8] = scratchEncodedEnd.high.x;
      segmentData[offset + 9] = scratchEncodedEnd.high.y;
      segmentData[offset + 10] = scratchEncodedEnd.high.z;
      segmentData[offset + 11] = 2.0;
      segmentData[offset + 12] = scratchEncodedEnd.low.x;
      segmentData[offset + 13] = scratchEncodedEnd.low.y;
      segmentData[offset + 14] = scratchEncodedEnd.low.z;
      segmentData[offset + 15] = 0.0;

      // Pick color
      segmentData[offset + 16] = pc.red;
      segmentData[offset + 17] = pc.green;
      segmentData[offset + 18] = pc.blue;
      segmentData[offset + 19] = pc.alpha;

      // Pick path inherits DP-H42 / DP-H40 / A.14 so the picked region
      // matches what the user sees on screen. Same contract as the
      // color path.
      const d = polyline._disableDepthTestDistance;
      segmentData[offset + 20] = typeof d === "number" && isFinite(d) ? d : 0.0;
      segmentData[offset + 21] = polyline._splitDirection ?? 0.0;
      const ddc = polyline._distanceDisplayCondition;
      if (ddc) {
        const ddcNear = typeof ddc.near === "number" ? ddc.near : 0.0;
        const ddcFar =
          typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
        segmentData[offset + 22] = ddcNear * ddcNear;
        segmentData[offset + 23] = isFinite(ddcFar)
          ? ddcFar * ddcFar
          : Number.MAX_VALUE;
      } else {
        segmentData[offset + 22] = 0.0;
        segmentData[offset + 23] = Number.MAX_VALUE;
      }
      packNearFarScalar(
        segmentData,
        offset + 24,
        polyline._translucencyByDistance,
        1.0,
      );

      segmentCount++;
    }
  }

  return { segmentData, segmentCount };
}

// =========================================================================
// Vertex buffer layout — same for all material types
// =========================================================================

const SEGMENT_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SEGMENT,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
    { shaderLocation: 3, offset: 48, format: "float32x4" },
    { shaderLocation: 4, offset: 64, format: "float32x4" },
    // DP-H42 / DP-H40 / A.14 DDC perInstanceFlags. Same slot in every
    // polyline shader variant so per-polyline state can flow through
    // regardless of material type.
    { shaderLocation: 5, offset: 80, format: "float32x4" },
    // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance.
    { shaderLocation: 6, offset: 96, format: "float32x4" },
  ],
};

/**
 * Maps a material-type string to the `ShaderSourceId` it resolves to.
 * Used so the shader-module cache key stays stable even when callers
 * pass different source strings for the same material type.
 * @private
 */
function sourceIdForMaterialType(materialType) {
  switch (materialType) {
    case "polylineArrow":
      return ShaderSourceId.POLYLINE_ARROW;
    case "polylineDash":
      return ShaderSourceId.POLYLINE_DASH;
    case "polylineGlow":
      return ShaderSourceId.POLYLINE_GLOW;
    case "polylineOutline":
      return ShaderSourceId.POLYLINE_OUTLINE;
    case "polylineColor":
    default:
      return ShaderSourceId.POLYLINE_COLLECTION;
  }
}

// Module-level shader-module cache keyed by GPUDevice, shared across
// every PolylineCollection on that device. Same pattern as Billboard /
// Label / Point.
const _polylineShaderModuleCaches = new WeakMap();

function getPolylineShaderModuleCache(device) {
  let cache = _polylineShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _polylineShaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Scan the collection for the DP-H42 / DP-H40 / A.14 defines that
 * apply this frame. Short-circuits once all four bits are set.
 * Baseline (no features) stays the hot path.
 * @private
 */
function computePolylineDefinesForFrame(collection, frameState) {
  let defines = 0;
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const polylines = collection._polylines;
  const length = collection._polylinesLength;
  // Polyline consumes 4 of the 6 distance defines (no pixelOffset, no
  // quad scale).
  const all =
    ShaderDefine.DISABLE_DEPTH_DISTANCE |
    ShaderDefine.SPLIT_ENABLED |
    ShaderDefine.DISTANCE_DISPLAY_CONDITION |
    ShaderDefine.EYE_DISTANCE_TRANSLUCENCY;
  for (let i = 0; i < length; i++) {
    if ((defines & all) === all) {
      break;
    }
    const p = polylines[i];
    if (!defined(p) || !p.show) {
      continue;
    }
    if (
      (defines & ShaderDefine.DISABLE_DEPTH_DISTANCE) === 0 &&
      typeof p._disableDepthTestDistance === "number" &&
      p._disableDepthTestDistance !== 0.0
    ) {
      defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
    }
    if (
      (defines & ShaderDefine.SPLIT_ENABLED) === 0 &&
      p._splitDirection !== undefined &&
      p._splitDirection !== 0.0
    ) {
      defines |= ShaderDefine.SPLIT_ENABLED;
    }
    // AUDIT_2026_05_02 A.14 (Batch 136) — DDC + translucencyByDistance.
    if (
      (defines & ShaderDefine.DISTANCE_DISPLAY_CONDITION) === 0 &&
      defined(p._distanceDisplayCondition)
    ) {
      defines |= ShaderDefine.DISTANCE_DISPLAY_CONDITION;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_TRANSLUCENCY) === 0 &&
      defined(p._translucencyByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_TRANSLUCENCY;
    }
  }
  return defines;
}

/**
 * Prewarm all (material type × define) combinations likely to appear
 * in the first 30 frames. Idempotent per device. 5 material types ×
 * 4 define combos + pick = 24 modules; each `createShaderModule` is
 * ~2–5 ms so the total startup cost stays well under 100 ms.
 * @private
 */
function prewarmPolylineShaders(device) {
  const cache = getPolylineShaderModuleCache(device);
  if (cache._polylinePrewarmed) {
    return;
  }
  const D = ShaderDefine;
  // AUDIT_2026_05_02 A.14 (Batch 136) — added DDC + translucencyByDistance
  // variants. Polyline consumes 4 distance-related defines, but the
  // most common production combos are: baseline, DDC alone (KML),
  // DDC + translucency (animated KML lines), and the all-active set.
  const D_KML = D.DISTANCE_DISPLAY_CONDITION | D.EYE_DISTANCE_TRANSLUCENCY;
  const D_PROD = D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED | D_KML;
  const defineSets = [
    0,
    D.DISABLE_DEPTH_DISTANCE,
    D.SPLIT_ENABLED,
    D.DISTANCE_DISPLAY_CONDITION,
    D.EYE_DISTANCE_TRANSLUCENCY,
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
    D_KML,
    D_PROD,
  ];
  const sourceIdsAndKeys = [
    [ShaderSourceId.POLYLINE_COLLECTION, "polylineColor"],
    [ShaderSourceId.POLYLINE_ARROW, "polylineArrow"],
    [ShaderSourceId.POLYLINE_DASH, "polylineDash"],
    [ShaderSourceId.POLYLINE_GLOW, "polylineGlow"],
    [ShaderSourceId.POLYLINE_OUTLINE, "polylineOutline"],
  ];
  for (const [sourceId, key] of sourceIdsAndKeys) {
    const source = getCollectionShaderSource(key);
    if (!source) {
      continue;
    }
    cache.prewarm(sourceId, source, defineSets, `Polyline ${key} shader`);
  }
  const pickSource = getCollectionShaderSource("polylinePick");
  if (pickSource) {
    cache.prewarm(
      ShaderSourceId.POLYLINE_COLLECTION_PICK,
      pickSource,
      defineSets,
      "Polyline pick shader",
    );
  }
  cache._polylinePrewarmed = true;
}

// =========================================================================
// Pipeline creation
// =========================================================================

/**
 * Build the cache-friendly descriptor for a color polyline pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58). Returns the descriptor plus the
 * shared BGLs so the caller can build bind groups; the actual
 * `GPURenderPipeline` is materialized by `WebGPURenderPipelineCache`.
 * @private
 */
function buildPolylineColorDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  label,
  defines,
) {
  const cameraBindGroupLayout = makeBindGroupLayout(
    device,
    `${label || "Polyline"} camera BGL`,
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const materialBindGroupLayout = makeBindGroupLayout(
    device,
    `${label || "Polyline"} material BGL`,
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [cameraBindGroupLayout, materialBindGroupLayout],
  });

  const descriptor = {
    name: `${label || "Polyline pipeline"} [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  return { descriptor, cameraBindGroupLayout, materialBindGroupLayout };
}

/**
 * Build the cache-friendly descriptor for a pick polyline pipeline. Pick
 * is camera-only (one BGL — pick color comes from instance data, no
 * material UBO).
 *
 * C-R7-RENDERER-MIGRATION (Batch 58).
 * @private
 */
function buildPolylinePickDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  defines,
) {
  const cameraBindGroupLayout = makeBindGroupLayout(
    device,
    "Polyline pick camera BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const descriptor = {
    name: `Polyline pick pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cameraBindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  return { descriptor, cameraBindGroupLayout };
}

/**
 * Convert a `WebGPURenderPipelineDescriptor` to a raw WebGPU descriptor
 * for the synchronous fallback path (no central cache).
 * @private
 */
function descriptorToGPU(d) {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve a single polyline pipeline (color or pick) through the central
 * pipeline cache. Returns the existing GPU pipeline if cached; otherwise
 * kicks off async creation via the cache and returns null. Falls back to
 * direct synchronous creation when `pipelineCache` is null (legacy /
 * WebGL contexts).
 *
 * The `entry` is a slot object { descriptor, pipeline, pending, ... }
 * that gets mutated in place.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58).
 * @private
 */
function tryResolvePolylinePipeline(device, pipelineCache, entry) {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(entry.descriptor);
    if (sync) {
      entry.pipeline = sync;
      entry.pending = false;
      return sync;
    }
    if (!entry.pending) {
      entry.pending = true;
      pipelineCache
        .getPipeline(entry.descriptor)
        .then((p) => {
          entry.pipeline = p;
          entry.pending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear in-flight flag.
          entry.pending = false;
        });
    }
    return null;
  }
  // Fallback — direct synchronous creation matches pre-migration behavior.
  entry.pipeline = device.createRenderPipeline(
    descriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

// =========================================================================
// Uniform packing — camera
// =========================================================================

/**
 * Packs camera/RTE uniforms into a 28-float (112-byte) buffer.
 * Uses RTE (Relative-To-Eye) encoding: the modelView matrix has its
 * translation column zeroed, and the camera position is split into
 * high/low components. This gives sub-meter precision at planetary scale.
 * @private
 */
function packCameraUniforms(uniformData, frameState, modelMatrix) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  // mvpRelativeToEye: modelView with translation zeroed × projection
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // Camera position split into high/low for RTE. Encode in the SAME
  // frame that the per-vertex positions live in (model-space when the
  // collection's modelMatrix is non-identity); see C-P5 in the 2026-04-16
  // per-feature review for the frame-mismatch rationale.
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    frameState.camera.positionWC,
    scratchCameraMC,
  );
  EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);
  uniformData[16] = scratchEncodedCamera.high.x;
  uniformData[17] = scratchEncodedCamera.high.y;
  uniformData[18] = scratchEncodedCamera.high.z;
  uniformData[19] = 0.0;
  uniformData[20] = scratchEncodedCamera.low.x;
  uniformData[21] = scratchEncodedCamera.low.y;
  uniformData[22] = scratchEncodedCamera.low.z;
  uniformData[23] = 0.0;

  // Viewport size for screen-space line expansion
  uniformData[24] = canvas.width;
  uniformData[25] = canvas.height;
  uniformData[26] = 0.0;
  uniformData[27] = 0.0;

  // DP-H42 — frame-wide fallback threshold (meters; squared in shader).
  uniformData[28] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;

  // DP-H40 — split cutoff in framebuffer pixels. WebGL's `czm_splitPosition`
  // convention: `frameState.splitPosition` is the fraction [0, 1] and we
  // upload `fraction * drawingBufferWidth` so the fragment compare sits in
  // the same pixel coord space as WGSL's `@builtin(position).x`.
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[29] = splitFraction * drawingBufferWidth;
  uniformData[30] = 0.0;
  uniformData[31] = 0.0;

  // DP-H41 (Batch 27) — previousViewProjection at slots 32..47 (16 floats,
  // 64 bytes). Cached by `UniformState.update()` BEFORE overwriting the
  // current-frame state, so on frame N this slot holds frame N-1's VP.
  // TAA / motion-vector shaders read it via `camera.previousViewProjection`.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, uniformData, 32);
  } else {
    uniformData[32] = 1;
    uniformData[33] = 0;
    uniformData[34] = 0;
    uniformData[35] = 0;
    uniformData[36] = 0;
    uniformData[37] = 1;
    uniformData[38] = 0;
    uniformData[39] = 0;
    uniformData[40] = 0;
    uniformData[41] = 0;
    uniformData[42] = 1;
    uniformData[43] = 0;
    uniformData[44] = 0;
    uniformData[45] = 0;
    uniformData[46] = 0;
    uniformData[47] = 1;
  }
}

// packMaterialUniforms removed — material data now sourced from
// MaterialUniformBuffer.gpuData via the Option B split. Camera UBO
// is group(0), material UBO is group(1). For the base "Color" type,
// a 16-byte placeholder is used (no material uniforms needed).

// =========================================================================
// Pipeline cache helpers
// =========================================================================

/**
 * Gets or creates a pipeline cache entry for the given (material type,
 * defines) tuple. Each entry is a `{ descriptor, pipeline, pending,
 * cameraBindGroupLayout, materialBindGroupLayout }` slot; the pipeline
 * itself is materialized by `WebGPURenderPipelineCache` so two
 * collections with identical (materialType, defines) share one
 * `GPURenderPipeline`.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58). Previously this returned
 * `{ pipeline, cameraBindGroupLayout, materialBindGroupLayout }` with an
 * already-created pipeline; now it returns the same shape with `pipeline`
 * possibly null until the central cache resolves it.
 * @private
 */
function getOrCreatePolylinePipelineEntry(
  cache,
  device,
  context,
  materialType,
  defines,
) {
  if (!defined(cache.pipelines)) {
    cache.pipelines = {};
  }

  // Batch 110 — invalidate cached pipelines on scene format change
  // (HDR toggle). The polyline cache nests Map-by-defines under each
  // materialType key, so we drop the entire materialType-keyed object
  // and rebuild empty maps on next access.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.pipelines = {};
    cache.pickPipelines = undefined;
    cache._pipelineFormatGeneration = sceneGen;
  }

  let byDefines = cache.pipelines[materialType];
  if (!defined(byDefines)) {
    byDefines = new Map();
    cache.pipelines[materialType] = byDefines;
  }
  if (byDefines.has(defines)) {
    return byDefines.get(defines);
  }

  const shaderKey = selectShaderKey(materialType);
  const shaderCode = getCollectionShaderSource(shaderKey);
  const format = context.scenePipelineFormat || "bgra8unorm";
  const depthFmt = context.depthFormat || "depth24plus-stencil8";
  const label = `Polyline ${materialType}`;
  const moduleCache = getPolylineShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    sourceIdForMaterialType(materialType),
    shaderCode,
    defines,
    label,
  );
  const built = buildPolylineColorDescriptor(
    device,
    shaderModule,
    format,
    depthFmt,
    label,
    defines,
  );

  const entry = {
    descriptor: built.descriptor,
    pipeline: null,
    pending: false,
    cameraBindGroupLayout: built.cameraBindGroupLayout,
    materialBindGroupLayout: built.materialBindGroupLayout,
  };

  byDefines.set(defines, entry);
  return entry;
}

// =========================================================================
// Main update entry point
// =========================================================================

/**
 * Updates or creates WebGPU draw commands for PolylineCollection.
 * Groups polylines by material type and creates per-type draw commands
 * with material-specific shaders and uniform data.
 */
async function updateWebGPUPolylines(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection._polylinesLength;
  if (length === 0) {
    return;
  }

  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;

  // AUDIT_2026_05_02 A.14 (Batch 136) — both Polyline distance gates
  // (DDC + translucencyByDistance) are wired. Polyline has no
  // pixelOffset or quad-scale, so those gates don't apply here.

  // Prewarm all (material × defines) shader modules on first render per
  // device so the hot path doesn't pay for `createShaderModule` cost.
  prewarmPolylineShaders(device);

  // Compute the DP-H42 / DP-H40 defines bitmask for this frame. One bit
  // set per feature that ANY polyline in the collection activates (or
  // the frame-wide `minimumDisableDepthTestDistance` is non-zero).
  const defines = computePolylineDefinesForFrame(collection, frameState);
  cache.currentDefines = defines;

  // Group polylines by material type
  const groups = groupByMaterialType(collection);

  for (const [materialType, group] of groups) {
    // Get or create the descriptor-level cache entry for this
    // (materialType, defines) combo. The actual GPU pipeline is
    // resolved through the central pipeline cache below.
    const pipelineEntry = getOrCreatePolylinePipelineEntry(
      cache,
      device,
      context,
      materialType,
      defines,
    );
    const resolvedPipeline = tryResolvePolylinePipeline(
      device,
      context.webgpuPipelineCache ?? null,
      pipelineEntry,
    );
    if (!defined(resolvedPipeline)) {
      // Pipeline still materializing async — skip this material group's
      // draw for this frame; subsequent frames pick it up via getPipelineSync.
      continue;
    }
    // Backwards-compat shape — downstream code reads `pipelineResult.pipeline`,
    // `pipelineResult.cameraBindGroupLayout`, `pipelineResult.materialBindGroupLayout`.
    const pipelineResult = {
      pipeline: resolvedPipeline,
      cameraBindGroupLayout: pipelineEntry.cameraBindGroupLayout,
      materialBindGroupLayout: pipelineEntry.materialBindGroupLayout,
    };

    // Camera uniform buffer (shared structure, per-material-type instance)
    const camKey = `cameraBuffer_${materialType}`;
    if (!defined(cache[camKey])) {
      cache[camKey] = WebGPUBuffer.createUniformBuffer(
        device,
        CAMERA_BUFFER_SIZE,
        `Polyline ${materialType} camera`,
      );
      cache[`cameraData_${materialType}`] = new Float32Array(CAMERA_FLOATS);
    }

    const cameraBuffer = cache[camKey];
    const cameraData = cache[`cameraData_${materialType}`];

    // Pack camera RTE uniforms
    packCameraUniforms(cameraData, frameState, modelMatrix);
    device.queue.writeBuffer(
      cameraBuffer.buffer,
      0,
      cameraData.buffer,
      0,
      CAMERA_BUFFER_SIZE,
    );

    // Material uniform buffer — sourced from MaterialUniformBuffer.gpuData
    const matKey = `materialBuffer_${materialType}`;
    const material = group.material;
    const matUB = defined(material) ? material._uniformBuffer : undefined;
    const matGpuData = defined(matUB) ? matUB.gpuData : undefined;
    const matByteSize = defined(matGpuData)
      ? Math.max(matGpuData.byteLength, PLACEHOLDER_MATERIAL_BYTES)
      : PLACEHOLDER_MATERIAL_BYTES;

    if (!defined(cache[matKey]) || cache[`${matKey}_size`] !== matByteSize) {
      if (defined(cache[matKey])) {
        cache[matKey].destroy();
      }
      cache[matKey] = device.createBuffer({
        size: matByteSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: `Polyline ${materialType} material`,
      });
      cache[`${matKey}_size`] = matByteSize;
      cache[`matBindGroup_${materialType}`] = null; // force rebind
    }

    if (defined(matGpuData)) {
      if (
        !defined(matUB) ||
        matUB.isDirty ||
        !defined(cache[`matBindGroup_${materialType}`])
      ) {
        device.queue.writeBuffer(cache[matKey], 0, matGpuData);
        if (defined(matUB)) {
          matUB.clearDirty();
        }
      }
    } else {
      device.queue.writeBuffer(
        cache[matKey],
        0,
        new Float32Array(matByteSize / 4),
      );
    }

    // Camera bind group
    const camBgKey = `camBindGroup_${materialType}`;
    if (!defined(cache[camBgKey])) {
      cache[camBgKey] = device.createBindGroup({
        layout: pipelineResult.cameraBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: cameraBuffer.buffer } }],
      });
    }

    // Material bind group
    const matBgKey = `matBindGroup_${materialType}`;
    if (!defined(cache[matBgKey])) {
      cache[matBgKey] = device.createBindGroup({
        layout: pipelineResult.materialBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: cache[matKey] } }],
      });
    }

    // Build segment data with st coords for material shaders
    const needsST = materialNeedsST(materialType);
    const { segmentData, segmentCount } = buildSegmentDataForGroup(
      group,
      needsST,
    );
    if (segmentCount === 0) {
      continue;
    }

    // Segment vertex buffer
    const sbKey = `segmentBuffer_${materialType}`;
    const requiredSize = segmentCount * BYTES_PER_SEGMENT;
    if (!defined(cache[sbKey]) || cache[sbKey].size < requiredSize) {
      if (defined(cache[sbKey])) {
        cache[sbKey].destroy();
      }
      cache[sbKey] = WebGPUBuffer.createVertexBuffer(
        device,
        requiredSize,
        true,
        `Polyline ${materialType} segments`,
      );
    }
    device.queue.writeBuffer(
      cache[sbKey].buffer,
      0,
      segmentData.buffer,
      0,
      requiredSize,
    );

    // Create draw command for render pass. Pick the pass from the
    // collection's blendOption so translucent polylines composite
    // correctly against the rest of the translucent scene. Polyline
    // materials default to alpha-blended (PolylineDash / PolylineGlow /
    // PolylineArrow all render with alpha), so defaulting to TRANSLUCENT
    // when the collection leaves blendOption unspecified is safer than
    // the previous hardcoded OPAQUE.
    if (frameState.passes.render) {
      const polylineBlendOpt = collection._blendOption;
      const polylinePass =
        polylineBlendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */
      // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward the matching
      // render-state from PolylineCollection (`_opaqueRS` / `_translucentRS`,
      // built on demand at lines 536/548 in PolylineCollection.js). The
      // WebGL path does this inline per command at line 740 of
      // PolylineCollection.js — without this forward, the WebGPU pass
      // picks up encoder defaults for stencil/blend/viewport overrides
      // instead of the polyline-specific values.
      const polylineRS =
        polylinePass === 8 /* Pass.OPAQUE */
          ? collection._opaqueRS
          : collection._translucentRS;
      const cmd = new WebGPUDrawCommand({
        pipeline: pipelineResult.pipeline,
        bindGroups: [cache[camBgKey], cache[matBgKey]],
        vertexBuffers: [cache[sbKey]],
        vertexCount: VERTICES_PER_SEGMENT,
        instanceCount: segmentCount,
        pass: polylinePass,
        owner: collection,
        boundingVolume: collection._boundingVolume,
        modelMatrix: modelMatrix,
        cull: true,
        renderState: polylineRS,
      });
      commandList.push(cmd);
    }
  }

  // Pick pass — uses a single combined buffer with pick colors
  if (frameState.passes.pick) {
    _pushPolylinePickCommand(
      collection,
      frameState,
      device,
      cache,
      modelMatrix,
      commandList,
    );
  }
}

/**
 * Builds and pushes a polyline pick draw command.
 * Pick uses the base PolylineCollection shader (color from instance data)
 * since pick color is per-polyline, not per-material.
 * @private
 */
function _pushPolylinePickCommand(
  collection,
  frameState,
  device,
  cache,
  modelMatrix,
  commandList,
) {
  const context = frameState.context;

  // DP-H42 / DP-H40 — pick pipeline mirrors the color pipeline's defines
  // so picked regions match the visible ones.
  // C-R7-RENDERER-MIGRATION (Batch 58) — `pickPipelines` is now a Map of
  // `defines → { descriptor, pipeline, pending, cameraBindGroupLayout }`.
  // The actual GPU pipeline is materialized via `context.webgpuPipelineCache`.
  const pickDefines = cache.currentDefines ?? 0;
  if (!defined(cache.pickPipelines)) {
    cache.pickPipelines = new Map();
  }
  let pickPipelineEntry = cache.pickPipelines.get(pickDefines);
  if (!defined(pickPipelineEntry)) {
    const pickShader = getCollectionShaderSource("polylinePick");
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getPolylineShaderModuleCache(device);
    const pickModule = moduleCache.getOrCreate(
      ShaderSourceId.POLYLINE_COLLECTION_PICK,
      pickShader,
      pickDefines,
      "Polyline pick shader",
    );
    const built = buildPolylinePickDescriptor(
      device,
      pickModule,
      format,
      depthFmt,
      pickDefines,
    );
    pickPipelineEntry = {
      descriptor: built.descriptor,
      pipeline: null,
      pending: false,
      cameraBindGroupLayout: built.cameraBindGroupLayout,
    };
    cache.pickPipelines.set(pickDefines, pickPipelineEntry);
    // When the defines rotate, the cameraBindGroupLayout is recreated —
    // drop the cached bind group so it gets rebuilt next.
    cache.pickCameraBindGroup = undefined;
  }
  const resolvedPickPipeline = tryResolvePolylinePipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pickPipelineEntry,
  );
  if (!defined(resolvedPickPipeline)) {
    // Pick pipeline still materializing — skip this frame's pick draw.
    return;
  }
  cache.pickPipeline = resolvedPickPipeline;
  cache.pickCameraBindGroupLayout = pickPipelineEntry.cameraBindGroupLayout;

  // Camera-only buffer for pick pass
  if (!defined(cache.pickCameraBuffer)) {
    cache.pickCameraBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      CAMERA_BUFFER_SIZE,
      "Polyline pick camera",
    );
    cache.pickCameraData = new Float32Array(CAMERA_FLOATS);
  }

  // Pick pass uses the same RTE camera transform as the render pass
  packCameraUniforms(cache.pickCameraData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cache.pickCameraBuffer.buffer,
    0,
    cache.pickCameraData.buffer,
    0,
    CAMERA_BUFFER_SIZE,
  );

  if (!defined(cache.pickCameraBindGroup)) {
    cache.pickCameraBindGroup = device.createBindGroup({
      layout: cache.pickCameraBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: cache.pickCameraBuffer.buffer },
        },
      ],
    });
  }

  const pickResult = buildPickSegmentData(collection, context);
  if (pickResult.segmentCount === 0) {
    return;
  }

  const pickSize = pickResult.segmentCount * BYTES_PER_SEGMENT;
  if (
    !defined(cache.pickSegmentBuffer) ||
    cache.pickSegmentBuffer.size < pickSize
  ) {
    if (defined(cache.pickSegmentBuffer)) {
      cache.pickSegmentBuffer.destroy();
    }
    cache.pickSegmentBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      pickSize,
      true,
      "Polyline pick segments",
    );
  }
  device.queue.writeBuffer(
    cache.pickSegmentBuffer.buffer,
    0,
    pickResult.segmentData.buffer,
    0,
    pickSize,
  );

  cache.pickCommand = new WebGPUDrawCommand({
    pipeline: cache.pickPipeline,
    bindGroups: [cache.pickCameraBindGroup],
    vertexBuffers: [cache.pickSegmentBuffer],
    vertexCount: VERTICES_PER_SEGMENT,
    instanceCount: pickResult.segmentCount,
    pass: 8,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
    // Pick runs in OPAQUE pass — mirror WebGL behavior by using the
    // opaque render state (depth-test on, depth-write on, no blending
    // relevant to pick IDs). Falls back to translucent state for
    // TRANSLUCENT-only collections.
    renderState: collection._opaqueRS ?? collection._translucentRS,
  });

  commandList.push(cache.pickCommand);
}

function destroyWebGPUPolylineResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  // Destroy all segment buffers (per-material and pick)
  for (const key of Object.keys(cache)) {
    if (
      key.startsWith("segmentBuffer_") ||
      key.startsWith("cameraBuffer_") ||
      key.startsWith("materialBuffer_")
    ) {
      if (defined(cache[key]) && typeof cache[key].destroy === "function") {
        cache[key].destroy();
      }
    }
  }
  if (defined(cache.pickSegmentBuffer)) {
    cache.pickSegmentBuffer.destroy();
  }
  if (defined(cache.pickUniformBuffer)) {
    cache.pickUniformBuffer.destroy();
  }

  collection._webgpuCache = undefined;
}

export { updateWebGPUPolylines, destroyWebGPUPolylineResources };
export default { updateWebGPUPolylines, destroyWebGPUPolylineResources };
