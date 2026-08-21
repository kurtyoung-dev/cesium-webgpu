// SkyAtmosphere.wgsl — Nishita-style atmospheric scattering for CesiumJS WebGPU
// Renders an ellipsoid shell with Rayleigh + Mie scattering
//
// Paired shader: Shaders/SkyAtmosphere{VS,FS,Common}.glsl
// A change here must land with the matching change there.
// See SHADER_PAIRS_LOCKSTEP.md.
//
// References:
//   - Tomoyuki Nishita, Takao Sirai, Katsumi Tadamura and Eihachiro Nakamae,
//     "Display of the Earth Taking into Account Atmospheric Scattering"
//     (SIGGRAPH 1993) — the single-scattering integral the ray march below
//     evaluates, and the model this shader's WebGL twin also follows.
//   - Eric Bruneton and Fabrice Neyret, "Precomputed Atmospheric Scattering",
//     Computer Graphics Forum 27(4), 1079 (2008) —
//     https://hal.inria.fr/inria-00288758
//     The transmittance and inscatter table conventions the lookup path reads.
//   - Sebastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
//     Rendering Technique", Computer Graphics Forum 39(4), 13 (2020) —
//     https://sebh.github.io/publications/egsr2020.pdf
//     The multiple-scattering term and the sky-view parameterisation.
// Reimplemented from those papers; no reference source is incorporated.
//
// Structural differences from the paired GLSL shaders:
//
// 1. **Single file vs multi-file split.** GLSL splits the pipeline into
//    vertex, fragment, and common modules. WGSL keeps both entry points and
//    their helpers in this module, with Cesium builtins ported inline.
//
// 2. **Ray-march quadrature.** `computeScattering` matches the GLSL 16/4
//    adaptive step scheme, including its full-step primary samples. Rays that
//    strike the planet continue through its interior so extinction forms the
//    WebGL limb profile. WGSL alone clamps underground sample height to -150 km
//    because overflow from `exp` is indeterminate in WGSL; the clamp produces
//    deterministic total extinction.
//
// 3. **Per-vertex vs per-fragment.** GLSL can select vertex- or
//    fragment-evaluated scattering. WGSL always evaluates per fragment because
//    interpolated scattering exposes the shell mesh pattern at orbit altitude.
//
// 4. **LUT fast paths.** WebGL always ray marches because it has no compute
//    bake. WGSL retains a legacy inscatter lookup, but the renderer disables it
//    for the visible sky because its cosViewZenith-by-altitude mapping lacks a
//    view-to-sun azimuth axis. That mapping stays unchanged for fog, globe,
//    voxel, splat, and point-cloud consumers. A separate sun-relative sky-view
//    LUT supplies the visible-sky lookup path.
//
// 5. **Dual-light scattering.** WGSL can add moon scattering from a second LUT
//    or inline march. GLSL has a single light source.
//
// 6. **Debug bypass output.** WGSL can emit flat magenta when
//    `u.debug.x > 0.5`; GLSL has no shader-local equivalent.
//
// 7. **Wind state.** WGSL reserves `windDirectionAndSpeed` in the uniform
//    layout, although this shader does not consume it. GLSL has no equivalent.
//
// 8. **Tonemap chain.** WGSL always applies PBR Neutral tonemapping, sRGB
//    encoding, and then any HSB shift. GLSL guards parts of that sequence with
//    HDR and color-correction defines because its HDR composite is plumbed
//    differently.
//
// 9. **RTE vs `czm_model` vertex transform.** GLSL VS uses
//    `czm_model * position`; WGSL uses the renderer-wide relative-to-eye path.
//    The centered atmosphere shell does not itself require RTE precision.
//
// 10. **Translucent-globe brightening.** GLSL has `#ifdef
//     GLOBE_TRANSLUCENT`; WGSL uses runtime gate `u.atmosControl.w > 0.5`.
//     Both substitute the same dark distance-faded horizon gradient for rays
//     through a translucent planet.
//
// 11. **Ellipsoid math (uniform vs builtins).** GLSL pulls
//     ellipsoid and viewer state from automatic uniforms. WGSL receives the
//     equivalent values in `Uniforms`, with the distance-adjusted inner radius
//     already computed on the CPU.
//
// 12. **Light-direction selection.** GLSL calls the shared builtin
//     `czm_getSkyAtmosphereLightDirection(positionWC, lightEnum)` from
//     both stages. WGSL inlines the same selection because it has no builtin
//     include mechanism: `NONE` and `SUNLIGHT` use the astronomical sun,
//     `SCENE_LIGHT` uses the packed scene light, and `LEGACY_OVERHEAD` uses
//     local up. Keep `Tools/visual-regression/sky-light-direction.spec.mjs`
//     aligned with both implementations.

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
  // x = innerRadius — WebGL scattering-shell inner radius, computed as
  //     `(|cameraWC| - eyeHeight) - radiusAdjust`
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
  //   y = multipleScatteringEnabled — when > 0.5, add the precomputed
  //       multiple-scattering term. It raises horizon and shadowed-limb
  //       radiance that single scattering leaves too dark. The renderer sets
  //       the flag only when the option is enabled and the LUT is baked.
  //   z = useSkyViewLut — when > 0.5, replace the inline march with one sample
  //       from the sun-relative sky-view LUT. Unlike the legacy inscatter
  //       table, this separate LUT represents every view-to-sun azimuth. The
  //       renderer sets the flag only when the option is enabled and the LUT
  //       is baked.
  //   w = unused
  debug: vec4<f32>,
  // The moon LUT is baked separately from the sun LUT. When dual-light
  // scattering is enabled, the fragment shader adds both contributions and
  // scales the moon term linearly by `moonPhaseFraction`.
  moonDirectionWC: vec3<f32>,
  _pad7: f32,
  // x = enableDualLightAtmosphere flag (0/1)
  // y = moonPhaseFraction (0..1)
  // z = moonIntensityScale (default 0.05 — moon is much dimmer than sun)
  // w = pad
  dualLightControl: vec4<f32>,
  // Packed wind state from
  // `frameState.atmosphericConditions.weather.{windSpeed, windDirection}`.
  // This shader does not consume the values, but the fixed slot keeps the
  // shared uniform layout stable. Direction is normalized in world coordinates
  // and speed is in metres per second:
  //   xyz = windDirectionWC (normalized; defaults to (0, 0, 1))
  //   w   = windSpeed m/s (defaults to 0 = calm)
  windDirectionAndSpeed: vec4<f32>,
  // Fullscreen-sky path (view-independent sky option). The shell-mesh path
  // ignores these; the fullscreen path reconstructs the per-pixel world ray
  // from screen UV with them (mirrors the cloud renderer's getWorldRay). Packed
  // at float offsets 68 (inverseProjection) and 84 (inverseView).
  inverseProjection: mat4x4<f32>,
  inverseView: mat4x4<f32>,
  // Optional atmosphere-physics gates. Zero selects the single-light
  // Henyey-Greenstein path without ozone:
  //   x = improvedMiePhase — select the Jendersie and d'Eon droplet phase
  //       approximation instead of single-g Henyey-Greenstein.
  //   y = dualLightInline — add an analytic moon-light scattering march to the
  //       inline path.
  //   z = ozoneEnabled — apply Chappuis-band extinction in the inline march.
  //       The CPU gates LUT ozone by zeroing its coefficient.
  //   w = reserved
  atmosControl: vec4<f32>,
  // Per-metre RGB Chappuis-band absorption coefficient. It contributes only
  // to inline-march extinction when `atmosControl.z > 0.5`; zero is identity.
  ozoneCoefficient: vec3<f32>,
  _pad8: f32,
  // Moon inputs for the inline dual-light path. `moonControl.x` is phase
  // fraction, `moonControl.y` is intensity scale, and z/w are reserved. These
  // fields are read only when `atmosControl.y > 0.5`.
  moonLightDirWC: vec3<f32>,
  _pad9: f32,
  moonControl: vec4<f32>,
  // Eclipse horizon twilight control at float offset 116.
  //   x = horizon gain as a multiple of the sky's luminance along the same ray.
  //       Zero skips the contribution.
  //   y/z/w = reserved
  eclipseControl: vec4<f32>,
  // Active atmosphere ellipsoid gradient weights at float offset 120.
  // xyz = 1 / (radii * radii); w-equivalent is the explicit pad below.
  ellipsoidInverseRadiiSquared: vec3<f32>,
  _pad10: f32,
};

// Keep these constants identical to `Shaders/SkyAtmosphereFS.glsl` and
// `Scene/EclipseState.js`.
// atan(25 km / 60 km): the elevation the sunlit penumbral atmosphere subtends
// from the middle of a ~120 km umbral track. Above it the observer is looking
// at umbral sky, so the band ends there.
const ECLIPSE_TWILIGHT_ELEVATION: f32 = 0.394791119699762;
// Rayleigh transmission exp(-0.5 * (550/lambda)^4) at 650/550/450 nm,
// normalised to a peak of 1 — the same physics that reddens a sunset, over the
// long slant path out to the penumbra.
const ECLIPSE_TWILIGHT_TINT: vec3<f32> = vec3<f32>(1.0, 0.784, 0.424);

@group(0) @binding(0) var<uniform> u: Uniforms;

// Match SkyAtmosphereFS.glsl's local-horizon calculation. The ellipsoid
// gradient is the geodetic up direction; radial then +Z fallbacks keep
// degenerate inputs from reaching normalize(vec3(0.0)).
fn getEclipseObserverUp(
  positionWC: vec3<f32>,
  ellipsoidInverseRadiiSquared: vec3<f32>,
) -> vec3<f32> {
  var radialUp = vec3<f32>(0.0, 0.0, 1.0);
  let radialMagnitudeSquared = dot(positionWC, positionWC);
  if (radialMagnitudeSquared > 0.0) {
    radialUp = positionWC * inverseSqrt(radialMagnitudeSquared);
  }

  let geodeticGradient = positionWC * ellipsoidInverseRadiiSquared;
  let gradientMagnitudeSquared = dot(geodeticGradient, geodeticGradient);
  if (gradientMagnitudeSquared > 0.0) {
    return geodeticGradient * inverseSqrt(gradientMagnitudeSquared);
  }
  return radialUp;
}

// Precomputed atmosphere LUTs. Bound unconditionally so the pipeline
// layout never changes. The transmittance LUT (256×64) stores extinction
// along view rays of varying zenith angle and altitude; the inscatter LUT
// (256×128) is the full Rayleigh+Mie integral with the relevant light
// direction baked in by AtmosphereLUT.wgsl. Sampling the inscatter table
// replaces the 16-step ray march below with a single texture fetch.
//
// Moon LUTs at bindings 3 and 4 mirror the sun LUTs at bindings 1 and 2.
// Cleared moon textures keep the layout stable when dual-light scattering is
// disabled.
@group(1) @binding(0) var lutSampler: sampler;
@group(1) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(1) @binding(2) var inscatterLut: texture_2d<f32>;
@group(1) @binding(3) var moonTransmittanceLut: texture_2d<f32>;
@group(1) @binding(4) var moonInscatterLut: texture_2d<f32>;
// The 256-by-128 multiple-scattering LUT uses the sun-relative sky-view domain:
// relative view-to-sun azimuth by Hillaire-warped view zenith. The azimuth axis
// lets the contribution vary around the whole sky. `AtmosphereLUT.wgsl` bakes
// it after single scattering when the sun direction changes. The binding stays
// in the layout unconditionally and is sampled only when `u.debug.y > 0.5`.
@group(1) @binding(5) var multipleScatterLut: texture_2d<f32>;
// The separate 256-by-128 sky-view LUT uses relative view-to-sun azimuth and
// Hillaire-warped view zenith at a ground-level observer. Unlike the legacy
// inscatter mapping, it represents radiance away from the sun meridian. The
// binding stays in the layout unconditionally and is sampled only when
// `u.debug.z > 0.5`.
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
// Mirror the cloud renderer's `getWorldRay` in `ProceduralClouds.wgsl`. NDC z=1
// selects a far-plane point; clearing w before inverse view produces a
// direction.
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
  // Pin the triangle to the far plane.
  output.position = vec4<f32>(tx * 2.0 - 1.0, ty * 2.0 - 1.0, 1.0, 1.0);
  // `getWorldRay` reconstructs the ray from NDC-equivalent UV coordinates.
  output.uv = vec2<f32>(tx, ty);
  output.cameraToVertex = vec3<f32>(0.0, 0.0, 1.0); // unused on this path
  output.worldPosition = u.cameraPositionWC;
  return output;
}

// Constants
const PI: f32 = 3.14159265358979323846;
// Match WebGL's `czm_computeScattering` with 16 primary and 4 light steps,
// adaptive inside-atmosphere counts, full-step primary sample placement, and
// the `total / 7` inside-atmosphere stride. Matching these quadrature details
// preserves both ground radiance and the orbital halo.
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

// Draine phase function from Jendersie and d'Eon, "An Approximate Mie
// Scattering Function for Fog and Cloud Rendering" (2023). Its generalized
// Henyey-Greenstein form adds a physical forward peak and soft backscatter lobe
// for a more representative droplet aureole.
//   p(θ) = (1-g²) / (4π · (1 + α·(1+2g²)/3)) ·
//          (1 + α·cosθ²) / (1 + g² - 2g·cosθ)^(3/2)
// Alpha zero reduces to Henyey-Greenstein; alpha one supplies the water-droplet
// angular term used here.
fn drainePhaseFunction(cosAngle: f32, g: f32, alpha: f32) -> f32 {
  let g2 = g * g;
  let denom = pow(max(1.0 + g2 - 2.0 * g * cosAngle, 1e-4), 1.5);
  let norm = 4.0 * PI * (1.0 + alpha * (1.0 + 2.0 * g2) / 3.0);
  return ((1.0 - g2) / norm) * (1.0 + alpha * cosAngle * cosAngle) / denom;
}

// Jendersie & d'Eon 2023 approximate Mie phase: a weighted blend of a strongly
// forward HG lobe (large g_hg) and a Draine lobe (smaller g_d, α). The blend
// weight w and the two g's are the paper's droplet-size fit; we use a fixed
// mid-droplet parameterization (the published d≈10µm fit) that yields a tight
// forward peak plus a mild back-scatter rise — a clearly more physical aureole
// than single-g HG without needing a per-droplet-radius uniform.
fn improvedMiePhaseFunction(cosAngle: f32) -> f32 {
  let gHG: f32 = 0.85;   // forward HG lobe
  let gD: f32 = 0.35;    // Draine lobe asymmetry
  let alpha: f32 = 1.0;  // Draine angular term (Cornette-Shanks-like)
  let w: f32 = 0.4;      // blend weight toward the Draine lobe
  let hg = miePhaseFunction(cosAngle, gHG);
  let draine = drainePhaseFunction(cosAngle, gD, alpha);
  return mix(hg, draine, w);
}

// Select the droplet approximation only when `atmosControl.x > 0.5`; otherwise
// preserve the single-g Henyey-Greenstein phase.
fn miePhaseSelected(cosAngle: f32, g: f32) -> f32 {
  if (u.atmosControl.x > 0.5) {
    return improvedMiePhaseFunction(cosAngle);
  }
  return miePhaseFunction(cosAngle, g);
}

fn densityAtHeight(height: f32, scaleHeight: f32) -> f32 {
  return exp(-height / scaleHeight);
}

// Match `AtmosphereLUT.wgsl::ozoneDensity` so inline and baked extinction
// agree. The unitless linear tent peaks at 25 km and reaches zero at 10 and
// 40 km; the per-metre coefficient supplies its absorption magnitude.
fn ozoneDensityAtHeight(height: f32) -> f32 {
  let center = 25000.0;
  let halfWidth = 15000.0;
  return max(0.0, 1.0 - abs(height - center) / halfWidth);
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

  // Ozone is a pure absorber, so it contributes only to the Beer-Lambert
  // exponent and never to the scattering accumulators. A disabled gate selects
  // a zero coefficient.
  let ozoneEnabled = u.atmosControl.z > 0.5;
  let ozoneCoeff = select(vec3<f32>(0.0), u.ozoneCoefficient, ozoneEnabled);
  var ozoneOpticalDepth: f32 = 0.0;

  for (var i: i32 = 0; i < PRIMARY_STEPS_MAX; i++) {
    if (i >= primarySteps) {
      break;
    }

    // Sample position along the view ray — one full step from the start,
    // matching the GLSL exactly (NOT midpoint).
    let samplePosition = rayOrigin + rayDir * (rayPositionLength + rayStepLength);
    // Clamp underground height at -150 km. Deeper density would overflow f32,
    // whose result is indeterminate in WGSL; this floor keeps terms finite
    // while still forcing total extinction. Above-ground samples and shallow
    // sub-limb chords retain their unclamped values.
    let sampleHeight = max(length(samplePosition) - innerRadius, -150000.0);
    let sampleDensity = exp(-sampleHeight / heightScale) * rayStepLength;
    opticalDepth += sampleDensity;
    ozoneOpticalDepth += ozoneDensityAtHeight(sampleHeight) * rayStepLength;

    // Light ray from the sample to the outer ring of the atmosphere.
    let lightIntersect = raySphereIntersect(samplePosition, sunDir, outerRadius);
    let lightStepLength = lightIntersect.y / f32(lightSteps);
    var lightPositionLength = 0.0;
    var lightOpticalDepth = vec2<f32>(0.0);
    var lightOzoneOpticalDepth: f32 = 0.0;

    for (var j: i32 = 0; j < LIGHT_STEPS_MAX; j++) {
      if (j >= lightSteps) {
        break;
      }
      let lightPosition = samplePosition +
        sunDir * (lightPositionLength + lightStepLength * 0.5);
      // Same -150 km floor as the view-ray samples: light rays from
      // underground samples (or night-side samples shadowed by the
      // planet) must extinguish deterministically, not overflow.
      let lightHeight = max(length(lightPosition) - innerRadius, -150000.0);
      lightOpticalDepth += exp(-lightHeight / heightScale) * lightStepLength;
      lightOzoneOpticalDepth += ozoneDensityAtHeight(lightHeight) * lightStepLength;
      lightPositionLength += lightStepLength;
    }

    let attenuation = exp(
      -((u.mieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) +
        (u.rayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x)) +
        (ozoneCoeff * (ozoneOpticalDepth + lightOzoneOpticalDepth)))
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
  // Dispatch between the optional droplet phase and Henyey-Greenstein.
  let miePhase = miePhaseSelected(cosAngle, u.mieAnisotropy);

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
// A texture parameter lets the sun and moon paths share the UV mapping.
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
  // The LUT clamps altitude at its upper edge, which would otherwise produce
  // equal haze at every orbital altitude. Fade only the excess altitude using
  // the inner planet radius as scale height. This preserves WebGL's visible
  // orbital halo while leaving cameras inside the shell unchanged.
  let excessAltitude = max(0.0, altitude - thickness);
  let orbitScaleHeight = max(thickness, innerRadius);
  let orbitFalloff = exp(-excessAltitude / orbitScaleHeight);
  // The baked inscatter already includes `params.intensity`; applying it again
  // would square the light intensity. Only orbital falloff remains runtime
  // dependent because camera altitude is not baked into the table.
  return s.rgb * orbitFalloff;
}

// Sample the sun-relative sky-view LUT by inverting the parameterization in
// `AtmosphereLUT.wgsl::computeSkyView`:
//   U = relativeAzimuth(viewDir, sunDir) / PI
//   V = 0.5 + 0.5 * sign(cosViewZenith) * sqrt(abs(cosViewZenith))
// Mirror symmetry about the sun meridian lets [0, PI] cover all azimuths. The
// Hillaire warp concentrates texels around the horizon. The baked Rayleigh and
// Mie result already includes intensity.
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

// Sample multiple scattering on the same sun-relative domain and with the same
// UV derivation as `sampleSkyViewLut`. This keeps its directional contribution
// aligned with the single-scattering sky view. Bake-time intensity is already
// included.
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

// Khronos PBR Neutral tonemap, ported from WebGL
// `Builtin/Functions/pbrNeutralTonemapping.glsl`.
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

// Shared sky scattering for one camera ray. The shell-mesh path receives its
// ray from the interpolated vertex, while the fullscreen path reconstructs it
// with `getWorldRay`. Rays that miss the atmosphere or have a degenerate
// segment return transparent black because a helper function cannot discard.
fn skyColorForRay(rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> vec4<f32> {
  let innerRadius = u.radiiAndDynamicAtmosphere.x;
  let outerRadius = u.radiiAndDynamicAtmosphere.y;
  // Use WebGL's camera-height convention for the altitude-opacity ramp. The
  // CPU packs eye height plus adjusted inner radius because
  // `length(cameraPositionWC)` differs by `radiusAdjust`.
  let cameraHeight = u.radiiAndDynamicAtmosphere.w;

  // Determine ray intersections
  let atmosphereIntersect = raySphereIntersect(rayOrigin, rayDir, outerRadius);

  if (atmosphereIntersect.y < 0.0) {
    return vec4<f32>(0.0);
  }

  let earthIntersect = raySphereIntersect(rayOrigin, rayDir, innerRadius);
  var rayStart = max(0.0, atmosphereIntersect.x);
  // Do not stop at the earth surface. WebGL passes the full camera-to-shell
  // distance and clamps only at the outer-sphere exit, so planet-striking rays
  // continue through the interior. Their optical depth blacks out the hidden
  // disk and preserves the bright grazing peak plus shallow sub-limb extinction
  // tail. The underground height floor in `computeScattering` makes that
  // extinction deterministic under WGSL's overflow rules.
  let rayEnd = atmosphereIntersect.y;

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
  // Dual-light LUT scattering samples the separately baked moon table and
  // scales it by moon phase and intensity. The inline branch below uses an
  // analogous second analytic march.
  // Decide between LUT vs inline ray-march. The LUT was generated for
  // camera positions inside the atmosphere shell [innerRadius,
  // outerRadius]; the V coordinate clamps to 1.0 at the edge, so for
  // orbit-altitude cameras the LUT would keep returning its edge value. Above
  // twice the shell thickness, use the inline march so the ray intersections
  // handle camera-outside geometry. Cameras inside the shell retain the
  // single-sample LUT path.
  let cameraHeightAboveShell = max(0.0, length(u.cameraPositionWC) - outerRadius);

  // Resolve `DynamicAtmosphereLightingType` like the GLSL
  // `czm_getSkyAtmosphereLightDirection` helper. `NONE` and `SUNLIGHT` use the
  // astronomical sun, while `SCENE_LIGHT` uses the scene direction packed in
  // `sunDirectionWC`. `LEGACY_OVERHEAD` alone uses per-fragment local up and
  // therefore cannot use a LUT baked for one direction. Keep the enum value
  // unchanged because the day-night alpha ramp distinguishes `NONE` from the
  // dynamically lit modes.
  let dynamicLighting = u.radiiAndDynamicAtmosphere.z;
  let isLegacyOverhead = dynamicLighting > 2.5;
  var lightDirWC: vec3<f32>;
  if (isLegacyOverhead) {
    lightDirWC = normalize(skyPoint);
  } else {
    lightDirWC = u.sunDirectionWC;
  }
  // Restrict LUT eligibility to the two explicit scene-light modes. Keeping
  // `NONE` on inline scattering preserves the established eclipse path.
  let lutEligible = dynamicLighting > 0.5 && dynamicLighting < 2.5;

  // Translucent-globe sky path. Like the WebGL `GLOBE_TRANSLUCENT` branch, it
  // replaces full scattering through the planet with a distance- and
  // angle-faded navy gradient. This prevents bright blue radiance from flooding
  // the see-through disk. `u.atmosControl.w` supplies the runtime gate.
  if (u.atmosControl.w > 0.5 && earthIntersect.x > 0.0 && earthIntersect.y > 0.0) {
    // WebGL casts a ray from the (far-side) shell fragment toward the
    // ellipsoid centre to find the ground point under it; the far earth
    // intersection of the view ray is that same exit point in our ray form.
    let ugOnEarth = rayOrigin + rayDir * earthIntersect.y;
    // interpolateByDistance(vec4(0, 1, R, 0), |camera - onEarth|):
    // 1 at distance 0, fading to 0 at one Earth radius (clamped).
    let ugDistance = length(rayOrigin - ugOnEarth);
    let ugOpacity =
      1.0 - clamp(ugDistance / max(innerRadius, 1.0), 0.0, 1.0);
    // Camera↔exit-point central angle controls the color falloff.
    let ugAngle = dot(normalize(rayOrigin), normalize(ugOnEarth));
    let ugHorizonColor = vec3<f32>(0.1, 0.2, 0.3);
    let ugRayleigh = ugHorizonColor * (exp(-ugAngle) * ugOpacity);
    // computeAtmosphereColor with mieColor = 0 (GLSL leaves mie unset on
    // this path): rayleighPhase × rayleighColor × lightIntensity.
    let ugCosAngle = dot(rayDir, lightDirWC);
    let ugPhase = 3.0 / 50.2654824574 * (1.0 + ugCosAngle * ugCosAngle);
    var ugColor = ugPhase * ugRayleigh * u.intensity;
    // Same post-scattering pipeline as the main path (tonemap → gamma →
    // HSB); WebGL's FS skips ONLY the final alpha adjust when
    // underTranslucentGlobe == 1, so alpha stays the distance-ramp opacity.
    ugColor = pbrNeutralTonemapSky(ugColor);
    ugColor = pow(max(ugColor, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
    if (abs(u.hsbShift.x) > 0.001 || abs(u.hsbShift.y) > 0.001 || abs(u.hsbShift.z) > 0.001) {
      var ugHsb = rgbToHsb(ugColor);
      ugHsb.x = fract(ugHsb.x + u.hsbShift.x);
      ugHsb.y = clamp(ugHsb.y + u.hsbShift.y, 0.0, 1.0);
      ugHsb.z = clamp(ugHsb.z + u.hsbShift.z, 0.0, 1.0);
      ugColor = hsbToRgb(ugHsb);
    }
    return vec4<f32>(ugColor, ugOpacity);
  }

  let useLutPath =
    lutEligible &&
    u.useLut > 0.5 &&
    cameraHeightAboveShell < (outerRadius - innerRadius) * 2.0;

  // The separate sky-view LUT carries a view-to-sun azimuth axis, unlike the
  // legacy inscatter table. Use it only for eligible single-direction lighting
  // and cameras near or inside the shell; the inline march handles orbital
  // geometry. Give this path priority if both LUT gates are enabled.
  let useSkyViewLut =
    lutEligible &&
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
    // `czm_computeScattering` takes the camera origin and camera-to-shell
    // distance, then derives its own interval.
    color = computeScattering(
      u.cameraPositionWC,
      rayDir,
      rayEnd,
      lightDirWC,
      innerRadius,
      outerRadius,
    );

    // When inline dual light is enabled, reuse the same scattering medium for a
    // second analytic march along the moon direction. Scale that contribution
    // by moon phase and intensity; a disabled gate avoids the extra march.
    if (u.atmosControl.y > 0.5 && u.moonControl.x > 0.001) {
      let moonColor = computeScattering(
        u.cameraPositionWC,
        rayDir,
        rayEnd,
        normalize(u.moonLightDirWC),
        innerRadius,
        outerRadius,
      );
      let moonScale = u.moonControl.x * u.moonControl.y;
      color = color + moonColor * moonScale;
    }
  }

  // Optional multiple scattering uses the sun-relative sky-view domain and the
  // same UV derivation as `sampleSkyViewLut`, keeping both terms directionally
  // aligned. Bake-time intensity is already included. Add the term before
  // tonemapping to lift horizon and shadowed-limb radiance while retaining the
  // shared highlight shoulder.
  if (u.debug.y > 0.5) {
    // Use normalized camera position as the ground-level local vertical. The
    // table is baked against the world sun, so its azimuth reference must be
    // `u.sunDirectionWC`, including in `LEGACY_OVERHEAD` mode where
    // `lightDirWC` varies per fragment.
    let upDir = normalize(u.cameraPositionWC);
    let msColor = sampleMultipleScatterLut(upDir, rayDir, u.sunDirectionWC);
    // This is a perceptual scale rather than a physical coefficient.
    const MS_SCALE: f32 = 0.06;
    color = color + max(msColor, vec3<f32>(0.0)) * MS_SCALE;
  }

  // Match WebGL's post-scattering pipeline order:
  //   linear scatter → czm_pbrNeutralTonemapping → czm_inverseGamma
  //   → czm_applyHSBShift → output
  //
  // PBR Neutral preserves saturation through its soft highlight shoulder.
  // Apply the HSB shift after tonemapping and gamma so it operates on
  // perceptual SDR values. Add eclipse horizon twilight in linear scattering
  // space before the tonemap, matching `SkyAtmosphereFS.glsl`. The profile is
  // azimuth-independent because the surrounding penumbra lights the whole
  // horizon inside the umbra.
  if (u.eclipseControl.x > 0.0) {
    let upObs = getEclipseObserverUp(
      u.cameraPositionWC,
      u.ellipsoidInverseRadiiSquared,
    );
    let elevation = asin(clamp(dot(normalize(rayDir), upObs), -1.0, 1.0));
    var band = max(0.0, 1.0 - max(elevation, 0.0) / ECLIPSE_TWILIGHT_ELEVATION);
    band = band * band;
    let skyLuminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
    color = color + skyLuminance * ECLIPSE_TWILIGHT_TINT * (u.eclipseControl.x * band);
  }

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

  // Match `SkyAtmosphereCommon.glsl` altitude opacity. It falls linearly from
  // opaque at ground level to transparent above the shell, then uses night
  // alpha to fade the unlit side into space. Mixing against blue preserves the
  // WebGL hue of the remaining orbital halo.
  let altitudeOpacity = clamp(
    (outerRadius - cameraHeight) / max(1.0, outerRadius - innerRadius),
    0.0,
    1.0,
  );
  // nightAlpha: 1.0 on day side, 0.0 on night side. Only applied when
  // dynamic atmosphere lighting is enabled (radiiAndDynamicAtmosphere.z != 0).
  let isDynamic = u.radiiAndDynamicAtmosphere.z != 0.0;
  var nightAlpha = select(
    1.0,
    clamp(dot(normalize(skyPoint), lightDirWC), 0.0, 1.0),
    isDynamic,
  );
  // Inline moon scattering must also raise night-side opacity; otherwise its
  // color disappears against a transparent sky after sunset. Use the brighter
  // body-side term, scaled by moon phase, while the dual-light gate is enabled.
  if (u.atmosControl.y > 0.5 && u.moonControl.x > 0.001) {
    let moonNight =
      clamp(dot(normalize(skyPoint), normalize(u.moonLightDirWC)), 0.0, 1.0) *
      u.moonControl.x;
    nightAlpha = max(nightAlpha, moonNight);
  }
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
