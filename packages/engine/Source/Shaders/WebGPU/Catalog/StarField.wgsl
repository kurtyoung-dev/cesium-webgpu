// StarField.wgsl — Yale Bright Star Catalog point starfield for CesiumJS WebGPU.
//
// References:
//   - N. R. Pogson, "Magnitudes of Thirty-six of the Minor Planets", Monthly
//     Notices of the Royal Astronomical Society 17, 12 (1856) — the magnitude
//     scale the magnitude-to-intensity mapping inverts.
//   - Fernando Ballesteros, "New insights into black bodies", Europhysics
//     Letters 97, 34008 (2012) — the B−V to colour-temperature relation.
//   - Shota Matsuda, Takram — `three-geospatial` (MIT),
//     https://github.com/takram-design-engineering/three-geospatial — the
//     compact Planckian-locus RGB fit the colour temperature is mapped
//     through. Implemented fresh here; no third-party code copied.
//
// Each catalog entry is drawn as a view-facing point sprite. The star's
// inertial (J2000 / TEME) direction is rotated into the Earth-fixed frame
// on the CPU (TEME→pseudo-fixed matrix, matching SkyBox), then placed at
// the far plane so it sits behind all scene geometry. Output is additively
// blended into the scene framebuffer. The Moffat PSF in fragmentMain is
// designed for the default LDR target (scene.highDynamicRange=false, bloom
// off): only the tight Gaussian core of the brightest stars exceeds 1.0 and
// clips to white — deliberately, over ≤ ~1.3 px radius — while the power-law
// glare halo stays below the clip level by construction and keeps its
// blackbody hue. HDR and bloom are an optional enhancement rather than a
// dependency; with them on, the same core overflow feeds the bloom
// bright-pass.
//
// Geometry: instanced draw — 6 vertices (two triangles) per instance,
// one instance per star. The per-instance buffer carries the fixed-frame
// unit direction (already rotated), the Pogson intensity, and the
// blackbody RGB color. The 6-vertex quad corners come from @builtin
// vertex_index so no separate corner buffer is needed.

struct Uniforms {
  // Projection × view with translation removed (stars are directional —
  // no RTE position split needed; they live on the unit sphere at the
  // far plane). Column-major mat4.
  viewProjectionNoTranslation: mat4x4<f32>,
  // Point-sprite half-size in NDC (x = horizontal, y = vertical;
  // aspect-corrected on the CPU from the projection focal terms).
  pointSize: vec2<f32>,
  // Global intensity multiplier (lets the app dim/brighten the field;
  // also folds in the day/twilight fade so stars vanish in daylight).
  intensityScale: f32,
  // Minimum on-screen pixel radius floor → keeps faint stars from
  // collapsing to sub-pixel flicker. Expressed in NDC half-extent.
  minPointSize: f32,
  // Zenith atmospheric transmittance (per channel) and the camera local-up
  // direction expressed in the star instance frame (TEME/inertial). Each
  // star's slant transmittance is zenithTransmittance^airmass(elevation).
  // (1,1,1) from orbit or with the atmosphere hidden, so the multiply is a
  // byte-identical no-op (pow(1, x) === 1).
  zenithTransmittance: vec3<f32>,
  _extPad0: f32,
  cameraUpTeme: vec3<f32>,
  _extPad1: f32,
  // Angular solar-glare star washout, appended at the tail of the buffer
  // (bytes 112..143 of 256) so every earlier member keeps its offset and the
  // bind-group layout is unchanged. Resolved once per frame on the CPU by
  // `Scene/SolarGlareAppearance.js` and published on
  // `frameState.solarGlareAppearance`; the GLSL twin (`StarFieldVS.glsl`)
  // reads byte-identical values through `u_solarGlare` / `u_solarGlareCurve`.
  //   solarGlare.xyz  = Sun direction in the TEME instance frame (unit)
  //   solarGlare.w    = washout strength; exactly 0 disables the whole block
  //   solarGlareCurve = (angular core rad, pedestal, support rad, reserved)
  // The curve numbers arrive as uniforms rather than shader literals so this
  // file carries no numeric copy of them; `solar-glare-star-washout.spec.mjs`
  // fails on any shader that hard-codes one.
  solarGlare: vec4<f32>,       // 112..127
  solarGlareCurve: vec4<f32>,  // 128..143
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  // Per-vertex: which of the 6 quad corners (0..5).
  @builtin(vertex_index) vertexIndex: u32,
  // Per-instance star record (see WebGPUStarFieldRenderer pack).
  @location(0) directionFixed: vec3<f32>,  // unit vector, Earth-fixed frame
  @location(1) intensity: f32,             // Pogson-scaled brightness
  @location(2) color: vec3<f32>,           // blackbody RGB (B−V derived)
  @location(3) sizeBoost: f32,             // extra radius for bright stars
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) corner: vec2<f32>,   // [-1,1] quad-local coordinate
  @location(1) color: vec3<f32>,    // HDR color (already intensity-weighted)
  // The quad enlargement factor (1 + sizeBoost). The fragment profile
  // multiplies the core's radius by this so the core keeps a constant
  // on-screen size while the enlarged quad carries the halo.
  @location(2) coreScale: f32,
};

// Veiling-glare weight as a function of angular separation from the Sun.
// Character-identical to `solarGlareVeil` in `Shaders/StarFieldVS.glsl`,
// `Shaders/WebGPU/CubeMapPanorama.wgsl` and `Shaders/SkyBoxFS.glsl`, and a
// line-for-line translation of `angularGlareVeil` in
// `Scene/SolarDiscModel.js`; `Tools/visual-regression/solar-glare-star-washout.spec.mjs`
// extracts all four texts, compiles each body as JavaScript, and requires them
// to agree with the JS reference to 1e-15.
//
//   raw(theta)  = 1 / (1 + (theta/core)^2)      -> ~ 1/theta^2 far field
//   veil(theta) = (raw - pedestal) / (1 - pedestal), clamped to [0, 1]
//
// The `1/theta^2` tail is the Stiles-Holladay / CIE disability-glare form. The
// pedestal subtraction makes the veil reach exactly 0 at the support angle
// (90 deg), and the `cosSeparation <= 0.0` early-out is the same half-space,
// so a star at or beyond 90 deg from the Sun is multiplied by exactly 1.0 and
// the frame stays byte-identical to one with no Sun at all.
fn solarGlareVeil(cosSeparation: f32, core: f32, pedestal: f32, support: f32) -> f32 {
  if (cosSeparation <= 0.0) { return 0.0; }
  let theta = acos(min(cosSeparation, 1.0));
  if (theta >= support) { return 0.0; }
  let t = theta / core;
  let raw = 1.0 / (1.0 + t * t);
  let v = (raw - pedestal) / (1.0 - pedestal);
  return clamp(v, 0.0, 1.0);
}

// Two-triangle quad corner table indexed by vertex_index 0..5.
fn cornerForIndex(idx: u32) -> vec2<f32> {
  // 0:(-1,-1) 1:(1,-1) 2:(1,1) | 3:(-1,-1) 4:(1,1) 5:(-1,1)
  switch (idx) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>( 1.0, -1.0); }
    case 2u: { return vec2<f32>( 1.0,  1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>( 1.0,  1.0); }
    default: { return vec2<f32>(-1.0,  1.0); }
  }
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Project the unit direction with the translation-free view-projection.
  // The star sits on the unit sphere; we only care about its angular
  // position, so a plain direction transform suffices.
  var clip = u.viewProjectionNoTranslation * vec4<f32>(input.directionFixed, 1.0);

  // Behind-camera cull: collapse the quad off-screen so the rasterizer
  // discards it. Without this, stars behind the camera wrap around and
  // smear across the frame.
  if (clip.w <= 0.0) {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.corner = vec2<f32>(0.0);
    output.color = vec3<f32>(0.0);
    output.coreScale = 1.0;
    return output;
  }

  let corner = cornerForIndex(input.vertexIndex);

  // Per-instance point radius: base size + a brightness-driven boost so
  // first-magnitude stars read as visibly larger discs than fourth-
  // magnitude pinpoints, then a floor so nothing sub-pixels out.
  let halfX = max(u.pointSize.x * (1.0 + input.sizeBoost), u.minPointSize);
  let halfY = max(u.pointSize.y * (1.0 + input.sizeBoost), u.minPointSize);

  // Offset the clip-space corner. Multiplying by clip.w keeps the sprite
  // a constant NDC size regardless of depth (the perspective divide
  // restores .x/.y after this).
  clip.x += corner.x * halfX * clip.w;
  clip.y += corner.y * halfY * clip.w;

  // Pin to the far plane so stars render behind every other surface.
  // clip-z = clip-w → NDC z = 1.0 (the [0,1] WebGPU far plane); the
  // less-equal depth compare still lets the star pass against cleared
  // depth.
  output.position = vec4<f32>(clip.x, clip.y, clip.w, clip.w);
  output.corner = corner;
  output.coreScale = 1.0 + input.sizeBoost;

  // Per-star atmospheric extinction. Bouguer's law with a plane-parallel
  // airmass X ≈ 1/sin(elevation), capped near the horizon at ~38 (Kasten-Young
  // limit); slant transmittance = zenithTransmittance^X. directionFixed and
  // cameraUpTeme are both in the TEME frame (dot is rotation-invariant),
  // matching the WebGL path. zenithTransmittance == (1,1,1) from orbit →
  // byte-identical no-op.
  let sinElev = dot(input.directionFixed, u.cameraUpTeme);
  let airmass = 1.0 / max(sinElev, 0.02631579);
  let extinction = pow(u.zenithTransmittance, vec3<f32>(airmass));

  // Angular solar-glare washout, per star. A star is a point source, so its
  // separation from the Sun is constant across its whole quad; evaluating it
  // per-vertex is both cheaper and exactly parity-able with the GLSL vertex
  // stage. `input.directionFixed` and `u.solarGlare.xyz` are both in the TEME
  // frame: the TEME->fixed rotation is baked into
  // `viewProjectionNoTranslation`, and the CPU resolves the Sun into TEME.
  // Appended last in the multiply chain so the disabled position
  // (`glare == 1.0`) is exact: `x * 1.0 === x`.
  var glare = 1.0;
  if (u.solarGlare.w > 0.0) {
    glare = 1.0 - u.solarGlare.w * solarGlareVeil(
      dot(input.directionFixed, u.solarGlare.xyz),
      u.solarGlareCurve.x,
      u.solarGlareCurve.y,
      u.solarGlareCurve.z
    );
  }
  output.color = input.color * input.intensity * u.intensityScale * extinction * glare;
  return output;
}

// Moffat core-plus-wing glare PSF with a chroma-preserving amplitude split.
// These constants stay byte-identical to the GLSL twin
// (Shaders/StarFieldFS.glsl) under the shared-shading rule;
// Tools/visual-regression/starfield-psf.spec.mjs extracts both texts,
// compares them, and asserts the analytic shape r_1e-3 / r_core ≥ 8.
//
//   core = exp(−(r·coreScale)² / (2σ²)) — the resolved stellar image.
//     σ is relative to the base quad; multiplying r by coreScale (the quad
//     enlargement, 1 + sizeBoost) holds the core at a constant on-screen
//     pixel size (σ ≈ 0.60 px at 1920×1080) while the quad grows, so quad
//     growth is pure halo extent and never a bigger disc.
//   halo = (1 + (r/α)²)^(−β) — Moffat (1969) power-law wing, log-log
//     slope −2β = −4.0: the vacuum/ocular glare regime (Stiles–Holladay
//     inverse-square family; Spencer et al., SIGGRAPH '95), not the
//     ground-seeing β=4.765. α is quad-relative and deliberately not
//     coreScale-compensated, so the wing widens with the boosted quad —
//     that is the halo-extent mechanism.
//   window = smoothstep(1.0, 0.92, r) — narrow AA band at the quad edge.
//     The band has to stay narrow: one as wide as (1.0, 0.45) multiplies
//     the wing to zero across the outer 55% of the quad and makes it
//     inert. At r = 0.92 even Sirius' wing is ≈ 3e−4 — below 1/255 — so
//     the window trims nothing visible; it exists to reach exactly zero
//     at the quad edge, which is what stops the sprite reading as a
//     square (CelestiaProject/Celestia#1948).
//
// Amplitude: rgb = color·prof, where color = chroma·I from the vertex
// stage. The halo share I·K_HALO ≤ 5.87·0.08 ≈ 0.47 < 1 for the brightest
// catalogue star (I_max = EXPOSURE·10^(0.4·1.46), StarFieldMath.ts), so
// on the default LDR target the halo never clips and keeps full blackbody
// hue. Only the tight core may exceed 1.0 and clip to white — which is
// correct, saturated detector cores are white — over ≤ ~1.3 px radius at
// 1920×1080 (solve I_max·exp(−r²/(2·0.60²)) + 0.47·halo = 1 →
// r ≈ 1.2 px). Raising intensities re-widens that clip rather than
// brightening the star: under an LDR clamp it strictly widens the white
// disc.
const STAR_PSF_SIGMA: f32 = 0.12;
const STAR_PSF_ALPHA: f32 = 0.15;
const STAR_PSF_BETA: f32 = 2.0;
const STAR_PSF_K_HALO: f32 = 0.08;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let r = length(input.corner);
  let rCore = r * input.coreScale;
  let core = exp(-(rCore * rCore) / (2.0 * STAR_PSF_SIGMA * STAR_PSF_SIGMA));
  let haloBase = r / STAR_PSF_ALPHA;
  let halo = pow(1.0 + haloBase * haloBase, -STAR_PSF_BETA);
  let win = smoothstep(1.0, 0.92, r);
  let prof = (core + STAR_PSF_K_HALO * halo) * win;

  // Additive premultiplied output: RGB is the blackbody color already
  // weighted by linear Pogson intensity in the VS, times the PSF profile.
  let rgb = input.color * prof;
  return vec4<f32>(rgb, prof);
}
