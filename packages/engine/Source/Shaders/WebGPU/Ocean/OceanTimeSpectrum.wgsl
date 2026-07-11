// OceanTimeSpectrum.wgsl — per-frame time evolution of the ocean spectrum
// (Campaign 6/7, C6-FFT-OCEAN). Reads the static h0(k)/conj(h0(-k)) packing and
// produces the two complex fields that the inverse FFT turns into real spatial
// displacement:
//
//   h(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}   (Hermitian -> real field)
//   Dy(k)  = h                                        (vertical height)
//   Dx(k)  = -i kx/|k| * h                            (horizontal choppiness)
//   Dz(k)  = -i kz/|k| * h
//
// Two-for-one packing (both Dy and Dx spectra are Hermitian so each IFFTs to a
// real field): output0 = Dy + i*Dx  (IFFT -> re=Dy, im=Dx); output1 = Dz.
// Deep-water dispersion w = sqrt(g|k|). Wave clock `time` is frame-number
// derived (quantized upstream) so paused clocks still animate deterministically
// across multi-view (B630 lesson).
//
// Derived from Tessendorf's published equations; packing follows gasgiant/
// FFT-Ocean (MIT) and Popov72/OceanDemo (MIT, WGSL) time-dependent-spectrum.

struct TimeParams {
  size: u32,
  _pad0: u32,
  patchLength: f32,
  gravity: f32,
  time: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

@group(0) @binding(0) var H0: texture_2d<f32>; // (h0.xy, conj(h0(-k)).zw)
@group(0) @binding(1) var OutputDyDx: texture_storage_2d<rg32float, write>;
@group(0) @binding(2) var OutputDz: texture_storage_2d<rg32float, write>;
@group(0) @binding(3) var<uniform> params: TimeParams;

const PI: f32 = 3.14159265358979323846;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn evolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let N = params.size;
  if (id.x >= N || id.y >= N) {
    return;
  }
  let half = i32(N) / 2;
  let mx = i32(id.x) - half;
  let mz = i32(id.y) - half;
  let dk = 2.0 * PI / params.patchLength;
  let k = vec2<f32>(f32(mx) * dk, f32(mz) * dk);
  let kLen = length(k);

  let packed = textureLoad(H0, vec2<i32>(id.xy), 0);
  let h0 = packed.xy;
  let h0MinusConj = packed.zw;

  let w = sqrt(params.gravity * kLen);
  let phase = w * params.time;
  let ep = vec2<f32>(cos(phase), sin(phase));   // e^{iwt}
  let em = vec2<f32>(cos(phase), -sin(phase));  // e^{-iwt}

  // h(k,t) — Hermitian complex height spectrum.
  let h = cmul(h0, ep) + cmul(h0MinusConj, em);

  // Horizontal displacement spectra: -i * k_/|k| * h.
  var kxN = 0.0;
  var kzN = 0.0;
  if (kLen > 1e-6) {
    kxN = k.x / kLen;
    kzN = k.y / kLen;
  }
  let dx = cmul(vec2<f32>(0.0, -kxN), h);
  let dz = cmul(vec2<f32>(0.0, -kzN), h);

  // Pack Dy + i*Dx into one complex field (both IFFT to real).
  let g1 = h + cmul(vec2<f32>(0.0, 1.0), dx);

  textureStore(OutputDyDx, vec2<i32>(id.xy), vec4<f32>(g1, 0.0, 0.0));
  textureStore(OutputDz, vec2<i32>(id.xy), vec4<f32>(dz, 0.0, 0.0));
}
