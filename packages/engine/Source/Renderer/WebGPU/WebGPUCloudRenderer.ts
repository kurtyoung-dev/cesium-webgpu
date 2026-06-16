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
// Slice 5c-B Phase 1 (Batch 106) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
// NEW-COLLECTION-RENDERER-BASE (Phase 11 finisher, Batch 307) — shared
// per-frame scaffolding. Cloud uses the genuinely-shared pieces only:
//   - the per-device shader-module-cache accessor (was an inline WeakMap),
//   - the re-entry / infinite-loop sentinel (Sentinel 1).
// Cloud keeps its OWN unique logic: the count-only rebuild gate, the
// `buildInstanceBuffer` non-resident packing, the velocity lifecycle, and
// the format/log-depth full-re-init invalidation (which nulls the single
// `pipelineDescriptor` + velocity pipelines, not defines→entry Maps, so the
// base's Map-clearing `invalidatePipelinesOnSceneFormatChange` doesn't fit).
import {
  beginCollectionFrame,
  endCollectionFrame,
  makeDeviceShaderModuleCacheAccessor,
  type CollectionRenderCache,
} from "./WebGPUCollectionRendererBase.js";

// Per-device shader module cache so multiple CloudCollections sharing the
// same GPUDevice reuse a single compiled `GPUShaderModule`. Mirrors the
// per-renderer WeakMap pattern used by Polyline / Billboard / Label /
// PointPrimitive (C-R7-SHADER-MODULE-DEDUP, Batch 72). Folded onto the
// shared base accessor (NEW-COLLECTION-RENDERER-BASE).
const getCloudShaderModuleCache = makeDeviceShaderModuleCacheAccessor();

interface CloudCache extends CollectionRenderCache {
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — group-0 layout
  // (stashed for the per-slice resolver to rebuild bind groups) + the
  // per-collection per-slice camera-UB pool/resolver factory.
  bindGroupLayout?: GPUBindGroupLayout | null;
  cameraUB?: WebGPUCollectionCameraUB;
  noiseTexture: GPUTexture | null;
  noiseTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastCloudCount: number;
  // C-R7-RENDERER-MIGRATION (Batch 72) — pipeline arrives asynchronously
  // from `WebGPURenderPipelineCache.getPipeline()`. Tracks whether the
  // request is in flight so we don't re-issue it every frame.
  pipelineRequestPending: boolean;
  pipelineDescriptor: WebGPURenderPipelineDescriptor | null;

  // Batch 170 - B.10 NEW-ADVANCED-MOTION-VECTORS (CloudCollection).
  // Same lifecycle as PointCloud Batch 168/169:
  //   - `instanceData` tracks THIS frame's interleaved Float32Array.
  //   - `prevInstanceData` is promoted from `instanceData` AFTER the
  //     velocity dispatch (PointPrimitive Batch 148 pattern).
  //   - `prevInstanceBuffer` is the GPU mirror of prev positions.
  //   - `velocityPipelineDescriptor` + `velocityPipeline` resolve via
  //     the central pipeline cache.
  // Static cloud collections have prev=curr → velocity=0 (camera-only
  // TAA fallback handles motion). Animated clouds (per-frame position
  // updates by the application) get real per-cloud velocity.
  instanceData: Float32Array | null;
  prevInstanceData: Float32Array | null;
  prevInstanceBuffer: GPUBuffer | null;
  velocityPipeline: GPURenderPipeline | null;
  velocityPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;
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
  @location(3) scaleAndBrightness: vec4<f32>,
  @location(4) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vBrightness: f32,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(3) v_logDepth: f32,
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
  let offset = vec2<f32>(
    input.quadPos.x * input.scaleAndBrightness.x * camera.projScaleX,
    input.quadPos.y * input.scaleAndBrightness.y * camera.projScaleY
  );
  output.position = centerClip + vec4<f32>(offset, 0.0, 0.0);
  output.uv = input.quadPos * 0.5 + 0.5;
  output.vColor = input.color;
  output.vBrightness = input.scaleAndBrightness.z;
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

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  let dist = length(input.uv - vec2<f32>(0.5));
  let alpha = smoothstep(0.5, 0.2, dist);
  let noise = textureSample(noiseTex, noiseSampler, input.uv * 2.0).r;
  let cloudAlpha = alpha * (0.5 + 0.5 * noise) * input.vColor.a;
  let cloudColor = input.vColor.rgb * input.vBrightness;
  if (cloudAlpha < 0.01) { discard; }
  var out: FragOutput;
  out.color = vec4<f32>(cloudColor, cloudAlpha);
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepth.z);
  //>>endif
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
  // (NEW-CLOUD-SCALE-METERS, Batch 253).
  let offset = vec2<f32>(
    input.quadPos.x * input.scaleAndBrightness.x * camera.projScaleX,
    input.quadPos.y * input.scaleAndBrightness.y * camera.projScaleY
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

function createNoiseTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const val = Math.floor(
        (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 256,
      );
      data[idx] = Math.abs(val);
      data[idx + 1] = Math.abs(val);
      data[idx + 2] = Math.abs(val);
      data[idx + 3] = 255;
    }
  }
  const texture = device.createTexture({
    size: { width: size, height: size },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size * 4 },
    { width: size, height: size },
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
  // Per instance: posHigh(12) + posLow(12) + scaleAndBrightness(16) + color(16) = 56 bytes
  const data = new Float32Array(count * 14);
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
    };
    // Per-cloud show flag — WebGL reads it, we previously rendered every
    // cloud regardless of show.
    if (cloud.show === false) {
      continue;
    }
    const pos = cloud.position || new Cartesian3();
    EncodedCartesian3.fromCartesian(pos, scratchEncoded);
    const off = visibleCount * 14;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;
    data[off + 6] = cloud.scale?.x ?? 50.0;
    data[off + 7] = cloud.scale?.y ?? 30.0;
    data[off + 8] = cloud.brightness ?? 1.0;
    data[off + 9] = cloud.slice ?? 0.0;
    const c = cloud.color;
    data[off + 10] = c?.red ?? 1.0;
    data[off + 11] = c?.green ?? 1.0;
    data[off + 12] = c?.blue ?? 1.0;
    data[off + 13] = c?.alpha ?? 0.8;
    visibleCount++;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  // Return visibleCount (clouds with show:true) as the instance count.
  // The buffer itself is still sized for the full collection slot count
  // so the next frame's rewrite doesn't have to reallocate on toggle.
  // Batch 170 - hand the interleaved data back so the velocity helper
  // can keep a CPU-side prev mirror.
  return { buffer, count: visibleCount, instanceData: data };
}

/**
 * Resolve the cloud pipeline through the central pipeline cache. If the
 * cache is unavailable (no WebGPU context, or device not yet present),
 * falls back to direct `device.createRenderPipeline()` so behavior remains
 * unchanged.
 *
 * Returns synchronously when the pipeline is already cached; otherwise
 * kicks off async creation and returns false so the caller can skip the
 * frame and try again next tick.
 *
 * C-R7-RENDERER-MIGRATION (Batch 72). Mirrors the
 * `tryResolveEllipsoidPipelines` pattern from Batch 56.
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

  // Fallback: no central cache (e.g. WebGL-backed graphics context). Mirror
  // the historical synchronous path so behavior matches pre-migration.
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
      // Batch 170 - velocity slots (lazy, allocated when TAA is on).
      instanceData: null,
      prevInstanceData: null,
      prevInstanceBuffer: null,
      velocityPipeline: null,
      velocityPipelineDescriptor: null,
      velocityPipelineRequestPending: false,
    } as CloudCache;
  }

  // NEW-COLLECTIONS-ERROR-SENTINELS (Sentinel 1, NEW-COLLECTION-RENDERER-BASE)
  // — re-entry / infinite-loop guard around the whole update. Increments a
  // per-collection depth and `console.error`s (throttled) if the cloud update
  // re-enters itself for the same collection before settling; the `finally`
  // always settles the depth back to 0.
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
  // Batch 110 — clouds draw into scene FB; use scenePipelineFormat
  // so HDR mode targets rgba16float instead of canvas bgra8unorm.
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
  // Batch 110 — invalidate cache on scene format change.
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
    // Batch 170 - velocity pipeline references the same shader module
    // built against the now-invalid format; force rebuild.
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    (
      cache as unknown as { _pipelineFormatGeneration?: number }
    )._pipelineFormatGeneration = sceneGen;
  }

  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — bake the
  // LOG_DEPTH define into the cloud module + pipelines when active; force
  // a full re-init when the master switch flips (mirrors the
  // scene-format-generation invalidation above).
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
    // C-R7-SHADER-MODULE-DEDUP (Batch 72) — route module compilation
    // through the per-device shader module cache so two CloudCollections
    // share a single `GPUShaderModule`.
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
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    cache.quadVertexBuffer = createQuadVB(device);

    const bgl = makeBindGroupLayout(device, "Cloud BGL", [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT),
      sampler(2, Stage.FRAGMENT),
    ]);
    // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — stash the
    // group-0 layout so the per-slice resolver can rebuild the bind group.
    cache.bindGroupLayout = bgl;

    // C-R7-RENDERER-MIGRATION (Batch 72) — descriptor-only construction;
    // the pipeline itself materializes through `webgpuPipelineCache` so
    // two CloudCollections sharing the same descriptor share a single
    // `GPURenderPipeline`. The descriptor object is held on the cache
    // sidecar so re-resolution attempts use a stable key (cache key
    // hashes the full descriptor shape).
    // NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH — bake the scene-FB MSAA sample
    // count into the pipeline (mirrors the Billboard Batch-134 fix). Without
    // it the pipeline defaults to count=1 and fails attachment-state
    // validation against the MSAA scene framebuffer pass — which invalidates
    // the WHOLE pass encoder, so adding a single cloud blanked every other
    // primitive in the scene. `ms=` is keyed into the name so the central
    // pipeline cache distinguishes sample-count variants.
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
            arrayStride: 56,
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
        ],
      },
      fragment: {
        module: cache.shaderModule,
        entryPoint: "fragmentMain",
        // Slice 5c-B Phase 1 (Batch 106) — routed through
        // `makeSceneFBTargets` so Phase 2 picks up the 2nd null slot
        // automatically. Verbatim blend preserves the existing
        // descriptor shape (no `operation` field) so the pipeline-cache
        // hash for this shader stays stable across the conversion.
        // The velocity pipeline below (line 901) targets rg16float
        // (TAA velocity texture), NOT scene-FB, and intentionally
        // stays single-target.
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

  // C-R7-RENDERER-MIGRATION (Batch 72) — resolve the pipeline through the
  // central cache. On first frame this kicks off async creation and
  // returns false; subsequent frames pick up the cached pipeline
  // synchronously and return true. Skip the draw on not-yet-ready frames
  // so we never enqueue a draw command with a null pipeline.
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

  // NEW-CLOUD-REBUILD-DIRTY-GATE (Batch 233) — capture the collection's
  // dirty state BEFORE the per-frame consume below clears it (the consume
  // comment has documented this ordering requirement since Batch 228).
  // `_cloudsToUpdateIndex > 0` covers every property setter routed through
  // `_updateCloud` (show/position/scale/maximumSize/slice/brightness/color);
  // `_createVertexArray` covers add/remove/removeAll — count changes are
  // already caught by the count gate, but a same-frame add+remove nets to
  // an equal count with different members.
  const dirtyState = collection as unknown as {
    _cloudsToUpdateIndex?: number;
    _createVertexArray?: boolean;
  };
  const hasDirtyEdits =
    (dirtyState._cloudsToUpdateIndex ?? 0) > 0 ||
    dirtyState._createVertexArray === true;

  // Rebuild instance buffer when clouds change — count change OR per-cloud
  // property edits. Pre-Batch-233 this keyed only on the count, so property
  // edits (position/scale/brightness/color) never re-uploaded and rendered
  // stale forever.
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
    // Batch 170 - track THIS frame's instance data so the velocity
    // helper can promote it to `prevInstanceData` AFTER its dispatch.
    // Same lifecycle as PointCloud Batch 168/169 — see the long doc
    // comment on the `attachCloudVelocityCommand` helper for the
    // first-frame-seed and revision-change-mismatch cases.
    cache.instanceData = result.instanceData;
  }

  // Phase 0 dirty-consume (NEW-DIRTY-CONSUME-CLOUD). The WebGPU renderer
  // replaces the WebGL vertex build, so CloudCollection's per-cloud `_dirty`,
  // `_cloudsToUpdateIndex`, `_createVertexArray`, and `_propertiesChanged`
  // are never cleared on this path — settled clouds get re-dirtied every
  // frame and the update queue grows unbounded. Consume every frame (not
  // just on rebuild). ORDERING (load-bearing): the rebuild gate above reads
  // `_cloudsToUpdateIndex` / `_createVertexArray` BEFORE this consume clears
  // them (NEW-CLOUD-REBUILD-DIRTY-GATE, Batch 233) — never move this call
  // above the gate.
  if (typeof collection._consumeDirtyState === "function") {
    collection._consumeDirtyState();
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Pack camera uniforms.
  //
  // RTE: zero the translation column of VIEW *before* multiplying by
  // projection. Zeroing the result's col3 after the multiply wipes out
  // projection's P23 depth-mapping term, producing incorrect NDC depth.
  // See `UniformStateComputations.cleanModelViewProjectionRelativeToEye`
  // for the canonical pattern.
  //
  // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — the body is a
  // closure so the per-slice resolver can re-invoke it at draw time against
  // the slice's refreshed `uniformState.view`/`.projection`. Called once here
  // to fill the static (slice-0 / single-frustum) buffer, then again per slice
  // by the resolver into the slice's own buffer.
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
    // Projection diagonal for meters-based quad sizing
    // (NEW-CLOUD-SCALE-METERS, Batch 253) — column-major m00/m11. Valid for
    // both perspective (3D) and orthographic (2D/CV) frusta.
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

    // Batch 170 - DP-H41 prev viewProjection at floats 28..43.
    // UniformState swaps `_previousViewProjection := viewProjection` at
    // the END of `update()` AFTER returning the prior frame's value, so
    // on frame N this slot holds frame N-1's VP. First frame falls
    // through to identity.
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

  // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — per-slice camera
  // UB resolver. Cloud's group 0 carries the camera UB (binding 0) plus the
  // STABLE noise texture + sampler (bindings 1-2, created once at init), so the
  // resolver rebuilds group 0 with the slice's own buffer + those same texture
  // refs as extraEntries. The static `cache.bindGroup` is the slice-0 fallback.
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

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      bindGroupResolvers: [cloudCameraResolver],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: Pass.TRANSLUCENT,
    });
  } else {
    // `cache.command` is built once; refresh the resolver each frame so it
    // re-packs against THIS frame's camera + the current texture refs.
    (cache.command as { bindGroupResolvers?: unknown[] }).bindGroupResolvers = [
      cloudCameraResolver,
    ];
  }

  // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward CloudCollection's
  // `_rs` so the translucent cloud pass uses the same alpha-blend +
  // depth-test configuration as the WebGL path. Written per-frame (not
  // only at command creation) because the collection could in principle
  // rebuild its render state if a future feature adds one.
  (cache.command as { renderState?: unknown }).renderState = (
    collection as unknown as { _rs?: unknown }
  )._rs;

  // Batch 170 - B.10 NEW-ADVANCED-MOTION-VECTORS attach. Maintain a
  // one-frame-lagged prev mirror of the instance buffer so the
  // velocity VS reads (current, previous) position pairs.
  attachCloudVelocityCommand(device, context, frameState, cache);

  commandList.push(cache.command);
}

/**
 * Batch 170 - upload prev positions, build (or fetch) the velocity
 * pipeline, attach `velocityCommand` to the cache's color command. The
 * TAA pass walks the command list for `cmd.velocityCommand` and
 * dispatches it into the rg16float velocity texture. Mirrors PointCloud
 * Batch 168/169.
 *
 * Skips entirely when TAA is off and no prev buffer has been allocated
 * yet — keeps the off-path zero-cost.
 *
 * Two ways to fall into the GPU self-copy fallback below:
 *   1. First frame ever — `prevInstanceData` is null. Seed by copying
 *      curr → prev so this frame emits velocity = 0; the post-dispatch
 *      promotion at the end of this function then captures THIS
 *      frame's data as prev for next frame's real delta.
 *   2. Cloud-count change — animated cloud collection adds or removes
 *      clouds across frames. The prev buffer carried last frame's
 *      smaller/larger data; falling through to the self-copy emits
 *      velocity = 0 for this transition (correct: no continuous index
 *      correspondence between OLD and NEW clouds at the same i).
 *      Subsequent frames at the new count restore real delta capture.
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

  const requiredBytes = cache.instanceCount * 56;
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
  }

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
  }

  // Lazy velocity pipeline build. Reuses the same color BGL since the
  // velocity VS reads from the same uniform buffer (camera struct
  // includes prevViewProjection now).
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
              arrayStride: 56,
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
              // the same 56-byte stride; color/scale at offset 24+
              // are ignored by the velocity VS).
              arrayStride: 56,
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
        instanceCount: cache.instanceCount,
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
  // Batch 170 - release the velocity-path GPU buffer.
  cache.prevInstanceBuffer?.destroy();
  collection._webgpuCache = undefined;
}

export { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
export default { updateWebGPUCloudCollection, destroyWebGPUCloudResources };
