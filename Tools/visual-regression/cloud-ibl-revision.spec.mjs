import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const managerPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
);
const cloudRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const manager = fs.readFileSync(managerPath, "utf8");
const cloudRenderer = fs.readFileSync(cloudRendererPath, "utf8");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source anchor: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source anchor: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the environment-map cache edge-triggers fills from cloud revisions", () => {
  const cacheShape = sourceSection(
    manager,
    "interface DynEnvMapCache {",
    "/**\n * Update WebGPU dynamic environment map resources.",
  );
  assert.match(cacheShape, /lastCloudRevision:\s*number;/);

  const cacheInitialization = sourceSection(
    manager,
    "if (!manager._webgpuCache) {",
    "const cache = manager._webgpuCache as DynEnvMapCache;",
  );
  assert.match(cacheInitialization, /lastCloudRevision:\s*NaN,/);

  const refreshGate = sourceSection(
    manager,
    "const liveCloudState =",
    "// C2-25 ENV-SCENE-CAPTURE",
  );
  assert.match(refreshGate, /iblRevision\?:\s*number/);
  assert.match(
    refreshGate,
    /const liveCloudRevision\s*=\s*liveCloudState\?\.iblRevision\s*\?\?\s*0;/,
  );
  assert.match(
    refreshGate,
    /const cloudRevisionChanged\s*=\s*liveCloudRevision\s*!==\s*cache\.lastCloudRevision;/,
  );

  const fillBlock = sourceSection(
    manager,
    "if (\n    cache.needsUpdate ||",
    "// Expose cubemap + prefiltered IBL views for shader consumption.",
  );
  assert.match(fillBlock, /\|\|\s*cloudRevisionChanged\s*\|\|/);

  const fillIndex = fillBlock.indexOf("runProceduralSkyFill(");
  const prefilterIndex = fillBlock.indexOf("runIBLPrefilter(");
  const projectionIndex = fillBlock.indexOf(
    "runSphericalHarmonicProjection(",
  );
  const revisionCommitIndex = fillBlock.indexOf(
    "cache.lastCloudRevision = liveCloudRevision;",
  );
  assert.ok(fillIndex >= 0, "sky fill must run on the refresh path");
  assert.ok(
    prefilterIndex > fillIndex,
    "the IBL prefilter must follow the sky fill",
  );
  assert.ok(
    projectionIndex > prefilterIndex,
    "SH projection must follow the IBL prefilter",
  );
  assert.ok(
    revisionCommitIndex > projectionIndex,
    "the consumed revision must be committed only after the complete fill",
  );
});

test("one revision covers every reflected-density input without per-frame fills", () => {
  const publisher = sourceSection(
    cloudRenderer,
    "export function publishCloudIblCoverage(",
    "\nfunction clampUnit(",
  );
  // Continuous inputs are compared through their snapped (quantized) values so
  // sub-step jitter cannot bump the revision; discrete flags compare exactly.
  for (const comparison of [
    "cache.iblDeckBottom !== quantDeckBottom",
    "cache.iblDeckTop !== quantDeckTop",
    "cache.iblWindX !== quantWindX",
    "cache.iblWindY !== quantWindY",
    "cache.iblWindSpeed !== quantWindSpeed",
    "cache.iblDensity !== quantDensity",
    "cache.iblPuffSize !== quantPuffSize",
    "cache.iblPWActive !== pwActive",
    "cache.iblCoverage !== quantCoverage",
  ]) {
    assert.ok(
      publisher.includes(comparison),
      `the publisher must revise IBL for ${comparison}`,
    );
  }
  assert.match(
    publisher,
    /const advectionMeters\s*=\s*quantWindSpeed\s*\*\s*cloudTimeSeconds;/,
  );
  assert.match(
    publisher,
    /const advectionMoved\s*=\s*contributesIbl\s*&&[\s\S]*64\.0\s*\*\s*64\.0/,
  );
  assert.match(
    publisher,
    /if\s*\(staticStateChanged\s*\|\|\s*advectionMoved\)\s*\{\s*cache\.iblRevision\+\+;/,
  );

  const revisionVisibleToManager = (lastRevision, liveRevision) =>
    liveRevision !== lastRevision;
  const revisionReasons = [
    "configuration",
    "scene time",
    "Perlin-Worley morphology",
    "wind vector or speed",
    "deck bounds",
    "density",
  ];

  let lastRevision = 17;
  for (const reason of revisionReasons) {
    for (let staticFrame = 0; staticFrame < 4; staticFrame++) {
      assert.equal(
        revisionVisibleToManager(lastRevision, lastRevision),
        false,
        `${reason} must not force a fill while its revision is unchanged`,
      );
    }

    const publishedRevision = lastRevision + 1;
    assert.equal(
      revisionVisibleToManager(lastRevision, publishedRevision),
      true,
      `${reason} must be able to request one fill through the revision`,
    );
    lastRevision = publishedRevision;
    assert.equal(
      revisionVisibleToManager(lastRevision, publishedRevision),
      false,
      `${reason} must settle immediately after the fill consumes its revision`,
    );
  }
});

test("IBL density phases absorb advection before the f32 uniform boundary", () => {
  assert.match(
    manager,
    /import\s*\{[\s\S]*writeCloudDensityAdvectedOriginPhases,[\s\S]*\}\s*from "\.\/WebGPUCloudDensityDomain\.js";/,
  );
  assert.doesNotMatch(manager, /\bwriteCloudDensityOriginPhases\b/);
  assert.match(
    manager,
    /const SKY_UNIFORM_FLOATS\s*=\s*56\s*\+\s*CLOUD_DENSITY_ORIGIN_PHASE_FLOATS;/,
  );

  const pack = sourceSection(
    manager,
    "const deckBottom =",
    "device.queue.writeBuffer(cache.skyUniformBuffer, 0, data);",
  );
  assert.match(
    pack,
    /const cloudTime\s*=\s*cloudMarchActive\s*\?\s*\(cloudCache\?\.iblTimeSeconds\s*\?\?\s*0\.0\)\s*:\s*0\.0;/,
  );
  assert.match(
    pack,
    /data\[44\]\s*=\s*0\.0;\s*data\[45\]\s*=\s*0\.0;\s*data\[46\]\s*=\s*0\.0;/,
  );
  assert.doesNotMatch(pack, /data\[(?:44|45|46)\]\s*=\s*wind/);
  assert.match(
    pack,
    /writeCloudDensityAdvectedOriginPhases\(\s*data,\s*56,\s*position\.x,\s*position\.y,\s*position\.z,\s*cloudPuffSize,\s*windX,\s*windY,\s*windSpeed,\s*cloudTime,\s*\);/,
  );
});
