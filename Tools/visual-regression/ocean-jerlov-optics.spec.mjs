// ocean-jerlov-optics.spec.mjs — verification spec for Jerlov spectral ocean optics.
// @purpose Verifies Jerlov ocean optical model extinction coefficients, optical path length, spectral transmittance monotonicity, bathymetric depth attenuation, and WGSL shader parity.
// @status ACTIVE
//
// Pins the Jerlov water column optical model and bathymetric extinction
// for whole-earth ocean rendering.
//
// Run: node --test Tools/visual-regression/ocean-jerlov-optics.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { compileFunction, stripComments, vec2 } from "./lib/wgsl-mini-eval.mjs";
import {
  ShaderDefineHi,
  defaultVariant,
  hiVariant,
} from "./lib/wgsl-variant.mjs";
import { readEngineShader } from "./lib/engine-shader-source.mjs";

function readGlobeWgsl() {
  return readEngineShader("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
}

test("1. Jerlov extinction coefficients match Type IB ocean classification", () => {
  const wgsl = readGlobeWgsl();
  const match =
    /let\s+jerlovExtinction\s*=\s*vec3<f32>\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\);/m.exec(
      wgsl,
    );
  assert.ok(
    match,
    "jerlovExtinction vector must be declared in GlobeTerrain.wgsl",
  );
  const cR = parseFloat(match[1]);
  const cG = parseFloat(match[2]);
  const cB = parseFloat(match[3]);

  // Jerlov Type IB published coefficients
  assert.equal(cR, 0.045, "Red extinction coefficient must equal 0.045 m^-1");
  assert.equal(cG, 0.015, "Green extinction coefficient must equal 0.015 m^-1");
  assert.equal(cB, 0.008, "Blue extinction coefficient must equal 0.008 m^-1");

  // Spectral selectivity: Red attenuates faster than green, which attenuates faster than blue
  assert.ok(cR > cG, "Red must extinguish faster than green");
  assert.ok(cG > cB, "Green must extinguish faster than blue");
});

test("2. Transmittance obeys Beer-Lambert exponential decay and monotonicity", () => {
  const cR = 0.045;
  const cG = 0.015;
  const cB = 0.008;

  function transmittance(depth, cosView = 1.0, cosSun = 1.0) {
    const opticalPath =
      depth * (1.0 / Math.max(cosView, 0.1) + 1.0 / Math.max(cosSun, 0.1));
    return [
      Math.exp(-cR * opticalPath),
      Math.exp(-cG * opticalPath),
      Math.exp(-cB * opticalPath),
    ];
  }

  // At depth 0, transmittance must be exactly 1 across all channels
  const t0 = transmittance(0.0);
  assert.equal(t0[0], 1.0);
  assert.equal(t0[1], 1.0);
  assert.equal(t0[2], 1.0);

  // Strict monotonicity across depth
  const depths = [1, 5, 10, 25, 50, 100, 200];
  for (let i = 0; i < depths.length - 1; i++) {
    const tNear = transmittance(depths[i]);
    const tFar = transmittance(depths[i + 1]);
    assert.ok(
      tNear[0] > tFar[0],
      `Red transmittance must decrease from ${depths[i]}m to ${depths[i + 1]}m`,
    );
    assert.ok(
      tNear[1] > tFar[1],
      `Green transmittance must decrease from ${depths[i]}m to ${depths[i + 1]}m`,
    );
    assert.ok(
      tNear[2] > tFar[2],
      `Blue transmittance must decrease from ${depths[i]}m to ${depths[i + 1]}m`,
    );
  }

  // At shallow water (5m, nadir view/sun):
  // Red has attenuated measurably (~36%), while Blue is almost fully preserved (~92%)
  const t5 = transmittance(5.0);
  assert.ok(t5[0] < 0.7, "Red should be significantly extinguished at 5m");
  assert.ok(t5[2] > 0.9, "Blue should remain largely unattenuated at 5m");

  // At deep water (100m):
  // Red is completely extinguished (< 0.001)
  const t100 = transmittance(100.0);
  assert.ok(t100[0] < 0.001, "Red must be fully extinguished at 100m");
});

test("3. Optical path length increases at oblique grazing angles", () => {
  const c = 0.015;
  const depth = 20.0;
  const tNadir = Math.exp(-c * depth * (1.0 / 1.0 + 1.0 / 1.0)); // cos = 1.0
  const tGrazing = Math.exp(-c * depth * (1.0 / 0.2 + 1.0 / 0.2)); // cos = 0.2 (steep angle)

  assert.ok(
    tGrazing < tNadir,
    "Grazing angles must produce greater optical path extinction than nadir",
  );
});

test("4. Water body color transitions smoothly from shallow turquoise to abyssal deepColor", () => {
  const shallowColor = [0.05, 0.25, 0.35];
  const deepColor = [0.008, 0.045, 0.12];

  function waterBody(depth) {
    const blend = 1.0 - Math.exp(-0.04 * depth);
    return [
      shallowColor[0] * (1.0 - blend) + deepColor[0] * blend,
      shallowColor[1] * (1.0 - blend) + deepColor[1] * blend,
      shallowColor[2] * (1.0 - blend) + deepColor[2] * blend,
    ];
  }

  // At 1m, color is very close to shallow turquoise
  const w1 = waterBody(1.0);
  assert.ok(
    Math.abs(w1[1] - shallowColor[1]) < 0.05,
    "1m depth should retain shallow emerald tint",
  );

  // At 200m, color has converged to abyssal deepColor within 0.1%
  const w200 = waterBody(200.0);
  assert.ok(
    Math.abs(w200[0] - deepColor[0]) < 0.001,
    "200m depth should converge to deep red channel",
  );
  assert.ok(
    Math.abs(w200[1] - deepColor[1]) < 0.001,
    "200m depth should converge to deep green channel",
  );
  assert.ok(
    Math.abs(w200[2] - deepColor[2]) < 0.001,
    "200m depth should converge to deep blue channel",
  );
});

test("5. Bathymetric depth resolution correctly maps negative bed heights", () => {
  // In Cesium bathymetry, elevation below sea level is negative:
  const bedElevation = -42.5;
  const resolvedDepth = bedElevation < 0.0 ? -bedElevation : 100.0;
  assert.equal(
    resolvedDepth,
    42.5,
    "Negative terrain bed elevation must map to positive water column depth",
  );

  // Above or at sea level, depth defaults to deep water fallback (100.0m)
  const landElevation = 15.0;
  const landDepth = landElevation < 0.0 ? -landElevation : 100.0;
  assert.equal(
    landDepth,
    100.0,
    "Non-bathymetric ocean terrain must default to nominal 100m deep water",
  );
});

/**
 * The bed height the fragment hands `computeEnhancedOcean`, EXECUTED out of the
 * shader: the call's last argument names a binding, and that binding's own
 * statements are run for a fragment at `(u, v)` with terrain height `height`.
 * Returns null when the call site does not pass a binding derived from
 * `input.v_height`, so a caller that stops forwarding the bed reads as a
 * failure rather than as a skipped check.
 */
function bedHeightReachingOcean(wgsl, u, v, height) {
  const call =
    /let\s+oceanColor\s*=\s*computeEnhancedOcean\s*\([\s\S]*?input\.v_distance\s*,\s*(\w+)\s*\);/.exec(
      wgsl,
    );
  if (!call) {
    return null;
  }
  const name = call[1];
  const edge = /let\s+tileEdgeDist\s*=[^;]+;/.exec(wgsl);
  const binding = new RegExp(`let\\s+${name}\\s*=[\\s\\S]*?\\);`).exec(wgsl);
  if (!edge || !binding) {
    return null;
  }
  const source = stripComments(
    `fn probe() -> f32 {\n${edge[0]}\n${binding[0]}\nreturn ${name};\n}`,
  ).replace(/,(\s*\))/g, "$1"); // the evaluator reads WGSL without its trailing commas
  const run = compileFunction(source, "probe", {
    geoUV: vec2(u, v),
    input: { v_height: height },
  });
  return run();
}

test("6. GlobeTerrain.wgsl declares bedHeight in computeEnhancedOcean signature and caller", () => {
  // The bed height is an enhanced-ocean input: since W-A1 the parameter and the
  // argument exist only in the ENHANCED_OCEAN variant (the default variant is
  // the shipped shader), so this reads the variant the enhanced pipelines compile.
  const source = readGlobeWgsl();
  const wgsl = hiVariant(source, ShaderDefineHi.ENHANCED_OCEAN);
  assert.doesNotMatch(
    stripComments(defaultVariant(source)),
    /\bbedHeight\b|\bsafeFragHeight\b/,
    "the default variant carries no bed height",
  );

  // Check signature
  assert.match(
    wgsl,
    /fn\s+computeEnhancedOcean\s*\([\s\S]*?bedHeight\s*:\s*f32[\s\S]*?\)\s*->\s*vec3<f32>/,
    "computeEnhancedOcean must declare bedHeight parameter",
  );

  // The call site forwards the fragment's terrain height: a 40 m deep bed at
  // the middle of a tile reaches the ocean as -40, a shore height as itself.
  assert.equal(bedHeightReachingOcean(wgsl, 0.5, 0.5, -40), -40);
  assert.equal(bedHeightReachingOcean(wgsl, 0.5, 0.5, 12), 12);
  // The tile-edge and deep-trench clamps keep a skirt vertex from reading as
  // an absurd bed: below the sea surface they report 0.
  assert.equal(bedHeightReachingOcean(wgsl, 0.01, 0.5, -40), 0);
  assert.equal(bedHeightReachingOcean(wgsl, 0.5, 0.5, -500), 0);

  // Inertness: a call site that stops forwarding the bed is DETECTED.
  const dropped = wgsl.replace(
    /(let\s+oceanColor\s*=\s*computeEnhancedOcean\s*\([\s\S]*?input\.v_distance\s*,\s*)\w+(\s*\);)/,
    "$10.0$2",
  );
  assert.notEqual(dropped, wgsl, "mutation precondition: the call changed");
  assert.notEqual(
    bedHeightReachingOcean(dropped, 0.5, 0.5, -40),
    -40,
    "a constant argument must not read as a forwarded bed height",
  );

  // Check live callers of getOceanDeepColor and getOceanDarkening in enhanced ocean arm
  const fnSlice = wgsl.slice(wgsl.indexOf("fn computeEnhancedOcean"));
  const enhancedArm = fnSlice.slice(0, fnSlice.indexOf("\n}\n"));
  assert.ok(
    enhancedArm.includes("getOceanDeepColor()"),
    "enhanced arm must call getOceanDeepColor()",
  );
  assert.ok(
    enhancedArm.includes("getOceanDarkening()"),
    "enhanced arm must call getOceanDarkening()",
  );
});
