// eclipse-cloud-ibl-response.spec.mjs — C13-41 (the C12-29 S3 rider): pins the
// eclipse response of the cloud + environment-map subsystem.
//
// Pure Node (`node --test`). No browser, no build.
//
// WHAT THIS EXISTS TO CATCH.
//
//   - the exact-identity position is lost. Every one of the seven sites is a
//     multiply by a scalar that is EXACTLY 1.0 outside an enabled solar
//     eclipse, so every non-eclipse frame must stay byte-identical. A curve, a
//     lerp, a clamp with a non-unit ceiling, or an `?? 0.0` default breaks it;
//
//   - the cloud SHADOW strength starts using S2's `eclipseSceneLightFactor`.
//     This is the substitution the row's obvious implementation reaches for and
//     it is arithmetically wrong, not merely a matter of taste: shadowed ground
//     becomes `F * (1 - 0.65F)`, which this spec measures RISING from its
//     un-eclipsed 0.350 to a peak 0.384 at F = 0.769 — a shadowed patch would
//     get ~10% brighter through the whole early partial phase. The refutation
//     group below reconstructs that design and demands the check fail on it;
//
//   - the environment bake is dimmed WITHOUT the quantized eclipse refresh
//     input, or the input is added without the dimming. Either half alone is a
//     defect: dim-only latches the environment dark for up to an hour after
//     third contact (the WebGL gate's `maximumSecondsDifference` is 3600 s and
//     `sunMoved` needs ~0.3 deg of arc that totality never supplies), and
//     trigger-only spends a full cube fill + prefilter + SH projection to
//     reproduce the bytes it already had. Both backends are checked for BOTH
//     halves;
//
//   - the refresh gate becomes ONE-WAY ("only re-fill when it got darker").
//     That is the stale-dark latch this row exists to prevent, and it is the
//     mutant the recovery group builds;
//
//   - the eclipse refresh term gets gated on the cloud march the way
//     `cloudRevisionChanged` is. `cloudsInReflections` is OFF by default, so
//     that would silently disable the whole leg for the default scene;
//
//   - the refresh bucket gets committed outside the granted branch, which would
//     make a budget-deferred refresh lossy (C11-193);
//
//   - the SH projection's step-3 intensity multiply also acquires the factor on
//     either backend, double-dimming the irradiance the cube already carries;
//
//   - the two backends drift: one dims, the other does not, or they dim
//     different scalars or quantize on different grids. This is the C12
//     exit-gate class for a default-ON celestial multiplier;
//
//   - a WGSL file acquires eclipse ALU. C13-39 proved runtime-gated shader code
//     still costs static registers, so this row is deliberately 100% CPU-side
//     uniform arithmetic and the structural check below enforces that.
//
// Run: node --test Tools/visual-regression/eclipse-cloud-ibl-response.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

// Multi-line source anchors below are written with LF. The checkout is CRLF on
// Windows working trees, so normalize or every anchor silently misses.
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");

const cloudRenderer = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const webgpuEnvManager = readEngine(
  "Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts",
);
const webglEnvManager = readEngine("Scene/DynamicEnvironmentMapManager.js");
const globeCameraUB = readEngine(
  "Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
);
const aerialEffect = readEngine(
  "Renderer/WebGPU/WebGPUAerialPerspectiveEffect.ts",
);
const fogRenderer = readEngine(
  "Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts",
);
const ppCollection = readEngine(
  "Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
);
const responseModule = readEngine("Scene/EclipseCloudResponse.js");
const cloudCollectionFs = readEngine("Shaders/CloudCollectionFS.glsl");

const {
  resolveEclipseCloudFactor,
  eclipseCloudDirectionalFraction,
  applyEclipseCloudDimming,
  quantizeEclipseEnvironmentRefreshInput,
  ECLIPSE_ENV_REFRESH_STEPS,
  ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY,
} = await import(
  pathToFileURL(enginePath("Scene/EclipseCloudResponse.js")).href
);

const { getEclipseSceneLightFactor, ECLIPSE_RADIOMETRIC_FLOOR } = await import(
  pathToFileURL(enginePath("Scene/EclipseState.js")).href
);

/** A minimal published S1 state at a given lunar obscuration. */
function stateAt(obscuration, overrides) {
  return {
    enabled: true,
    valid: true,
    autoExposure: false,
    moonObscuration: obscuration,
    ...overrides,
  };
}

/** The frame-state shape both accessors read. */
function frameAt(obscuration, overrides) {
  const eclipseState = stateAt(obscuration, overrides);
  return {
    eclipseState,
    eclipseSceneLightFactor: getEclipseSceneLightFactor(eclipseState),
  };
}

// The beer-shadow floor `sampleCloudGroundShadow` clamps to, and the mix it
// performs: `mix(1, transmittance, strength)`. Read off GlobeTerrain.wgsl.
const BEER_FLOOR = 0.35;
const shadowedGround = (sceneFactor, strength) =>
  sceneFactor * (1.0 - strength * (1.0 - BEER_FLOOR));

// ─────────────────────────────────────────────────────────────────────────────
// A. The two derived scalars
// ─────────────────────────────────────────────────────────────────────────────

test("A1 identity is EXACT, not approximate, on every accessor", () => {
  // Absent frame state, absent fields, disabled effect, invalid geometry, and a
  // plain non-eclipse frame all resolve to the multiplicative identity.
  for (const frame of [
    undefined,
    {},
    { eclipseState: undefined, eclipseSceneLightFactor: undefined },
    frameAt(0.0),
    { ...frameAt(0.6), eclipseState: stateAt(0.6, { enabled: false }) },
    { ...frameAt(0.6), eclipseState: stateAt(0.6, { valid: false }) },
  ]) {
    assert.equal(eclipseCloudDirectionalFraction(frame), 1.0);
  }

  assert.equal(resolveEclipseCloudFactor(undefined), 1.0);
  assert.equal(resolveEclipseCloudFactor({}), 1.0);
  assert.equal(resolveEclipseCloudFactor(frameAt(0.0)), 1.0);

  // A NaN or out-of-range factor must resolve to the identity rather than
  // poison a uniform. `NaN >= 0` is false, so the range test catches it.
  for (const bad of [NaN, -0.5, 1.5, Infinity, "0.5", null]) {
    assert.equal(
      resolveEclipseCloudFactor({ eclipseSceneLightFactor: bad }),
      1.0,
    );
  }

  // And the composition at the identity is bit-exact for the real shipped
  // defaults each site multiplies (sunIntensity, ambientIntensity, shadow
  // strength, WebGPU scatteringIntensity, WebGL atmosphereScatteringIntensity).
  for (const value of [10.0, 1.5, 1.0, 2.0, 0.04, 50.0, 0.1 + 0.2]) {
    assert.equal(applyEclipseCloudDimming(value, 1.0), value);
  }
});

test("A2 the directional fraction is derived from S2's own constants", () => {
  // Not a tuned curve: visible / (visible + FLOOR*(1-visible)), i.e. the
  // directional share of S2's pre-adaptation flux. Reconstructed here from the
  // exported constant, so a silently re-tuned floor fails.
  for (const o of [0.1, 0.5, 0.9, 0.99, 0.999, 0.99999]) {
    const visible = 1.0 - o;
    const flux = visible + ECLIPSE_RADIOMETRIC_FLOOR * (1.0 - visible);
    assert.equal(eclipseCloudDirectionalFraction(frameAt(o)), visible / flux);
  }
  // The two ends are exact, not merely close.
  assert.equal(eclipseCloudDirectionalFraction(frameAt(0.0)), 1.0);
  assert.equal(eclipseCloudDirectionalFraction(frameAt(1.0)), 0.0);

  // It must NOT carry S2's adaptation exponent — that is a display transform,
  // not a change in the directional/nonlocal split. If it did, the 0.9 value
  // would be the cube root (0.99985), not 0.99955.
  assert.ok(
    Math.abs(eclipseCloudDirectionalFraction(frameAt(0.9)) - 0.9995502) < 1e-6,
  );

  // Driven by moonObscuration ALONE. `sunVisibleFraction` saturates through
  // twilight and all night via its Earth-limb term, so keying on it would erase
  // every cloud shadow at every sunset.
  const nightish = frameAt(0.0);
  nightish.eclipseState.sunVisibleFraction = 0.0;
  nightish.eclipseState.earthOcclusionFraction = 1.0;
  assert.equal(eclipseCloudDirectionalFraction(nightish), 1.0);
});

test("A3 both scalars are monotone and bounded across a full sweep", () => {
  const N = 20000;
  let prevF = resolveEclipseCloudFactor(frameAt(0.0));
  let prevFd = eclipseCloudDirectionalFraction(frameAt(0.0));
  for (let i = 1; i <= N; i++) {
    const frame = frameAt(i / N);
    const f = resolveEclipseCloudFactor(frame);
    const fd = eclipseCloudDirectionalFraction(frame);
    assert.ok(f >= 0.0 && f <= 1.0, `factor out of range at ${i / N}`);
    assert.ok(fd >= 0.0 && fd <= 1.0, `fraction out of range at ${i / N}`);
    assert.ok(f <= prevF, `scene factor rose at obscuration ${i / N}`);
    assert.ok(
      fd <= prevFd,
      `directional fraction rose at obscuration ${i / N}`,
    );
    prevF = f;
    prevFd = fd;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The refutation: why the shadow strength is NOT S2's scene factor
// ─────────────────────────────────────────────────────────────────────────────

test("B1 REJECTED design (strength x sceneFactor) brightens shadowed ground", () => {
  // Reconstruct the design this row deliberately did not ship and show it is
  // non-monotone essentially immediately — the mutant must be detectable.
  const N = 200000;
  let prev = shadowedGround(1.0, 1.0);
  let firstRise = null;
  let peak = prev;
  for (let i = 1; i <= N; i++) {
    const f = resolveEclipseCloudFactor(frameAt(i / N));
    const g = shadowedGround(f, f); // <- the rejected substitution
    if (g > prev + 1e-15 && firstRise === null) {
      firstRise = i / N;
    }
    peak = Math.max(peak, g);
    prev = g;
  }
  assert.notEqual(firstRise, null, "the rejected design must be non-monotone");
  assert.ok(
    firstRise < 0.001,
    `the rejected design brightens from the very start of the partial phase (first rise at ${firstRise})`,
  );
  // It peaks ~10% above the un-eclipsed shadowed value.
  assert.ok(
    peak > shadowedGround(1.0, 1.0) * 1.09,
    `expected a >9% lift, measured ${peak}`,
  );
});

test("B2 SHIPPED design holds shadowed ground monotone across the observable phase", () => {
  // The whole partial phase and all of the deep partial phase are monotone.
  const N = 200000;
  const LAST_MONOTONE = 0.999; // covers every observable instant of a partial eclipse
  let prev = shadowedGround(1.0, 1.0);
  for (let i = 1; i <= Math.floor(N * LAST_MONOTONE); i++) {
    const frame = frameAt(i / N);
    const g = shadowedGround(
      resolveEclipseCloudFactor(frame),
      eclipseCloudDirectionalFraction(frame),
    );
    assert.ok(
      g <= prev + 1e-15,
      `shipped shadowed ground rose at obscuration ${i / N}`,
    );
    prev = g;
  }

  // BEYOND that the shadow is physically DISAPPEARING (the umbral sky is
  // nonlocal multiple scattering no local cloud can block), so the shadowed
  // pixel rises to meet the unshadowed one. Pinned as a bounded, documented
  // terminal transient rather than hidden: it is confined above obscuration
  // 0.9998 — the diamond-ring instant — and lands exactly on the unshadowed
  // twilight floor.
  let minG = Infinity;
  let minAt = 0;
  for (let i = Math.floor(N * LAST_MONOTONE); i <= N; i++) {
    const frame = frameAt(i / N);
    const g = shadowedGround(
      resolveEclipseCloudFactor(frame),
      eclipseCloudDirectionalFraction(frame),
    );
    if (g < minG) {
      minG = g;
      minAt = i / N;
    }
  }
  assert.ok(
    minAt > 0.9998,
    `terminal minimum must be at second contact, got ${minAt}`,
  );
  // At totality the shadow is gone: the shadowed pixel IS the unshadowed one.
  const totality = frameAt(1.0);
  assert.equal(eclipseCloudDirectionalFraction(totality), 0.0);
  assert.equal(
    shadowedGround(resolveEclipseCloudFactor(totality), 0.0),
    resolveEclipseCloudFactor(totality),
  );
});

test("B3 shadow CONTRAST is near-invariant through the partial phase", () => {
  // The physical claim behind the design: an eclipse dims the direct beam and
  // the skylight together, so the shadow's contrast ratio barely moves until
  // the nonlocal floor takes over. A regression that made the shadow visibly
  // lift at 90% obscured would fail here.
  const baseline = 1.0 - 1.0 * (1.0 - BEER_FLOOR); // 0.35
  const at90 =
    1.0 - eclipseCloudDirectionalFraction(frameAt(0.9)) * (1.0 - BEER_FLOOR);
  assert.ok(
    Math.abs(at90 / baseline - 1.0) < 0.002,
    `contrast moved ${(at90 / baseline - 1.0) * 100}% at 90% obscuration`,
  );
  // And it HAS collapsed by totality.
  const atTotality =
    1.0 - eclipseCloudDirectionalFraction(frameAt(1.0)) * (1.0 - BEER_FLOOR);
  assert.equal(atTotality, 1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The quantized environment-refresh input
// ─────────────────────────────────────────────────────────────────────────────

test("C1 quantization edges are exact and the grid is the shared unit grid", () => {
  assert.equal(ECLIPSE_ENV_REFRESH_STEPS, 256);
  assert.equal(ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY, 256);
  // Deliberately the same 1/256 unit grid as the other IBL inputs. If someone
  // invents a private step size, this and the source anchor in D5 both fail.
  assert.match(responseModule, /const ECLIPSE_ENV_REFRESH_STEPS = 256;/);

  // Bucket k covers [(k-0.5)/256, (k+0.5)/256); Math.round takes .5 upward.
  assert.equal(quantizeEclipseEnvironmentRefreshInput(1.0), 256);
  assert.equal(quantizeEclipseEnvironmentRefreshInput(255.5 / 256), 256);
  assert.equal(
    quantizeEclipseEnvironmentRefreshInput(Math.fround(255.5 / 256) - 1e-9),
    255,
  );
  assert.equal(quantizeEclipseEnvironmentRefreshInput(0.5), 128);
  assert.equal(quantizeEclipseEnvironmentRefreshInput(0.5 / 256), 1);
  assert.equal(quantizeEclipseEnvironmentRefreshInput(0.4999 / 256), 0);
  assert.equal(quantizeEclipseEnvironmentRefreshInput(0.0), 0);
  // Defensive inputs resolve to the identity bucket, never to 0 (which would
  // read as "totality" and fire a fill).
  for (const bad of [NaN, -1, 2, undefined, "x"]) {
    assert.equal(quantizeEclipseEnvironmentRefreshInput(bad), 256);
  }
  // Every bucket is an integer, so the gate's `!==` is exact.
  for (let i = 0; i <= 1000; i++) {
    const b = quantizeEclipseEnvironmentRefreshInput(i / 1000);
    assert.equal(b, Math.trunc(b));
  }
});

test("C2 the gate RECOVERS: a level comparison fires on the way back up", () => {
  // The shipped predicate, restated exactly as the two managers write it.
  const shipped = (bucket, committed) => bucket !== committed;
  // THE MUTANT this row exists to prevent: a one-way "only re-fill when it got
  // darker" gate. Written NaN-safely (`!(a >= b)`), exactly as a real author
  // would have to write it to keep the first-frame sentinel working — otherwise
  // the mutant would be rejected for the wrong reason (never firing at all)
  // instead of for the reason that matters (never recovering).
  const latching = (bucket, committed) => !(bucket >= committed);

  // Sweep obscuration 0 -> 0.9 -> 0 and drive both gates.
  const sweep = [];
  const STEPS = 400;
  for (let i = 0; i <= STEPS; i++) sweep.push((0.9 * i) / STEPS);
  for (let i = STEPS - 1; i >= 0; i--) sweep.push((0.9 * i) / STEPS);

  const run = (predicate) => {
    let committed = NaN; // the shipped first-frame sentinel
    let fills = 0;
    let lastFilledBucket = NaN;
    for (const o of sweep) {
      const bucket = quantizeEclipseEnvironmentRefreshInput(
        resolveEclipseCloudFactor(frameAt(o)),
      );
      if (predicate(bucket, committed)) {
        fills++;
        committed = bucket;
        lastFilledBucket = bucket;
      }
    }
    return { fills, lastFilledBucket };
  };

  const shippedRun = run(shipped);
  const latchingRun = run(latching);

  // Shipped: the environment ENDS at the identity bucket — fully recovered.
  assert.equal(
    shippedRun.lastFilledBucket,
    ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY,
  );
  // Latching: it ends stuck at the DARKEST bucket it ever saw. This is the
  // stale-dark latch, reproduced and rejected.
  assert.ok(
    latchingRun.lastFilledBucket < ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY,
    "the one-way mutant must fail to recover",
  );
  assert.equal(
    latchingRun.lastFilledBucket,
    quantizeEclipseEnvironmentRefreshInput(
      resolveEclipseCloudFactor(frameAt(0.9)),
    ),
  );

  // Cadence is bounded and predictable: one fill to establish the first-frame
  // baseline off the NaN sentinel, then at most one per bucket edge in each
  // direction. 256 -> 119 is 137 steps, so 1 + 2*137 = 275 over the whole
  // sweep. Pinned as an equality, not an inequality: a regression that made the
  // gate fire per-frame, or stop firing on the way back up, moves this number.
  const darkest = quantizeEclipseEnvironmentRefreshInput(
    resolveEclipseCloudFactor(frameAt(0.9)),
  );
  assert.equal(darkest, 119);
  const bound = 1 + 2 * (ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY - darkest);
  assert.equal(bound, 275);
  assert.equal(
    shippedRun.fills,
    bound,
    `expected exactly ${bound} fills, got ${shippedRun.fills}`,
  );
  // The sweep is 801 frames, so the gate is quiescent on ~two thirds of them
  // even while the factor is moving continuously.
  assert.ok(shippedRun.fills < sweep.length);
});

test("C3 deferral is lossless and sub-step jitter is inert", () => {
  // C11-193: the granted branch is the ONLY place the bucket is committed, so a
  // budget-denied frame re-evaluates the identical level next frame.
  const bucket = quantizeEclipseEnvironmentRefreshInput(
    resolveEclipseCloudFactor(frameAt(0.6)),
  );
  let committed = ECLIPSE_ENV_REFRESH_BUCKET_IDENTITY;
  // Frame 1 requests, scheduler denies -> no commit.
  assert.ok(bucket !== committed);
  // Frame 2 re-evaluates true because nothing was committed.
  assert.ok(bucket !== committed);
  // Frame 3 granted -> commit -> quiescent.
  committed = bucket;
  assert.ok(!(bucket !== committed));

  // Snap-and-compare, not a delta test: a factor wobbling well inside one grid
  // step never fires, while a slow drift ACCUMULATES across an edge and does.
  const base = 0.500001;
  const jittered = base + 0.3 / 256.0;
  assert.equal(
    quantizeEclipseEnvironmentRefreshInput(base),
    quantizeEclipseEnvironmentRefreshInput(jittered),
  );
  assert.notEqual(
    quantizeEclipseEnvironmentRefreshInput(base),
    quantizeEclipseEnvironmentRefreshInput(base + 1.0 / 256.0),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Source ownership — every site, both backends, with mutation checks
// ─────────────────────────────────────────────────────────────────────────────

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

test("D1 cloud DIRECT and AMBIENT light both carry the factor, resolved once", () => {
  pinWithMutant(
    cloudRenderer,
    /const eclipseCloudFactor = resolveEclipseCloudFactor\(frameState\);/,
    (s) =>
      s.replace(
        "const eclipseCloudFactor = resolveEclipseCloudFactor(frameState);",
        "const eclipseCloudFactor = 1.0;",
      ),
    "the pack resolves the factor from frameState",
  );
  pinWithMutant(
    cloudRenderer,
    /data\[offset\+\+\] = applyEclipseCloudDimming\(\n\s*config\.atmosphereLightIntensity \?\? 10\.0,\n\s*eclipseCloudFactor,\n\s*\); \/\/ sunIntensity/,
    (s) =>
      s.replace(
        "config.atmosphereLightIntensity ?? 10.0,\n    eclipseCloudFactor,",
        "config.atmosphereLightIntensity ?? 10.0,\n    1.0,",
      ),
    "sunIntensity (direct term) is dimmed",
  );
  pinWithMutant(
    cloudRenderer,
    /data\[offset\+\+\] = applyEclipseCloudDimming\(\n\s*config\.cloudAmbientIntensity \?\? 1\.5,\n\s*eclipseCloudFactor,\n\s*\); \/\/ 73 ambientIntensity/,
    (s) =>
      s.replace(
        "config.cloudAmbientIntensity ?? 1.5,\n    eclipseCloudFactor,",
        "config.cloudAmbientIntensity ?? 1.5,\n    1.0,",
      ),
    "ambientIntensity is dimmed too",
  );

  // The ambient leg is load-bearing, not decorative: the deck's ambient colours
  // are hard-coded constants that track no scene light, so a direct-only dim
  // leaves a bright deck over a dark world. Premise re-verified, not assumed.
  assert.match(cloudRenderer, /data\[offset\+\+\] = 0\.5; \/\/ 80/);
  assert.match(cloudRenderer, /data\[offset\+\+\] = 0\.35; \/\/ 84/);
});

test("D1b the AERIAL TINT is an ADDEND and carries the factor too", () => {
  // `C13-41-CLOUD-AERIAL-TINT-UNDIMMED`, closed 2026-08-07 (CO-11). The two
  // scalars D1 pins are MULTIPLIERS on the deck's own radiance, so dimming them
  // makes `weightedColor` exactly linear in F. The aerial tint is different in
  // kind: the shader lerps TOWARD it
  // (`hazed = mix(toneMapped, cloud.aerialColor, aerial)`), so the `aerial`
  // fraction of every deck pixel is this colour no matter how dark the deck
  // gets. Undimmed it is a floor the eclipse cannot reach — the same defect
  // `C13-41-ENV-GROUND-INSCATTER-ADDEND-UNDIMMED` names for the bakes.
  // The dim is applied through ONE named local, so the whole tint moves
  // together and the probe's provenance guard has a numeral-free marker.
  pinWithMutant(
    cloudRenderer,
    /const dimAerialTint = \(channel: number\): number =>\n\s*applyEclipseCloudDimming\(channel, eclipseCloudFactor\);/,
    (s) =>
      s.replace(
        "applyEclipseCloudDimming(channel, eclipseCloudFactor);",
        "applyEclipseCloudDimming(channel, 1.0);",
      ),
    "the aerial tint helper resolves the eclipse factor",
  );
  for (const [channel, expression] of [
    ["92 R", "dimAerialTint(0.8 + (0.62 - 0.8) * todT)"],
    ["93 G", "dimAerialTint(0.62 + (0.72 - 0.62) * todT)"],
    ["94 B", "dimAerialTint(0.5 + (0.85 - 0.5) * todT)"],
  ]) {
    pinWithMutant(
      cloudRenderer,
      new RegExp(
        `data\\[offset\\+\\+\\] = ${expression.replace(
          /[.()+*]/g,
          (c) => `\\${c}`,
        )}; \\/\\/ ${channel}`,
      ),
      (s) =>
        s.replace(
          `data[offset++] = ${expression};`,
          `data[offset++] = ${expression.slice("dimAerialTint(".length, -1)};`,
        ),
      `aerialColor ${channel} routes through the dim`,
    );
  }

  // The SHADER side of the claim: the tint is consumed as the second operand of
  // a `mix`, i.e. an addend. If this ever becomes a multiply the dim above is
  // the wrong correction and this test should fail rather than ride along.
  assert.match(
    readEngine("Shaders/WebGPU/Environment/ProceduralClouds.wgsl"),
    /var hazed = mix\(toneMapped, cloud\.aerialColor, aerial\);/,
  );

  // The aerial STRENGTH is deliberately NOT dimmed: it is the haze FRACTION
  // (a geometry term keyed on march distance), not a radiance. Dimming it would
  // make distant clouds crisper during an eclipse, which is not a light change.
  assert.match(
    cloudRenderer,
    /data\[offset\+\+\] = config\.cloudAerialStrength \?\? 1\.0; \/\/ 91 aerialStrength/,
  );
});

test("D2 the cloud shadow has ONE owner and uses the DIRECTIONAL fraction", () => {
  pinWithMutant(
    cloudRenderer,
    /cache\.shadowStrength = eclipseCloudDirectionalFraction\(frameState\);/,
    (s) =>
      s.replace(
        "cache.shadowStrength = eclipseCloudDirectionalFraction(frameState);",
        "cache.shadowStrength = resolveEclipseCloudFactor(frameState);",
      ),
    "the shadow strength is published from the DIRECTIONAL fraction",
  );

  // All four consumers read that one seam. None may re-derive, and none may
  // keep the old literal.
  const consumers = [
    [
      globeCameraUB,
      /data\[offset\+\+\] = cloudCache\?\.shadowStrength \?\? 1\.0;/g,
      2,
    ],
    [aerialEffect, /f\[o\+\+\] = d\.cloudShadowStrength \?\? 1\.0;/g, 1],
    [
      fogRenderer,
      /r\.paramsData\[98\] = cloudCacheForFog\?\.shadowStrength \?\? 1\.0;/g,
      1,
    ],
  ];
  for (const [source, re, count] of consumers) {
    assert.equal(
      (source.match(re) ?? []).length,
      count,
      `expected ${count} eclipse-aware strength write(s)`,
    );
  }
  // The aerial consumer's value must come from the same `_cloudCache` seam.
  assert.match(
    ppCollection,
    /cloudShadowStrength: cloudCache\?\.shadowStrength \?\? 1\.0,/,
  );
  // No consumer may still write a bare literal strength.
  assert.doesNotMatch(globeCameraUB, /= 1\.0; \/\/ z = strength \(full\)/);
  assert.doesNotMatch(aerialEffect, /f\[o\+\+\] = 1\.0; \/\/ z = strength/);
  assert.doesNotMatch(fogRenderer, /r\.paramsData\[98\] = 1\.0;/);
});

test("D3 WebGPU environment: the bake dims AND the gate can see it", () => {
  // Half one — the dim, on the documented lockstep scalar.
  pinWithMutant(
    webgpuEnvManager,
    /const skyColorScattering = applyEclipseCloudDimming\(\n\s*manager\.atmosphereScatteringIntensity \?\? 2\.0,\n\s*resolveEclipseCloudFactor\(frameState\),\n\s*\);/,
    (s) =>
      s.replace(
        "const skyColorScattering = applyEclipseCloudDimming(\n    manager.atmosphereScatteringIntensity ?? 2.0,\n    resolveEclipseCloudFactor(frameState),\n  );",
        "const skyColorScattering = manager.atmosphereScatteringIntensity ?? 2.0;",
      ),
    "WebGPU bake is dimmed",
  );
  assert.match(webgpuEnvManager, /data\[34\] = skyColorScattering;/);

  // Half two — the quantized level term, UNGATED and in the hoisted predicate.
  pinWithMutant(
    webgpuEnvManager,
    /const eclipseEnvChanged = eclipseEnvBucket !== cache\.lastEclipseEnvBucket;/,
    (s) =>
      s.replace(
        "const eclipseEnvChanged = eclipseEnvBucket !== cache.lastEclipseEnvBucket;",
        "const eclipseEnvChanged = eclipseEnvBucket < cache.lastEclipseEnvBucket;",
      ),
    "the WebGPU term is a symmetric LEVEL comparison",
  );
  // It must NOT be gated on the cloud march the way cloudRevisionChanged is —
  // `cloudsInReflections` is off by default, which would disable the whole leg.
  assert.doesNotMatch(
    webgpuEnvManager,
    /const eclipseEnvChanged =[^;]*wantMarch/,
  );
  const predicate = webgpuEnvManager.slice(
    webgpuEnvManager.indexOf("const refreshRequested ="),
    webgpuEnvManager.indexOf("// A refresh is only deferrable"),
  );
  // Grouped with the sky-bake terms, NOT inside the capture run — the
  // `webgpu-dynamic-environment-recovery` guard pins that run's adjacency.
  assert.match(
    predicate,
    /lutPathChanged \|\|\n(\s*\/\/[^\n]*\n)*\s*eclipseEnvChanged \|\|\n\s*cloudCoverageMoved \|\|/,
  );

  // The commit lives ONLY inside the granted branch (C11-193 lossless defer),
  // and only after the complete fill.
  assert.equal(
    (
      webgpuEnvManager.match(
        /cache\.lastEclipseEnvBucket = eclipseEnvBucket;/g,
      ) ?? []
    ).length,
    1,
  );
  const granted = webgpuEnvManager.slice(
    webgpuEnvManager.indexOf("if (refreshGranted) {"),
    webgpuEnvManager.indexOf("// Expose cubemap + prefiltered IBL views"),
  );
  const fillIdx = granted.indexOf("runProceduralSkyFill(");
  const shIdx = granted.indexOf("runSphericalHarmonicProjection(");
  const commitIdx = granted.indexOf(
    "cache.lastEclipseEnvBucket = eclipseEnvBucket;",
  );
  assert.ok(fillIdx >= 0 && shIdx > fillIdx);
  assert.ok(
    commitIdx > shIdx,
    "the consumed bucket must be committed only after the complete fill",
  );
  // NaN sentinel so the first frame always runs.
  assert.match(webgpuEnvManager, /lastEclipseEnvBucket: NaN,/);
});

test("D4 WebGL environment: the same two halves, the same module", () => {
  pinWithMutant(
    webglEnvManager,
    /adjustments\.w = applyEclipseCloudDimming\(\n\s*manager\.atmosphereScatteringIntensity,\n\s*resolveEclipseCloudFactor\(frameState\),\n\s*\);/,
    (s) =>
      s.replace(
        "adjustments.w = applyEclipseCloudDimming(\n      manager.atmosphereScatteringIntensity,\n      resolveEclipseCloudFactor(frameState),\n    );",
        "adjustments.w = manager.atmosphereScatteringIntensity;",
      ),
    "WebGL bake is dimmed",
  );
  pinWithMutant(
    webglEnvManager,
    /eclipseEnvBucket !== this\._lastEclipseEnvBucket \|\|/,
    (s) =>
      s.replace(
        "eclipseEnvBucket !== this._lastEclipseEnvBucket ||",
        "eclipseEnvBucket < this._lastEclipseEnvBucket ||",
      ),
    "the WebGL term is a symmetric LEVEL comparison",
  );
  assert.match(webglEnvManager, /this\._lastEclipseEnvBucket = NaN;/);
  assert.match(
    webglEnvManager,
    /this\._lastEclipseEnvBucket = eclipseEnvBucket;/,
  );
  // The bucket is committed in the same branch that resets — never elsewhere.
  assert.equal(
    (
      webglEnvManager.match(
        /this\._lastEclipseEnvBucket = eclipseEnvBucket;/g,
      ) ?? []
    ).length,
    1,
  );
});

test("D5 both backends import ONE module — no second eclipse path", () => {
  for (const [source, spec] of [
    [webgpuEnvManager, '"../../Scene/EclipseCloudResponse.js"'],
    [webglEnvManager, '"./EclipseCloudResponse.js"'],
    [cloudRenderer, '"../../Scene/EclipseCloudResponse.js"'],
  ]) {
    assert.ok(
      source.includes(`from ${spec}`),
      `expected an import from ${spec}`,
    );
  }
  // Nothing outside the response module may recompute the eclipse response.
  for (const [name, source] of [
    ["cloud renderer", cloudRenderer],
    ["WebGPU env manager", webgpuEnvManager],
    ["WebGL env manager", webglEnvManager],
    ["globe camera UB", globeCameraUB],
    ["aerial effect", aerialEffect],
    ["fog renderer", fogRenderer],
  ]) {
    assert.doesNotMatch(
      source,
      /ECLIPSE_RADIOMETRIC_FLOOR|ECLIPSE_ADAPTATION_EXPONENT|Math\.pow\([^)]*moonObscuration/,
      `${name} must not re-derive the eclipse curve`,
    );
  }
});

test("D6 the SH step-3 multiply is NOT double-dimmed on either backend", () => {
  // Both backends project THIS cube, so the coefficients inherit the dimming
  // exactly once. A second multiply here would square the factor.
  assert.match(
    webgpuEnvManager,
    /const intensity = manager\.atmosphereScatteringIntensity \?\? 2\.0;/,
  );
  const shSection = webgpuEnvManager.slice(
    webgpuEnvManager.indexOf("function runSphericalHarmonicProjection("),
  );
  assert.doesNotMatch(shSection, /applyEclipseCloudDimming/);

  const webglSh = webglEnvManager.slice(
    webglEnvManager.indexOf("function updateSphericalHarmonicCoefficients("),
  );
  assert.doesNotMatch(webglSh, /applyEclipseCloudDimming|EclipseCloudResponse/);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Structural premises this row's scoping rests on
// ─────────────────────────────────────────────────────────────────────────────

test("E1 no WGSL was touched — the C13-39 occupancy mandate is structural", () => {
  // The whole row is CPU-side uniform arithmetic, so there is no static
  // register pressure to measure. Enforce that by requiring the eclipse to
  // appear in NO shader source at all under the cloud/globe/environment set
  // this row touches.
  const shaderRoots = [
    "Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    "Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
    "Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
    "Shaders/WebGPU/Compute/VolumetricFog.wgsl",
    "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "Shaders/ComputeRadianceMapFS.glsl",
    "Shaders/CloudCollectionFS.glsl",
  ];
  // No shader in the touched set carries this row's marker: C13-41 added zero
  // shader instructions, so there is no occupancy delta to measure.
  for (const rel of shaderRoots) {
    assert.doesNotMatch(
      readEngine(rel),
      /C13-41/,
      `${rel} must not acquire eclipse ALU — this row is uniform-only`,
    );
  }
  // The cloud, sky-cube, fog and GLSL shaders have NO eclipse code at all, and
  // must keep none. `GlobeTerrain.wgsl` is excluded because it already carries
  // C12-29 S5's per-fragment globe umbra, which predates and is not this row.
  for (const rel of shaderRoots.filter(
    (r) => !r.endsWith("Globe/GlobeTerrain.wgsl"),
  )) {
    assert.doesNotMatch(
      readEngine(rel),
      /eclipse/i,
      `${rel} must not acquire eclipse ALU — this row is uniform-only`,
    );
  }
  // And within GlobeTerrain the CLOUD-SHADOW function specifically stays
  // eclipse-free: the response lives entirely in the CPU-packed `strength`.
  const globeSrc = readEngine("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  const shadowFn = globeSrc.slice(
    globeSrc.indexOf("fn sampleCloudGroundShadow("),
    globeSrc.indexOf("// Enhanced Day/Night Rendering"),
  );
  assert.ok(shadowFn.length > 0, "cloud-shadow sampler not found");
  assert.doesNotMatch(shadowFn, /eclipse/i);
  // The two levers this row uses must still be the ones the shaders read.
  const clouds = readEngine("Shaders/WebGPU/Environment/ProceduralClouds.wgsl");
  assert.match(
    clouds,
    /let scatteredLight = \(msLight \+ silverLining\) \* cloud\.sunIntensity;/,
  );
  assert.match(clouds, /\* cloud\.ambientIntensity;/);
  const globe = readEngine("Shaders/WebGPU/Globe/GlobeTerrain.wgsl");
  assert.match(globe, /let strength = camera\.cloudShadowControl\.z;/);
  assert.match(
    globe,
    /return mix\(1\.0, transmittance, clamp\(strength, 0\.0, 1\.0\)\);/,
  );
  // The beer floor this spec's ground model uses must still be 0.35.
  assert.match(globe, /max\(exp\(-opticalDepth \* absorption\), 0\.35\)/);
});

test("E2 the WebGL billboard cloud path is UNLIT — the parity decision's premise", () => {
  // C13-41 gives the WebGL `CloudCollection` billboards NOTHING, deliberately.
  // The justification is that they are unlit by design: no sun direction, no
  // scene light, no N.L, no day/night response — so an eclipse-only multiply
  // would be the ONLY light response they have, which is an inconsistency, not
  // parity. That premise is re-verified here rather than assumed, so if the
  // billboards ever DO acquire scene lighting this decision gets revisited.
  assert.doesNotMatch(
    cloudCollectionFs,
    /czm_lightDirection|czm_lightColor|czm_sunDirection/,
  );
  // Its only brightness input is the per-cloud authored appearance value.
  assert.match(cloudCollectionFs, /in float v_brightness;/);
  const collection = readEngine("Scene/CloudCollection.js");
  assert.match(collection, /const brightness = cloud\.brightness;/);
});
