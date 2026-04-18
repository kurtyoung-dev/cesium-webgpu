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
fn froxelWorldPosition(gid: vec3<u32>) -> vec3<f32> {
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
  return u.cameraAndPlanet.xyz + rayDir * linearDepth;
}

// Henyey-Greenstein phase function. cosθ is dot(viewDir, lightDir).
fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1e-4), 1.5));
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

  // Sun contribution. The shadow factor cuts the sun term to zero
  // (or to `darkness × sunTerm`) inside terrain shadow volumes,
  // producing visible god rays where the lit and shadowed regions
  // meet at high density gradient.
  let sunDir = u.sunDirectionAndIntensity.xyz;
  let sunIntensity = u.sunDirectionAndIntensity.w;
  let cosThetaSun = dot(viewDir, sunDir);
  let phaseSun = henyeyGreenstein(cosThetaSun, g);
  let sunScatter = sunIntensity * phaseSun * sunShadowFactor;

  // Moon contribution. The .w slot is already (phase × intensity), so
  // a new moon (phase=0) zeroes the moon term naturally — no extra
  // branch needed. Phase 5c does NOT sample a moon shadow map (the
  // moon is dim enough that shadow precision wouldn't be visible);
  // a future Phase 5e could add it if motivated.
  let moonDir = u.moonDirectionAndScale.xyz;
  let moonScale = u.moonDirectionAndScale.w;
  let cosThetaMoon = dot(viewDir, moonDir);
  let phaseMoon = henyeyGreenstein(cosThetaMoon, g);
  let moonScatter = moonScale * phaseMoon;

  // Phase 5c — ambient term. Without this, occlusion-cut shadow
  // volumes become hard-edged + over-dark. Real engines sample the
  // atmosphere inscatter LUT at (altitude, up direction) to get a
  // physically motivated ambient color (Hillaire 2020 / Frostbite).
  // For now we use a simple constant tinted by the fog albedo so
  // shadowed froxels still receive a soft fill.
  // Future Phase 5e can swap this for an actual LUT sample once the
  // SkyAtmosphere LUT views are wired through to this renderer.
  let ambientStrength = u.occlusion.y;
  let ambientTerm = ambientStrength;

  // In-scattered radiance per unit length:
  //   direct contribution = albedo × density × (sun + moon scatter)
  //   ambient contribution = albedo × density × ambient
  let scatteredRGB =
    albedo * density * (sunScatter + moonScatter + ambientTerm);

  // Pack scatter + density. The integrate pass uses density to compute
  // extinction, and the scatter directly for the alpha-over composite.
  textureStore(
    scatteringOut,
    vec3<i32>(gid),
    vec4<f32>(scatteredRGB, density),
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

  // Pre-compute the previous slice's depth so we can take the slice
  // thickness for extinction. The first slice spans (near, depth(1)).
  var prevDepth = u.scattering.x; // near plane

  for (var k: u32 = 0u; k < depthCount; k = k + 1u) {
    let coord = vec3<i32>(i32(gid.x), i32(gid.y), i32(k));
    let s = textureLoad(scatteringIn, coord);
    let scattered = s.rgb;
    let density = s.a;

    let curDepth = sliceToLinearDepth(f32(k) + 1.0, res.z);
    let sliceThickness = max(curDepth - prevDepth, 0.0);
    prevDepth = curDepth;

    let extinction = max(density * sliceThickness, 0.0);
    let sliceTransmittance = exp(-extinction);

    // Standard Beer-Lambert front-to-back integration. The
    // `(1 - sliceTransmittance) / extinction` factor handles the
    // case where extinction → 0 (gives the limit, which is the slice
    // thickness — no division blow-up).
    let scatterIntegral = select(
      scattered * sliceThickness,
      scattered * (1.0 - sliceTransmittance) / max(extinction, 1e-6),
      extinction > 1e-6,
    );
    accumScattered = accumScattered + transmittance * scatterIntegral;
    transmittance = transmittance * sliceTransmittance;

    textureStore(
      integratedOut,
      coord,
      vec4<f32>(accumScattered, transmittance),
    );
  }
}
