// weather-probe-headroom.spec.mjs — browser-free guard for the Batch-861
// Gate-B repairs and the pinning fleet's transitive immutable-capture doctrine.
// @purpose Guard Gate-B headroom/determinism repairs plus canonical immutable capture across the shared weather pinning helper and every direct consumer.
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
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import {
  collectGlobeReadinessStructural,
  collectHeadroomStructural,
  collectPinStructural,
  collectRepeatStructural,
  COVERAGE_HEADROOM_BAND,
  inHeadroomBand,
  installWeatherPinHarness,
  installWeatherPinHarnessOnPage,
  selectPartialCoverageBand,
} from "./lib/weather-probe-pinning.mjs";
import { FUSED_SNAPSHOT_CAPTURE_SOURCE } from "./lib/same-task-capture.mjs";
import {
  analyzeWeatherCaptureConsumer,
  analyzeWeatherCaptureDoctrine,
  censusWeatherCaptureConsumers,
  formatWeatherCaptureFailures,
  WEATHER_CAPTURE_FAILURE,
} from "./lib/weather-capture-doctrine.mjs";

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

const WEATHER_PINNING = readNormalized(
  "Tools/visual-regression/lib/weather-probe-pinning.mjs",
);

const CAPTURE_CANDIDATE_PATHS = Object.freeze(
  readdirSync(HERE)
    .filter((name) => /^probe-.*\.mjs$/u.test(name))
    .map((name) => `Tools/visual-regression/${name}`)
    .sort(),
);
const CAPTURE_CANDIDATE_SOURCES = Object.freeze(
  Object.fromEntries(
    CAPTURE_CANDIDATE_PATHS.map((relative) => [
      relative,
      readNormalized(relative),
    ]),
  ),
);
const CAPTURE_CENSUS = censusWeatherCaptureConsumers(CAPTURE_CANDIDATE_SOURCES);
const CAPTURE_CONSUMER_PATHS = CAPTURE_CENSUS.paths;
const CAPTURE_CONSUMERS = CAPTURE_CENSUS.consumers;

const weatherCaptureDoctrineFailures = ({
  candidateSources = CAPTURE_CANDIDATE_SOURCES,
  consumers = CAPTURE_CONSUMERS,
  pinning = WEATHER_PINNING,
  snapshot = FUSED_SNAPSHOT_CAPTURE_SOURCE,
} = {}) =>
  analyzeWeatherCaptureDoctrine({
    candidateSources,
    consumers,
    pinning,
    snapshot,
  });

const captureConsumerFixture = (
  body = "",
) => `const pin = globalThis.__weatherPin;
const bandMean = (frame) => {
  let sum = 0;
  for (const value of frame.data) sum += value;
  return sum;
};
const metricFrame = await pin.capture(0, true);
const metric = bandMean(metricFrame);
const documentaryPng = metricFrame.png;
void metric;
void documentaryPng;
${body}`;

const captureConsumerFailures = (body = "") =>
  analyzeWeatherCaptureConsumer(captureConsumerFixture(body), {
    relative: "reviewer-capture-mutant.mjs",
  }).failures;

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

test("an unparseable consumer is a PARSE_ERROR red, never a silent skip", () => {
  const { failures } = analyzeWeatherCaptureConsumer("const broken = (;", {
    relative: "Tools/visual-regression/probe-weather-fixture-broken.mjs",
  });
  assert.ok(failures.length > 0, "an unparseable source produced no failure");
  assert.ok(
    failures.some((f) => f.code === WEATHER_CAPTURE_FAILURE.PARSE_ERROR),
    "the failure is not classified parse-error: " + JSON.stringify(failures),
  );
});

test("capture doctrine traverses the shared helper and every direct probe consumer", () => {
  assert.deepEqual(CAPTURE_CONSUMER_PATHS, [
    "Tools/visual-regression/probe-cloud-shadows-flagon.mjs",
    "Tools/visual-regression/probe-cloud-shadows-polar.mjs",
    "Tools/visual-regression/probe-eclipse-cloud-response.mjs",
    "Tools/visual-regression/probe-weather-channels.mjs",
    "Tools/visual-regression/probe-weather-edr-mock.mjs",
    "Tools/visual-regression/probe-weather-ingest.mjs",
    "Tools/visual-regression/probe-weather-metar.mjs",
    "Tools/visual-regression/probe-weather-seam-poles.mjs",
    "Tools/visual-regression/probe-weather-wcs.mjs",
  ]);
  assert.deepEqual(weatherCaptureDoctrineFailures(), []);
});

test("capture installer emits one parseable canonical init script and fails closed without it", async () => {
  let installed;
  const page = {
    async addInitScript(options) {
      installed = options;
    },
  };
  await installWeatherPinHarnessOnPage(page);
  assert.deepEqual(Object.keys(installed), ["content"]);
  assert.match(
    installed.content,
    /const makeFusedSnapshotCapture = \(scene, canvas, timeFn\) =>/u,
  );
  assert.match(installed.content, /\(makeFusedSnapshotCapture\);\s*$/u);
  assert.doesNotThrow(() => new Script(installed.content));
  assert.throws(
    () => installWeatherPinHarness(),
    /requires the canonical fused snapshot helper/u,
  );
});

test("capture doctrine rejects transitive and consumer mutants", () => {
  const eclipsePath =
    "Tools/visual-regression/probe-eclipse-cloud-response.mjs";
  const eclipse = CAPTURE_CONSUMERS[eclipsePath];
  const withEclipse = (mutated) => ({
    ...CAPTURE_CONSUMERS,
    [eclipsePath]: mutated,
  });
  const replaceExactlyOnce = (source, before, after, label) => {
    assert.equal(
      source.split(before).length - 1,
      1,
      `${label} fixture must match exactly once`,
    );
    return source.replace(before, after);
  };
  const mutants = [
    [
      "shared-helper live-canvas drawImage/getImageData",
      {
        pinning: replaceExactlyOnce(
          WEATHER_PINNING,
          "const snapshotPromise = fused.captureSnapshot();",
          `const live = document.createElement("canvas").getContext("2d");
      live.drawImage(canvas, 0, 0);
      live.getImageData(0, 0, canvas.width, canvas.height);
      const snapshotPromise = fused.captureSnapshot();`,
          "shared-helper live read",
        ),
      },
      /weather pinning reads the live WebGPU canvas/u,
    ],
    [
      "consumer live-canvas drawImage/getImageData",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const frame = await pin.capture(julian, wantPng);",
            `const liveContext = document.createElement("canvas").getContext("2d");
    liveContext.drawImage(scene.canvas, 0, 0);
    liveContext.getImageData(0, 0, scene.canvas.width, scene.canvas.height);
    const frame = await pin.capture(julian, wantPng);`,
            "consumer live read",
          ),
        ),
      },
      /drawImage bypasses|getImageData bypasses/u,
    ],
    [
      "consumer live-canvas aliases",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const frame = await pin.capture(julian, wantPng);",
            `const liveContext = document.createElement("canvas").getContext("2d");
    const drawLive = liveContext.drawImage.bind(liveContext);
    const { getImageData: readLive } = liveContext;
    drawLive(scene.canvas, 0, 0);
    readLive(0, 0, scene.canvas.width, scene.canvas.height);
    const frame = await pin.capture(julian, wantPng);`,
            "consumer aliased live read",
          ),
        ),
      },
      /drawImage bypasses|getImageData bypasses/u,
    ],
    [
      "separate documentary capture",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `const documentaryFrame = await pin.capture(julian, true);
    const offCloudsPng = deepest ? documentaryFrame.png : null;`,
            "separate documentary frame",
          ),
        ),
      },
      /documentary PNG uses a separate capture/u,
    ],
    [
      "separate documentary capture through a member alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `const documentaryFrame = await pin.capture(julian, true);
    const documentaryFrames = { offClouds: documentaryFrame };
    const offCloudsPng = deepest ? documentaryFrames.offClouds.png : null;`,
            "member-aliased documentary frame",
          ),
        ),
      },
      /documentary PNG uses a separate capture/u,
    ],
    [
      "separate documentary wrapper capture",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `const documentaryFrame = await captureLabelled(
      "documentary-only",
      julian,
      true,
    );
    const offCloudsPng = deepest ? documentaryFrame.png : null;`,
            "separate documentary wrapper frame",
          ),
        ),
      },
      /documentary PNG uses a separate capture/u,
    ],
    [
      "separate documentary capture through nested member aliases",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `const documentaryFrame = await pin.capture(julian, true);
    const documentaryFrames = { deepest: { frame: documentaryFrame } };
    const documentaryAlias = documentaryFrames.deepest.frame;
    const offCloudsPng = deepest ? documentaryAlias.png : null;`,
            "nested-member documentary frame",
          ),
        ),
      },
      /documentary PNG uses a separate capture/u,
    ],
    [
      "floating direct capture",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false)",
            "pin.capture(firstTime, false)",
            "floating direct capture",
          ),
        ),
      },
      /pin\.capture invocation is not awaited/u,
    ],
    [
      "floating capture alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const captureAlias = pin.capture;
  captureAlias(firstTime, false); // discarded on purpose`,
            "floating capture alias",
          ),
        ),
      },
      /captureAlias invocation is not awaited/u,
    ],
    [
      "floating bound capture alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const captureAlias = pin["capture"].bind(pin);
  captureAlias(firstTime, false); // discarded on purpose`,
            "floating bound capture alias",
          ),
        ),
      },
      /captureAlias invocation is not awaited/u,
    ],
    [
      "floating destructured capture alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const { capture: captureAlias } = pin;
  captureAlias(firstTime, false); // discarded on purpose`,
            "floating destructured capture alias",
          ),
        ),
      },
      /captureAlias invocation is not awaited/u,
    ],
    [
      "floating thin wrapper",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const captureWrapper = async (...args) => await pin.capture(...args);
  captureWrapper(firstTime, false); // discarded on purpose`,
            "floating thin wrapper",
          ),
        ),
      },
      /captureWrapper invocation is not awaited/u,
    ],
    [
      "floating member alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const captureTools = { take: pin.capture };
  captureTools.take(firstTime, false); // discarded on purpose`,
            "floating member alias",
          ),
        ),
      },
      /captureTools\.take invocation is not awaited/u,
    ],
    [
      "floating member thin wrapper",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "await pin.capture(firstTime, false); // discarded on purpose",
            `const captureTools = {
    take: async (...args) => await pin.capture(...args),
  };
  captureTools.take(firstTime, false); // discarded on purpose`,
            "floating member thin wrapper",
          ),
        ),
      },
      /captureTools\.take invocation is not awaited/u,
    ],
    [
      "consumer-local documentary render",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `scene.render(julian);
    const offCloudsPng = deepest ? aOffCloudsFrame.png : null;`,
            "consumer-local render",
          ),
        ),
      },
      /consumer-local render creates a second capture source/u,
    ],
    [
      "consumer-local documentary render alias",
      {
        consumers: withEclipse(
          replaceExactlyOnce(
            eclipse,
            "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
            `const { render: documentaryRender } = scene;
    documentaryRender(julian);
    const offCloudsPng = deepest ? aOffCloudsFrame.png : null;`,
            "consumer-local render alias",
          ),
        ),
      },
      /consumer-local render creates a second capture source/u,
    ],
    [
      "decode gap before freeze",
      {
        snapshot: replaceExactlyOnce(
          FUSED_SNAPSHOT_CAPTURE_SOURCE,
          'const dataUrl = canvas.toDataURL("image/png");',
          'await Promise.resolve();\n    const dataUrl = canvas.toDataURL("image/png");',
          "decode gap",
        ),
      },
      /canonical snapshot yields before freezing/u,
    ],
    [
      "canonical helper not installed",
      {
        pinning: replaceExactlyOnce(
          WEATHER_PINNING,
          "(${installWeatherPinHarness.toString()})(makeFusedSnapshotCapture);",
          "canonical helper intentionally omitted",
          "canonical helper omission",
        ),
      },
      /canonical snapshot factory is not installed/u,
    ],
  ];

  for (const [name, mutant, expected] of mutants) {
    const failures = weatherCaptureDoctrineFailures(mutant);
    assert.match(
      formatWeatherCaptureFailures(failures),
      expected,
      `${name} survived or tripped only an unrelated capture rule`,
    );
  }
});

test("capture doctrine rejects every independently reproduced alias/computed bypass and their combined mutant", () => {
  const eclipsePath =
    "Tools/visual-regression/probe-eclipse-cloud-response.mjs";
  const eclipse = CAPTURE_CONSUMERS[eclipsePath];
  const replaceExactlyOnce = (source, before, after, label) => {
    assert.equal(
      source.split(before).length - 1,
      1,
      `${label} fixture must match exactly once`,
    );
    return source.replace(before, after);
  };
  const auditEclipse = (mutated) =>
    weatherCaptureDoctrineFailures({
      consumers: { ...CAPTURE_CONSUMERS, [eclipsePath]: mutated },
    });
  const warmup = "await pin.capture(firstTime, false); // discarded on purpose";
  const documentary =
    "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;";
  const captureWrapper = "const frame = await pin.capture(julian, wantPng);";

  const cases = [
    {
      code: WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
      name: "nested object documentary container alias",
      source: replaceExactlyOnce(
        eclipse,
        documentary,
        `const documentaryFrame = await pin.capture(julian, true);
    const holder = { deep: { frame: documentaryFrame } };
    const alias = holder;
    const offCloudsPng = deepest ? alias.deep.frame.png : null;`,
        "nested object documentary container",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
      name: "nested array/numeric documentary container alias",
      source: replaceExactlyOnce(
        eclipse,
        documentary,
        `const documentaryFrame = await pin.capture(julian, true);
    const holder = [{ deep: [documentaryFrame] }];
    const alias = holder;
    const offCloudsPng = deepest ? alias[0].deep[0].png : null;`,
        "nested array documentary container",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "computed drawImage",
      source: replaceExactlyOnce(
        eclipse,
        captureWrapper,
        `const liveContext = document.createElement("canvas").getContext("2d");
    liveContext["draw" + "Image"](scene.canvas, 0, 0);
    const frame = await pin.capture(julian, wantPng);`,
        "computed drawImage",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "computed getImageData",
      source: replaceExactlyOnce(
        eclipse,
        captureWrapper,
        `const liveContext = document.createElement("canvas").getContext("2d");
    liveContext["get" + "ImageData"](0, 0, scene.canvas.width, scene.canvas.height);
    const frame = await pin.capture(julian, wantPng);`,
        "computed getImageData",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
      name: "computed render",
      source: replaceExactlyOnce(
        eclipse,
        documentary,
        `scene["ren" + "der"](julian);
    const offCloudsPng = deepest ? aOffCloudsFrame.png : null;`,
        "computed render",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "array/numeric capture callable",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        "[pin.capture][0](firstTime, false); // discarded on purpose",
        "array capture callable",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "Reflect.get capture callable",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `Reflect.get(pin, "capture")(firstTime, false); // discarded on purpose`,
        "Reflect.get capture callable",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "Function.prototype.bind.call capture callable",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `Function.prototype.bind.call(pin.capture, pin)(firstTime, false); // discarded on purpose`,
        "bind.call capture callable",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "thin sequence wrapper",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const sequenceWrapper = (...args) => (0, pin.capture)(...args);
  sequenceWrapper(firstTime, false); // discarded on purpose`,
        "thin sequence wrapper",
      ),
    },
  ];

  for (const { code, name, source } of cases) {
    const failures = auditEclipse(source);
    assert.ok(
      failures.some((failure) => failure.code === code),
      `${name} survived or tripped only an unrelated rule:\n${formatWeatherCaptureFailures(failures)}`,
    );
  }

  let combined = replaceExactlyOnce(
    eclipse,
    warmup,
    `const captureArray = [pin.capture];
  captureArray[0](firstTime, false);
  Reflect.get(pin, "capture")(firstTime, false);
  Function.prototype.bind.call(pin.capture, pin)(firstTime, false);
  const sequenceWrapper = (...args) => (0, pin.capture)(...args);
  sequenceWrapper(firstTime, false); // discarded on purpose`,
    "combined capture aliases",
  );
  combined = replaceExactlyOnce(
    combined,
    captureWrapper,
    `const liveContext = document.createElement("canvas").getContext("2d");
    liveContext["draw" + "Image"](scene.canvas, 0, 0);
    liveContext["get" + "ImageData"](0, 0, scene.canvas.width, scene.canvas.height);
    scene["ren" + "der"](julian);
    const frame = await pin.capture(julian, wantPng);`,
    "combined computed reads",
  );
  combined = replaceExactlyOnce(
    combined,
    documentary,
    `const documentaryCapture = pin.capture;
    const documentaryFrame = await documentaryCapture(julian, true);
    const holder = [{ deep: { frame: documentaryFrame } }];
    const alias = holder;
    const offCloudsPng = deepest ? alias[0].deep.frame.png : null;`,
    "combined documentary alias",
  );
  const combinedCodes = new Set(
    auditEclipse(combined).map((failure) => failure.code),
  );
  for (const code of [
    WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
    WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
    WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
    WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
  ]) {
    assert.ok(combinedCodes.has(code), `combined mutant must reach ${code}`);
  }
});

test("capture consumer census includes named, namespace, and dynamic imports", () => {
  const sources = {
    "dynamic.mjs": `const weather = await import("./lib/weather-probe-pinning.mjs");
weather.installWeatherPinHarnessOnPage(page);`,
    "named.mjs": `import { installWeatherPinHarnessOnPage as install } from "./lib/weather-probe-pinning.mjs";
await install(page);`,
    "namespace.mjs": `import * as weather from "./lib/weather-probe-pinning.mjs";
await weather.installWeatherPinHarnessOnPage(page);`,
    "pure-only.mjs": `import { collectPinStructural } from "./lib/weather-probe-pinning.mjs";
collectPinStructural(report);`,
  };
  const census = censusWeatherCaptureConsumers(sources);
  assert.deepEqual(census.failures, []);
  assert.deepEqual(census.paths, ["dynamic.mjs", "named.mjs", "namespace.mjs"]);
  assert.deepEqual(census.modes, {
    "dynamic.mjs": ["dynamic"],
    "named.mjs": ["named"],
    "namespace.mjs": ["namespace"],
  });

  const failures = weatherCaptureDoctrineFailures({
    candidateSources: sources,
    consumers: {},
  });
  assert.equal(
    failures.filter(
      (failure) => failure.code === WEATHER_CAPTURE_FAILURE.UNTRACKED_CONSUMER,
    ).length,
    3,
    "every import form must enter the fail-closed direct-consumer census",
  );
});

test("capture doctrine fails closed on dynamic members, returned callables/frames, and unsupported escapes", () => {
  const eclipsePath =
    "Tools/visual-regression/probe-eclipse-cloud-response.mjs";
  const eclipse = CAPTURE_CONSUMERS[eclipsePath];
  const warmup = "await pin.capture(firstTime, false); // discarded on purpose";
  const documentary =
    "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;";
  const captureWrapper = "const frame = await pin.capture(julian, wantPng);";
  const replaceExactlyOnce = (source, before, after, label) => {
    assert.equal(
      source.split(before).length - 1,
      1,
      `${label} fixture must match exactly once`,
    );
    return source.replace(before, after);
  };
  const audit = (mutated) =>
    weatherCaptureDoctrineFailures({
      consumers: { ...CAPTURE_CONSUMERS, [eclipsePath]: mutated },
    });
  const cases = [
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "unknown live-reader member",
      source: replaceExactlyOnce(
        eclipse,
        captureWrapper,
        `const liveContext = document.createElement("canvas").getContext("2d");
    const liveMethod = globalThis.__unknownLiveMethod;
    liveContext[liveMethod](scene.canvas, 0, 0);
    const frame = await pin.capture(julian, wantPng);`,
        "unknown live reader",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_RENDER,
      name: "unknown scene method",
      source: replaceExactlyOnce(
        eclipse,
        documentary,
        `const renderMethod = globalThis.__unknownRenderMethod;
    scene[renderMethod](julian);
    const offCloudsPng = deepest ? aOffCloudsFrame.png : null;`,
        "unknown render",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
      name: "unknown weather-pin member",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const captureMethod = globalThis.__unknownCaptureMethod;
  pin[captureMethod](firstTime, false); // discarded on purpose`,
        "unknown capture member",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
      name: "dynamic Reflect.get weather-pin member",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const captureMethod = globalThis.__unknownCaptureMethod;
  Reflect.get(pin, captureMethod)(firstTime, false); // discarded on purpose`,
        "dynamic Reflect.get capture",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
      name: "callable passed to an unsupported consumer",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const consumeCallable = (value) => value;
  consumeCallable(pin.capture);
  await pin.capture(firstTime, false); // discarded on purpose`,
        "capture callable argument escape",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
      name: "callable spread escape",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const captureHolder = { take: pin.capture };
  const escapedCaptureHolder = { ...captureHolder };
  void escapedCaptureHolder;
  await pin.capture(firstTime, false); // discarded on purpose`,
        "capture callable spread",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "returned capture callable",
      source: replaceExactlyOnce(
        eclipse,
        warmup,
        `const returnCapture = () => pin.capture;
  returnCapture()(firstTime, false); // discarded on purpose`,
        "returned capture callable",
      ),
    },
    {
      code: WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
      name: "returned nested documentary frame",
      source: replaceExactlyOnce(
        eclipse,
        documentary,
        `const returnDocumentaryFrame = async () => ({
      deep: await pin.capture(julian, true),
    });
    const documentaryHolder = await returnDocumentaryFrame();
    const offCloudsPng = deepest ? documentaryHolder.deep.png : null;`,
        "returned documentary frame",
      ),
    },
  ];

  for (const { code, name, source } of cases) {
    const failures = audit(source);
    assert.ok(
      failures.some((failure) => failure.code === code),
      `${name} survived or tripped only an unrelated rule:\n${formatWeatherCaptureFailures(failures)}`,
    );
  }

  const awaitedReturnedCallable = replaceExactlyOnce(
    eclipse,
    warmup,
    `const returnCapture = () => pin.capture;
  await returnCapture()(firstTime, false); // discarded on purpose`,
    "awaited returned capture callable",
  );
  assert.deepEqual(audit(awaitedReturnedCallable), []);

  const sameOriginReturnedFrame = replaceExactlyOnce(
    eclipse,
    documentary,
    `const returnMetricFrame = async () => ({
      deep: await pin.capture(julian, true),
    });
    const metricHolder = await returnMetricFrame();
    const metricWitness = bandMean(metricHolder.deep);
    const offCloudsPng = deepest ? metricHolder.deep.png : null;
    void metricWitness;`,
    "same-origin returned metric frame",
  );
  assert.deepEqual(audit(sameOriginReturnedFrame), []);
});

test("capture doctrine accepts awaited aliases/wrappers and same-frame documentary aliases", () => {
  const eclipsePath =
    "Tools/visual-regression/probe-eclipse-cloud-response.mjs";
  const eclipse = CAPTURE_CONSUMERS[eclipsePath];
  const checkEclipse = (mutated) =>
    weatherCaptureDoctrineFailures({
      consumers: { ...CAPTURE_CONSUMERS, [eclipsePath]: mutated },
    });
  const replacements = [
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const captureAlias = pin.capture;
  await captureAlias(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const captureAlias = pin.capture;
  const captureWrapper = async (...args) => await captureAlias(...args);
  await captureWrapper(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const captureTools = { take: pin.capture };
  await captureTools.take(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
      `const metricFrames = { offClouds: aOffCloudsFrame };
    const offCloudsPng = deepest ? metricFrames.offClouds.png : null;`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `await [pin.capture][0](firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `await Reflect.get(pin, "capture")(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `await Function.prototype.bind.call(pin.capture, pin)(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `const sequenceWrapper = (...args) => (0, pin.capture)(...args);
  await sequenceWrapper(firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `await pin["cap" + "ture"](firstTime, false); // discarded on purpose`,
    ),
    eclipse.replace(
      "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
      `const metricFrames = { deep: { frame: aOffCloudsFrame } };
    const metricAlias = metricFrames;
    const offCloudsPng = deepest ? metricAlias.deep.frame.png : null;`,
    ),
    eclipse.replace(
      "const offCloudsPng = deepest ? aOffCloudsFrame.png : null;",
      `const metricFrames = [{ deep: [aOffCloudsFrame] }];
    const metricAlias = metricFrames;
    const offCloudsPng = deepest
      ? metricAlias[0]["de" + "ep"][0].png
      : null;`,
    ),
    eclipse.replace(
      "await pin.capture(firstTime, false); // discarded on purpose",
      `Math["ma" + "x"](0, 1);
  await pin.capture(firstTime, false); // discarded on purpose`,
    ),
  ];

  for (const [index, replacement] of replacements.entries()) {
    assert.notEqual(
      replacement,
      eclipse,
      `positive transform ${index} applied`,
    );
    assert.deepEqual(
      checkEclipse(replacement),
      [],
      `valid awaited/same-frame alias transform ${index} was rejected`,
    );
  }
});

test("capture doctrine requires executable canonical helper semantics, not inert proof text", () => {
  const before = "const snapshotPromise = fused.captureSnapshot();";
  assert.equal(WEATHER_PINNING.split(before).length - 1, 1);
  const pinning = WEATHER_PINNING.replace(
    before,
    `const inertProof = "const snapshotPromise = fused.captureSnapshot();";
      void inertProof;
      const snapshotPromise = Promise.resolve({
        dataUrl: "data:image/png;base64,",
        imageData: { data: new Uint8ClampedArray(4), width: 1, height: 1 },
      });`,
  );
  const failures = weatherCaptureDoctrineFailures({ pinning });
  assert.ok(
    failures.some(
      (failure) => failure.code === WEATHER_CAPTURE_FAILURE.CAPTURE_ORDER,
    ),
    formatWeatherCaptureFailures(failures),
  );
});

test("capture taint reaches calls through aggregates, callbacks, reflection, and classes", () => {
  const livePrefix = `const scene = globalThis.viewer.scene;
const live = document.createElement("canvas").getContext("2d");`;
  const cases = [
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "dynamic object aliases plus call",
      source: `${livePrefix}
const operations = { nested: { draw: live.drawImage, read: live.getImageData } };
const alias = operations.nested;
alias.draw.call(live, scene.canvas, 0, 0);
alias.read.call(live, 0, 0, 1, 1);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "Reflect.get container plus Reflect.apply",
      source: `${livePrefix}
const operations = { read: live.getImageData };
const read = Reflect.get(operations, "read");
Reflect.apply(read, live, [0, 0, 1, 1]);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "bound live reader through callback",
      source: `${livePrefix}
const invoke = (callback, ...args) => callback(...args);
const draw = live.drawImage.bind(live);
invoke(draw, scene.canvas, 0, 0);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "Array.at capture callable",
      source: `const captures = [];
captures.push(pin.capture);
captures.at(-1)(1, false);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "Array.pop capture callable",
      source: `const captures = [];
captures.push(pin.capture);
captures.pop()(1, false);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "Map.get capture callable",
      source: `const captures = new Map();
captures.set("take", pin.capture);
captures.get("take")(1, false);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      name: "class-returned capture callable",
      source: `class CaptureCarrier {
  take() { return pin.capture; }
}
const carrier = new CaptureCarrier();
carrier.take()(1, false);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNSUPPORTED_CAPTURE_ESCAPE,
      name: "unmodelled tainted constructor",
      source: `const UnknownCarrier = globalThis.UnknownCarrier;
new UnknownCarrier(pin.capture);`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
      name: "unmodelled bound-reader consumer",
      source: `${livePrefix}
const consume = globalThis.consume;
consume(live.getImageData.bind(live));`,
    },
    {
      code: WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
      companionCode: WEATHER_CAPTURE_FAILURE.UNTRUSTED_INTRINSIC,
      name: "shadowed Promise.all",
      source: `const Promise = {
  all(values) { return globalThis.Promise.resolve(values.length); },
};
await Promise.all([pin.capture(1, false)]);`,
    },
  ];

  for (const { code, companionCode, name, source } of cases) {
    const failures = captureConsumerFailures(source);
    assert.ok(
      failures.some((failure) => failure.code === code),
      `${name}:\n${formatWeatherCaptureFailures(failures)}`,
    );
    if (companionCode) {
      assert.ok(
        failures.some((failure) => failure.code === companionCode),
        `${name} must also reject the shadowed intrinsic:\n${formatWeatherCaptureFailures(failures)}`,
      );
    }
  }
});

test("capture taint accepts modeled operations when every capture promise is adopted", () => {
  const inverses = [
    `const captures = [];
captures.push(pin.capture);
await captures.at(-1)(1, false);`,
    `const captures = [];
captures.push(pin.capture);
await captures.pop()(1, false);`,
    `const captures = new Map();
captures.set("take", pin.capture);
await captures.get("take")(1, false);`,
    `class CaptureCarrier {
  take() { return pin.capture; }
}
const carrier = new CaptureCarrier();
await carrier.take()(1, false);`,
    `await Reflect.apply(pin.capture, pin, [1, false]);`,
    `const invoke = (callback, ...args) => callback(...args);
await invoke(pin.capture, 1, false);`,
    `await Promise.all([pin.capture(1, false)]);`,
  ];
  for (const [index, inverse] of inverses.entries()) {
    assert.deepEqual(
      captureConsumerFailures(inverse),
      [],
      `modeled awaited inverse ${index} was rejected`,
    );
  }
});

test("documentary capture must reach a scored reducer; unused pixel touches do not qualify", () => {
  for (const field of ["width", "data"]) {
    const failures = captureConsumerFailures(
      `const documentaryFrame = await pin.capture(2, true);
void documentaryFrame.${field};
const separatePng = documentaryFrame.png;
void separatePng;`,
    );
    assert.ok(
      failures.some(
        (failure) =>
          failure.code === WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
      ),
      `unused .${field} touch laundered documentary origin:\n${formatWeatherCaptureFailures(failures)}`,
    );
  }

  const fakeReducer = analyzeWeatherCaptureConsumer(
    `const pin = globalThis.__weatherPin;
const bandMean = (frame) => { void frame.data; return 0; };
const documentaryFrame = await pin.capture(2, true);
const fakeMetric = bandMean(documentaryFrame);
const separatePng = documentaryFrame.png;
void fakeMetric;
void separatePng;`,
    { relative: "fake-reducer-mutant.mjs" },
  ).failures;
  assert.ok(
    fakeReducer.some(
      (failure) =>
        failure.code === WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
    ),
    `a reducer name plus inert pixel touch is not genuine scoring:\n${formatWeatherCaptureFailures(fakeReducer)}`,
  );

  assert.deepEqual(
    captureConsumerFailures(
      `const documentaryFrame = await pin.capture(2, true);
const documentaryMetric = bandMean(documentaryFrame);
const separatePng = documentaryFrame.png;
void documentaryMetric;
void separatePng;`,
    ),
    [],
    "a genuine reducer and PNG from the same capture must remain valid",
  );
});

test("capture consumer census resolves static dynamic-import expressions and fails closed on relevant unknowns", () => {
  const sources = {
    "concatenated.mjs": `const weather = await import("./lib/weather-" + "probe-pinning.mjs");
weather.installWeatherPinHarnessOnPage(page);`,
    "const-bound.mjs": `const modulePath = "./lib/weather-probe-pinning.mjs";
const weather = await import(modulePath);
weather.installWeatherPinHarnessOnPage(page);`,
    "new-url.mjs": `const weather = await import(new URL("./lib/weather-probe-pinning.mjs", import.meta.url));
weather.installWeatherPinHarnessOnPage(page);`,
    "template.mjs": `const middle = "probe";
const weather = await import(\`./lib/weather-\${middle}-pinning.mjs\`);
weather.installWeatherPinHarnessOnPage(page);`,
    "unrelated-unresolved.mjs": `const runtimePath = globalThis.runtimePath;
const runtime = await import(runtimePath);
void runtime;`,
    "unresolved-weather.mjs": `const middle = globalThis.captureModule;
const weather = await import(\`./lib/weather-\${middle}.mjs\`);
weather.installWeatherPinHarnessOnPage(page);`,
  };
  const census = censusWeatherCaptureConsumers(sources);
  assert.deepEqual(census.paths, [
    "concatenated.mjs",
    "const-bound.mjs",
    "new-url.mjs",
    "template.mjs",
    "unresolved-weather.mjs",
  ]);
  assert.deepEqual(
    census.failures.map((failure) => [failure.relative, failure.code]),
    [
      [
        "unresolved-weather.mjs",
        WEATHER_CAPTURE_FAILURE.UNRESOLVED_CAPTURE_IMPORT,
      ],
    ],
  );
});

test("combined capture mutant preserves every independent red", () => {
  const failures =
    captureConsumerFailures(`const scene = globalThis.viewer.scene;
const live = document.createElement("canvas").getContext("2d");
const readers = { draw: live.drawImage.bind(live) };
const invoke = (callback, ...args) => callback(...args);
invoke(Reflect.get(readers, "draw"), scene.canvas, 0, 0);
const captures = new Map([["take", pin.capture]]);
captures.get("take")(1, false);
const Promise = { all() { return globalThis.Promise.resolve(); } };
await Promise.all([pin.capture(2, false)]);
const documentaryFrame = await pin.capture(3, true);
void documentaryFrame.data;
const separatePng = documentaryFrame.png;
void separatePng;`);
  const codes = new Set(failures.map((failure) => failure.code));
  for (const code of [
    WEATHER_CAPTURE_FAILURE.CONSUMER_LIVE_READ,
    WEATHER_CAPTURE_FAILURE.DOCUMENTARY_ORIGIN_MISMATCH,
    WEATHER_CAPTURE_FAILURE.UNAWAITED_CAPTURE,
    WEATHER_CAPTURE_FAILURE.UNTRUSTED_INTRINSIC,
  ]) {
    assert.ok(
      codes.has(code),
      `combined mutant must preserve ${code}:\n${formatWeatherCaptureFailures(failures)}`,
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
