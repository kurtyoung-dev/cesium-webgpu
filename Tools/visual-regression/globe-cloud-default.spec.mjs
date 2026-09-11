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
import { resolveCloudPreset } from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const sceneDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Scene/", import.meta.url),
);

async function loadCloudDefaults(mutate, label) {
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
      "CumulusCloud",
      "AtmosphericConditions",
      "Frozen",
      "defined",
      "Math",
    ],
    preseed: [
      "CloudCollection.js",
      "CumulusCloud.js",
      "AtmosphericConditions.js",
    ].map((name) => path.join(sceneDirectory, name)),
    mutate,
    label,
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
