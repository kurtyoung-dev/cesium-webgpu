// AerialPerspective — unified per-pixel atmospheric haze post-process.
//
// Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS). Applies a single,
// depth-correct atmosphere over the WHOLE composited scene (terrain, 3D
// tiles, glTF models, geometry) AFTER the opaque scene pass, replacing the
// per-tile ground-atmosphere drape with one consistent look. This is the
// "post-process lighting for the terrain" the Takram talk describes.
//
// For each pixel we:
//   1. Recover the eye-space distance from the (log-depth) scene depth
//      buffer — `csm_reverseLogDepthToEyeDistance`, the renderer-wide
//      log-depth contract (CLAUDE.md). Sky pixels (depth at/near the far
//      plane) get no haze so the sky/atmosphere shell shows through.
//   2. Reconstruct the world-space fragment position from the camera world
//      position + the per-pixel world-space view ray × distance. In ECEF
//      the ellipsoid centre is the world origin, so altitude is simply
//      `length(positionWC) - innerRadius`.
//   3. EXTINCTION — multiply the scene colour by the atmospheric
//      transmittance from the camera to the fragment. Sampled from the
//      Bruneton TRANSMITTANCE LUT (altitude × cosZenith), which is a sound,
//      sun-independent optical-depth table. Distant terrain dims + reddens
//      exactly like real aerial perspective.
//   4. INSCATTER — add the single-scattered sky radiance along the
//      camera→fragment ray. Computed ANALYTICALLY here (a short Rayleigh +
//      Mie march with the HG phase against the sun) rather than from the
//      single-inscatter LUT: that LUT bakes the world-space sun into a
//      synthetic Y-up frame and cannot represent the view–sun azimuth
//      (see WebGPUSkyAtmosphereRenderer.js ENABLE_SKY_INSCATTER_LUT = false
//      / DEFERRED_WORK NEW-ATMOSPHERE-LUT-SUN-RELATIVE). The analytic march
//      is the parity port of WebGL's czm_computeScattering /
//      computeAtmosphereColor (AtmosphereCommon.glsl), so the haze colour +
//      sun-relative brightening match the WebGL ground-atmosphere look.
//
// Composition: this pass is the SINGLE owner of distance haze on the
// WebGPU backend when enabled. The in-globe GlobeTerrain.wgsl ground-
// atmosphere/fog drape must be gated OFF while this runs to avoid double-
// applying (see WebGPUAerialPerspectiveEffect.ts header + the scene
// `aerialPerspective` flag). Reuses the camera RTE world position so the
// reconstruction stays 64-bit-stable near the surface.
//
// References:
//   - Eric Bruneton & Fabrice Neyret, "Precomputed Atmospheric Scattering"
//     (EGSR 2008) — transmittance LUT parameterization. Technique
//     reimplemented from the paper, not copied from any GPL/BSD source.
//   - Takram `three-geospatial` (MIT) `AerialPerspectiveEffect` — the
//     transmittance×color + inscatter post-process structure. Credited per
//     migration_doc/RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md (technique only).
//   - CesiumJS AtmosphereCommon.glsl computeScattering / computeAtmosphereColor
//     — the analytic single-scatter march this inscatter term ports.

const PI: f32 = 3.141592653589793;
// Analytic inscatter march step count. Modest — this runs per screen pixel
// every frame, and the haze is a smooth low-frequency term, so a coarse
// march is visually sufficient. WebGL uses 4..16 adaptive primary steps.
const INSCATTER_STEPS: u32 = 10u;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct AerialUniforms {
  // Camera world position (ECEF, relative to ellipsoid centre = origin). xyz;
  // .w = innerRadius (ellipsoid max radius, metres).
  cameraPositionWC: vec4<f32>,
  // Sun direction in world coordinates (normalized). xyz; .w = atmosphere
  // light intensity.
  sunDirectionWC: vec4<f32>,
  // Rayleigh scattering coefficient (per-metre, RGB). .w = rayleigh scale height.
  rayleighCoefficient: vec4<f32>,
  // Mie scattering coefficient (per-metre, RGB). .w = mie scale height.
  mieCoefficient: vec4<f32>,
  // .x = mie anisotropy g, .y = near, .z = far, .w = atmosphere thickness (m).
  params0: vec4<f32>,
  // .x = haze intensity (master multiplier 0..N, default 1),
  // .y = inscatter intensity scale,
  // .z = Item 2.2 (ENV-AERIAL-MS, Batch 430) useMultiScatterLut flag — when
  //      > 0.5 the in-scatter term is sourced from the sun-relative sky-view
  //      LUT (+ MS LUT add), the SAME tables the visible SkyAtmosphere samples,
  //      so the haze color matches the visible MS sky. When <= 0.5 (default)
  //      the analytic single-scatter march below runs verbatim (byte-identical
  //      parity). (Replaces the prior unused-reserve=1 slot.)
  // .w = sky-depth cutoff fraction (depths >= far*this are sky → skipped).
  params1: vec4<f32>,
  // Inverse projection — recovers the EYE-space ray direction for a pixel
  // from its NDC. We deliberately build the world ray as
  // `inverseViewRotation × eyeRayDir` rather than reconstructing world
  // positions from a full inverse-view-projection: at Earth scale (~6.4e6 m)
  // the `pFar - pNear` difference of two huge FP32 vectors suffers
  // catastrophic cancellation and yields a garbage (NaN-prone) ray. The
  // rotation-of-a-direction path stays unit-precise.
  inverseProjection: mat4x4<f32>,
  // Inverse view ROTATION (eye→world). Only the upper-left 3×3 is used; the
  // translation column is ignored (the camera world position is supplied
  // separately via cameraPositionWC).
  inverseViewRotation: mat4x4<f32>,
  // ── Batch 437 (CLOUD-SHADOWS): sun-view beer shadow map projection ──
  // `cloudShadowVP` maps a WORLD (ECEF) fragment position into the sun's ortho
  // clip space; the FS reads the cloud OPTICAL DEPTH column from `cloudShadowTex`
  // (binding 7) and ATTENUATES the inscatter by transmittance = exp(-depth·
  // absorption) so the air-light dims under the clouds. `cloudShadowControl`:
  // x = enabled (1.0 when globe.cloudCastShadows + a real map rendered), y =
  // absorption, z = strength, w = reserved. Appended add-only; (identity, 0,0,0,0)
  // by default → the FS gate (`x > 0.5`) stays closed → byte-identical.
  cloudShadowVP: mat4x4<f32>,
  cloudShadowControl: vec4<f32>,
  // Batch 438 (4.5 SKY-OZONE) — ozone Chappuis-band absorption coefficient
  // (per-metre). xyz = RGB coefficient; w = enabled (1.0 when skyAtmosphere.ozone
  // is on AND aerial perspective is active). Pure absorber added to the analytic
  // march's extinction term so the distance-haze extinction matches the visible
  // sky's ozone deepening. Appended add-only; default (0,0,0,0) → exp(-0) =
  // identity → byte-identical when ozone is off.
  ozoneCoefficient: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var transmittanceTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: AerialUniforms;
// Batch 437 (CLOUD-SHADOWS) — sun-view beer shadow map (binding 7). Bound
// UNCONDITIONALLY (1×1 zero placeholder when globe.cloudCastShadows is off →
// transmittance 1, no attenuation) so the layout never forks. Reuses `texSampler`
// (linear clamp). Sampled only inside the `cloudShadowControl.x > 0.5` gate.
@group(0) @binding(7) var cloudShadowTex: texture_2d<f32>;
// Item 2.2 (ENV-AERIAL-MS, Batch 430). Sun-relative sky-view LUT (256x128) +
// multiple-scattering LUT (256x128) — the SAME tables the visible
// SkyAtmosphere samples (baked by AtmosphereLUT.wgsl computeSkyView /
// computeMultipleScattering). Bound UNCONDITIONALLY so the bind-group layout
// never changes; the effect binds the white 1x1 transmittance placeholder to
// these slots until the real LUTs arrive, and the `useMultiScatterLut` flag
// (params1.z) keeps them unsampled (passthrough to the analytic march) when off
// → byte-identical parity.
@group(0) @binding(5) var skyViewTex: texture_2d<f32>;
@group(0) @binding(6) var multipleScatterTex: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

// Reverse the renderer-wide logarithmic depth to a positive eye-space
// distance (metres). Byte-compatible with csm_reverseLogDepthToEyeDistance
// (csm_reverseLogDepth.wgsl) — inlined here so the post-process shader has
// no chunk-include dependency.
fn logDepthToEyeDistance(logZ: f32, near: f32, far: f32) -> f32 {
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  return depthFromNear + near;
}

// Ray-sphere intersection from `origin` along unit `dir`. Returns
// (tNear, tFar); .y < 0 means no forward hit. Used for the analytic
// inscatter march (atmosphere shell) + sun-ray optical depth.
fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let s = sqrt(disc);
  return vec2<f32>(-b - s, -b + s);
}

fn rayleighPhase(cosAngle: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosAngle * cosAngle);
}

fn miePhase(cosAngle: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosAngle;
  return (1.0 - g2) / (4.0 * PI * pow(max(denom, 1e-4), 1.5));
}

// Batch 438 (4.5 SKY-OZONE) — ozone tent-profile relative density (matches
// AtmosphereLUT.wgsl / SkyAtmosphere.wgsl exactly: peak 1.0 at 25 km, 0 at 10/40
// km). Pure absorber; supplies the unit-less density, the per-metre coefficient
// supplies the magnitude.
fn ozoneDensity(height: f32) -> f32 {
  let center = 25000.0;
  let halfWidth = 15000.0;
  return max(0.0, 1.0 - abs(height - center) / halfWidth);
}

// Sample the transmittance LUT for the optical path from a point at
// `altitude` (metres above the inner radius) looking along `cosZenith`
// (cos of angle between the ray and local up) to the top of atmosphere.
// Mirrors AtmosphereLUT.wgsl computeTransmittance's UV layout exactly:
//   u = (cosZenith + 1) / 2 ,  v = altitude / thickness .
fn sampleTransmittance(altitude: f32, cosZenith: f32) -> vec3<f32> {
  let thickness = uniforms.params0.w;
  let u = clamp(cosZenith * 0.5 + 0.5, 0.0, 1.0);
  let v = clamp(altitude / max(thickness, 1.0), 0.0, 1.0);
  return textureSampleLevel(transmittanceTex, texSampler, vec2<f32>(u, v), 0.0).rgb;
}

// Batch 437 (CLOUD-SHADOWS) — sample the sun-view beer shadow map at a WORLD
// (ECEF) position and return the cloud transmittance (0..1) used to attenuate the
// inscatter under the clouds. Returns 1.0 (no attenuation) outside the shadow-map
// footprint. Only called inside the `cloudShadowControl.x > 0.5` gate, so the
// placeholder is never read on the default path. Mirrors GlobeTerrain's
// `sampleCloudGroundShadow` (same projection + Beer-Lambert + 0.35 floor) so the
// ground shadow and the air-light dimming agree.
fn sampleCloudInscatterShadow(worldPos: vec3<f32>) -> f32 {
  let clip = uniforms.cloudShadowVP * vec4<f32>(worldPos, 1.0);
  let ndc = clip.xyz / max(abs(clip.w), 1e-6);
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 1.0;
  }
  let opticalDepth = textureSampleLevel(cloudShadowTex, texSampler, uv, 0.0).r;
  let absorption = uniforms.cloudShadowControl.y;
  let strength = uniforms.cloudShadowControl.z;
  let transmittance = max(exp(-opticalDepth * absorption), 0.35);
  return mix(1.0, transmittance, clamp(strength, 0.0, 1.0));
}

// Item 2.2 (ENV-AERIAL-MS, Batch 430) — sample the sun-relative sky-view LUT.
// COPIED VERBATIM (same UV/basis derivation) from SkyAtmosphere.wgsl's
// `sampleSkyViewLut` so the aerial haze color agrees with the visible sky:
//   U = relativeAzimuth(rayDir, sunDir) / π   (sky symmetric about the sun
//       meridian → [0, π] covers all azimuths)
//   V = 0.5 + 0.5 * sign(cosViewZenith) * sqrt(|cosViewZenith|)  (Hillaire warp)
// `up` is the local vertical at the camera; `rayDir`/`sunDir` are unit world
// vectors. Returns the baked combined Rayleigh+Mie inscatter (intensity already
// applied at bake time).
fn sampleSkyViewLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(
    0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)),
    0.0,
    1.0,
  );
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(skyViewTex, texSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Item 2.2 — sample the multiple-scattering LUT (same sun-relative sky-view
// domain). Identical (U, V) derivation to sampleSkyViewLut so the MS add agrees
// directionally with the single-scatter sky-view sample.
fn sampleMultipleScatterLut(up: vec3<f32>, rayDir: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  let vCoord = clamp(
    0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)),
    0.0,
    1.0,
  );
  let viewHoriz = rayDir - up * cosViewZenith;
  let sunHoriz = sunDir - up * dot(sunDir, up);
  let vhLen = length(viewHoriz);
  let shLen = length(sunHoriz);
  var cosRelAzimuth: f32 = 1.0;
  if (vhLen > 1e-4 && shLen > 1e-4) {
    cosRelAzimuth = clamp(dot(viewHoriz, sunHoriz) / (vhLen * shLen), -1.0, 1.0);
  }
  let relAzimuth = acos(cosRelAzimuth); // [0, π]
  let uCoord = clamp(relAzimuth * (1.0 / PI), 0.0, 1.0);
  let s = textureSampleLevel(multipleScatterTex, texSampler, vec2<f32>(uCoord, vCoord), 0.0);
  return max(s.rgb, vec3<f32>(0.0));
}

// Mirror of SkyAtmosphere.wgsl's MS_SCALE — the perceptual on-screen strength
// of the MS add. Same constant so the aerial haze matches the visible sky.
const MS_SCALE: f32 = 0.06;

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let sceneColor = textureSampleLevel(sceneColorTex, texSampler, uv, 0.0);

  let near = uniforms.params0.y;
  let far = uniforms.params0.z;
  let innerRadius = uniforms.cameraPositionWC.w;
  let thickness = uniforms.params0.w;
  let outerRadius = innerRadius + thickness;
  let skyCutoff = uniforms.params1.w;
  let hazeIntensity = uniforms.params1.x;
  let inscatterScale = uniforms.params1.y;

  let rawDepth = textureSampleLevel(sceneDepthTex, texSampler, uv, 0.0).r;

  // Sky pixels: depth at/beyond the far-plane fraction. No aerial perspective
  // — the sky / atmosphere shell already carries its own colour, and applying
  // ground-relative haze to it would darken the limb (double-apply). Pass
  // the scene colour straight through.
  if (rawDepth >= skyCutoff) {
    return sceneColor;
  }

  // Eye-space distance along the view ray (metres). Clamp away from zero so
  // the near-field pixels don't divide by tiny lengths.
  let eyeDistance = max(logDepthToEyeDistance(rawDepth, near, far), 1.0);

  // World-space view ray. Recover the EYE-space ray direction from NDC via
  // the inverse projection, then rotate it to world with the inverse-view
  // rotation. Rotating a unit direction is FP32-precise; reconstructing two
  // Earth-scale world positions and subtracting them is NOT (see the
  // inverseProjection field comment).
  // Use the NEAR plane (WebGPU clip-z = 0) for the eye-ray reconstruction:
  // the projection here is near-at-0.1 with an INFINITE far plane, so the
  // far-plane row (clip-z = 1) maps to w ≈ 0 — dividing by it blows up /
  // NaNs. The near plane gives a well-conditioned w. The eye-space ray
  // direction through the near point is the same direction we march along.
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
  let eyeH = uniforms.inverseProjection * vec4<f32>(ndc, 0.0, 1.0);
  let eyeDir = normalize(eyeH.xyz / eyeH.w);
  // inverseViewRotation upper-left 3×3 applied to the eye-space direction.
  let rayDir = normalize(
    (uniforms.inverseViewRotation * vec4<f32>(eyeDir, 0.0)).xyz
  );

  let cameraWC = uniforms.cameraPositionWC.xyz;
  // Fragment world position along the ray at the recovered eye distance.
  let fragWC = cameraWC + rayDir * eyeDistance;

  let camR = max(length(cameraWC), innerRadius);

  // ── EXTINCTION + INSCATTER via one analytic single-scatter march ──
  // The camera→fragment transmittance is computed DIRECTLY from the optical
  // depth accumulated along that exact segment (`exp(-(βR·ODr + βM·ODm))`),
  // NOT from a ratio of the transmittance LUT's path-to-TOA values: for a
  // horizontal / downward view ray both endpoints have a near-opaque path to
  // the top of atmosphere, so a LUT-ratio collapses to a meaningless ~0/0 and
  // blacks the scene. The marched optical depth is physically exact for the
  // segment and self-consistent with the inscatter accumulated below. The
  // transmittance LUT stays bound (group 0, binding 2) for the sun-radiance /
  // derived-lighting follow-on (Track V-A3) and to keep the layout stable;
  // `sampleTransmittance` is the entry point those passes will use.
  //
  // INSCATTER — parity port of computeScattering (AtmosphereCommon.glsl):
  // march the camera→fragment segment, accumulate Rayleigh + Mie in-scattered
  // light attenuated by the optical depth back to the camera and out to the
  // sun.
  let sunDir = uniforms.sunDirectionWC.xyz;
  let lightIntensity = uniforms.sunDirectionWC.w;
  let rayleighCoeff = uniforms.rayleighCoefficient.xyz;
  let mieCoeff = uniforms.mieCoefficient.xyz;
  let rayleighScaleH = uniforms.rayleighCoefficient.w;
  let mieScaleH = uniforms.mieCoefficient.w;
  let mieG = uniforms.params0.x;

  // March only within the atmosphere shell + within the eye distance. Start
  // at the camera (or the camera's entry into the shell, if above it).
  let camToTop = raySphereIntersect(cameraWC, rayDir, outerRadius);
  var marchStart = 0.0;
  if (camR > outerRadius) {
    // Camera above the atmosphere — begin at the shell entry.
    marchStart = max(camToTop.x, 0.0);
  }
  let marchEnd = min(eyeDistance, max(camToTop.y, 0.0));
  let segment = max(marchEnd - marchStart, 0.0);

  var rayleighAccum = vec3<f32>(0.0);
  var mieAccum = vec3<f32>(0.0);
  var rOpticalDepth = 0.0;
  var mOpticalDepth = 0.0;
  // Batch 438 (4.5 SKY-OZONE) — ozone extinction along the camera→fragment
  // segment. Gated by ozoneCoefficient.w; default 0 → identity.
  let ozoneEnabled = uniforms.ozoneCoefficient.w > 0.5;
  let ozoneCoeff = select(vec3<f32>(0.0), uniforms.ozoneCoefficient.xyz, ozoneEnabled);
  var oOpticalDepth = 0.0;

  if (segment > 0.0) {
    let stepLen = segment / f32(INSCATTER_STEPS);
    for (var i = 0u; i < INSCATTER_STEPS; i = i + 1u) {
      let t = marchStart + (f32(i) + 0.5) * stepLen;
      let samplePos = cameraWC + rayDir * t;
      let h = max(length(samplePos) - innerRadius, 0.0);

      let rDensity = exp(-h / rayleighScaleH) * stepLen;
      let mDensity = exp(-h / mieScaleH) * stepLen;
      rOpticalDepth = rOpticalDepth + rDensity;
      mOpticalDepth = mOpticalDepth + mDensity;
      oOpticalDepth = oOpticalDepth + ozoneDensity(h) * stepLen;

      // Optical depth from the sample to the sun (to the top of atmosphere).
      let sunHit = raySphereIntersect(samplePos, sunDir, outerRadius);
      if (sunHit.y > 0.0) {
        let sunLen = sunHit.y;
        let lightSteps = 4u;
        let lightStep = sunLen / f32(lightSteps);
        var rSunOD = 0.0;
        var mSunOD = 0.0;
        var oSunOD = 0.0;
        for (var j = 0u; j < lightSteps; j = j + 1u) {
          let lp = samplePos + sunDir * (f32(j) + 0.5) * lightStep;
          let lh = max(length(lp) - innerRadius, 0.0);
          rSunOD = rSunOD + exp(-lh / rayleighScaleH) * lightStep;
          mSunOD = mSunOD + exp(-lh / mieScaleH) * lightStep;
          oSunOD = oSunOD + ozoneDensity(lh) * lightStep;
        }
        let attenuation = exp(
          -(rayleighCoeff * (rOpticalDepth + rSunOD) +
            mieCoeff * (mOpticalDepth + mSunOD) +
            ozoneCoeff * (oOpticalDepth + oSunOD))
        );
        rayleighAccum = rayleighAccum + rDensity * attenuation;
        mieAccum = mieAccum + mDensity * attenuation;
      }
    }
  }

  let cosAngle = dot(rayDir, sunDir);
  let rPhase = rayleighPhase(cosAngle);
  let mPhase = miePhase(cosAngle, mieG);
  let rayleighColor = rayleighCoeff * rayleighAccum * rPhase;
  let mieColor = mieCoeff * mieAccum * mPhase;
  // Analytic single-scatter in-scatter (default / parity path).
  let analyticInscatter =
    (rayleighColor + mieColor) * lightIntensity * inscatterScale * hazeIntensity;

  // Item 2.2 (ENV-AERIAL-MS, Batch 430) — in-scatter source select. OFF
  // (params1.z <= 0.5, default): the analytic march result verbatim →
  // byte-identical. ON: source the in-scattered sky radiance from the
  // sun-relative sky-view LUT (+ MS add) — the SAME tables the visible
  // SkyAtmosphere samples — so the distance haze color matches the visible MS
  // sky (richer, directional, off-meridian-correct). The LUT already carries
  // the atmosphere intensity at bake time, so we do NOT re-multiply
  // `lightIntensity` (that would double-apply it); we DO carry the
  // `inscatterScale * hazeIntensity` master + a distance ramp so near-field
  // pixels stay clear and distant pixels approach the full sky radiance,
  // matching the analytic term's grow-with-distance shape. `up` is the local
  // vertical at the camera (the LUT's ground-observer convention); `rayDir` +
  // `sunDir` give the azimuth.
  var inscatter = analyticInscatter;
  if (uniforms.params1.z > 0.5) {
    let up = normalize(cameraWC);
    let lutSky = sampleSkyViewLut(up, rayDir, sunDir);
    let lutMs = sampleMultipleScatterLut(up, rayDir, sunDir);
    // Distance ramp: 0 at the camera → 1 across one atmosphere thickness, so
    // the haze builds up with distance like the marched term (which grows with
    // the in-scattered segment length) rather than slamming the full sky color
    // onto every pixel.
    let distanceRamp = clamp(segment / max(thickness, 1.0), 0.0, 1.0);
    inscatter = (lutSky + lutMs * MS_SCALE)
              * (inscatterScale * hazeIntensity * distanceRamp);
  }

  // Batch 437 (CLOUD-SHADOWS) — attenuate the inscatter (air light) where the
  // fragment sits under the procedural clouds. Project `fragWC` into the sun-view
  // beer shadow map and scale the inscatter by the cloud transmittance, so the
  // distance haze dims under the clouds like real shadowed air. Gated so the
  // default (globe.cloudCastShadows off) leaves `inscatter` untouched → byte-
  // identical (the placeholder is never read).
  if (uniforms.cloudShadowControl.x > 0.5) {
    inscatter = inscatter * sampleCloudInscatterShadow(fragWC);
  }

  // Camera→fragment transmittance from the marched optical depth (Beer-
  // Lambert over exactly the segment we in-scattered along). Distant pixels
  // accumulate more optical depth → lower transmittance → dimmer + redder.
  let extinction = exp(
    -(rayleighCoeff * rOpticalDepth + mieCoeff * mOpticalDepth +
      ozoneCoeff * oOpticalDepth)
  );
  // Blend extinction strength by the master haze intensity (0 → no dimming,
  // 1 → full physical extinction).
  let transmittance = mix(vec3<f32>(1.0), extinction, hazeIntensity);

  // Compose: extinction × scene + additive inscatter. This is the standard
  // aerial-perspective composite (== WebGL's `color * T + inscatter`).
  let outColor = sceneColor.rgb * transmittance + inscatter;
  return vec4<f32>(outColor, sceneColor.a);
}
