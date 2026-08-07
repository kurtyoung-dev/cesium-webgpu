#!/usr/bin/env node
// probe-celestial-gates.mjs — Campaign 12 celestial gate harness (C12-01 + C12-02).
//
// WHAT THIS IS
// ------------
// The measured, never-eyeballed gate probe for the celestial appearance work.
// It captures the star field on BOTH backends (WebGL + WebGPU) under the exact
// framing each gate needs and evaluates the second-order metrics from
// Tools/visual-regression/lib/celestial-metrics.mjs (the node --test trust
// anchor). Mean luminance is reported but is EXPLICITLY non-certifying — a
// normalized-kernel convolution (mip/bilinear/MSAA/JPEG) moves the mean by
// zero, so a mean diff cannot see any of these gates.
//
// GATE G1 (default run) — TWO LANES since the C12-G1F2 repair.
//
//   LANE A — `orbital-cubemap-parity`. The historical G1 framing: camera at
//   5.0e7 m along the sun direction, globe / sun / moon / skyAtmosphere / fog
//   OFF, bare star field over a black background, captured three ways per the
//   M6 source-split below. It measures exactly what it can see — CUBEMAP AND
//   SPRITE PARITY. It was previously LABELLED as "the only framing that reaches
//   the C11-176 failure state", which is false in two independent ways:
//     * that camera is ~43,600 km up, far above
//       `ATMOSPHERIC_COLUMN_FADE_END = 111 km` (`SkyBrightness.js`), so
//       `computeAtmosphericColumnFactor` is 0 and `frameState.skyBrightness` is
//       identically 0 — the recorded runs show `skyBrightness 0` at
//       `sunElevationDeg 90`. `AtmosphericConditions.js` states this as the
//       DESIGN ("that camera gets factor 1.0 and is byte-identical to today").
//     * `CubeMapPanorama.js` gates star modulation on
//       `frameState.skyAtmosphereVisible === true`, and this lane turns the sky
//       atmosphere off.
//   PASS requires, on the default pair:
//     M1 point-source count ratio (WebGPU/WebGL) >= 0.90
//     M2a RMS-contrast ratio in [0.85, 1.15]
//     M2b (P99.9 - P50) ratio in [0.85, 1.15]
//     M3 median chroma >= 0.85 x WebGL
//     M2e robust sky floor: |gpu - gl| <= one 8-bit code value in linear light
//   and, on EACH M6 mode, the M1 count ratio >= 0.90 (so a cubemap-only or
//   sprites-only regression cannot be masked by the other source). A mode where
//   BOTH backends census zero sources is reported STRUCTURAL, not FAIL — 0/0 is
//   an instrument that cannot see its subject.
//
//   LANE B — `in-column-star-modulation`. Camera INSIDE the atmospheric column
//   (30 km, i.e. below `ATMOSPHERIC_COLUMN_FADE_START = 60 km`) on the sunlit
//   side with the sky atmosphere ON, so `skyBrightness` saturates to 1.0 and
//   `skyAtmosphereVisible` is true — both C11-176 preconditions met. Captured
//   twice, with `enableStarBrightnessModulation` OFF then ON. The certifying
//   quantity is the modulation's OWN energy, `mean(OFF) - mean(ON)`, taken
//   within each backend and only then compared across backends: differencing
//   inside a backend cancels the sky-atmosphere shell, so a shell-parity gap
//   can neither masquerade as nor mask a star-modulation gap. The OFF/ON swing
//   doubles as the non-vacuity control — a lane whose modulation term never
//   moved a pixel is STRUCTURAL.
//
//   REACHABILITY IS ASSERTED ON THE DRIVING VARIABLE. `framingReached` tests
//   `skyBrightness > 0.5` — `probe-skybox-star-modulation.mjs`'s own predicate —
//   NOT `sunElevationDeg >= 25`. Solar elevation is a proxy that correlates with
//   sky brightness below 60 km and is fully decoupled from it above 111 km,
//   which is where the old assertion was being evaluated.
//
// M6 SOURCE-SPLIT — the true isolation toggles (determined from SkyBox.js +
// Scene.updateEnvironment, NOT guessed):
//   * `skyBox.show`      delegates to the CubeMapPanorama's show only
//     (SkyBox.js get/set show -> _panorama.show). It gates the CUBEMAP command.
//   * `skyBox.starField.show` gates the SPRITE catalogue. StarField.update
//     (StarField.js:142-149) early-returns solely on its own `.show`; the
//     starfield is driven independently in Scene.updateEnvironment
//     (Scene.js:3746-3765), NOT inside SkyBox.update. So `skyBox.show=false`
//     does NOT kill the sprites — it kills only the cubemap.
//   Therefore:
//     default      : skyBox.show=true,  starField.show=true   (cubemap+sprites)
//     cubemap-only : skyBox.show=true,  starField.show=false  (cubemap alone)
//     sprites-only : skyBox.show=false, starField.show=true   (sprites alone —
//                    the cubemap command is dropped; both backends execute the
//                    single returned star command)
//
// GATE EVIDENCE — EXPOSURE BRACKET (--bracket, C12-02).
//   An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is
//   exactly the part the 8-bit capture discards. The bracket restores ~5 decades
//   of range with no engine change:
//     * scene.highDynamicRange = true  (exposure only takes effect on the HDR
//       path — PostProcessStageCollection.exposure -> tonemap uniform), RECORDED
//       in the manifest as `hdr:true`. Bracket evidence is HDR-lane evidence,
//       distinct from the SDR G1 lanes.
//     * capture at scene.postProcessStages.exposure = 1x, 8x, 64x.
//   STITCH MATH (per pixel, per channel):
//     For a pixel, among the three exposures pick the HIGHEST factor f whose
//     captured 8-bit channel value v is UNCLIPPED (v < 250). The linear estimate
//     is  L = (v / 255) / f. Picking the highest unclipped exposure maximises the
//     signal-to-quantization ratio at that pixel; dividing by f removes the
//     exposure gain. This assumes the display transform is locally LINEAR in the
//     unclipped region (v < 250) — true to good approximation for PBR-Neutral's
//     near-identity low/mid response, and sufficient because M4 measures the
//     RELATIVE radial falloff, which the near-linear low end preserves. The
//     composite spans ~ (1/1) down to (1/255)/64 ~ 6e-5, i.e. > 4 decades, which
//     an 8-bit readback (1/255 ~ 4e-3, ~2.4 decades) cannot reach. The composite
//     is a linear-light float image fed to M4 (brightest source) and M5
//     (curated bright-star cross-match). Both are reported as DIAGNOSTIC — the
//     PSF gates G2/G4 land in W2/W4; the bracket's own PASS is that the range
//     extension is REAL (halo signal recovered below the 8-bit floor).
//
// BINDING PROBE RULES (defect class root-caused Batch 744):
//   1. Pinned clock: viewer.useDefaultRenderLoop=false; EVERY render passes the
//      pinned time — scene.render(viewer.clock.currentTime) — never bare
//      scene.render() (which renders at wall-clock NOW).
//   2. Same-task capture: the final scene.render() and the drawImage/getImageData
//      run in the SAME task with NO await between them (the WebGPU drawing buffer
//      clears once the compositor consumes a presented frame).
//   3. Bounded sun-direction settle loop before any sun-relative aiming (ICRF
//      loads async): <= 180 frames, stable when 10 consecutive deltas < 1e-9.
//   4. Unref'd force-exit watchdog + try/finally browser close.
//   5. HARD exit codes: 0 only on PASS, 1 on gate FAIL, 2 on a lane that failed
//      to RUN, 3 on STRUCTURAL (a lane that ran but could not see its subject).
//   6. Settle is a WALL-CLOCK READINESS BUDGET, not a frame count, and every
//      capture is preceded by a DISCARDED warm-up capture. See SETTLE_BUDGET_MS.
//
// EXIT CODES:
//   0 PASS  1 FAIL (a measurable criterion is out of band)
//   2 ERROR (a backend lane did not run)
//   3 STRUCTURAL (a lane ran but could not see its subject — reachability not
//     met, or the modulation term never moved a pixel, or both backends
//     censused zero sources in a count mode). NEVER report such a lane as 0.
//
// Usage:
//   node Tools/visual-regression/probe-celestial-gates.mjs            # G1 (SDR)
//   node Tools/visual-regression/probe-celestial-gates.mjs --bracket  # C12-02 HDR bracket
//   PROBE_BASE=http://localhost:8080 node ... (override server)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import {
  m1PointSourceCensus,
  m2ContrastTail,
  m2eSkyFloor,
  m3Chroma,
  m4RadialFalloff,
  m5MagnitudeFidelity,
} from "./lib/celestial-metrics.mjs";
import { sha256, createSceneIdentity } from "./lib/visual-gate-policy.mjs";
import {
  EXIT_CODE,
  buildG1Summary,
  evaluateCubemapParityLane,
  evaluateStarModulationLane,
  foldG1Verdict,
  ratio,
} from "./lib/celestial-g1-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const PINNED_ISO = "2026-05-19T18:00:00Z";
const VIEWPORT = { width: 1280, height: 720 };
const CROP = { width: 1000, height: 640 };

// SETTLE — a WALL-CLOCK READINESS BUDGET, not a frame count.
//
// The previous `SETTLE_FRAMES = 32` bought roughly 530 ms of frames. The
// measured async pipeline-compile cost on this fork is 2674 ms, so a 32-frame
// settle capture reads a scene whose pipelines are still compiling — and the
// shortfall lands hardest on whichever mode is captured first. The budget below
// is the project standard (wall clock >= the measured compile cost), with a
// frame floor so a fast machine still advances the render loop enough times.
//
// The yield is `setTimeout`, not `requestAnimationFrame`: with
// `useDefaultRenderLoop = false` in a headless browser, rAF delivery is at the
// compositor's discretion, and a starved rAF would silently shorten the budget
// into exactly the under-settle it exists to prevent.
const SETTLE_BUDGET_MS = 3000;
const SETTLE_MIN_FRAMES = 32;
const SETTLE_YIELD_MS = 16;

// MODE CAPTURE ORDER — EXPLICIT AND CERTIFYING-LAST.
//
// The previous order was `["default", "cubemap-only", "sprites-only"]`, so the
// only certifying mode was always captured against the COLDEST caches while its
// non-certifying siblings inherited warm ones. That is an ordered contamination
// whose bias runs in the direction the gate scores. The certifying mode is now
// captured LAST, after its siblings have warmed everything it shares.
const G1_MODE_CAPTURE_ORDER = ["cubemap-only", "sprites-only", "default"];
const G1_CERTIFYING_MODE = "default";
const G1_COUNT_MODES = ["cubemap-only", "sprites-only"];

// Lane B captures OFF first so the certifying difference `mean(OFF) - mean(ON)`
// is taken with ON — the state the defect lives in — measured last and warmest.
const COLUMN_MODE_CAPTURE_ORDER = ["modulation-off", "modulation-on"];

// Lane B camera height, metres. Below ATMOSPHERIC_COLUMN_FADE_START (60 km) so
// `computeAtmosphericColumnFactor` is exactly 1.0 and `skyBrightness` is
// whatever the solar geometry says — which, with the camera placed along the
// sun direction, is the saturated daylight value 1.0.
const IN_COLUMN_HEIGHT_M = 30000;

const BRACKET = process.argv.includes("--bracket");

// Curated bright stars (J2000 RA/Dec deg, Johnson V) spanning ~3.5 mag around
// the Sirius field — the M5 cross-match set. Projected in-page at the pinned
// clock via the same TEME->pseudo-fixed transform the renderer uses, so render
// and projection share any precession offset and it cancels in the match.
const CATALOG_EXPECTATIONS = [
  { name: "Sirius", ra: 101.287, dec: -16.716, vmag: -1.46 },
  { name: "Canopus", ra: 95.988, dec: -52.696, vmag: -0.74 },
  { name: "Rigel", ra: 78.634, dec: -8.202, vmag: 0.13 },
  { name: "Procyon", ra: 114.825, dec: 5.225, vmag: 0.34 },
  { name: "Betelgeuse", ra: 88.793, dec: 7.407, vmag: 0.42 },
  { name: "Aldebaran", ra: 68.98, dec: 16.509, vmag: 0.85 },
  { name: "Adhara", ra: 104.656, dec: -28.972, vmag: 1.5 },
  { name: "Bellatrix", ra: 81.283, dec: 6.35, vmag: 1.64 },
  { name: "Alnilam", ra: 84.053, dec: -1.202, vmag: 1.69 },
  { name: "Mirzam", ra: 95.674, dec: -17.956, vmag: 1.98 },
];

// Raised from 300s at the C12-G1F2 repair: the run now has two lanes, and every
// capture pays a wall-clock settle budget plus a discarded warm-up (see
// SETTLE_BUDGET_MS). The watchdog must outlast the honest worst case or it
// becomes the thing that fails the gate.
const HARD_LIMIT_MS = 600000;
const watchdog = setTimeout(() => {
  console.error("[probe-celestial-gates] WATCHDOG FIRED (600s) — forcing exit");
  process.exit(EXIT_CODE.ERROR);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) => (!Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
// NOTE: sky floors, means and stddevs are reported UNROUNDED. The M2e tolerance
// is ~3.0e-4 in linear light, so the 3-decimal rounder this report used to apply
// to `webgl_skyFloor`/`webgpu_skyFloor` printed every legitimate floor as a flat
// 0 and made the pedestal discriminator unreadable in the very report that was
// supposed to carry it.

function getGit() {
  const run = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
  try {
    const sourceCommit = run("git rev-parse HEAD");
    const sourceDirty = run("git status --porcelain").length > 0;
    return { sourceCommit, sourceDirty };
  } catch {
    return { sourceCommit: "0".repeat(40), sourceDirty: true };
  }
}

function normalizeHardwareClass(parts) {
  const populated = parts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().toLowerCase().replaceAll(/\s+/g, "-"));
  return populated.length > 0 ? populated.join(":") : "unknown";
}

// --------------------------------------------------------------------------
// In-page: configure the G1 scene, settle the sun direction, aim the camera.
// Returns the stable sun direction, sky brightness, adapter provenance, and the
// canvas/crop geometry. Runs entirely at the pinned clock.
// --------------------------------------------------------------------------
async function setupScene(page, { aim, skyAtmosphereOn, cameraHeightM }) {
  return page.evaluate(
    async ({
      pinnedIso,
      aimMode,
      crop,
      settleBudgetMs,
      settleMinFrames,
      settleYieldMs,
      catalog,
      skyOn,
      heightM,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;

      // RULE 1 — kill the default loop, render only at the pinned clock.
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(pinnedIso);
      viewer.useDefaultRenderLoop = false;
      scene.requestRenderMode = false;
      const pinnedTime = () => viewer.clock.currentTime;

      // G1 scene: pure star field, nothing else emitting light.
      scene.backgroundColor = C.Color.BLACK;
      if (scene.globe) {
        scene.globe.show = false;
      }
      if (scene.sun) {
        scene.sun.show = false;
      }
      if (scene.moon) {
        scene.moon.show = false;
      }
      if (scene.skyAtmosphere) {
        // Lane B REQUIRES this on: `CubeMapPanorama.updateStarModulation` gates
        // the whole term on `frameState.skyAtmosphereVisible === true`, which
        // `Scene.js` derives from `skyAtmosphere.show`. Lane A keeps it off so
        // its background stays black and the M2e quantization bound holds.
        scene.skyAtmosphere.show = skyOn === true;
      }
      if (scene.fog) {
        scene.fog.enabled = false;
      }

      // RULE 3 — bounded sun-direction settle (ICRF loads async).
      let prev = null;
      let stableRun = 0;
      for (let i = 0; i < 180 && stableRun < 10; i++) {
        scene.render(pinnedTime());
        const cur = C.Cartesian3.clone(
          scene.context.uniformState.sunDirectionWC,
        );
        if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) {
          stableRun++;
        } else {
          stableRun = 0;
        }
        prev = cur;
        await new Promise((r) => requestAnimationFrame(r));
      }
      const sunDir = prev;

      const dist = 5.0e7;
      let cameraUp;
      if (aimMode === "sirius") {
        // Aim at the brightest catalogue star so the bracket lane has a bright
        // source dead centre. Same RA/Dec -> TEME -> pseudo-fixed transform the
        // renderer uses (probe-starfield-webgl-parity pattern).
        const s = catalog[0];
        const ra = C.Math.toRadians(s.ra);
        const dec = C.Math.toRadians(s.dec);
        const teme = new C.Cartesian3(
          Math.cos(dec) * Math.cos(ra),
          Math.cos(dec) * Math.sin(ra),
          Math.sin(dec),
        );
        const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
          pinnedTime(),
          new C.Matrix3(),
        );
        const dir = C.Matrix3.multiplyByVector(
          temeToFixed,
          teme,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(dir, dir);
        const eye = C.Cartesian3.multiplyByScalar(
          dir,
          -dist,
          new C.Cartesian3(),
        );
        let up = C.Cartesian3.UNIT_Z;
        if (Math.abs(C.Cartesian3.dot(dir, up)) > 0.95) {
          up = C.Cartesian3.UNIT_X;
        }
        const right = C.Cartesian3.normalize(
          C.Cartesian3.cross(dir, up, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const realUp = C.Cartesian3.normalize(
          C.Cartesian3.cross(right, dir, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        scene.camera.setView({
          destination: eye,
          orientation: { direction: dir, up: realUp },
        });
        cameraUp = C.Cartesian3.normalize(eye, new C.Cartesian3());
      } else {
        // SUNLIT G1: camera ALONG the sun direction => local up == sunDir =>
        // the Sun sits at the local zenith. `computeCelestialElevationSine`
        // takes local up as `normalize(cameraPositionWC)`, so placing the eye on
        // the sun ray makes sin(altitude) exactly 1 at ANY radius. Aim
        // perpendicular to the sun so neither the sun disc nor Earth is in view.
        //
        // The RADIUS is what separates the two lanes, and it is the whole point
        // of the C12-G1F2 repair: at `dist` the camera is ~43,600 km up and
        // `computeAtmosphericColumnFactor` zeroes `skyBrightness`; at
        // `heightM` = 30 km it is 1.0 and `skyBrightness` saturates to 1.0.
        const axis = sunDir;
        let radius = dist;
        if (Number.isFinite(heightM)) {
          const ellipsoid = scene.ellipsoid ?? C.Ellipsoid.WGS84;
          const ray = C.Cartesian3.multiplyByScalar(
            axis,
            1.0e7,
            new C.Cartesian3(),
          );
          const surface = ellipsoid.scaleToGeodeticSurface(
            ray,
            new C.Cartesian3(),
          );
          radius = C.Cartesian3.magnitude(surface) + heightM;
        }
        const position = C.Cartesian3.multiplyByScalar(
          axis,
          radius,
          new C.Cartesian3(),
        );
        const seed =
          Math.abs(axis.z) < 0.9
            ? new C.Cartesian3(0, 0, 1)
            : new C.Cartesian3(1, 0, 0);
        const perp = C.Cartesian3.normalize(
          C.Cartesian3.cross(axis, seed, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        const up = C.Cartesian3.normalize(
          C.Cartesian3.cross(perp, axis, new C.Cartesian3()),
          new C.Cartesian3(),
        );
        scene.camera.setView({
          destination: position,
          orientation: { direction: perp, up },
        });
        cameraUp = C.Cartesian3.normalize(position, new C.Cartesian3());
      }

      // Sun elevation above the camera's local horizon (deg).
      const sunElevationDeg =
        (Math.asin(
          Math.max(-1, Math.min(1, C.Cartesian3.dot(sunDir, cameraUp))),
        ) *
          180) /
        Math.PI;

      // Adapter provenance (C12-03 substrate): WebGPU adapter.info, else the
      // WebGL UNMASKED_RENDERER string.
      let adapter = {
        vendor: null,
        architecture: null,
        device: null,
        description: null,
      };
      const ctx = scene.context;
      const gpuAdapter = ctx.adapter ?? ctx._adapter;
      if (gpuAdapter && gpuAdapter.info) {
        const info = gpuAdapter.info;
        adapter = {
          vendor: info.vendor ?? null,
          architecture: info.architecture ?? null,
          device: info.device ?? null,
          description: info.description ?? null,
        };
      } else {
        try {
          const gl = ctx._gl || ctx._originalGLContext || ctx.gl;
          if (gl) {
            const ext = gl.getExtension("WEBGL_debug_renderer_info");
            if (ext) {
              adapter.description = gl.getParameter(
                ext.UNMASKED_RENDERER_WEBGL,
              );
              adapter.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
            }
          }
        } catch {
          // leave adapter unknown
        }
      }

      // Wall-clock readiness budget (see SETTLE_BUDGET_MS in the Node half).
      const settleStart = performance.now();
      let settleFrameCount = 0;
      while (
        performance.now() - settleStart < settleBudgetMs ||
        settleFrameCount < settleMinFrames
      ) {
        scene.render(pinnedTime());
        settleFrameCount++;
        await new Promise((r) => setTimeout(r, settleYieldMs));
      }

      const canvas = scene.canvas;
      const cw = Math.min(crop.width, canvas.width);
      const ch = Math.min(crop.height, canvas.height);
      const ox = Math.floor((canvas.width - cw) / 2);
      const oy = Math.floor((canvas.height - ch) / 2);

      // Project the curated bright-star list to canvas, keep the ones inside the
      // crop; positions are crop-relative for M5.
      const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
        pinnedTime(),
        new C.Matrix3(),
      );
      const expectations = [];
      for (const s of catalog) {
        const ra = C.Math.toRadians(s.ra);
        const dec = C.Math.toRadians(s.dec);
        const teme = new C.Cartesian3(
          Math.cos(dec) * Math.cos(ra),
          Math.cos(dec) * Math.sin(ra),
          Math.sin(dec),
        );
        const dir = C.Matrix3.multiplyByVector(
          temeToFixed,
          teme,
          new C.Cartesian3(),
        );
        C.Cartesian3.normalize(dir, dir);
        const far = C.Cartesian3.multiplyByScalar(
          dir,
          1.0e12,
          new C.Cartesian3(),
        );
        const win = scene.cartesianToCanvasCoordinates(far, new C.Cartesian2());
        if (win && Number.isFinite(win.x) && Number.isFinite(win.y)) {
          const sx = win.x - ox;
          const sy = win.y - oy;
          if (sx >= 0 && sy >= 0 && sx < cw && sy < ch) {
            expectations.push({
              name: s.name,
              vmag: s.vmag,
              screenX: sx,
              screenY: sy,
            });
          }
        }
      }

      return {
        rendererType: scene.context.rendererType,
        skyBrightness: scene.frameState
          ? (scene.frameState.skyBrightness ?? null)
          : null,
        skyAtmosphereVisible: scene.frameState
          ? scene.frameState.skyAtmosphereVisible === true
          : null,
        cameraHeightM: scene.camera?.positionCartographic?.height ?? null,
        sunElevationDeg,
        settleFrameCount,
        settleElapsedMs: performance.now() - settleStart,
        adapter,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        crop: { x: ox, y: oy, width: cw, height: ch },
        expectations,
      };
    },
    {
      pinnedIso: PINNED_ISO,
      aimMode: aim,
      crop: CROP,
      settleBudgetMs: SETTLE_BUDGET_MS,
      settleMinFrames: SETTLE_MIN_FRAMES,
      settleYieldMs: SETTLE_YIELD_MS,
      catalog: CATALOG_EXPECTATIONS,
      skyOn: skyAtmosphereOn === true,
      heightM: Number.isFinite(cameraHeightM) ? cameraHeightM : null,
    },
  );
}

// --------------------------------------------------------------------------
// In-page: apply the M6 toggles (or the bracket exposure), settle, and capture
// the crop in the SAME task as the final render (RULE 2).
// --------------------------------------------------------------------------
async function captureMode(page, { mode, crop, exposure, hdr }) {
  return page.evaluate(
    async ({
      captureMode,
      cropRect,
      exposureFactor,
      useHdr,
      settleBudgetMs,
      settleMinFrames,
      settleYieldMs,
    }) => {
      await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const pinnedTime = () => viewer.clock.currentTime;

      const skyBox = scene.skyBox;
      if (skyBox) {
        if (captureMode === "cubemap-only") {
          skyBox.show = true;
          if (skyBox.starField) {
            skyBox.starField.show = false;
          }
        } else if (
          captureMode === "sprites-only" ||
          captureMode === "bracket"
        ) {
          // sprites-only AND bracket are catalogue-only: cubemap off, sprites on.
          skyBox.show = false;
          if (skyBox.starField) {
            skyBox.starField.show = true;
          }
        } else {
          // "default" and both Lane-B modulation modes are the full sky.
          skyBox.show = true;
          if (skyBox.starField) {
            skyBox.starField.show = true;
          }
        }
      }

      // Lane B A/B: the modulation flag lives on the atmospheric-conditions
      // facade, which `Scene` republishes to frameState every frame regardless
      // of `globe.show`.
      let modulationFlag = null;
      const skyLeaf = scene.globe?.atmosphericConditions?.skyAtmosphere;
      if (skyLeaf) {
        if (captureMode === "modulation-off") {
          skyLeaf.enableStarBrightnessModulation = false;
        } else if (captureMode === "modulation-on") {
          skyLeaf.enableStarBrightnessModulation = true;
        }
        modulationFlag = skyLeaf.enableStarBrightnessModulation === true;
      }

      let hdrEngaged = null;
      if (useHdr) {
        scene.highDynamicRange = true;
        hdrEngaged = scene.highDynamicRange === true;
        if (scene.postProcessStages) {
          scene.postProcessStages.exposure = exposureFactor;
        }
      }

      // RULE 2 — final render + readback in ONE task, no await between.
      const grab = () => {
        scene.render(pinnedTime());
        const canvas = scene.canvas;
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx = tmp.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        return ctx.getImageData(
          cropRect.x,
          cropRect.y,
          cropRect.width,
          cropRect.height,
        );
      };

      const settle = () => {
        const start = performance.now();
        let frames = 0;
        return (async () => {
          while (
            performance.now() - start < settleBudgetMs ||
            frames < settleMinFrames
          ) {
            scene.render(pinnedTime());
            frames++;
            await new Promise((r) => setTimeout(r, settleYieldMs));
          }
          return frames;
        })();
      };

      // WARM-UP CAPTURE — settle, capture, DISCARD. The readback itself is part
      // of the work being warmed (canvas alloc, drawImage path, and on WebGPU
      // the present/consume cycle), so warming with renders alone would leave
      // the first real capture measuring a cold path. Nothing from this pass
      // reaches the metrics.
      const warmupFrames = await settle();
      grab();

      const settleFrameCount = await settle();
      const full = grab();

      return {
        width: cropRect.width,
        height: cropRect.height,
        data: Array.from(full.data),
        skyBrightness: scene.frameState
          ? (scene.frameState.skyBrightness ?? null)
          : null,
        skyAtmosphereVisible: scene.frameState
          ? scene.frameState.skyAtmosphereVisible === true
          : null,
        modulationFlag,
        warmupDiscarded: true,
        warmupFrames,
        settleFrameCount,
        hdrEngaged,
        exposureFactor: useHdr ? exposureFactor : null,
        cubemapOn: !!(skyBox && skyBox.show),
        spritesOn: !!(skyBox && skyBox.starField && skyBox.starField.show),
      };
    },
    {
      captureMode: mode,
      cropRect: crop,
      exposureFactor: exposure ?? 1,
      useHdr: !!hdr,
      settleBudgetMs: SETTLE_BUDGET_MS,
      settleMinFrames: SETTLE_MIN_FRAMES,
      settleYieldMs: SETTLE_YIELD_MS,
    },
  );
}

function toImage(capture) {
  return {
    data: new Uint8ClampedArray(capture.data),
    width: capture.width,
    height: capture.height,
  };
}

// EncodePNG — copied verbatim from capture-and-diff.mjs so the written PNG is
// byte-identical to the pixels the metrics measured (imageSha256 covers exactly
// what was gated).
function encodePNG(rgba, width, height) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function adler32(buf) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }
  function chunk(type, data) {
    const len = data.length;
    const out = new Uint8Array(8 + len + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + len);
    crcInput.set(out.subarray(4, 8 + len));
    dv.setUint32(8 + len, crc32(crcInput));
    return out;
  }
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width);
  ihdrDv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowSize = width * 4 + 1;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowSize + 1);
  }
  const blocks = [];
  const MAX = 65535;
  for (let i = 0; i < raw.length; i += MAX) {
    const len = Math.min(MAX, raw.length - i);
    const last = i + len === raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    header[1] = len & 0xff;
    header[2] = (len >>> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >>> 8) & 0xff;
    blocks.push(header, raw.subarray(i, i + len));
  }
  const totalBlocks = blocks.reduce((s, b) => s + b.length, 0);
  const idatPayload = new Uint8Array(2 + totalBlocks + 4);
  idatPayload[0] = 0x78;
  idatPayload[1] = 0x01;
  let off = 2;
  for (const b of blocks) {
    idatPayload.set(b, off);
    off += b.length;
  }
  const adler = adler32(raw);
  const dv = new DataView(idatPayload.buffer);
  dv.setUint32(idatPayload.length - 4, adler);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", idatPayload);
  const iendChunk = chunk("IEND", new Uint8Array(0));
  const total = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  total.set(sig, 0);
  total.set(ihdrChunk, sig.length);
  total.set(idatChunk, sig.length + ihdrChunk.length);
  total.set(iendChunk, sig.length + ihdrChunk.length + idatChunk.length);
  return total;
}

// Build the 14-field provenance manifest entry (visual-gate-policy.mjs:9-24).
function buildManifestEntry({
  scene,
  image,
  pngBytes,
  renderer,
  env,
  git,
  sceneIdentity,
  extra,
}) {
  return {
    scene,
    image,
    imageSha256: sha256(pngBytes),
    renderer,
    provenanceClass: "probe-evidence",
    sourceCommit: git.sourceCommit,
    sourceDirty: git.sourceDirty,
    width: CROP.width,
    height: CROP.height,
    sceneIdentity,
    browserClass: env.browserClass,
    browserVersion: env.browserVersion,
    adapterClass: env.adapterClass,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

// Stitch the 1x/8x/64x captures into a linear-light float composite.
function stitchBracket(captures) {
  const { width, height } = captures[0];
  const n = width * height * 4;
  const out = new Float64Array(n);
  // Highest factor first so the first unclipped sample wins.
  const ordered = captures
    .slice()
    .sort((a, b) => b.exposureFactor - a.exposureFactor);
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      let linear = 0;
      for (const cap of ordered) {
        const v = cap.data[i + c];
        if (v < 250) {
          linear = v / 255 / cap.exposureFactor;
          break;
        }
      }
      // Every exposure clipped (v>=250 everywhere): fall back to the lowest
      // exposure's normalized value so a saturated core still reads as bright.
      if (linear === 0) {
        const lowest = ordered[ordered.length - 1];
        linear = lowest.data[i + c] / 255 / lowest.exposureFactor;
      }
      out[i + c] = linear;
    }
    out[i + 3] = 1;
  }
  return { data: out, width, height };
}

async function runBackend(
  browser,
  renderer,
  { aim, hdr, modes, skyAtmosphereOn, cameraHeightM },
) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(5000);

    const setup = await setupScene(page, {
      aim,
      skyAtmosphereOn,
      cameraHeightM,
    });
    const captures = {};
    if (hdr) {
      for (const [factor, label] of [
        [1, "1x"],
        [8, "8x"],
        [64, "64x"],
      ]) {
        captures[label] = await captureMode(page, {
          mode: "bracket",
          crop: setup.crop,
          exposure: factor,
          hdr: true,
        });
      }
    } else {
      // Order is the caller's explicit, justified sequence — see
      // G1_MODE_CAPTURE_ORDER / COLUMN_MODE_CAPTURE_ORDER.
      for (const mode of modes ?? G1_MODE_CAPTURE_ORDER) {
        captures[mode] = await captureMode(page, {
          mode,
          crop: setup.crop,
          hdr: false,
        });
      }
    }
    return {
      ok: true,
      renderer,
      setup,
      captures,
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } catch (e) {
    return {
      ok: false,
      renderer,
      error: String((e && e.message) || e).slice(0, 400),
      consoleErrors: consoleErrors.slice(0, 6),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function metricsForImage(image) {
  const m1 = m1PointSourceCensus(image);
  const m2 = m2ContrastTail(image);
  const m2e = m2eSkyFloor(image);
  const m3 = m3Chroma(image, m1.sources);
  return { m1, m2, m2e, m3 };
}

function writeCapturePng(image, name) {
  const png = encodePNG(image.data, image.width, image.height);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, png);
  return { file, png };
}

// The two G1 lanes. `cameraHeightM: null` means "use the historical orbital
// distance"; a finite value places the eye that far above the ellipsoid on the
// sun ray. `skyAtmosphereOn` decides both whether the background is black (and
// therefore whether the M2e quantization bound applies) and whether
// `frameState.skyAtmosphereVisible` — a hard precondition of the star-modulation
// term — can ever be true.
const G1_LANE_SPECS = [
  {
    key: "cubemapParity",
    id: "orbital-cubemap-parity",
    role: "cubemap + sprite parity over a black background (M6 source split)",
    modes: G1_MODE_CAPTURE_ORDER,
    countModes: G1_COUNT_MODES,
    certifyingMode: G1_CERTIFYING_MODE,
    skyAtmosphereOn: false,
    cameraHeightM: null,
  },
  {
    key: "starModulation",
    id: "in-column-star-modulation",
    role: "C11-176 star-brightness modulation, inside the atmospheric column",
    modes: COLUMN_MODE_CAPTURE_ORDER,
    countModes: [],
    certifyingMode: "modulation-on",
    skyAtmosphereOn: true,
    cameraHeightM: IN_COLUMN_HEIGHT_M,
  },
];

function comparePair(glImg, gpuImg) {
  const glM = metricsForImage(glImg);
  const gpuM = metricsForImage(gpuImg);
  return {
    m1CountRatio: ratio(gpuM.m1.count, glM.m1.count),
    m2aRatio: ratio(gpuM.m2.rmsContrast, glM.m2.rmsContrast),
    m2bRatio: ratio(gpuM.m2.p999MinusP50, glM.m2.p999MinusP50),
    m3ChromaRatio: ratio(gpuM.m3.medianSaturation, glM.m3.medianSaturation),
    // ATTRIBUTION FACTORS for m2aRatio = (sigma/mu)_gpu / (sigma/mu)_gl. Without
    // both of these a failing m2aRatio cannot be attributed to a mean/pedestal
    // shift versus a contrast excess — the omission that produced C12-G1F2.
    meanLumRatio: ratio(gpuM.m2.mean, glM.m2.mean),
    stddevRatio: ratio(gpuM.m2.stddev, glM.m2.stddev),
    webglMean: glM.m2.mean,
    webgpuMean: gpuM.m2.mean,
    webglStddev: glM.m2.stddev,
    webgpuStddev: gpuM.m2.stddev,
    webglM1Count: glM.m1.count,
    webgpuM1Count: gpuM.m1.count,
    webglSkyFloor: glM.m2e.skyFloor,
    webgpuSkyFloor: gpuM.m2e.skyFloor,
  };
}

async function runG1Lane(browser, git, spec, browserVersion) {
  const gl = await runBackend(browser, "webgl", {
    aim: "sunlit",
    hdr: false,
    modes: spec.modes,
    skyAtmosphereOn: spec.skyAtmosphereOn,
    cameraHeightM: spec.cameraHeightM,
  });
  const gpu = await runBackend(browser, "webgpu", {
    aim: "sunlit",
    hdr: false,
    modes: spec.modes,
    skyAtmosphereOn: spec.skyAtmosphereOn,
    cameraHeightM: spec.cameraHeightM,
  });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const envOf = (backend) => ({
    browserClass: "msedge",
    browserVersion,
    adapterClass: normalizeHardwareClass([
      backend.setup.adapter.vendor,
      backend.setup.adapter.architecture,
      backend.setup.adapter.device,
      backend.setup.adapter.description,
    ]),
  });

  const manifest = {};
  const perMode = {};
  for (const mode of spec.modes) {
    const glImg = toImage(gl.captures[mode]);
    const gpuImg = toImage(gpu.captures[mode]);
    perMode[mode] = comparePair(glImg, gpuImg);

    for (const [renderer, backend, img] of [
      ["webgl", gl, glImg],
      ["webgpu", gpu, gpuImg],
    ]) {
      const sceneName = `celestial-g1-${spec.id}-${mode}`;
      const pngName = `${sceneName}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: {
          aim: "sunlit",
          heightM: spec.cameraHeightM,
          distance: spec.cameraHeightM === null ? 5.0e7 : null,
          pinnedIso: PINNED_ISO,
        },
        setup: "celestial-gate-g1",
        setupParams: {
          lane: spec.id,
          mode,
          globeOff: true,
          sunOff: true,
          skyAtmosphereOn: spec.skyAtmosphereOn,
          settleBudgetMs: SETTLE_BUDGET_MS,
          warmupDiscarded: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_MIN_FRAMES,
        viewport: VIEWPORT,
      });
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: envOf(backend),
        git,
        sceneIdentity,
        extra: {
          hdr: false,
          lane: spec.id,
          skyBrightness: r3(backend.captures[mode].skyBrightness),
          skyAtmosphereVisible: backend.captures[mode].skyAtmosphereVisible,
          modulationFlag: backend.captures[mode].modulationFlag,
          cameraHeightM: r3(backend.setup.cameraHeightM),
          sunElevationDeg: r3(backend.setup.sunElevationDeg),
        },
      });
    }
  }

  // skyBrightness is read from the CERTIFYING mode's own capture, not from
  // setup: the reachability claim has to describe the frame that was gated.
  const certifying = spec.certifyingMode;
  const laneInput = {
    id: spec.id,
    role: spec.role,
    skyBrightness: {
      webgl: gl.captures[certifying].skyBrightness,
      webgpu: gpu.captures[certifying].skyBrightness,
    },
    skyAtmosphereVisible: {
      webgl: gl.captures[certifying].skyAtmosphereVisible,
      webgpu: gpu.captures[certifying].skyAtmosphereVisible,
    },
    sunElevationDeg: {
      webgl: r3(gl.setup.sunElevationDeg),
      webgpu: r3(gpu.setup.sunElevationDeg),
    },
    cameraHeightM: {
      webgl: r3(gl.setup.cameraHeightM),
      webgpu: r3(gpu.setup.cameraHeightM),
    },
    countModes: spec.countModes,
    perMode,
  };

  return { fatal: false, laneInput, manifest, gl, gpu };
}

async function runG1(browser, git) {
  const browserVersion = browser.version();
  const lanes = {};
  const manifest = {};
  const consoleErrors = {};
  for (const spec of G1_LANE_SPECS) {
    const run = await runG1Lane(browser, git, spec, browserVersion);
    if (run.fatal) {
      return { fatal: true, gl: run.gl, gpu: run.gpu };
    }
    Object.assign(manifest, run.manifest);
    consoleErrors[`${spec.id}:webgl`] = run.gl.consoleErrors;
    consoleErrors[`${spec.id}:webgpu`] = run.gpu.consoleErrors;
    lanes[spec.key] =
      spec.key === "starModulation"
        ? evaluateStarModulationLane(run.laneInput)
        : evaluateCubemapParityLane(run.laneInput);
  }

  const folded = foldG1Verdict(lanes);
  return {
    fatal: false,
    gate: "G1",
    ...folded,
    pass: folded.exitCode === EXIT_CODE.PASS,
    // Kept at the top level for continuity with the historical report shape.
    // It now reports the STAR-MODULATION lane, i.e. the variable that actually
    // drives the defect, not the orbital lane's solar-elevation proxy.
    framingReached: lanes.starModulation?.framingReached ?? false,
    orbitalLaneFramingReached: lanes.cubemapParity?.framingReached ?? false,
    lanes,
    manifest,
    consoleErrors,
  };
}

function bracketDiagnostics(setup, composite) {
  const m1 = m1PointSourceCensus(composite, { alreadyLinear: true });
  if (m1.count === 0) {
    return { m1Count: 0, m4: null, m5: null };
  }
  // Brightest detected source for M4.
  let brightest = m1.sources[0];
  for (const s of m1.sources) {
    if (s.peak > brightest.peak) {
      brightest = s;
    }
  }
  const m4 = m4RadialFalloff(
    composite,
    { x: brightest.x, y: brightest.y },
    {
      alreadyLinear: true,
    },
  );
  const m5 = m5MagnitudeFidelity(setup.expectations, m1.sources, {
    maxDistance: 3,
  });
  return {
    m1Count: m1.count,
    brightest: { x: brightest.x, y: brightest.y, peak: brightest.peak },
    m4: {
      rCore: r3(m4.rCore),
      r1e2: r3(m4.r1e2),
      r1e3: r3(m4.r1e3),
      ratio1e3: r3(m4.ratio1e3),
      slopeInner: r3(m4.slopeInner),
      slopeOuter: r3(m4.slopeOuter),
      peak: r3(m4.peak),
    },
    m5: {
      matched: m5.matched.length,
      spearman: r3(m5.spearman),
      exponent: r3(m5.exponent),
      brightestFaintestRatio: r3(m5.brightestFaintestRatio),
    },
  };
}

async function runBracket(browser, git) {
  const gl = await runBackend(browser, "webgl", { aim: "sirius", hdr: true });
  const gpu = await runBackend(browser, "webgpu", { aim: "sirius", hdr: true });
  if (!gl.ok || !gpu.ok) {
    return { fatal: true, gl, gpu };
  }

  const browserVersion = browser.version();
  const lanes = {};
  const manifest = {};
  let structuralPass = true;
  for (const [renderer, lane] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    const caps = [
      lane.captures["1x"],
      lane.captures["8x"],
      lane.captures["64x"],
    ];
    const hdrEngaged = caps.every((c) => c.hdrEngaged === true);
    const composite = stitchBracket(caps);

    // Range-extension proof: the 64x lane must reveal signal where the 1x lane
    // read hard 0 (below the 8-bit floor), around the brightest source.
    const oneX = toImage(caps.find((c) => c.exposureFactor === 1));
    const diag = bracketDiagnostics(lane.setup, composite);
    let rangeExtended = false;
    if (diag.m1Count > 0 && diag.brightest) {
      const { x, y } = diag.brightest;
      // ring at radius ~12 px from the core, where the 8-bit 1x capture is 0.
      let oneXFloorZero = false;
      let compositeSignal = false;
      for (let a = 0; a < 8; a++) {
        const px = Math.round(x + 12 * Math.cos((a / 8) * Math.PI * 2));
        const py = Math.round(y + 12 * Math.sin((a / 8) * Math.PI * 2));
        if (px >= 0 && py >= 0 && px < oneX.width && py < oneX.height) {
          const i = (py * oneX.width + px) * 4;
          const lum8 = oneX.data[i] + oneX.data[i + 1] + oneX.data[i + 2];
          const cl =
            composite.data[i] + composite.data[i + 1] + composite.data[i + 2];
          if (lum8 === 0) {
            oneXFloorZero = true;
          }
          if (cl > 1e-4) {
            compositeSignal = true;
          }
        }
      }
      rangeExtended = oneXFloorZero && compositeSignal;
    }

    const laneOk = hdrEngaged && diag.m1Count > 0;
    if (!laneOk) {
      structuralPass = false;
    }

    // Manifest per bracket exposure step (HDR-lane evidence).
    for (const cap of caps) {
      const img = toImage(cap);
      const label = `${cap.exposureFactor}x`;
      const sceneName = `celestial-bracket-${label}`;
      const pngName = `celestial-bracket-${label}-${renderer}.png`;
      const { png } = writeCapturePng(img, pngName);
      const sceneDescriptor = {
        name: sceneName,
        camera: { aim: "sirius", distance: 5.0e7, pinnedIso: PINNED_ISO },
        setup: "celestial-gate-bracket",
        setupParams: {
          exposure: cap.exposureFactor,
          hdr: true,
          spritesOnly: true,
        },
      };
      const sceneIdentity = createSceneIdentity(sceneDescriptor, {
        baseUrl: BASE,
        settleFrames: SETTLE_MIN_FRAMES,
        viewport: VIEWPORT,
      });
      manifest[`${sceneName}:${renderer}`] = buildManifestEntry({
        scene: sceneName,
        image: pngName,
        pngBytes: png,
        renderer,
        env: {
          browserClass: "msedge",
          browserVersion,
          adapterClass: normalizeHardwareClass([
            lane.setup.adapter.vendor,
            lane.setup.adapter.architecture,
            lane.setup.adapter.device,
            lane.setup.adapter.description,
          ]),
        },
        git,
        sceneIdentity,
        extra: {
          hdr: true,
          exposureFactor: cap.exposureFactor,
          hdrEngaged: cap.hdrEngaged,
        },
      });
    }

    lanes[renderer] = { hdrEngaged, rangeExtended, ...diag };
  }

  return {
    fatal: false,
    gate: "bracket",
    structuralPass,
    lanes,
    manifest,
    gl,
    gpu,
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const git = getGit();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let result;
  let exitCode;
  try {
    result = BRACKET
      ? await runBracket(browser, git)
      : await runG1(browser, git);
  } finally {
    await browser.close().catch(() => {});
  }

  if (result.fatal) {
    console.error(
      "[probe-celestial-gates] ERROR — a backend lane did not run at all",
    );
    for (const lane of [result.gl, result.gpu]) {
      if (lane && !lane.ok) {
        console.error(`  ${lane.renderer}: ${lane.error}`);
        for (const e of lane.consoleErrors || []) {
          console.error(`    console: ${e}`);
        }
      }
    }
    clearTimeout(watchdog);
    process.exit(EXIT_CODE.ERROR);
  }

  const outName = BRACKET ? "celestial-bracket.json" : "celestial-g1.json";
  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  if (BRACKET) {
    const summary = {
      gate: "bracket (C12-02 evidence, HDR lane)",
      structuralPass: result.structuralPass,
      lanes: Object.fromEntries(
        Object.entries(result.lanes).map(([k, v]) => [
          k,
          {
            hdrEngaged: v.hdrEngaged,
            rangeExtended: v.rangeExtended,
            m1Count: v.m1Count,
            m4_ratio1e3_DIAGNOSTIC: v.m4 ? v.m4.ratio1e3 : null,
            m5_spearman_DIAGNOSTIC: v.m5 ? v.m5.spearman : null,
            m5_matched: v.m5 ? v.m5.matched : null,
          },
        ]),
      ),
    };
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.structuralPass ? 0 : 1;
    console.log(
      exitCode === 0
        ? "bracket PASS — HDR engaged, sources detected, range extended on both backends"
        : "bracket FAIL — HDR not engaged and/or no source detected on a backend",
    );
  } else {
    console.log(JSON.stringify(buildG1Summary(result), null, 2));
    console.log(`\n[full report: ${outPath}]`);
    exitCode = result.exitCode;
    const verdictLine = {
      [EXIT_CODE.PASS]:
        "G1 PASS — cubemap/sprite parity holds AND the in-column star-modulation lane reached its failure state at parity",
      [EXIT_CODE.FAIL]: "G1 FAIL — see failures/lanes above",
      [EXIT_CODE.STRUCTURAL]:
        "G1 STRUCTURAL — a lane ran but could not see its subject; this is NOT a pass and NOT a defect (see structural[] above)",
    };
    console.log(verdictLine[exitCode] ?? `G1 exit ${exitCode}`);
  }

  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-celestial-gates] FATAL", e);
  clearTimeout(watchdog);
  process.exit(EXIT_CODE.ERROR);
});
