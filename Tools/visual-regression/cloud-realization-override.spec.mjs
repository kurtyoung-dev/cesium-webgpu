// cloud-realization-override.spec.mjs — the cloud march can be varied one
// realization axis at a time, and the frame reports what it was asked beside
// what it ran.
// @purpose Executes the pure cloud resolver and the renderer's realization publisher from Node to prove the debug realization override moves exactly the axis it names on the tier path (steps, or one qualityFlags bit) while the escape hatch cannot, that the resolver is byte-identical to its reference with no override, that the ask and the realised value differ exactly when a clamp, a restricted bit or an absent resource moved the ask, that a release strip leaves no working override, and that each of those properties goes red when the override is made unreachable.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// The only public way to change the cloud march's step count is
// `cloudQuality`, and any value other than 64 takes the escape hatch: it
// returns tier 1 with LIVE noise, jitter off and no planet density domain. The
// `qualityFlags` word moves from 12601 to 4400 — three bits at once — so a
// measurement that varies the step count through that dial also varies the
// noise source, the jitter and the density domain, and cannot attribute
// anything to any one of them. The realization override is the instrument
// that removes the confound; this file proves it does, by executing it.
//
// WHAT IS ASSERTED
// ----------------
//  A. STEPS ON THE TIER PATH. Tier 3 plus an override of 48 primary steps
//     resolves 48 steps with the tier-3 noise source, the tier-3 flag word and
//     every other tier-3 field. The escape hatch's 48 is the defect oracle: it
//     changes the noise source and the flag word, and the test requires that
//     contrast so it cannot pass against a resolver where both paths agree.
//  B. ONE BIT AT A TIME. On the tier-3 orbital word (12601, derived here from
//     the real block builder and the renderer's three folds), clearing exactly
//     JITTER, NOISE_BAKED, PLANET_DENSITY or the 0+13 pair changes exactly
//     those bits and no field of the preset.
//  C. INERT BY DEFAULT. With no override the resolver reproduces a reference
//     for all four tiers and the escape hatch over a wide input sweep, and a
//     `null` override is the same state as none. The reference is a
//     transcription of the resolver as it stood before the override existed;
//     when the repository still holds that commit, the module is also read out
//     of git and all three are required to agree. A later, deliberate change to
//     the no-override resolver (a step clamp, say) re-baselines the reference
//     and PRE_OVERRIDE_COMMIT in the same change.
//  D. ASKED VERSUS RAN. The report's `requested*` equal the ask, its realised
//     values equal what the resolver and the flag gate produced, and the two
//     differ in exactly the cases where a clamp, a restricted bit or an absent
//     baked resource moved the ask. No override raises the per-pixel
//     workload above the larger of the caps and what the dials resolved.
//  E. INERTNESS MUTANTS. Each gate made unreachable (`if (false && …)`) in a
//     copy of the module under `os.tmpdir()` turns the matching assertion red.
//  F. THE RENDERER'S SIDE. The publisher that writes float 74 and the counters
//     is a module-level helper, so it is lifted out of the renderer verbatim
//     and executed: each one-bit clear uploads the expected word and records
//     it beside the ask. The same helper and the resolver, after the release
//     build's own pragma strip, ignore any override. The three call-site facts
//     that only a device could exercise (the hand-off into the resolver
//     inputs, the publish after the last fold of float 74, and the one
//     `executeSerial` advance after the composite) are pinned by position,
//     and each pin and each executed check is shown to go red under its own
//     mutant.
//
// NOT ASSERTED HERE: that a device reaches those call sites on a real frame.
// An Edge row whose uploaded `qualityFlags` differs from its ask, or whose
// `executeSerial` did not advance, is void by rule.
//
// Run: node --test Tools/visual-regression/cloud-realization-override.spec.mjs

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
// The last commit whose resolver has no override. Read only when present, so a
// shallow clone still runs every other assertion.
const PRE_OVERRIDE_COMMIT = "37c0f8767ee2632255510dc27bb9de2bd433b8cd";

// Normalised to LF: a Windows checkout with autocrlf holds CRLF, and every
// anchor and extraction below is written against LF.
const readSource = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const presetsSource = readSource(PRESETS_TS);

// The preset module is import-free, which is what lets Node's type stripping
// load the `.ts` directly; an added relative import would break every
// execution below, so it is asserted rather than assumed.
assert.equal(
  /^\s*import\s/m.test(presetsSource),
  false,
  "WebGPUCloudTierPresets.ts must stay import-free so the seam is executable from Node",
);

const live = await import(pathToFileURL(path.join(root, PRESETS_TS)).href);

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORBITAL_HEIGHT = 6_608_000;

/** Resolver inputs for a named preset at an orbital camera. */
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

/** A full-resolution frame with the baked noise resident, as tier 3 runs. */
const FULL_RES_BAKED = Object.freeze({
  bakedNoiseResident: true,
  halfResActive: false,
  temporalActive: false,
  erosionStrengthOverride: undefined,
});

/**
 * The frame's final flag word: the block's bits plus the three renderer folds
 * an orbital default frame carries — high precision (on unless disabled), the
 * physical aerial LUT (the default above the band edge) and the planet domain
 * (set whenever bit 0 is).
 */
function orbitalWord(mod, preset, runtime = FULL_RES_BAKED) {
  const block = mod.buildCloudQualityBlock(preset, runtime);
  let word =
    block.qualityFlags | mod.CLOUD_QF_HIGH_PRECISION | mod.CLOUD_QF_AERIAL_LUT;
  if ((block.qualityFlags & mod.CLOUD_QF_NOISE_BAKED) !== 0) {
    word |= mod.CLOUD_QF_PLANET_DENSITY;
  }
  return word >>> 0;
}

/** Every field but the two step counts. */
function withoutSteps(preset) {
  const rest = { ...preset };
  delete rest.primarySteps;
  delete rest.lightSteps;
  return rest;
}

// ── A. Steps on the tier path ───────────────────────────────────────────────

/**
 * @param {object} mod The preset module under test (live or a mutant).
 */
function assertTierPathSteps(mod) {
  const tier3 = mod.resolveCloudPreset(inputsFor("high"));
  assert.equal(tier3.tier, 3, "fixture: 'high' resolves tier 3");
  assert.equal(tier3.primarySteps, 96, "fixture: tier 3 marches 96 steps");

  const overridden = mod.resolveCloudPreset(
    inputsFor("high", { realizationOverride: { primarySteps: 48 } }),
  );
  assert.equal(overridden.primarySteps, 48, "the override sets primarySteps");
  assert.equal(
    overridden.noiseSource,
    tier3.noiseSource,
    "the noise source stays the tier's",
  );
  assert.equal(overridden.lightSteps, tier3.lightSteps);
  assert.deepEqual(
    withoutSteps(overridden),
    withoutSteps(tier3),
    "no field other than the step count moves",
  );
  assert.equal(
    mod.buildCloudQualityBlock(overridden, FULL_RES_BAKED).qualityFlags,
    mod.buildCloudQualityBlock(tier3, FULL_RES_BAKED).qualityFlags,
    "the flag word is the un-overridden tier-3 word",
  );
  assert.equal(
    orbitalWord(mod, overridden),
    orbitalWord(mod, tier3),
    "the full orbital word is the un-overridden tier-3 word",
  );

  const lightOnly = mod.resolveCloudPreset(
    inputsFor("high", { realizationOverride: { lightSteps: 4 } }),
  );
  assert.equal(lightOnly.lightSteps, 4, "the override sets lightSteps");
  assert.equal(lightOnly.primarySteps, 96);
  assert.deepEqual(withoutSteps(lightOnly), withoutSteps(tier3));
}

test("A1 tier 3 + primarySteps 48 keeps the tier path; the escape hatch's 48 does not", () => {
  assertTierPathSteps(live);

  // The defect oracle: the only public way to reach 48 changes the noise
  // source and the flag word. Were these equal, A1 would be proving nothing.
  const tier3 = live.resolveCloudPreset(inputsFor("high"));
  const escape = live.resolveCloudPreset(
    inputsFor("high", { rawCloudQuality: 48 }),
  );
  assert.equal(escape.primarySteps, 48);
  assert.equal(escape.noiseSource, live.CloudNoiseSource.LIVE);
  assert.notEqual(escape.noiseSource, tier3.noiseSource);
  assert.notEqual(orbitalWord(live, escape), orbitalWord(live, tier3));
});

test("A2 the step override reaches every tier and the escape hatch, late", () => {
  for (const preset of ["low", "medium", "high"]) {
    const base = live.resolveCloudPreset(inputsFor(preset));
    const moved = live.resolveCloudPreset(
      inputsFor(preset, { realizationOverride: { primarySteps: 40 } }),
    );
    assert.equal(moved.primarySteps, 40, `${preset}: steps follow the ask`);
    assert.deepEqual(withoutSteps(moved), withoutSteps(base), preset);
  }
  const escapeBase = live.resolveCloudPreset(
    inputsFor("high", { rawCloudQuality: 32 }),
  );
  const escapeMoved = live.resolveCloudPreset(
    inputsFor("high", {
      rawCloudQuality: 32,
      realizationOverride: { primarySteps: 40 },
    }),
  );
  assert.equal(escapeMoved.primarySteps, 40);
  assert.deepEqual(withoutSteps(escapeMoved), withoutSteps(escapeBase));
  // The table is not mutated by an override.
  assert.equal(live.CLOUD_TIER_PRESETS[3].primarySteps, 96);
});

// ── B. One bit at a time ────────────────────────────────────────────────────

const SINGLE_BIT_CASES = [
  ["JITTER", (m) => m.CLOUD_QF_JITTER],
  ["NOISE_BAKED", (m) => m.CLOUD_QF_NOISE_BAKED],
  ["PLANET_DENSITY", (m) => m.CLOUD_QF_PLANET_DENSITY],
  [
    "NOISE_BAKED+PLANET_DENSITY",
    (m) => m.CLOUD_QF_NOISE_BAKED | m.CLOUD_QF_PLANET_DENSITY,
  ],
];

/**
 * @param {object} mod The preset module under test (live or a mutant).
 */
function assertSingleBitClears(mod) {
  const tier3 = mod.resolveCloudPreset(inputsFor("high"));
  const word = orbitalWord(mod, tier3);
  assert.equal(word, 12601, "fixture: the tier-3 orbital word is 12601");
  for (const [name, maskOf] of SINGLE_BIT_CASES) {
    const mask = maskOf(mod);
    const override = { qualityFlagsClear: mask };
    const preset = mod.resolveCloudPreset(
      inputsFor("high", { realizationOverride: override }),
    );
    assert.deepEqual(preset, tier3, `${name}: no preset field moves`);
    const report = mod.resolveCloudRealization(preset, word, override, true);
    assert.equal(
      (report.qualityFlags ^ word) >>> 0,
      mask,
      `${name}: exactly the named bits changed`,
    );
    assert.equal(report.qualityFlags & mask, 0, `${name}: the bits are clear`);
    assert.equal(report.primarySteps, 96, name);
    assert.equal(report.lightSteps, 8, name);
    assert.equal(report.requestedQualityFlags, report.qualityFlags, name);
  }
}

test("B1 clearing one bit (or the 0+13 pair) changes that bit and nothing else", () => {
  assertSingleBitClears(live);
});

test("B2 the tier path at 96 steps with one bit cleared is reachable; the escape hatch reads 4400", () => {
  const escape = live.resolveCloudPreset(
    inputsFor("high", { rawCloudQuality: 96 }),
  );
  assert.equal(orbitalWord(live, escape), 4400);
  // The escape word differs from the tier word in exactly bits 0, 3 and 13;
  // the override reaches each of those states without leaving the tier path.
  const tier3 = live.resolveCloudPreset(inputsFor("high"));
  assert.equal(
    (orbitalWord(live, tier3) ^ 4400) >>> 0,
    live.CLOUD_QF_NOISE_BAKED |
      live.CLOUD_QF_JITTER |
      live.CLOUD_QF_PLANET_DENSITY,
  );
});

// ── C. Inert by default ─────────────────────────────────────────────────────

// The resolver as it stood before the override, transcribed with its own copy
// of the table so a table edit in the live module cannot move the reference.
const REFERENCE_ROW_TAIL = {
  powderStrength: 0.5,
  isotropicFloor: 0,
  ambientFloor: 0,
  curlAmplitude: 0,
};
const REFERENCE_TABLE = [
  {
    tier: 0,
    primarySteps: 0,
    lightSteps: 0,
    noiseSource: 0,
    renderResScale: 1.0,
    temporalEnabled: false,
    temporalUpdateFraction: 0,
    jitterEnabled: false,
    lightSampleScale: 1.0,
    lightConeSampling: false,
    multiScatterOctaves: 0,
    ...REFERENCE_ROW_TAIL,
  },
  {
    tier: 1,
    primarySteps: 24,
    lightSteps: 3,
    noiseSource: 1,
    renderResScale: 0.5,
    temporalEnabled: true,
    temporalUpdateFraction: 1 / 16,
    jitterEnabled: true,
    lightSampleScale: 0.5,
    lightConeSampling: true,
    multiScatterOctaves: 2,
    ...REFERENCE_ROW_TAIL,
  },
  {
    tier: 2,
    primarySteps: 48,
    lightSteps: 4,
    noiseSource: 1,
    renderResScale: 0.5,
    temporalEnabled: true,
    temporalUpdateFraction: 1 / 8,
    jitterEnabled: true,
    lightSampleScale: 0.5,
    lightConeSampling: true,
    multiScatterOctaves: 3,
    ...REFERENCE_ROW_TAIL,
  },
  {
    tier: 3,
    primarySteps: 96,
    lightSteps: 8,
    noiseSource: 1,
    renderResScale: 1.0,
    temporalEnabled: false,
    temporalUpdateFraction: 0,
    jitterEnabled: true,
    lightSampleScale: 1.0,
    lightConeSampling: false,
    multiScatterOctaves: 3,
    ...REFERENCE_ROW_TAIL,
  },
];

function referenceResolve(inputs) {
  const raw = inputs.rawCloudQuality;
  if (typeof raw === "number" && raw !== 64) {
    return {
      tier: 1,
      primarySteps: raw,
      lightSteps: Math.max(2, Math.round(6 * Math.sqrt(raw / 64))),
      noiseSource: 0,
      renderResScale: 1.0,
      temporalEnabled: false,
      temporalUpdateFraction: 0,
      jitterEnabled: false,
      lightSampleScale: 1.0,
      lightConeSampling: false,
      multiScatterOctaves: 3,
      ...REFERENCE_ROW_TAIL,
    };
  }
  const preset = inputs.preset ?? "auto";
  let tier;
  if (preset === "low") {
    tier = 1;
  } else if (preset === "medium") {
    tier = 2;
  } else if (preset === "high") {
    tier = 3;
  } else if (inputs.cameraHeightMeters >= inputs.disableAltitudeMeters) {
    tier = 1;
  } else if (inputs.cameraHeightMeters <= inputs.enableAltitudeMeters) {
    tier = 3;
  } else {
    tier = 2;
  }
  return REFERENCE_TABLE[tier];
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

function* sweepInputs() {
  const presets = ["low", "medium", "high", "auto", undefined, "unknown"];
  const heights = [-1, 0, 49_999, 50_000, 50_001, 75_000, 100_000, 6_608_000];
  const raws = [undefined, 64, 0, -5, 24, 32, 48, 63.5, 96, 128, 256, NaN];
  const bands = [
    [50_000, 100_000],
    [1_000, 2_000],
  ];
  for (const preset of presets) {
    for (const cameraHeightMeters of heights) {
      for (const rawCloudQuality of raws) {
        for (const [enableAltitudeMeters, disableAltitudeMeters] of bands) {
          yield {
            preset,
            rawCloudQuality,
            cameraHeightMeters,
            enableAltitudeMeters,
            disableAltitudeMeters,
          };
        }
      }
    }
  }
}

test("C1 with no override the resolver reproduces the reference for every tier and the escape hatch", () => {
  const tiersSeen = new Set();
  let escapeSeen = 0;
  let cases = 0;
  for (const inputs of sweepInputs()) {
    const expected = serialize(referenceResolve(inputs));
    const absent = live.resolveCloudPreset(inputs);
    assert.equal(serialize(absent), expected, JSON.stringify(inputs));
    // The renderer writes the field even when nothing is set, so an explicit
    // `undefined` must be the same state as an absent one.
    const explicit = live.resolveCloudPreset({
      ...inputs,
      realizationOverride: undefined,
    });
    assert.equal(serialize(explicit), expected, JSON.stringify(inputs));
    // A harness that clears the override with `null` must not throw out of
    // the cloud prepare, and must get the unmoved preset back.
    const cleared = live.resolveCloudPreset({
      ...inputs,
      realizationOverride: null,
    });
    assert.equal(serialize(cleared), expected, JSON.stringify(inputs));
    const raw = inputs.rawCloudQuality;
    if (typeof raw === "number" && raw !== 64) {
      escapeSeen++;
    } else {
      tiersSeen.add(absent.tier);
      // The tier path hands out the table row itself, override or not.
      const row = live.CLOUD_TIER_PRESETS[absent.tier];
      assert.equal(absent, row, JSON.stringify(inputs));
      assert.equal(explicit, row, JSON.stringify(inputs));
      assert.equal(cleared, row, JSON.stringify(inputs));
    }
    cases++;
  }
  assert.deepEqual(
    [...tiersSeen].sort(),
    [1, 2, 3],
    "the sweep reaches tiers 1-3",
  );
  assert.ok(escapeSeen > 0, "the sweep reaches the escape hatch");
  assert.ok(cases > 1000);
  // Tier 0 is never resolved; its row is still pinned against the table.
  assert.equal(
    serialize(live.CLOUD_TIER_PRESETS[0]),
    serialize(REFERENCE_TABLE[0]),
  );
});

test("C2 the pre-override module read out of git agrees with the live resolver", async (t) => {
  let source;
  try {
    source = execFileSync(
      "git",
      ["show", `${PRE_OVERRIDE_COMMIT}:${PRESETS_TS}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    t.skip(`commit ${PRE_OVERRIDE_COMMIT} is not in this clone`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-realization-ref-"));
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the reference sandbox ${dir} escaped os.tmpdir()`,
  );
  try {
    const file = path.join(dir, "WebGPUCloudTierPresets.ts");
    fs.writeFileSync(file, source);
    const pre = await import(pathToFileURL(file).href);
    assert.equal(typeof pre.resolveCloudRealization, "undefined");
    for (const inputs of sweepInputs()) {
      const expected = serialize(pre.resolveCloudPreset(inputs));
      assert.equal(
        serialize(referenceResolve(inputs)),
        expected,
        "transcription",
      );
      assert.equal(
        serialize(live.resolveCloudPreset(inputs)),
        expected,
        "live",
      );
      assert.equal(
        live.buildCloudQualityBlock(
          live.resolveCloudPreset(inputs),
          FULL_RES_BAKED,
        ).qualityFlags,
        pre.buildCloudQualityBlock(
          pre.resolveCloudPreset(inputs),
          FULL_RES_BAKED,
        ).qualityFlags,
        "flag word",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── D. Asked versus ran ─────────────────────────────────────────────────────

/**
 * @param {object} mod The preset module under test (live or a mutant).
 */
function assertAskedVersusRan(mod) {
  const tier3Word = 12601;
  const escapeWord = 4400;
  // [label, preset name, extra inputs, override, word, bake resident, moved]
  const cases = [
    [
      "steps inside the caps",
      "high",
      {},
      { primarySteps: 48 },
      tier3Word,
      true,
      false,
    ],
    [
      "steps equal to the tier",
      "high",
      {},
      { primarySteps: 96 },
      tier3Word,
      true,
      false,
    ],
    [
      "steps above the cap",
      "high",
      {},
      { primarySteps: 512 },
      tier3Word,
      true,
      true,
    ],
    [
      "steps rounded",
      "high",
      {},
      { primarySteps: 47.6 },
      tier3Word,
      true,
      true,
    ],
    ["steps below 1", "high", {}, { primarySteps: 0 }, tier3Word, true, true],
    [
      "steps not finite",
      "high",
      {},
      { primarySteps: NaN },
      tier3Word,
      true,
      true,
    ],
    [
      "light above the cap",
      "high",
      {},
      { lightSteps: 16 },
      tier3Word,
      true,
      true,
    ],
    [
      "light inside the caps",
      "high",
      {},
      { lightSteps: 4 },
      tier3Word,
      true,
      false,
    ],
    [
      "clear jitter",
      "high",
      {},
      { qualityFlagsClear: 1 << 3 },
      tier3Word,
      true,
      false,
    ],
    [
      "set jitter on the escape word",
      "high",
      { rawCloudQuality: 96 },
      { qualityFlagsSet: 1 << 3 },
      escapeWord,
      true,
      false,
    ],
    [
      "set bit 0 with the bake resident",
      "high",
      { rawCloudQuality: 96 },
      { qualityFlagsSet: 1 },
      escapeWord,
      true,
      false,
    ],
    [
      "set bit 0 without the bake",
      "high",
      { rawCloudQuality: 96 },
      { qualityFlagsSet: 1 },
      escapeWord,
      false,
      true,
    ],
    [
      "set bit 13 without the bake",
      "high",
      { rawCloudQuality: 96 },
      { qualityFlagsSet: 1 << 13 },
      escapeWord,
      false,
      true,
    ],
    [
      "clear a structural bit (half-res)",
      "low",
      {},
      { qualityFlagsClear: 1 << 1 },
      tier3Word | 2,
      true,
      true,
    ],
    [
      "set an allocation bit (multi-deck)",
      "high",
      {},
      { qualityFlagsSet: 1 << 11 },
      tier3Word,
      true,
      true,
    ],
    [
      "set a bit already set",
      "high",
      {},
      { qualityFlagsSet: 1 << 3 },
      tier3Word,
      true,
      false,
    ],
    ["empty override", "high", {}, {}, tier3Word, true, false],
  ];
  for (const [label, name, extra, override, word, baked, moved] of cases) {
    const preset = mod.resolveCloudPreset(
      inputsFor(name, { ...extra, realizationOverride: override }),
    );
    const unmoved = mod.resolveCloudPreset(inputsFor(name, extra));
    const report = mod.resolveCloudRealization(preset, word, override, baked);
    // The ask is exactly what was asked.
    assert.ok(
      Object.is(
        report.requestedPrimarySteps,
        override.primarySteps ?? unmoved.primarySteps,
      ),
      `${label}: requestedPrimarySteps is the ask`,
    );
    assert.ok(
      Object.is(
        report.requestedLightSteps,
        override.lightSteps ?? unmoved.lightSteps,
      ),
      `${label}: requestedLightSteps is the ask`,
    );
    assert.equal(
      report.requestedQualityFlags,
      ((word | (override.qualityFlagsSet ?? 0)) &
        ~(override.qualityFlagsClear ?? 0)) >>>
        0,
      `${label}: requestedQualityFlags is the ask`,
    );
    // What ran is what the resolver produced.
    assert.equal(report.primarySteps, preset.primarySteps, label);
    assert.equal(report.lightSteps, preset.lightSteps, label);
    const differs =
      !Object.is(report.requestedPrimarySteps, report.primarySteps) ||
      !Object.is(report.requestedLightSteps, report.lightSteps) ||
      report.requestedQualityFlags !== report.qualityFlags;
    assert.equal(differs, moved, `${label}: asked and ran differ iff moved`);
  }
  // The caps, stated as the realised numbers.
  const capped = mod.resolveCloudPreset(
    inputsFor("high", {
      realizationOverride: { primarySteps: 512, lightSteps: 64 },
    }),
  );
  assert.equal(capped.primarySteps, mod.CLOUD_OVERRIDE_MAX_PRIMARY_STEPS);
  assert.equal(capped.lightSteps, mod.CLOUD_OVERRIDE_MAX_LIGHT_STEPS);
  assert.equal(mod.CLOUD_OVERRIDE_MAX_PRIMARY_STEPS, 128);
  assert.equal(mod.CLOUD_OVERRIDE_MAX_LIGHT_STEPS, 8);
}

test("D1 the report's ask and realised values differ exactly when something moved the ask", () => {
  assertAskedVersusRan(live);
});

/**
 * @param {object} mod The preset module under test (live or a mutant).
 */
function assertWorkloadBound(mod) {
  const cap =
    mod.CLOUD_OVERRIDE_MAX_PRIMARY_STEPS * mod.CLOUD_OVERRIDE_MAX_LIGHT_STEPS;
  let escapeCases = 0;
  for (const preset of ["low", "medium", "high"]) {
    for (const raw of [64, 24, 32, 96, 100, 128, 200, 256, 512, 1024]) {
      const base = mod.resolveCloudPreset(
        inputsFor(preset, { rawCloudQuality: raw }),
      );
      for (const primarySteps of [undefined, 1, 48, 128, 129, 512, 1e9]) {
        for (const lightSteps of [undefined, 1, 4, 8, 9, 64]) {
          const moved = mod.resolveCloudPreset(
            inputsFor(preset, {
              rawCloudQuality: raw,
              realizationOverride: { primarySteps, lightSteps },
            }),
          );
          const label = `${preset} raw ${raw} ask ${primarySteps}x${lightSteps}`;
          assert.ok(
            moved.primarySteps * moved.lightSteps <=
              Math.max(cap, base.primarySteps * base.lightSteps),
            `${label}: ${moved.primarySteps}x${moved.lightSteps} exceeds the bound`,
          );
          if (raw !== 64) {
            escapeCases++;
          }
        }
      }
    }
  }
  assert.ok(escapeCases > 0, "the sweep reaches the escape hatch");
}

test("D2 no override raises the per-pixel workload above the larger of the caps and the dials' own", () => {
  assertWorkloadBound(live);
});

// ── E. Inertness mutants ────────────────────────────────────────────────────

/**
 * Copy the preset module into a fresh directory under `os.tmpdir()`, make one
 * gate unreachable, import the copy, run a check against it and remove the
 * sandbox.
 *
 * @param {string} anchor Exact, unique source text to replace.
 * @param {string} replacement Its unreachable form.
 * @param {(mutant:object) => void} check Assertions expected to throw.
 * @returns {Promise<void>}
 */
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
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloud-realization-mutant-"),
  );
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the mutant sandbox ${dir} escaped os.tmpdir()`,
  );
  try {
    const file = path.join(dir, "WebGPUCloudTierPresets.ts");
    fs.writeFileSync(file, mutated);
    const mutant = await import(pathToFileURL(file).href);
    assert.throws(
      () => check(mutant),
      assert.AssertionError,
      `the mutant survived: ${replacement}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const STEP_GATE = "if (override !== undefined && override !== null) {";
const FLAG_GATE = "if (askedSet !== 0 || askedClear !== 0) {";

test("E1 the step gate made unreachable turns A and D red", async () => {
  const unreachable =
    "if (false && override !== undefined && override !== null) {";
  await assertMutantRed(STEP_GATE, unreachable, assertTierPathSteps);
  await assertMutantRed(STEP_GATE, unreachable, assertAskedVersusRan);
});

test("E3 the step caps removed turn D red", async () => {
  const capped = "return steps < 1 ? resolved : Math.min(max, steps);";
  const uncapped = "return steps < 1 ? resolved : steps;";
  await assertMutantRed(capped, uncapped, assertAskedVersusRan);
  await assertMutantRed(capped, uncapped, assertWorkloadBound);
});

test("E2 the flag gate made unreachable turns B and D red", async () => {
  const unreachable = "if (false && (askedSet !== 0 || askedClear !== 0)) {";
  await assertMutantRed(FLAG_GATE, unreachable, assertSingleBitClears);
  await assertMutantRed(FLAG_GATE, unreachable, assertAskedVersusRan);
});

// ── F. The renderer's side ──────────────────────────────────────────────────

const RENDERER_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const rendererSource = readSource(RENDERER_TS);

// The release strip itself, not a re-typed copy of it, loaded only by the tests
// that need it.
let buildModulePromise;
function loadBuildModule() {
  buildModulePromise ??= import(
    pathToFileURL(path.join(root, "scripts", "build.js")).href
  );
  return buildModulePromise;
}

/** The publisher's source, lifted verbatim from a renderer source text. */
function extractPublish(source) {
  const start = source.indexOf("function publishCloudRealization(");
  assert.ok(start >= 0, "publishCloudRealization is not in the renderer");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "publishCloudRealization has no closing brace");
  return source.slice(start, end + 3);
}

/**
 * Load a preset module and a publisher lifted from a renderer source, beside
 * each other in a sandbox under `os.tmpdir()`, so the publisher's one import
 * resolves to that preset module.
 *
 * @param {string} renderer Renderer source text (live, stripped or a mutant).
 * @param {string} presets Preset module source text.
 * @returns {Promise<{publish: Function, presets: object}>}
 */
async function loadPublisher(renderer, presets = presetsSource) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloud-realization-publish-"),
  );
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the publisher sandbox ${dir} escaped os.tmpdir()`,
  );
  try {
    const presetsFile = path.join(dir, "WebGPUCloudTierPresets.ts");
    fs.writeFileSync(presetsFile, presets);
    const publishFile = path.join(dir, "publish.ts");
    fs.writeFileSync(
      publishFile,
      'import { resolveCloudRealization } from "./WebGPUCloudTierPresets.ts";\n' +
        `export ${extractPublish(renderer)}`,
    );
    const presetsModule = await import(pathToFileURL(presetsFile).href);
    const publishModule = await import(pathToFileURL(publishFile).href);
    return {
      publish: publishModule.publishCloudRealization,
      presets: presetsModule,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the publisher once over a packed buffer whose float 74 holds `word`. */
function runPublish(loaded, preset, word, override, bakedNoiseResident = true) {
  const data = new Float32Array(256);
  data[74] = word;
  const counters = {
    requestedPrimarySteps: -1,
    requestedLightSteps: -1,
    requestedQualityFlags: -1,
    qualityFlags: -1,
  };
  loaded.publish(data, counters, preset, override, bakedNoiseResident);
  return { uploaded: data[74], counters };
}

// The pre-registered Edge rows: each clear on the tier-3 orbital word and the
// word the shader must then read.
const EDGE_ROWS = [
  [8, 12593],
  [1, 12600],
  [8192, 4409],
  [8193, 4408],
  [8201, 4400],
];

/**
 * @param {{publish: Function, presets: object}} loaded A lifted publisher.
 */
function assertPublishWiring(loaded) {
  const presets = loaded.presets;
  const tier3 = presets.resolveCloudPreset(inputsFor("high"));
  for (const override of [undefined, null]) {
    const run = runPublish(loaded, tier3, 12601, override);
    assert.equal(run.uploaded, 12601, `${override}: the word is untouched`);
    assert.deepEqual(
      run.counters,
      {
        requestedPrimarySteps: 96,
        requestedLightSteps: 8,
        requestedQualityFlags: 12601,
        qualityFlags: 12601,
      },
      `${override}: with nothing asked, the ask is the resolved value`,
    );
  }
  for (const [clear, expected] of EDGE_ROWS) {
    const override = { qualityFlagsClear: clear };
    const preset = presets.resolveCloudPreset(
      inputsFor("high", { realizationOverride: override }),
    );
    const run = runPublish(loaded, preset, 12601, override);
    assert.equal(run.uploaded, expected, `clear ${clear}: the uploaded word`);
    assert.equal(run.counters.qualityFlags, expected, `clear ${clear}`);
    assert.equal(
      run.counters.requestedQualityFlags,
      expected,
      `clear ${clear}`,
    );
    assert.equal(run.counters.requestedPrimarySteps, 96, `clear ${clear}`);
    assert.equal(run.counters.requestedLightSteps, 8, `clear ${clear}`);
  }
  // A refused bit: the ask is recorded, the word is not moved.
  const refused = { qualityFlagsSet: 1 << 11 };
  const refusedRun = runPublish(loaded, tier3, 12601, refused);
  assert.equal(refusedRun.uploaded, 12601, "a refused bit is not uploaded");
  assert.equal(refusedRun.counters.requestedQualityFlags, 12601 | (1 << 11));
  assert.equal(refusedRun.counters.qualityFlags, 12601);
  // An absent bake refuses bit 0 on the escape word.
  const unbaked = { qualityFlagsSet: 1 };
  const escape = presets.resolveCloudPreset(
    inputsFor("high", { rawCloudQuality: 96, realizationOverride: unbaked }),
  );
  const unbakedRun = runPublish(loaded, escape, 4400, unbaked, false);
  assert.equal(unbakedRun.uploaded, 4400, "bit 0 needs the bake");
  assert.equal(unbakedRun.counters.requestedQualityFlags, 4401);
  // Steps: the ask is recorded beside the capped count the preset carries.
  const steps = { primarySteps: 512, lightSteps: 4 };
  const stepped = presets.resolveCloudPreset(
    inputsFor("high", { realizationOverride: steps }),
  );
  assert.equal(stepped.primarySteps, 128);
  const stepRun = runPublish(loaded, stepped, 12601, steps);
  assert.equal(stepRun.uploaded, 12601, "a step ask leaves the word alone");
  assert.equal(stepRun.counters.requestedPrimarySteps, 512);
  assert.equal(stepRun.counters.requestedLightSteps, 4);
}

test("F1 the renderer's publisher, executed, uploads each pre-registered word and records it beside the ask", async () => {
  assertPublishWiring(await loadPublisher(rendererSource));
});

test("F2 after the release build's pragma strip, neither the resolver nor the publisher honours an override", async () => {
  const build = await loadBuildModule();
  assert.equal(build.pragmas.debug, false, "fixture: release strips debug");
  const strip = (source) =>
    source.replace(build.constructRegex("debug", build.pragmas.debug), "");
  const PAIR = "//>>includeStart('debug', pragmas.debug);";
  const pairs = (source) => source.split(PAIR).length - 1;
  assert.ok(pairs(presetsSource) >= 1, "fixture: the resolver carries a pair");
  assert.ok(pairs(rendererSource) >= 2, "fixture: the renderer carries two");
  const strippedPresets = strip(presetsSource);
  const strippedRenderer = strip(rendererSource);
  assert.equal(pairs(strippedPresets), 0);
  assert.equal(pairs(strippedRenderer), 0);

  const released = await loadPublisher(strippedRenderer, strippedPresets);
  const presets = released.presets;
  const tier3Row = presets.CLOUD_TIER_PRESETS[3];
  assert.equal(
    presets.resolveCloudPreset(
      inputsFor("high", {
        realizationOverride: { primarySteps: 48, lightSteps: 2 },
      }),
    ),
    tier3Row,
    "the release resolver returns the tier row itself",
  );
  for (const [clear] of EDGE_ROWS) {
    const run = runPublish(released, tier3Row, 12601, {
      qualityFlagsClear: clear,
      primarySteps: 48,
    });
    assert.equal(run.uploaded, 12601, `release, clear ${clear}`);
    assert.deepEqual(run.counters, {
      requestedPrimarySteps: 96,
      requestedLightSteps: 8,
      requestedQualityFlags: 12601,
      qualityFlags: 12601,
    });
  }
  // The same checks that pass on the debug form fail on the release form.
  assert.throws(() => assertPublishWiring(released), assert.AssertionError);
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
  const body = end < 0 ? rest : rest.slice(0, end);
  return body.split("\n").map((line) => line.trim());
}

function onlyIndex(lines, predicate, what) {
  const found = [];
  lines.forEach((line, i) => {
    if (predicate(line)) {
      found.push(i);
    }
  });
  assert.equal(
    found.length,
    1,
    `${what}: expected exactly one, found ${found.length}`,
  );
  return found[0];
}

/**
 * The call-site facts a device run relies on, by position.
 *
 * @param {string} source Renderer source text (live or a mutant).
 */
function assertRendererWiring(source) {
  const lines = prepareLines(source);
  // The hand-off: debug-only, after the inputs exist, before the resolver.
  const handoff = onlyIndex(
    lines,
    (l) =>
      l === "qualityInputs.realizationOverride = cache.realizationOverride;",
    "the override hand-off",
  );
  assert.equal(lines[handoff - 1], "//>>includeStart('debug', pragmas.debug);");
  assert.equal(lines[handoff + 1], "//>>includeEnd('debug');");
  const inputsBuilt = onlyIndex(
    lines,
    (l) => l.startsWith("const qualityInputs = buildCloudQualityInputs("),
    "the resolver inputs",
  );
  const resolved = onlyIndex(
    lines,
    (l) => l.includes("resolveCloudPreset(qualityInputs)"),
    "the resolver call",
  );
  assert.ok(inputsBuilt < handoff && handoff < resolved, "hand-off order");

  // The publish: once, after the last fold of float 74, before the upload,
  // and handed the same override the resolver saw.
  const publish = onlyIndex(
    lines,
    (l) => l.includes("publishCloudRealization("),
    "the publish call",
  );
  assert.equal(
    lines[publish],
    "publishCloudRealization(",
    "an unconditional call",
  );
  let lastFold = -1;
  lines.forEach((line, i) => {
    if (/data\[74\]\s*=[^=]/.test(line)) {
      lastFold = i;
    }
  });
  assert.ok(lastFold > 0, "fixture: float 74 is folded in the prepare");
  assert.ok(publish > lastFold, "the publish is float 74's last writer");
  const upload = onlyIndex(
    lines,
    (l) => l === "device.queue.writeBuffer(cache.uniformBuffer!, 0, data);",
    "the uniform upload",
  );
  assert.ok(publish < upload, "the publish precedes the upload");
  const callEnd = lines.indexOf(");", publish);
  const args = lines.slice(publish, callEnd);
  assert.ok(
    args.includes("qualityInputs.realizationOverride,"),
    "the override",
  );
  assert.ok(args.includes("cloudPreset,"), "the resolved preset");

  // The serial: advanced once, straight after the composite stage closes.
  const writes = source.match(/executeSerial\s*(?:\+\+|--|[-+]?=(?!=))/g) ?? [];
  assert.equal(writes.length, 1, "executeSerial is written in one place");
  const serial = onlyIndex(
    lines,
    (l) => l === "cache.executeSerial++;",
    "the executeSerial advance",
  );
  const next = lines.slice(serial + 1).find((l) => l !== "");
  assert.equal(next, "return true;", "the advance is the success return's");
  assert.ok(
    lines
      .slice(Math.max(0, serial - 4), serial)
      .includes("stages.endStage(CloudCpuStage.COMPOSITE);"),
    "the advance follows the composite stage",
  );
}

/** Replace a unique anchor in the renderer source. */
function mutateRenderer(anchor, replacement) {
  const first = rendererSource.indexOf(anchor);
  assert.ok(first >= 0, `mutation anchor not found: ${anchor}`);
  assert.equal(
    rendererSource.indexOf(anchor, first + 1),
    -1,
    `mutation anchor is not unique: ${anchor}`,
  );
  return (
    rendererSource.slice(0, first) +
    replacement +
    rendererSource.slice(first + anchor.length)
  );
}

test("F3 the renderer hands the override to the resolver, publishes after the last fold, and advances executeSerial only after the composite", () => {
  assertRendererWiring(rendererSource);
});

test("F4 each renderer mutant turns F1 or F3 red", async () => {
  const pinMutants = [
    [
      "hand-off unreachable",
      "    qualityInputs.realizationOverride = cache.realizationOverride;",
      "    if (false) qualityInputs.realizationOverride = cache.realizationOverride;",
    ],
    [
      "publish unreachable",
      "\n    publishCloudRealization(\n",
      "\n    if (false) publishCloudRealization(\n",
    ],
    [
      "a fold after the publish",
      "    device.queue.writeBuffer(cache.uniformBuffer!, 0, data);",
      "    data[74] = data[74] | 0;\n    device.queue.writeBuffer(cache.uniformBuffer!, 0, data);",
    ],
    ["executeSerial never advances", "        cache.executeSerial++;\n", ""],
  ];
  for (const [name, anchor, replacement] of pinMutants) {
    // Mutated outside the throws check, so a lost anchor fails loudly instead
    // of passing as a "killed" mutant.
    const mutated = mutateRenderer(anchor, replacement);
    assert.throws(
      () => assertRendererWiring(mutated),
      assert.AssertionError,
      `the pin survived: ${name}`,
    );
  }
  const executedMutants = [
    [
      "the publisher's gate unreachable",
      "if (override !== undefined && override !== null) {",
      "if (false && override !== undefined && override !== null) {",
    ],
    ["float 74 never written", "data[74] = realization.qualityFlags;", ""],
    [
      "the flag ask never recorded",
      "counters.requestedQualityFlags = realization.requestedQualityFlags;",
      "",
    ],
  ];
  for (const [name, anchor, replacement] of executedMutants) {
    const loaded = await loadPublisher(mutateRenderer(anchor, replacement));
    assert.throws(
      () => assertPublishWiring(loaded),
      assert.AssertionError,
      `the executed check survived: ${name}`,
    );
  }
});
