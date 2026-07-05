/**
 * GPU compute processor that filters a large point cloud down to a
 * compacted list of currently-visible points. Replaces per-frame CPU
 * iteration across millions of points with a single compute dispatch
 * that does frustum culling + distance-based LOD selection + screen-
 * space density decimation in one pass.
 *
 * ## Relationship to Cesium's existing LOD
 *
 * This is a **new WebGPU-only enhancement**, not a port of a WebGL
 * feature. Cesium's WebGL path uses tile-level LOD via 3D Tiles's
 * geometric-error tree (see Cesium3DTile.getScreenSpaceError) — all
 * LOD math runs on the CPU in JavaScript (f64), then each loaded
 * tile's points are drawn in full. There is no per-point culling on
 * the WebGL path.
 *
 * The processor here adds a *second* LOD layer **within** a tile
 * (or across a monolithic, non-tiled point cloud like a raw LAS
 * load). It's valuable when:
 *   - A pnts tile is large enough that drawing all its points is
 *     wasteful for far views.
 *   - The user loads a standalone PointCloud primitive not backed by
 *     3D Tiles.
 *
 * It's NOT a replacement for tile-level LOD. When a point cloud is
 * delivered as 3D Tiles, tile-level LOD still runs first (CPU/f64/
 * precise at any scale); this processor just further culls within a
 * loaded tile.
 *
 * ## Precision
 *
 * Positions are stored as f32 SOA arrays and the distance² math in
 * the shader is f32. For **all realistic use cases** this is enough:
 *   - LiDAR / photogrammetry scans: ≤1km range. f32 gives sub-mm
 *     precision.
 *   - pnts tiles: bounding radius < 1km typical. Same.
 *
 * The pathological case is a single point cloud spanning planetary
 * distances, where f32 distance² loses precision beyond ~10M meters.
 * This case doesn't arise in practice — global point clouds are
 * always tiled, so the LOD processor only ever sees the contents of
 * one bounded tile. If that assumption ever breaks, the fix is to
 * pass `cameraHigh + cameraLow` (two vec3s) and do the RTE subtract
 * in the shader — ~20 LOC spike.
 *
 * ## Architecture
 *
 *   - Owns three persistent storage buffers: SOA positions (xyz in
 *     separate arrays for coalesced reads), a compacted visibleIndices
 *     output, and a 1×u32 atomic `visibleCount`.
 *   - Storage buffers grow dynamically in `_ensurePositionBuffers` on
 *     each uploadPositions — no pre-declared cap.
 *   - Wraps `PointCloudLOD.wgsl`, which ships two entry points: a
 *     portable `computeMain` and a subgroup-accelerated
 *     `computeMainSubgroups` variant that collapses the per-lane
 *     atomicAdd into one atomicAdd per subgroup. The processor picks
 *     the fast path on devices that expose the "subgroups" feature
 *     and falls back to `computeMain` otherwise.
 *   - Host-side preprocessor strips the __SUBGROUP_BLOCK_*__ section
 *     of the shader source when subgroups are unavailable (mirrors
 *     the WebGPUGPUCuller pattern) so non-capable devices never see
 *     an invalid `subgroupBallot` call.
 *
 * ## Usage from a point cloud renderer
 *
 *   const lod = new WebGPUPointCloudLODProcessor(device);
 *   await lod.initialize();
 *   // Once per point set:
 *   lod.uploadPositions(posX, posY, posZ);
 *   // Each frame:
 *   lod.dispatch(encoder, { cameraPositionWC, frustumPlanes, ... });
 *   // The indirect draw buffer of the point renderer reads
 *   // `lod.visibleCountBuffer` for the vertex count.
 *
 * @see PointCloudLOD.wgsl (shader source)
 * @see WebGPUGPUCuller (same subgroup preprocessor pattern)
 * @see Cesium3DTile.getScreenSpaceError (tile-level LOD, complementary)
 * @module WebGPUPointCloudLODProcessor
 */

/// <reference types="@webgpu/types" />

import { gpuData } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  trackComputePipelineCreation,
  type AsyncResourceMonitor,
} from "./AsyncResourceMonitor.js";
import PointCloudLODShader from "../../Shaders/WebGPU/Compute/PointCloudLOD.js";
import PointCloudLODScanCompactShader from "../../Shaders/WebGPU/Compute/PointCloudLODScanCompact.js";
import DecoupledLookbackScanShader from "../../Shaders/WebGPU/Compute/DecoupledLookbackScan.js";
import { WebGPUDecoupledScan } from "./WebGPUDecoupledScan.js";

/**
 * LOD band thresholds + budget. Distances are measured squared (matches
 * the WGSL uniform layout) so the shader can compare without sqrt.
 */
export interface PointCloudLODDispatchParams {
  /** Camera position in world coordinates */
  cameraPositionWC: [number, number, number];
  /** Distance² beyond which all points are culled */
  lod3Distance2: number;
  /** Distance² → LOD 2 (1/16 keep rate) */
  lod2Distance2: number;
  /** Distance² → LOD 1 (1/4 keep rate) */
  lod1Distance2: number;
  /** Distance² within which full detail is kept */
  lod0Distance2: number;
  /**
   * Six frustum planes as Cartesian4 (x,y,z = normal, w = -distance).
   * Must be in world space to match the positionsX/Y/Z coords.
   */
  frustumPlanes: Float32Array | number[]; // 24 floats (6 × vec4)
  /** Total number of points to process */
  pointCount: number;
  /** Max points to output — hard cap to prevent overdraw */
  maxVisiblePoints: number;
  /** Target minimum pixel spacing for density control */
  screenSpaceRadius?: number;
  /** Tile's geometric error (3D Tiles) for LOD refinement */
  geometricError?: number;
}

export interface PointCloudLODProcessorOptions {
  /**
   * Label prefix for GPU-debug tooling. Pass a context-scoped string so
   * debugging tools can tell per-context instances apart.
   */
  label?: string;
  /** NEW-WEBGPU-PIPELINE-READY-SIGNAL — async resource monitor. */
  asyncResourceMonitor?: AsyncResourceMonitor | null;
  /**
   * When true, compact visible points using a decoupled-lookback parallel
   * prefix scan instead of the default per-workgroup atomicAdd path.
   * Produces a DETERMINISTIC output ordering (visibleIndices is always
   * sorted by original point index) at the cost of one extra compute
   * pass and two extra storage buffers per capacity unit.
   *
   * Turn this on when the consumer depends on stable ordering — e.g.
   * GPU-driven picking against a compacted list, persistent point
   * selection buffers across frames, or split-screen / multi-view
   * passes that must produce identical index streams.
   *
   * Default: false (keeps atomic-add path; lowest memory + overhead).
   * See PointCloudLODScanCompact.wgsl for the shader side.
   */
  useDecoupledScan?: boolean;
}

/**
 * Structural contract between the WebGPU context and whatever consumer
 * wants to dispatch the LOD processor. Declared as an interface (not
 * just `typeof WebGPUPointCloudLODProcessor`) so the context can stash
 * an instance without importing the compute-heavy class — keeping the
 * processor out of bundles that never render point clouds.
 *
 * The `WebGPUPointCloudLODProcessor` class below declares
 * `implements WebGPUPointCloudLODProcessorInstance` so adding a new
 * public method forces an update to the interface at the same time —
 * consumers of the interface won't drift away from reality silently.
 */
export interface WebGPUPointCloudLODProcessorInstance {
  readonly isReady: boolean;
  readonly visibleCountBuffer: GPUBuffer | null;
  readonly visibleIndicesBuffer: GPUBuffer | null;
  uploadPositions(
    posX: Float32Array,
    posY: Float32Array,
    posZ: Float32Array,
  ): void;
  dispatch(
    encoder: GPUCommandEncoder,
    params: PointCloudLODDispatchParams,
  ): void;
  destroy(): void;
}

// Note: storage buffers grow dynamically via `_ensurePositionBuffers`
// on every uploadPositions call — no fixed cap. A prior `maxPoints`
// option was removed because it was stored but never read; the real
// memory cost is proportional to the incoming point count, not to any
// pre-declared cap.

// Layout MUST match `struct LODParams` in PointCloudLOD.wgsl.
// 36 floats / u32s = 144 bytes, padded to 256 for UBO alignment.
const PARAMS_FLOATS = 36;
const PARAMS_BYTES = 256;
const WORKGROUP_SIZE = 256;

/**
 * Pre-compiled pipeline pair so we can fall back at dispatch time if
 * the subgroup variant errors (driver edge cases on some cards).
 */
interface CompiledPipelines {
  main: GPUComputePipeline;
  mainSubgroups?: GPUComputePipeline;
  preferredEntryPoint: "computeMain" | "computeMainSubgroups";
}

export class WebGPUPointCloudLODProcessor implements WebGPUPointCloudLODProcessorInstance {
  private _device: GPUDevice;
  private _label: string;
  private _useDecoupledScan: boolean;

  // GPU resources
  private _paramsBuffer: GPUBuffer | null = null;
  private _positionsX: GPUBuffer | null = null;
  private _positionsY: GPUBuffer | null = null;
  private _positionsZ: GPUBuffer | null = null;
  private _visibleIndices: GPUBuffer | null = null;
  private _visibleCount: GPUBuffer | null = null;
  private _positionsCapacity = 0;

  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _pipelines: CompiledPipelines | null = null;
  private _bindGroup: GPUBindGroup | null = null;

  // Scan-path resources (null unless useDecoupledScan: true)
  private _scanBindGroupLayout: GPUBindGroupLayout | null = null;
  private _scanTagPipeline: GPUComputePipeline | null = null;
  private _scanCompactPipeline: GPUComputePipeline | null = null;
  private _scanBindGroup: GPUBindGroup | null = null;
  private _flagsBuffer: GPUBuffer | null = null;
  private _prefixBuffer: GPUBuffer | null = null;
  private _scanner: WebGPUDecoupledScan | null = null;

  // Scratch arrays — reused every dispatch
  private _paramsScratch = new Float32Array(PARAMS_FLOATS);
  private _paramsScratchU32: Uint32Array;

  private _initialized = false;
  private _isDestroyed = false;

  private _monitor: AsyncResourceMonitor | null;

  constructor(device: GPUDevice, options: PointCloudLODProcessorOptions = {}) {
    this._device = device;
    this._label = options.label ?? "PointCloudLOD";
    this._useDecoupledScan = options.useDecoupledScan ?? false;
    this._monitor = options.asyncResourceMonitor ?? null;
    this._paramsScratchU32 = new Uint32Array(
      this._paramsScratch.buffer,
      this._paramsScratch.byteOffset,
      this._paramsScratch.length,
    );
  }

  /**
   * Whether the processor has compiled its pipelines and is ready to
   * accept `uploadPositions` / `dispatch` calls.
   */
  get isReady(): boolean {
    return this._initialized && !this._isDestroyed;
  }

  /**
   * Expose the visible-count atomic buffer so callers can chain it
   * into `drawIndirect`. The first u32 in the buffer is the total
   * number of points the last dispatch passed through.
   */
  get visibleCountBuffer(): GPUBuffer | null {
    return this._visibleCount;
  }

  /**
   * Expose the compacted indices buffer. Point cloud renderers bind
   * this as a storage buffer (read-only) and fetch per-vertex via
   * `visibleIndices[vertex_index]` to get the source point index.
   */
  get visibleIndicesBuffer(): GPUBuffer | null {
    return this._visibleIndices;
  }

  /**
   * Build all GPU resources and compile the compute pipeline(s).
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Detect subgroup support. Mirror the WebGPUGPUCuller pattern — the
    // feature name has stabilized to "subgroups" in recent WebGPU
    // releases; older snapshots used "chromium-experimental-subgroups"
    // which we treat identically.
    const useSubgroups =
      this._device.features.has("subgroups" as GPUFeatureName) ||
      this._device.features.has(
        "chromium-experimental-subgroups" as GPUFeatureName,
      );

    // Host-side preprocessor. The .wgsl file wraps `computeMainSubgroups`
    // in __SUBGROUP_BLOCK_START__ / END sentinel comments AND deliberately
    // omits the `enable subgroups;` directive (WGSL parse error to have
    // one after the first global decl). We either prepend it or strip
    // the entire block depending on feature support.
    const shaderCode = PointCloudLODShader;
    const preparedCode = useSubgroups
      ? `enable subgroups;\n${shaderCode}`
      : shaderCode.replace(
          /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
          "// (subgroup variant stripped — feature not present)",
        );

    const shaderModule = this._device.createShaderModule({
      code: preparedCode,
      label: `${this._label} Shader`,
    });

    // Bind group layout matches PointCloudLOD.wgsl @group(0):
    //   0: uniform LODParams
    //   1-3: storage read positionsX/Y/Z
    //   4: storage read_write visibleIndices
    //   5: storage read_write atomic<u32> visibleCount
    this._bindGroupLayout = makeBindGroupLayout(
      this._device,
      `${this._label} BGL`,
      [
        uniformBuffer(0, Stage.COMPUTE),
        storageBuffer(1, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(2, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(3, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(4, Stage.COMPUTE),
        storageBuffer(5, Stage.COMPUTE),
      ],
    );

    const pipelineLayout = this._device.createPipelineLayout({
      label: `${this._label} Pipeline Layout`,
      bindGroupLayouts: [this._bindGroupLayout],
    });

    // Always compile the portable `computeMain` pipeline — it's our
    // guaranteed fallback if the subgroup variant errors at runtime.
    const main = await trackComputePipelineCreation(
      this._monitor,
      this._device,
      {
        label: `${this._label} Pipeline (computeMain)`,
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: "computeMain" },
      },
      "PointCloudLOD-computeMain",
    );

    let mainSubgroups: GPUComputePipeline | undefined;
    let preferredEntryPoint: "computeMain" | "computeMainSubgroups" =
      "computeMain";
    if (useSubgroups) {
      try {
        mainSubgroups = await trackComputePipelineCreation(
          this._monitor,
          this._device,
          {
            label: `${this._label} Pipeline (computeMainSubgroups)`,
            layout: pipelineLayout,
            compute: {
              module: shaderModule,
              entryPoint: "computeMainSubgroups",
            },
          },
          "PointCloudLOD-computeMainSubgroups",
        );
        preferredEntryPoint = "computeMainSubgroups";
      } catch (e) {
        // Some drivers advertise the feature but fail to compile the
        // subgroup intrinsics under specific layouts. Swallow and use
        // the scalar main path.
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[${this._label}] Subgroup variant failed to compile — falling back to computeMain: ${e}`,
        );
        //>>includeEnd('debug');
      }
    }

    this._pipelines = { main, mainSubgroups, preferredEntryPoint };

    // Allocate the params UB — small, persistent, updated per dispatch.
    this._paramsBuffer = this._device.createBuffer({
      label: `${this._label} LODParams UB`,
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Allocate the visibleCount atomic — 4 bytes + INDIRECT usage flag
    // so a downstream `drawIndirect(visibleCountBuffer, 0)` works after
    // a one-command `copyBufferToBuffer` from here into an indirect
    // buffer (point cloud renderer's responsibility).
    this._visibleCount = this._device.createBuffer({
      label: `${this._label} visibleCount`,
      size: 16, // 4 bytes of atomic + 12 bytes padding for 16-byte alignment
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.INDIRECT,
    });

    if (this._useDecoupledScan) {
      await this._initializeScanPath();
    }

    this._initialized = true;
  }

  /**
   * Build the scan-based tag + compact pipelines and the shared
   * DecoupledScan instance. Runs once at init when
   * `useDecoupledScan: true`.
   */
  private async _initializeScanPath(): Promise<void> {
    // Bind group for PointCloudLODScanCompact.wgsl (7 bindings — see the
    // shader's @group(0) declarations).
    this._scanBindGroupLayout = makeBindGroupLayout(
      this._device,
      `${this._label} Scan BGL`,
      [
        uniformBuffer(0, Stage.COMPUTE),
        storageBuffer(1, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(2, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(3, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(4, Stage.COMPUTE),
        storageBuffer(5, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(6, Stage.COMPUTE),
      ],
    );

    const scanCompactModule = this._device.createShaderModule({
      code: PointCloudLODScanCompactShader,
      label: `${this._label} Scan Shader`,
    });

    const scanPipelineLayout = this._device.createPipelineLayout({
      label: `${this._label} Scan Pipeline Layout`,
      bindGroupLayouts: [this._scanBindGroupLayout],
    });

    this._scanTagPipeline = await trackComputePipelineCreation(
      this._monitor,
      this._device,
      {
        label: `${this._label} Scan Pipeline (tagVisible)`,
        layout: scanPipelineLayout,
        compute: { module: scanCompactModule, entryPoint: "tagVisible" },
      },
      "PointCloudLOD-tagVisible",
    );

    this._scanCompactPipeline = await trackComputePipelineCreation(
      this._monitor,
      this._device,
      {
        label: `${this._label} Scan Pipeline (compactScanned)`,
        layout: scanPipelineLayout,
        compute: { module: scanCompactModule, entryPoint: "compactScanned" },
      },
      "PointCloudLOD-compactScanned",
    );

    // DecoupledScan owns its own params UBO + partitions buffer; it only
    // needs the caller-supplied input/output storage at dispatch time.
    // Forward the monitor so its own internal pipeline is tracked too.
    this._scanner = new WebGPUDecoupledScan(this._device, {
      label: `${this._label} Scan`,
      asyncResourceMonitor: this._monitor,
    });
    await this._scanner.initialize(DecoupledLookbackScanShader);
  }

  /**
   * Upload a new set of point positions. Call once per point cloud,
   * then dispatch repeatedly per frame. Positions are stored in SOA
   * (structure-of-arrays) for coalesced GPU reads — the shader does
   * not read XYZ as a single vec3 because separate float streams
   * pack better into cache lines for the compaction pass.
   *
   * Resizes storage if `pointCount` exceeds previous capacity. The
   * output index buffer is sized to `maxVisiblePoints` which the
   * caller passes at `dispatch` time.
   */
  uploadPositions(
    posX: Float32Array,
    posY: Float32Array,
    posZ: Float32Array,
  ): void {
    if (!this._initialized) {
      throw new Error(`[${this._label}] uploadPositions called before init`);
    }
    const n = posX.length;
    if (n === 0) return;
    if (posY.length !== n || posZ.length !== n) {
      throw new Error(
        `[${this._label}] position arrays must have equal length (x=${posX.length} y=${posY.length} z=${posZ.length})`,
      );
    }

    this._ensurePositionBuffers(n);
    const device = this._device;
    device.queue.writeBuffer(this._positionsX!, 0, gpuData(posX));
    device.queue.writeBuffer(this._positionsY!, 0, gpuData(posY));
    device.queue.writeBuffer(this._positionsZ!, 0, gpuData(posZ));

    // Bind group is now stale — rebuild on next dispatch.
    this._bindGroup = null;
    this._scanBindGroup = null;
  }

  /**
   * Ensures the SOA position storage and visibleIndices buffers are at
   * least big enough to hold `pointCount` points. Grows-only — when a
   * smaller point cloud follows a larger one we keep the bigger
   * allocation (typical for streaming scenes where point counts flap).
   */
  private _ensurePositionBuffers(pointCount: number): void {
    const capacity = Math.max(this._positionsCapacity, pointCount);
    if (capacity === this._positionsCapacity && this._positionsX) return;

    // Destroy previous allocation — the buffers were too small.
    this._positionsX?.destroy();
    this._positionsY?.destroy();
    this._positionsZ?.destroy();
    this._visibleIndices?.destroy();

    const posUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this._positionsX = this._device.createBuffer({
      label: `${this._label} positionsX`,
      size: Math.max(16, capacity * 4),
      usage: posUsage,
    });
    this._positionsY = this._device.createBuffer({
      label: `${this._label} positionsY`,
      size: Math.max(16, capacity * 4),
      usage: posUsage,
    });
    this._positionsZ = this._device.createBuffer({
      label: `${this._label} positionsZ`,
      size: Math.max(16, capacity * 4),
      usage: posUsage,
    });
    // Visible indices buffer sized to the same cap so no dispatch can
    // overflow it. Consumers cap the actual write via maxVisiblePoints.
    this._visibleIndices = this._device.createBuffer({
      label: `${this._label} visibleIndices`,
      size: Math.max(16, capacity * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    if (this._useDecoupledScan) {
      // Flags: one u32 per point (0 or 1). Partitions buffer inside the
      // scanner is separate and self-managed via scanner.ensureCapacity.
      this._flagsBuffer?.destroy();
      this._prefixBuffer?.destroy();
      this._flagsBuffer = this._device.createBuffer({
        label: `${this._label} flags`,
        size: Math.max(16, capacity * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      // Prefix buffer: needs COPY_SRC so we can copy prefix[N-1] into
      // visibleCount after the scan, letting downstream drawIndirect
      // reads see the total visible count without a CPU round-trip.
      this._prefixBuffer = this._device.createBuffer({
        label: `${this._label} prefix`,
        size: Math.max(16, capacity * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this._scanner?.ensureCapacity(capacity);
      // Scan bind group is now stale — rebuild on next scan dispatch.
      this._scanBindGroup = null;
    }

    this._positionsCapacity = capacity;
  }

  /**
   * Pack dispatch params into the UB and record the compute dispatch.
   * Caller must `device.queue.submit([encoder.finish()])` afterwards.
   *
   * Before the compute pass runs, the visibleCount atomic is cleared
   * to 0 via a COPY_DST → 0 write. The shader then atomically bumps
   * it for each visible point, producing the final count in the same
   * buffer the caller reads via drawIndirect or mapAsync.
   */
  dispatch(
    encoder: GPUCommandEncoder,
    params: PointCloudLODDispatchParams,
  ): void {
    if (!this.isReady || !this._pipelines) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(`[${this._label}] dispatch called before initialize`);
      //>>includeEnd('debug');
      return;
    }
    if (params.pointCount === 0) return;
    if (params.pointCount > this._positionsCapacity) {
      throw new Error(
        `[${this._label}] pointCount ${params.pointCount} exceeds uploaded capacity ${this._positionsCapacity}`,
      );
    }

    this._writeParams(params);

    // Always clear visibleCount to 0 first — both paths end with it
    // carrying the final visible count for drawIndirect consumers.
    encoder.clearBuffer(this._visibleCount!, 0, 16);

    // The decoupled-lookback scan path is only livelock-safe when the device
    // can co-schedule every dispatched workgroup (A2.3). The scanner's
    // occupancy gate refuses oversized dispatches; when it does, fall through
    // to the atomic-compaction path here rather than encode a no-op scan.
    if (
      this._useDecoupledScan &&
      this._scanner!.canDispatch(params.pointCount)
    ) {
      this._dispatchScanPath(encoder, params);
      return;
    }

    this._ensureBindGroup();

    const pipeline =
      this._pipelines.preferredEntryPoint === "computeMainSubgroups"
        ? this._pipelines.mainSubgroups!
        : this._pipelines.main;

    const pass = encoder.beginComputePass({
      label: `${this._label} dispatch (${this._pipelines.preferredEntryPoint})`,
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this._bindGroup!);
    const workgroups = Math.ceil(params.pointCount / WORKGROUP_SIZE);
    pass.dispatchWorkgroups(workgroups, 1, 1);
    pass.end();
  }

  /**
   * Scan-based compaction path: tagVisible → DecoupledScan → compactScanned
   * → copy prefix[N-1] into visibleCount[0]. Produces a deterministic
   * output ordering (visibleIndices sorted by original point index).
   *
   * The tag and compact passes reuse the same bind group because they
   * share the same buffers — only the pipeline differs. The scanner runs
   * its own pass between them and is wired separately (its bind group
   * layout comes from WebGPUDecoupledScan, not from us).
   */
  private _dispatchScanPath(
    encoder: GPUCommandEncoder,
    params: PointCloudLODDispatchParams,
  ): void {
    this._ensureScanBindGroup();

    const workgroups = Math.ceil(params.pointCount / WORKGROUP_SIZE);

    // Pass 1 — tag each point with 0/1 visibility.
    const tagPass = encoder.beginComputePass({
      label: `${this._label} scan dispatch (tagVisible)`,
    });
    tagPass.setPipeline(this._scanTagPipeline!);
    tagPass.setBindGroup(0, this._scanBindGroup!);
    tagPass.dispatchWorkgroups(workgroups, 1, 1);
    tagPass.end();

    // Pass 2 — inclusive prefix sum of flags → prefix.
    this._scanner!.dispatch(
      encoder,
      this._flagsBuffer!,
      this._prefixBuffer!,
      params.pointCount,
    );

    // Pass 3 — compact visible points using prefix slot.
    const compactPass = encoder.beginComputePass({
      label: `${this._label} scan dispatch (compactScanned)`,
    });
    compactPass.setPipeline(this._scanCompactPipeline!);
    compactPass.setBindGroup(0, this._scanBindGroup!);
    compactPass.dispatchWorkgroups(workgroups, 1, 1);
    compactPass.end();

    // The inclusive prefix's last entry equals total visible count. Copy
    // that single u32 into the visibleCount buffer so downstream
    // drawIndirect consumers see the count without a CPU round-trip.
    encoder.copyBufferToBuffer(
      this._prefixBuffer!,
      (params.pointCount - 1) * 4,
      this._visibleCount!,
      0,
      4,
    );
  }

  /**
   * Format the params struct exactly as declared in PointCloudLOD.wgsl.
   * The order matters — the shader reads by fixed offset, not name.
   */
  private _writeParams(p: PointCloudLODDispatchParams): void {
    const f = this._paramsScratch;
    const u = this._paramsScratchU32;
    // cameraPositionWC: vec3 + pad → slots 0-3
    f[0] = p.cameraPositionWC[0];
    f[1] = p.cameraPositionWC[1];
    f[2] = p.cameraPositionWC[2];
    f[3] = 0;
    // LOD distance² thresholds — order matches the struct
    f[4] = p.lod0Distance2;
    f[5] = p.lod1Distance2;
    f[6] = p.lod2Distance2;
    f[7] = p.lod3Distance2;
    // 6 frustum planes — 24 floats at slots 8..31
    const planes = p.frustumPlanes;
    for (let i = 0; i < 24; i++) {
      f[8 + i] = planes[i] ?? 0;
    }
    // Scalar tail at slots 32-35: pointCount (u32), maxVisiblePoints (u32),
    // screenSpaceRadius (f32), geometricError (f32)
    u[32] = p.pointCount >>> 0;
    u[33] = p.maxVisiblePoints >>> 0;
    f[34] = p.screenSpaceRadius ?? 1.0;
    f[35] = p.geometricError ?? 0.0;

    this._device.queue.writeBuffer(
      this._paramsBuffer!,
      0,
      f.buffer,
      0,
      PARAMS_FLOATS * 4,
    );
  }

  /**
   * Lazy bind group creation. Rebuilds when `uploadPositions` invalidates
   * it (different buffer handles) — otherwise reuses across dispatches.
   */
  private _ensureBindGroup(): void {
    if (this._bindGroup) return;
    this._bindGroup = this._device.createBindGroup({
      label: `${this._label} BG`,
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._paramsBuffer! } },
        { binding: 1, resource: { buffer: this._positionsX! } },
        { binding: 2, resource: { buffer: this._positionsY! } },
        { binding: 3, resource: { buffer: this._positionsZ! } },
        { binding: 4, resource: { buffer: this._visibleIndices! } },
        { binding: 5, resource: { buffer: this._visibleCount! } },
      ],
    });
  }

  /**
   * Lazy bind group for the scan-path pipelines. Binds the SAME
   * buffer resources to both tagVisible and compactScanned since they
   * share the shader module and bind group layout.
   */
  private _ensureScanBindGroup(): void {
    if (this._scanBindGroup) return;
    this._scanBindGroup = this._device.createBindGroup({
      label: `${this._label} Scan BG`,
      layout: this._scanBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._paramsBuffer! } },
        { binding: 1, resource: { buffer: this._positionsX! } },
        { binding: 2, resource: { buffer: this._positionsY! } },
        { binding: 3, resource: { buffer: this._positionsZ! } },
        { binding: 4, resource: { buffer: this._flagsBuffer! } },
        { binding: 5, resource: { buffer: this._prefixBuffer! } },
        { binding: 6, resource: { buffer: this._visibleIndices! } },
      ],
    });
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._paramsBuffer?.destroy();
    this._positionsX?.destroy();
    this._positionsY?.destroy();
    this._positionsZ?.destroy();
    this._visibleIndices?.destroy();
    this._visibleCount?.destroy();
    this._flagsBuffer?.destroy();
    this._prefixBuffer?.destroy();
    this._scanner?.destroy();
    this._paramsBuffer = null;
    this._positionsX = null;
    this._positionsY = null;
    this._positionsZ = null;
    this._visibleIndices = null;
    this._visibleCount = null;
    this._flagsBuffer = null;
    this._prefixBuffer = null;
    this._scanner = null;
    this._bindGroup = null;
    this._scanBindGroup = null;
    this._pipelines = null;
    this._bindGroupLayout = null;
    this._scanTagPipeline = null;
    this._scanCompactPipeline = null;
    this._scanBindGroupLayout = null;
    this._isDestroyed = true;
    this._initialized = false;
  }
}

export default WebGPUPointCloudLODProcessor;
