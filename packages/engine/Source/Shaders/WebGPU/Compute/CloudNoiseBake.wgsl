// Cloud noise bake — WebGPU compute
//
// Bakes the two 3D noise textures the volumetric-cloud raymarcher samples:
//   • bakeShape  → 128³ RGBA8 low-frequency "shape" texture:
//        R = the connected, billowy base shape
//        G/B/A = inverted Worley at increasing frequency — the erosion fBm the
//                density evaluation combines to remap R
//   • bakeDetail → 32³ RGBA8 high-frequency "detail/erosion" texture:
//        R/G/B = inverted Worley at increasing frequency
//
// All noise is periodic, and therefore tileable: every lattice index is wrapped
// `mod freq` with a positive modulo before hashing, so the textures wrap
// seamlessly under the `repeat`-addressed sampler and the raymarcher can tile
// world space through them without a visible grid seam. Frequencies are integers
// so the wrap is exact.
//
// One module, several entry points, disjoint storage bindings — 0 for shape, 1
// for detail — so a single module can declare both write targets without a
// `@binding` collision, the same idiom VolumetricFog.wgsl uses. Each pipeline
// binds only the target its entry point writes.

// References:
//   - Andrew Schneider and Nathan Vos, "The Real-Time Volumetric Cloudscapes
//     of Horizon Zero Dawn" (SIGGRAPH 2015 Advances in Real-Time Rendering) —
//     the Perlin-Worley remap baked into the shape texture's red channel and
//     the Worley erosion octaves in the remaining channels.
//   - Andrew Schneider, "Real-Time Volumetric Cloudscapes", GPU Pro 7
//     (2016) — the same construction written up with the frequency ladder
//     these dispatches use.
//   - Steven Worley, "A Cellular Texture Basis Function" (SIGGRAPH 1996) —
//     the cellular noise itself.

@group(0) @binding(0) var shapeTex: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var detailTex: texture_storage_3d<rgba8unorm, write>;

// Positive modulo for periodic lattice wrapping.
fn pmod3(a: vec3<f32>, m: f32) -> vec3<f32> {
  return a - floor(a / m) * m;
}

// Gradient hash to a unit vec3 for a wrapped integer lattice point. Normalizing
// keeps the Perlin output range predictable, around ±0.7 per octave, which is
// what the [0,1] remap below is calibrated against.
fn gradHash(p: vec3<f32>) -> vec3<f32> {
  let q = vec3<f32>(
    dot(p, vec3<f32>(127.1, 311.7, 74.7)),
    dot(p, vec3<f32>(269.5, 183.3, 246.1)),
    dot(p, vec3<f32>(113.5, 271.9, 124.6)),
  );
  let g = -1.0 + 2.0 * fract(sin(q) * 43758.5453123);
  return g / max(length(g), 1e-3);
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

// Inverted Worley, high at feature points — the cloud "billow" primitive.
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
  // Normalized gradients → ~±0.6 over 3 octaves; map to [0,1].
  return clamp(v / 1.2 + 0.5, 0.0, 1.0);
}

// Signed 3-octave Perlin fBm in ~[-0.5, 0.5], with no [0,1] recentre. The
// Perlin-Worley remap needs a signed base so it stretches symmetrically around
// 0; remapping an already-recentred value double-lifts it, which floods the
// coverage gate into flat overcast.
fn perlinFBMSigned(P: vec3<f32>, freq: f32) -> f32 {
  var v: f32 = 0.0;
  var amp: f32 = 0.5;
  var f: f32 = freq;
  for (var i: i32 = 0; i < 3; i = i + 1) {
    v = v + amp * perlinPeriodic(P, f);
    f = f * 2.0;
    amp = amp * 0.5;
  }
  return clamp(v / 1.2, -0.5, 0.5);
}

fn remap(v: f32, lo: f32, hi: f32, a: f32, b: f32) -> f32 {
  return a + (v - lo) * (b - a) / (hi - lo);
}

// Periodic value-noise hash → [0,1] for a (wrapped) integer lattice point.
fn valueHashP(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453123);
}

// Periodic value noise in [0,1]: trilinear interpolation of corner hashes, with
// the lattice wrapped mod freq. Its distribution is broader and sharper than
// gradient Perlin's, which is what carves big puffs with clear gaps once the
// coverage gate is applied.
fn valueNoisePeriodic(P: vec3<f32>, freq: f32) -> f32 {
  let pp = P * freq;
  let pi = floor(pp);
  let pf = fract(pp);
  let u = pf * pf * (3.0 - 2.0 * pf);
  var total: f32 = 0.0;
  for (var c: i32 = 0; c < 8; c = c + 1) {
    let cx = f32(c & 1);
    let cy = f32((c >> 1) & 1);
    let cz = f32((c >> 2) & 1);
    let corner = vec3<f32>(cx, cy, cz);
    let h = valueHashP(pmod3(pi + corner, freq));
    let w = mix(1.0 - u.x, u.x, cx) * mix(1.0 - u.y, u.y, cy) * mix(1.0 - u.z, u.z, cz);
    total = total + w * h;
  }
  return total;
}

// 4-octave periodic value fBM in [0,1].
fn valueFBM(P: vec3<f32>, freq: f32) -> f32 {
  var v: f32 = 0.0;
  var amp: f32 = 0.5;
  var f: f32 = freq;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    v = v + amp * valueNoisePeriodic(P, f);
    f = f * 2.0;
    amp = amp * 0.5;
  }
  return v / 0.9375; // amp sum
}

@compute @workgroup_size(4, 4, 4)
fn bakeShape(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(shapeTex);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims); // voxel center in [0,1)

  // R — the cloud base shape: a periodic value-noise fBm, broad and sharp enough
  // that the coverage gate carves big distinct puffs with clear gaps, which
  // smooth gradient Perlin does not. Base frequency 2 gives ~1.7 km features and
  // skips the frequency-1 octave, which would tile too obviously. It is not
  // Worley-remapped, because a remap over-densifies the deck; the Worley only
  // erodes edges, through the detail texture. `bakeShapePW` below is the
  // Perlin-Worley alternative.
  let base = valueFBM(p, 2.0);

  // G/B/A — inverted Worley at increasing frequency: the erosion fBm.
  let g = worleyInv(p, 4.0);
  let b = worleyInv(p, 8.0);
  let a = worleyInv(p, 16.0);

  textureStore(shapeTex, vec3<i32>(gid), vec4<f32>(base, g, b, a));
}

// Perlin-Worley shape variant: a separate entry point writing a separate
// texture, allocated and dispatched by the renderer only when
// `noiseMorphology = 'perlin-worley'`, so the two variants coexist and the
// renderer binds whichever the flag selects. R is the Schneider/Nubis
// Perlin-Worley remap — the Perlin fBm base remapped by the low-band inverted
// Worley, `remap(perlin, worleyLow - 1, 1, 0, 1)` clamped to [0,1] — so
// connected billowy cores form where the Worley billow is high and cauliflower
// gaps form where it is low. That raises the structural connectivity of the base
// shape against the broad, sharp value fBm, whose puffs read as more isolated
// blobs. G/B/A keep the same erosion-fBm channels as the value bake so the
// downstream erosion path is identical.
@compute @workgroup_size(4, 4, 4)
fn bakeShapePW(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(shapeTex);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims);

  // Signed Perlin fBm base in ~[-0.5, 0.5], symmetric around 0 so the remap does
  // not double-lift and over-densify. Same frequency band as the value bake.
  let perlin = perlinFBMSigned(p, 2.0);
  // Low-band inverted-Worley billow in [0,1], high at feature points, which are
  // the cloud cores.
  let worleyLow = worleyFBM(p, 3.0);
  // The Perlin-Worley remap, `remap(perlin, worleyLow - 1, 1, 0, 1)`. Its low
  // edge, worleyLow - 1, lies in [-1,0]: where the Worley billow is high, at the
  // cores, the floor lifts and connected billowy cores form; where it is low the
  // floor drops and the Perlin valleys carve cauliflower gaps.
  let pw = clamp(remap(perlin, worleyLow - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  // Level-matched to the value-fBm base, whose mean is ~0.5, so one coverage gate
  // serves both and carves distinct connected cumulus rather than flat overcast
  // when too high or thin wisps when too low. The raw remap centres near 0.33;
  // the lift and scale put cores near 0.7 and valleys near 0.36, centring around
  // 0.48, while keeping the Perlin-Worley connectivity and cauliflower structure.
  let base = clamp(pw * 0.9 + 0.18, 0.0, 1.0);

  // G/B/A — the same erosion fBm channels as the value bake, so erosion matches.
  let g = worleyInv(p, 4.0);
  let b = worleyInv(p, 8.0);
  let a = worleyInv(p, 16.0);

  textureStore(shapeTex, vec3<i32>(gid), vec4<f32>(base, g, b, a));
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
