/**
 * WebGPU Cloud Renderer
 *
 * Renders cumulus cloud collections using WebGPU instanced billboard quads
 * with procedural noise for volumetric cloud appearance.
 * Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.
 *
 * @module WebGPUCloudRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUCollectionCameraUB from "./WebGPUCollectionCameraUB.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
// Shared per-frame scaffolding from the collection renderer base. Only the
// genuinely shared pieces are taken from it: the per-device
// shader-module-cache accessor and the re-entry sentinel. The count-only
// rebuild gate, the `buildInstanceBuffer` non-resident packing, the velocity
// lifecycle and the format/log-depth full-re-init invalidation stay local —
// that invalidation nulls a single `pipelineDescriptor` plus the velocity
// pipelines rather than defines-to-entry maps, so the base's map-clearing
// `invalidatePipelinesOnSceneFormatChange` does not fit.
import {
  beginCollectionFrame,
  endCollectionFrame,
  validateDrawTargets,
  validateInstancedDrawBuffer,
  makeDeviceShaderModuleCacheAccessor,
  type CollectionRenderCache,
} from "./WebGPUCollectionRendererBase.js";

// Per-device shader module cache so multiple CloudCollections sharing the
// same GPUDevice reuse a single compiled `GPUShaderModule`. Mirrors the
// per-renderer pattern used by Polyline, Billboard, Label and PointPrimitive.
const getCloudShaderModuleCache = makeDeviceShaderModuleCacheAccessor();

interface CloudCache extends CollectionRenderCache {
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  // Group-0 layout, retained so the per-slice resolver can rebuild bind
  // groups, plus the per-collection per-slice camera-UB pool and resolver
  // factory.
  bindGroupLayout?: GPUBindGroupLayout | null;
  cameraUB?: WebGPUCollectionCameraUB;
  noiseTexture: GPUTexture | null;
  noiseTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastCloudCount: number;
  // The pipeline arrives asynchronously from
  // `WebGPURenderPipelineCache.getPipeline()`; this tracks whether a request
  // is in flight so it is not re-issued every frame.
  pipelineRequestPending: boolean;
  pipelineDescriptor: WebGPURenderPipelineDescriptor | null;

  // Motion-vector slots, on the same lifecycle as the point-cloud renderer:
  //   - `instanceData` tracks this frame's interleaved Float32Array.
  //   - `prevInstanceData` is promoted from `instanceData` after the velocity
  //     dispatch.
  //   - `prevInstanceBuffer` is the GPU mirror of the previous positions.
  //   - `velocityPipelineDescriptor` and `velocityPipeline` resolve through
  //     the central pipeline cache.
  // Static cloud collections have previous equal to current, so velocity is
  // zero and the camera-only TAA fallback carries the motion. Collections
  // whose positions the application updates per frame get real per-cloud
  // velocity.
  instanceData: Float32Array | null;
  prevInstanceData: Float32Array | null;
  prevInstanceBuffer: GPUBuffer | null;
  velocityPipeline: GPURenderPipeline | null;
  velocityPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;
  // Monotonic counter bumped at the single `instanceBuffer` content-write
  // site, which fires on a cloud count change or on per-cloud property edits
  // (the rebuild gate reads the collection dirty state). The identity-case
  // prev buffer re-seeds once via `copyBufferToBuffer` and then skips the
  // per-frame CPU re-upload.
  instanceDataRevision: number;
  // The `instanceDataRevision` resident in `prevInstanceBuffer`; `undefined`
  // means unknown or stale and forces a re-seed. Reset when the prev buffer is
  // reallocated.
  prevBufferRevision: number | undefined;
}

const CLOUD_WGSL = /* wgsl */ `
struct CameraUniforms {
  modelViewProjectionRTE: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  // Projection diagonal P00/P11 (NEW-CLOUD-SCALE-METERS, Batch 253) —
  // CumulusCloud.scale is METERS in eye space (upstream CloudCollectionVS:
  // positionEC.xy += scale * offset), so the VS sizes the quad via
  // clip-offset = scale * (P00, P11). Packed into the former pad lanes.
  projScaleX: f32,
  encodedCameraLow: vec3<f32>,
  projScaleY: f32,
  viewportSize: vec2<f32>,
  time: f32,
  _pad2: f32,
  // Batch 170 - DP-H41 prev viewProjection at the tail. CloudCollection
  // positions are in world space (no modelMatrix), so the velocity VS
  // can apply prevVP directly to the prev instance position.
  prevViewProjection: mat4x4<f32>,
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — (near, far,
  // oneOverLog2FarDepthFromNearPlusOne, reserved) at floats 44-47. Packed
  // unconditionally; only the LOG_DEPTH ifdef blocks read it.
  logDepth: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;

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

struct VertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) scaleAndBrightness: vec4<f32>, // xy=scale(m), z=brightness, w=slice
  @location(4) color: vec4<f32>,
  // NEW-CLOUD-IMPOSTOR-FS-PARITY (Batch 363) — per-cloud ellipsoid extent
  // (CumulusCloud.maximumSize, meters). The FS raymarches 0.82 * maximumSize.
  @location(5) maximumSize: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  // Local raymarch offset in [-0.5, 0.5] (WebGL v_offset = dir - 0.5).
  @location(0) vOffset: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vBrightness: f32,
  @location(3) vMaximumSize: vec3<f32>,
  @location(4) vSlice: f32,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(5) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - camera.encodedCameraHigh)
             + (input.positionLow - camera.encodedCameraLow);
  let centerClip = camera.modelViewProjectionRTE * vec4<f32>(posRTE, 1.0);
  // Scale is METERS (upstream parity): an eye-space lateral offset of
  // (dx, dy) meters projects to clip offset (dx*P00, dy*P11) for a
  // symmetric frustum — no /w, no viewport term. The previous
  // /viewportSize*2*w form sized the quad in screen PIXELS, blowing a
  // 2000 m cloud up to full-screen at any camera distance
  // (NEW-CLOUD-SCALE-METERS, Batch 253).
  // NEW-WEBGPU-CLOUD-SIZE-PARITY (Batch 366) — the quad VB spans quadPos in
  // [-1,1] (half-extent 1.0), but WebGL's quad uses offset = dir-0.5 in
  // [-0.5,0.5] (half-extent 0.5; CloudCollectionVS.glsl:34 does
  // "positionEC.xy += scale * offset"). Scaling the FULL quadPos here made the WebGPU cloud quad
  // 2x too wide → the raymarched cloud rendered ~1.9x WebGL's size. The *0.5
  // matches WebGL's eye-space half-extent; vOffset below is ALREADY halved,
  // so the raymarch coordinate (maxSize*vOffset) is unchanged.
  let offset = vec2<f32>(
    input.quadPos.x * 0.5 * input.scaleAndBrightness.x * camera.projScaleX,
    input.quadPos.y * 0.5 * input.scaleAndBrightness.y * camera.projScaleY
  );
  output.position = centerClip + vec4<f32>(offset, 0.0, 0.0);
  output.vOffset = input.quadPos * 0.5;
  output.vColor = input.color;
  output.vBrightness = input.scaleAndBrightness.z;
  output.vMaximumSize = input.maximumSize;
  output.vSlice = input.scaleAndBrightness.w;
  //>>ifdef LOG_DEPTH
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Written for the depth TEST as well (frag_depth replaces rasterized z),
  // so the translucent cloud pass tests correctly against log scene depth.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

// ---- Volumetric cloud FS (NEW-CLOUD-IMPOSTOR-FS-PARITY, Batch 363) ----
// Faithful port of CloudCollectionFS.glsl: raymarch the per-cloud ellipsoid
// (0.82 * maximumSize) in a local eye space, shade with the Gardner (1985)
// analytic texture function + diffuse/specular, then erode the silhouette with
// 3-channel worley FBM (inline port of CloudNoiseFS.glsl's worley, in place of
// the baked 3D-packed-2D noise texture — bindings 1/2 are retained for the
// bind-group layout + a future exact-worley-texture pass). czm_epsilon2 = 0.01,
// czm_pi = 3.141592653589793 inlined.

// Baked 3-channel worley-FBM noise texture sampling — 1:1 port of
// CloudCollectionFS.glsl's voxelToUV + sampleNoiseTexture (NEW-WEBGPU-CLOUD-
// WORLEY-TEXTURE-PARITY). The texture is a 3D worley cube packed into a 2D
// atlas (see createNoiseTexture); we decode the trilinear sample manually, so
// the noise sampler MUST be NEAREST (no hardware blend across slice seams).
// Constants mirror the CPU generator: SLICE=64 voxels, ROWS=4, DETAIL=8 (chosen
// so a 64³ cube reproduces WebGL's 128³/detail-16 grain frequency + tile
// period at half the gen cost).
const NOISE_SLICE: f32 = 64.0;
const NOISE_ROWS: f32 = 4.0;
const NOISE_INV_ROWS: f32 = 0.25;
const NOISE_DETAIL: f32 = 8.0;

fn csm_cloudMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }

fn csm_cloudWrap(value: f32, rangeLength: f32) -> f32 {
  if (value < 0.0) {
    let modValue = csm_cloudMod(abs(value), rangeLength);
    return csm_cloudMod(rangeLength - modValue, rangeLength);
  }
  return csm_cloudMod(value, rangeLength);
}

fn csm_cloudVoxelToUV(voxelIndex: vec3<f32>) -> vec2<f32> {
  let invDims = vec2<f32>(
    NOISE_ROWS / (NOISE_SLICE * NOISE_SLICE),
    NOISE_INV_ROWS / NOISE_SLICE);
  let wrapped = vec3<f32>(
    csm_cloudWrap(voxelIndex.x, NOISE_SLICE),
    csm_cloudWrap(voxelIndex.y, NOISE_SLICE),
    csm_cloudWrap(voxelIndex.z, NOISE_SLICE));
  let column = csm_cloudMod(wrapped.z, NOISE_SLICE * NOISE_INV_ROWS);
  let row = floor(wrapped.z / NOISE_SLICE * NOISE_ROWS);
  let xPixel = wrapped.x + column * NOISE_SLICE;
  let yPixel = wrapped.y + row * NOISE_SLICE;
  return vec2<f32>(xPixel, yPixel) * invDims;
}

fn csm_cloudLerpSamplesX(voxelIndex: vec3<f32>, x: f32) -> vec4<f32> {
  let uv0 = csm_cloudVoxelToUV(voxelIndex);
  let uv1 = csm_cloudVoxelToUV(voxelIndex + vec3<f32>(1.0, 0.0, 0.0));
  let s0 = textureSampleLevel(noiseTex, noiseSampler, uv0, 0.0);
  let s1 = textureSampleLevel(noiseTex, noiseSampler, uv1, 0.0);
  return mix(s0, s1, x);
}

fn csm_cloudSampleNoise(position: vec3<f32>) -> vec4<f32> {
  let recentered = position + vec3<f32>(NOISE_SLICE / 2.0);
  let lerpValue = fract(recentered);
  let voxelIndex = floor(recentered);
  let xLerp00 = csm_cloudLerpSamplesX(voxelIndex, lerpValue.x);
  let xLerp01 = csm_cloudLerpSamplesX(voxelIndex + vec3<f32>(0.0, 0.0, 1.0), lerpValue.x);
  let xLerp10 = csm_cloudLerpSamplesX(voxelIndex + vec3<f32>(0.0, 1.0, 0.0), lerpValue.x);
  let xLerp11 = csm_cloudLerpSamplesX(voxelIndex + vec3<f32>(0.0, 1.0, 1.0), lerpValue.x);
  let yLerp0 = mix(xLerp00, xLerp10, lerpValue.y);
  let yLerp1 = mix(xLerp01, xLerp11, lerpValue.y);
  return mix(yLerp0, yLerp1, lerpValue.z);
}

// Unit-sphere (r=0.5) intersection with optional slice plane.
fn csm_cloudIntersectSphere(origin: vec3<f32>, dir: vec3<f32>, slice: f32,
                            point: ptr<function, vec3<f32>>,
                            normal: ptr<function, vec3<f32>>) -> bool {
  let A = dot(dir, dir);
  let B = dot(origin, dir);
  let Cc = dot(origin, origin) - 0.25;
  let disc = B * B - A * Cc;
  if (disc < 0.0) { return false; }
  let root = sqrt(disc);
  var t = (-B - root) / A;
  if (t < 0.0) { t = (-B + root) / A; }
  var p = origin + t * dir;
  if (slice >= 0.0) {
    p.z = (slice * 0.5) - 0.5;
    if (length(p) > 0.5) { return false; }
  }
  let n = normalize(p);
  *point = p - 0.01 * n;
  *normal = n;
  return true;
}

// Ray vs ellipsoid: transform into unit-sphere space, intersect, transform back.
fn csm_cloudIntersectEllipsoid(origin: vec3<f32>, dir: vec3<f32>, center: vec3<f32>,
                               scale: vec3<f32>, slice: f32,
                               point: ptr<function, vec3<f32>>,
                               normal: ptr<function, vec3<f32>>) -> bool {
  if (scale.x <= 0.01 || scale.y < 0.01 || scale.z < 0.01) { return false; }
  let o = (origin - center) / scale;
  let d = dir / scale;
  var p: vec3<f32>;
  var n: vec3<f32>;
  let hit = csm_cloudIntersectSphere(o, d, slice, &p, &n);
  if (hit) {
    *point = (p * scale) + center;
    *normal = n;
  }
  return hit;
}

// Gardner (1985) analytic cloud texture function.
fn csm_cloudPhaseShift2D(p: vec2<f32>, freq: vec2<f32>) -> vec2<f32> {
  return (3.141592653589793 / 2.0) * sin(freq.yx * p.yx);
}
fn csm_cloudPhaseShift3D(p: vec3<f32>, freq: vec2<f32>) -> vec2<f32> {
  return csm_cloudPhaseShift2D(p.xy, freq)
       + 3.141592653589793 * vec2<f32>(sin(freq.x * p.z));
}
fn csm_cloudT(point: vec3<f32>) -> f32 {
  let T0 = 0.6;
  let kk = 0.1;
  var Ci = 0.8;
  var FXY = vec2<f32>(0.6, 0.6);
  var sum = vec2<f32>(0.0);
  for (var i = 0; i < 5; i = i + 1) {
    let PXY = csm_cloudPhaseShift3D(point, FXY);
    Ci = Ci * 0.707;
    FXY = FXY * 2.0;
    let sinTerm = sin(FXY * point.xy + PXY);
    sum = sum + Ci * sinTerm + vec2<f32>(T0);
  }
  return kk * sum.x * sum.y;
}

fn csm_cloudI(Id: f32, Is: f32, It: f32) -> f32 {
  let a = 0.5; // ambient/scattered fraction
  let t = 0.4; // texture shading fraction
  let s = 0.25; // specular fraction
  return (1.0 - a) * ((1.0 - t) * ((1.0 - s) * Id + s * Is) + t * It) + a;
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  var out: FragOutput;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
  //>>endif

  // Raycast from an arbitrarily smaller local space (WebGL parity).
  let maxSize = input.vMaximumSize;
  let coordinate = maxSize.xy * input.vOffset;
  let ellipsoidScale = 0.82 * maxSize;
  let ellipsoidCenter = vec3<f32>(0.0);

  let zOffset = max(ellipsoidScale.z - 10.0, 0.0);
  let eye = vec3<f32>(0.0, 0.0, -10.0 - zOffset);
  let rayDir = normalize(vec3<f32>(coordinate, 1.0) - eye);
  let rayOrigin = eye;

  var cloudPoint = vec3<f32>(0.0);
  var cloudNormal = vec3<f32>(0.0);
  let hit = csm_cloudIntersectEllipsoid(
    rayOrigin, rayDir, ellipsoidCenter, ellipsoidScale, input.vSlice,
    &cloudPoint, &cloudNormal);
  if (!hit) {
    discard;
    out.color = vec4<f32>(0.0);
    return out;
  }

  let lightDir = normalize(vec3<f32>(0.2, -1.0, 0.7));
  let Id = clamp(dot(cloudNormal, -lightDir), 0.0, 1.0);   // diffuse
  let Is = max(pow(dot(-lightDir, -rayDir), 2.0), 0.0);     // specular
  let It = csm_cloudT(cloudPoint);                          // texture
  let intensity = csm_cloudI(Id, Is, It);
  let color = vec3<f32>(intensity * clamp(input.vBrightness, 0.1, 1.0));

  // Worley erosion — sample the baked 3-channel worley-FBM texture EXACTLY
  // like WebGL (CloudCollectionFS: noise = sampleNoiseTexture(noiseDetail *
  // cloudPoint); W/W2/W3 = noise.x/y/z), tiled + trilinear. This replaces the
  // B363 inline-worley approximation (which, normalized by cloud radius, was
  // ~4 cells across vs WebGL's ~8/tile × many tiles → coarser, less grainy).
  let noise = csm_cloudSampleNoise(NOISE_DETAIL * cloudPoint);
  let W  = noise.x;
  let W2 = noise.y;
  let W3 = noise.z;

  let ndDot = clamp(dot(cloudNormal, -rayDir), 0.0, 1.0);
  var TR = pow(ndDot, 3.0) - W;     // translucency
  TR = TR * 1.3;
  let minusDot = 0.5 - ndDot;
  TR = TR - min(minusDot * W2, 0.0);
  TR = TR - 0.8 * (minusDot + 0.25) * W3;

  var shading = mix(1.0 - 0.8 * W * W, 1.0, Id * TR);
  shading = clamp(shading + 0.2, 0.3, 1.0);

  let finalColor = mix(vec3<f32>(0.5), shading * color, 1.15);
  let cloud = vec4<f32>(finalColor, clamp(TR, 0.0, 1.0)) * input.vColor;
  if (cloud.w < 0.01) {
    discard;
    out.color = vec4<f32>(0.0);
    return out;
  }
  out.color = cloud;
  return out;
}

// Batch 170 - B.10 NEW-ADVANCED-MOTION-VECTORS velocity emission for
// animated cloud collections. Mirrors PointCloud's pattern: rasterize
// the cloud quad at the CURRENT-frame position so the velocity texture
// covers the same pixels the color pass touched, then emit per-fragment
// (currNdc - prevNdc). Cloud positions are world-space (no modelMatrix),
// so the prev clip computation is just prevVP × prevWorldPos.
struct VelocityVertexInput {
  @location(0) quadPos: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) scaleAndBrightness: vec4<f32>,
  @location(4) color: vec4<f32>,
  // Slot 1: prev-frame instance data — only positions matter (locs 5/6).
  @location(5) prevPositionHigh: vec3<f32>,
  @location(6) prevPositionLow: vec3<f32>,
};

struct VelocityVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) currCenterClip: vec4<f32>,
  @location(1) prevCenterClip: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Velocity pass shares scene depth read-only — test in log space.
  @location(2) v_logDepth: f32,
  //>>endif
};

@vertex
fn vertexVelocityMain(input: VelocityVertexInput) -> VelocityVertexOutput {
  var output: VelocityVertexOutput;
  // Current-frame center clip via RTE.
  let posRTE = (input.positionHigh - camera.encodedCameraHigh)
             + (input.positionLow - camera.encodedCameraLow);
  let currCenterClip = camera.modelViewProjectionRTE * vec4<f32>(posRTE, 1.0);
  // Previous-frame center clip via full prev VP × world position.
  let prevWorldPos = vec4<f32>(
    input.prevPositionHigh + input.prevPositionLow, 1.0,
  );
  let prevCenterClip = camera.prevViewProjection * prevWorldPos;
  // Rasterize quad at the current center. Meters-based sizing — must
  // match vertexMain exactly so velocity covers the same fragments
  // (NEW-CLOUD-SCALE-METERS, Batch 253; *0.5 half-extent NEW-WEBGPU-CLOUD-
  // SIZE-PARITY, Batch 366).
  let offset = vec2<f32>(
    input.quadPos.x * 0.5 * input.scaleAndBrightness.x * camera.projScaleX,
    input.quadPos.y * 0.5 * input.scaleAndBrightness.y * camera.projScaleY
  );
  output.position = currCenterClip + vec4<f32>(offset, 0.0, 0.0);
  output.currCenterClip = currCenterClip;
  output.prevCenterClip = prevCenterClip;
  //>>ifdef LOG_DEPTH
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.logDepth.x);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif
  return output;
}

struct VelocityFragOutput {
  @location(0) velocity: vec2<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentVelocityMain(input: VelocityVertexOutput) -> VelocityFragOutput {
  var out: VelocityFragOutput;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
  //>>endif
  let curW = input.currCenterClip.w;
  let prevW = input.prevCenterClip.w;
  if (curW <= 0.0 || prevW <= 0.0) {
    out.velocity = vec2<f32>(0.0);
    return out;
  }
  let curNdc = input.currCenterClip.xy / curW;
  let prevNdc = input.prevCenterClip.xy / prevW;
  out.velocity = curNdc - prevNdc;
  return out;
}
`;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// Scratch view matrix with translation column zeroed — used to build a
// translation-free MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

// Three-channel worley-FBM noise baked into a 3D-to-2D atlas, a CPU port of
// `CloudNoiseFS.glsl`'s worley plus `CloudCollection.js`'s packing. The cloud
// fragment shader samples it at `NOISE_DETAIL * cloudPoint` through the WGSL
// `voxelToUV` and a manual trilinear blend, matching the WebGL path so the
// erosion grain agrees.
//
// A 64-voxel cube at detail 8 reproduces the WebGL 128-voxel/detail-16 grain
// frequency (cells per tile = slice / detail = 8) and tile period (also 8, in
// `cloudPoint` space) at an eighth of the generation cost. These packing
// dimensions have to stay in lock-step with the WGSL constants
// `NOISE_SLICE`, `NOISE_ROWS`, `NOISE_INV_ROWS` and `NOISE_DETAIL`.
//
// The worley cell points depend only on cells wrapped to [0, slice / detail),
// that is [0, 8) per axis, so the 8³ = 512 unique points are precomputed once
// and the per-voxel loop runs without trigonometry, which keeps the one-time
// generation well under a frame-budget hitch even at 1024 by 256.
const NOISE_TEX_SLICE = 64;
const NOISE_TEX_ROWS = 4;
const NOISE_TEX_DETAIL = 8.0;

function createNoiseTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const SLICE = NOISE_TEX_SLICE;
  const ROWS = NOISE_TEX_ROWS;
  const DETAIL = NOISE_TEX_DETAIL;
  const width = (SLICE * SLICE) / ROWS; // 1024
  const height = SLICE * ROWS; // 256
  const invRows = 1.0 / ROWS;
  const wrapRange = SLICE / DETAIL; // 8 — worley cell wrap period (integers)
  const data = new Uint8Array(width * height * 4);

  const fract = (x: number): number => x - Math.floor(x);
  const glslMod = (x: number, y: number): number => x - y * Math.floor(x / y);
  const wrap = (v: number, r: number): number => {
    if (v < 0) {
      const m = glslMod(Math.abs(v), r);
      return glslMod(r - m, r);
    }
    return glslMod(v, r);
  };

  // Precompute random3(cell) for every wrapped integer cell in [0, wrapRange)³.
  const wr = Math.round(wrapRange);
  const cellPts = new Float32Array(wr * wr * wr * 3);
  for (let cz = 0; cz < wr; cz++) {
    for (let cy = 0; cy < wr; cy++) {
      for (let cx = 0; cx < wr; cx++) {
        const d1 = cx * 127.1 + cy * 311.7 + cz * 932.8;
        const d2 = cx * 269.5 + cy * 183.3 + cz * 421.4;
        const b = ((cz * wr + cy) * wr + cx) * 3;
        cellPts[b] = fract(Math.sin(d1 - d2));
        cellPts[b + 1] = fract(Math.cos(d1 * d2));
        cellPts[b + 2] = fract(d1 * d2);
      }
    }
  }

  // worleyNoise(P, F): shortest distance to a feature point in the 3×3×3
  // neighborhood, cells wrapped to [0, wrapRange). Mirrors CloudNoiseFS.
  const worley = (px: number, py: number, pz: number, freq: number): number => {
    const Px = px * freq;
    const Py = py * freq;
    const Pz = pz * freq;
    const ccx = Math.floor(Px);
    const ccy = Math.floor(Py);
    const ccz = Math.floor(Pz);
    const fx = Px - ccx;
    const fy = Py - ccy;
    const fz = Pz - ccz;
    let shortest = 1000.0;
    for (let oz = -1; oz <= 1; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cellx = wrap(ccx + ox, wrapRange);
          const celly = wrap(ccy + oy, wrapRange);
          const cellz = wrap(ccz + oz, wrapRange);
          const b = ((cellz * wr + celly) * wr + cellx) * 3;
          const dx = fx - (ox + cellPts[b]);
          const dy = fy - (oy + cellPts[b + 1]);
          const dz = fz - (oz + cellPts[b + 2]);
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < shortest) {
            shortest = d;
          }
        }
      }
    }
    return shortest;
  };

  // 3-octave FBM at a given outer scale (persistence 0.625).
  const worleyFBM = (
    px: number,
    py: number,
    pz: number,
    scale: number,
  ): number => {
    let noise = 0.0;
    let freq = 1.0;
    let persistence = 0.625;
    for (let i = 0; i < 3; i++) {
      noise +=
        worley(px * scale, py * scale, pz * scale, freq * scale) * persistence;
      persistence *= 0.5;
      freq *= 2.0;
    }
    return noise;
  };

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

  for (let py = 0; py < height; py++) {
    const y = glslMod(py, SLICE);
    const sliceRow = Math.floor(py / SLICE);
    for (let px = 0; px < width; px++) {
      // pixel → voxel (inverse of voxelToUV / CloudNoiseFS main).
      const x = glslMod(px, SLICE);
      const z = Math.floor(px / SLICE) + sliceRow * invRows * SLICE;
      const posx = x / DETAIL;
      const posy = y / DETAIL;
      const posz = z / DETAIL;
      const idx = (py * width + px) * 4;
      data[idx] = Math.round(clamp01(worleyFBM(posx, posy, posz, 1.0)) * 255);
      data[idx + 1] = Math.round(
        clamp01(worleyFBM(posx, posy, posz, 2.0)) * 255,
      );
      data[idx + 2] = Math.round(
        clamp01(worleyFBM(posx, posy, posz, 3.0)) * 255,
      );
      data[idx + 3] = 255;
    }
  }

  const texture = device.createTexture({
    size: { width, height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: width * 4 },
    { width, height },
  );
  return { texture, view: texture.createView() };
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

function buildInstanceBuffer(
  device: GPUDevice,
  collection: CesiumObjectWithWebGPUCache,
): { buffer: GPUBuffer; count: number; instanceData: Float32Array } {
  const clouds = collection._clouds || [];
  const count = clouds.length || collection.length || 0;
  if (count === 0) {
    return {
      buffer: device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX }),
      count: 0,
      instanceData: new Float32Array(0),
    };
  }
  // Per instance: posHigh(12) + posLow(12) + scaleAndBrightness(16) + color(16)
  //             + maximumSize(12) = 68 bytes.
  const data = new Float32Array(count * 17);
  let visibleCount = 0;
  for (let i = 0; i < count; i++) {
    const rawCloud =
      clouds[i] || (collection.get ? collection.get(i) : undefined);
    if (!rawCloud) {
      continue;
    }
    const cloud = rawCloud as {
      show?: boolean;
      position?: CesiumCartesian3;
      scale?: CesiumCartesian2;
      brightness?: number;
      slice?: number;
      color?: CesiumColor;
      maximumSize?: CesiumCartesian3;
    };
    // Per-cloud show flag, honoured here as it is on the WebGL path.
    if (cloud.show === false) {
      continue;
    }
    const pos = cloud.position || new Cartesian3();
    EncodedCartesian3.fromCartesian(pos, scratchEncoded);
    const off = visibleCount * 17;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;
    // Defaults mirror CumulusCloud: scale (20,12), slice -1.0 (no slice plane).
    const sx = cloud.scale?.x ?? 20.0;
    const sy = cloud.scale?.y ?? 12.0;
    data[off + 6] = sx;
    data[off + 7] = sy;
    data[off + 8] = cloud.brightness ?? 1.0;
    data[off + 9] = cloud.slice ?? -1.0;
    const c = cloud.color;
    data[off + 10] = c?.red ?? 1.0;
    data[off + 11] = c?.green ?? 1.0;
    data[off + 12] = c?.blue ?? 1.0;
    data[off + 13] = c?.alpha ?? 0.8;
    // maximumSize (CumulusCloud default = (scale.x, scale.y, min(sx,sy)/1.5)).
    const ms = cloud.maximumSize;
    data[off + 14] = ms?.x ?? sx;
    data[off + 15] = ms?.y ?? sy;
    data[off + 16] = ms?.z ?? Math.min(sx, sy) / 1.5;
    visibleCount++;
  }
  const buffer = device.createBuffer({
    // `COPY_SRC` so the velocity prev-buffer identity seed and count-change
    // seed can `copyBufferToBuffer` from here into `prevInstanceBuffer` on the
    // GPU, where the identical bytes already reside. Mirrors the splat
    // renderer.
    size: data.byteLength,
    usage:
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(buffer, 0, data);
  // The instance count is `visibleCount`, the clouds whose `show` is true,
  // while the buffer stays sized for the full collection slot count so
  // toggling `show` does not force a reallocation on the next rewrite. The
  // interleaved data is handed back so the velocity helper can keep a
  // CPU-side prev mirror.
  return { buffer, count: visibleCount, instanceData: data };
}

/**
 * Resolve the cloud pipeline through the central pipeline cache. If the
 * cache is unavailable (no WebGPU context, or device not yet present),
 * falls back to a direct `device.createRenderPipeline()`.
 *
 * Returns synchronously when the pipeline is already cached; otherwise
 * kicks off async creation and returns false so the caller can skip the
 * frame and try again next tick. Mirrors `tryResolveEllipsoidPipelines`.
 */
function tryResolveCloudPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: CloudCache,
): boolean {
  if (cache.pipeline) {
    return true;
  }
  const desc = cache.pipelineDescriptor;
  if (!desc) {
    return false;
  }

  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(desc);
    if (sync) {
      cache.pipeline = sync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      pipelineCache
        .getPipeline(desc)
        .then((p) => {
          cache.pipeline = p;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear the in-flight flag
          // so the next frame retries.
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback for when there is no central cache, such as a WebGL-backed
  // graphics context: create the pipeline synchronously.
  cache.pipeline = device.createRenderPipeline({
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
    multisample: desc.multisample,
  });
  return true;
}

function updateWebGPUCloudCollection(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  if (!collection.show || collection.length === 0) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      quadVertexBuffer: null,
      instanceBuffer: null,
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      noiseTexture: null,
      noiseTextureView: null,
      sampler: null,
      instanceCount: 0,
      command: null,
      initialized: false,
      lastCloudCount: -1,
      pipelineRequestPending: false,
      pipelineDescriptor: null,
      // Velocity slots, allocated lazily when TAA is on.
      instanceData: null,
      prevInstanceData: null,
      prevInstanceBuffer: null,
      velocityPipeline: null,
      velocityPipelineDescriptor: null,
      velocityPipelineRequestPending: false,
      // Prev-buffer revision skip.
      instanceDataRevision: 0,
      prevBufferRevision: undefined,
    } as CloudCache;
  }

  // Re-entry guard around the whole update: it increments a per-collection
  // depth and logs a throttled `console.error` if the cloud update re-enters
  // itself for the same collection before settling. The `finally` always
  // settles the depth back to zero.
  const sentinelCache = collection._webgpuCache as unknown as CloudCache;
  beginCollectionFrame(sentinelCache, "CloudCollection");
  try {
    _updateWebGPUCloudCollectionInner(collection, frameState);
  } finally {
    endCollectionFrame(sentinelCache);
  }
}

function _updateWebGPUCloudCollectionInner(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  const cache = collection._webgpuCache as CloudCache;
  // Clouds draw into the scene framebuffer, so the pipeline follows
  // `scenePipelineFormat`: HDR mode targets rgba16float rather than the
  // canvas bgra8unorm.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
        presentationFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (
      context as unknown as {
        presentationFormat?: GPUTextureFormat;
      }
    ).presentationFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Invalidate the cache on a scene format change.
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  if (
    cache.initialized &&
    (cache as unknown as { _pipelineFormatGeneration?: number })
      ._pipelineFormatGeneration !== sceneGen
  ) {
    cache.initialized = false;
    cache.command = null;
    cache.pipelineDescriptor = null;
    cache.pipeline = null;
    cache.pipelineRequestPending = false;
    // The velocity pipeline references the same shader module, built against
    // the format that just changed, so it has to be rebuilt as well.
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  // Renderer-wide log depth: the LOG_DEPTH define is baked into the cloud
  // module and pipelines while it is active, and a flip of the switch forces
  // a full re-init, mirroring the scene-format-generation invalidation above.
  const logDepthActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );
  if (
    cache.initialized &&
    (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled !==
      logDepthActive
  ) {
    cache.initialized = false;
    cache.command = null;
    cache.pipelineDescriptor = null;
    cache.pipeline = null;
    cache.pipelineRequestPending = false;
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
  }
  (cache as unknown as { _logDepthEnabled?: boolean })._logDepthEnabled =
    logDepthActive;

  if (!cache.initialized) {
    // Route module compilation through the per-device shader module cache so
    // two CloudCollections share a single `GPUShaderModule`.
    const moduleCache = getCloudShaderModuleCache(device);
    cache.shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.CLOUD_COLLECTION,
      CLOUD_WGSL,
      logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
      "CloudCollection",
    );
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const noise = createNoiseTexture(device);
    cache.noiseTexture = noise.texture;
    cache.noiseTextureView = noise.view;
    // Nearest filtering: the worley atlas is a 3D cube packed into 2D and the
    // fragment shader does its own trilinear blend in `csm_cloudSampleNoise`,
    // so hardware filtering would bleed across the slice seams.
    cache.sampler = device.createSampler({
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    cache.quadVertexBuffer = createQuadVB(device);

    const bgl = makeBindGroupLayout(device, "Cloud BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
    ]);
    // Retain the group-0 layout so the per-slice resolver can rebuild the
    // bind group.
    cache.bindGroupLayout = bgl;

    // Descriptor-only construction: the pipeline itself materializes through
    // `webgpuPipelineCache`, so two CloudCollections sharing a descriptor
    // share a single `GPURenderPipeline`. The descriptor is held on the cache
    // sidecar so re-resolution attempts use a stable key, the cache key being
    // a hash of the full descriptor shape.
    //
    // The scene framebuffer's MSAA sample count is baked into the pipeline, as
    // it is for billboards. Left at the default of 1 it fails attachment-state
    // validation against the MSAA scene framebuffer pass, and that invalidates
    // the entire pass encoder, so a single cloud blanks every other primitive
    // in the scene. `ms=` is keyed into the name so the central pipeline cache
    // distinguishes sample-count variants.
    const sampleCount =
      (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
    cache.pipelineDescriptor = {
      name: `CloudCollection pipeline [${canvasFormat}/ms=${sampleCount}/ld=${logDepthActive ? 1 : 0}]`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: cache.shaderModule,
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
            arrayStride: 68,
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
              {
                shaderLocation: 4,
                offset: 40,
                format: "float32x4" as GPUVertexFormat,
              },
              {
                shaderLocation: 5,
                offset: 56,
                format: "float32x3" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: cache.shaderModule,
        entryPoint: "fragmentMain",
        // Routed through `makeSceneFBTargets` so a second scene-framebuffer
        // slot is picked up automatically. The blend is spelled out without an
        // `operation` field, which keeps the pipeline-cache hash for this
        // shader stable. The velocity pipeline below targets rg16float, the
        // TAA velocity texture, rather than the scene framebuffer, and stays
        // single-target.
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
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        // less-equal for planetary-scale precision robustness — see
        // the matching comment in WebGPUBufferPrimitiveRenderer.
        depthCompare: "less-equal",
      },
      multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
    };

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer } },
        { binding: 1, resource: cache.noiseTextureView! },
        { binding: 2, resource: cache.sampler! },
      ],
    });

    cache.initialized = true;
  }

  // Resolve the pipeline through the central cache. The first frame kicks off
  // async creation and returns false; later frames pick the cached pipeline up
  // synchronously and return true. The draw is skipped until then, so no draw
  // command is ever enqueued with a null pipeline.
  if (!cache.pipeline) {
    const ctxAny = context as unknown as {
      webgpuPipelineCache?: WebGPURenderPipelineCache | null;
    };
    if (
      !tryResolveCloudPipeline(
        device,
        ctxAny.webgpuPipelineCache ?? null,
        cache,
      )
    ) {
      return;
    }
  }

  // Capture the collection's dirty state before the per-frame consume below
  // clears it. `_cloudsToUpdateIndex > 0` covers every property setter routed
  // through `_updateCloud` — show, position, scale, maximumSize, slice,
  // brightness and color — while `_createVertexArray` covers add, remove and
  // removeAll. Count changes are already caught by the count gate, but a
  // same-frame add and remove nets to an equal count with different members.
  const dirtyState = collection as unknown as {
    _cloudsToUpdateIndex?: number;
    _createVertexArray?: boolean;
  };
  const hasDirtyEdits =
    (dirtyState._cloudsToUpdateIndex ?? 0) > 0 ||
    dirtyState._createVertexArray === true;

  // Rebuild the instance buffer when clouds change: either a count change or
  // a per-cloud property edit. Keying on the count alone leaves property edits
  // — position, scale, brightness, color — never re-uploaded, so they render
  // stale indefinitely.
  const cloudCount = collection.length;
  if (cloudCount !== cache.lastCloudCount || hasDirtyEdits) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, collection);
    cache.instanceBuffer = result.buffer;
    cache.instanceCount = result.count;
    cache.lastCloudCount = cloudCount;
    cache.command = null;
    // Track this frame's instance data so the velocity helper can promote it
    // to `prevInstanceData` after its dispatch. `attachCloudVelocityCommand`
    // documents the first-frame-seed and count-mismatch cases.
    cache.instanceData = result.instanceData;
    // The single `instanceBuffer` content-write site, reached on a count
    // change or on a property edit through the dirty-state gate. Bumping the
    // revision makes the velocity prev buffer re-seed once for this content
    // and then skip the per-frame uploads.
    cache.instanceDataRevision++;
  }

  // The WebGPU renderer replaces the WebGL vertex build, so CloudCollection's
  // per-cloud `_dirty`, `_cloudsToUpdateIndex`, `_createVertexArray` and
  // `_propertiesChanged` are never cleared on this path: settled clouds are
  // re-dirtied every frame and the update queue grows without bound. The
  // consume therefore runs every frame, not only on a rebuild.
  //
  // The ordering is load-bearing. The rebuild gate above reads
  // `_cloudsToUpdateIndex` and `_createVertexArray` before this consume clears
  // them, so moving this call above the gate silently disables the gate.
  if (typeof collection._consumeDirtyState === "function") {
    collection._consumeDirtyState();
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Pack camera uniforms.
  //
  // RTE: zero the translation column of the view matrix *before* multiplying
  // by projection. Zeroing column 3 of the result after the multiply wipes out
  // projection's P23 depth-mapping term and produces incorrect NDC depth. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye` for the
  // canonical pattern.
  //
  // The body is a closure so the per-slice resolver can re-invoke it at draw
  // time against the slice's refreshed `uniformState.view` and `.projection`.
  // It is called once here to fill the single-frustum buffer, then again per
  // slice by the resolver into the slice's own buffer.
  const us = context.uniformState;
  const packCloud = (data: Float32Array): void => {
    const view = us.view;
    const proj = us.projection;
    Matrix4.clone(view, scratchMVRTE);
    scratchMVRTE[12] = 0;
    scratchMVRTE[13] = 0;
    scratchMVRTE[14] = 0;
    const mvp = m4Values(Matrix4.multiply(proj, scratchMVRTE, scratchMVP));
    for (let i = 0; i < 16; i++) {
      data[i] = mvp[i];
    }

    const camWorld = us.cameraPosition;
    EncodedCartesian3.fromCartesian(camWorld, scratchEncoded);
    data[16] = scratchEncoded.high.x;
    data[17] = scratchEncoded.high.y;
    data[18] = scratchEncoded.high.z;
    // Projection diagonal for metre-based quad sizing: column-major m00 and
    // m11. Valid for both perspective (3D) and orthographic (2D and Columbus
    // view) frusta.
    data[19] = proj[0];
    data[20] = scratchEncoded.low.x;
    data[21] = scratchEncoded.low.y;
    data[22] = scratchEncoded.low.z;
    data[23] = proj[5];

    const canvas = context._canvas || { width: 1920, height: 1080 };
    data[24] = canvas.width;
    data[25] = canvas.height;
    data[26] = frameState.frameNumber * 0.016; // approximate time for animation
    data[27] = 0;

    // Previous view-projection at floats 28 to 43. `UniformState` assigns
    // `_previousViewProjection` from `viewProjection` at the end of
    // `update()`, after returning the prior frame's value, so on frame N this
    // slot holds frame N-1's matrix. The first frame falls through to
    // identity.
    const prevVP = (us as { previousViewProjection?: Matrix4 })
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
    // Renderer-wide log depth — (near, far, factor) from the same encode
    // frustum every producer packs (uniformState.currentFrustum at
    // scene-update time). Unconditional; only the LOG_DEPTH variant reads it.
    const usLog = us as unknown as {
      currentFrustum?: { x: number; y: number };
      oneOverLog2FarDepthFromNearPlusOne?: number;
    };
    const ldNear = usLog.currentFrustum?.x ?? 0.0;
    const ldFar = usLog.currentFrustum?.y ?? 0.0;
    let ldFactor =
      typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
        ? usLog.oneOverLog2FarDepthFromNearPlusOne
        : 0.0;
    if (!(ldFactor > 0.0) && ldFar > ldNear) {
      const log2Far = Math.log2(ldFar - ldNear + 1.0);
      ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    }
    data[44] = ldNear;
    data[45] = ldFar;
    data[46] = ldFactor;
    data[47] = 0.0;
  };

  const data = new Float32Array(48);
  packCloud(data);
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  // Per-slice camera uniform-buffer resolver. Group 0 carries the camera
  // uniform buffer at binding 0 plus the noise texture and sampler at bindings
  // 1 and 2, which are created once at init and never change, so the resolver
  // rebuilds group 0 from the slice's own buffer and those same texture
  // references as extra entries. The static `cache.bindGroup` is the
  // single-frustum fallback.
  if (!cache.cameraUB) {
    cache.cameraUB = new WebGPUCollectionCameraUB(device, "Cloud");
  }
  cache.cameraUB.bindUniformState(us);
  const cloudCameraResolver = cache.cameraUB.makeResolver({
    bufferSize: 192, // 48 floats packed; buffer aligned to 256 by helper
    bindGroupLayout: cache.bindGroupLayout!,
    pack: packCloud,
    extraEntries: [
      { binding: 1, resource: cache.noiseTextureView! },
      { binding: 2, resource: cache.sampler! },
    ],
  });

  // Both the quad and instance vertex buffers have to be live at the
  // render-pass boundary; a null here hands the WebGPU validation layer a draw
  // with no vertex buffer. The draw is skipped for this frame instead, and the
  // failure is logged unconditionally.
  if (
    !validateDrawTargets(
      [cache.quadVertexBuffer, cache.instanceBuffer],
      "CloudCollection",
    )
  ) {
    return;
  }

  // Each cloud instance reads 68 bytes (`arrayStride: 68`), so the drawn
  // instance count is clamped to what the instance buffer physically holds:
  // a drift between `instanceCount` and the last buffer growth would otherwise
  // issue an out-of-range instanced draw. On the happy path the buffer is
  // sized for the full slot count and the clamp is inert.
  const safeCloudInstanceCount = validateInstancedDrawBuffer(
    cache.instanceBuffer,
    cache.instanceCount,
    68,
    "CloudCollection",
  );

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      bindGroupResolvers: [cloudCameraResolver],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: safeCloudInstanceCount,
      pass: Pass.TRANSLUCENT,
    });
  } else {
    // `cache.command` is built once; the resolver is refreshed each frame so
    // it re-packs against this frame's camera and the current texture
    // references.
    (cache.command as { bindGroupResolvers?: unknown[] }).bindGroupResolvers = [
      cloudCameraResolver,
    ];
  }

  // Forward CloudCollection's `_rs` so the translucent cloud pass uses the
  // same alpha-blend and depth-test configuration as the WebGL path. Written
  // per frame rather than only at command creation, because the collection can
  // rebuild its render state.
  (cache.command as { renderState?: unknown }).renderState = (
    collection as unknown as { _rs?: unknown }
  )._rs;

  // Maintain a one-frame-lagged mirror of the instance buffer so the velocity
  // vertex shader reads current and previous position pairs.
  attachCloudVelocityCommand(device, context, frameState, cache);

  // Exclusive volumetric toggle. A collection whose `renderMode` is
  // `CloudRenderMode.VOLUMETRIC` (1) drives the full-screen volumetric deck
  // published from `CloudCollection.update` and suppresses its own billboards.
  // The buffer and dirty-state bookkeeping above still runs, so
  // `_consumeDirtyState` clears each frame and the instance buffer stays
  // coherent for a flip back to billboards; only the draw command is withheld
  // from the command list. In the default billboard mode the value is 0, the
  // guard is false, and the push happens.
  const CLOUD_RENDER_MODE_VOLUMETRIC = 1;
  const collectionRenderMode = (
    collection as unknown as { renderMode?: number }
  ).renderMode;
  if (collectionRenderMode === CLOUD_RENDER_MODE_VOLUMETRIC) {
    return;
  }

  commandList.push(cache.command);
}

/**
 * Upload previous positions, build or fetch the velocity pipeline, and attach
 * `velocityCommand` to the cache's color command. The TAA pass walks the
 * command list for `cmd.velocityCommand` and dispatches it into the rg16float
 * velocity texture. Mirrors the point-cloud renderer.
 *
 * Skipped entirely when TAA is off and no prev buffer has been allocated yet,
 * which keeps the off path free.
 *
 * Two cases fall into the GPU self-copy below:
 *   1. The first frame, where `prevInstanceData` is null. Seeding by copying
 *      current onto previous makes this frame emit a velocity of zero; the
 *      promotion at the end of this function then captures this frame's data
 *      as previous, so the next frame has a real delta.
 *   2. A cloud-count change, where the collection added or removed clouds
 *      across frames. The prev buffer carries the old count's data, and the
 *      self-copy emits a velocity of zero for the transition — correct,
 *      because there is no index correspondence between the old and new
 *      clouds at the same slot. Subsequent frames at the new count resume
 *      real delta capture.
 *
 * @private
 */
function attachCloudVelocityCommand(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  cache: CloudCache,
): void {
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

  const requiredBytes = cache.instanceCount * 68;
  if (
    !cache.prevInstanceBuffer ||
    cache.prevInstanceBuffer.size < requiredBytes
  ) {
    if (cache.prevInstanceBuffer) {
      cache.prevInstanceBuffer.destroy();
    }
    cache.prevInstanceBuffer = device.createBuffer({
      label: "Cloud prev instances",
      size: requiredBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // The prev buffer was reallocated, so the resident revision is stale.
    cache.prevBufferRevision = undefined;
  }

  // Revision skip plus GPU self-copy.
  const prevSrc = cache.prevInstanceData;
  const isIdentity = prevSrc === cache.instanceData; // static: prev IS curr
  if (
    isIdentity &&
    cache.prevInstanceBuffer &&
    cache.prevInstanceBuffer.size >= requiredBytes
  ) {
    // Identity case, meaning static clouds: the bytes already reside in
    // `instanceBuffer` on the GPU. Seed `prevInstanceBuffer` from it once,
    // then skip while the data revision is unchanged. Geometry velocity is
    // zero either way.
    if (cache.prevBufferRevision !== cache.instanceDataRevision) {
      const encoder = device.createCommandEncoder({
        label: "Cloud prev identity-seed",
      });
      encoder.copyBufferToBuffer(
        cache.instanceBuffer,
        0,
        cache.prevInstanceBuffer,
        0,
        requiredBytes,
      );
      device.queue.submit([encoder.finish()]);
      cache.prevBufferRevision = cache.instanceDataRevision;
    }
    // Otherwise the content is static and already resident, so nothing is
    // uploaded; that is where the per-frame saving comes from.
  } else if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    // Animated path, where previous and current are distinct arrays.
    device.queue.writeBuffer(
      cache.prevInstanceBuffer,
      0,
      prevSrc.buffer,
      prevSrc.byteOffset,
      requiredBytes,
    );
    cache.prevBufferRevision = undefined;
  } else {
    // First-frame seed or count mismatch, handled by a GPU copy.
    const encoder = device.createCommandEncoder({
      label: "Cloud prev seed",
    });
    encoder.copyBufferToBuffer(
      cache.instanceBuffer,
      0,
      cache.prevInstanceBuffer,
      0,
      requiredBytes,
    );
    device.queue.submit([encoder.finish()]);
    cache.prevBufferRevision = undefined;
  }

  // Lazy velocity pipeline build. It reuses the color bind-group layout
  // because the velocity vertex shader reads the same uniform buffer, whose
  // camera struct carries `prevViewProjection`.
  if (!cache.velocityPipelineDescriptor && cache.shaderModule) {
    // The velocity pipeline shares the color pipeline's layout (BGL).
    // Pull it from the existing color descriptor for layout consistency.
    const layout = cache.pipelineDescriptor?.layout;
    if (layout) {
      cache.velocityPipelineDescriptor = {
        name: `CloudCollection velocity pipeline [ld=${
          (cache as unknown as { _logDepthEnabled?: boolean })
            ._logDepthEnabled === true
            ? 1
            : 0
        }]`,
        layout,
        vertex: {
          module: cache.shaderModule,
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
              arrayStride: 68,
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
                {
                  shaderLocation: 4,
                  offset: 40,
                  format: "float32x4" as GPUVertexFormat,
                },
              ],
            },
            {
              // Prev-position stream (positions only — locs 5/6 of
              // the same 68-byte stride; color/scale/maximumSize at offset
              // 24+ are ignored by the velocity VS).
              arrayStride: 68,
              stepMode: "instance" as GPUVertexStepMode,
              attributes: [
                {
                  shaderLocation: 5,
                  offset: 0,
                  format: "float32x3" as GPUVertexFormat,
                },
                {
                  shaderLocation: 6,
                  offset: 12,
                  format: "float32x3" as GPUVertexFormat,
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
      // Fallback synchronous creation when no central cache.
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
    cache.prevInstanceBuffer &&
    cache.quadVertexBuffer
  ) {
    // Clamp the velocity instanced draw to what the current and previous
    // instance buffers hold, at 68 bytes per instance. The prev buffer is
    // grown to `instanceCount * 68` just above, so this is inert on the happy
    // path.
    const safeVelocityInstanceCount = validateInstancedDrawBuffer(
      cache.instanceBuffer,
      cache.instanceCount,
      68,
      "CloudCollection velocity",
    );
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      new WebGPUDrawCommand({
        pipeline: cache.velocityPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: [
          cache.quadVertexBuffer,
          cache.instanceBuffer,
          cache.prevInstanceBuffer,
        ],
        vertexCount: 6,
        instanceCount: safeVelocityInstanceCount,
        pass: Pass.TRANSLUCENT,
      });
  } else if (cache.command) {
    (cache.command as { velocityCommand?: unknown }).velocityCommand =
      undefined;
  }

  // Promote `instanceData` → `prevInstanceData` for next frame.
  if (cache.instanceData) {
    cache.prevInstanceData = cache.instanceData;
  }
}

function destroyWebGPUCloudResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as CloudCache | undefined;
  if (!cache) {
    return;
  }
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  cache.uniformBuffer?.destroy();
  cache.noiseTexture?.destroy();
  // Release the velocity-path GPU buffer.
  cache.prevInstanceBuffer?.destroy();
  collection._webgpuCache = undefined;
}

export { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
export default { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
