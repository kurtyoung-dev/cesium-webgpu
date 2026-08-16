// weather-probe-headroom.spec.mjs — browser-free guard for the Batch-861
// Gate-B repairs: `probe-weather-metar.mjs`'s gate-4 partial-coverage
// discriminator, and `probe-weather-channels.mjs`'s migration onto the shared
// pinning module with a BRACKETING determinism control.
// @purpose Guard for Gate-B probe repairs: METAR gate-4 partial-coverage discriminator and channels-probe migration onto shared pinning with brackets.
// @status ACTIVE
//
// Both repairs are repairs to a GATE, so a spec that only exercised the correct
// implementation would be worth nothing: the pre-repair code also "passed" — it
// just passed blindly. Gate 4 measured `sum|ch1-ch0| = 0.0019` over seven
// locations that read 0.997..1.000 in BOTH legs, five of them pinned at exactly
// 1.000; a metric at its ceiling reports a null no matter how large the effect
// is. Every rule below is therefore stated once and then run twice, against the
// real implementation and against a battery of MUTANTS, each of which is the
// plausible wrong implementation somebody would actually write. `mutant
// rejection` requires every mutant to be caught by at least one rule.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectGlobeReadinessStructural,
  collectHeadroomStructural,
  collectPinStructural,
  collectRepeatStructural,
  COVERAGE_HEADROOM_BAND,
  inHeadroomBand,
  selectPartialCoverageBand,
} from "./lib/weather-probe-pinning.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const stripComments = (source) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const METAR = readNormalized("Tools/visual-regression/probe-weather-metar.mjs");
const CHANNELS = readNormalized(
  "Tools/visual-regression/probe-weather-channels.mjs",
);
const METAR_CODE = stripComments(METAR);
const CHANNELS_CODE = stripComments(CHANNELS);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ladder with exactly nine in-band candidates plus saturated witnesses. */
const ladder = () => [
  { key: -104, value: 0.02 }, // below band
  { key: -100, value: 0.14 },
  { key: -96, value: 0.26 },
  { key: -92, value: 0.38 },
  { key: -88, value: 0.5 },
  { key: -84, value: 0.62 },
  { key: -80, value: 0.74 },
  { key: -76, value: 0.86 },
  { key: 88, value: 0.44 },
  { key: 96, value: 0.56 },
  { key: 104, value: 0.95 }, // above band
  { key: -60, value: 1.0, eligible: false }, // saturated witness
  { key: 0, value: 1.0, eligible: false },
  { key: 60, value: 0.999, eligible: false },
];

const slots = (over = {}) => ({
  time: 1000,
  maxSteps: 32,
  weatherMapEnabled: 1,
  qualityFlags: 0,
  channelStrength: 1,
  ...over,
});

const capture = (lon, over = {}) => ({
  lon,
  label: `leg lon ${lon}`,
  slots: slots(over.slots),
  ...over,
});

const healthyPins = (over = {}) => ({
  rendererType: "webgpu",
  isWebGPU: true,
  useDefaultRenderLoop: false,
  requestRenderMode: false,
  shouldAnimate: false,
  clockMultiplier: 0,
  imageryLayersBefore: 1,
  imageryLayersAfter: 0,
  ellipsoidTerrain: true,
  terrainForced: true,
  showGroundAtmosphere: false,
  enableLighting: false,
  canvas: { width: 1024, height: 768 },
  ...over,
});

const healthyDials = (over = {}) => ({
  cloudWindSpeed: 0,
  cloudQuality: 32,
  cloudCastShadows: false,
  cloudContributesIBL: false,
  ...over,
});

/** A globe that rendered: an `awaitGlobeReady` report with binned commands. */
const healthyReadiness = (over = {}) => ({
  binnedGlobeCommands: 96,
  firstBinnedMs: 412,
  elapsedMs: 3011,
  ...over,
});

/** The report `awaitGlobeReady` actually returns when the budget expires. */
const deadReadiness = () => ({
  binnedGlobeCommands: 0,
  firstBinnedMs: null,
  elapsedMs: 90000,
});

// ---------------------------------------------------------------------------
// MUTANTS — the plausible wrong implementations
// ---------------------------------------------------------------------------

const sortByKey = (list) => list.slice().sort((a, b) => a.key - b.key);

/** M1 — no in-band filter: takes `count` candidates regardless of headroom. */
const mutantNoFilter = ({ samples, count }) => {
  const eligible = sortByKey(samples.filter((s) => s.eligible !== false));
  return {
    selected: eligible.slice(0, count),
    inBand: eligible,
    rejected: [],
    reasons: [],
  };
};

/** M2 — band widened to the full range, so a saturated 1.000 counts as usable. */
const mutantWidenedBand = ({ samples, count }) =>
  selectPartialCoverageBand({ samples, count, band: { min: 0, max: 1 } });

/** M3 — ranks by closeness to mid-scale instead of spreading across the field. */
const mutantMidScaleRanked = ({ samples, count }) => {
  const inBand = samples
    .filter((s) => s.eligible !== false && inHeadroomBand(s.value))
    .slice()
    .sort((a, b) => Math.abs(a.value - 0.5) - Math.abs(b.value - 0.5));
  return {
    selected: sortByKey(inBand.slice(0, count)),
    inBand,
    rejected: [],
    reasons: inBand.length < count ? ["insufficient"] : [],
  };
};

/** M4 — ignores the `eligible` flag, so saturated witnesses can be scored. */
const mutantIgnoresEligible = ({ samples, count }) =>
  selectPartialCoverageBand({
    samples: samples.map(({ key, value }) => ({ key, value })),
    count,
  });

/** M5 — half-open band, so a value exactly on a bound is wrongly rejected. */
const mutantExclusiveBounds = ({ samples, count }) => {
  const inBand = sortByKey(
    samples.filter(
      (s) =>
        s.eligible !== false &&
        s.value > COVERAGE_HEADROOM_BAND.min &&
        s.value < COVERAGE_HEADROOM_BAND.max,
    ),
  );
  if (inBand.length < count) {
    return { selected: [], inBand, rejected: [], reasons: ["insufficient"] };
  }
  const step = (inBand.length - 1) / (count - 1);
  return {
    selected: Array.from(
      { length: count },
      (_, i) => inBand[Math.round(i * step)],
    ),
    inBand,
    rejected: [],
    reasons: [],
  };
};

/** M6 — a shortfall degrades to "score what we have" instead of STRUCTURAL. */
const mutantDegradesOnShortfall = ({ samples, count }) => {
  const inBand = sortByKey(
    samples.filter((s) => s.eligible !== false && inHeadroomBand(s.value)),
  );
  return {
    selected: inBand.slice(0, count),
    inBand,
    rejected: [],
    reasons: [],
  };
};

const SELECT_MUTANTS = [
  ["M1 no in-band filter", mutantNoFilter],
  ["M2 widened band", mutantWidenedBand],
  ["M3 mid-scale ranked", mutantMidScaleRanked],
  ["M4 ignores eligible flag", mutantIgnoresEligible],
  ["M5 exclusive bounds", mutantExclusiveBounds],
  ["M6 degrades on shortfall", mutantDegradesOnShortfall],
];

/** M7 — headroom checked against the CALIBRATION ladder, not the scored leg. */
const mutantHeadroomOnLadder = ({ ladderSamples }) =>
  collectHeadroomStructural({ label: "gate 4", samples: ladderSamples });

/** M8 — headroom check that accepts an empty scored leg. */
const mutantHeadroomEmptyOk = ({ samples }) =>
  samples.length === 0
    ? []
    : collectHeadroomStructural({ label: "gate 4", samples });

/** M9 — one-sided headroom: guards the ceiling but not the floor. */
const mutantHeadroomCeilingOnly = ({ samples }) =>
  samples.some((s) => s.value > COVERAGE_HEADROOM_BAND.max) ? ["ceiling"] : [];

// ---------------------------------------------------------------------------
// RULES — the selector
// ---------------------------------------------------------------------------

const selectRules = [
  [
    "R1 never selects a location outside the headroom band",
    (select) => {
      const out = select({ samples: ladder(), count: 7 });
      if (out.reasons.length) {
        return; // a STRUCTURAL result selects nothing — vacuously in-band
      }
      for (const s of out.selected) {
        assert.ok(
          inHeadroomBand(s.value),
          `selected ${s.key}=${s.value} outside ${JSON.stringify(COVERAGE_HEADROOM_BAND)}`,
        );
      }
    },
  ],
  [
    "R2 never selects an ineligible witness, even one that happens to be in-band",
    (select) => {
      // Eligibility is a SCOPE declaration, not a headroom heuristic. A witness
      // that happens to read mid-scale must still be unscorable, or the flag is
      // decorative — the exact hole a "filter by value only" implementation
      // leaves. Only three eligible candidates are in-band, so an implementation
      // that honours the flag must report STRUCTURAL rather than reach for the
      // witnesses to make up the count.
      const withInBandWitness = [
        { key: -100, value: 0.3 },
        { key: -90, value: 0.5 },
        { key: -80, value: 0.7 },
        { key: -60, value: 0.45, eligible: false },
        { key: 0, value: 0.55, eligible: false },
        { key: 60, value: 0.65, eligible: false },
        { key: 120, value: 0.35, eligible: false },
      ];
      const out = select({ samples: withInBandWitness, count: 5 });
      const witnesses = new Set([-60, 0, 60, 120]);
      for (const s of out.selected) {
        assert.ok(!witnesses.has(s.key), `selected witness ${s.key}`);
      }
      assert.ok(
        out.reasons.length > 0,
        "three eligible in-band candidates cannot aim a 5-location gate",
      );
    },
  ],
  [
    "R3 a shortfall of in-band candidates is STRUCTURAL, never a short selection",
    (select) => {
      // Only three candidates have headroom; a 7-location gate cannot be aimed.
      const scarce = [
        { key: -100, value: 0.3 },
        { key: -90, value: 0.5 },
        { key: -80, value: 0.7 },
        { key: -70, value: 1.0 },
        { key: -60, value: 1.0 },
        { key: -50, value: 0.0 },
        { key: -40, value: 0.0 },
      ];
      const out = select({ samples: scarce, count: 7 });
      assert.ok(
        out.reasons.length > 0,
        "a shortfall must produce a STRUCTURAL reason",
      );
      assert.equal(out.selected.length, 0, "a shortfall must select nothing");
    },
  ],
  [
    "R4 selection SPANS the candidate range rather than clustering at mid-scale",
    (select) => {
      const out = select({ samples: ladder(), count: 7 });
      assert.equal(out.reasons.length, 0);
      const keys = out.selected.map((s) => s.key);
      // The ladder's IN-BAND candidates run -100..96 (-104 is below the band and
      // 104 above it). A selection that spans them must retain both extremes; a
      // mid-scale ranking drops them first, and for an IDW field the mid-scale
      // point is exactly where the interpolated channel is most nearly NEUTRAL.
      assert.ok(
        keys.includes(-100) && keys.includes(96),
        `selection ${JSON.stringify(keys)} does not span the in-band range`,
      );
    },
  ],
  [
    "R5 a value exactly on a band bound is usable",
    (select) => {
      const onBounds = [
        { key: 1, value: COVERAGE_HEADROOM_BAND.min },
        { key: 2, value: 0.3 },
        { key: 3, value: COVERAGE_HEADROOM_BAND.max },
      ];
      const out = select({ samples: onBounds, count: 3 });
      assert.equal(
        out.reasons.length,
        0,
        "inclusive bounds: three in-band candidates satisfy a 3-location gate",
      );
      assert.deepEqual(
        out.selected.map((s) => s.key),
        [1, 2, 3],
      );
    },
  ],
  [
    "R6 selects exactly `count` distinct locations",
    (select) => {
      const out = select({ samples: ladder(), count: 7 });
      assert.equal(out.reasons.length, 0);
      assert.equal(out.selected.length, 7);
      assert.equal(new Set(out.selected.map((s) => s.key)).size, 7);
    },
  ],
];

for (const [name, rule] of selectRules) {
  test(`selectPartialCoverageBand — ${name}`, () => {
    rule((options) =>
      selectPartialCoverageBand({ band: COVERAGE_HEADROOM_BAND, ...options }),
    );
  });
}

test("selectPartialCoverageBand — mutant rejection (every mutant caught)", () => {
  for (const [mutantName, mutant] of SELECT_MUTANTS) {
    let caught = false;
    for (const [, rule] of selectRules) {
      try {
        rule(mutant);
      } catch {
        caught = true;
        break;
      }
    }
    assert.ok(caught, `${mutantName} survived every rule — the spec is blind`);
  }
});

test("selectPartialCoverageBand — the selector cannot see the response leg", () => {
  // Two ladders identical in every field the selector is allowed to read, but
  // carrying opposite response-leg deltas. A selector that peeked at the
  // response would aim differently; this one must not.
  const base = ladder();
  const withBigDeltaAtEdges = base.map((s) => ({
    ...s,
    ch1: Math.abs(s.key) > 90 ? 1.0 : s.value,
    delta: Math.abs(s.key) > 90 ? 0.9 : 0.0,
  }));
  const withBigDeltaAtCentre = base.map((s) => ({
    ...s,
    ch1: Math.abs(s.key) <= 90 ? 1.0 : s.value,
    delta: Math.abs(s.key) <= 90 ? 0.9 : 0.0,
  }));
  const a = selectPartialCoverageBand({
    samples: withBigDeltaAtEdges,
    count: 7,
  });
  const b = selectPartialCoverageBand({
    samples: withBigDeltaAtCentre,
    count: 7,
  });
  assert.deepEqual(
    a.selected.map((s) => s.key),
    b.selected.map((s) => s.key),
    "the aim changed with the response leg — the selector is cherry-picking",
  );
});

test("selectPartialCoverageBand — a non-integer or absent count is STRUCTURAL", () => {
  for (const count of [0, -1, 2.5, undefined, NaN]) {
    const out = selectPartialCoverageBand({ samples: ladder(), count });
    assert.ok(out.reasons.length > 0, `count=${count} must be rejected`);
    assert.equal(out.selected.length, 0);
  }
});

// ---------------------------------------------------------------------------
// RULES — the headroom enforcement
// ---------------------------------------------------------------------------

const headroomRules = [
  [
    "H1 a saturated scored leg is STRUCTURAL",
    (check) => {
      // The Batch-860 measurement, verbatim.
      const recorded = [0.997, 1.0, 1.0, 1.0, 1.0, 1.0, 0.997];
      const out = check({
        samples: recorded.map((value, i) => ({ key: i, value })),
        ladderSamples: ladder().filter((s) => s.eligible !== false),
      });
      assert.ok(
        out.length > 0,
        "the recorded saturated ch0 leg must report STRUCTURAL",
      );
    },
  ],
  [
    "H2 a floored scored leg is STRUCTURAL too",
    (check) => {
      const out = check({
        samples: [0.0, 0.0, 0.05, 0.5, 0.5, 0.5, 0.5].map((value, i) => ({
          key: i,
          value,
        })),
        ladderSamples: ladder().filter((s) => s.eligible !== false),
      });
      assert.ok(out.length > 0, "a floored leg has no downward headroom");
    },
  ],
  [
    "H3 an in-band scored leg passes",
    (check) => {
      const out = check({
        samples: [0.32, 0.41, 0.5, 0.55, 0.62, 0.7, 0.78].map((value, i) => ({
          key: i,
          value,
        })),
        ladderSamples: ladder().filter((s) => s.eligible !== false),
      });
      assert.deepEqual(out, [], "an in-band leg must not be STRUCTURAL");
    },
  ],
  [
    "H4 an empty scored leg is STRUCTURAL",
    (check) => {
      const out = check({
        samples: [],
        ladderSamples: ladder().filter((s) => s.eligible !== false),
      });
      assert.ok(out.length > 0, "no baseline samples certifies nothing");
    },
  ],
  [
    "H5 a stale aim is caught: ladder in-band, scored leg saturated",
    (check) => {
      // The ladder that AIMED the gate is healthy; the leg that was SCORED has
      // since saturated. Reading the ladder instead of the scored leg is the
      // failure this rule exists for.
      const out = check({
        samples: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0].map((value, i) => ({
          key: i,
          value,
        })),
        ladderSamples: [0.3, 0.4, 0.5, 0.6, 0.7, 0.45, 0.55].map(
          (value, i) => ({ key: i, value }),
        ),
      });
      assert.ok(out.length > 0, "a stale aim must report STRUCTURAL");
    },
  ],
  [
    "H6 a NaN reading is STRUCTURAL, not silently in-band",
    (check) => {
      const out = check({
        samples: [0.3, 0.4, NaN, 0.6, 0.7, 0.45, 0.55].map((value, i) => ({
          key: i,
          value,
        })),
        ladderSamples: ladder().filter((s) => s.eligible !== false),
      });
      assert.ok(out.length > 0, "NaN must not pass a band test");
    },
  ],
];

for (const [name, rule] of headroomRules) {
  test(`collectHeadroomStructural — ${name}`, () => {
    rule(({ samples }) =>
      collectHeadroomStructural({ label: "gate 4 ch0 baseline", samples }),
    );
  });
}

test("collectHeadroomStructural — mutant rejection (every mutant caught)", () => {
  for (const [mutantName, mutant] of [
    ["M7 checks the ladder, not the scored leg", mutantHeadroomOnLadder],
    ["M8 accepts an empty scored leg", mutantHeadroomEmptyOk],
    ["M9 guards the ceiling only", mutantHeadroomCeilingOnly],
  ]) {
    let caught = false;
    for (const [, rule] of headroomRules) {
      try {
        rule(mutant);
      } catch {
        caught = true;
        break;
      }
    }
    assert.ok(caught, `${mutantName} survived every rule — the spec is blind`);
  }
});

test("inHeadroomBand — bounds are inclusive and non-finite input is false", () => {
  assert.equal(inHeadroomBand(0.1), true);
  assert.equal(inHeadroomBand(0.9), true);
  assert.equal(inHeadroomBand(0.0999999), false);
  assert.equal(inHeadroomBand(0.9000001), false);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "0.5"]) {
    assert.equal(inHeadroomBand(bad), false, `${String(bad)} must be false`);
  }
});

// ---------------------------------------------------------------------------
// SOURCE ANCHORS — the probes must actually USE the enforcement
// ---------------------------------------------------------------------------

test("metar: gate 4's band is calibrated, not a hard-coded saturated list", () => {
  // The old band. Its longitudes all carry IDW coverage >= 0.75, which after the
  // `cloudCoverage * 2` strength fold is effective coverage >= 0.90 — saturated
  // at every point. Its reappearance as a scored constant is the regression.
  assert.ok(
    !/const\s+BAND_LONS\s*=/.test(METAR_CODE),
    "the hard-coded saturated BAND_LONS is back",
  );
  assert.match(METAR_CODE, /selectPartialCoverageBand\(/);
  assert.match(METAR_CODE, /collectHeadroomStructural\(/);
  // The aim must be re-checked against the SCORED ch0 leg.
  assert.match(
    METAR_CODE,
    /collectHeadroomStructural\(\{[\s\S]{0,240}?samples:\s*ch0\.captures/,
    "the headroom check must read the scored ch0 leg",
  );
});

test("metar: a failed aim exits 3 and does not fall back to a saturated band", () => {
  assert.match(
    METAR_CODE,
    /if\s*\(aim\.reasons\.length\)\s*\{[\s\S]{0,900}?process\.exitCode\s*=\s*3/,
    "a missed aim must be STRUCTURAL",
  );
});

test("metar: the 0.04 bar and the 7-location count are UNCHANGED", () => {
  assert.match(METAR_CODE, /absDeltaSumMin:\s*0\.04\b/);
  assert.match(METAR_CODE, /spatialMargin:\s*0\.05\b/);
  assert.match(METAR_CODE, /BAND_COUNT\s*=\s*7\b/);
  assert.match(METAR_CODE, /absDeltaSum\s*>=\s*ASSERT\.absDeltaSumMin/);
});

test("metar: the saturated witnesses are measured but can never be scored", () => {
  assert.match(METAR_CODE, /SATURATION_WITNESS_LONS\s*=\s*\[-60,\s*0,\s*60\]/);
  assert.match(
    METAR_CODE,
    /eligible:\s*!SATURATION_WITNESS_LONS\.includes\(/,
    "witnesses must be marked ineligible for selection",
  );
});

test("metar: the calibration ladder is measured at channel strength ZERO", () => {
  // A ladder measured at strength 1 would aim gate 4 using the response leg.
  assert.match(
    METAR_CODE,
    /configuredCalibration\s*=\s*configure\(0\.0\)/,
    "the calibration ladder must run in the baseline configuration",
  );
});

test("channels: consumes the shared pinning module, holds no private copy", () => {
  assert.match(
    CHANNELS_CODE,
    /from\s+"\.\/lib\/weather-probe-pinning\.mjs"/,
    "the channels probe must import the shared pinning module",
  );
  assert.match(CHANNELS_CODE, /installWeatherPinHarnessOnPage\(page\)/);
  assert.match(CHANNELS_CODE, /collectPinStructural\(/);
  assert.match(CHANNELS_CODE, /collectRepeatStructural\(/);
  // The private copies that the shared module replaced must be gone.
  for (const copied of [
    /const\s+awaitWeatherApplied\s*=/,
    /const\s+awaitGlobeReady\s*=/,
    /const\s+binnedGlobeCommands\s*=/,
    /const\s+localNoon\s*=/,
    /const\s+FORBIDDEN_QUALITY_BITS\s*=/,
    /scratchContext\.getImageData/,
  ]) {
    assert.ok(
      !copied.test(CHANNELS_CODE),
      `a private copy of ${copied} survives the migration`,
    );
  }
});

test("channels: the determinism control BRACKETS the neutral and gated legs", () => {
  const order = ["richA", "neutral", "richOff", "richB"].map((leg) =>
    CHANNELS_CODE.indexOf(`await sweep("${leg}"`),
  );
  for (const index of order) {
    assert.ok(index > 0, "every leg must be swept");
  }
  assert.deepEqual(
    order.slice().sort((a, b) => a - b),
    order,
    `leg order must be richA -> neutral -> richOff -> richB, got ${JSON.stringify(order)}`,
  );
});

test("channels: no scored threshold moved", () => {
  assert.match(CHANNELS_CODE, /minRichMean:\s*0\.02\b/);
  assert.match(CHANNELS_CODE, /stddevMargin:\s*0\.01\b/);
  assert.match(CHANNELS_CODE, /westEastMargin:\s*0\.02\b/);
  assert.match(CHANNELS_CODE, /perLocation:\s*0\.005\b/);
  assert.match(CHANNELS_CODE, /mean:\s*0\.0025\b/);
  assert.match(CHANNELS_CODE, /brightThreshold:\s*120\b/);
  assert.match(CHANNELS_CODE, /sampleStride:\s*3\b/);
});

test("both probes keep the offline globe in their URL", () => {
  for (const [name, source] of [
    ["metar", METAR_CODE],
    ["channels", CHANNELS_CODE],
  ]) {
    assert.match(
      source,
      /renderer=webgpu&offline=true/,
      `${name} must load the offline globe`,
    );
  }
});

// ---------------------------------------------------------------------------
// The shared enforcement still behaves — regression cover for the migration
// ---------------------------------------------------------------------------

test("collectPinStructural — a healthy channels-shaped report is clean", () => {
  const out = collectPinStructural({
    pins: healthyPins(),
    dials: healthyDials(),
    globeReadiness: { setup: healthyReadiness() },
    captures: [
      { ...capture(-170), expectedChannelStrength: 1 },
      { ...capture(150), expectedChannelStrength: 1 },
      {
        ...capture(-170),
        slots: slots({ channelStrength: 0 }),
        expectedChannelStrength: 0,
      },
    ],
    applied: {
      rich: { ok: true },
      neutral: { ok: true },
      richOff: { ok: true },
    },
    brightThreshold: 120,
  });
  assert.deepEqual(out, []);
});

test("collectPinStructural — the checks the private copy lacked now fire", () => {
  const base = {
    captures: [{ ...capture(-170), expectedChannelStrength: 1 }],
    applied: { rich: { ok: true } },
    globeReadiness: { setup: healthyReadiness() },
    brightThreshold: 120,
  };
  const cases = [
    [
      "requestRenderMode",
      healthyPins({ requestRenderMode: true }),
      healthyDials(),
    ],
    ["clockMultiplier", healthyPins({ clockMultiplier: 1 }), healthyDials()],
    ["cloudQuality", healthyPins(), healthyDials({ cloudQuality: 64 })],
    [
      "cloudCastShadows",
      healthyPins(),
      healthyDials({ cloudCastShadows: true }),
    ],
    [
      "cloudContributesIBL",
      healthyPins(),
      healthyDials({ cloudContributesIBL: true }),
    ],
  ];
  for (const [name, pins, dials] of cases) {
    const out = collectPinStructural({ ...base, pins, dials });
    assert.ok(out.length > 0, `${name} must produce a STRUCTURAL reason`);
  }
});

// ---------------------------------------------------------------------------
// RULES — P10 readiness non-vacuity
//
// `awaitGlobeReady` RETURNS `{ binnedGlobeCommands: 0, firstBinnedMs: null }`
// when the budget expires with no globe; it does not throw. Before this clause
// existed the six pinned probes printed that number and nothing read it, so a
// WebGPU globe pipeline still cooking past the 90 s budget produced a RED
// product verdict over frames that were entirely the clear colour. Each rule is
// run against the real implementation AND against the mutants below.
// ---------------------------------------------------------------------------

const readinessRules = [
  [
    "G1 a zero-binned report is STRUCTURAL",
    (check) => {
      const out = check({ readiness: deadReadiness() });
      assert.ok(
        out.length > 0,
        "a globe that never binned a Pass.GLOBE command certifies nothing",
      );
    },
  ],
  [
    "G2 a healthy report is clean",
    (check) => {
      assert.deepEqual(
        check({ readiness: healthyReadiness() }),
        [],
        "a globe that rendered must not be STRUCTURAL",
      );
    },
  ],
  [
    "G3 an ABSENT report is STRUCTURAL — the vacuity that named the clause",
    (check) => {
      // A read-back a caller can simply forget to hand in is not enforcement.
      for (const readiness of [undefined, null]) {
        assert.ok(
          check({ readiness }).length > 0,
          `readiness=${String(readiness)} must be STRUCTURAL, not clean`,
        );
      }
    },
  ],
  [
    "G4 a non-finite binned count is STRUCTURAL, not silently truthy",
    (check) => {
      for (const binnedGlobeCommands of [NaN, undefined, "96", null]) {
        assert.ok(
          check({ readiness: healthyReadiness({ binnedGlobeCommands }) })
            .length > 0,
          `binnedGlobeCommands=${String(binnedGlobeCommands)} must be STRUCTURAL`,
        );
      }
    },
  ],
  [
    "G5 binned>0 with a null firstBinnedMs is an inconsistent report",
    (check) => {
      assert.ok(
        check({ readiness: healthyReadiness({ firstBinnedMs: null }) }).length >
          0,
        "a report that counts commands but never recorded when they arrived is not a proof",
      );
    },
  ],
  [
    "G6 a long but SUCCESSFUL wait is not STRUCTURAL",
    (check) => {
      // Slow is not blind. Gating on elapsedMs instead of the binned count
      // would fail this and pass G1 — which is the whole mutation.
      assert.deepEqual(
        check({
          readiness: {
            binnedGlobeCommands: 12,
            firstBinnedMs: 86_400,
            elapsedMs: 89_900,
          },
        }),
        [],
      );
    },
  ],
];

for (const [name, rule] of readinessRules) {
  test(`collectGlobeReadinessStructural — ${name}`, () => {
    rule(({ readiness }) =>
      collectGlobeReadinessStructural({ label: "setup", readiness }),
    );
  });
}

/** M10 — gates the BUDGET instead of the binned count (the classic proxy). */
const mutantReadinessElapsedOnly = ({ readiness }) =>
  (readiness?.elapsedMs ?? 0) >= 90_000 ? ["budget expired"] : [];

/** M11 — an absent report is treated as clean (the pre-repair behaviour). */
const mutantReadinessAbsentOk = ({ readiness }) =>
  readiness === undefined || readiness === null
    ? []
    : collectGlobeReadinessStructural({ label: "setup", readiness });

/** M12 — `>= 0` instead of `> 0`, so zero binned commands passes. */
const mutantReadinessNonNegative = ({ readiness }) =>
  (readiness?.binnedGlobeCommands ?? -1) >= 0 ? [] : ["negative"];

/** M13 — truthiness test, so NaN and "96" and 0 all misclassify. */
const mutantReadinessTruthy = ({ readiness }) =>
  readiness && readiness.binnedGlobeCommands ? [] : ["no readiness"];

const READINESS_MUTANTS = [
  ["M10 gates elapsedMs, not the binned count", mutantReadinessElapsedOnly],
  ["M11 an absent report is clean", mutantReadinessAbsentOk],
  ["M12 accepts binned === 0", mutantReadinessNonNegative],
  ["M13 truthiness instead of a finite positive count", mutantReadinessTruthy],
];

test("collectGlobeReadinessStructural — mutant rejection (every mutant caught)", () => {
  for (const [mutantName, mutant] of READINESS_MUTANTS) {
    let caught = false;
    for (const [, rule] of readinessRules) {
      try {
        rule(mutant);
      } catch {
        caught = true;
        break;
      }
    }
    assert.ok(caught, `${mutantName} survived every rule — the spec is blind`);
  }
});

test("collectPinStructural — the P10 clause is REACHED, not merely exported", () => {
  // M14, the mutation that matters most: a perfectly enforced standalone helper
  // that `collectPinStructural` never calls is the defect verbatim. Everything
  // else in this report is healthy, so only the readiness clause can speak.
  const healthy = {
    pins: healthyPins(),
    dials: healthyDials(),
    captures: [{ ...capture(-170), expectedChannelStrength: 1 }],
    applied: { rich: { ok: true } },
    brightThreshold: 120,
  };
  const dead = collectPinStructural({
    ...healthy,
    globeReadiness: { setup: deadReadiness() },
  });
  assert.ok(
    dead.some((reason) => /binned a Pass\.GLOBE command/.test(reason)),
    `a zero-binned globe must reach collectPinStructural's output, got ${JSON.stringify(dead)}`,
  );

  // An omitted key must not be silently clean either.
  assert.ok(
    collectPinStructural(healthy).length > 0,
    "an omitted globeReadiness must be STRUCTURAL",
  );
  assert.ok(
    collectPinStructural({ ...healthy, globeReadiness: {} }).length > 0,
    "an empty globeReadiness map asserts nothing and must be STRUCTURAL",
  );
});

test("every pinned weather probe hands its readiness to the enforcement layer", () => {
  // The lib can only enforce what the probes pass it. This is the anchor that
  // stops a future probe from printing `readiness` and gating nothing again.
  for (const name of [
    "channels",
    "edr-mock",
    "ingest",
    "metar",
    "seam-poles",
    "wcs",
  ]) {
    const source = stripComments(
      readNormalized(`Tools/visual-regression/probe-weather-${name}.mjs`),
    );
    assert.match(
      source,
      /globeReadiness:\s*\{[^}]*globeReady[^}]*\}/,
      `probe-weather-${name}.mjs must pass globeReadiness to collectPinStructural`,
    );
    // And it must not have grown a private copy of the readiness loop.
    assert.ok(
      !/const\s+awaitGlobeReady\s*=/.test(source),
      `probe-weather-${name}.mjs holds a private awaitGlobeReady copy — the shared fix cannot reach it`,
    );
  }
});

// ---------------------------------------------------------------------------
// RULES — `subjectDials`, the ONLY sanctioned way to be exempt from a pin
//
// A probe whose SUBJECT is a determinism dial (probe-cloud-shadows-polar toggles
// `cloudCastShadows`) must be able to say so. That is a loosening path, so it is
// spelled out here: what it exempts, what it does NOT exempt, and that the
// default behaviour is unchanged when it is absent.
// ---------------------------------------------------------------------------

test("subjectDials — an exemptible dial declared as the subject is not STRUCTURAL", () => {
  const base = {
    pins: healthyPins(),
    captures: [capture(-170)],
    applied: { rich: { ok: true } },
    globeReadiness: { setup: healthyReadiness() },
  };
  assert.deepEqual(
    collectPinStructural({
      ...base,
      dials: healthyDials({ cloudCastShadows: true }),
      subjectDials: ["cloudCastShadows"],
    }),
    [],
  );
});

test("subjectDials — absent, the pin still fires (the exemption is opt-in only)", () => {
  const base = {
    pins: healthyPins(),
    captures: [capture(-170)],
    applied: { rich: { ok: true } },
    globeReadiness: { setup: healthyReadiness() },
  };
  assert.ok(
    collectPinStructural({
      ...base,
      dials: healthyDials({ cloudCastShadows: true }),
    }).length > 0,
    "without a declaration, a cast-shadow pin that did not take must be STRUCTURAL",
  );
});

test("subjectDials — declaring one dial does not exempt the other", () => {
  const out = collectPinStructural({
    pins: healthyPins(),
    dials: healthyDials({ cloudCastShadows: true, cloudContributesIBL: true }),
    captures: [capture(-170)],
    applied: { rich: { ok: true } },
    globeReadiness: { setup: healthyReadiness() },
    subjectDials: ["cloudCastShadows"],
  });
  assert.ok(
    out.some((reason) => /cloudContributesIBL/.test(reason)),
    `the undeclared dial must still fire, got ${JSON.stringify(out)}`,
  );
  assert.ok(
    !out.some((reason) => /cloudCastShadows pin did not take/.test(reason)),
    "the declared dial must not fire",
  );
});

test("subjectDials — wind and the tier escape are NOT exemptible", () => {
  for (const name of ["cloudWindSpeed", "cloudQuality", "requestRenderMode"]) {
    const out = collectPinStructural({
      pins: healthyPins(),
      dials: healthyDials(),
      captures: [capture(-170)],
      applied: { rich: { ok: true } },
      globeReadiness: { setup: healthyReadiness() },
      subjectDials: [name],
    });
    assert.ok(
      out.some((reason) => reason.includes("not exemptible")),
      `${name} must be rejected as a subject dial`,
    );
  }
});

test("cloud-shadows-polar consumes the shared pinning module and declares its subject", () => {
  // The probe was missed by the Batch-855 sweep because that sweep selected by
  // the `probe-weather-*` FILENAME glob rather than by instrument shape. This
  // anchor is what stops it drifting back off the shared module.
  const source = stripComments(
    readNormalized("Tools/visual-regression/probe-cloud-shadows-polar.mjs"),
  );
  assert.match(source, /from\s+"\.\/lib\/weather-probe-pinning\.mjs"/);
  assert.match(source, /installWeatherPinHarnessOnPage\(page\)/);
  assert.match(source, /renderer=webgpu&offline=true/);
  assert.match(source, /globeReadiness:\s*\{[^}]*globeReady[^}]*\}/);
  assert.match(source, /subjectDials:\s*\["cloudCastShadows"\]/);
  assert.match(source, /collectRepeatStructural\(/);
  // The scored bar is UNCHANGED by the pinning pass.
  assert.match(source, /delta\s*>\s*0\.5/);
  // No bare `s.render()` may survive: that is what substitutes JulianDate.now().
  assert.ok(
    !/\bs\.render\(\)/.test(source) && !/\bscene\.render\(\)/.test(source),
    "a bare render() reintroduces the wall clock the pinning removed",
  );
});

test("collectRepeatStructural — a bracketing control catches a drifting leg", () => {
  const a = [-170, -130, -90].map((lon, i) => ({
    key: lon,
    value: 0.5 + i * 0.01,
    time: 1000,
  }));
  const clean = collectRepeatStructural({
    label: "richA vs richB",
    a,
    b: a.map((s) => ({ ...s })),
    perSample: 0.005,
    mean: 0.0025,
  });
  assert.deepEqual(clean.reasons, []);

  const drifted = collectRepeatStructural({
    label: "richA vs richB",
    a,
    b: a.map((s, i) => ({ ...s, value: i === 0 ? 1.0 : s.value })),
    perSample: 0.005,
    mean: 0.0025,
  });
  assert.ok(
    drifted.reasons.length > 0,
    "a 0.000->1.000 flip across the bracket must be STRUCTURAL",
  );

  const timeDrifted = collectRepeatStructural({
    label: "richA vs richB",
    a,
    b: a.map((s) => ({ ...s, time: 1001 })),
    perSample: 0.005,
    mean: 0.0025,
  });
  assert.ok(
    timeDrifted.reasons.length > 0,
    "a cloud time-uniform drift must be STRUCTURAL",
  );
});
