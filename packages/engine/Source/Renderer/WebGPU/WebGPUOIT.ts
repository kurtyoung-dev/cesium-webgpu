/// <reference types="@webgpu/types" />
/**
 * WebGPU Order-Independent Transparency (OIT)
 *
 * Implements weighted blended OIT for correct translucent rendering.
 * Based on McGuire & Bavoil 2013 "Weighted Blended Order-Independent Transparency"
 *
 * Strategy:
 * 1. Render translucent geometry to MRT (Multi-Render-Target):
 *    - Target 0 (accumulation): premultiplied-alpha color * weight
 *    - Target 1 (revealage): alpha * weight (product)
 * 2. Composite over the opaque scene using a fullscreen pass:
 *    - finalColor = accumulation.rgb / max(accumulation.a, epsilon)
 *    - alpha = 1 - revealage
 *
 * If dual-source-blending is available (Chrome 128+), we use it for
 * single-pass OIT. Otherwise, we fall back to this MRT approach.
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
import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";

// OIT composite shader: combines accumulation + revealage textures with opaque scene
const OIT_COMPOSITE_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var accumulationTex: texture_2d<f32>;
@group(0) @binding(1) var revealageTex: texture_2d<f32>;
@group(0) @binding(2) var oitSampler: sampler;

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
  let accum = textureSample(accumulationTex, oitSampler, in.uv);
  let reveal = textureSample(revealageTex, oitSampler, in.uv).r;

  // Avoid division by zero
  let eps = 0.00001;

  // Weighted blended OIT composite
  let averageColor = accum.rgb / max(accum.a, eps);

  // revealage is the product of (1-alpha) for all fragments
  // So alpha = 1 - revealage
  let alpha = 1.0 - reveal;

  return vec4<f32>(averageColor * alpha, alpha);
}
`;

export class WebGPUOIT {
  private readonly _timestampProvider: WebGPUPassTimestampProvider | null;
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;

  // MRT render targets for OIT accumulation pass
  private _accumulationTexture: GPUTexture | null = null;
  private _revealageTexture: GPUTexture | null = null;
  private _accumulationView: GPUTextureView | null = null;
  private _revealageView: GPUTextureView | null = null;

  // Shared depth-stencil (borrowed from opaque pass)
  private _depthStencilView: GPUTextureView | null = null;

  // Composite pipeline resources
  private _compositePipeline: GPURenderPipeline | null = null;
  // The color-target format the current composite pipeline was built for. The
  // composite render pass writes into the scene color (bgra8unorm by default,
  // rgba16float in HDR); the pipeline's target format MUST match the attachment
  // or WebGPU fails pipeline-vs-attachment validation. Pre-fix this was pinned
  // to rgba8unorm and never rebuilt, so MRT-OIT composite failed every frame.
  private _compositeFormat: GPUTextureFormat = "rgba8unorm";
  private _compositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _compositeBindGroup: GPUBindGroup | null = null;
  private _compositeSampler: GPUSampler | null = null;

  // Scene color format for format-compatible single-target mode
  private _sceneColorFormat: GPUTextureFormat = "bgra8unorm";

  // Whether OIT is supported and enabled
  private _supported: boolean = false;
  private _isDestroyed: boolean = false;

  constructor(timestampProvider?: WebGPUPassTimestampProvider) {
    this._timestampProvider = timestampProvider ?? null;
  }

  /**
   * Whether OIT is supported on this device.
   */
  get isSupported(): boolean {
    return this._supported;
  }

  /**
   * The MRT render pass descriptor for the OIT accumulation pass.
   * Translucent geometry is rendered using this pass.
   */
  getAccumulationPassDescriptor(
    depthStencilView: GPUTextureView,
  ): GPURenderPassDescriptor | null {
    if (!this._accumulationView || !this._revealageView) {
      return null;
    }

    return {
      label: "OIT-Accumulation-Pass",
      colorAttachments: [
        {
          view: this._accumulationView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
        {
          view: this._revealageView,
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
      // C11-157 Slice A — READ-ONLY depth+stencil. The OIT accumulation pass
      // depth-TESTS translucent fragments against the opaque scene depth but
      // never writes it (the OIT pipelines set depthWriteEnabled:false). For a
      // combined depth24plus-stencil8 target the attachment must encompass ALL
      // aspects, so BOTH depth and stencil are declared read-only; WebGPU
      // forbids loadOp/storeOp alongside `*ReadOnly: true`, so they are omitted
      // (the prior `depthReadOnly:true` + depthLoadOp/StoreOp combination was
      // an invalid descriptor that failed validation every frame — latent
      // because the OIT path was unreachable until Slice A wired it up). The
      // `depthStencilView` MUST be the all-aspects render-pass attachment view,
      // NOT a depth-only sampleable view (see the caller).
      depthStencilAttachment: {
        view: depthStencilView,
        depthReadOnly: true,
        stencilReadOnly: true,
      },
    };
  }

  // Session 65 Batch 33 — MSAA sample count tracked alongside the
  // viewport dimensions. When `context._msaaSamples` changes (bridge
  // re-enable), `update()` rebuilds the composite pipeline at the new
  // count. Default 1 = single-sample (pre-bridge behavior).
  private _sampleCount: number = 1;

  /**
   * Update OIT render targets to match viewport size.
   *
   * @param device GPU device
   * @param width  Viewport width in pixels
   * @param height Viewport height in pixels
   * @param sampleCount Scene FB MSAA sample count (defaults to 1).
   *   The composite pipeline writes into `_sceneColorView` which is
   *   the MSAA target when the scene FB is MSAA; the pipeline must
   *   match that sample count or attachment validation fails.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    sampleCount: number = 1,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._sampleCount !== sampleCount;

    if (!needsRecreate) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._sampleCount = sampleCount;
    this._supported = true;

    this._destroyTargets();

    // Accumulation texture: rgba16float for high precision
    this._accumulationTexture = device.createTexture({
      label: "OIT-Accumulation",
      size: { width, height },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._accumulationView = this._accumulationTexture.createView();

    // Revealage texture: r8unorm is sufficient (single channel)
    this._revealageTexture = device.createTexture({
      label: "OIT-Revealage",
      size: { width, height },
      format: "r8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._revealageView = this._revealageTexture.createView();

    // Create composite pipeline for the current scene-color format. The actual
    // target format is authoritative at draw time (`executeComposite` rebuilds
    // on mismatch — e.g. HDR toggle), but seed it from the known scene color.
    this._createCompositePipeline(device, this._sceneColorFormat);
  }

  /**
   * Execute the OIT composite pass: blend accumulated transparency over the opaque scene.
   * @param encoder Command encoder
   * @param targetView The opaque scene color texture view to composite onto
   * @param targetFormat The format of the target texture
   */
  executeComposite(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetFormat: GPUTextureFormat,
  ): void {
    if (!this._accumulationView || !this._revealageView) {
      return;
    }

    // Ensure the composite pipeline's color-target format matches the actual
    // attachment we're about to write into. The scene color is bgra8unorm by
    // default and rgba16float in HDR; the pipeline must match or the render
    // pass fails WebGPU's pipeline-vs-attachment format validation. Pre-fix the
    // pipeline was pinned to rgba8unorm and `targetFormat` was ignored, so this
    // (the entire MRT-OIT composite) failed validation every frame.
    if (
      this._device &&
      (!this._compositePipeline || this._compositeFormat !== targetFormat)
    ) {
      this._createCompositePipeline(this._device, targetFormat);
    }
    if (!this._compositePipeline) {
      return;
    }

    this._updateCompositeBindGroup();
    if (!this._compositeBindGroup) return;

    const passDesc: GPURenderPassDescriptor = {
      label: "OIT-Composite-Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load" as GPULoadOp, // Preserve opaque content
          storeOp: "store" as GPUStoreOp,
        },
      ],
    };

    const pass = encoder.beginRenderPass(
      this._timestampProvider?.withRenderPassTimestamps(passDesc) ?? passDesc,
    );
    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compositeBindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }

  private _createCompositePipeline(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ): void {
    this._compositeFormat = targetFormat;
    const shaderModule = device.createShaderModule({
      label: "OIT-Composite-Shader",
      code: OIT_COMPOSITE_WGSL,
    });

    this._compositeBindGroupLayout = makeBindGroupLayout(
      device,
      "OIT-Composite-BindGroupLayout",
      [
        texture(0, Stage.FRAGMENT),
        texture(1, Stage.FRAGMENT),
        sampler(2, Stage.FRAGMENT),
      ],
    );

    this._compositeSampler = device.createSampler({
      label: "OIT-Composite-Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "OIT-Composite-PipelineLayout",
      bindGroupLayouts: [this._compositeBindGroupLayout],
    });

    this._compositePipeline = device.createRenderPipeline({
      label: "OIT-Composite-Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: targetFormat, // matches the scene-color attachment
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      // Session 65 Batch 33 — match scene FB sample count so MSAA
      // composite output validates against the MSAA scene color
      // attachment. Composite source textures (accumulation, revealage)
      // remain single-sample — the multisample state only affects the
      // pipeline's render-target compatibility.
      multisample:
        this._sampleCount > 1 ? { count: this._sampleCount } : undefined,
    });
  }

  private _updateCompositeBindGroup(): void {
    if (
      !this._device ||
      !this._compositeBindGroupLayout ||
      !this._compositeSampler ||
      !this._accumulationView ||
      !this._revealageView
    ) {
      return;
    }

    this._compositeBindGroup = this._device.createBindGroup({
      label: "OIT-Composite-BindGroup",
      layout: this._compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: this._accumulationView },
        { binding: 1, resource: this._revealageView },
        { binding: 2, resource: this._compositeSampler },
      ],
    });
  }

  private _destroyTargets(): void {
    this._accumulationTexture?.destroy();
    this._revealageTexture?.destroy();
    this._accumulationTexture = null;
    this._revealageTexture = null;
    this._accumulationView = null;
    this._revealageView = null;
    this._compositeBindGroup = null;
  }

  // ─── OIT Pipeline Variant Factory ───

  // Cache of OIT shader modules: hash(baseCode) → GPUShaderModule
  private _oitShaderCache = new Map<string, GPUShaderModule>();
  // Cache of OIT pipelines: hash(basePipeline+layout) → GPURenderPipeline
  private _oitPipelineCache = new Map<string, GPURenderPipeline>();

  /**
   * The MRT blend states for OIT accumulation targets.
   * Target 0 (accumulation rgba16float): additive blend
   * Target 1 (revealage r8unorm): zero-src multiplicative
   */
  static readonly OIT_TARGETS: GPUColorTargetState[] = [
    {
      format: "rgba16float" as GPUTextureFormat,
      blend: {
        color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      },
    },
    {
      format: "r8unorm" as GPUTextureFormat,
      blend: {
        color: {
          srcFactor: "zero",
          dstFactor: "one-minus-src" as GPUBlendFactor,
          operation: "add",
        },
        alpha: {
          srcFactor: "zero",
          dstFactor: "one-minus-src" as GPUBlendFactor,
          operation: "add",
        },
      },
    },
  ];

  /**
   * Inject OIT output into a WGSL fragment shader.
   * Transforms single-target fragment output into dual MRT output
   * with weighted blended OIT accumulation.
   *
   * The injection:
   * 1. Adds OITFragOutput struct with @location(0) and @location(1)
   * 2. Adds csm_alphaWeight function
   * 3. Replaces the fragment return type and wraps the output
   *
   * @param baseWGSL The original WGSL shader code
   * @param fragmentEntryPoint The fragment entry point name (default: "fragmentMain")
   * @returns Modified WGSL with OIT output
   */
  static injectOITOutput(
    baseWGSL: string,
    fragmentEntryPoint: string = "fragmentMain",
  ): string {
    // OIT helper code to prepend
    const oitHelpers = `
// ─── OIT Weighted Blended Output ───
struct OITFragOutput {
  @location(0) accumulation: vec4<f32>,
  @location(1) revealage: vec4<f32>,
}

fn csm_oitWeight(a: f32, z: f32) -> f32 {
  return clamp(a * max(1e-2, min(3e3, 10.0 / (1e-5 + pow(z / 5.0, 2.0) + pow(z / 200.0, 6.0)))), 1e-2, 3e2);
}

fn csm_oitOutput(color: vec4<f32>, clipZ: f32) -> OITFragOutput {
  let alpha = color.a;
  let weight = csm_oitWeight(alpha, clipZ);
  var out: OITFragOutput;
  out.accumulation = vec4<f32>(color.rgb * alpha * weight, alpha * weight);
  out.revealage = vec4<f32>(alpha, 0.0, 0.0, 0.0);
  return out;
}
`;

    // ── C11-157 Slice A — struct-typed fragment return support (ADD-ONLY) ──
    // The single-`@location(0)` path below is preserved VERBATIM; Gaussian
    // splats + FLAT primitive shaders depend on its exact output (a spec
    // asserts byte-identity). LIT / MRT-G-buffer primitive fragment shaders
    // instead return a NAMED STRUCT (e.g. `-> FragOutput` with `@location(0)
    // color` + `@location(1) normalRoughness`). The text-surgery below can't
    // strip a `@location(0)` that lives on the STRUCT DEFINITION rather than
    // the function signature, and after renaming the entry to a non-entry
    // function that struct's `@location`/`@builtin` attributes would be
    // orphaned (WGSL rejects IO attributes outside entry-point I/O). Struct
    // returns therefore route through a dedicated branch that renames the
    // entry, strips the struct's IO attributes, and wraps with
    // `csm_oitOutput(base.<colorField>, in.<posField>.z)`.
    const structInfo = WebGPUOIT._analyzeStructFragmentReturn(
      baseWGSL,
      fragmentEntryPoint,
    );
    if (structInfo) {
      return WebGPUOIT._injectOITStructReturn(
        baseWGSL,
        fragmentEntryPoint,
        structInfo,
        oitHelpers,
      );
    }

    // Strategy: rename the original fragment entry point, then create a wrapper
    // that calls it and transforms the output.
    const entryRegex = new RegExp(
      `(@fragment\\s*\\n\\s*fn\\s+)(${fragmentEntryPoint})(\\s*\\()`,
    );

    if (!entryRegex.test(baseWGSL)) {
      // Try a more lenient match
      const lenientRegex = new RegExp(
        `(@fragment[\\s\\S]*?fn\\s+)(${fragmentEntryPoint})(\\s*\\()`,
      );
      if (!lenientRegex.test(baseWGSL)) {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[OIT] Could not find fragment entry '${fragmentEntryPoint}' for OIT injection`,
        );
        //>>includeEnd('debug');
        return baseWGSL;
      }
    }

    // Rename original entry point and change return type annotation
    let modified = baseWGSL.replace(
      new RegExp(`@fragment([\\s\\S]*?)fn\\s+${fragmentEntryPoint}`),
      `fn _oit_base_${fragmentEntryPoint}`,
    );

    // Remove @location(0) from the renamed function's return type
    modified = modified.replace(
      /fn _oit_base_\w+\([^)]*\)\s*->\s*@location\(0\)\s*/,
      (match) => match.replace(/@location\(0\)\s*/, ""),
    );

    // Find the input parameter type from the original function signature
    const paramMatch = modified.match(
      new RegExp(`fn _oit_base_${fragmentEntryPoint}\\(([^)]+)\\)`),
    );
    const paramDecl = paramMatch ? paramMatch[1].trim() : "input: VertexOutput";
    const paramName = paramDecl.split(":")[0].trim();
    const paramType = paramDecl.split(":").slice(1).join(":").trim();

    // Create OIT wrapper function
    const oitWrapper = `
@fragment
fn ${fragmentEntryPoint}(${paramName}: ${paramType}) -> OITFragOutput {
  let _oitBaseColor = _oit_base_${fragmentEntryPoint}(${paramName});
  return csm_oitOutput(_oitBaseColor, ${paramName}.position.z);
}
`;

    return oitHelpers + modified + oitWrapper;
  }

  /**
   * Analyze a fragment shader whose entry point returns a NAMED STRUCT type
   * (the LIT / MRT-G-buffer primitive shape, `-> FragOutput`). Returns null for
   * the single-`@location(0)` shape (so the caller keeps the verbatim legacy
   * path) or when the shader can't be parsed (graceful fall-through). On
   * success returns the struct name, the `@location(0)` color member name, and
   * the fragment input parameter name/type plus its `@builtin(position)` member
   * name (the clip/frag position the OIT weight function samples).
   * @private
   */
  private static _analyzeStructFragmentReturn(
    baseWGSL: string,
    fragmentEntryPoint: string,
  ): {
    structName: string;
    colorField: string;
    paramName: string;
    paramType: string;
    posField: string;
  } | null {
    // Entry signature: `@fragment fn <entry>(<params>) -> <ret> {`.
    const sigRe = new RegExp(
      `@fragment\\s+fn\\s+${fragmentEntryPoint}\\s*\\(([^)]*)\\)\\s*->\\s*([A-Za-z_]\\w*|@[\\s\\S]*?)\\s*\\{`,
    );
    const sig = baseWGSL.match(sigRe);
    if (!sig) {
      return null;
    }
    const paramDecl = sig[1].trim();
    const returnType = sig[2].trim();
    // A `@location(0) vec4<f32>` (or any `@`-prefixed) return is the single-
    // target shape → NOT a struct; let the byte-identical legacy path handle it.
    if (returnType.startsWith("@") || !/^[A-Za-z_]\w*$/.test(returnType)) {
      return null;
    }
    const structName = returnType;
    const structBody = WebGPUOIT._extractStructBody(baseWGSL, structName);
    if (!structBody) {
      return null;
    }
    const colorMatch = structBody.match(/@location\(0\)\s+([A-Za-z_]\w*)\s*:/);
    if (!colorMatch) {
      return null;
    }
    const colorField = colorMatch[1];
    const paramName = paramDecl.split(":")[0].trim();
    const paramType = paramDecl.split(":").slice(1).join(":").trim();
    // The `@builtin(position)` member of the input struct is the framebuffer
    // position; its `.z` (NDC depth) feeds csm_oitWeight. Field name varies
    // (`position` on flat shaders, `clipPosition` on lit) — resolve it.
    let posField = "position";
    const inputBody = WebGPUOIT._extractStructBody(baseWGSL, paramType);
    if (inputBody) {
      const posMatch = inputBody.match(
        /@builtin\(position\)\s+([A-Za-z_]\w*)\s*:/,
      );
      if (posMatch) {
        posField = posMatch[1];
      }
    }
    return { structName, colorField, paramName, paramType, posField };
  }

  /**
   * Extract the `{ ... }` body text of `struct <name>`, or null if not found.
   * WGSL struct member declarations contain no nested `{}` (composite types use
   * `<>` / `[]`), so scanning to the first `}` after the opening `{` is exact.
   * @private
   */
  private static _extractStructBody(
    wgsl: string,
    structName: string,
  ): string | null {
    const decl = new RegExp(`struct\\s+${structName}\\b`).exec(wgsl);
    if (!decl) {
      return null;
    }
    const open = wgsl.indexOf("{", decl.index);
    if (open < 0) {
      return null;
    }
    const close = wgsl.indexOf("}", open);
    if (close < 0) {
      return null;
    }
    return wgsl.slice(open + 1, close);
  }

  /**
   * Remove `@location(n)` and `@builtin(...)` attributes from the members of
   * `struct <structName>`. Required so the renamed non-entry `_oit_base_*`
   * function can return the (formerly entry-point) output struct without WGSL
   * rejecting its now-orphaned I/O attributes.
   * @private
   */
  private static _stripStructIOAttributes(
    wgsl: string,
    structName: string,
  ): string {
    const decl = new RegExp(`struct\\s+${structName}\\b`).exec(wgsl);
    if (!decl) {
      return wgsl;
    }
    const open = wgsl.indexOf("{", decl.index);
    if (open < 0) {
      return wgsl;
    }
    const close = wgsl.indexOf("}", open);
    if (close < 0) {
      return wgsl;
    }
    const body = wgsl.slice(open + 1, close);
    const strippedBody = body
      .replace(/@location\([^)]*\)\s*/g, "")
      .replace(/@builtin\([^)]*\)\s*/g, "");
    return wgsl.slice(0, open + 1) + strippedBody + wgsl.slice(close);
  }

  /**
   * Transform a struct-returning fragment shader into an OIT MRT variant
   * (weighted-blended dual output). Add-only companion to `injectOITOutput` —
   * never invoked for the single-`@location(0)` shape. Strategy: (1) rename the
   * entry to a non-entry `_oit_base_*` keeping its `-> <struct>` return, (2)
   * strip the struct's I/O attributes, (3) append an OIT wrapper entry that
   * calls the base and re-emits `csm_oitOutput(base.<colorField>, in.pos.z)`.
   * @private
   */
  private static _injectOITStructReturn(
    baseWGSL: string,
    fragmentEntryPoint: string,
    info: {
      structName: string;
      colorField: string;
      paramName: string;
      paramType: string;
      posField: string;
    },
    oitHelpers: string,
  ): string {
    let modified = baseWGSL.replace(
      new RegExp(`@fragment([\\s\\S]*?)fn\\s+${fragmentEntryPoint}`),
      `fn _oit_base_${fragmentEntryPoint}`,
    );
    modified = WebGPUOIT._stripStructIOAttributes(modified, info.structName);
    const oitWrapper = `
@fragment
fn ${fragmentEntryPoint}(${info.paramName}: ${info.paramType}) -> OITFragOutput {
  let _oitBase = _oit_base_${fragmentEntryPoint}(${info.paramName});
  return csm_oitOutput(_oitBase.${info.colorField}, ${info.paramName}.${info.posField}.z);
}
`;
    return oitHelpers + modified + oitWrapper;
  }

  /**
   * Create an OIT pipeline variant from a command's pipeline configuration.
   * The resulting pipeline renders to 2 MRT targets (accumulation + revealage).
   *
   * @param device GPU device
   * @param shaderCode Original WGSL shader code
   * @param config Pipeline configuration from the base command
   * @returns The OIT pipeline, or null if creation fails
   */
  createOITPipeline(
    device: GPUDevice,
    shaderCode: string,
    config: {
      label?: string;
      layout: GPUPipelineLayout | "auto";
      vertexBuffers?: GPUVertexBufferLayout[];
      vertexEntryPoint?: string;
      fragmentEntryPoint?: string;
      primitive?: GPUPrimitiveState;
      depthStencil?: GPUDepthStencilState;
      multisample?: GPUMultisampleState;
    },
  ): GPURenderPipeline | null {
    const fragEntry = config.fragmentEntryPoint ?? "fragmentMain";
    const vertEntry = config.vertexEntryPoint ?? "vertexMain";

    // Check cache
    const cacheKey = `${shaderCode.length}_${fragEntry}_${config.label ?? ""}`;
    const cached = this._oitPipelineCache.get(cacheKey);
    if (cached) return cached;

    try {
      const oitCode = WebGPUOIT.injectOITOutput(shaderCode, fragEntry);

      // Check shader module cache
      let shaderModule = this._oitShaderCache.get(cacheKey);
      if (!shaderModule) {
        shaderModule = device.createShaderModule({
          label: `OIT-${config.label ?? "unknown"}`,
          code: oitCode,
        });
        this._oitShaderCache.set(cacheKey, shaderModule);
      }

      const depthStencil = config.depthStencil
        ? {
            ...config.depthStencil,
            depthWriteEnabled: false, // OIT never writes depth
          }
        : undefined;

      const pipeline = device.createRenderPipeline({
        label: `OIT-Pipeline-${config.label ?? "unknown"}`,
        layout: config.layout,
        vertex: {
          module: shaderModule,
          entryPoint: vertEntry,
          buffers: config.vertexBuffers ?? [],
        },
        fragment: {
          module: shaderModule,
          entryPoint: fragEntry,
          targets: WebGPUOIT.OIT_TARGETS,
        },
        primitive: config.primitive ?? { topology: "triangle-list" },
        depthStencil,
        multisample: config.multisample,
      });

      this._oitPipelineCache.set(cacheKey, pipeline);
      return pipeline;
    } catch (e) {
      // Pipeline creation failure — must always reach the console as a real
      // error per CLAUDE.md (shader compile / pipeline creation failures are
      // never pragma-stripped). Promoted from console.warn so the
      // debug-pragma lint leaves it permanent.
      console.error(`[OIT] Failed to create OIT pipeline variant:`, e);
      return null;
    }
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTargets();
    this._oitShaderCache.clear();
    this._oitPipelineCache.clear();
    this._compositePipeline = null;
    this._compositeBindGroupLayout = null;
    this._compositeSampler = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
