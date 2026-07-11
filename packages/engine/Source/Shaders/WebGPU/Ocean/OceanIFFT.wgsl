// OceanIFFT.wgsl — radix-2 inverse FFT butterfly stages for the FFT spectral
// ocean (Campaign 6/7, C6-FFT-OCEAN). Precomputed twiddle+index texture drives
// a ping-pong texture butterfly: one dispatch per stage, `horizontalStep` walks
// rows, `verticalStep` walks columns. After log2(N) horizontal + log2(N)
// vertical stages the input spectrum is inverse-transformed into a real spatial
// field (see OceanMerge.wgsl for the reassembly).
//
// The precomputed-twiddle scheme and the inverse-conjugated twiddle are the
// gasgiant/FFT-Ocean (MIT, (c) 2020 Ivan Pensionerov) and BarthPaleologue/
// WebTide (MIT, (c) 2024 Barthelemy Paleologue) pattern. The exact sign/index
// conventions used here were re-derived and CPU-validated against a brute-force
// IDFT before porting (no fftshift permutation needed: the spectrum texel n
// maps to frequency index n so the butterfly output is the field directly).
//
// TEXTURE_BINDING (unfilterable-float, textureLoad only) for inputs; write-only
// rg32float storage for outputs. Ping-pong buffers alternate each stage.

struct IFFTParams {
  step: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var Twiddle: texture_2d<f32>;   // (tw.re, tw.im, i0, i1)
@group(0) @binding(1) var InputBuffer: texture_2d<f32>; // rg32float complex
@group(0) @binding(2) var OutputBuffer: texture_storage_2d<rg32float, write>;
@group(0) @binding(3) var<uniform> params: IFFTParams;

fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn horizontalStep(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = i32(id.x);
  let y = i32(id.y);
  let data = textureLoad(Twiddle, vec2<i32>(i32(params.step), x), 0);
  let i0 = i32(data.b);
  let i1 = i32(data.a);
  let in0 = textureLoad(InputBuffer, vec2<i32>(i0, y), 0).xy;
  let in1 = textureLoad(InputBuffer, vec2<i32>(i1, y), 0).xy;
  // Inverse transform conjugates the twiddle (tw.re, -tw.im).
  let tw = vec2<f32>(data.r, -data.g);
  let outv = in0 + complexMult(tw, in1);
  textureStore(OutputBuffer, vec2<i32>(x, y), vec4<f32>(outv, 0.0, 0.0));
}

@compute @workgroup_size(8, 8, 1)
fn verticalStep(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = i32(id.x);
  let y = i32(id.y);
  let data = textureLoad(Twiddle, vec2<i32>(i32(params.step), y), 0);
  let i0 = i32(data.b);
  let i1 = i32(data.a);
  let in0 = textureLoad(InputBuffer, vec2<i32>(x, i0), 0).xy;
  let in1 = textureLoad(InputBuffer, vec2<i32>(x, i1), 0).xy;
  let tw = vec2<f32>(data.r, -data.g);
  let outv = in0 + complexMult(tw, in1);
  textureStore(OutputBuffer, vec2<i32>(x, y), vec4<f32>(outv, 0.0, 0.0));
}
