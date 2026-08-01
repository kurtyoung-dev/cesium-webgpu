#!/usr/bin/env node
// C12-31 — NATURAL SOLAR ATMOSPHERIC AUREOLE: is the sky's bright lobe anchored
// to the SUN or to the VIEW?
//
// ⚠ AUTHORED BY A NO-BROWSER WORKER (2026-08-01). It has NOT been executed.
// Treat the first run as part of the review, not as a regression check.
//
// THE DEFECT THIS DISCRIMINATES. `Globe.enableLighting` defaults to false, so
// the sky's dynamic-lighting enum resolves to NONE, and before C12-31 both
// backends then substituted `normalize(positionWC)` for the astronomical Sun.
// `computeAtmosphereColor` takes `cosAngle = dot(viewDir, lightDirection)`,
// which under that substitution is ≈1 along every ray a ground observer looks
// down — so the Mie phase sits on a forward peak 4869.9× its 90° value (default
// g = 0.9) NO MATTER WHERE THE CAMERA POINTS. The signature is therefore not
// "the sky is too bright"; it is "the bright lobe does not move when the camera
// turns away from the Sun, and it is still there after sunset."
//
// So this probe never measures absolute brightness. It measures ANCHORING:
//
//   L1 AZIMUTH RESPONSE — sweep the camera heading around a fixed observer at a
//      pinned clock and compare the upper-frame sky luminance. Sun-anchored sky:
//      brightest looking toward the Sun, dimmest looking anti-Sun. View-locked
//      sky: all four headings within a few percent (the defect).
//   L2 LOBE DISPLACEMENT — with the Sun 60° off the camera axis, the
//      luminance-weighted horizontal centroid of the upper frame must sit on the
//      Sun's SIDE of centre, and must flip sides when the offset flips sign. A
//      view-locked lobe is centred in every frame, so the sign test fails.
//   L3 AFTER SUNSET — with the Sun ~15° BELOW the local horizon, no bright patch
//      may remain. This is the maintainer's screenshot condition.
//   L4 BACKEND TRUTH — `scene.context.rendererType` must equal the requested
//      backend; a silent WebGPU→WebGL fallback fails hard rather than quietly
//      reporting WebGL numbers twice.
//
// The Sun billboard, its glare, the skybox, the star field, the Moon, bloom and
// FXAA are all OFF: this row must prove the ATMOSPHERE is the source, and
// `C12-18`/`C12-19` own the direct-Sun radiance/halo lanes. Generic bloom is
// radiance-driven by design and would only spread whatever the shell emits.
//
//   node Tools/visual-regression/probe-sky-aureole-anchor.mjs
//
// Env:
//   AUREOLE_DAY_TIME    ISO instant for L1/L2 (default 2026-06-21T15:00:00Z).
//   AUREOLE_NIGHT_TIME  ISO instant for L3    (default 2026-06-21T02:30:00Z).
//   AUREOLE_BACKENDS    comma list (default "webgl,webgpu").
//
// Exit code 0 only when every lane of every requested backend passes.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const DAY_TIME = process.env.AUREOLE_DAY_TIME ?? "2026-06-21T15:00:00Z";
const NIGHT_TIME = process.env.AUREOLE_NIGHT_TIME ?? "2026-06-21T02:30:00Z";
const BACKENDS = (process.env.AUREOLE_BACKENDS ?? "webgl,webgpu")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Ground observer looking up — the maintainer's reproduction geometry.
const SITE = { lon: -80.0, lat: 40.0, height: 300.0 };
// Pitched up so the shell fills the frame and the globe stays out of the
// measured region; the measured region is the top 45% of the frame.
const PITCH_DEG = 32.0;
const MEASURE_ROWS = [0.0, 0.45];

// L1: the toward-Sun frame must out-brighten the anti-Sun frame by this factor.
// The defect produces ~1.00; a sun-anchored sky at a mid-elevation Sun produces
// a large multiple. 1.25 separates them with room for tonemap compression.
const MIN_AZIMUTH_CONTRAST = 1.25;
// L2: how far off centre (in frame widths) the lobe centroid must sit.
const MIN_CENTROID_OFFSET = 0.04;
// L3: after sunset the measured sky must fall to this fraction of the
// toward-Sun daytime mean, and no pixel may stay this bright.
const MAX_NIGHT_MEAN_FRACTION = 0.15;
const MAX_NIGHT_PEAK = 40;

/**
 * One capture pass, entirely inside the page: pin the clock, configure the
 * isolation scene, aim the camera, settle, then render-and-read in ONE task.
 */
async function measure(page, { timeIso, headingDeg }) {
  return await page.evaluate(
    async ({ site, timeIso, headingDeg, pitchDeg, rows }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const canvas = scene.canvas;

      const pinned = C.JulianDate.fromIso8601(timeIso);
      const timeFn = () => pinned.clone();
      viewer.clock.currentTime = pinned.clone();
      viewer.clock.startTime = pinned.clone();
      viewer.clock.stopTime = pinned.clone();
      viewer.clock.shouldAnimate = false;
      viewer.clock.multiplier = 0;
      scene.requestRenderMode = false;

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

      const capture = makeSameTaskCapture(scene, canvas, timeFn);

      // ── Isolation: the atmosphere shell is the ONLY celestial source. ──
      scene.skyAtmosphere.show = true;
      scene.skyBox.show = false;
      if (scene.starField) {
        scene.starField.show = false;
      }
      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.globe.show = true;
      scene.globe.showGroundAtmosphere = false;
      // Left at its DEFAULT false on purpose: that default is what resolves the
      // sky's enum to NONE, which is the whole subject of this probe.
      scene.globe.enableLighting = false;
      scene.highDynamicRange = false;
      const stages = scene.postProcessStages;
      if (stages) {
        if (stages.bloom) {
          stages.bloom.enabled = false;
        }
        if (stages.fxaa) {
          stages.fxaa.enabled = false;
        }
        if (stages.ambientOcclusion) {
          stages.ambientOcclusion.enabled = false;
        }
      }
      for (const selector of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-viewer-navigationContainer",
        ".cesium-navigation-help",
      ]) {
        const element = document.querySelector(selector);
        if (element) {
          element.style.display = "none";
        }
      }

      // ── The Sun's LOCAL azimuth/elevation at this site and instant. ──
      const carto = C.Cartographic.fromDegrees(site.lon, site.lat, site.height);
      const origin = C.Cartographic.toCartesian(carto);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const inverseEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
      const sunInertial =
        C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          pinned,
          new C.Cartesian3(),
        );
      const icrfToFixed = C.Transforms.computeIcrfToFixedMatrix(
        pinned,
        new C.Matrix3(),
      );
      const sunFixed = icrfToFixed
        ? C.Matrix3.multiplyByVector(
            icrfToFixed,
            sunInertial,
            new C.Cartesian3(),
          )
        : sunInertial;
      const sunDir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunFixed, origin, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const sunLocal = C.Matrix4.multiplyByPointAsVector(
        inverseEnu,
        sunDir,
        new C.Cartesian3(),
      );
      const sunAzimuth =
        ((((Math.atan2(sunLocal.x, sunLocal.y) * 180) / Math.PI) % 360) + 360) %
        360;
      const sunElevation =
        (Math.asin(Math.max(-1, Math.min(1, sunLocal.z))) * 180) / Math.PI;

      const heading =
        headingDeg === null ? sunAzimuth : ((headingDeg % 360) + 360) % 360;
      scene.camera.setView({
        destination: origin,
        orientation: {
          heading: C.Math.toRadians(heading),
          pitch: C.Math.toRadians(pitchDeg),
          roll: 0.0,
        },
      });

      // Yield ONLY while loading; the final render and the read share one task.
      const settle = await capture.settleThen(
        120,
        () => scene.globe.tilesLoaded === true,
        () => capture.captureNow(),
      );
      const image = settle.result;

      // ── Metrics over the measured sky band. ──
      const width = image.width;
      const height = image.height;
      const data = image.data;
      const y0 = Math.max(0, Math.floor(height * rows[0]));
      const y1 = Math.min(height, Math.floor(height * rows[1]));

      let sum = 0;
      let count = 0;
      let peak = 0;
      let peakX = 0;
      let peakY = 0;
      let weightSum = 0;
      let weightedX = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum =
            0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          sum += lum;
          count++;
          if (lum > peak) {
            peak = lum;
            peakX = x;
            peakY = y;
          }
          // Fourth power so the centroid tracks the LOBE rather than the
          // uniform sky it sits on.
          const weight = Math.pow(lum / 255, 4);
          weightSum += weight;
          weightedX += weight * (x / (width - 1));
        }
      }

      return {
        rendererType: scene.context.rendererType,
        settled: settle.settled,
        width,
        height,
        heading,
        sunAzimuth,
        sunElevation,
        mean: count > 0 ? sum / count : 0,
        peak,
        peakXFraction: width > 1 ? peakX / (width - 1) : 0,
        peakYFraction: height > 1 ? peakY / (height - 1) : 0,
        centroidX: weightSum > 1e-9 ? weightedX / weightSum : 0.5,
        png: capture.grabNow(),
      };
    },
    {
      site: SITE,
      timeIso,
      headingDeg,
      pitchDeg: PITCH_DEG,
      rows: MEASURE_ROWS,
    },
  );
}

function writePng(dataUrl, name) {
  const base64 = String(dataUrl ?? "").split(",")[1];
  if (!base64) {
    return null;
  }
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

async function runBackend(browser, backend, failures) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 640 },
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${backend}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Sun azimuth first, so every heading below is relative to the real Sun.
  const anchor = await measure(page, { timeIso: DAY_TIME, headingDeg: null });
  const sunAzimuth = anchor.sunAzimuth;
  console.log(
    `[${backend}] renderer=${anchor.rendererType} sun az=${sunAzimuth.toFixed(1)}deg ` +
      `el=${anchor.sunElevation.toFixed(1)}deg tilesSettled=${anchor.settled}`,
  );

  // L4 — backend truth.
  if (anchor.rendererType !== backend) {
    failures.push(
      `[${backend}] L4 backend: rendererType is "${anchor.rendererType}"`,
    );
  }
  if (anchor.sunElevation < 10) {
    failures.push(
      `[${backend}] L1 setup: AUREOLE_DAY_TIME puts the sun at ${anchor.sunElevation.toFixed(1)}deg; pick an instant with the sun well up`,
    );
  }

  // L1 — azimuth response.
  const lanes = [
    { name: "toward", offset: 0 },
    { name: "left60", offset: -60 },
    { name: "right60", offset: 60 },
    { name: "anti", offset: 180 },
  ];
  const results = {};
  for (const lane of lanes) {
    const result =
      lane.offset === 0
        ? anchor
        : await measure(page, {
            timeIso: DAY_TIME,
            headingDeg: sunAzimuth + lane.offset,
          });
    results[lane.name] = result;
    writePng(result.png, `sky-aureole-${backend}-${lane.name}.png`);
    console.log(
      `  ${lane.name.padEnd(8)} heading=${result.heading.toFixed(0).padStart(3)}deg ` +
        `mean=${result.mean.toFixed(2).padStart(7)} peak=${result.peak.toFixed(0).padStart(3)} ` +
        `centroidX=${result.centroidX.toFixed(3)} peakAt=(${result.peakXFraction.toFixed(2)},${result.peakYFraction.toFixed(2)})`,
    );
  }

  const contrast = results.toward.mean / Math.max(1e-6, results.anti.mean);
  console.log(`  L1 toward/anti mean ratio = ${contrast.toFixed(3)}`);
  if (!(contrast >= MIN_AZIMUTH_CONTRAST)) {
    failures.push(
      `[${backend}] L1 azimuth response: toward/anti = ${contrast.toFixed(3)} < ${MIN_AZIMUTH_CONTRAST} — the lobe is not sun-anchored`,
    );
  }
  const brightest = Object.entries(results).reduce((a, b) =>
    a[1].mean >= b[1].mean ? a : b,
  )[0];
  if (brightest !== "toward") {
    failures.push(
      `[${backend}] L1 azimuth response: brightest heading is "${brightest}", expected "toward"`,
    );
  }

  // L2 — lobe displacement. Camera 60deg LEFT of the sun puts the sun on the
  // RIGHT of frame (centroid > 0.5) and vice versa. A view-locked lobe is
  // centred in both, so the SIGN test is what discriminates, not the size.
  const left = results.left60.centroidX;
  const right = results.right60.centroidX;
  console.log(
    `  L2 centroidX left60=${left.toFixed(3)} right60=${right.toFixed(3)} (expect >0.5 and <0.5)`,
  );
  if (!(left > 0.5 + MIN_CENTROID_OFFSET)) {
    failures.push(
      `[${backend}] L2 displacement: camera left of the sun put the lobe at ${left.toFixed(3)}, expected > ${(0.5 + MIN_CENTROID_OFFSET).toFixed(3)}`,
    );
  }
  if (!(right < 0.5 - MIN_CENTROID_OFFSET)) {
    failures.push(
      `[${backend}] L2 displacement: camera right of the sun put the lobe at ${right.toFixed(3)}, expected < ${(0.5 - MIN_CENTROID_OFFSET).toFixed(3)}`,
    );
  }

  // L3 — after sunset.
  const night = await measure(page, { timeIso: NIGHT_TIME, headingDeg: null });
  writePng(night.png, `sky-aureole-${backend}-night.png`);
  const nightFraction = night.mean / Math.max(1e-6, results.toward.mean);
  console.log(
    `  L3 night sun el=${night.sunElevation.toFixed(1)}deg mean=${night.mean.toFixed(2)} ` +
      `peak=${night.peak.toFixed(0)} (fraction of day toward-sun mean = ${nightFraction.toFixed(3)})`,
  );
  if (night.sunElevation > -5) {
    failures.push(
      `[${backend}] L3 setup: AUREOLE_NIGHT_TIME puts the sun at ${night.sunElevation.toFixed(1)}deg; pick an instant with the sun below the horizon`,
    );
  }
  if (!(nightFraction <= MAX_NIGHT_MEAN_FRACTION)) {
    failures.push(
      `[${backend}] L3 after sunset: sky is still ${(100 * nightFraction).toFixed(1)}% of the daytime mean`,
    );
  }
  if (!(night.peak <= MAX_NIGHT_PEAK)) {
    failures.push(
      `[${backend}] L3 after sunset: a patch at luminance ${night.peak.toFixed(0)} remains (max ${MAX_NIGHT_PEAK}) — the aureole survived sunset`,
    );
  }

  if (consoleErrors.length > 0) {
    failures.push(`[${backend}] ${consoleErrors.length} console error(s)`);
    consoleErrors.slice(0, 8).forEach((e) => console.log(`    ${e}`));
  } else {
    console.log("  [0 console errors]");
  }

  await page.close();
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const failures = [];
  try {
    for (const backend of BACKENDS) {
      await runBackend(browser, backend, failures);
    }
  } finally {
    await browser.close();
  }

  console.log("");
  if (failures.length === 0) {
    console.log(
      "[sky-aureole-anchor] PASS — the sky's bright lobe is sun-anchored.",
    );
    process.exit(0);
  }
  console.log(`[sky-aureole-anchor] FAIL — ${failures.length} gate(s):`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
})();
