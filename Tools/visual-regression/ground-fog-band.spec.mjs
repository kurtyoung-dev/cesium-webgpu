// RUNNER REQUIREMENT: Node >= 22.18. This spec imports engine `.ts` modules and
// relies on Node's built-in type stripping, which is on by default only from
// 22.18 onward; on 22.6-22.17 add `--experimental-strip-types`.
// @purpose Pins the inscribed-sphere altitude bug that made ground fog arithmetically absent, the Koschmieder-derived fix, four mutants, and byte-neutrality.
// @status ACTIVE
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
//   7. MUTATION: four ways to un-fix it, each required to be caught;
//   7b. the 2026-08-06 CALIBRATION QUESTION, settled: the "~40 counts" was an
//      attenuation magnitude and not the signed change the probe scores; the
//      model's vertical field of view was 60 where Cesium's aspect rule gives
//      35.98; and the residual 12.9x is the LEVEL datum meeting 307 m of Alpine
//      relief, with the competing "uniform dilution" reading refuted by the
//      rendered row structure rather than argued away;
//   7c. the BASE height fog's own inscribed-sphere datum — an 8.5x latitude
//      error — and the opt-in that corrects it without moving a default byte.
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
  BATCH_844_MEASUREMENT,
  INNER_RADIUS,
  MEASURED_LOWER_BAND_MEAN,
  PROBE_CAMERA,
  WGS84,
  bandElevations,
  bandOpticalDepth,
  cameraFrame,
  compositeDeltaCounts,
  eightBitCounts,
  fogSourceRadianceCounts,
  froxelBandOpticalDepth,
  impliedTerrainOffset,
  invertCompositeDelta,
  invertCompositeSums,
  marchOpticalDepth,
  verticalFieldOfView,
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
const CONDITIONS_JS = "packages/engine/Source/Scene/AtmosphericConditions.js";

const fogSource = read(FOG_WGSL);
const rendererSource = read(RENDERER_TS);
const probeSource = read(PROBE_MJS);
const conditionsSource = read(CONDITIONS_JS);

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

// Camera + datum for the probe's scene. The terrain height beneath the camera
// is no longer a guess: `probe-ground-fog.mjs` echoes `globe.getHeight` at the
// camera and Cesium World Terrain answers 2041.31 m at 10.5E 46.4N. The
// terrain-free (ellipsoid globe) case is covered separately because most demos
// and probes run without a terrain provider.
const ALPINE_TERRAIN_HEIGHT = 2041.31;
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

// The scattering pass's inputs on the ground-fog path, as the renderer packs
// them. Asserted against the source below, so a drift in either direction
// breaks this file rather than silently re-basing the prediction.
const SHIPPED_FOG_ALBEDO = { r: 0.9, g: 0.92, b: 0.95 };
const SHIPPED_GROUND_FOG_AMBIENT = 0.7;
const SHIPPED_FOG_ANISOTROPY = 0.3;
const SHIPPED_SUN_INTENSITY = 1.0;
const SHIPPED_MAX_MOON_SCALE = 0.05;

// The fog's own in-scatter luminance is bounded WITHOUT knowing where the sun
// is: the ambient floor dominates and the Henyey-Greenstein term can only run
// between full backscatter and the shader's clamped forward peak. That makes
// the in-scatter half of the composite a falsifiable prediction with no free
// parameter — which is what settled the 2026-08-06 calibration question.
const inScatterAt = (cosSunAngle, moonScale) =>
  fogSourceRadianceCounts({
    albedo: SHIPPED_FOG_ALBEDO,
    ambientStrength: SHIPPED_GROUND_FOG_AMBIENT,
    sunIntensity: SHIPPED_SUN_INTENSITY,
    cosSunAngle,
    anisotropy: SHIPPED_FOG_ANISOTROPY,
    moonScale,
    cosMoonAngle: cosSunAngle,
  });
const SHIPPED_INSCATTER_BOUNDS = {
  min: inScatterAt(-1, 0),
  max: inScatterAt(1, SHIPPED_MAX_MOON_SCALE),
};

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
  // The probe's camera is 2 km above the datum and the upper band looks UP or
  // grazes the horizon, so those rays never descend into the 120 m band.
  //
  // Cesium's `fov` is the WIDER axis, so at 1280x720 the vertical field of view
  // is 35.98 deg, not 60 — the top 30% of rows spans +10.0 deg down to
  // -0.8 deg, not +22..+4. The rendered frame confirms the narrower figure: the
  // ground-fog delta first appears at row ~216, which is -0.8 deg here and
  // +12 deg (open sky) under the old 60.
  const { topDeg, bottomDeg } = bandElevations(
    UPPER.fromFraction,
    UPPER.toFraction,
  );
  assert.ok(topDeg > 9 && topDeg < 11, `sky band top ${topDeg} deg`);
  assert.ok(
    bottomDeg > -1.0 && bottomDeg < 0,
    `sky band bottom ${bottomDeg} deg — grazing the horizon, not descending`,
  );
  // Only the single grazing ray gets anywhere near the band — over 50 km of
  // curvature it descends about 1 km and the camera sits 1.46 km above the
  // datum — and it is one ray in nine, so the BAND MEAN (which is what the
  // probe scores) stays a tenth of a count.
  assert.ok(
    eightBitCounts(upper.mean) < 0.2,
    `sky band mean moves ${eightBitCounts(upper.mean)} 8-bit counts`,
  );
  assert.ok(
    eightBitCounts(upper.max) < 1.5,
    `even the grazing ray only moves ${eightBitCounts(upper.max)} counts`,
  );

  const lower = marchBand({ ...LOWER, intensity: 1.0 });
  assert.ok(
    eightBitCounts(lower.mean) >
      100 * Math.max(eightBitCounts(upper.mean), 1e-6),
    `ground ${eightBitCounts(lower.mean)} vs sky ${eightBitCounts(upper.mean)}`,
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

// The whole intensity knob, in 8-bit counts, at a given peak extinction.
const sweepCounts = (peakDensity) =>
  [0.3, 0.6, 1.0].map((intensity) =>
    eightBitCounts(
      bandOpticalDepth({
        frame,
        boost: band.groundFogDensityBoost,
        bandHeight: band.GROUND_FOG_BAND_HEIGHT,
        peakDensity,
        referenceAltitude: REFERENCE,
        terrainAltitude: REFERENCE,
        intensity,
        ...LOWER,
      }).mean,
    ),
  );

test("the historical peak extinction described clear air, not fog", () => {
  // 1.2e-4 was tuned in Batch 421 against a whiteout the pre-421 integrate
  // produced for ZERO density, so it never measured this coefficient. It
  // corresponds to 32 km of visibility.
  const historical = visibilityForExtinction(1.2e-4);
  assert.ok(historical > 30000, `historical visibility ${historical} m`);

  // And with the anchor fixed but that coefficient restored, the probe's whole
  // intensity knob collapses into a few 8-bit counts — 0.3 lands within about
  // one count of the quantisation floor and the full 0.3→1.0 travel is under
  // 5 counts, against 31 for the derived value. That is why the coefficient
  // rides with the anchor instead of being left alone.
  //
  // The exact figures moved when the model's vertical field of view was
  // corrected from 60 to the aspect-derived 35.98 deg (the band's rays are
  // shallower, so they traverse more of the layer): the historical low end is
  // 1.27 counts, not the sub-1.0 this test first recorded. Reported rather than
  // hidden — the claim that survives is the COMPRESSION, which is what makes the
  // knob unusable.
  const historicalSweep = sweepCounts(1.2e-4);
  const derivedSweep = sweepCounts(band.GROUND_FOG_PEAK_EXTINCTION);
  const travel = (sweep) => sweep[2] - sweep[0];
  assert.ok(
    historicalSweep[0] < 2 * VISIBLE_COUNTS,
    `historical coefficient at intensity 0.3 moves ${historicalSweep[0]} counts`,
  );
  assert.ok(
    travel(historicalSweep) < 5,
    `historical sweep travel ${travel(historicalSweep)} counts: ${JSON.stringify(historicalSweep)}`,
  );
  assert.ok(
    travel(derivedSweep) > 25,
    `derived sweep travel ${travel(derivedSweep)} counts: ${JSON.stringify(derivedSweep)}`,
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
    /r\.paramsData\[69\] = 0\.0;\s*\n\s*let groundFogTerrainHeight = 0\.0;\s*\n\s*if \(groundFogActive && cMag > 0\) \{/,
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
  // Slot 68 is `altitudeCurvature.x`, the curvature denominator. Pinning it
  // proves slot 69 really is the SECOND component of that same vec4, which is
  // what `u.altitudeCurvature.y` above resolves to. Anchored on the packing
  // statement, not on the prose that describes it.
  assert.match(
    rendererSource,
    /r\.paramsData\[68\] = cMag > 0 \? 1\.0 \/ \(2\.0 \* cMag\) : 0\.0;/,
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

// The MS optical-depth scale (slot 122) is the SECOND consumer of the peak
// extinction: the WGSL injects `groundFogIntensity × peakDensity ×
// exp(-h/bandHeight)`, so the densest froxel of the ground-fog-only path IS
// slot 85 × slot 87, and slot 122 has to reference the same number to condition
// it. Batch 843 re-derived slot 87 and left a second copy of the refuted 1.2e-4
// here, so the two sites described different fogs. These two tests hold them to
// ONE source — the symbol, textually, and the arithmetic it produces.
//
// Both bounds are PACKING STATEMENTS, not comments: a block located by prose
// stops being locatable the moment the prose is reworded.
const msScaleBlock = (source) => {
  const start = source.indexOf("r.paramsData[121] = 2.0;");
  const end = source.indexOf("r.paramsData[123]", start);
  assert.ok(start > 0 && end > start, "the MS scale block must be locatable");
  return source.slice(start, end);
};

// Full-line `//` comments removed, so a comment that QUOTES the refuted literal
// (the block's own history note does) can neither satisfy nor defeat a pin on
// the expression itself.
const codeOnly = (block) =>
  block
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

test("the MS optical-depth scale references the SAME peak extinction slot 87 packs", () => {
  const code = codeOnly(msScaleBlock(rendererSource));
  const msGroundPeak = code.match(/const msGroundPeak =[\s\S]*?;/);
  assert.ok(msGroundPeak, "the MS ground-peak reference must be locatable");
  assert.match(
    msGroundPeak[0],
    /GROUND_FOG_PEAK_EXTINCTION \* groundFogIntensity/,
    "the MS reference must read the leaf constant, not a second copy of it",
  );
  // No extinction literal may live in that expression — a numeric here is the
  // defect, whatever its value. (The `1e-4` CONDITIONING floor on the line
  // below is a different quantity and stays; this pin is scoped to the
  // ground-peak expression alone.)
  assert.doesNotMatch(
    msGroundPeak[0],
    /\d+(?:\.\d+)?e-\d+/,
    "the ground-fog peak extinction must have exactly one home",
  );
  // ...and that one home is the same symbol slot 87 carries.
  assert.match(code, /GROUND_FOG_PEAK_EXTINCTION/);
  assert.match(
    rendererSource,
    /r\.paramsData\[87\] = GROUND_FOG_PEAK_EXTINCTION;/,
  );
});

// `msOpticalDepth = clamp(density × opticalDepthScale, 0, 4)` (VolumetricFog.wgsl
// :1011). `density` on the ground-fog-only path always uses the SHIPPED slot-87
// peak; only the SCALE was reading the stale one, which is why the defect is
// invisible to any gate that reads back slot 87 or `_groundFogDiagnostics`.
const OPTICAL_DEPTH_TARGET = 3.0;
const MS_OPTICAL_DEPTH_CLAMP = 4.0;
const opticalDepthScaleFor = (peak, intensity) =>
  OPTICAL_DEPTH_TARGET / Math.max(0.0, peak * intensity, 1e-4);
const msOpticalDepthAt = (scale, intensity, heightMeters) =>
  Math.min(
    MS_OPTICAL_DEPTH_CLAMP,
    intensity *
      band.GROUND_FOG_PEAK_EXTINCTION *
      Math.exp(-heightMeters / band.GROUND_FOG_BAND_HEIGHT) *
      scale,
  );

test("one source conditions the MS optical depth; the stale literal pinned the whole band at the clamp", () => {
  const derived = opticalDepthScaleFor(band.GROUND_FOG_PEAK_EXTINCTION, 1.0);
  const stale = opticalDepthScaleFor(1.2e-4, 1.0);
  assert.ok(
    Math.abs(derived - 1533.7) < 0.5,
    `derived opticalDepthScale ${derived}`,
  );
  assert.ok(Math.abs(stale - 25000) < 0.5, `stale opticalDepthScale ${stale}`);
  assert.ok(stale / derived > 16, `overstatement ${stale / derived}x`);

  // Derived: the densest froxel lands exactly on the design target and nothing
  // in the band reaches the clamp, so the MS lift decays with altitude — which
  // is the stated intent ("the lift bites only the core").
  assert.ok(
    Math.abs(msOpticalDepthAt(derived, 1.0, 0) - OPTICAL_DEPTH_TARGET) < 1e-9,
  );
  assert.ok(
    msOpticalDepthAt(derived, 1.0, 0) < MS_OPTICAL_DEPTH_CLAMP,
    "the derived scale must never saturate the clamp",
  );
  assert.ok(Math.abs(msOpticalDepthAt(derived, 1.0, 300) - 0.246) < 0.01);

  // Stale: saturated at the clamp from the datum all the way to ~300 m, i.e.
  // across the entire 3-band-height envelope the effect is defined over. Every
  // froxel then takes the maximum MS lift instead of only the dense core.
  assert.equal(msOpticalDepthAt(stale, 1.0, 0), MS_OPTICAL_DEPTH_CLAMP);
  assert.equal(msOpticalDepthAt(stale, 1.0, 120), MS_OPTICAL_DEPTH_CLAMP);
  assert.equal(msOpticalDepthAt(stale, 1.0, 300), MS_OPTICAL_DEPTH_CLAMP);
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
  // And numerically: the reverted coefficient compresses the whole intensity
  // knob into under 5 counts, a 16x loss of travel.
  const historicalSweep = sweepCounts(1.2e-4);
  const derivedSweep = sweepCounts(band.GROUND_FOG_PEAK_EXTINCTION);
  assert.ok(historicalSweep[2] - historicalSweep[0] < 5);
  assert.ok(
    (derivedSweep[2] - derivedSweep[0]) /
      (historicalSweep[2] - historicalSweep[0]) >
      10,
  );
});

test("MUTATION: a SECOND copy of the extinction in the MS scale is caught by the one-home pin", () => {
  // This is the shape the defect actually had: slot 87 correct, slot 122
  // referencing a private literal. Reproduce it and require the pin to reject.
  const mutated = rendererSource.replace(
    "GROUND_FOG_PEAK_EXTINCTION * groundFogIntensity",
    "1.2e-4 * groundFogIntensity",
  );
  assert.notEqual(mutated, rendererSource, "the mutation must actually apply");
  // Slot 87 is UNTOUCHED by the mutation, so the existing slot-87 pin, the
  // `_groundFogDiagnostics` echo and probe-ground-fog's gate H all still pass —
  // which is exactly why this needed its own pin.
  assert.match(mutated, /r\.paramsData\[87\] = GROUND_FOG_PEAK_EXTINCTION;/);
  const mutantExpr = codeOnly(msScaleBlock(mutated)).match(
    /const msGroundPeak =[\s\S]*?;/,
  )[0];
  assert.throws(() =>
    assert.match(
      mutantExpr,
      /GROUND_FOG_PEAK_EXTINCTION \* groundFogIntensity/,
    ),
  );
  assert.throws(() => assert.doesNotMatch(mutantExpr, /\d+(?:\.\d+)?e-\d+/));
});

// Both anchors above used to be COMMENT text. They now sit on packing
// statements, and these two controls prove the new anchors are load-bearing
// rather than merely present. Each rename is deliberately NOT a prefix of the
// anchor it perturbs: a prefix rename leaves the original substring intact and
// the "control" passes for the wrong reason.
test("MUTATION: the slot-68 curvature pin bites when the packing statement moves", () => {
  const mutated = rendererSource.replace(
    "r.paramsData[68] = cMag > 0 ? 1.0 / (2.0 * cMag) : 0.0;",
    "r.paramsData[68] = zzMagnitude > 0 ? 1.0 / (2.0 * zzMagnitude) : 0.0;",
  );
  assert.notEqual(mutated, rendererSource, "the mutation must actually apply");
  assert.throws(() =>
    assert.match(
      mutated,
      /r\.paramsData\[68\] = cMag > 0 \? 1\.0 \/ \(2\.0 \* cMag\) : 0\.0;/,
    ),
  );
});

test("MUTATION: the MS-scale block locator bites when its opening statement moves", () => {
  const mutated = rendererSource.replace(
    "r.paramsData[121] = 2.0;",
    "r.paramsData[121] = msLiftClampZZ;",
  );
  assert.notEqual(mutated, rendererSource, "the mutation must actually apply");
  assert.throws(
    () => msScaleBlock(mutated),
    /the MS scale block must be locatable/,
  );
});

// ── 7b. The calibration question, settled ────────────────────────────────────
//
// Batch 844 shipped a passing acceptance with a recorded 10x magnitude gap:
// the derivation predicted "~40 8-bit counts", the frame moved 3.6. Everything
// below is the settlement, and every number in it is either computed from the
// shipped constants or measured from the probe's own PNGs — nothing is fitted.

test("the '~40 counts' prediction was an ATTENUATION magnitude, not the signed change the probe scores", () => {
  const lower = marchBand({ ...LOWER, intensity: 1.0 });
  // What the derivation quoted: the `scene * transmittance` half alone. On its
  // own that is a DARKENING of the band, which no gate was ever going to see as
  // a "brighten".
  const attenuation = eightBitCounts(lower.mean);
  assert.ok(
    attenuation > 45 && attenuation < 55,
    `attenuation-only magnitude ${attenuation} counts`,
  );

  // What the probe scores: the FULL composite, which adds the mist's own
  // in-scatter back. With the shipped uniforms the mist is BRIGHTER than the
  // terrain it hazes, so the two terms do not cancel — they compound into a
  // net BRIGHTENING of the same order. The corrected prediction is +36, not
  // +/-40, and the distinction is a sign as well as a magnitude.
  const signed = compositeDeltaCounts(
    lower.mean,
    MEASURED_LOWER_BAND_MEAN,
    SHIPPED_INSCATTER_BOUNDS.min,
  );
  assert.ok(signed > 30 && signed < 45, `signed composite delta ${signed}`);

  // A mist DARKER than the terrain would darken the band — the sign is carried
  // by the radiance difference, which is why a prediction has to name both.
  assert.ok(compositeDeltaCounts(lower.mean, 200, 100) < 0);
});

test("the recorded measurement is re-derivable from its own raw sums", () => {
  // Not a write-up: the regression sums are in the model file, so this file
  // recomputes the two numbers the verdict rests on instead of quoting them.
  const inverted = invertCompositeSums(BATCH_844_MEASUREMENT.lowerBandSums);
  assert.ok(
    Math.abs(
      inverted.transmittance - BATCH_844_MEASUREMENT.effectiveTransmittance,
    ) < 1e-4,
    `transmittance ${inverted.transmittance}`,
  );
  assert.ok(
    Math.abs(inverted.fogLuminance - BATCH_844_MEASUREMENT.inScatterCounts) <
      0.05,
    `in-scatter ${inverted.fogLuminance}`,
  );
  // The band mean the probe printed falls out of the same sums.
  const meanScene =
    BATCH_844_MEASUREMENT.lowerBandSums.sumScene /
    BATCH_844_MEASUREMENT.lowerBandSums.count;
  const meanDelta =
    BATCH_844_MEASUREMENT.lowerBandSums.sumDelta /
    BATCH_844_MEASUREMENT.lowerBandSums.count;
  assert.ok(Math.abs(meanScene - BATCH_844_MEASUREMENT.lowerMeanOff) < 0.01);
  assert.ok(
    Math.abs(meanDelta - BATCH_844_MEASUREMENT.lowerBandBrighten) < 0.01,
  );
});

test("the rendered IN-SCATTER lands on the shipped uniforms with no free parameter", () => {
  // The regression's intercept/slope ratio is invariant to any uniform scaling
  // of the fog contribution, so this tests the scattering pass on its own.
  const measured = BATCH_844_MEASUREMENT.inScatterCounts;
  assert.ok(
    measured > SHIPPED_INSCATTER_BOUNDS.min * 0.97 &&
      measured < SHIPPED_INSCATTER_BOUNDS.max * 1.03,
    `measured in-scatter ${measured} counts vs admissible ` +
      `${SHIPPED_INSCATTER_BOUNDS.min.toFixed(1)}..${SHIPPED_INSCATTER_BOUNDS.max.toFixed(1)}`,
  );
  // The interval is narrow BECAUSE the ambient floor dominates: ground fog
  // forces ambientStrength to at least 0.7, and the HG sun term can only add
  // between 0.033 (backscatter) and 0.211 (the clamped forward peak).
  assert.ok(
    SHIPPED_INSCATTER_BOUNDS.max / SHIPPED_INSCATTER_BOUNDS.min < 1.3,
    "the admissible in-scatter interval must stay narrow enough to falsify",
  );
});

test("the whole shortfall is in the OPTICAL DEPTH, and it is the level datum meeting relief", () => {
  const lower = marchBand({ ...LOWER, intensity: 1.0 });
  const measured = BATCH_844_MEASUREMENT.effectiveOpticalDepth;
  const shortfall = lower.mean / measured;
  assert.ok(shortfall > 10 && shortfall < 16, `shortfall ${shortfall}x`);

  // Converted into the one quantity the level band cannot represent: how far
  // the visible terrain stands above the camera's single-scalar datum.
  const offset = impliedTerrainOffset(
    measured,
    lower.mean,
    band.GROUND_FOG_BAND_HEIGHT,
  );
  assert.ok(
    offset > 250 && offset < 360,
    `implied terrain-above-datum ${offset} m`,
  );
  // 3 band heights is where the band's own docstring says the boost becomes
  // negligible, so this scene sits just INSIDE the level datum's design
  // envelope — which is exactly why the mist is faint rather than absent.
  assert.ok(
    offset < 3 * band.GROUND_FOG_BAND_HEIGHT,
    `${offset} m exceeds the level datum's ${3 * band.GROUND_FOG_BAND_HEIGHT} m envelope`,
  );

  // And the sanity check that stops this being circular: put that same terrain
  // offset into the model and it reproduces the measured brighten.
  const predicted = compositeDeltaCounts(
    lower.mean * Math.exp(-offset / band.GROUND_FOG_BAND_HEIGHT),
    BATCH_844_MEASUREMENT.lowerMeanOff,
    BATCH_844_MEASUREMENT.inScatterCounts,
  );
  assert.ok(
    Math.abs(predicted - BATCH_844_MEASUREMENT.lowerBandBrighten) < 0.5,
    `predicted ${predicted} vs measured ${BATCH_844_MEASUREMENT.lowerBandBrighten}`,
  );
});

test("the SHIPPED quadrature is coarser than the fine march, and in the OTHER direction", () => {
  // The shader samples one density per froxel and multiplies by the whole slice
  // thickness; at 64 log slices over 1 m..50 km a slice is ~18% of its own
  // depth, so the slice a 120 m band lives in is several hundred metres thick.
  // Whatever that costs, it does NOT cost optical depth — the filtered read
  // straddles the terrain boundary, where froxels below the datum carry the
  // clamped PEAK density, so the delivered depth comes out HIGHER than the
  // ideal integral. It therefore cannot be the explanation for a shortfall.
  const direction = viewDirection(frame, -20);
  const shipped = froxelBandOpticalDepth({
    frame,
    direction,
    boost: band.groundFogDensityBoost,
    intensity: 1.0,
    peakDensity: band.GROUND_FOG_PEAK_EXTINCTION,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    referenceAltitude: REFERENCE,
    terrainAltitude: REFERENCE,
  });
  const fine = marchOpticalDepth({
    frame,
    direction,
    boost: band.groundFogDensityBoost,
    intensity: 1.0,
    peakDensity: band.GROUND_FOG_PEAK_EXTINCTION,
    bandHeight: band.GROUND_FOG_BAND_HEIGHT,
    referenceAltitude: REFERENCE,
    terrainAltitude: REFERENCE,
  });
  assert.ok(
    shipped.opticalDepth > fine.opticalDepth,
    `shipped ${shipped.opticalDepth} vs fine ${fine.opticalDepth}`,
  );
  assert.ok(
    shipped.opticalDepth < 4 * fine.opticalDepth,
    `shipped quadrature overshoot ${shipped.opticalDepth / fine.opticalDepth}x`,
  );
  // The whole-volume march is enormous (the below-datum clamp times kilometre
  // slices), and it is the composite's depth stop that keeps it off the screen.
  assert.ok(shipped.marchedOpticalDepth > 50);
});

test("MUTATION: the composite inversion actually separates the two halves", () => {
  // Round-trip: synthesise a frame pair from a known (T, S) and require the
  // inversion to return them. If it could not, the calibration verdict above
  // would be unfounded.
  const transmittance = 0.62;
  const fogLuminance = 168.0;
  const scene = [];
  const delta = [];
  for (let value = 5; value < 250; value += 1) {
    scene.push(value);
    delta.push((fogLuminance - value) * (1 - transmittance));
  }
  const inverted = invertCompositeDelta({ scene, delta });
  assert.ok(Math.abs(inverted.transmittance - transmittance) < 1e-9);
  assert.ok(Math.abs(inverted.fogLuminance - fogLuminance) < 1e-9);

  // MUTATION: a uniformly DILUTED composite (the competing hypothesis — the
  // fog reaching the frame at 10% strength) leaves the recovered radiance
  // untouched and moves only the transmittance. That is what makes the
  // in-scatter check independent of the optical-depth check.
  const dilution = 0.1;
  const diluted = invertCompositeDelta({
    scene,
    delta: delta.map((d) => d * dilution),
  });
  assert.ok(Math.abs(diluted.fogLuminance - fogLuminance) < 1e-9);
  assert.ok(
    diluted.transmittance > transmittance,
    "dilution must show up as transmittance, not as radiance",
  );
});

test("MUTATION: a constant dilution cannot produce the measured row structure", () => {
  // The two surviving readings of the shortfall were (a) terrain above the
  // datum and (b) a uniform dilution of the fog contribution. They are
  // separable: under (b) the delivered depth must track the model's smooth
  // elevation profile, because the dilution is the same everywhere.
  //
  // Measured per-row effective optical depth over rows 336..704 of the Batch
  // 844 pair swings 0.030 -> 0.224 -> 0.050 -> 0.087 while the model's own
  // profile falls monotonically 2.02 -> 0.55. A constant factor cannot turn a
  // monotone profile into one with an interior peak and a 7.5x swing.
  const measuredRows = [0.03008, 0.2245, 0.05, 0.0871];
  const modelRows = [2.0231, 1.3659, 0.834, 0.5681];
  const ratios = measuredRows.map((value, index) => value / modelRows[index]);
  const spread = Math.max(...ratios) / Math.min(...ratios);
  assert.ok(
    spread > 5,
    `row-to-row ratio spread ${spread}x — a constant dilution would give 1x`,
  );
  // ...and the same rows read as terrain relief are all plausible Alpine
  // numbers in a narrow band, which is the reading that survives.
  const offsets = measuredRows.map((value, index) =>
    impliedTerrainOffset(value, modelRows[index], band.GROUND_FOG_BAND_HEIGHT),
  );
  for (const offset of offsets) {
    assert.ok(offset > 150 && offset < 550, `implied offset ${offset} m`);
  }
});

// ── 7c. The BASE height fog's own datum ──────────────────────────────────────

test("the base height fog's inscribed-sphere datum is an 8.5x latitude error", () => {
  const falloff = 0.0001; // the shipped default
  const surfaceOffset = (latitudeDeg) => {
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
  const scale = (latitudeDeg) =>
    Math.exp(-surfaceOffset(latitudeDeg) * falloff);
  assert.ok(Math.abs(scale(0) - 0.1178) < 1e-3, `equator scale ${scale(0)}`);
  assert.ok(Math.abs(scale(90) - 1.0) < 1e-6, `polar scale ${scale(90)}`);
  const ratio = scale(90) / scale(0);
  assert.ok(ratio > 8.4 && ratio < 8.6, `pole/equator density ratio ${ratio}`);
  // At the probe's own latitude the same fog is 2.8x thinner than at a pole.
  assert.ok(
    Math.abs(scale(PROBE_CAMERA.latitudeDeg) - 0.36) < 0.01,
    `46.4N scale ${scale(PROBE_CAMERA.latitudeDeg)}`,
  );
});

test("the base-fog correction is OPT-IN and its default is bit-exact", () => {
  const baseFogStart = fogSource.indexOf("// Standard exponential height fog.");
  assert.ok(baseFogStart > 0, "the base height-fog block must be locatable");
  const block = fogSource.slice(
    baseFogStart,
    fogSource.indexOf("let varyingEnabled", baseFogStart),
  );
  assert.match(
    block,
    /let baseAltitude = max\(0\.0, altitude - u\.altitudeCurvature\.z\);/,
  );
  assert.match(block, /exp\(-baseAltitude \* falloff\)/);
  assert.doesNotMatch(block, /exp\(-altitude \* falloff\)/);

  // Default OFF packs 0.0 into slot 70, and `altitude` is already clamped
  // non-negative, so `max(0.0, altitude - 0.0)` returns the same float — the
  // default density field is byte-identical, not merely close.
  assert.match(
    rendererSource,
    /r\.paramsData\[70\] = 0\.0;\s*\n\s*const surfaceRelativeAltitude =/,
  );
  assert.match(
    rendererSource,
    /if \(surfaceRelativeAltitude && cMag > 0\) \{/,
    "the surface datum must only be packed when the flag is opted into",
  );
  for (const altitude of [0, 1e-7, 1, 120, 21384.7, 1e7]) {
    assert.equal(Math.max(0, altitude - 0), altitude);
  }

  // The default in the facade is FALSE — a parity-visible change may not be
  // switched on for existing scenes without a decision.
  assert.match(conditionsSource, /surfaceRelativeAltitude: false,/);

  // And it uses SEA LEVEL, not terrain: the base fog is an atmospheric column.
  const packBlock = rendererSource.slice(
    rendererSource.indexOf("if (surfaceRelativeAltitude && cMag > 0) {"),
    rendererSource.indexOf("r.paramsData[71] = 0.0;"),
  );
  assert.match(packBlock, /0\.0,\s*\n\s*\);/);
});

test("the ground-fog band's shipped inputs are reported for the acceptance probe", () => {
  // Batch 844 could not tell a wrong density from a wrong datum because nothing
  // on the frame reported what the shader had been handed. It does now.
  assert.match(rendererSource, /export interface GroundFogDiagnostics \{/);
  for (const field of [
    "referenceAltitude",
    "terrainHeight",
    "cameraAltitude",
    "ambientStrength",
    "peakDensity",
    "bandHeight",
    "anisotropy",
  ]) {
    assert.match(
      rendererSource,
      new RegExp(`diagnostics\\.${field} = `),
      `${field} must be recorded as packed`,
    );
  }
  // Recorded FROM the packed uniform slots, not from the inputs that produced
  // them — a diagnostic that reads the intent instead of the bytes cannot catch
  // a packing bug.
  assert.match(
    rendererSource,
    /diagnostics\.referenceAltitude = r\.paramsData\[69\];/,
  );
  assert.match(
    rendererSource,
    /diagnostics\.baseSurfaceAltitude = r\.paramsData\[70\];/,
  );
  assert.match(rendererSource, /groundFog: GroundFogDiagnostics;/);
  // And the probe consumes them.
  assert.match(probeSource, /fogGroundDatum/);
  assert.match(probeSource, /impliedTerrainOffset/);
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
  // ...and the per-pixel re-measurement of the same frames agrees with it.
  assert.ok(
    Math.abs(BATCH_844_MEASUREMENT.lowerMeanOff - MEASURED_LOWER_BAND_MEAN) <
      0.05,
  );
});

test("the model's scattering inputs are the ones the renderer packs", () => {
  assert.match(
    rendererSource,
    /const albedo = vf\?\.fogAlbedo \?\? \{ r: 0\.9, g: 0\.92, b: 0\.95 \};/,
  );
  assert.match(
    rendererSource,
    /r\.paramsData\[11\] = vf\?\.fogAnisotropy \?\? 0\.3;/,
  );
  assert.match(rendererSource, /r\.paramsData\[51\] = 1\.0;/);
  assert.match(
    rendererSource,
    /Math\.max\(vf\?\.ambientStrength \?\? 0, 0\.7\)/,
    "ground fog forces an ambient floor, and the in-scatter prediction rests on it",
  );
  assert.match(
    rendererSource,
    /moonIntensity = ac\?\.lighting\?\.moonIntensity \?\? 0\.05;/,
  );
});

test("the probe's row bands map to elevations through Cesium's own fovy rule", () => {
  // `PerspectiveFrustum` applies `fov` to the WIDER axis. Getting this wrong
  // pointed the model's rays 24 deg too high and inflated every band figure it
  // produced.
  assert.ok(Math.abs(verticalFieldOfView(60, 1280, 720) - 35.9834) < 1e-3);
  assert.equal(verticalFieldOfView(60, 720, 1280), 60);
  assert.equal(PROBE_CAMERA.verticalFovDeg, verticalFieldOfView(60, 1280, 720));

  const perspectiveSource = read(
    "packages/engine/Source/Core/PerspectiveFrustum.js",
  );
  assert.match(
    perspectiveSource,
    /frustum\.aspectRatio <= 1\s*\n\s*\? frustum\.fov\s*\n\s*: Math\.atan\(Math\.tan\(frustum\.fov \* 0\.5\) \/ frustum\.aspectRatio\) \* 2\.0;/,
  );
});
