/**
 * C13-01 tour contract spec — pure Node, no browser.
 *
 * This is the gate that makes the fixture/sequence/metric work checkable
 * without an Edge cycle. It holds four contracts:
 *
 *   1. COVERAGE. The fixture and sequence tables satisfy the C13-01 queue row
 *      in the row's own words — four-plus climate/region fixtures, three-plus
 *      genera, multiple same-type formations, both dateline directions, both
 *      poles, ground/inside-deck/above-deck/orbital, altitude transitions, and
 *      wind/time + teleport + history-reset sequences.
 *   2. DETERMINISM. Clocks are pinned and derived, never sampled; replay keys
 *      are stable and sensitive; the probe cannot reach wall time.
 *   3. NO CPU TWIN. Every constant this tooling mirrors from the engine — the
 *      temporal reset bit table, the cloud quality-flag bits, the tier presets,
 *      the genus enum — is asserted against the ENGINE's own exports. A renamed
 *      or renumbered engine constant fails here, in milliseconds, instead of
 *      producing a manifest that confidently reports the wrong cause.
 *   4. PROBE DISCIPLINE. The probe embeds the canonical same-task capture block
 *      byte-for-byte, never reads a canvas outside it, boots offline, carries a
 *      watchdog, implements every action the sequence table can name, and has
 *      no unbounded loop.
 *
 * Run: node --test Tools/visual-regression/cloud-tour-sequences.spec.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import CloudType from "../../packages/engine/Source/Scene/CloudType.js";
import {
  CLOUD_TEMPORAL_RESET_DECK_BOUNDS,
  CLOUD_TEMPORAL_RESET_FRAME_GAP,
  CLOUD_TEMPORAL_RESET_INITIAL,
  CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM,
  CLOUD_TEMPORAL_RESET_MORPH,
  CLOUD_TEMPORAL_RESET_MULTI_DECK,
  CLOUD_TEMPORAL_RESET_NONE,
  CLOUD_TEMPORAL_RESET_PROJECTION,
  CLOUD_TEMPORAL_RESET_REACTIVATED,
  CLOUD_TEMPORAL_RESET_RESOURCE,
  CLOUD_TEMPORAL_RESET_SCENE_MODE,
  CLOUD_TEMPORAL_RESET_TELEPORT,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTemporalHistory.ts";
import {
  CLOUD_QF_HALF_RES,
  CLOUD_QF_JITTER,
  CLOUD_QF_LIGHT_CONE,
  CLOUD_QF_NOISE_BAKED,
  CLOUD_QF_PLANET_DENSITY,
  CLOUD_QF_TEMPORAL,
  CLOUD_TIER_PRESETS,
  CloudNoiseSource,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";

import {
  CLOUD_TOUR_FIXTURES,
  CLOUD_TOUR_SEQUENCES,
  PHASE_ACTIONS,
  SEQUENCE_KINDS,
  STATION_REGIMES,
  fixtureById,
  fixtureClockIso,
  fixtureReplaySubset,
  replayKeyFor,
  sequenceById,
  sequenceFrameBudget,
  sequenceReplaySubset,
  stableStringify,
  summarizeFixtureCoverage,
  utcIsoForLocalSolarHour,
  validateFixture,
  validateFixtureSet,
  validateSequence,
  validateSequenceSet,
} from "./lib/cloud-tour-fixtures.mjs";
import {
  CLOUD_QF_BITS,
  CLOUD_TEMPORAL_RESET_BIT_NAMES,
  REQUIRED_SEQUENCE_METRIC_PATHS,
  assessInterleavedAb,
  assessPhaseReset,
  decodeResetReasons,
  defaultControlPasses,
  deriveCloudTier,
  frameDistribution,
  parseControlPasses,
  framewiseDeltaSeries,
  ghostMetrics,
  imageDeltaMetrics,
  summarizeGpuPasses,
  validateSequenceMetricRecord,
} from "./lib/cloud-tour-metrics.mjs";
import { assertSourcePinIsWidthSafe } from "./lib/provenance-markers.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = "probe-cloud-tour-sequences.mjs";
const probeSource = fs
  .readFileSync(path.join(here, PROBE), "utf8")
  .replace(/\r\n/g, "\n");

/**
 * The probe with comments blanked out, for pins that forbid a CODE shape.
 *
 * Written after this suite's own "no argument-less render" pin fired on a
 * COMMENT explaining why an argument-less render would be wrong. A forbidding
 * pin matched against prose punishes the author for documenting the trap, which
 * is the fastest way to get the documentation deleted instead of the pin fixed.
 * Newlines are preserved so any diagnostic still points at the right line.
 */
const probeCode = probeSource
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) =>
    lead + " ".repeat(match.length - lead.length),
  );

// ── 1. Coverage ───────────────────────────────────────────────────────────

test("the fixture table validates clean", () => {
  assert.deepEqual(validateFixtureSet(), []);
});

test("the sequence table validates clean", () => {
  assert.deepEqual(validateSequenceSet(), []);
});

test("fixtures answer the C13-01 row's coverage words", () => {
  const coverage = summarizeFixtureCoverage();

  // "at least four distinct climate/region fixtures"
  assert.ok(
    coverage.climates.length >= 4,
    `climates: ${coverage.climates.join(", ")}`,
  );
  assert.ok(coverage.regions.length >= 4, `regions: ${coverage.regions.join(", ")}`);

  // "at least three cloud types, including multiple same-type formations"
  assert.ok(coverage.genera.length >= 3, `genera: ${coverage.genera.join(", ")}`);
  assert.ok(
    coverage.sameTypeGroups.length >= 2,
    "at least two genera must carry multiple formations",
  );
  for (const group of coverage.sameTypeGroups) {
    assert.ok(group.fixtureIds.length >= 2);
  }

  // "low-altitude ground/horizon; inside a cloud deck; above the deck;
  //  orbital altitude and altitude transitions"
  assert.deepEqual([...coverage.regimes].sort(), [...STATION_REGIMES].sort());
  assert.equal(coverage.hasAltitudeTransition, true);

  // "dateline crossings in both directions"
  assert.deepEqual(coverage.datelineDirections, ["east", "west"]);

  // "north- and south-pole approaches"
  assert.deepEqual(coverage.poles, ["north", "south"]);

  // Not in the row, but the row's evidence is worthless without it.
  assert.equal(coverage.hasNegativeControl, true);
});

test("sequences answer the row's wind/time, teleport and history-reset words", () => {
  const kinds = new Set(CLOUD_TOUR_SEQUENCES.map((sequence) => sequence.kind));
  for (const kind of SEQUENCE_KINDS) {
    assert.ok(kinds.has(kind), `no sequence of kind ${kind}`);
  }

  // The wind/time evidence is a three-lane SET; a single wind lane cannot
  // separate advection from the sun moving.
  const windLanes = CLOUD_TOUR_SEQUENCES.filter(
    (sequence) => sequence.kind === "wind-time",
  );
  assert.equal(windLanes.length, 3);
  assert.equal(new Set(windLanes.map((lane) => lane.fixtureId)).size, 1);
  const signature = windLanes
    .map((lane) => `${lane.clock.stepSeconds}/${lane.volumetric.cloudWindSpeed}`)
    .sort();
  assert.deepEqual(signature, ["0/0", "60/0", "60/15"]);

  // Teleport and reset sequences must run where a history exists.
  for (const sequence of CLOUD_TOUR_SEQUENCES) {
    const asserts = sequence.phases.some(
      (phase) => Number.isInteger(phase.expectResetBits) && phase.expectResetBits !== 0,
    );
    if (asserts) {
      assert.ok(
        ["low", "medium"].includes(sequence.volumetric?.cloudVolumetricQuality),
        `${sequence.id} asserts resets on a non-temporal tier`,
      );
    }
  }

  // The reset taxonomy must provoke more than one distinct cause, or it is a
  // "did anything reset" check wearing a taxonomy's name.
  const taxonomy = CLOUD_TOUR_SEQUENCES.find(
    (sequence) => sequence.kind === "history-reset",
  );
  const causes = taxonomy.phases
    .map((phase) => phase.expectResetBits ?? 0)
    .filter((bits) => bits !== 0);
  assert.ok(
    new Set(causes).size >= 3,
    "the history-reset sequence must provoke at least three distinct causes",
  );
});

test("every sequence has a constant, bounded frame budget", () => {
  for (const sequence of CLOUD_TOUR_SEQUENCES) {
    const budget = sequenceFrameBudget(sequence);
    assert.ok(Number.isInteger(budget) && budget > 0 && budget < 2000, sequence.id);
  }
});

// ── 1b. The validators are not vacuous ────────────────────────────────────

test("validateFixture rejects a station whose regime contradicts its own deck", () => {
  const fixture = fixtureById("plains-fairweather-cumulus");
  const broken = {
    ...fixture,
    stations: fixture.stations.map((station) =>
      station.regime === "inside-deck" ? { ...station, height: 40000 } : station,
    ),
  };
  const failures = validateFixture(broken);
  assert.ok(
    failures.some((failure) => /regime inside-deck but height/.test(failure)),
    failures.join("\n"),
  );
});

test("validateFixture rejects a gate with no justification and a genus mismatch", () => {
  const fixture = fixtureById("sahara-clear-sky");
  assert.ok(
    validateFixture({ ...fixture, gate: { maxChangedFraction: 0.02 } }).some(
      (failure) => /gate\.why/.test(failure),
    ),
  );
  assert.ok(
    validateFixture({
      ...fixture,
      volumetric: { ...fixture.volumetric, cloudType: CloudType.CIRRUS },
    }).some((failure) => /volumetric\.cloudType must equal/.test(failure)),
  );
});

test("validateFixtureSet rejects an undeclared same-genus duplicate", () => {
  const original = fixtureById("plains-fairweather-cumulus");
  const clone = {
    ...original,
    id: "plains-fairweather-cumulus-copy",
    region: "somewhere-else",
    climate: "another-climate",
  };
  const failures = validateFixtureSet([...CLOUD_TOUR_FIXTURES, clone]);
  assert.ok(
    failures.some((failure) => /share an identical volumetric/.test(failure)),
    failures.join("\n"),
  );
});

test("validateSequence rejects an unbounded phase and an unknown action", () => {
  const sequence = sequenceById("teleport-hemisphere-jump");
  const unbounded = {
    ...sequence,
    phases: sequence.phases.map((phase, index) =>
      index === 0 ? { ...phase, frames: 0 } : phase,
    ),
  };
  assert.ok(
    validateSequence(unbounded).some((failure) =>
      /frames must be a positive integer/.test(failure),
    ),
  );
  const bogus = {
    ...sequence,
    phases: sequence.phases.map((phase, index) =>
      index === 0 ? { ...phase, action: "warp-drive" } : phase,
    ),
  };
  assert.ok(
    validateSequence(bogus).some((failure) => /unknown action warp-drive/.test(failure)),
  );
});

test("the reset grace window is bounded and never applied to an expected reset", () => {
  const sequence = sequenceById("history-reset-taxonomy");
  const settle = sequence.phases.find((phase) => phase.id === "settle-after-resize");
  assert.ok(settle.resetAssertFromFrame > 0, "a settle phase needs a grace window");
  assert.ok(settle.resetAssertFromFrame <= settle.frames / 2);

  // Grace that swallows the whole phase is a vacuous assertion.
  const vacuous = {
    ...sequence,
    phases: sequence.phases.map((phase) =>
      phase.id === "settle-after-resize"
        ? { ...phase, resetAssertFromFrame: phase.frames }
        : phase,
    ),
  };
  assert.ok(validateSequence(vacuous).some((failure) => /vacuous/.test(failure)));

  // A phase that EXPECTS a reset must watch from frame 0 — the edge it is
  // looking for is at the start of the phase.
  const blinded = {
    ...sequence,
    phases: sequence.phases.map((phase) =>
      phase.id === "resized" ? { ...phase, resetAssertFromFrame: 1 } : phase,
    ),
  };
  assert.ok(
    validateSequence(blinded).some((failure) => /must observe from frame 0/.test(failure)),
  );

  // No phase that expects a reset carries a grace.
  for (const entry of CLOUD_TOUR_SEQUENCES) {
    for (const phase of entry.phases) {
      if (phase.expectResetBits) {
        assert.ok(!phase.resetAssertFromFrame, `${entry.id}/${phase.id}`);
      }
    }
  }
});

test("the probe applies the grace window and still records the full mask", () => {
  assert.match(probeSource, /assertedResetMask/);
  assert.match(probeSource, /observedAllFrames/);
  assert.match(
    probeSource,
    /assessPhaseReset\(phase,\s*result\.assertedResetMask\)/,
    "the assertion must use the graced mask, not the raw one",
  );
  // The resize phase cannot provoke a RESOURCE reset unless the canvas actually
  // resizes, and `scene.render()` does not do that on its own.
  assert.match(probeSource, /viewer\.resize\?\.\(\)/);
});

test("validateSequence rejects reset assertions on a non-temporal tier", () => {
  const sequence = sequenceById("history-reset-taxonomy");
  const cinematic = {
    ...sequence,
    volumetric: { ...sequence.volumetric, cloudVolumetricQuality: "high" },
  };
  assert.ok(
    validateSequence(cinematic).some((failure) => /vacuous/.test(failure)),
    "a T3 reset assertion must be rejected as vacuous",
  );
});

// ── 2. Determinism ────────────────────────────────────────────────────────

test("local-solar-hour clocks are correct, pinned and stable", () => {
  // Greenwich: local solar noon is UTC noon.
  assert.equal(utcIsoForLocalSolarHour(0, 12), "2026-06-21T12:00:00Z");
  // 90E is six hours ahead, so local noon is 06:00 UTC.
  assert.equal(utcIsoForLocalSolarHour(90, 12), "2026-06-21T06:00:00Z");
  // 90W is six hours behind.
  assert.equal(utcIsoForLocalSolarHour(-90, 12), "2026-06-21T18:00:00Z");
  // Longitude wrapping is equivalent, not merely tolerated.
  assert.equal(utcIsoForLocalSolarHour(190, 9), utcIsoForLocalSolarHour(-170, 9));
  // Same inputs, same output, always.
  assert.equal(utcIsoForLocalSolarHour(37.5, 7.25), utcIsoForLocalSolarHour(37.5, 7.25));
  assert.throws(() => utcIsoForLocalSolarHour(0, 24), /localSolarHour/);
  assert.throws(() => utcIsoForLocalSolarHour(Number.NaN, 12), /longitude/);
  assert.throws(() => utcIsoForLocalSolarHour(0, 12, "21-06-2026"), /YYYY-MM-DD/);
});

test("every fixture pins a whole-second UTC instant", () => {
  for (const fixture of CLOUD_TOUR_FIXTURES) {
    const iso = fixtureClockIso(fixture);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, fixture.id);
    assert.equal(iso, fixtureClockIso(fixture), `${fixture.id} clock is not stable`);
  }
});

test("the antimeridian twins are pinned to the SAME instant", () => {
  const east = fixtureById("dateline-east-convective");
  const west = fixtureById("dateline-west-convective");
  assert.equal(fixtureClockIso(east), fixtureClockIso(west));
  assert.equal(
    stableStringify(east.volumetric),
    stableStringify(west.volumetric),
    "twins must share a configuration or the pair varies more than one thing",
  );
  assert.notEqual(east.dateline, west.dateline);
});

test("replay keys are stable, sensitive to render inputs, and blind to gates", () => {
  for (const fixture of CLOUD_TOUR_FIXTURES) {
    const key = replayKeyFor(fixtureReplaySubset(fixture));
    assert.match(key, /^[0-9a-f]{8}$/);
    assert.equal(key, replayKeyFor(fixtureReplaySubset(fixture)));

    // A render input moves the key ...
    const moved = {
      ...fixture,
      volumetric: { ...fixture.volumetric, cloudCoverage: fixture.volumetric.cloudCoverage / 2 },
    };
    assert.notEqual(replayKeyFor(fixtureReplaySubset(moved)), key, fixture.id);

    // ... and a judgement threshold does not.
    const regated = { ...fixture, gate: { ...fixture.gate, why: "revised wording here" } };
    assert.equal(replayKeyFor(fixtureReplaySubset(regated)), key, fixture.id);
  }
  const keys = new Set(
    CLOUD_TOUR_FIXTURES.map((fixture) => replayKeyFor(fixtureReplaySubset(fixture))),
  );
  assert.equal(keys.size, CLOUD_TOUR_FIXTURES.length, "fixture replay keys collide");

  const sequenceKeys = new Set(
    CLOUD_TOUR_SEQUENCES.map((sequence) => replayKeyFor(sequenceReplaySubset(sequence))),
  );
  assert.equal(sequenceKeys.size, CLOUD_TOUR_SEQUENCES.length);
});

test("canonical stringification is order-independent", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

// ── 3. No CPU twin: engine constants are the source of truth ──────────────

test("the reset bit-name table mirrors the engine exactly", () => {
  const engineBits = {
    INITIAL: CLOUD_TEMPORAL_RESET_INITIAL,
    MISSING_TRANSFORM: CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM,
    FRAME_GAP: CLOUD_TEMPORAL_RESET_FRAME_GAP,
    TELEPORT: CLOUD_TEMPORAL_RESET_TELEPORT,
    SCENE_MODE: CLOUD_TEMPORAL_RESET_SCENE_MODE,
    MORPH: CLOUD_TEMPORAL_RESET_MORPH,
    PROJECTION: CLOUD_TEMPORAL_RESET_PROJECTION,
    REACTIVATED: CLOUD_TEMPORAL_RESET_REACTIVATED,
    DECK_BOUNDS: CLOUD_TEMPORAL_RESET_DECK_BOUNDS,
    MULTI_DECK: CLOUD_TEMPORAL_RESET_MULTI_DECK,
    RESOURCE: CLOUD_TEMPORAL_RESET_RESOURCE,
  };
  // Every engine constant decodes to exactly its own name ...
  for (const [name, bit] of Object.entries(engineBits)) {
    assert.deepEqual(decodeResetReasons(bit), [name], `bit ${bit}`);
  }
  // ... and the mirror table holds nothing the engine does not define.
  const engineValues = new Set(Object.values(engineBits));
  for (const index of Object.keys(CLOUD_TEMPORAL_RESET_BIT_NAMES)) {
    assert.ok(
      engineValues.has(1 << Number(index)),
      `mirror table declares bit ${index}, which the engine does not export`,
    );
  }
  assert.deepEqual(decodeResetReasons(CLOUD_TEMPORAL_RESET_NONE), []);
  // An unknown bit is surfaced, never dropped.
  assert.deepEqual(decodeResetReasons(1 << 20), ["BIT_20"]);
});

test("the quality-flag bit table mirrors the engine exactly", () => {
  assert.equal(CLOUD_QF_BITS.NOISE_BAKED, CLOUD_QF_NOISE_BAKED);
  assert.equal(CLOUD_QF_BITS.HALF_RES, CLOUD_QF_HALF_RES);
  assert.equal(CLOUD_QF_BITS.TEMPORAL, CLOUD_QF_TEMPORAL);
  assert.equal(CLOUD_QF_BITS.JITTER, CLOUD_QF_JITTER);
  assert.equal(CLOUD_QF_BITS.LIGHT_CONE, CLOUD_QF_LIGHT_CONE);
  assert.equal(CLOUD_QF_BITS.PLANET_DENSITY, CLOUD_QF_PLANET_DENSITY);
});

test("tier derivation agrees with the engine's own preset table", () => {
  // Flags are assembled the way `WebGPUProceduralCloudRenderer` assembles them:
  // BAKED from noiseSource, HALF_RES from renderResScale, TEMPORAL from
  // temporalEnabled, LIGHT_CONE from lightConeSampling.
  for (const preset of CLOUD_TIER_PRESETS) {
    if (preset.tier === 0) {
      continue; // T0 does not run the cloud pass, so nothing is realized.
    }
    const flags =
      (preset.noiseSource === CloudNoiseSource.BAKED ? CLOUD_QF_NOISE_BAKED : 0) |
      (preset.renderResScale < 1 ? CLOUD_QF_HALF_RES : 0) |
      (preset.temporalEnabled ? CLOUD_QF_TEMPORAL : 0) |
      (preset.lightConeSampling ? CLOUD_QF_LIGHT_CONE : 0);
    const derived = deriveCloudTier({
      qualityFlags: flags,
      lightSteps: preset.lightSteps,
      maxSteps: preset.primarySteps,
    });
    assert.equal(derived.tier, preset.tier, `tier ${preset.tier} flags ${flags}`);
    assert.equal(derived.confidence, "exact");
  }
});

test("tier derivation refuses to guess", () => {
  // Live noise is the power-user escape hatch, not T1 — `resolveCloudPreset`
  // labels it `tier: 1` and reporting that as T1 would misattribute a whole
  // A/B lane.
  assert.equal(
    deriveCloudTier({ qualityFlags: 0, lightSteps: 6, maxSteps: 96 }).tierName,
    "escape-hatch-live",
  );
  // A degraded T1/T2 whose history allocation failed keeps the half-res + cone
  // bits but loses TEMPORAL. That is not T3 and it is not T1.
  const degraded = deriveCloudTier({
    qualityFlags: CLOUD_QF_NOISE_BAKED | CLOUD_QF_HALF_RES | CLOUD_QF_LIGHT_CONE,
    lightSteps: 3,
    maxSteps: 24,
  });
  assert.equal(degraded.tier, null);
  assert.equal(degraded.confidence, "ambiguous");
  // Nothing realized at all.
  assert.equal(
    deriveCloudTier({}).confidence,
    "unrealized",
  );
});

test("every fixture names a real CloudType genus", () => {
  for (const fixture of CLOUD_TOUR_FIXTURES) {
    assert.equal(CloudType.validate(fixture.cloudType), true, fixture.id);
    assert.equal(fixture.volumetric.cloudType, fixture.cloudType, fixture.id);
  }
});

// ── 4. Metric contracts ───────────────────────────────────────────────────

test("frame distribution reports percentiles and never invents a zero", () => {
  const empty = frameDistribution([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p95Ms, null, "an empty sample must not read as a 0 ms frame");
  const stats = frameDistribution([5, 1, 3, 2, 4]);
  assert.equal(stats.count, 5);
  assert.equal(stats.p50Ms, 3);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.maxMs, 5);
  // Nearest-rank: every reported percentile is a frame that actually happened.
  assert.ok([1, 2, 3, 4, 5].includes(stats.p95Ms));
  assert.equal(frameDistribution([1, Number.NaN, 3]).count, 2);
});

test("image delta treats a structural mismatch as a failure, not as zero", () => {
  const a = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const b = new Uint8ClampedArray([0, 0, 0, 255]);
  const mismatch = imageDeltaMetrics(a, b);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.changedFraction, null);
  assert.match(mismatch.reason, /length mismatch/);

  const identical = imageDeltaMetrics(a, a);
  assert.equal(identical.ok, true);
  assert.equal(identical.changedPixels, 0);
  assert.equal(identical.meanAbsRgbDelta, 0);

  const changed = imageDeltaMetrics(
    a,
    new Uint8ClampedArray([0, 0, 0, 255, 40, 40, 40, 255]),
  );
  assert.equal(changed.changedPixels, 1);
  assert.equal(changed.changedFraction, 0.5);
  assert.equal(changed.maxChannelDelta, 40);
});

test("framewise series needs two frames and propagates a structural failure", () => {
  const frame = new Uint8ClampedArray([1, 2, 3, 255]);
  assert.equal(framewiseDeltaSeries([frame]).ok, false);
  assert.equal(framewiseDeltaSeries([frame, frame]).meanAbsRgbDelta, 0);
  const bad = framewiseDeltaSeries([frame, new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])]);
  assert.equal(bad.ok, false);
  assert.equal(bad.meanAbsRgbDelta, null);
});

test("the ghost oracle is the same-pose residual, anchored to the run's own floor", () => {
  const reference = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]);
  const clean = ghostMetrics({
    reference,
    reconverged: reference,
    floorMeanAbsRgbDelta: 0.5,
  });
  assert.equal(clean.residual.meanAbsRgbDelta, 0);
  assert.equal(clean.ghostOverFloor, 0);

  const ghosted = ghostMetrics({
    reference,
    reconverged: new Uint8ClampedArray([130, 130, 130, 255, 100, 100, 100, 255]),
    floorMeanAbsRgbDelta: 0.5,
  });
  assert.ok(ghosted.residual.meanAbsRgbDelta > 0);
  assert.ok(ghosted.ghostOverFloor > 1, "a real residual must exceed the noise floor");

  // Without a floor the number is reported but NOT turned into a ratio — an
  // unanchored ghost figure is not a verdict.
  assert.equal(
    ghostMetrics({ reference, reconverged: reference }).ghostOverFloor,
    null,
  );
});

test("phase reset assessment is two-sided", () => {
  const expectTeleport = { expectResetBits: CLOUD_TEMPORAL_RESET_TELEPORT };
  assert.equal(assessPhaseReset(expectTeleport, CLOUD_TEMPORAL_RESET_TELEPORT).ok, true);

  const missed = assessPhaseReset(expectTeleport, 0);
  assert.equal(missed.ok, false);
  assert.deepEqual(missed.missing, ["TELEPORT"]);

  // `expectResetBits: 0` means "must not reset at all" — a settled phase that
  // resets every frame is the failure a nonzero-only check cannot see.
  const settled = assessPhaseReset(
    { expectResetBits: 0 },
    CLOUD_TEMPORAL_RESET_FRAME_GAP,
  );
  assert.equal(settled.ok, false);
  assert.deepEqual(settled.unexpected, ["FRAME_GAP"]);

  const forbidden = assessPhaseReset(
    { expectResetBits: CLOUD_TEMPORAL_RESET_INITIAL, forbidResetBits: CLOUD_TEMPORAL_RESET_TELEPORT },
    CLOUD_TEMPORAL_RESET_INITIAL | CLOUD_TEMPORAL_RESET_TELEPORT,
  );
  assert.equal(forbidden.ok, false);
  assert.deepEqual(forbidden.unexpected, ["TELEPORT"]);

  // No observation is not a pass.
  assert.equal(assessPhaseReset(expectTeleport, null).ok, false);
});

test("a pass the profiler never saw is absent, not fast", () => {
  const summary = summarizeGpuPasses(
    { enabled: true, frameCount: 60, passes: { "ProceduralClouds pass": { avgMs: 1.5 } } },
    ["ProceduralClouds pass", "CloudShadow map pass"],
  );
  assert.equal(summary.passes["ProceduralClouds pass"].present, true);
  assert.equal(summary.passes["ProceduralClouds pass"].avgMs, 1.5);
  assert.equal(summary.passes["CloudShadow map pass"].present, false);
  assert.equal(
    summary.passes["CloudShadow map pass"].avgMs,
    null,
    "a missing pass must not average into an A/B as a very fast pass",
  );
  assert.equal(summary.observedCount, 1);
  assert.equal(summary.declaredCount, 2);
  assert.equal(summarizeGpuPasses(null, ["x"]).profiler, null);
});

// ── 4b. Per-sequence metric completeness ─────────────────────────────────

function completeRecord() {
  return {
    id: "sample",
    kind: "wind-time",
    fixtureId: "plains-fairweather-cumulus",
    replayKey: "abcdef01",
    provenance: {
      commit: "0".repeat(40),
      runtimeBundle: { path: "Build/CesiumUnminified/Cesium.js", byteLength: 1, sha256: "a".repeat(64) },
    },
    environment: {
      adapterInfo: { vendor: "nvidia" },
      browserVersion: "1.2.3",
      canvas: { width: 1024, height: 768 },
    },
    configuration: { requestedVolumetric: {}, configTruth: { ok: true } },
    clock: { baseIso: "2026-06-21T18:20:00Z", stepSeconds: 0, frames: 48 },
    realization: {
      tier: 3,
      tierName: "T3-cinematic",
      tierEvidence: {},
      currentTarget: { width: 1024, height: 768 },
      historyTarget: { width: 0, height: 0 },
    },
    cpuFrames: { count: 40, p50Ms: 3, p95Ms: 6, p99Ms: 8 },
    gpu: { supported: true, passes: {}, profiler: { enabled: true } },
    temporal: { phases: [], framewise: [], ghost: null },
    screenshots: [{ phase: "hold-first", path: `${"x"}.png`, sha256: "b".repeat(64) }],
    structural: { ok: true },
  };
}

test("a complete per-sequence record validates", () => {
  assert.deepEqual(validateSequenceMetricRecord(completeRecord()), []);
});

test("every required metric path is actually enforced", () => {
  // Deleting each path in turn must produce a failure naming it. Without this
  // the required-path list could drift into decoration.
  for (const requiredPath of REQUIRED_SEQUENCE_METRIC_PATHS) {
    const record = completeRecord();
    const keys = requiredPath.split(".");
    let cursor = record;
    for (const key of keys.slice(0, -1)) {
      cursor = cursor[key];
    }
    delete cursor[keys[keys.length - 1]];
    const failures = validateSequenceMetricRecord(record);
    assert.ok(
      failures.some((failure) => failure.includes(requiredPath)),
      `deleting ${requiredPath} produced no naming failure: ${failures.join("; ")}`,
    );
  }
});

test("record validation catches an unusable screenshot and an unverifiable clock walk", () => {
  const noSha = completeRecord();
  noSha.screenshots = [{ phase: "hold", path: "a.png" }];
  assert.ok(
    validateSequenceMetricRecord(noSha).some((failure) => /sha256/.test(failure)),
  );

  const advancing = completeRecord();
  advancing.clock.stepSeconds = 60;
  assert.ok(
    validateSequenceMetricRecord(advancing).some((failure) => /end instant/.test(failure)),
  );

  const lying = completeRecord();
  lying.gpu.profiler = null;
  assert.ok(
    validateSequenceMetricRecord(lying).some((failure) =>
      /supported but no profiler result/.test(failure),
    ),
  );
});

// ── 4c. The interleaved A/B protocol, as a function ──────────────────────

function manifest({ tag, round, order, sha, deltas = {} }) {
  return {
    manifestVersion: "c13-01-tour-sequences/1",
    tag,
    round,
    order,
    pairId: "pair-1",
    source: { runtimeBundle: { sha256: sha } },
    environment: {
      adapterInfo: { vendor: "nvidia" },
      browserVersion: "1.2.3",
      canvas: { width: 1024, height: 768 },
      viewport: { width: 1024, height: 768 },
    },
    measurement: { kind: "x" },
    sequences: [
      {
        id: "wind-time-advection",
        replayKey: "key-1",
        structural: { ok: true },
        gpu: {
          passes: {
            "ProceduralClouds pass": { avgMs: deltas.march ?? 10 },
            "CloudUpscale composite pass": { avgMs: deltas.control ?? 2 },
          },
        },
      },
    ],
  };
}

const CONTROLS = { "wind-time-advection": ["CloudUpscale composite pass"] };

test("one binary measured twice is not an A/B", () => {
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "pre", round: 1, order: "post-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 1, order: "post-first", sha: "a".repeat(64) }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "session-drifting");
  assert.ok(
    result.rounds.every((round) =>
      round.failures.some((failure) => /SAME runtime bundle/.test(failure)),
    ),
  );
});

test("a single round cannot answer the question", () => {
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 0, order: "pre-first", sha: "b".repeat(64) }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "insufficient-rounds");
});

test("every round in the same order is rejected", () => {
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 0, order: "pre-first", sha: "b".repeat(64), deltas: { march: 7 } }),
      manifest({ tag: "pre", round: 1, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 1, order: "pre-first", sha: "b".repeat(64), deltas: { march: 7 } }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "no-reverse-order");
});

test("a round whose control pass moved is discarded, not interpreted", () => {
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      // Control moved 2 -> 3 (+50%): this is the 2026-07-24 drift signature.
      manifest({
        tag: "post",
        round: 0,
        order: "pre-first",
        sha: "b".repeat(64),
        deltas: { march: 7, control: 3 },
      }),
      manifest({ tag: "pre", round: 1, order: "post-first", sha: "a".repeat(64) }),
      manifest({
        tag: "post",
        round: 1,
        order: "post-first",
        sha: "b".repeat(64),
        deltas: { march: 7 },
      }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "session-drifting");
  assert.equal(result.rounds[0].controlDrifted, true);
  assert.equal(result.rounds[0].usable, false);
  assert.equal(result.rounds[1].usable, true);
});

test("a reproducing effect across two orders is reported as reproducible", () => {
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 0, order: "pre-first", sha: "b".repeat(64), deltas: { march: 7 } }),
      manifest({ tag: "pre", round: 1, order: "post-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 1, order: "post-first", sha: "b".repeat(64), deltas: { march: 7.2 } }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "assessed");
  const march = result.verdict["wind-time-advection / ProceduralClouds pass"];
  assert.equal(march.direction, "faster");
  assert.equal(march.reproducible, true);
  const control = result.verdict["wind-time-advection / CloudUpscale composite pass"];
  assert.equal(control.direction, "unchanged");
});

test("halves that replayed different definitions are not comparable", () => {
  const post = manifest({ tag: "post", round: 0, order: "pre-first", sha: "b".repeat(64) });
  post.sequences[0].replayKey = "key-2";
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      post,
      manifest({ tag: "pre", round: 1, order: "post-first", sha: "a".repeat(64) }),
      manifest({ tag: "post", round: 1, order: "post-first", sha: "b".repeat(64) }),
    ],
    controlPasses: CONTROLS,
  });
  assert.equal(result.status, "session-drifting");
  assert.ok(
    result.rounds[0].failures.some((failure) => /replay keys differ/.test(failure)),
  );
});

test("the default drift controls are the non-march passes, and are overridable", () => {
  const controls = defaultControlPasses(CLOUD_TOUR_SEQUENCES);
  // Every temporal sequence contributes its resolve + composite as controls ...
  const temporal = CLOUD_TOUR_SEQUENCES.filter((sequence) =>
    sequence.gpuPasses.includes("CloudTemporalResolve pass"),
  );
  assert.ok(temporal.length > 0);
  for (const sequence of temporal) {
    assert.deepEqual(controls[sequence.id], [
      "CloudTemporalResolve pass",
      "CloudUpscale composite pass",
    ]);
  }
  // ... and a march-only sequence contributes no control, because the pass it
  // declares is the one under test.
  for (const sequence of CLOUD_TOUR_SEQUENCES) {
    if (sequence.gpuPasses.every((name) => name.startsWith("ProceduralClouds"))) {
      assert.equal(controls[sequence.id], undefined, sequence.id);
    }
  }

  assert.deepEqual(
    parseControlPasses("a:One pass|Two pass,b:Three pass", CLOUD_TOUR_SEQUENCES),
    { a: ["One pass", "Two pass"], b: ["Three pass"] },
  );
  assert.deepEqual(
    parseControlPasses("", CLOUD_TOUR_SEQUENCES),
    defaultControlPasses(CLOUD_TOUR_SEQUENCES),
  );
  assert.throws(() => parseControlPasses("no-colon", CLOUD_TOUR_SEQUENCES), /sequenceId/);
  assert.throws(() => parseControlPasses("a:", CLOUD_TOUR_SEQUENCES), /no pass/);
});

test("a mismatched environment is refused outright", () => {
  const other = manifest({ tag: "post", round: 0, order: "pre-first", sha: "b".repeat(64) });
  other.environment.adapterInfo = { vendor: "amd" };
  const result = assessInterleavedAb({
    manifests: [
      manifest({ tag: "pre", round: 0, order: "pre-first", sha: "a".repeat(64) }),
      other,
    ],
  });
  assert.equal(result.status, "incomparable-environment");
});

// ── 5. Probe discipline ───────────────────────────────────────────────────

test("no tooling source carries a control character", () => {
  // A raw NUL used as a string delimiter works at runtime and is invisible in
  // review, but it makes the file BINARY to ripgrep and every grep-based tool —
  // including the source pins in this very suite, which silently stop matching.
  // Caught once here already; this keeps it caught.
  for (const file of [
    PROBE,
    "cloud-tour-sequences.spec.mjs",
    "lib/cloud-tour-fixtures.mjs",
    "lib/cloud-tour-metrics.mjs",
  ]) {
    const bytes = fs.readFileSync(path.join(here, file));
    const offending = bytes.findIndex(
      (byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20),
    );
    assert.equal(
      offending,
      -1,
      `${file} carries a control byte at offset ${offending}`,
    );
  }
});

test("the probe embeds the canonical same-task capture block", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probeSource), []);
});

test("the probe never reads a canvas outside the canonical block", () => {
  assert.deepEqual(checkFusedCaptureUsage(probeSource), []);
});

test("the probe boots deterministically and offline", () => {
  const pins = [
    {
      pattern: /CesiumViewer\/index\.html\?renderer=webgpu&offline=true/,
      why: "external terrain/imagery requests make the scene depend on the network",
    },
    {
      pattern: /useDefaultRenderLoop\s*=\s*false/,
      why: "an app-driven render loop renders frames the probe did not author",
    },
    {
      pattern: /requestRenderMode\s*=\s*false/,
      why: "request-render mode can skip the frames the measurement counts on",
    },
    {
      pattern: /shouldAnimate\s*=\s*false/,
      why: "an animating clock is wall time reaching the renderer",
    },
  ];
  for (const pin of pins) {
    assert.match(probeSource, pin.pattern, pin.why);
    assertSourcePinIsWidthSafe({
      pattern: pin.pattern,
      sourceText: probeSource,
      label: pin.why,
    });
  }
});

test("the probe cannot substitute wall time for its authored instant", () => {
  // Matched against CODE, not prose: see `probeCode`.
  assert.doesNotMatch(
    probeCode,
    /JulianDate\.now\(/,
    "the probe must render its authored instant",
  );
  assert.doesNotMatch(
    probeCode,
    /Math\.random\(/,
    "a random draw is an unrecorded input",
  );
  assert.doesNotMatch(
    probeCode,
    /\bscene\.render\(\s*\)/,
    "an argument-less render silently substitutes the wall-clock instant",
  );
  // The single render call site lives inside the canonical block and renders
  // whatever the probe's own time function returns.
  assert.match(probeSource, /renderNow\s*=\s*\(\)\s*=>\s*scene\.render\(timeFn\(\)\)/);
});

test("the probe carries a watchdog sized from the declared frame budgets", () => {
  assert.match(probeSource, /HARD_LIMIT_MS/);
  assert.match(probeSource, /WATCHDOG\s+FIRED/);
  assert.match(probeSource, /process\.exit\(2\)/);
  assert.match(
    probeSource,
    /sequenceFrameBudget/,
    "the watchdog budget must be derived from the tables, not guessed",
  );
  assert.match(probeSource, /watchdog\.unref/);
});

test("the probe has no unbounded loop", () => {
  assert.doesNotMatch(probeCode, /while\s*\(\s*true\s*\)/);
  assert.doesNotMatch(probeCode, /for\s*\(\s*;\s*;\s*\)/);
});

test("the comment-stripping used by the forbidding pins actually works", () => {
  // Without this the pins above could silently pass because `probeCode` was
  // empty, or fail because a URL's `//` swallowed a line of real code.
  assert.equal(probeCode.length, probeSource.length, "line/char alignment lost");
  assert.match(probeCode, /const\s+OCCUPANCY_MAX_FRAMES\s*=/, "code was stripped");
  assert.ok(
    probeSource.includes("scene.render()"),
    "the probe should still DOCUMENT the argument-less-render trap",
  );
  assert.ok(!probeCode.includes("scene.render()"), "the comment survived stripping");
  // A protocol-relative-looking `http://` inside a template literal must not eat
  // the rest of its line.
  assert.match(probeCode, /renderer=webgpu&offline=true/);
});

test("the probe implements every action the sequence table can name", () => {
  for (const action of PHASE_ACTIONS) {
    // "hold" and "return" are handled by the shared setView branch; each action
    // must appear as a literal in the probe so a new table entry cannot ship
    // without a runtime branch.
    assert.ok(
      probeSource.includes(`"${action}"`),
      `probe does not implement phase action ${action}`,
    );
  }
  for (const action of new Set(
    CLOUD_TOUR_SEQUENCES.flatMap((sequence) =>
      sequence.phases.map((phase) => phase.action),
    ),
  )) {
    assert.ok(PHASE_ACTIONS.includes(action), `sequence uses unregistered action ${action}`);
  }
});

test("the probe consumes the shared tables instead of redefining them", () => {
  assert.match(probeSource, /from\s*"\.\/lib\/cloud-tour-fixtures\.mjs"/);
  assert.match(probeSource, /from\s*"\.\/lib\/cloud-tour-metrics\.mjs"/);
  assert.doesNotMatch(
    probeSource,
    /const\s+CLOUD_TOUR_FIXTURES\s*=/,
    "the probe must not carry its own copy of the fixture table",
  );
  // It must also refuse to run on a table that does not validate, so a typo
  // costs microseconds rather than an Edge cycle.
  assert.match(probeSource, /validateFixtureSet\(\)/);
  assert.match(probeSource, /validateSequenceSet\(\)/);
});

test("the probe arms and disarms the C13-39 timestamp profiler", () => {
  assert.match(probeSource, /gpuPassCost/);
  assert.match(probeSource, /timestampProfiler/);
  assert.match(probeSource, /onSubmittedWorkDone/);
  // The A/B bookkeeping the interleave assessment needs.
  assert.match(probeSource, /TOUR_ROUND/);
  assert.match(probeSource, /TOUR_ORDER/);
  assert.match(probeSource, /TOUR_PAIR_ID/);
});

test("the probe proves execution rather than trusting a loaded handle", () => {
  // C13-35: a fixed rAF warm-up count or a resolved feature-renderer handle is
  // not execution evidence.
  assert.match(probeSource, /awaitProceduralReady/);
  assert.match(probeSource, /occupancyMaxFrames/);
  assert.match(probeSource, /canvas-readback-all-zero/);
  assert.match(probeSource, /renderer-never-realized/);
});
