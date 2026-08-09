// OceanTwiddle.wgsl — precompute the twiddle-factor + butterfly-index texture
// for OceanIFFT.wgsl. One rgba32float texel per (step, index):
// (tw.re, tw.im, i0, i1). Run once at init, and again on resize.
//
// Reference: mirrors the gasgiant/FFT-Ocean (MIT)
// PrecomputeTwiddleFactorsAndInputIndices kernel and WebTide's
// twiddleFactors.wgsl; see the Third-Party section of LICENSE.md. The formula
// below was CPU-validated against a brute-force IDFT. It is
// decimation-in-frequency: the top half of the column shares indices with the
// bottom half and negates the twiddle.

struct TwiddleParams {
  size: u32,       // N (power of two)
  log2Size: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var Output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var<uniform> params: TwiddleParams;

const PI: f32 = 3.14159265358979323846;

@compute @workgroup_size(1, 64, 1)
fn precompute(@builtin(global_invocation_id) id: vec3<u32>) {
  let step = id.x;
  let y = id.y;
  let N = params.size;
  if (step >= params.log2Size || y >= N) {
    return;
  }
  let b = N >> (step + 1u);
  let half = N / 2u;
  var j = y;
  var negate = false;
  if (y >= half) {
    j = y - half;
    negate = true;
  }
  let block = j / b;
  let i0 = (2u * b * block + (j % b)) % N;
  let i1 = i0 + b;
  let angle = -2.0 * PI * f32(block * b) / f32(N);
  var tw = vec2<f32>(cos(angle), sin(angle));
  if (negate) {
    tw = -tw;
  }
  textureStore(Output, vec2<i32>(i32(step), i32(y)),
    vec4<f32>(tw.x, tw.y, f32(i0), f32(i1)));
}
