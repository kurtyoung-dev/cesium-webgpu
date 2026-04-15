/**
 * @module WebGPUDebugDepthOverlay
 *
 * Tier 2 debug pass — visualizes the scene depth attachment as a grayscale
 * fullscreen overlay. Used for z-fighting diagnostics, depth-precision
 * analysis at the horizon (stars vs terrain), and verifying that
 * 3D Tiles vs terrain depth values are sane.
 *
 * Standalone from `WebGPUPostProcessPipeline` because depth textures need
 * `sampleType: "depth"` (or `"unfilterable-float"`) bind group layouts,
 * which the production post-process pipeline doesn't carry. Keeping this
 * separate avoids polluting the production pipeline class with debug-only
 * bind group variants.
 *
 * Activation: `Scene.debugShowDepthAsColor = true`. The scene render path
 * checks `frameState.debugShowDepthAsColor` after the main scene pass and
 * invokes `execute()` instead of the normal post-process chain.
 *
 * Linearization: raw NDC depth in [0,1] is non-linear (most precision near
 * the camera). The shader linearizes via the standard
 *   linearZ = (near * far) / (far - depth * (far - near))
 * conversion.
 *
 * CRITICAL — we use LOG-SCALE normalization, not linear. Cesium's planetary
 * camera runs with near ~1m and far ~1e10m (ten decades). A pixel at a
 * terrain feature 10 km out, linear-normalized over [1, 1e10], comes back
 * as 1e-6 — indistinguishable from zero on an 8-bit grayscale display. The
 * result is a pure-black image with white "nothing drawn here" patches, no
 * useful mid-tones. log2-normalizing the same range gives the 10 km pixel
 * a value of 13/33 ≈ 0.4, a 100 km pixel 0.5, a 1000 km pixel 0.6 — visible,
 * distinguishable grey tones across the scale you actually care about.
 *
 * Raw NDC depth is also available in mode 1, but because Cesium's planetary
 * depth values sit in [0.9999, 1.0] we apply a pow() stretch so the tail is
 * actually visible instead of saturating to white.
 */

/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const DEPTH_OVERLAY_WGSL = /* wgsl */ `
struct Uniforms {
  // x = near, y = far, z = mode (0 = linearized red, 1 = raw green, 2 = both),
  // w = unused
  params: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // Fullscreen triangle covering the viewport (no vertex buffer needed).
  // Vertex 0: (-1,-1), Vertex 1: (3,-1), Vertex 2: (-1,3)
  var output: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  // Flip Y because WebGPU's screen origin is top-left and we want UV (0,0)
  // at the top of the viewport.
  output.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return output;
}

fn linearizeDepth(rawDepth: f32, near: f32, far: f32) -> f32 {
  // Standard reverse of the perspective projection's z mapping.
  // Returns world-space distance from near plane.
  let denom = far - rawDepth * (far - near);
  return (near * far) / max(denom, 1e-6);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // textureSampleLevel on a depth texture returns f32 directly.
  // NOTE: depth textures require the level parameter to be i32 / u32 —
  // abstract-float 0.0 is rejected by naga with a "no matching call"
  // error. Use 0i explicitly.
  let raw = textureSampleLevel(depthTexture, depthSampler, input.uv, 0i);
  let near = u.params.x;
  let far = u.params.y;
  let mode = u.params.z;

  // Pixels at exactly 1.0 (or within floating-point epsilon of it) were
  // never drawn this frame — tint them magenta so they're visually
  // distinct from "drawn but far". If you see large magenta regions,
  // that's content that lives in a different frustum than the one whose
  // depth ended up in the buffer (see WebGPUSceneRenderer's debug bypass
  // of the inter-frustum clear).
  if (raw >= 0.99999) {
    return vec4<f32>(0.5, 0.0, 0.5, 1.0);
  }

  let linear = linearizeDepth(raw, near, far);

  // ── Log-scale normalization ──
  // Cesium's planetary camera runs near ≈ 1m, far ≈ 1e10m (ten decades).
  // Linear normalization collapses every rendered pixel to near-zero
  // grayscale. log2 spreads the useful range: a 10 km feature lands at
  // ~0.4, 100 km at ~0.5, 1000 km at ~0.6 — visible, distinguishable
  // bands across the altitudes you actually care about.
  let logNear = log2(max(near, 1.0));
  let logFar = log2(max(far, max(near, 1.0) * 2.0));
  let logLinear = log2(max(linear, 1.0));
  let linearNorm = clamp(
    (logLinear - logNear) / max(logFar - logNear, 1e-6),
    0.0,
    1.0,
  );

  // Stretched raw depth. Raw NDC depth for a planetary scene sits in
  // [0.999, 1.0), so displaying it directly saturates to white. (1-raw)
  // puts it in [0, 1e-3]; pow(., 0.15) stretches the tail across the
  // full visible range so precision tiers near the far plane become
  // readable.
  let rawStretch = pow(clamp(1.0 - raw, 0.0, 1.0), 0.15);

  // Mode selector:
  //   0 = log-linearized grayscale (default, most useful)
  //   1 = stretched-raw grayscale (for precision-tier diagnosis)
  //   2 = combined (R = log-linear, G = stretched-raw)
  if (mode > 1.5) {
    return vec4<f32>(linearNorm, rawStretch, 0.0, 1.0);
  } else if (mode > 0.5) {
    return vec4<f32>(rawStretch, rawStretch, rawStretch, 1.0);
  }
  return vec4<f32>(linearNorm, linearNorm, linearNorm, 1.0);
}
`;

/**
 * Standalone debug pass that draws a fullscreen depth visualization
 * over the scene framebuffer. Self-contained: owns its shader module,
 * pipeline, bind group layout, sampler, and uniform buffer.
 */
export class WebGPUDebugDepthOverlay {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _sampler: GPUSampler | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  private _uniformData: Float32Array = new Float32Array(4);
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";
  private _isInitialized: boolean = false;
  private _isDestroyed: boolean = false;

  /**
   * Lazy initialization. Safe to call multiple times — re-initializes only
   * if the device or canvas format changes.
   */
  initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (
      this._isInitialized &&
      this._device === device &&
      this._canvasFormat === canvasFormat
    ) {
      return;
    }
    this._device = device;
    this._canvasFormat = canvasFormat;

    const shaderModule = device.createShaderModule({
      label: "DebugDepthOverlay shader",
      code: DEPTH_OVERLAY_WGSL,
    });

    // Depth textures require sampleType: "depth" — they are NOT
    // compatible with the "float" sampleType used by the production
    // post-process pipeline. The "non-filtering" sampler type pairs with
    // "depth" sample type; "filtering" causes a validation error.
    this._bindGroupLayout = makeBindGroupLayout(
      device,
      "DebugDepthOverlay BGL",
      [
        texture(0, Stage.FRAGMENT, { sampleType: "depth" }),
        sampler(1, Stage.FRAGMENT, "non-filtering"),
        uniformBuffer(2, Stage.FRAGMENT),
      ],
    );

    const pipelineLayout = device.createPipelineLayout({
      label: "DebugDepthOverlay PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "DebugDepthOverlay Pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._sampler = device.createSampler({
      label: "DebugDepthOverlay Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this._uniformBuffer = device.createBuffer({
      label: "DebugDepthOverlay UB",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._isInitialized = true;
    this._isDestroyed = false;
  }

  /**
   * Draws a fullscreen depth visualization to `targetView`, sampling from
   * `depthView`. Caller is responsible for ending any in-progress render
   * pass on the encoder before invoking this; we begin and end our own.
   *
   * @param near - Camera near plane distance (used for linearization)
   * @param far - Camera far plane distance
   * @param mode - 0 linearized, 1 raw NDC, 2 combined R=linear G=raw
   */
  execute(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView,
    targetView: GPUTextureView,
    near: number,
    far: number,
    mode: number = 0,
  ): void {
    if (!this._isInitialized || !this._device || !this._pipeline) {
      return;
    }

    this._uniformData[0] = near;
    this._uniformData[1] = far;
    this._uniformData[2] = mode;
    this._uniformData[3] = 0;
    this._device.queue.writeBuffer(this._uniformBuffer!, 0, this._uniformData);

    const bindGroup = this._device.createBindGroup({
      label: "DebugDepthOverlay BG",
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._sampler! },
        { binding: 2, resource: { buffer: this._uniformBuffer! } },
      ],
    });

    const passEncoder = encoder.beginRenderPass({
      label: "DebugDepthOverlay Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    passEncoder.setPipeline(this._pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    // Single fullscreen triangle, 3 vertices, no vertex buffer.
    passEncoder.draw(3, 1, 0, 0);
    passEncoder.end();
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._uniformBuffer?.destroy();
    this._uniformBuffer = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._sampler = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }
}

export default WebGPUDebugDepthOverlay;
