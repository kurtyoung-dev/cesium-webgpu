/// <reference types="@webgpu/types" />
/**
 * WebGPU Screen-Space Reflections Effect
 *
 * Integrates into the post-process pipeline as a complex multi-pass effect.
 * Activated via `scene.screenSpaceReflections = true`.
 *
 * Configuration:
 *   - scene.ssrMaxDistance: number (default 200.0)
 *   - scene.ssrThickness: number (default 0.5)
 *   - scene.ssrMaxSteps: number (default 96)
 *   - scene.ssrStride: number (default 2.0)
 *   - scene.ssrReflectionStrength: number 0-1 (default 0.5)
 *
 * The march budget is sized for mid-range scenes. A 50 m distance over 64
 * steps rarely reaches a reflector more than a few metres from the
 * reflective surface, so a typical aerial scene with an object 50 to 200 m
 * from a lake produces essentially no visible reflection signal; 200 m over
 * 96 steps covers urban reflective surfaces with buildings up to about 200 m
 * away. The trade is per-frame cost — 96 steps across a few million
 * ray-marched pixels per HD frame, bounded by texture-sample throughput —
 * and SSR is off by default, so only scenes that enable it pay for it.
 *
 * Reference: Morgan McGuire and Michael Mara, "Efficient GPU Screen-Space Ray
 * Tracing", Journal of Computer Graphics Techniques 3(4), 73 (2014) —
 * {@link https://jcgt.org/published/0003/04/04/}. The digital-differential-
 * analyser march in screen space, with the thickness test that decides whether
 * a depth crossing is a hit or a step behind an occluder, follows that paper;
 * the shader it drives cites it as well.
 *
 * @private
 */
import SSRShaderWGSL from "../../Shaders/WebGPU/PostProcess/ScreenSpaceReflections.js";
// Hand-tuned f16 variant, selected when the
// context opts in via `useShaderF16` AND the device granted `shader-f16`.
import SSRShaderF16WGSL from "../../Shaders/WebGPU/PostProcess/ScreenSpaceReflections_f16.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// AUDIT_2026_05_02 B.15 — bumped from 44 to 48 for the new `flags: vec4`
// trailing field in SSRUniforms (hasNormalGBuffer flag).
const SSR_UNIFORM_FLOATS = 48; // matches SSRUniforms struct
const SSR_UNIFORM_BYTES = SSR_UNIFORM_FLOATS * 4;

interface SSRBindGroupEntry {
  colorView: GPUTextureView;
  depthView: GPUTextureView;
  normalView: GPUTextureView;
  bindGroup: GPUBindGroup;
}

export interface SSRCache {
  pipeline: GPURenderPipeline | null;
  uniformBuffer: GPUBuffer | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  normalTexture: GPUTexture | null;
  normalView: GPUTextureView | null;
  uniformData: Float32Array;
  bindGroups: [SSRBindGroupEntry | null, SSRBindGroupEntry | null];
  nextBindGroupSlot: number;
  initialized: boolean;
  width: number;
  height: number;
  warnedNoNormalGBuffer: boolean;
}

function ensureSSRCache(context: CesiumGraphicsContext): SSRCache {
  if (!context._ssrCache) {
    context._ssrCache = {
      pipeline: null,
      uniformBuffer: null,
      bindGroupLayout: null,
      sampler: null,
      normalTexture: null,
      normalView: null,
      uniformData: new Float32Array(SSR_UNIFORM_FLOATS),
      bindGroups: [null, null],
      nextBindGroupSlot: 0,
      initialized: false,
      width: 0,
      height: 0,
      warnedNoNormalGBuffer: false,
    };
  }
  return context._ssrCache;
}

function initializeSSRPipeline(
  device: GPUDevice,
  cache: SSRCache,
  canvasFormat: GPUTextureFormat,
  useShaderF16: boolean = false,
): void {
  if (cache.initialized) return;

  // Pick the f16 variant only when the caller
  // confirmed both the opt-in flag and device support. The f16 SSR keeps
  // the entire ray-march + reconstruction in f32 (precision-critical) and
  // only narrows the final color blend, so output stays f32-identical
  // within tolerance. Default path (useShaderF16 false) is byte-identical.
  const shaderModule = device.createShaderModule({
    label: useShaderF16 ? "SSR shader (f16)" : "SSR shader",
    code: useShaderF16 ? SSRShaderF16WGSL : SSRShaderWGSL,
  });

  cache.bindGroupLayout = makeBindGroupLayout(device, "SSR BGL", [
    texture(0, Stage.FRAGMENT),
    texture(1, Stage.FRAGMENT),
    texture(2, Stage.FRAGMENT),
    sampler(3, Stage.FRAGMENT),
    uniformBuffer(4, Stage.FRAGMENT),
  ]);

  const pipelineLayout = device.createPipelineLayout({
    label: "SSR pipeline layout",
    bindGroupLayouts: [cache.bindGroupLayout],
  });

  cache.pipeline = device.createRenderPipeline({
    label: "SSR pipeline",
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
    label: "SSR UB",
    size: Math.max(SSR_UNIFORM_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

function ensureNormalTexture(
  device: GPUDevice,
  cache: SSRCache,
  width: number,
  height: number,
): void {
  if (cache.normalTexture && cache.width === width && cache.height === height)
    return;

  cache.normalTexture?.destroy();
  cache.normalTexture = device.createTexture({
    label: "SSR normal placeholder",
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  cache.normalView = cache.normalTexture.createView();
  cache.width = width;
  cache.height = height;
}

/**
 * Execute the SSR effect pass.
 * Inserted into post-process pipeline after AO, before bloom.
 */
export function executeSSR(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  colorTextureView: GPUTextureView,
  depthTextureView: GPUTextureView,
  normalTextureView: GPUTextureView | null,
  outputView: GPUTextureView,
  scene: CesiumScene,
): boolean {
  const device = context._device;
  if (!device) return false;

  const cache = ensureSSRCache(context);
  // Use f16 only when opted in and device-supported.
  const useF16 = !!context.useShaderF16 && !!context.hasFeature?.("shader-f16");
  initializeSSRPipeline(
    device,
    cache,
    context._canvasFormat || "bgra8unorm",
    useF16,
  );

  const canvas = context._canvas;
  const w = canvas?.width ?? 1920;
  const h = canvas?.height ?? 1080;

  // Use provided normal texture or fallback placeholder. The placeholder
  // is uninitialized — SSR will sample garbage and produce noise rather
  // than reflections. A real normal G-buffer for this path awaits the
  // depth-prepass and normal G-buffer foundation work. Surface this
  // once so users don't think SSR is broken — they're seeing the
  // documented placeholder behavior.
  let normalView = normalTextureView;
  if (!normalView) {
    if (!cache.warnedNoNormalGBuffer) {
      cache.warnedNoNormalGBuffer = true;
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        "[CesiumJS:webgpu] Screen-space reflections enabled without a normal G-buffer. " +
          "SSR will sample an uninitialized placeholder and produce noise. " +
          "No normal G-buffer was available for this view. " +
          "Set `scene.screenSpaceReflections = false` to avoid the placeholder noise.",
      );
      //>>includeEnd('debug');
    }
    ensureNormalTexture(device, cache, w, h);
    normalView = cache.normalView!;
  }

  // Pack uniforms
  const data = cache.uniformData;
  const us = frameState.context?.uniformState ?? context.uniformState;
  let offset = 0;

  // projection (mat4, 16 floats)
  const proj = us?.projection;
  if (proj) {
    for (let i = 0; i < 16; i++) data[offset++] = proj[i];
  } else {
    offset += 16;
  }

  // inverseProjection (mat4, 16 floats)
  const invProj = us?.inverseProjection;
  if (invProj) {
    for (let i = 0; i < 16; i++) data[offset++] = invProj[i];
  } else {
    offset += 16;
  }

  // resolution (vec4)
  data[offset++] = w;
  data[offset++] = h;
  data[offset++] = 1.0 / w;
  data[offset++] = 1.0 / h;

  // params (vec4): maxDistance, thickness, maxSteps, stride. See the file
  // header for how the march budget is sized.
  data[offset++] = scene.ssrMaxDistance ?? 200.0;
  data[offset++] = scene.ssrThickness ?? 0.5;
  data[offset++] = scene.ssrMaxSteps ?? 96.0;
  data[offset++] = scene.ssrStride ?? 2.0;

  // params2 (vec4): fadeScreenEdge, fadeDistance, reflectionStrength, fresnelPower
  data[offset++] = 0.1;
  data[offset++] = 1.0;
  data[offset++] = scene.ssrReflectionStrength ?? 0.5;
  data[offset++] = 5.0;

  // AUDIT_2026_05_02 B.15 — flags.x = hasNormalGBuffer flag. When the
  // caller passed a real normal G-buffer (`normalTextureView !== null`)
  // the FS samples the texture; otherwise it falls back to depth-derived
  // normals via `cross(dFdy, dFdx)`. Far better than the all-noise
  // placeholder produced by sampling an uninitialized texture.
  data[offset++] = normalTextureView ? 1.0 : 0.0;
  // `flags.y` is `logActive`, `.z` the encode near and `.w` the encode far.
  // The shared depth texture is log-encoded by default, under renderer-wide
  // log depth, so the fragment stage must reverse it before the
  // inverse-projection unproject. The globe's full-camera encode frustum is
  // read from `uniformState._logDepthEncodeNearFar`, where the globe
  // camera-uniform packer stashes it — the same source ground polylines and
  // ground primitives use. Armed only when the master switch and the
  // per-frame `useLogDepth` are on and a valid encode frustum is stashed;
  // otherwise the lanes stay zero and the fragment stage keeps the
  // hyperbolic path. SSR is off by default either way.
  const logActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );
  const encNF = (
    us as unknown as { _logDepthEncodeNearFar?: ArrayLike<number> }
  )?._logDepthEncodeNearFar;
  const armLog = logActive && !!encNF && encNF[1] > encNF[0];
  data[offset++] = armLog ? 1.0 : 0.0;
  data[offset++] = armLog ? encNF![0] : 0.0;
  data[offset++] = armLog ? encNF![1] : 0.0;

  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);

  let bindGroup: GPUBindGroup | null = null;
  for (let i = 0; i < cache.bindGroups.length; i++) {
    const entry = cache.bindGroups[i];
    if (
      entry?.colorView === colorTextureView &&
      entry.depthView === depthTextureView &&
      entry.normalView === normalView
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
        { binding: 2, resource: normalView },
        { binding: 3, resource: cache.sampler! },
        { binding: 4, resource: { buffer: cache.uniformBuffer! } },
      ],
    });
    const slot = cache.nextBindGroupSlot;
    cache.bindGroups[slot] = {
      colorView: colorTextureView,
      depthView: depthTextureView,
      normalView,
      bindGroup,
    };
    cache.nextBindGroupSlot = (slot + 1) & 1;
  }

  // Record into the main frame encoder. An effect that creates its own
  // encoder and submits eagerly runs before the main encoder's post-process
  // blit, so its canvas write is overwritten and invisible. Recording here
  // puts SSR after `_runPostProcessing`'s commands, where the blend on top
  // survives.
  const mainEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  const useMain = !!mainEncoder;
  const encoder =
    mainEncoder ?? device.createCommandEncoder({ label: "SSR (orphan)" });
  const pass = encoder.beginRenderPass({
    label: "SSR pass",
    colorAttachments: [
      {
        view: outputView,
        loadOp: "load",
        storeOp: "store",
      },
    ],
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

export function destroySSRResources(context: CesiumGraphicsContext): void {
  const cache = context._ssrCache;
  if (cache) {
    cache.uniformBuffer?.destroy();
    cache.normalTexture?.destroy();
    cache.pipeline = null;
    cache.uniformBuffer = null;
    cache.bindGroupLayout = null;
    cache.sampler = null;
    cache.normalTexture = null;
    cache.normalView = null;
    cache.bindGroups = [null, null];
    cache.nextBindGroupSlot = 0;
    cache.initialized = false;
    context._ssrCache = undefined;
  }
}
