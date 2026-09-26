// cloud-march-budget.spec.mjs — a cloud dial cannot ask the device for a march
// it cannot finish: the resolver holds every frame to a march budget, reports
// the ask beside what ran, and leaves every ask inside the budget untouched.
// @purpose Executes the pure cloud resolver from Node to prove that every input path (the tier dial, raw cloudQuality and the debug realization override) resolves to a march whose cost, counted over the shader's real interval sentinel, never exceeds the budget; that an ask inside the budget resolves byte-identical to the resolver as it stood before the budget; that an ask outside it keeps every field but the step counts, loses primary steps before light steps, and reports the ask; that the measured completions and hangs fall on the stated sides; and that each gate made unreachable turns the matching assertion red.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// Raw `cloudQuality` passed straight through as the primary step count with no
// bound, and the debug override's caps bound the step product only. Neither
// sees the render resolution or the noise source, and both matter on a real
// device: at a 2048² canvas the cinematic 96 × 8 march completed with baked
// noise and hung the GPU with live noise, and raw 256 hung it too. The budget
// is the one place that weighs all of them, late in the resolver, after the
// tier decision and after the override.
//
// WHAT IS ASSERTED
// ----------------
//  A. THE RULE'S CONSTANTS ARE THE SHADER'S. The per-step interval sentinel,
//     the multi-deck march count and the cone tap count are read out of the
//     WGSL, so a march-law change there cannot leave the budget costing the
//     old one.
//  B. THE MEASURED POINTS FALL ON THEIR SIDES. The completed 96 × 8 baked
//     frame and its jitter-off twin resolve untouched; the live-noise frame
//     that hung, raw 256 and raw 384 resolve budgeted with the ask reported;
//     every margin is at least 1.39.
//  C. EVERY INPUT PATH, SWEPT. Every tier, the auto bands, every aerial mode,
//     raw values {32 … 1e6, NaN, ∞, a fraction just under an integer}, six
//     viewports, three residency states, both deck modes, the mask pass and
//     the full-resolution fallback: the resolved cost, counted on the f32
//     counts the shader reads, never exceeds the budget; an ask inside it is
//     byte-identical to the resolver read out of git at the pre-budget commit;
//     an ask outside it is reduced no further than the budget and the fitted
//     step ceiling need, primary steps first, with every other field unmoved.
//  D. THE DEFAULT ROWS ARE NOT BUDGETED up to 5,859,375 canvas pixels with the
//     bake resident, and the tier row itself is handed out; above that the
//     cinematic row is budgeted, which is pinned with its thresholds.
//  E. THE OVERRIDE, THE INTERVAL LAW AND THE FRAME'S OTHER MARCHES. The
//     override's flag half moves the costed noise source and light march
//     exactly as it moves the frame; the multi-deck march multiplies the
//     intervals; the per-device budget input scales the result; the f32
//     upload, the full-resolution fallback and the mask pass are costed; a
//     budgeted frame runs no more than the fitted step ceiling, and an
//     unbounded count resolves to the floor.
//  F. RELEASE AND RENDERER. After the release pragma strip the budget still
//     holds raw `cloudQuality`; the renderer hands the resolver the viewport,
//     the bake's residency, the deck mode and the mask pass before it
//     resolves, applies the budget again when the half-resolution target
//     falls back, publishes the report, and counts `primarySampleBudget` over
//     the real intervals.
//  G. INERTNESS MUTANTS. The budget gate made unreachable, the noise weight
//     removed, the deck factor removed, the f32 read removed, the fallback and
//     mask costing made unreachable and the step ceiling removed each turn
//     their assertions red.
//
// NOT ASSERTED HERE: that a device completes a budgeted frame. That is the
// named Edge leg's job; this file proves only what the resolver hands it.
//
// Run: node --test Tools/visual-regression/cloud-march-budget.spec.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const PRESETS_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";
const RENDERER_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const OBSERVABILITY_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts";
const CLOUDS_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl";
// The last commit whose resolver has no march budget. Read only when present,
// so a shallow clone still runs every other assertion.
const PRE_BUDGET_COMMIT = "090dc1cdec02399128a37676f0ebaa25ee5a3639";

const readSource = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const presetsSource = readSource(PRESETS_TS);

const live = await import(pathToFileURL(path.join(root, PRESETS_TS)).href);

/**
 * Import a module source from a fresh sandbox under `os.tmpdir()`, run `use`
 * against it and remove the sandbox.
 *
 * @param {string} source Module source text.
 * @param {(mod: object) => (void|Promise<void>)} use
 * @returns {Promise<void>}
 */
async function withModule(source, use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-march-budget-"));
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the sandbox ${dir} escaped os.tmpdir()`,
  );
  try {
    const file = path.join(dir, "WebGPUCloudTierPresets.ts");
    fs.writeFileSync(file, source);
    await use(await import(pathToFileURL(file).href));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The pre-budget resolver, or `null` when the commit is not in this clone. */
function preBudgetSource() {
  try {
    return execFileSync("git", ["show", `${PRE_BUDGET_COMMIT}:${PRESETS_TS}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// ── The rule, transcribed independently of the module ───────────────────────
//
// cost = marchPixels × marches × 3·trunc(f32 primarySteps) × lightTaps × weight
//   marchPixels  viewport × renderResScale² on a reduced-resolution tier whose
//                target allocated (else the viewport), plus the viewport again
//                when the transmittance-mask pass runs
//   marches      3 with the multi-deck march, else 1
//   lightTaps    6 on the cone light march, else
//                max(1, trunc(f32(f32 light × f32 scale)))
//   weight       1 for resident baked noise, 2 for live noise

const BUDGET = 1.35e10;
const LIVE_WEIGHT = 2;
const REFERENCE_PIXELS = 1920 * 1080;
const FITTED_CEILING = 128;
const QF_NOISE_BAKED = 1;
const QF_LIGHT_CONE = 1 << 10;
const f32 = Math.fround;

function mask(value) {
  return value !== undefined && Number.isFinite(value) ? value >>> 0 : 0;
}

/**
 * @param {object} preset A resolved or asked preset.
 * @param {object} inputs Resolver inputs.
 * @returns {number}
 */
function specCost(preset, inputs) {
  const steps = Math.trunc(f32(preset.primarySteps));
  if (Number.isNaN(steps) || steps === Infinity) {
    return Infinity;
  }
  if (steps <= 0) {
    return 0;
  }
  const v = inputs.viewportPixels;
  const viewport =
    typeof v === "number" && Number.isFinite(v) && v >= 0
      ? v
      : REFERENCE_PIXELS;
  const s = preset.renderResScale;
  const reduced = s > 0 && s < 1 && inputs.fullResolutionFallback !== true;
  const pixels =
    (reduced ? viewport * s * s : viewport) +
    (inputs.transmittanceMaskPass === true ? viewport : 0);
  const resident = inputs.bakedNoiseResident === true;
  let baked = preset.noiseSource === 1 && resident;
  let cone = preset.lightConeSampling;
  const o = inputs.realizationOverride;
  if (o !== undefined && o !== null) {
    const set = mask(o.qualityFlagsSet);
    const clear = mask(o.qualityFlagsClear);
    baked =
      (baked || ((set & QF_NOISE_BAKED) !== 0 && resident)) &&
      (clear & QF_NOISE_BAKED) === 0;
    cone =
      (cone || (set & QF_LIGHT_CONE) !== 0) && (clear & QF_LIGHT_CONE) === 0;
  }
  let taps = 6;
  if (!cone) {
    const n = Math.trunc(
      f32(f32(preset.lightSteps) * f32(preset.lightSampleScale)),
    );
    taps = Number.isFinite(n) ? Math.max(1, n) : Infinity;
  }
  const marches = inputs.multiDeck === true ? 3 : 1;
  return pixels * marches * 3 * steps * taps * (baked ? 1 : LIVE_WEIGHT);
}

/** A key-ordered serialization that keeps NaN, -0 and Infinity distinct. */
function serialize(preset) {
  return JSON.stringify(
    Object.entries(preset).map(([key, value]) => [
      key,
      typeof value === "number"
        ? String(Object.is(value, -0) ? "-0" : value)
        : value,
    ]),
  );
}

function withoutSteps(preset) {
  const rest = { ...preset };
  delete rest.primarySteps;
  delete rest.lightSteps;
  return rest;
}

const ORBITAL_HEIGHT = 6_608_000;
const RIG_PIXELS = 2048 * 2048;

function inputsFor(preset, extra = {}) {
  return {
    preset,
    rawCloudQuality: 64,
    cameraHeightMeters: ORBITAL_HEIGHT,
    enableAltitudeMeters: 50_000,
    disableAltitudeMeters: 100_000,
    ...extra,
  };
}

// ── A. The rule's constants are the shader's ────────────────────────────────

test("A1 the budget's interval, deck and cone constants are read out of the march shader", () => {
  const wgsl = readSource(CLOUDS_WGSL);
  assert.match(wgsl, /let maxIter: i32 = steps \* 3;/);
  assert.equal(live.CLOUD_MARCH_INTERVALS_PER_STEP, 3);
  assert.match(
    wgsl,
    /for \(var k: i32 = 0; k < 3; k = k \+ 1\) \{\n\s*if \(trans < 0\.005\) \{ break; \}[^\n]*\n\s*let di = order\[k\];\n\s*let r = marchDeck\(/,
  );
  assert.equal(live.CLOUD_MULTI_DECK_MARCHES, 3);
  assert.match(wgsl, /Six taps, five full and one cheap/);
  assert.equal(live.CLOUD_LIGHT_CONE_TAPS, 6);
  assert.match(
    wgsl,
    /let steps = max\(1, i32\(cloud\.lightSteps \* cloud\.lightSampleScale\)\);/,
  );
  assert.equal(live.CLOUD_MARCH_BUDGET_DEFAULT, BUDGET);
  assert.equal(live.CLOUD_MARCH_LIVE_NOISE_WEIGHT, LIVE_WEIGHT);
  assert.equal(live.CLOUD_MARCH_REFERENCE_PIXELS, REFERENCE_PIXELS);
  assert.equal(live.CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS, FITTED_CEILING);
  // The mask pass is a second march: its entry calls the same deck march on
  // the same step count, so the budget costs it as one.
  const maskEntry = wgsl.slice(wgsl.indexOf("fn fragmentCloudMaskMain("));
  assert.match(
    maskEntry.slice(0, maskEntry.indexOf("\n}\n")),
    /let r = marchDeck\(/,
  );
});

// ── B. The measured points fall on their sides ──────────────────────────────

/**
 * @param {object} mod The preset module under test (live or a mutant).
 */
function assertMeasuredPoints(mod) {
  const row = mod.CLOUD_TIER_PRESETS[3];
  const rig = { viewportPixels: RIG_PIXELS, bakedNoiseResident: true };

  // Completed: the cinematic tier, baked, and its jitter-off twin.
  for (const [label, override] of [
    ["96 x 8 baked", undefined],
    ["96 x 8 baked, jitter cleared", { qualityFlagsClear: 8 }],
  ]) {
    const inputs = inputsFor("high", { ...rig, realizationOverride: override });
    const preset = mod.resolveCloudPreset(inputs);
    const report = mod.describeCloudMarchBudget(inputs, preset);
    assert.equal(serialize(preset), serialize(row), `${label}: the tier row`);
    assert.equal(serialize(report.asked), serialize(preset), label);
    assert.equal(report.budgetApplied, false, label);
    assert.equal(report.cost, specCost(preset, inputs), label);
    assert.ok(BUDGET / report.cost >= 1.39, `${label}: inside with margin`);
  }

  // Hung: the same frame with live noise. Budgeted, ask reported, nothing but
  // the step counts moved.
  const r2 = inputsFor("high", {
    ...rig,
    realizationOverride: { qualityFlagsClear: 1 },
  });
  const r2Preset = mod.resolveCloudPreset(r2);
  const r2Report = mod.describeCloudMarchBudget(r2, r2Preset);
  assert.equal(r2Report.budgetApplied, true, "live-noise 96 x 8: budgeted");
  assert.equal(r2Report.asked.primarySteps, 96, "the ask is reported");
  assert.equal(r2Report.asked.lightSteps, 8);
  assert.equal(r2Preset.primarySteps, 67, "primary steps reduced");
  assert.equal(r2Preset.lightSteps, 8, "light steps kept");
  assert.deepEqual(withoutSteps(r2Preset), withoutSteps(row));
  assert.equal(r2Report.requestedCost, 4194304 * 288 * 8 * 2);
  assert.ok(r2Report.requestedCost / BUDGET >= 1.39, "outside with margin");
  assert.ok(specCost(r2Preset, r2) <= BUDGET);
  const r2Realization = mod.resolveCloudRealization(
    r2Report.asked,
    12601,
    r2.realizationOverride,
    true,
  );
  assert.equal(r2Realization.requestedPrimarySteps, 96);
  assert.equal(r2Realization.qualityFlags, 12600, "bit 0 still cleared");

  // Hung: raw 256 at the rig. The bake is irrelevant to the escape hatch.
  const raw256 = inputsFor("high", {
    viewportPixels: RIG_PIXELS,
    rawCloudQuality: 256,
  });
  const raw256Preset = mod.resolveCloudPreset(raw256);
  const raw256Report = mod.describeCloudMarchBudget(raw256, raw256Preset);
  assert.equal(raw256Report.budgetApplied, true, "raw 256: budgeted");
  assert.equal(raw256Report.asked.primarySteps, 256);
  assert.equal(raw256Report.asked.lightSteps, 12);
  assert.equal(raw256Preset.primarySteps, 44);
  assert.equal(raw256Preset.lightSteps, 12);
  assert.ok(raw256Report.requestedCost / BUDGET >= 1.39);

  // Raw 128 completed at the rig; the one-weight rule cannot separate it from
  // the live 96 x 8 that hung, so it is budgeted on the conservative side.
  const raw128 = inputsFor("high", {
    viewportPixels: RIG_PIXELS,
    rawCloudQuality: 128,
  });
  const raw128Preset = mod.resolveCloudPreset(raw128);
  assert.equal(
    mod.describeCloudMarchBudget(raw128, raw128Preset).budgetApplied,
    true,
  );
  assert.equal(raw128Preset.primarySteps, 67);
  // At the reference viewport it is inside.
  const raw128Ref = inputsFor("high", { rawCloudQuality: 128 });
  assert.equal(
    mod.resolveCloudPreset(raw128Ref).primarySteps,
    128,
    "raw 128 at 1080p runs as asked",
  );

  // Hung: 384 steps at 1080p. The public dial that asked for it baked is not
  // in this tree, so the baked point is placed by the rule, and raw 384 by the
  // resolver.
  const baked384 = specCost(
    { ...row, primarySteps: 384 },
    { viewportPixels: REFERENCE_PIXELS, bakedNoiseResident: true },
  );
  assert.ok(baked384 / BUDGET >= 1.39, "baked 384 at 1080p outside");
  // The same ask marched at 960 × 540 counts inside: the budget bounds only
  // the intervals the base march law takes, so a march law with more
  // intervals per step must be counted by that law's own sentinel.
  const halfRes384 = specCost(
    { ...row, primarySteps: 384 },
    { viewportPixels: 960 * 540, bakedNoiseResident: true },
  );
  assert.ok(halfRes384 < BUDGET, "baked 384 at 960 x 540 counts inside");
  const raw384 = inputsFor("high", { rawCloudQuality: 384 });
  assert.equal(
    mod.describeCloudMarchBudget(raw384, mod.resolveCloudPreset(raw384))
      .budgetApplied,
    true,
  );
}

test("B1 the measured completions resolve untouched and the measured hangs resolve budgeted, with margin", () => {
  assertMeasuredPoints(live);
});

// ── C. Every input path, swept ──────────────────────────────────────────────

const VIEWPORTS = [
  undefined,
  1280 * 720,
  1920 * 1080,
  2048 * 2048,
  2560 * 1440,
  3840 * 2160,
];

function* sweepInputs(mod) {
  const presets = ["low", "medium", "high", "auto"];
  const heights = [0, 75_000, ORBITAL_HEIGHT];
  const raws = [
    undefined,
    32,
    48,
    64,
    65,
    76.999999,
    96,
    128,
    221.999999,
    256,
    384,
    512,
    1e6,
    NaN,
    Infinity,
  ];
  const aerialModes = [undefined, "auto", "heuristic", "physical"];
  const passes = [
    {},
    { transmittanceMaskPass: true },
    { fullResolutionFallback: true },
  ];
  for (const preset of presets) {
    for (const height of heights) {
      for (const raw of raws) {
        for (const aerial of aerialModes) {
          const base = mod.buildCloudQualityInputs(
            {
              cloudVolumetricQuality: preset,
              cloudQuality: raw,
              cloudAerialMode: aerial,
            },
            height,
          );
          for (const viewportPixels of VIEWPORTS) {
            for (const bakedNoiseResident of [true, false, undefined]) {
              for (const multiDeck of [false, true]) {
                for (const pass of passes) {
                  yield {
                    ...base,
                    viewportPixels,
                    bakedNoiseResident,
                    multiDeck,
                    ...pass,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

/**
 * @param {object} mod The preset module under test.
 * @param {object} pre The pre-budget preset module, or a stand-in.
 * @returns {{inside: number, outside: number}}
 */
function assertSweep(mod, pre) {
  let inside = 0;
  let outside = 0;
  for (const inputs of sweepInputs(mod)) {
    const label = JSON.stringify(inputs);
    const tip = pre.resolveCloudPreset(inputs);
    const preset = mod.resolveCloudPreset(inputs);
    const report = mod.describeCloudMarchBudget(inputs, preset);
    const askedCost = specCost(tip, inputs);
    assert.equal(serialize(report.asked), serialize(tip), `${label}: the ask`);
    assert.ok(Object.is(report.requestedCost, askedCost), `${label}: ask cost`);
    assert.equal(report.budget, BUDGET, label);
    assert.ok(Object.is(report.cost, specCost(preset, inputs)), label);
    assert.ok(specCost(preset, inputs) <= BUDGET, `${label}: over budget`);
    if (askedCost <= BUDGET) {
      inside++;
      assert.equal(serialize(preset), serialize(tip), `${label}: identical`);
      assert.equal(report.budgetApplied, false, label);
      const raw = inputs.rawCloudQuality;
      if (!(typeof raw === "number" && raw !== 64)) {
        assert.equal(preset, mod.CLOUD_TIER_PRESETS[preset.tier], label);
      }
      continue;
    }
    outside++;
    assert.equal(report.budgetApplied, true, label);
    assert.deepEqual(withoutSteps(preset), withoutSteps(tip), label);
    assert.ok(Number.isInteger(preset.primarySteps), label);
    assert.ok(preset.primarySteps >= 1, label);
    assert.ok(preset.primarySteps <= FITTED_CEILING, `${label}: ceiling`);
    // An unbounded count, as the shader reads it, resolves to the floor.
    const unbounded = (n) => !Number.isFinite(f32(n));
    const askedCount = unbounded(tip.primarySteps)
      ? 1
      : Math.trunc(f32(tip.primarySteps));
    const askedLight = unbounded(tip.lightSteps) ? 1 : tip.lightSteps;
    assert.ok(
      !(preset.primarySteps > askedCount),
      `${label}: primary steps raised`,
    );
    assert.ok(
      !(preset.lightSteps > askedLight),
      `${label}: light steps raised`,
    );
    if (!Object.is(preset.lightSteps, askedLight)) {
      assert.equal(preset.primarySteps, 1, `${label}: primary steps first`);
    } else if (
      preset.primarySteps < askedCount &&
      preset.primarySteps < FITTED_CEILING
    ) {
      // Reduced no further than the budget needs.
      assert.ok(
        specCost({ ...preset, primarySteps: preset.primarySteps + 1 }, inputs) >
          BUDGET,
        `${label}: reduced more than the budget needs`,
      );
    }
  }
  return { inside, outside };
}

test("C1 every input path resolves inside the budget; an ask inside it is byte-identical to the pre-budget resolver", async (t) => {
  const source = preBudgetSource();
  if (source === null) {
    t.skip(`commit ${PRE_BUDGET_COMMIT} is not in this clone`);
    return;
  }
  assert.equal(source.includes("describeCloudMarchBudget"), false);
  await withModule(source, (pre) => {
    const { inside, outside } = assertSweep(live, pre);
    t.diagnostic(`inside ${inside}, outside ${outside}`);
    assert.ok(inside > 20_000, "the sweep reaches the inside");
    assert.ok(outside > 20_000, "the sweep reaches the outside");
  });
});

// ── D. The default rows are never budgeted ──────────────────────────────────

/**
 * @param {object} mod The preset module under test.
 */
function assertDefaultRows(mod) {
  const measured = [
    undefined,
    1280 * 720,
    1920 * 1080,
    2560 * 1440,
    RIG_PIXELS,
  ];
  for (const preset of ["low", "medium", "high", "auto", undefined]) {
    for (const height of [0, 49_999, 75_000, 100_000, ORBITAL_HEIGHT]) {
      for (const viewportPixels of measured) {
        const inputs = inputsFor(preset, {
          rawCloudQuality: undefined,
          cameraHeightMeters: height,
          viewportPixels,
          bakedNoiseResident: true,
        });
        const resolved = mod.resolveCloudPreset(inputs);
        const report = mod.describeCloudMarchBudget(inputs, resolved);
        const label = `${preset} @ ${height} m, ${viewportPixels} px`;
        assert.equal(report.budgetApplied, false, label);
        assert.equal(resolved, mod.CLOUD_TIER_PRESETS[resolved.tier], label);
      }
    }
  }
  // A frame whose bake is absent marches live noise. Up to 1080p the tier
  // rows still fit; at the measured 2048² the cinematic row is the live-noise
  // march that hung, and it is budgeted.
  const unbaked = (viewportPixels) =>
    inputsFor("high", { viewportPixels, bakedNoiseResident: false });
  for (const viewportPixels of [undefined, 1280 * 720, 1920 * 1080]) {
    const inputs = unbaked(viewportPixels);
    assert.equal(
      mod.describeCloudMarchBudget(inputs, mod.resolveCloudPreset(inputs))
        .budgetApplied,
      false,
      `unbaked tier 3 @ ${viewportPixels}`,
    );
  }
  const unbakedRig = unbaked(RIG_PIXELS);
  assert.equal(
    mod.describeCloudMarchBudget(unbakedRig, mod.resolveCloudPreset(unbakedRig))
      .budgetApplied,
    true,
  );
}

test("D1 no default tier row is budgeted at the viewports the tiers meet on the measured device", () => {
  assertDefaultRows(live);
});

// The largest canvas on which the cinematic row's baked march fits:
// floor(budget / (3 × 96 intervals × 8 taps)).
const BAKED_TIER3_MAX_PIXELS = 5_859_375;

test("D2 above 5,859,375 canvas pixels the default cinematic row is budgeted; the range the default-row claim holds in is pinned", () => {
  const row = live.CLOUD_TIER_PRESETS[3];
  assert.equal(
    Math.floor(BUDGET / (3 * row.primarySteps * row.lightSteps)),
    BAKED_TIER3_MAX_PIXELS,
  );
  const cases = [
    [BAKED_TIER3_MAX_PIXELS, 96, false],
    [BAKED_TIER3_MAX_PIXELS + 1, 95, true],
    [2560 * 1440, 96, false],
    [3440 * 1440, 96, false],
    [3024 * 1964, 94, true],
    [3840 * 2160, 67, true],
    [5120 * 2880, 38, true],
  ];
  // The "high" dial, the default "auto" dial at or below 50 km, and no dial.
  for (const [preset, height] of [
    ["high", ORBITAL_HEIGHT],
    ["auto", 0],
    ["auto", 50_000],
    [undefined, 0],
  ]) {
    for (const [viewportPixels, steps, applied] of cases) {
      const inputs = inputsFor(preset, {
        rawCloudQuality: undefined,
        cameraHeightMeters: height,
        viewportPixels,
        bakedNoiseResident: true,
      });
      const resolved = live.resolveCloudPreset(inputs);
      const report = live.describeCloudMarchBudget(inputs, resolved);
      const label = `${preset} @ ${height} m, ${viewportPixels} px`;
      assert.equal(resolved.tier, 3, label);
      assert.equal(resolved.primarySteps, steps, label);
      assert.equal(resolved.lightSteps, 8, label);
      assert.equal(report.budgetApplied, applied, label);
      assert.equal(report.asked, row, `${label}: the ask is the tier row`);
    }
  }
  // Tiers 1 and 2 march at half resolution on the cone and fit at 5K.
  for (const preset of ["low", "medium"]) {
    const inputs = inputsFor(preset, {
      rawCloudQuality: undefined,
      viewportPixels: 5120 * 2880,
      bakedNoiseResident: true,
    });
    const resolved = live.resolveCloudPreset(inputs);
    assert.equal(resolved, live.CLOUD_TIER_PRESETS[resolved.tier], preset);
  }
});

// ── E. The override and the interval law ────────────────────────────────────

test("E1 the override's flag half moves the costed noise source and light march as it moves the frame", () => {
  const rig = { viewportPixels: RIG_PIXELS, bakedNoiseResident: true };
  const cost = (override) => {
    const inputs = inputsFor("high", { ...rig, realizationOverride: override });
    return live.cloudMarchCost(live.CLOUD_TIER_PRESETS[3], inputs);
  };
  const base = cost(undefined);
  assert.equal(base, 4194304 * 288 * 8);
  assert.equal(cost({ qualityFlagsClear: 1 }), base * 2, "bit 0 cleared: live");
  assert.equal(cost({ qualityFlagsClear: 8 }), base, "jitter is not costed");
  assert.equal(cost({ qualityFlagsSet: 1 << 10 }), base * (6 / 8), "cone");
  // Setting bit 0 without the bake is refused on the frame, so it is not
  // costed as baked either.
  const escape = inputsFor("high", {
    viewportPixels: RIG_PIXELS,
    rawCloudQuality: 96,
    bakedNoiseResident: false,
    realizationOverride: { qualityFlagsSet: 1 },
  });
  const escapeReport = live.describeCloudMarchBudget(
    escape,
    live.resolveCloudPreset(escape),
  );
  assert.equal(escapeReport.requestedCost, 4194304 * 288 * 7 * 2);
  // With the bake resident the same set is honoured and costed as baked.
  const escapeBaked = { ...escape, bakedNoiseResident: true };
  assert.equal(
    live.cloudMarchCost(escapeReport.asked, escapeBaked),
    4194304 * 288 * 7,
  );
  // The override's own caps are not the budget: 128 x 8 live at the rig is
  // inside the caps and outside the budget.
  const capped = inputsFor("high", {
    ...rig,
    realizationOverride: {
      primarySteps: 128,
      lightSteps: 8,
      qualityFlagsClear: 1,
    },
  });
  const cappedPreset = live.resolveCloudPreset(capped);
  const cappedReport = live.describeCloudMarchBudget(capped, cappedPreset);
  assert.equal(cappedReport.budgetApplied, true);
  assert.equal(cappedReport.asked.primarySteps, 128);
  assert.equal(cappedPreset.primarySteps, 67);
});

test("E2 the interval law: three intervals per step, one march per deck, none for a non-positive count", () => {
  assert.equal(live.cloudMarchIntervals(96, false), 288);
  assert.equal(live.cloudMarchIntervals(96, true), 864);
  assert.equal(live.cloudMarchIntervals(63.5, false), 189);
  assert.equal(live.cloudMarchIntervals(0, false), 0);
  assert.equal(live.cloudMarchIntervals(-5, true), 0);
  assert.equal(live.cloudMarchIntervals(NaN, false), Infinity);
  assert.equal(live.cloudMarchIntervals(Infinity, false), Infinity);
  // The multi-deck march runs three shells on the full step count each.
  const inputs = inputsFor("high", {
    viewportPixels: 1920 * 1080,
    bakedNoiseResident: true,
    multiDeck: true,
  });
  const preset = live.resolveCloudPreset(inputs);
  const report = live.describeCloudMarchBudget(inputs, preset);
  assert.equal(report.requestedCost, 1920 * 1080 * 864 * 8);
  assert.equal(report.budgetApplied, true, "tier 3 multi-deck at 1080p");
  assert.equal(preset.primarySteps, 90);
});

test("E3 the per-device budget input scales the result, and a meaningless one falls back to the default", () => {
  const inputs = (marchBudget) =>
    inputsFor("high", {
      viewportPixels: RIG_PIXELS,
      bakedNoiseResident: true,
      marchBudget,
    });
  const half = inputs(BUDGET / 2);
  const halfPreset = live.resolveCloudPreset(half);
  assert.equal(halfPreset.primarySteps, 67);
  assert.equal(
    live.describeCloudMarchBudget(half, halfPreset).budget,
    BUDGET / 2,
  );
  for (const meaningless of [undefined, NaN, 0, -1, Infinity]) {
    const i = inputs(meaningless);
    assert.equal(live.resolveCloudPreset(i), live.CLOUD_TIER_PRESETS[3]);
    assert.equal(
      live.describeCloudMarchBudget(i, live.resolveCloudPreset(i)).budget,
      BUDGET,
    );
  }
});

/**
 * A fraction just under an integer uploads as that integer, so the shader runs
 * one step more than the f64 count says.
 *
 * @param {object} mod The preset module under test.
 */
function assertF32Counts(mod) {
  for (const [raw, viewportPixels] of [
    [76.999999, RIG_PIXELS],
    [221.999999, 1280 * 720],
  ]) {
    const inputs = inputsFor("high", { rawCloudQuality: raw, viewportPixels });
    const resolved = mod.resolveCloudPreset(inputs);
    const report = mod.describeCloudMarchBudget(inputs, resolved);
    const label = `raw ${raw} @ ${viewportPixels} px`;
    assert.equal(Math.trunc(f32(raw)), Math.ceil(raw), `${label}: fixture`);
    assert.equal(report.budgetApplied, true, label);
    assert.ok(specCost(resolved, inputs) <= BUDGET, `${label}: as it runs`);
    assert.equal(report.requestedCost, specCost(report.asked, inputs), label);
  }
  assert.equal(mod.cloudMarchIntervals(76.999999, false), 3 * 77);
}

test("E4 counts are costed as the shader reads them after the f32 upload", () => {
  assertF32Counts(live);
});

/**
 * @param {object} mod The preset module under test.
 */
function assertFullResolutionFallback(mod) {
  // Tier 2 marches a quarter of the pixels; when that target cannot allocate
  // it marches all of them.
  const ask = (fullResolutionFallback) =>
    inputsFor("medium", {
      viewportPixels: RIG_PIXELS,
      bakedNoiseResident: true,
      fullResolutionFallback,
      realizationOverride: { primarySteps: 128, qualityFlagsClear: 1 },
    });
  const reduced = ask(undefined);
  const reducedPreset = mod.resolveCloudPreset(reduced);
  assert.equal(
    mod.describeCloudMarchBudget(reduced, reducedPreset).budgetApplied,
    false,
    "a quarter of the canvas fits",
  );
  const fallback = ask(true);
  const fallbackPreset = mod.applyCloudMarchBudget(reducedPreset, fallback);
  assert.ok(fallbackPreset.primarySteps < 128, "the whole canvas does not");
  assert.ok(specCost(fallbackPreset, fallback) <= BUDGET);
  assert.equal(fallbackPreset.renderResScale, reducedPreset.renderResScale);
  assert.equal(
    serialize(fallbackPreset),
    serialize(mod.resolveCloudPreset(fallback)),
    "applying the budget again equals resolving with the fallback",
  );
  assert.equal(
    mod.describeCloudMarchBudget(fallback, fallbackPreset).budgetApplied,
    true,
  );
  // The default medium dial on a 4K canvas with the bake absent.
  const medium4k = inputsFor("medium", {
    rawCloudQuality: undefined,
    viewportPixels: 3840 * 2160,
    bakedNoiseResident: false,
    fullResolutionFallback: true,
  });
  const medium4kPreset = mod.resolveCloudPreset(medium4k);
  assert.equal(
    mod.describeCloudMarchBudget(medium4k, medium4kPreset).budgetApplied,
    true,
  );
  assert.ok(specCost(medium4kPreset, medium4k) <= BUDGET);
}

test("E5 a reduced-resolution tier whose target falls back to the whole canvas is costed at the whole canvas", () => {
  assertFullResolutionFallback(live);
});

/**
 * @param {object} mod The preset module under test.
 */
function assertMaskPass(mod) {
  const at = (viewportPixels, transmittanceMaskPass) =>
    inputsFor("high", {
      viewportPixels,
      bakedNoiseResident: true,
      transmittanceMaskPass,
    });
  const row = mod.CLOUD_TIER_PRESETS[3];
  const rig = at(RIG_PIXELS, true);
  const rigPreset = mod.resolveCloudPreset(rig);
  const rigReport = mod.describeCloudMarchBudget(rig, rigPreset);
  assert.equal(rigReport.requestedCost, 2 * 4194304 * 288 * 8);
  assert.equal(rigReport.budgetApplied, true, "the mask doubles the march");
  assert.equal(rigPreset.primarySteps, 67);
  assert.equal(mod.resolveCloudPreset(at(RIG_PIXELS, false)), row);
  assert.equal(mod.resolveCloudPreset(at(1920 * 1080, true)), row, "1080p");
}

test("E6 the transmittance-mask pass is costed as a second full-resolution march", () => {
  assertMaskPass(live);
});

/**
 * @param {object} mod The preset module under test.
 */
function assertFittedCeiling(mod) {
  // An override that asks for one light step cannot trade it for more primary
  // steps than any frame has been measured to finish.
  const fewTaps = inputsFor("high", {
    viewportPixels: RIG_PIXELS,
    rawCloudQuality: 1e6,
    realizationOverride: { lightSteps: 1 },
  });
  const fewTapsPreset = mod.resolveCloudPreset(fewTaps);
  assert.equal(fewTapsPreset.primarySteps, FITTED_CEILING);
  assert.equal(fewTapsPreset.lightSteps, 1);
  assert.equal(
    mod.describeCloudMarchBudget(fewTaps, fewTapsPreset).budgetApplied,
    true,
  );
  // Raw 256 on a 720p canvas.
  const raw256 = inputsFor("high", {
    viewportPixels: 1280 * 720,
    rawCloudQuality: 256,
  });
  const raw256Preset = mod.resolveCloudPreset(raw256);
  assert.equal(raw256Preset.primarySteps, FITTED_CEILING);
  assert.equal(raw256Preset.lightSteps, 12);
  // An ask inside the budget is not held to the ceiling.
  const raw200 = inputsFor("high", {
    viewportPixels: 1280 * 720,
    rawCloudQuality: 200,
  });
  assert.equal(mod.resolveCloudPreset(raw200).primarySteps, 200);
}

test("E7 a budgeted frame runs no more than the fitted step ceiling", () => {
  assertFittedCeiling(live);
});

test("E8 a count with no finite bound resolves to the floor of one step", () => {
  for (const raw of [NaN, Infinity]) {
    const inputs = inputsFor("high", { rawCloudQuality: raw });
    const resolved = live.resolveCloudPreset(inputs);
    assert.equal(resolved.primarySteps, 1, `raw ${raw}`);
    assert.equal(resolved.lightSteps, 1, `raw ${raw}`);
    assert.equal(
      live.describeCloudMarchBudget(inputs, resolved).budgetApplied,
      true,
    );
  }
  // A bounded primary ask with an unbounded light count keeps its primary
  // steps and takes the light floor.
  const inputs = inputsFor("high", {
    rawCloudQuality: -1,
    realizationOverride: { primarySteps: 96 },
  });
  const resolved = live.resolveCloudPreset(inputs);
  assert.ok(
    Number.isNaN(
      live.describeCloudMarchBudget(inputs, resolved).asked.lightSteps,
    ),
  );
  assert.equal(resolved.primarySteps, 96);
  assert.equal(resolved.lightSteps, 1);
});

// ── F. Release and renderer ─────────────────────────────────────────────────

test("F1 after the release pragma strip the budget still holds raw cloudQuality, and the override is inert", async () => {
  const build = await import(
    pathToFileURL(path.join(root, "scripts", "build.js")).href
  );
  assert.equal(build.pragmas.debug, false, "fixture: release strips debug");
  const stripped = presetsSource.replace(
    build.constructRegex("debug", build.pragmas.debug),
    "",
  );
  assert.equal(stripped.includes("includeStart('debug'"), false);
  assert.ok(stripped.includes("if (overBudget) {"), "the gate survives");
  await withModule(stripped, (released) => {
    const raw256 = inputsFor("high", {
      viewportPixels: RIG_PIXELS,
      rawCloudQuality: 256,
    });
    assert.equal(released.resolveCloudPreset(raw256).primarySteps, 44);
    // The live-noise override is gone, so the baked row fits and is returned.
    const r2 = inputsFor("high", {
      viewportPixels: RIG_PIXELS,
      bakedNoiseResident: true,
      realizationOverride: { qualityFlagsClear: 1, primarySteps: 128 },
    });
    assert.equal(
      released.resolveCloudPreset(r2),
      released.CLOUD_TIER_PRESETS[3],
    );
  });
});

/** Lines of the frame-prepare function, trimmed. */
function prepareLines(source) {
  const header = "export function prepareCloudFrameAndEncodeMask(";
  const start = source.indexOf(header);
  assert.ok(
    start >= 0,
    "prepareCloudFrameAndEncodeMask is not in the renderer",
  );
  const rest = source.slice(start + header.length);
  const end = rest.search(/\n(?:export )?function /);
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .map((line) => line.trim());
}

function onlyIndex(lines, text, what) {
  const found = [];
  lines.forEach((line, i) => {
    if (line === text) {
      found.push(i);
    }
  });
  assert.equal(found.length, 1, `${what}: expected exactly one "${text}"`);
  return found[0];
}

/**
 * @param {string} source Renderer source text (live or a mutant).
 */
function assertRendererWiring(source) {
  const lines = prepareLines(source);
  const resolved = onlyIndex(
    lines,
    "let cloudPreset = resolveCloudPreset(qualityInputs);",
    "the resolver call",
  );
  for (const handoff of [
    "qualityInputs.viewportPixels = canvasW * canvasH;",
    "qualityInputs.bakedNoiseResident = cache.noiseBaked && cache.noise !== null;",
    "qualityInputs.multiDeck = multiDeckOn;",
    "qualityInputs.transmittanceMaskPass = captureRequested;",
  ]) {
    const at = onlyIndex(lines, handoff, "a budget hand-off");
    assert.ok(at < resolved, `${handoff} precedes the resolver`);
    assert.ok(
      !lines[at - 1].startsWith("//>>includeStart"),
      `${handoff} is not debug-only`,
    );
  }
  const described = onlyIndex(
    lines,
    "let cloudMarchBudget = describeCloudMarchBudget(qualityInputs, cloudPreset);",
    "the budget report",
  );
  assert.ok(described === resolved + 1, "the report follows the resolver");
  // The half-resolution fallback applies the budget again to the same ask at
  // the whole canvas's cost, and re-describes it, before the quality block.
  const fellBack = onlyIndex(
    lines,
    "qualityInputs.fullResolutionFallback = true;",
    "the fallback hand-off",
  );
  assert.deepEqual(
    lines.slice(fellBack + 1, fellBack + 6),
    [
      "cloudPreset = applyCloudMarchBudget(",
      "cloudMarchBudget.asked,",
      "qualityInputs,",
      ");",
      "cloudMarchBudget = describeCloudMarchBudget(qualityInputs, cloudPreset);",
    ],
    "the fallback re-applies the budget to the ask",
  );
  const failed = lines.lastIndexOf("if (!allocated) {", fellBack);
  assert.ok(failed > described, "the fallback sits in the half-res gate");
  assert.ok(
    lines
      .slice(failed, fellBack)
      .some((l) => l.includes("falling back to full-res")),
    "inside the half-resolution failure branch",
  );
  const gateSettled = onlyIndex(
    lines,
    "halfResActive = allocated;",
    "the half-res gate",
  );
  assert.ok(fellBack < gateSettled, "the fallback is costed in the gate");
  const block = lines.findIndex((l) =>
    l.startsWith("const qualityBlock = buildCloudQualityBlock(cloudPreset,"),
  );
  assert.ok(block > gateSettled, "the quality block reads the costed preset");
  for (const counter of [
    "counters.primarySampleBudget =",
    "counters.budgetApplied = cloudMarchBudget.budgetApplied ? 1 : 0;",
    "counters.marchBudget = cloudMarchBudget.budget;",
    "counters.marchCost = cloudMarchBudget.cost;",
    "counters.requestedMarchCost = cloudMarchBudget.requestedCost;",
  ]) {
    onlyIndex(lines, counter, "a budget counter");
  }
  const intervals = lines.indexOf("counters.primarySampleBudget =");
  assert.equal(
    lines[intervals + 1],
    "counters.marchPixels *",
    "primarySampleBudget counts dispatched pixels",
  );
  assert.equal(
    lines[intervals + 2],
    "cloudMarchIntervals(qualityBlock.maxSteps, multiDeckOn);",
    "primarySampleBudget counts the real intervals",
  );
  const publish = lines.indexOf("publishCloudRealization(");
  assert.ok(publish > described, "the publish follows the report");
  const args = lines.slice(publish, lines.indexOf(");", publish));
  assert.ok(args.includes("cloudMarchBudget.asked,"), "the ask is published");
}

test("F2 the renderer hands the resolver the budget's inputs, publishes the report and counts the real intervals", () => {
  assertRendererWiring(readSource(RENDERER_TS));
});

test("F3 each renderer hand-off removed turns F2 red", () => {
  const renderer = readSource(RENDERER_TS);
  for (const anchor of [
    "    qualityInputs.viewportPixels = canvasW * canvasH;\n",
    "    qualityInputs.bakedNoiseResident = cache.noiseBaked && cache.noise !== null;\n",
    "    qualityInputs.multiDeck = multiDeckOn;\n",
    "    qualityInputs.transmittanceMaskPass = captureRequested;\n",
    "        qualityInputs.fullResolutionFallback = true;\n",
  ]) {
    const first = renderer.indexOf(anchor);
    assert.ok(first >= 0, `mutation anchor not found: ${anchor}`);
    assert.equal(renderer.indexOf(anchor, first + 1), -1, "anchor unique");
    const mutated =
      renderer.slice(0, first) + renderer.slice(first + anchor.length);
    assert.throws(() => assertRendererWiring(mutated), assert.AssertionError);
  }
});

test("F4 the observability block carries the budget beside the ask", () => {
  const source = readSource(OBSERVABILITY_TS);
  for (const field of [
    "budgetApplied",
    "marchBudget",
    "marchCost",
    "requestedMarchCost",
  ]) {
    assert.match(source, new RegExp(`\\n {2}${field}: number;\\n`), field);
    assert.match(source, new RegExp(`\\n {2}"${field}",\\n`), `${field} reset`);
    assert.match(source, new RegExp(`\\n {4}${field}: 0,\\n`), `${field} init`);
  }
  assert.match(source, /\n {6}budgetApplied: c\.budgetApplied === 1,\n/);
  assert.match(source, /\n {6}marchBudget: c\.marchBudget,\n/);
  assert.match(source, /\n {6}marchCost: c\.marchCost,\n/);
  assert.match(source, /\n {6}requestedMarchCost: c\.requestedMarchCost,\n/);
});

// ── G. Inertness mutants ────────────────────────────────────────────────────

async function assertMutantRed(anchor, replacement, check) {
  const first = presetsSource.indexOf(anchor);
  assert.ok(first >= 0, `mutation anchor not found: ${anchor}`);
  assert.equal(
    presetsSource.indexOf(anchor, first + 1),
    -1,
    `mutation anchor is not unique: ${anchor}`,
  );
  const mutated =
    presetsSource.slice(0, first) +
    replacement +
    presetsSource.slice(first + anchor.length);
  await withModule(mutated, (mutant) => {
    assert.throws(
      () => check(mutant),
      assert.AssertionError,
      `the mutant survived: ${replacement}`,
    );
  });
}

const GATE = "if (overBudget) {";
const WEIGHT = "const weight = baked ? 1 : CLOUD_MARCH_LIVE_NOISE_WEIGHT;";
const DECKS = "multiDeck === true ? CLOUD_MULTI_DECK_MARCHES : 1";

test("G1 the budget gate made unreachable turns B, C and D red", async (t) => {
  const unreachable = "if (false && overBudget) {";
  await assertMutantRed(GATE, unreachable, assertMeasuredPoints);
  await assertMutantRed(GATE, unreachable, assertDefaultRows);
  const source = preBudgetSource();
  if (source === null) {
    t.skip(`commit ${PRE_BUDGET_COMMIT} is not in this clone`);
    return;
  }
  await withModule(source, async (pre) => {
    await assertMutantRed(GATE, unreachable, (mutant) =>
      assertSweep(mutant, pre),
    );
  });
});

test("G2 the noise weight removed turns the live-noise hang red", async () => {
  await assertMutantRed(WEIGHT, "const weight = 1;", assertMeasuredPoints);
  await assertMutantRed(WEIGHT, "const weight = 1;", assertDefaultRows);
});

test("G3 the deck factor removed turns the multi-deck interval law red", async () => {
  await assertMutantRed(DECKS, "1", (mutant) => {
    assert.equal(mutant.cloudMarchIntervals(96, true), 864);
  });
});

test("G4 the f32 read made unreachable turns E4 red", async () => {
  await assertMutantRed(
    "const steps = Math.trunc(Math.fround(primarySteps));",
    "const steps = Math.trunc(false ? Math.fround(primarySteps) : primarySteps);",
    assertF32Counts,
  );
});

test("G5 the full-resolution fallback made unreachable turns E5 red", async () => {
  await assertMutantRed(
    "inputs.fullResolutionFallback !== true",
    "(true || inputs.fullResolutionFallback !== true)",
    assertFullResolutionFallback,
  );
});

test("G6 the mask pass made unreachable turns E6 red", async () => {
  await assertMutantRed(
    "inputs.transmittanceMaskPass === true ? pixels : 0",
    "false && inputs.transmittanceMaskPass === true ? pixels : 0",
    assertMaskPass,
  );
});

test("G7 the fitted step ceiling made unreachable turns E7 red", async () => {
  await assertMutantRed(
    "    CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS,\n",
    "    false ? CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS : Infinity,\n",
    assertFittedCeiling,
  );
});
