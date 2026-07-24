// starfield-psf.spec.mjs — C12-05/06/07/08 analytic acceptance spec.
//
// CPU reference implementation of the StarField Moffat core+wing PSF and
// the linear-Pogson magnitude→intensity mapping, proving the G2 shape
// BEFORE the GPU ever draws it (`node --test Tools/visual-regression/starfield-psf.spec.mjs`):
//
//   (a) peak intensity is strictly monotone (and exactly linear-Pogson)
//       in catalogue flux — no clamp, no gamma;
//   (b) brightest:faintest intensity ratio ≥ 15 at the math layer;
//   (c) the G2 headline shape: r_1e-3 / r_core ≥ 8 for the new profile
//       while the OLD truncated-Gaussian reference gives < 2, under one
//       consistent definition pair (stated below);
//   (d) the profile reaches zero at the quad edge through a continuous
//       AA window (no hard truncation — the old blob failure mode);
//   (e) the WGSL and GLSL fragment sources carry IDENTICAL profile
//       constants, and the TS math layer's K_HALO matches them (guards
//       against cross-backend drift, Principle 5).
//
// Definitions used for (c) — stated so the orchestrator's harness can
// reconcile its own M4 measurement against these analytics:
//   r_core  := HWHM of the CORE component in pixels (the resolved
//              stellar image): sigma_px * sqrt(2 ln 2). The C12-06 quad
//              boost leaves this invariant by construction (asserted).
//   r_1e-3  := radius in pixels where the BRIGHTEST star's full rendered
//              profile (core + K_HALO*halo, windowed, in LDR clip units)
//              falls to 1e-3 of the clip level.
// The same definition pair applied to the old shader (Gaussian
// exp(-2.2 r^2), window smoothstep(1.0, 0.45, r), peak color HI = 2.0,
// base half-angle 0.0042 rad) yields ~1.74 — matching the research doc's
// "a Gaussian truncated at d=1.0 cannot exceed ~1.8".
// The composite-HWHM variant (threshold 0.5 of clip on the brightest
// star) is reported as a diagnostic; it is definition-sensitive and the
// report to the orchestrator discusses it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import BrightStarCatalog from "../../packages/engine/Source/Scene/BrightStarCatalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const wgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl",
);
const glslFsPath = path.join(
  root,
  "packages/engine/Source/Shaders/StarFieldFS.glsl",
);
const glslVsPath = path.join(
  root,
  "packages/engine/Source/Shaders/StarFieldVS.glsl",
);
const mathTsPath = path.join(
  root,
  "packages/engine/Source/Scene/StarFieldMath.ts",
);
const starFieldJsPath = path.join(
  root,
  "packages/engine/Source/Scene/StarField.js",
);

const wgsl = fs.readFileSync(wgslPath, "utf8");
const glslFs = fs.readFileSync(glslFsPath, "utf8");
const glslVs = fs.readFileSync(glslVsPath, "utf8");
const mathTs = fs.readFileSync(mathTsPath, "utf8");
const starFieldJs = fs.readFileSync(starFieldJsPath, "utf8");

// ---------------------------------------------------------------------------
// Reference constants — the single source of truth this spec asserts the
// shaders and math layer against.
// ---------------------------------------------------------------------------
const REF = {
  SIGMA: 0.12, // base-quad-relative Gaussian core sigma
  ALPHA: 0.15, // quad-relative Moffat wing scale (rides the C12-06 boost)
  BETA: 2.0, // Moffat exponent — wing log-log slope = -2*BETA = -4
  K_HALO: 0.08, // halo amplitude share
  WINDOW_INNER: 0.92, // AA window start (moved from the inert 0.45)
  MAG_CUTOFF: 5.0,
  FAINT_ANCHOR_MAG: 3.6,
  FAINT_ANCHOR_PEAK: 0.06,
  GLARE_MAX_DIAMETER_RAD: 0.017453292519943295, // 1 degree
  BASE_QUAD_DIAMETER_RAD: 0.006, // 2 x StarField.js _pointAngularSize
};
const EXPOSURE =
  (REF.FAINT_ANCHOR_PEAK / (1.0 + REF.K_HALO)) *
  Math.pow(10.0, 0.4 * REF.FAINT_ANCHOR_MAG);
const MAX_QUAD_SCALE = REF.GLARE_MAX_DIAMETER_RAD / REF.BASE_QUAD_DIAMETER_RAD;

// Historical (pre-C12-05) shader, reproduced as the OLD reference.
const OLD = {
  GAUSS_K: 2.2, // exp(-2.2 r^2)
  WINDOW_INNER: 0.45,
  HI: 2.0, // old brightest-star peak color
  BASE_HALF_RAD: 0.0042,
};

// G2 measurement geometry: 1920x1080 at Cesium's default 60-degree
// horizontal FOV (fovy derived through the aspect ratio, matching
// PerspectiveFrustum).
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const FOV_X = Math.PI / 3.0;
const fovY = 2.0 * Math.atan(Math.tan(FOV_X / 2.0) * (CANVAS_H / CANVAS_W));
const proj5 = 1.0 / Math.tan(fovY / 2.0);
const basePxHalf =
  (REF.BASE_QUAD_DIAMETER_RAD / 2.0) * proj5 * (CANVAS_H / 2.0);
const oldBasePxHalf = OLD.BASE_HALF_RAD * proj5 * (CANVAS_H / 2.0);

// ---------------------------------------------------------------------------
// CPU reference implementation (mirrors the shader + math layer exactly).
// ---------------------------------------------------------------------------
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1.0, Math.max(0.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

function intensity(vmag) {
  return vmag > REF.MAG_CUTOFF ? 0.0 : EXPOSURE * Math.pow(10.0, -0.4 * vmag);
}

function quadScale(flux) {
  return flux > 1.0 ? Math.min(Math.sqrt(flux), MAX_QUAD_SCALE) : 1.0;
}

// Full rendered radial profile in LDR clip units at boosted-quad-relative
// radius r for a star of intensity I (pre-clip; the ROP clamps at 1.0).
function newProfile(r, I) {
  const qs = quadScale(I);
  const rCore = r * qs;
  const core = Math.exp(-(rCore * rCore) / (2.0 * REF.SIGMA * REF.SIGMA));
  const q = r / REF.ALPHA;
  const halo = Math.pow(1.0 + q * q, -REF.BETA);
  const win = smoothstep(1.0, REF.WINDOW_INNER, r);
  return I * (core + REF.K_HALO * halo) * win;
}

function oldProfile(r, I) {
  const core = Math.exp(-r * r * OLD.GAUSS_K);
  const edge = smoothstep(1.0, OLD.WINDOW_INNER, r);
  return I * core * edge;
}

// Both profiles are strictly decreasing on [0, sqrt(2)] — bisect for the
// radius where `fn` crosses `target` from above.
function bisectRadius(fn, target, lo = 0.0, hi = Math.SQRT2) {
  assert.ok(fn(lo) > target, "bisection: target above profile peak");
  assert.ok(fn(hi) < target, "bisection: target below profile floor");
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (fn(mid) > target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

// Catalogue sweep.
const cat = BrightStarCatalog.data;
const stride = BrightStarCatalog.STRIDE;
const count = BrightStarCatalog.count;
const vmags = [];
for (let i = 0; i < count; i++) {
  vmags.push(cat[i * stride + 2]);
}
vmags.sort((a, b) => a - b);
const vmagBrightest = vmags[0];
const rendered = vmags.filter((m) => m <= REF.MAG_CUTOFF);
const vmagFaintestRendered = rendered[rendered.length - 1];
const I_MAX = intensity(vmagBrightest);
const I_FAINT = intensity(vmagFaintestRendered);

// ---------------------------------------------------------------------------
// (e) Constant identity across WGSL / GLSL / TS
// ---------------------------------------------------------------------------
function extract(src, re, what, file) {
  const m = src.match(re);
  assert.ok(m, `${what} not found in ${file}`);
  return Number(m[1]);
}

const NUM = String.raw`([0-9]*\.?[0-9]+)`;

test("(e) WGSL and GLSL fragment profiles carry identical constants", () => {
  const pairs = [
    ["STAR_PSF_SIGMA", REF.SIGMA],
    ["STAR_PSF_ALPHA", REF.ALPHA],
    ["STAR_PSF_BETA", REF.BETA],
    ["STAR_PSF_K_HALO", REF.K_HALO],
  ];
  for (const [name, refValue] of pairs) {
    const w = extract(
      wgsl,
      new RegExp(`const ${name}: f32 = ${NUM};`),
      name,
      "StarField.wgsl",
    );
    const g = extract(
      glslFs,
      new RegExp(`const float ${name} = ${NUM};`),
      name,
      "StarFieldFS.glsl",
    );
    assert.equal(w, g, `${name} drift between WGSL and GLSL`);
    assert.equal(w, refValue, `${name} differs from the spec reference`);
  }

  // The AA window moved to (1.0, 0.92) in BOTH files — left at 0.45 the
  // wing is multiplied to zero across the outer 55% and C12-05 is inert.
  for (const [src, file] of [
    [wgsl, "StarField.wgsl"],
    [glslFs, "StarFieldFS.glsl"],
  ]) {
    assert.match(
      src,
      /smoothstep\(1\.0,\s*0\.92,\s*r\)/,
      `narrow AA window missing in ${file}`,
    );
    assert.ok(
      !/smoothstep\(1\.0,\s*0\.45,/.test(src),
      `stale 0.45 window survives in ${file}`,
    );
  }

  // Both fragments consume the C12-06 core scale (quad growth must not
  // grow the core), and both vertex stages feed it.
  assert.match(wgsl, /r \* input\.coreScale/, "WGSL core scale unused");
  assert.match(glslFs, /r \* v_coreScale/, "GLSL core scale unused");
  assert.match(wgsl, /coreScale = 1\.0 \+ input\.sizeBoost/, "WGSL VS feed");
  assert.match(glslVs, /v_coreScale = 1\.0 \+ sizeBoost/, "GLSL VS feed");
});

test("(e) TS math layer constants match the shaders and this spec", () => {
  const tsK = extract(
    mathTs,
    new RegExp(`const K_HALO = ${NUM};`),
    "K_HALO",
    "StarFieldMath.ts",
  );
  assert.equal(tsK, REF.K_HALO, "TS K_HALO drifted from shader K_HALO");

  const anchors = [
    ["MAG_CUTOFF", REF.MAG_CUTOFF],
    ["FAINT_ANCHOR_MAG", REF.FAINT_ANCHOR_MAG],
    ["FAINT_ANCHOR_PEAK", REF.FAINT_ANCHOR_PEAK],
    ["GLARE_MAX_DIAMETER_RAD", REF.GLARE_MAX_DIAMETER_RAD],
    ["BASE_QUAD_DIAMETER_RAD", REF.BASE_QUAD_DIAMETER_RAD],
  ];
  for (const [name, refValue] of anchors) {
    const v = extract(
      mathTs,
      new RegExp(`const ${name} =\\s*${NUM};`),
      name,
      "StarFieldMath.ts",
    );
    assert.equal(v, refValue, `${name} differs from the spec reference`);
  }

  // Cross-file coupling: MAX_QUAD_SCALE's derivation bakes in 2x
  // StarField.js's _pointAngularSize.
  const pointAngular = extract(
    starFieldJs,
    new RegExp(`_pointAngularSize = ${NUM};`),
    "_pointAngularSize",
    "StarField.js",
  );
  assert.equal(
    2.0 * pointAngular,
    REF.BASE_QUAD_DIAMETER_RAD,
    "StarField.js _pointAngularSize out of sync with StarFieldMath BASE_QUAD_DIAMETER_RAD",
  );
});

// ---------------------------------------------------------------------------
// (a) Monotonicity + strict Pogson linearity
// ---------------------------------------------------------------------------
test("(a) intensity is strictly monotone and exactly linear-Pogson in flux", () => {
  for (let i = 1; i < rendered.length; i++) {
    const a = rendered[i - 1];
    const b = rendered[i];
    const ia = intensity(a);
    const ib = intensity(b);
    if (b > a) {
      assert.ok(
        ib < ia,
        `intensity not strictly decreasing: vmag ${a}=>${ia}, ${b}=>${ib}`,
      );
    } else {
      assert.equal(ib, ia, "equal magnitudes must map to equal intensity");
    }
    // Linearity: the delivered ratio must be EXACTLY the Pogson flux
    // ratio — any residual clamp/gamma would break this.
    const expected = Math.pow(10.0, -0.4 * (b - a));
    const actual = ib / ia;
    assert.ok(
      Math.abs(actual - expected) <= 1e-12 * expected,
      `Pogson linearity violated between vmag ${a} and ${b}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (b) Dynamic range at the math layer
// ---------------------------------------------------------------------------
test("(b) brightest:faintest intensity ratio >= 15 at the math layer", (t) => {
  const ratio = I_MAX / I_FAINT;
  t.diagnostic(
    `math-layer range ${ratio.toFixed(1)}:1 over vmag [${vmagBrightest}, ${vmagFaintestRendered}] (old construction: 4:1)`,
  );
  assert.ok(ratio >= 15.0, `math-layer range ${ratio} < 15`);
});

// ---------------------------------------------------------------------------
// Exposure anchoring — M1 floor and the rendered 15:1 window (C12-08)
// ---------------------------------------------------------------------------
test("exposure anchor: M1 floor met, rendered ratio >= 15, halo never clips", (t) => {
  const anchorPeak = intensity(REF.FAINT_ANCHOR_MAG) * (1.0 + REF.K_HALO);
  assert.ok(
    Math.abs(anchorPeak - REF.FAINT_ANCHOR_PEAK) < 1e-12,
    "EXPOSURE does not reproduce the faint anchor peak",
  );
  // M1 detection floor (P - B >= 12/255) at the anchor magnitude...
  assert.ok(anchorPeak >= 12 / 255, "anchor star below the M1 floor");
  // ...while low enough that the clipped brightest star (peak 1.0) keeps
  // the rendered brightest:faintest peak ratio >= 15 (G2 criterion 5).
  assert.ok(1.0 / anchorPeak >= 15.0, "rendered peak ratio < 15");

  // The brightest star's core does clip (small white core is intended)...
  assert.ok(I_MAX * (1.0 + REF.K_HALO) > 1.0, "brightest core no longer clips");
  // ...but the halo term NEVER reaches the clip level, for any star, by
  // construction (C12-07): haloIntensity = I*K_HALO < 1.
  assert.ok(
    I_MAX * REF.K_HALO < 1.0,
    `halo term can clip: I_max*K = ${I_MAX * REF.K_HALO}`,
  );
  t.diagnostic(
    `I_max=${I_MAX.toFixed(3)} haloShare=${(I_MAX * REF.K_HALO).toFixed(3)} anchorPeak=${anchorPeak.toFixed(4)} (${(anchorPeak * 255).toFixed(1)}/255)`,
  );
});

// ---------------------------------------------------------------------------
// (c) G2 headline — the profile is a star, not a blob
// ---------------------------------------------------------------------------
test("(c) r_1e-3 / r_core >= 8 for the new PSF; old truncated Gaussian < 2", (t) => {
  // NEW: brightest catalogue star.
  const qsMax = quadScale(I_MAX);
  const newQuadHalfPx = basePxHalf * qsMax;
  const rCorePxNew = REF.SIGMA * Math.sqrt(2.0 * Math.log(2.0)) * basePxHalf;
  const r1e3QuadNew = bisectRadius((r) => newProfile(r, I_MAX), 1e-3);
  const r1e3PxNew = r1e3QuadNew * newQuadHalfPx;
  const newRatio = r1e3PxNew / rCorePxNew;

  // OLD: same definitions on the historical shader at its base quad.
  const rCorePxOld =
    Math.sqrt(Math.log(2.0) / OLD.GAUSS_K) * oldBasePxHalf;
  const r1e3QuadOld = bisectRadius((r) => oldProfile(r, OLD.HI), 1e-3);
  const r1e3PxOld = r1e3QuadOld * oldBasePxHalf;
  const oldRatio = r1e3PxOld / rCorePxOld;

  t.diagnostic(
    `NEW r_core=${rCorePxNew.toFixed(3)}px r_1e-3=${r1e3PxNew.toFixed(2)}px ratio=${newRatio.toFixed(1)} | OLD r_core=${rCorePxOld.toFixed(2)}px r_1e-3=${r1e3PxOld.toFixed(2)}px ratio=${oldRatio.toFixed(2)}`,
  );
  assert.ok(newRatio >= 8.0, `G2 headline FAIL: new ratio ${newRatio} < 8`);
  assert.ok(oldRatio < 2.0, `old reference ratio ${oldRatio} unexpectedly >= 2`);

  // The 1e-3 isophote must sit INSIDE the AA window start, or the window
  // (not the wing) sets the measured extent.
  assert.ok(
    r1e3QuadNew < REF.WINDOW_INNER,
    "1e-3 isophote truncated by the AA window",
  );

  // Clipped white core stays small: <= 1.5 px radius and well under the
  // G2 25-clipped-px budget for the brightest star at 1x exposure.
  const rClipQuad = bisectRadius((r) => newProfile(r, I_MAX), 1.0);
  const rClipPx = rClipQuad * newQuadHalfPx;
  const clippedPx = Math.PI * rClipPx * rClipPx;
  t.diagnostic(
    `clip radius ${rClipPx.toFixed(2)}px -> ~${clippedPx.toFixed(1)} clipped px (budget 25)`,
  );
  assert.ok(rClipPx <= 1.5, `clip radius ${rClipPx}px > 1.5px`);
  assert.ok(clippedPx < 25.0, `clipped area ${clippedPx}px^2 >= 25`);

  // Diagnostic only (definition-sensitive, see file header): composite
  // HWHM measured on the clipped brightest-star profile.
  const rHalfQuad = bisectRadius((r) => newProfile(r, I_MAX), 0.5);
  const rHalfPx = rHalfQuad * newQuadHalfPx;
  t.diagnostic(
    `composite-HWHM variant: r_core=${rHalfPx.toFixed(2)}px ratio=${(r1e3PxNew / rHalfPx).toFixed(2)} (non-certifying here; see report)`,
  );
});

// ---------------------------------------------------------------------------
// (d) AA window continuity
// ---------------------------------------------------------------------------
test("(d) profile fades continuously to exactly zero across [0.92, 1.0]", () => {
  const step = 5e-4;
  let prev = newProfile(0.9, I_MAX);
  for (let r = 0.9 + step; r <= 1.05 + 1e-9; r += step) {
    const v = newProfile(r, I_MAX);
    // Continuity: a legitimate windowed wing moves ~3e-6 per step here; a
    // hard truncation would jump by the full wing value (~3e-4).
    assert.ok(
      Math.abs(v - prev) < 1e-5,
      `discontinuity at r=${r.toFixed(4)}: |delta|=${Math.abs(v - prev)}`,
    );
    // Monotone fade, and exactly zero at/beyond the quad edge.
    assert.ok(v <= prev + 1e-15, `profile increases at r=${r.toFixed(4)}`);
    if (r >= 1.0) {
      assert.equal(v, 0.0, `profile nonzero beyond the quad edge (r=${r})`);
    }
    prev = v;
  }
});

// ---------------------------------------------------------------------------
// C12-06 — quad growth is halo extent, never core size; 1-degree cap
// ---------------------------------------------------------------------------
test("C12-06: core pixel size is boost-invariant; glare capped at 1 degree", (t) => {
  // Core HWHM in px must be identical for an unboosted star and the
  // maximally boosted brightest star.
  const coreOnly = (r, qs) =>
    Math.exp(-(r * qs * (r * qs)) / (2.0 * REF.SIGMA * REF.SIGMA));
  const hwhmPx = (qs) =>
    bisectRadius((r) => coreOnly(r, qs), 0.5, 0.0, 1.4 / qs) *
    basePxHalf *
    qs;
  const qsMax = quadScale(I_MAX);
  assert.ok(qsMax > 1.0, "brightest star gets no halo extent");
  assert.ok(
    Math.abs(hwhmPx(1.0) - hwhmPx(qsMax)) < 1e-9,
    "core pixel size changed with the quad boost",
  );

  // Total glare (quad) angular diameter <= 1 degree for every star.
  assert.ok(
    qsMax * REF.BASE_QUAD_DIAMETER_RAD <=
      REF.GLARE_MAX_DIAMETER_RAD + 1e-12,
    "glare diameter exceeds the 1-degree Celestia bound",
  );

  // Boost is monotone non-decreasing with flux and zero for faint stars.
  let prevQs = 0.0;
  for (const m of [...rendered].reverse()) {
    const qs = quadScale(intensity(m));
    assert.ok(qs >= prevQs - 1e-15, "quadScale not monotone in flux");
    prevQs = qs;
  }
  assert.equal(quadScale(I_FAINT), 1.0, "faint stars must not be boosted");
  t.diagnostic(
    `quadScale(brightest)=${qsMax.toFixed(3)} (cap ${MAX_QUAD_SCALE.toFixed(3)}) -> glare diameter ${((qsMax * REF.BASE_QUAD_DIAMETER_RAD * 180) / Math.PI).toFixed(3)} deg`,
  );
});
