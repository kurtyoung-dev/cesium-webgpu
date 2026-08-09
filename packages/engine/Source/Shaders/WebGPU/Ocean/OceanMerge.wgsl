// OceanMerge.wgsl — reassemble the inverse-FFT fields into a filterable
// displacement + foam map for the ocean surface.
//
// The FFT inputs store the spectrum centered (frequency index m = n - N/2), so
// the inverse transform output carries an fftshift factor, corrected here with
// the standard (-1)^(x+y) sign flip. fieldDyDx packs re=Dy (height) and im=Dx
// (x displacement); fieldDz packs re=Dz. The filterable rgba16float output is
// (lambda*Dx, Dy, lambda*Dz, foam), where foam comes from the Jacobian of the
// horizontal displacement — wave folding, J below threshold — evaluated by
// finite difference.
//
// Reference: fftshift correction from Jerry Tessendorf, "Simulating Ocean
// Water" (SIGGRAPH course notes); turbulence detection follows
// gasgiant/FFT-Ocean (MIT), see the Third-Party section of LICENSE.md.

struct MergeParams {
  size: u32,
  _pad0: u32,
  patchLength: f32,
  choppiness: f32,        // lambda
  heightScale: f32,       // overall displacement gain
  foamThreshold: f32,
  foamScale: f32,
  _pad1: f32,
};

@group(0) @binding(0) var FieldDyDx: texture_2d<f32>;
@group(0) @binding(1) var FieldDz: texture_2d<f32>;
@group(0) @binding(2) var Output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: MergeParams;

fn signAt(x: i32, y: i32) -> f32 {
  // (-1)^(x+y) fftshift correction.
  return select(-1.0, 1.0, ((x + y) & 1) == 0);
}

// Normalization for the unnormalized inverse FFT (the butterfly computes the
// un-scaled IDFT sum; dividing by N brings the summed spectral energy back to
// physical displacement — empirically calibrated to ~2 m RMS at U=12).
fn dispNorm() -> f32 {
  return params.heightScale / f32(params.size);
}

// Horizontal displacement (Dx, Dz) at texel (x,y), sign- and norm-corrected.
fn horizDisp(x: i32, y: i32, N: i32) -> vec2<f32> {
  let xw = ((x % N) + N) % N;
  let yw = ((y % N) + N) % N;
  let s = signAt(xw, yw) * dispNorm();
  let dx = textureLoad(FieldDyDx, vec2<i32>(xw, yw), 0).y * s;
  let dz = textureLoad(FieldDz, vec2<i32>(xw, yw), 0).x * s;
  return vec2<f32>(dx, dz);
}

@compute @workgroup_size(8, 8, 1)
fn merge(@builtin(global_invocation_id) id: vec3<u32>) {
  let N = i32(params.size);
  if (id.x >= params.size || id.y >= params.size) {
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  let norm = signAt(x, y) * dispNorm();

  let dyDx = textureLoad(FieldDyDx, vec2<i32>(x, y), 0).xy;
  let dy = dyDx.x * norm;
  let dx = dyDx.y * norm;
  let dz = textureLoad(FieldDz, vec2<i32>(x, y), 0).x * norm;

  let lambda = params.choppiness;

  // Jacobian of horizontal displacement via central differences (world units).
  let dWorld = params.patchLength / f32(params.size);
  let dispR = horizDisp(x + 1, y, N);
  let dispL = horizDisp(x - 1, y, N);
  let dispU = horizDisp(x, y + 1, N);
  let dispD = horizDisp(x, y - 1, N);
  let dDxdx = (dispR.x - dispL.x) / (2.0 * dWorld);
  let dDzdz = (dispU.y - dispD.y) / (2.0 * dWorld);
  let dDxdz = (dispU.x - dispD.x) / (2.0 * dWorld);
  let dDzdx = (dispR.y - dispL.y) / (2.0 * dWorld);
  let jxx = 1.0 + lambda * dDxdx;
  let jzz = 1.0 + lambda * dDzdz;
  let jxz = lambda * dDxdz;
  let jzx = lambda * dDzdx;
  let jacobian = jxx * jzz - jxz * jzx;
  let foam = clamp((params.foamThreshold - jacobian) * params.foamScale, 0.0, 1.0);

  textureStore(Output, vec2<i32>(x, y),
    vec4<f32>(lambda * dx, dy, lambda * dz, foam));
}
