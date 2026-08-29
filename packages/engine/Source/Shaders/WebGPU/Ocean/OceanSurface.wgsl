// OceanSurface.wgsl — displaced ocean surface patch for the FFT spectral
// ocean. A flat ENU grid patch anchored at the camera sub-point is displaced by
// the merged FFT displacement map and shaded with a simple Fresnel water BRDF
// plus Jacobian foam. Positioning is relative-to-eye: the anchor is
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
  _p2: vec2<f32>,
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

  let uv = vec2<f32>(e0, n0) / ocean.patchL + ocean.uvOffset;
  let disp = sampleDisp(uv);

  // Distance fade of wave amplitude (matches the B630 water-mask handover band).
  let planarDist = length(vec2<f32>(e0, n0));
  let fadeLin = clamp(
    (planarDist - ocean.waveFadeNear) /
      max(ocean.waveFadeFar - ocean.waveFadeNear, 1.0),
    0.0, 1.0);
  let amp = pow(1.0 - fadeLin, 5.0);

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

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  // Normal from the height-gradient of the displacement map (finite difference).
  let t = ocean.texelSize;
  let hL = sampleDisp(input.uv - vec2<f32>(t, 0.0)).y;
  let hR = sampleDisp(input.uv + vec2<f32>(t, 0.0)).y;
  let hD = sampleDisp(input.uv - vec2<f32>(0.0, t)).y;
  let hU = sampleDisp(input.uv + vec2<f32>(0.0, t)).y;
  let worldStep = 2.0 * t * ocean.patchL;
  let slopeE = (hR - hL) / max(worldStep, 1e-3) * ocean.detailScale * input.fade;
  let slopeN = (hU - hD) / max(worldStep, 1e-3) * ocean.detailScale * input.fade;
  let nLocal = normalize(vec3<f32>(-slopeE, -slopeN, 1.0));
  let worldNormal = normalize(
    ocean.east * nLocal.x + ocean.north * nLocal.y + ocean.up * nLocal.z);

  let viewDir = normalize(-input.posRelEye);
  let nDotV = max(dot(worldNormal, viewDir), 0.0);
  // Schlick Fresnel, F0 = 0.02 for water.
  let fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);

  // Sky reflection: brighten with the up-component of the reflected ray.
  let reflectDir = reflect(-viewDir, worldNormal);
  let skyUp = clamp(dot(reflectDir, normalize(ocean.up)), 0.0, 1.0);
  let skyColor = mix(ocean.shallowColor, vec3<f32>(0.55, 0.72, 0.92), skyUp);

  var color = mix(ocean.deepColor, skyColor, fresnel);

  // Sun specular. Two laws, chosen at runtime by the celestial-reflection
  // enable float rather than by a shader define, because the microfacet lobe
  // shares its evaluation with the night-side terms and both have to be
  // switchable without recompiling or spending one of the exhausted define
  // bits. The off arm below is the historical Blinn-Phong highlight, unchanged,
  // so the default look survives the addition untouched.
  let sunDir = normalize(ocean.sunDirection);
  if (ocean.celestialEnable > 0.0) {
    let celestialRoughness = clamp(
      ocean.celestialRoughness + (1.0 - input.fade) * CELESTIAL_DISTANCE_ROUGHEN,
      CELESTIAL_MIN_ROUGHNESS,
      1.0);
    // The two light sources hand over across the terminator through
    // complementary weights, so neither is counted twice and no seam appears
    // where one takes over from the other.
    let up = normalize(ocean.up);
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

  // Foam from the Jacobian channel.
  let foam = clamp(sampleDisp(input.uv).w * ocean.foamStrength, 0.0, 1.0) * input.fade;
  color = mix(color, vec3<f32>(0.92, 0.95, 0.97), foam);

  var outc: FragOutput;
  outc.color = vec4<f32>(color, 1.0);
  //>>ifdef LOG_DEPTH
  outc.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return outc;
}
