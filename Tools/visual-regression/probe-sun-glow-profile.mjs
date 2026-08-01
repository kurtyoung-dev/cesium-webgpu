#!/usr/bin/env node
// probe-sun-glow-profile.mjs — C12 SUN WAVE (C12-15 / C12-16 / C12-17) +
// C12-29 slice S4. Measures the sun billboard's RENDERED RADIAL LUMINANCE
// PROFILE on both backends, as a function of angular radius in SOLAR RADII,
// and discriminates WHY the WebGPU sun contributes nothing near the Earth
// limb.
//
// ─────────────────────────────────────────────────────────────────────────
// THE PHENOMENON (measured, on clean main at HEAD 764)
// ─────────────────────────────────────────────────────────────────────────
//   near-limb, WebGPU: partialGlowOffRawMax = 0 AND partialGlowOnRawMax = 0
//                      across all 13 partial steps
//   near-limb, WebGL:  3,082,817 / 2,937,038, bandTier primary-masked,
//                      ratio 0.491 == expected
//   OPEN SKY, WebGL:   glowOff 2,241,410
//   OPEN SKY, WebGPU:  glowOff 1,732,142   <- the WebGPU sun DOES render,
//                                             at 77% of WebGL's luminance
//
// So the sun renders at open sky and contributes exactly zero near the limb.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IS ALREADY ELIMINATED — do not spend a lane on these
// ─────────────────────────────────────────────────────────────────────────
// H-GEOM / H-FALLOFF / H-QUANT — EXCLUDED by the open-sky measurement above:
//   a mis-sized quad, a terminating falloff or an 8-bit tail would all show
//   at open sky too, and none of them can be geometry-selective at the limb.
//   Corroborated arithmetically (pinned in `solar-disc-model.spec.mjs`): at
//   the default glowFactor the bake's `radius` maps to solar radii as
//   `rho = radius * sqrt(2) * 11`, so the legacy falloff terminates at
//   8.556 R_sun and the rgba8unorm 1/255 floor bites only past 8.199 R_sun —
//   both OUTSIDE the 1.5x..6x annulus that measured zero, where the
//   billboard's alpha is 0.689 down to 0.161 (8-bit codes 176..41).
//
// "AN OPAQUE SKY SHELL OCCLUDES THE SUN" — ELIMINATED BY DRAW ORDER, from
//   source, by a concurrent fleet: the SUN IS BINNED AFTER THE ATMOSPHERE
//   (`SceneRenderer.js:348-357` carries its own note to that effect; the moon
//   is likewise injected by APPEND at :411-413, and the star field's binned
//   copy also lands after). Only the skyBox cubemap and an injected star copy
//   sit BEHIND the sky shell. A separate worker's finding that WebGPU
//   resolves the dynamic-atmosphere-lighting enum from
//   `frameState.atmosphere.dynamicLighting` (ships NONE = 0) — which makes
//   the WebGPU sky-shell alpha compute to exactly 1.0, a fully opaque shell —
//   therefore CANNOT hide the sun's glow. The resolved enum is still recorded
//   here as a cheap REPORTED diagnostic documenting scene state, but it is
//   not a hypothesis. **No sky or atmosphere file is touched by this probe or
//   by the changeset it gates.**
//
//   NOTE THE DISTINCTION THAT SURVIVES: draw order rules out the shell
//   OCCLUDING the sun; it does not rule out the shell (or the sunlit globe)
//   SATURATING the background the additive sun is blended onto — draw order
//   in fact enables that, since whatever draws first sets `dst`.
//
// ─────────────────────────────────────────────────────────────────────────
// ROUND-3: THE ZERO IS THE PHYSICS, AND THE RESIDUAL IS A BLEND ARTEFACT
// ─────────────────────────────────────────────────────────────────────────
// The round-2 Edge run settled it. `frameState.sunAtmosphereExtinction` is
// computed BACKEND-AGNOSTICALLY in `Sun.js` before the branch point, and the
// probe read BYTE-IDENTICAL values on both backends at all five near-limb
// steps: [0.723, 0.467, 0.190] at −19.0°, and [0, 0, 0] (< 5e-4/channel) at
// every step below it. Both backends multiply the billboard's RGB by it
// (`SunFS.glsl`: `out_FragColor.rgb *= u_atmosphereExtinction`;
// `WebGPUEnvironmentRenderer.js:116`: `color.rgb * u.extinction`, fed from
// the same field). Extinction 0 => a BLACK billboard.
//
//   ** WEBGPU'S ZERO IS THE PHYSICS EXECUTING CORRECTLY. The sun is
//      genuinely extinguished at those elevations on BOTH backends. **
//
// So the question inverts: why does WEBGL measure a residual where its own
// billboard is arithmetically black? Two candidate mechanisms, and they are
// separated by the SIGN of the difference, which this probe now records:
//
//   (A) BLEND DIVERGENCE — the arithmetic, and the leading hypothesis.
//       WebGL's sun draws with `BlendingState.ALPHA_BLEND` (`Sun.js`), i.e.
//         out = src.rgb·src.a + dst·(1 − src.a)
//       With src.rgb == 0 that is `out = dst·(1 − a)`: the black billboard
//       DARKENS the sky by `a·dst`. It is not a no-op — it paints a black
//       disc+halo. WebGPU blends additively (`src-alpha`/`one`):
//         out = src.rgb·src.a + dst = dst + 0 = dst
//       an EXACT identity. Predicted signature: WebGL's signed delta is
//       strongly NEGATIVE at the extinction-0 steps with magnitude
//       proportional to the background, WebGPU's is exactly 0. This already
//       explains every round-2 observation without any extra mechanism: the
//       residual appears exactly where the billboard is black (because it is
//       black), tracks `bgMean` (it IS `a·bg`), collapses to 0 at −22.6°
//       (no billboard drawn at all there), and at the one non-extinguished
//       step makes WebGPU read 120% of WebGL (additive measures `a·src`,
//       alpha-blend measures `a·(src − dst)`, and dst > 0).
//
//   (B) WEBGL-ONLY SUN BLOOM — the previously inferred mechanism.
//       `EnvironmentRenderer.js:43-58` runs a bright-pass+blur+copy and
//       `FramebufferOrchestrator.js:49-53` redirects the framebuffer.
//       Predicted signature: POSITIVE signed delta (bloom ADDS light).
//
// ** PREDICTION, STATED BEFORE THE RUN — (B) IS EXPECTED TO BE FALSIFIED. **
// Both of those sites are gated on `scene.sunBloom` (not on `isSunVisible`
// alone), and `Scene.sunBloom` is a plain public field (`Scene.js:564`) with
// no setter indirection. THIS PROBE ALREADY SET `scene.sunBloom = false`
// BEFORE ANY RENDER in the round-2 run that produced the residual, and so
// does `probe-eclipse-sun-fade` ("forced OFF in every lane"). So the bloom
// pass was already not executing when the residual was measured, and the
// bloom A/B added below should show NO collapse. Concretely:
//
//   predicted: bloomOffAnnulus ≈ bloomOnAnnulus on WebGL at the
//              extinction-0 steps (ratio within ~±20%), signed delta
//              NEGATIVE in both, and WebGPU unchanged and ~0 in both.
//   if instead the residual COLLAPSES with bloom off, then `sunBloom = false`
//              was not taking effect and THAT is the finding — the probe
//              reports `bloomMechanism: "bloom-confirmed"` and the blend
//              explanation must be withdrawn.
//   if the signed delta is POSITIVE, mechanism (A) is wrong regardless of
//              the toggle and the probe says so.
//
// This is the one link in the chain that was reasoned rather than measured,
// so it is now measured in BOTH directions (toggle A/B and sign), and the
// probe reports `context.supportsLegacySunBloom` per backend so the
// capability itself is on the record rather than assumed.
//
// ─────────────────────────────────────────────────────────────────────────
// THE REMAINING HYPOTHESES, AND HOW EACH IS SEPARATED
// ─────────────────────────────────────────────────────────────────────────
// A measured zero still admits: the sun contributed no fragments (never
// built, culled, or depth-clipped), `dst` was already 255 so an additive add
// is invisible, or — now — the billboard was genuinely black. Two earlier
// designs of this classifier got the first three wrong in ways that would
// have printed a confident wrong verdict. Both are recorded so they cannot
// come back:
//
//   M1 — testing H-OCCL before saturation is unsound WHEN THE SATURATOR IS
//        THE GLOBE. At the 400 km near-limb vantage the annulus pixels ARE
//        the sunlit Earth limb, and WebGPU's additive sun clamps them at 255
//        (probe-eclipse-sun-fade's own header documents exactly this). Under
//        that cause `sunDelta == 0` by SATURATION, yet hiding the globe
//        removes the saturator, so `sunDeltaNoGlobe` is large and
//        `globeFrac` is high — the H-OCCL signature, printed for a
//        saturation cause. FIX: the background-saturation branch is evaluated
//        FIRST, and the H-OCCL branch additionally REQUIRES low saturation.
//        The direct discriminator is `bgMean` / `bgSatFrac` measured INSIDE
//        the annulus WITH THE GLOBE PRESENT — i.e. lane L0, which every step
//        records.
//
//   M2 — `globe.show = false` does not vary one thing. It removes (a) the
//        only depth writer in the ROI, (b) the sunlit-limb saturator, AND
//        (c) the legacy sun cull: `SceneUtilities.getOccluder` returns
//        undefined when `!scene.globe?.show`, which disables
//        `Occluder.isBoundingSphereVisible` — and at these elevations
//        (−19.0..−22.6 against a −19.8° horizon) that cull is exactly
//        WebGL's own mechanism. A fully CULLED sun therefore also produces
//        "sunDeltaNoGlobe large when the globe is hidden". FIX: absence is
//        settled at STATE level, never by pixel differencing — per step, in
//        the SAME task right after the sun-SHOWN render (S1 learned that a
//        read after the sun-hidden render is corrupted), the probe records
//        `environmentState.isSunVisible`, whether a sun draw command exists,
//        and whether that command carries a bounding volume.
//
// LANES (each varies exactly one scene knob relative to L0):
//   L0 base       globe ON,  sky ON,  bloom OFF -> sunDelta, sunDeltaSigned, bg, bgSat
//   L1 sky-off    globe ON,  sky OFF, bloom OFF -> bgNoSky, bgSatNoSky
//   L2 globe-off  globe OFF, sky ON,  bloom OFF -> sunDeltaNoGlobe, bgNoGlobe, bgSatNoGlobe
//   L3 bloom-on   globe ON,  sky ON,  bloom ON  -> sunDeltaBloom, sunDeltaBloomSigned
//                 (near-limb vantage only; the requested A/B control)
//
// `scene.sun.show` IS NOT A SINGLE-VARIABLE LEVER ON WEBGL. It sets
// `environmentState.isSunVisible`, which gates the sun bloom pass as well as
// the billboard, so any sun measurement that leaves `sunBloom` at its default
// (TRUE) is toggling a whole-frame bright-pass+blur+copy along with the disc.
// Every lane here pins `sunBloom` explicitly, and L3 exists precisely to
// measure what that pin is worth.
//
// L1 IS A SATURATION-ATTRIBUTION LANE ONLY, not an occlusion lane (the
// occlusion reading is eliminated by draw order above). Its BACKGROUND
// statistics are clean — the sun is hidden in that capture, so the sun's own
// extinction is irrelevant to them. Its `sunDeltaNoSky` is NOT clean and is
// reported as a diagnostic with an explicit confound flag: `Sun.update` gates
// the sun's atmospheric extinction on `frameState.skyAtmosphereVisible`
// (= `scene.skyAtmosphere.show`), so hiding the shell also forces that
// extinction to identity — worth up to 1e5x in red at grazing geometry by the
// S4 measurements. It is never used to select a hypothesis.
//
// OUTCOME TABLE (what settles each hypothesis, and on which single lever):
//
//   hypothesis            settled by                  lever      signature
//   --------------------  --------------------------  ---------  ------------------------------------
//   H-ABSENT (not built)  STATE read, no pixels       none       commandBuiltSteps == 0
//   H-ABSENT (culled)     STATE read, no pixels       none       backendHasBV && cullFiredSteps == steps
//   H-SAT (any source)    L0 alone, evaluated FIRST   none       bgSat >= 0.5 or bgMean > 250
//   H-SAT-BY-GLOBE        L0 vs L2 backgrounds        globe      bgSat high in L0, bgSatNoGlobe low
//   H-SAT-BY-SKY          L0 vs L1 backgrounds        sky        bgSat high in L0, bgSatNoSky low
//   H-OCCL (depth clip)   L0 vs L2, SAT excluded      globe      bgSat LOW, sunDeltaNoGlobe large, globeFrac high
//   H-GEOM/FALLOFF/QUANT  open-sky control            none       ALREADY EXCLUDED (see above)
//   shell occlusion       source draw order           n/a        ALREADY ELIMINATED (SceneRenderer.js:348-357)
//
// ─────────────────────────────────────────────────────────────────────────
// GEOMETRY IS SELF-CONSISTENT BY CONSTRUCTION (the round-1 blocker)
// ─────────────────────────────────────────────────────────────────────────
// The first revision shipped viewport 1280x720 + fov 12 deg + maxRsun 12.0,
// which is arithmetically unsatisfiable: limbPx = 27.94 px, maxHalf =
// floor(0.45 * 720) = 324, and the in-page guard `half < maxRsun * limbPx`
// reduces to `324 < 335.28` — TRUE, so the probe exited 2 at step 0 on every
// run, forever, before reaching any fix-dependent code. (Generalised: at fov
// 12 the guard needs `H >= 0.5821 * W`, i.e. aspect <= 1.718, while 1280x720
// is 1.778. The sibling sun-fade probe survives only because it needs
// 6.5 * limbPx = 182 px, not 12 * limbPx.) Even relaxed, the ROI would have
// reached only 11.60 R_sun — BELOW this probe's own 11.75 R_sun support gate,
// so part of the acceptance band was unmeasurable.
//
// The fix is a self-consistent set (fov widened 12 -> 20 deg, which SHRINKS
// limbPx; narrowing the fov would have made it worse), plus two structural
// guards so the class cannot ship again: `roiFeasibility()` below is a pure
// function evaluated over the perihelion..aphelion distance range BEFORE the
// browser launches, and `solar-disc-model.spec.mjs` extracts both the
// constants block and that function VERBATIM and asserts satisfiability in
// `node --test`.
//
// PROBE RULES (fleet convention): useDefaultRenderLoop killed; EVERY
// scene.render(t) gets the pinned time; bounded sun-direction settle loop;
// canvas capture in the SAME task as its render; canvas ELEMENT screenshots
// (locator('canvas'), never page.screenshot); rendererType recorded +
// hard-fail on mismatch; absolute sanity floors; unref'd force-exit
// watchdog; try/finally close; bounded loops; hard exit codes (0 pass /
// 1 gate fail / 2 structural). Provenance: numeral-free source markers must
// appear VERBATIM in a bundle newer than every touched source file, and a
// MISSING source file degrades provenance to a reported failure instead of
// throwing, so a PRE (pre-fix) baseline run is always possible. EVERY helper
// used inside a page.evaluate callback is defined INSIDE it.
//
// The WebGL-vs-WebGPU divergence is reported as STRUCTURAL, never gated: it
// is the subject under investigation, and a diagnostic that fails on its own
// phenomenon cannot report it.
//
// No GPU-timing claim is made anywhere in this probe, so the interleaved
// bundle-swap A/B protocol does not apply.
//
// Usage: node Tools/visual-regression/probe-sun-glow-profile.mjs
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
    "[probe-sun-glow-profile] WATCHDOG FIRED (420s) — forcing exit",
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const r3 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1000) / 1000;

// ==BEGIN PROBE_CONSTANTS== (extracted VERBATIM by solar-disc-model.spec.mjs)
const PROBE_CONSTANTS = {
  // Viewport kept at the sibling sun-fade probe's 1280x720 so the two
  // probes' orbital geometry stays directly comparable.
  viewportWidth: 1280,
  viewportHeight: 720,
  // HORIZONTAL fov (Cesium's PerspectiveFrustum.fov is horizontal whenever
  // width > height). 20 deg, not 12: a WIDER fov shrinks limbPx, which is
  // the direction that makes the ROI fit.
  fovDeg: 20.0,
  // Radial extent of the measured profile, in solar radii.
  maxRsun: 12.0,
  // Extra ROI half-extent requested beyond maxRsun so the outermost bin is
  // fully populated rather than clipped by the ROI edge.
  roiMarginRsun: 0.5,
  // Below this the projected disc is too small for a meaningful profile.
  minLimbPx: 6,
  binWidthRsun: 0.5,
  // A bin counts as "carrying signal" at or above this mean luminance in the
  // sun-on minus sun-off difference image.
  supportFloorLum: 0.5,
  // C12-16 acceptance band for the open-sky support radius. Pre-fix
  // expectation ~8.25 (legacy terminates at 8.556 R_sun); post-fix ~10.75
  // (the Lorentzian reaches the billboard's inscribed circle at 11.0).
  supportGateLoRsun: 9.5,
  supportGateHiRsun: 11.75,
  // Earth-Sun distance range the ROI must remain feasible across.
  sunDistanceMinM: 1.471e11,
  sunDistanceMaxM: 1.521e11,
};
// ==END PROBE_CONSTANTS==

// ==BEGIN roiFeasibility== (extracted VERBATIM by solar-disc-model.spec.mjs)
// Pure mirror of the in-page ROI arithmetic. Returns the geometry a run
// WOULD produce plus every reason it would be rejected, so an unsatisfiable
// constant set is caught in `node --test` and again before the browser
// launches — never at step 0 of a browser run.
function roiFeasibility(k, sunDistanceMeters) {
  const SOLAR_RADIUS = 6.955e8;
  const aspect = k.viewportWidth / k.viewportHeight;
  const fov = (k.fovDeg * Math.PI) / 180.0;
  // Cesium: fovy = 2*atan(tan(fov/2)/aspect) when aspect > 1, else fov.
  const tanHalfFovY =
    aspect > 1.0 ? Math.tan(fov * 0.5) / aspect : Math.tan(fov * 0.5);
  const angHalf = SOLAR_RADIUS / sunDistanceMeters;
  const limbPx = (angHalf / tanHalfFovY) * (k.viewportHeight * 0.5);
  const maxHalf = Math.floor(
    0.45 * Math.min(k.viewportWidth, k.viewportHeight),
  );
  const half = Math.min(
    Math.ceil((k.maxRsun + k.roiMarginRsun) * limbPx),
    maxHalf,
  );
  const roiRsun = half / limbPx;
  const reasons = [];
  if (!(limbPx >= k.minLimbPx)) {
    reasons.push(`limbPx ${limbPx.toFixed(2)} < minLimbPx ${k.minLimbPx}`);
  }
  if (half < k.maxRsun * limbPx) {
    reasons.push(
      `half ${half} < maxRsun*limbPx ${(k.maxRsun * limbPx).toFixed(2)} ` +
        `(maxHalf ${maxHalf} clamps the ROI below the requested extent)`,
    );
  }
  if (2 * half + 1 > Math.min(k.viewportWidth, k.viewportHeight)) {
    reasons.push(`ROI ${2 * half + 1}px does not fit the viewport`);
  }
  if (roiRsun < k.supportGateHiRsun) {
    reasons.push(
      `ROI reaches only ${roiRsun.toFixed(2)} R_sun, below the ` +
        `supportGateHiRsun ${k.supportGateHiRsun} the gate must be able to measure`,
    );
  }
  return {
    limbPx,
    maxHalf,
    half,
    roiRsun,
    feasible: reasons.length === 0,
    reasons,
  };
}
// ==END roiFeasibility==

// ── Provenance ──────────────────────────────────────────────────────────────
const SOURCE_FILES = [
  "packages/engine/Source/Scene/SolarDiscModel.js",
  "packages/engine/Source/Scene/SunDiscAppearance.js",
  "packages/engine/Source/Scene/computeSolarObscuration.js",
  "packages/engine/Source/Scene/Sun.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Shaders/SunTextureFS.glsl",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
];

// Numeral-FREE markers on purpose: esbuild normalises float literals
// (`1.0` -> `1`) into the bundle, so any marker containing a decimal matches
// the source but never the build.
const VERBATIM_SLICES = [
  {
    file: "packages/engine/Source/Shaders/SunTextureFS.glsl",
    marker: "float surface = step(radius, u_radiusTS) * limb;",
  },
  {
    file: "packages/engine/Source/Shaders/SunTextureFS.glsl",
    marker: "uniform vec4 u_glareProfile;",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
    marker: "cache.lastAppearanceKey !== appearanceKey",
  },
  {
    file: "packages/engine/Source/Scene/Sun.js",
    marker: "frameState.sunDiscAppearance = appearance;",
  },
];

const REQUIRED_TOKENS = [
  "u_limbDarkening",
  "u_glareProfile",
  "sunDiscAppearance",
  "enableSolarLimbDarkening",
  "enableSolarGlareFalloff",
  "solarGlareProfile",
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
  const missingSources = [];
  let newestSourceMs = 0;
  // A missing source must DEGRADE provenance, never throw: this probe has to
  // be runnable on a PRE (pre-fix) tree to produce a baseline, and on such a
  // tree the new modules do not exist yet.
  for (const p of SOURCE_FILES) {
    let bytes;
    let stat;
    try {
      bytes = fs.readFileSync(p);
      stat = fs.statSync(p);
    } catch {
      missingSources.push(p);
      continue;
    }
    sources[p] = { byteLength: bytes.byteLength, sha256: sha256(bytes) };
    if (stat.mtimeMs > newestSourceMs) {
      newestSourceMs = stat.mtimeMs;
    }
  }

  let bundleFiles;
  try {
    bundleFiles = collectBundleFiles();
  } catch {
    return {
      ok: false,
      reason: "Build/CesiumUnminified missing",
      missingSources,
      sources,
    };
  }
  if (bundleFiles.length === 0) {
    return { ok: false, reason: "no built JS found", missingSources, sources };
  }

  let newestBundleMs = 0;
  for (const f of bundleFiles) {
    const m = fs.statSync(f).mtimeMs;
    if (m > newestBundleMs) {
      newestBundleMs = m;
    }
  }

  // Content-hashed chunks accumulate across builds; only files from the most
  // recent build may satisfy the token/marker searches, or a stale leftover
  // turns the guard into a no-op exactly when it matters.
  const BUILD_WINDOW_MS = 600000;
  const cutoffMs = newestBundleMs - BUILD_WINDOW_MS;
  const considered = [];
  let skippedStaleCount = 0;
  for (const f of bundleFiles) {
    if (fs.statSync(f).mtimeMs >= cutoffMs) {
      considered.push(f);
    } else {
      skippedStaleCount++;
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
    let src;
    try {
      src = fs.readFileSync(slice.file, "utf8");
    } catch {
      missingSlices.push(`${slice.file}: SOURCE FILE ABSENT (PRE tree?)`);
      continue;
    }
    if (!src.includes(slice.marker)) {
      missingSlices.push(`${slice.file}: marker absent from SOURCE`);
      continue;
    }
    if (!texts.some((text) => text.includes(slice.marker))) {
      missingSlices.push(`${slice.file}: marker absent from BUILD`);
    }
  }

  const stale = newestSourceMs > newestBundleMs;
  return {
    ok:
      !stale &&
      entryFresh &&
      missingSources.length === 0 &&
      missingTokens.length === 0 &&
      missingSlices.length === 0,
    stale,
    entryFresh,
    missingSources,
    missingTokens,
    missingSlices,
    skippedStaleCount,
    newestSourceMs,
    newestBundleMs,
    sources,
  };
}

// ── Radial-profile sweep (runs inside the page) ─────────────────────────────
const PROFILE = async ({ iso, vantages, k }) => {
  // ALL helpers live inside this callback (serialization boundary).
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  const T = () => viewer.clock.currentTime;
  scene.requestRenderMode = false;

  // Deterministic, comparable scene — same recipe as probe-eclipse-sun-fade
  // lane (a) so the two probes' geometries are directly comparable.
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
    return { structuralError: "no atmosphericConditions.lighting" };
  }
  // This probe measures the BAKE's rendered profile, not the eclipse fade.
  // Forcing the eclipse off makes `sunEclipseAlpha` exactly 1.0 in every
  // render, so every lane difference is occlusion / background, never the S1
  // multiply. The published alpha is recorded per step as proof.
  ac.lighting.enableEclipse = false;

  const skyDefaultShow = scene.skyAtmosphere
    ? scene.skyAtmosphere.show === true
    : null;

  // Per-frame engine state, sampled at postRender (the canonical point —
  // `updateEnvironment` has run by then). Frames rendered with the sun
  // hidden are ignored: hiding it clears `sunDrawCommand` and forces
  // `isSunVisible` false for reasons unrelated to the cull (S1's lesson).
  const envHolder = {
    isSunVisible: null,
    hasSunCommand: false,
    sunCommandHasBV: null,
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
    envHolder.isSunVisible = envState.isSunVisible === true;
    envHolder.hasSunCommand = !!cmd;
    envHolder.sunCommandHasBV = cmd ? !!cmd.boundingVolume : null;
  };
  const removeEnvListener = scene.postRender.addEventListener(onPostRender);

  const out = {
    rendererType: scene.context.rendererType,
    iso,
    constants: k,
    bake: null,
    appearance: null,
    dynamicLighting: null,
    bloom: null,
    vantages: [],
  };

  try {
    // Bounded sun-direction settle (ICRF / EOP load async).
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

    const sunDirWC = C.Cartesian3.normalize(
      C.Cartesian3.clone(
        scene.context.uniformState.sunPositionWC,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const seed =
      Math.abs(sunDirWC.z) < 0.9
        ? new C.Cartesian3(0, 0, 1)
        : new C.Cartesian3(1, 0, 0);
    const perp = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        C.Cartesian3.cross(sunDirWC, seed, new C.Cartesian3()),
        sunDirWC,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const ORBIT_RADIUS = 6371000.0 + 400000.0;

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
    await settleTiles(400);

    const canvas = scene.canvas;
    const dprX = canvas.width / canvas.clientWidth;
    const dprY = canvas.height / canvas.clientHeight;
    const scratchWin = new C.Cartesian2();
    const scratchWin2 = new C.Cartesian2();
    const tmp = document.createElement("canvas");
    const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });

    // Eight luminance buffers: {L0, L1, L2, L3} x {sun on, sun off}.
    let bufSize = -1;
    let l0On = null;
    let l0Off = null;
    let l1On = null;
    let l1Off = null;
    let l2On = null;
    let l2Off = null;
    let l3On = null;
    let l3Off = null;
    const ensureBuffers = (size) => {
      if (bufSize === size) {
        return;
      }
      bufSize = size;
      const n = size * size;
      l0On = new Float32Array(n);
      l0Off = new Float32Array(n);
      l1On = new Float32Array(n);
      l1Off = new Float32Array(n);
      l2On = new Float32Array(n);
      l2Off = new Float32Array(n);
      l3On = new Float32Array(n);
      l3Off = new Float32Array(n);
    };
    const capture = (x0, y0, size, lum) => {
      tmpCtx.drawImage(canvas, x0, y0, size, size, 0, 0, size, size);
      const data = tmpCtx.getImageData(0, 0, size, size).data;
      for (let p = 0, j = 0; p < lum.length; p++, j += 4) {
        lum[p] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
      }
    };
    const readExtinction = () => {
      const fs1 = scene._frameState;
      const e = fs1 ? fs1.sunAtmosphereExtinction : null;
      return e ? [e.x, e.y, e.z] : null;
    };

    let structuralError = null;
    for (let v = 0; v < vantages.length && structuralError === null; v++) {
      const vantage = vantages[v];
      const binCount = Math.round(k.maxRsun / k.binWidthRsun);
      const bins = [];
      const distinct = [];
      for (let b = 0; b < binCount; b++) {
        bins.push({
          rsunLo: b * k.binWidthRsun,
          rsunHi: (b + 1) * k.binWidthRsun,
          n: 0,
          sunDelta: 0,
          sunDeltaSigned: 0,
          sunDeltaNoSky: 0,
          sunDeltaNoGlobe: 0,
          sunDeltaBloom: 0,
          sunDeltaBloomSigned: 0,
          bgSum: 0,
          bgMax: 0,
          bgSat: 0,
          bgNoSkySum: 0,
          bgSatNoSky: 0,
          bgNoGlobeSum: 0,
          bgSatNoGlobe: 0,
          litSum: 0,
          litSat: 0,
          globePx: 0,
        });
        distinct.push(new Set());
      }

      const stepRecords = [];
      for (
        let i = 0;
        i < vantage.elevs.length && structuralError === null;
        i++
      ) {
        const elevDeg = vantage.elevs[i];
        const theta = ((90.0 - elevDeg) * Math.PI) / 180.0;
        const up = C.Cartesian3.normalize(
          new C.Cartesian3(
            Math.cos(theta) * sunDirWC.x + Math.sin(theta) * perp.x,
            Math.cos(theta) * sunDirWC.y + Math.sin(theta) * perp.y,
            Math.cos(theta) * sunDirWC.z + Math.sin(theta) * perp.z,
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
        scene.camera.frustum.fov = C.Math.toRadians(k.fovDeg);

        scene.globe.show = true;
        if (scene.skyAtmosphere) {
          scene.skyAtmosphere.show = skyDefaultShow;
        }
        scene.sun.show = true;
        await settleTiles(30);

        // ── L0: globe ON, sky ON, sun ON ───────────────────────────────────
        scene.render(T());
        // STATE read, SAME TASK, immediately after the sun-SHOWN render.
        const envOn = {
          isSunVisible: envHolder.isSunVisible,
          hasSunCommand: envHolder.hasSunCommand,
          sunCommandHasBV: envHolder.sunCommandHasBV,
        };
        const fsL0 = scene._frameState;
        const alpha = fsL0 ? fsL0.sunEclipseAlpha : null;
        const extL0 = readExtinction();
        if (out.appearance === null && fsL0 && fsL0.sunDiscAppearance) {
          const a = fsL0.sunDiscAppearance;
          out.appearance = {
            limbDarkening: a.limbDarkening,
            glareFalloff: a.glareFalloff,
            a0: a.a0,
            a1: a.a1,
            a2: a.a2,
            glareCore: a.glareCore,
            glarePedestal: a.glarePedestal,
            glareLegacy: a.glareLegacy,
            key: a.key,
          };
        }
        if (out.dynamicLighting === null) {
          // REPORTED DIAGNOSTIC ONLY — the opaque-shell OCCLUSION reading is
          // eliminated by draw order (see the header); this documents scene
          // state and lets the manifest corroborate the other worker's
          // finding without this probe depending on it. Reads of public
          // state only; no sky/atmosphere file is touched.
          let fromGlobeFlags = null;
          try {
            fromGlobeFlags =
              C.DynamicAtmosphereLightingType &&
              typeof C.DynamicAtmosphereLightingType.fromGlobeFlags ===
                "function"
                ? C.DynamicAtmosphereLightingType.fromGlobeFlags(scene.globe)
                : null;
          } catch {
            fromGlobeFlags = null;
          }
          out.dynamicLighting = {
            frameStateAtmosphereDynamicLighting:
              fsL0 && fsL0.atmosphere
                ? (fsL0.atmosphere.dynamicLighting ?? null)
                : null,
            fromGlobeFlags,
            globeEnableLighting: scene.globe
              ? scene.globe.enableLighting
              : null,
            globeDynamicAtmosphereLighting: scene.globe
              ? scene.globe.dynamicAtmosphereLighting
              : null,
            globeDynamicAtmosphereLightingFromSun: scene.globe
              ? scene.globe.dynamicAtmosphereLightingFromSun
              : null,
            skyAtmosphereShow: skyDefaultShow,
          };
          // Bloom capability + the pinned baseline, on the record rather
          // than assumed. `supportsLegacySunBloom` is true on WebGL and
          // false on WebGPU (`GraphicsContext.ts:942` /
          // `WebGPUContext.ts:1713`), and both bloom sites additionally
          // gate on `scene.sunBloom` — a plain public field (`Scene.js:564`).
          out.bloom = {
            supportsLegacySunBloom:
              scene.context.supportsLegacySunBloom !== false,
            baselineSunBloom: scene.sunBloom === true,
          };
        }

        // ROI geometry — camera fixed for this step, so project once.
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
          structuralError = `${vantage.name} step ${i}: sun did not project`;
          break;
        }
        const cx = center.x * dprX;
        const cy = center.y * dprY;
        const limbPx =
          Math.hypot(limb.x - center.x, limb.y - center.y) *
          Math.max(dprX, dprY);
        const maxHalf = Math.floor(
          0.45 * Math.min(canvas.width, canvas.height),
        );
        const half = Math.min(
          Math.ceil((k.maxRsun + k.roiMarginRsun) * limbPx),
          maxHalf,
        );
        const x0 = Math.round(cx - half);
        const y0 = Math.round(cy - half);
        if (
          !(limbPx >= k.minLimbPx) ||
          half < k.maxRsun * limbPx ||
          x0 < 0 ||
          y0 < 0 ||
          x0 + 2 * half >= canvas.width ||
          y0 + 2 * half >= canvas.height
        ) {
          // Emit the full arithmetic, not a bare "ROI invalid": the round-1
          // failure was diagnosable only by hand-recomputing these numbers.
          structuralError =
            `${vantage.name} step ${i}: ROI invalid — limbPx=${limbPx.toFixed(2)} ` +
            `(min ${k.minLimbPx}), half=${half}, maxHalf=${maxHalf}, ` +
            `maxRsun*limbPx=${(k.maxRsun * limbPx).toFixed(2)}, ` +
            `roiRsun=${(half / limbPx).toFixed(2)}, canvas=${canvas.width}x${canvas.height}, ` +
            `centre=${cx.toFixed(1)},${cy.toFixed(1)}, fovDeg=${k.fovDeg}. ` +
            `roiFeasibility() should have rejected this constant set before launch.`;
          break;
        }
        const size = 2 * half + 1;
        if (tmp.width !== size) {
          tmp.width = size;
          tmp.height = size;
        }
        ensureBuffers(size);
        capture(x0, y0, size, l0On);

        // ── L0: sun OFF ────────────────────────────────────────────────────
        scene.sun.show = false;
        scene.render(T());
        capture(x0, y0, size, l0Off);

        // ── L1: sky OFF (globe still ON) — varies the SKY only ─────────────
        // SATURATION-ATTRIBUTION lane. Its BACKGROUND capture is clean (the
        // sun is hidden, so the sun's extinction cannot touch it). Its
        // sun-shown capture is confounded — hiding the shell also flips
        // `frameState.skyAtmosphereVisible`, which gates the sun's own
        // atmospheric extinction in `Sun.update` — so `sunDeltaNoSky` is
        // recorded as a diagnostic and never selects a hypothesis.
        let extL1 = null;
        if (scene.skyAtmosphere) {
          scene.skyAtmosphere.show = false;
        }
        scene.sun.show = true;
        scene.render(T());
        extL1 = readExtinction();
        capture(x0, y0, size, l1On);
        scene.sun.show = false;
        scene.render(T());
        capture(x0, y0, size, l1Off);
        if (scene.skyAtmosphere) {
          scene.skyAtmosphere.show = skyDefaultShow;
        }

        // ── L2: globe OFF (sky back ON) — varies the GLOBE only ────────────
        // DOCUMENTED: `globe.show = false` removes THREE things at once —
        // the depth writer, the sunlit-limb saturator, AND the legacy sun
        // cull (`SceneUtilities.getOccluder` returns undefined when the
        // globe is hidden, which disables `Occluder.isBoundingSphereVisible`).
        // That is why absence is settled by the STATE read above and never
        // by this lane, and why the H-OCCL branch additionally requires the
        // L0 background to be UNSATURATED. Do not re-derive this; see M1/M2
        // in the header.
        scene.globe.show = false;
        scene.sun.show = true;
        scene.render(T());
        capture(x0, y0, size, l2On);
        scene.sun.show = false;
        scene.render(T());
        capture(x0, y0, size, l2Off);
        scene.globe.show = true;
        scene.sun.show = true;

        // ── L3: bloom ON (globe ON, sky ON) — varies BLOOM only ───────────
        // The requested A/B control for the "WebGL-only sun bloom" mechanism.
        // L0..L2 all run with `scene.sunBloom = false`, which is what the
        // round-2 run that produced the residual also did — so if the bloom
        // were the mechanism, the residual should already have been absent.
        // Running the toggle in the OTHER direction measures that instead of
        // reasoning about it. Near-limb only (runtime).
        let ranBloomLane = false;
        if (vantage.bloomLane === true) {
          scene.sunBloom = true;
          scene.sun.show = true;
          scene.render(T());
          capture(x0, y0, size, l3On);
          scene.sun.show = false;
          scene.render(T());
          capture(x0, y0, size, l3Off);
          scene.sunBloom = false;
          scene.sun.show = true;
          ranBloomLane = true;
        }

        // ── Accumulate the radial profile ──────────────────────────────────
        let annulusL0 = 0;
        let annulusL0Signed = 0;
        let annulusL1 = 0;
        let annulusL2 = 0;
        let annulusL3 = 0;
        let annulusL3Signed = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const p = y * size + x;
            const dx = x - half;
            const dy = y - half;
            const rho = Math.sqrt(dx * dx + dy * dy) / limbPx;
            if (rho >= k.maxRsun) {
              continue;
            }
            const b = Math.min(binCount - 1, Math.floor(rho / k.binWidthRsun));
            const bin = bins[b];
            // SIGNED first: the sign is the discriminator between "bloom adds
            // light" (positive) and "a black billboard under ALPHA_BLEND
            // subtracts a*dst" (negative). The absolute value is kept for the
            // magnitude metrics that predate this.
            const s0 = l0On[p] - l0Off[p];
            const d0 = Math.abs(s0);
            const d1 = Math.abs(l1On[p] - l1Off[p]);
            const d2 = Math.abs(l2On[p] - l2Off[p]);
            bin.n++;
            bin.sunDelta += d0;
            bin.sunDeltaSigned += s0;
            bin.sunDeltaNoSky += d1;
            bin.sunDeltaNoGlobe += d2;
            if (ranBloomLane) {
              const s3 = l3On[p] - l3Off[p];
              bin.sunDeltaBloom += Math.abs(s3);
              bin.sunDeltaBloomSigned += s3;
              annulusL3Signed += rho >= 1.5 && rho <= 6.0 ? s3 : 0;
              annulusL3 += rho >= 1.5 && rho <= 6.0 ? Math.abs(s3) : 0;
            }
            bin.bgSum += l0Off[p];
            bin.litSum += l0On[p];
            if (l0Off[p] > bin.bgMax) {
              bin.bgMax = l0Off[p];
            }
            if (l0Off[p] >= 250) {
              bin.bgSat++;
            }
            if (l0On[p] >= 250) {
              bin.litSat++;
            }
            bin.bgNoSkySum += l1Off[p];
            if (l1Off[p] >= 250) {
              bin.bgSatNoSky++;
            }
            bin.bgNoGlobeSum += l2Off[p];
            if (l2Off[p] >= 250) {
              bin.bgSatNoGlobe++;
            }
            // A pixel is "globe" when hiding the globe changed the
            // sun-hidden background there by more than 8-bit noise.
            if (Math.abs(l0Off[p] - l2Off[p]) > 2) {
              bin.globePx++;
            }
            if (distinct[b].size < 4096) {
              distinct[b].add(Math.round(d2));
            }
            if (rho >= 1.5 && rho <= 6.0) {
              annulusL0 += d0;
              annulusL0Signed += s0;
              annulusL1 += d1;
              annulusL2 += d2;
            }
          }
        }

        stepRecords.push({
          elevDeg,
          limbPx,
          roiRsun: half / limbPx,
          alpha,
          extinctionL0: extL0,
          extinctionL1: extL1,
          annulusL0,
          annulusL0Signed,
          annulusL1,
          annulusL2,
          annulusL3,
          annulusL3Signed,
          ranBloomLane,
          isSunVisible: envOn.isSunVisible,
          hasSunCommand: envOn.hasSunCommand,
          sunCommandHasBV: envOn.sunCommandHasBV,
        });
      }

      if (structuralError !== null) {
        break;
      }

      out.vantages.push({
        name: vantage.name,
        elevs: vantage.elevs,
        steps: stepRecords,
        profile: bins.map((bin, b) => ({
          rsunLo: bin.rsunLo,
          rsunHi: bin.rsunHi,
          n: bin.n,
          sunDeltaMean: bin.n > 0 ? bin.sunDelta / bin.n : 0,
          sunDeltaSignedMean: bin.n > 0 ? bin.sunDeltaSigned / bin.n : 0,
          sunDeltaNoSkyMean: bin.n > 0 ? bin.sunDeltaNoSky / bin.n : 0,
          sunDeltaNoGlobeMean: bin.n > 0 ? bin.sunDeltaNoGlobe / bin.n : 0,
          sunDeltaBloomMean: bin.n > 0 ? bin.sunDeltaBloom / bin.n : 0,
          sunDeltaBloomSignedMean:
            bin.n > 0 ? bin.sunDeltaBloomSigned / bin.n : 0,
          bgMean: bin.n > 0 ? bin.bgSum / bin.n : 0,
          bgMax: bin.bgMax,
          bgSatFrac: bin.n > 0 ? bin.bgSat / bin.n : 0,
          bgNoSkyMean: bin.n > 0 ? bin.bgNoSkySum / bin.n : 0,
          bgSatFracNoSky: bin.n > 0 ? bin.bgSatNoSky / bin.n : 0,
          bgNoGlobeMean: bin.n > 0 ? bin.bgNoGlobeSum / bin.n : 0,
          bgSatFracNoGlobe: bin.n > 0 ? bin.bgSatNoGlobe / bin.n : 0,
          litMean: bin.n > 0 ? bin.litSum / bin.n : 0,
          litSatFrac: bin.n > 0 ? bin.litSat / bin.n : 0,
          globeFrac: bin.n > 0 ? bin.globePx / bin.n : 0,
          distinctValues: distinct[b].size,
        })),
      });
    }

    // ── Bake introspection (C12-17 parity, read live) ──────────────────────
    try {
      const sun = scene.sun;
      const wcache = sun && sun._webgpuCache ? sun._webgpuCache : null;
      out.bake = {
        backend: scene.context.rendererType,
        webglSize: sun && sun._texture ? sun._texture.width : null,
        webglDatatype:
          sun && sun._texture && sun._texture.pixelDatatype !== undefined
            ? String(sun._texture.pixelDatatype)
            : null,
        webgpuSize: wcache ? (wcache.lastBakeSize ?? null) : null,
        webgpuFormat: wcache ? (wcache.lastBakeFormat ?? null) : null,
        webgpuAppearanceKey: wcache ? (wcache.lastAppearanceKey ?? null) : null,
        drawingBufferWidth: scene.context.drawingBufferWidth ?? null,
        drawingBufferHeight: scene.context.drawingBufferHeight ?? null,
        useHDR: scene.highDynamicRange === true,
      };
    } catch (e) {
      out.bake = { error: String(e).slice(0, 200) };
    }

    if (structuralError !== null) {
      out.structuralError = structuralError;
    }
  } finally {
    removeEnvListener();
    if (scene.skyAtmosphere && skyDefaultShow !== null) {
      scene.skyAtmosphere.show = skyDefaultShow;
    }
    if (scene.globe) {
      scene.globe.show = true;
    }
  }
  return out;
};

// ── Playwright driver ───────────────────────────────────────────────────────
async function runBackend(browser, renderer, plan) {
  const context = await browser.newContext({
    viewport: {
      width: plan.k.viewportWidth,
      height: plan.k.viewportHeight,
    },
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

    out.profile = await page.evaluate(PROFILE, plan);

    await page
      .locator("canvas")
      .first()
      .screenshot({
        path: path.join(OUT_DIR, `sun-glow-profile-${renderer}.png`),
      })
      .catch(() => {});
  } catch (e) {
    out.error = String(e).slice(0, 400);
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

// ── Analysis ────────────────────────────────────────────────────────────────
const binCentre = (bin) => 0.5 * (bin.rsunLo + bin.rsunHi);

// Radius at which the globe-free profile falls to `frac` of its value in the
// 1.5 R_sun bin. Globe-free because the open-sky control has no globe in the
// ROI anyway, and at near-limb it is the only lane with a full profile.
function fallOffRadius(profile, frac) {
  const ref = profile.find((b) => b.rsunLo <= 1.5 && b.rsunHi > 1.5);
  if (!ref || !(ref.sunDeltaNoGlobeMean > 0)) {
    return null;
  }
  const target = ref.sunDeltaNoGlobeMean * frac;
  let prev = ref;
  for (const bin of profile) {
    if (binCentre(bin) <= 1.5) {
      continue;
    }
    if (bin.sunDeltaNoGlobeMean <= target) {
      const a = prev.sunDeltaNoGlobeMean;
      const b = bin.sunDeltaNoGlobeMean;
      const ca = binCentre(prev);
      const cb = binCentre(bin);
      return a === b ? cb : ca + ((a - target) / (a - b)) * (cb - ca);
    }
    prev = bin;
  }
  return null;
}

// Outermost bin centre whose globe-free profile still carries signal.
function supportRadius(profile, floor) {
  let out = null;
  for (const bin of profile) {
    if (bin.sunDeltaNoGlobeMean >= floor) {
      out = binCentre(bin);
    }
  }
  return out;
}

function annulusBins(profile) {
  return profile.filter((b) => b.rsunLo >= 1.5 && b.rsunHi <= 6.0);
}

// "Zero" = below the 8-bit dither floor of a difference image.
const ZERO = 0.25;
const RECOVER = 4 * ZERO;
const SAT_FRAC = 0.5;

function classify(vantage) {
  const bins = annulusBins(vantage.profile);
  if (bins.length === 0) {
    return { hypothesis: "no-annulus-bins" };
  }
  const mean = (f) => bins.reduce((a, b) => a + f(b), 0) / bins.length;
  const ev = {
    sunDelta: mean((b) => b.sunDeltaMean),
    sunDeltaNoGlobe: mean((b) => b.sunDeltaNoGlobeMean),
    // Diagnostic only — confounded by the extinction gate (see header).
    sunDeltaNoSky_DIAGNOSTIC: mean((b) => b.sunDeltaNoSkyMean),
    bgMean: mean((b) => b.bgMean),
    bgSat: mean((b) => b.bgSatFrac),
    litSat: mean((b) => b.litSatFrac),
    bgMeanNoSky: mean((b) => b.bgNoSkyMean),
    bgSatNoSky: mean((b) => b.bgSatFracNoSky),
    bgMeanNoGlobe: mean((b) => b.bgNoGlobeMean),
    bgSatNoGlobe: mean((b) => b.bgSatFracNoGlobe),
    globeFrac: mean((b) => b.globeFrac),
  };

  const steps = vantage.steps;
  const backendHasBV = steps.some((s) => s.sunCommandHasBV === true);
  const commandBuiltSteps = steps.filter(
    (s) => s.hasSunCommand === true,
  ).length;
  const cullFiredSteps = steps.filter((s) => s.isSunVisible === false).length;
  const state = {
    backendHasBV,
    totalSteps: steps.length,
    commandBuiltSteps,
    cullFiredSteps,
  };

  const extNear1 = (e) => e !== null && e.every((c) => c > 0.9);
  const skyLaneExtinctionConfound = steps.some(
    (s) => !extNear1(s.extinctionL0) && extNear1(s.extinctionL1),
  );

  // Saturation source attribution, from the two BACKGROUND lanes (clean —
  // the sun is hidden in all three background captures).
  let saturationSource = null;
  if (ev.bgSat >= SAT_FRAC || ev.bgMean > 250) {
    if (ev.bgSatNoGlobe < SAT_FRAC && ev.bgSatNoSky >= SAT_FRAC) {
      saturationSource = "globe";
    } else if (ev.bgSatNoSky < SAT_FRAC && ev.bgSatNoGlobe >= SAT_FRAC) {
      saturationSource = "sky-shell";
    } else if (ev.bgSatNoGlobe < SAT_FRAC && ev.bgSatNoSky < SAT_FRAC) {
      saturationSource = "globe+shell jointly";
    } else {
      saturationSource = "not isolated by either single lever";
    }
  }

  let hypothesis;
  if (ev.sunDelta >= ZERO) {
    hypothesis = "sun-measurable-in-annulus";
  } else if (commandBuiltSteps === 0) {
    // STATE level, no pixels involved.
    hypothesis = "H-ABSENT(state): no sun draw command was built in any step";
  } else if (backendHasBV && cullFiredSteps === steps.length) {
    hypothesis =
      "H-ABSENT(state): the legacy Occluder cull removed the billboard in every step";
  } else if (saturationSource !== null) {
    // M1 — SATURATION IS TESTED BEFORE OCCLUSION. When the saturator is the
    // globe, the occlusion signature is indistinguishable from it.
    hypothesis = `H-SAT: the annulus background is already at 255, saturator = ${saturationSource} — the additive sun adds into a clamped destination`;
  } else if (ev.sunDeltaNoGlobe >= RECOVER && ev.globeFrac > 0.3) {
    // Reached only with the L0 background UNSATURATED, so the recovery
    // cannot be the saturator going away.
    hypothesis = "H-OCCL: per-pixel depth clip by the globe";
  } else {
    hypothesis =
      "inconclusive: the command exists, the L0 background is unsaturated, " +
      "and hiding the globe does not recover the sun";
  }

  return {
    hypothesis,
    evidence: ev,
    state,
    saturationSource,
    skyLaneExtinctionConfound,
  };
}

function annulusSums(vantage) {
  let l0 = 0;
  let l0s = 0;
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  let l3s = 0;
  let bloomSteps = 0;
  for (const s of vantage.steps) {
    l0 += s.annulusL0;
    l0s += s.annulusL0Signed;
    l1 += s.annulusL1;
    l2 += s.annulusL2;
    if (s.ranBloomLane) {
      l3 += s.annulusL3;
      l3s += s.annulusL3Signed;
      bloomSteps++;
    }
  }
  return {
    annulusSumBase: l0,
    annulusSumBaseSigned: l0s,
    annulusSumNoSky: l1,
    annulusSumNoGlobe: l2,
    annulusSumBloomOn: bloomSteps > 0 ? l3 : null,
    annulusSumBloomOnSigned: bloomSteps > 0 ? l3s : null,
    bloomSteps,
  };
}

// Mechanism call for the WebGL residual at the extinction-0 steps. Two
// candidates, separated by SIGN and by the bloom toggle; see the header.
//   blend-darkening  -> signed delta NEGATIVE, bloom toggle changes little
//   bloom            -> signed delta POSITIVE, residual collapses with bloom off
function bloomMechanism(vantage) {
  // Steps where the billboard is arithmetically black: extinction ~0 in
  // every channel AND a command was actually built (so "nothing drawn" is
  // not what we are measuring).
  const dark = vantage.steps.filter(
    (s) =>
      s.hasSunCommand === true &&
      s.extinctionL0 !== null &&
      s.extinctionL0.every((c) => c !== null && c < 5e-4),
  );
  if (dark.length === 0) {
    return { verdict: "no-extinguished-steps", darkSteps: 0 };
  }
  const sum = (f) => dark.reduce((a, s) => a + f(s), 0);
  const off = sum((s) => s.annulusL0);
  const offSigned = sum((s) => s.annulusL0Signed);
  const ranBloom = dark.every((s) => s.ranBloomLane === true);
  const on = ranBloom ? sum((s) => s.annulusL3) : null;
  const onSigned = ranBloom ? sum((s) => s.annulusL3Signed) : null;
  // Relative magnitude of the residual with bloom ON vs OFF.
  const ratio = ranBloom && off > 0 ? on / off : null;

  let verdict;
  if (off < 1) {
    verdict =
      "no-residual: this backend measures ~0 where the billboard is black";
  } else if (offSigned < -0.5 * off) {
    verdict =
      "blend-darkening CONFIRMED: the residual is NEGATIVE — a black " +
      "billboard under ALPHA_BLEND subtracts a*dst from the sky. Not bloom.";
  } else if (offSigned > 0.5 * off) {
    verdict =
      "additive-residual: the residual is POSITIVE, so it is added light — " +
      "blend-darkening is REFUTED and the bloom/other-additive path is live";
  } else {
    verdict = "mixed-sign residual: neither mechanism dominates";
  }
  let bloomCall = "not-run";
  if (ranBloom && ratio !== null) {
    bloomCall =
      ratio < 0.25
        ? "bloom-CONFIRMED: the residual collapses when bloom is off (so `sunBloom = false` was NOT taking effect in earlier runs)"
        : ratio > 0.8 && ratio < 1.25
          ? "bloom-REFUTED: toggling bloom barely moves the residual, as predicted (both bloom sites are gated on scene.sunBloom, which every lane pins false)"
          : `bloom-PARTIAL: residual ratio on/off = ${ratio.toFixed(3)}`;
  }
  return {
    verdict,
    bloomCall,
    darkSteps: dark.length,
    residualBloomOff: off,
    residualBloomOffSigned: offSigned,
    residualBloomOn: on,
    residualBloomOnSigned: onSigned,
    bloomOnOverOff: ratio,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Constant-set feasibility BEFORE the browser launches, over the whole
  // Earth-Sun distance range. The round-1 blocker exited 2 at step 0 of a
  // browser run; this makes an unsatisfiable set impossible to ship.
  const feas = {
    perihelion: roiFeasibility(
      PROBE_CONSTANTS,
      PROBE_CONSTANTS.sunDistanceMinM,
    ),
    aphelion: roiFeasibility(PROBE_CONSTANTS, PROBE_CONSTANTS.sunDistanceMaxM),
  };
  if (!feas.perihelion.feasible || !feas.aphelion.feasible) {
    console.error(
      "[probe-sun-glow-profile] STRUCTURAL: ROI geometry is unsatisfiable",
    );
    for (const [name, f] of Object.entries(feas)) {
      console.error(
        `  ${name}: limbPx=${f.limbPx.toFixed(2)} maxHalf=${f.maxHalf} half=${f.half} roiRsun=${f.roiRsun.toFixed(2)}`,
      );
      for (const r of f.reasons) {
        console.error(`    - ${r}`);
      }
    }
    process.exit(2);
  }

  const prov = provenance();

  const plan = {
    // Pinned clock. Same instant family as probe-eclipse-sun-fade lane (a)
    // so the two probes' orbital geometry is directly comparable.
    iso: "2026-08-12T17:46:00Z",
    k: PROBE_CONSTANTS,
    vantages: [
      {
        // CONTROL. From 400 km the geometric horizon is at -19.8 deg, so a
        // sun 5 deg below local horizontal still sits ~14.8 deg (over 50
        // solar radii) clear of the limb: the whole ROI is open sky.
        name: "open-sky",
        elevs: [-5.0],
      },
      {
        // The failing case: probe-eclipse-sun-fade lane (a)'s own band.
        name: "near-limb",
        elevs: [-19.0, -19.9, -20.8, -21.7, -22.6],
        // Run the bloom A/B here only — this is where the residual lives.
        bloomLane: true,
      },
    ],
  };

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let webgl;
  let webgpu;
  try {
    webgl = await runBackend(browser, "webgl", plan);
    webgpu = await runBackend(browser, "webgpu", plan);
  } finally {
    await browser.close().catch(() => {});
  }

  const report = {
    probe: "probe-sun-glow-profile",
    generatedAt: new Date().toISOString(),
    provenance: prov,
    constants: PROBE_CONSTANTS,
    roiFeasibility: feas,
    plan: { iso: plan.iso, vantages: plan.vantages },
    backends: {},
    gates: {},
    structural: [],
    verdict: {},
  };

  const structural = [];
  for (const [name, res] of [
    ["webgl", webgl],
    ["webgpu", webgpu],
  ]) {
    if (!res || res.error) {
      structural.push(`${name}: driver error ${res ? res.error : "no result"}`);
      continue;
    }
    const p = res.profile;
    if (!p || p.structuralError) {
      structural.push(`${name}: ${p ? p.structuralError : "no profile"}`);
      continue;
    }
    if (p.rendererType !== name) {
      structural.push(
        `${name}: rendererType mismatch — requested ${name}, got ${p.rendererType}`,
      );
      continue;
    }
    const byName = {};
    for (const v of p.vantages) {
      byName[v.name] = {
        ...annulusSums(v),
        ...classify(v),
        bloomMechanism: bloomMechanism(v),
        supportRsun: supportRadius(v.profile, PROBE_CONSTANTS.supportFloorLum),
        // Sensitivity of the support metric to its own floor — recorded so a
        // gate near the dither floor is auditable rather than trusted.
        supportRsunFloor1: supportRadius(v.profile, 1.0),
        supportRsunFloor2: supportRadius(v.profile, 2.0),
        r10Rsun: fallOffRadius(v.profile, 0.1),
        r50Rsun: fallOffRadius(v.profile, 0.5),
        steps: v.steps.map((s) => ({
          elevDeg: s.elevDeg,
          limbPx: r3(s.limbPx),
          roiRsun: r3(s.roiRsun),
          alpha: s.alpha,
          extinctionL0: s.extinctionL0 ? s.extinctionL0.map(r3) : null,
          extinctionL1: s.extinctionL1 ? s.extinctionL1.map(r3) : null,
          annulusL0: r3(s.annulusL0),
          annulusL0Signed: r3(s.annulusL0Signed),
          annulusL1_DIAGNOSTIC: r3(s.annulusL1),
          annulusL2: r3(s.annulusL2),
          annulusL3BloomOn: s.ranBloomLane ? r3(s.annulusL3) : null,
          annulusL3BloomOnSigned: s.ranBloomLane ? r3(s.annulusL3Signed) : null,
          isSunVisible: s.isSunVisible,
          hasSunCommand: s.hasSunCommand,
          sunCommandHasBV: s.sunCommandHasBV,
        })),
        profile: v.profile.map((b) => ({
          rsun: r3(binCentre(b)),
          n: b.n,
          sunDelta: r3(b.sunDeltaMean),
          sunDeltaSigned: r3(b.sunDeltaSignedMean),
          sunDeltaNoGlobe: r3(b.sunDeltaNoGlobeMean),
          sunDeltaNoSky_DIAGNOSTIC: r3(b.sunDeltaNoSkyMean),
          sunDeltaBloomOn: r3(b.sunDeltaBloomMean),
          sunDeltaBloomOnSigned: r3(b.sunDeltaBloomSignedMean),
          bg: r3(b.bgMean),
          bgMax: r3(b.bgMax),
          bgSat: r3(b.bgSatFrac),
          bgNoSky: r3(b.bgNoSkyMean),
          bgSatNoSky: r3(b.bgSatFracNoSky),
          bgNoGlobe: r3(b.bgNoGlobeMean),
          bgSatNoGlobe: r3(b.bgSatFracNoGlobe),
          lit: r3(b.litMean),
          litSat: r3(b.litSatFrac),
          globeFrac: r3(b.globeFrac),
          distinct: b.distinctValues,
        })),
      };
    }
    report.backends[name] = {
      rendererType: p.rendererType,
      bake: p.bake,
      appearance: p.appearance,
      dynamicLighting: p.dynamicLighting,
      bloom: p.bloom,
      consoleErrors: res.consoleErrors.slice(0, 10),
      vantages: byName,
    };
  }

  report.structural = structural;
  if (structural.length > 0) {
    fs.writeFileSync(
      path.join(OUT_DIR, "sun-glow-profile.json"),
      JSON.stringify(report, null, 2),
    );
    console.error("[probe-sun-glow-profile] STRUCTURAL:");
    for (const s of structural) {
      console.error(`  - ${s}`);
    }
    process.exit(2);
  }

  const gl = report.backends.webgl;
  const gpu = report.backends.webgpu;
  const glOpen = gl.vantages["open-sky"];
  const gpuOpen = gpu.vantages["open-sky"];

  const gates = {};

  gates.provenance = {
    pass: prov.ok === true,
    detail: prov.ok
      ? "sources present in a fresh bundle"
      : `stale=${prov.stale} entryFresh=${prov.entryFresh} missingSources=${JSON.stringify(prov.missingSources ?? [])} tokens=${JSON.stringify(prov.missingTokens ?? [])} slices=${JSON.stringify(prov.missingSlices ?? [])}`,
  };

  gates.sanity = {
    pass:
      glOpen.annulusSumBase > 1000 &&
      gpuOpen.annulusSumBase > 1000 &&
      glOpen.supportRsun !== null &&
      gpuOpen.supportRsun !== null,
    detail: `open-sky annulusSumBase webgl=${r3(glOpen.annulusSumBase)} webgpu=${r3(gpuOpen.annulusSumBase)}`,
  };

  const supportOk = (s) =>
    s !== null &&
    s >= PROBE_CONSTANTS.supportGateLoRsun &&
    s <= PROBE_CONSTANTS.supportGateHiRsun;
  gates.c12_16_support = {
    pass: supportOk(glOpen.supportRsun) && supportOk(gpuOpen.supportRsun),
    detail:
      `open-sky supportRsun webgl=${r3(glOpen.supportRsun)} webgpu=${r3(gpuOpen.supportRsun)} ` +
      `(band ${PROBE_CONSTANTS.supportGateLoRsun}..${PROBE_CONSTANTS.supportGateHiRsun}; ` +
      `pre-C12-16 expectation ~8.25, post ~10.75) ` +
      `floor-sensitivity webgl=${r3(glOpen.supportRsunFloor1)}/${r3(glOpen.supportRsunFloor2)} ` +
      `webgpu=${r3(gpuOpen.supportRsunFloor1)}/${r3(gpuOpen.supportRsunFloor2)}`,
  };

  const geomDelta =
    glOpen.r10Rsun !== null && gpuOpen.r10Rsun !== null
      ? Math.abs(gpuOpen.r10Rsun - glOpen.r10Rsun) / glOpen.r10Rsun
      : null;
  gates.geometry_lockstep = {
    pass: geomDelta !== null && geomDelta <= 0.2,
    detail: `r10 webgl=${r3(glOpen.r10Rsun)} webgpu=${r3(gpuOpen.r10Rsun)} relDelta=${r3(geomDelta)}`,
  };

  // C12-17: at 1280x720 WebGL's own rule gives 2^(ceil(log2(1280))-2) = 512.
  const expectedSize = 512;
  gates.c12_17_bake = {
    pass:
      !!gpu.bake &&
      gpu.bake.webgpuSize === expectedSize &&
      gpu.bake.webgpuFormat === "rgba8unorm" &&
      !!gl.bake &&
      gl.bake.webglSize === expectedSize,
    detail: `webgl=${gl.bake ? gl.bake.webglSize : null} webgpu=${gpu.bake ? gpu.bake.webgpuSize : null}/${gpu.bake ? gpu.bake.webgpuFormat : null} (SDR expectation ${expectedSize}/rgba8unorm)`,
  };

  const sameAppearance =
    !!gl.appearance &&
    !!gpu.appearance &&
    JSON.stringify(gl.appearance) === JSON.stringify(gpu.appearance);
  gates.c12_15_appearance = {
    pass:
      sameAppearance &&
      gl.appearance.key === 3 &&
      gl.appearance.a0 === 0.3 &&
      gl.appearance.glareLegacy === 0,
    detail: `webgl=${JSON.stringify(gl.appearance)} webgpu=${JSON.stringify(gpu.appearance)}`,
  };

  const allAlphaOne = [gl, gpu].every((b) =>
    Object.values(b.vantages).every((v) => v.steps.every((s) => s.alpha === 1)),
  );
  gates.eclipse_identity = {
    pass: allAlphaOne,
    detail: "sunEclipseAlpha must be exactly 1.0 with enableEclipse false",
  };

  // INSTRUMENT gate, not a physics gate: `scene.sun.show` is not a
  // single-variable lever on WebGL (it gates the bloom pass too), so every
  // measuring lane must have `sunBloom` pinned OFF. If a future edit lets it
  // drift back to its default TRUE, this fails loudly instead of silently
  // re-introducing the artefact the round-2 run chased.
  gates.bloom_pinned = {
    pass:
      !!gl.bloom &&
      !!gpu.bloom &&
      gl.bloom.baselineSunBloom === false &&
      gpu.bloom.baselineSunBloom === false,
    detail: `baselineSunBloom webgl=${gl.bloom ? gl.bloom.baselineSunBloom : null} webgpu=${gpu.bloom ? gpu.bloom.baselineSunBloom : null}; supportsLegacySunBloom webgl=${gl.bloom ? gl.bloom.supportsLegacySunBloom : null} webgpu=${gpu.bloom ? gpu.bloom.supportsLegacySunBloom : null}`,
  };

  gates.console = {
    pass: gl.consoleErrors.length === 0 && gpu.consoleErrors.length === 0,
    detail: `webgl=${gl.consoleErrors.length} webgpu=${gpu.consoleErrors.length}`,
  };

  report.gates = gates;

  report.verdict = {
    note:
      "The WebGL-vs-WebGPU near-limb divergence is the SUBJECT of this probe, " +
      "not a gate: a diagnostic that fails on its own phenomenon cannot report " +
      "it. Absence is settled at STATE level (M2); saturation is tested before " +
      "occlusion (M1); the opaque-shell OCCLUSION reading was eliminated from " +
      "source by draw order (SceneRenderer.js:348-357) and is not in the " +
      "hypothesis set.",
    webgl: {
      openSky: glOpen.hypothesis,
      nearLimb: gl.vantages["near-limb"].hypothesis,
    },
    webgpu: {
      openSky: gpuOpen.hypothesis,
      nearLimb: gpu.vantages["near-limb"].hypothesis,
    },
    nearLimbEvidence: {
      webgl: gl.vantages["near-limb"].evidence,
      webgpu: gpu.vantages["near-limb"].evidence,
    },
    nearLimbState: {
      webgl: gl.vantages["near-limb"].state,
      webgpu: gpu.vantages["near-limb"].state,
    },
    saturationSource: {
      webgl: gl.vantages["near-limb"].saturationSource,
      webgpu: gpu.vantages["near-limb"].saturationSource,
    },
    dynamicLighting: {
      webgl: gl.dynamicLighting,
      webgpu: gpu.dynamicLighting,
    },
    // ROUND-3: the sun is EXTINGUISHED at these elevations on BOTH backends
    // (extinction read byte-identical from the backend-agnostic publisher).
    // WebGPU's zero is the physics; WebGL's residual is the thing needing an
    // explanation, and these two fields decide between the two candidates.
    bloomMechanism: {
      webgl: gl.vantages["near-limb"].bloomMechanism,
      webgpu: gpu.vantages["near-limb"].bloomMechanism,
    },
    bloomCapability: { webgl: gl.bloom, webgpu: gpu.bloom },
    reproducesBankedZero:
      gpu.vantages["near-limb"].annulusSumBase === 0 &&
      gl.vantages["near-limb"].annulusSumBase > 0,
    excluded: [
      "H-GEOM / H-FALLOFF / H-QUANT — the executor measured the WebGPU sun at " +
        "77% of WebGL's luminance at OPEN SKY (1,732,142 vs 2,241,410), so the " +
        "quad, the falloff and the bake depth all work; none of them can be " +
        "geometry-selective at the limb.",
      "Opaque sky shell OCCLUDING the sun — eliminated from source by draw " +
        "order: the sun is binned AFTER the atmosphere (SceneRenderer.js:348-357), " +
        "so the shell cannot cover it. The shell can still SATURATE the " +
        "destination, which is what the saturation lanes attribute.",
      "C12-16 as a cause of the zero — both profiles put alpha 0.16..0.69 in " +
        "the 1.5x..6x annulus and terminate at 8.556 R_sun, outside it.",
      "C12-17 as a cause of the zero — the rgba8unorm 1/255 floor bites only " +
        "beyond 8.199 R_sun, and 256 texels already oversampled the quad.",
    ],
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "sun-glow-profile.json"),
    JSON.stringify(report, null, 2),
  );

  const failed = Object.entries(gates).filter(([, g]) => !g.pass);
  console.log("[probe-sun-glow-profile] gates:");
  for (const [name, g] of Object.entries(gates)) {
    console.log(`  ${g.pass ? "PASS" : "FAIL"} ${name} — ${g.detail}`);
  }
  console.log("[probe-sun-glow-profile] verdict:");
  console.log(`  webgl  near-limb: ${report.verdict.webgl.nearLimb}`);
  console.log(`  webgpu near-limb: ${report.verdict.webgpu.nearLimb}`);
  console.log(
    `  near-limb annulus (base/no-sky*/no-globe): ` +
      `webgl ${r3(gl.vantages["near-limb"].annulusSumBase)}/${r3(gl.vantages["near-limb"].annulusSumNoSky)}/${r3(gl.vantages["near-limb"].annulusSumNoGlobe)}  ` +
      `webgpu ${r3(gpu.vantages["near-limb"].annulusSumBase)}/${r3(gpu.vantages["near-limb"].annulusSumNoSky)}/${r3(gpu.vantages["near-limb"].annulusSumNoGlobe)}  ` +
      `(* no-sky is diagnostic only — extinction-confounded)`,
  );
  console.log(
    `  saturationSource: webgl=${gl.vantages["near-limb"].saturationSource} webgpu=${gpu.vantages["near-limb"].saturationSource}`,
  );
  console.log(
    `  dynamicLighting enum: webgl=${JSON.stringify(gl.dynamicLighting)} webgpu=${JSON.stringify(gpu.dynamicLighting)}`,
  );
  for (const [name, b] of [
    ["webgl", gl.vantages["near-limb"].bloomMechanism],
    ["webgpu", gpu.vantages["near-limb"].bloomMechanism],
  ]) {
    console.log(
      `  ${name} extinguished-step residual (${b.darkSteps} steps): ` +
        `|d|=${r3(b.residualBloomOff)} signed=${r3(b.residualBloomOffSigned)} ` +
        `bloomOn=${r3(b.residualBloomOn)} ratio=${r3(b.bloomOnOverOff)}`,
    );
    console.log(`    -> ${b.verdict}`);
    console.log(`    -> ${b.bloomCall}`);
  }
  console.log(
    `[probe-sun-glow-profile] report: ${path.join(OUT_DIR, "sun-glow-profile.json")}`,
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[probe-sun-glow-profile] STRUCTURAL:", e);
  process.exit(2);
});
