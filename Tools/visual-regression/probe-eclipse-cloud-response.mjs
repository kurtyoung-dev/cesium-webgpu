#!/usr/bin/env node
// probe-eclipse-cloud-response.mjs — C13-41 (the C12-29 S3 rider) Edge
// acceptance: eclipse-driven cloud lighting, cloud shadow, and IBL
// dimming/refresh.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
// ─────────────────────────────────────────────────────────────────────────────
// C13-41 landed at Batch 871 with THREE pre-registered, falsifiable Edge
// predictions and NO probe to run them. `Tools/visual-regression/` carries the
// row's pure-Node contract (`eclipse-cloud-ibl-response.spec.mjs`, 17/17), and
// the four existing eclipse probes (`probe-eclipse-globe-shadow`,
// `probe-eclipse-scene-dimming`, `probe-eclipse-sky-totality`,
// `probe-eclipse-sun-fade`) measure NONE of the three — CO-1's reconciliation
// confirmed that. Authoring this probe is the FIRST step of the acceptance, not
// a re-run of one.
//
// THE THREE PREDICTIONS, VERBATIM FROM THE ROW:
//
//   (i)   at obscuration 0.9 the eclipse factor is 0.464228 and the cloud
//         deck's PRE-tonemap radiance ratio vs no-eclipse is exactly 0.4642;
//         post-Reinhard the DISPLAYED ratio lands between 0.46 (faint deck)
//         and ~0.63 (a bright core at exposed radiance ~1) — never above ~0.7.
//   (ii)  the ground cloud-shadow contrast changes by +0.08%
//         (`mix(1, 0.35, s)` goes 0.350000 -> 0.350293), i.e. visually
//         unchanged — a probe measuring a LARGE shadow-contrast change at 0.9
//         REFUTES the model.
//   (iii) a 0 -> 0.9 -> 0 obscuration sweep produces exactly 275 environment
//         refreshes (one first-frame baseline + 2 x 137 bucket edges, buckets
//         256 -> 119), which is quiescent on roughly two thirds of an
//         801-frame sweep.
//
// Plus the row's STILL OWED list: an IBL recovery leg that steps a clock
// through the deep phase and out the other side and asserts the environment
// brightens back, and the wall-clock cost of the 275 fills
// (`C13-41-ECLIPSE-REFRESH-COST-UNMEASURED`), which lane C times so that row
// discharges in the same run.
//
// ─────────────────────────────────────────────────────────────────────────────
// AIMING vs GATING — the discriminator is never built from what it discriminates
// ─────────────────────────────────────────────────────────────────────────────
// The engine's own `updateEclipseState` (exported as `Cesium.EclipseState`) is
// used to AIM: to locate the ground vantage and the instants whose obscuration
// hits each target. That is legitimate and deliberate — it makes the SCHEDULED
// obscuration and the REALIZED obscuration the same number by construction, so
// the ladder is exact instead of approximately located by a uniform-disc
// stand-in. It is not a gate.
//
// Every GATE compares the shipped subsystem against a SECOND implementation
// written here from the published constants:
//   `predictFactor`      — the S2 curve (flux^(1/3)), re-derived, so a silent
//                          retune of `ECLIPSE_ADAPTATION_EXPONENT` or the
//                          5-lux floor fails the probe instead of riding along;
//   `predictDirectional` — C13-41's own `visible / (visible + FLOOR*(1-visible))`;
//   `predictBucket`      — `round(f * 256)`, the 1/256 refresh grid.
// A gate that echoed the engine's own accessor would certify nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SWEEP IS A FACTOR SWEEP, AND ITS DESCENDING BRANCH IS A REVERSE REPLAY
// ─────────────────────────────────────────────────────────────────────────────
// Lane C's claim is about the FACTOR walking 1.0 -> 0.4642 -> 1.0 across a
// quantization grid. The rising branch is 401 real instants aimed at the linear
// obscuration ramp `o = 0.9 * k / 400`; the descending branch REPLAYS those
// instants in reverse (400 frames, peak not repeated). Every frame is therefore
// a real, engine-derived eclipse state, and the descending obscuration series
// is the EXACT mirror of the rising one — which is what makes "exactly 275"
// determinate rather than a coin flip on where the real falling branch's
// samples happen to land. The physical falling branch is not what the
// prediction is about; the anti-latch recovery IS, and a reverse replay
// exercises it exactly. Lane A/B use real, forward, physically-ordered instants.
//
// WHY 401 FRAMES ON THE RAMP AND NOT FEWER. The refresh count is the number of
// bucket CHANGES, not the number of bucket EDGES: a ramp coarse enough to jump
// two buckets in one frame fires ONE refresh and the count collapses. The
// bucket derivative is steepest at the deep end — `db/do = (256/3) *
// flux^(-2/3) * (1-FLOOR)`, which at o = 0.9 (flux 0.1) is ~396 per unit
// obscuration, i.e. 0.89 buckets per frame at the ramp's `do = 0.9/400`. Under
// one per frame with ~12% margin, by construction. `rampNeverSkipsABucket`
// gates that margin from the REALIZED series rather than trusting the algebra.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT EACH BACKEND GETS, AND WHY THAT IS NOT AN ASYMMETRY DEFECT
// ─────────────────────────────────────────────────────────────────────────────
// Lanes A and B are WebGPU-only because the volumetric deck and the beer-shadow
// map are WebGPU-only. The row's WebGL decision is recorded and deliberate: the
// WebGL cloud path is the billboard `CloudCollection`, whose fragment shader
// has no sun direction, no scene light and no N-dot-L — its only brightness
// input is the per-`CumulusCloud` AUTHORED `v_brightness`. An eclipse-only
// multiply would be the ONLY light response it has. That premise is a SOURCE
// claim and is pinned by `eclipse-cloud-ibl-response.spec.mjs` (E2), not
// re-litigated here.
//
// Lane C runs on BOTH backends, because the IBL leg ships on both and the
// anti-latch mechanism is the same quantized level comparison.
//
// ─────────────────────────────────────────────────────────────────────────────
// PROBE HYGIENE (fleet doctrine — `lib/weather-probe-pinning.mjs` shape)
// ─────────────────────────────────────────────────────────────────────────────
// offline globe (`&offline=true` + imagery removed + EllipsoidTerrainProvider,
// all READ BACK); `useDefaultRenderLoop=false`, `requestRenderMode=false`,
// `shouldAnimate=false`, `multiplier=0`, and EVERY render goes through
// `renderAt(julianDate)` with an explicit date; `cloudWindSpeed = 0` so the
// clock is provably inert on cloud SHAPE (`cloud.time` reaches the density
// field only as `windDirection * windSpeed * time`) — which is what makes a
// per-instant clock safe in a lane that must move the clock; `cloudQuality =
// 32` (the escape hatch: no temporal, no jitter, no half-res, LIVE noise, so
// two captures of one configuration are comparable); a DISCARDED warm-up before
// the first scored capture (the async noise prewarm renders a cold first
// fixture stable-black); same-task capture (render -> drawImage -> getImageData
// with no await between); canvas-ELEMENT screenshots; `rendererType` read back
// and hard-failed on mismatch; a determinism bracket (the first scored
// configuration is re-captured at the end and must reproduce); an unref'd
// force-exit watchdog; `browser.close()` in `finally`; every loop bounded.
//
// EXIT CONTRACT (fleet): 0 PASS / 1 gate FAIL / 2 HARNESS FAULT (the watchdog
// fired, or an exception escaped — no verdict of any kind was formed) / 3
// STRUCTURAL (the probe finished and deliberately refused to certify: a stale
// build, a failed pin, a lane that did not run, a vacuous measurement). The
// mapping is `eclipseCloudExitCode` in the gate module, not a ternary here, so
// the spec pins it directly.
//
// FAIL OUTRANKS STRUCTURAL. With per-lane scoping a run can quarantine one lane
// and still return a real verdict on another, and the real verdict is the
// actionable half. The first run had exactly that shape — a blind SHADOW lane
// and a 3x out-of-band DECK reading — and printed `failedPredicates: []`.
//
// EVERY helper used inside a `page.evaluate` callback is defined INSIDE that
// callback — module-scope bindings do not cross the serialization boundary.
//
// Usage: node Tools/visual-regression/probe-eclipse-cloud-response.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import {
  collectPinStructural,
  installWeatherPinHarnessOnPage,
  PINNED_CLOUD_QUALITY,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  DECK_AERIAL_SHARE_CROSS_RUN,
  ECLIPSE_CLOUD_BANDS,
  ECLIPSE_CLOUD_EXIT,
  ECLIPSE_CLOUD_GATE_PREDICATES,
  ECLIPSE_CLOUD_PARITY_PREDICATES,
  ECLIPSE_CLOUD_PREDICATE_LANES,
  ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES,
  SWEEP_FRAMES,
  SWEEP_PEAK_OBSCURATION,
  SWEEP_RISING_FRAMES,
  eclipseCloudExitCode,
  eclipseCloudGateLabel,
  judgeEclipseCloudResponse,
  predictBucket,
  predictDirectional,
  predictFactor,
  predictedSweepRefreshCount,
} from "./lib/eclipse-cloud-response-gate.mjs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL_URL =
  "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

// 8 minutes, not the fleet's usual 7: lane C renders 801 pinned frames on each
// of two backends on top of lanes A and B. Still a hard ceiling — the watchdog
// forces exit 2, it does not extend to fit a slow run.
const HARD_LIMIT_MS = 480000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-eclipse-cloud-response] WATCHDOG FIRED (480s) — forcing exit",
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
const r6 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1e6) / 1e6;

// ── Provenance: the probe must not run against a stale build ────────────────
const SOURCE_FILES = [
  "packages/engine/Source/Scene/EclipseCloudResponse.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
];

// NUMERAL-FREE substrings on purpose: esbuild normalises float literals
// (`1.0` -> `1`) on the way into the bundle, so a marker containing `1.0`
// matches the source but never the build (S1's lesson, cost a round).
const VERBATIM_SLICES = [
  {
    file: "packages/engine/Source/Scene/EclipseCloudResponse.js",
    marker: "return flux > ",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    marker:
      "cache.shadowStrength = eclipseCloudDirectionalFraction(frameState)",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
    marker: "cache.lastEclipseEnvBucket = eclipseEnvBucket",
  },
  {
    file: "packages/engine/Source/Scene/DynamicEnvironmentMapManager.js",
    marker: "this._lastEclipseEnvBucket = eclipseEnvBucket",
  },
  {
    // `C13-41-CLOUD-AERIAL-TINT-UNDIMMED` (CO-11). The deck's fourth eclipse
    // site. Without this slice the probe would happily re-measure the deck
    // ratio against a build that predates the fix and report the SAME 0.894.
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    marker: "dimAerialTint",
  },
];

const REQUIRED_TOKENS = [
  "quantizeEclipseEnvironmentRefreshInput",
  "eclipseCloudDirectionalFraction",
  "applyEclipseCloudDimming",
  "eclipseSceneLightFactor",
  "shadowStrength",
  "enableEclipse",
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
  for (const f of bundleFiles) {
    if (fs.statSync(f).mtimeMs >= cutoffMs) {
      considered.push(f);
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
    entryFresh,
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

// ─────────────────────────────────────────────────────────────────────────────
// IN-PAGE: derive the vantage and the exact instants for each target obscuration
// ─────────────────────────────────────────────────────────────────────────────
//
// Uses the ENGINE's own `updateEclipseState` (AIMING, not gating — see header),
// so the scheduled and realized obscurations are the same number by
// construction. Bounded: 2 regions x 5 vantages x 241 coarse samples, then a
// 44-step bisection per target.
const DERIVE_SCHEDULE = async ({ targets, rampFrames, rampPeak }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const updateEclipseState = C.EclipseState;
  if (typeof updateEclipseState !== "function") {
    return { structuralError: "Cesium.EclipseState is not the state updater" };
  }

  const state = {
    sunPositionWC: new C.Cartesian3(),
    moonPositionWC: new C.Cartesian3(),
  };
  const options = {
    active: true,
    enabled: true,
    autoExposure: false,
    horizonTwilightEnabled: true,
    cameraPositionWC: new C.Cartesian3(),
    cameraHeight: 0.0,
    time: undefined,
  };

  const setVantage = (lat, lon, height) => {
    C.Cartesian3.fromDegrees(
      lon,
      lat,
      height,
      undefined,
      options.cameraPositionWC,
    );
    options.cameraHeight = height;
  };

  const obscurationAt = (julian) => {
    options.time = julian;
    const s = updateEclipseState(state, options);
    return s.valid === true ? s.moonObscuration : 0.0;
  };

  // The 2026-08-12 total solar eclipse: a north-Atlantic / Iberian track. Two
  // candidate regions, five vantages each; the deepest wins. Deliberately the
  // same fixture family the S2 ladder probe uses, so a reader comparing the two
  // runs is comparing the same eclipse.
  const REGIONS = [
    { name: "iceland", lat: 64.15, lons: [-24.0, -21.9, -19.5, -17.0, -14.5] },
    { name: "spain", lat: 41.65, lons: [-6.0, -3.7, -1.5, 0.6, 2.8] },
  ];
  const dayStart = C.JulianDate.fromIso8601("2026-08-12T15:00:00Z");
  const COARSE_SAMPLES = 241; // 3 hours at 45 s
  const COARSE_STEP_S = 45.0;

  let best = null;
  const scratch = new C.JulianDate();
  for (const region of REGIONS) {
    for (const lon of region.lons) {
      setVantage(region.lat, lon, 0.0);
      for (let i = 0; i < COARSE_SAMPLES; i++) {
        C.JulianDate.addSeconds(dayStart, i * COARSE_STEP_S, scratch);
        const o = obscurationAt(scratch);
        if (best === null || o > best.obscuration) {
          best = {
            region: region.name,
            lat: region.lat,
            lon,
            obscuration: o,
            index: i,
            iso: C.JulianDate.toIso8601(scratch),
            seconds: i * COARSE_STEP_S,
          };
        }
      }
    }
  }
  if (best === null || !(best.obscuration > rampPeak)) {
    return {
      structuralError: `no vantage reached obscuration ${rampPeak}; deepest ${best ? best.obscuration : "none"}`,
      best,
    };
  }

  setVantage(best.lat, best.lon, 0.0);

  // The RISING branch bracket: from the last sample at (near) zero obscuration
  // up to the peak sample. Bisection needs a monotone bracket, and the rising
  // branch is monotone by construction.
  let riseStartSeconds = 0.0;
  for (let i = best.index; i >= 0; i--) {
    C.JulianDate.addSeconds(dayStart, i * COARSE_STEP_S, scratch);
    if (obscurationAt(scratch) <= 0.0) {
      riseStartSeconds = i * COARSE_STEP_S;
      break;
    }
  }
  const peakSeconds = best.seconds;

  // Bisect the rising branch for the time at which obscuration === target.
  const timeForObscuration = (target) => {
    if (!(target > 0.0)) {
      return riseStartSeconds;
    }
    let lo = riseStartSeconds;
    let hi = peakSeconds;
    for (let i = 0; i < 44; i++) {
      const mid = 0.5 * (lo + hi);
      C.JulianDate.addSeconds(dayStart, mid, scratch);
      if (obscurationAt(scratch) < target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return 0.5 * (lo + hi);
  };

  const instantAt = (seconds) => {
    C.JulianDate.addSeconds(dayStart, seconds, scratch);
    return {
      seconds,
      iso: C.JulianDate.toIso8601(scratch),
      obscuration: obscurationAt(scratch),
    };
  };

  // Lane A/B ladder: the named targets, in ascending (forward-in-time) order.
  const ladder = targets.map((target) => {
    const rung = instantAt(timeForObscuration(target));
    rung.target = target;
    return rung;
  });

  // Lane C ramp: the RISING branch only. The driver mirrors it for the
  // descending branch (reverse replay — see the file header).
  const ramp = [];
  for (let k = 0; k < rampFrames; k++) {
    const target = (rampPeak * k) / (rampFrames - 1);
    ramp.push(instantAt(timeForObscuration(target)));
  }

  return {
    region: best.region,
    lat: best.lat,
    lon: best.lon,
    peakObscuration: best.obscuration,
    peakIso: best.iso,
    riseStartSeconds,
    peakSeconds,
    ladder,
    ramp,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// IN-PAGE: lanes A + B (WebGPU only) — deck lighting and cloud-shadow contrast
// ─────────────────────────────────────────────────────────────────────────────
const RUN_CLOUD_LANES = async (cfg) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const pin = globalThis.__weatherPin;
  const cloudProbe = globalThis.__cloudProbe;
  const viewer = window.viewer;
  const scene = viewer.scene;

  // ── P1/P2: offline globe, one render driver, one clock.
  //
  // THE SKY IS REMOVED, and the reason is arithmetic (Batch 909). The first run
  // kept it on this rationale: "the deck is measured as a DIFFERENCE against a
  // clouds-off capture of the same instant, so whatever the sky contributes
  // cancels exactly." That is FALSE. The deck composites as
  // `mix(sceneColor, deckColor, cloudAlpha)`, so
  //
  //     cloudsOn - cloudsOff = alpha * (H - S)
  //
  // — the background S survives the difference with a MINUS sign. It does not
  // cancel across eclipse positions either: the sky is tonemapped by the scene
  // chain (Reinhard + inverseGamma) while the deck carries its own private
  // Reinhard at `cloud.exposure` and composites AFTER the gamma stage, so the
  // two dim at different DISPLAY rates. When H and S land close the denominator
  // collapses and the ratio diverges — which is how a deck that CANNOT brighten
  // (its pre-tonemap radiance is exactly linear in the eclipse factor, and
  // Reinhard is monotone, so H(F) <= H(1) and the true ratio is bounded by 1)
  // measured 2.937.
  //
  // With the sky shell, skybox, sun, moon and clear colour all black, S ~ 0 and
  // the difference IS `alpha * H` — the quantity the [0.44, 0.70] band was
  // derived for. `deckBackgroundIsDark` reads the precondition back rather than
  // trusting this comment.
  const pins = pin.pinScene(C, {
    groundAtmosphere: false,
    fog: false,
    sky: false,
  });
  scene.globe.enableLighting = true;

  // ── LANE B PRECONDITION (Batch 911): the GROUND has to be able to carry a
  // contrast at all.
  //
  // The offline pin removes every imagery layer, so the globe renders
  // `GlobeSurfaceTileProvider.baseColor`, whose default is
  // `new Color(0.0, 0.0, 0.5, 1.0)` (`Scene/GlobeSurfaceTileProvider.js:409`) —
  // a Rec.709 luma of 0.036 BEFORE `enableLighting`'s Lambert term. The second
  // Edge run's lane B read a ground band mean of 0.5125 against that: the band
  // was ~98% sunlit CLOUD TOP and ~2% ground. A cast shadow floors the ground at
  // `max(exp(-tau*0.04), 0.35)` (`GlobeTerrain.wgsl:2219`), i.e. it can remove at
  // most 65% of the ground's share — 0.65 * 0.018 = 1.2% of the band, so the
  // measured contrast could not have crossed the 0.98 vacuity ceiling even with
  // EVERY visible ground pixel fully shadowed. The lane was vacuous by
  // construction for a PHOTOMETRIC reason, the same way the first run's 300 m
  // vantage was vacuous for a GEOMETRIC one.
  //
  // A neutral bright base colour puts the ground at ~0.7 display luma, the same
  // order as the deck, so the 65% floor is worth ~0.45 of the band. Read back
  // below, and `shadowGroundIsBright` gates the read-back rather than this
  // assignment.
  scene.globe.baseColor = C.Color.fromBytes(200, 200, 200);

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;
  if (!ac || !ac.lighting || !("enableEclipse" in ac.lighting)) {
    return {
      structuralError: "no atmosphericConditions.lighting.enableEclipse",
    };
  }
  // C12-29 S5's per-fragment umbra is an ORTHOGONAL sub-effect that darkens the
  // globe surface independently of anything this row touches. Lane B measures a
  // ground CONTRAST, and S5 moves both bands; switching it off is what its own
  // docstring says isolation probes should do.
  if ("enableEclipseGlobeShadow" in ac.lighting) {
    ac.lighting.enableEclipseGlobeShadow = false;
  }

  const setEclipse = (on) => {
    ac.lighting.enableEclipse = on;
  };

  const configure = (extra) =>
    cloudProbe.configure({
      requireWebGPU: true,
      enableVolumetric: extra.enableVolumetric !== false,
      volumetric: {
        cloudCoverage: 0.6,
        cloudDensity: 0.5,
        cloudLayerBottom: 1500,
        cloudLayerTop: 4000,
        // CO-19: the aerial dial is re-pinned to its shipped default on EVERY
        // configure, not just restored after the diagnostic leg. The dials live
        // on a persistent `CloudVolumetrics` object, so a leg that zeroes float
        // 91 and forgets to put it back silently re-scores every later capture
        // — and the harness round-trip-verifies each key, so pinning it here
        // also makes the default itself a read-back rather than an assumption.
        cloudAerialStrength: 1.0,
        ...cfg.determinismDials,
        ...(extra.dials ?? {}),
      },
    });

  // ── Band reducers. Defined INSIDE the callback (serialization boundary).
  const bandMean = (frame, y0, y1) => {
    const { data, width, height } = frame;
    const top = Math.floor(height * y0);
    const bottom = Math.floor(height * y1);
    let sum = 0;
    let samples = 0;
    for (let y = top; y < bottom; y += 2) {
      for (let x = Math.floor(width * 0.15); x < width * 0.85; x += 2) {
        const i = (y * width + x) * 4;
        // Rec.709 luma on the captured (display-transformed) values.
        sum +=
          (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) /
          255;
        samples++;
      }
    }
    return { mean: samples ? sum / samples : 0, samples };
  };

  const skyBand = (frame) => bandMean(frame, 0.05, 0.45);
  const groundBand = (frame) => bandMean(frame, 0.6, 0.95);

  // ── LANE B TELEMETRY (Batch 911). CPU-side reads only, so they cost one
  // property access each and can be taken in the same task as the capture.
  //
  // The second run left three questions unanswerable from its own report, and
  // each of these answers exactly one of them:
  //   "did the shadow PRODUCER run?"   -> `cloudCacheTelemetry`
  //   "did the CONSUMER's gate open?"  -> `globeUniformTelemetry` (the packed
  //                                       `cloudShadowControl` the terrain FS
  //                                       branches on, read out of the globe
  //                                       surface renderer's own UB scratch)
  //   "does the scored band even LIE   -> `shadowFootprintTelemetry`
  //    inside the shadow footprint?"
  const cloudCacheTelemetry = () => {
    const cache = scene.context?._cloudCache;
    if (!cache) {
      return null;
    }
    return {
      shadowActive: cache.shadowActive ?? null,
      shadowStrength: cache.shadowStrength ?? null,
      shadowAbsorption: cache.shadowAbsorption ?? null,
      shadowSize: cache.shadowSize ?? null,
      shadowViewPresent: !!cache.shadowView,
      shadowFrameValid: cache.shadowFrame?.valid ?? null,
      shadowFrameHalfExtent: cache.shadowFrame?.halfExtent ?? null,
      shadowCascadeActive: cache.shadowCascadeActive ?? null,
    };
  };

  // The globe surface renderer packs `cloudShadowVP` at floats 148-163 and
  // `cloudShadowControl` at 164-167, with the C13-06 eye-relative flag in
  // `cloudShadowCascadeParams.y` at 229 (`WebGPUGlobeSurfaceCameraUB.ts:820-935`
  // and `:1084-1118`). Reading the scratch after a render is the CONSUMER-side
  // truth: `control.x <= 0.5` means the terrain FS never entered the shadow
  // branch at all, whatever the producer published.
  const globeUniformTelemetry = () => {
    const fr = scene.context?.getFeatureRenderer?.(cfg.globeSurfaceKey);
    const data = fr?._cameraUniformData;
    if (!data || data.length < 232) {
      return null;
    }
    return {
      cloudShadowControl: [data[164], data[165], data[166], data[167]],
      cloudShadowRelativeToEye: data[229],
      cloudShadowVpTranslationColumn: [
        data[160],
        data[161],
        data[162],
        data[163],
      ],
    };
  };

  // Project the ground the SCORED BAND actually sees through the published
  // absolute sun-view VP. `sampleCloudGroundShadow` returns 1.0 (no shadow) for
  // any fragment whose uv leaves [0,1], so an `inside: false` here is a complete
  // explanation for a blind lane. `texel` makes the CO-10 texel-count argument
  // measurable instead of derived: the band must span more than one texel of the
  // 512-wide map.
  const shadowFootprintTelemetry = () => {
    const cache = scene.context?._cloudCache;
    const vp = cache?.shadowSunViewVP;
    if (!vp || vp.length < 16) {
      return null;
    }
    const canvas = scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const size = cache.shadowSize ?? 512;
    const samples = [];
    for (const fraction of [0.6, 0.775, 0.95]) {
      const windowPosition = new C.Cartesian2(width * 0.5, height * fraction);
      const ray = scene.camera.getPickRay(windowPosition);
      const world = ray ? scene.globe.pick(ray, scene) : undefined;
      if (!world) {
        samples.push({ bandFraction: fraction, groundHit: false });
        continue;
      }
      // Column-major mat4 * vec4(world, 1), matching the WGSL exactly.
      const cx = vp[0] * world.x + vp[4] * world.y + vp[8] * world.z + vp[12];
      const cy = vp[1] * world.x + vp[5] * world.y + vp[9] * world.z + vp[13];
      const cw = vp[3] * world.x + vp[7] * world.y + vp[11] * world.z + vp[15];
      const w = Math.abs(cw) > 1e-6 ? Math.abs(cw) : 1e-6;
      const u = (cx / w) * 0.5 + 0.5;
      const v = 1.0 - ((cy / w) * 0.5 + 0.5);
      samples.push({
        bandFraction: fraction,
        groundHit: true,
        u,
        v,
        inside: u >= 0 && u <= 1 && v >= 0 && v <= 1,
        texel: [u * size, v * size],
        rangeMeters: C.Cartesian3.distance(world, scene.camera.positionWC),
      });
    }
    const hits = samples.filter((sample) => sample.groundHit);
    return {
      shadowMapSize: size,
      samples,
      allInside: hits.length > 0 && hits.every((sample) => sample.inside),
      // The band's extent in shadow texels — the number CO-10's "smaller than
      // ONE texel" argument was about. Measured here, not derived from a FOV.
      texelSpan:
        hits.length >= 2
          ? Math.hypot(
              hits[hits.length - 1].texel[0] - hits[0].texel[0],
              hits[hits.length - 1].texel[1] - hits[0].texel[1],
            )
          : null,
    };
  };

  // ── Camera: ground vantage, ANTI-SOLAR azimuth so the S1 sun billboard is
  // out of frame entirely and nothing measured here can be its alpha fade.
  //
  // The two lanes need DIFFERENT altitudes and each passes its own; see
  // `cfg.cameraHeight` (lane A, under the deck, looking up) and
  // `cfg.groundCameraHeight` (lane B, above the deck, looking down at a ground
  // patch large enough to resolve the cast shadow).
  const aimCamera = (julian, pitchDegrees, heightMeters) => {
    const carto = C.Cartographic.fromDegrees(
      cfg.lon,
      cfg.lat,
      heightMeters ?? cfg.cameraHeight,
    );
    const positionWC = C.Cartographic.toCartesian(carto);
    const enu = C.Transforms.eastNorthUpToFixedFrame(positionWC);
    const sunWC =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        julian,
        new C.Cartesian3(),
      );
    const rot = C.Transforms.computeIcrfToCentralBodyFixedMatrix(
      julian,
      new C.Matrix3(),
    );
    C.Matrix3.multiplyByVector(rot, sunWC, sunWC);
    const toSun = C.Cartesian3.normalize(
      C.Cartesian3.subtract(sunWC, positionWC, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const inverseEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
    const sunLocal = C.Matrix4.multiplyByPointAsVector(
      inverseEnu,
      toSun,
      new C.Cartesian3(),
    );
    const sunHeading = Math.atan2(sunLocal.x, sunLocal.y);
    scene.camera.setView({
      destination: positionWC,
      orientation: {
        heading: sunHeading + Math.PI,
        pitch: C.Math.toRadians(pitchDegrees),
        roll: 0.0,
      },
    });
  };

  const results = { rungs: [], structuralError: null, pins, dials: null };

  // ── Readiness: the lazy procedural feature renderer must have EXECUTED, and
  // the globe must have BINNED commands. A fixed rAF count is not evidence.
  configure({});
  results.dials = pin.readDials();
  const firstTime = C.JulianDate.fromIso8601(cfg.ladder[0].iso);
  const ready = await cloudProbe.awaitProceduralReady({
    featureRendererKey: cfg.proceduralKey,
    frameTime: firstTime,
    maxFrames: 240,
  });
  const globeReadiness = await pin.awaitGlobeReady(C, firstTime, 400, 60000);
  results.ready = ready;
  results.globeReadiness = { first: globeReadiness };

  // ── Discarded warm-up. The async noise prewarm renders a cold first fixture
  // stable-black; a scored capture taken there is not a measurement.
  aimCamera(firstTime, cfg.skyPitchDegrees);
  await pin.settle(firstTime, 1200);
  pin.capture(firstTime, false); // discarded on purpose

  const captures = [];
  const captureLabelled = (label, julian, wantPng) => {
    const frame = pin.capture(julian, wantPng);
    captures.push({ label, slots: frame.slots });
    return frame;
  };

  const shots = [];
  for (let index = 0; index < cfg.ladder.length; index++) {
    const rung = cfg.ladder[index];
    const julian = C.JulianDate.fromIso8601(rung.iso);
    const deepest = index === cfg.ladder.length - 1;

    // ── LANE A: deck lighting. Four captures at ONE instant:
    //   (cloudsOn, eclipseOff) (cloudsOff, eclipseOff)
    //   (cloudsOn, eclipseOn)  (cloudsOff, eclipseOn)
    // The deck's own contribution is the DIFFERENCE within each eclipse
    // position, so the sky — which S2 already dims through its own sites —
    // cancels exactly and what is left is the deck.
    aimCamera(julian, cfg.skyPitchDegrees);
    setEclipse(false);
    configure({ enableVolumetric: true });
    await pin.settle(julian, cfg.settleMs);
    const aOffClouds = skyBand(
      captureLabelled(`A${index}-eclipseOff-cloudsOn`, julian, deepest),
    );
    const offCloudsPng = deepest ? pin.capture(julian, true).png : null;
    configure({ enableVolumetric: false });
    await pin.settle(julian, cfg.settleMs);
    const aOffBare = skyBand(
      captureLabelled(`A${index}-eclipseOff-cloudsOff`, julian, false),
    );

    setEclipse(true);
    configure({ enableVolumetric: true });
    await pin.settle(julian, cfg.settleMs);
    const aOnFrame = captureLabelled(
      `A${index}-eclipseOn-cloudsOn`,
      julian,
      deepest,
    );
    const aOnClouds = skyBand(aOnFrame);
    const onCloudsPng = deepest ? aOnFrame.png : null;
    configure({ enableVolumetric: false });
    await pin.settle(julian, cfg.settleMs);
    const aOnBare = skyBand(
      captureLabelled(`A${index}-eclipseOn-cloudsOff`, julian, false),
    );

    // ── LANE A DIAGNOSTIC LEG (CO-19), deepest rung only: cloudAerialStrength
    // = 0. Pre-registered by CO-17 as the ONE number that pins the deck's
    // display transform without a cross-run input.
    //
    // `ProceduralClouds.wgsl:2557` composites the deck as
    // `mix(toneMapped, cloud.aerialColor, aerial)`, and float 91 is the
    // `aerial` scale (`config.cloudAerialStrength ?? 1.0`,
    // `WebGPUProceduralCloudRenderer.ts:2273`). Zeroing it sets the tint
    // fraction to exactly 0, so this leg's own `cloudsOn - cloudsOff` ratio IS
    // the pure deck ratio rho = F(1+e)/(1+F*e) and `e` reads off ONE
    // measurement. PRE-REGISTERED: the deepest rung reads 0.635 +/- 0.01.
    //
    // TWO captures, not four: the dial scales a term INSIDE the cloud shader,
    // so the clouds-OFF frames are aerial-independent by construction and the
    // same instant's already-captured `aOffBare` / `aOnBare` are the correct
    // background to subtract. Capturing them again would cost two more settles
    // to re-measure a number the dial cannot move.
    let aerialZero = null;
    if (deepest) {
      const aerialZeroDials = { cloudAerialStrength: 0.0 };
      setEclipse(false);
      configure({ enableVolumetric: true, dials: aerialZeroDials });
      await pin.settle(julian, cfg.settleMs);
      const zOffClouds = skyBand(
        captureLabelled(`A${index}-aerial0-eclipseOff-cloudsOn`, julian, false),
      );
      setEclipse(true);
      configure({ enableVolumetric: true, dials: aerialZeroDials });
      await pin.settle(julian, cfg.settleMs);
      const zOnClouds = skyBand(
        captureLabelled(`A${index}-aerial0-eclipseOn-cloudsOn`, julian, false),
      );
      aerialZero = {
        aerialStrength: 0.0,
        offClouds: zOffClouds.mean,
        onClouds: zOnClouds.mean,
        offBare: aOffBare.mean,
        onBare: aOnBare.mean,
        offContribution: zOffClouds.mean - aOffBare.mean,
        onContribution: zOnClouds.mean - aOnBare.mean,
        samples: zOffClouds.samples,
      };
      // The dial goes back on the very next `configure`, which re-pins it to
      // 1.0 unconditionally — see the `configure` helper.
    }

    // The engine's published state for THIS instant, read in the same task as
    // the render that produced it.
    setEclipse(true);
    configure({ enableVolumetric: true });
    pin.renderAt(julian);
    const eclipseState = scene.frameState?.eclipseState;
    const published = {
      moonObscuration: eclipseState ? eclipseState.moonObscuration : null,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      enabled: eclipseState ? eclipseState.enabled : null,
      valid: eclipseState ? eclipseState.valid : null,
      shadowStrength: scene.context?._cloudCache?.shadowStrength ?? null,
    };
    setEclipse(false);
    pin.renderAt(julian);
    const publishedOff = {
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      moonObscuration: scene.frameState?.eclipseState?.moonObscuration ?? null,
      shadowStrength: scene.context?._cloudCache?.shadowStrength ?? null,
    };

    // ── LANE B: ground cloud-shadow CONTRAST. Look down; toggle
    // `cloudCastShadows` at one instant in each eclipse position. The contrast
    // is `shadowOn / shadowOff`, and the CLAIM is that the eclipse leaves that
    // ratio essentially unchanged (+0.08%) — because an eclipse dims the direct
    // beam and the skylight together, so the shadow's contrast ratio survives
    // until the nonlocal umbral floor takes over.
    //
    // THE LANE FLIES ITS OWN CAMERA, and that is what the first run got wrong.
    // The cast-shadow map is a 512x512 ortho render over a +/-60 km footprint
    // centred on the camera's geodetic surface point
    // (`CLOUD_SHADOW_SIZE = 512` and `CLOUD_SHADOW_FOOTPRINT_M = 60000.0`,
    // `WebGPUProceduralCloudRenderer.ts:918,926`), i.e. ONE TEXEL IS 234 m of
    // ground. Lane A's 300 m vantage put the scored ground band
    // (60%..95% of the frame at -35 deg, vertical half-FOV ~17.5 deg on this
    // canvas) at ground ranges of 300/tan(50.8 deg) = 245 m to
    // 300/tan(38.6 deg) = 376 m — a strip ~131 m deep and ~200-300 m wide, i.e.
    // SMALLER THAN A SINGLE SHADOW TEXEL. The map is constant over the whole
    // measured band by construction, so the lane could only ever read "the one
    // texel under the camera", and a ~63%-clear field reads clear most of the
    // time. 0.9969 is that reading, not a missing feature.
    //
    // Batch 909 flew this at 9000 m / -38 deg, where the same band spans
    // 9000/tan(53.8 deg) = 6.6 km to 9000/tan(41.6 deg) = 10.1 km — a ~3.5 km
    // strip, ~15 x 35 texels. That fixed the GEOMETRIC vacuity and the second
    // Edge run still read 0.9987, because the lane had a SECOND, PHOTOMETRIC
    // vacuity underneath it, and the numbers in the run's own report identify it
    // exactly:
    //
    //   band mean, clear         0.512511   ground share ~1.8%, deck ~98%
    //   band mean, obscuration 0.9   0.378175
    //
    // Fit `(1-a)*G + a*D` with the offline globe's `baseColor` = (0, 0, 0.5)
    // (display luma 0.036, `GlobeSurfaceTileProvider.js:409`) and lane A's own
    // measured deck response: a = 0.70, D = 0.719, and the clear/eclipsed pair
    // reproduces to 0.513 / 0.3786 against the measured 0.5125 / 0.37818. At a
    // 1.8% ground share the beer floor's maximum reach is 0.65 * 0.018 = 1.2% of
    // the band, so the contrast COULD NOT have crossed the 0.98 vacuity ceiling
    // however well the cast shadow worked. The 0.126% it did move corresponds to
    // ~11% of the visible ground being shadowed — i.e. the shadow WAS there.
    //
    // Batch 911 therefore flies the lane BELOW the deck and looks down. At
    // `groundCameraHeight` = 1400 m (the deck's floor is 1500 m) with a -8 deg
    // pitch, the scored 60%..95% band covers down-angles 11.7 deg to 24.3 deg
    // (vertical half-FOV 18 deg on this 1280x720 canvas) and therefore ground
    // ranges 1400/tan(24.3 deg) = 3.1 km to 1400/tan(11.7 deg) = 6.8 km — a
    // ~3.7 km strip, ~16 texels of the 234 m/texel map, so the geometric fix
    // survives. What changes is that the line of sight to that ground NEVER
    // crosses the 1500-4000 m deck, because the deck is entirely ABOVE the
    // camera: the band is ground, and the cast shadow lands on it in full.
    // `shadowGroundNotOccluded` reads that back instead of trusting it.
    //
    // `cloudDensity` stays at the 0.85 that `probe-cloud-shadows-flagon` and
    // `probe-cloud-shadow-cascades` use: the ground term is
    // `max(exp(-opticalDepth * 0.04), 0.35)` (`GlobeTerrain.wgsl:2219`), so a
    // half-density deck halves the optical depth and the darkening with it.
    // Density is lane B's own dial and does not touch lane A, whose subject is
    // the deck's own radiance.
    aimCamera(julian, cfg.groundPitchDegrees, cfg.groundCameraHeight);
    const groundDials = { cloudDensity: cfg.groundCloudDensity };
    setEclipse(false);
    // The DECK-FREE ground control. Without it "the band is ground" is an
    // assumption, and the second run proves an assumption is not enough: this is
    // the same class of read-back `deckBackgroundIsDark` added for lane A.
    configure({ enableVolumetric: false, dials: groundDials });
    await pin.settle(julian, cfg.settleMs);
    const bOffNoCloud = groundBand(
      captureLabelled(`B${index}-eclipseOff-cloudsOff`, julian, false),
    );
    configure({
      enableVolumetric: true,
      dials: { ...groundDials, cloudCastShadows: false },
    });
    await pin.settle(julian, cfg.settleMs);
    const bOffNoShadow = groundBand(
      captureLabelled(`B${index}-eclipseOff-shadowOff`, julian, false),
    );
    configure({
      enableVolumetric: true,
      dials: { ...groundDials, cloudCastShadows: true },
    });
    await pin.settle(julian, cfg.settleMs);
    const bOffShadow = groundBand(
      captureLabelled(`B${index}-eclipseOff-shadowOn`, julian, false),
    );
    const shadowStrengthOff =
      scene.context?._cloudCache?.shadowStrength ?? null;
    const shadowActiveOff = scene.context?._cloudCache?.shadowActive ?? null;
    const cloudCacheOff = cloudCacheTelemetry();
    const globeUniformOff = globeUniformTelemetry();
    const footprintOff = shadowFootprintTelemetry();

    // ── THE SETTLED TWIN of the deck-free control (CO-21). The SAME
    // configuration as `bOffNoCloud`, re-captured at the END of the leg instead
    // of at its start, i.e. three settles further from the leg's own eclipse
    // transition instead of one.
    //
    // WHY IT EXISTS. The fifth run measured `onNoCloud / offNoCloud` = 0.449 at
    // obscuration ZERO, where the published laws force 1.0, and its two
    // candidate causes are indistinguishable in that run's own numbers: either
    // the globe's light path really is dimmed by merely ENABLING the eclipse
    // (engine), or the deck-free capture is the ONLY scored capture in the
    // probe taken one settle after a genuine eclipse-state transition and had
    // not converged (instrument). The first-vs-settled delta separates them
    // with one extra capture per leg: a converged reading proves the number is
    // the measurement, and a moving one proves it was not.
    //
    // IT IS TAKEN ON BOTH LEGS, at the same ordinal position within each leg.
    // A repeat on the eclipse-ON leg alone would re-introduce exactly the
    // unmatched-ordering defect it exists to detect — the comparison would then
    // be a first-position OFF read against a last-position ON read.
    configure({ enableVolumetric: false, dials: groundDials });
    await pin.settle(julian, cfg.settleMs);
    const bOffNoCloudSettled = groundBand(
      captureLabelled(`B${index}-eclipseOff-cloudsOff-settled`, julian, false),
    );

    setEclipse(true);
    // ── THE DECK-FREE ECLIPSE-ON TWIN (CO-19), at the SAME instant as
    // `bOffNoCloud` and with the identical configuration apart from the eclipse
    // toggle. CO-17 derived that the published laws require the deck-free
    // ground band to dim by exactly F; `onNoCloud / offNoCloud` is the only
    // measurement that says whether it does, and therefore whether the ~12.6%
    // under-dim CO-17 measured with the deck ON belongs to the globe's own
    // light path or to the cloud subsystem. See
    // `deckFreeGroundDimTolerance` in the gate module for the tolerance and
    // both verdict shapes.
    configure({ enableVolumetric: false, dials: groundDials });
    await pin.settle(julian, cfg.settleMs);
    const bOnNoCloud = groundBand(
      captureLabelled(`B${index}-eclipseOn-cloudsOff`, julian, false),
    );
    configure({
      enableVolumetric: true,
      dials: { ...groundDials, cloudCastShadows: false },
    });
    await pin.settle(julian, cfg.settleMs);
    const bOnNoShadow = groundBand(
      captureLabelled(`B${index}-eclipseOn-shadowOff`, julian, false),
    );
    configure({
      enableVolumetric: true,
      dials: { ...groundDials, cloudCastShadows: true },
    });
    await pin.settle(julian, cfg.settleMs);
    const bOnShadow = groundBand(
      captureLabelled(`B${index}-eclipseOn-shadowOn`, julian, false),
    );
    const shadowStrengthOn = scene.context?._cloudCache?.shadowStrength ?? null;
    const shadowActiveOn = scene.context?._cloudCache?.shadowActive ?? null;
    const cloudCacheOn = cloudCacheTelemetry();
    const globeUniformOn = globeUniformTelemetry();

    // CO-21: the eclipse-ON half of the settled twin, at the same ordinal
    // position within its leg as the OFF one above. See the block there.
    configure({ enableVolumetric: false, dials: groundDials });
    await pin.settle(julian, cfg.settleMs);
    const bOnNoCloudSettled = groundBand(
      captureLabelled(`B${index}-eclipseOn-cloudsOff-settled`, julian, false),
    );

    // Restore the lane-A dials so the next rung starts from one configuration.
    configure({ enableVolumetric: true });

    if (deepest && onCloudsPng && offCloudsPng) {
      shots.push({ name: "deepest-eclipseOn-cloudsOn", png: onCloudsPng });
      shots.push({ name: "deepest-eclipseOff-cloudsOn", png: offCloudsPng });
    }

    results.rungs.push({
      target: rung.target,
      iso: rung.iso,
      published,
      publishedOff,
      deck: {
        offClouds: aOffClouds.mean,
        offBare: aOffBare.mean,
        onClouds: aOnClouds.mean,
        onBare: aOnBare.mean,
        offContribution: aOffClouds.mean - aOffBare.mean,
        onContribution: aOnClouds.mean - aOnBare.mean,
        samples: aOffClouds.samples,
      },
      // CO-19: the `cloudAerialStrength = 0` leg, deepest rung only. `null`
      // everywhere else, and the gate reads it off the deepest rung.
      deckAerialZero: aerialZero,
      shadow: {
        // The DECK-FREE ground, i.e. what the band would read with no cloud in
        // the scene at all. `offNoShadow / offNoCloud` is then the fraction of
        // the ground band the deck did NOT take over, which is the precondition
        // the second run silently failed.
        offNoCloud: bOffNoCloud.mean,
        // CO-19: the eclipse-ON twin of the same deck-free control, captured at
        // the same instant. `onNoCloud / offNoCloud` is the attribution.
        onNoCloud: bOnNoCloud.mean,
        // CO-21: the SETTLED twins of both deck-free controls — same dials,
        // same instant, last position in the leg instead of first. The pair of
        // deltas is what says whether the two reads above are measurements or
        // transients; see the block at the OFF capture.
        offNoCloudSettled: bOffNoCloudSettled.mean,
        onNoCloudSettled: bOnNoCloudSettled.mean,
        offNoShadow: bOffNoShadow.mean,
        offShadow: bOffShadow.mean,
        onNoShadow: bOnNoShadow.mean,
        onShadow: bOnShadow.mean,
        strengthOff: shadowStrengthOff,
        strengthOn: shadowStrengthOn,
        // The engine's own "a shadow map was rendered this frame" flag. Read
        // (not gated) so a vacuity structural can be told apart at a glance:
        // `shadowActive: false` means the producer never ran, `true` with a
        // clear contrast means the map ran and the footprint had no cloud in
        // it — two different diagnoses, and the first run could distinguish
        // neither. It HAS been in the report JSON since Batch 909; what was
        // missing is that no verdict or console line read it, so a reader saw
        // "the shadow lane is blind" with the producer's own answer sitting
        // three levels down in the file. `shadowTelemetry` in the verdicts and
        // the SHADOW console line close that.
        shadowActiveOff,
        shadowActiveOn,
        // Producer / consumer / footprint, per eclipse position.
        cloudCacheOff,
        cloudCacheOn,
        globeUniformOff,
        globeUniformOn,
        footprintOff,
        cameraHeight: cfg.groundCameraHeight,
        pitchDegrees: cfg.groundPitchDegrees,
        samples: bOffShadow.samples,
      },
    });
  }

  // ── Determinism bracket: re-capture the FIRST scored configuration and
  // require it to reproduce. Without this, residual capture noise is
  // indistinguishable from a real effect at the tight lane-B band.
  {
    const rung = cfg.ladder[0];
    const julian = C.JulianDate.fromIso8601(rung.iso);
    aimCamera(julian, cfg.skyPitchDegrees);
    setEclipse(false);
    configure({ enableVolumetric: true });
    await pin.settle(julian, cfg.settleMs);
    const repeat = skyBand(
      captureLabelled("repeat-A0-eclipseOff-cloudsOn", julian, false),
    );
    results.repeat = {
      first: results.rungs[0].deck.offClouds,
      again: repeat.mean,
      delta: Math.abs(repeat.mean - results.rungs[0].deck.offClouds),
    };
  }

  results.captures = captures;
  results.shots = shots;
  // The lane-B ground pin, READ BACK. `baseColor` is what the offline globe
  // renders with every imagery layer removed, so its luma is the ceiling on any
  // ground contrast this lane can measure.
  {
    const base = scene.globe.baseColor;
    results.groundPin = {
      baseColor: base ? [base.red, base.green, base.blue] : null,
      baseColorLuma: base
        ? 0.2126 * base.red + 0.7152 * base.green + 0.0722 * base.blue
        : null,
      enableLighting: scene.globe.enableLighting === true,
      globeSurfaceRendererResolved: !!scene.context?.getFeatureRenderer?.(
        cfg.globeSurfaceKey,
      ),
    };
  }
  results.rendererType = String(
    scene.context?.rendererType ?? "",
  ).toLowerCase();
  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
// IN-PAGE: lane C — IBL dimming, the quantized refresh cadence, and recovery
// ─────────────────────────────────────────────────────────────────────────────
const RUN_IBL_SWEEP = async (cfg) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const pin = globalThis.__weatherPin;
  const viewer = window.viewer;
  const scene = viewer.scene;

  const pins = pin.pinScene(C, {
    groundAtmosphere: false,
    fog: false,
  });

  // P10 is collected FIRST, while the globe is still shown: the readiness
  // read-back proves the offline globe actually reached the frame. Only then
  // does the lane hide it, because the measured quantity is the MODEL's
  // IBL-lit brightness and a lit globe would dominate the band.
  const readinessTime = C.JulianDate.fromIso8601(cfg.ramp[0].iso);
  const globeReadiness = await pin.awaitGlobeReady(
    C,
    readinessTime,
    300,
    30000,
  );

  scene.globe.show = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.light = new C.DirectionalLight({
    direction: new C.Cartesian3(0, 0, -1),
    color: C.Color.BLACK,
    intensity: 0.0,
  });

  const ac = scene.globe ? scene.globe.atmosphericConditions : null;
  if (!ac || !ac.lighting || !("enableEclipse" in ac.lighting)) {
    return {
      structuralError: "no atmosphericConditions.lighting.enableEclipse",
    };
  }

  const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, 0.0),
  );
  const model = await C.Model.fromGltfAsync({
    url: cfg.modelUrl,
    modelMatrix,
    scale: 1.0,
  });
  scene.primitives.add(model);

  const firstTime = C.JulianDate.fromIso8601(cfg.ramp[0].iso);
  for (let i = 0; i < 600 && !model.ready; i++) {
    pin.renderAt(firstTime);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!model.ready) {
    return { structuralError: "the IBL model never became ready" };
  }

  const manager = model.environmentMapManager;
  if (!manager) {
    return { structuralError: "model.environmentMapManager is absent" };
  }
  // The COMMITTED refresh level, read from whichever backend owns it. Both
  // commit inside the branch that actually re-fills, so a transition here IS a
  // fill — that is what makes counting transitions a refresh count rather than
  // a re-derivation of the arithmetic.
  const committedBucket = () => {
    const webgpu = manager._webgpuCache;
    if (webgpu && "lastEclipseEnvBucket" in webgpu) {
      return webgpu.lastEclipseEnvBucket;
    }
    if ("_lastEclipseEnvBucket" in manager) {
      return manager._lastEclipseEnvBucket;
    }
    return undefined;
  };
  if (committedBucket() === undefined) {
    return {
      structuralError:
        "no committed eclipse refresh bucket on either manager — the C13-41 refresh input is not reachable",
    };
  }

  scene.camera.viewBoundingSphere(
    model.boundingSphere,
    new C.HeadingPitchRange(
      0.0,
      C.Math.toRadians(-20.0),
      model.boundingSphere.radius * 3.5,
    ),
  );
  scene.camera.lookAtTransform(C.Matrix4.IDENTITY);

  const modelBand = (frame) => {
    const { data, width, height } = frame;
    let sum = 0;
    let samples = 0;
    let lit = 0;
    for (let y = Math.floor(height * 0.25); y < height * 0.75; y += 2) {
      for (let x = Math.floor(width * 0.25); x < width * 0.75; x += 2) {
        const i = (y * width + x) * 4;
        const luma =
          (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) /
          255;
        sum += luma;
        if (luma > 0.02) {
          lit++;
        }
        samples++;
      }
    }
    return {
      mean: samples ? sum / samples : 0,
      litFraction: samples ? lit / samples : 0,
      samples,
    };
  };

  // Frame labels only. The shared pin checker's capture clause reads the CLOUD
  // uniform slots, and this lane deliberately runs no cloud deck (it isolates
  // the environment cube), so `_cloudCache` does not exist and every slot would
  // read `undefined`. Handing those captures to the checker would manufacture a
  // structural failure out of a configuration the lane does not use; the lane
  // therefore declares `captures: []` in the driver and the labels below exist
  // for the report.
  const frameLabels = [];
  const settleAndRead = async (julian, label, milliseconds) => {
    await pin.settle(julian, milliseconds);
    const frame = pin.capture(julian, false);
    frameLabels.push(label);
    return modelBand(frame);
  };

  // ── The sweep. Eclipse ON. Rising branch = the derived instants; descending
  // branch = the SAME instants replayed in reverse (see the file header).
  ac.lighting.enableEclipse = true;
  const schedule = [];
  for (const rung of cfg.ramp) {
    schedule.push(rung);
  }
  for (let k = cfg.ramp.length - 2; k >= 0; k--) {
    schedule.push(cfg.ramp[k]);
  }

  // Warm-up so the environment cube's first fill is not inside the timed sweep.
  await pin.settle(C.JulianDate.fromIso8601(schedule[0].iso), 1500);

  // Which legs have rendered the WHOLE schedule at least once. Read (not
  // asserted) by the cost accounting below, so removing or reordering a phase
  // flips the flag instead of silently leaving a stale `true` behind.
  const warmedLegs = { eclipse: false, control: false };

  const factors = [];
  const buckets = [];
  const obscurations = [];
  let bucketTransitions = 0;
  let previousCommitted = committedBucket();
  const initialCommitted = previousCommitted;
  const sweepStartMs = performance.now();
  for (let f = 0; f < schedule.length; f++) {
    const julian = C.JulianDate.fromIso8601(schedule[f].iso);
    pin.renderAt(julian);
    factors.push(scene.frameState?.eclipseSceneLightFactor ?? null);
    obscurations.push(scene.frameState?.eclipseState?.moonObscuration ?? null);
    const committed = committedBucket();
    buckets.push(committed);
    if (!Object.is(committed, previousCommitted)) {
      bucketTransitions++;
      previousCommitted = committed;
    }
    // Yield only every 32 frames: an await per frame turns an 801-frame sweep
    // into 801 task boundaries, and the sweep is a COST measurement.
    if ((f & 31) === 31) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const sweepWallMs = performance.now() - sweepStartMs;
  warmedLegs.eclipse = true;

  // The NaN-seeded first commit is a refresh too (`NaN !== anything`), and it
  // is the "one first-frame baseline" term of the 275. It happened during the
  // warm-up above, so add it back explicitly rather than pretending the sweep
  // saw it.
  const engineRefreshCount =
    bucketTransitions + (Number.isNaN(initialCommitted) ? 0 : 1);

  // ── The COUNT control: the identical 801-frame schedule with the eclipse
  // effect OFF, which produces exactly ONE eclipse-driven fill (the identity
  // bucket, committed once). This leg exists for `controlRefreshQuiescent`; it
  // is NOT where the cost comes from any more (see the next block).
  ac.lighting.enableEclipse = false;
  await pin.settle(C.JulianDate.fromIso8601(schedule[0].iso), 1500);
  let controlTransitions = 0;
  let controlPrevious = committedBucket();
  const controlStartMs = performance.now();
  for (let f = 0; f < schedule.length; f++) {
    pin.renderAt(C.JulianDate.fromIso8601(schedule[f].iso));
    const committed = committedBucket();
    if (!Object.is(committed, controlPrevious)) {
      controlTransitions++;
      controlPrevious = committed;
    }
    if ((f & 31) === 31) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const controlWallMs = performance.now() - controlStartMs;
  warmedLegs.control = true;

  // ── C13-41-ECLIPSE-REFRESH-COST-UNMEASURED: the INTERLEAVED cost legs.
  //
  // The first run derived the cost from the two counting legs above and got
  // -18.9 ms/refresh: the eclipse leg ran FIRST at 0.77 s and the control leg
  // ran SECOND at 5.97 s. A wall-clock A/B whose legs do not pay the same
  // warm-up is not a measurement — the fleet's mandatory interleaved-A/B
  // protocol for GPU timing (Batch 762) applies to wall clock just as hard.
  //
  // Both legs have now rendered the ENTIRE schedule once, so warm-up parity is
  // paid before anything below is timed, and it is REPORTED from `warmedLegs`
  // rather than asserted in a comment. The legs are then interleaved segment by
  // segment with the leg ORDER alternating (ABBA), so any monotone drift over
  // the run lands on both legs instead of on the effect.
  //
  // Each segment renders one untimed frame immediately after the toggle: that
  // frame absorbs the toggle's own bucket transition out of BOTH the clock and
  // the fill count, so the accounting stays self-consistent.
  const COST_SEGMENTS = 8;
  const segmentBounds = [];
  {
    const size = Math.ceil(schedule.length / COST_SEGMENTS);
    for (let start = 0; start < schedule.length; start += size) {
      segmentBounds.push([start, Math.min(start + size, schedule.length)]);
    }
  }
  const runCostSegment = (leg, from, to) => {
    ac.lighting.enableEclipse = leg === "eclipse";
    pin.renderAt(C.JulianDate.fromIso8601(schedule[from].iso)); // untimed
    let previous = committedBucket();
    let fills = 0;
    const startMs = performance.now();
    for (let f = from; f < to; f++) {
      pin.renderAt(C.JulianDate.fromIso8601(schedule[f].iso));
      const committed = committedBucket();
      if (!Object.is(committed, previous)) {
        fills++;
        previous = committed;
      }
    }
    return {
      leg,
      from,
      to,
      frames: to - from,
      wallMs: performance.now() - startMs,
      fills,
    };
  };
  const costSegments = [];
  for (let s = 0; s < segmentBounds.length; s++) {
    const [from, to] = segmentBounds[s];
    const order =
      (s & 1) === 0 ? ["eclipse", "control"] : ["control", "eclipse"];
    for (const leg of order) {
      costSegments.push(runCostSegment(leg, from, to));
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  const sumLeg = (leg, key) =>
    costSegments
      .filter((segment) => segment.leg === leg)
      .reduce((total, segment) => total + segment[key], 0);
  const refreshCost = {
    warmupBothLegs: warmedLegs.eclipse === true && warmedLegs.control === true,
    warmupNote:
      "the eclipse counting leg and the eclipse-off counting leg each rendered the whole schedule before any segment below was timed",
    interleave: "ABBA — the leg that runs first alternates per segment",
    segmentsPerLeg: segmentBounds.length,
    eclipseFrames: sumLeg("eclipse", "frames"),
    controlFrames: sumLeg("control", "frames"),
    eclipseWallMs: sumLeg("eclipse", "wallMs"),
    controlWallMs: sumLeg("control", "wallMs"),
    eclipseFills: sumLeg("eclipse", "fills"),
    controlFills: sumLeg("control", "fills"),
    // Per-segment, so a reader can see WHERE a differential comes from. If the
    // first run's 7.7x inversion was a step change at the eclipse toggle rather
    // than a warm-up ramp, it shows up here as a per-segment pattern instead of
    // hiding inside one aggregate number.
    segments: costSegments,
  };

  // ── Brightness legs: baseline (clear), deepest, and RECOVERY (back at clear
  // after the sweep has been through the deep phase). The recovery leg is the
  // anti-latch assertion the row explicitly still owed.
  ac.lighting.enableEclipse = true;
  const clearTime = C.JulianDate.fromIso8601(cfg.ramp[0].iso);
  const deepTime = C.JulianDate.fromIso8601(cfg.ramp[cfg.ramp.length - 1].iso);
  const baseline = await settleAndRead(clearTime, "C-baseline", 1200);
  const deepest = await settleAndRead(deepTime, "C-deepest", 1200);
  const recovered = await settleAndRead(clearTime, "C-recovered", 1200);

  const publishedAtDeepest = (() => {
    pin.renderAt(deepTime);
    return {
      moonObscuration: scene.frameState?.eclipseState?.moonObscuration ?? null,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
    };
  })();

  return {
    pins,
    globeReadiness: { sweep: globeReadiness },
    frameLabels,
    rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
    sweepFrames: schedule.length,
    factors,
    obscurations,
    buckets,
    initialCommittedWasNaN: Number.isNaN(initialCommitted),
    engineRefreshCount,
    controlRefreshCount: controlTransitions,
    // Reported-only from Batch 909 on: the GATE derives the per-refresh cost
    // from `refreshCost` below, never from these two counting legs. They are
    // kept because they are what the first run's -18.9 ms was computed from,
    // and a reader comparing runs needs to see them.
    sweepWallMs,
    controlWallMs,
    refreshCost,
    ibl: { baseline, deepest, recovered },
    publishedAtDeepest,
    modelReady: model.ready === true,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

async function openPage(browser, renderer) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 400));
    }
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(String(error).slice(0, 400)),
  );
  await installWeatherPinHarnessOnPage(page);
  await installCloudProbeHarnessOnPage(page);
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
    { waitUntil: "domcontentloaded", timeout: 90000 },
  );
  await page.waitForFunction(() => !!window.viewer?.scene, null, {
    timeout: 90000,
  });
  return { context, page, consoleErrors };
}

async function resolveFeatureRendererKeys(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const clouds = C.FeatureRendererKey?.PROCEDURAL_CLOUDS;
    const globe = C.FeatureRendererKey?.GLOBE_SURFACE;
    return {
      proceduralKey: typeof clouds === "number" ? clouds : null,
      globeSurfaceKey: typeof globe === "number" ? globe : null,
    };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const prov = provenance();
  if (!prov.ok) {
    console.error(
      "[probe-eclipse-cloud-response] PROVENANCE FAILURE — stale or missing build:",
      JSON.stringify(prov, null, 2),
    );
    // STRUCTURAL, not a harness fault: the probe ran, checked, and refused. A
    // pin on the BUILD is the same class as a pin on the scene.
    console.log(`EXIT: ${ECLIPSE_CLOUD_EXIT.STRUCTURAL}`);
    process.exit(ECLIPSE_CLOUD_EXIT.STRUCTURAL);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let derived;
  let cloudLanes;
  let iblWebGPU;
  let iblWebGL;
  const consoleFaults = { webgpu: [], webgl: [] };
  const shotsWritten = [];

  try {
    // ── Derive the schedule ONCE, on a WebGL context (pure ephemeris; no
    // rendering), and reuse it for both backends so the two runs are the same
    // fixture rather than two independently-located ones.
    {
      const opened = await openPage(browser, "webgl");
      derived = await opened.page.evaluate(DERIVE_SCHEDULE, {
        targets: ECLIPSE_CLOUD_BANDS.ladderTargets,
        rampFrames: SWEEP_RISING_FRAMES,
        rampPeak: SWEEP_PEAK_OBSCURATION,
      });
      await opened.context.close().catch(() => {});
    }
    if (!derived || derived.structuralError) {
      console.error(
        "[probe-eclipse-cloud-response] schedule derivation failed:",
        JSON.stringify(derived, null, 2),
      );
      await browser.close().catch(() => {});
      // The derivation lane returned a `structuralError`; that is the same
      // class as any other lane that could not run.
      console.log(`EXIT: ${ECLIPSE_CLOUD_EXIT.STRUCTURAL}`);
      process.exit(ECLIPSE_CLOUD_EXIT.STRUCTURAL);
    }
    console.log(
      `2026-08-12 vantage ${derived.region} (${r3(derived.lat)}, ${r3(derived.lon)}), ` +
        `peak obscuration ${r3(derived.peakObscuration)} at ${derived.peakIso}`,
    );
    for (const rung of derived.ladder) {
      console.log(
        `  ladder target ${rung.target} -> realized ${r6(rung.obscuration)} @ ${rung.iso}`,
      );
    }

    const laneConfig = {
      lat: derived.lat,
      lon: derived.lon,
      // Lane A: UNDER the 1500-4000 m deck, looking up, so the deck is measured
      // against the (now black) background.
      cameraHeight: 300.0,
      skyPitchDegrees: 12.0,
      // Lane B: BELOW the 1500 m deck floor, looking down at a ground patch far
      // enough away to span many shadow texels. The +/-60 km, 512-texel shadow
      // map is 234 m per texel, so the FIRST run's 300 m vantage put the whole
      // scored band inside ONE texel (geometric vacuity); the SECOND run's
      // 9000 m vantage fixed that but flew ABOVE the deck, so ~98% of the band
      // was cloud top and only ~1.8% was ground (photometric vacuity). 1400 m
      // at -8 deg puts the band at 3.1-6.8 km — ~16 texels — with the deck
      // entirely above the line of sight. See the arithmetic at the lane-B
      // block; `shadowGroundNotOccluded` and `shadowGroundIsBright` read both
      // preconditions back.
      groundCameraHeight: 1400.0,
      groundPitchDegrees: -8.0,
      groundCloudDensity: 0.85,
      settleMs: 500,
      ladder: derived.ladder,
      determinismDials: WEATHER_DETERMINISM_DIALS,
    };

    // ── WebGPU: lanes A + B, then lane C in a fresh context (the IBL lane
    // hides the globe and replaces the scene light, so it must not share a
    // context with the cloud lanes).
    {
      const opened = await openPage(browser, "webgpu");
      const keys = await resolveFeatureRendererKeys(opened.page);
      if (keys.proceduralKey === null || keys.globeSurfaceKey === null) {
        cloudLanes = {
          structuralError:
            "FeatureRendererKey.PROCEDURAL_CLOUDS / GLOBE_SURFACE is not exported",
        };
      } else {
        cloudLanes = await opened.page.evaluate(RUN_CLOUD_LANES, {
          ...laneConfig,
          proceduralKey: keys.proceduralKey,
          globeSurfaceKey: keys.globeSurfaceKey,
        });
      }
      consoleFaults.webgpu.push(...opened.consoleErrors.slice(0, 8));
      if (cloudLanes?.shots) {
        for (const shot of cloudLanes.shots) {
          if (!shot.png) {
            continue;
          }
          const file = path.join(
            OUT_DIR,
            `eclipse-cloud-response-${shot.name}.png`,
          );
          fs.writeFileSync(
            file,
            Buffer.from(shot.png.split(",")[1] ?? "", "base64"),
          );
          shotsWritten.push(file.replaceAll("\\", "/"));
        }
        delete cloudLanes.shots;
      }
      await opened.context.close().catch(() => {});
    }

    const iblConfig = {
      lat: derived.lat,
      lon: derived.lon,
      modelUrl: MODEL_URL,
      ramp: derived.ramp,
    };
    {
      const opened = await openPage(browser, "webgpu");
      iblWebGPU = await opened.page.evaluate(RUN_IBL_SWEEP, iblConfig);
      consoleFaults.webgpu.push(...opened.consoleErrors.slice(0, 8));
      await opened.context.close().catch(() => {});
    }
    {
      const opened = await openPage(browser, "webgl");
      iblWebGL = await opened.page.evaluate(RUN_IBL_SWEEP, iblConfig);
      consoleFaults.webgl.push(...opened.consoleErrors.slice(0, 8));
      await opened.context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Pin enforcement (exit 3). A probe that is not measuring the
  // configuration it documents certifies nothing, so this is STRUCTURAL and
  // never a product verdict.
  const pinReasons = [];
  for (const [name, lane] of [
    ["webgpu-cloud", cloudLanes],
    ["webgpu-ibl", iblWebGPU],
    ["webgl-ibl", iblWebGL],
  ]) {
    if (!lane || lane.structuralError) {
      pinReasons.push(
        `${name}: ${lane?.structuralError ?? "lane did not run"}`,
      );
      continue;
    }
    // The cloud lanes hand in their dials AND every scored capture's uniform
    // slots. The IBL lanes hand in neither: they run no cloud deck by design,
    // so `_cloudCache` does not exist and the cloud-slot clause would
    // manufacture a structural failure out of a configuration they do not use.
    // Their scene pins and globe readiness are still fully enforced.
    const isCloudLane = name === "webgpu-cloud";
    pinReasons.push(
      ...collectPinStructural({
        pins: lane.pins,
        dials: isCloudLane ? lane.dials : undefined,
        captures: isCloudLane ? (lane.captures ?? []) : [],
        globeReadiness: lane.globeReadiness ?? {},
        requireWeatherMap: false,
        subjectDials: ["cloudCastShadows", "cloudContributesIBL"],
      }).map((reason) => `${name}: ${reason}`),
    );
  }

  // A pin failure is a claim about the CONFIGURATION, not about any one lane,
  // so it is not scoped — it blinds the whole run. The judge still runs, so the
  // report carries every measured number, but its verdicts do not gate.
  const verdicts = judgeEclipseCloudResponse({
    cloudLanes,
    iblWebGPU,
    iblWebGL,
  });

  const structuralReasons = [...pinReasons, ...verdicts.structuralReasons];
  const failed = pinReasons.length > 0 ? [] : verdicts.failedPredicates;
  const parityFailed = pinReasons.length > 0 ? [] : verdicts.parityFailed;
  const outcome = {
    harnessFault: false,
    structuralReasons,
    failedPredicates: failed,
    parityFailed,
  };
  const exitCode = eclipseCloudExitCode(outcome);
  const GATE = eclipseCloudGateLabel(outcome);

  const report = {
    probe: "probe-eclipse-cloud-response",
    task: "C13-41 (C12-29 S3 rider) — cloud lighting / cloud shadow / IBL",
    provenance: {
      buildIsNewer: prov.buildIsNewer,
      entryFresh: prov.entryFresh,
      consideredFileCount: prov.consideredFileCount,
    },
    // The tier escape hatch every scored capture is required to have been taken
    // under. Echoed into the report because the pin checker's failure message
    // names it and a reader should not have to open the shared module to learn
    // what value was expected.
    pinnedCloudQuality: PINNED_CLOUD_QUALITY,
    bands: ECLIPSE_CLOUD_BANDS,
    predicateLanes: ECLIPSE_CLOUD_PREDICATE_LANES,
    exitContract: ECLIPSE_CLOUD_EXIT,
    predictions: {
      factorAt09: predictFactor(SWEEP_PEAK_OBSCURATION),
      directionalAt09: predictDirectional(SWEEP_PEAK_OBSCURATION),
      bucketAt09: predictBucket(predictFactor(SWEEP_PEAK_OBSCURATION)),
      sweepFrames: SWEEP_FRAMES,
      sweepRefreshCount: predictedSweepRefreshCount(),
    },
    derived: derived
      ? {
          region: derived.region,
          lat: derived.lat,
          lon: derived.lon,
          peakObscuration: derived.peakObscuration,
          peakIso: derived.peakIso,
          ladder: derived.ladder,
          rampFrames: derived.ramp?.length ?? 0,
        }
      : null,
    shotsWritten,
    consoleFaults,
    pinReasons,
    webgpuCloudLanes: cloudLanes,
    webgpuIbl: iblWebGPU,
    webglIbl: iblWebGL,
    verdicts,
    structuralReasons,
    unscoredPredicates: verdicts.unscoredPredicates ?? [],
    GATE,
    exitCode,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "eclipse-cloud-response-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      { predictions: report.predictions, pinReasons, verdicts, GATE, exitCode },
      null,
      2,
    ),
  );

  // ── The lines a reader should need. STRUCTURAL and FAIL are no longer
  // exclusive: with per-lane scoping a run can quarantine one lane and still
  // return a real verdict on the others, and BOTH halves have to be visible or
  // the scoping has just moved the first run's blind spot somewhere else.
  for (const reason of structuralReasons) {
    console.log(`STRUCTURAL: ${reason}`);
  }
  if (verdicts.unscoredPredicates?.length) {
    console.log(
      `UNSCORED (quarantined with their blind lane): ${verdicts.unscoredPredicates.join(", ")}`,
    );
  }
  const scoredCount =
    ECLIPSE_CLOUD_GATE_PREDICATES.length -
    (verdicts.unscoredPredicates?.length ?? 0);
  console.log(
    failed.length === 0
      ? `GATE: ${GATE} — ${scoredCount} of ${ECLIPSE_CLOUD_GATE_PREDICATES.length} gating predicates scored, all true`
      : `GATE: ${GATE} — failing predicate(s): ${failed.join(", ")}`,
  );
  console.log(
    verdicts.unscoredParityPredicates?.length
      ? `GATE parity: UNSCORED — ${verdicts.unscoredParityPredicates.join(", ")}`
      : `GATE parity: ${parityFailed.length === 0 ? "PASS" : `FAIL — ${parityFailed.join(", ")}`} ` +
          `(${ECLIPSE_CLOUD_PARITY_PREDICATES.length} cross-backend predicates)`,
  );
  console.log(
    `NOT GATING (reported-only): ${ECLIPSE_CLOUD_REPORTED_ONLY_PREDICATES.join(", ")}`,
  );
  // The SHADOW plumbing, on one line. The second run's report carried
  // `shadowActive` but nothing printed it, so a blind lane looked like a missing
  // instrument rather than a scene that could not see its own subject.
  {
    const t = verdicts.shadowTelemetry ?? {};
    const control = t.consumer?.cloudShadowControl;
    console.log(
      `SHADOW telemetry: producerActive off/on ${t.producerActiveOff}/${t.producerActiveOn}; ` +
        `map ${t.producer?.shadowSize ?? "?"} px, frameValid ${t.producer?.shadowFrameValid ?? "?"}, ` +
        `absorption ${t.producer?.shadowAbsorption ?? "?"}; ` +
        `terrain cloudShadowControl ${control ? `[${control.map((n) => r3(n)).join(", ")}]` : "UNREADABLE"} ` +
        `(x>0.5 opens the FS branch), eyeRelative ${t.consumer?.cloudShadowRelativeToEye ?? "?"}; ` +
        `band inside footprint ${t.footprint?.allInside ?? "?"}, texelSpan ${r3(t.footprint?.texelSpan)}; ` +
        `groundOnly ${r3(t.groundOnly)}, retention ${r3(t.groundRetention)} ` +
        `@ ${t.cameraHeight} m / ${t.pitchDegrees} deg`,
    );
    // CO-19 INSTRUMENT TELL, printed UNROUNDED and in full. The fourth run's
    // four `offNoCloud` reads were bit-identical (0.2750603921572111) across
    // instants 54 minutes apart while `offNoShadow` moved +3.3%; four identical
    // f64s here is the tell that the deck-free control is not being re-captured
    // per rung. Reported only — if it reads false again it becomes its own
    // instrument investigation, not a product verdict.
    console.log(
      `SHADOW deck-free series: offNoCloud [${(t.offNoCloudSeries ?? []).join(", ")}] ` +
        `spread ${t.offNoCloudSpread}, offNoShadow spread ${t.offNoShadowSpread}; ` +
        `offNoCloudVariesWithSun ${t.offNoCloudVariesWithSun} ` +
        `(false = four identical f64s, the tell); ` +
        `deck-free dim at deepest ${r3(t.deckFreeExcessAtDeepest)}x F ` +
        `(1.0 exonerates the globe light path and makes the CO-17 residue CLOUD-DRIVEN; ` +
        `>1 indicts the globe path)`,
    );
    // CO-21 ATTRIBUTION EVIDENCE, printed UNROUNDED. The fifth run's 0.449 at
    // obscuration ZERO has exactly two causes and this line separates them:
    // `deckFreeSettled true` means the reads had CONVERGED, so 0.449 is the
    // measurement and the identity violation is the ENGINE's; `false` means the
    // first-position capture was still moving and the number was an artefact of
    // being the only scored capture taken one settle after a real eclipse-state
    // transition. `retention on/off` is the corroborating pair: 0.9894 off
    // against 2.2035 on says the deck-present and deck-free bands cannot both
    // be reading the same surface.
    console.log(
      `SHADOW deck-free convergence: settled ${t.deckFreeSettled} ` +
        `(bracket ${ECLIPSE_CLOUD_BANDS.deckFreeGroundSettleDelta.hi}); ` +
        `per-rung [${(t.deckFreeSettleDelta ?? [])
          .map(
            (e) =>
              `obs ${e.obscuration}: off ${e.offFirst}->${e.offSettled} (d ${e.offDelta}), ` +
              `on ${e.onFirst}->${e.onSettled} (d ${e.onDelta})`,
          )
          .join(" | ")}]; ` +
        `retention off ${t.groundRetention} vs on ${t.groundRetentionOn} ` +
        `(settled+failing = ENGINE identity violation; unsettled = INSTRUMENT)`,
    );
  }
  // The CO-19 deck leg, on its own line: the pure deck ratio and the `e` it
  // implies, with no cross-run input anywhere in the chain.
  {
    const fit = verdicts.deckTonemapFit ?? {};
    console.log(
      `DECK aerial-zero leg: pure ratio ${verdicts.deckPureRatio} ` +
        `(pre-registered 0.635 +/- 0.01, band [${ECLIPSE_CLOUD_BANDS.deckPureDeckRatio.lo}, ${ECLIPSE_CLOUD_BANDS.deckPureDeckRatio.hi}]) ` +
        `-> e ${verdicts.deckTonemapEntryFromPureLeg}; ` +
        `single-run aerial share ${verdicts.deckAerialShareSingleRun} ` +
        `(cross-run constant ${DECK_AERIAL_SHARE_CROSS_RUN}); ` +
        `fit source: ${fit.aerialShareSource}`,
    );
  }
  // INVALID is printed as INVALID with its reason. The first run printed
  // "-18.9 ms/refresh", which reads like a measurement and is not one.
  console.log(
    `COST (C13-41-ECLIPSE-REFRESH-COST-UNMEASURED): ` +
      `webgpu ${verdicts.cost.webgpu.valid ? `${r3(verdicts.cost.webgpuMsPerRefresh)} ms/refresh` : `INVALID — ${verdicts.cost.webgpu.invalidReason}`}; ` +
      `webgl ${verdicts.cost.webgl.valid ? `${r3(verdicts.cost.webglMsPerRefresh)} ms/refresh` : `INVALID — ${verdicts.cost.webgl.invalidReason}`}`,
  );

  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  // An escaped exception is a HARNESS FAULT (exit 2), not a STRUCTURAL refusal
  // (exit 3): no verdict of any kind was formed, and the two must be
  // distinguishable from the exit code alone.
  console.error("[probe-eclipse-cloud-response] HARNESS FAULT:", e);
  console.log(`EXIT: ${ECLIPSE_CLOUD_EXIT.HARNESS}`);
  process.exit(ECLIPSE_CLOUD_EXIT.HARNESS);
});
