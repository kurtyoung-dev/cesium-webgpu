/**
 * WebGPU Gaussian Splat Renderer
 *
 * Renders 3D Gaussian Splatting primitives. Each splat is projected from
 * a 3D Gaussian to a 2D screen-space Gaussian evaluated per-pixel.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUGaussianSplatRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { preprocess } from "./WebGPUShaderPreprocessor.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
} from "./WebGPULogDepth.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import { WebGPUOIT } from "./WebGPUOIT.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import {
  attachPickToColorCommand,
  buildPickPipelineDescriptor,
  destroyPickIds,
  ensurePickId,
  type SinglePickIdCache,
} from "./WebGPUPickCommandHelpers.js";
import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
import { getOrCreateSharedAdvancedEffectsBG } from "./WebGPUPrimitiveCommands.js";
// Slice 5c-B Phase 1 (Batch 112) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

interface GaussianSplatCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  oitPipeline: GPURenderPipeline | null;
  pickPipeline: GPURenderPipeline | null;
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant of the
  // color pipeline. Same layout / vertex / fragment / blend; only the
  // depthStencil block flips `depthWriteEnabled: true`. Populated on
  // the splat WebGPUDrawCommand as `classificationDepthPipeline` so the
  // dispatcher can swap to it when `depthForTranslucentClassification`
  // is set (Cesium3DTile.update flips that flag for splat-pass commands
  // alongside translucent commands). Splats can then participate as
  // classifier targets — clipping volumes, draped classifiers, etc.
  // pick the splat surface depth instead of the geometry behind it.
  // Without this variant the splat alpha-blend would let classifiers
  // pass through to the next-deepest opaque surface.
  depthWritePipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — splat attributes now live in
  // a read-only STORAGE buffer (group 0 binding 1) the VS reads via
  // sortedIndices[instance_index]. `sortedIndexBuffer` (binding 2) holds the
  // CPU back-to-front depth permutation. The bind group needs rebuilding when
  // either buffer is reallocated (count change).
  splatBuffer: GPUBuffer | null;
  sortedIndexBuffer: GPUBuffer | null;
  sortedIndexCount: number;
  // CPU-side sorted permutation staging; reused across frames when the count
  // is unchanged. Identity until the async sort resolves.
  sortIndices: Uint32Array | null;
  // Camera pose at the last sort so we only re-sort when the view moves enough.
  lastSortCameraDir: Cartesian3 | null;
  sortRequestPending: boolean;
  splatCount: number;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — flip-
  // rebuild guard mirroring the format-generation guard. When the LOG_DEPTH
  // master switch flips, the color/depth-write pipelines must recompile from
  // the other shader-module variant.
  logDepthEnabled: boolean;
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — tracks the pick-fleet master
  // switch state the pick pipeline was built with (separate from the scene
  // logDepthEnabled) so a flip rebuilds the pick pipeline.
  pickLogDepthEnabled: boolean;
  pipelineLayout: GPUPipelineLayout | null;
  // C-R7-RENDERER-MIGRATION (Batch 56) — see EllipsoidPrimitiveRenderer
  // for the rationale. The OIT pipeline is optional (its WGSL injection
  // can fail) and stays out of the central cache for now to preserve
  // the existing fall-through-to-null semantics. Only the color + pick
  // pipelines route through the cache.
  pipelineRequestPending: boolean;

  // Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS (GaussianSplat).
  // Same lifecycle as PointCloud Batch 168/169 + Cloud Batch 170:
  //   - `splatData` tracks THIS frame's typed-array splat upload.
  //   - `prevSplatData` is promoted from `splatData` AFTER the
  //     velocity dispatch (PointPrimitive Batch 148 pattern).
  //   - `prevSplatBuffer` is the GPU mirror of prev positions.
  //   - `velocityPipeline` resolves through the central pipeline cache.
  // Static splat clouds have prev=curr → velocity=0 (camera-only TAA
  // fallback handles motion). For animated splats (rare; the loader
  // typically locks splat data at content load), per-splat velocity
  // is captured via the parallel buffer.
  splatData: ArrayBufferView | null;
  prevSplatData: ArrayBufferView | null;
  prevSplatBuffer: GPUBuffer | null;
  velocityPipeline: GPURenderPipeline | null;
  velocityPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;
  // C10-09-VELOCITY-PREV-BUFFER-GPU-COPY. Monotonic counter bumped at the
  // single `splatBuffer` content-write (rebuild) site; the identity-case prev
  // buffer re-seeds once via copyBufferToBuffer then skips the per-frame CPU
  // re-upload while the revision is unchanged.
  instanceDataRevision: number;
  // The `instanceDataRevision` resident in `prevSplatBuffer`; `undefined` =
  // unknown/stale → re-seed. Reset on prev-buffer realloc (T-4).
  prevBufferRevision: number | undefined;
}

const SPLAT_WGSL = `
// NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — splat attributes now live in a
// read-only storage buffer (one SplatRecord per splat, 64 bytes — byte-
// identical to the former 64-byte per-instance vertex stride) and the draw
// indexes through a sorted-index storage buffer so the rasterizer visits
// splats in back-to-front depth order. Pre-Batch-288 the splat data was a
// per-instance VERTEX buffer drawn in storage order, so the premultiplied
// over-blend (order-dependent) produced wrong tinting/haloing that shifted
// with camera angle (audit A2.1). The CPU radix sort already produced a
// depth order (primitive._indexes) that the WebGPU draw silently dropped.
// Scalar fields (NOT vec3) so the storage-buffer record is exactly 64 bytes,
// byte-identical to the tightly-packed CPU _splatData (16 floats/splat). WGSL
// gives vec3 a 16-byte size+alignment INSIDE a struct, which would make a
// vec3-field record 80 bytes and mis-stride against the 64-byte CPU layout.
struct SplatRecord {
  phx: f32, phy: f32, phz: f32,   // positionHigh
  plx: f32, ply: f32, plz: f32,   // positionLow
  ca0: f32, ca1: f32, ca2: f32,   // covA (Sxx, Sxy, Sxz)
  cb0: f32, cb1: f32, cb2: f32,   // covB (Syy, Syz, Szz)
  cr: f32, cg: f32, cb: f32, calpha: f32, // color + alpha
};
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) conic: vec3<f32>,
  @location(2) centerOffset: vec2<f32>,
  // FEAT-GAP-09 (Batch 103 audit fix) — splat-center RTE position
  // (position relative to camera) for the aerial-perspective fog
  // block. Per-quad-vertex spread is tiny relative to fog scale.
  @location(3) worldPos: vec3<f32>,
  //>>ifdef LOG_DEPTH
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) —
  // interpolated linear depthFromNearPlusOne (splat-center eye distance + 1).
  // The FS converts it to log @builtin(frag_depth) so a splat cloud at
  // altitude depth-tests against the log-depth globe at FAR range instead of
  // z-fighting it. Per-quad-vertex depth spread is negligible vs the splat
  // center, so using the center value across the quad is correct.
  @location(4) v_logDepth: f32,
  //>>endif
};
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — renderer-
  // wide log-depth near plane (formerly _pad0, float 35). Packed
  // unconditionally; only the //>>ifdef LOG_DEPTH blocks read it.
  logDepthNear: f32,
  encodedCameraLow: vec3<f32>,
  // log-depth factor = oneOverLog2FarDepthFromNearPlusOne (formerly _pad1,
  // float 39).
  logDepthFactor: f32,
  viewportSize: vec2<f32>,
  focalX: f32,
  focalY: f32,
  // C-R9 (Batch 31) — pick color broadcast across the whole splat cloud.
  // Splats belong to a single primitive for pick purposes (there's no
  // per-splat feature ID today), so one pickColor per primitive is
  // correct. UBO grows 176 → 192 bytes.
  pickColor: vec4<f32>,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Layout-only invariant today; consumed by future per-splat
  // motion-vector pass for animated splat clouds. UBO grows 192 → 256.
  prevViewProjection: mat4x4<f32>,
  // Batch 172 — full model matrix (no translation zeroing) so the
  // velocity VS can lift prev model-space positions to world space
  // before applying prevViewProjection. UBO grows 256 → 320.
  modelMatrix: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> splats: array<SplatRecord>;
// Sorted draw order — sortedIndices[instanceIndex] = the splat to draw at
// rasterizer instance position instanceIndex. Back-to-front for correct
// premultiplied over-blend.
@group(0) @binding(2) var<storage, read> sortedIndices: array<u32>;

//>>ifdef LOG_DEPTH
// Renderer-wide log depth — canonical inline copies; see
// chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

// FEAT-GAP-09 (Batch 103 audit fix; original Batch 101 modified the
// dead standalone Advanced/GaussianSplat.wgsl). Same EffectsUniforms
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
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  input: VertexInput,
) -> VertexOutput {
  var output: VertexOutput;
  // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — index through the sorted
  // order so the rasterizer visits splats back-to-front.
  let splatIdx = sortedIndices[instanceIndex];
  let s = splats[splatIdx];
  let positionHigh = vec3<f32>(s.phx, s.phy, s.phz);
  let positionLow = vec3<f32>(s.plx, s.ply, s.plz);
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let J00 = u.focalX / t.z;
  let J02 = -(u.focalX * t.x / t.z) / t.z;
  let J11 = u.focalY / t.z;
  let J12 = -(u.focalY * t.y / t.z) / t.z;
  // C-P15: rotate 3D covariance by the modelView 3x3 so splats follow
  // modelMatrix rotation/scale. Matches GLSL: R = mat3(czm_modelView).
  // The translation column of modelViewRelativeToEye is zeroed CPU-side,
  // so its 3x3 block is the pure rotation*scale we need.
  let R = mat3x3<f32>(
    u.modelViewRelativeToEye[0].xyz,
    u.modelViewRelativeToEye[1].xyz,
    u.modelViewRelativeToEye[2].xyz,
  );
  let Sigma = mat3x3<f32>(
    vec3<f32>(s.ca0, s.ca1, s.ca2),
    vec3<f32>(s.ca1, s.cb0, s.cb1),
    vec3<f32>(s.ca2, s.cb1, s.cb2),
  );
  let SV = R * Sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];
  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;
  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;
  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;
  let det = c00*c11 - c01*c01;
  if (det <= 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec4<f32>(0.0); output.conic = vec3<f32>(0.0);
    output.centerOffset = vec2<f32>(0.0);
    output.worldPos = vec3<f32>(0.0);
    //>>ifdef LOG_DEPTH
    output.v_logDepth = 1.0;
    //>>endif
    return output;
  }
  let invDet = 1.0 / det;
  let conic = vec3<f32>(c11*invDet, -c01*invDet, c00*invDet);
  let eigenMax = 0.5*(c00+c11+sqrt((c00-c11)*(c00-c11)+4.0*c01*c01));
  let radius = ceil(3.0 * sqrt(eigenMax));
  let pixOff = input.quadVertex * radius;
  let ndcOff = pixOff / u.viewportSize * 2.0 * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + ndcOff.x; fp.y = fp.y + ndcOff.y;
  //>>ifdef LOG_DEPTH
  // Use the splat-CENTER clip w for the eye distance (the quad expansion only
  // moves x/y; the center w is the splat's depth). Then clamp clip-z so the
  // high far/near ratio of a log buffer can't pre-clip the vertex.
  output.v_logDepth = csm_vertexLogDepth(clipPos, u.logDepthNear);
  fp = csm_updatePositionDepth(fp);
  //>>endif
  output.position = fp;
  output.color = vec4<f32>(s.cr, s.cg, s.cb, s.calpha);
  output.conic = conic;
  output.centerOffset = pixOff;
  // FEAT-GAP-09 (Batch 103) — splat-center RTE position for fog block.
  output.worldPos = posRTE;
  return output;
}

// NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — the color
// FS returns a struct carrying @builtin(frag_depth) ONLY in the LOG_DEPTH
// variant. The //>>else branch keeps the historical bare-@location(0) vec4
// signature byte-identical so (a) the hyperbolic kill-switch path is
// unchanged and (b) the OIT module (injected from the raw defines=0 source)
// still sees the bare-vec4 fragmentMain its WGSL transform expects.
//>>ifdef LOG_DEPTH
struct FragOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};
@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
//>>else
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
  let off = input.centerOffset;
  let power = -0.5*(input.conic.x*off.x*off.x + input.conic.z*off.y*off.y)
              - input.conic.y*off.x*off.y;
  if (power > 0.0) { discard; }
  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0/255.0) { discard; }
  var finalColor = vec4<f32>(input.color.rgb * alpha, alpha);

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

  //>>ifdef LOG_DEPTH
  var out: FragOutput;
  out.color = finalColor;
  out.depth = csm_writeLogDepth(input.v_logDepth, u.logDepthFactor);
  return out;
  //>>else
  return finalColor;
  //>>endif
}

// C-R9 (Batch 31) — pick entry point. Same gaussian footprint test as
// the color pass (so pick hits only the visible splat density), but
// outputs u.pickColor unmodified. No blending on the pick pipeline so
// the readback sees byte-exact pick IDs.
//
// NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — under the pick-fleet LOG_DEPTH
// module (compiled only when isWebGPUPickLogDepthActive) the pick FS writes
// the SAME log frag_depth the color FS writes (input.v_logDepth via the
// vertex csm_vertexLogDepth, factor u.logDepthFactor), so the splat pick
// shares the fleet's log encoding in the shared pick FBO. The //>>else keeps
// the historical bare-@location(0) return byte-identical (kill-switch parity).
// NO near-discard — the color sibling has none; mirror it exactly.
//>>ifdef LOG_DEPTH
struct PickFragOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};
@fragment
fn fragmentPickMain(input: VertexOutput) -> PickFragOutput {
//>>else
@fragment
fn fragmentPickMain(input: VertexOutput) -> @location(0) vec4<f32> {
//>>endif
  let off = input.centerOffset;
  let power = -0.5*(input.conic.x*off.x*off.x + input.conic.z*off.y*off.y)
              - input.conic.y*off.x*off.y;
  if (power > 0.0) { discard; }
  let alpha = min(0.99, input.color.a * exp(power));
  if (alpha < 1.0/255.0) { discard; }
  //>>ifdef LOG_DEPTH
  var out: PickFragOutput;
  out.color = u.pickColor;
  out.depth = csm_writeLogDepth(input.v_logDepth, u.logDepthFactor);
  return out;
  //>>else
  return u.pickColor;
  //>>endif
}

// Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity emission for
// animated Gaussian splat clouds. Mirrors PointCloud Batch 168/169 +
// CloudCollection Batch 170 patterns.
//
// NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — the velocity VS now also reads
// the current splat from the storage buffer indexed through the SAME sorted
// order as the color pass, and the prev-frame positions from a parallel
// prevSplats storage buffer at the SAME splat index. Because prev/curr are
// indexed by the stable splat id (sortedIndices is a permutation of the same
// splat-id space), the prev lookup follows the current sort permutation
// automatically — index identity holds even with per-frame re-sorting.
struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
};

@group(0) @binding(3) var<storage, read> prevSplats: array<SplatRecord>;

@vertex
fn vertexVelocityMain(
  @builtin(instance_index) instanceIndex: u32,
  input: VertexInput,
) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  let splatIdx = sortedIndices[instanceIndex];
  let s = splats[splatIdx];
  let prev = prevSplats[splatIdx];
  let positionHigh = vec3<f32>(s.phx, s.phy, s.phz);
  let positionLow = vec3<f32>(s.plx, s.ply, s.plz);
  // Current-frame center clip via RTE (matches vertexMain).
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let currCenterClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Batch 172 — Previous-frame center clip via prevVP × modelMatrix ×
  // prevModelPos. Splat positions are model-space; the current-frame VS
  // folds the modelMatrix into mvpRelativeToEye, so prev needs the explicit
  // lift via the standalone modelMatrix (in the UBO). For typical 3D-Tiles
  // content the modelMatrix is identity and the lift is a no-op; for custom
  // primitives with non-identity modelMatrix this is required for correct
  // prev-clip projection.
  let prevModelPos = vec4<f32>(
    vec3<f32>(prev.phx, prev.phy, prev.phz)
      + vec3<f32>(prev.plx, prev.ply, prev.plz),
    1.0,
  );
  let prevWorldPos = u.modelMatrix * prevModelPos;
  let prevCenterClip = u.prevViewProjection * prevWorldPos;

  // Batch 172 — Replicate the full elliptical footprint expansion from
  // vertexMain so the velocity texture covers the SAME pixels the
  // color pass touched (within numerical precision). Pre-Batch-172 a
  // coarse 2-pixel square footprint left edge pixels of large splats
  // outside the velocity texture, falling back to camera-only TAA
  // reprojection at the splat edges of animated splats.
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let J00 = u.focalX / t.z;
  let J02 = -(u.focalX * t.x / t.z) / t.z;
  let J11 = u.focalY / t.z;
  let J12 = -(u.focalY * t.y / t.z) / t.z;
  let R = mat3x3<f32>(
    u.modelViewRelativeToEye[0].xyz,
    u.modelViewRelativeToEye[1].xyz,
    u.modelViewRelativeToEye[2].xyz,
  );
  let Sigma = mat3x3<f32>(
    vec3<f32>(s.ca0, s.ca1, s.ca2),
    vec3<f32>(s.ca1, s.cb0, s.cb1),
    vec3<f32>(s.ca2, s.cb1, s.cb2),
  );
  let SV = R * Sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];
  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;
  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;
  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;
  let det = c00*c11 - c01*c01;
  if (det <= 0.0) {
    // Degenerate splat — emit a behind-camera zero-coverage triangle so
    // the velocity FS never executes for this instance. Mirrors
    // vertexMain's degenerate handling.
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.currCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.prevCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }
  let eigenMax = 0.5*(c00+c11+sqrt((c00-c11)*(c00-c11)+4.0*c01*c01));
  let radius = ceil(3.0 * sqrt(eigenMax));
  let pixOff = input.quadVertex * radius;
  let ndcOff = pixOff / u.viewportSize * 2.0 * currCenterClip.w;
  var fp = currCenterClip;
  fp.x = fp.x + ndcOff.x;
  fp.y = fp.y + ndcOff.y;
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

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

// Per-device shader-module cache so the LOG_DEPTH and non-log variants compile
// once per device and dedupe across split-screen contexts (C-R7-SHADER-MODULE-
// DEDUP). The cache runs the `//>>ifdef` preprocessor on miss.
const _splatModuleCaches = new WeakMap<GPUDevice, WebGPUShaderModuleCache>();
function getSplatModuleCache(device: GPUDevice): WebGPUShaderModuleCache {
  let cache = _splatModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _splatModuleCaches.set(device, cache);
  }
  return cache;
}

function createQuadVB(device: GPUDevice): GPUBuffer {
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

// NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — the only vertex buffer is now
// the 6-vertex quad at location 0. Splat attributes moved to a storage buffer
// (group 0 binding 1) the VS reads via sortedIndices[instance_index], so the
// rasterizer visits splats in back-to-front depth order. Pre-Batch-288 the
// splat data was a 64-byte per-instance vertex buffer drawn in storage order.
const SPLAT_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
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
];

interface SplatPipelineResources {
  shaderModule: GPUShaderModule;
  oitShaderModule: GPUShaderModule | null;
  bgl: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
  colorDescriptor: WebGPURenderPipelineDescriptor;
  oitDescriptor: WebGPURenderPipelineDescriptor | null;
  pickDescriptor: WebGPURenderPipelineDescriptor;
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176). Same as colorDescriptor
  // but with `depthWriteEnabled: true`. Routed through the central
  // pipeline cache the same way the color descriptor is.
  depthWriteDescriptor: WebGPURenderPipelineDescriptor;
}

/**
 * Build the synchronous resources (shader modules, BGL, pipeline layout)
 * and the descriptor objects passed to `WebGPURenderPipelineCache`.
 *
 * C-R7-RENDERER-MIGRATION (Batch 56). Two splat primitives with identical
 * material settings now share a single `GPURenderPipeline` per variant
 * (color + OIT + pick) instead of materializing six pipelines for two
 * primitives.
 */
function buildSplatPipelineResources(
  device: GPUDevice,
  format: GPUTextureFormat,
  logDepthActive: boolean,
  sampleCount: number,
  pickFormat: GPUTextureFormat = "rgba8unorm",
  pickLogActive: boolean = false,
): SplatPipelineResources {
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — the color
  // + depth-write variants use the LOG_DEPTH-preprocessed module when active so
  // the splat FS writes log @builtin(frag_depth). The PICK + OIT variants
  // always use the base (defines=0) module: pick stays hyperbolic (the pick
  // FBO is self-consistent — CLAUDE.md rule), and OIT's WGSL injection expects
  // the bare-@location(0) fragmentMain signature (its pass has
  // depthWriteEnabled:false anyway, so frag_depth is irrelevant to it).
  const moduleCache = getSplatModuleCache(device);
  const smBase = moduleCache.getOrCreate(
    ShaderSourceId.GAUSSIAN_SPLAT,
    SPLAT_WGSL,
    0,
    "GaussianSplat",
  );
  const sm = logDepthActive
    ? moduleCache.getOrCreate(
        ShaderSourceId.GAUSSIAN_SPLAT,
        SPLAT_WGSL,
        ShaderDefine.LOG_DEPTH,
        "GaussianSplat [log]",
      )
    : smBase;
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — the PICK pipeline is gated by
  // the SEPARATE pick-fleet master switch (isWebGPUPickLogDepthActive), NOT
  // the scene log switch. When active it uses the LOG_DEPTH module so
  // fragmentPickMain writes log frag_depth into the shared pick FBO (all-or-
  // nothing coherence, INV-2); when inactive it stays on the base module —
  // byte-identical to the historical hyperbolic pick. Dedupes to `sm` when
  // both switches agree.
  const pickModule = pickLogActive
    ? moduleCache.getOrCreate(
        ShaderSourceId.GAUSSIAN_SPLAT,
        SPLAT_WGSL,
        ShaderDefine.LOG_DEPTH,
        "GaussianSplat [log]",
      )
    : smBase;
  const bgl = makeBindGroupLayout(device, "GaussianSplat BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — splat attributes, sorted
    // index permutation, and the prev-frame splat mirror (velocity). All
    // read-only VERTEX-stage storage; bound on a single group-0 BGL shared
    // by the color / pick / velocity / depth-write pipelines (each statically
    // references the subset it needs — unused bindings are still provided so
    // the bind group matches the shared pipeline layout).
    storageBuffer(1, Stage.VERTEX, { readOnly: true }),
    storageBuffer(2, Stage.VERTEX, { readOnly: true }),
    storageBuffer(3, Stage.VERTEX, { readOnly: true }),
  ]);
  // FEAT-GAP-09 (Batch 101) — append shared effects BGL at slot 1 so
  // the WGSL fog block at @group(1) resolves. Shared layout cascades
  // to the pick, velocity, OIT, and depth-write pipelines too (all
  // built with this same `layout` below).
  const effectsBGL = getEffectsBindGroupLayout(device);
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [bgl, effectsBGL],
  });

  const colorDescriptor: WebGPURenderPipelineDescriptor = {
    name: `GaussianSplat color pipeline [ld=${logDepthActive ? 1 : 0}/ms=${sampleCount}]`,
    layout,
    vertex: {
      module: sm,
      entryPoint: "vertexMain",
      buffers: SPLAT_VERTEX_BUFFERS,
    },
    fragment: {
      module: sm,
      entryPoint: "fragmentMain",
      // Slice 5c-B Phase 1 (Batch 112) — scene-FB color target via
      // helper. Premultiplied alpha blend preserved verbatim.
      targets: makeSceneFBTargets(format, {
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — scene-FB pipelines MUST
    // bake the MSAA sample count or the attachment state mismatches the
    // multisampled Scene Framebuffer Render Pass and invalidates the whole
    // command buffer. Pre-Batch-288 the splat color/depth-write pipelines
    // omitted this; the bug was latent because the renderer never actually
    // drew (no _splatData producer was wired).
    multisample: { count: sampleCount },
  };

  // GS-WSR: OIT pipeline variant for weighted-sum rendering. WGSL injection
  // can fail (returns null), in which case OIT support is skipped — same
  // semantics as the pre-cache path. Inject on the defines=0-preprocessed
  // source so the injector sees the bare-@location(0) fragmentMain.
  let oitShaderModule: GPUShaderModule | null = null;
  let oitDescriptor: WebGPURenderPipelineDescriptor | null = null;
  try {
    const baseCode = preprocess(SPLAT_WGSL, 0);
    const oitCode = WebGPUOIT.injectOITOutput(baseCode, "fragmentMain");
    oitShaderModule = device.createShaderModule({
      label: "GaussianSplat-OIT-GS-WSR",
      code: oitCode,
    });
    oitDescriptor = {
      name: "GaussianSplat-OIT-Pipeline",
      layout,
      vertex: {
        module: oitShaderModule,
        entryPoint: "vertexMain",
        buffers: SPLAT_VERTEX_BUFFERS,
      },
      fragment: {
        module: oitShaderModule,
        entryPoint: "fragmentMain",
        targets: WebGPUOIT.OIT_TARGETS,
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness.
        depthCompare: "less-equal",
      },
      // OIT pass is multisampled (WebGPUOIT._sampleCount tracks _msaaSamples).
      multisample: { count: sampleCount },
    };
  } catch (e) {
    // OIT variant creation is non-fatal — falls back to standard alpha blending
  }

  // C-R9 (Batch 31 / refactored Batch 59) — pick descriptor. The pick VS is
  // `vertexMain` of the BASE (non-log) module so the pick FBO stays hyperbolic
  // and self-consistent (CLAUDE.md pick rule). Built explicitly (not via
  // buildPickPipelineDescriptor's color-clone) because the color descriptor
  // may reference the LOG_DEPTH module. Blend stripped; single pick target.
  const pickDescriptor: WebGPURenderPipelineDescriptor =
    buildPickPipelineDescriptor(
      {
        ...colorDescriptor,
        vertex: { ...colorDescriptor.vertex, module: pickModule },
      },
      "fragmentPickMain",
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — stamp the context's pick
      // format authority, not the (possibly float/HDR) scene format.
      pickFormat,
      {
        // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — distinct [ld] name so the central
        // cache never serves the hyperbolic pick pipeline for the log module.
        name: pickLogActive
          ? "GaussianSplat pick pipeline [ld]"
          : "GaussianSplat pick pipeline",
        // Write log frag_depth into the shared pick FBO depth ONLY when the
        // fleet is log (gate on); otherwise stay depth-test-only (byte-
        // identical to the historical hyperbolic pick).
        forceDepthWriteEnabled: pickLogActive,
      },
    );
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — pick FS module = the pick-gated module
  // (base when the fleet switch is off; LOG_DEPTH when on).
  if (pickDescriptor.fragment) {
    pickDescriptor.fragment.module = pickModule;
  }

  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant of the
  // color pipeline. Same module / layout / vertex / fragment / blend as
  // the color pipeline; the only delta is `depthWriteEnabled: true` so
  // the splat surface populates the scene-FB depth attachment when this
  // variant is bound. The splat command's `classificationDepthPipeline`
  // points here; `WebGPUDrawCommand.execute` swaps to it when
  // `depthForTranslucentClassification` is set on the command (mirrors
  // Batch 79's translucent-classification mechanism for Models).
  const depthWriteDescriptor: WebGPURenderPipelineDescriptor = {
    ...colorDescriptor,
    name: `GaussianSplat depth-write pipeline [ld=${logDepthActive ? 1 : 0}/ms=${sampleCount}]`,
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  return {
    shaderModule: sm,
    oitShaderModule,
    bgl,
    layout,
    colorDescriptor,
    oitDescriptor,
    pickDescriptor,
    depthWriteDescriptor,
  };
}

function descriptorToGPU(
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
 * Resolve the color, OIT, and pick pipelines through the central pipeline
 * cache. Returns true once the color + pick pipelines are ready
 * (OIT is best-effort — null OIT is a valid steady-state result so it
 * never blocks the ready signal).
 */
function tryResolveSplatPipelines(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  resources: SplatPipelineResources,
  cache: GaussianSplatCache,
): boolean {
  if (cache.pipeline && cache.pickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    const oitSync = resources.oitDescriptor
      ? pipelineCache.getPipelineSync(resources.oitDescriptor)
      : null;
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — resolve the depth-write
    // variant alongside color/pick. Cache miss is non-fatal: the color
    // path still works without it; only the classification-depth swap
    // becomes a no-op until the variant lands.
    const depthWriteSync = pipelineCache.getPipelineSync(
      resources.depthWriteDescriptor,
    );
    if (colorSync && pickSync) {
      cache.pipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.oitPipeline = oitSync ?? null;
      cache.depthWritePipeline = depthWriteSync ?? null;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      const work: Promise<unknown>[] = [
        pipelineCache.getPipeline(resources.colorDescriptor).then((p) => {
          cache.pipeline = p;
        }),
        pipelineCache.getPipeline(resources.pickDescriptor).then((p) => {
          cache.pickPipeline = p;
        }),
        pipelineCache
          .getPipeline(resources.depthWriteDescriptor)
          .then((p) => {
            cache.depthWritePipeline = p;
          })
          .catch(() => {
            // Depth-write variant failure is non-fatal — the color path
            // still works without it; classification-depth swap becomes
            // a no-op (matches pre-Batch-176 behavior).
            cache.depthWritePipeline = null;
          }),
      ];
      if (resources.oitDescriptor) {
        work.push(
          pipelineCache
            .getPipeline(resources.oitDescriptor)
            .then((p) => {
              cache.oitPipeline = p;
            })
            .catch(() => {
              // OIT failure is non-fatal — the color pass still works.
              cache.oitPipeline = null;
            }),
        );
      }
      Promise.all(work)
        .then(() => {
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache. Mirror the historical synchronous path.
  cache.pipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
  // NEW-GS-CLASSIFICATION-DEPTH (Batch 176).
  cache.depthWritePipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthWriteDescriptor),
  );
  if (resources.oitDescriptor) {
    try {
      cache.oitPipeline = device.createRenderPipeline(
        descriptorToGPU(resources.oitDescriptor),
      );
    } catch {
      cache.oitPipeline = null;
    }
  }
  return true;
}

// NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — re-sort threshold. Re-sort when
// the camera view direction has rotated more than ~0.5° OR moved enough
// relative to the splat cloud. Mirrors the WebGL steady-sort cadence
// (GaussianSplatPrimitive DEFAULT_SORT_MIN_ANGLE_RADIANS).
const SORT_MIN_ANGLE_COS = Math.cos(0.008726646259971648);
const scratchSortDir = new Cartesian3();
const scratchSortMV = new Matrix4();

/**
 * NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288). CPU back-to-front sort of the
 * splat indices by view-space depth, uploaded to the sorted-index storage
 * buffer the VS reads via `sortedIndices[instance_index]`. Without this the
 * WebGPU draw visited splats in buffer order, producing order-dependent
 * premultiplied over-blend errors (audit A2.1). Runs only when the camera has
 * rotated enough since the last sort (cheap-frame amortization). The sort key
 * is the splat-center eye-space z; farthest (most negative z) drawn first.
 *
 * @private
 */
function maybeSortSplats(
  device: GPUDevice,
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
  cache: GaussianSplatCache,
): void {
  const count = cache.splatCount;
  if (count === 0 || !cache.sortedIndexBuffer) {
    return;
  }
  const splatData = (cache.splatData ?? null) as Float32Array | null;
  // Need the interleaved 64-byte (16-float) records to read positions.
  if (!splatData || splatData.length < count * 16) {
    return;
  }

  const camera = (
    frameState as unknown as { camera?: { directionWC?: Cartesian3 } }
  ).camera;
  const dir = camera?.directionWC;
  // Throttle: skip if the view direction hasn't rotated past the threshold.
  if (dir && cache.lastSortCameraDir) {
    const cosAngle = Cartesian3.dot(
      Cartesian3.normalize(dir, scratchSortDir),
      cache.lastSortCameraDir,
    );
    if (cosAngle >= SORT_MIN_ANGLE_COS && !cache.sortRequestPending) {
      return;
    }
  }

  // modelView = view * modelMatrix (the eye-space transform of model-space
  // splat positions). The renderer packs the same MV (with the translation
  // column zeroed for RTE) into the UBO below; here we keep the full MV so the
  // depth key is the true eye-space z.
  const us = (
    frameState as unknown as { context: { uniformState: { view: Matrix4 } } }
  ).context.uniformState;
  const mm = (primitive.modelMatrix as Matrix4 | undefined) ?? Matrix4.IDENTITY;
  Matrix4.multiply(us.view, mm, scratchSortMV);
  const m0 = scratchSortMV[2];
  const m1 = scratchSortMV[6];
  const m2 = scratchSortMV[10];
  const m3 = scratchSortMV[14];

  let indices = cache.sortIndices;
  if (!indices || indices.length !== count) {
    indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      indices[i] = i;
    }
    cache.sortIndices = indices;
  }

  // Eye-space z for each splat (the depth-sort key). Interleaved layout is
  // [posHigh(0-2), posLow(3-5), covA(6-8), covB(9-11), color(12-15)]; the
  // world position is posHigh + posLow.
  const depth = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * 16;
    const px = splatData[base] + splatData[base + 3];
    const py = splatData[base + 1] + splatData[base + 4];
    const pz = splatData[base + 2] + splatData[base + 5];
    depth[i] = m0 * px + m1 * py + m2 * pz + m3;
  }

  // Ascending eye-space z = farthest (most negative) first → back-to-front for
  // the premultiplied over-blend operator.
  Array.prototype.sort.call(
    indices,
    (a: number, b: number) => depth[a] - depth[b],
  );

  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indices);
  if (dir) {
    cache.lastSortCameraDir = Cartesian3.normalize(
      dir,
      cache.lastSortCameraDir ?? new Cartesian3(),
    );
  }
  cache.sortRequestPending = false;
}

function updateWebGPUGaussianSplats(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      oitPipeline: null,
      pickPipeline: null,
      // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — populated alongside
      // the color pipeline by `tryResolveSplatPipelines`.
      depthWritePipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      splatBuffer: null,
      sortedIndexBuffer: null,
      sortedIndexCount: 0,
      sortIndices: null,
      lastSortCameraDir: null,
      sortRequestPending: false,
      splatCount: 0,
      command: null,
      pickCommand: null,
      initialized: false,
      lastRevision: -1,
      logDepthEnabled: false,
      pickLogDepthEnabled: false,
      pipelineLayout: null,
      pipelineRequestPending: false,
      // Batch 171 - velocity slots (lazy, allocated when TAA is on).
      splatData: null,
      prevSplatData: null,
      prevSplatBuffer: null,
      velocityPipeline: null,
      velocityPipelineDescriptor: null,
      velocityPipelineRequestPending: false,
      // C10-09 - prev-buffer revision-skip.
      instanceDataRevision: 0,
      prevBufferRevision: undefined,
    } as GaussianSplatCache;
  }

  const cache = primitive._webgpuCache as GaussianSplatCache;
  // Batch 110 — splats draw into scene FB; use scenePipelineFormat.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Batch 110 — invalidate pipeline resources on scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — recompile
  // the color/depth-write pipelines from the other shader-module variant when
  // the LOG_DEPTH master switch flips. Shares the format-invalidation reset
  // machinery (which already tears down + rebuilds all pipeline resources).
  const logDepthActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — the pick pipeline is gated by
  // the SEPARATE pick-fleet master switch; a flip must rebuild it against the
  // pick-gated module (+ [ld] name), so track it in the same guard.
  const pickLogActive = isWebGPUPickLogDepthActive(
    context as unknown as {
      _logDepthWriteEnabled?: boolean;
      _pickLogDepthWriteEnabled?: boolean;
    },
    frameState as unknown as { useLogDepth?: boolean },
  );
  const logDepthFlipped =
    cache.initialized &&
    (cache.logDepthEnabled !== logDepthActive ||
      cache.pickLogDepthEnabled !== pickLogActive);
  if (
    cache.initialized &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      logDepthFlipped)
  ) {
    (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources = undefined;
    // Batch 171 - same pre-existing pattern as Ground{Primitive,Polyline}
    // and PointCloud: cached pipeline objects + draw commands hold
    // pointers to old-format pipelines after the resources reset; the
    // resolver early-returns on the truthy slot check and leaves stale-
    // format pipelines bound. WebGPU then rejects the next draw because
    // the bound pipeline's color target format doesn't match the active
    // attachment. Clear them all so the resolver re-runs against the
    // new format.
    cache.pipeline = null;
    cache.oitPipeline = null;
    cache.pickPipeline = null;
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — Batch 179 follow-up.
    // Audit found this slot was missed in the format-invalidation
    // sweep: stale depth-write pipeline retains the OLD presentation
    // format, and `WebGPUDrawCommand.execute`'s classification swap
    // would fail validation against the active attachment. Clears
    // alongside the other pipelines so the resolver re-runs against
    // the new format.
    cache.depthWritePipeline = null;
    cache.pipelineRequestPending = false;
    cache.command = null;
    cache.pickCommand = null;
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — the bind group references
    // the old BGL; drop it so it rebuilds against the new resources below.
    cache.bindGroup = null;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  // C-R7-RENDERER-MIGRATION (Batch 56) — sidecar holds the resources we
  // built once and re-use across frames while the cache materializes
  // pipelines asynchronously.
  let resources = (
    cache as GaussianSplatCache & {
      _pipelineResources?: SplatPipelineResources;
    }
  )._pipelineResources;

  if (!cache.initialized) {
    // C-R9 (Batch 31) — UBO grew 176 → 192 bytes to include pickColor
    // (floats 44-47 at offset 176).
    // AUDIT_2026_05_02 B.9 (Batch 153) — UBO grew 192 → 256 bytes to
    // include prev viewProjection (floats 48-63 at offset 192).
    // Batch 172 — UBO grew 256 → 320 bytes to include the model matrix
    // (floats 64-79 at offset 256). Used by the velocity VS to lift
    // prev model-space positions to world space before applying
    // prevViewProjection. Necessary for correct velocity when
    // `primitive.modelMatrix` is non-identity (typical 3D-Tiles
    // GaussianSplat content has identity, but custom primitives don't).
    cache.uniformBuffer = device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.quadVertexBuffer = createQuadVB(device);

    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — placeholder STORAGE buffers
    // (replaced when splat data loads). All three group-0 storage bindings
    // must exist before the first bind group is built.
    // COPY_SRC so the velocity prev-seed copyBufferToBuffer (curr → prev) is
    // valid (the prev path GPU-self-copies when no continuous prev exists).
    cache.splatBuffer = device.createBuffer({
      label: "GaussianSplat splats (placeholder)",
      size: 64,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    cache.sortedIndexBuffer = device.createBuffer({
      label: "GaussianSplat sorted indices (placeholder)",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    cache.prevSplatBuffer = device.createBuffer({
      label: "GaussianSplat prev splats (placeholder)",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    cache.splatCount = 0;
    cache.sortedIndexCount = 0;
    cache.initialized = true;
  }

  // Build (or rebuild after format/log-depth invalidation) the pipeline
  // resources from the current format + log-depth state.
  if (!resources) {
    const sampleCount =
      (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
    resources = buildSplatPipelineResources(
      device,
      canvasFormat,
      logDepthActive,
      sampleCount,
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      (context as unknown as { pickPipelineFormat?: GPUTextureFormat })
        .pickPipelineFormat ?? "rgba8unorm",
      pickLogActive,
    );
    (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;
    cache.pipelineLayout = resources.layout;
    cache.logDepthEnabled = logDepthActive;
    cache.pickLogDepthEnabled = pickLogActive;
    // Bind group references the freshly-built BGL + current buffers.
    cache.bindGroup = null;
  }

  // (Re)build the group-0 bind group whenever it's missing (init, format/
  // log-depth flip, or a storage-buffer reallocation cleared it).
  if (!cache.bindGroup) {
    cache.bindGroup = device.createBindGroup({
      layout: resources.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer! } },
        { binding: 1, resource: { buffer: cache.splatBuffer! } },
        { binding: 2, resource: { buffer: cache.sortedIndexBuffer! } },
        { binding: 3, resource: { buffer: cache.prevSplatBuffer! } },
      ],
    });
    // Bind group identity changed — drop cached commands so they rebuild
    // with the new bind group.
    cache.command = null;
    cache.pickCommand = null;
  }

  // Resolve the color + OIT + pick pipelines via the central cache.
  // Skip drawing this frame if pipelines aren't ready yet.
  const ctxAny = context as unknown as {
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  if (
    !tryResolveSplatPipelines(
      device,
      ctxAny.webgpuPipelineCache ?? null,
      resources!,
      cache,
    )
  ) {
    return;
  }

  // Check if splat data has been uploaded
  const splatData =
    primitive._splatData || primitive._renderResources?.splatBuffer;
  const revision = primitive._splatCount ?? 0;
  if (revision !== cache.lastRevision && splatData) {
    if (cache.splatBuffer) {
      cache.splatBuffer.destroy();
    }
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — splat attributes now live
    // in a read-only STORAGE buffer the VS reads via sortedIndices. COPY_SRC
    // for the velocity prev-seed self-copy.
    cache.splatBuffer = device.createBuffer({
      label: "GaussianSplat splats",
      size: splatData.byteLength || 64,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    if (splatData.byteLength > 0) {
      device.queue.writeBuffer(cache.splatBuffer, 0, splatData);
    }
    cache.splatCount = revision;
    cache.lastRevision = revision;
    cache.command = null;
    // Batch 171 - track THIS frame's splat data so the velocity helper
    // can promote it to `prevSplatData` AFTER its dispatch. Reference
    // to the same typed array — the loader owns the storage.
    cache.splatData = splatData;
    // C10-09 - single `splatBuffer` content-write site; bump so the velocity
    // prev buffer re-seeds once for this content then skips per-frame uploads.
    cache.instanceDataRevision++;

    // (Re)allocate the sorted-index storage buffer to match the count, and
    // seed it with identity order (overwritten once the sort resolves). Force
    // a re-sort + bind-group rebuild for the new buffers.
    const count = cache.splatCount;
    if (count > 0) {
      if (cache.sortedIndexBuffer) {
        cache.sortedIndexBuffer.destroy();
      }
      cache.sortedIndexBuffer = device.createBuffer({
        label: "GaussianSplat sorted indices",
        size: count * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const identity = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        identity[i] = i;
      }
      device.queue.writeBuffer(cache.sortedIndexBuffer, 0, identity);
      cache.sortIndices = identity;
      cache.sortedIndexCount = count;
      cache.lastSortCameraDir = null; // force a sort against the new data
    }
    // The splat + sorted-index storage buffers were reallocated, so the
    // bind group must be rebuilt against the new buffers.
    cache.bindGroup = null;
    cache.pickCommand = null;
  }

  if (cache.splatCount === 0) {
    return;
  }

  // (Re)build the bind group if a buffer reallocation above cleared it. (The
  // earlier rebuild ran before the data upload; this catches the realloc.)
  if (!cache.bindGroup) {
    cache.bindGroup = device.createBindGroup({
      layout: resources.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer! } },
        { binding: 1, resource: { buffer: cache.splatBuffer! } },
        { binding: 2, resource: { buffer: cache.sortedIndexBuffer! } },
        { binding: 3, resource: { buffer: cache.prevSplatBuffer! } },
      ],
    });
    cache.command = null;
    cache.pickCommand = null;
  }

  // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — run a CPU back-to-front sort
  // when the view has moved enough since the last sort, then upload the new
  // permutation to the sorted-index storage buffer. Mirrors WebGL's radix
  // sort feeding primitive._indexes — the WebGPU draw previously dropped it.
  maybeSortSplats(device, primitive, frameState, cache);

  // Pack uniforms.
  //
  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth and breaking
  // depth testing at planetary scale.
  const us = context.uniformState;
  const mm = primitive.modelMatrix ?? Matrix4.IDENTITY;
  Matrix4.multiply(us.view, mm, scratchMV);
  scratchMV[12] = 0;
  scratchMV[13] = 0;
  scratchMV[14] = 0;
  Matrix4.multiply(us.projection, scratchMV, scratchMVP);
  const mv = m4Values(scratchMV);
  const mvp = m4Values(scratchMVP);

  const camWorld = us.cameraPosition;
  const invM = Matrix4.inverse(mm, new Matrix4());
  const camM = Matrix4.multiplyByPoint(invM, camWorld, new Cartesian3());
  EncodedCartesian3.fromCartesian(camM, scratchEncoded);

  const data = new Float32Array(40);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }
  data[32] = scratchEncoded.high.x;
  data[33] = scratchEncoded.high.y;
  data[34] = scratchEncoded.high.z;
  data[36] = scratchEncoded.low.x;
  data[37] = scratchEncoded.low.y;
  data[38] = scratchEncoded.low.z;
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) — renderer-
  // wide log-depth lanes in the formerly-zero pad slots (float 35 = near,
  // float 39 = oneOverLog2FarDepthFromNearPlusOne). Packed unconditionally;
  // only the //>>ifdef LOG_DEPTH shader variant reads them.
  //
  // CRITICAL: prefer the stashed FULL-frustum `_logDepthEncodeNearFar` the
  // globe baked with over the live per-slice `currentFrustum`. The splat
  // command is pushed once and executed across all frustum slices, but its
  // log-depth MUST use the same (near, factor) the globe encoded with or the
  // splat's frag_depth disagrees with the globe at the same pixel and the
  // splat loses every depth tie (occluded by terrain it sits above). Same
  // pattern as WebGPUEllipsoidPrimitiveRenderer / WebGPUBillboardRenderer.
  const lds = us as unknown as {
    currentFrustum?: { x: number; y: number };
    oneOverLog2FarDepthFromNearPlusOne?: number;
    _logDepthEncodeNearFar?: Float32Array | null;
  };
  // The globe (WebGPUGlobeSurfaceCameraUB) encodes log depth with the LIVE
  // per-pass `currentFrustum` near/far. The splat command is pushed once and
  // executed in the GAUSSIAN_SPLATS (translucent) pass; to depth-test against
  // the globe it MUST encode with the same `currentFrustum` the globe used.
  // (Using the stashed full-frustum `_logDepthEncodeNearFar` — meant for
  // depth-sample classifiers — over-deepens the splat vs the globe's per-pass
  // encode and the splat loses every tie.)
  const ldNear = lds.currentFrustum?.x ?? 0.0;
  const ldFar = lds.currentFrustum?.y ?? 0.0;
  let ldFactor = lds.oneOverLog2FarDepthFromNearPlusOne ?? 0.0;
  if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const log2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  data[35] = ldNear;
  data[39] = ldFactor;

  // Viewport + focal length derived from the perspective projection matrix.
  // For a standard perspective: P[0][0] = 1/(aspect*tan(fov/2)),
  // P[1][1] = 1/tan(fov/2). Pixel-space focal = P[i][i] * (viewportDim/2).
  const vpData = new Float32Array(4);
  const viewportW =
    context.drawingBufferWidth || context._canvas?.width || 1920;
  const viewportH =
    context.drawingBufferHeight || context._canvas?.height || 1080;
  const proj = m4Values(us.projection);
  vpData[0] = viewportW;
  vpData[1] = viewportH;
  vpData[2] = proj[0] * (viewportW * 0.5); // focal X (pixels)
  vpData[3] = proj[5] * (viewportH * 0.5); // focal Y (pixels)
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
  device.queue.writeBuffer(cache.uniformBuffer!, 160, vpData);

  // C-R9 (Batch 31 / refactored Batch 59) — pick ID lifecycle delegated to
  // {@link ensurePickId}. Pick IDs are per-primitive, not per-splat; the
  // whole splat cloud reports the same owner when clicked. UBO write at
  // offset 176 below stays per-renderer because the layout differs from
  // every other pick consumer.
  const passes = frameState.passes;
  const allowAllocate = !!(passes && (passes.pick || passes.render));
  const pickState = primitive as unknown as SinglePickIdCache;
  const pickId = ensurePickId(
    primitive as unknown as import("../GraphicsContext.js").PickTarget,
    context,
    pickState,
    { allowAllocate },
  );
  const pickColor = pickId?.color;
  if (pickColor) {
    const pickData = new Float32Array(4);
    pickData[0] = pickColor.red ?? 0;
    pickData[1] = pickColor.green ?? 0;
    pickData[2] = pickColor.blue ?? 0;
    pickData[3] = pickColor.alpha ?? 0;
    device.queue.writeBuffer(cache.uniformBuffer!, 176, pickData);
  }

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at byte
  // offset 192 (float 48). UniformState swaps `_previousViewProjection`
  // at the END of `update()` AFTER returning the prior frame's value, so
  // on frame N this slot holds frame N-1's VP. First frame falls through
  // to identity.
  const prevVPData = new Float32Array(16);
  const prevVP = (us as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, prevVPData, 0);
  } else {
    prevVPData[0] = 1;
    prevVPData[5] = 1;
    prevVPData[10] = 1;
    prevVPData[15] = 1;
  }
  device.queue.writeBuffer(cache.uniformBuffer!, 192, prevVPData);

  // Batch 172 — model matrix at byte offset 256 (float 64). Used by the
  // velocity VS to lift prev model-space positions to world space
  // before applying prevViewProjection. CPU passes the primitive's
  // modelMatrix directly (no translation zeroing — the prev path needs
  // the full transform, not the RTE-zeroed one used for currVP).
  const modelMatrixData = new Float32Array(16);
  Matrix4.pack(mm, modelMatrixData, 0);
  device.queue.writeBuffer(cache.uniformBuffer!, 256, modelMatrixData);

  // FEAT-GAP-09 (Batch 101) — per-frame effects BG. Shared helper
  // returns placeholder when none of (shadow, csm, atmosphereLut) is
  // active, so this is cheap and idempotent.
  const effectsBG =
    getOrCreateSharedAdvancedEffectsBG(frameState) ??
    getPlaceholderEffects(device).bindGroup;

  // C7-SPLAT-DEPTH-COMPOSE — WebGL parity: `GaussianSplatPrimitive.js` builds
  // its DrawCommand with `boundingVolume: tileset.boundingSphere` and
  // `modelMatrix: rootTransform` (GaussianSplatPrimitive.js:2140-2148). Those
  // fields drive per-frustum binning (`View.createPotentiallyVisibleSet`) and
  // the splat back-to-front sorter (`_backToFrontSplatsComparator` reads
  // `boundingVolume.center`). Without them a multi-frustum real-tileset splat
  // command is binned into every frustum band and never depth-sorted against
  // its neighbours. Both refresh every frame (the tileset bounding sphere
  // grows as tiles stream in). Synthetic FR-driven primitives without a
  // tileset (probes) leave `boundingVolume` undefined — null-safe: the sorter
  // short-circuits on missing centers and single-frustum binning is unaffected.
  const parityFields = primitive as unknown as {
    _tileset?: { boundingSphere?: CesiumBoundingSphere };
    _rootTransform?: Matrix4;
  };
  const commandBoundingVolume = parityFields._tileset?.boundingSphere;
  const commandModelMatrix = parityFields._rootTransform ?? mm;

  if (!cache.command) {
    const cmd = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup, effectsBG],
      // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — only the quad VB; splats
      // + sorted indices are read from group-0 storage buffers in the VS.
      vertexBuffers: [cache.quadVertexBuffer],
      vertexCount: 6,
      instanceCount: cache.splatCount,
      pass: Pass.GAUSSIAN_SPLATS,
      boundingVolume: commandBoundingVolume,
      modelMatrix: commandModelMatrix,
      owner:
        primitive as unknown as import("./WebGPUDrawCommand.js").WebGPUCommandOwner,
      // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — depth-write variant
      // for translucent-classification swap. Cesium3DTile.update flips
      // `depthForTranslucentClassification` for splat-pass commands so
      // the dispatcher swaps to this variant (writes depth to the
      // scene-FB) when a classifier needs to clip against the splat
      // surface. Without the variant, splats stay alpha-blended without
      // depth-write and classifiers pass through to whatever lies
      // behind. May be null when the central pipeline cache hasn't
      // resolved the variant yet — the dispatcher tolerates that.
      classificationDepthPipeline: cache.depthWritePipeline ?? undefined,
    });
    // GS-WSR: attach OIT pipeline variant for weighted-sum rendering
    if (cache.oitPipeline) {
      cmd._oitPipeline = cache.oitPipeline;
    }
    // Store shader code for dynamic OIT variant creation via scene renderer
    cmd._shaderCode = SPLAT_WGSL;
    cache.command = cmd;
  } else {
    // FEAT-GAP-09 (Batch 101) — per-frame effects BG refresh on
    // existing command. Slot 1 in the cached bindGroups array tracks
    // the active effects BG (or placeholder); swap it each frame so
    // shadow / CSM / atmosphere LUT toggles flow through.
    (cache.command as { bindGroups?: GPUBindGroup[] }).bindGroups = [
      cache.bindGroup,
      effectsBG,
    ];
    // C7-SPLAT-DEPTH-COMPOSE — refresh the WebGL-parity binning/sort fields on
    // the cached command (the tileset bounding sphere changes as tiles stream).
    cache.command.boundingVolume = commandBoundingVolume;
    cache.command.modelMatrix = commandModelMatrix;
  }
  if (
    cache.command &&
    cache.depthWritePipeline &&
    !cache.command.classificationDepthPipeline
  ) {
    // NEW-GS-CLASSIFICATION-DEPTH (Batch 176) — central-pipeline-cache
    // resolution races the command construction. If the depth-write
    // variant landed AFTER the command was first built (a frame later
    // than the color pipeline), patch it on so the dispatcher can swap
    // when needed. Cheap reference write; runs at most once per cache.
    cache.command.classificationDepthPipeline = cache.depthWritePipeline;
  }

  // C-R9 (Batch 31) — pick command. Same VS + splat buffer as the color
  // command; different pipeline (pickPipeline) that routes through the
  // `fragmentPickMain` entry point to emit u.pickColor. Wired onto the
  // color command's derivedCommands so the Batch 29 dispatcher routes
  // to it on pick passes.
  if (pickColor) {
    // Pick path uses placeholder effects BG — pipeline layout shared
    // with color, but `fragmentPickMain` doesn't sample atmosphere.
    const pickEffectsBG = getPlaceholderEffects(device).bindGroup;
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline!,
        bindGroups: [cache.bindGroup, pickEffectsBG],
        // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — quad VB only.
        vertexBuffers: [cache.quadVertexBuffer],
        vertexCount: 6,
        instanceCount: cache.splatCount,
        pass: Pass.GAUSSIAN_SPLATS,
        owner:
          primitive as unknown as import("./WebGPUDrawCommand.js").WebGPUCommandOwner,
        pickOnly: true,
      });
    }
    attachPickToColorCommand(
      cache.command as CesiumAnyDrawCommand,
      cache.pickCommand,
    );
  }

  // Batch 171 - B.10 NEW-ADVANCED-MOTION-VECTORS attach. Maintain a
  // one-frame-lagged prev mirror of the splat buffer.
  attachSplatVelocityCommand(device, context, frameState, cache);

  commandList.push(cache.command);
}

/**
 * Batch 171 - upload prev splat positions, build (or fetch) the
 * velocity pipeline, attach `velocityCommand` to the cache's color
 * command. Mirrors PointCloud Batch 168/169 + Cloud Batch 170.
 *
 * Falls into the GPU self-copy branch on:
 *   1. First frame ever — `prevSplatData` is null. Velocity = 0
 *      (no continuous "previous" exists).
 *   2. Splat-count change across revisions — prev byteLength
 *      mismatches the required size; emit velocity = 0 for the
 *      transition (no continuous index correspondence).
 *
 * @private
 */
function attachSplatVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: GaussianSplatCache,
): void {
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!taaEnabledThisFrame && !cache.prevSplatBuffer) {
    if (cache.command) {
      (cache.command as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
    return;
  }
  if (!cache.splatBuffer || cache.splatCount === 0) {
    return;
  }

  const requiredBytes = cache.splatCount * 64;
  if (!cache.prevSplatBuffer || cache.prevSplatBuffer.size < requiredBytes) {
    if (cache.prevSplatBuffer) {
      cache.prevSplatBuffer.destroy();
    }
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — prev splats are now a
    // read-only STORAGE buffer (group-0 binding 3) the velocity VS reads via
    // sortedIndices[instance_index] (parallel to the current splat fetch). The
    // bind group references it, so rebuild the bind group after realloc.
    cache.prevSplatBuffer = device.createBuffer({
      label: "GaussianSplat prev splats",
      size: requiredBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Rebuild the bind group immediately against the new prev buffer so the
    // velocity command built THIS frame (and the color command, which shares
    // the bind group) reference a valid group-0 binding 3.
    const res = (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources;
    if (
      res &&
      cache.uniformBuffer &&
      cache.splatBuffer &&
      cache.sortedIndexBuffer
    ) {
      cache.bindGroup = device.createBindGroup({
        layout: res.bgl,
        entries: [
          { binding: 0, resource: { buffer: cache.uniformBuffer } },
          { binding: 1, resource: { buffer: cache.splatBuffer } },
          { binding: 2, resource: { buffer: cache.sortedIndexBuffer } },
          { binding: 3, resource: { buffer: cache.prevSplatBuffer } },
        ],
      });
      // Color/pick commands captured the old bind group; refresh slot 0 while
      // preserving the per-frame effects BG already in slot 1.
      if (cache.command) {
        const cmdBGs = (cache.command as { bindGroups?: GPUBindGroup[] })
          .bindGroups;
        const effSlot =
          cmdBGs && cmdBGs[1]
            ? cmdBGs[1]
            : getPlaceholderEffects(device).bindGroup;
        (cache.command as { bindGroups?: GPUBindGroup[] }).bindGroups = [
          cache.bindGroup,
          effSlot,
        ];
      }
      cache.pickCommand = null;
    }
    // C10-09 T-4 - prev buffer was reallocated; resident revision is stale.
    cache.prevBufferRevision = undefined;
  }

  // C10-09-VELOCITY-PREV-BUFFER-GPU-COPY — revision-skip + GPU self-copy.
  const prevSrc = cache.prevSplatData;
  const isIdentity = prevSrc === cache.splatData; // static: prev IS curr
  if (
    isIdentity &&
    cache.prevSplatBuffer &&
    cache.prevSplatBuffer.size >= requiredBytes
  ) {
    // Identity (static splats): the bytes already reside in `splatBuffer` on
    // the GPU. Seed `prevSplatBuffer` from it ONCE then SKIP while the data
    // revision is unchanged (INV-1). Geometry velocity is 0 either way.
    if (cache.prevBufferRevision !== cache.instanceDataRevision) {
      const encoder = device.createCommandEncoder({
        label: "GaussianSplat prev identity-seed",
      });
      encoder.copyBufferToBuffer(
        cache.splatBuffer,
        0,
        cache.prevSplatBuffer,
        0,
        requiredBytes,
      );
      device.queue.submit([encoder.finish()]);
      cache.prevBufferRevision = cache.instanceDataRevision;
    }
    // else: static & already resident → NOTHING. This is the per-frame win.
  } else if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    // Animated distinct-array path (INV-2) — unchanged.
    device.queue.writeBuffer(
      cache.prevSplatBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
    cache.prevBufferRevision = undefined;
  } else {
    // First-frame seed OR count mismatch (INV-4) — existing GPU copy.
    const encoder = device.createCommandEncoder({
      label: "GaussianSplat prev seed",
    });
    encoder.copyBufferToBuffer(
      cache.splatBuffer,
      0,
      cache.prevSplatBuffer,
      0,
      requiredBytes,
    );
    device.queue.submit([encoder.finish()]);
    cache.prevBufferRevision = undefined;
  }

  // Lazy velocity pipeline build. Reuses the color BGL since the
  // velocity VS reads from the same uniform buffer.
  if (
    !cache.velocityPipelineDescriptor &&
    cache.shaderModule &&
    cache.pipelineLayout
  ) {
    cache.velocityPipelineDescriptor = {
      // NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH — `cache.shaderModule` below is the
      // LOG_DEPTH-gated module (chosen by `logDepthActive` in
      // `buildSplatPipelineResources`), and the `logDepthFlipped` branch nulls
      // this descriptor so it REBUILDS on a flip. The central pipeline cache
      // keys on the descriptor name and never reads the module, so a constant
      // name here would serve the previously-cached module's pipeline for the
      // newly-compiled one. Matches the `ld=` marker the color and depth-write
      // pipelines in this file already carry.
      name: `GaussianSplat velocity pipeline [ld=${
        cache.logDepthEnabled ? 1 : 0
      }]`,
      layout: cache.pipelineLayout,
      vertex: {
        module: cache.shaderModule,
        entryPoint: "vertexVelocityMain",
        // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — quad VB only. The
        // velocity VS reads the current splat (binding 1) and prev splat
        // (binding 3) from group-0 storage via sortedIndices[instance_index].
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
        module: cache.shaderModule,
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
  if (
    !cache.velocityPipeline &&
    cache.velocityPipelineDescriptor &&
    !cache.velocityPipelineRequestPending
  ) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    const pipelineCache = ctxAny.webgpuPipelineCache ?? null;
    if (pipelineCache) {
      const sync = pipelineCache.getPipelineSync(
        cache.velocityPipelineDescriptor,
      );
      if (sync) {
        cache.velocityPipeline = sync;
      } else {
        cache.velocityPipelineRequestPending = true;
        pipelineCache
          .getPipeline(cache.velocityPipelineDescriptor)
          .then((p) => {
            cache.velocityPipeline = p;
            cache.velocityPipelineRequestPending = false;
          })
          .catch(() => {
            cache.velocityPipelineRequestPending = false;
          });
      }
    } else {
      const desc = cache.velocityPipelineDescriptor;
      cache.velocityPipeline = device.createRenderPipeline({
        label: desc.name,
        layout: desc.layout ?? "auto",
        vertex: {
          module: desc.vertex.module,
          entryPoint: desc.vertex.entryPoint,
          buffers: desc.vertex.buffers,
        },
        fragment: desc.fragment
          ? {
              module: desc.fragment.module,
              entryPoint: desc.fragment.entryPoint,
              targets: desc.fragment.targets,
            }
          : undefined,
        primitive: desc.primitive,
        depthStencil: desc.depthStencil,
      });
    }
  }

  if (
    cache.command &&
    cache.velocityPipeline &&
    cache.prevSplatBuffer &&
    cache.quadVertexBuffer &&
    cache.splatBuffer
  ) {
    // Velocity path shares the color pipeline layout (effectsBGL at
    // slot 1); placeholder is safe — `vertexVelocityMain`/`fragmentVelocityMain`
    // don't sample atmosphere bindings.
    const velocityEffectsBG = getPlaceholderEffects(device).bindGroup;
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
        pipeline: cache.velocityPipeline,
        bindGroups: [cache.bindGroup, velocityEffectsBG],
        // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — quad VB only; curr +
        // prev splats are read from group-0 storage bindings 1/3.
        vertexBuffers: [cache.quadVertexBuffer],
        vertexCount: 6,
        instanceCount: cache.splatCount,
        pass: Pass.GAUSSIAN_SPLATS,
      });
  } else if (cache.command) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }

  if (cache.splatData) {
    cache.prevSplatData = cache.splatData;
  }
}

function destroyWebGPUGaussianSplatResources(
  primitive: CesiumObjectWithWebGPUCache,
): void {
  const cache = primitive._webgpuCache as GaussianSplatCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.splatBuffer?.destroy();
  // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — release the sorted-index
  // storage buffer.
  cache.sortedIndexBuffer?.destroy();
  // Batch 171 - release the velocity-path GPU buffer.
  cache.prevSplatBuffer?.destroy();

  // C-R9 (Batch 31 / refactored Batch 59) — release pick ID.
  destroyPickIds(primitive as unknown as SinglePickIdCache);

  primitive._webgpuCache = undefined;
}

// Alias for scene file import compatibility
const updateWebGPUGaussianSplatPrimitive = updateWebGPUGaussianSplats;
const destroyWebGPUGaussianSplatPrimitiveResources =
  destroyWebGPUGaussianSplatResources;

export {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
export default {
  updateWebGPUGaussianSplats,
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
  destroyWebGPUGaussianSplatPrimitiveResources,
};
