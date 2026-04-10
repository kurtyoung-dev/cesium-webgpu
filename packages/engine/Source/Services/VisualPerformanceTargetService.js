/**
 * @module VisualPerformanceTargetService
 *
 * Adaptive visual quality coordinator. Acts as the puppeteer of both Scene
 * and Renderer features that have a tunable quality dial — the user picks a
 * target framerate (e.g. "hold 60 FPS") and this service dynamically adjusts
 * registered "sinks" up or down based on measurements from registered
 * "probes" so the target is met.
 *
 * Architecturally this service belongs to neither Scene nor Renderer because
 * it operates across both: probes typically read GPU/CPU frame timings
 * (Renderer concern) while sinks tune visual features (Scene concern). It
 * lives under `Source/Services/` as the first orchestration service in the
 * engine.
 *
 * ── Relationship to other rendering services ────────────────────────
 *
 * VPT composes with `Scene.requestRenderMode` and {@link SnapshotModeService}
 * — see that file's module doc for the full three-way diagram. The short
 * version:
 *
 *   1. `Scene.requestRenderMode` decides WHETHER a frame renders.
 *   2. SnapshotModeService (when frozen) makes a render frame cheap by
 *      replaying cached bundles.
 *   3. VPT measures the resulting frame and tunes quality for next time.
 *
 * VPT's `tick()` is gated on snapshot-mode-frozen so the auto-tuner
 * doesn't drift the captured bundles toward an inconsistent state. The
 * snapshot service in turn flips its `vpt.snapshotMode` flag from
 * Scene.render() each frame, so the gate is current. There is also no
 * duplication with `requestRenderMode` because Scene only ticks VPT
 * inside the `if (shouldRender)` block — idle frames never reach VPT.
 *
 * Future hook: when VPT actually starts adjusting sinks (Phase 1+), it
 * should call `scene.markSnapshotDirty('VPT sink change')` so an active
 * snapshot rebuilds against the new quality dial outputs. The hook
 * isn't wired yet because there are no live sinks to test it with.
 *
 * ── Phase 0 status ──────────────────────────────────────────────────────
 * This file is the **skeleton only**: registration API + tick contract.
 * No probes, no sinks, no auto-tuning logic yet. Phase 1 and Phase 2
 * features (volumetric cloud sample count, fog froxel resolution, terrain
 * LOD bias, shadow map resolution, etc.) will register against this
 * surface as they land. Wiring the service in now avoids retrofitting
 * every consumer when the auto-tuner is finally implemented.
 *
 * ── Critical behavior contracts ─────────────────────────────────────────
 * 1. Disabled by default. Opt-in via `service.enabled = true`.
 * 2. tick() MUST no-op when `scene._renderRequested === false` — Cesium
 *    skips rendering when nothing changed, and measurements during idle
 *    frames are meaningless.
 * 3. tick() MUST no-op when `snapshotMode === true` — when the scene is
 *    in snapshot/locked-orbit mode the render bundle is frozen and there
 *    is nothing meaningful to tune.
 *
 * @private
 */

import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";

/**
 * Sink contract — registered via {@link VisualPerformanceTargetService#registerSink}.
 *
 * @typedef {object} VisualPerformanceSink
 * @property {string[]} levels Ordered list of quality levels, lowest first
 *   (e.g. `["low", "medium", "high", "ultra"]`).
 * @property {function():string} getLevel Returns the current level.
 * @property {function(string):void} setLevel Sets the level. Implementations
 *   should be idempotent and cheap to call repeatedly with the same value.
 * @property {number} [cost] Optional relative cost hint (higher = more
 *   expensive feature). The auto-tuner will prefer to scale down higher-cost
 *   sinks first when a frame budget is being missed.
 */

/**
 * Probe contract — registered via {@link VisualPerformanceTargetService#registerProbe}.
 *
 * A probe is a function returning a measurement object. The shape of that
 * object is probe-specific; the auto-tuner (Phase 1+) will know which probes
 * it cares about and how to interpret their output.
 *
 * @typedef {function():object} VisualPerformanceProbe
 */

class VisualPerformanceTargetService {
  constructor() {
    this._enabled = false;
    this._targetFps = 60;
    this._snapshotMode = false;

    /** @type {Map<string, VisualPerformanceProbe>} */
    this._probes = new Map();

    /** @type {Map<string, VisualPerformanceSink>} */
    this._sinks = new Map();

    // Reserved for the auto-tuner — populated in a future phase.
    this._lastEvaluationFrameNumber = -1;
    this._evaluationIntervalFrames = 60; // re-evaluate roughly once per second
  }

  /**
   * Whether the service is enabled. When false, {@link #tick} is a no-op
   * and registered sinks are never adjusted.
   * @type {boolean}
   * @default false
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    this._enabled = value === true;
  }

  /**
   * Target frames-per-second the auto-tuner will try to hold.
   * @type {number}
   * @default 60
   */
  get targetFps() {
    return this._targetFps;
  }
  set targetFps(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value) || value <= 0) {
      throw new DeveloperError("targetFps must be a positive number");
    }
    //>>includeEnd('debug');
    this._targetFps = value;
  }

  /**
   * When true, the service treats the scene as frozen (snapshot/locked-orbit
   * mode). The tick contract requires this to be a no-op so a frozen render
   * bundle is never re-tuned. Set by the snapshot mode subsystem; consumers
   * normally don't toggle this directly.
   * @type {boolean}
   * @default false
   */
  get snapshotMode() {
    return this._snapshotMode;
  }
  set snapshotMode(value) {
    this._snapshotMode = value === true;
  }

  /**
   * Number of registered probes. Diagnostic / test convenience.
   * @type {number}
   * @readonly
   */
  get probeCount() {
    return this._probes.size;
  }

  /**
   * Number of registered sinks. Diagnostic / test convenience.
   * @type {number}
   * @readonly
   */
  get sinkCount() {
    return this._sinks.size;
  }

  /**
   * Diagnostic snapshot for the central debug surface
   * (`Scene.getDebugSnapshot()`). Returns a clone — safe to inspect or
   * mutate. Lists every registered probe + sink with its current value
   * so the operator can see, at a glance, what the auto-tuner sees.
   *
   * Probe values are queried lazily by calling each probe function;
   * any probe that throws is reported as `{ error: <message> }` so a
   * single broken probe doesn't poison the whole dump.
   */
  getStatistics() {
    const probes = {};
    for (const [name, probeFn] of this._probes) {
      try {
        probes[name] = probeFn();
      } catch (e) {
        probes[name] = { error: String(e?.message ?? e) };
      }
    }
    const sinks = {};
    for (const [name, sink] of this._sinks) {
      let level;
      try {
        level = sink.getLevel();
      } catch (e) {
        level = `<error: ${String(e?.message ?? e)}>`;
      }
      sinks[name] = {
        level,
        levels: Array.isArray(sink.levels) ? sink.levels.slice() : [],
        cost: sink.cost ?? null,
      };
    }
    return {
      enabled: this._enabled,
      targetFps: this._targetFps,
      snapshotMode: this._snapshotMode,
      probeCount: this._probes.size,
      sinkCount: this._sinks.size,
      probes,
      sinks,
    };
  }

  /**
   * Register a measurement probe. Probes are queried by the auto-tuner each
   * evaluation tick to inform sink adjustments.
   *
   * @param {string} name Unique probe name.
   * @param {VisualPerformanceProbe} probeFn Function returning a measurement.
   */
  registerProbe(name, probeFn) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(name) || typeof name !== "string") {
      throw new DeveloperError("name must be a non-empty string");
    }
    if (!defined(probeFn) || typeof probeFn !== "function") {
      throw new DeveloperError("probeFn must be a function");
    }
    //>>includeEnd('debug');
    this._probes.set(name, probeFn);
  }

  /**
   * Unregister a previously-registered probe.
   * @param {string} name
   * @returns {boolean} True if a probe with that name was removed.
   */
  unregisterProbe(name) {
    return this._probes.delete(name);
  }

  /**
   * Register a tunable feature ("sink") with the service. The auto-tuner
   * will scale registered sinks up or down to meet the target framerate.
   *
   * @param {string} name Unique sink name.
   * @param {VisualPerformanceSink} sink Sink contract object.
   */
  registerSink(name, sink) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(name) || typeof name !== "string") {
      throw new DeveloperError("name must be a non-empty string");
    }
    if (!defined(sink)) {
      throw new DeveloperError("sink is required");
    }
    if (!Array.isArray(sink.levels) || sink.levels.length === 0) {
      throw new DeveloperError("sink.levels must be a non-empty array");
    }
    if (typeof sink.getLevel !== "function") {
      throw new DeveloperError("sink.getLevel must be a function");
    }
    if (typeof sink.setLevel !== "function") {
      throw new DeveloperError("sink.setLevel must be a function");
    }
    //>>includeEnd('debug');
    this._sinks.set(name, sink);
  }

  /**
   * Unregister a previously-registered sink.
   * @param {string} name
   * @returns {boolean} True if a sink with that name was removed.
   */
  unregisterSink(name) {
    return this._sinks.delete(name);
  }

  /**
   * Frame tick — called once per rendered frame from {@link Scene#render}.
   *
   * Coordination contract:
   *   - Disabled flag short-circuits everything.
   *   - Snapshot-mode flag (set externally by Scene.render() each frame
   *     from `scene.snapshotMode.isFrozen`) short-circuits the auto-tune
   *     measurement so the dial outputs don't drift the captured bundles
   *     toward an inconsistent state.
   *   - Idle frames don't reach this method at all because Scene.render()
   *     only ticks VPT inside the `if (shouldRender)` block. The
   *     defensive `_renderRequested === false` guard is kept as a safety
   *     net for callers that drive `tick()` outside the normal render
   *     path (e.g. test harnesses).
   *
   * In Phase 0 the post-guard body is a stub: probes are not queried
   * and sinks are not adjusted. The auto-tuner implementation lands in
   * a future phase. The call site + registration API are wired now so
   * consumers can register against the service today without any later
   * Scene plumbing changes.
   *
   * @param {Scene} scene
   */
  tick(scene) {
    if (!this._enabled) {
      return;
    }
    if (this._snapshotMode) {
      return;
    }
    // Defensive idle-frame guard — only reachable when a test harness
    // or other non-Scene caller invokes tick() with a scene whose
    // `_renderRequested` is still false. The normal Scene.render() path
    // clears that flag inside the `if (shouldRender)` block before
    // ticking us, so production frames never hit this branch.
    if (defined(scene) && scene._renderRequested === false) {
      return;
    }

    // Phase 1+: query probes, evaluate frame-time budget, adjust sinks.
    // The fields `_probes`, `_sinks`, `_lastEvaluationFrameNumber`, and
    // `_evaluationIntervalFrames` are populated/declared in preparation
    // for that work — they're not dead, they're pending implementation.
  }

  /**
   * Releases references to all registered probes and sinks. Call when the
   * owning Scene is being destroyed.
   */
  destroy() {
    this._probes.clear();
    this._sinks.clear();
  }
}

export default VisualPerformanceTargetService;
