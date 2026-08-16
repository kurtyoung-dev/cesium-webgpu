// @purpose Source-anchored guard that WebGPUDynamicEnvironmentMapManager and the procedural cloud renderer keep the IBL revision handshake wired (CRLF-safe).
// @status ACTIVE

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
// Multi-line source anchors below are written with LF. Normalize the checkout's
// line endings so the spec is not silently CRLF-sensitive on Windows working
// trees (it was failing there for exactly that reason, unrelated to the
// behaviour under test).
const readNormalized = (file) =>
  fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const manager = readNormalized(managerPath);
const cloudRenderer = readNormalized(cloudRendererPath);

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
    // End the slice on a declaration rather than on comment prose: a comment
    // can be reworded, a declaration is what the comment-only gate holds
    // byte-identical.
    "const sceneCaptureEnabled =",
  );
  assert.match(refreshGate, /iblRevision\?:\s*number/);
  assert.match(
    refreshGate,
    /const liveCloudRevision\s*=\s*liveCloudState\?\.iblRevision\s*\?\?\s*0;/,
  );
  assert.match(
    refreshGate,
    /const cloudRevisionChanged\s*=\s*\(wantMarch\s*\|\|\s*cache\.lastUsedCloudMarch\)\s*&&\s*liveCloudRevision\s*!==\s*cache\.lastCloudRevision;/,
  );

  // C11-193 (Batch 782) hoisted the dirty predicate into `refreshRequested` so
  // the context-owned bounded drain can see the same condition the refresh body
  // used to be inlined under. The block asserted below therefore spans the
  // predicate AND the granted branch; the ordering contracts are unchanged.
  const fillBlock = sourceSection(
    manager,
    "const refreshRequested =\n    cache.needsUpdate ||",
    "// Expose cubemap + prefiltered IBL views for shader consumption.",
  );
  assert.match(fillBlock, /\|\|\s*cloudRevisionChanged\s*\|\|/);

  const fillIndex = fillBlock.indexOf("runProceduralSkyFill(");
  const prefilterIndex = fillBlock.indexOf("runIBLPrefilter(");
  const projectionIndex = fillBlock.indexOf("runSphericalHarmonicProjection(");
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

test("cloud revisions refresh only a current or previous full reflection march", () => {
  const revisionRequestsFill = ({
    wantMarch,
    lastUsedCloudMarch,
    liveRevision,
    lastRevision,
  }) => (wantMarch || lastUsedCloudMarch) && liveRevision !== lastRevision;

  const cases = [
    {
      name: "static opt-out",
      wantMarch: false,
      lastUsedCloudMarch: false,
      liveRevision: 11,
      lastRevision: 11,
      expected: false,
    },
    {
      name: "animated opt-out",
      wantMarch: false,
      lastUsedCloudMarch: false,
      liveRevision: 12,
      lastRevision: 11,
      expected: false,
    },
    {
      name: "active full march",
      wantMarch: true,
      lastUsedCloudMarch: true,
      liveRevision: 12,
      lastRevision: 11,
      expected: true,
    },
    {
      name: "first opt-in consumes deferred revision",
      wantMarch: true,
      lastUsedCloudMarch: false,
      liveRevision: 19,
      lastRevision: 11,
      expected: true,
    },
    {
      name: "ON-to-OFF teardown consumes final revision",
      wantMarch: false,
      lastUsedCloudMarch: true,
      liveRevision: 20,
      lastRevision: 19,
      expected: true,
    },
    {
      name: "settled teardown",
      wantMarch: false,
      lastUsedCloudMarch: false,
      liveRevision: 20,
      lastRevision: 20,
      expected: false,
    },
  ];

  for (const fixture of cases) {
    assert.equal(revisionRequestsFill(fixture), fixture.expected, fixture.name);
  }

  for (let liveRevision = 1; liveRevision <= 100; liveRevision++) {
    assert.equal(
      revisionRequestsFill({
        wantMarch: false,
        lastUsedCloudMarch: false,
        liveRevision,
        lastRevision: 0,
      }),
      false,
      `opted-out animation revision ${liveRevision} must remain inert`,
    );
  }
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
