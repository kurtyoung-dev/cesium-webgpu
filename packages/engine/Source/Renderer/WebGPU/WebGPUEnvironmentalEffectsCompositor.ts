/// <reference types="@webgpu/types" />

/**
 * Ordered composition state for the WebGPU environmental-effects chain.
 *
 * The post-process snapshot is side A of a two-texture graph. A single lazy
 * canvas-format texture is side B. Full-screen effects always sample the
 * current side and render to the other side, so WebGPU never sees a texture as
 * both a sampled resource and a render attachment in the same pass. Weather
 * geometry does not sample scene color and may therefore draw in-place. The
 * final accumulated side is blitted to the canvas once at the tail.
 *
 * The state object and GPU resources are retained per context. Settled frames
 * allocate neither a cursor nor a final-blit bind group. Two bind groups cover
 * the only possible source identities (snapshot and ping), including parity
 * changes when an effect is toggled.
 *
 * @private
 */

import {
  makeBindGroupLayout,
  texture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const FINAL_BLIT_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var output : VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;

@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4f {
  return textureLoad(sourceTexture, vec2i(input.position.xy), 0);
}
`;

interface FinalBlitBindGroupEntry {
  sourceView: GPUTextureView;
  bindGroup: GPUBindGroup;
}

interface EnvironmentalCompositorCache {
  device: GPUDevice;
  format: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  width: number;
  height: number;
  pingTexture: GPUTexture;
  pingView: GPUTextureView;
  bindGroupLayout: GPUBindGroupLayout;
  pipeline: GPURenderPipeline;
  finalBindGroups: [
    FinalBlitBindGroupEntry | null,
    FinalBlitBindGroupEntry | null,
  ];
  state: EnvironmentalCompositionState;
}

export interface EnvironmentalCompositionState {
  snapshotView: GPUTextureView | null;
  pingView: GPUTextureView | null;
  sourceView: GPUTextureView | null;
  targetView: GPUTextureView | null;
  wrote: boolean;
}

export type EnvironmentalWeatherRoute =
  "offscreen-before-fog" | "present-then-canvas" | "direct-canvas";

const compositorCaches = new WeakMap<
  CesiumGraphicsContext,
  EnvironmentalCompositorCache
>();

function createCompositorCache(
  device: GPUDevice,
  format: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  width: number,
  height: number,
): EnvironmentalCompositorCache {
  const pingTexture = device.createTexture({
    label: "EnvironmentalEffects ping texture",
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    sampleCount: 1,
  });
  const pingView = pingTexture.createView({
    label: "EnvironmentalEffects ping view",
  });
  const bindGroupLayout = makeBindGroupLayout(
    device,
    "EnvironmentalEffects final blit BGL",
    [texture(0, Stage.FRAGMENT)],
  );
  const shader = device.createShaderModule({
    label: "EnvironmentalEffects final blit shader",
    code: FINAL_BLIT_WGSL,
  });
  const pipeline = device.createRenderPipeline({
    label: "EnvironmentalEffects final blit pipeline",
    layout: device.createPipelineLayout({
      label: "EnvironmentalEffects final blit pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: { module: shader, entryPoint: "vertexMain" },
    fragment: {
      module: shader,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
    // The final blit is drawn into `resumeDefaultRenderPass()`'s canvas pass,
    // which ALWAYS carries a depth-stencil attachment (`_beginDefaultRenderPass`
    // attaches `_depthTextureView`, which `beginFrame` populates every frame).
    // A pipeline with no depthStencil state is incompatible with that pass, so
    // `setPipeline` fails validation, the pass is invalidated, and the whole
    // frame's command buffer is dropped at submit — a black canvas on any frame
    // with an environmental effect enabled. Depth is neither written nor tested
    // here: `always` keeps every fragment of the full-screen triangle, so the
    // blit output is identical to the no-depth-state pipeline and stays correct
    // under either depth convention (`less-equal` against this triangle's z=0
    // would silently discard the present under reversed-Z). The stencil state
    // defaults to all-`keep`, so the pass's stored depth/stencil is unchanged.
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  });
  return {
    device,
    format,
    depthFormat,
    width,
    height,
    pingTexture,
    pingView,
    bindGroupLayout,
    pipeline,
    finalBindGroups: [null, null],
    state: {
      snapshotView: null,
      pingView: null,
      sourceView: null,
      targetView: null,
      wrote: false,
    },
  };
}

function ensureCompositorCache(
  context: CesiumGraphicsContext,
): EnvironmentalCompositorCache | null {
  const contextState = context as unknown as {
    _device?: GPUDevice | null;
    _canvas?: HTMLCanvasElement;
    presentationFormat?: GPUTextureFormat;
    _canvasFormat?: GPUTextureFormat;
  };
  const device = contextState._device;
  const width = contextState._canvas?.width ?? 0;
  const height = contextState._canvas?.height ?? 0;
  if (!device || width <= 0 || height <= 0) {
    return null;
  }
  const format =
    contextState.presentationFormat ??
    contextState._canvasFormat ??
    "bgra8unorm";
  // Same source and fallback the weather renderer keys its canvas-pass pipeline
  // off (WebGPUWeatherRenderer, `context.depthFormat ?? "depth24plus-stencil8"`)
  // so both canvas-pass pipelines and the pass itself cannot disagree.
  const depthFormat = context.depthFormat ?? "depth24plus-stencil8";
  const previous = compositorCaches.get(context);
  if (
    previous &&
    previous.device === device &&
    previous.format === format &&
    previous.depthFormat === depthFormat &&
    previous.width === width &&
    previous.height === height
  ) {
    return previous;
  }
  previous?.pingTexture.destroy();
  const next = createCompositorCache(
    device,
    format,
    depthFormat,
    width,
    height,
  );
  compositorCaches.set(context, next);
  return next;
}

/**
 * Select the render target opposite `sourceView`.
 *
 * Exported for a GPU-free contract test. `null` means the source is not one of
 * this graph's two owned identities, which is a caller error rather than a
 * reason to risk a sample/render alias.
 */
export function selectEnvironmentalCompositionTarget(
  sourceView: GPUTextureView,
  snapshotView: GPUTextureView,
  pingView: GPUTextureView,
): GPUTextureView | null {
  if (sourceView === snapshotView) {
    return pingView;
  }
  if (sourceView === pingView) {
    return snapshotView;
  }
  return null;
}

/**
 * Pure routing policy for weather's geometry insertion point. Exported so the
 * no-extra-blit weather-only path is contract tested without a GPU.
 */
export function selectEnvironmentalWeatherRoute(
  fogFollows: boolean,
  hasComposition: boolean,
  compositionHasWrites: boolean,
): EnvironmentalWeatherRoute {
  if (fogFollows && hasComposition) {
    return "offscreen-before-fog";
  }
  if (compositionHasWrites) {
    return "present-then-canvas";
  }
  return "direct-canvas";
}

/** Begin one frame's composition graph. The returned object is reused. */
export function beginEnvironmentalEffectsComposition(
  context: CesiumGraphicsContext,
  snapshotView: GPUTextureView,
): EnvironmentalCompositionState | null {
  const cache = ensureCompositorCache(context);
  if (!cache) {
    return null;
  }
  const state = cache.state;
  state.snapshotView = snapshotView;
  state.pingView = cache.pingView;
  state.sourceView = snapshotView;
  state.targetView = cache.pingView;
  state.wrote = false;
  return state;
}

/**
 * Commit a full-screen stage only when it actually recorded its output pass.
 * A culled or not-yet-ready renderer leaves the graph on the previous source.
 */
export function commitEnvironmentalFullscreenStage(
  state: EnvironmentalCompositionState,
  recorded: boolean,
): void {
  if (!recorded || !state.sourceView || !state.targetView) {
    return;
  }
  state.sourceView = state.targetView;
  state.targetView = selectEnvironmentalCompositionTarget(
    state.sourceView,
    state.snapshotView!,
    state.pingView!,
  );
  state.wrote = true;
}

/** Record that geometry modified the current source in-place. */
export function commitEnvironmentalInPlaceStage(
  state: EnvironmentalCompositionState,
  recorded: boolean,
): void {
  state.wrote ||= recorded;
}

function getFinalBlitBindGroup(
  cache: EnvironmentalCompositorCache,
  sourceView: GPUTextureView,
): GPUBindGroup {
  for (let i = 0; i < cache.finalBindGroups.length; i++) {
    const entry = cache.finalBindGroups[i];
    if (entry?.sourceView === sourceView) {
      return entry.bindGroup;
    }
  }
  const bindGroup = cache.device.createBindGroup({
    label: "EnvironmentalEffects final blit bind group",
    layout: cache.bindGroupLayout,
    entries: [{ binding: 0, resource: sourceView }],
  });
  const slot = cache.finalBindGroups[0] === null ? 0 : 1;
  cache.finalBindGroups[slot] = { sourceView, bindGroup };
  return bindGroup;
}

/**
 * Present the accumulated graph once. Returns false when no environmental
 * stage wrote, leaving the already-post-processed canvas untouched.
 */
export function presentEnvironmentalEffectsComposition(
  context: CesiumGraphicsContext,
  state: EnvironmentalCompositionState,
): boolean {
  if (!state.wrote || !state.sourceView) {
    return false;
  }
  const cache = compositorCaches.get(context);
  if (!cache) {
    return false;
  }
  const pass = (
    context as unknown as {
      resumeDefaultRenderPass?: () => GPURenderPassEncoder | null;
    }
  ).resumeDefaultRenderPass?.();
  if (!pass) {
    return false;
  }
  pass.setPipeline(cache.pipeline);
  pass.setBindGroup(0, getFinalBlitBindGroup(cache, state.sourceView));
  pass.draw(3);
  return true;
}

/** Release the compositor's context-owned texture eagerly. */
export function destroyEnvironmentalEffectsCompositor(
  context: CesiumGraphicsContext,
): void {
  const cache = compositorCaches.get(context);
  cache?.pingTexture.destroy();
  compositorCaches.delete(context);

  // The snapshot is side A of this graph even though allocation lives in the
  // scene-renderer resource step. Clear both sides together so a pooled device
  // cannot retain one canvas-sized texture after Context teardown, and device
  // recovery cannot reuse an old-generation view.
  const snapshotOwner = context as unknown as {
    _postProcessSnapshotTexture?: GPUTexture | null;
    _postProcessSnapshotView?: GPUTextureView | null;
    _postProcessSnapshotWidth?: number;
    _postProcessSnapshotHeight?: number;
    _postProcessSnapshotDevice?: GPUDevice | null;
  };
  snapshotOwner._postProcessSnapshotTexture?.destroy();
  snapshotOwner._postProcessSnapshotTexture = null;
  snapshotOwner._postProcessSnapshotView = null;
  snapshotOwner._postProcessSnapshotWidth = 0;
  snapshotOwner._postProcessSnapshotHeight = 0;
  snapshotOwner._postProcessSnapshotDevice = null;
}
