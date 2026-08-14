// moon-phase-terminator.spec.mjs — C12-21 (phase-dependent earthshine) and
// C12-22 (soft terminator from the Sun's finite angular size), plus the
// C11-176b regression surface those two ride on.
//
// WHAT THIS SPEC IS FOR. Both rows are pure arithmetic changes inside a
// lockstep shader PAIR (`Shaders/WebGPU/Environment/Moon.wgsl` ↔
// `Shaders/EllipsoidFS.glsl`). The failure mode is not "it crashes", it is
// "one backend quietly computes something else" or "the sign is inverted and
// nobody notices because the term is small". So this spec does three things
// that a text-grep spec does not:
//
//   1. It EXTRACTS `softTerminatorMu0` from BOTH shader texts, compiles each
//      body as JavaScript, and checks all three implementations (WGSL, GLSL,
//      and the JS reference in `Scene/MoonPhaseAppearance.js`) agree to 1e-15
//      over a sweep that straddles the band. That is cross-language
//      equivalence, not a shared regex.
//   2. It states the mathematical PROPERTIES the terminator law must have as
//      a reusable predicate, and then runs that predicate against four
//      deliberately WRONG implementations to prove it rejects them. A check
//      that passes both the right and the wrong answer is worthless.
//   3. It pins the numbers the Edge acceptance run is supposed to reproduce.
//
// LINE ENDINGS: this repo checks out CRLF (`core.autocrlf=true`). Every
// source read below is normalised to `\n` first — a spec anchored on a bare
// `\n` silently false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/moon-phase-terminator.spec.mjs

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

const WGSL_PATH = "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl";
const GLSL_PATH = "packages/engine/Source/Shaders/EllipsoidFS.glsl";

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const sceneMoon = read("packages/engine/Source/Scene/Moon.js");
const primitive = read("packages/engine/Source/Scene/EllipsoidPrimitive.js");
const envRenderer = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);
const conditions = read(
  "packages/engine/Source/Scene/AtmosphericConditions.js",
);
const frameState = read("packages/engine/Source/Scene/FrameState.js");

const appearance = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Scene/MoonPhaseAppearance.js"),
  ).href
);

const {
  EARTHSHINE_TINT_RED,
  EARTHSHINE_TINT_GREEN,
  EARTHSHINE_TINT_BLUE,
  EARTHSHINE_STRENGTH,
  MEAN_SOLAR_ANGULAR_RADIUS,
  computeEarthshinePhaseScale,
  computeSolarAngularRadius,
  createMoonPhaseAppearance,
  readMoonPhaseAppearance,
  softTerminatorMu0,
} = appearance;

// Comment-stripped views. Both languages use `//`; the deleted C11-176b gate
// and every rationale block live on in comments deliberately (Principle 7),
// so absence checks must never run against raw text.
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
}

const wgslCode = stripLineComments(wgsl);
const glslCode = stripLineComments(glsl);

// ───────────────────────────────────────────────────────────────────────────
// Cross-language extraction: compile each shader's softTerminatorMu0 as JS.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Slices the balanced `{ ... }` body that follows `signature` in `source`.
 */
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

const jsClamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Compiles a shader function body into a JS callable. The bodies of both
 * twins are written so that the ONLY non-JavaScript tokens are the storage
 * keywords, which is itself part of the lockstep contract: if either shader
 * grows a construct that cannot be translated this way, the translation must
 * be made explicit rather than silently skipped.
 */
function compileShaderBody(body, replacements) {
  let js = body;
  for (const [pattern, replacement] of replacements) {
    js = js.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-new-func
  return new Function("nDotL", "hardMu0", "softness", "clamp", "max", js);
}

const wgslBody = extractBody(
  wgslCode,
  "fn softTerminatorMu0(nDotL: f32, hardMu0: f32, softness: f32) -> f32",
);
const glslBody = extractBody(
  glslCode,
  "float softTerminatorMu0(float nDotL, float hardMu0, float softness)",
);

const wgslFn = compileShaderBody(wgslBody, [[/\blet\b/g, "let"]]);
const glslFn = compileShaderBody(glslBody, [[/\bfloat\b/g, "let"]]);

const wgslMu0 = (c, w) => wgslFn(c, Math.max(c, 0.0), w, jsClamp, Math.max);
const glslMu0 = (c, w) => glslFn(c, Math.max(c, 0.0), w, jsClamp, Math.max);
const refMu0 = (c, w) => softTerminatorMu0(c, w);

// ───────────────────────────────────────────────────────────────────────────
// The property predicate — the thing the mutants must fail.
// ───────────────────────────────────────────────────────────────────────────

const W = MEAN_SOLAR_ANGULAR_RADIUS;

/**
 * Asserts every property C12-22 actually requires of a soft-terminator law.
 * Throws (any AssertionError) on the first violation; `rejects()` below uses
 * that to prove the wrong implementations are caught.
 */
function assertSoftTerminatorLaw(f) {
  // P1 — EXACT identity outside the band. This is what makes the off
  // position byte-identical rather than merely close, and it is what a
  // degrees-vs-radians unit error breaks first.
  for (const c of [-1.0, -0.5, -0.1, -W, W, 0.1, 0.5, 1.0]) {
    assert.equal(
      f(c, W),
      Math.max(c, 0.0),
      `outside the band the law must equal max(c,0) exactly (c=${c})`,
    );
  }
  // P2 — softness 0 is the exact legacy clip everywhere.
  for (const c of [-1.0, -1e-4, 0.0, 1e-4, 1.0]) {
    assert.equal(f(c, 0.0), Math.max(c, 0.0), "softness 0 must be identity");
  }
  // P3 — inside the band the law must BRIGHTEN, strictly. This is the whole
  // point: with a finite solar disc the surface just past the geometric
  // terminator is still partially lit. A gate-style law can only darken and
  // dies here.
  for (const c of [-0.75 * W, -0.5 * W, -0.25 * W, 0.0, 0.25 * W, 0.5 * W]) {
    assert.ok(
      f(c, W) > Math.max(c, 0.0),
      `the law must exceed max(c,0) inside the band (c/w=${c / W})`,
    );
  }
  // P4 — monotone non-decreasing across the band.
  let previous = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const c = -2.0 * W + (4.0 * W * i) / 400;
    const v = f(c, W);
    assert.ok(v >= previous - 1e-18, `law must be monotone (c/w=${c / W})`);
    previous = v;
  }
  // P5 — peak excess is exactly w/4, at exactly c = 0. Distinguishes this
  // closed form from every other smooth curve through the same seams.
  assert.ok(
    Math.abs(f(0.0, W) - W / 4.0) < 1e-18,
    "the law must give exactly w/4 at the geometric terminator",
  );
  // P6 — homogeneity: the law is scale-free in (c, w) jointly. A hard-coded
  // width (degrees, a magic 0.0044, a fixed 0.5°) breaks this immediately.
  for (const k of [0.5, 2.0, 10.0]) {
    for (const x of [-0.5, 0.0, 0.5]) {
      const scaled = f(k * x * W, k * W);
      assert.ok(
        Math.abs(scaled - k * f(x * W, W)) < 1e-18,
        `the law must be homogeneous (k=${k}, c/w=${x})`,
      );
    }
  }
}

function rejects(name, f) {
  let threw = false;
  try {
    assertSoftTerminatorLaw(f);
  } catch {
    threw = true;
  }
  assert.ok(
    threw,
    `the property predicate FAILED to reject the mutant: ${name}`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// C12-22 — the law itself
// ───────────────────────────────────────────────────────────────────────────

test("C12-22: the reference law satisfies every required property", () => {
  assertSoftTerminatorLaw(refMu0);
});

test("C12-22: WGSL and GLSL twins compile to the SAME function as the reference", () => {
  assertSoftTerminatorLaw(wgslMu0);
  assertSoftTerminatorLaw(glslMu0);
  let maxDelta = 0;
  for (let i = 0; i <= 2000; i++) {
    const c = -1.0 + (2.0 * i) / 2000;
    for (const w of [0.0, 1e-5, W, 0.05]) {
      const a = refMu0(c, w);
      maxDelta = Math.max(
        maxDelta,
        Math.abs(wgslMu0(c, w) - a),
        Math.abs(glslMu0(c, w) - a),
      );
    }
  }
  assert.ok(
    maxDelta < 1e-15,
    `WGSL/GLSL/JS must agree; max delta was ${maxDelta}`,
  );
});

// ── ADVERSARIAL: each mutant is a plausible wrong implementation ───────────

test("C12-22 mutant REJECTED: one bare smoothstep (the row's own wording)", () => {
  // `smoothstep(-w, w, c)` returns a 0..1 GATE, not an irradiance. Multiplying
  // the legacy clip by it leaves the dark side at exactly 0 and DARKENS the
  // lit side — it makes the terminator harder, which is the opposite of the
  // row's intent. Caught by P3 (must brighten) and P5 (w/4 at c=0).
  const smoothstep = (e0, e1, x) => {
    const t = jsClamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  };
  rejects("smoothstep gate", (c, w) =>
    w > 0 ? Math.max(c, 0.0) * smoothstep(-w, w, c) : Math.max(c, 0),
  );
});

test("C12-22 mutant REJECTED: smoothstep edges swapped", () => {
  const smoothstep = (e0, e1, x) => {
    const t = jsClamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  };
  // Edges reversed: bright where it should be dark. Caught by P1/P4.
  rejects("swapped edges", (c, w) =>
    w > 0 ? w * smoothstep(w, -w, c) + Math.max(c - w, 0.0) : Math.max(c, 0),
  );
});

test("C12-22 mutant REJECTED: width in DEGREES instead of N·L units", () => {
  // The classic unit slip — the row quotes the sun's size as "~0.5°", and
  // 0.25 as a number is a perfectly plausible thing to hand the shader.
  // Caught by P1: the band no longer closes at |c| = w.
  const DEG = 180.0 / Math.PI;
  rejects("degrees for radians", (c, w) => softTerminatorMu0(c, w * DEG));
});

test("C12-22 mutant REJECTED: quadratic band with the sign of c flipped", () => {
  // (w - c)^2 / (4w) instead of (c + w)^2 / (4w) — a one-character slip that
  // mirrors the penumbra about the terminator. Caught by P4 (monotonicity).
  rejects("mirrored quadratic", (c, w) => {
    if (!(w > 0)) {
      return Math.max(c, 0.0);
    }
    const clamped = jsClamp(c, -w, w);
    const t = w - clamped;
    return Math.max(c - w, 0.0) + (t * t) / (4.0 * w);
  });
});

test("C12-22 mutant REJECTED: no softening at all (the pre-C12-22 engine)", () => {
  rejects("hard clip", (c) => Math.max(c, 0.0));
});

// ───────────────────────────────────────────────────────────────────────────
// C12-21 — earthshine phase
// ───────────────────────────────────────────────────────────────────────────

/**
 * Earth's phase seen from the Moon is the exact complement of the Moon's
 * phase seen from Earth.
 */
function assertEarthshineLaw(f) {
  assert.equal(f(0.0), 1.0, "new moon: full Earth ⇒ earthshine at full scale");
  assert.equal(f(1.0), 0.0, "full moon: new Earth ⇒ earthshine exactly zero");
  assert.equal(f(0.5), 0.5, "quarter: exactly half");
  let previous = Infinity;
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    const v = f(p);
    assert.ok(v <= previous + 1e-18, "must decrease with the moon's phase");
    assert.ok(v >= 0.0 && v <= 1.0, "must stay in [0,1]");
    previous = v;
  }
  // Out-of-range inputs must clamp, not extrapolate into negative light.
  assert.equal(f(1.4), 0.0);
  assert.equal(f(-0.3), 1.0);
}

test("C12-21: the earthshine phase scale is the complement of the moon phase", () => {
  assertEarthshineLaw(computeEarthshinePhaseScale);
});

test("C12-21 mutant REJECTED: multiplied by phaseFraction, not its complement", () => {
  // The exact sign error the row exists to prevent: earthshine that peaks at
  // FULL moon, which is when Earth is new and lights nothing.
  let threw = false;
  try {
    assertEarthshineLaw((p) => jsClamp(p, 0, 1));
  } catch {
    threw = true;
  }
  assert.ok(threw, "predicate failed to reject the un-complemented scale");
});

test("C12-21 mutant REJECTED: tent profile peaking at quarter phase", () => {
  let threw = false;
  try {
    assertEarthshineLaw((p) => 1.0 - 2.0 * Math.abs(jsClamp(p, 0, 1) - 0.5));
  } catch {
    threw = true;
  }
  assert.ok(threw, "predicate failed to reject the tent profile");
});

test("C12-21 mutant REJECTED: unclamped complement (negative earthshine)", () => {
  let threw = false;
  try {
    assertEarthshineLaw((p) => 1.0 - p);
  } catch {
    threw = true;
  }
  assert.ok(threw, "predicate failed to reject the unclamped complement");
});

// ───────────────────────────────────────────────────────────────────────────
// Resolver: the single CPU site both backends read
// ───────────────────────────────────────────────────────────────────────────

test("resolver: both toggles ON produce the live values", () => {
  const r = readMoonPhaseAppearance(
    { enableEarthshinePhase: true, enableSoftTerminator: true },
    true,
    0.25,
    1.495978707e11,
    createMoonPhaseAppearance(),
  );
  assert.equal(r.earthshinePhase, true);
  assert.equal(r.softTerminator, true);
  assert.equal(r.earthshinePhaseScale, 0.75);
  assert.ok(Math.abs(r.terminatorSoftness - W) < 1e-15);
});

test("resolver: each toggle OFF lands on its EXACT identity", () => {
  const r = readMoonPhaseAppearance(
    { enableEarthshinePhase: false, enableSoftTerminator: false },
    true,
    0.25,
    1.495978707e11,
    createMoonPhaseAppearance(),
  );
  // 1.0 reproduces the historical CONSTANT earthshine bit-for-bit; 0.0 makes
  // softTerminatorMu0 return the legacy max(N·L, 0) bit-for-bit.
  assert.equal(r.earthshinePhaseScale, 1.0);
  assert.equal(r.terminatorSoftness, 0.0);
});

test("resolver: no lighting facade (no globe) keeps the pre-C12 look", () => {
  const r = readMoonPhaseAppearance(
    undefined,
    true,
    0.25,
    undefined,
    createMoonPhaseAppearance(),
  );
  assert.equal(r.earthshinePhaseScale, 1.0);
  assert.equal(r.terminatorSoftness, 0.0);
});

test("resolver: enableMoonPhase=false must NOT delete earthshine", () => {
  // Moon.update forces phaseFraction to the 1.0 sentinel when phase modelling
  // is off. Feeding that straight into (1 - phaseFraction) would zero
  // earthshine entirely — the opposite of "don't model phase". The resolver
  // has to fall back to the constant instead.
  const r = readMoonPhaseAppearance(
    { enableEarthshinePhase: true, enableSoftTerminator: true },
    false,
    1.0,
    1.495978707e11,
    createMoonPhaseAppearance(),
  );
  assert.equal(r.earthshinePhaseScale, 1.0);
});

test("solar angular radius tracks the true Sun→Moon distance", () => {
  // Earth's orbital eccentricity swings the distance ±1.7% over a year.
  const perihelion = computeSolarAngularRadius(1.471e11);
  const aphelion = computeSolarAngularRadius(1.521e11);
  assert.ok(perihelion > W && aphelion < W, "must vary about the mean");
  assert.ok(
    Math.abs(perihelion / aphelion - 1.0) > 0.03,
    "annual swing must be resolved, not flattened to a constant",
  );
  // Degenerate inputs fall back to the mean rather than producing NaN.
  assert.equal(computeSolarAngularRadius(undefined), W);
  assert.equal(computeSolarAngularRadius(0), W);
  assert.equal(computeSolarAngularRadius(NaN), W);
});

// ───────────────────────────────────────────────────────────────────────────
// Shader-text lockstep: one number, two shaders
// ───────────────────────────────────────────────────────────────────────────

test("earthshine literals are identical in both shaders and match the module", () => {
  const tint = `vec3<f32>(${EARTHSHINE_TINT_RED}, ${EARTHSHINE_TINT_GREEN}, ${EARTHSHINE_TINT_BLUE}) * ${EARTHSHINE_STRENGTH}`;
  assert.ok(
    wgslCode.includes(tint),
    `WGSL earthshine literals must match the module (${tint})`,
  );
  const glslTint = `vec3(${EARTHSHINE_TINT_RED}, ${EARTHSHINE_TINT_GREEN}, ${EARTHSHINE_TINT_BLUE}) * ${EARTHSHINE_STRENGTH}`;
  assert.ok(
    glslCode.includes(glslTint),
    `GLSL earthshine literals must match the module (${glslTint})`,
  );
});

test("WGSL: earthshine is scaled by the phase uniform, keyed on raw N·L", () => {
  assert.match(wgslCode, /earthshinePhaseScale\s*:\s*f32/);
  assert.match(wgslCode, /let rawNdotL = max\(dot\(N, L\), 0\.0\);/);
  assert.match(wgslCode, /\(1\.0 - rawNdotL\) \* u\.earthshinePhaseScale/);
  // C11-176b stays discharged: the phase must NOT re-enter as a whole-disc
  // multiplier, and `phaseFraction` must remain a UB declaration only.
  assert.equal((wgslCode.match(/phaseFraction/g) ?? []).length, 1);
  assert.match(wgslCode, /var color = lit;/);
});

test("GLSL: earthshine exists at all (the Principle-5 gap C12-21 closes)", () => {
  // Before this row `earthshine` appeared in NO GLSL file — a WebGPU-only
  // default-off celestial term. The pair is now real.
  assert.match(
    glslCode,
    /#ifdef EARTHSHINE\nuniform float u_earthshinePhaseScale;/,
  );
  assert.match(
    glslCode,
    /float rawNdotL = max\(dot\(material\.normal, earthshineLightDirEC\), 0\.0\);/,
  );
  assert.match(glslCode, /\(1\.0 - rawNdotL\) \* u_earthshinePhaseScale/);
  // Honours onlySunLighting exactly like every other lighting term here.
  assert.match(
    glslCode,
    /#ifdef ONLY_SUN_LIGHTING\n\s*vec3 earthshineLightDirEC = czm_sunDirectionEC;/,
  );
});

test("both shaders apply the soft terminator ONLY in the lunar BRDF path", () => {
  assert.match(wgslCode, /terminatorSoftness\s*:\s*f32/);
  assert.match(
    wgslCode,
    /let mu0 = softTerminatorMu0\(dot\(N, L\), mu0Hard, u\.terminatorSoftness\);/,
  );
  assert.match(
    glslCode,
    /mu0 = softTerminatorMu0\(dot\(material\.normal, lunarLightDirEC\), mu0, u_terminatorSoftness\);/,
  );
  // The disc law itself is untouched and still character-identical.
  assert.match(wgslCode, /2\.0 \* mu0 \/ \(mu0 \+ mu \+ 1\.0e-4\)/);
  assert.match(glslCode, /2\.0 \* mu0 \/ \(mu0 \+ mu \+ 1\.0e-4\)/);
  // The phong fallbacks must NOT have grown the term: czm_private_phong and
  // czm_phong are shared builtins, so softening there would be WebGPU-only.
  assert.ok(!wgslCode.includes("softTerminatorMu0(dot(m.normal"));
  const glslSoftUses = glslCode.match(/softTerminatorMu0\(/g) ?? [];
  assert.equal(
    glslSoftUses.length,
    2,
    "exactly one definition + one call site, both inside LUNAR_BRDF",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring: resolved ONCE on the CPU, published, packed, defined
// ───────────────────────────────────────────────────────────────────────────

test("Moon.update resolves both terms once and publishes them on frameState", () => {
  assert.match(sceneMoon, /readMoonPhaseAppearance\(/);
  assert.match(
    sceneMoon,
    /frameState\.moonEarthshinePhaseScale = phaseAppearance\.earthshinePhaseScale;/,
  );
  assert.match(
    sceneMoon,
    /frameState\.moonTerminatorSoftness = phaseAppearance\.terminatorSoftness;/,
  );
  // The resolution must happen BEFORE the feature-renderer branch, or the
  // WebGL fallback would never see it (Scene Logic Extractor pattern).
  const resolveAt = sceneMoon.indexOf("readMoonPhaseAppearance(");
  const branchAt = sceneMoon.indexOf(
    "context.getFeatureRenderer(FeatureRendererKey.MOON)",
  );
  assert.ok(resolveAt > 0 && branchAt > 0 && resolveAt < branchAt);
  assert.match(frameState, /this\.moonEarthshinePhaseScale = undefined;/);
  assert.match(frameState, /this\.moonTerminatorSoftness = undefined;/);
});

test("EllipsoidPrimitive gains both defines and both uniforms", () => {
  assert.match(primitive, /fs\.defines\.push\("EARTHSHINE"\);/);
  assert.match(primitive, /fs\.defines\.push\("SOFT_TERMINATOR"\);/);
  assert.match(primitive, /u_earthshinePhaseScale: function \(\) \{/);
  assert.match(primitive, /u_terminatorSoftness: function \(\) \{/);
  // Both default to `undefined`, i.e. no define, i.e. byte-identical for
  // every non-Moon EllipsoidPrimitive consumer.
  assert.match(primitive, /this\.earthshinePhaseScale = undefined;/);
  assert.match(primitive, /this\.terminatorSoftness = undefined;/);
  // A define transition must force the recompile.
  assert.match(primitive, /earthshineChanged \|\|/);
  assert.match(primitive, /softTerminatorChanged \|\|/);
});

test("WebGPU packs both at the reserved tail offsets, with identity fallbacks", () => {
  assert.match(
    envRenderer,
    /ud\[85\] = frameState\.moonEarthshinePhaseScale \?\? 1\.0;/,
  );
  assert.match(
    envRenderer,
    /ud\[86\] = frameState\.moonTerminatorSoftness \?\? 0\.0;/,
  );
  // ADD-ONLY at the tail: the 352-byte buffer and every existing offset are
  // unchanged, so no BGL/bind-group churn.
  assert.match(envRenderer, /const MOON_UNIFORM_BUFFER_SIZE = 352;/);
  assert.match(
    envRenderer,
    /ud\[84\] = frameState\.moonNormalMapStrength \?\? 0\.0;/,
  );
  // Debug surface exposes them so an Edge probe can read what reached the GPU.
  assert.match(envRenderer, /earthshinePhaseScale,\n\s*terminatorSoftness,/);
});

// C12-25/21/22 grew the moon UB 336 -> 352, but the two INLINE comments that
// the next add-only author actually reads — the one over the allocation and the
// one over the debug snapshot — were left describing the 336-byte / 84-float
// tail. Reading "84 floats" at the allocation site and appending at float 84
// silently overwrites C12-25's `normalStrength`: the buffer size and the bind
// group stay valid, nothing throws, and only a probe that asserts on relief
// notices. So the comments are pinned to numbers DERIVED from the code rather
// than to a second copy of the literals.
const lastPackedMoonFloat = (() => {
  const start = envRenderer.indexOf("function _packMoonUniforms(");
  assert.ok(start > 0, "the moon pack function must be locatable");
  const body = envRenderer.slice(start, envRenderer.indexOf("\n}\n", start));
  const indices = [...body.matchAll(/\bud\[(\d+)\]\s*=/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(indices.length > 0, "the pack body must write indexed floats");
  return Math.max(...indices);
})();

const moonUniformBufferSize = Number(
  envRenderer.match(/const MOON_UNIFORM_BUFFER_SIZE = (\d+);/)[1],
);

test("the moon UB's inline offset comments describe the SHIPPED tail", () => {
  // Ground truth, derived from the shipped code.
  assert.equal(lastPackedMoonFloat, 86);
  assert.equal(moonUniformBufferSize, 352);
  assert.ok(
    lastPackedMoonFloat < moonUniformBufferSize / 4,
    "the pack must stay inside the allocation",
  );

  // 1. The allocation comment. It must not still advertise a smaller tail than
  //    the code writes — that is the number a next author appends after.
  //    Located by walking back from the allocation itself to the blank line
  //    above its comment block, rather than by matching the comment's opening
  //    words: anchoring on prose means a reworded comment silently skips this
  //    check, and the whole point of the test is that the comment stays true.
  const allocationEnd = envRenderer.indexOf(
    "cache.uniformData = new Float32Array(MOON_UNIFORM_BUFFER_SIZE / 4)",
  );
  assert.ok(allocationEnd > 0, "the moon uniform allocation must be locatable");
  const allocationStart =
    envRenderer.slice(0, allocationEnd).lastIndexOf("\n\n") + 1;
  assert.ok(allocationStart > 0, "the allocation comment must be locatable");
  const allocation = envRenderer.slice(allocationStart, allocationEnd);
  assert.match(
    allocation,
    /MOON_UNIFORM_BUFFER_SIZE/,
    "the allocation comment must name the constant the buffer size lives on",
  );
  assert.match(
    allocation,
    /ud\[86\]/,
    "the allocation comment must name the last float the pack writes",
  );
  const advertisedBytes = [...allocation.matchAll(/(\d+) bytes/g)].map(
    (match) => Number(match[1]),
  );
  const advertisedFloats = [...allocation.matchAll(/(\d+) floats/g)].map(
    (match) => Number(match[1]),
  );
  for (const bytes of advertisedBytes) {
    assert.equal(
      bytes,
      moonUniformBufferSize,
      `the allocation comment advertises ${bytes} bytes; the buffer is ${moonUniformBufferSize}`,
    );
  }
  for (const floats of advertisedFloats) {
    assert.equal(
      floats,
      moonUniformBufferSize / 4,
      `the allocation comment advertises ${floats} floats; the buffer holds ${moonUniformBufferSize / 4}`,
    );
  }

  // 2. The debug-snapshot comment. It names the moon tail's float range and the
  //    reads directly beneath it must all fall inside that range.
  const snapshotRange = envRenderer.match(
    /mirror `_packMoonUniforms\(\)` \(offsets (\d+)\.\.(\d+) are the moon tail/,
  );
  assert.ok(snapshotRange, "the snapshot comment must name a float range");
  assert.equal(
    Number(snapshotRange[2]),
    lastPackedMoonFloat,
    "the snapshot comment's tail end must be the last float the pack writes",
  );
  const snapshotStart = envRenderer.indexOf(snapshotRange[0]);
  const snapshotBody = envRenderer.slice(
    snapshotStart,
    envRenderer.indexOf(
      "const lifecycle = cache._moonTextureLifecycle;",
      snapshotStart,
    ),
  );
  const snapshotReads = [...snapshotBody.matchAll(/\bud\[(\d+)\]/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(snapshotReads.length > 0, "the snapshot must read indexed floats");
  assert.ok(
    Math.max(...snapshotReads) <= Number(snapshotRange[2]) &&
      Math.min(...snapshotReads) >= Number(snapshotRange[1]),
    `snapshot reads ${Math.min(...snapshotReads)}..${Math.max(...snapshotReads)} ` +
      `escape the documented ${snapshotRange[1]}..${snapshotRange[2]}`,
  );
});

test("WGSL UB members are appended at the tail, existing offsets frozen", () => {
  const normalAt = wgslCode.indexOf("normalStrength: f32");
  const shineAt = wgslCode.indexOf("earthshinePhaseScale: f32");
  const softAt = wgslCode.indexOf("terminatorSoftness: f32");
  assert.ok(normalAt > 0 && shineAt > normalAt && softAt > shineAt);
  // Every pre-existing member keeps its documented byte offset.
  assert.match(
    wgsl,
    /moonDirWC: vec3<f32>, phaseFraction: f32,\s+\/\/ 256\.\.271/,
  );
  assert.match(wgsl, /normalStrength: f32,\s+\/\/ 336/);
  assert.match(wgsl, /earthshinePhaseScale: f32,\s+\/\/ 340/);
  assert.match(wgsl, /terminatorSoftness: f32,\s+\/\/ 344/);
});

test("both toggles are registered in AtmosphericConditions, default ON", () => {
  assert.match(conditions, /enableEarthshinePhase: true,/);
  assert.match(conditions, /enableSoftTerminator: true,/);
  // The public `lighting` JSDoc registry must name them.
  const jsdocAt = conditions.indexOf("Lighting flags.");
  const getterAt = conditions.indexOf("get lighting()");
  const registry = conditions.slice(jsdocAt, getterAt);
  assert.ok(registry.includes("enableEarthshinePhase"));
  assert.ok(registry.includes("enableSoftTerminator"));
  // Maintainer ruling 2026-08-06 (R5): the master toggle now defaults ON.
  // Both original reasons for the FALSE default (WebGPU-only, phase-
  // backwards) were removed by C12-21's batch, so the phase-correct term is
  // live on both backends at defaults and C12-21 is no longer inert.
  assert.match(conditions, /enableEarthshine: true,/);
});

// ───────────────────────────────────────────────────────────────────────────
// Numeric predictions the Edge acceptance run must reproduce
// ───────────────────────────────────────────────────────────────────────────

test("PREDICTIONS: the numbers the Edge run is measured against", () => {
  // Solar angular radius from the Moon at 1 AU.
  assert.ok(Math.abs(W - 0.004650484023614976) < 1e-15);
  // Peak μ0 excess, at exactly the geometric terminator.
  assert.ok(Math.abs(W / 4 - 0.001162621005903744) < 1e-15);
  assert.equal(refMu0(0.0, W), W / 4);

  // Screen width of the softened band at a face-on terminator: the surface
  // point at angle θ past the sub-observer point has N·L = sin θ and screen
  // x = R·sin θ, so |N·L| < w ⇔ |x| < R·w, i.e. a band of 2·R·w pixels.
  const bandPx = (radiusPx) => 2 * radiusPx * W;
  assert.ok(Math.abs(bandPx(95) - 0.8835919644868455) < 1e-9); // ~190 px zoomed disc
  assert.ok(Math.abs(bandPx(8) - 0.07440774437783962) < 1e-9); // ~16 px default disc

  // Radiance change at the terminator pixel, through Lommel-Seeliger with a
  // representative μ ≈ 0.5: ΔLS = 2·(w/4)/((w/4) + μ + 1e-4) − 0.
  const mu = 0.5;
  const mu0 = refMu0(0.0, W);
  const deltaLS = (2 * mu0) / (mu0 + mu + 1e-4);
  assert.ok(Math.abs(deltaLS - 0.004639) < 1e-6);
  // Times a mid-grey lunar albedo (~0.35) that is ~1.6e-3 in linear light.
  assert.ok(Math.abs(deltaLS * 0.35 - 0.001624) < 1e-6);

  // C12-21 at the three canonical phases, with earthshine enabled. The blue
  // channel is the largest: 0.7 × 0.08 = 0.056 linear on the fully unlit limb.
  const unlitBlue = EARTHSHINE_TINT_BLUE * EARTHSHINE_STRENGTH;
  assert.ok(Math.abs(unlitBlue - 0.056) < 1e-12);
  assert.equal(unlitBlue * computeEarthshinePhaseScale(0.0), unlitBlue); // new
  assert.equal(unlitBlue * computeEarthshinePhaseScale(1.0), 0.0); // full
  assert.ok(
    Math.abs(unlitBlue * computeEarthshinePhaseScale(0.5) - 0.028) < 1e-15,
  ); // quarter
});

test("Moon.wgsl still passes naga validation", async () => {
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
  assert.doesNotThrow(() => naga.validate_wgsl(wgsl));
});
