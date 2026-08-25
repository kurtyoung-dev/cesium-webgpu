import BoundingSphere from "../Core/BoundingSphere.js";
import Check from "../Core/Check.js";
import DeveloperError from "../Core/DeveloperError.js";
import Frozen from "../Core/Frozen.js";
import JulianDate from "../Core/JulianDate.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  updateWebGLComputeInstanceCollection,
  destroyWebGLComputeInstanceResources,
  getWebGLInstanceWorldPosition,
} from "../Renderer/WebGLComputeInstanceRenderer.js";

// Registers the WebGL2 compute-instance renderer at most once per context.
// Routing through the feature-renderer registry keeps WebGPU renderer
// internals out of this scene module.
function ensureWebGLComputeInstanceRenderer(context) {
  let fr = context.getFeatureRenderer(
    FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION,
  );
  if (!fr) {
    context.registerFeatureRenderer(
      FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION,
      {
        update: updateWebGLComputeInstanceCollection,
        destroy: destroyWebGLComputeInstanceResources,
        // WebGL2 resolves pick positions by re-running the CPU kernel for the
        // selected instance.
        getInstanceWorldPosition: getWebGLInstanceWorldPosition,
      },
    );
    fr = context.getFeatureRenderer(
      FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION,
    );
  }
  return fr;
}

/**
 * A collection of instances whose positions, colors, and sizes are generated
 * from caller-defined parameters and simulation time. WebGPU invokes a
 * caller-supplied WGSL compute kernel for each instance; WebGL2 can invoke an
 * optional JavaScript CPU kernel with the same output contract.
 *
 * On WebGPU, per-instance parameter floats are uploaded only when the
 * collection changes. The user kernel writes instance records directly into
 * GPU memory each frame, and the instanced point draw reads them without a CPU
 * round trip. The only per-frame CPU upload is the simulation-time scalar.
 *
 * Simulation time is derived from <code>frameState.time</code> each frame,
 * as seconds elapsed since {@link ComputeInstanceCollection#epoch} (which
 * defaults to the first rendered frame's time). Driving the scene clock —
 * e.g. <code>viewer.clock.multiplier</code> — therefore speeds up or
 * rewinds the collection like any other time-dynamic primitive.
 *
 * <h4>Kernel contract</h4>
 *
 * <code>options.kernel</code> is a WGSL snippet that must define
 *
 * <pre><code>fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut</code></pre>
 *
 * where the engine supplies these stable declarations from
 * <code>Shaders/WebGPU/Compute/ComputeInstanceScaffold.wgsl</code>:
 * <ul>
 *   <li><code>struct ComputeInstanceOut { position: vec3&lt;f32&gt;,
 *       positionLow: vec3&lt;f32&gt;, color: vec4&lt;f32&gt;,
 *       pixelSize: f32 }</code> — the kernel's return type.
 *       <code>position</code> is absolute ECEF meters (the RTE high part);
 *       <code>positionLow</code> is the RTE low part (leave it zero for
 *       f32 kernels — the default — or fill it from df64 math for extended
 *       precision, see below); <code>color</code> is straight RGBA in
 *       [0,1]; <code>pixelSize</code> is the dot diameter in pixels.</li>
 *   <li><code>params: array&lt;f32&gt;</code> — read access to the raw
 *       per-instance float lanes exactly as passed to
 *       {@link ComputeInstanceCollection#addInstance}. The lane layout is
 *       entirely the caller's business; index it as
 *       <code>params[index * FLOATS_PER_INSTANCE + lane]</code>.</li>
 *   <li><code>FLOATS_PER_INSTANCE: u32</code> — injected as a module
 *       constant from <code>options.floatsPerInstance</code>.</li>
 * </ul>
 *
 * The engine wraps the snippet with the storage-buffer bindings, the
 * dispatch entry point, the instance-count bounds check, and the RTE
 * (relative-to-eye) high/low split + output write — kernels never declare
 * bindings and never deal with RTE.
 *
 * <h4>Precision: f32 (default) vs df64 (opt-in)</h4>
 *
 * By default a kernel computes <code>out.position</code> in f32 and leaves
 * <code>out.positionLow</code> zero, giving ~meter-scale absolute error at
 * planetary radii. For extended precision the scaffold exposes
 * double-single (two-float, ~46-bit) <code>df64</code> helpers
 * (<code>csm_df64_add</code>, <code>csm_df64_mul</code>,
 * <code>csm_df64_sin</code>/<code>cos</code>, <code>csm_df64_split</code>)
 * and a <code>csm_emitDF64(x, y, z)</code> packer that fills both the RTE
 * high and low from three df64 position components. A kernel that
 * accumulates a precision-sensitive angle (e.g. mean anomaly over a long
 * propagation interval, where <code>time * meanMotion</code> overflows
 * f32 angular resolution) in df64 and emits via <code>csm_emitDF64</code>
 * makes the RTE low part meaningful — no buffer/render/pipeline changes,
 * the df64 path just fills a slot the f32 path leaves zero. df64 is opt-in
 * per quantity (mix df64 angle accumulation with f32 color/size freely).
 * See the scaffold header for the full df64 contract.
 *
 * All <code>csm_</code>-prefixed identifiers are engine-reserved; kernels
 * must not redeclare <code>ComputeInstanceOut</code>, <code>params</code>,
 * or anything <code>csm_*</code>. The kernel and
 * <code>floatsPerInstance</code> are immutable after construction.
 *
 * <h4>WebGL2 fallback</h4>
 *
 * WebGL2 has no compute shaders, so the WGSL <code>kernel</code> cannot run
 * on that backend. Supply an optional <code>options.cpuKernel</code> — a JS
 * function <code>(out, index, timeSeconds, params) =&gt; void</code> that
 * writes the same per-instance result the WGSL kernel produces
 * (<code>out.position</code> a Cartesian3-shaped <code>{x,y,z}</code> in
 * absolute ECEF meters, <code>out.color</code> a
 * <code>{red,green,blue,alpha}</code> in [0,1], <code>out.pixelSize</code> in
 * pixels). On WebGL2 the engine runs it synchronously over all instances on
 * the main thread each frame, RTE-splits the positions into the same high/low
 * representation WebGPU consumes, and issues an instanced quad draw that
 * mirrors the WebGPU vertex layout. The two kernels share an element layout
 * by the caller's contract; the engine never transpiles WGSL. Without a
 * <code>cpuKernel</code>, the collection renders nothing on WebGL2.
 *
 * <code>cpuKernel</code> is used only on the non-compute backend; WebGPU
 * always runs the WGSL <code>kernel</code> and ignores it. Worker or
 * WebAssembly offload is not implemented.
 *
 * @alias ComputeInstanceCollection
 *
 * @param {object} options Object with the following properties:
 * @param {string} options.kernel WGSL snippet defining
 *        <code>csm_computeInstance</code> (see the kernel contract above).
 * @param {number} options.floatsPerInstance Number of float parameter lanes
 *        per instance (at least 1). Immutable after construction.
 * @param {number} [options.count=0] Pre-populates the collection with this
 *        many instances whose parameter lanes are all zero (for kernels
 *        that derive everything from <code>index</code> and
 *        <code>time</code>).
 * @param {boolean} [options.show=true] Whether to display the collection.
 * @param {boolean} [options.allowPicking=true] When <code>true</code> the
 *        collection participates in {@link Scene#pick}: the GPU pick pass
 *        renders one pick id per instance into the pick framebuffer, so a
 *        <code>scene.pick</code> over an instance returns a
 *        <code>{ collection, instanceIndex, primitive }</code> record
 *        (picking uses the backend's rasterized pass rather than CPU hit
 *        tests). Set <code>false</code> to skip the per-instance
 *        pick id allocation and the pick draw entirely.
 * @param {ComputeInstanceCollection.CpuKernel} [options.cpuKernel] Optional
 *        JS kernel <code>(out, index, timeSeconds, params) =&gt; void</code>
 *        used only on the WebGL2 (non-compute) backend to produce the same
 *        per-instance result as the WGSL <code>kernel</code>. See the WebGL2
 *        fallback note above. Omit for a WebGPU-only collection.
 * @param {JulianDate} [options.epoch] The epoch that simulation time is
 *        measured from. Defaults to the first rendered frame's time.
 * @param {BoundingSphere} [options.boundingSphere] A user-supplied sphere
 *        (world/ECEF meters) that bounds every position the kernel can
 *        produce. The engine cannot derive this bound from a time-varying
 *        kernel. When supplied, the draw command carries it as its
 *        bounding volume and is frustum-culled / frustum-binned like any
 *        CPU primitive; when omitted the collection is never culled and
 *        bins into all frustums.
 *
 * @example
 * // Instances on a vertical circle above the equator; one parameter lane
 * // (an angular offset), color and size constant in the kernel.
 * const collection = scene.primitives.add(
 *   new Cesium.ComputeInstanceCollection({
 *     floatsPerInstance: 1,
 *     kernel: `
 *       fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
 *         let angle = params[index * FLOATS_PER_INSTANCE] + time * 0.001;
 *         var out: ComputeInstanceOut;
 *         out.position = vec3<f32>(8.0e6 * cos(angle), 0.0, 8.0e6 * sin(angle));
 *         out.color = vec4<f32>(0.0, 1.0, 1.0, 1.0);
 *         out.pixelSize = 4.0;
 *         return out;
 *       }`,
 *   }),
 * );
 * for (let i = 0; i < 1000; i++) {
 *   collection.addInstance([(i / 1000) * 2.0 * Math.PI]);
 * }
 */
class ComputeInstanceCollection {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    // This check remains in release builds because a missing entry point
    // otherwise surfaces later as an opaque WGSL compilation error.
    if (
      typeof options.kernel !== "string" ||
      !options.kernel.includes("csm_computeInstance")
    ) {
      throw new DeveloperError(
        "options.kernel must be a WGSL string defining " +
          "`fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut` " +
          "(see the ComputeInstanceCollection kernel contract).",
      );
    }
    const floatsPerInstance = options.floatsPerInstance;
    if (
      !Number.isInteger(floatsPerInstance) ||
      floatsPerInstance < 1 ||
      floatsPerInstance > 1024
    ) {
      throw new DeveloperError(
        "options.floatsPerInstance must be an integer in [1, 1024].",
      );
    }

    /**
     * Determines if instances in this collection will be shown.
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * When <code>true</code> the collection participates in {@link Scene#pick}
     * via a rasterized pick pass (one pick id per instance). Read by the
     * active feature renderer each frame, so it can be toggled after
     * construction.
     * @type {boolean}
     * @default true
     */
    this.allowPicking = options.allowPicking ?? true;

    //>>includeStart('debug', pragmas.debug);
    if (defined(options.cpuKernel) && typeof options.cpuKernel !== "function") {
      throw new DeveloperError(
        "options.cpuKernel must be a function (out, index, timeSeconds, params) => void.",
      );
    }
    //>>includeEnd('debug');

    this._kernel = options.kernel;
    // Used only by the non-compute backend and assignable through `cpuKernel`.
    this._cpuKernel = options.cpuKernel;
    this._floatsPerInstance = floatsPerInstance;
    this._epoch = defined(options.epoch)
      ? JulianDate.clone(options.epoch)
      : undefined;
    this._boundingSphere = defined(options.boundingSphere)
      ? BoundingSphere.clone(options.boundingSphere)
      : undefined;

    const count = options.count ?? 0;
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThanOrEquals("count", count, 0);
    //>>includeEnd('debug');
    this._count = count;
    // Flat per-instance parameter lanes (capacity-doubled on growth). The
    // renderer uploads subarray(0, _count * _floatsPerInstance) when dirty.
    this._paramsData = new Float32Array(
      Math.max(count, 64) * floatsPerInstance,
    );
    // Cleared by the feature renderer after it uploads the current parameters.
    this._catalogDirty = true;
    // Seconds since _epoch, computed from frameState.time each frame and
    // read by the feature renderer (the only per-frame CPU→GPU scalar).
    this._simulationTimeSeconds = 0;
    this._featureRenderer = undefined;
    // The context from the most recent update() — pickPosition
    // (getInstanceWorldPosition) needs it to reach the GPU device on WebGPU,
    // but it's called outside the render loop (from Scene#pickPosition).
    this._context = undefined;
    this._webgpuCache = undefined;
    this._webglCache = undefined;
  }

  /**
   * The number of instances in the collection.
   * @type {number}
   * @readonly
   */
  get length() {
    return this._count;
  }

  /**
   * The user WGSL kernel snippet. Immutable after construction.
   * @type {string}
   * @readonly
   */
  get kernel() {
    return this._kernel;
  }

  /**
   * The JS CPU fallback kernel used only on the WebGL2 (non-compute) backend:
   * <code>(out, index, timeSeconds, params) =&gt; void</code>. Writes
   * <code>out.position</code> ({x,y,z} ECEF meters), <code>out.color</code>
   * ({red,green,blue,alpha} in [0,1]) and <code>out.pixelSize</code> (px) to
   * mirror the WGSL <code>kernel</code>'s per-instance output. Ignored on
   * WebGPU. Assignable after construction.
   * @type {ComputeInstanceCollection.CpuKernel|undefined}
   */
  get cpuKernel() {
    return this._cpuKernel;
  }

  set cpuKernel(value) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(value) && typeof value !== "function") {
      throw new DeveloperError(
        "cpuKernel must be a function (out, index, timeSeconds, params) => void.",
      );
    }
    //>>includeEnd('debug');
    this._cpuKernel = value;
  }

  /**
   * Number of float parameter lanes per instance. Immutable after
   * construction.
   * @type {number}
   * @readonly
   */
  get floatsPerInstance() {
    return this._floatsPerInstance;
  }

  /**
   * The epoch that simulation time is measured from. Undefined until set
   * explicitly or until the first frame renders.
   * @type {JulianDate|undefined}
   */
  get epoch() {
    return this._epoch;
  }

  set epoch(value) {
    this._epoch = defined(value) ? JulianDate.clone(value) : undefined;
  }

  /**
   * A user-supplied sphere (world/ECEF meters) bounding every position the
   * kernel can produce, used as the draw command's bounding volume for
   * frustum culling/binning. The engine cannot derive this bound from a
   * time-varying kernel, so it is entirely the caller's contract. Assign
   * <code>undefined</code> to restore the never-culled behavior. The value
   * is cloned on assignment; mutate-and-reassign to update.
   * @type {BoundingSphere|undefined}
   */
  get boundingSphere() {
    return this._boundingSphere;
  }

  set boundingSphere(value) {
    this._boundingSphere = defined(value)
      ? BoundingSphere.clone(value, this._boundingSphere)
      : undefined;
  }

  /**
   * Adds an instance to the collection.
   *
   * @param {number[]|Float32Array} [paramsFloats] The instance's parameter
   *        lanes; length must equal <code>floatsPerInstance</code>. Omit
   *        for all-zero lanes.
   * @returns {number} The zero-based index of the added instance.
   */
  addInstance(paramsFloats) {
    const fpi = this._floatsPerInstance;
    //>>includeStart('debug', pragmas.debug);
    if (defined(paramsFloats) && paramsFloats.length !== fpi) {
      throw new DeveloperError(
        `paramsFloats.length (${paramsFloats.length}) must equal floatsPerInstance (${fpi}).`,
      );
    }
    //>>includeEnd('debug');

    const index = this._count;
    const needed = (index + 1) * fpi;
    if (needed > this._paramsData.length) {
      const grown = new Float32Array(
        Math.max(needed, this._paramsData.length * 2),
      );
      grown.set(this._paramsData);
      this._paramsData = grown;
    }
    if (defined(paramsFloats)) {
      this._paramsData.set(paramsFloats, index * fpi);
    } else {
      this._paramsData.fill(0, index * fpi, needed);
    }
    this._count = index + 1;
    this._catalogDirty = true;
    return index;
  }

  /**
   * Replaces the parameter lanes of an existing instance.
   *
   * @param {number} index The zero-based instance index.
   * @param {number[]|Float32Array} paramsFloats The new parameter lanes;
   *        length must equal <code>floatsPerInstance</code>.
   */
  setInstanceParams(index, paramsFloats) {
    const fpi = this._floatsPerInstance;
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThanOrEquals("index", index, 0);
    Check.typeOf.number.lessThan("index", index, this._count);
    if (paramsFloats.length !== fpi) {
      throw new DeveloperError(
        `paramsFloats.length (${paramsFloats.length}) must equal floatsPerInstance (${fpi}).`,
      );
    }
    //>>includeEnd('debug');
    this._paramsData.set(paramsFloats, index * fpi);
    this._catalogDirty = true;
  }

  /**
   * Returns a copy of an instance's parameter lanes.
   *
   * @param {number} index The zero-based instance index.
   * @returns {Float32Array} The instance's parameter lanes.
   */
  getInstanceParams(index) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.number.greaterThanOrEquals("index", index, 0);
    Check.typeOf.number.lessThan("index", index, this._count);
    //>>includeEnd('debug');
    const fpi = this._floatsPerInstance;
    return this._paramsData.slice(index * fpi, (index + 1) * fpi);
  }

  /**
   * Removes all instances from the collection.
   */
  removeAll() {
    this._count = 0;
    this._catalogDirty = true;
  }

  /**
   * Marks the collection dirty so external edits re-upload next frame.
   * ({@link ComputeInstanceCollection#setInstanceParams} and
   * {@link ComputeInstanceCollection#addInstance} mark it automatically.)
   */
  markDirty() {
    this._catalogDirty = true;
  }

  /**
   * Cleared by the feature renderer after a parameter upload so settled
   * collections do not re-upload unchanged data.
   * @private
   */
  _consumeDirtyState() {
    this._catalogDirty = false;
  }

  /**
   * Reconstructs the world position (absolute ECEF meters) of one instance.
   * Positions are produced by the kernel, so this routes through the active
   * backend's feature renderer:
   * <ul>
   *   <li><b>WebGPU</b>: reads the instance's record slot back from the GPU
   *       position buffer via an async <code>copyBufferToBuffer</code> +
   *       <code>mapAsync</code>, bridged to this synchronous call by a
   *       one-frame-stale per-index cache. The first call for an index returns
   *       <code>undefined</code> and starts the
   *       readback; subsequent calls for the same index converge within 1-2
   *       rendered frames.</li>
   *   <li><b>WebGL2</b>: re-runs the <code>cpuKernel</code> for the index at the
   *       current simulation time and returns the result directly (synchronous,
   *       deterministic).</li>
   * </ul>
   * Used by {@link Scene#pickPosition} when the picked object is one of this
   * collection's instances. The collection must have rendered at least once
   * (so the backend renderer and — on WebGPU — its GPU buffers exist).
   *
   * @param {number} index The zero-based instance index (e.g. the
   *        <code>instanceIndex</code> from a {@link Scene#pick} result).
   * @param {Cartesian3} [result] The object on which to store the result.
   * @returns {Cartesian3|undefined} The instance's world position, or
   *          <code>undefined</code> when it is unavailable (no renderer yet,
   *          index out of range, WebGL2 without a <code>cpuKernel</code>, or a
   *          cold WebGPU readback).
   * @private
   */
  getInstanceWorldPosition(index, result) {
    const fr = this._featureRenderer;
    if (
      !defined(fr) ||
      typeof fr.getInstanceWorldPosition !== "function" ||
      index < 0 ||
      index >= this._count
    ) {
      return undefined;
    }
    // WebGPU needs the device (from the context); WebGL ignores the extra arg.
    return fr.getInstanceWorldPosition(this, index, result, this._context);
  }

  /**
   * @private
   */
  update(frameState) {
    if (!this.show || this._count === 0) {
      return;
    }

    // Derive simulation time before selecting a renderer so both backends use
    // the scene clock.
    if (!defined(this._epoch)) {
      this._epoch = JulianDate.clone(frameState.time);
    }
    this._simulationTimeSeconds = JulianDate.secondsDifference(
      frameState.time,
      this._epoch,
    );

    const context = frameState.context;
    this._context = context;
    let fr = context.getFeatureRenderer(
      FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION,
    );

    // A non-compute context receives the WebGL renderer only when the
    // collection supplies a CPU kernel. Capability detection and the
    // feature-renderer registry keep backend selection out of scene logic.
    if (!fr && !context.supportsComputeShaders && defined(this._cpuKernel)) {
      fr = ensureWebGLComputeInstanceRenderer(context);
    }

    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
      // Stamp the context only when this frame can resolve compute-instance
      // positions. Scene#pickPosition uses the stamp to avoid an extra object
      // pick in scenes without pickable compute instances; running that pass
      // unconditionally would disrupt globe depth-buffer reconstruction.
      if (
        this.allowPicking !== false &&
        typeof fr.getInstanceWorldPosition === "function"
      ) {
        context._pickableComputeInstanceFrame = frameState.frameNumber;
      }
      return;
    }

    // A backend without a registered renderer leaves the collection
    // undisplayed. On WebGL2 this occurs when `cpuKernel` is undefined.
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the renderer resources held by this collection. Once destroyed,
   * the object should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError}.
   *
   * @example
   * collection = collection && collection.destroy();
   */
  destroy() {
    if (defined(this._featureRenderer)) {
      this._featureRenderer.destroy(this);
      this._featureRenderer = undefined;
    }
    return destroyObject(this);
  }
}

/**
 * Position components populated by a CPU fallback kernel.
 *
 * @typedef {object} ComputeInstanceCollection.CpuKernelPosition
 * @property {number} x X coordinate in absolute ECEF meters.
 * @property {number} y Y coordinate in absolute ECEF meters.
 * @property {number} z Z coordinate in absolute ECEF meters.
 */

/**
 * Color components populated by a CPU fallback kernel.
 *
 * @typedef {object} ComputeInstanceCollection.CpuKernelColor
 * @property {number} red Red component in the range [0, 1].
 * @property {number} green Green component in the range [0, 1].
 * @property {number} blue Blue component in the range [0, 1].
 * @property {number} alpha Alpha component in the range [0, 1].
 */

/**
 * Mutable output record populated by a CPU fallback kernel.
 *
 * @typedef {object} ComputeInstanceCollection.CpuKernelOutput
 * @property {ComputeInstanceCollection.CpuKernelPosition} position Position in
 *        absolute ECEF meters.
 * @property {ComputeInstanceCollection.CpuKernelColor} color Per-instance color
 *        components in the range [0, 1].
 * @property {number} pixelSize Point diameter in pixels.
 */

/**
 * Produces one instance for the non-compute renderer.
 *
 * @callback ComputeInstanceCollection.CpuKernel
 * @param {ComputeInstanceCollection.CpuKernelOutput} out Mutable output record.
 * @param {number} index Zero-based instance index.
 * @param {number} timeSeconds Seconds elapsed since the collection epoch.
 * @param {Float32Array} params Packed parameter lanes for every instance.
 * @returns {void}
 */

export default ComputeInstanceCollection;
