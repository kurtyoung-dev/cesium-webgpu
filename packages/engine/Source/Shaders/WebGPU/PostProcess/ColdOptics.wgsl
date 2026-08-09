// ColdOptics — ice-crystal sky halos (22 halo + sun-dogs / parhelia).
//
// A screen-space sky overlay that draws the optical phenomena cold-air
// hexagonal ice crystals produce around the sun: the 22-degree halo ring and
// the two sun dogs, or parhelia, about 22 degrees to the left and right of
// the sun at the sun's own altitude. Gated through the unified effects
// hierarchy by `scene.coldOpticsEnabled` and `scene.coldOpticsIntensity`,
// which `AtmosphericEffects.ts` derives from sub-freezing temperatures, the
// way heat shimmer derives from hot ones.
//
// Per pixel:
//   1. Reconstruct the world-space VIEW RAY the SAME FP32-safe way
//      AerialPerspective.wgsl does: eye-space ray dir = inverseProjection
//      (ndc, 0, 1), then rotate to world with the inverse-view rotation.
//      (Reconstructing two Earth-scale world positions and subtracting is
//      NOT FP32-safe; rotating a unit direction IS.)
//   2.  = acos(dot(viewRay, sunDir)) — the angular separation from the sun.
//   3. 22 HALO: a thin bright RING where  ~ radians(22), coloured reddish
//      on the inner edge fading to faint blue-white outward, suppressed
//      inside the ring so it reads as a ring not a disc.
//   4. SUN-DOGS: two brighter, more saturated spots ON the parhelic circle
//      at the sun's altitude, ~22 horizontally left/right of the sun. The
//      view sun offset is split into a VERTICAL component (along world up)
//      and a HORIZONTAL component; the dogs peak where |horizontal|  22
//      and |vertical|  0.
//   5. SKY-ONLY: only drawn where the scene depth is at/near the far plane
//      (sky). Geometry (terrain / tiles) is never overdrawn.
//   6. SUN-UP: the whole effect fades out as the sun drops below the
//      horizon (sunDir up < 0).
//   7. ADDITIVE over the scene colour. intensity <= 0 or disabled is a
//      byte-identical passthrough (returns the source sample).
//
// Single fullscreen pass, mirrors HeatShimmer's structure (one output
// texture, one pipeline, scene-color + depth + sampler + uniforms bindings).
//
// An opt-in advanced branch, gated on `params1.w > 0.5` and driven by
// `effects.optics.advanced`. With it off the halo and sun dogs above run
// unchanged. With it on, the same per-pixel angle feeds a physically
// parameterized ice-crystal model:
//   - 22 HALO — random-oriented hexagonal columns, 60 prism, minimum
//     deviation; SPECTRAL DISPERSION shifts the red ray to ~21.5 and the
//     blue ray to ~22.5, so the halo has a reddish inner rim fading to
//     bluish outward (sampled as three offset gaussians: R/G/B).
//   - 46 HALO — 90 prism faces; minimum deviation ~46 with the same
//     dispersion (red ~45.7, blue ~46.5). Fainter than the 22 halo.
//   - UPPER TANGENT ARC — column crystals, tangent to the 22 halo directly
//     ABOVE the sun; a brightening of the 22 ring weighted toward the top,
//     bowing outward away from the zenith.
//   - LIGHT PILLARS — plate crystals reflecting off their horizontal basal
//     faces produce a VERTICAL column of light through the sun, brightest at
//     the sun and fading with vertical distance (and with horizontal offset
//     so it stays a column, not a glow). Strongest when the sun is LOW.
// All advanced features share the legacy sky-only + sun-up gates and the
// master intensity, and are ADDITIVE + energy-reasonable (subtle brightenings,
// not opaque rings). This also covers the separately-deferred light-pillars
// item from the atmospheric-effects roadmap.

const PI: f32 = 3.141592653589793;
const DEG2RAD: f32 = 0.017453292519943295;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct ColdOpticsUniforms {
  // Camera world position (ECEF, relative to ellipsoid centre = origin). xyz;
  // .w = innerRadius (ellipsoid max radius, metres) — used to form world up.
  cameraPositionWC: vec4<f32>,
  // Sun direction in world coordinates (normalized). xyz; .w = intensity
  // (master amount 0..N; <=0 -> passthrough).
  sunDirectionWC: vec4<f32>,
  // .x = haloRadiusRad (radians(22)), .y = haloWidthRad (gaussian sigma),
  // .z = near, .w = far (depth linearization / sky cutoff context).
  params0: vec4<f32>,
  // .x = skyCutoff (raw depths at or above this are sky), .y = dogRadiusRad,
  // the parhelia horizontal offset in radians, .z = dogSigmaRad, the angular
  // spread of each dog, and .w = the advanced flag. Zero, the default, keeps
  // the halo and sun dogs alone; above 0.5 selects the physically-derived 22
  // and 46 degree halos with spectral dispersion, the upper tangent arc, and
  // the light pillars.
  params1: vec4<f32>,
  // Inverse projection — recovers the EYE-space ray direction from NDC.
  inverseProjection: mat4x4<f32>,
  // Inverse view ROTATION (eye->world). Only the upper-left 3x3 is used.
  inverseViewRotation: mat4x4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: ColdOpticsUniforms;

// COLD-OPTICS-HQ helpers (advanced branch only)
//
// A spectrally-dispersed gaussian RING. The ice-crystal minimum-deviation
// angle depends on wavelength (the prism disperses sunlight), so the R/G/B
// channels peak at slightly DIFFERENT radii: red on the INNER edge, blue on
// the OUTER edge. We evaluate three offset gaussians — one per channel —
// centred at radiusR/radiusG/radiusB, all sharing the ring sigma. The result
// is a ring whose inner rim is reddish and whose outer rim fades bluish, the
// signature look of the real 22 / 46 halos.
fn dispersedRing(
  theta: f32,
  radiusR: f32,
  radiusG: f32,
  radiusB: f32,
  sigma: f32
) -> vec3<f32> {
  let dR = (theta - radiusR) / sigma;
  let dG = (theta - radiusG) / sigma;
  let dB = (theta - radiusB) / sigma;
  return vec3<f32>(exp(-dR * dR), exp(-dG * dG), exp(-dB * dB));
}

// The physically-parameterized cold-optics features: 22 + 46 dispersed
// halos, the upper tangent arc, and light pillars. Returns the ADDITIVE RGB
// contribution BEFORE the master intensity / sun-up scaling (the caller
// applies those). `theta` is the angular separation from the sun (radians);
// `haloRadius` / `haloWidth` are the legacy 22 radius + ring sigma reused as
// the dispersion centre + width so the advanced 22 halo lines up with the
// legacy one. `rayDir` / `sunDir` / `up` are the world-space view ray, sun
// direction, and local up.
fn coldOpticsAdvanced(
  theta: f32,
  haloRadius: f32,
  haloWidth: f32,
  rayDir: vec3<f32>,
  sunDir: vec3<f32>,
  up: vec3<f32>
) -> vec3<f32> {
  // Minimum-deviation angles. The 22 halo (60 prism) disperses red ~21.5
  // -> blue ~22.5; the 46 halo (90 prism faces) disperses red ~45.7 ->
  // blue ~46.5. Centre the 22 dispersion on the legacy radius so the
  // advanced ring sits exactly where the legacy ring did.
  let r22R = haloRadius - 0.5 * DEG2RAD; // red inner
  let r22G = haloRadius;                 // green centre
  let r22B = haloRadius + 0.5 * DEG2RAD; // blue outer
  let r46R = 45.7 * DEG2RAD;
  let r46G = 46.0 * DEG2RAD;
  let r46B = 46.5 * DEG2RAD;

  // 22 halo — dispersed ring, inner suppression so it reads as a ring.
  let ring22 = dispersedRing(theta, r22R, r22G, r22B, haloWidth);
  let inner22 = smoothstep(
    haloRadius - 0.5 * DEG2RAD - haloWidth,
    haloRadius - 0.5 * DEG2RAD,
    theta
  );
  // 46 halo — wider sigma (it's a softer, fainter feature) + inner cut.
  let sigma46 = haloWidth * 1.6;
  let ring46 = dispersedRing(theta, r46R, r46G, r46B, sigma46);
  let inner46 = smoothstep(
    r46R - sigma46,
    r46R,
    theta
  );

  // Build the sun-local frame for the tangent arc + pillars. right is
  // horizontal-ish (sun x up); sunLocalUp completes a right-handed basis.
  // Guard the degenerate sun-straight-up case.
  var arcAmt = 0.0;
  var pillarAmt = 0.0;
  let crossLen = length(cross(sunDir, up));
  if (crossLen > 0.05) {
    let sunRight = cross(sunDir, up) / crossLen;
    let sunLocalUp = normalize(cross(sunRight, sunDir));
    let vRight = dot(rayDir, sunRight);
    let vUp = dot(rayDir, sunLocalUp);
    let vFwd = dot(rayDir, sunDir);

    // UPPER TANGENT ARC
    // Column crystals (long axis horizontal) refract light into an arc
    // TANGENT to the 22 halo directly ABOVE the sun. Approximate it as a
    // brightening of the 22 ring weighted toward the TOP of the ring
    // (vUp > 0) that bows slightly OUTWARD (its effective radius grows a
    // touch with azimuth away from straight-up). topWeight peaks at the
    // top and falls off to the sides; outwardBow nudges the matched radius
    // out so the arc kisses the halo at the apex and flares above it.
    let aboveGate = smoothstep(0.0, 0.25, vUp);
    let topAzimuth = clamp(vUp / max(0.05, sqrt(vUp * vUp + vRight * vRight)), 0.0, 1.0);
    let topWeight = topAzimuth * topAzimuth * aboveGate;
    let outwardBow = (1.0 - topWeight) * 1.4 * DEG2RAD;
    let arcRadius = haloRadius + outwardBow;
    let dArc = (theta - arcRadius) / (haloWidth * 1.3);
    arcAmt = exp(-dArc * dArc) * topWeight * smoothstep(0.0, 0.15, vFwd);

    // LIGHT PILLARS
    // Plate crystals (basal faces horizontal) act as tiny mirrors,
    // reflecting the sun into a VERTICAL column through it. Brightest AT
    // the sun, fading with vertical distance; narrow horizontally so it
    // stays a column, not a glow. Strongest when the sun is LOW (plate
    // reflections graze the horizon) — fade with sun elevation.
    let pillarHalfWidth = 1.2 * DEG2RAD;   // horizontal narrowness
    let pillarHeight = 11.0 * DEG2RAD;     // vertical extent (1/e)
    let horizTerm = vRight / pillarHalfWidth;
    let vertTerm = vUp / pillarHeight;
    // Gaussian-narrow horizontally, exponential vertical falloff (soft, long
    // tail upward + a shorter sub-sun pillar below). Forward hemisphere only.
    let pillarShape = exp(-horizTerm * horizTerm) * exp(-abs(vertTerm));
    let lowSun = 1.0 - smoothstep(0.10, 0.55, dot(sunDir, up)); // strong when low
    pillarAmt = pillarShape * smoothstep(0.0, 0.10, vFwd) * lowSun;
  }

  // Colours. The dispersed rings already carry their own R/G/B weighting, so
  // tint them only lightly (warm overall). The tangent arc shares the 22
  // ring's warm-inner lean. Pillars take the sun's own warm-white.
  let warm = vec3<f32>(1.0, 0.82, 0.62);
  let pillarColor = vec3<f32>(1.0, 0.86, 0.66);

  // Energy budget: the 22 halo is the brightest advanced feature but still
  // subtle; the 46 halo is markedly fainter (it really is in the sky); the
  // tangent arc is a localised brightening; pillars are soft.
  let halo22 = ring22 * inner22 * warm * 0.55;
  let halo46 = ring46 * inner46 * warm * 0.22;
  let arc = warm * arcAmt * 0.6;
  let pillar = pillarColor * pillarAmt * 0.5;

  return halo22 + halo46 + arc + pillar;
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let sceneColor = textureSampleLevel(sceneColorTex, texSampler, uv, 0.0);

  let intensity = uniforms.sunDirectionWC.w;
  // intensity <= 0 -> byte-identical passthrough.
  if (intensity <= 0.0) {
    return sceneColor;
  }

  let skyCutoff = uniforms.params1.x;
  let rawDepth = textureSampleLevel(sceneDepthTex, texSampler, uv, 0.0).r;
  // SKY-ONLY: geometry (depth < cutoff) is never overdrawn. The optics live
  // only on sky pixels (depth at/near the far plane).
  if (rawDepth < skyCutoff) {
    return sceneColor;
  }

  // World-space view ray. Recover the EYE-space ray direction from NDC via
  // the inverse projection (use the NEAR plane, clip-z = 0, which is well-
  // conditioned for an infinite-far projection), then rotate to world with
  // the inverse-view rotation. Rotating a unit direction is FP32-precise.
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
  let eyeH = uniforms.inverseProjection * vec4<f32>(ndc, 0.0, 1.0);
  let eyeDir = normalize(eyeH.xyz / eyeH.w);
  let rayDir = normalize(
    (uniforms.inverseViewRotation * vec4<f32>(eyeDir, 0.0)).xyz
  );

  let sunDir = normalize(uniforms.sunDirectionWC.xyz);

  // World up at the camera (ECEF: up is the camera position direction).
  let camWC = uniforms.cameraPositionWC.xyz;
  let camLen = length(camWC);
  var up = vec3<f32>(0.0, 0.0, 1.0);
  if (camLen > 1.0) {
    up = camWC / camLen;
  }

  // SUN-UP gate: fade the whole effect as the sun drops below the local
  // horizon. Full strength when the sun is well up, off below the horizon.
  let sunElev = dot(sunDir, up);
  let sunUp = smoothstep(-0.05, 0.10, sunElev);
  if (sunUp <= 0.0) {
    return sceneColor;
  }

  // Angular separation from the sun.
  let cosTheta = clamp(dot(rayDir, sunDir), -1.0, 1.0);
  let theta = acos(cosTheta);

  let haloRadius = uniforms.params0.x; // radians(22)
  let haloWidth = uniforms.params0.y;  // gaussian sigma (radians)

  // 22 HALO
  // Thin bright ring at  ~ 22 with a gaussian falloff. Suppress inside the
  // ring (just inside the radius) so it reads as a ring, not a filled disc.
  let dHalo = (theta - haloRadius) / haloWidth;
  var haloAmt = exp(-dHalo * dHalo);
  // Inner suppression: kill everything more than ~0.5 inside the radius so
  // the central disc stays clear.
  let innerCut = smoothstep(
    haloRadius - 0.5 * DEG2RAD - haloWidth,
    haloRadius - 0.5 * DEG2RAD,
    theta
  );
  haloAmt = haloAmt * innerCut;

  // Halo colour: reddish on the INNER edge ( < radius) fading to a faint
  // blue-white on the OUTER edge ( > radius), matching the real 22 halo's
  // dispersion (red inside, blue outside).
  let inner = vec3<f32>(1.0, 0.55, 0.35); // warm red-orange (inner edge)
  let outer = vec3<f32>(0.80, 0.88, 1.0); // faint cool blue-white (outer)
  let edgeMix = clamp((theta - haloRadius) / (2.0 * haloWidth) + 0.5, 0.0, 1.0);
  let haloColor = mix(inner, outer, edgeMix);

  // SUN-DOGS (parhelia)
  // Two bright spots on the parhelic circle (the sun's altitude) ~22 to
  // the left and right of the sun. Decompose the view->sun angular offset
  // into a VERTICAL component (along world up) and a HORIZONTAL component.
  // Build a sun-local frame: forward = sunDir, right = normalize(sunDir x up),
  // localUp = right x sunDir. Project the view ray into that frame and read
  // its azimuth (horizontal) + elevation (vertical) relative to the sun.
  let dogRadius = uniforms.params1.y; // radians(22)
  let dogSigma = uniforms.params1.z;  // angular spread

  var dogAmt = 0.0;
  let sunRight = normalize(cross(sunDir, up));
  // Guard the degenerate case (sun straight up — right is undefined). When
  // sunElev is near 1 the cross product length collapses; skip the dogs.
  if (length(cross(sunDir, up)) > 0.05) {
    let sunLocalUp = normalize(cross(sunRight, sunDir));
    // Components of the view ray in the sun-local frame.
    let vRight = dot(rayDir, sunRight);
    let vUp = dot(rayDir, sunLocalUp);
    let vFwd = dot(rayDir, sunDir);
    // Horizontal angle (left/right along the parhelic circle) and vertical
    // angle (above/below the sun's altitude). atan2 keeps these well-defined
    // across the full hemisphere in front of the viewer.
    let horiz = atan2(vRight, vFwd); // signed; |horiz| ~ dogRadius at the dogs
    let vert = atan2(vUp, sqrt(vRight * vRight + vFwd * vFwd));
    // Peak where |horiz| ~ dogRadius AND vert ~ 0.
    let dHoriz = (abs(horiz) - dogRadius) / dogSigma;
    let dVert = vert / (dogSigma * 1.3);
    // Only forward hemisphere (vFwd > 0) carries the dogs.
    let fwdGate = smoothstep(0.0, 0.2, vFwd);
    dogAmt = exp(-(dHoriz * dHoriz) - (dVert * dVert)) * fwdGate;
  }
  // Sun-dogs are warmer + brighter than the ring; same dispersion lean.
  let dogColor = vec3<f32>(1.0, 0.78, 0.55);

  // Compose (legacy)
  // The halo is the fainter feature; the sun-dogs are brighter. Both fade
  // with the sun-up gate and scale with the master intensity. Additive.
  let haloContribution = haloColor * haloAmt * 0.7;
  let dogContribution = dogColor * dogAmt * 1.5;
  let glow = (haloContribution + dogContribution) * intensity * sunUp;

  // Advanced branch, gated on `params1.w`. With it off this whole block is
  // skipped and the return below adds only the base glow. With it on it adds
  // the dispersed 22 and 46 degree halos, the upper tangent arc, and the light
  // pillars on top of that base contribution.
  var advGlow = vec3<f32>(0.0, 0.0, 0.0);
  let advanced = uniforms.params1.w;
  if (advanced > 0.5) {
    advGlow = coldOpticsAdvanced(
      theta, haloRadius, haloWidth, rayDir, sunDir, up
    ) * intensity * sunUp;
  }

  return vec4<f32>(sceneColor.rgb + glow + advGlow, sceneColor.a);
}
