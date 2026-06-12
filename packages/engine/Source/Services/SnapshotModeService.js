/**
 * Locked-orbit / inspection-mode renderer optimization. When enabled,
 * tells {@link WebGPURenderBundleManager} (and any other registered
 * "freezable" subsystems) to treat their current cache state as frozen:
 * cache hits keep returning the same bundle even when the normal
 * frame-by-frame invalidation triggers would otherwise rebuild it.
 *
 * The expected win is large for static scenes (orbiting a stationary
 * model, slow guided tours, presentation mode): a typical Cesium frame
 * spends 30-60% of CPU time in command encoding. Skipping that work
 * when nothing has changed should yield a Babylon-style "FAST mode"
 * speedup, observed at 2-5x in similar engines.
 *
 * ── Relationship to other rendering services ────────────────────────
 *
 * SnapshotModeService composes with two other layers; the three are
 * COMPLEMENTARY, not duplicative:
 *
 *   1. {@link Scene#requestRenderMode}  (Cesium core, "macro-level")
 *      When `true`, Scene skips the entire render call when nothing
 *      has changed (no camera move, no dirty flags, no morph). This is
 *      the cheapest path: zero CPU work for idle frames.
 *
 *   2. SnapshotModeService             ("micro-level")
 *      When enabled and frozen, frames that DO render reuse cached
 *      bundles instead of re-encoding draw commands. The CPU win is on
 *      a per-frame basis: roughly 30-60% command-encoding cost is
 *      eliminated. Doesn't help on idle frames (those don't render at
 *      all in requestRenderMode), but is the only thing that helps for
 *      slow-moving scenes that DO render every frame.
 *
 *   3. {@link VisualPerformanceTargetService} ("quality-tuning")
 *      Adapts registered sinks (cloud sample count, fog froxel
 *      resolution, shadow map resolution, etc.) to hit a target frame
 *      time. Skipped while snapshot mode is frozen so the dial outputs
 *      don't drift the captured bundles toward an inconsistent state.
 *
 * The three layers compose as follows:
 *
 *   - `requestRenderMode` decides WHETHER to render this frame.
 *   - If yes, snapshot mode (when frozen) makes that render cheap.
 *   - VPT measures the resulting frame and tunes quality for next time.
 *
 * Auto-enter coordination (`autoEnterIdleFrames`):
 *   When non-zero AND `requestRenderMode = true`, the snapshot service
 *   will automatically enter snapshot mode after N consecutive idle
 *   frames (frames where Scene.render() decided not to render anything).
 *   This means a user who turns on `requestRenderMode` AND configures
 *   `autoEnterIdleFrames = 120` gets the FAST mode benefit for free
 *   the moment their scene settles. The next render — typically
 *   triggered by a small camera move or a tile load — replays bundles
 *   instead of rebuilding them. Disabled by default so the existing
 *   behavior is unchanged for users who haven't opted in.
 *
 * Mark-dirty hooks: when something explicitly invalidates the
 * snapshot — `Scene.requestRender()`, an HDR/depth-buffer change, a
 * VPT sink adjustment — the service auto-thaws so the next render
 * rebuilds bundles against fresh state. See {@link #markDirty}.
 *
 * ── Phase 0.7 status ────────────────────────────────────────────────
 * This file is the **registration skeleton only**. There is no actual
 * freeze/thaw logic yet — Phase 1+ features (volumetric fog froxel
 * passes, terrain bundles, primitive bundles) register against this
 * surface as they land. Wiring the service in now means Phase 5/6 work
 * has a stable target.
 *
 * The reconciliation contract with {@link Scene._snapshotVersion}
 * (introduced by the 3D Tiles invalidation feed in Phase 0.5) is
 * already implemented: every tick, the service compares its captured
 * `_baselineSnapshotVersion` against the current `scene._snapshotVersion`,
 * and if they differ, calls `_thawAll()` because something somewhere
 * mutated scene state in a way that invalidates frozen bundles.
 *
 * ── Critical behavior contracts ─────────────────────────────────────
 * 1. Disabled by default. Opt-in via `service.enabled = true`. While
 *    disabled, every method past the contract guard is a no-op.
 * 2. Snapshot mode AUTO-THAWS when `scene._snapshotVersion` advances
 *    past the captured baseline. The application code does not need to
 *    manually thaw on every tile invalidation — the version comparison
 *    handles it.
 * 3. Snapshot mode AUTO-THAWS when the camera moves significantly. A
 *    small camera-position-delta tolerance (Phase 1+) prevents
 *    millimeter jitter from triggering a thaw, but any meaningful
 *    motion does. (Threshold to be tuned in Phase 1.)
 * 4. The service does NOT itself freeze bundles — it tells registered
 *    "freezables" to freeze. Each freezable owns its actual freeze
 *    semantics (the bundle manager keeps its cache; the VPT service
 *    locks its tuning; etc.).
 * 5. Snapshot state is BACKEND-NEUTRAL. WebGL has no bundles to freeze
 *    so its registered freezables are typically no-ops; the service
 *    still works for it as a "lock VPT tuning" surface.
 *
 * ── Known limitation: shared-context multi-view ─────────────────────
 *
 * SnapshotModeService is a per-Scene singleton, but several freezables
 * (notably {@link WebGPURenderBundleManager}) live on the GraphicsContext
 * and are SHARED across all Scenes that bind to the same context. If
 * Scene A enters snapshot mode while Scene B keeps animating against
 * the SAME context, Scene B will inadvertently see frozen bundles
 * because the bundle manager itself is frozen.
 *
 * Workarounds for the multi-view case:
 *   - Give each Scene its own GraphicsContext (recommended for split
 *     screens with independent cameras / clocks).
 *   - Leave snapshot mode disabled on every Scene that shares a context
 *     unless ALL of them are simultaneously idle.
 *   - Restrict freezables to per-Scene state (the volumetric fog
 *     freezable already does this; bundle manager does NOT yet).
 *
 * Tracked in `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` as a Phase 6
 * post-merge follow-up. Until per-context partitioning lands, callers
 * mixing snapshot mode + multi-view should assume single-Scene
 * ownership of the context.
 *
 * @private
 * @module SnapshotModeService
 */

import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Cartesian3 from "../Core/Cartesian3.js";

/**
 * Freezable contract — registered via {@link SnapshotModeService#registerFreezable}.
 *
 * @typedef {object} SnapshotFreezable
 * @property {string} name Diagnostic name (e.g. `"webgpu-bundle-manager"`).
 * @property {function():void} freeze Called when snapshot mode is entered
 *   or when a previously-thawed snapshot is re-entered. Implementations
 *   should be idempotent.
 * @property {function():void} thaw Called when snapshot mode is exited
 *   OR when the scene's `_snapshotVersion` advances past the captured
 *   baseline. Implementations should be idempotent.
 * @property {function():boolean} [isFrozen] Optional introspection hook.
 */

class SnapshotModeService {
  constructor() {
    this._enabled = false;
    this._isFrozen = false;
    this._baselineSnapshotVersion = -1;

    /** @type {Map<string, SnapshotFreezable>} */
    this._freezables = new Map();

    // Phase 6B — camera-delta auto-thaw state. Captured at enter() and
    // compared each tickCamera() call. Defaults are intentionally
    // conservative; real apps should override via the `cameraDelta*`
    // setters once a target scene is wired up.
    this._capturedCameraPosition = new Cartesian3();
    this._capturedCameraDirection = new Cartesian3();
    this._capturedCameraUp = new Cartesian3();
    this._cameraDeltaPositionThreshold = 1.0; // meters
    this._cameraDeltaRotationThreshold = 0.0087; // ~0.5 degrees in radians

    // Auto-enter coordination with `Scene.requestRenderMode`. When
    // `_autoEnterIdleFrames > 0`, the service tracks consecutive idle
    // frames (frames where Scene.render() decided not to render) and
    // automatically calls `enter()` after that many. Default 0 keeps
    // the existing manual-only behavior. Apps that want the
    // FAST-mode-for-free benefit set this to e.g. 120 (~2 seconds at
    // 60fps) alongside `scene.requestRenderMode = true`.
    this._autoEnterIdleFrames = 0;
    this._consecutiveIdleFrames = 0;

    // Diagnostics
    this._stats = {
      enterCount: 0,
      autoEnterCount: 0,
      autoThawCount: 0,
      manualThawCount: 0,
      cameraThawCount: 0,
      lastEnterFrame: -1,
      lastThawFrame: -1,
      lastThawReason: null,
      lastAutoEnterReason: null,
    };
  }

  /**
   * Number of consecutive idle frames (no real render fired) required
   * before the service auto-enters snapshot mode. Set to `0` to
   * disable auto-entry — the service then only enters when an explicit
   * `enter(scene)` call is made.
   *
   * Recommended companion to `scene.requestRenderMode = true` for the
   * FAST-mode-on-idle preset:
   *
   *     scene.requestRenderMode = true;
   *     scene.snapshotMode.enabled = true;
   *     scene.snapshotMode.autoEnterIdleFrames = 120;  // ~2s at 60fps
   *
   * @type {number}
   * @default 0
   */
  get autoEnterIdleFrames() {
    return this._autoEnterIdleFrames;
  }
  set autoEnterIdleFrames(value) {
    this._autoEnterIdleFrames = Math.max(0, value | 0);
    if (this._autoEnterIdleFrames === 0) {
      this._consecutiveIdleFrames = 0;
    }
  }

  /**
   * Whether the service is enabled. While false, all tick / freeze /
   * thaw calls are no-ops and registered freezables are never touched.
   * @type {boolean}
   * @default false
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    const next = value === true;
    if (next === this._enabled) {
      return;
    }
    this._enabled = next;
    if (!next && this._isFrozen) {
      // Disabling the service must thaw any active snapshot.
      this._thawAll("service disabled");
    }
  }

  /**
   * Whether the service is currently in snapshot mode (frozen).
   * @type {boolean}
   * @readonly
   */
  get isFrozen() {
    return this._isFrozen;
  }

  /**
   * The captured baseline `Scene._snapshotVersion` at the moment the
   * current snapshot was entered. -1 when not frozen.
   * @type {number}
   * @readonly
   */
  get baselineSnapshotVersion() {
    return this._baselineSnapshotVersion;
  }

  /**
   * Number of registered freezables. Diagnostic / test convenience.
   * @type {number}
   * @readonly
   */
  get freezableCount() {
    return this._freezables.size;
  }

  /**
   * Diagnostics snapshot — returns a clone, safe to inspect.
   */
  getStatistics() {
    return Object.assign({}, this._stats, {
      isFrozen: this._isFrozen,
      enabled: this._enabled,
      freezableCount: this._freezables.size,
      baselineSnapshotVersion: this._baselineSnapshotVersion,
    });
  }

  /**
   * Register a subsystem that can be frozen as part of snapshot mode.
   * The subsystem owns its actual freeze semantics; the service just
   * orchestrates when to call freeze() and thaw().
   *
   * Typical Phase 1+ registrants:
   * - `WebGPURenderBundleManager` — freeze the cache so beginFrame
   *   eviction stops dropping bundles
   * - `VisualPerformanceTargetService` — lock current quality dials
   * - Volumetric fog froxel grid encoder — reuse last frame's grid
   *
   * @param {string} name
   * @param {SnapshotFreezable} freezable
   */
  registerFreezable(name, freezable) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(name) || typeof name !== "string") {
      throw new DeveloperError("name must be a non-empty string");
    }
    if (!defined(freezable)) {
      throw new DeveloperError("freezable is required");
    }
    if (typeof freezable.freeze !== "function") {
      throw new DeveloperError("freezable.freeze must be a function");
    }
    if (typeof freezable.thaw !== "function") {
      throw new DeveloperError("freezable.thaw must be a function");
    }
    //>>includeEnd('debug');
    freezable.name = freezable.name ?? name;
    this._freezables.set(name, freezable);

    // If snapshot mode is already active, the new arrival joins
    // immediately so the cache it's about to fill is recognized as
    // part of this snapshot.
    if (this._enabled && this._isFrozen) {
      try {
        freezable.freeze();
      } catch (e) {
        console.error(
          `[SnapshotMode] freeze() threw for late-arrival ${name}:`,
          e,
        );
      }
    }
  }

  /**
   * Unregister a freezable.
   * @param {string} name
   * @returns {boolean}
   */
  unregisterFreezable(name) {
    return this._freezables.delete(name);
  }

  /**
   * Enter snapshot mode. Captures the current `scene._snapshotVersion`
   * as the baseline and calls freeze() on every registered freezable.
   *
   * Idempotent — calling enter() while already frozen is a no-op.
   *
   * @param {Scene} scene
   */
  enter(scene) {
    if (!this._enabled) {
      return;
    }
    if (this._isFrozen) {
      return;
    }
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene)) {
      throw new DeveloperError("scene is required");
    }
    //>>includeEnd('debug');

    this._baselineSnapshotVersion = scene._snapshotVersion ?? 0;
    this._isFrozen = true;
    this._stats.enterCount++;
    this._stats.lastEnterFrame =
      scene._frameState?.frameNumber ?? this._stats.lastEnterFrame;

    // Phase 6B — capture the current camera state so tickCamera() can
    // detect meaningful motion. Defensively cloned because the scene
    // mutates these vectors in-place every frame.
    const camera = scene.camera;
    if (defined(camera)) {
      Cartesian3.clone(camera.positionWC, this._capturedCameraPosition);
      Cartesian3.clone(camera.directionWC, this._capturedCameraDirection);
      Cartesian3.clone(camera.upWC, this._capturedCameraUp);
    }

    for (const [name, freezable] of this._freezables) {
      try {
        freezable.freeze();
      } catch (e) {
        console.error(`[SnapshotMode] freeze() threw for ${name}:`, e);
      }
    }
  }

  /**
   * Phase 6B — Camera position + rotation thresholds (settable).
   *
   * `cameraDeltaPositionThreshold` (meters): how far the camera position
   * is allowed to drift from the captured baseline before the snapshot
   * auto-thaws. Default 1.0m. Larger thresholds tolerate user-input
   * jitter; smaller thresholds make the snapshot more sensitive.
   *
   * `cameraDeltaRotationThreshold` (radians): minimum angle change of
   * the camera direction or up vector that triggers a thaw. Default
   * ~0.5 degrees. Smaller = stricter.
   */
  get cameraDeltaPositionThreshold() {
    return this._cameraDeltaPositionThreshold;
  }
  set cameraDeltaPositionThreshold(value) {
    this._cameraDeltaPositionThreshold = Math.max(0, value);
  }
  get cameraDeltaRotationThreshold() {
    return this._cameraDeltaRotationThreshold;
  }
  set cameraDeltaRotationThreshold(value) {
    this._cameraDeltaRotationThreshold = Math.max(0, value);
  }

  /**
   * Phase 6B — Per-frame camera-delta check. Compares the current
   * camera position + direction + up against the captured baseline
   * and auto-thaws when either exceeds the configured threshold.
   *
   * Called from `Scene.render()` once per frame, after the standard
   * `tick()` (which handles snapshot version reconciliation). Split
   * out from `tick()` so unit tests can drive each independently and
   * so the camera-delta path is easy to disable for headless tests.
   *
   * Idempotent / no-op when not enabled or not currently frozen.
   *
   * @param {Scene} scene
   */
  tickCamera(scene) {
    if (!this._enabled || !this._isFrozen || !defined(scene)) {
      return;
    }
    const camera = scene.camera;
    if (!defined(camera)) {
      return;
    }

    // Position delta — Euclidean distance in world coordinates.
    const posDelta = Cartesian3.distance(
      camera.positionWC,
      this._capturedCameraPosition,
    );
    if (posDelta > this._cameraDeltaPositionThreshold) {
      this._stats.cameraThawCount++;
      this._stats.lastThawFrame =
        scene._frameState?.frameNumber ?? this._stats.lastThawFrame;
      this._thawAll(
        `camera position delta ${posDelta.toFixed(3)}m > ${this._cameraDeltaPositionThreshold}m`,
      );
      return;
    }

    // Rotation delta — angle between captured and current direction.
    // We compare both the forward direction and the up vector so a
    // pure roll (which doesn't change the forward axis) still
    // triggers a thaw.
    const dirDot = Cartesian3.dot(
      camera.directionWC,
      this._capturedCameraDirection,
    );
    const dirAngle = Math.acos(Math.min(1.0, Math.max(-1.0, dirDot)));
    if (dirAngle > this._cameraDeltaRotationThreshold) {
      this._stats.cameraThawCount++;
      this._stats.lastThawFrame =
        scene._frameState?.frameNumber ?? this._stats.lastThawFrame;
      this._thawAll(
        `camera direction angle ${dirAngle.toFixed(4)}rad > ${this._cameraDeltaRotationThreshold}rad`,
      );
      return;
    }
    const upDot = Cartesian3.dot(camera.upWC, this._capturedCameraUp);
    const upAngle = Math.acos(Math.min(1.0, Math.max(-1.0, upDot)));
    if (upAngle > this._cameraDeltaRotationThreshold) {
      this._stats.cameraThawCount++;
      this._stats.lastThawFrame =
        scene._frameState?.frameNumber ?? this._stats.lastThawFrame;
      this._thawAll(
        `camera up angle ${upAngle.toFixed(4)}rad > ${this._cameraDeltaRotationThreshold}rad (roll)`,
      );
      return;
    }
  }

  /**
   * Per-frame coordination hook with `Scene.requestRenderMode`. Called
   * from {@link Scene#render} BEFORE the `if (shouldRender)` gate so
   * the service sees idle frames too. The `isRenderFrame` argument
   * tells us whether Scene chose to render this tick.
   *
   * Behavior:
   *   - On a real render frame the idle counter resets. The service's
   *     existing `tick()` and `tickCamera()` paths handle the actual
   *     auto-thaw checks for that frame.
   *   - On an idle frame the counter increments. When it crosses the
   *     `autoEnterIdleFrames` threshold (and the service is enabled
   *     but not yet frozen), `enter()` is called automatically with
   *     the current scene as the baseline.
   *
   * Disabled by default — `autoEnterIdleFrames === 0` short-circuits
   * the auto-enter path entirely. The idle counter still ticks (cheap)
   * but no enter call is made.
   *
   * @param {Scene} scene
   * @param {boolean} isRenderFrame True when Scene.render() decided to
   *   render this tick (i.e. the `if (shouldRender)` block ran).
   */
  notifyFrame(scene, isRenderFrame) {
    if (!this._enabled) {
      return;
    }
    if (isRenderFrame) {
      this._consecutiveIdleFrames = 0;
      return;
    }
    // Idle frame.
    this._consecutiveIdleFrames++;
    if (
      this._autoEnterIdleFrames > 0 &&
      !this._isFrozen &&
      this._consecutiveIdleFrames >= this._autoEnterIdleFrames
    ) {
      this._stats.autoEnterCount++;
      this._stats.lastAutoEnterReason = `${this._consecutiveIdleFrames} consecutive idle frames (threshold ${this._autoEnterIdleFrames})`;
      this.enter(scene);
    }
  }

  /**
   * Phase 6C — Mark the active snapshot dirty with a reason. Called
   * by `Scene.markSnapshotDirty()` and any subsystem that needs to
   * tell the service "something changed that I can't push through
   * the snapshotVersion mechanism — please thaw."
   *
   * The typical caller is HDR/depth-buffer reconfiguration: changing
   * the scene's HDR mode or depth precision rebuilds the swap chain
   * textures, which invalidates any cached bundles that were encoded
   * against the old attachments. Without this, `executeBundles()`
   * would throw a validation error on the next replay.
   *
   * Other consumers: user `postUpdate` listeners that mutate entity
   * state silently (the contract is that user code calls this when
   * it knows it has changed visible state without bumping a tile
   * version), animation systems on first tick, and the volumetric
   * fog renderer when its quality dial changes mid-snapshot.
   *
   * Idempotent and safe to call when not currently frozen.
   *
   * @param {string} reason Diagnostic string surfaced via getStatistics().
   */
  markDirty(reason) {
    if (!this._isFrozen) {
      return;
    }
    this._stats.manualThawCount++;
    this._thawAll(reason ?? "markDirty (no reason supplied)");
  }

  /**
   * Manually exit snapshot mode. Idempotent.
   * @param {Scene} [scene] Optional, used only for diagnostics frame number.
   */
  exit(scene) {
    if (!this._isFrozen) {
      return;
    }
    if (defined(scene) && defined(scene._frameState)) {
      this._stats.lastThawFrame = scene._frameState.frameNumber;
    }
    this._stats.manualThawCount++;
    this._thawAll("manual exit");
  }

  /**
   * Per-frame tick from {@link Scene#render}. Compares the current
   * `scene._snapshotVersion` against the captured baseline and
   * auto-thaws if they differ. This is the reconciliation contract
   * with the 3D Tiles invalidation feed and any other subsystem that
   * bumps `_snapshotVersion`.
   *
   * @param {Scene} scene
   */
  tick(scene) {
    if (!this._enabled) {
      return;
    }
    if (!this._isFrozen) {
      return;
    }
    if (!defined(scene)) {
      return;
    }
    const current = scene._snapshotVersion ?? 0;
    if (current !== this._baselineSnapshotVersion) {
      // Something invalidated scene state — bundles are stale.
      this._stats.autoThawCount++;
      this._stats.lastThawFrame =
        scene._frameState?.frameNumber ?? this._stats.lastThawFrame;
      this._thawAll(
        `snapshotVersion advanced ${this._baselineSnapshotVersion} -> ${current}`,
      );
    }
    // Phase 6B — camera-delta auto-thaw lives in tickCamera() called
    // separately from Scene.render(). The split keeps the existing
    // version-reconciliation path unit-testable in isolation.
  }

  /**
   * @private
   */
  _thawAll(reason) {
    if (!this._isFrozen) {
      return;
    }
    this._isFrozen = false;
    this._baselineSnapshotVersion = -1;
    this._stats.lastThawReason = reason;
    // Reset the idle counter so a thaw doesn't immediately re-enter
    // on the next idle frame. The user has to actually idle for
    // `autoEnterIdleFrames` again before the next auto-entry.
    this._consecutiveIdleFrames = 0;

    for (const [name, freezable] of this._freezables) {
      try {
        freezable.thaw();
      } catch (e) {
        console.error(`[SnapshotMode] thaw() threw for ${name}:`, e);
      }
    }
  }

  /**
   * Releases references to all registered freezables. Called when the
   * owning Scene is destroyed.
   */
  destroy() {
    if (this._isFrozen) {
      this._thawAll("service destroyed");
    }
    this._freezables.clear();
  }
}

export default SnapshotModeService;
