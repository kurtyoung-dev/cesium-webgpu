// Screen-Space Reflections (SSR) — WebGPU Post-Process
//
// Ray-marches in screen space to find reflected color from the depth buffer.
// Uses hierarchical tracing with binary refinement for performance.
//
// Bind group 0:
//   binding 0: color texture (previous frame or current)
//   binding 1: depth texture
//   binding 2: normal texture (eye-space normals from G-buffer or reconstructed)
//   binding 3: sampler
//   binding 4: SSR uniforms
//
// Algorithm:
//   1. Reconstruct view-space position from depth
//   2. Reflect the view direction around the surface normal
//   3. March the reflected ray through screen space (linear steps)
//   4. Binary-refine when a depth intersection is found
//   5. Fade at screen edges and based on Fresnel
//
// Reference: Efficient GPU Screen-Space Ray Tracing (Morgan McGuire, JCGT 2014)

struct SSRUniforms {
  // Projection matrix for view→clip transform
  projection: mat4x4<f32>,
  // Inverse projection for clip→view
  inverseProjection: mat4x4<f32>,
  // Screen resolution: x=width, y=height, z=1/width, w=1/height
  resolution: vec4<f32>,
  // x=maxDistance, y=thickness, z=maxSteps, w=stride
  params: vec4<f32>,
  // x=fadeScreenEdge, y=fadeDistance, z=reflectionStrength, w=fresnelPower
  params2: vec4<f32>,
  // .x flags whether `normalTex` carries valid eye-space normals or is the
  // placeholder. Below 0.5 the fragment stage computes normals from depth
  // derivatives instead of sampling the texture — a rough approximation, but
  // visually correct on reflective surfaces, where the placeholder instead
  // yields all-vertical noise.
  // .y is logActive: above 0.5 the sampled depth is log-encoded and must be
  // reversed before the unproject. .z and .w are the log-encode frustum near
  // and far. All zero keeps the hyperbolic path.
  flags: vec4<f32>,
};

@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> ssr: SSRUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Full-screen triangle (3 vertices, no vertex buffer needed)
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 2 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 2 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Inline `csm_reverseLogDepth`, byte-compatible with
// `chunks/functions/csm_reverseLogDepth.wgsl`. Maps a [0,1] log-depth value
// back to the hyperbolic [0,1] window-space NDC z a standard
// inverse-projection consumer expects.
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

// Reconstruct view-space position from depth and UV
fn reconstructViewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  // The shared depth texture is log-encoded by default (renderer-wide log
  // depth). Reverse to hyperbolic NDC z before unprojecting; the flag is
  // packed by WebGPUSSREffect only when the master switch + useLogDepth are
  // on AND a valid encode frustum is stashed, so flags.y<0.5 keeps the
  // byte-identical pre-Slice-C path.
  var z = depth;
  if (ssr.flags.y > 0.5) {
    z = logDepthReverse(depth, ssr.flags.z, ssr.flags.w);
  }
  let ndc = vec4<f32>(uv * 2.0 - 1.0, z, 1.0);
  var viewPos = ssr.inverseProjection * ndc;
  viewPos /= viewPos.w;
  return viewPos.xyz;
}

// Project view-space position to screen UV + depth
fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  var clipPos = ssr.projection * vec4<f32>(viewPos, 1.0);
  clipPos /= clipPos.w;
  let screenUV = clipPos.xy * 0.5 + 0.5;
  return vec3<f32>(screenUV.x, 1.0 - screenUV.y, clipPos.z);
}

// Screen-edge fade: attenuate reflections near viewport borders
fn screenEdgeFade(uv: vec2<f32>) -> f32 {
  let fadeWidth = ssr.params2.x; // default 0.1
  let edgeDist = min(
    min(uv.x, 1.0 - uv.x),
    min(uv.y, 1.0 - uv.y)
  );
  return smoothstep(0.0, fadeWidth, edgeDist);
}

// Fresnel factor for reflection strength
fn fresnelFade(NdotV: f32) -> f32 {
  let power = ssr.params2.w; // default 5.0
  return pow(1.0 - clamp(NdotV, 0.0, 1.0), power);
}

// Linear ray march with binary refinement
fn traceRay(
  origin: vec3<f32>,
  direction: vec3<f32>,
) -> vec4<f32> {
  let maxDist = ssr.params.x;     // default 50.0
  let thickness = ssr.params.y;    // default 0.5
  let maxSteps = i32(ssr.params.z); // default 64
  let stride = ssr.params.w;       // default 2.0

  var rayPos = origin;
  let step = direction * stride;

  // Linear march
  var hitUV = vec2<f32>(0.0);
  var hit = false;

  for (var i: i32 = 0; i < maxSteps; i++) {
    rayPos += step;

    // Check max distance
    if (length(rayPos - origin) > maxDist) { break; }

    let screenCoord = projectToScreen(rayPos);
    let uv = screenCoord.xy;

    // Out of screen bounds
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }

    let sampleDepth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;
    let sampleViewPos = reconstructViewPosition(uv, sampleDepth);

    // Depth difference between ray and scene
    let depthDiff = rayPos.z - sampleViewPos.z;

    // Hit: ray is behind the surface within thickness
    if (depthDiff > 0.0 && depthDiff < thickness) {
      hitUV = uv;
      hit = true;

      // Binary refinement (5 steps)
      var refinedPos = rayPos;
      var refinedStep = step * 0.5;
      for (var r: i32 = 0; r < 5; r++) {
        refinedPos -= refinedStep;
        refinedStep *= 0.5;

        let rScreen = projectToScreen(refinedPos);
        let rDepth = textureSampleLevel(depthTex, texSampler, rScreen.xy, 0.0).r;
        let rViewPos = reconstructViewPosition(rScreen.xy, rDepth);
        let rDiff = refinedPos.z - rViewPos.z;

        if (rDiff > 0.0) {
          refinedPos += refinedStep * 2.0;
        }
      }

      hitUV = projectToScreen(refinedPos).xy;
      break;
    }
  }

  if (!hit) { return vec4<f32>(0.0); }

  let reflectedColor = textureSampleLevel(colorTex, texSampler, hitUV, 0.0).rgb;
  let edgeFade = screenEdgeFade(hitUV);
  let distFade = 1.0 - smoothstep(maxDist * 0.5, maxDist, length(rayPos - origin));

  return vec4<f32>(reflectedColor, edgeFade * distFade);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let originalColor = textureSample(colorTex, texSampler, uv).rgb;

  let depth = textureSampleLevel(depthTex, texSampler, uv, 0.0).r;

  // Sky (depth == 1.0 or 0.0 depending on reversed-Z) — no reflection
  if (depth >= 0.999 || depth <= 0.001) {
    return vec4<f32>(originalColor, 1.0);
  }

  let viewPos = reconstructViewPosition(uv, depth);

  // AUDIT_2026_05_02 B.15 — when the host hasn't bound a real normal
  // G-buffer (`flags.x < 0.5`), reconstruct the surface normal from
  // neighbor-pixel view positions. This is a coarse approximation but
  // produces visually plausible reflections on horizontal/vertical
  // surfaces — far better than the all-noise sampled placeholder.
  // FEAT-GAP-01 will replace this with a real normal G-buffer.
  var normal: vec3<f32>;
  if (ssr.flags.x < 0.5) {
    let invRes = ssr.resolution.zw;
    let depthDx = textureSampleLevel(
      depthTex, texSampler, uv + vec2<f32>(invRes.x, 0.0), 0.0,
    ).r;
    let depthDy = textureSampleLevel(
      depthTex, texSampler, uv + vec2<f32>(0.0, invRes.y), 0.0,
    ).r;
    let viewPosDx = reconstructViewPosition(
      uv + vec2<f32>(invRes.x, 0.0), depthDx,
    );
    let viewPosDy = reconstructViewPosition(
      uv + vec2<f32>(0.0, invRes.y), depthDy,
    );
    let dPosDx = viewPosDx - viewPos;
    let dPosDy = viewPosDy - viewPos;
    let n = cross(dPosDy, dPosDx);
    let nLenSq = dot(n, n);
    if (nLenSq < 1.0e-8) {
      return vec4<f32>(originalColor, 1.0);
    }
    normal = n * inverseSqrt(nLenSq);
  } else {
    // Read the eye-space normal directly from the G-buffer. It is rgba16float
    // written by `GBufferNormalsFromDepth.wgsl` with normals already in the
    // signed [-1, 1] range, so no `* 2 - 1` decode is needed. Applying one —
    // as if the packing were UNORM — silently halves every component and
    // offsets it by -1, producing wrong-direction reflections on any surface
    // whose normal is not near (0.5, 0.5, 0.5) in encoded space.
    //
    // Sentinel check: the producer emits (0,0,0,*) for sky, depth-clear and
    // high-gradient pixels. Those are skipped — no useful normal to reflect.
    let normalRoughness = textureSampleLevel(normalTex, texSampler, uv, 0.0);
    let normalSample = normalRoughness.xyz;
    if (length(normalSample) < 0.1) {
      return vec4<f32>(originalColor, 1.0);
    }
    normal = normalize(normalSample);
    // Read roughness from the G-buffer's `.w` channel. The producer writes a
    // depth-gradient-derived roughness proxy: smooth surfaces such as water
    // and building facades land near 0.1, a sharp mirror, while rough ones
    // such as terrain and vegetation land near 0.95, effectively diffuse and
    // with no reflection. Ray marching is skipped entirely for high-roughness
    // surfaces, whose reflection would be blurred to invisibility anyway.
    if (normalRoughness.w > 0.6) {
      return vec4<f32>(originalColor, 1.0);
    }
    // Stash the per-fragment roughness for the final blend. Note:
    // WGSL doesn't allow `var` declarations to span this `if/else`
    // boundary cleanly, so we re-extract below by sampling once more
    // in the blend path (sampler-side cache; cheap).
  }
  let viewDir = normalize(viewPos);
  let NdotV = abs(dot(normal, -viewDir));

  // Reflect the view direction
  let reflectDir = reflect(viewDir, normal);

  // Trace the reflected ray
  let result = traceRay(viewPos, reflectDir);

  // Combine with the Fresnel-weighted reflection strength and the roughness
  // attenuation. Roughness comes from the G-buffer when `flags.x > 0.5`, and
  // falls back to 0.0, a mirror, on the depth-fallback path, where there is
  // no roughness signal.
  let reflectionStrength = ssr.params2.z; // default 0.5
  let fresnel = fresnelFade(NdotV);
  var roughness: f32 = 0.0;
  if (ssr.flags.x > 0.5) {
    roughness = textureSampleLevel(normalTex, texSampler, uv, 0.0).w;
  }
  // Smooth → 1.0 reflectance contribution; rough → fades toward 0.
  // We already early-returned for roughness > 0.6 above, so the
  // roughness here is in [0, 0.6]. Map linearly to a [1, 0] attenuator
  // so mid-roughness surfaces still contribute reduced SSR.
  let roughnessAttenuation = 1.0 - clamp(roughness / 0.6, 0.0, 1.0);
  let blendFactor = result.a * fresnel * reflectionStrength * roughnessAttenuation;

  let finalColor = mix(originalColor, result.rgb, blendFactor);
  return vec4<f32>(finalColor, 1.0);
}
