// probe-ssr-water.spec.mjs - the SSR water probe on the shared runtime, in Node.
// @purpose Pins probe-ssr-water.mjs without a browser: its four cells stage registered rigs that differ only in enableSSR and deferredLighting and carry a valid lake + wall polygon list, the diffs and verdicts pass an engaged reflection and fail a missing one or a deferred-lighting divergence, an unbuilt scene, a missing capture and an unarmed error gate refuse, and a failed served-build preflight refuses before any launch; with inertness mutants of the engagement floor and the unbuilt-scene refusal.
// @status ACTIVE
//
// Lane A salvage (Andustar) of the water-w5 rework: the w5 spec's descriptor,
// engagement and preflight cases re-derived for the rig-staged probe.

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import { polygonScenePayload } from "./lib/polygon-primitive-scene.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  exitCodeForOutcome,
  runProbe,
} from "./lib/probe-runtime.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";
import {
  SSR_WATER_CELLS,
  compareSsrImages,
  descriptor,
  readCenterPixel,
  refuseUnbuiltScene,
  ssrWaterVerdicts,
  summarizeSsrWaterCells,
} from "./probe-ssr-water.mjs";

const PROBE_FILE = fileURLToPath(
  new URL("./probe-ssr-water.mjs", import.meta.url),
);

function makeImage(width, height, paint) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, channels: 4, data };
}

const LAKE = makeImage(20, 20, () => [13, 26, 51]);
// SSR on: the bottom quarter of the frame shows the wall's orange reflection.
const REFLECTED = makeImage(20, 20, (x, y) =>
  y >= 15 ? [200, 140, 20] : [13, 26, 51],
);

function makeCells(images, { armedDevices = 1 } = {}) {
  return SSR_WATER_CELLS.map(({ label, rig }) => ({
    run: 0,
    label,
    rig,
    capture: images[label] ? { path: label } : null,
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

const HEALTHY = {
  "a-ssr-off-def-off": LAKE,
  "b-ssr-on-def-off": REFLECTED,
  "c-ssr-on-def-on": REFLECTED,
  "d-ssr-off-def-on": LAKE,
};

function verdictsFor(images, verdictsFn = ssrWaterVerdicts, summarize) {
  const cells = makeCells(images);
  const summary = (summarize ?? summarizeSsrWaterCells)(
    cells,
    (label) => images[label],
  );
  return verdictsFn(cells, summary);
}

test("descriptor: shared-runtime contract and the four cells in order", () => {
  assert.equal(descriptor.name, "ssr-water");
  assert.equal(descriptor.outputSubdirectory, "ssr-water");
  assert.equal(descriptor.receiptEnvelope, "runtime");
  assert.ok(
    descriptor.servedArtifacts.includes("Apps/CesiumViewer/index.html"),
  );
  assert.deepEqual(
    SSR_WATER_CELLS.map((cell) => cell.label),
    [
      "a-ssr-off-def-off",
      "b-ssr-on-def-off",
      "c-ssr-on-def-on",
      "d-ssr-off-def-on",
    ],
  );
});

test("the four cell rigs are registered and valid, differ only in enableSSR and deferredLighting, and carry the lake + wall polygons", async () => {
  const rigs = await loadRigs();
  const want = {
    "a-ssr-off-def-off": [false, false],
    "b-ssr-on-def-off": [true, false],
    "c-ssr-on-def-on": [true, true],
    "d-ssr-off-def-on": [false, true],
  };
  const strip = (rig) => {
    const { id: _id, description: _description, ...rest } = rig;
    const dials = { ...rest.dials };
    delete dials.enableSSR;
    delete dials.deferredLighting;
    return JSON.stringify({ ...rest, dials });
  };
  let shared = null;
  for (const { label, rig: id } of SSR_WATER_CELLS) {
    const rig = rigById(rigs, id);
    assert.deepEqual(validateRig(rig), [], id);
    const payload = landingStagePayload(rig);
    assert.deepEqual(
      [payload.scene.enableSSR, payload.scene.deferredLighting],
      want[label],
      id,
    );
    assert.equal(payload.scene.ssrReflectionStrength, 1, id);
    assert.equal(payload.globe.globeEnableLighting, true, id);
    const polygons = polygonScenePayload(rig).polygons;
    assert.deepEqual(
      polygons.map((polygon) => polygon.id),
      ["lake", "wall"],
      id,
    );
    assert.ok(
      polygons[1].extrudedHeight > polygons[1].height,
      "the wall stands",
    );
    shared ??= strip(rig);
    assert.equal(strip(rig), shared, `${id} differs only in the two dials`);
  }
});

test("an engaged reflection passes; no reflection, or a deferred-lighting divergence, fails (exit 1)", () => {
  const healthy = verdictsFor(HEALTHY);
  assert.equal(healthy.length, 3);
  assert.ok(healthy.every((verdict) => verdict.pass === true));
  assert.equal(exitCodeForOutcome({ verdicts: healthy }), PROBE_EXIT_CODES.OK);

  const dark = verdictsFor({
    ...HEALTHY,
    "b-ssr-on-def-off": LAKE,
    "c-ssr-on-def-on": LAKE,
  });
  assert.equal(dark.find((v) => v.id === "ssr-engagement").pass, false);
  assert.equal(
    exitCodeForOutcome({ verdicts: dark }),
    PROBE_EXIT_CODES.FAILURE,
  );

  const diverged = verdictsFor({ ...HEALTHY, "c-ssr-on-def-on": LAKE });
  assert.equal(
    diverged.find((v) => v.id === "deferred-lighting-gate-noop").pass,
    false,
  );

  const diff = compareSsrImages(LAKE, REFLECTED);
  assert.equal(diff.mismatchPct, 25);
  assert.deepEqual(readCenterPixel(LAKE), { r: 13, g: 26, b: 51, a: 255 });
});

// Main's per-pixel rule (probe-ssr-water.mjs at a46ed8feeb): d = |dR| + |dG| +
// |dB|, mismatched when d > 30. A single channel off by 11 is NOT a mismatch;
// a channel sum of 31 is.
function assertMainChannelSumRule(compare) {
  const base = makeImage(10, 10, () => [100, 100, 100]);
  const shifted = (dr, dg, db) =>
    makeImage(10, 10, () => [100 + dr, 100 + dg, 100 + db]);
  assert.equal(compare(base, shifted(11, 0, 0)).mismatchPct, 0);
  assert.equal(compare(base, shifted(10, 10, 10)).mismatchPct, 0);
  assert.equal(compare(base, shifted(10, 10, 11)).mismatchPct, 100);
  assert.equal(compare(base, shifted(20, 6, 6)).mismatchPct, 100);
  assert.equal(compare(base, shifted(10, 10, 11)).meanDelta, 31);
}

test("compareSsrImages keeps main's rule: a pixel is mismatched when |dR|+|dG|+|dB| > 30", () => {
  assertMainChannelSumRule(compareSsrImages);
});

test("inertness mutant: the channel-sum mismatch count made unreachable fails main's rule", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    ["    if (d > channelSum) {", "    if (false && d > channelSum) {"],
  ]);
  assert.throws(
    () => assertMainChannelSumRule(mutated.compareSsrImages),
    (error) => error instanceof assert.AssertionError,
  );
});

test("a missing capture and an unarmed error gate refuse (ProbeRefusal), they are never a measured red", () => {
  const missing = makeCells({ ...HEALTHY, "c-ssr-on-def-on": undefined });
  assert.throws(
    () => summarizeSsrWaterCells(missing, (label) => HEALTHY[label]),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "ssr-water-captures-missing" &&
      /c-ssr-on-def-on/.test(error.message),
  );
  const unarmed = makeCells(HEALTHY, { armedDevices: 0 });
  assert.throws(
    () =>
      ssrWaterVerdicts(
        unarmed,
        summarizeSsrWaterCells(unarmed, (label) => HEALTHY[label]),
      ),
    (error) =>
      error instanceof ProbeRefusal && error.reason === "error-gate-unarmed",
  );
});

const RIG = Object.freeze({
  id: "ssr-water-lake-wall-ssr-on-deferred-off",
  polygons: [{ id: "lake" }, { id: "wall" }],
});

function assertUnbuiltRefuses(refuse) {
  assert.throws(
    () =>
      refuse(
        "b-ssr-on-def-off",
        RIG,
        {
          notApplied: ["enableSSR"],
          dials: { enableSSR: { reason: "enableSSR is not a property here" } },
        },
        { added: ["lake", "wall"] },
      ),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "rig-scene-not-built" &&
      error.details.notApplied.includes("enableSSR"),
  );
  assert.throws(
    () =>
      refuse(
        "b-ssr-on-def-off",
        RIG,
        { notApplied: [], dials: {} },
        { added: ["lake"] },
      ),
    (error) =>
      error instanceof ProbeRefusal &&
      error.reason === "rig-scene-not-built" &&
      error.details.absent.includes("wall"),
  );
}

test("a cell whose dials or polygons were not built refuses, naming what is missing", () => {
  assertUnbuiltRefuses(refuseUnbuiltScene);
  assert.doesNotThrow(() =>
    refuseUnbuiltScene(
      "a",
      RIG,
      { notApplied: [], dials: {} },
      { added: ["lake", "wall"] },
    ),
  );
});

test("runProbe refuses a failed served-build preflight without launching a browser", async () => {
  await withLaneTmp("ssr-water-refusal-", async (tmpDir) => {
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

test("inertness mutant: the engagement floor made unreachable lets a missing reflection pass, so the no-reflection check goes red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "pass: ssrEngagement.mismatchPct >= bands.minEngagementDiffPct,",
      "pass: true || ssrEngagement.mismatchPct >= bands.minEngagementDiffPct,",
    ],
  ]);
  const darkCheck = (verdictsFn) => {
    const dark = verdictsFor(
      { ...HEALTHY, "b-ssr-on-def-off": LAKE, "c-ssr-on-def-on": LAKE },
      verdictsFn,
      mutated.summarizeSsrWaterCells,
    );
    assert.equal(dark.find((v) => v.id === "ssr-engagement").pass, false);
  };
  darkCheck(ssrWaterVerdicts);
  assert.throws(
    () => darkCheck(mutated.ssrWaterVerdicts),
    (error) => error instanceof assert.AssertionError,
  );
});

test("inertness mutant: the unbuilt-scene refusal made unreachable no longer refuses, so the refusal check goes red", async () => {
  const mutated = await importMutated(PROBE_FILE, [
    [
      "  if (notApplied.length > 0 || absent.length > 0) {",
      "  if (false && (notApplied.length > 0 || absent.length > 0)) {",
    ],
  ]);
  assert.throws(
    () => assertUnbuiltRefuses(mutated.refuseUnbuiltScene),
    (error) => error instanceof assert.AssertionError,
  );
});
