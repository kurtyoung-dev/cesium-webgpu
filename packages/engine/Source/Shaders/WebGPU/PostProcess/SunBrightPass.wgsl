// SunBrightPass.wgsl — luminance bright pass for the sun glow.
//
// Twin of Shaders/PostProcessStages/BrightPass.glsl, the first stage of the
// WebGL `SunPostProcess` chain. The two must stay in lockstep: the extraction
// curve is what sets the glow's amplitude, so a change on one backend alone is
// a visible split.
//
// Not to be confused with BrightPass.wgsl in this directory, which is a port of
// ContrastBias.glsl and drives the scene-wide bloom stage. That shader shifts
// hue-saturation-brightness and applies a contrast curve; this one extracts
// supra-white luminance through a saturating rational. They share a name in
// English and nothing in arithmetic.
//
// See section 9, "The bright-pass filter", of Realtime HDR Rendering
// http://www.cg.tuwien.ac.at/research/publications/2007/Luksch_2007_RHR/Luksch_2007_RHR-RealtimeHDR%20.pdf
//
// Everything variable is a runtime uniform; the shader declares no preprocessor
// flags and therefore claims no ShaderDefine bit.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct SunBrightPassUniforms {
  // x = avgLuminance, a guess at the average luminance of the whole scene and
  //     the argument of `key()` below. A scene-exposure heuristic, not an
  //     extraction parameter.
  // y = threshold, the luminance at which extraction starts.
  // z = offset, so that `threshold + offset` is the luminance at which
  //     extraction reaches one half.
  // w = unused.
  params: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> brightPass: SunBrightPassUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Port of czm_RGBToXYZ (Shaders/Builtin/Functions/RGBToXYZ.glsl). Returns CIE
// Yxy: luminance in `r`, chromaticity in `gb`.
fn rgbToXyz(rgb: vec3<f32>) -> vec3<f32> {
  let xyz = vec3<f32>(
    dot(vec3<f32>(0.4124, 0.3576, 0.1805), rgb),
    dot(vec3<f32>(0.2126, 0.7152, 0.0722), rgb),
    dot(vec3<f32>(0.0193, 0.1192, 0.9505), rgb),
  );
  let total = xyz.x + xyz.y + xyz.z;
  // A lightless pixel has no chromaticity, and `xyz.rg / 0.0` is 0/0, which is
  // NaN rather than zero. Exact black is the only input that reaches it — every
  // matrix entry is positive — and it is also the most common pixel in a scene
  // rendered against space. A NaN here survives float storage and the two blur
  // passes spread it across the whole glow.
  if (!(total > 0.0)) {
    return vec3<f32>(xyz.y, 0.0, 0.0);
  }
  return vec3<f32>(xyz.y, xyz.x / total, xyz.y / total);
}

// Port of czm_XYZToRGB (Shaders/Builtin/Functions/XYZToRGB.glsl).
fn xyzToRgb(Yxy: vec3<f32>) -> vec3<f32> {
  // `Yxy.b` is the chromaticity y, strictly positive for every real colour and
  // zero only for the degenerate triple `rgbToXyz` returns for a lightless
  // pixel. Black is the honest answer there.
  if (!(Yxy.b > 0.0)) {
    return vec3<f32>(0.0);
  }
  let xyz = vec3<f32>(
    (Yxy.r * Yxy.g) / Yxy.b,
    Yxy.r,
    (Yxy.r * (1.0 - Yxy.g - Yxy.b)) / Yxy.b,
  );
  return vec3<f32>(
    dot(vec3<f32>(3.2405, -1.5371, -0.4985), xyz),
    dot(vec3<f32>(-0.9693, 1.8760, 0.0416), xyz),
    dot(vec3<f32>(0.0556, -0.2040, 1.0572), xyz),
  );
}

fn key(avg: f32) -> f32 {
  let guess = 1.5 - (1.5 / (avg * 0.1 + 1.0));
  return max(0.0, guess) + 0.1;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(inputTexture, inputSampler, in.uv);
  var xyz = rgbToXyz(color.rgb);
  let luminance = xyz.r;

  let avgLuminance = brightPass.params.x;
  let scaledLum = (key(avgLuminance) * luminance) / avgLuminance;
  let brightLum = max(scaledLum - brightPass.params.y, 0.0);
  let brightness = brightLum / (brightPass.params.z + brightLum);

  xyz.r = brightness;
  return vec4<f32>(xyzToRgb(xyz), 1.0);
}
