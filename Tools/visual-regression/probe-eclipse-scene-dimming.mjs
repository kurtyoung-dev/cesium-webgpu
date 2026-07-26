#!/usr/bin/env node
// probe-eclipse-scene-dimming.mjs — C12-29 S2 (scene-light + atmosphere
// dimming), WebGL vs WebGPU.
//
// WHAT S2 SHIPS (research: migration_doc/ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md).
// S1 made the sun BILLBOARD fade. S2 makes the WORLD dim: one per-frame scalar
// `frameState.eclipseSceneLightFactor` multiplies
//   1. the scene's sun-driven light colour  (UniformState -> czm_/csm_lightColor
//      + czm_/csm_lightColorHdr + the WebGPU globe camera UB),
//   2. the sky-atmosphere shell            (SkyAtmosphere.js closure + the
//      WebGPU sky renderer's `u.intensity`),
//   3. the globe's ground atmosphere AND its fog (one `tileProvider`
//      mirror in Globe.js, read by both backends),
//   4. `frameState.skyBrightness`          (inert at defaults),
//   5. WebGPU MODEL direct lighting + its sky-irradiance ambient
//      (`WebGPUModelRenderer.packLightUniforms`) — the ONE site that does not
//      share a uniform source with WebGL, because `ModelPBRComplete.wgsl`
//      reads no `csm_lightColor*` at all.
// The factor is linear in the limb-darkened flux fraction, floored on the
// documented ~5-lux twilight constant, and carried through the eye's
// adaptation exponent unless `eclipseAutoExposure` is on (ruling E2).
//
// THE MEASUREMENT, AND WHY IT IS AN INTERLEAVE. Every step renders the SAME
// pinned instant three times — {enableEclipse off} then {on} then
// {on + eclipseAutoExposure} — and the lane's metric is the RATIO of the
// on-luminance to the off-luminance inside that one step. Two things fall out:
//
//   * The sun-elevation confound disappears. The instants in the ladder are up
//     to ~90 minutes apart, so their raw luminances are not comparable at all;
//     the within-step ratio is.
//   * Cross-run comparison is deleted. S1's lane (c) needed three redesigns
//     before this lesson stuck: two separate sweeps can never be compared,
//     because frame-count-driven animation, globe-tile residency and 8-bit
//     saturation all differ between runs.
//
// THE CAMERA LOOKS AWAY FROM THE SUN. Anti-solar azimuth, pitched 10 deg down,
// 60 deg FOV, from the derived ground vantage. That removes the S1 sun
// billboard from the frame entirely, so nothing this probe measures can be
// explained by S1's alpha fade — what is left is sky (upper band) and lit
// ground (lower band), which is exactly the S2 surface. The horizon row that
// separates the two bands is found by binary-searching
// `camera.pickEllipsoid`, not assumed.
//
// `globe.enableLighting` is switched ON. It is off in stock Cesium, and with
// it off `GlobeFS`/`GlobeTerrain.wgsl` never multiply by the scene light at
// all — the terrain band would then only exercise injection site 3. Sites 2
// and 3 are measured on the default path regardless; site 1 needs this.
//
// LANES:
//   (a) ladder   — 5 instants derived IN-PAGE from Simon1994 around the
//       2026-08-12 eclipse at an Iceland/Spain ground vantage, at target
//       obscurations 0 / ~0.35 / ~0.65 / ~0.90 / maximum. Asserts the
//       measured dim ratio falls monotonically as the published factor
//       falls, that it is bracketed by the linear prediction below and the
//       display-gamma-lifted prediction above, and that the deepest step
//       dims visibly.
//   (b) curve + floor — the published factor is checked against a SECOND
//       implementation of the S2 curve at the MEASURED obscuration, at every
//       rung and in both E2 modes, which tests the transfer everywhere rather
//       than only at the endpoint. The floor is then a bound (`>= floor`)
//       everywhere plus an exact equality at obscuration 1.0 only — the curve
//       reaches the floor there and nowhere below it (0.995 -> 0.1716,
//       0.9999 -> 0.0531), so an "== floor at >= 0.995" gate would false-fail
//       across a zone the ladder can genuinely land in. Plus absolute
//       luminance floors so a blank canvas cannot pass vacuously.
//   (c) identity — the OFF position must publish EXACTLY 1.0 every step (the
//       identity proof: `x * 1.0 === x` bit-for-bit), the toggle must be
//       observed flipping both ways, and at the zero-obscuration step the ON
//       and OFF images must agree to within measurement noise.
//   (d) autoExposure — ruling E2's camera mode must publish a STRICTLY LOWER
//       (linear radiometric) factor than the eye-adapted default at every
//       eclipsed step, and render correspondingly darker.
//   Parity: the published factor series must agree between backends to f64
//   precision (it is one CPU module), and the measured dim series to a band —
//   but ONLY once both contexts are shown to have resolved the same
//   Earth-orientation rotation. `Transforms` substitutes the TEME pseudo-fixed
//   matrix while the IAU2006 XYS data loads, and the two disagree by ~0.3-0.4
//   deg in 2026 (larger than the solar disc), so a branch mismatch makes the
//   two ephemerides genuinely different. The settle loop cannot catch it — it
//   only demands the sun direction STOP MOVING, which a stuck TEME frame
//   satisfies perfectly. A mismatch is therefore classified STRUCTURAL
//   (reference disagreement about the fixture), never reported as an engine
//   failure.
//
//   The measured ratio is read through the DISPLAY TRANSFORM, not against a
//   naive `f^(1/2.2)` bound: the sky and the globe's atmosphere/fog drape run
//   through Khronos PBR-Neutral tonemapping plus an inverse gamma on the
//   default LDR path, and that compressive shoulder puts the measured ratio
//   ABOVE `f^(1/2.2)` at bright rungs. `predictDim` inverts gamma, inverts
//   PBR-Neutral, scales by the factor and pushes the result back out through
//   the same transform, so the bracket tracks the shoulder by construction.
//
//   Injection site 1 additionally gets an END-TO-END numeric check on both
//   backends: `uniformState.lightColorHdr` must equal
//   `light.color * light.intensity * factor` at every rung, which proves the
//   published scalar reached the light uniform rather than merely existing on
//   `frameState`.
//
//   ★ THE GATE IS AN EQUIVALENCE, NOT A PREDICTION (round 4, terminal).
//   Three rounds of physical modelling — display gamma, the PBR-Neutral
//   shoulder, then background reveal — each explained part of the sky band and
//   each leaked somewhere else. Round 3's own falsifiability machinery killed
//   the last one: `backgroundRevealExplains` came back FALSE on both backends
//   at every rung, with `cRecovered` 3.5-42x larger than the measured
//   background could supply. What the data actually shows is that the shell's
//   response to `atmosphereLightIntensity` is strongly SUB-LINEAR in the
//   bright regime (rung 1: a factor of 0.866 moved the sky only to 0.986) —
//   saturating scattering stacked on the tonemap — and no closed form is going
//   to survive that. Each further round of widening a predictive bound is a
//   round of the gate learning less.
//
//   S2's contract is not "the sky dims by f". It is "S2 applies exactly the
//   factor the injection sites would apply if you set them by hand". So each
//   eclipsed rung takes ONE more capture with `enableEclipse` OFF and the same
//   factor applied MANUALLY through the public surfaces — `scene.light` colour
//   x f (site 1), `skyAtmosphere.atmosphereLightIntensity` x f (site 2),
//   `globe.atmosphereLightIntensity` x f (site 3, whose `tileProvider` mirror
//   is then VERIFIED to carry the same number, not assumed to) — and the two
//   images must agree per band within 2% relative + 0.005 absolute. Model-free
//   by construction: every nonlinearity applies identically to both paths and
//   cancels exactly. Site 4 is excluded (no public setter, and byte-inert at
//   defaults — asserted); site 5 is N/A (no model in the scene). `predictDim`,
//   `cRecovered` and `backgroundRevealExplains` are KEPT as reported-only
//   diagnostics, because they are the record of the saturating-shell physics
//   for whoever reads this next.
//
//   THE SKY BAND IS NOT THE SHELL ALONE (Edge cycle finding I1, both
//   backends, growing with obscuration). The band is
//   `shell*alpha + B*(1-alpha)` composited in display space, and the shell's
//   alpha is luminance-dependent (`mix(color.b, 1, heightOpacity)`) — so as
//   S2 dims the shell, its alpha falls and MORE of the un-dimmed skybox/star
//   cubemap shows through. That is the `L = f*L_shell + c` additive signature
//   the deep rungs measured, and it is a legitimately non-solar source: a
//   starrier totality sky is PHYSICALLY CORRECT (E3/S6 territory), so the
//   instrument is what has to change, never the stars. Each rung therefore
//   takes two extra captures with `skyAtmosphere.show = false` (both toggle
//   positions, same pinned state) to measure the fully revealed background
//   `B`, and the sky prediction becomes a bracket over the unknown revealed
//   fraction: `c = 0` at the low end (shell-only) and `c = B` at the high end.
//   The model is falsifiable rather than assumed — `cRecovered` is bisected
//   back out of the measurement and `backgroundRevealExplains` reports whether
//   it fits inside the measured `B`; if it does not, the reveal hypothesis is
//   refuted and the report says so. `backgroundIsToggleInvariant` additionally
//   gates that the background does NOT move with the eclipse toggle. Star
//   modulation is default-on now, but hiding the atmosphere makes its
//   applicability false; this control therefore remains full-strength in both
//   toggle positions.
//
//   THE VISUAL LANE IS CAPTURED IN-TASK (finding I3). A post-evaluate
//   `page.locator('canvas').screenshot()` runs after the page has been
//   restored to the live wall clock with no globe, so it captured the default
//   view and the lane shipped empty. The deepest rung's frames are now read as
//   canvas data URLs inside the same task as the render that produced them —
//   eclipse ON and OFF, both backends — and written from Node.
//
// PROBE RULES (fleet convention): useDefaultRenderLoop killed; EVERY
// scene.render(t) gets the pinned time; sun-direction settle loop (ICRF loads
// async); canvas capture in the SAME task as its render; canvas ELEMENT
// screenshots (locator('canvas'), never page.screenshot); rendererType
// recorded + hard-fail on mismatch; absolute sanity floors; unref'd force-exit
// watchdog; try/finally close; bounded loops; hard exit codes (0 pass / 1 gate
// fail / 2 structural). Provenance markers are numeral-free — esbuild rewrites
// `1.0` to `1` on the way into the bundle (learned in S1).
//
// EVERY helper used inside a page.evaluate callback is defined INSIDE that
// callback — module-scope bindings do not cross the serialization boundary.
//
// Usage: node Tools/visual-regression/probe-eclipse-scene-dimming.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import {
  LADDER_TARGETS,
  validateLadderSeparation,
} from "./eclipse-ladder-rungs.mjs";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const HARD_LIMIT_MS = 420000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-eclipse-scene-dimming] WATCHDOG FIRED (420s) — forcing exit",
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

// The engine's documented totality floor, recomputed here from the same two
// published illuminance figures rather than imported, so a silent retune of
// the engine constant fails this probe instead of riding along with it.
const ECLIPSE_RADIOMETRIC_FLOOR = 5.0 / 100000.0;
const ECLIPSE_ADAPTATION_EXPONENT = 1.0 / 3.0;
const EXPECTED_TWILIGHT_FLOOR = Math.pow(
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
);

/**
 * The S2 curve, reimplemented here from the published constants — a SECOND
 * implementation, so the probe tests the engine's transfer rather than
 * echoing it. Used to check the published factor against the measured
 * obscuration at EVERY rung, which is strictly stronger than only checking
 * the endpoint: the curve reaches the floor exactly at obscuration 1.0 and
 * nowhere below it (at 0.995 the correct factor is 0.1716, at 0.9999 it is
 * 0.0531), so an "is it the floor yet?" gate anchored at 0.995 would fire
 * false failures across the whole [0.995, 1) zone — which is reachable, since
 * the in-page locator is a uniform disc while the engine is limb-darkened,
 * and 10-second stepping can straddle second contact.
 */
function predictFactor(obscuration, autoExposure) {
  if (!(obscuration > 0)) {
    return 1.0;
  }
  const visible = obscuration >= 1 ? 0 : 1 - obscuration;
  const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1 - visible);
  return autoExposure ? flux : Math.pow(flux, ECLIPSE_ADAPTATION_EXPONENT);
}

// ── The display transform the measured ratio has to be read through ────────
// Both backends run the sky (and the globe's atmosphere/fog drape) through
// Khronos PBR-Neutral tonemapping followed by an inverse gamma on the default
// LDR path (`#ifndef HDR`; the probe does not enable HDR). That shoulder is
// COMPRESSIVE, so a linear light multiply of `f` does NOT show up as `f` or
// even as `f^(1/2.2)` in the capture — at a bright rung it measures well
// above both, and a naive `f^(1/2.2)` upper bound false-fails.
//
// So the bound is derived THROUGH the shoulder instead: invert gamma, invert
// PBR-Neutral to recover a scene-linear stand-in, scale it by the published
// factor, push it back out through the same transform, and compare the
// measured ratio against THAT prediction. Applying a per-pixel nonlinearity to
// a band MEAN is an approximation — that is what the tolerance bands around
// the prediction are for, and it is why the prediction is a band rather than
// an equality.
const PBR_NEUTRAL_START_COMPRESSION = 0.8 - 0.04;

/**
 * Scalar (achromatic) PBR-Neutral tonemap — the peak-channel path. On an
 * achromatic input the final desaturation `mix(color, newPeak*white, g)` is a
 * no-op (the colour and the white it mixes toward are the same value), so the
 * whole transform collapses to the offset + the peak compression. That is
 * exactly the right stand-in here, because the metric is a band MEAN
 * LUMINANCE, not a colour.
 */
function pbrNeutral(x) {
  if (!(x > 0)) {
    return 0;
  }
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const c = x - offset;
  if (c < PBR_NEUTRAL_START_COMPRESSION) {
    return c;
  }
  const d = 1 - PBR_NEUTRAL_START_COMPRESSION;
  return 1 - (d * d) / (c + d - PBR_NEUTRAL_START_COMPRESSION);
}

/** Monotone inverse of `pbrNeutral`, by bisection. Bounded at 60 steps. */
function pbrNeutralInverse(y) {
  if (!(y > 0)) {
    return 0;
  }
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (pbrNeutral(mid) < y) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * Predicted measured ratio for a band whose OFF mean is `meanOff` (in [0,1],
 * post-tonemap + post-inverse-gamma, as captured) when the scene light is
 * scaled by `factor`.
 */
function predictDim(meanOff, factor) {
  if (!(meanOff > 0)) {
    return null;
  }
  const tonemappedOff = Math.pow(meanOff, 2.2); // undo the inverse gamma
  const linearOff = pbrNeutralInverse(tonemappedOff);
  const onCaptured = Math.pow(pbrNeutral(linearOff * factor), 1 / 2.2);
  return onCaptured / meanOff;
}

// ── Provenance: the probe must not run against a stale build ────────────────
const SOURCE_FILES = [
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/computeSolarObscuration.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/SkyAtmosphere.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Renderer/UniformState.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
];

// NUMERAL-FREE substrings on purpose: esbuild normalises float literals
// (`1.0` -> `1`) on the way into the bundle, so any marker containing `1.0`
// matches the source but never the build and would fail provenance on a
// perfectly current build (S1's lesson, cost a round).
const VERBATIM_SLICES = [
  {
    file: "packages/engine/Source/Scene/EclipseState.js",
    marker: "const visible = obscuration >= ",
  },
  {
    file: "packages/engine/Source/Renderer/UniformState.js",
    marker: "eclipseSceneLightFactor !== ",
  },
  {
    file: "packages/engine/Source/Scene/Globe.js",
    marker: "this.atmosphereLightIntensity *",
  },
  {
    file: "packages/engine/Source/Scene/SkyAtmosphere.js",
    marker: "atmosphereLightIntensity * that._eclipseLightFactor",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    marker: "skyAtmosphere._eclipseLightFactor",
  },
  {
    file: "packages/engine/Source/Scene/Scene.js",
    marker: "frameState.eclipseSceneLightFactor = ",
  },
  {
    // Injection site 5 — WebGPU model direct lighting, the one site that does
    // NOT share a uniform source with WebGL.
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
    marker: "lightColor.red * eclipseFactor",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
    marker: "skyIrradiance.x * eclipseFactor",
  },
];

const REQUIRED_TOKENS = [
  "eclipseSceneLightFactor", // the published S2 scalar
  "eclipseAutoExposure", // ruling E2's mode toggle
  "_eclipseLightFactor", // the SkyAtmosphere per-frame mirror
  "eclipseFactor", // the WebGPU model-renderer local (site 5)
  "autoExposure", // the EclipseState field
  "moonObscuration", // what the scene factor is derived FROM
  "enableEclipse", // the S1 toggle, still gating application
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
  // marker searches — `Build/CesiumUnminified` accumulates content-hashed
  // chunks across builds, and a stale leftover would contain every token we
  // look for, turning the guard into a no-op exactly when it matters.
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

// ── In-page: derive the 2026-08-12 obscuration LADDER + its vantage ─────────
// Pure ephemeris + geometry, no rendering, and deliberately a SECOND
// implementation of the overlap math (uniform-disc — enough to LOCATE the
// instants; the engine's limb-darkened value is what the lane then reads).
// Bounded: 2 regions x 9 vantages x 301 coarse samples, then 5 x 1201 refine
// samples on the chosen vantage.
const DERIVE_ECLIPSE_LADDER = async ({ fixedTargets }) => {
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

  const stateAt = (camPos, t) => {
    const { sun, moon } = bodiesAt(t);
    const toSun = C.Cartesian3.subtract(sun, camPos, new C.Cartesian3());
    const dSun = C.Cartesian3.magnitude(toSun);
    C.Cartesian3.divideByScalar(toSun, dSun, toSun);
    const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
    const elev =
      90 - (Math.acos(clampUnit(C.Cartesian3.dot(up, toSun))) * 180) / Math.PI;
    const toMoon = C.Cartesian3.subtract(moon, camPos, new C.Cartesian3());
    const dMoon = C.Cartesian3.magnitude(toMoon);
    if (dMoon >= dSun) return { o: 0, elev };
    C.Cartesian3.divideByScalar(toMoon, dMoon, toMoon);
    const rs = Math.asin(Math.min(1, SOLAR_RADIUS / dSun));
    const ro = Math.asin(Math.min(1, LUNAR_RADIUS / dMoon));
    const sep = Math.acos(clampUnit(C.Cartesian3.dot(toSun, toMoon)));
    return { o: overlap(rs, ro, sep), elev };
  };

  // The maintainer-facing 2026 showcase pair from the research report's
  // acceptance scenes.
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
      const s = stateAt(v.pos, t);
      // The sun must be well above the horizon or the lit-ground band has
      // nothing in it.
      if (s.elev > 8 && s.o > best.o) {
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
  if (best.o < 0.6) {
    return { structuralError: `no deep 2026-08-12 eclipse found (max o=${best.o})` };
  }

  // Walk 100 minutes of seconds-resolution on either side of the maximum and
  // pick the instant closest to each rung of the ladder.
  //
  // `fixedTargets` is passed in as DATA (module-scope bindings do not cross
  // the serialization boundary — `LADDER_TARGETS` in `eclipse-ladder-rungs.mjs`
  // is the single source of truth, and the spec pins it there). The final rung
  // is always "as deep as this eclipse actually goes at this vantage".
  const pos = C.Cartesian3.fromDegrees(best.lon, best.lat, 100.0);
  const peak = C.JulianDate.addMinutes(base, best.minutes, new C.JulianDate());
  const targets = [...fixedTargets, Math.min(best.o, 1.0)];
  const picks = targets.map(() => null);
  for (let s = -6000; s <= 6000; s += 10) {
    const t = C.JulianDate.addSeconds(peak, s, scratchT);
    const st = stateAt(pos, t);
    if (!(st.elev > 8)) {
      continue;
    }
    for (let k = 0; k < targets.length; k++) {
      const err = Math.abs(st.o - targets[k]);
      if (picks[k] === null || err < picks[k].err) {
        picks[k] = {
          err,
          iso: C.JulianDate.toIso8601(t),
          obscuration: st.o,
          sunElevationDeg: st.elev,
        };
      }
    }
  }
  if (picks.some((p) => p === null)) {
    return { structuralError: "ladder rung unreachable above 8 deg sun elevation" };
  }
  // The rung-separation check deliberately does NOT live here. It is pure data
  // validation over the returned array, so it runs in the Node driver via
  // `validateLadderSeparation` — where it can be unit-tested and where a
  // failure can print the offending pair instead of an opaque list.

  return {
    region: best.name,
    lat: best.lat,
    lon: best.lon,
    peakObscuration: best.o,
    peakIso: C.JulianDate.toIso8601(peak),
    ladder: picks.map((p) => ({
      iso: p.iso,
      obscuration: p.obscuration,
      sunElevationDeg: p.sunElevationDeg,
    })),
  };
};

// ── In-page: the ladder measurement (all four lanes) ────────────────────────
const LADDER = async ({ lat, lon, ladder }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;

  // Deterministic, comparable scene.
  scene.backgroundColor = C.Color.BLACK;
  // WebGPU's sun bloom is unwired (C11-160); leaving it on makes the two
  // backends structurally incomparable. The camera looks away from the sun
  // anyway, so this only removes a screen-space bleed risk.
  scene.sunBloom = false;
  if (scene.globe) {
    scene.globe.show = true;
    try {
      scene.globe.imageryLayers.removeAll();
    } catch {
      /* nothing to remove */
    }
    scene.globe.baseColor = C.Color.fromBytes(70, 90, 60, 255);
    // See the header: with lighting off the globe shaders never multiply by
    // the scene light at all, so injection site 1 would be unobservable.
    scene.globe.enableLighting = true;
    scene.globe.showGroundAtmosphere = true;
  }
  try {
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
  } catch {
    /* keep whatever is configured */
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
  }
  if (scene.sun) {
    scene.sun.show = true;
  }

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;
  if (!ac || !ac.lighting) {
    return { structuralError: "no atmosphericConditions.lighting to toggle" };
  }
  if (!("eclipseAutoExposure" in ac.lighting)) {
    return { structuralError: "eclipseAutoExposure toggle is absent" };
  }
  if (!("enableEclipseHorizonTwilight" in ac.lighting)) {
    return {
      structuralError: "enableEclipseHorizonTwilight toggle is absent",
    };
  }
  if (ac.lighting.enableEclipseHorizonTwilight !== true) {
    return {
      structuralError:
        "enableEclipseHorizonTwilight no longer has its shipped default-on value",
    };
  }

  // ── R1 setup: make the MANUAL path an exact twin of the engine path ───────
  //
  // The equivalence gate below re-creates the eclipse factor by hand through
  // the public surfaces of the injection sites. Two preconditions have to hold
  // or the twin is not a twin, and both are asserted rather than assumed.
  //
  // (1) SUN LIGHT INTENSITY 1.0. Site 1 dims `_lightColorHdr` AND `_lightColor`
  //     AFTER the LDR clamp (`_lightColor` = hdr renormalised so its max
  //     channel is <= 1). Scaling `light.color` by hand instead dims BEFORE
  //     that clamp, and the clamp then divides the scale straight back out:
  //     at the stock intensity of 2.0 a manual factor of 0.8 gives
  //     hdr' = 1.6, max 1.6 > 1, so `_lightColor` renormalises to 1.0 —
  //     completely undimmed — while the engine path gives 0.8. The two paths
  //     agree exactly when the clamp never fires, i.e. when
  //     `color * intensity <= 1`. Forcing intensity 1.0 with a white base
  //     colour puts the whole factor range on that branch, so manual and
  //     engine become algebraically identical. (This asymmetry is a real,
  //     documented property of site 1, not a defect — pre-clamp dimming is
  //     exactly what the site's comment says it must never do.)
  //
  // (2) AERIAL PERSPECTIVE OFF. When `scene.aerialPerspective` is on AND the
  //     backend is WebGPU, `Scene.updateFrameState` REPLACES `frameState.light`
  //     with `_atmosphereDerivedLight`, whose colour is computed from the
  //     atmosphere and ignores `scene.light.color` entirely — so the manual
  //     colour scaling would silently do nothing on that backend only. It
  //     defaults to false; the probe asserts that rather than trusting it.
  if (scene.aerialPerspective === true) {
    return {
      structuralError:
        "scene.aerialPerspective is on — frameState.light would be the derived " +
        "light and the manual colour scaling would be a no-op on WebGPU",
    };
  }
  const BASE_LIGHT_INTENSITY = 1.0;
  const baseLightColor = C.Color.clone(C.Color.WHITE);
  scene.light = new C.SunLight({
    color: baseLightColor,
    intensity: BASE_LIGHT_INTENSITY,
  });

  // Site 4 (`frameState.skyBrightness`) has no public setter. It USED to be
  // excluded from the manual twin, justified by being byte-inert at defaults:
  // its sole consumer is the cubemap-panorama star modulation, gated on
  // `enableStarBrightnessModulation`, false since C11-176. That justification
  // was asserted rather than assumed, precisely so the exclusion could not
  // outlive it — and it did not.
  //
  // ★ C12-29 S6 / ruling E3 ENDED IT. The maintainer's E3 ruling flips
  // `enableStarBrightnessModulation` to true by default, so site 4 is LIVE:
  // `Scene.render` publishes `skyBrightness = computeSkyBrightness(...) *
  // eclipseSceneLightFactor`, the modulation consumes it, and the engine path
  // therefore dims the star cubemap while an unmodelled manual path would not.
  // The guard fired exactly as designed and caught a cross-slice regression.
  //
  // RESOLVED BY MODELLING SITE 4, not by re-justifying the exclusion. The
  // exclusion cannot be re-justified: S2's own round-3 finding is that the sky
  // band is NOT the shell alone — the cubemap composites through it — so a
  // dimmed cubemap lands inside the very band the equivalence gate measures.
  // Turning the modulation off for the capture would restore the old
  // justification, but it would test a configuration the engine no longer
  // ships, which is the bypass this guard exists to prevent.
  //
  // The modelling is exact and uses a public knob: the engine evaluates the
  // modulation curve at `B * f`, so the manual twin evaluates the SAME curve at
  // `B` with an inflection re-solved to produce the identical factor. Both
  // paths then hand the cubemap shader one number, and it is the same number.
  const starModulation =
    ac.skyAtmosphere?.enableStarBrightnessModulation ?? false;
  const starCurve = ac.skyAtmosphere?.starModulationCurve;
  if (starModulation === true && !starCurve) {
    return {
      structuralError:
        "enableStarBrightnessModulation is on but starModulationCurve is " +
        "absent — site 4 is live and cannot be modelled in the manual twin",
    };
  }
  // Site 5 (WebGPU model direct lighting) is N/A here: the scene contains no
  // model. Recorded in the manifest so the coverage claim stays honest.

  const out = {
    rendererType: scene.context.rendererType,
    vantage: { lat, lon },
    // N2 — which Earth-orientation rotation this browser context resolved.
    // `Transforms` silently substitutes the TEME pseudo-fixed matrix while the
    // IAU2006 XYS data is still loading, and the two disagree by ~0.3-0.4 deg
    // in 2026 — LARGER than the solar disc. Two contexts can legitimately land
    // on different branches (the settle loop only demands the sun direction
    // STOP MOVING, which a stuck TEME frame satisfies perfectly), so the
    // cross-backend factor comparison has to know before it compares.
    icrfBranch: [],
    steps: [],
  };

  const canvas = scene.canvas;
  const dprX = canvas.width / canvas.clientWidth;
  const dprY = canvas.height / canvas.clientHeight;
  const tmp = document.createElement("canvas");
  const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });

  const camPos = C.Cartesian3.fromDegrees(lon, lat, 100.0);
  const ellipsoid = scene.globe ? scene.globe.ellipsoid : C.Ellipsoid.WGS84;

  const readBandPixels = (y0, y1) => {
    const x0 = Math.round(canvas.width * 0.15);
    const w = Math.round(canvas.width * 0.7);
    const h = Math.max(1, y1 - y0);
    tmp.width = w;
    tmp.height = h;
    tmpCtx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    return { data: tmpCtx.getImageData(0, 0, w, h).data, w, h };
  };

  // Mean luminance of an axis-aligned band of canvas rows, plus the fraction
  // of pixels that are 8-bit saturated (a saturated band cannot report a
  // dimming ratio and must not be allowed to pass vacuously). The optional
  // mask is derived from a white-vs-black globe-base-color A/B and limits the
  // ground statistic to pixels that demonstrably belong to the rendered globe.
  const bandStats = (y0, y1, mask) => {
    const { data, w, h } = readBandPixels(y0, y1);
    let sum = 0;
    let sat = 0;
    let used = 0;
    const n = w * h;
    for (let p = 0, k = 0; p < n; p++, k += 4) {
      if (mask && mask[p] !== 1) {
        continue;
      }
      const r = data[k];
      const g = data[k + 1];
      const b = data[k + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      used++;
      if (r >= 250 && g >= 250 && b >= 250) {
        sat++;
      }
    }
    return {
      mean: used > 0 ? sum / used / 255 : 0,
      saturated: used > 0 ? sat / used : 0,
      sampleFraction: used / n,
    };
  };

  const readState = () => {
    const fsState = scene._frameState;
    const es = fsState ? fsState.eclipseState : null;
    // Injection site 1, read END TO END on both backends: `lightColorHdr` is
    // what `czm_lightColorHdr` / `csm_lightColorHdr` carry, and it must equal
    // `light.color * light.intensity * factor`. This is the numeric proof that
    // the published scalar actually reached the light uniform, as opposed to
    // merely existing on `frameState`.
    const us = scene.context.uniformState;
    const hdr = us ? us.lightColorHdr : null;
    const sceneLight = fsState ? fsState.light : null;
    const lightRed = sceneLight?.color?.red ?? null;
    const lightIntensity = sceneLight?.intensity ?? null;
    return {
      lightColorHdrX: hdr ? hdr.x : null,
      lightRawRed: lightRed,
      lightIntensity,
      factor: fsState ? fsState.eclipseSceneLightFactor : null,
      enabled: es ? es.enabled : null,
      autoExposure: es ? es.autoExposure : null,
      valid: es ? es.valid : null,
      moonObscuration: es ? es.moonObscuration : null,
      earthOcclusionFraction: es ? es.earthOcclusionFraction : null,
      sunVisibleFraction: es ? es.sunVisibleFraction : null,
      skyBrightness: fsState ? fsState.skyBrightness : null,
    };
  };

  // I3 — VISUAL LANE, captured IN-TASK.
  //
  // `page.locator('canvas').screenshot()` after the evaluate returns is the
  // wrong instrument for this probe and shipped an empty lane: by then the
  // page has been restored to the live wall clock with no globe, so the PNGs
  // were the default view, not the eclipse. The canvas must be read in the
  // SAME task as the render that produced it (the fleet's same-task rule), so
  // the deepest rung's frames are grabbed here as data URLs and written from
  // Node.
  const shots = {};
  const grabCanvas = () => {
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  };

  let structuralError = null;
  let groundMask;
  let terrainResponse;
  for (let i = 0; i < ladder.length && structuralError === null; i++) {
    const rung = ladder[i];
    viewer.clock.currentTime = C.JulianDate.fromIso8601(rung.iso);
    const T = () => viewer.clock.currentTime;

    // Sun-direction settle: the ICRF / earth-orientation data loads async, and
    // the clock JUMPS between rungs. Bounded.
    {
      let prev = null;
      let stableRun = 0;
      for (let k = 0; k < 120 && stableRun < 8; k++) {
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

    // N2 — record the rotation branch AT THIS RUNG, after the settle. `true`
    // means the IAU2006 XYS data resolved; `false` means this context is still
    // on the TEME fallback, and its ephemeris (hence its published factor) is
    // not comparable with a context that resolved ICRF.
    out.icrfBranch.push(
      !!C.Transforms.computeIcrfToFixedMatrix(T(), new C.Matrix3()),
    );

    // Anti-solar view, pitched 10 deg down: no sun billboard in frame, so
    // nothing measured here can be S1's alpha fade.
    const sunPos = scene.context.uniformState.sunPositionWC;
    const toSun = C.Cartesian3.normalize(
      C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
    const anti = C.Cartesian3.negate(toSun, new C.Cartesian3());
    const horiz = C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        anti,
        C.Cartesian3.multiplyByScalar(
          up,
          C.Cartesian3.dot(anti, up),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const pitch = (10.0 * Math.PI) / 180.0;
    const dir = C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        C.Cartesian3.multiplyByScalar(horiz, Math.cos(pitch), new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(up, Math.sin(pitch), new C.Cartesian3()),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const camUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        C.Cartesian3.cross(dir, up, new C.Cartesian3()),
        dir,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    scene.camera.setView({
      destination: camPos,
      orientation: { direction: dir, up: camUp },
    });
    scene.camera.frustum.fov = C.Math.toRadians(60.0);

    // Globe-tile residency settle BEFORE any capture, so all captures in this
    // step see the same globe. `tilesLoaded` alone is insufficient: it is also
    // true for an empty/no-tile frame. Require renderable tiles after a current
    // render, exactly as the S6 totality fixture does.
    let tilesLoaded = true;
    let tilesToRender = 0;
    if (scene.globe) {
      tilesLoaded = false;
      for (let k = 0; k < 240 && !tilesLoaded; k++) {
        scene.render(T());
        tilesToRender = scene.globe._surface?._tilesToRender?.length ?? 0;
        if (scene.globe.tilesLoaded === true && tilesToRender > 0) {
          tilesLoaded = true;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!tilesLoaded) {
        structuralError =
          `step ${i}: globe never reached non-empty offline readiness ` +
          `(tilesToRender=${tilesToRender})`;
        break;
      }
    }

    // Horizon row by binary search on `pickEllipsoid` — defined below the
    // horizon, undefined above it. CSS pixels in, canvas pixels out.
    const cxCss = canvas.clientWidth * 0.5;
    let loCss = 0;
    let hiCss = canvas.clientHeight - 1;
    const scratch2 = new C.Cartesian2();
    const hitsGlobe = (yCss) => {
      scratch2.x = cxCss;
      scratch2.y = yCss;
      return !!scene.camera.pickEllipsoid(scratch2, ellipsoid, new C.Cartesian3());
    };
    if (hitsGlobe(loCss) || !hitsGlobe(hiCss)) {
      structuralError = `step ${i}: horizon not inside the viewport`;
      break;
    }
    for (let k = 0; k < 24 && hiCss - loCss > 1; k++) {
      const mid = (loCss + hiCss) * 0.5;
      if (hitsGlobe(mid)) {
        hiCss = mid;
      } else {
        loCss = mid;
      }
    }
    const horizonPx = Math.round(hiCss * dprY);
    const H = canvas.height;
    const skyY0 = Math.max(0, Math.round(horizonPx - 0.45 * H));
    const skyY1 = Math.max(skyY0 + 1, Math.round(horizonPx - 0.06 * H));
    const groundY0 = Math.min(H - 2, Math.round(horizonPx + 0.06 * H));
    const groundY1 = Math.min(H - 1, Math.round(horizonPx + 0.45 * H));
    if (skyY1 - skyY0 < 20 || groundY1 - groundY0 < 20) {
      structuralError = `step ${i}: bands too thin (sky ${skyY1 - skyY0}, ground ${groundY1 - groundY0})`;
      break;
    }

    // The deepest rung is the last one (the ladder is ascending in
    // obscuration by construction, and the driver has already validated that).
    const isDeepest = i === ladder.length - 1;

    // ── 1. eclipse OFF (the un-dimmed reference) ──────────────────────────
    ac.lighting.enableEclipse = false;
    ac.lighting.eclipseAutoExposure = false;
    scene.render(T());
    let offState = readState();
    let offSky = bandStats(skyY0, skyY1);
    let offGround = bandStats(groundY0, groundY1, groundMask);

    // A non-empty tile list does not prove that the ground ROI contains globe
    // pixels. Build one stable mask from a white-vs-black base-color A/B on the
    // clear rung, and require a material response before any ground claim is
    // allowed to gate. This catches the historical WebGPU near-limb
    // globe-absent failure instead of accidentally measuring sky/background.
    if (!groundMask && scene.globe) {
      const savedBaseColor = C.Color.clone(scene.globe.baseColor);

      scene.globe.baseColor = C.Color.clone(C.Color.WHITE);
      scene.render(T());
      const white = readBandPixels(groundY0, groundY1);

      scene.globe.baseColor = C.Color.clone(C.Color.BLACK);
      scene.render(T());
      const black = readBandPixels(groundY0, groundY1);

      const n = white.w * white.h;
      groundMask = new Uint8Array(n);
      const responseFloor = 8 / 255;
      let responsivePixels = 0;
      let responseSum = 0;
      let whiteSum = 0;
      let blackSum = 0;
      for (let p = 0, k = 0; p < n; p++, k += 4) {
        const whiteLuma =
          (0.2126 * white.data[k] +
            0.7152 * white.data[k + 1] +
            0.0722 * white.data[k + 2]) /
          255;
        const blackLuma =
          (0.2126 * black.data[k] +
            0.7152 * black.data[k + 1] +
            0.0722 * black.data[k + 2]) /
          255;
        const response = Math.abs(whiteLuma - blackLuma);
        whiteSum += whiteLuma;
        blackSum += blackLuma;
        responseSum += response;
        if (response >= responseFloor) {
          groundMask[p] = 1;
          responsivePixels++;
        }
      }
      const responsiveFraction = responsivePixels / n;
      const meanAbsoluteResponse = responseSum / n;
      terrainResponse = {
        responseFloor,
        responsivePixels,
        responsiveFraction,
        meanAbsoluteResponse,
        whiteMean: whiteSum / n,
        blackMean: blackSum / n,
        pass: responsiveFraction >= 0.25 && meanAbsoluteResponse >= 0.05,
      };

      scene.globe.baseColor = savedBaseColor;
      scene.render(T());
      offState = readState();
      offSky = bandStats(skyY0, skyY1);
      offGround = bandStats(groundY0, groundY1, groundMask);
    }
    if (isDeepest) {
      // Read in the same task as the render above.
      shots.deepestOff = grabCanvas();
    }

    // ── 2. eclipse ON, human-eye default (the shipped default path) ───────
    ac.lighting.enableEclipse = true;
    ac.lighting.eclipseAutoExposure = false;
    scene.render(T());
    const onState = readState();
    const onSky = bandStats(skyY0, skyY1);
    const onGround = bandStats(groundY0, groundY1, groundMask);
    if (isDeepest) {
      shots.deepestOn = grabCanvas();
    }
    // Site 3's mirror, read HERE — immediately after the ON render, while it
    // still holds what the ON frame was drawn with. It used to be read down in
    // the manual block, which sits AFTER the auto-exposure capture: that
    // capture renders with `eclipseAutoExposure = true`, then the flag is
    // reset WITHOUT a re-render, so `Globe.beginFrame` never runs again and
    // the mirror is left holding `base * f_AE` — the CAMERA-mode factor. The
    // comparison then failed on a stale read while the engine was correct
    // (the executor's live trace confirmed the mirror is exactly `base * f_ON`
    // at this point). Read-after-render is the invariant; anything that
    // renders in between invalidates it.
    const engineMirror =
      scene.globe?._surface?.tileProvider?.atmosphereLightIntensity ?? null;

    // The factor the engine actually applied this rung, and whether this rung
    // is an eclipse at all (the clear rung has nothing to reproduce manually).
    const f = onState.factor;
    const isEclipsed =
      typeof onState.moonObscuration === "number" &&
      onState.moonObscuration > 0.01 &&
      typeof f === "number" &&
      f < 1;

    // S6 adds a physically separate horizon-twilight term at deep totality.
    // Keep the shipped/default-on ON capture above, but isolate that orthogonal
    // term for S2's manual-equivalence proof. This reference is still the real
    // engine path with eclipse dimming enabled; only S6's additive glow is off.
    // The dedicated totality probe independently requires that glow on both
    // backends, so this isolation cannot hide a missing S6 feature.
    let equivalentOnState = onState;
    let equivalentOnSky = onSky;
    let equivalentOnGround = onGround;
    let equivalentEngineMirror = engineMirror;
    let horizonTwilightIsolated = false;
    if (isEclipsed) {
      ac.lighting.enableEclipseHorizonTwilight = false;
      scene.render(T());
      equivalentOnState = readState();
      equivalentOnSky = bandStats(skyY0, skyY1);
      equivalentOnGround = bandStats(groundY0, groundY1, groundMask);
      equivalentEngineMirror =
        scene.globe?._surface?.tileProvider?.atmosphereLightIntensity ?? null;
      horizonTwilightIsolated = true;
      ac.lighting.enableEclipseHorizonTwilight = true;
      scene.render(T());
    }

    // ── 3. eclipse ON, ruling-E2 camera mode ──────────────────────────────
    ac.lighting.eclipseAutoExposure = true;
    scene.render(T());
    const aeState = readState();
    const aeSky = bandStats(skyY0, skyY1);
    const aeGround = bandStats(groundY0, groundY1, groundMask);
    ac.lighting.eclipseAutoExposure = false;

    // ── 4-5. BACKGROUND REVEAL: the same pinned state with the atmosphere
    // shell hidden, in BOTH toggle positions.
    //
    // WHY. The sky band is not the shell alone. The shell is composited with
    // ALPHA_BLEND over the skybox/star cubemap, and its alpha is
    // luminance-dependent (`mix(color.b, 1, heightOpacity)`), so as S2 dims
    // the shell the shell's own alpha falls and MORE of the background shows
    // through. The background is a legitimately un-dimmed, non-solar source —
    // starlight does not care about a solar eclipse, and a starrier totality
    // sky is physically correct (E3/S6 territory) — but the shell-only
    // prediction cannot model it, which is exactly the "L = f*L_sky + c"
    // additive signature the deep rungs showed.
    //
    // Hiding the shell gives `B`, the FULLY revealed background: an upper
    // bound on that additive term, since the composite can only ever show
    // `B*(1-alpha)` of it. Two captures rather than one so the probe can SEE
    // whether the background itself moves with the toggle. With the shell
    // hidden, current-frame atmosphere visibility disables the default-on star
    // modulation, so this is intentionally a full-strength control in both
    // toggle positions.
    // ── 4. THE EQUIVALENCE CAPTURE (R1) — S2's literal contract, model-free.
    //
    // Three rounds of physical modelling (display gamma, PBR-Neutral shoulder,
    // background reveal) each explained part of the sky band and each leaked
    // somewhere else; the round-3 data killed the last one outright
    // (`backgroundRevealExplains` false at every rung, `cRecovered` 3.5-42x
    // larger than the background could supply). The shell's response to
    // `atmosphereLightIntensity` is strongly SUB-LINEAR in the bright regime —
    // saturating scattering on top of the tonemap — and no closed-form
    // prediction is going to survive that.
    //
    // So stop predicting. S2's contract is not "the sky dims by f"; it is
    // "S2 applies exactly the factor the injection sites would apply if you
    // set them by hand". That is directly testable: render the SAME pinned
    // state with `enableEclipse` OFF and the factor applied MANUALLY through
    // the public surfaces, and require the two images to agree. Whatever
    // nonlinearities exist — tonemap, saturation, alpha reveal, sub-linear
    // scattering — apply IDENTICALLY to both paths and cancel exactly.
    //
    // Manual twin of each site:
    //   site 1  scene.light        -> SunLight(color = white * f, intensity 1)
    //   site 2  skyAtmosphere.atmosphereLightIntensity *= f
    //   site 3  globe.atmosphereLightIntensity *= f   (the tileProvider mirror
    //           follows automatically — VERIFIED below, not assumed)
    //   site 4  star modulation reproduced by re-solving its public curve
    //   site 5  N/A, no model in this scene
    let manualSky = null;
    let manualGround = null;
    let manualState = null;
    let mirrorMatches = null;
    let site4Record = null;
    if (isEclipsed) {
      const savedLight = scene.light;
      const savedSkyIntensity = scene.skyAtmosphere
        ? scene.skyAtmosphere.atmosphereLightIntensity
        : null;
      const savedGlobeIntensity = scene.globe
        ? scene.globe.atmosphereLightIntensity
        : null;
      // `engineMirror` was captured right after the ON render — see there.

      // SITE 4, modelled (C12-29 S6 / ruling E3 — see the guard at setup).
      // The engine path evaluates the star-modulation curve at `B * f`; with
      // the eclipse off the manual path sees `B`, so its inflection is
      // re-solved to make the curve return the identical factor at `B`.
      // `smoothstep` is monotone on [0,1], so the inverse is exact wherever
      // the target is strictly inside (0,1); at the clamped ends any
      // inflection on the correct side reproduces the endpoint exactly.
      const savedInflection = starCurve ? starCurve.inflection : null;
      let site4 = null;
      if (starModulation === true && starCurve) {
        const s = starCurve.steepness;
        const i0 = starCurve.inflection;
        const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
        const factorAt = (b) => {
          const t = clamp01((b - i0) * s);
          return 1 - t * t * (3 - 2 * t);
        };
        // Read the brightness from the isolated engine-reference frame.
        // Reading `scene.frameState` here would instead observe the intervening
        // auto-exposure render and mix its radiometric factor with `f` from the
        // earlier human-eye frame.
        const B = equivalentOnState.skyBrightness;
        // The engine's skyBrightness ALREADY carries `f`; divide it back out
        // to recover the un-eclipsed `B` the manual path will see.
        const bManual = typeof B === "number" && f > 0 ? B / f : null;
        const target = typeof B === "number" ? factorAt(B) : null;
        if (bManual !== null && target !== null) {
          // Invert `1 - smoothstep(0,1,t) = target` for t, then place the
          // inflection so `(bManual - i') * s == t`.
          let lo = 0;
          let hi = 1;
          for (let q = 0; q < 200; q++) {
            const mid = 0.5 * (lo + hi);
            const sm = mid * mid * (3 - 2 * mid);
            if (1 - sm > target) lo = mid;
            else hi = mid;
          }
          const tStar = 0.5 * (lo + hi);
          starCurve.inflection = bManual - tStar / s;
          site4 = {
            engineSkyBrightness: B,
            manualSkyBrightness: bManual,
            targetFactor: target,
            solvedInflection: starCurve.inflection,
          };
        }
      }

      ac.lighting.enableEclipse = false;
      scene.light = new C.SunLight({
        color: new C.Color(f, f, f, 1.0),
        intensity: BASE_LIGHT_INTENSITY,
      });
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.atmosphereLightIntensity = savedSkyIntensity * f;
      }
      if (scene.globe) {
        scene.globe.atmosphereLightIntensity = savedGlobeIntensity * f;
      }
      scene.render(T());
      // Verify the modelling produced the factor it was solved for, rather
      // than trusting the algebra: recompute from the manual frame's own
      // published `skyBrightness`.
      if (site4 && starCurve) {
        const bSeen = scene.frameState?.skyBrightness;
        const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
        const t = clamp01((bSeen - starCurve.inflection) * starCurve.steepness);
        site4.manualFactorSeen = 1 - t * t * (3 - 2 * t);
        site4.matches =
          Math.abs(site4.manualFactorSeen - site4.targetFactor) <= 1e-6;
      }
      manualState = readState();
      manualSky = bandStats(skyY0, skyY1);
      manualGround = bandStats(groundY0, groundY1, groundMask);
      const manualMirror =
        scene.globe?._surface?.tileProvider?.atmosphereLightIntensity ?? null;
      // Site 3 verification: the engine's dimmed mirror and the manual dimmed
      // mirror must be the same number, or the two paths are not comparable at
      // that site and the whole gate would be measuring the wrong thing.
      mirrorMatches =
        equivalentEngineMirror !== null && manualMirror !== null
          ? Math.abs(equivalentEngineMirror - manualMirror) <=
            1e-9 * Math.max(1, Math.abs(equivalentEngineMirror))
          : null;

      // Leak-proof restore, before anything else renders.
      scene.light = savedLight;
      if (scene.skyAtmosphere) {
        scene.skyAtmosphere.atmosphereLightIntensity = savedSkyIntensity;
      }
      if (scene.globe) {
        scene.globe.atmosphereLightIntensity = savedGlobeIntensity;
      }
      if (starCurve && savedInflection !== null) {
        starCurve.inflection = savedInflection;
      }
      ac.lighting.enableEclipseHorizonTwilight = true;
      manualState = manualState ?? null;
      if (site4) {
        site4.inflectionRestored =
          starCurve && starCurve.inflection === savedInflection;
      }
      site4Record = site4;
      ac.lighting.enableEclipse = true;
      scene.render(T());
    }

    const skyShown = scene.skyAtmosphere ? scene.skyAtmosphere.show : null;
    let bgSkyOff = null;
    let bgGroundOff = null;
    let bgSkyOn = null;
    let bgGroundOn = null;
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = false;

      ac.lighting.enableEclipse = false;
      scene.render(T());
      bgSkyOff = bandStats(skyY0, skyY1);
      bgGroundOff = bandStats(groundY0, groundY1, groundMask);

      ac.lighting.enableEclipse = true;
      scene.render(T());
      bgSkyOn = bandStats(skyY0, skyY1);
      bgGroundOn = bandStats(groundY0, groundY1, groundMask);

      scene.skyAtmosphere.show = skyShown;
      scene.render(T());
    }

    out.steps.push({
      iso: rung.iso,
      targetObscuration: rung.obscuration,
      sunElevationDeg: rung.sunElevationDeg,
      tilesLoaded,
      tilesToRender,
      terrainResponse,
      horizonPx,
      off: { state: offState, sky: offSky, ground: offGround },
      on: { state: onState, sky: onSky, ground: onGround },
      ae: { state: aeState, sky: aeSky, ground: aeGround },
      // Shell hidden — the fully revealed background. `sky` is the term the
      // shell-only prediction cannot model; `ground` is recorded as a
      // diagnostic only (with the shell off the ground band is still the lit
      // globe, not a background, so no correction is derived from it).
      bg: {
        off: { sky: bgSkyOff, ground: bgGroundOff },
        on: { sky: bgSkyOn, ground: bgGroundOn },
      },
      // R1 — the manual twin. Null on the clear rung (nothing to reproduce).
      manual: isEclipsed
        ? {
            engineReference: {
              state: equivalentOnState,
              sky: equivalentOnSky,
              ground: equivalentOnGround,
              horizonTwilightIsolated,
            },
            state: manualState,
            sky: manualSky,
            ground: manualGround,
            mirrorMatches,
            site4: site4Record,
          }
        : null,
      dimSky: offSky.mean > 0 ? onSky.mean / offSky.mean : null,
      dimGround: offGround.mean > 0 ? onGround.mean / offGround.mean : null,
      dimSkyAe: offSky.mean > 0 ? aeSky.mean / offSky.mean : null,
      dimGroundAe: offGround.mean > 0 ? aeGround.mean / offGround.mean : null,
    });
  }

  if (structuralError !== null) {
    out.structuralError = structuralError;
  }
  out.shots = shots;
  return out;
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
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(4000);

    out.ladder = await page.evaluate(LADDER, {
      lat: plan.lat,
      lon: plan.lon,
      ladder: plan.ladder,
    });

    // I3 — write the IN-TASK captures. A post-evaluate
    // `locator('canvas').screenshot()` is NOT equivalent here: by the time it
    // runs, the page has been restored to the live wall clock with no globe,
    // so it captures the default view and the visual lane ships empty. These
    // data URLs were read inside the same task as the render that produced
    // them, at the deepest rung, in both toggle positions.
    const shots = out.ladder?.shots ?? {};
    out.shotsWritten = [];
    for (const [key, dataUrl] of Object.entries(shots)) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
        continue;
      }
      const file = path.join(
        OUT_DIR,
        `eclipse-scene-dimming-${renderer}-${key}.png`,
      );
      fs.writeFileSync(
        file,
        Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
      );
      out.shotsWritten.push(file.replaceAll("\\", "/"));
    }
    // Drop the base64 payloads before the manifest is serialised.
    if (out.ladder) {
      delete out.ladder.shots;
    }

    const t = out.ladder && out.ladder.rendererType;
    if (t && t !== renderer) {
      out.backendMismatch = `requested ${renderer}, got ${t}`;
    }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
function judge(steps) {
  const v = {};
  v.terrainResponse = steps[0]?.terrainResponse ?? null;
  v.terrainResponsive =
    v.terrainResponse?.pass === true &&
    steps.every(
      (s) =>
        s.off.ground.sampleFraction >= 0.25 &&
        s.on.ground.sampleFraction >= 0.25 &&
        s.ae.ground.sampleFraction >= 0.25,
    );

  // Lane (c) — identity. The OFF position must publish EXACTLY 1.0.
  v.offFactorAllExactlyOne = steps.every((s) => s.off.state.factor === 1);
  v.toggleObserved = steps.every(
    (s) => s.off.state.enabled === false && s.on.state.enabled === true,
  );
  v.autoExposureFlagObserved = steps.every(
    (s) => s.on.state.autoExposure === false && s.ae.state.autoExposure === true,
  );
  // The physics must keep running with the effect OFF (that is the whole
  // point of gating application rather than computation).
  v.physicsRunsWhenOff = steps.every(
    (s) =>
      typeof s.off.state.moonObscuration === "number" &&
      Math.abs(s.off.state.moonObscuration - s.on.state.moonObscuration) < 1e-12,
  );

  // N1 — the two classes must PARTITION the rungs. A rung landing in the old
  // (1e-6, 0.01] gap belonged to neither, which turned `ladderNonVacuous` into
  // a false failure driven purely by ladder geometry. Anything in the gap is
  // now reported and made STRUCTURAL by the caller — a rung that is neither
  // clearly clear nor clearly eclipsed is a broken fixture, not a verdict.
  const eclipsed = steps.filter((s) => s.on.state.moonObscuration > 0.01);
  const clear = steps.filter((s) => s.on.state.moonObscuration <= 1e-6);
  v.unclassifiedRungs = steps
    .filter(
      (s) =>
        s.on.state.moonObscuration > 1e-6 && s.on.state.moonObscuration <= 0.01,
    )
    .map((s) => ({ iso: s.iso, obscuration: r6(s.on.state.moonObscuration) }));
  v.rungsPartition = v.unclassifiedRungs.length === 0;
  v.ladderNonVacuous = eclipsed.length >= 3 && clear.length >= 1;
  v.deepestObscuration = steps.reduce(
    (m, s) => Math.max(m, s.on.state.moonObscuration ?? 0),
    0,
  );

  // Injection site 1, end to end: `lightColorHdr` must equal
  // `light.color * light.intensity * factor` on both backends. Reported per
  // step so a backend that silently drops the multiply is visible even if
  // its pixels happen to land inside a band.
  const hdrCheck = (s, which) => {
    const st = s[which].state;
    if (
      st.lightColorHdrX === null ||
      st.lightRawRed === null ||
      st.lightIntensity === null
    ) {
      return null;
    }
    const expected = st.lightRawRed * st.lightIntensity * st.factor;
    // `lightColorHdr` is f32-packed nowhere on the JS side, so f64 relative
    // agreement is the right bar.
    return Math.abs(st.lightColorHdrX - expected) <=
      1e-9 * Math.max(1, Math.abs(expected))
      ? true
      : { got: st.lightColorHdrX, expected };
  };
  v.lightUniformCarriesFactor = steps.every(
    (s) => hdrCheck(s, "on") === true && hdrCheck(s, "off") === true,
  );
  v.lightUniformSamples = steps.map((s) => ({
    iso: s.iso,
    on: r6(s.on.state.lightColorHdrX),
    off: r6(s.off.state.lightColorHdrX),
    factor: r6(s.on.state.factor),
  }));

  // The zero-obscuration rung must render the same picture in both positions.
  v.clearStepIdentity = clear.every(
    (s) =>
      s.on.state.factor === 1 &&
      Math.abs(s.dimSky - 1) < 5e-3 &&
      Math.abs(s.dimGround - 1) < 5e-3,
  );

  // Absolute sanity floors — a blank or blown-out canvas cannot pass. The
  // UPPER bound matters as much as the lower one here: on a band whose
  // un-dimmed mean is already pinned against 1.0, the tonemap shoulder is so
  // flat that `predictDim` returns ~1 for any factor and the bracket below
  // becomes vacuous. Such a band is an unusable instrument, not a pass.
  v.sanityFloors = steps.every(
    (s) =>
      s.off.sky.mean > 0.08 &&
      s.off.sky.mean < 0.99 &&
      s.off.ground.mean > 0.02 &&
      s.off.ground.mean < 0.99 &&
      s.off.sky.saturated < 0.5 &&
      s.off.ground.saturated < 0.5,
  );

  // Lane (a) — monotone tracking. Sorted by DESCENDING published factor, both
  // measured dim series must be non-increasing (2% slack for tile/dither
  // noise). Ratios, so the sun-elevation differences between rungs cancel.
  const byFactor = [...steps].sort((a, b) => b.on.state.factor - a.on.state.factor);
  const monotone = (key) => {
    let worstRise = 0;
    for (let i = 1; i < byFactor.length; i++) {
      const rise = byFactor[i][key] - byFactor[i - 1][key];
      if (rise > worstRise) {
        worstRise = rise;
      }
    }
    return worstRise;
  };
  v.worstRiseSky = monotone("dimSky");
  v.worstRiseGround = monotone("dimGround");
  v.monotoneSky = v.worstRiseSky <= 0.02;
  v.monotoneGround = v.worstRiseGround <= 0.02;

  // Lane (a) — the physical bracket, derived THROUGH the display transform.
  //
  // The naive `[f, f^(1/2.2)]` bracket is wrong on this path and produced
  // false failures at bright rungs: the sky (and the globe's atmosphere/fog
  // drape) run through Khronos PBR-Neutral tonemapping plus an inverse gamma
  // on the default LDR path, and that shoulder is compressive, so a linear
  // multiply of `f` measures ABOVE `f^(1/2.2)` whenever the un-dimmed band
  // sits on the shoulder (e.g. scene-linear ~2.0 with f = 0.216 measures
  // ~0.68 against a 0.56 bound). `predictDim` inverts gamma, inverts
  // PBR-Neutral, scales by `f`, and pushes the result back out through the
  // same transform, so the prediction tracks the shoulder by construction.
  //
  // The bands around the prediction absorb the one honest approximation —
  // applying a per-pixel nonlinearity to a band MEAN — plus tile dither. The
  // ground band is allowed a wider upper margin because it also carries
  // ambient and base-colour terms the eclipse does not scale.
  // THE SKY BAND IS NOT THE SHELL ALONE. It is `shell*alpha + B*(1-alpha)`,
  // composited in display space, where `B` is the skybox/star cubemap and the
  // shell's alpha is luminance-dependent (`mix(color.b, 1, heightOpacity)`).
  // As S2 dims the shell its alpha falls, so MORE un-dimmed background shows
  // through — an additive term the shell-only `predictDim` cannot model, and
  // exactly the `L = f*L_shell + c` signature the deep rungs showed. The stars
  // are NOT the bug: a starrier totality sky is physically correct, and
  // dimming them to make a prediction fit would be falsifying the instrument.
  //
  // So the prediction becomes a BRACKET over the unknown revealed fraction,
  // using the MEASURED fully-revealed background `B` (shell hidden) as the
  // upper bound on it. With `S` the shell's display contribution at f = 1 and
  // `c` in [0, B] the un-dimmed part:
  //   M_off = S + c ,  M_on = r(S)*S + c   where r = predictDim on the SHELL
  //   c = 0  ->  dim = predictDim(M_off, f)                      (lower)
  //   c = B  ->  dim = [predictDim(M_off-B, f)*(M_off-B) + B]/M_off  (upper)
  // The prediction is monotone in `c` (r < 1), so those really are the ends.
  //
  // It is falsifiable: `cRecovered` is solved back out of the measurement by
  // bisection, and `backgroundRevealExplains` says whether it fits inside the
  // measured B. If it does not, the reveal hypothesis is WRONG and something
  // else is adding light — which is what the report will then say, rather than
  // the gate quietly widening until it passes.
  const predictWithBackground = (meanOff, f, background) => {
    const b = Math.min(Math.max(background ?? 0, 0), meanOff);
    const shellOff = meanOff - b;
    const r = predictDim(shellOff, f);
    if (r === null) {
      return null;
    }
    return (r * shellOff + b) / meanOff;
  };
  // Bisect the un-dimmed component that reproduces the measured ratio.
  const recoverC = (meanOff, meanOn, f) => {
    if (!(meanOff > 0) || !(meanOn > 0)) {
      return null;
    }
    let lo = 0;
    let hi = meanOff;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const pred = predictWithBackground(meanOff, f, mid);
      if (pred === null) {
        return null;
      }
      if (pred * meanOff < meanOn) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return 0.5 * (lo + hi);
  };

  const bracket = [];
  for (const s of eclipsed) {
    const f = s.on.state.factor;
    // Use the eclipse-ON background: it is what is actually behind the shell
    // in the ON capture. (`bg.off` is reported so a moving background is
    // visible; at defaults the two must agree.)
    const bSky = s.bg?.on?.sky?.mean ?? null;
    const predSkyLow = predictDim(s.off.sky.mean, f);
    const predSkyHigh =
      bSky === null ? predSkyLow : predictWithBackground(s.off.sky.mean, f, bSky);
    const predGround = predictDim(s.off.ground.mean, f);
    const cRecovered = recoverC(s.off.sky.mean, s.on.sky.mean, f);
    bracket.push({
      iso: s.iso,
      factor: r6(f),
      dimSky: r3(s.dimSky),
      predictedSkyShellOnly: r3(predSkyLow),
      predictedSkyWithBackground: r3(predSkyHigh),
      backgroundSkyOn: r3(bSky),
      backgroundSkyOff: r3(s.bg?.off?.sky?.mean),
      cRecovered: r3(cRecovered),
      // The falsifiable claim: the un-dimmed component the measurement implies
      // must be no larger than the background that is physically available.
      cOverBackground:
        bSky !== null && bSky > 0 && cRecovered !== null
          ? r3(cRecovered / bSky)
          : null,
      backgroundRevealExplains:
        bSky !== null && cRecovered !== null
          ? cRecovered <= bSky * 1.15 + 0.005
          : null,
      dimGround: r3(s.dimGround),
      predictedGround: r3(predGround),
      skyInBracket:
        predSkyLow !== null &&
        predSkyHigh !== null &&
        s.dimSky >= predSkyLow * 0.75 &&
        s.dimSky <= Math.min(1.0, predSkyHigh * 1.15 + 0.02),
      groundInBracket:
        predGround !== null &&
        s.dimGround >= predGround * 0.5 &&
        s.dimGround <= Math.min(1.0, predGround * 1.25 + 0.05),
    });
  }
  // ── R1: THE GATE IS EQUIVALENCE, NOT PREDICTION ──────────────────────────
  //
  // Everything above (`predictDim`, `cRecovered`, `backgroundRevealExplains`,
  // the brackets) is now REPORTED-ONLY. Three rounds of physical modelling
  // each explained part of the sky band and each leaked elsewhere; round 3
  // killed the background-reveal hypothesis outright — `cRecovered` came back
  // 3.5-42x larger than the background could supply, on both backends at every
  // rung. What that data actually says is that the shell's response to
  // `atmosphereLightIntensity` is strongly SUB-LINEAR in the bright regime
  // (rung 1: factor 0.866 moved the sky only to 0.986), i.e. saturating
  // scattering stacked on the tonemap. No closed form survives that, and each
  // round of widening a predictive bound is a round of the gate learning less.
  //
  // The equivalence gate tests S2's LITERAL contract instead: the eclipse path
  // must produce the same image as setting the same factor by hand through the
  // injection sites' public surfaces. Model-free by construction — every
  // nonlinearity applies identically to both paths and cancels exactly.
  //
  // CALIBRATION EVIDENCE (fleet practice: record it in-file). The band opened
  // at relative 2% + absolute 0.005 as a first-run estimate, with an in-file
  // invitation to tighten it once measured. IT HAS NOW BEEN MEASURED, on the
  // terminal Edge cycle (2026-07-24, both backends, every eclipsed rung):
  //
  //   WebGL   worst relative deviation  5.876e-7   (sky band, deepest rung)
  //   WebGPU  worst relative deviation  0          — BIT-IDENTICAL, 8 of 8 bands
  //
  // WebGPU coming back bit-identical is the strong form of the result: the
  // engine path and the hand-applied path produce the same bytes, which is
  // exactly what "S2 applies the factor the sites would apply by hand" means
  // in the limit. WebGL's 5.876e-7 is the expected residue — the two paths
  // differ only by IEEE multiply ORDER (site 1 dims `color*intensity`
  // post-clamp while the manual twin scales `color` pre-multiply; ~1e-14
  // relative, separately pinned in `eclipse-scene-dimming.spec.mjs`), plus f32
  // rounding once the value reaches a uniform, plus 8-bit quantisation of the
  // band mean (<= 1/255 per pixel, averaged over ~200k pixels).
  //
  // Tightened accordingly to relative 1e-4 + absolute 1e-5: still >100x
  // headroom over the measured worst case, and 200x tighter than the opening
  // estimate. A future run that exceeds this is a real divergence between the
  // two paths, not instrument noise.
  const EQUIV_REL = 1.0e-4;
  const EQUIV_ABS = 1.0e-5;
  const equivalence = [];
  for (const s of eclipsed) {
    const m = s.manual;
    if (
      !m ||
      !m.sky ||
      !m.ground ||
      !m.engineReference?.sky ||
      !m.engineReference?.ground
    ) {
      equivalence.push({ iso: s.iso, ok: false, reason: "no manual capture" });
      continue;
    }
    const cmp = (engine, manual) => {
      const rel =
        manual > 0 ? Math.abs(engine - manual) / manual : Math.abs(engine - manual);
      return {
        engine: r3(engine),
        manual: r3(manual),
        rel: r3(rel),
        ok: Math.abs(engine - manual) <= EQUIV_REL * manual + EQUIV_ABS,
      };
    };
    const sky = cmp(m.engineReference.sky.mean, m.sky.mean);
    const ground = cmp(m.engineReference.ground.mean, m.ground.mean);
    equivalence.push({
      iso: s.iso,
      factor: r6(s.on.state.factor),
      // The manual path must have run with the effect OFF and an identity
      // factor, or it is not an independent reproduction.
      manualFactorIsOne: m.state?.factor === 1,
      manualToggleOff: m.state?.enabled === false,
      horizonTwilightIsolated:
        m.engineReference?.horizonTwilightIsolated === true,
      // Site 3's mirror must carry the same number down both paths.
      mirrorMatches: m.mirrorMatches,
      // Site 4 (C12-29 S6 / ruling E3): live since the star-modulation default
      // flipped on, so it is MODELLED rather than excluded. The manual twin
      // re-solves the curve inflection to hand the cubemap shader the same
      // factor the engine's `skyBrightness * f` produces, and the solve is
      // verified from the manual frame's own published brightness. `null` when
      // the modulation is off, where the old inert-exclusion still holds.
      site4Modelled: m.site4 === null ? null : m.site4?.matches === true,
      site4InflectionRestored:
        m.site4 === null ? null : m.site4?.inflectionRestored === true,
      site4: m.site4,
      sky,
      ground,
      ok:
        sky.ok &&
        ground.ok &&
        m.state?.factor === 1 &&
        m.state?.enabled === false &&
        m.engineReference?.horizonTwilightIsolated === true &&
        m.mirrorMatches !== false &&
        // Site 4 must have been modelled successfully whenever it is live.
        // `null` (modulation off) keeps the historical inert-exclusion path.
        (m.site4 === null || m.site4?.matches === true) &&
        (m.site4 === null || m.site4?.inflectionRestored === true),
    });
  }
  v.equivalence = equivalence;
  v.equivalenceOk =
    equivalence.length > 0 && equivalence.every((e) => e.ok === true);
  v.equivalenceWorstRel = equivalence.reduce(
    (m, e) => Math.max(m, e.sky?.rel ?? 0, e.ground?.rel ?? 0),
    0,
  );
  v.equivalenceTolerance = { relative: EQUIV_REL, absolute: EQUIV_ABS };

  // ── Reported-only diagnostics, kept because they DOCUMENT the physics ────
  v.bracket = bracket;
  v.skyBracketOkReportedOnly = bracket.every((b) => b.skyInBracket);
  v.groundBracketOkReportedOnly = bracket.every((b) => b.groundInBracket);
  // Round-3 verdict, retained so the next reader does not re-run the same
  // three modelling rounds: FALSE here means the sky's excess brightness is
  // NOT background reveal — it is the shell's sub-linear response.
  v.backgroundRevealExplainsAll = bracket.every(
    (b) => b.backgroundRevealExplains !== false,
  );
  // The background itself must not move with the eclipse toggle while the
  // atmosphere is hidden. Current-frame visibility disables the default-on
  // star modulation in both captures; a difference would therefore be a real
  // state leak between the two paths.
  v.backgroundIsToggleInvariant = eclipsed.every((s) => {
    const a = s.bg?.off?.sky?.mean;
    const b = s.bg?.on?.sky?.mean;
    return a === null || b === null || a === undefined || b === undefined
      ? true
      : Math.abs(a - b) <= 0.005;
  });

  // The deepest rung must dim VISIBLY, not by a rounding error.
  const deepest = byFactor[byFactor.length - 1];
  v.deepest = {
    iso: deepest.iso,
    factor: r6(deepest.on.state.factor),
    dimSky: r3(deepest.dimSky),
    dimGround: r3(deepest.dimGround),
    onSkyMean: r3(deepest.on.sky.mean),
    onGroundMean: r3(deepest.on.ground.mean),
  };
  v.deepestDimsVisibly = deepest.dimSky < 0.9 && deepest.dimGround < 0.95;

  // Lane (b) — the curve and the floor.
  //
  // The published factor is checked against the CURVE PREDICTION at the
  // measured obscuration, at every rung and in both E2 modes. That tests the
  // transfer everywhere instead of only at the endpoint, and it removes the
  // algebra error the previous shape carried: the curve reaches the floor
  // exactly at obscuration 1.0 and nowhere below it (0.995 -> 0.1716,
  // 0.9999 -> 0.0531), so demanding "== floor" anywhere in [0.995, 1) was a
  // guaranteed false failure — and that zone is reachable, because the in-page
  // locator is a uniform disc while the engine is limb-darkened and 10-second
  // stepping can straddle second contact.
  const curveMisses = [];
  for (const s of steps) {
    const o = s.on.state.moonObscuration;
    const wantEye = predictFactor(o, false);
    const wantCam = predictFactor(s.ae.state.moonObscuration, true);
    if (Math.abs(s.on.state.factor - wantEye) > 1e-9) {
      curveMisses.push({
        iso: s.iso,
        mode: "eye",
        obscuration: r6(o),
        got: r6(s.on.state.factor),
        want: r6(wantEye),
      });
    }
    if (Math.abs(s.ae.state.factor - wantCam) > 1e-9) {
      curveMisses.push({
        iso: s.iso,
        mode: "camera",
        obscuration: r6(s.ae.state.moonObscuration),
        got: r6(s.ae.state.factor),
        want: r6(wantCam),
      });
    }
  }
  v.curveMisses = curveMisses;
  v.curveMatchesPrediction = curveMisses.length === 0;

  v.floorRespected = steps.every(
    (s) => s.on.state.factor >= EXPECTED_TWILIGHT_FLOOR - 1e-12,
  );
  // Only obscuration EXACTLY 1.0 is on the floor. Reported when reached; never
  // required, because whether the ladder's maximum rung is total depends on
  // the vantage, not on the engine.
  const total = steps.filter((s) => s.on.state.moonObscuration >= 1.0);
  v.reachedTotality = total.length > 0;
  v.floorExactAtTotality =
    !v.reachedTotality ||
    total.every(
      (s) => Math.abs(s.on.state.factor - EXPECTED_TWILIGHT_FLOOR) < 1e-12,
    );
  v.notBlackAtDeepest =
    deepest.on.sky.mean > 0.004 && deepest.on.ground.mean > 0.004;

  // Lane (d) — ruling E2's camera mode publishes the LINEAR radiometric
  // factor, strictly below the eye-adapted default, and renders darker.
  // Ground comparisons use only the base-color-responsive terrain mask proven
  // above; an absent WebGPU globe can no longer pass by measuring shell/stars
  // in a nominally "ground" rectangle. A tiny mean tolerance covers floating
  // accumulation only, and a separate non-vacuity condition requires material
  // dimming in both bands.
  v.aeFactorStrictlyLower = eclipsed.every(
    (s) => s.ae.state.factor < s.on.state.factor - 1e-9,
  );
  v.aeIdentityWhenClear = clear.every((s) => s.ae.state.factor === 1);
  const aeLuminanceTolerance = 1e-4;
  v.aeLuminanceTolerance = aeLuminanceTolerance;
  v.aeRendersDarker = eclipsed.every(
    (s) =>
      s.ae.sky.mean <= s.on.sky.mean + aeLuminanceTolerance &&
      s.ae.ground.mean <= s.on.ground.mean + aeLuminanceTolerance,
  );
  v.aeDimmingNonVacuous =
    eclipsed.some((s) => s.on.sky.mean - s.ae.sky.mean > 0.02) &&
    eclipsed.some((s) => s.on.ground.mean - s.ae.ground.mean > 0.005);

  v.PASS =
    v.offFactorAllExactlyOne &&
    v.toggleObserved &&
    v.autoExposureFlagObserved &&
    v.physicsRunsWhenOff &&
    v.ladderNonVacuous &&
    v.terrainResponsive &&
    v.clearStepIdentity &&
    v.sanityFloors &&
    v.lightUniformCarriesFactor &&
    v.monotoneSky &&
    v.monotoneGround &&
    v.equivalenceOk &&
    v.backgroundIsToggleInvariant &&
    v.deepestDimsVisibly &&
    v.curveMatchesPrediction &&
    v.floorRespected &&
    v.floorExactAtTotality &&
    v.notBlackAtDeepest &&
    v.aeFactorStrictlyLower &&
    v.aeIdentityWhenClear &&
    v.aeRendersDarker &&
    v.aeDimmingNonVacuous;
  return v;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prov = provenance();
  if (!prov.ok) {
    console.error(
      "[probe-eclipse-scene-dimming] PROVENANCE FAILURE — stale or missing build:",
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
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    derived = await derivePage.evaluate(DERIVE_ECLIPSE_LADDER, {
      fixedTargets: LADDER_TARGETS,
    });
    await deriveContext.close().catch(() => {});
    if (!derived || derived.structuralError) {
      console.error(
        "[probe-eclipse-scene-dimming] ladder derivation failed:",
        JSON.stringify(derived),
      );
      await browser.close().catch(() => {});
      process.exit(2);
    }
    // Rung separation is validated HERE, on the returned data, so the failure
    // names the offending pair and the predicate that rejected it.
    const separation = validateLadderSeparation(derived.ladder);
    if (!separation.ok) {
      console.error(
        "[probe-eclipse-scene-dimming] ladder derivation failed:",
        JSON.stringify({ ...separation, derived }, null, 2),
      );
      await browser.close().catch(() => {});
      process.exit(2);
    }
    console.log(
      `2026-08-12 ladder @ ${derived.region} (${r3(derived.lat)}, ${r3(derived.lon)}), ` +
        `regional peak ${r3(derived.peakObscuration)} at ${derived.peakIso}:`,
    );
    for (const rung of derived.ladder) {
      console.log(
        `  ${rung.iso}  obscuration ${r3(rung.obscuration)}  sunElev ${r3(rung.sunElevationDeg)} deg`,
      );
    }

    const plan = {
      lat: derived.lat,
      lon: derived.lon,
      ladder: derived.ladder,
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
    if (!side.ladder || side.ladder.structuralError || !side.ladder.steps) {
      structural = true;
    } else if (side.ladder.steps.length < 4) {
      structural = true;
    }
  }

  const verdicts = {};
  let anyFail = false;
  const structuralReasons = [];
  if (structural) {
    structuralReasons.push("backend run failed or returned too few rungs");
  }
  if (!structural) {
    for (const [name, side] of [
      ["webgl", gl],
      ["webgpu", gpu],
    ]) {
      verdicts[name] = judge(side.ladder.steps);
      verdicts[name].rendererType = side.ladder.rendererType;
      verdicts[name].icrfBranch = side.ladder.icrfBranch;
      verdicts[name].consoleErrors = side.consoleErrors.slice(0, 5);
      // N1 — a rung that is neither clearly clear nor clearly eclipsed is a
      // broken FIXTURE, not a verdict about the engine. Escalate, don't fail.
      if (!verdicts[name].rungsPartition) {
        structural = true;
        structuralReasons.push(
          `${name}: rungs in the unclassified (1e-6, 0.01] obscuration gap: ` +
            JSON.stringify(verdicts[name].unclassifiedRungs),
        );
      } else if (!verdicts[name].PASS) {
        anyFail = true;
      }
    }
  }

  if (!structural) {
    // Parity. The published factor is ONE CPU module, so it must agree to f64
    // precision; the measured dim ratios are two different shader stacks, so
    // they get a band. A disagreement in the MEASURED series is structural
    // information about the two sky/globe shaders, never a gate failure on
    // its own — the per-backend brackets above are what gate.
    //
    // N2 — but the factor comparison is only MEANINGFUL when both contexts
    // resolved the same Earth-orientation rotation. `Transforms` substitutes
    // the TEME pseudo-fixed matrix while the IAU2006 XYS data is still
    // loading, and the two disagree by ~0.3-0.4 deg in 2026 — larger than the
    // solar disc, so the obscuration (hence the factor) genuinely differs.
    // The settle loop cannot catch this: it only demands the sun direction
    // stop moving, which a stuck TEME frame satisfies perfectly. A branch
    // mismatch is a REFERENCE DISAGREEMENT about the fixture, so it is
    // classified structural rather than reported as an engine failure.
    const glBranch = gl.ladder.icrfBranch ?? [];
    const gpuBranch = gpu.ladder.icrfBranch ?? [];
    const branchesMatch =
      glBranch.length > 0 &&
      glBranch.length === gpuBranch.length &&
      glBranch.every((x, i) => x === gpuBranch[i]);

    const a = gl.ladder.steps;
    const b = gpu.ladder.steps;
    const n = Math.min(a.length, b.length);
    let maxFactorDelta = 0;
    let maxObscurationDelta = 0;
    let maxDimSkyDelta = 0;
    let maxDimGroundDelta = 0;
    for (let i = 0; i < n; i++) {
      maxFactorDelta = Math.max(
        maxFactorDelta,
        Math.abs(a[i].on.state.factor - b[i].on.state.factor),
      );
      maxObscurationDelta = Math.max(
        maxObscurationDelta,
        Math.abs(
          a[i].on.state.moonObscuration - b[i].on.state.moonObscuration,
        ),
      );
      maxDimSkyDelta = Math.max(
        maxDimSkyDelta,
        Math.abs(a[i].dimSky - b[i].dimSky),
      );
      maxDimGroundDelta = Math.max(
        maxDimGroundDelta,
        Math.abs(a[i].dimGround - b[i].dimGround),
      );
    }
    const parity = {
      icrfBranchWebGL: glBranch,
      icrfBranchWebGPU: gpuBranch,
      branchesMatch,
      maxObscurationDelta: r6(maxObscurationDelta),
      maxFactorDelta: r6(maxFactorDelta),
      maxDimSkyDelta: r3(maxDimSkyDelta),
      maxDimGroundDelta: r3(maxDimGroundDelta),
      // The CPU scalar is the gate — but only once the fixture is comparable.
      factorParity: branchesMatch ? maxFactorDelta < 1e-9 : null,
      dimSeriesAgree: maxDimSkyDelta < 0.15 && maxDimGroundDelta < 0.2,
    };
    verdicts.parity = parity;
    if (!branchesMatch) {
      structural = true;
      structuralReasons.push(
        "ICRF/TEME rotation branch differs between the two browser contexts — " +
          "the ephemerides are not comparable; re-run once earth-orientation " +
          "data is warm in both",
      );
    } else if (!parity.factorParity) {
      anyFail = true;
    }
  }

  const GATE = structural ? "STRUCTURAL" : anyFail ? "FAIL" : "PASS";
  const report = {
    probe: "probe-eclipse-scene-dimming",
    task: "C12-29 S2",
    provenance: {
      buildIsNewer: prov.buildIsNewer,
      entryFresh: prov.entryFresh,
      consideredFileCount: prov.consideredFileCount,
    },
    expectedTwilightFloor: r6(EXPECTED_TWILIGHT_FLOOR),
    structuralReasons,
    shotsWritten: {
      webgl: gl?.shotsWritten ?? [],
      webgpu: gpu?.shotsWritten ?? [],
    },
    derived,
    webgl: gl && gl.ladder ? gl.ladder.steps : gl,
    webgpu: gpu && gpu.ladder ? gpu.ladder.steps : gpu,
    verdicts,
    GATE,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "eclipse-scene-dimming-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ derived, verdicts, structuralReasons, GATE }, null, 2),
  );

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-eclipse-scene-dimming] STRUCTURAL:", e);
  process.exit(2);
});
