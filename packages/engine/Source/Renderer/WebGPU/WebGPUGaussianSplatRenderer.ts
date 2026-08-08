/**
 * WebGPU Gaussian Splat Renderer
 *
 * Renders 3D Gaussian Splatting primitives. Each splat is projected from
 * a 3D Gaussian to a 2D screen-space Gaussian evaluated per-pixel.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * References:
 *   - Bernhard Kerbl, Georgios Kopanas, Thomas Leimkuehler and George
 *     Drettakis, "3D Gaussian Splatting for Real-Time Radiance Field
 *     Rendering", ACM Transactions on Graphics 42(4), 2023 —
 *     {@link https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/}.
 *     The covariance projection, the spherical-harmonic evaluation of
 *     view-dependent colour and the front-to-back depth ordering implement
 *     that paper; they are written against WebGPU rather than ported from
 *     its CUDA reference.
 *
 * @module WebGPUGaussianSplatRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import BoundingSphere from "../../Core/BoundingSphere.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import type { WebGPUPipelineConfig } from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { preprocess } from "./WebGPUShaderPreprocessor.js";
import {
  ShaderDefine,
  ShaderDefineHi,
  ShaderSourceId,
} from "./WebGPUShaderDefines.js";
import {
  isWebGPULogDepthActive,
  isWebGPUPickLogDepthActive,
  recordLogDepthEncoder,
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
  // C15-G5 — packed SH coefficients (group 0 binding 4), the primitive's
  // `_shData` uploaded verbatim. Always allocated (a 16-byte placeholder when
  // the content carries no SH) so the bind group matches the ONE shared layout
  // regardless of the SPLAT_SPHERICAL_HARMONICS variant.
  shBuffer: GPUBuffer | null;
  // Identity of the `_shData` view last uploaded — the same producer-identity
  // dirty signal `splatSourceToken` is, and for the same reason: a snapshot
  // rebuild that lands on the same count and degree still publishes a fresh
  // subarray over a REUSED scratch buffer, so neither count nor degree is a
  // sufficient signal on its own.
  shSourceToken: ArrayBufferView | null;
  // Degree resident in `shBuffer` (0 = none), packed into the UBO each frame
  // as `u.shDegree`.
  shDegree: number;
  // Whether the SH term is active for the resident data. Separate from
  // `resourcesShEnabled` (which describes the compiled PIPELINES) for exactly
  // the reason `layoutPacked` / `resourcesLayoutPacked` are separate: the two
  // are legitimately out of step while a cold variant compiles.
  shEnabled: boolean;
  resourcesShEnabled: boolean;
  // C15-G3 — which attribute-record layout `splatBuffer` currently holds, and
  // therefore which `SPLAT_PACKED_WASM` shader variant the pipelines must be
  // built from. `true` = the 32-byte WASM `generate_splat_texture` record
  // (production); `false` = the historical 64-byte 16-f32 record (the three
  // synthetic probes). Drives `splatRecordBytes`, the velocity prev-buffer
  // size, and whether the in-renderer comparator sort is reachable at all.
  layoutPacked: boolean;
  // The layout the PIPELINE RESOURCES were compiled for. Tracked separately
  // from `layoutPacked` (which describes the resident BUFFER) because the two
  // are legitimately out of step for the frames between a layout flip and the
  // pipeline resolving: `tryResolveSplatPipelines` returns early while a cold
  // variant compiles (~2.7 s measured on this fork), and the buffer commit sits
  // BELOW that return. Comparing the flip against the buffer's layout would
  // therefore re-invalidate — and re-request — the pipelines on every frame of
  // that window.
  resourcesLayoutPacked: boolean;
  // Bytes per splat in `splatBuffer` — 32 packed, 64 legacy. Kept next to
  // `layoutPacked` so every size computation reads ONE number instead of
  // re-deriving the stride at each site (the class of bug this row exists to
  // fix was a stride disagreement between producer and consumer).
  splatRecordBytes: number;
  // Identity of the object that PRODUCED the resident bytes: the packed
  // payload object for the production path, the typed array itself for the
  // legacy path. A count-preserving re-commit (a snapshot rebuild that lands
  // on the same splat count) changes this and nothing else, so the count alone
  // is not a sufficient dirty signal.
  splatSourceToken: object | null;
  // C15-G3 — identity + length of the `primitive._indexes` permutation last
  // uploaded to `sortedIndexBuffer`. The WASM radix sort resolves into a fresh
  // array, so identity is the re-upload signal.
  providedIndexSource: ArrayBufferView | null;
  // C15-G4 — provenance of the RESIDENT permutation, mirrored from the
  // producer's stamp (`GaussianSplatPrimitive._indexesSortSequence` /
  // `_indexesDataGeneration`). The upload boundary is the swap point, so this
  // pair is what makes the swap monotonic: a resolution for an older camera
  // pose, or for a superseded data generation, is refused rather than allowed
  // to regress the order already on the GPU. `-1` = nothing resident (the
  // identity seed), which every stamped permutation beats.
  providedIndexSequence: number;
  providedIndexGeneration: number;
  // C15-G4 instruments. `comparatorSorts` is the `C15-G4` exit gate's own
  // observable: the row's contract is that the synchronous main-thread
  // comparator NEVER runs on production content, and "never" has to be
  // measured, not inferred. `providedSortUploads` counts worker permutations
  // that landed; `supersededSortUploads` counts the ones the sequence guard
  // refused.
  comparatorSorts: number;
  providedSortUploads: number;
  supersededSortUploads: number;
  // CPU-side sorted permutation staging; reused across frames when the count
  // is unchanged. Identity until the async sort resolves.
  sortIndices: Uint32Array | null;
  // Camera pose at the last sort so we only re-sort when the view moves enough.
  lastSortCameraDir: Cartesian3 | null;
  // Externally-forced re-sort request for the LEGACY comparator path: set it to
  // skip the view-angle throttle once. Retained per the `C15-G4` row (the
  // demand signal stays with the throttle); the production path takes its
  // demand from the shared `shouldStartSteadySort` in the primitive instead.
  sortRequestPending: boolean;
  splatCount: number;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;
  // C15-G6h (NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE) — MODEL-space bounds of the
  // resident splat centres, recomputed only when the attribute bytes change
  // (in the same block that uploads them, so it adds no new asymptotic cost),
  // and the world-space sphere the draw command carries. Kept separate because
  // the model matrix can change every frame while the data does not: the
  // per-frame work is one `BoundingSphere.transform`, not a rescan.
  localBoundingSphere: BoundingSphere | null;
  worldBoundingSphere: BoundingSphere | null;
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
  // NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — what the splat command publishes
  // to the dynamic OIT fallback. Mirrored off the pipeline resources so both
  // travel with the SAME variant axes the compiled OIT module was built from;
  // a `_shaderCode` on one axis set and a bind group on another is exactly the
  // class of defect this row exists to close.
  oitFallbackShaderCode: string | null;
  oitFallbackConfig: WebGPUPipelineConfig | null;
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
// read-only storage buffer (one attribute record per splat) and the draw
// indexes through a sorted-index storage buffer so the rasterizer visits
// splats in back-to-front depth order. Pre-Batch-288 the splat data was a
// per-instance VERTEX buffer drawn in storage order, so the premultiplied
// over-blend (order-dependent) produced wrong tinting/haloing that shifted
// with camera angle (audit A2.1). The CPU radix sort already produced a
// depth order (primitive._indexes) that the WebGPU draw silently dropped.
//
// C15-G3 — the attribute buffer is declared array<u32> and DECODED, in both
// layout variants, rather than typed as a struct. Two reasons:
//
//   1. The production layout is the WASM generate_splat_texture output
//      consumed VERBATIM (8 u32 = 32 bytes per splat), which is half u32-packed
//      (position bits, RGBA8) and half f16-pair-packed (covariance). No WGSL
//      struct describes it; it has to be unpacked with bitcast<f32> /
//      unpack2x16float anyway.
//   2. Keeping ONE binding type across both variants means the bind-group
//      layout, the bind group, and the pipeline layout are literally the same
//      objects for either layout — the only thing the SPLAT_PACKED_WASM
//      define changes is the arithmetic inside loadSplat.
//
// The legacy 64-byte record (16 f32: positionHigh(3) + positionLow(3) +
// covA(3) + covB(3) + rgba(4)) is read back out of the same u32 array with
// bitcast<f32>, which is bit-exact — the //>>else branch is the historical
// path for the three synthetic probes that still produce it.
struct SplatAttributes {
  positionHigh: vec3<f32>,
  positionLow: vec3<f32>,
  covA: vec3<f32>,   // Sxx, Sxy, Sxz
  covB: vec3<f32>,   // Syy, Syz, Szz
  color: vec4<f32>,
};
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  // C15-G3b — WebGL-parity footprint. The interpolated QUAD-CORNER coordinate
  // (GLSL v_vertPos): +/-1 at the quad edge along each principal axis of the
  // projected 2D covariance. The FS evaluates the same exp(-4*dot(v,v))
  // falloff PrimitiveGaussianSplatFS.glsl does, so the WebGPU splat has the
  // same SUPPORT and the same alpha profile as WebGL's, not merely the same
  // covariance. Replaces the pre-C15-G3b conic + pixel-offset pair, whose
  // 3-sigma square support rendered ~3.5x the area WebGL's sqrt(2)-sigma
  // oriented quad does.
  @location(1) vertPos: vec2<f32>,
  // FEAT-GAP-09 (Batch 103 audit fix) — splat-center RTE position
  // (position relative to camera) for the aerial-perspective fog
  // block. Per-quad-vertex spread is tiny relative to fog scale.
  @location(2) worldPos: vec3<f32>,
  //>>ifdef LOG_DEPTH
  // NEW-LOG-DEPTH-REMAINING-PRODUCERS-POINTCLOUD-SPLAT (Batch 288) —
  // interpolated linear depthFromNearPlusOne (splat-center eye distance + 1).
  // The FS converts it to log @builtin(frag_depth) so a splat cloud at
  // altitude depth-tests against the log-depth globe at FAR range instead of
  // z-fighting it. Per-quad-vertex depth spread is negligible vs the splat
  // center, so using the center value across the quad is correct.
  @location(3) v_logDepth: f32,
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
  // C15-G5 — spherical-harmonics view direction. The GLSL evaluates SH against
  //   normalize(u_inverseModelRotation * (splatWC - u_cameraPositionWC))
  // (PrimitiveGaussianSplatVS.glsl:190-193): a WORLD-space camera->splat vector
  // rotated into the SH training frame. This renderer never materializes a
  // world-space splat position — it works in the RTE residual posRTE, which
  // is that same camera->splat vector expressed in the primitive's MODEL frame
  // — so the CPU folds the two rotations into one matrix,
  //   shViewRotation = _shInverseRotation * mat3(modelMatrix),
  // and mat3(modelMatrix) * posRTE == splatWC - cameraWC EXACTLY for any
  // invertible model matrix (the translation cancels in the difference and the
  // camera is encoded in model space). UBO grows 320 → 384.
  shViewRotation: mat3x3<f32>,
  // C15-G5 — active SH degree, 0..3. The twin of GLSL's
  // u_sphericalHarmonicsDegree, kept a RUNTIME f32 (not folded into the
  // define) for the same reason the GLSL keeps it a uniform: a snapshot that
  // degrades to degree 0 must not force a pipeline recompile, and the >= 1./2./3.
  // comparison chain is then term-for-term with the reference.
  shDegree: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> splats: array<u32>;
// Sorted draw order — sortedIndices[instanceIndex] = the splat to draw at
// rasterizer instance position instanceIndex. Back-to-front for correct
// premultiplied over-blend.
@group(0) @binding(2) var<storage, read> sortedIndices: array<u32>;
// Batch 171 — prev-frame mirror of splats, SAME layout, read by the velocity
// VS at the same splat index.
@group(0) @binding(3) var<storage, read> prevSplats: array<u32>;
// C15-G5 — packed spherical-harmonics coefficients, bands 1-3, consumed
// VERBATIM from GaussianSplatPrimitive._shData (the same Uint32Array the WebGL
// path regroups into its RG32UI SH texture). Per splat: dims * 2 u32, where
// dims is the band count for the active degree (3 / 8 / 15); coefficient i
// occupies words splatID * dims * 2 + i * 2 (low u32 = f16 pair (r, g),
// high u32 = f16 (b) in its LOW half).
//
// DECLARED UNCONDITIONALLY, outside every //>>ifdef, so that the bind-group
// layout, the bind group and the pipeline layout are the SAME objects whether
// or not SPLAT_SPHERICAL_HARMONICS is set — the C15-G3 discipline. A non-SH
// primitive binds a 16-byte placeholder here.
@group(0) @binding(4) var<storage, read> shCoefficients: array<u32>;

//>>ifdef SPLAT_SPHERICAL_HARMONICS
// C15-G5 — the WGSL twin of PrimitiveGaussianSplatVS.glsl:10-101. Constants,
// band ordering and basis polynomials are term-for-term with the GLSL; the
// spec extracts BOTH and requires numeric agreement over a direction sweep.
//
// There is NO degree-0 (DC) term here, deliberately and by contract: the DC
// band is already folded into the base RGBA8 colour by the SPZ decode
// (GltfSpzLoader.js:23-24), the writer's per-degree base offsets start at band
// 1 (GaussianSplat3DTileContent.js base = [0, 9, 24]), and the GLSL only ever
// ADDS bands 1-3 on top of v_splatColor. Adding a DC term would roughly double
// every splat's brightness — the classic SH integration bug.
const SPLAT_SH_C1: f32 = 0.48860251;
const SPLAT_SH_C2 = array<f32, 5>(
  1.092548430,
  -1.09254843,
  0.315391565,
  -1.09254843,
  0.546274215,
);
const SPLAT_SH_C3 = array<f32, 7>(
  -0.59004358,
  2.890611442,
  -0.45704579,
  0.373176332,
  -0.45704579,
  1.445305721,
  -0.59004358,
);

// GLSL: const uint coefficientCount[3] = uint[3](3u,8u,15u), indexed by
// degree-1. Written as a comparison chain rather than a const-array lookup
// because the index is a RUNTIME value here (u.shDegree).
fn splatShCoefficientCount(degree: f32) -> u32 {
  if (degree >= 3.0) { return 15u; }
  if (degree >= 2.0) { return 8u; }
  return 3u;
}

// GLSL loadSHCoeff + halfToVec3, with the texture row addressing collapsed
// away: the WebGL texture is a pure regrouping of this same flat array
// (row r holds splats [r*splatsPerRow, (r+1)*splatsPerRow) at
// floatsPerRow = splatsPerRow * dims * 2 words), so the GLSL texel fetch
// texelFetch(tex, ivec2((splatID % splatsPerRow) * dims + index,
// splatID / splatsPerRow)) reads exactly the two words below.
fn loadSplatShCoefficient(splatID: u32, dims: u32, index: u32) -> vec3<f32> {
  let base = splatID * dims * 2u + index * 2u;
  let rg = unpack2x16float(shCoefficients[base]);
  let b = unpack2x16float(shCoefficients[base + 1u]);
  return vec3<f32>(rg.x, rg.y, b.x);
}

fn evaluateSplatSH(splatID: u32, degree: f32, viewDir: vec3<f32>) -> vec3<f32> {
  var result = vec3<f32>(0.0, 0.0, 0.0);
  let x = viewDir.x;
  let y = viewDir.y;
  let z = viewDir.z;

  if (degree >= 1.0) {
    let dims = splatShCoefficientCount(degree);
    let sh1 = loadSplatShCoefficient(splatID, dims, 0u);
    let sh2 = loadSplatShCoefficient(splatID, dims, 1u);
    let sh3 = loadSplatShCoefficient(splatID, dims, 2u);
    result += -SPLAT_SH_C1 * y * sh1 + SPLAT_SH_C1 * z * sh2 - SPLAT_SH_C1 * x * sh3;

    if (degree >= 2.0) {
      let xx = x * x;
      let yy = y * y;
      let zz = z * z;
      let xy = x * y;
      let yz = y * z;
      let xz = x * z;

      let sh4 = loadSplatShCoefficient(splatID, dims, 3u);
      let sh5 = loadSplatShCoefficient(splatID, dims, 4u);
      let sh6 = loadSplatShCoefficient(splatID, dims, 5u);
      let sh7 = loadSplatShCoefficient(splatID, dims, 6u);
      let sh8 = loadSplatShCoefficient(splatID, dims, 7u);
      result += SPLAT_SH_C2[0] * xy * sh4 +
              SPLAT_SH_C2[1] * yz * sh5 +
              SPLAT_SH_C2[2] * (2.0 * zz - xx - yy) * sh6 +
              SPLAT_SH_C2[3] * xz * sh7 +
              SPLAT_SH_C2[4] * (xx - yy) * sh8;

      if (degree >= 3.0) {
        let sh9 = loadSplatShCoefficient(splatID, dims, 8u);
        let sh10 = loadSplatShCoefficient(splatID, dims, 9u);
        let sh11 = loadSplatShCoefficient(splatID, dims, 10u);
        let sh12 = loadSplatShCoefficient(splatID, dims, 11u);
        let sh13 = loadSplatShCoefficient(splatID, dims, 12u);
        let sh14 = loadSplatShCoefficient(splatID, dims, 13u);
        let sh15 = loadSplatShCoefficient(splatID, dims, 14u);
        result += SPLAT_SH_C3[0] * y * (3.0 * xx - yy) * sh9 +
                SPLAT_SH_C3[1] * xy * z * sh10 +
                SPLAT_SH_C3[2] * y * (4.0 * zz - xx - yy) * sh11 +
                SPLAT_SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * sh12 +
                SPLAT_SH_C3[4] * x * (4.0 * zz - xx - yy) * sh13 +
                SPLAT_SH_C3[5] * z * (xx - yy) * sh14 +
                SPLAT_SH_C3[6] * x * (xx - 3.0 * yy) * sh15;
      }
    }
  }
  return result;
}
//>>endif

// C15-G3 — decode one splat out of the group-0 binding-1 storage buffer.
//
// RTE (CLAUDE.md "64-Bit Precision & RTE"): both variants return positionHigh
// and positionLow, and BOTH call sites keep the
// (positionHigh - u.encodedCameraHigh) + (positionLow - u.encodedCameraLow)
// cancellation structure. In the packed variant the WASM record stores position
// as a SINGLE f32 vec3, so there is no low word to recover — the f32 IS the
// data's precision ceiling, and positionLow = 0 is the honest encoding of
// that, not a dropped lane. RTE still buys the precision it exists for, on the
// CAMERA side: the CPU transforms the camera into the primitive's model frame
// (inverse(rootTransform) * cameraWC) and splits it high/low, and splat
// positions are metre-scale in that ENU frame by construction
// (GaussianSplatPrimitive.transformTile bakes every tile into
// inverse(_rootTransform)), so the large magnitude is cancelled BEFORE the
// f32 subtract rather than after it.
fn loadSplat(index: u32) -> SplatAttributes {
  var s: SplatAttributes;
//>>ifdef SPLAT_PACKED_WASM
  // 8 u32 per splat — the WASM generate_splat_texture record, decoded term
  // for term against PrimitiveGaussianSplatVS.glsl:152-173 (two side-by-side
  // RGBA32UI texels there; a flat u32 run here, which is the same bytes: the
  // GLSL row addressing (i & rowMask) << 1, i >> rowShift at width
  // maximumTextureSize reduces algebraically to texel 2*i).
  let base = index * 8u;
  s.positionHigh = vec3<f32>(
    bitcast<f32>(splats[base]),
    bitcast<f32>(splats[base + 1u]),
    bitcast<f32>(splats[base + 2u]),
  );
  s.positionLow = vec3<f32>(0.0, 0.0, 0.0);
  // splats[base + 3u] is unused in the WASM record (the GLSL reads the texel as
  // a vec4 and takes .xyz).
  let cov0 = unpack2x16float(splats[base + 4u]);
  let cov1 = unpack2x16float(splats[base + 5u]);
  let cov2 = unpack2x16float(splats[base + 6u]);
  // GLSL: Vrk = mat3(u1.x, u1.y, u2.x,  u1.y, u2.y, u3.x,  u2.x, u3.x, u3.y)
  //         → (Sxx, Sxy, Sxz, Syy, Syz, Szz) = (u1.x, u1.y, u2.x, u2.y, u3.x, u3.y)
  s.covA = vec3<f32>(cov0.x, cov0.y, cov1.x);
  s.covB = vec3<f32>(cov1.y, cov2.x, cov2.y);
  let packedColor = splats[base + 7u];
  s.color = vec4<f32>(
    f32(packedColor & 0xffu),
    f32((packedColor >> 8u) & 0xffu),
    f32((packedColor >> 16u) & 0xffu),
    f32((packedColor >> 24u) & 0xffu),
  ) / 255.0;
//>>else
  // Historical 16-f32 / 64-byte record. Scalar-packed (NOT vec3 fields): WGSL
  // gives vec3 a 16-byte size+alignment inside a struct, which would have made
  // a vec3-field record 80 bytes and mis-stride against the 64-byte CPU layout.
  // Reading it out of array<u32> with bitcast<f32> is bit-exact and keeps
  // the binding type identical across both variants.
  let base = index * 16u;
  s.positionHigh = vec3<f32>(
    bitcast<f32>(splats[base]),
    bitcast<f32>(splats[base + 1u]),
    bitcast<f32>(splats[base + 2u]),
  );
  s.positionLow = vec3<f32>(
    bitcast<f32>(splats[base + 3u]),
    bitcast<f32>(splats[base + 4u]),
    bitcast<f32>(splats[base + 5u]),
  );
  s.covA = vec3<f32>(
    bitcast<f32>(splats[base + 6u]),
    bitcast<f32>(splats[base + 7u]),
    bitcast<f32>(splats[base + 8u]),
  );
  s.covB = vec3<f32>(
    bitcast<f32>(splats[base + 9u]),
    bitcast<f32>(splats[base + 10u]),
    bitcast<f32>(splats[base + 11u]),
  );
  s.color = vec4<f32>(
    bitcast<f32>(splats[base + 12u]),
    bitcast<f32>(splats[base + 13u]),
    bitcast<f32>(splats[base + 14u]),
    bitcast<f32>(splats[base + 15u]),
  );
//>>endif
  return s;
}

// Batch 171 velocity — the prev mirror needs only the model-space position.
// Same layouts, same word offsets; a separate function because WGSL cannot take
// a pointer to a runtime-sized storage array portably.
fn loadPrevSplatModelPosition(index: u32) -> vec3<f32> {
//>>ifdef SPLAT_PACKED_WASM
  let base = index * 8u;
  return vec3<f32>(
    bitcast<f32>(prevSplats[base]),
    bitcast<f32>(prevSplats[base + 1u]),
    bitcast<f32>(prevSplats[base + 2u]),
  );
//>>else
  let base = index * 16u;
  // positionHigh + positionLow — the model-space position the prev VP lifts.
  return vec3<f32>(
    bitcast<f32>(prevSplats[base]),
    bitcast<f32>(prevSplats[base + 1u]),
    bitcast<f32>(prevSplats[base + 2u]),
  ) + vec3<f32>(
    bitcast<f32>(prevSplats[base + 3u]),
    bitcast<f32>(prevSplats[base + 4u]),
    bitcast<f32>(prevSplats[base + 5u]),
  );
//>>endif
}

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

// C15-G3b — the projected 2D covariance, in WebGL's units.
//
// Term for term with PrimitiveGaussianSplatVS.glsl's calcCovVectors head:
// J is the perspective Jacobian built from focal/t.z, Vrk_view = R*Sigma*R^T,
// cov = J^T * Vrk_view * J, and BOTH diagonals carry the same +0.3 dilation.
// u.focalX/Y are the FULL-viewport focal lengths (czm_projection[i][i] *
// czm_viewport.zw), NOT the half-viewport pixel focal the pre-C15-G3b code
// packed — which matters beyond a scale factor, because the +0.3 dilation and
// the 1024 clamp are ABSOLUTE constants: at half focal the dilation was
// effectively 4x stronger relative to the splat, inflating small splats.
//
// Returns (diagonal1, offDiagonal, diagonal2).
fn projectSplatCovariance(
  sigma: mat3x3<f32>,
  R: mat3x3<f32>,
  viewPos: vec3<f32>,
) -> vec3<f32> {
  let focal = vec2<f32>(u.focalX, u.focalY);
  let J1 = focal / viewPos.z;
  let J2 = -focal * vec2<f32>(viewPos.x, viewPos.y)
         / (viewPos.z * viewPos.z);
  let SV = R * sigma * transpose(R);
  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];
  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];
  let diagonal1 = J1.x*J1.x*a + 2.0*J1.x*J2.x*c + J2.x*J2.x*f + 0.3;
  let offDiagonal = J1.x*J1.y*b + J2.x*J1.y*e + J1.x*J2.y*c + J2.x*J2.y*f;
  let diagonal2 = J1.y*J1.y*d + 2.0*J1.y*J2.y*e + J2.y*J2.y*f + 0.3;
  return vec3<f32>(diagonal1, offDiagonal, diagonal2);
}

struct SplatQuadAxes {
  major: vec2<f32>,
  minor: vec2<f32>,
};

// C15-G3b — the oriented quad half-axes, in pixels.
//
// PrimitiveGaussianSplatVS.glsl's calcCovVectors tail, with ONE deliberate
// deviation, called out because it is a divergence from the reference:
//
//   GLSL: diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1))
//
// For an axis-aligned splat that argument is EXACTLY (0, 0) — offDiagonal is
// zero and lambda1 collapses to max(diagonal1, diagonal2) — so normalize
// returns NaN and the whole quad degenerates. Real splat clouds never land
// exactly there, but a synthetic isotropic covariance at the screen centre
// does, which is precisely what probe-splat-sort.mjs feeds this shader. The
// guarded form below picks the x axis in that case, which is correct for a
// circular footprint (every axis is a principal axis) and byte-identical to
// the GLSL whenever the GLSL is well-defined at all.
fn splatQuadAxes(cov: vec3<f32>) -> SplatQuadAxes {
  let diagonal1 = cov.x;
  let offDiagonal = cov.y;
  let diagonal2 = cov.z;
  let mid = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2<f32>((diagonal1 - diagonal2) * 0.5, offDiagonal));
  let lambda1 = mid + radius;
  let lambda2 = max(mid - radius, 0.1);
  let rawDirection = vec2<f32>(offDiagonal, lambda1 - diagonal1);
  let directionLength = length(rawDirection);
  let diagonalVector = select(
    vec2<f32>(1.0, 0.0),
    rawDirection / max(directionLength, 1e-20),
    directionLength > 1e-12,
  );
  var axes: SplatQuadAxes;
  axes.major = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
  axes.minor = min(sqrt(2.0 * lambda2), 1024.0)
             * vec2<f32>(diagonalVector.y, -diagonalVector.x);
  return axes;
}

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  input: VertexInput,
) -> VertexOutput {
  var output: VertexOutput;
  // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — index through the sorted
  // order so the rasterizer visits splats back-to-front.
  let splatIdx = sortedIndices[instanceIndex];
  let s = loadSplat(splatIdx);
  let positionHigh = s.positionHigh;
  let positionLow = s.positionLow;
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
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
    vec3<f32>(s.covA.x, s.covA.y, s.covA.z),
    vec3<f32>(s.covA.y, s.covB.x, s.covB.y),
    vec3<f32>(s.covA.z, s.covB.y, s.covB.z),
  );
  let cov = projectSplatCovariance(Sigma, R, t.xyz);
  let axes = splatQuadAxes(cov);
  // WebGL's whole-splat rejections, ported verbatim
  // (PrimitiveGaussianSplatVS.glsl:159-165 and :180-183): a centre well
  // outside the frustum, and a footprint under 2 px on BOTH principal axes.
  let clipLimit = 1.2 * clipPos.w;
  let offscreen = clipPos.z < -clipLimit
               || clipPos.x < -clipLimit || clipPos.x > clipLimit
               || clipPos.y < -clipLimit || clipPos.y > clipLimit;
  let subPixel = dot(axes.major, axes.major) < 4.0
              && dot(axes.minor, axes.minor) < 4.0;
  // Both diagonals carry the +0.3 dilation, so in every well-defined case they
  // are >= 0.3; this fires only on a NaN/Inf covariance (a splat at t.z == 0).
  // The GLSL has the same exposure and no guard — a strict robustness win with
  // zero parity cost, and it replaces the pre-C15-G3b det <= 0 test that the
  // conic formulation needed and this one does not.
  let degenerate = !(cov.x > 0.0) || !(cov.z > 0.0);
  if (offscreen || subPixel || degenerate) {
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.color = vec4<f32>(0.0);
    output.vertPos = vec2<f32>(0.0);
    output.worldPos = vec3<f32>(0.0);
    //>>ifdef LOG_DEPTH
    output.v_logDepth = 1.0;
    //>>endif
    return output;
  }
  // Oriented quad, WebGL's expansion term for term:
  //   gl_Position += vec4((corner.x*major + corner.y*minor) / viewport * w, 0, 0)
  // Note there is NO factor of 2 and the focal lengths are FULL-viewport, so
  // the two cancel into the same screen-space extent the GLSL produces.
  let corner = input.quadVertex;
  let ndcOff = (corner.x * axes.major + corner.y * axes.minor)
             / u.viewportSize * clipPos.w;
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
  //>>ifdef SPLAT_SPHERICAL_HARMONICS
  // PrimitiveGaussianSplatVS.glsl:189-194, term for term:
  //   vec4 splatWC = czm_inverseView * splatViewPos;
  //   vec3 viewDirModel = normalize(u_inverseModelRotation *
  //                                 (splatWC.xyz - u_cameraPositionWC.xyz));
  //   v_splatColor.rgb += evaluateSH(texIdx, viewDirModel).rgb;
  // u.shViewRotation * posRTE IS that argument (see the Uniforms comment):
  // posRTE is the camera->splat vector in model space, and shViewRotation is
  // inverse(SH frame) * mat3(modelMatrix). The SH result is ADDED to the base
  // colour — which already carries the DC band — and alpha is untouched.
  let shViewDir = normalize(u.shViewRotation * posRTE);
  output.color = vec4<f32>(
    s.color.rgb + evaluateSplatSH(splatIdx, u.shDegree, shViewDir),
    s.color.a,
  );
  //>>else
  output.color = s.color;
  //>>endif
  output.vertPos = corner;
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
  // C15-G3b — PrimitiveGaussianSplatFS.glsl's falloff, verbatim:
  //   A = -dot(v_vertPos, v_vertPos);  if (A < -4.) discard;
  //   B = exp(A * 4.) * v_splatColor.a;
  //   out = vec4(rgb * B, B);
  // The A * 4. is upstream's deliberate sharpening — it renders a gaussian
  // of effective sigma/2 — and the quad edge (|v| = 1) sits at exp(-4) = 1.8%
  // of peak alpha. The pre-C15-G3b conic form evaluated the TRUE gaussian out
  // to a 3-sigma square instead, i.e. a ~3.5x larger footprint at a much
  // flatter profile; matching WebGL means matching BOTH the support and the
  // profile, not just the covariance. The min(0.99, ...) alpha cap and the
  // 1/255 discard the conic form carried are gone: WebGL has neither, and the
  // cap visibly diverged for opaque splats.
  let A = -dot(input.vertPos, input.vertPos);
  if (A < -4.0) { discard; }
  let alpha = exp(A * 4.0) * input.color.a;
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
  // C15-G3b — mirror the colour FS's footprint exactly so pick hits only the
  // pixels the colour pass painted. Pick keeps its OWN visibility floor (the
  // colour pass has none, matching WebGL): a pick hit on a fragment at 1/255
  // alpha is not something a user can see or aim at.
  let A = -dot(input.vertPos, input.vertPos);
  if (A < -4.0) { discard; }
  let alpha = exp(A * 4.0) * input.color.a;
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

@vertex
fn vertexVelocityMain(
  @builtin(instance_index) instanceIndex: u32,
  input: VertexInput,
) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  let splatIdx = sortedIndices[instanceIndex];
  let s = loadSplat(splatIdx);
  let positionHigh = s.positionHigh;
  let positionLow = s.positionLow;
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
  let prevModelPos = vec4<f32>(loadPrevSplatModelPosition(splatIdx), 1.0);
  let prevWorldPos = u.modelMatrix * prevModelPos;
  let prevCenterClip = u.prevViewProjection * prevWorldPos;

  // Batch 172 — Replicate the full elliptical footprint expansion from
  // vertexMain so the velocity texture covers the SAME pixels the
  // color pass touched (within numerical precision). Pre-Batch-172 a
  // coarse 2-pixel square footprint left edge pixels of large splats
  // outside the velocity texture, falling back to camera-only TAA
  // reprojection at the splat edges of animated splats.
  //
  // C15-G3b — through the SAME two helpers vertexMain uses, so the velocity
  // texture keeps covering exactly the pixels the colour pass touched. Before
  // this the two were separate copies of the same math; a footprint change in
  // one silently desynchronized the other, which is how the coverage they are
  // supposed to share would have drifted.
  let t = u.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  let R = mat3x3<f32>(
    u.modelViewRelativeToEye[0].xyz,
    u.modelViewRelativeToEye[1].xyz,
    u.modelViewRelativeToEye[2].xyz,
  );
  let Sigma = mat3x3<f32>(
    vec3<f32>(s.covA.x, s.covA.y, s.covA.z),
    vec3<f32>(s.covA.y, s.covB.x, s.covB.y),
    vec3<f32>(s.covA.z, s.covB.y, s.covB.z),
  );
  let cov = projectSplatCovariance(Sigma, R, t.xyz);
  let axes = splatQuadAxes(cov);
  let subPixel = dot(axes.major, axes.major) < 4.0
              && dot(axes.minor, axes.minor) < 4.0;
  let degenerate = !(cov.x > 0.0) || !(cov.z > 0.0);
  if (subPixel || degenerate) {
    // Degenerate splat — emit a behind-camera zero-coverage triangle so
    // the velocity FS never executes for this instance. Mirrors
    // vertexMain's degenerate handling.
    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    output.currCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    output.prevCenterClip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }
  let corner = input.quadVertex;
  let ndcOff = (corner.x * axes.major + corner.y * axes.minor)
             / u.viewportSize * currCenterClip.w;
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
// C15-G5 — the SH view-direction fold: mat3(modelMatrix), then
// _shInverseRotation * that.
const scratchModelRotation = new Matrix3();
const scratchShRotation = new Matrix3();

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
  // NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — the two halves the dynamic OIT
  // fallback in `WebGPUSceneRendererTranslucentPass` needs from this renderer.
  // See `buildSplatPipelineResources` for why they are built unconditionally.
  oitFallbackShaderCode: string;
  oitFallbackConfig: WebGPUPipelineConfig;
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
  packedWasmLayout: boolean = false,
  sphericalHarmonics: boolean = false,
): SplatPipelineResources {
  // C15-G3 — the record-layout axis lives in the HI define word
  // (`ShaderDefineHi.SPLAT_PACKED_WASM`; the lo word is full at bit 30). It is
  // orthogonal to LOG_DEPTH and applies to EVERY variant built here — color,
  // depth-write, pick, OIT and velocity all read the same storage buffer, so a
  // variant compiled against the other stride would decode garbage rather than
  // simply look different.
  //
  // C15-G5 — the view-dependent-colour axis rides the SAME hi word. It applies
  // to every variant for the same reason: pick and velocity share `vertexMain`
  // (whose colour output the OIT fragment path also consumes), so compiling one
  // of them without the SH term would make the pick footprint and the OIT
  // colour disagree with the colour pass.
  const layoutDefinesHi =
    (packedWasmLayout ? ShaderDefineHi.SPLAT_PACKED_WASM : 0) |
    (sphericalHarmonics ? ShaderDefineHi.SPLAT_SPHERICAL_HARMONICS : 0);
  const layoutMarker = packedWasmLayout ? 1 : 0;
  const shMarker = sphericalHarmonics ? 1 : 0;
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
    `GaussianSplat [packed=${layoutMarker}/sh=${shMarker}]`,
    0,
    layoutDefinesHi,
  );
  const sm = logDepthActive
    ? moduleCache.getOrCreate(
        ShaderSourceId.GAUSSIAN_SPLAT,
        SPLAT_WGSL,
        ShaderDefine.LOG_DEPTH,
        `GaussianSplat [log/packed=${layoutMarker}/sh=${shMarker}]`,
        0,
        layoutDefinesHi,
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
        `GaussianSplat [log/packed=${layoutMarker}/sh=${shMarker}]`,
        0,
        layoutDefinesHi,
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
    // C15-G5 — packed SH coefficients. Declared here UNCONDITIONALLY, exactly
    // like the WGSL binding, so both states of SPLAT_SPHERICAL_HARMONICS share
    // one BGL / bind group / pipeline layout. A layout may legally carry an
    // entry the shader does not reference, which is what the non-SH variant is.
    storageBuffer(4, Stage.VERTEX, { readOnly: true }),
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
    name: `GaussianSplat color pipeline [ld=${logDepthActive ? 1 : 0}/ms=${sampleCount}/packed=${layoutMarker}/sh=${shMarker}]`,
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
    // C15-G3 — the layout axis must reach the OIT source too: an OIT module
    // compiled from the other stride would decode garbage, not merely blend
    // differently. C15-G5 — and so must the SH axis, or the OIT pass would
    // composite the base colour while the color pass composites the
    // view-dependent one. Both ride `layoutDefinesHi`. LOG_DEPTH stays cleared
    // here (the injector expects the bare `@location(0)` fragmentMain and the
    // OIT pass has depthWriteEnabled:false).
    const baseCode = preprocess(SPLAT_WGSL, 0, layoutDefinesHi);
    const oitCode = WebGPUOIT.injectOITOutput(baseCode, "fragmentMain");
    oitShaderModule = device.createShaderModule({
      label: `GaussianSplat-OIT-GS-WSR [packed=${layoutMarker}/sh=${shMarker}]`,
      code: oitCode,
    });
    oitDescriptor = {
      name: `GaussianSplat-OIT-Pipeline [packed=${layoutMarker}/sh=${shMarker}]`,
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
          ? `GaussianSplat pick pipeline [ld/packed=${layoutMarker}/sh=${shMarker}]`
          : `GaussianSplat pick pipeline [packed=${layoutMarker}/sh=${shMarker}]`,
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
    name: `GaussianSplat depth-write pipeline [ld=${logDepthActive ? 1 : 0}/ms=${sampleCount}/packed=${layoutMarker}/sh=${shMarker}]`,
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  };

  // ── NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE, second half.
  //
  // `WebGPUSceneRendererTranslucentPass` (`:165-205`) builds an OIT pipeline
  // for any command carrying `_shaderCode` but no `_oitPipeline`, and when the
  // command carries no `_pipelineConfig` it substitutes `layout: "auto"`. The
  // splat VS reads three group-0 storage buffers plus a UBO through an
  // EXPLICIT `GPUPipelineLayout`, and the command's cached bind groups were
  // created against THAT layout — binding them to an auto-derived layout is a
  // WebGPU validation error, not a visual difference. `C15-G3` fixed the
  // `_shaderCode` half (it now ships preprocessed source rather than the raw
  // `//>>ifdef` template); this is the layout half.
  //
  // Built UNCONDITIONALLY, not inside the `try` above: `oitDescriptor` is null
  // exactly when `injectOITOutput` threw, and that is one of the two states in
  // which the fallback is reached (the other is a pipeline-cache resolution
  // that has not landed yet, where the fallback CAN succeed and must therefore
  // have the real layout). The fields mirror `oitDescriptor` term for term, so
  // a fallback pipeline is the same pipeline the renderer would have built —
  // `createOITPipeline` supplies `WebGPUOIT.OIT_TARGETS` and forces
  // `depthWriteEnabled: false` itself, which is why neither appears here.
  const oitFallbackShaderCode = preprocess(SPLAT_WGSL, 0, layoutDefinesHi);
  const oitFallbackConfig: WebGPUPipelineConfig = {
    label: `GaussianSplat [packed=${layoutMarker}/sh=${shMarker}]`,
    layout,
    vertexBuffers: SPLAT_VERTEX_BUFFERS,
    vertexEntryPoint: "vertexMain",
    fragmentEntryPoint: "fragmentMain",
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: { count: sampleCount },
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
    oitFallbackShaderCode,
    oitFallbackConfig,
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
// C15-G4 — a legacy-layout cloud this large would make the synchronous
// comparator a visible main-thread stall. The three in-tree exercisers are 3,
// 27 and a handful of splats, so this can only fire for an out-of-tree producer
// that should be supplying `_indexes` instead. Diagnostic only: the sort still
// runs, so no feature is bypassed to protect a metric.
const COMPARATOR_STALL_SPLATS = 65536;
const _reportedComparatorStall = new WeakSet<object>();
const scratchSortDir = new Cartesian3();
const scratchSortMV = new Matrix4();

/**
 * C15-G3 — the transform that takes splat MODEL space to world space.
 *
 * A production `GaussianSplatPrimitive` has NO `modelMatrix` member: its WebGL
 * DrawCommand is built with `modelMatrix: primitive._rootTransform`
 * (`GaussianSplatPrimitive.js:2307-2321`), the ENU frame at the tileset
 * bounding-sphere centre that `transformTile` bakes every tile into so
 * `view * modelMatrix` stays numerically small. Reading `modelMatrix` alone —
 * which is all this renderer did while it was only ever fed synthetic data —
 * resolves to IDENTITY for real content and places the whole cloud at the
 * geocentre.
 *
 * `_rootTransform` wins when present; the three synthetic probes set
 * `modelMatrix` and no `_rootTransform`, so they are unaffected.
 *
 * @private
 */
function splatModelMatrix(primitive: CesiumObjectWithWebGPUCache): Matrix4 {
  const fields = primitive as unknown as {
    _rootTransform?: Matrix4;
    modelMatrix?: Matrix4;
  };
  return fields._rootTransform ?? fields.modelMatrix ?? Matrix4.IDENTITY;
}

/**
 * NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288). CPU back-to-front sort of the
 * splat indices by view-space depth, uploaded to the sorted-index storage
 * buffer the VS reads via `sortedIndices[instance_index]`. Without this the
 * WebGPU draw visited splats in buffer order, producing order-dependent
 * premultiplied over-blend errors (audit A2.1). Runs only when the camera has
 * rotated enough since the last sort (cheap-frame amortization). The sort key
 * is the splat-center eye-space z; farthest (most negative z) drawn first.
 *
 * # `C15-G4` — why this is RETIRED but not deleted
 *
 * It is a synchronous main-thread `Array.prototype.sort` with a JS comparator
 * over a freshly allocated `Float64Array(count)`. On production content that is
 * a per-frame stall — `tower` is 286,868 splats — so `C15-G4` retires it from
 * that path STRUCTURALLY: the packed layout returns before any work, and
 * `uploadProvidedSortOrder` has already consumed the worker's permutation by
 * the time this is called at all.
 *
 * It is NOT dead code (Principle 7). The LEGACY 16-f32 record has exactly three
 * exercisers, all synthetic probe primitives that carry `_splatData` and no
 * `_indexes` — `probe-splat-sort.mjs` (which asserts the non-identity
 * permutation and is the Batch-288 sort-consume evidence),
 * `probe-splat-globe-occlusion.mjs` and `probe-oit-transparency.mjs`. Deleting
 * this would leave those three drawing in identity order and turn a green
 * instrument red for a reason that has nothing to do with what it measures.
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
  // C15-G4 — the retirement itself. The packed production path takes its
  // permutation from the WASM radix sort the shared pipeline already ran
  // (`primitive._indexes`), uploaded by `uploadProvidedSortOrder` above; this
  // comparator is the LEGACY-layout fallback only. Removing this line puts a
  // synchronous 286k-element main-thread sort back on every qualifying frame.
  if (cache.layoutPacked) {
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
  const mm = splatModelMatrix(primitive);
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
  // C15-G4 instrument — the exit gate reads this off the cache and requires 0
  // on production content. Counted at the point the sort ACTUALLY ran, not at
  // entry, so the throttled and early-returned frames do not inflate it.
  cache.comparatorSorts++;
  // Permanent sentinel (no pragma): reaching a main-thread comparator sort at
  // this size is the stall `C15-G4` exists to prevent, and it can only happen
  // if a legacy-layout producer grew past probe scale. Behaviour is unchanged —
  // the sort still runs, so nothing is bypassed or degraded — but the condition
  // must reach the console, once, rather than showing up as a frame-time
  // mystery.
  if (
    count >= COMPARATOR_STALL_SPLATS &&
    !_reportedComparatorStall.has(cache)
  ) {
    _reportedComparatorStall.add(cache);
    console.error(
      `[CesiumJS:webgpu] GaussianSplat legacy comparator sorted ${count} splats on the main thread. The async WASM radix sort (primitive._indexes) is the production path; a producer this large must supply it.`,
    );
  }

  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indices);
  if (dir) {
    cache.lastSortCameraDir = Cartesian3.normalize(
      dir,
      cache.lastSortCameraDir ?? new Cartesian3(),
    );
  }
  cache.sortRequestPending = false;
}

/**
 * The bytes the packed WASM texture generator produced for this primitive,
 * carried on the snapshot as `{ width, height, data }` and committed to
 * `primitive._packedSplatTextureData` by `GaussianSplatPrimitive.commitSnapshot`
 * on the native branch ONLY (WebGL holds the same bytes in a `Texture`).
 *
 * @private
 */
interface PackedSplatTextureData {
  width: number;
  height: number;
  data: Uint32Array;
}

/** Bytes per splat in each attribute-record layout. @private */
const PACKED_SPLAT_RECORD_BYTES = 32;
const LEGACY_SPLAT_RECORD_BYTES = 64;
/** u32 words per splat in the packed WASM record. @private */
const PACKED_SPLAT_RECORD_WORDS = PACKED_SPLAT_RECORD_BYTES / 4;
// C15-G6h — f32 lanes per legacy record, the unit `computeLocalSplatBoundingSphere`
// strides by. Derived from the byte size for the same reason the word count is:
// a literal here could drift from the record the shader decodes.
const LEGACY_SPLAT_RECORD_FLOATS = LEGACY_SPLAT_RECORD_BYTES / 4;

/**
 * Payloads whose short-buffer error has already been reported, so the
 * permanent sentinel below fires once per bad payload rather than once per
 * frame. Weak so a retired snapshot is collectable.
 *
 * @private
 */
const _reportedShortPayloads = new WeakSet<object>();

/**
 * C15-G3 — resolve which attribute bytes this primitive is offering, and in
 * which layout.
 *
 * Two producers exist and they are NOT interchangeable:
 *
 *   * `_packedSplatTextureData` — the WASM `generate_splat_texture` output,
 *     8 u32 per splat, the PRODUCTION path. Consumed verbatim (Option B in the
 *     `C15-G3` row): no CPU repack, half the GPU memory of the expanded record,
 *     and a covariance that is bit-identical to what WebGL samples out of its
 *     `RGBA32UI` texture — which is what makes a tight `C15-G8` parity
 *     threshold reachable at all.
 *   * `_splatData` / `_renderResources.splatBuffer` — the historical 16-f32
 *     record. Nothing in `packages/` emits it; the three synthetic splat probes
 *     do, and they are the Batch-288 sort-consume evidence.
 *
 * `computeSplatTextureLayout` pads the packed buffer out to the full
 * `width * height * 4` texture footprint, but the splat records themselves are
 * a tight `count * 8` run at the FRONT of it — the GLSL row addressing
 * (`(i & rowMask) << 1`, `i >> rowShift` at width `maximumTextureSize`) reduces
 * to texel `2*i` exactly, which is why the padding can be sliced off rather
 * than decoded around.
 *
 * @private
 */
function resolveSplatSource(primitive: CesiumObjectWithWebGPUCache): {
  view: ArrayBufferView | null;
  count: number;
  packed: boolean;
  token: object | null;
} {
  const fields = primitive as unknown as {
    _splatData?: ArrayBufferView;
    _renderResources?: { splatBuffer?: ArrayBufferView };
    _splatCount?: number;
    _packedSplatTextureData?: PackedSplatTextureData;
    _numSplats?: number;
  };
  const legacy = fields._splatData ?? fields._renderResources?.splatBuffer;
  if (legacy) {
    return {
      view: legacy,
      count: fields._splatCount ?? 0,
      packed: false,
      token: legacy,
    };
  }
  const payload = fields._packedSplatTextureData;
  const count = fields._numSplats ?? 0;
  if (payload?.data && count > 0) {
    const words = count * PACKED_SPLAT_RECORD_WORDS;
    if (payload.data.length < words) {
      // The shared layout pass guarantees `data.length >= count * 8`; a short
      // buffer would make the VS read out of bounds (clamped to zero by WebGPU,
      // i.e. a silently truncated cloud). Loud, unpragma'd: this is the
      // producer/consumer stride disagreement the whole row exists to prevent.
      // Latched per payload so an impossible-but-real condition reports once
      // instead of once per frame.
      if (!_reportedShortPayloads.has(payload)) {
        _reportedShortPayloads.add(payload);
        console.error(
          `[CesiumJS:webgpu] GaussianSplat packed payload is short: ${payload.data.length} u32 for ${count} splats (need ${words}). Splat draw skipped.`,
        );
      }
      return { view: null, count: 0, packed: true, token: null };
    }
    return {
      view: payload.data.subarray(0, words),
      count,
      packed: true,
      // The PAYLOAD object, not the subarray: a fresh subarray view is
      // allocated on every call, so its identity would report "changed" every
      // frame and re-upload 9 MB per frame on `tower`.
      token: payload,
    };
  }
  return { view: null, count: 0, packed: false, token: null };
}

/**
 * C15-G5 — bands per splat for an SH degree.
 *
 * The JS twin of the WGSL `splatShCoefficientCount` and the GLSL
 * `coefficientCount[3] = uint[3](3u, 8u, 15u)` table. Kept here (rather than
 * read off the snapshot's `shCoefficientCount`) so the consumer derives the
 * stride from the SAME quantity the shader does: a degree/count disagreement
 * on the producer side then shows up as a SHORT BUFFER below instead of as a
 * silently mis-strided read.
 *
 * @private
 */
function splatShBandCount(degree: number): number {
  if (degree >= 3) {
    return 15;
  }
  if (degree >= 2) {
    return 8;
  }
  return 3;
}

/** u32 words per SH coefficient — an f16 (r, g) pair plus an f16 b. @private */
const SH_COEFFICIENT_WORDS = 2;

/**
 * Payloads whose short-SH-buffer error has already been reported. Same
 * once-per-payload latching as `_reportedShortPayloads`.
 *
 * @private
 */
const _reportedShortShPayloads = new WeakSet<object>();

/**
 * C15-G5 — resolve the spherical-harmonics coefficients this primitive is
 * offering, and at what degree.
 *
 * `GaussianSplatPrimitive.commitSnapshot` publishes `_shData` (the aggregated,
 * f16-packed `Uint32Array`) and `_sphericalHarmonicsDegree` for BOTH backends —
 * the WebGL path additionally regroups the same array into an `RG32UI` texture,
 * which is a pure row-padding rearrangement of these bytes. Consuming the flat
 * array VERBATIM is therefore bit-exact against WebGL and needs no new producer
 * (the `C15-G3` Option-B precedent).
 *
 * Returns `enabled: false` — i.e. degree 0, base colour only — for content with
 * no SH, and for a payload too short to describe `count` splats at its declared
 * degree. The degrade-to-0 decision for an over-tall SH texture is NOT made
 * here: it is made once, backend-neutrally, in
 * `GaussianSplatPrimitive.applySphericalHarmonicsBudget`, and reaches this
 * function as a degree of 0 on both backends alike
 * (`NEW-SPLAT-SH-DEGREE-BACKEND-DEPENDENT`).
 *
 * @private
 */
function resolveSplatShSource(
  primitive: CesiumObjectWithWebGPUCache,
  count: number,
): {
  view: ArrayBufferView | null;
  degree: number;
  enabled: boolean;
  token: ArrayBufferView | null;
} {
  const fields = primitive as unknown as {
    _shData?: Uint32Array;
    _sphericalHarmonicsDegree?: number;
  };
  const shData = fields._shData;
  const degree = fields._sphericalHarmonicsDegree ?? 0;
  if (!shData || !(degree >= 1) || count <= 0) {
    return { view: null, degree: 0, enabled: false, token: null };
  }
  const words = count * splatShBandCount(degree) * SH_COEFFICIENT_WORDS;
  if (shData.length < words) {
    // A short SH payload would make the VS read out of bounds (clamped to zero
    // by WebGPU) — i.e. splats silently losing their view-dependent colour
    // partway through the cloud. Loud and unpragma'd, once per payload: this is
    // the producer/consumer stride disagreement class the row exists to avoid.
    if (!_reportedShortShPayloads.has(shData)) {
      _reportedShortShPayloads.add(shData);
      console.error(
        `[CesiumJS:webgpu] GaussianSplat SH payload is short: ${shData.length} u32 for ${count} splats at degree ${degree} (need ${words}). Spherical harmonics disabled for this cloud.`,
      );
    }
    return { view: null, degree: 0, enabled: false, token: null };
  }
  return {
    view: shData.length === words ? shData : shData.subarray(0, words),
    degree,
    enabled: true,
    // The SOURCE array, not the trimmed subarray: `subarray` allocates a fresh
    // view on every call, so its identity would report "changed" every frame.
    token: shData,
  };
}

/**
 * C15-G6h (NEW-SPLAT-MULTIFRUSTUM-DEPTH-COMPOSE) — MODEL-space bounding sphere
 * over the resident splat centres.
 *
 * # Why the command needs one at all
 *
 * `View.createPotentiallyVisibleSet` gives a command with NO `boundingVolume`
 * the camera's worst-case span (`View.js:382-392`). Under log depth that span
 * is `[0.1, 1e10]`, whose 1e11 ratio splits into TWO depth slices — and the
 * BV-less command then bins into BOTH, while the globe (whose tiles carry real
 * bounding volumes) bins only into the near one. The frustum loop clears depth
 * between slices (`WebGPUSceneRendererFrustumLoop.ts:251-253`) and preserves
 * colour, so the splat's far-slice execution draws against a depth buffer that
 * does not contain the globe. That is the `C15-G6h` leak: measured at Batch 888
 * with all three producers' baked log-depth pairs EQUAL, which excluded the
 * encode and left the binning.
 *
 * B647 already added `boundingVolume: tileset.boundingSphere` for real content
 * (matching `GaussianSplatPrimitive.js:2318`), but every exerciser of this path
 * is a synthetic primitive with no `_tileset`, so that fix has never executed —
 * the `C15-G6` queue row records exactly that. This derivation closes the gap
 * for ANY producer, so a custom or synthetic primitive cannot silently inherit
 * the worst-case span.
 *
 * # Cost
 *
 * Called ONLY from the attribute-commit block, which already walks the same
 * bytes to upload them and already fills an O(n) identity permutation. Two
 * allocation-free passes (AABB, then exact radius about its centre) add no new
 * asymptotic cost and nothing per frame — the per-frame work is one
 * `BoundingSphere.transform` at the command site.
 *
 * # What is deliberately NOT included
 *
 * The Gaussian FOOTPRINT (each splat's covariance) is not added to the radius.
 * The command is not `cull`-gated — `Scene.isVisible` returns true immediately
 * for `!command.cull` (`Scene.js:3746`) — so this volume can never clip a splat
 * out of the frame; it feeds slice binning, the scene near/far accumulators and
 * the back-to-front sort key, all of which work in kilometres-to-megametres
 * while a splat's footprint is metres. Adding it would mean decoding f16
 * covariance for the packed layout to move a slice boundary that cannot move.
 *
 * @param view - the resident attribute bytes (legacy 16-f32 or packed 8-u32).
 * @param count - splat count.
 * @param packed - true for the WASM `SPLAT_PACKED_WASM` record layout.
 * @returns the model-space sphere, or null when there is nothing to bound.
 */
function computeLocalSplatBoundingSphere(
  view: ArrayBufferView,
  count: number,
  packed: boolean,
): BoundingSphere | null {
  if (count <= 0) {
    return null;
  }
  // Both layouts are read as f32 over the SAME bytes: the packed record stores
  // position as three u32 words that the WGSL `bitcast<f32>`s, and reading them
  // through a Float32Array is that same reinterpretation, bit-exact.
  const stride = packed
    ? PACKED_SPLAT_RECORD_WORDS
    : LEGACY_SPLAT_RECORD_FLOATS;
  const needed = count * stride;
  if (view.byteOffset % 4 !== 0 || view.byteLength < needed * 4) {
    return null;
  }
  const f32 = new Float32Array(view.buffer, view.byteOffset, needed);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    // RTE: the legacy record splits the model-space position into high + low
    // words (the packed WASM record has no low word — the f32 IS the data's
    // precision ceiling, see `loadSplat`). Recombining here mirrors the vertex
    // shader exactly; the sum is model-space and metre-scale by construction.
    const x = packed ? f32[base] : f32[base] + f32[base + 3];
    const y = packed ? f32[base + 1] : f32[base + 1] + f32[base + 4];
    const z = packed ? f32[base + 2] : f32[base + 2] + f32[base + 5];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      // A NaN centre would poison the sphere and, through it, the scene near/far
      // accumulators — every other command's slice assignment with it. Skip the
      // record; a cloud that is ENTIRELY non-finite falls through to null below.
      continue;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  // Exact radius about the AABB centre rather than half the diagonal: the
  // diagonal over-bounds a flat or linear cloud (common for a single tile) by
  // up to sqrt(3), which would widen the scene far plane for everyone.
  let radiusSquared = 0.0;
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const x = (packed ? f32[base] : f32[base] + f32[base + 3]) - cx;
    const y = (packed ? f32[base + 1] : f32[base + 1] + f32[base + 4]) - cy;
    const z = (packed ? f32[base + 2] : f32[base + 2] + f32[base + 5]) - cz;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    const d = x * x + y * y + z * z;
    if (d > radiusSquared) {
      radiusSquared = d;
    }
  }
  return new BoundingSphere(
    new Cartesian3(cx, cy, cz),
    Math.sqrt(radiusSquared),
  );
}

/**
 * `C15-G4` — consume the asynchronous WASM radix sort, and make the swap
 * atomic at the buffer-upload boundary.
 *
 * `GaussianSplatPrimitive` schedules `GaussianSplatSorter.radixSortIndexes` on
 * a task-processor worker for BOTH backends since `C15-G2`, and publishes the
 * resolved permutation to `_indexes` with a `(sequence, dataGeneration)` stamp.
 * The WebGPU draw indexes through `sortedIndices[instance_index]`, so consuming
 * it is a single buffer write — which is exactly what makes the swap atomic:
 * `writeBuffer` snapshots the source at call time, so the frame either draws
 * the whole old permutation or the whole new one. There is no window in which
 * half the splats are ordered for one camera and half for another.
 *
 * The two failure modes this guards, in order of how they'd actually be hit:
 *
 *   * **Torn order** — impossible by construction (one write, whole array), and
 *     the length check refuses a permutation that does not describe the buffer.
 *   * **Regression** — a resolution for camera A arriving after one for camera
 *     B. The producer's `isActiveSort` already refuses those, but this consumer
 *     reads `_indexes` off an *arbitrary* object (the synthetic probes prove
 *     that surface is real), so it re-derives the ordering itself from the
 *     stamp rather than trusting a scheduler in another module. A refused
 *     resolution leaves the previous permutation resident and STILL returns
 *     `true`: stale-but-consistent beats falling back to a synchronous sort.
 *
 * An unstamped producer (no `_indexesSortSequence`) keeps the historical
 * identity-only behaviour, so the legacy synthetic path is unchanged.
 *
 * @returns {boolean} `true` when a provided permutation is resident, so the
 *   comparator fallback must not run.
 * @private
 */
function uploadProvidedSortOrder(
  device: GPUDevice,
  primitive: CesiumObjectWithWebGPUCache,
  cache: GaussianSplatCache,
): boolean {
  const fields = primitive as unknown as {
    _indexes?: Uint32Array;
    _indexesSortSequence?: number;
    _indexesDataGeneration?: number;
  };
  const indexes = fields._indexes;
  const count = cache.splatCount;
  // Not resolved yet, or resolved against a different splat count — either way
  // there is nothing that legitimately describes the resident buffer, so no
  // write happens. This ordering is load-bearing: the upload must never precede
  // the resolution check.
  if (
    !indexes ||
    count === 0 ||
    !cache.sortedIndexBuffer ||
    indexes.length !== count
  ) {
    return false;
  }
  if (cache.providedIndexSource === indexes) {
    return true;
  }
  const sequence = fields._indexesSortSequence;
  const generation = fields._indexesDataGeneration;
  if (typeof sequence === "number" && typeof generation === "number") {
    if (
      generation < cache.providedIndexGeneration ||
      (generation === cache.providedIndexGeneration &&
        sequence <= cache.providedIndexSequence)
    ) {
      cache.supersededSortUploads++;
      return true;
    }
  }
  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indexes);
  // Bookkeeping AFTER the write: if the write throws, the cache must keep
  // describing what is actually on the GPU, not what we intended to put there.
  cache.providedIndexSource = indexes;
  if (typeof sequence === "number" && typeof generation === "number") {
    cache.providedIndexSequence = sequence;
    cache.providedIndexGeneration = generation;
  }
  cache.providedSortUploads++;
  // The comparator's throttle state is meaningless once the worker owns the
  // order; clear it so a later fall-back to the legacy layout re-sorts.
  cache.lastSortCameraDir = null;
  cache.sortRequestPending = false;
  return true;
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
      // C15-G5 — SH slots. Default to "no view-dependent colour", so a cache
      // that never sees SH data compiles the //>>else variant.
      shBuffer: null,
      shSourceToken: null,
      shDegree: 0,
      shEnabled: false,
      resourcesShEnabled: false,
      // C15-G3 — layout state. Defaults to the legacy record so a cache that
      // never sees data keeps the historical shape.
      layoutPacked: false,
      resourcesLayoutPacked: false,
      splatRecordBytes: LEGACY_SPLAT_RECORD_BYTES,
      splatSourceToken: null,
      providedIndexSource: null,
      // C15-G4 — nothing but the identity seed is resident, so every stamped
      // permutation outranks it.
      providedIndexSequence: -1,
      providedIndexGeneration: -1,
      comparatorSorts: 0,
      providedSortUploads: 0,
      supersededSortUploads: 0,
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
      // NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — populated with the pipeline
      // resources; null until they exist, which is also before any command
      // does, so the fallback can never see a half-published pair.
      oitFallbackShaderCode: null,
      oitFallbackConfig: null,
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
      // C15-G6h - derived command bounds; filled by the attribute commit.
      localBoundingSphere: null,
      worldBoundingSphere: null,
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
  // C15-G3 — resolve the attribute source BEFORE the invalidation sweep: the
  // record layout is a shader-module axis, so a primitive that switches
  // producers (or a cache built while no data existed) must recompile from the
  // other `SPLAT_PACKED_WASM` variant, exactly like a LOG_DEPTH flip. Without
  // this the first pipeline built (legacy, from the placeholder buffer) would
  // be served for packed data and decode at the wrong stride.
  const source = resolveSplatSource(primitive);
  // When no source is offered this frame, the RESIDENT layout is authoritative
  // — rebuilding the pipelines for the default layout while packed bytes are
  // still bound would decode at the wrong stride.
  const activeLayoutPacked =
    source.view !== null ? source.packed : cache.layoutPacked;
  const layoutFlipped =
    cache.initialized && cache.resourcesLayoutPacked !== activeLayoutPacked;
  // C15-G5 — the SH axis is resolved on the SAME "is this primitive offering
  // data" question as the layout axis, so the two can never describe different
  // snapshots. When nothing is offered this frame the resident state stays
  // authoritative (rebuilding to the non-SH variant while SH bytes are still
  // bound would drop the view-dependent term for a frame and then restore it).
  const shSource = resolveSplatShSource(primitive, source.count);
  const activeShEnabled =
    source.view !== null ? shSource.enabled : cache.shEnabled;
  const shFlipped =
    cache.initialized && cache.resourcesShEnabled !== activeShEnabled;
  if (
    cache.initialized &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      logDepthFlipped ||
      layoutFlipped ||
      shFlipped)
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
    // C15-G5 — UBO grows 320 → 384 bytes for the spherical-harmonics tail:
    // `shViewRotation: mat3x3<f32>` at byte 320 (three 16-byte-strided
    // columns, floats 80-91) and `shDegree: f32` at byte 368 (float 92).
    // mat3x3 has 16-byte alignment, so 320 is a legal offset and no padding is
    // needed before it; floats 93-95 are the struct's trailing pad.
    cache.uniformBuffer = device.createBuffer({
      size: 384,
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
    // C15-G5 — the SH binding is unconditional, so a primitive with no SH data
    // still needs a real buffer here for the shared bind group to be valid.
    cache.shBuffer = device.createBuffer({
      label: "GaussianSplat SH coefficients (placeholder)",
      size: 16,
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
      // C15-G3 — the attribute-record layout axis.
      activeLayoutPacked,
      // C15-G5 — the view-dependent-colour axis.
      activeShEnabled,
    );
    (
      cache as GaussianSplatCache & {
        _pipelineResources?: SplatPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;
    cache.pipelineLayout = resources.layout;
    // NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — publish both halves together,
    // from the same resource build that produced the bind-group layout the
    // command's bind groups are created against.
    cache.oitFallbackShaderCode = resources.oitFallbackShaderCode;
    cache.oitFallbackConfig = resources.oitFallbackConfig;
    cache.logDepthEnabled = logDepthActive;
    cache.pickLogDepthEnabled = pickLogActive;
    // C15-G3 — record which record layout these pipelines decode, so the flip
    // check above compares like with like. C15-G5 — same for the SH axis.
    cache.resourcesLayoutPacked = activeLayoutPacked;
    cache.resourcesShEnabled = activeShEnabled;
    // Bind group references the freshly-built BGL + current buffers.
    cache.bindGroup = null;
  }

  // (Re)build the group-0 bind group whenever it's missing (init, format/
  // log-depth flip, or a storage-buffer reallocation cleared it).
  // ── C15-G3 — commit the attribute bytes.
  //
  // The dirty signal is (count, layout, producer identity), not the count
  // alone: a snapshot rebuild that lands on the SAME splat count produces a
  // fresh payload object and nothing else changes, and re-uploading only on a
  // count change would leave the previous cloud resident forever.
  //
  // C15-G3b — this block sits ABOVE the pipeline gate deliberately. Uploading
  // the attribute bytes needs the DEVICE, not a pipeline, and
  // `tryResolveSplatPipelines` legitimately returns early for however long a
  // cold variant takes to compile (~2.7 s measured on this fork). With the
  // commit below that gate, `cache.splatCount` stayed 0 for the whole compile
  // even though the data had been ready since the shared pipeline committed it
  // — which is exactly what the Batch-881 Edge run measured (`splatCount=0`
  // sampled during readiness, 27 by the time the scored frame drew). Hoisting
  // it makes the count mean "the data is resident", not "the data is resident
  // AND a pipeline happened to finish compiling", and it starts the upload one
  // compile earlier. The command build still waits on the pipeline below.
  const splatData = source.view;
  const revision = source.count;
  if (
    splatData &&
    (revision !== cache.lastRevision ||
      cache.layoutPacked !== source.packed ||
      cache.splatSourceToken !== source.token)
  ) {
    if (cache.splatBuffer) {
      cache.splatBuffer.destroy();
    }
    // NEW-SPLAT-SORT-CONSUME-INDEXES (Batch 288) — splat attributes now live
    // in a read-only STORAGE buffer the VS reads via sortedIndices. COPY_SRC
    // for the velocity prev-seed self-copy.
    cache.splatBuffer = device.createBuffer({
      label: `GaussianSplat splats [packed=${source.packed ? 1 : 0}]`,
      size: splatData.byteLength || 64,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    if (splatData.byteLength > 0) {
      // Frame-owned upload: `device.queue.writeBuffer` is the queue-ordered
      // write every renderer on this fork uses for CPU→GPU attribute data. No
      // private encoder, no private submit — the only `queue.submit` in this
      // file is the velocity prev-seed self-copy, which predates this row.
      device.queue.writeBuffer(cache.splatBuffer, 0, splatData);
    }
    cache.splatCount = revision;
    cache.lastRevision = revision;
    cache.layoutPacked = source.packed;
    cache.splatRecordBytes = source.packed
      ? PACKED_SPLAT_RECORD_BYTES
      : LEGACY_SPLAT_RECORD_BYTES;
    cache.splatSourceToken = source.token;
    // C15-G6h — recompute the model-space bounds alongside the bytes they
    // describe. This is the ONLY call site: bounds and buffer contents change
    // together by construction, so they can never disagree.
    cache.localBoundingSphere = computeLocalSplatBoundingSphere(
      splatData,
      revision,
      source.packed,
    );
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
      // The identity seed just overwrote whatever permutation was resident, so
      // the provided-order upload must re-run even for the same `_indexes`.
      cache.providedIndexSource = null;
      // C15-G4 — and the sequence guard must not veto that re-upload. The guard
      // protects a RESIDENT order from being regressed; after the identity seed
      // there is no resident order to protect, so the provenance resets with it.
      cache.providedIndexSequence = -1;
      cache.providedIndexGeneration = -1;
    }
    // The splat + sorted-index storage buffers were reallocated, so the
    // bind group must be rebuilt against the new buffers.
    cache.bindGroup = null;
    cache.pickCommand = null;
  } else if (!splatData && cache.splatCount > 0 && cache.layoutPacked) {
    // C15-G3 lifecycle — the production producer withdrew its payload (tileset
    // unload, `_dirty` snapshot teardown, or `GaussianSplatPrimitive.destroy`,
    // all of which clear `_packedSplatTextureData` / `_numSplats`). Retire the
    // draw rather than keep rasterizing a cloud whose source is gone. The GPU
    // buffers stay allocated for the next commit; `destroy` releases them.
    cache.splatCount = 0;
    cache.lastRevision = -1;
    cache.splatSourceToken = null;
    cache.providedIndexSource = null;
    cache.providedIndexSequence = -1;
    cache.providedIndexGeneration = -1;
    cache.splatData = null;
    cache.prevSplatData = null;
    cache.command = null;
    cache.pickCommand = null;
    // C15-G5 — the SH coefficients described the withdrawn cloud; retire them
    // with it so a later commit cannot be drawn against a stale palette.
    cache.shSourceToken = null;
    cache.shDegree = 0;
    cache.shEnabled = false;
  }

  // ── C15-G5 — commit the SH coefficients.
  //
  // Same dirty signal as the attribute commit (producer identity + degree +
  // count), same reason: a snapshot rebuild that lands on the same count and
  // degree still publishes a fresh `_shData` view over a REUSED scratch buffer.
  // Sits beside the attribute commit and ABOVE the pipeline gate for the
  // Batch-881 reason — the upload needs the device, not a pipeline.
  if (
    shSource.view &&
    (cache.shSourceToken !== shSource.token ||
      cache.shDegree !== shSource.degree ||
      !cache.shEnabled ||
      // Size is read back off the GPU object rather than tracked in a parallel
      // count field, so the guard cannot drift from what is actually resident.
      cache.shBuffer === null ||
      cache.shBuffer.size !== (shSource.view.byteLength || 16))
  ) {
    if (cache.shBuffer) {
      cache.shBuffer.destroy();
    }
    cache.shBuffer = device.createBuffer({
      label: `GaussianSplat SH coefficients [degree=${shSource.degree}]`,
      size: shSource.view.byteLength || 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.shBuffer, 0, shSource.view);
    cache.shSourceToken = shSource.token;
    cache.shDegree = shSource.degree;
    cache.shEnabled = true;
    // The binding changed identity, so the shared bind group must rebuild.
    cache.bindGroup = null;
    cache.command = null;
    cache.pickCommand = null;
  } else if (!shSource.view && cache.shEnabled && source.view !== null) {
    // The primitive still offers attribute bytes but no longer offers SH (a
    // degree-0 fallback, or a re-commit at degree 0). Drop the term rather than
    // keep evaluating a retired palette; the placeholder-sized buffer stays
    // bound so the shared layout remains valid.
    cache.shSourceToken = null;
    cache.shDegree = 0;
    cache.shEnabled = false;
    cache.command = null;
    cache.pickCommand = null;
  }

  if (!cache.bindGroup) {
    cache.bindGroup = device.createBindGroup({
      layout: resources.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer! } },
        { binding: 1, resource: { buffer: cache.splatBuffer! } },
        { binding: 2, resource: { buffer: cache.sortedIndexBuffer! } },
        { binding: 3, resource: { buffer: cache.prevSplatBuffer! } },
        // C15-G5 — always bound (placeholder when the content has no SH).
        { binding: 4, resource: { buffer: cache.shBuffer! } },
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
        // C15-G5 — always bound (placeholder when the content has no SH).
        { binding: 4, resource: { buffer: cache.shBuffer! } },
      ],
    });
    cache.command = null;
    cache.pickCommand = null;
  }

  // C15-G4 — the sort chain, in priority order. The asynchronous WASM radix
  // sort the shared pipeline runs on a worker owns the production order; its
  // resolved permutation is swapped in atomically at the buffer-upload
  // boundary. Only when NO provided permutation describes the resident buffer
  // does the legacy synchronous comparator get a chance, and it in turn refuses
  // the packed layout — so on production content neither branch ever runs a
  // main-thread sort (`cache.comparatorSorts` is the measurement, not the
  // claim). `uploadProvidedSortOrder` returning `true` after REFUSING a
  // superseded resolution is deliberate: keeping the previous order is correct,
  // falling back to a synchronous sort is not.
  if (!uploadProvidedSortOrder(device, primitive, cache)) {
    maybeSortSplats(device, primitive, frameState, cache);
  }

  // Pack uniforms.
  //
  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth and breaking
  // depth testing at planetary scale.
  const us = context.uniformState;
  // C15-G3 — `_rootTransform` for production content (the ENU frame the splat
  // positions are expressed in, which is what the WebGL DrawCommand uses);
  // `modelMatrix` for the synthetic probes. See `splatModelMatrix`.
  const mm = splatModelMatrix(primitive);
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
  //>>includeStart('debug', pragmas.debug);
  // C15-G6g — publish WHAT THIS PRODUCER ACTUALLY BAKED, at the moment it
  // baked it. The whole family has been argued from the fields each producer
  // READS (verified identical in source at `C15-G3d`) and from a post-render
  // sample of `uniformState` (which is the LAST FRUSTUM SLICE, not what anyone
  // packed). Neither is the quantity that decides the depth compare. This is.
  recordLogDepthEncoder(us, "splat", ldNear, ldFar, ldFactor);
  //>>includeEnd('debug');

  // Viewport + focal length derived from the perspective projection matrix.
  // For a standard perspective: P[0][0] = 1/(aspect*tan(fov/2)),
  // P[1][1] = 1/tan(fov/2).
  //
  // C15-G3b — this is WebGL's focal convention, NOT the half-viewport pixel
  // focal packed before it:
  //   GLSL: vec2 focal = vec2(czm_projection[0][0] * czm_viewport.z,
  //                           czm_projection[1][1] * czm_viewport.w);
  // i.e. the FULL viewport dimension. The factor of 2 is not cosmetic. The
  // projected covariance scales as focal^2, so at half focal it came out 4x
  // small — while the `+ 0.3` dilation and the 1024-pixel axis clamp in
  // `projectSplatCovariance`/`splatQuadAxes` are ABSOLUTE constants ported
  // from the GLSL. A 4x-small covariance against an unchanged dilation
  // inflates every small splat. The compensating halving lives in the quad
  // expansion, which now divides by the viewport WITHOUT the historical
  // `* 2.0` — exactly as the GLSL does.
  const vpData = new Float32Array(4);
  const viewportW =
    context.drawingBufferWidth || context._canvas?.width || 1920;
  const viewportH =
    context.drawingBufferHeight || context._canvas?.height || 1080;
  const proj = m4Values(us.projection);
  vpData[0] = viewportW;
  vpData[1] = viewportH;
  vpData[2] = proj[0] * viewportW; // focal X (czm_projection[0][0] * czm_viewport.z)
  vpData[3] = proj[5] * viewportH; // focal Y (czm_projection[1][1] * czm_viewport.w)
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

  // C15-G5 — spherical-harmonics tail at byte offset 320 (float 80).
  //
  // The GLSL evaluates SH against
  //   normalize(u_inverseModelRotation * (splatWC - cameraWC))
  // where `u_inverseModelRotation` is the rotation of
  //   inverse(tile.computedTransform × axisCorrection × content.worldTransform)
  // — the SH training frame — cached by the primitive as `_shInverseRotation`
  // on every snapshot rebuild (GaussianSplatPrimitive.js:1536-1552).
  //
  // The WGSL has no world-space splat position; it has `posRTE`, the
  // camera->splat vector in the primitive's MODEL frame. For a model matrix
  // M = [A | t] and a camera encoded in model space (c_model = M^-1 c_world),
  //   A * posRTE = A*p - A*M^-1*c_world = (A*p + t) - c_world = splatWC - c_world
  // EXACTLY, for any invertible A — the translation cancels in the difference.
  // So folding the two rotations CPU-side into one mat3 reproduces the GLSL's
  // argument with no extra shader work and no world-space round trip.
  const shRotationData = new Float32Array(16);
  const shInverseRotation = (
    primitive as unknown as { _shInverseRotation?: Matrix3 }
  )._shInverseRotation;
  if (cache.shEnabled && shInverseRotation) {
    Matrix4.getMatrix3(mm, scratchModelRotation);
    Matrix3.multiply(
      shInverseRotation,
      scratchModelRotation,
      scratchShRotation,
    );
  } else {
    Matrix3.clone(Matrix3.IDENTITY, scratchShRotation);
  }
  // mat3x3<f32> columns are 16-byte strided; Matrix3 is column-major, so
  // column j is elements [3j, 3j+1, 3j+2] and lands at floats 4j..4j+2.
  // Matrix3 is index-addressable at runtime; the ambient class type does not
  // declare an index signature, so view it as ArrayLike for the strided copy.
  const shRotationElements = scratchShRotation as unknown as ArrayLike<number>;
  for (let column = 0; column < 3; column++) {
    shRotationData[column * 4] = shRotationElements[column * 3];
    shRotationData[column * 4 + 1] = shRotationElements[column * 3 + 1];
    shRotationData[column * 4 + 2] = shRotationElements[column * 3 + 2];
    shRotationData[column * 4 + 3] = 0.0;
  }
  // float 92 (byte 368) — the twin of GLSL's `u_sphericalHarmonicsDegree`.
  // Zero whenever the SH variant is not compiled, so a stale non-zero degree
  // can never survive a flip back to the base-colour shader.
  shRotationData[12] = cache.shEnabled ? cache.shDegree : 0.0;
  device.queue.writeBuffer(cache.uniformBuffer!, 320, shRotationData);

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
  // grows as tiles stream in).
  //
  // C15-G6h — and "without them" was EVERY frame, for every exerciser of this
  // path. The pre-existing note here said a missing `boundingVolume` was
  // "null-safe … single-frustum binning is unaffected". The first half is true
  // and the second half was the defect: a BV-less command does not get
  // single-frustum binning, it gets the camera's WORST-CASE span
  // (`View.js:382-392`), which under log depth is `[0.1, 1e10]` — a 1e11 ratio
  // that splits into TWO slices and bins the command into BOTH, while the globe
  // bins into the near one only. Depth is cleared between slices and colour is
  // not, so the far-slice execution composites against a depth buffer with no
  // globe in it. Measured at Batch 888 with every producer's baked log-depth
  // pair EQUAL, which excluded the encode and left exactly this.
  //
  // So the bounding volume is now derived when no tileset offers one, and the
  // fallback order is deliberate:
  //   1. `_tileset.boundingSphere` — WebGL parity, and authoritative for real
  //      content because it covers the WHOLE tileset (including tiles not yet
  //      resident) rather than just the splats currently uploaded;
  //   2. the derived sphere over the resident centres, transformed to world
  //      space by the SAME matrix the command carries (C15-G3's lesson: the
  //      splat's model frame is `_rootTransform` for real content and
  //      `modelMatrix` for synthetic primitives — `splatModelMatrix` resolves
  //      both, and a bounding volume left in model space would bin against the
  //      camera as though the tileset sat at the geocentre);
  //   3. `undefined` — only reachable for a producer with neither a tileset nor
  //      decodable attribute bytes. That keeps the worst-case span, which is the
  //      honest answer when the extent is genuinely unknown: a command that
  //      might belong in any slice must not be clipped out of one.
  const parityFields = primitive as unknown as {
    _tileset?: { boundingSphere?: CesiumBoundingSphere };
    _rootTransform?: Matrix4;
  };
  const commandModelMatrix = parityFields._rootTransform ?? mm;
  let commandBoundingVolume = parityFields._tileset?.boundingSphere;
  if (!commandBoundingVolume && cache.localBoundingSphere) {
    // Transform into a persistent scratch: the model matrix can change every
    // frame while the data does not, so this is the only per-frame cost and it
    // is O(1). The command holds a reference to this same object, which the
    // PVS walk reads synchronously in the same frame.
    cache.worldBoundingSphere ??= new BoundingSphere();
    commandBoundingVolume = BoundingSphere.transform(
      cache.localBoundingSphere,
      commandModelMatrix,
      cache.worldBoundingSphere,
    ) as unknown as CesiumBoundingSphere;
  }

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
    // (`WebGPUSceneRendererTranslucentPass` builds an OIT pipeline from it when
    // `_oitPipeline` is absent).
    //
    // C15-G3 — PREPROCESSED, not raw. The raw template still carries the
    // `//>>ifdef` directives, which WGSL sees as comments: the consumer would
    // compile a source with BOTH branches of every block present (two
    // `fragmentMain` definitions) and, on the splat shader specifically, with
    // the wrong record stride for packed data.
    //
    // NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — both halves now come from the
    // pipeline resources rather than being re-derived here. Two defects the
    // re-derivation carried: (1) it rebuilt the define mask from
    // `cache.layoutPacked` alone, so after `C15-G5` it omitted
    // `SPLAT_SPHERICAL_HARMONICS` while the renderer's OWN OIT module included
    // it — a fallback pipeline would have composited the base colour while the
    // colour pass composited the view-dependent one; and (2) no
    // `_pipelineConfig` was published at all, so the fallback substituted
    // `layout: "auto"` and the command's explicit-layout bind groups would
    // have failed WebGPU validation. Publishing them as a pair from one build
    // is what keeps the shader axes and the layout from drifting apart again.
    cmd._shaderCode = cache.oitFallbackShaderCode ?? undefined;
    cmd._pipelineConfig = cache.oitFallbackConfig ?? undefined;
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

  // C15-G3 — stride comes from the resident layout (32 packed / 64 legacy),
  // not a literal. A 64 here against packed data would allocate (and self-copy)
  // twice the source size and blow past `splatBuffer`'s extent on the seed
  // `copyBufferToBuffer`.
  const requiredBytes = cache.splatCount * cache.splatRecordBytes;
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
          // C15-G5 — always bound (placeholder when the content has no SH).
          { binding: 4, resource: { buffer: cache.shBuffer! } },
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
      }/packed=${cache.layoutPacked ? 1 : 0}/sh=${cache.shEnabled ? 1 : 0}]`,
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
  // C15-G5 — release the SH coefficient storage buffer.
  cache.shBuffer?.destroy();

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
