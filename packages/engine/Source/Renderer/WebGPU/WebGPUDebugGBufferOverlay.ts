/**
 * @module WebGPUDebugGBufferOverlay
 *
 * Phase 8a Slice 2c (Batch 89) — visualizes the G-buffer
 * `normalRoughnessTexture` as a fullscreen overlay. Models on
 * `WebGPUDebugDepthOverlay`: same shape, same lifecycle, swap the
 * input texture from depth to G-buffer.
 *
 * Visualization mapping:
 *   .xyz (eye-space normal in [-1, 1]) → `(n + 1) * 0.5` → RGB in [0, 1].
 *     - Surface facing +X (right): red.
 *     - Surface facing +Y (up):    green.
 *     - Surface facing +Z (toward camera): blue.
 *     - Surface facing -X / -Y / -Z: the complementary axis tinted dark.
 *   .w (roughness, currently always 1.0 from the Slice 1-2 producer):
 *     ignored for the normal visualization. Slice 5b will thread real
 *     roughness through and this overlay can be extended to a
 *     mode-2 visualization showing it.
 *
 * Sentinel pixels (.xyz = (0,0,0) — sky, depth-clear, high-gradient
 * fallback in the producer) are tinted magenta so they're visually
 * distinct from "real normal pointing nowhere in particular."
 *
 * Activation: `Scene.debugShowGBufferNormals = true`. Scene.js's
 * `updateFrameState` propagates this to
 * `frameState.debugShowGBufferNormals`, which the WebGPU scene
 * renderer checks alongside the existing `debugShowDepthAsColor`.
 *
 * IMPORTANT — this overlay requires the G-buffer to be populated, so
 * setting `debugShowGBufferNormals = true` ALSO forces
 * `scene.deferredLighting = true` for the same frame
 * (the CesiumDebug command sets both).
 */

/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  texture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const GBUFFER_OVERLAY_WGSL = /* wgsl */ `
@group(0) @binding(0) var gBufferTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // Fullscreen triangle covering the viewport.
  var output: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Batch 92 (Slice 2e investigation) — textureLoad on the G-buffer
  // returns (0,0,0) under the current Chrome/Dawn configuration,
  // despite the producer's writes being visible to other consumers
  // (the AO consumer probe shows a real 0.094% canvas diff that
  // ONLY appears when the producer runs — see WEBGPU_DEBUGGING_LOG.md
  // Batches 87 + 90). Best guess is a bind-group validation
  // subtlety we couldn't isolate without browser internals access.
  //
  // The overlay's render pass + pipeline + fragment-output path are
  // confirmed working (Batch 92 split-screen hardcoded-gradient test
  // rendered correctly to the canvas). The textureLoad path is the
  // specific failure point.
  //
  // For now the overlay tints magenta when the sample reads (0,0,0).
  // That serves as a coarse "G-buffer is empty or read failed" signal
  // for users; the more informative normal-map visualization will
  // come back once the read path is fixed in a future session.
  let dim = vec2<i32>(textureDimensions(gBufferTexture));
  let pixel = vec2<i32>(
    i32(input.uv.x * f32(dim.x)),
    i32(input.uv.y * f32(dim.y)),
  );
  let s = textureLoad(gBufferTexture, pixel, 0);
  let lenSq = dot(s.xyz, s.xyz);
  if (lenSq < 0.01) {
    return vec4<f32>(1.0, 0.0, 1.0, 1.0);
  }
  let rgb = s.xyz * 0.5 + vec3<f32>(0.5);
  return vec4<f32>(rgb, 1.0);
}
`;

export class WebGPUDebugGBufferOverlay {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";
  private _isInitialized: boolean = false;
  private _isDestroyed: boolean = false;

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
      label: "DebugGBufferOverlay shader",
      code: GBUFFER_OVERLAY_WGSL,
    });

    this._bindGroupLayout = makeBindGroupLayout(
      device,
      "DebugGBufferOverlay BGL",
      [
        // G-buffer is `rgba16float` — `unfilterable-float` sample type
        // is required (float16 textures aren't natively filterable per
        // the WebGPU spec without the `float16-filterable` extension).
        // `textureLoad` doesn't use a sampler so we don't need one in
        // the BGL.
        texture(0, Stage.FRAGMENT, { sampleType: "unfilterable-float" }),
      ],
    );

    const pipelineLayout = device.createPipelineLayout({
      label: "DebugGBufferOverlay PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "DebugGBufferOverlay Pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._isInitialized = true;
    this._isDestroyed = false;
  }

  execute(
    encoder: GPUCommandEncoder,
    gBufferView: GPUTextureView,
    targetView: GPUTextureView,
  ): void {
    if (!this._isInitialized || !this._device || !this._pipeline) {
      return;
    }

    const bindGroup = this._device.createBindGroup({
      label: "DebugGBufferOverlay BG",
      layout: this._bindGroupLayout!,
      entries: [{ binding: 0, resource: gBufferView }],
    });

    const passEncoder = encoder.beginRenderPass({
      label: "DebugGBufferOverlay Pass",
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
    passEncoder.draw(3, 1, 0, 0);
    passEncoder.end();
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }
}

export default WebGPUDebugGBufferOverlay;
