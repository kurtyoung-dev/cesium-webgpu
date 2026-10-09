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

// Clip-space corner of the full-screen triangle for vertex 0, 1 or 2:
// (-1,-1), (3,-1), (-1,3). Its hypotenuse x + y = 2 passes through the NDC
// corner (1,1), so the one triangle covers all of [-1,1] x [-1,1]. Corners
// at +-1 alone, (-1,-1), (1,-1), (-1,1), would cover only the half below the
// diagonal x + y = 0. The index arrives as f32 and is matched with `select`
// so the law stays pure arithmetic.
fn ssrFullScreenCorner(vertexIndex: f32) -> vec2<f32> {
  return vec2<f32>(
    select(-1.0, 3.0, vertexIndex == 1.0),
    select(-1.0, 3.0, vertexIndex == 2.0)
  );
}

// NDC xy to the screen UV the color and depth textures are sampled with. UV
// y grows downward (row 0 is the top of the target) while NDC y grows upward,
// hence the flip. `ssrUVToNdc` is its exact inverse; the vertex stage and
// `projectToScreen` both go through this one map, so every UV in the pass is
// in the same frame.
fn ssrNdcToUV(ndc: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
}

fn ssrUVToNdc(uv: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}

// Full-screen triangle (3 vertices, no vertex buffer needed)
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let corner = ssrFullScreenCorner(f32(vertexIndex));
  out.position = vec4<f32>(corner, 0.0, 1.0);
  out.uv = ssrNdcToUV(corner);
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

// The sampled depth as hyperbolic NDC z. The shared depth texture is
// log-encoded by default (renderer-wide log depth), so it is reversed before
// unprojecting. WebGPUSSREffect packs the flag only when the master switch
// and useLogDepth are on AND a valid encode frustum is stashed; flags.y < 0.5
// passes the depth through unchanged, the hyperbolic path.
fn ssrNdcDepth(depth: f32) -> f32 {
  if (ssr.flags.y > 0.5) {
    return logDepthReverse(depth, ssr.flags.z, ssr.flags.w);
  }
  return depth;
}

// Reconstruct view-space position from depth and UV. The exact inverse of
// `projectToScreen`: both cross between UV and NDC through the same flip.
fn reconstructViewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(ssrUVToNdc(uv), ssrNdcDepth(depth), 1.0);
  let viewPos = ssr.inverseProjection * ndc;
  return viewPos.xyz / viewPos.w;
}

// Project view-space position to screen UV + depth
fn projectToScreen(viewPos: vec3<f32>) -> vec3<f32> {
  let clipPos = ssr.projection * vec4<f32>(viewPos, 1.0);
  return vec3<f32>(ssrNdcToUV(clipPos.xy / clipPos.w), clipPos.z / clipPos.w);
}

// One step of the hit refinement's bisection. `diff` is the ray-minus-scene
// depth difference at `pos`; `hitDiff` is the one at the march step that
// detected the hit. While `pos` is on the hit's side of the depth crossing the
// crossing lies behind it, so the walk steps back by `halfStep`; once it is on
// the other side it steps forward. Repeating this with `halfStep` halved each
// time keeps the crossing within the last step taken.
fn ssrBisectStep(
  pos: vec3<f32>,
  halfStep: vec3<f32>,
  diff: f32,
  hitDiff: f32,
) -> vec3<f32> {
  return select(pos + halfStep, pos - halfStep, (diff > 0.0) == (hitDiff > 0.0));
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

      // Binary refinement: five depth samples steer six bisection steps of
      // half, a quarter, ... 1/64 of the march step, so the refined hit lies
      // within 1/64 of a march step of the depth crossing between the last
      // two march positions. The first step needs no sample: the march
      // position is on the hit's side by definition.
      var refinedPos = rayPos;
      var refinedStep = step * 0.5;
      var refinedDiff = depthDiff;
      for (var r: i32 = 0; r < 5; r++) {
        refinedPos = ssrBisectStep(refinedPos, refinedStep, refinedDiff, depthDiff);
        refinedStep *= 0.5;

        let rScreen = projectToScreen(refinedPos);
        let rDepth = textureSampleLevel(depthTex, texSampler, rScreen.xy, 0.0).r;
        let rViewPos = reconstructViewPosition(rScreen.xy, rDepth);
        refinedDiff = refinedPos.z - rViewPos.z;
      }
      refinedPos = ssrBisectStep(refinedPos, refinedStep, refinedDiff, depthDiff);

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

  // When the host hasn't bound a real normal G-buffer (`flags.x < 0.5`),
  // reconstruct the surface normal from neighbor-pixel view positions. This
  // is a coarse approximation but produces visually plausible reflections on
  // horizontal/vertical surfaces. Binding a real normal G-buffer would
  // replace this reconstruction outright; none is produced yet.
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
