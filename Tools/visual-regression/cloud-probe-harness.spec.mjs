import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { resolveCloudPerfPass } from "./lib/cloud-perf-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeFiles = [
  "probe-cloud-tour.mjs",
  "probe-cloud-temporal.mjs",
  "probe-cloud-perf.mjs",
];

test("cloud probe configuration round-trips through the collection contract", () => {
  const volumetric = {
    cloudCoverage: 0.5,
    cloudDensity: 0.3,
    cloudQuality: 64,
    cloudWindDirection: { x: 0.7, y: 0.3 },
  };
  globalThis.viewer = {
    scene: {
      requestRenderMode: true,
      context: { rendererType: "webgpu", isWebGPU: true },
      globe: {
        defaultCloudCollection: {
          enableVolumetric: false,
          renderMode: 0,
          volumetric,
        },
      },
    },
  };

  try {
    installCloudProbeHarness();
    const truth = globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: {
        cloudCoverage: 0.35,
        cloudDensity: 0.7,
        cloudQuality: 128,
        cloudWindDirection: { x: 0.25, y: -0.5 },
      },
    });

    assert.equal(truth.ok, true);
    assert.equal(truth.requestRenderMode, false);
    assert.equal(truth.enableVolumetric, true);
    assert.deepEqual(truth.config, {
      cloudCoverage: 0.35,
      cloudDensity: 0.7,
      cloudQuality: 128,
      cloudWindDirection: { x: 0.25, y: -0.5 },
    });
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
});

test("core cloud probes never gate volumetric fields on Globe", () => {
  const staleGlobeGuard =
    /if\s*\(\s*["']cloud[A-Za-z0-9_]+["']\s+in\s+g\s*\)/g;

  for (const file of probeFiles) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.equal(
      staleGlobeGuard.test(source),
      false,
      `${file} contains a stale Globe cloud-property guard`,
    );
    staleGlobeGuard.lastIndex = 0;
  }
});

test("core cloud probes use the deterministic offline viewer boot", () => {
  for (const file of probeFiles) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.match(
      source,
      /CesiumViewer\/index\.html\?renderer=.*offline=true/,
      `${file} must disable external terrain and imagery requests`,
    );
  }
});

test("manual cloud probes render with their fixed JulianDate", () => {
  for (const file of ["probe-cloud-tour.mjs", "probe-cloud-temporal.mjs"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:s|scene)\.render\(\s*\)/,
      `${file} must not silently substitute JulianDate.now()`,
    );
    assert.match(
      source,
      /\b(?:s|scene)\.render\(frameTime\)/,
      `${file} must render the declared fixed time`,
    );
  }
});

test("cloud probe rejects misspelled or removed volumetric fields", () => {
  globalThis.viewer = {
    scene: {
      requestRenderMode: true,
      context: { rendererType: "webgpu", isWebGPU: true },
      globe: {
        defaultCloudCollection: {
          enableVolumetric: false,
          renderMode: 0,
          volumetric: { cloudCoverage: 0.5 },
        },
      },
    },
  };

  try {
    installCloudProbeHarness();
    assert.throws(
      () =>
        globalThis.__cloudProbe.configure({
          requireWebGPU: true,
          volumetric: { cloudCoverge: 0.35 },
        }),
      /unknown CloudVolumetrics property cloudCoverge/,
    );
    assert.equal(
      Object.hasOwn(
        globalThis.viewer.scene.globe.defaultCloudCollection.volumetric,
        "cloudCoverge",
      ),
      false,
    );
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
});

test("explicit cloud perf pairs cannot degrade to single-artifact passes", () => {
  const resolve = (overrides) =>
    resolveCloudPerfPass({
      currentArtifactValid: true,
      pairId: null,
      comparisonStatus: "not-requested",
      comparisonPassed: null,
      ...overrides,
    });

  assert.equal(resolve({}), true);
  assert.equal(
    resolve({ pairId: "pair-a", comparisonStatus: "missing-companion" }),
    false,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "noncomparable-companion",
    }),
    false,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "compared",
      comparisonPassed: true,
    }),
    true,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "compared",
      comparisonPassed: false,
    }),
    false,
  );
  assert.equal(resolve({ currentArtifactValid: false }), false);
});
