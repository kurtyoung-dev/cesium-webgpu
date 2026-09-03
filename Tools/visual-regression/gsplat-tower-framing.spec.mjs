// gsplat-tower-framing.spec.mjs — pure C15-G7 tower/terrain camera-framing math.
// @purpose Behaviour-pin the tower/terrain range formula, the real evaluator's live cross-check that the page actually used it, and the pre-registered mask-pixel floor decision; then mutate both of the real evaluator's guards for inertness to prove each is load-bearing rather than vacuous.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, build, or GPU device is required.
//
// SCOPE. This spec pins three things, all exercised as plain-number or
// structured-result behaviour, never by inspecting source text: the
// range-from-separation formula itself (`computeTowerTerrainRange`), the
// real evaluator's live cross-check that a recorded page range matches that
// formula (Section 3b -- this is `computeTowerTerrainRange`'s production
// consumer, not just this spec), and the floor decision
// (`evaluateTowerMaskFloor`). Section 3a/3b drive the REAL evaluator
// (`evaluateGsplatClassificationDepth`) through a full valid input built the
// same way the sibling C15-G7 instrument suite does, to prove both guards
// are actually wired into the structural gate and not merely defined.
// Section 4 mutates each guard in turn to be unreachable and requires the
// fixture that trips it to stop tripping it -- proving each is
// load-bearing.
//
// WHAT THIS SPEC DOES NOT PROVE. Whether the reframed camera actually puts
// "hundreds" of tower-silhouette pixels on screen is a rendering fact this
// pure-Node spec cannot observe -- that is the Edge executor's re-run after
// the companion engine fix lands (see the probe's own header). This spec
// proves the FORMULA is correct, that the real page range is checked
// against it, and that the FLOOR is correct and wired; it cannot prove the
// live capture clears the floor.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TOWER_FRAMING_CONFIG,
  computeTowerTerrainRange,
  evaluateTowerMaskFloor,
} from "./lib/gsplat-tower-framing.mjs";
import { evaluateGsplatClassificationDepth } from "./lib/gsplat-classification-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(here, "lib/gsplat-classification-model.mjs");
// Matches the sibling `webgpu-blend-table-parity.spec.mjs` convention: scratch
// copies used to dynamically import a mutated real module live under the
// gitignored `Tools/visual-regression/output/` directory, not the OS temp
// directory, so they stay inside the repo's own scratch area.
const outputDirectory = path.join(here, "output");

// The real `tower/tileset.json` asset's tower-to-terrain-reference altitude
// separation and the live vertical field of view Cesium's default
// `PerspectiveFrustum` produces for the probe's 960x720 canvas (aspectRatio
// = width/height = 4/3 > 1, so `fovy = 2*atan(tan(fov/2)/aspectRatio)` per
// `PerspectiveFrustum.js`'s own `update()`, with the default `fov` = 60
// degrees). Re-derived independently from the asset's `tileset.json` root
// box and transform during the C15-G7b fix round -- see
// `gsplat-tower-framing.mjs`'s module doc for the full derivation.
const REAL_ASSET_VERTICAL_SEPARATION_METERS = 2851.9544793492455;
const REAL_ASSET_FOVY_RADIANS =
  2 * Math.atan(Math.tan(Math.PI / 3 / 2) / (960 / 720));

// =============================================================================
// Section 1 -- computeTowerTerrainRange: the range-from-separation formula.
// =============================================================================

test("computeTowerTerrainRange matches the closed-form range/2/(margin*tan(halfFovY)) arithmetic", () => {
  // halfFovY = PI/4, tan(PI/4) = 1, so range = separation/2 for margin = 1.
  assert.ok(
    Math.abs(computeTowerTerrainRange(2000, Math.PI / 2, 1) - 1000) < 1e-9,
  );
});

test("computeTowerTerrainRange defaults to the registered margin fraction when none is supplied", () => {
  const withDefault = computeTowerTerrainRange(2000, Math.PI / 2);
  const withExplicit = computeTowerTerrainRange(
    2000,
    Math.PI / 2,
    TOWER_FRAMING_CONFIG.marginFraction,
  );
  assert.equal(withDefault, withExplicit);
});

test("a larger margin fraction moves the camera closer (smaller range)", () => {
  const loose = computeTowerTerrainRange(2000, Math.PI / 2, 0.5);
  const tight = computeTowerTerrainRange(2000, Math.PI / 2, 0.9);
  assert.ok(
    tight < loose,
    "a tighter (larger) margin fraction must produce a smaller range",
  );
});

test("range scales linearly with vertical separation for a fixed fovY and margin", () => {
  const base = computeTowerTerrainRange(1000, Math.PI / 2, 0.8);
  const doubled = computeTowerTerrainRange(2000, Math.PI / 2, 0.8);
  assert.ok(
    Math.abs(doubled - 2 * base) < 1e-9,
    "doubling the separation must double the range",
  );
});

test("computeTowerTerrainRange rejects a non-positive or non-finite vertical separation", () => {
  for (const bad of [0, -5, NaN, Infinity, undefined]) {
    assert.throws(
      () => computeTowerTerrainRange(bad, Math.PI / 2, 0.8),
      RangeError,
    );
  }
});

test("computeTowerTerrainRange rejects a fovY outside (0, PI)", () => {
  for (const bad of [0, -1, Math.PI, Math.PI + 0.1, NaN, Infinity]) {
    assert.throws(() => computeTowerTerrainRange(2000, bad, 0.8), RangeError);
  }
});

test("computeTowerTerrainRange rejects a margin fraction outside (0, 1]", () => {
  for (const bad of [0, -1, 1.01, NaN, Infinity]) {
    assert.throws(
      () => computeTowerTerrainRange(2000, Math.PI / 2, bad),
      RangeError,
    );
  }
});

// Pins the row's actual geometry claim: applied to the real asset's measured
// altitude separation and Cesium's real default vertical FOV for this
// probe's canvas, the registered margin fraction produces a range strictly
// smaller than the range the pre-fix probe used (`combined.radius * 3` =
// 4284.009060367698, computed against the same asset during the fix round --
// a genuine tightening, not merely a differently-derived number of the same
// size.
test("against the real tower asset's measured geometry, the range is smaller than the pre-fix combined-sphere range", () => {
  const range = computeTowerTerrainRange(
    REAL_ASSET_VERTICAL_SEPARATION_METERS,
    REAL_ASSET_FOVY_RADIANS,
    TOWER_FRAMING_CONFIG.marginFraction,
  );
  const preFixCombinedSphereRange = 4284.009060367698;
  assert.ok(range > 0 && Number.isFinite(range));
  assert.ok(
    range < preFixCombinedSphereRange,
    `expected a tighter range than the pre-fix ${preFixCombinedSphereRange}, got ${range}`,
  );
});

// =============================================================================
// Section 2 -- evaluateTowerMaskFloor: the refusal decision.
// =============================================================================

test("evaluateTowerMaskFloor refuses a mask below the pre-registered floor", () => {
  const result = evaluateTowerMaskFloor(1, 100);
  assert.equal(result.ok, false);
  assert.equal(result.floor, 100);
  assert.equal(result.reason, "tower-mask:below-framing-floor");
});

test("evaluateTowerMaskFloor accepts a mask exactly at the floor", () => {
  const result = evaluateTowerMaskFloor(100, 100);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test("evaluateTowerMaskFloor accepts a mask above the floor", () => {
  const result = evaluateTowerMaskFloor(4000, 100);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test("evaluateTowerMaskFloor rejects a non-integer pixel count defensively", () => {
  for (const bad of [1.5, NaN, "289", undefined, null]) {
    const result = evaluateTowerMaskFloor(bad, 100);
    assert.equal(result.ok, false);
  }
});

test("evaluateTowerMaskFloor defaults to the registered floor when none is supplied", () => {
  const belowDefault = TOWER_FRAMING_CONFIG.minimumTowerMaskPixels - 1;
  assert.equal(evaluateTowerMaskFloor(belowDefault).ok, false);
  assert.equal(
    evaluateTowerMaskFloor(TOWER_FRAMING_CONFIG.minimumTowerMaskPixels).ok,
    true,
  );
});

// =============================================================================
// Section 3 -- both guards wired into the real evaluator.
// =============================================================================
//
// Mirrors the fixture shape `gsplat-campaign15-instruments.spec.mjs` already
// uses for this same evaluator (a full valid classification input that PASSes
// by default), scaled down here so the tower silhouette size is directly
// controllable per test.

function rgbaFrame(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 38;
    data[offset + 1] = 38;
    data[offset + 2] = 44;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function cloneFrame(frame) {
  return {
    width: frame.width,
    height: frame.height,
    data: new Uint8ClampedArray(frame.data),
  };
}

function paintSquare(frame, centerX, centerY, halfSide, color) {
  for (let y = centerY - halfSide; y <= centerY + halfSide; y++) {
    for (let x = centerX - halfSide; x <= centerX + halfSide; x++) {
      const offset = (y * frame.width + x) * 4;
      frame.data[offset] = color[0];
      frame.data[offset + 1] = color[1];
      frame.data[offset + 2] = color[2];
      frame.data[offset + 3] = 255;
    }
  }
}

// `towerHalfSide` controls the rendered tower silhouette's pixel count:
// (2 * towerHalfSide + 1)^2. 1 -> 9px (below a 100px floor); 8 -> 289px
// (matches the sibling suite's default fixture, above the floor).
function frames(towerHalfSide) {
  const width = 100;
  const height = 100;
  const baseline = rgbaFrame(width, height);
  const tower = cloneFrame(baseline);
  paintSquare(tower, 70, 50, towerHalfSide, [170, 170, 180]);
  const towerRepeat = cloneFrame(tower);
  const terrainReference = cloneFrame(baseline);
  paintSquare(terrainReference, 25, 50, 3, [240, 5, 210]);
  const positive = cloneFrame(tower);
  paintSquare(positive, 25, 50, 3, [240, 5, 210]);
  paintSquare(positive, 70, 50, 3, [240, 5, 210]);
  return { baseline, tower, towerRepeat, terrainReference, positive };
}

function pixelsInput(towerHalfSide) {
  return {
    frames: frames(towerHalfSide),
    anchors: { splat: { x: 70, y: 50 }, terrain: { x: 25, y: 50 } },
  };
}

// `framingOverride` lets a test tamper with the recorded page telemetry
// (Section 3b) independently of the tower silhouette size (Section 3a).
// `undefined` (the default) omits `framing` entirely -- exercising the
// same shape older fixtures that predate this telemetry would have.
function runtimeFor(rendererType, framingOverride) {
  return {
    ready: true,
    globeTilesLoaded: true,
    globeCommands: 1,
    splatCommands: 1,
    tilesetReady: true,
    classifierReady: true,
    rendererType,
    ...(rendererType === "webgpu" ? { gpuGateArmedDevices: 1 } : {}),
    ...(framingOverride !== undefined ? { framing: framingOverride } : {}),
  };
}

// A framing telemetry object a real page would record, self-consistent with
// `computeTowerTerrainRange` (Section 3b's "matches" leg uses this as-is;
// its "mismatch" leg perturbs `range` alone).
function consistentFraming() {
  const verticalSeparationMeters = 2000;
  const fovYRadians = Math.PI / 2;
  const marginFraction = 0.8;
  return {
    verticalSeparationMeters,
    fovYRadians,
    marginFraction,
    range: computeTowerTerrainRange(
      verticalSeparationMeters,
      fovYRadians,
      marginFraction,
    ),
    minimumTowerMaskPixels: TOWER_FRAMING_CONFIG.minimumTowerMaskPixels,
  };
}

function counter(kind) {
  return {
    executions: 1,
    selectedExecutions: kind === "selected" ? 1 : 0,
    fallbackExecutions: kind === "fallback" ? 1 : 0,
    unexpectedReadExecutions: 0,
  };
}

// Builds a full valid `evaluateGsplatClassificationDepth` input using the
// SAME `summarizeClassificationPixels` the real probe calls, with the tower
// silhouette size and the recorded framing telemetry as controlled
// variables.
async function classificationInputWithTowerSize(
  summarizeClassificationPixels,
  config,
  towerHalfSide,
  framingOverride,
) {
  const pixels = summarizeClassificationPixels(
    pixelsInput(towerHalfSide),
    config,
  );
  return {
    schema: "cesium.c15-g7.gsplat-classification-depth.v1",
    captureContract: {
      canonical: true,
      singleBlock: true,
      usageValid: true,
      writeOnce: true,
    },
    cleanup: { complete: true },
    harnessErrors: [],
    productErrors: [],
    webgl: { pixels, runtime: runtimeFor("webgl", framingOverride) },
    webgpu: {
      pixels,
      runtime: runtimeFor("webgpu", framingOverride),
      route: {
        instrument: {
          commandLocated: true,
          commandInFrustum: true,
          gaussianSplatPass: true,
          depthClassificationFlag: true,
          variantDefined: true,
          variantDistinctFromBase: true,
          bundleAbsent: true,
          stableCommandIdentity: true,
          suppressionGetterHeld: true,
          descriptorRestored: true,
        },
        positive: counter("selected"),
        suppressed: counter("fallback"),
        restored: counter("selected"),
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Section 3a -- the pixel floor guard.
// -----------------------------------------------------------------------------

test("the real evaluator refuses a tower mask below the pre-registered floor, for both backends", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  // halfSide 1 -> a 3x3 = 9px tower silhouette, well under the 100px floor.
  const input = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    1,
  );
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, 3);
  assert.ok(result.structural.includes("webgl:tower-mask:below-framing-floor"));
  assert.ok(
    result.structural.includes("webgpu:tower-mask:below-framing-floor"),
  );
});

test("the real evaluator does not raise the framing-floor reason once the tower mask clears it", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  // halfSide 8 -> a 17x17 = 289px tower silhouette, matching the sibling
  // instrument suite's default fixture and clearing the 100px floor.
  const input = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    8,
  );
  const result = evaluateGsplatClassificationDepth(input);
  assert.ok(
    !result.structural.includes("webgl:tower-mask:below-framing-floor"),
  );
  assert.ok(
    !result.structural.includes("webgpu:tower-mask:below-framing-floor"),
  );
});

test("the pixel summary states the floor it judged towerMaskPixels against", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const summary = summarizeClassificationPixels(
    pixelsInput(8),
    GSPLAT_CLASSIFICATION_CONFIG,
  );
  assert.equal(
    summary.framingFloor,
    GSPLAT_CLASSIFICATION_CONFIG.minimumTowerMaskPixels,
  );
});

test("an invalid minimumTowerMaskPixels config value is rejected like every other threshold", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const summary = summarizeClassificationPixels(pixelsInput(8), {
    ...GSPLAT_CLASSIFICATION_CONFIG,
    minimumTowerMaskPixels: -1,
  });
  assert.equal(summary.ok, false);
  assert.ok(
    summary.failures.includes("pixels:config:minimumTowerMaskPixels:invalid"),
  );
});

// -----------------------------------------------------------------------------
// Section 3b -- the framing-range pinning guard (computeTowerTerrainRange's
// production consumer: it recomputes the expected range from recorded page
// telemetry and requires the page's actual range to match).
// -----------------------------------------------------------------------------

test("the real evaluator raises no framing reason when the recorded page range matches the pinned formula", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const input = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    8,
    consistentFraming(),
  );
  const result = evaluateGsplatClassificationDepth(input);
  assert.ok(!result.structural.includes("webgl:framing:range-not-pinned"));
  assert.ok(!result.structural.includes("webgpu:framing:range-not-pinned"));
});

test("the real evaluator refuses when the recorded page range does not match the pinned formula", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const tampered = { ...consistentFraming(), range: 999999 };
  const input = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    8,
    tampered,
  );
  const result = evaluateGsplatClassificationDepth(input);
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(result.structural.includes("webgl:framing:range-not-pinned"));
  assert.ok(result.structural.includes("webgpu:framing:range-not-pinned"));
});

test("a fixture with no framing telemetry at all is unaffected by the pinning guard", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  // `framingOverride` omitted -> `runtime.framing` is absent, matching a
  // fixture written before this telemetry existed.
  const input = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    8,
  );
  const result = evaluateGsplatClassificationDepth(input);
  assert.ok(!result.structural.includes("webgl:framing:range-not-pinned"));
  assert.ok(!result.structural.includes("webgpu:framing:range-not-pinned"));
});

// =============================================================================
// Section 4 -- inertness mutants: each of the real evaluator's two guards,
// disabled in turn.
// =============================================================================
//
// Wraps one real `gsplat-classification-model.mjs` guard call at a time in
// `if (false && true) { ... }` in a scratch copy, so the guard is present in
// source but never executes. The fixture that Section 3a/3b proved trips
// that guard on the real module must NOT trip it on the mutant -- otherwise
// the guard is decorative rather than load-bearing. The two existing
// relative imports are rewritten to absolute file URLs so the scratch copy
// (written under `Tools/visual-regression/output/`, this package's own
// gitignored scratch area) still resolves its real, unmutated dependencies.

// The model computes `towerFloorResult = evaluateTowerMaskFloor(...)` as its
// own statement, then reads `towerFloorResult.ok`/`.reason` inside the
// `pushUnless(...)` call that actually raises the reason -- so
// `towerFloorResult.ok,` (the property read, not the constructor call one
// statement above) is the stable anchor INSIDE that `pushUnless(...)`
// call's own text. It survives both a Prettier reflow AND any future
// rewording of the reason-string construction, unlike a needle on the
// reason STRING itself (which does not appear verbatim in this file's
// source at all -- it lives only in `gsplat-tower-framing.mjs`, returned at
// runtime). Finding the ENCLOSING `pushUnless(...)` call by paren-balance
// (rather than matching the call's exact formatted text) keeps this mutant
// immune to reflow, the way `gsplat-campaign15-instruments.spec.mjs`'s own
// `extractBalanced` helper does for its lifted-function extraction.
const FLOOR_GUARD_CALL_NEEDLE = "towerFloorResult.ok,";
// Same reasoning for the framing-range pinning guard added in this fix
// round (Section 3b): `framingInputsValid &&` is text inside that
// `pushUnless(...)` call's own condition, distinct from the guard's
// surrounding `if (framing !== undefined) { ... }` wrapper.
const FRAMING_GUARD_CALL_NEEDLE = "framingInputsValid &&";

function findEnclosingCall(source, callName, needle) {
  const needleIndex = source.indexOf(needle);
  assert.notEqual(
    needleIndex,
    -1,
    `needle not found in ${modelPath}: ${needle}`,
  );
  const callStart = source.lastIndexOf(`${callName}(`, needleIndex);
  assert.notEqual(
    callStart,
    -1,
    `no enclosing ${callName}(...) call before the needle`,
  );
  const openParen = callStart + callName.length;
  assert.equal(source[openParen], "(");

  let depth = 0;
  let index = openParen;
  for (; index < source.length; index++) {
    if (source[index] === "(") {
      depth++;
    } else if (source[index] === ")") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
  }
  assert.equal(depth, 0, `unbalanced parens scanning the ${callName} call`);
  let end = index + 1;
  if (source[end] === ";") {
    end += 1;
  }
  return { start: callStart, end };
}

// This repo checks out with CRLF line terminators (`core.autocrlf=true`);
// normalize to LF before matching so the needle is checkout-independent.
function readNormalized(file) {
  return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

function buildMutantSource(needle, expectedSubstring) {
  const source = readNormalized(modelPath);
  const { start, end } = findEnclosingCall(source, "pushUnless", needle);
  const guardCall = source.slice(start, end);
  assert.ok(
    guardCall.includes(expectedSubstring),
    `matched the wrong pushUnless call -- expected the guard containing "${expectedSubstring}"`,
  );

  const towerFramingUrl = pathToFileURL(
    path.join(here, "lib/gsplat-tower-framing.mjs"),
  ).href;
  const verdictExitGateUrl = pathToFileURL(
    path.join(here, "lib/verdict-exit-gate.mjs"),
  ).href;

  const disabledGuard = `if (false && true) {\n    ${guardCall}\n  }`;
  const mutated = source.slice(0, start) + disabledGuard + source.slice(end);

  assert.notEqual(
    mutated,
    source,
    "the inertness rewrite must actually change the source",
  );

  return mutated
    .replace('"./verdict-exit-gate.mjs"', `"${verdictExitGateUrl}"`)
    .replace('"./gsplat-tower-framing.mjs"', `"${towerFramingUrl}"`);
}

async function importMutant(needle, expectedSubstring) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(outputDirectory, "gsplat-tower-framing-mutant-"),
  );
  try {
    const file = path.join(directory, "gsplat-classification-model.mutant.mjs");
    fs.writeFileSync(
      file,
      buildMutantSource(needle, expectedSubstring),
      "utf8",
    );
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("inertness: disabling the real evaluator's floor guard makes the below-floor fixture stop tripping it", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const belowFloorInput = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    1,
  );

  const original = evaluateGsplatClassificationDepth(belowFloorInput);
  assert.ok(
    original.structural.includes("webgl:tower-mask:below-framing-floor"),
    "precondition: the real (unmutated) guard must trip on this fixture",
  );

  const mutant = await importMutant(
    FLOOR_GUARD_CALL_NEEDLE,
    "towerFloorResult",
  );
  const mutated = mutant.evaluateGsplatClassificationDepth(belowFloorInput);
  assert.ok(
    !mutated.structural.includes("webgl:tower-mask:below-framing-floor"),
    "the disabled guard must no longer raise the reason -- proves the guard, not something else, produced it",
  );
});

test("inertness: disabling the real evaluator's framing-pinning guard makes the mismatched-range fixture stop tripping it", async () => {
  const { summarizeClassificationPixels, GSPLAT_CLASSIFICATION_CONFIG } =
    await import("./lib/gsplat-classification-model.mjs");
  const tampered = { ...consistentFraming(), range: 999999 };
  const mismatchedInput = await classificationInputWithTowerSize(
    summarizeClassificationPixels,
    GSPLAT_CLASSIFICATION_CONFIG,
    8,
    tampered,
  );

  const original = evaluateGsplatClassificationDepth(mismatchedInput);
  assert.ok(
    original.structural.includes("webgl:framing:range-not-pinned"),
    "precondition: the real (unmutated) guard must trip on this fixture",
  );

  const mutant = await importMutant(
    FRAMING_GUARD_CALL_NEEDLE,
    "framingInputsValid",
  );
  const mutated = mutant.evaluateGsplatClassificationDepth(mismatchedInput);
  assert.ok(
    !mutated.structural.includes("webgl:framing:range-not-pinned"),
    "the disabled guard must no longer raise the reason -- proves the guard, not something else, produced it",
  );
});
