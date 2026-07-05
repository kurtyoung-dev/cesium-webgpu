// GTAOGenerate — Ground-Truth Ambient Occlusion (Jimenez 2016).
//
// Drop-in replacement for `AmbientOcclusionGenerate.wgsl` (HBAO variant).
// Same uniform layout + bind group + output shape so `AmbientOcclusionEffect`
// can swap the generation pipeline between HBAO and GTAO via a config flag
// without plumbing changes. The blur + modulate passes downstream are
// algorithm-agnostic.
//
// Why GTAO over HBAO:
//   - GTAO solves the analytic cos-weighted horizon integral instead of
//     summing discrete horizon-angle contributions. That matches the
//     reference integral exactly at the cost of two transcendentals per
//     sample direction — still cheap.
//   - GTAO handles near-grazing view angles without the horizon-angle
//     clamping artefact HBAO exhibits near silhouettes.
//   - GTAO is the modern standard in most AAA engines (UE4/5, Unity HDRP,
//     Frostbite) for exactly this reason.
//
// Reference: Jiménez, Wu, Pesce, Jarabo — "Practical Realtime Strategies
// for Accurate Indirect Occlusion" (SIGGRAPH 2016).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSAOUniforms {
  // x = intensity, y = bias, z = lengthCap (max eye-space radius), w = stepCount
  params0: vec4<f32>,
  // x = directionCount, y = 1/width, z = 1/height, w = randomTexSize
  params1: vec4<f32>,
  // frustum: x = near, y = far, z = logActive (C4-LOGDEPTH-PP-SLICEB), w = unused
  frustum: vec4<f32>,
  _pad: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSAOUniforms;

const PI: f32 = 3.14159265359;
const HALF_PI: f32 = 1.57079632679;

// C4-LOGDEPTH-PP-SLICEB — reverse a logarithmic depth sample to hyperbolic
// window depth [0,1]. Byte-compatible with WebGL czm_reverseLogDepth. Only
// invoked when the renderer-wide log-depth flag is set (frustum.z >= 0.5).
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn readDepth(uv: vec2<f32>) -> f32 {
  let raw = textureSample(depthTexture, texSampler, uv).r;
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  // C4-LOGDEPTH-PP-SLICEB — reverse log depth before linearizing when active.
  var d = raw;
  if (uniforms.frustum.z > 0.5) {
    d = logDepthReverse(raw, near, far);
  }
  return near * far / (far - d * (far - near));
}

fn pixelToEye(screenCoord: vec2<f32>) -> vec3<f32> {
  let uv = screenCoord * vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let depth = readDepth(uv);
  let xy = 2.0 * uv - vec2<f32>(1.0);
  return vec3<f32>(xy * depth, -depth);
}

// Robust eye-space normal reconstruction — pick the nearest depth neighbour
// along each axis to avoid silhouette bleed. Same pattern as HBAO.
fn getNormal(posEC: vec3<f32>, coord: vec2<f32>) -> vec3<f32> {
  let posLeft = pixelToEye(coord + vec2<f32>(-1.0, 0.0));
  let posRight = pixelToEye(coord + vec2<f32>(1.0, 0.0));
  let posUp = pixelToEye(coord + vec2<f32>(0.0, 1.0));
  let posDown = pixelToEye(coord + vec2<f32>(0.0, -1.0));

  let dx = select(
    posRight - posEC,
    posEC - posLeft,
    abs(posLeft.z - posEC.z) < abs(posRight.z - posEC.z),
  );
  let dy = select(
    posUp - posEC,
    posEC - posDown,
    abs(posDown.z - posEC.z) < abs(posUp.z - posEC.z),
  );
  return normalize(cross(dx, dy));
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

/**
 * Scan along a 2D screen-space direction, sampling depth and tracking the
 * maximum horizon angle (cos of angle-from-view). Mirrors the left/right
 * scan pattern from the GTAO paper — we do them separately so the
 * analytic integral can clamp each horizon independently.
 *
 * @param centerEC       Eye-space position of the center pixel
 * @param centerScreen   Screen pixel coord (not UV)
 * @param viewDir        Normalized view direction (centerEC's negative)
 * @param dir            2D screen-space scan direction
 * @param stepCount      Number of samples to take
 * @param stepSize       Pixels per step along `dir`
 * @param lengthCap      Max eye-space radius — samples beyond this don't
 *                       contribute to the horizon estimate
 * @return cosine of the horizon angle (1 = directly view-aligned,
 *         -1 = directly away from view). Higher = MORE horizon = less occluded.
 */
fn scanHorizon(
  centerEC: vec3<f32>,
  centerScreen: vec2<f32>,
  viewDir: vec3<f32>,
  dir: vec2<f32>,
  stepCount: i32,
  stepSize: f32,
  lengthCap: f32,
) -> f32 {
  var cosHorizon: f32 = -1.0;
  for (var s = 1; s <= stepCount; s = s + 1) {
    let sampleScreen = centerScreen + dir * (stepSize * f32(s));
    let samplePos = pixelToEye(sampleScreen);
    let delta = samplePos - centerEC;
    let dist = length(delta);
    if (dist > lengthCap) {
      break;
    }
    // cos(angle between delta and viewDir); we want the MAX because a
    // steeper rise toward the view means more occlusion — but the GTAO
    // formulation wants the horizon direction SEEN FROM the center,
    // which is delta normalized (pointing at the occluder).
    let cosAngle = dot(normalize(delta), viewDir);
    cosHorizon = max(cosHorizon, cosAngle);
  }
  return cosHorizon;
}

/**
 * GTAO analytic integral for one scan direction.
 *
 * Projects the surface normal onto the scan-plane (view x dir), converts
 * the two horizon cosines into angles in slice space, clamps to the
 * hemisphere of the projected normal, and applies the textbook integral:
 *
 *   ∫ max(0, cos(θ-γ)) dθ  over θ∈[h_l, h_r]
 *     = 0.5 * (-cos(2θ-γ) + cos(γ) + 2θ*sin(γ)) | h_l → h_r
 *
 * Multiply by the length of the projected normal to get the final
 * direction-weighted occlusion contribution.
 */
fn gtaoDirectionContribution(
  cosHorizonLeft: f32,
  cosHorizonRight: f32,
  normal: vec3<f32>,
  viewDir: vec3<f32>,
  sliceDir3D: vec3<f32>,
) -> f32 {
  // Build the slice basis: (sliceDir3D, viewDir, sliceAxis=cross)
  let sliceAxis = normalize(cross(viewDir, sliceDir3D));
  // Project normal onto the slice plane (plane spanned by viewDir + sliceDir3D)
  let projNormal = normal - sliceAxis * dot(normal, sliceAxis);
  let projLen = length(projNormal);
  if (projLen < 1e-4) {
    return 0.0;
  }
  let projNormalN = projNormal / projLen;

  // Signed angle of projected normal from viewDir, in the (viewDir, sliceDir) plane.
  // cos(γ) = dot(projN, viewDir); sin(γ) = dot(projN, sliceDir3D).
  let cosGamma = clamp(dot(projNormalN, viewDir), -1.0, 1.0);
  let sinGamma = dot(projNormalN, sliceDir3D);
  let gamma = atan2(sinGamma, cosGamma);

  // Horizon cosines → angles measured from viewDir in slice space.
  // Left side is the -dir scan, so its angle is negative.
  let hL = -acos(clamp(cosHorizonLeft, -1.0, 1.0));
  let hR = acos(clamp(cosHorizonRight, -1.0, 1.0));

  // Clamp horizons to the hemisphere of projN — occluders behind the
  // surface (relative to n) can't actually occlude, so clip to ±π/2 from γ.
  let h1 = gamma + max(hL - gamma, -HALF_PI);
  let h2 = gamma + min(hR - gamma, HALF_PI);

  // Analytic integral. The 0.25 factor combines the 0.5 from the
  // antiderivative with the 0.5 Monte Carlo normalization for the
  // two-sided horizon (left + right averaged into one slice).
  let contrib =
    0.25 *
    ((-cos(2.0 * h1 - gamma) + cos(gamma) + 2.0 * h1 * sin(gamma)) +
     (-cos(2.0 * h2 - gamma) + cos(gamma) + 2.0 * h2 * sin(gamma)));

  // Weight by projected normal length — slices where the normal lies
  // closer to the slice plane contribute more (steeper cosine falloff).
  return contrib * projLen;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let intensity = uniforms.params0.x;
  let bias = uniforms.params0.y;
  let lengthCap = uniforms.params0.z;
  let stepCount = i32(uniforms.params0.w);
  let directionCount = i32(uniforms.params1.x);
  let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let randomTexSize = uniforms.params1.w;

  let screenCoord = in.uv / texelSize;
  let centerEC = pixelToEye(screenCoord);

  // Early-out on background depth — the scene blit wrote Z = far into
  // slots with no geometry, so occlusion there is nonsense. The HBAO
  // shader uses the same pattern.
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  if (-centerEC.z >= far * 0.99) {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
  }

  let normal = getNormal(centerEC, screenCoord);
  let viewDir = normalize(-centerEC);

  // Per-pixel random rotation to break up the discrete direction pattern.
  // Same random texture as HBAO (R channel = 0..1 angle fraction).
  let randomUV = fract(screenCoord / max(randomTexSize, 1.0));
  let randAngle =
    textureSample(randomTexture, texSampler, randomUV).r * 2.0 * PI;
  let dirStep = PI / f32(directionCount);

  // Step size in pixels — scale by 1/depth so near pixels sample
  // a smaller screen radius than far pixels (constant eye-space reach).
  let stepPixels = max(
    1.0,
    lengthCap / max(-centerEC.z, 0.01) / (2.0 * texelSize.x) /
      f32(stepCount),
  );

  var ao: f32 = 0.0;
  for (var d = 0; d < directionCount; d = d + 1) {
    let theta = randAngle + f32(d) * dirStep;
    let dir2D = vec2<f32>(cos(theta), sin(theta));
    // Build the 3D scan direction by projecting (cos, sin, 0) onto the
    // view plane. Since we scan in screen space, the 3D direction at the
    // center pixel's eye space is simply (cos, sin, 0) expressed in
    // view-space (the eye-space axes already align with the view).
    let sliceDir3D = normalize(vec3<f32>(dir2D.x, dir2D.y, 0.0));

    let cosHL = scanHorizon(
      centerEC,
      screenCoord,
      viewDir,
      -dir2D,
      stepCount,
      stepPixels,
      lengthCap,
    );
    let cosHR = scanHorizon(
      centerEC,
      screenCoord,
      viewDir,
      dir2D,
      stepCount,
      stepPixels,
      lengthCap,
    );

    // Bias term — subtract a small depth offset from each horizon cosine
    // to avoid self-occlusion. Matches the HBAO convention.
    let cosHLBias = clamp(cosHL - bias, -1.0, 1.0);
    let cosHRBias = clamp(cosHR - bias, -1.0, 1.0);

    ao += gtaoDirectionContribution(
      cosHLBias,
      cosHRBias,
      normal,
      viewDir,
      sliceDir3D,
    );
  }

  // Normalize by direction count, clamp, convert to visibility (1 = visible).
  ao = ao / max(1.0, f32(directionCount));
  let visibility = clamp(1.0 - ao * intensity, 0.0, 1.0);
  return vec4<f32>(visibility, visibility, visibility, 1.0);
}
