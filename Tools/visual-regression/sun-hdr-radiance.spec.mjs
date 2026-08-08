// sun-hdr-radiance.spec.mjs — C12-19 (True HDR sun radiance + BrightPass retune).
//
// Pins, in pure Node with no browser:
//
//   1. TWO PREMISE CORRECTIONS the row and the Batch-906 record both need.
//      (a) The bake's final `clamp(...,0,1)` is NOT what masks C12-15 limb
//          darkening — C12-18 already unmasked it by moving the halo out of
//          the bake, and the law composites at HEAD. The clamp binds on
//          exactly one channel at the default (BLUE), where it is a WHITE
//          POINT, not a radiance clamp.
//      (b) Removing the clamp from ALPHA is UNSAFE: since C11-115 both
//          backends blend the sun ALPHA_BLEND, so alpha is the DESTINATION
//          weight and `a > 1` makes `1 - a` negative — the sun subtracts the
//          sky. Both halves of the split are MUTANT-pinned.
//
//   2. The disc radiance is DERIVED from the engine's own statement of solar
//      radiance (`light.intensity * max(light.color)`, the factor by which
//      `czm_lightColorHdr` exceeds `czm_lightColor`) — exactly 1.0 in SDR,
//      2.0 at the shipped defaults — and is ECLIPSE-INVARIANT, because the
//      billboard's alpha already carries the eclipse fade and a second
//      multiply would square it.
//
//   3. RAISING THE RADIANCE DESTROYS LIMB DARKENING; it does not unmask it.
//      The contrast is strictly decreasing in radiance under the default
//      tonemapper, and the ceiling at which half the law survives (2.0148)
//      agrees with `SunLight`'s default intensity (2.0) to 0.74% — two
//      derivations with nothing in common.
//
//   4. The BrightPass retune is DERIVED, not dialled: `threshold` puts the
//      extraction's foot on display white EXACTLY and `offset` puts its
//      half-saturation point on `sqrt(radiance)` EXACTLY, both checked as
//      identities against the compiled GLSL. `L <= 1` returns (0.25, 0.1)
//      bit-for-bit.
//
//   5. THE VACUITY BLOCKER: `SunPostProcess` built every stage at
//      UNSIGNED_BYTE and called `SceneFramebuffer.update` with no `hdr`
//      argument, so `sunBloom = true` (the default) clamped the WHOLE HDR
//      scene to 8 bits. Without the datatype fix the radiance and the retune
//      are both unreachable on WebGL.
//
//   6. Cross-backend parity — both sun fragment shaders apply the radiance
//      AFTER the gamma decode and to RGB ONLY; the WebGPU slot is the former
//      `_sunPad1` pad, so there is no uniform-layout growth and no new
//      `ShaderDefine` bit (C12 exit condition 5).
//
//   7. The C12-18 halo continuity invariant is RE-DERIVED: `haloAmplitude`
//      scales with the disc radiance, so `haloAmplitude / discRadiance` is
//      the constant 0.75 at every radiance instead of only at 1.0.
//
// Run: node --test Tools/visual-regression/sun-hdr-radiance.spec.mjs

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

const GLOW_LENGTH_TS = 5.0;
const GAMMA = 2.2;

// ───────────────────────────────────────────────────────────────────────────
// Shared harness — a CPU twin of the bake, and compiled shader bodies.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The bake's own composition at a given bake `radius`, as BOTH bakes compute
 * it (SunTextureFS.glsl main() and WebGPUEnvironmentRenderer.createSunTexture),
 * PRE-saturation. Returns the raw rgb + alpha so the saturation's effect can be
 * measured rather than assumed.
 */
function bakeRaw(M, radius, discEdge, haloGain) {
  const xr = Math.min(radius / discEdge, 1.0);
  const surface = radius <= discEdge ? M.solarLimbIntensity(xr) * 1.0 : 0.0;
  const glow = M.solarGlareProfile(radius);
  // The burst term is zero away from the six spike directions; this harness
  // samples on the radial axis only, where it contributes nothing, so the
  // halo term alone is what drives alpha past 1 on the legacy path.
  return {
    r: 1.0,
    g: 1.0,
    b: surface + 0.2 + glow * (0.75 * haloGain),
    a: surface + glow * (0.75 * haloGain),
  };
}

const sat01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Strip comments before a NEGATIVE control runs.
 *
 * Every "the old form must be gone" assertion in this file is about CODE, and
 * this row's code is documented by comments that necessarily QUOTE the old
 * form (that is what makes them useful). Matching the raw file would make
 * those comments self-defeating — the same trap the C12-18 spec avoided by
 * slicing to one descriptor.
 */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `czm_pbrNeutralTonemapping`, compiled from the GLSL for a NEUTRAL input. */
function compilePbrNeutral() {
  const src = readEngine(
    "Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl",
  );
  const open = src.indexOf("vec3 czm_pbrNeutralTonemapping(vec3 color) {");
  assert.ok(open > 0, "czm_pbrNeutralTonemapping body not found");
  let body = src.slice(src.indexOf("{", open) + 1, src.lastIndexOf("}"));
  body = body
    .replace(/color\.[rgb]/g, "color")
    .replace(/vec3\(1\.0,\s*1\.0,\s*1\.0\)/g, "1.0")
    .replace(/\bconst float\b/g, "const")
    .replace(/\bfloat\b/g, "let")
    .replace(/\bmin\(/g, "Math.min(")
    .replace(/\bmax\(/g, "Math.max(");
  assert.doesNotMatch(
    body,
    /vec3|float|\bcolor\.[rgba]\b/,
    `an unsubstituted GLSL symbol survived:\n${body}`,
  );
  const czm_branchFreeTernary = (c, a, b) => (c ? a : b);
  const mix = (a, b, t) => a * (1.0 - t) + b * t;
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "color",
    "czm_branchFreeTernary",
    "mix",
    `${body}\nreturn color;`,
  );
  return (v) => fn(v, czm_branchFreeTernary, mix);
}

/** `BrightPass.glsl`'s three-line extraction, compiled. Neutral input only. */
function compileBrightPass() {
  const src = readEngine("Shaders/PostProcessStages/BrightPass.glsl");
  const keyBody = src.slice(
    src.indexOf("float key(float avg)"),
    src.indexOf("}", src.indexOf("float key(float avg)")) + 1,
  );
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^float (scaledLum|brightLum|brightness)\s*=/.test(l));
  assert.equal(lines.length, 3, "expected 3 extraction lines in BrightPass");
  const body = `${keyBody}\n${lines.join("\n")}`
    .replace(/\bfloat\b/g, "let")
    .replace(/\bmax\(/g, "Math.max(")
    .replace(/\blet key\(let avg\)/, "function key(avg)");
  assert.doesNotMatch(body, /\bfloat\b/, `unsubstituted GLSL:\n${body}`);
  // eslint-disable-next-line no-new-func
  return new Function(
    "luminance",
    "avgLuminance",
    "threshold",
    "offset",
    `${body}\nreturn brightness;`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 1. PREMISE CORRECTION (a) — the clamp is not what masked limb darkening
// ───────────────────────────────────────────────────────────────────────────

test("C12-19 (a): at C12-18 defaults the bake saturation binds on BLUE ONLY — never on alpha", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const edge = M.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  let blueClipped = 0;
  let alphaClipped = 0;
  for (let i = 0; i <= 4000; i++) {
    const radius = (i / 4000) * Math.SQRT1_2;
    const raw = bakeRaw(M, radius, edge, 0.0); // bakeHaloGain = 0 (the default)
    assert.ok(raw.a <= 1.0 + 1e-15, `alpha exceeded 1 at radius ${radius}`);
    assert.ok(raw.r <= 1.0 && raw.g <= 1.0, "r/g must sit exactly at 1");
    if (raw.b > 1.0) {
      blueClipped++;
    }
    if (raw.a > 1.0) {
      alphaClipped++;
    }
  }
  assert.equal(alphaClipped, 0, "alpha must never reach the saturation");
  assert.ok(
    blueClipped > 0,
    "blue MUST be clipped over the inner disc — that is the one channel the saturation still binds on",
  );
});

test("C12-19 (a): the C12-15 law ALREADY composites at HEAD — 255 -> 77 codes in SDR", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const edge = M.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  // SDR: no tonemap stage runs, the bake is already display-encoded, and
  // ALPHA_BLEND over a black sky is `rgb * a`.
  const centre = bakeRaw(M, 0.0, edge, 0.0);
  const limb = bakeRaw(M, edge * (1.0 - 1e-9), edge, 0.0);
  const centreCode = 255.0 * sat01(centre.r) * sat01(centre.a);
  const limbCode = 255.0 * sat01(limb.r) * sat01(limb.a);
  assert.ok(Math.abs(centreCode - 255.0) < 1e-6, `centre ${centreCode}`);
  assert.ok(
    Math.abs(limbCode - 255.0 * M.SOLAR_LIMB_DARKENING_A0) < 0.5,
    `limb ${limbCode} should be 255 * a0 = 76.5`,
  );
  assert.ok(
    centreCode - limbCode > 170.0,
    "the SDR limb gradient is enormous and predates C12-19",
  );
});

test("C12-19 (a): blue's saturation is a WHITE POINT — removing it tints the core", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const edge = M.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  const centre = bakeRaw(M, 0.0, edge, 0.0);
  // Saturated: r == g == b, i.e. white.
  assert.equal(sat01(centre.r), sat01(centre.b));
  // Unsaturated: blue exceeds red by exactly the `+0.2` hue term, which is a
  // 20% blue cast on the sun's core — the regression a naive clamp removal
  // ships.
  assert.ok(
    centre.b - centre.r > 0.19,
    `unsaturated blue excess was ${centre.b - centre.r}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 2. PREMISE CORRECTION (b) — alpha's saturation is a BLEND WEIGHT
// ───────────────────────────────────────────────────────────────────────────

test("C12-19 (b): on the legacy halo path alpha would exceed 1 and SUBTRACT the sky", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const edge = M.solarDiscBakeEdge(GLOW_LENGTH_TS, true);
  let worst = 0.0;
  for (let i = 0; i <= 4000; i++) {
    const radius = (i / 4000) * Math.SQRT1_2;
    const raw = bakeRaw(M, radius, edge, 1.0); // bakeHaloGain = 1 (sunBloom off)
    worst = Math.max(worst, raw.a);
  }
  assert.ok(worst > 1.0, `legacy alpha peak was ${worst}, expected > 1`);
  // ALPHA_BLEND: dst' = src.rgb * a + dst * (1 - a). With a > 1 the second
  // term is NEGATIVE, i.e. the sun darkens the sky around itself — the
  // Batch-364 black-sky class, arrived at from the opposite direction.
  const dstWeight = 1.0 - worst;
  assert.ok(
    dstWeight < 0.0,
    "the destination weight must go negative — that is why the alpha clamp stays",
  );
});

test("C12-19 (b): MUTANT REJECTED — both bakes must saturate alpha, and both must saturate rgb", () => {
  const glsl = readEngine("Shaders/SunTextureFS.glsl");
  assert.match(
    glsl,
    /vec3 chroma\s*=\s*clamp\(color\.rgb,\s*vec3\(0\.0\),\s*vec3\(1\.0\)\);/,
    "the rgb white-point saturation must survive",
  );
  assert.match(
    glsl,
    /float blendWeight\s*=\s*clamp\(color\.a,\s*0\.0,\s*1\.0\);/,
    "the alpha blend-weight saturation must survive",
  );
  assert.match(glsl, /out_FragColor\s*=\s*vec4\(chroma,\s*blendWeight\);/);
  // NEGATIVE CONTROL — the naive readings of the row. An unsaturated write of
  // either channel is the mutation this test exists to catch.
  assert.doesNotMatch(codeOf(glsl), /out_FragColor\s*=\s*color\s*;/);
  assert.doesNotMatch(
    codeOf(glsl),
    /out_FragColor\s*=\s*vec4\(chroma,\s*color\.a\)/,
  );

  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /const chromaR = Math\.min\(1\.0, Math\.max\(0\.0, cr\)\)/);
  assert.match(
    env,
    /const blendWeight = Math\.min\(1\.0, Math\.max\(0\.0, ca\)\)/,
  );
  assert.match(env, /pixels\[idx \+ 3\] = floatToHalfBits\(blendWeight\)/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The disc radiance — derived, SDR-identical, eclipse-invariant
// ───────────────────────────────────────────────────────────────────────────

const whiteSunLight = { intensity: 2.0, color: { red: 1, green: 1, blue: 1 } };

test("C12-19: SDR is the multiplicative identity — EXACTLY 1.0, not 'close'", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  for (const light of [
    whiteSunLight,
    { intensity: 50.0, color: { red: 1, green: 1, blue: 1 } },
    undefined,
  ]) {
    assert.equal(M.solarDiscHdrRadiance(false, light), 1.0);
  }
  // `useHdr` must be a strict `true` — an unpublished frame is SDR, not HDR.
  assert.equal(M.solarDiscHdrRadiance(undefined, whiteSunLight), 1.0);
});

test("C12-19: the HDR radiance IS the engine's own lightColorHdr/lightColor factor", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  // `UniformState.updateFrameState`: lightColorHdr = color * intensity, and
  // lightColor = that renormalised by its maximum component when it exceeds 1.
  const cases = [
    [{ intensity: 2.0, color: { red: 1, green: 1, blue: 1 } }, 2.0],
    [{ intensity: 1.0, color: { red: 1, green: 1, blue: 1 } }, 1.0],
    [{ intensity: 4.0, color: { red: 0.5, green: 0.5, blue: 0.5 } }, 2.0],
    [{ intensity: 3.0, color: { red: 1, green: 0.8, blue: 0.6 } }, 3.0],
    // A dimmer-than-white light must NOT darken the disc below the SDR look.
    [{ intensity: 0.25, color: { red: 1, green: 1, blue: 1 } }, 1.0],
  ];
  for (const [light, expected] of cases) {
    const lightColorHdrMax =
      light.intensity *
      Math.max(light.color.red, light.color.green, light.color.blue);
    assert.equal(
      M.solarDiscHdrRadiance(true, light),
      expected,
      `radiance for intensity ${light.intensity}`,
    );
    if (expected > 1.0) {
      assert.equal(
        M.solarDiscHdrRadiance(true, light),
        lightColorHdrMax,
        "the radiance must BE the HDR light peak, not a function of it",
      );
    }
  }
});

test("C12-19: the radiance is ECLIPSE-INVARIANT — a second dim would SQUARE the fade", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  // `UniformState` applies `eclipseSceneLightFactor` to BOTH `_lightColorHdr`
  // and `_lightColor` AFTER the renormalisation, so their ratio — this
  // function's value — does not move. `Sun.update` already scales the
  // billboard's alpha by `sunEclipseAlpha`; if the radiance dimmed too, the
  // disc would fade as the SQUARE of the visible solar fraction.
  const base = M.solarDiscHdrRadiance(true, whiteSunLight);
  for (const e of [1.0, 0.5, 0.1, 0.001]) {
    // The eclipse never touches `light.intensity`; it is applied downstream.
    assert.equal(M.solarDiscHdrRadiance(true, whiteSunLight), base);
    assert.ok(e > 0.0);
  }
  const src = readEngine("Scene/SunHaloAppearance.js");
  const assignments = [
    ...src.matchAll(/result\.discRadiance\s*=\s*([\s\S]*?);/g),
  ];
  assert.equal(assignments.length, 1, "discRadiance assigned exactly once");
  assert.doesNotMatch(
    assignments[0][1],
    /eclipse/i,
    "the radiance must not read the eclipse factor",
  );
});

test("C12-19: the fp16 ceiling comes from the FORMAT, and never binds at defaults", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const ceiling = M.SOLAR_DISC_RADIANCE_FP16_CEILING;
  // (1 + haloAmplitude) * L + 1 <= 65504 / 4
  assert.ok(
    Math.abs((1.0 + M.SOLAR_HALO_AMPLITUDE) * ceiling + 1.0 - 65504.0 / 4.0) <
      1e-9,
    "the ceiling must be the solution of the fp16 headroom inequality",
  );
  assert.ok(ceiling > 9000.0 && ceiling < 10000.0, `ceiling ${ceiling}`);
  assert.equal(
    M.solarDiscHdrRadiance(true, {
      intensity: 1e9,
      color: { red: 1, green: 1, blue: 1 },
    }),
    ceiling,
    "a pathological light must saturate at the ceiling, not produce Inf",
  );
  assert.ok(
    M.solarDiscHdrRadiance(true, whiteSunLight) < ceiling / 1000.0,
    "the ceiling must be nowhere near the shipped radiance",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE HEADLINE FINDING — radiance and limb darkening TRADE OFF
// ───────────────────────────────────────────────────────────────────────────

test("C12-19: the compiled GLSL tonemapper and the JS restriction agree on neutral greys", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const glsl = compilePbrNeutral();
  for (let i = 0; i <= 6000; i++) {
    const v = (i / 6000) * 64.0;
    const a = glsl(v);
    const b = M.pbrNeutralNeutralGrey(v);
    assert.ok(
      Math.abs(a - b) < 1e-12,
      `tonemap disagrees at v=${v}: ${a} ${b}`,
    );
  }
  // The two literals must be MIRRORED from the GLSL, not re-invented.
  const src = readEngine(
    "Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl",
  );
  assert.match(src, /startCompression\s*=\s*0\.8\s*-\s*0\.04/);
  assert.equal(M.PBR_NEUTRAL_START_COMPRESSION, 0.8 - 0.04);
  assert.equal(M.PBR_NEUTRAL_OFFSET, 0.04);
});

test("C12-19: limb contrast is STRICTLY DECREASING in radiance — more HDR MASKS the law", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  let previous = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const L = 1.0 + (i / 2000) * 63.0;
    const c = M.solarDiscLimbContrastCodes(L, GAMMA);
    assert.ok(c < previous, `contrast rose at L=${L}`);
    previous = c;
  }
  // The row's own "~10^5 energy" warning, quantified: the disc becomes a flat
  // white circle with the C12-15 law arithmetically invisible.
  assert.ok(
    M.solarDiscLimbContrastCodes(1e5, GAMMA) < 0.01,
    "at 10^5 the limb law is below a thousandth of one 8-bit code",
  );
});

test("C12-19: TWO INDEPENDENT DERIVATIONS agree on 2.0 to within 0.74%", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const ceiling = M.SOLAR_DISC_RADIANCE_CONTRAST_CEILING;
  // (i) the half-power point of the limb-darkening signal
  assert.ok(
    Math.abs(
      M.solarDiscLimbContrastCodes(ceiling, GAMMA) /
        M.SOLAR_DISC_LIMB_CONTRAST_IDEAL -
        M.SOLAR_DISC_LIMB_CONTRAST_FRACTION,
    ) < 1e-6,
    "the ceiling must be the exact half-power radiance",
  );
  assert.ok(
    Math.abs(ceiling - 2.0147530525879143) < 1e-9,
    `contrast ceiling drifted: ${ceiling}`,
  );
  // (ii) the engine's own SunLight default intensity
  const shipped = M.solarDiscHdrRadiance(true, whiteSunLight);
  assert.equal(shipped, 2.0);
  assert.ok(
    Math.abs(shipped - ceiling) / ceiling < 0.0074,
    `the two derivations diverged by ${Math.abs(shipped - ceiling) / ceiling}`,
  );
  // The shipped radiance must sit BELOW the ceiling — i.e. more than half the
  // limb law survives at the default.
  assert.ok(shipped < ceiling);
  assert.ok(
    M.solarDiscLimbContrastCodes(shipped, GAMMA) >
      M.SOLAR_DISC_LIMB_CONTRAST_FRACTION * M.SOLAR_DISC_LIMB_CONTRAST_IDEAL,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. BrightPass retune — derived, checked against the compiled GLSL
// ───────────────────────────────────────────────────────────────────────────

test("C12-19: the SDR bright-pass pair is the historical one BIT-FOR-BIT", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  for (const L of [0.0, 0.5, 1.0]) {
    const t = M.solarBrightPassTuning(L, M.SUN_BRIGHT_PASS_AVG_LUMINANCE);
    assert.equal(t.threshold, 0.25);
    assert.equal(t.offset, 0.1);
  }
  assert.equal(M.SUN_BRIGHT_PASS_THRESHOLD_LEGACY, 0.25);
  assert.equal(M.SUN_BRIGHT_PASS_OFFSET_LEGACY, 0.1);
});

test("C12-19: the derived pair puts the cut on white and the knee on sqrt(L) — as IDENTITIES", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const brightPass = compileBrightPass();
  const avg = M.SUN_BRIGHT_PASS_AVG_LUMINANCE;
  for (const L of [1.5, 2.0, 4.0, 16.0]) {
    const { threshold, offset } = M.solarBrightPassTuning(L, avg);
    // Extraction starts EXACTLY at display white.
    assert.ok(
      Math.abs(brightPass(1.0, avg, threshold, offset)) < 1e-15,
      `L=${L}: white must extract exactly 0`,
    );
    assert.ok(brightPass(1.0 + 1e-6, avg, threshold, offset) > 0.0);
    // Half saturation EXACTLY at sqrt(L).
    assert.ok(
      Math.abs(brightPass(Math.sqrt(L), avg, threshold, offset) - 0.5) < 1e-12,
      `L=${L}: knee must land on sqrt(L)`,
    );
    // ...and the disc peak lands on the closed form the construction implies,
    // `(sqrt(L) + 1) / (sqrt(L) + 2)`, which is 1/sqrt(2) exactly at L = 2.
    const closed = (Math.sqrt(L) + 1.0) / (Math.sqrt(L) + 2.0);
    assert.ok(
      Math.abs(brightPass(L, avg, threshold, offset) - closed) < 1e-12,
      `L=${L}: the disc peak must extract at (sqrt(L)+1)/(sqrt(L)+2)`,
    );
  }
});

test("C12-19: the SHIPPED pair flattens the sun's HDR range — the defect being retuned", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const brightPass = compileBrightPass();
  const avg = M.SUN_BRIGHT_PASS_AVG_LUMINANCE;
  const L = M.solarDiscHdrRadiance(true, whiteSunLight);

  // Legacy: the cut sits BELOW display white (0.7292), so an ordinary bright
  // sky already blooms, and only 0.33 of the output range is left for the sun.
  const legacySpan =
    brightPass(L, avg, 0.25, 0.1) - brightPass(1.0, avg, 0.25, 0.1);
  assert.ok(
    brightPass(0.75, avg, 0.25, 0.1) > 0.0,
    "legacy blooms below white",
  );
  assert.ok(legacySpan < 0.34, `legacy span was ${legacySpan}`);

  // Derived: nothing below white blooms at all, and the sun owns 0.707 of the
  // range.
  const { threshold, offset } = M.solarBrightPassTuning(L, avg);
  assert.equal(brightPass(0.75, avg, threshold, offset), 0.0);
  const derivedSpan =
    brightPass(L, avg, threshold, offset) -
    brightPass(1.0, avg, threshold, offset);
  assert.ok(derivedSpan > 2.0 * legacySpan, `derived span was ${derivedSpan}`);
});

test("C12-19: `SunPostProcess` reads the derived pair through closures, not literals", () => {
  const src = readEngine("Scene/SunPostProcess.js");
  assert.match(
    src,
    /threshold: function \(\) \{\s*return that\._brightPassThreshold;/,
  );
  assert.match(
    src,
    /offset: function \(\) \{\s*return that\._brightPassOffset;/,
  );
  // NEGATIVE CONTROL — the frozen literals must be gone from the stage.
  assert.doesNotMatch(codeOf(src), /threshold:\s*0\.25\s*,/);
  assert.doesNotMatch(codeOf(src), /offset:\s*0\.1\s*,/);
  // `avgLuminance` is deliberately UNCHANGED — it is `key()`'s argument.
  assert.match(src, /avgLuminance: SUN_BRIGHT_PASS_AVG_LUMINANCE/);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. THE VACUITY BLOCKER — SunPostProcess clamped the whole HDR scene to 8 bits
// ───────────────────────────────────────────────────────────────────────────

test("C12-19: `SunPostProcess` propagates HDR to its own scene framebuffer", () => {
  const src = readEngine("Scene/SunPostProcess.js");
  assert.match(
    src,
    /sceneFramebuffer\.update\(context,\s*viewport,\s*this\._useHdr\)/,
    "the scene renders INTO this framebuffer when sunBloom is on",
  );
  // NEGATIVE CONTROL — the two-argument call is the whole defect. Run against
  // the comment-stripped source: the constructor's own note quotes it.
  assert.doesNotMatch(
    codeOf(src),
    /sceneFramebuffer\.update\(context,\s*viewport\)/,
  );
});

test("C12-19: EVERY stage carries the pipeline datatype — one 8-bit stage re-clamps the frame", () => {
  const src = readEngine("Scene/SunPostProcess.js");
  const code = codeOf(src);
  const stages = [...code.matchAll(/new PostProcessStage\(\{/g)].length;
  assert.equal(stages, 7, `expected 7 stages, found ${stages}`);
  const tagged = [...code.matchAll(/pixelDatatype: datatype,/g)].length;
  assert.equal(
    tagged,
    stages,
    "every stage must be built with the pipeline datatype",
  );
  assert.match(src, /get pixelDatatype\(\) \{\s*return this\._pixelDatatype;/);
});

test("C12-19: the orchestrator resolves the datatype and RECONSTRUCTS on an HDR flip", () => {
  const src = readEngine("Scene/FramebufferOrchestrator.js");
  assert.match(src, /const sunBloomPixelDatatype = scene\._hdr/);
  assert.match(src, /PixelDatatype\.HALF_FLOAT/);
  assert.match(src, /PixelDatatype\.FLOAT/);
  assert.match(src, /new SunPostProcess\(sunBloomPixelDatatype\)/);
  assert.match(
    src,
    /scene\._sunPostProcess\.pixelDatatype !== sunBloomPixelDatatype/,
    "an HDR flip must rebuild — the stage datatype is fixed at construction",
  );
  // NEGATIVE CONTROL — a bare construction leaves the pipeline at 8 bits.
  assert.doesNotMatch(codeOf(src), /new SunPostProcess\(\)/);
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Cross-backend parity + no layout / define growth
// ───────────────────────────────────────────────────────────────────────────

test("C12-19: both sun shaders scale RGB ONLY, and AFTER the gamma decode", () => {
  const glsl = readEngine("Shaders/SunFS.glsl");
  const gammaAt = glsl.indexOf("czm_gammaCorrect(color)");
  const scaleAt = glsl.indexOf("out_FragColor.rgb *= u_discRadiance;");
  assert.ok(
    gammaAt > 0 && scaleAt > gammaAt,
    "the scale must follow the decode",
  );
  assert.match(glsl, /uniform float u_discRadiance;/);
  // NEGATIVE CONTROL — an alpha scale reinstates the negative destination
  // weight this row exists to avoid.
  assert.doesNotMatch(codeOf(glsl), /out_FragColor\.a\s*\*=\s*u_discRadiance/);

  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  const wgslGamma = env.indexOf("pow(color.rgb, vec3f(u.gamma))");
  const wgslScale = env.indexOf("color.rgb * u.discRadiance");
  assert.ok(wgslGamma > 0 && wgslScale > wgslGamma);
  assert.match(env, /color = vec4f\(color\.rgb \* u\.discRadiance, color\.a\)/);
  assert.doesNotMatch(codeOf(env), /color\.a \* u\.discRadiance/);
});

test("C12-19: the WebGPU slot is the former `_sunPad1` — no uniform growth, no new define bit", () => {
  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /encodedSunLow: vec3<f32>, discRadiance: f32,/);
  assert.doesNotMatch(
    env,
    /_sunPad1\s*:\s*f32/,
    "the pad must be renamed, not added to",
  );
  // The slot is offset 39 — the last float of the existing 40-float pack.
  assert.match(env, /uniformData\[39\] =\s*typeof discRadiance === "number"/);
  assert.doesNotMatch(
    codeOf(env),
    /uniformData\[40\]/,
    "no uniform-buffer growth",
  );
  // C12 exit condition 5 — the low-word ShaderDefine registry is exhausted.
  const sunWgslStart = env.indexOf("const SUN_SHADER_WGSL = `");
  const sunWgslEnd = env.indexOf("`;", sunWgslStart);
  const sunWgsl = env.slice(sunWgslStart, sunWgslEnd);
  assert.doesNotMatch(sunWgsl, /\/\/>>ifdef/, "no new shader define");
});

test("C12-19: `Sun.js` feeds the uniform from the SAME publication WebGPU reads", () => {
  const src = readEngine("Scene/Sun.js");
  assert.match(
    src,
    /u_discRadiance: function \(\) \{\s*return that\._discRadiance;/,
  );
  assert.match(src, /this\._discRadiance = halo\.discRadiance;/);
  // The radiance is NOT bake payload: it must not enter the rebuild key, or
  // the WebGPU CPU bake would re-run whenever `scene.light` moves (which the
  // `aerialPerspective` derived light does every frame).
  const keyLine = src.match(/_bakedAppearanceKey = [^;]+;/g) ?? [];
  for (const line of keyLine) {
    assert.doesNotMatch(line, /discRadiance/);
  }
  const halo = readEngine("Scene/SunHaloAppearance.js");
  const keyAssign = halo.match(/result\.key\s*=\s*[^;]+;/);
  assert.ok(keyAssign);
  assert.doesNotMatch(keyAssign[0], /Radiance/);
});

// ───────────────────────────────────────────────────────────────────────────
// 8. The C12-18 halo continuity invariant, RE-DERIVED
// ───────────────────────────────────────────────────────────────────────────

async function resolve(lighting, useHDR, light) {
  const M = await importEngine("Scene/SunHaloAppearance.js");
  const result = M.createSunHaloAppearance();
  return M.readSunHaloAppearance(
    {
      atmosphericConditions: { lighting },
      sunBloomActive: true,
      useHDR: useHDR,
      light: light,
    },
    GLOW_LENGTH_TS,
    result,
  );
}

test("C12-19: halo amplitude scales with the disc — the B906 invariant becomes radiance-free", async () => {
  const D = await importEngine("Scene/SolarDiscModel.js");
  for (const [useHDR, light, expected] of [
    [false, whiteSunLight, 1.0],
    [true, whiteSunLight, 2.0],
    [true, { intensity: 6.0, color: { red: 1, green: 1, blue: 1 } }, 6.0],
  ]) {
    const r = await resolve({}, useHDR, light);
    assert.equal(r.discRadiance, expected);
    assert.equal(r.haloAmplitude, D.SOLAR_HALO_AMPLITUDE * expected);
    // The invariant, as arithmetic: the halo is always the same FRACTION of
    // the disc, at every radiance. Before this row it was 0.75 / radiance.
    assert.ok(
      Math.abs(r.haloAmplitude / r.discRadiance - D.SOLAR_HALO_AMPLITUDE) <
        1e-15,
      "halo/disc must be the constant 0.75",
    );
  }
});

test("C12-19: MUTANT REJECTED — an unscaled haloAmplitude breaks continuity at radiance > 1", async () => {
  const D = await importEngine("Scene/SolarDiscModel.js");
  const src = readEngine("Scene/SunHaloAppearance.js");
  const assignments = [
    ...src.matchAll(/result\.haloAmplitude\s*=\s*([^;]+);/g),
  ].map((m) => m[1].trim());
  assert.equal(assignments.length, 1, "haloAmplitude assigned exactly once");
  assert.equal(assignments[0], "SOLAR_HALO_AMPLITUDE * result.discRadiance");
  // The mutant (`= SOLAR_HALO_AMPLITUDE`) would make the halo 0.375 of the
  // disc at the shipped radiance — a sun less than half as glowing as its own
  // C12-16 curve says it is.
  const mutantFraction = D.SOLAR_HALO_AMPLITUDE / 2.0;
  assert.ok(mutantFraction < 0.5 * D.SOLAR_HALO_AMPLITUDE + 1e-15);
});

// ───────────────────────────────────────────────────────────────────────────
// 9. Identity positions
// ───────────────────────────────────────────────────────────────────────────

test("C12-19: SDR is an exact identity across the whole row", async () => {
  const D = await importEngine("Scene/SolarDiscModel.js");
  const r = await resolve({}, false, whiteSunLight);
  assert.equal(r.discRadiance, 1.0);
  assert.equal(r.haloAmplitude, D.SOLAR_HALO_AMPLITUDE);
  assert.equal(r.brightPassThreshold, 0.25);
  assert.equal(r.brightPassOffset, 0.1);
});

test("C12-19: `enableTrueSolarRadiance === false` is an exact identity in BOTH ranges", async () => {
  const D = await importEngine("Scene/SolarDiscModel.js");
  for (const useHDR of [false, true]) {
    const r = await resolve({ enableTrueSolarRadiance: false }, useHDR, {
      intensity: 40.0,
      color: { red: 1, green: 1, blue: 1 },
    });
    assert.equal(r.trueRadiance, false);
    assert.equal(r.discRadiance, 1.0);
    assert.equal(r.haloAmplitude, D.SOLAR_HALO_AMPLITUDE);
    assert.equal(r.brightPassThreshold, 0.25);
    assert.equal(r.brightPassOffset, 0.1);
  }
  // ...and the toggle follows the `!== false` convention of its two siblings.
  const on = await resolve(
    { enableTrueSolarRadiance: true },
    true,
    whiteSunLight,
  );
  const absent = await resolve({}, true, whiteSunLight);
  assert.equal(on.discRadiance, absent.discRadiance);
  assert.equal(absent.trueRadiance, true);
});

test("C12-19: an unpublished frame degrades to the SDR identity, never to a dark sun", async () => {
  const M = await importEngine("Scene/SunHaloAppearance.js");
  const D = await importEngine("Scene/SolarDiscModel.js");
  const fresh = M.createSunHaloAppearance();
  assert.equal(fresh.discRadiance, D.SOLAR_DISC_SDR_RADIANCE);
  assert.equal(fresh.brightPassThreshold, 0.25);
  assert.equal(fresh.brightPassOffset, 0.1);
  // ...and the WebGPU pack's fallback is the same number.
  const env = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(env, /typeof discRadiance === "number" \? discRadiance : 1\.0/);
});
