#!/usr/bin/env node
/**
 * Dawn sun-disc acquisition probe.
 * @purpose Acquire a dual-backend dawn sweep of the solar disc and publish per-sample disc-centre versus disc-annulus luminance and chroma ratios with WebGL as the parity control.
 * @status ACTIVE
 *
 * This file is acquisition only. Its landing claimed no verdict, and only an
 * authorized machine-lane run against an already-served build can earn one. The
 * probe starts no server and builds nothing. Two full thirteen-sample two-backend
 * runs exist as of 2026-08-28; the "never been run" claim this paragraph used to
 * carry is retired here so a reader does not treat a paired acquisition as
 * blindness.
 *
 * THE SUBJECT. A maintainer screenshot dated 2026-08-24 shows a small dark,
 * brownish spot at the centre of the rendered solar disc, inside the bright
 * core, with the sun a few degrees above the horizon over terrain. The
 * measurement is the ratio of the disc CENTRE's mean luminance to the disc
 * ANNULUS's mean luminance, and the same ratio formed in blue-over-red so the
 * "brownish" half of the report is measured rather than inferred.
 *
 * THE BAR IS DERIVED-PENDING. The pre-registration says the FAIL bar comes
 * from the first WebGL sweep and never from a WebGPU sweep. This authoring
 * lane runs no browsers, so no WebGL sweep exists and every bound in
 * `SUN_DISC_DAWN_BAR` is null. The scorer reads a null bound as "no standing
 * to pass or fail" and folds the run to STRUCTURAL — it does not read it as
 * "everything passed". The first machine-lane sweep is what derives the bar.
 *
 * THE WebGL LEG IS A PARITY CONTROL, NOT A HEALTH REFERENCE. Both backends
 * draw this billboard from one shared scene-level resolution and two twin
 * shaders. If the two legs agree and BOTH sit far from the shipped intensity
 * law's own reference ratio, the reading is a shared-engine finding and a bar
 * derived from WebGL would certify agreement rather than correctness. The
 * artifact publishes `limbLawReferenceRatio` — derived from the shipped
 * limb-darkening coefficients alone, so it depends on neither backend — for
 * exactly that case.
 *
 * THREE DELIBERATE DEPARTURES FROM THE REPORTED SCENE, each disclosed in the
 * artifact:
 *
 *  - The vertical field of view is forced to 3 degrees. At the engine default
 *    of 60 degrees the sun's 0.5327 degree disc lands on about 3 px of radius,
 *    which cannot carry a centre-versus-annulus measurement at all.
 *  - The camera tracks the sun: each sample re-aims at the sun's own azimuth
 *    and altitude, so a narrow frame keeps the disc centred across the sweep.
 *  - The viewer runs in its `offline=true` mode, which carries no imagery and
 *    no terrain. The measurement is taken inside the solar disc, which sits
 *    above the horizon for every scored sample, so ground content cannot enter
 *    the region means; the SKY atmosphere is left on and asserted, because it
 *    is what gates the engine's own sun extinction path.
 *
 * WHAT THE SWEEP WINDOW IS. Thirteen five-minute steps from
 * 2026-08-24T22:10:00Z. Evaluating the engine's own sun position against an
 * east-north-up frame at the site puts that window at -1.89 degrees to +10.17
 * degrees of solar altitude, spanning the pre-registered band; the
 * screenshot's own instant sits inside it at +8.48 degrees. The probe records
 * the altitude the ENGINE reports at each sample and the gate scores those,
 * so a window that has drifted reads as blindness rather than as a finding.
 *
 * BELOW-HORIZON SAMPLES ARE EXCLUDED, NOT FAILED — AND THE ENGINE'S CULL FLAG
 * IS NOT WHAT EXCLUDES THEM. The sweep deliberately begins below the local
 * horizon. This paragraph used to assert that such a sample publishes
 * `sunVisible: false`; the 2026-08-28 acquisition measured
 * `isSunVisible === true` on all thirteen samples of BOTH legs, because
 * `Scene.updateEnvironment` culls only when the sun's six-solar-radii glow
 * sphere lies entirely inside the Earth occluder's cone — a far deeper
 * condition than the disc being occulted. The probe therefore publishes the
 * geometry the exclusion is actually made of: the sun's own angular radius, the
 * geocentric radius under the site and the site's geodetic height. The gate
 * derives the horizon dip from those and scores a sample only when the WHOLE
 * disc clears it, still requiring the two backends to AGREE about which samples
 * those are, because a disagreement there is a parity finding rather than noise.
 *
 * THE GLOBE MUST BE ON SCREEN BEFORE THE FIRST CAPTURE. The disc is composited
 * over whatever the frame already holds, and at the lowest samples that is the
 * Earth. On WebGPU a globe tile whose pipeline variant is not yet resident is
 * skipped entirely for that frame, and `globe.tilesLoaded` — which this probe
 * used to settle on — reports tile residency, not pipeline residency. The
 * 2026-08-28 acquisition captured a globe-less WebGPU frame beside a complete
 * WebGL one at the two lowest samples and published the difference as a 0.10
 * parity delta about the sun. The sweep now spends a bounded readiness gate on
 * a binned `Pass.GLOBE` command once per leg, at the lowest-sun view where the
 * globe fills the frame, and a leg that never reaches it reports blindness.
 *
 * THE REGISTERED ALTITUDES ARE FRAME-DEPENDENT. `Simon1994EphemerisProvider`
 * takes the ICRF branch when the IAU-2006 XYS chunks have loaded and the
 * TEME/pseudo-fixed fallback when they have not. The two differ at this epoch by
 * the precession accumulated since J2000, measured as -0.359 to -0.363 deg
 * across this sweep, so a no-server derivation and a served browser disagree by
 * that much on every sample. The probe publishes which branch was live at each
 * sample so the difference reads as provenance rather than as drift.
 *
 * THE PAGE INSTRUMENT IS EXTRACTABLE AND SELF-CONTAINED. Every helper the page
 * needs is declared INSIDE the evaluate callback between the page-instrument
 * markers; nothing in that block may reference a Node-scope binding, because a
 * Node-scope symbol referenced inside `page.evaluate` is a ReferenceError in
 * the browser and killed a probe on 2026-08-24. `sun-disc-dawn-gate.spec.mjs`
 * extracts the block, EXECUTES it in Node over fixtures, and separately proves
 * that none of this module's own top-level names appear inside it.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  FUSED_SNAPSHOT_BEGIN,
  FUSED_SNAPSHOT_END,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import {
  SUN_DISC_DAWN_BAR,
  SUN_DISC_DAWN_FIELD_OF_VIEW_DEGREES,
  SUN_DISC_DAWN_LIMB_REFERENCE_RATIO,
  SUN_DISC_DAWN_READINESS,
  SUN_DISC_DAWN_READINESS_WORST_CASE_MS,
  SUN_DISC_DAWN_REGIONS,
  SUN_DISC_DAWN_RENDERERS,
  SUN_DISC_DAWN_REPORTED_INSTANT_ISO,
  SUN_DISC_DAWN_SCHEMA,
  SUN_DISC_DAWN_SITE,
  SUN_DISC_DAWN_SWEEP,
  SUN_DISC_DAWN_VIEWPORT,
  evaluateSunDiscDawnSweep,
} from "./lib/sun-disc-dawn-gate.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const probeSourcePath = fileURLToPath(import.meta.url);
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputRoot = path.resolve(
  process.env.SUN_DISC_DAWN_OUTPUT_DIR ??
    path.join(toolDirectory, "output/sun-disc-dawn"),
);

// The fuse must outlast the worst case the readiness gate can spend, or a
// slow-but-honest cold pipeline would look like a hung run. Derived rather than
// written down, so raising the budget cannot quietly outgrow its own bound.
const RUN_WATCHDOG_MS = Math.max(
  420_000,
  SUN_DISC_DAWN_READINESS_WORST_CASE_MS + 180_000,
);
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const PROCESS_WATCHDOG_MS =
  BROWSER_LAUNCH_TIMEOUT_MS +
  RUN_WATCHDOG_MS +
  BROWSER_CLOSE_TIMEOUT_MS +
  60_000;

/** The plain-JSON framing the page instrument is handed. */
const PAGE_CONFIG = Object.freeze({
  site: SUN_DISC_DAWN_SITE,
  sweep: SUN_DISC_DAWN_SWEEP,
  regions: SUN_DISC_DAWN_REGIONS,
  fieldOfViewDegrees: SUN_DISC_DAWN_FIELD_OF_VIEW_DEGREES,
  viewport: SUN_DISC_DAWN_VIEWPORT,
  readiness: SUN_DISC_DAWN_READINESS,
});

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function serializeError(value) {
  const error = value instanceof Error ? value : new Error(String(value));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    watchdog: error.sunDiscDawnWatchdog ?? null,
  };
}

function validateLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { href: url.href, origin: url.origin };
}

function markerCount(source, marker) {
  let count = 0;
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    count++;
    cursor += marker.length;
  }
  return count;
}

/**
 * Fold this probe's own source through the fleet capture validators.
 *
 * Exported so the browser-free spec runs the same check the probe runs on
 * itself, rather than asserting the same property twice in two dialects.
 *
 * @param {string} source This module's source text.
 * @returns {object} The contract standing and its reasons.
 */
export function inspectSunDiscDawnCaptureContract(source) {
  const canonicalFailures = checkEmbeddedFusedSnapshotIsCanonical(source);
  const usageFailures = checkFusedCaptureUsage(source);
  const beginCount = markerCount(source, FUSED_SNAPSHOT_BEGIN);
  const endCount = markerCount(source, FUSED_SNAPSHOT_END);
  const singleBlock = beginCount === 1 && endCount === 1;
  return {
    canonical: canonicalFailures.length === 0,
    singleBlock,
    usageValid: usageFailures.length === 0,
    beginCount,
    endCount,
    failures: [
      ...canonicalFailures,
      ...usageFailures,
      ...(singleBlock
        ? []
        : [
            `fused snapshot markers must occur exactly once (BEGIN=${beginCount}, END=${endCount})`,
          ]),
    ],
  };
}

function readExact(file, expected, label, operations = fs) {
  const actual = operations.readFileSync(file);
  const bytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  if (!bytes.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from the run-owned canonical bytes`);
  }
  return bytes;
}

function writeOnceExact(file, bytes, label, operations = fs) {
  const canonical = Buffer.from(bytes);
  try {
    operations.writeFileSync(file, canonical, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  return readExact(file, canonical, label, operations);
}

function createRunPaths(runId, outputRoot = defaultOutputRoot) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("runId must be a UUID v4");
  }
  const root = path.resolve(outputRoot);
  const directory = path.join(root, runId);
  if (path.dirname(directory) !== root) {
    throw new Error("run directory escaped the configured output root");
  }
  return {
    root,
    directory,
    artifact: path.join(directory, `${runId}.json`),
  };
}

function prepareRunDirectory(paths, operations = fs) {
  operations.mkdirSync(paths.root, { recursive: true });
  operations.mkdirSync(paths.directory, { recursive: false });
}

function pngBytes(dataUrl, label) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new Error(`${label} is not a PNG data URL`);
  }
  const encoded = dataUrl.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical base64`);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length <= signature.length ||
    !bytes.subarray(0, 8).equals(signature)
  ) {
    throw new Error(`${label} did not decode to a complete PNG`);
  }
  return bytes;
}

async function closeBounded(instance, label, timeoutMs) {
  if (!instance) {
    return { attempted: false, closed: true, label };
  }
  let timer;
  try {
    const closed = await Promise.race([
      Promise.resolve()
        .then(() => instance.close())
        .then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return { attempted: true, closed, label };
  } catch (error) {
    return {
      attempted: true,
      closed: false,
      label,
      error: serializeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupOwned(owned) {
  const pageClose = await closeBounded(
    owned.page,
    "page",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  if (pageClose.closed) {
    owned.page = undefined;
  }
  const contextClose = await closeBounded(
    owned.context,
    "context",
    SESSION_CLOSE_TIMEOUT_MS,
  );
  if (contextClose.closed) {
    owned.context = undefined;
  }
  const browserClose = await closeBounded(
    owned.browser,
    "browser",
    BROWSER_CLOSE_TIMEOUT_MS,
  );
  if (browserClose.closed) {
    owned.browser = undefined;
  }
  return {
    pageClose,
    contextClose,
    browserClose,
    cleanupComplete:
      pageClose.closed && contextClose.closed && browserClose.closed,
  };
}

/**
 * Race an operation against a watchdog that proves teardown before it rejects.
 *
 * @param {Function} operation The bounded acquisition.
 * @param {Function} onTimeout Cleanup invoked when the timer wins.
 * @param {number} [timeoutMs] The bound.
 * @returns {Promise<*>} The operation's value.
 */
export async function withSunDiscDawnWatchdog(
  operation,
  onTimeout,
  timeoutMs = RUN_WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let evidence;
          try {
            evidence = await onTimeout();
          } catch (cleanupError) {
            const aggregate = new AggregateError(
              [
                new Error(`sun-disc watchdog expired after ${timeoutMs} ms`),
                cleanupError,
              ],
              "sun-disc watchdog cleanup failed",
            );
            aggregate.sunDiscDawnWatchdog = {
              timeoutMs,
              cleanupComplete: false,
            };
            reject(aggregate);
            return;
          }
          const error = new Error(
            evidence?.cleanupComplete
              ? `sun-disc watchdog expired after ${timeoutMs} ms`
              : `sun-disc watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.sunDiscDawnWatchdog = { timeoutMs, ...evidence };
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Acquire one backend's whole sweep inside the page.
 *
 * Everything this callback needs is declared inside it or arrives through the
 * single serializable argument. It must never close over a Node binding.
 *
 * @param {object} argument The renderer label and the plain-JSON framing.
 * @returns {Promise<object>} The measurement record.
 */
async function acquirePageMeasurement({ renderer, config }) {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;

  // ==BEGIN sun-disc-dawn-page-instrument==
  const RECIPROCAL_255 = 1 / 255;

  const relativeLuminance = (r, g, b) =>
    (0.2126 * r + 0.7152 * g + 0.0722 * b) * RECIPROCAL_255;

  // Region means over one immutable snapshot. `centerY` arrives in the GL
  // convention the engine publishes it in — y UP from the bottom-left — while
  // ImageData rows run top-down, so the flip happens here once and is recorded
  // beside the result rather than being assumed by a later reader.
  const measureDiscRegions = (
    imageData,
    centerX,
    centerYFromBottom,
    limbPx,
    regions,
  ) => {
    const { width, height, data } = imageData;
    const centreOuter = limbPx * regions.centreOuterFraction;
    const annulusInner = limbPx * regions.annulusInnerFraction;
    const annulusOuter = limbPx * regions.annulusOuterFraction;
    const centerYFromTop = height - 1 - centerYFromBottom;
    const accumulate = () => ({ pixels: 0, r: 0, g: 0, b: 0, luminance: 0 });
    const centre = accumulate();
    const annulus = accumulate();
    const lowX = Math.max(0, Math.floor(centerX - annulusOuter) - 1);
    const highX = Math.min(width - 1, Math.ceil(centerX + annulusOuter) + 1);
    const lowY = Math.max(0, Math.floor(centerYFromTop - annulusOuter) - 1);
    const highY = Math.min(
      height - 1,
      Math.ceil(centerYFromTop + annulusOuter) + 1,
    );
    for (let y = lowY; y <= highY; y++) {
      for (let x = lowX; x <= highX; x++) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerYFromTop;
        const radius = Math.sqrt(dx * dx + dy * dy);
        let bucket = null;
        if (radius <= centreOuter) {
          bucket = centre;
        } else if (radius >= annulusInner && radius <= annulusOuter) {
          bucket = annulus;
        }
        if (bucket === null) {
          continue;
        }
        const offset = (y * width + x) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        bucket.pixels += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.luminance += relativeLuminance(r, g, b);
      }
    }
    const finish = (bucket) => ({
      pixels: bucket.pixels,
      meanR: bucket.pixels > 0 ? bucket.r / bucket.pixels : Number.NaN,
      meanG: bucket.pixels > 0 ? bucket.g / bucket.pixels : Number.NaN,
      meanB: bucket.pixels > 0 ? bucket.b / bucket.pixels : Number.NaN,
      meanLuminance:
        bucket.pixels > 0 ? bucket.luminance / bucket.pixels : Number.NaN,
    });
    return {
      centre: finish(centre),
      annulus: finish(annulus),
      centerYFromTop,
      window: { lowX, highX, lowY, highY },
    };
  };

  // Local altitude and azimuth of a world-space direction, in degrees, from an
  // east-north-up basis built at the site. Written against plain arrays so the
  // browser-free spec can execute it with no Cesium types.
  const localAltitudeAzimuth = (east, north, up, relative) => {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const length = Math.sqrt(dot(relative, relative));
    if (!(length > 0)) {
      return { altitudeDegrees: Number.NaN, azimuthDegrees: Number.NaN };
    }
    const unit = [
      relative[0] / length,
      relative[1] / length,
      relative[2] / length,
    ];
    const e = dot(unit, east);
    const n = dot(unit, north);
    const u = dot(unit, up);
    const altitude = Math.asin(Math.max(-1, Math.min(1, u)));
    const azimuth = Math.atan2(e, n);
    return {
      altitudeDegrees: (altitude * 180) / Math.PI,
      azimuthDegrees: ((azimuth * 180) / Math.PI + 360) % 360,
    };
  };
  // Commands the scene has binned into the GLOBE pass, summed over the frustum
  // list. Zero both when no tile is visible AND when every visible tile was
  // skipped for an unresolved pipeline, which is exactly why it, and not
  // `tilesLoaded`, is the readiness signal. Backend-neutral: both renderers bin
  // into the same list. The pass index arrives as an argument so this stays a
  // total function over plain data with no engine barrel of its own.
  const countGlobeCommands = (scene, globePassIndex) => {
    if (!Number.isInteger(globePassIndex)) {
      return null;
    }
    const view = scene && scene._view;
    const binned = view && view.frustumCommandsList;
    if (!binned) {
      return null;
    }
    let total = 0;
    for (let index = 0; index < binned.length; index++) {
      const slots = binned[index] && binned[index].indices;
      total += slots ? slots[globePassIndex] | 0 : 0;
    }
    return total;
  };

  // Bounded, wall-clock wait for the globe to reach the screen.
  //
  // LOADING side only — nothing is read here, so yielding is safe, and it is
  // also mandatory: a WebGPU pipeline promise cannot settle without one. The
  // caller supplies a sleep that elapses REAL time rather than an animation
  // frame, because a headless page that is not compositing still has to let
  // that promise land.
  //
  // `tilesLoaded` is kept as a term but is not the signal: it reports tile
  // residency, and a resident tile with no resident pipeline draws nothing.
  const awaitGlobeReady = async (
    scene,
    globePassIndex,
    renderFrame,
    sleep,
    now,
    timeoutMs,
    pollMs,
  ) => {
    const started = now();
    let frames = 0;
    let ready = false;
    let commands = null;
    while (now() - started < timeoutMs) {
      renderFrame();
      frames++;
      commands = countGlobeCommands(scene, globePassIndex);
      if (scene?.globe?.tilesLoaded === true && commands > 0) {
        ready = true;
        break;
      }
      await sleep(pollMs);
    }
    return { ready, frames, commands, waitedMs: Math.round(now() - started) };
  };
  // ==END sun-disc-dawn-page-instrument==

  // ==BEGIN fused-snapshot-capture==
  const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decode = async (dataUrl) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("fused PNG decode failed"));
      });
      image.src = dataUrl;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const captureSnapshot = async () => {
      scene.render(timeFn());
      const dataUrl = canvas.toDataURL("image/png");
      const imageData = await decode(dataUrl);
      return { dataUrl, imageData };
    };
    return { captureSnapshot };
  };
  // ==END fused-snapshot-capture==

  const harnessErrors = [];
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  scene.sun.show = true;
  scene.globe.show = true;
  scene.skyAtmosphere.show = true;

  const frustum = scene.camera.frustum;
  const fovApplied = typeof frustum.fov === "number";
  if (fovApplied) {
    frustum.fov = C.Math.toRadians(config.fieldOfViewDegrees);
  } else {
    harnessErrors.push("page:camera-frustum-has-no-field-of-view");
  }

  const sitePosition = C.Cartesian3.fromDegrees(
    config.site.longitudeDegrees,
    config.site.latitudeDegrees,
    config.site.heightMeters,
  );
  const enu = C.Transforms.eastNorthUpToFixedFrame(sitePosition);
  const basis = (column) => {
    const axis = C.Matrix4.getColumn(enu, column, new C.Cartesian4());
    const vector = [axis.x, axis.y, axis.z];
    const length = Math.sqrt(
      vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2],
    );
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  };
  const east = basis(0);
  const north = basis(1);
  const up = basis(2);

  // The GLOBE pass slot the readiness signal indexes. If that export ever moves,
  // `indices[undefined]` is NaN, `| 0` makes it zero, and the gate would time
  // out on EVERY leg while looking like a real finding. Say so instead.
  const globePassIndex =
    C.Pass && Number.isInteger(C.Pass.GLOBE) ? C.Pass.GLOBE : null;
  if (globePassIndex === null) {
    harnessErrors.push("page:pass-globe-not-an-integer");
  }

  // The horizon the below-horizon exclusion is actually made of, read off the
  // engine's own ellipsoid rather than written down here: the geocentric radius
  // under the site, and the site's geodetic height. The gate derives the dip
  // from the pair, so the probe publishes measurements and no judgement.
  const ellipsoid = scene.globe?.ellipsoid ?? C.Ellipsoid.default;
  const siteSurface = ellipsoid.scaleToGeodeticSurface(
    sitePosition,
    new C.Cartesian3(),
  );
  const localEarthRadiusMeters = siteSurface
    ? C.Cartesian3.magnitude(siteSurface)
    : null;
  const siteCarto = C.Cartographic.fromCartesian(
    sitePosition,
    ellipsoid,
    new C.Cartographic(),
  );
  const siteHeightMeters = siteCarto ? siteCarto.height : null;
  if (localEarthRadiusMeters === null || siteHeightMeters === null) {
    harnessErrors.push("page:site-horizon-geometry-unreadable");
  }

  // One readiness spend per leg, filled in at the lowest-sun sample below.
  let globeReadiness = {
    ready: false,
    frames: 0,
    commands: null,
    waitedMs: 0,
  };

  const startMs = Date.parse(config.sweep.startIso);
  const samples = [];

  for (let index = 0; index < config.sweep.sampleCount; index++) {
    const requestedMs = startMs + index * config.sweep.stepMinutes * 60_000;
    const requestedIso = new Date(requestedMs).toISOString();
    const time = C.JulianDate.fromDate(new Date(requestedMs));
    const reasons = [];

    // One render at the sample instant so the engine resolves its own sun
    // position, then the camera is aimed from THAT position rather than from
    // an independently recomputed ephemeris.
    viewer.clock.currentTime = time;
    scene.render(time);
    const sunPositionWC = scene.context.uniformState.sunPositionWC;
    const relative = [
      sunPositionWC.x - sitePosition.x,
      sunPositionWC.y - sitePosition.y,
      sunPositionWC.z - sitePosition.z,
    ];
    const aim = localAltitudeAzimuth(east, north, up, relative);
    const sunDistanceMeters = Math.hypot(relative[0], relative[1], relative[2]);
    if (!Number.isFinite(aim.altitudeDegrees)) {
      reasons.push("sun-direction-unreadable");
    }

    scene.camera.setView({
      destination: sitePosition,
      orientation: {
        heading: C.Math.toRadians(aim.azimuthDegrees),
        pitch: C.Math.toRadians(aim.altitudeDegrees),
        roll: 0,
      },
    });

    // The globe has to be on screen before anything is composited over it, and
    // on WebGPU that is a PIPELINE question rather than a tile question. Spend
    // the readiness budget once, here, at the lowest-sun view — the sweep uses
    // one terrain encoding and therefore one pipeline variant, and this is the
    // only view in the sweep the globe fills.
    if (index === 0) {
      globeReadiness = await awaitGlobeReady(
        scene,
        globePassIndex,
        () => {
          scene.render(time);
        },
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        () => performance.now(),
        config.readiness.initialTimeoutMs,
        config.readiness.pollMs,
      );
    }

    // Yield ONLY on the loading side. The capture below renders and freezes a
    // PNG in one task, with no yield between the final render and the read.
    // A FIXED settle, not an exit on `tilesLoaded`: that flag was already true
    // at every sample after the first, so the loop it used to guard ran zero
    // frames and the sweep captured whatever the previous view had left.
    for (let frame = 0; frame < config.readiness.settleFrames; frame++) {
      scene.render(time);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const { captureSnapshot } = makeFusedSnapshotCapture(
      scene,
      canvas,
      () => time,
    );
    const snapshot = await captureSnapshot();

    const halo = scene.frameState.sunHalo;
    const extinction = scene.frameState.sunAtmosphereExtinction;
    const appearance = scene.frameState.sunDiscAppearance;
    const environmentState = scene._environmentState;
    if (!halo) {
      reasons.push("sun-halo-unpublished");
    }
    if (!environmentState) {
      reasons.push("environment-state-unreadable");
    }
    const geometryValid = halo?.geometryValid === true;
    const limbPx = halo?.limbPx ?? Number.NaN;
    const centerX = halo?.centerX ?? Number.NaN;
    const centerY = halo?.centerY ?? Number.NaN;
    const drawingBufferWidth = scene.context.drawingBufferWidth;
    const drawingBufferHeight = scene.context.drawingBufferHeight;
    if (
      drawingBufferWidth !== snapshot.imageData.width ||
      drawingBufferHeight !== snapshot.imageData.height
    ) {
      reasons.push("drawing-buffer-does-not-match-snapshot");
    }

    let regions = null;
    let regionWindow = null;
    if (geometryValid && Number.isFinite(limbPx) && limbPx > 0) {
      const measured = measureDiscRegions(
        snapshot.imageData,
        centerX,
        centerY,
        limbPx,
        config.regions,
      );
      regions = { centre: measured.centre, annulus: measured.annulus };
      regionWindow = {
        centerYFromTop: measured.centerYFromTop,
        ...measured.window,
      };
    }
    // Deliberately no judgement here: an unusable disc geometry is a FACT the
    // gate reads beside `sunVisible`, because a culled sun below the horizon
    // and a sun the projection could not locate are different findings.

    samples.push({
      index,
      requestedIso,
      observed: {
        sunAltitudeDegrees: aim.altitudeDegrees,
        sunAzimuthDegrees: aim.azimuthDegrees,
        sunVisible: environmentState
          ? environmentState.isSunVisible === true
          : null,
        // The sun's own angular radius, from the engine's solar radius and the
        // distance the frame actually used. The gate subtracts it from the
        // altitude so a disc the Earth has bitten into is excluded rather than
        // measured against globe pixels in its own annulus.
        solarAngularRadiusDegrees: sunDistanceMeters
          ? C.Math.toDegrees(
              Math.asin(Math.min(1, C.Math.SOLAR_RADIUS / sunDistanceMeters)),
            )
          : null,
        localEarthRadiusMeters,
        siteHeightMeters,
        // Which inertial-to-fixed branch the ephemeris took this frame. The two
        // differ at this epoch by the precession accumulated since J2000, so a
        // registration derived without the XYS chunks and an acquisition served
        // with them disagree by about a third of a degree on every sample.
        icrfFrameResolved:
          typeof C.Transforms?.computeIcrfToFixedMatrix === "function"
            ? C.Transforms.computeIcrfToFixedMatrix(time) !== undefined
            : null,
        globeReady: globeReadiness.ready === true,
        globeReadyWaitMs: globeReadiness.waitedMs,
        globeReadyFrames: globeReadiness.frames,
        globeCommands: countGlobeCommands(scene, globePassIndex),
        geometryValid,
        centerX,
        centerY,
        limbPx,
        skyAtmosphereVisible: scene.frameState.skyAtmosphereVisible === true,
        sunBloomActive: scene.frameState.sunBloomActive === true,
        bakeHaloGain: halo?.bakeHaloGain ?? null,
        discRadiance: halo?.discRadiance ?? null,
        useHdr: scene.highDynamicRange === true,
        limbDarkening: appearance
          ? { a0: appearance.a0, a1: appearance.a1, a2: appearance.a2 }
          : null,
        extinction: extinction
          ? { r: extinction.x, g: extinction.y, b: extinction.z }
          : null,
        frame: {
          width: snapshot.imageData.width,
          height: snapshot.imageData.height,
        },
        regionWindow,
      },
      regions,
      reasons,
      dataUrl: snapshot.dataUrl,
    });
  }

  return {
    renderer,
    samples,
    harnessErrors,
    runtime: {
      rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
      fovApplied,
      fieldOfViewRadians: fovApplied ? scene.camera.frustum.fov : null,
      requestRenderMode: scene.requestRenderMode === true,
      terrainProvider: String(
        scene.globe?.terrainProvider?.constructor?.name ?? "unknown",
      ),
      imageryLayerCount: scene.imageryLayers?.length ?? null,
      frameNumber: scene.frameState.frameNumber,
      globeReadiness,
      localEarthRadiusMeters,
      siteHeightMeters,
    },
  };
}

async function runBackend(browser, renderer, base, owned) {
  const session = { renderer, measurement: null, cleanup: null };
  let context;
  let page;
  const pending = new Set();
  const externalRequests = [];
  try {
    owned.phase = `${renderer}:context`;
    context = await browser.newContext({
      viewport: SUN_DISC_DAWN_VIEWPORT,
      deviceScaleFactor: 1,
    });
    owned.context = context;
    page = await context.newPage();
    owned.page = page;
    await page.addInitScript(errorGateInit);
    const consoleErrors = attachConsoleErrorGate(page);

    page.on("request", (request) => {
      pending.add(request);
      const url = request.url();
      try {
        const parsed = new URL(url);
        if (
          parsed.origin !== base.origin &&
          parsed.protocol !== "data:" &&
          parsed.protocol !== "blob:"
        ) {
          externalRequests.push(url);
        }
      } catch {
        externalRequests.push(url);
      }
    });
    page.on("requestfinished", (request) => pending.delete(request));
    page.on("requestfailed", (request) => pending.delete(request));

    owned.phase = `${renderer}:navigate`;
    await page.goto(
      `${base.href.replace(/\/$/u, "")}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: 60_000,
    });
    if (renderer === "webgpu") {
      await armWebGPUDevices(page);
    }

    owned.phase = `${renderer}:measure`;
    const measurement = await page.evaluate(acquirePageMeasurement, {
      renderer,
      config: PAGE_CONFIG,
    });
    owned.phase = `${renderer}:diagnostics`;
    const gpuGate =
      renderer === "webgpu"
        ? await collectGateErrors(page)
        : { errors: [], deviceLost: null, armedDevices: 0 };
    measurement.harnessErrors = [
      ...(measurement.harnessErrors ?? []),
      ...consoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...externalRequests.map(
        (url) => `non-loopback request escaped offline scene: ${url}`,
      ),
    ];
    measurement.diagnostics = {
      gpuGate,
      externalRequests: [...new Set(externalRequests)].sort(),
      pendingRequestsBeforeClose: pending.size,
    };
    session.measurement = measurement;
    return session;
  } finally {
    owned.phase = `${renderer}:cleanup`;
    const pageClose = await closeBounded(
      page,
      `${renderer} page`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    const contextClose = await closeBounded(
      context,
      `${renderer} context`,
      SESSION_CLOSE_TIMEOUT_MS,
    );
    if (pageClose.closed && owned.page === page) {
      owned.page = undefined;
    }
    if (contextClose.closed && owned.context === context) {
      owned.context = undefined;
    }
    session.cleanup = {
      pageClose,
      contextClose,
      pendingRequests: pending.size,
      complete: pageClose.closed && contextClose.closed && pending.size === 0,
    };
  }
}

async function acquireBothBackends(browser, base, owned) {
  const result = { sessions: [], cleanup: { complete: false } };
  try {
    for (const renderer of SUN_DISC_DAWN_RENDERERS) {
      result.sessions.push(await runBackend(browser, renderer, base, owned));
    }
    return result;
  } finally {
    const browserClose = await closeBounded(
      browser,
      "browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (browserClose.closed && owned.browser === browser) {
      owned.browser = undefined;
    }
    let lastResortClose = { attempted: false, closed: browserClose.closed };
    if (!browserClose.closed && owned.browser === browser) {
      try {
        // Fleet-visible last resort, deliberately unbounded: the terminating
        // process fuse in `main` owns a close that never returns.
        await browser.close();
        lastResortClose = { attempted: true, closed: true };
        owned.browser = undefined;
      } catch (error) {
        lastResortClose = {
          attempted: true,
          closed: false,
          error: serializeError(error),
        };
      }
    }
    result.cleanup = {
      browserClose,
      lastResortClose,
      sessions: result.sessions.map((session) => session.cleanup),
      complete:
        browserClose.closed &&
        result.sessions.length === SUN_DISC_DAWN_RENDERERS.length &&
        result.sessions.every((session) => session.cleanup?.complete === true),
    };
  }
}

function persistSampleImages(paths, sessions, operations = fs) {
  const records = {};
  for (const session of sessions) {
    for (const sample of session.measurement?.samples ?? []) {
      const label = `${session.renderer}-sample${String(sample.index).padStart(2, "0")}`;
      const bytes = pngBytes(sample.dataUrl, label);
      const file = path.join(paths.directory, `${label}.png`);
      const reread = writeOnceExact(file, bytes, label, operations);
      records[label] = {
        file: path.basename(file),
        bytes: reread.length,
        sha256: sha256(reread),
      };
      delete sample.dataUrl;
    }
  }
  return records;
}

function artifactWithStatus(status, fields) {
  return {
    schema: SUN_DISC_DAWN_SCHEMA,
    instrument: "cesium.sun-disc-dawn-probe.v1",
    disclosures: {
      acquisitionOnly: true,
      authoringRunState: "NEVER RUN IN AUTHORING LANE",
      verdictClaimedByLanding: false,
      barState:
        "DERIVED-PENDING: the bar is derived from the first WebGL sweep and never from a WebGPU sweep, so no bound exists on this landing and no family can pass or fail.",
      webglLegRole:
        "The WebGL leg is a PARITY CONTROL, not a health reference. Two agreeing legs far from limbLawReferenceRatio is a shared-engine reading, not agreement that the disc is correct.",
      narrowFieldOfView: `The probe forces camera.frustum.fov to ${SUN_DISC_DAWN_FIELD_OF_VIEW_DEGREES} degrees; at the engine default of 60 the solar disc spans about 3 px of radius and cannot carry the metric.`,
      sunTrackingCamera:
        "The camera re-aims at the sun's own azimuth and altitude at every sample so a narrow frame keeps the disc centred across the sweep.",
      offlineScene:
        "The viewer runs in offline mode: no imagery and no terrain. The sky atmosphere is left on and asserted, because it gates the engine's sun extinction path.",
      belowHorizonSamples:
        "A sample is scored only when the engine reports the sun visible AND the whole disc clears the local horizon derived from the published site geometry. The engine's own cull is a six-solar-radii bounding-sphere test and stays true well below the horizon, so it alone would score a below-horizon sample as sky over sky; a disagreement between backends about which samples those are is itself a parity finding.",
      globeReadiness:
        "The readiness gate waits for at least one binned Pass.GLOBE command before the first capture, once per leg. tilesLoaded reports tile residency, not pipeline residency, and on WebGPU a tile whose pipeline variant is not yet resident is skipped entirely - a leg that captured before that lands is compositing the disc over an empty frame.",
      ephemerisFrame:
        "icrfFrameResolved records which inertial-to-fixed branch Simon1994EphemerisProvider took. The ICRF branch carries precession and nutation and the TEME fallback does not, so at this epoch the two disagree by about -0.36 degrees of solar altitude on every sample of this sweep.",
      luminanceSpace:
        "Luminance is Rec.709 over the display-referred framebuffer bytes, not a linear radiance.",
      reportedInstant: SUN_DISC_DAWN_REPORTED_INSTANT_ISO,
      limbLawReferenceRatio: SUN_DISC_DAWN_LIMB_REFERENCE_RATIO,
    },
    ...fields,
    status,
    exitCode: exitCodeForS5Status(status),
  };
}

/**
 * Acquire and score one dawn sweep.
 *
 * @param {object} [options] Run options.
 * @returns {Promise<object>} The artifact, its quiescence and its publication.
 */
export async function runSunDiscDawnProbe(options = {}) {
  const operations = options.operations ?? fs;
  const runId = options.runId ?? randomUUID();
  const paths = createRunPaths(runId, options.outputRoot);
  prepareRunDirectory(paths, operations);
  const startedAt = new Date().toISOString();
  const source = operations.readFileSync(probeSourcePath, "utf8");
  const capturePreflight = inspectSunDiscDawnCaptureContract(source);
  const owned = {
    browser: undefined,
    context: undefined,
    page: undefined,
    phase: "preflight",
  };
  let artifact;
  let images = {};
  let quiescent = true;
  try {
    if (capturePreflight.failures.length > 0) {
      artifact = artifactWithStatus("STRUCTURAL", {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        structural: capturePreflight.failures,
        failures: [],
        harnessErrors: [],
        images: {},
      });
    } else {
      owned.phase = "browser-launch";
      const browser = await chromium.launch({
        channel: "msedge",
        headless: !options.headed,
        args: ["--enable-unsafe-webgpu"],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      owned.browser = browser;
      quiescent = false;
      const acquisition = await withSunDiscDawnWatchdog(
        () => acquireBothBackends(browser, options.base, owned),
        () => cleanupOwned(owned),
        options.watchdogMs ?? RUN_WATCHDOG_MS,
      );
      quiescent =
        acquisition.cleanup.complete === true &&
        !owned.browser &&
        !owned.context &&
        !owned.page;
      images = persistSampleImages(paths, acquisition.sessions, operations);

      const byRenderer = Object.fromEntries(
        acquisition.sessions.map((session) => [session.renderer, session]),
      );
      const evidence = {
        samples: Object.fromEntries(
          SUN_DISC_DAWN_RENDERERS.map((renderer) => [
            renderer,
            byRenderer[renderer]?.measurement?.samples ?? null,
          ]),
        ),
      };
      const evaluation = evaluateSunDiscDawnSweep(evidence, {
        bar: options.bar ?? SUN_DISC_DAWN_BAR,
      });
      const harnessErrors = acquisition.sessions.flatMap((session) =>
        (session.measurement?.harnessErrors ?? []).map(
          (reason) => `${session.renderer}:${reason}`,
        ),
      );
      artifact = artifactWithStatus(evaluation.status, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        captureContract: { ...capturePreflight, writeOnce: true },
        bar: evaluation.bar,
        limbLawReferenceRatio: evaluation.limbLawReferenceRatio,
        families: evaluation.families,
        measurements: evaluation.measurements,
        structural: evaluation.structural,
        failures: evaluation.failures,
        unproven: evaluation.unproven,
        harnessErrors,
        images,
        sessions: acquisition.sessions.map((session) => ({
          renderer: session.renderer,
          runtime: session.measurement?.runtime ?? null,
          diagnostics: session.measurement?.diagnostics ?? null,
          samples: session.measurement?.samples ?? null,
          cleanup: session.cleanup,
        })),
        cleanup: acquisition.cleanup,
      });
    }
  } catch (error) {
    let terminalCleanup;
    try {
      terminalCleanup = await cleanupOwned(owned);
      quiescent = terminalCleanup.cleanupComplete === true;
    } catch (cleanupError) {
      quiescent = false;
      terminalCleanup = {
        complete: false,
        error: serializeError(cleanupError),
      };
    }
    artifact = artifactWithStatus("ERROR", {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      captureContract: { ...capturePreflight, writeOnce: true },
      structural: [],
      failures: [],
      harnessErrors: [serializeError(error)],
      images,
      cleanup: terminalCleanup ?? { complete: false },
    });
  }

  const artifactBytes = Buffer.from(stableJson(artifact));
  const reread = writeOnceExact(
    paths.artifact,
    artifactBytes,
    "final evidence",
    operations,
  );
  return {
    artifact,
    quiescent,
    publication: {
      file: paths.artifact,
      bytes: reread.length,
      sha256: sha256(reread),
    },
  };
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-sun-disc-dawn.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]\n\n" +
      "Requires an already-running loopback server and a current Build/CesiumUnminified build.",
  );
}

function parseArguments(argv) {
  const parsed = {
    base: validateLoopbackBase(defaultBase),
    outputRoot: defaultOutputRoot,
    headed: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[++index];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      return value;
    };
    if (argument === "--base") {
      parsed.base = validateLoopbackBase(nextValue());
    } else if (argument === "--output-directory") {
      parsed.outputRoot = path.resolve(nextValue());
    } else if (argument === "--headed") {
      parsed.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(exitCodeForS5Status("PASS"));
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return parsed;
}

async function main() {
  // The in-run watchdog can only reject if the event loop returns. This
  // terminating fuse stays armed through bounded teardown and the evidence
  // write, and is the construct that ends a wedged run.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[sun-disc-dawn] process watchdog fired after ${PROCESS_WATCHDOG_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  let quiescent = false;
  try {
    const result = await runSunDiscDawnProbe(
      parseArguments(process.argv.slice(2)),
    );
    quiescent = result.quiescent === true;
    console.log(
      JSON.stringify(
        {
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          runId: result.artifact.runId,
          evidence: result.publication,
        },
        null,
        2,
      ),
    );
    process.exitCode = exitCodeForS5Status(result.artifact.status);
  } catch (error) {
    console.error("[sun-disc-dawn] uncaught probe failure", error);
    process.exitCode = exitCodeForS5Status("ERROR");
  } finally {
    if (quiescent) {
      clearTimeout(processWatchdog);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
