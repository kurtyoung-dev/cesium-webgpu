// sun-halo-composition.spec.mjs — C12-18 (absorbing C11-160 + C11-115).
// @purpose Node gate: WebGPU sun blends ALPHA_BLEND, disc edge at 1.0 Rsun, exactly one live halo source, GLSL/WGSL veil equivalence to 1e-15.
// @status ACTIVE
//
// Pins, in pure Node with no browser:
//
//   1. C11-115 — the WebGPU sun command blends ALPHA_BLEND, the exact twin of
//      `BlendingState.ALPHA_BLEND` that `Sun.js` sets on the WebGL command.
//      The historical additive pair is asserted ABSENT, because the whole
//      C12-29 round-3 finding turned on it: under `src-alpha`/`one` a BLACK
//      billboard is an exact identity, while WebGL's ALPHA_BLEND darkens the
//      sky by `a*dst`.
//
//   2. C12-18 disc — the shipped bake put the solar limb at 1/sqrt(2) of the
//      Sun's true angular radius. `solarDiscBakeEdge` maps to EXACTLY 1.0
//      solar radii; the legacy expression maps to 0.70711; the disabled
//      toggle position is bit-identical to the legacy expression.
//
//   3. C12-18 halo — EXACTLY ONE HALO SOURCE IS LIVE AT A TIME. The truth
//      table is exhaustive over the two toggles x `sunBloomActive`, and a
//      mutant that leaves the bake halo on while the screen halo runs is
//      REJECTED.
//
//   4. Cross-language equivalence — the veil body is extracted from
//      `SolarHalo.glsl` and `SolarHalo.wgsl`, compiled as JavaScript, and
//      required to agree with `SolarDiscModel.solarScreenHaloProfile` to
//      1e-15 over a dense sweep. FOUR mutants are REJECTED, including **the
//      pedestal-subtracted, support-clamped curve — i.e. the OLD baked-halo
//      composition**, which is the one a careless "reuse solarGlareProfile"
//      refactor would reintroduce and which would silently re-truncate the
//      tail at 11 solar radii.
//
//   5. CLT-C4 — the eclipse factor multiplies the halo's amplitude, so
//      totality extinguishes the halo. A corona inside an undimmed halo is
//      the named failure mode of the rider.
//
//   6. C11-160 vacuity — `scene.sunBloom` must actually be READ on the
//      WebGPU side. Before this row it had no WebGPU consumer at all.
//
//   7. No new `ShaderDefine` bit (C12 exit condition 5) and Naga validation
//      of the assembled WGSL.
//
// Run: node --test Tools/visual-regression/sun-halo-composition.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");
const importEngine = (p) => import(pathToFileURL(enginePath(p)).href);

// Default `glowFactor = 1` geometry, shared with both bakes.
const GLOW_LENGTH_TS = 5.0;
const HALF_EXTENT_RSUN = 1.0 + 2.0 * GLOW_LENGTH_TS;

// ───────────────────────────────────────────────────────────────────────────
// 1. C11-115 — WebGPU sun blend mode
// ───────────────────────────────────────────────────────────────────────────

test("C11-115: the WebGPU sun pipeline blends ALPHA_BLEND, not additively", async () => {
  const src = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  // Isolate the Sun pipeline descriptor so the Moon's own blend (which is
  // `one`/`zero` and correctly untouched by this row) cannot satisfy the
  // assertions below.
  const sunStart = src.indexOf("const descriptor = {");
  assert.ok(sunStart > 0, "sun pipeline descriptor not found");
  const sunEnd = src.indexOf("cache.pipelineEntry = { descriptor", sunStart);
  assert.ok(sunEnd > sunStart, "sun pipeline descriptor end not found");
  const sunDescriptor = src.slice(sunStart, sunEnd);

  const blendStart = sunDescriptor.indexOf("blend: {");
  assert.ok(blendStart > 0, "sun blend state not found");
  const blend = sunDescriptor.slice(blendStart);

  // `BlendingState.ALPHA_BLEND`: SOURCE_ALPHA / ONE_MINUS_SOURCE_ALPHA for
  // colour, ONE / ONE_MINUS_SOURCE_ALPHA for alpha, both ADD.
  const colorBlock = blend.slice(blend.indexOf("color: {"));
  const alphaBlock = blend.slice(blend.indexOf("alpha: {"));
  assert.match(colorBlock.slice(0, 200), /srcFactor:\s*"src-alpha"/);
  assert.match(colorBlock.slice(0, 200), /dstFactor:\s*"one-minus-src-alpha"/);
  assert.match(alphaBlock.slice(0, 200), /srcFactor:\s*"one"/);
  assert.match(alphaBlock.slice(0, 200), /dstFactor:\s*"one-minus-src-alpha"/);

  // NEGATIVE CONTROL — the historical additive pair must be gone. This is the
  // mutation this test exists to catch: `dstFactor: "one"` on the colour
  // target restores the divergence that made a black sun billboard an exact
  // identity on WebGPU while darkening the sky on WebGL.
  assert.doesNotMatch(
    colorBlock.slice(0, 200),
    /dstFactor:\s*"one"\s*,/,
    "the sun colour target must not blend additively (C11-115 regression)",
  );
});

test("C11-115: the fade design is invariant to the blend flip — alpha, never rgb", () => {
  // Both the C12-29 S1 eclipse fade and this row's halo hand-off scale ALPHA.
  // Under `src-alpha`/X the alpha IS the blend weight, so an alpha-only
  // multiply fades correctly under additive AND alpha blending. If anyone
  // "simplifies" either to an rgb multiply, the two backends diverge again.
  const sunFS = readEngine("Shaders/SunFS.glsl");
  assert.match(sunFS, /out_FragColor\.a\s*\*=\s*u_eclipseAlpha;/);
  assert.doesNotMatch(sunFS, /out_FragColor\.rgb\s*\*=\s*u_eclipseAlpha/);
  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /color\.a\s*\*\s*u\.eclipseAlpha/);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. C12-18 — the disc's true angular size
// ───────────────────────────────────────────────────────────────────────────

test("C12-18: the SHIPPED disc edge was 1/sqrt(2) solar radii — the defect this row names", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const legacy = M.solarDiscBakeEdgeLegacy(GLOW_LENGTH_TS);
  assert.equal(legacy, 0.5 / HALF_EXTENT_RSUN, "legacy expression verbatim");
  const legacyRsun = M.solarBakeRadiusToSolarRadii(legacy, GLOW_LENGTH_TS);
  assert.ok(
    Math.abs(legacyRsun - Math.SQRT1_2) < 1e-15,
    `legacy disc edge must land at 1/sqrt(2) R_sun, got ${legacyRsun}`,
  );
});

test("C12-18: the shipped disc edge lands at exactly 1.0 solar radii", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const edge = M.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  const rsun = M.solarBakeRadiusToSolarRadii(edge, GLOW_LENGTH_TS);
  assert.ok(
    Math.abs(rsun - 1.0) < 1e-15,
    `true-size disc edge must land at 1.0 R_sun, got ${rsun}`,
  );
  // The growth factor is exactly the bakes' own lengthScalar — sqrt(2), i.e.
  // +41.42% in angular radius and x2 in disc AREA. Pre-registered for the
  // Edge run.
  const ratio = edge / M.solarDiscBakeEdgeLegacy(GLOW_LENGTH_TS);
  assert.ok(Math.abs(ratio - Math.SQRT2) < 1e-15, `ratio ${ratio}`);

  // Holds at every glowFactor, not just the default — the row is about the
  // conflation of two radius conventions, which is glow-independent.
  for (const glowFactor of [0.25, 0.5, 1.0, 2.0, 7.0]) {
    const g = glowFactor * 5.0;
    const r = M.solarBakeRadiusToSolarRadii(M.solarDiscBakeEdge(g, true), g);
    assert.ok(Math.abs(r - 1.0) < 1e-14, `glowFactor ${glowFactor}: ${r}`);
  }
});

test("C12-18: enableTrueSolarDiscSize = false is BIT-identical to the legacy edge", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const { createSunHaloAppearance, readSunHaloAppearance } = await importEngine(
    "Scene/SunHaloAppearance.js",
  );
  const result = readSunHaloAppearance(
    {
      atmosphericConditions: { lighting: { enableTrueSolarDiscSize: false } },
    },
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(
    result.discEdge,
    M.solarDiscBakeEdgeLegacy(GLOW_LENGTH_TS),
    "the off position must be the historical value, not an approximation",
  );
});

test("C12-18: both bakes consume the resolved disc edge — neither re-derives it", () => {
  // WebGL: the GLSL must hold no `0.5 / (1 + 2*glowLengthTS)` twin, and Sun.js
  // must feed `halo.discEdge` into `_radiusTS`.
  const sunJs = readEngine("Scene/Sun.js");
  assert.match(sunJs, /this\._radiusTS\s*=\s*halo\.discEdge;/);
  assert.doesNotMatch(
    sunJs,
    /_radiusTS\s*=\s*\(1\.0\s*\/\s*\(1\.0\s*\+\s*2\.0\s*\*\s*this\._glowLengthTS\)\)/,
    "Sun.js must not keep its own copy of the disc-edge expression",
  );
  // WebGPU: the CPU bake must read `halo.discEdge` too.
  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /const radiusTS\s*=\s*halo\s*\?\s*halo\.discEdge/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. C12-18 — EXACTLY ONE HALO SOURCE
// ───────────────────────────────────────────────────────────────────────────

const haloCase = async (lighting, sunBloomActive) => {
  const { createSunHaloAppearance, readSunHaloAppearance } = await importEngine(
    "Scene/SunHaloAppearance.js",
  );
  return readSunHaloAppearance(
    { atmosphericConditions: { lighting }, sunBloomActive },
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
};

test("C12-18: the halo-source truth table is exhaustive and never doubles or drops the halo", async () => {
  const rows = [
    // [enableScreenSpaceSunHalo, sunBloomActive, screenHalo, bakeHaloGain]
    [undefined, true, true, 0.0], // shipped default
    [true, true, true, 0.0],
    [false, true, false, 1.0], // toggle off -> historical baked halo
    [undefined, false, false, 1.0], // sunBloom off -> historical baked halo
    [true, false, false, 1.0], // requested but no chain -> baked halo
    [false, false, false, 1.0],
  ];
  for (const [toggle, chain, expectScreen, expectGain] of rows) {
    const lighting =
      toggle === undefined ? {} : { enableScreenSpaceSunHalo: toggle };
    const r = await haloCase(lighting, chain);
    assert.equal(
      r.screenHalo,
      expectScreen,
      `screenHalo for toggle=${toggle} chain=${chain}`,
    );
    assert.equal(
      r.bakeHaloGain,
      expectGain,
      `bakeHaloGain for toggle=${toggle} chain=${chain}`,
    );
    // The invariant, stated as arithmetic rather than as prose: the two halo
    // weights are complementary, so their sum is exactly 1 in every row.
    assert.equal(
      r.bakeHaloGain + (r.screenHalo ? 1 : 0),
      1,
      "exactly one halo source must be live",
    );
  }
});

test("C12-18: MUTANT REJECTED — bakeHaloGain must be DERIVED, not assigned beside the toggle", () => {
  // The old bake-halo composition is what a mutant reintroduces by writing
  // `result.bakeHaloGain = 1.0` (or by reading its own toggle). Structurally:
  // there must be exactly ONE assignment to `bakeHaloGain` in the resolver and
  // it must be the ternary on `screenHalo`.
  const src = readEngine("Scene/SunHaloAppearance.js");
  const assignments = [
    ...src.matchAll(/result\.bakeHaloGain\s*=\s*([^;]+);/g),
  ].map((m) => m[1].trim());
  assert.equal(
    assignments.length,
    1,
    `bakeHaloGain must be assigned exactly once, found ${assignments.length}`,
  );
  assert.equal(assignments[0], "screenHalo ? 0.0 : 1.0");
});

test("C12-18: both bakes gate their halo term with the gain — no ungated 0.75 survives", () => {
  const glsl = readEngine("Shaders/SunTextureFS.glsl");
  assert.match(glsl, /\*\s*\(0\.75\s*\*\s*u_haloGain\)/);
  assert.match(glsl, /\*\s*\(0\.15\s*\*\s*u_haloGain\)/);
  // NEGATIVE CONTROL — the pre-C12-18 ungated forms.
  assert.doesNotMatch(glsl, /glow\)\s*\*\s*0\.75\s*;/);
  assert.doesNotMatch(glsl, /vec4\(1\.0\)\)\s*\*\s*0\.15\s*;/);

  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /cb\s*\+=\s*glow\s*\*\s*\(0\.75\s*\*\s*haloGain\)/);
  assert.match(env, /ca\s*\+=\s*glow\s*\*\s*\(0\.75\s*\*\s*haloGain\)/);
  assert.match(env, /\*\s*\(0\.15\s*\*\s*haloGain\)/);
  assert.doesNotMatch(env, /cb\s*\+=\s*glow\s*\*\s*0\.75\s*;/);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Cross-language equivalence of the veil body
// ───────────────────────────────────────────────────────────────────────────

/**
 * Extract the three-line veil computation from a shader and compile it as a
 * JavaScript function of (dist, limbPx, core). Both shaders are written as a
 * line-for-line translation of `solarScreenHaloProfile`, so the substitution
 * table below is tiny by design — if it ever has to grow, the shaders have
 * drifted from the reference and that is the finding.
 */
function compileVeil(source, kind) {
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\b(rho|t|veil)\s*=/.test(l) && !l.startsWith("//"));
  assert.equal(lines.length, 3, `${kind}: expected 3 veil lines`);
  let body = lines.join("\n");
  if (kind === "glsl") {
    body = body
      .replace("length(gl_FragCoord.xy - u_haloCenter)", "dist")
      .replace(/u_haloLimbPx/g, "limbPx")
      .replace(/u_haloCoreRadii/g, "core")
      .replace(/\bfloat\b/g, "const");
  } else {
    body = body
      .replace("length(fragGL - halo.geometry.xy)", "dist")
      .replace(/halo\.geometry\.z/g, "limbPx")
      .replace(/halo\.geometry\.w/g, "core")
      .replace(/\blet\b/g, "const");
  }
  assert.doesNotMatch(
    body,
    /u_halo|halo\.|gl_FragCoord|fragGL/,
    `${kind}: an unsubstituted shader symbol survived — ${body}`,
  );
  // eslint-disable-next-line no-new-func
  return new Function("dist", "limbPx", "core", `${body}\nreturn veil;`);
}

test("C12-18: GLSL, WGSL and the JS reference compute the SAME veil to 1e-15", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const glsl = compileVeil(
    readEngine("Shaders/PostProcessStages/SolarHalo.glsl"),
    "glsl",
  );
  const wgsl = compileVeil(
    readEngine("Shaders/WebGPU/PostProcess/SolarHalo.wgsl"),
    "wgsl",
  );
  const core = M.solarHaloCoreRadii(GLOW_LENGTH_TS);
  const limbPx = 4.3; // ~1080p / 60 deg FOV, the figure the C12-17 note quotes
  for (let i = 0; i <= 4000; i++) {
    const rho = (i / 4000) * 120.0;
    const dist = rho * limbPx;
    const ref = M.solarScreenHaloProfile(rho, core);
    assert.ok(
      Math.abs(glsl(dist, limbPx, core) - ref) < 1e-15,
      `GLSL disagrees at rho=${rho}`,
    );
    assert.ok(
      Math.abs(wgsl(dist, limbPx, core) - ref) < 1e-15,
      `WGSL disagrees at rho=${rho}`,
    );
  }
});

test("C12-18: FOUR mutants REJECTED — including the OLD baked-halo composition", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const core = M.solarHaloCoreRadii(GLOW_LENGTH_TS);
  const ref = (rho) => M.solarScreenHaloProfile(rho, core);

  // (a) THE OLD BAKED-HALO COMPOSITION: pedestal-subtracted and clamped to
  //     zero at the quad's inscribed circle. This is exactly what a
  //     "just reuse solarGlareProfile" refactor produces, and it re-truncates
  //     the tail at 11 solar radii — the defect C12-18 exists to remove.
  const bakedComposition = (rho) =>
    M.solarGlareProfile(rho / (Math.SQRT2 * HALF_EXTENT_RSUN));
  // (b) wrong power: 1/(1+t) instead of 1/(1+t^2).
  const wrongPower = (rho) => 1.0 / (1.0 + rho / core);
  // (c) Gaussian wing instead of a Lorentzian one.
  const gaussian = (rho) => Math.exp(-((rho / core) ** 2));
  // (d) core taken in BAKE-RADIUS units rather than solar radii.
  const wrongUnits = (rho) => M.solarScreenHaloProfile(rho, 0.275);

  const mutants = [
    ["old baked-halo composition", bakedComposition],
    ["1/(1+t) wing", wrongPower],
    ["Gaussian wing", gaussian],
    ["core in bake-radius units", wrongUnits],
  ];
  for (const [name, mutant] of mutants) {
    let maxDelta = 0;
    for (let i = 0; i <= 2000; i++) {
      const rho = (i / 2000) * 60.0;
      maxDelta = Math.max(maxDelta, Math.abs(mutant(rho) - ref(rho)));
    }
    assert.ok(
      maxDelta > 1e-6,
      `mutant "${name}" was NOT rejected (max delta ${maxDelta})`,
    );
  }

  // The specific, load-bearing consequence of mutant (a): at and beyond the
  // old support the baked composition is EXACTLY zero while the screen halo
  // is not. That is the non-terminating tail, stated as a measurement.
  // At the support radius itself the baked profile is zero to within one
  // binary64 ULP rather than exactly zero — `solarBakeRadiusToSolarRadii`
  // uses `Math.SQRT2` while the bakes' own `lengthScalar` is `2 / sqrt(2)`,
  // and the two differ in the last bit (documented on
  // `SOLAR_DISC_BAKE_LENGTH_SCALAR`). Both round to the same binary32, so the
  // shipped shader really does terminate there; the assertion is written to
  // the arithmetic that is true rather than to the one that reads nicer.
  assert.ok(
    bakedComposition(11.0) < 1e-16,
    `baked halo at its own support = ${bakedComposition(11.0)}`,
  );
  assert.ok(ref(11.0) > 0.13, `screen halo at 11 R_sun = ${ref(11.0)}`);
  assert.equal(bakedComposition(30.0), 0.0);
  assert.ok(ref(30.0) > 0.019);
});

test("C12-18: pre-registered halo numbers for the Edge run", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const core = M.solarHaloCoreRadii(GLOW_LENGTH_TS);
  // Half amplitude at 4.27800 R_sun == 1.1397 deg.
  assert.ok(Math.abs(core - 4.277996026178613) < 1e-12, `core ${core}`);
  assert.equal(M.solarScreenHaloProfile(core, core), 0.5);
  assert.equal(M.SOLAR_HALO_AMPLITUDE, 0.75);

  // Worst-case brightening vs the baked halo is at the OLD support radius,
  // and it is 25/255 in alpha units. Beyond ~57 R_sun the halo drops below
  // one 8-bit code — "non-terminating" must not mean "washes the whole sky".
  const alphaDelta = (rho) =>
    (M.solarScreenHaloProfile(rho, core) -
      M.solarGlareProfile(rho / (Math.SQRT2 * HALF_EXTENT_RSUN))) *
    M.SOLAR_HALO_AMPLITUDE;
  let worst = 0;
  let worstRho = 0;
  for (let i = 0; i <= 60000; i++) {
    const rho = (i / 60000) * 60.0;
    const d = alphaDelta(rho);
    if (d > worst) {
      worst = d;
      worstRho = rho;
    }
  }
  assert.ok(Math.abs(worstRho - 11.0) < 0.02, `worst at rho=${worstRho}`);
  assert.ok(
    Math.abs(worst * 255 - 25.13) < 0.1,
    `worst 8-bit delta ${worst * 255}`,
  );
  const codeAt = (rho) =>
    M.solarScreenHaloProfile(rho, core) * M.SOLAR_HALO_AMPLITUDE * 255;
  assert.ok(codeAt(57.0) > 1.0, `halo at 57 R_sun = ${codeAt(57.0)} codes`);
  assert.ok(codeAt(60.0) < 1.0, `halo at 60 R_sun = ${codeAt(60.0)} codes`);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. CLT-C4 — the eclipse factor multiplies the halo INPUT
// ───────────────────────────────────────────────────────────────────────────

test("CLT-C4: the eclipse factor scales the halo amplitude — totality extinguishes it", async () => {
  const { createSunHaloAppearance, readSunHaloAppearance } = await importEngine(
    "Scene/SunHaloAppearance.js",
  );
  const M = await importEngine("Scene/SolarDiscModel.js");

  // A frameState whose geometry resolves (identity view, on-axis sun).
  const makeFrameState = (sunEclipseAlpha) => ({
    sunBloomActive: true,
    sunEclipseAlpha,
    atmosphericConditions: { lighting: {} },
    camera: { positionWC: { x: 0, y: 0, z: 0 } },
    context: {
      drawingBufferWidth: 1920,
      drawingBufferHeight: 1080,
      uniformState: {
        // Column-major identity-ish view; the Sun sits at -Z (in front).
        view: identityView(),
        projection: perspective(),
        sunPositionWC: { x: 0.0, y: 0.0, z: -1.5e11 },
      },
    },
  });

  const full = readSunHaloAppearance(
    makeFrameState(1.0),
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(full.visible, true, "the on-axis sun must resolve as visible");
  assert.equal(full.haloIntensity, M.SOLAR_HALO_AMPLITUDE);

  for (const f of [0.75, 0.5, 0.25, 0.001]) {
    const partial = readSunHaloAppearance(
      makeFrameState(f),
      GLOW_LENGTH_TS,
      createSunHaloAppearance(),
    );
    assert.ok(
      Math.abs(partial.haloIntensity - M.SOLAR_HALO_AMPLITUDE * f) < 1e-15,
      `eclipse ${f}`,
    );
  }

  const totality = readSunHaloAppearance(
    makeFrameState(0.0),
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(
    totality.haloIntensity,
    0.0,
    "at totality the halo must be EXACTLY zero — a corona inside an " +
      "undimmed halo is the CLT-C4 failure mode",
  );
});

test("CLT-C4: the derived bloom paths are NOT multiplied a second time", () => {
  // The bright-pass chains bloom the sun billboard, whose ALPHA `Sun.update`
  // already scaled by `sunEclipseAlpha`. A second multiply there would SQUARE
  // the fade. Structurally: neither the WebGL sun bloom chain nor the WebGPU
  // bloom effect may reference an eclipse term.
  const sunPP = fs.readFileSync(enginePath("Scene/SunPostProcess.js"), "utf8");
  assert.doesNotMatch(sunPP, /eclipse/i.test("") ? /$^/ : /u_eclipse/);
  const additive = readEngine("Shaders/PostProcessStages/AdditiveBlend.glsl");
  assert.doesNotMatch(additive, /eclipse/i);
  const bloom = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUBloomEffect.ts"),
    "utf8",
  );
  assert.doesNotMatch(bloom, /eclipse/i);
});

test("C12-18: the halo also inherits atmospheric extinction — a set sun has no halo", async () => {
  const { createSunHaloAppearance, readSunHaloAppearance } = await importEngine(
    "Scene/SunHaloAppearance.js",
  );
  const r = readSunHaloAppearance(
    {
      sunBloomActive: true,
      sunAtmosphereExtinction: { x: 0.723, y: 0.467, z: 0.19 },
      atmosphericConditions: { lighting: {} },
    },
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(r.haloColorR, 0.723);
  assert.equal(r.haloColorG, 0.467);
  assert.equal(r.haloColorB, 0.19);
  // Absent publication -> exactly (1,1,1), a byte-identical no-op.
  const none = readSunHaloAppearance(
    { sunBloomActive: true, atmosphericConditions: { lighting: {} } },
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(none.haloColorR, 1.0);
  assert.equal(none.haloColorG, 1.0);
  assert.equal(none.haloColorB, 1.0);
});

test("C12-18: a Sun BEHIND the camera resolves as not visible", async () => {
  const { createSunHaloAppearance, readSunHaloAppearance } = await importEngine(
    "Scene/SunHaloAppearance.js",
  );
  const r = readSunHaloAppearance(
    {
      sunBloomActive: true,
      atmosphericConditions: { lighting: {} },
      camera: { positionWC: { x: 0, y: 0, z: 0 } },
      context: {
        drawingBufferWidth: 1920,
        drawingBufferHeight: 1080,
        uniformState: {
          view: identityView(),
          projection: perspective(),
          // +Z in eye space == behind the camera.
          sunPositionWC: { x: 0.0, y: 0.0, z: 1.5e11 },
        },
      },
    },
    GLOW_LENGTH_TS,
    createSunHaloAppearance(),
  );
  assert.equal(r.visible, false);
  assert.equal(r.haloIntensity, 0.0);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. C11-160 vacuity — `scene.sunBloom` must be READ on WebGPU
// ───────────────────────────────────────────────────────────────────────────

test("C11-160: scene.sunBloom now has a WebGPU consumer", () => {
  const collection = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUPostProcessStageCollection.ts"),
    "utf8",
  );
  assert.match(
    collection,
    /sunBloom\?:\s*boolean\s*}\s*\)\?\.sunBloom\s*===\s*true/,
    "the WebGPU configure pass must read scene.sunBloom",
  );
  // ...and it must also honour the same occlusion gate the WebGL chain uses.
  assert.match(collection, /_environmentState\?\.isSunVisible/);
  assert.match(collection, /pipeline\.addSunHalo\(device, canvasFormat\)/);

  // The pipeline must actually execute it, and BEFORE bloom, so the halo
  // participates in bloom/tonemap the way WebGL's SunPostProcess output does.
  const pipeline = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUPostProcessPipeline.ts"),
    "utf8",
  );
  const haloAt = pipeline.indexOf("this._sunHaloEffect.execute(");
  const bloomAt = pipeline.indexOf("this._bloomEffect.execute(");
  assert.ok(haloAt > 0, "SunHalo must be executed in the chain");
  assert.ok(bloomAt > 0);
  assert.ok(haloAt < bloomAt, "SunHalo must run before Bloom");
  // The halo alone must keep the chain alive on an otherwise effect-free
  // scene, or the stage would silently never run at engine defaults.
  assert.match(pipeline, /if \(this\._sunHaloEffect\?\.enabled\) return true;/);
});

test("C12-18: the WebGL stage runs LAST inside SunPostProcess", () => {
  const src = fs.readFileSync(enginePath("Scene/SunPostProcess.js"), "utf8");
  assert.match(src, /const stages = new Array\(7\);/);
  assert.match(
    src,
    /stages\[6\] = new PostProcessStage\(\{\s*\r?\n\s*fragmentShader: SolarHalo,/,
  );
  // `copy()` reads the LAST stage's output, so appending must not have
  // orphaned the composite.
  assert.match(src, /_stages\.get\(that\._stages\.length - 1\)\.outputTexture/);
});

test("C12-18: the halo publication is RESET every frame on both Scene paths", () => {
  // `Sun.update` early-returns in 2D / MORPHING / non-render passes and when
  // `sun.show` is false. Without a reset the LAST 3D frame's halo object --
  // `visible: true`, at its old screen position -- would still be on
  // frameState and both consumers would paint it. Two reset sites are
  // required: the "no celestial consumer" branch and the publish-then-branch
  // site immediately above `sun.update`.
  const scene = fs.readFileSync(enginePath("Scene/Scene.js"), "utf8");
  const resets = [...scene.matchAll(/frameState\.sunHalo = undefined;/g)];
  assert.equal(
    resets.length,
    2,
    `expected 2 sunHalo resets in Scene.js, found ${resets.length}`,
  );
  // The live publication must happen AFTER the reset that precedes it.
  const publish = scene.indexOf("frameState.sunBloomActive =");
  const sunUpdate = scene.indexOf("this.sun.update(frameState");
  assert.ok(publish > 0 && sunUpdate > publish, "publish must precede update");
});

// ───────────────────────────────────────────────────────────────────────────
// 7. C12 exit condition 5 + WGSL validation
// ───────────────────────────────────────────────────────────────────────────

test("C12 exit condition 5: no new ShaderDefine bit was minted for this row", () => {
  const defines = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUShaderDefines.ts"),
    "utf8",
  );
  assert.doesNotMatch(defines, /SUN_HALO|SOLAR_HALO|TRUE_DISC/i);
  const wgsl = readEngine("Shaders/WebGPU/PostProcess/SolarHalo.wgsl");
  assert.doesNotMatch(
    wgsl,
    /\/\/>>ifdef/,
    "the halo shader must be uniform-driven, not define-gated",
  );
});

test("C12-18: SolarHalo.wgsl passes Naga WGSL validation", async () => {
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
  const shader = readEngine("Shaders/WebGPU/PostProcess/SolarHalo.wgsl");
  assert.doesNotThrow(() => naga.validate_wgsl(shader));
});

test("C12-18: the WGSL flips y exactly once and the GLSL does not flip at all", () => {
  const wgsl = readEngine("Shaders/WebGPU/PostProcess/SolarHalo.wgsl");
  const glsl = readEngine("Shaders/PostProcessStages/SolarHalo.glsl");
  // `@builtin(position)` is y-DOWN; `gl_FragCoord` is y-UP. The published
  // centre is in the GL convention, so exactly one conversion must exist and
  // it must be on the WebGPU side.
  const flips = [...wgsl.matchAll(/viewport\.x\s*-\s*in\.position\.y/g)];
  assert.equal(flips.length, 1, "exactly one y flip in the WGSL");
  assert.doesNotMatch(glsl, /-\s*gl_FragCoord\.y|height\s*-/);
  // Both must measure the distance from the SAME published centre.
  assert.match(glsl, /gl_FragCoord\.xy\s*-\s*u_haloCenter/);
  assert.match(wgsl, /fragGL\s*-\s*halo\.geometry\.xy/);
});

// ───────────────────────────────────────────────────────────────────────────
// helpers — minimal Matrix4-compatible column-major arrays
// ───────────────────────────────────────────────────────────────────────────

/** Identity view matrix (camera at the origin looking down -Z). */
function identityView() {
  // prettier-ignore
  return [1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1];
}

/** Symmetric perspective, 60 deg vertical FOV, 16:9, near 1, far 1e10. */
function perspective() {
  const fovy = (60.0 * Math.PI) / 180.0;
  const f = 1.0 / Math.tan(fovy / 2.0);
  const aspect = 16.0 / 9.0;
  const near = 1.0;
  const far = 1.0e10;
  // prettier-ignore
  return [f / aspect, 0, 0, 0,
          0, f, 0, 0,
          0, 0, (far + near) / (near - far), -1,
          0, 0, (2 * far * near) / (near - far), 0];
}
