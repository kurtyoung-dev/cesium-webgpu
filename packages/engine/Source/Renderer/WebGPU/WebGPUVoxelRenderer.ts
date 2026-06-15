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
import Cartesian3 from "../../Core/Cartesian3.js";
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
  destroyPickIds,
  ensurePickId,
  type SinglePickIdCache,
} from "./WebGPUPickCommandHelpers.js";
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
    let uvw = (p - u.minBounds) / (u.maxBounds - u.minBounds);
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) { continue; }
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

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

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
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
    (
      cache as unknown as { _pipelineSampleCount?: number }
    )._pipelineSampleCount = sceneSampleCount;
  }

  if (!cache.initialized) {
    // Batch 173 - UBO grew 256 → 320 bytes to include the model matrix
    // (floats 56-71 at byte offset 224). Used by the velocity VS to
    // lift model-space cube vertices to world space before applying
    // prevViewProjection. Comfortably fits with 32 spare bytes.
    cache.uniformBuffer = device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
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

    // FEAT-GAP-09 (Batch 100) — append the shared effects bind group
    // layout so the WGSL fog block at `@group(1)` resolves to the same
    // 480-byte UBO + aerial-LUT textures the globe and Mat shaders use.
    // The pipeline cache keys on the descriptor, so adding the BGL is
    // safe — a fresh pipeline will be built once and reused.
    const effectsBGL = getEffectsBindGroupLayout(device);

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bgl, effectsBGL],
    });

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
  const modelMatrix = primitive.modelMatrix ?? Matrix4.IDENTITY;
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
  const data = new Float32Array(72);
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

  // C-R9-VOXEL-PICK (Batch 53 / refactored Batch 59) — release the pick
  // ID so the registry slot is reclaimed and the next VoxelPrimitive
  // instance gets a fresh color. No-op when the primitive never entered
  // a render or pick pass.
  destroyPickIds(primitive as unknown as SinglePickIdCache);

  primitive._webgpuCache = undefined;
}

export { updateWebGPUVoxelPrimitive, destroyWebGPUVoxelResources };
export default { updateWebGPUVoxelPrimitive, destroyWebGPUVoxelResources };
