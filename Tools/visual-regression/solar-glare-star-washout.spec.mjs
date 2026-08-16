// solar-glare-star-washout.spec.mjs — C12-27
// (`NEW-ANGULAR-SOLAR-GLARE-STAR-WASHOUT`), plus the C12-14 samplable star
// texture and the C12-13 LICENSE.md residual that ride the same batch.
// @purpose C12-27: extracts solarGlareVeil from five shader texts, compiles each, requires 1e-15 agreement with the JS reference; rejects 7 wrong curves.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. C12-27 is a pure-arithmetic change replicated across
// FIVE shader texts (two WGSL files, one JS-embedded production WGSL copy, and
// two GLSL files) driven by ONE CPU resolver. The failure modes are not
// crashes:
//
//   * one backend quietly computes a different curve;
//   * the curve is the WRONG member of the glare family (the queue row itself
//     prescribes reusing C12-05's Moffat wing, which is inverse-FOURTH-power,
//     while calling it "Stiles-Holladay inverse-square" — those are different
//     curves and only one of them is what the row asks for);
//   * the ">90 deg is byte-identical" criterion silently degrades to
//     "small but non-zero", which is exactly what an un-subtracted pedestal
//     produces;
//   * the toggle's OFF position drifts from an identity to an approximation.
//
// So this spec does four things a text-grep spec does not:
//
//   1. EXTRACTS `solarGlareVeil` from all five shader texts, compiles each
//      body as JavaScript, and requires all five plus the JS reference in
//      `Scene/SolarDiscModel.js` to agree to 1e-15 over a sweep. That is
//      cross-language equivalence, not a shared regex. (It proves the shader
//      SOURCE is one function; it does not and cannot prove a GPU's `acos`
//      matches the CPU's to the same tolerance.)
//   2. States the mathematical PROPERTIES the washout law must have as a
//      reusable predicate, then runs that predicate against seven deliberately
//      wrong implementations — including the exact curve the queue row names —
//      to prove it rejects them.
//   3. Pins the C12-16 refactor: `solarGlareProfile` now delegates to a shared
//      kernel, and a frozen copy of its PRE-C12-27 body must reproduce it
//      BIT-for-bit over a dense sweep.
//   4. Pins the numbers the Edge acceptance run is measured against, including
//      the honest statement of where the effect is arithmetically invisible.
//
// LINE ENDINGS: this repo checks out CRLF (`core.autocrlf=true`). Every source
// read below is normalised to `\n` first — a spec anchored on a bare `\n`
// silently false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/solar-glare-star-washout.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const STAR_WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl";
const STAR_GLSL_PATH = "packages/engine/Source/Shaders/StarFieldVS.glsl";
const PANORAMA_WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl";
const PANORAMA_GLSL_PATH = "packages/engine/Source/Shaders/SkyBoxFS.glsl";

const starWgsl = read(STAR_WGSL_PATH);
const starGlsl = read(STAR_GLSL_PATH);
const panoramaWgsl = read(PANORAMA_WGSL_PATH);
const panoramaGlsl = read(PANORAMA_GLSL_PATH);
const panoramaRendererJs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
);
const starRendererTs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts",
);
const starRendererJs = read(
  "packages/engine/Source/Renderer/WebGLStarFieldRenderer.js",
);
const panoramaScene = read("packages/engine/Source/Scene/CubeMapPanorama.js");
const skyBoxScene = read("packages/engine/Source/Scene/SkyBox.js");
const sceneJs = read("packages/engine/Source/Scene/Scene.js");
const frameStateJs = read("packages/engine/Source/Scene/FrameState.js");
const conditions = read(
  "packages/engine/Source/Scene/AtmosphericConditions.js",
);
const featureRenderers = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
);
const licenseMd = read("LICENSE.md");

const model = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Scene/SolarDiscModel.js"),
  ).href
);
const glare = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Scene/SolarGlareAppearance.js"),
  ).href
);
const cubeMapResource = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Scene/StarCubeMapResource.js"),
  ).href
);

const {
  SOLAR_GLARE_CORE,
  SOLAR_GLARE_SUPPORT,
  SOLAR_GLARE_PEDESTAL,
  SOLAR_GLARE_ANGULAR_VALID_MIN_DEG,
  SOLAR_GLARE_ANGULAR_VALID_MAX_DEG,
  SOLAR_GLARE_ANGULAR_CORE,
  SOLAR_GLARE_ANGULAR_SUPPORT,
  SOLAR_GLARE_ANGULAR_PEDESTAL,
  lorentzianPedestal,
  pedestalLorentzian,
  solarGlareProfile,
  angularGlareVeil,
  solarAngularGlareVeil,
  solarAngularGlareFactor,
} = model;

const {
  SOLAR_GLARE_STRENGTH,
  createSolarGlareAppearance,
  readSolarGlareAppearance,
} = glare;

const CORE = SOLAR_GLARE_ANGULAR_CORE;
const PEDESTAL = SOLAR_GLARE_ANGULAR_PEDESTAL;
const SUPPORT = SOLAR_GLARE_ANGULAR_SUPPORT;

const toRadians = (deg) => (deg * Math.PI) / 180.0;
const veilAtDegrees = (deg) => solarAngularGlareVeil(Math.cos(toRadians(deg)));

// ───────────────────────────────────────────────────────────────────────────
// Cross-language extraction: compile every shader's solarGlareVeil as JS.
// ───────────────────────────────────────────────────────────────────────────

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
}

/** Slices the balanced `{ ... }` body that follows `signature` in `source`. */
function extractBody(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `signature not found: ${signature}`);
  const open = source.indexOf("{", at);
  assert.ok(open > at, `no body brace after: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

/**
 * Slices the JS-embedded production WGSL out of the panorama renderer, the way
 * `eclipse-sky-totality.spec.mjs` does. Backtick-free by contract: a backtick
 * followed by a semicolon inside the template literal truncates this slice and
 * would leave a downstream naga check validating a fragment.
 */
function extractInlinePanoramaWgsl() {
  const start = panoramaRendererJs.indexOf("const CUBEMAP_PANORAMA_WGSL = `");
  assert.ok(start > 0, "inline panorama WGSL not found");
  const bodyStart = panoramaRendererJs.indexOf("`", start) + 1;
  const bodyEnd = panoramaRendererJs.indexOf("`;", bodyStart);
  assert.ok(bodyEnd > bodyStart);
  const inline = panoramaRendererJs.slice(bodyStart, bodyEnd);
  assert.ok(inline.includes("uniforms.starModulation"), "wrong slice");
  assert.ok(
    inline.includes("fn fragmentMain"),
    "slice truncated before the FS",
  );
  assert.ok(!inline.includes("${"), "template interpolation in the WGSL");
  return inline;
}

const inlinePanoramaWgsl = extractInlinePanoramaWgsl();

const WGSL_SIGNATURE =
  "fn solarGlareVeil(cosSeparation: f32, core: f32, pedestal: f32, support: f32) -> f32";
const GLSL_SIGNATURE =
  "float solarGlareVeil(float cosSeparation, float core, float pedestal, float support)";

function compileShaderBody(body, replacements) {
  let js = body;
  for (const [pattern, replacement] of replacements) {
    js = js.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "cosSeparation",
    "core",
    "pedestal",
    "support",
    "clamp",
    "acos",
    "min",
    js,
  );
  return (cos, c, p, s) => fn(cos, c, p, s, jsClamp, Math.acos, Math.min);
}

const jsClamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

const wgslReplacements = [[/\blet\b/g, "let"]];
const glslReplacements = [[/\bfloat\b/g, "let"]];

const implementations = {
  "StarField.wgsl": compileShaderBody(
    extractBody(stripLineComments(starWgsl), WGSL_SIGNATURE),
    wgslReplacements,
  ),
  "CubeMapPanorama.wgsl": compileShaderBody(
    extractBody(stripLineComments(panoramaWgsl), WGSL_SIGNATURE),
    wgslReplacements,
  ),
  "WebGPUCubeMapPanoramaRenderer.js (embedded)": compileShaderBody(
    extractBody(stripLineComments(inlinePanoramaWgsl), WGSL_SIGNATURE),
    wgslReplacements,
  ),
  "StarFieldVS.glsl": compileShaderBody(
    extractBody(stripLineComments(starGlsl), GLSL_SIGNATURE),
    glslReplacements,
  ),
  "SkyBoxFS.glsl": compileShaderBody(
    extractBody(stripLineComments(panoramaGlsl), GLSL_SIGNATURE),
    glslReplacements,
  ),
};

// ───────────────────────────────────────────────────────────────────────────
// The property predicate — the thing the mutants must fail.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Asserts every property C12-27 actually requires of an angular washout law.
 * `f` takes the COSINE of the separation and returns the veil weight.
 */
function assertAngularGlareLaw(f) {
  // P1 — EXACTLY zero at and beyond the support angle. This is what makes the
  // ">90 deg separation is byte-identical to the no-Sun frame" criterion an
  // identity rather than an approximation, and it is the first thing an
  // un-subtracted pedestal breaks.
  for (const deg of [90, 90.0001, 100, 120, 179, 180]) {
    assert.equal(
      f(Math.cos(toRadians(deg))),
      0.0,
      `the veil must be exactly 0 at ${deg} deg`,
    );
  }
  assert.equal(f(0.0), 0.0, "cos == 0 (exactly 90 deg) must be exactly 0");
  assert.equal(f(-1.0), 0.0, "antisolar must be exactly 0");

  // P2 — full veil dead on the Sun.
  assert.equal(f(1.0), 1.0, "the veil must be exactly 1 at zero separation");

  // P3 — range.
  for (let i = 0; i <= 400; i++) {
    const v = f(Math.cos((Math.PI * i) / 400));
    assert.ok(v >= 0.0 && v <= 1.0, "the veil must stay in [0, 1]");
  }

  // P4 — STRICTLY decreasing with separation across the whole active band.
  // The deleted elevation-keyed model is constant in separation and dies here.
  let previous = Infinity;
  for (let i = 1; i <= 300; i++) {
    const deg = (90 * i) / 300;
    const v = f(Math.cos(toRadians(deg)));
    assert.ok(v < previous, `the veil must strictly decrease (${deg} deg)`);
    previous = v;
  }

  // P5 — INVERSE-SQUARE far field. Measured as a two-point log-log slope over
  // [15 deg, 30 deg]: far enough past the 5.477 deg core that the regularised
  // knee is done, near enough that the pedestal subtraction has not yet bent
  // the tail. This is the check that separates the Stiles-Holladay / CIE
  // veiling-glare form the row asks for (-2) from C12-05's Moffat wing (-3.75
  // here, -4 asymptotically) and from a Gaussian (-16).
  const a = 15.0;
  const b = 30.0;
  const slope =
    Math.log(f(Math.cos(toRadians(b))) / f(Math.cos(toRadians(a)))) /
    Math.log(b / a);
  assert.ok(
    slope > -2.1 && slope < -1.9,
    `the far field must fall as 1/theta^2; measured log-log slope ${slope}`,
  );

  // P6 — continuity at the support seam. Approaching 90 deg from inside must
  // land sub-LSB, otherwise the exact zero at 90 deg is a visible step.
  assert.ok(
    f(Math.cos(toRadians(89.9))) < 1.0 / 255.0,
    "the veil must already be sub-LSB just inside the support angle",
  );
}

function rejects(name, f) {
  let threw = false;
  try {
    assertAngularGlareLaw(f);
  } catch {
    threw = true;
  }
  assert.ok(
    threw,
    `the property predicate FAILED to reject the mutant: ${name}`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// C12-27 — the law itself
// ───────────────────────────────────────────────────────────────────────────

test("C12-27: the reference law satisfies every required property", () => {
  assertAngularGlareLaw(solarAngularGlareVeil);
});

test("C12-27: all five shader twins compile to the SAME function as the reference", () => {
  let maxDelta = 0;
  for (const [name, fn] of Object.entries(implementations)) {
    const bound = (cos) => fn(cos, CORE, PEDESTAL, SUPPORT);
    assertAngularGlareLaw(bound);
    for (let i = 0; i <= 3000; i++) {
      const cos = -1.0 + (2.0 * i) / 3000;
      const delta = Math.abs(bound(cos) - solarAngularGlareVeil(cos));
      maxDelta = Math.max(maxDelta, delta);
    }
    // Also exercise a non-shipped parameter set, so an implementation that
    // hard-codes a constant instead of reading its argument is caught.
    for (let i = 0; i <= 200; i++) {
      const cos = i / 200;
      const delta = Math.abs(
        fn(cos, 0.2, lorentzianPedestal(1.0, 0.2), 1.0) -
          angularGlareVeil(cos, 0.2, lorentzianPedestal(1.0, 0.2), 1.0),
      );
      assert.ok(delta < 1e-15, `${name} ignores its parameters`);
    }
  }
  assert.ok(
    maxDelta < 1e-15,
    `all five shader twins must match the JS reference; max delta ${maxDelta}`,
  );
});

// ── ADVERSARIAL: each mutant is a plausible wrong implementation ───────────

test("C12-27 mutant REJECTED: C12-05's Moffat wing (the curve the queue row names)", () => {
  // The row says to reuse "the C12-05 Stiles-Holladay math". C12-05 DID land,
  // but `STAR_PSF_BETA = 2.0` makes its wing (1 + (r/a)^2)^(-2), a log-log
  // slope of -4 — an inverse-FOURTH-power point-spread function, not the
  // inverse-square veiling luminance the same sentence asks for. Reusing it
  // would put the washout two orders of magnitude too low at 30 deg. Caught by
  // P5.
  const p = Math.pow(1.0 + Math.pow(SUPPORT / CORE, 2), -2);
  rejects("Moffat beta=2 wing", (cos) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const theta = Math.acos(Math.min(cos, 1.0));
    if (theta >= SUPPORT) {
      return 0.0;
    }
    const t = theta / CORE;
    const raw = Math.pow(1.0 + t * t, -2);
    return jsClamp((raw - p) / (1.0 - p), 0.0, 1.0);
  });
});

test("C12-27 mutant REJECTED: raw Lorentzian, no pedestal subtraction", () => {
  // The single most likely simplification, and the one that quietly destroys
  // the acceptance criterion: it leaves 0.00369 of veil at 90 deg and beyond,
  // so nothing outside the support is byte-identical any more. Caught by P1.
  rejects("no pedestal", (cos) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const t = Math.acos(Math.min(cos, 1.0)) / CORE;
    return 1.0 / (1.0 + t * t);
  });
});

test("C12-27 mutant REJECTED: Gaussian falloff", () => {
  // Physically the wrong family entirely — a Gaussian has no power-law tail,
  // so the washout would stop dead a few degrees from the Sun. Caught by P5.
  const p = Math.exp(-Math.pow(SUPPORT / CORE, 2) / 2.0);
  rejects("Gaussian", (cos) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const theta = Math.acos(Math.min(cos, 1.0));
    const raw = Math.exp(-Math.pow(theta / CORE, 2) / 2.0);
    return jsClamp((raw - p) / (1.0 - p), 0.0, 1.0);
  });
});

test("C12-27 mutant REJECTED: the DELETED elevation-keyed global dim", () => {
  // The model C11-176 removed: one scalar for the whole sky, independent of
  // where the star is. This mutant is what "re-add the old behaviour" looks
  // like. Caught by P4 (must strictly decrease with separation).
  rejects("global dim", () => 0.5);
});

test("C12-27 mutant REJECTED: core expressed in DEGREES instead of radians", () => {
  // The classic unit slip. A 5.477-RADIAN core is wider than the entire
  // support, so the veil barely decays at all across the sky. Caught by P5.
  const coreDeg = (CORE * 180.0) / Math.PI;
  const p = lorentzianPedestal(SUPPORT, coreDeg);
  rejects("degrees for radians", (cos) =>
    angularGlareVeil(cos, coreDeg, p, SUPPORT),
  );
});

test("C12-27 mutant REJECTED: chord parameterisation instead of the true angle", () => {
  // Using `2*(1 - cos)` (the squared chord) in place of theta^2 dodges the
  // `acos` and is right to first order near the Sun, but the two diverge by
  // 10% by 90 deg, so the pedestal no longer lands on the support and the
  // far half-sky stops being exact. Caught by P1.
  rejects("chord parameterisation", (cos) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const t = Math.sqrt(2.0 * (1.0 - Math.min(cos, 1.0))) / CORE;
    const raw = 1.0 / (1.0 + t * t);
    return jsClamp((raw - PEDESTAL) / (1.0 - PEDESTAL), 0.0, 1.0);
  });
});

test("C12-27 mutant REJECTED: sign of the separation flipped", () => {
  // `dot(star, -sun)` — washes out the ANTISOLAR sky and leaves the Sun's
  // neighbourhood untouched. A one-character error with an entirely wrong
  // picture. Caught by P2/P4.
  rejects("antisolar", (cos) => solarAngularGlareVeil(-cos));
});

// ───────────────────────────────────────────────────────────────────────────
// One curve, two parameterisations — the "one home" claim, measured
// ───────────────────────────────────────────────────────────────────────────

test("C12-27: the angular veil IS C12-16's curve, re-parameterised", () => {
  // The module claims `solarGlareProfile` (bake radius) and the angular veil
  // are the same pedestal-subtracted Lorentzian. Prove it rather than assert
  // it in a comment: feed the same position to both parameterisations.
  //
  // The only difference between the two paths is the `acos(cos(theta))`
  // round trip, so this test ALSO measures that round trip and requires it to
  // account for the whole residual.
  let maxRoundTrip = 0;
  let maxDelta = 0;
  for (let i = 0; i <= 2000; i++) {
    const theta = (SUPPORT * i) / 2001; // strictly inside the support
    const roundTripped = Math.acos(Math.min(Math.cos(theta), 1.0));
    maxRoundTrip = Math.max(maxRoundTrip, Math.abs(roundTripped - theta));
    const viaAngle = solarAngularGlareVeil(Math.cos(theta));
    const viaKernel = pedestalLorentzian(theta, CORE, PEDESTAL);
    maxDelta = Math.max(maxDelta, Math.abs(viaAngle - viaKernel));
  }
  assert.ok(
    maxRoundTrip < 1e-8,
    `acos(cos(theta)) round trip must be tiny; was ${maxRoundTrip}`,
  );
  assert.ok(
    maxDelta < 1e-8,
    `the two parameterisations must be one curve; max delta ${maxDelta}`,
  );
  // Fed the SAME argument, they are bit-identical — no round trip involved.
  for (let i = 0; i <= 500; i++) {
    const x = (SUPPORT * i) / 500;
    assert.equal(
      angularGlareVeil(Math.cos(0.0), CORE, PEDESTAL, SUPPORT) * 0 +
        pedestalLorentzian(x, CORE, PEDESTAL),
      pedestalLorentzian(x, CORE, PEDESTAL),
    );
  }
});

test("C12-16 REGRESSION: solarGlareProfile is BIT-identical after the refactor", () => {
  // The pre-C12-27 body, frozen verbatim. C12-27 factored it into
  // `pedestalLorentzian`; if that moved a single bit, the landed and
  // Edge-verified sun bake changes underneath us.
  const legacy = (radius) => {
    const t = radius / SOLAR_GLARE_CORE;
    const raw = 1.0 / (1.0 + t * t);
    const v = (raw - SOLAR_GLARE_PEDESTAL) / (1.0 - SOLAR_GLARE_PEDESTAL);
    return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
  };
  for (let i = 0; i <= 20000; i++) {
    const radius = i / 20000;
    assert.equal(
      solarGlareProfile(radius),
      legacy(radius),
      `solarGlareProfile moved at radius ${radius}`,
    );
  }
  // The check has teeth: an algebraically equal but differently ORDERED
  // expression is not bit-identical, and this test must be able to see that.
  const reordered = (radius) => {
    const t = radius / SOLAR_GLARE_CORE;
    const raw = 1.0 / (1.0 + t * t);
    const v =
      raw / (1.0 - SOLAR_GLARE_PEDESTAL) -
      SOLAR_GLARE_PEDESTAL / (1.0 - SOLAR_GLARE_PEDESTAL);
    return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
  };
  let sawDifference = false;
  for (let i = 0; i <= 20000 && !sawDifference; i++) {
    const radius = i / 20000;
    if (reordered(radius) !== legacy(radius)) {
      sawDifference = true;
    }
  }
  assert.ok(
    sawDifference,
    "the bit-identity check is vacuous — a reordered expression matched",
  );
  // And the pedestal constant itself is unchanged by the helper extraction.
  assert.equal(
    SOLAR_GLARE_PEDESTAL,
    1.0 /
      (1.0 +
        (SOLAR_GLARE_SUPPORT / SOLAR_GLARE_CORE) *
          (SOLAR_GLARE_SUPPORT / SOLAR_GLARE_CORE)),
  );
});

test("C12-27: the three zero-guards are mutually REDUNDANT at support = 90 deg", () => {
  // Recorded because a live mutation sweep found it, and because it changes
  // what a future reader should conclude from a failed "remove this guard"
  // experiment. `solarGlareVeil` reaches exact zero outside the support by
  // THREE independent routes:
  //
  //   (a) the `cosSeparation <= 0.0` early-out,
  //   (b) the `theta >= support` guard,
  //   (c) the lower clamp, since `raw < pedestal` past the support.
  //
  // At the shipped `support == PI/2` all three cover the same half-space, so
  // deleting any ONE of them leaves the function bit-identical — a mutation
  // suite cannot "catch" such a deletion, and it would be wrong to claim it
  // does. Keep all three anyway: (a) is the fast path that skips an `acos` for
  // half the sky, and (b)+(c) are what keep the function correct for a support
  // BELOW 90 deg, where (a) alone is NOT sufficient. The second half of this
  // test is the proof of that last clause.
  const withoutEarlyOut = (cos, core, pedestal, support) => {
    const theta = Math.acos(Math.min(cos, 1.0));
    if (theta >= support) {
      return 0.0;
    }
    const t = theta / core;
    const raw = 1.0 / (1.0 + t * t);
    const v = (raw - pedestal) / (1.0 - pedestal);
    return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
  };
  const withoutSupportGuard = (cos, core, pedestal) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const t = Math.acos(Math.min(cos, 1.0)) / core;
    const raw = 1.0 / (1.0 + t * t);
    const v = (raw - pedestal) / (1.0 - pedestal);
    return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v;
  };
  const withoutLowerClamp = (cos, core, pedestal, support) => {
    if (cos <= 0.0) {
      return 0.0;
    }
    const theta = Math.acos(Math.min(cos, 1.0));
    if (theta >= support) {
      return 0.0;
    }
    const t = theta / core;
    const raw = 1.0 / (1.0 + t * t);
    return Math.min((raw - pedestal) / (1.0 - pedestal), 1.0);
  };
  for (let i = 0; i <= 4000; i++) {
    const cos = -1.0 + (2.0 * i) / 4000;
    const reference = angularGlareVeil(cos, CORE, PEDESTAL, SUPPORT);
    assert.equal(withoutEarlyOut(cos, CORE, PEDESTAL, SUPPORT), reference);
    assert.equal(withoutSupportGuard(cos, CORE, PEDESTAL), reference);
    assert.equal(withoutLowerClamp(cos, CORE, PEDESTAL, SUPPORT), reference);
  }

  // Now the clause that makes the redundancy conditional: at a 60 deg support
  // the early-out alone is NOT enough — it would leave a live veil between
  // 60 and 90 deg, so the other two guards are load-bearing there.
  const narrow = toRadians(60.0);
  const narrowPedestal = lorentzianPedestal(narrow, CORE);
  const at75 = Math.cos(toRadians(75.0));
  assert.equal(angularGlareVeil(at75, CORE, narrowPedestal, narrow), 0.0);
  const naive = (() => {
    if (at75 <= 0.0) {
      return 0.0;
    }
    const t = Math.acos(Math.min(at75, 1.0)) / CORE;
    const raw = 1.0 / (1.0 + t * t);
    return Math.min((raw - narrowPedestal) / (1.0 - narrowPedestal), 1.0);
  })();
  assert.ok(naive < 0.0, "the guards are load-bearing for a narrower support");
});

// ───────────────────────────────────────────────────────────────────────────
// Constants: derived, not dialled
// ───────────────────────────────────────────────────────────────────────────

test("C12-27: every curve constant is derived from a stated quantity", () => {
  // The core is the GEOMETRIC centre of the Stiles-Holladay validity band.
  assert.equal(SOLAR_GLARE_ANGULAR_VALID_MIN_DEG, 1.0);
  assert.equal(SOLAR_GLARE_ANGULAR_VALID_MAX_DEG, 30.0);
  const expectedCoreDeg = Math.sqrt(
    SOLAR_GLARE_ANGULAR_VALID_MIN_DEG * SOLAR_GLARE_ANGULAR_VALID_MAX_DEG,
  );
  assert.ok(Math.abs(expectedCoreDeg - 5.477225575051661) < 1e-15);
  assert.ok(Math.abs((CORE * 180.0) / Math.PI - expectedCoreDeg) < 1e-15);

  // The support is the acceptance criterion, exactly.
  assert.equal(SUPPORT, Math.PI / 2.0);
  // ...and it MUST be <= PI/2 or the `cos <= 0` early-out stops being exact.
  assert.ok(SUPPORT <= Math.PI / 2.0);

  // The pedestal follows from the two above; nothing else may set it.
  assert.equal(PEDESTAL, lorentzianPedestal(SUPPORT, CORE));
  assert.ok(Math.abs(PEDESTAL - 0.0036900369003690036) < 1e-18);

  // Strength is the one appearance parameter and is disclosed as such.
  assert.equal(SOLAR_GLARE_STRENGTH, 1.0);
});

// ───────────────────────────────────────────────────────────────────────────
// Resolver: the single CPU site all four consumers read
// ───────────────────────────────────────────────────────────────────────────

const IDENTITY_MATRIX3 = {
  0: 1,
  1: 0,
  2: 0,
  3: 0,
  4: 1,
  5: 0,
  6: 0,
  7: 0,
  8: 1,
  length: 9,
};

test("resolver: ON produces a unit TEME Sun direction and the shipped curve", () => {
  const r = readSolarGlareAppearance(
    { enableAngularSolarGlare: true },
    { x: 0.6, y: 0.0, z: 0.8 },
    undefined,
    undefined,
    createSolarGlareAppearance(),
  );
  assert.equal(r.enabled, true);
  assert.equal(r.strength, 1.0);
  assert.equal(r.angularCore, CORE);
  assert.equal(r.pedestal, PEDESTAL);
  assert.equal(r.support, SUPPORT);
  const d = r.sunDirectionTeme;
  assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1.0) < 1e-15);
  assert.ok(Math.abs(d.x - 0.6) < 1e-15 && Math.abs(d.z - 0.8) < 1e-15);
});

test("resolver: OFF lands on the EXACT identity", () => {
  const r = readSolarGlareAppearance(
    { enableAngularSolarGlare: false },
    { x: 0.0, y: 0.0, z: 1.0 },
    undefined,
    undefined,
    createSolarGlareAppearance(),
  );
  assert.equal(r.enabled, false);
  // Strength EXACTLY 0 is what makes every shader skip its whole glare block.
  assert.equal(r.strength, 0.0);
  assert.equal(solarAngularGlareFactor(1.0, r.strength), 1.0);
});

test("resolver: no lighting facade (no globe) keeps the pre-C12-27 look", () => {
  const r = readSolarGlareAppearance(
    undefined,
    { x: 0.0, y: 0.0, z: 1.0 },
    undefined,
    undefined,
    createSolarGlareAppearance(),
  );
  assert.equal(r.enabled, false);
  assert.equal(r.strength, 0.0);
});

test("resolver: no sun direction disables rather than producing NaN", () => {
  const r = readSolarGlareAppearance(
    { enableAngularSolarGlare: true },
    undefined,
    undefined,
    undefined,
    createSolarGlareAppearance(),
  );
  assert.equal(r.enabled, false);
  assert.equal(r.strength, 0.0);
});

test("resolver: a degenerate (zero-length) sun direction disables", () => {
  const r = readSolarGlareAppearance(
    { enableAngularSolarGlare: true },
    { x: 0.0, y: 0.0, z: 0.0 },
    IDENTITY_MATRIX3,
    undefined,
    createSolarGlareAppearance(),
  );
  assert.equal(r.enabled, false);
  assert.equal(r.strength, 0.0);
});

test("resolver: the TEME rotation is applied as the INVERSE, not forward", () => {
  // A 90 deg rotation about +Z as a column-major Matrix3: TEME -> fixed. The
  // Sun arrives in the FIXED frame, so the resolver must apply the TRANSPOSE.
  // Getting this backwards rotates the glare centre by twice the sidereal
  // angle — a bug that looks like "the washout is in the wrong place" and is
  // invisible at t = 0.
  const temeToFixed = { 0: 0, 1: 1, 2: 0, 3: -1, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 };
  const r = readSolarGlareAppearance(
    { enableAngularSolarGlare: true },
    { x: 1.0, y: 0.0, z: 0.0 },
    temeToFixed,
    undefined,
    createSolarGlareAppearance(),
  );
  const d = r.sunDirectionTeme;
  // transpose * (1,0,0) = (0,-1,0); the forward rotation would give (0,1,0).
  assert.ok(Math.abs(d.x) < 1e-15, "x must vanish");
  assert.ok(Math.abs(d.y + 1.0) < 1e-15, "the INVERSE rotation must be used");
});

// ───────────────────────────────────────────────────────────────────────────
// C12-27 SOURCE-VISIBILITY GATE (Batch 873) — the veil needs a visible Sun
//
// The row as first landed had NO notion of whether the Sun delivers any flux
// to the observer, and Batch 865 filed that against itself. Below the horizon
// the veil still removed every star within 90 deg of the Sun's SKY POSITION —
// glare with no glare source, and user-visible as a bald patch in a night sky.
//
// The gate is one multiply by `eclipseState.sunVisibleFraction`. Every test
// here is written so that DELETING the multiply (`strength = enabled ?
// SOLAR_GLARE_STRENGTH : 0.0`) fails it — that is the adversarial mutant, and
// it is the pre-fix source verbatim.
// ───────────────────────────────────────────────────────────────────────────

const eclipse = (fields) => ({
  enabled: true,
  valid: true,
  sunVisibleFraction: 1.0,
  ...fields,
});

const resolveStrength = (eclipseState) =>
  readSolarGlareAppearance(
    { enableAngularSolarGlare: true },
    { x: 0.6, y: 0.0, z: 0.8 },
    undefined,
    eclipseState,
    createSolarGlareAppearance(),
  );

test("visibility: a fully occluded Sun drives strength to EXACTLY 0", () => {
  // Night, or a camera in Earth's shadow: `earthOcclusionFraction` saturates
  // at 1, so `sunVisibleFraction` is 0. Exactly 0 is what makes every
  // consumer's `> 0.0` guard skip its whole glare block, i.e. byte-identical
  // to the no-Sun frame rather than merely close to it.
  const r = resolveStrength(eclipse({ sunVisibleFraction: 0.0 }));
  assert.equal(r.strength, 0.0);
  assert.equal(r.sunVisibleFraction, 0.0);
  // ...and therefore the multiplier is exactly 1.0 even DEAD ON the Sun.
  assert.equal(solarAngularGlareFactor(1.0, r.strength), 1.0);
  // `enabled` still reports the TOGGLE, not the physics — a probe must be able
  // to tell "switched off" from "source not visible".
  assert.equal(r.enabled, true);
});

test("visibility: a partly occluded Sun scales the veil linearly", () => {
  const r = resolveStrength(eclipse({ sunVisibleFraction: 0.25 }));
  assert.equal(r.strength, 0.25);
  // Dead on the Sun the multiplier is 1 - strength, so a quarter-lit Sun
  // leaves three quarters of the star's radiance instead of extinguishing it.
  assert.ok(Math.abs(solarAngularGlareFactor(1.0, r.strength) - 0.75) < 1e-15);
});

test("visibility: a fully visible Sun is bit-identical to the pre-gate row", () => {
  const r = resolveStrength(eclipse({ sunVisibleFraction: 1.0 }));
  assert.equal(r.strength, SOLAR_GLARE_STRENGTH);
  assert.equal(solarAngularGlareFactor(1.0, r.strength), 0.0);
});

test("visibility: absent / invalid / disabled eclipse state resolves to 1.0", () => {
  // These are the identity rules. A missing state (no globe, 2D/CV/MORPHING,
  // the first frame before the ephemeris resolves) must NOT switch the veil
  // off — that would make the row inert in exactly the scenes it was asked
  // for. Same for `enableEclipse` off: every other consumer's off position
  // applies exactly 1.0.
  for (const state of [
    undefined,
    null,
    eclipse({ valid: false, sunVisibleFraction: 0.0 }),
    eclipse({ enabled: false, sunVisibleFraction: 0.0 }),
    eclipse({ sunVisibleFraction: Number.NaN }),
    eclipse({ sunVisibleFraction: "0" }),
  ]) {
    const r = resolveStrength(state);
    assert.equal(r.strength, SOLAR_GLARE_STRENGTH, JSON.stringify(state));
    assert.equal(r.sunVisibleFraction, 1.0);
  }
});

test("visibility: out-of-range fractions are clamped, never extrapolated", () => {
  assert.equal(
    resolveStrength(eclipse({ sunVisibleFraction: -0.5 })).strength,
    0.0,
  );
  assert.equal(
    resolveStrength(eclipse({ sunVisibleFraction: 4.0 })).strength,
    1.0,
  );
});

test("visibility: the toggle OFF position stays EXACTLY 0 at every visibility", () => {
  // The multiply must not be able to resurrect a disabled row, and it must not
  // turn the off position into `0 * something` that could round differently.
  for (const f of [0.0, 0.5, 1.0]) {
    const r = readSolarGlareAppearance(
      { enableAngularSolarGlare: false },
      { x: 0.6, y: 0.0, z: 0.8 },
      undefined,
      eclipse({ sunVisibleFraction: f }),
      createSolarGlareAppearance(),
    );
    assert.equal(r.enabled, false);
    assert.equal(r.strength, 0.0);
  }
});

test("visibility: the resolver reads the state — the multiply is IN the source", () => {
  // Source-anchored, CRLF-normalised. The mutant this rejects is the pre-fix
  // line `result.strength = enabled ? SOLAR_GLARE_STRENGTH : 0.0;`, which
  // every behavioural test above also rejects; this one additionally proves
  // the gate is a single named resolution rather than an inline re-derivation
  // that a second consumer could disagree with.
  const src = read("packages/engine/Source/Scene/SolarGlareAppearance.js");
  assert.match(src, /function resolveSunVisibility\(eclipseState\)/);
  assert.match(
    src,
    /result\.strength = enabled \? SOLAR_GLARE_STRENGTH \* visibility : 0\.0;/,
  );
  assert.equal((src.match(/sunVisibleFraction/g) ?? []).length >= 2, true);
  // Scene must hand the resolver the PUBLISHED state, not re-derive one.
  assert.match(
    sceneJs,
    /readSolarGlareAppearance\(\s*frameState\.atmosphericConditions\?\.lighting,\s*frameState\.context\.uniformState\.sunDirectionWC,\s*frameState\.context\.uniformState\.temeToPseudoFixedMatrix,\s*frameState\.eclipseState,/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring: resolved ONCE on the CPU, published, packed, gated
// ───────────────────────────────────────────────────────────────────────────

test("Scene.updateEnvironment resolves once, BEFORE both star consumers", () => {
  assert.match(
    sceneJs,
    /frameState\.solarGlareAppearance = readSolarGlareAppearance\(/,
  );
  const resolveAt = sceneJs.indexOf(
    "frameState.solarGlareAppearance = readSolarGlareAppearance(",
  );
  const skyBoxAt = sceneJs.indexOf("this.skyBox.update(frameState, this._hdr)");
  const starAt = sceneJs.indexOf("starField.update(frameState)");
  assert.ok(resolveAt > 0 && skyBoxAt > 0 && starAt > 0);
  assert.ok(resolveAt < skyBoxAt, "must resolve before the cube map updates");
  assert.ok(resolveAt < starAt, "must resolve before the sprites update");
  // Exactly one CALL site — no second derivation anywhere in Scene (the named
  // import carries no parenthesis, so this counts calls only).
  assert.equal((sceneJs.match(/readSolarGlareAppearance\(/g) ?? []).length, 1);
  // The non-drawing path must clear it rather than leave a stale frame.
  assert.match(sceneJs, /frameState\.solarGlareAppearance = undefined;/);
  assert.match(frameStateJs, /this\.solarGlareAppearance = undefined;/);
});

test("the toggle is registered in AtmosphericConditions, default ON", () => {
  assert.match(conditions, /enableAngularSolarGlare: true,/);
  // The public `lighting` JSDoc registry must name it.
  const jsdocAt = conditions.indexOf("Lighting flags.");
  const getterAt = conditions.indexOf("get lighting()");
  const registry = conditions.slice(jsdocAt, getterAt);
  assert.ok(registry.includes("enableAngularSolarGlare"));
});

test("WGSL star UB members are appended at the tail, existing offsets frozen", () => {
  const code = stripLineComments(starWgsl);
  const camUpAt = code.indexOf("cameraUpTeme: vec3<f32>");
  const glareAt = code.indexOf("solarGlare: vec4<f32>");
  const curveAt = code.indexOf("solarGlareCurve: vec4<f32>");
  assert.ok(camUpAt > 0 && glareAt > camUpAt && curveAt > glareAt);
  assert.match(starWgsl, /solarGlare: vec4<f32>,\s+\/\/ 112\.\.127/);
  assert.match(starWgsl, /solarGlareCurve: vec4<f32>,\s+\/\/ 128\.\.143/);
  // ADD-ONLY: the allocation is unchanged, so no BGL or bind-group churn.
  assert.match(starRendererTs, /const STAR_UNIFORM_BUFFER_SIZE = 256;/);
});

test("WebGPU star pack writes the reserved tail floats with identity fallbacks", () => {
  assert.match(starRendererTs, /uniformData\[28\] = sun\.x;/);
  assert.match(starRendererTs, /uniformData\[31\] = glare\.strength;/);
  assert.match(starRendererTs, /uniformData\[32\] = glare\.angularCore;/);
  assert.match(starRendererTs, /uniformData\[34\] = glare\.support;/);
  // Every pre-existing offset is untouched.
  assert.match(starRendererTs, /uniformData\[18\] = effectiveIntensityScale;/);
  assert.match(starRendererTs, /uniformData\[27\] = 0\.0;/);
  // The disabled branch must write strength 0, not simply skip.
  assert.match(starRendererTs, /uniformData\[31\] = 0\.0;/);
});

test("WebGL star renderer feeds the same resolution through uniforms", () => {
  assert.match(starRendererJs, /frameState\.solarGlareAppearance/);
  assert.match(starRendererJs, /u_solarGlare: function \(\) \{/);
  assert.match(starRendererJs, /u_solarGlareCurve: function \(\) \{/);
  assert.match(starRendererJs, /cache\.solarGlare\.w = 0\.0;/);
});

test("the sprite VS dots against the RAW TEME attribute on BOTH backends", () => {
  // If GLSL used the already-rotated `dirFixed` while WGSL used the TEME
  // attribute, the two backends would disagree by the sidereal rotation.
  assert.match(
    stripLineComments(starGlsl),
    /dot\(directionFixed, u_solarGlare\.xyz\)/,
  );
  assert.ok(
    !stripLineComments(starGlsl).includes("dot(dirFixed, u_solarGlare"),
  );
  assert.match(
    stripLineComments(starWgsl),
    /dot\(input\.directionFixed, u\.solarGlare\.xyz\)/,
  );
  // And the glare rides LAST in both multiply chains, so `glare == 1.0` is an
  // exact identity rather than a re-association of the product.
  assert.match(
    stripLineComments(starGlsl),
    /v_color = starColor \* intensity \* u_intensityScale \* extinction \* glare;/,
  );
  assert.match(
    stripLineComments(starWgsl),
    /output\.color = input\.color \* input\.intensity \* u\.intensityScale \* extinction \* glare;/,
  );
});

test("the cube-map pair applies the glare in the SAME position in the chain", () => {
  // Contract order: modulate -> cloud-occlude -> GLARE -> gamma. Moving the
  // multiply across the gamma step desynchronises the backends under HDR,
  // because k*x^g != (k*x)^g.
  for (const [name, text] of [
    ["CubeMapPanorama.wgsl", panoramaWgsl],
    ["embedded WGSL", inlinePanoramaWgsl],
  ]) {
    const code = stripLineComments(text);
    const cloudAt = code.indexOf("modulated = modulated * (1.0 - cloudCover);");
    const glareAt = code.indexOf(
      "modulated = modulated * (1.0 - uniforms.solarGlare.w * veil);",
    );
    const gammaAt = code.indexOf("let hdrGamma = uniforms.hdr.x;");
    assert.ok(cloudAt > 0 && glareAt > cloudAt, `${name}: glare after cloud`);
    assert.ok(gammaAt > glareAt, `${name}: glare before gamma`);
  }
  const glslCode = stripLineComments(panoramaGlsl);
  const cloudAt = glslCode.indexOf(
    "color.rgb *= (1.0 - clamp(u_starModulation.w, 0.0, 1.0));",
  );
  const glareAt = glslCode.indexOf(
    "color.rgb *= (1.0 - u_solarGlare.w * veil);",
  );
  const gammaAt = glslCode.indexOf("czm_gammaCorrect(color)");
  assert.ok(cloudAt > 0 && glareAt > cloudAt && gammaAt > glareAt);
  // Both cube-map twins sample and dot the SAME direction vector.
  assert.match(glslCode, /vec3 dir = normalize\(v_texCoord\);/);
  assert.match(glslCode, /dot\(dir, u_solarGlare\.xyz\)/);
  assert.match(
    stripLineComments(panoramaWgsl),
    /dot\(dir, uniforms\.solarGlare\.xyz\)/,
  );
});

test("the panorama UB grew ADD-ONLY and every prior offset is unchanged", () => {
  assert.match(panoramaRendererJs, /const UNIFORM_BUFFER_SIZE = 288;/);
  // The C12-27 vec4s occupy floats 60..67 = bytes 240..271.
  assert.match(
    panoramaRendererJs,
    /uniformData\[63\] = solarGlare\?\.w \?\? 0\.0;/,
  );
  assert.match(
    panoramaRendererJs,
    /uniformData\[64\] = solarGlareCurve\?\.x \?\? 1\.0;/,
  );
  // Pre-existing writes still land where they did.
  assert.match(
    panoramaRendererJs,
    /uniformData\[48\] = uniformState\.entireFrustum\.y;/,
  );
  assert.match(panoramaRendererJs, /uniformData\[56\] =/);
  // Both WGSL copies declare the members in the same order at the tail.
  for (const text of [panoramaWgsl, inlinePanoramaWgsl]) {
    const code = stripLineComments(text);
    const hdrAt = code.indexOf("hdr: vec4<f32>,");
    const glareAt = code.indexOf("solarGlare: vec4<f32>,");
    const curveAt = code.indexOf("solarGlareCurve: vec4<f32>,");
    assert.ok(hdrAt > 0 && glareAt > hdrAt && curveAt > glareAt);
  }
});

test("the cube-map glare is gated on isStarMap, NOT on the atmosphere", () => {
  // Generic and Street View panoramas must stay byte-identical...
  assert.match(
    panoramaScene,
    /panorama\._isStarMap === true &&\s*\n\s*defined\(glareAppearance\)/,
  );
  assert.match(panoramaScene, /g\.w = 0\.0;/);
  // ...and the glare must NOT inherit the sky-atmosphere gate the star
  // modulation carries, or it would be inert in orbit — the exact viewpoint
  // this row was reported from. The modulation block still has its gate.
  assert.match(
    panoramaScene,
    /sky\.enableStarBrightnessModulation === true &&\s*\n\s*frameState\.skyAtmosphereVisible === true/,
  );
  const glareBlockAt = panoramaScene.indexOf(
    "const glareAppearance = frameState.solarGlareAppearance;",
  );
  assert.ok(glareBlockAt > 0);
  const glareBlock = panoramaScene.slice(glareBlockAt);
  assert.ok(
    !glareBlock.includes("skyAtmosphereVisible"),
    "the angular glare must not be gated by skyAtmosphereVisible",
  );
  assert.ok(
    !glareBlock.includes("computeAtmosphericColumnFactor"),
    "the angular glare must not be gated by the atmospheric column factor",
  );
});

test("no shader carries a numeric copy of the curve constants", () => {
  // The C12-15/16 convention: the numbers travel as uniforms so there is
  // nothing to drift. A literal here is the drift.
  const coreDigits = CORE.toString().slice(0, 8);
  const pedestalDigits = PEDESTAL.toString().slice(0, 8);
  for (const [name, text] of [
    ["StarField.wgsl", starWgsl],
    ["StarFieldVS.glsl", starGlsl],
    ["CubeMapPanorama.wgsl", panoramaWgsl],
    ["SkyBoxFS.glsl", panoramaGlsl],
    ["embedded WGSL", inlinePanoramaWgsl],
  ]) {
    const code = stripLineComments(text);
    assert.ok(!code.includes(coreDigits), `${name} hard-codes the core`);
    assert.ok(
      !code.includes(pedestalDigits),
      `${name} hard-codes the pedestal`,
    );
    assert.ok(!code.includes("1.5707963"), `${name} hard-codes the support`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// C12-14 — the samplable star texture
// ───────────────────────────────────────────────────────────────────────────

test("C12-14: the descriptor reports availability and ownership honestly", () => {
  const r = cubeMapResource.createStarCubeMapResource();
  assert.equal(r.available, false);
  assert.equal(r.orientation, "TEME");

  cubeMapResource.setWebGLStarCubeMap(r, { width: 2048 });
  assert.equal(r.available, true);
  assert.equal(r.backend, "webgl");
  assert.equal(r.faceSize, 2048);
  assert.ok(r.webgpuTexture === undefined && r.webgpuTextureView === undefined);

  cubeMapResource.setWebGPUStarCubeMap(r, { width: 1024 }, {});
  assert.equal(r.backend, "webgpu");
  assert.equal(r.faceSize, 1024);
  assert.ok(r.webglCubeMap === undefined, "a backend swap must not leave both");

  // A still-loading / destroyed texture must publish "not available" rather
  // than a stale handle — the async-load rule the header states.
  cubeMapResource.setWebGPUStarCubeMap(r, undefined, undefined);
  assert.equal(r.available, false);
  assert.equal(r.webgpuTexture, undefined);
  cubeMapResource.setWebGLStarCubeMap(r, undefined);
  assert.equal(r.available, false);
});

test("C12-14: both backends realize the handle and the star map publishes it", () => {
  assert.match(
    panoramaScene,
    /setWebGPUStarCubeMap\(this\._samplableCubeMap, gpu\?\.texture, gpu\?\.view\);/,
  );
  assert.match(
    panoramaScene,
    /setWebGLStarCubeMap\(this\._samplableCubeMap, this\._cubeMap\);/,
  );
  // The WebGPU refresh must run AFTER the feature renderer's update, or the
  // texture created this frame is missed for a frame.
  const frUpdateAt = panoramaScene.indexOf(
    "const command = fr.update(this, frameState, useHdr);",
  );
  const frResourceAt = panoramaScene.indexOf("fr.getResource(this)");
  assert.ok(frUpdateAt > 0 && frResourceAt > frUpdateAt);
  // The WebGL refresh must run BEFORE the "no cube map yet" early-out, or a
  // loading frame leaves a stale handle published.
  const webglSetAt = panoramaScene.indexOf(
    "setWebGLStarCubeMap(this._samplableCubeMap",
  );
  const earlyOutAt = panoramaScene.indexOf("if (!defined(this._cubeMap)) {");
  assert.ok(webglSetAt > 0 && earlyOutAt > webglSetAt);
  // Only star maps claim the frame-wide slot.
  assert.match(
    panoramaScene,
    /if \(panorama\._isStarMap !== true\) \{\s*\n\s*return;/,
  );
  assert.match(
    panoramaScene,
    /frameState\.starCubeMap = panorama\._samplableCubeMap;/,
  );
  assert.match(frameStateJs, /this\.starCubeMap = undefined;/);
  // Teardown drops the borrowed handles.
  assert.match(
    panoramaScene,
    /clearStarCubeMapResource\(this\._samplableCubeMap\);/,
  );
  // The WebGPU side is reached through the feature renderer, so scene code
  // never imports from Renderer/WebGPU (Principle 2).
  assert.match(featureRenderers, /getResource: getCubeMapPanoramaResource,/);
  assert.ok(!panoramaScene.includes("Renderer/WebGPU/"));
  // SkyBox re-exposes it, and reports which variant is loaded so a consumer
  // can tell whether the map carries resolved stars (DR-01: the default does
  // NOT).
  assert.match(
    skyBoxScene,
    /get starCubeMap\(\) \{\s*\n\s*return this\._panorama\.samplableCubeMap;/,
  );
  assert.match(skyBoxScene, /get variant\(\) \{/);
  // Batch 932 (C12-12) hoisted the default-variant ternary into
  // `resolvedVariant` so the resolution policy could read it; the semantic —
  // the default star variant is TYCHO_T3, and it is what the constructor
  // receives — is unchanged and both halves are pinned.
  assert.match(
    skyBoxScene,
    /const resolvedVariant = defined\(descriptor\) \? v : SkyBox\.Variant\.TYCHO_T3;/,
  );
  assert.match(skyBoxScene, /variant: resolvedVariant,/);
  // Replacing the sources must stop claiming a variant rather than go stale.
  assert.match(
    skyBoxScene,
    /this\._panorama\.sources = value;\s*\n[\s\S]{0,240}?this\._variant = undefined;/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// C12-13 — the LICENSE.md residual
// ───────────────────────────────────────────────────────────────────────────

test("C12-13: every shipped skybox face is covered by the LICENSE entry", () => {
  const dir = "packages/engine/Source/Assets/Textures/SkyBox";
  const files = fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(".jpg"));
  assert.equal(files.length, 18, "18 bundled faces expected");
  const start = licenseMd.indexOf("### Star map cube maps");
  const end = licenseMd.indexOf("### Lunar albedo map");
  assert.ok(start > 0 && end > start);
  const entry = licenseMd.slice(start, end);
  for (const prefix of ["tycho2t3_80", "tycho2t5_80", "tycho2t5_80_diffuse"]) {
    assert.ok(entry.includes(prefix), `LICENSE must cover ${prefix}`);
  }
  // The recorded total must equal the bytes actually on disk.
  const total = files.reduce(
    (sum, f) => sum + fs.statSync(path.join(root, dir, f)).size,
    0,
  );
  assert.ok(
    entry.includes(total.toLocaleString("en-US")),
    `LICENSE must record the real bundled total (${total.toLocaleString("en-US")})`,
  );
  // The derivation chain for the baked faces, in order.
  for (const step of [
    "SMPTE gamma-1.8",
    "bake-tycho-t5.mjs",
    "4096/face",
    "lanczos3",
    "quality 90",
    "4:4:4",
  ]) {
    assert.ok(entry.includes(step), `LICENSE must record the step "${step}"`);
  }
  // PREMISE CORRECTION recorded in the entry: there is no KTX2 bake to
  // document, because C12-12 has not landed. Assert BOTH halves — the claim
  // and the fact — so this test fails the day a KTX2 asset ships without the
  // entry being updated.
  assert.ok(entry.includes("KTX2"), "LICENSE must state the KTX2 position");
  const anyKtx2 = fs
    .readdirSync(path.join(root, dir))
    .some((f) => f.endsWith(".ktx2") || f.endsWith(".basis"));
  assert.equal(anyKtx2, false, "a KTX2 face shipped; update the LICENSE entry");
});

// ───────────────────────────────────────────────────────────────────────────
// Numeric predictions the Edge acceptance run must reproduce
// ───────────────────────────────────────────────────────────────────────────

test("PREDICTIONS: the numbers the Edge run is measured against", () => {
  const near = (a, b, eps = 1e-9) =>
    assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

  // Radiance MULTIPLIER (1 - veil) at the reported separations.
  near(1 - veilAtDegrees(1), 0.032377539);
  near(1 - veilAtDegrees(5.477225575051661), 0.501851852);
  near(1 - veilAtDegrees(10), 0.772079772);
  near(1 - veilAtDegrees(20), 0.933677864);
  near(1 - veilAtDegrees(30), 0.971326165);
  // At and past the support the multiplier is EXACTLY one — the acceptance
  // criterion, as an identity.
  assert.equal(1 - veilAtDegrees(90), 1.0);
  assert.equal(1 - veilAtDegrees(120), 1.0);
  assert.equal(solarAngularGlareFactor(Math.cos(toRadians(150)), 1.0), 1.0);

  // In 8-bit code values, on the SDR default target. `StarFieldMath`'s
  // exposure anchor puts a mag-3.6 star's peak at 0.060 linear = 15.3/255 by
  // construction, so the anchor star is the cleanest sprite probe target.
  const anchorPeak = 0.06;
  const cv = (linear) => linear * 255.0;
  near(cv(anchorPeak), 15.3, 1e-9);
  near(cv(anchorPeak * (1 - veilAtDegrees(10))), 11.81282, 1e-5);
  near(cv(anchorPeak * (1 - veilAtDegrees(30))), 14.86129, 1e-5);
  assert.equal(cv(anchorPeak * (1 - veilAtDegrees(90))), cv(anchorPeak));

  // A mag-2.0 star is the strongest UNCLIPPED signal: peak = 1.08 * EXPOSURE *
  // 10^(-0.4*2) with EXPOSURE = (0.06/1.08)*10^(0.4*3.6).
  const EXPOSURE = (0.06 / 1.08) * Math.pow(10, 0.4 * 3.6);
  const peak = (mag) => 1.08 * EXPOSURE * Math.pow(10, -0.4 * mag);
  near(peak(2.0), 0.2619095, 1e-8);
  near(cv(peak(2.0)), 66.786922, 1e-6);
  near(cv(peak(2.0) * (1 - veilAtDegrees(10))), 51.564832, 1e-6);
  // ~15 code values at 10 deg: comfortably above any sane diff threshold.
  assert.ok(cv(peak(2.0)) - cv(peak(2.0) * (1 - veilAtDegrees(10))) > 12.0);

  // HONEST LIMIT — the brightest stars show NO core change until the
  // separation is small. Sirius' profile peak is 6.341 linear, so it stays
  // clipped at 255 until the multiplier drops it under 1.0, i.e. until
  // veil > 0.84229, i.e. inside ~2.37 deg. A probe that measures Sirius' core
  // at 10 deg will correctly measure zero movement; that is the design, not a
  // failure. (Its HALO does move at 10 deg — the halo share is 0.47 < 1 by
  // C12-07 construction, so it never clipped in the first place.)
  near(peak(-1.46), 6.34090506, 1e-8);
  const clipEscapeVeil = 1.0 - 1.0 / peak(-1.46);
  near(clipEscapeVeil, 0.84229381, 1e-8);
  let clipEscapeDeg = 0;
  for (let i = 1; i <= 90000; i++) {
    const deg = i / 1000;
    if (veilAtDegrees(deg) < clipEscapeVeil) {
      clipEscapeDeg = deg;
      break;
    }
  }
  assert.ok(
    Math.abs(clipEscapeDeg - 2.365) < 0.002,
    `Sirius should leave the clip at 2.365 deg; got ${clipEscapeDeg}`,
  );

  // The cube map's diffuse band peaks at 8..28 code values (measured in
  // `Tools/skybox-bake/skybox-manifest.json`), so its movement is small in
  // absolute terms even where the multiplier is large: at 10 deg a peak-28
  // texel loses 6.4 code values, at 30 deg only 0.8. State it so the Edge run
  // targets the sprite lane for the headline number and treats the cube-map
  // lane as corroboration.
  near(28 * veilAtDegrees(10), 6.381766, 1e-5);
  near(28 * veilAtDegrees(30), 0.802867, 1e-5);

  // OFF: exact identity everywhere, at every separation.
  for (const deg of [0, 1, 10, 45, 90, 180]) {
    assert.equal(
      solarAngularGlareFactor(Math.cos(toRadians(deg)), 0.0),
      1.0,
      "the OFF position must be an exact identity",
    );
  }
});

test("both WGSL cube-map copies and the star WGSL pass naga validation", async () => {
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
  assert.doesNotThrow(() => naga.validate_wgsl(starWgsl), "StarField.wgsl");
  assert.doesNotThrow(
    () => naga.validate_wgsl(panoramaWgsl),
    "CubeMapPanorama.wgsl",
  );
  assert.doesNotThrow(
    () => naga.validate_wgsl(inlinePanoramaWgsl),
    "embedded panorama WGSL",
  );
});
