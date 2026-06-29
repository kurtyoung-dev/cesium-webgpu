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
  //   y = multipleScatteringEnabled (Batch 427 SKY-MS) — when > 0.5 the
  //       fragment shader ADDS the precomputed multiple-scattering LUT term to
  //       the single-scatter sky color (Hillaire 2020 / Bruneton MS). Raises
  //       the horizon + shadowed-limb radiance that single scatter leaves too
  //       dark. The renderer sets this only when the user opt-in
  //       `skyAtmosphere.multipleScattering` is on AND the MS LUT is baked, so
  //       the default (0) is byte-identical to single scatter.
  //   z = useSkyViewLut (Batch 428 A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-
  //       RELATIVE) — when > 0.5 the fragment shader REPLACES the inline
  //       czm_computeScattering march with a single sample of the sun-relative
  //       sky-view LUT (Hillaire 2020), which is correct at ANY view azimuth
  //       relative to the sun (the old inscatter LUT could only represent the
  //       sun meridian). The renderer sets this only when the user opt-in
  //       `skyAtmosphere.useScatteringLut` is on AND the sky-view LUT is baked,
  //       so the default (0) keeps the inline march — byte-identical to today.
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
  // Fullscreen-sky path (view-independent sky option). The shell-mesh path
  // ignores these; the fullscreen path reconstructs the per-pixel world ray
  // from screen UV with them (mirrors the cloud renderer's getWorldRay). Packed
  // at float offsets 68 (inverseProjection) and 84 (inverseView).
  inverseProjection: mat4x4<f32>,
  inverseView: mat4x4<f32>,
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
// Batch 427 (SKY-MS) + Batch 429 (A-LUT-REPARAM follow-up) — multiple-scattering
// LUT (256×128). As of Batch 429 it is baked on the SAME sun-relative sky-view
// domain as the sky-view LUT (binding 6): relative view↔sun azimuth × Hillaire-
// warped view-zenith — NOT the old azimuth-flat (cosViewZenith × altitude)
// inscatter mapping. That gives the MS add a view–sun azimuth axis so it lifts
// the sky at ALL azimuths, closing the off-meridian gap the 427 add had. Baked
// by AtmosphereLUT.wgsl::computeMultipleScattering whenever the sun direction
// changes (chained after the single-scatter bake). Bound unconditionally so the
// pipeline layout never changes; the fragment shader only ADDS its contribution
// (via `sampleMultipleScatterLut`, same UV mapping as the sky-view sample) when
// `u.debug.y > 0.5` (the opt-in `skyAtmosphere.multipleScattering` flag, set by
// the renderer only when the MS LUT is actually baked). With the flag off the
// texture is never sampled, so the default sky is byte-identical.
@group(1) @binding(5) var multipleScatterLut: texture_2d<f32>;
// Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) — sun-relative
// sky-view LUT (256×128). Parameterized by (relative view↔sun azimuth ×
// Hillaire-warped view-zenith) at a baked ground-level observer, so it can
// represent sky radiance at ANY view azimuth relative to the sun — unlike the
// inscatter LUT (binding 2) whose (cosViewZenith × altitude) mapping only
// covers the sun meridian. Baked by AtmosphereLUT.wgsl::computeSkyView. Bound
// unconditionally so the pipeline layout never changes; only sampled when
// `u.debug.z > 0.5` (the opt-in `skyAtmosphere.useScatteringLut` flag, set by
// the renderer only when the LUT is baked). With the flag off the texture is
// never sampled → byte-identical to the inline-march sky.
@group(1) @binding(6) var skyViewLut: texture_2d<f32>;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) cameraToVertex: vec3<f32>,
  @location(2) uv: vec2<f32>, // fullscreen-path screen UV (shell path leaves 0)
};

// Reconstruct the world-space view ray from screen UV (fullscreen sky path).
// Mirror of the cloud renderer's getWorldRay (ProceduralClouds.wgsl) — the proven
// on-backend per-pixel ray reconstruction. NDC z=1 (far) so the inverse projection
// yields a far-plane point; w-zeroed before the inverse view to get a direction.
fn getWorldRay(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  var viewDir = u.inverseProjection * ndc;
  viewDir.w = 0.0;
  let worldDir = u.inverseView * viewDir;
  return normalize(worldDir.xyz);
}

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
  output.uv = vec2<f32>(0.0, 0.0);
  return output;
}

// Fullscreen-triangle vertex for the view-independent sky path. No vertex
// buffer — the 3 verts come from @builtin(vertex_index). Pinned to the far
// plane (z=w → NDC z=1) so the globe occludes it via the pipeline's less-equal
// depth compare (depthWrite=false). The fragment reconstructs the per-pixel ray
// from uv, so this path has none of the shell mesh's ground-view coverage gap.
@vertex
fn vertexMainFullscreen(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var output: VertexOutput;
  // Oversized single triangle covering all of NDC [-1,1] (verts (-1,-1),(3,-1),
  // (-1,3)) — full coverage with 3 verts, draw(3), triangle-list.
  let tx = f32((vid << 1u) & 2u); // 0, 2, 0
  let ty = f32(vid & 2u); // 0, 0, 2
  output.position = vec4<f32>(tx * 2.0 - 1.0, ty * 2.0 - 1.0, 1.0, 1.0); // z=1 far
  output.uv = vec2<f32>(tx, ty); // uv*2-1 == NDC; getWorldRay reconstructs the ray
  output.cameraToVertex = vec3<f32>(0.0, 0.0, 1.0); // unused on this path
  output.worldPosition = u.cameraPositionWC;
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

// Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) — sample the
// sun-relative sky-view LUT. Inverts the parameterization that
// AtmosphereLUT.wgsl::computeSkyView laid out:
//   U = relativeAzimuth(viewDir, sunDir) / π     (sky symmetric about the
//       sun meridian → half-plane [0, π] covers all azimuths)
//   V = 0.5 + 0.5 * sign(cosViewZenith) * sqrt(|cosViewZenith|)
//         (Hillaire non-linear horizon warp — concentrates texels at the
//          horizon band where the sky gradient is steepest)
// `up` is the local vertical at the observer; `rayDir` and `sunDir` are unit
// world vectors. Returns the baked combined Rayleigh+Mie inscatter (intensity
// already applied at bake time, matching the inscatter LUT convention), so the
// result drops straight into the tonemap like sampleScatteringLut.
fn sampleSkyViewLut(
  up: vec3<f32>,
  rayDir: vec3<f32>,
  sunDir: vec3<f32>,
) -> vec3<f32> {
  let cosViewZenith = clamp(dot(rayDir, up), -1.0, 1.0);
  // Hillaire horizon warp (forward map matching the bake's inverse).
  let vCoord = clamp(
    0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith)),
    0.0,
    1.0,
  );

  // Relative azimuth between the view and the sun, measured in the horizon
  // plane (project both onto the plane ⟂ up). Robust near the zenith where the
  // horizontal projections shrink: fall back to azimuth 0 (toward sun) so the
  // sample stays continuous rather than spinning.
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

  let s = textureSampleLevel(
    skyViewLut, lutSampler, vec2<f32>(uCoord, vCoord), 0.0,
  );
  return max(s.rgb, vec3<f32>(0.0));
}

// Batch 429 (A-LUT-REPARAM follow-up / SKY-MS all-azimuth) — sample the
// multiple-scattering LUT, which is now baked on the SAME sun-relative sky-view
// domain as `computeSkyView` (relative view↔sun azimuth × Hillaire-warped
// view-zenith) instead of the old azimuth-flat (cosViewZenith × altitude)
// inscatter mapping. The (U, V) derivation here is IDENTICAL to
// `sampleSkyViewLut` so the MS add agrees directionally with the single-scatter
// sky-view fast-path: the MS lift is now strongest toward the bright sky and
// correct at every azimuth, closing the off-meridian gap that left the SKY-MS
// add (Batch 427) directionally flat. Returns the baked MS radiance (intensity
// already applied at bake time, matching the inscatter/sky-view convention).
fn sampleMultipleScatterLut(
  up: vec3<f32>,
  rayDir: vec3<f32>,
  sunDir: vec3<f32>,
) -> vec3<f32> {
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

  let s = textureSampleLevel(
    multipleScatterLut, lutSampler, vec2<f32>(uCoord, vCoord), 0.0,
  );
  return max(s.rgb, vec3<f32>(0.0));
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

// Shared sky scattering for one camera ray. Used by BOTH the shell-mesh path
// (fragmentMain, rayDir from the interpolated shell vertex) and the fullscreen
// path (fragmentMainFullscreen, rayDir from getWorldRay(uv)). The math is
// identical; only the ray SOURCE differs. Rays that miss the atmosphere or whose
// segment is degenerate return a fully-transparent color (alpha 0) — equivalent
// to the old `discard` under the alpha-over blend, but a function can't discard.
fn skyColorForRay(rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> vec4<f32> {
  let innerRadius = u.radiiAndDynamicAtmosphere.x;
  let outerRadius = u.radiiAndDynamicAtmosphere.y;
  // Batch 247 — WebGL-convention camera height (eyeHeight + adjusted
  // inner radius, packed CPU-side) for the altitude-opacity ramp;
  // |cameraPositionWC| differs from it by the WebGL radiusAdjust.
  let cameraHeight = u.radiiAndDynamicAtmosphere.w;

  // Determine ray intersections
  let atmosphereIntersect = raySphereIntersect(rayOrigin, rayDir, outerRadius);

  if (atmosphereIntersect.y < 0.0) {
    return vec4<f32>(0.0);
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
    return vec4<f32>(0.0);
  }

  // The sky point along this ray (rayDir is unit, so distance == rayEnd). Used
  // for the "lit from above" light dir, the primary ray length, and the
  // day/night term — replaces the shell path's per-vertex worldPosition.
  let skyPoint = rayOrigin + rayDir * rayEnd;

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
    lightDirWC = normalize(skyPoint);
  } else {
    lightDirWC = u.sunDirectionWC;
  }

  let useLutPath =
    !isNoneCase &&
    u.useLut > 0.5 &&
    cameraHeightAboveShell < (outerRadius - innerRadius) * 2.0;

  // Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) — sun-relative
  // sky-view LUT fast-path. Opt-in via `skyAtmosphere.useScatteringLut`
  // (renderer packs it into `u.debug.z` only when the LUT is baked). Unlike the
  // inscatter LUT (`useLutPath`), the sky-view LUT carries a view↔sun azimuth
  // axis, so it is correct off the sun meridian. Gated to NON-NONE dynamic-
  // lighting (the LUT bakes a single light direction) and to cameras near/inside
  // the shell (same orbit crossover as the inscatter LUT — above that the inline
  // march handles camera-outside geometry). Highest priority so the user opt-in
  // wins over the inscatter fast-path when both happen to be enabled.
  let useSkyViewLut =
    !isNoneCase &&
    u.debug.z > 0.5 &&
    cameraHeightAboveShell < (outerRadius - innerRadius) * 2.0;

  var color: vec3<f32>;
  if (useSkyViewLut) {
    // Local vertical at the observer (LUT baked at ground level → up ≈ the
    // normalized camera position). rayDir + sun direction give the azimuth.
    let up = normalize(u.cameraPositionWC);
    color = sampleSkyViewLut(up, rayDir, lightDirWC);
  } else if (useLutPath) {
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
      rayEnd,
      lightDirWC,
      innerRadius,
      outerRadius,
    );
  }

  // Batch 427 (SKY-MS) + Batch 429 (A-LUT-REPARAM follow-up) — opt-in
  // multiple-scattering add (Hillaire 2020 / Bruneton MS). `u.debug.y > 0.5` is
  // the renderer's gated `skyAtmosphere.multipleScattering` flag (only set when
  // the MS LUT is baked). As of Batch 429 the MS LUT is baked on the SAME
  // sun-relative sky-view domain (relative view↔sun azimuth × Hillaire-warped
  // view-zenith) as `computeSkyView`, so it now carries a view–sun azimuth axis
  // and lifts the sky at ALL azimuths — not just the meridian. We sample it
  // through `sampleMultipleScatterLut`, whose (U, V) derivation is identical to
  // `sampleSkyViewLut`, so the MS add agrees directionally with the
  // single-scatter sky-view fast-path. The result has `intensity` already baked
  // in (it is NOT re-applied here) and is ADDED to the single-scatter color
  // BEFORE tonemapping — lifting the horizon and shadowed-limb radiance that
  // single scattering alone leaves too dark, while the shared tonemap shoulder
  // keeps the zenith from blowing out. The off-meridian directional lift the
  // 427 add was missing is now closed by the re-param. With the flag off
  // (default) the texture is never sampled and the sky is byte-identical.
  if (u.debug.y > 0.5) {
    // Local vertical at the observer (LUT baked at ground level → up ≈ the
    // normalized camera position); rayDir + the SUN direction give the azimuth.
    // The MS LUT was baked against the WORLD sun (frameState.sunDirectionWC),
    // so the azimuth reference MUST be `u.sunDirectionWC` — NOT `lightDirWC`,
    // which in the NONE dynamic-lighting mode (the default) is the per-fragment
    // `normalize(skyPoint)` "lit from above" direction. Using lightDirWC there
    // measures the azimuth against the wrong vector and flattens the MS add to a
    // view-uniform veil even though the LUT itself is fully directional. The
    // sky-view fast-path above sidesteps this because it is gated to non-NONE
    // lighting (where lightDirWC == u.sunDirectionWC); the MS add is NOT so
    // gated, so it must reference the sun explicitly.
    let upDir = normalize(u.cameraPositionWC);
    let msColor = sampleMultipleScatterLut(upDir, rayDir, u.sunDirectionWC);
    // Conservative scale. As of Batch 429 the MS LUT carries the FULL single-
    // scatter sky-view radiance × f_ms (0.5) — i.e. it is now a sizeable
    // fraction of the sky's own brightness, not the tiny gather output the 427
    // LUT held. So the perceptual scale here is correspondingly smaller: at the
    // old 0.18 the add lifted the zenith by ~14% (over-bright veil). 0.02× lands
    // the lift back in the "tasteful" band — a measurable, now-DIRECTIONAL
    // deepening of the horizon/limb radiance (clearly stronger toward the bright
    // sky thanks to the sky-view re-param, see the 22.6× azimuth spread in the
    // MS LUT) that still preserves the blue hue and the warm sunset band,
    // reading as a richer all-around atmosphere rather than a flat veil.
    // Perceptual constant, not physical.
    const MS_SCALE: f32 = 0.06;
    color = color + max(msColor, vec3<f32>(0.0)) * MS_SCALE;
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
    clamp(dot(normalize(skyPoint), lightDirWC), 0.0, 1.0),
    isDynamic,
  );
  let opacity = altitudeOpacity * pow(nightAlpha, 0.5);
  let alpha = mix(finalColor.b, 1.0, opacity);
  return vec4<f32>(finalColor, alpha);
}

// Shell-mesh path entry — ray from the interpolated shell vertex.
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return skyColorForRay(u.cameraPositionWC, normalize(input.cameraToVertex));
}

// Fullscreen path entry — ray reconstructed per pixel from screen UV.
@fragment
fn fragmentMainFullscreen(input: VertexOutput) -> @location(0) vec4<f32> {
  return skyColorForRay(u.cameraPositionWC, getWorldRay(input.uv));
}
