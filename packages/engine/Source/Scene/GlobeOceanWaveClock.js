import defined from "../Core/defined.js";
import {
  cloneSimulationEpoch,
  resolveOceanSimulationSeconds,
} from "./OceanSurfacePrimitive.js";

/**
 * Frames per second the globe's water-mask wave constants were tuned against.
 *
 * The wave phase used to be the render-loop counter itself: GLSL read
 * <code>czm_frameNumber</code> and the WebGPU tile uniform buffer mirrored it
 * deliberately. Both wave-speed constants were therefore chosen against an
 * assumed sixty hertz, and this number is that assumption made explicit rather
 * than a new tuning knob. Multiplying elapsed scene seconds by it reproduces
 * the frame count the constants were calibrated with, so one second of scene
 * time at clock speed one advances the sea by exactly what sixty frames did.
 * Changing it would change the look of the default ocean; it exists to be
 * shared, not adjusted.
 *
 * Consumed by <code>GlobeFS.glsl</code> (as the constant
 * <code>oceanWaveNominalFramesPerSecond</code>, which
 * <code>globe-ocean-wave-clock.spec.mjs</code> holds equal to this value) and
 * by <code>WebGPUGlobeSurfaceTileUB</code>, which folds it into the per-second
 * phase rate it writes to the tile uniform buffer.
 *
 * @type {number}
 * @private
 */
export const OCEAN_WAVE_NOMINAL_FPS = 60.0;

/**
 * Phase advance for a frame that carries no clock at all, in scene seconds.
 *
 * One nominal frame, which is the rate the sea has always run at, so a frame
 * with no time neither stalls the waves nor speeds them up.
 *
 * @type {number}
 * @private
 */
const CLOCKLESS_FRAME_SECONDS = 1.0 / OCEAN_WAVE_NOMINAL_FPS;

/**
 * The mutable state behind the globe water-mask ocean's wave clock.
 *
 * @typedef {object} GlobeOceanWaveClock
 * @property {JulianDate} [_simulationEpoch] The instant elapsed seconds are
 *   measured from. Undefined until the first frame that carries a time, which
 *   the shared law then adopts; the field name is the law's, which reads and
 *   writes nothing else on the object it is handed.
 * @property {JulianDate} [_pinnedEpochSource] The caller's pinned instant as
 *   last seen, held only to notice that the pin changed. Never read for its
 *   value.
 * @property {number} seconds The last resolved phase, in scene seconds, which
 *   a clockless frame continues from.
 * @private
 */

/**
 * Create the wave clock a {@link Globe} owns for its water-mask ocean.
 *
 * @returns {GlobeOceanWaveClock} A clock that has not adopted an epoch yet.
 * @private
 */
function createGlobeOceanWaveClock() {
  return {
    _simulationEpoch: undefined,
    _pinnedEpochSource: undefined,
    seconds: 0.0,
  };
}

/**
 * Resolve this frame's wave phase, in scene seconds, for both backends.
 *
 * The sea is a function of the clock the scene is showing. Driving it from the
 * render-loop counter instead made the wave rate whatever the frame rate
 * happened to be, left a paused clock churning, and — because two pages that
 * have rendered a different number of frames were then showing different seas —
 * made every capture that was not frame-locked meaningless. That last
 * consequence is the one that surfaced it: a same-settings A/B on this ocean
 * had no byte-identity form at all.
 *
 * The epoch comes from one of two places. A caller may pin it, in which case
 * two viewers at the same instant draw the same sea; that pin is the FFT
 * surface's, {@link GlobeWaterOcean#simulationEpoch}, so one setting reaches
 * both seas. Otherwise the shared law adopts the first frame that carries a
 * time, into this clock's own field rather than into the facade's — a globe
 * that has merely been drawing must not make the FFT surface's public
 * <code>simulationEpoch</code> start reporting an instant nobody chose, and
 * must not move that surface's phase origin off zero.
 *
 * A frame with no time carries on from where the clock left it, one nominal
 * frame at a time. It must NOT fall back to the frame counter: that counter has
 * an origin of its own, unrelated to the clock's, so switching to it teleports
 * the sea by however far the two have diverged and switching back teleports it
 * again. When the clock returns it is authoritative, which is a correction
 * rather than a jump.
 *
 * With a clock this is a pure function of <code>frameState.time</code>, so the
 * several logical views of one rendered frame all resolve the same phase and
 * calling it more than once in a frame changes nothing.
 *
 * @param {GlobeOceanWaveClock} clock The globe's clock.
 * @param {FrameState} [frameState] The frame state, read only for its time.
 * @param {JulianDate} [pinnedEpoch] The pinned epoch, or undefined to measure
 *   from the first frame that carries a time.
 * @returns {number} Elapsed scene seconds for this frame.
 * @private
 */
function advanceGlobeOceanWaveClock(clock, frameState, pinnedEpoch) {
  if (pinnedEpoch !== clock._pinnedEpochSource) {
    // The instants a caller reaches for — `viewer.clock.currentTime` and
    // `frameState.time` — are rewritten in place by the engine rather than
    // replaced, so a clock that kept the caller's reference would watch its own
    // epoch advance with the scene and freeze at zero elapsed. Copying makes
    // the pin mean what it says. Clearing it re-adopts on the next timed frame.
    clock._pinnedEpochSource = pinnedEpoch;
    clock._simulationEpoch = cloneSimulationEpoch(pinnedEpoch);
  }
  const elapsed = resolveOceanSimulationSeconds(clock, frameState);
  clock.seconds = defined(elapsed)
    ? elapsed
    : clock.seconds + CLOCKLESS_FRAME_SECONDS;
  return clock.seconds;
}

export { advanceGlobeOceanWaveClock, createGlobeOceanWaveClock };
