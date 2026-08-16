// daynight-terminator-law.spec.mjs — CLT-B1's Node-testable half.
// @purpose CLT-B1 Node half: transcribed laws vs shaders, calibration inversion, ramp classifier, structural exit codes — all mutant-rejected.
// @status ACTIVE
//
// WHAT IS PINNED HERE, AND WHY IT IS NOT THE PROBE'S JOB. An Edge run of
// `probe-daynight-terminator-law.mjs` can only tell you what the pixels said.
// Everything BELOW the pixels — whether the transcribed laws still match the
// shaders, whether the calibration inversion is sound, whether the ramp
// classifier can tell the recorded `+0.5` offset apart from a constant normal,
// whether a lane that cannot see its subject exits 3 rather than 0 — is
// arithmetic, and arithmetic that is only exercised by a browser run is
// arithmetic nobody checks when the browser run is red for an unrelated reason.
//
// Section E is the part that earns its keep: every predicate the probe scores
// is run against a DELIBERATELY WRONG input and required to reject it. A gate
// that passes both the right and the wrong answer certifies nothing.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read is normalised to
// `\n` first.
//
// Run: node --test Tools/visual-regression/daynight-terminator-law.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXIT_CODE,
  LANE,
  DIVERGENCE_BAND,
  FIT_WINDOW,
  SOLSTICE_DISCRIMINATOR,
  dayFadeGlsl,
  dayFadeWgsl,
  nightBlendGlsl,
  nightBlendWgsl,
  calibrationHealth,
  invertCalibration,
  binByNdotL,
  rmseAgainst,
  centralSlope,
  alphaAtTerminator,
  classifyRamp,
  evaluateRampLane,
  evaluateSentinelLane,
  evaluateCameraFadeLane,
  evaluateSolsticeLane,
  foldVerdict,
} from "./lib/daynight-terminator-law.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const PROBE_PATH = "Tools/visual-regression/probe-daynight-terminator-law.mjs";
const probe = read(PROBE_PATH);
const glsl = read("packages/engine/Source/Shaders/GlobeFS.glsl");
const wgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const shaderSet = read("packages/engine/Source/Scene/GlobeSurfaceShaderSet.js");

// ─── A. the transcribed laws still match the shaders ─────────────────────────

test("A1: the GLSL night-blend law is transcribed verbatim", () => {
  // If this line moves, `dayFadeGlsl` is a stale twin and every residual the
  // probe prints is measured against the wrong reference.
  assert.match(
    glsl,
    /float nightBlend = 1\.0 - clamp\(czm_getLambertDiffuse\(czm_lightDirectionEC, normalEC\) \* 5\.0, 0\.0, 1\.0\);/,
    "GlobeFS.glsl's night-blend law changed — update dayFadeGlsl with it",
  );
  // And it is guarded by both defines, which is finding (c)'s static half.
  assert.match(
    glsl,
    /#if defined\(APPLY_DAY_NIGHT_ALPHA\) && defined\(ENABLE_DAYNIGHT_SHADING\)\n\s*float nightBlend = 1\.0/,
  );
});

test("A2: the SHIPPED WGSL day-fade law is now GLSL's, and `dayFadeWgsl` is the retired one", () => {
  // CLT-B4 CLOSED at Batch 925 (CO-18). This assertion used to require the
  // `+0.5` to still be in the shader. It now requires the opposite — but
  // `dayFadeWgsl` in the lib is DELIBERATELY LEFT AT THE OLD LAW, because it is
  // no longer a transcription: it is the classifier's ALTERNATIVE HYPOTHESIS.
  // `classifyRamp` separates a backend's measured ramp by comparing residuals
  // against `dayFadeGlsl` and `dayFadeWgsl`; making the two functions identical
  // would collapse every verdict to "ambiguous" and blind the probe. So the
  // instrument keeps both laws and the SHADER keeps one.
  assert.match(
    wgsl,
    /fn computeDayNightFade\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{\n\s*let lambertDiffuse = max\(dot\(sunDirEC, normalEC\), 0\.0\);\n\s*return clamp\(lambertDiffuse \* 5\.0, 0\.0, 1\.0\);/,
    "GlobeTerrain.wgsl's day-fade law is no longer GLSL's — CLT-B4 regressed, " +
      "or the expression was reformatted and this pin needs re-anchoring",
  );
  assert.doesNotMatch(
    wgsl,
    /return clamp\(\s*(?:NdotL|lambertDiffuse)\s*\* 5\.0 \+ 0\.5, 0\.0, 1\.0\);/,
    "the +0.5 offset is back in the shader",
  );
  // The SECOND expression WebGL has always had — the lighting one — is now
  // present as its own function rather than reusing the alpha ramp.
  assert.match(
    wgsl,
    /fn computeDayNightDiffuse\(normalEC: vec3<f32>, sunDirEC: vec3<f32>\) -> f32 \{\n\s*let lambertDiffuse = max\(dot\(sunDirEC, normalEC\), 0\.0\);\n\s*return clamp\(lambertDiffuse \* 5\.0 \+ 0\.3, 0\.0, 1\.0\);/,
    "the WGSL lighting expression must be GLSL:829's `N·L*5 + 0.3`, distinct " +
      "from the alpha ramp",
  );
});

test("A3: the shipped law and the retired law still differ by 0.5 at the terminator", () => {
  // This is what keeps `classifyRamp` able to name which law a backend runs.
  // If it ever became 0, the probe could no longer tell a fixed backend from a
  // broken one — the separation IS the instrument.
  assert.equal(dayFadeGlsl(0), 0);
  assert.equal(dayFadeWgsl(0), 0.5);
  assert.equal(nightBlendGlsl(0), 1);
  assert.equal(nightBlendWgsl(0), 0.5);
  assert.equal(nightBlendGlsl(0) - nightBlendWgsl(0), 0.5);
});

test("A4: the divergence band brackets both ramps and nothing more", () => {
  // Outside the band both laws are saturated, so a sample there discriminates
  // nothing. The band's own edges must be exactly where saturation begins.
  assert.equal(dayFadeWgsl(DIVERGENCE_BAND.min), 0);
  assert.equal(dayFadeGlsl(DIVERGENCE_BAND.max), 1);
  for (const ndotl of [-0.5, -0.2, -0.11]) {
    assert.equal(dayFadeGlsl(ndotl), 0);
    assert.equal(dayFadeWgsl(ndotl), 0);
  }
  for (const ndotl of [0.21, 0.4, 1]) {
    assert.equal(dayFadeGlsl(ndotl), 1);
    assert.equal(dayFadeWgsl(ndotl), 1);
  }
  assert.ok(FIT_WINDOW.min < DIVERGENCE_BAND.min);
  assert.ok(FIT_WINDOW.max > DIVERGENCE_BAND.max);
});

test("A5: the false 'Matches the GLSL path' comment is gone, and now it would be true", () => {
  // §2 bug 2's second half. The original form of this test required the WRONG
  // comment to still be present, so that correcting the prose without
  // correcting the law would fail loudly. CO-18 corrected the LAW, so the pin
  // inverts: the stale claim must be gone. The `+0.5` counter-pin lives in A2.
  assert.doesNotMatch(
    wgsl,
    /Matches the GLSL path/,
    "the retired 'Matches the GLSL path' comment is back — it described a " +
      "claim that was false for the +0.5 law and is now redundant for the " +
      "reconciled one",
  );
  // And the replacement prose names the contract rather than asserting parity.
  assert.match(
    wgsl,
    /The day\/night ramp law: one law, two expressions, two consumers/,
    "the reconciled law's own explanation block is missing from the shader",
  );
});

// ─── B. the calibration instrument ───────────────────────────────────────────

test("B1: a monotone ladder with span inverts to the alpha that made it", () => {
  // A deliberately NON-linear transfer, to show the inversion does not assume
  // linearity: value = 255 * alpha^2.2 (a gamma-encoded output chain).
  const alphas = [0, 0.25, 0.5, 0.75, 0.999];
  const ladder = alphas.map((alpha) => ({
    alpha,
    value: 255 * Math.pow(alpha, 2.2),
  }));
  assert.equal(calibrationHealth(ladder).ok, true);
  for (const trueAlpha of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const value = 255 * Math.pow(trueAlpha, 2.2);
    const recovered = invertCalibration(ladder, value);
    assert.ok(
      Math.abs(recovered - trueAlpha) < 0.08,
      `recovered ${recovered} from ${trueAlpha} under a gamma transfer`,
    );
  }
});

test("B2: a flat ladder is rejected, not silently inverted", () => {
  const flat = [0, 0.25, 0.5, 0.75, 0.999].map((alpha) => ({
    alpha,
    value: 3,
  }));
  const health = calibrationHealth(flat);
  assert.equal(health.ok, false);
  assert.match(health.reason, /span/);
});

test("B3: a reversing ladder is rejected", () => {
  const bad = [
    { alpha: 0, value: 10 },
    { alpha: 0.5, value: 90 },
    { alpha: 0.999, value: 40 },
  ];
  assert.equal(calibrationHealth(bad).ok, false);
  assert.match(calibrationHealth(bad).reason, /reverses/);
});

test("B4: 8-bit noise does not count as a reversal", () => {
  const noisy = [
    { alpha: 0, value: 10 },
    { alpha: 0.25, value: 30 },
    { alpha: 0.5, value: 29 }, // one count of dither
    { alpha: 0.75, value: 60 },
    { alpha: 0.999, value: 80 },
  ];
  assert.equal(calibrationHealth(noisy, { noise: 2 }).ok, true);
});

test("B5: a flat bracket never produces a divide-by-zero interpolation", () => {
  // A flat run in the middle of a ladder is what an 8-bit readout does when two
  // rungs land on the same count. The contract is: resolve to the EARLIEST
  // bracket containing the value (a deterministic, in-range alpha), never
  // divide by a zero denominator, and never emit NaN.
  const ladder = [
    { alpha: 0, value: 0 },
    { alpha: 0.5, value: 50 },
    { alpha: 0.75, value: 50 },
    { alpha: 0.999, value: 120 },
  ];
  assert.equal(calibrationHealth(ladder).ok, true);
  assert.equal(invertCalibration(ladder, 50.0), 0.5);
  for (const value of [0, 25, 50, 85, 120, -5, 500]) {
    const alpha = invertCalibration(ladder, value);
    assert.ok(Number.isFinite(alpha), `inversion of ${value} was ${alpha}`);
    assert.ok(alpha >= 0 && alpha <= 0.999);
  }
  // A ladder whose TOP is flat is genuinely ambiguous at that level — the
  // inversion clamps to the top rung. The protection is upstream: such a
  // ladder has a tiny span and `calibrationHealth` drops the pixel before the
  // inversion is ever asked. That ordering is the invariant worth pinning.
  const topFlat = [
    { alpha: 0, value: 0 },
    { alpha: 0.5, value: 10 },
    { alpha: 0.75, value: 10 },
    { alpha: 0.999, value: 10 },
  ];
  assert.equal(calibrationHealth(topFlat).ok, false);
  assert.match(calibrationHealth(topFlat).reason, /span/);
  assert.equal(invertCalibration(topFlat, 10), 0.999);
});

// ─── C. the ramp classifier — the trap this row was written around ───────────

/** Synthesise binned samples from a law, at the probe's own bin width. */
function synthBins(law, { min = FIT_WINDOW.min, max = FIT_WINDOW.max } = {}) {
  const samples = [];
  for (let ndotl = min; ndotl <= max + 1e-9; ndotl += 0.002) {
    for (let k = 0; k < 12; k++) {
      samples.push({ ndotl, alpha: law(ndotl) });
    }
  }
  return binByNdotL(samples, { min, max, binWidth: 0.02, minCount: 8 });
}

function summarise(bins) {
  const scored = bins.filter(
    (b) => b.ndotl >= DIVERGENCE_BAND.min && b.ndotl <= DIVERGENCE_BAND.max,
  );
  const alphas = bins.map((b) => b.alpha);
  const range = Math.max(...alphas) - Math.min(...alphas);
  const rmseGlsl = rmseAgainst(scored, dayFadeGlsl);
  const rmseWgsl = rmseAgainst(scored, dayFadeWgsl);
  const slope = centralSlope(bins);
  return {
    bins,
    range,
    slope,
    rmseGlsl,
    rmseWgsl,
    atTerminator: alphaAtTerminator(bins),
    classification: classifyRamp({
      bins: scored,
      rmseGlsl,
      rmseWgsl,
      slope,
      range,
    }),
  };
}

test("C1: a GLSL-law ramp classifies as glsl-law", () => {
  const s = summarise(synthBins(dayFadeGlsl));
  assert.equal(s.classification.verdict, "glsl-law", s.classification.why);
  assert.ok(Math.abs(s.atTerminator - 0) < 0.06);
});

test("C2: a WGSL-offset ramp classifies as wgsl-offset-law", () => {
  const s = summarise(synthBins(dayFadeWgsl));
  assert.equal(
    s.classification.verdict,
    "wgsl-offset-law",
    s.classification.why,
  );
  assert.ok(Math.abs(s.atTerminator - 0.5) < 0.06);
});

test("C3: THE TRAP — a constant 0.5 ramp is NOT read as the offset law", () => {
  // This is the whole reason the classifier exists. A backend whose day/night
  // term reads a constant model-space normal produces exactly 0.5 at the
  // equinox — the number finding (a) predicts — with no ramp at all.
  const s = summarise(synthBins(() => 0.5));
  assert.equal(s.classification.verdict, "constant", s.classification.why);
  assert.ok(Math.abs(s.atTerminator - 0.5) < 1e-9);
  assert.match(
    s.classification.why,
    /not reading a per-fragment surface normal/,
  );
});

test("C4: a constant ramp makes lane A STRUCTURAL, never CONFIRMED", () => {
  const lane = evaluateRampLane({
    webgl: summarise(synthBins(dayFadeGlsl)),
    webgpu: summarise(synthBins(() => 0.5)),
  });
  assert.equal(lane.status, LANE.STRUCTURAL);
  assert.match(lane.failures[0], /NOT evidence for the recorded \+0\.5 offset/);
  assert.notEqual(foldVerdict({ lane }), EXIT_CODE.PASS);
});

test("C5: the honest both-laws case is CONFIRMED", () => {
  const lane = evaluateRampLane({
    webgl: summarise(synthBins(dayFadeGlsl)),
    webgpu: summarise(synthBins(dayFadeWgsl)),
  });
  assert.equal(lane.status, LANE.CONFIRMED, JSON.stringify(lane.failures));
  assert.ok(Math.abs(lane.metrics.terminator_delta - 0.5) < 0.06);
});

test("C6: two backends running the SAME law is REFUTED, not confirmed", () => {
  // If a future batch lands CLT-B4 and reconciles the ramp, this probe must
  // report the finding as refuted rather than quietly passing.
  const lane = evaluateRampLane({
    webgl: summarise(synthBins(dayFadeGlsl)),
    webgpu: summarise(synthBins(dayFadeGlsl)),
  });
  assert.equal(lane.status, LANE.REFUTED);
  assert.equal(foldVerdict({ lane }), EXIT_CODE.FAIL);
});

test("C7: too few bins is STRUCTURAL, not a verdict", () => {
  const thin = binByNdotL(
    [
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
      { ndotl: 0.0, alpha: 0.5 },
    ],
    { min: FIT_WINDOW.min, max: FIT_WINDOW.max, binWidth: 0.02, minCount: 8 },
  );
  const c = classifyRamp({
    bins: thin,
    rmseGlsl: 0.5,
    rmseWgsl: 0.0,
    slope: 0,
    range: 0,
  });
  assert.equal(c.verdict, "unmeasured");
});

test("C8: bins below the sample floor are dropped, not reported thin", () => {
  const samples = [
    ...Array.from({ length: 20 }, () => ({ ndotl: 0.01, alpha: 0.5 })),
    ...Array.from({ length: 3 }, () => ({ ndotl: 0.09, alpha: 0.9 })),
  ];
  const bins = binByNdotL(samples, {
    min: FIT_WINDOW.min,
    max: FIT_WINDOW.max,
    binWidth: 0.02,
    minCount: 8,
  });
  assert.equal(bins.length, 1);
  assert.equal(bins[0].count, 20);
});

// ─── D. the remaining lanes ──────────────────────────────────────────────────

test("D1: lane B confirms the sentinel only after the headroom control", () => {
  const lane = evaluateSentinelLane({ on: 22, off: 22, boosted: 38 });
  assert.equal(lane.status, LANE.CONFIRMED);
  assert.equal(lane.metrics.delta_off_minus_on, 0);
});

test("D2: lane B is STRUCTURAL when the emission cannot move the metric", () => {
  // off == on is vacuous if raising nightIntensity does nothing either — that
  // is a scene in which the emission term is simply unreachable.
  const lane = evaluateSentinelLane({ on: 6, off: 6, boosted: 6 });
  assert.equal(lane.status, LANE.STRUCTURAL);
  assert.match(lane.failures[0], /not reachable in this configuration/);
  assert.notEqual(foldVerdict({ lane }), EXIT_CODE.PASS);
});

test("D3: lane B REFUTES the bug when the toggle actually works", () => {
  const lane = evaluateSentinelLane({ on: 22, off: 6, boosted: 38 });
  assert.equal(lane.status, LANE.REFUTED);
  assert.match(lane.failures[0], /needs restating/);
});

test("D4: lane D confirms the camera fade with the predicted shape", () => {
  const lane = evaluateCameraFadeLane({
    webglLow: 1.0,
    webglHigh: 0.08,
    webgpuLow: 0.3,
    webgpuHigh: 0.31,
    rampVerdictWebgpu: "wgsl-offset-law",
  });
  assert.equal(lane.status, LANE.CONFIRMED, JSON.stringify(lane.failures));
});

test("D5: lane D declines to attribute when WebGPU's normal is constant", () => {
  const lane = evaluateCameraFadeLane({
    webglLow: 1.0,
    webglHigh: 0.08,
    webgpuLow: 1.0,
    webgpuHigh: 1.0,
    rampVerdictWebgpu: "constant",
  });
  assert.equal(lane.status, LANE.STRUCTURAL);
  assert.match(
    lane.failures.at(-1),
    /cannot be attributed to a missing camera fade/,
  );
});

test("D6: lane D refuses a WebGL leg that does not show the fade", () => {
  const lane = evaluateCameraFadeLane({
    webglLow: 0.3,
    webglHigh: 0.29,
    webgpuLow: 0.3,
    webgpuHigh: 0.3,
    rampVerdictWebgpu: "wgsl-offset-law",
  });
  assert.equal(lane.status, LANE.REFUTED);
  assert.equal(lane.failures.length, 2);
});

test("D7: lane E separates a constant normal from a per-fragment one", () => {
  const constant = evaluateSolsticeLane({
    webglRange: 0.95,
    webgpuRange: 0.01,
  });
  assert.equal(constant.status, LANE.CONFIRMED);
  assert.equal(constant.normalSource, "constant");

  const perFragment = evaluateSolsticeLane({
    webglRange: 0.95,
    webgpuRange: 0.9,
  });
  assert.equal(perFragment.normalSource, "per-fragment");
});

test("D8: lane E is STRUCTURAL when the REFERENCE shows no terminator", () => {
  // If WebGL itself is flat at the solstice, the framing is what was measured.
  const lane = evaluateSolsticeLane({ webglRange: 0.02, webgpuRange: 0.01 });
  assert.equal(lane.status, LANE.STRUCTURAL);
  assert.match(lane.failures[0], /framing — not the/);
});

test("D9: the solstice discriminator's own arithmetic", () => {
  assert.ok(Math.abs(SOLSTICE_DISCRIMINATOR.axisDotSun - 0.3977) < 1e-3);
  // A constant-normal backend evaluates the WGSL law once, at that dot, and
  // saturates — which is what makes the leg separating.
  assert.equal(dayFadeWgsl(SOLSTICE_DISCRIMINATOR.axisDotSun), 1);
  assert.equal(dayFadeWgsl(-SOLSTICE_DISCRIMINATOR.axisDotSun), 0);
});

// ─── E. verdict folding — STRUCTURAL must never read as PASS ─────────────────

test("E1: fold precedence is FAIL > STRUCTURAL > PASS", () => {
  const pass = { status: LANE.CONFIRMED };
  const structural = { status: LANE.STRUCTURAL };
  const fail = { status: LANE.REFUTED };
  assert.equal(foldVerdict({ a: pass, b: pass }), EXIT_CODE.PASS);
  assert.equal(foldVerdict({ a: pass, b: structural }), EXIT_CODE.STRUCTURAL);
  assert.equal(foldVerdict({ a: structural, b: fail }), EXIT_CODE.FAIL);
  assert.equal(foldVerdict({ a: {} }), EXIT_CODE.ERROR);
});

test("E2: the probe's own lane C is structural BY CONSTRUCTION offline", () => {
  // The finding-(c) render half needs vertex-normal terrain, which no offline
  // provider in this fork supplies. The probe must SAY so rather than skip.
  assert.match(
    probe,
    /status: LANE\.STRUCTURAL,\s*\n\s*failures: failures\.concat\(\[\s*\n\s*"RENDER half UNAVAILABLE OFFLINE/,
  );
  assert.match(probe, /hasVertexNormals === true/);
  for (const provider of [
    "EllipsoidTerrainProvider",
    "CustomHeightmapTerrainProvider",
    "ArcGISTiledElevationTerrainProvider",
  ]) {
    assert.match(
      read(`packages/engine/Source/Core/${provider}.js`),
      /get hasVertexNormals\(\) \{\s*\n?\s*return false;/,
      `${provider} unexpectedly reports vertex normals — lane C could now run ` +
        "offline and the probe's stated reason is stale",
    );
  }
});

test("E3: lane C's static half reads the emission rule it claims to", () => {
  assert.match(
    shaderSet,
    /if \(enableLighting\) \{\s*\n\s*if \(hasVertexNormals\) \{[\s\S]{0,200}ENABLE_VERTEX_LIGHTING[\s\S]{0,200}\} else \{[\s\S]{0,200}ENABLE_DAYNIGHT_SHADING/,
  );
});

// ─── F. probe hygiene ────────────────────────────────────────────────────────

test("F1: the probe embeds the CANONICAL same-task capture block", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probe), []);
});

test("F2: no probe-local pixel reader bypasses the fused primitive", () => {
  assert.deepEqual(checkFusedCaptureUsage(probe), []);
});

test("F3: the probe pins its clock, runs offline, and drives its own loop", () => {
  assert.match(probe, /const EQUINOX_ISO = "2026-03-20T12:00:00Z";/);
  assert.match(probe, /const SOLSTICE_ISO = "2026-06-21T12:00:00Z";/);
  assert.match(probe, /\?renderer=\$\{renderer\}&offline=true/);
  assert.match(probe, /viewer\.useDefaultRenderLoop = false;/);
  assert.match(probe, /scene\.requestRenderMode = false;/);
  assert.match(probe, /viewer\.clock\.shouldAnimate = false;/);
  // Every render goes through the pinned instant: `scene.render()` with no
  // argument substitutes `JulianDate.now()`.
  assert.doesNotMatch(probe, /scene\.render\(\)/);
});

test("F4: the probe has a watchdog that exits non-zero", () => {
  assert.match(probe, /const WATCHDOG_MS = \d[\d_]*;/);
  assert.match(
    probe,
    /watchdog = setTimeout\([\s\S]{0,400}?process\.exit\(EXIT_CODE\.ERROR\)/,
  );
  assert.match(probe, /watchdog\.unref\?\.\(\)/);
});

test("F5: every loop in the probe's page code is bounded", () => {
  // A `while (true)` inside `page.evaluate` hangs the browser, not the probe,
  // and the watchdog then kills a run that produced nothing. The settle loop's
  // bound is its wall-clock budget plus a frame floor.
  assert.doesNotMatch(probe, /while\s*\(\s*true\s*\)/);
  assert.match(
    probe,
    /while \(performance\.now\(\) - start < budgetMs \|\| frames < minFrames\)/,
  );
});

test("F6: the probe reads back every pin it claims", () => {
  for (const pin of [
    "useDefaultRenderLoop",
    "requestRenderMode",
    "enableLighting",
    "imageryLayerCount",
    "terrainHasVertexNormals",
    "lightingFadeOutDistance",
    "lightingFadeInDistance",
  ]) {
    assert.match(
      probe,
      new RegExp(`out\\.pins = \\{[\\s\\S]*?${pin}:`),
      `${pin} is claimed as a pin but never read back`,
    );
  }
  assert.match(probe, /pinFailures\.length > 0[\s\S]{0,160}structuralError/);
});

test("F7: the fade regime is asserted, not assumed", () => {
  assert.match(probe, /is not inside the fade=0/);
  assert.match(probe, /is not inside the fade=1/);
  // And the chosen altitudes really do sit in those regimes for a WGS84 globe.
  const minimumRadius = 6356752.314245179;
  const equatorial = 6378137.0;
  const fadeOut = (Math.PI / 2) * minimumRadius;
  const fadeIn = Math.PI * minimumRadius;
  assert.ok(equatorial + 3_000_000 < fadeOut);
  assert.ok(equatorial + 25_000_000 > fadeIn);
});

test("F8: the ladder's top rung avoids a shader-variant swap", () => {
  // `applyDayNightAlpha` is set when any layer's day/night alpha differs from
  // 1.0 (GlobeSurfaceTileProviderRendering.js). A rung at exactly 1.0 would
  // compile a DIFFERENT WebGL variant than the rungs it calibrates.
  assert.match(
    probe,
    /LADDER_ALPHAS = Object\.freeze\(\[0\.0, 0\.25, 0\.5, 0\.75, 0\.999\]\)/,
  );
  assert.match(
    read("packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js"),
    /applyDayNightAlpha \|\|\s*\n\s*uniformMapProperties\.dayTextureNightAlpha\[numberOfDayTextures\] !== 1\.0/,
  );
});

test("F9: the measurement leg cannot trip the night-lights emission", () => {
  // `isNightLayer = step(dayAlpha + 0.01, nightAlpha)` — the ramp leg uses
  // (1.0, 0.0), so the gate is closed and no additive term contaminates the
  // alpha inversion.
  assert.match(
    wgsl,
    /let isNightLayer = step\(dayAlpha \+ 0\.01, nightAlpha\);/,
  );
  assert.match(probe, /setLayerAlphas\(1\.0, 0\.0\);/);
  // The sentinel lane deliberately opens it.
  assert.match(probe, /setLayerAlphas\(0\.0, 1\.0\);/);
});
