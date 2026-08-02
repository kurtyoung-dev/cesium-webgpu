// Browser-free contracts for the corrected log-depth composition probe.
//
// The post-Batch-818 audit proved the alleged second Bug 814.1 mechanism was
// an instrument false positive: online terrain made +5 m ellipsoid-relative
// placement nondeterministic, and the default terrain-depth policy deliberately
// cleared the depth the negative control expected to consume. These checks pin
// the deterministic scene and keep one-time telemetry out of renderer hot paths.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const read = (relative) => readFileSync(resolve(ROOT, relative), "utf8");
const PROBE = read("Tools/visual-regression/probe-logdepth-zfight.mjs");

test("the browser scene is offline and pins ellipsoid terrain", () => {
  assert.match(PROBE, /renderer=webgpu&offline=true/);
  assert.match(
    PROBE,
    /v\.terrainProvider = new C\.EllipsoidTerrainProvider\(\);/,
  );
  assert.ok(
    PROBE.indexOf("new C.EllipsoidTerrainProvider()") <
      PROBE.indexOf("const imgOn = await snapWithGlobe(true)"),
  );
});

test("terrain depth is retained and asserted before the occlusion verdict", () => {
  assert.match(PROBE, /scene\.globe\.depthTestAgainstTerrain = true;/);
  assert.match(PROBE, /onClearGlobeDepth: imgOn\.clearGlobeDepth/);
  assert.match(PROBE, /out\.onClearGlobeDepth === false/);
  assert.ok(
    PROBE.indexOf("scene.globe.depthTestAgainstTerrain = true") <
      PROBE.indexOf("const imgOn = await snapWithGlobe(true)"),
  );
});

test("the depth-composition gate counts the colocated reference union", () => {
  assert.match(PROBE, /const onForeground = countAll\(/);
  assert.match(PROBE, /const offForeground = countAll\(/);
  assert.match(PROBE, /isGreen\(data, index\) \|\| isMagenta\(data, index\)/);
  assert.match(PROBE, /out\.onForeground \/ out\.offForeground/);
});

test("the underground control has a distinct blue predicate", () => {
  assert.match(PROBE, /const isBelowBlue =/);
  assert.match(
    PROBE,
    /belowMat\.uniforms\.color = new C\.Color\(0\.15, 0\.25, 1\.0, 1\.0\)/,
  );
  assert.match(PROBE, /out\.ctrlGreen <= 40/);
});

test("closed-incident telemetry does not remain in renderer hot paths", () => {
  for (const relative of [
    "packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
  ]) {
    assert.doesNotMatch(read(relative), /_webgpuLogDepthProbeCapture/);
  }
  assert.doesNotMatch(PROBE, /_webgpuLogDepthProbeCapture/);
});
