// Cloud noise bake — WebGPU compute (Campaign 3 v2, V2)
//
// Bakes the two 3D noise textures the volumetric-cloud raymarcher samples (V3+):
//   • bakeShape  → 128³ RGBA8 low-frequency "shape" texture:
//        R = Perlin-Worley billow (the connected, billowy base)
//        G/B/A = inverted Worley at increasing frequency (the GBA Worley fBm
//                that V3 combines to remap R — the Nubis erosion fBm)
//   • bakeDetail → 32³ RGBA8 high-frequency "detail/erosion" texture:
//        R/G/B = inverted Worley at increasing frequency
//
// ALL noise is PERIODIC (tileable): every lattice index is wrapped `mod freq`
// (positive modulo) before hashing, so the textures wrap seamlessly under the
// `repeat`-addressed sampler — no visible grid seam when the raymarcher tiles
// world space through them. Frequencies are integers so the wrap is exact.
//
// One module, two entry points, disjoint storage bindings (0 = shape, 1 =
// detail) so the single module can declare both write targets without a
// `@binding` collision (same idiom as VolumetricFog.wgsl). Each pipeline binds
// only the target its entry point writes.

@group(0) @binding(0) var shapeTex: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detailTex: texture_storage_3d<rgba8unorm, write>;

// Positive modulo for periodic lattice wrapping.
fn pmod3(a: vec3<f32>, m: f32) -> vec3<f32> {
  return a - floor(a / m) * m;
}

// Gradient hash → vec3 in [-1,1] for a (wrapped) integer lattice point.
fn gradHash(p: vec3<f32>) -> vec3<f32> {
  let q = vec3<f32>(
    dot(p, vec3<f32>(127.1, 311.7, 74.7)),
    dot(p, vec3<f32>(269.5, 183.3, 246.1)),
    dot(p, vec3<f32>(113.5, 271.9, 124.6)),
  );
  return -1.0 + 2.0 * fract(sin(q) * 43758.5453123);
}

// Feature-point hash → vec3 in [0,1] (offset within a Worley cell).
fn featHash(p: vec3<f32>) -> vec3<f32> {
  let q = vec3<f32>(
    dot(p, vec3<f32>(127.1, 311.7, 74.7)),
    dot(p, vec3<f32>(269.5, 183.3, 246.1)),
    dot(p, vec3<f32>(113.5, 271.9, 124.6)),
  );
  return fract(sin(q) * 43758.5453123);
}

fn fade3(t: vec3<f32>) -> vec3<f32> {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// Periodic Perlin (gradient) noise in ~[-1,1].
fn perlinPeriodic(P: vec3<f32>, freq: f32) -> f32 {
  let pp = P * freq;
  let pi = floor(pp);
  let pf = fract(pp);
  let u = fade3(pf);
  var total: f32 = 0.0;
  for (var c: i32 = 0; c < 8; c = c + 1) {
    let cx = f32(c & 1);
    let cy = f32((c >> 1) & 1);
    let cz = f32((c >> 2) & 1);
    let corner = vec3<f32>(cx, cy, cz);
    let g = gradHash(pmod3(pi + corner, freq));
    let d = pf - corner;
    let wx = mix(1.0 - u.x, u.x, cx);
    let wy = mix(1.0 - u.y, u.y, cy);
    let wz = mix(1.0 - u.z, u.z, cz);
    total = total + wx * wy * wz * dot(g, d);
  }
  return total;
}

// Periodic Worley F1 distance in [0,1] (low at feature points).
fn worleyPeriodic(P: vec3<f32>, freq: f32) -> f32 {
  let pp = P * freq;
  let pi = floor(pp);
  let pf = fract(pp);
  var minDist: f32 = 1.0;
  for (var i: i32 = 0; i < 27; i = i + 1) {
    let off = vec3<f32>(
      f32(i % 3 - 1),
      f32((i / 3) % 3 - 1),
      f32(i / 9 - 1),
    );
    let cell = pmod3(pi + off, freq);
    let feat = off + featHash(cell);
    let d = feat - pf;
    minDist = min(minDist, dot(d, d));
  }
  return sqrt(min(minDist, 1.0));
}

// Inverted Worley (HIGH at feature points) — the cloud "billow" primitive.
fn worleyInv(P: vec3<f32>, freq: f32) -> f32 {
  return 1.0 - worleyPeriodic(P, freq);
}

// 3-octave inverted-Worley fBm in [0,1].
fn worleyFBM(P: vec3<f32>, freq: f32) -> f32 {
  return worleyInv(P, freq) * 0.625
       + worleyInv(P, freq * 2.0) * 0.25
       + worleyInv(P, freq * 4.0) * 0.125;
}

// 3-octave Perlin fBm remapped to [0,1].
fn perlinFBM(P: vec3<f32>, freq: f32) -> f32 {
  var v: f32 = 0.0;
  var amp: f32 = 0.5;
  var f: f32 = freq;
  for (var i: i32 = 0; i < 3; i = i + 1) {
    v = v + amp * perlinPeriodic(P, f);
    f = f * 2.0;
    amp = amp * 0.5;
  }
  // amp sum 0.875; map [-0.875,0.875] → [0,1].
  return clamp(v / 1.75 + 0.5, 0.0, 1.0);
}

fn remap(v: f32, lo: f32, hi: f32, a: f32, b: f32) -> f32 {
  return a + (v - lo) * (b - a) / (hi - lo);
}

@compute @workgroup_size(4, 4, 4)
fn bakeShape(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(shapeTex);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims); // voxel center in [0,1)

  // R — Perlin-Worley billow (Schneider remap: erode the Perlin base by the
  // low-freq Worley fBm so the base reads connected-yet-billowy).
  let pfbm = perlinFBM(p, 4.0);
  let wfbmBase = worleyFBM(p, 4.0);
  let pw = clamp(remap(pfbm, wfbmBase - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);

  // G/B/A — inverted Worley at increasing frequency (the erosion fBm V3 combines).
  let g = worleyInv(p, 4.0);
  let b = worleyInv(p, 8.0);
  let a = worleyInv(p, 16.0);

  textureStore(shapeTex, vec3<i32>(gid), vec4<f32>(pw, g, b, a));
}

@compute @workgroup_size(4, 4, 4)
fn bakeDetail(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(detailTex);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims);

  // R/G/B — high-frequency inverted Worley at increasing frequency.
  let r = worleyInv(p, 4.0);
  let g = worleyInv(p, 8.0);
  let b = worleyInv(p, 16.0);

  textureStore(detailTex, vec3<i32>(gid), vec4<f32>(r, g, b, 1.0));
}
