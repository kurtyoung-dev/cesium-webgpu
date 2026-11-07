// landing-kit11-cells.spec.mjs - the cloud-shadow layout cell, the 2D and morphing cloud cells and the sky-cubemap cell.
//
// @purpose Node spec for the landing cells E-BGL-shadow, E-CLOUD-2d, E-CLOUD-morph and E-SKY-cube: the shadow rig is cloud-underside-noon-cov055 plus exactly cloudCastShadows and its cell carries the layout census; the 2D rig is default-2d-pinned plus the cloud collection and the morph rig holds the scene in MORPHING through the morphHold step dial, both with no cloud dial; each rig stages through the real payload builder with its step dial passed over; the cells plan as one WebGPU page, off by default; a fake-browser run of the real probe carries the shadow layout row, the morph-hold record (held only when the page read MORPHING twice, NOT AVAILABLE when the page answers nothing) and the sky-cube record (faces written to files, bytes out of the report); the morph page function runs against a fake scene that leaves MORPHING when the spec says so; with inertness mutants for the probe's two dispatches and capture condition and for the held rule.
// @status ACTIVE
//
// The fake page never answers the quantity under test: the default fake
// browser answers NOT AVAILABLE for the morph and sky-cube page functions, and
// every value a case reads is one the case handed to the fake.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  LANDING_STEP_DIALS,
  landingStagePayload,
} from "./lib/landing-cell-stage.mjs";
import {
  CLOUD_LAYOUT_LABELS,
  DEFAULT_CELLS,
  LANDING_CELLS,
  planLandingCells,
} from "./lib/landing-cell-table.mjs";
import * as morph from "./lib/morph-steps.mjs";
import { loadRigs, rigById, validateRig } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_MODULE = path.join(here, "probe-landing-cells.mjs");
const MORPH_MODULE = path.join(here, "lib", "morph-steps.mjs");

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("landing-kit11-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

const rigs = await loadRigs();
const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
const get = (id) => rigById(rigs, id);

const IDENTITY = ["declaredBy", "description", "id"];

/** The keys whose values differ between two records, identity text aside. */
function differingKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !IDENTITY.includes(key))
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

// ---------------------------------------------------------------------------
// The rigs
// ---------------------------------------------------------------------------

test("the four rigs validate and are WebGPU-only", () => {
  for (const id of [
    "cloud-shadow-noon-cov055",
    "cloud-2d-default",
    "cloud-morph-default",
    "sky-cubemap-model",
  ]) {
    const rig = get(id);
    assert.deepEqual(validateRig(rig), [], `${id} validates`);
    assert.deepEqual(rig.renderers, ["webgpu"], `${id} renderers`);
  }
  assert.deepEqual(get("sky-cubemap-model").tags, ["skybox"]);
});

test("cloud-shadow-noon-cov055 is cloud-underside-noon-cov055 plus exactly cloudCastShadows", () => {
  const twin = get("cloud-underside-noon-cov055");
  const rig = get("cloud-shadow-noon-cov055");
  assert.deepEqual(differingKeys(rig, twin), ["dials"]);
  assert.deepEqual(rig.dials, { ...twin.dials, cloudCastShadows: true });
  const a = landingStagePayload(rig);
  const b = landingStagePayload(twin);
  assert.deepEqual(a.volumetric, {
    ...b.volumetric,
    cloudCastShadows: true,
  });
  assert.deepEqual(
    { ...a, volumetric: null, rigId: null },
    {
      ...b,
      volumetric: null,
      rigId: null,
    },
  );
});

test("cloud-2d-default is default-2d-pinned plus the cloud collection, with no cloud dial", () => {
  const twin = get("default-2d-pinned");
  const rig = get("cloud-2d-default");
  assert.deepEqual(differingKeys(rig, twin), ["dials", "renderers", "tags"]);
  assert.deepEqual(rig.dials, { ...twin.dials, cloudsEnabled: true });
  assert.deepEqual(
    Object.keys(rig.dials).filter((key) => /^cloud[A-Z]/.test(key)),
    [],
    "no cloud* dial: the engine's own quality",
  );
  const payload = landingStagePayload(rig);
  assert.equal(payload.scene.sceneMode, "SCENE2D");
  assert.equal(payload.cloudsEnabled, true);
  assert.deepEqual(payload.volumetric, {});
  assert.equal(payload.camera.height, 40500000);
});

test("cloud-morph-default holds the morph through a step dial the stage passes over; the stage sets no scene mode", () => {
  const rig = get("cloud-morph-default");
  assert.ok(LANDING_STEP_DIALS.includes("morphHold"));
  const payload = landingStagePayload(rig);
  assert.deepEqual(payload.stepDials, ["morphHold"]);
  assert.equal(payload.scene.sceneMode, undefined);
  assert.deepEqual(payload.volumetric, {});
  assert.equal(payload.cloudsEnabled, true);
  assert.equal(morph.morphHoldViolation(rig.dials.morphHold), null);
  assert.ok(rig.dials.morphHold.seconds >= 600);
});

test("sky-cubemap-model stages through the payload builder with the model as a step dial", () => {
  const rig = get("sky-cubemap-model");
  assert.ok(LANDING_STEP_DIALS.includes("skyCubeModel"));
  const payload = landingStagePayload(rig);
  assert.deepEqual(payload.stepDials, ["skyCubeModel"]);
  assert.equal(payload.cloudsEnabled, false);
  assert.equal(payload.globe.terrain, "ellipsoid");
  assert.match(rig.dials.skyCubeModel.url, /^\/Apps\/SampleData\//);
});

// ---------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------

test("the four cells ride their rigs, are off by default and plan one WebGPU page each", () => {
  const expected = {
    "E-BGL-shadow": ["cloud-shadow-noon-cov055", "capture"],
    "E-CLOUD-2d": ["cloud-2d-default", "capture"],
    "E-CLOUD-morph": ["cloud-morph-default", "morph-hold"],
    "E-SKY-cube": ["sky-cubemap-model", "sky-cube"],
  };
  for (const [cell, [rig, kind]] of Object.entries(expected)) {
    assert.deepEqual(
      [LANDING_CELLS[cell].rig, LANDING_CELLS[cell].kind],
      [rig, kind],
    );
    assert.ok(!DEFAULT_CELLS.includes(cell));
    assert.deepEqual(
      planLandingCells({ cells: cell }, rigsById).map((e) => [
        e.cell,
        e.renderer,
        e.page,
      ]),
      [[cell, "webgpu", "scene"]],
    );
  }
  assert.equal(LANDING_CELLS["E-BGL-shadow"].layoutCensus, CLOUD_LAYOUT_LABELS);
  assert.equal(LANDING_CELLS["E-CLOUD-2d"].layoutCensus, undefined);
});

// ---------------------------------------------------------------------------
// Fake-browser runs of the real probe
// ---------------------------------------------------------------------------

const SHADOW_COUNTS = {
  vertex: {},
  fragment: {
    sampledTextures: 6,
    uniformBuffers: 5,
    storageBuffers: 1,
    samplers: 2,
    storageTextures: 0,
    externalTextures: 0,
  },
  compute: {},
};
const CENSUS = (withShadow) => ({
  installed: true,
  layouts: {
    "ProceduralClouds BGL": {
      created: 1,
      variants: 1,
      entries: 11,
      counts: {
        vertex: {},
        fragment: {
          sampledTextures: 12,
          uniformBuffers: 5,
          storageBuffers: 2,
          samplers: 4,
          storageTextures: 0,
          externalTextures: 0,
        },
        compute: {},
      },
    },
    ...(withShadow
      ? {
          "CloudShadow BGL": {
            created: 1,
            variants: 1,
            entries: 16,
            counts: SHADOW_COUNTS,
          },
        }
      : {}),
  },
  groups: {
    "ProceduralClouds BGL": { 0: 1 },
    ...(withShadow ? { "CloudShadow BGL": { 0: 1 } } : {}),
  },
  unlabelled: 0,
  device: { found: true, limits: {} },
});

test("E-BGL-shadow: the census row of the shadow layout rides the page record with its per-stage counts, and is absent when the page did not create it", async () => {
  const on = await p14Run("shadow-on", ["--cells", "E-BGL-shadow"], {
    layoutCensus: CENSUS(true),
    // The shadow owners the cell names, as the census shows them on a page
    // that casts shadows (the owners-seen verdict reads them).
    censusByLabel: SHADOW_ROWS(LANDING_CELLS["E-BGL-shadow"].ownerLabels),
  });
  assert.equal(on.code, 0);
  const rows = on.report.pages[0].layoutCensus.rows;
  const shadow = rows.find((row) => row.label === "CloudShadow BGL");
  assert.equal(shadow.seen, true);
  assert.deepEqual(shadow.counts.fragment, SHADOW_COUNTS.fragment);
  const off = await p14Run("shadow-off", ["--cells", "E-BGL-shadow"], {
    layoutCensus: CENSUS(false),
  });
  assert.equal(
    off.report.pages[0].layoutCensus.rows.find(
      (row) => row.label === "CloudShadow BGL",
    ).seen,
    false,
  );
});

const RAW_MORPH = (afterMode) => ({
  available: true,
  to: "SCENE2D",
  seconds: 3600,
  frames: 30,
  before: { mode: "SCENE3D", morphTime: 1 },
  started: { mode: "MORPHING", morphTime: 1 },
  after: { mode: afterMode, morphTime: 0.9996 },
});

test("E-CLOUD-morph: the morph-hold record rides the page, held only when the page read MORPHING twice; a silent page is NOT AVAILABLE", async () => {
  const held = await p14Run("morph-held", ["--cells", "E-CLOUD-morph"], {
    morphAnswer: RAW_MORPH("MORPHING"),
  });
  assert.equal(held.code, 0);
  const page = held.report.pages[0];
  assert.equal(page.kind, "morph-hold");
  assert.equal(page.morph.held, true);
  assert.equal(page.morph.modeStarted, "MORPHING");
  assert.ok(page.capture, "the morphing frame is captured");
  const done = await p14Run("morph-done", ["--cells", "E-CLOUD-morph"], {
    morphAnswer: RAW_MORPH("SCENE2D"),
  });
  assert.equal(done.report.pages[0].morph.held, false);
  const silent = await p14Run("morph-silent", ["--cells", "E-CLOUD-morph"]);
  const none = silent.report.pages[0].morph;
  assert.equal(none.available, false);
  assert.match(none.reason, /NOT AVAILABLE/);
  assert.equal(none.held, undefined, "no mode is invented");
});

const faceBytes = (face) => Buffer.alloc(64, face + 1);
const RAW_CUBE = {
  available: true,
  format: "rgba8unorm",
  size: 4,
  mipLevels: 3,
  frames: 5,
  faces: Array.from({ length: 6 }, (_, face) => ({
    face,
    bytes: faceBytes(face).toString("base64"),
  })),
};

test("E-SKY-cube: the faces are read, written to files and recorded by sha256; the report holds no bytes; a silent page is NOT AVAILABLE", async () => {
  const read = await p14Run("sky-read", ["--cells", "E-SKY-cube"], {
    skyCubeAnswers: {
      add: { added: true, ready: true, frames: 3 },
      read: RAW_CUBE,
    },
  });
  assert.equal(read.code, 0);
  const cube = read.report.pages[0].skyCube;
  assert.equal(cube.available, true);
  assert.equal(cube.faces.length, 6);
  assert.deepEqual(cube.model, {
    url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
    ready: true,
    frames: 3,
  });
  for (const face of cube.faces) {
    assert.equal(face.byteLength, 64);
    assert.ok(fs.existsSync(face.path), "the face file exists");
    assert.deepEqual(fs.readFileSync(face.path), faceBytes(face.face));
  }
  assert.ok(
    !JSON.stringify(read.report).includes(RAW_CUBE.faces[0].bytes),
    "no face bytes in the report",
  );
  const silent = await p14Run("sky-silent", ["--cells", "E-SKY-cube"]);
  const none = silent.report.pages[0].skyCube;
  assert.equal(none.available, false);
  assert.match(none.reason, /NOT AVAILABLE/);
  assert.equal(none.faces, undefined, "no face is invented");
  const noCube = await p14Run("sky-nocube", ["--cells", "E-SKY-cube"], {
    skyCubeAnswers: { add: { added: true, ready: true, frames: 1 } },
  });
  assert.match(
    noCube.report.pages[0].skyCube.reason,
    /manager\._webgpuCache\.cubemapTexture/,
  );
});

test("a capture cell carries neither a morph nor a sky-cube record", async () => {
  const run = await p14Run("plain", ["--cells", "E-CLOUD-2d"]);
  const page = run.report.pages[0];
  assert.equal(page.morph, undefined);
  assert.equal(page.skyCube, undefined);
  assert.ok(page.capture);
});

// ---------------------------------------------------------------------------
// The morph page function, run as written against a fake scene
// ---------------------------------------------------------------------------

const SCENE_MODE_MODULE = `data:text/javascript,${encodeURIComponent(
  "export const SceneMode = { MORPHING: 0, COLUMBUS_VIEW: 1, SCENE2D: 2, SCENE3D: 3 };",
)}`;

async function withFakeScene(world, fn) {
  const root = globalThis;
  const saved = { viewer: root.viewer, raf: root.requestAnimationFrame };
  const scene = {
    mode: 3,
    morphTime: 1,
    frameState: { frameNumber: 0 },
    initializeFrame() {},
    render() {
      scene.frameState.frameNumber++;
      if (
        world.completesAfter &&
        scene.frameState.frameNumber >= world.completesAfter
      ) {
        scene.mode = 2;
      }
    },
  };
  if (world.hasMethod !== false) {
    scene.morphTo2D = (seconds) => {
      world.calls.push(seconds);
      if (world.throws) {
        throw new Error("morph refused");
      }
      scene.mode = 0;
    };
  }
  root.viewer = { scene, clock: { currentTime: {} } };
  root.requestAnimationFrame = (callback) => setImmediate(() => callback(0));
  try {
    return await fn();
  } finally {
    root.viewer = saved.viewer;
    root.requestAnimationFrame = saved.raf;
  }
}

const morphArgs = (moduleUrl = SCENE_MODE_MODULE) => ({
  to: "SCENE2D",
  seconds: 3600,
  frames: 4,
  method: "morphTo2D",
  moduleUrl,
});

test("pageMorphHold: the mode is read by name before, right after the morph starts and after the frames", async () => {
  const world = { calls: [] };
  const raw = await withFakeScene(world, () =>
    morph.pageMorphHold(morphArgs()),
  );
  assert.deepEqual(world.calls, [3600]);
  assert.equal(raw.before.mode, "SCENE3D");
  assert.equal(raw.started.mode, "MORPHING");
  assert.equal(raw.after.mode, "MORPHING");
  assert.equal(raw.after.frameNumber, 4);
  assert.equal(morph.morphHoldRecord(raw).held, true);
});

test("pageMorphHold: a scene that completes its morph during the frames is not held; a missing or throwing method is NOT AVAILABLE", async () => {
  const done = await withFakeScene({ calls: [], completesAfter: 2 }, () =>
    morph.pageMorphHold(morphArgs()),
  );
  const record = morph.morphHoldRecord(done);
  assert.equal(record.held, false);
  assert.equal(record.modeAfter, "SCENE2D");
  const missing = await withFakeScene({ calls: [], hasMethod: false }, () =>
    morph.pageMorphHold(morphArgs()),
  );
  assert.equal(missing.available, false);
  assert.match(missing.reason, /scene\.morphTo2D is not a function/);
  const thrown = await withFakeScene({ calls: [], throws: true }, () =>
    morph.pageMorphHold(morphArgs()),
  );
  assert.equal(thrown.available, false);
  assert.match(thrown.reason, /morph refused/);
});

test("the morphHold dial is validated in Node: a target outside the list and a morph too short to outlast the run are refused", () => {
  assert.equal(
    morph.morphHoldViolation({ to: "SCENE2D", seconds: 3600 }),
    null,
  );
  assert.match(
    morph.morphHoldViolation({ to: "MORPHING", seconds: 3600 }),
    /morphHold\.to/,
  );
  assert.match(
    morph.morphHoldViolation({ to: "SCENE2D", seconds: 5 }),
    /at least 600/,
  );
  assert.match(morph.morphHoldViolation(undefined), /morphHold/);
});

// ---------------------------------------------------------------------------
// Inertness
// ---------------------------------------------------------------------------

// Each inertness test runs a BEHAVIOUR that passes on the real module, then
// the same behaviour against the mutant, which must fail with an
// AssertionError (an anchor that no longer matches throws another error and
// does not count).
async function assertRed(behaviour, real, mutant) {
  await behaviour(real);
  await assert.rejects(async () => behaviour(mutant), assert.AssertionError);
}

/** A morph that finishes during the frames is not held. */
async function behaviourHeld(mod) {
  const done = await withFakeScene({ calls: [], completesAfter: 2 }, () =>
    mod.pageMorphHold(morphArgs()),
  );
  assert.equal(mod.morphHoldRecord(done).held, false);
  const kept = await withFakeScene({ calls: [] }, () =>
    mod.pageMorphHold(morphArgs()),
  );
  assert.equal(mod.morphHoldRecord(kept).held, true);
}

const DISPATCH_FAKE = {
  morphAnswer: RAW_MORPH("MORPHING"),
  skyCubeAnswers: {
    add: { added: true, ready: true, frames: 3 },
    read: RAW_CUBE,
  },
};

/** The probe's dispatches put the morph and sky-cube records on their pages. */
async function behaviourDispatch(probe) {
  const a = await p14Run(
    "beh-morph",
    ["--cells", "E-CLOUD-morph"],
    DISPATCH_FAKE,
    probe.descriptor,
  );
  assert.equal(a.report.pages[0].morph?.held, true);
  const b = await p14Run(
    "beh-sky",
    ["--cells", "E-SKY-cube"],
    DISPATCH_FAKE,
    probe.descriptor,
  );
  assert.equal(b.report.pages[0].skyCube?.available, true);
}

/** The morph-hold page captures its morphing frame. */
async function behaviourCapture(probe) {
  const run = await p14Run(
    "beh-capture",
    ["--cells", "E-CLOUD-morph"],
    { morphAnswer: RAW_MORPH("MORPHING") },
    probe.descriptor,
  );
  assert.ok(run.report.pages[0].capture, "the morphing frame is captured");
}

test("inertness: the held rule made unreachable calls a finished morph held", async () => {
  const mutated = await importMutated(MORPH_MODULE, [
    [
      'held: startedMode === "MORPHING" && afterMode === "MORPHING",',
      "held: true,",
    ],
  ]);
  await assertRed(behaviourHeld, morph, mutated);
});

test("inertness: the probe's morph and sky-cube dispatches made unreachable lose their records", async () => {
  const real = {
    descriptor: (
      await import(new URL("./probe-landing-cells.mjs", import.meta.url).href)
    ).descriptor,
  };
  const noMorph = await importMutated(PROBE_MODULE, [
    [
      'if (entry.kind === "morph-hold") {\n        record.morph',
      'if (false && entry.kind === "morph-hold") {\n        record.morph',
    ],
  ]);
  await assertRed(behaviourDispatch, real, noMorph);
  const noSky = await importMutated(PROBE_MODULE, [
    [
      'if (entry.kind === "sky-cube") {',
      'if (false && entry.kind === "sky-cube") {',
    ],
  ]);
  await assertRed(behaviourDispatch, real, noSky);
});

test("inertness: the capture condition made unreachable loses the morphing and model frames", async () => {
  const real = {
    descriptor: (
      await import(new URL("./probe-landing-cells.mjs", import.meta.url).href)
    ).descriptor,
  };
  const noCapture = await importMutated(PROBE_MODULE, [
    [
      'entry.kind === "morph-hold" ||',
      'false && entry.kind === "morph-hold" ||',
    ],
  ]);
  await assertRed(behaviourCapture, real, noCapture);
});

// The per-page verdicts of the two new kinds, judged by lib/landing-verdicts.mjs
// from the records the step pieces leave; the records here are synthetic.
const VERDICTS_MODULE = fileURLToPath(
  new URL("./lib/landing-verdicts.mjs", import.meta.url),
);
const SIX_FACES = (nonZeroBytes) =>
  Array.from({ length: 6 }, (_, face) => ({
    face,
    byteLength: 64,
    nonZeroBytes,
    sha256: `f${face}`,
  }));
const KIT11_RECORDS = [
  {
    run: 0,
    cell: "E-CLOUD-morph",
    renderer: "webgpu",
    page: "scene",
    kind: "morph-hold",
    notRun: null,
    gate: { deviceLost: false },
    morph: { available: true, held: true },
  },
  {
    run: 0,
    cell: "E-CLOUD-morph",
    renderer: "webgpu",
    page: "scene",
    kind: "morph-hold",
    notRun: null,
    gate: { deviceLost: false },
    morph: { available: true, held: false },
  },
  {
    run: 0,
    cell: "E-SKY-cube",
    renderer: "webgpu",
    page: "scene",
    kind: "sky-cube",
    notRun: null,
    gate: { deviceLost: false },
    skyCube: { available: true, faces: SIX_FACES(9) },
  },
  {
    run: 0,
    cell: "E-SKY-cube",
    renderer: "webgpu",
    page: "scene",
    kind: "sky-cube",
    notRun: null,
    gate: { deviceLost: false },
    skyCube: { available: true, faces: SIX_FACES(0) },
  },
  {
    run: 0,
    cell: "E-SKY-cube",
    renderer: "webgpu",
    page: "scene",
    kind: "sky-cube",
    notRun: null,
    gate: { deviceLost: false },
    skyCube: {
      available: false,
      reason: "NOT AVAILABLE: manager._webgpuCache.cubemapTexture",
    },
  },
];

function kit11Verdicts(landingVerdicts) {
  return landingVerdicts(KIT11_RECORDS, null).filter((v) =>
    /:(morph-held|sky-cube-read)$/.test(v.id),
  );
}

test("verdicts: morph-held passes only on a held morph; sky-cube-read fails an all-zero cube and is NOT RUN without one", async () => {
  const { landingVerdicts } = await import(
    new URL("./lib/landing-verdicts.mjs", import.meta.url).href
  );
  const verdicts = kit11Verdicts(landingVerdicts);
  assert.deepEqual(
    verdicts.map((v) => [v.id.split(":").pop(), v.pass, v.notRun]),
    [
      ["morph-held", true, false],
      ["morph-held", false, false],
      ["sky-cube-read", true, false],
      ["sky-cube-read", false, false],
      ["sky-cube-read", false, true],
    ],
  );
  assert.match(verdicts[4].reason, /NOT AVAILABLE: manager\._webgpuCache/);
});

async function behaviourVerdicts(mod) {
  const verdicts = kit11Verdicts(mod.landingVerdicts);
  assert.deepEqual(
    verdicts.map((v) => [v.id.split(":").pop(), v.pass, v.notRun]),
    [
      ["morph-held", true, false],
      ["morph-held", false, false],
      ["sky-cube-read", true, false],
      ["sky-cube-read", false, false],
      ["sky-cube-read", false, true],
    ],
  );
}

test("verdicts (mutants): the morph-held and sky-cube-read verdicts made unreachable fail the verdict behaviour", async () => {
  const real = await import(
    new URL("./lib/landing-verdicts.mjs", import.meta.url).href
  );
  for (const anchor of [
    'if (record.kind === "morph-hold") {',
    'if (record.kind === "sky-cube") {',
  ]) {
    const mutated = await importMutated(VERDICTS_MODULE, [
      [anchor, anchor.replace("if (", "if (false && ")],
    ]);
    await assertRed(behaviourVerdicts, real, mutated);
  }
});

// ---------------------------------------------------------------------------
// E-BGL-shadow's owner labels: only objects the GPU device census records.
// ---------------------------------------------------------------------------

const ENGINE_WEBGPU = fileURLToPath(
  new URL("../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
);
const CENSUS_MODULE_SOURCE = fs.readFileSync(
  fileURLToPath(new URL("./lib/gpu-device-census.mjs", import.meta.url)),
  "utf8",
);

/** The device creators the census wraps, read from its own source. */
function censusCreators() {
  const creators = new Set();
  for (const match of CENSUS_MODULE_SOURCE.matchAll(
    /DeviceProto\.(create\w+) = function/g,
  )) {
    creators.add(match[1]);
  }
  for (const match of CENSUS_MODULE_SOURCE.matchAll(
    /wrap(?:Sync|Async)\(\s*"(create\w+)"/g,
  )) {
    creators.add(match[1]);
  }
  return creators;
}

/**
 * The creator each label is made by in the engine's WebGPU sources: the
 * nearest `device.createX(` / `.createX({` before the `label: "<label>"`
 * literal, within 12 lines.
 */
function creatorsOfLabel(label) {
  const found = [];
  for (const name of fs.readdirSync(ENGINE_WEBGPU)) {
    if (!name.endsWith(".ts")) {
      continue;
    }
    const lines = fs
      .readFileSync(path.join(ENGINE_WEBGPU, name), "utf8")
      .split(/\r?\n/);
    lines.forEach((line, at) => {
      if (!line.includes(`label: ${JSON.stringify(label)}`)) {
        return;
      }
      for (let back = at; back >= Math.max(0, at - 12); back--) {
        const call = /\.(create\w+)\(/.exec(lines[back]);
        if (call) {
          found.push({ file: name, line: at + 1, creator: call[1] });
          return;
        }
      }
      found.push({ file: name, line: at + 1, creator: null });
    });
  }
  return found;
}

function behaviourObservableOwnerLabels(labels) {
  const recorded = censusCreators();
  assert.ok(recorded.has("createTexture") && recorded.has("createBuffer"));
  assert.equal(
    recorded.has("createSampler"),
    false,
    "the census records no samplers (a GPUSampler has no destroy())",
  );
  for (const label of labels) {
    const sites = creatorsOfLabel(label);
    assert.ok(sites.length > 0, `${label}: the engine creates it`);
    for (const site of sites) {
      assert.ok(
        site.creator !== null && recorded.has(site.creator),
        `${label} (${site.file}:${site.line}) is made by ${site.creator}, which the census does not record`,
      );
    }
  }
}

test("E-BGL-shadow lists only owner labels the GPU device census can observe", () => {
  assert.deepEqual(LANDING_CELLS["E-BGL-shadow"].ownerLabels, [
    "CloudShadow UB",
    "CloudShadow Map (sun-view optical depth)",
    "CloudShadow Placeholder (1x1 zero r16float)",
  ]);
  behaviourObservableOwnerLabels(LANDING_CELLS["E-BGL-shadow"].ownerLabels);
});

test("E-BGL-shadow (mutant): the sampler label added back is refused as unobservable", () => {
  assert.throws(
    () =>
      behaviourObservableOwnerLabels([
        ...LANDING_CELLS["E-BGL-shadow"].ownerLabels,
        "CloudShadow Sampler",
      ]),
    assert.AssertionError,
  );
});

const SHADOW_ROWS = (labels) =>
  Object.fromEntries(
    labels.map((label) => [
      `texture:${label}`,
      {
        kind: "texture",
        label,
        created: 1,
        destroyed: 0,
        freedByDevice: 0,
        liveBytes: 4,
      },
    ]),
  );

/** The owners-seen verdict over page records: all seen passes, unseen fails naming them. */
function behaviourOwnersVerdict(mod) {
  const page = (owners) => ({
    run: 0,
    cell: "E-BGL-shadow",
    renderer: "webgpu",
    page: "scene",
    kind: "capture",
    notRun: null,
    gate: { deviceLost: false },
    owners,
  });
  const row = (label, seen) => ({ label, kind: seen ? "texture" : null, seen });
  const judge = (owners) =>
    mod
      .landingVerdicts([page(owners)], null)
      .find((v) => v.id.endsWith(":owners-seen"));
  const good = judge([row("a", true), row("b", true)]);
  assert.ok(good, "the verdict exists");
  assert.equal(good.pass, true);
  const bad = judge([row("a", true), row("CloudShadow Sampler", false)]);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.unseen, ["CloudShadow Sampler"]);
}

async function behaviourOwnersSeen(probe) {
  const all = await p14Run(
    "owners-all",
    ["--cells", "E-BGL-shadow"],
    {
      censusByLabel: SHADOW_ROWS(LANDING_CELLS["E-BGL-shadow"].ownerLabels),
    },
    probe.descriptor,
  );
  const seen = all.report.verdicts.find((v) => v.id.endsWith(":owners-seen"));
  assert.ok(seen, "the owners-seen verdict exists");
  assert.equal(seen.pass, true);
  assert.equal(all.report.pages[0].owners.length, 3);
  const short = await p14Run(
    "owners-short",
    ["--cells", "E-BGL-shadow"],
    { censusByLabel: SHADOW_ROWS(["CloudShadow UB"]) },
    probe.descriptor,
  );
  const missing = short.report.verdicts.find((v) =>
    v.id.endsWith(":owners-seen"),
  );
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.unseen, [
    "CloudShadow Map (sun-view optical depth)",
    "CloudShadow Placeholder (1x1 zero r16float)",
  ]);
  assert.equal(short.code, 1, "an owner never seen is a measured red");
}

test("E-BGL-shadow: owners-seen passes when the census shows every listed owner and fails naming the unseen ones", async () => {
  const real = await import(
    new URL("./probe-landing-cells.mjs", import.meta.url).href
  );
  await behaviourOwnersSeen(real);
});

test("E-BGL-shadow (mutants): the owner read or the owners-seen verdict made unreachable", async () => {
  const real = await import(
    new URL("./probe-landing-cells.mjs", import.meta.url).href
  );
  const noRead = await importMutated(PROBE_MODULE, [
    [
      "if (Array.isArray(cell.ownerLabels)) {",
      "if (false && Array.isArray(cell.ownerLabels)) {",
    ],
  ]);
  await assertRed(behaviourOwnersSeen, real, noRead);
  const verdictsModule = fileURLToPath(
    new URL("./lib/landing-verdicts.mjs", import.meta.url),
  );
  const realVerdicts = await import(
    new URL("./lib/landing-verdicts.mjs", import.meta.url).href
  );
  const noVerdict = await importMutated(verdictsModule, [
    [
      "if (Array.isArray(record.owners) && !record.deviceLoss) {",
      "if (false && Array.isArray(record.owners) && !record.deviceLoss) {",
    ],
  ]);
  await assertRed(behaviourOwnersVerdict, realVerdicts, noVerdict);
});
