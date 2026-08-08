// celestial-capture-harness.mjs — the shared Playwright/page half of the
// celestial probe fleet: one definition of "the page is ready", one settle
// recipe, one capture, one lane driver, one PNG writer.
//
// WHY THIS IS A MODULE AND NOT A PATTERN. The recipe below is not boilerplate;
// nearly every line of it is a repair paid for by a failed run:
//
//   * the clock is PINNED and the default render loop is off, so nothing in a
//     capture depends on wall time;
//   * settle is a WALL-CLOCK budget with a frame floor, yielding on
//     `setTimeout` rather than `requestAnimationFrame` — a starved rAF in a
//     headless browser silently shortens the budget into the under-settle it
//     exists to prevent;
//   * every measured capture is preceded by a DISCARDED warm-up capture,
//     because the readback path itself (canvas allocation, drawImage, and on
//     WebGPU the present/consume cycle) is part of what needs warming;
//   * the final render and the readback happen in the SAME task, with no await
//     between them — a read taken across a yield is invalid on both backends;
//   * the camera aim is applied through an explicit basis and its round-trip
//     residual is REPORTED, so an aim that did not take is visible as a number
//     rather than as a mysteriously dim measurement;
//   * every per-leg scene flag is pinned in BOTH directions, because several
//     lanes share one page and a one-way pin hands its state to every lane
//     after it.
//
// A second copy of any of that is a second thing that can drift, and drift here
// does not fail loudly — it produces a confident wrong number. Probes import
// these; they do not re-author them.
//
// BROWSER-FREE AT IMPORT. Nothing here imports Playwright: `withPage` and
// `runBackendLanes` take an already-launched `browser`. Specs can therefore
// import this module under plain `node --test`, which is what lets the recipe
// above be pinned by assertions rather than by review.
//
// @module celestial-capture-harness

import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import { stitchBracketLinear } from "./celestial-g2-gate.mjs";
import { sha256 } from "./visual-gate-policy.mjs";

export const BASE = process.env.PROBE_BASE || "http://localhost:8080";
export const OUT_DIR = "Tools/visual-regression/output";
export const PINNED_ISO = "2026-05-19T18:00:00Z";
export const VIEWPORT = { width: 1280, height: 720 };
export const CROP = { width: 1000, height: 640 };

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
export const SETTLE_BUDGET_MS = 3000;
export const SETTLE_MIN_FRAMES = 32;
export const SETTLE_YIELD_MS = 16;

// Cap on the projected expectation payload crossing the page boundary.
export const G2_MAGNITUDE_MAX_EXPECTATIONS = 120;

// Curated bright stars (J2000 RA/Dec deg, Johnson V) spanning ~3.5 mag around
// the Sirius field — the M5 cross-match set. Projected in-page at the pinned
// clock via the same TEME->pseudo-fixed transform the renderer uses, so render
// and projection share any precession offset and it cancels in the match.
export const CATALOG_EXPECTATIONS = [
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

export function getGit() {
  const run = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
  try {
    const sourceCommit = run("git rev-parse HEAD");
    const sourceDirty = run("git status --porcelain").length > 0;
    return { sourceCommit, sourceDirty };
  } catch {
    return { sourceCommit: "0".repeat(40), sourceDirty: true };
  }
}

export function normalizeHardwareClass(parts) {
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
export async function setupScene(
  page,
  {
    aim,
    skyAtmosphereOn,
    cameraHeightM,
    fovXDeg,
    catalogMaxVmag,
    sunOn,
    moonOn,
  },
) {
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
      fovX,
      maxVmag,
      maxExpectations,
      showSun,
      showMoon,
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
      // G1/G2 want a bare star field, so both bodies default OFF and every
      // existing lane keeps its historical scene byte-for-byte. G4's sun lanes
      // are the first to ask for the sun billboard itself.
      if (scene.sun) {
        scene.sun.show = showSun === true;
      }
      if (scene.moon) {
        scene.moon.show = showMoon === true;
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

      // TELESCOPE FRAMING (G2 psf sub-lane). `PerspectiveFrustum.fov` is the
      // HORIZONTAL field of view whenever the canvas is wider than it is tall,
      // which it is here (1280x720). The star quads are sized in ANGLE, so this
      // magnifies the same profile onto more pixels rather than changing it.
      //
      // RESTORED, NOT LEFT BEHIND. `runBackendLanes` drives several lanes on ONE
      // page, so a lane that narrowed the FOV would silently hand its framing to
      // every lane after it — the magnitude sub-lane would then cross-match a
      // 6-degree field against a 47-degree expectation list and the glare legs
      // would sample a different patch of sky than their derivation assumes. The
      // original value is stashed on the first setup and put back whenever no
      // override is requested.
      let appliedFovXDeg = null;
      const frustum = scene.camera?.frustum;
      if (frustum && typeof frustum.fov === "number") {
        if (typeof window.__probeOriginalFovRad !== "number") {
          window.__probeOriginalFovRad = frustum.fov;
        }
        frustum.fov = Number.isFinite(fovX)
          ? C.Math.toRadians(fovX)
          : window.__probeOriginalFovRad;
        appliedFovXDeg = C.Math.toDegrees(frustum.fov);
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

      // ── CAMERA AIM — ONE PLACE, AND IT REPORTS ITSELF ────────────────────
      // `G4-FIRSTRUN-FIX-1`. `Camera.setView({orientation:{direction, up}})`
      // does NOT keep the basis it is handed. It converts direction/up into
      // heading/pitch/roll in the local ENU frame at `destination` and rebuilds
      // the basis from those three angles — and `getHeading` has a GIMBAL-LOCK
      // branch that fires when `|direction.z|` in that frame is within
      // `CesiumMath.EPSILON3 = 1e-3` of 1, where it takes the azimuth from the
      // UP vector instead of from the direction.
      //
      // Every lane that parks the camera ON a body's ray and looks along it is
      // inside that branch, because the camera direction IS the local vertical
      // — to within the ellipsoid's geodetic-vs-geocentric deflection
      //
      //     eps = f * sin(2 * phi)     (f = 1/298.257; 0.19207 deg at 45 deg)
      //
      // which at the Sun's declination on the pinned epoch (19.80 deg) is
      // 0.12299 deg. The reconstruction keeps the PITCH (eps off the vertical)
      // but substitutes the UP vector's azimuth, which is 90 deg away, so the
      // applied direction lands
      //
      //     2 * sin(45 deg) * eps = sqrt(2) * eps = 0.17393 deg
      //
      // from the requested one, at exactly 135 deg in screen space.
      //
      // That is the whole of Batch 941's "sun aim by ~0.35 deg", and it
      // reproduces OFFLINE to four significant figures: 111.30 px predicted
      // against 111.65 measured at the disc lane's 2 deg fov, and
      // (-2.38, +2.38) px predicted against the live `frameState.sunHalo`
      // centre's (-2.3878, +2.3878) at the halo lane's 60 deg. The three moon
      // epochs predict 4.98 / 7.85 / 10.37 px against 4.91 / 7.92 / 10.33
      // measured. (The filing's 0.35 deg read the disc offset against the wrong
      // pixel scale; the angle is 0.1745 deg and the lanes AGREE on it.)
      //
      // `setView` still runs — it owns the position and the camera transform —
      // and the requested basis is then written back verbatim. In the
      // NON-degenerate lanes the round trip already reproduces the basis
      // exactly, so the write-back is an identity there and the offline check
      // puts `sunlit` and `sirius` at residual 0.0; only `sun-facing` and
      // `anti-sun` are displaced.
      const angleBetweenDeg = (a, b) =>
        (Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(a, b)))) * 180) /
        Math.PI;
      let aimDiagnostics = null;
      const aimCamera = (position, direction, up) => {
        scene.camera.setView({
          destination: position,
          orientation: { direction, up },
        });
        // Read BEFORE the repair: this is the defect's own magnitude, and it is
        // reported every run so a future regression in `Camera.setView` cannot
        // hide behind a probe that silently corrects it.
        const roundTrip = C.Cartesian3.clone(
          scene.camera.directionWC,
          new C.Cartesian3(),
        );
        const hprRoundTripResidualDeg = angleBetweenDeg(direction, roundTrip);
        C.Cartesian3.clone(direction, scene.camera.direction);
        C.Cartesian3.clone(up, scene.camera.up);
        C.Cartesian3.normalize(
          C.Cartesian3.cross(direction, up, scene.camera.right),
          scene.camera.right,
        );
        const applied = C.Cartesian3.clone(
          scene.camera.directionWC,
          new C.Cartesian3(),
        );
        const ellipsoid = scene.ellipsoid ?? C.Ellipsoid.WGS84;
        let localVerticalSeparationDeg = null;
        const normal = ellipsoid.geodeticSurfaceNormal(
          position,
          new C.Cartesian3(),
        );
        if (C.defined(normal)) {
          localVerticalSeparationDeg = angleBetweenDeg(direction, normal);
        }
        aimDiagnostics = {
          aimMode,
          requestedDirection: {
            x: direction.x,
            y: direction.y,
            z: direction.z,
          },
          hprRoundTripDirection: {
            x: roundTrip.x,
            y: roundTrip.y,
            z: roundTrip.z,
          },
          hprRoundTripResidualDeg,
          appliedDirection: { x: applied.x, y: applied.y, z: applied.z },
          appliedResidualDeg: angleBetweenDeg(direction, applied),
          // The eps above. `sqrt(2) * this` IS `hprRoundTripResidualDeg`
          // whenever the gimbal-lock branch fired, which is what makes the
          // diagnosis checkable from the report alone.
          localVerticalSeparationDeg,
          gimbalLockBranchPredicted:
            Number.isFinite(localVerticalSeparationDeg) &&
            Math.abs(Math.cos((localVerticalSeparationDeg * Math.PI) / 180)) >
              1.0 - 1.0e-3,
        };
      };

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
        aimCamera(eye, dir, realUp);
        cameraUp = C.Cartesian3.normalize(eye, new C.Cartesian3());
      } else if (aimMode === "sun-facing" || aimMode === "anti-sun") {
        // C12-27 GLARE FRAMING. BOTH legs put the camera on the SUNLIT side,
        // at +sunDir * dist, and differ only in where it looks. That is
        // load-bearing: `SolarGlareAppearance` multiplies the veil strength by
        // `eclipseState.sunVisibleFraction`, so a camera behind the Earth
        // resolves strength 0 and every glare criterion would pass vacuously.
        // Placing both legs in sunlight means the far-field byte-identity claim
        // is made with the veil ENABLED and its strength NON-ZERO — the veil is
        // exactly 1.0 there because the pedestal-subtracted Lorentzian reaches
        // 0 at its 90-degree support, not because the term is switched off.
        //
        //   sun-facing : the Sun is at frame CENTRE, so the crop spans 0 deg
        //                (centre) to ~27.7 deg (corner) of separation — the
        //                whole of the band where the veil is measurable.
        //   anti-sun   : every direction in frame is >= 152 deg from the Sun,
        //                far beyond the support, so the multiplier is exactly
        //                1.0 everywhere and `x * 1.0 === x`.
        const axis = sunDir;
        const position = C.Cartesian3.multiplyByScalar(
          axis,
          dist,
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
        const direction =
          aimMode === "sun-facing"
            ? C.Cartesian3.clone(axis, new C.Cartesian3())
            : C.Cartesian3.negate(axis, new C.Cartesian3());
        aimCamera(position, direction, perp);
        cameraUp = C.Cartesian3.normalize(position, new C.Cartesian3());
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
        aimCamera(position, perp, up);
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

      // CROSS-MATCH EXPECTATIONS.
      //
      // The curated ten-star list is the historical set and stays the default.
      // When `maxVmag` is supplied (the G2 magnitude sub-lane) the list is built
      // from the SHIPPED `BrightStarCatalog` instead, imported out of the served
      // source tree exactly as `probe-sky-twilight-range.mjs` imports
      // `SkyBrightness`. That is deliberately the renderer's OWN data: the
      // criterion is "does the renderer honour the catalogue it was given", so a
      // hand-typed coordinate list would add a provenance risk (a 0.14-degree
      // error is already a 3 px miss at the default framing) without adding any
      // independence — the catalogue is the input under test, not the oracle.
      let sourceList = catalog;
      let catalogSource = "curated-10";
      if (Number.isFinite(maxVmag)) {
        const mod =
          await import("/packages/engine/Source/Scene/BrightStarCatalog.js");
        const cat = mod.default;
        const rows = [];
        for (let i = 0; i < cat.count; i++) {
          const base = i * cat.STRIDE;
          const vmag = cat.data[base + 2];
          if (vmag <= maxVmag) {
            rows.push({
              name: `bsc-${i}`,
              ra: cat.data[base + 0],
              dec: cat.data[base + 1],
              vmag,
            });
          }
        }
        rows.sort((a, b) => a.vmag - b.vmag);
        sourceList = rows;
        catalogSource = `BrightStarCatalog<=${maxVmag}`;
      }

      // Project to canvas, keep the ones inside the crop; positions are
      // crop-relative for M5.
      const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
        pinnedTime(),
        new C.Matrix3(),
      );
      const expectations = [];
      for (const s of sourceList) {
        if (expectations.length >= maxExpectations) {
          break;
        }
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
              // Angular separation from the Sun, in the Earth-fixed frame both
              // vectors are expressed in here. Reported so the C12-27 glare
              // legs can state — rather than assume — which side of the
              // 90-degree support their content sits on.
              sunSeparationDeg:
                (Math.acos(
                  Math.max(-1, Math.min(1, C.Cartesian3.dot(dir, sunDir))),
                ) *
                  180) /
                Math.PI,
            });
          }
        }
      }

      // G4 SUN GEOMETRY. `frameState.sunHalo` is `SunHaloAppearance`'s resolved
      // result, published before the backend branch, so this is the SAME
      // `limbPx` the shipped `SolarHalo` stage draws with — not a second
      // derivation that could disagree with it. The ephemeris diameter is the
      // honest reference for the disc-size criterion: 0.5334 deg is a mean and
      // the real disc breathes +/-1.7% over a year.
      const sunPositionWC = scene.context.uniformState.sunPositionWC;
      const camPositionWC = scene.camera.positionWC;
      const sunDistanceM =
        sunPositionWC && camPositionWC
          ? C.Cartesian3.distance(sunPositionWC, camPositionWC)
          : null;
      const expectedSolarAngularRadiusDeg =
        sunDistanceM > 0
          ? (Math.asin(C.Math.SOLAR_RADIUS / sunDistanceM) * 180) / Math.PI
          : null;
      const haloState = scene.frameState?.sunHalo ?? null;

      // THE EPHEMERIS-PROJECTED SUN, in the SAME crop pixel coordinates the
      // captured frames are measured in (`G4-FIRSTRUN-FIX-1`, part b). This is
      // what separates "the camera is mis-aimed" from "the Sun is not drawn
      // where the ephemeris says": if this lands on the measured light, the aim
      // is the defect; if it does not, the renderer is.
      // `cartesianToCanvasCoordinates` returns CSS-pixel WINDOW coordinates
      // (y DOWN), which is the convention the crop is indexed in; the
      // drawing-buffer ratio is 1 in headless Edge but is measured rather than
      // assumed, exactly as the moon lane does it.
      let sunProjectionCropPx = null;
      if (sunPositionWC) {
        const bufferScale =
          canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
        const win = scene.cartesianToCanvasCoordinates(
          sunPositionWC,
          new C.Cartesian2(),
        );
        if (C.defined(win) && isFinite(win.x) && isFinite(win.y)) {
          sunProjectionCropPx = {
            x: win.x * bufferScale - ox,
            y: win.y * bufferScale - oy,
            bufferScale,
          };
        }
      }

      return {
        rendererType: scene.context.rendererType,
        catalogSource,
        appliedFovXDeg,
        sunDistanceM,
        expectedSolarAngularRadiusDeg,
        devicePixelRatio: window.devicePixelRatio ?? 1,
        aimDiagnostics,
        sunProjectionCropPx,
        sunHalo: haloState
          ? {
              screenHalo: haloState.screenHalo === true,
              bakeHaloGain: haloState.bakeHaloGain,
              haloIntensity: haloState.haloIntensity,
              haloAmplitude: haloState.haloAmplitude,
              haloCoreRadii: haloState.haloCoreRadii,
              discRadiance: haloState.discRadiance,
              limbPx: haloState.limbPx,
              centerX: haloState.centerX,
              centerY: haloState.centerY,
              visible: haloState.visible === true,
              eclipseFactor: haloState.eclipseFactor,
            }
          : null,
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
      fovX: Number.isFinite(fovXDeg) ? fovXDeg : null,
      maxVmag: Number.isFinite(catalogMaxVmag) ? catalogMaxVmag : null,
      maxExpectations: G2_MAGNITUDE_MAX_EXPECTATIONS,
      showSun: sunOn === true,
      showMoon: moonOn === true,
    },
  );
}

// --------------------------------------------------------------------------
// In-page: apply the M6 toggles (or the bracket exposure), settle, and capture
// the crop in the SAME task as the final render (RULE 2).
// --------------------------------------------------------------------------
export async function captureMode(
  page,
  { mode, crop, exposure, hdr, glareOn, toggles, sceneFlags },
) {
  return page.evaluate(
    async ({
      captureMode,
      cropRect,
      exposureFactor,
      useHdr,
      glareFlag,
      settleBudgetMs,
      settleMinFrames,
      settleYieldMs,
      lightingToggles,
      scenePins,
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
        } else if (captureMode === "sun-only" || captureMode === "moon-only") {
          // G4: no sky at all. The disc/halo/moon measurements are radiances
          // over a BLACK background, so a cube map or a sprite catalogue in
          // frame would be an additive pedestal on every band this gate reads.
          skyBox.show = false;
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

      // C12-27 angular solar glare. The toggle lives on the same
      // atmospheric-conditions facade as the star modulation, and `Scene`
      // re-resolves it every frame in `updateEnvironment` regardless of
      // `globe.show`. Left untouched when `glareFlag` is null, so the G1 lanes
      // and the legacy bracket keep the shipped default.
      let glareRequested = null;
      const lightingLeaf = scene.globe?.atmosphericConditions?.lighting;
      if (lightingLeaf && typeof glareFlag === "boolean") {
        lightingLeaf.enableAngularSolarGlare = glareFlag;
        glareRequested = lightingLeaf.enableAngularSolarGlare === true;
      }

      // G4 A/B TOGGLES. Every one of these lives on the SAME
      // atmospheric-conditions facade, is re-resolved by its owning module every
      // frame (`SunDiscAppearance`, `SunHaloAppearance`, `MoonPhaseAppearance`),
      // and has a documented byte-identical OFF position. Each leg pins the
      // flags it depends on EXPLICITLY rather than inheriting whatever the
      // previous leg left behind — several lanes run on one page.
      let lightingRequested = null;
      if (lightingLeaf && lightingToggles) {
        for (const [flag, value] of Object.entries(lightingToggles)) {
          if (typeof value === "boolean") {
            lightingLeaf[flag] = value;
          }
        }
        lightingRequested = {};
        for (const flag of Object.keys(lightingToggles)) {
          lightingRequested[flag] = lightingLeaf[flag] === true;
        }
      }

      // Scene-level pins follow the same explicit-both-directions rule as the
      // lighting flags: several lanes share one page, so a leg that depends
      // on a Scene property states it rather than inheriting the previous
      // leg's value.
      //
      // ⚠ DO NOT PIN `sunBloom = false` ON ANY SUN LANE TO "REMOVE THE HALO".
      // The one-halo-source invariant in `Scene/SunHaloAppearance.js` derives
      // `bakeHaloGain` from `screenHalo`, and `sunBloom = false` forces
      // `screenHalo = false`, so the pin does not delete the halo — it SWAPS
      // the screen halo for the legacy BAKED one, which is composited into the
      // billboard's own alpha. That baked halo drives the bake's alpha above 1
      // across the WHOLE disc (min 1.0053 at the extreme limb) and its blue
      // above 1 as well, so both saturate and the disc renders FLAT: every
      // disc pixel reads the same code and the limb law is erased from the
      // capture. No scene configuration renders a halo-free disc. The
      // halo-free quantity is a DIFFERENTIAL between legs (`flat - limb`
      // cancels the halo exactly, because no halo uniform reads either disc
      // toggle) — measure that, at the shipped defaults.
      if (scenePins) {
        for (const [flag, value] of Object.entries(scenePins)) {
          if (typeof value === "boolean") {
            scene[flag] = value;
          }
        }
      }

      // HDR IS SET IN BOTH DIRECTIONS, NOT ONLY ON. `runBackendLanes` drives
      // several lanes on ONE page: an HDR lane that never turned the flag back
      // off would hand the tonemap + inverse-gamma stage to the SDR lanes after
      // it, and the C12-27 glare legs read raw 8-bit codes on the stated
      // grounds that the SDR canvas carries clamp(linear) directly. Leaving the
      // exposure behind would be worse still — the last bracket step is 64x.
      let hdrEngaged;
      if (useHdr) {
        scene.highDynamicRange = true;
        hdrEngaged = scene.highDynamicRange === true;
        if (scene.postProcessStages) {
          scene.postProcessStages.exposure = exposureFactor;
        }
      } else {
        scene.highDynamicRange = false;
        hdrEngaged = scene.highDynamicRange === true;
        if (scene.postProcessStages) {
          scene.postProcessStages.exposure = 1.0;
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
      // Read in the SAME task as the measured render (RULE 2) so the resolved
      // glare describes the frame that was captured, not the intent. `strength`
      // already carries the `sunVisibleFraction` product; `sunVisibleFraction`
      // travels separately so "the toggle is off" (strength 0, visibility 1) is
      // distinguishable from "the Sun is behind the Earth" (strength 0,
      // visibility 0) without re-deriving either.
      const glareState = scene.frameState?.solarGlareAppearance ?? null;
      const solarGlare = glareState
        ? {
            enabled: glareState.enabled === true,
            strength: glareState.strength,
            sunVisibleFraction: glareState.sunVisibleFraction,
            supportRad: glareState.support,
          }
        : null;

      // G4 LIVE STATE — read in the SAME task as the measured render (RULE 2),
      // so the resolved appearance describes the frame that was captured rather
      // than the intent. All of these are published on `frameState` by their
      // owning module BEFORE the backend branch, which is exactly why they can
      // certify a shared-code claim.
      const fs = scene.frameState;
      const haloState = fs?.sunHalo ?? null;
      const sunHalo = haloState
        ? {
            screenHalo: haloState.screenHalo === true,
            trueDiscSize: haloState.trueDiscSize === true,
            bakeHaloGain: haloState.bakeHaloGain,
            discEdge: haloState.discEdge,
            haloIntensity: haloState.haloIntensity,
            haloAmplitude: haloState.haloAmplitude,
            haloCoreRadii: haloState.haloCoreRadii,
            // C12-19's linear disc radiance. Read LIVE because
            // `expectedCompositeLimbRatio` needs the shipped pair
            // (`discRadiance`, `haloAmplitude = SOLAR_HALO_AMPLITUDE *
            // discRadiance`) to state the halo-over-disc confound as a number
            // rather than as a hypothesis — `G4-FIRSTRUN-FIX-4`.
            discRadiance: haloState.discRadiance,
            eclipseFactor: haloState.eclipseFactor,
            limbPx: haloState.limbPx,
            centerX: haloState.centerX,
            centerY: haloState.centerY,
            visible: haloState.visible === true,
          }
        : null;

      return {
        width: cropRect.width,
        height: cropRect.height,
        data: Array.from(full.data),
        glareRequested,
        solarGlare,
        lightingRequested,
        sunHalo,
        sunEclipseAlpha: fs?.sunEclipseAlpha ?? null,
        eclipseSunVisibleFraction: fs?.eclipseState?.sunVisibleFraction ?? null,
        moonPhaseFraction: fs?.moonPhaseFraction ?? null,
        moonEarthshinePhaseScale: fs?.moonEarthshinePhaseScale ?? null,
        moonTerminatorSoftness: fs?.moonTerminatorSoftness ?? null,
        enableEarthshine: lightingLeaf
          ? lightingLeaf.enableEarthshine === true
          : null,
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
      glareFlag: typeof glareOn === "boolean" ? glareOn : null,
      settleBudgetMs: SETTLE_BUDGET_MS,
      settleMinFrames: SETTLE_MIN_FRAMES,
      settleYieldMs: SETTLE_YIELD_MS,
      lightingToggles: toggles ?? null,
      scenePins: sceneFlags ?? null,
    },
  );
}

export function toImage(capture) {
  return {
    data: new Uint8ClampedArray(capture.data),
    width: capture.width,
    height: capture.height,
  };
}

// EncodePNG — copied verbatim from capture-and-diff.mjs so the written PNG is
// byte-identical to the pixels the metrics measured (imageSha256 covers exactly
// what was gated).
export function encodePNG(rgba, width, height) {
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
export function buildManifestEntry({
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

// Boot one viewer page on one backend and hand it to `body`. Extracted so the
// G1/bracket path and the multi-lane G2 path share ONE definition of "the page
// is ready" — a second copy is a second thing that can drift out of step with
// the readiness contract.
export async function withPage(browser, renderer, body) {
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
    const value = await body(page);
    return {
      ok: true,
      renderer,
      ...value,
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

// Run one backend through an ORDERED list of lane definitions on a single page.
// Each lane is `{ key, setup, captures }`; captures within a lane run in the
// listed order, which is CERTIFYING-LAST for the same reason
// `G1_MODE_CAPTURE_ORDER` is (see its comment).
// `setupFn` lets a lane bring its own in-page configuration (G4's moon lanes
// solve a phase epoch and park on the Earth->Moon line; its policy lane takes no
// picture at all). Omitting it keeps the historical `setupScene`, so G1/G2/G3
// lane definitions are unchanged.
// `onLane(laneKey, lane, renderer)` — OPTIONAL, and it is what keeps this
// function's memory flat (`G4-FIRSTRUN-FIX-5`). Each capture arrives from the
// page as a plain `Array` of `width * height * 4` numbers, which V8 stores at 8
// bytes an element: 20.5 MB per capture, 28 per backend, 56 for a G4 run —
// 1.15 GB of pixels that the original shape kept alive until the very end,
// which is how the first G4 run OOM'd a ~3.6 GB default heap at 31 minutes.
// A lane that is REDUCED and WRITTEN the moment it finishes retains nothing but
// its scalars, and the peak drops to one lane's bracket (6 captures, ~123 MB)
// plus its stitched composites.
//
// Omitting the hook keeps the historical shape byte-for-byte, so G2 and G3 lane
// definitions are unaffected.
export async function runBackendLanes(browser, renderer, laneDefs, onLane) {
  return withPage(browser, renderer, async (page) => {
    const lanes = {};
    for (const def of laneDefs) {
      const setup = await (def.setupFn ?? setupScene)(page, def.setup);
      const captures = {};
      for (const cap of def.captures ?? []) {
        captures[cap.key] = await captureMode(page, {
          mode: cap.mode,
          crop: setup.crop,
          exposure: cap.exposure,
          hdr: cap.hdr === true,
          glareOn: cap.glareOn,
          toggles: cap.toggles,
          sceneFlags: cap.sceneFlags,
        });
      }
      const lane = { setup, captures };
      lanes[def.key] = lane;
      if (typeof onLane === "function") {
        onLane(def.key, lane, renderer);
        // RELEASE. The hook has had its one chance at the pixels; everything
        // downstream works from what it extracted.
        lane.captures = null;
      }
    }
    return { lanes };
  });
}

export function writeCapturePng(image, name) {
  const png = encodePNG(image.data, image.width, image.height);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, png);
  return { file, png };
}

/** Stitch one named leg's exposures into a linear-light float image. */
export function stitchLeg(lane, prefix, exposures) {
  const caps = exposures.map((e) => lane.captures[`${prefix}-${e}x`]);
  if (caps.some((c) => !c)) {
    return null;
  }
  return {
    linear: stitchBracketLinear(caps),
    hdrEngaged: caps.every((c) => c.hdrEngaged === true),
    lead: caps[0],
    // The RAW bracket, so a caller can ask what one 8-bit code step was worth
    // at a particular pixel (`G4-FIRSTRUN-FIX-3`). Held only for the duration
    // of the lane's own metric call; `runBackendLanes` drops the captures the
    // moment the lane is consumed (`G4-FIRSTRUN-FIX-5`).
    legs: caps,
  };
}
