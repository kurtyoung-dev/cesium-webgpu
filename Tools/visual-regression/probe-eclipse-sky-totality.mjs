// C12-29 S6 (SKY HALF) — the totality sky: obs-1, the E3 default flip, the
// star reveal, and the 360-degree horizon twilight.
//
// THREE LANES, each an EQUIVALENCE or an ALGEBRAIC RECOVERY. No predictive
// model of the sky pipeline appears anywhere in this file: S2 burned three
// rounds on display gamma -> PBR-Neutral shoulder -> background reveal, each
// explaining part of a band and leaking elsewhere, and its own terminal
// finding is that the shell's response to `atmosphereLightIntensity` is
// strongly SUB-LINEAR in the bright regime. So every gate below compares two
// renders that differ in exactly one thing, or solves for an unknown that
// enters the compositing equation linearly.
//
//   LANE D — SHIPPED DEFAULTS, ground, clear night. Runs FIRST, before any
//     scene mutation, and verifies the visible consequence of deleting
//     WebGPU's duplicate binned star command. The one remaining cached command
//     is returned through the same pre-atmosphere slot WebGL uses, so WebGPU
//     moves from "sprites visible" to "sprites hidden" wherever the shell is
//     opaque. That is CONVERGENCE if and only if WebGL hides them there too —
//     so the lane measures the shell alpha algebraically on BOTH backends.
//     Sparse point-source and cubemap differences survive as diagnostics, but
//     are not compared as though they were equivalent instruments. The
//     exactly-once command contract is established directly in lane B4.
//
//   LANE A — obs-1, the shell's ALPHA, recovered algebraically.
//     The sky shell composites ALPHA_BLEND over whatever is behind it on both
//     backends. Render the same frame over two known backgrounds (black and
//     white) and the per-pixel result is `out = a*src + (1-a)*dst`, so
//         out_white - out_black = (1 - a)
//     exactly, with `a*src` cancelling — no tonemap, no gamma, no scattering
//     model survives the subtraction. A CONTROL pass with the shell hidden
//     measures the same difference with `a = 0`; if it is not ~1 the
//     background instrument itself is broken on that backend and the run is
//     STRUCTURAL, never a gate failure.
//
//     Pre-fix prediction, stated here so the run either confirms or refutes
//     it: WebGL recovers a LOW alpha in the anti-solar sky (its shell gets
//     SCENE_LIGHT from the globe flags, so `nightAlpha` -> 0 there and
//     `alpha = mix(color.b, 1, 0) = color.b`), while WebGPU recovers ~1.0
//     (its shell got NONE, `nightAlpha` is pinned at 1, and a ground camera's
//     `altitudeOpacity` is 1, so `alpha = mix(color.b, 1, 1) = 1`). That is
//     obs-1: an opaque WebGPU shell with the star cubemap behind it.
//
//   LANE B — the E3 multiplier reaches pixels, on both backends.
//     The star modulation is a pure multiply on the cubemap. Render the SAME
//     pinned frame twice, changing ONLY `starModulationCurve` so the factor
//     goes from 1.0 to a chosen k, and the star-band mean must scale by k.
//     The two paths differ in one number and nothing else, so the ratio is
//     the multiplier itself. Then the reveal: at a pinned totality instant,
//     eclipse ON must census MORE point sources than eclipse OFF.
//
//     And (b4) THE CATALOGUE MUST BE SCHEDULED EXACTLY ONCE. Before S6,
//     WebGPU emitted one binned command and one returned command. The probe
//     now counts both publication routes after a real render: one returned
//     environment command, zero command-list copies, and no command at all
//     when the field is hidden. This is deterministic and cannot pass on a
//     star-free region of interest.
//
//   LANE C — the 360-degree twilight, measured as a DIFFERENCE IMAGE.
//     Per azimuth, render with `enableEclipseHorizonTwilight` true and false
//     at the same pinned instant. The difference IS the added term. Gates:
//     present at every azimuth (the "360" claim), confined to the horizon
//     band (zero above 22.6 deg), warm (dR > dB), and EXACTLY zero at a
//     non-eclipse instant (the off-position identity).
//
// FLEET RULES OBSERVED: pinned clock on every render; bounded settle loops;
// same-task canvas capture (data URLs read inside the evaluate that rendered
// them); canvas-ELEMENT PNGs; rendererType hard-fail; numeral-free provenance
// markers (esbuild rewrites `1.0` -> `1`); absolute sanity floors so an
// all-black canvas FAILS; unref'd watchdog; exit codes 0 pass / 1 gate fail /
// 2 structural; every helper used inside a page.evaluate defined INSIDE it.
//
// Usage: node Tools/visual-regression/probe-eclipse-sky-totality.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import {
  FIXTURE_MIN_SUN_ELEV_DEG,
  FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
  selectEclipseFixture,
  shortlistVantages,
} from "./lib/eclipse-fixture-constraints.mjs";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const HARD_LIMIT_MS = 480000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-eclipse-sky-totality] WATCHDOG FIRED (480s) — forcing exit",
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

// The engine's totality floor, recomputed from the two published illuminance
// figures rather than imported, so a silent retune fails here instead of
// riding along.
const ECLIPSE_TWILIGHT_FLOOR = Math.pow(5.0 / 100000.0, 1.0 / 3.0);

// Lane B's chosen probe factor. 0.5 is far from both endpoints of the curve,
// so neither clamp can manufacture it.
const LANE_B_TARGET_FACTOR = 0.5;

// A background-control failure has ONE known engine cause, and naming it is
// the difference between "this probe is broken" and "this probe is blocked".
// Bisected by the executor at Batch 766 v2: on WebGPU, with all environment
// content hidden INCLUDING the sun, the band renders black and
// `scene.backgroundColor` is never applied, so a black->white swap moves
// nothing (1 -> 0 exactly at `sun.show = false`; WebGL unaffected at every
// step). That is a NEW-WEBGPU-ENV-PASS-DROP member that Batch 761's
// env-frustum root fix does not cover. This probe no longer hides the sun, so
// it should not reach that state — but if the control still fails, the reason
// says so rather than leaving the next reader to re-bisect it.
const BLOCKED_BY_ENV_PASS_DROP =
  " — if this persists, suspect NEW-WEBGPU-ENV-PASS-DROP (C12-G1F1 family," +
  " the member not covered by Batch 761's env-frustum fix): WebGPU renders" +
  " the band black and never applies scene.backgroundColor when all" +
  " environment content is hidden. BLOCKED-BY-ENGINE, not a probe defect;" +
  " this probe keeps scene.sun.show = true specifically to avoid that state.";

// ── Provenance ─────────────────────────────────────────────────────────────
const SOURCE_FILES = [
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/SkyAtmosphere.js",
  "packages/engine/Source/Scene/SkyBrightness.js",
  "packages/engine/Source/Scene/StarField.js",
  "packages/engine/Source/Scene/StarFieldMath.ts",
  "packages/engine/Source/Scene/CubeMapPanorama.js",
  "packages/engine/Source/Scene/AtmosphericConditions.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/FrameState.js",
  "packages/engine/Source/Shaders/SkyBoxFS.glsl",
  "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
  "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereUniforms.ts",
];

// ★ PROVENANCE MARKERS MUST BE STRINGS NEITHER THE BUNDLER NOR THE FORMATTER
// CAN REWRITE. A marker is matched against esbuild's OUTPUT while its source
// has been through prettier; anything either tool may rewrite is not a marker
// but a time bomb — the probe exits 2 in its own guard, never renders, and
// costs a full Edge cycle to find. FIVE recorded strikes across the fleet:
//   S1         numeric literal        esbuild wrote `1.0` as `1`
//   Batch 765  prettier-wrapped call  the marker spanned a moved line break
//   Batch 766  whitespace             `function ()` emitted as `function()`
//   Batch 766  identifier renaming    local `data` emitted as `data2`
//   Batch 766  distinctiveness        `data` matched unrelated code entirely
//
// ALLOWED: property names, and identifiers inside GLSL/WGSL sources (their
// text becomes string CONTENT in the bundle and cannot be renamed at all).
// FORBIDDEN: whitespace-adjacent syntax, local variable names, multi-token
// statements formatting can wrap, numeric literals, anything under 12 chars.
//
// Enforced mechanically — not by habit — in `eclipse-sky-totality.spec.mjs`
// via the shared `lib/provenance-markers.mjs`, which this probe's slices are
// parsed by. Every entry carries a `why` stating what makes it rename-proof.
//
// NOTE ON obs-1: its fix is a CALL-SITE change with no property-shaped token,
// so it has no verbatim slice by construction; it is covered by the
// `resolveSkyDynamicLighting` entry in REQUIRED_TOKENS below. A weaker gate
// honestly labelled beats a strong-looking marker that cannot match.
const VERBATIM_SLICES = [
  {
    // S6 — the twilight gain packed into the WebGPU sky UB tail.
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    marker: "_eclipseHorizonTwilight",
    why: "property access `skyAtmosphere._eclipseHorizonTwilight`; esbuild does not rename properties",
  },
  {
    // S6 — the WebGL uniform closure's source of the same scalar.
    file: "packages/engine/Source/Scene/SkyAtmosphere.js",
    marker: "_eclipseHorizonTwilight",
    why: "property access `that._eclipseHorizonTwilight` in the uniform map",
  },
  {
    // E3 — the WebGL consumer whose absence was C11-176's stated reason.
    file: "packages/engine/Source/Shaders/SkyBoxFS.glsl",
    marker: "u_starModulation",
    why: "GLSL source becomes string content in the bundle; nothing in it is renameable",
  },
  {
    // E3 — the WebGL uniform map that feeds it.
    file: "packages/engine/Source/Scene/CubeMapPanorama.js",
    marker: "u_starModulation",
    why: "uniform-map property name `u_starModulation:`; the enclosing `function ()` is NOT part of the marker (Batch 766 strike)",
  },
  {
    // S6 — the twilight add, both shaders.
    file: "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
    marker: "u_eclipseHorizonTwilight",
    why: "GLSL source becomes string content in the bundle",
  },
  {
    file: "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
    marker: "eclipseControl",
    why: "WGSL source becomes string content in the bundle",
  },
  {
    // S6 — the published scalar.
    file: "packages/engine/Source/Scene/Scene.js",
    marker: "eclipseHorizonTwilight",
    why: "property assignment `frameState.eclipseHorizonTwilight`",
  },
];

const REQUIRED_TOKENS = [
  "resolveSkyDynamicLighting",
  "eclipseHorizonTwilight",
  "horizonTwilightStrength",
  "enableEclipseHorizonTwilight",
  "u_starModulation",
  "u_skyBrightness",
  "computeAtmosphericColumnFactor",
  "computeStarBrightnessModulation",
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

  // Only files written by the MOST RECENT build may satisfy the searches —
  // `Build/CesiumUnminified` accumulates content-hashed chunks across builds
  // and a stale leftover would contain every token, turning the guard into a
  // no-op exactly when it matters.
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

// ── In-page: score EVERY vantage against every lane's needs ────────────────
// Pure ephemeris, no rendering, and a SECOND implementation of the overlap
// (uniform-disc — enough to LOCATE instants; the engine's limb-darkened value
// is what the lanes then read off `scene`).
//
// ★ THIS RETURNS A TABLE AND SELECTS NOTHING. The selector is pure data
// validation over the returned array, so it lives in the NODE driver
// (`lib/eclipse-fixture-constraints.mjs`) where it can be unit-tested and
// where a rejection can name the constraint that caused it. Putting it behind
// the `page.evaluate` boundary is exactly how the previous version shipped a
// selector that picked on MAXIMUM OBSCURATION alone and then demanded a night
// instant the winning vantage could not supply — see the module header there.
//
// Bounded: 18 vantages x (301 coarse eclipse samples + 145 night samples).
const DERIVE_CANDIDATES = async () => {
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
  const candidates = [];
  for (const v of vantages) {
    let maxObscuration = 0;
    let maxSunElevationDeg = -90;
    let peakMinutes = 0;
    for (let i = 0; i <= 300; i++) {
      const t = C.JulianDate.addMinutes(base, i, scratchT);
      const s = stateAt(v.pos, t);
      if (s.elev > 8 && s.o > maxObscuration) {
        maxObscuration = s.o;
        maxSunElevationDeg = s.elev;
        peakMinutes = i;
      }
    }
    // How dark does it actually get here in the following 24 h? This is the
    // constraint the old selector never asked about: at 62-66N in mid-August
    // the sun never gets far below the horizon, so the star-dependent lanes
    // have no usable instant however deep the eclipse is.
    let minNightSunElevationDeg = 90;
    for (let m = 0; m <= 1440; m += 10) {
      const t = C.JulianDate.addMinutes(base, peakMinutes + m, scratchT);
      const s = stateAt(v.pos, t);
      if (s.elev < minNightSunElevationDeg) {
        minNightSunElevationDeg = s.elev;
      }
    }
    candidates.push({
      name: v.name,
      lat: v.lat,
      lon: v.lon,
      peakMinutes,
      maxObscuration,
      maxSunElevationDeg,
      minNightSunElevationDeg,
    });
  }
  return { candidates, baseIso: "2026-08-12T16:00:00Z" };
};

// ── In-page: refine the shortlisted vantages to instants ───────────────────
// Only the candidates the Node-side constraint pass kept, so the cost is
// bounded by FIXTURE_MAX_REFINED rather than by the vantage grid.
const REFINE_VANTAGES = async ({ shortlist, baseIso, nightMaxElevDeg, minSunElevDeg }) => {
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

  const base = C.JulianDate.fromIso8601(baseIso);
  const scratchT = new C.JulianDate();
  const refined = [];

  for (const cand of shortlist) {
    const pos = C.Cartesian3.fromDegrees(cand.lon, cand.lat, 100.0);
    const peak = C.JulianDate.addMinutes(
      base,
      cand.peakMinutes,
      new C.JulianDate(),
    );

    let deepest = null;
    for (let s = -600; s <= 600; s += 1) {
      const t = C.JulianDate.addSeconds(peak, s, scratchT);
      const st = stateAt(pos, t);
      if (!(st.elev > minSunElevDeg)) continue;
      if (deepest === null || st.o > deepest.obscuration) {
        deepest = {
          iso: C.JulianDate.toIso8601(t),
          obscuration: st.o,
          sunElevationDeg: st.elev,
        };
      }
    }

    let clear = null;
    for (let m = -400; m <= -60; m += 1) {
      const t = C.JulianDate.addMinutes(peak, m, scratchT);
      const st = stateAt(pos, t);
      if (st.o === 0 && st.elev > minSunElevDeg) {
        clear = {
          iso: C.JulianDate.toIso8601(t),
          obscuration: st.o,
          sunElevationDeg: st.elev,
        };
        break;
      }
    }

    let night = null;
    for (let m = 0; m <= 1440; m += 2) {
      const t = C.JulianDate.addMinutes(peak, m, scratchT);
      const st = stateAt(pos, t);
      if (st.elev <= nightMaxElevDeg) {
        night = {
          iso: C.JulianDate.toIso8601(t),
          sunElevationDeg: st.elev,
        };
        break;
      }
    }

    refined.push({ ...cand, deepest, clear, night });
  }
  return { refined };
};

// ── In-page: all three lanes ───────────────────────────────────────────────
const MEASURE = async ({ lat, lon, deepestIso, clearIso, nightIso, targetFactor }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;

  // ── helpers (INSIDE the evaluate — module scope does not cross) ──────────
  const rendererType = scene.context?.rendererType ?? "unknown";
  const out = { rendererType, structuralError: null };

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  scene.sunBloom = false;
  scene.highDynamicRange = false;

  // ── The pinned instant, owned by ONE scoped helper ───────────────────────
  //
  // ★ Batch 766: this was a bare `let pinned`, and Lane D reassigned it to the
  // NIGHT instant and never restored it. Lane D runs FIRST, so every later lane
  // — A, B1-B3 and C — rendered hours after the eclipse, where
  // `moonObscuration` is 0 and the horizon-twilight factor is exactly 0. The
  // probe could not exit 0 as written: `fixtureIsDeep`, `revealHappens`,
  // `revealIsPartial` and `presentAtEveryAzimuth` all fail against a fixture
  // that is not an eclipse at all. Lane B4's own save/restore pair was written
  // to protect a value Lane D had already clobbered — evidence of the intent,
  // and of why remembering it is not a mechanism.
  //
  // So the instant is no longer reassignable from a lane. `atInstant` is the
  // ONLY writer: it saves, sets, runs, and restores in a `finally`, so an early
  // return or a throw inside a lane cannot leak the change. `_pinnedInstant` is
  // read through `T()` and written nowhere else — `eclipse-sky-totality.spec.mjs`
  // asserts mechanically that exactly one assignment site exists and that it is
  // inside `atInstant`, because "no lane mutates shared state" is a property a
  // spec can hold and a comment cannot.
  let _pinnedInstant = C.JulianDate.fromIso8601(deepestIso);
  const T = () => _pinnedInstant;
  const atInstant = async (iso, body) => {
    const saved = _pinnedInstant;
    _pinnedInstant = C.JulianDate.fromIso8601(iso);
    try {
      return await body();
    } finally {
      _pinnedInstant = saved;
    }
  };
  // ── SAME-TASK CAPTURE — canonical copy, owned by the shared lib ──────────
  //
  // The primitives below are the VERBATIM contents of
  // `lib/same-task-capture.mjs`'s `SAME_TASK_CAPTURE_SOURCE`, embedded because
  // module-scope bindings do not cross the `page.evaluate` boundary — a page
  // cannot import a Node ESM module, so in-page code has to live as text.
  // `eclipse-sky-totality.spec.mjs` compares this block against the library
  // byte-for-byte via `checkEmbeddedCaptureIsCanonical`, so it cannot drift;
  // edit the library, never this copy.
  //
  // What it prevents (both mechanisms measured, in two different lanes):
  // WebGL clears the drawing buffer after the compositor swap, so a read after
  // a yield returns BLACK; WebGPU invalidates the swap-chain texture after
  // presentation, so the same read returns a STALE frame. Neither is a
  // rendering failure — the engine renders correctly and the probe reads the
  // wrong thing, which is why the symptom points away from the cause.
  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("same-task PNG decode failed"));
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
      const result = typeof capture === "function" ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  const { renderNow, captureNow, grabNow, settleThen } = makeSameTaskCapture(
    scene,
    canvas,
    T,
  );
  const render = renderNow;
  const grabCanvas = grabNow;
  const frame = async () => {
    renderNow();
    await new Promise((r) => requestAnimationFrame(r));
  };

  // ── Per-lane instant provenance ──────────────────────────────────────────
  //
  // The `atInstant` fix was unverifiable from the executor's artifacts because
  // the manifest carried no timestamp — the very defect being repaired was not
  // observable in the output. Every lane now RECORDS the instant it actually
  // rendered at, with the solar elevation, and the verdict asserts it is the
  // instant that lane requires. A lane silently running at the wrong time is
  // the failure mode this whole round exists to prevent, so it is measured,
  // not inferred from source.
  out.laneInstants = [];
  const recordInstant = (lane, expectedIso) => {
    // ★ RENDER FIRST, and that is the whole point. The elevation is derived
    // from `uniformState.sunPositionWC`, which reflects the last RENDERED
    // frame — so a caller that records before rendering at its instant reports
    // the PREVIOUS lane's sun. Measured: B4 recorded ISO `23:13:00Z` (correct)
    // with elevation +25.655 (lane B's deepest instant), because it called
    // this before its first render while lane D called it after four renders
    // and reported the correct -8.096. The render was always at the right
    // instant; the REPORT was stale.
    //
    // Fixing the call site alone would leave an order-dependent reporter that
    // drifts again the next time a lane is reordered, so the render is pulled
    // INSIDE: after this line the uniform state cannot disagree with the ISO
    // being recorded, whatever the caller did first. It is one extra render at
    // a pinned instant — idempotent, and cheap next to the settles around it.
    renderNow();
    const iso = C.JulianDate.toIso8601(T());
    const camPos = scene.camera?.positionWC;
    const sunPos = scene.context?.uniformState?.sunPositionWC;
    let sunElevationDeg = null;
    if (camPos && sunPos) {
      const toSun = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());
      const d = Math.max(-1, Math.min(1, C.Cartesian3.dot(up, toSun)));
      sunElevationDeg = 90 - (Math.acos(d) * 180) / Math.PI;
    }
    const entry = {
      lane,
      iso,
      expectedIso,
      matches: iso === expectedIso,
      sunElevationDeg,
    };
    out.laneInstants.push(entry);
    return entry;
  };

  // Mean linear-ish channel means over a rectangle, in [0,1] display units.
  const bandStats = (img, x0, y0, x1, y1) => {
    const d = img.data;
    const W = img.width;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
    }
    if (n === 0) return { r: 0, g: 0, b: 0, mean: 0, n: 0 };
    r /= n * 255;
    g /= n * 255;
    b /= n * 255;
    return { r, g, b, mean: (r + g + b) / 3, n };
  };

  /** Brightest luminance in a band — the statistic a point source moves. */
  const bandMax = (img, x0, y0, x1, y1) => {
    const d = img.data;
    const W = img.width;
    let max = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (v > max) max = v;
      }
    }
    return max;
  };

  // The fleet's trust-anchored M1 point-source census, ported in-page
  // verbatim (a `page.evaluate` callback cannot import a module). Strict 3x3
  // local maximum; local background = MEDIAN of an annulus at r 3..5; accept
  // only on `v - bg >= 12` AND `v >= 1.6 * bg`. A home-grown census without
  // the prominence arm counts twilight dither as stars — the Batch-761
  // lesson, and exactly the failure mode this lane would hit.
  const m1PointSourceCensus = (img, x0, y0, x1, y1) => {
    const d = img.data;
    const W = img.width;
    const lum = (x, y) => {
      const i = (y * W + x) * 4;
      return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    };
    const ring = [];
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const r2 = dx * dx + dy * dy;
        if (r2 >= 9 && r2 <= 25) {
          ring.push([dx, dy]);
        }
      }
    }
    let count = 0;
    const xa = Math.max(x0 + 6, 6);
    const ya = Math.max(y0 + 6, 6);
    const xb = Math.min(x1 - 6, W - 6);
    const yb = Math.min(y1 - 6, img.height - 6);
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const v = lum(x, y);
        if (v < 12) continue;
        let isMax = true;
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (lum(x + dx, y + dy) >= v) {
              isMax = false;
              break;
            }
          }
        }
        if (!isMax) continue;
        const samples = [];
        for (const [dx, dy] of ring) {
          samples.push(lum(x + dx, y + dy));
        }
        samples.sort((a, b) => a - b);
        const bg = samples[samples.length >> 1];
        if (v - bg >= 12 && v >= 1.6 * bg) {
          count++;
        }
      }
    }
    return count;
  };

  const sceneReadiness = () => {
    const tilesToRender = scene.globe?._surface?._tilesToRender?.length ?? 0;
    return {
      tilesLoaded: scene.globe?.tilesLoaded === true,
      tilesToRender,
      atmosphereReady:
        scene._environmentState?.isReadyForAtmosphere === true,
      atmosphereVisible:
        scene._environmentState?.isSkyAtmosphereVisible === true,
    };
  };
  const settleTiles = async (
    maxFrames,
    requireAtmosphere = false,
    requireVisibleTile = false,
  ) => {
    for (let k = 0; k < maxFrames; k++) {
      // Resolve the current camera/state before reading private readiness.
      // A settled previous view must not satisfy the next lane.
      await frame();
      const readiness = sceneReadiness();
      if (
        readiness.tilesLoaded &&
        (!requireVisibleTile || readiness.tilesToRender > 0) &&
        (!requireAtmosphere ||
          (readiness.atmosphereReady && readiness.atmosphereVisible))
      ) {
        return { ...readiness, settled: true, frames: k + 1 };
      }
    }
    return {
      ...sceneReadiness(),
      settled: false,
      frames: maxFrames,
    };
  };

  // ══ LANE D — SHIPPED DEFAULTS, ground, clear night ═══════════════════════
  //
  // Runs FIRST, before any of the scene mutations below, because the whole
  // point is to measure Cesium AS SHIPPED: `globe.enableLighting` untouched
  // (false), skyAtmosphere/skyBox/starField at their constructor defaults, no
  // atmosphericConditions overrides.
  //
  // The question this lane exists to settle: deleting WebGPU's duplicate
  // binned command leaves one cached command in the pre-atmosphere slot where
  // WebGL executes the catalogue. The shipped NONE lighting enum makes the
  // ground shell analytically opaque, so the expected result is explicit:
  // both background layers are hidden on both backends.
  //
  // The cubemap and sparse sprite measurements survive as diagnostics. They
  // are deliberately not compared as equivalent visibility instruments:
  // their source distributions and statistics are different, and a sparse ROI
  // can truthfully report no sprite delta while the cubemap changes.
  const laneD = {};
  await atInstant(nightIso, async () => {
    const ellipsoidD = scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84;
    const camPosD = C.Cartesian3.fromDegrees(lon, lat, 100.0);
    const upD = C.Cartesian3.normalize(camPosD, new C.Cartesian3());
    const eastD = C.Cartesian3.normalize(
      C.Cartesian3.cross(upD, new C.Cartesian3(0, 0, 1), new C.Cartesian3()),
      new C.Cartesian3(),
    );

    // First prove that the deterministic offline globe can select and render a
    // real tile. The measurement camera below looks away from the globe, where
    // zero visible tiles is the correct quadtree result and cannot serve as a
    // readiness signal.
    scene.camera.setView({
      destination: camPosD,
      orientation: {
        direction: C.Cartesian3.negate(upD, new C.Cartesian3()),
        up: eastD,
      },
    });
    laneD.globeReadiness = await settleTiles(180, true, true);
    if (!laneD.globeReadiness.settled) {
      out.structuralError =
        "lane D: offline globe did not produce a renderable tile " +
        JSON.stringify(laneD.globeReadiness);
      return;
    }

    // Look straight up-ish: 45 deg elevation on an arbitrary azimuth. No sun
    // in frame at a night instant, and no globe in the band.
    const dirD = C.Cartesian3.normalize(
      C.Cartesian3.add(
        C.Cartesian3.multiplyByScalar(eastD, Math.cos(Math.PI / 4), new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(upD, Math.sin(Math.PI / 4), new C.Cartesian3()),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    scene.camera.setView({ destination: camPosD, orientation: { direction: dirD, up: upD } });
    scene.camera.frustum.fov = C.Math.toRadians(60.0);
    laneD.readiness = await settleTiles(180, true);
    if (!laneD.readiness.settled) {
      out.structuralError =
        "lane D: atmosphere did not become ready in the sky-only view " +
        JSON.stringify(laneD.readiness);
      return;
    }

    const bandD = () => {
      const w = canvas.width;
      const h = canvas.height;
      return [
        Math.round(w * 0.25),
        Math.round(h * 0.15),
        Math.round(w * 0.75),
        Math.round(h * 0.6),
      ];
    };
    const capture = async () => {
      // Settle across task boundaries, then render+read in ONE task.
      await frame();
      const img = await captureNow();
      const [x0, y0, x1, y1] = bandD();
      return {
        stats: bandStats(img, x0, y0, x1, y1),
        sources: m1PointSourceCensus(img, x0, y0, x1, y1),
      };
    };

    // The band must contain NO GLOBE. This is not fussiness: the sun-glow
    // worker's near-limb orbital run measured `globeFrac = 0` and
    // `bgNoGlobe` BIT-IDENTICAL to `bg` on WebGPU — i.e. the globe contributes
    // nothing there EVEN WITH THE SHELL HIDDEN, which is obs-2 (a near-black
    // WebGPU globe), not shell opacity. Any lane that lets the globe into its
    // ROI inherits that confound and can mistake a missing globe for an
    // opaque shell. Checked by `pickEllipsoid` at the band corners and centre;
    // a hit is STRUCTURAL, not a verdict.
    {
      const [bx0, by0, bx1, by1] = bandD();
      const dpr = canvas.width / canvas.clientWidth;
      const probePts = [
        [bx0, by0],
        [bx1, by0],
        [bx0, by1],
        [bx1, by1],
        [(bx0 + bx1) / 2, (by0 + by1) / 2],
      ];
      const scratchPick = new C.Cartesian2();
      let globeInBand = false;
      for (const [px, py] of probePts) {
        scratchPick.x = px / dpr;
        scratchPick.y = py / dpr;
        if (scene.camera.pickEllipsoid(scratchPick, ellipsoidD, new C.Cartesian3())) {
          globeInBand = true;
          break;
        }
      }
      laneD.globeInBand = globeInBand;
      if (globeInBand) {
        // NOT `return out` — this body is an `atInstant` callback, so a return
        // here would leave `MEASURE` running with a structural error already
        // recorded. Set the flag and let the lane fall through; the caller
        // checks `out.structuralError` immediately after the scope closes.
        out.structuralError =
          "lane D: the globe intersects the sky band — the measurement would " +
          "inherit the obs-2 dark-globe confound";
      }
    }
    if (out.structuralError) {
      return;
    }

    const skyBox = scene.skyBox;
    const sf = skyBox ? skyBox.starField : undefined;
    laneD.defaultsObserved = {
      enableLighting: scene.globe ? scene.globe.enableLighting : null,
      dynamicAtmosphereLighting: scene.globe
        ? scene.globe.dynamicAtmosphereLighting
        : null,
      skyAtmosphereShow: scene.skyAtmosphere ? scene.skyAtmosphere.show : null,
      skyBoxShow: skyBox ? skyBox.show : null,
      starFieldShow: sf ? sf.show : null,
      dynamicLightingEnum: scene.skyAtmosphere
        ? scene.skyAtmosphere.dynamicLighting
        : null,
    };

    // (1) The shell's alpha, by the same algebraic recovery lane A uses.
    //
    // ★ WHAT THIS ARM IS AND IS NOT. Under shipped defaults the enum is NONE
    // (`defaultsAreDefaults` requires it), so `SkyAtmosphereCommon.glsl:109`
    // takes the constant `1.0` branch for `nightAlpha`, and at a 100 m camera
    // `opacity = altitudeOpacity = 1`, giving `alpha = mix(color.b, 1, 1) = 1`
    // — with the sun position entering NOWHERE. So `alphaRecovered` here reads
    // identically at -8 deg, -34 deg and at noon: it is an ALGEBRAIC IDENTITY
    // CHECK on the compositing model plus the background instrument, not a
    // night measurement, and `defaultsAlphaParity` is a gate that cannot fail
    // for any night threshold. It is kept for exactly that value — it proves
    // `scene.backgroundColor` reaches the clear on both backends and that the
    // shell composites alpha-over, which is the premise lanes A and B4 depend
    // on — and it is LABELLED so nobody reads it as evidence about darkness.
    // The sparse sprite/cubemap samples are diagnostics only; command
    // ownership is gated directly in B4.
    const overBg = async (color, shellShown) => {
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = shellShown;
      if (skyBox) skyBox.show = false;
      if (sf) sf.show = false;
      scene.backgroundColor = color;
      return (await capture()).stats.mean;
    };
    const dCtrlB = await overBg(C.Color.BLACK, false);
    const dCtrlW = await overBg(C.Color.WHITE, false);
    const dShellB = await overBg(C.Color.BLACK, true);
    const dShellW = await overBg(C.Color.WHITE, true);
    recordInstant("D-defaults", nightIso);
    laneD.controlResponse = dCtrlW - dCtrlB;
    laneD.shellResponse = dShellW - dShellB;
    laneD.alphaRecovered =
      laneD.controlResponse > 1e-6
        ? 1 - laneD.shellResponse / laneD.controlResponse
        : null;

    // (2) Are the catalogue SPRITES visible through the shell?
    scene.backgroundColor = C.Color.BLACK;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    if (skyBox) skyBox.show = true;
    if (sf) sf.show = true;
    const withSprites = await capture();
    if (sf) sf.show = false;
    const withoutSprites = await capture();
    if (sf) sf.show = true;
    laneD.spriteDelta = withSprites.stats.mean - withoutSprites.stats.mean;
    laneD.spriteSourceDelta = withSprites.sources - withoutSprites.sources;
    laneD.spritesVisible =
      laneD.spriteDelta > 0.002 || laneD.spriteSourceDelta >= 3;

    // (3) Is the CUBEMAP visible through the shell? Same shape, same band.
    if (sf) sf.show = false;
    if (skyBox) skyBox.show = true;
    const withCubemap = await capture();
    if (skyBox) skyBox.show = false;
    const withoutCubemap = await capture();
    if (skyBox) skyBox.show = true;
    if (sf) sf.show = true;
    laneD.cubemapDelta = withCubemap.stats.mean - withoutCubemap.stats.mean;
    laneD.cubemapVisible = laneD.cubemapDelta > 0.002;

    // Same-task PNGs of the defaults view, for the maintainer.
    const shotDefaults = grabCanvas();
    out.laneDShot = shotDefaults;
  });
  // Lane D's structural exits cannot `return` out of `MEASURE` from inside the
  // scoped callback, so they are surfaced here instead.
  if (out.structuralError) {
    return { ...out, laneD };
  }

  // ── deterministic scene ──────────────────────────────────────────────────
  scene.backgroundColor = C.Color.BLACK;
  if (scene.globe) {
    scene.globe.show = true;
    try {
      scene.globe.imageryLayers.removeAll();
    } catch {
      /* nothing to remove */
    }
    scene.globe.baseColor = C.Color.fromBytes(70, 90, 60, 255);
    // Injection-site relevance: with lighting off the globe flags resolve the
    // sky's dynamic-lighting enum to NONE on BOTH backends and obs-1 becomes
    // unobservable by construction. This IS the maintainer-facing default for
    // any lit scene, and it is the configuration obs-1 was recorded in.
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
    // ★ THE SUN STAYS SHOWN, and this is a deliberate reversal.
    //
    // It used to be hidden as "never in frame; removes a bloom/glare
    // variable". The executor bisected the v2 exit-2 to exactly this line: on
    // WebGPU, with all other environment content hidden, `sun.show = false`
    // flips the background-control response 1 -> 0 — the band renders black
    // and `backgroundColor` is never applied, so a black->white swap moves
    // nothing. WebGL is unaffected at every step. That is the
    // NEW-WEBGPU-ENV-PASS-DROP family (C12-G1F1), a member Batch 761's
    // env-frustum root fix does not cover, and it is filed as its own engine
    // lane — not this probe's to fix.
    //
    // The dependency is REMOVED rather than worked around: every camera in
    // this probe is anti-solar (lanes A, B and D aim 180 deg from the sun,
    // lane C sweeps azimuths at 6 deg pitch), and the widest frustum here is
    // 60 deg, so the solar disc is geometrically incapable of entering any
    // measured band. Hiding it bought nothing the camera does not already
    // buy, and cost a dependency on an unrelated engine defect.
    scene.sun.show = true;
    // WebGPU's sun bloom is unwired (C11-160) and is a screen-space effect,
    // so it IS worth suppressing — that is the variable the old line was
    // actually reaching for, and it can be removed without touching the env
    // pass. (`scene.sunBloom` is already false from the deterministic block.)
  }

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;
  if (!ac || !ac.lighting || !ac.skyAtmosphere) {
    out.structuralError = "no atmosphericConditions.lighting/skyAtmosphere";
    return out;
  }
  if (!("enableEclipseHorizonTwilight" in ac.lighting)) {
    out.structuralError = "enableEclipseHorizonTwilight toggle is absent";
    return out;
  }
  if (!("enableStarBrightnessModulation" in ac.skyAtmosphere)) {
    out.structuralError = "enableStarBrightnessModulation is absent";
    return out;
  }

  out.defaults = {
    enableStarBrightnessModulation:
      ac.skyAtmosphere.enableStarBrightnessModulation,
    inflection: ac.skyAtmosphere.starModulationCurve?.inflection,
    steepness: ac.skyAtmosphere.starModulationCurve?.steepness,
    enableEclipse: ac.lighting.enableEclipse,
    enableEclipseHorizonTwilight: ac.lighting.enableEclipseHorizonTwilight,
  };

  const camPos = C.Cartesian3.fromDegrees(lon, lat, 100.0);
  const up = C.Cartesian3.normalize(camPos, new C.Cartesian3());

  // Aim the camera at a given azimuth OFFSET from the anti-solar direction,
  // pitched UP so the measured sky band is well clear of the horizon line and
  // no globe pixels enter it.
  const aim = (azimuthOffsetDeg, pitchUpDeg) => {
    // ★ RENDER FIRST — third instance of the same class, and the one that ate
    // lane B4. `uniformState.sunPositionWC` reflects the last RENDERED frame,
    // so aiming before rendering at the pinned instant points the camera using
    // the PREVIOUS lane's sun. B4 called `aim(0, 25)` as the first statement
    // inside its night scope, so it aimed anti-solar for the DEEPEST instant's
    // sun — hours of Earth rotation away — and the band landed somewhere with
    // no sky in it. That is why `spriteDeltaWithShell` and `spriteDeltaNoShell`
    // read EXACTLY 0 (byte-identical captures: toggling the star field changed
    // nothing in a band containing no stars) while the reveal lane's census
    // found 14 peaks in its own frames at its own instant.
    //
    // `recordInstant` was fixed the same way last round; fixing only the call
    // site would leave the next caller to rediscover it, so the render moves
    // inside the helper. After this line the sun direction cannot disagree
    // with the pinned instant, whatever the caller did first.
    renderNow();
    const sunPos = scene.context.uniformState.sunPositionWC;
    const toSun = C.Cartesian3.normalize(
      C.Cartesian3.subtract(sunPos, camPos, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const anti = C.Cartesian3.negate(toSun, new C.Cartesian3());
    let horiz = C.Cartesian3.subtract(
      anti,
      C.Cartesian3.multiplyByScalar(
        up,
        C.Cartesian3.dot(anti, up),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    if (C.Cartesian3.magnitude(horiz) < 1e-6) {
      horiz = C.Cartesian3.cross(up, new C.Cartesian3(0, 0, 1), new C.Cartesian3());
    }
    C.Cartesian3.normalize(horiz, horiz);
    const east = C.Cartesian3.normalize(
      C.Cartesian3.cross(up, horiz, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const a = (azimuthOffsetDeg * Math.PI) / 180.0;
    const flat = C.Cartesian3.normalize(
      C.Cartesian3.add(
        C.Cartesian3.multiplyByScalar(horiz, Math.cos(a), new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(east, Math.sin(a), new C.Cartesian3()),
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const p = (pitchUpDeg * Math.PI) / 180.0;
    const dir = C.Cartesian3.normalize(
      C.Cartesian3.add(
        C.Cartesian3.multiplyByScalar(flat, Math.cos(p), new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(up, Math.sin(p), new C.Cartesian3()),
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
  };

  const W = () => canvas.width;
  const H = () => canvas.height;

  await settleTiles(240);

  // ══ LANE A — obs-1: recover the shell alpha algebraically ════════════════
  //
  // `out_white - out_black = (1 - a)` per channel, exactly, under ALPHA_BLEND.
  // The CONTROL (shell hidden) measures the same difference with a == 0 and
  // must read ~1; if it does not, `scene.backgroundColor` is not reaching the
  // clear on this backend and the instrument — not the engine — is broken.
  const laneA = {};
  {
    aim(0, 25); // anti-solar, well above the horizon
    const shownSkyBox = scene.skyBox ? scene.skyBox.show : false;
    const shownStars =
      scene.skyBox && scene.skyBox.starField
        ? scene.skyBox.starField.show
        : false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyBox && scene.skyBox.starField) {
      scene.skyBox.starField.show = false;
    }

    const bandOf = () => {
      const w = W();
      const h = H();
      return [Math.round(w * 0.3), Math.round(h * 0.1), Math.round(w * 0.7), Math.round(h * 0.3)];
    };

    const measureOverBackground = async (color) => {
      scene.backgroundColor = color;
      await frame();
      const img = await captureNow();
      const [x0, y0, x1, y1] = bandOf();
      return bandStats(img, x0, y0, x1, y1);
    };

    // Control: no shell.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    const ctrlBlack = await measureOverBackground(C.Color.BLACK);
    const ctrlWhite = await measureOverBackground(C.Color.WHITE);
    laneA.controlResponse = ctrlWhite.mean - ctrlBlack.mean;

    // With the shell.
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    const shellBlack = await measureOverBackground(C.Color.BLACK);
    const shellWhite = await measureOverBackground(C.Color.WHITE);
    laneA.shellResponse = shellWhite.mean - shellBlack.mean;
    laneA.shellMeanOverBlack = shellBlack.mean;

    recordInstant("A-shellAlpha", deepestIso);
    laneA.alphaRecovered =
      laneA.controlResponse > 1e-6
        ? 1 - laneA.shellResponse / laneA.controlResponse
        : null;
    laneA.dynamicLightingEnum = scene.skyAtmosphere
      ? scene.skyAtmosphere.dynamicLighting
      : null;
    laneA.sceneAtmosphereDynamicLighting = scene.atmosphere
      ? scene.atmosphere.dynamicLighting
      : null;

    scene.backgroundColor = C.Color.BLACK;
    if (scene.skyBox) scene.skyBox.show = shownSkyBox;
    if (scene.skyBox && scene.skyBox.starField) {
      scene.skyBox.starField.show = shownStars;
    }
  }

  // ══ LANE B — the E3 multiplier reaches pixels ════════════════════════════
  const laneB = {};
  {
    aim(0, 25);
    if (scene.skyBox) scene.skyBox.show = true;
    if (scene.skyBox && scene.skyBox.starField) {
      scene.skyBox.starField.show = true;
    }

    const curve = ac.skyAtmosphere.starModulationCurve;
    const savedInflection = curve.inflection;
    const savedSteepness = curve.steepness;
    const savedEnable = ac.skyAtmosphere.enableStarBrightnessModulation;

    const band = () => {
      const w = W();
      const h = H();
      return [Math.round(w * 0.25), Math.round(h * 0.05), Math.round(w * 0.75), Math.round(h * 0.35)];
    };

    const measureBand = async () => {
      await frame();
      const img = await captureNow();
      const [x0, y0, x1, y1] = band();
      return {
        stats: bandStats(img, x0, y0, x1, y1),
        sources: m1PointSourceCensus(img, x0, y0, x1, y1),
      };
    };

    // (b1) The multiplier itself. Two renders differing ONLY in the curve.
    // `inflection = 1` puts t at exactly 0 for any sky brightness in [0,1],
    // so the factor is exactly 1; then solve the curve for the target.
    const solveInflection = (targetFactor, brightness, steepness) => {
      // 1 - smoothstep(0,1,t) = target  ->  t
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        const s = mid * mid * (3 - 2 * mid);
        if (1 - s > targetFactor) lo = mid;
        else hi = mid;
      }
      const t = 0.5 * (lo + hi);
      return brightness - t / steepness;
    };

    // The MODULATED COMPONENT, isolated by difference. The multiplier only
    // ever scales what the star layers draw, so that is what has to be
    // measured — with the layers toggled off, the same frame gives the
    // unmodulated sky underneath, and the subtraction leaves exactly the
    // quantity the curve acts on. The ratio of two such contributions IS the
    // factor, with the sky term cancelling instead of diluting it.
    const modulatedComponent = async () => {
      const [x0, y0, x1, y1] = band();
      const sf = scene.skyBox ? scene.skyBox.starField : undefined;
      const cubeShown = scene.skyBox ? scene.skyBox.show : false;
      const sfShown = sf ? sf.show : false;
      if (scene.skyBox) scene.skyBox.show = true;
      if (sf) sf.show = true;
      await frame();
      const withStars = await captureNow();
      if (scene.skyBox) scene.skyBox.show = false;
      if (sf) sf.show = false;
      await frame();
      const without = await captureNow();
      if (scene.skyBox) scene.skyBox.show = cubeShown;
      if (sf) sf.show = sfShown;
      const a = bandStats(withStars, x0, y0, x1, y1);
      const b = bandStats(without, x0, y0, x1, y1);
      const n = a.n || 1;
      return { sum: (a.mean - b.mean) * n, mean: a.mean - b.mean };
    };

    ac.skyAtmosphere.enableStarBrightnessModulation = true;
    curve.steepness = 23.0;
    curve.inflection = 1.0; // factor exactly 1
    const full = await measureBand();
    const fullComponent = await modulatedComponent();
    laneB.skyBrightness = scene.frameState
      ? scene.frameState.skyBrightness
      : null;

    const brightness =
      typeof laneB.skyBrightness === "number" ? laneB.skyBrightness : 0.5;
    curve.inflection = solveInflection(targetFactor, brightness, 23.0);
    const halved = await measureBand();
    const halvedComponent = await modulatedComponent();
    laneB.fullComponentSum = fullComponent.sum;
    laneB.halvedComponentSum = halvedComponent.sum;
    // THE GATE: the ratio of the modulated component, where the sky cancels.
    laneB.measuredFactor =
      Math.abs(fullComponent.sum) > 1.0
        ? halvedComponent.sum / fullComponent.sum
        : null;

    recordInstant("B-multiplier", deepestIso);
    laneB.fullMean = full.stats.mean;
    laneB.halvedMean = halved.stats.mean;
    // REPORTED ONLY — the band-mean ratio is NOT the multiplier, and v3 proved
    // it: it measured 0.938 against a 0.5 target. The modulation scales the
    // CUBEMAP (and, through the reveal floor, the sprites); the band mean is
    // dominated by the sky shell, which the modulation never touches. Solving
    // `1 - 0.5c = 0.938` puts the modulated content at c = 12.4% of the band,
    // so the ratio is arithmetically pinned near 1 whatever the multiplier
    // does. Same error class as the reveal census and the B4 band mean: the
    // right quantity measured in the wrong place.
    laneB.bandMeanRatioReportedOnly =
      full.stats.mean > 1e-4 ? halved.stats.mean / full.stats.mean : null;
    laneB.targetFactor = targetFactor;
    laneB.fullSources = full.sources;

    // (b2) The reveal. Same camera, same curve defaults, eclipse ON vs OFF at
    // the deepest instant. The ONLY difference is the eclipse toggle.
    curve.inflection = savedInflection;
    curve.steepness = savedSteepness;
    ac.skyAtmosphere.enableStarBrightnessModulation = true;

    // THE HEADLINE, IN PIXELS. The feature is "stars reveal during totality",
    // and until now no artifact showed a star: the shots came from lanes C and
    // D, neither of which frames the star band at the eclipse instant. These
    // two are the reveal itself — same pinned instant, same camera, same
    // curve, differing ONLY in the eclipse toggle — captured same-task so they
    // are the frames the numbers were read from, not a later repaint.
    // ★ THE CENSUS CANNOT SEE THIS REVEAL, and that is arithmetic, not luck.
    //
    // v2 returned zero point sources in all 12 frames with `revealOn` peaking
    // at luminance 36. Working it through at the measured background (band
    // mean 0.053 -> 13.5/255, census bar `max(bg+12, 1.6*bg)` = 25.5) and the
    // totality modulation factor k = 0.0628:
    //
    //   CUBEMAP  a cubemap star must have source luminance >= 25.5 / 0.0628
    //            = 406/255 to clear the bar. IMPOSSIBLE — the census is
    //            arithmetically blind to the cubemap half of the reveal at
    //            totality, whatever the engine does.
    //   SPRITES  Sirius (I = 5.87) lands at 29-94/255 after the same scaling
    //            and plausible atmospheric extinction, so sprites ARE
    //            detectable — but only if a star that bright happens to sit
    //            in this ~30x18 deg anti-solar patch at this instant, which
    //            nothing in the fixture arranges.
    //
    // So a census verdict here is fixture-dependent at best and blind at
    // worst. The reveal is therefore measured DIRECTLY, by difference, with
    // statistics appropriate to point sources: the SUM over the band (means
    // dilute a sparse population into the noise) and the MAX pixel. Both are
    // taken with the star field toggled off and on at each eclipse state, so
    // what is isolated is the star contribution itself rather than the sky
    // behind it. The census stays, reported, as the human-legible number.
    const starFieldB = scene.skyBox ? scene.skyBox.starField : undefined;
    const starContribution = async () => {
      const [x0, y0, x1, y1] = band();
      const shown = starFieldB ? starFieldB.show : false;
      const cubeShown = scene.skyBox ? scene.skyBox.show : false;
      if (starFieldB) starFieldB.show = true;
      if (scene.skyBox) scene.skyBox.show = true;
      await frame();
      const withAll = await captureNow();
      if (starFieldB) starFieldB.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      await frame();
      const without = await captureNow();
      if (starFieldB) starFieldB.show = shown;
      if (scene.skyBox) scene.skyBox.show = cubeShown;
      const a = bandStats(withAll, x0, y0, x1, y1);
      const b = bandStats(without, x0, y0, x1, y1);
      // Sum over the band (mean x pixel count) and the brightest pixel — the
      // statistics a sparse point-source population actually moves.
      const n = a.n || 1;
      return {
        sumDelta: (a.mean - b.mean) * n,
        meanDelta: a.mean - b.mean,
        maxWith: bandMax(withAll, x0, y0, x1, y1),
        maxWithout: bandMax(without, x0, y0, x1, y1),
      };
    };

    ac.lighting.enableEclipse = false;
    const revealOff = await measureBand();
    laneB.revealOffShot = grabCanvas();
    const starOff = await starContribution();
    ac.lighting.enableEclipse = true;
    const revealOn = await measureBand();
    laneB.revealOnShot = grabCanvas();
    const starOn = await starContribution();
    laneB.starSumOff = starOff.sumDelta;
    laneB.starSumOn = starOn.sumDelta;
    laneB.starMaxOff = starOff.maxWith;
    laneB.starMaxOn = starOn.maxWith;
    laneB.starMaxNoStarsOn = starOn.maxWithout;

    laneB.revealOffSources = revealOff.sources;
    laneB.revealOnSources = revealOn.sources;
    laneB.revealOffMean = revealOff.stats.mean;
    laneB.revealOnMean = revealOn.stats.mean;
    laneB.eclipseFactorAtDeepest = scene.frameState
      ? scene.frameState.eclipseSceneLightFactor
      : null;
    laneB.obscurationAtDeepest = scene.frameState?.eclipseState
      ? scene.frameState.eclipseState.moonObscuration
      : null;

    // (b3) OFF-position identity: with the modulation flag false the cubemap
    // must be untouched no matter what the curve says.
    ac.skyAtmosphere.enableStarBrightnessModulation = false;
    curve.inflection = 0.0;
    curve.steepness = 1000.0; // would black the map out if it were read
    const offIdentity = await measureBand();
    ac.skyAtmosphere.enableStarBrightnessModulation = savedEnable;
    curve.inflection = savedInflection;
    curve.steepness = savedSteepness;
    laneB.offIdentityMean = offIdentity.stats.mean;
    laneB.offIdentitySources = offIdentity.sources;

    // ── (b4) THE CATALOGUE MUST CONTRIBUTE EXACTLY ONCE ──────────────────
    //
    // Count both publication routes after a real render. The correct
    // architecture has one returned environment command and no binned copy.
    // Hiding the field must remove both. This is a stronger instrument than a
    // sparse pixel-band ratio: it cannot pass merely because the chosen ROI
    // happened to contain no catalogue sprites.
    await atInstant(nightIso, async () => {
      aim(0, 25);
      await settleTiles(120);

      const sfB4 = scene.skyBox ? scene.skyBox.starField : undefined;
      const snapshotStarSubmission = () => {
        if (!sfB4) {
          return {
            environmentCommand: false,
            commandListOwnerCount: 0,
            submissionCount: 0,
          };
        }
        const commandListOwnerCount = scene._frameState.commandList.filter(
          (command) => command?.owner === sfB4,
        ).length;
        const environmentCommand =
          scene._environmentState.starFieldCommand?.owner === sfB4;
        return {
          environmentCommand,
          commandListOwnerCount,
          submissionCount:
            Number(environmentCommand) + commandListOwnerCount,
        };
      };

      const savedShow = sfB4?.show;
      laneB.starFieldInitiallyShown = savedShow === true;
      if (sfB4) {
        sfB4.show = true;
      }
      await frame();
      await frame();
      laneB.starSubmission = snapshotStarSubmission();

      if (sfB4) {
        sfB4.show = false;
      }
      await frame();
      laneB.hiddenStarSubmission = snapshotStarSubmission();

      if (sfB4) {
        sfB4.show = savedShow;
      }
      await frame();
      laneB.starSubmissionAfterRestore = snapshotStarSubmission();
      laneB.nightIso = nightIso;
      laneB.instantAtB4 = recordInstant("B4-exactlyOnce", nightIso);
    });
    await settleTiles(120);
  }

  // ══ LANE C — the 360-degree horizon twilight ═════════════════════════════
  const laneC = { azimuths: [] };
  {
    ac.lighting.enableEclipse = true;
    const azimuths = [0, 90, 180, 270];

    const horizonBand = () => {
      const w = W();
      const h = H();
      // The camera is pitched so the horizon sits near 3/4 height; the band
      // just above it is where the twilight lives.
      return [Math.round(w * 0.2), Math.round(h * 0.55), Math.round(w * 0.8), Math.round(h * 0.72)];
    };
    const zenithBand = () => {
      const w = W();
      const h = H();
      return [Math.round(w * 0.2), Math.round(h * 0.02), Math.round(w * 0.8), Math.round(h * 0.12)];
    };

    const measureToggle = async () => {
      ac.lighting.enableEclipseHorizonTwilight = false;
      await frame();
      const off = await captureNow();
      ac.lighting.enableEclipseHorizonTwilight = true;
      await frame();
      const on = await captureNow();
      const hb = horizonBand();
      const zb = zenithBand();
      const offH = bandStats(off, hb[0], hb[1], hb[2], hb[3]);
      const onH = bandStats(on, hb[0], hb[1], hb[2], hb[3]);
      const offZ = bandStats(off, zb[0], zb[1], zb[2], zb[3]);
      const onZ = bandStats(on, zb[0], zb[1], zb[2], zb[3]);
      return {
        deltaHorizon: onH.mean - offH.mean,
        deltaZenith: onZ.mean - offZ.mean,
        deltaR: onH.r - offH.r,
        deltaB: onH.b - offH.b,
        offHorizonMean: offH.mean,
        onHorizonMean: onH.mean,
      };
    };

    // Pitch DOWN a little so the horizon is inside the frame.
    for (const az of azimuths) {
      aim(az, 6);
      await settleTiles(120);
      const m = await measureToggle();
      const inst = recordInstant(`C-az${az}`, deepestIso);
      laneC.azimuths.push({ azimuth: az, instant: inst, ...m });
    }

    laneC.twilightFactor = scene.frameState
      ? scene.frameState.eclipseHorizonTwilight
      : null;
    laneC.horizonTwilightStrength = scene.frameState?.eclipseState
      ? scene.frameState.eclipseState.horizonTwilightStrength
      : null;

    // The deepest-rung visual, captured IN THIS TASK.
    aim(0, 6);
    ac.lighting.enableEclipseHorizonTwilight = true;
    await frame();
    await frame();
    const shots = { totalityOn: grabCanvas() };
    ac.lighting.enableEclipseHorizonTwilight = false;
    await frame();
    await frame();
    shots.totalityOff = grabCanvas();
    ac.lighting.enableEclipseHorizonTwilight = true;

    // OFF-ECLIPSE IDENTITY: at the clear instant the two toggle positions must
    // be EXACTLY equal — the strength is 0 by construction, not by rounding.
    await atInstant(clearIso, async () => {
      await settleTiles(120);
      const clearToggle = await measureToggle();
      laneC.clearDeltaHorizon = clearToggle.deltaHorizon;
      laneC.clearDeltaZenith = clearToggle.deltaZenith;
      laneC.clearFactor = scene.frameState
        ? scene.frameState.eclipseHorizonTwilight
        : null;
      recordInstant("C-clear", clearIso);
      laneC.clearObscuration = scene.frameState?.eclipseState
        ? scene.frameState.eclipseState.moonObscuration
        : null;
      await frame();
      shots.clear = grabCanvas();
    });

    shots.defaults = out.laneDShot;
    delete out.laneDShot;
    // The star-reveal pair, so the headline is demonstrable in artifacts.
    if (laneB.revealOffShot) {
      shots.revealOff = laneB.revealOffShot;
      delete laneB.revealOffShot;
    }
    if (laneB.revealOnShot) {
      shots.revealOn = laneB.revealOnShot;
      delete laneB.revealOnShot;
    }
    out.shots = shots;
  }

  return { ...out, laneA, laneB, laneC, laneD };
};

// ── Playwright driver ──────────────────────────────────────────────────────
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

    out.result = await page.evaluate(MEASURE, {
      lat: plan.lat,
      lon: plan.lon,
      deepestIso: plan.deepest.iso,
      clearIso: plan.clear.iso,
      nightIso: plan.night.iso,
      targetFactor: LANE_B_TARGET_FACTOR,
    });

    const shots = out.result?.shots ?? {};
    out.shotsWritten = [];
    for (const [key, dataUrl] of Object.entries(shots)) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
        continue;
      }
      const file = path.join(
        OUT_DIR,
        `eclipse-sky-totality-${renderer}-${key}.png`,
      );
      fs.writeFileSync(
        file,
        Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
      );
      out.shotsWritten.push(file.replaceAll("\\", "/"));
    }
    if (out.result) {
      delete out.result.shots;
    }

    const t = out.result && out.result.rendererType;
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

// ── Verdict ────────────────────────────────────────────────────────────────
function judge(result) {
  const v = {};
  const a = result.laneA ?? {};
  const b = result.laneB ?? {};
  const c = result.laneC ?? {};

  // Lane A. The control is STRUCTURAL (it measures the instrument), the
  // recovered alpha is the finding.
  v.laneA = {
    controlResponse: r3(a.controlResponse),
    shellResponse: r3(a.shellResponse),
    alphaRecovered: r3(a.alphaRecovered),
    dynamicLightingEnum: a.dynamicLightingEnum,
    sceneAtmosphereDynamicLighting: a.sceneAtmosphereDynamicLighting,
    // Scene must resolve SCENE_LIGHT from the globe flags on BOTH backends —
    // that part was never the bug, and pinning it here keeps the root-cause
    // story attached to a measurement.
    sceneResolvedSceneLight: a.dynamicLightingEnum === 1,
    // The finding: a ground camera's anti-solar shell must NOT be opaque.
    shellIsTranslucent:
      typeof a.alphaRecovered === "number" && a.alphaRecovered < 0.9,
    // Sanity floor: an all-black frame must fail rather than pass vacuously.
    bandNotBlack: (a.shellMeanOverBlack ?? 0) > 0.01,
  };

  // Lane B.
  const factorErr =
    typeof b.measuredFactor === "number"
      ? Math.abs(b.measuredFactor - b.targetFactor) / b.targetFactor
      : null;
  v.laneB = {
    skyBrightness: r6(b.skyBrightness),
    fullMean: r3(b.fullMean),
    halvedMean: r3(b.halvedMean),
    bandMeanRatioReportedOnly: r3(b.bandMeanRatioReportedOnly),
    fullComponentSum: r3(b.fullComponentSum),
    halvedComponentSum: r3(b.halvedComponentSum),
    // Non-vacuity: there must BE a modulated component to ratio.
    modulatedComponentMeasurable: Math.abs(b.fullComponentSum ?? 0) > 1.0,
    measuredFactor: r3(b.measuredFactor),
    targetFactor: b.targetFactor,
    factorRelError: r3(factorErr),
    fullSources: b.fullSources,
    revealOffSources: b.revealOffSources,
    revealOnSources: b.revealOnSources,
    revealOffMean: r3(b.revealOffMean),
    revealOnMean: r3(b.revealOnMean),
    eclipseFactorAtDeepest: r6(b.eclipseFactorAtDeepest),
    obscurationAtDeepest: r6(b.obscurationAtDeepest),
    offIdentityMean: r3(b.offIdentityMean),
    offIdentitySources: b.offIdentitySources,
    // The multiplier reaches pixels, within a band that no clamp can fake.
    multiplierReachesPixels: factorErr !== null && factorErr <= 0.15,
    // Non-vacuity: there has to be a star field to modulate.
    starFieldPresent: (b.fullSources ?? 0) >= 20,
    // The reveal, measured DIRECTLY rather than by census. The census is
    // arithmetically blind to the cubemap half at totality (a cubemap star
    // would need source luminance 406/255 to clear the bar at k = 0.0628) and
    // fixture-dependent for the sprite half, so the gate is the star
    // CONTRIBUTION — sum over the band, star field toggled off/on at each
    // eclipse state — which isolates the stars from the sky behind them.
    starSumOff: r6(b.starSumOff),
    starSumOn: r6(b.starSumOn),
    starMaxOff: r3(b.starMaxOff),
    starMaxOn: r3(b.starMaxOn),
    starMaxNoStarsOn: r3(b.starMaxNoStarsOn),
    // Eclipse ON must contribute strictly more star light than eclipse OFF.
    revealHappens: (b.starSumOn ?? 0) > (b.starSumOff ?? 0),
    // Daylight with the eclipse OFF must contribute essentially nothing —
    // the modulation factor is exactly 0 there, so this is the converse the
    // reveal claim needs.
    noStarsWithoutTheEclipse: Math.abs(b.starSumOff ?? 0) < 1.0,
    // ...and it must be a PARTIAL reveal, not the whole night sky. The
    // brightest star present must clear the local sky, while the total
    // contribution stays below the undimmed reference.
    revealIsPartial:
      (b.starMaxOn ?? 0) > (b.starMaxNoStarsOn ?? 0) &&
      (b.starSumOn ?? 0) > 0,
    // The off position must restore the undimmed cubemap exactly, even with a
    // curve that would otherwise black it out.
    offToggleRestoresFull:
      typeof b.offIdentityMean === "number" &&
      typeof b.fullMean === "number" &&
      Math.abs(b.offIdentityMean - b.fullMean) <= 0.01,
    // The fixture must actually be a deep eclipse.
    fixtureIsDeep: (b.obscurationAtDeepest ?? 0) > 0.98,

    // (b4) exactly-once command ownership. This counts both publication
    // routes and therefore remains meaningful even when no catalogue point
    // falls inside a pixel ROI.
    nightIso: b.nightIso,
    starSubmission: b.starSubmission,
    hiddenStarSubmission: b.hiddenStarSubmission,
    starSubmissionAfterRestore: b.starSubmissionAfterRestore,
    starFieldInitiallyShown: b.starFieldInitiallyShown === true,
    catalogDrawnOnce:
      b.starSubmission?.environmentCommand === true &&
      b.starSubmission?.commandListOwnerCount === 0 &&
      b.starSubmission?.submissionCount === 1,
    hiddenStopsSubmission:
      b.hiddenStarSubmission?.environmentCommand === false &&
      b.hiddenStarSubmission?.commandListOwnerCount === 0 &&
      b.hiddenStarSubmission?.submissionCount === 0,
    restoreSchedulesOnce:
      b.starSubmissionAfterRestore?.environmentCommand === true &&
      b.starSubmissionAfterRestore?.commandListOwnerCount === 0 &&
      b.starSubmissionAfterRestore?.submissionCount === 1,
  };

  // Lane C.
  const az = c.azimuths ?? [];
  const deltas = az.map((x) => x.deltaHorizon ?? 0);
  v.laneC = {
    twilightFactor: r3(c.twilightFactor),
    horizonTwilightStrength: r3(c.horizonTwilightStrength),
    perAzimuth: az.map((x) => ({
      azimuth: x.azimuth,
      deltaHorizon: r3(x.deltaHorizon),
      deltaZenith: r3(x.deltaZenith),
      deltaR: r3(x.deltaR),
      deltaB: r3(x.deltaB),
      offHorizonMean: r3(x.offHorizonMean),
      onHorizonMean: r3(x.onHorizonMean),
    })),
    clearDeltaHorizon: r6(c.clearDeltaHorizon),
    clearDeltaZenith: r6(c.clearDeltaZenith),
    clearFactor: c.clearFactor,
    clearObscuration: r6(c.clearObscuration),
    // The whole point: present at EVERY azimuth.
    presentAtEveryAzimuth: az.length === 4 && deltas.every((d) => d > 0.004),
    // Confined to the band — nothing above 22.6 deg elevation.
    confinedToBand: az.every(
      (x) => Math.abs(x.deltaZenith ?? 0) <= 0.25 * Math.abs(x.deltaHorizon ?? 1),
    ),
    // Sunset-coloured.
    isWarm: az.every((x) => (x.deltaR ?? 0) > (x.deltaB ?? 0)),
    // Sanity floor: the horizon band must not be black in either position.
    bandNotBlack: az.every((x) => (x.offHorizonMean ?? 0) > 0.01),
    // OFF the eclipse the toggle is an identity by construction. Frame
    // aggregation and readback can still leave a few f32 ULPs of noise.
    clearFactorIsZero: c.clearFactor === 0,
    clearIsIdentity:
      Math.abs(c.clearDeltaHorizon ?? 1) < 1e-6 &&
      Math.abs(c.clearDeltaZenith ?? 1) < 1e-6,
    fixtureIsClear: (c.clearObscuration ?? 1) === 0,
  };

  // Lane D — shipped defaults. Reported per backend; the VERDICT is the
  // cross-backend parity computed by the caller, because "did the fix converge
  // or regress" is only answerable by comparing the two.
  const d = result.laneD ?? {};
  v.laneD = {
    globeReadiness: d.globeReadiness,
    readiness: d.readiness,
    defaultsObserved: d.defaultsObserved,
    controlResponse: r3(d.controlResponse),
    shellResponse: r3(d.shellResponse),
    alphaRecovered: r3(d.alphaRecovered),
    spriteDelta: r6(d.spriteDelta),
    spriteSourceDelta: d.spriteSourceDelta,
    spritesVisible: d.spritesVisible,
    cubemapDelta: r6(d.cubemapDelta),
    cubemapVisible: d.cubemapVisible,
    // The defaults must actually BE the defaults, or the lane measures
    // something else entirely.
    defaultsAreDefaults:
      d.defaultsObserved?.enableLighting === false &&
      d.defaultsObserved?.skyAtmosphereShow === true &&
      d.defaultsObserved?.skyBoxShow === true &&
      d.defaultsObserved?.starFieldShow === true &&
      d.defaultsObserved?.dynamicLightingEnum === 0,
    offlineSceneReady:
      d.globeReadiness?.settled === true &&
      d.globeReadiness?.tilesLoaded === true &&
      (d.globeReadiness?.tilesToRender ?? 0) > 0 &&
      d.readiness?.settled === true &&
      d.readiness?.tilesLoaded === true &&
      d.readiness?.atmosphereReady === true &&
      d.readiness?.atmosphereVisible === true,
    // With the shipped NONE enum and a ground camera, the shader's alpha
    // branch is analytically opaque. This checks that premise directly; it
    // does not infer it from two incomparable sparse-image statistics.
    opaqueShellAtDefaults: (d.alphaRecovered ?? 0) >= 0.98,
    opaqueShellHidesBackgroundLayers:
      d.spritesVisible === false && d.cubemapVisible === false,
  };

  // ── Every lane rendered at the instant it requires ───────────────────────
  // Asserted from the RECORDED instant, not from source. This is the gate the
  // `atInstant` round exists to make observable: a lane silently running at
  // the wrong time is the failure mode, and it was previously unverifiable
  // from artifacts because the manifest carried no timestamp.
  const instants = result.laneInstants ?? [];
  v.laneInstants = instants.map((e) => ({
    lane: e.lane,
    iso: e.iso,
    expectedIso: e.expectedIso,
    matches: e.matches,
    sunElevationDeg: r3(e.sunElevationDeg),
  }));
  v.everyLaneAtItsInstant =
    instants.length >= 6 && instants.every((e) => e.matches === true);
  // The night lanes must actually be dark, and the eclipse lanes must actually
  // have the sun up — a matching ISO with an absurd elevation would mean the
  // fixture, not the plumbing, is wrong.
  v.nightLanesAreDark = instants
    .filter((e) => e.lane === "D-defaults" || e.lane === "B4-exactlyOnce")
    .every((e) => (e.sunElevationDeg ?? 90) <= -5.74);
  v.eclipseLanesAreSunlit = instants
    .filter((e) => e.lane.startsWith("C-az") || e.lane === "A-shellAlpha")
    .every((e) => (e.sunElevationDeg ?? -90) > 0);

  const laneOk = (lane) => Object.values(lane).every((x) => typeof x !== "boolean" || x);
  v.PASS =
    laneOk(v.laneA) &&
    laneOk(v.laneB) &&
    laneOk(v.laneC) &&
    v.laneD.defaultsAreDefaults &&
    v.laneD.offlineSceneReady &&
    v.laneD.opaqueShellAtDefaults &&
    v.laneD.opaqueShellHidesBackgroundLayers &&
    v.everyLaneAtItsInstant &&
    v.nightLanesAreDark &&
    v.eclipseLanesAreSunlit;
  return v;
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prov = provenance();
  if (!prov.ok) {
    console.error(
      "[probe-eclipse-sky-totality] PROVENANCE FAILURE — stale or missing build:",
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
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    // ── Fixture selection: EVERY lane's constraint, evaluated per candidate ──
    // The in-page pass scores all 18 vantages and selects nothing; the
    // predicates live in `lib/eclipse-fixture-constraints.mjs` so they are
    // unit-testable and so a rejection names the constraint that caused it.
    const scored = await derivePage.evaluate(DERIVE_CANDIDATES);
    const { survivors, rejections: cheapRejections } = shortlistVantages(
      scored?.candidates ?? [],
    );
    let refinedResult = { refined: [] };
    if (survivors.length > 0) {
      refinedResult = await derivePage.evaluate(REFINE_VANTAGES, {
        shortlist: survivors,
        baseIso: scored.baseIso,
        nightMaxElevDeg: FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
        minSunElevDeg: FIXTURE_MIN_SUN_ELEV_DEG,
      });
    }
    const selection = selectEclipseFixture(
      refinedResult?.refined ?? [],
      cheapRejections,
    );
    await deriveContext.close().catch(() => {});

    // The constraint table is printed WHETHER OR NOT selection succeeded — a
    // future unsatisfiable combination names itself instead of surfacing as a
    // bare structural string.
    console.log("vantage constraint table (2026-08-12):");
    for (const c of scored?.candidates ?? []) {
      const row = selection.constraintTable.find(
        (r) => r.lat === c.lat && r.lon === c.lon,
      );
      const verdict = row
        ? row.ok
          ? "OK"
          : `FAIL ${row.failed.join(",")}`
        : (cheapRejections.find((r) => r.lat === c.lat && r.lon === c.lon)
            ?.failed ?? ["not-refined"]
          ).join(",");
      console.log(
        `  ${c.name.padEnd(8)} ${r3(c.lat).toString().padStart(7)},${r3(c.lon).toString().padStart(8)}  ` +
          `o=${r3(c.maxObscuration)}  sunElev=${r3(c.maxSunElevationDeg)}  ` +
          `minNightElev=${r3(c.minNightSunElevationDeg)}  ${verdict}`,
      );
    }

    if (selection.structuralError || selection.chosen === null) {
      console.error(
        "[probe-eclipse-sky-totality] fixture selection failed:",
        JSON.stringify(
          {
            structuralError: selection.structuralError,
            rejections: selection.rejections,
          },
          null,
          2,
        ),
      );
      await browser.close().catch(() => {});
      process.exit(2);
    }

    derived = {
      region: selection.chosen.name,
      lat: selection.chosen.lat,
      lon: selection.chosen.lon,
      deepest: selection.chosen.deepest,
      clear: selection.chosen.clear,
      night: selection.chosen.night,
      constraintTable: selection.constraintTable,
      rejections: selection.rejections,
    };
    console.log(
      `2026-08-12 @ ${derived.region} (${r3(derived.lat)}, ${r3(derived.lon)}):`,
    );
    console.log(
      `  deepest ${derived.deepest.iso}  o=${r3(derived.deepest.obscuration)}  sunElev ${r3(derived.deepest.sunElevationDeg)}`,
    );
    console.log(
      `  clear   ${derived.clear.iso}  o=${r3(derived.clear.obscuration)}  sunElev ${r3(derived.clear.sunElevationDeg)}`,
    );
    console.log(
      `  night   ${derived.night.iso}  sunElev ${r3(derived.night.sunElevationDeg)}`,
    );

    gl = await runBackend(browser, "webgl", derived);
    gpu = await runBackend(browser, "webgpu", derived);
  } finally {
    await browser.close().catch(() => {});
  }

  const structuralReasons = [];
  if (gl.error) structuralReasons.push(`webgl: ${gl.error}`);
  if (gpu.error) structuralReasons.push(`webgpu: ${gpu.error}`);
  if (gl.backendMismatch) structuralReasons.push(`webgl: ${gl.backendMismatch}`);
  if (gpu.backendMismatch)
    structuralReasons.push(`webgpu: ${gpu.backendMismatch}`);
  for (const [name, side] of [
    ["webgl", gl],
    ["webgpu", gpu],
  ]) {
    if (!side.result) {
      structuralReasons.push(`${name}: no result`);
    } else if (side.result.structuralError) {
      structuralReasons.push(`${name}: ${side.result.structuralError}`);
    } else if (!(side.result.laneD?.controlResponse > 0.9)) {
      structuralReasons.push(
        `${name}: lane D background control response ${r3(side.result.laneD?.controlResponse)} (expected ~1)` +
          BLOCKED_BY_ENV_PASS_DROP,
      );
    } else if (!(side.result.laneA?.controlResponse > 0.9)) {
      // The background instrument itself. `scene.backgroundColor` not reaching
      // the clear on a backend makes lane A meaningless — that is a REFERENCE
      // DISAGREEMENT about the fixture, never an engine gate failure.
      structuralReasons.push(
        `${name}: background control response ${r3(side.result.laneA?.controlResponse)} (expected ~1) — ` +
          `scene.backgroundColor is not reaching the clear, lane A is uninstrumented` +
          BLOCKED_BY_ENV_PASS_DROP,
      );
    }
  }

  const manifest = {
    probe: "probe-eclipse-sky-totality",
    when: new Date().toISOString(),
    derived,
    laneBTargetFactor: LANE_B_TARGET_FACTOR,
    expectedTwilightFloor: r6(ECLIPSE_TWILIGHT_FLOOR),
    provenance: {
      entryFresh: prov.entryFresh,
      buildIsNewer: prov.buildIsNewer,
      consideredFileCount: prov.consideredFileCount,
    },
    webgl: {
      rendererType: gl.result?.rendererType,
      defaults: gl.result?.defaults,
      consoleErrors: gl.consoleErrors.slice(0, 5),
      shotsWritten: gl.shotsWritten,
    },
    webgpu: {
      rendererType: gpu.result?.rendererType,
      defaults: gpu.result?.defaults,
      consoleErrors: gpu.consoleErrors.slice(0, 5),
      shotsWritten: gpu.shotsWritten,
    },
  };

  // ── The abort path must PRESERVE the evidence ────────────────────────────
  //
  // Previously a structural exit serialised only `derived`, `provenance`,
  // `defaults` and `shotsWritten`: every lane measurement was computed in
  // memory and discarded, so one early failure erased ALL downstream evidence
  // from that cycle. With the gate order checking lane D's control response
  // first, a single instrument defect cost every other lane's numbers too, and
  // this probe has spent several cycles surfacing one defect at a time as a
  // direct result. `judge` is now run defensively on whatever each backend
  // returned, and the RAW lane objects ride along, so a structural cycle still
  // yields every value that was computed before the abort.
  const partialVerdict = (side) => {
    if (!side?.result) {
      return { unavailable: true, error: side?.error ?? null };
    }
    try {
      return judge(side.result);
    } catch (e) {
      return { judgeThrew: String((e && e.message) || e).slice(0, 200) };
    }
  };
  const rawLanes = (side) => ({
    laneInstants: side?.result?.laneInstants ?? null,
    laneA: side?.result?.laneA ?? null,
    laneB: side?.result?.laneB ?? null,
    laneC: side?.result?.laneC ?? null,
    laneD: side?.result?.laneD ?? null,
    structuralError: side?.result?.structuralError ?? null,
  });

  if (structuralReasons.length > 0) {
    manifest.structuralReasons = structuralReasons;
    manifest.partialVerdicts = {
      webgl: partialVerdict(gl),
      webgpu: partialVerdict(gpu),
    };
    manifest.partialLanes = { webgl: rawLanes(gl), webgpu: rawLanes(gpu) };
    const file = path.join(OUT_DIR, "eclipse-sky-totality.json");
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    console.error(
      "[probe-eclipse-sky-totality] STRUCTURAL:",
      JSON.stringify(structuralReasons, null, 2),
    );
    // The per-lane instants are the single most useful thing on this path —
    // print them so the reason is visible without opening the manifest.
    for (const [name, side] of [
      ["webgl", gl],
      ["webgpu", gpu],
    ]) {
      for (const e of side?.result?.laneInstants ?? []) {
        console.error(
          `  ${name} ${e.lane.padEnd(16)} ${e.iso}  sunElev ${r3(e.sunElevationDeg)}  ` +
            `${e.matches ? "OK" : `MISMATCH expected ${e.expectedIso}`}`,
        );
      }
    }
    console.error(`  partial manifest: ${file.replaceAll("\\", "/")}`);
    process.exit(2);
  }

  manifest.verdicts = {
    webgl: judge(gl.result),
    webgpu: judge(gpu.result),
  };

  // Cross-backend parity. The alpha recovery is an algebraic quantity, so the
  // two backends must agree closely once obs-1 is fixed; a disagreement is
  // the finding, and it GATES (this is the whole point of the lane).
  const aGl = manifest.verdicts.webgl.laneA.alphaRecovered;
  const aGpu = manifest.verdicts.webgpu.laneA.alphaRecovered;
  manifest.parity = {
    alphaRecoveredWebGL: aGl,
    alphaRecoveredWebGPU: aGpu,
    alphaDelta: r3(Math.abs((aGl ?? 0) - (aGpu ?? 0))),
    alphaParity: Math.abs((aGl ?? 0) - (aGpu ?? 1)) <= 0.08,
    revealParity:
      Math.abs(
        (manifest.verdicts.webgl.laneB.revealOnSources ?? 0) -
          (manifest.verdicts.webgpu.laneB.revealOnSources ?? 0),
      ) <=
      0.5 *
        Math.max(
          manifest.verdicts.webgl.laneB.revealOnSources ?? 1,
          manifest.verdicts.webgpu.laneB.revealOnSources ?? 1,
        ),
    twilightPresentBoth:
      manifest.verdicts.webgl.laneC.presentAtEveryAzimuth &&
      manifest.verdicts.webgpu.laneC.presentAtEveryAzimuth,
    // Count both command-publication routes after a real frame on each
    // backend. This is deterministic even when the chosen ROI has no stars.
    starSubmissionWebGL: manifest.verdicts.webgl.laneB.starSubmission,
    starSubmissionWebGPU: manifest.verdicts.webgpu.laneB.starSubmission,
    catalogOnceBoth:
      manifest.verdicts.webgl.laneB.catalogDrawnOnce &&
      manifest.verdicts.webgpu.laneB.catalogDrawnOnce,
    hiddenStopsBoth:
      manifest.verdicts.webgl.laneB.hiddenStopsSubmission &&
      manifest.verdicts.webgpu.laneB.hiddenStopsSubmission,
    restoreOnceBoth:
      manifest.verdicts.webgl.laneB.restoreSchedulesOnce &&
      manifest.verdicts.webgpu.laneB.restoreSchedulesOnce,

    // ── Lane D: the convergence-vs-regression verdict, at shipped defaults ──
    // This gates the visible result of WebGPU's single-command architecture.
    // The constructor-default NONE branch is analytically opaque at a ground
    // camera. Sparse catalogue and cubemap deltas remain reported diagnostics,
    // but are not treated as equivalent visibility instruments.
    // NOTE: under shipped defaults the enum is NONE, so this alpha is the
    // constant-branch value (`mix(color.b, 1, 1) = 1`) and carries NO
    // dependence on the sun's position. It is an algebraic identity check on
    // the compositing model + the background instrument — a real premise for
    // lanes A and B4 — and NOT evidence about how dark the fixture is. The
    // command-ownership verdict lives in lane B4.
    defaultsAlphaIsIdentityCheckNotNightEvidence: true,
    defaultsAlphaWebGL: manifest.verdicts.webgl.laneD.alphaRecovered,
    defaultsAlphaWebGPU: manifest.verdicts.webgpu.laneD.alphaRecovered,
    defaultsSpritesWebGL: manifest.verdicts.webgl.laneD.spritesVisible,
    defaultsSpritesWebGPU: manifest.verdicts.webgpu.laneD.spritesVisible,
    defaultsCubemapWebGL: manifest.verdicts.webgl.laneD.cubemapVisible,
    defaultsCubemapWebGPU: manifest.verdicts.webgpu.laneD.cubemapVisible,
    defaultsAlphaParity:
      Math.abs(
        (manifest.verdicts.webgl.laneD.alphaRecovered ?? 0) -
          (manifest.verdicts.webgpu.laneD.alphaRecovered ?? 1),
      ) <= 0.08,
    defaultsOpaqueBoth:
      manifest.verdicts.webgl.laneD.opaqueShellAtDefaults &&
      manifest.verdicts.webgpu.laneD.opaqueShellAtDefaults,
    defaultsBackgroundOccludedBoth:
      manifest.verdicts.webgl.laneD.opaqueShellHidesBackgroundLayers &&
      manifest.verdicts.webgpu.laneD.opaqueShellHidesBackgroundLayers,
  };

  const file = path.join(OUT_DIR, "eclipse-sky-totality.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest.verdicts, null, 2));
  console.log(JSON.stringify(manifest.parity, null, 2));
  console.log(`manifest: ${file.replaceAll("\\", "/")}`);

  const pass =
    manifest.verdicts.webgl.PASS &&
    manifest.verdicts.webgpu.PASS &&
    manifest.parity.alphaParity &&
    manifest.parity.revealParity &&
    manifest.parity.twilightPresentBoth &&
    manifest.parity.catalogOnceBoth &&
    manifest.parity.hiddenStopsBoth &&
    manifest.parity.restoreOnceBoth &&
    manifest.parity.defaultsAlphaParity &&
    manifest.parity.defaultsOpaqueBoth &&
    manifest.parity.defaultsBackgroundOccludedBoth;

  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("[probe-eclipse-sky-totality] UNCAUGHT:", e);
  process.exit(2);
});
