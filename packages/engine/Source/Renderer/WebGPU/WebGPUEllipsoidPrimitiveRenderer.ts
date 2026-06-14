/**
 * WebGPU Ellipsoid Primitive Renderer
 *
 * Renders ray-cast ellipsoid primitives using WebGPU. Each ellipsoid is
 * rendered as a radii-scaled bounding-box geometry (Batch 269 — matching
 * WebGL EllipsoidVS; replaced the old FOV-less screen quad) whose rasterized
 * eye-space surface hands the fragment shader a correct per-pixel eye->surface
 * ray for analytical ray-ellipsoid intersection. Uses RTE (Relative-To-Eye)
 * positioning for planetary-scale precision; the world transform comes from
 * the Scene's `_computedModelMatrix` (modelMatrix * translate(center)).
 *
 * @module WebGPUEllipsoidPrimitiveRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
// Slice 5c-B Phase 1 (Batch 111) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
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
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 185) — per-device module cache.
// EllipsoidPrimitive is typically few-per-scene; the dedup win is
// modest but the cache unifies the pattern across the renderer family.
const _ellipsoidPrimitiveShaderCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getEllipsoidPrimitiveShaderCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _ellipsoidPrimitiveShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _ellipsoidPrimitiveShaderCaches.set(device, cache);
  }
  return cache;
}

interface EllipsoidCache {
  uniformBuffer: GPUBuffer | null;
  ellipsoidUniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  pickPipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup0: GPUBindGroup | null;
  bindGroup1: GPUBindGroup | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  command: CesiumAnyDrawCommand | null;
  pickCommand: CesiumAnyDrawCommand | null;
  initialized: boolean;
  // C-R7-RENDERER-MIGRATION (Batch 56) — once pipeline-cache routing is
  // engaged the color + pick pipelines arrive asynchronously via
  // `WebGPURenderPipelineCache.getPipeline()`. We track whether the
  // request is already in flight so subsequent frames don't re-issue it,
  // and skip drawing on frames where the pipelines aren't materialized
  // yet (matches `getPipelineSync()` returning undefined).
  pipelineRequestPending: boolean;
}

// Inline WGSL for ray-marched ellipsoid
const ELLIPSOID_WGSL = `
struct CameraUniforms {
  modelViewProjectionRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: f32,
  _pad3: f32,
  // DP-H41 (Batch 27) — previous frame's viewProjection for
  // TAA / motion-vector reprojection. Sourced from
  // UniformState._previousViewProjection (f32 mat4).
  previousViewProjection: mat4x4<f32>,
  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — the camera projection
  // matrix (uniformState.projection) so the ray-cast FS can recover the
  // eye-space hit's clip-space w (= eye distance) for log/hyperbolic
  // depth. WebGL EllipsoidFS does positionCC = czm_projection *
  // vec4(positionEC, 1.0); the FS mirrors that here.
  projection: mat4x4<f32>,
  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — renderer-wide log depth
  // lanes: (near, far, oneOverLog2FarDepthFromNearPlusOne, reserved).
  // Packed unconditionally by packCameraUniforms; only the //>>ifdef
  // LOG_DEPTH FS branch reads it. See WebGPULogDepth.ts.
  logDepth: vec4<f32>,
};

//>>ifdef LOG_DEPTH
// Renderer-wide log depth (NEW-ELLIPSOIDPRIM-LOG-DEPTH) — canonical inline
// copies; see chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
// The ellipsoid is a full-screen ray-cast, so depth is computed entirely
// in the FS from the eye-space hit point (no v_logDepth varying).
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

struct EllipsoidUniforms {
  radii: vec3<f32>,
  _pad0: f32,
  oneOverRadiiSq: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
  centerHigh: vec3<f32>,
  _pad2: f32,
  centerLow: vec3<f32>,
  _pad3: f32,
  // C-R9 (Batch 30) — pick color output for the pick FBO. Always written
  // but only read by the fragmentPickMain entry point.
  pickColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> ellipsoid: EllipsoidUniforms;

struct VertexInput {
  // BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE (Batch 269) — bounding-box geometry,
  // matching WebGL EllipsoidVS. The cube spans (-1,-1,-1)..(1,1,1) in the
  // ellipsoid's MODEL frame; the VS scales it by radii so it encloses the
  // shell, and the rasterizer hands the FS exactly the screen coverage the
  // ray-cast needs. Pre-Batch-269 this was a full-screen 2D quad with a
  // FOV-less fake eyeDirection (x*aspect, y, -1) that never matched the real
  // camera ray, so the intersection test produced 0 fragments.
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  // Box-surface position in EYE coordinates (mirrors WebGL v_positionEC).
  // normalize(positionEC) in the FS is the per-pixel eye->surface ray.
  @location(0) positionEC: vec3<f32>,
  // Ellipsoid center in EYE coordinates. With _computedModelMatrix folding
  // in the center, the ellipsoid origin in the model frame is (0,0,0), so the
  // center RTE offset reduces to (-camHigh) + (-camLow).
  @location(1) ellipsoidCenter: vec3<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Box-surface position in the ellipsoid's MODEL frame, scaled by radii.
  // radii-scale (~km) is small + exact in f32 — the planetary-scale
  // translation lives in modelViewRelativeToEye + the RTE camera split.
  let positionMC = ellipsoid.radii * input.position;

  // Model-space RTE: subtract the high/low-split camera position (already in
  // the model frame; packCameraUniforms encodes invModel * cameraWorld). The
  // box vertex is exact so its low part is zero.
  let positionRTE = (positionMC - camera.encodedCameraPositionMCHigh)
                  - camera.encodedCameraPositionMCLow;
  let positionEye = (camera.modelViewRelativeToEye * vec4<f32>(positionRTE, 1.0)).xyz;
  output.positionEC = positionEye;

  // Ellipsoid center (model-frame origin) in eye space.
  let centerRTE = (-camera.encodedCameraPositionMCHigh) - camera.encodedCameraPositionMCLow;
  output.ellipsoidCenter = (camera.modelViewRelativeToEye * vec4<f32>(centerRTE, 1.0)).xyz;

  // Project the eye-space box surface. modelViewProjectionRelativeToEye =
  // projection * modelViewRelativeToEye, so this is projection * positionEye.
  output.position = camera.modelViewProjectionRelativeToEye * vec4<f32>(positionRTE, 1.0);
  return output;
}

fn intersectEllipsoid(
  rayOrigin: vec3<f32>, rayDir: vec3<f32>,
  center: vec3<f32>, oneOverRadiiSq: vec3<f32>
) -> vec2<f32> {
  let oc = rayOrigin - center;
  let sqrtOORS = sqrt(oneOverRadiiSq);
  let ocScaled = oc * sqrtOORS;
  let dirScaled = rayDir * sqrtOORS;
  let a = dot(dirScaled, dirScaled);
  let b = 2.0 * dot(dirScaled, ocScaled);
  let c = dot(ocScaled, ocScaled) - 1.0;
  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) { return vec2<f32>(-1.0, -1.0); }
  let sd = sqrt(disc);
  return vec2<f32>((-b - sd) / (2.0 * a), (-b + sd) / (2.0 * a));
}

// Slice 5c-B Batch 118 — G-buffer MRT output struct for the color
// pipeline. Slot 0 = lit color (the pre-Batch-118 single output);
// slot 1 = eye-space normal + roughness packed into rgba16float.
// The pick fragment entry below stays single-target — pick uses
// its own pipeline derived via buildPickPipelineDescriptor which
// filters the slot-1 target from the pick FB 1-attachment pass.
struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — the ellipsoid is a full-screen
  // ray-cast quad whose rasterized z is the near plane (z=0); without an
  // explicit frag_depth it would always test as on-top. With renderer-wide
  // log depth ON it MUST write the same log-depth encoding the globe wrote so
  // an ellipsoid shell at altitude depth-tests correctly against the terrain.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(
  @builtin(position) fragPos: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
) -> FragOutput {
  // The eye is at the origin in eye space; the ray points from the eye
  // toward the rasterized box-surface position (mirrors WebGL
  // normalize(v_positionEC)).
  let rayDir = normalize(positionEC);
  let t = intersectEllipsoid(vec3<f32>(0.0), rayDir, ellipsoidCenter, ellipsoid.oneOverRadiiSq);
  if (t.x < 0.0 && t.y < 0.0) { discard; }
  var tHit = t.x;
  if (tHit < 0.0) { tHit = t.y; }
  if (tHit < 0.0) { discard; }
  let hit = rayDir * tHit;
  // Eye-space normal. (hit - center) * oneOverRadiiSq gives the
  // ellipsoidal-corrected outward normal; both hit and ellipsoidCenter
  // are already in eye-space (vertex stage projects via
  // modelViewRelativeToEye), so n is directly the eye-space normal
  // the G-buffer expects.
  let n = normalize((hit - ellipsoidCenter) * ellipsoid.oneOverRadiiSq);
  let lightDir = normalize(vec3<f32>(0.5, 1.0, 0.3));
  let NdotL = max(dot(n, lightDir), 0.0);
  let col = ellipsoid.color.rgb * (0.3 + 0.7 * NdotL);
  // 0.5 roughness placeholder — ellipsoid uniforms don't carry a
  // material roughness yet. Update when EllipsoidUniforms grows a
  // material slot.
  var out: FragOutput;
  out.color = vec4<f32>(col, ellipsoid.color.a);
  out.normalRoughness = vec4<f32>(n, 0.5);
  //>>ifdef LOG_DEPTH
  // Recover the eye-space hit's clip-space w (= eye distance) via the camera
  // projection, then encode log depth with the SAME (near, factor) the globe
  // used. Mirrors WebGL EllipsoidFS's WRITE_DEPTH/LOG_DEPTH block, but uses the
  // renderer-wide csm_vertexLogDepth ((w - near) + 1) convention so the value
  // composes with the globe + collections rather than WebGL's idiosyncratic
  // (1 + w) ray-cast form.
  let positionCC = camera.projection * vec4<f32>(hit, 1.0);
  out.depth = csm_writeLogDepth(
    csm_vertexLogDepth(positionCC, camera.logDepth.x),
    camera.logDepth.z,
  );
  //>>endif
  return out;
}

// C-R9 (Batch 30) — pick entry point. Same ray-ellipsoid intersection +
// discard as the color pass, but outputs the pick color instead of the
// lit material. The pick FBO readback maps this color back to the
// {primitive, id} target registered at creation time.
@fragment
fn fragmentPickMain(
  @builtin(position) fragPos: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) ellipsoidCenter: vec3<f32>,
) -> @location(0) vec4<f32> {
  let rayDir = normalize(positionEC);
  let t = intersectEllipsoid(vec3<f32>(0.0), rayDir, ellipsoidCenter, ellipsoid.oneOverRadiiSq);
  if (t.x < 0.0 && t.y < 0.0) { discard; }
  var tHit = t.x;
  if (tHit < 0.0) { tHit = t.y; }
  if (tHit < 0.0) { discard; }
  return ellipsoid.pickColor;
}
`;

// Scratch objects for RTE encoding
const scratchEncodedPosition = {
  high: new Cartesian3(),
  low: new Cartesian3(),
};
const scratchMVP = new Matrix4();
const scratchMV = new Matrix4();

// BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE (Batch 269) — unit bounding cube spanning
// (-1,-1,-1)..(1,1,1), matching WebGL's BoxGeometry.fromDimensions({2,2,2}).
// The VS scales each vertex by radii so the box encloses the ellipsoid shell;
// the rasterized box surface gives the FS correct per-pixel eye->surface rays.
// 36 indices (12 triangles, 2 per face). cullMode "back" (Batch 276) rasterizes
// exactly ONE box face per pixel so the ray-cast FS runs once — matching WebGL's
// CullFace.FRONT single-rasterization (fixes translucent double-blend). The FS
// ray-casts to the near ellipsoid surface (t.x) from whichever face rasterizes,
// so coverage is identical to the prior cullMode "none".
const ELLIPSOID_BOX_INDEX_COUNT = 36;

function createBoxGeometry(device: GPUDevice): {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
} {
  // 8 corners of the unit cube.
  const vertices = new Float32Array([
    -1.0,
    -1.0,
    -1.0, // 0
    1.0,
    -1.0,
    -1.0, // 1
    1.0,
    1.0,
    -1.0, // 2
    -1.0,
    1.0,
    -1.0, // 3
    -1.0,
    -1.0,
    1.0, // 4
    1.0,
    -1.0,
    1.0, // 5
    1.0,
    1.0,
    1.0, // 6
    -1.0,
    1.0,
    1.0, // 7
  ]);
  // 12 triangles (winding is irrelevant — cullMode is "none").
  const indices = new Uint16Array([
    0,
    1,
    2,
    0,
    2,
    3, // -z
    4,
    6,
    5,
    4,
    7,
    6, // +z
    0,
    4,
    5,
    0,
    5,
    1, // -y
    3,
    2,
    6,
    3,
    6,
    7, // +y
    0,
    3,
    7,
    0,
    7,
    4, // -x
    1,
    5,
    6,
    1,
    6,
    2, // +x
  ]);

  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, gpuData(vertices));

  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, gpuData(indices));

  return { vertexBuffer, indexBuffer };
}

// Vertex buffer layout shared by the color + pick pipelines. Defined once
// here so the cache-key signature in `WebGPURenderPipelineCache` (which
// hashes the full `vertex.buffers[]` shape) matches across both descriptor
// requests — otherwise the cache would treat them as different layouts.
const ELLIPSOID_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    // BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE (Batch 269) — box geometry is vec3
    // position (12-byte stride), was vec2 (8-byte) for the old screen quad.
    arrayStride: 12,
    attributes: [
      {
        shaderLocation: 0,
        offset: 0,
        format: "float32x3" as GPUVertexFormat,
      },
    ],
  },
];

interface EllipsoidPipelineResources {
  shaderModule: GPUShaderModule;
  bindGroupLayout0: GPUBindGroupLayout;
  bindGroupLayout1: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  colorDescriptor: WebGPURenderPipelineDescriptor;
  pickDescriptor: WebGPURenderPipelineDescriptor;
}

/**
 * Build the synchronous resources (shader module, BGLs, pipeline layout)
 * and the descriptor objects passed to `WebGPURenderPipelineCache`.
 * The cache materializes the actual `GPURenderPipeline` objects asynchronously.
 *
 * C-R7-RENDERER-MIGRATION (Batch 56). Previously this function called
 * `device.createRenderPipeline()` twice — once per primitive instance
 * regardless of whether two ellipsoids shared identical pipeline state.
 * Routing through the central cache means two ellipsoids with identical
 * descriptors share a single `GPURenderPipeline`.
 */
function buildEllipsoidPipelineResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  sampleCount: number = 1,
  logDepthActive: boolean = false,
): EllipsoidPipelineResources {
  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — OR in LOG_DEPTH when active so
  // the module cache compiles the //>>ifdef LOG_DEPTH FS branch (projection-
  // recovered eye distance → log frag_depth). defines=0 emits the //>>else
  // (no frag_depth → rasterized near-plane z), byte-identical to pre-fix.
  const defines = logDepthActive ? ShaderDefine.LOG_DEPTH : 0;
  const shaderModule = getEllipsoidPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.ELLIPSOID_PRIMITIVE,
    ELLIPSOID_WGSL,
    defines,
    `EllipsoidPrimitive${logDepthActive ? " [log]" : ""}`,
  );

  const bindGroupLayout0 = makeBindGroupLayout(
    device,
    "EllipsoidPrimitive BGL 0",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const bindGroupLayout1 = makeBindGroupLayout(
    device,
    "EllipsoidPrimitive BGL 1",
    [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
  );

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1],
  });

  const colorDescriptor: WebGPURenderPipelineDescriptor = {
    name: "EllipsoidPrimitive color pipeline",
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: ELLIPSOID_VERTEX_BUFFERS,
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Slice 5c-B Batch 118 — emit G-buffer slot 1 (eye-space normal +
      // roughness). The shader emits `FragOutput { color, normalRoughness }`
      // and the pipeline declares slot 1 as writable (writeMask: 0xf via
      // `emitsGBuffer: true`). Pick pipeline is derived from this via
      // `buildPickPipelineDescriptor` which filters out the rgba16float
      // slot 1 so the pick FB's 1-attachment pass stays compatible.
      targets: makeSceneFBTargets(canvasFormat, {
        emitsGBuffer: true,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    // BUG-ELLIPSOIDPRIM-WEBGPU-TRANSLUCENT-DOUBLE-BLEND (Batch 276) — rasterize
    // only ONE box face per pixel (was cullMode "none", which let both the near
    // and far box face survive). For opaque the second fragment overwrites
    // identically (harmless), but a translucent shell (alpha < 1) would blend
    // twice. WebGL's EllipsoidPrimitive cuts this with `CullFace.FRONT`
    // (single rasterization); we mirror that with backface culling here. The FS
    // ray-casts to the NEAR ellipsoid surface (`t.x`) from whichever face
    // rasterizes, and the box silhouette is identical from either face set, so
    // coverage is unchanged (verified: opaque green-pixel count is byte-identical
    // to the prior cullMode "none"). NOTE: the dominant double-blend on this
    // primitive came from the command carrying NO boundingVolume and NOT being
    // flagged executeInClosestFrustum — a no-BV command bins into EVERY frustum
    // slice (2 by default) and draws once per slice; that is fixed below by
    // mirroring WebGL's boundingVolume + executeInClosestFrustum + Pass wiring.
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
    // Slice 5c-B Batch 118 — match scene-FB MSAA sample count. Pre-fix
    // this defaulted to sampleCount=1 against an MSAA=4 scene FB pass,
    // tripping "Attachment state not compatible" the moment an
    // EllipsoidPrimitive landed in a scene with default `msaaSamples=4`.
    // The DeveloperError ("_beginDefaultRenderPass called with active
    // render pass") that was the visible failure was downstream — once
    // the EllipsoidPrimitive's pipeline tripped validation, the WebGPU
    // command encoder went invalid and downstream beginRenderPass
    // calls cascaded into the JS-side guard.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  // C-R9 (Batch 30 / refactored Batch 59) — pick pipeline derived from the
  // color descriptor via {@link buildPickPipelineDescriptor}. Same layout,
  // same vertex stage, same depth behaviour; fragment entry swapped to
  // `fragmentPickMain` and blend stripped so pick colors reach the FBO
  // unmodified for byte-exact readback. `forceDepthWriteEnabled: true`
  // matches the historical Batch 30 setting (color path also writes depth).
  const pickDescriptor: WebGPURenderPipelineDescriptor =
    buildPickPipelineDescriptor(colorDescriptor, "fragmentPickMain", {
      name: "EllipsoidPrimitive pick pipeline",
      forceDepthWriteEnabled: true,
    });

  return {
    shaderModule,
    bindGroupLayout0,
    bindGroupLayout1,
    pipelineLayout,
    colorDescriptor,
    pickDescriptor,
  };
}

/**
 * Resolve the color + pick pipelines through the central pipeline cache.
 * If the cache is unavailable (WebGL context, or device not yet present),
 * falls back to direct `device.createRenderPipeline*Async()` so behavior
 * remains unchanged.
 *
 * Returns synchronously when both pipelines are already cached; otherwise
 * kicks off async creation and returns null so the caller can skip the
 * frame and try again next tick.
 */
function tryResolveEllipsoidPipelines(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  resources: EllipsoidPipelineResources,
  cache: EllipsoidCache,
): boolean {
  // Already resolved — nothing to do.
  if (cache.pipeline && cache.pickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    if (colorSync && pickSync) {
      cache.pipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.colorDescriptor),
        pipelineCache.getPipeline(resources.pickDescriptor),
      ])
        .then(([color, pick]) => {
          cache.pipeline = color;
          cache.pickPipeline = pick;
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

  // Fallback: no central cache (e.g. WebGL-backed graphics context). Mirror
  // the historical synchronous path so behavior matches pre-migration.
  cache.pipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
  return true;
}

/**
 * Convert our cache-friendly descriptor back into the WebGPU descriptor
 * shape for the fallback path. Only used when `pipelineCache` is null —
 * i.e. when we couldn't route through the central cache.
 */
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

function packCameraUniforms(
  uniformState: CesiumUniformState,
  modelMatrix: Matrix4 | CesiumMatrix4,
  viewportWidth: number,
  viewportHeight: number,
): Float32Array {
  // 320 bytes = 80 floats: mvpRTE(16) + mvRTE(16) + camHigh(3+1) + camLow(3+1)
  //   + viewport(2+2 pad) + previousViewProjection(16) [DP-H41, Batch 27]
  //   + projection(16) + logDepth(4) [NEW-ELLIPSOIDPRIM-LOG-DEPTH, Batch 266]
  const data = new Float32Array(80);
  const view = uniformState.view;
  const projection = uniformState.projection;

  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term, producing incorrect NDC depth. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  Matrix4.multiply(view, modelMatrix, scratchMV);
  scratchMV[12] = 0;
  scratchMV[13] = 0;
  scratchMV[14] = 0;
  Matrix4.multiply(projection, scratchMV, scratchMVP);
  const mv = m4Values(scratchMV);
  const mvp = m4Values(scratchMVP);

  // MVP relative to eye
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  // ModelView relative to eye
  for (let i = 0; i < 16; i++) {
    data[16 + i] = mv[i];
  }

  // Encoded camera position in model coordinates
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camWorld = uniformState.cameraPosition;
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncodedPosition);
  data[32] = scratchEncodedPosition.high.x;
  data[33] = scratchEncodedPosition.high.y;
  data[34] = scratchEncodedPosition.high.z;
  data[35] = 0; // pad
  data[36] = scratchEncodedPosition.low.x;
  data[37] = scratchEncodedPosition.low.y;
  data[38] = scratchEncodedPosition.low.z;
  data[39] = 0; // pad

  // viewportSize at offset 160 (float index 40)
  data[40] = viewportWidth;
  data[41] = viewportHeight;
  data[42] = 0; // _pad2
  data[43] = 0; // _pad3

  // DP-H41 (Batch 27) — previousViewProjection at slots 44..59 for
  // TAA / motion-vector reprojection. `UniformState.update()` caches
  // last frame's viewProjection before overwriting the current state.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    const prev = m4Values(prevVP);
    for (let i = 0; i < 16; i++) data[44 + i] = prev[i];
  } else {
    data[44] = 1;
    data[45] = 0;
    data[46] = 0;
    data[47] = 0;
    data[48] = 0;
    data[49] = 1;
    data[50] = 0;
    data[51] = 0;
    data[52] = 0;
    data[53] = 0;
    data[54] = 1;
    data[55] = 0;
    data[56] = 0;
    data[57] = 0;
    data[58] = 0;
    data[59] = 1;
  }

  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — camera projection at floats
  // 60..75. The ray-cast FS recovers the eye-space hit's clip-space w
  // (= eye distance) via this projection to encode log/hyperbolic depth.
  const proj = m4Values(projection);
  for (let i = 0; i < 16; i++) {
    data[60 + i] = proj[i];
  }

  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — renderer-wide log-depth lanes
  // at floats 76..79 (near, far, factor, reserved). This UB carries a
  // dedicated `logDepth: vec4` tail (NOT the shared CameraUniforms `.w`-lane
  // convention), so the scalars are written directly here rather than via
  // packCameraLogDepthLanes (which targets floats 51/55/59 of the shared
  // struct — inside this layout's previousViewProjection). Prefer the
  // stashed FULL-frustum encode the globe baked with over the live per-slice
  // currentFrustum so the ellipsoid's depth composes with the globe; see the
  // same pattern in WebGPUBillboardRenderer.packUniforms.
  const ldEncode = (
    uniformState as unknown as { _logDepthEncodeNearFar?: Float32Array | null }
  )._logDepthEncodeNearFar;
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
  data[76] = ldNear;
  data[77] = ldFar;
  data[78] = ldFactor;
  data[79] = 0.0; // reserved

  return data;
}

// 112 bytes = 28 floats: radii(4) + oneOverRadiiSq(4) + color(4)
// + centerHigh(4) + centerLow(4) + pickColor(4) [C-R9, Batch 30]
const ELLIPSOID_UBO_BYTES = 112;
const ELLIPSOID_UBO_FLOATS = ELLIPSOID_UBO_BYTES / 4;

function packEllipsoidUniforms(
  primitive: CesiumObjectWithWebGPUCache,
  pickColor: { red: number; green: number; blue: number; alpha: number } | null,
): Float32Array {
  const data = new Float32Array(ELLIPSOID_UBO_FLOATS);
  const radii = primitive.radii;
  data[0] = radii.x;
  data[1] = radii.y;
  data[2] = radii.z;
  data[3] = 0;

  const oors = primitive._oneOverEllipsoidRadiiSquared;
  data[4] = oors.x;
  data[5] = oors.y;
  data[6] = oors.z;
  data[7] = 0;

  // Color from material or default
  const color = primitive.material?.uniforms?.color;
  if (color) {
    data[8] = color.red ?? color.x ?? 1.0;
    data[9] = color.green ?? color.y ?? 1.0;
    data[10] = color.blue ?? color.z ?? 1.0;
    data[11] = color.alpha ?? color.w ?? 1.0;
  } else {
    data[8] = 1.0;
    data[9] = 1.0;
    data[10] = 1.0;
    data[11] = 1.0;
  }

  // BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE (Batch 269) — the VS now positions the
  // shell entirely through `_computedModelMatrix` (folded into the camera UB's
  // modelViewRelativeToEye + RTE camera split), so the ellipsoid center in the
  // model frame is the ORIGIN. These centerHigh/centerLow slots are retained
  // in the struct for layout stability (add-only) but are no longer read by
  // the shader; zero them. Pre-Batch-268 they carried the bare modelMatrix
  // translation — which double-counted the transform and (with an IDENTITY
  // modelMatrix) was just (0,0,0) anyway, contributing to the invisibility.
  data[12] = 0;
  data[13] = 0;
  data[14] = 0;
  data[15] = 0;
  data[16] = 0;
  data[17] = 0;
  data[18] = 0;
  data[19] = 0;

  // C-R9 (Batch 30) — pick color slot. Zero when the primitive hasn't
  // been pick-registered yet; the pick pass skips the draw in that
  // case, so the zero alpha reaching the pick FBO is benign.
  if (pickColor) {
    data[20] = pickColor.red;
    data[21] = pickColor.green;
    data[22] = pickColor.blue;
    data[23] = pickColor.alpha;
  } else {
    data[20] = 0;
    data[21] = 0;
    data[22] = 0;
    data[23] = 0;
  }

  return data;
}

/**
 * Update WebGPU ellipsoid primitive resources and issue draw commands.
 */
function updateWebGPUEllipsoidPrimitive(
  primitive: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!primitive.show) {
    return;
  }

  // Compute oneOverEllipsoidRadiiSquared if needed
  const radii = primitive.radii;
  if (radii) {
    const oors = primitive._oneOverEllipsoidRadiiSquared;
    if (!oors || oors.x === 0) {
      primitive._oneOverEllipsoidRadiiSquared = new Cartesian3(
        1.0 / (radii.x * radii.x),
        1.0 / (radii.y * radii.y),
        1.0 / (radii.z * radii.z),
      );
    }
  }

  if (!primitive._webgpuCache) {
    primitive._webgpuCache = {
      uniformBuffer: null,
      ellipsoidUniformBuffer: null,
      pipeline: null,
      pickPipeline: null,
      shaderModule: null,
      bindGroup0: null,
      bindGroup1: null,
      vertexBuffer: null,
      indexBuffer: null,
      command: null,
      pickCommand: null,
      initialized: false,
      pipelineRequestPending: false,
    } as EllipsoidCache;
  }

  const cache = primitive._webgpuCache as EllipsoidCache;
  // Batch 110 — ellipsoid primitive draws into scene FB; use
  // scenePipelineFormat (rgba16float in HDR) instead of canvas format.
  const canvasFormat: GPUTextureFormat =
    (
      context as unknown as {
        scenePipelineFormat?: GPUTextureFormat;
      }
    ).scenePipelineFormat ??
    (navigator.gpu.getPreferredCanvasFormat() as GPUTextureFormat);
  // Slice 5c-B Batch 118 — read MSAA sample count so the pipeline's
  // multisample state matches the scene FB pass it draws into.
  const sampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  // Batch 110 — invalidate cached pipeline resources on scene format
  // change (HDR toggle).
  const sceneGen =
    (context as unknown as { _scenePipelineFormatGeneration?: number })
      ._scenePipelineFormatGeneration ?? 0;
  // NEW-ELLIPSOIDPRIM-LOG-DEPTH (Batch 266) — the LOG_DEPTH master switch (or a
  // frame that toggles frameState.useLogDepth) flips the shader define, so the
  // shader module + pipelines must rebuild. Tracked alongside the scene-format
  // generation; mirrors the GroundPrimitive `_pipelineLogDepth` flip guard.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  const cacheGuard = cache as unknown as {
    _pipelineFormatGeneration?: number;
    _pipelineLogDepth?: boolean;
  };
  if (
    cache.initialized &&
    (cacheGuard._pipelineFormatGeneration !== sceneGen ||
      cacheGuard._pipelineLogDepth !== logDepthActive)
  ) {
    (
      cache as EllipsoidCache & {
        _pipelineResources?: EllipsoidPipelineResources;
      }
    )._pipelineResources = undefined;
    cacheGuard._pipelineFormatGeneration = sceneGen;
    cacheGuard._pipelineLogDepth = logDepthActive;
  }

  // C-R7-RENDERER-MIGRATION (Batch 56) — route pipeline creation through
  // the central WebGPURenderPipelineCache. Held on a sidecar so we can
  // re-resolve every frame until both pipelines materialize.
  let resources = (
    cache as EllipsoidCache & {
      _pipelineResources?: EllipsoidPipelineResources;
    }
  )._pipelineResources;

  // Slice 5c-B Batch 118 — pre-existing bug fix. Before this:
  // invalidating `_pipelineResources` on a scene-pipeline-format
  // change left `cache.initialized = true`, so the init block below
  // was SKIPPED and `resources` stayed undefined. The next call to
  // `tryResolveEllipsoidPipelines(..., resources!, ...)` then
  // dereferenced undefined → "Cannot read properties of undefined
  // (reading 'colorDescriptor')" floods the console.error stream
  // until the user dismisses the renderer-error dialog.
  //
  // If resources is undefined here but `cache.initialized` is true,
  // rebuild ONLY the pipeline resources + bind groups. The GPU
  // buffers + quad geometry can be reused — they don't depend on the
  // scene FB format. The pipeline cache will pick up the new
  // descriptor variants and async-create matching pipelines.
  if (cache.initialized && !resources) {
    resources = buildEllipsoidPipelineResources(
      device,
      canvasFormat,
      sampleCount,
      logDepthActive,
    );
    (
      cache as EllipsoidCache & {
        _pipelineResources?: EllipsoidPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;
    cache.bindGroup0 = device.createBindGroup({
      layout: resources.bindGroupLayout0,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer! } }],
    });
    cache.bindGroup1 = device.createBindGroup({
      layout: resources.bindGroupLayout1,
      entries: [
        { binding: 0, resource: { buffer: cache.ellipsoidUniformBuffer! } },
      ],
    });
    // Force pipeline re-resolution: the cached pipelines were keyed on
    // the OLD descriptor; new descriptor will cache-miss and async-
    // create against the new scene FB format.
    cache.pipeline = null;
    cache.pickPipeline = null;
    cache.pipelineRequestPending = false;
  }

  // One-time initialization of CPU-side resources (buffers, BGLs, shader,
  // pipeline-layout, bind groups, and the quad geometry). The pipelines
  // themselves are resolved separately via the central cache below.
  if (!cache.initialized) {
    // Camera UBO: 80 floats × 4 = 320 bytes (mvpRTE + mvRTE + camHigh/Low +
    //   viewport + previousViewProjection [DP-H41, Batch 27] + projection +
    //   logDepth [NEW-ELLIPSOIDPRIM-LOG-DEPTH, Batch 266])
    cache.uniformBuffer = device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ellipsoid UBO: 28 floats × 4 = 112 bytes (radii + oneOverRadiiSq +
    //   color + center + pickColor [C-R9, Batch 30])
    cache.ellipsoidUniformBuffer = device.createBuffer({
      size: ELLIPSOID_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    resources = buildEllipsoidPipelineResources(
      device,
      canvasFormat,
      sampleCount,
      logDepthActive,
    );
    (
      cache as EllipsoidCache & {
        _pipelineResources?: EllipsoidPipelineResources;
      }
    )._pipelineResources = resources;
    cache.shaderModule = resources.shaderModule;

    // Create bind groups
    cache.bindGroup0 = device.createBindGroup({
      layout: resources.bindGroupLayout0,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });
    cache.bindGroup1 = device.createBindGroup({
      layout: resources.bindGroupLayout1,
      entries: [
        { binding: 0, resource: { buffer: cache.ellipsoidUniformBuffer } },
      ],
    });

    // Create bounding-box geometry (replaces the old screen quad).
    const geom = createBoxGeometry(device);
    cache.vertexBuffer = geom.vertexBuffer;
    cache.indexBuffer = geom.indexBuffer;

    cache.initialized = true;
  }

  // Resolve the color + pick pipelines via the central cache. On first
  // frame this kicks off async creation and returns false; subsequent
  // frames pick up the cached pipeline synchronously and return true.
  // We `return` early on the not-yet-ready frames so we don't enqueue
  // a draw command with a null pipeline.
  const ctxAny = context as unknown as {
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  if (
    !tryResolveEllipsoidPipelines(
      device,
      ctxAny.webgpuPipelineCache ?? null,
      resources!,
      cache,
    )
  ) {
    return;
  }

  // Per-frame uniform updates.
  // BUG-ELLIPSOIDPRIM-WEBGPU-INVISIBLE (Batch 269) — use the Scene's
  // `_computedModelMatrix` (= modelMatrix * translate(center)), NOT the bare
  // `modelMatrix`. Scene/EllipsoidPrimitive.js folds `center` into
  // `_computedModelMatrix`; reading the bare modelMatrix dropped `center`
  // entirely, placing every ellipsoid at its model-frame origin (the Earth's
  // center for an IDENTITY modelMatrix) where the camera never sees it.
  const uniformState = context.uniformState;
  const modelMatrix = (primitive._computedModelMatrix ??
    primitive.modelMatrix ??
    Matrix4.IDENTITY) as Matrix4 | CesiumMatrix4;

  const viewportWidth = context.drawingBufferWidth || 1;
  const viewportHeight = context.drawingBufferHeight || 1;
  const cameraData = packCameraUniforms(
    uniformState,
    modelMatrix,
    viewportWidth,
    viewportHeight,
  );
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(cameraData));

  // C-R9 (Batch 30 / refactored Batch 59) — pick ID lifecycle delegated to
  // {@link ensurePickId}. The helper keeps the legacy `_pickId` /
  // `_pickIdLastId` cache slots so external debug tooling sees the same
  // shape; allocation is gated on render/pick passes to mirror WebGL's
  // `Scene/EllipsoidPrimitive.js` lines 377-387.
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
  const ellipsoidData = packEllipsoidUniforms(primitive, pickColor ?? null);
  device.queue.writeBuffer(
    cache.ellipsoidUniformBuffer!,
    0,
    gpuData(ellipsoidData),
  );

  // C-R1 (Batch 35) — forward any WebGL-style renderState set by
  // Scene/EllipsoidPrimitive.js onto the emitted WebGPUDrawCommand so
  // `applyPerEncoderState` (Batch 30) runs stencilRef / blendConstant /
  // viewport / scissor before the draw. Refreshed every frame so a
  // material translucent-state change picks up on the next frame
  // without needing to invalidate the command.
  const primitiveRS = (primitive as unknown as { _rs?: unknown })._rs;

  // BUG-ELLIPSOIDPRIM-WEBGPU-TRANSLUCENT-DOUBLE-BLEND (Batch 276) — mirror
  // Scene/EllipsoidPrimitive.js's command wiring (lines 375-385). A command
  // with NO boundingVolume is binned into EVERY frustum slice and executed
  // once per slice (2 by default even with the globe off) — harmless for an
  // opaque shell (identical depth → same pixel overwritten) but a translucent
  // shell blends its alpha twice (over black: 0.5·S becomes 0.75·S, 1.5× too
  // opaque). WebGL avoids this by carrying the bounding sphere AND flagging
  // `executeInClosestFrustum` for translucent draws so the command runs in a
  // single frustum. We replicate both, plus route translucent shells through
  // Pass.TRANSLUCENT for correct back-to-front ordering.
  const material = primitive.material;
  const translucent =
    typeof material?.isTranslucent === "function"
      ? material.isTranslucent()
      : (material?.uniforms?.color?.alpha ?? 1.0) < 1.0;

  // Color command (normal render pass)
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup0, cache.bindGroup1],
      vertexBuffers: [cache.vertexBuffer],
      indexBuffer: cache.indexBuffer,
      indexCount: ELLIPSOID_BOX_INDEX_COUNT,
      pass: translucent ? Pass.TRANSLUCENT : Pass.OPAQUE,
    });
  }
  // Refresh per-frame so a material translucency toggle (alpha crossing 1.0)
  // re-routes the command between the opaque and translucent passes and keeps
  // the bounding volume / closest-frustum flag current as `center`/`radii`
  // change. These fields are plain command properties (no pipeline rebuild).
  const cmd = cache.command as CesiumAnyDrawCommand;
  cmd.pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE;
  cmd.boundingVolume = primitive._boundingSphere;
  (cmd as { executeInClosestFrustum?: boolean }).executeInClosestFrustum =
    translucent;
  // Keep renderState in sync each frame — catches primitive.material
  // translucent-toggle cases where `_rs` rebuilds between frames. The
  // WebGL-shape `renderState` is passed through as an opaque object and
  // consumed by `applyPerEncoderState` in `WebGPUDrawCommand.execute`.
  if (primitiveRS) {
    cmd.renderState = primitiveRS as CesiumAnyDrawCommand["renderState"];
  }

  commandList.push(cache.command);

  // C-R9 (Batch 30) — pick command. Emitted unconditionally alongside the
  // color command so the scene-renderer's `_executePickBatch` finds it
  // during pick passes. Commands tagged with pass=OPAQUE already flow
  // into the pick pass through `Pass.OPAQUE` walk in `_executePickPass`;
  // no separate pick-only pass bucket is needed on WebGPU because the
  // pick FBO render pass reuses the same opaque command list.
  if (pickColor) {
    if (!cache.pickCommand) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline!,
        bindGroups: [cache.bindGroup0, cache.bindGroup1],
        vertexBuffers: [cache.vertexBuffer],
        indexBuffer: cache.indexBuffer,
        indexCount: ELLIPSOID_BOX_INDEX_COUNT,
        pass: Pass.OPAQUE,
        pickOnly: true,
      });
    }
    // Carry the bounding sphere on the pick command too (WebGL sets it at
    // EllipsoidPrimitive.js:447) so pick-pass frustum culling matches color.
    (cache.pickCommand as CesiumAnyDrawCommand).boundingVolume =
      primitive._boundingSphere;
    // Wire onto `colorCommand.derivedCommands.picking.pickCommand` so the
    // Batch 29 `selectCommandVariant` dispatcher swaps to this command on
    // pick passes.
    attachPickToColorCommand(
      cache.command as CesiumAnyDrawCommand,
      cache.pickCommand,
    );
  }
}

/**
 * Destroy WebGPU ellipsoid primitive resources.
 */
function destroyWebGPUEllipsoidPrimitiveResources(
  primitive: CesiumObjectWithWebGPUCache,
): void {
  const cache = primitive._webgpuCache as EllipsoidCache | undefined;
  if (!cache) {
    return;
  }

  cache.uniformBuffer?.destroy();
  cache.ellipsoidUniformBuffer?.destroy();
  cache.vertexBuffer?.destroy();
  cache.indexBuffer?.destroy();

  // C-R9 (Batch 30 / refactored Batch 59) — tear down the pick ID so its
  // slot in the pick registry is reclaimed and the next primitive instance
  // gets a fresh color. No-op if the primitive never entered a pick pass.
  destroyPickIds(primitive as unknown as SinglePickIdCache);

  primitive._webgpuCache = undefined;
}

export {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
export default {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
};
