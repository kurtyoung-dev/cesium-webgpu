// OceanInitialSpectrum.wgsl — initial wave-height spectrum h0(k) for the FFT
// spectral ocean. Computed once, or when the spectrum parameters change, never
// per frame. Output rgba32float packs the complex h0(k) in .xy and the complex
// conjugate partner h0(-k) in .zw, so the per-frame time-evolution pass
// (OceanTimeSpectrum.wgsl) can build the Hermitian
// h(k,t) = h0(k)e^{iwt} + conj(h0(-k))e^{-iwt} from a single texel fetch.
//
// Gaussian noise (xr, xi per partner) is uploaded deterministically from the
// CPU by Box-Muller, so results are reproducible across contexts.
//
// Reference: Jerry Tessendorf, "Simulating Ocean Water" (SIGGRAPH course notes
// 1999-2004) — the Phillips spectrum, implemented from the published math with
// no code copied.

struct InitParams {
  size: u32,        // N
  _pad0: u32,
  patchLength: f32, // L (meters)
  gravity: f32,     // g
  windX: f32,       // wind direction (unit) * used for alignment
  windZ: f32,
  windSpeed: f32,   // U (m/s)
  amplitude: f32,   // A (Phillips constant)
  smallWave: f32,   // capillary cutoff length l (meters)
  dirDamp: f32,     // damping of waves moving against the wind [0,1]
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var Noise: texture_2d<f32>;     // rgba32float, 4 gaussians
@group(0) @binding(1) var H0: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: InitParams;

const PI: f32 = 3.14159265358979323846;

fn phillips(k: vec2<f32>) -> f32 {
  let kLen = length(k);
  if (kLen < 1e-6) {
    return 0.0;
  }
  let kLen2 = kLen * kLen;
  let kLen4 = kLen2 * kLen2;
  let L = params.windSpeed * params.windSpeed / params.gravity; // largest wave
  let kHat = k / kLen;
  let wHat = normalize(vec2<f32>(params.windX, params.windZ));
  var dirFactor = dot(kHat, wHat);
  dirFactor = dirFactor * dirFactor; // |k^.w^|^2
  // Damp waves travelling against the wind.
  if (dot(kHat, wHat) < 0.0) {
    dirFactor = dirFactor * params.dirDamp;
  }
  let l = params.smallWave;
  var p = params.amplitude * exp(-1.0 / (kLen2 * L * L)) / kLen4 * dirFactor;
  p = p * exp(-kLen2 * l * l); // suppress very short waves
  return p;
}

@compute @workgroup_size(8, 8, 1)
fn initialSpectrum(@builtin(global_invocation_id) id: vec3<u32>) {
  let N = params.size;
  if (id.x >= N || id.y >= N) {
    return;
  }
  let half = i32(N) / 2;
  // texel n -> frequency index m (negative freqs at n > N/2)
  let mx = i32(id.x) - half;
  let mz = i32(id.y) - half;
  let dk = 2.0 * PI / params.patchLength;
  let k = vec2<f32>(f32(mx) * dk, f32(mz) * dk);

  let noise = textureLoad(Noise, vec2<i32>(id.xy), 0);
  let invSqrt2 = 0.70710678118;

  // h0(k) from the first gaussian pair.
  let h0 = invSqrt2 * noise.xy * sqrt(phillips(k));
  // conj(h0(-k)): spectrum at -k, second gaussian pair, conjugated.
  let hm = invSqrt2 * noise.zw * sqrt(phillips(-k));
  let h0MinusConj = vec2<f32>(hm.x, -hm.y);

  textureStore(H0, vec2<i32>(id.xy),
    vec4<f32>(h0.x, h0.y, h0MinusConj.x, h0MinusConj.y));
}
