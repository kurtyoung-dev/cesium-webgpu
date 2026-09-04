// probe-oit-reachability-runtime-migration.spec.mjs — DX-06 batch 1 (Folcred):
// proves the C11-157 OIT-reachability trio's migration onto
// `lib/probe-runtime.mjs` kept every receipt field a downstream reader
// expects, and that the DX-02 anti-re-accretion contract still bites on a
// mutated copy of one of these three files specifically (not only the pilot).
//
// @purpose Fixture-receipt and mutation-control spec for the C11-157 OIT-reachability probe trio's DX-06 migration onto lib/probe-runtime.mjs.
// @status ACTIVE
//
// WHY A FIXTURE, NOT A CAPTURED "BEFORE" JSON. None of the three probes
// (`probe-oit-primitive-reachable.mjs`, `-collection-reachable`, `-model-
// reachable`) had a spec before this migration, so there is no pre-existing
// "after a real run" receipt to diff against. What is provable without a
// browser is field-SHAPE compatibility: the pre-migration `runScene()` in
// each file returned an object literal with a fixed, named field set (read
// from the pre-migration source, reproduced in `EXPECTED_SCENE_FIELDS_*`
// below), and the post-migration `descriptor.receipt()` must still assemble
// `{ base, scenes: { <sceneKind>: <that same field set> } }` from whatever
// cells `descriptor.cells()` hands it. Driving `receipt()`/`verdicts()`
// directly with a synthetic cell is exactly the "fixture receipt captured
// from the probe's pure functions" the migration brief asks for — cheaper
// and more precise than diffing a real capture, and it does not need Edge.
//
// THE ONE FIELD DIFFERENCE, NAMED. The model probe's pre-migration
// `runScene()` never included `noiseFloor_maxDelta` in its returned object
// (primitive and collection both do) — confirmed by reading the pre-migration
// source, not assumed. `EXPECTED_SCENE_FIELDS_MODEL` omits it too, so this
// spec pins the asymmetry as it was, rather than "fixing" it into false
// parity across the three files.
//
// THE VALUE THAT LEGITIMATELY DIFFERS. `receipt().base` is `context.origin`,
// which the runtime resolves from `--port` (default 8094) instead of the old
// `PROBE_BASE` env var (default `http://localhost:8080`, now refused by the
// runtime — `lib/probe-runtime.mjs`'s own `parseProbeArgs` header explains
// why). The FIELD is unchanged (`base` still names the served origin); only
// the default VALUE moved, and only because port 8080 measures the wrong
// bundle. This is the same, already-precedented shift `probe-globe-cold-
// start-readiness.mjs` (DX-01's pilot) made.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { descriptor as collectionDescriptor } from "./probe-oit-collection-reachable.mjs";
import { descriptor as modelDescriptor } from "./probe-oit-model-reachable.mjs";
import { descriptor as primitiveDescriptor } from "./probe-oit-primitive-reachable.mjs";
import { analyzeRuntimeResidency } from "./lib/runtime-residency-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} sceneKind Scene identifier.
 * @param {object} [overrides] Fields to override on the fixture.
 * @returns {object} A synthetic `runScene()`-shaped cell (primitive/collection shape).
 */
function fixtureCellAB(sceneKind, overrides = {}) {
  return {
    sceneKind,
    setup: { renderer: "webgpu", msaa: 1, hasAlternateRenderer: true },
    status: {
      toggled: true,
      live: true,
      sawOITActiveAnyFrame: true,
      activeThisFrame: true,
    },
    errors: 0,
    gateErrorsSample: [],
    consoleFaults: [],
    offNonBlack: 12.3,
    onNonBlack: 45.6,
    offMean: { r: 1, g: 2, b: 3 },
    onMean: { r: 4, g: 5, b: 6 },
    onVsOff_diffPct: 1.5,
    onVsOff_maxDelta: 30,
    noiseFloor_mismatchPx: 0,
    noiseFloor_maxDelta: 0,
    restoreVsOff_mismatchPx: 0,
    restoreVsOff_maxDelta: 0,
    pass: true,
    ...overrides,
  };
}

/**
 * @param {string} sceneKind Scene identifier.
 * @param {object} [overrides] Fields to override on the fixture.
 * @returns {object} A synthetic `runScene()`-shaped cell (model shape — no `noiseFloor_maxDelta`).
 */
function fixtureCellModel(sceneKind, overrides = {}) {
  const cell = fixtureCellAB(sceneKind, overrides);
  delete cell.noiseFloor_maxDelta;
  return cell;
}

const EXPECTED_SCENE_FIELDS_AB = [
  "sceneKind",
  "setup",
  "status",
  "errors",
  "gateErrorsSample",
  "consoleFaults",
  "offNonBlack",
  "onNonBlack",
  "offMean",
  "onMean",
  "onVsOff_diffPct",
  "onVsOff_maxDelta",
  "noiseFloor_mismatchPx",
  "noiseFloor_maxDelta",
  "restoreVsOff_mismatchPx",
  "restoreVsOff_maxDelta",
  "pass",
].sort();

const EXPECTED_SCENE_FIELDS_MODEL = EXPECTED_SCENE_FIELDS_AB.filter(
  (f) => f !== "noiseFloor_maxDelta",
).sort();

const CASES = [
  {
    label: "primitive (Slice A)",
    descriptor: primitiveDescriptor,
    kinds: ["lit", "flat"],
    fixture: fixtureCellAB,
    expectedFields: EXPECTED_SCENE_FIELDS_AB,
  },
  {
    label: "collection (Slice B)",
    descriptor: collectionDescriptor,
    kinds: ["point", "polyline", "billboard"],
    fixture: fixtureCellAB,
    expectedFields: EXPECTED_SCENE_FIELDS_AB,
  },
  {
    label: "model (Slice C)",
    descriptor: modelDescriptor,
    kinds: ["twin", "blend"],
    fixture: fixtureCellModel,
    expectedFields: EXPECTED_SCENE_FIELDS_MODEL,
  },
];

for (const { label, descriptor, kinds, fixture, expectedFields } of CASES) {
  test(`${label}: descriptor.name/outputSubdirectory keep the pre-migration artifact paths`, () => {
    // outputSubdirectory:"" is what keeps output landing directly in
    // Tools/visual-regression/output/ instead of a new output/<name>/
    // subfolder — a silent path change would strand every existing consumer
    // (or archived screenshot) that reads oit{prim,coll,model}-*.png at the
    // old location.
    assert.equal(descriptor.outputSubdirectory, "");
    assert.equal(descriptor.receiptEnvelope, "probe-owned");
  });

  test(`${label}: receipt() reproduces the pre-migration {base, scenes} shape with every field name intact`, () => {
    const cells = kinds.map((kind, i) => fixture(kind, { pass: i % 2 === 0 }));
    const receipt = descriptor.receipt(cells, {
      origin: "http://localhost:8094",
    });
    assert.deepEqual(Object.keys(receipt).sort(), ["base", "scenes"]);
    assert.equal(receipt.base, "http://localhost:8094");
    assert.deepEqual(Object.keys(receipt.scenes).sort(), [...kinds].sort());
    for (const kind of kinds) {
      const scene = receipt.scenes[kind];
      assert.deepEqual(
        Object.keys(scene).sort(),
        expectedFields,
        `${label}/${kind}: field set drifted from the pre-migration shape`,
      );
      // Identity, not just shape: the exact cell object flows through
      // unchanged (receipt() is a pure re-keying by sceneKind).
      assert.equal(scene, cells[kinds.indexOf(kind)]);
    }
  });

  test(`${label}: verdicts() emits one verdict per cell carrying the cell's own pass`, () => {
    const cells = kinds.map((kind, i) => fixture(kind, { pass: i === 0 }));
    const verdicts = descriptor.verdicts(cells);
    assert.equal(verdicts.length, kinds.length);
    verdicts.forEach((v, i) => {
      assert.equal(v.id, kinds[i]);
      assert.equal(v.pass, cells[i].pass);
      assert.equal(typeof v.claim, "string");
    });
  });

  test(`${label}: summary() counts passes over the reconstructed receipt without throwing`, () => {
    const cells = kinds.map((kind, i) => fixture(kind, { pass: i === 0 }));
    const receipt = descriptor.receipt(cells, {
      origin: "http://localhost:8094",
    });
    const markdown = descriptor.summary(receipt);
    assert.match(markdown, /Scenes: 1\//);
  });
}

// ---------------------------------------------------------------------------
// Inertness mutant — DX-02 must still catch a hand-rolled preflight
// re-added to one of THESE THREE files, not only the pilot.
// ---------------------------------------------------------------------------

test("INERTNESS MUTANT: re-adding a hand-rolled createHash preflight to probe-oit-primitive-reachable.mjs is caught by the DX-02 contract, and clears when removed", () => {
  const path = join(HERE, "probe-oit-primitive-reachable.mjs");
  const base = readFileSync(path, "utf8");

  const clean = analyzeRuntimeResidency(base);
  assert.equal(clean.resident, true);
  assert.deepEqual(clean.violations, []);

  const anchor = "const VIEWPORT = { width: 800, height: 600 };";
  assert.ok(base.includes(anchor), "anchor line moved in the migrated probe");
  const insertion = 'import { createHash } from "node:crypto";\n';
  const mutated = base.replace(anchor, insertion + anchor);
  assert.notEqual(mutated, base, "mutation did not apply");

  const mutatedAnalysis = analyzeRuntimeResidency(mutated);
  assert.ok(
    mutatedAnalysis.violations.some((v) => v.id === "own-hash-or-preflight"),
    `re-added createHash import was not caught (got ${JSON.stringify(mutatedAnalysis.violations)})`,
  );

  // Round trip: removing exactly the inserted line restores byte-identical
  // source and a clean analysis — the detector reacts to the SHAPE, not to
  // some incidental side effect of editing the file.
  const restored = mutated.replace(insertion, "");
  assert.equal(restored, base);
  assert.deepEqual(analyzeRuntimeResidency(restored).violations, []);
});
