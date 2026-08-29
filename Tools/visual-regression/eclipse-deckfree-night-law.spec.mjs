// @purpose Re-derives the shipped globe night/day fragment law in both dialects and checks the deck-free eclipse diagnostic's closed form against banked pixels (Q-78).
// @status ACTIVE

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS,
  DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
  DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE,
  DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
  DECK_FREE_EXPECTED_LIGHTING_FADE,
  DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
  DECK_FREE_RAW_BASE_COLOR_LUMA,
  computeDeckFreeDirectionalDiagnosticLuma,
  computeDeckFreeEffectiveNightDarkness,
  computeDeckFreeNightBlend,
  computeDeckFreeNightDarkeningMultiplier,
} from "./lib/c13-41-deckfree-control.mjs";
import { BAND_MEAN_CAPTURE_DELTA } from "./lib/eclipse-cloud-response-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineShaders = path.join(
  here,
  "..",
  "..",
  "packages",
  "engine",
  "Source",
  "Shaders",
);
const readShader = (relative) =>
  fs.readFileSync(path.join(engineShaders, relative), "utf8");

/**
 * The four deck-free diagnostic band means, WebGPU, as rendered by the shipped
 * fragment.
 *
 * Provenance: Edge tranche 3d, 2026-08-29, run under `--serve-built` with the
 * served entry md5 equal to the on-disk md5, so this is not the live-esbuild
 * artefact that voided the tranche's first pass. Source file
 * `Tools/visual-regression/output/edge-tranche3d-2026-08-29/J4-eclipse-cloud-response-report.json`,
 * key `webgpuCloudLanes.deckFreeControl.directionalDiagnostic[i]`. All four
 * ABBA legs (`offA`, `offB`, `onA`, `onB`) carry the same value to the last
 * digit, which is what the eclipse-invariance predicate expects of a custom
 * DirectionalLight.
 */
const BANKED_DIAGNOSTIC_MEANS = Object.freeze([
  0.1146870588235741, 0.20012784313720947, 0.3315262745099332,
  0.5094329411766432,
]);

/**
 * The same four rungs as they read BEFORE the night epic put a procedural
 * floor on the night side. Kept as the historical control that dates the
 * divergence, never as an expectation: run bef98b53, SHA-256
 * 63ab81ab...b20293, quoted in `eclipse-cloud-response-gate.spec.mjs` K8.
 */
const HISTORICAL_PRE_NIGHT_FLOOR_MEANS = Object.freeze([
  0.3146870588234545, 0.4667945098038767, 0.6099576470587704,
  0.7514533333337392,
]);

// Two capture deltas, the tolerance the shipped fold already uses for these
// pixels: one for the 8-bit band mean, one for the analytic-normal drift over
// the sub-2 km diagnostic patch.
const DIAGNOSTIC_PIXEL_TOLERANCE = BAND_MEAN_CAPTURE_DELTA * 2;

const REC709 = [0.2126, 0.7152, 0.0722];
const WARM_GLOW_LUMA = 0.95 * REC709[0] + 0.45 * REC709[1] + 0.15 * REC709[2];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const mix = (a, b, t) => a + (b - a) * t;

/**
 * The shipped WGSL fragment path, transcribed from
 * `packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl` for the
 * deck-free configuration: no imagery layer, no vertex normals, no shadow, no
 * ground atmosphere, one grey base colour.
 *
 * Transcribed lines, in execution order:
 *   :2244-2246  computeDayNightFade      clamp(NdotL * 5, 0, 1)
 *   :4479-4485  dayFade / nightBlend
 *   :5009-5020  eclipseAbsolute / eclipseRelative from the gate
 *   :5044-5046  the night-darkening multiply, AHEAD of the lighting arms
 *   :2254-2256  computeDayNightDiffuse   clamp(NdotL * 5 + 0.3, 0, 1)
 *   :5096-5097  the DAYNIGHT arm and its camera-distance mix
 *   :5105       the light-colour multiply
 *   :5110-5115  the surface eclipse select
 *   :2266-2273  computeTerminatorGlow
 *   :5122-5128  the additive glow, scaled by the ABSOLUTE factor
 *
 * `nightDarkeningIsLive` exists so a mutant can make that one term
 * unreachable without deleting it.
 */
function wgslGlobeSurfaceLuma(options) {
  const {
    baseLuma = DECK_FREE_RAW_BASE_COLOR_LUMA,
    ndotl,
    lightingFade,
    effectiveNightDarkness,
    terminatorGlowStrength,
    lightColorLuma = 1,
    eclipseGate = 0,
    eclipseFragmentFactor = 1,
    invSceneLightFactor = 1,
    nightDarkeningIsLive = true,
  } = options;

  const dayFade = clamp(Math.max(ndotl, 0) * 5, 0, 1);
  const nightBlend = 1 - dayFade;

  let eclipseAbsolute = 1;
  let eclipseRelative = 1;
  if (eclipseGate > 0.5) {
    if (eclipseGate < 2.5) {
      eclipseAbsolute = eclipseFragmentFactor;
    }
    eclipseRelative = eclipseAbsolute * invSceneLightFactor;
  }

  let color = baseLuma;
  if (nightDarkeningIsLive && effectiveNightDarkness < 1) {
    color = color * mix(1, effectiveNightDarkness, nightBlend);
  }

  const dayNightDiffuse = clamp(Math.max(ndotl, 0) * 5 + 0.3, 0, 1);
  const diffuse = mix(1, dayNightDiffuse, clamp(lightingFade, 0, 1));
  color = color * diffuse * lightColorLuma;

  color =
    color *
    (eclipseGate > 1.5 && eclipseGate < 3.5
      ? eclipseRelative
      : eclipseAbsolute);

  const strength = Math.max(terminatorGlowStrength, 0);
  if (strength > 0) {
    color +=
      WARM_GLOW_LUMA *
      Math.exp(-ndotl * ndotl * 40) *
      0.15 *
      strength *
      eclipseAbsolute;
  }
  return color;
}

/**
 * The shipped GLSL fragment path, transcribed from
 * `packages/engine/Source/Shaders/GlobeFS.glsl` under the same configuration —
 * `ENABLE_DAYNIGHT_SHADING`, `APPLY_NIGHT_DARKNESS`,
 * `ENABLE_ECLIPSE_GLOBE_SHADOW`.
 *
 * Transcribed lines, in execution order:
 *   :705       nightBlend = 1 - clamp(lambert * 5, 0, 1)
 *   :928       color.rgb *= mix(1, u_nightDarkness, nightBlend)
 *   :935-937   the DAYNIGHT arm, its `fade` mix and czm_lightColor
 *   :955-968   eclipseAbsolute / eclipseRelative from the same gate
 *   :970-976   the surface select on gates 2 and 3
 *   :980       terminatorGlowEclipse = eclipseAbsolute
 *   :659-665   computeTerminatorGlow
 *   :985-1000  the additive glow
 */
function glslGlobeSurfaceLuma(options) {
  const {
    baseLuma = DECK_FREE_RAW_BASE_COLOR_LUMA,
    ndotl,
    lightingFade,
    effectiveNightDarkness,
    terminatorGlowStrength,
    lightColorLuma = 1,
    eclipseGate = 0,
    eclipseFragmentFactor = 1,
    invSceneLightFactor = 1,
    nightDarkeningIsLive = true,
    eclipseGlobeShadowDefined = true,
  } = options;

  const nightBlend = 1 - clamp(Math.max(ndotl, 0) * 5, 0, 1);

  let color = baseLuma;
  if (nightDarkeningIsLive && effectiveNightDarkness < 1) {
    color = color * mix(1, effectiveNightDarkness, nightBlend);
  }

  let diffuseIntensity = clamp(Math.max(ndotl, 0) * 5 + 0.3, 0, 1);
  diffuseIntensity = mix(1, diffuseIntensity, clamp(lightingFade, 0, 1));
  let finalColor = color * lightColorLuma * diffuseIntensity;

  // :943 — the value the glow carries when ENABLE_ECLIPSE_GLOBE_SHADOW is not
  // defined at all. Everything below it lives inside that #ifdef.
  let terminatorGlowEclipse = 1;
  if (eclipseGlobeShadowDefined) {
    let eclipseAbsolute = 1;
    let eclipseRelative = 1;
    if (eclipseGate > 0.5) {
      if (eclipseGate < 2.5) {
        eclipseAbsolute = eclipseFragmentFactor;
      }
      eclipseRelative = eclipseAbsolute * invSceneLightFactor;
    }
    finalColor =
      finalColor *
      (eclipseGate > 1.5 && eclipseGate < 3.5
        ? eclipseRelative
        : eclipseAbsolute);
    terminatorGlowEclipse = eclipseAbsolute;
  }

  const strength = Math.max(terminatorGlowStrength, 0);
  if (strength > 0) {
    finalColor +=
      WARM_GLOW_LUMA *
      Math.exp(-ndotl * ndotl * 40) *
      0.15 *
      strength *
      terminatorGlowEclipse;
  }
  return finalColor;
}

const pinnedEffectiveNightDarkness = computeDeckFreeEffectiveNightDarkness(
  DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS,
  DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
);
const alternateEffectiveNightDarkness = computeDeckFreeEffectiveNightDarkness(
  DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE,
  DECK_FREE_EXPECTED_NIGHT_LAYER_COVERAGE,
);

const diagnosticRung = (index, overrides = {}) => ({
  ndotl: DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index],
  lightingFade: DECK_FREE_EXPECTED_LIGHTING_FADE,
  effectiveNightDarkness: pinnedEffectiveNightDarkness,
  terminatorGlowStrength: DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
  ...overrides,
});

test("N1 the closed form with the night floor reproduces every banked rung inside the shipped band", () => {
  const residuals = BANKED_DIAGNOSTIC_MEANS.map((measured, index) => {
    const predicted = computeDeckFreeDirectionalDiagnosticLuma(
      DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index],
      DECK_FREE_EXPECTED_LIGHTING_FADE,
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
      pinnedEffectiveNightDarkness,
    );
    return Math.abs(predicted - measured);
  });
  assert.equal(residuals.length, 4);
  for (const [index, residual] of residuals.entries()) {
    assert.ok(
      residual <= DIAGNOSTIC_PIXEL_TOLERANCE,
      `rung ${index} residual ${residual} exceeds ${DIAGNOSTIC_PIXEL_TOLERANCE}`,
    );
  }
  // Five times inside the band, not merely inside it — the residual is 8-bit
  // quantization plus the patch's own normal drift, and nothing else.
  assert.ok(Math.max(...residuals) < 0.0016);
});

test("N2 the stale closed form — the Q-78 red — misses every banked rung by more than 0.2", () => {
  const misses = BANKED_DIAGNOSTIC_MEANS.map((measured, index) => {
    const ndotl = DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index];
    const stale = wgslGlobeSurfaceLuma(
      diagnosticRung(index, { nightDarkeningIsLive: false }),
    );
    assert.ok(computeDeckFreeNightBlend(ndotl) > 0);
    return stale - measured;
  });
  for (const [index, miss] of misses.entries()) {
    assert.ok(
      miss > 0.2,
      `rung ${index} stale-vs-measured gap ${miss} is not the reported divergence`,
    );
  }
  // The reported rung 0 and rung 3 numbers, to the digit.
  assert.equal(
    Number(
      wgslGlobeSurfaceLuma(
        diagnosticRung(0, { nightDarkeningIsLive: false }),
      ).toFixed(14),
    ),
    0.31549011764706,
  );
  assert.equal(
    Number(
      wgslGlobeSurfaceLuma(
        diagnosticRung(3, { nightDarkeningIsLive: false }),
      ).toFixed(14),
    ),
    0.75096392847618,
  );
});

test("N3 the historical pre-floor means are what an INERT night term renders, which dates the drift", () => {
  // The same four rungs, before the floor reached the surface, match the
  // inert-term evaluation — so the instrument was correct when it was written
  // and the engine is correct now; only the closed form stayed behind.
  for (const [index, measured] of HISTORICAL_PRE_NIGHT_FLOOR_MEANS.entries()) {
    const inert = wgslGlobeSurfaceLuma(
      diagnosticRung(index, { nightDarkeningIsLive: false }),
    );
    assert.ok(
      Math.abs(inert - measured) <= DIAGNOSTIC_PIXEL_TOLERANCE,
      `historical rung ${index} does not match the inert-term evaluation`,
    );
    // And it is NOT what the live term renders: the whole ladder separates by
    // at least 0.199, twenty-four times the band.
    const live = wgslGlobeSurfaceLuma(diagnosticRung(index));
    assert.ok(Math.abs(live - measured) > 0.199);
  }
});

test("N4 both dialects place the night floor, the diffuse and the additive glow in the same order", () => {
  const cases = [
    ...DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS.map((_, index) =>
      diagnosticRung(index),
    ),
    diagnosticRung(0, {
      effectiveNightDarkness: alternateEffectiveNightDarkness,
    }),
    // The product globe: glow off, floor live, full day/night fade.
    diagnosticRung(2, { terminatorGlowStrength: 0 }),
    // A custom light colour, which both dialects multiply into the surface.
    diagnosticRung(1, { lightColorLuma: 0.5 }),
  ];
  for (const [index, options] of cases.entries()) {
    const wgsl = wgslGlobeSurfaceLuma(options);
    const glsl = glslGlobeSurfaceLuma(options);
    assert.ok(
      Object.is(wgsl, glsl),
      `case ${index}: WGSL ${wgsl} and GLSL ${glsl} are not bit-identical`,
    );
  }
  // The Node oracle the fold uses is the same number as the two dialects.
  for (
    let index = 0;
    index < DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS.length;
    index++
  ) {
    const oracle = computeDeckFreeDirectionalDiagnosticLuma(
      DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[index],
      DECK_FREE_EXPECTED_LIGHTING_FADE,
      DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
      pinnedEffectiveNightDarkness,
    );
    assert.ok(Object.is(oracle, wgslGlobeSurfaceLuma(diagnosticRung(index))));
    assert.ok(Object.is(oracle, glslGlobeSurfaceLuma(diagnosticRung(index))));
  }
});

test("N5 INERTNESS MUTANT — an unreachable night floor breaks the banked agreement in both dialects", () => {
  for (const evaluate of [wgslGlobeSurfaceLuma, glslGlobeSurfaceLuma]) {
    for (const [index, measured] of BANKED_DIAGNOSTIC_MEANS.entries()) {
      const live = evaluate(diagnosticRung(index));
      const inert = evaluate(
        diagnosticRung(index, { nightDarkeningIsLive: false }),
      );
      assert.ok(Math.abs(live - measured) <= DIAGNOSTIC_PIXEL_TOLERANCE);
      assert.ok(Math.abs(inert - measured) > DIAGNOSTIC_PIXEL_TOLERANCE);
    }
  }
});

test("N6 the two pinned floors are resolvable in the pixels, which is what makes the term measured", () => {
  const primary = computeDeckFreeDirectionalDiagnosticLuma(
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[0],
    DECK_FREE_EXPECTED_LIGHTING_FADE,
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
    pinnedEffectiveNightDarkness,
  );
  const alternate = computeDeckFreeDirectionalDiagnosticLuma(
    DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS[0],
    DECK_FREE_EXPECTED_LIGHTING_FADE,
    DECK_FREE_DIAGNOSTIC_TERMINATOR_GLOW_STRENGTH,
    alternateEffectiveNightDarkness,
  );
  const separation = Math.abs(alternate - primary);
  // Rung 0 sits at N·L = 0, where the ramp is fully night, so the separation
  // is the raw base luma times the difference between the two floors.
  assert.ok(
    Math.abs(
      separation -
        DECK_FREE_RAW_BASE_COLOR_LUMA *
          0.3 *
          (DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS_ALTERNATE -
            DECK_FREE_DIAGNOSTIC_NIGHT_DARKNESS),
    ) < 1e-12,
  );
  assert.ok(separation > DIAGNOSTIC_PIXEL_TOLERANCE * 10);
  assert.ok(Object.is(primary, wgslGlobeSurfaceLuma(diagnosticRung(0))));
  assert.ok(
    Object.is(
      alternate,
      wgslGlobeSurfaceLuma(
        diagnosticRung(0, {
          effectiveNightDarkness: alternateEffectiveNightDarkness,
        }),
      ),
    ),
  );
});

test("N7 the diagnostic's ON/OFF identity to the last digit is the gate arithmetic, not a defect", () => {
  // The deck-free control disables the fragment-local eclipse-globe shadow and
  // installs a custom DirectionalLight, so `EclipseGlobeShadow` publishes
  // either gate 0 (inert; `resetEclipseGlobeShadow`,
  // `packages/engine/Source/Scene/EclipseGlobeShadow.js:563`) or gate 4
  // (correction-only, custom light; `:597`). Gate 4 leaves `eclipseAbsolute`
  // at 1 because the fragment factor is only evaluated below 2.5, and the
  // surface select takes the ABSOLUTE branch because 4 is not below 3.5.
  for (const evaluate of [wgslGlobeSurfaceLuma, glslGlobeSurfaceLuma]) {
    for (let index = 0; index < 4; index++) {
      const off = evaluate(diagnosticRung(index, { eclipseGate: 0 }));
      const on = evaluate(
        diagnosticRung(index, {
          eclipseGate: 4,
          // A real correction reciprocal, which gate 4 must NOT apply.
          invSceneLightFactor: 1 / 0.4640972577439927,
          eclipseFragmentFactor: 0.3,
        }),
      );
      assert.ok(
        Object.is(off, on),
        `rung ${index}: gates 0 and 4 are not bit-identical (${off} vs ${on})`,
      );
    }
  }
  // And it is a real invariance, not a dead branch: gate 1, the ACTIVE
  // custom-light gate, does dim by the fragment factor.
  const undimmed = wgslGlobeSurfaceLuma(diagnosticRung(1, { eclipseGate: 0 }));
  const dimmed = wgslGlobeSurfaceLuma(
    diagnosticRung(1, { eclipseGate: 1, eclipseFragmentFactor: 0.3 }),
  );
  assert.ok(dimmed < undimmed);
});

test("N8 the SunLight lane dims by exactly the fragment factor on both dialects", () => {
  // Gate 2: the camera-anchored factor already rode in on czm_lightColor /
  // camera.lightColor, and the surface replaces it with this fragment's own by
  // multiplying the relative factor. The banked rung-3 published factor is the
  // camera anchor; the fragment factor is the quantity the pixel must show.
  const cameraFactor = 0.4640972577439927;
  const fragmentFactor = 0.3117;
  for (const evaluate of [wgslGlobeSurfaceLuma, glslGlobeSurfaceLuma]) {
    const undimmed = evaluate(
      diagnosticRung(3, { terminatorGlowStrength: 0, eclipseGate: 0 }),
    );
    const dimmed = evaluate(
      diagnosticRung(3, {
        terminatorGlowStrength: 0,
        eclipseGate: 2,
        lightColorLuma: cameraFactor,
        invSceneLightFactor: 1 / cameraFactor,
        eclipseFragmentFactor: fragmentFactor,
      }),
    );
    assert.ok(undimmed > 0);
    const ratio = dimmed / undimmed;
    assert.ok(
      Math.abs(ratio - fragmentFactor) < 1e-12,
      `dimmed/undimmed ${ratio} is not the fragment factor ${fragmentFactor}`,
    );
  }
});

test("N9 the independently modelled terms are the ones the fold multiplies", () => {
  for (const [index, ndotl] of DECK_FREE_DIAGNOSTIC_NDOTL_TARGETS.entries()) {
    const nightBlend = computeDeckFreeNightBlend(ndotl);
    const multiplier = computeDeckFreeNightDarkeningMultiplier(
      ndotl,
      pinnedEffectiveNightDarkness,
    );
    assert.equal(nightBlend, 1 - Math.min(1, Math.max(0, ndotl * 5)));
    assert.ok(
      Math.abs(
        multiplier - (1 + (pinnedEffectiveNightDarkness - 1) * nightBlend),
      ) < 1e-15,
    );
    assert.ok(multiplier > 0 && multiplier <= 1);
    assert.ok(index < 4);
  }
  // The coverage fold: a night layer that fully covers the night side scales
  // the floor back to the identity, which is the value that shuts the guard.
  assert.equal(computeDeckFreeEffectiveNightDarkness(0.15, 1), 1);
  assert.equal(computeDeckFreeEffectiveNightDarkness(1, 0), 1);
  assert.equal(computeDeckFreeNightBlend(Number.NaN), null);
  assert.equal(computeDeckFreeNightDarkeningMultiplier(0, 1.5), null);
});

test("N10 SOURCE ANCHOR — both dialects still carry the floor ahead of their lighting arms", () => {
  // A drift alarm, not the proof: N1-N8 are the behavioural half. This only
  // asserts that the two transcriptions above still describe the files.
  const wgsl = readShader(path.join("WebGPU", "Globe", "GlobeTerrain.wgsl"));
  const glsl = readShader("GlobeFS.glsl");

  const wgslFloor = wgsl.indexOf(
    "color = color * mix(1.0, effectiveNightDarkness, nightBlend);",
  );
  const wgslDiffuse = wgsl.indexOf(
    "color = color * diffuse * camera.lightColor.rgb;",
  );
  const wgslGlow = wgsl.indexOf(
    "computeTerminatorGlow(dayNightNormalEC, sunDir) *",
  );
  // The anchor must exist exactly once: a `> 0` test went false-green when the
  // shader text moved under it, so absence and duplication are both rejected.
  assert.ok(wgslFloor !== -1 && wgslDiffuse !== -1 && wgslGlow !== -1);
  assert.equal(
    wgsl.lastIndexOf(
      "color = color * mix(1.0, effectiveNightDarkness, nightBlend);",
    ),
    wgslFloor,
  );
  assert.ok(wgslDiffuse > wgslFloor && wgslGlow > wgslDiffuse);

  const glslFloor = glsl.indexOf(
    "color.rgb *= mix(1.0, effectiveNightDarkness, nightBlend);",
  );
  const glslDiffuse = glsl.indexOf(
    "float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);",
  );
  const glslGlow = glsl.indexOf("finalColor.rgb +=");
  assert.ok(glslFloor !== -1 && glslDiffuse !== -1 && glslGlow !== -1);
  assert.equal(
    glsl.lastIndexOf(
      "color.rgb *= mix(1.0, effectiveNightDarkness, nightBlend);",
    ),
    glslFloor,
  );
  assert.ok(glslDiffuse > glslFloor && glslGlow > glslDiffuse);

  // The two ramps are different expressions and must stay different: the floor
  // rides the bare `* 5` ramp, the diffuse the `* 5 + 0.3` one.
  assert.ok(
    wgsl.includes("return clamp(lambertDiffuse * 5.0, 0.0, 1.0);") &&
      wgsl.includes("return clamp(lambertDiffuse * 5.0 + 0.3, 0.0, 1.0);"),
  );
  assert.ok(
    glsl.includes(
      "float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);",
    ),
  );
  // Both glow implementations carry the same three constants.
  for (const source of [wgsl, glsl]) {
    assert.ok(source.includes("exp(-NdotL * NdotL * 40.0)"));
    assert.ok(source.includes("0.95, 0.45, 0.15"));
    assert.ok(source.includes("terminatorFactor * 0.15"));
  }
});
