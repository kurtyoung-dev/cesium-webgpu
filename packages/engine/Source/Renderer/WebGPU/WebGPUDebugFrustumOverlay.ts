/**
 * @module WebGPUDebugFrustumOverlay
 *
 * Tier 2 debug pass — tints the scene framebuffer based on per-pixel
 * depth membership, implementing the WebGPU equivalents of
 * `scene.debugShowFrustums` and `scene.debugShowCommands`.
 *
 * Why a post-process overlay instead of DebugInspector-style per-command
 * uniform injection (the WebGL path):
 *
 * - WebGL's `DebugInspector.js` clones each command's shader program and
 *   injects a `uniform vec3 debugShowFrustumsColor` that multiplies
 *   `out_FragColor.rgb`. This works because WebGL draws are stateful and
 *   a single uniform can be set immediately before the draw call.
 * - WebGPU shaders are compiled ahead of time into pipeline objects and
 *   every pipeline owns its own bind group layout. Cloning every terrain
 *   / 3D-Tiles / point-cloud / model pipeline with a debug variant — and
 *   threading a per-command tint through the draw loop — would require
 *   touching every shader in the engine. That's a huge surface.
 * - A fullscreen post-process overlay that reads the sampled depth buffer
 *   gets almost-identical visual results in one file: each pixel's depth
 *   linearizes to a view-space Z, we look up which frustum split contains
 *   that Z, and tint the pre-composited scene color accordingly.
 *
 * Two modes:
 *
 *   mode 0 — **Frustums**: tints by frustum membership (R=0, G=1, B=2,
 *            matching DebugInspector's bitmask layout). Great for
 *            diagnosing multi-frustum depth clears and precision banding.
 *
 *   mode 1 — **Commands**: approximates WebGL's random-per-command tint
 *            by quantizing linearized depth into 8 buckets and mapping
 *            each bucket to a distinct RGB palette entry. Not *literally*
 *            per-command, but shows "where different depth clusters
 *            rendered" which is the same diagnostic goal.
 *
 * Both modes preserve scene color by multiplying (debug color × scene
 * color) instead of overwriting, so users can still see the scene
 * structure with the tint applied — matching WebGL's `rgb *= tint`
 * behavior.
 */

/// <reference types="@webgpu/types" />

const MAX_FRUSTUMS = 4;

const FRUSTUM_OVERLAY_WGSL = /* wgsl */ `
struct Uniforms {
  // x = global near, y = global far, z = mode (0 = frustums, 1 = commands),
  // w = numFrustums (as float)
  params: vec4<f32>,
  // Up to MAX_FRUSTUMS (near, far, 0, 0) vec4s. Frustum i spans
  // frustumRanges[i].x .. frustumRanges[i].y in view-space Z.
  frustumRanges: array<vec4<f32>, 4>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var depthTexture: texture_depth_2d;
@group(0) @binding(3) var depthSampler: sampler;
@group(0) @binding(4) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // Fullscreen triangle (see WebGPUDebugDepthOverlay for derivation).
  var output: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return output;
}

fn linearizeDepth(rawDepth: f32, near: f32, far: f32) -> f32 {
  // Standard inverse of the perspective depth mapping.
  let denom = far - rawDepth * (far - near);
  return (near * far) / max(denom, 1e-6);
}

// DebugInspector's bit-masked RGB: bit 0 -> R, bit 1 -> G, bit 2 -> B,
// matching the WebGL visualization exactly.
fn frustumColor(index: i32) -> vec3<f32> {
  let bit0 = f32((index + 1) & 1);
  let bit1 = f32(((index + 1) >> 1) & 1);
  let bit2 = f32(((index + 1) >> 2) & 1);
  return vec3<f32>(bit0, bit1, bit2);
}

// 8-color palette for the commands mode — visually distinct and roughly
// matches the "random tint per command" vibe of the WebGL debug inspector
// without needing a shader-side RNG.
fn commandPaletteColor(bucket: i32) -> vec3<f32> {
  let b = bucket % 8;
  if (b == 0) { return vec3<f32>(1.0, 0.25, 0.25); } // red
  if (b == 1) { return vec3<f32>(0.25, 1.0, 0.25); } // green
  if (b == 2) { return vec3<f32>(0.25, 0.5, 1.0); }  // blue
  if (b == 3) { return vec3<f32>(1.0, 1.0, 0.25); }  // yellow
  if (b == 4) { return vec3<f32>(1.0, 0.5, 1.0); }   // magenta
  if (b == 5) { return vec3<f32>(0.25, 1.0, 1.0); }  // cyan
  if (b == 6) { return vec3<f32>(1.0, 0.6, 0.25); }  // orange
  return vec3<f32>(0.75, 0.75, 0.75);                // gray
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Scene color is texture_2d<f32> so its level must be f32.
  // Depth is texture_depth_2d and its level must be i32 / u32 — WGSL
  // rejects abstract-float 0.0 with "no matching call".
  let sceneColor = textureSampleLevel(sceneTexture, sceneSampler, input.uv, 0.0);
  let raw = textureSampleLevel(depthTexture, depthSampler, input.uv, 0i);

  // Pixels at the far plane are the background (skybox / empty clear).
  // Pass the scene color through untouched so the tint only applies to
  // actually-drawn geometry — matches the WebGL DebugInspector path
  // which only runs on command output, not cleared background.
  if (raw >= 0.9999) {
    return sceneColor;
  }

  let globalNear = u.params.x;
  let globalFar = u.params.y;
  let mode = u.params.z;
  let numFrustums = i32(u.params.w);

  let linear = linearizeDepth(raw, globalNear, globalFar);

  var tint = vec3<f32>(1.0);

  if (mode < 0.5) {
    // ── Frustums mode ──
    // Walk the frustum ranges and tint by which slot this pixel lands in.
    // If no range matches (shouldn't happen — frustums are a strict
    // partition), fall back to white.
    var matched = false;
    for (var i = 0; i < 4; i = i + 1) {
      if (i >= numFrustums) { break; }
      let range = u.frustumRanges[i];
      if (linear >= range.x && linear <= range.y) {
        tint = frustumColor(i);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Pixel depth is outside *every* declared frustum range. That
      // indicates a stale depth value or a clear-op mismatch — flag it
      // in bright white so it's visually obvious.
      tint = vec3<f32>(1.0);
    }
  } else {
    // ── Commands mode ──
    // Bucket by linearized depth. 8 buckets across the global near/far
    // range yields visually distinct bands even on a mostly-planar
    // surface. This is a depth-based *approximation* of per-command
    // tinting — see the file header for the rationale.
    let norm = clamp(
      (linear - globalNear) / max(globalFar - globalNear, 1e-6),
      0.0,
      1.0,
    );
    let bucket = i32(norm * 8.0);
    tint = commandPaletteColor(bucket);
  }

  // Multiply tint into the scene color (matches WebGL "rgb *= tint").
  // Keep scene alpha so downstream blend / canvas composition is untouched.
  return vec4<f32>(sceneColor.rgb * tint, sceneColor.a);
}
`;

/**
 * Standalone debug overlay for `debugShowFrustums` and `debugShowCommands`.
 *
 * Owns its own shader module, pipeline, samplers, bind group layout, and
 * uniform buffer. Lazily initialized on first use so production frames
 * pay nothing. Mirrors {@link WebGPUDebugDepthOverlay} structurally.
 */
export class WebGPUDebugFrustumOverlay {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _colorSampler: GPUSampler | null = null;
  private _depthSampler: GPUSampler | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  // params (4 floats) + MAX_FRUSTUMS × vec4 ranges
  private _uniformData: Float32Array = new Float32Array(4 + MAX_FRUSTUMS * 4);
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
      label: "DebugFrustumOverlay shader",
      code: FRUSTUM_OVERLAY_WGSL,
    });

    this._bindGroupLayout = device.createBindGroupLayout({
      label: "DebugFrustumOverlay BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "depth" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "DebugFrustumOverlay PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "DebugFrustumOverlay Pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._colorSampler = device.createSampler({
      label: "DebugFrustumOverlay ColorSampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this._depthSampler = device.createSampler({
      label: "DebugFrustumOverlay DepthSampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    // params (16B) + 4 × vec4 ranges (64B) = 80B, rounded up to the nearest
    // 16B alignment per std140 / WGSL uniform rules.
    this._uniformBuffer = device.createBuffer({
      label: "DebugFrustumOverlay UB",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._isInitialized = true;
    this._isDestroyed = false;
  }

  /**
   * Draw the overlay. Caller is responsible for ending any active render
   * pass before invoking — we open and close our own fullscreen pass.
   *
   * @param mode 0 for showFrustums, 1 for showCommands
   * @param frustumRanges Interleaved near/far pairs for up to 4 frustums.
   *   If fewer are supplied, the unused slots are zeroed.
   */
  execute(
    encoder: GPUCommandEncoder,
    sceneColorView: GPUTextureView,
    sceneDepthView: GPUTextureView,
    targetView: GPUTextureView,
    globalNear: number,
    globalFar: number,
    mode: number,
    frustumRanges: { near: number; far: number }[],
  ): void {
    if (!this._isInitialized || !this._device || !this._pipeline) {
      return;
    }

    const data = this._uniformData;
    const numFrustums = Math.min(frustumRanges.length, MAX_FRUSTUMS);
    data[0] = globalNear;
    data[1] = globalFar;
    data[2] = mode;
    data[3] = numFrustums;
    for (let i = 0; i < MAX_FRUSTUMS; i++) {
      const base = 4 + i * 4;
      if (i < numFrustums) {
        data[base + 0] = frustumRanges[i].near;
        data[base + 1] = frustumRanges[i].far;
      } else {
        data[base + 0] = 0;
        data[base + 1] = 0;
      }
      data[base + 2] = 0;
      data[base + 3] = 0;
    }
    this._device.queue.writeBuffer(this._uniformBuffer!, 0, data);

    const bindGroup = this._device.createBindGroup({
      label: "DebugFrustumOverlay BG",
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: sceneColorView },
        { binding: 1, resource: this._colorSampler! },
        { binding: 2, resource: sceneDepthView },
        { binding: 3, resource: this._depthSampler! },
        { binding: 4, resource: { buffer: this._uniformBuffer! } },
      ],
    });

    const passEncoder = encoder.beginRenderPass({
      label: "DebugFrustumOverlay Pass",
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
    this._uniformBuffer?.destroy();
    this._uniformBuffer = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._colorSampler = null;
    this._depthSampler = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }
}

export default WebGPUDebugFrustumOverlay;
