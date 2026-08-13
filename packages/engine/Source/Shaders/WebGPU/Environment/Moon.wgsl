// Moon.wgsl — canonical WebGPU moon shader.
//
// Architecture: bounding-cube-rasterized + analytic ray-marched ellipsoid in
// model space. Mirrors WebGL EllipsoidPrimitive.js + EllipsoidVS.glsl +
// EllipsoidFS.glsl exactly:
//
//   - VS rasterizes a unit cube `[-1,1]^3`, scaled by `radii` to wrap the
//     ellipsoid bounding volume. Only fragments inside the cube's screen
//     footprint enter the FS — orders of magnitude cheaper than a full-
//     screen quad when the moon is small on screen.
//   - FS does an analytic ray-ellipsoid intersection in model space using
//     the eye-space hit point reconstructed from the VS output.
//
// A bounding cube rather than a full-screen quad, matching WebGL's
// EllipsoidPrimitive (BoxGeometry.fromDimensions({2,2,2}), VS scaling by
// radii): at Earth-distance moon viewing the cube covers ~50-200 pixels of
// screen space, where a full-screen quad would run the FS for every pixel on
// the entire canvas (~8M FS invocations at 4K). The cube approach scales with
// the moon's actual screen footprint.
//
// The VS uses RTE 64-bit emulated precision, where WebGL's EllipsoidVS uses
// single-precision `radii * position` model space. Single precision is
// adequate for the small moon at distance; RTE is the project-wide convention
// and costs nothing here.
//
// Feature parity with the WebGL EllipsoidFS/EllipsoidVS moon path:
//   - Bounding-cube rasterization (matches WebGL geometry approach)
//   - Ray-ellipsoid analytic intersection in model space
//   - Geodetic normal via the `position * oneOverRadiiSq` gradient
//     (czm_geodeticSurfaceNormal) — accounts for ellipsoid oblateness
//   - Back-face / inside pass: t0 and t1 computed; the one visible hit is
//     selected before shading. The Moon material is unconditionally opaque,
//     so this is pixel-equivalent to EllipsoidFS.glsl's general-purpose
//     outside/inside alpha composite. UV gradients are evaluated before the
//     miss discard and supplied explicitly to both Moon textures.
//   - Canonical spherical UV unwrap (atan2/asin —
//     czm_ellipsoidTextureCoordinates), not mesh-baked UVs
//   - CsmMaterial-style filling (chunks/functions/csm_getDefaultMaterial):
//     texture sample → m.diffuse, Phong runs through that. Matches
//     Material.fromType(Material.ImageType) in the WebGL path.
//   - Phong lighting matching czm_private_phong (Lambert diffuse +
//     specular, zero ambient, zero emission, white light)
//   - onlySunLighting toggle — picks sunDirMC vs sceneLightDirMC
//     (matches WebGL `#ifdef ONLY_SUN_LIGHTING`)
//   - Exact log depth write via VS-output clip-space w
//
// Celestial terms. Each has a twin in EllipsoidFS.glsl and the pair is kept
// character-consistent, so a change to one is a change to both:
//   - Earthshine — soft blue-grey tint on the unlit side, gated by
//     atmosphericConditions.lighting.enableEarthshine and scaled by the
//     Earth-phase complement (see below). Twin: the EARTHSHINE block in
//     EllipsoidFS.glsl.
//   - Lommel-Seeliger lunar reflectance (runtime uniform flag `lunarBRDF`,
//     from atmosphericConditions.lighting.enableLunarBRDF): replaces Lambert
//     with 2·μ0/(μ0+μ+ε) so the full moon renders as the real flat bright
//     disc, not a limb-darkened ball.
//   - Opposition surge (uniform `oppositionSurge`, CPU-side Hapke-SHOE
//     multiplier from the true phase angle; 1.0 = identity).
//   - Atmospheric in-scattering sky-wash (uniform `inscatter`, additive):
//     disc = disc × extinction + inscatter, computed by the CPU integral in
//     Scene/computeAtmosphereExtinction.js which mirrors the sky-atmosphere
//     shader's own scattering model. Exactly (0,0,0) from orbit or when
//     disabled — the additive identity.
//   - LOLA-derived terminator relief: a tangent-space normal map at
//     @binding(3) perturbs the lighting normal in an east/north/up frame
//     rebuilt in model space. Gated by the uniform `normalStrength`, which
//     is exactly 0.0 (the identity) when the feature is off or the selected
//     Moon.Variant ships no map. Twin: the LUNAR_NORMAL_MAP block in
//     EllipsoidFS.glsl.
//   - Phase-dependent earthshine: the ashen tint is multiplied by
//     `earthshinePhaseScale`, which is Earth's illuminated fraction seen from
//     the Moon — the exact complement of the Moon's phase seen from Earth, so
//     earthshine peaks at new moon and is exactly zero at full. Exactly 1.0
//     (the historical constant) when the toggle or moon-phase modelling is
//     off. Twin: the EARTHSHINE block in EllipsoidFS.glsl. Both read
//     Scene/MoonPhaseAppearance.js's single resolved number via frameState.
//   - Soft terminator: the Lommel-Seeliger μ0 uses the finite solar disc's
//     cosine-weighted irradiance instead of the hard `max(N·L, 0)` clip.
//     `terminatorSoftness` is the Sun's angular radius seen from the Moon
//     (~4.649e-3 rad), resolved CPU-side from the true Sun→Moon distance;
//     exactly 0.0 selects the legacy clip bit-for-bit. Applied only in the
//     Lommel-Seeliger branch, on both backends: the GLSL twin's Phong
//     fallback runs inside czm_private_phong / czm_phong, shared builtins
//     that must not grow a moon-specific term, so keeping the fallback
//     hard-clipped on both backends is what preserves parity.
//
// Coordinate frame strategy:
//   The ray march happens in moon model space. The VS rasterizes the
//   bounding cube in clip space and outputs the eye-space hit point
//   (interpolated). The FS:
//     1. Reconstructs the per-pixel eye-space ray direction from the
//        interpolated hit point: `dirEC = normalize(hitEC - eye)` where
//        the eye is at the origin in eye space, so simply
//        `dirEC = normalize(hitEC)`.
//     2. Rotates that to model space using `inverseModelView 3x3`.
//     3. Uses `cameraPositionMC` (pre-computed JS-side) as the ray origin.
//     4. Intersects, computes geodetic normal, samples texture, lights.
//   Light directions are pre-rotated to model space on the JS side
//   (sunDirMC, sceneLightDirMC) so the FS does no per-pixel matrix work
//   for lighting.
//
// Uniform layout: a 352-byte budget. Members are appended at the tail and
// every existing offset is frozen, which is what keeps the buffer size and
// the bind-group layout stable across additions; `phaseFraction` sits at
// byte 268.
//
// This file is the build source for Shaders/WebGPU/Environment/Moon.js, a
// hand-written wrapper that `gulp build` regenerates via wgslToJavaScript.

struct U {
  mvpRTE: mat4x4<f32>,                              // 0..63

  // RTE camera split — camera position in moon model coordinates. mvpRTE's
  // linear part is viewRot×moonRot, so the RTE offset it consumes must be
  // model-space: a world-space offset is rotated by the moon's IAU
  // orientation and displaces the disc off screen.
  camH: vec3<f32>, _p0: f32,                        // 64..79
  camL: vec3<f32>, _p1: f32,                        // 80..95
  // World-space moon center split — informational only; the VS does not read
  // it, because the moon center is the origin in model space. Retained for
  // layout stability with packEllipsoidBaseUniforms offsets 24..31.
  moonH: vec3<f32>, _p2: f32,                       // 96..111
  moonL: vec3<f32>, _p3: f32,                       // 112..127

  // inverse modelView 3x3 — eye→model rotation, packed as 3 vec4 rows.
  ivmRow0: vec3<f32>, _p4: f32,                     // 128..143
  ivmRow1: vec3<f32>, _p5: f32,                     // 144..159
  ivmRow2: vec3<f32>, _p6: f32,                     // 160..175

  cameraPositionMC: vec3<f32>, _p7: f32,            // 176..191
  radii: vec3<f32>, _p8: f32,                       // 192..207
  oneOverRadiiSq: vec3<f32>, _p9: f32,              // 208..223

  sunDirMC: vec3<f32>, onlySunLighting: f32,        // 224..239 (u32-as-f32)
  sceneLightDirMC: vec3<f32>, _p10: f32,            // 240..255

  moonDirWC: vec3<f32>, phaseFraction: f32,         // 256..271

  // Per-frame flags + Phong tunables.
  enableEarthshine: f32,                            // 272 (u32-as-f32)
  useLogDepth: f32,                                 // 276 (u32-as-f32)
  shininess: f32,                                   // 280
  specularStrength: f32,                            // 284

  farPlane: f32,                                    // 288
  // C12-37 physical-depth route reuses the three historical pad lanes. The
  // legacy fs/vs entry points never read them, so their layout and output stay
  // byte-identical. Physical meanings: canonical encode near/factor and packed
  // globe-depth mode (0 = native live depth, 1 = compare packed, -1 = fail
  // closed because a required late view was unavailable).
  logDepthNear: f32,                                // 292
  logDepthFactor: f32,                              // 296
  packedGlobeDepthMode: f32,                        // 300

  // Per-channel atmospheric transmittance (extinction) along the camera→moon
  // view ray. Exactly vec3(1.0) from orbit and when the sky atmosphere is
  // hidden, so the moon is byte-identical there. vec3 is 16-byte aligned;
  // offset 304 is 16-aligned.
  extinction: vec3<f32>,                            // 304..315

  // Lommel-Seeliger runtime flag (u32-as-f32). 1 = lunar BRDF, 0 = legacy
  // Lambert/Phong.
  lunarBRDF: f32,                                   // 316

  // Additive in-scattered sky radiance (sky-wash) along the camera→moon view
  // ray. Exactly vec3(0.0) from orbit and when disabled — the additive
  // identity, mirroring extinction's multiplicative one.
  inscatter: vec3<f32>,                             // 320..331

  // Opposition-surge brightness multiplier (Hapke SHOE), computed CPU-side
  // from the true phase angle. 1.0 = identity/disabled.
  oppositionSurge: f32,                             // 332

  // LOLA relief strength. Exactly 0.0 when the normal map is disabled or the
  // selected Moon.Variant ships no map (SMALL), which makes the perturbation
  // the exact identity and leaves the legacy disc byte-identical. 336..351 is
  // a slot of its own because 320..335 is full (inscatter vec3 +
  // oppositionSurge).
  normalStrength: f32,                              // 336

  // Earth's illuminated fraction seen from the Moon, i.e. the complement of
  // the Moon's own phase. Exactly 1.0 (the historical constant earthshine)
  // when the toggle or moon-phase modelling is off. Resolved once per frame
  // by Scene/MoonPhaseAppearance.js, so the GLSL twin's
  // u_earthshinePhaseScale cannot disagree with it.
  earthshinePhaseScale: f32,                        // 340

  // The Sun's angular radius seen from the Moon, in radians (~4.649e-3).
  // Exactly 0.0 when the toggle is off, which makes softTerminatorMu0 return
  // the legacy max(N·L, 0) bit-for-bit.
  terminatorSoftness: f32,                          // 344
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
// LOLA-derived tangent-space normal map. Binding 3 is always present, since
// there is no shader variant: when the moon has no normal map the renderer
// binds a 1x1 flat (128,128,255) texture and sets normalStrength to 0, so the
// sample is skipped and the math is the exact identity. Reuses the binding-2
// sampler — the two maps share the same UV unwrap and the same filtering, so
// a second sampler would be pure duplication.
@group(0) @binding(3) var normalTex: texture_2d<f32>;
// C12-37 physical route only. The legacy `fs` entry point has no call path to
// this binding, so the existing environment bind-group layout remains valid.
@group(0) @binding(4) var packedGlobeDepthTex: texture_2d<f32>;

const PI: f32 = 3.14159265359;

// CsmMaterial-style local. Matches the chunks/structs/CsmMaterial shape
// (chunks/functions/csm_getDefaultMaterial.wgsl). Inlined here so the chunk
// preprocessor does not have to be wired up for one struct.
struct CsmMaterial {
  diffuse: vec3<f32>,
  specular: f32,
  shininess: f32,
  normal: vec3<f32>,
  emission: vec3<f32>,
  alpha: f32,
};

// Inlined from chunks/functions/csm_ellipsoidTextureCoordinates.wgsl —
// canonical atan2/asin spherical unwrap.
fn ellipsoidTexCoords(n: vec3<f32>) -> vec2<f32> {
  return vec2<f32>(
    atan2(n.y, n.x) * (0.5 / PI) + 0.5,
    asin(n.z) * (1.0 / PI) + 0.5,
  );
}

// Geodetic normal via the inverse-radii-squared gradient. Analytic
// gradient of `(x/rx)^2 + (y/ry)^2 + (z/rz)^2 - 1 = 0`. Matches
// czm_geodeticSurfaceNormal exactly.
fn geodeticNormal(positionMC: vec3<f32>) -> vec3<f32> {
  return normalize(positionMC * u.oneOverRadiiSq);
}

struct EllipsoidIntersection {
  roots: vec2<f32>,
  discriminant: f32,
};

// Ray-ellipsoid analytic intersection. Returns the front/back roots plus the
// UNCLAMPED discriminant. The roots use sqrt(max(discriminant, 0)): on a miss
// they collapse to the continuous closest-approach/tangent parameter instead
// of a -1 sentinel. That continuation is not rendered, but it gives adjacent
// miss lanes a finite, limb-continuous helper UV for pre-discard derivatives.
// The raw discriminant remains the authoritative hit/miss test.
fn intersectEllipsoid(
  rayOriginMC: vec3<f32>,
  rayDirMC: vec3<f32>,
) -> EllipsoidIntersection {
  let sqrtOORS = sqrt(u.oneOverRadiiSq);
  let oScaled = rayOriginMC * sqrtOORS;
  let dScaled = rayDirMC * sqrtOORS;

  let a = dot(dScaled, dScaled);
  let b = 2.0 * dot(dScaled, oScaled);
  let c = dot(oScaled, oScaled) - 1.0;

  let disc = b * b - 4.0 * a * c;
  let sqrtDisc = sqrt(max(disc, 0.0));
  let t0 = (-b - sqrtDisc) / (2.0 * a);
  let t1 = (-b + sqrtDisc) / (2.0 * a);
  return EllipsoidIntersection(vec2<f32>(t0, t1), disc);
}

// Cosine-weighted irradiance from a solar disc of angular radius `softness`,
// replacing the hard `max(nDotL, 0)` horizon clip. Character-identical twin
// of softTerminatorMu0 in EllipsoidFS.glsl; the JavaScript reference (and the
// derivation) live in Scene/MoonPhaseAppearance.js.
//
//     f(c) = 0                       c <= -w
//     f(c) = (c + w)^2 / (4w)        -w < c < w
//     f(c) = c                       c >= w
//
// C1-continuous at both seams and exactly the legacy value outside the band,
// so `softness == 0.0` is a true identity rather than an approximation of one.
fn softTerminatorMu0(nDotL: f32, hardMu0: f32, softness: f32) -> f32 {
  if (softness <= 0.0) {
    return hardMu0;
  }
  let clamped = clamp(nDotL, -softness, softness);
  let t = clamped + softness;
  return max(nDotL - softness, 0.0) + t * t / (4.0 * softness);
}

// Phong lighting through a CsmMaterial. Matches czm_private_phong from
// packages/engine/Source/Shaders/Builtin/Functions/phong.glsl: Lambert
// diffuse against material.normal, specular via reflect()/pow()/shininess,
// zero ambient, zero emission, white light color.
fn phongCsmMaterial(
  m: CsmMaterial,
  lightDirMC: vec3<f32>,
  toEyeMC: vec3<f32>,
) -> vec3<f32> {
  let rawNdotL = max(dot(m.normal, lightDirMC), 0.0);
  let R = reflect(-lightDirMC, m.normal);
  let specFactor = pow(max(dot(R, toEyeMC), 0.0), max(m.shininess, 1.0)) * m.specular;
  let lightColor = vec3<f32>(1.0);
  return m.diffuse * rawNdotL * lightColor + vec3<f32>(specFactor) * lightColor;
}

struct VI {
  // Unit cube position in [-1, 1]^3 model space — scaled by `radii` here.
  @location(0) cubePos: vec3<f32>,
};

struct VO {
  @builtin(position) pos: vec4<f32>,
  // Model-space cube-face point at this vertex, despite the name; the
  // rasterizer interpolates it across the face so the FS gets a per-pixel
  // target to aim the model-space ray at. The vertex stage explains why the
  // point is carried in model space rather than eye space.
  @location(0) hitEC: vec3<f32>,
  @location(1) clipW: f32,
};

@vertex
fn vs(i: VI) -> VO {
  var o: VO;

  // Scale the unit cube to wrap the moon ellipsoid. WebGL EllipsoidVS does
  // exactly this: `vec4 p = vec4(u_radii * position, 1.0)`.
  let posMC = i.cubePos * u.radii;

  // RTE in model space: mvpRTE = proj × (view × model with translation
  // zeroed), whose linear part maps model-space vectors to clip space and
  // whose implied origin is the camera. The input is therefore the cube
  // vertex relative to the camera in model coordinates:
  //     rte = posMC − cameraMC
  // with cameraMC carried as an RTE high/low split (camH, camL). This is
  // algebraically identical to WebGL's czm_modelViewProjection × (radii ×
  // position). A world-space form such as ((moonH + posMC) − camH) +
  // (moonL − camL) does not work here: mvpRTE's linear part includes the
  // moon's IAU rotation, which must not be applied to a world-space
  // centre−camera offset, and applying it renders the moon as an off-screen
  // sliver.
  let rte = (posMC - u.camH) - u.camL;

  let clip = u.mvpRTE * vec4<f32>(rte, 1.0);
  // Force clip-space z/w = 1 (far plane). The moon is at lunar distance,
  // well beyond any sensible per-frustum far value at orbital altitudes,
  // so its real projected Z is > 1 and the rasterizer would clip it.
  // Parking it at the far plane lets the depth test (`less-equal`) draw
  // it only in pixels not occluded by opaque geometry. `clipW` preserves
  // the original perspective W so the fragment shader's view-direction
  // reconstruction still works correctly.
  o.pos = vec4<f32>(clip.x, clip.y, clip.w, clip.w);
  o.clipW = clip.w;

  // The model-space cube-vertex position is passed straight through. Eye
  // space is not reachable from this uniform buffer — it carries `ivmRow*`
  // (eye→model) but neither a `modelView` nor an `inverseProjection` — and it
  // is not needed: the eye sits at `u.cameraPositionMC` in model space, so
  // the FS forms the ray as `posMC - cameraPositionMC` with no matrix
  // inversion. Interpolation of a non-flat varying is perspective-correct in
  // WebGPU, which is what keeps the interpolated point right under
  // perspective. The varying is named `hitEC`, but it carries a model-space
  // point.
  o.hitEC = posMC;

  return o;
}

// C12-37 — true-position vertex route for the ordinary OPAQUE frustum bins.
// X/Y/W retain the exact RTE projection. Z is clamped only for raster coverage
// (the analytic fragment hit writes the authoritative depth), matching the
// renderer-wide csm_updatePositionDepth contract.
@vertex
fn vsPhysical(i: VI) -> VO {
  var o: VO;
  let posMC = i.cubePos * u.radii;
  let rte = (posMC - u.camH) - u.camL;
  let clip = u.mvpRTE * vec4<f32>(rte, 1.0);
  var rasterClip = clip;
  rasterClip.z = clamp(clip.z / clip.w, 0.0, 1.0) * clip.w;
  o.pos = rasterClip;
  o.clipW = clip.w;
  o.hitEC = posMC;
  return o;
}

// Fragment output: shaded colour plus an explicit log-depth write.
struct FragOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

// Compute color for one selected hit. `side` is +1 for outside (front) faces
// and -1 for inside (back) faces — matches EllipsoidFS.glsl's `side` flip.
fn computeEllipsoidColor(
  hitMC: vec3<f32>,
  side: f32,
  uv: vec2<f32>,
  uvDx: vec2<f32>,
  uvDy: vec2<f32>,
) -> vec4<f32> {
  // Geodetic normal. `side` flips orientation when rendering the back face.
  var N = geodeticNormal(hitMC) * side;

  // Explicit, seam-corrected normalized-UV gradients are computed before the
  // fragment-varying miss discard. Supplying the same normalized gradients to
  // two textureSampleGrad calls does not force one LOD: WebGPU's lambda
  // calculation scales them by each texture's own dimensions, so the 2K
  // albedo and 1K normal map still select independent mip levels.
  let texColor = textureSampleGrad(tex, samp, uv, uvDx, uvDy);

  // Fill a CsmMaterial. Matches Material.fromType(Material.ImageType):
  // diffuse from texture, specular and emission zero, alpha opaque,
  // normal is the geodetic surface normal.
  // LOLA-derived terminator relief. The stored map is tangent-space in a
  // geographic east-north-up frame (x = east, y = north, z = up), so the
  // basis is rebuilt here in model space — the same expression on the same
  // vectors as the LUNAR_NORMAL_MAP block in EllipsoidFS.glsl, which builds
  // it in model space too rather than reading `tangentToEyeMatrix`, so the
  // two texts stay character-identical. The degenerate-axis guard matters at
  // the poles, where (-y, x, 0) vanishes.
  //
  // The lighting normal is perturbed, not the UV normal, so the relief rides
  // whichever disc law is selected below — Lommel-Seeliger and the Phong
  // fallback both light against this vector. Visible near the terminator,
  // where N·L is near zero and a few degrees of tilt flips a facet between
  // lit and unlit; nearly invisible at full phase.
  //
  // `u.normalStrength` is exactly 0.0 when the feature is off or the variant
  // ships no map, and the branch then skips the fetch entirely, while the
  // WebGL twin compiles the whole block out via its LUNAR_NORMAL_MAP define.
  // Both reach the identical identity; the asymmetry is wiring, not math —
  // WebGL's EllipsoidFS is shared by every EllipsoidPrimitive and must not
  // grow an unconditional sampler, while Moon.wgsl is moon-only.
  if (u.normalStrength > 0.0) {
    let nRaw = textureSampleGrad(normalTex, samp, uv, uvDx, uvDy).xyz * 2.0 - 1.0;
    let nTS = vec3<f32>(nRaw.xy * u.normalStrength, nRaw.z);
    let upMC = N;
    let eastRaw = vec3<f32>(-hitMC.y, hitMC.x, 0.0);
    let eastLenMC = length(eastRaw);
    let eastMC = select(vec3<f32>(1.0, 0.0, 0.0), eastRaw / eastLenMC, eastLenMC > 1.0e-6);
    let northMC = cross(upMC, eastMC);
    N = normalize(eastMC * nTS.x + northMC * nTS.y + upMC * nTS.z);
  }

  var m: CsmMaterial;
  m.diffuse = texColor.rgb;
  m.specular = u.specularStrength;
  m.shininess = u.shininess;
  m.normal = N;
  m.emission = vec3<f32>(0.0);
  m.alpha = 1.0;

  // Light direction selection. Both candidates pre-rotated to model space.
  let useSun: bool = u32(round(u.onlySunLighting)) == 1u;
  let L = select(u.sceneLightDirMC, u.sunDirMC, useSun);

  // Eye direction in model space.
  let toEyeMC = normalize(u.cameraPositionMC - hitMC);

  // Lommel-Seeliger lunar-regolith reflectance vs legacy Lambert/Phong,
  // selected by a runtime uniform. The branch is cheap and spends no
  // ShaderDefine bit: the registry is exhausted, and quality toggles are
  // routed by runtime uniform rather than by shader variant. I ∝ μ0/(μ0+μ),
  // normalized so the sub-solar point at full phase matches Lambert's peak
  // (2·1/(1+1) = 1). At full moon μ0 ≈ μ across the whole disc so the
  // factor is ~1 everywhere — the real Moon's famously flat full disc,
  // where Lambert renders a limb-darkened ball. Diffuse-only by design:
  // lunar regolith has no specular lobe (specularStrength is 0 anyway).
  // `oppositionSurge` is the CPU-side Hapke-SHOE multiplier from the true
  // phase angle (1.0 = identity). Both terms are character-consistent with
  // the LUNAR_BRDF / OPPOSITION_SURGE blocks in EllipsoidFS.glsl.
  let useLunar: bool = u32(round(u.lunarBRDF)) == 1u;
  var lit: vec3<f32>;
  if (useLunar) {
    // `mu0Hard` is the legacy horizon clip, kept as the exact value
    // softTerminatorMu0 returns when `terminatorSoftness` is 0.0.
    let mu0Hard = max(dot(N, L), 0.0);
    let mu0 = softTerminatorMu0(dot(N, L), mu0Hard, u.terminatorSoftness);
    let mu = max(dot(N, toEyeMC), 0.0);
    let lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);
    lit = m.diffuse * lommelSeeliger * u.oppositionSurge;
  } else {
    lit = phongCsmMaterial(m, L, toEyeMC) * u.oppositionSurge;
  }

  // The disc carries no phase multiplier. N·L against the real Simon1994 sun
  // direction already produces the terminator and the illuminated fraction,
  // so scaling the disc by a function of `u.phaseFraction` — for instance
  // `smoothstep(0.0, 0.3, u.phaseFraction)` — double-counts phase, and it
  // additionally blacks out the whole disc, crescent included, whenever the
  // sun-moon elongation is small: every daytime moon near the sun. WebGL
  // (EllipsoidFS.glsl + czm_private_phong) carries no such term either, so
  // the lit fraction follows the real phase geometry on both backends.
  // `u.phaseFraction` is kept in the UB for phase-dependent earthshine and
  // for layout stability.
  let rawNdotL = max(dot(N, L), 0.0);
  var color = lit;

  // Earthshine — gated on atmosphericConditions.lighting.enableEarthshine.
  // Soft blue-grey tint on the unlit side; uses raw (pre-phase) N·L so
  // the shadowed hemisphere still receives it during crescent phases.
  //
  // `earthshinePhaseScale` is Earth's illuminated fraction as seen from the
  // Moon, which is the exact complement of the Moon's phase seen from Earth.
  // Earthshine therefore peaks at new moon, where a full Earth hangs over the
  // lunar night side, and is exactly zero at full moon, where a new Earth
  // lights nothing. The scale is exactly 1.0 when the toggle or moon-phase
  // modelling is off, so that position is the historical constant
  // bit-for-bit. The GLSL twin is the EARTHSHINE block in EllipsoidFS.glsl;
  // both read the same resolved number, published on frameState by
  // Scene/MoonPhaseAppearance.js.
  let earthshineOn: bool = u32(round(u.enableEarthshine)) == 1u;
  if (earthshineOn) {
    let earthshine =
      vec3<f32>(0.4, 0.5, 0.7) * 0.08 * (1.0 - rawNdotL) * u.earthshinePhaseScale;
    color = color + earthshine;
  }

  return vec4<f32>(color, m.alpha);
}

@fragment
fn fs(i: VO) -> FragOut {
  var out: FragOut;

  // Model-space ray. The interpolated cube vertex `posMC` IS the surface
  // point on the cube face at this pixel — exactly the model-space target.
  // The eye sits at `cameraPositionMC` in model space (computed JS-side).
  // The ray goes from camera toward the cube hit point.
  let originMC = u.cameraPositionMC;
  let dirMC = normalize(i.hitEC - u.cameraPositionMC);

  // Analytic ellipsoid intersection. Select the nearer/front root when the
  // camera is outside, otherwise the farther/back hit when it is inside.
  // The Moon material is pinned opaque in computeEllipsoidColor, so this is
  // algebraically identical to the old outside/inside alpha composite while
  // removing fragment-varying call control flow.
  let intersection = intersectEllipsoid(originMC, dirMC);
  let ts = intersection.roots;
  let outsideHit = ts.x >= 0.0;
  let tHit = select(ts.y, ts.x, outsideHit);
  let side = select(-1.0, 1.0, outsideHit);
  let hitMC = originMC + dirMC * tHit;

  // Canonical spherical UV unwrap from the spherical (not geodetic) normal,
  // matching EllipsoidFS.glsl. These derivatives must execute before discard.
  // Miss lanes receive the clamped-discriminant closest-approach continuation
  // from intersectEllipsoid, which converges on the real tangent hit at the
  // limb; a fixed sentinel t would inject an artificial derivative spike.
  let sphericalN = normalize(hitMC / u.radii);
  let uv = ellipsoidTexCoords(sphericalN);
  var uvDx = dpdx(uv);
  var uvDy = dpdy(uv);
  // Longitude is periodic. Across atan2's 1->0 wrap, choose the shortest
  // periodic derivative; latitude is clamped at the poles and must not wrap.
  uvDx.x = uvDx.x - round(uvDx.x);
  uvDy.x = uvDy.x - round(uvDy.x);

  let hasForwardHit = ts.x >= 0.0 || ts.y >= 0.0;
  if (intersection.discriminant < 0.0 || !hasForwardHit) {
    discard;
  }

  let hitColor = computeEllipsoidColor(hitMC, side, uv, uvDx, uvDy);

  // Attenuate and redden by the atmospheric transmittance along the view ray
  // (exactly vec3(1.0) from orbit, so a no-op there), then add the
  // in-scattered sky radiance: disc = disc × extinction + inscatter, the full
  // radiative-transfer composite. `inscatter` is exactly vec3(0.0) from orbit
  // and when disabled, so the legacy output is byte-identical there. The wash
  // is what makes a daytime disc pale and sky-blended instead of a dark
  // cutout against the bright sky the opaque disc overdraws.
  out.color = vec4<f32>(hitColor.rgb * u.extinction + u.inscatter, 1.0);

  // Log depth. This deliberately diverges from the shared csm_writeLogDepth
  // contract.
  //
  // The canonical renderer-wide encode (csm_vertexLogDepth + csm_writeLogDepth,
  // used by globe/collections/primitives/buffer/ellipsoid) is:
  //     fragDepth = log2((clipW - near) + 1) * (1 / log2((far - near) + 1))
  // i.e. it measures eye distance from the near plane and normalizes by the
  // (far - near) span. The form below instead uses log2(1 + clipW) / log2(1 + far)
  // — it omits `near` entirely and normalizes by the full [0, far] span.
  //
  // The divergence is harmless because the VS parks the moon at the far plane
  // (o.pos.z = o.pos.w ⇒ NDC z = 1.0). Real scene geometry (globe, tiles,
  // models) sits at lunar-scale-smaller eye distances, so the moon's depth is
  // always at or near the far end of the buffer and can never win a
  // `less-equal` depth tie against any opaque fragment — it only fills pixels
  // nothing else occupies. The exact normalization of that always-far value is
  // therefore cosmetically irrelevant; both encodes produce a monotonic ≈1.0.
  // Routing this through the shared chunk would require carrying `near` plus
  // the precomputed `oneOverLog2FarDepthFromNearPlusOne` factor in this UB,
  // which today carries only `farPlane` — plumbing with no visible effect on a
  // parked-at-far environment shader, so the lighter self-contained encode
  // stands.
  let useLog: bool = u32(round(u.useLogDepth)) == 1u;
  if (useLog) {
    let logZ = log2(max(1e-6, 1.0 + i.clipW));
    let logFar = log2(max(1e-6, 1.0 + u.farPlane));
    out.depth = logZ / logFar;
  } else {
    out.depth = 0.5;
  }

  return out;
}

fn unpackPackedDepth(packed: vec4<f32>) -> f32 {
  return dot(
    packed,
    vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0),
  );
}

// C12-37 — the physical Moon shares the normal OPAQUE attachment with tiles,
// voxels, and models. When Cesium's default terrain-depth clear is active it
// also compares the same raw depth against the packed pre-clear globe depth.
@fragment
fn fsPhysical(i: VO) -> FragOut {
  var out: FragOut;

  let originMC = u.cameraPositionMC;
  let dirMC = normalize(i.hitEC - u.cameraPositionMC);
  let intersection = intersectEllipsoid(originMC, dirMC);
  let ts = intersection.roots;
  let outsideHit = ts.x >= 0.0;
  let tHit = select(ts.y, ts.x, outsideHit);
  let side = select(-1.0, 1.0, outsideHit);
  let hitMC = originMC + dirMC * tHit;

  // Derivatives must be evaluated before the fragment-varying miss discard.
  let sphericalN = normalize(hitMC / u.radii);
  let uv = ellipsoidTexCoords(sphericalN);
  var uvDx = dpdx(uv);
  var uvDy = dpdy(uv);
  uvDx.x = uvDx.x - round(uvDx.x);
  uvDy.x = uvDy.x - round(uvDy.x);

  let hasForwardHit = ts.x >= 0.0 || ts.y >= 0.0;
  if (intersection.discriminant < 0.0 || !hasForwardHit) {
    discard;
  }

  let hitColor = computeEllipsoidColor(hitMC, side, uv, uvDx, uvDy);
  out.color = vec4<f32>(hitColor.rgb * u.extinction + u.inscatter, 1.0);

  // Project the analytic hit through the same late-resolved, TAA-jittered
  // per-frustum matrix used by the vertex path. RTE subtraction happens before
  // the float32 matrix multiply, so lunar-scale world coordinates never enter
  // the shader as one lossy absolute value.
  let hitRte = (hitMC - u.camH) - u.camL;
  let hitClip = u.mvpRTE * vec4<f32>(hitRte, 1.0);
  if (hitClip.w <= 0.0) {
    discard;
  }
  // The command is present in every intersecting frustum so camera-inside-Moon
  // views can reach the slice containing the exit surface. The live projection
  // identifies that one owning slice before canonical full-range depth is
  // calculated; all other executions are fragment-inert.
  let sliceDepth = hitClip.z / hitClip.w;
  if (sliceDepth < 0.0 || sliceDepth > 1.0) {
    discard;
  }

  let useLog: bool = u32(round(u.useLogDepth)) == 1u;
  var moonDepth: f32;
  if (useLog) {
    let depthFromNearPlusOne = (hitClip.w - u.logDepthNear) + 1.0;
    let farDepthFromNearPlusOne =
      (u.farPlane - u.logDepthNear) + 1.0;
    if (
      depthFromNearPlusOne <= 0.9999999 ||
      depthFromNearPlusOne > farDepthFromNearPlusOne ||
      !(u.logDepthFactor > 0.0)
    ) {
      discard;
    }
    moonDepth = log2(depthFromNearPlusOne) * u.logDepthFactor;
  } else {
    moonDepth = sliceDepth;
  }

  // A required texture that failed to publish late must never turn into an
  // on-top draw. The resolver binds a valid placeholder and selects -1 here.
  if (u.packedGlobeDepthMode < -0.5) {
    discard;
  }
  if (u.packedGlobeDepthMode > 0.5) {
    let globeDepth = unpackPackedDepth(textureLoad(
      packedGlobeDepthTex,
      vec2<i32>(i.pos.xy),
      0,
    ));
    // Zero is the packed-depth no-fragment sentinel. Earth wins an exact or
    // quantized tie to avoid a Moon-over-Earth seam at the limb.
    if (globeDepth != 0.0 && moonDepth >= globeDepth) {
      discard;
    }
  }

  out.depth = moonDepth;
  return out;
}
