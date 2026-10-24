// water-flight-surface-regimes.spec.mjs
// @purpose Verifies Phase 3 In-Flight & Sea-Level water regimes: [3000m, 12000m] altitude handover, shore-normal surf rollers, Toksvig specular AA, intertidal thin-film wet sand, and FFT wave-crest SSS.
// @status ACTIVE
//
// Tests 1-6 are text tripwires on shader source (they keep passing if a pinned helper is left defined but uncalled); tests 7 and 8 pin the call sites of the flight handover and the surf rollers and run against a copy with those call sites removed (water-spec-mutants.mjs).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  preprocess,
  ShaderDefine,
  readEngineShader,
} from "./lib/wgsl-variant.mjs";
import {
  assertCallSiteLive,
  assertInertnessMutantTurnsRed,
  stripUses,
} from "./water-spec-mutants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("Phase 3 — In-Flight & Sea-Level Regimes: Handover, Surf Swash, Toksvig Specular AA, and Wave-Crest SSS", () => {
  it("1. GlobeTerrain.wgsl and OceanSurface.wgsl share the [3000m, 12000m] flight-to-surface handover window", () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );
    const oceanWgsl = readEngineShader(
      "Shaders/WebGPU/Ocean/OceanSurface.wgsl",
    );

    assert.match(
      globeWgsl,
      /let flightToSurfaceHandover = 1\.0 - smoothstep\(3000\.0,\s*12000\.0,\s*distance\);/,
      "GlobeTerrain.wgsl must define flightToSurfaceHandover over [3000, 12000] m",
    );
    assert.match(
      oceanWgsl,
      /let altitudeHandover = 1\.0 - smoothstep\(3000\.0,\s*12000\.0,\s*eyeDist\);/,
      "OceanSurface.wgsl must define altitudeHandover over [3000, 12000] m",
    );
  });

  it("2. GlobeTerrain.wgsl implements shore-propagating surf rollers, Toksvig normal-variance specular AA, and intertidal thin-film wet sand", () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );

    assert.match(
      globeWgsl,
      /fn computeShoreSurfRollersAndSwash\(/,
      "GlobeTerrain.wgsl must define computeShoreSurfRollersAndSwash",
    );
    assert.match(
      globeWgsl,
      /let surfCoord = \(1\.0 - waterMaskValue\) \* 42\.0;/,
      "Surf rollers must propagate shoreward along the coastal SDF gradient",
    );
    assert.match(
      globeWgsl,
      /let normalVariance = clamp\(uvFootprint \* uvFootprint \* 2\.5e9,\s*0\.0,\s*0\.22\);/,
      "GlobeTerrain.wgsl must compute UV-footprint normal variance for Toksvig AA",
    );
    assert.match(
      globeWgsl,
      /toksvigSpecScale = 1\.0 \/ \(1\.0 \+ normalVariance \* 4\.5\);/,
      "GlobeTerrain.wgsl must attenuate near-surface specular aliasing via toksvigSpecScale",
    );
    assert.match(
      globeWgsl,
      /let thinFilmSpec =\s*\n?\s*pow\(max\(dot\(reflect\(-sunDir,\s*dayNightNormalEC\),\s*viewDir\),\s*0\.0\),\s*48\.0\)/,
      "Intertidal swash zone must include thin-film water specular glisten",
    );
  });

  it("3. OceanSurface.wgsl implements wave-crest turquoise subsurface scattering and passes Naga for both default and LOG_DEPTH variants", async () => {
    const oceanWgsl = readEngineShader(
      "Shaders/WebGPU/Ocean/OceanSurface.wgsl",
    );

    assert.match(
      oceanWgsl,
      /let crestElevation = clamp\(max\(dispCenter\.y,\s*0\.0\) \* 0\.35,\s*0\.0,\s*1\.5\);/,
      "OceanSurface.wgsl must amplify subsurface scattering in elevated wave crests",
    );
    assert.match(
      oceanWgsl,
      /vec3<f32>\(0\.05,\s*0\.25,\s*0\.35\) \* sssFactor/,
      "OceanSurface.wgsl must match GlobeTerrain.wgsl's turquoise SSS chromaticity",
    );

    const nagaDir = path.join(
      repoRoot,
      "Tools/shader-pipeline/naga-wasm-tools",
    );
    const naga = await import(
      pathToFileURL(path.join(nagaDir, "naga_wasm_tools.js")).href
    );
    await naga.default({
      module_or_path: fs.readFileSync(
        path.join(nagaDir, "naga_wasm_tools_bg.wasm"),
      ),
    });

    assert.doesNotThrow(() => {
      naga.validate_wgsl(preprocess(oceanWgsl, 0, 0));
      naga.validate_wgsl(preprocess(oceanWgsl, ShaderDefine.LOG_DEPTH, 0));
    });
  });

  it("4. evaluateShoreRefractionAndSwashOptics bends waves along -grad(SDF), injects 4.5s jade-emerald bubble plumes, and models wet-sand mirror swash (roughness=0.04, 45% darkening)", async () => {
    const { evaluateShoreRefractionAndSwashOptics } = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          "packages/engine/Source/Scene/BathymetryTensorMap.ts",
        ),
      ).href
    );

    const offshore = evaluateShoreRefractionAndSwashOptics(0.9, 0.0, 1.2, 0.5);
    const shoaling = evaluateShoreRefractionAndSwashOptics(0.5, 0.0, 1.2, 0.5);
    assert.ok(
      Math.abs(shoaling.refractedWaveAzimuthRad) <
        Math.abs(offshore.refractedWaveAzimuthRad),
      "Wave propagation azimuth must refract toward shore-normal (-grad SDF) as shoreSdf approaches 0.50",
    );
    assert.ok(
      shoaling.subsurfaceBubblePlumeIntensity > 0.2 &&
        shoaling.subsurfaceBubbleColor.g > shoaling.subsurfaceBubbleColor.r,
      "Breaking surf zone must inject jade-emerald subsurface aerated bubble plumes",
    );

    const freshSwash = evaluateShoreRefractionAndSwashOptics(
      0.45,
      0.0,
      0.5,
      0.0,
    );
    assert.ok(
      Math.abs(freshSwash.wetSandRoughness - 0.04) < 1e-4 &&
        Math.abs(freshSwash.wetSandAlbedoScale - 0.55) < 1e-4,
      "Newly inundated beach swash must reach mirror roughness 0.04 and 45% albedo darkening (0.55 scale)",
    );
  });

  it("5. evaluatePolarSeaIceAndGlacialOptics transitions frazil slush -> Voronoi pancake floes -> pack ice above 62 deg and models Jerlov 7C glacial rock-flour plumes", async () => {
    const { PolarSeaIceRegime, evaluatePolarSeaIceAndGlacialOptics } =
      await import(
        pathToFileURL(
          path.join(
            repoRoot,
            "packages/engine/Source/Scene/BathymetryTensorMap.ts",
          ),
        ).href
      );

    const tropical = evaluatePolarSeaIceAndGlacialOptics(
      (20.0 * Math.PI) / 180.0,
    );
    assert.equal(tropical.iceRegime, PolarSeaIceRegime.OPEN_WATER);
    assert.equal(tropical.iceConcentration, 0.0);

    const fjordSubpolar = evaluatePolarSeaIceAndGlacialOptics(
      (58.0 * Math.PI) / 180.0,
      0.0,
      0.52,
    );
    assert.ok(
      fjordSubpolar.glacialFlourTurbidity > 0.3 &&
        fjordSubpolar.glacialPlumeColor.b > fjordSubpolar.glacialPlumeColor.r,
      "High-latitude coastal fjords must emit milky-cyan Jerlov 7C glacial rock-flour plumes",
    );

    const pancakeZone = evaluatePolarSeaIceAndGlacialOptics(
      (68.0 * Math.PI) / 180.0,
      0.0,
      0.8,
      0.02,
      0.5,
    );
    assert.equal(pancakeZone.iceRegime, PolarSeaIceRegime.PANCAKE_ICE_FLOES);
    assert.ok(pancakeZone.capillaryWaveDamping > 0.4);

    const highArctic = evaluatePolarSeaIceAndGlacialOptics(
      (82.0 * Math.PI) / 180.0,
    );
    assert.equal(highArctic.iceRegime, PolarSeaIceRegime.CONSOLIDATED_PACK_ICE);
    assert.ok(highArctic.iceAlbedo.b > 0.85);
  });

  it("6. evaluateKelvinWakeAndBuoyancyQuery evaluates up to 64 Gerstner-inverted slots and stamps the 19.47 deg Kelvin V-wake", async () => {
    const { evaluateKelvinWakeAndBuoyancyQuery } = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          "packages/engine/Source/Scene/BathymetryTensorMap.ts",
        ),
      ).href
    );

    // 70 queries -> clamped to 64 slots
    const queries = Array.from({ length: 70 }, (_, i) => ({
      x: -i * 2.0,
      y: i * 2.0 * Math.tan(Math.asin(1.0 / 3.0)), // Right along the 19.47 deg Kelvin cusp line!
    }));
    const slots = evaluateKelvinWakeAndBuoyancyQuery(
      queries,
      { x: 0.0, y: 0.0, vx: 10.0, vy: 0.0, lengthMeters: 20.0 },
      {
        amplitudeMeters: 1.0,
        wavelengthMeters: 40.0,
        directionRad: 0.0,
        timeSeconds: 1.5,
      },
    );
    assert.equal(
      slots.length,
      64,
      "WaterQuery batch must cap at 64 slots per frame",
    );
    assert.ok(
      slots[5].kelvinWakeFoam > 0.2 &&
        Math.abs(slots[5].kelvinWakeDisplacementMeters) > 0.01,
      "Points along the 19.47 deg (arcsin(1/3)) stern Kelvin cusp must receive wake displacement and foam",
    );
  });

  // Tests 1 and 2 are text tripwires: a regex that matches a definition keeps matching
  // after every use of it is deleted. These two pin the call sites, and each is run
  // against a copy whose call sites were removed, which must turn it red.
  it("7. inertness: the flight-to-surface handover is read by the surface shader, and the check goes red when it is not", () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );
    assertInertnessMutantTurnsRed(
      "flight-to-surface handover",
      globeWgsl,
      (text) => stripUses(text, "flightToSurfaceHandover", "0.0"),
      (text) =>
        assertCallSiteLive(
          text,
          "flightToSurfaceHandover",
          "flight-to-surface handover",
        ),
    );
  });

  it("8. inertness: the shore surf rollers are called by the surface shader, and the check goes red when the call is removed", () => {
    const globeWgsl = readEngineShader(
      "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    );
    assertInertnessMutantTurnsRed(
      "shore surf rollers and swash",
      globeWgsl,
      (text) =>
        stripUses(text, "computeShoreSurfRollersAndSwash", "vec4<f32>(0.0)", {
          call: true,
        }),
      (text) =>
        assertCallSiteLive(
          text,
          "computeShoreSurfRollersAndSwash",
          "shore surf rollers and swash",
          { call: true },
        ),
    );
  });
});
