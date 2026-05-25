/// <reference types="@webgpu/types" />
/**
 * WebGPU Contact Shadows Effect — Slice 5c-B Batch 133.
 *
 * Screen-space contact shadows post-process pass. Reads the
 * G-buffer normal-roughness (slot 1 of the MRT scene FB pass) +
 * scene depth, unprojects to eye-space, marches a short ray toward
 * the sun direction sampling the depth buffer at each step, and
 * darkens the fragment when an occluder is found within the
 * marched distance.
 *
 * Activated via `scene.enableContactShadows = true`. Tunables on
 * `scene`:
 *   - `contactShadowMaxDistance` (default 2.0 eye-space meters)
 *   - `contactShadowSteps` (default 12 — clamped to 32 in shader)
 *   - `contactShadowStrength` (default 0.5 — 0 = no darkening, 1 =
 *     fully black at occluded pixels)
 *   - `contactShadowThickness` (default 0.005 — FRACTIONAL: the
 *     allowed front-delta window is `thickness * |eyePosZ|`, so
 *     0.005 = 0.5% of view-space depth. Scales correctly across
 *     ground-level and orbital altitudes.)
 *
 * Architecture notes:
 *   - Modeled on WebGPUNPROutlineEffect.ts. Same cache + init +
 *     execute + destroy shape, same FeatureRenderer hookup.
 *   - Sentinel-aware via `length(N) < 0.1` in shader — sky and
 *     non-emitting Phase 1 pipelines (billboards, labels, lines)
 *     skip the test and return base color unchanged.
 *   - Records into the main frame encoder (Batch 127 pattern) so
 *     the canvas write composites AFTER post-process's blit.
 *
 * @private
 */

import ContactShadowsShaderWGSL from "../../Shaders/WebGPU/PostProcess/ContactShadows.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// inverseProjection(16) + projection(16) + sunDirEC(4) + params(4) +
// texelSize(4) = 44 floats. Pad to 256-byte UBO alignment minimum.
const CS_UNIFORM_FLOATS = 44;
const CS_UNIFORM_BYTES_RAW = CS_UNIFORM_FLOATS * 4;

export interface ContactShadowsCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  initialized: boolean;
}

function ensureCache(context: CesiumGraphicsContext): ContactShadowsCache {
  const ctx = context as unknown as {
    _contactShadowsCache?: ContactShadowsCache;
  };
  if (!ctx._contactShadowsCache) {
    ctx._contactShadowsCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      uniformData: new Float32Array(CS_UNIFORM_FLOATS),
      initialized: false,
    };
  }
  return ctx._contactShadowsCache;
}

function initializePipeline(
  device: GPUDevice,
  cache: ContactShadowsCache,
  canvasFormat: GPUTextureFormat,
): void {
  if (cache.initialized) return;

  const shaderModule = device.createShaderModule({
    label: "ContactShadows shader",
    code: ContactShadowsShaderWGSL,
  });

  cache.bindGroupLayout = makeBindGroupLayout(device, "ContactShadows BGL", [
    texture(0, Stage.FRAGMENT), // colorTex (filterable-float)
    // depth slot — same r16float resolved view that NPR consumes
    // (Batch 128 produces this for both single-sample + MSAA modes).
    // Filterable-float matches the BGL default.
    texture(1, Stage.FRAGMENT),
    texture(2, Stage.FRAGMENT), // normalRoughTex (rgba16float, filterable)
    sampler(3, Stage.FRAGMENT),
    uniformBuffer(4, Stage.FRAGMENT),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "ContactShadows pipeline layout",
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  cache.pipeline = device.createRenderPipeline({
    label: "ContactShadows pipeline",
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  cache.sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  cache.uniformBuffer = device.createBuffer({
    label: "ContactShadows UB",
    size: Math.max(CS_UNIFORM_BYTES_RAW, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

/**
 * Execute the contact-shadows pass. Reads colorTextureView (current
 * scene color — post-process snapshot per Batch 129), depthTextureView
 * (NDC depth — MSAA-resolved per Batch 128), normalTextureView
 * (G-buffer slot 1), and writes the darkened result to outputView.
 *
 * Records into `context._currentCommandEncoder` (Batch 127 pattern)
 * so the canvas write composites AFTER post-process's blit. Falls
 * back to ephemeral encoder + immediate submit when no main encoder
 * exists.
 */
export function executeContactShadows(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  normalTextureView: GPUTextureView,
  outputView: GPUTextureView,
  scene: CesiumScene,
): void {
  const device = (context as unknown as { _device?: GPUDevice })._device;
  if (!device) return;

  const cache = ensureCache(context);
  const canvasFormat =
    (context as unknown as { _canvasFormat?: GPUTextureFormat })
      ._canvasFormat || "bgra8unorm";
  initializePipeline(device, cache, canvasFormat);

  const canvas = (context as unknown as { _canvas?: HTMLCanvasElement })
    ._canvas;
  const w = canvas?.width ?? 1920;
  const h = canvas?.height ?? 1080;

  // Pack uniforms.
  const us =
    (
      frameState.context as unknown as {
        uniformState?: {
          projection?: ArrayLike<number>;
          inverseProjection?: ArrayLike<number>;
          sunDirectionEC?: { x: number; y: number; z: number };
        };
      }
    )?.uniformState ??
    (
      context as unknown as {
        uniformState?: {
          projection?: ArrayLike<number>;
          inverseProjection?: ArrayLike<number>;
          sunDirectionEC?: { x: number; y: number; z: number };
        };
      }
    ).uniformState;

  const data = cache.uniformData;
  let o = 0;
  const invProj = us?.inverseProjection;
  if (invProj) {
    for (let i = 0; i < 16; i++) data[o++] = invProj[i];
  } else {
    // Identity fallback so the shader's unproject produces no shadow.
    for (let i = 0; i < 16; i++) data[o++] = i % 5 === 0 ? 1 : 0;
  }
  const proj = us?.projection;
  if (proj) {
    for (let i = 0; i < 16; i++) data[o++] = proj[i];
  } else {
    for (let i = 0; i < 16; i++) data[o++] = i % 5 === 0 ? 1 : 0;
  }
  const sun = us?.sunDirectionEC;
  data[o++] = sun?.x ?? 0;
  data[o++] = sun?.y ?? 0;
  data[o++] = sun?.z ?? 1; // default towards camera
  data[o++] = 0;
  // params: maxDistance, steps, strength, thickness
  const sceneAny = scene as unknown as {
    contactShadowMaxDistance?: number;
    contactShadowSteps?: number;
    contactShadowStrength?: number;
    contactShadowThickness?: number;
  };
  data[o++] = sceneAny.contactShadowMaxDistance ?? 2.0;
  data[o++] = sceneAny.contactShadowSteps ?? 12;
  data[o++] = sceneAny.contactShadowStrength ?? 0.5;
  data[o++] = sceneAny.contactShadowThickness ?? 0.005;
  // texelSize
  data[o++] = 1.0 / w;
  data[o++] = 1.0 / h;
  data[o++] = 0;
  data[o++] = 0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  const bindGroup = device.createBindGroup({
    layout: cache.bindGroupLayout!,
    entries: [
      { binding: 0, resource: colorTextureView },
      { binding: 1, resource: depthTextureView },
      { binding: 2, resource: normalTextureView },
      { binding: 3, resource: cache.sampler! },
      { binding: 4, resource: { buffer: cache.uniformBuffer! } },
    ],
  });

  // Main encoder pattern (Batch 127).
  const mainEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  const useMain = !!mainEncoder;
  const encoder =
    mainEncoder ??
    device.createCommandEncoder({ label: "ContactShadows (orphan)" });
  const pass = encoder.beginRenderPass({
    label: "ContactShadows pass",
    colorAttachments: [{ view: outputView, loadOp: "load", storeOp: "store" }],
  });
  pass.setPipeline(cache.pipeline!);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  if (!useMain) {
    device.queue.submit([encoder.finish()]);
  }
}

export function destroyContactShadowsResources(
  context: CesiumGraphicsContext,
): void {
  const ctx = context as unknown as {
    _contactShadowsCache?: ContactShadowsCache;
  };
  const cache = ctx._contactShadowsCache;
  if (cache) {
    cache.uniformBuffer?.destroy();
    cache.pipeline = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.sampler = null;
    cache.initialized = false;
    ctx._contactShadowsCache = undefined;
  }
}
