// solar-disc-model.spec.mjs — C12-15 / C12-16 / C12-17 (the C12 sun wave).
//
// Pins, in pure Node with no browser:
//   - the ONE constants source (C12-15's landing requirement): the eclipse
//     photometry and BOTH sun-disc bakes must read `Scene/SolarDiscModel.js`,
//     and neither bake may carry a numeric copy;
//   - the limb-darkening law's endpoints and monotonicity;
//   - the C12-16 glare profile's endpoints, monotonicity, inverse-square
//     tail, and exact zero at the billboard's inscribed circle (a non-zero
//     pedestal there would paint a hard circular edge);
//   - the exact identity of the two disabled toggle positions — the
//     `(1, 0, 0)` limb triple and the legacy glare branch — because a
//     default-ON celestial multiplier that cannot be turned off byte-exactly
//     is the C11-176/C12 exit-gate failure class;
//   - the WebGL/WebGPU bake lockstep (both must consume the resolved
//     `frameState.sunDiscAppearance`, not their own literals);
//   - **the arithmetic that REFUTES C12-16 and C12-17 as causes of
//     `probe-eclipse-sun-fade`'s `glowOffRaw == 0` on WebGPU.** Both banked
//     co-suspects were named on the C12-16/C12-17 rows at Batch 760. This
//     spec fails if anyone re-asserts them without new evidence: over the
//     probe's 1.5x..6x solar-radius annulus BOTH glare profiles put alpha
//     between 0.16 and 0.69 (8-bit codes 41..176), and 8-bit quantisation
//     only truncates the halo beyond 8.19 solar radii — outside the annulus
//     entirely. A reshaped falloff and a wider/deeper bake cannot turn a
//     measured zero into a non-zero.
//
// Run: node --test Tools/visual-regression/solar-disc-model.spec.mjs

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

// Default `glowFactor = 1` geometry, shared with both bakes:
//   glowLengthTS = 5, quad half-extent = 1 + 2*glowLengthTS = 11 solar radii.
const GLOW_LENGTH_TS = 5.0;
const HALF_EXTENT_RSUN = 1.0 + 2.0 * GLOW_LENGTH_TS;
// bake `radius` for a distance of `rho` solar radii from the solar centre.
const radiusAt = (rho) => rho / (Math.SQRT2 * HALF_EXTENT_RSUN);

test("limb-darkening law: endpoints, monotonicity, clamping", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  assert.equal(
    M.SOLAR_LIMB_DARKENING_A0 +
      M.SOLAR_LIMB_DARKENING_A1 +
      M.SOLAR_LIMB_DARKENING_A2,
    1.0,
    "I(mu=1) must be exactly 1 at disc centre",
  );
  assert.equal(M.solarLimbIntensity(0.0), 1.0, "centre == 1");
  assert.equal(
    M.solarLimbIntensity(1.0),
    M.SOLAR_LIMB_DARKENING_A0,
    "limb == a0 (0.30, ~30% of centre)",
  );
  // Strictly decreasing outward.
  let prev = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const v = M.solarLimbIntensity(i / 1000);
    assert.ok(v < prev, `limb intensity must decrease outward (i=${i})`);
    prev = v;
  }
  // Clamps rather than extrapolating (the bakes pass min(r/radiusTS, 1)).
  assert.equal(M.solarLimbIntensity(-1.0), M.solarLimbIntensity(0.0));
  assert.equal(M.solarLimbIntensity(4.0), M.solarLimbIntensity(1.0));
});

test("C12-15: ONE constants source — photometry re-exports, shaders hold no copy", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const O = await importEngine("Scene/computeSolarObscuration.js");
  assert.equal(O.LIMB_DARKENING_A0, M.SOLAR_LIMB_DARKENING_A0);
  assert.equal(O.LIMB_DARKENING_A1, M.SOLAR_LIMB_DARKENING_A1);
  assert.equal(O.LIMB_DARKENING_A2, M.SOLAR_LIMB_DARKENING_A2);
  // The photometry module must IMPORT them, not redeclare them.
  const obscSrc = readEngine("Scene/computeSolarObscuration.js");
  assert.match(obscSrc, /from "\.\/SolarDiscModel\.js"/);
  assert.doesNotMatch(
    obscSrc,
    /LIMB_DARKENING_A1\s*=\s*0\.93/,
    "computeSolarObscuration must not redeclare the triple",
  );

  // The WebGL bake must receive the numbers as uniforms — no literals.
  // Comments are stripped first: the prose deliberately quotes the old
  // expression, and a doc mention is not a second constants source.
  const glsl = readEngine("Shaders/SunTextureFS.glsl");
  const glslCode = glsl.replace(/\/\/[^\n]*/g, "");
  assert.match(glsl, /uniform vec3 u_limbDarkening;/);
  assert.match(glsl, /uniform vec4 u_glareProfile;/);
  for (const literal of ["0.93", "0.23", "0.275", "0.55"]) {
    assert.ok(
      !glslCode.includes(literal),
      `SunTextureFS.glsl must not hardcode ${literal}`,
    );
  }
  // Both smoothstep edges now come from u_glareProfile.z.
  const smoothstepEdges = glslCode.match(/smoothstep\(0\.0,\s*([^,]+),/g) ?? [];
  assert.equal(smoothstepEdges.length, 2, "halo + burst smoothsteps");
  for (const s of smoothstepEdges) {
    assert.match(s, /u_glareProfile\.z/);
  }

  // The WebGPU CPU bake must consume the RESOLVED appearance, not literals.
  const wgpu = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(wgpu, /appearance\.a0/);
  assert.match(wgpu, /appearance\.glareCore/);
  assert.match(wgpu, /frameState\.sunDiscAppearance/);

  // And Sun.js must publish it BEFORE the feature-renderer branch, so the
  // two backends cannot resolve it differently.
  const sun = readEngine("Scene/Sun.js");
  const publishIdx = sun.indexOf("frameState.sunDiscAppearance = appearance");
  const branchIdx = sun.indexOf("getFeatureRenderer(FeatureRendererKey.SUN)");
  assert.ok(publishIdx > 0, "Sun.update must publish sunDiscAppearance");
  assert.ok(
    publishIdx < branchIdx,
    "publication must precede the backend branch",
  );
});

test("C12-16 glare profile: endpoints, monotonicity, inverse-square tail", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  assert.equal(M.solarGlareProfile(0.0), 1.0, "peak == 1 at centre");
  assert.equal(
    M.solarGlareProfile(M.SOLAR_GLARE_SUPPORT),
    0.0,
    "must reach EXACTLY zero at the inscribed circle — a residual pedestal " +
      "there draws a hard circular edge inside the billboard",
  );
  assert.equal(M.SOLAR_GLARE_SUPPORT, Math.SQRT1_2);
  assert.equal(M.solarGlareProfile(1.0), 0.0, "clamped beyond the support");

  let prev = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const v = M.solarGlareProfile((M.SOLAR_GLARE_SUPPORT * i) / 2000);
    assert.ok(v <= prev, `glare must be non-increasing outward (i=${i})`);
    prev = v;
  }

  // The unclipped kernel is a Lorentzian: raw(2r)/raw(r) -> 1/4 (inverse
  // square in angle). Measured at 4x and 8x the core radius.
  // (measured: 5/17 = 0.2941 at 2->4 core radii, 17/65 = 0.2615 at 4->8,
  // 65/257 = 0.2529 at 8->16 — converging to 1/4 from above, as a
  // Lorentzian must.)
  const raw = (r) => 1.0 / (1.0 + (r / M.SOLAR_GLARE_CORE) ** 2);
  const octave = (n) => raw(2 * n * M.SOLAR_GLARE_CORE) / raw(n * M.SOLAR_GLARE_CORE);
  const r2 = octave(2);
  const r4 = octave(4);
  const r8 = octave(8);
  assert.ok(r2 > 0.25 && r2 < 0.30, `octave ratio 2->4 core radii: ${r2}`);
  assert.ok(r4 > 0.25 && r4 < 0.27, `octave ratio 4->8 core radii: ${r4}`);
  assert.ok(r8 > 0.25 && r8 < 0.256, `octave ratio 8->16 core radii: ${r8}`);
  assert.ok(r8 < r4 && r4 < r2, "must approach the inverse square from above");

  // Legacy curve is exactly `1 - smoothstep(0, 0.55, r)`.
  assert.equal(M.solarGlareProfileLegacy(0.0), 1.0);
  assert.equal(M.solarGlareProfileLegacy(M.SOLAR_GLARE_LEGACY_EDGE), 0.0);
  assert.equal(M.solarGlareProfileLegacy(0.9), 0.0);
  assert.ok(
    Math.abs(M.solarGlareProfileLegacy(0.275) - 0.5) < 1e-12,
    "0.275 is the legacy half-amplitude point the new core is anchored to",
  );
  assert.equal(M.SOLAR_GLARE_CORE, 0.275);

  // Support: the legacy curve dies at 8.556 R_sun, the new one at 11.0.
  const supportRsun = M.solarBakeRadiusToSolarRadii(
    M.SOLAR_GLARE_SUPPORT,
    GLOW_LENGTH_TS,
  );
  assert.ok(
    Math.abs(supportRsun - 11.0) < 1e-9,
    `new support == quad half-extent (${supportRsun})`,
  );
  const legacyRsun = M.solarBakeRadiusToSolarRadii(
    M.SOLAR_GLARE_LEGACY_EDGE,
    GLOW_LENGTH_TS,
  );
  assert.ok(
    Math.abs(legacyRsun - 8.556) < 0.01,
    `legacy support (${legacyRsun})`,
  );
});

test("C12-16/C12-17 are REFUTED as causes of the measured glowOffRaw == 0", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  // `probe-eclipse-sun-fade` integrates the sun's contribution over a
  // 1.5x..6x solar-radius annulus and measured EXACTLY 0 on WebGPU across
  // all 15 partial-band steps. The bake's alpha there is 0.75 * profile.
  for (const rho of [1.5, 3.0, 4.5, 6.0]) {
    const r = radiusAt(rho);
    for (const [name, fn] of [
      ["legacy", M.solarGlareProfileLegacy],
      ["c12-16", M.solarGlareProfile],
    ]) {
      const alpha = 0.75 * fn(r);
      assert.ok(
        alpha > 0.15 && alpha < 0.70,
        `${name} alpha at ${rho} R_sun is ${alpha} — the annulus is never faint`,
      );
      assert.ok(
        alpha * 255 > 38,
        `${name} alpha at ${rho} R_sun quantises to ${Math.floor(alpha * 255)}/255`,
      );
    }
  }
  // 8-bit quantisation (C12-17's suspect) only bites OUTSIDE the annulus:
  // the legacy alpha crosses 1/255 at 8.19 R_sun, so the 8-bit bake loses
  // 8.19..8.556 R_sun — 4.2% of the radius and 0% of the measured region.
  const crossing = (fn) => {
    let lo = 0.0;
    let hi = 20.0;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (0.75 * fn(radiusAt(mid)) >= 1 / 255) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  const legacyCrossing = crossing(M.solarGlareProfileLegacy);
  assert.ok(
    legacyCrossing > 8.0 && legacyCrossing < 8.3,
    `legacy 8-bit floor crossing at ${legacyCrossing} R_sun (expected ~8.19)`,
  );
  assert.ok(
    legacyCrossing > 6.0,
    "the 8-bit floor is outside the 1.5x..6x annulus, so quantisation " +
      "cannot explain a zero measured inside it",
  );
  // C12-16 pushes the 8-bit-visible tail out to ~10.8 R_sun.
  const newCrossing = crossing(M.solarGlareProfile);
  assert.ok(
    newCrossing > 10.0,
    `C12-16 8-bit floor crossing at ${newCrossing} R_sun`,
  );
});

test("toggle identity: both OFF reproduces the pre-C12 bake exactly", async () => {
  const A = await importEngine("Scene/SunDiscAppearance.js");
  const M = await importEngine("Scene/SolarDiscModel.js");
  const state = A.createSunDiscAppearance();

  // No atmosphericConditions (no globe) -> both default ON.
  A.readSunDiscAppearance({}, state);
  assert.equal(state.limbDarkening, true);
  assert.equal(state.glareFalloff, true);
  assert.equal(state.a0, M.SOLAR_LIMB_DARKENING_A0);
  assert.equal(state.glareLegacy, 0.0);
  assert.equal(state.key, 3);

  // Explicit OFF -> exact identities.
  A.readSunDiscAppearance(
    {
      atmosphericConditions: {
        lighting: {
          enableSolarLimbDarkening: false,
          enableSolarGlareFalloff: false,
        },
      },
    },
    state,
  );
  assert.equal(state.a0, 1.0, "flat disc: I(mu) == 1 identically");
  assert.equal(state.a1, 0.0);
  assert.equal(state.a2, 0.0);
  assert.equal(state.glareLegacy, 1.0, "legacy glare branch selected");
  assert.equal(state.key, 0);
  // I(mu) with (1,0,0) is exactly 1 for every mu, i.e. the historical
  // `step(radius, u_radiusTS)` disc, not an approximation of it.
  for (const mu of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    assert.equal(state.a0 + state.a1 * mu + state.a2 * mu * mu, 1.0);
  }

  // Independently togglable, and the key is the rebuild signature.
  const keys = new Set();
  for (const ld of [true, false]) {
    for (const gf of [true, false]) {
      A.readSunDiscAppearance(
        {
          atmosphericConditions: {
            lighting: {
              enableSolarLimbDarkening: ld,
              enableSolarGlareFalloff: gf,
            },
          },
        },
        state,
      );
      keys.add(state.key);
    }
  }
  assert.equal(keys.size, 4, "all four toggle combinations must be distinct");

  // The toggles must exist on the shipped lighting leaf, default ON.
  const ac = readEngine("Scene/AtmosphericConditions.js");
  assert.match(ac, /enableSolarLimbDarkening: true/);
  assert.match(ac, /enableSolarGlareFalloff: true/);
});

test("C12-17: WebGPU bake size/format parity with WebGL", () => {
  const wgpu = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  const sun = readEngine("Scene/Sun.js");
  // WebGL's rule, still present.
  assert.match(sun, /Math\.ceil\(Math\.log\(size\) \/ Math\.log\(2\.0\)\) - 2\.0/);
  // WebGPU now derives from the drawing buffer instead of a hardcoded 256.
  assert.match(wgpu, /function sunTextureSize\(/);
  assert.match(wgpu, /context\.drawingBufferWidth/);
  assert.ok(
    !/createSunTexture\(device, 256,/.test(wgpu),
    "the hardcoded 256 bake must be gone",
  );
  // HDR format selection mirrors WebGL's HALF_FLOAT choice.
  assert.match(wgpu, /frameState\.useHDR === true \? "rgba16float"/);
  assert.match(wgpu, /function floatToHalfBits\(/);
  // Rebuild set must cover size, format and the C12-15/16 toggle key.
  assert.match(wgpu, /cache\.lastBakeSize !== bakeSize/);
  assert.match(wgpu, /cache\.lastBakeFormat !== bakeFormat/);
  assert.match(wgpu, /cache\.lastAppearanceKey !== appearanceKey/);
});

// ── probe-sun-glow-profile geometry satisfiability ──────────────────────────
//
// The first revision of that probe shipped a constant set that was
// arithmetically unsatisfiable — viewport 1280x720 + fov 12 deg + maxRsun
// 12.0 gives limbPx 27.94, maxHalf floor(0.45*720) = 324, and the in-page
// guard `half < maxRsun*limbPx` reduces to `324 < 335.28`, so the probe
// exited 2 at step 0 on every run, forever, before reaching any
// fix-dependent code. It NEVER PRODUCED A MEASUREMENT. These tests extract
// the shipped constants and the shipped feasibility function VERBATIM from
// the probe and prove the set is satisfiable, so that class cannot ship
// again without `node --test` going red.
function loadProbeGeometry() {
  const src = fs
    .readFileSync(path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const slice = (name) => {
    const a = src.indexOf(`// ==BEGIN ${name}==`);
    const b = src.indexOf(`// ==END ${name}==`);
    assert.ok(a > 0 && b > a, `probe block ${name} must be marker-delimited`);
    return src.slice(a, b);
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    `${slice("PROBE_CONSTANTS")}\n${slice("roiFeasibility")}\n` +
      `return { PROBE_CONSTANTS, roiFeasibility };`,
  )();
}

test("probe geometry: the shipped constant set is satisfiable at every Earth-Sun distance", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  for (const [name, d] of [
    ["perihelion", k.sunDistanceMinM],
    ["aphelion", k.sunDistanceMaxM],
    ["mean", 0.5 * (k.sunDistanceMinM + k.sunDistanceMaxM)],
  ]) {
    const f = roiFeasibility(k, d);
    assert.ok(
      f.feasible,
      `${name}: ${f.reasons.join("; ")} (limbPx ${f.limbPx.toFixed(2)}, half ${f.half}, maxHalf ${f.maxHalf}, roiRsun ${f.roiRsun.toFixed(2)})`,
    );
    // The ROI must reach past the support gate's UPPER bound, or part of the
    // acceptance band is unmeasurable at this viewport (the second half of
    // the round-1 blocker: even relaxed, the old set reached only 11.60).
    assert.ok(
      f.roiRsun >= k.supportGateHiRsun,
      `${name}: ROI reaches ${f.roiRsun.toFixed(2)} R_sun, gate needs ${k.supportGateHiRsun}`,
    );
    assert.ok(f.limbPx >= k.minLimbPx, `${name}: limbPx ${f.limbPx}`);
  }
});

test("probe geometry: the feasibility function actually rejects the round-1 set", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  // The exact set that shipped and never measured anything. If this stops
  // being rejected, the guard has been weakened into a no-op.
  const broken = { ...k, fovDeg: 12.0 };
  const f = roiFeasibility(broken, 1.5157e11);
  assert.ok(!f.feasible, "fov 12 deg at 1280x720 must be rejected");
  assert.ok(
    Math.abs(f.limbPx - 27.94) < 0.15,
    `the executor measured limbPx 27.94 there; model says ${f.limbPx.toFixed(2)}`,
  );
  assert.equal(f.maxHalf, 324);
  assert.ok(
    f.reasons.some((r) => r.includes("maxRsun*limbPx")),
    `the ROI-clamp reason must be named: ${JSON.stringify(f.reasons)}`,
  );
  // …and the "relaxed" variant still fails the support-gate reachability arm.
  assert.ok(
    f.roiRsun < k.supportGateHiRsun,
    `relaxed ROI reaches ${f.roiRsun.toFixed(2)}, still under the gate bound`,
  );

  // A too-narrow fov must fail too — narrowing GROWS limbPx, which is the
  // wrong direction, and is the intuitive-but-wrong fix.
  assert.ok(!roiFeasibility({ ...k, fovDeg: 9.0 }, 1.5157e11).feasible);
  // And the shipped fov must clear it with real margin, not by a hair.
  const ok = roiFeasibility(k, 1.5157e11);
  assert.ok(
    ok.maxHalf / (k.maxRsun * ok.limbPx) > 1.3,
    `shipped set must clear the ROI clamp with >30% margin (${(ok.maxHalf / (k.maxRsun * ok.limbPx)).toFixed(2)}x)`,
  );
});

test("probe geometry: the in-page arithmetic matches the pure feasibility model", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  const probe = fs
    .readFileSync(path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  // The in-page guard and the pure model must use the same expressions, or
  // the pre-launch check can pass while the run still rejects.
  assert.match(
    probe,
    /Math\.ceil\(\(k\.maxRsun \+ k\.roiMarginRsun\) \* limbPx\)/,
    "in-page `half` must use the same expression as roiFeasibility",
  );
  assert.match(
    probe,
    /half < k\.maxRsun \* limbPx/,
    "in-page ROI guard must be the one the model mirrors",
  );
  assert.match(
    probe,
    /Math\.floor\(0\.45 \* Math\.min\(canvas\.width, canvas\.height\)\)/,
    "in-page maxHalf must be the one the model mirrors",
  );
  // The pre-launch feasibility check must exist and be fatal.
  assert.match(probe, /if \(!feas\.perihelion\.feasible \|\| !feas\.aphelion\.feasible\)/);
  assert.match(probe, /ROI geometry is unsatisfiable/);
  // The viewport must come FROM the constants, not a second literal.
  assert.match(probe, /width: plan\.k\.viewportWidth/);
  assert.match(probe, /height: plan\.k\.viewportHeight/);
  assert.match(probe, /C\.Math\.toRadians\(k\.fovDeg\)/);
  // Sanity: the model agrees with the shipped constants' own viewport.
  assert.equal(k.viewportWidth, 1280);
  assert.equal(k.viewportHeight, 720);
  assert.ok(roiFeasibility(k, 1.5157e11).feasible);
});

test("probe classifier: absence is settled at STATE level, saturation before occlusion", () => {
  const probe = fs
    .readFileSync(path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const body = probe.slice(probe.indexOf("function classify("));
  const iAbsentBuilt = body.indexOf("commandBuiltSteps === 0");
  const iAbsentCull = body.indexOf("cullFiredSteps === steps.length");
  const iSat = body.indexOf("saturationSource !== null");
  const iOccl = body.indexOf('hypothesis = "H-OCCL');
  assert.ok(iAbsentBuilt > 0 && iAbsentCull > 0, "state-level absence arms must exist");
  assert.ok(iSat > 0, "the saturation arm must exist");
  assert.ok(iOccl > 0, "the occlusion arm must exist");
  // M2: absence is decided before any pixel-difference branch.
  assert.ok(iAbsentBuilt < iSat && iAbsentCull < iSat, "absence must precede pixels");
  // M1: saturation is decided before occlusion.
  assert.ok(
    iSat < iOccl,
    "H-SAT must be evaluated BEFORE H-OCCL — when the saturator is the globe " +
      "the two signatures are identical",
  );
  // The state read must happen right after the sun-SHOWN render.
  const iShownRender = probe.indexOf("// ── L0: globe ON, sky ON, sun ON");
  const iStateRead = probe.indexOf("// STATE read, SAME TASK");
  const iHiddenRender = probe.indexOf("// ── L0: sun OFF");
  assert.ok(
    iShownRender < iStateRead && iStateRead < iHiddenRender,
    "the env-state read must sit between the sun-shown render and the sun-hidden one",
  );
  // The triple confound of the globe lane must be documented in place.
  assert.match(probe, /removes THREE things at once/);
  assert.match(probe, /SceneUtilities\.getOccluder/);
  // The eliminated hypothesis must be recorded as eliminated, not tested.
  assert.match(probe, /ELIMINATED BY DRAW ORDER/);
  assert.ok(
    !/hypothesis = "H-SKY/.test(probe),
    "the opaque-shell OCCLUSION hypothesis must not be in the classifier",
  );
  // The sky lane must be marked diagnostic-only (extinction confound).
  assert.match(probe, /sunDeltaNoSky_DIAGNOSTIC/);
  assert.match(probe, /skyLaneExtinctionConfound/);
});

test("probe: scene.sun.show is pinned against the WebGL bloom lever, and the residual is sign-discriminated", () => {
  const probe = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");

  // The lever lesson must be stated where a probe author will hit it.
  assert.match(probe, /IS NOT A SINGLE-VARIABLE LEVER ON WEBGL/);
  // Every measuring lane pins bloom, and the pin is GATED so it cannot drift
  // back to Scene's default `true`.
  assert.match(probe, /scene\.sunBloom = false;/);
  assert.match(probe, /gates\.bloom_pinned = \{/);
  assert.match(probe, /baselineSunBloom === false/);
  // The capability is recorded per backend rather than assumed.
  assert.match(probe, /supportsLegacySunBloom/);

  // The A/B lane exists, runs bloom ON, and restores the pin afterwards.
  const lane = probe.slice(
    probe.indexOf("// ── L3: bloom ON"),
    probe.indexOf("// ── Accumulate the radial profile"),
  );
  assert.ok(lane.length > 0, "the L3 bloom lane must exist");
  assert.match(lane, /scene\.sunBloom = true;/);
  assert.match(lane, /scene\.sunBloom = false;/);
  assert.match(lane, /vantage\.bloomLane === true/);

  // SIGN is the discriminator: bloom ADDS light (positive), a black
  // billboard under ALPHA_BLEND SUBTRACTS a*dst (negative). Both the signed
  // accumulator and the mechanism call must be present, and the mechanism
  // call must key on the sign, not only on the toggle.
  assert.match(probe, /const s0 = l0On\[p\] - l0Off\[p\];/);
  assert.match(probe, /sunDeltaSigned/);
  assert.match(probe, /function bloomMechanism\(/);
  assert.match(probe, /offSigned < -0\.5 \* off/);
  assert.match(probe, /offSigned > 0\.5 \* off/);
  assert.match(probe, /bloom-REFUTED/);
  assert.match(probe, /bloom-CONFIRMED/);

  // The extinguished-step selector must require BOTH a built command and a
  // ~zero extinction, or "nothing drawn" would be scored as "black".
  assert.match(probe, /s\.hasSunCommand === true &&/);
  assert.match(probe, /s\.extinctionL0\.every\(\(c\) => c !== null && c < 5e-4\)/);

  // The prediction must be on the record BEFORE the run, in both directions.
  assert.match(probe, /PREDICTION, STATED BEFORE THE RUN/);
  assert.match(probe, /if instead the residual COLLAPSES/);
});

test("probe provenance: a missing source degrades, never throws", () => {
  const probe = fs
    .readFileSync(path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  const fn = probe.slice(
    probe.indexOf("function provenance()"),
    probe.indexOf("// ── Radial-profile sweep"),
  );
  assert.match(fn, /missingSources/, "missing sources must be tracked");
  assert.match(
    fn,
    /try \{\s*bytes = fs\.readFileSync\(p\);/,
    "the per-source read must be guarded so a PRE tree can still run",
  );
  assert.match(
    fn,
    /SOURCE FILE ABSENT/,
    "a missing verbatim-slice source must degrade rather than throw",
  );
  assert.match(fn, /missingSources\.length === 0/, "…and must fail the gate");
});

test("C12-17: half-float packing round-trips the bake's value range", async () => {
  // Re-implement the decode side only; the encoder under test is the one
  // shipped in WebGPUEnvironmentRenderer.js, extracted by source so the
  // spec cannot drift from it.
  const src = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js").replace(
    /\r\n/g,
    "\n",
  );
  const start = src.indexOf("function floatToHalfBits(");
  assert.ok(start > 0, "floatToHalfBits must exist in the WebGPU bake");
  const close = src.indexOf("\n}", start);
  assert.ok(close > start, "could not delimit floatToHalfBits");
  const body = src.slice(start, close + 2);
  const scratchDecl =
    "const _f32Scratch = new Float32Array(1);\n" +
    "const _u32Scratch = new Uint32Array(_f32Scratch.buffer);\n";
  // eslint-disable-next-line no-new-func
  const encode = new Function(
    `${scratchDecl}${body}\nreturn floatToHalfBits;`,
  )();

  const decode = (bits) => {
    const sign = bits & 0x8000 ? -1 : 1;
    const exp = (bits >> 10) & 0x1f;
    const mant = bits & 0x3ff;
    if (exp === 0) {
      return sign * mant * Math.pow(2, -24);
    }
    if (exp === 31) {
      return mant ? NaN : sign * Infinity;
    }
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
  };

  assert.equal(decode(encode(0.0)), 0.0);
  assert.equal(decode(encode(1.0)), 1.0);
  assert.equal(decode(encode(0.5)), 0.5);
  assert.equal(decode(encode(0.25)), 0.25);
  // Relative accuracy over the bake's range must beat 8-bit by orders of
  // magnitude — that is the whole point of C12-17's format half.
  let worstRel = 0;
  for (let i = 1; i <= 4096; i++) {
    const v = i / 4096;
    const back = decode(encode(v));
    worstRel = Math.max(worstRel, Math.abs(back - v) / v);
  }
  assert.ok(worstRel < 1e-3, `worst relative error ${worstRel}`);
  // And the deep tail rgba8unorm cannot hold at all.
  const tiny = 1 / 65536;
  assert.ok(
    Math.abs(decode(encode(tiny)) - tiny) / tiny < 1e-3,
    "half-float represents alpha 256x below the 8-bit floor",
  );
  assert.equal(Math.floor(tiny * 255), 0, "…which rgba8unorm truncates to 0");
});
