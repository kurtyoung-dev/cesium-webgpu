// landing-fog-dials.spec.mjs - the fog dial family of the landing stage and the landing row of the fog parity scene.
// @purpose Pins lib/landing-fog-dials.mjs and its routing in lib/landing-cell-stage.mjs: the rig cloud-shadows-parity-fog stages (enableVolumetric as the spelling of cloudsEnabled, the three fog dials routed to the globe's fog block before the cloud pattern), bad values and conflicting spellings are refused in Node, no other rig's payload gains a fog key, the page function writes each dial on the live fog block and reads it back (a missing block, a frozen block and a setter that does not stick are applied: false with a reason), the stage merges the rows into staged.dials and staged.notApplied so the probe turns an unapplied fog dial into NOT RUN, and the E-A8-fog table row rides the rig; each rule has an inertness mutant that turns its case red.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as fogDials from "./lib/landing-fog-dials.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
} from "./lib/landing-cell-table.mjs";
import * as stage from "./lib/landing-cell-stage.mjs";
import { loadRigs, rigById } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STAGE_FILE = path.join(here, "lib/landing-cell-stage.mjs");
const FOG_FILE = path.join(here, "lib/landing-fog-dials.mjs");
const ENGINE = path.join(here, "../../packages/engine/Source");

const rigs = await loadRigs();
const FOG_RIG = rigById(rigs, "cloud-shadows-parity-fog");

const FOG_DIALS = {
  volumetricFogEnabled: true,
  volumetricFogDensity: 0.0008,
  cloudShadowHiFi: false,
};

/** The rig with its dials replaced. */
const rigWith = (dials) => ({ ...FOG_RIG, dials });

// ---------------------------------------------------------------------------
// Case behaviours (each takes the stage module under test).
// ---------------------------------------------------------------------------

function behaviourParityRigStages(mod) {
  const payload = mod.landingStagePayload(FOG_RIG);
  assert.equal(payload.cloudsEnabled, false, "enableVolumetric: false");
  assert.deepEqual(payload.fog, FOG_DIALS);
  assert.deepEqual(
    payload.volumetric,
    { cloudCastShadows: false },
    "cloudShadowHiFi is a fog dial, not a CloudVolumetrics property",
  );
  assert.deepEqual(payload.globe, {
    globeShow: true,
    globeEnableLighting: true,
  });
  assert.equal(payload.needsCloudHarness, true);
  assert.equal(payload.camera.lon, -109.5);
}

function refusalOf(mod, dials) {
  try {
    mod.landingStagePayload(rigWith(dials));
  } catch (error) {
    return error;
  }
  return null;
}

function behaviourRefusals(mod) {
  for (const [name, dials, named] of [
    ["density a string", { volumetricFogDensity: "x" }, "volumetricFogDensity"],
    ["density negative", { volumetricFogDensity: -1 }, "volumetricFogDensity"],
    ["density NaN", { volumetricFogDensity: NaN }, "volumetricFogDensity"],
    [
      "fog enabled a number",
      { volumetricFogEnabled: 1 },
      "volumetricFogEnabled",
    ],
    ["hi-fi a string", { cloudShadowHiFi: "on" }, "cloudShadowHiFi"],
    [
      "enableVolumetric a string",
      { enableVolumetric: "no" },
      "enableVolumetric",
    ],
    [
      "enableVolumetric against cloudsEnabled",
      { enableVolumetric: false, cloudsEnabled: true },
      "conflicts with cloudsEnabled",
    ],
  ]) {
    const error = refusalOf(mod, dials);
    assert.ok(error, `${name} is refused`);
    assert.equal(error.name, "ProbeRefusal", name);
    assert.equal(error.reason, "rig-dial-unsupported", name);
    assert.ok(error.message.includes(named), `${name}: ${error.message}`);
  }
  // The same spellings, agreeing or valid, are accepted.
  assert.equal(
    mod.landingStagePayload(
      rigWith({ enableVolumetric: true, cloudsEnabled: true }),
    ).cloudsEnabled,
    true,
  );
  assert.equal(
    mod.landingStagePayload(rigWith({ volumetricFogDensity: 0 })).fog
      .volumetricFogDensity,
    0,
  );
}

function behaviourNoFogKeyElsewhere(mod) {
  let measured = 0;
  for (const rig of rigs) {
    const declared = Object.keys(rig.dials ?? {});
    if (
      declared.some(
        (key) =>
          key === "enableVolumetric" ||
          fogDials.LANDING_FOG_DIALS.includes(key),
      )
    ) {
      continue;
    }
    let payload;
    try {
      payload = mod.landingStagePayload(rig);
    } catch {
      continue;
    }
    measured++;
    assert.equal(Object.hasOwn(payload, "fog"), false, rig.id);
  }
  assert.ok(measured > 50, `${measured} rigs measured`);
}

/** The page world: viewer.scene.globe.atmosphericConditions.volumetricFog is `block`. */
function fogWorld(block, { noConditions = false } = {}) {
  const globe = noConditions
    ? {}
    : { atmosphericConditions: { volumetricFog: block } };
  const world = { viewer: { scene: { globe } } };
  world.globalThis = world;
  return vm.createContext(world);
}

async function applyIn(mod, world, fog) {
  const run = vm.runInContext(`(${String(mod.pageApplyFogDials)})`, world);
  return JSON.parse(JSON.stringify(await run(fog)));
}

async function behaviourPageApply(mod) {
  const block = { enabled: false, density: 1 };
  const rows = await applyIn(mod, fogWorld(block), FOG_DIALS);
  assert.deepEqual(rows, {
    volumetricFogEnabled: { requested: true, observed: true, applied: true },
    volumetricFogDensity: {
      requested: 0.0008,
      observed: 0.0008,
      applied: true,
    },
    cloudShadowHiFi: { requested: false, observed: false, applied: true },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(block)),
    { enabled: true, density: 0.0008, cloudShadowHiFi: false },
    "the live block holds the values",
  );

  const absent = await applyIn(
    mod,
    fogWorld(null, { noConditions: true }),
    FOG_DIALS,
  );
  for (const dial of Object.keys(FOG_DIALS)) {
    assert.equal(absent[dial].applied, false, dial);
    assert.match(
      absent[dial].reason,
      /^NOT AVAILABLE: viewer\.scene\.globe\.atmosphericConditions\.volumetricFog$/,
    );
  }

  const frozen = await applyIn(
    mod,
    fogWorld(Object.freeze({ enabled: false, density: 1 })),
    FOG_DIALS,
  );
  for (const dial of Object.keys(FOG_DIALS)) {
    assert.equal(frozen[dial].applied, false, `${dial} on a frozen block`);
    assert.ok(frozen[dial].reason, dial);
  }
  assert.equal(frozen.volumetricFogEnabled.observed, false);

  const ignoring = {
    enabled: false,
    get density() {
      return 1;
    },
    set density(_value) {},
  };
  const stuck = await applyIn(mod, fogWorld(ignoring), {
    volumetricFogDensity: 0.5,
  });
  assert.equal(
    stuck.volumetricFogDensity.applied,
    false,
    "the value did not stick",
  );
  assert.equal(stuck.volumetricFogDensity.observed, 1);

  const undeclared = await applyIn(mod, fogWorld({ density: 1 }), {
    volumetricFogEnabled: true,
  });
  assert.equal(undeclared.volumetricFogEnabled.applied, false);
  assert.match(undeclared.volumetricFogEnabled.reason, /not a property/);
}

/** A recording page: the stage's page functions by name, the fog rows as `fogRows`. */
function recordingPage(calls, { fogRows, stagedNotApplied = [] } = {}) {
  return {
    evaluate: async (fn, arg) => {
      calls.push(fn.name);
      if (fn.name === "stageLandingCellInPage") {
        return {
          dials: {
            cloudsEnabled: { requested: false, observed: false, applied: true },
          },
          notApplied: [...stagedNotApplied],
        };
      }
      if (fn.name === "pageApplyFogDials") {
        return (
          fogRows ??
          Object.fromEntries(
            Object.entries(arg).map(([dial, requested]) => [
              dial,
              { requested, observed: requested, applied: true },
            ]),
          )
        );
      }
      throw new Error(`unexpected stage call ${fn.name}`);
    },
  };
}

async function behaviourStageMerge(mod) {
  const { blockingDials } = await import("./probe-landing-cells.mjs");
  const calls = [];
  const ok = await mod.stageLandingCell({
    page: recordingPage(calls),
    rig: FOG_RIG,
  });
  assert.deepEqual(calls, ["stageLandingCellInPage", "pageApplyFogDials"]);
  assert.deepEqual(ok.staged.dials.volumetricFogDensity, {
    requested: 0.0008,
    observed: 0.0008,
    applied: true,
  });
  assert.ok(ok.staged.dials.cloudsEnabled, "the stage's own rows are kept");
  assert.deepEqual(ok.staged.notApplied, []);
  assert.deepEqual(blockingDials(ok.staged), []);

  const bad = await mod.stageLandingCell({
    page: recordingPage([], {
      stagedNotApplied: ["globeShow"],
      fogRows: {
        volumetricFogEnabled: {
          requested: true,
          observed: true,
          applied: true,
        },
        volumetricFogDensity: {
          requested: 0.0008,
          observed: 1,
          applied: false,
          reason: "x",
        },
        cloudShadowHiFi: { requested: false, observed: false, applied: true },
      },
    }),
    rig: FOG_RIG,
  });
  assert.deepEqual(bad.staged.notApplied, [
    "globeShow",
    "volumetricFogDensity",
  ]);
  assert.deepEqual(blockingDials(bad.staged), [
    "globeShow",
    "volumetricFogDensity",
  ]);

  // A rig with no fog dial never asks the page for them.
  const callsPlain = [];
  await mod.stageLandingCell({
    page: recordingPage(callsPlain),
    rig: { id: "plain", camera: null, clock: null, dials: {} },
  });
  assert.deepEqual(callsPlain, ["stageLandingCellInPage"]);
}

// ---------------------------------------------------------------------------
// Cases on the real modules.
// ---------------------------------------------------------------------------

test("6b-1: the rig cloud-shadows-parity-fog stages: clouds off, the three fog dials routed, the cloud shadow cast dial kept", () => {
  behaviourParityRigStages(stage);
});

test("6b-2: a bad fog value, a bad enableVolumetric and a conflicting spelling are refused in Node, naming the dial", () => {
  behaviourRefusals(stage);
});

test("6b-3: no other rig's payload gains a fog key", () => {
  behaviourNoFogKeyElsewhere(stage);
});

test("6b-4: the page function writes each dial on the live fog block and reads it back, with a reason for every dial that did not apply", async () => {
  await behaviourPageApply(fogDials);
});

test("6b-5: the stage merges the fog rows into staged.dials and staged.notApplied, and the probe's blocking list names an unapplied one", async () => {
  await behaviourStageMerge(stage);
});

test("6b-6: the properties the dials write are the engine's: the fog block getter, its declared fields and the renderer's high-fidelity switch", () => {
  const atmospheric = fs.readFileSync(
    path.join(ENGINE, "Scene/AtmosphericConditions.js"),
    "utf8",
  );
  const globeSource = fs.readFileSync(
    path.join(ENGINE, "Scene/Globe.js"),
    "utf8",
  );
  const renderer = fs.readFileSync(
    path.join(ENGINE, "Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts"),
    "utf8",
  );
  assert.match(atmospheric, /get volumetricFog\(\)/);
  const block = atmospheric.slice(
    atmospheric.indexOf("function buildVolumetricFog()"),
  );
  assert.match(block, /\n {4}enabled: false,/);
  assert.match(block, /\n {4}density: 1\.0,/);
  assert.match(renderer, /vf\?\.cloudShadowHiFi === true/);
  assert.match(renderer, /ac\.volumetricFog/);
  assert.match(globeSource, /get atmosphericConditions\(\)/);
  assert.deepEqual(fogDials.LANDING_FOG_PROPERTIES, {
    volumetricFogEnabled: "enabled",
    volumetricFogDensity: "density",
    cloudShadowHiFi: "cloudShadowHiFi",
  });
  // The page function's own copy of the map is the exported one.
  const pageSource = String(fogDials.pageApplyFogDials);
  for (const [dial, property] of Object.entries(
    fogDials.LANDING_FOG_PROPERTIES,
  )) {
    assert.ok(
      pageSource.includes(`${dial}: "${property}"`),
      `the page function maps ${dial} to ${property}`,
    );
  }
});

test("6b-7: the E-A8-fog row rides the rig, is a capture cell outside the default set, and plans one WebGPU page", () => {
  const cell = LANDING_CELLS["E-A8-fog"];
  assert.equal(cell.rig, "cloud-shadows-parity-fog");
  assert.equal(cell.kind, "capture");
  assert.equal(DEFAULT_CELLS.includes("E-A8-fog"), false);
  const plan = planLandingCells(
    { cells: "E-A8-fog" },
    new Map(rigs.map((r) => [r.id, r])),
  );
  assert.deepEqual(
    plan.map((e) => [e.renderer, e.page]),
    [["webgpu", "scene"]],
  );
  behaviourParityRigStages(stage);
});

// ---------------------------------------------------------------------------
// Inertness mutants.
// ---------------------------------------------------------------------------

/**
 * The mutant must fail the case: with an assertion, or, where the rule it
 * removes is what lets the rig stage at all, with the stage's own refusal of
 * the dial that rule routes (`refusing`).
 */
async function mutantFails(file, pairs, behaviour, refusing = null) {
  const mutated = await importMutated(file, pairs);
  let failure = null;
  try {
    await behaviour(mutated);
  } catch (error) {
    failure = error;
  }
  assert.ok(
    failure instanceof assert.AssertionError ||
      (refusing !== null &&
        failure?.name === "ProbeRefusal" &&
        failure.reason === "rig-dial-unsupported" &&
        failure.message.includes(refusing)),
    `the mutant must fail ${behaviour.name}, got ${failure}`,
  );
  if (process.env.MUTANT_REPORT === "1") {
    console.log(
      `MUTANT-FAILED-ON ${behaviour.name}: ${String(failure.message).split(/\r?\n/)[0]}`,
    );
  }
}

test("M6b-1: cloudShadowHiFi routed to the cloud dials again (the fog check unreachable) turns the parity-rig case red", async () => {
  await mutantFails(
    STAGE_FILE,
    [
      [
        "} else if (LANDING_FOG_DIALS.includes(key)) {",
        "} else if (false && LANDING_FOG_DIALS.includes(key)) {",
      ],
    ],
    (mod) => behaviourParityRigStages(mod),
    "volumetricFogEnabled",
  );
});

test("M6b-2: the enableVolumetric alias unreachable turns the parity-rig case red", async () => {
  await mutantFails(
    STAGE_FILE,
    [
      [
        '} else if (key === "enableVolumetric") {',
        '} else if (false && key === "enableVolumetric") {',
      ],
    ],
    (mod) => behaviourParityRigStages(mod),
    "enableVolumetric",
  );
});

test("M6b-3: the read-back comparison unreachable (applied always true) turns the page case red", async () => {
  await mutantFails(
    FOG_FILE,
    [
      [
        "const applied = Object.is(observed, requested);",
        "const applied = true || Object.is(observed, requested);",
      ],
    ],
    behaviourPageApply,
  );
});

test("M6b-4: the merge into notApplied unreachable turns the stage case red", async () => {
  await mutantFails(
    STAGE_FILE,
    [
      [
        "if (row.applied !== true && !notApplied.includes(dial)) {",
        "if (false && row.applied !== true && !notApplied.includes(dial)) {",
      ],
    ],
    behaviourStageMerge,
  );
});

test("M6b-5: a fog key always present in the payload turns the other-rigs case red", async () => {
  await mutantFails(
    STAGE_FILE,
    [["...(Object.keys(fog).length === 0 ? {} : { fog }),", "fog,"]],
    behaviourNoFogKeyElsewhere,
  );
});
