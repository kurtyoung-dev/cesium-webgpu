// Moon.wgsl — canonical WebGPU moon shader (Phase 1.2c v2 — full WebGL parity).
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
// Why bounding cube and not full-screen quad: WebGL's EllipsoidPrimitive
// uses BoxGeometry.fromDimensions({2,2,2}), with the VS scaling by radii.
// At Earth-distance moon viewing the cube covers ~50-200 pixels of screen
// space; a full-screen quad would run the FS for every pixel on the entire
// canvas (~8M FS invocations at 4K). The cube approach scales with the
// moon's actual screen footprint.
//
// Improvement over WebGL's EllipsoidVS: this VS uses RTE 64-bit emulated
// precision per the project rule. The WebGL VS uses single-precision
// `radii * position` model space, fine for the small moon at distance, but
// our project standard is RTE everywhere. Costs nothing.
//
// Feature parity with the WebGL EllipsoidFS/EllipsoidVS moon path:
//   - Bounding-cube rasterization (matches WebGL geometry approach)
//   - Ray-ellipsoid analytic intersection in model space
//   - Geodetic normal via the `position * oneOverRadiiSq` gradient
//     (czm_geodeticSurfaceNormal) — accounts for ellipsoid oblateness
//   - Back-face / inside pass: t0 AND t1 computed; outside-then-inside
//     compositing matching EllipsoidFS.glsl `outsideFaceColor` +
//     `insideFaceColor` mix
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
// Phase 1.2 celestial additions:
//   - Moon phase gating (smoothstep on phaseFraction) — DELETED (C11-176b,
//     2026-07-24). It double-counted phase (N·L against the real sun
//     direction already yields the terminator + illuminated fraction) and
//     blacked out the whole disc at small sun-moon elongations (the C12-30
//     daytime "dark blob"). No GLSL twin ever had it. Do NOT re-add; the
//     phaseFraction uniform stays for C12-21 phase-dependent earthshine.
//   - Earthshine — soft blue-grey tint on the unlit side, gated by
//     atmosphericConditions.lighting.enableEarthshine
//
// C12 moon-wave additions (2026-07-24, BOTH backends in lockstep with
// EllipsoidFS.glsl — keep character-consistent):
//   - C12-20 Lommel-Seeliger lunar reflectance (runtime uniform flag
//     `lunarBRDF`, from atmosphericConditions.lighting.enableLunarBRDF):
//     replaces Lambert with 2·μ0/(μ0+μ+ε) so the full moon renders as the
//     real flat bright disc, not a limb-darkened ball.
//   - C12-23 opposition surge (uniform `oppositionSurge`, CPU-side
//     Hapke-SHOE multiplier from the true phase angle; 1.0 = identity).
//   - C12-30 atmospheric in-scattering sky-wash (uniform `inscatter`,
//     additive): disc = disc × extinction + inscatter, computed by the
//     CPU integral in Scene/computeAtmosphereExtinction.js which mirrors
//     the sky-atmosphere shader's own scattering model. Exactly (0,0,0)
//     from orbit / disabled — the additive identity.
//   - C12-25 LOLA-derived terminator relief (2026-08-02): a tangent-space
//     normal map at @binding(3) perturbs the LIGHTING normal in an
//     east/north/up frame rebuilt in model space. Gated by the uniform
//     `normalStrength`, which is exactly 0.0 (the identity) when the
//     feature is off or the selected Moon.Variant ships no map. Twin:
//     the LUNAR_NORMAL_MAP block in EllipsoidFS.glsl.
//
// Coordinate frame strategy:
//   The ray march happens in MOON MODEL space. The VS rasterizes the
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
// Uniform layout: 352-byte budget (256 → 320 in Phase 1.2c v2; 320 → 336
// for the C12 moon wave; 336 → 352 for C12-25's `normalStrength` — ADD-ONLY
// at the tail, existing offsets frozen; phaseFraction stays at byte 268).
//
// This file is the build source for Shaders/WebGPU/Environment/Moon.js
// (hand-written wrapper until the next `gulp build` regenerates it via
// wgslToJavaScript).

struct U {
  mvpRTE: mat4x4<f32>,                              // 0..63

  // RTE camera split — camera position in MOON MODEL coordinates
  // (ENV-MOON-SLIVER fix: mvpRTE's linear part is viewRot×moonRot, so the
  // RTE offset it consumes must be model-space. A world-space offset gets
  // wrongly rotated by the moon's IAU orientation and displaces the disc).
  camH: vec3<f32>, _p0: f32,                        // 64..79
  camL: vec3<f32>, _p1: f32,                        // 80..95
  // World-space moon center split — informational only; the VS no longer
  // reads it (the moon center is the origin in model space). Kept for
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
  _p11: f32,                                        // 292
  _p12: f32,                                        // 296
  _p13: f32,                                        // 300

  // NS-MOON-ATMOSPHERE-EXTINCTION — per-channel atmospheric transmittance
  // (extinction) along the camera→moon view ray. Exactly vec3(1.0) from orbit
  // / when the sky atmosphere is hidden, so the moon is byte-identical there.
  // vec3 is 16-byte aligned; offset 304 is 16-aligned.
  extinction: vec3<f32>,                            // 304..315

  // C12-20 — Lommel-Seeliger runtime flag (u32-as-f32; was _spare3, so no
  // existing offset moved). 1 = lunar BRDF, 0 = legacy Lambert/Phong.
  lunarBRDF: f32,                                   // 316

  // C12-30 — additive in-scattered sky radiance (sky-wash) along the
  // camera→moon view ray. Exactly vec3(0.0) from orbit / when disabled —
  // the ADDITIVE identity, mirroring extinction's multiplicative one.
  inscatter: vec3<f32>,                             // 320..331

  // C12-23 — opposition-surge brightness multiplier (Hapke SHOE), computed
  // CPU-side from the true phase angle. 1.0 = identity/disabled.
  oppositionSurge: f32,                             // 332

  // C12-25 — LOLA relief strength. EXACTLY 0.0 when the normal map is
  // disabled or the selected Moon.Variant ships no map (SMALL), which makes
  // the perturbation the exact identity and leaves the legacy disc
  // byte-identical. 336..351 is a NEW 16-byte slot: the 320..335 slot was
  // full (inscatter vec3 + oppositionSurge), so the UB grows 336 -> 352.
  // ADD-ONLY at the tail; every existing offset is frozen.
  normalStrength: f32,                              // 336
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
// C12-25 — LOLA-derived tangent-space normal map. Binding 3 is ALWAYS
// present (there is no shader variant): when the moon has no normal map the
// renderer binds a 1x1 flat (128,128,255) texture and sets normalStrength to
// 0, so the sample is skipped and the math is the exact identity. Reuses the
// binding-2 sampler — the two maps share the same UV unwrap and the same
// filtering, so a second sampler would be pure duplication.
@group(0) @binding(3) var normalTex: texture_2d<f32>;

const PI: f32 = 3.14159265359;

// CsmMaterial-style local. Matches the existing chunks/structs/CsmMaterial
// shape (chunks/functions/csm_getDefaultMaterial.wgsl). Inlined here so we
// don't have to wire up the chunk preprocessor for one struct.
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

// Ray-ellipsoid analytic intersection. Returns (t0, t1) for front and back
// hits, or (-1, -1) on miss. Transforms the ray to unit-sphere space via
// `sqrt(oneOverRadiiSq)` so we can do a simple sphere intersection — the
// same trick as Generated/EllipsoidPrimitive.wgsl, kept inline here so
// Moon.wgsl is self-contained until a future EllipsoidPrimitive feature
// renderer consolidates the math.
fn intersectEllipsoid(
  rayOriginMC: vec3<f32>,
  rayDirMC: vec3<f32>,
) -> vec2<f32> {
  let sqrtOORS = sqrt(u.oneOverRadiiSq);
  let oScaled = rayOriginMC * sqrtOORS;
  let dScaled = rayDirMC * sqrtOORS;

  let a = dot(dScaled, dScaled);
  let b = 2.0 * dot(dScaled, oScaled);
  let c = dot(oScaled, oScaled) - 1.0;

  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) {
    return vec2<f32>(-1.0, -1.0);
  }
  let sqrtDisc = sqrt(disc);
  let t0 = (-b - sqrtDisc) / (2.0 * a);
  let t1 = (-b + sqrtDisc) / (2.0 * a);
  return vec2<f32>(t0, t1);
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

// ─────────────────────────────────────────────────────────────────────
// Vertex stage — bounding cube
// ─────────────────────────────────────────────────────────────────────

struct VI {
  // Unit cube position in [-1, 1]^3 model space — scaled by `radii` here.
  @location(0) cubePos: vec3<f32>,
};

struct VO {
  @builtin(position) pos: vec4<f32>,
  // Eye-space hit point at this vertex; the rasterizer interpolates it
  // across the cube face so the FS gets a per-pixel direction toward the
  // surface (eye is at origin in eye space → direction = normalize(hitEC)).
  @location(0) hitEC: vec3<f32>,
  @location(1) clipW: f32,
};

@vertex
fn vs(i: VI) -> VO {
  var o: VO;

  // Scale the unit cube to wrap the moon ellipsoid. WebGL EllipsoidVS does
  // exactly this: `vec4 p = vec4(u_radii * position, 1.0)`.
  let posMC = i.cubePos * u.radii;

  // RTE in MODEL space: mvpRTE = proj × (view × model with translation
  // zeroed), whose linear part maps model-space vectors to clip space and
  // whose implied origin is the camera. The correct input is therefore the
  // cube vertex relative to the camera IN MODEL COORDINATES:
  //     rte = posMC − cameraMC
  // with cameraMC carried as an RTE high/low split (camH, camL). This is
  // algebraically identical to WebGL's czm_modelViewProjection × (radii ×
  // position). The previous world-space form ((moonH + posMC) − camH) +
  // (moonL − camL) was wrong: mvpRTE's linear part includes the moon's IAU
  // rotation, which must not be applied to the world-space center−camera
  // offset (ENV-MOON-SLIVER — the moon rendered as an off-screen sliver).
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

  // Reconstruct the eye-space position of this vertex by transforming the
  // RTE position through the same MV path used to build mvpRTE. The MVP-RTE
  // gives clip space; we want eye space. The simplest stable approach is
  // to transform `posMC` through a separate `modelView` uniform — but we
  // don't have one. Instead, we compute hitEC by inverting the projection
  // on `clip` (perspective divide cancels later).
  //
  // Cleaner alternative: the FS doesn't need exact hitEC, only the
  // *direction* from the eye. We pass the cube vertex's eye-space
  // *direction* (interpolated) and the FS does:
  //     dirEC = normalize(hitEC_interpolated)
  //     dirMC = inverseModelView3x3 * dirEC
  // The numerical issue is that `hitEC` interpolated in clip space gives
  // wrong direction at perspective; perspective-correct interpolation
  // (which WebGPU does by default for non-flat varyings) handles this.
  //
  // Compute hitEC by chasing through inverseProjection(clip):
  //   hitEC = (inverseProjection * clip).xyz / w
  // But we don't have inverseProjection either. The pragmatic fix: pass the
  // model-space cube vertex position through, and the FS rotates it to eye
  // space using the *inverse* of inverseModelView (= modelView). That's
  // also not in our uniforms.
  //
  // OK, the cleanest path is to actually pass posMC straight through and
  // do the eye-space ray-direction reconstruction in the FS using the
  // ivmRow* matrix — model→eye is the *transpose* of (eye→model), and
  // since the matrix is orthonormal, transpose = inverse, so we already
  // have what we need: model-space position of the surface point at this
  // vertex IS posMC, and the eye position in model space IS u.cameraPositionMC.
  // The FS just uses (posMC - cameraPositionMC) as the model-space ray
  // direction directly. No matrix inversion needed.
  //
  // hitEC field becomes "model-space hit point at this vertex" — renaming
  // would be cleaner but the field name `hitEC` is just a label.
  o.hitEC = posMC;

  return o;
}

// ─────────────────────────────────────────────────────────────────────
// Fragment stage — ray-march, light, write log depth
// ─────────────────────────────────────────────────────────────────────

struct FragOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

// Compute color for one hit. `t` is the ray parameter, `side` is +1 for
// outside (front) faces and -1 for inside (back) faces — matches
// EllipsoidFS.glsl `side` flip.
fn computeEllipsoidColor(
  rayOriginMC: vec3<f32>,
  rayDirMC: vec3<f32>,
  t: f32,
  side: f32,
) -> vec4<f32> {
  let hitMC = rayOriginMC + rayDirMC * t;

  // Geodetic normal. `side` flips orientation when rendering the back face.
  var N = geodeticNormal(hitMC) * side;

  // Canonical spherical UV unwrap from the *spherical* normal
  // (normalize(positionMC / radii)). EllipsoidFS.glsl uses the spherical
  // normal for UVs, not the geodetic normal — they differ on oblate
  // ellipsoids. We match WebGL exactly here.
  let sphericalN = normalize(hitMC / u.radii);
  let uv = ellipsoidTexCoords(sphericalN);
  // textureSampleLevel (explicit mip 0) instead of textureSample because
  // this function is called from non-uniform control flow (the inside-face
  // branch depends on the outside-face result). textureSample requires
  // uniform control flow for implicit derivatives.
  let texColor = textureSampleLevel(tex, samp, uv, 0.0);

  // Fill a CsmMaterial. Matches Material.fromType(Material.ImageType):
  // diffuse from texture, specular and emission zero, alpha opaque,
  // normal is the geodetic surface normal.
  // C12-25 — LOLA-derived terminator relief. The stored map is tangent-space
  // in a GEOGRAPHIC east-north-up frame (x = east, y = north, z = up), so the
  // basis is rebuilt here in MODEL space — the same expression on the same
  // vectors as the LUNAR_NORMAL_MAP block in EllipsoidFS.glsl, which builds
  // it in model space too rather than reading `tangentToEyeMatrix`, precisely
  // so these twins stay character-identical (Principle 5 lockstep). The
  // degenerate-axis guard matters at the poles, where (-y, x, 0) vanishes.
  //
  // Perturbing the LIGHTING normal (not the UV normal) is what makes the
  // relief ride whichever disc law is selected below — Lommel-Seeliger or
  // the Phong fallback both light against this vector. Visible near the
  // TERMINATOR, where N·L is near zero and a few degrees of tilt flips a
  // facet between lit and unlit; nearly invisible at full phase.
  //
  // `u.normalStrength` is exactly 0.0 when the feature is off or the variant
  // ships no map, and the branch then skips the fetch entirely — the WebGL
  // twin compiles the whole block out via its LUNAR_NORMAL_MAP define. Both
  // reach the identical identity; the asymmetry is wiring, not math (WebGL's
  // EllipsoidFS is shared by every EllipsoidPrimitive and must not grow an
  // unconditional sampler, while Moon.wgsl is moon-only).
  if (u.normalStrength > 0.0) {
    let nRaw = textureSampleLevel(normalTex, samp, uv, 0.0).xyz * 2.0 - 1.0;
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

  // C12-20 — Lommel-Seeliger lunar-regolith reflectance vs legacy
  // Lambert/Phong, selected by a runtime uniform (cheap branch; no
  // ShaderDefine bit — the registry is exhausted and the C12 exit criteria
  // mandate runtime uniforms for quality toggles). I ∝ μ0/(μ0+μ),
  // normalized so the sub-solar point at full phase matches Lambert's peak
  // (2·1/(1+1) = 1). At full moon μ0 ≈ μ across the whole disc so the
  // factor is ~1 everywhere — the real Moon's famously FLAT full disc,
  // where Lambert renders a limb-darkened ball. Diffuse-only by design:
  // lunar regolith has no specular lobe (specularStrength is 0 anyway).
  // C12-23 — `oppositionSurge` is the CPU-side Hapke-SHOE multiplier from
  // the true phase angle (1.0 = identity). Both terms are character-
  // consistent with the LUNAR_BRDF / OPPOSITION_SURGE blocks in
  // EllipsoidFS.glsl (Principle 5 lockstep).
  let useLunar: bool = u32(round(u.lunarBRDF)) == 1u;
  var lit: vec3<f32>;
  if (useLunar) {
    let mu0 = max(dot(N, L), 0.0);
    let mu = max(dot(N, toEyeMC), 0.0);
    let lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);
    lit = m.diffuse * lommelSeeliger * u.oppositionSurge;
  } else {
    lit = phongCsmMaterial(m, L, toEyeMC) * u.oppositionSurge;
  }

  // C11-176b (phaseGate DELETED): the disc used to be multiplied by
  // `smoothstep(0.0, 0.3, u.phaseFraction)`. That was a physical double
  // count — N·L against the real Simon1994 sun direction already produces
  // the correct terminator and illuminated fraction — and it additionally
  // blacked out the WHOLE disc (crescent included) whenever the sun-moon
  // elongation was small, e.g. every daytime moon near the sun (C12-30
  // "dark blob"). WebGL (EllipsoidFS.glsl + czm_private_phong) has no such
  // term; the lit fraction now follows the real phase geometry on both
  // backends. `u.phaseFraction` stays in the UB for C12-21
  // (phase-dependent earthshine) and layout stability.
  let rawNdotL = max(dot(N, L), 0.0);
  var color = lit;

  // Earthshine — gated on atmosphericConditions.lighting.enableEarthshine.
  // Soft blue-grey tint on the unlit side; uses raw (pre-phase) N·L so
  // the shadowed hemisphere still receives it during crescent phases.
  let earthshineOn: bool = u32(round(u.enableEarthshine)) == 1u;
  if (earthshineOn) {
    let earthshine = vec3<f32>(0.4, 0.5, 0.7) * 0.08 * (1.0 - rawNdotL);
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

  // Analytic ellipsoid intersection.
  let ts = intersectEllipsoid(originMC, dirMC);
  if (ts.x < 0.0 && ts.y < 0.0) {
    discard;
  }

  // Outside (front) face: render whenever t0 (the nearer hit) is in
  // front of the camera. Inside (back) face: only used when the camera
  // is inside the ellipsoid (t0 < 0 < t1) — matches EllipsoidFS.glsl
  // outsideFaceColor / insideFaceColor blending.
  var outsideColor = vec4<f32>(0.0);
  var insideColor = vec4<f32>(0.0);

  if (ts.x >= 0.0) {
    outsideColor = computeEllipsoidColor(originMC, dirMC, ts.x, 1.0);
  }
  if (outsideColor.a < 1.0 && ts.y >= 0.0) {
    insideColor = computeEllipsoidColor(originMC, dirMC, ts.y, -1.0);
  }

  // Composite. Moon material is opaque; outside face dominates whenever
  // present. Inside face only matters from inside the ellipsoid.
  let mixed = mix(insideColor, outsideColor, outsideColor.a);
  let alpha = 1.0 - (1.0 - insideColor.a) * (1.0 - outsideColor.a);
  // NS-MOON-ATMOSPHERE-EXTINCTION — attenuate + redden by the atmospheric
  // transmittance along the view ray (exactly vec3(1.0) from orbit → no-op).
  // C12-30 — then ADD the in-scattered sky radiance (sky-wash):
  // disc = disc × extinction + inscatter, the full radiative-transfer
  // composite. inscatter is exactly vec3(0.0) from orbit / disabled, so
  // the legacy output is byte-identical there. The wash is what makes a
  // daytime disc pale and sky-blended instead of a dark cutout against
  // the bright sky the opaque disc overdraws.
  out.color = vec4<f32>(mixed.rgb * u.extinction + u.inscatter, alpha);

  // Log depth — this INTENTIONALLY DIVERGES from the shared csm_writeLogDepth
  // contract, and the divergence is safe (see below).
  //
  // The canonical renderer-wide encode (csm_vertexLogDepth + csm_writeLogDepth,
  // used by globe/collections/primitives/buffer/ellipsoid) is:
  //     fragDepth = log2((clipW - near) + 1) * (1 / log2((far - near) + 1))
  // i.e. it measures eye distance FROM THE NEAR PLANE and normalizes by the
  // (far - near) span. The form below instead uses log2(1 + clipW) / log2(1 + far)
  // — it omits `near` entirely and normalizes by the full [0, far] span.
  //
  // Why the divergence is harmless: the VS parks the moon at the FAR plane
  // (o.pos.z = o.pos.w ⇒ NDC z = 1.0). Real scene geometry (globe, tiles,
  // models) sits at lunar-scale-smaller eye distances, so the moon's depth is
  // ALWAYS at/near the far end of the buffer and can never win a `less-equal`
  // depth tie against any opaque fragment — it only fills pixels nothing else
  // occupies. The exact normalization of that always-far value is therefore
  // cosmetically irrelevant; both encodes produce a monotonic ≈1.0. Routing
  // this through the shared chunk would require carrying `near` + the precomputed
  // `oneOverLog2FarDepthFromNearPlusOne` factor in this UB (which today carries
  // only `farPlane`) — pure plumbing for zero visible effect on a parked-at-far
  // environment shader. Left as the lighter self-contained encode by design.
  // (NEW-LOG-DEPTH-REMAINING-PRODUCERS — documented divergence, not a residual.)
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
