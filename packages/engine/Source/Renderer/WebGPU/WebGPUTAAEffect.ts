/// <reference types="@webgpu/types" />
/**
 * @module WebGPUTAAEffect
 *
 * Temporal Anti-Aliasing post-process effect. Accumulates jittered frames
 * into a history buffer using neighborhood clamping to suppress ghosting.
 *
 * Toggle: `scene.taaEnabled` (default false).
 * Pipeline position: after ColorGrading, before FXAA.
 *
 * Requires:
 *   - Sub-pixel camera jitter (Halton 2,3 sequence)
 *   - History ping-pong textures (managed internally)
 *   - Depth texture for future motion vector reprojection
 *
 * @private
 */

import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";
import type { DebugStatsObject } from "../GraphicsContext.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import TAASource from "../../Shaders/WebGPU/PostProcess/TAA.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  WebGPUParityManager,
  type HistorySlotId,
} from "./WebGPUParityManager.js";

// TAA params UBO layout (256-byte aligned, 240 bytes of content):
//   offset   0: texelSize          vec2<f32>   (8B)
//   offset   8: blendWeight        f32         (4B)
//   offset  12: frameIndex         u32         (4B)
//   offset  16: jitterOffset       vec2<f32>   (8B)
//   offset  24: historyValid       u32         (4B)   — 0 on the first post-jitter frame; suppresses reprojection
//   offset  28: _pad0              u32         (4B)
//   offset  32: currentVpRte       mat4x4<f32> (64B)  — used to unproject current depth → eye-relative
//   offset  96: previousVpRte      mat4x4<f32> (64B)  — reprojects previous eye-relative → previous NDC
//   offset 160: inverseCurrentVpRte mat4x4<f32>(64B)  — CPU-precomputed once/frame so the shader skips per-pixel inverse
//   offset 224: cameraDelta        vec3<f32>   (12B)  — currentCameraWC - previousCameraWC, FP64 on CPU
//   offset 236: _pad1              f32         (4B)
// Padded to 256 for UBO minimum binding alignment.
const TAA_PARAMS_BYTES = 256;
const TAA_PARAMS_FLOATS = TAA_PARAMS_BYTES / 4;

/**
 * Invert a column-major 4×4 matrix in-place into `result`. Matches the
 * algorithm used by Cesium's `Matrix4.inverse`. Imported as a standalone
 * function to avoid cross-module Matrix4 import coupling — this file is
 * already a TS-compiled unit with no Matrix4 dependency.
 *
 * Returns `result`; throws if the matrix is singular (non-invertible).
 */
export function _invertMatrix4(
  m: ArrayLike<number>,
  result: Float64Array,
): Float64Array {
  const src0 = m[0],
    src1 = m[4],
    src2 = m[8],
    src3 = m[12];
  const src4 = m[1],
    src5 = m[5],
    src6 = m[9],
    src7 = m[13];
  const src8 = m[2],
    src9 = m[6],
    src10 = m[10],
    src11 = m[14];
  const src12 = m[3],
    src13 = m[7],
    src14 = m[11],
    src15 = m[15];

  const tmp0 = src10 * src15;
  const tmp1 = src11 * src14;
  const tmp2 = src9 * src15;
  const tmp3 = src11 * src13;
  const tmp4 = src9 * src14;
  const tmp5 = src10 * src13;
  const tmp6 = src8 * src15;
  const tmp7 = src11 * src12;
  const tmp8 = src8 * src14;
  const tmp9 = src10 * src12;
  const tmp10 = src8 * src13;
  const tmp11 = src9 * src12;

  const dst0 =
    tmp0 * src5 +
    tmp3 * src6 +
    tmp4 * src7 -
    (tmp1 * src5 + tmp2 * src6 + tmp5 * src7);
  const dst1 =
    tmp1 * src4 +
    tmp6 * src6 +
    tmp9 * src7 -
    (tmp0 * src4 + tmp7 * src6 + tmp8 * src7);
  const dst2 =
    tmp2 * src4 +
    tmp7 * src5 +
    tmp10 * src7 -
    (tmp3 * src4 + tmp6 * src5 + tmp11 * src7);
  const dst3 =
    tmp5 * src4 +
    tmp8 * src5 +
    tmp11 * src6 -
    (tmp4 * src4 + tmp9 * src5 + tmp10 * src6);
  const dst4 =
    tmp1 * src1 +
    tmp2 * src2 +
    tmp5 * src3 -
    (tmp0 * src1 + tmp3 * src2 + tmp4 * src3);
  const dst5 =
    tmp0 * src0 +
    tmp7 * src2 +
    tmp8 * src3 -
    (tmp1 * src0 + tmp6 * src2 + tmp9 * src3);
  const dst6 =
    tmp3 * src0 +
    tmp6 * src1 +
    tmp11 * src3 -
    (tmp2 * src0 + tmp7 * src1 + tmp10 * src3);
  const dst7 =
    tmp4 * src0 +
    tmp9 * src1 +
    tmp10 * src2 -
    (tmp5 * src0 + tmp8 * src1 + tmp11 * src2);

  const tmp12 = src2 * src7;
  const tmp13 = src3 * src6;
  const tmp14 = src1 * src7;
  const tmp15 = src3 * src5;
  const tmp16 = src1 * src6;
  const tmp17 = src2 * src5;
  const tmp18 = src0 * src7;
  const tmp19 = src3 * src4;
  const tmp20 = src0 * src6;
  const tmp21 = src2 * src4;
  const tmp22 = src0 * src5;
  const tmp23 = src1 * src4;

  const dst8 =
    tmp12 * src13 +
    tmp15 * src14 +
    tmp16 * src15 -
    (tmp13 * src13 + tmp14 * src14 + tmp17 * src15);
  const dst9 =
    tmp13 * src12 +
    tmp18 * src14 +
    tmp21 * src15 -
    (tmp12 * src12 + tmp19 * src14 + tmp20 * src15);
  const dst10 =
    tmp14 * src12 +
    tmp19 * src13 +
    tmp22 * src15 -
    (tmp15 * src12 + tmp18 * src13 + tmp23 * src15);
  const dst11 =
    tmp17 * src12 +
    tmp20 * src13 +
    tmp23 * src14 -
    (tmp16 * src12 + tmp21 * src13 + tmp22 * src14);
  const dst12 =
    tmp14 * src10 +
    tmp17 * src11 +
    tmp13 * src9 -
    (tmp16 * src11 + tmp12 * src9 + tmp15 * src10);
  const dst13 =
    tmp20 * src11 +
    tmp12 * src8 +
    tmp19 * src10 -
    (tmp18 * src10 + tmp21 * src11 + tmp13 * src8);
  const dst14 =
    tmp18 * src9 +
    tmp23 * src11 +
    tmp15 * src8 -
    (tmp22 * src11 + tmp14 * src8 + tmp19 * src9);
  const dst15 =
    tmp22 * src10 +
    tmp16 * src8 +
    tmp21 * src9 -
    (tmp20 * src9 + tmp23 * src10 + tmp17 * src8);

  const det = src0 * dst0 + src1 * dst1 + src2 * dst2 + src3 * dst3;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) {
    // Degenerate — fall back to identity so the TAA shader doesn't NaN.
    result[0] = 1;
    result[1] = 0;
    result[2] = 0;
    result[3] = 0;
    result[4] = 0;
    result[5] = 1;
    result[6] = 0;
    result[7] = 0;
    result[8] = 0;
    result[9] = 0;
    result[10] = 1;
    result[11] = 0;
    result[12] = 0;
    result[13] = 0;
    result[14] = 0;
    result[15] = 1;
    return result;
  }
  const invDet = 1.0 / det;

  result[0] = dst0 * invDet;
  result[1] = dst1 * invDet;
  result[2] = dst2 * invDet;
  result[3] = dst3 * invDet;
  result[4] = dst4 * invDet;
  result[5] = dst5 * invDet;
  result[6] = dst6 * invDet;
  result[7] = dst7 * invDet;
  result[8] = dst8 * invDet;
  result[9] = dst9 * invDet;
  result[10] = dst10 * invDet;
  result[11] = dst11 * invDet;
  result[12] = dst12 * invDet;
  result[13] = dst13 * invDet;
  result[14] = dst14 * invDet;
  result[15] = dst15 * invDet;
  return result;
}

/**
 * Halton sequence evaluator — low-discrepancy quasi-random sequence
 * for sub-pixel jitter offsets. Uses bases 2 and 3 (standard for TAA).
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

export class WebGPUTAAEffect implements PostProcessEffect {
  readonly name = "TAA";
  enabled = false;

  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _paramsScratch = new Float32Array(TAA_PARAMS_FLOATS);

  // Motion-vector state fed by `updateMotionVectorParams()` before each
  // `execute()` call. Kept as FP64 Float64Arrays so the CPU-side composition
  // (especially `inverse(currentVpRte)`) preserves precision; FP32 down-cast
  // happens only when we write to the uniform scratch.
  private _currentVpRte = new Float64Array(16);
  private _previousVpRte = new Float64Array(16);
  private _inverseCurrentVpRte = new Float64Array(16);
  private _cameraDelta: [number, number, number] = [0, 0, 0];
  private _motionVectorsValid = false;

  // History ping-pong. Phase tracking is delegated to WebGPUParityManager
  // (FEAT-SURVEY-07) — the manager owns the "current read / current write"
  // decision for every history effect so individual consumers can't
  // double-flip, miss-flip, or flip at the wrong point in their lifecycle.
  // Current design: TAA owns its own manager (1 consumer, 1 slot); a later
  // session can hoist the manager to the scene renderer so Hi-Z
  // reprojection and auto-exposure share a single monotonic frame counter.
  private _historyTextures: [GPUTexture | null, GPUTexture | null] = [
    null,
    null,
  ];
  private _historyViews: [GPUTextureView | null, GPUTextureView | null] = [
    null,
    null,
  ];
  private readonly _parityManager = new WebGPUParityManager();
  private _historySlotId: HistorySlotId | null = null;
  // `_skipNextBlend` preserves the old reset-on-resize behaviour: when the
  // history textures are freshly allocated their contents aren't a valid
  // previous frame, so we return the source view unchanged on the next
  // `execute()` call and let frame N+2 be the first real blend.
  private _skipNextBlend = true;

  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";
  private _sampler: GPUSampler | null = null;

  // Current jitter offset in UV space (set by the caller before execute).
  jitterX = 0;
  jitterY = 0;

  /** Blend weight: fraction of current frame in the blend (0.1 = 10%). */
  blendWeight = 0.1;

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._format = format;
    this._width = width;
    this._height = height;

    // Params UBO
    this._paramsBuffer = device.createBuffer({
      label: "TAA_Params",
      size: TAA_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sampler
    this._sampler = device.createSampler({
      label: "TAA_Sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    // Bind group layout
    this._bindGroupLayout = makeBindGroupLayout(device, "TAA_BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT, { sampleType: "depth" }),
      sampler(3, Stage.FRAGMENT),
      uniformBuffer(4, Stage.FRAGMENT),
    ]);

    // Render pipeline
    const shaderModule = device.createShaderModule({
      label: "TAA_Shader",
      code: TAASource,
    });

    this._pipeline = device.createRenderPipeline({
      label: "TAA_Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._allocateHistoryTextures(width, height, format);
  }

  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) {
      return;
    }
    this._width = width;
    this._height = height;
    // `_allocateHistoryTextures` also sets `_skipNextBlend = true` so the
    // next execute() returns the source view without blending stale history.
    this._allocateHistoryTextures(width, height, this._format);
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    _sampler: GPUSampler,
  ): GPUTextureView {
    if (
      !this._device ||
      !this._pipeline ||
      !this._paramsBuffer ||
      !this._sampler ||
      !this._bindGroupLayout ||
      this._historySlotId === null
    ) {
      return sourceView;
    }

    // Advance the parity counter EXACTLY ONCE per frame, here at the
    // execute entry point. The ParityManager resolves read/write slots
    // from `frameIndex` — `read()` returns pair[(frameIndex-1) & 1] and
    // `write()` returns pair[frameIndex & 1], so a single advance gives
    // us both sides of the ping-pong for free.
    this._parityManager.advanceFrame();

    const historyReadView = this._parityManager.read<GPUTextureView>(
      this._historySlotId,
    );
    const historyWriteView = this._parityManager.write<GPUTextureView>(
      this._historySlotId,
    );

    // First frame / post-resize: skip blending — the "previous" history
    // slot contains undefined contents. Next frame will blend normally.
    if (this._skipNextBlend) {
      this._skipNextBlend = false;
      return sourceView;
    }

    // Upload params.
    const p = this._paramsScratch;
    p[0] = 1.0 / this._width;
    p[1] = 1.0 / this._height;
    p[2] = this.blendWeight;
    const u32View = new Uint32Array(p.buffer);
    u32View[3] = this._parityManager.frameIndex;
    p[4] = this.jitterX;
    p[5] = this.jitterY;
    // historyValid gates reprojection: 0 on the very first frame where the
    // "previous" VP is still identity, so the shader skips motion-vector
    // math and falls back to the unjittered-UV sample.
    u32View[6] = this._motionVectorsValid ? 1 : 0;
    u32View[7] = 0;
    // currentVpRte (offset 32, floats 8..23).
    for (let i = 0; i < 16; i++) p[8 + i] = this._currentVpRte[i];
    // previousVpRte (offset 96, floats 24..39).
    for (let i = 0; i < 16; i++) p[24 + i] = this._previousVpRte[i];
    // inverseCurrentVpRte (offset 160, floats 40..55).
    for (let i = 0; i < 16; i++) p[40 + i] = this._inverseCurrentVpRte[i];
    // cameraDelta (offset 224, floats 56..58 + pad at 59).
    p[56] = this._cameraDelta[0];
    p[57] = this._cameraDelta[1];
    p[58] = this._cameraDelta[2];
    p[59] = 0;
    // Remaining slots up to TAA_PARAMS_FLOATS are padding — leave zeroed.
    this._device.queue.writeBuffer(this._paramsBuffer, 0, p);

    // Use a dummy depth view if none provided.
    // The TAA shader currently doesn't use depth for motion vectors,
    // but the bind group layout requires it.
    if (!depthView) {
      // Can't run without depth — pass through. Parity already advanced.
      return sourceView;
    }

    // Build bind group.
    const bg = this._device.createBindGroup({
      label: "TAA_BG",
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: historyReadView },
        { binding: 2, resource: depthView },
        { binding: 3, resource: this._sampler },
        { binding: 4, resource: { buffer: this._paramsBuffer } },
      ],
    });

    // Render into the write history slot.
    const pass = encoder.beginRenderPass({
      label: "TAA_Pass",
      colorAttachments: [
        {
          view: historyWriteView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3, 1, 0, 0);
    pass.end();

    // Parity was already advanced at the top of execute() — no manual
    // flip needed here. Returning `historyWriteView` matches the old
    // behaviour: the pass just wrote into `pair[frameIndex & 1]`, and
    // next frame's `read()` will pick it up as `pair[(frameIndex) & 1]`
    // since frameIndex will have advanced by 1.
    return historyWriteView;
  }

  /**
   * Push motion-vector matrices + camera delta from the caller (typically
   * `Scene.js` pulling from `UniformState`). Called once per frame before
   * `execute()`. Operates in FP64 on the CPU so the inverse of
   * `currentVpRte` preserves precision before the shader consumes it.
   *
   * @param currentVpRte - Current-frame view-projection RTE: projection ×
   *   (view with translation zeroed). What the main scene rendered with.
   * @param previousVpRte - Previous-frame view-projection RTE (snapshot
   *   from `UniformState.previousViewProjectionRelativeToEye`).
   * @param cameraDeltaX/Y/Z - `currentCameraWC - previousCameraWC`,
   *   computed in FP64 on CPU. Applied as `previousEyeRel = currentEyeRel + delta`
   *   inside the TAA shader to shift eye-relative coords between frames
   *   without reconstructing world-space positions.
   * @param valid - False on the first frame (no meaningful previous
   *   snapshot); the shader skips motion-vector math in that case.
   */
  updateMotionVectorParams(
    currentVpRte: ArrayLike<number>,
    previousVpRte: ArrayLike<number>,
    cameraDeltaX: number,
    cameraDeltaY: number,
    cameraDeltaZ: number,
    valid: boolean,
  ): void {
    for (let i = 0; i < 16; i++) {
      this._currentVpRte[i] = currentVpRte[i];
      this._previousVpRte[i] = previousVpRte[i];
    }
    _invertMatrix4(this._currentVpRte, this._inverseCurrentVpRte);
    this._cameraDelta[0] = cameraDeltaX;
    this._cameraDelta[1] = cameraDeltaY;
    this._cameraDelta[2] = cameraDeltaZ;
    this._motionVectorsValid = valid;
  }

  /**
   * Compute jitter offset for the current frame using Halton(2,3).
   * Returns offset in NDC space (apply to projection matrix columns 2,0 and 2,1).
   */
  computeJitter(
    frameIndex: number,
    screenWidth: number,
    screenHeight: number,
  ): { x: number; y: number } {
    const hx = halton((frameIndex % 16) + 1, 2);
    const hy = halton((frameIndex % 16) + 1, 3);
    const x = ((hx - 0.5) * 2.0) / screenWidth;
    const y = ((hy - 0.5) * 2.0) / screenHeight;
    this.jitterX = (hx - 0.5) / screenWidth;
    this.jitterY = (hy - 0.5) / screenHeight;
    return { x, y };
  }

  getStatistics(): DebugStatsObject {
    return {
      enabled: this.enabled,
      // Derived from the ParityManager so the stat stays in sync with
      // whatever slot the manager returns from `read()/write()` this frame.
      frameCounter: this._parityManager.frameIndex,
      blendWeight: this.blendWeight,
      jitterX: this.jitterX,
      jitterY: this.jitterY,
      // `historyIndex` retains its historical meaning: which slot is the
      // WRITE slot this frame (= `frameIndex & 1` for phaseOffset 0).
      historyIndex: this._parityManager.frameIndex & 1,
    };
  }

  destroy(): void {
    for (let i = 0; i < 2; i++) {
      if (this._historyTextures[i]) {
        this._historyTextures[i]!.destroy();
        this._historyTextures[i] = null;
        this._historyViews[i] = null;
      }
    }
    if (this._paramsBuffer) {
      this._paramsBuffer.destroy();
      this._paramsBuffer = null;
    }
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
  }

  private _allocateHistoryTextures(
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    if (!this._device) return;
    for (let i = 0; i < 2; i++) {
      if (this._historyTextures[i]) {
        this._historyTextures[i]!.destroy();
      }
      this._historyTextures[i] = this._device.createTexture({
        label: `TAA_History_${i}`,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this._historyViews[i] = this._historyTextures[i]!.createView({
        label: `TAA_History_${i}_View`,
      });
    }

    // Register or rebind the slot on the ParityManager. Rebinding
    // preserves the slot's phase so frames that happen AFTER a resize
    // still alternate read/write correctly; `_skipNextBlend` flags the
    // next execute() to pass through without blending because the newly
    // allocated textures have undefined contents.
    const pair: [GPUTextureView, GPUTextureView] = [
      this._historyViews[0]!,
      this._historyViews[1]!,
    ];
    if (this._historySlotId === null) {
      this._historySlotId = this._parityManager.register<GPUTextureView>(
        "taa-history",
        pair,
      );
    } else {
      this._parityManager.rebind<GPUTextureView>(this._historySlotId, pair);
    }
    this._skipNextBlend = true;
  }
}
