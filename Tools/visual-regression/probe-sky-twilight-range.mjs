#!/usr/bin/env node
// C12-34 sky-brightness twilight range — browser acceptance probe (Batch 823+).
// @purpose C12-34 browser acceptance for the twilight sky-brightness curve: shipped-module ENGINE leg plus positional star-contribution PIXELS leg.
// @status ACTIVE
//
// The Node spec (sky-brightness-twilight.spec.mjs, 27/27) proves the MODEL.
// This probe proves the shipped RUNTIME executes that model in a real browser
// on both backends, and that the result reaches the screen.
//
// Two independent gates per lane:
//
//   ENGINE — the page imports the SHIPPED SkyBrightness module out of the
//     served bundle and evaluates it at a pinned solar elevation, then compares
//     against the factors the Node spec derived. A mismatch means the browser
//     is running different code than the spec measured (stale bundle, a build
//     that dropped the change, or a backend-specific divergence).
//
//   PIXELS — star CONTRIBUTION in a sky band: capture with the star field on
//     and off at the same instant, and count the pixels the star field ADDS.
//     Deliberately a point/structural metric, never a band mean: the old and
//     new estimators are BYTE-IDENTICAL at both ends of the range, so an
//     aggregate over the whole sky is arithmetically blind to this change (the
//     trap recorded across this campaign and in the eclipse work).
//
// ⚠ RE-SCOPED 2026-08-07 FOR DR-01 (CO-3,
// `PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS`). The PIXELS leg's structural
// precondition used to be a FITTED COUNT: `starAddedPixels[darkest] >= 50` on
// both backends. That number was calibrated when the shipped cube map was the
// UN-blurred `TYCHO_T5` bake and resolved stars were plentiful and bright.
// Batch 833 (C12-11 / DR-01) made `TYCHO_T5_DIFFUSE` the default: the cube map
// now carries diffuse light ONLY and every resolved star comes from the sprite
// catalogue, whose exposure anchors a vmag-3.6 star at 15.3/255. A 50-pixel
// floor over a sprite-only field sits right on top of the expected value for
// this framing (a uniform sky puts ~36 stars brighter than the `a - b > 24`
// bar in a 1024x768 60-degree frame, each lighting a handful of pixels), so it
// was a coin flip rather than a control.
//
// Following Batch 848's re-scope of `probe-stars-catalog.mjs` — "counting pixels
// against a pre-DR-01 floor measures the REMOVED CUBEMAP, not the catalogue" —
// the precondition is now POSITIONAL and ZERO-BARRED: the darkest lane must
// resolve a point source AT the projected position of the brightest catalogue
// star in frame, on both backends. The `a - b > 24` difference bar is NOT
// loosened: it is a difference metric feeding the MONOTONIC-ORDERING claim, not
// a census, and lowering it would admit dither. What it is not is a
// reachability control, which is the job it was doing.
//
// ⚠ THE CONTROL WAS RUN ON THE ABSOLUTE FRAME AND COULD NOT BE SATISFIED HERE.
// The shared detector's `minPeak` of 40 exists to separate a resolved star from
// the diffuse cube map, and the same module's note derives that only stars
// brighter than vmag 2.56 clear it — in SPACE. This lane's camera is 500 m off
// the ground, where the shipped per-star extinction cuts a star at 30 degrees
// elevation to roughly a third, moving the bar past vmag 1.5; the brightest
// star an anti-solar 60-degree frame contains at the control instant is vmag
// 2.14, whose peak lands near 21 luma. So the control asserted a proposition
// the framing cannot deliver, and a miss read as "the star field drew nothing".
// It now censuses the STARS-ON minus STARS-OFF difference of the same pinned
// instant, where the cube map and the sky shell cancel and the honest bar is
// zero. The absolute census is still computed and printed beside it.
//
// ⚠ REPAIRED 2026-08-07 — THE PIXELS LEG USED TO RENDER AT THE WALL CLOCK.
// `useDefaultRenderLoop = false` (below) kills `CesiumWidget.render()`, which is
// the ONLY caller that passes `clock.tick()` into `Scene.render`. Every render
// in this file was then a bare `s.render()`, and `Scene.js` answers a missing
// time argument with `JulianDate.now()` — so the four clock-solved lanes were
// all DRAWN at whatever the wall clock said, while the ENGINE leg evaluated the
// solved instants. The two legs described different scenes, which is exactly
// what the comment at the clock solver calls "load-bearing, not fussiness", and
// exactly what the landing commit claimed had been fixed. Every render now
// passes `at()`, and the gate carries a STRUCTURAL guard (`renderedSunTracked`)
// that reads the sun back OUT of the rendered frame and requires it to match the
// lane it was solved for — so this class cannot recur silently. See
// `probe-celestial-gates.mjs`'s BINDING PROBE RULES, rule 1.
//
// Lanes (predictions from the Batch 823 derivation):
//   N  sun -20 deg  factor 1.000000  CONTROL — must be byte-identical to pre-C12-34
//   A  sun -15 deg  factor 0.604705  astronomical twilight
//   B  sun  -9 deg  factor 0.098257  nautical
//   C  sun  -3 deg  factor 0.006619  civil (was 0.370549)
// The old curve returned EXACTLY 0 below -5.74 deg, so lanes A and B are the
// ones that could not have existed before: their whole span was 0.000000.
//
// Usage: node Tools/visual-regression/probe-sky-twilight-range.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
// ONE HOME for the resolved-point-source claim. The census itself is the same
// module the skybox bake and `probe-stars-catalog.mjs` use, at its UNCHANGED
// geometry; the shared wrapper here owns the absolute-frame form and the
// stars-on-minus-off difference form, and is unit-tested in
// `sky-shell-star-occlusion.spec.mjs`.
import {
  STAR_AIM_TOLERANCE_PX,
  STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR,
  censusAtTarget,
  censusAtTargetDifference,
  isStarReachable,
} from "./lib/star-contribution-census.mjs";

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run.
const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-sky-twilight-range] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const VIEW = { width: 1024, height: 768 };

// Solar elevation (deg) -> factor predicted by the Batch 823 derivation.
const LANES = [
  { id: "N", elevationDeg: -20, predicted: 1.0, control: true },
  { id: "A", elevationDeg: -15, predicted: 0.604705 },
  { id: "B", elevationDeg: -9, predicted: 0.098257 },
  { id: "C", elevationDeg: -3, predicted: 0.006619 },
];

// The engine leg is exact math on shipped code, so it gets a tight bound; the
// factor is a pure function of the pinned elevation with no sampling noise.
const ENGINE_TOL = 5e-4;

// STRUCTURAL GUARD on the repaired render-time discipline, in degrees.
//
// The sun direction is read back off `uniformState.sunDirectionWC` in the SAME
// task as the final render, so it is the sun the frame was DRAWN with. It must
// land on the elevation the clock was solved for. The bound is loose enough to
// absorb the ~0.53 deg solar disc and the bisection's own residual and tight
// enough that a wall-clock substitution — which puts the sun tens of degrees
// away, and puts ALL FOUR LANES AT THE SAME PLACE — cannot slip through.
const RENDERED_ELEVATION_TOL_DEG = 1.0;
// And the four lanes must be measurably DIFFERENT scenes. Their solved
// elevations are -20/-15/-9/-3, so the smallest legitimate gap is 5 deg; a
// wall-clock leg collapses this to ~0.
const RENDERED_ELEVATION_MIN_SPREAD_DEG = 2.0;

// POST-DR-01 REACHABILITY CONTROL (see the header).
//
// Half-width, in pixels, of the box shipped out of the page around the brightest
// in-frame catalogue star at the CONTROL lane. 40 gives an 81x81 box: wide
// enough that the detector's 5 px background ring is never clamped against an
// edge, small enough that the payload is ~26 KB rather than a whole frame.
const CENSUS_BOX_HALF_PX = 40;
//
// ⚠ REPAIRED 2026-08-29 (Q-115) — the `differencePeak` value this control
// reports used to have no floor of its own: reachability instead fell through
// to the unrelated whole-frame `addedPixels()` metric below (threshold 24 on
// an RGB SUM), which an Edge executor reverse-engineered as "differencePeak
// >= 8" by eye rather than from this control's own framing. That floor was
// mis-derived for a star this header already documents is heavily
// extinguished. The floor is now `STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR`
// (2.468) imported from `lib/star-contribution-census.mjs`.
//
// ⚠ CORRECTED post-B1-review (station-3 pass 1) — a first version of this
// floor re-applied this header's "roughly a third" extinction figure a
// SECOND time, on top of the ~21.2-luma peak that is already the
// POST-extinction value (the computed extinction ratio at this elevation is
// 0.41544, not the header's rounded 0.3333, and either way it must not be
// applied twice). At the correct computed ratio the resulting floor would
// have been 7.31, which fails the tranche's own banked measurement of 6.07 —
// the exact false-fail class this row exists to remove. The floor is now a
// DECLARED SAFETY FACTOR (0.14) applied to the extinguished peak, stated as
// roughly half of the one banked render observation (6.07 / 21.1969 =
// 0.2864) rather than derived from it, plus one 8-bit quantization
// half-code. Full derivation, with the arithmetic, lives beside
// `deriveStarReachabilityFloor` in the shared module — ONE HOME, not
// transcribed here. Unit-tested in `sky-shell-star-occlusion.spec.mjs`
// against the pre-fix erased state (0.0), the modelled shell-composite
// residual (~0.095), and tranche 3e-C's banked post-fix measurement (6.07) —
// with no assertion pinning the floor's distance from any single
// measurement, which was the B1 finding against the first version.
//
// The positional claim, and why it runs on the difference image, live in
// `lib/star-contribution-census.mjs` — including the tolerance imported above.

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  try {
    return await runWith(browser, renderer);
  } finally {
    // The bare `await browser.close()` this replaces was skipped whenever the
    // evaluate threw, leaving a headless Edge + GPU process alive.
    await browser.close();
  }
}

async function runWith(browser, renderer) {
  const page = await browser.newPage({ viewport: VIEW });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) =>
    errs.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(
    async ({ lanes, view, censusBoxHalf }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.globe.show = false; // sky-only frame: no terrain pixels in the band
      s.backgroundColor = C.Color.BLACK;
      v.useDefaultRenderLoop = false;
      for (const sel of [
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-toolbar",
        ".cesium-viewer-fullscreenContainer",
        ".cesium-viewer-navigationContainer",
        ".cesium-navigation-help",
        ".cesium-renderer-toggle",
      ]) {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      }

      const dev = s.context?._device;
      const deviceErrs = [];
      if (dev) {
        dev.onuncapturederror = (ev) =>
          deviceErrs.push(String(ev?.error?.message ?? "").slice(0, 200));
      }

      // The SHIPPED module — not a re-implementation. SkyBrightness is an
      // INTERNAL module: it is not re-exported from the public Cesium barrel,
      // so it is imported from the served source tree (the same live modules
      // the CesiumViewer page itself executes) rather than from the bundle.
      const {
        computeSkyBrightness,
        computeCelestialElevationSine,
        NIGHT_ZENITH_MAGNITUDE,
      } = await import("/packages/engine/Source/Scene/SkyBrightness.js");
      const engineExports = {
        computeSkyBrightness: typeof computeSkyBrightness === "function",
        computeCelestialElevationSine:
          typeof computeCelestialElevationSine === "function",
        nightZenithMagnitude: NIGHT_ZENITH_MAGNITUDE ?? null,
      };

      // The SHIPPED catalogue — under DR-01 it is the sole source of resolved
      // stars, so it is also the only honest oracle for "is a star there".
      const { default: BrightStarCatalog } =
        await import("/packages/engine/Source/Scene/BrightStarCatalog.js");

      // Ground camera at a fixed site. The lane's sun is SOLVED FROM THE CLOCK
      // (see `solveClock` below) and the clock then drives the renderer, so one
      // scene backs both legs. This comment used to claim the opposite —
      // "synthesized ... rather than solved from a clock" — which is the
      // fingerprint of a clock solve retrofitted without touching the render
      // call, and is precisely the state the 2026-08-07 repair found.
      const lon = -105.0;
      const lat = 40.0;
      const cameraPos = C.Cartesian3.fromDegrees(lon, lat, 500.0);
      const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(
        cameraPos,
        new C.Cartesian3(),
      );
      const east = C.Cartesian3.cross(
        C.Cartesian3.UNIT_Z,
        up,
        new C.Cartesian3(),
      );
      C.Cartesian3.normalize(east, east);

      // EVERY render passes the pinned time. `useDefaultRenderLoop = false`
      // above killed the only caller that would have supplied it, and a bare
      // `s.render()` substitutes `JulianDate.now()` — the wall clock — which is
      // what `frameState.time` then stamps and what `UniformState` derives
      // `sunDirectionWC` from. `at()` is read per call, so it always returns the
      // CURRENT lane's solved instant.
      const at = () => v.clock.currentTime;
      const frame = async (n) => {
        for (let i = 0; i < n; i++) {
          s.requestRender();
          s.render(at());
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      const grab = () => {
        const c = s.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d", { willReadFrequently: true });
        cx.drawImage(c, 0, 0);
        return {
          data: cx.getImageData(0, 0, c.width, c.height).data,
          w: c.width,
          h: c.height,
        };
      };
      // SAME-TASK CAPTURE, and the read-back of the sun the frame was DRAWN
      // with. The drawing buffer is cleared once the compositor consumes a
      // presented frame, so the final render, the `sunDirectionWC` read and the
      // `drawImage` must all run without an intervening await. Reading the sun
      // here rather than from setup is the whole point: it is the frame's own
      // state, so it can falsify the render-time discipline instead of merely
      // restating what the probe intended.
      const renderAndGrab = () => {
        s.requestRender();
        s.render(at());
        const renderedSunDir = C.Cartesian3.clone(
          s.context.uniformState.sunDirectionWC,
        );
        return { image: grab(), renderedSunDir };
      };
      // Point metric: how many pixels the star field ADDS. Counting added
      // pixels (not mean luminance) is what survives a change whose ends are
      // byte-identical.
      const addedPixels = (withStars, without) => {
        let added = 0;
        for (let i = 0; i < withStars.data.length; i += 4) {
          const a =
            withStars.data[i] + withStars.data[i + 1] + withStars.data[i + 2];
          const b = without.data[i] + without.data[i + 1] + without.data[i + 2];
          if (a - b > 24) added++;
        }
        return added;
      };

      // POST-DR-01 REACHABILITY CONTROL. Project every catalogue star at the
      // lane's instant and return the BRIGHTEST one that lands inside the frame
      // with room for the detector's background ring. Positional, and sourced
      // from the renderer's own table, so the control cannot drift away from
      // what was drawn.
      const boxHalf = censusBoxHalf;
      const brightestInFrameStar = (jd) => {
        const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
          jd,
          new C.Matrix3(),
        );
        const cat = BrightStarCatalog;
        let best = null;
        for (let i = 0; i < cat.count; i++) {
          const base = i * cat.STRIDE;
          const vmag = cat.data[base + 2];
          if (best !== null && vmag >= best.vmag) continue;
          const ra = C.Math.toRadians(cat.data[base + 0]);
          const dec = C.Math.toRadians(cat.data[base + 1]);
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
          const win = s.cartesianToCanvasCoordinates(far, new C.Cartesian2());
          if (!win || !Number.isFinite(win.x) || !Number.isFinite(win.y)) {
            continue;
          }
          const px = Math.round(win.x);
          const py = Math.round(win.y);
          if (
            px < boxHalf ||
            py < boxHalf ||
            px >= s.canvas.width - boxHalf ||
            py >= s.canvas.height - boxHalf
          ) {
            continue;
          }
          best = { vmag, x: px, y: py, exactX: win.x, exactY: win.y };
        }
        return best;
      };
      const extractBox = (image, cx, cy) => {
        const w = 2 * boxHalf + 1;
        const h = 2 * boxHalf + 1;
        const out = new Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const si = 4 * ((cy - boxHalf + y) * image.w + (cx - boxHalf + x));
            const di = 4 * (y * w + x);
            out[di] = image.data[si];
            out[di + 1] = image.data[si + 1];
            out[di + 2] = image.data[si + 2];
            out[di + 3] = image.data[si + 3];
          }
        }
        return { data: out, w, h, centerX: boxHalf, centerY: boxHalf };
      };

      // Solve the CLOCK for each lane's solar elevation instead of synthesizing
      // a sun direction. This is load-bearing, not fussiness: the renderer draws
      // with the sun the clock produces, so a synthesized direction would have
      // the engine leg and the pixel leg describing DIFFERENT scenes — the math
      // would be checked at one sun and the pixels captured at another. Scan a
      // day at coarse steps for the bracketing pair, then bisect.
      const sunAt = (jd) => {
        const icrf = C.Transforms.computeIcrfToFixedMatrix(jd);
        const sunIcrf =
          C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
            jd,
            new C.Cartesian3(),
          );
        const sunFixed = C.defined(icrf)
          ? C.Matrix3.multiplyByVector(icrf, sunIcrf, new C.Cartesian3())
          : sunIcrf;
        return C.Cartesian3.normalize(sunFixed, new C.Cartesian3());
      };
      const elevOf = (jd) =>
        C.Math.toDegrees(
          Math.asin(
            Math.max(
              -1,
              Math.min(1, computeCelestialElevationSine(sunAt(jd), cameraPos)),
            ),
          ),
        );
      const solveClock = (targetDeg) => {
        const base = C.JulianDate.fromIso8601("2026-03-20T00:00:00Z");
        let lo = null;
        let hi = null;
        let prevJd = base;
        let prevEl = elevOf(base);
        for (let m = 5; m <= 1440; m += 5) {
          const jd = C.JulianDate.addMinutes(base, m, new C.JulianDate());
          const el = elevOf(jd);
          if (prevEl >= targetDeg !== el >= targetDeg) {
            lo = prevJd;
            hi = jd;
            break;
          }
          prevJd = jd;
          prevEl = el;
        }
        if (lo === null) return null;
        for (let i = 0; i < 40; i++) {
          const mid = C.JulianDate.addSeconds(
            lo,
            C.JulianDate.secondsDifference(hi, lo) * 0.5,
            new C.JulianDate(),
          );
          if (elevOf(lo) >= targetDeg !== elevOf(mid) >= targetDeg) hi = mid;
          else lo = mid;
        }
        return lo;
      };

      const out = [];
      let controlBox = null;
      let controlBoxOff = null;
      let controlTarget = null;
      for (const lane of lanes) {
        const jd = solveClock(lane.elevationDeg);
        if (jd === null) {
          out.push({ id: lane.id, unsolved: true });
          continue;
        }
        v.clock.currentTime = jd.clone();
        v.clock.startTime = jd.clone();
        v.clock.stopTime = jd.clone();
        v.clock.shouldAnimate = false;
        v.clock.multiplier = 0;
        const sunDir = sunAt(jd);
        const solvedElevationDeg = elevOf(jd);

        const sinAlt = computeCelestialElevationSine(sunDir, cameraPos);
        // POSITIONAL signature (sunDirWC, moonDirWC, moonPhaseFraction,
        // cameraPositionWC, cameraHeight). Passing an object literal instead
        // makes cameraPositionWC undefined, which the module's documented
        // "misconfigured scene -> full bright" guard answers with exactly 1.0 —
        // so a wrong call shape reads as a permanent bright daytime sky on
        // every lane rather than as an error. Moonless: moonDir undefined,
        // phase 0, so the lane isolates the SOLAR twilight term.
        const factor = computeSkyBrightness(
          sunDir,
          undefined,
          0.0,
          cameraPos,
          500.0,
        );

        // Aim at the anti-solar sky so the band is darkest and star-dominated.
        const antiSun = C.Cartesian3.negate(sunDir, new C.Cartesian3());
        v.camera.setView({
          destination: cameraPos,
          orientation: { direction: antiSun, up: up },
        });

        s.skyBox.starField.show = true;
        await frame(12);
        const withStars = renderAndGrab();
        s.skyBox.starField.show = false;
        await frame(12);
        const without = renderAndGrab();
        s.skyBox.starField.show = true;

        // Reachability control, CONTROL lane only: the darkest lane is the one
        // whose star field must be present for the monotonic-ordering claim to
        // mean anything. Ships BOTH boxes around the brightest in-frame
        // catalogue star — stars-on and stars-off at the same instant — so the
        // shared detector can run in Node over their difference, where the cube
        // map and the sky shell cancel. The probe does not re-implement the
        // census.
        if (lane.control === true) {
          controlTarget = brightestInFrameStar(jd);
          controlBox = controlTarget
            ? extractBox(withStars.image, controlTarget.x, controlTarget.y)
            : null;
          controlBoxOff = controlTarget
            ? extractBox(without.image, controlTarget.x, controlTarget.y)
            : null;
        }

        // The sun the RENDERER used, expressed in the same units as the lane.
        // If this does not equal `solvedElevationDeg`, the pixels and the engine
        // leg are describing different scenes and the PIXELS verdict is void.
        const renderedElevationDeg = C.Math.toDegrees(
          Math.asin(
            Math.max(
              -1,
              Math.min(
                1,
                computeCelestialElevationSine(
                  withStars.renderedSunDir,
                  cameraPos,
                ),
              ),
            ),
          ),
        );

        // computeSkyBrightness returns SKY BRIGHTNESS (0 = astronomical night,
        // 1 = noon). The derivation's published numbers are the STAR
        // MODULATION derived from it via the shipped curve
        // `1 - smoothstep(0, 1, clamp((B - inflection) * steepness, 0, 1))`
        // (inflection 0, steepness 23.0 — documented at
        // AtmosphericConditions.js:506 and asserted byte-identical across all
        // four implementations by sky-brightness-twilight.spec.mjs). Applying
        // it here is instrumentation, not a second source of truth: the gate
        // still compares against factors derived independently of this probe.
        const x = Math.max(0, Math.min(1, (factor - 0.0) * 23.0));
        const modulation = 1 - x * x * (3 - 2 * x);
        out.push({
          id: lane.id,
          elevationDeg: lane.elevationDeg,
          solvedElevationDeg,
          sinAlt,
          skyBrightness: factor,
          factor: modulation,
          renderedElevationDeg,
          starAddedPixels: addedPixels(withStars.image, without.image),
        });
      }
      return {
        engineExports,
        lanes: out,
        deviceErrs,
        controlBox,
        controlBoxOff,
        controlTarget,
        // Configuration diagnostics. The sky shell is drawn AFTER the star
        // field with alpha blending, so whatever alpha it resolves to is a
        // multiplier on every star already in the frame, and the shell's
        // day/night ramp is selected by this enum. Recorded, never gated, so a
        // structural exit names the configuration it happened under.
        skyDynamicLighting: s.skyAtmosphere?.dynamicLighting ?? null,
        globeEnableLighting: s.globe?.enableLighting ?? null,
        starIntensityScale:
          s.skyBox?.starField?._effectiveIntensityScale ?? null,
      };
    },
    { lanes: LANES, view: VIEW, censusBoxHalf: CENSUS_BOX_HALF_PX },
  );

  return { ...result, consoleErrs: errs };
}

const gl = await run("webgl");
const gpu = await run("webgpu");

console.log("=== C12-34 twilight range acceptance ===");
console.log(
  `shipped exports reachable: webgl=${JSON.stringify(gl.engineExports)} webgpu=${JSON.stringify(gpu.engineExports)}`,
);

let enginePass = true;
let pixelPass = true;
let controlPass = true;
for (let i = 0; i < LANES.length; i++) {
  const lane = LANES[i];
  const g = gl.lanes[i];
  const w = gpu.lanes[i];
  const dg = Math.abs(g.factor - lane.predicted);
  const dw = Math.abs(w.factor - lane.predicted);
  const ok = dg <= ENGINE_TOL && dw <= ENGINE_TOL;
  if (!ok) enginePass = false;
  // Both backends must agree exactly — the factor is shared CPU-side math.
  const parity = g.factor === w.factor;
  if (!parity) enginePass = false;
  console.log(
    `lane ${lane.id} (sun ${lane.elevationDeg}deg): predicted=${lane.predicted.toFixed(6)} ` +
      `webgl=${g.factor.toFixed(6)} webgpu=${w.factor.toFixed(6)} ` +
      `starPx gl=${g.starAddedPixels} gpu=${w.starAddedPixels} ` +
      `renderedElev gl=${g.renderedElevationDeg?.toFixed(2)} gpu=${w.renderedElevationDeg?.toFixed(2)} ` +
      `${ok ? "OK" : "MISMATCH"}${parity ? "" : " PARITY-BREAK"}`,
  );
  if (lane.control && g.factor !== 1.0) controlPass = false;
}

// STRUCTURAL PRECONDITION FOR THE PIXELS LEG — the renderer must have DRAWN
// each lane at the instant that lane was solved for.
//
// This is the guard that makes the wall-clock class non-recurrent. It is read
// back out of `uniformState.sunDirectionWC` in the same task as the final
// render, so it describes the FRAME rather than the intent, and it fails in two
// independent ways under a wall-clock substitution: every lane lands far from
// its target elevation, and all four lanes land on the SAME elevation.
const renderedElevations = (run) =>
  run.lanes.map((l) => l.renderedElevationDeg ?? NaN);
const glRenderedElev = renderedElevations(gl);
const gpuRenderedElev = renderedElevations(gpu);
const tracksSolved = (rendered) =>
  rendered.every(
    (deg, i) =>
      Number.isFinite(deg) &&
      Math.abs(deg - LANES[i].elevationDeg) <= RENDERED_ELEVATION_TOL_DEG,
  );
const lanesDiffer = (rendered) => {
  const finite = rendered.filter((d) => Number.isFinite(d));
  if (finite.length !== rendered.length) return false;
  const sorted = [...finite].sort((a, b) => a - b);
  let smallestGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    smallestGap = Math.min(smallestGap, sorted[i] - sorted[i - 1]);
  }
  return smallestGap >= RENDERED_ELEVATION_MIN_SPREAD_DEG;
};
const renderedSunTracked =
  tracksSolved(glRenderedElev) &&
  tracksSolved(gpuRenderedElev) &&
  lanesDiffer(glRenderedElev) &&
  lanesDiffer(gpuRenderedElev);

// Stars must be strictly more visible as the sun gets lower. Monotonic
// ordering is a structural claim a band mean cannot make.
const glStars = gl.lanes.map((l) => l.starAddedPixels);
const gpuStars = gpu.lanes.map((l) => l.starAddedPixels);
const monotonic = (a) => a[0] >= a[1] && a[1] >= a[2] && a[2] >= a[3];

// PRECONDITION, reported STRUCTURAL rather than FAIL: the darkest lane must
// actually draw stars, or this leg is measuring an empty sky and its verdict
// is meaningless either way. A leg that cannot see its own subject must say
// so — scoring it as a product failure would be a phantom defect, and scoring
// it as a pass would be a false green.
//
// RE-SCOPED FOR DR-01 (see the header): the old form was `>= 50` added pixels,
// a floor fitted to the pre-DR-01 cube map. It is POSITIONAL and zero-barred —
// a resolved point source AT the brightest in-frame catalogue star's projected
// position, plus a bare "the sprite layer added something at all".
//
// The census now runs on the STARS-ON minus STARS-OFF difference of the same
// pinned instant rather than on the absolute frame (see the note beside
// `censusAtTargetDifference`): a ground camera's per-star extinction puts the
// brightest star an anti-solar 60-degree frame can contain BELOW the shared
// detector's absolute floor, which is a property of the framing rather than of
// the star field, so the absolute form asserted something the scene could not
// deliver. The absolute census is still computed and reported.
const glCensus = censusAtTargetDifference(gl.controlBox, gl.controlBoxOff);
const gpuCensus = censusAtTargetDifference(gpu.controlBox, gpu.controlBoxOff);
const glAbsoluteCensus = censusAtTarget(gl.controlBox);
const gpuAbsoluteCensus = censusAtTarget(gpu.controlBox);
// Q-115: reachability is now the box census's OWN peak against the derived
// floor (`isStarReachable`), not the unrelated whole-frame `addedPixels()`
// metric (`glStars`/`gpuStars` below) that an executor previously read as a
// de facto "differencePeak >= 8". `glStars`/`gpuStars` remain the metric for
// the separate monotonic-ordering claim across all four lanes, unaffected.
const starsVisible = isStarReachable(glCensus) && isStarReachable(gpuCensus);
let pixelStructuralReason = null;
if (!renderedSunTracked) {
  // Strictly ahead of `starsVisible`: if the frames were not drawn at their
  // lanes' instants, `starAddedPixels` is not a measurement of this lane at all
  // and no conclusion — including "the star field drew nothing" — follows.
  pixelPass = null;
  pixelStructuralReason =
    "the RENDERED sun did not track the solved lane (rendered elevations " +
    `gl=${JSON.stringify(glRenderedElev.map((d) => Number(d?.toFixed?.(2))))} ` +
    `gpu=${JSON.stringify(gpuRenderedElev.map((d) => Number(d?.toFixed?.(2))))} ` +
    `vs solved ${JSON.stringify(LANES.map((l) => l.elevationDeg))}) — the pixel ` +
    "leg and the engine leg described different scenes";
} else if (!starsVisible) {
  pixelPass = null; // structural
  const describe = (name, run, difference, absolute, target, added) =>
    `${name}: ` +
    (difference.available
      ? `target vmag ${target?.vmag ?? "?"} at (${target?.x ?? "?"},${target?.y ?? "?"}), ` +
        `difference census ${difference.count} source(s), nearest ${Number.isFinite(difference.nearestPx) ? difference.nearestPx.toFixed(2) : "none"} px ` +
        `(tolerance ${STAR_AIM_TOLERANCE_PX}), difference peak ${difference.peakMax?.toFixed?.(2)}, ` +
        `absolute box peak luma ${absolute.peakMax?.toFixed?.(1)}, addedPixels ${added}, ` +
        `sky enum ${run.skyDynamicLighting}, globe.enableLighting ${run.globeEnableLighting}, ` +
        `star intensityScale ${run.starIntensityScale}`
      : "no in-frame catalogue star was found to aim the control at");
  pixelStructuralReason =
    "the darkest lane resolved NO star contribution at the target's projected " +
    "position, so this leg measured a sky whose star field it cannot confirm " +
    "was drawn. A zero DIFFERENCE peak means nothing the star field drew " +
    "reached the frame: either the sprites were not drawn (check the reported " +
    "intensityScale) or something composited over them — the sky shell is " +
    "drawn after the star field with alpha blending, so its alpha multiplies " +
    "every star already in the frame, and the reported sky enum selects which " +
    "day/night ramp that alpha uses. Instrument-or-composite, NOT a product " +
    "verdict on the star field; the ENGINE leg above is unaffected — " +
    `${describe("webgl", gl, glCensus, glAbsoluteCensus, gl.controlTarget, glStars[0])}; ` +
    `${describe("webgpu", gpu, gpuCensus, gpuAbsoluteCensus, gpu.controlTarget, gpuStars[0])}`;
} else if (!monotonic(glStars) || !monotonic(gpuStars)) {
  pixelPass = false;
}

const allErrs = [
  ...gl.consoleErrs,
  ...gl.deviceErrs,
  ...gpu.consoleErrs,
  ...gpu.deviceErrs,
];
console.log(
  `\nENGINE (shipped factors match the derivation, both backends): ${enginePass ? "PASS" : "FAIL"}`,
);
console.log(
  `CONTROL (sun -20deg still exactly 1.0, byte-identical end): ${controlPass ? "PASS" : "FAIL"}`,
);
console.log(
  `PIXELS (star contribution monotonic with darkness): ${
    pixelPass === null
      ? `STRUCTURAL - ${pixelStructuralReason}`
      : pixelPass
        ? "PASS"
        : "FAIL"
  } gl=${JSON.stringify(glStars)} gpu=${JSON.stringify(gpuStars)}`,
);
const reachabilityLine = (run, difference, absolute) =>
  JSON.stringify({
    target: run.controlTarget?.vmag ?? null,
    count: difference.count ?? null,
    nearestPx: Number.isFinite(difference.nearestPx)
      ? Number(difference.nearestPx.toFixed(2))
      : null,
    differencePeak: Number.isFinite(difference.peakMax)
      ? Number(difference.peakMax.toFixed(2))
      : null,
    differencePeakFloor: Number(
      STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR.toFixed(4),
    ),
    absolutePeak: Number.isFinite(absolute.peakMax)
      ? Number(absolute.peakMax.toFixed(2))
      : null,
    skyEnum: run.skyDynamicLighting,
    enableLighting: run.globeEnableLighting,
    intensityScale: run.starIntensityScale,
  });
console.log(
  `STAR REACHABILITY (control lane resolves the star field's OWN contribution ` +
    `AT the target's projected position, tolerance ${STAR_AIM_TOLERANCE_PX} px): ` +
    `${starsVisible ? "PASS" : "STRUCTURAL"} ` +
    `gl=${reachabilityLine(gl, glCensus, glAbsoluteCensus)} ` +
    `gpu=${reachabilityLine(gpu, gpuCensus, gpuAbsoluteCensus)}`,
);
console.log(
  `RENDER-TIME (the frames were drawn at the lanes' solved instants): ${
    renderedSunTracked ? "PASS" : "STRUCTURAL"
  } renderedElevDeg gl=${JSON.stringify(glRenderedElev.map((d) => Number(d?.toFixed?.(2))))} ` +
    `gpu=${JSON.stringify(gpuRenderedElev.map((d) => Number(d?.toFixed?.(2))))}`,
);
console.log(`errors: ${allErrs.length}`);
if (allErrs.length) console.log(allErrs.slice(0, 6).join("\n"));

// EXIT CODES: 0 PASS | 1 FAIL (a measurable criterion missed) | 3 STRUCTURAL (a
// leg RAN but could not see its subject).
//
// The pixel leg used to be allowed through as a pass on the stated grounds that
// the ENGINE leg is the acceptance claim and is exact. That is still true of the
// ENGINE claim, and nothing about it is weakened here — but an exit 0 cannot
// distinguish "both legs certified" from "one leg measured nothing", and this
// probe's own history is the case for the distinction: the structural pixel leg
// recorded at Batch 860 was an INSTRUMENT defect (the wall-clock render fixed
// above), and it was reported under an exit code that reads as a clean run.
// A leg that could not see its subject now exits 3, per the project rule filed
// as NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION.
const hardFail = !enginePass || !controlPass || pixelPass === false;
const structural = !hardFail && pixelPass === null;
const pass = !hardFail && !structural && allErrs.length === 0;
const exitCode = hardFail || allErrs.length > 0 ? 1 : structural ? 3 : 0;
console.log(
  `\nGATE ${pass ? "PASS" : structural ? "STRUCTURAL" : "FAIL"} (exit ${exitCode})`,
);
clearTimeout(watchdog);
process.exit(exitCode);
