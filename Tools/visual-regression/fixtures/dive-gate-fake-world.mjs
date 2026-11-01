// dive-gate-fake-world.mjs - the one fake viewer and page the dive-gate specs run the real page functions against.
// @purpose Spec support for the dive gate: a fake viewer whose scene holds `globeHeight` undefined until `initializeFrame()` runs, whose wheel input moves the camera only when `initializeFrame()` runs the controller update (clamped at the surface plus `minimumZoomDistance`, or at the dive floor where the water facade's gate allows), whose `render()` changes neither, and a fake page that runs the real page functions (`pagePlaceDiveCamera`, `pageReadDiveState`, `pageRenderFrames`) with `globalThis.viewer` and `requestAnimationFrame` provided and restored afterwards.
// @status ACTIVE
//
// WHY THIS IS ONE SHARED WORLD. An earlier fake answered `globeHeight` and the gate directly,
// so the specs passed while the Edge leg read `globe-height-undefined` on every dive page: the
// real page never refreshed them with its render loop stopped. This world refuses what the
// engine refuses. In `Scene.js`, `initializeFrame()` is the only place `_globeHeight` is
// refreshed (when `_globeHeightDirty`) and where the screen-space camera controller runs;
// `render()` only marks the height dirty when the camera changed. The water facade applies the
// engine's `canDiveAtSurfaceHeight` rule (`GlobeWater.js`: collision disabled and
// |height| <= 110 m). The controller's zoom floor is the stock `globeHeight +
// minimumZoomDistance`, or, where that gate allows, the virtual dive's 14 m stop with the
// depth counting instead (`SSCCInputHelpers.js`).
//
// WHAT IT DOES NOT ANSWER. Nothing under test is answered here: the quantities the specs read
// (`globeHeight`, `cameraHeight`, the gate) come out of the real page functions reading this
// world, and move only because the real frame loop drove it.

import { pageRenderFrames } from "../lib/landing-page-frames.mjs";

/** The log name the stub Cesium module's `Cartesian3.fromDegrees` appends to on `globalThis`. */
export const STUB_CESIUM_LOG = "__diveGateCells";

/** A stub Cesium module: the one `fromDegrees` the placement uses, logging its calls. */
export const STUB_CESIUM_MODULE_URL = `data:text/javascript,${encodeURIComponent(
  `globalThis.${STUB_CESIUM_LOG} ??= [];
export const Cartesian3 = {
  fromDegrees: (lon, lat, height) => {
    globalThis.${STUB_CESIUM_LOG}.push({ lon, lat, height });
    return { lon, lat, height };
  },
};`,
)}`;

/** The engine's sea-level band half-width, in metres (`GlobeWater.js`). */
const SEA_LEVEL_SURFACE_TOLERANCE_METERS = 110;

/** The virtual dive's stop above the surface and the depth one notch adds there. */
const DIVE_STOP_METERS = 14;
const DIVE_DEPTH_STEP_METERS = 10;

/**
 * Build the world.
 *
 * @param {object} [setup]
 * @param {number|undefined} [setup.surface] Terrain height under the camera,
 *   in metres; `undefined` is terrain that never arrives.
 * @param {number} [setup.startHeight] The camera height before any placement.
 * @param {boolean} [setup.facade] Whether the controller's globe has a water
 *   facade (`_water`); `false` is a globe whose `_water` never exists.
 * @param {boolean} [setup.waterAccessor] Whether `globe.water` exists at all;
 *   `false` makes the placement report no water facade.
 * @param {boolean} [setup.sinks] A controller bug: the terrain clamp never
 *   holds.
 * @param {boolean} [setup.enableInputs] `false` is a controller that ignores
 *   its input: the wheel never moves the camera.
 * @param {number} [setup.wheelStepMeters] A fixed metres per notch; omitted,
 *   a notch covers 35 % of the distance above the zoom floor (at least 2 m).
 * @param {(args: {frames: number}) => Promise<number>} [setup.frameDriver]
 *   The page function {@link World.settle} evaluates; the real frame driver
 *   unless a mutant is passed.
 * @returns {object} The world: `viewer`, `scene`, `camera`, `water`, `page`,
 *   `settle` and `seen` (what the page was asked and what the engine would
 *   have counted).
 */
export function makeDiveGateFakeWorld({
  surface,
  startHeight = 200,
  facade = true,
  waterAccessor = true,
  sinks = false,
  enableInputs = true,
  wheelStepMeters = null,
  frameDriver = pageRenderFrames,
} = {}) {
  const seen = {
    accessorHits: 0,
    wheels: [],
    moves: [],
    settles: [],
    renders: [],
    initializeFrames: 0,
    clockTicks: 0,
    animationFrames: 0,
    globeHeightRefreshes: 0,
    placedAt: null,
  };
  const currentTime = Object.freeze({ frozen: true });
  const queue = [];

  const water = {
    disableWaterCollision: false,
    diveDepthMeters: 0,
    canDiveAtSurfaceHeight(height) {
      return (
        this.disableWaterCollision === true &&
        Number.isFinite(height) &&
        Math.abs(height) <= SEA_LEVEL_SURFACE_TOLERANCE_METERS
      );
    },
  };
  // The accessor creates the facade (as the engine's does); `_water` is
  // whatever exists, and a build without one never gets any.
  let facadeCreated = false;

  const camera = {
    height: startHeight,
    get positionCartographic() {
      return { height: this.height };
    },
    setView({ destination }) {
      this.height = destination.height;
      seen.placedAt = destination;
    },
  };

  const controller = { minimumZoomDistance: 1, enableInputs };

  const scene = {
    camera,
    // Undefined until `initializeFrame()` refreshes it, as `Scene._globeHeight` is.
    _globeHeight: undefined,
    _globeHeightDirty: true,
    _renderedCameraHeight: Number.NaN,
    get globeHeight() {
      return this._globeHeight;
    },
    screenSpaceCameraController: controller,
    canvas: {
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 800,
        height: 400,
      }),
    },
    // `Scene.initializeFrame`: refresh the globe height when stale, then run
    // the controller update, which is the only consumer of wheel input.
    initializeFrame() {
      seen.initializeFrames++;
      if (this._globeHeightDirty) {
        this._globeHeight = surface;
        this._globeHeightDirty = false;
        seen.globeHeightRefreshes++;
      }
      this.runController();
    },
    // `Scene.render`: marks the height stale when the camera changed since the
    // last frame; refreshes nothing and moves nothing.
    render(time) {
      seen.renders.push(time);
      if (camera.height !== this._renderedCameraHeight) {
        this._renderedCameraHeight = camera.height;
        this._globeHeightDirty = true;
      }
    },
    runController() {
      const notches = queue.splice(0, queue.length);
      if (!controller.enableInputs) {
        return;
      }
      for (const deltaY of notches) {
        zoom(deltaY);
      }
    },
    globe: {
      get water() {
        if (!waterAccessor) {
          return undefined;
        }
        seen.accessorHits++;
        facadeCreated = true;
        return water;
      },
      get _water() {
        return facade && facadeCreated ? water : undefined;
      },
    },
  };

  // One wheel notch, applied the way the controller's zoom handler does: a
  // zoom-out is free; a zoom-in stops at the clamp floor, or at the dive stop
  // (counting depth) where the facade's gate allows.
  function zoom(deltaY) {
    const base = surface ?? 0;
    const step = (distance) =>
      wheelStepMeters ?? Math.max(2, 0.35 * Math.max(distance, 0));
    if (deltaY >= 0) {
      camera.height += step(camera.height - base);
      return;
    }
    if (sinks) {
      camera.height -= step(camera.height - base);
      return;
    }
    const dives =
      facade && facadeCreated && water.canDiveAtSurfaceHeight(surface);
    const floor =
      base +
      (dives
        ? Math.max(controller.minimumZoomDistance + 2, DIVE_STOP_METERS)
        : controller.minimumZoomDistance);
    const next = camera.height - step(camera.height - floor);
    if (next > floor) {
      camera.height = next;
      return;
    }
    camera.height = floor;
    if (dives) {
      water.diveDepthMeters += DIVE_DEPTH_STEP_METERS;
    }
  }

  const viewer = {
    scene,
    clock: {
      currentTime,
      tick() {
        seen.clockTicks++;
        return currentTime;
      },
    },
  };

  const page = {
    // The real page functions run here, with the globals a page has.
    evaluate: async (fn, arg) => {
      const savedViewer = globalThis.viewer;
      const savedFrame = globalThis.requestAnimationFrame;
      globalThis.viewer = viewer;
      globalThis.requestAnimationFrame = (callback) => {
        seen.animationFrames++;
        setImmediate(() => callback(0));
        return seen.animationFrames;
      };
      try {
        return await fn(arg);
      } finally {
        globalThis.viewer = savedViewer;
        globalThis.requestAnimationFrame = savedFrame;
      }
    },
    mouse: {
      move: async (x, y) => seen.moves.push([x, y]),
      // Playwright's trusted wheel: delivered to the controller's listener,
      // consumed at the next `initializeFrame()`.
      wheel: async (_dx, deltaY) => {
        seen.wheels.push(deltaY);
        queue.push(deltaY);
      },
    },
  };

  const settle = async (frames) => {
    seen.settles.push(frames);
    return page.evaluate(frameDriver, { frames });
  };

  return { viewer, scene, camera, water, controller, page, settle, seen };
}
