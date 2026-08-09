// ContactShadows.wgsl — screen-space contact shadows.
//
// Screen-space contact shadows. For each fragment with a valid
// G-buffer normal (length(N) >= 0.1 sentinel check), unproject to
// eye-space, then march a short ray toward the sun direction (in
// eye-space). At each step, sample the depth buffer; if the
// sampled depth indicates an occluder is in FRONT of the marched
// position (by a small tolerance band), the fragment is shadowed.
//
// Output = inputColor * mix(strength, 1.0, shadow) where shadow=1
// means fully lit and shadow=0 means fully occluded.
//
// Reference: the short screen-space ray march against the depth buffer is
// the contact-shadow technique described by Mikkel Gjoel and Mikke Svendsen,
// "The Rendering of Inside" (GDC 2016), and used under that name in several
// engines since. No reference source is incorporated.
//
// Why this exists:
//   - Shadow maps from the sun cover large-scale shadowing well but
//     are coarse near object bases (PCF blur + cascade resolution).
//   - Contact shadows fill in the fine-scale darkening where one
//     object grounds against another (foliage on terrain, vehicle
//     against road, building base meeting ground).
//   - Reuses the existing G-buffer (normal) + depth — no new
//     producer, very cheap (few-dozen taps per pixel max).
//
// Sentinel-aware: pixels without a real G-buffer normal (sky / labels
// / billboards / Phase 1 non-emitting pipelines) skip the test and
// return base color. Same for back-facing pixels (nDotL <= 0) — they
// are already in self-shadow per lighting eval.

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct ContactShadowUniforms {
  // inverseProjection: unproject NDC → eye-space.
  inverseProjection: mat4x4<f32>,
  // projection: project eye-space → NDC for the per-step depth sample.
  projection: mat4x4<f32>,
  // .xyz = sun direction in eye-space.
  // .w = logActive: above 0.5 the sampled depth is log-encoded and must be
  // reversed before the unproject.
  sunDirEC: vec4<f32>,
  // .x = maxDistance (eye-space meters)
  // .y = steps (float, cast to i32 in the loop)
  // .z = strength (0 = no shadow contribution; 1 = fully black at occluded pixels)
  // .w = thickness — how thick is the depth occluder considered
  //      (avoids self-shadow false positives when the marched ray
  //      grazes the surface; in eye-space depth units).
  params: vec4<f32>,
  // .xy = 1/width, 1/height (texelSize)
  // .z = log-encode frustum near; .w = far.
  texelSize: vec4<f32>,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalRoughTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: ContactShadowUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen oversize triangle covering NDC [-1, 1].
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.clipPos = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return output;
}

// Inline `csm_reverseLogDepth`, byte-compatible with
// `chunks/functions/csm_reverseLogDepth.wgsl`. Maps a [0,1] log-depth value
// back to the hyperbolic [0,1] window-space NDC z.
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

// Unproject a UV + depth into eye-space position. UV is in [0,1] with
// Y growing downward (texture coord). Depth is NDC z in [0,1].
fn unprojectUV(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  // The shared depth texture is log-encoded by default; reverse to
  // hyperbolic NDC z before unprojecting. sunDirEC.w<0.5 (log inactive or
  // not wired) keeps the byte-identical pre-Slice-C path.
  var z = depth;
  if (uniforms.sunDirEC.w > 0.5) {
    z = logDepthReverse(depth, uniforms.texelSize.z, uniforms.texelSize.w);
  }
  // Flip Y for NDC (which is Y-up in WebGPU's clip space, [-1, +1]).
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  let unproj = uniforms.inverseProjection * ndc;
  return unproj.xyz / unproj.w;
}

// Project an eye-space position to UV [0,1] + depth [0,1]. Returns
// (uvX, uvY, depth) so callers can use uv for color/depth sampling.
fn projectToUV(posEC: vec3<f32>) -> vec3<f32> {
  let clip = uniforms.projection * vec4<f32>(posEC, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3<f32>(
    ndc.x * 0.5 + 0.5,
    1.0 - (ndc.y * 0.5 + 0.5),
    ndc.z,
  );
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let baseColor = textureSampleLevel(colorTex, texSampler, in.uv, 0.0);

  let normalSample = textureSampleLevel(normalRoughTex, texSampler, in.uv, 0.0).xyz;
  // Sentinel — sky / non-emitter pixel. No contact shadow contribution.
  if (length(normalSample) < 0.1) {
    return baseColor;
  }
  let normalEC = normalize(normalSample);

  let depth = textureSampleLevel(depthTex, texSampler, in.uv, 0.0).r;
  if (depth >= 0.99999) {
    // Sky pixel by depth (the sentinel check above also catches this
    // when the producer wrote sentinel — belt-and-suspenders).
    return baseColor;
  }

  let sunDirEC = normalize(uniforms.sunDirEC.xyz);
  let nDotL = dot(normalEC, sunDirEC);
  // Back-facing to sun → already in self-shadow per lighting eval;
  // contact shadows wouldn't add visible darkening.
  if (nDotL <= 0.001) {
    return baseColor;
  }

  let posEC = unprojectUV(in.uv, depth);

  // Bias the ray start position along the normal to avoid self-
  // shadowing at the origin pixel. Scale by depth so the bias is
  // a fraction of the view-space distance — a fixed 1cm bias is
  // meaningless at planetary altitudes (typical Cesium scenes view
  // terrain from hundreds-of-meters to thousands-of-km). 0.1% of
  // |posEC.z| gives ~1m bias at 1km altitude, ~1km bias at 1000km.
  let depthMagnitude = max(abs(posEC.z), 1.0);
  let biasedStart = posEC + normalEC * (depthMagnitude * 0.001);

  let maxDistance = uniforms.params.x;
  let stepCount = i32(uniforms.params.y);
  let strength = uniforms.params.z;
  let thickness = uniforms.params.w;

  let stepSize = maxDistance / f32(max(stepCount, 1));

  var shadow: f32 = 1.0; // 1 = lit, 0 = fully shadowed
  for (var i: i32 = 1; i <= stepCount; i = i + 1) {
    if (i > 32) { break; } // safety clamp matching the 32-step typical
    let samplePos = biasedStart + sunDirEC * (f32(i) * stepSize);
    let projected = projectToUV(samplePos);
    let sampleUV = projected.xy;
    // Out-of-frame samples can't shadow us — no info.
    if (sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
        sampleUV.y < 0.0 || sampleUV.y > 1.0) {
      break;
    }
    let sampleDepth = textureSampleLevel(depthTex, texSampler, sampleUV, 0.0).r;
    if (sampleDepth >= 0.99999) {
      continue; // sky neighbor — no occluder here
    }
    // Unproject the sampled depth at the sampled UV to get the actual
    // eye-space position of whatever surface is there.
    let sampledEyePos = unprojectUV(sampleUV, sampleDepth);
    // We are shadowed iff the sampled surface is IN FRONT of our
    // marched position (in Cesium WebGPU eye-space, Z grows positive
    // forward; same convention as SSR's `depthDiff > 0` check) AND
    // within the thickness band.
    //
    // The minFrontDelta gate is set to `stepSize * 2` so that the
    // natural depth increase along the sun direction over one step
    // doesn't false-positive as occlusion when the marched ray is
    // glancing along the surface. Without this, the very first
    // march step always finds the same surface at a "deeper"
    // sample-position depth and triggers shadow=progress[1]=tiny.
    let frontDelta = samplePos.z - sampledEyePos.z;
    let minFrontDelta = stepSize * 2.0;
    let scaledThickness = thickness * depthMagnitude;
    if (frontDelta > minFrontDelta && frontDelta < scaledThickness) {
      // Smooth shadow factor based on how deep along the march the
      // occluder is — earlier occluders feel "harder" while later
      // ones fade. Common SSCS softening trick.
      let progress = f32(i) / f32(stepCount);
      shadow = min(shadow, progress);
    }
  }

  // Modulate base color by the shadow factor. `strength=0` produces no
  // visible shadow contribution (shadow factor scaled to 1.0);
  // `strength=1` produces fully black at occluded pixels.
  let shadowFactor = mix(1.0, shadow, strength);
  return vec4<f32>(baseColor.rgb * shadowFactor, baseColor.a);
}
