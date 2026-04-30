/**
 * @module WebGPUAutoExposure
 *
 * GPU compute-based auto-exposure for the WebGPU post-process pipeline.
 * Replaces the WebGL multi-pass framebuffer reduction (AutoExposure.js)
 * with a two-pass compute shader that's both simpler and faster.
 *
 * Pass 1: parallel reduction — each 16×16 workgroup reduces its tile to
 * a single luminance value via shared-memory tree reduction.
 *
 * Pass 2: single workgroup reduces all tile values to one scalar and
 * applies temporal smoothing against the previous frame.
 *
 * The output is a single f32 (`averageLuminance`) that the tonemapping
 * stage reads via `getExposureMultiplier()` to implement adaptive
 * eye adaptation. The tonemapping shader's `exposure` uniform is
 * multiplied by `1 / (averageLuminance + epsilon)` to brighten dark
 * scenes and darken bright scenes.
 *
 * @private
 */

/// <reference types="@webgpu/types" />

import AutoExposureWGSL from "../../Shaders/WebGPU/Compute/AutoExposure.js";
import {
  makeBindGroupLayout,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import WebGPUBindGroupCache from "./WebGPUBindGroupCache.js";
import type { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";

export interface AutoExposureConfig {
  minimumLuminance?: number;
  maximumLuminance?: number;
  adaptationSeconds?: number;
  targetFps?: number;
}

export class WebGPUAutoExposure {
  private _device: GPUDevice | null = null;
  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — central cache reference
  // captured at `initialize()` time so `_createPipelines` can route
  // through it.
  private _computePipelineCache: WebGPUComputePipelineCache | null = null;
  private _pass1Pipeline: GPUComputePipeline | null = null;
  private _pass2Pipeline: GPUComputePipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private _intermediateBuffer: GPUBuffer | null = null;
  private _resultBuffer: GPUBuffer | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _paramsData: Float32Array = new Float32Array(8);

  private _width = 0;
  private _height = 0;
  private _tileCountX = 0;
  private _tileCountY = 0;

  private _minimumLuminance: number;
  private _maximumLuminance: number;
  private _adaptationRate: number;

  private _averageLuminance = 0.5;
  // Batch 110 — ring of 3 readback buffers to avoid the "used while
  // mapped" race. A single buffer breaks because `mapAsync` resolves
  // asynchronously (after GPU completes the copy + the JS event loop
  // returns to microtasks); between two consecutive frames the buffer
  // can transition into the mapped state while the next frame's
  // `copyBufferToBuffer` is already queued for submit, and WebGPU
  // rejects "buffer used in submit while mapped". With 3 buffers we
  // pick whichever slot is currently idle each frame, leaving older
  // slots to finish their mapAsync at their own pace.
  private _readbackRing: Array<{
    buffer: GPUBuffer;
    state: "idle" | "queued" | "mapped";
  }> = [];
  // Kept for backwards compatibility with the destroy() path; points
  // at whichever ring slot's buffer is the current "primary" one (the
  // one most recently copied into) so older code paths that referenced
  // `_readbackBuffer` directly still find a valid resource.
  private _readbackBuffer: GPUBuffer | null = null;

  // C-R11 (Batch 32) — AutoExposure dispatches one bind group per frame
  // from a stable sceneColorTexture. The naive path does
  // `sceneColorTexture.createView()` + `device.createBindGroup()` each
  // frame. We memoize the view by texture identity + cache the bind
  // group by resource tuple; steady state is zero per-frame allocations.
  private _viewCache = new WeakMap<GPUTexture, GPUTextureView>();
  private _bgCache = new WebGPUBindGroupCache();

  enabled = true;
  private _initialized = false;

  constructor(config?: AutoExposureConfig) {
    this._minimumLuminance = config?.minimumLuminance ?? 0.1;
    this._maximumLuminance = config?.maximumLuminance ?? 10.0;
    const fps = config?.targetFps ?? 60;
    const seconds = config?.adaptationSeconds ?? 1.5;
    this._adaptationRate = 1.0 / (fps * seconds);
  }

  get averageLuminance(): number {
    return this._averageLuminance;
  }

  getExposureMultiplier(): number {
    return 1.0 / Math.max(this._averageLuminance, 0.001);
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    computePipelineCache: WebGPUComputePipelineCache | null = null,
  ): void {
    // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — accept the central cache
    // so `_createPipelines` can route through it. Default `null` keeps
    // the constructor-injected fallback path in callers that haven't
    // been threaded through yet.
    this._computePipelineCache = computePipelineCache;
    if (
      this._initialized &&
      this._width === width &&
      this._height === height &&
      this._device === device
    ) {
      return;
    }

    this._device = device;
    this._width = width;
    this._height = height;
    this._tileCountX = Math.ceil(width / 16);
    this._tileCountY = Math.ceil(height / 16);
    const totalTiles = this._tileCountX * this._tileCountY;

    this._destroyBuffers();

    if (!this._pass1Pipeline) {
      this._createPipelines(device);
    }

    this._intermediateBuffer = device.createBuffer({
      label: "AutoExposure intermediate",
      size: Math.max(totalTiles * 4, 4),
      usage: GPUBufferUsage.STORAGE,
    });

    // Result buffer: holds 1 f32 (the average luminance). Initialized to
    // 0.5 so the first frame's temporal smoothing has a sane starting point.
    this._resultBuffer = device.createBuffer({
      label: "AutoExposure result",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Batch 110 — allocate the readback ring (3 slots).
    this._readbackRing = [];
    for (let i = 0; i < 3; i++) {
      const buf = device.createBuffer({
        label: `AutoExposure readback (slot ${i})`,
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this._readbackRing.push({ buffer: buf, state: "idle" });
    }
    this._readbackBuffer = this._readbackRing[0].buffer;

    this._paramsBuffer = device.createBuffer({
      label: "AutoExposure params",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._initialized = true;
  }

  /**
   * Dispatch both compute passes. Must be called inside a command encoder
   * scope BEFORE the tonemapping stage executes.
   *
   * @param encoder The command encoder for this frame
   * @param sceneColorView The scene framebuffer's color texture view (HDR)
   */
  dispatch(encoder: GPUCommandEncoder, sceneColorTexture: GPUTexture): void {
    if (
      !this.enabled ||
      !this._device ||
      !this._pass1Pipeline ||
      !this._pass2Pipeline ||
      !this._intermediateBuffer ||
      !this._resultBuffer ||
      !this._paramsBuffer
    ) {
      return;
    }

    const device = this._device;

    // Update params
    const p = this._paramsData;
    p[0] = this._width;
    p[1] = this._height;
    p[2] = this._tileCountX;
    p[3] = this._tileCountY;
    p[4] = this._minimumLuminance;
    p[5] = this._maximumLuminance;
    p[6] = this._adaptationRate;
    p[7] = 0; // pad
    device.queue.writeBuffer(this._paramsBuffer, 0, p);

    // C-R11 (Batch 32) — memoize createView() per sceneColorTexture so
    // its identity is stable across frames, then route the bind group
    // through the cache. Steady state: 0 per-frame allocations.
    let sceneView = this._viewCache.get(sceneColorTexture);
    if (!sceneView) {
      sceneView = sceneColorTexture.createView();
      this._viewCache.set(sceneColorTexture, sceneView);
    }
    const bindGroup = this._bgCache.getOrCreate(
      device,
      "AutoExposure-BG",
      this._bindGroupLayout!,
      [
        { binding: 0, resource: sceneView },
        { binding: 1, resource: { buffer: this._intermediateBuffer } },
        { binding: 2, resource: { buffer: this._resultBuffer } },
        { binding: 3, resource: { buffer: this._paramsBuffer } },
      ],
    );

    // Pass 1: tile reduction
    const pass1 = encoder.beginComputePass({
      label: "AutoExposure pass1",
    });
    pass1.setPipeline(this._pass1Pipeline);
    pass1.setBindGroup(0, bindGroup);
    pass1.dispatchWorkgroups(this._tileCountX, this._tileCountY, 1);
    pass1.end();

    // Pass 2: final reduction + temporal smoothing
    const pass2 = encoder.beginComputePass({
      label: "AutoExposure pass2",
    });
    pass2.setPipeline(this._pass2Pipeline);
    pass2.setBindGroup(0, bindGroup);
    pass2.dispatchWorkgroups(1, 1, 1);
    pass2.end();

    // Batch 110 — ring-buffered async readback. Pick an idle slot, copy
    // the current frame's result into it, queue mapAsync. Slots transition
    // through `idle → queued → mapped → idle` over (typically) 1-2 frames;
    // having 3 slots ensures at least one is always idle. If somehow none
    // is idle (e.g., a slot's mapAsync stalled on a hung GPU), we skip
    // readback this frame — the previous frame's averageLuminance is
    // reused, which is fine for tonemap stability.
    const slot = this._readbackRing.find((s) => s.state === "idle");
    if (slot) {
      encoder.copyBufferToBuffer(this._resultBuffer, 0, slot.buffer, 0, 4);
      slot.state = "queued";
      this._readbackBuffer = slot.buffer; // keep the back-compat handle current
      // Capture slot reference so the callback can detect if the ring
      // was destroyed/replaced (resize, device loss) between mapAsync()
      // and resolution.
      const ring = this._readbackRing;
      // Batch 110 — defer mapAsync to a microtask so it runs AFTER the
      // SceneRenderer's queue.submit. Calling mapAsync immediately would
      // put the buffer into "pending-map" state, and any queued submit
      // that references it (the copyBufferToBuffer above is part of the
      // same encoder we're about to submit) would fail validation with
      // "buffer used in submit while mapped". The microtask delay is
      // free — the synchronous code above queues the copy on the
      // encoder, the SceneRenderer's submit completes, then this
      // microtask schedules the mapAsync.
      Promise.resolve().then(() => {
        if (ring !== this._readbackRing) return;
        slot.buffer
          .mapAsync(GPUMapMode.READ)
          .then(() => {
            if (ring !== this._readbackRing) {
              return;
            }
            slot.state = "mapped";
            try {
              const data = new Float32Array(slot.buffer.getMappedRange());
              this._averageLuminance = data[0];
            } finally {
              try {
                slot.buffer.unmap();
              } catch {
                /* already unmapped (destroy raced) */
              }
              slot.state = "idle";
            }
          })
          .catch(() => {
            if (ring !== this._readbackRing) return;
            slot.state = "idle";
          });
      });
    }
  }

  private _createPipelines(device: GPUDevice): void {
    const module = device.createShaderModule({
      label: "AutoExposure compute",
      code: AutoExposureWGSL,
    });

    this._bindGroupLayout = makeBindGroupLayout(device, "AutoExposure BGL", [
      texture(0, Stage.COMPUTE),
      storageBuffer(1, Stage.COMPUTE),
      storageBuffer(2, Stage.COMPUTE),
      uniformBuffer(3, Stage.COMPUTE),
    ]);

    const layout = device.createPipelineLayout({
      label: "AutoExposure PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — route both passes through
    // the central cache. Two PostProcessPipelines (multi-viewer setup)
    // sharing the same shader + layout will share one pipeline.
    const computeCache = this._computePipelineCache;
    if (computeCache) {
      this._pass1Pipeline = computeCache.getOrCreateSync({
        name: "AutoExposure pass1",
        layout,
        compute: { module, entryPoint: "pass1" },
      });
      this._pass2Pipeline = computeCache.getOrCreateSync({
        name: "AutoExposure pass2",
        layout,
        compute: { module, entryPoint: "pass2" },
      });
    } else {
      this._pass1Pipeline = device.createComputePipeline({
        label: "AutoExposure pass1",
        layout,
        compute: { module, entryPoint: "pass1" },
      });
      this._pass2Pipeline = device.createComputePipeline({
        label: "AutoExposure pass2",
        layout,
        compute: { module, entryPoint: "pass2" },
      });
    }
  }

  private _destroyBuffers(): void {
    this._intermediateBuffer?.destroy();
    this._resultBuffer?.destroy();
    // Batch 110 — destroy each ring slot's buffer. Pending mapAsync
    // promises on these buffers will reject; the .catch handler is a
    // no-op since the ring identity check filters out resolutions
    // against a stale ring.
    for (const slot of this._readbackRing) {
      try {
        slot.buffer.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this._readbackRing = [];
    this._readbackBuffer = null;
    this._paramsBuffer?.destroy();
    this._intermediateBuffer = null;
    this._resultBuffer = null;
    this._paramsBuffer = null;
    this._bindGroup = null;
    // C-R11 (Batch 32) — the storage/uniform buffers in the cached BG
    // were just destroyed; drop stale entries so next dispatch rebuilds
    // against the fresh buffers.
    this._bgCache.invalidateAll();
  }

  destroy(): void {
    this._destroyBuffers();
    this._pass1Pipeline = null;
    this._pass2Pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
    this._initialized = false;
  }
}
