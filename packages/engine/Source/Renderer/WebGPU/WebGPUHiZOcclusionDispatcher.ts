/// <reference types="@webgpu/types" />
/**
 * @module WebGPUHiZOcclusionDispatcher
 *
 * Phase 3 activation wrapper for the HiZPyramid + OcclusionTest compute
 * shaders. Owns the GPU resources that the pair of shaders needs:
 *
 *   - Hi-Z pyramid texture (`r32float`, mipmapped, built bottom-up from
 *     the previous frame's depth buffer)
 *   - Per-mip bind groups for the `HiZPyramid.wgsl` compute pass
 *   - SOA sphere storage buffers matching `SOABoundingSphereLayout`
 *   - OcclusionParams UBO + visibility output storage buffer
 *   - Staging buffer for async `mapAsync` readback
 *
 * The dispatcher exposes three entry points:
 *
 *   buildHiZPyramid(encoder, depthTextureView, mipLevels)
 *     — Records a compute pass per mip level that reduces the input
 *       depth into the Hi-Z mip chain. Mip 0 is the caller's depth
 *       texture; mips 1..N are the dispatcher's pyramid texture.
 *
 *   dispatchOcclusionTest(encoder, soa, params)
 *     — Uploads the SOA sphere buffers + OcclusionParams UBO, encodes
 *       the occlusion test compute pass, and copies the visibility
 *       output into the staging buffer for readback next frame.
 *
 *   readbackVisibility() : Promise<Uint8Array | null>
 *     — Maps the staging buffer, reads it into a Uint8Array, and
 *       unmaps. Returns `null` when no test has been dispatched yet
 *       or when the readback is already in-flight from a previous call.
 *
 * The JS fallback (OcclusionCulling with everything treated as visible)
 * is still the authoritative path until the consumer wires the current
 * frame's depth texture into `buildHiZPyramid`. This dispatcher is the
 * GPU-side half of that wiring; the Scene integration is a separate
 * step (tracked in the backlog).
 *
 * @private
 */

/**
 * Bind group layout constants — kept in sync with the WGSL @group(0)
 * layouts. A mismatch here will fail pipeline creation, so the
 * explicit layout is worth the verbosity.
 */

const HI_Z_PARAMS_BYTES = 32; // 8 × u32
const OCCLUSION_PARAMS_BYTES = 96; // mat4 (64) + 4 floats + 4 u32 = 96

/** Per-mip resources for the HiZ pyramid build. */
interface HiZMipLevel {
  /** Full-size bind group for this mip (depthInput view + hiZOutput view + params UBO).
   *  Null until `_getOrBuildMipBindGroup` lazily builds it for the current input view. */
  bindGroup: GPUBindGroup | null;
  /** Storage texture view for this mip. */
  outputView: GPUTextureView;
  /** Per-mip params UBO. */
  paramsBuffer: GPUBuffer;
  /** Output dimensions at this mip. */
  width: number;
  height: number;
}

interface HiZOcclusionResources {
  /** Input depth used to build mip 0. Caller owns the underlying texture. */
  boundDepthTextureView: GPUTextureView | null;
  /** The Hi-Z mip pyramid — one texture, `mipLevels` mips. */
  hiZTexture: GPUTexture;
  /** Full-mip sampleable view used by the occlusion test pass. */
  hiZSampleView: GPUTextureView;
  /** One HiZMipLevel per mip level built (mip 1..N-1; mip 0 is the input). */
  mipLevels: HiZMipLevel[];
  /** Depth-mip-0 view created from the bound depth texture (mip 0 = input). */
  depthMip0View: GPUTextureView | null;
  /** Pipelines. */
  hiZPipeline: GPUComputePipeline;
  /** Mip 0 pipeline that reads texture_depth_2d (sampleType "depth"). */
  hiZFromDepthPipeline: GPUComputePipeline | null;
  occlusionPipeline: GPUComputePipeline;
  hiZBindGroupLayout: GPUBindGroupLayout;
  /** Mip 0 bind group layout for depth-format input (sampleType "depth"). */
  hiZFromDepthBindGroupLayout: GPUBindGroupLayout | null;
  occlusionBindGroupLayout: GPUBindGroupLayout;
  /** OcclusionTest sampler (comparison not required — uses linear sample). */
  hiZSampler: GPUSampler;
  /** OcclusionTest SOA storage buffers (one per sphere component). */
  sphereCenterXBuffer: GPUBuffer;
  sphereCenterYBuffer: GPUBuffer;
  sphereCenterZBuffer: GPUBuffer;
  sphereRadiusBuffer: GPUBuffer;
  /** OcclusionTest params UBO (view-proj + screen dims + counts). */
  occlusionParamsBuffer: GPUBuffer;
  /** Visibility output — one u32 per command (0 = occluded, 1 = visible). */
  visibilityBuffer: GPUBuffer;
  /** Staging buffer for async readback of visibility. */
  stagingBuffer: GPUBuffer;
  /** Occlusion test bind group — rebuilt when a sphere buffer is re-allocated. */
  occlusionBindGroup: GPUBindGroup;
  /** Width of the input depth texture (mip 0). */
  inputWidth: number;
  /** Height of the input depth texture. */
  inputHeight: number;
  /** Number of Hi-Z mip levels (including mip 0 in the input). */
  totalMipLevels: number;
  /** Max commands the SOA buffers were sized for. */
  maxCommands: number;
}

/**
 * Round `n` down to the next lower power of two mip-compatible size.
 * Hi-Z pyramid mips halve each dimension; the helper just clamps to a
 * minimum of 1.
 */
function halveDim(n: number): number {
  return Math.max(1, n >> 1);
}

/**
 * Compute the total mip count that a `width × height` input pyramid
 * reduces to before it bottoms out at a 1×1 texel.
 */
function computeMipLevels(
  width: number,
  height: number,
  maxLevels: number,
): number {
  let w = width;
  let h = height;
  let count = 1;
  while ((w > 1 || h > 1) && count < maxLevels) {
    w = halveDim(w);
    h = halveDim(h);
    count++;
  }
  return count;
}

class WebGPUHiZOcclusionDispatcher {
  private _device: GPUDevice;
  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — captured at init time.
  private _computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null;

  /**
   * Pipeline-cache injection point. Set before `allocate()`.
   * C-R7-COMPUTE-PIPELINE-CACHE (Batch 76).
   */
  _setComputePipelineCache(
    cache:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null,
  ): void {
    this._computePipelineCache = cache;
  }
  private _resources: HiZOcclusionResources | null = null;
  private _hiZShaderModule: GPUShaderModule | null = null;
  private _hiZFromDepthShaderModule: GPUShaderModule | null = null;
  private _occlusionShaderModule: GPUShaderModule | null = null;
  // Diagnostic counters.
  private _hiZBuilds = 0;
  private _hiZBuildsSkipped = 0;
  private _occlusionDispatches = 0;
  private _successfulReadbacks = 0;
  private _failedReadbacks = 0;
  private _inFlightReadback = false;
  // B210-D1 (Batch 213) — track which frame the pyramid was last
  // built for. Per-frustum dispatches in the same frame share the
  // same depth texture and can reuse the previously-built pyramid.
  // -1 sentinel means "not built yet this session".
  private _lastBuiltFrameId: number = -1;
  // Reused scratch arrays for per-frame UBO uploads.
  private _hiZParamsScratch = new Uint32Array(8);
  private _occlusionParamsScratch = new ArrayBuffer(OCCLUSION_PARAMS_BYTES);
  private _occlusionParamsFloats: Float32Array;
  private _occlusionParamsU32: Uint32Array;

  constructor(device: GPUDevice) {
    this._device = device;
    this._occlusionParamsFloats = new Float32Array(
      this._occlusionParamsScratch,
    );
    this._occlusionParamsU32 = new Uint32Array(this._occlusionParamsScratch);
  }

  /**
   * Inject the HiZPyramid.wgsl source. Called once on first use from
   * `OcclusionCulling.initialize()`. The shader module is cached for
   * the lifetime of the dispatcher.
   */
  setHiZShaderSource(wgsl: string): void {
    if (this._hiZShaderModule) return;
    this._hiZShaderModule = this._device.createShaderModule({
      label: "HiZPyramid_Shader",
      code: wgsl,
    });
  }

  /**
   * Inject the HiZPyramidFromDepth.wgsl source — the variant that reads
   * `texture_depth_2d` (sampleType "depth") so mip 0 can be built
   * directly from the native depth attachment without a format copy.
   */
  setHiZFromDepthShaderSource(wgsl: string): void {
    if (this._hiZFromDepthShaderModule) return;
    this._hiZFromDepthShaderModule = this._device.createShaderModule({
      label: "HiZPyramidFromDepth_Shader",
      code: wgsl,
    });
  }

  /**
   * Inject the OcclusionTest.wgsl source.
   */
  setOcclusionShaderSource(wgsl: string): void {
    if (this._occlusionShaderModule) return;
    this._occlusionShaderModule = this._device.createShaderModule({
      label: "OcclusionTest_Shader",
      code: wgsl,
    });
  }

  /**
   * Whether both shader modules have been injected. Until this
   * returns true, `allocate()` cannot create the pipelines and
   * `buildHiZPyramid` / `dispatchOcclusionTest` are no-ops.
   */
  get shadersReady(): boolean {
    return !!this._hiZShaderModule && !!this._occlusionShaderModule;
  }

  /**
   * Diagnostic snapshot for the central debug surface.
   */
  getStatistics(): {
    allocated: boolean;
    shadersReady: boolean;
    hiZBuilds: number;
    occlusionDispatches: number;
    successfulReadbacks: number;
    failedReadbacks: number;
    inFlightReadback: boolean;
    inputWidth: number;
    inputHeight: number;
    mipLevels: number;
    maxCommands: number;
  } {
    return {
      allocated: !!this._resources,
      shadersReady: this.shadersReady,
      hiZBuilds: this._hiZBuilds,
      occlusionDispatches: this._occlusionDispatches,
      successfulReadbacks: this._successfulReadbacks,
      failedReadbacks: this._failedReadbacks,
      inFlightReadback: this._inFlightReadback,
      inputWidth: this._resources?.inputWidth ?? 0,
      inputHeight: this._resources?.inputHeight ?? 0,
      mipLevels: this._resources?.totalMipLevels ?? 0,
      maxCommands: this._resources?.maxCommands ?? 0,
    };
  }

  /**
   * Allocate or reallocate GPU resources for a depth buffer of the given
   * dimensions and a maximum command count. Called from
   * `OcclusionCulling.initialize()` and again whenever the viewport
   * resizes.
   *
   * Returns true on success, false if the shader modules aren't loaded
   * or the device is missing a required feature.
   */
  allocate(
    inputWidth: number,
    inputHeight: number,
    maxCommands: number,
    maxMipLevels: number = 12,
  ): boolean {
    if (!this.shadersReady) return false;
    if (inputWidth <= 0 || inputHeight <= 0 || maxCommands <= 0) return false;

    // Already allocated for this exact configuration — reuse.
    if (
      this._resources &&
      this._resources.inputWidth === inputWidth &&
      this._resources.inputHeight === inputHeight &&
      this._resources.maxCommands >= maxCommands
    ) {
      return true;
    }

    this.destroy();

    const device = this._device;
    const totalMipLevels = computeMipLevels(
      inputWidth,
      inputHeight,
      maxMipLevels,
    );

    // ── Hi-Z pyramid texture ──
    // The pyramid starts at half the input resolution (mip 0 of the
    // pyramid corresponds to mip 1 of the input depth), so the texture
    // dimensions are halved once up front. The total number of mips
    // stored here is therefore `totalMipLevels - 1`.
    const pyramidWidth = halveDim(inputWidth);
    const pyramidHeight = halveDim(inputHeight);
    const pyramidMips = Math.max(1, totalMipLevels - 1);

    const hiZTexture = device.createTexture({
      label: "HiZ_Pyramid",
      size: {
        width: pyramidWidth,
        height: pyramidHeight,
        depthOrArrayLayers: 1,
      },
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      mipLevelCount: pyramidMips,
    });

    const hiZSampleView = hiZTexture.createView({
      label: "HiZ_Pyramid_SampleView",
      dimension: "2d",
      baseMipLevel: 0,
      mipLevelCount: pyramidMips,
    });

    // NON-filtering sampler. `Occlusion_BGL` binding(2) is declared
    // `"non-filtering"` and the Hi-Z texture (binding 1) is
    // `unfilterable-float`, so a linear/filtering sampler here is a double
    // WebGPU validation violation (filtering sampler in a non-filtering slot
    // AND filtering an unfilterable-float texture) — a Wave-0 P0 cause. The
    // occlusion test is the only consumer of this sampler (the pyramid build
    // uses textureLoad, no sampler), and conservative max-depth occlusion
    // wants point sampling anyway, so `nearest` is both correct and required.
    const hiZSampler = device.createSampler({
      label: "HiZ_Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
    });

    // ── Hi-Z bind group layout ──
    // Mirrors HiZPyramid.wgsl:
    //   @binding(0) depthInput: texture_2d<f32>
    //   @binding(1) hiZOutput:  texture_storage_2d<r32float, write>
    //   @binding(2) params:     uniform HiZParams
    const hiZBindGroupLayout = makeBindGroupLayout(device, "HiZ_BGL", [
      texture(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
      storageTexture(1, Stage.COMPUTE, "r32float"),
      uniformBuffer(2, Stage.COMPUTE),
    ]);

    // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — central cache routing.
    const computeCache = this._computePipelineCache;
    const hiZLayout = device.createPipelineLayout({
      bindGroupLayouts: [hiZBindGroupLayout],
    });
    const hiZPipeline = computeCache
      ? computeCache.getOrCreateSync({
          name: "HiZ_Pipeline",
          layout: hiZLayout,
          compute: {
            module: this._hiZShaderModule!,
            entryPoint: "computeMain",
          },
        })
      : device.createComputePipeline({
          label: "HiZ_Pipeline",
          layout: hiZLayout,
          compute: {
            module: this._hiZShaderModule!,
            entryPoint: "computeMain",
          },
        });

    // ── Depth-format mip 0 pipeline (optional) ──
    // When the caller passes a native depth texture view (aspect
    // "depth-only" from a depth24plus-stencil8 attachment), the bind
    // group layout must use sampleType "depth" and the WGSL shader
    // must declare texture_depth_2d. This avoids a full-resolution
    // depth → r32float copy every frame.
    let hiZFromDepthBindGroupLayout: GPUBindGroupLayout | null = null;
    let hiZFromDepthPipeline: GPUComputePipeline | null = null;
    if (this._hiZFromDepthShaderModule) {
      hiZFromDepthBindGroupLayout = makeBindGroupLayout(
        device,
        "HiZ_FromDepth_BGL",
        [
          texture(0, Stage.COMPUTE, { sampleType: "depth" }),
          storageTexture(1, Stage.COMPUTE, "r32float"),
          uniformBuffer(2, Stage.COMPUTE),
        ],
      );
      const hiZFromDepthLayout = device.createPipelineLayout({
        bindGroupLayouts: [hiZFromDepthBindGroupLayout],
      });
      hiZFromDepthPipeline = computeCache
        ? computeCache.getOrCreateSync({
            name: "HiZ_FromDepth_Pipeline",
            layout: hiZFromDepthLayout,
            compute: {
              module: this._hiZFromDepthShaderModule,
              entryPoint: "computeMain",
            },
          })
        : device.createComputePipeline({
            label: "HiZ_FromDepth_Pipeline",
            layout: hiZFromDepthLayout,
            compute: {
              module: this._hiZFromDepthShaderModule,
              entryPoint: "computeMain",
            },
          });
    }

    // ── Per-mip bind groups for the pyramid build ──
    // Mip 0 of the pyramid consumes the input depth texture; every
    // subsequent pyramid mip consumes the previous pyramid mip. Bind
    // groups that reference the input depth are created lazily at
    // dispatch time because the depth texture view changes every
    // frame (it's owned by the caller).
    const mipLevels: HiZMipLevel[] = [];
    for (let m = 0; m < pyramidMips; m++) {
      const outputWidth = Math.max(1, pyramidWidth >> m);
      const outputHeight = Math.max(1, pyramidHeight >> m);
      const outputView = hiZTexture.createView({
        label: `HiZ_Pyramid_Mip${m}_Out`,
        dimension: "2d",
        baseMipLevel: m,
        mipLevelCount: 1,
      });
      const paramsBuffer = device.createBuffer({
        label: `HiZ_Params_Mip${m}`,
        size: HI_Z_PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      // `bindGroup` is built lazily per frame in `_getOrBuildMipBindGroup`
      // because it holds a reference to the input texture view.
      mipLevels.push({
        bindGroup: null,
        outputView,
        paramsBuffer,
        width: outputWidth,
        height: outputHeight,
      });
    }

    // ── Occlusion test resources ──
    // Mirrors OcclusionTest.wgsl:
    //   @binding(0) params: uniform OcclusionParams
    //   @binding(1) hiZTexture: texture_2d<f32>
    //   @binding(2) hiZSampler: sampler
    //   @binding(3..6) sphereCenter[X/Y/Z]/Radius: storage<read>
    //   @binding(7) visibility: storage<read_write>
    const occlusionBindGroupLayout = makeBindGroupLayout(
      device,
      "Occlusion_BGL",
      [
        uniformBuffer(0, Stage.COMPUTE),
        texture(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
        sampler(2, Stage.COMPUTE, "non-filtering"),
        storageBuffer(3, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(4, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(5, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(6, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(7, Stage.COMPUTE),
      ],
    );

    const occlusionLayout = device.createPipelineLayout({
      bindGroupLayouts: [occlusionBindGroupLayout],
    });
    const occlusionPipeline = computeCache
      ? computeCache.getOrCreateSync({
          name: "Occlusion_Pipeline",
          layout: occlusionLayout,
          compute: {
            module: this._occlusionShaderModule!,
            entryPoint: "computeMain",
          },
        })
      : device.createComputePipeline({
          label: "Occlusion_Pipeline",
          layout: occlusionLayout,
          compute: {
            module: this._occlusionShaderModule!,
            entryPoint: "computeMain",
          },
        });

    const sphereBufferBytes = maxCommands * 4;
    const makeSphereBuffer = (label: string) =>
      device.createBuffer({
        label,
        size: sphereBufferBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    const sphereCenterXBuffer = makeSphereBuffer("Occlusion_SphereCenterX");
    const sphereCenterYBuffer = makeSphereBuffer("Occlusion_SphereCenterY");
    const sphereCenterZBuffer = makeSphereBuffer("Occlusion_SphereCenterZ");
    const sphereRadiusBuffer = makeSphereBuffer("Occlusion_SphereRadius");

    const occlusionParamsBuffer = device.createBuffer({
      label: "Occlusion_Params",
      size: OCCLUSION_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const visibilityBuffer = device.createBuffer({
      label: "Occlusion_Visibility",
      size: maxCommands * 4,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    const stagingBuffer = device.createBuffer({
      label: "Occlusion_VisibilityStaging",
      size: maxCommands * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const occlusionBindGroup = device.createBindGroup({
      label: "Occlusion_BG",
      layout: occlusionBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: occlusionParamsBuffer } },
        { binding: 1, resource: hiZSampleView },
        { binding: 2, resource: hiZSampler },
        { binding: 3, resource: { buffer: sphereCenterXBuffer } },
        { binding: 4, resource: { buffer: sphereCenterYBuffer } },
        { binding: 5, resource: { buffer: sphereCenterZBuffer } },
        { binding: 6, resource: { buffer: sphereRadiusBuffer } },
        { binding: 7, resource: { buffer: visibilityBuffer } },
      ],
    });

    this._resources = {
      boundDepthTextureView: null,
      depthMip0View: null,
      hiZTexture,
      hiZSampleView,
      mipLevels,
      hiZPipeline,
      hiZFromDepthPipeline,
      occlusionPipeline,
      hiZBindGroupLayout,
      hiZFromDepthBindGroupLayout,
      occlusionBindGroupLayout,
      hiZSampler,
      sphereCenterXBuffer,
      sphereCenterYBuffer,
      sphereCenterZBuffer,
      sphereRadiusBuffer,
      occlusionParamsBuffer,
      visibilityBuffer,
      stagingBuffer,
      occlusionBindGroup,
      inputWidth,
      inputHeight,
      totalMipLevels,
      maxCommands,
    };
    return true;
  }

  /**
   * Bind the current frame's depth texture as the mip-0 input for the
   * Hi-Z pyramid build. Must be called before `buildHiZPyramid`.
   *
   * The dispatcher keeps a reference to the view, not the underlying
   * texture, so the caller is responsible for ensuring the texture
   * stays alive for the duration of the frame.
   */
  setDepthTexture(depthTextureView: GPUTextureView): void {
    if (!this._resources) return;
    this._resources.boundDepthTextureView = depthTextureView;
    // The depth view passed in is expected to be a full mip-0 view
    // of the source depth texture. Store it directly — the per-mip
    // bind groups reference it.
    this._resources.depthMip0View = depthTextureView;
  }

  /**
   * Encode the per-mip Hi-Z pyramid build into the given command
   * encoder. Must be called after `setDepthTexture`. No-op when
   * the dispatcher isn't allocated or shaders aren't loaded.
   *
   * **B210-D1 (Batch 213)** — pass `frameId` to dedupe the rebuild
   * across multiple per-frustum dispatch calls in the same frame.
   * The depth texture is shared across frustums so the pyramid is
   * frame-stable; rebuilding 3× per frame for a 3-frustum scene was
   * pure waste. Pass the same `frameId` from every call site in a
   * given frame; the second call onward is a fast no-op that bumps
   * `_hiZBuildsSkipped`. Pass -1 to force a rebuild (e.g., after
   * the depth texture changes mid-frame).
   */
  buildHiZPyramid(encoder: GPUCommandEncoder, frameId: number = -1): boolean {
    const r = this._resources;
    if (!r || !r.boundDepthTextureView || !this.shadersReady) return false;

    // Dedupe within the same frame.
    if (frameId >= 0 && this._lastBuiltFrameId === frameId) {
      this._hiZBuildsSkipped++;
      return true;
    }

    for (let m = 0; m < r.mipLevels.length; m++) {
      const mip = r.mipLevels[m];
      // Mip 0 of the pyramid samples the input depth; subsequent mips
      // sample the previous pyramid mip.
      const inputView =
        m === 0
          ? r.boundDepthTextureView
          : r.hiZTexture.createView({
              label: `HiZ_Pyramid_Mip${m - 1}_In`,
              dimension: "2d",
              baseMipLevel: m - 1,
              mipLevelCount: 1,
            });

      // Upload per-mip params.
      // HiZParams.mipLevel is 0 for the shader (textureLoad expects a
      // mip index relative to the bound view, and each per-mip bind
      // group binds exactly one mip as input — so mipLevel is always
      // the 0 of that single-mip view).
      this._hiZParamsScratch[0] =
        m === 0 ? r.inputWidth : r.mipLevels[m - 1].width;
      this._hiZParamsScratch[1] =
        m === 0 ? r.inputHeight : r.mipLevels[m - 1].height;
      this._hiZParamsScratch[2] = mip.width;
      this._hiZParamsScratch[3] = mip.height;
      this._hiZParamsScratch[4] = 0; // mipLevel relative to single-mip input view
      this._hiZParamsScratch[5] = 0;
      this._hiZParamsScratch[6] = 0;
      this._hiZParamsScratch[7] = 0;
      this._device.queue.writeBuffer(
        mip.paramsBuffer,
        0,
        this._hiZParamsScratch.buffer,
      );

      // For mip 0, use the depth-format pipeline when available (reads
      // texture_depth_2d directly from the scene depth attachment). For
      // mips 1+, use the standard r32float pipeline.
      const useDepthPipeline =
        m === 0 && r.hiZFromDepthPipeline && r.hiZFromDepthBindGroupLayout;
      const layout = useDepthPipeline
        ? r.hiZFromDepthBindGroupLayout!
        : r.hiZBindGroupLayout;
      const pipeline = useDepthPipeline
        ? r.hiZFromDepthPipeline!
        : r.hiZPipeline;

      const bg = this._device.createBindGroup({
        label: `HiZ_BG_Mip${m}`,
        layout,
        entries: [
          { binding: 0, resource: inputView },
          { binding: 1, resource: mip.outputView },
          { binding: 2, resource: { buffer: mip.paramsBuffer } },
        ],
      });
      mip.bindGroup = bg;

      const workgroupsX = Math.ceil(mip.width / 16);
      const workgroupsY = Math.ceil(mip.height / 16);
      const pass = encoder.beginComputePass({
        label: `HiZ_Pass_Mip${m}`,
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
      pass.end();
    }
    this._hiZBuilds++;
    this._lastBuiltFrameId = frameId;
    return true;
  }

  /**
   * Upload SOA sphere data + OcclusionParams, encode the occlusion
   * test compute pass, and schedule an async readback of the
   * visibility buffer. Must be called after `buildHiZPyramid`.
   *
   * @param encoder Active command encoder.
   * @param soa The SOA bounding sphere layout (Float32Arrays).
   * @param params View-projection + screen dims + near/far.
   */
  dispatchOcclusionTest(
    encoder: GPUCommandEncoder,
    soa: {
      centerX: Float32Array;
      centerY: Float32Array;
      centerZ: Float32Array;
      radius: Float32Array;
      count: number;
    },
    params: {
      viewProjection: ArrayLike<number>;
      screenWidth: number;
      screenHeight: number;
      nearPlane: number;
      farPlane: number;
    },
  ): boolean {
    const r = this._resources;
    if (!r || !this.shadersReady) return false;
    if (soa.count <= 0 || soa.count > r.maxCommands) return false;

    const device = this._device;
    // Upload SOA — one queue.writeBuffer per component, sub-range so
    // we don't overshoot on small command counts.
    const byteLen = soa.count * 4;
    device.queue.writeBuffer(
      r.sphereCenterXBuffer,
      0,
      soa.centerX.buffer,
      soa.centerX.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.sphereCenterYBuffer,
      0,
      soa.centerY.buffer,
      soa.centerY.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.sphereCenterZBuffer,
      0,
      soa.centerZ.buffer,
      soa.centerZ.byteOffset,
      byteLen,
    );
    device.queue.writeBuffer(
      r.sphereRadiusBuffer,
      0,
      soa.radius.buffer,
      soa.radius.byteOffset,
      byteLen,
    );

    // Pack OcclusionParams.
    const f = this._occlusionParamsFloats;
    for (let i = 0; i < 16; i++) {
      f[i] = params.viewProjection[i];
    }
    f[16] = params.screenWidth;
    f[17] = params.screenHeight;
    f[18] = params.nearPlane;
    f[19] = params.farPlane;
    this._occlusionParamsU32[20] = r.totalMipLevels;
    this._occlusionParamsU32[21] = soa.count;
    this._occlusionParamsU32[22] = 0;
    this._occlusionParamsU32[23] = 0;
    device.queue.writeBuffer(
      r.occlusionParamsBuffer,
      0,
      this._occlusionParamsScratch,
    );

    const workgroupsX = Math.ceil(soa.count / 256);
    const pass = encoder.beginComputePass({
      label: "Occlusion_Pass",
    });
    pass.setPipeline(r.occlusionPipeline);
    pass.setBindGroup(0, r.occlusionBindGroup);
    pass.dispatchWorkgroups(workgroupsX, 1, 1);
    pass.end();

    // Copy visibility → staging so the CPU can map it next frame.
    // Only copy the range we actually wrote.
    encoder.copyBufferToBuffer(
      r.visibilityBuffer,
      0,
      r.stagingBuffer,
      0,
      soa.count * 4,
    );
    this._occlusionDispatches++;
    return true;
  }

  /**
   * Map the staging buffer and read the visibility results. Returns
   * `null` when no test has been dispatched yet or when a previous
   * readback is still in-flight (the dispatcher avoids two concurrent
   * map calls).
   *
   * The returned array holds one u32 per command: 0 = occluded,
   * nonzero = visible. The caller converts that to the `Uint8Array`
   * that `SOABoundingSphereLayout.visibility` expects.
   */
  async readbackVisibility(count: number): Promise<Uint32Array | null> {
    const r = this._resources;
    if (!r) return null;
    if (this._inFlightReadback) return null;
    if (count <= 0) return null;
    this._inFlightReadback = true;
    try {
      await r.stagingBuffer.mapAsync(
        GPUMapMode.READ,
        0,
        Math.min(count * 4, r.maxCommands * 4),
      );
      const mapped = r.stagingBuffer.getMappedRange(0, count * 4);
      const out = new Uint32Array(count);
      out.set(new Uint32Array(mapped));
      r.stagingBuffer.unmap();
      this._successfulReadbacks++;
      return out;
    } catch (_e) {
      this._failedReadbacks++;
      return null;
    } finally {
      this._inFlightReadback = false;
    }
  }

  /**
   * Release all GPU resources. Idempotent.
   */
  destroy(): void {
    const r = this._resources;
    if (!r) return;
    try {
      r.hiZTexture.destroy();
      r.sphereCenterXBuffer.destroy();
      r.sphereCenterYBuffer.destroy();
      r.sphereCenterZBuffer.destroy();
      r.sphereRadiusBuffer.destroy();
      r.occlusionParamsBuffer.destroy();
      r.visibilityBuffer.destroy();
      r.stagingBuffer.destroy();
      for (const mip of r.mipLevels) {
        mip.paramsBuffer.destroy();
      }
    } catch (_e) {
      // Defensive — second destroy() is a no-op.
    }
    this._resources = null;
  }
}

// ─── Feature renderer factory + entry points ───────────────────────
//
// One dispatcher instance per WebGPUContext, cached in a WeakMap so
// the consumer doesn't have to thread the reference through. The
// factory also loads the shader sources on first use so the WGSL
// stays in `Source/Shaders/WebGPU/Compute/` and the build pipeline
// owns the JS-wrapper generation.

// `any` on the imports because the generated JS wrappers don't have
// d.ts types. They're plain string exports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import HiZPyramidSource from "../../Shaders/WebGPU/Compute/HiZPyramid.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import HiZPyramidFromDepthSource from "../../Shaders/WebGPU/Compute/HiZPyramidFromDepth.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import OcclusionTestSource from "../../Shaders/WebGPU/Compute/OcclusionTest.js";
import {
  makeBindGroupLayout,
  sampler,
  storageBuffer,
  storageTexture,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const _instances = new WeakMap<object, WebGPUHiZOcclusionDispatcher>();

function getOrCreateDispatcher(context: {
  device: GPUDevice | null | undefined;
}): WebGPUHiZOcclusionDispatcher | null {
  if (!context || !context.device) return null;
  let inst = _instances.get(context);
  if (!inst) {
    inst = new WebGPUHiZOcclusionDispatcher(context.device);
    inst.setHiZShaderSource(HiZPyramidSource);
    inst.setHiZFromDepthShaderSource(HiZPyramidFromDepthSource);
    inst.setOcclusionShaderSource(OcclusionTestSource);
    _instances.set(context, inst);
  }
  return inst;
}

/**
 * Feature renderer entry point: lazily allocate the dispatcher's GPU
 * resources for a given depth buffer size + command cap. Called from
 * `OcclusionCulling.initialize()` on the Scene side via the feature
 * renderer registry.
 */
function initWebGPUHiZOcclusion(
  context: {
    device: GPUDevice | null | undefined;
    webgpuComputePipelineCache?:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null;
  },
  inputWidth: number,
  inputHeight: number,
  maxCommands: number,
): boolean {
  const inst = getOrCreateDispatcher(context);
  if (!inst) return false;
  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76).
  inst._setComputePipelineCache(context.webgpuComputePipelineCache ?? null);
  return inst.allocate(inputWidth, inputHeight, maxCommands);
}

/**
 * Feature renderer entry point: run one frame of Hi-Z pyramid build
 * + occlusion test. Returns true when the compute passes were
 * recorded, false when the dispatcher isn't allocated.
 *
 * The caller provides:
 *   - `encoder` — active GPU command encoder
 *   - `depthTextureView` — mip-0 view of the current frame's depth
 *   - `soa` — SOABoundingSphereLayout arrays
 *   - `params` — view-projection + screen dims + near/far
 *   - `frameId` (optional) — pass the same frame counter from every
 *     call site in a given frame so the pyramid build dedupes (B210-D1
 *     fix, Batch 213). Omit to force a rebuild every call (legacy).
 */
function dispatchWebGPUHiZOcclusion(
  context: { device: GPUDevice | null | undefined },
  encoder: GPUCommandEncoder,
  depthTextureView: GPUTextureView,
  soa: {
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    radius: Float32Array;
    count: number;
  },
  params: {
    viewProjection: ArrayLike<number>;
    screenWidth: number;
    screenHeight: number;
    nearPlane: number;
    farPlane: number;
  },
  frameId?: number,
): boolean {
  const inst = _instances.get(context);
  if (!inst) return false;
  inst.setDepthTexture(depthTextureView);
  const ok = inst.buildHiZPyramid(encoder, frameId ?? -1);
  if (!ok) return false;
  return inst.dispatchOcclusionTest(encoder, soa, params);
}

/**
 * Feature renderer entry point: async readback of the visibility
 * results from the last dispatched occlusion test. Returns `null`
 * when the dispatcher isn't allocated or a readback is in flight.
 */
function readbackWebGPUHiZOcclusion(
  context: { device: GPUDevice | null | undefined },
  count: number,
): Promise<Uint32Array | null> {
  const inst = _instances.get(context);
  if (!inst) return Promise.resolve(null);
  return inst.readbackVisibility(count);
}

/**
 * Feature renderer entry point: return the per-context diagnostic
 * snapshot. Null when no dispatcher is allocated for this context.
 */
function getWebGPUHiZOcclusionStatistics(context: {
  device: GPUDevice | null | undefined;
}): ReturnType<WebGPUHiZOcclusionDispatcher["getStatistics"]> | null {
  const inst = _instances.get(context);
  return inst ? inst.getStatistics() : null;
}

/**
 * Feature renderer destroy entry point. Releases all GPU resources
 * for the given context's dispatcher instance.
 */
function destroyWebGPUHiZOcclusion(context: {
  device: GPUDevice | null | undefined;
}): void {
  const inst = _instances.get(context);
  if (inst) {
    inst.destroy();
    _instances.delete(context);
  }
}

export {
  WebGPUHiZOcclusionDispatcher,
  computeMipLevels,
  halveDim,
  HI_Z_PARAMS_BYTES,
  OCCLUSION_PARAMS_BYTES,
  initWebGPUHiZOcclusion,
  dispatchWebGPUHiZOcclusion,
  readbackWebGPUHiZOcclusion,
  getWebGPUHiZOcclusionStatistics,
  destroyWebGPUHiZOcclusion,
};
export default WebGPUHiZOcclusionDispatcher;
