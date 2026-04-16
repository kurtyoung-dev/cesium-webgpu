// SkyAtmosphere.wgsl — Nishita-style atmospheric scattering for CesiumJS WebGPU
// Renders an ellipsoid shell with Rayleigh + Mie scattering

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  cameraPositionWC: vec3<f32>,
  _pad2: f32,
  sunDirectionWC: vec3<f32>,
  _pad3: f32,
  radiiAndDynamicAtmosphere: vec4<f32>, // x=innerRadius, y=outerRadius, z=dynamicLighting, w=unused
  rayleighScaleHeight: f32,
  mieScaleHeight: f32,
  mieAnisotropy: f32,
  intensity: f32,
  hsbShift: vec3<f32>,  // hue, saturation, brightness shifts
  // LUT enable flag. When > 0.5 the fragment shader replaces the per-pixel
  // 16-step Nishita ray march with a single inscatter LUT sample (the LUT is
  // baked once per sun-direction change by `WebGPUPerformanceManager`).
  // Renderer leaves this 0 if compute shaders are unavailable or the LUT
  // bind group is missing.
  useLut: f32,
  rayleighCoefficient: vec3<f32>,
  _pad5: f32,
  mieCoefficient: vec3<f32>,
  _pad6: f32,
  // Debug controls (Tier 1):
  //   x = disableScattering — when > 0.5 the fragment shader bypasses the
  //       Nishita Rayleigh+Mie integral and returns a flat magenta diagnostic
  //       color. Lets you isolate scattering math bugs from LUT/composite
  //       errors. Magenta is intentional — picks up immediately on a blue
  //       sky and is unmistakable for any natural sky color.
  //   y = showLutOnly — reserved (Tier 3 LUT inspector)
  //   z = forceSunDirOverride — reserved (Tier 3 sun override)
  //   w = unused
  debug: vec4<f32>,
  // Phase 1.3c — Dual-light atmosphere scattering. The moon LUT is
  // baked separately from the sun LUT (by WebGPUPerformanceManager
  // with target="moon") and the fragment shader sums both contributions
  // when `dualLightControl.x > 0.5`. The moon term scales linearly with
  // `moonPhaseFraction` (0 = new moon → no contribution, 1 = full moon).
  moonDirectionWC: vec3<f32>,
  _pad7: f32,
  // x = enableDualLightAtmosphere flag (0/1)
  // y = moonPhaseFraction (0..1)
  // z = moonIntensityScale (default 0.05 — moon is much dimmer than sun)
  // w = pad
  dualLightControl: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// Precomputed atmosphere LUTs. Bound unconditionally so the pipeline
// layout never changes. The transmittance LUT (256×64) stores extinction
// along view rays of varying zenith angle and altitude; the inscatter LUT
// (256×128) is the full Rayleigh+Mie integral with the relevant light
// direction baked in by AtmosphereLUT.wgsl. Sampling the inscatter table
// replaces the 16-step ray march below with a single texture fetch.
//
// Phase 1.3c — moon LUTs at bindings 3+4 mirror the sun LUTs at 1+2.
// When dual-light scattering is off the moon LUTs still bind to valid
// (cleared) textures so the layout stays constant.
@group(1) @binding(0) var lutSampler: sampler;
@group(1) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(1) @binding(2) var inscatterLut: texture_2d<f32>;
@group(1) @binding(3) var moonTransmittanceLut: texture_2d<f32>;
@group(1) @binding(4) var moonInscatterLut: texture_2d<f32>;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) cameraToVertex: vec3<f32>,
};

// Translate Relative To Eye for 64-bit precision
fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let positionRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    u.encodedCameraHigh, u.encodedCameraLow
  );
  output.position = u.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);
  // Stay in the RTE / camera-local frame. positionRTE IS the camera-to-vertex
  // delta at full emulated 64-bit precision, so using it directly avoids the
  // `posHigh + posLow` rule violation and the subsequent catastrophic
  // cancellation on `worldPos - cameraPositionWC`. worldPosition is not read
  // by the fragment shader, so reconstructing it as `cameraPositionWC +
  // positionRTE` is the cheapest safe placeholder.
  output.cameraToVertex = positionRTE;
  output.worldPosition = u.cameraPositionWC + positionRTE;
  return output;
}

// Constants
const PI: f32 = 3.14159265358979323846;
const NUM_SCATTER_STEPS: i32 = 16;
const NUM_OPTICAL_DEPTH_STEPS: i32 = 8;

fn rayleighPhaseFunction(cosAngle: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosAngle * cosAngle);
}

fn miePhaseFunction(cosAngle: f32, g: f32) -> f32 {
  let g2 = g * g;
  let num = 3.0 * (1.0 - g2) * (1.0 + cosAngle * cosAngle);
  let denom = 8.0 * PI * (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5);
  return num / max(denom, 0.0001);
}

fn densityAtHeight(height: f32, scaleHeight: f32) -> f32 {
  return exp(-height / scaleHeight);
}

fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
  let a = dot(dir, dir);
  let b = 2.0 * dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let sqrtD = sqrt(discriminant);
  return vec2<f32>((-b - sqrtD) / (2.0 * a), (-b + sqrtD) / (2.0 * a));
}

fn opticalDepth(origin: vec3<f32>, dir: vec3<f32>, pathLength: f32, scaleHeight: f32, innerRadius: f32) -> f32 {
  let stepSize = pathLength / f32(NUM_OPTICAL_DEPTH_STEPS);
  var totalDensity: f32 = 0.0;
  var point = origin + dir * (stepSize * 0.5);
  for (var i: i32 = 0; i < NUM_OPTICAL_DEPTH_STEPS; i++) {
    let height = max(0.0, length(point) - innerRadius);
    totalDensity += densityAtHeight(height, scaleHeight) * stepSize;
    point += dir * stepSize;
  }
  return totalDensity;
}

fn computeScattering(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  rayLength: f32,
  sunDir: vec3<f32>,
  innerRadius: f32,
  outerRadius: f32,
) -> vec3<f32> {
  let stepSize = rayLength / f32(NUM_SCATTER_STEPS);
  var point = rayOrigin + rayDir * (stepSize * 0.5);

  var totalRayleigh = vec3<f32>(0.0);
  var totalMie = vec3<f32>(0.0);
  var rayleighOpticalDepthSum: f32 = 0.0;
  var mieOpticalDepthSum: f32 = 0.0;

  for (var i: i32 = 0; i < NUM_SCATTER_STEPS; i++) {
    let height = max(0.0, length(point) - innerRadius);
    let rayleighDensity = densityAtHeight(height, u.rayleighScaleHeight) * stepSize;
    let mieDensity = densityAtHeight(height, u.mieScaleHeight) * stepSize;

    rayleighOpticalDepthSum += rayleighDensity;
    mieOpticalDepthSum += mieDensity;

    // Sun optical depth from this point
    let sunIntersect = raySphereIntersect(point, sunDir, outerRadius);
    if (sunIntersect.y > 0.0) {
      let sunRayLength = sunIntersect.y;
      let sunOptDepthR = opticalDepth(point, sunDir, sunRayLength, u.rayleighScaleHeight, innerRadius);
      let sunOptDepthM = opticalDepth(point, sunDir, sunRayLength, u.mieScaleHeight, innerRadius);

      let attenuation = exp(
        -(u.rayleighCoefficient * (rayleighOpticalDepthSum + sunOptDepthR) +
          u.mieCoefficient * (mieOpticalDepthSum + sunOptDepthM))
      );

      totalRayleigh += rayleighDensity * attenuation;
      totalMie += mieDensity * attenuation;
    }

    point += rayDir * stepSize;
  }

  let cosAngle = dot(rayDir, sunDir);
  let rayleighPhase = rayleighPhaseFunction(cosAngle);
  let miePhase = miePhaseFunction(cosAngle, u.mieAnisotropy);

  return u.intensity * (
    totalRayleigh * u.rayleighCoefficient * rayleighPhase +
    totalMie * u.mieCoefficient * miePhase
  );
}

// LUT-based scattering: replaces the 16-step Nishita integral with a single
// texture sample of the inscatter LUT (already integrated for the relevant
// light direction at LUT-generation time). The mapping mirrors the U/V
// encoding in AtmosphereLUT.wgsl::computeInscatter:
//   U = (cosViewZenith + 1) / 2     where cosViewZenith = dot(viewDir, up)
//   V = altitude / atmosphereThickness
// Returns vec3 ready to feed straight into the post-scattering tonemap.
//
// Phase 1.3c — accepts a texture parameter so the same helper can be
// reused for both sun and moon inscatter samples without duplicating
// the U/V math. WGSL doesn't have first-class texture parameters in
// every backend, but `texture_2d<f32>` is fine for vertex/fragment
// stages on every WebGPU 1.0 implementation.
fn sampleScatteringLut(
  inscatterTex: texture_2d<f32>,
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  innerRadius: f32,
  outerRadius: f32,
) -> vec3<f32> {
  let upDir = normalize(rayOrigin);
  let cosViewZenith = clamp(dot(rayDir, upDir), -1.0, 1.0);
  let altitude = max(0.0, length(rayOrigin) - innerRadius);
  let thickness = max(1.0, outerRadius - innerRadius);
  let uCoord = clamp(cosViewZenith * 0.5 + 0.5, 0.0, 1.0);
  let vCoord = clamp(altitude / thickness, 0.0, 1.0);
  let s = textureSampleLevel(
    inscatterTex, lutSampler, vec2<f32>(uCoord, vCoord), 0.0,
  );
  // Orbital falloff: the LUT was generated for camera positions in [0, thickness].
  // Above the atmosphere (LEO/MEO/GEO) the clamp at vCoord saturates, which
  // otherwise produces identical haze at every orbital altitude. Fade the
  // inscatter contribution above the atmosphere with a scale-height equal
  // to the atmosphere thickness (~100 km on Earth) \u2014 roughly matches how
  // atmospheric airmass visibly decreases with distance.
  let excessAltitude = max(0.0, altitude - thickness);
  let orbitFalloff = exp(-excessAltitude / thickness);
  return s.rgb * u.intensity * orbitFalloff;
}

// HSB shift for color correction
fn rgbToHsb(c: vec3<f32>) -> vec3<f32> {
  let maxC = max(c.r, max(c.g, c.b));
  let minC = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  var h: f32 = 0.0;
  var s: f32 = 0.0;
  let b = maxC;
  if (delta > 0.001) {
    s = delta / maxC;
    if (c.r >= maxC) { h = (c.g - c.b) / delta; }
    else if (c.g >= maxC) { h = 2.0 + (c.b - c.r) / delta; }
    else { h = 4.0 + (c.r - c.g) / delta; }
    h = h / 6.0;
    if (h < 0.0) { h += 1.0; }
  }
  return vec3<f32>(h, s, b);
}

fn hsbToRgb(hsb: vec3<f32>) -> vec3<f32> {
  let h = fract(hsb.x) * 6.0;
  let s = clamp(hsb.y, 0.0, 1.0);
  let b = clamp(hsb.z, 0.0, 1.0);
  let i = floor(h);
  let f = h - i;
  let p = b * (1.0 - s);
  let q = b * (1.0 - s * f);
  let t = b * (1.0 - s * (1.0 - f));
  let ii = i32(i) % 6;
  if (ii == 0) { return vec3<f32>(b, t, p); }
  if (ii == 1) { return vec3<f32>(q, b, p); }
  if (ii == 2) { return vec3<f32>(p, b, t); }
  if (ii == 3) { return vec3<f32>(p, q, b); }
  if (ii == 4) { return vec3<f32>(t, p, b); }
  return vec3<f32>(b, p, q);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let innerRadius = u.radiiAndDynamicAtmosphere.x;
  let outerRadius = u.radiiAndDynamicAtmosphere.y;

  let rayDir = normalize(input.cameraToVertex);
  let cameraHeight = length(u.cameraPositionWC);

  // Determine ray origin and intersections
  var rayOrigin = u.cameraPositionWC;
  let atmosphereIntersect = raySphereIntersect(rayOrigin, rayDir, outerRadius);

  if (atmosphereIntersect.y < 0.0) {
    discard;
  }

  let earthIntersect = raySphereIntersect(rayOrigin, rayDir, innerRadius);
  var rayStart = max(0.0, atmosphereIntersect.x);
  var rayEnd = atmosphereIntersect.y;

  // If ray hits the earth, stop at earth surface
  if (earthIntersect.x > 0.0) {
    rayEnd = earthIntersect.x;
  }

  let rayLength = rayEnd - rayStart;
  if (rayLength <= 0.0) {
    discard;
  }

  // Tier 1 debug: bypass scattering and emit diagnostic magenta. Lets you
  // see the atmosphere shell's geometric coverage without scattering math
  // muddying the picture — confirms ray-sphere intersection + draw call
  // are reaching the fragment stage.
  if (u.debug.x > 0.5) {
    return vec4<f32>(1.0, 0.0, 1.0, 0.5);
  }

  let startPoint = rayOrigin + rayDir * rayStart;
  // Fast path: when the renderer reports the precomputed LUT is bound and
  // up-to-date for the current sun direction, replace the 16-step ray
  // march with a single inscatter texture fetch. The LUT was integrated
  // by AtmosphereLUT.wgsl with phase functions and Beer-Lambert
  // attenuation already applied, so the result drops straight into the
  // tonemap below.
  //
  // Phase 1.3c — Dual-light scattering. When `dualLightControl.x > 0.5`
  // we ALSO sample the moon inscatter LUT (baked separately for the
  // current moon direction) and add its contribution scaled by the moon
  // phase fraction × the moon intensity scale. The moon term costs one
  // extra texture sample on the LUT path; on the fallback ray-march
  // path it's currently skipped (the per-pixel ray march only handles
  // a single light source — adding moon there is a Phase 5 task that
  // ties into volumetric fog scattering occlusion).
  var color: vec3<f32>;
  if (u.useLut > 0.5) {
    color = sampleScatteringLut(
      inscatterLut, startPoint, rayDir, innerRadius, outerRadius,
    );
    if (u.dualLightControl.x > 0.5 && u.dualLightControl.y > 0.001) {
      let moonColor = sampleScatteringLut(
        moonInscatterLut, startPoint, rayDir, innerRadius, outerRadius,
      );
      // Scale by phase fraction (linear; new moon → 0) and the moon
      // intensity multiplier so the moon term sits at a few percent of
      // the sun term at full moon.
      let moonScale = u.dualLightControl.y * u.dualLightControl.z;
      color = color + moonColor * moonScale;
    }
  } else {
    color = computeScattering(startPoint, rayDir, rayLength, u.sunDirectionWC, innerRadius, outerRadius);
  }

  // Apply HSB shift
  var finalColor = color;
  if (abs(u.hsbShift.x) > 0.001 || abs(u.hsbShift.y) > 0.001 || abs(u.hsbShift.z) > 0.001) {
    var hsb = rgbToHsb(finalColor);
    hsb.x = fract(hsb.x + u.hsbShift.x);
    hsb.y = clamp(hsb.y + u.hsbShift.y, 0.0, 1.0);
    hsb.z = clamp(hsb.z + u.hsbShift.z, 0.0, 1.0);
    finalColor = hsbToRgb(hsb);
  }

  // Tonemap to prevent oversaturation
  finalColor = vec3<f32>(1.0) - exp(-finalColor);

  let alpha = clamp(max(finalColor.r, max(finalColor.g, finalColor.b)) * 2.0, 0.0, 1.0);
  return vec4<f32>(finalColor, alpha);
}
