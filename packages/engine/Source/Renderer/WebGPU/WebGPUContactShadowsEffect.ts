/// <reference types="@webgpu/types" />
/**
 * WebGPU Contact Shadows Effect.
 *
 * Screen-space contact shadows post-process pass. Reads the G-buffer
 * normal-roughness, slot 1 of the MRT scene framebuffer pass, together with
 * scene depth; unprojects to eye space; marches a short ray toward the sun
 * direction, sampling the depth buffer at each step; and darkens the fragment
 * when an occluder is found within the marched distance.
 *
 * Activated by `scene.enableContactShadows = true`. Tunables on `scene`:
 *   - `contactShadowMaxDistance` — default 4.0 eye-space metres.
 *   - `contactShadowSteps` — default 16, clamped to 32 in the shader.
 *   - `contactShadowStrength` — default 0.5; 0 is no darkening, 1 is fully
 *     black at occluded pixels.
 *   - `contactShadowThickness` — default 0.01, and fractional: the allowed
 *     front-delta window is `thickness * |eyePosZ|`, so 0.01 is 1% of
 *     view-space depth, which scales correctly from ground level to orbit.
 *
 * The march budget is sized for aerial views rather than ground-level ones.
 * A 2 m distance with a 0.5% thickness suits a vehicle wheel meeting a road
 * or a plant base meeting soil, but is invisibly small on most occluders at
 * the 300 m to orbital altitudes typical here; 4 m with a 1% thickness widens
 * the visible range without producing false-positive shadows on flat terrain,
 * because the front-delta gating still filters self-shadow. Sixteen steps
 * cover the larger budget at the same per-step granularity twelve gave the
 * smaller one.
 *
 * The class is modelled on `WebGPUNPROutlineEffect.ts`: same cache, init,
 * execute and destroy shape, and the same feature-renderer hookup. It is
 * sentinel-aware through `length(N) < 0.1` in the shader, so sky and the
 * non-emitting pipelines — billboards, labels, lines — skip the test and
 * return the base colour unchanged. It records into the main frame encoder so
 * the canvas write composites after the post-process blit.
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
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// inverseProjection(16) + projection(16) + sunDirEC(4) + params(4) +
// texelSize(4) = 44 floats. Pad to 256-byte UBO alignment minimum.
const CS_UNIFORM_FLOATS = 44;
const CS_UNIFORM_BYTES_RAW = CS_UNIFORM_FLOATS * 4;

interface ContactShadowBindGroupEntry {
  colorView: GPUTextureView;
  depthView: GPUTextureView;
  normalView: GPUTextureView;
  bindGroup: GPUBindGroup;
}

export interface ContactShadowsCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  uniformData: Float32Array;
  bindGroups: [
    ContactShadowBindGroupEntry | null,
    ContactShadowBindGroupEntry | null,
  ];
  nextBindGroupSlot: number;
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
      bindGroups: [null, null],
      nextBindGroupSlot: 0,
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
    // The depth slot, the same r16float resolved view NPR consumes, produced
    // for both single-sample and MSAA modes. Filterable-float matches the
    // bind-group layout default.
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
 * Execute the contact-shadows pass. Reads `colorTextureView`, the current
 * scene colour as snapshotted by the post-process chain; `depthTextureView`,
 * the MSAA-resolved NDC depth; and `normalTextureView`, G-buffer slot 1; and
 * writes the darkened result to `outputView`.
 *
 * Records into `context._currentCommandEncoder` so the canvas write composites
 * after the post-process blit, falling back to an ephemeral encoder and an
 * immediate submit when no main encoder exists.
 */
export function executeContactShadows(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  normalTextureView: GPUTextureView,
  outputView: GPUTextureView,
  scene: CesiumScene,
): boolean {
  const device = (context as unknown as { _device?: GPUDevice })._device;
  if (!device) return false;

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
          _logDepthEncodeNearFar?: ArrayLike<number>;
        };
      }
    )?.uniformState ??
    (
      context as unknown as {
        uniformState?: {
          projection?: ArrayLike<number>;
          inverseProjection?: ArrayLike<number>;
          sunDirectionEC?: { x: number; y: number; z: number };
          _logDepthEncodeNearFar?: ArrayLike<number>;
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
  // Arm the log-depth reverse when the master switch and the per-frame
  // `useLogDepth` are both on and a valid encode frustum is stashed — the
  // globe's full-camera near and far, the ones it log-encoded the shared
  // depth with. `sunDirEC.w` carries `logActive`; `texelSize.zw` carry near
  // and far below. The effect is off by default, so no default scene is
  // affected either way.
  const logActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );
  const encNF = us?._logDepthEncodeNearFar;
  const armLog = logActive && !!encNF && encNF[1] > encNF[0];

  const sun = us?.sunDirectionEC;
  data[o++] = sun?.x ?? 0;
  data[o++] = sun?.y ?? 0;
  data[o++] = sun?.z ?? 1; // default towards camera
  data[o++] = armLog ? 1.0 : 0.0; // sunDirEC.w = logActive
  // params: maxDistance, steps, strength, thickness
  const sceneAny = scene as unknown as {
    contactShadowMaxDistance?: number;
    contactShadowSteps?: number;
    contactShadowStrength?: number;
    contactShadowThickness?: number;
  };
  // Defaults: see the file header for how the march budget is sized.
  data[o++] = sceneAny.contactShadowMaxDistance ?? 4.0;
  data[o++] = sceneAny.contactShadowSteps ?? 16;
  data[o++] = sceneAny.contactShadowStrength ?? 0.5;
  data[o++] = sceneAny.contactShadowThickness ?? 0.01;
  // texelSize.xy = 1/w, 1/h; .zw = log-encode frustum near/far (Slice C).
  data[o++] = 1.0 / w;
  data[o++] = 1.0 / h;
  data[o++] = armLog ? encNF![0] : 0.0;
  data[o++] = armLog ? encNF![1] : 0.0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  let bindGroup: GPUBindGroup | null = null;
  for (let i = 0; i < cache.bindGroups.length; i++) {
    const entry = cache.bindGroups[i];
    if (
      entry?.colorView === colorTextureView &&
      entry.depthView === depthTextureView &&
      entry.normalView === normalTextureView
    ) {
      bindGroup = entry.bindGroup;
      break;
    }
  }
  if (!bindGroup) {
    bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout!,
      entries: [
        { binding: 0, resource: colorTextureView },
        { binding: 1, resource: depthTextureView },
        { binding: 2, resource: normalTextureView },
        { binding: 3, resource: cache.sampler! },
        { binding: 4, resource: { buffer: cache.uniformBuffer! } },
      ],
    });
    const slot = cache.nextBindGroupSlot;
    cache.bindGroups[slot] = {
      colorView: colorTextureView,
      depthView: depthTextureView,
      normalView: normalTextureView,
      bindGroup,
    };
    cache.nextBindGroupSlot = (slot + 1) & 1;
  }

  // Record into the main frame encoder.
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
  return true;
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
    cache.bindGroups = [null, null];
    cache.nextBindGroupSlot = 0;
    cache.initialized = false;
    ctx._contactShadowsCache = undefined;
  }
}
