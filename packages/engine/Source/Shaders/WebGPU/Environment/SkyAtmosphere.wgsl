// SkyAtmosphere.wgsl — Nishita-style atmospheric scattering for CesiumJS WebGPU
// Renders an ellipsoid shell with Rayleigh + Mie scattering
//
// ┌─────────────────────────────────────────────────────────────────────┐
// │ PAIR: WebGPU WGSL (this file, 536 lines)                             │
// │       WebGL GLSL: Shaders/SkyAtmosphereVS.glsl (32 lines)            │
// │                   Shaders/SkyAtmosphereFS.glsl (59 lines)            │
// │                   Shaders/SkyAtmosphereCommon.glsl (81 lines)        │
// │                   Shaders/Builtin/Functions/computeScattering.glsl   │
// │                   Shaders/Builtin/Functions/computeAtmosphereColor.glsl │
// │ Last lockstep audit: 2026-05-19, Batch 76                            │
// └─────────────────────────────────────────────────────────────────────┘
// Any change in this file MUST land with a matching change in the GLSL
// counterparts. See migration_doc/SHADER_PAIRS_LOCKSTEP.md.
//
// STRUCTURAL DIVERGENCES (cataloged for the convention ledger)
//
// 1. **Single file vs multi-file split.** GLSL splits the pipeline into
//    VS + FS + Common (= czm_computeScattering + czm_computeAtmosphereColor
//    builtins). WGSL is a single module with @vertex + @fragment + helper
//    fns inlined; czm_* builtins (pbrNeutralTonemapping, inverseGamma,
//    applyHSBShift, raySphereIntersect) are ported inline as
//    `pbrNeutralTonemapSky`, `pow(x, 1/2.2)`, `rgbToHsb`/`hsbToRgb`,
//    `raySphereIntersect`.
//
// 2. **Ray-march quadrature.** RESOLVED Batch 247 — `computeScattering`
//    is now a 1:1 port of czm_computeScattering's 16/4 adaptive scheme
//    (w_inside_atmosphere / w_stop_gt_lprl step counts + stride,
//    including its quadrature quirks). The previous 64-step uniform
//    march was MORE converged than WebGL, which made the ground-level
//    sky ~1.5× brighter than the WebGL reference (the coarse GLSL
//    quadrature undershoots the converged Rayleigh integral). See the
//    `PRIMARY_STEPS_MAX` comment at line ~230.
//
// 3. **Per-vertex vs per-fragment.** GLSL has #ifdef
//    PER_FRAGMENT_ATMOSPHERE that decides between vertex-evaluated
//    scattering (then interpolated as `v_mieColor`/`v_rayleighColor`
//    varyings) vs per-fragment evaluation. WGSL always evaluates
//    per-fragment — the WGSL VertexOutput carries only position and the
//    camera-to-vertex delta. Per-vertex would re-introduce the
//    mesh-pattern artifact at orbit altitudes (same lesson as Batch 56
//    for ground atmosphere).
//
// 4. **LUT fast-path.** WGSL has a `useLut > 0.5` branch that replaces
//    the 64-step ray march with a single inscatter LUT texture sample
//    (LUT baked once per sun-direction change by
//    `WebGPUPerformanceManager`). GLSL has no equivalent — WebGL2 has
//    no compute shaders, so the LUT bake step doesn't exist on that
//    backend. WebGL always uses the inline ray march. Documented as
//    an intentional one-way enhancement (Phase 4).
//    ⚠ Batch 247: the JS side currently packs `useLut = 0`
//    unconditionally (`ENABLE_SKY_INSCATTER_LUT = false` in
//    WebGPUSkyAtmosphereRenderer) — the 2D bake encodes the world-space
//    sun direction in a synthetic Y-up frame and has no view–sun
//    azimuth axis, which rendered a frame-filling over-bright daytime
//    sky at ground level (NEW-GROUND-VIEW-ENV-DIVERGENCES). The branch
//    below is retained scaffolding for the sun-relative re-bake
//    (DEFERRED_WORK: NEW-ATMOSPHERE-LUT-SUN-RELATIVE).
//
// 5. **Dual-light scattering (sun + moon).** WGSL samples a SECOND
//    inscatter LUT (`moonInscatterLut`) when `dualLightControl.x > 0.5`
//    and adds the moon contribution scaled by phase × intensity. GLSL
//    has no equivalent — single light source only. Phase 1.3c
//    WGSL-only enhancement.
//
// 6. **Debug bypass output.** WGSL has Tier 1 debug at
//    `u.debug.x > 0.5` → flat magenta. GLSL has no equivalent — debug
//    work in WebGL uses external CesiumDebug commands rather than
//    shader-local toggles.
//
// 7. **Wind state scaffolding.** WGSL carries `windDirectionAndSpeed`
//    in the UBO ahead of Phase 5/6 (volumetric fog + cloud motion).
//    GLSL has no equivalent — none of those phases are planned for
//    WebGL2 backend.
//
// 8. **Tonemap chain order.** GLSL FS L40-48: scatter → IF !HDR
//    czm_pbrNeutralTonemapping + czm_inverseGamma → IF COLOR_CORRECT
//    czm_applyHSBShift. WGSL FS L491-500: ALWAYS pbrNeutralTonemapSky →
//    ALWAYS pow(x, 1/2.2) sRGB encode → IF |hsbShift| > 0.001 then
//    hsbToRgb(rgbToHsb()). WGSL is unconditional on the tonemap chain
//    because HDR mode is plumbed differently on the WebGPU side (post-
//    process pipeline handles HDR composite).
//
// 9. **RTE vs `czm_model` vertex transform.** GLSL VS uses
//    `czm_model * position` (no RTE — single precision is sufficient
//    for the atmosphere shell mesh at planet scale because the shell
//    is centered on the planet origin). WGSL VS uses
//    `translateRelativeToEye(positionHigh, positionLow, encodedCameraHigh,
//    encodedCameraLow)` then `mvpRelativeToEye * positionRTE` — RTE is
//    used uniformly across all WGSL shaders for consistency, not
//    because the atmosphere shell needs it.
//
// 10. **Translucent-globe brightening.** GLSL has `#ifdef
//     GLOBE_TRANSLUCENT` path in computeAtmosphereScattering that
//     brightens the inside-globe view when translucency is enabled.
//     WGSL has no equivalent — globe-translucency is not yet wired
//     through the WebGPU pipeline (deferred, tracked in
//     DEFERRED_WORK.md as part of multi-frustum/translucent classification).
//
// 11. **Ellipsoid math (uniform vs builtins).** GLSL pulls
//     `czm_ellipsoidRadii`, `czm_ellipsoidInverseRadii`,
//     `czm_eyeHeight`, `czm_viewerPositionWC` from automatic uniforms.
//     WGSL pulls `radiiAndDynamicAtmosphere` (innerRadius, outerRadius,
//     dynamicLighting, _), `cameraPositionWC` from the explicit
//     `Uniforms` struct — innerRadius IS the ellipsoid-radius minus a
//     distance-adjust quantity that the CPU pre-computes (no in-shader
//     equivalent to GLSL's runtime `distanceAdjust` math).

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
  // x = innerRadius — WebGL-parity scattering-shell inner radius
  //     (`(|cameraWC| - eyeHeight) - radiusAdjust`, Batch 247; mirrors
  //     SkyAtmosphereCommon.glsl L43-54)
  // y = outerRadius — innerRadius + 111e3 (czm_computeScattering's
  //     ATMOSPHERE_THICKNESS)
  // z = dynamicLighting enum
  // w = WebGL-convention camera height for the altitude-opacity ramp
  //     (`czm_eyeHeight + atmosphereInnerRadius`, SkyAtmosphereCommon.glsl
  //     L104) — NOT |cameraPositionWC|, which differs by radiusAdjust
  radiiAndDynamicAtmosphere: vec4<f32>,
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
  // Session 65 Batch 42 — Phase 4 completion. Wind state pre-emptively
  // plumbed for Phase 5 (volumetric fog advection), Phase 6 (cloud
  // motion in raymarched + procedural cloud layers), and the sibling
  // water-rendering design (wave displacement modulation).
  //
  // Source: `frameState.atmosphericConditions.weather.{windSpeed,
  // windDirection}`. WindSpeed is in m/s; windDirection is a normalized
  // 3-vector in WORLD coords (Earth-relative). Both pack into a single
  // vec4 to keep the uniform layout compact:
  //   xyz = windDirectionWC (normalized; defaults to (0, 0, 1))
  //   w   = windSpeed m/s (defaults to 0 = calm)
  //
  // No fragment shader path consumes these yet — they are scaffolding
  // ahead of Phase 5/6. Adding them now keeps the uniform buffer
  // layout stable when those phases land so SkyAtmosphere bind groups
  // don't need to be rebuilt later.
  windDirectionAndSpeed: vec4<f32>,
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
// Batch 247 (NEW-GROUND-VIEW-ENV-DIVERGENCES fix 1) — `computeScattering`
// below is now a 1:1 port of WebGL's `czm_computeScattering`
// (Builtin/Functions/computeScattering.glsl): 16/4 max steps with the
// adaptive `w_inside_atmosphere` / `w_stop_gt_lprl` step-count and
// stride scheme, INCLUDING its quadrature quirks (first sample one full
// step from the ray start, `total/7` stride inside the atmosphere).
// The previous 64-step uniform-stride midpoint march was numerically
// *more* converged than WebGL — which is exactly why it diverged:
// WebGL's coarse inside-atmosphere quadrature undershoots the converged
// Rayleigh integral, so the near-converged WGSL sky rendered ~1.5×
// brighter at ground level even with identical coefficients and shell
// geometry. Parity means matching WebGL's *output*, not the ideal
// integral. (The earlier 64-step bump that fixed "no halo at orbit"
// is preserved by this port too: at orbit `w_inside_atmosphere ≈ 0`
// → 16 uniform steps from the shell entry point — the same sampling
// WebGL uses to render its orbit halo.)
const PRIMARY_STEPS_MAX: i32 = 16;
const LIGHT_STEPS_MAX: i32 = 4;

// Port of czm_approximateTanh (Builtin/Functions/approximateTanh.glsl).
fn approximateTanh(x: f32) -> f32 {
  let x2 = x * x;
  return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}

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

// 1:1 port of czm_computeScattering (computeScattering.glsl) followed by
// czm_computeAtmosphereColor's phase/intensity combine. `rayOrigin` is the
// CAMERA world position (GLSL `primaryRay.origin`) and `primaryRayLength`
// is the camera→shell-fragment distance (GLSL `length(cameraToPositionWC)`)
// — NOT a pre-clamped march segment; the function derives its own start/
// stop exactly like the GLSL (no earth-surface clipping: WebGL doesn't
// test the inner sphere here, and below-horizon fragments are overdrawn
// by the globe anyway).
fn computeScattering(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  primaryRayLength: f32,
  sunDir: vec3<f32>,
  innerRadius: f32,
  outerRadius: f32,
) -> vec3<f32> {
  let atmosphereThickness = outerRadius - innerRadius;

  // Intersection from the camera to the outer ring of the atmosphere.
  let intersect = raySphereIntersect(rayOrigin, rayDir, outerRadius);
  if (intersect.y < 0.0) {
    // GLSL czm_emptyRaySegment case — no scattering.
    return vec3<f32>(0.0);
  }

  // Sky-or-horizon soft split weight (GLSL w_stop_gt_lprl).
  let x = 1e-7 * intersect.y / primaryRayLength;
  let w_stop_gt_lprl = 0.5 * (1.0 + approximateTanh(x));

  // Ray starts at the shell entry (or camera when inside); ends at the
  // shell exit or the fragment distance, whichever is smaller.
  let start_0 = intersect.x;
  let tStart = max(intersect.x, 0.0);
  let tStop = min(intersect.y, primaryRayLength);

  // Inside-vs-outside atmosphere weight → adaptive step counts.
  let x_o_a = start_0 - atmosphereThickness;
  let w_inside_atmosphere = 1.0 - 0.5 * (1.0 + approximateTanh(x_o_a));
  let primarySteps = PRIMARY_STEPS_MAX - i32(w_inside_atmosphere * 12.0);
  let lightSteps = LIGHT_STEPS_MAX - i32(w_inside_atmosphere * 2.0);

  var rayPositionLength = tStart;
  let totalRayLength = tStop - rayPositionLength;
  let rayStepLengthIncrease = w_inside_atmosphere *
    ((1.0 - w_stop_gt_lprl) * totalRayLength /
      (f32(primarySteps * (primarySteps + 1)) / 2.0));
  var rayStepLength = max(1.0 - w_inside_atmosphere, w_stop_gt_lprl) *
    totalRayLength / max(7.0 * w_inside_atmosphere, f32(primarySteps));

  var rayleighAccumulation = vec3<f32>(0.0);
  var mieAccumulation = vec3<f32>(0.0);
  var opticalDepth = vec2<f32>(0.0);
  let heightScale = vec2<f32>(u.rayleighScaleHeight, u.mieScaleHeight);

  for (var i: i32 = 0; i < PRIMARY_STEPS_MAX; i++) {
    if (i >= primarySteps) {
      break;
    }

    // Sample position along the view ray — one full step from the start,
    // matching the GLSL exactly (NOT midpoint).
    let samplePosition = rayOrigin + rayDir * (rayPositionLength + rayStepLength);
    let sampleHeight = length(samplePosition) - innerRadius;
    let sampleDensity = exp(-sampleHeight / heightScale) * rayStepLength;
    opticalDepth += sampleDensity;

    // Light ray from the sample to the outer ring of the atmosphere.
    let lightIntersect = raySphereIntersect(samplePosition, sunDir, outerRadius);
    let lightStepLength = lightIntersect.y / f32(lightSteps);
    var lightPositionLength = 0.0;
    var lightOpticalDepth = vec2<f32>(0.0);

    for (var j: i32 = 0; j < LIGHT_STEPS_MAX; j++) {
      if (j >= lightSteps) {
        break;
      }
      let lightPosition = samplePosition +
        sunDir * (lightPositionLength + lightStepLength * 0.5);
      let lightHeight = length(lightPosition) - innerRadius;
      lightOpticalDepth += exp(-lightHeight / heightScale) * lightStepLength;
      lightPositionLength += lightStepLength;
    }

    let attenuation = exp(
      -((u.mieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) +
        (u.rayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x)))
    );

    rayleighAccumulation += sampleDensity.x * attenuation;
    mieAccumulation += sampleDensity.y * attenuation;

    // GLSL: rayPositionLength += (rayStepLength += rayStepLengthIncrease);
    rayStepLength += rayStepLengthIncrease;
    rayPositionLength += rayStepLength;
  }

  // czm_computeAtmosphereColor combine: phase functions × accumulated
  // scattering × light intensity. (The GLSL's transmittance `opacity`
  // output is discarded by SkyAtmosphereCommon.glsl L106, which
  // overwrites it with the altitude ramp — mirrored in fragmentMain.)
  let cosAngle = dot(rayDir, sunDir);
  let rayleighPhase = rayleighPhaseFunction(cosAngle);
  let miePhase = miePhaseFunction(cosAngle, u.mieAnisotropy);

  return u.intensity * (
    rayleighPhase * u.rayleighCoefficient * rayleighAccumulation +
    miePhase * u.mieCoefficient * mieAccumulation
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
  // Above the atmosphere shell the clamped vCoord otherwise produces identical
  // haze at every orbital altitude. Fade the inscatter contribution above
  // the atmosphere so it tapers off \u2014 but with a scale-height much larger
  // than the atmosphere shell thickness, so the halo stays visible across
  // typical orbit views (5\u201340 Mm above Earth) where WebGL clearly shows
  // it. Previous scale (1\u00d7 thickness \u2248 160 km on Earth) collapsed the
  // halo to zero by LEO (Hello World at 5.6 Mm above shell \u2192 exp(-35) \u2248
  // 0). Using the inner planet radius (~Earth's 6378 km) as the
  // scale-height stretches the falloff to "perceptibly visible up to
  // ~3 Earth radii out, faded but present at GEO" \u2014 empirically that
  // matches the WebGL halo extent. See Session 65 cont. atmosphere
  // investigation. Camera ALTITUDE inside the shell (0..thickness) the
  // falloff is identity (exp(0) = 1), so ground-level / low-LEO views
  // are unaffected.
  let excessAltitude = max(0.0, altitude - thickness);
  let orbitScaleHeight = max(thickness, innerRadius);
  let orbitFalloff = exp(-excessAltitude / orbitScaleHeight);
  // Session 65 Batch 27 (NEW-VR2-3b limb halo fix) — the LUT compute
  // shader (`AtmosphereLUT.wgsl::computeInscatter` L241-242) already
  // multiplies the stored inscatter by `params.intensity` at bake
  // time. The previous `* u.intensity` here applied intensity a
  // SECOND time, producing an effective `intensity² × inscatter`
  // (~2500× when intensity = 50) which was the root cause of the
  // over-bright limb halo + sub-solar glare patch on orbit views
  // (Hello World, Sentinel-2, Star Burst). Real orbital photography
  // shows a subtle Rayleigh-dominated blue limb; matching that
  // requires the single intensity multiplication that the LUT bake
  // already provides. `orbitFalloff` stays as the runtime-only
  // attenuation curve since it depends on per-frame camera altitude,
  // not LUT-baked state.
  return s.rgb * orbitFalloff;
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

// Khronos PBR Neutral tonemap — port of WebGL czm_pbrNeutralTonemapping
// (packages/engine/Source/Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl).
// Identity for inputs ≤ 0.76; gentle peak compression with saturation
// preservation above. Used below to bring the linear-HDR scattered
// radiance into SDR display space before the sRGB encode, matching
// WebGL SkyAtmosphereFS.glsl's `czm_pbrNeutralTonemapping ->
// czm_inverseGamma` pair under `#ifndef HDR`.
fn pbrNeutralTonemapSky(color: vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) { return c; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3<f32>(newPeak), vec3<f32>(g));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let innerRadius = u.radiiAndDynamicAtmosphere.x;
  let outerRadius = u.radiiAndDynamicAtmosphere.y;

  let rayDir = normalize(input.cameraToVertex);
  // Batch 247 — WebGL-convention camera height (eyeHeight + adjusted
  // inner radius, packed CPU-side) for the altitude-opacity ramp;
  // |cameraPositionWC| differs from it by the WebGL radiusAdjust.
  let cameraHeight = u.radiiAndDynamicAtmosphere.w;

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
  // Decide between LUT vs inline ray-march. The LUT was generated for
  // camera positions inside the atmosphere shell [innerRadius,
  // outerRadius]; the V coordinate clamps to 1.0 at the edge, so for
  // orbit-altitude cameras (5–40 Mm above Earth in typical sandcastles)
  // the LUT keeps returning the EDGE value and the inscatter visibly
  // collapses (Hello World, Star Burst, every orbit-view demo).
  // Session 65 cont. atmosphere investigation root cause.
  //
  // Fix: when the camera sits well above the shell, fall back to the
  // inline `computeScattering` ray-march which handles camera-outside-
  // atmosphere geometry correctly via the rayStart/rayEnd intersection
  // math above. The 2× threshold gives a smooth crossover — well inside
  // the atmosphere the LUT path stays optimized (single texture
  // sample); orbital views ray-march per-fragment which is the path
  // WebGL takes too.
  let cameraHeightAboveShell = max(0.0, length(u.cameraPositionWC) - outerRadius);

  // Session 65 Batch 20 — `dynamicLighting` enum at `radiiAndDynamic
  // Atmosphere.z` (matches `DynamicAtmosphereLightingType.js`):
  //   0 = NONE        → light direction is per-fragment `normalize
  //                     (positionWC)` ("lit from directly above").
  //                     Mirrors upstream
  //                     `czm_getDynamicAtmosphereLightDirection.glsl`.
  //   1 = SCENE_LIGHT → use the uniform direction (JS packs
  //                     `lightDirectionWC` into `sunDirectionWC` for
  //                     this case — see WebGPUSkyAtmosphereRenderer
  //                     Batch 18).
  //   2 = SUNLIGHT    → use the uniform direction (JS packs the true
  //                     sun direction).
  // The NONE case can't use the precomputed inscatter LUT because the
  // LUT was baked for a single fixed light direction; per-fragment
  // light direction needs the inline `computeScattering` ray-march.
  let dynamicLighting = u.radiiAndDynamicAtmosphere.z;
  let isNoneCase = dynamicLighting < 0.5;
  var lightDirWC: vec3<f32>;
  if (isNoneCase) {
    lightDirWC = normalize(input.worldPosition);
  } else {
    lightDirWC = u.sunDirectionWC;
  }

  let useLutPath =
    !isNoneCase &&
    u.useLut > 0.5 &&
    cameraHeightAboveShell < (outerRadius - innerRadius) * 2.0;

  var color: vec3<f32>;
  if (useLutPath) {
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
    // Batch 247 — czm_computeScattering port takes the CAMERA origin and
    // the camera→shell-fragment distance (GLSL primaryRayLength) and
    // derives its own start/stop internally.
    color = computeScattering(
      u.cameraPositionWC,
      rayDir,
      length(input.cameraToVertex),
      lightDirWC,
      innerRadius,
      outerRadius,
    );
  }

  // Session 65 Batch 27 (NEW-VR2-3b limb halo fix) — match WebGL's
  // post-scattering pipeline order:
  //   linear scatter → czm_pbrNeutralTonemapping → czm_inverseGamma
  //   → czm_applyHSBShift → output
  //
  // Pre-Batch-27 the WGSL applied `1 - exp(-x)` exposure curve INSTEAD
  // of PBR Neutral. That curve saturates faster (Reinhard-like) and
  // produced the over-bright sub-solar glare patch + cyan/white limb
  // haze visible on Hello World, Sentinel-2, Star Burst. PBR Neutral
  // has a softer shoulder + preserves saturation, matching real-camera
  // tonemap behavior.
  //
  // HSB shift moved to AFTER tonemap+gamma so the shift operates on
  // perceptual SDR values (matches WebGL ordering at
  // SkyAtmosphereFS.glsl L41-47).
  var finalColor = pbrNeutralTonemapSky(color);
  // sRGB encode (czm_inverseGamma equivalent — approximate 1/2.2 gamma).
  finalColor = pow(max(finalColor, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
  if (abs(u.hsbShift.x) > 0.001 || abs(u.hsbShift.y) > 0.001 || abs(u.hsbShift.z) > 0.001) {
    var hsb = rgbToHsb(finalColor);
    hsb.x = fract(hsb.x + u.hsbShift.x);
    hsb.y = clamp(hsb.y + u.hsbShift.y, 0.0, 1.0);
    hsb.z = clamp(hsb.z + u.hsbShift.z, 0.0, 1.0);
    finalColor = hsbToRgb(hsb);
  }

  // Batch 53 — port WebGL's altitude-based opacity from
  // SkyAtmosphereCommon.glsl:72-80. The previous WGSL "geometric path
  // ratio" formula (`1 - exp(-2 * pathRatio)`) was tuned for ground-
  // level views but produced opacity ≈ 0.86 even at orbital altitude
  // (where rayLength ≈ shellThickness perpendicular through the shell),
  // making the atmosphere shell render as a thick over-bright halo
  // that bled into the globe disc and made the globe appear smaller
  // and darker than in WebGL. The visible "ring" the user kept
  // reporting was this halo.
  //
  // WebGL formula: opacity decays linearly with camera altitude above
  // the atmosphere shell — fully opaque at ground (cameraHeight ≈
  // innerRadius), fully transparent at orbit (cameraHeight > outerRadius).
  // Then modulated by nightAlpha so the night side fades to space.
  //
  // The mix-against-blue floor is preserved so the visible halo at
  // orbit still leans sky-blue (matches WebGL's `mix(color.b, 1.0,
  // opacity)`).
  let altitudeOpacity = clamp(
    (outerRadius - cameraHeight) / max(1.0, outerRadius - innerRadius),
    0.0,
    1.0,
  );
  // nightAlpha: 1.0 on day side, 0.0 on night side. Only applied when
  // dynamic atmosphere lighting is enabled (radiiAndDynamicAtmosphere.z != 0).
  let isDynamic = u.radiiAndDynamicAtmosphere.z != 0.0;
  let nightAlpha = select(
    1.0,
    clamp(dot(normalize(input.worldPosition), lightDirWC), 0.0, 1.0),
    isDynamic,
  );
  let opacity = altitudeOpacity * pow(nightAlpha, 0.5);
  let alpha = mix(finalColor.b, 1.0, opacity);
  return vec4<f32>(finalColor, alpha);
}
