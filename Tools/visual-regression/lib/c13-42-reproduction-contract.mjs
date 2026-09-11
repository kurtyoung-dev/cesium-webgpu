import {
  fixtureById,
  fixtureClockIso,
  fixtureReplaySubset,
  stableStringify,
} from "./cloud-tour-fixtures.mjs";
import { analyzeCloudImages } from "./cloud-image-analysis.mjs";
import {
  framewiseDeltaSeries,
  ghostMetrics,
  imageDeltaMetrics,
} from "./cloud-tour-metrics.mjs";
import {
  C13_42_GODRAY_FIXTURE,
  UNIFORM_SKY_CONTROL,
  traceF32Ray,
} from "./c13-42-godray-fixture.mjs";
import { sha256 } from "./visual-gate-policy.mjs";
import {
  S5_FINAL_STATUSES,
  exitCodeForS5StatusOrStructural,
} from "./verdict-exit-gate.mjs";

export const C13_42_CONTRACT_VERSION = "c13-42-reproduction-contract/1";

export const REPORTED_PAGE_PROFILES = Object.freeze([
  Object.freeze({
    id: "R-atmospheric",
    pageId: "atmospheric-conditions",
    leg: "reported",
    terrain: "world-terrain",
  }),
  Object.freeze({
    id: "R-fullscreen-sky",
    pageId: "webgpu-fullscreen-sky",
    leg: "reported",
    terrain: "page-authored",
  }),
  Object.freeze({
    id: "R-god-rays",
    pageId: "webgpu-god-rays",
    leg: "reported",
    terrain: "page-authored",
  }),
]);

export const C13_42_REPRODUCTION_PROFILES = REPORTED_PAGE_PROFILES;

const PLAINS_FIXTURE_ID = "plains-fairweather-cumulus";

function freezeCell(cell) {
  return Object.freeze({ ...cell });
}

export function initialCoreSubjects() {
  const fixture = fixtureById(PLAINS_FIXTURE_ID);
  if (!fixture) {
    throw new Error(`required fixture ${PLAINS_FIXTURE_ID} is unavailable`);
  }
  const reported = REPORTED_PAGE_PROFILES.map((profile) =>
    freezeCell({
      id: profile.id,
      pageId: profile.pageId,
      leg: "reported",
      bracket:
        profile.id === "R-god-rays"
          ? ["OFF", "ON", "OFF", "ON"]
          : ["OFF", "ON", "OFF"],
    }),
  );
  const offline = fixture.stations.map((station) =>
    freezeCell({
      id: `O-${station.id}`,
      fixtureId: fixture.id,
      stationId: station.id,
      leg: "offline",
      bracket: ["OFF", "ON", "OFF"],
    }),
  );
  return Object.freeze([...reported, ...offline]);
}

export function buildC13_42Schedule() {
  return Object.freeze({
    profiles: C13_42_REPRODUCTION_PROFILES,
    coreSubjects: initialCoreSubjects(),
    controlledRay: CONTROLLED_RAY_FIXTURE_OBLIGATION,
    controlledRayProvider: CONTROLLED_RAY_PROVIDER_OBLIGATION,
    servedResponseBudget: C13_42_SERVED_RESPONSE_BUDGET,
    thresholds: CHARACTERIZATION_THRESHOLDS,
    disposition: characterizationDisposition(),
  });
}

/**
 * The five things the controlled-ray obligation named as unfrozen, each mapped
 * to the fixture member that would have to be frozen for the claim to be false.
 *
 * The obligation used to carry a hand-written reason string. A hand-written
 * reason cannot notice that the thing it describes has since been frozen, and
 * this one did not: the fixture module deep-freezes all five. Deriving the
 * status from the fixture is what stops the release going stale in the other
 * direction — unfreeze any of them and the obligation returns to STRUCTURAL on
 * its own.
 */
const CONTROLLED_RAY_GEOMETRY_MEMBERS = Object.freeze([
  Object.freeze({ name: "emitter", read: (f) => f.emitter }),
  Object.freeze({ name: "projectedShaftDirection", read: (f) => f.sun }),
  Object.freeze({ name: "occluder", read: (f) => f.occluder }),
  Object.freeze({ name: "camera", read: (f) => f.camera }),
  Object.freeze({ name: "imageMasks", read: (f) => f.rounding }),
]);

function deeplyFrozen(value) {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => deeplyFrozen(child));
}

/**
 * Decides the controlled-ray geometry obligation by reading the fixture rather
 * than by restating a claim about it. Sample count is checked as an INPUT: a
 * fixture that baked N into the march would not be a controlled ray fixture at
 * all, because no consumer could vary the one control C13-45 is about.
 */
export function assessControlledRayFixture(
  fixture = C13_42_GODRAY_FIXTURE,
  trace = traceF32Ray,
) {
  const unfrozen = CONTROLLED_RAY_GEOMETRY_MEMBERS.filter(
    (member) => !deeplyFrozen(member.read(fixture)),
  ).map((member) => member.name);
  const sampleCountIsAnInput = trace.length >= 2 && countsAreSeparable(trace);
  if (!sampleCountIsAnInput) unfrozen.push("sampleCount");
  return Object.freeze({
    id: "controlled-ray-geometry",
    status: unfrozen.length === 0 ? "FROZEN" : "STRUCTURAL",
    frozen: Object.freeze(
      CONTROLLED_RAY_GEOMETRY_MEMBERS.map((member) => member.name)
        .concat("sampleCount")
        .filter((name) => !unfrozen.includes(name)),
    ),
    unfrozen: Object.freeze(unfrozen),
    reason:
      unfrozen.length === 0
        ? "controlled ray emitter, projected shaft direction, occluder, camera, image-mask rounding, and sample count are frozen inputs of the fixture module"
        : `controlled ray fixture members are not frozen: ${unfrozen.join(", ")}`,
  });
}

/**
 * A controlled ray fixture whose amplitude ignored its sample count would read
 * as "frozen" on a structural check while being useless to C13-45. Two traces
 * that differ only in N must differ in amplitude for the geometry release to
 * mean anything.
 */
function countsAreSeparable(trace) {
  const options = {
    emitterHull: UNIFORM_SKY_CONTROL.emitterHull,
    occluderHull: null,
    exposure: UNIFORM_SKY_CONTROL.exposure,
  };
  const low = trace(0, 0, { ...options, sampleCount: 16 });
  const high = trace(0, 0, { ...options, sampleCount: 64 });
  return (
    low.taps.length === 16 &&
    high.taps.length === 64 &&
    low.diagnostics !== null &&
    high.diagnostics !== null &&
    low.diagnostics.main !== high.diagnostics.main
  );
}

export const CONTROLLED_RAY_FIXTURE_OBLIGATION = assessControlledRayFixture();

/**
 * The half of the controlled-ray work that is genuinely NOT done, kept as its
 * own named obligation so releasing the geometry does not silently release it
 * too. The fixture module says so itself (`providerIntegration.implemented`).
 */
export const CONTROLLED_RAY_PROVIDER_OBLIGATION = Object.freeze({
  id: "controlled-ray-provider-integration",
  status:
    C13_42_GODRAY_FIXTURE.providerIntegration.implemented === true
      ? "FROZEN"
      : "STRUCTURAL",
  reason: C13_42_GODRAY_FIXTURE.providerIntegration.reason,
});

/**
 * Null until the first successful calibration captures exist (maintainer ruling
 * M6, 2026-09-10). While it is null every successful capture is CALIBRATION, not
 * acceptance — `characterizationDisposition()` is how the apparatus says that
 * where it reports a result, rather than leaving it to prose.
 *
 * OWED, not invented: no capture has ever succeeded (see
 * `_lane-out/EVIDENCE_HORN_2026-09-09_RUNS.md`), so there is nothing to derive
 * from. `deriveCharacterizationThresholds` is the derivation, shipped as code so
 * the freeze is a mechanical step over the first artefacts rather than a
 * judgement call made twice.
 */
export const CHARACTERIZATION_THRESHOLDS = null;

/**
 * The smallest difference a published metric can express. Every field the keys
 * below read is produced by `imageDeltaMetrics`, which rounds with
 * `toFixed(6)` before it publishes — so 1e-6 is the metric's own quantisation
 * step, not a chosen epsilon. It is the floor for the derived margin: see
 * `deriveCharacterizationThresholds`.
 */
const METRIC_QUANTUM = 1e-6;

/**
 * What each threshold key means and which receipt field it is derived from, so
 * the freeze is reproducible by someone who did not write it.
 *
 * EVERY `from` here was re-derived by EXECUTING `computeC13_42CellMetrics` over
 * the exact input the probe builds, and reading the produced object — not from
 * a notion of what a receipt contains. The first version of this table named
 * `metrics.support.fraction`, `metrics.radial.contrast`, `metrics.delta.fraction`
 * and `metrics.repeatOff.meanAbsoluteDelta`; none of those paths exists, so the
 * derivation refused every real receipt and the Edge calibration leg carried an
 * unsatisfiable bar. The produced shape is:
 *
 * - god-ray cell (`kind: "godRay"`, the `R-god-rays` subject):
 *   `metrics.toggle.{offOn,frames,repeatOff,repeatOn}`, `metrics.cloud === null`
 * - every other cell (`kind: "cloud"`, including all four offline subjects):
 *   `metrics.cloud.{cloud,offOn,frames,repeat}`, no `metrics.toggle`
 *
 * A key may therefore name SEVERAL candidate paths: the same quantity lives at
 * a different path in the two cell shapes, and the first path that resolves on
 * a given cell is the one used.
 *
 * NAMED GAP, not a silent omission (Principle 9). The god-ray GEOMETRY metrics
 * — `shaftSupportFraction`, `radialFalloffLinearLuminancePerPixel`,
 * `radialAlignmentAngleErrorRadians`, `angularWidthRadians` — are produced by
 * `analyzeGodRayImages`, which `computeC13_42CellMetrics` calls only when the
 * caller supplies `masks` or `emitter`. The probe supplies NEITHER, so
 * `metrics.godRay` is `null` on every cell it produces and no threshold can be
 * derived from those fields today. Wiring the fixture's `deriveFixtureMasks`,
 * projected emitter and `expectedDirectionRadians` into the probe is the
 * missing piece; until it lands the geometry thresholds cannot be frozen, and
 * the keys below are the reachable characterization.
 */
export const CHARACTERIZATION_THRESHOLD_DERIVATION = Object.freeze({
  method:
    "take the per-key metric across every calibration cell, then bound it by the observed extreme widened by the observed spread, with the margin floored at the metric's own quantisation step",
  keys: Object.freeze([
    Object.freeze({
      key: "godRayToggleChangedFraction",
      from: Object.freeze([
        "cells[id=R-god-rays].metrics.toggle.offOn.changedFraction",
      ]),
      bound: "lower",
      rule: "minimum observed, narrowed by the derived margin",
      means:
        "the fraction of pixels the god-ray toggle changes; a floor, because the effect must be present",
    }),
    Object.freeze({
      key: "godRayToggleMeanAbsRgbDelta",
      from: Object.freeze([
        "cells[id=R-god-rays].metrics.toggle.offOn.meanAbsRgbDelta",
      ]),
      bound: "lower",
      rule: "minimum observed, narrowed by the derived margin",
      means:
        "the mean per-channel magnitude of the god-ray toggle; a floor, because a present-but-invisible effect is a failure",
    }),
    Object.freeze({
      key: "cloudToggleChangedFraction",
      from: Object.freeze([
        "cells[leg=offline].metrics.cloud.offOn.changedFraction",
      ]),
      bound: "lower",
      rule: "minimum observed across offline cells, narrowed by the derived margin",
      means:
        "the fraction of pixels the cloud toggle changes on the offline fixtures",
    }),
    Object.freeze({
      key: "repeatOffDrift",
      from: Object.freeze([
        "cells[*].metrics.toggle.repeatOff.meanAbsRgbDelta",
        "cells[*].metrics.cloud.repeat.residual.meanAbsRgbDelta",
      ]),
      bound: "upper",
      rule: "maximum observed, widened by the derived margin",
      means:
        "how far a repeated OFF phase drifts from the first OFF phase; a ceiling, because the same state must reconverge",
    }),
  ]),
  minimumCalibrationRuns: 3,
  marginFloor: METRIC_QUANTUM,
  marginFloorDerivation:
    "imageDeltaMetrics publishes every value through toFixed(6), so 1e-6 is the smallest difference a receipt can express",
});

/** "calibration" while thresholds are null, "acceptance" once they are frozen. */
export function characterizationDisposition(
  thresholds = CHARACTERIZATION_THRESHOLDS,
) {
  return thresholds === null ? "calibration" : "acceptance";
}

function metricAt(cell, dottedPath) {
  return dottedPath
    .split(".")
    .reduce(
      (value, key) =>
        value === null || value === undefined ? undefined : value[key],
      cell,
    );
}

/**
 * Does this cell match the selector inside `cells[...]`? `*` matches every
 * cell, and is spelled out rather than falling out of `undefined !== undefined`
 * — the accidental form works but says nothing about intent, and the next
 * selector added to the table would not get the same luck.
 */
function cellMatchesSelector(cell, selector) {
  if (selector === "*") return true;
  const [field, want] = selector.split("=");
  return cell?.[field] === want;
}

/**
 * Collect every finite sample a key's candidate paths yield. The first path
 * that resolves on a given cell wins, so one key can span the two cell shapes
 * (`metrics.toggle.*` on the god-ray cell, `metrics.cloud.*` on the rest)
 * without double-counting a cell that somehow carried both.
 */
function collectKeySamples(receipts, from) {
  const candidates = Array.isArray(from) ? from : [from];
  const samples = [];
  for (const receipt of receipts) {
    for (const cell of receipt?.cells ?? []) {
      for (const candidate of candidates) {
        const [, selector, ...rest] = candidate.split(/\[|\]\./u);
        if (!cellMatchesSelector(cell, selector)) continue;
        const value = metricAt(cell, rest.join("."));
        if (typeof value === "number" && Number.isFinite(value)) {
          samples.push(value);
          break;
        }
      }
    }
  }
  return samples;
}

/**
 * Turns calibration receipts into the frozen threshold object. Returns a
 * refusal record rather than a threshold when the calibration is too thin to
 * derive from — a threshold invented from one run is how a characterization
 * quietly becomes an acceptance of whatever the first run happened to do.
 *
 * THE MARGIN IS DERIVED, INCLUDING WHEN THE CALIBRATION IS DEGENERATE. Widening
 * by the observed spread alone leaves a zero-margin bar whenever the runs agree
 * exactly: a lower bound equal to the observed minimum is failed by the first
 * downward flicker, and an upper bound equal to the observed maximum by the
 * first upward one. Three agreeing runs do not show that the true variation is
 * zero, only that it is below what three samples resolve; the smallest
 * defensible margin is then the smallest difference the receipt can EXPRESS,
 * which is the metric's own `toFixed(6)` quantum. Hence
 * `margin = max(spread, METRIC_QUANTUM)`. A degenerate key is reported as such
 * in the per-key record rather than being quietly frozen.
 */
export function deriveCharacterizationThresholds(receipts) {
  if (
    !Array.isArray(receipts) ||
    receipts.length <
      CHARACTERIZATION_THRESHOLD_DERIVATION.minimumCalibrationRuns
  ) {
    return Object.freeze({
      ok: false,
      reason: `threshold derivation needs at least ${CHARACTERIZATION_THRESHOLD_DERIVATION.minimumCalibrationRuns} successful calibration receipts`,
      thresholds: null,
      derivation: Object.freeze([]),
    });
  }
  const thresholds = {};
  const derivation = [];
  const missing = [];
  for (const entry of CHARACTERIZATION_THRESHOLD_DERIVATION.keys) {
    const samples = collectKeySamples(receipts, entry.from);
    if (samples.length === 0) {
      missing.push(entry.key);
      continue;
    }
    const lowest = Math.min(...samples);
    const highest = Math.max(...samples);
    const spread = highest - lowest;
    const degenerate = spread === 0;
    const margin = Math.max(spread, METRIC_QUANTUM);
    const threshold =
      entry.bound === "upper" ? highest + margin : lowest - margin;
    thresholds[entry.key] = threshold;
    derivation.push(
      Object.freeze({
        key: entry.key,
        bound: entry.bound,
        sampleCount: samples.length,
        lowest,
        highest,
        spread,
        margin,
        marginSource: degenerate
          ? "metric quantum (the calibration runs agreed exactly)"
          : "observed spread",
        degenerate,
        threshold,
      }),
    );
  }
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      reason: `calibration receipts carry no samples for ${missing.join(", ")}`,
      thresholds: null,
      derivation: Object.freeze(derivation),
    });
  }
  return Object.freeze({
    ok: true,
    reason: null,
    thresholds: Object.freeze(thresholds),
    derivation: Object.freeze(derivation),
  });
}

const BASELINE_SERVED_RESPONSE_BUDGET = 48;

/**
 * What the six 2026-09-09 runs actually recorded. Five refused on the response
 * cap; the sixth ERRORED on cloud readiness and never reached the cap at all.
 * `overflow` counts response EVENTS, not distinct URLs: once the cap fills,
 * `seenUrls` stops growing, so a repeat fetch of an over-cap URL is counted
 * again. Every `overflow` here is therefore an UPPER bound on the distinct
 * over-cap URLs, which is why the derived budget below has slack it should lose
 * when the de-duplication repair lands.
 */
export const C13_42_OBSERVED_SERVED_OVERFLOW = Object.freeze([
  Object.freeze({
    run: "c13-20260909-above-deck-progress-01",
    subjectId: "O-above-deck",
    leg: "offline",
    bracketLength: 3,
    retained: 48,
    overflow: 58,
  }),
  Object.freeze({
    run: "c13-20260909-above-deck-progress-02",
    subjectId: "O-above-deck",
    leg: "offline",
    bracketLength: 3,
    retained: 48,
    overflow: 58,
  }),
  Object.freeze({
    run: "c13-20260909-above-deck-pw-progress-03",
    subjectId: "O-above-deck",
    leg: "offline",
    bracketLength: 3,
    retained: 48,
    overflow: 58,
  }),
  Object.freeze({
    run: "c13-20260909-calibration-02",
    subjectId: null,
    leg: null,
    bracketLength: null,
    retained: 48,
    overflow: 125,
  }),
  Object.freeze({
    run: "c13-20260909-calibration-03",
    subjectId: "R-atmospheric",
    leg: "reported",
    bracketLength: 3,
    retained: 48,
    overflow: 12,
  }),
]);

/**
 * Derives the raised per-subject bound instead of picking a round number.
 *
 * The worst observed run needed at most `retained + overflow` distinct relevant
 * responses. Every observed datum came from a three-phase bracket; `R-god-rays`
 * is the only four-phase subject, and the response listener lives for the whole
 * cell, so a fourth phase can pull a fourth phase's worth of module fetches.
 */
export function deriveServedResponseBudget(
  observed = C13_42_OBSERVED_SERVED_OVERFLOW,
  subjects = initialCoreSubjects(),
) {
  const ceiling = Math.max(
    ...observed.map((entry) => entry.retained + entry.overflow),
  );
  const observedBracketLength = Math.max(
    ...observed
      .map((entry) => entry.bracketLength)
      .filter((length) => typeof length === "number"),
  );
  const maximumBracketLength = Math.max(
    ...subjects.map((subject) => subject.bracket.length),
  );
  return Math.ceil((ceiling * maximumBracketLength) / observedBracketLength);
}

/**
 * Per-subject, not a bumped global (maintainer ruling M6, 2026-09-10), and the
 * derived bound now covers the OFFLINE leg too (maintainer ruling
 * R-2026-09-11-2, 2026-09-11).
 *
 * WHY THE OFFLINE LEG WAS RAISED. M6 scoped the raise to the reported demos,
 * but the evidence does not fit that scoping: the worst ATTRIBUTABLE overflow
 * is the OFFLINE subject `O-above-deck` at 58, on three separate runs, while
 * the only reported subject that reached the refusal with an attributable cell,
 * `R-atmospheric`, overflowed by 12. `validateReceipt` requires all seven core
 * subjects, and the over-cap refusal is zero-tolerance, so a reported-only
 * raise still refuses on `O-above-deck` and NO complete receipt is producible
 * at all. Raising both legs is what makes a first complete receipt reachable.
 *
 * The cost is the deadline: with both legs on the derived bound the per-subject
 * sum coincides with the global form (7 x 231 x perResponseMs). That is stated
 * rather than hidden — the per-subject MECHANISM is what M6 ruled and it is
 * intact (a subject on any other leg is still charged the baseline bound), but
 * the saving the split produced while the legs differed is not present at these
 * values. The levers that shrink it again are the de-duplication repair, which
 * should lower the derived 231, and the calibration run, which replaces the
 * derived value with a measured one.
 */
export const C13_42_SERVED_RESPONSE_BUDGET = Object.freeze({
  baseline: BASELINE_SERVED_RESPONSE_BUDGET,
  reported: deriveServedResponseBudget(),
  offline: deriveServedResponseBudget(),
  derivation:
    "ceil(max(retained + overflow) * maxBracketLength / observedBracketLength) over C13_42_OBSERVED_SERVED_OVERFLOW",
});

/**
 * The per-subject response bound the probe must apply for this subject. Keyed
 * on the subject's leg, so the lookup keeps saying which leg it read even now
 * that both named legs carry the same derived bound; a subject on any other leg
 * falls to the baseline rather than silently inheriting a raise.
 */
export function servedResponseBudgetFor(subject) {
  if (!subject || typeof subject !== "object") {
    throw new TypeError("servedResponseBudgetFor requires a core subject");
  }
  const bound = C13_42_SERVED_RESPONSE_BUDGET[subject.leg];
  return typeof bound === "number"
    ? bound
    : C13_42_SERVED_RESPONSE_BUDGET.baseline;
}

/**
 * The decision the probe's over-cap refusal site asks for. Returning a record
 * rather than throwing keeps the cap policy testable without a browser, which
 * is the only reason any of this could be re-derived at all after the runs that
 * produced the evidence had gone.
 */
export function assessC13_42ServedResponseBudget({
  subject,
  retained,
  overflow,
} = {}) {
  const budget = servedResponseBudgetFor(subject);
  const over = Number(overflow) > 0;
  return Object.freeze({
    ok: !over,
    subjectId: subject.id,
    leg: subject.leg,
    budget,
    retained: Number(retained),
    overflow: Number(overflow),
    reason: over
      ? `the served identity closure exceeded the ${budget}-response budget for ${subject.id}`
      : null,
  });
}

/**
 * The per-run work budget contribution of the response drain, summed per
 * subject rather than by multiplying the largest bound across every cell. The
 * global form charged all seven cells the reported subjects' raised bound,
 * which is how raising a cap silently disarms a deadline.
 */
export function servedResponseBudgetMs(
  perResponseMs,
  subjects = initialCoreSubjects(),
) {
  if (!Number.isSafeInteger(perResponseMs) || perResponseMs <= 0) {
    throw new RangeError("perResponseMs must be a positive safe integer");
  }
  return subjects.reduce(
    (total, subject) =>
      total + servedResponseBudgetFor(subject) * perResponseMs,
    0,
  );
}

const METRIC_DEFINITION_KEYS = Object.freeze([
  "contract",
  "cloudImageAnalysis",
  "cloudTourMetrics",
]);

function selectedFixture() {
  const fixture = fixtureById(PLAINS_FIXTURE_ID);
  if (!fixture) {
    throw new Error(`required fixture ${PLAINS_FIXTURE_ID} is unavailable`);
  }
  return fixture;
}

export function offlineCaptureRequest(fixture = selectedFixture(), phase) {
  const normalizedPhase = String(phase).toUpperCase();
  if (normalizedPhase !== "OFF" && normalizedPhase !== "ON") {
    throw new TypeError("offline capture phase must be OFF or ON");
  }
  return Object.freeze({
    fixtureId: fixture.id,
    fixtureClockIso: fixtureClockIso(fixture),
    enabled: normalizedPhase === "ON",
    volumetric: Object.freeze({ ...fixture.volumetric }),
  });
}

export function hashC13_42Definition(value) {
  return sha256(Buffer.from(stableStringify(value)));
}

export function fixtureScheduleHash(fixture = selectedFixture()) {
  return hashC13_42Definition({
    fixtureReplay: fixtureReplaySubset(fixture),
    subjects: initialCoreSubjects(),
    controlledRay: CONTROLLED_RAY_FIXTURE_OBLIGATION,
  });
}

export function metricDefinitionHash(definitions) {
  if (!definitions || typeof definitions !== "object") {
    throw new TypeError("metric definitions must be an object");
  }
  const keys = Object.keys(definitions).sort();
  if (!sameArray(keys, [...METRIC_DEFINITION_KEYS].sort())) {
    throw new TypeError(
      `metric definitions must contain exactly ${METRIC_DEFINITION_KEYS.join(", ")}`,
    );
  }
  const fingerprints = {};
  for (const key of METRIC_DEFINITION_KEYS) {
    const definition = definitions[key];
    if (
      !definition ||
      definition.exists !== true ||
      !Number.isSafeInteger(definition.byteLength) ||
      definition.byteLength <= 0 ||
      typeof definition.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(definition.sha256)
    ) {
      throw new TypeError(`metric definition ${key} has no exact fingerprint`);
    }
    fingerprints[key] = {
      byteLength: definition.byteLength,
      sha256: definition.sha256,
    };
  }
  return hashC13_42Definition({
    contractVersion: C13_42_CONTRACT_VERSION,
    definitions: fingerprints,
  });
}

const C13_42_EXACT_SERVED_ARTIFACTS = new Set([
  "/Source/Cesium.js",
  "/packages/engine/Build/Unminified/index.js",
  "/packages/engine/Build/Unminified/index-wgsl.js",
  "/packages/widgets/Build/Unminified/index.js",
]);

function rawServedPath(value) {
  let raw = value;
  const absoluteUrl = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(raw);
  if (absoluteUrl) {
    raw = absoluteUrl[1] ?? "/";
  } else if (raw.startsWith("//")) {
    const pathnameStart = raw.indexOf("/", 2);
    raw = pathnameStart === -1 ? "/" : raw.slice(pathnameStart);
  }
  raw = raw.split(/[?#]/u, 1)[0];
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function relevantRawServedPath(value) {
  if (typeof value !== "string") return false;
  const rawPath = rawServedPath(value);
  return (
    rawPath.startsWith("/Build/CesiumUnminified/") ||
    C13_42_EXACT_SERVED_ARTIFACTS.has(rawPath) ||
    (rawPath.startsWith("/Apps/Sandcastle2/") &&
      (rawPath.endsWith(".js") || rawPath.endsWith(".html"))) ||
    rawPath.includes("/gallery/")
  );
}

function servedArtifactResult(relevant, ok, path, reason) {
  return Object.freeze({ relevant, ok, path, reason });
}

export function classifyC13_42ServedArtifact(value) {
  const relevant = relevantRawServedPath(value);
  if (typeof value !== "string") {
    return servedArtifactResult(relevant, false, null, "artifact-not-string");
  }
  if (value.length === 0) {
    return servedArtifactResult(relevant, false, null, "artifact-empty");
  }
  if (value.trim() !== value) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-edge-whitespace",
    );
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-is-absolute-url",
    );
  }
  if (value.startsWith("//")) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-is-protocol-relative",
    );
  }
  if (/^[a-z]:[\\/]/iu.test(value)) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-is-absolute-filesystem-path",
    );
  }
  if (/[?#]/u.test(value)) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-query-or-fragment",
    );
  }
  if (value.includes("%")) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-percent-encoding",
    );
  }
  if (value.includes("\\")) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-backslash",
    );
  }
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-control-character",
    );
  }
  const path = value.startsWith("/") ? value.slice(1) : value;
  if (path.length === 0) {
    return servedArtifactResult(relevant, false, null, "artifact-empty");
  }
  if (path.includes("//") || path.endsWith("/")) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-empty-segment",
    );
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    return servedArtifactResult(relevant, false, null, "artifact-backtracks");
  }
  if (segments.includes(".")) {
    return servedArtifactResult(
      relevant,
      false,
      null,
      "artifact-has-dot-segment",
    );
  }
  if (segments.some((segment) => segment.includes(":"))) {
    return servedArtifactResult(relevant, false, null, "artifact-has-colon");
  }
  return servedArtifactResult(relevant, true, path, null);
}

function freezeServedClosureAssessment(value) {
  for (const item of value.malformed) Object.freeze(item);
  for (const values of Object.values(value)) {
    if (Array.isArray(values)) Object.freeze(values);
  }
  return Object.freeze(value);
}

function malformedArtifact(source, index, value, reason) {
  return {
    source,
    index,
    value: typeof value === "string" ? value : String(value),
    reason,
  };
}

function canonicalArtifactSet(values, source, malformed) {
  if (!Array.isArray(values) && !(values instanceof Set)) {
    malformed.push(
      malformedArtifact(source, null, values, "artifact-set-not-array-or-set"),
    );
    return new Set();
  }
  const canonical = new Set();
  [...values].forEach((value, index) => {
    const result = classifyC13_42ServedArtifact(value);
    if (!result.ok) {
      malformed.push(malformedArtifact(source, index, value, result.reason));
    } else {
      canonical.add(result.path);
    }
  });
  return canonical;
}

export function assessC13_42ServedClosure({
  ledger,
  requiredArtifacts,
  allowedArtifacts,
  snapshottedArtifacts,
} = {}) {
  const malformed = [];
  const required = canonicalArtifactSet(
    requiredArtifacts,
    "requiredArtifacts",
    malformed,
  );
  const allowed = canonicalArtifactSet(
    allowedArtifacts,
    "allowedArtifacts",
    malformed,
  );
  const snapshotted = canonicalArtifactSet(
    snapshottedArtifacts,
    "snapshottedArtifacts",
    malformed,
  );
  const observed = new Set();
  const unboundAllowed = new Set(
    [...allowed].filter((path) => !snapshotted.has(path)),
  );
  const unexpectedObserved = new Set();
  const mismatched = new Set();
  if (!Array.isArray(ledger)) {
    malformed.push(
      malformedArtifact("ledger", null, ledger, "ledger-not-array"),
    );
  } else {
    ledger.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        malformed.push(
          malformedArtifact("ledger", index, entry, "ledger-entry-not-object"),
        );
        return;
      }
      const value = entry.relativePath ?? entry.url;
      if (Object.hasOwn(entry, "canonicalizationError")) {
        malformed.push(
          malformedArtifact(
            "ledger",
            index,
            value,
            String(
              entry.canonicalizationError || "ledger-canonicalization-error",
            ),
          ),
        );
        return;
      }
      const result = classifyC13_42ServedArtifact(value);
      if (!result.ok) {
        malformed.push(
          malformedArtifact("ledger", index, value, result.reason),
        );
        return;
      }
      observed.add(result.path);
      if (!allowed.has(result.path)) {
        unexpectedObserved.add(result.path);
      }
      if (entry.matchesDisk !== true) mismatched.add(result.path);
    });
  }
  const missingRequired = [...required].filter((path) => !observed.has(path));
  const result = {
    ok:
      malformed.length === 0 &&
      unboundAllowed.size === 0 &&
      unexpectedObserved.size === 0 &&
      mismatched.size === 0 &&
      missingRequired.length === 0,
    malformed,
    unboundAllowed: [...unboundAllowed].sort(),
    unexpectedObserved: [...unexpectedObserved].sort(),
    mismatched: [...mismatched].sort(),
    missingRequired: missingRequired.sort(),
  };
  return freezeServedClosureAssessment(result);
}

function structural(reasons) {
  return {
    status: "STRUCTURAL",
    exitCode: exitCodeForS5StatusOrStructural("STRUCTURAL"),
    reasons,
  };
}

function requiredObject(value, path, reasons) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reasons.push(`missing or malformed ${path}`);
    return false;
  }
  return true;
}

function requiredNonEmptyArray(value, path, reasons) {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push(`missing or malformed ${path}`);
    return false;
  }
  return true;
}

function requiredString(value, path, reasons) {
  if (typeof value !== "string" || value.length === 0) {
    reasons.push(`missing or malformed ${path}`);
    return false;
  }
  return true;
}

function requiredSha256(value, path, reasons) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    reasons.push(`missing or malformed ${path}`);
    return false;
  }
  return true;
}

function requiredFinite(value, path, reasons) {
  if (!Number.isFinite(value)) {
    reasons.push(`missing or malformed ${path}`);
    return false;
  }
  return true;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const RAW_CONTROL_KEYS = Object.freeze([
  "name",
  "selector",
  "property",
  "event",
  "value",
  "dataBind",
  "elementId",
]);

function validateRawControls(value, path, reasons) {
  if (!requiredNonEmptyArray(value, path, reasons)) return;
  const names = new Set();
  const selectors = new Set();
  const elementIds = new Set();
  for (let index = 0; index < value.length; index++) {
    const control = value[index];
    const controlPath = `${path}[${index}]`;
    if (!requiredObject(control, controlPath, reasons)) continue;
    if (!sameArray(Object.keys(control).sort(), [...RAW_CONTROL_KEYS].sort())) {
      reasons.push(`${controlPath} does not match the control readback schema`);
    }
    requiredString(control.name, `${controlPath}.name`, reasons);
    requiredString(control.selector, `${controlPath}.selector`, reasons);
    if (control.property !== "checked" && control.property !== "value") {
      reasons.push(`missing or malformed ${controlPath}.property`);
    }
    if (control.event !== "change" && control.event !== "input") {
      reasons.push(`missing or malformed ${controlPath}.event`);
    }
    if (
      (control.property === "checked" &&
        (control.event !== "change" || typeof control.value !== "boolean")) ||
      (control.property === "value" &&
        (control.event !== "input" || typeof control.value !== "string"))
    ) {
      reasons.push(`${controlPath} has contradictory property/event/value`);
    }
    if (
      control.dataBind !== null &&
      (typeof control.dataBind !== "string" || control.dataBind.length === 0)
    ) {
      reasons.push(`missing or malformed ${controlPath}.dataBind`);
    } else if (
      typeof control.dataBind === "string" &&
      (control.property === "checked" || control.property === "value") &&
      !control.dataBind.includes(`${control.property}:`)
    ) {
      reasons.push(`${controlPath} has contradictory property/dataBind`);
    }
    if (!Number.isSafeInteger(control.elementId) || control.elementId <= 0) {
      reasons.push(`missing or malformed ${controlPath}.elementId`);
    }
    for (const [field, collection] of [
      ["name", names],
      ["selector", selectors],
      ["elementId", elementIds],
    ]) {
      if (collection.has(control[field])) {
        reasons.push(`${path} has contradictory duplicate ${field}`);
      }
      collection.add(control[field]);
    }
  }
}

function validateIdentity(receipt, reasons) {
  const identity = receipt?.identity;
  if (!requiredObject(identity, "identity", reasons)) return;
  for (const owner of ["source", "build", "served"]) {
    requiredSha256(
      identity?.[owner]?.sha256,
      `identity.${owner}.sha256`,
      reasons,
    );
  }
  requiredSha256(identity.fixtureHash, "identity.fixtureHash", reasons);
  requiredSha256(identity.metricHash, "identity.metricHash", reasons);
}

function validateEnvironment(receipt, reasons) {
  const environment = receipt?.environment;
  if (!requiredObject(environment, "environment", reasons)) return;
  requiredString(environment.browser, "environment.browser", reasons);
  requiredString(environment.adapter, "environment.adapter", reasons);
  requiredFinite(
    environment.canvas?.width,
    "environment.canvas.width",
    reasons,
  );
  requiredFinite(
    environment.canvas?.height,
    "environment.canvas.height",
    reasons,
  );
  requiredFinite(environment.dpr, "environment.dpr", reasons);
}

function validateCell(cell, expected, reasons) {
  if (!requiredObject(cell, `cell ${expected.id}`, reasons)) return;
  if (cell.id !== expected.id || cell.leg !== expected.leg) {
    reasons.push(`cell ${expected.id} does not match its scheduled identity`);
  }
  if (expected.pageId && cell.pageId !== expected.pageId) {
    reasons.push(`cell ${expected.id} has the wrong reported page id`);
  }
  if (expected.fixtureId && cell.fixtureId !== expected.fixtureId) {
    reasons.push(`cell ${expected.id} has the wrong offline fixture id`);
  }
  if (!sameArray(cell.bracket, expected.bracket)) {
    reasons.push(`cell ${expected.id} has an incomplete same-state bracket`);
  }
  if (!S5_FINAL_STATUSES.includes(cell.status)) {
    reasons.push(`cell ${expected.id} has an unknown status`);
  }
  validateRawControls(
    cell.rawControls,
    `cell ${expected.id}.rawControls`,
    reasons,
  );
  requiredObject(cell.preState, `cell ${expected.id}.preState`, reasons);
  requiredObject(cell.postState, `cell ${expected.id}.postState`, reasons);
  if (cell.status === "PASS" && cell.postState?.restored !== true) {
    reasons.push(`cell ${expected.id} PASS lacks exact restoration proof`);
  }
  requiredObject(cell.metrics, `cell ${expected.id}.metrics`, reasons);
  requiredSha256(cell.pngSha256, `cell ${expected.id}.pngSha256`, reasons);
}

export function validateReceipt(receipt) {
  const reasons = [];
  if (!requiredObject(receipt, "receipt", reasons)) return structural(reasons);
  if (receipt.contractVersion !== C13_42_CONTRACT_VERSION) {
    reasons.push("receipt has an unknown contract version");
  }
  // Identity, not equality, was the original test. It reads correctly while the
  // thresholds are null and inverts the moment they are frozen: a receipt is
  // JSON, so a round-tripped copy of a non-null threshold object can never be
  // `===` the module's, and EVERY receipt would fail validation the day M6's
  // freeze landed. Compare the values.
  if (
    stableStringify(receipt.thresholds ?? null) !==
    stableStringify(CHARACTERIZATION_THRESHOLDS)
  ) {
    reasons.push(
      "characterization thresholds must match the contract's frozen thresholds",
    );
  }
  validateIdentity(receipt, reasons);
  validateEnvironment(receipt, reasons);
  const expected = initialCoreSubjects();
  if (
    !Array.isArray(receipt.cells) ||
    receipt.cells.length !== expected.length
  ) {
    reasons.push(
      `receipt must contain exactly ${expected.length} core subjects`,
    );
  } else {
    const ids = new Set(receipt.cells.map((cell) => cell?.id));
    for (const subject of expected) {
      if (!ids.has(subject.id)) {
        reasons.push(`missing core subject ${subject.id}`);
      }
      validateCell(
        receipt.cells.find((cell) => cell?.id === subject.id),
        subject,
        reasons,
      );
    }
  }
  const ray = receipt.controlledRay;
  // This used to require `ray.status === "STRUCTURAL"` literally, while
  // `foldReceipt` refused to publish a PASS *because* the status was STRUCTURAL.
  // Together they made a certification PASS unreachable no matter what any
  // capture showed. The receipt must carry the obligation at whatever
  // disposition the contract currently holds — which is what makes M6's release
  // observable in a receipt instead of merely asserted in a module.
  if (
    !ray ||
    ray.id !== CONTROLLED_RAY_FIXTURE_OBLIGATION.id ||
    ray.status !== CONTROLLED_RAY_FIXTURE_OBLIGATION.status ||
    typeof ray.reason !== "string"
  ) {
    reasons.push(
      "controlled-ray geometry must be carried at the contract's current disposition",
    );
  }
  return reasons.length === 0
    ? { status: "PASS", exitCode: 0, reasons: [] }
    : structural(reasons);
}

function foldStatus(statuses) {
  if (statuses.includes("ERROR")) return "ERROR";
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("STRUCTURAL")) return "STRUCTURAL";
  return "PASS";
}

export function foldReceipt(receipt) {
  const validCells = Array.isArray(receipt?.cells)
    ? receipt.cells.filter((cell) => S5_FINAL_STATUSES.includes(cell?.status))
    : [];
  const measuredStatus = foldStatus(validCells.map((cell) => cell.status));
  if (measuredStatus === "ERROR" || measuredStatus === "FAIL") {
    return {
      status: measuredStatus,
      exitCode: exitCodeForS5StatusOrStructural(measuredStatus),
      worstCells: validCells
        .filter((cell) => cell.status === measuredStatus)
        .map((cell) => cell.id),
      reasons: [],
    };
  }
  const validation = validateReceipt(receipt);
  if (validation.status !== "PASS") return validation;
  if (receipt.controlledRay.status === "STRUCTURAL") {
    return structural([
      "controlled-ray geometry remains an unscored required obligation",
    ]);
  }
  // Maintainer ruling R-2026-09-11-3: a certification PASS REQUIRES
  // `providerIntegration.implemented === true`.
  //
  // Splitting the single controlled-ray obligation in two released the geometry
  // honestly but removed the provider half's ONLY enforcement point: before the
  // split, one obligation being STRUCTURAL blocked a PASS here; after it, the
  // provider record was published and read by nobody. Nothing was released the
  // day it landed — the disposition is `calibration`, so the branch below
  // refuses everything anyway — but the moment the thresholds froze, a
  // certification PASS would have become reachable with provider, scene and
  // browser integration still unimplemented. This is that enforcement point,
  // restored, and it is read from the fixture's own `implemented` flag rather
  // than asserted, so implementing the integration releases it automatically.
  if (CONTROLLED_RAY_PROVIDER_OBLIGATION.status === "STRUCTURAL") {
    return structural([
      `controlled-ray provider integration remains an unmet required obligation: ${CONTROLLED_RAY_PROVIDER_OBLIGATION.reason}`,
    ]);
  }
  if (characterizationDisposition() !== "acceptance") {
    return structural([
      "threshold-null characterization is calibration, not acceptance; it cannot publish a certification PASS",
    ]);
  }
  const status = foldStatus(validCells.map((cell) => cell.status));
  return {
    status,
    exitCode: exitCodeForS5StatusOrStructural(status),
    worstCells: validCells
      .filter((cell) => cell.status === status)
      .map((cell) => cell.id),
    reasons: [],
  };
}

export function foldC13_42Verdicts(cells, options = {}) {
  if (
    !Array.isArray(cells) ||
    cells.some((cell) => !S5_FINAL_STATUSES.includes(cell?.status))
  ) {
    return structural([
      "every folded cell must carry a recognized final status",
    ]);
  }
  const status = foldStatus(cells.map((cell) => cell.status));
  return {
    status,
    exitCode: exitCodeForS5StatusOrStructural(status),
    worstCells: cells
      .filter((cell) => cell.status === status)
      .map((cell) => cell.id),
    phase: options.phase ?? null,
    reasons: [],
  };
}

export function validateBaselineRepairComparability(baseline, repair) {
  const baselineValidation = validateReceipt(baseline);
  const repairValidation = validateReceipt(repair);
  if (
    baselineValidation.status !== "PASS" ||
    repairValidation.status !== "PASS"
  ) {
    return structural([
      "baseline and repair receipts must each be structurally valid",
    ]);
  }
  const reasons = [];
  const pairs = [
    [
      baseline.identity.fixtureHash,
      repair.identity.fixtureHash,
      "fixture hash",
    ],
    [baseline.identity.metricHash, repair.identity.metricHash, "metric hash"],
    [baseline.environment.browser, repair.environment.browser, "browser"],
    [baseline.environment.adapter, repair.environment.adapter, "adapter"],
    [
      baseline.environment.canvas.width,
      repair.environment.canvas.width,
      "canvas width",
    ],
    [
      baseline.environment.canvas.height,
      repair.environment.canvas.height,
      "canvas height",
    ],
    [baseline.environment.dpr, repair.environment.dpr, "DPR"],
  ];
  for (const [left, right, name] of pairs) {
    if (left !== right) reasons.push(`baseline/repair ${name} mismatch`);
  }
  for (let index = 0; index < baseline.cells.length; index++) {
    const left = baseline.cells[index];
    const right = repair.cells[index];
    if (
      left.id !== right.id ||
      left.pageId !== right.pageId ||
      left.fixtureId !== right.fixtureId
    ) {
      reasons.push(`baseline/repair cell ${index} identity mismatch`);
    }
    if (
      stableStringify(left.rawControls) !== stableStringify(right.rawControls)
    ) {
      reasons.push(`baseline/repair cell ${left.id} raw controls mismatch`);
    }
  }
  return reasons.length === 0
    ? { status: "PASS", exitCode: 0, reasons: [] }
    : structural(reasons);
}

export const compareC13_42Phases = validateBaselineRepairComparability;
export const validateC13_42Receipt = validateReceipt;

function imageShape(image) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    !image.data
  ) {
    return null;
  }
  const channels = image.channels ?? 4;
  return image.data.length === image.width * image.height * channels
    ? { ...image, channels }
    : null;
}

function maskAt(mask, index, length) {
  return (
    mask === undefined ||
    mask === null ||
    (mask.length === length && Boolean(mask[index]))
  );
}

function srgbChannelToLinear(byte) {
  const encoded = byte / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function luminance(image, offset) {
  return (
    0.2126 * srgbChannelToLinear(image.data[offset]) +
    0.7152 * srgbChannelToLinear(image.data[offset + 1]) +
    0.0722 * srgbChannelToLinear(image.data[offset + 2])
  );
}

function angularDistance(left, right) {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function supportComponents(support, width, height) {
  const visited = new Uint8Array(support.length);
  let components = 0;
  for (let start = 0; start < support.length; start++) {
    if (!support[start] || visited[start]) continue;
    components++;
    const queue = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }
          const next = nextY * width + nextX;
          if (support[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
  }
  return components;
}

export function analyzeGodRayImages(input = {}) {
  const on = imageShape(input.onImage);
  const off = imageShape(input.offImage);
  if (
    !on ||
    !off ||
    on.width !== off.width ||
    on.height !== off.height ||
    on.channels !== off.channels
  ) {
    return {
      ok: false,
      reason: "GodRay images must be matching decoded images",
    };
  }
  const pixels = on.width * on.height;
  const masks = input.masks ?? {};
  const requiredMasks = [
    "valid",
    "emitter",
    "occluder",
    "ground",
    "behindCamera",
    "border",
  ];
  for (const name of requiredMasks) {
    if (!masks[name] || masks[name].length !== pixels) {
      return { ok: false, reason: `missing ${name} mask` };
    }
  }
  const emitter = input.emitter;
  if (!emitter || !Number.isFinite(emitter.x) || !Number.isFinite(emitter.y)) {
    return { ok: false, reason: "missing projected emitter in pixels" };
  }
  const expectedDirection = input.expectedDirectionRadians;
  if (!Number.isFinite(expectedDirection)) {
    return {
      ok: false,
      status: "STRUCTURAL",
      reason:
        "radial alignment and angular width require a frozen projected shaft direction",
      unsupportedFields: [
        "radialAlignmentAngleErrorRadians",
        "angularWidthRadians",
      ],
    };
  }
  let finite = 0;
  let clipped = 0;
  let positiveEnergy = 0;
  let negativeEnergy = 0;
  let support = 0;
  let weightedCos = 0;
  let weightedSin = 0;
  let radiusSum = 0;
  let energySum = 0;
  let radiusSquaredSum = 0;
  let radiusEnergySum = 0;
  let occluderLeak = 0;
  let groundLeak = 0;
  let behindLeak = 0;
  let borderLeak = 0;
  const supportMask = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index++) {
    if (!maskAt(masks.valid, index, pixels)) continue;
    const offset = index * on.channels;
    const delta = luminance(on, offset) - luminance(off, offset);
    if (!Number.isFinite(delta)) continue;
    finite++;
    if (
      on.data[offset] === 255 ||
      on.data[offset + 1] === 255 ||
      on.data[offset + 2] === 255
    ) {
      clipped++;
    }
    const positive = Math.max(0, delta);
    positiveEnergy += positive;
    negativeEnergy += Math.max(0, -delta);
    if (positive > 0) {
      const x = index % on.width;
      const y = Math.floor(index / on.width);
      const dx = x - emitter.x;
      const dy = y - emitter.y;
      const angle = Math.atan2(dy, dx);
      const radius = Math.hypot(dx, dy);
      support++;
      supportMask[index] = 1;
      weightedCos += positive * Math.cos(angle);
      weightedSin += positive * Math.sin(angle);
      energySum += positive;
      radiusSum += radius;
      radiusSquaredSum += radius * radius;
      radiusEnergySum += radius * positive;
    }
    if (masks.occluder[index]) occluderLeak += positive;
    if (masks.ground[index]) groundLeak += positive;
    if (masks.behindCamera[index]) behindLeak += positive;
    if (masks.border[index]) borderLeak += positive;
  }
  const sampleCount = Math.max(finite, 1);
  const meanAngle = Math.atan2(weightedSin, weightedCos);
  const resultantLength =
    positiveEnergy > 0
      ? Math.hypot(weightedCos, weightedSin) / positiveEnergy
      : 0;
  const meanRadius = support > 0 ? radiusSum / support : null;
  const meanEnergy = support > 0 ? energySum / support : null;
  const radialDenominator =
    support > 0 && meanRadius !== null
      ? radiusSquaredSum - support * meanRadius * meanRadius
      : 0;
  const radialNumerator =
    support > 0 && meanRadius !== null && meanEnergy !== null
      ? radiusEnergySum - support * meanRadius * meanEnergy
      : 0;
  return {
    ok: finite > 0,
    units: {
      energy: "linearized-srgb-luminance-sum",
      normalizedEnergy: "linearized-srgb-luminance-per-valid-pixel",
      angle: "radians",
      radialFalloff: "linearized-srgb-luminance-per-pixel-radius",
    },
    finitePixelFraction: finite / pixels,
    clippedHighlightFraction: clipped / sampleCount,
    positiveEnergy,
    negativeEnergy,
    positiveEnergyPerValidPixel: positiveEnergy / sampleCount,
    shaftSupportFraction: support / sampleCount,
    connectedComponents: supportComponents(supportMask, on.width, on.height),
    radialAlignmentAngleErrorRadians:
      support && positiveEnergy > 0
        ? angularDistance(meanAngle, expectedDirection)
        : null,
    angularWidthRadians:
      support && positiveEnergy > 0 && resultantLength > 0
        ? Math.sqrt(Math.max(0, -2 * Math.log(resultantLength)))
        : null,
    radialFalloffLinearLuminancePerPixel:
      radialDenominator > 0 ? radialNumerator / radialDenominator : null,
    leakageEnergy: {
      occluder: occluderLeak,
      ground: groundLeak,
      behindCamera: behindLeak,
      border: borderLeak,
    },
    repeatOff: input.repeatOffImage
      ? imageDeltaMetrics(off.data, input.repeatOffImage.data)
      : null,
    repeatOn: input.repeatOnImage
      ? imageDeltaMetrics(on.data, input.repeatOnImage.data)
      : null,
    sampleCount,
  };
}

export function composeCloudMetrics(input = {}) {
  try {
    return {
      ok: true,
      cloud: analyzeCloudImages(input.onImage, input.offImage, input.options),
      offOn: imageDeltaMetrics(input.offImage.data, input.onImage.data),
      frames: framewiseDeltaSeries(
        input.frames ?? [input.offImage.data, input.onImage.data],
      ),
      repeat: ghostMetrics({
        reference: input.offImage.data,
        reconverged: input.repeatOffImage?.data ?? input.offImage.data,
        floorMeanAbsRgbDelta: input.floorMeanAbsRgbDelta,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function computeC13_42CellMetrics(input = {}) {
  if (input.kind === "godRay") {
    const offOn = imageDeltaMetrics(input.offImage?.data, input.onImage?.data);
    const frames = framewiseDeltaSeries(
      input.frames ?? [input.offImage?.data, input.onImage?.data],
    );
    const repeatOff = input.repeatOffImage
      ? imageDeltaMetrics(input.offImage?.data, input.repeatOffImage.data)
      : null;
    const repeatOn = input.repeatOnImage
      ? imageDeltaMetrics(input.onImage?.data, input.repeatOnImage.data)
      : null;
    const godRay =
      input.masks || input.emitter ? analyzeGodRayImages(input) : null;
    return {
      ok:
        offOn.ok &&
        frames.ok &&
        (repeatOff === null || repeatOff.ok) &&
        (repeatOn === null || repeatOn.ok) &&
        (godRay === null || godRay.ok),
      cloud: null,
      toggle: { offOn, frames, repeatOff, repeatOn },
      godRay,
    };
  }
  const cloud = composeCloudMetrics(input);
  const godRay =
    input.masks || input.emitter ? analyzeGodRayImages(input) : null;
  return {
    ok: cloud.ok && (godRay === null || godRay.ok),
    cloud,
    godRay,
  };
}

export default {
  C13_42_CONTRACT_VERSION,
  REPORTED_PAGE_PROFILES,
  C13_42_REPRODUCTION_PROFILES,
  CONTROLLED_RAY_FIXTURE_OBLIGATION,
  CONTROLLED_RAY_PROVIDER_OBLIGATION,
  CHARACTERIZATION_THRESHOLDS,
  CHARACTERIZATION_THRESHOLD_DERIVATION,
  C13_42_OBSERVED_SERVED_OVERFLOW,
  C13_42_SERVED_RESPONSE_BUDGET,
  assessControlledRayFixture,
  characterizationDisposition,
  deriveCharacterizationThresholds,
  deriveServedResponseBudget,
  servedResponseBudgetFor,
  servedResponseBudgetMs,
  assessC13_42ServedResponseBudget,
  initialCoreSubjects,
  buildC13_42Schedule,
  offlineCaptureRequest,
  fixtureScheduleHash,
  metricDefinitionHash,
  hashC13_42Definition,
  classifyC13_42ServedArtifact,
  assessC13_42ServedClosure,
  validateReceipt,
  validateC13_42Receipt,
  foldReceipt,
  foldC13_42Verdicts,
  validateBaselineRepairComparability,
  compareC13_42Phases,
  analyzeGodRayImages,
  composeCloudMetrics,
  computeC13_42CellMetrics,
};
