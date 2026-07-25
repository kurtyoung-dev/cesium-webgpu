#!/usr/bin/env node
/* global console, process, window, document, requestAnimationFrame, setTimeout, clearTimeout */
// probe-env-pass-matrix.mjs — C12-G1F1 (WIDENED) environment-pass independence
// matrix, WebGPU vs WebGL.
//
// WHAT THIS GATES
// ---------------
// Every environment element must render independently of which OTHER
// environment elements are shown. `starField.show = false` must hide ONLY the
// star field; a moon-only scene must render the moon; any subset of
// {skyBox, starField, atmosphere, sun, moon, globe} must show exactly that
// subset — matching WebGL semantics exactly.
//
// DEFECT UNDER TEST (root-caused before this probe was written):
//   `View.createPotentiallyVisibleSet` derives the frustum count from the scene
//   near/far accumulated over `frameState.commandList`. Only SkyAtmosphere, Sun
//   and StarField push a binned copy onto that list (StarField only while its
//   daytime fade is non-zero); SkyBox is inject-only and Moon even redirects
//   `frameState.commandList` to a scratch array. On the injection convention
//   (any `scene._alternateSceneRenderer`, i.e. WebGPU) environment commands are
//   injected into the FARTHEST frustum — and `SceneRenderer.executeCommands`
//   skips that injection entirely when `frustumCommandsList.length === 0`,
//   while `WebGPUSceneRenderer.executeCommands` drops the frame outright. So an
//   environment-only frame whose binned-copy emitters all happened to be off
//   produced ZERO frustums and a black canvas. WebGL is unaffected: it executes
//   the environment via `renderEnvironment` BEFORE the frustum loop.
//
// PRE-FIX vs POST-FIX CELL EXPECTATIONS
//   Cells whose WebGPU frame is DROPPED pre-fix (no binned-copy emitter is on,
//   so zero frustums exist): `skybox-only`, `moon-only`, `skybox+moon` in both
//   lanes, plus `all-off` (which is dropped on purpose and asserts nothing).
//   Of those, the cells that FAIL the gate pre-fix — i.e. where WebGL renders a
//   GATED element that WebGPU does not — are:
//     night/`skybox-only`   (stars: WebGL sources > 0, WebGPU 0)
//     night/`moon-only`     (moon)
//     night/`skybox+moon`   (moon + stars)
//     day/`moon-only`       (moon)
//     day/`skybox+moon`     (moon)
//     night `sourceContract` (cubemapOnly ratio 0: WebGPU 0 vs WebGL 1094)
//   day/`skybox-only` is dropped on WebGPU too, but every gated element in that
//   cell is expected ABSENT (stars are not gated in daylight), so it passes
//   vacuously — the night lane is what covers the cubemap.
//   Cells that PASS pre-fix because a binned-copy emitter keeps a frustum
//   alive: `all-on`, `starfield-off`, `starfield-only`, `skybox+starfield`,
//   `atmosphere-only`, `sun-only`, `globe-only`.
//   Post-fix: every cell green on both backends, in both lanes.
//
// LANES (epochs derived in-page from Simon1994 — no hardcoded lucky dates; the
// ground observer is then solved analytically so the moon/sun sit at pinned
// elevations, the probe-moon-atmosphere-appearance pattern):
//   night : moon ~70° up, sun ~20° BELOW the horizon, phaseFraction 0.60-0.78.
//           Star/cubemap sources are visible (no daytime fade); the sky is dark
//           so the atmosphere and globe are NOT asserted in this lane.
//   day   : moon ~70° up, sun ~55° up, phaseFraction 0.10-0.20. The atmosphere
//           and sun are asserted here; star sources are day-faded by design.
//   Both lanes park the moon and sun OUTSIDE the wide sky frame (top edge
//   ~+28°) so the sky-band metric measures the ATMOSPHERE, never a celestial
//   disc or its glare.
//
// THREE MEASUREMENT PASSES PER CELL (one page.evaluate, same settled scene):
//   moonROI : FOV 3° aimed at the moon; ROI from the PROJECTED moonPositionWC
//             plus a limb point (no hardcoded pixels). Presence = the disc
//             stands above its own sky ring.
//   sunROI  : FOV 3° aimed at the sun; ROI from the projected sunPositionWC +
//             solar limb. Presence = same disc-over-ring test.
//   sky     : FOV 60° aimed +10° elevation in the moon azimuth (vertical span
//             ~ -8°..+28°). Sky band = rows 10%..40% (pure sky), ground band =
//             rows 88%..99%. Yields sky mean/median luminance, blue dominance,
//             a strict-local-maximum bright-point census (stars/cubemap), and
//             ground-band statistics (diagnostic only — see below).
//
// ELEMENT PRESENCE PREDICATES (and where each is GATED) — SHAPE-based, see D1:
//   moon       : litFrac >= 0.02 AND maxLitComponentPx >= 200 AND
//                maxLitComponentFrac >= 0.5 AND litFrac >= 6 * ringLitFrac,
//                where "lit" means above max(ringP99 + 20, ringMean + 25, 30)
//   sun        : discMean >= ringMean + 20 AND discMax >= 200 AND
//                absLitFrac >= 0.10 AND absMaxComponentFrac >= 0.5, where
//                "abs-lit" means above the FIXED bar 180 — the sun uses no
//                ring-derived threshold at all (D2 below)
//   atmosphere : skyMean >= 8 AND skyMedian >= 4 AND skyB > 1.05 * skyR
//   stars      : brightPoints >= 3, where the census is the fleet's
//                trust-anchored m1PointSourceCensus algorithm — strict 3x3
//                local maximum, local background = MEDIAN OF AN ANNULUS
//                (r 3..5), accept on `v - bg >= 12` AND `v >= 1.6 * bg` (E2)
//
// D1 — WHY NOT ABSOLUTE LUMINANCE (defect found by the orchestrator's pre-fix
// run, 2026-07-24). The first version asked `discMax >= ringMean + 20 &&
// litFrac > 0.02`. With the TYCHO_T5 skybox (the Batch-742 default bright Milky
// Way render) behind a HIDDEN moon, cubemap pixels inside the 3° ROI cleared
// that bar, so `day skybox-only` and `day skybox+starfield` read moon=true on
// the WebGL reference and correctly tripped this probe's own
// reference-disagreement structural guard (exit 2 instead of the expected RED
// exit 1). Absolute luminance fails in BOTH directions, and the synthetic
// anchors in `env-matrix-shape.spec.mjs` measure exactly that: with NO body, a
// Milky Way band produces a disc/ring mean step of +37 (past any +20 margin);
// with a REAL daylight crescent, the opaque unlit face occludes the bright band
// and the disc reads ~20 LSB DARKER than the ring. Only shape separates them —
// a rendered body is one large contiguous run of pixels above the LOCAL
// background's own bright tail (ring P99), while a star field is speckle whose
// largest component is a couple of pixels and whose lit fraction matches the
// ring's. Measured on the synthetic set: hidden/starfield litFrac 0.003,
// maxComponent 2 px; crescent litFrac 0.076, maxComponent 2599 px, componentFrac
// 1.0. Known limit (geometrically unreachable for a full-sky cubemap at a 3°
// ROI, so not gated): a bright band crossing the disc but NOT the adjacent
// 1.25-1.55r annulus would still read as a body.
//
// D2 — WHY THE SUN IS ABSOLUTE WHERE THE MOON IS RING-RELATIVE (second pre-fix
// run, 2026-07-24). Applying D1's ring-relative bar to the sun inverted it:
// the sun's glare floods its own annulus, ringP99 climbs to near-saturation,
// `max(ringP99 + 20, ...)` rises ABOVE the disc, and litFrac collapses to ~0
// precisely where the sun is brightest. `day sun-only` then read gl=false /
// gpu=true — WebGL's alpha-blended sun fell under the self-raised bar while
// WebGPU's additive blend saturated to 255 and cleared it. Not a renderer
// divergence: an instrument that defeats itself. The sun now classifies lit
// pixels against a FIXED bar (180) and keeps only the scale-free
// `discMean >= ringMean + 20` arm from the ring. That asymmetry is principled,
// not ad hoc: the sun is the brightest object in any scene, so a fixed floor
// has no false-negative mode; the moon is not, and a daylight crescent can sit
// below any fixed level a bright skybox also clears — which is D1. Each body
// gets the only threshold family that is sound for it.
//
// E1/E2 — TWO MORE INSTRUMENT DEFECTS, both "the expectation table
// out-demanding the engine" (fourth pre-fix run, 2026-07-24):
//
//   E1  night/`starfield-only` asserted stars=true, but WebGL censused only ~2
//       sprite points at DEFAULT brightness (parity held: gpu also false). The
//       catalogue sits below any prominence bar at default intensity. Fixed in
//       the CELL, not the bar: that cell — whose entire job is to gate the
//       sprite PATH on its own — now renders at `starField.intensity = 40`.
//       `intensity` is a public, backend-NEUTRAL knob that BOTH feature
//       renderers consume through the same `StarField._effectiveIntensityScale`
//       (`WebGLStarFieldRenderer.js:264`, `WebGPUStarFieldRenderer.ts:596`), so
//       it exercises the identical draw path on both backends and cannot mask a
//       divergence. Every other cell explicitly restores the captured default,
//       so the boost cannot leak. (When the C12 star-brightness default-flip
//       work lands, this boost can drop back to the default.)
//   E2  night/`atmosphere-only` asserted stars=false but BOTH backends read
//       true — again parity-intact, so an instrument artifact. The sky shader
//       draws no point sources at all (`SkyAtmosphere.wgsl` has zero
//       star/twinkle features; its only "star" hits are the demo name "Star
//       Burst"), so the census had to be the culprit: it used a whole-band
//       `median + 25` bar with NO PROMINENCE arm and counted the twilight
//       gradient's dither. Replaced with the fleet's trust-anchored
//       m1PointSourceCensus algorithm rather than a new invention — dither
//       peaks sit 1-2 LSB above their annulus and are rejected, while a real
//       star clears both the +12 prominence and the 1.6x ratio easily.
//
// The atmosphere predicate gained a MEDIAN arm for the same artifact class —
// a diffuse lit sky raises the median, a star field raises only the mean.
//   A LIT atmosphere pushes the sky band and the near-disc ring toward
//   saturation, at which point "disc above ring" and "sky is blue" stop being
//   independent signals. So every predicate EXCEPT `atmosphere` is GATED only
//   on atmosphere-OFF cells; `atmosphere` is gated only in the day lane;
//   `stars` only in the night lane; `sun` only in the day lane. Atmosphere-on
//   cells still record every metric — as diagnostics, marked `diag` in the
//   summary. This costs nothing: the C12-G1F1 defect lives precisely in the
//   sparse (atmosphere-off) configurations, because the atmosphere is one of
//   the three elements that DID keep a frustum alive.
//   The GLOBE is configured in the matrix (it is one of the six toggles and the
//   dominant frustum source) but its pixels are NOT presence-asserted: with the
//   globe hidden, the sky-atmosphere shell still fills the downward band, so a
//   below-horizon luminance test cannot separate "globe" from "atmosphere"
//   without an imagery-dependent texture heuristic. Globe rendering is already
//   gated by capture-and-diff + the globe probes; here `globe-only` earns its
//   keep by asserting that NO environment element renders when only the globe
//   is on. Ground-band stats are reported as diagnostics.
//
// GATE
//   FAIL (exit 1): any (lane, cell, element) where WebGPU presence !==
//     WebGL presence, or a night `sourceContract` cubemap ratio below 0.5
//     (see `evaluateNightSourceContract`).
//   STRUCTURAL (exit 2): a lane/backend never measured, a renderer mismatch, an
//     ROI that would not project, a phase fraction outside its window, the
//     WebGL reference disagreeing with the expected presence table, or the
//     WebGL reference failing the source contract's own sanity floor (the
//     instrument is wrong, not the engine — never gate on a broken reference).
//   PASS (exit 0): otherwise.
//
// PROBE RULES (fleet convention): pinned clock on EVERY scene.render(t);
// bounded sun-direction settle loop; same-task capture (render + getImageData
// with no await between); canvas ELEMENT screenshots; rendererType recorded +
// hard-fail on mismatch; absolute sanity floors so a black canvas cannot
// vacuously pass; unref'd force-exit watchdog (480 s); try/finally close;
// bounded loops everywhere; hard exit codes. EVERY helper used inside a
// page.evaluate callback is defined INSIDE that callback.
//
// PROVENANCE: the built bundle is fingerprinted and searched for the fix token.
// `fixPresent` is REPORTED, not gated — that is what lets the orchestrator run
// this probe against a pre-fix build to capture the red baseline.
//
// Usage: node Tools/visual-regression/probe-env-pass-matrix.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)
//   PROBE_BASE=http://localhost:8080 overrides the server.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const VIEWPORT = { width: 1280, height: 720 };

const HARD_LIMIT_MS = 480000;
const watchdog = setTimeout(() => {
  console.error("[probe-env-pass-matrix] WATCHDOG FIRED (480s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

// ── The matrix. Each cell is the exact enabled subset of the six toggles. ────
const off = () => ({
  skyBox: false,
  starField: false,
  atmosphere: false,
  sun: false,
  moon: false,
  globe: false,
});
const cell = (overrides) => ({ ...off(), ...overrides });

const CELLS = {
  "all-on": cell({
    skyBox: true,
    starField: true,
    atmosphere: true,
    sun: true,
    moon: true,
    globe: true,
  }),
  // "starField off must hide ONLY the star field" in a realistic scene.
  "starfield-off": cell({
    skyBox: true,
    atmosphere: true,
    sun: true,
    moon: true,
    globe: true,
  }),
  // The original C12-G1F1 repro (G1's cubemap-only split).
  "skybox-only": cell({ skyBox: true }),
  // E1 — this is the ONE cell whose job is to gate the sprite PATH on its own,
  // so it renders the catalogue at a boosted `starField.intensity`. At the
  // DEFAULT intensity the Yale sprites census only ~2 points even on WebGL —
  // they sit below any prominence bar — so an unboosted cell would assert an
  // absolute expectation the reference cannot meet (that is exactly how this
  // was found: expected=true, webgl=false, webgpu=false, parity intact).
  // Boosting is honest instrumentation, not a fudge: `intensity` is a public,
  // backend-NEUTRAL knob that both feature renderers consume through the same
  // `StarField._effectiveIntensityScale` field (`WebGLStarFieldRenderer.js:264`,
  // `WebGPUStarFieldRenderer.ts:596`), so it exercises the identical draw path
  // on both backends and cannot mask a divergence. Every other cell explicitly
  // restores the default, so the boost cannot leak.
  "starfield-only": cell({ starField: true, starFieldIntensity: 40 }),
  "skybox+starfield": cell({ skyBox: true, starField: true }),
  // Sparse pair where NEITHER element pushes a binned copy.
  "skybox+moon": cell({ skyBox: true, moon: true }),
  "atmosphere-only": cell({ atmosphere: true }),
  "sun-only": cell({ sun: true }),
  // The Batch-756 blackout, hardened (the star field is off here too).
  "moon-only": cell({ moon: true }),
  "globe-only": cell({ globe: true }),
  "all-off": cell({}),
};

// Canvas screenshots only for the cells that carry the defect signal, so the
// run does not emit 44 full-size PNGs.
const SCREENSHOT_CELLS = new Set([
  "all-on",
  "skybox-only",
  "skybox+moon",
  "moon-only",
  "all-off",
]);

// Candidate element checks per lane. Whether a candidate is actually asserted
// for a given cell is decided by `isMeaningful` below.
const LANE_ELEMENTS = {
  night: ["moon", "stars"],
  day: ["moon", "sun", "atmosphere"],
};

// A lit atmosphere floods the sky band and the near-disc ring toward
// saturation, at which point "disc stands above its ring" and "sky is blue"
// stop being independent signals. So every check EXCEPT the atmosphere check
// itself is asserted only on atmosphere-off cells — which is exactly where the
// C12-G1F1 defect lives (sparse environment configurations). Atmosphere-on
// cells still record full metrics; they are diagnostics, not gates.
function isMeaningful(laneName, cellName, element) {
  const c = CELLS[cellName];
  if (element === "atmosphere") {
    return laneName === "day";
  }
  if (element === "stars") {
    return laneName === "night" && !c.atmosphere;
  }
  if (element === "sun") {
    return laneName === "day" && !c.atmosphere;
  }
  if (element === "moon") {
    return !c.atmosphere;
  }
  return false;
}

// Expected presence per (cell, element), derived from the cell's toggles.
// `stars` is driven by skyBox OR starField — both draw celestial point sources
// and the census cannot (and need not) tell a cubemap star from a sprite star;
// the night source contract below separates them by cell instead.
function expectedPresence(cellName, element) {
  const c = CELLS[cellName];
  if (element === "stars") {
    return c.skyBox || c.starField;
  }
  return c[element] === true;
}

// ── Provenance ──────────────────────────────────────────────────────────────
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function fileFingerprint(p) {
  const bytes = fs.readFileSync(p);
  return {
    path: p.replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}
function provenance() {
  const sourcePath = "packages/engine/Source/Scene/EnvironmentFrustumDemand.ts";
  let source = null;
  try {
    source = fileFingerprint(sourcePath);
  } catch {
    // pre-fix tree — the module does not exist yet; not structural.
  }
  const bundleDir = "Build/CesiumUnminified";
  const candidates = [];
  let bundlePresent = false;
  try {
    for (const name of fs.readdirSync(bundleDir)) {
      if (name.endsWith(".js")) {
        candidates.push(path.join(bundleDir, name));
      }
    }
    const chunksDir = path.join(bundleDir, "chunks");
    if (fs.existsSync(chunksDir)) {
      for (const name of fs.readdirSync(chunksDir)) {
        if (name.endsWith(".js")) {
          candidates.push(path.join(chunksDir, name));
        }
      }
    }
    bundlePresent = candidates.length > 0;
  } catch {
    bundlePresent = false;
  }
  // Fix token — REPORTED, never gated, so a pre-fix baseline run still reaches
  // the cell measurements instead of exiting structural.
  const tokens = ["hasInjectedEnvironmentContent", "needsEnvironmentOnlyFrustum"];
  const hits = {};
  for (const t of tokens) {
    hits[t] = false;
  }
  for (const file of candidates) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const t of tokens) {
      if (!hits[t] && text.includes(t)) {
        hits[t] = true;
      }
    }
  }
  return {
    source,
    bundlePresent,
    fixTokens: hits,
    fixPresent: tokens.every((t) => hits[t]),
  };
}

// ── In-page: derive the two lane epochs from Simon1994 ──────────────────────
// Pure ephemeris math, no rendering. Bounded: 481 samples (60 days, 3 h).
const DERIVE_EPOCHS = async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const sunScratch = new C.Cartesian3();
  const moonScratch = new C.Cartesian3();
  const phaseFractionAt = (t) => {
    const sun = C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      t,
      sunScratch,
    );
    const moon = C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      t,
      moonScratch,
    );
    const cos =
      C.Cartesian3.dot(sun, moon) /
      (C.Cartesian3.magnitude(sun) * C.Cartesian3.magnitude(moon));
    return 0.5 * (1.0 - cos);
  };
  const base = C.JulianDate.fromIso8601("2026-08-01T00:00:00Z");
  // Windows chosen so the observer solve is feasible for the lane's pinned
  // elevations: |zdMoon - zdSun| < gamma < zdMoon + zdSun.
  //   night: zdMoon 20, zdSun 110 ->  90 < gamma < 130  (pf 0.60..0.78)
  //   day  : zdMoon 20, zdSun  35 ->  15 < gamma <  55  (pf 0.10..0.20)
  const lanes = {
    night: { lo: 0.6, hi: 0.78, elMoonDeg: 70, elSunDeg: -20, iso: null, pf: null },
    day: { lo: 0.1, hi: 0.2, elMoonDeg: 70, elSunDeg: 55, iso: null, pf: null },
  };
  const scratchT = new C.JulianDate();
  for (let i = 0; i <= 480; i++) {
    const t = C.JulianDate.addHours(base, i * 3, scratchT);
    const pf = phaseFractionAt(t);
    for (const lane of Object.values(lanes)) {
      if (lane.iso === null && pf > lane.lo && pf < lane.hi) {
        lane.iso = C.JulianDate.toIso8601(t);
        lane.pf = pf;
      }
    }
  }
  return lanes;
};

// ── In-page: pin the clock, settle, solve the ground observer for the lane ──
const SETUP_LANE = async ({ iso, elMoonDeg, elSunDeg, pfWindow }) => {
  // ALL helpers live inside this callback (serialization boundary).
  const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  scene.requestRenderMode = false;
  const T = () => viewer.clock.currentTime;

  scene.backgroundColor = C.Color.BLACK;
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (!scene.moon) {
    scene.moon = new C.Moon();
  }

  // Bounded sun-direction settle (ICRF / earth-orientation load async).
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

  const t = T();
  let icrfToFixed = C.Transforms.computeIcrfToFixedMatrix(t, new C.Matrix3());
  let usedIcrf = true;
  if (!icrfToFixed) {
    icrfToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(t, new C.Matrix3());
    usedIcrf = false;
  }
  const moonPos = C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    t,
    new C.Cartesian3(),
  );
  C.Matrix3.multiplyByVector(icrfToFixed, moonPos, moonPos);
  const moonDir = C.Cartesian3.normalize(moonPos, new C.Cartesian3());
  const sunDir = C.Cartesian3.normalize(
    scene.context.uniformState.sunDirectionWC,
    new C.Cartesian3(),
  );
  const phaseFraction = 0.5 * (1.0 - C.Cartesian3.dot(moonDir, sunDir));
  if (!(phaseFraction > pfWindow[0] && phaseFraction < pfWindow[1])) {
    return { structuralError: `phaseFraction ${r3(phaseFraction)} outside window`, iso };
  }

  // Observer solve: up = a*m + b*s + w*(m x s)/|m x s| with dot(up,m)=sin(elMoon),
  // dot(up,s)=sin(elSun), |up| = 1 (w soaks the norm).
  const sinMoon = Math.sin((elMoonDeg * Math.PI) / 180.0);
  const sinSun = Math.sin((elSunDeg * Math.PI) / 180.0);
  const c = C.Cartesian3.dot(moonDir, sunDir);
  const denom = 1.0 - c * c;
  if (Math.abs(denom) < 1e-6) {
    return { structuralError: "sun/moon directions degenerate", iso };
  }
  const a = (sinMoon - c * sinSun) / denom;
  const b = (sinSun - c * sinMoon) / denom;
  const q = new C.Cartesian3(
    a * moonDir.x + b * sunDir.x,
    a * moonDir.y + b * sunDir.y,
    a * moonDir.z + b * sunDir.z,
  );
  const qLenSq = C.Cartesian3.magnitudeSquared(q);
  if (qLenSq > 1.0) {
    return { structuralError: `observer infeasible (|q|^2=${r3(qLenSq)})`, iso };
  }
  const w = Math.sqrt(Math.max(1.0 - qLenSq, 0.0));
  const cross = C.Cartesian3.normalize(
    C.Cartesian3.cross(moonDir, sunDir, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(
    new C.Cartesian3(q.x + w * cross.x, q.y + w * cross.y, q.z + w * cross.z),
    new C.Cartesian3(),
  );
  const camPos = C.Cartesian3.multiplyByScalar(up, 6378137.0 + 400.0, new C.Cartesian3());

  const toMoon = C.Cartesian3.normalize(
    C.Cartesian3.subtract(moonPos, camPos, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const elMoonActual = 90.0 - (Math.acos(C.Cartesian3.dot(up, toMoon)) * 180.0) / Math.PI;
  const elSunActual = 90.0 - (Math.acos(C.Cartesian3.dot(up, sunDir)) * 180.0) / Math.PI;
  if (
    Math.abs(elMoonActual - elMoonDeg) > 3.5 ||
    Math.abs(elSunActual - elSunDeg) > 3.5
  ) {
    return {
      structuralError: `elevation drift (moon ${r3(elMoonActual)}/${elMoonDeg}, sun ${r3(elSunActual)}/${elSunDeg})`,
      iso,
    };
  }

  // Stash everything the per-cell measurement needs — page.evaluate callbacks
  // do not share module scope, so the shared frame lives on `window`.
  // `defaultStarIntensity` is captured ONCE per page, before any cell has
  // touched it, so the E1 boost in `starfield-only` always restores to the
  // engine default. Re-used across lanes so cell ORDER can never poison it.
  const priorDefault = window.__envMatrix
    ? window.__envMatrix.defaultStarIntensity
    : undefined;
  const defaultStarIntensity =
    priorDefault ??
    (scene.skyBox && scene.skyBox.starField ? scene.skyBox.starField.intensity : 1.0);
  window.__envMatrix = {
    C,
    camPos,
    up,
    moonPos,
    moonDir,
    toMoon,
    sunDir,
    defaultStarIntensity,
  };

  return {
    iso,
    rendererType: scene.context.rendererType,
    usedIcrf,
    phaseFraction,
    elMoonActual,
    elSunActual,
  };
};

// ── In-page: configure one cell and measure all three passes ────────────────
const MEASURE_CELL = async ({ elements, settleFrames }) => {
  const shared = window.__envMatrix;
  if (!shared) {
    return { structuralError: "lane setup did not run" };
  }
  const { C, camPos, up, moonPos } = shared;
  const viewer = window.viewer;
  const scene = viewer.scene;
  const T = () => viewer.clock.currentTime;

  // --- helpers (all inside the callback) ---
  const aimAt = (targetDir, fovDeg) => {
    const seed =
      Math.abs(targetDir.z) < 0.9 ? new C.Cartesian3(0, 0, 1) : new C.Cartesian3(1, 0, 0);
    const right = C.Cartesian3.normalize(
      C.Cartesian3.cross(targetDir, seed, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const camUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(right, targetDir, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.camera.setView({
      destination: camPos,
      orientation: { direction: targetDir, up: camUp },
    });
    scene.camera.frustum.fov = C.Math.toRadians(fovDeg);
    return right;
  };
  const spin = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render(T());
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const lum = (R, G, B) => 0.2126 * R + 0.7152 * G + 0.0722 * B;

  // ==BEGIN shapeStatsFromPixels== (self-contained on purpose: no closure
  // references, so `env-matrix-shape.spec.mjs` can extract this exact text from
  // the probe source and exercise it in Node against synthetic images. Keep it
  // dependency-free — an outer binding here would silently break that anchor.)
  const shapeStatsFromPixels = (data, W, Hh, half, rDev) => {
    const px2lum = (R, G, B) => 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const lumBuf = new Float32Array(W * Hh);
    const inDisc = new Uint8Array(W * Hh);
    const discR2 = rDev * 0.95 * (rDev * 0.95);
    const ringInner2 = rDev * 1.25 * (rDev * 1.25);
    const ringOuter2 = rDev * 1.55 * (rDev * 1.55);
    const ringHist = new Uint32Array(256);
    let discPx = 0;
    let discMax = 0;
    let discSum = 0;
    let ringPx = 0;
    let ringSum = 0;
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const i = 4 * p;
        const l = px2lum(data[i], data[i + 1], data[i + 2]);
        lumBuf[p] = l;
        const dx = x - half;
        const dy = y - half;
        const d2 = dx * dx + dy * dy;
        if (d2 <= discR2) {
          inDisc[p] = 1;
          discPx++;
          discSum += l;
          if (l > discMax) {
            discMax = l;
          }
        } else if (d2 >= ringInner2 && d2 <= ringOuter2) {
          ringPx++;
          ringSum += l;
          ringHist[Math.min(255, Math.max(0, Math.round(l)))]++;
        }
      }
    }
    const ringMean = ringPx > 0 ? ringSum / ringPx : 0;
    let ringP99 = 0;
    if (ringPx > 0) {
      let acc = 0;
      for (let v = 255; v >= 0; v--) {
        acc += ringHist[v];
        if (acc >= ringPx * 0.01) {
          ringP99 = v;
          break;
        }
      }
    }
    // Threshold sits above the background's OWN bright tail, so ordinary
    // cubemap stars inside the ROI are not "lit body" pixels. Absolute floor 30
    // keeps AA/noise out of a genuinely black frame.
    const litThreshold = Math.max(ringP99 + 20, ringMean + 25, 30);

    const litMask = new Uint8Array(W * Hh);
    let litPx = 0;
    let litSum = 0;
    for (let p = 0; p < W * Hh; p++) {
      if (inDisc[p] === 1 && lumBuf[p] > litThreshold) {
        litMask[p] = 1;
        litPx++;
        litSum += lumBuf[p];
      }
    }
    // Same threshold on the ring: with the body HIDDEN the disc and the ring
    // sample the same background, so their lit fractions match.
    let ringLitPx = 0;
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - half;
        const dy = y - half;
        const d2 = dx * dx + dy * dy;
        if (d2 >= ringInner2 && d2 <= ringOuter2 && lumBuf[y * W + x] > litThreshold) {
          ringLitPx++;
        }
      }
    }

    // D2 — the ABSOLUTE-bar mask, for bodies that flood their own ring.
    // The ring-relative bar above is self-defeating for the SUN: its glare
    // saturates the annulus, ringP99 runs to ~255, the bar rises above the disc
    // itself and litFrac collapses to ~0 exactly where the sun is brightest.
    // A fixed bar has no such feedback. It is only sound for a body whose
    // absolute brightness is known a priori (the sun is the brightest thing in
    // any scene); the moon must NOT use it, since a daylight crescent can sit
    // below any fixed bar that a bright skybox also clears.
    const ABS_LIT_BAR = 180;
    const absMask = new Uint8Array(W * Hh);
    let absLitPx = 0;
    for (let p = 0; p < W * Hh; p++) {
      if (inDisc[p] === 1 && lumBuf[p] >= ABS_LIT_BAR) {
        absMask[p] = 1;
        absLitPx++;
      }
    }

    // Largest 4-connected component of a mask (iterative flood fill; each pixel
    // is pushed at most once, so the work is bounded by the ROI area). Mutates
    // the mask it is given — each mask is consumed exactly once.
    const largestComponent = (mask) => {
      let best = 0;
      const stack = new Int32Array(W * Hh);
      for (let seed = 0; seed < W * Hh; seed++) {
        if (mask[seed] !== 1) {
          continue;
        }
        let top = 0;
        stack[top++] = seed;
        mask[seed] = 2;
        let size = 0;
        while (top > 0) {
          const p = stack[--top];
          size++;
          const cx = p % W;
          if (cx > 0 && mask[p - 1] === 1) {
            mask[p - 1] = 2;
            stack[top++] = p - 1;
          }
          if (cx < W - 1 && mask[p + 1] === 1) {
            mask[p + 1] = 2;
            stack[top++] = p + 1;
          }
          if (p >= W && mask[p - W] === 1) {
            mask[p - W] = 2;
            stack[top++] = p - W;
          }
          if (p + W < W * Hh && mask[p + W] === 1) {
            mask[p + W] = 2;
            stack[top++] = p + W;
          }
        }
        if (size > best) {
          best = size;
        }
      }
      return best;
    };

    const maxLitComponentPx = largestComponent(litMask);
    const absMaxComponentPx = largestComponent(absMask);

    return {
      discPx,
      discMax,
      discMean: discPx > 0 ? discSum / discPx : 0,
      ringPx,
      ringMean,
      ringP99,
      litThreshold,
      litPx,
      litFrac: discPx > 0 ? litPx / discPx : 0,
      meanLumLit: litPx > 0 ? litSum / litPx : 0,
      maxLitComponentPx,
      maxLitComponentFrac: litPx > 0 ? maxLitComponentPx / litPx : 0,
      ringLitFrac: ringPx > 0 ? ringLitPx / ringPx : 0,
      absLitBar: ABS_LIT_BAR,
      absLitPx,
      absLitFrac: discPx > 0 ? absLitPx / discPx : 0,
      absMaxComponentPx,
      absMaxComponentFrac: absLitPx > 0 ? absMaxComponentPx / absLitPx : 0,
    };
  };
  // ==END shapeStatsFromPixels==

  // ==BEGIN starCensusFromBand== (self-contained; extracted verbatim by
  // env-matrix-shape.spec.mjs.)
  //
  // E2 — the census is the SAME algorithm as the fleet's trust-anchored
  // `lib/celestial-metrics.mjs` m1PointSourceCensus, ported here because a
  // page.evaluate callback cannot import a module: strict 3x3 local maximum,
  // local background = MEDIAN OF AN ANNULUS (radius 3..5), accept only when
  // `v - bg >= 12` AND `v >= 1.6 * bg`. The earlier home-grown variant kept the
  // local-max test but replaced the annulus with a whole-band `median + 25`
  // bar, i.e. it had no PROMINENCE arm — so on an atmosphere-only night sky it
  // counted the twilight gradient's dither as "stars" (expected=false,
  // webgl=true, webgpu=true, parity intact: an instrument artifact, not a
  // render). The sky shader draws no point sources — `SkyAtmosphere.wgsl` has
  // zero star/twinkle features; every "star" hit in it is the demo-name string
  // "Star Burst" — so those census points had no legitimate source. Prominence
  // separates the two classes cleanly: a real star is an isolated peak tens of
  // LSB above its annulus, while dither peaks sit 1-2 LSB above theirs and a
  // smooth gradient produces no strict maxima at all.
  const starCensusFromBand = (data, W, H) => {
    const px2lum = (R, G, B) => 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const MIN_PROMINENCE = 12; // m1's 12/255, on the 0-255 scale
    const PEAK_RATIO = 1.6; // m1's peakRatio
    const INNER = 3;
    const OUTER = 5;
    const lumBuf = new Float32Array(W * H);
    const hist = new Uint32Array(256);
    let sumL = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let i = 0, p = 0; p < W * H; p++, i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const l = px2lum(R, G, B);
      lumBuf[p] = l;
      hist[Math.min(255, Math.max(0, Math.round(l)))]++;
      sumL += l;
      sumR += R;
      sumG += G;
      sumB += B;
    }
    const total = W * H;
    let acc = 0;
    let median = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= total * 0.5) {
        median = v;
        break;
      }
    }

    // Annulus offset stencil, precomputed once (m1's approach).
    const annulus = [];
    for (let dy = -OUTER; dy <= OUTER; dy++) {
      for (let dx = -OUTER; dx <= OUTER; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= INNER && d <= OUTER) {
          annulus.push(dy * W + dx);
        }
      }
    }
    const ring = new Float64Array(annulus.length);
    let brightPoints = 0;
    let brightPeak = 0;
    for (let y = OUTER; y < H - OUTER; y++) {
      for (let x = OUTER; x < W - OUTER; x++) {
        const p = y * W + x;
        const v = lumBuf[p];
        // Strict 3x3 local maximum: every neighbour must be strictly lower.
        let isMax = true;
        for (let ny = -1; ny <= 1 && isMax; ny++) {
          for (let nx = -1; nx <= 1; nx++) {
            if (nx === 0 && ny === 0) {
              continue;
            }
            if (lumBuf[p + ny * W + nx] >= v) {
              isMax = false;
              break;
            }
          }
        }
        if (!isMax) {
          continue;
        }
        for (let k = 0; k < annulus.length; k++) {
          ring[k] = lumBuf[p + annulus[k]];
        }
        ring.sort();
        const mid = ring.length >> 1;
        const bg =
          ring.length % 2 === 1 ? ring[mid] : 0.5 * (ring[mid - 1] + ring[mid]);
        if (v - bg >= MIN_PROMINENCE && v >= PEAK_RATIO * bg) {
          brightPoints++;
          if (v > brightPeak) {
            brightPeak = v;
          }
        }
      }
    }
    return {
      mean: sumL / total,
      median,
      meanR: sumR / total,
      meanG: sumG / total,
      meanB: sumB / total,
      brightPoints,
      brightPeak,
      minProminence: MIN_PROMINENCE,
      peakRatio: PEAK_RATIO,
    };
  };
  // ==END starCensusFromBand==

  // Disc ROI statistics for a body at `worldPos` with radius `bodyRadius`.
  // Returns null-ish structural info when the ROI cannot be formed.
  const discStats = (worldPos, bodyRadius) => {
    scene.render(T());
    const center = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      worldPos,
      new C.Cartesian2(),
    );
    if (!center) {
      return { roiError: "center did not project" };
    }
    const toBody = C.Cartesian3.normalize(
      C.Cartesian3.subtract(worldPos, camPos, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const seed =
      Math.abs(toBody.z) < 0.9 ? new C.Cartesian3(0, 0, 1) : new C.Cartesian3(1, 0, 0);
    const limbDir = C.Cartesian3.normalize(
      C.Cartesian3.cross(toBody, seed, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const limbWorld = C.Cartesian3.add(
      worldPos,
      C.Cartesian3.multiplyByScalar(limbDir, bodyRadius, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const limb = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      limbWorld,
      new C.Cartesian2(),
    );
    if (!limb) {
      return { roiError: "limb did not project" };
    }
    const canvas = scene.canvas;
    const dprX = canvas.width / canvas.clientWidth;
    const dprY = canvas.height / canvas.clientHeight;
    const cx = center.x * dprX;
    const cy = center.y * dprY;
    const rDev = Math.hypot(limb.x - center.x, limb.y - center.y) * Math.max(dprX, dprY);
    const half = Math.ceil(rDev * 1.7);
    const x0 = Math.round(cx - half);
    const y0 = Math.round(cy - half);
    if (
      !(
        rDev >= 3 &&
        x0 >= 0 &&
        y0 >= 0 &&
        x0 + 2 * half < canvas.width &&
        y0 + 2 * half < canvas.height
      )
    ) {
      return { roiError: `ROI invalid (r=${rDev} at ${cx},${cy})` };
    }
    // SAME-TASK capture: render then read with no await between.
    scene.render(T());
    const tmp = document.createElement("canvas");
    tmp.width = 2 * half + 1;
    tmp.height = 2 * half + 1;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, x0, y0, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
    const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    // D1 (orchestrator pre-fix run): an ABSOLUTE-luminance disc test
    // false-positived on the TYCHO_T5 skybox — its bright Milky Way pixels land
    // inside the 3° body ROI and cleared `discMax >= ringMean + 20` with the
    // body HIDDEN. The statistics are now SHAPE-based and live in the
    // dependency-free `shapeStatsFromPixels` above (extracted verbatim by
    // env-matrix-shape.spec.mjs and exercised against synthetic images).
    return {
      discRadiusPx: rDev,
      ...shapeStatsFromPixels(data, tmp.width, tmp.height, half, rDev),
    };
  };

  // --- apply the cell's toggles ---
  if (scene.skyBox) {
    scene.skyBox.show = elements.skyBox === true;
    if (scene.skyBox.starField) {
      scene.skyBox.starField.show = elements.starField === true;
      // E1 — ALWAYS assigned, so a boosted cell cannot leak into the next one.
      // `defaultStarIntensity` is captured before any cell runs.
      scene.skyBox.starField.intensity =
        elements.starFieldIntensity ?? shared.defaultStarIntensity;
    }
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = elements.atmosphere === true;
  }
  if (scene.sun) {
    scene.sun.show = elements.sun === true;
  }
  if (scene.moon) {
    scene.moon.show = elements.moon === true;
  }
  if (scene.globe) {
    scene.globe.show = elements.globe === true;
  }

  // --- pass 1: moon disc ---
  const toMoon = C.Cartesian3.normalize(
    C.Cartesian3.subtract(moonPos, camPos, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  aimAt(toMoon, 3.0);
  await spin(settleFrames);
  const moonROI = discStats(moonPos, C.Ellipsoid.MOON.maximumRadius);

  // --- pass 2: sun disc ---
  const sunPos = C.Cartesian3.clone(
    scene.context.uniformState.sunPositionWC,
    new C.Cartesian3(),
  );
  const toSun = C.Cartesian3.normalize(
    C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  aimAt(toSun, 3.0);
  await spin(settleFrames);
  // Solar photospheric radius (m) — fixed physical constant, not an engine value.
  const sunROI = discStats(sunPos, 6.957e8);

  // --- pass 3: wide sky ---
  // Aim +10 deg elevation in the moon azimuth: vertical span ~ -8..+28 deg at
  // 60 deg horizontal FOV on a 16:9 frame, so the moon (70 deg) and sun (55 or
  // -20 deg) are both outside the frame.
  const horiz = C.Cartesian3.normalize(
    C.Cartesian3.subtract(
      toMoon,
      C.Cartesian3.multiplyByScalar(up, C.Cartesian3.dot(toMoon, up), new C.Cartesian3()),
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  const el = (10.0 * Math.PI) / 180.0;
  const skyDir = C.Cartesian3.normalize(
    new C.Cartesian3(
      horiz.x * Math.cos(el) + up.x * Math.sin(el),
      horiz.y * Math.cos(el) + up.y * Math.sin(el),
      horiz.z * Math.cos(el) + up.z * Math.sin(el),
    ),
    new C.Cartesian3(),
  );
  aimAt(skyDir, 60.0);
  await spin(settleFrames);

  // SAME-TASK capture of both bands.
  scene.render(T());
  const canvas = scene.canvas;
  const skyY0 = Math.floor(canvas.height * 0.06);
  const skyH = Math.floor(canvas.height * 0.4);
  const gndY0 = Math.floor(canvas.height * 0.88);
  const gndH = Math.max(1, Math.floor(canvas.height * 0.11));
  const band = document.createElement("canvas");
  band.width = canvas.width;
  band.height = skyH + gndH;
  const bctx = band.getContext("2d");
  bctx.drawImage(canvas, 0, skyY0, canvas.width, skyH, 0, 0, canvas.width, skyH);
  bctx.drawImage(canvas, 0, gndY0, canvas.width, gndH, 0, skyH, canvas.width, gndH);
  const skyData = bctx.getImageData(0, 0, canvas.width, skyH).data;
  const gndData = bctx.getImageData(0, skyH, canvas.width, gndH).data;

  const W = canvas.width;
  const H = skyH;
  const census = starCensusFromBand(skyData, W, H);
  const { mean: skyMeanL, median, meanR, meanG, meanB, brightPoints, brightPeak } = census;

  // Ground band (diagnostic only).
  let gSum = 0;
  let gSumSq = 0;
  const gTotal = W * gndH;
  for (let i = 0, p = 0; p < gTotal; p++, i += 4) {
    const l = lum(gndData[i], gndData[i + 1], gndData[i + 2]);
    gSum += l;
    gSumSq += l * l;
  }
  const gMean = gTotal > 0 ? gSum / gTotal : 0;
  const gVar = gTotal > 0 ? Math.max(0, gSumSq / gTotal - gMean * gMean) : 0;

  return {
    rendererType: scene.context.rendererType,
    moonROI,
    sunROI,
    sky: {
      mean: skyMeanL,
      median,
      meanR,
      meanG,
      meanB,
      brightPoints,
      brightPeak,
    },
    ground: { mean: gMean, stdDev: Math.sqrt(gVar) },
  };
};

// ── Presence predicates (Node side, shared by both backends) ────────────────
//
// D1 fix. The MOON predicate must survive a bright textured skybox behind a
// HIDDEN moon (TYCHO_T5 Milky Way pixels inside the 3° ROI) while still firing
// on a thin daylight crescent (pf 0.10-0.20) that can be DARKER on average than
// that same skybox — the moon is opaque, so its unlit limb occludes the bright
// background. That rules out any mean- or max-based absolute test in either
// direction. What separates them is SHAPE: a rendered crescent is one large
// contiguous run of pixels well above the local background's bright tail, and
// the surrounding ring has no comparable population. Hence all four of:
//   * litFrac >= 0.02              — some fraction of the disc is genuinely lit
//   * maxLitComponentPx >= 200     — that fraction is a blob, not speckle
//   * maxLitComponentFrac >= 0.5   — and it is ONE blob, not scattered stars
//   * litFrac >= 6 * ringLitFrac   — the ring, sampling the same background,
//                                    has no such population
// The SUN cannot use ANY ring-derived statistic (D2, found by the orchestrator's
// second pre-fix run). Its glare legitimately floods the annulus, so ringP99
// runs to near-saturation, the ring-relative bar rises ABOVE the disc, and
// litFrac collapses to ~0 exactly where the sun is brightest — WebGL's
// alpha-blended sun read ABSENT while WebGPU's additive blend saturated to 255
// and squeaked past the same bar. The threshold defeats itself. The sun
// therefore classifies lit pixels against a FIXED bar (`absLitBar` = 180),
// which is sound for it and only for it: the sun is the brightest thing in any
// scene, so an absolute floor has no false-negative mode. The MOON must never
// use that bar — a daylight crescent can sit below any fixed level a bright
// skybox also clears (D1), which is why it stays ring-relative. The scale-free
// `discMean >= ringMean + 20` arm is kept for the sun: it is what a star field
// cannot fake, since a background's disc and ring means are equal by
// construction.
// ==BEGIN presenceOf== (extracted verbatim by env-matrix-shape.spec.mjs — this
// module cannot be imported from a spec because its top-level IIFE launches a
// browser, so keep this function self-contained too.)
function presenceOf(measurement) {
  const moon = measurement.moonROI;
  const sun = measurement.sunROI;
  const sky = measurement.sky;
  const usable = (roi) => !!roi && !roi.roiError && roi.discPx > 0;
  return {
    moon:
      usable(moon) &&
      moon.litFrac >= 0.02 &&
      moon.maxLitComponentPx >= 200 &&
      moon.maxLitComponentFrac >= 0.5 &&
      moon.litFrac >= 6 * moon.ringLitFrac,
    sun:
      usable(sun) &&
      sun.discMean >= sun.ringMean + 20 &&
      sun.discMax >= 200 &&
      sun.absLitFrac >= 0.1 &&
      sun.absMaxComponentFrac >= 0.5,
    // A diffuse lit sky raises the MEDIAN; a star field raises the mean through
    // sparse bright pixels while its median stays at the black floor. Requiring
    // both (plus Rayleigh blue dominance) keeps a bright cubemap from reading as
    // atmosphere — the same absolute-luminance artifact class as D1.
    atmosphere: !!sky && sky.mean >= 8 && sky.median >= 4 && sky.meanB > sky.meanR * 1.05,
    // The star census is background-RELATIVE and now PROMINENCE-based (E2): it
    // is the fleet's trust-anchored m1PointSourceCensus algorithm — strict 3x3
    // local maximum, annulus-median local background, `v - bg >= 12` and
    // `v >= 1.6 * bg`. A bright Milky Way raises its own local background, so
    // the D1 artifact does not apply; dither on a lit twilight sky has ~1-2 LSB
    // prominence and is rejected, which is what E2 fixed.
    stars: !!sky && sky.brightPoints >= 3,
  };
}
// ==END presenceOf==

// ==BEGIN evaluateNightSourceContract== (extracted verbatim by
// env-matrix-shape.spec.mjs — keep it self-contained.)
//
// The direct "starField off hides ONLY the star field" assertion: the CUBEMAP
// must survive the sprite toggle. Calibrated (D3) to what the WebGL reference
// DEMONSTRABLY delivers at this vantage, measured on the orchestrator's pre-fix
// run: webgl { cubemapOnly: 1094, spritesOnly: 2, both: 1094 }.
//
// `spritesOnly` is INFORMATIONAL and must never gain an `ok` arm. WebGL's own
// catalog star field registers just 2 census points here: at default brightness
// the Yale-catalog sprites sit BELOW the census bar (pointThreshold =
// median + 25), which is the known t3/t5 star-brightness behavior at defaults —
// expected, not an error. An earlier revision demanded `spritesOnly >= 3` and
// structurally failed the reference itself; `env-matrix-shape.spec.mjs` pins the
// measured value so that expectation cannot silently drift back above what
// WebGL delivers. (The sprite path is not left unguarded: the per-cell
// `starfield-only` and `skybox+starfield` presence rows gate it cross-backend.)
//
// The whole G1F1 signal lives in the cubemap arm — pre-fix WebGPU cubemapOnly
// is 0 against WebGL's 1094; post-fix it must return to parity.
function evaluateNightSourceContract(counts) {
  const SOURCE_FLOOR = 200; // WebGL cubemapOnly sanity floor (measured 1094)
  const RATIO_FLOOR = 0.5; // webgpu/webgl cubemapOnly gate (pre-fix 0, post-fix ~1)
  const gl = counts.webgl ?? {};
  const gpu = counts.webgpu ?? {};
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  // Reference sanity: enough cubemap sources to be a meaningful census, and
  // adding sprites must not REMOVE any (the ordering claim itself).
  const referenceOk =
    finite(gl.cubemapOnly) &&
    gl.cubemapOnly >= SOURCE_FLOOR &&
    finite(gl.both) &&
    gl.both >= gl.cubemapOnly;
  const ratio =
    finite(gl.cubemapOnly) && gl.cubemapOnly > 0 && finite(gpu.cubemapOnly)
      ? gpu.cubemapOnly / gl.cubemapOnly
      : null;
  return {
    sourceFloor: SOURCE_FLOOR,
    ratioFloor: RATIO_FLOOR,
    webgl: { cubemapOnly: gl.cubemapOnly ?? null, both: gl.both ?? null },
    webgpu: { cubemapOnly: gpu.cubemapOnly ?? null, both: gpu.both ?? null },
    cubemapOnlyRatio_webgpu_over_webgl: ratio,
    spritesOnly_INFORMATIONAL: {
      webgl: gl.spritesOnly ?? null,
      webgpu: gpu.spritesOnly ?? null,
      note: "not gated — catalog sprites sit below the census bar at default brightness",
    },
    referenceOk,
    gateOk: ratio !== null && ratio >= RATIO_FLOOR,
  };
}
// ==END evaluateNightSourceContract==

async function runBackend(browser, renderer, lanes) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  const out = { renderer, lanes: {}, consoleErrors };
  try {
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.waitForFunction(
      () => !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(4000);

    for (const [laneName, lane] of Object.entries(lanes)) {
      const setup = await page.evaluate(SETUP_LANE, {
        iso: lane.iso,
        elMoonDeg: lane.elMoonDeg,
        elSunDeg: lane.elSunDeg,
        pfWindow: [lane.lo, lane.hi],
      });
      const laneOut = { setup, cells: {} };
      out.lanes[laneName] = laneOut;
      if (setup.structuralError) {
        continue;
      }
      if (setup.rendererType && setup.rendererType !== renderer) {
        out.backendMismatch = `requested ${renderer}, got ${setup.rendererType}`;
        continue;
      }
      for (const [cellName, elements] of Object.entries(CELLS)) {
        const m = await page.evaluate(MEASURE_CELL, { elements, settleFrames: 8 });
        laneOut.cells[cellName] = m;
        if (m && m.rendererType && m.rendererType !== renderer) {
          out.backendMismatch = `requested ${renderer}, got ${m.rendererType}`;
        }
        if (SCREENSHOT_CELLS.has(cellName)) {
          const canvasHandle = await page.$("canvas");
          if (canvasHandle) {
            await canvasHandle
              .screenshot({
                path: path.join(
                  OUT_DIR,
                  `env-pass-matrix-${laneName}-${cellName.replaceAll("+", "-")}-${renderer}.png`,
                ),
              })
              .catch(() => {});
          }
        }
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

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prov = provenance();
  if (!prov.bundlePresent) {
    console.error(
      "[probe-env-pass-matrix] STRUCTURAL — Build/CesiumUnminified is missing; run `npx gulp build`",
    );
    clearTimeout(watchdog);
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let lanes;
  let gl;
  let gpu;
  try {
    const derivePage = await (await browser.newContext()).newPage();
    await derivePage.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    lanes = await derivePage.evaluate(DERIVE_EPOCHS);
    await derivePage
      .context()
      .close()
      .catch(() => {});
    for (const [name, lane] of Object.entries(lanes)) {
      if (!lane.iso) {
        console.error(`[probe-env-pass-matrix] no epoch found for lane ${name}`);
        clearTimeout(watchdog);
        process.exit(2);
      }
      console.log(`lane ${name}: ${lane.iso} (phaseFraction ${r3(lane.pf)})`);
    }
    gl = await runBackend(browser, "webgl", lanes);
    gpu = await runBackend(browser, "webgpu", lanes);
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  let structural = !!(gl.error || gpu.error || gl.backendMismatch || gpu.backendMismatch);
  const structuralNotes = [];
  if (gl.error) {
    structuralNotes.push(`webgl: ${gl.error}`);
  }
  if (gpu.error) {
    structuralNotes.push(`webgpu: ${gpu.error}`);
  }
  if (gl.backendMismatch) {
    structuralNotes.push(`webgl: ${gl.backendMismatch}`);
  }
  if (gpu.backendMismatch) {
    structuralNotes.push(`webgpu: ${gpu.backendMismatch}`);
  }

  let anyFail = false;
  const laneReports = {};
  for (const laneName of Object.keys(lanes)) {
    const glLane = gl.lanes[laneName];
    const gpuLane = gpu.lanes[laneName];
    const report = { cells: {} };
    laneReports[laneName] = report;
    if (!glLane || !gpuLane || glLane.setup.structuralError || gpuLane.setup.structuralError) {
      report.structural = {
        webgl: glLane ? (glLane.setup.structuralError ?? "missing") : "missing",
        webgpu: gpuLane ? (gpuLane.setup.structuralError ?? "missing") : "missing",
      };
      structural = true;
      continue;
    }
    report.setup = {
      iso: glLane.setup.iso,
      phaseFraction: r3(glLane.setup.phaseFraction),
      elMoon: r3(glLane.setup.elMoonActual),
      elSun: r3(glLane.setup.elSunActual),
    };

    const laneElements = LANE_ELEMENTS[laneName];
    const starCounts = { webgl: {}, webgpu: {} };
    for (const cellName of Object.keys(CELLS)) {
      const a = glLane.cells[cellName];
      const b = gpuLane.cells[cellName];
      const entry = { elements: CELLS[cellName] };
      report.cells[cellName] = entry;
      if (!a || a.structuralError || !b || b.structuralError) {
        entry.structural = {
          webgl: a ? (a.structuralError ?? null) : "missing",
          webgpu: b ? (b.structuralError ?? null) : "missing",
        };
        structural = true;
        continue;
      }
      const pa = presenceOf(a);
      const pb = presenceOf(b);
      starCounts.webgl[cellName] = a.sky.brightPoints;
      starCounts.webgpu[cellName] = b.sky.brightPoints;

      const perElement = {};
      let cellPass = true;
      let asserted = 0;
      for (const element of laneElements) {
        const expected = expectedPresence(cellName, element);
        const meaningful = isMeaningful(laneName, cellName, element);
        const parity = pa[element] === pb[element];
        const webglOk = pa[element] === expected;
        if (meaningful) {
          asserted++;
          if (!webglOk) {
            // A broken reference is an instrument failure, never an engine gate.
            structural = true;
          }
          if (!parity) {
            cellPass = false;
          }
        }
        perElement[element] = {
          asserted: meaningful,
          expected,
          webgl: pa[element],
          webgpu: pb[element],
          referenceOk: webglOk,
          parity,
        };
      }
      entry.perElement = perElement;
      entry.assertedChecks = asserted;
      entry.PASS = cellPass;
      // Every term of the shape-based presence predicates is reported, so a
      // future disagreement names its own failing arm without a re-run.
      const metricsFor = (m) => ({
        moon: {
          discMean: r3(m.moonROI.discMean),
          discMax: r3(m.moonROI.discMax),
          ringMean: r3(m.moonROI.ringMean),
          ringP99: r3(m.moonROI.ringP99),
          litThreshold: r3(m.moonROI.litThreshold),
          litFrac: r3(m.moonROI.litFrac),
          maxLitComponentPx: m.moonROI.maxLitComponentPx ?? null,
          maxLitComponentFrac: r3(m.moonROI.maxLitComponentFrac),
          ringLitFrac: r3(m.moonROI.ringLitFrac),
          roiError: m.moonROI.roiError ?? null,
        },
        sun: {
          discMean: r3(m.sunROI.discMean),
          discMax: r3(m.sunROI.discMax),
          ringMean: r3(m.sunROI.ringMean),
          ringP99: r3(m.sunROI.ringP99),
          absLitBar: m.sunROI.absLitBar ?? null,
          absLitFrac: r3(m.sunROI.absLitFrac),
          absMaxComponentFrac: r3(m.sunROI.absMaxComponentFrac),
          // Ring-relative terms retained as DIAGNOSTICS only — D2 proved they
          // are unusable for the sun (its own glare raises the bar past its
          // disc). The sun predicate no longer reads them.
          litThreshold_DIAGNOSTIC: r3(m.sunROI.litThreshold),
          litFrac_DIAGNOSTIC: r3(m.sunROI.litFrac),
          roiError: m.sunROI.roiError ?? null,
        },
        sky: {
          mean: r3(m.sky.mean),
          median: m.sky.median,
          rOverB: r3(m.sky.meanB > 0 ? m.sky.meanR / m.sky.meanB : null),
          brightPoints: m.sky.brightPoints,
          brightPeak: r3(m.sky.brightPeak),
        },
        ground: { mean: r3(m.ground.mean), stdDev: r3(m.ground.stdDev) },
      });
      entry.metrics = { webgl: metricsFor(a), webgpu: metricsFor(b) };
      if (!cellPass) {
        anyFail = true;
      }
    }

    // "starField off hides ONLY the star field" — evaluated on the clean night
    // triplet by the extractable pure predicate below.
    if (laneName === "night") {
      const contract = evaluateNightSourceContract({
        webgl: {
          cubemapOnly: starCounts.webgl["skybox-only"],
          spritesOnly: starCounts.webgl["starfield-only"],
          both: starCounts.webgl["skybox+starfield"],
        },
        webgpu: {
          cubemapOnly: starCounts.webgpu["skybox-only"],
          spritesOnly: starCounts.webgpu["starfield-only"],
          both: starCounts.webgpu["skybox+starfield"],
        },
      });
      // Reference-disagreement stays STRUCTURAL; the cross-backend arm is the
      // gate. Never let a broken reference read as an engine failure.
      if (!contract.referenceOk) {
        structural = true;
      } else if (!contract.gateOk) {
        anyFail = true;
      }
      report.sourceContract = contract;
    }
  }

  const GATE = structural
    ? "STRUCTURAL — a lane/cell never reached a valid measurement, or the WebGL reference disagreed with the expected presence table"
    : anyFail
      ? "FAIL — WebGPU drops (or adds) an environment element that WebGL renders"
      : "PASS — every environment element renders independently of the others on both backends";

  const manifest = {
    probe: "probe-env-pass-matrix",
    task: "C12-G1F1 (widened)",
    date: new Date().toISOString(),
    provenance: prov,
    viewport: VIEWPORT,
    lanes: laneReports,
    structuralNotes,
    GATE,
    raw: { gl, gpu },
  };
  const outPath = path.join(OUT_DIR, "env-pass-matrix.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  const summary = {
    fixPresentInBuild: prov.fixPresent,
    lanes: Object.fromEntries(
      Object.entries(laneReports).map(([name, rep]) => [
        name,
        {
          setup: rep.setup ?? null,
          structural: rep.structural ?? null,
          cells: Object.fromEntries(
            Object.entries(rep.cells).map(([c, e]) => [
              c,
              e.perElement
                ? {
                    PASS: e.PASS,
                    ...Object.fromEntries(
                      Object.entries(e.perElement).map(([el, v]) => [
                        el,
                        `${v.asserted ? "GATED" : "diag"} ${v.expected ? "expect" : "expect-no"} | gl=${v.webgl} gpu=${v.webgpu}`,
                      ]),
                    ),
                  }
                : { structural: e.structural },
            ]),
          ),
          sourceContract: rep.sourceContract ?? null,
        },
      ]),
    ),
    GATE,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[full report: ${outPath}]`);

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-env-pass-matrix] FATAL", e);
  clearTimeout(watchdog);
  process.exit(2);
});
