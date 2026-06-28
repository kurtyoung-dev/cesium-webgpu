// ColdOptics — ice-crystal sky halos (22 halo + sun-dogs / parhelia).
//
// Atmospheric Effects Phase D (Batch 422). A screen-space sky overlay that
// draws the optical phenomena cold-air hexagonal ice crystals produce around
// the sun: the 22 HALO ring and the two SUN-DOGS (parhelia) ~22 to the left
// and right of the sun at the sun's own altitude. Gated on the unified
// effects hierarchy (417a) via `scene.coldOpticsEnabled` /
// `scene.coldOpticsIntensity` (sub-freezing temperatures derive these in
// AtmosphericEffects.ts, mirroring how heat shimmer derives from hot
// temperatures).
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
  // .x = skyCutoff (raw depths >= this are sky), .y = dogRadiusRad
  // (radians(22) — parhelia horizontal offset), .z = dogSigmaRad (angular
  // spread of each dog), .w = reserved (=1).
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

  // ── 22 HALO ──────────────────────────────────────────────────────────
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

  // ── SUN-DOGS (parhelia) ──────────────────────────────────────────────
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

  // ── Compose ──────────────────────────────────────────────────────────
  // The halo is the fainter feature; the sun-dogs are brighter. Both fade
  // with the sun-up gate and scale with the master intensity. Additive.
  let haloContribution = haloColor * haloAmt * 0.7;
  let dogContribution = dogColor * dogAmt * 1.5;
  let glow = (haloContribution + dogContribution) * intensity * sunUp;

  return vec4<f32>(sceneColor.rgb + glow, sceneColor.a);
}
