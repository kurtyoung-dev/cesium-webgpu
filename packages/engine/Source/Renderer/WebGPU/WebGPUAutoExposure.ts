/**
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
 * @module WebGPUAutoExposure
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
import type { BindGroupCacheStats } from "./WebGPUBindGroupCache.js";
import type { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";
import type { WebGPUPassTimestampProvider } from "./WebGPUPerformanceManager.js";

export interface AutoExposureConfig {
  minimumLuminance?: number;
  maximumLuminance?: number;
  adaptationSeconds?: number;
  targetFps?: number;

  // Altitude-gated auto-exposure, paired with the bloom altitude gate. At
  // ground level the adaptive multiplier from `getExposureMultiplier()` is
  // used in full, matching WebGL; at orbit the multiplier blends toward 1.0,
  // no adaptation, so the bright atmosphere limb cannot pull exposure down
  // and darken the visible disk. Eye adaptation is a lens and retina effect,
  // and orbital photography of the disk is shot at fixed exposure, so the
  // adaptive path has no meaning at a vacuum viewpoint.
  //
  // With `enableAltitudeGate` false the gate is a no-op and the raw
  // multiplier from the compute reduction flows through. Setting
  // `altitudeGateOrbitFloor: 1.0` while leaving the gate on keeps the gate
  // path warm but neutral.
  enableAltitudeGate?: boolean;
  altitudeGateMinMeters?: number;
  altitudeGateMaxMeters?: number;
  // Floor multiplier blend at fully-gated altitude:
  //   0.0 = full adaptation at orbit
  //   1.0 = pure neutral exposure at orbit, no adaptation
  // The default 0.75 sits three quarters of the way toward neutral at orbit,
  // keeping enough adaptive influence for day/night transitions to smooth.
  altitudeGateOrbitFloor?: number;
}

export class WebGPUAutoExposure {
  private _device: GPUDevice | null = null;
  // Central compute-pipeline cache reference, captured at `initialize()` so
  // `_createPipelines` can route through it.
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

  // Altitude gate config, mirroring BloomEffect's. A `_altitudeBlend` of 1.0
  // means the full adaptive multiplier; the per-frame `applyAltitudeGate`
  // updates it.
  private _enableAltitudeGate: boolean;
  private _altitudeGateMinMeters: number;
  private _altitudeGateMaxMeters: number;
  private _altitudeGateOrbitFloor: number;
  // Blend toward neutral exposure (1.0 = full adaptation, 0.0 = neutral).
  // Computed from camera altitude in `applyAltitudeGate`; consumed by
  // `getExposureMultiplier` so the post-process pipeline picks up the
  // gated value without additional wiring.
  private _altitudeBlend = 1.0;

  private _averageLuminance = 0.5;
  // A ring of three readback buffers, to avoid the used-while-mapped race. A
  // single buffer breaks because `mapAsync` resolves asynchronously, after
  // the GPU completes the copy and the JS event loop returns to microtasks:
  // between two consecutive frames the buffer can enter the mapped state
  // while the next frame's `copyBufferToBuffer` is already queued for submit,
  // and WebGPU rejects a buffer used in a submit while mapped. With three
  // buffers there is always an idle slot to pick, and older slots finish
  // their `mapAsync` at their own pace.
  private _readbackRing: Array<{
    buffer: GPUBuffer;
    state: "idle" | "queued" | "mapped";
  }> = [];
  // Kept for backwards compatibility with the destroy() path; points
  // at whichever ring slot's buffer is the current "primary" one (the
  // one most recently copied into) so older code paths that referenced
  // `_readbackBuffer` directly still find a valid resource.
  private _readbackBuffer: GPUBuffer | null = null;

  // Auto-exposure dispatches one bind group per frame from a stable
  // `sceneColorTexture`. The naive path calls `sceneColorTexture.createView()`
  // and `device.createBindGroup()` every frame; memoizing the view by texture
  // identity and caching the bind group by resource tuple makes the steady
  // state allocation-free.
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

    // Altitude gate defaults — see AutoExposureConfig JSDoc above.
    this._enableAltitudeGate = config?.enableAltitudeGate ?? true;
    this._altitudeGateMinMeters = config?.altitudeGateMinMeters ?? 100_000.0;
    this._altitudeGateMaxMeters = config?.altitudeGateMaxMeters ?? 6_378_137.0;
    this._altitudeGateOrbitFloor = config?.altitudeGateOrbitFloor ?? 0.75;
  }

  /**
   * Read-only snapshot of the bind-group cache counters for
   * `WebGPUContext.getRendererStatistics()` and `CesiumDebug.cacheStats()`.
   * Pure exposure of bookkeeping the cache already maintains.
   */
  getBindGroupCacheStats(): BindGroupCacheStats {
    return this._bgCache.getStats();
  }

  get averageLuminance(): number {
    return this._averageLuminance;
  }

  /**
   * Returns the exposure multiplier blended with the altitude gate.
   *
   * At ground level (altitudeBlend = 1.0) this returns the raw adaptive
   * multiplier `1 / averageLuminance`. As the camera rises through the
   * gate range the result blends toward 1.0 (no adaptation) by
   * `altitudeGateOrbitFloor` × distance.
   *
   * @returns Effective exposure multiplier for the tonemap stage.
   */
  getExposureMultiplier(): number {
    const raw = 1.0 / Math.max(this._averageLuminance, 0.001);
    if (!this._enableAltitudeGate) return raw;
    // Linear mix: blend=1 → raw, blend=0 → 1.0 (neutral).
    return raw * this._altitudeBlend + 1.0 * (1.0 - this._altitudeBlend);
  }

  /**
   * Apply the per-frame altitude gate, mirroring
   * `BloomEffect.applyAltitudeGate` so the two gates pair up.
   *
   * Updates the internal `_altitudeBlend` weight: 1.0 at sea level, full
   * adaptation, falling to `1 - orbitFloor` at and above
   * `altitudeGateMaxMeters`, mostly neutral, with a smoothstep between.
   *
   * The multiplier itself is computed on demand by `getExposureMultiplier()`,
   * so callers need not re-pull values from a uniform buffer; the gate is a
   * CPU-side blend.
   *
   * @param cameraHeightMeters Camera altitude above the WGS84
   *   ellipsoid in meters (`frameState.camera.positionCartographic.height`).
   */
  applyAltitudeGate(cameraHeightMeters: number): void {
    if (!this._enableAltitudeGate) {
      this._altitudeBlend = 1.0;
      return;
    }
    const min = this._altitudeGateMinMeters;
    const max = this._altitudeGateMaxMeters;
    const t = Math.max(
      0,
      Math.min(1, (cameraHeightMeters - min) / Math.max(1e-6, max - min)),
    );
    const smooth = t * t * (3 - 2 * t);
    // blend = 1 at ground, (1 - orbitFloor) at orbit.
    // With orbitFloor=0.75: blend=1 at ground, 0.25 at orbit.
    this._altitudeBlend = 1.0 - smooth * this._altitudeGateOrbitFloor;
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    computePipelineCache: WebGPUComputePipelineCache | null = null,
  ): void {
    // Accepts the central compute-pipeline cache so `_createPipelines` can
    // route through it. A `null` default keeps the constructor-injected
    // fallback path for callers that do not supply one.
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

    // Allocate the readback ring.
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
  dispatch(
    encoder: GPUCommandEncoder,
    sceneColorTexture: GPUTexture,
    timestampProvider?: WebGPUPassTimestampProvider,
  ): void {
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

    // Memoize `createView()` per scene colour texture so its identity is
    // stable across frames, then route the bind group through the cache. The
    // steady state allocates nothing per frame.
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
    const pass1Descriptor: GPUComputePassDescriptor = {
      label: "AutoExposure pass1",
    };
    const pass1 = encoder.beginComputePass(
      timestampProvider?.withComputePassTimestamps(pass1Descriptor) ??
        pass1Descriptor,
    );
    pass1.setPipeline(this._pass1Pipeline);
    pass1.setBindGroup(0, bindGroup);
    pass1.dispatchWorkgroups(this._tileCountX, this._tileCountY, 1);
    pass1.end();

    // Pass 2: final reduction + temporal smoothing
    const pass2Descriptor: GPUComputePassDescriptor = {
      label: "AutoExposure pass2",
    };
    const pass2 = encoder.beginComputePass(
      timestampProvider?.withComputePassTimestamps(pass2Descriptor) ??
        pass2Descriptor,
    );
    pass2.setPipeline(this._pass2Pipeline);
    pass2.setBindGroup(0, bindGroup);
    pass2.dispatchWorkgroups(1, 1, 1);
    pass2.end();

    // Ring-buffered async readback: pick an idle slot, copy the current
    // frame's result into it, and queue the `mapAsync`. Slots move through
    // idle, queued, mapped and back to idle over one or two frames, and three
    // slots keep at least one idle. If none is idle — a slot's `mapAsync`
    // stalled on a hung GPU, say — readback is skipped for the frame and the
    // previous `averageLuminance` is reused, which is what tonemap stability
    // wants anyway.
    const slot = this._readbackRing.find((s) => s.state === "idle");
    if (slot) {
      encoder.copyBufferToBuffer(this._resultBuffer, 0, slot.buffer, 0, 4);
      slot.state = "queued";
      this._readbackBuffer = slot.buffer; // keep the back-compat handle current
      // Capture slot reference so the callback can detect if the ring
      // was destroyed/replaced (resize, device loss) between mapAsync()
      // and resolution.
      const ring = this._readbackRing;
      // Defer the `mapAsync` to a microtask so it runs after the scene
      // renderer's `queue.submit`. Calling it immediately puts the buffer into
      // a pending-map state, and the queued submit referencing it — the
      // `copyBufferToBuffer` above belongs to the encoder about to be
      // submitted — then fails validation as a buffer used in a submit while
      // mapped. The delay costs nothing: the synchronous code above queues
      // the copy on the encoder, the submit completes, and only then does
      // this microtask schedule the `mapAsync`.
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

    // Route both passes through the central pipeline cache, so two
    // post-process pipelines in a multi-viewer setup that share a shader and
    // layout share one pipeline.
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
    // Destroy each ring slot's buffer. Pending `mapAsync` promises on them
    // reject; the `.catch` handler is a no-op because the ring identity check
    // filters out resolutions against a stale ring.
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
    // The storage and uniform buffers in the cached bind group were just
    // destroyed, so stale entries are dropped and the next dispatch rebuilds
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
