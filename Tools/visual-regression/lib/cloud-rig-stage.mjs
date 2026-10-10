/**
 * Stages a cloud rig's scene in a CesiumViewer page: its dials, its clock and
 * its camera, so a probe declares WHICH rig it measures instead of re-writing
 * the same setup function.
 * @purpose Turns a cloud rig into a serialisable stage payload (Node side), applies it in the page through the cloud probe harness (scene dials, CloudVolumetrics dials with their round trip, the clock, a camera that may be stated relative to the sun's azimuth), settles it and reads the canvas in the task of the final render, and banks that frame (one arm); the same read and acceptance serve a page the probe staged itself (one demo leg).
 * @status ACTIVE
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND HARNESS. The harvest found the
 * same twenty-line setup in every W-series cloud gate (phase, ambient, time of
 * day, aerial) and in the ten stash-A/B probes it archived: hide the sky box,
 * the atmosphere and the sun over black, set three or four cloud dials, freeze
 * the clock, point the camera. Two things in the kit come close and neither
 * does it. `lib/capture.mjs`'s `defaultCellWork` navigates and waits for
 * readiness but never reads a rig's `camera`, `clock` or `dials` — they reach
 * the replay key and nothing else. `lib/cloud-probe-harness.mjs`'s
 * `__cloudProbe.configure` sets `CloudVolumetrics` properties and proves each
 * one round-tripped, and nothing else. So this module does the rest and hands
 * the cloud dials to `configure` rather than setting them itself: the round
 * trip stays in one place.
 *
 * THE DEFECT IT STRUCTURALLY CLOSES. Since Batch 622 moved the cloud dials off
 * the globe, sixteen cloud probes guarded their assignments with
 * `if ("cloudCoverage" in g)` where `g` is the globe — a property `Globe.js` no
 * longer declares — so the assignments under the guard never run. A rig staged
 * here cannot fail that way: every `cloud*` dial goes through `configure`,
 * which throws on a key `CloudVolumetrics` does not have and on a value that
 * did not round-trip.
 *
 * TWO HALVES, ONE FILE. `cloudRigStagePayload` is pure Node and refuses a rig
 * it cannot stage before a browser is involved; `captureCloudRigArm` is the
 * Node side of one arm. `stageCloudRigInPage` and `settleCloudRigInPage` run
 * in the page through `page.evaluate`, so they are self-contained: no import,
 * no module-scope name (the settle's canvas reader is the kit's block, copied
 * in), and the Cesium namespace comes from the payload's `moduleUrl`. The page
 * needs `installCloudProbeHarness` as an init script before it loads.
 *
 * A CAMERA RELATIVE TO THE SUN. The phase and ambient gates aim the camera AT
 * the sun's azimuth (or a fixed turn from it) at whatever instant they run, so
 * their rigs record `camera.headingReference: "sun-azimuth"` and a heading that
 * is an OFFSET. The page resolves the sun's local azimuth exactly as those
 * probes did — one `initializeFrame` + `render`, then `sunDirectionWC` in the
 * camera's east-north-up frame — and adds the offset.
 *
 * ONE ARM, ONE CALL. `captureCloudRigArm` is the stage-settle-read-bank
 * sequence every W-series gate ran by hand. Its frame is the canvas read in
 * the task of the final render (`settleCloudRigInPage`), never an element
 * screenshot, and nothing reaches the disk until the page's WebGPU gate says
 * the device is alive and the bytes decode as a PNG.
 *
 * ONE DEMO LEG, THE SAME READ. A gallery demo (the Weather Inspector) builds
 * its own viewer, with every default widget, and lays its own panel and
 * toolbar over the canvas; its probes stage the deck through the demo's
 * page and set each leg's dials themselves. `captureViewerCanvas` gives such
 * a leg this module's read and acceptance without a rig stage: one more
 * render at the instant the viewer's own loop draws at (its clock, frozen by
 * the probe), the canvas read in that task, then the same gate, PNG check and
 * record as an arm. A canvas read contains no DOM, so neither the demo's
 * panels nor the viewer's widgets can reach a metric, whatever the page lays
 * over the canvas.
 *
 * OVERLAP, NAMED. `lib/cloud-march-mechanism.mjs`'s `pageBuildScene` also
 * splits a rig's dials at the `cloud` prefix and hands that half to
 * `__cloudProbe.configure`, and sets the rig's clock. This module adds the
 * camera (absolute or sun-relative), the scene show-dials, the page's own
 * clock (`clock: null`) and the canvas read; that one adds the globe dials
 * and a baseline restore. Converging the two is the kit's capture-stager
 * work (`NEW-CAPTURE-DOES-NOT-STAGE-THE-RIG`), not either probe family's.
 */

import fs from "node:fs";
import path from "node:path";

import { decodePng } from "../../lib/png-decode.mjs";
import { collectGateErrors } from "../../lib/webgpu-error-gate.mjs";
import { ProbeRefusal, sha256, throwIfDeviceLost } from "./probe-runtime.mjs";

/** Where the page imports the Cesium namespace from, as every W-series gate did. */
export const CLOUD_RIG_MODULE_URL = "/Build/CesiumUnminified/index.js";

/**
 * The served artifacts a CesiumViewer page staged by this module reads, for a
 * probe's `servedArtifacts`. The runtime's default list names `Cesium.js` and
 * the engine build but not `Build/CesiumUnminified/index.js`, which is what the
 * viewer page and `CLOUD_RIG_MODULE_URL` both import — the same three the
 * orbital ladder declares for the same page, for the same reason.
 */
export const CLOUD_RIG_SERVED_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/index.js",
  "packages/engine/Build/Unminified/index.js",
]);

/**
 * Rig dials the stager applies to the scene itself. Every other dial must be a
 * `CloudVolumetrics` property (`cloud` + an upper-case letter) and goes to the
 * harness.
 */
export const CLOUD_RIG_SCENE_DIALS = Object.freeze([
  "skyBoxShow",
  "skyAtmosphereShow",
  "sunShow",
  "moonShow",
  "globeShow",
  "backgroundColor",
  "useDefaultRenderLoop",
]);

const HEADING_REFERENCES = Object.freeze([undefined, "sun-azimuth"]);

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The payload `stageCloudRigInPage` takes, from a rig and optional per-leg
 * overrides. Pure; JSON-safe; refuses what it cannot stage.
 *
 * @param {object} rig A rig record (`rigs/<id>.mjs`).
 * @param {object} [overrides] Per-leg changes on top of the rig.
 * @param {object} [overrides.volumetric] CloudVolumetrics values that replace the rig's.
 * @param {object} [overrides.camera] Camera fields that replace the rig's.
 * @param {string|null} [overrides.clock] An ISO instant, or null for the page clock.
 * @returns {{rigId: string, moduleUrl: string, camera: object,
 *   clock: string|null, volumetric: object, scene: object}} The payload.
 * @throws {TypeError} For a camera without lon/lat/height/heading/pitch, an
 *   unknown heading reference, or a dial that is neither a scene dial nor a
 *   `cloud*` property.
 */
export function cloudRigStagePayload(rig, overrides = {}) {
  const id = rig?.id ?? "(unnamed)";
  const camera = { roll: 0, ...(rig?.camera ?? {}), ...overrides.camera };
  for (const key of ["lon", "lat", "height", "heading", "pitch", "roll"]) {
    if (!isFiniteNumber(camera[key])) {
      throw new TypeError(
        `rig ${id}: the stager needs a finite camera.${key}, got ${String(camera[key])}`,
      );
    }
  }
  if (!HEADING_REFERENCES.includes(camera.headingReference)) {
    throw new TypeError(
      `rig ${id}: unknown camera.headingReference ${String(camera.headingReference)}`,
    );
  }
  const scene = {};
  const volumetric = {};
  for (const [key, value] of Object.entries(rig?.dials ?? {})) {
    if (CLOUD_RIG_SCENE_DIALS.includes(key)) {
      scene[key] = value;
    } else if (/^cloud[A-Z]/.test(key)) {
      volumetric[key] = value;
    } else {
      throw new TypeError(
        `rig ${id}: dial ${key} is neither a scene dial the stager applies nor a CloudVolumetrics property`,
      );
    }
  }
  Object.assign(volumetric, overrides.volumetric ?? {});
  const clock = Object.hasOwn(overrides, "clock")
    ? overrides.clock
    : (rig?.clock ?? null);
  return {
    rigId: id,
    moduleUrl: CLOUD_RIG_MODULE_URL,
    camera,
    clock,
    volumetric,
    scene,
  };
}

/**
 * PAGE SIDE. Apply a stage payload to `window.viewer`. Self-contained.
 *
 * @param {object} payload From `cloudRigStagePayload`.
 * @returns {Promise<{rigId: string, config: object, rendererType: string,
 *   headingRadians: number, sunHeadingDeg: number|null,
 *   sunElevationDeg: number|null}>} What was staged.
 */
export async function stageCloudRigInPage(payload) {
  const C = await import(payload.moduleUrl);
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const dials = payload.scene;
  if (typeof dials.useDefaultRenderLoop === "boolean") {
    viewer.useDefaultRenderLoop = dials.useDefaultRenderLoop;
  }
  // The harness owns the cloud dials and their round trip; it throws on a key
  // CloudVolumetrics lacks and on a value that did not survive assignment.
  const truth = globalThis.__cloudProbe.configure({
    volumetric: payload.volumetric,
    requireWebGPU: true,
  });
  const shows = {
    skyBoxShow: scene.skyBox,
    skyAtmosphereShow: scene.skyAtmosphere,
    sunShow: scene.sun,
    moonShow: scene.moon,
    globeShow: scene.globe,
  };
  for (const [key, target] of Object.entries(shows)) {
    if (typeof dials[key] === "boolean" && target) {
      target.show = dials[key];
    }
  }
  if (typeof dials.backgroundColor === "string") {
    scene.backgroundColor = C.Color.fromCssColorString(dials.backgroundColor);
  }
  viewer.clock.shouldAnimate = false;
  let time;
  if (payload.clock !== null) {
    time = C.JulianDate.fromIso8601(payload.clock);
    viewer.clock.currentTime = time;
  }

  const cam = payload.camera;
  const destination = C.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height);
  let heading = cam.heading;
  let sunHeadingDeg = null;
  let sunElevationDeg = null;
  if (cam.headingReference === "sun-azimuth") {
    const enu = C.Transforms.eastNorthUpToFixedFrame(destination);
    const invEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
    scene.initializeFrame();
    scene.render(time);
    const local = C.Matrix4.multiplyByPointAsVector(
      invEnu,
      scene.context.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    const n = C.Cartesian3.normalize(local, new C.Cartesian3());
    const sunHeading = Math.atan2(n.x, n.y);
    heading = sunHeading + cam.heading;
    sunHeadingDeg = C.Math.toDegrees(sunHeading);
    sunElevationDeg = C.Math.toDegrees(
      Math.asin(Math.max(-1, Math.min(1, n.z))),
    );
  }
  viewer.camera.setView({
    destination,
    orientation: { heading, pitch: cam.pitch, roll: cam.roll },
  });
  return {
    rigId: payload.rigId,
    config: truth.config,
    rendererType: truth.rendererType,
    headingRadians: heading,
    sunHeadingDeg,
    sunElevationDeg,
  };
}

/**
 * PAGE SIDE. Render `frames` frames at the staged clock (or the page's own
 * when it is null), yielding one animation frame between renders, then render
 * once more and read the canvas as a PNG data URL in that same task, and
 * report the sun's elevation over the camera position (null without a
 * camera). Self-contained.
 *
 * `timeSource` names the instant each render draws at: `"staged"` (the
 * default) is the staged clock, or the page's own when that is null;
 * `"viewer-clock"` is `viewer.clock.currentTime`, the instant the viewer's
 * own render loop draws at (with the clock frozen, `clock.tick()` returns it
 * unchanged), for a page whose scene the probe did not stage here.
 *
 * THE FRAME IS THE CANVAS, NEVER AN ELEMENT SCREENSHOT. A Playwright element
 * screenshot of the CesiumViewer canvas also takes the DOM chrome stacked
 * over it (toolbar, navigation help, credits, clock, timeline), and the
 * W-series clauses count bright pixels in the upper band, where that chrome
 * sits (`LADDER-CAPTURE-INCLUDES-VIEWER-CHROME` records it on this page). The
 * pre-harvest gates read `canvas.toDataURL`; this keeps that population and
 * reads it through the kit's block from `lib/same-task-capture.mjs` (copied
 * between its markers, pinned byte-for-byte by `cloud-rig-stage.spec.mjs`),
 * so the read never follows a yield after which neither backend guarantees
 * the drawing buffer. One render more than the pre-harvest settle: the one
 * whose frame is read.
 *
 * @param {{frames: number, clock: string|null, moduleUrl: string,
 *   camera: {lon: number, lat: number, height: number}|null,
 *   timeSource?: string}} options Options.
 * @returns {Promise<{frames: number, sunElevationDeg: number|null,
 *   frameNumber: number|null, png: string}>} The settle and the canvas read.
 */
export async function settleCloudRigInPage({
  frames,
  clock,
  moduleUrl,
  camera,
  timeSource = "staged",
}) {
  const C = await import(moduleUrl);
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  let time;
  if (clock !== null) {
    time = C.JulianDate.fromIso8601(clock);
    viewer.clock.currentTime = time;
  }
  let timeFn = () => time;
  if (timeSource === "viewer-clock") {
    timeFn = () => viewer.clock.currentTime;
  } else if (timeSource !== "staged") {
    throw new Error(`settleCloudRigInPage: unknown timeSource ${timeSource}`);
  }
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==
  const { settleThen, grabNow } = makeSameTaskCapture(
    scene,
    scene.canvas,
    timeFn,
  );
  const { result: png } = await settleThen(frames, undefined, grabNow);
  let sunElevationDeg = null;
  if (camera) {
    const up = C.Cartesian3.normalize(
      C.Cartesian3.fromDegrees(camera.lon, camera.lat, camera.height),
      new C.Cartesian3(),
    );
    const sinElev = C.Cartesian3.dot(
      scene.context.uniformState.sunDirectionWC,
      up,
    );
    sunElevationDeg = C.Math.toDegrees(
      Math.asin(Math.max(-1, Math.min(1, sinElev))),
    );
  }
  const frameNumber = scene.frameState?.frameNumber;
  return {
    frames,
    sunElevationDeg,
    frameNumber: typeof frameNumber === "number" ? frameNumber : null,
    png,
  };
}

/** The reader every arm's frame comes from; recorded on each capture. */
export const CLOUD_RIG_READ_PATH =
  "canvas.toDataURL in the task of the final render (lib/same-task-capture.mjs)";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Accept one canvas read and bank it: the acceptance both entry points share,
 * so an arm and a demo leg cannot drift apart. The page's WebGPU gate is read
 * through `throwIfDeviceLost` (the runtime's refusal and wording), the read
 * must be a PNG data URL that decodes, and only then is `<name>.png` written
 * and its record appended.
 *
 * @param {object} options Options.
 * @param {object} options.page The Playwright page.
 * @param {{png: unknown, frameNumber: number|null}} options.settled The settle's answer.
 * @param {string} options.name Capture name.
 * @param {string|null} options.rigId The rig the page shows, for a refusal's detail.
 * @param {string} options.outputDirectory Where the PNG is written.
 * @param {Array<object>} [options.captures] Sink the record is appended to.
 * @returns {Promise<{record: object, buffer: Buffer, image: object}>} The banked frame.
 */
async function bankCanvasRead({
  page,
  settled,
  name,
  rigId,
  outputDirectory,
  captures,
}) {
  const gate = await collectGateErrors(page);
  const liveness = throwIfDeviceLost(
    {
      gateArmed: gate.armedDevices > 0,
      deviceLost: gate.deviceLost,
      frameNumber: settled.frameNumber,
    },
    { name },
  );
  const png = settled.png;
  if (typeof png !== "string" || !png.startsWith(PNG_DATA_URL_PREFIX)) {
    const seen =
      typeof png === "string" ? JSON.stringify(png.slice(0, 32)) : String(png);
    throw new ProbeRefusal(
      "capture-not-png",
      `"${name}" was not banked: the canvas read returned ${seen}, not a PNG data URL`,
      { name, rigId },
    );
  }
  const buffer = Buffer.from(png.slice(PNG_DATA_URL_PREFIX.length), "base64");
  const image = decodePng(buffer);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, `${name}.png`);
  fs.writeFileSync(file, buffer);
  const record = {
    name,
    path: file,
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    readPath: CLOUD_RIG_READ_PATH,
    liveness: { state: liveness.state, frameNumber: settled.frameNumber },
  };
  if (Array.isArray(captures)) {
    captures.push(record);
  }
  return { record, buffer, image };
}

/**
 * One arm of a W-series gate: stage the rig (with any per-leg overrides),
 * settle it, read the canvas and bank the frame.
 *
 * NOTHING IS WRITTEN UNTIL THE FRAME IS ACCEPTED, as at the runtime's own
 * capture seam: the page's WebGPU gate is asked whether its device is still
 * alive (`collectGateErrors` read through `throwIfDeviceLost`, so the refusal
 * and its wording are the runtime's), and the read must be a PNG data URL
 * that decodes. The record carries the fields a runtime capture record does
 * (`name`, `path`, `byteLength`, `sha256`, `liveness`) plus `readPath`, so a
 * receipt says which reader produced the frame.
 *
 * @param {object} options Options.
 * @param {object} options.page The Playwright page (CesiumViewer, with
 *   `installCloudProbeHarness` and the error gate installed before load).
 * @param {object} options.rig The rig.
 * @param {object} [options.overrides] Per-leg changes, as `cloudRigStagePayload` takes them.
 * @param {string} options.name Capture name; the file is `<name>.png`.
 * @param {string} options.outputDirectory Where the PNG is written.
 * @param {Array<object>} [options.captures] Sink the record is appended to.
 * @returns {Promise<{staged: object, settled: {frames: number,
 *   sunElevationDeg: number}, capture: object, image: object}>} The arm:
 *   what was staged, the settle, the capture record (with `buffer`) and the
 *   decoded frame the metrics read.
 * @throws {ProbeRefusal} `capture-device-lost` for a lost device, or
 *   `capture-not-png` when the canvas read is not a PNG data URL.
 */
export async function captureCloudRigArm({
  page,
  rig,
  overrides = {},
  name,
  outputDirectory,
  captures,
}) {
  const payload = cloudRigStagePayload(rig, overrides);
  const staged = await page.evaluate(stageCloudRigInPage, payload);
  const settled = await page.evaluate(settleCloudRigInPage, {
    frames: rig.readiness.frames,
    clock: payload.clock,
    moduleUrl: payload.moduleUrl,
    camera: payload.camera,
  });
  const { record, buffer, image } = await bankCanvasRead({
    page,
    settled,
    name,
    rigId: payload.rigId,
    outputDirectory,
    captures,
  });
  return {
    staged,
    settled: {
      frames: settled.frames,
      sunElevationDeg: settled.sunElevationDeg,
    },
    capture: { ...record, buffer },
    image,
  };
}

/**
 * One demo leg: the canvas of a page whose scene the probe staged itself,
 * read in the task of one more render at the viewer's own clock, accepted and
 * banked exactly as an arm's frame is (`bankCanvasRead`). No rig is staged
 * and no settle frame is rendered; the probe waits for its own settle first.
 *
 * @param {object} options Options.
 * @param {object} options.page The Playwright page (`window.viewer` up, the
 *   error gate installed before load and armed).
 * @param {string} options.name Capture name; the file is `<name>.png`.
 * @param {string|null} [options.rigId] The rig the page shows, for a refusal's detail.
 * @param {string} options.outputDirectory Where the PNG is written.
 * @param {Array<object>} [options.captures] Sink the record is appended to.
 * @returns {Promise<{capture: object, image: object}>} The capture record
 *   (with `buffer`) and the decoded frame the metrics read.
 * @throws {ProbeRefusal} `capture-device-lost` or `capture-not-png`, as an arm.
 */
export async function captureViewerCanvas({
  page,
  name,
  rigId = null,
  outputDirectory,
  captures,
}) {
  const settled = await page.evaluate(settleCloudRigInPage, {
    frames: 0,
    clock: null,
    moduleUrl: CLOUD_RIG_MODULE_URL,
    camera: null,
    timeSource: "viewer-clock",
  });
  const { record, buffer, image } = await bankCanvasRead({
    page,
    settled,
    name,
    rigId,
    outputDirectory,
    captures,
  });
  return { capture: { ...record, buffer }, image };
}
