import Cartesian3 from "../Core/Cartesian3.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import DeveloperError from "../Core/DeveloperError.js";
import Frozen from "../Core/Frozen.js";
import JulianDate from "../Core/JulianDate.js";
import defined from "../Core/defined.js";

/**
 * The SECOND {@link ComputeInstanceCollection} kernel family
 * (NEW-SAMPLED-POSITION-KERNEL; the orbital secular-J2 propagator was the
 * first). Where the orbital kernel DERIVES each object's position from a
 * closed-form analytic model (six mean elements + secular rates), this kernel
 * handles the complementary, non-derivable regime: a dense catalog of
 * time-dynamic objects whose positions are given as KEYFRAMES — discrete
 * <code>(time, position)</code> samples that the GPU interpolates at the
 * current clock time. This is the GPU-resident analogue of Cesium's
 * {@link SampledPositionProperty}: a CZML / entity catalog of keyframed
 * objects becomes one storage buffer the kernel walks each frame, instead of
 * N JavaScript <code>getValue</code> calls per frame on the CPU.
 *
 * <h4>Why a kernel FAMILY, not a one-off kernel</h4>
 *
 * The keyframe COUNT per instance (hence the param-lane stride) is fixed at
 * pipeline-build time — a WGSL <code>array&lt;f32&gt;</code> kernel can't take
 * a per-instance variable-length list without a separate offset table. So this
 * is a <em>factory</em>: {@link SampledPositionKernel.create} bakes a concrete
 * <code>maxKeyframes</code> into a matched WGSL kernel + JS cpuKernel +
 * param-packer, all sharing ONE lane layout. Two catalogs with different
 * keyframe budgets are two <code>create</code> calls (two kernels, two
 * collections). Instances with FEWER keyframes than the budget store their
 * real count in lane 0 and leave the trailing slots unused.
 *
 * <h4>Param-lane layout (per instance, stride = 1 + 4 * maxKeyframes)</h4>
 *
 * <pre>
 *   lane 0                      : keyframeCount (as f32; 1..maxKeyframes)
 *   lanes 1 + 4*k .. 4 + 4*k    : keyframe k = (timeSeconds, x, y, z)
 * </pre>
 *
 * <code>timeSeconds</code> is seconds since the collection epoch (the same
 * clock the kernel's <code>time</code> argument carries); <code>x/y/z</code>
 * are absolute ECEF meters. Keyframes MUST be sorted ascending by time (the
 * packer asserts this) — the interpolation search relies on it.
 *
 * <h4>Interpolation</h4>
 *
 * LINEAR between the two bracketing keyframes (the default and most common
 * {@link SampledPositionProperty} mode — {@link LinearApproximation} of
 * degree 1). Before the first / after the last keyframe the position CLAMPS
 * to the endpoint (HOLD extrapolation), matching
 * {@link ExtrapolationType.HOLD}, which is Cesium's default backward
 * extrapolation. Higher-degree (Hermite / Lagrange) interpolation to match a
 * non-linear {@link SampledPositionProperty} is a documented follow-up
 * (NEW-SAMPLED-POSITION-KERNEL-HERMITE) — linear is exact for the dense
 * regime this targets (closely-spaced samples) and is the regime CZML
 * <code>position</code> tracks ship in by default.
 *
 * Both backends share ONE element layout by this factory's contract: the WGSL
 * kernel runs on WebGPU (compute), the JS <code>cpuKernel</code> runs on the
 * WebGL2 fallback, and {@link SampledPositionKernel.sample} is the pure-JS
 * reference both must match (used by the probe to validate parity against an
 * independent CPU interpolation).
 *
 * @namespace SampledPositionKernel
 *
 * @example
 * // A catalog of 5000 keyframed objects, up to 8 samples each.
 * const family = Cesium.SampledPositionKernel.create({ maxKeyframes: 8 });
 * const collection = scene.primitives.add(
 *   new Cesium.ComputeInstanceCollection({
 *     kernel: family.kernel,
 *     cpuKernel: family.cpuKernel,        // WebGL2 fallback
 *     floatsPerInstance: family.floatsPerInstance,
 *   }),
 * );
 * const epoch = Cesium.JulianDate.now();
 * collection.epoch = epoch;
 * for (const track of catalog) {
 *   // track.keyframes = [{ time: JulianDate, position: Cartesian3 }, ...]
 *   collection.addInstance(family.packInstance(track.keyframes, epoch));
 * }
 */
const SampledPositionKernel = {};

// Hard ceiling on the per-instance keyframe budget. Each keyframe is 4 lanes,
// and ComputeInstanceCollection caps floatsPerInstance at 1024, so
// 1 + 4 * maxKeyframes <= 1024 => maxKeyframes <= 255. Keep a round, lower
// cap (a 255-keyframe-per-instance catalog is well outside the dense-regime
// this family targets and would balloon the params buffer).
const MAX_KEYFRAMES_LIMIT = 64;

/**
 * Compose the WGSL <code>csm_computeInstance</code> kernel for a baked
 * <code>maxKeyframes</code>. The lane layout (count @0, then time/x/y/z
 * quadruples) MUST match {@link SampledPositionKernel#packInstance} and the
 * JS cpuKernel below. The interpolation is linear with HOLD extrapolation.
 *
 * @param {number} maxKeyframes
 * @param {Color} color
 * @param {number} pixelSize
 * @returns {string}
 * @private
 */
function buildWgslKernel(maxKeyframes, color, pixelSize) {
  // The lane stride and keyframe budget are compile-time constants in the
  // kernel — FLOATS_PER_INSTANCE is already injected by the engine prologue,
  // but inlining MAX_KEYFRAMES as a literal lets the search loop bound be a
  // const (WGSL requires a constant loop bound for unrollable loops).
  const r = color.red.toFixed(6);
  const g = color.green.toFixed(6);
  const b = color.blue.toFixed(6);
  const a = color.alpha.toFixed(6);
  const ps = pixelSize.toFixed(6);
  return `
const SPK_MAX_KEYFRAMES: u32 = ${maxKeyframes >>> 0}u;

fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
  let base = index * FLOATS_PER_INSTANCE;
  let countF = params[base + 0u];
  // Defensive clamp: count in [1, SPK_MAX_KEYFRAMES]. A zero-keyframe
  // instance (count <= 0) collapses to a single read of the first slot.
  var count: u32 = u32(max(countF, 1.0));
  if (count > SPK_MAX_KEYFRAMES) {
    count = SPK_MAX_KEYFRAMES;
  }

  // Each keyframe is 4 lanes (t, x, y, z) starting at lane 1.
  let kf0 = base + 1u;

  // First keyframe (clamp BEFORE the first sample — HOLD extrapolation).
  let t0 = params[kf0 + 0u];
  if (time <= t0 || count == 1u) {
    var outHead: ComputeInstanceOut;
    outHead.position = vec3<f32>(
      params[kf0 + 1u], params[kf0 + 2u], params[kf0 + 3u]
    );
    outHead.color = vec4<f32>(${r}, ${g}, ${b}, ${a});
    outHead.pixelSize = ${ps};
    return outHead;
  }

  // Walk segments [k, k+1) to find the bracket containing 'time'. count is
  // <= SPK_MAX_KEYFRAMES (a const) so the loop has a constant upper bound.
  var px = params[kf0 + 1u];
  var py = params[kf0 + 2u];
  var pz = params[kf0 + 3u];
  var found = false;
  for (var k: u32 = 0u; k < SPK_MAX_KEYFRAMES - 1u; k = k + 1u) {
    if (k + 1u >= count) {
      break;
    }
    let a0 = kf0 + k * 4u;
    let a1 = kf0 + (k + 1u) * 4u;
    let ta = params[a0 + 0u];
    let tb = params[a1 + 0u];
    if (time >= ta && time <= tb) {
      let span = tb - ta;
      // Degenerate (duplicate-time) segment -> snap to the later sample.
      let s = select(0.0, clamp((time - ta) / span, 0.0, 1.0), span > 0.0);
      px = mix(params[a0 + 1u], params[a1 + 1u], s);
      py = mix(params[a0 + 2u], params[a1 + 2u], s);
      pz = mix(params[a0 + 3u], params[a1 + 3u], s);
      found = true;
      break;
    }
  }

  if (!found) {
    // Past the last keyframe -> HOLD the last sample.
    let last = kf0 + (count - 1u) * 4u;
    px = params[last + 1u];
    py = params[last + 2u];
    pz = params[last + 3u];
  }

  var out: ComputeInstanceOut;
  out.position = vec3<f32>(px, py, pz);
  out.color = vec4<f32>(${r}, ${g}, ${b}, ${a});
  out.pixelSize = ${ps};
  return out;
}`;
}

/**
 * Pure-JS linear-interpolation reference over a packed instance's lanes,
 * shared by the cpuKernel (WebGL2 backend) and {@link SampledPositionKernel.sample}
 * (the probe's parity reference). Writes the interpolated position into
 * <code>result</code> ({x,y,z}).
 *
 * @param {Float32Array|number[]} params The full collection params array.
 * @param {number} base The instance's first lane (<code>index * stride</code>).
 * @param {number} maxKeyframes The baked keyframe budget.
 * @param {number} timeSeconds Seconds since epoch.
 * @param {{x:number,y:number,z:number}} result
 * @private
 */
function interpolateFromLanes(params, base, maxKeyframes, timeSeconds, result) {
  let count = Math.floor(Math.max(params[base + 0], 1));
  if (count > maxKeyframes) {
    count = maxKeyframes;
  }
  const kf0 = base + 1;

  const t0 = params[kf0 + 0];
  if (timeSeconds <= t0 || count === 1) {
    result.x = params[kf0 + 1];
    result.y = params[kf0 + 2];
    result.z = params[kf0 + 3];
    return;
  }

  for (let k = 0; k < count - 1; k++) {
    const a0 = kf0 + k * 4;
    const a1 = kf0 + (k + 1) * 4;
    const ta = params[a0 + 0];
    const tb = params[a1 + 0];
    if (timeSeconds >= ta && timeSeconds <= tb) {
      const span = tb - ta;
      const s =
        span > 0 ? Math.min(Math.max((timeSeconds - ta) / span, 0), 1) : 0;
      result.x = params[a0 + 1] + (params[a1 + 1] - params[a0 + 1]) * s;
      result.y = params[a0 + 2] + (params[a1 + 2] - params[a0 + 2]) * s;
      result.z = params[a0 + 3] + (params[a1 + 3] - params[a0 + 3]) * s;
      return;
    }
  }

  // Past the last keyframe -> HOLD the last sample.
  const last = kf0 + (count - 1) * 4;
  result.x = params[last + 1];
  result.y = params[last + 2];
  result.z = params[last + 3];
}

/**
 * Create a keyframe-interpolation kernel family for a fixed per-instance
 * keyframe budget. Returns the matched WGSL kernel, JS cpuKernel,
 * <code>floatsPerInstance</code>, and a per-instance param packer — feed these
 * straight to {@link ComputeInstanceCollection}.
 *
 * @param {object} [options]
 * @param {number} [options.maxKeyframes=8] Per-instance keyframe budget
 *        (1..64). Determines the param-lane stride
 *        (<code>1 + 4 * maxKeyframes</code>). Instances may carry fewer
 *        keyframes than this.
 * @param {Color} [options.color=Color.WHITE] Constant per-instance dot color.
 * @param {number} [options.pixelSize=6.0] Constant per-instance dot diameter
 *        in pixels.
 * @returns {SampledPositionKernel.Family}
 */
SampledPositionKernel.create = function (options) {
  options = options ?? Frozen.EMPTY_OBJECT;
  const maxKeyframes = options.maxKeyframes ?? 8;
  //>>includeStart('debug', pragmas.debug);
  if (!Number.isInteger(maxKeyframes) || maxKeyframes < 1) {
    throw new DeveloperError(
      "options.maxKeyframes must be a positive integer.",
    );
  }
  //>>includeEnd('debug');
  if (maxKeyframes > MAX_KEYFRAMES_LIMIT) {
    throw new DeveloperError(
      `options.maxKeyframes (${maxKeyframes}) exceeds the ${MAX_KEYFRAMES_LIMIT}-keyframe-per-instance limit.`,
    );
  }
  const color = defined(options.color)
    ? Color.clone(options.color)
    : Color.clone(Color.WHITE);
  const pixelSize = options.pixelSize ?? 6.0;

  const floatsPerInstance = 1 + 4 * maxKeyframes;
  const kernel = buildWgslKernel(maxKeyframes, color, pixelSize);

  // Scratch reused across the per-frame cpuKernel sweep (no per-instance
  // allocation). The WebGL renderer calls cpuKernel once per instance per
  // frame, so this must not allocate.
  const scratchPos = { x: 0, y: 0, z: 0 };

  /**
   * @type {ComputeInstanceCollection.CpuKernel}
   */
  const cpuKernel = function (out, index, timeSeconds, params) {
    const base = index * floatsPerInstance;
    interpolateFromLanes(params, base, maxKeyframes, timeSeconds, scratchPos);
    out.position.x = scratchPos.x;
    out.position.y = scratchPos.y;
    out.position.z = scratchPos.z;
    out.color.red = color.red;
    out.color.green = color.green;
    out.color.blue = color.blue;
    out.color.alpha = color.alpha;
    out.pixelSize = pixelSize;
  };

  /**
   * Flatten one instance's keyframes into the family's lane layout.
   *
   * @param {Array.<{time: (JulianDate|number), position: Cartesian3}>} keyframes
   *        Keyframes sorted ASCENDING by time. <code>time</code> is either a
   *        {@link JulianDate} (converted to seconds since <code>epoch</code>)
   *        or a number already in seconds since epoch. At least one keyframe;
   *        at most <code>maxKeyframes</code>.
   * @param {JulianDate} [epoch] The collection epoch. REQUIRED when any
   *        keyframe time is a {@link JulianDate}; ignored when all times are
   *        numbers.
   * @returns {Float32Array} A <code>floatsPerInstance</code>-length lane array
   *          ready for {@link ComputeInstanceCollection#addInstance}.
   */
  const packInstance = function (keyframes, epoch) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("keyframes", keyframes);
    if (keyframes.length < 1) {
      throw new DeveloperError("keyframes must have at least one entry.");
    }
    if (keyframes.length > maxKeyframes) {
      throw new DeveloperError(
        `keyframes.length (${keyframes.length}) exceeds maxKeyframes (${maxKeyframes}).`,
      );
    }
    //>>includeEnd('debug');

    const lanes = new Float32Array(floatsPerInstance);
    const count = keyframes.length;
    lanes[0] = count;
    let prevT = -Infinity;
    for (let k = 0; k < count; k++) {
      const kf = keyframes[k];
      let t = kf.time;
      if (typeof t !== "number") {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(epoch)) {
          throw new DeveloperError(
            "epoch is required when keyframe times are JulianDates.",
          );
        }
        //>>includeEnd('debug');
        t = JulianDate.secondsDifference(t, epoch);
      }
      //>>includeStart('debug', pragmas.debug);
      if (t < prevT) {
        throw new DeveloperError(
          `keyframes must be sorted ascending by time (keyframe ${k} t=${t} < previous ${prevT}).`,
        );
      }
      //>>includeEnd('debug');
      prevT = t;
      const pos = kf.position;
      const o = 1 + k * 4;
      lanes[o + 0] = t;
      lanes[o + 1] = pos.x;
      lanes[o + 2] = pos.y;
      lanes[o + 3] = pos.z;
    }
    return lanes;
  };

  /**
   * Pure-JS reference: the interpolated world position of one packed instance
   * at a query time. Independent of the cpuKernel's per-frame sweep — the
   * probe uses this to validate BOTH backends against a CPU interpolation.
   *
   * @param {Float32Array|number[]} lanes The instance's packed lanes (as
   *        returned by {@link SampledPositionKernel#packInstance}).
   * @param {number} timeSeconds Seconds since epoch.
   * @param {Cartesian3} [result]
   * @returns {Cartesian3} The interpolated position.
   */
  const sample = function (lanes, timeSeconds, result) {
    if (!defined(result)) {
      result = new Cartesian3();
    }
    interpolateFromLanes(lanes, 0, maxKeyframes, timeSeconds, result);
    return result;
  };

  return {
    kernel,
    cpuKernel,
    floatsPerInstance,
    maxKeyframes,
    packInstance,
    sample,
  };
};

/**
 * @typedef {object} SampledPositionKernel.Family
 * @property {string} kernel The WGSL <code>csm_computeInstance</code> snippet
 *           (pass as <code>ComputeInstanceCollection.kernel</code>).
 * @property {ComputeInstanceCollection.CpuKernel} cpuKernel The matching JS
 *           kernel for the WebGL2 fallback (pass as
 *           <code>ComputeInstanceCollection.cpuKernel</code>).
 * @property {number} floatsPerInstance The param-lane stride
 *           (<code>1 + 4 * maxKeyframes</code>).
 * @property {number} maxKeyframes The baked per-instance keyframe budget.
 * @property {function(Array.<{time:(JulianDate|number),position:Cartesian3}>, JulianDate=):Float32Array} packInstance
 *           Flattens one instance's keyframes into the lane layout.
 * @property {function((Float32Array|number[]), number, Cartesian3=):Cartesian3} sample
 *           Pure-JS interpolation reference (probe parity check).
 */

export default SampledPositionKernel;
