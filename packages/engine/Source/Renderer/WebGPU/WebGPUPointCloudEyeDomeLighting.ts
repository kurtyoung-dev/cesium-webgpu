/// <reference types="@webgpu/types" />
/**
 * WebGPU Point Cloud Eye-Dome Lighting (EDL) — full data path (PARITY-PC-EDL).
 *
 * EDL is a depth-discontinuity post-process that darkens the edges of a point
 * cloud to enhance depth perception (Boucheny 2009). The WebGL implementation
 * lives in `Scene/PointCloudEyeDomeLighting.js`: it redirects every point-cloud
 * draw command into an off-screen framebuffer with two color attachments
 * (color + packed depth) using a depth-writing "EC" shader variant, then blends
 * a darkened-edge result back to the main framebuffer.
 *
 * This module ports that pipeline to WebGPU:
 *
 *   1. `update()` (called from `PointCloudEyeDomeLighting.update` during the
 *      3D-Tileset traversal) scans the freshly-pushed point-cloud color
 *      commands, records their GPU resources (the `_edlSource` tag added by
 *      `WebGPUPointCloudRenderer`), and DISABLES them so they don't draw to the
 *      scene framebuffer — the EDL composite provides those pixels instead.
 *      It also allocates / resizes the off-screen framebuffer and flips a
 *      per-frame "active" flag on the context.
 *
 *   2. `renderFrustum()` (called from the frustum loop right after the OPAQUE
 *      pass) ends the scene pass, re-draws the recorded point clouds into the
 *      off-screen FBO with the dual-output depth shader
 *      (`PointCloud/PointCloudEDLDepth.wgsl`), resumes the scene pass, and runs
 *      the neighbor-depth blend (`Advanced/PointCloudEDL.wgsl`) as a
 *      full-screen alpha-blended draw that composites the darkened points back
 *      onto the scene framebuffer.
 *
 * # Off-gate (parity-neutral when disabled)
 *
 * Everything here runs ONLY when the user turns on
 * `pointCloudShading.eyeDomeLighting` (default false). With EDL off:
 *   - `PointCloudEyeDomeLighting.update` never delegates the EDL path (the
 *     3D-Tileset gate in `Cesium3DTileset.js` short-circuits), so `update()`
 *     below is never called → no off-screen allocation, no command disabling.
 *   - The depth shader is compiled with the `POINT_CLOUD_EDL_DEPTH` define
 *     which is add-only; at `defines=0` the point draw shaders and every other
 *     WGSL module preprocess byte-identically.
 *   - `renderFrustum()` early-returns when no EDL point clouds were recorded
 *     this frame, so the frustum-loop hook is a single boolean check on the
 *     off path.
 *
 * @module WebGPUPointCloudEyeDomeLighting
 */

import Cartesian2 from "../../Core/Cartesian2.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { gpuData } from "./webgpuTypeHelpers.js";
import { ShaderSourceId, ShaderDefine } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import PointCloudEDLDepthWGSL from "../../Shaders/WebGPU/PointCloud/PointCloudEDLDepth.js";
import PointCloudEDLBlendWGSL from "../../Shaders/WebGPU/Advanced/PointCloudEDL.js";
import type { PointCloudEDLSource } from "./WebGPUPointCloudRenderer.js";

// The blend uniform block (`EDLUniforms`) is 8 floats / 32 bytes:
// texelSize.xy, strength, radius, nearPlane, farPlane, _pad0, _pad1.
const BLEND_UNIFORM_FLOATS = 8;

/**
 * A single point-cloud draw recorded for EDL re-rendering into the off-screen
 * FBO. `command` is the original scene-FB color command (now disabled); its
 * `_edlSource` tag carries the raw buffers we re-issue with the depth shader.
 */
interface EDLRecordedCloud {
  source: PointCloudEDLSource;
}

/**
 * Per-context cache of EDL GPU resources. Allocated lazily the first frame EDL
 * is active; torn down by `destroy()` on toggle-off / device loss.
 */
interface PointCloudEDLCache {
  device: GPUDevice;
  colorFormat: GPUTextureFormat;
  width: number;
  height: number;

  // Off-screen render targets (single-sample). Slot 0 = point color in the
  // scene color format; slot 1 = raw eye-space depth (r32float) so near-field
  // depth deltas survive for the EDL response; plus a depth-stencil for the
  // point draw's depth test.
  colorTexture: GPUTexture | null;
  colorView: GPUTextureView | null;
  eyeDepthTexture: GPUTexture | null;
  eyeDepthView: GPUTextureView | null;
  dsTexture: GPUTexture | null;
  dsView: GPUTextureView | null;

  // Depth-writing point pipeline (dual color output: color + packed depth).
  depthShaderModule: GPUShaderModule | null;
  depthUniformBGL: GPUBindGroupLayout | null;
  depthPipeline: GPURenderPipeline | null;
  // Per-source uniform bind groups, keyed by the source's uniform buffer so a
  // scene with multiple point clouds reuses one BG per cloud.
  depthUniformBindGroups: WeakMap<GPUBuffer, GPUBindGroup>;

  // Blend/composite pipeline (full-screen, samples the off-screen FBO).
  blendShaderModule: GPUShaderModule | null;
  blendBGL: GPUBindGroupLayout | null;
  blendPipeline: GPURenderPipeline | null;
  blendUniformBuffer: GPUBuffer | null;
  blendBindGroup: GPUBindGroup | null;
  blendSampler: GPUSampler | null;
  blendUniformData: Float32Array;
  blendSampleCount: number;
}

/**
 * Minimal shape of the WebGL `PointCloudEyeDomeLighting` processor this
 * renderer reads. `_strength` / `_radius` are the user-configured EDL controls
 * (set on the processor by `PointCloudEyeDomeLighting.update` in the WebGL
 * path; we read the same fields for parity).
 */
interface EDLProcessorLike {
  _strength?: number;
  _radius?: number;
  _webgpuEDLActive?: boolean;
}

// Per-frame recorded clouds + the EDL controls captured at update() time.
// Stored on the context so `update()` (tileset time) and `renderFrustum()`
// (frustum-loop time) share state without threading it through the frameState.
interface EDLContextState {
  _pointCloudEDLCache?: PointCloudEDLCache | null;
  _pointCloudEDLClouds?: EDLRecordedCloud[];
  _pointCloudEDLStrength?: number;
  _pointCloudEDLRadius?: number;
  _pointCloudEDLComposited?: boolean;
  _pointCloudEDLFrame?: number;
}

const scratchStrengthRadius = new Cartesian2();

function getBlendSampler(cache: PointCloudEDLCache): GPUSampler {
  if (!cache.blendSampler) {
    cache.blendSampler = cache.device.createSampler({
      label: "PointCloudEDL blend sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  return cache.blendSampler;
}

/**
 * Build (once) the depth-writing point pipeline. Dual color targets:
 *   slot 0 — point color (scene color format)
 *   slot 1 — raw eye-space depth (r32float; near-field precision preserved)
 * Depth-stencil matches the point draw's `depth24plus-stencil8` / less-equal.
 */
function ensureDepthPipeline(cache: PointCloudEDLCache): void {
  if (cache.depthPipeline) {
    return;
  }
  const device = cache.device;
  if (!cache.depthShaderModule) {
    const moduleCache = new WebGPUShaderModuleCache(device);
    cache.depthShaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_CLOUD_EDL_DEPTH,
      PointCloudEDLDepthWGSL,
      ShaderDefine.POINT_CLOUD_EDL_DEPTH,
      "PointCloudEDL depth shader",
    );
  }
  if (!cache.depthUniformBGL) {
    cache.depthUniformBGL = makeBindGroupLayout(
      device,
      "PointCloudEDL depth uniform BGL",
      // VERTEX_FRAGMENT: FS reads u.logDepth.y (far) to normalise packed depth.
      [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
    );
  }
  cache.depthPipeline = device.createRenderPipeline({
    label: "PointCloudEDL depth pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.depthUniformBGL],
    }),
    vertex: {
      module: cache.depthShaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: 40,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x3" },
            { shaderLocation: 2, offset: 12, format: "float32x3" },
            { shaderLocation: 3, offset: 24, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: cache.depthShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        // slot 0 — point color, standard alpha blend (matches on-screen draw).
        {
          format: cache.colorFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
        // slot 1 — raw eye-space depth (r32float), no blend (nearest point
        // wins via the depth test).
        { format: "r32float" },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
}

/**
 * Build (once) the full-screen blend pipeline that composites the darkened
 * off-screen point color back onto the scene framebuffer.
 */
function ensureBlendPipeline(
  cache: PointCloudEDLCache,
  sceneFormat: GPUTextureFormat,
  sampleCount: number,
): void {
  if (
    cache.blendPipeline &&
    cache.colorFormat === sceneFormat &&
    cache.blendSampleCount === sampleCount
  ) {
    return;
  }
  cache.blendSampleCount = sampleCount;
  const device = cache.device;
  if (!cache.blendShaderModule) {
    const moduleCache = new WebGPUShaderModuleCache(device);
    cache.blendShaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_CLOUD_EDL_BLEND,
      PointCloudEDLBlendWGSL,
      0,
      "PointCloudEDL blend shader",
    );
  }
  if (!cache.blendBGL) {
    cache.blendBGL = makeBindGroupLayout(device, "PointCloudEDL blend BGL", [
      texture(0, Stage.FRAGMENT, { sampleType: "unfilterable-float" }), // color
      texture(1, Stage.FRAGMENT, { sampleType: "unfilterable-float" }), // r32float eye depth
      sampler(2, Stage.FRAGMENT, "non-filtering"),
      uniformBuffer(3, Stage.FRAGMENT),
    ]);
  }
  if (!cache.blendUniformBuffer) {
    cache.blendUniformBuffer = device.createBuffer({
      label: "PointCloudEDL blend uniforms",
      size: BLEND_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  cache.blendPipeline = device.createRenderPipeline({
    label: "PointCloudEDL blend pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.blendBGL],
    }),
    vertex: { module: cache.blendShaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: cache.blendShaderModule,
      entryPoint: "fragmentMain",
      // The scene FB render pass carries a slot-1 MRT G-buffer attachment
      // (when MRT mode is on), so the composite pipeline must declare BOTH
      // targets — slot 0 = darkened point color (alpha-blended over the scene),
      // slot 1 = placeholder (writeMask 0). `makeSceneFBTargets` produces the
      // right shape for the current MRT mode.
      targets: makeSceneFBTargets(sceneFormat, {
        // Alpha-blend the darkened points over the scene FB. Background
        // pixels of the off-screen FBO are emitted as fully transparent by
        // the blend shader, so non-point pixels are untouched.
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    // The scene FB render pass carries a depth-stencil attachment, so the
    // composite pipeline MUST declare a matching depthStencil state even
    // though it neither tests nor writes depth — a pipeline without one is
    // attachment-incompatible with the pass and every draw is dropped (which
    // made the composite silently produce nothing). `depthCompare: "always"` +
    // `depthWriteEnabled: false` = a pure overlay that ignores depth.
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "always",
    },
    // Match the scene framebuffer's MSAA sample count so the composite draw is
    // attachment-compatible with the (MSAA) Scene Framebuffer Render Pass.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
  // The bind group references the off-screen textures — rebuilt on resize
  // (framebuffer.update recreates textures). Invalidate here so the next
  // renderFrustum rebuilds it against the fresh views.
  cache.blendBindGroup = null;
}

/**
 * Ensure the per-context EDL cache exists and the off-screen framebuffer is
 * sized to the current drawing buffer.
 */
function ensureCache(
  context: CesiumGraphicsContext,
  sceneFormat: GPUTextureFormat,
): PointCloudEDLCache | null {
  const device = (context as unknown as { device?: GPUDevice }).device;
  if (!device) {
    return null;
  }
  const width = Math.max(1, context.drawingBufferWidth | 0);
  const height = Math.max(1, context.drawingBufferHeight | 0);

  const ctxState = context as unknown as EDLContextState;
  let cache = ctxState._pointCloudEDLCache ?? null;
  if (!cache) {
    cache = {
      device,
      colorFormat: sceneFormat,
      width: 0,
      height: 0,
      colorTexture: null,
      colorView: null,
      eyeDepthTexture: null,
      eyeDepthView: null,
      dsTexture: null,
      dsView: null,
      depthShaderModule: null,
      depthUniformBGL: null,
      depthPipeline: null,
      depthUniformBindGroups: new WeakMap(),
      blendShaderModule: null,
      blendBGL: null,
      blendPipeline: null,
      blendUniformBuffer: null,
      blendBindGroup: null,
      blendSampler: null,
      blendUniformData: new Float32Array(BLEND_UNIFORM_FLOATS),
      blendSampleCount: 0,
    };
    ctxState._pointCloudEDLCache = cache;
  }

  // Scene color format flipped (HDR toggle) — rebuild the color pipeline +
  // off-screen color texture against the new format.
  if (cache.colorFormat !== sceneFormat) {
    cache.colorFormat = sceneFormat;
    cache.width = 0; // force texture rebuild below
    cache.height = 0;
    cache.depthPipeline = null;
    cache.depthShaderModule = null;
    cache.blendPipeline = null;
    cache.blendShaderModule = null;
    cache.blendBindGroup = null;
  }

  if (cache.width !== width || cache.height !== height) {
    destroyEDLTextures(cache);
    cache.width = width;
    cache.height = height;
    cache.colorTexture = device.createTexture({
      label: "PointCloudEDL color",
      size: { width, height },
      format: sceneFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.colorView = cache.colorTexture.createView();
    cache.eyeDepthTexture = device.createTexture({
      label: "PointCloudEDL eyeDepth",
      size: { width, height },
      format: "r32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.eyeDepthView = cache.eyeDepthTexture.createView();
    cache.dsTexture = device.createTexture({
      label: "PointCloudEDL depthStencil",
      size: { width, height },
      format: "depth24plus-stencil8",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cache.dsView = cache.dsTexture.createView();
    // Off-screen texture views changed — the blend bind group must rebind.
    cache.blendBindGroup = null;
  }

  return cache;
}

/** Release the off-screen render-target textures (resize / destroy). */
function destroyEDLTextures(cache: PointCloudEDLCache): void {
  cache.colorTexture?.destroy();
  cache.eyeDepthTexture?.destroy();
  cache.dsTexture?.destroy();
  cache.colorTexture = null;
  cache.colorView = null;
  cache.eyeDepthTexture = null;
  cache.eyeDepthView = null;
  cache.dsTexture = null;
  cache.dsView = null;
}

/**
 * Feature-renderer `update` entry. Called from `PointCloudEyeDomeLighting.update`
 * (Scene) during the 3D-Tileset traversal, ONLY when the user enabled
 * `pointCloudShading.eyeDomeLighting`. Records the point-cloud color commands
 * pushed since `commandStart`, disables them, and captures the EDL controls.
 *
 * @param processor - The WebGL-side `PointCloudEyeDomeLighting` instance (carries
 *   `_strength` / `_radius`).
 * @param frameState - The current frame state (`commandList` is scanned).
 * @param commandStart - Index into `frameState.commandList` where this tileset's
 *   point-cloud commands begin.
 */
function updateWebGPUPointCloudEDL(
  processor: EDLProcessorLike,
  frameState: CesiumFrameState,
  commandStart: number,
): void {
  const context = frameState.context;
  const ctxState = context as unknown as EDLContextState;

  // New frame → reset the recorded-cloud list + per-frame composite guard.
  // Keyed on `frameState.frameNumber` so the first EDL tileset each frame
  // clears the list the render phase later consumes; a multi-tileset frame
  // appends without re-clearing.
  const frameNumber =
    (frameState as unknown as { frameNumber?: number }).frameNumber ?? 0;
  if (ctxState._pointCloudEDLFrame !== frameNumber) {
    ctxState._pointCloudEDLFrame = frameNumber;
    ctxState._pointCloudEDLClouds = [];
    ctxState._pointCloudEDLComposited = false;
  }
  processor._webgpuEDLActive = true;

  const clouds = ctxState._pointCloudEDLClouds!;
  const commandList = frameState.commandList;
  const start = typeof commandStart === "number" ? commandStart : 0;
  for (let i = start; i < commandList.length; i++) {
    const cmd = commandList[i] as unknown as {
      _edlSource?: PointCloudEDLSource;
      enabled?: boolean;
      isWebGPUDrawCommand?: boolean;
    };
    const src = cmd._edlSource;
    if (
      cmd.isWebGPUDrawCommand === true &&
      src &&
      src.instanceBuffer &&
      src.uniformBuffer &&
      src.quadVertexBuffer &&
      src.instanceCount > 0
    ) {
      // Disable the scene-FB draw — the EDL composite provides these pixels.
      cmd.enabled = false;
      clouds.push({ source: src });
    }
  }

  // Capture the user-configured EDL controls (mirrors WebGL: strength +
  // radius already scaled by pixelRatio by `PointCloudEyeDomeLighting.update`).
  ctxState._pointCloudEDLStrength = processor._strength ?? 1.0;
  ctxState._pointCloudEDLRadius = processor._radius ?? 1.0;
}

/**
 * Whether any EDL point clouds were recorded this frame. The frustum loop
 * checks this before doing any EDL work — a single boolean read on the off
 * path.
 */
export function hasWebGPUPointCloudEDL(
  context: CesiumGraphicsContext,
): boolean {
  const ctxState = context as unknown as EDLContextState;
  const clouds = ctxState._pointCloudEDLClouds;
  return (
    !!clouds && clouds.length > 0 && ctxState._pointCloudEDLComposited !== true
  );
}

/**
 * Render the recorded point clouds into the off-screen FBO and composite the
 * darkened result back onto the scene framebuffer. Called from the frustum
 * loop right after the OPAQUE pass, with the scene pass currently OPEN.
 *
 * The caller is responsible for having ended nothing — this function ends the
 * scene pass itself, does the off-screen render, then resumes the scene pass
 * via `resumeScenePass` and issues the composite draw into it.
 *
 * @param context - The WebGPU context (must have an active command encoder).
 * @param frameState - Current frame state.
 * @param resumeScenePass - Callback that re-opens the scene-FB render pass with
 *   loadOp:"load" and returns the pass encoder (the host's `_resumeScenePass`).
 * @param sceneFormat - The scene framebuffer color format.
 */
export function renderFrustumWebGPUPointCloudEDL(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  resumeScenePass: () => GPURenderPassEncoder | null,
  sceneFormat: GPUTextureFormat,
): void {
  const ctxState = context as unknown as EDLContextState;
  const clouds = ctxState._pointCloudEDLClouds;
  if (!clouds || clouds.length === 0 || ctxState._pointCloudEDLComposited) {
    return;
  }
  // Composite once per frame (point clouds live in the nearest frustum; a
  // single blend matches WebGL's single blend command).
  ctxState._pointCloudEDLComposited = true;

  const ctxAny = context as unknown as {
    _currentCommandEncoder?: GPUCommandEncoder | null;
    endCurrentRenderPass?: () => void;
  };
  const encoder = ctxAny._currentCommandEncoder;
  if (!encoder) {
    return;
  }

  const cache = ensureCache(context, sceneFormat);
  if (!cache) {
    return;
  }
  const sceneSampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  ensureDepthPipeline(cache);
  ensureBlendPipeline(cache, sceneFormat, sceneSampleCount);
  if (!cache.depthPipeline || !cache.blendPipeline) {
    return;
  }

  const device = cache.device;

  // ── 1. Off-screen render: points → (color + packed depth) FBO ──
  // End the active scene pass so we can open our own render pass on the same
  // command encoder.
  ctxAny.endCurrentRenderPass?.();

  if (!cache.colorView || !cache.eyeDepthView || !cache.dsView) {
    return;
  }
  const offscreenPass = encoder.beginRenderPass({
    label: "PointCloudEDL offscreen pass",
    colorAttachments: [
      {
        view: cache.colorView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
      {
        // r32float eye-depth; clear to 0 (the background/no-point sentinel).
        view: cache.eyeDepthView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: cache.dsView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      stencilClearValue: 0,
      stencilLoadOp: "clear",
      stencilStoreOp: "store",
    },
  });
  offscreenPass.setPipeline(cache.depthPipeline);
  for (let i = 0; i < clouds.length; i++) {
    const src = clouds[i].source;
    if (
      !src.uniformBuffer ||
      !src.quadVertexBuffer ||
      !src.instanceBuffer ||
      src.instanceCount <= 0
    ) {
      continue;
    }
    let bg = cache.depthUniformBindGroups.get(src.uniformBuffer);
    if (!bg) {
      bg = device.createBindGroup({
        label: "PointCloudEDL depth uniform BG",
        layout: cache.depthUniformBGL!,
        entries: [{ binding: 0, resource: { buffer: src.uniformBuffer } }],
      });
      cache.depthUniformBindGroups.set(src.uniformBuffer, bg);
    }
    offscreenPass.setBindGroup(0, bg);
    offscreenPass.setVertexBuffer(0, src.quadVertexBuffer);
    offscreenPass.setVertexBuffer(1, src.instanceBuffer);
    offscreenPass.draw(6, src.instanceCount, 0, 0);
  }
  offscreenPass.end();

  // ── 2. Composite: darkened off-screen color → scene FB (alpha blend) ──
  // Refresh blend uniforms (strength / radius / near-far / texel size).
  const near = getFrustumNear(context);
  const far = getFrustumFar(context);
  scratchStrengthRadius.x = ctxState._pointCloudEDLRadius ?? 1.0;
  scratchStrengthRadius.y = ctxState._pointCloudEDLStrength ?? 1.0;
  const data = cache.blendUniformData;
  data[0] = 1.0 / cache.width; // texelSize.x
  data[1] = 1.0 / cache.height; // texelSize.y
  data[2] = scratchStrengthRadius.y; // strength
  data[3] = scratchStrengthRadius.x; // radius
  data[4] = near; // nearPlane
  data[5] = far; // farPlane
  data[6] = 0.0;
  data[7] = 0.0;
  device.queue.writeBuffer(cache.blendUniformBuffer!, 0, gpuData(data));

  if (!cache.blendBindGroup) {
    const colorView = cache.colorView;
    const depthView = cache.eyeDepthView;
    if (colorView && depthView) {
      cache.blendBindGroup = device.createBindGroup({
        label: "PointCloudEDL blend BG",
        layout: cache.blendBGL!,
        entries: [
          { binding: 0, resource: colorView },
          { binding: 1, resource: depthView },
          { binding: 2, resource: getBlendSampler(cache) },
          { binding: 3, resource: { buffer: cache.blendUniformBuffer! } },
        ],
      });
    }
  }

  // Re-open the scene FB pass (loadOp:"load" preserves everything drawn so
  // far) and draw the full-screen composite into it.
  const scenePass = resumeScenePass();
  if (scenePass && cache.blendBindGroup) {
    scenePass.setPipeline(cache.blendPipeline);
    scenePass.setBindGroup(0, cache.blendBindGroup);
    scenePass.draw(3, 1, 0, 0);
  }
}

/** Read the current frustum near plane (metres), with a safe fallback. */
function getFrustumNear(context: CesiumGraphicsContext): number {
  const cf = (
    context.uniformState as unknown as {
      currentFrustum?: { x: number; y: number };
    }
  ).currentFrustum;
  return cf?.x ?? 1.0;
}

/** Read the current frustum far plane (metres), with a safe fallback. */
function getFrustumFar(context: CesiumGraphicsContext): number {
  const cf = (
    context.uniformState as unknown as {
      currentFrustum?: { x: number; y: number };
    }
  ).currentFrustum;
  return cf?.y ?? 1.0e7;
}

/**
 * Release all EDL GPU resources. Called on toggle-off (via the WebGL
 * processor's `destroy`), viewport teardown, and device loss.
 */
function destroyWebGPUPointCloudEDLResources(
  _processor: EDLProcessorLike,
  context?: CesiumGraphicsContext,
): void {
  if (!context) {
    return;
  }
  const ctxState = context as unknown as EDLContextState;
  const cache = ctxState._pointCloudEDLCache;
  if (cache) {
    destroyEDLTextures(cache);
    cache.blendUniformBuffer?.destroy();
    cache.blendBindGroup = null;
    cache.blendPipeline = null;
    cache.depthPipeline = null;
    ctxState._pointCloudEDLCache = null;
  }
  ctxState._pointCloudEDLClouds = [];
  ctxState._pointCloudEDLComposited = false;
}

export { updateWebGPUPointCloudEDL, destroyWebGPUPointCloudEDLResources };
export default {
  updateWebGPUPointCloudEDL,
  destroyWebGPUPointCloudEDLResources,
};
