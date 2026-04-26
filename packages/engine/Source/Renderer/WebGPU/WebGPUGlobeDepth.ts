/// <reference types="@webgpu/types" />
/**
 * WebGPU equivalent of GlobeDepth.js
 *
 * Manages depth framebuffers for the globe rendering pass. In WebGL, GlobeDepth
 * copies depth to a color texture (via a fullscreen quad + shader) so that shaders
 * can sample it. In WebGPU, we can directly use the depth texture as a shader resource
 * via texture_depth_2d, which is more efficient.
 *
 * Responsibilities:
 * - Maintain render target for globe color+depth rendering
 * - Provide depth texture for shader access (terrain clamping, picking, etc.)
 * - Support MSAA with automatic resolve
 * - Depth copy for 3D Tiles stencil-masked depth update
 * - Pick color framebuffer (separate, no MSAA)
 *
 * @private
 */

import { WebGPURenderTarget } from "./WebGPURenderTarget.js";
import {
  makeBindGroupLayout,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// Depth copy shader (single-sample): reads depth and writes to a color
// texture as packed RGBA.
const DEPTH_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0)
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let depth = textureSample(depthTex, depthSampler, in.uv);
  // Pack float depth into RGBA8 for compatibility with existing globe depth texture consumers
  let d = depth;
  let r = floor(d * 255.0) / 255.0;
  let g = floor((d - r) * 65025.0) / 255.0;
  let b = floor((d - r - g / 255.0) * 16581375.0) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
`;

// C-R8-GLOBE-DEPTH-MSAA (Batch 43) — MSAA variant. WGSL's
// `textureSample` can't read a `texture_depth_multisampled_2d`, and
// MSAA depth targets can't be resolved via a render-pass `resolveTarget`
// (the platform only resolves color attachments). The workaround:
// sample one specific fragment (`sampleIndex = 0`) via `textureLoad`.
// This matches the convention of WebGL's `glSampleCoverage` /
// default-sample read path — center-of-pixel depth is a reasonable
// approximation for pickPosition / terrain clamping, which don't
// need per-sample depth accuracy.
//
// The shader derives the integer pixel coordinate from the @builtin
// position (pre-viewport pixel coords). No sampler binding is needed
// (textureLoad is unsampled).
//
// Note on sample selection: sampling index 0 is deterministic and
// matches the MSAA pattern center for sample count 1 and the first
// sample for higher counts. Per-sample averaging would be more
// accurate but introduces a packed-format rounding question and
// dominates the cost; sample-0 is the standard approach.
const DEPTH_COPY_MSAA_WGSL = /* wgsl */ `
@group(0) @binding(0) var depthTex: texture_depth_multisampled_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let coord = vec2<i32>(i32(in.position.x), i32(in.position.y));
  let depth = textureLoad(depthTex, coord, 0);
  let d = depth;
  let r = floor(d * 255.0) / 255.0;
  let g = floor((d - r) * 65025.0) / 255.0;
  let b = floor((d - r - g / 255.0) * 16581375.0) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
`;

export interface WebGPUGlobeDepthOptions {
  picking?: boolean;
}

export class WebGPUGlobeDepth {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _numSamples: number = 1;

  // Main color+depth render target (supports MSAA)
  private _outputTarget: WebGPURenderTarget | null = null;

  // Pick-mode render target (no MSAA)
  private _pickTarget: WebGPURenderTarget | null = null;

  // Depth copy target: stores packed depth as RGBA color texture
  private _depthCopyTarget: WebGPURenderTarget | null = null;

  // Temp depth copy target for the 2-step stencil-masked update
  private _tempDepthCopyTarget: WebGPURenderTarget | null = null;

  // Depth copy pipeline resources (single-sample path)
  private _depthCopyPipeline: GPURenderPipeline | null = null;
  private _depthCopyBindGroupLayout: GPUBindGroupLayout | null = null;
  private _depthCopyBindGroup: GPUBindGroup | null = null;
  private _depthCopySampler: GPUSampler | null = null;

  // C-R8-GLOBE-DEPTH-MSAA (Batch 43) — MSAA-depth sampling variant.
  // Separate pipeline + bind group layout because the shader binding
  // type changes from `texture_depth_2d` to
  // `texture_depth_multisampled_2d` and the pipeline must be created
  // with a non-default `multisampleType` on the texture binding.
  // Bind group has no sampler (textureLoad is unsampled).
  private _depthCopyMSAAPipeline: GPURenderPipeline | null = null;
  private _depthCopyMSAABindGroupLayout: GPUBindGroupLayout | null = null;
  private _depthCopyMSAABindGroup: GPUBindGroup | null = null;

  private _isPicking: boolean = false;
  private _isDestroyed: boolean = false;

  // Public state used by Scene.js
  private _clearGlobeDepth: boolean = false;
  private _useHdr: boolean = false;

  constructor(options?: WebGPUGlobeDepthOptions) {
    this._isPicking = options?.picking ?? false;
  }

  /**
   * The render target for globe color+depth rendering.
   * Returns pick target when in pick mode.
   */
  get colorFramebufferTarget(): WebGPURenderTarget | null {
    return this._isPicking ? this._pickTarget : this._outputTarget;
  }

  /**
   * The render pass descriptor to use for rendering globe geometry.
   */
  get framebuffer(): GPURenderPassDescriptor | null {
    const target = this.colorFramebufferTarget;
    return target?.renderPassDescriptor ?? null;
  }

  /**
   * The depth texture for shader sampling.
   * In WebGPU, this can be used directly as texture_depth_2d.
   */
  get depthTexture(): GPUTexture | undefined {
    const target = this.colorFramebufferTarget;
    return target?.getDepthTexture() ?? undefined;
  }

  /**
   * The packed-depth-as-color texture (for compatibility with existing code
   * that expects globeDepthTexture as a color texture).
   */
  get globeDepthTexture(): GPUTexture | undefined {
    return this._depthCopyTarget?.getColorTexture() ?? undefined;
  }

  /**
   * The color texture from the globe rendering pass.
   */
  get colorTexture(): GPUTexture | undefined {
    const target = this.colorFramebufferTarget;
    return target?.getColorTexture() ?? undefined;
  }

  get clearGlobeDepth(): boolean {
    return this._clearGlobeDepth;
  }

  set clearGlobeDepth(value: boolean) {
    this._clearGlobeDepth = value;
  }

  /**
   * Update all render targets to match current viewport and settings.
   * Only recreates resources when parameters change.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    hdr: boolean,
    numSamples: number,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._numSamples !== numSamples ||
      this._useHdr !== hdr;

    if (!needsRecreate) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;
    this._useHdr = hdr;

    this._destroyTargets();

    const colorFormat = hdr
      ? ("rgba16float" as GPUTextureFormat)
      : canvasFormat;

    // Main output target with MSAA + depth-stencil
    this._outputTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-Output",
      width,
      height,
      colorFormats: [colorFormat],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: numSamples,
    });

    // Pick target (no MSAA)
    this._pickTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-Pick",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: 1,
    });

    // Depth copy target: stores packed depth as RGBA
    this._depthCopyTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-DepthCopy",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      sampleCount: 1,
    });

    // Temp copy for stencil-masked update
    this._tempDepthCopyTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-TempDepthCopy",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      sampleCount: 1,
    });

    // Create depth copy pipelines if not cached. Both single-sample
    // and MSAA variants are built eagerly — they're tiny (one shader
    // module + pipeline each) and having both ready means
    // `executeCopyDepth` can pick based on the source texture's actual
    // sampleCount without a late recompile.
    this._createDepthCopyPipeline(device);
    this._createDepthCopyMSAAPipeline(device);
  }

  /**
   * C-R8 (Batch 35) — WebGPU equivalent of
   * `GlobeDepth.executeUpdateDepth(context, passState, depthStencilTexture)`.
   * Fires after the main 3D Tile pass so subsequent classification,
   * overlay, and ground primitives read depth that includes tile
   * contributions rather than the pre-tile terrain-only state.
   *
   * Shares the depth-to-color copy implementation with
   * {@link executeCopyDepth} — in the current single-depth-attachment
   * WebGPU model, "update" and "copy" produce the same result: the
   * current live depth is projected into the color-ref texture that
   * downstream shaders sample. The method exists as a separate named
   * entry point so SceneRenderer caller intent stays clear (WebGL
   * has two distinct paths that composite partial updates; WebGPU
   * folds them into the same re-copy operation).
   */
  executeUpdateDepth(
    encoder: GPUCommandEncoder,
    depthTextureOverride?: GPUTexture,
  ): void {
    this.executeCopyDepth(encoder, depthTextureOverride);
  }

  /**
   * Copy the depth buffer to a color texture for shader access.
   * This is the WebGPU equivalent of GlobeDepth.executeCopyDepth().
   *
   * C-R8-INVERT-DEPTH-SOURCE (Batch 41) — `depthTextureOverride` lets
   * callers replace the default scene-framebuffer depth source for a
   * single copy. Used when InvertClassification is active: tile
   * geometry writes to the invert FBO's own depth texture (not scene
   * depth), and the post-tile copy should sample THAT depth so
   * downstream ground/overlay primitives see tile contributions.
   * Mirrors WebGL's `SceneRenderer.js:573-578` which passes
   * `scene._invertClassification._fbo.getDepthStencilTexture()` here.
   */
  executeCopyDepth(
    encoder: GPUCommandEncoder,
    depthTextureOverride?: GPUTexture,
  ): void {
    if (
      !this._depthCopyTarget ||
      !this._depthCopyPipeline ||
      !this._outputTarget
    ) {
      return;
    }

    // Create bind group with current depth texture (or the override,
    // when the caller is signalling "copy from this depth instead").
    // This also sets `_useMSAADepthCopy` based on the source texture's
    // sample count, driving the pipeline + bind group selection below.
    const useMSAA = this._updateDepthCopyBindGroup(depthTextureOverride);

    const bindGroup = useMSAA
      ? this._depthCopyMSAABindGroup
      : this._depthCopyBindGroup;
    const pipeline = useMSAA
      ? this._depthCopyMSAAPipeline
      : this._depthCopyPipeline;
    if (!bindGroup || !pipeline) return;

    const desc = this._depthCopyTarget.getLoadPassDescriptor();
    if (!desc) return;

    const pass = encoder.beginRenderPass(desc);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }

  /**
   * Create the depth copy render pipeline (single-sample path).
   */
  private _createDepthCopyPipeline(device: GPUDevice): void {
    if (this._depthCopyPipeline) return;

    const shaderModule = device.createShaderModule({
      label: "GlobeDepth-DepthCopy-Shader",
      code: DEPTH_COPY_WGSL,
    });

    this._depthCopyBindGroupLayout = makeBindGroupLayout(
      device,
      "GlobeDepth-DepthCopy-BindGroupLayout",
      [
        texture(0, Stage.FRAGMENT, { sampleType: "depth" }),
        // NEW-4-B (Batch 66) — depth textures expose a "non-filtering"
        // sampler type only; pairing with a default "filtering" sampler
        // throws WebGPU validation: "depth-only texture must be paired
        // with non-filtering sampler". The depth-copy fragment uses
        // textureLoad-style nearest reads, so non-filtering is correct.
        sampler(1, Stage.FRAGMENT, "non-filtering"),
      ],
    );

    this._depthCopySampler = device.createSampler({
      label: "GlobeDepth-DepthCopy-Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "GlobeDepth-DepthCopy-PipelineLayout",
      bindGroupLayouts: [this._depthCopyBindGroupLayout],
    });

    this._depthCopyPipeline = device.createRenderPipeline({
      label: "GlobeDepth-DepthCopy-Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /**
   * C-R8-GLOBE-DEPTH-MSAA (Batch 43) — Create the MSAA-capable depth
   * copy pipeline. Shader binding is `texture_depth_multisampled_2d`;
   * the bind group layout reflects that (via the `multisampled: true`
   * entry). No sampler binding — MSAA depth is read via `textureLoad`
   * which is unsampled.
   */
  private _createDepthCopyMSAAPipeline(device: GPUDevice): void {
    if (this._depthCopyMSAAPipeline) return;

    const shaderModule = device.createShaderModule({
      label: "GlobeDepth-DepthCopy-MSAA-Shader",
      code: DEPTH_COPY_MSAA_WGSL,
    });

    // Hand-rolled bind group layout — the `texture()` helper doesn't
    // expose `multisampled` yet (a follow-up to the helper would be
    // adding an overload). The shape is: one multisampled depth
    // texture at binding 0, nothing else.
    this._depthCopyMSAABindGroupLayout = device.createBindGroupLayout({
      label: "GlobeDepth-DepthCopy-MSAA-BindGroupLayout",
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
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "GlobeDepth-DepthCopy-MSAA-PipelineLayout",
      bindGroupLayouts: [this._depthCopyMSAABindGroupLayout],
    });

    this._depthCopyMSAAPipeline = device.createRenderPipeline({
      label: "GlobeDepth-DepthCopy-MSAA-Pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * Update the bind group to reference the current depth texture.
   */
  /**
   * Routes the bind group allocation to the single-sample or MSAA
   * path based on the source texture's `sampleCount`. Returns `true`
   * when MSAA was picked (caller uses `_depthCopyMSAABindGroup` and
   * `_depthCopyMSAAPipeline`), `false` for single-sample. The return
   * value lets `executeCopyDepth` avoid re-reading `sampleCount` and
   * keeps the branch logic in one place.
   */
  private _updateDepthCopyBindGroup(
    depthTextureOverride?: GPUTexture,
  ): boolean {
    const device = this._device;
    if (!device) {
      return false;
    }

    // Source texture order: explicit override > internal output target.
    // Callers should always pass an explicit override because the
    // internal `_outputTarget` is never actually rendered INTO by
    // WebGPU scene code (scene renders to `_sceneFramebuffer`
    // elsewhere); its depth attachment is always cleared. The
    // internal fallback stays for API compat with any caller that
    // still omits the override.
    let depthTexture = depthTextureOverride;
    if (!depthTexture) {
      const target = this.colorFramebufferTarget;
      if (!target) {
        this._depthCopyBindGroup = null;
        this._depthCopyMSAABindGroup = null;
        return false;
      }
      depthTexture = target.getDepthTexture();
    }
    if (!depthTexture) {
      this._depthCopyBindGroup = null;
      this._depthCopyMSAABindGroup = null;
      return false;
    }

    const sampleCount =
      (depthTexture as unknown as { sampleCount?: number }).sampleCount ?? 1;

    const depthView = depthTexture.createView({
      aspect: "depth-only",
      label: `GlobeDepth-DepthTextureView${sampleCount > 1 ? "-MSAA" : ""}`,
    });

    if (sampleCount > 1) {
      // MSAA path — bind group has no sampler, shader uses textureLoad.
      if (!this._depthCopyMSAABindGroupLayout) {
        return false;
      }
      this._depthCopyMSAABindGroup = device.createBindGroup({
        label: "GlobeDepth-DepthCopy-MSAA-BindGroup",
        layout: this._depthCopyMSAABindGroupLayout,
        entries: [{ binding: 0, resource: depthView }],
      });
      // Clear the single-sample slot so stale bindings don't leak
      // across frames if the sample count flips.
      this._depthCopyBindGroup = null;
      return true;
    }

    // Single-sample path.
    if (!this._depthCopyBindGroupLayout || !this._depthCopySampler) {
      return false;
    }
    this._depthCopyBindGroup = device.createBindGroup({
      label: "GlobeDepth-DepthCopy-BindGroup",
      layout: this._depthCopyBindGroupLayout,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._depthCopySampler },
      ],
    });
    this._depthCopyMSAABindGroup = null;
    return false;
  }

  private _destroyTargets(): void {
    this._outputTarget?.destroy();
    this._pickTarget?.destroy();
    this._depthCopyTarget?.destroy();
    this._tempDepthCopyTarget?.destroy();
    this._outputTarget = null;
    this._pickTarget = null;
    this._depthCopyTarget = null;
    this._tempDepthCopyTarget = null;
    this._depthCopyBindGroup = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTargets();
    this._depthCopyPipeline = null;
    this._depthCopyBindGroupLayout = null;
    this._depthCopySampler = null;
    this._depthCopyMSAAPipeline = null;
    this._depthCopyMSAABindGroupLayout = null;
    this._depthCopyMSAABindGroup = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
