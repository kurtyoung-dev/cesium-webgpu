// weather-lane-fixtures.mjs — fixture page-lane answers for the pinned weather
// probes, and the stub browser that serves them to the probes' descriptors.
// @purpose Fixture lane answers (pins, dials, slots, readiness, sweeps and one healthy lane per pinned weather probe) and a stub Playwright browser that answers each probe's page calls with them, so the runtime descriptors run end to end under node --test.
// @status ACTIVE
//
// WHERE IT COMES FROM. These builders and the stub browser were written in
// `weather-probe-descriptors.spec.mjs` and moved here unchanged apart from
// three things: each top-level declaration gained `export` (Prettier then
// re-wrapped `seamLanes`'s signature), the stub page gained the opt-in
// `pageErrors`, and `fakeLaunch` and `drive` pass that option through. They
// moved so a second spec, `weather-probe-gates.spec.mjs`, drives the same
// lanes instead of carrying copies. Nothing here renders and no number here is
// evidence about the engine: a lane answer stands in for what the probe's page
// lane returns in Edge.
//
// HOW THE STUB PAGE ANSWERS. `page.evaluate` is answered by the source of the
// function it is handed: the error gate's two functions by their
// `__armWebGPUDevice` / `__webgpuGate` markers, the capture-liveness read by
// `__captureLiveness`, and each probe's page lane by a marker its own source
// carries (the `*_MARKER` constants below). A call nothing here models throws,
// so an unmodelled page call is a red test rather than an undefined.

import fs from "node:fs";
import path from "node:path";

import { encodeRgbaPng } from "../../lib/png-rgba.mjs";
import { runProbe } from "./probe-runtime.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 4x4 grey PNG as a data url, standing in for a same-task canvas freeze. */
export const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(
  encodeRgbaPng(new Uint8Array(4 * 4 * 4).fill(128), 4, 4),
).toString("base64")}`;

export const healthyPins = (over = {}) => ({
  rendererType: "webgpu",
  isWebGPU: true,
  useDefaultRenderLoop: false,
  requestRenderMode: false,
  shouldAnimate: false,
  clockMultiplier: 0,
  imageryLayersBefore: 1,
  imageryLayersAfter: 0,
  ellipsoidTerrain: true,
  terrainForced: true,
  showGroundAtmosphere: false,
  enableLighting: false,
  canvas: { width: 1024, height: 768 },
  ...over,
});

export const healthyDials = (over = {}) => ({
  cloudWindSpeed: 0,
  cloudQuality: 32,
  cloudCastShadows: false,
  cloudContributesIBL: false,
  ...over,
});

export const slots = (over = {}) => ({
  time: 1000,
  maxSteps: 32,
  weatherMapEnabled: 1,
  qualityFlags: 0,
  channelStrength: 1,
  ...over,
});

export const readiness = () => ({
  globeReady: { binnedGlobeCommands: 96, firstBinnedMs: 412, elapsedMs: 3011 },
  proceduralReady: { waitedFrames: 4, executeCalls: 3 },
  configured: { ok: true },
});

/** One sweep as a page lane returns it; `pngAt` marks the documentary legs. */
export function sweep(label, lons, fracs, { pngAt = [], slotOver = {} } = {}) {
  return {
    label,
    captures: lons.map((lon, i) => ({
      lon,
      settledFrames: 12,
      png: pngAt.includes(lon) ? PNG_DATA_URL : null,
      slots: slots(slotOver),
      frac: fracs[i],
      meanMax: 100,
      samples: 20000,
    })),
  };
}

// ---------------------------------------------------------------------------
// The stub browser
// ---------------------------------------------------------------------------

/**
 * `pageErrors` lets a spec put an uncaught page error in front of a probe:
 * each message is delivered, as an `Error`, to every `pageerror` listener
 * the moment the probe registers it, so a probe's own console/page-error
 * collection sees it and its `clean` gate can be shown to fail. Without it
 * the page raises nothing, as before.
 *
 * @param {{calls: string[]}} log
 * @param {Array<{marker: string, respond: Function}>} lanes Page lanes by a
 *   marker their source carries, answered with fixture results. These probes
 *   capture through the pin harness in the page, never through an element
 *   screenshot, so the page offers no `locator` (a call would throw).
 * @param {{pageErrors?: string[]}} [options]
 */
export function fakePage(log, lanes, { pageErrors = [] } = {}) {
  return {
    on(event, listener) {
      if (event === "pageerror") {
        for (const message of pageErrors) listener(new Error(message));
      }
    },
    async addInitScript() {
      log.calls.push("init");
    },
    async addStyleTag() {},
    async goto(url) {
      log.calls.push(`goto:${url}`);
    },
    async waitForFunction() {},
    async waitForTimeout() {},
    async close() {},
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        return { gateArmed: true, deviceLost: null, frameNumber: 7 };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      for (const lane of lanes) {
        if (source.includes(lane.marker)) {
          log.calls.push(`lane:${lane.marker}`);
          return lane.respond(arg);
        }
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 160)}`);
    },
  };
}

export function fakeLaunch(log, lanes, pageOptions = {}) {
  return async () => {
    log.launches += 1;
    let connected = true;
    return {
      isConnected: () => connected,
      async newPage() {
        return fakePage(log, lanes, pageOptions);
      },
      async close() {
        connected = false;
      },
    };
  };
}

/**
 * Run a descriptor through `runProbe` against the stub browser.
 *
 * @param {object} [pageOptions] Passed to every stub page (`pageErrors`).
 * @returns {Promise<{code: number, out: string, log: object}>}
 */
export async function drive(
  descriptor,
  root,
  lanes,
  extraArgv = [],
  pageOptions = {},
) {
  const out = path.join(root, "out");
  const log = { calls: [], launches: 0 };
  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      ...extraArgv,
    ],
    now: () => Date.UTC(2026, 8, 26, 23, 0, 0),
    launch: fakeLaunch(log, lanes, pageOptions),
  });
  return { code, out, log };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Lane answers: the coverage sweep (edr-mock and its WCS declaration)
// ---------------------------------------------------------------------------

export const SWEEP_LONS = [-160, -120, -80, -40, 0, 40, 80, 120, 160];

/** A coverage-sweep lane answer: rising west -> east unless told otherwise. */
export function coverageLane({
  fracsA = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  fracsB,
  pins = healthyPins(),
  dials = healthyDials(),
  urlSuffix,
} = {}) {
  return (cfg) => {
    const suffix =
      urlSuffix ??
      (cfg.sourceClass === "EdrWeatherSource"
        ? `/collections/${cfg.collection}/cube?parameter-name=TCDC&f=CoverageJSON`
        : `/collections/${cfg.collection}/coverage?bbox=-180,-90,180,90&f=CoverageJSON`);
    return {
      sourceUrl: `${cfg.mockBase}${suffix}`,
      providerState: { hasData: true, version: 1, lastError: null },
      pins,
      dials,
      readiness: readiness(),
      applied: { fixture: { ok: true } },
      sweeps: {
        sweepA: sweep("sweepA", cfg.lonSweep, fracsA, {
          pngAt: [cfg.lonSweep[0], cfg.lonSweep[cfg.lonSweep.length - 1]],
        }),
        sweepB: sweep("sweepB", cfg.lonSweep, fracsB ?? fracsA),
      },
    };
  };
}

export const COVERAGE_MARKER = 'await sweep("sweepA"';

// ---------------------------------------------------------------------------
// Lane answers: channels
// ---------------------------------------------------------------------------

export const CHANNEL_LONS = [-170, -130, -90, -50, -10, 30, 70, 110, 150];

export function channelsLane({
  rich = [0.05, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95],
  richB,
  neutral = [0.5, 0.52, 0.5, 0.52, 0.5, 0.52, 0.5, 0.52, 0.5],
  richOff = [0.5, 0.51, 0.5, 0.51, 0.5, 0.51, 0.5, 0.51, 0.5],
  offStrength = 0,
} = {}) {
  return (cfg) => ({
    pins: healthyPins(),
    dials: healthyDials(),
    readiness: {
      ...readiness(),
      configuredOff: { ok: true },
      configuredBackOn: { ok: true },
    },
    applied: {
      rich: { ok: true },
      neutral: { ok: true },
      richOff: { ok: true },
    },
    richState: { hasData: true, version: 2, lastError: null },
    sweeps: {
      richA: sweep("richA", cfg.lonSweep, rich, {
        pngAt: [cfg.lonSweep[0], cfg.lonSweep[cfg.lonSweep.length - 1]],
      }),
      neutral: sweep("neutral", cfg.lonSweep, neutral),
      richOff: sweep("richOff", cfg.lonSweep, richOff, {
        slotOver: { channelStrength: offStrength },
      }),
      richB: sweep("richB", cfg.lonSweep, richB ?? rich),
    },
  });
}

export const CHANNELS_MARKER = 'await sweep("richA"';

// ---------------------------------------------------------------------------
// Lane answers: ingest
// ---------------------------------------------------------------------------

export const INGEST_MARKER = 'captureLeg("hiA"';

export function ingestLane({ hiA = 40, hiB = 40.5, lo = 2 } = {}) {
  return (cfg) => {
    const leg = (label, deck, png) => ({
      label,
      settledFrames: 20,
      png: png ? PNG_DATA_URL : null,
      slots: slots(),
      deck,
      samples: 100000,
    });
    return {
      api: {
        hasProvider: true,
        hasEdr: true,
        hasSynthetic: true,
        hasPacker: true,
      },
      edrUrl:
        "https://example.invalid/collections/x/cube?parameter-name=TCDC&f=CoverageJSON",
      pins: healthyPins(),
      dials: healthyDials(),
      readiness: readiness(),
      applied: { hi: { ok: true }, lo: { ok: true }, hiBack: { ok: true } },
      states: {
        hi: { hasData: true, version: 1, lastError: null },
        lo: { hasData: true, version: 2, lastError: null },
      },
      legs: {
        hiA: leg("hiA", hiA, true),
        hiB: leg("hiB", hiB, false),
        lo: leg("lo", lo, true),
      },
      region: cfg.region,
    };
  };
}

// ---------------------------------------------------------------------------
// Lane answers: metar (two page lanes with the aim between them)
// ---------------------------------------------------------------------------

export const METAR_SETUP_MARKER = "configuredCalibration = configure(0.0)";
export const METAR_SWEEPS_MARKER = 'await sweep("ch1A"';

export function metarLanes({
  calibrationFrac = 0.5,
  bandOn = 0.6,
  bandOff = 0.5,
} = {}) {
  const witnesses = new Set([-60, 0, 60]);
  const capture = (lon, frac, strength, png) => ({
    lon,
    settledFrames: 12,
    png: png ? PNG_DATA_URL : null,
    slots: slots({ channelStrength: strength }),
    frac,
    meanMax: 100,
    samples: 40000,
  });
  return [
    {
      marker: METAR_SETUP_MARKER,
      respond: (cfg) => ({
        caps: { capId: "metar:mock", supportsTime: false },
        providerState: { hasData: true, version: 1, lastError: null },
        pins: healthyPins(),
        dials: healthyDials(),
        readiness: readiness(),
        applied: { fixture: { ok: true } },
        calibration: {
          label: "calibration",
          captures: [...cfg.calibrationLons, ...cfg.witnessLons].map((lon) =>
            capture(lon, witnesses.has(lon) ? 1 : calibrationFrac, 0, false),
          ),
        },
      }),
    },
    {
      marker: METAR_SWEEPS_MARKER,
      respond: (aim) => {
        const onFrac = (lon) => (lon === -120 ? 0 : lon === 0 ? 1 : bandOn);
        const sweepOf = (label, lons, fracOf, strength, pngLons = []) => ({
          label,
          captures: lons.map((lon) =>
            capture(lon, fracOf(lon), strength, pngLons.includes(lon)),
          ),
        });
        return {
          readiness: {
            configuredOn: { ok: true },
            configuredOff: { ok: true },
            configuredBackOn: { ok: true },
          },
          dials: healthyDials(),
          sweeps: {
            ch1A: sweepOf("ch1A", aim.strengthOneLons, onFrac, 1, [
              -120,
              0,
              aim.bandLons[0],
            ]),
            ch0: sweepOf("ch0", aim.bandLons, () => bandOff, 0, [
              aim.bandLons[0],
            ]),
            ch1B: sweepOf("ch1B", aim.strengthOneLons, onFrac, 1),
          },
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Lane answers: seam-poles
// ---------------------------------------------------------------------------

export const SEAM_SETUP_MARKER =
  "const configured = globalThis.__cloudProbe.configure";
export const SEAM_CAPTURE_MARKER = "const ring = secSum.map";

/**
 * `spokes` puts the pre-fix pole signature on the north lane (both captures,
 * so its determinism control still reproduces): one dark sector on a ring of
 * 60 (mean 55, maxDev 55, a deviation BELOW the mean) and a 250 hot pixel in
 * the block's corner rather than at its centre element.
 */
export function seamLanes({
  wall = false,
  cloudFrac = 0.5,
  spokes = false,
} = {}) {
  const smooth = Array.from({ length: 819 }, (_, i) => 100 + (i % 7));
  const spoked = (tag) => spokes && tag.startsWith("npole");
  const cornerHot = Array(81).fill(52);
  cornerHot[0] = 250;
  return [
    {
      marker: SEAM_SETUP_MARKER,
      respond: () => ({
        pins: healthyPins(),
        dials: healthyDials(),
        readiness: readiness(),
      }),
    },
    {
      marker: SEAM_CAPTURE_MARKER,
      respond: (cfg) => ({
        tag: cfg.tag,
        settledFrames: 30,
        cols:
          wall && cfg.tag.startsWith("dateline")
            ? smooth.map((v, i) => (i < 409 ? 20 : 200))
            : smooth,
        cloudFrac,
        ring: spoked(cfg.tag)
          ? [...Array(11).fill(60), 0]
          : Array.from({ length: 12 }, (_, i) => 50 + (i % 3)),
        center: spoked(cfg.tag) ? cornerHot : Array(81).fill(52),
        png: PNG_DATA_URL,
        slots: slots(),
      }),
    },
  ];
}
