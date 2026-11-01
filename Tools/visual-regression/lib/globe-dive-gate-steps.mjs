/**
 * The camera controller's water dive gate as a step sequence: place the camera
 * at a lon/lat, set the water facade's `disableWaterCollision`, wheel-zoom in
 * through the real controller and record, per step, whether the gate allowed
 * the dive and whether the terrain clamp held the camera.
 * @purpose Globe-family dive-gate steps: place the camera, set `globe.water.disableWaterCollision`, wheel-zoom in N notches with Playwright's trusted mouse and settle after each, read the controller's gate (`canDiveAtSurfaceHeight`), `diveDepthMeters` and the camera's height against the terrain clamp floor per step, and turn that record into an allow/refuse receipt (or a reason the record cannot be read); also the landing probe's dive-gate cell page (`runDiveGateCellPage`, step data and the pre-registered gate read from the staged rig's dials) and its verdict (`diveGateVerdict`: the observed gate against the registered one, NOT RUN when unreadable).
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
 * WHERE CESIUM COMES FROM. The placement imports the Cesium module by URL
 * (`moduleUrl`, default {@link DEFAULT_CESIUM_MODULE_URL}) instead of reading
 * `globalThis.Cesium`: Apps/CesiumViewer, the landing probe's page, exposes
 * only `viewer`. The record names the URL the placement used.
 *
 * THE RECEIPT CARRIES NO VERDICT. It says what the controller did (`gate`
 * "allow" / "refuse" / "mixed", the depth, whether the camera stayed at or
 * above `globeHeight + minimumZoomDistance`), not whether that was expected;
 * a rig or a spec holds the expectation. A record that cannot be read (no
 * facade, no terrain height under the camera, no steps) is a reason, never a
 * receipt.
 *
 * WHY EVERY FRAME IS A WIDGET FRAME. The landing stage stops the viewer's
 * render loop, so the page only renders what the probe drives. The wheel
 * input is consumed, and `scene.globeHeight` refreshed, in
 * `Scene.initializeFrame()` and nowhere else; `scene.render()` alone never
 * does either. The placement therefore drives one widget frame
 * (`initializeFrame()` then `render()`, as `CesiumWidget.prototype.render`
 * does) after `setView`, and the probe's `settle` does the same per frame
 * (`lib/landing-page-frames.mjs`). A record whose camera never moved over the
 * wheel is not a measurement of the gate: it is unreadable (`wheel-unread`).
 *
 * @module Tools/visual-regression/lib/globe-dive-gate-steps
 */

/** Camera-height slack below the clamp floor that still counts as held, in metres. */
export const CLAMP_TOLERANCE_METERS = 0.5;

/**
 * An online page whose surface reads within this of 0 m read the bare
 * ellipsoid: the streamed terrain never arrived, so the page is void.
 */
export const STREAMED_TERRAIN_VOID_METERS = 0.5;

/**
 * Where the page's Cesium module is served from. Apps/CesiumViewer does not
 * put a `Cesium` namespace on `globalThis` (only Sandcastle does), so the
 * placement imports the module the way `probe-weather-map.mjs` does; the
 * module is the one the viewer already loaded, so `Cartesian3` is the same
 * class the scene uses.
 */
export const DEFAULT_CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** One wheel notch: negative `deltaY` is a scroll up, which zooms in. */
export const DEFAULT_WHEEL_DELTA_Y = -120;

/**
 * Place the camera, set the facade's flag and report the canvas centre the
 * wheel will be aimed at. Runs in the page; the Cesium module is imported
 * from `moduleUrl` (the default is spelled out because `page.evaluate`
 * serialises this function without the module's constants).
 *
 * @param {{lon: number, lat: number, height: number, heading?: number,
 *   pitch?: number, roll?: number, disableWaterCollision: boolean,
 *   moduleUrl?: string}} args
 * @returns {Promise<{ok: boolean, moduleUrl: string, reason?: string,
 *   cursor?: {x: number, y: number}}>}
 */
export async function pagePlaceDiveCamera({
  lon,
  lat,
  height,
  heading = 0,
  pitch = -0.2,
  roll = 0,
  disableWaterCollision,
  moduleUrl = "/Build/CesiumUnminified/index.js",
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer?.scene;
  if (!scene) {
    return {
      ok: false,
      moduleUrl,
      reason: "the page has no viewer.scene",
    };
  }
  let Cesium = null;
  let importError = null;
  try {
    Cesium = await import(moduleUrl);
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  if (!Cesium?.Cartesian3?.fromDegrees) {
    return {
      ok: false,
      moduleUrl,
      reason:
        importError === null
          ? `the Cesium module at ${moduleUrl} has no Cartesian3.fromDegrees`
          : `the Cesium module at ${moduleUrl} could not be imported: ${importError}`,
    };
  }
  const water = scene.globe?.water;
  if (!water) {
    return { ok: false, moduleUrl, reason: "the globe has no water facade" };
  }
  water.disableWaterCollision = disableWaterCollision;
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading, pitch, roll },
  });
  // One widget frame: with the render loop stopped, a bare `render()` would
  // leave `globeHeight` stale.
  scene.initializeFrame();
  scene.render(viewer.clock?.currentTime);
  const canvas = scene.canvas;
  const rect = canvas.getBoundingClientRect();
  return {
    ok: true,
    moduleUrl,
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
 *   `pitch`, `roll`, `wheelDeltaY`, `settleFramesBeforeFirst`,
 *   `settleFramesPerNotch` and `moduleUrl` (where the page imports Cesium
 *   from; {@link DEFAULT_CESIUM_MODULE_URL}).
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
    moduleUrl = DEFAULT_CESIUM_MODULE_URL,
    ...placement
  } = step;
  const record = {
    placement: {
      lon: placement.lon,
      lat: placement.lat,
      height: placement.height,
      disableWaterCollision: placement.disableWaterCollision,
      moduleUrl,
    },
    placed: await page.evaluate(pagePlaceDiveCamera, {
      ...placement,
      moduleUrl,
    }),
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

const unreadable = (reason, detail, cameraHeights = null) => ({
  readable: false,
  reason,
  detail,
  cameraHeights,
});

/** The camera height series of a record: the initial read, then each notch. */
const cameraHeightSeries = (record) =>
  [record.initial, ...(record.steps ?? [])].map((state) =>
    Number.isFinite(state?.cameraHeight) ? state.cameraHeight : null,
  );

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
  const cameraHeights = cameraHeightSeries(record);
  const unreadField = (field) =>
    states.some((state) => !Number.isFinite(state[field]));
  if (unreadField("globeHeight")) {
    return unreadable(
      "globe-height-undefined",
      `scene.globeHeight was not a finite number under the camera (camera heights ${JSON.stringify(cameraHeights)} m)`,
      cameraHeights,
    );
  }
  for (const field of ["cameraHeight", "minimumZoomDistance"]) {
    if (unreadField(field)) {
      return unreadable(
        `${field}-undefined`,
        `${field} was not finite`,
        cameraHeights,
      );
    }
  }
  // A camera that never moved over the wheel means the wheel never reached
  // the controller: the gate was not exercised, so nothing here is a reading.
  if (cameraHeights.every((height) => height === cameraHeights[0])) {
    return unreadable(
      "wheel-unread",
      `the camera stayed at ${cameraHeights[0]} m over ${steps.length} notches`,
      cameraHeights,
    );
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
      cameraHeights,
      minCameraHeight: Math.min(...steps.map((step) => step.cameraHeight)),
      diveDepthMax,
      diveDepthGrew: diveDepthMax > 0,
      // Depth counted while the gate refused is an engine inconsistency worth
      // a row of its own, so it is reported rather than folded into `gate`.
      depthWhileRefused: gate === "refuse" && diveDepthMax > 0,
    },
  };
}

/** The gate answers a rig may pre-register for a dive page. */
export const DIVE_GATE_EXPECTATIONS = Object.freeze(["allow", "refuse"]);

/** What a gate-only cell's frame compare reads as, wherever a reader looks. */
export const GATE_ONLY_FRAMES_REASON = "not-comparable: gate-only cell";

/**
 * The mark a rig that declares `frames: "gate-only"` puts on its pages: the
 * frame compare (dive against control, WebGL against WebGPU, base against tip)
 * is removed, and the mark says so and whose declaration removed it, so a
 * byte-identical pair is not read as a pass of anything visual. A rig that
 * declares nothing has no mark (null) and its frames stay comparable. Pure.
 *
 * @param {{id?: string, frames?: string}} [rig]
 * @returns {{comparable: false, removed: string, reason: string,
 *   declaredBy: string}|null}
 */
export function framesMarkOf(rig) {
  if (rig?.frames !== "gate-only") {
    return null;
  }
  return {
    comparable: false,
    removed: "frame-compare",
    reason: GATE_ONLY_FRAMES_REASON,
    declaredBy: `rig ${rig.id ?? "(unnamed)"} frames: "gate-only"`,
  };
}

/**
 * One dive-gate cell page: the step data, the collision flag and the
 * pre-registered gate come from the staged rig's dials (`diveGateStep`,
 * `diveCollisionDisabled`, `diveGateExpected`; a cell's variant lays the
 * flag and the expectation over the rig's own), the wheel is driven through
 * {@link runDiveGateSteps}, and the receipt lands in the page record.
 *
 * A rig that carries no step data yields an unreadable outcome (a NOT RUN
 * verdict), never a thrown error, so one mis-declared cell does not hide the
 * other pages of the run.
 *
 * @param {object} input
 * @param {object} input.page The Playwright page (or a stub with the same
 *   `evaluate` and `mouse`).
 * @param {{dials?: object}} input.rig The rig this page staged (variant dials
 *   already laid over it).
 * @param {(frames: number) => Promise<unknown>} input.settle
 * @returns {Promise<{diveGate: {step: (object|null), record: (object|null),
 *   outcome: object, expected: (string|null), frames: (object|null)}}>}
 */
export async function runDiveGateCellPage({ page, rig, settle }) {
  const dials = rig?.dials ?? {};
  const expected = Object.hasOwn(dials, "diveGateExpected")
    ? dials.diveGateExpected
    : null;
  const data = dials.diveGateStep;
  const frames = framesMarkOf(rig);
  if (data === null || typeof data !== "object") {
    return {
      diveGate: {
        step: null,
        record: null,
        expected,
        frames,
        outcome: unreadable(
          "step-missing",
          `rig ${rig?.id ?? "(unnamed)"} carries no diveGateStep dial`,
        ),
      },
    };
  }
  const step = {
    ...data,
    disableWaterCollision: dials.diveCollisionDisabled === true,
  };
  const { record, outcome } = await runDiveGateSteps({ page, step, settle });
  return { diveGate: { step, record, outcome, expected, frames } };
}

/**
 * The verdict of a dive-gate page: the gate the controller showed against the
 * gate the cell registered. The id is the page's, suffixed `:dive-gate`.
 *
 * A page with no `diveGate` has no verdict (null). An outcome that cannot be
 * read, or a page whose rig registered no allow / refuse, is NOT RUN, which
 * fails the run: a requested measurement that did not happen is not a pass.
 * `clampHeld` rides along for the reader; the pass is the gate alone. A page
 * of a gate-only cell (the rig declared `frames: "gate-only"`) carries
 * `frames`, the mark that its frame compare was removed.
 * `clockHeld` says whether the stage read back the rig's pinned instant,
 * frozen (null when the page record carries no stage clock): a frame lit by
 * the wall clock is not the scene the rig declared.
 *
 * @param {string} id The page's id.
 * @param {{diveGate?: object, stage?: {clock?: object}}} record A page record.
 * @returns {object|null}
 */
export function diveGateVerdict(id, record) {
  const verdict = gateVerdictOf(id, record);
  if (verdict === null) {
    return null;
  }
  // On the entry itself, so a reader of the verdict sees that this cell's
  // frames were removed from the compare; the gate fields are untouched.
  const frames = record.diveGate.frames ?? null;
  return {
    ...verdict,
    clockHeld: stageClockHeld(record?.stage?.clock),
    ...(frames === null ? {} : { frames }),
  };
}

/**
 * Whether a stage clock record holds the instant the rig pinned: requested,
 * read back equal, and frozen. Pure.
 *
 * @param {{requested?: string|null, observed?: string, frozen?: boolean}} [clock]
 * @returns {boolean|null}
 */
export function stageClockHeld(clock) {
  if (clock === null || typeof clock !== "object") {
    return null;
  }
  return (
    typeof clock.requested === "string" &&
    clock.observed === clock.requested &&
    clock.frozen === true
  );
}

function gateVerdictOf(id, record) {
  const dive = record?.diveGate;
  if (!dive) {
    return null;
  }
  const verdictId = `${id}:dive-gate`;
  const expected = dive.expected ?? null;
  const outcome = dive.outcome;
  if (outcome?.readable !== true) {
    return {
      id: verdictId,
      pass: false,
      notRun: true,
      expected,
      observed: null,
      clampHeld: null,
      cameraHeights: outcome?.cameraHeights ?? null,
      reason: `${outcome?.reason ?? "no-outcome"}: ${outcome?.detail ?? "the dive was not read"}`,
    };
  }
  const { receipt } = outcome;
  if (!DIVE_GATE_EXPECTATIONS.includes(expected)) {
    return {
      id: verdictId,
      pass: false,
      notRun: true,
      expected,
      observed: receipt.gate,
      clampHeld: receipt.clampHeld,
      cameraHeights: receipt.cameraHeights,
      reason: `expected-gate-missing: the rig registered ${JSON.stringify(expected)}, not allow or refuse`,
    };
  }
  // The gate is judged only where the surface under the camera is the one the
  // cell was placed over: a gate read over the wrong ground says nothing about
  // the controller.
  const height = receipt.globeHeight;
  const window = dive.step?.globeHeightWindow ?? null;
  const voidReason =
    record?.network === "online" &&
    Math.abs(height) < STREAMED_TERRAIN_VOID_METERS
      ? `terrain-not-streamed: globeHeight ${height} m on an online page is the bare ellipsoid; the page is void, not a pass`
      : window !== null && !(height >= window.min && height <= window.max)
        ? `globe-height-off-window: globeHeight ${height} m is outside the registered [${window.min}, ${window.max}] m; a rig finding (a mislocated point), not the controller's`
        : null;
  if (voidReason !== null) {
    return {
      id: verdictId,
      pass: false,
      notRun: true,
      expected,
      observed: receipt.gate,
      clampHeld: receipt.clampHeld,
      cameraHeights: receipt.cameraHeights,
      globeHeight: height,
      globeHeightWindow: window,
      reason: voidReason,
    };
  }
  return {
    id: verdictId,
    pass: receipt.gate === expected,
    globeHeightWindow: window,
    expected,
    observed: receipt.gate,
    clampHeld: receipt.clampHeld,
    collisionDisabled: receipt.collisionDisabled,
    globeHeight: receipt.globeHeight,
    cameraHeights: receipt.cameraHeights,
    notches: receipt.notches,
    diveDepthMax: receipt.diveDepthMax,
    depthWhileRefused: receipt.depthWhileRefused,
  };
}
