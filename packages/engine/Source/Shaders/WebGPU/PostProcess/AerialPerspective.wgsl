// AerialPerspective — unified per-pixel atmospheric haze post-process.
//
// Applies a single, depth-correct atmosphere over the whole composited scene —
// terrain, 3D tiles, glTF models, geometry — after the opaque scene pass,
// replacing the per-tile ground-atmosphere drape with one consistent look.
//
// For each pixel:
//   1. Recover the eye-space distance from the log-depth scene depth buffer
//      through `csm_reverseLogDepthToEyeDistance`, the renderer-wide log-depth
//      contract. Sky pixels, at or near the far plane, get no haze so the
//      sky/atmosphere shell shows through.
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
//      (see WebGPUSkyAtmosphereRenderer.js ENABLE_SKY_INSCATTER_LUT = false).
//      The analytic march
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
//   - Shota Matsuda, Takram — `three-geospatial` (MIT),
//     https://github.com/takram-design-engineering/three-geospatial — the
//     `AerialPerspectiveEffect` structure this follows: transmittance times
//     scene colour, plus an inscatter term, applied as one fullscreen pass
//     over the composited frame. Technique only; no source was copied.
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
  // .z = useMultiScatterLut flag — above 0.5 the in-scatter term is sourced
  //      from the sun-relative sky-view LUT plus the multiple-scattering LUT,
  //      the same tables the visible SkyAtmosphere samples, so the haze
  //      colour matches the visible sky. At or below 0.5, the default, the
  //      analytic single-scatter march below runs instead.
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
  // Sun-view beer shadow map. `cloudShadowVP` is
  // `worldToSunClip * translate(camera)`: the shared cloud-shadow frame owner
  // cancels the planet-scale translation in CPU f64, so this stage projects
  // the fragment's camera-relative offset rather than a full ECEF position.
  // It reads the cloud optical-depth column from `cloudShadowTex` at binding
  // 7 and attenuates the inscatter by `exp(-depth * absorption)`, so the air
  // light dims under the clouds. `cloudShadowControl`:
  // x = enabled (1.0 when globe.cloudCastShadows is set and a real map
  // rendered), y = absorption, z = strength, w = reserved. Defaults to
  // (identity, 0,0,0,0), which keeps the `x > 0.5` gate closed.
  cloudShadowVP: mat4x4<f32>,
  cloudShadowControl: vec4<f32>,
  // Ozone Chappuis-band absorption coefficient, per metre. xyz is the RGB
  // coefficient; w is 1.0 when `skyAtmosphere.ozone` is on and aerial
  // perspective is active. A pure absorber added to the analytic march's
  // extinction term, so the distance-haze extinction matches the visible
  // sky's ozone deepening. The default (0,0,0,0) makes `exp(-0)` an identity.
  ozoneCoefficient: vec4<f32>,
  // Item 2.3 (AERIAL-FROXEL, Batch Q23) — aerial-perspective froxel LUT gate.
  // x = enabled (> 0.5 → replace the analytic per-pixel march with ONE trilinear
  //     fetch of the pre-baked 32³ froxel volume, binding 8),
  // y = froxel max distance (m) — the distance the last froxel slice covers
  //     (squared slice distribution), used to invert the slice coordinate,
  // z, w = reserved. Appended add-only; default (0,0,0,0) → the analytic march
  // runs verbatim → byte-identical parity when the froxel path is off.
  froxelParams: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var transmittanceTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: AerialUniforms;
// Sun-view beer shadow map at binding 7. Bound unconditionally — a 1×1 zero
// placeholder reading as transmittance 1 when `globe.cloudCastShadows` is off
// — so the layout never forks. Reuses `texSampler`, a linear clamp. Sampled
// only inside the `cloudShadowControl.x > 0.5` gate.
@group(0) @binding(7) var cloudShadowTex: texture_2d<f32>;
// Sun-relative sky-view LUT (256x128) and multiple-scattering LUT (256x128):
// the same tables the visible SkyAtmosphere samples, baked by
// `AtmosphereLUT.wgsl`'s `computeSkyView` and `computeMultipleScattering`.
// Bound unconditionally so the bind-group layout never changes; the effect
// binds the white 1x1 transmittance placeholder to these slots until the real
// LUTs arrive, and the `useMultiScatterLut` flag at `params1.z` keeps them
// unsampled while it is off, passing through to the analytic march.
@group(0) @binding(5) var skyViewTex: texture_2d<f32>;
@group(0) @binding(6) var multipleScatterTex: texture_2d<f32>;
// Item 2.3 (AERIAL-FROXEL, Batch Q23) — the 32³ aerial-perspective froxel volume
// (rgb = accumulated inscatter, a = mean transmittance) baked once per frame by
// AerialPerspectiveFroxel.wgsl. Bound UNCONDITIONALLY (1×1×1 placeholder when the
// froxel path is off) so the layout never forks; sampled only inside the
// `froxelParams.x > 0.5` gate → byte-identical parity when off. Reuses
// `texSampler` (linear clamp) for the trilinear fetch.
@group(0) @binding(8) var froxelTex: texture_3d<f32>;

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

// Ozone tent-profile relative density, matching `AtmosphereLUT.wgsl` and
// `SkyAtmosphere.wgsl` exactly: peak 1.0 at 25 km, zero at 10 and 40 km. A
// pure absorber. This supplies the unit-less density; the per-metre
// coefficient supplies the magnitude.
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

// Sample the sun-view beer shadow map at a camera-relative position and
// return the cloud transmittance in [0,1] used to attenuate the inscatter
// under the clouds. Returns 1.0, no attenuation, outside the shadow map's
// footprint. Only called inside the `cloudShadowControl.x > 0.5` gate, so the
// placeholder is never read on the default path. Mirrors GlobeTerrain's
// `sampleCloudGroundShadow` — same projection, same Beer-Lambert, same 0.35
// floor — so the ground shadow and the air-light dimming agree.
//
// `cloudShadowVP` is `worldToSunClip * translate(camera)`, emitted by the
// shared frame owner in CPU f64. Its operand is therefore the fragment's
// offset from the camera, `rayDir * eyeDistance`, which this shader already
// forms, rather than the full-ECEF `fragWC`. That is what keeps the
// planet-scale `mvp * vec4(position, 1.0)` product out of the shader, as the
// relative-to-eye precision law requires.
fn sampleCloudInscatterShadow(offsetFromCamera: vec3<f32>) -> f32 {
  let clip = uniforms.cloudShadowVP * vec4<f32>(offsetFromCamera, 1.0);
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

// Sample the sun-relative sky-view LUT. The UV and basis derivation is the
// same one `SkyAtmosphere.wgsl`'s `sampleSkyViewLut` uses, so the aerial haze
// colour agrees with the visible sky:
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
  // Fragment offset from the camera along the ray at the recovered eye distance.
    // The cloud-shadow projection takes this camera-relative vector as its
    // operand; the absolute position below stays for the atmospheric march.
  let fragOffsetWC = rayDir * eyeDistance;
  // Fragment world position along the ray at the recovered eye distance.
  let fragWC = cameraWC + fragOffsetWC;

  let camR = max(length(cameraWC), innerRadius);

  // Item 2.3 (AERIAL-FROXEL, Batch Q23) — froxel fast path
  // When enabled, replace the entire analytic per-pixel march below with ONE
  // trilinear fetch of the pre-baked 32³ froxel volume. The froxel column
  // aligns with this pixel's screen UV; the slice coordinate inverts the bake's
  // squared distance distribution (`w = sqrt(eyeDistance / maxDistance)`). The
  // volume stores inscatter (rgb) + mean transmittance (a) already scaled by the
  // haze intensity / inscatter scale at bake time, so the composite is the same
  // `scene·T + inscatter` shape as the analytic path. Cloud-shadow attenuation
  // (if active) still applies to the fetched inscatter. Default off → this whole
  // block is skipped and the analytic march runs verbatim (byte-identical).
  if (uniforms.froxelParams.x > 0.5) {
    let maxDistanceF = max(uniforms.froxelParams.y, 1.0);
    let wCoord = sqrt(clamp(eyeDistance / maxDistanceF, 0.0, 1.0));
    let ap = textureSampleLevel(
      froxelTex, texSampler, vec3<f32>(uv.x, uv.y, wCoord), 0.0
    );
    var froxelInscatter = ap.rgb;
    if (uniforms.cloudShadowControl.x > 0.5) {
      froxelInscatter = froxelInscatter * sampleCloudInscatterShadow(fragOffsetWC);
    }
    let froxelColor = sceneColor.rgb * ap.a + froxelInscatter;
    return vec4<f32>(froxelColor, sceneColor.a);
  }

  // EXTINCTION + INSCATTER via one analytic single-scatter march
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
    // Ozone extinction along the camera-to-fragment segment, gated by
    // `ozoneCoefficient.w`, whose default of 0 makes this an identity.
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

    // In-scatter source select. At or below 0.5, the default, `params1.z`
    // keeps the analytic march result. Above it, the in-scattered sky radiance
    // comes from the sun-relative sky-view LUT plus the multiple-scattering
    // add — the same tables the visible SkyAtmosphere samples — so the
    // distance haze colour matches the visible sky, directionally and off the
    // sun meridian. The LUT already carries the atmosphere intensity from bake
    // time, so `lightIntensity` must not be re-multiplied here or it applies
    // twice. What does carry across is the
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

    // Attenuate the inscatter, the air light, where the fragment sits under
    // the procedural clouds: project `fragWC` into the sun-view beer shadow
    // map and scale the inscatter by the cloud transmittance, so the distance
    // haze dims under the clouds the way shadowed air does. Gated, so with
    // `globe.cloudCastShadows` off `inscatter` is untouched and the
    // placeholder is never read.
  if (uniforms.cloudShadowControl.x > 0.5) {
    inscatter = inscatter * sampleCloudInscatterShadow(fragOffsetWC);
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
