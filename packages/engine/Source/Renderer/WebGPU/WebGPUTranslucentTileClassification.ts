/// <reference types="@webgpu/types" />
/**
 * WebGPU Translucent Tile Classification
 *
 * Original purpose (Batch 47): WebGPU equivalent of
 * `Scene/TranslucentTileClassification.js`. Enables classification
 * overlays to clamp to translucent 3D-tile surface depth instead of
 * falling through to the opaque globe depth underneath.
 *
 * **Migration Session 5 (Batch 85, ADR-2026-04-28) — current role:**
 * the depth-sample classifier
 * (`WebGPUGroundPrimitiveRenderer`) is the runtime consumer of this
 * module. The depth-pack pipeline is still active and produces
 * `_packedTranslucentDepthView` per frame; the depth-sample classifier
 * (Migration Session 2) reads it as the source of front-most
 * translucent surface depth. The depth-sample classifier draws
 * directly into scene color, so the prior accumulation-FBO + composite
 * scaffolding is no longer wired:
 *
 *   - `_runTranslucentTileClassificationComposite` was removed from
 *     `WebGPUSceneRenderer`; nothing now calls `composite()`.
 *   - `_classificationColorTexture` / `_classificationColorView` are
 *     allocated but never written. They are inert until a future
 *     cleanup batch removes them.
 *   - The composite pipeline (`_compositePipeline`, `_compositeBGL`,
 *     `_compositeBindGroup`, `_compositeShaderModule`,
 *     `COMPOSITE_WGSL`, `_ensureCompositePipeline`) is similarly
 *     allocated but unreferenced.
 *
 * Removing the unused scaffolding cleanly is a follow-up batch (~100
 * LOC of careful surgery in this file). It was deferred from Session 5
 * to keep the migration's runtime correctness changes isolated from
 * code-removal churn.
 *
 * **MSAA (Batch 61, C-R8-TRANSLUCENT-DEPTH-MSAA):** scenes with
 * `sampleCount > 1` are no longer skipped. The MSAA pack pipeline
 * binds the scene depth texture as `texture_depth_multisampled_2d` on
 * both opaque and translucent slots and reads sample 0 via
 * `textureLoad`. Output is byte-equivalent to the single-sample copy +
 * pack path's output, so the downstream depth-sample classifier
 * doesn't need MSAA-aware changes.
 *
 * **Current responsibilities:**
 *   - Per-frame translucent depth capture
 *     (`executeTranslucentDepthPass`).
 *   - Per-frame depth pack to RGBA8 color
 *     (`executePackDepth`).
 *   - Per-frame view publication via the
 *     `packedTranslucentDepthView` getter that
 *     `WebGPUSceneRenderer` reads after `executePackDepth` and
 *     publishes on `context._packedTranslucentDepthView`.
 *
 * **What's still a no-op (legacy scaffolding):**
 *   - The accumulation target + composite pipeline (see Session 5
 *     migration note above).
 *   - `executeClassificationPass` — kept as part of the public surface
 *     parity but not invoked.
 *
 * @module WebGPUTranslucentTileClassification
 * @private
 */

const COMPARE_AND_PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var opaqueDepthTex: texture_depth_2d;
@group(0) @binding(1) var translucentDepthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var o: VertexOutput;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

fn packDepth(d: f32) -> vec4<f32> {
  // No-surface sentinel — WebGL's czm_packDepth is fract-based, so
  // packing the "skip" depth 1.0 yields exactly (0,0,0,0) and the
  // depth-sample classifiers' sky discard (unpack == 0.0) fires.
  // Mirror that here (the floor-based pack would emit ~0.004 instead).
  if (d >= 1.0) {
    return vec4<f32>(0.0);
  }
  let bits = vec4<f32>(1.0, 255.0, 65025.0, 16581375.0) * d;
  let floored = floor(bits);
  let shifted = vec4<f32>(
    floored.x,
    floored.y - floored.x * 255.0,
    floored.z - floored.y * 255.0,
    floored.w - floored.z * 255.0,
  );
  return shifted / 255.0;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let opaqueDepth = textureSample(opaqueDepthTex, samp, in.uv);
  var translucentDepth = textureSample(translucentDepthTex, samp, in.uv);
  // Mirror WebGL CompareAndPackTranslucentDepth.glsl: when translucent
  // is BEHIND opaque (depth value larger), force it to 1.0 so
  // classification primitives skip it.
  if (translucentDepth > opaqueDepth) {
    translucentDepth = 1.0;
  }
  return packDepth(translucentDepth);
}
`;

// C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA variant of the
// compare-and-pack pipeline. WGSL `textureSample` cannot read a
// `texture_depth_multisampled_2d`, and MSAA depth attachments cannot be
// MSAA-resolved via a render-pass `resolveTarget` (only color targets
// support that). The workaround mirrors the Batch 43 globe-depth path:
// bind both depth sources as `texture_depth_multisampled_2d` and read
// `sampleIndex = 0` via `textureLoad`.
//
// Sample 0 is the canonical "first hit" used elsewhere in the project
// (see `DEPTH_COPY_MSAA_WGSL` in `WebGPUGlobeDepth.ts`). For translucent
// classification specifically, sample 0 produces output equivalent to
// the single-sample copy path: the WebGL `CompareAndPackTranslucentDepth`
// reference also operates on the resolved single-sample depth, and our
// `_translucentDepthTexture` (single-sample, populated via
// `copyTextureToTexture`) is itself the result of an implicit
// resolve-by-copy on the single-sample side. Per-sample averaging would
// introduce a packed-format rounding question and dominate the cost
// without changing classification correctness — `if (translucent >
// opaque) translucent = 1.0` is binary, so a single representative
// sample is sufficient. No sampler binding is needed (textureLoad is
// unsampled).
//
// In MSAA mode the FIRST-CUT scope is preserved: both opaque and
// translucent depth come from the same scene framebuffer depth texture
// (the over-broad capture the single-sample path also uses). With
// translucentDepth == opaqueDepth, the `>` test is always false, so
// the packed output is the scene depth — same end result as the
// single-sample copy + pack would produce.
const COMPARE_AND_PACK_MSAA_WGSL = /* wgsl */ `
@group(0) @binding(0) var opaqueDepthTex: texture_depth_multisampled_2d;
@group(0) @binding(1) var translucentDepthTex: texture_depth_multisampled_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var o: VertexOutput;
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  o.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

fn packDepth(d: f32) -> vec4<f32> {
  // No-surface sentinel — WebGL's czm_packDepth is fract-based, so
  // packing the "skip" depth 1.0 yields exactly (0,0,0,0) and the
  // depth-sample classifiers' sky discard (unpack == 0.0) fires.
  // Mirror that here (the floor-based pack would emit ~0.004 instead).
  if (d >= 1.0) {
    return vec4<f32>(0.0);
  }
  let bits = vec4<f32>(1.0, 255.0, 65025.0, 16581375.0) * d;
  let floored = floor(bits);
  let shifted = vec4<f32>(
    floored.x,
    floored.y - floored.x * 255.0,
    floored.z - floored.y * 255.0,
    floored.w - floored.z * 255.0,
  );
  return shifted / 255.0;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let coord = vec2<i32>(i32(in.position.x), i32(in.position.y));
  let opaqueDepth = textureLoad(opaqueDepthTex, coord, 0);
  var translucentDepth = textureLoad(translucentDepthTex, coord, 0);
  if (translucentDepth > opaqueDepth) {
    translucentDepth = 1.0;
  }
  return packDepth(translucentDepth);
}
`;

const COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var classifiedColorTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

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
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let c = textureSample(classifiedColorTex, samp, in.uv);
  // Discard wholly-empty pixels so scene color passes through.
  if (c.a <= 0.0) {
    discard;
  }
  return c;
}
`;

export class WebGPUTranslucentTileClassification {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _colorFormat: GPUTextureFormat = "bgra8unorm";

  // Translucent depth target (single-sample so the pack shader can
  // sample as `texture_depth_2d`). Reused across frames; resized only
  // on viewport change.
  private _translucentDepthTexture: GPUTexture | null = null;
  private _translucentDepthView: GPUTextureView | null = null;
  // Sampleable view (depth-only aspect) for the pack shader.
  private _translucentDepthSampleableView: GPUTextureView | null = null;

  // Packed depth color texture — RGBA8 single-sample, sampled by
  // classification pipelines as their `globeDepthTexture` substitute.
  private _packedDepthTexture: GPUTexture | null = null;
  private _packedDepthView: GPUTextureView | null = null;

  // Classification accumulation color (single-sample for sampling at
  // composite time). Sized to match the canvas; depth-stencil reuses
  // the translucent depth above so classification primitives that
  // depth-test pick up the front-most translucent surface.
  private _classificationColorTexture: GPUTexture | null = null;
  private _classificationColorView: GPUTextureView | null = null;

  // Pack pipeline: reads opaqueDepth + translucentDepth, writes packed
  // RGBA8 depth color.
  private _packPipeline: GPURenderPipeline | null = null;
  private _packBGL: GPUBindGroupLayout | null = null;
  private _packBindGroup: GPUBindGroup | null = null;

  // C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA variant of the pack
  // pipeline. Separate pipeline + bind group layout because the shader
  // binding type changes from `texture_depth_2d` to
  // `texture_depth_multisampled_2d` and the layout must declare
  // `multisampled: true` on each depth texture entry. Bind group has
  // no sampler (textureLoad is unsampled). Built lazily on first use.
  private _packMSAAPipeline: GPURenderPipeline | null = null;
  private _packMSAABGL: GPUBindGroupLayout | null = null;
  private _packMSAABindGroup: GPUBindGroup | null = null;
  private _packMSAAShaderModule: GPUShaderModule | null = null;

  // Composite pipeline: reads classification color, blends over scene.
  private _compositePipeline: GPURenderPipeline | null = null;
  private _compositeBGL: GPUBindGroupLayout | null = null;
  private _compositeBindGroup: GPUBindGroup | null = null;

  private _packShaderModule: GPUShaderModule | null = null;
  private _compositeShaderModule: GPUShaderModule | null = null;
  private _sampler: GPUSampler | null = null;

  // Per-frame state — set by `prepareForFrame()` and consumed by
  // downstream `execute*` calls.
  private _hasTranslucentDepth: boolean = false;
  // C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — when MSAA depth was
  // captured, `executePackDepth` must route through the MSAA pipeline
  // and bind the scene depth texture directly (no copy was performed).
  // Set by `executeTranslucentDepthPass`; consumed + cleared semantics
  // are per-frame via `prepareForFrame`.
  private _msaaSourceDepthTexture: GPUTexture | null = null;

  /**
   * Returns `true` when the WebGPU backend supports the depth-texture
   * sampling needed by translucent classification. Always true on
   * WebGPU (every WebGPU adapter supports `depth24plus` with
   * `TEXTURE_BINDING`).
   */
  isSupported(): boolean {
    return true;
  }

  /**
   * True when this frame produced translucent depth that downstream
   * classification can consume. Drives the conditional execution of
   * the classification pass + composite.
   */
  get hasTranslucentDepth(): boolean {
    return this._hasTranslucentDepth;
  }

  /**
   * Get the packed-depth view for binding into classification
   * pipelines as their `globeDepthTexture` substitute. Returns
   * undefined when there's no captured translucent depth this frame
   * (typical case for scenes without translucent 3D-tile content).
   */
  get packedTranslucentDepthView(): GPUTextureView | undefined {
    return this._hasTranslucentDepth
      ? (this._packedDepthView ?? undefined)
      : undefined;
  }

  /**
   * Update framebuffer dimensions + color format. Reallocates targets
   * on any change.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    colorFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;
    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._colorFormat !== colorFormat;
    if (!needsRecreate) return;

    this._destroyTargets();

    this._device = device;
    this._width = width;
    this._height = height;
    this._colorFormat = colorFormat;

    // Translucent depth — single-sample, sampleable. The classification
    // first-cut captures depth via copy from scene depth (over-broad);
    // when the depth-only-command derivation lands this becomes the
    // actual render target for those depth-only draws.
    //
    // NEW-4-I (Batch 71): format must match the scene FB depth attachment
    // (`SceneFramebuffer-Color_depth`), which is `depth24plus-stencil8`
    // because the scene FB carries stencil for InvertClassification. The
    // `copyTextureToTexture` call in `executeTranslucentDepthPass` rejects
    // mismatched formats per WebGPU spec — even when both endpoints
    // specify `aspect: "depth-only"`, the underlying texture format must
    // match. Stencil aspect is unused by the translucent pack pipeline
    // (the sampleable view below pins `aspect: "depth-only"`), so the
    // cost is one stencil byte per pixel — negligible at any practical
    // viewport size.
    this._translucentDepthTexture = device.createTexture({
      label: "TranslucentTileClass_TranslucentDepth_1x",
      size: { width, height },
      format: "depth24plus-stencil8",
      sampleCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
    this._translucentDepthView = this._translucentDepthTexture.createView();
    this._translucentDepthSampleableView =
      this._translucentDepthTexture.createView({
        aspect: "depth-only",
        label: "TranslucentTileClass_TranslucentDepth_Sampleable",
      });

    this._packedDepthTexture = device.createTexture({
      label: "TranslucentTileClass_PackedDepth",
      size: { width, height },
      format: "rgba8unorm",
      sampleCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._packedDepthView = this._packedDepthTexture.createView();

    this._classificationColorTexture = device.createTexture({
      label: "TranslucentTileClass_ClassificationColor",
      size: { width, height },
      format: colorFormat,
      sampleCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._classificationColorView =
      this._classificationColorTexture.createView();

    // Pipelines + bind groups are format-sensitive — rebuild them too.
    this._packPipeline = null;
    this._packBindGroup = null;
    this._packMSAAPipeline = null;
    this._packMSAABindGroup = null;
    this._compositePipeline = null;
    this._compositeBindGroup = null;
  }

  /**
   * Reset per-frame state. Called at the start of each render before
   * the orchestration calls fire.
   */
  prepareForFrame(): void {
    this._hasTranslucentDepth = false;
    this._msaaSourceDepthTexture = null;
  }

  /**
   * Capture translucent depth by copying from `sceneDepthTexture` AFTER
   * the main translucent pass ends.
   *
   * **Selectivity (C-R8-TRANSLUCENT-DEPTH-ONLY, Batch 78):** the broad
   * scene-depth copy is now gated on whether ANY command in the current
   * frustum carries `depthForTranslucentClassification === true`. When
   * no commands are flagged (most scenes — only 3D-tilesets ever set
   * the flag, via `Cesium3DTile.js:1084`), the entire pack-depth
   * pipeline is short-circuited: no copy, no MSAA source recording, no
   * pack pass downstream. Saves a per-frustum copy when nothing reads
   * the result.
   *
   * **Still over-broad when active:** when at least one flagged command
   * exists, the implementation still uses the scene-depth copy path
   * (captures ALL translucent geometry, not just 3D-tile content).
   * Producing the truly selective render needs depth-only WGSL pipeline
   * variants per command — folded into the C-R8-TRANSLUCENT-MULTI-FRUSTUM
   * work because the per-frustum render pass restructure is the natural
   * place for it.
   */
  executeTranslucentDepthPass(
    encoder: GPUCommandEncoder,
    sceneDepthTexture: GPUTexture | null,
    flaggedCommandsPresent: boolean,
  ): void {
    if (!this._device || !sceneDepthTexture) return;
    if (!this._translucentDepthTexture) return;
    if (!flaggedCommandsPresent) {
      // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 78) — no `depthForTranslucent-
      // Classification` commands in this frustum; the captured depth
      // would feed nothing useful. Clear the in-flight flag so
      // `executePackDepth` is a no-op + `composite` correctly skips.
      this._msaaSourceDepthTexture = null;
      this._hasTranslucentDepth = false;
      return;
    }

    const sampleCount =
      (sceneDepthTexture as unknown as { sampleCount?: number }).sampleCount ??
      1;
    if (sampleCount > 1) {
      // C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA scene depth
      // cannot be copied via `copyTextureToTexture` (the platform
      // requires `sampleCount === destination.sampleCount`, and our
      // `_translucentDepthTexture` is single-sample on purpose so the
      // single-sample pack pipeline can sample it). Instead of copying,
      // record the source texture and let `executePackDepth` route
      // through the MSAA-variant pipeline that reads it directly via
      // `textureLoad(coord, 0)`.
      //
      // First-cut scope is preserved: opaque AND translucent depth both
      // come from the same scene framebuffer depth (over-broad — same
      // limitation as the single-sample path), so the WGSL `if
      // (translucentDepth > opaqueDepth)` test never trips, and the
      // packed output equals the scene depth — identical end-state to
      // what the single-sample copy + pack would have produced.
      this._msaaSourceDepthTexture = sceneDepthTexture;
      this._hasTranslucentDepth = true;
      return;
    }

    // Single-sample path: copy from scene depth into our owned target
    // so the pack pipeline can sample it as `texture_depth_2d`. The
    // scene depth has `COPY_SRC` by virtue of how the framebuffer is
    // allocated (`WebGPURenderTarget.createTextures` adds the bit when
    // `depthSamplable` is true); runtime mismatches surface as a
    // validation error in the same call.
    //
    // Aspect must be `"all"` (not `"depth-only"`) — the WebGPU spec
    // rejects `aspect: "depth-only"` for `copyTextureToTexture` when
    // the texture format carries a stencil aspect. Both sides are
    // `Depth24PlusStencil8` (after Batch 71's depth-format alignment),
    // so `"all"` is the only valid copy aspect. The pack pipeline's
    // sampleable view (allocated above with `aspect: "depth-only"`)
    // only binds the depth channel, so the stencil bytes copied into
    // the destination are inert.
    encoder.copyTextureToTexture(
      { texture: sceneDepthTexture, aspect: "all" },
      { texture: this._translucentDepthTexture, aspect: "all" },
      { width: this._width, height: this._height },
    );
    this._msaaSourceDepthTexture = null;
    this._hasTranslucentDepth = true;
  }

  /**
   * Pack the captured translucent depth into the RGBA8 color texture
   * that classification pipelines bind as `globeDepthTexture`.
   * Compares against the opaque depth so translucent surfaces behind
   * opaque geometry are forced to 1.0 (skipped by classification).
   *
   * `opaqueDepthSampleableView` should be the scene framebuffer's
   * depth-only view (single-sample). Bails if either depth source
   * isn't ready.
   */
  executePackDepth(
    encoder: GPUCommandEncoder,
    opaqueDepthSampleableView: GPUTextureView | null,
  ): void {
    if (!this._device || !this._hasTranslucentDepth) return;
    if (!this._packedDepthView) return;

    if (this._msaaSourceDepthTexture) {
      this._executePackDepthMSAA(encoder, this._msaaSourceDepthTexture);
      return;
    }

    if (!opaqueDepthSampleableView) return;
    if (!this._translucentDepthSampleableView) return;

    this._ensurePackPipeline();
    if (!this._packPipeline || !this._packBGL || !this._sampler) return;

    this._packBindGroup = this._device.createBindGroup({
      label: "TranslucentTileClass_PackBindGroup",
      layout: this._packBGL,
      entries: [
        { binding: 0, resource: opaqueDepthSampleableView },
        { binding: 1, resource: this._translucentDepthSampleableView },
        { binding: 2, resource: this._sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "TranslucentTileClass_PackPass",
      colorAttachments: [
        {
          view: this._packedDepthView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 1, g: 1, b: 1, a: 1 }, // depth=1 in packed form
        },
      ],
    });
    pass.setPipeline(this._packPipeline);
    pass.setBindGroup(0, this._packBindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — MSAA pack path. Binds the
   * MSAA scene depth as both opaque and translucent inputs (the
   * first-cut over-broad capture means they're the same texture); the
   * MSAA-variant shader reads sample 0 via `textureLoad`. Identical
   * downstream output to the single-sample copy + pack — same
   * `_packedDepthTexture` is written, so the composite pass and any
   * classification-pipeline `globeDepthTexture` consumer don't need
   * MSAA-aware changes.
   */
  private _executePackDepthMSAA(
    encoder: GPUCommandEncoder,
    msaaDepthTexture: GPUTexture,
  ): void {
    if (!this._device || !this._packedDepthView) return;

    this._ensurePackMSAAPipeline();
    if (!this._packMSAAPipeline || !this._packMSAABGL) return;

    const opaqueView = msaaDepthTexture.createView({
      aspect: "depth-only",
      label: "TranslucentTileClass_MSAA_OpaqueDepthView",
    });
    // Translucent input is the same texture in the first-cut path.
    // Cheaper to create one view and reuse, but WebGPU requires a
    // distinct binding entry per slot — same view object satisfies that.
    const translucentView = msaaDepthTexture.createView({
      aspect: "depth-only",
      label: "TranslucentTileClass_MSAA_TranslucentDepthView",
    });

    this._packMSAABindGroup = this._device.createBindGroup({
      label: "TranslucentTileClass_PackMSAABindGroup",
      layout: this._packMSAABGL,
      entries: [
        { binding: 0, resource: opaqueView },
        { binding: 1, resource: translucentView },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "TranslucentTileClass_PackMSAAPass",
      colorAttachments: [
        {
          view: this._packedDepthView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
    });
    pass.setPipeline(this._packMSAAPipeline);
    pass.setBindGroup(0, this._packMSAABindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Composite the classification accumulation onto the scene color
   * target. No-op when no translucent depth was captured.
   */
  composite(
    encoder: GPUCommandEncoder,
    targetColorView: GPUTextureView,
    targetFormat: GPUTextureFormat,
  ): void {
    if (!this._device || !this._hasTranslucentDepth) return;
    if (!this._classificationColorView) return;

    this._ensureCompositePipeline(targetFormat);
    if (!this._compositePipeline || !this._compositeBGL || !this._sampler) {
      return;
    }

    this._compositeBindGroup = this._device.createBindGroup({
      label: "TranslucentTileClass_CompositeBindGroup",
      layout: this._compositeBGL,
      entries: [
        { binding: 0, resource: this._classificationColorView },
        { binding: 1, resource: this._sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "TranslucentTileClass_CompositePass",
      colorAttachments: [
        {
          view: targetColorView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compositeBindGroup);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this._destroyTargets();
    this._packPipeline = null;
    this._packBGL = null;
    this._packBindGroup = null;
    this._packMSAAPipeline = null;
    this._packMSAABGL = null;
    this._packMSAABindGroup = null;
    this._packMSAAShaderModule = null;
    this._compositePipeline = null;
    this._compositeBGL = null;
    this._compositeBindGroup = null;
    this._packShaderModule = null;
    this._compositeShaderModule = null;
    this._sampler = null;
    this._msaaSourceDepthTexture = null;
    this._device = null;
  }

  private _destroyTargets(): void {
    this._translucentDepthTexture?.destroy();
    this._packedDepthTexture?.destroy();
    this._classificationColorTexture?.destroy();
    this._translucentDepthTexture = null;
    this._translucentDepthView = null;
    this._translucentDepthSampleableView = null;
    this._packedDepthTexture = null;
    this._packedDepthView = null;
    this._classificationColorTexture = null;
    this._classificationColorView = null;
  }

  private _ensurePackPipeline(): void {
    if (this._packPipeline || !this._device) return;
    const device = this._device;

    if (!this._packShaderModule) {
      this._packShaderModule = device.createShaderModule({
        label: "TranslucentTileClass_PackShader",
        code: COMPARE_AND_PACK_WGSL,
      });
    }
    if (!this._sampler) {
      this._sampler = device.createSampler({
        label: "TranslucentTileClass_Sampler",
        magFilter: "nearest",
        minFilter: "nearest",
      });
    }

    this._packBGL = device.createBindGroupLayout({
      label: "TranslucentTileClass_PackBGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "depth", viewDimension: "2d" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "depth", viewDimension: "2d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        },
      ],
    });

    this._packPipeline = device.createRenderPipeline({
      label: "TranslucentTileClass_PackPipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._packBGL],
      }),
      vertex: {
        module: this._packShaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: this._packShaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61) — lazily build the MSAA
   * variant of the pack pipeline. Bind group layout has two
   * `multisampled: true` depth texture slots and no sampler. Pipeline
   * is single-sample (it writes to the single-sample
   * `_packedDepthTexture`); only the source bindings are multisampled.
   */
  private _ensurePackMSAAPipeline(): void {
    if (this._packMSAAPipeline || !this._device) return;
    const device = this._device;

    if (!this._packMSAAShaderModule) {
      this._packMSAAShaderModule = device.createShaderModule({
        label: "TranslucentTileClass_PackMSAAShader",
        code: COMPARE_AND_PACK_MSAA_WGSL,
      });
    }

    this._packMSAABGL = device.createBindGroupLayout({
      label: "TranslucentTileClass_PackMSAABGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "depth",
            viewDimension: "2d",
            multisampled: true,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: "depth",
            viewDimension: "2d",
            multisampled: true,
          },
        },
      ],
    });

    this._packMSAAPipeline = device.createRenderPipeline({
      label: "TranslucentTileClass_PackMSAAPipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._packMSAABGL],
      }),
      vertex: {
        module: this._packMSAAShaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: this._packMSAAShaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private _ensureCompositePipeline(targetFormat: GPUTextureFormat): void {
    // Rebuild on format change so HDR scenes get the right target type.
    if (
      this._compositePipeline &&
      (this._compositePipeline as { _targetFormat?: GPUTextureFormat })
        ._targetFormat === targetFormat
    ) {
      return;
    }
    if (!this._device) return;
    const device = this._device;

    if (!this._compositeShaderModule) {
      this._compositeShaderModule = device.createShaderModule({
        label: "TranslucentTileClass_CompositeShader",
        code: COMPOSITE_WGSL,
      });
    }

    this._compositeBGL = device.createBindGroupLayout({
      label: "TranslucentTileClass_CompositeBGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this._compositePipeline = device.createRenderPipeline({
      label: "TranslucentTileClass_CompositePipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._compositeBGL],
      }),
      vertex: {
        module: this._compositeShaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: this._compositeShaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: targetFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    (
      this._compositePipeline as { _targetFormat?: GPUTextureFormat }
    )._targetFormat = targetFormat;
  }
}

export default WebGPUTranslucentTileClassification;
