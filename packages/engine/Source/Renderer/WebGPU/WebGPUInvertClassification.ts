/**
 * WebGPU Invert Classification
 *
 * Applies a highlight/dim effect to unclassified regions of 3D Tiles.
 * Uses a fullscreen composite pass that reads from a classified texture
 * and applies color modification to areas not covered by classification.
 *
 * @module WebGPUInvertClassification
 */

import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

interface InvertClassificationCache {
  uniformBuffer: GPUBuffer | null;
  // Unclassified composite pipeline (`equal` stencil compare, reference 0):
  // tints tile pixels that classification primitives did not touch.
  unclassifiedPipeline: GPURenderPipeline | null;
  // Classified composite pipeline (`not-equal` stencil compare, reference 0):
  // emits tile color unmodified for pixels the classification-ignore-show
  // pass marked with a non-zero stencil value.
  classifiedPipeline: GPURenderPipeline | null;
  // Single-pass fallback used when no stencil view is available. It tints
  // every tile pixel while `enableHighlight` is on.
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  // Render-target attachment texture (may be MSAA-multisampled; matches
  // the scene framebuffer's sample count so draw-command pipelines built
  // for the scene's MSAA count bind validly in this pass).
  classifiedTexture: GPUTexture | null;
  classifiedTextureView: GPUTextureView | null;
  // Resolved (single-sample) texture + view used by the composite bind
  // group. When `sampleCount === 1` this aliases `classifiedTexture` /
  // `classifiedTextureView`; when MSAA is on, the render pass uses
  // `classifiedTextureView` as the color attachment and
  // `resolveTextureView` as the resolve target.
  resolveTexture: GPUTexture | null;
  resolveTextureView: GPUTextureView | null;
  // Dedicated depth-stencil for the invert framebuffer. The tile pass writes
  // depth and color here, the
  // classification-ignore-show pass writes stencil bits marking
  // classified regions, and the stencil-gated composite reads this
  // view as the depth-stencil attachment (stencil-test drives whether
  // each pixel takes the classified or unclassified shader branch).
  // MSAA-matched to `classifiedTexture` so they can be paired in the
  // same render pass; the composite also runs at MSAA so it can re-use
  // this view without depth-stencil-resolve (unsupported in WebGPU).
  depthStencilTexture: GPUTexture | null;
  depthStencilView: GPUTextureView | null;
  sampler: GPUSampler | null;
  framebuffer: CesiumOpaqueFramebuffer | null;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  width: number;
  height: number;
  sampleCount: number;
  // Cache the scene color format so an HDR change invalidates compatible
  // resources. `"" as GPUTextureFormat` never matches a real format, so the
  // first update always triggers allocation.
  colorFormat: GPUTextureFormat | "";
}

// Three fragment entry points share one shader module:
//
// - `fragmentMain`: single-pass fallback with no stencil
//   gating. Tile pixels are always tinted by `highlightColor`. Used
//   when the stencil-gated two-pass composite can't run (no stencil
//   view available).
//
// - `fragmentUnclassified`: used by the stencil-gated composite with
//   stencilCompare=EQUAL, reference=0. Fires on tile pixels that the
//   classification-ignore-show pass did not mark (stencil == 0 →
//   "unclassified" tile region). Emits `classColor * highlightColor`
//   so the unclassified tile area shows the invert tint.
//
// - `fragmentClassified`: used by the stencil-gated composite with
//   stencilCompare=NOT_EQUAL, reference=0. Fires on tile pixels
//   flagged by classification primitives (stencil != 0 → "classified"
//   tile region). Emits the raw tile color so classified regions
//   render unmodified, matching the WebGL `rsClassified` /
//   `rsUnclassified` split in `InvertClassification.js:290-322`.
//
// All three share the same vertex + uniforms so a single shader
// module covers all pipelines; stencil testing happens in the
// depthStencilState, not inside WGSL.
const INVERT_CLASS_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
struct Uniforms {
  highlightColor: vec4<f32>,
  enableHighlight: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var classifiedTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Uniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var o: VertexOutput;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let classColor = textureSample(classifiedTex, samp, input.uv);
  if (classColor.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  if (params.enableHighlight > 0.5) {
    return vec4<f32>(
      classColor.rgb * params.highlightColor.rgb,
      classColor.a,
    );
  }
  return classColor;
}

@fragment
fn fragmentUnclassified(input: VertexOutput) -> @location(0) vec4<f32> {
  let classColor = textureSample(classifiedTex, samp, input.uv);
  if (classColor.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  if (params.enableHighlight > 0.5) {
    return vec4<f32>(
      classColor.rgb * params.highlightColor.rgb,
      classColor.a,
    );
  }
  return classColor;
}

@fragment
fn fragmentClassified(input: VertexOutput) -> @location(0) vec4<f32> {
  let classColor = textureSample(classifiedTex, samp, input.uv);
  if (classColor.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  return classColor;
}
`;

function updateWebGPUInvertClassification(
  invertClass: CesiumObjectWithWebGPUCache,
  context: CesiumGraphicsContext,
  numSamples: number,
  globeFramebuffer: CesiumOpaqueFramebuffer | undefined,
): void {
  const device: GPUDevice = context.device;

  if (!invertClass._webgpuCache) {
    invertClass._webgpuCache = {
      uniformBuffer: null,
      unclassifiedPipeline: null,
      classifiedPipeline: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      bindGroupLayout: null,
      classifiedTexture: null,
      classifiedTextureView: null,
      resolveTexture: null,
      resolveTextureView: null,
      depthStencilTexture: null,
      depthStencilView: null,
      sampler: null,
      framebuffer: null,
      command: null,
      initialized: false,
      width: 0,
      height: 0,
      sampleCount: 1,
      colorFormat: "",
    } as InvertClassificationCache;
  }

  const cache = invertClass._webgpuCache as InvertClassificationCache;
  // Track the scene's actual color format
  // (populated by the scene renderer each frame from the scene
  // framebuffer's `colorFormat`). Falls back to the canvas format when
  // the context field isn't populated yet (single-pass callers, pre-
  // first-render state). Tile draw-command pipelines are built for the scene
  // color format, so the redirected pass must target that same format. Using
  // the canvas format in an HDR scene causes silent pipeline validation drift.
  const canvasFormat: GPUTextureFormat =
    (context as unknown as { _sceneColorFormat?: GPUTextureFormat })
      ._sceneColorFormat ?? navigator.gpu.getPreferredCanvasFormat();
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;
  // numSamples is forwarded from FramebufferOrchestrator, which reads
  // `scene.msaaSamples`. The render-attachment texture must match that sample
  // count or tile pipelines fail validation against the redirected pass.
  const sampleCount = numSamples >= 2 ? numSamples : 1;

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    const sm = device.createShaderModule({ code: INVERT_CLASS_WGSL });
    cache.shaderModule = sm;

    cache.initialized = true;
  }

  // Resize classified texture if viewport, sample count, or color
  // format changes. Format change drives reallocation because MSAA
  // `classifiedTexture` and the resolve target are created with an
  // explicit format that must match the tile pipelines' target format
  // (= scene color format).
  const needsResize =
    cache.width !== width ||
    cache.height !== height ||
    cache.sampleCount !== sampleCount ||
    cache.colorFormat !== canvasFormat;
  if (needsResize) {
    cache.classifiedTexture?.destroy();
    cache.resolveTexture?.destroy();
    cache.depthStencilTexture?.destroy();
    cache.resolveTexture = null;
    cache.resolveTextureView = null;
    cache.depthStencilTexture = null;
    cache.depthStencilView = null;

    // Attachment texture matches scene MSAA sample count so the tile
    // draw-command pipelines validate in the redirected render pass.
    // MSAA attachments cannot be sampled directly. A multisampled allocation
    // therefore gets a single-sample resolve target for the composite pass;
    // the single-sample allocation binds its attachment view directly.
    cache.classifiedTexture = device.createTexture({
      label: `InvertClassification_color_${sampleCount}x`,
      size: { width, height },
      format: canvasFormat,
      sampleCount,
      usage:
        sampleCount > 1
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.classifiedTextureView = cache.classifiedTexture.createView();

    if (sampleCount > 1) {
      cache.resolveTexture = device.createTexture({
        label: `InvertClassification_resolve_1x`,
        size: { width, height },
        format: canvasFormat,
        sampleCount: 1,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      cache.resolveTextureView = cache.resolveTexture.createView();
    } else {
      // In the single-sample path, the attachment view is also sampleable.
      cache.resolveTextureView = cache.classifiedTextureView;
    }

    // The invert framebuffer's depth-stencil texture matches
    // `classifiedTexture` in sample count and the scene depth-stencil in
    // format, keeping redirected tile-command pipelines compatible. The
    // tile pass writes depth, the classification-ignore-show pass adds
    // nonzero stencil values, and the composite reads those values to
    // select each pixel's pipeline.
    cache.depthStencilTexture = device.createTexture({
      label: `InvertClassification_depthStencil_${sampleCount}x`,
      size: { width, height },
      format: "depth24plus-stencil8",
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cache.depthStencilView = cache.depthStencilTexture.createView();

    cache.width = width;
    cache.height = height;
    cache.sampleCount = sampleCount;
    cache.colorFormat = canvasFormat;
    cache.bindGroup = null; // needs recreation (resolveTextureView changed)
    cache.pipeline = null;
    cache.unclassifiedPipeline = null;
    cache.classifiedPipeline = null;
    cache.command = null;
  }

  // Create pipeline if needed (depends on format)
  if (!cache.pipeline) {
    // The layout uses one texture, `classifiedTex`. Scene color is not read by
    // the shader; the composite overlays highlight color in unclassified
    // regions with src-alpha blending directly onto the scene color target.
    // Avoids read/write-same-texture conflict.
    const bgl = makeBindGroupLayout(device, "InvertClassification BGL", [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      uniformBuffer(2, Stage.FRAGMENT),
    ]);
    cache.bindGroupLayout = bgl;

    // Three composite pipelines cover the available stencil states:
    //
    // 1. `pipeline` is the single-pass fallback when the
    //    stencil-gated composite can't run (no invert depth-stencil
    //    attachment, e.g., `depthStencilView` not yet allocated).
    //    Targets the resolved (single-sample) scene color view, no
    //    multisample, and no depth-stencil attachment.
    //
    // 2. **`unclassifiedPipeline`**: MSAA-matched, stencilCompare =
    //    `equal` with reference 0. Fires on tile pixels without a
    //    classification-primitive stencil mark — emits
    //    `classColor * highlightColor` so the unclassified region
    //    receives the invert tint.
    //
    // 3. **`classifiedPipeline`**: MSAA-matched, stencilCompare =
    //    `not-equal` with reference 0. Fires on tile pixels flagged by
    //    classification — emits the raw tile color unmodified.
    //
    // Pipelines 2 and 3 both target the scene color MSAA attachment
    // (so they must re-resolve at pass end) and pair with the invert
    // FBO's own MSAA depth-stencil view, which carries the stencil
    // bits written by the CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
    // redirect pass.
    const blend = {
      color: {
        srcFactor: "src-alpha" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
      },
      alpha: {
        srcFactor: "one" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
      },
    };
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bgl],
    });

    // (1) Single-sample fallback.
    cache.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: cache.shaderModule!, entryPoint: "vertexMain" },
      fragment: {
        module: cache.shaderModule!,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat, blend }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Depth-stencil state shared by the two stencil-gated pipelines.
    // Depth testing is disabled (compare=always, write=false) — this
    // is a fullscreen blit. Stencil test is the only gate, and its
    // `compare` flips between the two pipelines. `stencilReadMask`
    // covers all bits so any non-zero stencil = "classified".
    const sharedDepthStencilBase: Omit<GPUDepthStencilState, "stencilFront"> = {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "always",
      stencilReadMask: 0xff,
      stencilWriteMask: 0x00,
    };

    // (2) Unclassified: stencil == 0 → tint with highlight color.
    cache.unclassifiedPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: cache.shaderModule!, entryPoint: "vertexMain" },
      fragment: {
        module: cache.shaderModule!,
        entryPoint: "fragmentUnclassified",
        targets: [{ format: canvasFormat, blend }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        ...sharedDepthStencilBase,
        stencilFront: {
          compare: "equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
        stencilBack: {
          compare: "equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
      },
      multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
    });

    // (3) Classified: stencil != 0 → raw tile color.
    cache.classifiedPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: cache.shaderModule!, entryPoint: "vertexMain" },
      fragment: {
        module: cache.shaderModule!,
        entryPoint: "fragmentClassified",
        targets: [{ format: canvasFormat, blend }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        ...sharedDepthStencilBase,
        stencilFront: {
          compare: "not-equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
        stencilBack: {
          compare: "not-equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
      },
      multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
    });

    // Composite reads from the SINGLE-SAMPLE view — `resolveTextureView`
    // when MSAA is on (resolved copy of the MSAA attachment), or the
    // attachment view itself when the scene is single-sample (aliased
    // above). The MSAA path cannot bind the multisampled attachment
    // directly because `textureSample` in WGSL requires a
    // `texture_2d<f32>` binding, not a `texture_multisampled_2d<f32>`.
    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: cache.resolveTextureView! },
        { binding: 1, resource: cache.sampler! },
        { binding: 2, resource: { buffer: cache.uniformBuffer! } },
      ],
    });
  }

  // Pack uniforms
  const highlightColor = invertClass._highlightColor ?? {
    red: 1,
    green: 1,
    blue: 0,
    alpha: 0.5,
  };
  const data = new Float32Array(8);
  data[0] = highlightColor.red ?? 1.0;
  data[1] = highlightColor.green ?? 1.0;
  data[2] = highlightColor.blue ?? 0.0;
  data[3] = highlightColor.alpha ?? 0.5;
  data[4] = invertClass._enabled ? 1.0 : 0.0;
  device.queue.writeBuffer(cache.uniformBuffer!, 0, data);
}

/**
 * Composites the InvertClassification classified
 * texture onto the scene color view.
 *
 * Two execution modes depending on what the caller has wired:
 *
 * **Stencil-gated MSAA mode** (preferred; matches WebGL). Activated
 * when `sceneColorAttachmentView` is the MSAA scene-color attachment,
 * `sceneResolveView` is the resolve target for that attachment, and
 * the invert FBO has an accumulated stencil buffer (written by the
 * redirected CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW pass). Two
 * full-screen passes run: the `classifiedPipeline` emits raw tile
 * color where stencil != 0, the `unclassifiedPipeline` emits
 * `classColor * highlightColor` where stencil == 0. Mirrors the
 * WebGL `rsClassified` / `rsUnclassified` split.
 *
 * **Single-sample fallback mode**. Activated when `sceneResolveView`
 * is passed as the only target (no MSAA, no stencil). Runs the
 * single-pass fallback: every tile pixel is tinted
 * if `enableHighlight` is on. Used on first-frame-after-enable (no
 * stencil yet populated) and when MSAA info isn't available.
 *
 * The fallback always works; the stencil-gated mode requires more
 * setup but matches WebGL's behavior exactly.
 */
function executeInvertClassificationComposite(
  invertClass: CesiumObjectWithWebGPUCache,
  encoder: GPUCommandEncoder,
  sceneResolveView: GPUTextureView,
  sceneColorAttachmentView?: GPUTextureView,
  invertHasStencilData?: boolean,
): void {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  if (!cache || !cache.initialized || !cache.bindGroup) {
    return;
  }

  const canRunStencilGated =
    !!invertHasStencilData &&
    !!sceneColorAttachmentView &&
    !!cache.depthStencilView &&
    !!cache.unclassifiedPipeline &&
    !!cache.classifiedPipeline;

  if (canRunStencilGated) {
    // Stencil-gated two-pass composite. Targets the MSAA scene color
    // attachment with a resolve target so scene color resolves again
    // at pass end (overwriting the previous resolve with the
    // composited result). Depth-stencil attachment is the invert FBO's
    // MSAA depth-stencil, loaded read-only. Zero write masks leave it
    // unchanged. StencilReference = 0 matches
    // WebGL's `rsUnclassified.reference` / `rsClassified.reference`.
    const pass = encoder.beginRenderPass({
      label: "InvertClassification composite (stencil-gated)",
      colorAttachments: [
        {
          view: sceneColorAttachmentView!,
          resolveTarget: cache.sampleCount > 1 ? sceneResolveView : undefined,
          loadOp: "load" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
      depthStencilAttachment: {
        view: cache.depthStencilView!,
        depthLoadOp: "load",
        depthStoreOp: "store",
        stencilLoadOp: "load",
        stencilStoreOp: "store",
      },
    });
    pass.setStencilReference(0);
    pass.setBindGroup(0, cache.bindGroup);

    // Classified tiles first (stencil != 0) — raw tile color.
    pass.setPipeline(cache.classifiedPipeline!);
    pass.draw(3);

    // Unclassified tiles (stencil == 0) — tile color * highlight tint.
    pass.setPipeline(cache.unclassifiedPipeline!);
    pass.draw(3);

    pass.end();
    return;
  }

  // Single-sample fallback with no stencil.
  if (!cache.pipeline) {
    return;
  }
  const pass = encoder.beginRenderPass({
    label: "InvertClassification composite (single-pass fallback)",
    colorAttachments: [
      {
        view: sceneResolveView,
        loadOp: "load" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
      },
    ],
  });
  pass.setPipeline(cache.pipeline);
  pass.setBindGroup(0, cache.bindGroup);
  pass.draw(3);
  pass.end();
}

/**
 * Builds a color attachment that targets the InvertClassification classified
 * texture, with a resolve target when MSAA is active. Returns `null` if the
 * cache isn't ready (e.g., `update()` hasn't run this frame yet), signaling
 * the caller to fall back to rendering directly to the scene FBO.
 *
 * The caller is responsible for pairing this color attachment
 * with a compatible depth-stencil attachment (scene depth,
 * matching sample count) and for clearing the classified texture
 * at the start of the frame's redirected pass.
 */
function buildInvertClassificationColorAttachment(
  invertClass: CesiumObjectWithWebGPUCache,
): GPURenderPassColorAttachment | null {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  if (!cache?.initialized || !cache.classifiedTextureView) {
    return null;
  }
  const attachment: GPURenderPassColorAttachment = {
    view: cache.classifiedTextureView,
    loadOp: "clear",
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  };
  // MSAA pass: populate resolveTarget so the GPU resolves into the
  // single-sample `resolveTexture` at pass end — that's what the
  // composite bind group samples from.
  if (cache.sampleCount > 1 && cache.resolveTextureView) {
    attachment.resolveTarget = cache.resolveTextureView;
  }
  return attachment;
}

/**
 * Builds the depth-stencil attachment for the invert framebuffer. Used by
 * the redirected tile pass (loadOp=clear for both depth and stencil on first
 * use), the classification-ignore-show redirect (loadOp=load on both to
 * preserve tile depth and append stencil writes), and the stencil-gated
 * composite (loadOp=load on both so the accumulated
 * stencil bits drive which fragments pass).
 *
 * Callers specify the depth/stencil load ops so
 * the same helper covers all three use cases.
 */
function buildInvertClassificationDepthStencilAttachment(
  invertClass: CesiumObjectWithWebGPUCache,
  depthLoadOp: GPULoadOp = "clear",
  stencilLoadOp: GPULoadOp = "clear",
): GPURenderPassDepthStencilAttachment | null {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  if (!cache?.depthStencilView) {
    return null;
  }
  return {
    view: cache.depthStencilView,
    depthLoadOp,
    depthStoreOp: "store",
    depthClearValue: 1.0,
    stencilLoadOp,
    stencilStoreOp: "store",
    stencilClearValue: 0,
  };
}

/**
 * True when the InvertClassification cache is initialized and the
 * classified texture is sized for the current frame. Callers use this
 * to decide whether to take the FBO-redirect + composite path or fall
 * through to the plain 3D-tile pass.
 */
function isInvertClassificationReady(
  invertClass: CesiumObjectWithWebGPUCache,
): boolean {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  return !!(
    cache?.initialized &&
    cache.classifiedTextureView &&
    cache.bindGroup &&
    cache.pipeline &&
    cache.unclassifiedPipeline &&
    cache.classifiedPipeline &&
    cache.depthStencilView
  );
}

/**
 * Returns the MSAA sample count the redirected tile pass must use to
 * match the classified texture. Callers pair this with a depth
 * attachment of matching `sampleCount` to satisfy WebGPU's "all pass
 * attachments share sample count" invariant.
 */
function getInvertClassificationSampleCount(
  invertClass: CesiumObjectWithWebGPUCache,
): number {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  return cache?.sampleCount ?? 1;
}

/**
 * Returns the invert framebuffer's depth-stencil texture so
 * `WebGPUGlobeDepth.executeUpdateDepth` can
 * read from it when invert classification is active. Tile geometry
 * writes to this depth (not scene depth), so downstream consumers
 * that sample globe depth (ground / overlay / decal primitives) need
 * this source to see tile contributions. Mirrors WebGL's
 * `SceneRenderer.js:576` which passes
 * `scene._invertClassification._fbo.getDepthStencilTexture()`.
 *
 * Returns `undefined` when the cache isn't initialized or the depth
 * texture hasn't been allocated yet; callers fall back to the default
 * scene-depth source in that case.
 */
function getInvertClassificationDepthTexture(
  invertClass: CesiumObjectWithWebGPUCache,
): GPUTexture | undefined {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  return cache?.depthStencilTexture ?? undefined;
}

function destroyWebGPUInvertClassificationResources(
  invertClass: CesiumObjectWithWebGPUCache,
): void {
  const cache = invertClass._webgpuCache as
    InvertClassificationCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.classifiedTexture?.destroy();
  cache.resolveTexture?.destroy();
  cache.depthStencilTexture?.destroy();
  invertClass._webgpuCache = undefined;
}

export {
  updateWebGPUInvertClassification,
  executeInvertClassificationComposite,
  buildInvertClassificationColorAttachment,
  buildInvertClassificationDepthStencilAttachment,
  isInvertClassificationReady,
  getInvertClassificationSampleCount,
  getInvertClassificationDepthTexture,
  destroyWebGPUInvertClassificationResources,
};
export default {
  updateWebGPUInvertClassification,
  executeInvertClassificationComposite,
  buildInvertClassificationColorAttachment,
  buildInvertClassificationDepthStencilAttachment,
  isInvertClassificationReady,
  getInvertClassificationSampleCount,
  getInvertClassificationDepthTexture,
  destroyWebGPUInvertClassificationResources,
};
