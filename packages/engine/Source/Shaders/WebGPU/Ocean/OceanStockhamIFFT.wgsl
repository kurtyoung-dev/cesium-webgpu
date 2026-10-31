// OceanStockhamIFFT.wgsl — the FFT ocean's inverse FFT as two dispatches:
// one 256-lane workgroup per row (`horizontalStockham`), then one per column
// (`verticalStockham`), with all log2(N) = 8 radix-2 stages run in workgroup
// memory instead of eight global ping-pong passes each.
//
// The stage arithmetic is OceanIFFT.wgsl's, unchanged: each lane reads its
// (tw.re, tw.im, i0, i1) texel from the OceanTwiddle texture and computes
// in[i0] + conj(tw) * in[i1]. Reading the same texture, rather than evaluating
// cos/sin here, keeps every twiddle and index bit-for-bit the one the ping-pong
// kernel uses, so the two paths agree to the last bit without relying on the
// GPU's cos/sin being exactly even/odd. Both complex fields (Dy + i*Dx and Dz)
// travel together in one vec4 per lane.
//
// Workgroup storage: two 256 x vec4<f32> arrays, 8,192 B, half the 16,384 B
// WebGPU guarantees. N is fixed at 256 to match the workgroup size; the
// renderer's cascade is 256x256.

@group(0) @binding(0) var Twiddle: texture_2d<f32>;    // (tw.re, tw.im, i0, i1)
@group(0) @binding(1) var InputDyDx: texture_2d<f32>;  // rg32float complex
@group(0) @binding(2) var InputDz: texture_2d<f32>;    // rg32float complex
@group(0) @binding(3) var OutputDyDx: texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var OutputDz: texture_storage_2d<rg32float, write>;

const STOCKHAM_STAGE_PAIRS: u32 = 4u; // log2(N) / 2

var<workgroup> sPing: array<vec4<f32>, 256>;
var<workgroup> sPong: array<vec4<f32>, 256>;

fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// One butterfly: `data` is the lane's twiddle texel for the stage, `in0` and
// `in1` the two packed inputs it names. Inverse transform: the twiddle is
// conjugated.
fn stockhamButterfly(data: vec4<f32>, in0: vec4<f32>, in1: vec4<f32>) -> vec4<f32> {
  let tw = vec2<f32>(data.r, -data.g);
  let outA = in0.xy + complexMult(tw, in1.xy);
  let outB = in0.zw + complexMult(tw, in1.zw);
  return vec4<f32>(outA, outB);
}

// Runs the eight stages on the line held in sPing; the result ends in sPing.
fn runStockhamStages(t: u32) {
  for (var pair: u32 = 0u; pair < STOCKHAM_STAGE_PAIRS; pair = pair + 1u) {
    let s0 = pair * 2u;
    let d0 = textureLoad(Twiddle, vec2<i32>(i32(s0), i32(t)), 0);
    sPong[t] = stockhamButterfly(d0, sPing[u32(d0.b)], sPing[u32(d0.a)]);
    workgroupBarrier();
    let s1 = s0 + 1u;
    let d1 = textureLoad(Twiddle, vec2<i32>(i32(s1), i32(t)), 0);
    sPing[t] = stockhamButterfly(d1, sPong[u32(d1.b)], sPong[u32(d1.a)]);
    workgroupBarrier();
  }
}

@compute @workgroup_size(256, 1, 1)
fn horizontalStockham(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let t = lid.x;
  let coord = vec2<i32>(i32(t), i32(wid.x)); // lane = column, workgroup = row
  sPing[t] = vec4<f32>(
    textureLoad(InputDyDx, coord, 0).xy,
    textureLoad(InputDz, coord, 0).xy,
  );
  workgroupBarrier();
  runStockhamStages(t);
  let outv = sPing[t];
  textureStore(OutputDyDx, coord, vec4<f32>(outv.xy, 0.0, 0.0));
  textureStore(OutputDz, coord, vec4<f32>(outv.zw, 0.0, 0.0));
}

@compute @workgroup_size(256, 1, 1)
fn verticalStockham(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let t = lid.x;
  let coord = vec2<i32>(i32(wid.x), i32(t)); // lane = row, workgroup = column
  sPing[t] = vec4<f32>(
    textureLoad(InputDyDx, coord, 0).xy,
    textureLoad(InputDz, coord, 0).xy,
  );
  workgroupBarrier();
  runStockhamStages(t);
  let outv = sPing[t];
  textureStore(OutputDyDx, coord, vec4<f32>(outv.xy, 0.0, 0.0));
  textureStore(OutputDz, coord, vec4<f32>(outv.zw, 0.0, 0.0));
}
