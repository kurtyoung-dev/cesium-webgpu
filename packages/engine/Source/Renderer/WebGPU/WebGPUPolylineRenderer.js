/**
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
 * `perInstanceFlags` at @location(5) carries each polyline's
 * `disableDepthTestDistance`, `splitDirection`, and squared near/far
 * distance-display thresholds. `translucencyByDistance` uses @location(6).
 * Polyline does not have pixelOffset or quad-scale, so the
 * EYE_DISTANCE_PIXEL_OFFSET / EYE_DISTANCE_SCALING gates are not
 * consumed here. All 6 polyline shaders (base color + pick + 4 material
 * variants) read the same slots so switching materials doesn't require
 * re-packing.
 *
 * @private
 * @module WebGPUPolylineRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import BlendOption from "../../Scene/BlendOption.js";
import Pass from "../Pass.js";
// Scene-mode-aware position projection. `SceneTransforms.computeActualEllipsoidPosition`
// maps an ECEF position to the active scene mode's frame: identity in
// SCENE3D, `(proj.z, proj.x, proj.y)` in COLUMBUS_VIEW, `(0, proj.x,
// proj.y)` in SCENE2D, and a CPU-side per-vertex lerp by `morphTime`
// in MORPHING (the same `.zxy` swizzle and manual lerp the WebGL
// `PolylineVS.glsl` does on the GPU). Encoding the actual position in
// the segment buffer — instead of the raw ECEF — lets the existing
// mode-aware `mvpRelativeToEye` (built from `uniformState.view/projection`)
// project polylines correctly in all four modes without adding a second
// position stream or a WGSL morph branch. SCENE3D stays byte-identical.
import SceneMode from "../../Scene/SceneMode.js";
import SceneTransforms from "../../Scene/SceneTransforms.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUCollectionCameraUB from "./WebGPUCollectionCameraUB.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
// The OIT accumulation variant keeps a non-LOG_DEPTH preprocess of the
// polyline color source in `cmd._shaderCode`; it is unused unless OIT is active.
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";
// Build color targets against the scene framebuffer.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import {
  createMaterialUploadState,
  uploadMaterialUniformBuffer,
} from "./WebGPUMaterialUploadState.js";
// Shared per-frame scaffolding. Polyline is bucket-shaped (grouped by material
// type, no resident-instance manager, no per-instance pick buffer), so it
// folds only the genuinely-shared pieces:
//   - the per-device shader-module-cache accessor,
//   - the settled-2D/CV coplanar-depth flag (`computeNoDepthTest`), and
//   - the re-entry / infinite-loop sentinel (Sentinel 1).
// Polyline keeps its unique logic: the material-type bucketing, the
// nested `pipelines[materialType] → Map` cache + its bespoke string
// pipeline key, segment packing, and the per-material velocity gate.
import {
  beginCollectionFrame,
  endCollectionFrame,
  computeNoDepthTest,
  validateDrawTargets,
  validateInstancedDrawBuffer,
  makeDeviceShaderModuleCacheAccessor,
} from "./WebGPUCollectionRendererBase.js";

// Instance buffer: 7 × vec4 = 28 floats (112 bytes).
// The final vec4 carries the translucency-by-distance gate.
const FLOATS_PER_SEGMENT = 28;
const BYTES_PER_SEGMENT = FLOATS_PER_SEGMENT * 4;
const VERTICES_PER_SEGMENT = 6;
// Keep temporarily inactive material resources resident long enough to absorb
// ordinary show/hide changes and streaming gaps. Immediate retirement made a
// one-frame absence pay synchronous buffer/bind-group recreation on return.
const MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES = 60;

/**
 * Encodes `disableDepthTestDistance` using the same representation as
 * `WebGPUBillboardRenderer.encodeDisableDepthTestDistance`.
 * Maps `Number.POSITIVE_INFINITY` to `-1.0` so the WGSL `<0` always-disable
 * sentinel fires, matching WebGL's sentinel packing convention.
 * Infinity must be handled before the finite-value branch; collapsing it to
 * 0.0 would make the WGSL sentinel branch unreachable.
 */
function encodeDisableDepthTestDistance(value) {
  if (typeof value !== "number") {
    return 0.0;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return -1.0;
  }
  if (isFinite(value) && value > 0.0) {
    return value;
  }
  return 0.0;
}

/**
 * Packs a CesiumJS NearFarScalar
 * (near, nearValue, far, farValue) into four contiguous floats. Mirrors
 * `WebGPUBillboardRenderer.packNearFarScalar`. When `scalar` is undefined, an
 * identity NearFarScalar is written so the shader preserves the baseline for
 * polylines without `translucencyByDistance`.
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
// previousViewProjection supports TAA and motion vectors at byte offsets
// 128..191, or float slots 32..47.
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

// Scratch space for each mode-projected endpoint and for a world-frame copy
// after the collection model matrix is applied. Non-3D projection starts from
// the ECEF position transformed by that matrix, matching
// `PolylineBucket.getSegments`: apply `modelMatrix`, then call
// `projection.project(cartographic)`.
const scratchActualStart = new Cartesian3();
const scratchActualEnd = new Cartesian3();
const scratchModelPoint = new Cartesian3();

/**
 * Maps an ECEF position into the active scene mode's render frame. In
 * SCENE3D, `result` receives the raw ECEF input because
 * `mvpRelativeToEye` already includes the collection model matrix. In 2D,
 * Columbus View, and morph mode, it receives the projected `.zxy` position
 * expected by `mvpRelativeToEye`, with the model matrix and morph interpolation
 * applied on the CPU. Returns `result` (a Cartesian3).
 *
 * `modelMatrix` is the collection's model matrix; identity for the common
 * case, in which the multiply is a no-op clone.
 * @private
 */
function projectPositionForMode(position, frameState, modelMatrix, result) {
  if (frameState.mode === SceneMode.SCENE3D) {
    // `mvpRelativeToEye` already includes the model matrix in SCENE3D, so
    // encode the raw ECEF position expected by `EncodedCartesian3`.
    return Cartesian3.clone(position, result);
  }
  // 2D / CV / Morph: project the modelMatrix-applied world position.
  Matrix4.multiplyByPoint(modelMatrix, position, scratchModelPoint);
  const actual = SceneTransforms.computeActualEllipsoidPosition(
    frameState,
    scratchModelPoint,
    result,
  );
  // `computeActualEllipsoidPosition` can return undefined if the point
  // has no valid cartographic (e.g. exactly at the ellipsoid center).
  // Fall back to the world point so the segment still has finite data.
  return defined(actual) ? actual : Cartesian3.clone(scratchModelPoint, result);
}

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
 * Groups polylines by exact material identity. An optional result map lets the
 * renderer reuse group objects and arrays across frames for stable materials.
 * Empty groups are removed so a deleted material is not retained by the cache.
 *
 * @param {object} collection
 * @param {Map} [result]
 * @returns {Map}
 * @private
 */
const defaultMaterialGroupKey = Object.freeze({});

function groupByMaterialType(collection, result) {
  const polylines = collection._polylines;
  const length = collection._polylines.length;
  const groups = result ?? new Map();
  for (const group of groups.values()) {
    group.polylines.length = 0;
  }

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
    // Base Color-type materials are per-instance colored — the Color shader
    // reads the per-instance color attribute and ignores the material UBO —
    // so exact-object-identity grouping split N solid-color polylines into N
    // draws. Key Color materials by material type so they batch into a single
    // draw; UBO-consuming types (Dash/Glow/Arrow/Outline/Image) keep
    // exact-object-identity grouping because distinct instances carry
    // distinct uniforms.
    const groupKey =
      materialType === "Color"
        ? "Color"
        : (material ?? defaultMaterialGroupKey);

    let group = groups.get(groupKey);
    if (!defined(group)) {
      group = { polylines: [], material, materialType };
      groups.set(groupKey, group);
    }
    group.material = material;
    group.materialType = materialType;
    group.polylines.push(polyline);
  }

  for (const [key, group] of groups) {
    if (group.polylines.length === 0) {
      groups.delete(key);
    }
  }
  return groups;
}

function getMaterialResourceKey(cache, materialType, material) {
  // Color-type groups share one stable resource key: groupByMaterialType
  // batches all Color polylines into a single type-keyed group whose
  // `group.material` is merely the last member's instance. An identity-derived
  // key would flap with collection membership and churn the cached
  // material/segment buffers; the Color shader never reads the material UBO,
  // so a shared key is safe.
  if (materialType === "Color" || !defined(material)) {
    return `${materialType}_default`;
  }
  cache.materialResourceIds ??= new WeakMap();
  cache.materialResourceIdCounter ??= 0;
  let id = cache.materialResourceIds.get(material);
  if (!defined(id)) {
    id = ++cache.materialResourceIdCounter;
    cache.materialResourceIds.set(material, id);
  }
  return `${materialType}_${id}`;
}

function pruneInactiveMaterialResources(cache, activeKeys, frameNumber) {
  const lastUsedByKey = (cache.materialResourceLastUsed ??= new Map());
  for (const key of activeKeys) {
    lastUsedByKey.set(key, frameNumber);
  }

  for (const [key, lastUsedFrame] of lastUsedByKey) {
    if (
      activeKeys.has(key) ||
      frameNumber - lastUsedFrame < MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES
    ) {
      continue;
    }
    for (const prefix of [
      "materialBuffer_",
      "segmentBuffer_",
      "prevSegmentBuffer_",
    ]) {
      const resourceKey = `${prefix}${key}`;
      const resource = cache[resourceKey];
      if (defined(resource) && typeof resource.destroy === "function") {
        resource.destroy();
      }
      delete cache[resourceKey];
    }
    delete cache[`materialBuffer_${key}_size`];
    delete cache[`materialUploadState_${key}`];
    delete cache[`matBindGroup_${key}`];
    delete cache[`prevSegmentData_${key}`];
    lastUsedByKey.delete(key);
  }
}

/**
 * Resolves pipeline and camera resources once per material type per collection
 * update. Exact material instances still own distinct material/segment state,
 * but they no longer repeat an identical camera upload or resolver setup.
 *
 * @private
 */
function prepareMaterialTypeFrameResources(
  cache,
  device,
  context,
  materialType,
  defines,
  noDepthTest,
  frameState,
  modelMatrix,
  frameToken,
) {
  const resourcesByType = (cache.materialTypeFrameResources ??= new Map());
  let resources = resourcesByType.get(materialType);
  if (!defined(resources)) {
    resources = {
      frameToken: -1,
      ready: false,
      pipelineResult: {},
    };
    resourcesByType.set(materialType, resources);
  } else if (resources.frameToken === frameToken) {
    return resources.ready ? resources : undefined;
  }

  resources.frameToken = frameToken;
  resources.ready = false;

  const pipelineEntry = getOrCreatePolylinePipelineEntry(
    cache,
    device,
    context,
    materialType,
    defines,
    noDepthTest,
  );
  const resolvedPipeline = tryResolvePolylinePipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pipelineEntry,
  );
  if (!defined(resolvedPipeline)) {
    return undefined;
  }

  const pipelineResult = resources.pipelineResult;
  pipelineResult.pipeline = resolvedPipeline;
  pipelineResult.cameraBindGroupLayout = pipelineEntry.cameraBindGroupLayout;
  pipelineResult.materialBindGroupLayout =
    pipelineEntry.materialBindGroupLayout;
  // Carry the OIT variant inputs (base pipeline descriptor plus non-LOG_DEPTH
  // source) on the frame-result object read by the command site.
  pipelineResult.descriptor = pipelineEntry.descriptor;
  pipelineResult.oitShaderCode = pipelineEntry.oitShaderCode;

  const camKey = (resources.camKey ??= `cameraBuffer_${materialType}`);
  const cameraDataKey =
    (resources.cameraDataKey ??= `cameraData_${materialType}`);
  if (!defined(cache[camKey])) {
    cache[camKey] = WebGPUBuffer.createUniformBuffer(
      device,
      CAMERA_BUFFER_SIZE,
      `Polyline ${materialType} camera`,
    );
    cache[cameraDataKey] = new Float32Array(CAMERA_FLOATS);
  }

  const cameraBuffer = cache[camKey];
  const cameraData = cache[cameraDataKey];
  packCameraUniforms(cameraData, frameState, modelMatrix);
  device.queue.writeBuffer(
    cameraBuffer.buffer,
    0,
    cameraData.buffer,
    0,
    CAMERA_BUFFER_SIZE,
  );

  const camBgKey = (resources.camBgKey ??= `camBindGroup_${materialType}`);
  if (!defined(cache[camBgKey])) {
    cache[camBgKey] = device.createBindGroup({
      layout: pipelineResult.cameraBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cameraBuffer.buffer } }],
    });
  }

  const camUBKey = (resources.camUBKey ??= `cameraUB_${materialType}`);
  if (!defined(cache[camUBKey])) {
    cache[camUBKey] = new WebGPUCollectionCameraUB(
      device,
      `Polyline ${materialType}`,
    );
  }
  cache[camUBKey].bindUniformState(context.uniformState);

  resources.pipelineEntry = pipelineEntry;
  resources.cameraBuffer = cameraBuffer;
  resources.cameraResolver = cache[camUBKey].makeResolver({
    bufferSize: CAMERA_BUFFER_SIZE,
    bindGroupLayout: pipelineResult.cameraBindGroupLayout,
    pack: (data) => packCameraUniforms(data, frameState, modelMatrix),
  });
  resources.ready = true;
  return resources;
}

/**
 * Build segment instance data for a group of polylines sharing one exact
 * material instance. Pipeline state is still shared by material type, while
 * uniform and segment resources remain isolated by material identity.
 * Packs RTE-encoded positions, line width, and optional st coordinates
 * into the padding slots (startPosLow.w = sStart, endPosLow.w = sEnd).
 * @private
 */
function buildSegmentDataForGroup(
  polylineGroup,
  computeST,
  frameState,
  modelMatrix,
) {
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

      // Encode scene-mode-projected endpoints so 2D, Columbus View, and morph
      // modes use the correct map location. SCENE3D is a byte-identical clone.
      const projStart = projectPositionForMode(
        start,
        frameState,
        modelMatrix,
        scratchActualStart,
      );
      const projEnd = projectPositionForMode(
        end,
        frameState,
        modelMatrix,
        scratchActualEnd,
      );
      EncodedCartesian3.fromCartesian(projStart, scratchEncodedStart);
      EncodedCartesian3.fromCartesian(projEnd, scratchEncodedEnd);

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

      // perInstanceFlags stores per-polyline state shared by every segment so
      // the depth override, split direction, and distance-display window stay
      // coherent across the line.
      //   x: disableDepthTestDistance (raw meters; squared in shader)
      //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
      //   z: distanceDisplayCondition.near^2
      //   w: distanceDisplayCondition.far^2
      segmentData[offset + 20] = encodeDisableDepthTestDistance(
        polyline._disableDepthTestDistance,
      );
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

      // translucencyByDistance uses 1.0 as the multiplicative alpha identity.
      // Polyline does not expose pixelOffset or per-quad scale, so the other two
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
function buildPickSegmentData(collection, context, frameState, modelMatrix) {
  const polylines = collection._polylines;
  const length = collection._polylines.length;

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

    // One pick ID is shared by all segments of a polyline. `Polyline.getPickId`
    // preserves WebGL's `"polyline"` kind and registers the wrapper shape
    // `{ primitive, collection, id }`. Registering the bare polyline instead
    // would expose undefined `.primitive`, `.collection`, and `.id` properties
    // to user code.
    const pc = polyline.getPickId(context).color;

    const segLimit = loopClose ? positions.length : positions.length - 1;
    for (let j = 0; j < segLimit; j++) {
      const offset = segmentCount * FLOATS_PER_SEGMENT;
      // The pick path mirrors the color path's projected encoding so picked
      // regions land on the same screen pixels in 2D, Columbus View, and
      // morph modes.
      const projPickStart = projectPositionForMode(
        positions[j],
        frameState,
        modelMatrix,
        scratchActualStart,
      );
      const projPickEnd = projectPositionForMode(
        positions[(j + 1) % positions.length],
        frameState,
        modelMatrix,
        scratchActualEnd,
      );
      EncodedCartesian3.fromCartesian(projPickStart, scratchEncodedStart);
      EncodedCartesian3.fromCartesian(projPickEnd, scratchEncodedEnd);

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

      // The pick path applies the same depth override, split direction, and
      // distance gates as the color path so the picked region matches the
      // visible line.
      segmentData[offset + 20] = encodeDisableDepthTestDistance(
        polyline._disableDepthTestDistance,
      );
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
    // perInstanceFlags occupies the same slot in every polyline shader variant
    // so per-polyline depth, split, and distance-display state flows through
    // regardless of material type.
    { shaderLocation: 5, offset: 80, format: "float32x4" },
    // Per-polyline translucency-by-distance parameters.
    { shaderLocation: 6, offset: 96, format: "float32x4" },
  ],
};

/**
 * Defines the second vertex-buffer layout for the velocity pipeline. It uses
 * the same per-instance stride as the regular segment buffer because the
 * renderer keeps a one-frame-lagged mirror of that data. The velocity vertex
 * shader reads only the four position fields at locations 7-10, immediately
 * after the current shader's locations 0-6.
 *
 * Each polyline instance carries both a start and end position, so its
 * previous-frame data requires four vec4 slots instead of two.
 * @private
 */
const VELOCITY_PREV_SEGMENT_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_SEGMENT,
  stepMode: "instance",
  attributes: [
    // prevStartPosHighAndWidth at byte 0 — mirrors location 0.
    { shaderLocation: 7, offset: 0, format: "float32x4" },
    // prevStartPosLow at byte 16 — mirrors location 1.
    { shaderLocation: 8, offset: 16, format: "float32x4" },
    // prevEndPosHighAndMiter at byte 32 — mirrors location 2.
    { shaderLocation: 9, offset: 32, format: "float32x4" },
    // prevEndPosLow at byte 48 — mirrors location 3.
    { shaderLocation: 10, offset: 48, format: "float32x4" },
  ],
};

/**
 * Maps a material-type string to the `ShaderSourceId` it resolves to.
 * Used so the shader-module cache key stays stable even when callers
 * pass different source strings for the same material type.
 *
 * Render and velocity call sites pass the collection's public `material.type`
 * string ("PolylineDash", "PolylineGlow", "Color", …), not the lowercase
 * shader key used by this switch. Normalize through `selectShaderKey` first;
 * otherwise every material falls through to `POLYLINE_COLLECTION` and aliases
 * one module-cache id per `defines`. In a mixed collection that would serve the
 * first group's compiled module to all later groups, rendering Dash and Glow
 * lines with the solid Color shader. Single-material collections mask this
 * alias because no second shader competes for the same cache key.
 * @private
 */
function sourceIdForMaterialType(materialType) {
  const shaderKey = selectShaderKey(materialType);
  switch (shaderKey) {
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
// Label / Point through the shared base accessor.
const getPolylineShaderModuleCache = makeDeviceShaderModuleCacheAccessor();

/**
 * Scan the collection for the depth override, split, distance-display, and
 * translucency defines that apply this frame. Short-circuits once all four
 * bits are set.
 * Baseline (no features) stays the hot path.
 * @private
 */
function computePolylineDefinesForFrame(collection, frameState) {
  let defines = 0;
  // Enable renderer-wide log depth by adding the LOG_DEPTH bit when the master
  // switch and per-frame flag are on. The bit keys both the shader-module cache
  // and the pipeline maps and names, so the flip rebuilds
  // through the normal keyed-miss path. Inert while the switch defaults
  // false (defines unchanged, byte-identical shaders).
  if (isWebGPULogDepthActive(frameState?.context, frameState)) {
    defines |= ShaderDefine.LOG_DEPTH;
  }
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  const polylines = collection._polylines;
  const length = collection._polylines.length;
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
    // Distance-display and translucency-by-distance feature variants.
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
  // Prewarm the common distance-display and translucency-by-distance
  // variants. Polyline consumes four distance-related defines, but the
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
 * Builds the cache-friendly descriptor for a color polyline pipeline.
 *
 * Returns the descriptor plus the shared bind-group layouts so the caller can
 * build bind groups. The pipeline resolver materializes the actual
 * `GPURenderPipeline`, normally through `WebGPURenderPipelineCache`.
 * @private
 */
function buildPolylineColorDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  label,
  defines,
  sampleCount,
  noDepthTest,
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
    name: `${label || "Polyline pipeline"} [${format}/${depthFormat}/defines=0x${defines.toString(16)}/ms=${sampleCount ?? 1}/ndt=${noDepthTest ? 1 : 0}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Target the scene framebuffer through the shared helper. Standard
      // alpha-over blend matches the helper's
      // `translucent: true` shorthand exactly.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    // Honor the collection's `depthTest.enabled` state. WebGL's
    // PolylineCollection sets `useDepthTest = frameState.morphTime !== 0.0`,
    // so in 2D and Columbus View (both
    // morphTime === 0) the polyline renders with depth testing and depth
    // writes disabled. This draws it over the coplanar flat map instead of
    // z-fighting or being truncated by the map surface. `always` plus no
    // depth write matches the WebGL path.
    depthStencil: noDepthTest
      ? {
          format: depthFormat,
          depthWriteEnabled: false,
          depthCompare: "always",
        }
      : {
          format: depthFormat,
          depthWriteEnabled: true,
          depthCompare: "less-equal",
        },
    // Match the scene-framebuffer MSAA sample count; see
    // WebGPUBillboardRenderer for the rationale.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  return { descriptor, cameraBindGroupLayout, materialBindGroupLayout };
}

/**
 * Builds the polyline velocity-pipeline descriptor. It uses the same shader
 * module and pipeline layout as the regular polyline pipeline; the fragment
 * entry is `fragmentVelocityMain` and the target format is `rg16float` (the
 * scene-framebuffer velocity texture format). Depth is read-only so fragments
 * behind opaque geometry fail the depth test. Mirrors
 * `buildBillboardVelocityDescriptor`.
 * @private
 */
function buildPolylineVelocityDescriptor(
  device,
  shaderModule,
  depthFormat,
  defines,
) {
  const cameraBindGroupLayout = makeBindGroupLayout(
    device,
    "Polyline velocity camera BGL",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );
  const descriptor = {
    name: `Polyline velocity pipeline [${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cameraBindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMain",
      buffers: [SEGMENT_BUFFER_LAYOUT, VELOCITY_PREV_SEGMENT_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };
  return { descriptor, cameraBindGroupLayout };
}

/**
 * Builds the cache-friendly descriptor for a pick polyline pipeline. Pick is
 * camera-only: pick color comes from instance data, so no material uniform
 * buffer or second bind-group layout is needed.
 *
 * The pipeline resolver materializes the pipeline from this descriptor.
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

  // Shader-module identity and the defines mask distinguish the LOG_DEPTH
  // variant structurally. Append an explicit `[ld]` suffix so cache
  // descriptions and diagnostics identify logarithmic and hyperbolic pick
  // pipelines at a glance.
  const ldSuffix = defines & ShaderDefine.LOG_DEPTH ? " [ld]" : "";
  const descriptor = {
    name: `Polyline pick pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}${ldSuffix}]`,
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
      // Nearer pick producers back-clip farther ones in the shared pick
      // framebuffer. The logarithmic frag_depth write therefore composes with
      // the rest of the pick pass while preserving depth writes.
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
 * Pipeline resolution is centralized here so color and pick entries share the
 * same asynchronous and synchronous fallback behavior.
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
  // Contexts without a central cache require direct synchronous creation.
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

  // Split the camera position into high/low components in the same coordinate
  // frame as the vertices: model space when the collection's modelMatrix is
  // non-identity.
  //
  // This also applies to 2D, Columbus View, and morph modes without
  // reprojecting the camera.
  // `camera.positionWC` in 2D/CV is already expressed in the projected
  // `.zxy` frame (x = height above the map, y = easting, z = northing),
  // the same frame `computeActualEllipsoidPosition` produces for the
  // segment positions and that `czm_encodedCameraPositionMC` (=
  // `inverseModel * positionWC`) uses on the WebGL path. Re-projecting it
  // through `computeActualEllipsoidPosition` would double-project and
  // throw the lines off-anchor by thousands of km.
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
  // Pack the renderer-wide log-depth encode frustum (near and far) plus
  // oneOverLog2FarDepthFromNearPlusOne into the
  // reserved lanes. Same source every producer uses
  // (uniformState.currentFrustum at scene-update time); unconditional —
  // only the LOG_DEPTH shader variant reads them.
  //
  // Prefer the stashed full-frustum encode (`_logDepthEncodeNearFar`) over the
  // live per-slice `currentFrustum`. The globe packs its log-depth uniform once
  // during scene update and reuses it across slices, while 2D, Columbus View,
  // and morph modes repack this collection for each slice. Reading the live
  // slice would encode the polyline with different near/far planes, causing
  // its frag_depth to fail against the globe and truncate the line.
  const ldEncode = uniformState._logDepthEncodeNearFar;
  const ldFrustum = uniformState.currentFrustum;
  let ldNear = ldFrustum ? ldFrustum.x : 0.0;
  let ldFar = ldFrustum ? ldFrustum.y : 0.0;
  let ldFactor =
    typeof uniformState.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? uniformState.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  if (ldEncode && ldEncode[1] > ldEncode[0]) {
    ldNear = ldEncode[0];
    ldFar = ldEncode[1];
    const ldLog2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = ldLog2Far > 0.0 ? 1.0 / ldLog2Far : 0.0;
  } else if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const ldLog2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = ldLog2Far > 0.0 ? 1.0 / ldLog2Far : 0.0;
  }
  // Log-depth encode frustum at float slots 26 and 27.
  uniformData[26] = ldNear;
  uniformData[27] = ldFar;

  // Frame-wide fallback threshold in meters; the shader squares it.
  uniformData[28] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;

  // Split cutoff in framebuffer pixels. WebGL's `czm_splitPosition`
  // convention: `frameState.splitPosition` is the fraction [0, 1] and we
  // upload `fraction * drawingBufferWidth` so the fragment compare sits in
  // the same pixel coord space as WGSL's `@builtin(position).x`.
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[29] = splitFraction * drawingBufferWidth;
  // Log-depth factor at float slot 30.
  uniformData[30] = ldFactor;
  uniformData[31] = 0.0;

  // previousViewProjection occupies slots 32..47 (16 floats, 64 bytes).
  // `UniformState.update()` caches it before overwriting the
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

// Material data comes from MaterialUniformBuffer.gpuData. The camera UBO is
// group(0), and the material UBO is group(1). The base "Color" type uses a
// 16-byte placeholder because it has no material uniforms.

// =========================================================================
// Pipeline cache helpers
// =========================================================================

/**
 * Gets or creates a pipeline cache entry for the given (material type,
 * defines) tuple. Each entry is a `{ descriptor, pipeline, pending,
 * cameraBindGroupLayout, materialBindGroupLayout }` slot. The pipeline is
 * normally materialized by `WebGPURenderPipelineCache`, allowing two
 * collections with identical (materialType, defines) to share one
 * `GPURenderPipeline`.
 *
 * The returned slot keeps `pipeline` nullable until the resolver materializes
 * it while exposing both bind-group layouts immediately.
 * @private
 */
function getOrCreatePolylinePipelineEntry(
  cache,
  device,
  context,
  materialType,
  defines,
  noDepthTest,
) {
  if (!defined(cache.pipelines)) {
    cache.pipelines = {};
  }

  // Invalidate color and velocity pipelines when the scene format changes,
  // such as an HDR toggle. The polyline cache nests Map-by-defines under each
  // materialType key, so we drop the entire materialType-keyed object
  // and rebuild empty maps on next access.
  // The velocity cache must also rebuild against the current scene format.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.pipelines = {};
    cache.pickPipelines = undefined;
    cache.velocityPipelines = undefined;
    cache._pipelineFormatGeneration = sceneGen;
  }

  let byDefines = cache.pipelines[materialType];
  if (!defined(byDefines)) {
    byDefines = new Map();
    cache.pipelines[materialType] = byDefines;
  }
  // The depth-test state (on in 3D and mid-morph, off in settled 2D and
  // Columbus View) is part of the
  // pipeline, so it has to key the cache alongside `defines`. Compose a
  // string key so a 3D→2D flip resolves a distinct pipeline rather than
  // reusing the depth-testing one.
  const pipelineKey = `${defines}|${noDepthTest ? 1 : 0}`;
  if (byDefines.has(pipelineKey)) {
    return byDefines.get(pipelineKey);
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
  const sampleCount = context._msaaSamples ?? 1;
  const built = buildPolylineColorDescriptor(
    device,
    shaderModule,
    format,
    depthFmt,
    label,
    defines,
    sampleCount,
    noDepthTest,
  );

  const entry = {
    descriptor: built.descriptor,
    pipeline: null,
    pending: false,
    cameraBindGroupLayout: built.cameraBindGroupLayout,
    materialBindGroupLayout: built.materialBindGroupLayout,
    // Non-LOG_DEPTH preprocessed source for the OIT
    // accumulation variant (depth-read-only pass; frag_depth stripped). One per
    // (materialType, defines) pipeline; read only while OIT is active.
    oitShaderCode: preprocessShaderSource(
      shaderCode,
      defines & ~ShaderDefine.LOG_DEPTH,
    ),
  };

  byDefines.set(pipelineKey, entry);
  return entry;
}

/**
 * Gets or creates the velocity pipeline entry for the given (material,
 * defines) tuple. Lazily populated only when TAA is enabled this
 * frame; static scenes never construct a velocity pipeline. The
 * cache is keyed identically to the regular pipeline cache so a
 * polyline collection's color and velocity pipelines stay in lockstep.
 *
 * Only the base PolylineCollection shader exposes
 * `vertexVelocityMain` / `fragmentVelocityMain`. The PolylineArrow /
 * PolylineDash / PolylineGlow / PolylineOutline material variants
 * don't have velocity entry points yet, so velocity emission is
 * skipped for those materials, with camera-only TAA as the fallback. Material
 * velocity requires corresponding entry points before this gate can expand.
 * The gate therefore admits exactly the material types `selectShaderKey`
 * routes to `"polylineColor"` — `Color`, plus any type with no dedicated
 * material shader (`Image`, `DiffuseMap`), which the color pass already draws
 * with that same module.
 * @private
 */
function getOrCreatePolylineVelocityPipelineEntry(
  cache,
  device,
  context,
  materialType,
  defines,
) {
  // Velocity entries exist only on the base `PolylineCollection.wgsl` module —
  // the module `selectShaderKey` resolves the `Color` type, and every type this
  // renderer has no dedicated material shader for, to.
  //
  // `materialType` is the collection's PUBLIC `Material.type` ("Color",
  // "PolylineDash", "Image", …). `"polylineColor"` is the lowercase SHADER KEY
  // this file's own `MATERIAL_SHADER_KEYS` maps `Color` onto, and is never a
  // `Material.type` — so comparing the two directly made this gate true for
  // every material, and no polyline ever emitted a motion vector. Resolve the
  // key first, exactly as the module lookup below does.
  if (selectShaderKey(materialType) !== "polylineColor") {
    return null;
  }
  if (!defined(cache.velocityPipelines)) {
    cache.velocityPipelines = {};
  }
  let byDefines = cache.velocityPipelines[materialType];
  if (!defined(byDefines)) {
    byDefines = new Map();
    cache.velocityPipelines[materialType] = byDefines;
  }
  if (byDefines.has(defines)) {
    return byDefines.get(defines);
  }
  const shaderKey = selectShaderKey(materialType);
  const shaderCode = getCollectionShaderSource(shaderKey);
  const depthFmt = context.depthFormat || "depth24plus-stencil8";
  const label = `Polyline ${materialType} velocity`;
  const moduleCache = getPolylineShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    sourceIdForMaterialType(materialType),
    shaderCode,
    defines,
    label,
  );
  const built = buildPolylineVelocityDescriptor(
    device,
    shaderModule,
    depthFmt,
    defines,
  );
  const entry = {
    descriptor: built.descriptor,
    pipeline: null,
    pending: false,
    // The velocity pipeline builds its own `cameraBindGroupLayout` so
    // the dispatch site can create a dedicated bind group against it
    // (rather than reusing the color pipeline's bind group, which was
    // built against a structurally-equivalent but distinct layout
    // object). Mirrors the existing pick pipeline pattern in this
    // file.
    cameraBindGroupLayout: built.cameraBindGroupLayout,
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
  const length = collection._polylines.length;
  if (length === 0) {
    return;
  }

  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }

  // Re-entry and infinite-loop guard around the whole asynchronous update. The
  // polyline update is awaited per material group; `beginCollectionFrame`
  // counts overlapping in-flight entries and `console.error`s (throttled)
  // only on a runaway recursive re-enqueue. The `finally` always settles the
  // depth even if the inner update rejects.
  beginCollectionFrame(collection._webgpuCache, "PolylineCollection");
  try {
    await _updateWebGPUPolylinesInner(collection, frameState, commandList);
  } finally {
    endCollectionFrame(collection._webgpuCache);
  }
}

async function _updateWebGPUPolylinesInner(
  collection,
  frameState,
  commandList,
) {
  const context = frameState.context;
  const device = context.device;

  const cache = collection._webgpuCache;
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;

  // Polyline consumes distance-display and translucency-by-distance gates. It
  // has no pixel offset or quad scale, so the corresponding gates do not apply.

  // Prewarm all (material × defines) shader modules on first render per
  // device so the hot path doesn't pay for `createShaderModule` cost.
  prewarmPolylineShaders(device);

  // Compute the feature-defines bitmask for this frame. One bit is set per
  // feature that any polyline in the collection activates (or
  // the frame-wide `minimumDisableDepthTestDistance` is non-zero).
  const defines = computePolylineDefinesForFrame(collection, frameState);
  cache.currentDefines = defines;

  // Mirror WebGL's `useDepthTest = frameState.morphTime !== 0.0`.
  // In settled 2D + Columbus View (morphTime === 0) the polyline draws on
  // top of the flat map without a depth test; in 3D and mid-morph it depth-tests
  // normally. Keys the pipeline cache so the 3D pipeline stays byte-identical.
  // `computeNoDepthTest` provides the shared coplanar-depth flag and returns
  // `morphTime === 0 && mode !== SCENE3D`. Settled 3D reports
  // `morphTime === 1.0`, keeping the intent consistent across collection types.
  const noDepthTest = computeNoDepthTest(frameState);
  cache.currentNoDepthTest = noDepthTest;

  // Group by exact material identity, EXCEPT base Color-type materials which
  // group by type (per-instance colored; the Color shader ignores the material
  // UBO, so N solid-color polylines batch into one draw). Distinct instances
  // of the UBO-consuming shader types carry different uniforms and therefore
  // cannot share one UBO or segment draw. Pipeline compilation remains shared
  // by materialType.
  const groups = groupByMaterialType(
    collection,
    (cache.materialGroups ??= new Map()),
  );
  const activeMaterialResourceKeys = (cache.activeMaterialResourceKeys ??=
    new Set());
  activeMaterialResourceKeys.clear();
  const materialTypeFrameToken = (cache.materialTypeFrameToken ?? 0) + 1;
  cache.materialTypeFrameToken = materialTypeFrameToken;
  const materialResourceFrameNumber = Number.isFinite(frameState.frameNumber)
    ? frameState.frameNumber
    : materialTypeFrameToken;

  for (const group of groups.values()) {
    const materialType = group.materialType;
    const materialResourceKey = getMaterialResourceKey(
      cache,
      materialType,
      group.material,
    );
    activeMaterialResourceKeys.add(materialResourceKey);
    const typeFrameResources = prepareMaterialTypeFrameResources(
      cache,
      device,
      context,
      materialType,
      defines,
      noDepthTest,
      frameState,
      modelMatrix,
      materialTypeFrameToken,
    );
    if (!defined(typeFrameResources)) {
      // Pipeline still materializing async — skip this material group's
      // draw for this frame; subsequent frames pick it up via getPipelineSync.
      continue;
    }
    const pipelineResult = typeFrameResources.pipelineResult;
    const cameraBuffer = typeFrameResources.cameraBuffer;
    const camBgKey = typeFrameResources.camBgKey;
    const cameraResolver = typeFrameResources.cameraResolver;

    // Material uniform buffer — sourced from MaterialUniformBuffer.gpuData
    const matKey = `materialBuffer_${materialResourceKey}`;
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
      cache[`materialUploadState_${materialResourceKey}`] =
        createMaterialUploadState();
      cache[`matBindGroup_${materialResourceKey}`] = null; // force rebind
    }

    if (defined(matGpuData)) {
      const uploadStateKey = `materialUploadState_${materialResourceKey}`;
      cache[uploadStateKey] ??= createMaterialUploadState();
      if (defined(matUB)) {
        uploadMaterialUniformBuffer(
          device,
          cache[matKey],
          matUB,
          cache[uploadStateKey],
        );
      } else {
        device.queue.writeBuffer(cache[matKey], 0, matGpuData);
      }
    } else {
      device.queue.writeBuffer(
        cache[matKey],
        0,
        new Float32Array(matByteSize / 4),
      );
    }

    // Use one per-slice camera-uniform resolver per material type. Each group
    // keeps its own per-slice buffer pool, while `cache[camBgKey]` remains the
    // slice-zero or single-frustum fallback. The camera UBO is command group 0
    // and the material UBO is group 1, so the resolver replaces only the camera
    // group. `prepareMaterialTypeFrameResources` creates the resolver once per
    // frame for all exact-material groups of the same type.

    // Material bind group
    const matBgKey = `matBindGroup_${materialResourceKey}`;
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
      frameState,
      modelMatrix,
    );
    if (segmentCount === 0) {
      continue;
    }

    // Segment vertex buffer
    const sbKey = `segmentBuffer_${materialResourceKey}`;
    const requiredSize = segmentCount * BYTES_PER_SEGMENT;
    if (!defined(cache[sbKey]) || cache[sbKey].size < requiredSize) {
      if (defined(cache[sbKey])) {
        cache[sbKey].destroy();
      }
      cache[sbKey] = WebGPUBuffer.createVertexBuffer(
        device,
        requiredSize,
        false,
        `Polyline ${materialType} segments`,
      );
    }

    // Before overwriting the GPU segment buffer with this frame's data,
    // upload the previous frame's data to the previous-segment buffer so
    // the velocity VS reads both streams at slot 0 and slot 1. Mirrors
    // the Billboard and Label pattern.
    const taaEnabledThisFrame = frameState.taaEnabled === true;
    const prevSbKey = `prevSegmentBuffer_${materialResourceKey}`;
    const prevDataKey = `prevSegmentData_${materialResourceKey}`;
    if (taaEnabledThisFrame || defined(cache[prevSbKey])) {
      if (!defined(cache[prevSbKey]) || cache[prevSbKey].size < requiredSize) {
        if (defined(cache[prevSbKey])) {
          cache[prevSbKey].destroy();
        }
        cache[prevSbKey] = WebGPUBuffer.createVertexBuffer(
          device,
          requiredSize,
          false,
          `Polyline ${materialType} prev segments`,
        );
      }
      const prevSource = cache[prevDataKey] ?? segmentData;
      let prevPayload = prevSource;
      const expectedFloats = segmentCount * FLOATS_PER_SEGMENT;
      if (prevSource.length < expectedFloats) {
        prevPayload = new Float32Array(expectedFloats);
        prevPayload.set(prevSource);
        prevPayload.set(
          segmentData.subarray(prevSource.length, expectedFloats),
          prevSource.length,
        );
      } else if (prevSource.length > expectedFloats) {
        prevPayload = prevSource.subarray(0, expectedFloats);
      }
      device.queue.writeBuffer(
        cache[prevSbKey].buffer,
        0,
        prevPayload.buffer,
        prevPayload.byteOffset,
        requiredSize,
      );
    }

    device.queue.writeBuffer(
      cache[sbKey].buffer,
      0,
      segmentData.buffer,
      0,
      requiredSize,
    );

    // Stash this frame's data so next frame's velocity pass has prev
    // available. Always done — even when TAA is off — so a TAA off → on
    // transition doesn't lose a frame of history.
    cache[prevDataKey] = segmentData;

    // Create the color draw command. Pass routing follows WebGL's collapsed-bin
    // contract below, while render-state and OIT choices remain keyed by the
    // collection's blend option.
    if (frameState.passes.render) {
      // The segment vertex buffer must be live at the render-pass boundary.
      if (!validateDrawTargets([cache[sbKey]], "PolylineCollection")) {
        continue;
      }
      // Clamp the instanced draw to what the segment buffer
      // holds (`BYTES_PER_SEGMENT`/instance). The buffer was grown to
      // `segmentCount * BYTES_PER_SEGMENT` above, so this is inert on the
      // happy path; it guards against a drift between `segmentCount` and the
      // last grow.
      const safeSegmentCount = validateInstancedDrawBuffer(
        cache[sbKey],
        segmentCount,
        BYTES_PER_SEGMENT,
        "PolylineCollection",
      );

      const polylineBlendOpt = collection._blendOption;
      // WebGL assigns each bucket's pass from material translucency, not from a
      // collection blend option. This renderer collapses WebGL's paired
      // opaque/translucent commands to one
      // blended draw, so the faithful single bin is `Pass.OPAQUE` for every
      // blend option; `BlendOption.TRANSLUCENT` also reaches that bin through
      // WebGL's `!opaqueAndTranslucent` branch. Moving the collapsed command to
      // `Pass.TRANSLUCENT` would also move it into back-to-front sorting and the
      // actual-near-frustum path, changing globe occlusion. Render-state and OIT
      // choices below must therefore use the blend option rather than this pass
      // bin. The contract is pinned by
      // Tools/visual-regression/collection-pass-routing.spec.mjs.
      const polylinePass = Pass.OPAQUE;
      // Forward PolylineCollection's matching `_opaqueRS` or `_translucentRS`
      // render state, which the collection builds on demand. WebGL attaches
      // this state per command; without it, WebGPU uses encoder defaults
      // instead of the polyline-specific stencil, blend, and viewport
      // overrides. This selection keys off the blend option rather than the
      // pass bin. `PolylineCollection` exposes no blend option, so
      // `_blendOption` is permanently undefined and selects `_translucentRS`.
      const polylineRS =
        polylineBlendOpt === BlendOption.OPAQUE
          ? collection._opaqueRS
          : collection._translucentRS;
      const cmd = new WebGPUDrawCommand({
        pipeline: pipelineResult.pipeline,
        bindGroups: [cache[camBgKey], cache[matBgKey]],
        // Per-slice camera UBO at group 0; material group 1 is slice-invariant.
        bindGroupResolvers: [cameraResolver, undefined],
        vertexBuffers: [cache[sbKey]],
        vertexCount: VERTICES_PER_SEGMENT,
        instanceCount: safeSegmentCount,
        pass: polylinePass,
        owner: collection,
        boundingVolume: collection._boundingVolume,
        modelMatrix: modelMatrix,
        sortLayer: collection._commandOrdering.sortLayer,
        sortPriority: collection._commandOrdering.sortPriority,
        materialSortId: collection._commandOrdering.materialSortId,
        cull: true,
        renderState: polylineRS,
      });

      // Attach OIT inputs to blended polylines. The variant reuses the base
      // color pipeline's shared layout (camera and material bind-group layouts)
      // plus vertex, primitive, and depth state (single-sample for accumulation
      // targets). createOITPipeline forces depthWriteEnabled:false, so reusing
      // the base depthStencil (which may write depth on the 3D path) is safe.
      // When OIT is disabled or the command remains in Pass.OPAQUE, this metadata
      // is inert. The material fragment shader returns a `FragOutput` struct at
      // location 0, which the OIT output injector handles. Keeping the metadata
      // on blended collections supports a per-bucket translucency split.
      if (
        polylineBlendOpt !== BlendOption.OPAQUE &&
        defined(pipelineResult.descriptor) &&
        defined(pipelineResult.oitShaderCode)
      ) {
        cmd._shaderCode = pipelineResult.oitShaderCode;
        cmd._pipelineConfig = {
          label: "OIT Polyline",
          layout: pipelineResult.descriptor.layout,
          vertexBuffers: pipelineResult.descriptor.vertex.buffers,
          vertexEntryPoint: "vertexMain",
          fragmentEntryPoint: "fragmentMain",
          primitive: pipelineResult.descriptor.primitive,
          depthStencil: pipelineResult.descriptor.depthStencil,
          multisample: undefined,
        };
      }

      // Attach a velocity command only when TAA is on, the
      // material has a velocity entry point (currently base color
      // only), and the velocity pipeline resolved this tick. The TAA
      // pass walks `cmd.velocityCommand` and dispatches into the
      // rg16float velocity texture. Velocity uses only the camera
      // bind group (slot 0); the material BG is unused by the
      // velocity FS, so we omit it entirely from the velocity command.
      // Each velocity pipeline owns its own `cameraBindGroupLayout`,
      // so we build a dedicated `velCamBg` against that layout rather
      // than reusing the color pipeline's bind group (mirrors the
      // pick pattern in `_pushPolylinePickCommand`).
      if (taaEnabledThisFrame && defined(cache[prevSbKey])) {
        const velEntry = getOrCreatePolylineVelocityPipelineEntry(
          cache,
          device,
          context,
          materialType,
          defines,
        );
        const velocityPipeline = defined(velEntry)
          ? tryResolvePolylinePipeline(
              device,
              context.webgpuPipelineCache ?? null,
              velEntry,
            )
          : null;
        if (velocityPipeline) {
          const velCamBgKey = `velCamBindGroup_${materialType}`;
          if (!defined(cache[velCamBgKey])) {
            cache[velCamBgKey] = device.createBindGroup({
              layout: velEntry.cameraBindGroupLayout,
              entries: [
                { binding: 0, resource: { buffer: cameraBuffer.buffer } },
              ],
            });
          }
          cmd.velocityCommand = new WebGPUDrawCommand({
            pipeline: velocityPipeline,
            bindGroups: [cache[velCamBgKey]],
            vertexBuffers: [cache[sbKey], cache[prevSbKey]],
            vertexCount: VERTICES_PER_SEGMENT,
            instanceCount: safeSegmentCount,
            pass: polylinePass,
            owner: collection,
            boundingVolume: collection._boundingVolume,
            modelMatrix: modelMatrix,
            sortLayer: collection._commandOrdering.sortLayer,
            sortPriority: collection._commandOrdering.sortPriority,
            materialSortId: collection._commandOrdering.materialSortId,
            cull: true,
            renderState: polylineRS,
          });
        }
      }

      commandList.push(cmd);
    }
  }

  pruneInactiveMaterialResources(
    cache,
    activeMaterialResourceKeys,
    materialResourceFrameNumber,
  );

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

  // Consume dirty state after building the WebGPU segment data. This renderer
  // replaces the WebGL vertex-array build, and PolylineCollection.update()
  // returns to the FR before the WebGL clear path runs, so the per-polyline
  // _dirty flags, the _polylinesToUpdate queue, and _propertiesChanged are
  // never cleared on the FR path. Consume them now that segment data has been
  // built/grouped this frame — otherwise the shared scene logic and property
  // setters re-touch every settled polyline every frame and _polylinesToUpdate
  // grows unbounded. Mirrors the billboard/point consume call site.
  if (typeof collection._consumeDirtyState === "function") {
    collection._consumeDirtyState();
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

  // Mirror the color pipeline's feature defines so pick geometry matches
  // visible lines. `pickPipelines` maps each defines mask to
  // `{ descriptor, pipeline, pending, cameraBindGroupLayout }`; the central
  // `context.webgpuPipelineCache` materializes each GPU pipeline.
  //
  // Pick log depth is controlled independently from scene log depth. Remove
  // the scene's LOG_DEPTH bit and restore it only when
  // `isWebGPUPickLogDepthActive` is true. With pick log depth disabled, the
  // shader retains its baseline single `@location(0)` output and the shared
  // pick framebuffer remains uniformly hyperbolic. Both paths use
  // `packCameraUniforms`, whose slots 26-27 hold the near/far planes and slot
  // 30 holds the log-depth factor.
  const pickLogActive = isWebGPUPickLogDepthActive(context, frameState);
  const pickDefines =
    ((cache.currentDefines ?? 0) & ~ShaderDefine.LOG_DEPTH) |
    (pickLogActive ? ShaderDefine.LOG_DEPTH : 0);
  if (!defined(cache.pickPipelines)) {
    cache.pickPipelines = new Map();
  }
  let pickPipelineEntry = cache.pickPipelines.get(pickDefines);
  if (!defined(pickPipelineEntry)) {
    const pickShader = getCollectionShaderSource("polylinePick");
    // Match the pick framebuffer's byte object-ID format. The scene format may
    // be floating-point HDR and is not a valid pick target.
    const format = context.pickPipelineFormat || "rgba8unorm";
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

  const pickResult = buildPickSegmentData(
    collection,
    context,
    frameState,
    modelMatrix,
  );
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
      false,
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

  // Validate the pick segment buffer and clamp the instance count to its
  // capacity. The buffer was just grown to
  // `pickResult.segmentCount * BYTES_PER_SEGMENT`, so these checks are inert
  // unless allocation or count bookkeeping drifts.
  if (
    !validateDrawTargets([cache.pickSegmentBuffer], "PolylineCollection pick")
  ) {
    return;
  }
  const safePickSegmentCount = validateInstancedDrawBuffer(
    cache.pickSegmentBuffer,
    pickResult.segmentCount,
    BYTES_PER_SEGMENT,
    "PolylineCollection pick",
  );

  cache.pickCommand = new WebGPUDrawCommand({
    pipeline: cache.pickPipeline,
    bindGroups: [cache.pickCameraBindGroup],
    vertexBuffers: [cache.pickSegmentBuffer],
    vertexCount: VERTICES_PER_SEGMENT,
    instanceCount: safePickSegmentCount,
    pass: Pass.OPAQUE,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    sortLayer: collection._commandOrdering.sortLayer,
    sortPriority: collection._commandOrdering.sortPriority,
    materialSortId: collection._commandOrdering.materialSortId,
    cull: true,
    // Pick runs in OPAQUE pass — mirror WebGL behavior by using the
    // opaque render state (depth-test on, depth-write on, no blending
    // relevant to pick IDs). Falls back to translucent state for
    // TRANSLUCENT-only collections.
    renderState: collection._opaqueRS ?? collection._translucentRS,
    // Mark this command for execution only by the pick path.
    pickOnly: true,
  });

  commandList.push(cache.pickCommand);
}

function destroyWebGPUPolylineResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }

  // Destroy per-material segment buffers, their previous-frame motion-vector
  // buffers, and their camera and material uniform buffers.
  for (const key of Object.keys(cache)) {
    if (
      key.startsWith("segmentBuffer_") ||
      key.startsWith("prevSegmentBuffer_") ||
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

export {
  MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES,
  updateWebGPUPolylines,
  destroyWebGPUPolylineResources,
  groupByMaterialType,
  prepareMaterialTypeFrameResources,
  pruneInactiveMaterialResources,
};
export default { updateWebGPUPolylines, destroyWebGPUPolylineResources };
