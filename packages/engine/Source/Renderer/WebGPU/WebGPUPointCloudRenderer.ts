/**
 * WebGPU Point Cloud Renderer
 *
 * Renders point cloud data (LiDAR, photogrammetry) using instanced quads.
 * Supports per-point color, position splitting for RTE precision,
 * size attenuation, and optional normal-based lighting.
 *
 * @module WebGPUPointCloudRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import BoundingSphere from "../../Core/BoundingSphere.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { gpuData } from "./webgpuTypeHelpers.js";
import type { WebGPUPointCloudLODProcessorInstance } from "./WebGPUPointCloudLODProcessor.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
import { getOrCreateSharedAdvancedEffectsBG } from "./WebGPUPrimitiveCommands.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
// Scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { getAvailableFrameCommandEncoder } from "./WebGPUFrameCommandEncoder.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import { unpackPointCloudColor } from "../../Scene/PointCloudAttributeUtils.js";
import {
  createPointCloudRteHistory,
  updatePointCloudRteHistory,
} from "./WebGPUPointCloudRteHistory.js";
import { getWebGPUPointCloudSharedLayouts } from "./WebGPUPointCloudSharedLayouts.js";
import { updatePointCloudLodLocalFrame } from "./WebGPUPointCloudLodLocalFrame.js";

// Per-device shader module cache so multiple PointClouds on the same
// `GPUDevice` share one compiled `GPUShaderModule` per source.
const _pointCloudShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

/** Record a point-cloud buffer copy on the frame encoder when available. */
function copyPointCloudBuffer(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  label: string,
  source: GPUBuffer,
  destination: GPUBuffer,
  size: number,
): void {
  const frameEncoder = getAvailableFrameCommandEncoder(context);
  const encoder =
    frameEncoder ?? device.createCommandEncoder({ label: `${label} (orphan)` });
  encoder.copyBufferToBuffer(source, 0, destination, 0, size);
  if (!frameEncoder) {
    device.queue.submit([encoder.finish()]);
  }
}

function getPointCloudShaderModuleCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _pointCloudShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _pointCloudShaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Narrowed view of the CesiumJS `PointCloud` shape that this renderer
 * actually touches. The upstream type uses a generic index signature
 * (`[key: string]: unknown`) which makes arithmetic + property access
 * fail TypeScript's strict checks. Declaring the specific fields here
 * keeps the strict index signature in place for any fields we DON'T
 * reference while letting hot-path code compile without inline casts.
 *
 * Kept local to this file — callers elsewhere in the engine shouldn't
 * need to know about LOD internals.
 */
/**
 * Shape of the parsed-content blob produced by Cesium's point cloud
 * loader (PntsParser / 3D Tiles Point Cloud). Both layouts — raw LAS
 * and 3D Tiles tiles — populate the same fields, so this single shape
 * covers both loader paths. Declared separately so the interleaved
 * accesses in `buildInstanceBuffer` type-check as arrays of the right
 * numeric shape.
 */
interface PointCloudParsedContent {
  positions?:
    | ArrayLike<number>
    | {
        typedArray?: ArrayLike<number>;
        isQuantized?: boolean;
        quantizedVolumeScale?: { x: number; y: number; z: number };
        quantizedVolumeOffset?: { x: number; y: number; z: number };
        quantizedRange?: number;
      };
  colors?:
    | ArrayLike<number>
    | {
        typedArray?: ArrayLike<number>;
        componentDatatype?: number;
        componentCount?: number;
        isRGB565?: boolean;
        constantColor?: {
          red: number;
          green: number;
          blue: number;
          alpha: number;
        };
      };
  rtcCenter?: CesiumCartesian3;
}

interface PointCloudLike {
  _webgpuCache?: CesiumOpaqueObject | PointCloudCache | undefined;
  _parsedContent?: PointCloudParsedContent;
  _pointCloud?: { _parsedContent?: PointCloudParsedContent };
  _pointsLength?: number;
  enableGPULOD?: boolean;
  modelMatrix?: CesiumMatrix4;
  geometricError?: number;
  /** Cull beyond this world distance; undefined uses camera far, while 0 is a Float32-safe disable sentinel. */
  lodFarDistance?: number;
  // WebGL attenuation parity inputs (PointCloud.js).
  attenuation?: boolean;
  geometricErrorScale?: number;
  // True when a constant style pointSize is active — WebGL gives the style
  // priority over attenuation, so the attenuation clamp must be disabled.
  _webgpuStylePointSizeActive?: boolean;
  _webgpuPointSize?: number;
  _isRGB565?: boolean;
  _isTranslucent?: boolean;
  _constantColor?: { red: number; green: number; blue: number; alpha: number };
  _highlightColor?: { red: number; green: number; blue: number; alpha: number };
  _opaquePass?: number;
  _cull?: boolean;
  _webgpuLocalBoundingSphere?: CesiumBoundingSphere;
  _boundingSphere?: CesiumBoundingSphere;
  boundingSphere?: CesiumBoundingSphere;
  // Allow pass-through for anything else the buildInstanceBuffer /
  // frustum extraction paths read — keeps the typed surface minimal
  // while preserving the upstream escape hatch.
  [key: string]: unknown;
}

interface PointCloudPipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
  error?: unknown;
  errorReported?: boolean;
}

interface PointCloudCache {
  /** Exact GPU-resource ownership tuple; invalidated on device recovery. */
  context: CesiumGraphicsContext;
  device: GPUDevice;
  resourceGeneration: number;
  sharedLayouts: ReturnType<typeof getWebGPUPointCloudSharedLayouts>;
  rteHistory: ReturnType<typeof createPointCloudRteHistory>;
  uniformScratch: Float32Array;
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  instanceAllowsStorage: boolean;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  translucent: boolean;
  lastRevision: number;

  // Default-path pipeline resolves through `webgpuPipelineCache`; the entry
  // slot holds the descriptor + the in-flight tracking flag. Two PointCloud
  // instances sharing the same canvas format now share a single pipeline.
  pipelineEntry: PointCloudPipelineEntry | null;
  defaultBgl: GPUBindGroupLayout | null;

  // ── GPU LOD path (opt-in when pointCloud.enableGPULOD === true) ──
  //
  // Compiled lazily on first frame the flag is true. The LOD pipeline
  // reads instance data from a storage buffer (same bytes as the VB
  // path above — we back them with the same GPUBuffer but add STORAGE
  // usage) and looks up the actual instance via `visibleIndices[iidx]`.
  // `instanceCountBuffer` is a 16-byte indirect draw arg buffer that
  // the LOD processor's visibleCount is copied into each frame.
  lodPipeline: GPURenderPipeline | null;
  lodProcessor: WebGPUPointCloudLODProcessorInstance | null;
  lodProcessorPromise: Promise<WebGPUPointCloudLODProcessorInstance> | null;
  lodProcessorFailed: boolean;
  lodBindGroupLayout: GPUBindGroupLayout | null;
  lodStorageBindGroup: GPUBindGroup | null;
  lodIndirectBuffer: GPUBuffer | null;
  lodPositionsX: Float32Array | null;
  lodPositionsY: Float32Array | null;
  lodPositionsZ: Float32Array | null;
  /** Reused local-space culling inputs; model motion only rewrites params. */
  lodFrustumPlanes: Float32Array;
  lodCameraPositionLocal: [number, number, number];
  lodModelLinear: Float32Array;
  lodRtcCenter: Cartesian3;
  lodUploadedRevision: number;
  lodCommand: CesiumAnyDrawCommand | null;
  lodActive: boolean;
  defaultEdlSource: PointCloudEDLSource | null;
  lodEdlSource: PointCloudEDLSource | null;

  // Same pattern for the LOD pipeline. Held alongside the LOD pipeline slot so
  // the resolve helper can re-resolve every frame until the pipeline
  // materializes.
  lodPipelineEntry: PointCloudPipelineEntry | null;
  lodDefaultBgl: GPUBindGroupLayout | null;

  // Per-particle prev-position mirror of `instanceBuffer` so the velocity VS
  // reads (current, previous) position pairs from two parallel 40-byte instance
  // streams. Same lifecycle as PointPrimitive's `prevInstanceBuffer`: captured
  // before the GPU instance upload, retained one-frame-lagged. NULL when no
  // animated point cloud has been seen on this device yet (TAA off-path stays
  // cheap).
  prevInstanceBuffer: GPUBuffer | null;
  // CPU-side reference to THIS frame's instance data — the
  // interleaved Float32Array `buildInstanceBuffer` produced. Set on
  // every revision-change rebuild. Per-frame the velocity helper uses
  // this as the source for "what becomes prev next frame" (it does
  // NOT upload from this directly — the GPU `instanceBuffer` already
  // carries it).
  instanceData: Float32Array | null;
  // CPU-side reference to the PREVIOUS frame's instance data. On the
  // first frame this is null; the velocity helper seeds it from
  // `instanceData` so velocity = 0 at startup. After every successful
  // velocity dispatch, the helper assigns `prevInstanceData =
  // instanceData` so next frame's prev tracks the PREVIOUS frame's
  // data (the PointPrimitive velocity pattern). For the typical static
  // 3D-Tiles point cloud both refs point at the same Float32Array so
  // velocity stays zero; for animated content where each frame
  // re-runs `buildInstanceBuffer`, this captures the actual per-frame
  // delta.
  prevInstanceData: Float32Array | null;
  // Lazy velocity pipeline. Builds the first frame TAA is on; cached
  // thereafter. Cleared on format invalidation.
  velocityPipelineEntry: PointCloudPipelineEntry | null;
  velocityCommand: CesiumAnyDrawCommand | null;

  // LOD-path parallel storage buffer mirroring `instanceBuffer` with the
  // PREVIOUS frame's interleaved data. Same 40-byte stride; only positions
  // (floats 0-5) are read by the LOD velocity VS.
  lodPrevInstanceBuffer: GPUBuffer | null;
  // Lazy LOD velocity pipeline. Has its own descriptor (storageBGL
  // includes binding 2 for prev SSBO; the regular LOD pipeline only
  // declares bindings 0-1, so a different BGL is needed). Resolved on
  // the first LOD-active TAA frame.
  lodVelocityPipelineEntry: PointCloudPipelineEntry | null;
  lodVelocityCommand: CesiumAnyDrawCommand | null;
  lodVelocityBindGroup: GPUBindGroup | null;
  lodVelocityStorageBGL: GPUBindGroupLayout | null;

  // Monotonic counter bumped at every site that (re)writes `instanceBuffer`
  // CONTENT (the single rebuild site — the LOD path only uploads positions to
  // the LOD processor's own buffers, never `instanceBuffer`). `pointCount`
  // alone is an insufficient content-change signal (two static clouds could
  // share a count, and a count that returns to a prior value would alias), so a
  // dedicated monotonic counter is used. When the identity-case prev buffer
  // already holds this revision's bytes the per-frame CPU re-upload is skipped.
  instanceDataRevision: number;
  // The `instanceDataRevision` whose bytes currently reside in
  // `prevInstanceBuffer` (default VB path). `undefined` = unknown/stale →
  // re-seed. Reset to undefined on prev-buffer realloc (T-4).
  prevBufferRevision: number | undefined;
  // Same marker for the LOD storage-path prev buffer (`lodPrevInstanceBuffer`),
  // which has its own independent realloc lifecycle.
  lodPrevBufferRevision: number | undefined;
}

let nextPointCloudLodOwnerId = 1;

const POINT_CLOUD_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndAlpha: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointUV: vec2<f32>,
  // FEAT-GAP-09 (Batch 103 audit fix) — point-center RTE position
  // for the aerial-perspective fog block. Per-quad-vertex spread is
  // tiny (~point size in pixels) relative to fog scale.
  @location(2) worldPos: vec3<f32>,
  // C2-7 — interpolated linear depthFromNearPlusOne (point CENTER) for the
  // renderer-wide log-depth frag_depth write.
  @location(3) vLogDepth: f32,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  // POINT-SPRITE-SHAPE — WebGL attenuation parity. When > 0 this is
  // geometricError * geometricErrorScale * (drawingBufferHeight /
  // frustum.sseDenominator); per-point size becomes
  // min(attenuation / eyeDepth, bakedMaxSize) exactly like the WebGL
  // derived VS. 0 disables (2D / ortho / attenuation off) — the baked
  // per-point size is used as-is (formerly _pad2, layout unchanged).
  attenuation: f32,
  // Previous-frame point-cloud RTE snapshot. It is paired with the previous
  // model-space encoded camera at this struct's tail; no absolute f32 world
  // position participates in velocity reprojection.
  previousMvpRelativeToEye: mat4x4<f32>,
  // Current model matrix is retained for current-frame world-direction fog
  // inputs. Previous-frame velocity never reads it.
  modelMatrix: mat4x4<f32>,
  // C2-7 NEW-LOG-DEPTH-POINTCLOUD-PRODUCER. x=frustum near, y=frustum far,
  // z=oneOverLog2FarDepthFromNearPlusOne, w=useLogDepth flag (1.0 active,
  // 0.0 inert → byte-identical to the prior hyperbolic-z behavior).
  logDepth: vec4<f32>,
  // POINT-CLOUD-COLOR-FORMATS — public PointCloud.color multiplier. Keeping
  // this dynamic avoids rebuilding the immutable point-data buffer when an
  // application changes highlight color or alpha.
  highlightColor: vec4<f32>,
  previousEncodedCameraHigh: vec3<f32>,
  _pad3: f32,
  previousEncodedCameraLow: vec3<f32>,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// C2-7 — renderer-wide log depth (Approach A); mirrors PrimitiveBasicColor.wgsl.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var c = clipPosition;
  c.z = clamp(c.z / c.w, 0.0, 1.0) * c.w;
  return c;
}
fn csm_writeLogDepth(d: f32, factor: f32) -> f32 {
  return log2(d) * factor;
}

// FEAT-GAP-09 (Batch 103 audit fix; original Batch 102 modified the
// dead standalone Advanced/PointCloud.wgsl). Same EffectsUniforms
// truncation pattern as VOXEL_WGSL; aerial-LUT bindings at @group(1).
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
    atmosphereLutControl: vec4<f32>,
}
@group(1) @binding(0) var<uniform> effects: EffectsUniforms;
@group(1) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(1) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(1) @binding(9) var atmosphereLutSampler: sampler;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // POINT-SPRITE-SHAPE — WebGL attenuation parity:
  // gl_PointSize = min((u_geometricError / depth) * u_depthMultiplier,
  // u_pointSize). clipPos.w is the positive eye depth for a standard
  // perspective projection (= -positionEC.z in the WebGL VS).
  // The packed record's fourth color lane is true alpha. Point size is a
  // per-cloud value in this renderer, so it lives in the already-dynamic UBO.
  var pointSize = u.pointSizeMultiplier;
  if (u.attenuation > 0.0) {
    pointSize = min(u.attenuation / max(clipPos.w, 1.0e-6), pointSize);
  }
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndAlpha * u.highlightColor;
  output.pointUV = input.quadVertex;
  // FEAT-GAP-09 (Batch 103) — rotate/scale the model-relative RTE vector
  // into world space for the fog lookup. w=0 deliberately excludes the
  // translation already represented by the camera-relative subtraction.
  output.worldPos = (u.modelMatrix * vec4<f32>(posRTE, 0.0)).xyz;
  // C2-7 — log depth from the point CENTER (clipPos, not the spread corner);
  // clamp the final clip-z so the FS-written log depth isn't pre-empted.
  output.vLogDepth = csm_vertexLogDepth(clipPos, u.logDepth.x);
  if (u.logDepth.w > 0.5) {
    output.position = csm_updatePositionDepth(output.position);
  }
  return output;
}

struct FragOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOut {
  // POINT-SPRITE-SHAPE — WebGL gl_Points rasterize as SOLID SQUARES
  // (ModelFS.glsl only carves a circle under HAS_POINT_DIAMETER, the
  // Bentley point-style extension, which this path doesn't implement).
  // Fill the whole quad opaquely to match; pointUV stays in the
  // varying contract for a future round/point-style opt-in.
  var finalColor = input.color;

  // FEAT-GAP-09 (Batch 103) — Aerial-perspective fog blend.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    // The model-space camera feeds only LUT direction and altitude, where metre-scale f32 error is imperceptible.
    let cameraModel = u.encodedCameraHigh + u.encodedCameraLow;
    let cameraWC = (u.modelMatrix * vec4<f32>(cameraModel, 1.0)).xyz;
    let viewDirWS = normalize(input.worldPos);
    let upDir = normalize(cameraWC);
    let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
    let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
    let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
    let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);
    let tSample = textureSampleLevel(
      atmosphereTransmittanceLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let iSample = textureSampleLevel(
      atmosphereInscatterLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let transmittance =
      clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);
    let excessAltitude = max(0.0, cameraAltitude - thickness);
    let orbitFalloff = exp(-excessAltitude / thickness);
    let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
    finalColor = vec4<f32>(
      mix(finalColor.rgb, iSample.rgb, fogWeight),
      finalColor.a,
    );
    if (effects.atmosphereLutControl.w > 0.5) {
      finalColor = vec4<f32>(
        finalColor.rgb * mix(1.0, transmittance, fogWeight),
        finalColor.a,
      );
    }
  }

  // C2-7 — write renderer-wide log depth when active; otherwise reproduce the
  // rasterizer's interpolated hyperbolic z (byte-identical to before).
  var fragDepth = input.position.z;
  if (u.logDepth.w > 0.5) {
    fragDepth = csm_writeLogDepth(input.vLogDepth, u.logDepth.z);
  }
  return FragOut(finalColor, fragDepth);
}

// Batch 168 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity emission for
// animated point clouds. Mirrors the Batch 148 pattern from
// PointPrimitiveColor: rasterize the point quad at the CURRENT-frame
// position so the velocity texture covers the same pixels the color
// pass touched, then emit per-fragment (currNdc - prevNdc).
struct VelocityVertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndAlpha: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter.
  @location(4) prevPositionHigh: vec3<f32>,
  @location(5) prevPositionLow: vec3<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  @location(2) alpha: f32,
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  // Current-frame center clip via RTE (matches vertexMain math).
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Previous-frame center clip uses the previous model/camera RTE snapshot.
  // This remains precise at Earth scale and captures camera AND model motion.
  let prevPosRTE =
      (input.prevPositionHigh - u.previousEncodedCameraHigh)
    + (input.prevPositionLow - u.previousEncodedCameraLow);
  let prevCenterClip =
    u.previousMvpRelativeToEye * vec4<f32>(prevPosRTE, 1.0);
  // Rasterize quad at the current center using the existing pixel-size
  // expansion so the velocity texture covers the same screen pixels.
  // POINT-SPRITE-SHAPE — same attenuation clamp as vertexMain so the
  // velocity quad stays coverage-identical to the color quad.
  var pointSize = u.pointSizeMultiplier;
  if (u.attenuation > 0.0) {
    pointSize = min(u.attenuation / max(currCenterClip.w, 1.0e-6), pointSize);
  }
  let px = pointSize / u.viewportSize.x * currCenterClip.w;
  let py = pointSize / u.viewportSize.y * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  output.alpha = input.colorAndAlpha.a * u.highlightColor.a;
  return output;
}

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> @location(0) vec2<f32> {
  // Invisible source/highlight-alpha points must not write motion into TAA.
  if (input.alpha <= 0.0) {
    discard;
  }
  let curW = input.currCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = input.currCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

// GPU LOD variant of the point cloud shader. Identical math to the
// default path, but reads instance data from a storage buffer and
// looks up the actual source index via the LOD processor's compacted
// visibleIndices buffer. Activated by `pointCloud.enableGPULOD` when
// the point count is above POINT_COUNT_LOD_THRESHOLD.
//
// The storage buffer is the SAME 40-byte packed layout as the default
// path's vertex buffer (posHigh(12) + posLow(12) + color RGBA(16)).
// WGSL's `array<vec3<f32>>` would add 16-byte alignment padding that
// breaks that packing, so we declare the storage as `array<f32>` and
// index manually at 10 floats per instance. This lets us reuse the
// exact same GPUBuffer for both paths — `buildInstanceBuffer` only
// needs to OR in `STORAGE` usage when GPU LOD is potentially on.
const POINT_CLOUD_LOD_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointUV: vec2<f32>,
  // FEAT-GAP-09 (Batch 104) — point-center RTE position for the
  // aerial-perspective fog block.
  @location(2) worldPos: vec3<f32>,
  // C2-7 — interpolated linear depthFromNearPlusOne (point CENTER).
  @location(3) vLogDepth: f32,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  // POINT-SPRITE-SHAPE — attenuation scale; see the default-path
  // Uniforms comment (formerly _pad2, layout unchanged).
  attenuation: f32,
  previousMvpRelativeToEye: mat4x4<f32>,
  // Current-frame model matrix, used only for current fog/world directions.
  modelMatrix: mat4x4<f32>,
  // C2-7 NEW-LOG-DEPTH-POINTCLOUD-PRODUCER — x=near, y=far, z=factor,
  // w=useLogDepth flag. Matches the default-path UBO layout.
  logDepth: vec4<f32>,
  highlightColor: vec4<f32>,
  previousEncodedCameraHigh: vec3<f32>,
  _pad3: f32,
  previousEncodedCameraLow: vec3<f32>,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
// Storage declared as raw floats so the packed 40-byte VB layout
// works without WGSL's std430 struct padding. Indexing matches the
// layout that buildInstanceBuffer writes (10 floats per point).
@group(1) @binding(0) var<storage, read> instanceData: array<f32>;
@group(1) @binding(1) var<storage, read> visibleIndices: array<u32>;
// Batch 169 - B.10 NEW-ADVANCED-MOTION-VECTORS LOD variant. Parallel
// SSBO mirroring instanceData with the PREVIOUS frame's interleaved
// positions, indexed identically by visibleIndices[iidx]. Same
// 10-floats-per-point layout; only floats 0-5 (posHigh, posLow) are
// read by the velocity VS — color/alpha are ignored. Bound at slot 2
// alongside the regular LOD storage; the color pipeline doesn't
// declare this binding (WGSL only requires declared bindings, the
// BGL for both pipelines includes the slot).
@group(1) @binding(2) var<storage, read> prevInstanceData: array<f32>;

// FEAT-GAP-09 (Batch 104) — effects + aerial-LUT at @group(2) (the
// LOD pipeline already uses @group(0) for uniforms and @group(1) for
// storage buffers, so effects appends at slot 2). Same truncated
// EffectsUniforms shape as the default-path POINT_CLOUD_WGSL.
struct EffectsUniforms {
    shadowMatrix: mat4x4<f32>,
    shadowMapSize: vec2<f32>,
    shadowDarkness: f32,
    shadowSoftShadows: f32,
    clippingPlaneCount: u32,
    clippingUnionMode: u32,
    clippingEdgeWidth: f32,
    clippingPolygonCount: u32,
    clippingEdgeColor: vec4<f32>,
    clipPlaneEqHW: array<vec4<f32>, 8>,
    atmosphereLutControl: vec4<f32>,
}
@group(2) @binding(0) var<uniform> effects: EffectsUniforms;
@group(2) @binding(7) var atmosphereTransmittanceLut: texture_2d<f32>;
@group(2) @binding(8) var atmosphereInscatterLut: texture_2d<f32>;
@group(2) @binding(9) var atmosphereLutSampler: sampler;

// C2-7 — renderer-wide log depth (Approach A); mirrors PrimitiveBasicColor.wgsl.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var c = clipPosition;
  c.z = clamp(c.z / c.w, 0.0, 1.0) * c.w;
  return c;
}
fn csm_writeLogDepth(d: f32, factor: f32) -> f32 {
  return log2(d) * factor;
}

@vertex
fn vertexMainLOD(
  @builtin(instance_index) iidx: u32,
  @location(0) quadVertex: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  let actualIdx = visibleIndices[iidx];
  let base = actualIdx * 10u;
  let positionHigh = vec3<f32>(
    instanceData[base + 0u],
    instanceData[base + 1u],
    instanceData[base + 2u],
  );
  let positionLow = vec3<f32>(
    instanceData[base + 3u],
    instanceData[base + 4u],
    instanceData[base + 5u],
  );
  let color = vec4<f32>(
    instanceData[base + 6u],
    instanceData[base + 7u],
    instanceData[base + 8u],
    instanceData[base + 9u],
  );
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // POINT-SPRITE-SHAPE — WebGL attenuation parity (see default path).
  var pointSize = u.pointSizeMultiplier;
  if (u.attenuation > 0.0) {
    pointSize = min(u.attenuation / max(clipPos.w, 1.0e-6), pointSize);
  }
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + quadVertex.x * px;
  fp.y = fp.y + quadVertex.y * py;
  output.position = fp;
  output.color = color * u.highlightColor;
  output.pointUV = quadVertex;
  // FEAT-GAP-09 (Batch 104) — point-center RTE for fog block.
  output.worldPos = (u.modelMatrix * vec4<f32>(posRTE, 0.0)).xyz;
  // C2-7 — log depth from the point CENTER; clamp the final clip-z when active.
  output.vLogDepth = csm_vertexLogDepth(clipPos, u.logDepth.x);
  if (u.logDepth.w > 0.5) {
    output.position = csm_updatePositionDepth(output.position);
  }
  return output;
}

struct FragOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMainLOD(input: VertexOutput) -> FragOut {
  // POINT-SPRITE-SHAPE — solid square to match WebGL gl_Points; see
  // fragmentMain in POINT_CLOUD_WGSL for the parity rationale.
  var finalColor = input.color;

  // FEAT-GAP-09 (Batch 104) — Aerial-perspective fog blend. Same
  // body as the default POINT_CLOUD_WGSL::fragmentMain.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    // The model-space camera feeds only LUT direction and altitude, where metre-scale f32 error is imperceptible.
    let cameraModel = u.encodedCameraHigh + u.encodedCameraLow;
    let cameraWC = (u.modelMatrix * vec4<f32>(cameraModel, 1.0)).xyz;
    let viewDirWS = normalize(input.worldPos);
    let upDir = normalize(cameraWC);
    let cosViewZenith = clamp(dot(viewDirWS, upDir), -1.0, 1.0);
    let cameraAltitude = max(0.0, length(cameraWC) - innerRadius);
    let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
    let vCoord = clamp(cameraAltitude / thickness, 0.0, 1.0);
    let tSample = textureSampleLevel(
      atmosphereTransmittanceLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let iSample = textureSampleLevel(
      atmosphereInscatterLut, atmosphereLutSampler,
      vec2<f32>(uCoord, vCoord), 0.0,
    );
    let transmittance =
      clamp((tSample.r + tSample.g + tSample.b) / 3.0, 0.0, 1.0);
    let excessAltitude = max(0.0, cameraAltitude - thickness);
    let orbitFalloff = exp(-excessAltitude / thickness);
    let fogWeight = clamp(iSample.a, 0.0, 1.0) * orbitFalloff;
    finalColor = vec4<f32>(
      mix(finalColor.rgb, iSample.rgb, fogWeight),
      finalColor.a,
    );
    if (effects.atmosphereLutControl.w > 0.5) {
      finalColor = vec4<f32>(
        finalColor.rgb * mix(1.0, transmittance, fogWeight),
        finalColor.a,
      );
    }
  }

  // C2-7 — log depth when active; else the rasterizer's hyperbolic z (no-op).
  var fragDepth = input.position.z;
  if (u.logDepth.w > 0.5) {
    fragDepth = csm_writeLogDepth(input.vLogDepth, u.logDepth.z);
  }
  return FragOut(finalColor, fragDepth);
}

// Batch 169 - B.10 NEW-ADVANCED-MOTION-VECTORS LOD velocity emission.
// Same algorithm as the default-path vertexVelocityMain/
// fragmentVelocityMain (Batch 168) but reads (curr, prev) positions
// from the storage buffers instanceData/prevInstanceData indexed
// by visibleIndices[iidx]. Quad rasterized at the CURRENT-frame
// position so the velocity texture covers the same screen pixels the
// LOD color pass touched.
struct VelocityVertexOutputLOD {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  @location(2) alpha: f32,
};

@vertex
fn vertexVelocityMainLOD(
  @builtin(instance_index) iidx: u32,
  @location(0) quadVertex: vec2<f32>,
) -> VelocityVertexOutputLOD {
  var output: VelocityVertexOutputLOD;
  let actualIdx = visibleIndices[iidx];
  let base = actualIdx * 10u;

  // Current-frame center clip via RTE (matches vertexMainLOD math).
  let positionHigh = vec3<f32>(
    instanceData[base + 0u],
    instanceData[base + 1u],
    instanceData[base + 2u],
  );
  let positionLow = vec3<f32>(
    instanceData[base + 3u],
    instanceData[base + 4u],
    instanceData[base + 5u],
  );
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);

  // Previous positions live in the parallel SSBO at the SAME source index
  // (visibleIndices is regenerated each frame but the per-point
  // identity is stable across the LOD compaction — point i in the
  // base SSBO is point i in prev SSBO).
  let prevPosHigh = vec3<f32>(
    prevInstanceData[base + 0u],
    prevInstanceData[base + 1u],
    prevInstanceData[base + 2u],
  );
  let prevPosLow = vec3<f32>(
    prevInstanceData[base + 3u],
    prevInstanceData[base + 4u],
    prevInstanceData[base + 5u],
  );
  let prevPosRTE =
      (prevPosHigh - u.previousEncodedCameraHigh)
    + (prevPosLow - u.previousEncodedCameraLow);
  let prevCenterClip =
    u.previousMvpRelativeToEye * vec4<f32>(prevPosRTE, 1.0);

  // Rasterize quad at the current center using the existing pixel-size
  // expansion so the velocity texture covers the same screen pixels.
  // POINT-SPRITE-SHAPE — same attenuation clamp as vertexMainLOD.
  var pointSize = u.pointSizeMultiplier;
  if (u.attenuation > 0.0) {
    pointSize = min(u.attenuation / max(currCenterClip.w, 1.0e-6), pointSize);
  }
  let px = pointSize / u.viewportSize.x * currCenterClip.w;
  let py = pointSize / u.viewportSize.y * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + quadVertex.x * px;
  fp.y = fp.y + quadVertex.y * py;
  output.position = fp;
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  output.alpha = instanceData[base + 9u] * u.highlightColor.a;
  return output;
}

@fragment
fn fragmentVelocityMainLOD(input: VelocityVertexOutputLOD) -> @location(0) vec2<f32> {
  if (input.alpha <= 0.0) {
    discard;
  }
  let curW = input.currCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = input.currCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

/**
 * Below this point count the GPU LOD path is skipped even when opted in
 * — the compute dispatch + buffer copies cost more than CPU iteration
 * for small clouds. Tuned loosely against typical point cloud benchmarks.
 */
const POINT_COUNT_LOD_THRESHOLD = 50_000;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };

function createQuadVB(device: GPUDevice): GPUBuffer {
  const verts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, gpuData(verts));
  return buf;
}

/**
 * Build the cache-friendly descriptor for the default-path PointCloud
 * pipeline. The actual `GPURenderPipeline` materializes through
 * `webgpuPipelineCache.getPipeline()` so two PointCloud instances at the
 * same canvas format share one pipeline.
 *
 * @private
 */
function buildPipelineDescriptor(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  translucent: boolean,
  sharedLayouts: ReturnType<typeof getWebGPUPointCloudSharedLayouts>,
): {
  descriptor: WebGPURenderPipelineDescriptor;
  shaderModule: GPUShaderModule;
  bgl: GPUBindGroupLayout;
} {
  const moduleCache = getPointCloudShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.POINT_CLOUD,
    POINT_CLOUD_WGSL,
    0,
    "PointCloud shader",
  );
  const bgl = sharedLayouts.uniformBindGroupLayout;
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: `PointCloud pipeline [${format}/ms=${sampleCount}/${
      translucent ? "translucent" : "opaque"
    }]`,
    layout: sharedLayouts.defaultPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
        {
          arrayStride: 40,
          stepMode: "instance" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 1,
              offset: 0,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 2,
              offset: 12,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 3,
              offset: 24,
              format: "float32x4" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Opaque targets must omit blend entirely; WebGPU's fixed-function
      // blend stage is only enabled for source/public alpha content.
      targets: makeSceneFBTargets(
        format,
        translucent ? { translucent: true } : {},
      ),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      // Match PointCloud.js RenderState: translucent points blend and test
      // depth but do not write it; opaque points retain normal depth writes.
      depthWriteEnabled: !translucent,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
    // Match the scene framebuffer's MSAA sample count. Without this the
    // pipeline is single-sample and WebGPU rejects it as attachment-state
    // incompatible with the (MSAA) Scene Framebuffer Render Pass, silently
    // dropping every point-cloud draw.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
  return { descriptor, shaderModule, bgl };
}

/**
 * Velocity pipeline.
 * Same UBO BGL as the color path; vertex layout adds a second
 * 40-byte instance buffer at slot 1 carrying prev-frame positions
 * (locations 4 and 5). Outputs to rg16float matching the TAA
 * dispatcher's velocity texture format.
 * @private
 */
function buildVelocityPipelineDescriptor(
  shaderModule: GPUShaderModule,
  sharedLayouts: ReturnType<typeof getWebGPUPointCloudSharedLayouts>,
): WebGPURenderPipelineDescriptor {
  return {
    name: "PointCloud velocity pipeline",
    layout: sharedLayouts.defaultPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
        {
          arrayStride: 40,
          stepMode: "instance" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 1,
              offset: 0,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 2,
              offset: 12,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 3,
              offset: 24,
              format: "float32x4" as GPUVertexFormat,
            },
          ],
        },
        {
          // Prev-position stream. Same 40-byte stride; only positions are read
          // (locations 4-5). Color/size at offset 24 is ignored by
          // `vertexVelocityMain`.
          arrayStride: 40,
          stepMode: "instance" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 4,
              offset: 0,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 5,
              offset: 12,
              format: "float32x3" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" as GPUTextureFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path (no central cache available).
 * @private
 */
function _pcDescriptorToGPU(
  d: WebGPURenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
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
 * Resolve a PointCloud pipeline (default or LOD) through the central
 * pipeline cache. Returns the existing GPU pipeline if cached; otherwise
 * kicks off async creation and returns null.
 *
 * Mirrors `tryResolvePolylinePipeline`.
 * @private
 */
function tryResolvePointCloudPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  entry: PointCloudPipelineEntry,
): GPURenderPipeline | null {
  if (entry.pipeline) {
    return entry.pipeline;
  }
  // A terminal async compile failure is surfaced by the owner's next update.
  // Never restart it every frame; device/generation invalidation creates a
  // fresh cache/entry and is the explicit retry boundary.
  if (entry.error) {
    return null;
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
        .catch((error: unknown) => {
          entry.pending = false;
          entry.error = new Error(
            `WebGPU point-cloud pipeline '${entry.descriptor.name}' failed to compile`,
            { cause: error },
          );
        });
    }
    return null;
  }
  entry.pipeline = device.createRenderPipeline(
    _pcDescriptorToGPU(entry.descriptor),
  );
  entry.pending = false;
  return entry.pipeline;
}

function throwUnreportedPointCloudPipelineError(cache: PointCloudCache): void {
  const entries = [
    cache.pipelineEntry,
    cache.lodPipelineEntry,
    cache.velocityPipelineEntry,
    cache.lodVelocityPipelineEntry,
  ];
  for (const entry of entries) {
    if (entry?.error && entry.errorReported !== true) {
      entry.errorReported = true;
      throw entry.error;
    }
  }
}

function buildInstanceBuffer(
  device: GPUDevice,
  pointCloud: PointCloudLike,
  allowStorage: boolean,
): {
  buffer: GPUBuffer;
  count: number;
  // SOA model-local positions for the GPU LOD processor. Only populated
  // when `allowStorage` is true — saves 12 MB/million points otherwise.
  localX: Float32Array | null;
  localY: Float32Array | null;
  localZ: Float32Array | null;
  rtcX: number;
  rtcY: number;
  rtcZ: number;
  // Retained interleaved instance data so the velocity path can mirror it into
  // the prev-instance GPU buffer per frame. Same lifecycle as the GPU buffer
  // (rebuilt on revision change).
  instanceData: Float32Array;
} {
  // Read point positions, colors from pointCloud._drawCommand or _parsedContent
  const parsedContent =
    pointCloud._parsedContent || pointCloud._pointCloud?._parsedContent;
  if (!parsedContent || !parsedContent.positions) {
    return {
      buffer: device.createBuffer({ size: 40, usage: GPUBufferUsage.VERTEX }),
      count: 0,
      localX: null,
      localY: null,
      localZ: null,
      rtcX: 0.0,
      rtcY: 0.0,
      rtcZ: 0.0,
      instanceData: new Float32Array(0),
    };
  }

  // `_parsedContent.positions` / `.colors` are the attribute wrappers produced
  // by `PntsParser.parse` — `{ typedArray, isQuantized, quantized*, ... }` for
  // positions and `{ typedArray, componentDatatype, isRGB565 }` for colors —
  // NOT raw arrays. Unwrap `.typedArray` (with a defensive fall-through for the
  // legacy raw-array shape) so this decode works against the current parser
  // output. Also honour POSITION_QUANTIZED (16-bit dequantize with volume
  // scale/offset) and the RTC center so quantized clouds land in the right
  // place instead of at the ellipsoid origin.
  const posAttr = parsedContent.positions as unknown as {
    typedArray?: ArrayLike<number>;
    length?: number;
    isQuantized?: boolean;
    quantizedVolumeScale?: { x: number; y: number; z: number };
    quantizedVolumeOffset?: { x: number; y: number; z: number };
    quantizedRange?: number;
  };
  const positions: ArrayLike<number> =
    posAttr.typedArray ?? (parsedContent.positions as ArrayLike<number>);
  const colorAttr = parsedContent.colors as unknown as {
    typedArray?: ArrayLike<number>;
    componentDatatype?: number;
    componentCount?: number;
    isRGB565?: boolean;
    constantColor?: {
      red: number;
      green: number;
      blue: number;
      alpha: number;
    };
  } | null;
  const colors: ArrayLike<number> | null | undefined =
    colorAttr?.typedArray ??
    (parsedContent.colors as ArrayLike<number> | null | undefined);
  const colorsAreBytes =
    colors instanceof Uint8Array ||
    colors instanceof Uint8ClampedArray ||
    (colorAttr != null && colorAttr.componentDatatype === 5121); // UNSIGNED_BYTE
  const isRGB565 =
    pointCloud._isRGB565 === true || colorAttr?.isRGB565 === true;
  // PntsParser marks RGBA content translucent even when every alpha happens to
  // be 255. Draco adds an explicit componentCount in the shared decode stage.
  const colorComponentCount =
    colorAttr?.componentCount ?? (pointCloud._isTranslucent === true ? 4 : 3);
  const constantColor = colorAttr?.constantColor ??
    pointCloud._constantColor ?? {
      red: 0.25,
      green: 0.25,
      blue: 0.25,
      alpha: 1,
    };
  const decodedColor = new Float32Array(4);
  // Immutable descriptor shared by every point in this build. Keep it outside
  // the million-point loop so format support does not add allocation churn.
  const colorDecodeOptions = {
    colors,
    componentCount: colorComponentCount,
    colorsAreBytes,
    isRGB565,
    constantColor,
  };

  const pointCount = positions.length / 3;

  // Quantized-position dequantize parameters (POSITION_QUANTIZED). When not
  // quantized these stay inert (scale=1, offset=0, range=1) so the raw f32
  // positions pass through unchanged.
  const isQuantized = posAttr.isQuantized === true;
  const qScale = posAttr.quantizedVolumeScale ?? { x: 1, y: 1, z: 1 };
  const qOffset = posAttr.quantizedVolumeOffset ?? { x: 0, y: 0, z: 0 };
  const qRange =
    posAttr.quantizedRange && posAttr.quantizedRange > 0
      ? posAttr.quantizedRange
      : (1 << 16) - 1;

  // RTC center — quantized/local point positions are relative to this ECEF
  // anchor. Added after dequantize, BEFORE the model-matrix transform.
  const rtc = (parsedContent as unknown as { rtcCenter?: CesiumCartesian3 })
    .rtcCenter;
  const rtcX = rtc?.x ?? 0;
  const rtcY = rtc?.y ?? 0;
  const rtcZ = rtc?.z ?? 0;

  // 40 bytes per instance: posHigh(12) + posLow(12) + color RGBA(16).
  // Point size is per-cloud (not per-point) on this renderer and lives in the
  // dynamic UBO, which leaves the fourth lane available for real alpha.
  const data = new Float32Array(pointCount * 10);

  // Immutable model-local SOA arrays used by the LOD processor. Allocated only
  // when the caller plans to potentially activate GPU LOD — the
  // storage adds 12 bytes/point in CPU memory which isn't free.
  const localX = allowStorage ? new Float32Array(pointCount) : null;
  const localY = allowStorage ? new Float32Array(pointCount) : null;
  const localZ = allowStorage ? new Float32Array(pointCount) : null;

  const srcPosScratch = new Cartesian3();

  for (let i = 0; i < pointCount; i++) {
    let sx = positions[i * 3];
    let sy = positions[i * 3 + 1];
    let sz = positions[i * 3 + 2];
    if (isQuantized) {
      sx = (sx / qRange) * qScale.x + qOffset.x;
      sy = (sy / qRange) * qScale.y + qOffset.y;
      sz = (sz / qRange) * qScale.z + qOffset.z;
    }
    srcPosScratch.x = sx + rtcX;
    srcPosScratch.y = sy + rtcY;
    srcPosScratch.z = sz + rtcZ;

    // RTE invariant: the interleaved draw record stays in model/local space.
    // The shader subtracts a model-space camera and applies the cleaned
    // view*model matrix exactly once. Baking world space here would apply the
    // model again in color and velocity. The LOD SOA follows this same local
    // invariant; its small per-frame params transform the camera/frustum.
    EncodedCartesian3.fromCartesian(srcPosScratch, scratchEncoded);

    if (localX) {
      // Keep the LOD SOA relative to RTC_CENTER. RTC is frequently an
      // Earth-scale ECEF anchor; casting position+RTC to f32 here would erase
      // centimetre-scale detail before the compute shader sees it.
      localX[i] = sx;
      localY![i] = sy;
      localZ![i] = sz;
    }

    const off = i * 10;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;

    // Decode from the backend-neutral PNTS descriptor into reusable scratch;
    // no per-point allocations and no format branches in the draw hot path.
    unpackPointCloudColor(colorDecodeOptions, i, decodedColor);
    data[off + 6] = decodedColor[0];
    data[off + 7] = decodedColor[1];
    data[off + 8] = decodedColor[2];
    data[off + 9] = decodedColor[3];
  }

  // When GPU LOD might activate, OR in STORAGE usage so the same buffer
  // can back both the VB-instanced default path and the storage-backed
  // LOD path without duplicating 40 bytes/point of GPU memory.
  // COPY_SRC so the velocity prev-buffer identity-seed / count-change
  // seed can copyBufferToBuffer(instanceBuffer -> prevInstanceBuffer) on the
  // GPU (the identical bytes already reside here). Mirrors the splat renderer,
  // which added COPY_SRC for the same reason.
  let usage =
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  if (allowStorage) {
    usage |= GPUBufferUsage.STORAGE;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage,
  });
  device.queue.writeBuffer(buffer, 0, gpuData(data));
  return {
    buffer,
    count: pointCount,
    localX,
    localY,
    localZ,
    rtcX,
    rtcY,
    rtcZ,
    // Hand the interleaved data back so the velocity path can keep a CPU-side
    // prev mirror across the rebuild boundary.
    instanceData: data,
  };
}

function packUniforms(
  uniformState: CesiumUniformState,
  rteHistory: ReturnType<typeof createPointCloudRteHistory>,
  modelMatrix: Matrix4 | CesiumMatrix4,
  logActive: boolean,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
  attenuationScale: number,
  pointSize: number,
  highlightColor: { red: number; green: number; blue: number; alpha: number },
  data: Float32Array,
): Float32Array {
  // 304-byte layout: current RTE snapshot, draw controls, previous RTE
  // snapshot, current model (fog only), log/highlight, previous encoded camera.
  const currentRte = rteHistory.current;
  const previousRte = rteHistory.previous;
  Matrix4.pack(currentRte.mvpRelativeToEye, data, 0);
  data[16] = currentRte.encodedCameraHigh.x;
  data[17] = currentRte.encodedCameraHigh.y;
  data[18] = currentRte.encodedCameraHigh.z;
  data[19] = 0;
  data[20] = currentRte.encodedCameraLow.x;
  data[21] = currentRte.encodedCameraLow.y;
  data[22] = currentRte.encodedCameraLow.z;
  data[23] = 0;

  // viewportSize must be the REAL render-target size — `UniformState` has
  // no `_context`, so it cannot be read off the uniform state itself; the
  // caller passes context.drawingBufferWidth/Height.
  data[24] = drawingBufferWidth;
  data[25] = drawingBufferHeight;
  data[26] = pointSize;
  // Per-point attenuation numerator (0 = disabled); the shaders clamp
  // min(attenuation / eyeDepth, bakedMaxSize).
  data[27] = attenuationScale;

  Matrix4.pack(previousRte.mvpRelativeToEye, data, 28);

  // Current model matrix at floats 44..59 is only used to rotate relative
  // vectors/reconstruct the current camera for atmosphere effects.
  Matrix4.pack(modelMatrix as Matrix4, data, 44);

  // Log-depth lanes at floats 60..63.
  // near/far from the current frustum; factor = oneOverLog2FarDepthFromNearPlusOne
  // (derived if UniformState doesn't expose it); w = the per-frame active flag
  // (mirrors isWebGPULogDepthActive). When w==0 the shaders fall back to the
  // rasterizer's hyperbolic z, so this is inert unless the master switch is on.
  const frustum = (
    uniformState as { currentFrustum?: { x: number; y: number } }
  ).currentFrustum;
  const near = frustum?.x ?? 0.0;
  const far = frustum?.y ?? 0.0;
  let factor =
    (uniformState as { oneOverLog2FarDepthFromNearPlusOne?: number })
      .oneOverLog2FarDepthFromNearPlusOne ?? 0.0;
  if (!(factor > 0.0) && far > near) {
    const l = Math.log2(far - near + 1.0);
    factor = l > 0.0 ? 1.0 / l : 0.0;
  }
  data[60] = near;
  data[61] = far;
  data[62] = factor;
  data[63] = logActive ? 1.0 : 0.0;
  data[64] = highlightColor.red;
  data[65] = highlightColor.green;
  data[66] = highlightColor.blue;
  data[67] = highlightColor.alpha;
  data[68] = previousRte.encodedCameraHigh.x;
  data[69] = previousRte.encodedCameraHigh.y;
  data[70] = previousRte.encodedCameraHigh.z;
  data[71] = 0.0;
  data[72] = previousRte.encodedCameraLow.x;
  data[73] = previousRte.encodedCameraLow.y;
  data[74] = previousRte.encodedCameraLow.z;
  data[75] = 0.0;
  return data;
}

function isPointCloudTranslucent(pointCloud: PointCloudLike): boolean {
  return (
    pointCloud._isTranslucent === true ||
    (pointCloud._constantColor?.alpha ?? 1.0) < 1.0 ||
    (pointCloud._highlightColor?.alpha ?? 1.0) < 1.0
  );
}

/** Refresh the command's world-space sphere from backend-neutral local data. */
function updatePointCloudBoundingVolume(
  pointCloud: PointCloudLike,
  modelMatrix: Matrix4 | CesiumMatrix4,
): CesiumBoundingSphere | undefined {
  const local = pointCloud._webgpuLocalBoundingSphere;
  if (!local) {
    return pointCloud.boundingSphere ?? pointCloud._boundingSphere;
  }

  const world = pointCloud._boundingSphere ?? new BoundingSphere();
  BoundingSphere.transform(
    local as BoundingSphere,
    modelMatrix as Matrix4,
    world as BoundingSphere,
  );
  pointCloud._boundingSphere = world;
  return world;
}

/**
 * Convert world-space camera/frustum inputs to the immutable SOA's model-local
 * frame. Plane coefficients use `transpose(model) * plane`; the model's
 * linear rows are also packed so the compute shader measures true world-space
 * distance under rotation/non-uniform scale. Only these small arrays change
 * when an animated model moves—point buffers remain untouched.
 */
function updatePointCloudLodLocalParams(
  cache: PointCloudCache,
  modelMatrix: Matrix4 | CesiumMatrix4,
  cameraWorld: CesiumCartesian3,
  frameState: CesiumFrameState,
): void {
  const rtc = cache.lodRtcCenter;
  updatePointCloudLodLocalFrame(
    modelMatrix,
    cameraWorld,
    frameState.cullingVolume?.planes,
    rtc,
    cache.lodCameraPositionLocal,
    cache.lodFrustumPlanes,
    cache.lodModelLinear,
  );
}

/** Materialize one mutable LOD stream per PointCloud owner, off the hot path. */
function ensurePointCloudLodOwnerStream(
  pointCloud: PointCloudLike,
  cache: PointCloudCache,
  template: WebGPUPointCloudLODProcessorInstance | null,
): WebGPUPointCloudLODProcessorInstance | null {
  if (cache.lodProcessor) {
    return cache.lodProcessor;
  }
  if (
    !template?.isReady ||
    cache.lodProcessorPromise ||
    cache.lodProcessorFailed
  ) {
    return null;
  }

  const label = `PointCloud owner ${nextPointCloudLodOwnerId++}`;
  const promise = template.createOwnerStream(label);
  cache.lodProcessorPromise = promise;
  promise
    .then((processor) => {
      // Device recovery or owner destruction may detach this cache while the
      // immutable pipelines / deterministic scan worker materialize.
      if (
        pointCloud._webgpuCache !== cache ||
        cache.lodProcessorPromise !== promise
      ) {
        processor.destroy();
        return;
      }
      cache.lodProcessor = processor;
      cache.lodProcessorPromise = null;
      cache.lodUploadedRevision = -1;
      cache.lodStorageBindGroup = null;
      cache.lodVelocityBindGroup = null;
    })
    .catch(() => {
      if (
        pointCloud._webgpuCache === cache &&
        cache.lodProcessorPromise === promise
      ) {
        cache.lodProcessorPromise = null;
        cache.lodProcessorFailed = true;
      }
    });
  return null;
}

function updateWebGPUPointCloud(
  pointCloud: PointCloudLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;
  const resourceGeneration =
    (context as unknown as { resourceGeneration?: number })
      .resourceGeneration ?? 0;

  // Device recovery invalidates every owner resource, including buffers,
  // bind groups, layouts, and commands. Anchor this cache to the exact
  // (device, generation) tuple before any early return can publish stale GPU
  // handles. Async pipeline resolution only mutates the now-detached cache.
  const existingCache = pointCloud._webgpuCache as PointCloudCache | undefined;
  if (
    existingCache &&
    (existingCache.device !== device ||
      existingCache.resourceGeneration !== resourceGeneration)
  ) {
    destroyWebGPUPointCloudResources(pointCloud);
  }

  const sharedLayouts = getWebGPUPointCloudSharedLayouts(
    device,
    resourceGeneration,
    getEffectsBindGroupLayout(device),
  );

  if (!pointCloud._webgpuCache) {
    pointCloud._webgpuCache = {
      context,
      device,
      resourceGeneration,
      sharedLayouts,
      rteHistory: createPointCloudRteHistory(),
      uniformScratch: new Float32Array(76),
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      instanceBuffer: null,
      instanceAllowsStorage: false,
      instanceCount: 0,
      command: null,
      initialized: false,
      translucent: false,
      lastRevision: -1,
      lodPipeline: null,
      lodProcessor: null,
      lodProcessorPromise: null,
      lodProcessorFailed: false,
      lodBindGroupLayout: null,
      lodStorageBindGroup: null,
      lodIndirectBuffer: null,
      lodPositionsX: null,
      lodPositionsY: null,
      lodPositionsZ: null,
      lodFrustumPlanes: new Float32Array(24),
      lodCameraPositionLocal: [0.0, 0.0, 0.0],
      lodModelLinear: new Float32Array(12),
      lodRtcCenter: new Cartesian3(),
      lodUploadedRevision: -1,
      lodCommand: null,
      lodActive: false,
      defaultEdlSource: null,
      lodEdlSource: null,
      // Velocity pipeline + prev-instance buffer (lazy).
      prevInstanceBuffer: null,
      instanceData: null,
      prevInstanceData: null,
      velocityPipelineEntry: null,
      velocityCommand: null,
      // LOD-path velocity (parallel SSBO + LOD velocity VS).
      lodPrevInstanceBuffer: null,
      lodVelocityPipelineEntry: null,
      lodVelocityCommand: null,
      lodVelocityBindGroup: null,
      lodVelocityStorageBGL: null,
      // Prev-buffer revision-skip.
      instanceDataRevision: 0,
      prevBufferRevision: undefined,
      lodPrevBufferRevision: undefined,
    } as PointCloudCache;
  }

  const cache = pointCloud._webgpuCache as PointCloudCache;
  throwUnreportedPointCloudPipelineError(cache);
  const translucent = isPointCloudTranslucent(pointCloud);
  const cull = pointCloud._cull !== false;
  // Point cloud draws into scene FB; use scenePipelineFormat.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Invalidate cached pipeline on scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache.initialized &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      cache.translucent !== translucent)
  ) {
    cache.initialized = false;
    cache.pipelineEntry = null;
    cache.pipeline = null;
    // Velocity pipeline references the same shader module built against the
    // now-invalid format; force rebuild.
    cache.velocityPipelineEntry = null;
    // The cached draw commands hold a pointer to the OLD pipeline. After the
    // resolver re-runs against the new format the pipeline pointer changes; the
    // command must be re-built so its `pipeline` field points at the live
    // object. A command that survived a format change would be submitted with
    // the stale pipeline reference (WebGPU then rejects the draw because the
    // pipeline's color target format doesn't match the active attachment). Not
    // user-visible because HDR isn't toggled at runtime, but matches the
    // Ground{Primitive, Polyline} fix for the same class of bug.
    cache.command = null;
    cache.lodCommand = null;
    cache.lodPipeline = null;
    cache.lodPipelineEntry = null;
    // LOD velocity pipeline targets rg16float which is format-invariant, but we
    // rebuild it alongside the LOD color pipeline so the storageBGL and
    // bindings stay consistent across any future format-aware fields. Cheap
    // reset.
    cache.lodVelocityPipelineEntry = null;
    cache.lodVelocityBindGroup = null;
    cache.lodVelocityStorageBGL = null;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  if (!cache.initialized) {
    // Keep owner buffers across a pipeline-only rebuild (format or opacity
    // transition). The previous path reallocated both on every invalidation.
    if (!cache.uniformBuffer) {
      cache.uniformBuffer = device.createBuffer({
        size: 304,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    // Descriptor + central pipeline cache. Two PointCloud instances at the same
    // canvas format share one pipeline.
    const built = buildPipelineDescriptor(
      device,
      canvasFormat,
      (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1,
      translucent,
      cache.sharedLayouts,
    );
    cache.pipelineEntry = {
      descriptor: built.descriptor,
      pipeline: null,
      pending: false,
    };
    cache.shaderModule = built.shaderModule;
    cache.defaultBgl = built.bgl;

    cache.bindGroup = device.createBindGroup({
      layout: built.bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });

    if (!cache.quadVertexBuffer) {
      cache.quadVertexBuffer = createQuadVB(device);
    }
    cache.translucent = translucent;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    cache.initialized = true;
  }

  // Resolve the default pipeline through the central cache. On the first
  // frame this kicks off async creation and returns null; we skip the
  // default-path draw command so it can land next frame.
  if (!cache.pipeline && cache.pipelineEntry) {
    const resolved = tryResolvePointCloudPipeline(
      device,
      (
        context as unknown as {
          webgpuPipelineCache?: WebGPURenderPipelineCache | null;
        }
      ).webgpuPipelineCache ?? null,
      cache.pipelineEntry,
    );
    if (resolved) {
      cache.pipeline = resolved;
    }
  }

  // Decide whether GPU LOD can apply this frame. Opt-in flag + lazy
  // processor init + point count threshold are all checked. If any of
  // them says no we stay on the existing VB-instanced path.
  const optIn = pointCloud.enableGPULOD === true;
  const pointCount = pointCloud._pointsLength ?? 0;
  const lodSseDenominator = frameState.camera?.frustum?.sseDenominator;
  const perspectiveLodProjection =
    typeof lodSseDenominator === "number" &&
    Number.isFinite(lodSseDenominator) &&
    lodSseDenominator > 0.0;
  // Apply the threshold before touching the context template, forking an owner
  // stream, upgrading the instance buffer, or allocating world-position SOAs.
  // Alpha blending requires back-to-front ordering. Atomic compaction is
  // nondeterministic and the deterministic scan preserves source order, not
  // depth order, so translucent clouds must retain the full renderer until a
  // sorted/OIT LOD path exists.
  const lodEligible =
    optIn &&
    cull &&
    !translucent &&
    perspectiveLodProjection &&
    pointCount >= POINT_COUNT_LOD_THRESHOLD;
  // `context.pointCloudLOD` is typed as `object | null` on the
  // backend-agnostic `CesiumGraphicsContext` surface — cast to the real
  // processor interface at the boundary. Doing the cast here once
  // avoids scattering `as unknown as …` through the hot path below.
  const lodTemplate = lodEligible
    ? ((context.pointCloudLOD as WebGPUPointCloudLODProcessorInstance | null) ??
      null)
    : null;
  const lodProcessor = lodEligible
    ? ensurePointCloudLodOwnerStream(pointCloud, cache, lodTemplate)
    : null;
  const lodPossible = lodEligible && lodProcessor !== null;

  // Rebuild instance data when point data changes. When LOD might be
  // active we need STORAGE usage on the buffer AND the SOA world-space
  // arrays for the LOD processor. A false -> true toggle explicitly upgrades
  // the immutable buffer to STORAGE usage even when point count is unchanged.
  const modelMatrix = pointCloud.modelMatrix ?? Matrix4.IDENTITY;
  const boundingVolume = updatePointCloudBoundingVolume(
    pointCloud,
    modelMatrix,
  );
  const revision = pointCount;
  const needsStorageUpgrade = lodEligible && !cache.instanceAllowsStorage;
  if (
    revision !== cache.lastRevision ||
    !cache.instanceBuffer ||
    needsStorageUpgrade
  ) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, pointCloud, lodEligible);
    cache.instanceBuffer = result.buffer;
    cache.instanceAllowsStorage = lodEligible;
    cache.instanceCount = result.count;
    cache.lastRevision = revision;
    cache.lodPositionsX = result.localX;
    cache.lodPositionsY = result.localY;
    cache.lodPositionsZ = result.localZ;
    cache.lodRtcCenter.x = result.rtcX;
    cache.lodRtcCenter.y = result.rtcY;
    cache.lodRtcCenter.z = result.rtcZ;
    // Track THIS frame's instance data. The velocity helper promotes this to
    // `prevInstanceData` AFTER its dispatch so next frame's prev tracks the
    // previous frame's data (the PointPrimitive velocity pattern). Do NOT
    // clobber `prevInstanceData` here on revision change — that would force
    // velocity=0 every revision and miss per-frame animation deltas. The
    // size-mismatch case (point count changed across revision) is handled by
    // the byteLength check in attachPointCloudVelocityCommand: when prev is
    // shorter/longer than curr, the GPU self-copy fallback fires and emits
    // velocity=0 for the discontinuity (correct — no continuous index
    // correspondence between OLD and NEW points).
    cache.instanceData = result.instanceData;
    // The single content-write site for `instanceBuffer`. Bump the
    // monotonic data revision so the velocity prev buffers re-seed exactly
    // once for this content (T-3: grep confirms `instanceBuffer` is written
    // ONLY here — the LOD path uploads positions to the LOD processor, never
    // to `instanceBuffer`, so no second bump site exists).
    cache.instanceDataRevision++;
    cache.command = null;
    cache.lodCommand = null;
    cache.lodStorageBindGroup = null;
    cache.lodUploadedRevision = -1;
    // Velocity bind group references the (now-destroyed) instance buffer; force
    // rebuild on the next frame's velocity attach. lodPrevInstanceBuffer also
    // references stale data; the size-allocation check inside the LOD velocity
    // helper resizes it (the byteLength comparison in the prev-upload step then
    // emits velocity = 0 for the seed/revision-change frame).
    cache.lodVelocityBindGroup = null;
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Per-frame uniforms
  const logActive = isWebGPULogDepthActive(context, frameState);
  if (frameState.taaEnabled !== true) {
    // Keep the most recent off-frame as the seed for a later re-enable; never
    // calculate velocity across an arbitrarily long disabled interval.
    cache.rteHistory.valid = false;
  }
  updatePointCloudRteHistory(
    cache.rteHistory,
    frameState.frameNumber,
    frameState.camera ?? context.uniformState,
    context.uniformState.view,
    context.uniformState.projection,
    context.uniformState.cameraPosition,
    modelMatrix,
  );
  // WebGL attenuation parity. Mirrors PointCloud.js
  // u_pointSizeAndTimeAndGeometricErrorAndDepthMultiplier.zw: numerator =
  // geometricError * geometricErrorScale * (drawingBufferHeight /
  // frustum.sseDenominator). Ortho/2D frustums have no sseDenominator — WebGL
  // uses depthMultiplier = +Infinity there, i.e. the clamp always lands on
  // maximumAttenuation; we pass 0 (disabled) so the shaders use the baked max
  // size, which is the same result. A constant style pointSize overrides
  // attenuation entirely on WebGL (hasPointSizeStyle wins in the derived VS) —
  // keep the clamp off then.
  let attenuationScale = 0.0;
  if (
    pointCloud.attenuation === true &&
    pointCloud._webgpuStylePointSizeActive !== true
  ) {
    const frustum = (
      frameState as {
        camera?: { frustum?: { sseDenominator?: number } };
      }
    ).camera?.frustum;
    const sse = frustum?.sseDenominator;
    if (typeof sse === "number" && Number.isFinite(sse) && sse > 0) {
      const geometricError =
        (pointCloud.geometricError ?? 0) *
        (pointCloud.geometricErrorScale ?? 1);
      attenuationScale = geometricError * (context.drawingBufferHeight / sse);
    }
  }
  const uniforms = packUniforms(
    context.uniformState,
    cache.rteHistory,
    modelMatrix,
    logActive,
    context.drawingBufferWidth,
    context.drawingBufferHeight,
    attenuationScale,
    pointCloud._webgpuPointSize ?? 3.0,
    pointCloud._highlightColor ?? {
      red: 1.0,
      green: 1.0,
      blue: 1.0,
      alpha: 1.0,
    },
    cache.uniformScratch,
  );
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(uniforms));

  // ── Fast path: opt-in + above threshold + processor ready ──
  if (
    lodPossible &&
    lodProcessor!.isReady &&
    cache.lodPositionsX &&
    cache.lodPositionsY &&
    cache.lodPositionsZ
  ) {
    const enqueuedLod = _runGPULODPath(
      device,
      context,
      frameState,
      commandList,
      cache,
      lodProcessor!,
      pointCloud,
      modelMatrix,
      canvasFormat,
      boundingVolume,
    );
    if (enqueuedLod) {
      return;
    }
  }

  // ── Default path (current behaviour, untouched) ──
  // Skip the draw if the pipeline is still materializing in the central cache.
  // It'll be ready by next frame.
  if (!cache.pipeline) {
    return;
  }
  // Per-frame effects BG refresh. Shared helper caches per-frame and returns
  // the placeholder when none of (shadow, csm, atmosphereLut) is active.
  const effectsBG =
    getOrCreateSharedAdvancedEffectsBG(frameState) ??
    getPlaceholderEffects(device).bindGroup;
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup, effectsBG],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: translucent
        ? Pass.TRANSLUCENT
        : (pointCloud._opaquePass ?? Pass.OPAQUE),
      boundingVolume,
      cull,
    });
  } else {
    const bindGroups = (cache.command as { bindGroups?: GPUBindGroup[] })
      .bindGroups;
    if (bindGroups) {
      bindGroups[0] = cache.bindGroup!;
      bindGroups[1] = effectsBG;
    }
    cache.command.boundingVolume = boundingVolume;
    cache.command.cull = cull;
  }

  // Maintain a one-frame-lagged mirror of the instance buffer so the velocity
  // VS can read (current, previous) position pairs. Only allocates the GPU
  // buffer when TAA is enabled this frame (or has ever been since boot — we
  // keep the buffer once allocated so toggling TAA off→on doesn't lose a frame
  // of history).
  attachPointCloudVelocityCommand(
    device,
    context,
    frameState,
    cache,
    canvasFormat,
  );

  // Tag the color command with the raw GPU resources the Eye-Dome-Lighting
  // feature renderer needs to re-draw these points into its off-screen depth
  // framebuffer. This is a plain reference assignment with no behavior change;
  // the EDL renderer only reads it when the user has turned
  // `pointCloudShading.eyeDomeLighting` on (default off), so the default draw
  // path is byte-identical whether or not this tag is present.
  const defaultEdlSource = cache.defaultEdlSource ?? {
    uniformBuffer: null,
    quadVertexBuffer: null,
    instanceBuffer: null,
    instanceCount: 0,
  };
  defaultEdlSource.uniformBuffer = cache.uniformBuffer;
  defaultEdlSource.device = device;
  defaultEdlSource.resourceGeneration = resourceGeneration;
  defaultEdlSource.quadVertexBuffer = cache.quadVertexBuffer;
  defaultEdlSource.instanceBuffer = cache.instanceBuffer;
  defaultEdlSource.instanceCount = cache.instanceCount;
  defaultEdlSource.effectsBindGroup = effectsBG;
  defaultEdlSource.effectsBindGroupLayout =
    cache.sharedLayouts.effectsBindGroupLayout;
  cache.defaultEdlSource = defaultEdlSource;
  (cache.command as { _edlSource?: PointCloudEDLSource })._edlSource =
    defaultEdlSource;
  // Re-enable the cached command every frame. The EDL renderer disables it
  // (sets `.enabled = false`) when it hijacks the draw into its off-screen
  // FBO; without this reset a point cloud would stay invisible after EDL is
  // toggled back off (the command object is reused across frames).
  (cache.command as { enabled?: boolean }).enabled = true;

  commandList.push(cache.command);
}

/**
 * The raw GPU resources tagged onto a point-cloud color command so
 * `WebGPUPointCloudEyeDomeLighting` can re-issue the same instanced point draw
 * into its off-screen (color + packed-depth) framebuffer using the dual-output
 * depth shader. All fields alias the live `PointCloudCache` buffers — the EDL
 * renderer never mutates them.
 */
export interface PointCloudEDLSource {
  device?: GPUDevice | null;
  resourceGeneration?: number;
  uniformBuffer: GPUBuffer | null;
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  instanceCount: number;
  /** Active atmosphere/effects resources used by the normal color draw. */
  effectsBindGroup?: GPUBindGroup | null;
  effectsBindGroupLayout?: GPUBindGroupLayout | null;
  /** LOD storage indirection; when present EDL replays drawIndirect. */
  lodStorageBindGroup?: GPUBindGroup | null;
  lodStorageBindGroupLayout?: GPUBindGroupLayout | null;
  drawIndirectBuffer?: GPUBuffer | null;
}

/**
 * Upload prev positions, build (or fetch) the velocity pipeline, attach
 * `velocityCommand` to the cache's color command. The TAA pass walks the
 * command list for `cmd.velocityCommand` and dispatches it into the rg16float
 * velocity texture. Mirrors the Billboard/Point velocity pattern.
 *
 * Skips entirely when TAA is off and no prev buffer has been allocated
 * yet — keeps the off-path zero-cost.
 * @private
 */
function attachPointCloudVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: PointCloudCache,
  canvasFormat: GPUTextureFormat,
): void {
  // Read the TAA flag from the same source the Collection renderers use.
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!taaEnabledThisFrame) {
    if (cache.command) {
      (cache.command as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
    cache.prevInstanceData = cache.instanceData;
    cache.prevBufferRevision = undefined;
    return;
  }
  if (!cache.instanceBuffer || cache.instanceCount === 0) {
    return;
  }

  const requiredBytes = cache.instanceCount * 40;
  // Allocate / grow the prev buffer to match the current instance count.
  if (
    !cache.prevInstanceBuffer ||
    cache.prevInstanceBuffer.size < requiredBytes
  ) {
    if (cache.prevInstanceBuffer) {
      cache.prevInstanceBuffer.destroy();
    }
    cache.prevInstanceBuffer = device.createBuffer({
      label: "PointCloud prev instances",
      size: requiredBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // The resident revision points at bytes in the destroyed
    // buffer; force a re-seed on the next frame.
    cache.prevBufferRevision = undefined;
  }
  // Upload prev frame's data. `cache.prevInstanceData` tracks the
  // PREVIOUS frame's data (set at the END of this function on the
  // last call). For animated content this captures the actual
  // per-frame delta; for static content prev and curr point at the
  // same Float32Array so velocity stays zero (the camera-only TAA
  // path picks up the camera motion).
  //
  // Two ways to fall into the GPU self-copy fallback below:
  //   1. First frame ever — `prevInstanceData` is null because no
  //      previous frame has run. Seed by copying curr → prev so this
  //      frame emits velocity = 0 (correct: no continuous "previous"
  //      exists). The post-dispatch promotion at the end of this
  //      function then captures THIS frame's data as prev for next
  //      frame's real delta.
  //   2. Revision-change point-count mismatch (animated content where
  //      the application bumps the cloud's point count between
  //      frames). The prev buffer carried last frame's smaller/larger
  //      data; falling through to the self-copy emits velocity = 0 for
  //      this transition (correct: there's no continuous index
  //      correspondence between OLD and NEW points at the same i).
  //      Subsequent frames at the new count restore the per-frame
  //      delta capture.
  // Revision-skip + GPU self-copy.
  const prevSrc = cache.prevInstanceData;
  const isIdentity = prevSrc === cache.instanceData; // static: prev IS curr
  if (
    isIdentity &&
    cache.prevInstanceBuffer &&
    cache.prevInstanceBuffer.size >= requiredBytes
  ) {
    // Identity (static geometry): the bytes we would upload already live in
    // `instanceBuffer` on the GPU. Seed `prevInstanceBuffer` from it ONCE
    // (GPU copy, zero CPU upload) then SKIP while the data revision is
    // unchanged (INV-1). Geometry velocity is 0 either way; camera/model
    // motion comes from the cache-owned previous RTE snapshot.
    if (cache.prevBufferRevision !== cache.instanceDataRevision) {
      copyPointCloudBuffer(
        context,
        device,
        "PointCloud prev identity-seed",
        cache.instanceBuffer,
        cache.prevInstanceBuffer,
        requiredBytes,
      );
      cache.prevBufferRevision = cache.instanceDataRevision;
    }
    // else: static & already resident → NOTHING. This is the per-frame win.
  } else if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    // Animated distinct-array path (INV-2) — prev holds the PREVIOUS frame's
    // data; upload it unchanged so velocity captures the true delta.
    device.queue.writeBuffer(
      cache.prevInstanceBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
    // prev now holds last-frame data, not the current instance revision.
    cache.prevBufferRevision = undefined;
  } else {
    // First-frame seed OR revision-change point-count mismatch (INV-4).
    // Either way the correct emission is velocity = 0 for this frame;
    // GPU self-copy ensures the prev buffer holds matching bytes so
    // the velocity VS reads (curr, curr) → 0 instead of garbage.
    copyPointCloudBuffer(
      context,
      device,
      "PointCloud prev seed",
      cache.instanceBuffer,
      cache.prevInstanceBuffer,
      requiredBytes,
    );
    cache.prevBufferRevision = undefined;
  }

  // Lazy velocity pipeline build.
  if (!cache.velocityPipelineEntry && cache.shaderModule && cache.defaultBgl) {
    cache.velocityPipelineEntry = {
      descriptor: buildVelocityPipelineDescriptor(
        cache.shaderModule,
        cache.sharedLayouts,
      ),
      pipeline: null,
      pending: false,
    };
  }
  if (cache.velocityPipelineEntry && !cache.velocityPipelineEntry.pipeline) {
    tryResolvePointCloudPipeline(
      device,
      (
        context as unknown as {
          webgpuPipelineCache?: WebGPURenderPipelineCache | null;
        }
      ).webgpuPipelineCache ?? null,
      cache.velocityPipelineEntry,
    );
  }

  if (
    cache.command &&
    cache.velocityPipelineEntry?.pipeline &&
    cache.prevInstanceBuffer
  ) {
    // Velocity path uses placeholder effects BG — `vertexVelocityMain`
    // doesn't sample atmosphere, but the pipeline layout includes the
    // effects BGL (shared with color).
    const velocityEffectsBG = getPlaceholderEffects(device).bindGroup;
    if (!cache.velocityCommand) {
      cache.velocityCommand = new WebGPUDrawCommand({
        pipeline: cache.velocityPipelineEntry.pipeline,
        bindGroups: [cache.bindGroup, velocityEffectsBG],
        vertexBuffers: [
          cache.quadVertexBuffer,
          cache.instanceBuffer,
          cache.prevInstanceBuffer,
        ],
        vertexCount: 6,
        instanceCount: cache.instanceCount,
        pass: Pass.OPAQUE,
      });
    } else {
      const velocityCommand = cache.velocityCommand as {
        pipeline?: GPURenderPipeline;
        bindGroups?: Array<GPUBindGroup | null>;
        vertexBuffers?: Array<GPUBuffer | null>;
        instanceCount?: number;
      };
      velocityCommand.pipeline = cache.velocityPipelineEntry.pipeline;
      velocityCommand.bindGroups ??= [];
      velocityCommand.bindGroups[0] = cache.bindGroup;
      velocityCommand.bindGroups[1] = velocityEffectsBG;
      velocityCommand.vertexBuffers ??= [];
      velocityCommand.vertexBuffers[0] = cache.quadVertexBuffer;
      velocityCommand.vertexBuffers[1] = cache.instanceBuffer;
      velocityCommand.vertexBuffers[2] = cache.prevInstanceBuffer;
      velocityCommand.instanceCount = cache.instanceCount;
    }
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      cache.velocityCommand;
  } else if (cache.command) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }
  // Promote THIS frame's `instanceData` to next frame's `prevInstanceData`
  // AFTER the velocity command has been built (and therefore captured a stable
  // reference to the prev buffer's contents). For static content
  // `cache.instanceData` is the same Float32Array as before — assignment is a
  // no-op. For animated content where the application re-runs
  // `buildInstanceBuffer` each frame, this rolls the per-frame delta forward
  // correctly.
  if (cache.instanceData) {
    cache.prevInstanceData = cache.instanceData;
  }
  // Suppress unused-parameter warning for `canvasFormat` — kept for
  // signature parity with the surrounding pipeline-builder helpers.
  void canvasFormat;
}

/**
 * GPU LOD fast path. Uploads positions to the shared LOD processor the
 * first time a given revision is seen, dispatches the LOD compute pass
 * each frame, copies the atomic visibleCount into the indirect draw
 * instanceCount slot, and issues a drawIndirect that draws only the
 * visible points.
 *
 * Fails gracefully: any missing resource drops back to the caller which
 * re-routes through the default path on the next frame.
 */
function _runGPULODPath(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  commandList: CesiumAnyDrawCommand[],
  cache: PointCloudCache,
  lodProcessor: WebGPUPointCloudLODProcessorInstance,
  pointCloud: PointCloudLike,
  modelMatrix: Matrix4 | CesiumMatrix4,
  canvasFormat: GPUTextureFormat,
  boundingVolume: CesiumBoundingSphere | undefined,
): boolean {
  // Build the LOD pipeline + storage BGL lazily. Both are per-device not
  // per-instance, but storing them on the cache is simpler than a device-keyed
  // shared map and point cloud instances are typically few enough that the
  // duplication doesn't matter. Descriptor + central pipeline cache. Two
  // PointCloud instances on the same canvas format share one LOD pipeline.
  // Returns early without rendering when the pipeline is still materializing —
  // matches the existing `lodStorageBindGroup` not-ready behavior below
  // (one-frame visual gap, recovers next frame).
  if (!cache.lodPipelineEntry) {
    const built = _buildLODPipelineDescriptor(
      device,
      canvasFormat,
      (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1,
      cache.translucent,
      cache.sharedLayouts,
    );
    cache.lodPipelineEntry = {
      descriptor: built.descriptor,
      pipeline: null,
      pending: false,
    };
    cache.lodBindGroupLayout = built.storageBGL;
    cache.lodDefaultBgl = built.bgl;
    // Rebuild the uniform bind group against the LOD pipeline's BGL too
    // so both pipelines can share the same uniform buffer.
    cache.bindGroup = device.createBindGroup({
      layout: built.bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer! } }],
    });
  }
  if (!cache.lodPipeline) {
    const resolved = tryResolvePointCloudPipeline(
      device,
      (
        context as unknown as {
          webgpuPipelineCache?: WebGPURenderPipelineCache | null;
        }
      ).webgpuPipelineCache ?? null,
      cache.lodPipelineEntry,
    );
    if (!resolved) {
      return false;
    }
    cache.lodPipeline = resolved;
  }

  // Upload positions once per revision. uploadPositions invalidates
  // the processor's bind group internally so we don't need to track that.
  if (cache.lodUploadedRevision !== cache.lastRevision) {
    lodProcessor.uploadPositions(
      cache.lodPositionsX!,
      cache.lodPositionsY!,
      cache.lodPositionsZ!,
    );
    cache.lodUploadedRevision = cache.lastRevision;
    cache.lodStorageBindGroup = null; // force rebuild (visibleIndices buf may have changed)
  }

  // Allocate the indirect draw buffer once. Layout is [vertexCount=6,
  // instanceCount=<copied each frame>, firstVertex=0, firstInstance=0].
  if (!cache.lodIndirectBuffer) {
    const init = new Uint32Array([6, 0, 0, 0]);
    cache.lodIndirectBuffer = device.createBuffer({
      label: "PointCloud LOD indirect draw",
      size: 16,
      usage:
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.STORAGE,
    });
    device.queue.writeBuffer(cache.lodIndirectBuffer, 0, init.buffer);
  }

  // Storage bind group references the processor's visibleIndices buffer
  // — rebuild whenever we upload new positions (processor may have
  // grown the buffer). Bound to @group(1) of the LOD pipeline.
  if (!cache.lodStorageBindGroup && lodProcessor.visibleIndicesBuffer) {
    cache.lodStorageBindGroup = device.createBindGroup({
      label: "PointCloud LOD storage BG",
      layout: cache.lodBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.instanceBuffer! } },
        { binding: 1, resource: { buffer: lodProcessor.visibleIndicesBuffer } },
      ],
    });
  }
  if (!cache.lodStorageBindGroup) {
    // Processor not quite ready (async init still running). Fall back
    // to the default path by returning — caller pushes nothing here.
    return false;
  }

  const camPos = context.uniformState.cameraPosition;
  updatePointCloudLodLocalParams(cache, modelMatrix, camPos, frameState);

  const sseDenominator = frameState.camera?.frustum?.sseDenominator;
  const projectionScale =
    typeof sseDenominator === "number" && sseDenominator > 0.0
      ? context.drawingBufferHeight / sseDenominator
      : context.drawingBufferHeight;
  // Standalone point clouds may not carry a tile geometric error. Estimate a
  // conservative mean spacing from the world-space bound instead of silently
  // selecting one fixed LOD for the entire globe frustum.
  const estimatedSpacing =
    boundingVolume && cache.instanceCount > 0
      ? (2.0 * boundingVolume.radius) / Math.cbrt(cache.instanceCount)
      : 1.0;
  const configuredGeometricError = pointCloud.geometricError ?? 0.0;
  const geometricErrorScale = pointCloud.geometricErrorScale ?? 1.0;
  const geometricError = Math.max(
    (configuredGeometricError > 0.0
      ? configuredGeometricError
      : estimatedSpacing) * geometricErrorScale,
    Number.EPSILON,
  );
  const lodFarDistance =
    pointCloud.lodFarDistance ?? frameState.camera?.frustum?.far ?? 1e7;
  const frameEncoder = getAvailableFrameCommandEncoder(context);
  const encoder =
    frameEncoder ??
    device.createCommandEncoder({ label: "PointCloud LOD dispatch" });
  lodProcessor.dispatch(encoder, {
    cameraPositionLocal: cache.lodCameraPositionLocal,
    projectionScale,
    targetPixelSpacing: Math.max(pointCloud._webgpuPointSize ?? 1.0, 1.0),
    frustumPlanes: cache.lodFrustumPlanes,
    pointCount: cache.instanceCount,
    maxVisiblePoints: cache.instanceCount,
    geometricError,
    lodFarDistance,
    modelLinear: cache.lodModelLinear,
  });
  // Copy the atomic visibleCount (first u32) into the indirect draw
  // arg's instanceCount slot (offset 4, length 4).
  encoder.copyBufferToBuffer(
    lodProcessor.visibleCountBuffer!,
    0,
    cache.lodIndirectBuffer,
    4,
    4,
  );
  if (!frameEncoder) {
    device.queue.submit([encoder.finish()]);
  }

  // Emit a drawIndirect command. The scene renderer's execute path recognizes
  // `_drawIndirectBuffer` and routes through drawIndirect instead of the
  // default instanced draw. Per-frame effects BG refresh for LOD color command.
  // Same helper as the default path; cached per frame so this is cheap.
  const lodEffectsBG =
    getOrCreateSharedAdvancedEffectsBG(frameState) ??
    getPlaceholderEffects(device).bindGroup;
  if (!cache.lodCommand) {
    // Don't widen to `CesiumAnyDrawCommand` before the constructor —
    // the upstream ambient types `pipeline` as optional (for WebGL's
    // shaderProgram-shaped variant) but `WebGPUDrawCommandOptions`
    // requires it, and widening trips the assignability check. Build
    // the WebGPU-shape options object directly instead.
    cache.lodCommand = new WebGPUDrawCommand({
      pipeline: cache.lodPipeline,
      bindGroups: [cache.bindGroup, cache.lodStorageBindGroup, lodEffectsBG],
      vertexBuffers: [cache.quadVertexBuffer],
      vertexCount: 6,
      instanceCount: 0, // filled by drawIndirect
      pass: cache.translucent
        ? Pass.TRANSLUCENT
        : (pointCloud._opaquePass ?? Pass.OPAQUE),
      drawIndirectBuffer: cache.lodIndirectBuffer,
      boundingVolume,
      cull: pointCloud._cull !== false,
    });
  } else {
    // Per-frame effects BG refresh on cached command. Slot [2] is the LOD
    // effects slot (after uniforms at 0 and storage at 1).
    const bindGroups = (cache.lodCommand as { bindGroups?: GPUBindGroup[] })
      .bindGroups;
    if (bindGroups) {
      bindGroups[0] = cache.bindGroup!;
      bindGroups[1] = cache.lodStorageBindGroup!;
      bindGroups[2] = lodEffectsBG;
    }
    cache.lodCommand.boundingVolume = boundingVolume;
    cache.lodCommand.cull = pointCloud._cull !== false;
  }

  // LOD-path velocity emission. Mirrors the default-path attach helper:
  // maintain a parallel prev SSBO, build the velocity pipeline lazily, attach
  // `velocityCommand` to the lodCommand. The TAA pass walks the command list
  // for `cmd.velocityCommand` and dispatches it via drawIndirect (same indirect
  // buffer as color).
  attachLODPointCloudVelocityCommand(
    device,
    context,
    frameState,
    cache,
    lodProcessor,
  );

  const lodEdlSource = cache.lodEdlSource ?? {
    uniformBuffer: null,
    quadVertexBuffer: null,
    instanceBuffer: null,
    instanceCount: 0,
  };
  lodEdlSource.uniformBuffer = cache.uniformBuffer;
  lodEdlSource.device = device;
  lodEdlSource.resourceGeneration = cache.resourceGeneration;
  lodEdlSource.quadVertexBuffer = cache.quadVertexBuffer;
  lodEdlSource.instanceBuffer = cache.instanceBuffer;
  lodEdlSource.instanceCount = cache.instanceCount;
  lodEdlSource.lodStorageBindGroup = cache.lodStorageBindGroup;
  lodEdlSource.lodStorageBindGroupLayout = cache.lodBindGroupLayout;
  lodEdlSource.drawIndirectBuffer = cache.lodIndirectBuffer;
  lodEdlSource.effectsBindGroup = lodEffectsBG;
  lodEdlSource.effectsBindGroupLayout =
    cache.sharedLayouts.effectsBindGroupLayout;
  cache.lodEdlSource = lodEdlSource;
  (cache.lodCommand as { _edlSource?: PointCloudEDLSource })._edlSource =
    lodEdlSource;
  (cache.lodCommand as { enabled?: boolean }).enabled = true;

  commandList.push(cache.lodCommand);
  return true;
}

/**
 * Upload prev positions to the LOD prev SSBO, build (or fetch) the LOD velocity
 * pipeline, attach `velocityCommand` to `cache.lodCommand`. Same
 * `cache.instanceData` / `cache.prevInstanceData` lifecycle as the default-path
 * helper — both share the CPU mirror and the prev-promotion happens in the
 * default-path helper after both paths' velocity commands are wired.
 *
 * Skips entirely when TAA is off and no prev SSBO has been allocated
 * yet — keeps the off-path zero-cost.
 * @private
 */
function attachLODPointCloudVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: PointCloudCache,
  lodProcessor: WebGPUPointCloudLODProcessorInstance,
): void {
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!taaEnabledThisFrame) {
    if (cache.lodCommand) {
      (cache.lodCommand as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
    cache.prevInstanceData = cache.instanceData;
    cache.lodPrevBufferRevision = undefined;
    return;
  }
  if (!cache.instanceBuffer || cache.instanceCount === 0) {
    return;
  }

  const requiredBytes = cache.instanceCount * 40;
  // Allocate / grow the LOD prev SSBO to match the current instance
  // count. Same usage flags as the regular LOD instance buffer
  // (STORAGE for the velocity VS to read, COPY_DST for writeBuffer).
  if (
    !cache.lodPrevInstanceBuffer ||
    cache.lodPrevInstanceBuffer.size < requiredBytes
  ) {
    if (cache.lodPrevInstanceBuffer) {
      cache.lodPrevInstanceBuffer.destroy();
    }
    cache.lodPrevInstanceBuffer = device.createBuffer({
      label: "PointCloud LOD prev instances",
      size: requiredBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Storage BG references the prev SSBO; rebuild on size change.
    cache.lodVelocityBindGroup = null;
    // Resident revision points at the destroyed buffer; re-seed.
    cache.lodPrevBufferRevision = undefined;
  }

  // Revision-skip + GPU self-copy on the LOD storage prev SSBO (own realloc
  // lifecycle, own resident marker). Same three-branch shape as the default
  // path; `instanceBuffer` is the shared current-frame source and already
  // carries the identical bytes for static content, so the identity case is a
  // one-time GPU copy then skip.
  const prevSrc = cache.prevInstanceData;
  const isIdentity = prevSrc === cache.instanceData;
  if (
    isIdentity &&
    cache.lodPrevInstanceBuffer &&
    cache.lodPrevInstanceBuffer.size >= requiredBytes
  ) {
    if (cache.lodPrevBufferRevision !== cache.instanceDataRevision) {
      copyPointCloudBuffer(
        context,
        device,
        "PointCloud LOD prev identity-seed",
        cache.instanceBuffer,
        cache.lodPrevInstanceBuffer,
        requiredBytes,
      );
      cache.lodPrevBufferRevision = cache.instanceDataRevision;
    }
    // else: static & already resident → NOTHING.
  } else if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    device.queue.writeBuffer(
      cache.lodPrevInstanceBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
    cache.lodPrevBufferRevision = undefined;
  } else {
    copyPointCloudBuffer(
      context,
      device,
      "PointCloud LOD prev seed",
      cache.instanceBuffer,
      cache.lodPrevInstanceBuffer,
      requiredBytes,
    );
    cache.lodPrevBufferRevision = undefined;
  }

  // Lazy LOD velocity pipeline build.
  if (!cache.lodVelocityPipelineEntry && cache.lodDefaultBgl) {
    const built = _buildLODVelocityPipelineDescriptor(cache.sharedLayouts);
    cache.lodVelocityPipelineEntry = {
      descriptor: built.descriptor,
      pipeline: null,
      pending: false,
    };
    cache.lodVelocityStorageBGL = built.storageBGL;
  }
  if (
    cache.lodVelocityPipelineEntry &&
    !cache.lodVelocityPipelineEntry.pipeline
  ) {
    tryResolvePointCloudPipeline(
      device,
      (
        context as unknown as {
          webgpuPipelineCache?: WebGPURenderPipelineCache | null;
        }
      ).webgpuPipelineCache ?? null,
      cache.lodVelocityPipelineEntry,
    );
  }

  // Build the LOD velocity storage bind group (curr SSBO +
  // visibleIndices + prev SSBO). Rebuilt whenever the prev buffer is
  // re-allocated (size change) or visibleIndices ref changes — the
  // regular `lodStorageBindGroup` rebuild trigger sets
  // `lodVelocityBindGroup` null too via our cache lookup below.
  // Note: `lodStorageBindGroup` already references the current
  // visibleIndices buf, so we read the same underlying buffer ref.
  // The regular LOD path's storage bind group invalidation is in
  // `_runGPULODPath` (sets `cache.lodStorageBindGroup = null` when
  // upload happens); we mirror that for the velocity BG by tying both
  // invalidations together.
  if (
    !cache.lodVelocityBindGroup &&
    cache.lodVelocityStorageBGL &&
    cache.instanceBuffer &&
    cache.lodPrevInstanceBuffer
  ) {
    if (lodProcessor.visibleIndicesBuffer) {
      cache.lodVelocityBindGroup = device.createBindGroup({
        label: "PointCloud LOD velocity storage BG",
        layout: cache.lodVelocityStorageBGL,
        entries: [
          { binding: 0, resource: { buffer: cache.instanceBuffer } },
          {
            binding: 1,
            resource: { buffer: lodProcessor.visibleIndicesBuffer },
          },
          { binding: 2, resource: { buffer: cache.lodPrevInstanceBuffer } },
        ],
      });
    }
  }

  if (
    cache.lodCommand &&
    cache.lodVelocityPipelineEntry?.pipeline &&
    cache.lodVelocityBindGroup &&
    cache.lodIndirectBuffer
  ) {
    // Match the LOD color pipeline's 3-BGL layout. Velocity entry doesn't
    // sample atmosphere; placeholder is safe — WGSL allows unused bindings.
    const lodVelocityEffectsBG = getPlaceholderEffects(device).bindGroup;
    if (!cache.lodVelocityCommand) {
      cache.lodVelocityCommand = new WebGPUDrawCommand({
        pipeline: cache.lodVelocityPipelineEntry.pipeline,
        bindGroups: [
          cache.bindGroup,
          cache.lodVelocityBindGroup,
          lodVelocityEffectsBG,
        ],
        vertexBuffers: [cache.quadVertexBuffer],
        vertexCount: 6,
        instanceCount: 0, // filled by drawIndirect
        pass: Pass.OPAQUE,
        drawIndirectBuffer: cache.lodIndirectBuffer,
      });
    } else {
      const velocityCommand = cache.lodVelocityCommand as {
        pipeline?: GPURenderPipeline;
        bindGroups?: Array<GPUBindGroup | null>;
        vertexBuffers?: Array<GPUBuffer | null>;
        drawIndirectBuffer?: GPUBuffer;
      };
      velocityCommand.pipeline = cache.lodVelocityPipelineEntry.pipeline;
      velocityCommand.bindGroups ??= [];
      velocityCommand.bindGroups[0] = cache.bindGroup;
      velocityCommand.bindGroups[1] = cache.lodVelocityBindGroup;
      velocityCommand.bindGroups[2] = lodVelocityEffectsBG;
      velocityCommand.vertexBuffers ??= [];
      velocityCommand.vertexBuffers[0] = cache.quadVertexBuffer;
      velocityCommand.drawIndirectBuffer = cache.lodIndirectBuffer;
    }
    (cache.lodCommand as { velocityCommand?: unknown }).velocityCommand =
      cache.lodVelocityCommand;
  } else if (cache.lodCommand) {
    (cache.lodCommand as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }

  // Promote `instanceData` → `prevInstanceData` for next frame. Same
  // logic as the default-path helper; safe to call here even if both
  // helpers run in the same frame (the assignment is idempotent —
  // both paths see the same `cache.instanceData`).
  if (cache.instanceData) {
    cache.prevInstanceData = cache.instanceData;
  }
}

/**
 * Build the LOD-variant pipeline and both bind group layouts:
 *   group 0 (bgl):        uniform buffer
 *   group 1 (storageBGL): instanceData (storage, read) + visibleIndices (storage, read)
 */
/**
 * Build the cache-friendly descriptor for the LOD-path PointCloud
 * pipeline (storage-backed instance lookup via `visibleIndices`).
 * Materializes through the central pipeline cache.
 *
 * @private
 */
function _buildLODPipelineDescriptor(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  translucent: boolean,
  sharedLayouts: ReturnType<typeof getWebGPUPointCloudSharedLayouts>,
): {
  descriptor: WebGPURenderPipelineDescriptor;
  bgl: GPUBindGroupLayout;
  storageBGL: GPUBindGroupLayout;
} {
  const moduleCache = getPointCloudShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.POINT_CLOUD_LOD,
    POINT_CLOUD_LOD_WGSL,
    0,
    "PointCloud LOD shader",
  );
  const bgl = sharedLayouts.uniformBindGroupLayout;
  const storageBGL = sharedLayouts.lodStorageBindGroupLayout;
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: `PointCloud LOD Pipeline [${format}/ms=${sampleCount}/${
      translucent ? "translucent" : "opaque"
    }]`,
    layout: sharedLayouts.lodPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMainLOD",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMainLOD",
      // Match the default path: no blend state for opaque, standard alpha
      // blending only for content whose effective color can be translucent.
      targets: makeSceneFBTargets(
        format,
        translucent ? { translucent: true } : {},
      ),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: !translucent,
      depthCompare: "less-equal",
    },
    // Match the scene framebuffer's MSAA sample count (see buildPipelineDescriptor).
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
  return { descriptor, bgl, storageBGL };
}

/**
 * LOD velocity pipeline. Three storage bindings (curr instance + visibleIndices
 * + prev instance) instead of the regular LOD pipeline's two; emits to
 * rg16float matching the default-path velocity descriptor.
 *
 * Storage BGL is separate from the regular LOD pipeline's storageBGL
 * because that one only declares 2 bindings — a 3-binding BGL with a
 * 2-binding pipeline would fail validation, so we keep them split.
 * The uniform BGL (group 0) is shared.
 * @private
 */
function _buildLODVelocityPipelineDescriptor(
  sharedLayouts: ReturnType<typeof getWebGPUPointCloudSharedLayouts>,
): {
  descriptor: WebGPURenderPipelineDescriptor;
  storageBGL: GPUBindGroupLayout;
} {
  const device = sharedLayouts.device;
  const moduleCache = getPointCloudShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.POINT_CLOUD_LOD,
    POINT_CLOUD_LOD_WGSL,
    0,
    "PointCloud LOD shader",
  );
  const storageBGL = sharedLayouts.lodVelocityStorageBindGroupLayout;
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: "PointCloud LOD velocity pipeline",
    layout: sharedLayouts.lodVelocityPipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMainLOD",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMainLOD",
      targets: [{ format: "rg16float" as GPUTextureFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };
  return { descriptor, storageBGL };
}

function destroyWebGPUPointCloudResources(pointCloud: PointCloudLike): void {
  const cache = pointCloud._webgpuCache as PointCloudCache | undefined;
  if (!cache) {
    return;
  }
  // Detach an in-flight fork before clearing the owner cache; its completion
  // handler observes the mismatch and destroys the late stream immediately.
  cache.lodProcessorPromise = null;
  cache.lodProcessor?.destroy();
  cache.lodProcessor = null;
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  cache.prevInstanceBuffer?.destroy();
  cache.lodPrevInstanceBuffer?.destroy();
  cache.lodIndirectBuffer?.destroy();
  // Pipelines / bind groups / layouts are GC'd when references drop. The
  // context template remains shared; only this owner's mutable LOD stream was
  // destroyed above.
  pointCloud._webgpuCache = undefined;
}

/** True only after this owner's current-generation resources can emit a draw. */
function isWebGPUPointCloudReady(pointCloud: PointCloudLike): boolean {
  const cache = pointCloud._webgpuCache as PointCloudCache | undefined;
  const currentGeneration = cache
    ? ((cache.context as unknown as { resourceGeneration?: number })
        .resourceGeneration ?? 0)
    : -1;
  if (
    !cache ||
    cache.context.device !== cache.device ||
    cache.resourceGeneration !== currentGeneration ||
    !cache.initialized ||
    !cache.uniformBuffer ||
    !cache.bindGroup ||
    !cache.quadVertexBuffer ||
    !cache.instanceBuffer ||
    !cache.pipeline
  ) {
    return false;
  }
  return (
    cache.instanceCount === 0 ||
    cache.command !== null ||
    cache.lodCommand !== null
  );
}

export {
  updateWebGPUPointCloud,
  isWebGPUPointCloudReady,
  destroyWebGPUPointCloudResources,
};
export default {
  updateWebGPUPointCloud,
  isWebGPUPointCloudReady,
  destroyWebGPUPointCloudResources,
};
