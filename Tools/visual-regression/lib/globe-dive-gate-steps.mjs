/**
 * The camera controller's water dive gate as a step sequence: place the camera
 * at a lon/lat, set the water facade's `disableWaterCollision`, wheel-zoom in
 * through the real controller and record, per step, whether the gate allowed
 * the dive and whether the terrain clamp held the camera.
 * @purpose Globe-family dive-gate steps: place the camera, set `globe.water.disableWaterCollision`, wheel-zoom in N notches with Playwright's trusted mouse and settle after each, read the controller's gate (`canDiveAtSurfaceHeight`), `diveDepthMeters` and the camera's height against the terrain clamp floor per step, and turn that record into an allow/refuse receipt (or a reason the record cannot be read).
 * @status ACTIVE
 *
 * WHY THE WHEEL IS NODE-SIDE. The dive is decided inside
 * `ScreenSpaceCameraController`'s zoom handler (`SSCCInputHelpers.js`) and its
 * terrain clamp (`ScreenSpaceCameraController.js`), which only run for input
 * the controller's event aggregator saw. `camera.zoomIn` bypasses both, and a
 * `WheelEvent` built in the page is untrusted and carries no cursor position,
 * so the step uses Playwright's `page.mouse.move` / `page.mouse.wheel`: the
 * same trusted wheel a user produces, delivered through the DOM listeners the
 * controller registered. The page functions below only place the camera and
 * read state; they are self-contained because `page.evaluate` serialises them.
 *
 * WHAT IT READS AND WHAT IT DOES NOT. Gate and depth are read from
 * `globe._water`, never the public `globe.water` accessor: the accessor
 * creates the facade, and the controller itself reads `_water` for the same
 * reason (a facade nobody created has the dive off). Only the placement step
 * touches `globe.water`, because setting `disableWaterCollision` needs it.
 *
 * THE RECEIPT CARRIES NO VERDICT. It says what the controller did (`gate`
 * "allow" / "refuse" / "mixed", the depth, whether the camera stayed at or
 * above `globeHeight + minimumZoomDistance`), not whether that was expected;
 * a rig or a spec holds the expectation. A record that cannot be read (no
 * facade, no terrain height under the camera, no steps) is a reason, never a
 * receipt.
 *
 * @module Tools/visual-regression/lib/globe-dive-gate-steps
 */

/** Camera-height slack below the clamp floor that still counts as held, in metres. */
export const CLAMP_TOLERANCE_METERS = 0.5;

/** One wheel notch: negative `deltaY` is a scroll up, which zooms in. */
export const DEFAULT_WHEEL_DELTA_Y = -120;

/**
 * Place the camera, set the facade's flag and report the canvas centre the
 * wheel will be aimed at. Runs in the page.
 *
 * @param {{lon: number, lat: number, height: number, heading?: number,
 *   pitch?: number, roll?: number, disableWaterCollision: boolean}} args
 * @returns {{ok: boolean, reason?: string, cursor?: {x: number, y: number}}}
 */
export function pagePlaceDiveCamera({
  lon,
  lat,
  height,
  heading = 0,
  pitch = -0.2,
  roll = 0,
  disableWaterCollision,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const Cesium = /** @type {any} */ (globalThis).Cesium;
  const scene = viewer?.scene;
  if (!scene) {
    return { ok: false, reason: "the page has no viewer.scene" };
  }
  if (!Cesium?.Cartesian3?.fromDegrees) {
    return { ok: false, reason: "the page has no Cesium namespace" };
  }
  const water = scene.globe?.water;
  if (!water) {
    return { ok: false, reason: "the globe has no water facade" };
  }
  water.disableWaterCollision = disableWaterCollision;
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading, pitch, roll },
  });
  scene.render();
  const canvas = scene.canvas;
  const rect = canvas.getBoundingClientRect();
  return {
    ok: true,
    cursor: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
}

/**
 * What the controller sees right now. Runs in the page. Reads `_water`, not
 * the public accessor (see the module header).
 *
 * @returns {{waterFacade: boolean, disableWaterCollision: (boolean|null),
 *   cameraHeight: (number|null), globeHeight: (number|null),
 *   minimumZoomDistance: (number|null), gateAllows: (boolean|null),
 *   diveDepthMeters: (number|null)}}
 */
export function pageReadDiveState() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer?.scene;
  const water = scene?.globe?._water;
  const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
  const globeHeight = finiteOrNull(scene?.globeHeight);
  const gate = water?.canDiveAtSurfaceHeight;
  return {
    waterFacade: Boolean(water),
    disableWaterCollision: water ? water.disableWaterCollision === true : null,
    cameraHeight: finiteOrNull(scene?.camera?.positionCartographic?.height),
    globeHeight,
    minimumZoomDistance: finiteOrNull(
      scene?.screenSpaceCameraController?.minimumZoomDistance,
    ),
    gateAllows:
      typeof gate === "function" ? gate.call(water, scene.globeHeight) : null,
    diveDepthMeters: finiteOrNull(water?.diveDepthMeters),
  };
}

/**
 * Drive one dive step and record it.
 *
 * @param {object} args
 * @param {{evaluate: Function, mouse: {move: Function, wheel: Function}}} args.page
 * @param {object} args.step The step data: `lon`, `lat`, `height`,
 *   `disableWaterCollision`, `wheelNotches`, and optionally `heading`,
 *   `pitch`, `roll`, `wheelDeltaY`, `settleFramesBeforeFirst` and
 *   `settleFramesPerNotch`.
 * @param {(frames: number) => Promise<unknown>} args.settle Renders that many
 *   frames in the page.
 * @returns {Promise<{record: object, outcome: object}>} The record and the
 *   receipt (or the reason it cannot be read) built from it.
 */
export async function runDiveGateSteps({ page, step, settle }) {
  const {
    wheelNotches,
    wheelDeltaY = DEFAULT_WHEEL_DELTA_Y,
    settleFramesBeforeFirst = 60,
    settleFramesPerNotch = 20,
    ...placement
  } = step;
  const record = {
    placement: {
      lon: placement.lon,
      lat: placement.lat,
      height: placement.height,
      disableWaterCollision: placement.disableWaterCollision,
    },
    placed: await page.evaluate(pagePlaceDiveCamera, placement),
    initial: null,
    steps: [],
  };
  if (record.placed.ok === true) {
    // The terrain under the camera has to load before `scene.globeHeight`
    // means anything.
    await settle(settleFramesBeforeFirst);
    record.initial = await page.evaluate(pageReadDiveState);
    await page.mouse.move(record.placed.cursor.x, record.placed.cursor.y);
    for (let notch = 0; notch < wheelNotches; notch++) {
      await page.mouse.wheel(0, wheelDeltaY);
      await settle(settleFramesPerNotch);
      record.steps.push({
        notch,
        ...(await page.evaluate(pageReadDiveState)),
      });
    }
  }
  return { record, outcome: buildDiveGateReceipt(record) };
}

const unreadable = (reason, detail) => ({ readable: false, reason, detail });

/**
 * Turn a dive record into an allow/refuse receipt, or say why it cannot.
 *
 * @param {{placed?: {ok: boolean, reason?: string}, initial?: object|null,
 *   steps?: Array<object>}} record What {@link runDiveGateSteps} recorded.
 * @returns {{readable: true, receipt: object}|{readable: false, reason:
 *   string, detail: string}} The receipt, or the reason it is unreadable.
 */
export function buildDiveGateReceipt(record) {
  if (record?.placed?.ok !== true) {
    return unreadable(
      "placement-failed",
      record?.placed?.reason ?? "the camera was never placed",
    );
  }
  const steps = record.steps ?? [];
  if (steps.length === 0) {
    return unreadable("no-steps", "no wheel notch was recorded");
  }
  const states = [record.initial, ...steps].filter(Boolean);
  if (states.some((state) => state.waterFacade !== true)) {
    return unreadable(
      "no-water-facade",
      "the controller's globe has no `_water` to gate on",
    );
  }
  const unreadField = (field) =>
    states.some((state) => !Number.isFinite(state[field]));
  if (unreadField("globeHeight")) {
    return unreadable(
      "globe-height-undefined",
      "scene.globeHeight was not a finite number under the camera",
    );
  }
  for (const field of ["cameraHeight", "minimumZoomDistance"]) {
    if (unreadField(field)) {
      return unreadable(`${field}-undefined`, `${field} was not finite`);
    }
  }
  if (
    states.some((state) => typeof state.gateAllows !== "boolean") ||
    states.some((state) => !Number.isFinite(state.diveDepthMeters))
  ) {
    return unreadable(
      "gate-readout-missing",
      "the gate or the dive depth could not be read",
    );
  }

  const allowed = steps.filter((step) => step.gateAllows === true).length;
  const gate =
    allowed === steps.length ? "allow" : allowed === 0 ? "refuse" : "mixed";
  const breaches = steps.filter(
    (step) =>
      step.cameraHeight <
      step.globeHeight + step.minimumZoomDistance - CLAMP_TOLERANCE_METERS,
  );
  const diveDepthMax = Math.max(...steps.map((step) => step.diveDepthMeters));
  const globeHeights = steps.map((step) => step.globeHeight);
  return {
    readable: true,
    receipt: {
      gate,
      collisionDisabled: record.placement.disableWaterCollision === true,
      globeHeight: record.initial.globeHeight,
      globeHeightRange: [Math.min(...globeHeights), Math.max(...globeHeights)],
      notches: steps.length,
      clampHeld: breaches.length === 0,
      clampBreaches: breaches.map((step) => step.notch),
      minCameraHeight: Math.min(...steps.map((step) => step.cameraHeight)),
      diveDepthMax,
      diveDepthGrew: diveDepthMax > 0,
      // Depth counted while the gate refused is an engine inconsistency worth
      // a row of its own, so it is reported rather than folded into `gate`.
      depthWhileRefused: gate === "refuse" && diveDepthMax > 0,
    },
  };
}
