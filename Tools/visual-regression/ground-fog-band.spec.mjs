// RUNNER REQUIREMENT: Node >= 22.18. This spec imports engine `.ts` modules and
// relies on Node's built-in type stripping, which is on by default only from
// 22.18 onward; on 22.6-22.17 add `--experimental-strip-types`.
//
// NEW-WEBGPU-GROUND-FOG-RENDERS-NOTHING.
//
// The measured symptom: `probe-ground-fog.mjs` enables ground fog, the engine
// echoes the config back, zero console and zero device errors are raised, and
// the ON frame is byte-identical to the OFF frame — lower band mean 101.31 in
// both, upper band 167.36 in both, brighten 0.00 in both.
//
// The cause is arithmetic, and this file pins it as arithmetic rather than as
// prose. `densityInjection` reconstructs a froxel's `altitude` as a height above
// the ellipsoid's INSCRIBED SPHERE (the polar radius). That frame is right for
// the base height fog — its scale height is ~10 km, so the sphere-vs-ellipsoid
// offset is just a global density scale — but the ground-fog band's falloff
// scale is 120 m, and the offset is 10.2 km along the probe camera's radial and
// 21.4 km at the equator. `exp(-10214 / 120)` is `e^-85`, so the boost is a
// denormal at best and the accumulated optical depth is ~1e-44: transmittance
// comes back EXACTLY 1.0 in f32 and the in-scatter EXACTLY 0, which makes the
// fog composite a bit-exact copy of the scene colour. Not "too faint to see" —
// arithmetically absent. That is what a byte-identical ON frame means.
//
// NOT a regression. The density path is textually identical to the one Batch 421
// shipped, and Batch 420's ground-fog wiring introduced this anchor with the
// effect. What Batch 421 changed is the SYMPTOM: pre-421 the integrate pass took
// a degenerate `select(scattered * sliceThickness, ...)` branch whenever optical
// depth fell below 1e-6 — exactly what a zero density produces — so the zero
// density rendered a whiteout. Batch 421 replaced that branch with the
// energy-conserving form, which correctly returns nothing for nothing. The
// "probe-verified graded valley mist" recorded at Batch 421 was read off a PNG
// by eye from a probe with no verdict; on this arithmetic those frames were the
// unmodified scene.
//
// What is pinned here:
//   1. the root cause as a checkable fact about WGS84 geometry, evaluated with
//      the shipped functions;
//   2. the historical anchor reproduced and shown to produce a BIT-EXACT
//      pass-through at the probe camera — the byte-identity, derived;
//   3. the shipped anchor measured against the probe's own row bands, in the
//      8-bit counts the probe scores;
//   4. the peak extinction shown to be DERIVED (Koschmieder) rather than tuned;
//   5. byte-neutrality of every path that does not reach the band;
//   6. the WGSL and its CPU packer pinned as one definition;
//   7. MUTATION: four ways to un-fix it, each required to be caught.
//
// MEASUREMENT NOTE: every product metric below is an optical depth converted to
// 8-bit counts against the scene luminance the defect report measured, so a
// "pass" here means a change a frame differ can actually see — not a change
// that is merely non-zero in f64.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  INNER_RADIUS,
  MEASURED_LOWER_BAND_MEAN,
  PROBE_CAMERA,
  WGS84,
  bandElevations,
  bandOpticalDepth,
  cameraFrame,
  eightBitCounts,
  marchOpticalDepth,
  viewDirection,
  visibilityForExtinction,
} from "./lib/ground-fog-band-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
// Line endings are normalised because this repository checks these files out
// with CRLF on Windows; every structural assertion below is about code shape,
// never about which line terminator the working tree happens to carry.
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const FOG_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl";
const DOMAIN_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl";
const RENDERER_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts";
const BAND_TS = "packages/engine/Source/Renderer/WebGPU/WebGPUGroundFogBand.ts";
const PROBE_MJS = "Tools/visual-regression/probe-ground-fog.mjs";

const fogSource = read(FOG_WGSL);
const rendererSource = read(RENDERER_TS);
const probeSource = read(PROBE_MJS);

// The ground-fog CODE block of `densityInjection`, comments around it excluded.
// Every source-shape assertion below reads this rather than the whole file, so
// a doc comment that quotes the expression can never satisfy — or defeat — a
// pin on the expression itself.
const groundFogBlock = (source) => {
  const start = source.indexOf("let groundFogEnabled = u.groundFog.x;");
  const end = source.indexOf("let anisotropy", start);
  assert.ok(start > 0 && end > start, "the ground-fog block must be locatable");
  return source.slice(start, end);
};

// The shipped arithmetic, executed — not re-implemented.
const band = await import(pathToFileURL(path.join(root, BAND_TS)).href);

// Camera + datum for the probe's scene. Terrain height beneath the camera in
// the Alps; the terrain-free (ellipsoid globe) case is covered separately
// because most demos and probes run without a terrain provider.
const ALPINE_TERRAIN_HEIGHT = 1500;
const frame = cameraFrame(
  PROBE_CAMERA.latitudeDeg,
  PROBE_CAMERA.longitudeDeg,
  PROBE_CAMERA.heightMeters,
);
const datum = (terrainHeight) =>
  band.groundFogReferenceAltitude(
    frame.unit.x,
    frame.unit.y,
    frame.unit.z,
    WGS84.a,
    WGS84.a,
    WGS84.b,
    INNER_RADIUS,
    terrainHeight,
  );
const REFERENCE = datum(ALPINE_TERRAIN_HEIGHT);

// The probe's own row bands: bottom 30% of rows is the ground band, top 30% the
// sky band, mid ignored so the horizon does not pollute either.
const LOWER = { fromFraction: 0.7, toFraction: 1.0 };
const UPPER = { fromFraction: 0.0, toFraction: 0.3 };

// A change smaller than one 8-bit count cannot reach the frame at all, so it is
// the floor every product claim in this file has to clear.
const VISIBLE_COUNTS = 1.0;
// The shipped band has to clear the floor by a wide margin at the probe's ON
// intensity, or the acceptance is riding on rounding.
const SHIPPED_LOWER_COUNTS = 20.0;

const marchBand = (options) =>
  bandOpticalDepth({
    frame,
    boost: band.groundFogDensityBoost,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    peakDensity: band.GROUND_FOG_PEAK_EXTINCTION,
    referenceAltitude: REFERENCE,
    terrainAltitude: REFERENCE,
    ...options,
  });

// ── 1. Root cause, as a checkable fact about the geometry ────────────────────

test("the froxel altitude frame sits kilometres above the ground everywhere but the poles", () => {
  // If this offset were small, one anchor would serve both the base fog and the
  // ground band and there would be no defect.
  const offsetAt = (latitudeDeg) => {
    const f = cameraFrame(latitudeDeg, 0, 0);
    return (
      band.ellipsoidRadiusAlongDirection(
        f.unit.x,
        f.unit.y,
        f.unit.z,
        WGS84.a,
        WGS84.a,
        WGS84.b,
      ) - INNER_RADIUS
    );
  };

  // At sea level, on the equator, the surface is 21.4 km above the sphere the
  // froxel altitude is measured from.
  assert.ok(
    Math.abs(offsetAt(0) - 21384.7) < 1,
    `equator offset ${offsetAt(0)}`,
  );
  // At the probe's latitude, 10.2 km.
  assert.ok(
    Math.abs(offsetAt(PROBE_CAMERA.latitudeDeg) - 10214.8) < 1,
    `probe-latitude offset ${offsetAt(PROBE_CAMERA.latitudeDeg)}`,
  );
  // Only at the pole does the frame coincide with the ground.
  assert.ok(offsetAt(90) < 1e-6, `polar offset ${offsetAt(90)}`);

  // The band is 120 m. The offset stays above three band heights — the point
  // past which the boost is negligible — until ~83 deg, so the only latitudes
  // where the historical form could produce ANY mist are polar.
  const threeBands = 3 * band.GROUND_FOG_BAND_HEIGHT;
  assert.ok(
    offsetAt(80) > threeBands,
    `80N offset ${offsetAt(80)} should still exceed ${threeBands}`,
  );
  assert.ok(
    offsetAt(85) < threeBands,
    `85N offset ${offsetAt(85)} — past this the offset finally falls inside ` +
      `the band, which is the only place the historical form could work`,
  );
});

// ── 2. The historical anchor, reproduced, and shown to BE the byte-identity ──

test("the historical anchor makes the composite a BIT-EXACT pass-through", () => {
  // Historical form: the band measured from the inscribed sphere, i.e. datum 0.
  // The ray still stops at the real terrain, because the composite only samples
  // the volume up to the scene depth.
  for (const intensity of [0.3, 0.6, 1.0]) {
    const lower = marchBand({
      ...LOWER,
      intensity,
      referenceAltitude: 0,
    });
    // f32 transmittance is EXACTLY 1 and f32 in-scatter EXACTLY 0, so
    // `scene.rgb * transmittance + scatteredLight` returns `scene.rgb`
    // bit-for-bit. That is the byte-identical ON frame, derived.
    assert.equal(
      Math.fround(Math.exp(-lower.max)),
      1.0,
      `intensity ${intensity}: optical depth ${lower.max} should vanish in f32`,
    );
    assert.ok(
      eightBitCounts(lower.max) < 1e-30,
      `intensity ${intensity}: ${eightBitCounts(lower.max)} 8-bit counts`,
    );
  }
});

test("the historical anchor is not merely faint — it is arithmetically absent", () => {
  // The distinction matters: a faint effect would still perturb SOME pixel and
  // the probe's 0.00 would be a rounding artefact. At the equator the boost is
  // not a denormal, it is the f32 zero.
  const equator = cameraFrame(0, 0, 0);
  const surfaceOffset =
    band.ellipsoidRadiusAlongDirection(
      equator.unit.x,
      equator.unit.y,
      equator.unit.z,
      WGS84.a,
      WGS84.a,
      WGS84.b,
    ) - INNER_RADIUS;
  assert.equal(
    band.groundFogDensityBoost(
      1.0,
      band.GROUND_FOG_PEAK_EXTINCTION,
      band.GROUND_FOG_BAND_HEIGHT,
      surfaceOffset,
      0,
    ),
    0,
  );
});

// ── 3. The shipped anchor, measured in the units the probe scores ────────────

test("the shipped band puts a measurable mist in the probe's ground band", () => {
  const lower = marchBand({ ...LOWER, intensity: 1.0 });
  const counts = eightBitCounts(lower.mean);
  assert.ok(
    counts > SHIPPED_LOWER_COUNTS,
    `ground band moves ${counts.toFixed(2)} 8-bit counts (optical depth ` +
      `${lower.mean.toFixed(4)}) — expected more than ${SHIPPED_LOWER_COUNTS}`,
  );
  // ...and it must NOT be a whiteout: the acceptance is explicitly "terrain
  // visible THROUGH the haze". Transmittance stays well clear of 0.
  assert.ok(
    Math.exp(-lower.mean) > 0.4,
    `ground-band transmittance ${Math.exp(-lower.mean)} — too opaque to see through`,
  );
});

test("the sky band is untouched, which is the discrimination the probe gates on", () => {
  const upper = marchBand({ ...UPPER, intensity: 1.0 });
  // The probe's camera is 2 km above the datum and the upper band looks UP, so
  // those rays never enter the 120 m band at all.
  const { topDeg, bottomDeg } = bandElevations(
    UPPER.fromFraction,
    UPPER.toFraction,
  );
  assert.ok(
    topDeg > 0 && bottomDeg > 0,
    `sky band ${bottomDeg}..${topDeg} deg`,
  );
  assert.ok(
    eightBitCounts(upper.max) < 0.01,
    `sky band moves ${eightBitCounts(upper.max)} 8-bit counts`,
  );

  const lower = marchBand({ ...LOWER, intensity: 1.0 });
  assert.ok(
    eightBitCounts(lower.mean) > 50 * Math.max(eightBitCounts(upper.max), 1e-6),
    `ground ${eightBitCounts(lower.mean)} vs sky ${eightBitCounts(upper.max)}`,
  );
});

test("intensity sweeps a usable range — every step separately visible", () => {
  const sweep = [0.3, 0.6, 1.0].map((intensity) => ({
    intensity,
    counts: eightBitCounts(marchBand({ ...LOWER, intensity }).mean),
  }));
  for (const step of sweep) {
    assert.ok(
      step.counts > VISIBLE_COUNTS,
      `intensity ${step.intensity} moves only ${step.counts.toFixed(2)} counts`,
    );
  }
  assert.ok(
    sweep[0].counts < sweep[1].counts && sweep[1].counts < sweep[2].counts,
    `not monotonic: ${JSON.stringify(sweep)}`,
  );
});

test("the band works on the terrain-free globe too", () => {
  // Most demos and probes run without a terrain provider; the datum then falls
  // back to the ellipsoid surface (sea level) and the mist must still land.
  const seaLevel = datum(0);
  const lower = bandOpticalDepth({
    frame,
    boost: band.groundFogDensityBoost,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    peakDensity: band.GROUND_FOG_PEAK_EXTINCTION,
    referenceAltitude: seaLevel,
    terrainAltitude: seaLevel,
    intensity: 1.0,
    ...LOWER,
  });
  assert.ok(
    eightBitCounts(lower.mean) > SHIPPED_LOWER_COUNTS,
    `ellipsoid-globe ground band moves ${eightBitCounts(lower.mean)} counts`,
  );
  // The datum is the camera's geodetic height below it, which is the whole
  // point of expressing it in the inscribed-sphere frame.
  assert.ok(
    Math.abs(frame.cameraAltitude - seaLevel - PROBE_CAMERA.heightMeters) < 0.5,
    `camera sits ${frame.cameraAltitude - seaLevel} m above the sea-level datum`,
  );
});

test("the band profile is the documented exponential, clamped below the datum", () => {
  const peak = band.groundFogDensityBoost(
    1.0,
    band.GROUND_FOG_PEAK_EXTINCTION,
    band.GROUND_FOG_BAND_HEIGHT,
    REFERENCE,
    REFERENCE,
  );
  const oneBandUp = band.groundFogDensityBoost(
    1.0,
    band.GROUND_FOG_PEAK_EXTINCTION,
    band.GROUND_FOG_BAND_HEIGHT,
    REFERENCE + band.GROUND_FOG_BAND_HEIGHT,
    REFERENCE,
  );
  assert.ok(
    Math.abs(oneBandUp / peak - Math.exp(-1)) < 1e-5,
    `${oneBandUp / peak} should be 1/e at one band height`,
  );
  // Below the datum the clamp holds the peak instead of exploding.
  const belowDatum = band.groundFogDensityBoost(
    1.0,
    band.GROUND_FOG_PEAK_EXTINCTION,
    band.GROUND_FOG_BAND_HEIGHT,
    REFERENCE - 500,
    REFERENCE,
  );
  assert.equal(belowDatum, peak);
});

// ── 4. The peak extinction is derived, not tuned ─────────────────────────────

test("the peak extinction is the Koschmieder value for a stated visibility", () => {
  assert.equal(
    band.GROUND_FOG_PEAK_EXTINCTION,
    band.extinctionForVisibility(2000),
  );
  const visibility = visibilityForExtinction(band.GROUND_FOG_PEAK_EXTINCTION);
  assert.ok(
    Math.abs(visibility - 2000) < 1,
    `implied visibility ${visibility} m`,
  );
  // WMO puts the fog/mist boundary at 1 km and calls anything under 5 km
  // reduced visibility. A knob named "ground fog" at full intensity has to land
  // inside that, and outside the 10 km+ range that means clear air.
  assert.ok(visibility >= 1000 && visibility <= 5000, `${visibility} m`);
});

test("the historical peak extinction described clear air, not fog", () => {
  // 1.2e-4 was tuned in Batch 421 against a whiteout the pre-421 integrate
  // produced for ZERO density, so it never measured this coefficient. It
  // corresponds to 32 km of visibility.
  const historical = visibilityForExtinction(1.2e-4);
  assert.ok(historical > 30000, `historical visibility ${historical} m`);

  // And with the anchor fixed but that coefficient restored, the probe's own
  // intensity sweep drops back under the 8-bit floor at its low end — which is
  // why the coefficient rides with the anchor rather than being left alone.
  const lowEnd = bandOpticalDepth({
    frame,
    boost: band.groundFogDensityBoost,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    peakDensity: 1.2e-4,
    referenceAltitude: REFERENCE,
    terrainAltitude: REFERENCE,
    intensity: 0.3,
    ...LOWER,
  });
  assert.ok(
    eightBitCounts(lowEnd.mean) < VISIBLE_COUNTS,
    `historical coefficient at intensity 0.3 moves ${eightBitCounts(lowEnd.mean)} counts`,
  );
});

// ── 5. Byte-neutrality of the paths that do not reach the band ───────────────

test("ground fog off contributes exactly zero", () => {
  assert.equal(
    band.groundFogDensityBoost(
      0.0,
      band.GROUND_FOG_PEAK_EXTINCTION,
      band.GROUND_FOG_BAND_HEIGHT,
      REFERENCE,
      REFERENCE,
    ),
    0,
  );
  // The WGSL keeps the whole boost — including the new subtraction — inside the
  // enabled gate, so the OFF density field is untouched.
  const block = groundFogBlock(fogSource);
  const gate = block.indexOf(
    "if (groundFogEnabled > 0.5 && groundFogIntensity > 0.0) {",
  );
  const subtraction = block.indexOf("altitude - u.altitudeCurvature.y");
  assert.ok(gate >= 0, "the enabled gate must still exist");
  assert.ok(
    subtraction > gate,
    "the datum subtraction must sit INSIDE the enabled gate, not before it",
  );

  // The CPU mirrors that: the datum slot is written only when ground fog is
  // active, so an off frame's uniform bytes are the historical ones.
  assert.match(
    rendererSource,
    /r\.paramsData\[69\] = 0\.0;\s*\n\s*if \(groundFogActive && cMag > 0\) \{/,
    "slot 69 must default to 0 and be filled only under groundFogActive",
  );
});

// ── 6. The WGSL and its CPU packer, pinned as one definition ─────────────────

test("the shader measures the band from the datum the renderer packs", () => {
  const block = groundFogBlock(fogSource);
  assert.match(
    block,
    /let heightAboveGround = max\(0\.0, altitude - u\.altitudeCurvature\.y\);/,
  );
  assert.match(
    block,
    /exp\(-heightAboveGround \/ bandHeight\)/,
    "the falloff argument must be the ground-relative height",
  );
  assert.doesNotMatch(
    block,
    /exp\(-altitude \/ bandHeight\)/,
    "the inscribed-sphere altitude must never reach the band falloff again",
  );

  // Slot 69 is `altitudeCurvature.y` — the WGSL field the shader reads. Both
  // sides must name the same slot or the band reads the curvature pad.
  assert.match(
    rendererSource,
    /r\.paramsData\[69\] = groundFogReferenceAltitude\(/s,
  );
  assert.match(
    rendererSource,
    /altitudeCurvature \(oneOverDenom, groundFogReference, pad\)/,
  );

  // The uniform block did NOT grow: the datum claimed an existing pad, so every
  // bind group, buffer size and WGSL struct offset is unchanged.
  assert.match(rendererSource, /VOLUMETRIC_FOG_PARAMS_FLOATS = 124;/);

  // The band height and peak extinction the shader is fed come from the leaf
  // module this spec executes — no second copy of either number.
  assert.match(rendererSource, /r\.paramsData\[86\] = GROUND_FOG_BAND_HEIGHT;/);
  assert.match(
    rendererSource,
    /r\.paramsData\[87\] = GROUND_FOG_PEAK_EXTINCTION;/,
  );
});

test("the probe that owns this acceptance gates instead of asking a human", () => {
  // The defect went unnoticed for 400+ batches because this probe printed band
  // numbers under the heading "Manual checks (read the PNGs)" and exited 0
  // whatever they said.
  assert.doesNotMatch(probeSource, /Manual checks/);
  assert.match(probeSource, /process\.exitCode = /);
  assert.match(probeSource, /STRUCTURAL/);
  // The verdict has to be the RELATIVE claim — ground band above sky band —
  // not merely "something changed".
  assert.match(probeSource, /lowerBandBrighten/);
  assert.match(probeSource, /upperBandBrighten/);
});

// ── 7. MUTATION: each way to un-fix it must be caught ────────────────────────

test("MUTATION: dropping the datum is caught by the ground-band measurement", () => {
  const mutant = marchBand({ ...LOWER, intensity: 1.0, referenceAltitude: 0 });
  assert.ok(
    eightBitCounts(mutant.mean) < VISIBLE_COUNTS,
    `the historical anchor must be undetectable, got ${eightBitCounts(mutant.mean)} counts`,
  );
  // ...and the shipped one must be, by the same measurement.
  const shipped = marchBand({ ...LOWER, intensity: 1.0 });
  assert.ok(eightBitCounts(shipped.mean) > SHIPPED_LOWER_COUNTS);
});

test("MUTATION: packing the datum as a constant 0 is caught the same way", () => {
  // The CPU-side version of the same defect: the shader subtracts a slot that
  // is always zero. Identical arithmetic, so the same gate has to reject it.
  const alwaysZero = marchOpticalDepth({
    frame,
    direction: viewDirection(frame, -25),
    boost: band.groundFogDensityBoost,
    intensity: 1.0,
    peakDensity: band.GROUND_FOG_PEAK_EXTINCTION,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    referenceAltitude: 0,
    terrainAltitude: REFERENCE,
  });
  assert.ok(
    eightBitCounts(alwaysZero.opticalDepth) < VISIBLE_COUNTS,
    `${eightBitCounts(alwaysZero.opticalDepth)} counts`,
  );
});

test("MUTATION: restoring the old WGSL falloff is caught by the source pin", () => {
  const shipped = groundFogBlock(fogSource);
  const mutated = shipped.replace(
    "exp(-heightAboveGround / bandHeight)",
    "exp(-altitude / bandHeight)",
  );
  assert.notEqual(mutated, shipped, "the mutation must actually apply");
  // The same two assertions the shipped-source test makes must now fail.
  assert.throws(() =>
    assert.match(mutated, /exp\(-heightAboveGround \/ bandHeight\)/),
  );
  assert.throws(() =>
    assert.doesNotMatch(mutated, /exp\(-altitude \/ bandHeight\)/),
  );
});

test("MUTATION: reverting the peak extinction is caught by the sweep floor", () => {
  const mutated = rendererSource.replace(
    "r.paramsData[87] = GROUND_FOG_PEAK_EXTINCTION;",
    "r.paramsData[87] = 1.2e-4;",
  );
  assert.notEqual(mutated, rendererSource, "the mutation must actually apply");
  assert.throws(() =>
    assert.match(mutated, /r\.paramsData\[87\] = GROUND_FOG_PEAK_EXTINCTION;/),
  );
  // And numerically: the probe's low intensity step falls under the 8-bit floor.
  const lowEnd = bandOpticalDepth({
    frame,
    boost: band.groundFogDensityBoost,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    peakDensity: 1.2e-4,
    referenceAltitude: REFERENCE,
    terrainAltitude: REFERENCE,
    intensity: 0.3,
    ...LOWER,
  });
  assert.ok(eightBitCounts(lowEnd.mean) < VISIBLE_COUNTS);
});

// ── 8. naga ──────────────────────────────────────────────────────────────────

test("the edited fog shader passes naga validation", async () => {
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
  // VolumetricFog is compiled with the shared density-domain chunk prepended,
  // exactly as `WebGPUVolumetricFogResources` assembles it.
  assert.doesNotThrow(() =>
    naga.validate_wgsl(`${read(DOMAIN_WGSL)}\n${fogSource}`),
  );
});

// Sanity on the harness itself: the scene luminance the counts are scored
// against is the one the defect report measured, so the units are the probe's.
test("the counts are scored against the measured scene", () => {
  assert.equal(MEASURED_LOWER_BAND_MEAN, 101.31);
});
