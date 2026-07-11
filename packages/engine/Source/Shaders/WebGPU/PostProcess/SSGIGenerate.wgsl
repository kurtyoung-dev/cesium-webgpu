// SSGIGenerate — Screen-Space Global Illumination (visibility bitmask / SSILVB).
//
// Fork-added Campaign-6 rendering enhancement (C6-SSGI-DIFFUSE). Opt-in,
// default-off: reachable only when the AmbientOcclusion post-process stage is
// enabled AND its `algorithm` uniform is set to "ssgi". When any other
// algorithm ("hbao"/"gtao") is selected, or the AO stage is disabled (the
// default), this shader is never compiled or executed → byte-identical output.
//
// Structural superset of GTAOGenerate.wgsl: the same per-pixel slice/step
// horizon scan, the same depth reconstruction (readDepth/logDepthReverse,
// C4-LOGDEPTH-PP-SLICEB), the same random rotation. The delta vs GTAO:
//   - replace the two horizon cosines with a 32-bit sector visibility bitmask
//     (countOneBits over uniform angular sectors of the slice hemicircle), and
//   - accumulate scene-color radiance for each newly-occluded sector, weighted
//     by the receiver cosine and a HDR luminance firefly clamp.
// One pass produces BOTH an improved AO term (.a, thin-surface fix from the
// per-sample linear thickness) and a diffuse indirect-bounce color (.rgb).
//
// Output: rgba16float = vec4(gi.rgb * giIntensity, aoVisibility). Consumed by
// BilateralBlur1D (depth-aware denoise) then SSGIComposite (upsample/modulate).
//
// Reference / attribution (MIT — see RESEARCH_R-SSGI §4):
//   Therrien, Levesque, Gilet, "Screen Space Indirect Lighting with Visibility
//   Bitmask", The Visual Computer 2023 (arXiv:2301.11376). Derived, technique
//   only, from the MIT-licensed three.js SSGINode (© 2010-2026 three.js
//   authors) and cdrinmatane/SSRT3 (© 2024 CDRIN). No source copied verbatim.
//
// Planet-scale guards (Cesium-specific; RESEARCH_R-SSGI §7):
//   - depth read via readDepth() so log-depth (frustum.z) is reversed for free;
//   - all math stays eye-space (pixelToEye output, magnitudes <= far) → RTE-safe
//     exactly like TAA.wgsl; never reconstructs world position at Earth scale;
//   - sky rejection: center or march samples at -z >= far*0.99 neither occlude
//     nor emit (sky bounce is already double-counted by the IBL/atmosphere);
//   - screen-space-proportional radius (constant pixel reach) with an eye-space
//     maxWorldRadius cap, so orbit views degrade to a near no-op;
//   - per-sample linear thickness = max(thicknessMin, thicknessK * -viewZ).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SSGIUniforms {
  // x = aoIntensity, y = bias, z = altitudeFade [0,1], w = stepCount
  params0: vec4<f32>,
  // x = sliceCount, y = 1/width, z = 1/height, w = randomTexSize
  params1: vec4<f32>,
  // x = near, y = far, z = logActive (C4-LOGDEPTH-PP-SLICEB), w = unused
  frustum: vec4<f32>,
  // x = giIntensity, y = luminanceClamp, z = thicknessMin, w = thicknessK
  params2: vec4<f32>,
  // x = radiusPixels, y = maxWorldRadius, z = frameIndex, w = expFactor
  params3: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var randomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: SSGIUniforms;
@group(0) @binding(4) var sceneColorTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const HALF_PI: f32 = 1.57079632679;
const SECTOR_COUNT: u32 = 32u;

fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn readDepth(uv: vec2<f32>) -> f32 {
  // textureSampleLevel (explicit LOD 0) so the call is legal from the divergent
  // control flow of the slice/step march (textureSample needs uniform flow).
  let raw = textureSampleLevel(depthTexture, texSampler, uv, 0.0).r;
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  var d = raw;
  if (uniforms.frustum.z > 0.5) {
    d = logDepthReverse(raw, near, far);
  }
  let z = near * far / (far - d * (far - near));
  // Sanitize against Inf/NaN from a degenerate planet-scale frustum (select()
  // returns the fallback for NaN — all comparisons are false — and for
  // out-of-range values). A NaN eye-space position would poison the march.
  return select(far, z, z > 0.0 && z < 1e20);
}

fn pixelToEye(screenCoord: vec2<f32>) -> vec3<f32> {
  let uv = screenCoord * vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let depth = readDepth(uv);
  let xy = 2.0 * uv - vec2<f32>(1.0);
  return vec3<f32>(xy * depth, -depth);
}

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

// Map a signed slice-space angle interval [phiMin, phiMax] (radians, measured
// from the view direction, positive toward +sliceDir) onto the 32-sector
// bitmask covering the slice hemicircle [-PI/2, PI/2].
fn sectorBits(phiMin: f32, phiMax: f32) -> u32 {
  let a = clamp(phiMin / PI + 0.5, 0.0, 1.0) * f32(SECTOR_COUNT);
  let b = clamp(phiMax / PI + 0.5, 0.0, 1.0) * f32(SECTOR_COUNT);
  let lo = min(a, b);
  let hi = max(a, b);
  let startBit = u32(floor(lo));
  let endBit = u32(ceil(hi));
  if (endBit <= startBit) {
    return 0u;
  }
  var cnt = endBit - startBit;
  cnt = min(cnt, SECTOR_COUNT);
  let s = min(startBit, SECTOR_COUNT - 1u);
  let mask = select(0xFFFFFFFFu >> (SECTOR_COUNT - cnt), 0xFFFFFFFFu, cnt >= SECTOR_COUNT);
  return mask << s;
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

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let aoIntensity = uniforms.params0.x;
  let bias = uniforms.params0.y;
  let altitudeFade = uniforms.params0.z;
  let stepCount = i32(uniforms.params0.w);
  let sliceCount = i32(uniforms.params1.x);
  let texelSize = vec2<f32>(uniforms.params1.y, uniforms.params1.z);
  let randomTexSize = uniforms.params1.w;

  let giIntensity = uniforms.params2.x;
  let lumClamp = max(uniforms.params2.y, 1e-3);
  let thicknessMin = uniforms.params2.z;
  let thicknessK = uniforms.params2.w;

  let radiusPixels = uniforms.params3.x;
  let maxWorldRadius = uniforms.params3.y;
  let frameIndex = uniforms.params3.z;
  let expFactor = max(uniforms.params3.w, 1.0);

  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;

  // Altitude fade (planet-scale no-op guard, RESEARCH_R-SSGI §7.2). Computed on
  // the CPU from camera height and decoupled from depth reconstruction, so the
  // effect degrades to a byte-exact no-op from orbit even where multi-frustum
  // depth would otherwise mis-reconstruct sample distances (the maxWorldRadius
  // world-space break cannot catch that case because the mis-reconstructed
  // distances are small). fade=0 → return scene-preserving (gi=0, ao=1).
  if (altitudeFade <= 0.001) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let screenCoord = in.uv / texelSize;
  let centerEC = pixelToEye(screenCoord);

  // Sky / background early-out — AO fully visible, no GI.
  if (-centerEC.z >= far * 0.99) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let normal = getNormal(centerEC, screenCoord);
  let viewDir = normalize(-centerEC);
  let thickness = max(thicknessMin, thicknessK * max(-centerEC.z, 0.01));

  // Per-pixel random rotation + temporal rotation keyed to the TAA frame index
  // (Activision GTAO 6-angle × 4-offset cycle — coherent with the downstream
  // TAA so the residual slice banding integrates instead of aliasing).
  let randomUV = fract(screenCoord / max(randomTexSize, 1.0));
  let randSample = textureSampleLevel(randomTexture, texSampler, randomUV, 0.0);
  let baseAngle = randSample.r * 2.0 * PI;
  var temporalRot = array<f32, 6>(60.0, 300.0, 180.0, 240.0, 120.0, 0.0);
  var temporalOff = array<f32, 4>(0.0, 0.5, 0.25, 0.75);
  let rotIdx = u32(max(frameIndex, 0.0)) % 6u;
  let offIdx = u32(max(frameIndex, 0.0)) % 4u;
  let randAngle = baseAngle + temporalRot[rotIdx] * (PI / 180.0);
  let jitter = fract(randSample.g + temporalOff[offIdx]);

  let sliceStep = PI / max(1.0, f32(sliceCount));
  let stepPix = max(1.0, radiusPixels / max(1.0, f32(stepCount)));

  var gi = vec3<f32>(0.0);
  var occludedFrac: f32 = 0.0;

  for (var slice = 0; slice < sliceCount; slice = slice + 1) {
    let theta = randAngle + f32(slice) * sliceStep;
    let dir2D = vec2<f32>(cos(theta), sin(theta));
    let sliceDir3D = normalize(vec3<f32>(dir2D.x, dir2D.y, 0.0));

    var bitfield: u32 = 0u;

    // Scan both sides of the slice through the center. side = -1 and +1 map to
    // the two halves of the hemicircle; the signed slice-space angle handles
    // both uniformly.
    for (var sideI = 0; sideI < 2; sideI = sideI + 1) {
      let side = select(1.0, -1.0, sideI == 0);
      for (var s = 1; s <= stepCount; s = s + 1) {
        // Exponential step distribution — denser near the center pixel.
        let t = (f32(s) - jitter) / f32(stepCount);
        let offsetPix = max(pow(clamp(t, 0.0, 1.0), expFactor) * radiusPixels, stepPix * f32(s));
        let sampleScreenClamped = screenCoord + dir2D * (side * offsetPix);
        let samplePos = pixelToEye(sampleScreenClamped);

        // Sky rejection — sky texels neither occlude nor emit.
        if (-samplePos.z >= far * 0.99) {
          continue;
        }

        let deltaPos = samplePos - centerEC;
        let dist = length(deltaPos);
        // World-radius cap (orbit-view degradation → no-op).
        if (dist > maxWorldRadius) {
          break;
        }
        if (dist < 1e-4) {
          continue;
        }

        let w = deltaPos / dist;
        let deltaBack = deltaPos - viewDir * thickness;
        let wBack = normalize(deltaBack);

        // Signed slice-space angles (from viewDir, positive toward sliceDir3D).
        let phiFront = atan2(dot(w, sliceDir3D), dot(w, viewDir));
        let phiBack = atan2(dot(wBack, sliceDir3D), dot(wBack, viewDir));

        // Bias nudges the interval slightly toward the view to suppress
        // self-occlusion at skirts/silhouettes (matches GTAO's cosH - bias).
        let bits = sectorBits(phiFront + bias * side, phiBack + bias * side);
        let newBits = countOneBits(bits & ~bitfield);
        bitfield = bitfield | bits;

        if (newBits > 0u) {
          let sampleUV = sampleScreenClamped * texelSize;
          var c = textureSampleLevel(
            sceneColorTexture, texSampler, sampleUV, 0.0).rgb;
          let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
          c = c * select(1.0, lumClamp / lum, lum > lumClamp);
          let nDotL = clamp(dot(normal, w), 0.0, 1.0);
          gi += (f32(newBits) / f32(SECTOR_COUNT)) * c * nDotL;
        }
      }
    }

    occludedFrac += f32(countOneBits(bitfield)) / f32(SECTOR_COUNT);
  }

  let invSlices = 1.0 / max(1.0, f32(sliceCount));
  gi = gi * invSlices * giIntensity * altitudeFade;
  occludedFrac = occludedFrac * invSlices;
  var visibility = clamp(1.0 - occludedFrac * aoIntensity, 0.0, 1.0);
  // Fade AO toward fully-visible with altitude so partial (>0) fade regions
  // transition smoothly to the no-op instead of popping.
  visibility = mix(1.0, visibility, altitudeFade);

  return vec4<f32>(gi, visibility);
}
