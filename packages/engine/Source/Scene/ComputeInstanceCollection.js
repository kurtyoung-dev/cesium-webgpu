import BoundingSphere from "../Core/BoundingSphere.js";
import Check from "../Core/Check.js";
import DeveloperError from "../Core/DeveloperError.js";
import Frozen from "../Core/Frozen.js";
import JulianDate from "../Core/JulianDate.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

/**
 * A GPU-resident collection of N instances whose per-instance data lives in
 * a GPU storage buffer and is repopulated each frame by a USER-SUPPLIED
 * WGSL compute kernel (NEW-COMPUTE-INSTANCE-SYSTEM — the generalization of
 * the Batch-230 GPU-resident catalog; Phase 3 of the Large Dynamic Objects
 * roadmap).
 *
 * Unlike {@link PointPrimitiveCollection}, positions are never computed on
 * the CPU: the per-instance parameter floats upload to the GPU once
 * (re-uploaded only when the collection changes), the user kernel runs once
 * per instance per frame, and the instanced point draw reads the kernel's
 * output directly from GPU memory. The CPU's per-frame upload is one
 * scalar — the simulation time.
 *
 * Simulation time is derived from <code>frameState.time</code> each frame,
 * as seconds elapsed since {@link ComputeInstanceCollection#epoch} (which
 * defaults to the first rendered frame's time). Driving the scene clock —
 * e.g. <code>viewer.clock.multiplier</code> — therefore speeds up or
 * rewinds the collection like any other time-dynamic primitive.
 *
 * <h4>Kernel contract</h4>
 *
 * <code>options.kernel</code> is a WGSL snippet that MUST define
 *
 * <pre><code>fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut</code></pre>
 *
 * where the engine provides (stable, documented scaffolding — see
 * <code>Shaders/WebGPU/Compute/ComputeInstanceScaffold.wgsl</code>):
 * <ul>
 *   <li><code>struct ComputeInstanceOut { position: vec3&lt;f32&gt;,
 *       positionLow: vec3&lt;f32&gt;, color: vec4&lt;f32&gt;,
 *       pixelSize: f32 }</code> — the kernel's return type.
 *       <code>position</code> is absolute ECEF meters (the RTE HIGH part);
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
 * The ENGINE wraps the snippet with the storage-buffer bindings, the
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
 * and a <code>csm_emitDF64(x, y, z)</code> packer that fills BOTH the RTE
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
 * Rendering is currently WebGPU-only (WebGL2 has no compute). The WebGL2
 * fallback (worker/WASM kernel writing the same instance buffer) is a
 * tracked follow-up — see NEW-COMPUTE-INSTANCE-* entries in
 * migration_doc/DEFERRED_WORK.md. On a WebGL context this collection
 * renders nothing.
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
 * @param {JulianDate} [options.epoch] The epoch that simulation time is
 *        measured from. Defaults to the first rendered frame's time.
 * @param {BoundingSphere} [options.boundingSphere] A user-supplied sphere
 *        (world/ECEF meters) that bounds every position the kernel can
 *        produce. Because positions are GPU-resident the engine cannot
 *        derive one. When supplied, the draw command carries it as its
 *        bounding volume and is frustum-culled / frustum-binned like any
 *        CPU primitive; when omitted the collection is never culled and
 *        bins into all frustums (the pre-Batch-235 behavior).
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

    // Fail loudly in ALL builds (not pragma-stripped): a kernel without the
    // entry function would otherwise surface as an opaque WGSL compile
    // error deep inside the renderer.
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

    this._kernel = options.kernel;
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
    // Consumed by the feature renderer after each params upload
    // (Phase-0 dirty-consume discipline — see _consumeDirtyState).
    this._catalogDirty = true;
    // Seconds since _epoch, computed from frameState.time each frame and
    // read by the feature renderer (the only per-frame CPU→GPU scalar).
    this._simulationTimeSeconds = 0;
    this._featureRenderer = undefined;
    this._webgpuCache = undefined;
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
   * frustum culling/binning. Positions are GPU-resident, so the engine
   * cannot derive this — it is entirely the caller's contract. Assign
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
   * Consumed by the feature renderer after the params upload each frame so
   * settled collections never re-upload (Phase-0 dirty-consume discipline —
   * mirrors BillboardCollection._consumeDirtyState).
   * @private
   */
  _consumeDirtyState() {
    this._catalogDirty = false;
  }

  /**
   * @private
   */
  update(frameState) {
    if (!this.show || this._count === 0) {
      return;
    }

    // Shared scene logic BEFORE the backend branch (scene-logic-extractor
    // pattern): derive simulation time from the scene clock so both
    // backends agree on the time source.
    if (!defined(this._epoch)) {
      this._epoch = JulianDate.clone(frameState.time);
    }
    this._simulationTimeSeconds = JulianDate.secondsDifference(
      frameState.time,
      this._epoch,
    );

    const fr = frameState.context.getFeatureRenderer(
      FeatureRendererKey.COMPUTE_INSTANCE_COLLECTION,
    );
    if (fr) {
      fr.update(this, frameState);
      this._featureRenderer = fr;
      return;
    }

    // WebGL2 has no compute — the fallback (a worker/WASM kernel host
    // writing the same instance buffer) is tracked as
    // NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK in migration_doc/DEFERRED_WORK.md.
    // Until it lands, the collection renders nothing on WebGL.
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
   * Destroys the WebGPU resources held by this collection. Once destroyed,
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

export default ComputeInstanceCollection;
