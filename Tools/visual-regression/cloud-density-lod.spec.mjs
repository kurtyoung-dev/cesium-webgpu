import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const domainSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  ),
  "utf8",
);
const cloudSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  ),
  "utf8",
);
const iblSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
  ),
  "utf8",
);

function mipLevel(
  footprintMeters,
  domainUnitsPerMeter,
  baseResolution,
  levelCount,
  enabled = true,
) {
  if (!enabled) {
    return 0.0;
  }
  const coveredVoxels =
    Math.max(footprintMeters, 0.0) *
    Math.abs(domainUnitsPerMeter) *
    baseResolution;
  return Math.min(
    Math.max(Math.log2(Math.max(coveredVoxels, 1.0)) - 1.0, 0.0),
    levelCount - 1,
  );
}

test("footprint LOD begins after two voxels, is monotonic, and clamps", () => {
  const worldToNoise = 0.0003000000142492354;
  const puffSize = 0.45;
  const domains = [
    {
      name: "shape",
      scale: worldToNoise * puffSize,
      resolution: 128,
      levels: 8,
    },
    {
      name: "warp",
      scale: worldToNoise * puffSize * (1.0 / Math.PI),
      resolution: 32,
      levels: 6,
    },
    {
      name: "detail",
      scale: worldToNoise * (3.5 * Math.SQRT2),
      resolution: 32,
      levels: 6,
    },
  ];

  for (const domain of domains) {
    const voxelMeters = 1.0 / (domain.scale * domain.resolution);
    assert.equal(
      mipLevel(
        voxelMeters * 2.0,
        domain.scale,
        domain.resolution,
        domain.levels,
      ),
      0.0,
      `${domain.name} must retain LOD 0 through two voxels`,
    );
    assert.ok(
      mipLevel(
        voxelMeters * 4.0,
        domain.scale,
        domain.resolution,
        domain.levels,
      ) > 0.99,
      `${domain.name} must begin filtering after two voxels`,
    );

    const footprints = [0, 5, 25, 100, 500, 2_500, 25_000, 1_000_000];
    const levels = footprints.map((footprint) =>
      mipLevel(
        footprint,
        domain.scale,
        domain.resolution,
        domain.levels,
      ),
    );
    for (let index = 1; index < levels.length; index++) {
      assert.ok(
        levels[index] >= levels[index - 1],
        `${domain.name} LOD must be monotonic`,
      );
    }
    assert.ok(levels.every((level) => level >= 0));
    assert.ok(levels.every((level) => level <= domain.levels - 1));
    assert.equal(levels.at(-1), domain.levels - 1);
  }
});

test("legacy and LIVE paths retain an exact level-zero escape route", () => {
  for (const footprint of [0, 100, 10_000, 1_000_000]) {
    assert.equal(mipLevel(footprint, 0.001, 128, 8, false), 0.0);
  }

  assert.match(
    cloudSource,
    /fn cloudDensityMipLevels\([\s\S]*if \(!planetDensityEnabled\(\) \|\| !noiseBakedEnabled\(\)\)\s*\{\s*return CloudNoiseMipLevels\(0\.0, 0\.0, 0\.0\)/,
  );
  const macroBody = cloudSource.slice(
    cloudSource.indexOf("fn cloudMacroSampleAt("),
    cloudSource.indexOf("fn cloudBaseFromMacro("),
  );
  assert.match(
    macroBody,
    /var mipLevels = CloudNoiseMipLevels\(0\.0, 0\.0, 0\.0\)[\s\S]*if \(noiseBakedEnabled\(\)\)\s*\{\s*mipLevels = cloudDensityMipLevels\(footprintMeters\)/,
  );
  assert.match(
    macroBody,
    /else\s*\{\s*density = fbmNoise\(coordinates\.canonical\)/,
  );
});

test("visible base and erosion share one bundled footprint evaluation", () => {
  assert.match(
    cloudSource,
    /struct CloudNoiseMipLevels\s*\{[\s\S]*shape:\s*f32[\s\S]*warp:\s*f32[\s\S]*detail:\s*f32/,
  );
  assert.match(
    cloudSource,
    /fn bakedBase\([\s\S]*mipLevels:\s*CloudNoiseMipLevels[\s\S]*coordinates\.warp,\s*mipLevels\.warp[\s\S]*uvw,\s*mipLevels\.shape/,
  );
  assert.match(
    cloudSource,
    /return CloudMacroSample\([\s\S]*mipLevels\.detail/,
  );
  assert.match(
    cloudSource,
    /coordinates\.detail[\s\S]*sample\.detailMipLevel/,
  );

  const marchBody = cloudSource.slice(
    cloudSource.indexOf("fn marchDeck("),
    cloudSource.indexOf("@fragment\nfn fragmentMain"),
  );
  assert.match(
    marchBody,
    /sampleDistance = t \+ marchSamplePhase \* curStep[\s\S]*sampleOffset = rayDir \* sampleDistance/,
  );
  assert.match(
    marchBody,
    /cloudMacroSampleAt\([\s\S]*heightFraction,[\s\S]*deckBottom,[\s\S]*deckTop,[\s\S]*curFineStep/,
  );
  assert.match(
    marchBody,
    /base = cloudBaseFromMacro\(macroSample\)[\s\S]*density = cloudDensityFromMacro\(macroSample, heightFraction\)/,
  );
});

test("light, shadow, and IBL marches supply their represented intervals", () => {
  const coneBody = cloudSource.slice(
    cloudSource.indexOf("fn lightMarchCone("),
    cloudSource.indexOf("fn lightMarch("),
  );
  assert.match(
    coneBody,
    /cloudDensityAtCoordinates\([\s\S]*hf,[\s\S]*deckBottom,[\s\S]*deckTop,[\s\S]*coneStepBase/,
  );
  assert.match(
    coneBody,
    /cloudMacroSampleAt\([\s\S]*farHf,[\s\S]*deckBottom,[\s\S]*deckTop,[\s\S]*coneStepBase \* 3\.0/,
  );
  assert.doesNotMatch(coneBody, /tapFootprint|max\(coneStepBase, coneRadius\)/);

  const straightBody = cloudSource.slice(
    cloudSource.indexOf("fn lightMarch("),
    cloudSource.indexOf("fn effectiveAbsorption("),
  );
  assert.match(
    straightBody,
    /cloudDensityAtCoordinates\([\s\S]*hf,[\s\S]*deckBottom,[\s\S]*deckTop,[\s\S]*stepSize/,
  );

  const shadowBody = cloudSource.slice(
    cloudSource.indexOf("fn cloudShadowMain("),
  );
  assert.match(
    shadowBody,
    /cloudDensityWithFootprint\([\s\S]*cloud\.cloudLayerTop,\s*stepSize/,
  );

  assert.match(
    iblSource,
    /fn cloudDensityIBL\([\s\S]*footprintMeters:\s*f32/,
  );
  assert.match(iblSource, /cloudDensityIBL\(sp, hf, stepLen\)/);
  assert.match(iblSource, /cloudDensityIBL\(p, hf, stepLen\)/);
  assert.match(
    iblSource,
    /struct CloudNoiseMipLevelsIBL\s*\{[\s\S]*shape:\s*f32[\s\S]*warp:\s*f32[\s\S]*detail:\s*f32/,
  );
});

test("visible and IBL density shaders remain valid WGSL with shared domain", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${cloudSource}`),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${iblSource}`),
  );
});
