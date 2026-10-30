// @purpose Pins the managed cloud deck OFF by default (maintainer ruling M2) while proving the cinematic tier still resolves when a scene opts in.
// @status ACTIVE

// Ruling M2 (2026-09-10) held the `Scene/Globe.js` hunk that constructed the
// managed deck as `new CloudCollection({ enableVolumetric: true, volumetric: {
// cloudVolumetricQuality: "high" } })`. Turning the volumetric raymarch on for
// every WebGPU scene at tier 3 — full resolution, 96 primary / 8 light steps,
// no temporal reprojection, no measured frame cost — IS the reported defect
// (flat dark-navy sky, stippled repeating blotches), and the authorising
// document approved configuration behaviour only, explicitly withholding
// visual and rollout approval.
//
// So this file asserts the *observable configuration a fresh scene gets*: no
// deck, no raymarch demand, and therefore no cloud work on either backend. It
// deliberately also asserts the opposite half — that an explicit opt-in still
// reaches the cinematic tier — so the guard cannot be satisfied by breaking the
// feature instead of by defaulting it off.
//
// The last test is the inertness control: it rewrites `Globe.js` into the held
// construction and requires the default-off assertion to fail. Without it, a
// re-landing of the held hunk would leave every test above green.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import CloudRenderMode from "../../packages/engine/Source/Scene/CloudRenderMode.js";
import FeatureRendererKey from "../../packages/engine/Source/Renderer/FeatureRendererKey.js";
import { resolveCloudPreset } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const sceneDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Scene/", import.meta.url),
);

async function loadCloudDefaults(mutate, label, overrides = []) {
  const globePath = path.join(sceneDirectory, "Globe.js");
  const source = readFileSync(globePath, "utf8").replaceAll("\r\n", "\n");
  return bundle({
    path: globePath,
    source: `${source}\nimport AtmosphericConditions from "./AtmosphericConditions.js";\nexport { CloudCollection, AtmosphericConditions };\n`,
    real: [
      "CloudCollection",
      "CloudVolumetrics",
      "CloudRenderMode",
      "CloudType",
      "CloudWeatherState",
      "CumulusCloud",
      "AtmosphericConditions",
      "FeatureRendererKey",
      "Frozen",
      "defined",
      "Math",
    ],
    preseed: [
      "CloudCollection.js",
      "CloudWeatherState.js",
      "CumulusCloud.js",
      "AtmosphericConditions.js",
    ].map((name) => path.join(sceneDirectory, name)),
    mutate,
    label,
    overrides,
  });
}

function createGlobe(Globe) {
  // Only unrelated constructor dependencies are stubbed; cloud state is real.
  return new Globe({ maximumRadius: 6378137, minimumRadius: 6356752 });
}

/**
 * The property the environmental-effects and god-ray gates actually read. A
 * deck drives work only when `renderMode` is VOLUMETRIC *and*
 * `volumetric.enabled` is set, so both are asserted: either one alone leaves
 * the raymarch unreachable, and the gate is what a viewer's frame cost follows.
 */
function assertManagedDeckDrivesNoWork(globe) {
  const collection = globe.defaultCloudCollection;
  assert.equal(
    collection.renderMode,
    CloudRenderMode.BILLBOARD,
    "a fresh scene must not publish a volumetric deck",
  );
  assert.equal(collection.enableVolumetric, false);
  assert.equal(collection.volumetric.enabled, false);
  assert.notEqual(
    collection.volumetric.cloudVolumetricQuality,
    "high",
    "a fresh scene must not pin the cinematic preset",
  );
}

test("a fresh globe's managed cloud deck drives no volumetric work", async () => {
  const { default: Globe } = await loadCloudDefaults();
  assertManagedDeckDrivesNoWork(createGlobe(Globe));
});

test("the cloud facade reports the off state and honours an explicit opt-in", async () => {
  const { default: Globe, AtmosphericConditions } = await loadCloudDefaults();
  const globe = createGlobe(Globe);
  const clouds = new AtmosphericConditions({}, globe).clouds;
  assert.equal(clouds.enableVolumetric, false);
  assert.equal(clouds.enableProcedural, false);

  clouds.enableVolumetric = true;
  assert.equal(
    globe.defaultCloudCollection.renderMode,
    CloudRenderMode.VOLUMETRIC,
    "an explicit opt-in must still reach the volumetric render mode",
  );
  assert.equal(globe.defaultCloudCollection.volumetric.enabled, true);

  clouds.enableVolumetric = false;
  assert.equal(
    globe.defaultCloudCollection.renderMode,
    CloudRenderMode.BILLBOARD,
    "turning the facade back off must retire the deck",
  );
  assert.equal(globe.defaultCloudCollection.volumetric.enabled, false);
});

test("an opted-in deck still resolves the cinematic tier at every altitude", async () => {
  // The capability the held hunk wanted is intact; only its default changed.
  const { default: Globe, AtmosphericConditions } = await loadCloudDefaults();
  const globe = createGlobe(Globe);
  const clouds = new AtmosphericConditions({}, globe).clouds;
  clouds.volumetricQuality = "high";
  clouds.enableVolumetric = true;
  const volumetric = globe.defaultCloudCollection.volumetric;
  assert.equal(volumetric.cloudVolumetricQuality, "high");
  for (const cameraHeightMeters of [0, 75000, 30000000]) {
    const preset = resolveCloudPreset({
      preset: volumetric.cloudVolumetricQuality,
      rawCloudQuality: volumetric.cloudQuality,
      cameraHeightMeters,
      enableAltitudeMeters: 50000,
      disableAltitudeMeters: 100000,
    });
    assert.equal(preset.tier, 3);
    assert.equal(preset.renderResScale, 1);
    assert.equal(preset.primarySteps, 96);
    assert.equal(preset.lightSteps, 8);
  }
});

test("standalone cloud collections remain opt-in and preserve supplied quality", async () => {
  const { CloudCollection } = await loadCloudDefaults();
  const standard = new CloudCollection();
  assert.equal(standard.renderMode, CloudRenderMode.BILLBOARD);
  assert.equal(standard.enableVolumetric, false);
  assert.equal(standard.volumetric.enabled, false);
  assert.equal(standard.volumetric.cloudVolumetricQuality, "auto");
  const selected = new CloudCollection({
    enableVolumetric: true,
    volumetric: { cloudVolumetricQuality: "medium" },
  });
  assert.equal(selected.enableVolumetric, true);
  assert.equal(selected.volumetric.cloudVolumetricQuality, "medium");
});

test("the guard fails when the held default-on construction is restored", async () => {
  // Inertness control. Re-landing the held hunk must turn this file red rather
  // than slipping past a guard that only ever read a constant.
  const { default: Globe } = await loadCloudDefaults(
    (source) =>
      source.replace(
        "this._defaultCloudCollection = new CloudCollection();",
        'this._defaultCloudCollection = new CloudCollection({\n      enableVolumetric: true,\n      volumetric: { cloudVolumetricQuality: "high" },\n    });',
      ),
    "restore the held default-on cloud deck",
  );
  assert.throws(() => assertManagedDeckDrivesNoWork(createGlobe(Globe)), {
    name: "AssertionError",
  });
});

// ── Scene-clock weather: a state exists only where a cloud renderer reads it ──
//
// The managed deck is not a primitive, so `Globe.beginFrame` ticks its weather;
// a user collection ticks its own in `update`. These tests drive the real
// `Globe.beginFrame` and `CloudCollection` with a stub frame state. A context
// that carries a CLOUD_COLLECTION feature renderer stands for WebGPU; one
// without it stands for WebGL, whose frame keeps the base behaviour: no weather
// state is ever created there. The two mutants make the `beginFrame` hook, and
// the consumer gate, unreachable, and each must turn a check red.

function weatherFrameState(consumer) {
  const renderer = { update() {}, destroy() {} };
  const requests = [];
  return {
    requests,
    frameState: {
      context: {
        getFeatureRenderer: (key) =>
          consumer && key === FeatureRendererKey.CLOUD_COLLECTION
            ? renderer
            : undefined,
        requestVolumetricClouds: (config) => requests.push(config),
      },
      passes: {},
      afterRender: [],
    },
  };
}

function quietGlobe(Globe) {
  const globe = createGlobe(Globe);
  // The ocean normal-map reload in `beginFrame` is unrelated to clouds, and
  // with its dependencies stubbed its resource would look defined.
  globe._oceanNormalMapResourceDirty = false;
  return globe;
}

/** Steps the managed deck through every gate and records whether a state exists. */
function managedWeatherStates(globe, frameState) {
  const collection = globe.defaultCloudCollection;
  const seen = {};
  const step = (name, renderMode, enabled, show = true) => {
    collection.renderMode = renderMode;
    collection.volumetric.enabled = enabled;
    collection.show = show;
    globe.beginFrame(frameState);
    seen[name] = collection._weatherState !== undefined;
  };
  step("billboard", CloudRenderMode.BILLBOARD, false);
  step("volumetric", CloudRenderMode.VOLUMETRIC, true);
  step("hidden", CloudRenderMode.VOLUMETRIC, true, false);
  step("disabled", CloudRenderMode.VOLUMETRIC, false);
  step("billboardEnabled", CloudRenderMode.BILLBOARD, true);
  step("volumetricAgain", CloudRenderMode.VOLUMETRIC, true);
  return seen;
}

const ONLY_WHEN_SHOWN_VOLUMETRIC_ENABLED = {
  billboard: false,
  volumetric: true,
  hidden: false,
  disabled: false,
  billboardEnabled: false,
  volumetricAgain: true,
};

test("Globe.beginFrame ticks the managed deck's weather only while it is shown, VOLUMETRIC and enabled", async () => {
  const { default: Globe } = await loadCloudDefaults();
  const { frameState } = weatherFrameState(true);
  assert.deepEqual(
    managedWeatherStates(quietGlobe(Globe), frameState),
    ONLY_WHEN_SHOWN_VOLUMETRIC_ENABLED,
  );
});

test("without a cloud feature renderer (WebGL) no weather state is ever created", async () => {
  const { default: Globe } = await loadCloudDefaults();
  const { frameState } = weatherFrameState(false);
  const seen = managedWeatherStates(quietGlobe(Globe), frameState);
  assert.deepEqual(
    Object.values(seen),
    Object.values(seen).map(() => false),
  );
});

test("a user collection publishes this frame's weather with its request, and a hidden one publishes nothing", async () => {
  const { CloudCollection } = await loadCloudDefaults();
  const collection = new CloudCollection({
    enableVolumetric: true,
    volumetric: { cloudWeatherMap: true },
  });
  const { frameState, requests } = weatherFrameState(true);
  collection.update(frameState);
  assert.notEqual(collection._weatherState, undefined);
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0].weatherProvider, undefined);
  assert.equal(
    requests[0].weatherProvider,
    collection._weatherState.provider,
    "the request carries the state's provider",
  );
  collection.show = false;
  collection.update(frameState);
  assert.equal(
    collection._weatherState,
    undefined,
    "a hidden collection drops its weather",
  );
  assert.equal(requests.length, 1, "a hidden collection publishes nothing");
  collection.destroy();
});

test("MUTANT: the beginFrame weather hook made unreachable leaves the managed deck without weather, and the check sees it", async () => {
  const { default: Globe } = await loadCloudDefaults(
    (source) =>
      source.replace(
        "    this._defaultCloudCollection?._updateWeather?.(frameState);",
        "    if (false) this._defaultCloudCollection?._updateWeather?.(frameState);",
      ),
    "make the Globe.beginFrame weather hook unreachable",
  );
  const { frameState } = weatherFrameState(true);
  assert.notDeepEqual(
    managedWeatherStates(quietGlobe(Globe), frameState),
    ONLY_WHEN_SHOWN_VOLUMETRIC_ENABLED,
  );
});

test("MUTANT: the consumer gate made unreachable creates weather on WebGL, and the check sees it", async () => {
  const { default: Globe } = await loadCloudDefaults(undefined, undefined, [
    {
      basename: "CloudCollection.js",
      mutate: (source) =>
        source.replace(
          "      defined(\n        frameState.context?.getFeatureRenderer?.(\n          FeatureRendererKey.CLOUD_COLLECTION,\n        ),\n      )",
          "      true",
        ),
      label: "drop the cloud feature renderer gate from _updateWeather",
    },
  ]);
  const { frameState } = weatherFrameState(false);
  assert.equal(
    managedWeatherStates(quietGlobe(Globe), frameState).volumetric,
    true,
    "without the gate the WebGL frame creates a weather state",
  );
});
