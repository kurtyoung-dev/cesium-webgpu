#!/usr/bin/env node
// C12-34 sky-brightness twilight range — browser acceptance probe (Batch 823+).
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
    async ({ lanes, view }) => {
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
      return { engineExports, lanes: out, deviceErrs };
    },
    { lanes: LANES, view: VIEW },
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
const starsVisible = glStars[0] >= 50 && gpuStars[0] >= 50;
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
  pixelStructuralReason =
    "the star field drew nothing at the darkest lane, so this leg measured an " +
    "empty sky (instrument gap, NOT a product verdict; the ENGINE leg above is " +
    "unaffected)";
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
