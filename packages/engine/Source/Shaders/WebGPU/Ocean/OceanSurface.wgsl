// OceanSurface.wgsl — displaced ocean surface patch for the FFT spectral
// ocean. A flat ENU grid patch anchored at the camera sub-point is displaced by
// the merged FFT displacement map (one 250 m cascade, resampled at several
// scales: see sampleMultiBandDisp) and shaded with an exact dielectric Fresnel
// reflection of an elevation-dependent sky, a Gordon-style in-scattering term,
// a refracted-column absorption ceiling when the eye is under the surface, and
// Jacobian foam. Positioning is relative-to-eye: the anchor is
// EncodedCartesian3-split into high and low halves and the vertex is
// transformed with mvpRelativeToEye, never an absolute f32 world position.
//
// Reference: displacement and normal reassembly follow gasgiant/FFT-Ocean (MIT)
// and Popov72/OceanDemo (MIT); see the Third-Party section of LICENSE.md. The
// relative-to-eye vertex path mirrors FlowFieldRender.wgsl.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  viewportSize: vec2<f32>,
  logDepthNearFar: vec2<f32>,
  encodedCameraHigh: vec3<f32>,
  logDepthFactor: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  previousViewProjection: mat4x4<f32>,
};

struct OceanUniforms {
  anchorHigh: vec3<f32>,
  _p0: f32,
  anchorLow: vec3<f32>,
  _p1: f32,
  east: vec3<f32>,
  patchExtent: f32,
  north: vec3<f32>,
  invRadius: f32,
  up: vec3<f32>,
  patchL: f32,
  sunDirection: vec3<f32>,
  foamStrength: f32,
  deepColor: vec3<f32>,
  waveFadeNear: f32,
  shallowColor: vec3<f32>,
  waveFadeFar: f32,
  uvOffset: vec2<f32>,
  texelSize: f32,
  detailScale: f32,
  // Celestial reflection controls. Every one of them is written as exactly
  // zero in the off position, so nothing the shader reads differs from what it
  // read before this tail existed and the fragment takes its historical branch.
  // The buffer itself is two vec4 longer either way; that allocation is the
  // whole cost of the feature while it is off.
  celestialEnable: f32,
  celestialRoughness: f32,
  celestialSunIntensity: f32,
  celestialSinAngularRadius: f32,
  // Unit direction to the Moon, or exactly zero when no Moon is being drawn
  // this frame. The zero vector needs no companion flag: it drives both the
  // glint's own horizon test and the rise gate to zero on its own.
  moonDirection: vec3<f32>,
  celestialMoonPhase: f32,
  celestialMoonIntensity: f32,
  celestialMoonSinAngularRadius: f32,
  // Seabed depth in metres (x, 0 when unknown) and Jerlov water type (y).
  bathymetry: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> ocean: OceanUniforms;
@group(0) @binding(2) var Displacement: texture_2d<f32>;
@group(0) @binding(3) var DisplacementSampler: sampler;

//>>ifdef LOG_DEPTH
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, factor: f32) -> f32 {
  return log2(depthFromNearPlusOne) * factor;
}
//>>endif

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) posRelEye: vec3<f32>,
  @location(2) fade: f32,
  //>>ifdef LOG_DEPTH
  @location(3) v_logDepth: f32,
  //>>endif
};

fn sampleDisp(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(Displacement, DisplacementSampler, uv, 0.0);
}

// Detail bands built from ONE 250 m FFT cascade: the Displacement texture is
// sampled at several scales and orientations and the samples are summed. These
// are scaled resamples, not spectral cascades.
// - band 0 (250 m, domain-warped): the cascade itself
// - sub band (0.276x, rotated): a slow low-frequency repeat breaker
// - band 1 (5.95238x, about 42 m, rotated +17 deg): intermediate chop
// - band 2 (35.714x, about 7 m, rotated -23 deg): fine wavelets
// The wavelengths shrink but the time evolution is still the 250 m spectrum's,
// so the smaller bands move at the wrong phase speed, and no spectrum was
// generated for them. Separate spectral cascades (L = 250 / 17 / 5) are still
// open work. The 7 m band is also displaced at the
// vertices, where the 5.25 m grid is above its Nyquist length, so that term
// aliases; its weight (0.045) keeps this mild.
fn evaluateOceanStochasticGroup(uv: vec2<f32>) -> vec3<f32> {
  let p0 = uv * 0.19098301;
  let p1 = vec2<f32>(uv.x * 0.11803399 - uv.y * 0.22360680, uv.x * 0.22360680 + uv.y * 0.11803399);
  let f = abs(fract(vec4<f32>(p0, p1)) * 2.0 - 1.0);
  let q = f * f * (3.0 - 2.0 * f) * 2.0 - 1.0;
  let warp = vec2<f32>(q.x * 0.62 + q.z * 0.38, q.y * 0.62 + q.w * 0.38);
  let env = mix(0.42, 1.34, clamp(0.5 + 0.32 * (q.x + q.w) + 0.22 * (q.y * q.z), 0.0, 1.0));
  return vec3<f32>(warp * 0.18, env);
}

fn sampleMultiBandDisp(uv: vec2<f32>, detailFade: f32) -> vec4<f32> {
  let sg = evaluateOceanStochasticGroup(uv);
  let warpedUv = uv + sg.xy;
  let groupEnv = sg.z;
  let uvSub = vec2<f32>(
    uv.x * 0.6180340 - uv.y * 0.7861514,
    uv.x * 0.7861514 + uv.y * 0.6180340,
  ) * 0.2763932 - sg.yx * 0.45 + vec2<f32>(0.19, 0.83);
  let dSub = sampleDisp(uvSub) * vec4<f32>(0.42, 0.38, 0.42, 0.28);
  let d0 = sampleDisp(warpedUv) * vec4<f32>(groupEnv, groupEnv, groupEnv, mix(0.65, 1.15, groupEnv));
  let uv1 = vec2<f32>(
    warpedUv.x * 0.9563047 - warpedUv.y * 0.2923717,
    warpedUv.x * 0.2923717 + warpedUv.y * 0.9563047,
  ) * 5.95238 + vec2<f32>(0.37, 0.61);
  let d1 = sampleDisp(uv1) * vec4<f32>(0.22, 0.24, 0.22, 0.45) * (0.35 + 0.65 * detailFade) * groupEnv;
  if (detailFade <= 1.0e-3) {
    return d0 + dSub + d1;
  }
  let uv2 = vec2<f32>(
    warpedUv.x * 0.9205048 + warpedUv.y * 0.3907311,
    -warpedUv.x * 0.3907311 + warpedUv.y * 0.9205048,
  ) * 35.714 + vec2<f32>(0.73, 0.19);
  let d2 = sampleDisp(uv2) * vec4<f32>(0.045, 0.055, 0.045, 0.30) * detailFade;
  return d0 + dSub + d1 + d2;
}

// Analytical Lord Kelvin 19.47 deg (arcsin(1/3), tan(alpha) ~= 0.35355) vessel V-wake
// and turbulent stern propeller wash evaluated in local ENU meters.
//
// NOT CALLED (deferred, CI-01). The previous revision displaced every enabled
// ocean by this wake at a hard-coded origin (85, 140) with a phase taken from
// the integer lattice offset, so it jumped on every 250 m snap and the
// fragment copy was disabled by a position hack. A wake belongs behind a gate
// uniform driven by vesselWakeEnabled, with emitter position and velocity
// uploaded and the phase taken from the simulation clock; none of that exists
// for the FFT ocean yet (GlobeWater's emitters feed only the globe shader).
// The function stays as the scaffold that wiring will call; the origin below is
// a placeholder, not a position.
fn computeKelvinVesselWake(localEnu: vec2<f32>, phaseTime: f32, detailFade: f32) -> vec2<f32> {
  if (detailFade <= 1.0e-3) {
    return vec2<f32>(0.0);
  }
  let wakeOrigin = vec2<f32>(85.0, 140.0);
  let rel = localEnu - wakeOrigin;
  // Wake trails behind the vessel along (-0.8, -0.6)
  let s = -(rel.x * 0.8 + rel.y * 0.6);
  let r = abs(-rel.x * 0.6 + rel.y * 0.8);
  if (s <= 0.0 || s > 480.0 || r > s * 0.42 + 8.0) {
    return vec2<f32>(0.0);
  }
  let kelvinSlope = 0.3535534; // tan(19.47122 deg) = 1 / sqrt(8)
  let armRatio = r / max(s * kelvinSlope, 1.0);
  let cuspEnvelope =
    smoothstep(0.45, 0.96, armRatio) *
    (1.0 - smoothstep(1.0, 1.18, armRatio));
  let longitudinalDecay = exp(-0.0048 * s) * smoothstep(0.0, 14.0, s);
  let divergentWave = sin(r * 0.62 - s * 0.22 - phaseTime * 2.4) * cuspEnvelope;
  let transverseWave =
    cos(s * 0.28 - phaseTime * 1.8) *
    (1.0 - smoothstep(0.0, 0.98, armRatio)) *
    0.55;
  let wakeHeight = (divergentWave + transverseWave) * longitudinalDecay * detailFade * 0.42;
  let propWashCore =
    exp(-r * r / max(10.0 + s * 0.16, 1.0)) *
    exp(-0.0065 * s) *
    (0.65 + 0.35 * sin(s * 0.85 - phaseTime * 3.5));
  let cuspFoam = clamp(abs(divergentWave) * cuspEnvelope * 1.15 + propWashCore * 0.88, 0.0, 1.0) *
    longitudinalDecay *
    detailFade;
  return vec2<f32>(wakeHeight, cuspFoam);
}

// Microfacet glint of a celestial disc on water.
//
// A light source of finite angular size cannot produce a specular lobe
// narrower than its own disc, however smooth the water is. Evaluating
// Cook-Torrance against the direction to the source alone collapses the lobe
// to a sub-pixel spike as the roughness falls, which reads as a flickering dot
// rather than a glitter path, so the microfacet roughness is given a floor
// derived from the source's angular radius.
//
// The floor is half the angular radius because the microfacet that reflects a
// given direction lies half way between the light and the view: a spread of
// theta across the light direction is a spread of theta/2 across the half
// vector. The energy renormalisation that usually accompanies this widening is
// deliberately omitted -- it compensates for shifting the light to a
// representative point on the source, which this evaluation does not do, and
// applying it anyway drives the smooth-water highlight to zero.
//
// Reference: Cook and Torrance 1982 for the microfacet reflectance model,
// Walter et al. 2007 for the GGX distribution and the Smith shadowing term,
// and Karis 2013 for the Schlick approximation of Smith-GGX and the
// spherical-light roughness widening.
const CELESTIAL_PI: f32 = 3.14159265358979;
// Fresnel reflectance of sea water at normal incidence, refractive index 1.333.
const CELESTIAL_WATER_F0: f32 = 0.02;
// Sine of the Sun's mean angular radius, 959.63 arcseconds.
const CELESTIAL_SUN_SIN_ANGULAR_RADIUS: f32 = 0.0046524;
// Half-vector factor described above.
const CELESTIAL_DISC_WIDEN: f32 = 0.5;
// Roughness floor, and the growth of roughness with distance. The single
// displacement tap resolves less of the wave slope the further the fragment
// is, and the unresolved slope is exactly what a microfacet roughness stands
// for, so the far band self-roughens into a wider, dimmer path while the near
// patch keeps a tight sparkle.
const CELESTIAL_MIN_ROUGHNESS: f32 = 0.02;
const CELESTIAL_DISTANCE_ROUGHEN: f32 = 0.25;
// Warm white of the reflected solar disc, unchanged from the Blinn-Phong
// highlight this replaces, so enabling the feature changes the shape of the
// glint and not its hue.
const CELESTIAL_SUN_TINT: vec3<f32> = vec3<f32>(1.0, 0.98, 0.9);
// Sine of the Moon's mean angular radius, 932.58 arcseconds -- close enough
// to the Sun's that the two discs nearly eclipse, and far enough apart to be
// worth carrying separately.
const CELESTIAL_MOON_SIN_ANGULAR_RADIUS: f32 = 0.0045213;
// Warm grey of the reflected lunar disc. Moonlight only looks blue-white
// because the dark-adapted eye loses colour, and a blue tint here would fight
// the water's own deep colour rather than sit on it.
const CELESTIAL_MOON_TINT: vec3<f32> = vec3<f32>(0.95, 0.93, 0.85);
// The Moon has to clear this much of the sky before its reflection is drawn.
// Sine of five degrees: below it the disc is refracted, extinguished and
// usually behind whatever is on the horizon, and a reflection there reads as
// a bug rather than as moonlight.
const CELESTIAL_MOON_RISE_SIN: f32 = 0.0871557;
// Half-width of the terminator's soft band, as the sine of the Sun's altitude.
// Sine of three degrees, which is a little wider than civil twilight, so the
// night terms arrive over a few minutes of sweep instead of switching on.
const CELESTIAL_NIGHT_BAND_SIN: f32 = 0.0523360;

// How much of the night has fallen at this point on the surface: 1 well after
// sunset, 0 well before it, ramped smoothly across the terminator.
//
// The altitude is measured against the patch's own geodetic up rather than
// against the wave normal. A wave facet tilts by tens of degrees, so gating on
// it would make the terminator flicker with the swell; the anchor's up moves
// with the camera and not with the sea.
fn celestialNightGate(up: vec3<f32>, sunDir: vec3<f32>) -> f32 {
  let sunAltitude = dot(up, sunDir);
  return 1.0 - smoothstep(
    -CELESTIAL_NIGHT_BAND_SIN, CELESTIAL_NIGHT_BAND_SIN, sunAltitude);
}

// GGX/Trowbridge-Reitz normal distribution.
fn celestialDistributionGGX(nDotH: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(CELESTIAL_PI * d * d, 1.0e-8);
}

// Schlick approximation of the Smith-GGX masking term, one direction.
fn celestialSmithG1(nDotX: f32, alpha: f32) -> f32 {
  let k = alpha * 0.5;
  return nDotX / max(nDotX * (1.0 - k) + k, 1.0e-6);
}

// Reflected radiance of a celestial disc of angular radius `sinAngularRadius`,
// per unit source radiance. Zero wherever the source or the eye is below the
// surface's own horizon, so the caller needs no separate visibility term.
fn celestialGlint(
  normal: vec3<f32>,
  viewDir: vec3<f32>,
  lightDir: vec3<f32>,
  roughness: f32,
  sinAngularRadius: f32,
) -> f32 {
  let nDotL = dot(normal, lightDir);
  let nDotV = dot(normal, viewDir);
  if (nDotL <= 0.0 || nDotV <= 0.0) {
    return 0.0;
  }
  let halfVector = normalize(lightDir + viewDir);
  let nDotH = max(dot(normal, halfVector), 0.0);
  let vDotH = max(dot(viewDir, halfVector), 0.0);
  let alpha = roughness * roughness;
  let alphaPrime = clamp(
    alpha + CELESTIAL_DISC_WIDEN * sinAngularRadius, alpha, 1.0);
  let d = celestialDistributionGGX(nDotH, alphaPrime);
  let f =
    CELESTIAL_WATER_F0 + (1.0 - CELESTIAL_WATER_F0) * pow(1.0 - vDotH, 5.0);
  let g =
    celestialSmithG1(nDotV, alphaPrime) * celestialSmithG1(nDotL, alphaPrime);
  // The cosine of the reflectance equation cancels the nDotL of the microfacet
  // denominator, leaving 4 * nDotV.
  return d * f * g / max(4.0 * nDotV, 1.0e-4);
}

@vertex
fn vertexMain(@location(0) gridPos: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;

  // Local ENU planar coordinates (meters), grid in [-0.5, 0.5].
  let e0 = gridPos.x * ocean.patchExtent;
  let n0 = gridPos.y * ocean.patchExtent;

  // Distance fade of wave amplitude + radial patch-edge feather to eliminate rectangular seam.
  let planarDist = length(vec2<f32>(e0, n0));
  let detailFade = 1.0 - smoothstep(180.0, 2200.0, planarDist);
  let uv = vec2<f32>(e0, n0) / ocean.patchL + ocean.uvOffset;
  let disp = sampleMultiBandDisp(uv, detailFade);
  let fadeLin = clamp(
    (planarDist - ocean.waveFadeNear) /
      max(ocean.waveFadeFar - ocean.waveFadeNear, 1.0),
    0.0, 1.0);
  let patchEdgeWindow = 1.0 - smoothstep(
    ocean.patchExtent * 0.60,
    ocean.patchExtent * 0.96,
    planarDist);
  let amp = pow(1.0 - fadeLin, 5.0) * patchEdgeWindow;

  let e = e0 + disp.x * amp;
  let n = n0 + disp.z * amp;
  // Curvature drop so far vertices hug the ellipsoid instead of the tangent plane.
  let drop = -(e0 * e0 + n0 * n0) * 0.5 * ocean.invRadius;
  let up = disp.y * amp + drop;

  // ENU -> ECEF offset from the anchor origin.
  let worldRel = ocean.east * e + ocean.north * n + ocean.up * up;

  // RTE: subtract the encoded camera from the anchor (high/low), add the small
  // local offset, transform with mvpRelativeToEye.
  var highDiff = ocean.anchorHigh - camera.encodedCameraHigh;
  if (length(highDiff) == 0.0) {
    highDiff = vec3<f32>(0.0);
  }
  let lowDiff = ocean.anchorLow - camera.encodedCameraLow;
  let posRelEye = highDiff + lowDiff + worldRel;

  var clip = camera.mvpRelativeToEye * vec4<f32>(posRelEye, 1.0);
  out.position = clip;
  out.uv = uv;
  out.posRelEye = posRelEye;
  out.fade = amp;
  //>>ifdef LOG_DEPTH
  out.v_logDepth = csm_vertexLogDepth(out.position, camera.logDepthNearFar.x);
  out.position = csm_updatePositionDepth(out.position);
  //>>endif
  return out;
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

fn fresnelDielectric(cosI: f32, eta: f32) -> f32 {
  let c = clamp(cosI, 0.0, 1.0);
  let sin2T = (1.0 - c * c) / (eta * eta);
  if (sin2T >= 1.0) {
    return 1.0;
  }
  let cosT = sqrt(max(0.0, 1.0 - sin2T));
  let rS = (c - eta * cosT) / max(c + eta * cosT, 1.0e-5);
  let rP = (eta * c - cosT) / max(eta * c + cosT, 1.0e-5);
  return clamp(0.5 * (rS * rS + rP * rP), 0.0, 1.0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  let eyeDist = length(input.posRelEye);
  let detailFade = 1.0 - smoothstep(180.0, 2200.0, eyeDist);
  let altitudeHandover = 1.0 - smoothstep(3000.0, 12000.0, eyeDist);

  // Normal from the 3-cascade height-gradient of the displacement map (forward finite difference).
  let dispCenter = sampleMultiBandDisp(input.uv, detailFade);
  let h0 = sampleDisp(input.uv).y;
  let t = ocean.texelSize;
  let hR = sampleDisp(input.uv + vec2<f32>(t, 0.0)).y;
  let hU = sampleDisp(input.uv + vec2<f32>(0.0, t)).y;
  let worldStep = t * ocean.patchL;
  let cascadeRippleE = (dispCenter.x - h0 * 0.15) * 0.08 * detailFade;
  let cascadeRippleN = (dispCenter.z - h0 * 0.15) * 0.08 * detailFade;
  let slopeE = ((hR - h0) / max(worldStep, 1e-3) + cascadeRippleE) * ocean.detailScale * input.fade;
  let slopeN = ((hU - h0) / max(worldStep, 1e-3) + cascadeRippleN) * ocean.detailScale * input.fade;
  let nLocal = normalize(vec3<f32>(-slopeE, -slopeN, 1.0));
  let worldNormal = normalize(
    ocean.east * nLocal.x + ocean.north * nLocal.y + ocean.up * nLocal.z);

  let viewDir = normalize(-input.posRelEye);
  let rawNdotV = dot(worldNormal, viewDir);
  let nDotV = max(rawNdotV, 0.0);
  // Exact unpolarized dielectric Fresnel for air-to-water (eta = 1.333333).
  let fresnel = fresnelDielectric(nDotV, 1.333333);

  // Sky reflection: couple zenith/horizon dome to solar elevation (day -> twilight -> night).
  let upDir = normalize(ocean.up);
  let sunDir = normalize(ocean.sunDirection);
  let sunElev = dot(upDir, sunDir);
  let dayWeight = smoothstep(-0.08, 0.18, sunElev);
  let twilightWeight =
    smoothstep(-0.22, -0.02, sunElev) * (1.0 - smoothstep(0.02, 0.24, sunElev));
  let zenithSky = mix(
    vec3<f32>(0.02, 0.04, 0.09),
    vec3<f32>(0.55, 0.72, 0.92),
    dayWeight) + vec3<f32>(0.42, 0.18, 0.08) * twilightWeight;
  let reflectDir = reflect(-viewDir, worldNormal);
  let skyUp = clamp(dot(reflectDir, upDir), 0.0, 1.0);
  let horizonConeGate = (1.0 - smoothstep(0.0, 0.16, skyUp)) * (0.35 + 0.65 * dayWeight);
  let localHorizonReflection = mix(
    ocean.shallowColor,
    mix(vec3<f32>(0.08, 0.18, 0.12), ocean.shallowColor, 0.65),
    horizonConeGate,
  );
  let skyColor = mix(localHorizonReflection, zenithSky, skyUp);

  // Sun specular. Two laws, chosen at runtime by the celestial-reflection
  // enable float rather than by a shader define, because the microfacet lobe
  // shares its evaluation with the night-side terms and both have to be
  // switchable without recompiling or spending one of the exhausted define
  // bits. The off arm below is the historical Blinn-Phong highlight, unchanged;
  // the surrounding shading (Fresnel, sky, scatter, foam) is not, see the
  // header.
  let localEnuFrag = (input.uv - ocean.uvOffset) * ocean.patchL;
  let refractedViewDir = refract(-viewDir, worldNormal, 0.75);
  let refractedCos = max(-dot(refractedViewDir, upDir), 0.12);
  let columnSlant = clamp(1.0 / refractedCos, 1.0, 4.5);
  let bathyDepth = ocean.bathymetry.x;
  let bathyJerlov = clamp(ocean.bathymetry.y, 0.0, 5.0);
  let shallowShelfBoost = select(
    1.0,
    1.0 + (1.0 - smoothstep(4.0, 85.0, bathyDepth)) * (0.45 - bathyJerlov * 0.05),
    bathyDepth > 0.0,
  );
  let gordonScatter =
    ocean.shallowColor *
    (1.0 - exp(-0.28 * columnSlant)) *
    (0.35 + 0.65 * max(sunElev, 0.0)) *
    (1.0 - fresnel) *
    0.22 *
    shallowShelfBoost;
  let vDotNegL = max(dot(viewDir, -sunDir), 0.0);
  let broadForward = max(0.0, dot(sunDir, -viewDir) + 0.3);
  let crestElevation = clamp(max(dispCenter.y, 0.0) * 0.35, 0.0, 1.5);
  let crestToTroughTranslucency =
    mix(vec3<f32>(-0.006, -0.012, -0.018), vec3<f32>(0.024, 0.26, 0.34), clamp(crestElevation, 0.0, 1.0)) *
    input.fade *
    altitudeHandover;
  let vDotNegL2 = vDotNegL * vDotNegL;
  let sssFactor =
    (1.0 - nDotV) *
    (vDotNegL2 * vDotNegL2 * 0.16 + broadForward * broadForward * 0.12) *
    (1.0 + crestElevation) *
    (1.0 - fresnel * 0.5) *
    input.fade *
    altitudeHandover;
  var color =
    mix(ocean.deepColor + gordonScatter + crestToTroughTranslucency, skyColor, fresnel) +
    vec3<f32>(0.05, 0.25, 0.35) * sssFactor;

  if (ocean.celestialEnable > 0.0) {
    let celestialRoughness = clamp(
      ocean.celestialRoughness + (1.0 - input.fade) * CELESTIAL_DISTANCE_ROUGHEN,
      CELESTIAL_MIN_ROUGHNESS,
      1.0);
    // The two light sources hand over across the terminator through
    // complementary weights, so neither is counted twice and no seam appears
    // where one takes over from the other.
    let up = upDir;
    let nightGate = celestialNightGate(up, sunDir);
    let dayGate = 1.0 - nightGate;

    let sunGlint = celestialGlint(
      worldNormal,
      viewDir,
      sunDir,
      celestialRoughness,
      ocean.celestialSinAngularRadius);
    let sunContribution =
      CELESTIAL_SUN_TINT * sunGlint * ocean.celestialSunIntensity * dayGate;

    // The moonglade. A zero moon direction carries itself to zero through
    // both terms, and the illuminated fraction closes the last of it as the
    // Moon goes new, so no branch is needed to suppress the term.
    let moonRiseGate =
      smoothstep(0.0, CELESTIAL_MOON_RISE_SIN, dot(up, ocean.moonDirection));
    let moonGlint = celestialGlint(
      worldNormal,
      viewDir,
      ocean.moonDirection,
      celestialRoughness,
      ocean.celestialMoonSinAngularRadius);
    let moonContribution =
      CELESTIAL_MOON_TINT * moonGlint * ocean.celestialMoonIntensity *
      ocean.celestialMoonPhase * moonRiseGate * nightGate;

    color += sunContribution + moonContribution;
  } else {
    let halfway = normalize(sunDir + viewDir);
    let spec = pow(max(dot(worldNormal, halfway), 0.0), 200.0);
    color += vec3<f32>(1.0, 0.98, 0.9) * spec * nDotV;
  }

  // Foam from the Jacobian channel + cellular Voronoi lace.
  let laceTrig = sin(vec4<f32>(
    localEnuFrag.x * 0.45 + localEnuFrag.y * 0.32,
    localEnuFrag.x * 0.38 - localEnuFrag.y * 0.51,
    localEnuFrag.x * 1.15 - localEnuFrag.y * 0.85,
    localEnuFrag.x * 0.92 + localEnuFrag.y * 1.24,
  ));
  let cascadeFoamLace = mix(
    1.0,
    clamp(0.55 + 0.30 * (laceTrig.x * laceTrig.y) + 0.25 * (laceTrig.z * laceTrig.w), 0.35, 1.25),
    detailFade,
  );
  let foam =
    clamp(dispCenter.w * ocean.foamStrength * cascadeFoamLace, 0.0, 1.0) *
    input.fade *
    altitudeHandover;
  let oneMinusNDotVOcean = 1.0 - nDotV;
  let crestSpindrift =
    vec3<f32>(0.76, 0.88, 0.96) *
    foam *
    (oneMinusNDotVOcean * oneMinusNDotVOcean * oneMinusNDotVOcean) *
    altitudeHandover *
    0.24;
  color = mix(color + crestSpindrift, vec3<f32>(0.92, 0.95, 0.97), foam);

  // Submerged upward-looking 3D wave ceiling: Snell's Window (48.6 deg critical cone),
  // Total Internal Reflection (TIR), and RGB prismatic rim dispersion (n_R=1.331, n_G=1.334, n_B=1.338).
  let meanSurfaceRelEyeUp = dot(input.posRelEye, upDir) - dispCenter.y * input.fade;
  if (rawNdotV < 0.0 && meanSurfaceRelEyeUp > 0.25) {
    let cosThetaI = clamp(dot(-worldNormal, -viewDir), 0.0, 1.0);
    let sin2ThetaI = max(0.0, 1.0 - cosThetaI * cosThetaI);
    let sin2ThetaR = 1.331 * 1.331 * sin2ThetaI;
    let sin2ThetaG = 1.334 * 1.334 * sin2ThetaI;
    let sin2ThetaB = 1.338 * 1.338 * sin2ThetaI;
    let cosThetaR = sqrt(max(0.0, 1.0 - sin2ThetaR));
    let cosThetaG = sqrt(max(0.0, 1.0 - sin2ThetaG));
    let cosThetaB = sqrt(max(0.0, 1.0 - sin2ThetaB));
    let snellWindowMask = 1.0 - smoothstep(0.94, 1.0, sin2ThetaG);
    let rimDispersion = vec3<f32>(
      smoothstep(0.76, 0.99, sin2ThetaR) * (1.0 - smoothstep(0.99, 1.02, sin2ThetaR)),
      smoothstep(0.76, 0.99, sin2ThetaG) * (1.0 - smoothstep(0.99, 1.02, sin2ThetaG)),
      smoothstep(0.76, 0.99, sin2ThetaB) * (1.0 - smoothstep(0.99, 1.02, sin2ThetaB))
    );
    let refractedSky = zenithSky * vec3<f32>(
      0.55 + 0.45 * cosThetaR,
      0.55 + 0.45 * cosThetaG,
      0.55 + 0.45 * cosThetaB
    ) + rimDispersion * vec3<f32>(0.36, 0.26, 0.48) * dayWeight;
    let tirUndersea = mix(ocean.deepColor, ocean.shallowColor, 0.38) * (0.25 + 0.75 * dayWeight);
    let ceilingColor = mix(tirUndersea, refractedSky, snellWindowMask);
    let beerLambert = exp(-vec3<f32>(0.22, 0.032, 0.0095) * min(eyeDist, 120.0));
    let inscatter = vec3<f32>(0.015, 0.16, 0.28) * (0.25 + 0.75 * dayWeight);
    color = ceilingColor * beerLambert + inscatter * (1.0 - beerLambert);
  }

  // Close-range water-type transparency & radial patch-edge alpha feathering:
  // Clear tropical water (high blue-green ratio in shallowColor) transmits more
  // light at steep viewing angles (low Fresnel), while turbid coastal water and
  // grazing horizon reflections approach full opacity.
  let closeClarityFade = 1.0 - smoothstep(180.0, 3800.0, eyeDist);
  let waterTypeTurbidity = clamp(
    (ocean.shallowColor.r * 2.4 + ocean.shallowColor.g * 1.1) /
      max(ocean.shallowColor.b, 0.08),
    0.22,
    0.92,
  );
  let minOpacityByWaterType = mix(0.36, 0.88, waterTypeTurbidity);
  let angleOpacity = mix(minOpacityByWaterType, 1.0, fresnel);
  let closeAlpha = mix(1.0, angleOpacity, closeClarityFade);
  let edgeAlpha = smoothstep(0.0, 0.22, input.fade);
  let surfaceAlpha = clamp(closeAlpha + foam * 0.85, 0.28, 1.0) * edgeAlpha;

  var outc: FragOutput;
  outc.color = vec4<f32>(color, surfaceAlpha);
  //>>ifdef LOG_DEPTH
  outc.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return outc;
}
