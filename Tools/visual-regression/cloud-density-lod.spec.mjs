// @purpose Pins LOD agreement across CloudDensityDomain.wgsl, ProceduralClouds.wgsl and ProceduralSkyCubemap.wgsl via direct source reads.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultVariant } from "./lib/wgsl-variant.mjs";

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

// The march source the renderer compiles: the modules its
// `PROCEDURAL_CLOUDS_SOURCE` template joins, in its order, each read from the
// `.wgsl` behind the generated module it imports. Read out of the renderer
// rather than listed here, so a module the renderer adds or reorders reaches
// naga without an edit to this spec.
function rendererMarchSource() {
  const renderer = fs
    .readFileSync(
      path.join(
        root,
        "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
      ),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  const template = renderer.match(
    /const PROCEDURAL_CLOUDS_SOURCE = `([^`]*)`;/,
  );
  assert.ok(template, "the renderer's PROCEDURAL_CLOUDS_SOURCE composition");
  const names = [...template[1].matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  assert.ok(names.includes("ProceduralCloudsWGSL"), "the march module");
  assert.equal(
    template[1],
    names.map((name) => `\${${name}}`).join("\\n"),
    "the composition joins whole modules with newlines only",
  );
  return names
    .map((name) => {
      const imported = renderer.match(
        new RegExp(
          `import ${name} from "\\.\\./\\.\\./(Shaders/[\\w/]+)\\.js";`,
        ),
      );
      assert.ok(imported, `the renderer imports ${name} as a shader module`);
      return fs
        .readFileSync(
          path.join(root, "packages/engine/Source", `${imported[1]}.wgsl`),
          "utf8",
        )
        .replace(/\r\n/g, "\n");
    })
    .join("\n");
}

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
      mipLevel(footprint, domain.scale, domain.resolution, domain.levels),
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
  assert.match(cloudSource, /coordinates\.detail[\s\S]*sample\.detailMipLevel/);

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

// The view march's density LOD, EXECUTED out of the shipped sources: the mip
// law (`cloudNoiseMipLevel` + `cloudDensityMipLevels`), the footprint helpers
// and interval lattice in CloudMarchSampling.wgsl, and the march's own
// call-site argument to `cloudMacroSampleAt`. The two regimes are the landing
// rigs': E-O (nadir orbital full disc, 6,608 km, 2,048 px square, fov 60 deg)
// and E-G (800 m under the 1,500-4,000 m deck, 1024x768, fov 60 deg wide).
const cloudSamplingSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudMarchSampling.wgsl",
  ),
  "utf8",
);
const cloudMini = await import("./lib/wgsl-mini-eval.mjs");

// WGSL allows a trailing comma in an argument list; the evaluator does not.
const evaluable = (source) =>
  cloudMini
    .stripComments(source.replace(/\r\n/g, "\n"))
    .replace(/,(\s*\))/g, "$1");

function densityLodLaw(samplingSource, marchSource) {
  const march = evaluable(marchSource);
  const constants = cloudMini.readConstants(
    evaluable(domainSource)
      .split("\n")
      .filter((line) =>
        /^const CLOUD_DENSITY_(WORLD_TO_NOISE|WARP_RATIO|DETAIL_RATIO):/.test(
          line,
        ),
      )
      .join("\n"),
  );
  // The legacy/LIVE guard is pinned by the escape-route test above; the route
  // under test is the planet-domain baked one after it (`!` is outside the
  // evaluator's subset), so the guard is cut by exact text, once.
  const guard =
    /if \(!planetDensityEnabled\(\) \|\| !noiseBakedEnabled\(\)\) \{\s*return CloudNoiseMipLevels\(0\.0, 0\.0, 0\.0\);\s*\}/;
  assert.match(march, guard);
  const globals = {
    ...constants,
    cloud: { puffSize: 0.45 },
    cloudShapeTex: "shape",
    cloudDetailTex: "detail",
    __functions: {
      exp: Math.exp,
      textureDimensions: (t) => cloudMini.vec(t === "shape" ? 128 : 32, 0, 0),
      textureNumLevels: (t) => (t === "shape" ? 8 : 6),
      CloudNoiseMipLevels: (shape, warp, detail) => ({ shape, warp, detail }),
    },
  };
  globals.__functions.cloudNoiseMipLevel = cloudMini.compileFunction(
    march,
    "cloudNoiseMipLevel",
    globals,
  );
  const mips = cloudMini.compileFunction(
    march.replace(guard, ""),
    "cloudDensityMipLevels",
    globals,
  );
  const sampling = evaluable(samplingSource);
  for (const name of [
    "cloudViewPixelFootprint",
    "cloudDensityLodFootprint",
    "cloudMarchIntervalBoundary",
  ]) {
    globals.__functions[name] = cloudMini.compileFunction(
      sampling,
      name,
      globals,
    );
  }
  // The march's own footprint argument: the last argument of its
  // `macroSample = cloudMacroSampleAt(...)` call, parsed and evaluated.
  const marchBody = march.slice(march.indexOf("fn marchDeck("));
  const open = marchBody.indexOf(
    "(",
    marchBody.indexOf("macroSample = cloudMacroSampleAt("),
  );
  let depth = 0;
  let close = open;
  let lastComma = open;
  for (; close < marchBody.length; close++) {
    const ch = marchBody[close];
    if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      break;
    } else if (ch === "," && depth === 1) {
      lastComma = close;
    }
  }
  const argument = cloudMini.parseExpression(
    cloudMini.tokenize(marchBody.slice(lastComma + 1, close)),
    0,
  ).node;
  const boundary = globals.__functions.cloudMarchIntervalBoundary;
  return {
    pixelFootprint: globals.__functions.cloudViewPixelFootprint,
    mips,
    // Every interval midpoint of one ray on the shipped lattice (step growth
    // 1, the default: growth exponent 0), with the mips the march selects there.
    ray(tStart, tEnd, steps, scale, resolution) {
      const chord = tEnd - tStart;
      const projection = new Array(16).fill(0);
      projection[5] = scale;
      const out = [];
      for (let k = 0; k < steps; k++) {
        const b0 = boundary(k, steps, chord, tStart, 2500, 0);
        const b1 = boundary(k + 1, steps, chord, tStart, 2500, 0);
        const sampleDistance = tStart + 0.5 * (b0 + b1);
        const footprint = cloudMini.evaluate(argument, {
          ...globals,
          sampleDistance,
          curFineStep: b1 - b0,
          cloud: {
            inverseProjection: cloudMini.mat4(projection),
            resolution: cloudMini.vec2(resolution, resolution),
          },
        });
        out.push({ sampleDistance, chord, selected: mips(footprint) });
      }
      return out;
    },
  };
}

const EARTH_RADIUS = 6371000;
function orbitalRay(pixelsFromCentre) {
  // E-O: nadir camera at 6,608,426.573 m; focal 1,773.62 px on 2,048 px.
  const rc = EARTH_RADIUS + 6608426.573306667;
  const cosAngle = Math.cos(Math.atan(pixelsFromCentre / 1773.6200269505305));
  const near = (r) =>
    rc * cosAngle - Math.sqrt((rc * cosAngle) ** 2 - rc * rc + r * r);
  return [near(EARTH_RADIUS + 4000), near(EARTH_RADIUS + 1500)];
}
function groundRay(elevationDegrees) {
  // E-G: 800 m under the deck, looking up at the given elevation.
  const rc = EARTH_RADIUS + 800;
  const s = Math.sin((elevationDegrees * Math.PI) / 180);
  const far = (r) => -rc * s + Math.sqrt((rc * s) ** 2 - rc * rc + r * r);
  return [far(EARTH_RADIUS + 1500), far(EARTH_RADIUS + 4000)];
}
const TAN_HALF_FOV = Math.tan(Math.PI / 6);

/** Violations of the orbital rule: within one mip of the step-length LOD. */
function orbitalViolations(law) {
  const violations = [];
  for (const pixels of [0, 400, 800, 950]) {
    const [tStart, tEnd] = orbitalRay(pixels);
    for (const s of law.ray(tStart, tEnd, 96, TAN_HALF_FOV, 2048)) {
      // Before 3446 the march passed its fine step, (tEnd - tStart) / steps.
      const stepLength = law.mips(s.chord / 96);
      for (const domain of ["shape", "warp", "detail"]) {
        if (Math.abs(s.selected[domain] - stepLength[domain]) > 1) {
          violations.push(
            `${pixels} px at ${s.sampleDistance.toFixed(0)} m: ${domain} ${s.selected[domain].toFixed(2)} vs ${stepLength[domain].toFixed(2)}`,
          );
        }
      }
    }
  }
  return violations;
}

test("the view march's density LOD keeps the step-length mip from orbit and the pixel mip from the ground", () => {
  const law = densityLodLaw(cloudSamplingSource, cloudSource);

  // Orbit: the pixel footprint alone selects shape mip above 4.9 at every
  // nadir sample (the regime that erased the deck), while the march's own
  // argument stays within one level of the step-length LOD on every domain.
  const [nadirStart, nadirEnd] = orbitalRay(0);
  for (const s of law.ray(nadirStart, nadirEnd, 96, TAN_HALF_FOV, 2048)) {
    const pixelOnly = law.mips(
      law.pixelFootprint(s.sampleDistance, TAN_HALF_FOV, 2048),
    );
    assert.ok(pixelOnly.shape > 4.9, `pixel-only shape mip ${pixelOnly.shape}`);
    assert.equal(s.selected.shape, 0, "nadir shape mip");
  }
  assert.deepEqual(orbitalViolations(law), []);

  // Ground: wherever the pixel is finer than the interval, the march selects
  // exactly the pixel-footprint mips (the near-field detail 3446 introduced).
  const groundScale = TAN_HALF_FOV * (768 / 1024);
  for (const elevation of [2, 8, 16, 32]) {
    const [tStart, tEnd] = groundRay(elevation);
    for (const s of law.ray(tStart, tEnd, 96, groundScale, 768)) {
      assert.deepEqual(
        s.selected,
        law.mips(law.pixelFootprint(s.sampleDistance, groundScale, 768)),
        `ground ${elevation} deg at ${s.sampleDistance.toFixed(0)} m`,
      );
    }
  }
});

test("MUTANT: an unreachable clamp, or the bare pixel footprint at the call site, turns the orbital rule red", () => {
  const clamp =
    "min(cloudViewPixelFootprint(distance, projectionScale, resolution), fineStep)";
  assert.ok(cloudSamplingSource.includes(clamp), "the clamp text");
  const unreachable = cloudSamplingSource.replace(
    clamp,
    `select(${clamp}, cloudViewPixelFootprint(distance, projectionScale, resolution), 1.0 > 0.0)`,
  );
  assert.notDeepEqual(
    orbitalViolations(densityLodLaw(unreachable, cloudSource)),
    [],
  );

  const callSite =
    "cloudDensityLodFootprint(sampleDistance, cloud.inverseProjection[1].y, cloud.resolution.y, curFineStep)";
  assert.ok(cloudSource.includes(callSite), "the call-site text");
  const bare = cloudSource.replace(
    callSite,
    "cloudViewPixelFootprint(sampleDistance, cloud.inverseProjection[1].y, cloud.resolution.y)",
  );
  assert.notDeepEqual(
    orbitalViolations(densityLodLaw(cloudSamplingSource, bare)),
    [],
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
  // C13-06 moved the live shadow route onto the camera-relative density twin
  // and named its deck bounds; both branches still supply the sun-march step as
  // the LOD footprint, which is what this row pins.
  assert.match(
    shadowBody,
    /cloudDensityRelativeWithFootprint\([\s\S]*deckTop,\s*\n?\s*stepSize/,
  );
  assert.match(
    shadowBody,
    /cloudDensityWithFootprint\([\s\S]*deckTop,\s*\n?\s*stepSize/,
  );

  assert.match(iblSource, /fn cloudDensityIBL\([\s\S]*footprintMeters:\s*f32/);
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
  // C13-10 — naga must see what the PIPELINE compiles: the cloud march now
  // carries a `//>>ifdef` variant, so its raw text holds both branches at once
  // and is not valid WGSL alone. `defaultVariant` is the engine preprocessor at
  // `definesHi = 0`, and a no-op for a directive-free shader. The visible march
  // is the renderer's whole composition (`rendererMarchSource`), because the
  // march calls helpers that live in its sibling modules
  // (`cloudMarchIntervalBoundary` in `CloudMarchSampling.wgsl`).
  assert.doesNotThrow(() =>
    naga.validate_wgsl(defaultVariant(rendererMarchSource())),
  );
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${domainSource}\n${defaultVariant(iblSource)}`),
  );
});
