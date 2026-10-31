// probe-fft-ocean.spec.mjs - the FFT ocean probe on the shared runtime, in Node.
// @purpose Pins probe-fft-ocean.mjs without a browser: its sessions stage registered rigs whose dials the landing stage accepts (the FFT ocean on/off through waterOceanEnabled, the globe hidden through globeShow, a clock step for the wave-motion capture), the metrics and verdicts pass healthy captures and fail a frozen sea, an unapplied dial, a missing capture and an unarmed error gate refuse, and a failed served-build preflight refuses before any launch; with inertness mutants of the temporal floor and the unapplied-dial refusal.
// @status ACTIVE
//
// Lane A salvage (Andustar) of the water-w5 rework: the w5 spec's descriptor,
// healthy/regressed and preflight cases re-derived for the rig-staged probe.

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  exitCodeForOutcome,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";
import {
  FFT_OCEAN_BANDS,
  FFT_OCEAN_RIGS,
  FFT_OCEAN_SESSIONS,
  analyzeFftOceanCaptures,
  descriptor,
  fftOceanVerdicts,
  refuseUnappliedDials,
  summarizeFftOceanCells,
} from "./probe-fft-ocean.mjs";

const PROBE_FILE = fileURLToPath(
  new URL("./probe-fft-ocean.mjs", import.meta.url),
);

function makeSolidImage(width, height, r, g, b, a = 255) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width, height, channels: 4, data };
}

const HEALTHY = {
  "off1.png": makeSolidImage(16, 16, 40, 60, 90),
  "off1b.png": makeSolidImage(16, 16, 40, 60, 91),
  "off2.png": makeSolidImage(16, 16, 40, 60, 90),
  "iso-off.png": makeSolidImage(16, 16, 0, 0, 0),
  "iso-on.png": makeSolidImage(16, 16, 30, 80, 140),
  "iso-on-t2.png": makeSolidImage(16, 16, 45, 95, 160),
  "ctx-on.png": makeSolidImage(16, 16, 30, 80, 140),
};
const CROP = { x0: 2, y0: 2, x1: 14, y1: 14 };

function makeCells({ armedDevices = 1 } = {}) {
  return FFT_OCEAN_SESSIONS.map((session) => ({
    run: 0,
    id: session.id,
    rigs: [...session.rigs],
    capture: { path: `${session.id}.png` },
    temporalCapture: session.temporal ? { path: `${session.id}-t2.png` } : null,
    gate: {
      deviceLost: null,
      errorCount: 0,
      errors: [],
      armedDevices,
      pageErrors: [],
      pageErrorCount: 0,
    },
  }));
}

function healthyVerdicts(fftOceanVerdictsFn = fftOceanVerdicts, load) {
  const cells = makeCells();
  const summary = summarizeFftOceanCells(
    cells,
    load ?? ((file) => HEALTHY[file]),
    CROP,
  );
  return fftOceanVerdictsFn(cells, summary);
}

test("descriptor: shared-runtime contract and the six sessions in order", () => {
  assert.equal(descriptor.name, "fft-ocean");
  assert.equal(descriptor.outputSubdirectory, "fft-ocean");
  assert.equal(descriptor.receiptEnvelope, "runtime");
  assert.ok(
    descriptor.servedArtifacts.includes("Apps/CesiumViewer/index.html"),
  );
  assert.deepEqual(
    FFT_OCEAN_SESSIONS.map((session) => session.id),
    ["off1", "off1b", "off2", "iso-off", "iso-on", "ctx-on"],
  );
  assert.deepEqual(
    FFT_OCEAN_SESSIONS.find((session) => session.id === "off2").rigs,
    [FFT_OCEAN_RIGS.on, FFT_OCEAN_RIGS.off],
    "off2 is enabled-then-disabled",
  );
});

test("every session rig is registered, valid, WebGPU, and stages through the landing stage with the dials its role needs", async () => {
  const rigs = await loadRigs();
  const role = {
    [FFT_OCEAN_RIGS.off]: { ocean: false, globe: undefined },
    [FFT_OCEAN_RIGS.on]: { ocean: true, globe: undefined },
    [FFT_OCEAN_RIGS.isolatedOff]: { ocean: false, globe: false },
    [FFT_OCEAN_RIGS.isolatedOn]: { ocean: true, globe: false },
  };
  for (const [id, want] of Object.entries(role)) {
    const rig = rigById(rigs, id);
    assert.deepEqual(validateRig(rig), [], id);
    assert.deepEqual(rig.renderers, ["webgpu"], id);
    const payload = landingStagePayload(rig);
    assert.equal(payload.water.waterOceanEnabled, want.ocean, id);
    assert.equal(payload.globe.globeShow, want.globe, id);
    assert.equal(payload.water.waterSimulationEpoch, rig.clock, id);
  }
  const iso = rigById(rigs, FFT_OCEAN_RIGS.isolatedOn);
  const steps = iso.dials.clockSteps;
  assert.equal(steps.length, 1);
  const seconds = (Date.parse(steps[0]) - Date.parse(iso.clock)) / 1000;
  assert.ok(seconds > 0, "the clock step moves scene time forward");
  assert.ok(iso.dials.settleFramesPerStep > 0);
  assert.deepEqual(
    landingStagePayload(iso).stepDials.sort(),
    ["clockSteps", "settleFramesPerStep"],
    "the stage leaves the step dials to lib/clock-steps.mjs",
  );
});

test("metrics and verdicts pass healthy captures; a frozen sea fails temporal-animation (exit 1)", () => {
  const metrics = analyzeFftOceanCaptures(
    {
      off1: HEALTHY["off1.png"],
      off1b: HEALTHY["off1b.png"],
      off2: HEALTHY["off2.png"],
      isoOff: HEALTHY["iso-off.png"],
      isoOn: HEALTHY["iso-on.png"],
      isoOnT2: HEALTHY["iso-on-t2.png"],
    },
    CROP,
  );
  assert.equal(metrics.offGate, 0);
  assert.equal(metrics.isoCoverageOff, 0);
  assert.equal(metrics.isoCoverageOn, 1);
  assert.ok(metrics.isoTemporal > FFT_OCEAN_BANDS.minTemporalLumaDelta);

  const verdicts = healthyVerdicts();
  assert.equal(verdicts.length, 4);
  assert.ok(verdicts.every((verdict) => verdict.pass === true));
  assert.equal(exitCodeForOutcome({ verdicts }), PROBE_EXIT_CODES.OK);

  const frozen = healthyVerdicts(fftOceanVerdicts, (file) =>
    file === "iso-on-t2.png" ? HEALTHY["iso-on.png"] : HEALTHY[file],
  );
  assert.equal(
    frozen.find((verdict) => verdict.id === "temporal-animation").pass,
    false,
  );
  assert.equal(
    exitCodeForOutcome({ verdicts: frozen }),
    PROBE_EXIT_CODES.FAILURE,
  );

  const leftBehind = healthyVerdicts(fftOceanVerdicts, (file) =>
    file === "off2.png" ? makeSolidImage(16, 16, 90, 120, 160) : HEALTHY[file],
  );
  assert.equal(
    leftBehind.find((verdict) => verdict.id === "off-gate-parity").pass,
    false,
    "an OFF session that still shows the ocean fails the OFF gate",
  );
});

// An empty isolated patch: the globe-hidden ON capture equals the OFF one.
function assertEmptyPatchFailsCoverage(verdictsFn) {
  const verdicts = healthyVerdicts(verdictsFn, (file) =>
    file === "iso-on.png" ? HEALTHY["iso-off.png"] : HEALTHY[file],
  );
  assert.equal(
    verdicts.find((verdict) => verdict.id === "isolated-coverage").pass,
    false,
    "an ON capture that paints nothing fails isolated-coverage",
  );
  assert.equal(exitCodeForOutcome({ verdicts }), PROBE_EXIT_CODES.FAILURE);
}

test("an empty isolated patch (ON capture equals OFF) fails isolated-coverage (exit 1)", () => {
  assertEmptyPatchFailsCoverage(fftOceanVerdicts);
});

test("inertness mutant: the coverage floor made unreachable lets an empty patch pass, so the empty-patch check goes red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "pass: metrics.isoCoverageOn >= coverageFloor,",
      "pass: true || metrics.isoCoverageOn >= coverageFloor,",
    ],
  ]);
  assert.throws(
    () => assertEmptyPatchFailsCoverage(mutated.fftOceanVerdicts),
    (error) => error instanceof assert.AssertionError,
  );
});

test("a missing capture and an unarmed error gate refuse (ProbeRefusal), they are never a measured red", () => {
  const cells = makeCells();
  cells.find((cell) => cell.id === "iso-on").temporalCapture = null;
  assert.throws(
    () => summarizeFftOceanCells(cells, (file) => HEALTHY[file], CROP),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "fft-ocean-captures-missing" &&
      /isoOnT2/.test(error.message),
  );
  const unarmed = makeCells({ armedDevices: 0 });
  assert.throws(
    () =>
      fftOceanVerdicts(
        unarmed,
        summarizeFftOceanCells(unarmed, (file) => HEALTHY[file], CROP),
      ),
    (error) =>
      error instanceof ProbeRefusal && error.reason === "error-gate-unarmed",
  );
});

const ABSENT_OCEAN_STAGE = Object.freeze({
  notApplied: ["waterOceanEnabled"],
  dials: {
    waterOceanEnabled: {
      requested: true,
      observed: undefined,
      applied: false,
      reason: "enabled is not a property here",
    },
  },
});

function assertAbsentOceanRefuses(refuse) {
  assert.throws(
    () => refuse("iso-on", FFT_OCEAN_RIGS.isolatedOn, ABSENT_OCEAN_STAGE),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "rig-dial-not-applied" &&
      error.details.reasons.waterOceanEnabled ===
        "enabled is not a property here",
  );
}

test("a session whose stage did not apply the ocean dial refuses, naming the dial and its reason", () => {
  assertAbsentOceanRefuses(refuseUnappliedDials);
  assert.doesNotThrow(() =>
    refuseUnappliedDials("off1", FFT_OCEAN_RIGS.off, {
      notApplied: [],
      dials: {},
    }),
  );
});

test("runProbe refuses a failed served-build preflight without launching a browser", async () => {
  await withLaneTmp("fft-ocean-refusal-", async (tmpDir) => {
    let launched = false;
    const code = await runProbe(descriptor, {
      argv: ["--output", tmpDir],
      repositoryRoot: tmpDir,
      preflight: async () => ({
        ok: false,
        mismatches: [
          { artifact: "Apps/CesiumViewer/index.html", reason: "stubbed" },
        ],
      }),
      launch: async () => {
        launched = true;
        throw new Error("must not launch a browser on a failed preflight");
      },
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(launched, false);
  });
});

test("inertness mutant: the temporal floor made unreachable lets a frozen sea pass, so the frozen-sea check goes red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "pass: metrics.isoTemporal > bands.minTemporalLumaDelta,",
      "pass: true || metrics.isoTemporal > bands.minTemporalLumaDelta,",
    ],
  ]);
  const frozenCheck = (verdictsFn) => {
    const cells = makeCells();
    const summary = mutated.summarizeFftOceanCells(
      cells,
      (file) =>
        file === "iso-on-t2.png" ? HEALTHY["iso-on.png"] : HEALTHY[file],
      CROP,
    );
    assert.equal(
      verdictsFn(cells, summary).find((v) => v.id === "temporal-animation")
        .pass,
      false,
    );
  };
  frozenCheck(fftOceanVerdicts);
  assert.throws(
    () => frozenCheck(mutated.fftOceanVerdicts),
    (error) => error instanceof assert.AssertionError,
  );
});

test("inertness mutant: the unapplied-dial refusal made unreachable no longer refuses, so the refusal check goes red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "  if (notApplied.length > 0) {",
      "  if (false && notApplied.length > 0) {",
    ],
  ]);
  assert.throws(
    () => assertAbsentOceanRefuses(mutated.refuseUnappliedDials),
    (error) => error instanceof assert.AssertionError,
  );
});
