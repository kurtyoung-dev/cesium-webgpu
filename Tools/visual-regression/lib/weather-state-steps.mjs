/**
 * The weather-state page steps of the landing cells E-W-*: read the managed
 * cloud collection's weather state with the deck on, switch the deck off,
 * render a few frames, read it again, and the pure verdict over the two reads.
 * @purpose Page-side weather-state read-back and deck-off step for the landing cells of kind weather-state (E-W-ground, E-W-ground-hdr, E-W-30km, E-W-30km-hdr), and the pure Node verdict of the W3 job's pre-registered E-W identity claim: on WebGPU the managed collection's weather state and provider are defined with the deck on and the state is undefined after enableVolumetric = false plus five frames, on WebGL it is undefined throughout; a tree without the field answers absent, and a missing read is NOT RUN.
 * @status ACTIVE
 *
 * WHERE THE CLAIM COMES FROM. The W3 cloud Edge-identity job (SUMMARY_Tarondor
 * section 1, row "E-W identity"): "TIP(8) WebGL collection._weatherState
 * undefined; TIP(8) WebGPU: _weatherState defined (provider present) with the
 * deck on, undefined after enableVolumetric=false + 5 frames, on 8/8 pages".
 * The job read it through a private copy of the landing probe; this piece is
 * that read-back as a kit step, so the cells run under the kit's own verdicts
 * and exit fold.
 *
 * WHAT IS READ. `scene.globe.defaultCloudCollection` is the managed
 * collection (`Globe.beginFrame` calls its `_updateWeather`, which creates
 * `_weatherState` when the deck is on and a feature renderer for the cloud
 * collection exists, and destroys it otherwise; WebGL has none). The read
 * carries the field presence (`hasWeatherStateField`: a tree before the weather
 * state has no such property, which is the BEFORE arm's answer, not a
 * failure), whether the state and its provider are defined, the collection's
 * show / render mode / volumetric gate, the volumetric dials the cell staged,
 * the WebGPU cloud cache's serials and switches, and the frame number. The
 * banked instrument also read the sky LUT and the god-ray dials; no verdict
 * reads them and they are not reproduced.
 *
 * @module Tools/visual-regression/lib/weather-state-steps
 */

/** Frames rendered after the deck is switched off, before the second read. */
export const WEATHER_STATE_DISABLE_FRAMES = 5;

/** Suffix of the verdict id: `<idPrefix>:weather-state`. */
export const WEATHER_STATE_VERDICT = "weather-state";

/**
 * PAGE SIDE. The managed collection's weather state. Self-contained: passed to
 * `page.evaluate`, so it closes over nothing.
 *
 * @returns {object} The read-back, JSON-safe.
 */
export function pageReadWeatherState() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const scene = viewer.scene;
  const context = scene.context;
  const collection = scene.globe && scene.globe.defaultCloudCollection;
  const volumetric = collection && collection.volumetric;
  const cache = context && context._cloudCache;
  const pick = (source, keys) => {
    if (!source) {
      return null;
    }
    const out = {};
    for (const key of keys) {
      out[key] = source[key] === undefined ? null : source[key];
    }
    return out;
  };
  return {
    rendererType: String(
      (context && context.rendererType) ||
        (context && context.isWebGPU ? "webgpu" : "webgl"),
    ).toLowerCase(),
    frameNumber: scene.frameState ? scene.frameState.frameNumber : null,
    managed: collection
      ? {
          show: collection.show,
          renderMode: collection.renderMode,
          enableVolumetric: collection.enableVolumetric,
          hasWeatherStateField: "_weatherState" in collection,
          weatherState: collection._weatherState !== undefined,
          weatherProvider:
            !!collection._weatherState && !!collection._weatherState.provider,
        }
      : null,
    dials: pick(volumetric, [
      "cloudWeatherMap",
      "cloudWeatherSeed",
      "cloudGeographicWind",
      "cloudContributesIBL",
    ]),
    cloudCache: pick(cache, [
      "executeSerial",
      "densityMomentsEnabled",
      "primaryReuseApplied",
      "maskCaptureEnabled",
      "reconstructionEnabled",
    ]),
    volumetricCloudFrameNumber:
      context && context.volumetricCloudFrameNumber !== undefined
        ? context.volumetricCloudFrameNumber
        : null,
  };
}

/**
 * PAGE SIDE. Switch the managed deck off and render `frames` frames at the
 * frozen clock, as the probe's own settle does. Self-contained.
 *
 * @param {{frames: number}} input
 * @returns {Promise<{frames: number, enableVolumetric: boolean|null,
 *   threw: string|null}>}
 */
export async function pageDisableManagedDeck({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const collection =
    viewer.scene.globe && viewer.scene.globe.defaultCloudCollection;
  if (!collection) {
    return {
      frames: 0,
      enableVolumetric: null,
      threw: "no managed collection",
    };
  }
  try {
    collection.enableVolumetric = false;
    for (let i = 0; i < frames; i++) {
      viewer.scene.render(viewer.clock.currentTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } catch (error) {
    return {
      frames,
      enableVolumetric: collection.enableVolumetric,
      threw: String(error && error.message ? error.message : error),
    };
  }
  return { frames, enableVolumetric: collection.enableVolumetric, threw: null };
}

/**
 * Read the weather state with the deck on, switch the deck off, read again.
 * Runs after the cell's capture, so the first read is of the captured frame's
 * state and nothing that was measured is touched.
 *
 * @param {{page: object, frames?: number}} input
 * @returns {Promise<{weatherStateOn: object, weatherDisable: object,
 *   weatherStateOff: object}>}
 */
export async function runWeatherStateSteps({
  page,
  frames = WEATHER_STATE_DISABLE_FRAMES,
}) {
  const weatherStateOn = await page.evaluate(pageReadWeatherState);
  const weatherDisable = await page.evaluate(pageDisableManagedDeck, {
    frames,
  });
  const weatherStateOff = await page.evaluate(pageReadWeatherState);
  return { weatherStateOn, weatherDisable, weatherStateOff };
}

/**
 * The E-W identity verdict of one page record. Pure.
 *
 * - A read that is missing, or whose managed collection could not be found, is
 *   NOT RUN (`pass: false`, `notRun: true`, no unmeasured marker: the page
 *   could not be read, which is a fault in the run and fails it).
 * - A tree whose collection has no `_weatherState` field on either read answers
 *   `absent`: it predates the weather state, as the W3 job's BEFORE arm did,
 *   and the verdict passes with `absent: true` so the sheet says so.
 * - WebGPU passes when the state and its provider are defined with the deck on
 *   and the state is undefined after the deck is switched off.
 * - WebGL passes when the state is undefined on both reads.
 *
 * @param {string} idPrefix `<cell>:<renderer>:<page>:run<n>`.
 * @param {{renderer?: string, weatherStateOn?: object, weatherDisable?: object,
 *   weatherStateOff?: object}|null|undefined} record A page record.
 * @returns {{id: string, pass: boolean, notRun?: boolean, absent?: boolean,
 *   reason?: string, expected?: object, observed?: object}}
 */
export function weatherStateVerdict(idPrefix, record) {
  const id = `${idPrefix}:${WEATHER_STATE_VERDICT}`;
  const on = record?.weatherStateOn?.managed ?? null;
  const off = record?.weatherStateOff?.managed ?? null;
  if (on === null || off === null) {
    return {
      id,
      pass: false,
      notRun: true,
      reason:
        "the managed cloud collection was not read before and after the deck was switched off",
    };
  }
  if (record.weatherDisable?.threw) {
    return {
      id,
      pass: false,
      notRun: true,
      reason: `switching the deck off threw: ${record.weatherDisable.threw}`,
    };
  }
  if (on.hasWeatherStateField !== true && off.hasWeatherStateField !== true) {
    return {
      id,
      pass: true,
      absent: true,
      reason: "this tree's managed cloud collection has no _weatherState field",
    };
  }
  const webgpu =
    (record.weatherStateOn.rendererType ?? record.renderer) === "webgpu";
  const expected = webgpu
    ? {
        onState: true,
        onProvider: true,
        offState: false,
        deckOffAfterDisable: true,
      }
    : { onState: false, onProvider: false, offState: false };
  const observed = {
    onState: on.weatherState === true,
    onProvider: on.weatherProvider === true,
    offState: off.weatherState === true,
    ...(webgpu ? { deckOffAfterDisable: off.enableVolumetric === false } : {}),
  };
  const pass = Object.keys(expected).every(
    (key) => observed[key] === expected[key],
  );
  return {
    id,
    pass,
    expected,
    observed,
    ...(pass
      ? {}
      : {
          reason: `${webgpu ? "WebGPU" : "WebGL"} weather state read ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`,
        }),
  };
}
