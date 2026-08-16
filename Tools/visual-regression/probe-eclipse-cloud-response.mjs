#!/usr/bin/env node
// probe-eclipse-cloud-response.mjs — C13-41 (the C12-29 S3 rider) Edge
// acceptance: eclipse-driven cloud lighting, cloud shadow, and IBL
// dimming/refresh.
// @purpose C13-41 Edge acceptance: eclipse-driven cloud radiance ratio, shadow contrast, and IBL refresh count — three pre-registered predictions.
// @status ACTIVE
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
// Plus the row's original STILL OWED list: an IBL recovery leg that steps a
// clock through the deep phase and out the other side, and the wall-clock cost
// of the 275 fills. The second Edge run discharged the one-time cost obligation
// (7.749 ms/refresh WebGPU, 1.607 WebGL). Lane C retains the full estimate as a
// reported diagnostic; an INVALID rerun never prints a negative cost and does
// not revoke the banked measurement.
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
// primary watchdog that closes Edge and drains `finally` into an ERROR artifact,
// plus a later outer fuse that leaves RUNNING fail-closed if cleanup itself
// hangs; every context and the browser close in `finally`; every loop bounded.
//
// EXIT CONTRACT (fleet): 0 PASS / 1 gate FAIL / 2 HARNESS FAULT (the primary
// watchdog fired, or an exception escaped — an ERROR artifact, not a product
// verdict, is formed) / 3
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

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  collectPinStructural,
  installWeatherPinHarnessOnPage,
  PINNED_CLOUD_QUALITY,
  WEATHER_DETERMINISM_DIALS,
} from "./lib/weather-probe-pinning.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";
import {
  assertEvidenceReadableOrAbsent,
  atomicReplaceEvidence,
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  preserveFirstRedEvidence,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";
import {
  DECK_FREE_CONTROL_SESSION_PLAN,
  DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
  DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS,
  DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY,
  DECK_FREE_LIGHTING_FADE_IN_DISTANCE,
  DECK_FREE_LIGHTING_FADE_OUT_DISTANCE,
  DECK_FREE_SUN_LIGHT_INTENSITY,
  foldDeckFreeControlSessions,
} from "./lib/c13-41-deckfree-control.mjs";
import {
  BAND_MEAN_CAPTURE_DELTA,
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
const CANONICAL_ARTIFACT = path.join(
  OUT_DIR,
  "eclipse-cloud-response-report.json",
);
const FIRST_RED_ARTIFACT = path.join(
  OUT_DIR,
  "eclipse-cloud-response-report.first-red.json",
);
const PRE_LIFECYCLE_RUN_6_ARTIFACT = path.join(
  OUT_DIR,
  "eclipse-cloud-response-report.pre-lifecycle-run-6.json",
);
const RUN_LOCK_ARTIFACT = path.join(
  OUT_DIR,
  "eclipse-cloud-response-report.lock",
);
const ARTIFACT_SCHEMA = "c13-41-eclipse-cloud-response-v3";
const MODEL_URL =
  "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

// Twelve minutes covers the original cloud page, two 801-frame IBL sweeps, and
// the four new fresh-context ABBA control warmups. The primary watchdog closes
// Edge and lets the probe's finally drain before publishing ERROR. A one-minute
// outer fuse exists only for a hung browser close; it deliberately leaves the
// atomic RUNNING marker in place rather than publishing raced evidence.
const HARD_LIMIT_MS = 720000;
const OUTER_WATCHDOG_GRACE_MS = 60000;
const OUTER_HARD_LIMIT_MS = HARD_LIMIT_MS + OUTER_WATCHDOG_GRACE_MS;

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
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
];
// The build consumes generated shader modules, while reviewers edit and audit
// the GLSL/WGSL sources above. Bind both halves: exact sourcesContent identity
// for the runtime inputs plus verbatim markers for each authoritative shader.
const BUILD_SOURCE_IDENTITY_FILES = [
  ...SOURCE_FILES.filter(
    (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
  ),
  "packages/engine/Source/Shaders/GlobeFS.js",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.js",
];

const BUILD_ENTRY_PATH = path.join("Build/CesiumUnminified", "index.js");
const BUILD_SOURCE_MAP_PATH = `${BUILD_ENTRY_PATH}.map`;
const PROBE_FILE = fileURLToPath(import.meta.url);
const LOCAL_EVIDENCE_FILES = Object.freeze({
  ...Object.fromEntries(
    SOURCE_FILES.map((file, index) => [
      `engineSource${index}`,
      path.resolve(file),
    ]),
  ),
  ...Object.fromEntries(
    BUILD_SOURCE_IDENTITY_FILES.filter(
      (file) => !SOURCE_FILES.includes(file),
    ).map((file, index) => [
      `generatedShaderSource${index}`,
      path.resolve(file),
    ]),
  ),
  buildEntry: path.resolve(BUILD_ENTRY_PATH),
  buildSourceMap: path.resolve(BUILD_SOURCE_MAP_PATH),
  probe: PROBE_FILE,
  weatherPinPolicy: fileURLToPath(
    new URL("./lib/weather-probe-pinning.mjs", import.meta.url),
  ),
  cloudProbeHarness: fileURLToPath(
    new URL("./lib/cloud-probe-harness.mjs", import.meta.url),
  ),
  gatePolicy: fileURLToPath(
    new URL("./lib/eclipse-cloud-response-gate.mjs", import.meta.url),
  ),
  deckFreePolicy: fileURLToPath(
    new URL("./lib/c13-41-deckfree-control.mjs", import.meta.url),
  ),
  sourceIdentityPolicy: fileURLToPath(
    new URL("./lib/build-source-identity.mjs", import.meta.url),
  ),
  acceptancePolicy: fileURLToPath(
    new URL("./eclipse-cloud-response-gate.spec.mjs", import.meta.url),
  ),
});
const EXPECTED_RUNTIME_SESSION_LABELS = Object.freeze([
  "derive-webgl",
  "cloud-webgpu",
  "deck-free-off-a",
  "deck-free-on-a",
  "deck-free-on-b",
  "deck-free-off-b",
  "ibl-webgpu",
  "ibl-webgl",
]);

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
    marker: "cache.lastEclipseEnvBucket = state.eclipseEnvBucket",
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
  {
    file: "packages/engine/Source/Scene/Globe.js",
    marker: "tileProvider.terminatorGlowStrength =",
  },
  {
    file: "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
    marker: "this.terminatorGlowStrength =",
  },
  {
    file: "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
    marker:
      "uniformMapProperties.terminatorGlowStrength = terminatorGlowStrength",
  },
  {
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
    marker: "tileProvider.terminatorGlowStrength ??",
  },
  {
    file: "packages/engine/Source/Shaders/GlobeFS.glsl",
    marker:
      "float terminatorGlowStrength = max(u_terminatorGlowStrength, 0.0);",
  },
  {
    file: "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    marker: "let terminatorGlowStrength = max(tile.tileControls.z, 0.0);",
  },
  {
    // Lane B reads the image after this cloud over-composite. Binding the exact
    // producer/consumer seam prevents a future build from silently moving the
    // additive cloud term back into the terrain-shadow domain.
    file: "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    marker: "let finalColor = mix(sceneColor.rgb, hazed, cloudAlpha);",
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
  const capturedAt = new Date().toISOString();
  const localIdentity = snapshotEvidenceFiles(LOCAL_EVIDENCE_FILES);
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
    return {
      ok: false,
      reason: "Build/CesiumUnminified missing",
      capturedAt,
      localIdentity,
      sources,
    };
  }
  if (bundleFiles.length === 0) {
    return {
      ok: false,
      reason: "no built JS found",
      capturedAt,
      localIdentity,
      sources,
    };
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
  const entryFresh =
    fs.existsSync(BUILD_ENTRY_PATH) &&
    considered.some((f) => path.resolve(f) === path.resolve(BUILD_ENTRY_PATH));

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
  let sourceIdentity;
  try {
    sourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: BUILD_SOURCE_MAP_PATH,
      sourceFiles: BUILD_SOURCE_IDENTITY_FILES,
    });
  } catch (error) {
    sourceIdentity = {
      ok: false,
      sourceMapPath: BUILD_SOURCE_MAP_PATH,
      reasons: [String(error)],
      entries: [],
    };
  }
  const entryBytes = fs.existsSync(BUILD_ENTRY_PATH)
    ? fs.readFileSync(BUILD_ENTRY_PATH)
    : null;

  return {
    capturedAt,
    localIdentity,
    sources,
    bundleFileCount: bundleFiles.length,
    consideredFileCount: considered.length,
    entryFresh,
    buildIsNewer,
    missingTokens,
    missingSlices,
    sourceIdentity,
    entrySha256: entryBytes ? sha256(entryBytes) : null,
    entryByteLength: entryBytes?.byteLength ?? null,
    ok:
      buildIsNewer &&
      entryFresh &&
      sourceIdentity.ok &&
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

    // ── LANE B: ground cloud-shadow DECREMENT. Look down; toggle
    // `cloudCastShadows` at one instant in each eclipse position. The raw
    // `shadowOn / shadowOff` contrast is retained for visual history, but the
    // terrain claim uses `noShadow - shadow`: that within-state difference
    // cancels ProceduralClouds' later additive over-composite. Its eclipse/clear
    // ratio must equal independent deck-free ABBA ground dim times the actual
    // producer-strength ratio.
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
    // The deck-free attribution control no longer runs on this page. Six Edge
    // runs proved that toggling this persistent collection between deck-present
    // and deck-free configurations produces state-order-dependent readings. The
    // Node driver attaches the fresh-context ABBA control after this lane
    // returns. This page now changes only the cast-shadow SUBJECT dial.
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

    setEclipse(true);
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
    const deckFreeEclipseState = scene.frameState?.eclipseState;
    const deckFreePublished = {
      moonObscuration: deckFreeEclipseState?.moonObscuration ?? null,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      enabled: deckFreeEclipseState?.enabled ?? null,
      valid: deckFreeEclipseState?.valid ?? null,
      cameraHeight: cfg.groundCameraHeight,
    };
    const shadowStrengthOn = scene.context?._cloudCache?.shadowStrength ?? null;
    const shadowActiveOn = scene.context?._cloudCache?.shadowActive ?? null;
    const cloudCacheOn = cloudCacheTelemetry();
    const globeUniformOn = globeUniformTelemetry();

    // Restore the lane-A dials so the next rung starts from one configuration.
    configure({ enableVolumetric: true });

    if (deepest && onCloudsPng && offCloudsPng) {
      shots.push({ name: "deepest-eclipseOn-cloudsOn", png: onCloudsPng });
      shots.push({ name: "deepest-eclipseOff-cloudsOn", png: offCloudsPng });
    }

    results.rungs.push({
      target: rung.target,
      iso: rung.iso,
      scheduledObscuration: rung.obscuration,
      published,
      deckFreePublished,
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
// IN-PAGE: state-isolated lane-B deck-free control (one fresh context per leg)
// ─────────────────────────────────────────────────────────────────────────────
const RUN_DECK_FREE_CONTROL_SESSION = async (cfg) => {
  const C = (window.Cesium =
    window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const pin = globalThis.__weatherPin;
  const cloudProbe = globalThis.__cloudProbe;
  const viewer = window.viewer;
  const scene = viewer.scene;
  const pins = pin.pinScene(C, {
    groundAtmosphere: false,
    fog: false,
    sky: false,
  });

  scene.globe.enableLighting = true;
  scene.globe.baseColor = C.Color.fromBytes(200, 200, 200);
  // The current engine exposes this appearance term as an opt-in strength. The
  // diagnostic pins it to one so its complete shader expression is explicit,
  // then restores the exact prior value before every scored Sun capture. Older
  // f38 evidence had the same expression unconditionally (effective strength
  // one); a build without this public control must be rebuilt before rerunning.
  const terminatorGlowSupported =
    "terminatorGlowStrength" in scene.globe &&
    Number.isFinite(scene.globe.terminatorGlowStrength);
  const priorTerminatorGlowStrength = terminatorGlowSupported
    ? scene.globe.terminatorGlowStrength
    : null;
  const readTerminatorGlowStrength = () => ({
    publicStrength: scene.globe.terminatorGlowStrength ?? null,
    tileProviderStrength:
      scene.globe._surface?.tileProvider?.terminatorGlowStrength ?? null,
  });
  // This control flies below Globe's normal ~9.98 Mm day/night fade-out, where
  // both backends intentionally flatten diffuse lighting to 1. Probe-only
  // distances 0/1 force the shipped day/night branch live at the unchanged
  // lane-B camera. They are read back and independently re-evaluated by the
  // Node fold; no engine default or product scene is changed.
  scene.globe.lightingFadeOutDistance = cfg.lightingFadeOutDistance;
  scene.globe.lightingFadeInDistance = cfg.lightingFadeInDistance;
  const ac = scene.globe?.atmosphericConditions;
  if (!ac?.lighting || !("enableEclipse" in ac.lighting)) {
    return {
      sessionLabel: cfg.sessionLabel,
      structuralError: "no atmosphericConditions.lighting.enableEclipse",
    };
  }
  if ("enableEclipseGlobeShadow" in ac.lighting) {
    ac.lighting.enableEclipseGlobeShadow = false;
  }
  ac.lighting.enableEclipse = cfg.eclipseEnabled;

  const readBaseColor = () => {
    const color = scene.globe.baseColor;
    return color ? [color.red, color.green, color.blue, color.alpha] : null;
  };
  const readLighting = () => {
    const view = scene.camera?.viewMatrix;
    const tx = view?.[12];
    const ty = view?.[13];
    const tz = view?.[14];
    const cameraDistance =
      Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)
        ? Math.sqrt(tx * tx + ty * ty + tz * tz)
        : null;
    const outDistance = scene.globe.lightingFadeOutDistance;
    const inDistance = scene.globe.lightingFadeInDistance;
    const span = inDistance - outDistance;
    const expectedFade =
      Number.isFinite(cameraDistance) && Number.isFinite(span) && span > 0
        ? Math.min(1, Math.max(0, (cameraDistance - outDistance) / span))
        : null;
    return {
      enableLighting: scene.globe.enableLighting === true,
      enableEclipse: ac.lighting.enableEclipse === true,
      enableEclipseGlobeShadow:
        "enableEclipseGlobeShadow" in ac.lighting
          ? ac.lighting.enableEclipseGlobeShadow === true
          : null,
      eclipseStateEnabled: scene.frameState?.eclipseState?.enabled === true,
      eclipseStateValid: scene.frameState?.eclipseState?.valid === true,
      moonObscuration: scene.frameState?.eclipseState?.moonObscuration ?? null,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      lightingFade: {
        outDistance,
        inDistance,
        cameraDistance,
        expectedFade,
      },
    };
  };
  const readLight = (diagnosticOnly) => {
    const readSide = (light) => ({
      constructorName: light?.constructor?.name ?? null,
      isSunLight: light instanceof C.SunLight,
      isDirectionalLight: light instanceof C.DirectionalLight,
      directionWC: light?.direction
        ? [light.direction.x, light.direction.y, light.direction.z]
        : null,
      color: light?.color
        ? [
            light.color.red,
            light.color.green,
            light.color.blue,
            light.color.alpha,
          ]
        : null,
      intensity: light?.intensity ?? null,
    });
    return {
      diagnosticOnly,
      sameObject: scene.light === scene.frameState?.light,
      scene: readSide(scene.light),
      frameState: readSide(scene.frameState?.light),
    };
  };

  // This is the configure epoch: exactly one configuration on a fresh page,
  // before readiness or any scored capture. The session never toggles the deck,
  // shadow, or eclipse state after this call.
  let configureCalls = 0;
  const configureTruth = (() => {
    configureCalls++;
    return cloudProbe.configure({
      requireWebGPU: true,
      enableVolumetric: false,
      volumetric: {
        cloudCoverage: 0.6,
        cloudDensity: cfg.groundCloudDensity,
        cloudLayerBottom: 1500,
        cloudLayerTop: 4000,
        cloudAerialStrength: 1.0,
        ...cfg.determinismDials,
      },
    });
  })();
  const dials = pin.readDials();
  const collection = scene.globe.defaultCloudCollection;

  const bandMean = (frame) => {
    const { data, width, height } = frame;
    const top = Math.floor(height * 0.6);
    const bottom = Math.floor(height * 0.95);
    let sum = 0;
    let samples = 0;
    for (let y = top; y < bottom; y += 2) {
      for (let x = Math.floor(width * 0.15); x < width * 0.85; x += 2) {
        const i = (y * width + x) * 4;
        sum +=
          (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) /
          255;
        samples++;
      }
    }
    return { mean: samples > 0 ? sum / samples : null, samples };
  };

  // Nadir plus a small central reducer keeps the diagnostic footprint under
  // 2 km at 1400 m. That bounds analytic-normal drift tightly enough for the
  // Node fold to distinguish the shipped 0.3/0.5/0.7/0.9 DAYNIGHT law from a
  // saturated or fabricated response without changing a product band.
  const diagnosticBandMean = (frame) => {
    const { data, width, height } = frame;
    let sum = 0;
    let samples = 0;
    for (let y = Math.floor(height * 0.35); y < height * 0.65; y += 2) {
      for (let x = Math.floor(width * 0.35); x < width * 0.65; x += 2) {
        const i = (y * width + x) * 4;
        sum +=
          (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) /
          255;
        samples++;
      }
    }
    return { mean: samples > 0 ? sum / samples : null, samples };
  };

  const aimCamera = (julian) => {
    const carto = C.Cartographic.fromDegrees(
      cfg.lon,
      cfg.lat,
      cfg.groundCameraHeight,
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
    scene.camera.setView({
      destination: positionWC,
      orientation: {
        heading: Math.atan2(sunLocal.x, sunLocal.y) + Math.PI,
        pitch: C.Math.toRadians(cfg.groundPitchDegrees),
        roll: 0.0,
      },
    });
  };

  const diagnosticPositionWC = C.Cartesian3.fromDegrees(cfg.lon, cfg.lat, 0);
  const diagnosticSurfaceNormalWC = scene.globe.ellipsoid.geodeticSurfaceNormal(
    diagnosticPositionWC,
    new C.Cartesian3(),
  );
  const diagnosticEastWC = C.Cartesian3.normalize(
    C.Cartesian3.cross(
      C.Cartesian3.UNIT_Z,
      diagnosticSurfaceNormalWC,
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  const aimDiagnosticCamera = () => {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        cfg.lon,
        cfg.lat,
        cfg.groundCameraHeight,
      ),
      orientation: {
        heading: 0,
        pitch: -C.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
  };
  const diagnosticDirection = (ndotlTarget) => {
    const tangentShare = Math.sqrt(1 - ndotlTarget * ndotlTarget);
    const incomingDirectionWC = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(
        diagnosticSurfaceNormalWC,
        ndotlTarget,
        new C.Cartesian3(),
      ),
      C.Cartesian3.multiplyByScalar(
        diagnosticEastWC,
        tangentShare,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(incomingDirectionWC, incomingDirectionWC);
    const emittedDirectionWC = C.Cartesian3.negate(
      incomingDirectionWC,
      new C.Cartesian3(),
    );
    const ndotl = C.Cartesian3.dot(
      diagnosticSurfaceNormalWC,
      incomingDirectionWC,
    );
    return {
      surfaceNormalWC: [
        diagnosticSurfaceNormalWC.x,
        diagnosticSurfaceNormalWC.y,
        diagnosticSurfaceNormalWC.z,
      ],
      eastWC: [diagnosticEastWC.x, diagnosticEastWC.y, diagnosticEastWC.z],
      incomingDirectionWC: [
        incomingDirectionWC.x,
        incomingDirectionWC.y,
        incomingDirectionWC.z,
      ],
      emittedDirectionWC: [
        emittedDirectionWC.x,
        emittedDirectionWC.y,
        emittedDirectionWC.z,
      ],
      ndotl,
      expectedDiffuse: Math.min(1, Math.max(0, Math.max(ndotl, 0) * 5 + 0.3)),
    };
  };

  const firstTime = C.JulianDate.fromIso8601(cfg.ladder[0].iso);
  aimCamera(firstTime);
  const readiness = await pin.awaitGlobeReady(C, firstTime, 400, 60000);
  const rungs = [];
  const directionalDiagnosticRungs = [];
  for (let rungIndex = 0; rungIndex < cfg.ladder.length; rungIndex++) {
    const rung = cfg.ladder[rungIndex];
    const julian = C.JulianDate.fromIso8601(rung.iso);

    // DIAGNOSTIC ONLY. DirectionalLight is intentionally outside S2's
    // SunLight-only uniform dimming and, with eclipse-globe shadow disabled,
    // must remain eclipse-invariant. It proves the unsaturated DAYNIGHT
    // diffuse path and its explicitly enabled terminator-glow addend are live.
    const ndotlTarget = cfg.directionalNdotLTargets[rungIndex];
    const directionSpec = diagnosticDirection(ndotlTarget);
    aimDiagnosticCamera();
    if (terminatorGlowSupported) {
      scene.globe.terminatorGlowStrength = cfg.diagnosticTerminatorGlowStrength;
    }
    scene.light = new C.DirectionalLight({
      direction: new C.Cartesian3(...directionSpec.emittedDirectionWC),
      color: C.Color.WHITE,
      intensity: cfg.directionalLightIntensity,
    });
    await pin.settle(julian, cfg.settleMs);
    const diagnosticReduced = diagnosticBandMean(pin.capture(julian, false));
    const diagnosticBaseColor = readBaseColor();
    const diagnosticLighting = readLighting();
    directionalDiagnosticRungs.push({
      target: rung.target,
      iso: rung.iso,
      captureRole: "diagnostic-directional-daynight",
      diagnosticOnly: true,
      ndotlTarget,
      directionSpec,
      mean: diagnosticReduced.mean,
      samples: diagnosticReduced.samples,
      eclipseEnabled: scene.frameState?.eclipseState?.enabled === true,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      baseColor: diagnosticBaseColor,
      enableLighting: scene.globe.enableLighting === true,
      lighting: diagnosticLighting,
      light: readLight(true),
      cameraHeight: cfg.groundCameraHeight,
      enableVolumetric: collection.enableVolumetric,
      configureCalls,
      terminatorGlowStrength: scene.globe.terminatorGlowStrength ?? null,
      terminatorGlowTileProviderStrength:
        readTerminatorGlowStrength().tileProviderStrength,
    });

    // SCORED FACTOR CAPTURE. Always replace the custom light with a fresh
    // SunLight, restore the real-Sun camera, and settle/render before reading a
    // pixel. S2 dims this type only; the diagnostic can never certify it.
    scene.light = new C.SunLight({
      color: C.Color.WHITE,
      intensity: cfg.sunLightIntensity,
    });
    if (terminatorGlowSupported) {
      scene.globe.terminatorGlowStrength = priorTerminatorGlowStrength;
    }
    aimCamera(julian);
    await pin.settle(julian, cfg.settleMs);
    const reduced = bandMean(pin.capture(julian, false));
    const baseColor = readBaseColor();
    const lighting = readLighting();
    rungs.push({
      target: rung.target,
      iso: rung.iso,
      captureRole: "scored-real-sun-factor",
      mean: reduced.mean,
      samples: reduced.samples,
      eclipseEnabled: scene.frameState?.eclipseState?.enabled === true,
      factor: scene.frameState?.eclipseSceneLightFactor ?? null,
      baseColor,
      baseColorLuma: baseColor
        ? 0.2126 * baseColor[0] + 0.7152 * baseColor[1] + 0.0722 * baseColor[2]
        : null,
      enableLighting: scene.globe.enableLighting === true,
      lighting,
      light: readLight(false),
      cameraHeight: cfg.groundCameraHeight,
      enableVolumetric: collection.enableVolumetric,
      configureCalls,
      terminatorGlowStrength: scene.globe.terminatorGlowStrength ?? null,
      terminatorGlowTileProviderStrength:
        readTerminatorGlowStrength().tileProviderStrength,
    });
  }

  return {
    sessionLabel: cfg.sessionLabel,
    sessionToken: globalThis.crypto.randomUUID(),
    eclipseEnabled: ac.lighting.enableEclipse === true,
    configureCalls,
    configureTruth,
    rendererType: String(scene.context?.rendererType ?? "").toLowerCase(),
    enableLighting: scene.globe.enableLighting === true,
    captureSequence: "directional-diagnostic-then-fresh-sun-scored",
    baseColor: readBaseColor(),
    lighting: readLighting(),
    light: readLight(false),
    terminatorGlow: {
      supported: terminatorGlowSupported,
      priorStrength: priorTerminatorGlowStrength,
      ...readTerminatorGlowStrength(),
    },
    pins,
    dials,
    globeReadiness: { control: readiness },
    rungs,
    directionalDiagnosticRungs,
  };
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

  // ── Reported-only refresh-cost re-estimate: the INTERLEAVED cost legs.
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

async function openPage(browser, renderer, sessionLabel, evidence) {
  const context = await browser.newContext();
  const pageDiagnostics = [];
  try {
    const page = await context.newPage();
    let entryResponseCaptured = false;
    const runtimeEntryPromise = new Promise((resolve, reject) => {
      page.on("response", (response) => {
        let pathname;
        try {
          pathname = new URL(response.url()).pathname;
        } catch {
          return;
        }
        if (
          entryResponseCaptured ||
          pathname !== "/Build/CesiumUnminified/index.js"
        ) {
          return;
        }
        entryResponseCaptured = true;
        void response.body().then(
          (bytes) =>
            resolve({
              sessionLabel,
              url: response.url(),
              ok: response.ok(),
              status: response.status(),
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
          reject,
        );
      });
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageDiagnostics.push({
          type: "console.error",
          text: message.text().slice(0, 400),
        });
      }
    });
    page.on("pageerror", (error) =>
      pageDiagnostics.push({
        type: "pageerror",
        text: String(error).slice(0, 400),
      }),
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
    // Force this exact entry module into the fresh context before any probe
    // callback uses it. The response listener above hashes the bytes Chromium
    // executed, not a neighboring verification request.
    await page.evaluate(async () => {
      await import("/Build/CesiumUnminified/index.js");
      return true;
    });
    const observedRuntimeEntry = await runtimeEntryPromise;
    if (observedRuntimeEntry.error) {
      throw observedRuntimeEntry.error;
    }
    const runtimeEntry = observedRuntimeEntry.value;
    return { context, page, pageDiagnostics, runtimeEntry, sessionLabel };
  } catch (error) {
    try {
      await context.close();
    } catch (closeError) {
      evidence.cleanupErrors.push({
        sessionLabel,
        type: "context-close",
        text: closeError?.message ?? String(closeError),
      });
    }
    evidence.pageDiagnostics.push(
      ...pageDiagnostics.map((diagnostic) => ({
        sessionLabel,
        ...diagnostic,
      })),
    );
    throw error;
  }
}

function retainFreshPageEvidence(opened, evidence) {
  evidence.runtimeEntries.push(opened.runtimeEntry);
  evidence.pageDiagnostics.push(
    ...opened.pageDiagnostics.map((diagnostic) => ({
      sessionLabel: opened.sessionLabel,
      ...diagnostic,
    })),
  );
}

async function withFreshPage(
  browser,
  renderer,
  sessionLabel,
  evidence,
  callback,
) {
  const opened = await openPage(browser, renderer, sessionLabel, evidence);
  try {
    return await callback(opened.page);
  } finally {
    try {
      await opened.context.close();
    } catch (error) {
      evidence.cleanupErrors.push({
        sessionLabel,
        type: "context-close",
        text: error?.message ?? String(error),
      });
    }
    retainFreshPageEvidence(opened, evidence);
  }
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

class StructuralProbeError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "StructuralProbeError";
    this.details = details;
  }
}

const RUN_ID = randomUUID();
const STARTED_AT = new Date().toISOString();
const RUN_ARTIFACT = path.join(
  OUT_DIR,
  `eclipse-cloud-response-report.run-${RUN_ID}.json`,
);
const PRIOR_CANONICAL_QUARANTINE_ARTIFACT = path.join(
  OUT_DIR,
  `eclipse-cloud-response-report.prior-${RUN_ID}.json`,
);
const LIFECYCLE_PATHS = Object.freeze({
  directory: OUT_DIR,
  canonical: CANONICAL_ARTIFACT,
  firstRed: FIRST_RED_ARTIFACT,
  preLifecycle: PRE_LIFECYCLE_RUN_6_ARTIFACT,
  lock: RUN_LOCK_ARTIFACT,
  run: RUN_ARTIFACT,
  priorQuarantine: PRIOR_CANONICAL_QUARANTINE_ARTIFACT,
  archiveForRunId(runId) {
    return path.join(
      OUT_DIR,
      `eclipse-cloud-response-report.run-${runId}.json`,
    );
  },
});
let activeBrowser = null;
let browserClosePromise = null;
let browserClosed = false;
let watchdogTimedOut = false;
let watchdogCloseAttempted = false;
const cleanupErrors = [];
let watchdog;
let outerWatchdog;
let publicationAttempted = false;
let runningMarkerPublished = false;
let runLockAcquired = false;
let firstRedAtStart;
let startLocalIdentity;
let startProvenance;
let previousCanonicalAtStart;
let priorCanonicalCapture;
const browserEvidence = {
  runtimeEntries: [],
  pageDiagnostics: [],
  cleanupErrors: [],
};

const artifactBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

function sameFingerprint(left, right) {
  if (left?.exists !== true || right?.exists !== true) {
    return (
      left?.exists === false &&
      left?.error === "ENOENT" &&
      right?.exists === false &&
      right?.error === "ENOENT"
    );
  }
  return (
    left?.byteLength === right?.byteLength && left?.sha256 === right?.sha256
  );
}

export function captureC1341PriorCanonical(file, operations = fs) {
  try {
    const value = operations.readFileSync(file);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const canonical = {
      file,
      exists: true,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
    try {
      return {
        canonical,
        bytes,
        parsed: JSON.parse(bytes.toString("utf8")),
        parseError: null,
      };
    } catch (error) {
      return {
        canonical,
        bytes,
        parsed: null,
        parseError: error?.message ?? String(error),
      };
    }
  } catch (error) {
    return {
      canonical: {
        file,
        exists: false,
        byteLength: null,
        sha256: null,
        error: error?.code ?? error?.message ?? String(error),
      },
      bytes: null,
      parsed: null,
      parseError: null,
    };
  }
}

function summarizePriorCanonical(captured) {
  return {
    canonical: captured?.canonical,
    parsedStatus: captured?.parsed?.status ?? null,
    parsedRunId: captured?.parsed?.runId ?? null,
    parseError: captured?.parseError ?? null,
  };
}

export function assertNoPriorC1341Running(captured) {
  if (
    captured?.parsed?.status === "RUNNING" ||
    captured?.parsed?.incomplete === true
  ) {
    throw new Error(
      `previous RUNNING marker ${String(captured.parsed.runId)} must be investigated before retry`,
    );
  }
}

export function acquireC1341RunLock(paths, runId, operations = fs) {
  operations.writeFileSync(
    paths.lock,
    artifactBytes({ runId, acquiredAt: new Date().toISOString() }),
    { flag: "wx" },
  );
  assertC1341RunLockOwnership(paths, runId, operations);
}

export function assertC1341RunLockOwnership(paths, runId, operations = fs) {
  let lock;
  try {
    lock = JSON.parse(operations.readFileSync(paths.lock, "utf8"));
  } catch (error) {
    throw new Error("C13-41 run lock is absent or unreadable", {
      cause: error,
    });
  }
  if (lock?.runId !== runId) {
    throw new Error("C13-41 run lock ownership changed during the run");
  }
  return lock;
}

export function releaseC1341RunLock(paths, runId, operations = fs) {
  assertC1341RunLockOwnership(paths, runId, operations);
  operations.unlinkSync(paths.lock);
}

export function publishC1341Running(paths, marker, operations = fs) {
  if (
    marker?.runId === undefined ||
    marker?.status !== "RUNNING" ||
    marker?.incomplete !== true
  ) {
    throw new Error("RUNNING marker does not own this C13-41 invocation");
  }
  assertC1341RunLockOwnership(paths, marker.runId, operations);
  atomicReplaceEvidence(paths.canonical, artifactBytes(marker), operations);
}

export function assertC1341RunningOwnership(paths, runId, operations = fs) {
  assertC1341RunLockOwnership(paths, runId, operations);
  let marker;
  try {
    marker = JSON.parse(operations.readFileSync(paths.canonical, "utf8"));
  } catch (error) {
    throw new Error("C13-41 RUNNING marker is absent or unreadable", {
      cause: error,
    });
  }
  if (
    marker?.runId !== runId ||
    marker?.status !== "RUNNING" ||
    marker?.incomplete !== true
  ) {
    throw new Error("C13-41 canonical RUNNING ownership was lost");
  }
  return marker;
}

function quarantineCapturedCanonical(captured, paths, operations) {
  try {
    createImmutableEvidence(paths.priorQuarantine, captured.bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const quarantine = fingerprintEvidenceFile(paths.priorQuarantine, operations);
  if (
    quarantine.exists !== true ||
    !Number.isInteger(quarantine.byteLength) ||
    quarantine.byteLength < 0 ||
    !/^[0-9a-f]{64}$/u.test(quarantine.sha256 ?? "") ||
    !sameFingerprint(captured.canonical, quarantine)
  ) {
    throw new Error("prior canonical quarantine differs from captured bytes");
  }
  return quarantine;
}

export function prepareCapturedCanonicalForRun(
  captured,
  paths,
  operations = fs,
) {
  const canonical = captured?.canonical;
  if (canonical?.exists !== true) {
    assertEvidenceReadableOrAbsent(canonical, "prior canonical artifact");
    return { mode: "absent", canonical };
  }

  if (
    captured.parseError !== null ||
    typeof captured.parsed !== "object" ||
    captured.parsed === null ||
    Array.isArray(captured.parsed)
  ) {
    const quarantine = quarantineCapturedCanonical(captured, paths, operations);
    throw new Error(
      `prior canonical JSON is malformed; exact bytes quarantined at ${quarantine.file}`,
    );
  }

  assertEvidenceReadableOrAbsent(canonical, "prior canonical artifact");

  const previous = captured.parsed;
  assertNoPriorC1341Running(captured);
  if (previous.schema === ARTIFACT_SCHEMA) {
    if (typeof previous.runId !== "string" || previous.runId.length === 0) {
      throw new Error("previous lifecycle artifact has no runId");
    }
    const previousArchivePath = paths.archiveForRunId(previous.runId);
    const previousArchive = fingerprintEvidenceFile(
      previousArchivePath,
      operations,
    );
    assertEvidenceReadableOrAbsent(
      previousArchive,
      "prior immutable run artifact",
    );
    if (!sameFingerprint(canonical, previousArchive)) {
      throw new Error(
        `previous canonical is not bound to immutable archive ${previousArchivePath}`,
      );
    }
    return {
      mode: "prior-lifecycle-run",
      canonical,
      immutableRunArtifact: previousArchive,
    };
  }

  // The six historical runs predate run IDs and immutable archives. RUNNING
  // is already durable before this fallible preservation/verification step,
  // so no stale PASS can survive a preflight failure.
  try {
    createImmutableEvidence(paths.preLifecycle, captured.bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const legacyArchive = fingerprintEvidenceFile(paths.preLifecycle, operations);
  assertEvidenceReadableOrAbsent(legacyArchive, "pre-lifecycle run-6 archive");
  if (!sameFingerprint(canonical, legacyArchive)) {
    throw new Error(
      "pre-lifecycle run-6 archive differs from the canonical it must preserve",
    );
  }
  return { mode: "pre-lifecycle-run-6", canonical, legacyArchive };
}

async function closeActiveBrowser(reason) {
  if (!activeBrowser) {
    return;
  }
  browserClosePromise ??= activeBrowser.close().then(
    () => {
      browserClosed = true;
    },
    (error) => {
      cleanupErrors.push({ reason, error: error?.message ?? String(error) });
    },
  );
  await browserClosePromise;
}

function armWatchdogs() {
  watchdog = setTimeout(() => {
    watchdogTimedOut = true;
    watchdogCloseAttempted = true;
    console.error(
      `[probe-eclipse-cloud-response] WATCHDOG FIRED (${HARD_LIMIT_MS}ms) — closing Edge before ERROR publication`,
    );
    void closeActiveBrowser("primary watchdog");
  }, HARD_LIMIT_MS);
  watchdog.unref?.();

  outerWatchdog = setTimeout(() => {
    console.error(
      `[probe-eclipse-cloud-response] OUTER WATCHDOG FIRED (${OUTER_HARD_LIMIT_MS}ms) — RUNNING marker retained`,
    );
    // A hung browser close means the measurement task is still racing. The
    // only fail-closed action is to retain RUNNING and refuse final evidence.
    process.exit(ECLIPSE_CLOUD_EXIT.HARNESS);
  }, OUTER_HARD_LIMIT_MS);
  outerWatchdog.unref?.();
}

function clearWatchdogs() {
  clearTimeout(watchdog);
  clearTimeout(outerWatchdog);
}

export function finalizeC1341Evidence(paths, artifact, operations = fs) {
  if (
    typeof artifact?.runId !== "string" ||
    !["PASS", "FAIL", "STRUCTURAL", "ERROR"].includes(artifact?.status) ||
    artifact?.incomplete !== false
  ) {
    throw new Error(
      "final C13-41 artifact is malformed or owned by no lifecycle run",
    );
  }
  const runningMarker = assertC1341RunningOwnership(
    paths,
    artifact.runId,
    operations,
  );
  const bytes = artifactBytes(artifact);
  createImmutableEvidence(paths.run, bytes, operations);
  const archive = fingerprintEvidenceFile(paths.run, operations);
  assertEvidenceReadableOrAbsent(archive, "new immutable run artifact");
  if (archive.exists !== true) {
    throw new Error("new immutable run artifact disappeared after creation");
  }
  const firstRed =
    artifact.status === "PASS"
      ? null
      : preserveFirstRedEvidence(
          paths.firstRed,
          bytes,
          operations,
          fingerprintEvidenceFile,
        );
  let canonical;
  try {
    atomicReplaceEvidence(paths.canonical, bytes, operations);
    canonical = fingerprintEvidenceFile(paths.canonical, operations);
    assertEvidenceReadableOrAbsent(canonical, "final canonical artifact");
    if (canonical.exists !== true) {
      throw new Error("final canonical artifact disappeared after replacement");
    }
    if (!sameFingerprint(archive, canonical)) {
      throw new Error(
        "canonical artifact is not byte-identical to immutable run archive",
      );
    }
    releaseC1341RunLock(paths, artifact.runId, operations);
  } catch (error) {
    // A final result is visible only after its bytes verify and ownership is
    // cleanly relinquished. Any post-replacement failure restores this
    // invocation's RUNNING marker while the lock is retained.
    atomicReplaceEvidence(
      paths.canonical,
      artifactBytes(runningMarker),
      operations,
    );
    assertC1341RunningOwnership(paths, artifact.runId, operations);
    throw new Error(
      "C13-41 final verification or lock release failed; owned RUNNING marker restored",
      { cause: error },
    );
  }
  return {
    canonical,
    immutableRunArtifact: archive,
    firstRed,
    lockReleased: true,
  };
}

function publishFinalArtifact(artifact) {
  publicationAttempted = true;
  const publication = finalizeC1341Evidence(LIFECYCLE_PATHS, artifact);
  runLockAcquired = false;
  console.log(
    JSON.stringify(
      {
        schema: ARTIFACT_SCHEMA,
        runId: RUN_ID,
        status: artifact.status,
        exitCode: artifact.exitCode,
        ...publication,
      },
      null,
      2,
    ),
  );
  return publication;
}

export async function runEclipseCloudResponseProbe() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    acquireC1341RunLock(LIFECYCLE_PATHS, RUN_ID);
    runLockAcquired = true;

    // Capture the prior bytes without asserting, parsing, archiving, or
    // fingerprinting any other input. A genuine prior RUNNING remains owned by
    // its invocation; every other prior state is invalidated immediately by
    // this run's marker before fallible evidence preflight begins.
    priorCanonicalCapture = captureC1341PriorCanonical(CANONICAL_ARTIFACT);
    previousCanonicalAtStart = summarizePriorCanonical(priorCanonicalCapture);
    assertNoPriorC1341Running(priorCanonicalCapture);
    publishC1341Running(LIFECYCLE_PATHS, {
      schema: ARTIFACT_SCHEMA,
      schemaVersion: 3,
      probe: "probe-eclipse-cloud-response",
      task: "C13-41 (C12-29 S3 rider)",
      runId: RUN_ID,
      status: "RUNNING",
      incomplete: true,
      startedAt: STARTED_AT,
      lock: { path: RUN_LOCK_ARTIFACT, runId: RUN_ID },
      priorCanonicalAtStart: previousCanonicalAtStart,
    });
    runningMarkerPublished = true;
    armWatchdogs();

    previousCanonicalAtStart = prepareCapturedCanonicalForRun(
      priorCanonicalCapture,
      LIFECYCLE_PATHS,
    );
    startLocalIdentity = snapshotEvidenceFiles(LOCAL_EVIDENCE_FILES);
    firstRedAtStart = fingerprintEvidenceFile(FIRST_RED_ARTIFACT);
    assertEvidenceReadableOrAbsent(firstRedAtStart, "prior first-red artifact");

    startProvenance = provenance();
    if (!startProvenance.ok) {
      console.error(
        "[probe-eclipse-cloud-response] PROVENANCE FAILURE — stale or missing build:",
        JSON.stringify(startProvenance, null, 2),
      );
      // STRUCTURAL, not a harness fault: the probe ran, checked, and refused. A
      // pin on the BUILD is the same class as a pin on the scene.
      throw new StructuralProbeError(
        "stale or missing build provenance",
        startProvenance,
      );
    }

    activeBrowser = await chromium.launch({
      channel: "msedge",
      headless: true,
    });
    const browser = activeBrowser;
    let derived;
    let cloudLanes;
    const deckFreeSessions = [];
    let iblWebGPU;
    let iblWebGL;
    const shotsWritten = [];

    try {
      // ── Derive the schedule ONCE, on a WebGL context (pure ephemeris; no
      // rendering), and reuse it for both backends so the two runs are the same
      // fixture rather than two independently-located ones.
      derived = await withFreshPage(
        browser,
        "webgl",
        "derive-webgl",
        browserEvidence,
        (page) =>
          page.evaluate(DERIVE_SCHEDULE, {
            targets: ECLIPSE_CLOUD_BANDS.ladderTargets,
            rampFrames: SWEEP_RISING_FRAMES,
            rampPeak: SWEEP_PEAK_OBSCURATION,
          }),
      );
      if (!derived || derived.structuralError) {
        console.error(
          "[probe-eclipse-cloud-response] schedule derivation failed:",
          JSON.stringify(derived, null, 2),
        );
        // The derivation lane returned a `structuralError`; that is the same
        // class as any other lane that could not run.
        throw new StructuralProbeError("schedule derivation failed", derived);
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
      cloudLanes = await withFreshPage(
        browser,
        "webgpu",
        "cloud-webgpu",
        browserEvidence,
        async (page) => {
          const keys = await resolveFeatureRendererKeys(page);
          if (keys.proceduralKey === null || keys.globeSurfaceKey === null) {
            return {
              structuralError:
                "FeatureRendererKey.PROCEDURAL_CLOUDS / GLOBE_SURFACE is not exported",
            };
          }
          return page.evaluate(RUN_CLOUD_LANES, {
            ...laneConfig,
            proceduralKey: keys.proceduralKey,
            globeSurfaceKey: keys.globeSurfaceKey,
          });
        },
      );
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

      // The deck-free control gets no shared page and no repeated configuration.
      // Each ABBA entry opens and closes its own browser context, configures the
      // collection exactly once, and captures the entire four-rung ladder without
      // changing eclipse/cloud state. Cross-session agreement replaces the
      // same-page "settled twin" that run 6 proved could reproduce stale state.
      for (const planned of DECK_FREE_CONTROL_SESSION_PLAN) {
        const report = await withFreshPage(
          browser,
          "webgpu",
          `deck-free-${planned.label}`,
          browserEvidence,
          (page) =>
            page.evaluate(RUN_DECK_FREE_CONTROL_SESSION, {
              ...laneConfig,
              sessionLabel: planned.label,
              eclipseEnabled: planned.eclipseEnabled,
              lightingFadeOutDistance: DECK_FREE_LIGHTING_FADE_OUT_DISTANCE,
              lightingFadeInDistance: DECK_FREE_LIGHTING_FADE_IN_DISTANCE,
              directionalNdotLTargets: DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS,
              directionalLightIntensity: DECK_FREE_DIRECTIONAL_LIGHT_INTENSITY,
              diagnosticTerminatorGlowStrength:
                DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
              sunLightIntensity: DECK_FREE_SUN_LIGHT_INTENSITY,
            }),
        );
        deckFreeSessions.push(report);
      }
      const deckFreeControl = foldDeckFreeControlSessions({
        sessions: deckFreeSessions,
        ladder: derived.ladder,
        certifiedRungs: cloudLanes?.rungs,
        factorTolerance: ECLIPSE_CLOUD_BANDS.factorTolerance.hi,
        scheduleObscurationTolerance:
          ECLIPSE_CLOUD_BANDS.scheduleObscurationTolerance.hi,
        captureDelta: BAND_MEAN_CAPTURE_DELTA,
        diagnosticSite: {
          latitudeDegrees: derived.lat,
          longitudeDegrees: derived.lon,
        },
      });
      if (cloudLanes && !cloudLanes.structuralError) {
        cloudLanes.deckFreeControl = deckFreeControl;
        for (let index = 0; index < cloudLanes.rungs.length; index++) {
          Object.assign(
            cloudLanes.rungs[index].shadow,
            deckFreeControl.rungs[index] ?? {},
          );
        }
      }

      const iblConfig = {
        lat: derived.lat,
        lon: derived.lon,
        modelUrl: MODEL_URL,
        ramp: derived.ramp,
      };
      iblWebGPU = await withFreshPage(
        browser,
        "webgpu",
        "ibl-webgpu",
        browserEvidence,
        (page) => page.evaluate(RUN_IBL_SWEEP, iblConfig),
      );
      iblWebGL = await withFreshPage(
        browser,
        "webgl",
        "ibl-webgl",
        browserEvidence,
        (page) => page.evaluate(RUN_IBL_SWEEP, iblConfig),
      );
    } finally {
      await closeActiveBrowser("measurement finally");
    }

    if (watchdogTimedOut) {
      throw new Error(`WATCHDOG: exceeded ${HARD_LIMIT_MS} ms`);
    }
    if (
      !browserClosed ||
      cleanupErrors.length > 0 ||
      browserEvidence.cleanupErrors.length > 0
    ) {
      throw new Error(
        `browser cleanup did not complete cleanly: closed=${browserClosed}, errors=${JSON.stringify([...cleanupErrors, ...browserEvidence.cleanupErrors])}`,
      );
    }

    const endProvenance = provenance();
    const markerToStartIdentity = compareEvidenceFileSnapshots(
      startLocalIdentity,
      startProvenance.localIdentity,
    );
    const runIdentityStable = compareEvidenceFileSnapshots(
      startLocalIdentity,
      endProvenance.localIdentity,
    );
    const servedEntryIdentity = validateServedEntryIdentities({
      entries: browserEvidence.runtimeEntries,
      expectedLabels: EXPECTED_RUNTIME_SESSION_LABELS,
      localEntry: startLocalIdentity.buildEntry,
    });
    const firstRedBeforeFinalize = fingerprintEvidenceFile(FIRST_RED_ARTIFACT);
    assertEvidenceReadableOrAbsent(
      firstRedBeforeFinalize,
      "first-red artifact before finalization",
    );
    const firstRedStable = sameFingerprint(
      firstRedAtStart,
      firstRedBeforeFinalize,
    );
    const provenanceReasons = [
      ...(startProvenance.ok
        ? []
        : ["start build/source identity is not certified"]),
      ...(endProvenance.ok
        ? []
        : [
            `end build/source identity is not certified: ${(
              endProvenance.sourceIdentity?.reasons ?? [endProvenance.reason]
            )
              .filter(Boolean)
              .join("; ")}`,
          ]),
      ...markerToStartIdentity.reasons,
      ...runIdentityStable.reasons,
      ...servedEntryIdentity.reasons,
      ...(firstRedStable
        ? []
        : ["write-once first-red bytes changed during the run"]),
    ].map((reason) => `provenance: ${reason}`);
    const diagnosticReasons = browserEvidence.pageDiagnostics.map(
      (diagnostic) =>
        `${diagnostic.sessionLabel}: ${diagnostic.type}: ${diagnostic.text}`,
    );
    const webglSessions = new Set(["derive-webgl", "ibl-webgl"]);
    const consoleFaults = {
      all: browserEvidence.pageDiagnostics,
      webgpu: browserEvidence.pageDiagnostics.filter(
        (entry) => !webglSessions.has(entry.sessionLabel),
      ),
      webgl: browserEvidence.pageDiagnostics.filter((entry) =>
        webglSessions.has(entry.sessionLabel),
      ),
    };

    // ── Pin enforcement (exit 3). A probe that is not measuring the
    // configuration it documents certifies nothing, so this is STRUCTURAL and
    // never a product verdict.
    const pinReasons = [...provenanceReasons, ...diagnosticReasons];
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

    // A control-session pin failure blinds only the deck-free attribution. It is
    // not allowed to demote the independent deck, shadow-contrast, or IBL lanes.
    if (cloudLanes?.deckFreeControl) {
      const controlPinReasons = [];
      for (const session of deckFreeSessions) {
        if (!session || session.structuralError) {
          controlPinReasons.push(
            `${session?.sessionLabel ?? "unknown"}: ${session?.structuralError ?? "session did not run"}`,
          );
          continue;
        }
        controlPinReasons.push(
          ...collectPinStructural({
            pins: session.pins,
            dials: session.dials,
            captures: [],
            globeReadiness: session.globeReadiness ?? {},
            requireWeatherMap: false,
          }).map((reason) => `${session.sessionLabel}: ${reason}`),
        );
      }
      cloudLanes.deckFreeControl.structuralReasons.push(...controlPinReasons);
      cloudLanes.deckFreeControl.isolationReasons.push(...controlPinReasons);
      cloudLanes.deckFreeControl.stateIsolated =
        cloudLanes.deckFreeControl.isolationReasons.length === 0;
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
    const status =
      exitCode === ECLIPSE_CLOUD_EXIT.PASS
        ? "PASS"
        : exitCode === ECLIPSE_CLOUD_EXIT.FAIL
          ? "FAIL"
          : "STRUCTURAL";

    const report = {
      schema: ARTIFACT_SCHEMA,
      schemaVersion: 3,
      probe: "probe-eclipse-cloud-response",
      task: "C13-41 (C12-29 S3 rider) — cloud lighting / cloud shadow / IBL",
      runId: RUN_ID,
      status,
      incomplete: false,
      startedAt: STARTED_AT,
      completedAt: new Date().toISOString(),
      provenance: {
        start: startProvenance,
        end: endProvenance,
        markerToStartIdentity,
        runIdentityStable,
        servedEntryIdentity,
        servedRuntimeEntries: browserEvidence.runtimeEntries,
      },
      firstRedAtStart,
      previousCanonicalAtStart,
      firstRedBeforeFinalize,
      cleanup: {
        browserClosed,
        watchdog: {
          timedOut: watchdogTimedOut,
          closeAttempted: watchdogCloseAttempted,
        },
        errors: cleanupErrors,
        contextErrors: browserEvidence.cleanupErrors,
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
    console.log(
      JSON.stringify(
        {
          predictions: report.predictions,
          pinReasons,
          verdicts,
          GATE,
          exitCode,
        },
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
      const decrement = t.decrementModelAtDeepest ?? {};
      console.log(
        `SHADOW model: producer/footprint ${t.producerAndFootprintCertified}; ` +
          `raw cloud-composite contrast ${r6(t.rawCompositeContrastAtDeepest)} ` +
          `(legacy [${ECLIPSE_CLOUD_BANDS.shadowContrastRatio.lo}, ${ECLIPSE_CLOUD_BANDS.shadowContrastRatio.hi}] ` +
          `${t.rawCompositeContrastInLegacyBand ? "inside" : "outside"}, REPORTED ONLY); ` +
          `terrain decrement observed/expected ${r6(decrement.observed)}/${r6(decrement.expected)}, ` +
          `residual ${r6(decrement.residual)}, quantization interval ` +
          `[${r6(decrement.quantization?.residualInterval?.lo)}, ${r6(decrement.quantization?.residualInterval?.hi)}], ` +
          `certified ${decrement.withinQuantizationBound}`,
      );
      // CO-19 INSTRUMENT TELL, printed UNROUNDED and in full. The fourth run's
      // four `offNoCloud` reads were bit-identical (0.2750603921572111) across
      // instants 54 minutes apart while `offNoShadow` moved +3.3%; four identical
      // f64s here is the tell that the deck-free control is not being re-captured
      // per rung. Reported only — if it reads false again it becomes its own
      // instrument investigation, not a product verdict.
      console.log(
        `SHADOW deck-free sessions: order [${(t.deckFreeSessionOrder ?? []).join(", ")}], ` +
          `unique tokens ${(t.deckFreeSessionTokens ?? []).length}, stateIsolated ${t.deckFreeControlStateIsolated}, ` +
          `lit ${t.deckFreeGroundIsLit}, rawDistance ${t.deckFreeMaximumRawDistance}, ` +
          `OFF spreads ${t.deckFreeOffASpread}/${t.deckFreeOffBSpread}; ` +
          `offNoCloud [${(t.offNoCloudSeries ?? []).join(", ")}] ` +
          `spread ${t.offNoCloudSpread}, offNoShadow spread ${t.offNoShadowSpread}; ` +
          `offNoCloudVariesWithSun ${t.offNoCloudVariesWithSun} ` +
          `(false = four identical f64s, the tell); ` +
          `deck-free dim at deepest ${r3(t.deckFreeExcessAtDeepest)}x F ` +
          `(1.0 exonerates the globe light path and makes the CO-17 residue CLOUD-DRIVEN; ` +
          `>1 indicts the globe path)`,
      );
      // State-isolated attribution evidence, printed unrounded. Each `first` and
      // `settled` value is now a different fresh browser context in ABBA order;
      // agreement means the measurement replicated across sessions, disagreement
      // is STRUCTURAL. `retention on/off` remains the corroborating pair.
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
          `(replicated+failing = ENGINE identity violation; divergent sessions = INSTRUMENT)`,
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
      `COST (reported-only; historical obligation discharged): ` +
        `webgpu ${verdicts.cost.webgpu.valid ? `${r3(verdicts.cost.webgpuMsPerRefresh)} ms/refresh` : `INVALID — ${verdicts.cost.webgpu.invalidReason}`}; ` +
        `webgl ${verdicts.cost.webgl.valid ? `${r3(verdicts.cost.webglMsPerRefresh)} ms/refresh` : `INVALID — ${verdicts.cost.webgl.invalidReason}`}`,
    );

    publishFinalArtifact(report);
    clearWatchdogs();
    console.log(`EXIT: ${exitCode}`);
    process.exitCode = exitCode;
  } catch (e) {
    // An escaped apparatus exception is a HARNESS FAULT (exit 2) and publishes
    // ERROR; a deliberate precondition refusal is STRUCTURAL (exit 3). Neither
    // is allowed to masquerade as a product verdict.
    await closeActiveBrowser("top-level error finally");
    const structural = e instanceof StructuralProbeError;
    const exitCode = structural
      ? ECLIPSE_CLOUD_EXIT.STRUCTURAL
      : ECLIPSE_CLOUD_EXIT.HARNESS;
    const status = structural ? "STRUCTURAL" : "ERROR";
    const errorArtifact = {
      schema: ARTIFACT_SCHEMA,
      schemaVersion: 3,
      probe: "probe-eclipse-cloud-response",
      task: "C13-41 (C12-29 S3 rider) — cloud lighting / cloud shadow / IBL",
      runId: RUN_ID,
      status,
      incomplete: false,
      exitCode,
      startedAt: STARTED_AT,
      completedAt: new Date().toISOString(),
      startLocalIdentity,
      endLocalIdentity: snapshotEvidenceFiles(LOCAL_EVIDENCE_FILES),
      startProvenance,
      firstRedAtStart,
      firstRedBeforeFinalize: fingerprintEvidenceFile(FIRST_RED_ARTIFACT),
      previousCanonicalAtStart,
      browserEvidence,
      cleanup: {
        browserLaunched: activeBrowser !== null,
        browserClosed,
        watchdog: {
          timedOut: watchdogTimedOut,
          closeAttempted: watchdogCloseAttempted,
        },
        errors: cleanupErrors,
        contextErrors: browserEvidence.cleanupErrors,
      },
      error: e?.stack ?? String(e),
      details: e?.details ?? null,
    };
    if (!publicationAttempted && runningMarkerPublished) {
      try {
        publishFinalArtifact(errorArtifact);
      } catch (publicationError) {
        console.error(
          "[probe-eclipse-cloud-response] FINAL ARTIFACT PUBLICATION FAILED; owned RUNNING marker and lock retained where possible:",
          publicationError,
        );
      }
    }
    if (!runningMarkerPublished && runLockAcquired) {
      try {
        releaseC1341RunLock(LIFECYCLE_PATHS, RUN_ID);
        runLockAcquired = false;
      } catch (releaseError) {
        console.error(
          "[probe-eclipse-cloud-response] pre-marker lock release failed; lock retained for investigation:",
          releaseError,
        );
      }
    }
    clearWatchdogs();
    console.error(
      `[probe-eclipse-cloud-response] ${structural ? "STRUCTURAL" : "HARNESS FAULT"}:`,
      e,
    );
    console.log(`EXIT: ${exitCode}`);
    process.exitCode = exitCode;
  } finally {
    // Last-resort reclamation. Every path above closes through
    // `closeActiveBrowser`, which memoizes into `browserClosePromise`, so this
    // launches a close only when something returned or threw before any of
    // those call sites ran — the leak a `finally` is the only construct that
    // can cover.
    if (activeBrowser !== null && browserClosePromise === null) {
      browserClosePromise = activeBrowser.close().then(
        () => {
          browserClosed = true;
        },
        (error) => {
          cleanupErrors.push({
            reason: "top-level finally",
            error: error?.message ?? String(error),
          });
        },
      );
    }
    await browserClosePromise;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === PROBE_FILE) {
  void runEclipseCloudResponseProbe();
}
