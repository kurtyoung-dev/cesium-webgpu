#!/usr/bin/env node
/**
 * Probe: the weather-map seam (Weather Phase 1 / C2-16, the keystone).
 * @purpose Keystone C2-16 seam check: cloudWeatherMap ON makes coverage vary spatially across locations (high cell stddev); OFF stays uniform.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * Before: ProceduralClouds uses ONE global coverage scalar → cloud cover is
 * uniform across the whole sky (only FBM small-scale detail varies). After:
 * globe.defaultCloudCollection.volumetric.cloudWeatherMap=true makes the raymarcher sample a 2D lat/lon weather
 * texture per world position, so coverage varies SPATIALLY — distinct cloudy
 * regions + clear gaps.
 *
 * Test (WebGPU), high nadir view over a wide footprint:
 *   - weatherMap OFF: coarse grid of cloud-fraction cells has LOW stddev (uniform).
 *   - weatherMap ON : HIGH stddev (regional structure from the weather map).
 *   - OFF still renders clouds (no regression); ON has clear gaps (some cells ~0).
 *
 * RUNTIME (probe-kit harvest). The browser, the served-build preflight, the
 * Edge slot, the deadline and the receipt belong to `lib/probe-runtime.mjs`.
 * Every bar is the pre-migration probe's. ONE thing about the measurement
 * changed, and it is the reader: the old probe copied the live scene canvas
 * through `drawImage` inside the page after a rAF yield — the reader the fleet
 * contract prohibits, because a presented WebGPU swap-chain texture can read
 * back empty — and this one takes the runtime's element capture of the canvas
 * and reduces it in Node with `lib/metrics/bright-fraction.mjs` (the same
 * window, stride and bar). An element capture composites whatever the page
 * stacks over the canvas, and in a fresh browser context the viewer's
 * toolbar, navigation-help panel, timeline and credits all sit inside its
 * rectangle. So before the first capture the probe removes them with
 * `lib/strip-viewer-widgets.mjs`, records the count removed and anything left
 * over (`chromeRemoved`, `chromeLeftovers`) in each run of its report, and
 * refuses (exit 3) when anything still overlaps the canvas: the scored pixels
 * are the canvas's own again, as the old reader's were. The page, the dials,
 * the locations and the settles are unchanged. By default the probe still pins
 * neither the wall clock, the cloud wind, the cloud quality tier nor the
 * network globe (`C13-WEATHER-PROBE-FLEET-NETWORK-GLOBE-TAIL` owns the
 * default); `--clock`, `--cloud-wind-speed`, `--cloud-quality` and
 * `--offline-globe` pin them opt-in, each read back from the live scene and
 * refused (exit 3, `dial-not-applied`) when it did not take.
 *
 * FIRST FRAME. Before the first capture the probe waits on the render
 * pipeline cache (`pageWaitForPendingPipelines`); a first capture that is
 * still black is re-settled, then refused (`first-frame-black`,
 * `lib/first-frame-guard.mjs`): a black canvas is not a measurement.
 *
 * Usage (serve the built tree on a governed port first, e.g.
 * `node server.js --port 8094 --serve-built`):
 *   node Tools/visual-regression/probe-weather-map.mjs [--port 8094]
 * Out:
 *   Tools/visual-regression/output/weather-map/ — every located capture, the
 *   two wide views and the runtime's weather-map-report.json / -summary.md
 */
import { decodePng } from "../lib/png-decode.mjs";
import {
  CLOCK_OPTION,
  assertClockHeld,
  pinClock,
  clockFlagExitCode,
} from "./lib/clock-pin.mjs";
import {
  FIRST_FRAME_MAX_RESETTLES,
  guardFirstFrame,
} from "./lib/first-frame-guard.mjs";
import {
  PIPELINE_WAIT_DEFAULTS,
  pageReadPendingPipelines,
  pageWaitForPendingPipelines,
} from "./lib/landing-cell-stage.mjs";
import { brightFraction } from "./lib/metrics/bright-fraction.mjs";
import { sweepStats } from "./lib/metrics/sweep-stats.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";

const PAGE = "/Apps/CesiumViewer/index.html?renderer=webgpu";
const VIEW = { width: 1024, height: 768 };
const CANVAS = ".cesium-widget canvas";

// Far-apart geographic locations. With weatherMap ON they sample different
// weather-map regions → different coverage; with OFF they're uniform (global).
const LOCATIONS = [
  [-120.0, 45.0],
  [-105.0, 47.0],
  [-95.0, 38.0],
  [-82.0, 43.0],
  [-70.0, 42.0],
  [-90.0, 25.0],
  [-110.0, 30.0],
  [-75.0, 30.0],
  [-100.0, 33.0],
  [-118.0, 36.0],
];

/** The located nadir views and the wide keystone view, as before. */
const VIEWS = Object.freeze({
  located: { height: 250000.0, frames: 90 },
  wide: { lon: -95.0, lat: 38.0, height: 2600000.0, frames: 120 },
});

/** Scored bars — IDENTICAL to the pre-migration probe, which wrote them inline. */
const ASSERT = {
  brightThreshold: 120,
  sampleStride: 3,
  offMin: 0.1,
  onMax: 0.3,
  onMinFraction: 0.5,
};

/**
 * Per-run work budget. The old probe carried no watchdog at all; this is a
 * derived bound — boot (90 s load + 90 s viewer), twenty located settles of 90
 * frames, the two 120-frame wide views, and twenty-two element captures — not
 * a measured one.
 */
const BASE_WORK_BUDGET_MS = 600_000;

/**
 * Extra time the first-frame readiness can add: the pipeline wait before the
 * first capture and before each re-settle (each bounded by its own deadline),
 * plus one located settle and capture per re-settle. The 10 s per settle and
 * capture is the base budget's own share, (600 s - 180 s boot) / (22 settles
 * + 22 captures) rounded up, not a measured figure.
 */
const FIRST_FRAME_RESETTLES = FIRST_FRAME_MAX_RESETTLES;
const WORK_BUDGET_MS =
  BASE_WORK_BUDGET_MS +
  PIPELINE_WAIT_DEFAULTS.deadlineMs * (1 + FIRST_FRAME_RESETTLES) +
  10_000 * FIRST_FRAME_RESETTLES;

/** The page-side opt-in dials, as the flags declare them. */
export const MAP_DIAL_OPTIONS = Object.freeze([
  {
    flag: "--cloud-wind-speed",
    key: "cloudWindSpeed",
    kind: "non-negative-number",
  },
  { flag: "--cloud-quality", key: "cloudQuality", kind: "non-negative-number" },
  { flag: "--offline-globe", key: "offlineGlobe", kind: "boolean" },
]);

/**
 * Pure. The dials the command line asked for, or null when it asked for none
 * (then the run writes nothing to the scene and loads today's URL).
 *
 * @param {{cloudWindSpeed?: number, cloudQuality?: number,
 *   offlineGlobe?: boolean}} options Parsed probe options.
 * @returns {{cloudWindSpeed?: number, cloudQuality?: number,
 *   offlineGlobe?: true}|null}
 */
export function planMapDials(options) {
  const plan = {};
  if (options.cloudWindSpeed !== undefined) {
    plan.cloudWindSpeed = options.cloudWindSpeed;
  }
  if (options.cloudQuality !== undefined) {
    plan.cloudQuality = options.cloudQuality;
  }
  if (options.offlineGlobe === true) plan.offlineGlobe = true;
  return Object.keys(plan).length === 0 ? null : plan;
}

/**
 * Pure. The page URL: the offline globe asks the viewer app for no base
 * layer and no streamed terrain (`CesiumViewerStartupOptions`), as the weather
 * fleet's P1 pin does.
 *
 * @param {object} options Parsed probe options.
 * @returns {string}
 */
export function mapPageUrl(options) {
  return options.offlineGlobe === true ? `${PAGE}&offline=true` : PAGE;
}

/**
 * Pure. Whether the live scene reads back what the plan requested.
 *
 * @param {object|null} plan From {@link planMapDials}.
 * @param {object|null} observed From the page: `cloudWindSpeed`,
 *   `cloudQuality`, `imageryLayerCount`, `terrainIsEllipsoid`.
 * @returns {{applied: boolean, mismatches: Array<{dial: string,
 *   requested: unknown, observed: unknown}>}}
 */
export function judgeMapDials(plan, observed) {
  const mismatches = [];
  if (plan !== null) {
    const seen = observed ?? {};
    for (const dial of ["cloudWindSpeed", "cloudQuality"]) {
      if (plan[dial] !== undefined && seen[dial] !== plan[dial]) {
        mismatches.push({
          dial,
          requested: plan[dial],
          observed: seen[dial] ?? null,
        });
      }
    }
    if (plan.offlineGlobe === true) {
      if (seen.imageryLayerCount !== 0) {
        mismatches.push({
          dial: "offlineGlobe.imageryLayerCount",
          requested: 0,
          observed: seen.imageryLayerCount ?? null,
        });
      }
      if (seen.terrainIsEllipsoid !== true) {
        mismatches.push({
          dial: "offlineGlobe.terrainIsEllipsoid",
          requested: true,
          observed: seen.terrainIsEllipsoid ?? null,
        });
      }
    }
  }
  return { applied: mismatches.length === 0, mismatches };
}

/**
 * Set the dials, the lights and the camera, then render `frames` frames. With
 * `dials` (opt-in; null writes nothing) the requested wind, quality and
 * offline-globe pins are applied after the volumetric dials and read back at
 * the end of the settle, when a streamed layer or provider would have
 * reappeared; the answer is the readback, or null with no dials.
 */
export const SET_VIEW = async ({
  lon,
  lat,
  height,
  weatherOn,
  frames,
  dials,
}) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    s = v.scene,
    g = s.globe;
  g.defaultCloudCollection.enableVolumetric = true;
  g.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
  g.defaultCloudCollection.volumetric.cloudDensity = 0.9;
  g.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
  g.defaultCloudCollection.volumetric.cloudLayerTop = 4000;
  g.defaultCloudCollection.volumetric.cloudWeatherMap = weatherOn;
  if (dials) {
    const vol = g.defaultCloudCollection.volumetric;
    if (dials.cloudWindSpeed !== undefined) {
      vol.cloudWindSpeed = dials.cloudWindSpeed;
    }
    if (dials.cloudQuality !== undefined) vol.cloudQuality = dials.cloudQuality;
    if (dials.offlineGlobe) {
      g.imageryLayers.removeAll();
      if (!(g.terrainProvider instanceof C.EllipsoidTerrainProvider)) {
        g.terrainProvider = new C.EllipsoidTerrainProvider();
      }
    }
  }
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  if (s.moon) s.moon.show = false;
  s.skyBox.show = false;
  s.backgroundColor = C.Color.BLACK;
  s.globe.baseColor = C.Color.fromBytes(20, 20, 25);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(lon, lat, height),
    orientation: {
      heading: 0.0,
      pitch: C.Math.toRadians(-90.0),
      roll: 0.0,
    },
  });
  for (let i = 0; i < frames; i++) {
    s.render();
    await new Promise((res) => requestAnimationFrame(res));
  }
  if (!dials) return null;
  const vol = g.defaultCloudCollection.volumetric;
  return {
    cloudWindSpeed: vol.cloudWindSpeed,
    cloudQuality: vol.cloudQuality,
    imageryLayerCount: g.imageryLayers.length,
    terrainIsEllipsoid: g.terrainProvider instanceof C.EllipsoidTerrainProvider,
  };
};

/**
 * Score one run. Pure: the per-location bright fractions with the map OFF and
 * ON, and the filtered error list, go in; the gates and the numbers come out.
 *
 * @param {number[]} offFracs One fraction per location, map OFF.
 * @param {number[]} onFracs The same locations, map ON.
 * @param {string[]} errors New console/page errors, already filtered.
 * @returns {{checks: Array<[string, string, boolean]>, stats: object}}
 */
export function scoreMap(offFracs, onFracs, errors) {
  const off = sweepStats(offFracs, { digits: null });
  const on = sweepStats(onFracs, { digits: null });
  const offMin = Math.min(...offFracs),
    onMin = Math.min(...onFracs),
    onMax = Math.max(...onFracs);
  return {
    checks: [
      [
        "off-renders",
        `OFF renders clouds everywhere (min ${offMin.toFixed(3)} > ${ASSERT.offMin} — uniform coverage)`,
        offMin > ASSERT.offMin,
      ],
      [
        "on-dense",
        `ON renders dense clouds somewhere (max ${onMax.toFixed(3)} > ${ASSERT.onMax})`,
        onMax > ASSERT.onMax,
      ],
      [
        "on-carves",
        `ON carves clearer regions than uniform coverage (onMin ${onMin.toFixed(3)} < ${ASSERT.onMinFraction} * offMin ${offMin.toFixed(3)})`,
        onMin < offMin * ASSERT.onMinFraction,
      ],
      [
        "on-range",
        `ON has wider regional range than OFF (${on.range.toFixed(3)} > ${off.range.toFixed(3)})`,
        on.range > off.range,
      ],
      ["clean", `no NEW webgpu errors (${errors.length})`, errors.length === 0],
    ],
    stats: { off, on, offFracs, onFracs },
  };
}

/** The runtime descriptor: the located and wide captures run in `cells`. */
export const descriptor = {
  name: "weather-map",
  title:
    "Weather-map keystone: cloudWeatherMap ON varies coverage between locations, OFF stays uniform",
  outputSubdirectory: "weather-map",
  receiptEnvelope: "probe-owned",
  // The viewer page and the page lane both import this one ESM entry; the
  // Sandcastle2 bucket bundle in the runtime's default list is never loaded.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  workBudgetMs: () => WORK_BUDGET_MS,
  args: { extraOptions: [CLOCK_OPTION, ...MAP_DIAL_OPTIONS] },
  async cells({ browser, run, options, origin, outputDirectory, captures }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "volumetric clouds and the weather map are WebGPU-only, so a run on " +
          `${options.renderers.join(",")} would score an empty deck`,
        { renderers: options.renderers },
      );
    }
    const page = await browser.newPage({ viewport: VIEW });
    const errs = [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });
    page.on("pageerror", (e) => errs.push("PE:" + e.message));
    const url = mapPageUrl(options);
    await page.goto(`${origin}${url}`, {
      waitUntil: "networkidle",
      timeout: 90000,
    });
    await page.waitForFunction(() => !!window.viewer, null, {
      timeout: 90000,
    });
    // Opt-in (--clock): without it the viewer keeps the wall clock, as before.
    // SET_VIEW never touches the clock, so the pin holds through the run; the
    // read after the captures proves it.
    let clockPin =
      options.clock === undefined ? null : await pinClock(page, options.clock);

    // Opt-in dials: SET_VIEW applies them on every call and answers with the
    // scene's own readback, so a dial the scene dropped mid-run (a provider
    // swapped back, a layer re-added) refuses at the view that saw it.
    const dialPlan = planMapDials(options);
    const dialRecord =
      dialPlan === null
        ? null
        : { url, requested: dialPlan, observed: null, observedAtEnd: null };
    const setView = async (viewArgs) => {
      const observed = await page.evaluate(SET_VIEW, {
        ...viewArgs,
        dials: dialPlan,
      });
      if (dialPlan === null) return;
      const judged = judgeMapDials(dialPlan, observed);
      if (!judged.applied) {
        throw new ProbeRefusal(
          "dial-not-applied",
          "the scene does not read back the requested pins: " +
            judged.mismatches
              .map(
                (m) =>
                  `${m.dial} requested ${JSON.stringify(m.requested)}, ` +
                  `observed ${JSON.stringify(m.observed)}`,
              )
              .join("; "),
          { requested: dialPlan, observed, mismatches: judged.mismatches },
        );
      }
      dialRecord.observed ??= observed;
      dialRecord.observedAtEnd = observed;
    };

    const fracs = { off: [], on: [] };
    let chrome = null;
    let firstFrame = null;
    for (const weatherOn of [false, true]) {
      for (const [lon, lat] of LOCATIONS) {
        const located = {
          lon,
          lat,
          height: VIEWS.located.height,
          weatherOn,
          frames: VIEWS.located.frames,
        };
        await setView(located);
        const shotName = `located-${weatherOn ? "on" : "off"}-lon${lon}-lat${lat}`;
        const capture = async (name) => {
          const shot = await captureElement({
            page,
            selector: CANVAS,
            name,
            outputDirectory,
            captures,
          });
          return { name, shot, image: decodePng(shot.buffer) };
        };
        let taken;
        if (chrome === null) {
          // Once, before the first capture: wait for the render pipeline cache
          // to drain (the first frame is the one that has to compile them),
          // then the element capture must read the canvas, not the chrome over
          // it. Not earlier, because the viewer page hides its centred loading
          // indicator only after a frame has rendered, and the strip would
          // (rightly) refuse on it.
          const waitForPipelines = () =>
            page.evaluate(pageWaitForPendingPipelines, {
              ...PIPELINE_WAIT_DEFAULTS,
              readerSource: pageReadPendingPipelines.toString(),
            });
          const pipelines = await waitForPipelines();
          chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
          if (chrome.leftovers.length > 0) {
            throw new ProbeRefusal(
              "viewer-chrome-over-canvas",
              "an element capture composites what is stacked over the canvas, " +
                "and after the viewer widgets were removed these elements " +
                `still overlapped it: ${chrome.leftovers.join(", ")}`,
              { chrome },
            );
          }
          // A black first capture is a probe readiness gap (the globe was not
          // drawn yet), never a verdict: re-settle, then refuse.
          const guarded = await guardFirstFrame({
            capture: (attempt) =>
              capture(attempt === 0 ? shotName : `${shotName}-retry${attempt}`),
            resettle: async () => {
              await setView(located);
              return waitForPipelines();
            },
          });
          taken = guarded.accepted;
          firstFrame = {
            pipelines,
            attempts: guarded.attempts,
            minNonBlackPct: guarded.minNonBlackPct,
            maxResettles: guarded.maxResettles,
          };
        } else {
          taken = await capture(shotName);
        }
        fracs[weatherOn ? "on" : "off"].push(
          brightFraction(
            taken.image,
            ASSERT.brightThreshold,
            ASSERT.sampleStride,
          ).frac,
        );
      }
    }
    // Wide-orbit captures for the visual read (regional structure spans many
    // texels). Not scored.
    for (const weatherOn of [false, true]) {
      await setView({ ...VIEWS.wide, weatherOn });
      await captureElement({
        page,
        selector: CANVAS,
        name: `weather-map-wide-${weatherOn ? "on" : "off"}`,
        outputDirectory,
        captures,
      });
    }

    if (clockPin !== null) clockPin = await assertClockHeld(page, clockPin);

    const errors = errs.filter((e) => !/AtmosphereLUT|default layout/.test(e));
    const scored = scoreMap(fracs.off, fracs.on, errors);
    console.log(
      `weather-map run ${run}: OFF ${fracs.off.map((f) => f.toFixed(3)).join(", ")} | ` +
        `ON ${fracs.on.map((f) => f.toFixed(3)).join(", ")} | errs ${errors.length}`,
    );
    return [
      {
        run,
        errors,
        scored,
        chromeRemoved: chrome.removed,
        chromeLeftovers: chrome.leftovers,
        clockPin,
        dials: dialRecord,
        firstFrame,
      },
    ];
  },

  verdicts(cells) {
    return cells.flatMap((cell) =>
      cell.scored.checks.map(([id, claim, pass]) => ({
        id: cells.length > 1 ? `run${cell.run}:${id}` : id,
        claim,
        pass,
      })),
    );
  },
  receipt(cells) {
    return {
      page: PAGE,
      locations: LOCATIONS,
      views: VIEWS,
      assert: ASSERT,
      runs: cells,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode =
    clockFlagExitCode(descriptor.name) ?? (await runProbe(descriptor));
}
