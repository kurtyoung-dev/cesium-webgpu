/**
 * WebGPU Voxel Renderer
 *
 * Renders volumetric voxel data via ray marching through a 3D texture.
 * Renders a bounding box as a proxy geometry, then ray-marches through
 * the voxel volume in the fragment shader.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUVoxelRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Matrix3 from "../../Core/Matrix3.js";
import Cartesian3 from "../../Core/Cartesian3.js";
// PARITY-VOXEL-SHAPE-PARITY (increment 2) — shape/OBB scene-level transform
// helpers. Run BEFORE the backend branch (Scene Logic Extractor pattern) so the
// VoxelPrimitive's shape OBB is current on the WebGPU path (the WebGPU feature
// renderer returns from VoxelPrimitive.update BEFORE the WebGL body that
// normally refreshes it).
import {
  checkTransformAndBounds,
  updateShapeAndTransforms,
} from "../../Scene/VoxelPrimitiveHelpers.js";
// NEW-VOXEL-ELLIPSOID-INTERSECT / NEW-VOXEL-CYLINDER-SHAPEUV — shape-typed
// real-intersection selection (BOX keeps intersectAABB; ELLIPSOID takes the
// shell quadratics; CYLINDER the bounded-cylinder quadratic + height slab).
import VoxelShapeType from "../../Scene/VoxelShapeType.js";
// C-R9-VOXEL-CELL-PICK-TAIL — the root SpatialNode built for Scene.pickVoxel's
// VoxelCell construction (WebGPU path has no CPU VoxelTraversal).
import SpatialNode from "../../Scene/SpatialNode.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture as textureEntry,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  attachPickToColorCommand,
  attachPickVoxelToColorCommand,
  destroyPickIds,
  ensurePickId,
  type SinglePickIdCache,
} from "./WebGPUPickCommandHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
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
// PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1) — real root-tile data upload
// that replaces the placeholder gradient when a voxel provider is present.
import {
  createVoxelDataUploadState,
  tryUploadRootVoxelTile,
  tryUploadChildVoxelTiles,
  type VoxelDataUploadState,
} from "./WebGPUVoxelDataUpload.js";
// VOXEL-USER-CUSTOMSHADER — per-primitive WGSL codegen for a USER-supplied
// native-WGSL voxel CustomShader (the voxel sibling of the model path's
// CustomShaderWGSLPipelineStage). GLSL-only voxel customShaders keep the
// warn + default-gray behavior.
import {
  generateVoxelUserShaderChunk,
  voxelUserShaderHasUniforms,
  type VoxelProviderMetadataLike,
  type VoxelUserCustomShaderLike,
  type VoxelUserShaderInfo,
} from "./WebGPUVoxelCustomShaderCodegen.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";

// Per-device shader module cache so multiple VoxelPrimitives sharing the
// same GPUDevice reuse a single compiled `GPUShaderModule`.
// (C-R7-SHADER-MODULE-DEDUP, Batch 72.)
const _voxelShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getVoxelShaderModuleCache(device: GPUDevice): WebGPUShaderModuleCache {
  let cache = _voxelShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _voxelShaderModuleCaches.set(device, cache);
  }
  return cache;
}

interface VoxelCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  pickPipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  voxelTexture: GPUTexture | null;
  voxelTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  // C-R7-RENDERER-MIGRATION (Batch 72) — color + pick pipelines arrive
  // asynchronously from `WebGPURenderPipelineCache.getPipeline()`. Track
  // whether the request is in flight so we don't re-issue it every frame.
  pipelineRequestPending: boolean;
  colorDescriptor: WebGPURenderPipelineDescriptor | null;
  pickDescriptor: WebGPURenderPipelineDescriptor | null;

  // Batch 173 - B.10 NEW-ADVANCED-MOTION-VECTORS (Voxel). No prev VB
  // needed (cube geometry is static); only the modelMatrix in the UBO
  // suffices for screen-space velocity emission. Pipeline reuses the
  // color BGL + pipeline layout — same uniform binding, just a
  // different pair of entry points.
  velocityPipeline: GPURenderPipeline | null;
  velocityDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;

  // PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1) — one-time async state
  // machine that requests the ROOT voxel tile and uploads its real property
  // data into a 3D texture, replacing the placeholder gradient. Null until the
  // first frame; when `phase === 'done'` the bind group is rebuilt to point at
  // `dataUpload.view`. Stays untouched (placeholder retained) when no provider
  // is present — the off-gate byte-identical case.
  dataUpload: VoxelDataUploadState | null;
  // True once the bind group has been re-pointed at the uploaded real-data
  // texture, so we only rebuild it once.
  usingRealData: boolean;
  // Retained so the real-data bind group can be rebuilt (same layout, new
  // texture view at binding 1) once the root tile finishes uploading.
  bindGroupLayout: GPUBindGroupLayout | null;

  // PARITY-VOXEL-COLOR-PARITY — retained so the COLOR pipeline can be rebuilt
  // with the VOXEL_CUSTOM_SHADER_COLOR define once the real root tile uploads
  // (the placeholder path stays byte-identical at defines=0). The pipeline
  // layout is the same for the placeholder + real-data color module (same
  // BGLs), so we reuse it; only the fragment module source (preprocessed WGSL)
  // differs. `pipelineLayout` is captured at init; `colorModuleCustomShader`
  // is the lazily-built defines=VOXEL_CUSTOM_SHADER_COLOR module.
  pipelineLayout: GPUPipelineLayout | null;
  colorModuleCustomShader: GPUShaderModule | null;

  // VOXEL-USER-CUSTOMSHADER — user native-WGSL customShader slots. The
  // generated chunk is cached per customShader OBJECT identity (userShaderRef)
  // so the per-frame resolve is a pointer compare; swapping / clearing the
  // primitive's customShader mid-session invalidates it. `userShaderInfo` is
  // null for the default shader, GLSL-only shaders (warn + default), and
  // uniform-carrying WGSL shaders (warn + default — uniforms are a documented
  // follow-up).
  userShaderRef: unknown;
  userShaderInfo: VoxelUserShaderInfo | null;

  // C-R9-VOXEL-CELL-PICK — dedicated per-cell pick pipeline + command for
  // the `passes.pickVoxel` pass. SEPARATE from `pickPipeline`/`pickCommand`
  // (the object-pick path emitting u.pickColor) so regular `scene.pick`
  // stays byte-identical. The pipeline is only resolved on the real-data
  // path (`usingRealData`) — the placeholder path has no cell convention to
  // decode and must not allocate GPU resources for it.
  pickVoxelPipeline: GPURenderPipeline | null;
  pickVoxelDescriptor: WebGPURenderPipelineDescriptor | null;
  pickVoxelPipelineRequestPending: boolean;
  pickVoxelCommand: CesiumAnyDrawCommand | null;
}

const VOXEL_WGSL = `
struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  minBounds: vec3<f32>,
  stepSize: f32,
  maxBounds: vec3<f32>,
  maxSteps: f32,
  cameraPositionEC: vec3<f32>,
  densityThreshold: f32,
  // C-R9-VOXEL-PICK (Batch 53) — pick color output for the pick FBO.
  // Always written by JS-side packing but only consumed by the
  // fragmentPickMain entry point.
  pickColor: vec4<f32>,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Layout-only invariant today; consumed by future per-cell
  // motion-vector pass for animated voxel volumes.
  prevViewProjection: mat4x4<f32>,
  // Batch 173 — full model matrix (no translation zeroing) so the
  // velocity VS can lift model-space cube vertices to world space
  // before applying prevViewProjection. UBO grows 224 → 288 bytes.
  modelMatrix: mat4x4<f32>,
  // PARITY-VOXEL-COLOR-PARITY — sun light direction transformed into the box's
  // MODEL/local frame (floats 72..74) + a lighting-enabled flag (float 75).
  // The default voxel customShader (VoxelPrimitive.DefaultCustomShader) shades
  // each voxel gray by \`0.5 + 0.5 * max(0, dot(voxelNormalEC, lightDirEC))\`;
  // because the entry-face normal is axis-aligned in the box-local frame and
  // \`dot(czm_normal * nLocal, lightEC) == dot(nLocal, czm_normal^T * lightEC)\`,
  // passing the light direction pre-transformed into model space lets the WGSL
  // do the same dot without a full normal matrix. Zero when the parity path is
  // inactive (only written when the color pipeline carries the define), so the
  // off-gate placeholder never reads meaningful data here.
  lightDirectionModel: vec3<f32>,
  voxelLightingEnabled: f32,
  // VOXEL-SHAPEUV-CONVENTION — WebGL sample-frame plumbing (floats 76..103).
  // \`proxyToShapeUv\` is the CPU-composed affine chain
  //   scale/translate(convertLocalToShapeUvSpace) · inverse(shapeTransform) · effModel
  // mapping a proxy-cube point p ∈ [-0.5, +0.5]^3 to the shape's UV space —
  // the SAME world→shapeUv convention WebGL's convertLocalToBoxUv.glsl /
  // VoxelBoxShape.convertLocalToShapeUvSpace encode. \`voxelDimensions\` /
  // \`paddingBefore\` / \`inputDimensions\` mirror u_dimensions / u_paddingBefore
  // / u_inputDimensions from Octree.glsl; \`metadataYUpBox\` gates the
  // Y_UP_METADATA_ORDER + SHAPE_BOX input-axis swap/flip. Only written when
  // the real-data color-parity pipeline is active; zero on the placeholder
  // path (which never reads these fields — off-gate byte-identical).
  voxelDimensions: vec3<f32>,
  metadataYUpBox: f32,
  proxyToShapeUv: mat4x4<f32>,
  inputDimensions: vec3<f32>,
  _pad2: f32,
  paddingBefore: vec3<f32>,
  _pad3: f32,
  // VOXEL-SHAPEUV-CONVENTION — the REAL camera position in the proxy cube's
  // model space (the same value the RTE encodedCamera high/low encode). The
  // parity march needs a physically-correct ray origin: the historical path
  // intersects a camera-CENTERED phantom box (worldPos is camera-relative and
  // cameraPositionEC is zero), which fills the right screen footprint but
  // samples the volume around the camera. Consumed ONLY by the
  // VOXEL_CUSTOM_SHADER_COLOR branch; zero on the placeholder/pick paths.
  cameraPositionProxy: vec3<f32>,
  _pad4: f32,
  // VOXEL-OCTREE-LOD — octree traversal (floats 108..119).
  // \`childSlots0/1\`: atlas slot per level-1 child octant (Z-up shape frame,
  // childIndex = x + 2y + 4z — Octree.glsl's getOctreeChildData order), or -1
  // when that child tile is not uploaded, in which case the march samples the
  // deepest uploaded ancestor for the octant — Octree.glsl's
  // OCTREE_FLAG_PACKED_LEAF_FROM_PARENT fallback. \`atlasInfo.x\` = tile slot
  // count stacked along the texture's Z axis (1 = single-tile texture,
  // historical layout; 9 = depth-1 atlas; 73 = depth-2 atlas; 585 = depth-3
  // atlas, NEW-VOXEL-OCTREE-DEEP-LEVELS);
  // \`atlasInfo.y\` = this frame's target LOD level (0 = root, 1..3 = refine)
  // from the CPU-evaluated SpatialNode.computeScreenSpaceError refine ladder.
  // All zero on the placeholder path (max(atlasInfo.x, 1.0) keeps the math
  // byte-identical there).
  childSlots0: vec4<f32>,
  childSlots1: vec4<f32>,
  atlasInfo: vec4<f32>,
  // NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — atlas slot per level-2 tile (floats
  // 120..183): linear index x + 4y + 16z over the 4x4x4 level-2 tile grid
  // (the radix-2 extension of the level-1 octant order), or -1 when that tile
  // is not uploaded. Only consulted when the iterative walk descends to
  // level 2 (target level >= 2 requires an uploaded level-2 tile CPU-side);
  // all -1 / zero on the shallower paths.
  l2Slots: array<vec4<f32>, 16>,
  // NEW-VOXEL-ELLIPSOID-INTERSECT — shape-typed intersection fields (floats
  // 184..207). \`proxyToLocal\` maps a proxy-cube point p ∈ [-0.5, +0.5]^3 into
  // the shape's ellipsoid-centered LOCAL frame in meters (the frame WebGL's
  // IntersectEllipsoid.glsl evaluates in — inverse(shapeTransform) · effModel);
  // \`ellipsoidRadii\` is the ellipsoid's per-axis radii (the compound
  // modelMatrix scale) and \`shapeHeightMinMax\` the min/max height bounds
  // relative to the surface. \`shapeType\` selects the REAL-intersection branch:
  // 0 = BOX (intersectAABB, the historical bit-identical path — also the
  // placeholder/degenerate fallback since the fields default to zero),
  // 1 = ELLIPSOID (outer/inner shell quadratics). Only written on the
  // real-data path for ELLIPSOID-shape providers.
  proxyToLocal: mat4x4<f32>,
  ellipsoidRadii: vec3<f32>,
  shapeType: f32,
  shapeHeightMinMax: vec2<f32>,
  _pad5: vec2<f32>,
  // NEW-VOXEL-ELLIPSOID-SHAPEUV — ellipsoid shapeUv mapping terms (floats
  // 208..215), mirroring VoxelEllipsoidShape's shader uniforms: \`...UvScale\`
  // is u_ellipsoidLocalToShapeUvScale (x = longitude scale, y = latitude
  // scale, z = height scale = 1/(maxHeight - minHeight)); \`...RangeOrigin\`
  // is u_ellipsoidShapeUvLongitudeRangeOrigin; \`...UvTranslate\` carries the
  // JS-side localToShapeUvTranslate lon/lat offsets; \`...HasShapeBounds\`
  // packs the ELLIPSOID_HAS_SHAPE_BOUNDS_LONGITUDE / _LATITUDE defines as
  // flags. Only written for ELLIPSOID-shape providers (the BOX/placeholder
  // paths never read them).
  ellipsoidLocalToShapeUvScale: vec3<f32>,
  ellipsoidShapeUvLongitudeRangeOrigin: f32,
  ellipsoidLocalToShapeUvTranslate: vec2<f32>,
  ellipsoidHasShapeBounds: vec2<f32>,
  // NEW-VOXEL-CYLINDER-SHAPEUV — cylinder shape terms (floats 216..227),
  // mirroring VoxelCylinderShape's shader uniforms. shapeType 2 = CYLINDER;
  // it reuses \`proxyToLocal\` (proxy → the shape's cylinder-centered LOCAL
  // frame) and \`shapeHeightMinMax\` (local z bounds — the renderBoundPlanes
  // distances) from the ellipsoid block. \`...RadiusMinMax\` is
  // u_cylinderRenderRadiusMinMax (x = inner radius → the march's hole
  // interval, y = outer radius); \`...AngleRangeOrigin\` is
  // u_cylinderShapeUvAngleRangeOrigin; \`...UvScale\`/\`...UvTranslate\` carry
  // the radial/angle/height scale + offset terms of
  // VoxelCylinderShape.convertLocalToShapeUvSpace. Only written for
  // CYLINDER-shape providers (the BOX/ELLIPSOID/placeholder paths never
  // read them).
  cylinderRenderRadiusMinMax: vec2<f32>,
  cylinderShapeUvAngleRangeOrigin: f32,
  _pad6: f32,
  cylinderLocalToShapeUvScale: vec3<f32>,
  _pad7: f32,
  cylinderLocalToShapeUvTranslate: vec3<f32>,
  _pad8: f32,
  // NEW-VOXEL-OCTREE-DEEP-LEVELS — atlas slot per level-3 tile (floats
  // 228..739): linear index x + 8y + 64z over the 8x8x8 level-3 tile grid
  // (the radix-2 extension of the level-2 order), or -1 when that tile is not
  // uploaded. Only consulted when the iterative walk descends to level 3
  // (target level >= 3 requires an uploaded level-3 tile CPU-side); all -1 /
  // zero on the shallower paths (585-slot static atlas only).
  l3Slots: array<vec4<f32>, 128>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var voxelTex: texture_3d<f32>;
@group(0) @binding(2) var voxelSamp: sampler;

// FEAT-GAP-09 (Batch 103 audit fix; original Batch 100 modified the
// dead standalone Advanced/VoxelPrimitive.wgsl which is never imported
// at runtime — this inline VOXEL_WGSL is the actual shader source).
// Truncated EffectsUniforms (480-byte UBO, truncated to reach
// \`atmosphereLutControl\` at byte offset 240 — see WebGPUEffectsBindGroup.js)
// + aerial-perspective LUT bindings at @group(1).
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
  output.position = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.worldPos = posRTE;
  return output;
}

fn intersectAABB(origin: vec3<f32>, invDir: vec3<f32>,
                 bMin: vec3<f32>, bMax: vec3<f32>) -> vec2<f32> {
  let t1 = (bMin - origin) * invDir;
  let t2 = (bMax - origin) * invDir;
  let tMin = min(t1, t2);
  let tMax = max(t1, t2);
  return vec2<f32>(max(max(tMin.x, tMin.y), tMin.z),
                   min(min(tMax.x, tMax.y), tMax.z));
}

// NEW-VOXEL-ELLIPSOID-INTERSECT — ray vs the ellipsoid-at-height surface,
// evaluated in the shape's ellipsoid-centered LOCAL frame (meters). Mirrors
// WebGL Shaders/Voxels/IntersectEllipsoid.glsl intersectHeight(): scale the
// ray by 1/(radii + height) so the surface becomes the unit sphere, then
// solve the quadratic with the cancellation-avoiding second root
// (t2 = c / (a * t1)) exactly as the GLSL does. \`dirLocal\` is intentionally
// NOT normalized — the returned t values stay in the caller's (proxy-space)
// ray parameterization, so they compose directly with the march's
// \`rayOrigin + rayDir * t\`. Returns (tMin, tMax); (+BIG, -BIG) on a miss so
// the shared \`enter > exit\` rejection test handles it.
fn intersectEllipsoidHeight(originLocal: vec3<f32>, dirLocal: vec3<f32>,
                            height: f32) -> vec2<f32> {
  let miss = vec2<f32>(3.402823e+38, -3.402823e+38);
  let radiiCorrection = vec3<f32>(1.0) / (u.ellipsoidRadii + vec3<f32>(height));
  let position = originLocal * radiiCorrection;
  let direction = dirLocal * radiiCorrection;
  let a = dot(direction, direction);
  let b = dot(direction, position);
  let c = dot(position, position) - 1.0;
  let determinant = b * b - a * c;
  if (determinant < 0.0 || a <= 0.0) {
    return miss;
  }
  let det = sqrt(determinant);
  let signB = select(1.0, -1.0, b < 0.0);
  let t1 = (-b - signB * det) / a;
  let t2 = c / (a * t1);
  return vec2<f32>(min(t1, t2), max(t1, t2));
}

// NEW-VOXEL-CYLINDER-SHAPEUV — ray vs the infinite cylinder x² + y² = r²
// about the local z-axis, evaluated in the shape's cylinder-centered LOCAL
// frame. Mirrors WebGL Shaders/Voxels/IntersectCylinder.glsl
// intersectCylinder(): quadratic on the xy components. \`dirLocal\` is
// intentionally NOT normalized so the returned t values stay in the caller's
// proxy-space ray parameterization (same convention as
// intersectEllipsoidHeight). A ray parallel to the axis (a ≈ 0) is
// always-inside (-BIG, +BIG) when within the radius, else a miss
// (+BIG, -BIG); the caller's slab clip / enter > exit test handles both.
fn intersectInfiniteCylinder(originLocal: vec3<f32>, dirLocal: vec3<f32>,
                             radius: f32) -> vec2<f32> {
  let miss = vec2<f32>(3.402823e+38, -3.402823e+38);
  let position = originLocal.xy;
  let direction = dirLocal.xy;
  let a = dot(direction, direction);
  let b = dot(position, direction);
  let c = dot(position, position) - radius * radius;
  if (a < 1e-12) {
    return select(miss, vec2<f32>(-3.402823e+38, 3.402823e+38), c < 0.0);
  }
  let determinant = b * b - a * c;
  if (determinant < 0.0) {
    return miss;
  }
  let det = sqrt(determinant);
  return vec2<f32>((-b - det) / a, (-b + det) / a);
}

// NEW-VOXEL-CYLINDER-SHAPEUV — ray vs the cylinder's height slab
// zMin <= z <= zMax in the LOCAL frame (WebGL's intersectBoundPlanes over the
// two renderBoundPlanes). Same always-inside / miss convention as above for
// rays parallel to the caps.
fn intersectCylinderZSlab(originLocal: vec3<f32>,
                          dirLocal: vec3<f32>) -> vec2<f32> {
  let zMin = u.shapeHeightMinMax.x;
  let zMax = u.shapeHeightMinMax.y;
  if (abs(dirLocal.z) < 1e-12) {
    let inside = originLocal.z >= zMin && originLocal.z <= zMax;
    return select(vec2<f32>(3.402823e+38, -3.402823e+38),
                  vec2<f32>(-3.402823e+38, 3.402823e+38), inside);
  }
  let t1 = (zMin - originLocal.z) / dirLocal.z;
  let t2 = (zMax - originLocal.z) / dirLocal.z;
  return vec2<f32>(min(t1, t2), max(t1, t2));
}

// NEW-VOXEL-ELLIPSOID-INTERSECT — shape-typed replacement for the REAL
// proxy-space intersection used by the parity color march + the per-cell pick
// march. u.shapeType 0 (BOX — the default, and every zero-filled fallback)
// returns intersectAABB's interval verbatim with an EMPTY inner-skip interval
// (+BIG, -BIG), so the marched t values and the accumulation stay
// bit-identical to the pre-ellipsoid path. u.shapeType 1 (ELLIPSOID)
// transforms the ray into the ellipsoid's local frame and intersects the
// OUTER ellipsoid (radii + maxHeight) for the march interval plus the INNER
// ellipsoid (radii + minHeight) for the shell's hole interval, per WebGL
// IntersectEllipsoid.glsl intersectShape(): the inner interval is sandwiched
// inside the outer one (float-noise guard on planet-scale thin shells) and
// the march SKIPS samples inside it. Interior per-cell addressing ships in
// NEW-VOXEL-ELLIPSOID-SHAPEUV (computeShapeUvReal); longitude/latitude RENDER
// bounds (cones/wedges/half-planes) remain a documented residual.
// NEW-VOXEL-CYLINDER-SHAPEUV — u.shapeType 2 (CYLINDER) intersects the OUTER
// infinite cylinder (renderRadiusMinMax.y) clipped by the height slab
// (WebGL IntersectCylinder.glsl intersectBoundedCylinder), plus the INNER
// infinite cylinder (renderRadiusMinMax.x > 0) as the hole interval —
// sandwiched into the outer interval exactly like the ellipsoid shell's
// inner hole (within the outer interval the ray is inside the height slab,
// so the hole clip is exact). Angle RENDER bounds (wedges/half-planes)
// remain a documented residual, mirroring the ellipsoid increment.
// Returns vec4(enter, exit, innerEnter, innerExit); enter > exit = miss.
fn intersectShapeReal(rayOrigin: vec3<f32>, rayDir: vec3<f32>,
                      invDir: vec3<f32>) -> vec4<f32> {
  let emptyHole = vec2<f32>(3.402823e+38, -3.402823e+38);
  if (u.shapeType < 0.5) {
    let tr = intersectAABB(rayOrigin, invDir, u.minBounds, u.maxBounds);
    return vec4<f32>(tr, emptyHole);
  }
  let oL = (u.proxyToLocal * vec4<f32>(rayOrigin, 1.0)).xyz;
  let dL = (u.proxyToLocal * vec4<f32>(rayDir, 0.0)).xyz;
  if (u.shapeType > 1.5) {
    let outerCyl = intersectInfiniteCylinder(
      oL, dL, u.cylinderRenderRadiusMinMax.y);
    let slab = intersectCylinderZSlab(oL, dL);
    let outerC = vec2<f32>(max(outerCyl.x, slab.x), min(outerCyl.y, slab.y));
    if (outerC.x > outerC.y) {
      return vec4<f32>(outerC, emptyHole);
    }
    var innerC = emptyHole;
    if (u.cylinderRenderRadiusMinMax.x > 0.0) {
      innerC = intersectInfiniteCylinder(
        oL, dL, u.cylinderRenderRadiusMinMax.x);
    }
    if (innerC.x > innerC.y) {
      return vec4<f32>(outerC, emptyHole);
    }
    return vec4<f32>(outerC,
                     max(innerC.x, outerC.x),
                     min(innerC.y, outerC.y));
  }
  let outer = intersectEllipsoidHeight(oL, dL, u.shapeHeightMinMax.y);
  if (outer.x > outer.y) {
    return vec4<f32>(outer, emptyHole);
  }
  // Inner ellipsoid only exists while radii + minHeight stays positive
  // (VoxelEllipsoidShape clamps minHeight >= -minimumRadius; equality
  // degenerates the inner surface to a point — no hole).
  let minRadius = min(u.ellipsoidRadii.x,
                      min(u.ellipsoidRadii.y, u.ellipsoidRadii.z));
  var inner = emptyHole;
  if (minRadius + u.shapeHeightMinMax.x > 0.0) {
    inner = intersectEllipsoidHeight(oL, dL, u.shapeHeightMinMax.x);
  }
  if (inner.x > inner.y) {
    return vec4<f32>(outer, emptyHole);
  }
  return vec4<f32>(outer,
                   max(inner.x, outer.x),
                   min(inner.y, outer.y));
}

// NEW-VOXEL-ELLIPSOID-INTERSECT — entry-face normal for the ellipsoid shell
// in the PROXY frame (the frame u.lightDirectionModel lives in). WebGL's
// intersectHeight() uses the spherical approximation: the unit-sphere-space
// position at the hit IS the surface normal in the ellipsoid's local frame.
// Normals transform between frames by the inverse-transpose; local→proxy is
// mat3(proxyToLocal)⁻¹, so n_proxy = mat3(proxyToLocal)ᵀ · n_local. The
// caller normalizes.
fn ellipsoidEntryNormal(rayOrigin: vec3<f32>, rayDir: vec3<f32>,
                        tEnter: f32) -> vec3<f32> {
  let oL = (u.proxyToLocal * vec4<f32>(rayOrigin, 1.0)).xyz;
  let dL = (u.proxyToLocal * vec4<f32>(rayDir, 0.0)).xyz;
  let rc = vec3<f32>(1.0)
         / (u.ellipsoidRadii + vec3<f32>(u.shapeHeightMinMax.y));
  let dSphere = (oL + tEnter * dL) * rc;
  let m3 = mat3x3<f32>(u.proxyToLocal[0].xyz,
                       u.proxyToLocal[1].xyz,
                       u.proxyToLocal[2].xyz);
  return transpose(m3) * dSphere;
}

// NEW-VOXEL-CYLINDER-SHAPEUV — entry-face normal for the cylinder solid in
// the PROXY frame. The composite entry of an intersection of convex sets is
// the LATEST of the surface entries, so when the height slab's entry t
// coincides with the composite entry the ray came in through a CAP
// (normal ±z, opposite the ray's z direction — WebGL intersectBoundPlanes);
// otherwise through the SIDE surface (radial normal — WebGL
// intersectCylinder's convex normal (position + t·direction, 0)). Same
// inverse-transpose local→proxy lift as ellipsoidEntryNormal; the caller
// normalizes.
fn cylinderEntryNormal(rayOrigin: vec3<f32>, rayDir: vec3<f32>,
                       tEnter: f32) -> vec3<f32> {
  let oL = (u.proxyToLocal * vec4<f32>(rayOrigin, 1.0)).xyz;
  let dL = (u.proxyToLocal * vec4<f32>(rayDir, 0.0)).xyz;
  let slab = intersectCylinderZSlab(oL, dL);
  var nLocal = vec3<f32>(oL.xy + tEnter * dL.xy, 0.0);
  if (slab.x >= tEnter - 1e-4 && abs(dL.z) >= 1e-12) {
    nLocal = vec3<f32>(0.0, 0.0, -sign(dL.z));
  }
  let m3 = mat3x3<f32>(u.proxyToLocal[0].xyz,
                       u.proxyToLocal[1].xyz,
                       u.proxyToLocal[2].xyz);
  return transpose(m3) * nLocal;
}

// NEW-VOXEL-ELLIPSOID-SHAPEUV — nearest point on the meridional ellipse +
// the local radius of curvature, WGSL port of WebGL's
// convertLocalToEllipsoidUv.glsl nearestPointAndRadiusOnEllipse() /
// VoxelEllipsoidShape.js nearestPointAndRadiusOnEllipse(): the trig-free
// evolute iteration (3 fixed steps). \`radii\` is the OUTER ellipse
// (outerRadii.xz); \`evoluteScale\` = (rx² - rz²)/rx, (rz² - rx²)/rz.
// Returns vec3(nearestPoint.xy in the caller's signed quadrant, |v - evolute|).
fn voxelNearestPointAndRadiusOnEllipse(pos: vec2<f32>, radii: vec2<f32>,
                                       evoluteScale: vec2<f32>) -> vec3<f32> {
  let p = abs(pos);
  let inverseRadii = vec2<f32>(1.0) / radii;
  var tTrigs = vec2<f32>(0.7071067811865476);
  var v = radii * tTrigs;
  var evolute = evoluteScale * tTrigs * tTrigs * tTrigs;
  for (var i = 0; i < 3; i = i + 1) {
    let q = normalize(p - evolute) * length(v - evolute);
    tTrigs = (q + evolute) * inverseRadii;
    tTrigs = normalize(clamp(tTrigs, vec2<f32>(0.0), vec2<f32>(1.0)));
    v = radii * tTrigs;
    evolute = evoluteScale * tTrigs * tTrigs * tTrigs;
  }
  return vec3<f32>(v * sign(pos), length(v - evolute));
}

// NEW-VOXEL-ELLIPSOID-SHAPEUV — radial/longitude/latitude shapeUv for a point
// in the shape's ellipsoid-centered LOCAL frame (meters). WGSL port of
// VoxelEllipsoidShape.prototype.convertLocalToShapeUvSpace (the CPU reference
// the box path already treats as the convention's source of truth):
//   x = (atan2(y, x) + π) / 2π, then the shape-bounds range-origin wrap +
//       scale/offset when ELLIPSOID_HAS_SHAPE_BOUNDS_LONGITUDE;
//   y = geodetic latitude via the nearest-point-on-ellipse normal,
//       (lat + π/2) / π, then scale/offset when ..._HAS_SHAPE_BOUNDS_LATITUDE;
//   z = 1 + signedHeight · heightScale, where signedHeight is measured
//       against the OUTER ellipsoid (u.ellipsoidRadii + maxHeight — the same
//       surface WebGL's shaderUniforms.ellipsoidRadii carries) and
//       heightScale = 1/(maxHeight - minHeight).
fn ellipsoidShapeUvFromLocal(pLocal: vec3<f32>) -> vec3<f32> {
  let outerRadii = u.ellipsoidRadii + vec3<f32>(u.shapeHeightMinMax.y);

  var longitude = (atan2(pLocal.y, pLocal.x) + 3.14159265358979)
                / 6.28318530717959;
  if (u.ellipsoidHasShapeBounds.x > 0.5) {
    longitude = fract(longitude - u.ellipsoidShapeUvLongitudeRangeOrigin);
    longitude = longitude * u.ellipsoidLocalToShapeUvScale.x
              + u.ellipsoidLocalToShapeUvTranslate.x;
  }

  let distanceFromZAxis = length(pLocal.xy);
  let posEllipse = vec2<f32>(distanceFromZAxis, pLocal.z);
  let evoluteScale = vec2<f32>(
    (outerRadii.x * outerRadii.x - outerRadii.z * outerRadii.z) / outerRadii.x,
    (outerRadii.z * outerRadii.z - outerRadii.x * outerRadii.x) / outerRadii.z,
  );
  let spr = voxelNearestPointAndRadiusOnEllipse(
    posEllipse, outerRadii.xz, evoluteScale);
  let surfacePoint = spr.xy;
  let invRadiiSq = vec2<f32>(1.0) / (outerRadii.xz * outerRadii.xz);
  let normal2d = normalize(surfacePoint * invRadiiSq);
  var latitude = (atan2(normal2d.y, normal2d.x) + 1.57079632679490)
               / 3.14159265358979;
  if (u.ellipsoidHasShapeBounds.y > 0.5) {
    latitude = latitude * u.ellipsoidLocalToShapeUvScale.y
             + u.ellipsoidLocalToShapeUvTranslate.y;
  }

  let heightSign = select(1.0, -1.0,
                          length(posEllipse) < length(surfacePoint));
  let height = heightSign * length(posEllipse - surfacePoint);
  let z = 1.0 + height * u.ellipsoidLocalToShapeUvScale.z;

  return vec3<f32>(longitude, latitude, z);
}

// NEW-VOXEL-CYLINDER-SHAPEUV — radial/angle/height shapeUv for a point in
// the shape's cylinder-centered LOCAL frame. Verbatim WGSL port of
// VoxelCylinderShape.prototype.convertLocalToShapeUvSpace (the CPU reference
// convention):
//   x = length(xy) · radialScale + radialOffset;
//   y = (atan2(y, x) + π) / 2π, wrapped past the shape-bounds angle-range
//       origin (fract), then · angleScale + angleOffset;
//   z = z · heightScale + heightOffset.
// The scale/offset terms are packed from the shape's OWN shader-uniform
// state (single source of truth) and the wrap applies unconditionally,
// exactly as the JS does.
fn cylinderShapeUvFromLocal(pLocal: vec3<f32>) -> vec3<f32> {
  let radius = length(pLocal.xy) * u.cylinderLocalToShapeUvScale.x
             + u.cylinderLocalToShapeUvTranslate.x;
  var angle = (atan2(pLocal.y, pLocal.x) + 3.14159265358979)
            / 6.28318530717959;
  angle = fract(angle - u.cylinderShapeUvAngleRangeOrigin);
  angle = angle * u.cylinderLocalToShapeUvScale.y
        + u.cylinderLocalToShapeUvTranslate.y;
  let height = pLocal.z * u.cylinderLocalToShapeUvScale.z
             + u.cylinderLocalToShapeUvTranslate.z;
  return vec3<f32>(radius, angle, height);
}

// NEW-VOXEL-ELLIPSOID-SHAPEUV — shape-typed sample coordinate for the REAL
// parity marches. BOX (shapeType 0 — also the zero-filled placeholder
// fallback) keeps the CPU-composed affine proxy→shapeUv chain verbatim
// (bit-identical to the pre-ellipsoid path); ELLIPSOID lifts the proxy point
// into the shape's local frame (the B22 proxyToLocal) and runs the
// radial/longitude/latitude conversion above; CYLINDER
// (NEW-VOXEL-CYLINDER-SHAPEUV, shapeType 2) runs the radial/angle/height
// conversion. All clamp like WebGL's getClampedTileUv (root tile:
// tileUv == shapeUv).
fn computeShapeUvReal(p: vec3<f32>) -> vec3<f32> {
  if (u.shapeType < 0.5) {
    return clamp(
      (u.proxyToShapeUv * vec4<f32>(p, 1.0)).xyz,
      vec3<f32>(0.0),
      vec3<f32>(1.0),
    );
  }
  let pLocal = (u.proxyToLocal * vec4<f32>(p, 1.0)).xyz;
  if (u.shapeType > 1.5) {
    return clamp(cylinderShapeUvFromLocal(pLocal),
                 vec3<f32>(0.0), vec3<f32>(1.0));
  }
  return clamp(ellipsoidShapeUvFromLocal(pLocal),
               vec3<f32>(0.0), vec3<f32>(1.0));
}

// NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — iterative octree walk (Octree.glsl-style
// descend with per-level slot indirection), shared by the color march and the
// per-cell pick march so the picked cell always agrees with the displayed
// surface. Starting at the root, refine one level at a time while this
// frame's target LOD level (u.atlasInfo.y — the CPU-evaluated SSE refine
// ladder) demands it AND the child tile owning the sample is uploaded: at
// level L the tile coordinate is floor(shapeUv * 2^L) (WebGL's shapeUv → tile
// convention) and the sample's tile-local uv is shapeUv * 2^L - tileCoord
// (Octree.glsl getTileUv, levelDifference 0). A missing tile (slot < 0) stops
// the walk at the deepest uploaded ANCESTOR — sampling it with the ancestor's
// tileUv is exactly getTileUv's levelDifference-N rescale, i.e. the
// OCTREE_FLAG_PACKED_LEAF_FROM_PARENT path. Slot indirection per level:
// level 1 reads childSlots0/1 (octant x + 2y + 4z), level 2 reads l2Slots
// (linear x + 4y + 16z), and level 3 reads l3Slots (linear x + 8y + 64z —
// NEW-VOXEL-OCTREE-DEEP-LEVELS). Depth is capped at 3 — the fixed-atlas
// budget (the 585-slot static deep-3 atlas; deeper/partial levels need the
// NEW-VOXEL-ATLAS-LRU-EVICT slot allocator generalized per level). targetLevel
// 0 (single-tile / placeholder / far view) never enters the loop: tileUv =
// shapeUv, slot = 0 — byte-identical to the pre-octree math.
//
// Returns vec4(tileUv.xyz, tileSlot).
fn octreeDescend(shapeUv: vec3<f32>) -> vec4<f32> {
  var tileUv = shapeUv;
  var tileSlot = 0.0;
  let targetLevel = min(i32(u.atlasInfo.y + 0.5), 3);
  var n = 2.0;
  for (var lvl = 1; lvl <= targetLevel; lvl = lvl + 1) {
    let tc = clamp(floor(shapeUv * n), vec3<f32>(0.0), vec3<f32>(n - 1.0));
    var slot = -1.0;
    if (lvl == 1) {
      let idx = i32(tc.x + 2.0 * tc.y + 4.0 * tc.z);
      if (idx < 4) {
        slot = u.childSlots0[idx];
      } else {
        slot = u.childSlots1[idx - 4];
      }
    } else if (lvl == 2) {
      let idx = i32(tc.x + 4.0 * tc.y + 16.0 * tc.z);
      slot = u.l2Slots[idx / 4][idx % 4];
    } else {
      let idx = i32(tc.x + 8.0 * tc.y + 64.0 * tc.z);
      slot = u.l3Slots[idx / 4][idx % 4];
    }
    if (slot < 0.0) { break; }
    tileSlot = slot;
    tileUv = clamp(shapeUv * n - tc, vec3<f32>(0.0), vec3<f32>(1.0));
    n = n * 2.0;
  }
  return vec4<f32>(tileUv, tileSlot);
}

// Batch 196 — IGN-based ray-start jitter for voxel ray-march. Same
// Jimenez IGN formula as csm_stochasticDither / fragmentPickHoverMain
// (Batch 192) and the TAA jitter (Batch 195). Anti-aliases sample
// positions across pixels: instead of every fragment's first sample
// landing at the same uniform-grid \`tS\`, neighboring fragments start
// at slightly different t-values along their rays. Reduces banding
// artifacts in volumetric renders that would otherwise show up as
// stair-step rings where rays cross density boundaries.
//
// With TAA on, TAA's own per-frame camera jitter implicitly produces
// a different sample pattern per frame at the same world-space pixel,
// giving temporal smoothing in addition to the spatial jitter here —
// no frame-counter plumbing needed in the voxel UBO.
fn voxelRayDither(fragCoord: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * fragCoord.x + 0.00583715 * fragCoord.y));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let rayDir = normalize(input.worldPos - u.cameraPositionEC);
  let invDir = 1.0 / rayDir;
  let tr = intersectAABB(u.cameraPositionEC, invDir, u.minBounds, u.maxBounds);
  // NEW-4-E (Batch 68): WGSL \`discard\` does not terminate function
  // control flow — naga requires every path to reach an explicit
  // \`return\`. Pair each early-out \`discard\` with a fall-through return
  // so naga can prove the function returns on every code path. The
  // returned value is dropped by \`discard\` so the colour is irrelevant.
  if (tr.x > tr.y) { discard; return vec4<f32>(0.0); }
  // Batch 196 — jitter the ray-start within one stepSize window so
  // adjacent fragments don't all sample at the same t-grid points.
  // Dither output is in [0, 1); multiplied by stepSize gives a
  // sub-step offset that anti-aliases the integration sample positions
  // across the screen. Compounds cleanly with TAA's per-frame camera
  // jitter for temporal smoothing under accumulation.
  let dither = voxelRayDither(input.position.xy);
  let tS = max(tr.x, 0.0) + dither * u.stepSize;
  let tE = tr.y;
  var accumC = vec3<f32>(0.0);
  var accumA: f32 = 0.0;
  let maxI = i32(u.maxSteps);
//>>ifdef VOXEL_CUSTOM_SHADER_COLOR
  // PARITY-VOXEL-COLOR-PARITY — WebGL-matching front-to-back accumulation using
  // the DEFAULT voxel customShader (VoxelPrimitive.DefaultCustomShader):
  //   material.diffuse = vec3(0.5 + 0.5 * max(0, dot(voxelNormalEC, lightEC)));
  //   material.alpha   = 1.0;
  // i.e. a GRAY box shaded by the voxel-face normal · sun direction — the
  // property colour is NOT used for diffuse in the default shader (it only
  // gates density). Mirrors Shaders/Voxels/VoxelFS.glsl's premultiplied
  // front-to-back integral (\`colorAccum += (1 - colorAccum.a) *
  // vec4(diffuse * alpha, alpha)\`) saturating at ALPHA_ACCUM_MAX (0.98) then
  // normalising alpha back to [0,1]. An opaque (alpha == 1) front voxel wins,
  // so the visible colour is the gray lighting at the entry face — the same
  // gray WebGL produces, instead of the raw-texel green/teal the historical
  // else-branch integral yields.
  let ALPHA_ACCUM_MAX: f32 = 0.98;
  // VOXEL-SHAPEUV-CONVENTION — march the REAL proxy box with the REAL
  // proxy-space camera origin. The shared prelude above intersects a
  // camera-CENTERED phantom box (\`worldPos\` is camera-relative and
  // \`u.cameraPositionEC\` is zero): that fills the correct screen footprint —
  // the rasterized proxy geometry gates which pixels run — but its sample
  // positions live in a volume centered on the camera, so the sampled cells
  // were view-dependent garbage. The parity path needs physically-correct
  // sample positions for the shapeUv chain to address the same cells WebGL's
  // traversal reads.
  let rayOrigin = u.cameraPositionProxy;
  // NEW-VOXEL-ELLIPSOID-INTERSECT — shape-typed real intersection: BOX takes
  // intersectAABB verbatim (bit-identical); ELLIPSOID intersects the
  // outer/inner shell. shellReal.zw is the inner-hole interval the march
  // skips (empty (+BIG, -BIG) for BOX and hole-less shells).
  let shellReal = intersectShapeReal(rayOrigin, rayDir, invDir);
  let trReal = shellReal.xy;
  // NEW-4-E: pair discard with a return for naga's terminator analysis.
  if (trReal.x > trReal.y) { discard; return vec4<f32>(0.0); }
  let tStart = max(trReal.x, 0.0) + dither * u.stepSize;
  let tEnd = trReal.y;
  // Entry-face normal in the box-LOCAL frame: the AABB slab whose tMin equals
  // the entry t (trReal.x). \`step()\` picks the axis; the sign is opposite the
  // ray direction (we enter through the face the ray points INTO).
  let t1n = (u.minBounds - rayOrigin) * invDir;
  let t2n = (u.maxBounds - rayOrigin) * invDir;
  let tMinV = min(t1n, t2n);
  let entryAxis = step(vec3<f32>(trReal.x) - vec3<f32>(1e-4), tMinV);
  // Normalize the selector so exactly one axis contributes even if two slabs
  // coincide, then orient it against the ray.
  let axisSum = max(entryAxis.x + entryAxis.y + entryAxis.z, 1.0);
  var entryNormalLocal = -sign(rayDir) * entryAxis / axisSum;
  // NEW-VOXEL-ELLIPSOID-INTERSECT — the shell's entry face is the outer
  // ellipsoid, not an AABB slab; use the spherical-approximation normal
  // (WebGL intersectHeight) transformed into the proxy frame. BOX keeps the
  // slab normal above bit-identically. NEW-VOXEL-CYLINDER-SHAPEUV — the
  // cylinder's entry face is the side surface or a cap plane.
  if (u.shapeType > 1.5) {
    entryNormalLocal = cylinderEntryNormal(rayOrigin, rayDir, trReal.x);
  } else if (u.shapeType > 0.5) {
    entryNormalLocal = ellipsoidEntryNormal(rayOrigin, rayDir, trReal.x);
  }
  // Default-shader gray lighting: 0.5 + 0.5 * max(0, dot(n, lightDirModel)).
  let ndotl = max(0.0, dot(normalize(entryNormalLocal), u.lightDirectionModel));
  let lighting = 0.5 + 0.5 * ndotl;
  let matDiffuse = vec3<f32>(lighting);
  for (var i = 0; i < maxI; i = i + 1) {
    let t = tStart + f32(i) * u.stepSize;
    if (t > tEnd || accumA > ALPHA_ACCUM_MAX) { break; }
    // NEW-VOXEL-ELLIPSOID-INTERSECT — skip samples inside the shell's inner
    // hole (the ELLIPSOID inner-ellipsoid interval). Empty for BOX
    // (+BIG, -BIG), so the comparison never fires there.
    if (t > shellReal.z && t < shellReal.w) { continue; }
    let p = rayOrigin + rayDir * t;
    // VOXEL-SHAPEUV-CONVENTION — derive the sample coordinate through WebGL's
    // convention chain instead of the historical model-space \`p + 0.5\`
    // shortcut: (1) proxy point → shapeUv via the shape-typed conversion
    // (BOX: the CPU-composed convertLocalToShapeUvSpace affine; ELLIPSOID:
    // the NEW-VOXEL-ELLIPSOID-SHAPEUV radial/longitude/latitude chain —
    // clamped like getClampedTileUv; the root tile's tileUv == shapeUv);
    // (2) shapeUv → input-data coordinate via Octree.glsl's
    // \`tileUv * u_dimensions + u_paddingBefore\` plus the
    // Y_UP_METADATA_ORDER + SHAPE_BOX axis swap/flip; (3) texel-centre clamp +
    // normalisation per Megatexture.glsl's getPropertiesFromMegatexture.
    let shapeUv = computeShapeUvReal(p);
    // VOXEL-OCTREE-LOD / NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — iterative octree
    // walk to this frame's target level (see octreeDescend). Non-refined
    // frames keep tileUv = shapeUv / tileSlot = 0 — byte-identical to the
    // pre-octree math.
    let descent = octreeDescend(shapeUv);
    let tileUv = descent.xyz;
    let tileSlot = descent.w;
    var inputCoord = tileUv * u.voxelDimensions + u.paddingBefore;
    if (u.metadataYUpBox > 0.5) {
      let inputY = inputCoord.y;
      inputCoord.y = inputCoord.z;
      inputCoord.z = u.inputDimensions.z - inputY;
    }
    let clampedCoord = clamp(
      inputCoord,
      vec3<f32>(0.5),
      u.inputDimensions - vec3<f32>(0.5),
    );
    // Atlas addressing: tiles are stacked along the texture Z axis, one
    // inputDimensions.z-deep slab per slot. The per-tile texel-centre clamp
    // above already prevents linear-filter bleed across slab boundaries.
    // slotCount = 1 (single-tile texture) reduces to the historical
    // clampedCoord / inputDimensions exactly.
    let slotCount = max(u.atlasInfo.x, 1.0);
    let uvw = vec3<f32>(
      clampedCoord.x / u.inputDimensions.x,
      clampedCoord.y / u.inputDimensions.y,
      (clampedCoord.z + tileSlot * u.inputDimensions.z)
        / (u.inputDimensions.z * slotCount),
    );
    let s = textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0);
//>>ifdef VOXEL_USER_CUSTOM_SHADER
    // VOXEL-USER-CUSTOMSHADER — run the USER's native-WGSL customShader for
    // this sample. \`czm_voxelCustomFragmentMain\` + the bridge structs come
    // from the GENERATED chunk prepended to this source
    // (WebGPUVoxelCustomShaderCodegen); this branch only compiles when that
    // chunk is present (the renderer sets the define + prepends together).
    // Accumulation mirrors WebGL VoxelFS.glsl exactly: sanitize the material
    // (rgb >= 0, alpha in [0,1]) then premultiplied front-to-back blend of
    // EVERY sample — no densityThreshold gate; a sample the user leaves at
    // the zero-initialised material (alpha 0) contributes nothing.
    var fsInput: czm_voxelCustomFragmentInput;
    fsInput.metadata = czm_voxelReadCustomMetadata(s);
    fsInput.attributes.normalLocal = normalize(entryNormalLocal);
    fsInput.attributes.lightDirectionLocal = u.lightDirectionModel;
    fsInput.attributes.shapeUv = shapeUv;
    var voxelMaterial: czm_voxelCustomMaterial;
    czm_voxelCustomFragmentMain(fsInput, &voxelMaterial);
    let userDiffuse = max(voxelMaterial.diffuse, vec3<f32>(0.0));
    let userAlpha = clamp(voxelMaterial.alpha, 0.0, 1.0);
    accumC = accumC + (1.0 - accumA) * userDiffuse * userAlpha;
    accumA = accumA + (1.0 - accumA) * userAlpha;
//>>else
    if (s.a > u.densityThreshold) {
      // Default voxel customShader material: gray lighting, opaque.
      let matAlpha = 1.0;
      accumC = accumC + (1.0 - accumA) * matDiffuse * matAlpha;
      accumA = accumA + (1.0 - accumA) * matAlpha;
    }
//>>endif
  }
  accumA = min(accumA, ALPHA_ACCUM_MAX);
  // Convert the alpha from [0, ALPHA_ACCUM_MAX] back to [0, 1] (WebGL).
  accumA = accumA / ALPHA_ACCUM_MAX;
  if (accumA < 0.01) { discard; return vec4<f32>(0.0); }
  var finalColor = vec4<f32>(accumC, accumA);
//>>else
  for (var i = 0; i < maxI; i = i + 1) {
    let t = tS + f32(i) * u.stepSize;
    if (t > tE || accumA > 0.99) { break; }
    let p = u.cameraPositionEC + rayDir * t;
    let uvw = (p - u.minBounds) / (u.maxBounds - u.minBounds);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { continue; }
    // NEW-4-G (Batch 69): WGSL requires textureSample to be called from
    // uniform control flow (it auto-computes derivatives across a 2x2
    // fragment quad). The enclosing for-loop has a data-dependent
    // \`break\` on accumA, so the loop body is not in uniform control
    // flow — naga rejects textureSample here. textureSampleLevel with
    // explicit LOD 0.0 has no derivative requirement and no uniform-
    // control-flow constraint. Volumetric voxel textures are single-mip
    // anyway, so forcing LOD 0 matches existing intent.
    let s = textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0);
    if (s.a > u.densityThreshold) {
      let sa = s.a * u.stepSize;
      accumC = accumC + s.rgb * sa * (1.0 - accumA);
      accumA = accumA + sa * (1.0 - accumA);
    }
  }
  if (accumA < 0.01) { discard; return vec4<f32>(0.0); }
  var finalColor = vec4<f32>(accumC, accumA);
//>>endif

  // FEAT-GAP-09 (Batch 103) — Aerial-perspective fog blend. Mirrors
  // PrimitiveBasicColor.wgsl::fragmentMain. The inline VOXEL_WGSL
  // already passes RTE-space \`worldPos\` (position relative to camera)
  // from vertex to fragment; we use that as the view direction source.
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

// C-R9-VOXEL-PICK (Batch 53) — pick entry point.
//
// Runs the same AABB entry/exit clip and ray-march loop as fragmentMain,
// but emits u.pickColor on the FIRST non-empty sample (density above
// threshold) instead of accumulating volumetric color. The "first hit"
// semantics give VoxelPrimitive-granularity pick (one pickId per
// VoxelPrimitive) — per-cell / per-tile granularity is a separate
// follow-up (C-R9-VOXEL-CELL-PICK). All shape entry/exit checks and
// uvw bounds checks are preserved so a ray that misses the volume still
// discards correctly.
@fragment
fn fragmentPickMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let rayDir = normalize(input.worldPos - u.cameraPositionEC);
  let invDir = 1.0 / rayDir;
  let tr = intersectAABB(u.cameraPositionEC, invDir, u.minBounds, u.maxBounds);
  // NEW-4-E (Batch 68): see comment in fragmentMain — every \`discard\`
  // is paired with an explicit \`return\` so naga can prove the function
  // terminates on every control-flow path.
  if (tr.x > tr.y) { discard; return vec4<f32>(0.0); }
  let tS = max(tr.x, 0.0);
  let tE = tr.y;
  let maxI = i32(u.maxSteps);
  for (var i = 0; i < maxI; i = i + 1) {
    let t = tS + f32(i) * u.stepSize;
    if (t > tE) { break; }
    let p = u.cameraPositionEC + rayDir * t;
    var uvw = (p - u.minBounds) / (u.maxBounds - u.minBounds);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { continue; }
    // VOXEL-OCTREE-LOD — when the bound texture is a Z-stacked tile atlas,
    // compress z into slot 0 (the ROOT slab) so the pick march samples only
    // root data. atlasInfo.x is 0 (placeholder) or 1 (single-tile texture)
    // outside the atlas case, so max(x, 1.0) keeps the historical math
    // byte-identical there.
    uvw.z = uvw.z / max(u.atlasInfo.x, 1.0);
    // NEW-4-G (Batch 69): textureSampleLevel(..., 0.0) instead of
    // textureSample — see fragmentMain for the uniform-control-flow
    // rationale. The early-return on first hit makes the data-dependence
    // structurally identical to the color path.
    let s = textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0);
    if (s.a > u.densityThreshold) {
      // First non-empty sample wins. Emit the pickColor unmodified —
      // the pick FBO readback maps it back to {primitive, id}.
      return u.pickColor;
    }
  }
  // Ray traversed the whole AABB with no density hit; nothing to pick.
  discard;
  return vec4<f32>(0.0);
}

// C-R9-VOXEL-CELL-PICK — WebGL VoxelFS.glsl packIntToVec2: base-255 split
// with the high byte in .x. Scene.pickVoxel decodes the readback bytes as
// \`255 * high + low\`, so the round-trip recovers the integer exactly for
// values < 255*255.
fn packVoxelIntToVec2(value: f32) -> vec2<f32> {
  let shifted = value / 255.0;
  return vec2<f32>(floor(shifted) / 255.0, fract(shifted));
}

// C-R9-VOXEL-CELL-PICK — per-cell pick entry point (passes.pickVoxel).
//
// Mirrors WebGL's Shaders/Voxels/VoxelFS.glsl PICKING_VOXEL branch: march
// the volume, and at the first sample whose accumulated alpha saturates
// ALPHA_ACCUM_MAX emit \`vec4(packIntToVec2(megatextureIndex),
// packIntToVec2(getSampleIndex(...)))\` so Scene.pickVoxel's \`255*R+G\` /
// \`255*B+A\` decode recovers {tileIndex, sampleIndex} unchanged. Under the
// WebGPU parity march model (default customShader: a sample is opaque when
// \`s.a > densityThreshold\`, else empty — see the VOXEL_CUSTOM_SHADER_COLOR
// branch of fragmentMain), the saturating sample is the FIRST density hit.
//
// The sample coordinate derives through the SAME physically-correct ray +
// world→shapeUv→inputCoordinate chain as the parity color march
// (VOXEL-SHAPEUV-CONVENTION): real proxy-space camera origin against the
// real ±0.5 proxy box, then Octree.glsl's \`tileUv * u_dimensions +
// u_paddingBefore\` + the Y_UP_METADATA_ORDER + SHAPE_BOX swap/flip. The
// cell index floors the UNCLAMPED-to-texel-centre input coordinate exactly
// like WebGL's getSampleIndex (clamp to [0, u_inputDimensions - 0.5], floor,
// flatten x + inX*(y + inY*z)). No ray dither — WebGL's PICKING_VOXEL
// samples the exact intersection positions, and a jittered start could flip
// the decoded cell at cell boundaries.
//
// megatextureIndex is the sampled TILE's atlas slot (NEW-VOXEL-PICK-OCTREE-
// COMPOSE): 0 = the ROOT tile (WebGL's root keyframeNode occupies megatexture
// slot 0), 1..8 = the level-1 children in child-octant order — the same
// order WebGL's VoxelTraversal adds them to the megatexture for a
// synchronously-resolving two-level provider — and 9..72 = the level-2 tiles
// in linear x + 4y + 16z order (NEW-VOXEL-OCTREE-DEEP-TRAVERSAL; deep-tree
// slot ordering is a deterministic backend-internal handle, not byte-equal to
// WebGL's load-order megatextureIndex).
//
// NEW-VOXEL-PICK-OCTREE-COMPOSE — the pick march composes with the color
// march's iterative octree walk (octreeDescend): on refined frames
// (atlasInfo.y >= 1) the sample descends to the deepest uploaded tile at the
// target level and the emitted {megatextureIndex, sampleIndex} identify THAT
// tile + its local cell, so the pick agrees with the displayed refined surface.
// When a USER native-WGSL customShader is active (VOXEL_USER_CUSTOM_SHADER)
// the winner gate matches the displayed surface too: ungated accumulation of
// the user material's alpha with WebGL's PICKING_VOXEL ALPHA_ACCUM_MAX (0.1)
// instead of the raw-texel density gate.
//
// Only ever dispatched from the dedicated pickVoxel pipeline, which is built
// exclusively on the real-data path (usingRealData) — the placeholder path
// never routes here, and the UBO convention fields this entry reads are only
// written on that same path.
@fragment
fn fragmentPickVoxelMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let rayDir = normalize(input.worldPos - u.cameraPositionEC);
  let invDir = 1.0 / rayDir;
  let rayOrigin = u.cameraPositionProxy;
  // NEW-VOXEL-ELLIPSOID-INTERSECT — the pick march composes with the color
  // march's shape-typed intersection so the picked surface agrees with the
  // displayed one. BOX is bit-identical to the pre-ellipsoid intersectAABB.
  let shellReal = intersectShapeReal(rayOrigin, rayDir, invDir);
  let trReal = shellReal.xy;
  // NEW-4-E: pair discard with a return for naga's terminator analysis.
  if (trReal.x > trReal.y) { discard; return vec4<f32>(0.0); }
  let tStart = max(trReal.x, 0.0);
  let tEnd = trReal.y;
  let maxI = i32(u.maxSteps);
//>>ifdef VOXEL_USER_CUSTOM_SHADER
  // NEW-VOXEL-PICK-OCTREE-COMPOSE — WebGL VoxelFS.glsl compiles the pick pass
  // with ALPHA_ACCUM_MAX 0.1 (vs 0.98 for color): the march accumulates every
  // sample's user-shader alpha and stops at the sample that crosses 0.1; the
  // emitted ids belong to the sample where the loop stopped (the saturating
  // sample, or the LAST marched sample when the ray exits unsaturated with
  // nonzero accumulated alpha — VoxelFS.glsl emits sampleDatas[0] at loop
  // exit and only discards at colorAccum.a == 0).
  let PICK_ALPHA_ACCUM_MAX: f32 = 0.1;
  // Entry-face normal in the box-LOCAL frame (same slab analysis as the
  // color march) — the user shader may read attributes.normalLocal.
  let t1n = (u.minBounds - rayOrigin) * invDir;
  let t2n = (u.maxBounds - rayOrigin) * invDir;
  let tMinV = min(t1n, t2n);
  let entryAxis = step(vec3<f32>(trReal.x) - vec3<f32>(1e-4), tMinV);
  let axisSum = max(entryAxis.x + entryAxis.y + entryAxis.z, 1.0);
  var entryNormalLocal = -sign(rayDir) * entryAxis / axisSum;
  // NEW-VOXEL-ELLIPSOID-INTERSECT / NEW-VOXEL-CYLINDER-SHAPEUV — same
  // shape-typed entry normal as the color march so the user shader sees
  // consistent attributes.
  if (u.shapeType > 1.5) {
    entryNormalLocal = cylinderEntryNormal(rayOrigin, rayDir, trReal.x);
  } else if (u.shapeType > 0.5) {
    entryNormalLocal = ellipsoidEntryNormal(rayOrigin, rayDir, trReal.x);
  }
  var accumA: f32 = 0.0;
  var winnerTileSlot: f32 = 0.0;
  var winnerInputCoord = vec3<f32>(0.0);
  var winnerValid = false;
//>>endif
  for (var i = 0; i < maxI; i = i + 1) {
    let t = tStart + f32(i) * u.stepSize;
    if (t > tEnd) { break; }
    // NEW-VOXEL-ELLIPSOID-INTERSECT — skip inner-hole samples (see the color
    // march). Empty interval for BOX — comparison never fires.
    if (t > shellReal.z && t < shellReal.w) { continue; }
    let p = rayOrigin + rayDir * t;
    // NEW-VOXEL-ELLIPSOID-SHAPEUV — same shape-typed sample coordinate as the
    // color march so the picked cell always agrees with the displayed one.
    let shapeUv = computeShapeUvReal(p);
    // NEW-VOXEL-PICK-OCTREE-COMPOSE — the SAME iterative octree walk as the
    // color march (octreeDescend): on refined frames the sample descends to
    // the deepest uploaded tile at the target level and the emitted
    // {megatextureIndex, sampleIndex} identify THAT tile + its local cell, so
    // the pick agrees with the displayed refined surface. Non-refined frames
    // (atlasInfo.y < 1) keep tileUv = shapeUv and tileSlot = 0 —
    // byte-identical to the pre-compose pick math.
    let descent = octreeDescend(shapeUv);
    let tileUv = descent.xyz;
    let tileSlot = descent.w;
    var inputCoord = tileUv * u.voxelDimensions + u.paddingBefore;
    if (u.metadataYUpBox > 0.5) {
      let inputY = inputCoord.y;
      inputCoord.y = inputCoord.z;
      inputCoord.z = u.inputDimensions.z - inputY;
    }
    // Texel-centre clamp for the SAMPLE (Megatexture.glsl) — the march's
    // density test must read the same texel the color march reads.
    let clampedCoord = clamp(
      inputCoord,
      vec3<f32>(0.5),
      u.inputDimensions - vec3<f32>(0.5),
    );
    // Atlas addressing with the sampled TILE's slot (root slab 0, or the
    // refined child's slab) — mirrors the color march exactly. Single-tile
    // textures have tileSlot = 0 / atlasInfo.x = 1 → byte-identical math.
    let uvw = vec3<f32>(
      clampedCoord.x / u.inputDimensions.x,
      clampedCoord.y / u.inputDimensions.y,
      (clampedCoord.z + tileSlot * u.inputDimensions.z)
        / (u.inputDimensions.z * max(u.atlasInfo.x, 1.0)),
    );
    // NEW-4-G: textureSampleLevel — see fragmentMain.
    let s = textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0);
//>>ifdef VOXEL_USER_CUSTOM_SHADER
    // Run the USER shader for this sample (same bridge structs as
    // fragmentMain's user branch) and accumulate its sanitized alpha —
    // the pick winner gate must match the DISPLAYED surface, which is the
    // ungated voxelMaterial.alpha accumulation, not the density gate.
    var fsInput: czm_voxelCustomFragmentInput;
    fsInput.metadata = czm_voxelReadCustomMetadata(s);
    fsInput.attributes.normalLocal = normalize(entryNormalLocal);
    fsInput.attributes.lightDirectionLocal = u.lightDirectionModel;
    fsInput.attributes.shapeUv = shapeUv;
    var voxelMaterial: czm_voxelCustomMaterial;
    czm_voxelCustomFragmentMain(fsInput, &voxelMaterial);
    let userAlpha = clamp(voxelMaterial.alpha, 0.0, 1.0);
    accumA = accumA + (1.0 - accumA) * userAlpha;
    winnerTileSlot = tileSlot;
    winnerInputCoord = inputCoord;
    winnerValid = true;
    if (accumA > PICK_ALPHA_ACCUM_MAX) { break; }
//>>else
    if (s.a > u.densityThreshold) {
      // WebGL getSampleIndex: clamp the raw input coordinate to
      // [0, u_inputDimensions - 0.5] then floor (NOT the texel-centre clamp
      // above — index derivation and texel addressing clamp differently).
      let cell = floor(clamp(
        inputCoord,
        vec3<f32>(0.0),
        u.inputDimensions - vec3<f32>(0.5),
      ));
      let sampleIndex =
        cell.x + u.inputDimensions.x * (cell.y + u.inputDimensions.y * cell.z);
      let megatextureId = packVoxelIntToVec2(tileSlot);
      let sampleId = packVoxelIntToVec2(sampleIndex);
      return vec4<f32>(megatextureId.x, megatextureId.y, sampleId.x, sampleId.y);
    }
//>>endif
  }
//>>ifdef VOXEL_USER_CUSTOM_SHADER
  if (winnerValid && accumA > 0.0) {
    let cell = floor(clamp(
      winnerInputCoord,
      vec3<f32>(0.0),
      u.inputDimensions - vec3<f32>(0.5),
    ));
    let sampleIndex =
      cell.x + u.inputDimensions.x * (cell.y + u.inputDimensions.y * cell.z);
    let megatextureId = packVoxelIntToVec2(winnerTileSlot);
    let sampleId = packVoxelIntToVec2(sampleIndex);
    return vec4<f32>(megatextureId.x, megatextureId.y, sampleId.x, sampleId.y);
  }
//>>endif
  // No pickable sample — nothing to pick at this pixel (WebGL:
  // colorAccum.a == 0 → discard).
  discard;
  return vec4<f32>(0.0);
}

// Batch 173 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity emission for
// voxel volumes. Screen-space approximation: emit per-fragment
// (currNdc - prevNdc) for the bounding-box surface vertex, which
// captures the camera-induced screen-space displacement of the
// volume's surface. For STATIC volumes (typical case — voxel volumes
// rarely animate per-cell), this gives correct TAA reprojection at
// the volume's screen pixels.
//
// What this DOESN'T capture (deferred follow-up):
//   - Per-cell motion of voxels animated by a compute pass (rare —
//     would need a per-cell prev grid texture or a prev modelMatrix).
//   - Animated modelMatrix between frames (the prev clip uses the
//     CURRENT modelMatrix; if modelMatrix is rigidly animated, the
//     velocity captures camera-motion only, not the per-frame model
//     transform delta). Voxel volumes rarely have animated
//     modelMatrix — typically locked at primitive construction.
//
// Falls back to camera-only TAA reprojection cleanly when both above
// are static (the dominant case).
struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
};

@vertex
fn vertexVelocityMain(input: VertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  // Current-frame clip via RTE (matches vertexMain).
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let currClip = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  // Previous-frame clip via prevVP × modelMatrix × modelPos. Voxel
  // cube vertices are static (unit cube [-h, h]^3), so the curr and
  // prev model-space positions are the SAME — we just project them
  // through the prev frame's full VP. For static modelMatrix the
  // delta is purely camera-motion-induced, which is exactly what TAA
  // reprojection wants.
  let modelPos = vec4<f32>(input.positionHigh + input.positionLow, 1.0);
  let prevWorldPos = u.modelMatrix * modelPos;
  let prevClip = u.prevViewProjection * prevWorldPos;
  output.position = currClip;
  output.currCenterClip = currClip;
  output.prevCenterClip = prevClip;
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

// PARITY-VOXEL-COLOR-PARITY — distinct pipeline-cache name for the color
// pipeline once it's rebuilt with the VOXEL_CUSTOM_SHADER_COLOR define. The
// central pipeline cache keys on `descriptor.name`, so this must differ from
// the placeholder "Voxel color pipeline" name to avoid a cache collision.
const VOXEL_COLOR_PARITY_PIPELINE_NAME = "Voxel color pipeline (customShader)";

// VOXEL-USER-CUSTOMSHADER — pipeline-cache name for a USER native-WGSL
// customShader color pipeline. Carries the generated chunk's hash so distinct
// user shader bodies get distinct pipeline-cache entries (the central cache
// keys on `descriptor.name`) while two primitives sharing the same shader
// share one pipeline.
function voxelUserShaderPipelineName(info: VoxelUserShaderInfo): string {
  return `Voxel color pipeline (userCustomShader#${info.hash.toString(16)})`;
}

// NEW-VOXEL-PICK-OCTREE-COMPOSE — per-cell pick pipeline names. The base name
// must match the init-time descriptor literal; the user variant carries the
// generated chunk's hash (same discriminator scheme as the color pipeline) so
// the pick winner gate is rebuilt from the user module when a native-WGSL
// customShader is active, and reverts when it is cleared.
const VOXEL_PICKVOXEL_PIPELINE_NAME = "Voxel pickVoxel pipeline";

function voxelUserPickVoxelPipelineName(info: VoxelUserShaderInfo): string {
  return `Voxel pickVoxel pipeline (userCustomShader#${info.hash.toString(16)})`;
}

/**
 * VOXEL-USER-CUSTOMSHADER — resolve (and cache, keyed by customShader object
 * identity) the generated user-WGSL chunk for this primitive's customShader.
 * Returns `null` when the primitive should keep the DEFAULT gray parity path:
 * no customShader / the DefaultCustomShader, a GLSL-only customShader
 * (warn + default — the model renderer's PARITY-CUSTOM-SHADER-WGSL policy),
 * or a WGSL customShader with uniforms (warn + default — voxel customShader
 * uniforms/textures are a documented follow-up).
 * @private
 */
function resolveVoxelUserShaderInfo(
  primitive: CesiumObjectWithWebGPUCache,
  cache: VoxelCache,
): VoxelUserShaderInfo | null {
  const prim = primitive as unknown as {
    customShader?: VoxelUserCustomShaderLike;
    provider?: VoxelProviderMetadataLike;
    constructor?: { DefaultCustomShader?: unknown };
  };
  const customShader = prim.customShader;
  // VoxelPrimitive substitutes DefaultCustomShader for an unset/cleared
  // customShader — that is the Batch 476 default gray path, not a user shader.
  const isDefault =
    !customShader || customShader === prim.constructor?.DefaultCustomShader;
  if (isDefault) {
    cache.userShaderRef = null;
    cache.userShaderInfo = null;
    return null;
  }
  if (cache.userShaderRef === customShader) {
    return cache.userShaderInfo;
  }
  cache.userShaderRef = customShader;
  cache.userShaderInfo = null;

  if (
    typeof customShader.wgslFragmentShaderText !== "string" ||
    customShader.wgslFragmentShaderText.length === 0
  ) {
    // GLSL-only voxel customShader — transpile is deferred by design; keep the
    // default gray rendering (the same policy as WebGPUModelRenderer).
    //>>includeStart('debug', pragmas.debug);
    oneTimeWarning(
      "WebGPUVoxel.customShader",
      "VoxelPrimitive.customShader with GLSL-only text is not supported on " +
        "the WebGPU backend (GLSL→WGSL transpile is deferred). Supply " +
        "wgslFragmentShaderText for a native-WGSL voxel customShader. The " +
        "GLSL is ignored; the voxel renders with the default gray shading. " +
        "Track VOXEL-USER-CUSTOMSHADER.",
    );
    //>>includeEnd('debug');
    return null;
  }

  if (voxelUserShaderHasUniforms(customShader)) {
    // Uniforms (incl. color-map SAMPLER_2D textures) need a voxel BGL /
    // pipeline-layout variant — a documented follow-up. Warn + default so the
    // primitive still renders (gray) rather than failing module compilation
    // on an undeclared `czm_customUniforms` reference.
    //>>includeStart('debug', pragmas.debug);
    oneTimeWarning(
      "WebGPUVoxel.customShaderUniforms",
      "VoxelPrimitive.customShader uniforms are not supported on the WebGPU " +
        "backend yet — the customShader is ignored and the voxel renders " +
        "with the default gray shading. Inline constants in the WGSL body " +
        "instead. Track VOXEL-USER-CUSTOMSHADER (uniforms follow-up).",
    );
    //>>includeEnd('debug');
    return null;
  }

  cache.userShaderInfo =
    generateVoxelUserShaderChunk(customShader, prim.provider) ?? null;
  return cache.userShaderInfo;
}

// PARITY-VOXEL-COLOR-PARITY scratches for the model-space light-direction pack.
const scratchMVNormal = new Matrix4();
const scratchMV3 = new Matrix3();
const scratchMV3Inv = new Matrix3();
const scratchLightModel = new Cartesian3();

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

// PARITY-VOXEL-SHAPE-PARITY (increment 2) scratches for building the effective
// model matrix from the shape's oriented bounding box.
const scratchObbHalfAxes = new Matrix3();
const scratchObbCenter = new Cartesian3();
const scratchEffModel = new Matrix4();

// VOXEL-SHAPEUV-CONVENTION scratches for composing the proxy→shapeUv matrix.
const scratchShapeTransformInv = new Matrix4();
const scratchProxyToLocal = new Matrix4();
const scratchUvScaleTranslate = new Matrix4();
const scratchProxyToShapeUv = new Matrix4();
const scratchUvScale = new Cartesian3();
const scratchConvBase = new Cartesian3();
const scratchConvAxis = new Cartesian3();

/**
 * Structural view of the parts of a {@link VoxelBoxShape}'s oriented bounding
 * box the ray-march placement needs. `center` is the box centre in world
 * (ECEF) coordinates; `halfAxes` is a {@link Matrix3} whose columns are the box
 * half-extent vectors (rotation × scale), so a point `p ∈ [-1, +1]^3` maps to
 * world via `center + halfAxes * p`.
 */
interface VoxelShapeLike {
  orientedBoundingBox?: {
    center?: Cartesian3;
    halfAxes?: Matrix3;
    // VOXEL-OCTREE-LOD — OrientedBoundingBox.distanceSquaredTo, used by the
    // SSE refine test (mirrors SpatialNode.computeScreenSpaceError).
    distanceSquaredTo?(point: Cartesian3): number;
  };
  // VOXEL-SHAPEUV-CONVENTION — the shape's compound local frame + its OWN
  // local→shapeUv conversion (VoxelBoxShape.convertLocalToShapeUvSpace), used
  // to compose the proxy→shapeUv matrix with WebGL-identical semantics rather
  // than re-deriving the boundScale formula here (single source of truth).
  shapeTransform?: Matrix4;
  convertLocalToShapeUvSpace?(
    positionLocal: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  // NEW-VOXEL-ELLIPSOID-INTERSECT — VoxelEllipsoidShape internals consumed by
  // the ellipsoid shell-intersection uniforms. `_ellipsoid` carries the
  // per-axis radii (the compound modelMatrix scale);
  // `_minimumHeight`/`_maximumHeight` are the shape's height bounds (bounds z)
  // relative to the ellipsoid surface.
  _ellipsoid?: { radii?: Cartesian3 };
  _minimumHeight?: number;
  _maximumHeight?: number;
  // NEW-VOXEL-ELLIPSOID-SHAPEUV — VoxelEllipsoidShape internals consumed by
  // the shapeUv mapping uniforms. `_shaderUniforms` carries the WebGL shader
  // uniform set (single source of truth for the lon/lat/height scale terms);
  // `_localToShapeUvTranslate` the JS-side lon/lat offsets; `_shaderDefines`
  // the ELLIPSOID_HAS_SHAPE_BOUNDS_* flags (value present = enabled,
  // undefined = disabled — the upstream convention).
  // NEW-VOXEL-CYLINDER-SHAPEUV — the cylinder* entries are the
  // VoxelCylinderShape analogues (radial/angle/height scale terms + render
  // radius bounds + the angle-range wrap origin).
  _shaderUniforms?: {
    ellipsoidLocalToShapeUvScale?: Cartesian3;
    ellipsoidShapeUvLongitudeRangeOrigin?: number;
    cylinderLocalToShapeUvScale?: Cartesian3;
    cylinderShapeUvAngleRangeOrigin?: number;
    cylinderRenderRadiusMinMax?: { x: number; y: number };
  };
  _localToShapeUvTranslate?: Cartesian3;
  _shaderDefines?: Record<string, unknown>;
  // NEW-VOXEL-CYLINDER-SHAPEUV — VoxelCylinderShape's height render bounds
  // live in its two renderBoundPlanes (plane 0: normal -z, distance =
  // renderMinBounds.z; plane 1: normal +z, distance = -renderMaxBounds.z);
  // `_minBounds`/`_maxBounds` are the unclipped shape bounds fallback.
  renderBoundPlanes?: { get(index: number): { distance: number } | undefined };
  _minBounds?: Cartesian3;
  _maxBounds?: Cartesian3;
}

/**
 * PARITY-VOXEL-SHAPE-PARITY (increment 2).
 *
 * Compute the effective model matrix that places the ray-march proxy cube at
 * the voxel volume's correct WORLD position, orientation, and extent — mirroring
 * the WebGL VoxelBoxShape convention.
 *
 * WebGL derives the shape's oriented bounding box from the compound model
 * matrix `globalTransform × modelMatrix × shapeTransform` (see
 * {@link updateShapeAndTransforms}). The box spans local `[-1, +1]^3`
 * (VoxelBoxShape.DefaultMin/MaxBounds), and the OBB maps that local box to world
 * via `world = center + halfAxes * localPos`.
 *
 * The WebGPU ray-march proxy cube is `[-0.5, +0.5]^3` (see
 * {@link createBoxGeometry}) and the shader normalises samples over
 * `minBounds = -0.5 … maxBounds = +0.5`. So to map the `[-0.5, +0.5]` cube onto
 * the same world box we scale the OBB half-axes by 2:
 *   `effModel = fromRotationTranslation(2 × halfAxes, center)`.
 *
 * This is the ONLY change from the Batch 474 data-upload path — the shader math,
 * the `[-0.5, +0.5]` cube geometry, and the `[-0.5, +0.5]` bounds are all
 * unchanged; only the model matrix fed into the existing RTE MVP + camera-to-
 * model transform changes. When no shape/OBB is available (no provider — the
 * placeholder gradient path), this returns the primitive's raw `modelMatrix`
 * unchanged, keeping the off-gate byte-identical with Batch 474.
 *
 * @returns the effective model matrix (scratch — do not retain across calls).
 */
function computeVoxelEffectiveModelMatrix(
  primitive: CesiumObjectWithWebGPUCache,
): Matrix4 {
  const rawModelMatrix =
    (primitive as unknown as { modelMatrix?: Matrix4 }).modelMatrix ??
    Matrix4.IDENTITY;

  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;
  const provider = (primitive as unknown as { _provider?: unknown })._provider;
  // Off-gate: no shape or no provider → keep the raw modelMatrix so the
  // placeholder path is byte-identical with Batch 474.
  if (!shape || !provider) {
    return rawModelMatrix;
  }

  // Scene Logic Extractor pattern — refresh the shape OBB from the current
  // modelMatrix / bounds BEFORE reading it. The WebGPU feature-renderer path
  // returns from VoxelPrimitive.update before the WebGL body runs these, so the
  // OBB would otherwise only reflect construction-time state.
  try {
    checkTransformAndBounds(primitive);
    updateShapeAndTransforms(primitive);
  } catch {
    // Shape update can throw if the volume is degenerate (zero scale, inverted
    // bounds). Fall back to the raw modelMatrix rather than crashing the frame.
    return rawModelMatrix;
  }

  const obb = shape.orientedBoundingBox;
  if (!obb || !obb.center || !obb.halfAxes) {
    return rawModelMatrix;
  }

  // Scale the half-axes by 2 so the [-0.5, +0.5] proxy cube spans the same
  // world box the [-1, +1] shape space maps to.
  const halfAxes2 = Matrix3.multiplyByScalar(
    obb.halfAxes,
    2.0,
    scratchObbHalfAxes,
  );
  const center = Cartesian3.clone(obb.center, scratchObbCenter);
  return Matrix4.fromRotationTranslation(halfAxes2, center, scratchEffModel);
}

/**
 * VOXEL-SHAPEUV-CONVENTION — pack the WebGL sample-frame convention into UBO
 * floats 76..103, mirroring the chain WebGL uses to derive the megatexture
 * sample coordinate:
 *
 *   shapeUv = boxLocalToShapeUvScale · (shapeTransform⁻¹ · world) + translate
 *             (VoxelBoxShape.convertLocalToShapeUvSpace / convertLocalToBoxUv.glsl)
 *   inputCoordinate = shapeUv · u_dimensions + u_paddingBefore, then the
 *             Y_UP_METADATA_ORDER + SHAPE_BOX axis swap/flip (Octree.glsl)
 *
 * The proxy→shapeUv affine is composed on the CPU as
 * `scaleTranslate(convertLocalToShapeUvSpace) · shapeTransform⁻¹ · effModel`
 * so the WGSL march applies ONE mat4 per sample. The scale/translate terms are
 * probed through the shape's own `convertLocalToShapeUvSpace` (an exact
 * componentwise affine for the box shape) so the WebGL implementation stays
 * the single source of truth for the convention.
 *
 * When the uploaded texture carries no convention (non-box shapes) — or the
 * shape transform is degenerate — falls back to the historical direct mapping
 * (`shapeUv = p + 0.5` over the texture's own extents, no padding/swap), which
 * is output-identical to the pre-convention sampling.
 */
function packVoxelSampleFrame(
  primitive: CesiumObjectWithWebGPUCache,
  effModel: Matrix4,
  cache: VoxelCache,
  data: Float32Array,
): void {
  const convention = cache.dataUpload?.convention ?? null;
  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;

  // NEW-VOXEL-ELLIPSOID-SHAPEUV — ELLIPSOID providers carry the sampling
  // convention (dimensions/padding/inputDimensions) but NOT the box affine:
  // their local→shapeUv map is nonlinear (lon/lat/height), evaluated per
  // sample in the WGSL (ellipsoidShapeUvFromLocal via the B22 proxyToLocal).
  // Probing convertLocalToShapeUvSpace with unit axes — the box path below —
  // would be meaningless (and NaN-prone at the origin) here, so write the
  // convention fields + an identity proxyToShapeUv (never read on the
  // ELLIPSOID branch of computeShapeUvReal) instead.
  // NEW-VOXEL-CYLINDER-SHAPEUV — CYLINDER shares the same treatment: its
  // radius/angle/height map is nonlinear too (cylinderShapeUvFromLocal).
  const providerShape = (
    primitive as unknown as { _provider?: { shape?: string } }
  )._provider?.shape;
  if (
    convention &&
    (providerShape === VoxelShapeType.ELLIPSOID ||
      providerShape === VoxelShapeType.CYLINDER)
  ) {
    data[76] = convention.dimensions.x;
    data[77] = convention.dimensions.y;
    data[78] = convention.dimensions.z;
    data[79] = convention.yUpBox ? 1 : 0;
    // Identity proxyToShapeUv (column-major diagonal) — unused by the
    // ellipsoid sample path but kept finite for safety.
    data[80] = 1;
    data[85] = 1;
    data[90] = 1;
    data[95] = 1;
    data[96] = convention.inputDimensions.x;
    data[97] = convention.inputDimensions.y;
    data[98] = convention.inputDimensions.z;
    data[100] = convention.paddingBefore.x;
    data[101] = convention.paddingBefore.y;
    data[102] = convention.paddingBefore.z;
    return;
  }

  if (
    convention &&
    shape &&
    shape.shapeTransform &&
    typeof shape.convertLocalToShapeUvSpace === "function"
  ) {
    try {
      const invShape = Matrix4.inverse(
        shape.shapeTransform,
        scratchShapeTransformInv,
      );
      const proxyToLocal = Matrix4.multiply(
        invShape,
        effModel,
        scratchProxyToLocal,
      );
      const base = shape.convertLocalToShapeUvSpace(
        Cartesian3.ZERO,
        scratchConvBase,
      );
      const tx = base.x;
      const ty = base.y;
      const tz = base.z;
      const sx =
        shape.convertLocalToShapeUvSpace(Cartesian3.UNIT_X, scratchConvAxis).x -
        tx;
      const sy =
        shape.convertLocalToShapeUvSpace(Cartesian3.UNIT_Y, scratchConvAxis).y -
        ty;
      const sz =
        shape.convertLocalToShapeUvSpace(Cartesian3.UNIT_Z, scratchConvAxis).z -
        tz;
      const st = Matrix4.fromScale(
        Cartesian3.fromElements(sx, sy, sz, scratchUvScale),
        scratchUvScaleTranslate,
      );
      st[12] = tx;
      st[13] = ty;
      st[14] = tz;
      const proxyToShapeUv = Matrix4.multiply(
        st,
        proxyToLocal,
        scratchProxyToShapeUv,
      );

      data[76] = convention.dimensions.x;
      data[77] = convention.dimensions.y;
      data[78] = convention.dimensions.z;
      data[79] = convention.yUpBox ? 1 : 0;
      Matrix4.pack(proxyToShapeUv, data, 80);
      data[96] = convention.inputDimensions.x;
      data[97] = convention.inputDimensions.y;
      data[98] = convention.inputDimensions.z;
      data[100] = convention.paddingBefore.x;
      data[101] = convention.paddingBefore.y;
      data[102] = convention.paddingBefore.z;
      return;
    } catch {
      // Degenerate shapeTransform (zero scale) — fall through to the direct
      // mapping rather than crashing the frame.
    }
  }

  // Fallback: direct proxy→uv mapping over the texture's own extents.
  const tex = cache.dataUpload?.texture ?? null;
  const w = tex ? tex.width : 1;
  const h = tex ? tex.height : 1;
  const d = tex ? tex.depthOrArrayLayers : 1;
  data[76] = w;
  data[77] = h;
  data[78] = d;
  data[79] = 0;
  // Identity rotation + 0.5 translation → shapeUv = p + 0.5 (column-major).
  data[80] = 1;
  data[85] = 1;
  data[90] = 1;
  data[92] = 0.5;
  data[93] = 0.5;
  data[94] = 0.5;
  data[95] = 1;
  data[96] = w;
  data[97] = h;
  data[98] = d;
  // paddingBefore stays zero.
}

// NEW-VOXEL-ELLIPSOID-INTERSECT scratches for composing the proxy→local
// matrix (separate from the VOXEL-SHAPEUV-CONVENTION scratches — both packs
// run in the same frame).
const scratchEllShapeTransformInv = new Matrix4();
const scratchEllProxyToLocal = new Matrix4();

/**
 * NEW-VOXEL-ELLIPSOID-INTERSECT — pack the shape-typed intersection fields
 * (floats 184..207): `proxyToLocal` (proxy-cube point → the shape's
 * ellipsoid-centered LOCAL frame in meters, `inverse(shapeTransform) ·
 * effModel`), the ellipsoid's per-axis radii, and the min/max height bounds —
 * the inputs WebGL's IntersectEllipsoid.glsl `intersectHeight()` consumes.
 * Only written for ELLIPSOID-shape providers; BOX providers (and any
 * degenerate/missing shape state) leave the floats zero, so `shapeType` stays
 * 0 and the WGSL takes the bit-identical `intersectAABB` branch — the
 * off-gate.
 *
 * NEW-VOXEL-ELLIPSOID-SHAPEUV also packs the lon/lat/height shapeUv mapping
 * terms (floats 208..215) here so per-cell content addressing runs WebGL's
 * convertLocalToShapeUvSpace chain in the WGSL (ellipsoidShapeUvFromLocal).
 *
 * NEW-VOXEL-CYLINDER-SHAPEUV — CYLINDER-shape providers pack `proxyToLocal` +
 * `shapeType = 2` the same way, reuse floats 204/205 for the height slab
 * (the renderBoundPlanes z bounds), and add the cylinder terms at floats
 * 216..227 (render radius min/max, angle-range origin, radial/angle/height
 * scale + offsets) — the inputs WebGL's IntersectCylinder.glsl /
 * VoxelCylinderShape.convertLocalToShapeUvSpace consume.
 */
function packVoxelShapeIntersect(
  primitive: CesiumObjectWithWebGPUCache,
  effModel: Matrix4,
  data: Float32Array,
): void {
  const provider = (primitive as unknown as { _provider?: { shape?: string } })
    ._provider;
  if (
    !provider ||
    (provider.shape !== VoxelShapeType.ELLIPSOID &&
      provider.shape !== VoxelShapeType.CYLINDER)
  ) {
    return;
  }
  if (provider.shape === VoxelShapeType.CYLINDER) {
    packVoxelCylinderIntersect(primitive, effModel, data);
    return;
  }
  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;
  const radii = shape?._ellipsoid?.radii;
  const minHeight = shape?._minimumHeight;
  const maxHeight = shape?._maximumHeight;
  if (
    !shape ||
    !shape.shapeTransform ||
    !radii ||
    typeof minHeight !== "number" ||
    typeof maxHeight !== "number" ||
    !(radii.x > 0 && radii.y > 0 && radii.z > 0)
  ) {
    return;
  }
  try {
    const invShape = Matrix4.inverse(
      shape.shapeTransform,
      scratchEllShapeTransformInv,
    );
    const proxyToLocal = Matrix4.multiply(
      invShape,
      effModel,
      scratchEllProxyToLocal,
    );
    Matrix4.pack(proxyToLocal, data, 184);
  } catch {
    // Degenerate shapeTransform — keep the zero-filled box fallback rather
    // than crashing the frame.
    return;
  }
  data[200] = radii.x;
  data[201] = radii.y;
  data[202] = radii.z;
  data[203] = 1; // shapeType = ELLIPSOID
  data[204] = minHeight;
  data[205] = maxHeight;

  // NEW-VOXEL-ELLIPSOID-SHAPEUV — lon/lat/height shapeUv mapping terms
  // (floats 208..215), read from the shape's OWN shader-uniform state so the
  // WebGL implementation (VoxelEllipsoidShape.update) stays the single source
  // of truth for the scale/offset formulas. The height scale falls back to
  // the direct 1/(maxHeight - minHeight) derivation when the shape hasn't
  // populated its shader uniforms yet (same quantity, same clamped bounds).
  const su = shape._shaderUniforms;
  const uvScale = su?.ellipsoidLocalToShapeUvScale;
  const uvTranslate = shape._localToShapeUvTranslate;
  const defines = shape._shaderDefines;
  const hasLonBounds =
    defines?.["ELLIPSOID_HAS_SHAPE_BOUNDS_LONGITUDE"] !== undefined;
  const hasLatBounds =
    defines?.["ELLIPSOID_HAS_SHAPE_BOUNDS_LATITUDE"] !== undefined;
  const thickness = maxHeight - minHeight;
  const fallbackHeightScale = thickness === 0 ? 0 : 1 / thickness;
  data[208] = uvScale ? uvScale.x : 0;
  data[209] = uvScale ? uvScale.y : 0;
  data[210] = uvScale ? uvScale.z : fallbackHeightScale;
  data[211] = su?.ellipsoidShapeUvLongitudeRangeOrigin ?? 0;
  data[212] = uvTranslate ? uvTranslate.x : 1;
  data[213] = uvTranslate ? uvTranslate.y : 1;
  data[214] = hasLonBounds ? 1 : 0;
  data[215] = hasLatBounds ? 1 : 0;
}

/**
 * NEW-VOXEL-CYLINDER-SHAPEUV — pack the CYLINDER shape-typed fields:
 * `proxyToLocal` (floats 184..199, shared with the ellipsoid block),
 * `shapeType = 2` (float 203), the height slab (floats 204/205 — read back
 * from the shape's two renderBoundPlanes, the same planes WebGL's
 * intersectBoundPlanes clips with; falls back to the unclipped shape z
 * bounds), and the cylinder-specific terms at floats 216..227 (render radius
 * min/max, shapeUv angle-range origin, radial/angle/height scale + offsets
 * from the shape's own shader-uniform state — WebGL's
 * VoxelCylinderShape.update stays the single source of truth for the
 * formulas). Any missing/degenerate shape state leaves the floats zero, so
 * `shapeType` stays 0 and the WGSL takes the bit-identical BOX branch — the
 * off-gate.
 */
function packVoxelCylinderIntersect(
  primitive: CesiumObjectWithWebGPUCache,
  effModel: Matrix4,
  data: Float32Array,
): void {
  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;
  const su = shape?._shaderUniforms;
  const radiusMinMax = su?.cylinderRenderRadiusMinMax;
  const uvScale = su?.cylinderLocalToShapeUvScale;
  const uvTranslate = shape?._localToShapeUvTranslate;
  if (
    !shape ||
    !shape.shapeTransform ||
    !radiusMinMax ||
    !uvScale ||
    !uvTranslate ||
    !(radiusMinMax.y > 0)
  ) {
    return;
  }
  // Height slab: renderBoundPlanes carry the RENDER (shape ∩ clip) z bounds
  // (plane 0 distance = renderMinZ, plane 1 distance = -renderMaxZ). Fall
  // back to the unclipped shape bounds, then the DefaultMin/MaxBounds z.
  let zMin = shape._minBounds ? shape._minBounds.z : -1;
  let zMax = shape._maxBounds ? shape._maxBounds.z : 1;
  const planes = shape.renderBoundPlanes;
  if (planes && typeof planes.get === "function") {
    const p0 = planes.get(0);
    const p1 = planes.get(1);
    if (p0 && typeof p0.distance === "number") {
      zMin = p0.distance;
    }
    if (p1 && typeof p1.distance === "number") {
      zMax = -p1.distance;
    }
  }
  if (!(zMax > zMin)) {
    return;
  }
  try {
    const invShape = Matrix4.inverse(
      shape.shapeTransform,
      scratchEllShapeTransformInv,
    );
    const proxyToLocal = Matrix4.multiply(
      invShape,
      effModel,
      scratchEllProxyToLocal,
    );
    Matrix4.pack(proxyToLocal, data, 184);
  } catch {
    // Degenerate shapeTransform — keep the zero-filled box fallback rather
    // than crashing the frame.
    return;
  }
  data[203] = 2; // shapeType = CYLINDER
  data[204] = zMin;
  data[205] = zMax;
  data[216] = radiusMinMax.x;
  data[217] = radiusMinMax.y;
  data[218] = su?.cylinderShapeUvAngleRangeOrigin ?? 0;
  data[220] = uvScale.x;
  data[221] = uvScale.y;
  data[222] = uvScale.z;
  data[224] = uvTranslate.x;
  data[225] = uvTranslate.y;
  data[226] = uvTranslate.z;
}

// VOXEL-OCTREE-LOD scratch for the SSE refine test.
const scratchObbScale = new Cartesian3();

/**
 * VOXEL-OCTREE-LOD / NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — decide this frame's
 * target octree level (0 = root, 1..2 = refine) with WebGL's refine test:
 * mirror {@link SpatialNode}'s `computeScreenSpaceError` for the ROOT tile —
 *
 *   sse = (screenHeight / sseDenominator) * (approximateVoxelSize / distance)
 *   approximateVoxelSize = 2 * maxComponent(scale(obb.halfAxes))
 *                        / minComponent(provider.dimensions)
 *
 * — then walk the refinement ladder: each level halves a node's
 * `approximateVoxelSize` (half the extent, same per-tile dimensions), so the
 * level-L SSE is `sse / 2^L`; descend while the CURRENT level's SSE still
 * meets `primitive.screenSpaceError` (VoxelTraversal descends exactly when a
 * node's SSE meets the primitive's target), capped at the deepest level with
 * ANY uploaded tile so the march never branches into an empty atlas. For
 * depth-1 (9-slot) atlases this reduces exactly to the shipped single refine
 * test — byte-identical behavior for `availableLevels < 3` providers.
 *
 * NEW-VOXEL-STREAMING-UPLOAD splits the ladder's CAP into two callers:
 * {@link computeVoxelTargetLevel} caps at the deepest UPLOADED level (what the
 * WGSL march may branch into this frame) while {@link computeVoxelDemandLevel}
 * caps at the atlas CAPACITY (what the camera is asking for — the signal that
 * drives demand-driven descendant uploads, independent of what has streamed
 * in so far).
 */
function computeVoxelRefinementLevel(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
  capLevel: number,
): number {
  if (capLevel <= 0) {
    return 0;
  }

  const camera = frameState.camera;
  const sseDenominator = camera?.frustum?.sseDenominator;
  if (!camera || typeof sseDenominator !== "number" || !(sseDenominator > 0)) {
    return 0;
  }

  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;
  const obb = shape?.orientedBoundingBox;
  if (!obb || !obb.center || !obb.halfAxes) {
    return 0;
  }

  const dims = state.convention?.dimensions;
  const minDim = dims ? Math.min(dims.x, dims.y, dims.z) : 1;
  const halfScale = Matrix3.getScale(obb.halfAxes, scratchObbScale);
  const maximumScale = 2.0 * Cartesian3.maximumComponent(halfScale);
  const approximateVoxelSize = maximumScale / Math.max(1, minDim);

  const cameraWC = camera.positionWC as unknown as Cartesian3;
  let distance;
  if (typeof obb.distanceSquaredTo === "function") {
    distance = Math.sqrt(obb.distanceSquaredTo(cameraWC));
  } else {
    distance = Cartesian3.distance(obb.center, cameraWC);
  }
  distance = Math.max(distance, 1e-7);

  const context = frameState.context;
  const pixelRatio = frameState.pixelRatio > 0 ? frameState.pixelRatio : 1;
  const screenHeight = context.drawingBufferHeight / pixelRatio;
  const sse =
    (screenHeight / sseDenominator) * (approximateVoxelSize / distance);

  const targetSse =
    (primitive as unknown as { screenSpaceError?: number }).screenSpaceError ??
    4.0;
  // Refinement ladder: descend while the current level's SSE (halving per
  // level) still meets the target, capped at the caller's level cap.
  let level = 0;
  let levelSse = sse;
  while (level < capLevel && levelSse >= targetSse) {
    level += 1;
    levelSse /= 2;
  }
  return level;
}

/**
 * VOXEL-OCTREE-LOD — the deepest octree level with ANY uploaded tile in the
 * atlas (0 = root only). The WGSL march must never branch into an empty slot,
 * so this caps the packed target level.
 */
function voxelMaxUploadedLevel(state: VoxelDataUploadState): number {
  if (state.slotCount < 9) {
    return 0;
  }
  let maxUploadedLevel = 0;
  for (let i = 0; i < 8; i++) {
    if (state.childSlots[i] >= 0) {
      maxUploadedLevel = 1;
      break;
    }
  }
  if (maxUploadedLevel === 0) {
    return 0;
  }
  // NEW-VOXEL-ATLAS-LRU-EVICT — any atlas with a level-2 pool (static 64 or
  // dynamic 1..63) can hold level-2 tiles; scan the slot indirection either
  // way. `slotCount >= 73` would miss the dynamic partial atlas.
  if (state.l2PoolSize > 0) {
    for (let i = 0; i < 64; i++) {
      if (state.l2Slots[i] >= 0) {
        maxUploadedLevel = 2;
        break;
      }
    }
  }
  if (maxUploadedLevel < 2) {
    return maxUploadedLevel;
  }
  // NEW-VOXEL-OCTREE-DEEP-LEVELS — the static deep-3 atlas (l3PoolSize > 0)
  // can hold level-3 tiles; if any is uploaded the walk may descend to 3.
  if (state.l3PoolSize > 0) {
    for (let i = 0; i < 512; i++) {
      if (state.l3Slots[i] >= 0) {
        maxUploadedLevel = 3;
        break;
      }
    }
  }
  return maxUploadedLevel;
}

/**
 * VOXEL-OCTREE-LOD / NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — this frame's UBO target
 * level: the SSE ladder capped at the deepest UPLOADED level. Identical math
 * to the pre-streaming implementation (the ladder + uploaded-cap were fused).
 */
function computeVoxelTargetLevel(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
): number {
  return computeVoxelRefinementLevel(
    primitive,
    frameState,
    state,
    voxelMaxUploadedLevel(state),
  );
}

/**
 * NEW-VOXEL-STREAMING-UPLOAD — this frame's DEMAND level: the SSE ladder
 * capped only by the atlas CAPACITY (1 for the 9-slot depth-1 atlas, 2 for
 * the 73-slot deep atlas), independent of which tiles have uploaded. Drives
 * {@link tryUploadChildVoxelTiles}: descendant levels are requested/uploaded
 * only while the camera demands them (upstream VoxelTraversal megatexture-add
 * semantics).
 */
function computeVoxelDemandLevel(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
): number {
  // NEW-VOXEL-ATLAS-LRU-EVICT — a dynamic partial atlas (slotCount 10..72,
  // l2PoolSize > 0) has level-2 CAPACITY too: demand drives tiles through the
  // LRU pool. Static atlases keep the historical 73→2 / 9→1 mapping exactly.
  // NEW-VOXEL-OCTREE-DEEP-LEVELS — the static deep-3 atlas has level-3
  // CAPACITY (l3PoolSize = 512), so the demand ladder may ask for level 3.
  const capacity =
    state.l3PoolSize > 0
      ? 3
      : state.l2PoolSize > 0
        ? 2
        : state.slotCount >= 9
          ? 1
          : 0;
  return computeVoxelRefinementLevel(primitive, frameState, state, capacity);
}

// NEW-VOXEL-ATLAS-LRU-EVICT scratches for the per-tile level-2 demand mask.
const scratchL2DemandMask = new Uint8Array(64);
const scratchL2ObbScale = new Cartesian3();
const scratchL2TileLocal = new Cartesian3();
const scratchL2TileCenter = new Cartesian3();

/**
 * NEW-VOXEL-ATLAS-LRU-EVICT — per-tile demand mask over the 64 level-2 tiles
 * (linear index x + 4y + 16z, Z-up shape frame), computed only when the
 * level-2 pool is DYNAMIC (capacity < 64 tiles) and the camera's ladder
 * demands level 2. A tile is demanded when it passes BOTH:
 *
 *   1. the frustum test — the tile's bounding sphere (OBB subregion center,
 *      conservative radius) intersects `frameState.cullingVolume`
 *      (CullingVolume.computeVisibility's sphere-vs-plane test), and
 *   2. the per-tile SSE gate — the level-2 ladder test with the TILE's own
 *      distance: `(screenHeight / sseDenominator) * (tileVoxelSize / dist)
 *      >= screenSpaceError`, where `tileVoxelSize` is the root
 *      approximateVoxelSize quartered (two halvings) and `dist` is the
 *      camera-to-tile-sphere distance.
 *
 * This mirrors upstream VoxelTraversal, which only visits (and megatexture-
 * adds) nodes that are visible AND fail the parent's SSE test — residency in
 * the LRU pool follows the camera. Returns null on the static paths (mask
 * unused — byte-identical B19 flow) and an all-zero mask when the camera /
 * shape state is unavailable.
 */
function computeVoxelL2DemandMask(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
  state: VoxelDataUploadState,
  demandLevel: number,
): Uint8Array | null {
  if (!state.l2Dynamic || demandLevel < 2) {
    return null;
  }
  const mask = scratchL2DemandMask;
  mask.fill(0);

  const camera = frameState.camera;
  const sseDenominator = camera?.frustum?.sseDenominator;
  if (!camera || typeof sseDenominator !== "number" || !(sseDenominator > 0)) {
    return mask;
  }
  const shape = (primitive as unknown as { _shape?: VoxelShapeLike })._shape;
  const obb = shape?.orientedBoundingBox;
  if (!obb || !obb.center || !obb.halfAxes) {
    return mask;
  }

  const dims = state.convention?.dimensions;
  const minDim = dims ? Math.min(dims.x, dims.y, dims.z) : 1;
  const halfScale = Matrix3.getScale(obb.halfAxes, scratchL2ObbScale);
  const rootVoxelSize =
    (2.0 * Cartesian3.maximumComponent(halfScale)) / Math.max(1, minDim);
  // Level 2 = two halvings of the root approximateVoxelSize (same ladder as
  // computeVoxelRefinementLevel), evaluated at the TILE's own distance.
  const tileVoxelSize = rootVoxelSize / 4.0;
  // Conservative bounding-sphere radius of a level-2 OBB subregion (quarter
  // extent per axis).
  const tileRadius = Cartesian3.magnitude(halfScale) / 4.0;

  const context = frameState.context;
  const pixelRatio = frameState.pixelRatio > 0 ? frameState.pixelRatio : 1;
  const screenHeight = context.drawingBufferHeight / pixelRatio;
  const targetSse =
    (primitive as unknown as { screenSpaceError?: number }).screenSpaceError ??
    4.0;
  const cameraWC = camera.positionWC as unknown as Cartesian3;
  const planes = frameState.cullingVolume?.planes;

  for (let i = 0; i < 64; i++) {
    const tx = i & 3;
    const ty = (i >> 2) & 3;
    const tz = (i >> 4) & 3;
    // Tile center in the OBB's local [-1, 1]^3 frame: shapeUv (tc + 0.5) / 4
    // mapped through uv * 2 - 1.
    scratchL2TileLocal.x = (tx + 0.5) / 2.0 - 1.0;
    scratchL2TileLocal.y = (ty + 0.5) / 2.0 - 1.0;
    scratchL2TileLocal.z = (tz + 0.5) / 2.0 - 1.0;
    const center = Matrix3.multiplyByVector(
      obb.halfAxes,
      scratchL2TileLocal,
      scratchL2TileCenter,
    );
    Cartesian3.add(obb.center, center, center);

    // Frustum gate — CullingVolume.computeVisibility's sphere test: outside
    // when any plane's signed distance to the center is < -radius.
    if (planes && planes.length >= 6) {
      let outside = false;
      for (let p = 0; p < planes.length; p++) {
        const pl = planes[p];
        if (
          pl.x * center.x + pl.y * center.y + pl.z * center.z + pl.w <
          -tileRadius
        ) {
          outside = true;
          break;
        }
      }
      if (outside) {
        continue;
      }
    }

    // Per-tile SSE gate at the tile-sphere distance.
    const dist = Math.max(
      Cartesian3.distance(center, cameraWC) - tileRadius,
      1e-7,
    );
    const sse = (screenHeight / sseDenominator) * (tileVoxelSize / dist);
    if (sse >= targetSse) {
      mask[i] = 1;
    }
  }
  return mask;
}

function createBoxGeometry(device: GPUDevice): {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
} {
  // Unit cube [-0.5, 0.5]^3 — will be scaled by model matrix
  const h = 0.5;
  const positions = new Float32Array([
    // Each vertex needs posHigh + posLow (for now, posLow = 0)
    -h,
    -h,
    -h,
    0,
    0,
    0,
    h,
    -h,
    -h,
    0,
    0,
    0,
    h,
    h,
    -h,
    0,
    0,
    0,
    -h,
    h,
    -h,
    0,
    0,
    0,
    -h,
    -h,
    h,
    0,
    0,
    0,
    h,
    -h,
    h,
    0,
    0,
    0,
    h,
    h,
    h,
    0,
    0,
    0,
    -h,
    h,
    h,
    0,
    0,
    0,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0,
    3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  const vb = device.createBuffer({
    size: positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vb, 0, positions);
  const ib = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ib, 0, indices);
  return { vertexBuffer: vb, indexBuffer: ib };
}

function createPlaceholderVoxelTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const size = 4;
  const texture = device.createTexture({
    size: { width: size, height: size, depthOrArrayLayers: size },
    format: "rgba8unorm",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Fill with gradient for placeholder visibility
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (z * size * size + y * size + x) * 4;
        data[idx] = Math.floor((x / size) * 255);
        data[idx + 1] = Math.floor((y / size) * 255);
        data[idx + 2] = Math.floor((z / size) * 255);
        data[idx + 3] = 128; // semi-transparent
      }
    }
  }
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return { texture, view: texture.createView() };
}

/**
 * Resolve the color + pick pipelines through the central pipeline cache.
 * If the cache is unavailable, falls back to direct
 * `device.createRenderPipeline()` so behavior remains unchanged.
 *
 * Returns synchronously when both pipelines are already cached; otherwise
 * kicks off async creation and returns false so the caller can skip the
 * frame and try again next tick.
 *
 * C-R7-RENDERER-MIGRATION (Batch 72). Mirrors the
 * `tryResolveEllipsoidPipelines` pattern from Batch 56.
 */
function tryResolveVoxelPipelines(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: VoxelCache,
): boolean {
  if (cache.pipeline && cache.pickPipeline) {
    return true;
  }
  const colorDesc = cache.colorDescriptor;
  const pickDesc = cache.pickDescriptor;
  if (!colorDesc || !pickDesc) {
    return false;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(colorDesc);
    const pickSync = pipelineCache.getPipelineSync(pickDesc);
    if (colorSync && pickSync) {
      cache.pipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(colorDesc),
        pipelineCache.getPipeline(pickDesc),
      ])
        .then(([color, pick]) => {
          cache.pipeline = color;
          cache.pickPipeline = pick;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache. Mirror the historical synchronous path.
  cache.pipeline = device.createRenderPipeline(toGPUDescriptor(colorDesc));
  cache.pickPipeline = device.createRenderPipeline(toGPUDescriptor(pickDesc));
  return true;
}

function toGPUDescriptor(
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

function updateWebGPUVoxelPrimitive(
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
      pickPipeline: null,
      shaderModule: null,
      bindGroup: null,
      vertexBuffer: null,
      indexBuffer: null,
      voxelTexture: null,
      voxelTextureView: null,
      sampler: null,
      command: null,
      pickCommand: null,
      initialized: false,
      pipelineRequestPending: false,
      colorDescriptor: null,
      pickDescriptor: null,
      // Batch 173 - velocity slots (lazy, allocated when TAA is on).
      velocityPipeline: null,
      velocityDescriptor: null,
      velocityPipelineRequestPending: false,
      // PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1) — real-data upload state.
      dataUpload: null,
      usingRealData: false,
      bindGroupLayout: null,
      // PARITY-VOXEL-COLOR-PARITY — color-parity pipeline rebuild slots.
      pipelineLayout: null,
      colorModuleCustomShader: null,
      // VOXEL-USER-CUSTOMSHADER — user native-WGSL customShader slots.
      userShaderRef: null,
      userShaderInfo: null,
      // C-R9-VOXEL-CELL-PICK — per-cell pick slots (lazy, real-data only).
      pickVoxelPipeline: null,
      pickVoxelDescriptor: null,
      pickVoxelPipelineRequestPending: false,
      pickVoxelCommand: null,
    } as VoxelCache;
  }

  const cache = primitive._webgpuCache as VoxelCache;
  // Batch 110 — voxels draw into scene FB; use scenePipelineFormat.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);

  // NEW-PICK-METADATA-READBACK (Batch 285) — the color pipeline draws into the
  // MSAA scene framebuffer, so it MUST bake `multisample.count =
  // context._msaaSamples` like every other scene-FB renderer
  // (WebGPUEllipsoidPrimitiveRenderer / BufferPoint / Cloud / ComputeInstance,
  // etc.). It was previously left at the default count:1, so on any MSAA scene
  // (the default msaaSamples is 4) WebGPU dropped every voxel color draw with
  // "Attachment state of [Voxel color pipeline] is not compatible with [Scene
  // Framebuffer Render Pass]" — the voxel never rendered, so pickVoxel had no
  // pixel to read back. Pick + velocity stay single-sample (pick FBO and the
  // velocity target are single-sample). The cache invalidates on sample-count
  // change as well as format change so a mid-session msaaSamples toggle
  // rebuilds the descriptor.
  const sceneSampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;

  // Batch 110 — invalidate cached pipeline on scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  const prevSampleCount = (
    cache as unknown as { _pipelineSampleCount?: number }
  )._pipelineSampleCount;
  if (
    cache.initialized &&
    ((cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen ||
      (prevSampleCount !== undefined && prevSampleCount !== sceneSampleCount))
  ) {
    cache.initialized = false;
    cache.pipeline = null;
    cache.pickPipeline = null;
    cache.colorDescriptor = null;
    cache.pickDescriptor = null;
    cache.pipelineRequestPending = false;
    cache.command = null;
    cache.pickCommand = null;
    // Batch 173 - velocity pipeline references the same shader module
    // built against the now-invalid format; force rebuild.
    cache.velocityPipeline = null;
    cache.velocityDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    // C-R9-VOXEL-CELL-PICK — same treatment for the per-cell pick variant.
    cache.pickVoxelPipeline = null;
    cache.pickVoxelDescriptor = null;
    cache.pickVoxelPipelineRequestPending = false;
    cache.pickVoxelCommand = null;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (
      cache as unknown as { _pipelineSampleCount?: number }
    )._pipelineSampleCount = sceneSampleCount;
  }

  if (!cache.initialized) {
    // Batch 173 - UBO grew 256 → 320 bytes to include the model matrix
    // (floats 56-71 at byte offset 224). VOXEL-SHAPEUV-CONVENTION grew it
    // 320 → 432 bytes for the WebGL sample-frame fields (floats 76-107:
    // dimensions + Y-up flag, proxy→shapeUv matrix, inputDimensions,
    // paddingBefore, proxy-space camera) consumed by the real-data
    // color-parity march. VOXEL-OCTREE-LOD grew it 432 → 480 bytes for the
    // depth-1 octree fields (floats 108-119: per-child atlas slots + slot
    // count + target LOD level). NEW-VOXEL-OCTREE-DEEP-TRAVERSAL grew it
    // 480 → 736 bytes for the 64 level-2 atlas slots (floats 120-183) read by
    // the iterative octree walk. NEW-VOXEL-ELLIPSOID-INTERSECT grew it
    // 736 → 832 bytes for the shape-typed intersection fields (floats
    // 184-207: proxyToLocal + ellipsoidRadii/shapeType + heightMinMax).
    // NEW-VOXEL-ELLIPSOID-SHAPEUV grew it 832 → 864 bytes for the ellipsoid
    // lon/lat/height shapeUv mapping terms (floats 208-215).
    // NEW-VOXEL-CYLINDER-SHAPEUV grew it 864 → 912 bytes for the cylinder
    // radius/angle/height terms (floats 216-227). NEW-VOXEL-OCTREE-DEEP-LEVELS
    // grew it 912 -> 2960 bytes for the 512 level-3 atlas slots (floats
    // 228-739) read by the iterative octree walk when it descends to level 3.
    cache.uniformBuffer = device.createBuffer({
      size: 2960,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // VOXEL-SHAPEUV-CONVENTION — honour VoxelPrimitive.nearestSampling
    // (parity: WebGL selects the megatexture's nearest-vs-linear sampler from
    // the same flag). Default is false → linear, the historical behaviour.
    const nearestSampling =
      (primitive as unknown as { nearestSampling?: boolean })
        .nearestSampling === true;
    cache.sampler = device.createSampler({
      magFilter: nearestSampling ? "nearest" : "linear",
      minFilter: nearestSampling ? "nearest" : "linear",
    });

    const { texture, view } = createPlaceholderVoxelTexture(device);
    cache.voxelTexture = texture;
    cache.voxelTextureView = view;

    // C-R7-SHADER-MODULE-DEDUP (Batch 72) — route module compilation
    // through the per-device shader module cache.
    const moduleCache = getVoxelShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.VOXEL_PRIMITIVE,
      VOXEL_WGSL,
      0,
      "VoxelPrimitive",
    );
    cache.shaderModule = shaderModule;

    const bgl = makeBindGroupLayout(device, "Voxel BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      textureEntry(1, Stage.FRAGMENT, { viewDimension: "3d" }),
      sampler(2, Stage.FRAGMENT),
    ]);
    // Retain for the real-data bind-group rebuild once the root tile uploads.
    cache.bindGroupLayout = bgl;

    // FEAT-GAP-09 (Batch 100) — append the shared effects bind group
    // layout so the WGSL fog block at `@group(1)` resolves to the same
    // 480-byte UBO + aerial-LUT textures the globe and Mat shaders use.
    // The pipeline cache keys on the descriptor, so adding the BGL is
    // safe — a fresh pipeline will be built once and reused.
    const effectsBGL = getEffectsBindGroupLayout(device);

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bgl, effectsBGL],
    });
    // PARITY-VOXEL-COLOR-PARITY — retain for the color-parity pipeline rebuild
    // once the real root tile uploads (same BGLs → same layout).
    cache.pipelineLayout = pipelineLayout;

    // Shared vertex stage — color + pick run identical vertex work
    // (RTE box vertex transform). Only the fragment entry differs.
    const vertexBuffers = [
      {
        arrayStride: 24,
        attributes: [
          {
            shaderLocation: 0,
            offset: 0,
            format: "float32x3" as GPUVertexFormat,
          },
          {
            shaderLocation: 1,
            offset: 12,
            format: "float32x3" as GPUVertexFormat,
          },
        ],
      },
    ];

    // C-R7-RENDERER-MIGRATION (Batch 72) — descriptor-only construction;
    // pipelines materialize through `webgpuPipelineCache` so two
    // VoxelPrimitives sharing the same descriptor share a single
    // `GPURenderPipeline`.
    cache.colorDescriptor = {
      name: "Voxel color pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        // Slice 5c-B Phase 1 (Batch 112) — scene-FB color target via
        // helper. Pick (line ~775, manually constructed with same
        // canvasFormat) and velocity (line ~800, rg16float) pipelines
        // stay single-target.
        targets: makeSceneFBTargets(canvasFormat, {
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
            },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }),
      },
      primitive: { topology: "triangle-list", cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness.
        depthCompare: "less-equal",
      },
      // Match the MSAA scene framebuffer's sample count (NEW-PICK-METADATA-READBACK).
      multisample:
        sceneSampleCount > 1 ? { count: sceneSampleCount } : undefined,
    };

    // C-R9-VOXEL-PICK (Batch 53) — pick pipeline. Same layout, same
    // vertex stage, same depth behaviour. Fragment entry emits
    // u.pickColor unmodified — NO blending, so the pick FBO readback
    // can map the color back to the registered pick target. cullMode
    // matches the color path so picking and shading agree on which
    // box face the ray enters from.
    cache.pickDescriptor = {
      name: "Voxel pick pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentPickMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    };

    // C-R9-VOXEL-CELL-PICK — per-cell pick descriptor. Same layout / vertex
    // stage / depth behaviour / single-sample target as the object-pick
    // descriptor above; the fragment entry packs {megatextureIndex,
    // sampleIndex} per WebGL's VoxelFS.glsl PICKING_VOXEL branch instead of
    // emitting u.pickColor. NO blending — the packed bytes must reach the
    // pick FBO exactly for Scene.pickVoxel's 255*R+G / 255*B+A decode.
    // Descriptor-only here (a plain object); the PIPELINE is resolved lazily
    // and only on the real-data path (see attachVoxelCellPickCommand).
    cache.pickVoxelDescriptor = {
      name: VOXEL_PICKVOXEL_PIPELINE_NAME,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentPickVoxelMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    };

    // Batch 173 - velocity descriptor. Same layout / vertex stage as
    // color (the box geometry is unchanged); different VS entry point
    // that computes curr + prev clip, and FS entry emitting
    // (currNdc - prevNdc) to rg16float.
    cache.velocityDescriptor = {
      name: "Voxel velocity pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexVelocityMain",
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentVelocityMain",
        targets: [{ format: "rg16float" as GPUTextureFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    };

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer } },
        { binding: 1, resource: cache.voxelTextureView! },
        { binding: 2, resource: cache.sampler! },
      ],
    });

    const geom = createBoxGeometry(device);
    cache.vertexBuffer = geom.vertexBuffer;
    cache.indexBuffer = geom.indexBuffer;

    // Stamp the generation + sample count this descriptor was built against so
    // the invalidation block above rebuilds on a later format / MSAA change
    // (NEW-PICK-METADATA-READBACK).
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (
      cache as unknown as { _pipelineSampleCount?: number }
    )._pipelineSampleCount = sceneSampleCount;

    cache.initialized = true;
  }

  // PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1) — drive the one-time root
  // voxel-tile upload. When no provider is present this returns false every
  // frame and the placeholder gradient stays bound (off-gate byte-identical).
  // When the root tile finishes uploading, swap binding 1 to the real-data
  // texture view and re-point every cached command's bind group. The
  // ray-march WGSL is unchanged — only the 3D texture SOURCE changes.
  if (!cache.usingRealData) {
    if (!cache.dataUpload) {
      cache.dataUpload = createVoxelDataUploadState();
    }
    const uploaded = tryUploadRootVoxelTile(
      device,
      primitive,
      frameState,
      cache.dataUpload,
    );
    if (
      uploaded &&
      cache.dataUpload.view &&
      cache.bindGroupLayout &&
      cache.uniformBuffer &&
      cache.sampler
    ) {
      cache.voxelTextureView = cache.dataUpload.view;
      cache.bindGroup = device.createBindGroup({
        label: "Voxel bind group (real data)",
        layout: cache.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cache.uniformBuffer } },
          { binding: 1, resource: cache.dataUpload.view },
          { binding: 2, resource: cache.sampler },
        ],
      });
      // Force the cached commands to pick up the rebuilt bind group at slot 0.
      cache.command = null;
      cache.pickCommand = null;
      // C-R9-VOXEL-CELL-PICK — cannot exist before usingRealData, but reset
      // for symmetry so a future multi-upload path rebinds it too.
      cache.pickVoxelCommand = null;
      cache.usingRealData = true;
    }
  }

  // VOXEL-OCTREE-LOD — once the root is bound, drive the asynchronous
  // descendant-tile uploads into atlas slots 1..8 (+9..72 on the deep atlas).
  // No-op for single-level providers (childPhase === "none") and once every
  // tile has settled; writes land in the already-bound atlas texture, so no
  // bind-group rebuild is needed.
  // NEW-VOXEL-STREAMING-UPLOAD — uploads are keyed to the camera's SSE demand
  // level (capacity-capped, NOT uploaded-capped): a far camera keeps a
  // root-only atlas, zooming in streams level-1 (then level-2) tiles in on
  // demand — upstream VoxelTraversal megatexture-add semantics. `demandLevel`
  // is recorded on the state as a probe-readable diagnostic.
  // NEW-VOXEL-ATLAS-LRU-EVICT — on a dynamic (capacity-capped) level-2 pool,
  // the per-tile demand mask (SSE + frustum) decides WHICH tiles occupy the
  // LRU slots; null on the static paths (mask ignored — byte-identical B19
  // flow).
  if (cache.usingRealData && cache.dataUpload) {
    const du = cache.dataUpload;
    const demandLevel = computeVoxelDemandLevel(primitive, frameState, du);
    du.demandLevel = demandLevel;
    const l2Mask = computeVoxelL2DemandMask(
      primitive,
      frameState,
      du,
      demandLevel,
    );
    tryUploadChildVoxelTiles(
      device,
      primitive,
      frameState,
      du,
      demandLevel,
      l2Mask,
    );
  }

  // PARITY-VOXEL-COLOR-PARITY — once a REAL voxel provider's root tile is
  // bound, the COLOR pipeline must use the VOXEL_CUSTOM_SHADER_COLOR define so
  // the ray-march applies the default voxel customShader colour mapping +
  // WebGL-matching front-to-back accumulation (matching the gray
  // VoxelBox3DTiles appearance) instead of the raw-texel integral. The pick +
  // velocity pipelines keep defines=0 (they don't colour-accumulate), and the
  // placeholder / no-provider path never sets `usingRealData` so its module
  // stays defines=0 → off-gate byte-identical. Applied here (not inside the
  // one-shot upload block) so a mid-session format/MSAA rebuild — which resets
  // `colorDescriptor` back to the base module — re-patches to the parity
  // module. The name check makes it idempotent + zero-cost per steady frame.
  // VOXEL-USER-CUSTOMSHADER — when the primitive carries a USER native-WGSL
  // customShader, the desired module is the generated chunk + VOXEL_WGSL with
  // the nested VOXEL_USER_CUSTOM_SHADER define; otherwise the Batch 476
  // default-gray parity module. The name compare keeps this idempotent +
  // zero-cost per steady frame, and also handles a MID-SESSION customShader
  // swap/clear (the desired name changes → re-patch in either direction).
  if (cache.usingRealData && cache.colorDescriptor) {
    const userInfo = resolveVoxelUserShaderInfo(primitive, cache);
    const desiredName = userInfo
      ? voxelUserShaderPipelineName(userInfo)
      : VOXEL_COLOR_PARITY_PIPELINE_NAME;
    if (cache.colorDescriptor.name !== desiredName) {
      const moduleCache = getVoxelShaderModuleCache(device);
      let colorModule: GPUShaderModule;
      if (userInfo) {
        colorModule = moduleCache.getOrCreate(
          ShaderSourceId.VOXEL_PRIMITIVE,
          userInfo.chunk + VOXEL_WGSL,
          ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR |
            ShaderDefine.VOXEL_USER_CUSTOM_SHADER,
          `VoxelPrimitive (user customShader #${userInfo.hash.toString(16)})`,
          // Bits ≥ 24 are masked out of the numeric cache key, so the salt is
          // what distinguishes this module from BOTH the defines=0 placeholder
          // and the default parity module (salt = bit-25 constant). The chunk
          // hash also separates DIFFERENT user shader bodies (DP-H46b).
          userInfo.hash,
        );
      } else {
        colorModule =
          cache.colorModuleCustomShader ??
          moduleCache.getOrCreate(
            ShaderSourceId.VOXEL_PRIMITIVE,
            VOXEL_WGSL,
            ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR,
            "VoxelPrimitive (VOXEL_CUSTOM_SHADER_COLOR)",
            // The module-cache numeric key masks defines to 24 bits
            // (`(defines & 0xffffff) << 8`), so VOXEL_CUSTOM_SHADER_COLOR
            // (bit 25) would alias the defines=0 (placeholder) module and
            // return the raw-texel shader. A non-zero keySalt forces a
            // distinct cache entry; the preprocessor still receives the
            // UNMASKED defines and emits the parity branch. (The salt value
            // is arbitrary but stable.)
            ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR,
          );
        cache.colorModuleCustomShader = colorModule;
      }
      // Re-point the color descriptor's vertex + fragment stages at the
      // custom-shader module. The vertex entry (`vertexMain`) preprocesses
      // identically (no gated vertex code), so reusing the same module for
      // both stages keeps the pipeline single-module.
      cache.colorDescriptor.vertex.module = colorModule;
      if (cache.colorDescriptor.fragment) {
        cache.colorDescriptor.fragment.module = colorModule;
      }
      // The central pipeline cache keys on `descriptor.name` (+ format/MSAA),
      // NOT on the shader-module identity — so the patched-module descriptor
      // MUST get a distinct name or it would collide with the placeholder
      // "Voxel color pipeline" entry and be served the old raw-texel pipeline.
      cache.colorDescriptor.name = desiredName;
      // Force the color pipeline to re-resolve from the patched descriptor,
      // and drop the cached draw command so it's rebuilt referencing the NEW
      // pipeline (the command captures `cache.pipeline` at construction —
      // leaving it stale would keep drawing with the old raw-texel pipeline).
      cache.pipeline = null;
      cache.pipelineRequestPending = false;
      cache.command = null;
    }

    // NEW-VOXEL-PICK-OCTREE-COMPOSE — the per-cell pick module must carry the
    // SAME user chunk + defines as the color module so the pick winner gate
    // matches the displayed surface (fragmentPickVoxelMain's
    // VOXEL_USER_CUSTOM_SHADER branch accumulates voxelMaterial.alpha; the
    // else branch keeps the default density gate). The getOrCreate call is
    // identical to the color one, so the module cache serves the SAME
    // GPUShaderModule — only the pipeline (entry point) differs. Reverts to
    // the base defines=0 module when the customShader is cleared mid-session.
    // The name compare keeps this idempotent AND keeps the DEFAULT path
    // untouched: with no user shader the desired name equals the init-time
    // literal, so no patch, no pipeline churn — off-gate byte-identical.
    if (cache.pickVoxelDescriptor && cache.shaderModule) {
      const desiredPickName = userInfo
        ? voxelUserPickVoxelPipelineName(userInfo)
        : VOXEL_PICKVOXEL_PIPELINE_NAME;
      if (cache.pickVoxelDescriptor.name !== desiredPickName) {
        const moduleCache = getVoxelShaderModuleCache(device);
        const pickModule = userInfo
          ? moduleCache.getOrCreate(
              ShaderSourceId.VOXEL_PRIMITIVE,
              userInfo.chunk + VOXEL_WGSL,
              ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR |
                ShaderDefine.VOXEL_USER_CUSTOM_SHADER,
              `VoxelPrimitive (user customShader #${userInfo.hash.toString(16)})`,
              userInfo.hash,
            )
          : cache.shaderModule;
        cache.pickVoxelDescriptor.vertex.module = pickModule;
        if (cache.pickVoxelDescriptor.fragment) {
          cache.pickVoxelDescriptor.fragment.module = pickModule;
        }
        // The central pipeline cache keys on `descriptor.name` — the patched
        // descriptor MUST get a distinct name or it would be served the
        // density-gate pipeline cached under the base name.
        cache.pickVoxelDescriptor.name = desiredPickName;
        // Re-resolve the pipeline + rebuild the command from the patched
        // descriptor (the command captures the pipeline at construction).
        cache.pickVoxelPipeline = null;
        cache.pickVoxelPipelineRequestPending = false;
        cache.pickVoxelCommand = null;
      }
    }
  }

  // C-R7-RENDERER-MIGRATION (Batch 72) — resolve color + pick pipelines
  // through the central cache. Skip the draw on not-yet-ready frames so
  // we never enqueue commands with null pipelines.
  if (!cache.pipeline || !cache.pickPipeline) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    if (
      !tryResolveVoxelPipelines(
        device,
        ctxAny.webgpuPipelineCache ?? null,
        cache,
      )
    ) {
      return;
    }
  }

  // Pack uniforms.
  //
  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  const us = context.uniformState;
  // PARITY-VOXEL-SHAPE-PARITY (increment 2) — use the shape/OBB-derived
  // effective model matrix so the proxy cube is placed at the voxel volume's
  // correct world position/orientation/extent (mirrors WebGL VoxelBoxShape).
  // Falls back to the raw modelMatrix in the off-gate (no provider) case, which
  // keeps the placeholder path byte-identical with Batch 474.
  const modelMatrix = computeVoxelEffectiveModelMatrix(primitive);
  const view = us.view;
  const projection = us.projection;
  const mvRte = Matrix4.multiply(view, modelMatrix, scratchMVRTE);
  mvRte[12] = 0;
  mvRte[13] = 0;
  mvRte[14] = 0;
  const mvp = m4Values(Matrix4.multiply(projection, mvRte, scratchMVP));

  const camWorld = us.cameraPosition;
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncoded);

  // C-R9-VOXEL-PICK (Batch 53 / refactored Batch 59) — pick ID lifecycle
  // delegated to {@link ensurePickId}. Per-cell / per-tile pick is a
  // separate follow-up (C-R9-VOXEL-CELL-PICK).
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

  // UBO layout (224 bytes = 56 floats):
  //   [ 0..15] mvpRelativeToEye        (mat4)
  //   [16..19] encodedCameraHigh + pad
  //   [20..23] encodedCameraLow  + pad
  //   [24..27] minBounds + stepSize
  //   [28..31] maxBounds + maxSteps
  //   [32..35] cameraPositionEC + densityThreshold
  //   [36..39] pickColor               (C-R9-VOXEL-PICK, Batch 53)
  //   [40..55] prevViewProjection      (B.9, Batch 153 — DP-H41)
  //   [56..71] modelMatrix              (Batch 173 — B.10 voxel velocity)
  //   [72..74] lightDirectionModel      (PARITY-VOXEL-COLOR-PARITY)
  //   [75]     voxelLightingEnabled     (PARITY-VOXEL-COLOR-PARITY)
  //   [76..79] voxelDimensions + metadataYUpBox   (VOXEL-SHAPEUV-CONVENTION)
  //   [80..95] proxyToShapeUv           (VOXEL-SHAPEUV-CONVENTION)
  //   [96..99] inputDimensions + pad    (VOXEL-SHAPEUV-CONVENTION)
  //   [100..103] paddingBefore + pad    (VOXEL-SHAPEUV-CONVENTION)
  //   [104..107] cameraPositionProxy + pad (VOXEL-SHAPEUV-CONVENTION)
  //   [108..115] childSlots0/1          (VOXEL-OCTREE-LOD)
  //   [116..119] atlasInfo: slotCount, targetLevel, pad, pad (VOXEL-OCTREE-LOD)
  //   [120..183] l2Slots (64 level-2 atlas slots, NEW-VOXEL-OCTREE-DEEP-TRAVERSAL)
  //   [184..199] proxyToLocal            (NEW-VOXEL-ELLIPSOID-INTERSECT)
  //   [200..203] ellipsoidRadii + shapeType (NEW-VOXEL-ELLIPSOID-INTERSECT)
  //   [204..207] shapeHeightMinMax + pad (NEW-VOXEL-ELLIPSOID-INTERSECT)
  //   [208..211] ellipsoidLocalToShapeUvScale + longitudeRangeOrigin
  //              (NEW-VOXEL-ELLIPSOID-SHAPEUV)
  //   [212..215] ellipsoidLocalToShapeUvTranslate + hasShapeBounds flags
  //              (NEW-VOXEL-ELLIPSOID-SHAPEUV)
  //   [216..219] cylinderRenderRadiusMinMax + angleRangeOrigin + pad
  //              (NEW-VOXEL-CYLINDER-SHAPEUV)
  //   [220..223] cylinderLocalToShapeUvScale + pad (NEW-VOXEL-CYLINDER-SHAPEUV)
  //   [224..227] cylinderLocalToShapeUvTranslate + pad
  //              (NEW-VOXEL-CYLINDER-SHAPEUV)
  //   [228..739] l3Slots (512 level-3 atlas slots, NEW-VOXEL-OCTREE-DEEP-LEVELS)
  const data = new Float32Array(740);
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;
  data[24] = -0.5;
  data[25] = -0.5;
  data[26] = -0.5;
  data[27] = 0.02; // minBounds + stepSize
  data[28] = 0.5;
  data[29] = 0.5;
  data[30] = 0.5;
  data[31] = 128; // maxBounds + maxSteps
  // cameraPositionEC stays zero — camera is the origin in eye space.
  data[32] = 0;
  data[33] = 0;
  data[34] = 0;
  data[35] = 0.1; // cameraEC + densityThreshold
  // Pick color zero when pickId hasn't been assigned yet — pick command
  // is gated by `pickColor` so the zero never reaches the pick FBO.
  if (pickColor) {
    data[36] = pickColor.red;
    data[37] = pickColor.green;
    data[38] = pickColor.blue;
    data[39] = pickColor.alpha;
  } else {
    data[36] = 0;
    data[37] = 0;
    data[38] = 0;
    data[39] = 0;
  }

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at floats
  // 40..55 (byte offset 160). UniformState swaps `_previousViewProjection
  // := viewProjection` at the END of `update()` AFTER returning the prior
  // frame's value, so on frame N this slot holds frame N-1's VP. First
  // frame falls through to identity.
  const prevVP = (us as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 40);
  } else {
    data[40] = 1;
    data[41] = 0;
    data[42] = 0;
    data[43] = 0;
    data[44] = 0;
    data[45] = 1;
    data[46] = 0;
    data[47] = 0;
    data[48] = 0;
    data[49] = 0;
    data[50] = 1;
    data[51] = 0;
    data[52] = 0;
    data[53] = 0;
    data[54] = 0;
    data[55] = 1;
  }

  // Batch 173 - model matrix at floats 56..71 (byte offset 224). Used
  // by the velocity VS to lift model-space cube vertices to world
  // space before applying prevViewProjection. CPU passes the
  // primitive's modelMatrix directly (no translation zeroing — the
  // velocity path needs the full transform, not the RTE-zeroed one).
  Matrix4.pack(modelMatrix, data, 56);

  // PARITY-VOXEL-COLOR-PARITY — transform the sun light direction (EC) into the
  // box's MODEL/local frame so the WGSL default-shader gray lighting
  // (0.5 + 0.5 * max(0, dot(entryNormalLocal, lightDirModel))) reproduces
  // WebGL's `dot(czm_normal * nLocal, czm_lightDirectionEC)`. Since
  // `dot(czm_normal * n, lEC) == dot(n, czm_normal^T * lEC)` and
  // `czm_normal = inverseTranspose(modelView3x3)`, the light direction in model
  // space is `czm_normal^T * lEC = inverse(modelView3x3) * lEC`. Only written
  // when the color-parity pipeline is active (real data); the off-gate
  // placeholder writes the historical 72-float layout implicitly zero-padded
  // here (`data` is zero-initialised past 71), so `voxelLightingEnabled` stays
  // 0 and the raw-texel else-branch never reads these floats.
  if (cache.usingRealData) {
    const mvForNormal = Matrix4.multiply(view, modelMatrix, scratchMVNormal);
    Matrix4.getMatrix3(mvForNormal, scratchMV3);
    const invMV3 = Matrix3.inverse(scratchMV3, scratchMV3Inv);
    const lightEC = context.uniformState.lightDirectionEC;
    const lightModel = Matrix3.multiplyByVector(
      invMV3,
      lightEC,
      scratchLightModel,
    );
    Cartesian3.normalize(lightModel, lightModel);
    data[72] = lightModel.x;
    data[73] = lightModel.y;
    data[74] = lightModel.z;
    data[75] = 1;

    // VOXEL-SHAPEUV-CONVENTION — pack the WebGL sample-frame convention
    // (floats 76..103) so the parity march samples through the SAME
    // world→shapeUv→inputCoordinate chain as WebGL. Only meaningful when the
    // real-data pipeline (VOXEL_CUSTOM_SHADER_COLOR) is active; the
    // placeholder path leaves these floats zero and never reads them.
    packVoxelSampleFrame(primitive, modelMatrix, cache, data);
    // The REAL proxy-space camera for the physically-correct parity ray
    // origin (the placeholder/pick paths keep the historical camera-centered
    // phantom march and never read this field).
    data[104] = camModel.x;
    data[105] = camModel.y;
    data[106] = camModel.z;

    // VOXEL-OCTREE-LOD — per-child atlas slots + slot count + this frame's
    // target LOD level (floats 108..119). Single-tile textures pack
    // slotCount = 1 and targetLevel = 0, which the WGSL reduces to the exact
    // historical sampling math (off-gate byte-identical). The placeholder
    // path never reaches this block and leaves the floats zero.
    const du = cache.dataUpload;
    if (du) {
      for (let i = 0; i < 8; i++) {
        data[108 + i] = du.childSlots[i];
      }
      data[116] = du.slotCount;
      const targetLevel = computeVoxelTargetLevel(primitive, frameState, du);
      du.lastTargetLevel = targetLevel;
      data[117] = targetLevel;
      // NEW-VOXEL-OCTREE-DEEP-TRAVERSAL — level-2 slot indirection (-1 =
      // not uploaded → the WGSL walk stops at the level-1 ancestor). Packed
      // verbatim even on shallower atlases (all -1 there) so a zero-filled
      // tail can never be misread as "level-2 tile at slot 0".
      for (let i = 0; i < 64; i++) {
        data[120 + i] = du.l2Slots[i];
      }
      // NEW-VOXEL-OCTREE-DEEP-LEVELS — level-3 slot indirection (floats
      // 228..739; -1 = not uploaded -> the walk stops at the level-2 ancestor).
      // du.l3Slots is all -1 on shallower atlases, so this is a byte-identical
      // zero/-1 tail there (never read: the WGSL walk only consults level 3
      // when targetLevel reaches 3, which needs an uploaded level-3 tile).
      for (let i = 0; i < 512; i++) {
        data[228 + i] = du.l3Slots[i];
      }
    }

    // NEW-VOXEL-ELLIPSOID-INTERSECT / NEW-VOXEL-CYLINDER-SHAPEUV —
    // shape-typed intersection fields (floats 184..207 + 216..227).
    // Zero-filled (shapeType 0 = the bit-identical BOX branch) unless the
    // provider's shape is ELLIPSOID or CYLINDER.
    packVoxelShapeIntersect(primitive, modelMatrix, data);
  }

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // FEAT-GAP-09 (Batch 100) — per-frame effects BG refresh. The
  // shared helper caches per frame and returns the placeholder when
  // none of (shadow, csm, atmosphereLut) is active, so this is cheap
  // and idempotent. We swap slot [1] of the cached command's bind
  // groups so a single command instance survives multi-frame use.
  const effectsBG =
    getOrCreateSharedAdvancedEffectsBG(frameState) ??
    getPlaceholderEffects(device).bindGroup;

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup, effectsBG],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: 36,
      pass: Pass.VOXELS,
    });
  } else {
    (cache.command as { bindGroups?: GPUBindGroup[] }).bindGroups = [
      cache.bindGroup,
      effectsBG,
    ];
    // PARITY-VOXEL-COLOR-PARITY — the color pipeline is swapped from the
    // placeholder (defines=0) to the customShader-parity pipeline once real
    // voxel data uploads and resolves ASYNCHRONOUSLY. The command may have been
    // created earlier bound to the placeholder pipeline; re-point it at the
    // current `cache.pipeline` so the drawn command uses the parity shader
    // rather than the stale raw-texel one. Idempotent (a no-op once equal).
    (cache.command as { pipeline?: GPURenderPipeline | null }).pipeline =
      cache.pipeline;
  }

  // Batch 173 - B.10 NEW-ADVANCED-MOTION-VECTORS attach. Voxel
  // geometry is the static unit cube — no prev VB needed. The velocity
  // VS reuses the same vertex buffer + bind group; only the entry
  // point changes. Same lifecycle as the other advanced renderers.
  attachVoxelVelocityCommand(device, context, frameState, cache);

  commandList.push(cache.command);

  // C-R9-VOXEL-PICK (Batch 53) — pick command. Same vertex stage and
  // bind group as the color command, different fragment entry. Wired
  // onto the color command's derivedCommands.picking.pickCommand so the
  // Batch 29 dispatcher (`selectCommandVariant`) routes to it during
  // pick passes; H-R3 (Batch 35) already added Pass.VOXELS to the pick
  // walk, so the command is reachable.
  if (pickColor) {
    // Pick path uses the placeholder effects BG — the pick fragment
    // entry doesn't reference `effects` / `atmosphere*`, but the
    // pipeline layout now includes the effects BGL (shared layout
    // with color + velocity), so we MUST bind something at slot 1.
    // Placeholder is safe — WGSL allows unused bindings.
    const pickEffectsBG = getPlaceholderEffects(device).bindGroup;
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline!,
        bindGroups: [cache.bindGroup, pickEffectsBG],
        vertexBuffers: [cache.vertexBuffer],
        indexBuffer: cache.indexBuffer,
        indexCount: 36,
        pass: Pass.VOXELS,
        pickOnly: true,
      });
    }
    attachPickToColorCommand(
      cache.command as CesiumAnyDrawCommand,
      cache.pickCommand,
    );
  }

  // C-R9-VOXEL-CELL-PICK — per-cell pick variant for `scene.pickVoxel`.
  // Real-data path only: the placeholder gradient has no cell convention to
  // decode, and the off-gate (no provider) must not allocate the pipeline.
  // Attached every frame (idempotent) onto
  // `derivedCommands.picking.pickVoxelCommand`; `selectCommandVariant`
  // routes to it ONLY during `passes.pickVoxel`, so the color render and the
  // regular object pick are untouched.
  if (cache.usingRealData) {
    attachVoxelCellPickCommand(device, context, cache);
  }
}

/**
 * C-R9-VOXEL-CELL-PICK — resolve the per-cell pick pipeline (lazily, through
 * the central pipeline cache when available) and attach the pick-voxel
 * command onto the color command's `derivedCommands.picking.pickVoxelCommand`
 * slot. Mirrors the `attachVoxelVelocityCommand` lifecycle: called every
 * frame on the real-data path, no-ops until the async pipeline resolves,
 * idempotent once attached.
 * @private
 */
function attachVoxelCellPickCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  cache: VoxelCache,
): void {
  if (!cache.pickVoxelDescriptor || !cache.command || !cache.bindGroup) {
    return;
  }

  if (!cache.pickVoxelPipeline && !cache.pickVoxelPipelineRequestPending) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    const pipelineCache = ctxAny.webgpuPipelineCache ?? null;
    if (pipelineCache) {
      const sync = pipelineCache.getPipelineSync(cache.pickVoxelDescriptor);
      if (sync) {
        cache.pickVoxelPipeline = sync;
      } else {
        cache.pickVoxelPipelineRequestPending = true;
        pipelineCache
          .getPipeline(cache.pickVoxelDescriptor)
          .then((p) => {
            cache.pickVoxelPipeline = p;
            cache.pickVoxelPipelineRequestPending = false;
          })
          .catch(() => {
            cache.pickVoxelPipelineRequestPending = false;
          });
      }
    } else {
      // Fallback synchronous creation when no central cache.
      cache.pickVoxelPipeline = device.createRenderPipeline(
        toGPUDescriptor(cache.pickVoxelDescriptor),
      );
    }
  }

  if (!cache.pickVoxelPipeline || !cache.vertexBuffer || !cache.indexBuffer) {
    return;
  }

  if (!cache.pickVoxelCommand) {
    // The pipeline layout includes the effects BGL at slot 1 (shared layout
    // with color/pick/velocity); the pick-voxel fragment entry never samples
    // the atmosphere bindings, so the placeholder BG is safe.
    const pickEffectsBG = getPlaceholderEffects(device).bindGroup;
    cache.pickVoxelCommand = new WebGPUDrawCommand({
      pipeline: cache.pickVoxelPipeline,
      bindGroups: [cache.bindGroup, pickEffectsBG],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: 36,
      pass: Pass.VOXELS,
      pickOnly: true,
    });
  }

  attachPickVoxelToColorCommand(
    cache.command as CesiumAnyDrawCommand,
    cache.pickVoxelCommand,
  );
}

/**
 * Batch 173 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity attach for
 * voxel volumes. Builds the velocity pipeline lazily, attaches a
 * `velocityCommand` to `cache.command`. The TAA pass walks the
 * command list for `cmd.velocityCommand` and dispatches it into the
 * rg16float velocity texture.
 *
 * Voxel geometry is a static unit cube — no prev vertex buffer
 * needed. The velocity is purely camera-induced (curr clip vs prev
 * clip via prevViewProjection × modelMatrix × modelPos), captured
 * at the bounding-box surface. For typical static voxel volumes
 * this gives correct TAA reprojection. For animated modelMatrix or
 * per-cell motion (rare), a deeper rework would be needed.
 *
 * Skips when TAA is off — keeps the off-path zero-cost.
 * @private
 */
function attachVoxelVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: VoxelCache,
): void {
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  if (!taaEnabledThisFrame) {
    if (cache.command) {
      (cache.command as { velocityCommand?: unknown }).velocityCommand =
        undefined;
    }
    return;
  }
  if (!cache.velocityDescriptor || !cache.command || !cache.bindGroup) {
    return;
  }

  // Lazy velocity pipeline resolution.
  if (!cache.velocityPipeline && !cache.velocityPipelineRequestPending) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    const pipelineCache = ctxAny.webgpuPipelineCache ?? null;
    if (pipelineCache) {
      const sync = pipelineCache.getPipelineSync(cache.velocityDescriptor);
      if (sync) {
        cache.velocityPipeline = sync;
      } else {
        cache.velocityPipelineRequestPending = true;
        pipelineCache
          .getPipeline(cache.velocityDescriptor)
          .then((p) => {
            cache.velocityPipeline = p;
            cache.velocityPipelineRequestPending = false;
          })
          .catch(() => {
            cache.velocityPipelineRequestPending = false;
          });
      }
    } else {
      // Fallback synchronous creation when no central cache.
      cache.velocityPipeline = device.createRenderPipeline(
        toGPUDescriptor(cache.velocityDescriptor),
      );
    }
  }

  if (cache.velocityPipeline && cache.vertexBuffer && cache.indexBuffer) {
    // Velocity path shares the color pipeline layout (effectsBGL at
    // slot 1); placeholder BG is safe — `fragmentVelocityMain`
    // doesn't sample atmosphere bindings.
    const velocityEffectsBG = getPlaceholderEffects(device).bindGroup;
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
        pipeline: cache.velocityPipeline,
        bindGroups: [cache.bindGroup, velocityEffectsBG],
        vertexBuffers: [cache.vertexBuffer],
        indexBuffer: cache.indexBuffer,
        indexCount: 36,
        pass: Pass.VOXELS,
      });
  } else {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }
}

function destroyWebGPUVoxelResources(
  primitive: CesiumObjectWithWebGPUCache,
): void {
  const cache = primitive._webgpuCache as VoxelCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.vertexBuffer?.destroy();
  cache.indexBuffer?.destroy();
  cache.voxelTexture?.destroy();
  // PARITY-VOXEL-MEGATEXTURE-UPLOAD (increment 1) — release the real-data
  // texture (distinct from the placeholder `voxelTexture`).
  cache.dataUpload?.texture?.destroy();

  // C-R9-VOXEL-PICK (Batch 53 / refactored Batch 59) — release the pick
  // ID so the registry slot is reclaimed and the next VoxelPrimitive
  // instance gets a fresh color. No-op when the primitive never entered
  // a render or pick pass.
  destroyPickIds(primitive as unknown as SinglePickIdCache);

  primitive._webgpuCache = undefined;
}

/**
 * C-R9-VOXEL-CELL-PICK-TAIL — the minimal provider fields that
 * {@link VoxelCell.fromKeyframeNode} reads (via the primitive) but that the
 * WebGPU feature-renderer path never copies onto the primitive (initFromProvider
 * is WebGL-only).
 */
interface VoxelPickProviderLike {
  dimensions?: Cartesian3;
  paddingBefore?: Cartesian3;
  paddingAfter?: Cartesian3;
}

/**
 * C-R9-VOXEL-CELL-PICK-TAIL — copy the provider-derived fields VoxelCell reads
 * (`dimensions`, `_paddingBefore`, `_paddingAfter`) onto the primitive. On the
 * WebGL path these are set by `initFromProvider`; the WebGPU feature-renderer
 * path skips it, leaving them at their zero-Cartesian constructor defaults.
 * Idempotent — mirrors `initFromProvider`'s provider-field copy exactly.
 */
function ensureVoxelPickPrimitiveFields(
  primitive: CesiumObjectWithWebGPUCache,
  provider: VoxelPickProviderLike,
): void {
  const p = primitive as unknown as {
    _dimensions?: Cartesian3;
    _paddingBefore?: Cartesian3;
    _paddingAfter?: Cartesian3;
  };
  if (provider.dimensions) {
    p._dimensions = Cartesian3.clone(provider.dimensions, p._dimensions);
  }
  p._paddingBefore = Cartesian3.clone(
    provider.paddingBefore ?? Cartesian3.ZERO,
    p._paddingBefore,
  );
  p._paddingAfter = Cartesian3.clone(
    provider.paddingAfter ?? Cartesian3.ZERO,
    p._paddingAfter,
  );
}

/**
 * C-R9-VOXEL-CELL-PICK-TAIL — build the keyframe-node handle `Scene.pickVoxel`
 * needs to construct a {@link VoxelCell} from a WebGPU cell-pick readback.
 *
 * The WebGL path resolves the picked `tileIndex` through the CPU-side
 * `VoxelTraversal.findKeyframeNode`, but the WebGPU feature-renderer path never
 * runs `initFromProvider`, so `primitive._traversal` (and its keyframeNode
 * table) is undefined. This resolver services the ROOT tile (megatextureIndex 0
 * — the single-tile / coarse case, WebGL-byte-identical per
 * VOXEL-CELL-PICK-RELAND) from the FR's uploaded root content, AND — since
 * NS-VOXEL-REFINED-TILE-CELL-RETENTION — the REFINED tiles (megatextureIndex
 * >= 1) by reverse-mapping the picked atlas slot back to its spatial tile
 * coordinate and its retained CPU-side child content. Either way it returns a
 * `{ spatialNode, content }` object shaped exactly like a WebGL KeyframeNode so
 * `VoxelCell.fromKeyframeNode` reads the same per-sample metadata + OBB.
 *
 * The picked `tileIndex` is the ATLAS SLOT emitted by the pick march
 * (0 = root; 1..8 = level-1 children; 9..72 = level-2; 73..584 = level-3). The
 * slot→tile inverse is read from the live `childSlots`/`l2Slots`/`l3Slots`
 * arrays, so it is correct for both the static full atlas and the dynamic LRU
 * pool. A slot whose retained content is missing (evicted mid-pick, or not yet
 * uploaded) degrades to `undefined` (no throw), exactly as WebGL does when a
 * keyframeNode is not found.
 *
 * @returns a KeyframeNode-like handle, or undefined when the resolved tile's
 * content is not (yet) available.
 */
function getVoxelPickKeyframeNode(
  primitive: CesiumObjectWithWebGPUCache,
  tileIndex: number,
):
  | { spatialNode: unknown; content: unknown; megatextureIndex: number }
  | undefined {
  const cache = primitive._webgpuCache as VoxelCache | undefined;
  const dataUpload = cache?.dataUpload ?? null;
  // Not-yet-uploaded root → no cell (nothing is resident to pick).
  if (!dataUpload || dataUpload.phase !== "done") {
    return undefined;
  }
  const shape = (primitive as unknown as { _shape?: unknown })._shape;
  const provider = (
    primitive as unknown as { _provider?: VoxelPickProviderLike }
  )._provider;

  // Resolve the picked atlas slot to its spatial tile coordinate + retained
  // content. Slot 0 is the root (level 0); slots >= 1 reverse-map through the
  // slot arrays to the retained child/L2/L3 content
  // (NS-VOXEL-REFINED-TILE-CELL-RETENTION).
  let level = 0;
  let tileX = 0;
  let tileY = 0;
  let tileZ = 0;
  let content: unknown;
  if (tileIndex === 0) {
    content = dataUpload.content;
  } else {
    const refined = resolveRefinedVoxelTile(dataUpload, tileIndex);
    if (refined) {
      level = refined.level;
      tileX = refined.x;
      tileY = refined.y;
      tileZ = refined.z;
      content = refined.content;
    }
  }
  if (!content || !shape || !provider) {
    return undefined;
  }

  ensureVoxelPickPrimitiveFields(primitive, provider);

  // Refresh the shape OBB/transform so the SpatialNode's bounding box is
  // current (the render path does this each frame; a pick after a render is
  // already current, but keep it robust to call order). Same guarded calls as
  // computeVoxelEffectiveModelMatrix.
  try {
    checkTransformAndBounds(primitive);
    updateShapeAndTransforms(primitive);
  } catch {
    // Degenerate volume — fall back to whatever OBB the shape last held.
  }

  const dimensions = (primitive as unknown as { dimensions?: Cartesian3 })
    .dimensions;
  const spatialNode = new SpatialNode(
    level,
    tileX,
    tileY,
    tileZ,
    undefined,
    shape,
    dimensions,
  );
  return { spatialNode, content, megatextureIndex: tileIndex };
}

/**
 * NS-VOXEL-REFINED-TILE-CELL-RETENTION — reverse-map a picked ATLAS SLOT
 * (megatextureIndex >= 1) to its octree tile coordinate (Z-up shape frame) and
 * the retained CPU-side content for that tile. The slot→tile-index inverse is
 * read from the live slot arrays (correct for the static full atlas AND the
 * dynamic LRU pool, where the slot assignment is not positional). The per-level
 * tile-index → (x, y, z) decode is the radix-2 extension of Octree.glsl's
 * `getOctreeChildData` octant order (level 1: childIndex = x + 2y + 4z; level 2:
 * x + 4y + 16z; level 3: x + 8y + 64z), mirroring `driveTileLevelUploads`'s
 * request coordinates.
 *
 * @returns the tile coordinate + content, or undefined when no resident slot
 * matches or its content is not retained.
 */
function resolveRefinedVoxelTile(
  dataUpload: VoxelDataUploadState,
  slot: number,
):
  | { level: number; x: number; y: number; z: number; content: unknown }
  | undefined {
  // Level 1 — slots 1..8, childIndex = x + 2y + 4z.
  for (let i = 0; i < 8; i++) {
    if (dataUpload.childSlots[i] === slot) {
      const content = dataUpload.childStates[i]?.content;
      if (!content) {
        return undefined;
      }
      return { level: 1, x: i & 1, y: (i >> 1) & 1, z: (i >> 2) & 1, content };
    }
  }
  // Level 2 — slots 9..72, linear index x + 4y + 16z.
  for (let i = 0; i < 64; i++) {
    if (dataUpload.l2Slots[i] === slot) {
      const content = dataUpload.l2States[i]?.content;
      if (!content) {
        return undefined;
      }
      return { level: 2, x: i & 3, y: (i >> 2) & 3, z: (i >> 4) & 3, content };
    }
  }
  // Level 3 — slots 73..584, linear index x + 8y + 64z.
  for (let i = 0; i < 512; i++) {
    if (dataUpload.l3Slots[i] === slot) {
      const content = dataUpload.l3States[i]?.content;
      if (!content) {
        return undefined;
      }
      return { level: 3, x: i & 7, y: (i >> 3) & 7, z: (i >> 6) & 7, content };
    }
  }
  return undefined;
}

export {
  updateWebGPUVoxelPrimitive,
  destroyWebGPUVoxelResources,
  getVoxelPickKeyframeNode,
};
export default {
  updateWebGPUVoxelPrimitive,
  destroyWebGPUVoxelResources,
  getVoxelPickKeyframeNode,
};
