// Cloud Half-Res Bilateral Upscale + Composite — WebGPU
//
// Second pass of the half-resolution cloud path. The procedural-cloud raymarch
// ran at 0.5× into an rgba16float target holding premultiplied cloud radiance
// (rgb = hazed·alpha) and coverage (a = alpha). This full-res pass reconstructs
// that buffer with a depth-aware joint-bilateral upsample and composites the
// result over the full-res scene color, writing the canvas.
//
// Why bilateral rather than a plain 2× bilinear blow-up: a cloud silhouette runs
// along a large scene-depth discontinuity — cloud over terrain, cloud edge over
// sky. A naive bilinear upscale bleeds half-res cloud across that edge into a fat
// blocky fringe and a dark-bright halo. Weighting each half-res tap by how
// closely its own scene depth matches the full-res output pixel's scene depth
// rejects taps from the other side of the discontinuity, so the silhouette stays
// crisp at full-res sharpness while the cloud interior gets the soft 0.5×
// reconstruction.
//
// References: Wronski, "Volumetric Atmospheric Scattering" (GDC 2014); the
// bilateral-upsample idea is from Kopf et al., "Joint Bilateral Upsampling"
// (2007).

struct UpscaleUniforms {
  // Full-res canvas size (px) and its reciprocal.
  fullResolution: vec2<f32>,
  invFullResolution: vec2<f32>,
  // Half-res cloud target size (px) and its reciprocal.
  halfResolution: vec2<f32>,
  invHalfResolution: vec2<f32>,
  // Bilateral depth-similarity falloff. The bound depth is the renderer-wide
  // nonlinear log depth in [0,1], so depthSigma is in that space rather than in
  // metres; a small value around 5e-3 keeps only taps within a thin depth band.
  depthSigma: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var cloudHalfTex: texture_2d<f32>; // premultiplied cloud (rgba16float)
@group(0) @binding(1) var sceneColorTex: texture_2d<f32>; // full-res scene color
@group(0) @binding(2) var sceneDepthTex: texture_2d<f32>;  // full-res scene depth (log, [0,1])
@group(0) @binding(3) var linearSampler: sampler;          // clamp, linear
@group(0) @binding(4) var<uniform> u: UpscaleUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Full-screen oversized triangle, matching ProceduralClouds.wgsl::vertexMain so
// the UV convention — v flipped — is identical and the cloud and scene UVs stay
// aligned.
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Depth-similarity weight: 1.0 when the tap depth equals the centre depth,
// falling off with the squared difference over depthSigma². Both depths are the
// nonlinear log depth, so identical sky or terrain pixels match exactly and a
// terrain-to-sky edge gets a near-zero cross weight, which is what preserves the
// silhouette.
fn depthWeight(centerDepth: f32, tapDepth: f32) -> f32 {
  let d = centerDepth - tapDepth;
  let s = max(u.depthSigma, 1e-6);
  return exp(-(d * d) / (s * s));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let sceneColor = textureSampleLevel(sceneColorTex, linearSampler, uv, 0.0);
  let centerDepth = textureSampleLevel(sceneDepthTex, linearSampler, uv, 0.0).r;

  // Locate this full-res pixel within the half-res grid. The four nearest
  // half-res texel centres form the bilinear footprint; `f` is the bilinear
  // fraction.
  let halfCoord = uv * u.halfResolution - vec2<f32>(0.5);
  let baseTexel = floor(halfCoord);
  let f = halfCoord - baseTexel;

  // Bilinear spatial weights for the 2×2 footprint: top-left, top-right,
  // bottom-left, bottom-right.
  let wTL = (1.0 - f.x) * (1.0 - f.y);
  let wTR = f.x * (1.0 - f.y);
  let wBL = (1.0 - f.x) * f.y;
  let wBR = f.x * f.y;

  var cloudAccum = vec4<f32>(0.0);
  var weightAccum = 0.0;

  // Unrolled 2×2 joint-bilateral. Each tap reads the premultiplied half-res
  // cloud, reads the scene depth at that tap's own full-res location so the depth
  // term compares like for like, and is weighted by spatial × depth similarity.
  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0)
  );
  let spatial = array<f32, 4>(wTL, wTR, wBL, wBR);

  for (var i: i32 = 0; i < 4; i = i + 1) {
    let texel = baseTexel + offsets[i];
    // Half-res texel centre to UV, used for both the cloud read and the matching
    // scene-depth read, so the bilateral compares the depth the tap was marched
    // against.
    let tapUV = (texel + vec2<f32>(0.5)) * u.invHalfResolution;
    let cloudTap = textureSampleLevel(cloudHalfTex, linearSampler, tapUV, 0.0);
    let tapDepth = textureSampleLevel(sceneDepthTex, linearSampler, tapUV, 0.0).r;
    let w = spatial[i] * depthWeight(centerDepth, tapDepth);
    cloudAccum = cloudAccum + cloudTap * w;
    weightAccum = weightAccum + w;
  }

  // Normalize. When every tap is rejected — a thin sliver with no
  // depth-consistent neighbour — fall back to the nearest tap, so the division
  // never runs against ~0 and the result is a slightly soft pixel rather than a
  // NaN hole.
  var cloud: vec4<f32>;
  if (weightAccum > 1e-4) {
    cloud = cloudAccum / weightAccum;
  } else {
    let nearestUV = (baseTexel + vec2<f32>(0.5)) * u.invHalfResolution;
    cloud = textureSampleLevel(cloudHalfTex, linearSampler, nearestUV, 0.0);
  }

  // Composite premultiplied cloud over scene: out = cloud.rgb + scene·(1-alpha).
  let outRgb = cloud.rgb + sceneColor.rgb * (1.0 - cloud.a);
  return vec4<f32>(outRgb, sceneColor.a);
}
