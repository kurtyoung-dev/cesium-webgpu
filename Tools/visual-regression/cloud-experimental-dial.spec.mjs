// @purpose Pins the rig `experimental` block end to end without a browser: the real harness configure against a real CloudVolumetrics, both real page-side stagers against a fake Cesium module, the validation and replay-key identity over every registered rig, and inertness mutants for the payload routing, the read-back check and the unknown-key check.
// @status ACTIVE

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import CloudVolumetrics from "../../packages/engine/Source/Scene/CloudVolumetrics.js";
import {
  FAKE_CESIUM_URL,
  createFakeViewer,
} from "./fixtures/landing-cell-stage-support.mjs";
import * as experimentalDial from "./lib/cloud-experimental-dial.mjs";
import {
  cloudRigStagePayload,
  stageCloudRigInPage,
} from "./lib/cloud-rig-stage.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { replayKeyFor as hashStableValue } from "./lib/cloud-tour-fixtures.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  landingStagePayload,
  stageLandingCellInPage,
} from "./lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "./lib/probe-refusal.mjs";
import { loadRigs, replayKeyFor, validateRig } from "./lib/rig-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => path.join(here, "lib", name);

const BLOCK = Object.freeze({
  cloudSpatialOccupancy: true,
  cloudDensityCache: true,
});

// The payload key sets as they stood before the block existed.
const CLOUD_PAYLOAD_KEYS = [
  "rigId",
  "moduleUrl",
  "camera",
  "clock",
  "volumetric",
  "scene",
];
const LANDING_PAYLOAD_KEYS = [
  "rigId",
  "moduleUrl",
  "camera",
  "clock",
  "scene",
  "globe",
  "water",
  "volumetric",
  "cloudsEnabled",
  "needsCloudHarness",
  "stepDials",
];

/** A viewer whose cloud collection carries `volumetric`. */
function cloudViewer(volumetric = new CloudVolumetrics()) {
  const viewer = createFakeViewer();
  viewer.scene.globe.defaultCloudCollection = {
    enableVolumetric: false,
    renderMode: 0,
    volumetric,
  };
  return viewer;
}

/** Run `body` with `viewer` installed as the page's viewer and the harness from `install`. */
async function withHarness(viewer, install, body) {
  globalThis.viewer = viewer;
  try {
    install();
    return await body(globalThis.__cloudProbe);
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
}

/** A namespace with exactly the real instance's experimental keys, whose setters drop writes. */
function droppingNamespace() {
  const namespace = {};
  for (const key of Object.keys(new CloudVolumetrics().experimental)) {
    Object.defineProperty(namespace, key, {
      enumerable: true,
      get: () => false,
      set: () => {},
    });
  }
  return namespace;
}

const cloudRig = (extra = {}) => ({
  id: "experimental-fixture",
  camera: { lon: 10, lat: 20, height: 3000, heading: 0, pitch: -0.5 },
  clock: null,
  dials: { cloudCoverage: 0.5 },
  ...extra,
});

const attempt = (build) => {
  try {
    return { payload: build() };
  } catch (error) {
    return { error };
  }
};

// ---------------------------------------------------------------------------
// The behaviours the mutants are run against. Each takes the module namespace
// it exercises, so the same assertions run on the real module and on a mutant.
// ---------------------------------------------------------------------------

async function behaviourConfigureApplies(harnessModule) {
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    harnessModule.installCloudProbeHarness,
    async (probe) => {
      const truth = probe.configure({ experimental: { ...BLOCK } });
      assert.equal(volumetric.experimental.cloudSpatialOccupancy, true);
      assert.equal(volumetric.experimental.cloudDensityCache, true);
      assert.deepEqual(truth.experimental, { ...BLOCK });
    },
  );
}

async function behaviourUnknownKeyThrows(harnessModule) {
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    harnessModule.installCloudProbeHarness,
    async (probe) => {
      assert.throws(
        () => probe.configure({ experimental: { cloudNotARealDial: true } }),
        /unknown CloudVolumetrics experimental property cloudNotARealDial/,
      );
    },
  );
}

async function behaviourRoundTripThrows(harnessModule) {
  const viewer = cloudViewer({ experimental: droppingNamespace() });
  await withHarness(
    viewer,
    harnessModule.installCloudProbeHarness,
    async (probe) => {
      assert.throws(
        () =>
          probe.configure({ experimental: { cloudSpatialOccupancy: true } }),
        /experimental\.cloudSpatialOccupancy round trip failed: expected true, received false/,
      );
    },
  );
}

async function behaviourLandingCarriesBlock(landingModule) {
  const payload = {
    ...landingModule.landingStagePayload({
      id: "fixture",
      camera: null,
      clock: null,
      dials: {},
      experimental: { ...BLOCK },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  };
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    installCloudProbeHarness,
    async () => {
      const answer = await landingModule.stageLandingCellInPage(payload);
      assert.deepEqual(answer.notApplied, []);
      assert.equal(
        answer.dials["experimental.cloudSpatialOccupancy"].applied,
        true,
      );
      assert.equal(volumetric.experimental.cloudDensityCache, true);
    },
  );
}

async function behaviourCloudCarriesBlock(cloudModule) {
  const payload = {
    ...cloudModule.cloudRigStagePayload(
      cloudRig({ experimental: { ...BLOCK } }),
    ),
    moduleUrl: FAKE_CESIUM_URL,
  };
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    installCloudProbeHarness,
    async () => {
      const answer = await cloudModule.stageCloudRigInPage(payload);
      assert.deepEqual(answer.experimental, { ...BLOCK });
      assert.equal(volumetric.experimental.cloudSpatialOccupancy, true);
    },
  );
}

function behaviourRegistryHandlesBlock(registryModule) {
  const rig = {
    ...cloudRig(),
    tags: ["wave-end"],
    renderers: ["webgpu"],
    page: "x",
    viewport: { width: 8, height: 8 },
    readiness: { kind: "settleFrames", frames: 1 },
  };
  const withBlock = { ...rig, experimental: { ...BLOCK } };
  assert.notEqual(
    registryModule.replayKeyFor(withBlock),
    registryModule.replayKeyFor(rig),
  );
  assert.deepEqual(
    registryModule.validateRig({ ...rig, experimental: { notCloud: true } })
      .length > 0,
    true,
  );
}

// ---------------------------------------------------------------------------
// (a) The harness, real configure against a real CloudVolumetrics.
// ---------------------------------------------------------------------------

test("A1: configure sets experimental dials on the namespace and reports them in truth.experimental", async () => {
  await behaviourConfigureApplies({ installCloudProbeHarness });
});

test("A2: a number-valued experimental dial round-trips too", async () => {
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    installCloudProbeHarness,
    async (probe) => {
      const truth = probe.configure({
        experimental: { cloudLightingContributionThreshold: 0.5 },
      });
      assert.equal(
        volumetric.experimental.cloudLightingContributionThreshold,
        0.5,
      );
      assert.deepEqual(truth.experimental, {
        cloudLightingContributionThreshold: 0.5,
      });
    },
  );
});

test("A3: an unknown experimental key throws naming the key and adds nothing to the namespace", async () => {
  await behaviourUnknownKeyThrows({ installCloudProbeHarness });
  const volumetric = new CloudVolumetrics();
  await withHarness(
    cloudViewer(volumetric),
    installCloudProbeHarness,
    async (probe) => {
      for (const key of ["constructor", "toString", "cloudNotARealDial"]) {
        assert.throws(
          () => probe.configure({ experimental: { [key]: true } }),
          new RegExp(`unknown CloudVolumetrics experimental property ${key}`),
        );
        assert.equal(Object.hasOwn(volumetric.experimental, key), false, key);
      }
    },
  );
});

test("A4: an instance without an experimental namespace refuses every experimental key", async () => {
  await withHarness(
    cloudViewer({}),
    installCloudProbeHarness,
    async (probe) => {
      assert.throws(
        () =>
          probe.configure({ experimental: { cloudSpatialOccupancy: true } }),
        /unknown CloudVolumetrics experimental property cloudSpatialOccupancy/,
      );
    },
  );
});

test("A5: an assignment the setter rejects throws naming the key and the message", async () => {
  await withHarness(cloudViewer(), installCloudProbeHarness, async (probe) => {
    assert.throws(
      () => probe.configure({ experimental: { cloudSpatialOccupancy: "yes" } }),
      /experimental\.cloudSpatialOccupancy assignment threw: .*boolean/,
    );
  });
});

test("A6: a value that does not round-trip throws naming the key", async () => {
  await behaviourRoundTripThrows({ installCloudProbeHarness });
});

test("A7: configure without the option returns a truth with no experimental key", async () => {
  await withHarness(cloudViewer(), installCloudProbeHarness, async (probe) => {
    const truth = probe.configure({ volumetric: { cloudCoverage: 0.4 } });
    assert.equal(Object.hasOwn(truth, "experimental"), false);
    assert.deepEqual(Object.keys(truth), [
      "ok",
      "errors",
      "rendererType",
      "isWebGPU",
      "requestRenderMode",
      "enableVolumetric",
      "renderMode",
      "config",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) The page-side stagers.
// ---------------------------------------------------------------------------

test("B1: stageLandingCellInPage records each experimental dial applied from the harness read-back", async () => {
  await behaviourLandingCarriesBlock({
    landingStagePayload,
    stageLandingCellInPage,
  });
  const volumetric = new CloudVolumetrics();
  const payload = {
    ...landingStagePayload({
      id: "fixture",
      camera: null,
      clock: null,
      dials: {},
      experimental: { ...BLOCK },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  };
  await withHarness(
    cloudViewer(volumetric),
    installCloudProbeHarness,
    async () => {
      const answer = await stageLandingCellInPage(payload);
      for (const [dial, value] of Object.entries(BLOCK)) {
        assert.deepEqual(answer.dials[`experimental.${dial}`], {
          requested: value,
          observed: value,
          applied: true,
        });
      }
      assert.equal(answer.dials.cloudsEnabled.applied, true);
    },
  );
});

test("B2: an unknown experimental key lands in notApplied with the key in the reason", async () => {
  const payload = {
    ...landingStagePayload({
      id: "fixture",
      camera: null,
      clock: null,
      dials: {},
      experimental: { cloudSpatialOccupancy: true, cloudNotARealDial: true },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  };
  await withHarness(cloudViewer(), installCloudProbeHarness, async () => {
    const answer = await stageLandingCellInPage(payload);
    assert.ok(answer.notApplied.includes("experimental.cloudNotARealDial"));
    const entry = answer.dials["experimental.cloudNotARealDial"];
    assert.equal(entry.applied, false);
    assert.match(entry.reason, /cloudNotARealDial/);
    assert.equal(answer.cloud.ok, false);
  });
});

test("B3: a page without the harness fails every experimental dial with a reason", async () => {
  const payload = {
    ...landingStagePayload({
      id: "fixture",
      camera: null,
      clock: null,
      dials: {},
      experimental: { ...BLOCK },
    }),
    moduleUrl: FAKE_CESIUM_URL,
  };
  globalThis.viewer = cloudViewer();
  try {
    const answer = await stageLandingCellInPage(payload);
    for (const dial of Object.keys(BLOCK)) {
      assert.ok(answer.notApplied.includes(`experimental.${dial}`));
      assert.match(
        answer.dials[`experimental.${dial}`].reason,
        /not installed/,
      );
    }
  } finally {
    delete globalThis.viewer;
  }
});

test("B4: stageCloudRigInPage returns the read-back as experimental, and leaves the key out without a block", async () => {
  await behaviourCloudCarriesBlock({
    cloudRigStagePayload,
    stageCloudRigInPage,
  });
  const plain = {
    ...cloudRigStagePayload(cloudRig()),
    moduleUrl: FAKE_CESIUM_URL,
  };
  await withHarness(cloudViewer(), installCloudProbeHarness, async () => {
    const answer = await stageCloudRigInPage(plain);
    assert.equal(Object.hasOwn(answer, "experimental"), false);
  });
});

// ---------------------------------------------------------------------------
// (c) Identity over the registry and the payload builders.
// ---------------------------------------------------------------------------

test("C1: validateRig accepts only a non-empty plain object of cloud keys with boolean or finite-number values", async () => {
  const rigs = await loadRigs();
  assert.ok(rigs.length > 0);
  for (const rig of rigs) {
    assert.deepEqual(validateRig(rig), [], `${rig.id} stays violation-free`);
  }
  const base = rigs[0];
  const good = [
    { cloudA: true },
    { cloudB: 0 },
    { cloudA: 1.5, cloudC: false },
  ];
  for (const experimental of good) {
    assert.deepEqual(
      validateRig({ ...base, experimental }),
      [],
      JSON.stringify(experimental),
    );
  }
  const bad = [
    [null, /experimental/],
    [[], /experimental/],
    [{}, /experimental/],
    ["cloudA", /experimental/],
    [{ coverage: true }, /coverage/],
    [{ cloud: true }, /experimental key cloud /],
    [{ cloudA: "yes" }, /cloudA/],
    [{ cloudA: null }, /cloudA/],
    [{ cloudA: Number.NaN }, /cloudA/],
    [{ cloudA: Number.POSITIVE_INFINITY }, /cloudA/],
    [{ cloudA: {} }, /cloudA/],
  ];
  for (const [experimental, pattern] of bad) {
    const violations = validateRig({ ...base, experimental });
    assert.ok(
      violations.length > 0,
      `refused: ${String(JSON.stringify(experimental))}`,
    );
    assert.match(violations.join("\n"), pattern);
  }
});

// The replay subset as it was defined before the block existed, restated here
// as the independent oracle for "a rig without a block keeps its key".
const oracleSubset = (rig) => ({
  id: rig.id,
  renderers: rig.renderers,
  camera: rig.camera ?? null,
  clock: rig.clock ?? null,
  dials: rig.dials ?? null,
  asset: rig.asset ?? rig.tileset ?? null,
  setupFile: rig.setupFile ?? null,
  setupParams: rig.setupParams ?? null,
  viewport: rig.viewport,
  readiness: rig.readiness,
});

test("C2: every registered rig without a block keeps its replay key, and the same rig with a block hashes differently", async () => {
  const rigs = await loadRigs();
  let declaring = 0;
  for (const rig of rigs) {
    // A rig that declares its own block hashes the block too.
    if (rig.experimental !== undefined) {
      declaring += 1;
      assert.notEqual(
        replayKeyFor(rig),
        hashStableValue(oracleSubset(rig)),
        rig.id,
      );
      continue;
    }
    assert.equal(replayKeyFor(rig), hashStableValue(oracleSubset(rig)), rig.id);
    const withBlock = { ...rig, experimental: { ...BLOCK } };
    assert.notEqual(replayKeyFor(withBlock), replayKeyFor(rig), rig.id);
    const other = { ...rig, experimental: { cloudSpatialOccupancy: false } };
    assert.notEqual(replayKeyFor(other), replayKeyFor(withBlock), rig.id);
  }
  assert.ok(declaring < rigs.length, "most registered rigs declare no block");
});

test("C3: neither builder emits an experimental key for a registered rig without a block, a rig with one carries only it, and the key sets are the ones they always had", async () => {
  const rigs = await loadRigs();
  let cloudBuilt = 0;
  let landingBuilt = 0;
  for (const rig of rigs) {
    // A rig that declares its own block carries it, and nothing else new.
    if (rig.experimental !== undefined) {
      const landing = landingStagePayload(rig);
      assert.deepEqual(
        Object.keys(landing).filter((key) => key !== "experimental"),
        LANDING_PAYLOAD_KEYS,
        rig.id,
      );
      assert.deepEqual(landing.experimental, rig.experimental, rig.id);
      continue;
    }
    const cloud = attempt(() => cloudRigStagePayload(rig));
    if (cloud.payload) {
      cloudBuilt += 1;
      assert.deepEqual(Object.keys(cloud.payload), CLOUD_PAYLOAD_KEYS, rig.id);
    } else {
      assert.doesNotMatch(String(cloud.error.message), /experimental/, rig.id);
    }
    const landing = attempt(() => landingStagePayload(rig));
    if (landing.payload) {
      landingBuilt += 1;
      assert.deepEqual(
        Object.keys(landing.payload),
        LANDING_PAYLOAD_KEYS,
        rig.id,
      );
    } else {
      assert.doesNotMatch(
        String(landing.error.message),
        /experimental/,
        rig.id,
      );
    }
  }
  assert.ok(
    cloudBuilt > 0,
    "at least one registered rig is stageable by the cloud stage",
  );
  assert.ok(
    landingBuilt > 0,
    "at least one registered rig is stageable by the landing stage",
  );
});

test("C4: adding a block to a registered rig changes nothing in either payload but the added key", async () => {
  const rigs = await loadRigs();
  let cloudChecked = 0;
  let landingChecked = 0;
  for (const rig of rigs) {
    // C3 covers a rig that declares its own block.
    if (rig.experimental !== undefined) {
      continue;
    }
    const block = { ...BLOCK };
    const withBlock = { ...rig, experimental: block };
    const cloud = attempt(() => cloudRigStagePayload(rig));
    if (cloud.payload) {
      cloudChecked += 1;
      const { experimental, ...rest } = cloudRigStagePayload(withBlock);
      assert.equal(JSON.stringify(rest), JSON.stringify(cloud.payload), rig.id);
      assert.deepEqual(experimental, BLOCK);
      assert.notEqual(experimental, block, "a copy, not the rig's own object");
    }
    const landing = attempt(() => landingStagePayload(rig));
    if (landing.payload && landing.payload.needsCloudHarness) {
      landingChecked += 1;
      const { experimental, ...rest } = landingStagePayload(withBlock);
      assert.equal(
        JSON.stringify(rest),
        JSON.stringify(landing.payload),
        rig.id,
      );
      assert.deepEqual(experimental, BLOCK);
      assert.notEqual(experimental, block, "a copy, not the rig's own object");
    }
  }
  assert.ok(
    cloudChecked > 0,
    "the cloud stage was checked on at least one rig",
  );
  assert.ok(
    landingChecked > 0,
    "the landing stage was checked on at least one cloud rig",
  );
});

test("C5: a malformed block is refused before any browser: TypeError from the cloud stage, ProbeRefusal from the landing stage, each naming the key", () => {
  for (const experimental of [
    { cloudA: "yes" },
    { notCloud: true },
    { cloudA: Number.NaN },
  ]) {
    const key = Object.keys(experimental)[0];
    assert.throws(
      () => cloudRigStagePayload(cloudRig({ experimental })),
      (error) => error instanceof TypeError && error.message.includes(key),
    );
    assert.throws(
      () =>
        landingStagePayload({
          id: "fixture",
          camera: null,
          clock: null,
          dials: {},
          experimental,
        }),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "rig-dial-unsupported" &&
        error.message.includes(key),
    );
  }
  for (const experimental of [null, [], {}]) {
    assert.throws(
      () => cloudRigStagePayload(cloudRig({ experimental })),
      TypeError,
    );
    assert.throws(
      () =>
        landingStagePayload({
          id: "fixture",
          camera: null,
          clock: null,
          dials: {},
          experimental,
        }),
      ProbeRefusal,
    );
  }
});

test("C6: in the landing stage a block alone needs the cloud harness and turns the collection on, unless cloudsEnabled says otherwise", () => {
  const stage = (dials) =>
    landingStagePayload({
      id: "fixture",
      camera: null,
      clock: null,
      dials,
      experimental: { ...BLOCK },
    });
  const alone = stage({});
  assert.equal(alone.needsCloudHarness, true);
  assert.equal(alone.cloudsEnabled, true);
  assert.deepEqual(alone.experimental, BLOCK);
  const off = stage({ cloudsEnabled: false });
  assert.equal(off.needsCloudHarness, true);
  assert.equal(off.cloudsEnabled, false);
  const without = landingStagePayload({
    id: "fixture",
    camera: null,
    clock: null,
    dials: {},
  });
  assert.equal(without.needsCloudHarness, false);
  assert.equal(without.cloudsEnabled, null);
  assert.equal(Object.hasOwn(without, "experimental"), false);
});

test("C7: the piece's own reading of a block", () => {
  assert.deepEqual(experimentalDial.violations(undefined), []);
  assert.equal(experimentalDial.copy({}), undefined);
  assert.deepEqual(experimentalDial.copy({ experimental: { cloudA: 1 } }), {
    cloudA: 1,
  });
});

// ---------------------------------------------------------------------------
// (d) Inertness mutants: each makes a clause unreachable and the behaviour
// that pins it must go red.
// ---------------------------------------------------------------------------

// A data: module has no import.meta.url to derive a directory from.
const REGISTRY_BASE = [
  "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
  'const __dirname = ".";',
];

async function mutantGoesRed(name, file, replacements, behaviour) {
  test(`D: mutant ${name} makes the behaviour fail`, async () => {
    const mutated = await importMutated(lib(file), replacements);
    let failure = null;
    try {
      await behaviour(mutated);
    } catch (error) {
      failure = error;
    }
    assert.notEqual(
      failure,
      null,
      `${name}: the behaviour must fail on the mutant`,
    );
  });
}

mutantGoesRed(
  "cloud builder drops the experimental block",
  "cloud-rig-stage.mjs",
  [["    ...(experimental === undefined ? {} : { experimental }),\n", ""]],
  behaviourCloudCarriesBlock,
);

mutantGoesRed(
  "landing builder drops the experimental block",
  "landing-cell-stage.mjs",
  [["    ...(experimental === undefined ? {} : { experimental }),\n", ""]],
  behaviourLandingCarriesBlock,
);

mutantGoesRed(
  "cloud stager does not pass the block to configure",
  "cloud-rig-stage.mjs",
  [
    [
      "    ...(payload.experimental === undefined\n      ? {}\n      : { experimental: payload.experimental }),\n",
      "",
    ],
  ],
  behaviourCloudCarriesBlock,
);

mutantGoesRed(
  "landing stager does not pass the block to configure",
  "landing-cell-stage.mjs",
  [
    [
      "          ...(payload.experimental === undefined\n            ? {}\n            : { experimental: payload.experimental }),\n",
      "",
    ],
  ],
  behaviourLandingCarriesBlock,
);

mutantGoesRed(
  "landing stager records no experimental dial",
  "landing-cell-stage.mjs",
  [
    [
      "Object.entries(payload.experimental ?? {})) {\n      const got",
      "Object.entries({})) {\n      const got",
    ],
  ],
  behaviourLandingCarriesBlock,
);

mutantGoesRed(
  "harness read-back check unreachable",
  "cloud-probe-harness.mjs",
  [
    [
      "        experimentalConfig[key] = snapshotValue(actual);\n        if (!valuesEqual(actual, expected)) {",
      "        experimentalConfig[key] = snapshotValue(actual);\n        if (false && !valuesEqual(actual, expected)) {",
    ],
  ],
  behaviourRoundTripThrows,
);

mutantGoesRed(
  "harness unknown-key check unreachable",
  "cloud-probe-harness.mjs",
  [
    [
      "        if (!experimentalKnown.has(key)) {\n          errors.push(",
      "        if (false && !experimentalKnown.has(key)) {\n          errors.push(",
    ],
  ],
  behaviourUnknownKeyThrows,
);

mutantGoesRed(
  "harness never assigns the experimental dials",
  "cloud-probe-harness.mjs",
  [["          experimental[key] = value;\n", ""]],
  behaviourConfigureApplies,
);

mutantGoesRed(
  "registry validation ignores the block",
  "rig-registry.mjs",
  [
    REGISTRY_BASE,
    [
      "for (const violation of experimentalDial.violations(rig?.experimental)) {",
      "for (const violation of []) {",
    ],
  ],
  behaviourRegistryHandlesBlock,
);

mutantGoesRed(
  "registry replay key ignores the block",
  "rig-registry.mjs",
  [
    REGISTRY_BASE,
    [
      "...(rig.experimental === undefined\n      ? {}\n      : { experimental: rig.experimental }),",
      "",
    ],
  ],
  behaviourRegistryHandlesBlock,
);

test("D: the behaviours pass on the unmutated modules", async () => {
  const harness = { installCloudProbeHarness };
  await behaviourConfigureApplies(harness);
  await behaviourUnknownKeyThrows(harness);
  await behaviourRoundTripThrows(harness);
  await behaviourLandingCarriesBlock({
    landingStagePayload,
    stageLandingCellInPage,
  });
  await behaviourCloudCarriesBlock({
    cloudRigStagePayload,
    stageCloudRigInPage,
  });
  behaviourRegistryHandlesBlock({ replayKeyFor, validateRig });
});
