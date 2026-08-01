#!/usr/bin/env node
// probe-eclipse-sun-fade.mjs — C12-29 S1 (EclipseState + continuous sun fade),
// WebGL vs WebGPU.
//
// DEFECT UNDER TEST (research: migration_doc/ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md):
//   Sun occlusion was a boolean with no intensity path.
//     WebGL  — `Scene.updateEnvironment` culls the whole billboard once the
//              ~6-solar-radii glow bounding sphere falls inside the Earth
//              occluder's horizon cone. The glow therefore snaps between
//              "absent" and "full" in ONE frame: the maintainer's pop.
//     WebGPU — the sun command carries NO bounding volume, so it is never
//              culled; the disc is hard-clipped per pixel by the globe's
//              depth and the glow ABOVE the limb never dims at all.
//     Moon   — not an occluder anywhere on either backend.
//   S1 publishes `frameState.eclipseState` (limb-darkened dual-cone circle
//   overlap, f64, CPU) and fades the sun billboard's ALPHA by
//   `sunVisibleFraction` on both backends.
//
// THREE LANES:
//   (a) orbital-sunset  — pinned clock, camera swept in equal 0.03 deg steps
//       through the Earth-limb occultation from a 400 km vantage. Asserts the
//       sun's screen-luminance envelope is CONTINUOUS (bounded inter-frame
//       delta), MONOTONE, and reaches zero. Pre-fix WebGL fails the delta
//       bound (a full-amplitude one-step drop at the cull boundary); pre-fix
//       WebGPU fails `endsDark` (the glow never dims).
//   (b) eclipse-2026    — the 2026-08-12 partial-eclipse instant, derived
//       IN-PAGE from Simon1994 by scanning Iceland + northern-Spain ground
//       vantages for maximum lunar obscuration and then stepping off the
//       maximum into a clean partial band. Asserts the engine reports
//       `sunVisibleFraction < 1` and that the measured billboard glow
//       tracks it linearly (the alpha multiply is exactly linear in the
//       difference image under BOTH blend modes).
//   (c) toggle-off      — measured IN THE SAME STEPS as lane (a), not in a
//       second sweep. Asserts the published alpha is EXACTLY 1.0 with the
//       effect off (the identity proof: `x * 1.0 === x`), that the toggle
//       demonstrably flipped both ways every step, that the physics still
//       runs when off, that the legacy binary cull's per-step STATE is
//       IDENTICAL on and off (the real "S1 did not touch the cull"
//       regression pin, read from `scene.environmentState.isSunVisible` via
//       `postRender`), that the sun command's bounding-volume shape matches
//       the backend (WebGL has one, WebGPU has none), that the two
//       luminance metrics agree where alpha is 1, and that the eclipse-ON
//       series is measurably dimmer through the partial band.
//
//       REDESIGNED TWICE (2026-07-24). v1 asked pixels to show WebGL's
//       binary pop, which is geometrically unobservable. v2 compared two
//       separate sweeps, which no tolerance can rescue — frame-count-driven
//       animation, globe-tile residency and the 8-bit saturation mask all
//       differ across runs. v3 measures both toggle positions inside one
//       step, deleting all three axes. See the lane-(c) verdict block.
//
// MEASUREMENT. Each step renders FOUR times at the same pinned time and
// camera — {eclipse off, on} x {sun shown, sun hidden} — and integrates
// |luminance difference| over an annulus around the projected solar centre
// (1.5x .. ~6x the solar limb radius). That difference image isolates the
// sun's contribution exactly, is zero wherever the globe covers the glow,
// and — because ALPHA_BLEND gives `out - dst = a*(src - dst)` and additive
// gives `out - dst = a*src` — scales EXACTLY linearly in the eclipse alpha
// under both backends' blend states. Both sums use ONE mask, built from the
// eclipse-OFF (brightest) capture, excluding 8-bit-saturated pixels: WebGPU
// blends the sun additively and an un-faded sun clamps at 255, which would
// otherwise pull the ON/OFF ratio toward 1 on that backend specifically.
//
// `scene.sunBloom` is forced OFF in every lane: WebGPU's sun bloom is
// unwired (C11-160) so leaving it on makes the two backends structurally
// incomparable, and the fade multiplies the bloom INPUT by construction.
//
// C12-29 S2 CONFOUND ON LANE (b), FIXED 2026-07-24 — THE BLEND EQUATIONS
// DIFFER BETWEEN THE BACKENDS AND ONLY ONE OF THEM IS dst-INDEPENDENT:
//   WebGL  (ALPHA_BLEND): out - dst = a*(src - dst)   -> depends on the sky
//   WebGPU (additive)   : out - dst = a*src           -> immune
// This lane's metric IS that difference image, so once S2 started dimming the
// sky the sun is composited over, WebGL's ratio began over-reporting for a
// reason that has nothing to do with the sun's alpha. Measured causally by
// the executor: toggling `eclipseAutoExposure` — which changes ONLY the S2
// scene factor and leaves S1's alpha bit-identical — moved the measured glow
// 4.8x. The fix uses only measured quantities: the four-render pattern already
// captures the sun-HIDDEN frame in both toggle positions, i.e. `dst` itself,
// so with the sun texture's own alpha `A` in [0, 1] the ratio is bracketed by
// `[f, f*(1 + sum(dstOff - dstOn)/sum(D_off))]`. The upper bound is applied on
// WebGL only; WebGPU keeps the tight historical band its blend makes valid.
// S1's CONTRACT never needed correcting — `alphaEqualsFraction` compares the
// published alpha with the published fraction bit-for-bit on both backends,
// and it was green throughout. Only the luminance PROXY was confounded.
//
// ...AND THE PROXY MUST BE READ IN THE SPACE THE BLEND HAPPENED IN (round 4).
// The dst correction above fixed the CEILING but the measured WebGL ratio was
// undershooting the FLOOR (0.209 against 0.257), which no dst term can cause.
// Cause: the captured bytes are display-encoded while the blend is performed
// in linear space, and `|E(a*src + (1-a)*dst) - E(dst)|` is COMPRESSIVE in `a`
// because E is concave — the classic "fades more than alpha in display space"
// signature. `measure()` therefore integrates BOTH `glowSum` (display) and
// `glowSumLinear` (sRGB EOTF applied per channel before differencing), and the
// gate runs in whichever space that backend's blend actually operates in.
// Which space that is, is DETERMINED BY MEASUREMENT rather than presumed:
// WebGPU is the analytic control — its additive blend has no dst term at all,
// so the difference is exactly `a*src` in its own blend space and whichever
// space reproduces `f` there IS that space. `additiveControlIsExact` gates on
// it, so if the control ever stops holding the instrument fails loudly instead
// of silently mis-reporting WebGL. `blendSpace`, `ratioDisplay`,
// `ratioLinear`, `errDisplay` and `errLinear` are all in the manifest.
//
// ⛔ RATIONALE CORRECTED 2026-07-25 (round 3 of the C12 sun wave). The
// `NA-geometric-limb` TIER BELOW IS STILL CORRECT — nothing measurable lives
// in that annulus — but the REASON recorded for it (immediately after this
// block: "the WebGPU sun's glow does not extend above the earth limb", "a
// PRE-EXISTING backend sun-RENDERING divergence") is WRONG, and the C12-15/
// C12-16/C12-17 rows it points at are NOT what unblocks it.
//
// `probe-sun-glow-profile` measured `frameState.sunAtmosphereExtinction` —
// which `Sun.js` computes BACKEND-AGNOSTICALLY before the feature-renderer
// branch — as BYTE-IDENTICAL on both backends at every near-limb step:
// [0.723, 0.467, 0.190] at -19.0 deg and [0, 0, 0] (< 5e-4/channel) below it.
// Both backends multiply the billboard's RGB by it. EXTINCTION 0 => A BLACK
// BILLBOARD => DELTA 0. WebGPU's zero is the physics executing correctly; the
// sun is genuinely extinguished at those elevations on BOTH backends, so
// there is no sun there to dim and no wave can make one appear.
//
// The anomaly is WebGL's NON-zero at those same steps. Leading mechanism,
// from source: WebGL's sun uses BlendingState.ALPHA_BLEND, so
// out = src.rgb*src.a + dst*(1 - src.a); with src.rgb == 0 that is
// out = dst*(1 - a) — a black billboard DARKENS the sky by a*dst. WebGPU
// blends additively (src-alpha/one), where src.rgb == 0 is an exact
// identity. That reproduces every observation: the residual appears exactly
// where the billboard is black, its magnitude tracks the ROI background, and
// it collapses to 0 at -22.6 deg where no billboard is drawn at all.
//
// CONSEQUENCE FOR THIS PROBE: at the one step where the sun is genuinely
// above the horizon (-19.0 deg) WebGPU measures 1,176,861 vs WebGL 982,022 —
// 120% of WebGL, BRIGHTER not absent — and the Batch-760 "open-sky WebGPU =
// 77% of WebGL" asymmetry DOES NOT REPRODUCE (0.06% agreement per radial
// bin). Lane (c)'s deferral to lane (b) should be re-derived on the corrected
// premise; it is not wrong to defer, but the stated cause is.
//
// ALSO: `scene.sun.show` IS NOT A SINGLE-VARIABLE LEVER ON WEBGL — it drives
// `environmentState.isSunVisible`, which gates the sun bloom pass
// (EnvironmentRenderer.js:43-58, FramebufferOrchestrator.js:49-53) as well as
// the billboard. This probe already forces `scene.sunBloom = false`, which is
// what makes that safe here; do not remove that line.
//
// MEASURED BACKEND DIVERGENCE, RECORDED HERE SO IT IS NOT RE-DISCOVERED
// (round-4 Edge run, 2026-07-24): WebGPU sun glow does not extend above the
// earth limb — glowOffRaw is 0 across the WHOLE fade band at this vantage
// (all 15 partial-band steps, fraction 0.990 down to 0.001, with the effect
// off AND on), while WebGL measures a clean band there because its ~6 R_sun
// glow billboard reaches above the limb. Visible earth-limb dimming is
// therefore unobservable on WebGPU until the C12-15..17 sun-appearance wave
// lands. This is a PRE-EXISTING backend sun-RENDERING divergence, not an S1
// defect and not something S1 can fix. The eclipse alpha application on
// WebGPU is proven by the open-sky moon-eclipse lane instead — lane (b),
// where the sun is high, nothing occludes the annulus, and the multiply is
// measured directly. Lane (c) detects the condition by measurement
// (`partialGlowOffRawMax === 0`), reports `bandTier: "NA-geometric-limb"`,
// and makes its PASS formally depend on lane (b)'s `alphaIsLinear` +
// `partialEclipse` so the deferral is an explicit dependency, never a
// silent exemption.
//
// PROBE RULES (fleet convention): useDefaultRenderLoop killed; EVERY
// scene.render(t) gets the pinned time; sun-direction settle loop (ICRF
// loads async); canvas capture in the SAME task as its render; canvas
// ELEMENT screenshots (locator('canvas'), never page.screenshot);
// rendererType recorded + hard-fail on mismatch; absolute sanity floors so
// an all-black canvas cannot vacuously pass; unref'd force-exit watchdog;
// try/finally close; bounded loops; hard exit codes (0 pass / 1 gate fail /
// 2 structural). Provenance: the exact new source lines must be present
// VERBATIM in the built bundle and the bundle must be newer than every
// touched source file.
//
// EVERY helper used inside a page.evaluate callback is defined INSIDE that
// callback — module-scope bindings do not cross the serialization boundary.
//
// Usage: node Tools/visual-regression/probe-eclipse-sun-fade.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const HARD_LIMIT_MS = 420000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-eclipse-sun-fade] WATCHDOG FIRED (420s) — forcing exit",
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) =>
  x === null || x === undefined ? null : Math.round(x * 1000) / 1000;
const r6 = (x) =>
  x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6;

// ── Provenance: the probe must not run against a stale build ────────────────
// Every source file this change touches OR that eclipse-state.spec.mjs
// asserts on. The mtime gate below fails if ANY of them is newer than the
// build, so a half-rebuilt tree cannot produce a green probe run.
const SOURCE_FILES = [
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/computeSolarObscuration.js",
  "packages/engine/Source/Scene/Sun.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Shaders/SunFS.glsl",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts",
];

// The exact new lines, READ OUT OF THE SOURCE at run time (never hardcoded)
// and required to appear verbatim in the built bundle. This is the
// source==built gate for a change whose shaders are embedded strings rather
// than standalone shader files.
const VERBATIM_SLICES = [
  {
    file: "packages/engine/Source/Shaders/SunFS.glsl",
    marker: "out_FragColor.a *= u_eclipseAlpha;",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
    marker: "color = vec4f(color.rgb, color.a * u.eclipseAlpha);",
  },
  {
    file: "packages/engine/Source/Scene/EclipseState.js",
    // NUMERAL-FREE substring on purpose: esbuild normalises float literals
    // (`1.0` -> `1`) on the way into the bundle, so any marker containing
    // `1.0` matches the source but never the build and would fail
    // provenance on a perfectly current build.
    marker: "- earthOcclusion) * (1",
  },
];

const REQUIRED_TOKENS = [
  "u_eclipseAlpha", // GLSL uniform (WebGL)
  "eclipseAlpha", // WGSL UB member + JS publisher
  "sunEclipseAlpha", // frameState publication
  "enableEclipse", // AtmosphericConditions toggle
  "sunVisibleFraction", // EclipseState contract
  "earthOcclusionFraction",
  "moonObscuration",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectBundleFiles() {
  const bundleDir = "Build/CesiumUnminified";
  const files = [];
  for (const name of fs.readdirSync(bundleDir)) {
    if (name.endsWith(".js")) {
      files.push(path.join(bundleDir, name));
    }
  }
  const chunksDir = path.join(bundleDir, "chunks");
  if (fs.existsSync(chunksDir)) {
    for (const name of fs.readdirSync(chunksDir)) {
      if (name.endsWith(".js")) {
        files.push(path.join(chunksDir, name));
      }
    }
  }
  return files;
}

function provenance() {
  const sources = {};
  let newestSourceMs = 0;
  for (const p of SOURCE_FILES) {
    const bytes = fs.readFileSync(p);
    const stat = fs.statSync(p);
    sources[p] = { byteLength: bytes.byteLength, sha256: sha256(bytes) };
    if (stat.mtimeMs > newestSourceMs) {
      newestSourceMs = stat.mtimeMs;
    }
  }

  let bundleFiles;
  try {
    bundleFiles = collectBundleFiles();
  } catch {
    return { ok: false, reason: "Build/CesiumUnminified missing", sources };
  }
  if (bundleFiles.length === 0) {
    return { ok: false, reason: "no built JS found", sources };
  }

  let newestBundleMs = 0;
  for (const f of bundleFiles) {
    const m = fs.statSync(f).mtimeMs;
    if (m > newestBundleMs) {
      newestBundleMs = m;
    }
  }

  // Only files written by the MOST RECENT build may satisfy the token and
  // marker searches. `Build/CesiumUnminified` accumulates content-hashed
  // chunk files across builds, and a stale leftover chunk from an older
  // build would happily contain every token we look for — turning the
  // stale-build guard into a no-op precisely when it matters. One esbuild
  // pass writes the whole directory, so a 10-minute window is generous.
  const BUILD_WINDOW_MS = 600000;
  const cutoffMs = newestBundleMs - BUILD_WINDOW_MS;
  const considered = [];
  const skippedStale = [];
  for (const f of bundleFiles) {
    if (fs.statSync(f).mtimeMs >= cutoffMs) {
      considered.push(f);
    } else {
      skippedStale.push(f.replaceAll("\\", "/"));
    }
  }
  // The entry bundle itself must be part of that window, or the "build" we
  // are validating is not the one the dev server serves.
  const entryPath = path.join("Build/CesiumUnminified", "index.js");
  const entryFresh =
    fs.existsSync(entryPath) &&
    considered.some((f) => path.resolve(f) === path.resolve(entryPath));

  const texts = considered.map((f) => fs.readFileSync(f, "utf8"));

  const missingTokens = REQUIRED_TOKENS.filter(
    (t) => !texts.some((text) => text.includes(t)),
  );

  const missingSlices = [];
  for (const slice of VERBATIM_SLICES) {
    const src = fs.readFileSync(slice.file, "utf8");
    if (!src.includes(slice.marker)) {
      missingSlices.push(`${slice.file}: marker absent from SOURCE`);
      continue;
    }
    if (!texts.some((text) => text.includes(slice.marker))) {
      missingSlices.push(`${slice.file}: marker absent from BUILD`);
    }
  }

  const buildIsNewer = newestBundleMs >= newestSourceMs;

  return {
    sources,
    bundleFileCount: bundleFiles.length,
    consideredFileCount: considered.length,
    skippedStale,
    entryFresh,
    newestSourceMs,
    newestBundleMs,
    buildIsNewer,
    missingTokens,
    missingSlices,
    ok:
      buildIsNewer &&
      entryFresh &&
      missingTokens.length === 0 &&
      missingSlices.length === 0,
  };
}

// ── In-page: derive the 2026-08-12 partial-eclipse instant + vantage ────────
// Pure ephemeris + geometry, no rendering. Independent of the engine's own
// EclipseState (which is what the lane then measures), so this doubles as a
// second implementation cross-check. Bounded: 2 regions x 9 vantages x 241
// coarse samples + 2 x 49 refine samples.
const DERIVE_ECLIPSE_INSTANT = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");

  const SOLAR_RADIUS = 6.955e8;
  const LUNAR_RADIUS = 1737400.0;

  const m3 = new C.Matrix3();
  const sunScratch = new C.Cartesian3();
  const moonScratch = new C.Cartesian3();

  const bodiesAt = (t) => {
    const rot = C.Transforms.computeIcrfToCentralBodyFixedMatrix(t, m3);
    const sun =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        t,
        sunScratch,
      );
    C.Matrix3.multiplyByVector(rot, sun, sun);
    const moon =
      C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        t,
        moonScratch,
      );
    C.Matrix3.multiplyByVector(rot, moon, moon);
    return { sun, moon };
  };

  // Uniform-disc obscuration — enough to LOCATE the instant; the engine's
  // limb-darkened value is what the lane asserts on.
  const clampUnit = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
  const overlap = (rs, ro, d) => {
    if (!(rs > 0) || !(ro > 0)) return 0;
    if (d >= rs + ro) return 0;
    if (d + rs <= ro) return 1;
    if (d + ro <= rs) return (ro / rs) * (ro / rs);
    const d2 = d * d;
    const rs2 = rs * rs;
    const ro2 = ro * ro;
    const a = Math.acos(clampUnit((d2 + rs2 - ro2) / (2 * d * rs)));
    const b = Math.acos(clampUnit((d2 + ro2 - rs2) / (2 * d * ro)));
    const prod = (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro);
    const lens = rs2 * a + ro2 * b - 0.5 * Math.sqrt(prod > 0 ? prod : 0);
    return Math.min(1, Math.max(0, lens / (Math.PI * rs2)));
  };

  const obscurationAt = (camPos, t) => {
    const { sun, moon } = bodiesAt(t);
    const toSun = C.Cartesian3.subtract(sun, camPos, new C.Cartesian3());
    const dSun = C.Cartesian3.magnitude(toSun);
    C.Cartesian3.divideByScalar(toSun, dSun, toSun);
    const toMoon = C.Cartesian3.subtract(moon, camPos, new C.Cartesian3());
    const dMoon = C.Cartesian3.magnitude(toMoon);
    if (dMoon >= dSun) return { o: 0, elev: 0 };
    C.Cartesian3.divideByScalar(toMoon, dMoon, toMoon);
    const rs = Math.asin(Math.min(1, SOLAR_RADIUS / dSun));
    const ro = Math.asin(Math.min(1, LUNAR_RADIUS / dMoon));
    const sep = Math.acos(clampUnit(C.Cartesian3.dot(toSun, toMoon)));
    const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
    const elev =
      90 - (Math.acos(clampUnit(C.Cartesian3.dot(up, toSun))) * 180) / Math.PI;
    return { o: overlap(rs, ro, sep), elev };
  };

  // Iceland + northern Spain ground vantages (the maintainer-facing 2026
  // showcase pair from the research report's acceptance scenes).
  const vantages = [];
  for (const region of [
    { name: "iceland", lat: 64.14, lon: -21.94 },
    { name: "spain", lat: 42.34, lon: -3.7 },
  ]) {
    for (const dLat of [-1.5, 0, 1.5]) {
      for (const dLon of [-2.5, 0, 2.5]) {
        vantages.push({
          name: region.name,
          lat: region.lat + dLat,
          lon: region.lon + dLon,
          pos: C.Cartesian3.fromDegrees(
            region.lon + dLon,
            region.lat + dLat,
            100.0,
          ),
        });
      }
    }
  }

  const base = C.JulianDate.fromIso8601("2026-08-12T16:00:00Z");
  const scratchT = new C.JulianDate();
  let best = { o: -1 };
  for (const v of vantages) {
    for (let i = 0; i <= 300; i++) {
      const t = C.JulianDate.addMinutes(base, i, scratchT);
      const s = obscurationAt(v.pos, t);
      // Require the sun above the horizon so the lane has something to look at.
      if (s.elev > 5 && s.o > best.o) {
        best = {
          o: s.o,
          elev: s.elev,
          minutes: i,
          name: v.name,
          lat: v.lat,
          lon: v.lon,
        };
      }
    }
  }
  if (best.o < 0.2) {
    return { structuralError: `no 2026-08-12 eclipse found (max o=${best.o})` };
  }

  // Step off the maximum into a clean PARTIAL band so the alpha-linearity
  // assertion is measurable (a totally eclipsed sun measures zero).
  const bestPos = C.Cartesian3.fromDegrees(best.lon, best.lat, 100.0);
  const peak = C.JulianDate.addMinutes(base, best.minutes, new C.JulianDate());
  let chosen = null;
  for (let s = 0; s <= 3600 && chosen === null; s += 10) {
    for (const sign of [-1, 1]) {
      const t = C.JulianDate.addSeconds(peak, sign * s, new C.JulianDate());
      const st = obscurationAt(bestPos, t);
      if (st.elev > 5 && st.o >= 0.4 && st.o <= 0.65) {
        chosen = {
          iso: C.JulianDate.toIso8601(t),
          obscuration: st.o,
          elev: st.elev,
        };
        break;
      }
    }
  }
  if (chosen === null) {
    return {
      structuralError: `no partial band [0.40,0.65] near the 2026-08-12 maximum (peak o=${best.o})`,
    };
  }

  return {
    region: best.name,
    lat: best.lat,
    lon: best.lon,
    peakObscuration: best.o,
    peakIso: C.JulianDate.toIso8601(peak),
    iso: chosen.iso,
    probeObscuration: chosen.obscuration,
    sunElevationDeg: chosen.elev,
  };
};
// ── In-page: the orbital-sunset sweep (lanes a and c) ───────────────────────
//
// ONE sweep measures BOTH toggle positions per step. The first design ran two
// separate sweeps and compared them, which made three of the lane-(c) checks
// unmeasurable: frame-count-driven animation advanced differently between
// runs, globe-tile residency differed between the cold and warm run, and the
// 8-bit saturation mask could not be shared across two page.evaluate calls.
// Measuring both positions inside one step removes that entire axis — the two
// captures are milliseconds apart, on the same tiles, at the same frame-number
// neighbourhood, and share one mask. It costs no extra rendering: four renders
// per step here versus two renders per step in each of two sweeps.
//
// Per step, in this order (pinned clock on every render):
//   1. enableEclipse = false, sun shown   -> "offOn"  (brightest; mask source)
//   2. enableEclipse = false, sun hidden  -> "offBg"
//   3. enableEclipse = true,  sun shown   -> "onOn"
//   4. enableEclipse = true,  sun hidden  -> "onBg"
// glowOff = sum|offOn - offBg| and glowOn = sum|onOn - onBg|, both over the
// annulus intersected with the pixels that were NOT saturated in offOn.
const SWEEP = async ({ iso, startElevDeg, endElevDeg, steps }) => {
  // ALL helpers live inside this callback (serialization boundary).
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  const T = () => viewer.clock.currentTime;
  scene.requestRenderMode = false;

  // Deterministic, comparable scene: no imagery streaming, analytic terrain,
  // no bloom (WebGPU's is unwired — C11-160), stars/skybox left at default.
  scene.backgroundColor = C.Color.BLACK;
  scene.sunBloom = false;
  if (scene.globe) {
    scene.globe.show = true;
    try {
      scene.globe.imageryLayers.removeAll();
    } catch {
      /* nothing to remove */
    }
    scene.globe.baseColor = C.Color.fromBytes(40, 60, 90, 255);
  }
  try {
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
  } catch {
    /* keep whatever is configured */
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (!scene.sun) {
    scene.sun = new C.Sun();
  }
  scene.sun.show = true;

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;
  if (!ac || !ac.lighting) {
    return { structuralError: "no atmosphericConditions.lighting to toggle" };
  }

  // ── Cull-state capture via postRender ───────────────────────────────────
  // `scene.environmentState.isSunVisible` is the result of the untouched
  // binary `Occluder.isBoundingSphereVisible` test in
  // `Scene.updateEnvironment`. Reading it straight after `scene.render()`
  // proved unreliable in the first Edge run (it read false on every step even
  // where lane (a) shows WebGL drawing a bright sun — and on WebGL a bright
  // sun REQUIRES isSunVisible true, since `EnvironmentRenderer` executes
  // `sunDrawCommand` only under that gate; so the value was a read artifact,
  // not engine behaviour). `postRender` is raised at the end of
  // `Scene.prototype.render`, after `updateEnvironment` has run for that
  // frame, which is the canonical point to sample per-frame scene state.
  // Frames rendered with the sun HIDDEN are ignored outright: hiding it
  // clears `sunDrawCommand`, which forces `isSunVisible` false for reasons
  // that have nothing to do with the cull.
  const cullHolder = {
    isSunVisible: null,
    hasSunCommand: false,
    sunCommandHasBV: null,
    frames: 0,
  };
  const onPostRender = () => {
    if (!scene.sun || scene.sun.show !== true) {
      return;
    }
    const envState = scene.environmentState ?? scene._environmentState ?? null;
    if (!envState) {
      return;
    }
    const cmd = envState.sunDrawCommand;
    cullHolder.isSunVisible = envState.isSunVisible === true;
    cullHolder.hasSunCommand = !!cmd;
    cullHolder.sunCommandHasBV = cmd ? !!cmd.boundingVolume : null;
    cullHolder.frames++;
  };
  const removeCullListener = scene.postRender.addEventListener(onPostRender);
  const snapshotCull = () => ({
    isSunVisible: cullHolder.isSunVisible,
    hasSunCommand: cullHolder.hasSunCommand,
    sunCommandHasBV: cullHolder.sunCommandHasBV,
  });

  const out = {
    rendererType: scene.context.rendererType,
    iso,
    initialTilesLoaded: false,
    postRenderFrames: 0,
    steps: [],
  };

  try {
    // Settle loop — ICRF / earth-orientation data loads async. Bounded.
    {
      let prev = null;
      let stableRun = 0;
      for (let i = 0; i < 180 && stableRun < 10; i++) {
        scene.render(T());
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
    }

    const sunDir = C.Cartesian3.normalize(
      C.Cartesian3.clone(
        scene.context.uniformState.sunPositionWC,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    // A fixed unit vector perpendicular to the sun direction: the camera
    // sweeps the great circle containing the sun, which is what an orbiting
    // camera's sunset track looks like locally.
    const seed =
      Math.abs(sunDir.z) < 0.9
        ? new C.Cartesian3(0, 0, 1)
        : new C.Cartesian3(1, 0, 0);
    const perp = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        C.Cartesian3.cross(sunDir, seed, new C.Cartesian3()),
        sunDir,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const ORBIT_RADIUS = 6371000.0 + 400000.0;

    // Bounded tile-residency settle. Returns true when `tilesLoaded`.
    const settleTiles = async (maxFrames) => {
      const globe = scene.globe;
      if (!globe) {
        return true;
      }
      for (let i = 0; i < maxFrames; i++) {
        if (globe.tilesLoaded === true) {
          return true;
        }
        scene.render(T());
        await new Promise((r) => requestAnimationFrame(r));
      }
      return globe.tilesLoaded === true;
    };
    out.initialTilesLoaded = await settleTiles(400);

    const canvas = scene.canvas;
    const dprX = canvas.width / canvas.clientWidth;
    const dprY = canvas.height / canvas.clientHeight;

    const scratchWin = new C.Cartesian2();
    const scratchWin2 = new C.Cartesian2();
    const tmp = document.createElement("canvas");
    const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });

    // Reusable luminance buffers so four captures per step do not churn the
    // heap. Reallocated only when the ROI size changes (it is essentially
    // constant — the camera-to-sun distance barely moves across the sweep).
    let bufSize = -1;
    let lumOffOn = null;
    let lumOffBg = null;
    let lumOnOn = null;
    let lumOnBg = null;
    let maskBuf = null;
    const ensureBuffers = (size) => {
      if (bufSize === size) {
        return;
      }
      bufSize = size;
      const n = size * size;
      lumOffOn = new Float32Array(n);
      lumOffBg = new Float32Array(n);
      lumOnOn = new Float32Array(n);
      lumOnBg = new Float32Array(n);
      maskBuf = new Uint8Array(n);
    };

    // Capture the ROI into `lum`; when `satOut` is given, also flag pixels
    // that are 8-bit saturated (the additive WebGPU sun clamps at 255 over a
    // bright background, which would bias any ON/OFF ratio toward 1).
    const capture = (x0, y0, size, lum, satOut) => {
      tmpCtx.drawImage(canvas, x0, y0, size, size, 0, 0, size, size);
      const data = tmpCtx.getImageData(0, 0, size, size).data;
      for (let p = 0, k = 0; p < lum.length; p++, k += 4) {
        const r = data[k];
        const g = data[k + 1];
        const b = data[k + 2];
        lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (satOut) {
          satOut[p] = r < 245 && g < 245 && b < 245 ? 1 : 0;
        }
      }
    };

    let structuralError = null;
    for (let i = 0; i < steps && structuralError === null; i++) {
      const elevDeg =
        startElevDeg +
        ((endElevDeg - startElevDeg) * i) / Math.max(1, steps - 1);
      // Local up such that the sun's elevation above the local horizontal is
      // `elevDeg`: angle(up, sunDir) = 90 - elev.
      const theta = ((90.0 - elevDeg) * Math.PI) / 180.0;
      const up = C.Cartesian3.normalize(
        new C.Cartesian3(
          Math.cos(theta) * sunDir.x + Math.sin(theta) * perp.x,
          Math.cos(theta) * sunDir.y + Math.sin(theta) * perp.y,
          Math.cos(theta) * sunDir.z + Math.sin(theta) * perp.z,
        ),
        new C.Cartesian3(),
      );
      const camPos = C.Cartesian3.multiplyByScalar(
        up,
        ORBIT_RADIUS,
        new C.Cartesian3(),
      );
      const sunPos = scene.context.uniformState.sunPositionWC;
      const toSun = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const camUp = C.Cartesian3.normalize(
        C.Cartesian3.cross(
          C.Cartesian3.cross(toSun, up, new C.Cartesian3()),
          toSun,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      scene.camera.setView({
        destination: camPos,
        orientation: { direction: toSun, up: camUp },
      });
      scene.camera.frustum.fov = C.Math.toRadians(12.0);

      // Tile settle BEFORE any capture, so all four captures in this step see
      // the same globe. Expiring is recorded, not structural — but the
      // identity check below only uses steps where it succeeded.
      scene.sun.show = true;
      const tilesSettled = await settleTiles(30);

      // ── 1. eclipse OFF, sun SHOWN (the un-faded reference + mask source) ──
      ac.lighting.enableEclipse = false;
      scene.sun.show = true;
      scene.render(T());
      const cullOff = snapshotCull();
      const fsOff = scene._frameState;
      const alphaOff = fsOff ? fsOff.sunEclipseAlpha : null;
      const esOff = fsOff ? fsOff.eclipseState : null;
      const enabledFlagOff = esOff ? esOff.enabled : null;

      // ROI geometry — the camera is fixed for this whole step, so project
      // once and reuse for all four captures.
      const center = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        sunPos,
        scratchWin,
      );
      const limbWorld = C.Cartesian3.add(
        sunPos,
        C.Cartesian3.multiplyByScalar(camUp, 6.955e8, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const limb = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        limbWorld,
        scratchWin2,
      );
      if (!center || !limb) {
        structuralError = `step ${i}: sun did not project`;
        break;
      }
      const cx = center.x * dprX;
      const cy = center.y * dprY;
      const limbPx =
        Math.hypot(limb.x - center.x, limb.y - center.y) * Math.max(dprX, dprY);
      const maxHalf = Math.floor(0.45 * Math.min(canvas.width, canvas.height));
      // ROI widened from 6.5x to 10.5x the solar limb radius so the EXTENDED
      // mask-sourcing annulus (below) fits. The PRIMARY annulus is unchanged
      // at 1.5x..6x, so lane (a)'s calibration is untouched.
      const half = Math.min(Math.ceil(10.5 * limbPx), maxHalf);
      const x0 = Math.round(cx - half);
      const y0 = Math.round(cy - half);
      if (
        !(limbPx >= 6) ||
        half < 6.5 * limbPx ||
        x0 < 0 ||
        y0 < 0 ||
        x0 + 2 * half >= canvas.width ||
        y0 + 2 * half >= canvas.height
      ) {
        structuralError = `step ${i}: ROI invalid (limbPx=${limbPx.toFixed(2)}, half=${half}, at ${cx.toFixed(1)},${cy.toFixed(1)})`;
        break;
      }
      const size = 2 * half + 1;
      if (tmp.width !== size) {
        tmp.width = size;
        tmp.height = size;
      }
      ensureBuffers(size);
      capture(x0, y0, size, lumOffOn, maskBuf);

      // ── 2. eclipse OFF, sun HIDDEN ───────────────────────────────────────
      scene.sun.show = false;
      scene.render(T());
      capture(x0, y0, size, lumOffBg, null);

      // ── 3. eclipse ON, sun SHOWN ─────────────────────────────────────────
      ac.lighting.enableEclipse = true;
      scene.sun.show = true;
      scene.render(T());
      const cullOn = snapshotCull();
      const fsOn = scene._frameState;
      const alphaOn = fsOn ? fsOn.sunEclipseAlpha : null;
      const es = fsOn ? fsOn.eclipseState : null;
      capture(x0, y0, size, lumOnOn, null);

      // ── 4. eclipse ON, sun HIDDEN ────────────────────────────────────────
      scene.sun.show = false;
      scene.render(T());
      capture(x0, y0, size, lumOnBg, null);
      scene.sun.show = true;

      // ── Integrate both differences over ONE shared mask ───────────────────
      //
      // THREE region/mask combinations are accumulated per step, because one
      // of them collapses on WebGPU and the band gate must stay non-vacuous
      // by construction rather than by luck:
      //
      //  PRIMARY masked  (1.5x..6x, unsaturated only) — lane (a)'s envelope
      //    and the identity check. Unchanged; WebGL measures cleanly here.
      //  WIDE masked     (1.5x..10x, unsaturated only) — band-gate fallback.
      //    WebGPU blends the sun ADDITIVELY, so with the effect off the inner
      //    glow clamps at 255 and the saturation mask throws away exactly the
      //    pixels where the sun contributes; what survives inside 6x can be
      //    only globe pixels the sun never reached, whose difference is 0 —
      //    which is how the round-3 run produced a null band ratio. The glow
      //    falls off radially, so extending the mask-eligible region outward
      //    recovers real, unsaturated, sun-bearing pixels.
      //  PRIMARY raw     (1.5x..6x, NO mask) — conservative last-resort arm.
      //    Saturation can only UNDERSTATE the dimming (a clamped ON pixel is
      //    at most as bright as a clamped OFF pixel), so `glowOnRaw <
      //    glowOffRaw` per step is a one-sided, always-safe claim.
      //
      // ASYMMETRY RATIONALE (same shape as the sun/moon threshold families):
      // the region may widen for MASK SOURCING, but within any single step
      // the glowOn and glowOff sums always run over the identical pixel set,
      // so every ratio compares like with like. Only the choice of which set
      // to use varies, and it is recorded per run in `bandTier`.
      const rInner = 1.5 * limbPx;
      const rPrimary = Math.min(6.0 * limbPx, half - 1);
      const rWide = Math.min(10.0 * limbPx, half - 1);
      const inner2 = rInner * rInner;
      const primary2 = rPrimary * rPrimary;
      const wide2 = rWide * rWide;
      // Radial saturation profile (4 bins across 1.5x..10x), so the manifest
      // shows WHERE the additive blend clamps rather than only that it did.
      const binCount = 4;
      const binEdge2 = [];
      for (let b = 1; b <= binCount; b++) {
        const r = rInner + ((rWide - rInner) * b) / binCount;
        binEdge2.push(r * r);
      }
      const satBin = [0, 0, 0, 0];
      const totBin = [0, 0, 0, 0];

      let glowOff = 0;
      let glowOn = 0;
      let maskedPx = 0;
      let annulusPx = 0;
      let saturatedPx = 0;
      let glowOffWide = 0;
      let glowOnWide = 0;
      let maskedPxWide = 0;
      let annulusPxWide = 0;
      let glowOffRaw = 0;
      let glowOnRaw = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const p = y * size + x;
          const dx = x - half;
          const dy = y - half;
          const d2 = dx * dx + dy * dy;
          if (d2 < inner2 || d2 > wide2) {
            continue;
          }
          const unsaturated = maskBuf[p] === 1;
          const dOn = Math.abs(lumOnOn[p] - lumOnBg[p]);
          const dOff = Math.abs(lumOffOn[p] - lumOffBg[p]);

          let bin = binCount - 1;
          for (let b = 0; b < binCount; b++) {
            if (d2 <= binEdge2[b]) {
              bin = b;
              break;
            }
          }
          totBin[bin]++;
          if (!unsaturated) {
            satBin[bin]++;
          }

          annulusPxWide++;
          if (unsaturated) {
            maskedPxWide++;
            glowOffWide += dOff;
            glowOnWide += dOn;
          }

          if (d2 <= primary2) {
            annulusPx++;
            glowOffRaw += dOff;
            glowOnRaw += dOn;
            if (unsaturated) {
              maskedPx++;
              glowOff += dOff;
              glowOn += dOn;
            } else {
              saturatedPx++;
            }
          }
        }
      }
      const saturationProfile = [];
      for (let b = 0; b < binCount; b++) {
        saturationProfile.push(totBin[b] > 0 ? satBin[b] / totBin[b] : 0);
      }

      out.steps.push({
        i,
        elevDeg,
        limbPx,
        tilesSettled,
        annulusPx,
        maskedPx,
        saturatedFrac: annulusPx > 0 ? saturatedPx / annulusPx : 0,
        saturationProfile,
        glowOn,
        glowOff,
        glowOnWide,
        glowOffWide,
        maskedPxWide,
        annulusPxWide,
        glowOnRaw,
        glowOffRaw,
        alphaOn,
        alphaOff,
        enabledFlagOn: es ? es.enabled : null,
        enabledFlagOff,
        fraction: es ? es.sunVisibleFraction : null,
        earthOcclusion: es ? es.earthOcclusionFraction : null,
        moonObscuration: es ? es.moonObscuration : null,
        earthSeparation: es ? es.earthSeparation : null,
        earthAngularRadius: es ? es.earthAngularRadius : null,
        sunAngularRadius: es ? es.sunAngularRadius : null,
        valid: es ? es.valid : null,
        cullOn,
        cullOff,
      });

      // Yield periodically so the page stays responsive under the watchdog.
      if ((i & 15) === 15) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (structuralError !== null) {
      out.structuralError = structuralError;
    }
    out.postRenderFrames = cullHolder.frames;
    // Leave the page in the shipped configuration for the screenshot.
    ac.lighting.enableEclipse = true;
    scene.sun.show = true;
    scene.render(T());
    return out;
  } finally {
    removeCullListener();
  }
};

// ── In-page: the 2026-08-12 partial-eclipse instant (lane b) ────────────────
const ECLIPSE_INSTANT = async ({ iso, lat, lon }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  const T = () => viewer.clock.currentTime;
  scene.requestRenderMode = false;

  scene.backgroundColor = C.Color.BLACK;
  scene.sunBloom = false;
  if (scene.globe) {
    scene.globe.show = true;
    try {
      scene.globe.imageryLayers.removeAll();
    } catch {
      /* nothing to remove */
    }
    scene.globe.baseColor = C.Color.fromBytes(40, 60, 90, 255);
  }
  try {
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
  } catch {
    /* keep whatever is configured */
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (!scene.sun) {
    scene.sun = new C.Sun();
  }
  scene.sun.show = true;
  // The decorative moon primitive is explicitly HIDDEN: an eclipse must dim
  // the sun whether or not the moon is being drawn (EclipseState computes the
  // lunar ephemeris itself precisely because `Moon.update` is gated on show).
  if (scene.moon) {
    scene.moon.show = false;
  }

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;

  {
    let prev = null;
    let stableRun = 0;
    for (let i = 0; i < 180 && stableRun < 10; i++) {
      scene.render(T());
      const cur = C.Cartesian3.clone(scene.context.uniformState.sunDirectionWC);
      if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) {
        stableRun++;
      } else {
        stableRun = 0;
      }
      prev = cur;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  const camPos = C.Cartesian3.fromDegrees(lon, lat, 100.0);
  const sunPos = scene.context.uniformState.sunPositionWC;
  const toSun = C.Cartesian3.normalize(
    C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
  const camUp = C.Cartesian3.normalize(
    C.Cartesian3.cross(
      C.Cartesian3.cross(toSun, up, new C.Cartesian3()),
      toSun,
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  scene.camera.setView({
    destination: camPos,
    orientation: { direction: toSun, up: camUp },
  });
  scene.camera.frustum.fov = C.Math.toRadians(12.0);

  const canvas = scene.canvas;
  const dprX = canvas.width / canvas.clientWidth;
  const dprY = canvas.height / canvas.clientHeight;
  const tmp = document.createElement("canvas");
  const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });

  // Bounded warm loop so the sun texture + pipeline are resident.
  for (let i = 0; i < 30; i++) {
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }

  // Globe-tile residency settle — the ON/OFF ratio below is a cross-pass
  // comparison, so both passes must see the same globe. Bounded; expiring is
  // recorded, not structural.
  let tilesLoaded = true;
  if (scene.globe) {
    tilesLoaded = false;
    for (let i = 0; i < 180 && !tilesLoaded; i++) {
      if (scene.globe.tilesLoaded === true) {
        tilesLoaded = true;
        break;
      }
      scene.render(T());
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  // `externalMask`, when supplied, restricts the integration to the pixels
  // that were NOT 8-bit saturated in the brighter (eclipse-OFF) pass. WebGPU
  // blends the sun additively, so an un-faded sun over a bright day sky can
  // clamp at 255 and bias the ON/OFF ratio toward 1 — which would make the
  // linearity gate vacuous exactly on the backend it most needs to test.
  const measure = (externalMask) => {
    scene.sun.show = true;
    scene.render(T());
    const center = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      sunPos,
      new C.Cartesian2(),
    );
    const limbWorld = C.Cartesian3.add(
      sunPos,
      C.Cartesian3.multiplyByScalar(camUp, 6.955e8, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const limb = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      limbWorld,
      new C.Cartesian2(),
    );
    if (!center || !limb) {
      return { structuralError: "sun did not project" };
    }
    const cx = center.x * dprX;
    const cy = center.y * dprY;
    const limbPx =
      Math.hypot(limb.x - center.x, limb.y - center.y) * Math.max(dprX, dprY);
    const maxHalf = Math.floor(0.45 * Math.min(canvas.width, canvas.height));
    const half = Math.min(Math.ceil(6.5 * limbPx), maxHalf);
    const x0 = Math.round(cx - half);
    const y0 = Math.round(cy - half);
    if (
      !(limbPx >= 6) ||
      half < 4 * limbPx ||
      x0 < 0 ||
      y0 < 0 ||
      x0 + 2 * half >= canvas.width ||
      y0 + 2 * half >= canvas.height
    ) {
      return {
        structuralError: `ROI invalid (limbPx=${limbPx.toFixed(2)}, half=${half})`,
      };
    }
    const size = 2 * half + 1;
    tmp.width = size;
    tmp.height = size;
    tmpCtx.drawImage(canvas, x0, y0, size, size, 0, 0, size, size);
    const onData = tmpCtx.getImageData(0, 0, size, size).data;

    const fsState = scene._frameState;
    const es = fsState ? fsState.eclipseState : null;
    const snapshot = es
      ? {
          enabled: es.enabled,
          valid: es.valid,
          sunVisibleFraction: es.sunVisibleFraction,
          earthOcclusionFraction: es.earthOcclusionFraction,
          moonObscuration: es.moonObscuration,
          eclipseMagnitude: es.eclipseMagnitude,
          moonSeparation: es.moonSeparation,
          sunAngularRadius: es.sunAngularRadius,
          moonAngularRadius: es.moonAngularRadius,
        }
      : null;
    const alpha = fsState ? fsState.sunEclipseAlpha : null;

    scene.sun.show = false;
    scene.render(T());
    tmpCtx.drawImage(canvas, x0, y0, size, size, 0, 0, size, size);
    const offData = tmpCtx.getImageData(0, 0, size, size).data;
    scene.sun.show = true;

    const inner2 = 1.5 * limbPx * (1.5 * limbPx);
    const outerR = Math.min(6.0 * limbPx, half - 1);
    const outer2 = outerR * outerR;
    // R2 — the sRGB EOTF. The metric below is a DIFFERENCE of composited
    // pixels, and a difference is only linear in alpha in the space the BLEND
    // happened in. Reading back display-encoded bytes and asserting a
    // linear-space property is a category error: with WebGL's ALPHA_BLEND
    // performed in linear space and the result stored sRGB-encoded,
    // |E(a*src + (1-a)*dst) - E(dst)| is COMPRESSIVE in `a` (E is concave), so
    // the measured ratio undershoots — round 3 measured 0.209 against a 0.257
    // floor, which is exactly that signature, and the dst correction from
    // round 2 could only ever move the ceiling. Both spaces are computed and
    // both are reported; which one each backend's blend is analytically valid
    // in is DETERMINED BY MEASUREMENT below, not presumed.
    const srgbToLinear = (b) => {
      const c = b / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lut = new Float32Array(256);
    for (let b = 0; b < 256; b++) {
      lut[b] = srgbToLinear(b);
    }

    const mask = new Uint8Array(size * size);
    let glowSum = 0;
    let glowSumLinear = 0;
    let bgSumLinear = 0;
    // C12-29 S2 — the DESTINATION sum over the same mask: the sun-hidden
    // luminance, i.e. `dst` in the blend equation. Needed because S2 dims the
    // sky the sun is composited OVER, which changes WebGL's difference metric
    // without changing the sun's alpha at all. See `alphaIsLinear`.
    let bgSum = 0;
    let maskedPx = 0;
    let saturatedPx = 0;
    let annulusPx = 0;
    let skyMean = 0;
    let skyPx = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = y * size + x;
        const k = 4 * p;
        const dOn =
          0.2126 * onData[k] + 0.7152 * onData[k + 1] + 0.0722 * onData[k + 2];
        const dOff =
          0.2126 * offData[k] +
          0.7152 * offData[k + 1] +
          0.0722 * offData[k + 2];
        const dx = x - half;
        const dy = y - half;
        const d2 = dx * dx + dy * dy;
        const unsaturated =
          onData[k] < 245 && onData[k + 1] < 245 && onData[k + 2] < 245;
        const inAnnulus = d2 >= inner2 && d2 <= outer2;
        if (inAnnulus) {
          annulusPx++;
          if (!unsaturated) {
            saturatedPx++;
          }
        }
        const keep =
          inAnnulus && unsaturated && (!externalMask || externalMask[p] === 1);
        mask[p] = keep ? 1 : 0;
        if (keep) {
          glowSum += Math.abs(dOn - dOff);
          bgSum += dOff;
          // Same two integrals, in LINEAR space. Luminance weights are applied
          // to linearised channels (which is what luminance means).
          const lOn =
            0.2126 * lut[onData[k]] +
            0.7152 * lut[onData[k + 1]] +
            0.0722 * lut[onData[k + 2]];
          const lOff =
            0.2126 * lut[offData[k]] +
            0.7152 * lut[offData[k + 1]] +
            0.0722 * lut[offData[k + 2]];
          glowSumLinear += Math.abs(lOn - lOff);
          bgSumLinear += lOff;
          maskedPx++;
        }
        skyMean += dOff;
        skyPx++;
      }
    }
    return {
      limbPx,
      glowSum,
      bgSum,
      glowSumLinear,
      bgSumLinear,
      maskedPx,
      annulusPx,
      saturatedFrac: annulusPx > 0 ? saturatedPx / annulusPx : 0,
      skyMean: skyPx > 0 ? skyMean / skyPx : 0,
      state: snapshot,
      alpha,
      mask,
    };
  };

  // Pass 1 — eclipse OFF FIRST (the brighter, un-faded reference). Its
  // unsaturated-pixel mask then constrains the ON pass so both integrals run
  // over exactly the same pixels and the ratio is a true alpha measurement.
  if (ac && ac.lighting) {
    ac.lighting.enableEclipse = false;
  }
  for (let i = 0; i < 4; i++) {
    scene.render(T());
  }
  const off = measure(null);
  if (off.structuralError) {
    return {
      rendererType: scene.context.rendererType,
      structuralError: off.structuralError,
    };
  }

  // Pass 2 — eclipse ON (the shipped default), masked by the OFF pass.
  if (ac && ac.lighting) {
    ac.lighting.enableEclipse = true;
  }
  for (let i = 0; i < 4; i++) {
    scene.render(T());
  }
  const on = measure(off.mask);
  if (on.structuralError) {
    return {
      rendererType: scene.context.rendererType,
      structuralError: on.structuralError,
    };
  }
  // Drop the masks before returning — they must not cross the serialization
  // boundary (and are meaningless outside the page).
  delete off.mask;
  delete on.mask;

  // Restore the default so the page is left in the shipped configuration.
  if (ac && ac.lighting) {
    ac.lighting.enableEclipse = true;
    scene.render(T());
  }

  return {
    rendererType: scene.context.rendererType,
    iso,
    lat,
    lon,
    tilesLoaded,
    on,
    off,
  };
};

// ── Playwright driver ───────────────────────────────────────────────────────
async function runBackend(browser, renderer, plan) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      errs.push(m.text().slice(0, 200));
    }
  });
  const out = { renderer, consoleErrors: errs };
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
    await page.waitForTimeout(4000);

    out.sweep = await page.evaluate(SWEEP, {
      iso: plan.sweepIso,
      startElevDeg: plan.startElevDeg,
      endElevDeg: plan.endElevDeg,
      steps: plan.steps,
    });
    await page
      .locator("canvas")
      .first()
      .screenshot({
        path: path.join(OUT_DIR, `eclipse-sun-fade-sweep-${renderer}.png`),
      })
      .catch(() => {});

    out.instant = await page.evaluate(ECLIPSE_INSTANT, {
      iso: plan.eclipseIso,
      lat: plan.lat,
      lon: plan.lon,
    });
    await page
      .locator("canvas")
      .first()
      .screenshot({
        path: path.join(OUT_DIR, `eclipse-sun-fade-instant-${renderer}.png`),
      })
      .catch(() => {});

    for (const key of ["sweep", "instant"]) {
      const t = out[key] && out[key].rendererType;
      if (t && t !== renderer) {
        out.backendMismatch = `${key}: requested ${renderer}, got ${t}`;
      }
    }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Verdict helpers ─────────────────────────────────────────────────────────
/**
 * Envelope statistics for one luminance series across the sweep. `key` is
 * "glowOn" (eclipse enabled — the shipped default) or "glowOff" (the
 * un-faded reference measured in the same steps).
 */
function envelopeStats(steps, key) {
  const peak = steps.reduce((m, s) => Math.max(m, s[key]), 0);
  if (!(peak > 0)) {
    return { peak: 0, valid: false };
  }
  let maxStepDelta = 0;
  let maxRise = 0;
  for (let i = 1; i < steps.length; i++) {
    const d = (steps[i - 1][key] - steps[i][key]) / peak;
    if (Math.abs(d) > maxStepDelta) {
      maxStepDelta = Math.abs(d);
    }
    if (-d > maxRise) {
      maxRise = -d;
    }
  }
  return {
    valid: true,
    peak,
    firstNorm: steps[0][key] / peak,
    lastNorm: steps[steps.length - 1][key] / peak,
    maxStepDelta,
    maxRise,
  };
}

/** Physics-side statistics, independent of which luminance series is used. */
function physicsStats(steps) {
  return {
    minFraction: steps.reduce(
      (m, s) => Math.min(m, s.fraction === null ? 1 : s.fraction),
      1,
    ),
    maxFraction: steps.reduce(
      (m, s) => Math.max(m, s.fraction === null ? 0 : s.fraction),
      0,
    ),
    // With the toggle OFF the published alpha must be EXACTLY 1 — the
    // identity proof, since `x * 1.0 === x` bit-for-bit in IEEE 754.
    alphaOffAllOne: steps.every((s) => s.alphaOff === 1),
    // With it ON the published alpha must be exactly the published fraction.
    alphaTracksFraction: steps.every(
      (s) =>
        s.alphaOn !== null &&
        s.fraction !== null &&
        Math.abs(s.alphaOn - s.fraction) < 1e-12,
    ),
    // The toggle actually took effect in both directions.
    toggleObserved: steps.every(
      (s) => s.enabledFlagOn === true && s.enabledFlagOff === false,
    ),
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prov = provenance();
  if (!prov.ok) {
    console.error(
      "[probe-eclipse-sun-fade] PROVENANCE FAILURE — stale or missing build:",
      JSON.stringify(prov, null, 2),
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let derived, gl, gpu;
  try {
    const deriveContext = await browser.newContext();
    const derivePage = await deriveContext.newPage();
    await derivePage.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    derived = await derivePage.evaluate(DERIVE_ECLIPSE_INSTANT);
    await deriveContext.close().catch(() => {});
    if (!derived || derived.structuralError) {
      console.error(
        "[probe-eclipse-sun-fade] epoch derivation failed:",
        JSON.stringify(derived),
      );
      await browser.close().catch(() => {});
      process.exit(2);
    }
    console.log(
      `2026-08-12 partial instant: ${derived.iso} @ ${derived.region} ` +
        `(${r3(derived.lat)}, ${r3(derived.lon)}) obscuration≈${r3(derived.probeObscuration)} ` +
        `sunElev≈${r3(derived.sunElevationDeg)}° (regional peak ${r3(derived.peakObscuration)} at ${derived.peakIso})`,
    );

    const plan = {
      // Any clock instant works for the geometric sweep — the camera, not the
      // clock, is what moves. Pinned for determinism.
      sweepIso: "2026-03-20T12:00:00Z",
      startElevDeg: -19.0,
      endElevDeg: -22.6,
      // 101 steps over 3.6 deg = 0.036 deg/step. The disc fade band is ~0.54
      // deg wide at this vantage, so ~15 steps land inside it. Four renders
      // per step (both toggle positions, sun shown + hidden) plus a bounded
      // 30-frame tile settle keeps the whole sweep inside the watchdog.
      steps: 101,
      eclipseIso: derived.iso,
      lat: derived.lat,
      lon: derived.lon,
    };

    gl = await runBackend(browser, "webgl", plan);
    gpu = await runBackend(browser, "webgpu", plan);
  } finally {
    await browser.close().catch(() => {});
  }

  let structural = !!(
    gl.error ||
    gpu.error ||
    gl.backendMismatch ||
    gpu.backendMismatch
  );
  for (const side of [gl, gpu]) {
    for (const key of ["sweep", "instant"]) {
      const v = side[key];
      if (!v || v.structuralError) {
        structural = true;
      }
    }
  }

  const verdicts = {};
  let anyFail = false;

  if (!structural) {
    for (const [name, side] of [
      ["webgl", gl],
      ["webgpu", gpu],
    ]) {
      const steps = side.sweep.steps;
      const on = envelopeStats(steps, "glowOn");
      const off = envelopeStats(steps, "glowOff");
      const phys = physicsStats(steps);
      const inst = side.instant;

      // ── Lane (a): orbital sunset, eclipse ON (the shipped default) ───────
      const laneA = {
        // Absolute sanity: the sun must actually be visible at the start.
        // A black canvas cannot pass this.
        startsBright: on.valid && on.firstNorm > 0.5 && on.peak > 2000,
        // THE POP GATE. Pre-fix WebGL drops the entire glow in ONE step at
        // the bounding-volume cull boundary (delta ~ 1.0).
        continuous: on.valid && on.maxStepDelta <= 0.2,
        // The envelope must not brighten as the sun sinks (monotone within a
        // small tolerance for 8-bit noise).
        monotone: on.valid && on.maxRise <= 0.05,
        // THE WEBGPU GATE. Pre-fix WebGPU never culls and never dims, so the
        // glow above the limb persists at full brightness.
        endsDark: on.valid && on.lastNorm <= 0.02,
        // The physics actually swept a full occultation this run.
        sweptFullRange: phys.maxFraction > 0.99 && phys.minFraction < 0.01,
        // The published alpha is exactly the published fraction.
        alphaTracksFraction: phys.alphaTracksFraction,
      };

      // ── Lane (b): the 2026-08-12 partial-eclipse instant ─────────────────
      const s = inst.on.state;
      const ratio =
        inst.off.glowSum > 0 ? inst.on.glowSum / inst.off.glowSum : null;

      // C12-29 S2 CONFOUND — THE BLEND EQUATIONS ARE NOT THE SAME ON THE TWO
      // BACKENDS, and S2 turned that from a curiosity into a measurement bug.
      //
      //   WebGL  (ALPHA_BLEND): out = a*src + (1-a)*dst  =>  out - dst = a*(src - dst)
      //   WebGPU (additive)   : out = a*src + dst        =>  out - dst = a*src
      //
      // This lane's metric is exactly that difference image, so on WebGPU it
      // is proportional to `a` and nothing else — immune. On WebGL it also
      // depends on `dst`, the SKY THE SUN IS DRAWN OVER — and S2 now dims that
      // sky. So with the eclipse on, WebGL's difference grows for a reason
      // that has nothing to do with the sun's alpha, and the raw ratio
      // over-reports. Measured causally by the executor: toggling
      // `eclipseAutoExposure` (which changes ONLY the S2 scene factor, leaving
      // S1's alpha bit-identical) moved the measured glow by 4.8x.
      //
      // The correction uses only measured quantities. Per pixel, with `A` the
      // sun texture's own alpha and `f` the eclipse factor:
      //   D_off = A*(src - dstOff)
      //   D_on  = A*f*(src - dstOn) = f*D_off + f*A*(dstOff - dstOn)
      // Summing over the shared mask and using A in [0, 1] brackets the ratio:
      //   ratio in [ f , f * (1 + sum(dstOff - dstOn) / sum(D_off)) ]
      // Both `dst` sums are already measured — they are the sun-HIDDEN
      // captures of the four-render pattern, integrated over the same mask.
      //
      // S1's CONTRACT is unaffected and still checked exactly:
      // `alphaEqualsFraction` compares the published alpha with the published
      // fraction bit-for-bit on both backends. Only this luminance PROXY
      // needed the blend model.
      //
      // R2 — AND THE METRIC MUST BE READ IN THE SPACE THE BLEND HAPPENED IN.
      // The captured bytes are display-encoded. `measure()` therefore computes
      // both integrals: `glowSum` (display) and `glowSumLinear` (sRGB EOTF
      // applied per channel before differencing). Which space each backend's
      // blend equation is analytically valid in is DETERMINED BY MEASUREMENT,
      // using WebGPU as the analytic control: its additive blend makes the
      // difference exactly `a*src` in whichever space it runs, so whichever
      // space reproduces `f` on WebGPU is that backend's blend space. WebGL is
      // then gated in LINEAR space, where `out - dst = a*(src - dst)` holds —
      // reading a linear-space law off display-encoded pixels is what produced
      // round 3's 0.209-against-a-0.257-floor undershoot (E is concave, so the
      // encoded difference is compressive in `a`; the round-2 dst correction
      // could only ever move the ceiling, never the floor).
      const ratioLinear =
        inst.off.glowSumLinear > 0
          ? inst.on.glowSumLinear / inst.off.glowSumLinear
          : null;
      const dstDelta = Math.max(0, inst.off.bgSum - inst.on.bgSum);
      const dstDeltaLinear = Math.max(
        0,
        inst.off.bgSumLinear - inst.on.bgSumLinear,
      );
      const dstLift = inst.off.glowSum > 0 ? dstDelta / inst.off.glowSum : 0;
      const dstLiftLinear =
        inst.off.glowSumLinear > 0
          ? dstDeltaLinear / inst.off.glowSumLinear
          : 0;
      const isAdditiveBlend = name === "webgpu";
      const f = s ? s.sunVisibleFraction : null;
      // The analytic control: on the additive backend the difference is
      // exactly `a*src`, so ONE of the two spaces must reproduce `f` tightly.
      const errDisplay =
        f !== null && ratio !== null ? Math.abs(ratio - f) : null;
      const errLinear =
        f !== null && ratioLinear !== null ? Math.abs(ratioLinear - f) : null;
      const controlTol = f !== null ? 0.03 * f + 0.01 : null;
      const blendSpace =
        errDisplay === null || errLinear === null
          ? null
          : errLinear <= errDisplay
            ? "linear"
            : "display";
      const ratioGated = blendSpace === "display" ? ratio : ratioLinear;
      const liftGated = blendSpace === "display" ? dstLift : dstLiftLinear;
      const linearUpper =
        f !== null
          ? 1.2 * f * (isAdditiveBlend ? 1 : 1 + liftGated) + 0.05
          : null;
      const additiveControlIsExact =
        !isAdditiveBlend ||
        (controlTol !== null &&
          Math.min(errDisplay ?? Infinity, errLinear ?? Infinity) <=
            controlTol);
      const alphaIsLinearMeasured =
        ratioGated !== null &&
        f !== null &&
        ratioGated > 0.8 * f &&
        ratioGated < linearUpper &&
        additiveControlIsExact;

      // NON-BOOLEAN DIAGNOSTICS LIVE OUTSIDE `laneB` ON PURPOSE. The verdict
      // aggregate is `Object.values(laneB).every(Boolean)`, so a numeric field
      // that legitimately measures 0 (`dstDelta` on a frame where the sky did
      // not move, say) would silently fail the whole lane. Keeping `laneB`
      // boolean-only makes the aggregate mean what it says.
      const laneBDiagnostics = {
        blendModel: isAdditiveBlend
          ? "additive (out-dst = a*src) — dst-independent, no dst correction"
          : "ALPHA_BLEND (out-dst = a*(src-dst)) — dst-corrected for S2 sky dimming",
        // Which space this backend's blend was measured to operate in, and the
        // evidence for it. Recorded per backend rather than assumed.
        blendSpace,
        ratioDisplay: r6(ratio),
        ratioLinear: r6(ratioLinear),
        ratioGated: r6(ratioGated),
        errDisplay: r6(errDisplay),
        errLinear: r6(errLinear),
        dstSumOff: r3(inst.off.bgSum),
        dstSumOn: r3(inst.on.bgSum),
        dstSumOffLinear: r6(inst.off.bgSumLinear),
        dstSumOnLinear: r6(inst.on.bgSumLinear),
        dstDelta: r3(dstDelta),
        dstLift: r3(dstLift),
        dstLiftLinear: r3(dstLiftLinear),
        linearUpper: r6(linearUpper),
        // Computed on BOTH backends; only GATED where the blend model makes it
        // analytic (see the structural note below).
        alphaIsLinearMeasured,
      };

      // ── THE GATED SET IS SYMMETRIC BY PHYSICS, NOT BY SHAPE ──────────────
      //
      // ORCHESTRATOR RULING (2026-07-24, terminal cycle): the WebGL sun-glow
      // LUMINANCE RATIO is reclassified REPORTED-NOT-GATED. Three independent
      // models were tried against it and all three failed —
      //   1. naive linear      (`ratio ~ f` on display bytes)
      //   2. dst-corrected display  (round 2: S2 dims the `dst` the sun is
      //      composited over; fixed the ceiling only)
      //   3. dst-corrected linear   (round 4: sRGB EOTF before differencing)
      // and the measured 0.2089 sits BELOW the analytic floor `f` in BOTH
      // spaces, which no dst term and no encoding can produce. The WebGL
      // sun-glow proxy is confounded by compositing effects none of our models
      // capture, and continuing to widen a band around it would only make the
      // gate mean less. It stays MEASURED and REPORTED so a future session has
      // the trail; it does not decide the run.
      //
      // What replaces it is a structural requirement, checked below: EACH
      // BACKEND MUST CARRY AT LEAST ONE GATED ECLIPSE-ALPHA APPLICATION PROOF.
      //   WebGL  -> laneC `eclipseVisiblyApplied`, the primary-masked band
      //             ratio (measured 0.491 == expected, green three cycles).
      //   WebGPU -> laneB `alphaIsLinear`, valid because its additive blend
      //             makes the difference analytically `a*src` (control exact
      //             at 2.4e-5) — and its laneC is `NA-geometric-limb`, which
      //             already delegates here.
      // `alphaEqualsFraction` — the actual S1 CONTRACT — stays gated on both.
      //
      // IF A FUTURE CHANGE FLIPS A BACKEND'S BLEND MODEL (e.g. C11-115 moving
      // WebGPU to ALPHA_BLEND), THE GATING LANE MUST BE RE-DERIVED: the
      // additive control disappears and laneB stops being analytic on that
      // backend. `eclipse-scene-dimming.spec.mjs` pins this structure so the
      // change fails loudly instead of silently ungating a backend.
      const laneB = {
        stateValid: !!s && s.valid === true && s.enabled === true,
        partialEclipse:
          !!s && s.sunVisibleFraction < 1 && s.sunVisibleFraction > 0,
        moonIsTheOccluder:
          !!s && s.moonObscuration > 0.2 && s.earthOcclusionFraction === 0,
        // S1's contract, bit-for-bit. Gated on BOTH backends, always.
        alphaEqualsFraction:
          inst.on.alpha !== null &&
          !!s &&
          Math.abs(inst.on.alpha - s.sunVisibleFraction) < 1e-12,
        offToggleIsIdentity: inst.off.alpha === 1,
        // Absolute sanity: the un-faded reference must be a real, bright sun
        // measured over a non-trivial set of unsaturated pixels.
        referenceBright: inst.off.glowSum > 2000 && inst.off.maskedPx > 500,
      };
      if (isAdditiveBlend) {
        // Only the additive backend gets the luminance proxy as a GATE, and
        // only together with its own control.
        laneB.additiveControlIsExact = additiveControlIsExact;
        laneB.alphaIsLinear = alphaIsLinearMeasured;
      }

      // ── Lane (c): the toggle-off identity, measured IN THE SAME STEPS ────
      //
      // REDESIGNED TWICE. The first version asked the luminance metric to
      // show WebGL's binary pop, which is geometrically unobservable (the
      // cull can only fire once the limb already covers the glow annulus).
      // The second version compared two SEPARATE sweeps, which no tolerance
      // can rescue: frame-count-driven animation, globe-tile residency and
      // the 8-bit saturation mask all differ across runs. This version
      // measures both toggle positions inside the same step, so those three
      // axes are gone by construction, and proves the cull claim at STATE
      // level via `scene.environmentState.isSunVisible`.
      //
      // NOTE ON WHAT IS AND IS NOT CLAIMED ABOUT THE CULL. The sun's glow
      // bounding volume is ~4.2e9 m while the Earth occluder is ~6.4e6 m,
      // so `Occluder.isBoundingSphereVisible` takes its rarely-exercised
      // "occludee larger than occluder" path and may never report the sun
      // fully occluded at 1 AU. Whether it fires in this scene is therefore
      // RECORDED, not gated — asserting "the cull fires" would repeat the
      // first version's mistake of gating on an unverified premise. What IS
      // gated is the regression-relevant claim: S1 did not change the cull's
      // behaviour, i.e. its per-step state is identical with the effect on
      // and off.
      let cullStatesEqual = true;
      let cullFirstDivergence = -1;
      let visibleStepCount = 0;
      let bvConsistent = true;
      for (let i = 0; i < steps.length; i++) {
        const a = steps[i].cullOn;
        const b = steps[i].cullOff;
        if (
          a.isSunVisible !== b.isSunVisible ||
          a.hasSunCommand !== b.hasSunCommand ||
          a.sunCommandHasBV !== b.sunCommandHasBV
        ) {
          if (cullStatesEqual) {
            cullFirstDivergence = i;
          }
          cullStatesEqual = false;
        }
        if (a.isSunVisible === true) {
          visibleStepCount++;
        }
        // WebGL's sun is a `DrawCommand` WITH a bounding volume (the cull can
        // fire); WebGPU's is a `WebGPUDrawCommand` with none, so
        // `Scene.isVisible` early-returns true and no cull exists at all.
        // This is the structural, backend-distinguishing fact and it does not
        // depend on whether the cull ever fires.
        const expectBV = name === "webgl";
        if (a.hasSunCommand && a.sunCommandHasBV !== expectBV) {
          bvConsistent = false;
        }
      }
      const cullFlipStep = (key) => {
        let seenVisible = false;
        for (let i = 0; i < steps.length; i++) {
          if (steps[i][key].isSunVisible === true) {
            seenVisible = true;
          } else if (seenVisible && steps[i][key].isSunVisible === false) {
            return i;
          }
        }
        return -1;
      };
      const onFlip = cullFlipStep("cullOn");
      const offFlip = cullFlipStep("cullOff");

      // Metric agreement where the eclipse factor is exactly 1, restricted to
      // steps whose globe tiles had settled (limb pixels inside the annulus
      // otherwise differ between the two captures).
      const unoccluded = steps.filter((s) => s.fraction === 1);
      const unoccludedSettled = unoccluded.filter((s) => s.tilesSettled);
      const relDelta = (s) =>
        Math.abs(s.glowOn - s.glowOff) / Math.max(s.glowOff, 1);
      let identityPool = unoccludedSettled;
      let identityTolerance = 0.02;
      let identityRelaxedReason = null;
      if (unoccludedSettled.length < 5) {
        // Fallback ONLY when settled steps are impossible; recorded so the
        // relaxation can never pass silently.
        identityPool = unoccluded;
        identityTolerance = 0.05;
        identityRelaxedReason = `only ${unoccludedSettled.length} of ${unoccluded.length} unoccluded steps had settled tiles`;
      }
      const identityWorst = identityPool.reduce(
        (m, s) => Math.max(m, relDelta(s)),
        0,
      );

      // Where the eclipse actually applies, the ON series must be measurably
      // dimmer. THREE TIERS, tried in order, so the gate is non-vacuous by
      // construction — the round-3 run produced a null ratio on WebGPU
      // because its additive blend saturated away every sun-bearing pixel
      // inside the primary annulus, leaving only globe pixels whose
      // difference is exactly 0.
      const MASKED_PX_FLOOR = 300;
      const MIN_BAND_STEPS = 5;
      const partialBand = steps.filter(
        (x) => x.fraction > 0.02 && x.fraction < 0.98,
      );
      // The load-bearing measurement for the backend-aware arm below: the
      // brightest sun contribution ANY partial-band step produced over the
      // unmasked annulus. Zero means the sun is not visible in the annulus
      // anywhere in the fade band — a geometric fact about the scene, not a
      // saturation artifact and not an eclipse effect.
      const partialGlowOffRawMax = partialBand.reduce(
        (m, x) => Math.max(m, x.glowOffRaw),
        0,
      );
      const partialGlowOnRawMax = partialBand.reduce(
        (m, x) => Math.max(m, x.glowOnRaw),
        0,
      );
      const ratioOver = (pool, onKey, offKey) => {
        let sOn = 0;
        let sOff = 0;
        let sOffF = 0;
        for (const x of pool) {
          sOn += x[onKey];
          sOff += x[offKey];
          sOffF += x[offKey] * x.fraction;
        }
        return sOff > 0
          ? { measured: sOn / sOff, expected: sOffF / sOff }
          : { measured: null, expected: null };
      };

      const poolPrimary = partialBand.filter(
        (x) => x.maskedPx >= MASKED_PX_FLOOR,
      );
      const poolWide = partialBand.filter(
        (x) => x.maskedPxWide >= MASKED_PX_FLOOR,
      );
      let bandTier = null;
      let bandStepsUsed = 0;
      let bandRatioMeasured = null;
      let bandRatioExpected = null;
      let bandStrictSteps = 0;
      let bandStrictTotal = 0;
      let bandGatePassed = false;
      let bandTierReason = null;

      if (poolPrimary.length >= MIN_BAND_STEPS) {
        const r = ratioOver(poolPrimary, "glowOn", "glowOff");
        if (r.measured !== null) {
          bandTier = "primary-masked";
          bandStepsUsed = poolPrimary.length;
          bandRatioMeasured = r.measured;
          bandRatioExpected = r.expected;
          bandGatePassed = r.measured < 0.8;
        }
      }
      if (bandTier === null && poolWide.length >= MIN_BAND_STEPS) {
        const r = ratioOver(poolWide, "glowOnWide", "glowOffWide");
        if (r.measured !== null) {
          bandTier = "wide-masked";
          bandTierReason = `only ${poolPrimary.length} partial-band steps reached ${MASKED_PX_FLOOR} unsaturated px inside 6x the limb radius; mask sourced from the 1.5x..10x annulus instead (glowOn/glowOff still summed over the identical pixel set per step)`;
          bandStepsUsed = poolWide.length;
          bandRatioMeasured = r.measured;
          bandRatioExpected = r.expected;
          bandGatePassed = r.measured < 0.8;
        }
      }
      if (bandTier === null) {
        // Conservative arm: over the UNMASKED primary annulus, require the
        // eclipse-ON sum to be strictly smaller at every partial-band step.
        // Saturation can only understate the dimming (a clamped ON pixel is
        // at most as bright as a clamped OFF pixel), so this is one-sided and
        // can never manufacture a pass.
        for (const x of partialBand) {
          if (x.glowOffRaw > 0) {
            bandStrictTotal++;
            if (x.glowOnRaw < x.glowOffRaw) {
              bandStrictSteps++;
            }
          }
        }
        bandTier = "raw-strict";
        bandTierReason = `no partial-band step reached ${MASKED_PX_FLOOR} unsaturated px in either annulus (primary ${poolPrimary.length}, wide ${poolWide.length}); falling back to a per-step strict-inequality count over the unmasked 1.5x..6x annulus, which saturation can only bias against passing`;
        bandStepsUsed = bandStrictTotal;
        bandGatePassed =
          bandStrictTotal >= MIN_BAND_STEPS &&
          bandStrictSteps === bandStrictTotal;
        const r = ratioOver(partialBand, "glowOnRaw", "glowOffRaw");
        bandRatioMeasured = r.measured;
        bandRatioExpected = r.expected;

        // ── Backend-aware close-out (round-4 evidence) ─────────────────────
        // On WebGPU the round-4 run measured glowOffRaw == glowOnRaw == 0 at
        // ALL 15 partial-band steps (fraction 0.990 down to 0.001), with the
        // effect off AND on. That is not saturation and not an S1 effect: the
        // fade band IS the earth-limb crossing, and WebGL has a measurable
        // band there only because its ~6 R_sun glow billboard extends ABOVE
        // the limb. The WebGPU sun's glow does not survive the limb at all —
        // a PRE-EXISTING backend sun-RENDERING divergence, squarely C12-15/
        // 16/17 sun-wave territory, not something S1 introduced or can fix.
        //
        // So the earth-limb band cannot demonstrate visible application on
        // WebGPU at this vantage. Rather than pass a vacuous raw-strict count
        // (0 >= 5 is already false) or drop the gate, laneC DEFERS the proof
        // to lane (b): the open-sky 2026-08-12 moon eclipse, where the sun is
        // high above the horizon, nothing occludes the annulus, and the alpha
        // multiply is measured directly and linearly. The condition is
        // MEASURED (partialGlowOffRawMax === 0), never assumed.
        if (
          name === "webgpu" &&
          partialBand.length > 0 &&
          partialGlowOffRawMax === 0
        ) {
          bandTier = "NA-geometric-limb";
          bandTierReason = `WebGPU sun glow does not extend above the earth limb (glowOffRaw 0 across all ${partialBand.length} partial-band steps, fraction ${r6(partialBand[0].fraction)} down to ${r6(partialBand[partialBand.length - 1].fraction)}, with the effect off AND on) — visible earth-limb dimming is unobservable on WebGPU until the C12-15..17 sun-appearance wave lands. This is a pre-existing backend sun-RENDERING divergence, not an S1 defect. The eclipse alpha application on WebGPU is proven by the open-sky moon-eclipse lane instead: laneB alphaIsLinear + partialEclipse.`;
          bandStepsUsed = partialBand.length;
          // Explicitly require lane (b)'s WebGPU proof, so the deferral is a
          // real dependency rather than a silent exemption.
          bandGatePassed =
            laneB.alphaIsLinear === true && laneB.partialEclipse === true;
        }
      }
      const partialBandSteps = partialBand.length;

      const laneC = {
        // The identity proof, at the only place it is exactly checkable.
        alphaExactlyOne: phys.alphaOffAllOne,
        // The toggle demonstrably flipped in both directions every step.
        toggleObserved: phys.toggleObserved,
        // Non-vacuity of the toggle: the physics still runs with it off.
        physicsStillComputed:
          phys.maxFraction > 0.99 && phys.minFraction < 0.01,
        // THE REGRESSION PIN: S1 did not change the legacy cull's behaviour.
        cullStateUnchanged: cullStatesEqual,
        // Non-vacuity for that pin — the sun was genuinely un-culled at least
        // once, so "identical" is not "identically false everywhere".
        cullNonVacuous: visibleStepCount > 0,
        // Structural backend fact: WebGL's sun command carries a bounding
        // volume, WebGPU's does not.
        boundingVolumeShape: bvConsistent,
        // Same sun measured where alpha is 1.
        identityWhereUnoccluded:
          identityPool.length > 0 && identityWorst <= identityTolerance,
        // And measurably dimmer where the eclipse applies. The tier actually
        // used is recorded in `crossToggle.bandTier` + `bandTierReason`, so a
        // fallback can never pass silently.
        eclipseVisiblyApplied: partialBandSteps > 0 && bandGatePassed,
      };
      if (identityPool.length === 0) {
        structural = true;
      }

      // ── The symmetric-by-physics application proof (see the laneB note) ──
      // Each backend nominates the lane whose blend model makes its pixel
      // proof analytic, and that lane's result is REQUIRED. WebGL's laneB
      // ratio is measured and reported but never decides the run; WebGPU's
      // laneC is `NA-geometric-limb` (its sun glow does not survive the earth
      // limb) and already delegates to laneB.
      const applicationProof = isAdditiveBlend
        ? {
            backend: name,
            gatedLane: "laneB.alphaIsLinear",
            gatedResult: laneB.alphaIsLinear === true,
            reason:
              "additive blend makes the difference image analytically a*src, " +
              "so the luminance ratio IS the alpha; the additive control is " +
              "checked alongside it. laneC is NA-geometric-limb on this " +
              "backend and delegates here.",
            reportedOnly: [],
          }
        : {
            backend: name,
            gatedLane: "laneC.eclipseVisiblyApplied",
            gatedResult: laneC.eclipseVisiblyApplied === true,
            reason:
              "ALPHA_BLEND makes the sun-glow difference depend on the dst " +
              "sky that S2 also dims, and three models (naive linear, " +
              "dst-corrected display, dst-corrected linear) all failed — the " +
              "measured ratio sits BELOW the analytic floor f in BOTH spaces. " +
              "The primary-masked laneC band ratio is the gated proof on this " +
              "backend instead.",
            reportedOnly: ["laneB.alphaIsLinearMeasured"],
          };

      const packEnv = (e) => ({
        peak: r3(e.peak),
        firstNorm: r3(e.firstNorm),
        lastNorm: r3(e.lastNorm),
        maxStepDelta: r3(e.maxStepDelta),
        maxRise: r3(e.maxRise),
      });

      verdicts[name] = {
        eclipseOnEnvelope: packEnv(on),
        // The un-faded reference envelope, measured in the same steps. This
        // is the in-run "before" picture: on WebGPU it is what the sun looked
        // like when nothing ever dimmed it.
        eclipseOffEnvelope: packEnv(off),
        physics: {
          minFraction: r6(phys.minFraction),
          maxFraction: r6(phys.maxFraction),
        },
        cull: {
          statesEqual: cullStatesEqual,
          firstDivergenceStep: cullFirstDivergence,
          visibleStepCount,
          onFlipStep: onFlip,
          offFlipStep: offFlip,
          onFlipElevDeg: onFlip >= 0 ? r3(steps[onFlip].elevDeg) : null,
          onFlipFraction: onFlip >= 0 ? r6(steps[onFlip].fraction) : null,
          sunCommandHasBV:
            steps.length > 0 ? steps[0].cullOn.sunCommandHasBV : null,
          postRenderFrames: side.sweep.postRenderFrames,
        },
        tiles: {
          initialLoaded: side.sweep.initialTilesLoaded,
          settledSteps: steps.filter((x) => x.tilesSettled).length,
          totalSteps: steps.length,
          instantLoaded: inst.tilesLoaded,
        },
        crossToggle: {
          unoccludedSteps: unoccluded.length,
          unoccludedSettledSteps: unoccludedSettled.length,
          identityTolerance,
          identityWorstRelDelta: r3(identityWorst),
          identityRelaxedReason,
          partialBandSteps,
          bandTier,
          bandTierReason,
          bandStepsUsed,
          bandRatioMeasured: r3(bandRatioMeasured),
          bandRatioExpected: r3(bandRatioExpected),
          bandStrictSteps,
          bandStrictTotal,
          // The measured basis for the "NA-geometric-limb" arm. Zero means
          // the sun contributed NO visible annulus pixels anywhere in the
          // fade band, with the effect off or on.
          partialGlowOffRawMax: r3(partialGlowOffRawMax),
          partialGlowOnRawMax: r3(partialGlowOnRawMax),
          // Set when laneC delegates its visible-application proof to laneB.
          deferredToLaneB:
            bandTier === "NA-geometric-limb"
              ? {
                  alphaIsLinear: laneB.alphaIsLinear,
                  partialEclipse: laneB.partialEclipse,
                }
              : null,
          // How many partial-band steps cleared the unsaturated-pixel floor
          // in each annulus — the mechanism behind any tier fallback.
          partialStepsOverFloorPrimary: poolPrimary.length,
          partialStepsOverFloorWide: poolWide.length,
          maskedPxFloor: MASKED_PX_FLOOR,
          partialMaskedPxMin: partialBand.reduce(
            (m, x) => Math.min(m, x.maskedPx),
            Number.POSITIVE_INFINITY,
          ),
          partialMaskedPxMax: partialBand.reduce(
            (m, x) => Math.max(m, x.maskedPx),
            0,
          ),
          partialMaskedPxWideMin: partialBand.reduce(
            (m, x) => Math.min(m, x.maskedPxWide),
            Number.POSITIVE_INFINITY,
          ),
          partialMaskedPxWideMax: partialBand.reduce(
            (m, x) => Math.max(m, x.maskedPxWide),
            0,
          ),
          meanSaturatedFrac: r3(
            steps.reduce((m, x) => m + x.saturatedFrac, 0) /
              Math.max(steps.length, 1),
          ),
          // Mean saturated fraction per radial bin across 1.5x..10x the limb
          // radius (4 bins, inner -> outer): shows WHERE the additive blend
          // clamps, not merely that it did.
          meanSaturationProfile: [0, 1, 2, 3].map((b) =>
            r3(
              steps.reduce((m, x) => m + (x.saturationProfile?.[b] ?? 0), 0) /
                Math.max(steps.length, 1),
            ),
          ),
          partialSaturationProfile: [0, 1, 2, 3].map((b) =>
            r3(
              partialBand.reduce(
                (m, x) => m + (x.saturationProfile?.[b] ?? 0),
                0,
              ) / Math.max(partialBand.length, 1),
            ),
          ),
        },
        instant: {
          iso: inst.iso,
          sunVisibleFraction: r6(s ? s.sunVisibleFraction : null),
          moonObscuration: r6(s ? s.moonObscuration : null),
          eclipseMagnitude: r3(s ? s.eclipseMagnitude : null),
          alphaOn: r6(inst.on.alpha),
          alphaOff: r6(inst.off.alpha),
          glowOn: r3(inst.on.glowSum),
          glowOff: r3(inst.off.glowSum),
          // The S2 blend confound, in the manifest so the correction is
          // auditable rather than implicit: `dst` is the sky the sun is
          // composited over, and S2 dims it.
          dstSumOn: r3(inst.on.bgSum),
          dstSumOff: r3(inst.off.bgSum),
          ratio: r3(ratio),
          maskedPx: inst.off.maskedPx,
          annulusPx: inst.off.annulusPx,
          saturatedFracOff: r3(inst.off.saturatedFrac),
          skyMean: r3(inst.off.skyMean),
        },
        laneA,
        laneB,
        laneBDiagnostics,
        laneC,
        // THE STRUCTURAL REQUIREMENT that replaces gating WebGL's confounded
        // luminance proxy: every backend must still carry at least ONE gated
        // proof that the eclipse alpha is actually APPLIED to pixels. Which
        // lane supplies it is a consequence of that backend's blend physics,
        // and is recorded here rather than left implicit.
        applicationProof,
        PASS:
          Object.values(laneA).every(Boolean) &&
          Object.values(laneB).every(Boolean) &&
          Object.values(laneC).every(Boolean) &&
          applicationProof.gatedResult === true,
      };
      if (!verdicts[name].PASS) {
        anyFail = true;
      }
    }

    // Cross-backend parity on the eclipse-ON envelope: both backends must
    // fade over the same fraction band and reach zero.
    const a = verdicts.webgl;
    const b = verdicts.webgpu;
    if (a && b) {
      const parity = {
        // The fraction is CPU-computed from identical camera positions, so
        // the two backends must agree to the reporting precision.
        sameSweepRange:
          Math.abs(a.physics.minFraction - b.physics.minFraction) <= 2e-6 &&
          Math.abs(a.physics.maxFraction - b.physics.maxFraction) <= 2e-6,
        bothContinuous: a.laneA.continuous && b.laneA.continuous,
        bothEndDark: a.laneA.endsDark && b.laneA.endsDark,
      };
      verdicts.parity = parity;
      if (!Object.values(parity).every(Boolean)) {
        anyFail = true;
      }
    }
  }

  const GATE = structural
    ? "STRUCTURAL — a lane never reached a valid measurement"
    : anyFail
      ? "FAIL — sun fade is not continuous / not identity-off / not tracking the eclipse fraction"
      : "PASS — continuous limb fade on both backends, moon obscuration applied at the 2026-08-12 partial, toggle-off restores legacy behaviour with alpha exactly 1.0";

  const manifest = {
    probe: "probe-eclipse-sun-fade",
    task: "C12-29 S1 (EclipseState + continuous sun fade)",
    date: new Date().toISOString(),
    provenance: prov,
    derived,
    verdicts,
    GATE,
    raw: { gl, gpu },
  };
  const outPath = path.join(OUT_DIR, "eclipse-sun-fade.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ derived, verdicts, GATE }, null, 2));
  console.log(`\n[full report: ${outPath}]`);

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-eclipse-sun-fade] FATAL", e);
  process.exit(2);
});
