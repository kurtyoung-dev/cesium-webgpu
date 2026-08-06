// VolumetricFog.wgsl — Phase 5b real kernels (height fog + sun/moon
// scattering + front-to-back integration). Phase 5c will add shadow
// occlusion + ambient term; Phase 5d adds 3D noise modulation.
//
// Three compute entry points modeling the Frostbite-style three-pass
// volumetric fog pipeline:
//
//   densityInjection — for each froxel, reconstruct world position via
//                      log-sliced depth + screen-UV unprojection,
//                      compute altitude above the planet surface, and
//                      write base height-fog density `density × exp(-h × falloff)`.
//                      Anisotropy goes in the .a slot.
//
//   lightScattering  — for each froxel, read density, sum sun + moon
//                      in-scattered light using the Henyey-Greenstein
//                      phase function. No shadow occlusion yet (Phase 5c).
//                      Output is `vec4(scatteredRGB, density)` so the
//                      integrate pass can read both with one fetch.
//
//   integrate        — one thread per (x, y) walks z = 0..D-1 and
//                      front-to-back accumulates `accumScattered + transmittance`
//                      using the standard Beer-Lambert + alpha-over
//                      composite. Output is the final 3D texture the
//                      composite render pass samples.
//
// Bind group layout strategy:
//   The three passes have different read/write needs. WGSL doesn't allow
//   the same `@binding(N)` to be declared twice in one module, so each
//   storage texture gets its own dedicated binding number. Each pass's
//   pipeline declares a BGL containing only the bindings its entry point
//   actually references — the unused slots are simply omitted from that
//   pipeline's layout (WebGPU validates per-entry-point, not per-module).
//
//   Binding map:
//     binding 0 — uniform params (all three passes)
//     binding 1 — densityOut         (write, density pass)
//     binding 2 — densityIn          (read, scattering pass)
//     binding 3 — scatteringOut      (write, scattering pass)
//     binding 4 — scatteringIn       (read, integrate pass)
//     binding 5 — integratedOut      (write, integrate pass)

// ─────────────────────────────────────────────────────────────────────
// Shared params
// ─────────────────────────────────────────────────────────────────────

struct VolumetricFogParams {
  // x = width, y = height, z = depth, w = unused
  resolution: vec4<u32>,
  // x = nearPlane, y = froxelMaxDistance,
  // z = baseFogDensity, w = fogFalloff (1/m)
  scattering: vec4<f32>,
  // xyz = fogAlbedo, w = fogAnisotropy (HG g)
  albedoAnisotropy: vec4<f32>,
  // Inverse view-projection matrix — used to unproject screen UV +
  // depth into world-space ray direction for the per-froxel position
  // reconstruction. Camera-relative coordinates work fine because the
  // composite pass and the kernel agree on the same matrix.
  invViewProj: mat4x4<f32>,
  // Sun shadow map matrix (world → shadow clip space). Phase 5c uses
  // this in the scattering kernel to query whether each froxel is lit
  // by the sun → controls god ray formation.
  sunShadowMatrix: mat4x4<f32>,
  // xyz = camera position WC; w = planet inner radius (for altitude)
  cameraAndPlanet: vec4<f32>,
  // xyz = sunDirectionWC (already normalized); w = sunIntensity
  sunDirectionAndIntensity: vec4<f32>,
  // xyz = moonDirectionWC (already normalized); w = moonPhase × moonIntensity
  moonDirectionAndScale: vec4<f32>,
  // x = enableScatteringOcclusion (0/1)
  // y = ambientStrength (0..1, scales the constant ambient term)
  // z = shadowMapValid (0/1, set to 0 when no shadow map is bound;
  //     kernel falls back to fully-lit when this is 0)
  // w = shadowDarkness (matches WebGPU shadow renderer's `darkness`)
  occlusion: vec4<f32>,
  // Phase 5d — varying atmosphere density.
  // x = enableVaryingDensity (0/1)
  // y = noiseScale (m, larger = bigger eddies)
  // z = noiseStrength (0..1, fractional density modulation)
  // w = unused
  noise: vec4<f32>,
  // C-P7-RTE (Batch 26) — altitude reconstruction that avoids the
  // `length(worldPos) - innerRadius` f32 catastrophic cancellation
  // seen pre-Batch-26. Both world-space positions are ~6.4e6 m at
  // Earth radius, so their f32 difference has ~1 m ulp — which
  // produces visible fog banding whenever altitude fluctuations are
  // finer than that (LEO / orbital cameras looking at atmospheric
  // haze).
  //
  // The fix uses a 2nd-order Taylor expansion of `|cameraPos + rayDir*d|`
  // around the camera, which reduces to:
  //
  //     altitude ≈ cameraAltitude
  //              + d * dot(rayDir, cameraUp)
  //              + d² * (1 - dot(rayDir, cameraUp)²) * oneOverDenom
  //
  // where:
  //   xyz = cameraUp = normalize(cameraPos) (CPU-computed in f64,
  //         uploaded as precise unit vector)
  //   w   = cameraAltitude = length(cameraPos) - innerRadius
  //         (CPU-computed in f64 — precise to sub-millimeter)
  //
  // Validates to ~0.25 m error at d = 100 km horizontal from a 10 km
  // altitude camera; ~1 m error at orbital d = 1000 km. Below f32's
  // natural granularity at those scales — good enough for fog.
  cameraAltitudeRTE: vec4<f32>,
  // C-P7-RTE — curvature correction denominator.
  //   x = oneOverDenom = 1 / (2 * (innerRadius + cameraAltitude))
  //                    = 1 / (2 * cameraCenterDistance)
  // Precomputed on CPU in f64 so the quadratic term stays stable.
  //   y, z, w = pad
  altitudeCurvature: vec4<f32>,

  // Phase 6c — Cloud shadows in volumetric fog (Session 65 Batch 44).
  // Each froxel's sun in-scatter term is attenuated by a one-sample
  // cloud-extinction approximation: project from the froxel along the
  // sun direction to the cloud-layer mid-altitude and sample the cloud
  // density there. Cheap (1 fbm sample per froxel × ~1.8M froxels at
  // medium quality) and visually sufficient for fog-grid resolution.
  //
  // cloudShadow:
  //   x = enableCloudShadow flag (0/1, gated on
  //       `atmosphericConditions.clouds.enableVolumetric` + a non-zero
  //       cloud coverage)
  //   y = cloudLayerBottom (m above surface, default 1500)
  //   z = cloudLayerTop    (m above surface, default 4000)
  //   w = cloudCoverage    (0..1)
  cloudShadow: vec4<f32>,
  // cloudWindAndTime:
  //   xy = wind direction in horizontal plane (XZ tangent, normalized)
  //   z  = wind speed (m/s) — together with `time` produces a moving
  //        offset applied before noise sampling so cloud-cast shadows
  //        drift over time matching the cloud render.
  //   w  = time (seconds since scene start)
  cloudWindAndTime: vec4<f32>,
  // cloudDensityShape:
  //   x = densityMultiplier (matches the cloud render's density scale
  //       so the shadow strength tracks the visible cloud thickness)
  //   y = absorptionCoeff   (extinction per unit density × layer
  //       thickness, ~0.04 default)
  //   z = noiseScale        (world units → noise units; default 3e-4
  //       so a 1 km wind offset moves the noise by ~0.3 octaves)
  //   w = reserved
  cloudDensityShape: vec4<f32>,

  // Phase C / Batch 420 — GROUND FOG (low-altitude "valley fog" mist).
  // Adds a height-dependent density BOOST concentrated in the lowest few
  // hundred metres of altitude so the froxel fog renders the classic
  // morning-mist-hugging-the-ground look. Driven by
  // `atmosphericConditions.effects.groundFog`. The boost is added on top
  // of the base height-fog density in `densityInjection`, then smoothly
  // faded out above the band so the result blends into the normal fog
  // (or clear sky) higher up.
  //
  // groundFog:
  //   x = enabled         (0/1 — gate; 0 makes the density pass
  //                        byte-identical to pre-Batch-420 output)
  //   y = intensity       (0..1, scales the peak boost; from
  //                        `effects.groundFog.intensity`)
  //   z = bandHeight      (m, exponential falloff scale — boost ≈
  //                        intensity × exp(-altitude / bandHeight))
  //   w = peakDensity     (the density value a fully-saturated ground
  //                        froxel reaches at altitude 0 when intensity=1;
  //                        a unit-scale knob so the mist reads as opaque
  //                        near the surface independent of the base fog's
  //                        `density`)
  groundFog: vec4<f32>,

  // Batch 431 (FOG-IBL-AMBIENT) — sky-LUT / IBL fog ambient.
  // Replaces the flat-constant `ambientTerm = u.occlusion.y` (used by the
  // lightScattering pass) with an altitude- + time-of-day-correct ambient:
  // a sample of the Bruneton TRANSMITTANCE LUT at `(froxel altitude,
  // view-up)` tinted by the atmosphere-derived SH-L2 irradiance probe
  // (`fogSH`). Sunset fog picks up warm sky color low + cool zenith ambient
  // instead of a flat grey.
  //
  // iblAmbient:
  //   x = enable (0/1) — gate. When < 0.5 the scattering kernel takes the
  //       existing constant branch byte-for-byte (parity default).
  //   y = atmosphereThickness (m) — MUST match the value the transmittance
  //       LUT was baked with (SkyAtmosphere ATMOSPHERE_THICKNESS = 111e3)
  //       so the LUT `v = altitude / thickness` lookup is correct.
  //   z = ambientScale — reuses `ambientStrength` as the brightness knob.
  //   w = reserved.
  iblAmbient: vec4<f32>,

  // Batch 435 (FOG-TEMPORAL) — blue-noise jitter for the integrate pass.
  // When `enableJitter` is on, the integrate march offsets each ray's
  // slice-depth phase by a per-(pixel, frame) blue-noise value so successive
  // frames sample DIFFERENT depths along the ray; the temporal resolve pass
  // then accumulates those jittered marches into a stable, high-sample-count
  // result (amortizing the full march across frames → the grazing-ray cap is
  // lifted). When `enableJitter` < 0.5 the integrate pass adds NO offset and
  // is byte-identical to pre-Batch-435.
  //
  // temporal:
  //   x = enableJitter (0/1)
  //   y = frameIndex (monotonic frame counter, used as the blue-noise seed)
  //   z = reserved
  //   w = reserved
  temporal: vec4<f32>,

  // Batch 437 (CLOUD-SHADOWS) — opt-in HI-FI cloud shadow. When the
  // `cloudShadowHiFi` sub-flag is on (AND globe.cloudCastShadows is on), the
  // scattering pass samples the procedural cloud renderer's beer SHADOW MAP
  // (the ACTUAL rendered cloud optical depth from the sun's view) instead of the
  // cheap 1-sample local-fbm `sampleCloudShadow`. Default OFF keeps the local-fbm
  // path verbatim (byte-identical).
  //
  // cloudShadowHiFi:
  //   x = enable (0/1) — gate. < 0.5 → the legacy local-fbm sampleCloudShadow
  //       runs unchanged (parity default).
  //   y = absorption — so the map's optical depth → transmittance matches the
  //       cloud render's exp(-depth·absorption).
  //   z = strength (0..1 darkening scale).
  //   w = reserved.
  cloudShadowHiFi: vec4<f32>,
  // C13-06 — sun-view clip matrix RELATIVE TO THE CAMERA (`worldToSunClip *
  // translate(camera)`, column-major) for the beer-shadow-map lookup. Identity
  // when the hi-fi flag is off (never used then).
  cloudShadowSunViewVP: mat4x4<f32>,

  // Batch 440 (FOG-MS) — opt-in MULTIPLE-SCATTERING octaves in the
  // lightScattering pass. When the `multiScatter` sub-flag is on AND
  // `msOctaves` > 1, the in-scatter source radiance's directional sun/moon
  // term is replaced by a Frostbite multi-octave sum (`multiScatterFog`):
  // each octave scales the contribution (a^i), the directional occlusion bleed
  // (b^i), and the HG phase eccentricity (c^i) by geometric factors, summed and
  // NORMALIZED by the contribution total. A dense valley mist then reads as a
  // LIT VOLUME (light bleeds into the dense core) instead of a flat dark mass,
  // without blowing out (the normalization caps a thin layer at the
  // single-scatter value). Mirrors ProceduralClouds.wgsl::multiScatterLight.
  //
  // multiScatter:
  //   x = enable (0/1) — gate. < 0.5 → the existing single HG-phase term runs
  //       byte-for-byte (parity default).
  //   y = octaves (>= 1). At 1 the MS gain collapses to 1 (no-op) and the caller
  //       SKIPS the function → byte-identical to the single-scatter term. The
  //       octave loop only contributes a lift at >= 2.
  //   z = decayA — contribution per octave (default 0.5).
  //   w = decayB — Beer extinction per octave (default 0.5).
  multiScatter: vec4<f32>,
  // multiScatterPhase:
  //   x = decayC — HG phase eccentricity per octave (default 0.5; smaller =
  //       deeper octaves relax to isotropic faster → softer core fill).
  //   y = maxGain — upper clamp on the MS lift multiplier (default 2.0). The MS
  //       term only ADDS light (gain in [1, maxGain]); this caps the dense-core
  //       brightening so it stays energy-conserving (no blowout).
  //   z = opticalDepthScale — converts the per-froxel base-density multiplier
  //       into a well-conditioned MS optical depth. CPU-tuned so a froxel at the
  //       CONFIGURED base density lands at optical depth ~3 (deep enough that the
  //       octave-0 Beer is dark and deeper octaves visibly lift it), regardless
  //       of the absolute density value. Thinner (higher-altitude) froxels scale
  //       down proportionally → gain ~1 there (no change), so MS only bites the
  //       dense core.
  //   w = reserved.
  multiScatterPhase: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: VolumetricFogParams;

const PI: f32 = 3.14159265359;

// ─────────────────────────────────────────────────────────────────────
// Shared math helpers
// ─────────────────────────────────────────────────────────────────────

// Slice index → linearized eye-space depth using log distribution.
// Frostbite: linearDepth = near × pow(maxDistance/near, k/D)
// Near-camera slices are tightly packed; far slices coarsely.
fn sliceToLinearDepth(k: f32, slices: f32) -> f32 {
  let near = u.scattering.x;
  let far = u.scattering.y;
  let t = k / max(slices, 1.0);
  return near * pow(far / max(near, 1e-3), t);
}

// Reconstruct the world-space position at the center of a froxel.
// 1. Build screen UV (i + 0.5) / W, (j + 0.5) / H
// 2. Build NDC (uv * 2 - 1), with y flipped (NDC y goes up, UV y goes down)
// 3. Sample the unprojected ray direction by reconstructing two clip
//    points (near and far) and subtracting
// 4. Place the froxel along the ray at the slice's linear depth
// C13-06 — the froxel's offset FROM THE CAMERA. The cloud-shadow projection
// consumes this directly so it never multiplies a full-ECEF position by a
// planet-scale f32 matrix (the `mvp * vec4(position, 1.0)` form the fork's RTE
// law forbids). `froxelWorldPosition` below simply adds the camera back.
fn froxelOffsetFromCamera(gid: vec3<u32>) -> vec3<f32> {
  let res = vec3<f32>(u.resolution.xyz);
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / res.xy;
  let ndcXY = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);

  // Unproject the (ndc.x, ndc.y, 0) and (ndc.x, ndc.y, 1) clip points
  // → take the difference → that's the un-normalized world-ray direction
  // through this pixel. Magnitude doesn't matter; we'll renormalize.
  let clipNear = vec4<f32>(ndcXY, 0.0, 1.0);
  let clipFar = vec4<f32>(ndcXY, 1.0, 1.0);
  let worldNear4 = u.invViewProj * clipNear;
  let worldFar4 = u.invViewProj * clipFar;
  let worldNear = worldNear4.xyz / worldNear4.w;
  let worldFar = worldFar4.xyz / worldFar4.w;
  let rayDir = normalize(worldFar - worldNear);

  // Place the froxel at log-sliced depth along the ray.
  let linearDepth = sliceToLinearDepth(f32(gid.z) + 0.5, res.z);
  return rayDir * linearDepth;
}

fn froxelWorldPosition(gid: vec3<u32>) -> vec3<f32> {
  return u.cameraAndPlanet.xyz + froxelOffsetFromCamera(gid);
}

// Henyey-Greenstein phase function. cosθ is dot(viewDir, lightDir).
//
// Batch 421 — the forward-scatter peak of HG is a near-singularity as
// g → 1 and cosθ → 1 (denom → (1-g)²). With the old `max(denom, 1e-4)`
// floor and a strongly-forward g the function spiked to ~7e4, which the
// fog's single-scatter source-radiance term carried straight into f16
// overflow (65504) — the froxel whiteout. Clamp the anisotropy to a
// stable range and floor the denominator at the physical (1-|g|)² so the
// peak stays finite, then clamp the phase to a sane maximum. A fog mist
// only needs a gentle forward bias; the raw glory-peak is not wanted here
// and would alias into fireflies anyway at froxel resolution.
fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let gc = clamp(g, -0.95, 0.95);
  let g2 = gc * gc;
  // Physical minimum of the denominator is (1-|g|)² (at cosθ=1); never let
  // it drop below that, and keep a small absolute floor for safety.
  let physMin = (1.0 - abs(gc)) * (1.0 - abs(gc));
  let denom = max(1.0 + g2 - 2.0 * gc * cosTheta, max(physMin, 1e-3));
  let phase = (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
  // Clamp the phase so the forward peak can't dominate the in-scatter
  // source radiance (energy-conserving fog wants a bounded source).
  return min(phase, 4.0);
}

// Batch 440 (FOG-MS) — Frostbite/Wrenninge energy-conserving MULTIPLE-SCATTERING
// octaves. Mirrors the OCTAVE STRUCTURE of ProceduralClouds.wgsl::multiScatterLight
// (an N-octave geometric-decay loop with per-octave contribution a^i, Beer
// extinction b^i, and HG phase eccentricity c^i) but returns a MULTIPLIER (>= 1)
// applied to the fog's existing single-scatter term, rather than a raw radiance.
//
// Why a multiplier: the cloud's octave-0 term IS the cloud single-scatter
// (`beerPowder(opticalDepth)·phase`), so its octave loop directly produces the lit
// radiance. The fog's single-scatter is DENSITY-INDEPENDENT (Batch 421 moved
// extinction to the integrate pass), so it has NO Beer term — folding a raw Beer
// octave-0 in would DARKEN it. Instead we compute the multi-octave Beer sum AND the
// octave-0-only Beer reference, and return their RATIO: the relative multi-scatter
// LIFT. In a DENSE core octave 0's Beer is small (dark) while deeper octaves
// penetrate more (brighter), so the ratio > 1 → the dense core is LIT from within.
// In THIN fog every octave's Beer ≈ 1 so the ratio ≈ 1 (no change). Clamped to
// [1, msMaxGain] so MS only ADDS light and can never blow out (energy-conserving).
//
// Per octave i (0-based), with scat = a^i, ext = b^i, ecc = c^i:
//   beer_i  = exp(-opticalDepth * ext)                 // deeper octaves penetrate more
//   phase_i = henyeyGreenstein(cosTheta, g * ecc)      // relaxes toward isotropic
//   msSum  += scat * phase_i * beer_i ;  total += scat
//   octave0Ref = phase_0 * beer_0   (octave-0-only)
//   gain    = (msSum / total) / octave0Ref
// Returns clamp(gain, 1.0, msMaxGain). The caller multiplies the single-scatter
// `HG(cosθ,g)·occlusion` by this so the occlusion (god-ray shadow) is preserved.
//
// PARITY: the caller skips this function entirely when octaves <= 1, so the OFF
// path (or octaves 1) is byte-for-byte the single-scatter term. (Even if called
// at octaves == 1, msSum == ref·total → gain == 1 → multiplier 1, a no-op.)
fn multiScatterFog(
  cosTheta: f32, g: f32, opticalDepth: f32, octaves: i32
) -> f32 {
  let a = u.multiScatter.z;       // contribution decay per octave
  let b = u.multiScatter.w;       // Beer extinction decay per octave
  let c = u.multiScatterPhase.x;  // phase eccentricity decay per octave
  let maxGain = max(u.multiScatterPhase.y, 1.0);  // upper clamp on the MS lift
  let n = max(octaves, 1);

  let phase0 = henyeyGreenstein(cosTheta, g);
  let beer0 = exp(-opticalDepth);
  let octave0Ref = max(phase0 * beer0, 1e-6);

  var msSum: f32 = 0.0;
  var total: f32 = 0.0;
  var scat: f32 = 1.0;
  var ext: f32 = 1.0;
  var ecc: f32 = 1.0;
  for (var i: i32 = 0; i < n; i = i + 1) {
    let beer = exp(-opticalDepth * ext);
    let ph = henyeyGreenstein(cosTheta, g * ecc);
    msSum = msSum + scat * ph * beer;
    total = total + scat;
    scat = scat * a;
    ext = ext * b;
    ecc = ecc * c;
  }
  // Average per-octave radiance vs the octave-0-only reference → relative lift.
  let gain = (msSum / max(total, 1e-6)) / octave0Ref;
  return clamp(gain, 1.0, maxGain);
}

// View direction at this froxel = normalized(worldPos - cameraPos)
fn froxelViewDir(worldPos: vec3<f32>) -> vec3<f32> {
  return normalize(worldPos - u.cameraAndPlanet.xyz);
}

// ─── Phase 5d — fbm3d for varying atmosphere density ──────────────
//
// Standard 3D value noise with hash-based pseudo-random gradients.
// Three octaves of fbm give visually rich density variation without
// the cost of a real 3D Perlin (which would need a precomputed
// permutation table). The output is in [-1, 1]; the density kernel
// maps it into a `(1 + strength × noise)` multiplier.

fn hash13(p: vec3<f32>) -> f32 {
  var pp = fract(p * 0.1031);
  pp = pp + dot(pp, pp.yzx + 33.33);
  return fract((pp.x + pp.y) * pp.z);
}

fn valueNoise3d(p: vec3<f32>) -> f32 {
  let pi = floor(p);
  let pf = fract(p);
  // Smoothstep interpolant gives C1 continuity.
  let w = pf * pf * (3.0 - 2.0 * pf);

  // Sample the 8 cube corners.
  let n000 = hash13(pi + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = hash13(pi + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash13(pi + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash13(pi + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash13(pi + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash13(pi + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash13(pi + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash13(pi + vec3<f32>(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, w.x);
  let nx10 = mix(n010, n110, w.x);
  let nx01 = mix(n001, n101, w.x);
  let nx11 = mix(n011, n111, w.x);
  let nxy0 = mix(nx00, nx10, w.y);
  let nxy1 = mix(nx01, nx11, w.y);
  return mix(nxy0, nxy1, w.z);
}

fn fbm3d(p: vec3<f32>) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var norm = 0.0;
  // 3 octaves — diminishing returns past this for the visual cost.
  for (var i: i32 = 0; i < 3; i = i + 1) {
    sum = sum + valueNoise3d(p * freq) * amp;
    norm = norm + amp;
    amp = amp * 0.5;
    freq = freq * 2.0;
  }
  return (sum / norm) * 2.0 - 1.0;  // Remap [0, 1] → [-1, 1]
}

// CLOUD-LOW-COVERAGE-CUTOFF (fog cheap-path arm) — the distribution constants
// that let the cheap cloud-shadow field share the visible march's coverage
// response. See the long block at the gate in `sampleCloudShadow`.
//
// MEASURED, not tuned. Both numbers come from sampling the two real fields
// with the shipped arithmetic in f32:
//
//   baked shape channel (CloudNoiseBake.wgsl `valueFBM`, 4 octaves, periodic)
//     over a 60^3 grid of its full period: mean 0.43067, sigma 0.08963
//   this module's `fbm3d(p) * 0.5 + 0.5` over 96,800 samples at the real ECEF
//     magnitudes the shadow ray reaches (|samplePos| * 0.0003 ~ 1913, so the
//     f32 hash quantisation the GPU sees is included): mean 0.49976,
//     sigma 0.12063
//
// `FOG_CHEAP_FIELD_MEAN` is 0.5 EXACTLY rather than the measured 0.49976: a
// value fBM of uniform hashes is symmetric about 0.5 by construction, so 0.5
// is the structural value and the residual is sampling noise.
// `FOG_CHEAP_FIELD_SIGMA_RATIO` is 0.12063 / 0.08963.
//
// The ratio is EMPIRICAL and cannot be predicted from octave weights alone
// (those give only 1.065): the bake's periodic `pmod` lattice at base
// frequency 2 and its different hash carry the rest.
const CLOUD_SHAPE_FIELD_MEAN: f32 = 0.4307;
const FOG_CHEAP_FIELD_MEAN: f32 = 0.5;
const FOG_CHEAP_FIELD_SIGMA_RATIO: f32 = 1.3459;

// Map one sample of this module's cheap cloud field onto the baked shape
// field's first two moments, so `cloudEffectiveCoverage`'s threshold means the
// same fraction of deck in both. Deliberately unclamped: `smoothstep` clamps
// its own interpolant, and clamping here would fold the tails the match exists
// to preserve.
fn normalizeFogCheapCloudField(value: f32) -> f32 {
  return CLOUD_SHAPE_FIELD_MEAN +
    (value - FOG_CHEAP_FIELD_MEAN) / FOG_CHEAP_FIELD_SIGMA_RATIO;
}

// Batch 435 (FOG-TEMPORAL) — interleaved-gradient noise (Jimenez 2014),
// the de-facto blue-noise dither used for TAA/temporal jitter. Returns a
// value in [0, 1) that is spatially low-discrepancy (blue-noise-like) across
// the (px, py) grid and decorrelated frame-to-frame by the frameIndex phase.
// Cheaper than a precomputed blue-noise texture and good enough to break up
// the slice-depth banding so the temporal accumulation can average it away.
fn interleavedGradientNoise(px: f32, py: f32, frameIndex: f32) -> f32 {
  // Golden-ratio frame rotation so each frame's pattern is a fresh rotation
  // of the IGN field (the standard "animated blue noise" trick).
  let x = px + 5.588238 * fract(frameIndex * 0.6180339887);
  let y = py + 5.588238 * fract(frameIndex * 0.6180339887);
  return fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y));
}

// Phase 5c — sample the sun shadow map at a world-space position.
// Returns 1.0 (fully lit) when the position is in front of the
// shadow caster, ~0.0 when occluded. Falls back to fully-lit when:
//   - scattering occlusion is disabled (`u.occlusion.x == 0`)
//   - no real shadow map is bound (`u.occlusion.z == 0`)
//   - the projected position is outside the shadow map's view
//
// We use the comparison sampler with a small bias on the projected z
// to avoid self-shadow acne. Phase 5b's HG scattering already gives
// soft fog; PCF here is overkill, so we do a single comparison sample.
fn sampleSunShadow(worldPos: vec3<f32>) -> f32 {
  if (u.occlusion.x < 0.5 || u.occlusion.z < 0.5) {
    return 1.0;
  }
  let clip = u.sunShadowMatrix * vec4<f32>(worldPos, 1.0);
  let proj = clip.xyz / max(abs(clip.w), 1e-6);
  // Shadow map is in [0, 1] UV; clip space is [-1, 1].
  let uv = vec2<f32>(proj.x * 0.5 + 0.5, 0.5 - proj.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || proj.z < 0.0 || proj.z > 1.0) {
    return 1.0;
  }
  // textureSampleCompareLevel returns 1.0 for "in front of" the shadow
  // (lit) and 0.0 for "behind" (occluded). We bias the comparison
  // depth slightly toward the camera to absorb precision noise.
  let bias = 0.001;
  let lit = textureSampleCompareLevel(
    sunShadowMap,
    sunShadowSampler,
    uv,
    proj.z - bias,
  );
  // Apply darkness so a fully-occluded fragment is not pitch black —
  // matches the WebGPU shadow renderer's `darkness` parameter.
  let darkness = u.occlusion.w;
  return mix(darkness, 1.0, lit);
}

// Phase 6c — sample cloud-density along the sun ray at a single point
// to approximate cloud extinction for the volumetric fog scattering
// term. Cheap: 1 fbm sample per froxel. Returns 1.0 (fully lit) when:
//   - the cloud-shadow feature is off (`u.cloudShadow.x == 0`)
//   - the froxel sits above the cloud layer (sun ray exits without
//     hitting the layer in front of us)
//   - sun direction is degenerate
// Otherwise returns `exp(-density × absorption × layerThickness)`
// which is the standard Beer-Lambert transmittance along a single
// step through the cloud layer.
//
// The cloud density function mirrors `ProceduralClouds.wgsl::
// cloudDensity` shape (wind-offset FBM × coverage threshold × height
// shaping) so the shadows roughly track the visible cloud layer the
// `WebGPUProceduralCloudRenderer` raymarches. It uses
// `VolumetricFog.wgsl::valueNoise3d` rather than ProceduralClouds'
// `valueNoise` — the noise functions differ in their hash but at fog
// grid resolution (~160 × 90 × 128 froxels for medium quality) the
// per-froxel cloud shape is much coarser than the screen-pixel cloud
// render anyway, and reusing the local hash keeps the WGSL slim.
fn sampleCloudShadow(worldPos: vec3<f32>, offsetFromCamera: vec3<f32>) -> f32 {
  // Batch 437 (CLOUD-SHADOWS) — HI-FI path. When the opt-in `cloudShadowHiFi`
  // sub-flag is on, REPLACE the cheap local-fbm approximation below with a sample
  // of the procedural cloud renderer's beer SHADOW MAP (the ACTUAL rendered cloud
  // optical depth from the sun's view), so the fog shadow tracks the visible cloud
  // field exactly. The legacy local-fbm path runs verbatim when the flag is off
  // (parity default).
  if (u.cloudShadowHiFi.x >= 0.5) {
    // C13-06 — `cloudShadowSunViewVP` is `worldToSunClip * translate(camera)`,
    // emitted by the shared frame owner in CPU f64, so the operand is the
    // froxel's camera-relative offset rather than its full-ECEF position.
    let clip = u.cloudShadowSunViewVP * vec4<f32>(offsetFromCamera, 1.0);
    let ndc = clip.xyz / max(abs(clip.w), 1e-6);
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return 1.0;
    }
    let opticalDepth = textureSampleLevel(
      cloudShadowMapTex, cloudShadowMapSampler, uv, 0.0).r;
    let absorption = u.cloudShadowHiFi.y;
    let strength = u.cloudShadowHiFi.z;
    let transmittance = max(exp(-opticalDepth * absorption), 0.35);
    return mix(1.0, transmittance, clamp(strength, 0.0, 1.0));
  }

  // NOTE: `enable` is a WGSL reserved keyword (used in `enable <ext>;`
  // extension directives) and is invalid as an identifier — using it
  // produced a "expected identifier for 'let' declaration" parse error
  // the first time this compute shader actually compiled at runtime
  // (Batch 420: ground fog is the first activation path that compiles
  // the froxel fog by default). Renamed to `cloudShadowEnable`.
  let cloudShadowEnable = u.cloudShadow.x;
  if (cloudShadowEnable < 0.5) {
    return 1.0;
  }

  let cloudLayerBottom = u.cloudShadow.y;
  let cloudLayerTop = u.cloudShadow.z;
  let coverage = u.cloudShadow.w;
  if (coverage <= 1e-3) {
    return 1.0;
  }

  let sunDir = u.sunDirectionAndIntensity.xyz;
  // Find t such that |worldPos + sunDir × t| = innerRadius + cloudLayerMid.
  // For grazing sun angles the ray may never reach the layer in front
  // of us — in that case `disc < 0` and we bail to fully-lit.
  let innerRadius = u.cameraAndPlanet.w;
  let cloudMid = innerRadius + 0.5 * (cloudLayerBottom + cloudLayerTop);
  let b = dot(worldPos, sunDir);
  let c = dot(worldPos, worldPos) - cloudMid * cloudMid;
  let disc = b * b - c;
  if (disc < 0.0) {
    return 1.0;
  }
  // Take the FORWARD intersection (along sun) — `−b + sqrt(disc)` is
  // the far root, `−b − sqrt(disc)` is the near root. We want the
  // smaller positive `t` so the sample point is the closest cloud-layer
  // crossing along the sun direction.
  let sqrtD = sqrt(disc);
  let tNear = -b - sqrtD;
  let tFar = -b + sqrtD;
  let t = select(tFar, tNear, tNear > 0.0);
  if (t <= 0.0) {
    return 1.0;
  }
  let samplePos = worldPos + sunDir * t;

  // Wind-offset noise sample. Matches the cloud render's wind-drift so
  // the cast shadows track the visible cloud motion.
  let windDir2 = u.cloudWindAndTime.xy;
  let windSpeed = u.cloudWindAndTime.z;
  let timeS = u.cloudWindAndTime.w;
  let windOffset = vec3<f32>(windDir2.x, 0.0, windDir2.y) * windSpeed * timeS;
  let noiseScale = u.cloudDensityShape.z;
  let p = (samplePos + windOffset) * noiseScale;

  // Base shape via 3-octave fbm in [-1, 1] → remap to [0, 1] for the
  // coverage threshold semantics.
  let n = fbm3d(p) * 0.5 + 0.5;
  // CLOUD-LOW-COVERAGE-CUTOFF — FOG CHEAP-PATH ARM.
  //
  // This gate used to threshold at `1.0 - <the raw requested coverage>`, on
  // the claim (three comment blocks above) that it "mirrors
  // ProceduralClouds.wgsl::cloudDensity shape ... so the shadows roughly track
  // the visible cloud layer". Both halves of that were wrong:
  //
  //   1. the visible march and the IBL cube now route their gate through the
  //      SHARED `cloudEffectiveCoverage` response, and this was the last raw
  //      `1.0 - coverage` threshold left in the cloud-density family; and
  //   2. a coverage threshold is only transferable between two density fields
  //      when they have the SAME distribution, and these two do not. The
  //      baked shape channel the march samples is a 4-octave periodic value
  //      fBM measuring mean 0.4307 / sigma 0.0896 / max 0.7164, while the
  //      local field here is `fbm3d`'s 3-octave value fBM, which is symmetric
  //      about 0.5 by construction and measures sigma 0.1206 / max 0.9331 —
  //      a field 35% wider and centred 0.07 higher.
  //
  // Feeding the same threshold to both therefore mistracks in BOTH directions:
  // with the shared response applied to the march, the raw gate here shadowed
  // 0.07% of ground at coverage 0.15 where the visible deck covers 2.21%, and
  // 65.0% at coverage 0.55 where the visible deck covers 41.3% — worst error
  // 23.9 percentage points. Fair-weather skies cast almost no fog shadow while
  // mid-coverage skies cast a near-overcast one. (Every figure in this block is
  // reproduced by the spec named at the end of it; run that, don't trust this.)
  //
  // The fix is a re-derivation, not a rescale: STANDARDISE this field onto the
  // baked shape field's first two moments and then apply the shared response
  // unmodified. That makes the gate's exceedance — the fraction of the deck
  // that is cloud — agree with the visible march's to within 1.5 percentage
  // points across the whole coverage range, and it keeps ONE definition of the
  // coverage response in the engine (`CloudDensityDomain.wgsl`, prepended to
  // this module by `WebGPUVolumetricFogResources`). Normalising the SAMPLE
  // rather than moving the threshold also matches the smoothstep RAMP, so the
  // gate's amplitude distribution tracks as well as its support.
  //
  // Reachability: everything from `cloudShadowEnable < 0.5` upward is
  // unchanged, so a scene without volumetric clouds is byte-identical.
  //
  // CPU twin: `normalizeFogCheapCloudField` in WebGPUCloudDensityDomain.ts.
  // Pinned by Tools/visual-regression/fog-cheap-coverage-gate.spec.mjs — do
  // not edit one alone.
  var density = smoothstep(
    1.0 - cloudEffectiveCoverage(coverage),
    1.0,
    normalizeFogCheapCloudField(n)
  );
  density = density * u.cloudDensityShape.x;

  // Height shaping: weaker shadow when sample lands above the layer
  // top (sun ray exits cloud quickly) — gentler than the cloud render's
  // anvil curve but cheap.
  let altitudeAtSample = length(samplePos) - innerRadius;
  let layerThickness = max(cloudLayerTop - cloudLayerBottom, 1.0);
  let inLayer = step(cloudLayerBottom, altitudeAtSample) *
                step(altitudeAtSample, cloudLayerTop);
  density = density * inLayer;

  // Beer-Lambert transmittance along the cloud-layer step.
  let absorption = u.cloudDensityShape.y;
  let extinction = density * absorption * layerThickness;
  return exp(-extinction);
}

// ─────────────────────────────────────────────────────────────────────
// Storage texture bindings — disjoint numbers per access mode + texture
// so the WGSL module declares each only once.
// ─────────────────────────────────────────────────────────────────────

@group(0) @binding(1) var densityOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var densityIn: texture_storage_3d<rgba16float, read>;
@group(0) @binding(3) var scatteringOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var scatteringIn: texture_storage_3d<rgba16float, read>;
@group(0) @binding(5) var integratedOut: texture_storage_3d<rgba16float, write>;

// Phase 5c — sun shadow map binding for scattering occlusion. Used by
// the lightScattering pass only. The renderer binds either the real
// shadow map (when sun shadows are active) or a 1×1 placeholder
// depth texture (when not). The kernel checks `u.occlusion.z` first
// and skips sampling entirely on the placeholder path.
@group(0) @binding(6) var sunShadowMap: texture_depth_2d;
@group(0) @binding(7) var sunShadowSampler: sampler_comparison;

// Batch 431 (FOG-IBL-AMBIENT) — sky-LUT / IBL ambient bindings, used by
// the lightScattering pass only. The renderer binds the real atmosphere
// TRANSMITTANCE LUT (binding 8) + a linear sampler (binding 9) + the
// atmosphere-derived SH-L2 irradiance buffer (binding 10) once they're
// available, or white/zero placeholders otherwise. The kernel only samples
// these when `u.iblAmbient.x >= 0.5`; with the flag off the placeholders
// are never touched and the ambient term is byte-identical to the prior
// flat constant.
@group(0) @binding(8) var fogTransmittanceLut: texture_2d<f32>;
@group(0) @binding(9) var fogLutSampler: sampler;
// Batch 437 (CLOUD-SHADOWS) — sun-view beer shadow map (binding 11) + a linear
// sampler (binding 12), used by the lightScattering pass only. Bound
// UNCONDITIONALLY (1×1 zero placeholder when the hi-fi flag is off → the legacy
// local-fbm path runs) so the BGL never forks. Sampled only inside the
// `cloudShadowHiFi.x >= 0.5` branch of `sampleCloudShadow`.
@group(0) @binding(11) var cloudShadowMapTex: texture_2d<f32>;
@group(0) @binding(12) var cloudShadowMapSampler: sampler;
// SHUniforms layout (matches ModelPBRComplete.wgsl::SHUniforms + the
// DynEnvMap SH buffer): 9 vec4 L2 coefficients + 1 vec4 control slot
// (control.w == 1.0 when the SH projection has populated real data).
struct FogSHUniforms {
  c0: vec4<f32>,
  c1: vec4<f32>,
  c2: vec4<f32>,
  c3: vec4<f32>,
  c4: vec4<f32>,
  c5: vec4<f32>,
  c6: vec4<f32>,
  c7: vec4<f32>,
  c8: vec4<f32>,
  control: vec4<f32>,
};
@group(0) @binding(10) var<uniform> fogSH: FogSHUniforms;

// Batch 431 (FOG-IBL-AMBIENT) — evaluate the L2 spherical-harmonic
// irradiance probe along direction `N`. Mirrors
// ModelPBRComplete.wgsl::evalSphericalHarmonics EXACTLY (same coefficient
// order + basis polynomials) so the fog ambient matches the model diffuse
// IBL — the SH set is the SAME atmosphere-derived buffer. `control.w` is
// 0 on the placeholder / before the projection runs, which scales the
// whole result to 0 so an unpopulated SH contributes nothing (fall back
// to the transmittance-only tint).
fn evalFogSH(N: vec3<f32>) -> vec3<f32> {
  var c = fogSH.c0.xyz;
  c = c + fogSH.c1.xyz * N.y;
  c = c + fogSH.c2.xyz * N.z;
  c = c + fogSH.c3.xyz * N.x;
  c = c + fogSH.c4.xyz * (N.x * N.y);
  c = c + fogSH.c5.xyz * (N.y * N.z);
  c = c + fogSH.c6.xyz * (3.0 * N.z * N.z - 1.0);
  c = c + fogSH.c7.xyz * (N.z * N.x);
  c = c + fogSH.c8.xyz * (N.x * N.x - N.y * N.y);
  // Gate on control.w (1.0 = SH active). max() clamps negative lobes (the
  // SH reconstruction can ring slightly below 0 at grazing directions).
  return max(c, vec3<f32>(0.0)) * fogSH.control.w;
}

// Sample the atmosphere TRANSMITTANCE LUT for the optical path from a
// point at `altitude` (m above the inner radius) looking along `cosZenith`
// (cos of the angle between the ray and local up) to the top of
// atmosphere. Mirrors AtmosphereLUT.wgsl::computeTransmittance's UV layout
// EXACTLY (and AerialPerspective.wgsl::sampleTransmittance):
//   u = (cosZenith + 1) / 2 ,  v = altitude / thickness .
// This is the warm-low / cool-high sky color the fog ambient picks up:
// near the horizon at sunset the path-to-TOA transmittance is reddened
// (blue scattered out), high up it stays bluer.
fn sampleFogTransmittance(altitude: f32, cosZenith: f32) -> vec3<f32> {
  let thickness = u.iblAmbient.y;
  let uvx = clamp(cosZenith * 0.5 + 0.5, 0.0, 1.0);
  let uvy = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(
    fogTransmittanceLut, fogLutSampler, vec2<f32>(uvx, uvy), 0.0
  ).rgb;
}

// ─────────────────────────────────────────────────────────────────────
// Pass 1 — Density injection
// ─────────────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8, 1)
fn densityInjection(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.resolution.x || gid.y >= u.resolution.y || gid.z >= u.resolution.z) {
    return;
  }

  let baseDensity = u.scattering.z;
  let falloff = u.scattering.w;

  let worldPos = froxelWorldPosition(gid);

  // C-P7-RTE — altitude reconstruction via 2nd-order Taylor expansion
  // around the camera position. See the `cameraAltitudeRTE` comment on
  // VolumetricFogParams for derivation and accuracy bounds. This
  // replaces the pre-Batch-26 `length(worldPos) - innerRadius`, which
  // had ~1 m f32 cancellation ulp that produced fog-density banding at
  // orbital altitudes. Clamped to >= 0 so below-ground froxels get
  // full density instead of negative-altitude exponential explosions.
  let cameraUp = u.cameraAltitudeRTE.xyz;
  let cameraAltitude = u.cameraAltitudeRTE.w;
  let oneOverDenom = u.altitudeCurvature.x;

  // `d * rayDir` is the froxel's offset from the camera — small
  // (~view-frustum magnitude), so f32 handles it with millimetre
  // precision. `cosGamma` is the cosine between the ray and the
  // camera's up (ellipsoid radial) direction.
  let froxelOffset = worldPos - u.cameraAndPlanet.xyz;
  let d = length(froxelOffset);
  let cosGamma = select(dot(froxelOffset, cameraUp) / max(d, 1e-6), 0.0, d < 1e-6);

  let deltaLinear = d * cosGamma;
  let deltaCurvature = d * d * (1.0 - cosGamma * cosGamma) * oneOverDenom;
  let altitude = max(0.0, cameraAltitude + deltaLinear + deltaCurvature);

  // Standard exponential height fog.
  var density = baseDensity * exp(-altitude * falloff);

  // Phase 5d — varying atmosphere density. Modulate the height-fog
  // density by `(1 + strength × fbm3d(worldPos / scale))`. The noise
  // is sampled at world position so the field is camera-stable —
  // moving the camera doesn't shift the haze pockets.
  let varyingEnabled = u.noise.x;
  if (varyingEnabled > 0.5) {
    let scale = max(u.noise.y, 1.0);
    let strength = u.noise.z;
    let n = fbm3d(worldPos / scale);
    density = density * (1.0 + strength * n);
    // Clamp to non-negative; large negative noise + low base density
    // could otherwise produce negative density which the integration
    // pass treats as anti-fog (visual artifact).
    density = max(density, 0.0);
  }

  // Phase C / Batch 420 — GROUND FOG boost. When enabled, add a near-
  // surface density spike that decays exponentially with altitude so the
  // mist hugs the ground and fades into the normal fog (or clear) above
  // the band. `altitude` is the same RTE-reconstructed altitude the base
  // height fog uses, so the boost tracks terrain elevation correctly.
  // Gated behind `enabled` AND `intensity > 0` so the OFF default path is
  // byte-identical to pre-Batch-420 (the `densityInjection` output is
  // unchanged when `u.groundFog.x < 0.5`).
  let groundFogEnabled = u.groundFog.x;
  let groundFogIntensity = u.groundFog.y;
  if (groundFogEnabled > 0.5 && groundFogIntensity > 0.0) {
    let bandHeight = max(u.groundFog.z, 1.0);
    let peakDensity = u.groundFog.w;
    // Exponential height falloff: full strength at the surface, ~37% at
    // one band-height, negligible beyond ~3 band-heights. `intensity`
    // scales the peak so a partially-saturated atmosphere produces a
    // thinner mist.
    let groundBoost =
      groundFogIntensity * peakDensity * exp(-altitude / bandHeight);
    // Add the boost on top of the base height fog so the mist layers over
    // any existing fog rather than replacing it.
    density = density + groundBoost;
  }

  let anisotropy = u.albedoAnisotropy.w;

  textureStore(
    densityOut,
    vec3<i32>(gid),
    vec4<f32>(density, 0.0, 0.0, anisotropy),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Pass 2 — Light scattering (sun + moon, no occlusion yet)
// ─────────────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8, 1)
fn lightScattering(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.resolution.x || gid.y >= u.resolution.y || gid.z >= u.resolution.z) {
    return;
  }

  // Read the density we just wrote in Pass 1.
  let densitySample = textureLoad(densityIn, vec3<i32>(gid));
  let density = densitySample.x;
  let g = densitySample.w;

  // Skip empty froxels — pure black scatter, no work to do. The output
  // texture is cleared to (0,0,0,0) by the next call so we still need
  // to write something, but we can short-circuit the phase math.
  if (density <= 1e-6) {
    textureStore(
      scatteringOut,
      vec3<i32>(gid),
      vec4<f32>(0.0, 0.0, 0.0, 0.0),
    );
    return;
  }

  let worldPos = froxelWorldPosition(gid);
  let viewDir = froxelViewDir(worldPos);

  let albedo = u.albedoAnisotropy.xyz;

  // Phase 5c — query the sun shadow map at this froxel's world
  // position. When occlusion is off (or no shadow map is bound) this
  // is hard-coded to 1.0 (fully lit). Otherwise it's `darkness..1`
  // depending on whether the froxel is in shadow.
  let sunShadowFactor = sampleSunShadow(worldPos);

  // Phase 6c — cloud shadows in volumetric fog. Multiplies a cheap
  // single-sample cloud extinction approximation into the existing sun
  // shadow term so clouds cast soft shadows in the fog beneath them
  // (visible as darkened patches in the volumetric god rays under a
  // cloudy sky). Returns 1.0 (no attenuation) when the cloud-shadow
  // feature is off, when the froxel is above the cloud layer, or when
  // the sun is at a grazing angle that misses the cloud layer in
  // front of us. See `sampleCloudShadow` for the approximation.
  let cloudShadowFactor = sampleCloudShadow(worldPos, froxelOffsetFromCamera(gid));
  let effectiveSunShadow = sunShadowFactor * cloudShadowFactor;

  // Batch 440 (FOG-MS) — decide once whether the multi-octave path runs.
  // It requires the flag AND octaves > 1; at octaves == 1 the multi-scatter
  // sum reduces to the single-scatter term, so we take the cheaper single
  // branch (which is ALSO the byte-identical parity default when the flag is
  // off). `i32(... + 0.5)` rounds the f32 octave count to an integer.
  let msEnabled = u.multiScatter.x >= 0.5;
  let msOctaves = i32(u.multiScatter.y + 0.5);
  let useMS = msEnabled && msOctaves > 1;
  // Local froxel OPTICAL DEPTH for the MS Beer octaves. The denser the froxel,
  // the higher the optical depth, so the per-octave `exp(-opticalDepth·b^i)`
  // makes the dense core's deeper octaves the ones that lift it (lit volume).
  // `density` is the base fog-density multiplier (Batch 421, dimensionless) and
  // the ENERGY-CONSERVING fog spreads opacity across many individually-THIN
  // froxels, so a per-froxel `density` is small even where the column is opaque.
  // `opticalDepthScale` (CPU-tuned to the configured base density) maps the base
  // density to optical depth ~3 so the dense-core lift is well-conditioned; the
  // clamp keeps a runaway density from pushing every octave's Beer to 0.
  let msOpticalDepth = clamp(density * u.multiScatterPhase.z, 0.0, 4.0);

  // Sun contribution. The shadow factor cuts the sun term to zero
  // (or to `darkness × sunTerm`) inside terrain shadow volumes,
  // producing visible god rays where the lit and shadowed regions
  // meet at high density gradient.
  let sunDir = u.sunDirectionAndIntensity.xyz;
  let sunIntensity = u.sunDirectionAndIntensity.w;
  let cosThetaSun = dot(viewDir, sunDir);
  // Single-scatter term (parity default), optionally lifted by the MS gain. The
  // MS gain is a multiplier (>= 1) that brightens the dense-core forward scatter
  // (lit volume); it multiplies the EXISTING `phaseSun * effectiveSunShadow`
  // product, so the god-ray occlusion is preserved. At octaves <= 1 `useMS` is
  // false and the term is byte-identical to the single-scatter default.
  let phaseSun = henyeyGreenstein(cosThetaSun, g);
  var sunMSGain: f32 = 1.0;
  if (useMS) {
    sunMSGain = multiScatterFog(cosThetaSun, g, msOpticalDepth, msOctaves);
  }
  let sunScatter = sunIntensity * phaseSun * effectiveSunShadow * sunMSGain;

  // Moon contribution. The .w slot is already (phase × intensity), so
  // a new moon (phase=0) zeroes the moon term naturally — no extra
  // branch needed. Phase 5c does NOT sample a moon shadow map (the
  // moon is dim enough that shadow precision wouldn't be visible);
  // a future Phase 5e could add it if motivated. The moon has no shadow
  // term, so the MS path passes occlusion = 1.0 (fully lit) — at octaves == 1
  // that returns exactly `henyeyGreenstein(cosThetaMoon, g)` (parity).
  let moonDir = u.moonDirectionAndScale.xyz;
  let moonScale = u.moonDirectionAndScale.w;
  let cosThetaMoon = dot(viewDir, moonDir);
  let phaseMoon = henyeyGreenstein(cosThetaMoon, g);
  var moonMSGain: f32 = 1.0;
  if (useMS) {
    moonMSGain = multiScatterFog(cosThetaMoon, g, msOpticalDepth, msOctaves);
  }
  let moonScatter = moonScale * phaseMoon * moonMSGain;

  // Phase 5c — ambient term. Without this, occlusion-cut shadow
  // volumes become hard-edged + over-dark. The DEFAULT (parity) path uses
  // a flat constant tinted by the fog albedo so shadowed froxels still
  // receive a soft fill.
  let ambientStrength = u.occlusion.y;
  let ambientTerm = ambientStrength;

  // ENERGY-CONSERVING SINGLE-SCATTER (Batch 421).
  //
  // This is the *source radiance* the slice would scatter toward the eye
  // if it were fully opaque — it is DENSITY-INDEPENDENT (no `× density`
  // factor here). The integrate pass turns this into the actual in-scatter
  // contribution by weighting it with the slice's absorption fraction
  // `(1 - exp(-σ·Δz))`, which is bounded to ≤ 1. That keeps the total
  // accumulated in-scatter ≤ the source radiance (energy-conserving) and
  // gives a smooth Beer-Lambert rolloff instead of the unbounded
  // `density × thickness` accumulation that whited out over the long
  // horizon path (NEW-WEBGPU-FROXEL-FOG-SCATTER-DYNAMIC-RANGE).
  //
  // Density is still packed in `.a` because the integrate pass needs it to
  // compute the per-slice optical depth `σ·Δz`.
  //
  // Batch 431 (FOG-IBL-AMBIENT) — when the opt-in flag is on, replace the
  // flat-constant ambient with a sky-LUT / IBL ambient COLOR. The OFF path
  // below is BYTE-IDENTICAL to pre-Batch-431 (same scalar `ambientTerm`,
  // same `albedo * (sunScatter + moonScatter + ambientTerm)` expression);
  // the flag-on path takes a separate branch so the parity-default
  // float arithmetic is untouched.
  var sourceRadiance: vec3<f32>;
  if (u.iblAmbient.x < 0.5) {
    sourceRadiance = albedo * (sunScatter + moonScatter + ambientTerm);
  } else {
    // ── Sky-LUT / IBL fog ambient ──
    // 1) Reconstruct the froxel altitude (same RTE 2nd-order Taylor
    //    expansion densityInjection uses — see cameraAltitudeRTE).
    let camUp = u.cameraAltitudeRTE.xyz;
    let camAlt = u.cameraAltitudeRTE.w;
    let invDenom = u.altitudeCurvature.x;
    let froxelOffset = worldPos - u.cameraAndPlanet.xyz;
    let dLen = length(froxelOffset);
    let cosGamma = select(
      dot(froxelOffset, camUp) / max(dLen, 1e-6), 0.0, dLen < 1e-6
    );
    let altitude = max(
      0.0,
      camAlt + dLen * cosGamma
        + dLen * dLen * (1.0 - cosGamma * cosGamma) * invDenom
    );

    // 2) Sky tint from the TRANSMITTANCE LUT along the SUN direction at this
    //    altitude. cosZenith = dot(localUp, sunDir): at sunset the sun is
    //    near the horizon (cosZenith ≈ 0 → long, reddened path) so the
    //    ambient warms; at noon (cosZenith ≈ 1 → short white path) it stays
    //    neutral. The result tracks time of day. Scaled by sun intensity so
    //    night fog isn't lit by a stale daytime tint.
    let cosSunZenith = dot(camUp, sunDir);
    let skyTint = sampleFogTransmittance(altitude, cosSunZenith)
                  * max(sunIntensity, 0.0);

    // 3) Cool zenith ambient from the SH-L2 irradiance probe evaluated
    //    along local up. Zero when the SH buffer is a placeholder
    //    (control.w == 0) → transmittance-only ambient in that case.
    let shAmbient = evalFogSH(camUp);

    // 4) Blend: Hillaire sky-view transmittance × ambient-probe SH. The
    //    skyTint carries the low-warm / high-cool gradient; the SH adds the
    //    directional zenith fill. Both scaled by `ambientStrength` (the same
    //    knob the constant path uses) so brightness stays user-controllable.
    //    Bounded by the same implicit energy budget — skyTint <= 1 and the
    //    SH ambient is clamped non-negative, so the source radiance can't
    //    blow out.
    let ambientScale = u.iblAmbient.z;
    let iblAmbientColor = (skyTint + shAmbient) * ambientScale;
    sourceRadiance =
      albedo * (sunScatter + moonScatter) + albedo * iblAmbientColor;
  }

  textureStore(
    scatteringOut,
    vec3<i32>(gid),
    vec4<f32>(sourceRadiance, density),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Pass 3 — Front-to-back integration
// ─────────────────────────────────────────────────────────────────────

// Single thread per (x, y), serial walk over z. Dispatched as
// (ceil(W/8), ceil(H/8), 1) — note z=1 unlike the other two passes.
@compute @workgroup_size(8, 8, 1)
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.resolution.x || gid.y >= u.resolution.y) {
    return;
  }

  let res = vec3<f32>(u.resolution.xyz);
  let depthCount = u.resolution.z;

  var accumScattered = vec3<f32>(0.0);
  var transmittance = 1.0;

  // Batch 435 (FOG-TEMPORAL) — per-(pixel, frame) blue-noise slice-depth
  // jitter. When the temporal flag is OFF, `jitterPhase` is exactly 0.0 so
  // the depth slicing below is byte-identical to pre-Batch-435. When ON, each
  // frame offsets every slice's sampled depth by a fractional [-0.5, 0.5)
  // sub-slice amount, so successive jittered marches sample different points
  // along the ray; the temporal resolve pass accumulates them into a clean,
  // high-effective-sample-count volume (the grazing-ray cap is lifted because
  // a single frame no longer has to resolve the whole march).
  var jitterPhase = 0.0;
  if (u.temporal.x > 0.5) {
    let ign = interleavedGradientNoise(
      f32(gid.x), f32(gid.y), u.temporal.y
    );
    jitterPhase = ign - 0.5;
  }

  // Pre-compute the previous slice's depth so we can take the slice
  // thickness for extinction. The first slice spans (near, depth(1)).
  // The jitter shifts the slice boundaries coherently so the per-slice
  // thickness stays positive and the march still covers (near, far).
  var prevDepth = sliceToLinearDepth(jitterPhase, res.z);

  for (var k: u32 = 0u; k < depthCount; k = k + 1u) {
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(k));
    let s = textureLoad(scatteringIn, coord);
    // `sourceRadiance` is the DENSITY-INDEPENDENT in-scatter source the
    // scattering pass wrote (albedo × phase-weighted light + ambient).
    let sourceRadiance = s.rgb;
    let density = s.a;

    let curDepth = sliceToLinearDepth(f32(k) + 1.0 + jitterPhase, res.z);
    let sliceThickness = max(curDepth - prevDepth, 0.0);
    prevDepth = curDepth;

    // ENERGY-CONSERVING SINGLE-SCATTER (Batch 421).
    //
    // Optical depth of this slice and its Beer-Lambert transmittance:
    //   tau               = σ_t · Δz
    //   sliceTransmittance = exp(-tau)
    //
    // The analytic transmittance-weighted in-scatter integral over the
    // slice is `sourceRadiance · (1 - sliceTransmittance)` — the fraction
    // of light the slice absorbs is exactly the fraction it scatters back
    // toward the eye (albedo folded into `sourceRadiance`). This is
    // BOUNDED to ≤ sourceRadiance per slice, so accumulating it across the
    // whole march can never exceed the source radiance no matter how long
    // the low-altitude horizon path is. That replaces the prior unbounded
    // `sourceRadiance · density · Δz` term that blew past the 1.0 display
    // clamp across a <1.2× density window (the whiteout cliff).
    let tau = max(density * sliceThickness, 0.0);
    let sliceTransmittance = exp(-tau);
    let inscatter = sourceRadiance * (1.0 - sliceTransmittance);

    // Front-to-back: weight each slice's in-scatter by the transmittance
    // accumulated from the camera up to this slice, then attenuate the
    // running transmittance by this slice. `transmittance` is the SAME
    // energy-conserving product the composite multiplies the scene color
    // by, so opacity and in-scatter color stay consistent.
    accumScattered = accumScattered + transmittance * inscatter;
    transmittance = transmittance * sliceTransmittance;

    textureStore(
      integratedOut,
      coord,
      vec4<f32>(accumScattered, transmittance),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pass 4 — Temporal reprojection + accumulation (Batch 435, FOG-TEMPORAL)
// ─────────────────────────────────────────────────────────────────────
//
// Hillaire/Frostbite froxel temporal accumulation. The integrate pass writes
// the FRESHLY-MARCHED (blue-noise-jittered) current volume to
// `integratedCurrent`. This pass reprojects the PREVIOUS frame's accumulated
// history (`temporalHistoryIn`) into the current froxel grid via
// `previousViewProjection`, neighborhood-clamps it to reject ghosting (Karis
// 2014), and exponentially blends `mix(clampedHistory, current, alpha)` with a
// small alpha (~0.05) so the effective sample count is ~1/alpha marches. The
// result (the new accumulated history) is what the composite samples.
//
// This pass is dispatched ONLY when temporal is on; on the parity-default path
// it is never recorded and the composite samples the raw integrated volume.

struct TemporalUniforms {
  // Previous-frame world→clip matrix (UniformState.previousViewProjection),
  // column-major. Reprojects the current froxel world anchor into last frame.
  previousViewProjection: mat4x4<f32>,
  // Current-frame inverse view-projection (unproject froxel UV + slice depth →
  // world position; SAME convention as `froxelWorldPosition`).
  invViewProj: mat4x4<f32>,
  // xyz = current camera world position; w = planet inner radius.
  cameraAndInner: vec4<f32>,
  // xyz = grid resolution (W, H, D) as f32; w = pad.
  gridParams: vec4<f32>,
  // x = nearPlane, y = froxelMaxDistance, z = blend alpha (new-sample weight),
  // w = firstFrame flag (1.0 → emit current only, identity history seed).
  depthParams: vec4<f32>,
};

@group(0) @binding(0) var<uniform> t: TemporalUniforms;
@group(0) @binding(1) var integratedCurrent: texture_3d<f32>;
@group(0) @binding(2) var temporalHistoryIn: texture_3d<f32>;
@group(0) @binding(3) var temporalSampler: sampler;
@group(0) @binding(4) var temporalHistoryOut: texture_storage_3d<rgba16float, write>;

// Slice index → linear depth (matches `sliceToLinearDepth`, but reads the
// temporal uniform's near/far so the resolve agrees with the integrate march).
fn tSliceToLinearDepth(k: f32, slices: f32) -> f32 {
  let near = t.depthParams.x;
  let far = t.depthParams.y;
  let tt = k / max(slices, 1.0);
  return near * pow(far / max(near, 1e-3), tt);
}

// Inverse of tSliceToLinearDepth: linear depth → fractional slice index in
// [0, D]. Used to find which previous-frame slice a reprojected depth lands in.
fn tLinearDepthToSlice(depth: f32, slices: f32) -> f32 {
  let near = t.depthParams.x;
  let far = t.depthParams.y;
  let ratio = far / max(near, 1e-3);
  let logR = log(max(ratio, 1.0 + 1e-6));
  let frac = log(max(depth, 1e-3) / max(near, 1e-3)) / max(logR, 1e-6);
  return clamp(frac, 0.0, 1.0) * slices;
}

// Reconstruct the world-space position at a froxel center using the current
// frame's invViewProj (mirrors `froxelWorldPosition`).
fn tFroxelWorldPosition(gid: vec3<u32>, res: vec3<f32>) -> vec3<f32> {
  let uv = (vec2<f32>(gid.xy) + vec2<f32>(0.5)) / res.xy;
  let ndcXY = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let clipNear = vec4<f32>(ndcXY, 0.0, 1.0);
  let clipFar = vec4<f32>(ndcXY, 1.0, 1.0);
  let worldNear4 = t.invViewProj * clipNear;
  let worldFar4 = t.invViewProj * clipFar;
  let worldNear = worldNear4.xyz / worldNear4.w;
  let worldFar = worldFar4.xyz / worldFar4.w;
  let rayDir = normalize(worldFar - worldNear);
  let linearDepth = tSliceToLinearDepth(f32(gid.z) + 0.5, res.z);
  return t.cameraAndInner.xyz + rayDir * linearDepth;
}

// Sample the current integrated volume at an integer froxel (point — the grid
// IS the data, so a load-equivalent at slice center).
fn tSampleCurrent(coord: vec3<f32>, res: vec3<f32>) -> vec4<f32> {
  let uvw = (coord + vec3<f32>(0.5)) / res;
  return textureSampleLevel(integratedCurrent, temporalSampler, uvw, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn temporalResolve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = t.gridParams.xyz;
  if (gid.x >= u32(res.x) || gid.y >= u32(res.y) || gid.z >= u32(res.z)) {
    return;
  }
  let coordF = vec3<f32>(gid);
  let coordI = vec3<i32>(gid);

  // Current freshly-marched (jittered) froxel value.
  let current = tSampleCurrent(coordF, res);

  // FIRST FRAME — history is invalid; write the current sample as the
  // identity history (no startup flash; TAA/CSM first-frame convention).
  if (t.depthParams.w > 0.5) {
    textureStore(temporalHistoryOut, coordI, current);
    return;
  }

  // ── 3×3×3 neighborhood AABB of the CURRENT (freshly-marched) volume ──
  // The reprojected history is clamped into this box to reject ghosting: a
  // stale history value that disagrees with the current neighborhood (a
  // freshly-revealed/occluded region under camera motion) is snapped onto the
  // box so it cannot smear last frame's fog across the new frame.
  var nMin = current;
  var nMax = current;
  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        if (dx == 0 && dy == 0 && dz == 0) { continue; }
        let nc = coordF + vec3<f32>(f32(dx), f32(dy), f32(dz));
        // Skip out-of-grid neighbors (clamp-to-edge would just duplicate the
        // edge froxel — harmless, but explicit skip keeps the AABB tight).
        if (nc.x < 0.0 || nc.y < 0.0 || nc.z < 0.0 ||
            nc.x >= res.x || nc.y >= res.y || nc.z >= res.z) {
          continue;
        }
        let sN = tSampleCurrent(nc, res);
        nMin = min(nMin, sN);
        nMax = max(nMax, sN);
      }
    }
  }

  // ── Reproject this froxel's world anchor into the previous frame ──
  let worldAnchor = tFroxelWorldPosition(gid, res);
  let prevClip = t.previousViewProjection * vec4<f32>(worldAnchor, 1.0);
  // Behind the previous camera (w <= 0) → no valid reprojection; current only.
  if (prevClip.w <= 0.0) {
    textureStore(temporalHistoryOut, coordI, current);
    return;
  }
  let prevNdc = prevClip.xyz / prevClip.w;
  // NDC → UV (same v-flip as the forward froxel reconstruction).
  let prevUV = vec2<f32>(prevNdc.x * 0.5 + 0.5, 1.0 - (prevNdc.y * 0.5 + 0.5));

  // DISOCCLUSION — reprojected off-screen last frame → no history to blend;
  // the current freshly-marched sample shows immediately (no trailing hole).
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    textureStore(temporalHistoryOut, coordI, current);
    return;
  }

  // Find the previous-frame slice this froxel reprojects to from its depth in
  // the previous camera's eye space (distance along the previous view ray ≈
  // distance from the previous camera to the anchor — the froxel grid is
  // camera-relative so this is the right depth key).
  let prevCamDist = length(worldAnchor - t.cameraAndInner.xyz);
  let prevSliceF = tLinearDepthToSlice(prevCamDist, res.z);
  let prevW = clamp((prevSliceF) / res.z, 0.0, 1.0);

  // Sample history at the reprojected (uv, slice). Trilinear via the 3D
  // sampler. Then neighborhood-CLAMP into the current 3×3×3 AABB.
  let prevUVW = vec3<f32>(prevUV.x, prevUV.y, prevW);
  let historyRaw = textureSampleLevel(
    temporalHistoryIn, temporalSampler, prevUVW, 0.0
  );
  let history = clamp(historyRaw, nMin, nMax);

  // Exponential accumulation: blend the clamped history with the new sample by
  // the per-frame alpha (history keeps 1-alpha). Holding the camera still,
  // repeated jittered marches converge to a clean image; under motion the
  // clamp keeps it crisp.
  let alpha = clamp(t.depthParams.z, 0.01, 1.0);
  let result = mix(history, current, alpha);
  textureStore(temporalHistoryOut, coordI, result);
}
