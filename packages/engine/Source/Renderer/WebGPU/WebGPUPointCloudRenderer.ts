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
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import type { WebGPUPointCloudLODProcessorInstance } from "./WebGPUPointCloudLODProcessor.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
import { getOrCreateSharedAdvancedEffectsBG } from "./WebGPUPrimitiveCommands.js";
// Slice 5c-B Phase 1 (Batch 112) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

// Per-device shader module cache so multiple PointClouds on the same
// `GPUDevice` share one compiled `GPUShaderModule` per source.
// (C-R7-SHADER-MODULE-DEDUP, Batch 74.)
const _pointCloudShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

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
  positions?: Float32Array;
  colors?: Uint8Array | Float32Array;
}

interface PointCloudLike {
  _webgpuCache?: CesiumOpaqueObject | PointCloudCache | undefined;
  _parsedContent?: PointCloudParsedContent;
  _pointCloud?: { _parsedContent?: PointCloudParsedContent };
  _pointsLength?: number;
  enableGPULOD?: boolean;
  modelMatrix?: CesiumMatrix4;
  lodFarDistance?: number;
  geometricError?: number;
  // Allow pass-through for anything else the buildInstanceBuffer /
  // frustum extraction paths read — keeps the typed surface minimal
  // while preserving the upstream escape hatch.
  [key: string]: unknown;
}

interface PointCloudPipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
}

interface PointCloudCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;

  // C-R7-RENDERER-MIGRATION (Batch 74). Default-path pipeline now
  // resolves through `webgpuPipelineCache`; the entry slot holds the
  // descriptor + the in-flight tracking flag. Two PointCloud instances
  // sharing the same canvas format now share a single pipeline.
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
  lodBindGroupLayout: GPUBindGroupLayout | null;
  lodStorageBindGroup: GPUBindGroup | null;
  lodIndirectBuffer: GPUBuffer | null;
  lodPositionsX: Float32Array | null;
  lodPositionsY: Float32Array | null;
  lodPositionsZ: Float32Array | null;
  lodUploadedRevision: number;
  lodCommand: CesiumAnyDrawCommand | null;
  lodActive: boolean;

  // C-R7-RENDERER-MIGRATION (Batch 74) — same pattern for the LOD
  // pipeline. Held alongside the LOD pipeline slot so the resolve helper
  // can re-resolve every frame until the pipeline materializes.
  lodPipelineEntry: PointCloudPipelineEntry | null;
  lodDefaultBgl: GPUBindGroupLayout | null;

  // Batch 168 - B.10 NEW-ADVANCED-MOTION-VECTORS (PointCloud).
  // Per-particle prev-position mirror of `instanceBuffer` so the velocity
  // VS reads (current, previous) position pairs from two parallel
  // 40-byte instance streams. Same lifecycle as PointPrimitive's
  // `prevInstanceBuffer` (Batch 148): captured before the GPU instance
  // upload, retained one-frame-lagged. NULL when no animated point cloud
  // has been seen on this device yet (TAA off-path stays cheap).
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
  // data (PointPrimitive Batch 148 pattern). For the typical static
  // 3D-Tiles point cloud both refs point at the same Float32Array so
  // velocity stays zero; for animated content where each frame
  // re-runs `buildInstanceBuffer`, this captures the actual per-frame
  // delta.
  prevInstanceData: Float32Array | null;
  // Lazy velocity pipeline. Builds the first frame TAA is on; cached
  // thereafter. Cleared on format invalidation.
  velocityPipelineEntry: PointCloudPipelineEntry | null;

  // Batch 169 - B.10 NEW-ADVANCED-MOTION-VECTORS LOD path. Parallel
  // storage buffer mirroring `instanceBuffer` with the PREVIOUS
  // frame's interleaved data. Same 40-byte stride; only positions
  // (floats 0-5) are read by the LOD velocity VS.
  lodPrevInstanceBuffer: GPUBuffer | null;
  // Lazy LOD velocity pipeline. Has its own descriptor (storageBGL
  // includes binding 2 for prev SSBO; the regular LOD pipeline only
  // declares bindings 0-1, so a different BGL is needed). Resolved on
  // the first LOD-active TAA frame.
  lodVelocityPipelineEntry: PointCloudPipelineEntry | null;
  lodVelocityBindGroup: GPUBindGroup | null;
  lodVelocityStorageBGL: GPUBindGroupLayout | null;
}

const POINT_CLOUD_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndSize: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
  // FEAT-GAP-09 (Batch 103 audit fix) — point-center RTE position
  // for the aerial-perspective fog block. Per-quad-vertex spread is
  // tiny (~point size in pixels) relative to fog scale.
  @location(2) worldPos: vec3<f32>,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Consumed by Batch 168's per-particle motion-vector pass.
  prevViewProjection: mat4x4<f32>,
  // Batch 168 - B.10 NEW-ADVANCED-MOTION-VECTORS. Model matrix (no
  // translation zeroing) lifts prev model-space positions to world
  // space before applying prevVP. CPU packs pointCloud.modelMatrix
  // directly; static for typical 3D-Tiles content (modelMatrix locked
  // at tile-content load) so velocity stays at zero in the common case.
  modelMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

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
  let pointSize = input.colorAndSize.a * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndSize.rgb;
  output.pointUV = input.quadVertex;
  // FEAT-GAP-09 (Batch 103) — point-center RTE for fog block.
  output.worldPos = posRTE;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  var finalColor = vec4<f32>(input.color, alpha);

  // FEAT-GAP-09 (Batch 103) — Aerial-perspective fog blend.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    let cameraWC = u.encodedCameraHigh + u.encodedCameraLow;
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

  return finalColor;
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
  @location(3) colorAndSize: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter.
  @location(4) prevPositionHigh: vec3<f32>,
  @location(5) prevPositionLow: vec3<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  // Current-frame center clip via RTE (matches vertexMain math).
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Previous-frame center clip via full prev VP. Prev positions are in
  // model space (same as current); lift to world space via current
  // modelMatrix (acceptable approximation for the static-modelMatrix
  // case which dominates 3D-Tiles point cloud content), then apply
  // prevViewProjection to land in prev clip space.
  let prevModelPos = vec4<f32>(
    input.prevPositionHigh + input.prevPositionLow, 1.0,
  );
  let prevWorldPos = u.modelMatrix * prevModelPos;
  let prevCenterClip = u.prevViewProjection * prevWorldPos;
  // Rasterize quad at the current center using the existing pixel-size
  // expansion so the velocity texture covers the same screen pixels.
  let pointSize = input.colorAndSize.a * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * currCenterClip.w;
  let py = pointSize / u.viewportSize.y * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  return output;
}

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> @location(0) vec2<f32> {
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
// path's vertex buffer (posHigh(12) + posLow(12) + colorAndSize(16)).
// WGSL's `array<vec3<f32>>` would add 16-byte alignment padding that
// breaks that packing, so we declare the storage as `array<f32>` and
// index manually at 10 floats per instance. This lets us reuse the
// exact same GPUBuffer for both paths — `buildInstanceBuffer` only
// needs to OR in `STORAGE` usage when GPU LOD is potentially on.
const POINT_CLOUD_LOD_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
  // FEAT-GAP-09 (Batch 104) — point-center RTE position for the
  // aerial-perspective fog block.
  @location(2) worldPos: vec3<f32>,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection.
  prevViewProjection: mat4x4<f32>,
  // Batch 168 - matches the default-path UBO layout. Used by the
  // velocity VS (Batch 169) to lift prev model-space positions to
  // world space; the regular LOD VS doesn't read it.
  modelMatrix: mat4x4<f32>,
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
// read by the velocity VS — color/size are ignored. Bound at slot 2
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
  let color = vec3<f32>(
    instanceData[base + 6u],
    instanceData[base + 7u],
    instanceData[base + 8u],
  );
  let size = instanceData[base + 9u];
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pointSize = size * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + quadVertex.x * px;
  fp.y = fp.y + quadVertex.y * py;
  output.position = fp;
  output.color = color;
  output.pointUV = quadVertex;
  // FEAT-GAP-09 (Batch 104) — point-center RTE for fog block.
  output.worldPos = posRTE;
  return output;
}

@fragment
fn fragmentMainLOD(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  var finalColor = vec4<f32>(input.color, alpha);

  // FEAT-GAP-09 (Batch 104) — Aerial-perspective fog blend. Same
  // body as the default POINT_CLOUD_WGSL::fragmentMain.
  if (effects.atmosphereLutControl.x > 0.5) {
    let innerRadius = effects.atmosphereLutControl.y;
    let thickness = max(1.0, effects.atmosphereLutControl.z);
    let cameraWC = u.encodedCameraHigh + u.encodedCameraLow;
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

  return finalColor;
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
  let size = instanceData[base + 9u];
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);

  // Previous-frame center clip via prevVP × modelMatrix × prevModelPos.
  // Prev positions live in the parallel SSBO at the SAME source index
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
  let prevModelPos = vec4<f32>(prevPosHigh + prevPosLow, 1.0);
  let prevWorldPos = u.modelMatrix * prevModelPos;
  let prevCenterClip = u.prevViewProjection * prevWorldPos;

  // Rasterize quad at the current center using the existing pixel-size
  // expansion so the velocity texture covers the same screen pixels.
  let pointSize = size * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * currCenterClip.w;
  let py = pointSize / u.viewportSize.y * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + quadVertex.x * px;
  fp.y = fp.y + quadVertex.y * py;
  output.position = fp;
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  return output;
}

@fragment
fn fragmentVelocityMainLOD(input: VelocityVertexOutputLOD) -> @location(0) vec2<f32> {
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
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

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
 * C-R7-RENDERER-MIGRATION (Batch 74).
 * @private
 */
function buildPipelineDescriptor(
  device: GPUDevice,
  format: GPUTextureFormat,
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
  const bgl = makeBindGroupLayout(device, "PointCloud BGL", [
    uniformBuffer(0, Stage.VERTEX),
  ]);
  // FEAT-GAP-09 (Batch 102) — append the shared effects BGL at slot 1
  // so the WGSL fog block at @group(1) resolves. Shared layout
  // cascades through to all PointCloud variants (LOD, velocity, EDL)
  // since they reuse this descriptor's `layout` field.
  const effectsBGL = getEffectsBindGroupLayout(device);
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: `PointCloud pipeline [${format}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bgl, effectsBGL],
    }),
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
      // Slice 5c-B Phase 1 (Batch 112) — scene-FB color target via
      // helper. Verbatim blend preserves the (no-`operation`) shape.
      // Used for BOTH default `fragmentMain` and LOD `fragmentMainLOD`
      // color pipelines; velocity pipelines at lines ~836 + ~2107
      // (rg16float) stay single-target.
      targets: makeSceneFBTargets(format, {
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
  };
  return { descriptor, shaderModule, bgl };
}

/**
 * Batch 168 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity pipeline.
 * Same UBO BGL as the color path; vertex layout adds a second
 * 40-byte instance buffer at slot 1 carrying prev-frame positions
 * (locations 4 and 5). Outputs to rg16float matching the TAA
 * dispatcher's velocity texture format.
 * @private
 */
function buildVelocityPipelineDescriptor(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  bgl: GPUBindGroupLayout,
): WebGPURenderPipelineDescriptor {
  // FEAT-GAP-09 (Batch 102) — match the color pipeline's 2-BGL layout
  // (uniforms + effects). Velocity entry doesn't sample atmosphere
  // bindings, but the layout shape must match what the WGSL module
  // expects, so we append the effects BGL here too.
  const effectsBGL = getEffectsBindGroupLayout(device);
  const layout = device.createPipelineLayout({
    label: "PointCloud velocity pipeline layout",
    bindGroupLayouts: [bgl, effectsBGL],
  });
  return {
    name: "PointCloud velocity pipeline",
    layout,
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
          // Batch 168 - prev-position stream. Same 40-byte stride; only
          // positions are read (locations 4-5). Color/size at offset 24
          // is ignored by `vertexVelocityMain`.
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
 * C-R7-RENDERER-MIGRATION (Batch 74). Mirrors `tryResolvePolylinePipeline`.
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
          entry.pending = false;
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

function buildInstanceBuffer(
  device: GPUDevice,
  pointCloud: PointCloudLike,
  modelMatrix: Matrix4 | CesiumMatrix4,
  allowStorage: boolean,
): {
  buffer: GPUBuffer;
  count: number;
  // SOA world-space positions for the GPU LOD processor. Only populated
  // when `allowStorage` is true — saves 12 MB/million points otherwise.
  worldX: Float32Array | null;
  worldY: Float32Array | null;
  worldZ: Float32Array | null;
  // Batch 168 - retained interleaved instance data so the velocity
  // path can mirror it into the prev-instance GPU buffer per frame.
  // Same lifecycle as the GPU buffer (rebuilt on revision change).
  instanceData: Float32Array;
} {
  // Read point positions, colors from pointCloud._drawCommand or _parsedContent
  const parsedContent =
    pointCloud._parsedContent || pointCloud._pointCloud?._parsedContent;
  if (!parsedContent || !parsedContent.positions) {
    return {
      buffer: device.createBuffer({ size: 40, usage: GPUBufferUsage.VERTEX }),
      count: 0,
      worldX: null,
      worldY: null,
      worldZ: null,
      instanceData: new Float32Array(0),
    };
  }

  const positions = parsedContent.positions;
  const colors = parsedContent.colors;
  const pointCount = positions.length / 3;
  // 40 bytes per instance: posHigh(12) + posLow(12) + colorAndSize(16)
  const data = new Float32Array(pointCount * 10);

  // World-space SOA arrays used by the LOD processor. Allocated only
  // when the caller plans to potentially activate GPU LOD — the
  // storage adds 12 bytes/point in CPU memory which isn't free.
  const worldX = allowStorage ? new Float32Array(pointCount) : null;
  const worldY = allowStorage ? new Float32Array(pointCount) : null;
  const worldZ = allowStorage ? new Float32Array(pointCount) : null;

  const worldPosScratch = new Cartesian3();
  const srcPosScratch = new Cartesian3();

  for (let i = 0; i < pointCount; i++) {
    srcPosScratch.x = positions[i * 3];
    srcPosScratch.y = positions[i * 3 + 1];
    srcPosScratch.z = positions[i * 3 + 2];

    // Transform to world space
    Matrix4.multiplyByPoint(modelMatrix, srcPosScratch, worldPosScratch);
    EncodedCartesian3.fromCartesian(worldPosScratch, scratchEncoded);

    if (worldX) {
      worldX[i] = worldPosScratch.x;
      worldY![i] = worldPosScratch.y;
      worldZ![i] = worldPosScratch.z;
    }

    const off = i * 10;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;

    // Color (normalized) + size
    if (colors && colors.length >= pointCount * 3) {
      const cn = colors instanceof Uint8Array ? 1.0 / 255.0 : 1.0;
      data[off + 6] = colors[i * 3] * cn;
      data[off + 7] = colors[i * 3 + 1] * cn;
      data[off + 8] = colors[i * 3 + 2] * cn;
    } else {
      data[off + 6] = 1.0;
      data[off + 7] = 1.0;
      data[off + 8] = 1.0;
    }
    data[off + 9] = 3.0; // default point size
  }

  // When GPU LOD might activate, OR in STORAGE usage so the same buffer
  // can back both the VB-instanced default path and the storage-backed
  // LOD path without duplicating 40 bytes/point of GPU memory.
  let usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
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
    worldX,
    worldY,
    worldZ,
    // Batch 168 - hand the interleaved data back so the velocity path
    // can keep a CPU-side prev mirror across the rebuild boundary.
    instanceData: data,
  };
}

function packUniforms(
  uniformState: CesiumUniformState,
  modelMatrix: Matrix4 | CesiumMatrix4,
): Float32Array {
  // Batch 168 - bumped from 44 → 60 floats (240 bytes) to fit the
  // trailing `modelMatrix: mat4x4<f32>` used by the velocity VS to
  // lift prev model-space positions to world space. UBO is allocated
  // at 256 bytes; still fits with 16 spare bytes.
  const data = new Float32Array(60);
  const view = uniformState.view;
  const projection = uniformState.projection;

  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  const mvRte = Matrix4.multiply(view, modelMatrix, scratchMVRTE);
  mvRte[12] = 0;
  mvRte[13] = 0;
  mvRte[14] = 0;
  const mvp = m4Values(Matrix4.multiply(projection, mvRte, scratchMVP));
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }

  const camWorld = uniformState.cameraPosition;
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncoded);
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;

  const canvas = uniformState._context?._canvas || {
    width: 1920,
    height: 1080,
  };
  data[24] = canvas.width;
  data[25] = canvas.height;
  data[26] = 1.0; // pointSizeMultiplier
  data[27] = 0; // pad

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at floats
  // 28..43. UniformState swaps `_previousViewProjection := viewProjection`
  // at the END of `update()` AFTER returning the prior frame's value, so
  // on frame N this slot holds frame N-1's VP. First frame falls through
  // to identity.
  const prevVP = (uniformState as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 28);
  } else {
    data[28] = 1;
    data[29] = 0;
    data[30] = 0;
    data[31] = 0;
    data[32] = 0;
    data[33] = 1;
    data[34] = 0;
    data[35] = 0;
    data[36] = 0;
    data[37] = 0;
    data[38] = 1;
    data[39] = 0;
    data[40] = 0;
    data[41] = 0;
    data[42] = 0;
    data[43] = 1;
  }

  // Batch 168 - modelMatrix at floats 44..59. The velocity VS lifts
  // prev model-space positions to world space via this, then applies
  // prevVP to land in prev clip space. CPU passes the Cesium
  // `pointCloud.modelMatrix` directly (no translation zeroing - the
  // velocity path needs the full transform, not the RTE-zeroed one).
  Matrix4.pack(modelMatrix as Matrix4, data, 44);
  return data;
}

function updateWebGPUPointCloud(
  pointCloud: PointCloudLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!pointCloud._webgpuCache) {
    pointCloud._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      instanceBuffer: null,
      instanceCount: 0,
      command: null,
      initialized: false,
      lastRevision: -1,
      lodPipeline: null,
      lodBindGroupLayout: null,
      lodStorageBindGroup: null,
      lodIndirectBuffer: null,
      lodPositionsX: null,
      lodPositionsY: null,
      lodPositionsZ: null,
      lodUploadedRevision: -1,
      lodCommand: null,
      lodActive: false,
      // Batch 168 - velocity pipeline + prev-instance buffer (lazy).
      prevInstanceBuffer: null,
      instanceData: null,
      prevInstanceData: null,
      velocityPipelineEntry: null,
      // Batch 169 - LOD-path velocity (parallel SSBO + LOD velocity VS).
      lodPrevInstanceBuffer: null,
      lodVelocityPipelineEntry: null,
      lodVelocityBindGroup: null,
      lodVelocityStorageBGL: null,
    } as PointCloudCache;
  }

  const cache = pointCloud._webgpuCache as PointCloudCache;
  // Batch 110 — point cloud draws into scene FB; use scenePipelineFormat.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Batch 110 — invalidate cached pipeline on scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache.initialized &&
    (cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen
  ) {
    cache.initialized = false;
    cache.pipelineEntry = null;
    cache.pipeline = null;
    // Batch 168 - velocity pipeline references the same shader module
    // built against the now-invalid format; force rebuild.
    cache.velocityPipelineEntry = null;
    // Batch 169 - the cached draw commands hold a pointer to the
    // OLD pipeline. After the resolver re-runs against the new
    // format the pipeline pointer changes; the command must be
    // re-built so its `pipeline` field points at the live object.
    // Pre-Batch-169 the command survived a format change and would
    // be submitted with the stale pipeline reference (WebGPU then
    // rejects the draw because the pipeline's color target format
    // doesn't match the active attachment). Not user-visible because
    // HDR isn't toggled at runtime, but matches the Ground{Primitive,
    // Polyline} fix that landed pre-Batch-166.
    cache.command = null;
    cache.lodCommand = null;
    cache.lodPipeline = null;
    cache.lodPipelineEntry = null;
    // Batch 169 - LOD velocity pipeline targets rg16float which is
    // format-invariant, but we rebuild it alongside the LOD color
    // pipeline so the storageBGL and bindings stay consistent across
    // any future format-aware fields. Cheap reset.
    cache.lodVelocityPipelineEntry = null;
    cache.lodVelocityBindGroup = null;
    cache.lodVelocityStorageBGL = null;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // C-R7 (Batch 74) — descriptor + central pipeline cache. Two
    // PointCloud instances at the same canvas format share one pipeline.
    const built = buildPipelineDescriptor(device, canvasFormat);
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

    cache.quadVertexBuffer = createQuadVB(device);
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
  // `context.pointCloudLOD` is typed as `object | null` on the
  // backend-agnostic `CesiumGraphicsContext` surface — cast to the real
  // processor interface at the boundary. Doing the cast here once
  // avoids scattering `as unknown as …` through the hot path below.
  const lodProcessor = optIn
    ? ((context.pointCloudLOD as WebGPUPointCloudLODProcessorInstance | null) ??
      null)
    : null;
  const lodPossible =
    optIn && pointCount >= POINT_COUNT_LOD_THRESHOLD && lodProcessor !== null;

  // Rebuild instance data when point data changes. When LOD might be
  // active we need STORAGE usage on the buffer AND the SOA world-space
  // arrays for the LOD processor; we speculatively build both whenever
  // the opt-in flag is set so flipping enableGPULOD mid-session doesn't
  // require a rebuild.
  const modelMatrix = pointCloud.modelMatrix ?? Matrix4.IDENTITY;
  const revision = pointCount;
  if (revision !== cache.lastRevision || !cache.instanceBuffer) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, pointCloud, modelMatrix, optIn);
    cache.instanceBuffer = result.buffer;
    cache.instanceCount = result.count;
    cache.lastRevision = revision;
    cache.lodPositionsX = result.worldX;
    cache.lodPositionsY = result.worldY;
    cache.lodPositionsZ = result.worldZ;
    // Batch 169 - track THIS frame's instance data. The velocity helper
    // promotes this to `prevInstanceData` AFTER its dispatch so next
    // frame's prev tracks the previous frame's data (PointPrimitive
    // Batch 148 pattern). Do NOT clobber `prevInstanceData` here on
    // revision change — that would force velocity=0 every revision
    // and miss per-frame animation deltas. The size-mismatch case
    // (point count changed across revision) is handled by the
    // byteLength check in attachPointCloudVelocityCommand: when prev
    // is shorter/longer than curr, the GPU self-copy fallback fires
    // and emits velocity=0 for the discontinuity (correct — no
    // continuous index correspondence between OLD and NEW points).
    cache.instanceData = result.instanceData;
    cache.command = null;
    cache.lodCommand = null;
    cache.lodStorageBindGroup = null;
    cache.lodUploadedRevision = -1;
    // Batch 169 - velocity bind group references the (now-destroyed)
    // instance buffer; force rebuild on the next frame's velocity
    // attach. lodPrevInstanceBuffer also references stale data; the
    // size-allocation check inside the LOD velocity helper resizes
    // it (the byteLength comparison in the prev-upload step then
    // emits velocity = 0 for the seed/revision-change frame).
    cache.lodVelocityBindGroup = null;
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Per-frame uniforms
  const uniforms = packUniforms(context.uniformState, modelMatrix);
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(uniforms));

  // ── Fast path: opt-in + above threshold + processor ready ──
  if (
    lodPossible &&
    lodProcessor!.isReady &&
    cache.lodPositionsX &&
    cache.lodPositionsY &&
    cache.lodPositionsZ
  ) {
    _runGPULODPath(
      device,
      context,
      frameState,
      commandList,
      cache,
      lodProcessor!,
      pointCloud,
      modelMatrix,
      canvasFormat,
    );
    return;
  }

  // ── Default path (current behaviour, untouched) ──
  // C-R7 (Batch 74) — skip the draw if the pipeline is still
  // materializing in the central cache. It'll be ready by next frame.
  if (!cache.pipeline) {
    return;
  }
  // FEAT-GAP-09 (Batch 102) — per-frame effects BG refresh. Shared
  // helper caches per-frame and returns the placeholder when none of
  // (shadow, csm, atmosphereLut) is active.
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
      pass: Pass.OPAQUE,
    });
  } else {
    (cache.command as { bindGroups?: GPUBindGroup[] }).bindGroups = [
      cache.bindGroup,
      effectsBG,
    ];
  }

  // Batch 168 - B.10 NEW-ADVANCED-MOTION-VECTORS. Maintain a
  // one-frame-lagged mirror of the instance buffer so the velocity VS
  // can read (current, previous) position pairs. Only allocates the
  // GPU buffer when TAA is enabled this frame (or has ever been since
  // boot — we keep the buffer once allocated so toggling TAA off→on
  // doesn't lose a frame of history).
  attachPointCloudVelocityCommand(
    device,
    context,
    frameState,
    cache,
    canvasFormat,
  );

  commandList.push(cache.command);
}

/**
 * Batch 168 - upload prev positions, build (or fetch) the velocity
 * pipeline, attach `velocityCommand` to the cache's color command. The
 * TAA pass walks the command list for `cmd.velocityCommand` and
 * dispatches it into the rg16float velocity texture. Mirrors the
 * Billboard/Point pattern (Batches 143/148).
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
  if (!taaEnabledThisFrame && !cache.prevInstanceBuffer) {
    if (cache.command) {
      (cache.command as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
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
  const prevSrc = cache.prevInstanceData;
  if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    device.queue.writeBuffer(
      cache.prevInstanceBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
  } else {
    // First-frame seed OR revision-change point-count mismatch.
    // Either way the correct emission is velocity = 0 for this frame;
    // GPU self-copy ensures the prev buffer holds matching bytes so
    // the velocity VS reads (curr, curr) → 0 instead of garbage.
    const encoder = device.createCommandEncoder({
      label: "PointCloud prev seed",
    });
    encoder.copyBufferToBuffer(
      cache.instanceBuffer,
      0,
      cache.prevInstanceBuffer,
      0,
      requiredBytes,
    );
    device.queue.submit([encoder.finish()]);
  }

  // Lazy velocity pipeline build.
  if (!cache.velocityPipelineEntry && cache.shaderModule && cache.defaultBgl) {
    cache.velocityPipelineEntry = {
      descriptor: buildVelocityPipelineDescriptor(
        device,
        cache.shaderModule,
        cache.defaultBgl,
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
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
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
  } else if (cache.command) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }
  // Batch 169 - promote THIS frame's `instanceData` to next frame's
  // `prevInstanceData` AFTER the velocity command has been built (and
  // therefore captured a stable reference to the prev buffer's
  // contents). For static content `cache.instanceData` is the same
  // Float32Array as before — assignment is a no-op. For animated
  // content where the application re-runs `buildInstanceBuffer` each
  // frame, this rolls the per-frame delta forward correctly.
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
): void {
  // Build the LOD pipeline + storage BGL lazily. Both are per-device
  // not per-instance, but storing them on the cache is simpler than
  // a device-keyed shared map and point cloud instances are typically
  // few enough that the duplication doesn't matter.
  // C-R7 (Batch 74) — descriptor + central pipeline cache. Two
  // PointCloud instances on the same canvas format share one LOD
  // pipeline. Returns early without rendering when the pipeline is
  // still materializing — matches the existing `lodStorageBindGroup`
  // not-ready behavior below (one-frame visual gap, recovers next
  // frame).
  if (!cache.lodPipelineEntry) {
    const built = _buildLODPipelineDescriptor(device, canvasFormat);
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
      return;
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
    return;
  }

  // Build the frustum planes in world space. The LOD processor tests
  // `dot(plane.xyz, worldPos) + plane.w >= 0` per point.
  const frustumPlanes = _extractFrustumPlanes(context.uniformState, frameState);

  // Distance² thresholds derived from the camera/frustum far plane.
  // These are coarse — tiles with per-tile geometricError can override
  // by mutating pointCloud.lodDistances before the update.
  const far =
    pointCloud.lodFarDistance ?? frameState.camera?.frustum?.far ?? 1e7;
  const lod0 = far * 0.1;
  const lod1 = far * 0.25;
  const lod2 = far * 0.5;
  const lod3 = far;

  const camPos = context.uniformState.cameraPosition;
  const encoder = device.createCommandEncoder({
    label: "PointCloud LOD dispatch",
  });
  lodProcessor.dispatch(encoder, {
    cameraPositionWC: [camPos.x, camPos.y, camPos.z],
    lod0Distance2: lod0 * lod0,
    lod1Distance2: lod1 * lod1,
    lod2Distance2: lod2 * lod2,
    lod3Distance2: lod3 * lod3,
    frustumPlanes,
    pointCount: cache.instanceCount,
    maxVisiblePoints: cache.instanceCount,
    screenSpaceRadius: 1.0,
    geometricError: pointCloud.geometricError ?? 0.0,
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
  device.queue.submit([encoder.finish()]);

  // Emit a drawIndirect command. The scene renderer's execute path
  // recognizes `_drawIndirectBuffer` and routes through drawIndirect
  // instead of the default instanced draw.
  // FEAT-GAP-09 (Batch 104) — per-frame effects BG refresh for LOD
  // color command. Same helper as the default path; cached per frame
  // so this is cheap.
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
      pass: Pass.OPAQUE,
      drawIndirectBuffer: cache.lodIndirectBuffer,
    });
  } else {
    // FEAT-GAP-09 (Batch 104) — per-frame effects BG refresh on
    // cached command. Slot [2] is the LOD effects slot (after uniforms
    // at 0 and storage at 1).
    (cache.lodCommand as { bindGroups?: GPUBindGroup[] }).bindGroups = [
      cache.bindGroup,
      cache.lodStorageBindGroup,
      lodEffectsBG,
    ];
  }

  // Batch 169 - LOD-path velocity emission. Mirrors the default-path
  // attach helper: maintain a parallel prev SSBO, build the velocity
  // pipeline lazily, attach `velocityCommand` to the lodCommand. The
  // TAA pass walks the command list for `cmd.velocityCommand` and
  // dispatches it via drawIndirect (same indirect buffer as color).
  attachLODPointCloudVelocityCommand(device, context, frameState, cache);

  commandList.push(cache.lodCommand);
}

/**
 * Batch 169 - upload prev positions to the LOD prev SSBO, build (or
 * fetch) the LOD velocity pipeline, attach `velocityCommand` to
 * `cache.lodCommand`. Same `cache.instanceData` / `cache.prevInstanceData`
 * lifecycle as the default-path helper — both share the CPU mirror and
 * the prev-promotion happens in the default-path helper after both
 * paths' velocity commands are wired.
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
): void {
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!taaEnabledThisFrame && !cache.lodPrevInstanceBuffer) {
    if (cache.lodCommand) {
      (cache.lodCommand as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
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
  }

  // Upload prev frame's data. Same cases as the default-path helper:
  // first-frame seed OR revision-change point-count mismatch both
  // fall through to the GPU self-copy emitting velocity = 0. Static
  // 3D-Tiles content has prevInstanceData aliasing instanceData so
  // velocity stays zero (camera-only TAA fallback handles motion).
  const prevSrc = cache.prevInstanceData;
  if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    device.queue.writeBuffer(
      cache.lodPrevInstanceBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
  } else {
    const encoder = device.createCommandEncoder({
      label: "PointCloud LOD prev seed",
    });
    encoder.copyBufferToBuffer(
      cache.instanceBuffer,
      0,
      cache.lodPrevInstanceBuffer,
      0,
      requiredBytes,
    );
    device.queue.submit([encoder.finish()]);
  }

  // Lazy LOD velocity pipeline build.
  if (!cache.lodVelocityPipelineEntry && cache.lodDefaultBgl) {
    const built = _buildLODVelocityPipelineDescriptor(
      device,
      cache.lodDefaultBgl,
    );
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
    // Re-derive the visibleIndices buffer from the LOD processor by
    // reading the regular bind group's buffer slot. Simpler: pull
    // directly from context's pointCloudLOD processor.
    const lodProcessor = (
      context as unknown as {
        pointCloudLOD?: WebGPUPointCloudLODProcessorInstance | null;
      }
    ).pointCloudLOD as WebGPUPointCloudLODProcessorInstance | null;
    if (lodProcessor?.visibleIndicesBuffer) {
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
    // FEAT-GAP-09 (Batch 104) — match the LOD color pipeline's 3-BGL
    // layout. Velocity entry doesn't sample atmosphere; placeholder is
    // safe — WGSL allows unused bindings.
    const lodVelocityEffectsBG = getPlaceholderEffects(device).bindGroup;
    (cache.lodCommand as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
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
 * C-R7-RENDERER-MIGRATION (Batch 74).
 * @private
 */
function _buildLODPipelineDescriptor(
  device: GPUDevice,
  format: GPUTextureFormat,
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
  const bgl = makeBindGroupLayout(device, "PointCloud LOD uniform BGL", [
    uniformBuffer(0, Stage.VERTEX),
  ]);
  // Storage bind group — we use the helpers' storageBuffer readOnly
  // shape so the layout matches `var<storage, read>`.
  const storageBGL = device.createBindGroupLayout({
    label: "PointCloud LOD storage BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  // FEAT-GAP-09 (Batch 104) — append the shared effects BGL at slot 2
  // so the WGSL fog block at @group(2) resolves. Cascades to the LOD
  // velocity pipeline since both reuse this descriptor's layout shape
  // (LOD velocity adds it below independently because it builds its
  // own pipeline layout from a different storageBGL).
  const effectsBGL = getEffectsBindGroupLayout(device);
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: `PointCloud LOD Pipeline [${format}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bgl, storageBGL, effectsBGL],
    }),
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
      // Slice 5c-B Phase 1 (Batch 112) — scene-FB color target via
      // helper. Verbatim blend preserves the (no-`operation`) shape.
      // Used for BOTH default `fragmentMain` and LOD `fragmentMainLOD`
      // color pipelines; velocity pipelines at lines ~836 + ~2107
      // (rg16float) stay single-target.
      targets: makeSceneFBTargets(format, {
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };
  return { descriptor, bgl, storageBGL };
}

/**
 * Batch 169 - B.10 LOD velocity pipeline. Three storage bindings
 * (curr instance + visibleIndices + prev instance) instead of the
 * regular LOD pipeline's two; emits to rg16float matching the
 * default-path velocity descriptor (Batch 168).
 *
 * Storage BGL is separate from the regular LOD pipeline's storageBGL
 * because that one only declares 2 bindings — a 3-binding BGL with a
 * 2-binding pipeline would fail validation, so we keep them split.
 * The uniform BGL (group 0) is shared.
 * @private
 */
function _buildLODVelocityPipelineDescriptor(
  device: GPUDevice,
  bgl: GPUBindGroupLayout,
): {
  descriptor: WebGPURenderPipelineDescriptor;
  storageBGL: GPUBindGroupLayout;
} {
  const moduleCache = getPointCloudShaderModuleCache(device);
  const shaderModule = moduleCache.getOrCreate(
    ShaderSourceId.POINT_CLOUD_LOD,
    POINT_CLOUD_LOD_WGSL,
    0,
    "PointCloud LOD shader",
  );
  const storageBGL = device.createBindGroupLayout({
    label: "PointCloud LOD velocity storage BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  // FEAT-GAP-09 (Batch 104) — match the LOD color pipeline shape so
  // the LOD velocity command can share bind-group cardinality with the
  // LOD color command if needed. Velocity entries don't sample
  // atmosphere; placeholder effects BG is bound at draw time.
  const effectsBGL = getEffectsBindGroupLayout(device);
  const descriptor: WebGPURenderPipelineDescriptor = {
    name: "PointCloud LOD velocity pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bgl, storageBGL, effectsBGL],
    }),
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

/**
 * Extract six world-space frustum planes from the current camera as a
 * Float32Array of 24 floats (6 × vec4). Each plane is `(n.x, n.y, n.z, d)`
 * where the "inside" test is `dot(n, worldPos) + d >= 0`.
 */
function _extractFrustumPlanes(
  uniformState: CesiumUniformState,
  frameState: CesiumFrameState,
): Float32Array {
  const out = new Float32Array(24);
  const cullingVolume = frameState.cullingVolume;
  const planes = cullingVolume?.planes;
  if (planes && planes.length >= 6) {
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      out[i * 4 + 0] = p.x;
      out[i * 4 + 1] = p.y;
      out[i * 4 + 2] = p.z;
      out[i * 4 + 3] = p.w;
    }
  }
  return out;
  // Silence unused-import lint in case uniformState isn't consumed
  // — kept in the signature for callers that want to compose against it.
  void uniformState;
}

function destroyWebGPUPointCloudResources(pointCloud: PointCloudLike): void {
  const cache = pointCloud._webgpuCache as PointCloudCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  cache.lodIndirectBuffer?.destroy();
  // Pipelines / bind groups / layouts are GC'd when references drop.
  // The LOD processor itself lives on the WebGPUContext — don't destroy
  // it here since it may be shared with other point clouds.
  pointCloud._webgpuCache = undefined;
}

export { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
export default { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
