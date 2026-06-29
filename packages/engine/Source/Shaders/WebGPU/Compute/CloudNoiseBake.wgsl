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

// Gradient hash → UNIT vec3 for a (wrapped) integer lattice point. Normalizing
// keeps the Perlin output range predictable (~±0.7 per octave) so the [0,1]
// remap below is calibrated, not guessed.
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
  // Normalized gradients → ~±0.6 over 3 octaves; map to [0,1].
  return clamp(v / 1.2 + 0.5, 0.0, 1.0);
}

// Batch 439 (4.8) — SIGNED 3-octave Perlin fBm in ~[-0.5, 0.5] (no [0,1] recenter).
// The Nubis Perlin-Worley remap needs the SIGNED base so it stretches symmetrically
// around 0 rather than double-lifting an already-recentered value (which floods the
// coverage gate into flat overcast — the 379a over-densify failure).
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

// Periodic value noise in [0,1] (trilinear interp of corner hashes, lattice
// wrapped mod freq). Broader/sharper distribution than gradient Perlin — this is
// the live base type, the one that carves big puffs + clear gaps under coverage.
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

  // R — the cloud BASE shape: a periodic VALUE-noise fBM (the live base type —
  // broad/sharp enough that the coverage gate carves big distinct puffs + clear
  // gaps, which smooth gradient-Perlin could not). Base freq 2 → ~1.7 km features
  // (skips the freq-1 octave that would tile too obviously). NOT Worley-remapped
  // (that over-densifies — the 379a-revert lesson); Worley only ERODES edges via
  // the detail texture. V4 will refine the morphology toward Perlin-Worley.
  let base = valueFBM(p, 2.0);

  // G/B/A — inverted Worley at increasing frequency (erosion fBm, for V4 morphology).
  let g = worleyInv(p, 4.0);
  let b = worleyInv(p, 8.0);
  let a = worleyInv(p, 16.0);

  textureStore(shapeTex, vec3<i32>(gid), vec4<f32>(base, g, b, a));
}

// Batch 439 (4.8 CLOUD-PW-NOISE) — Perlin-Worley SHAPE variant. A SEPARATE entry
// point writing a SEPARATE texture (the renderer allocates + dispatches this only
// when `noiseMorphology = 'perlin-worley'`), so the default `bakeShape` output is
// never disturbed — the two variants coexist and the renderer binds whichever the
// flag selects. R is the true Schneider/Nubis Perlin-Worley REMAP: the Perlin fBm
// base remapped by the low-band inverted-Worley so connected, billowy cores form
// where the Worley billow is high and cauliflower gaps form where it is low —
// `remap(perlin, worleyLow - 1, 1, 0, 1)` clamped to [0,1]. This raises the
// structural connectivity of the base shape vs the broad/sharp value-FBM (whose
// puffs are more isolated blobs). G/B/A keep the same erosion-fBm channels as the
// value bake so the downstream erosion path is identical.
@compute @workgroup_size(4, 4, 4)
fn bakeShapePW(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(shapeTex);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) { return; }
  let p = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims);

  // SIGNED Perlin fBm base (~[-0.5,0.5]) — symmetric around 0 so the remap doesn't
  // double-lift (the over-densify failure). Same freq band as the value bake.
  let perlin = perlinFBMSigned(p, 2.0);
  // Low-band inverted-Worley billow ∈ [0,1] (high AT feature points = cloud cores).
  let worleyLow = worleyFBM(p, 3.0);
  // Schneider/Nubis Perlin-Worley remap: `remap(perlin, worleyLow-1, 1, 0, 1)`.
  // worleyLow-1 ∈ [-1,0] is the low edge — where the Worley billow is HIGH (cores)
  // the floor lifts so connected billowy cores form; where it is LOW the floor
  // drops so the Perlin valleys carve cauliflower gaps.
  let pw = clamp(remap(perlin, worleyLow - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  // LEVEL-MATCH to the value-FBM base (mean ~0.5) so the SAME coverage gate carves
  // distinct connected cumulus instead of either a flat overcast (too high) or thin
  // wisps (too low). The raw remap centers ~0.33; lift+scale to cores ~0.7 /
  // valleys ~0.36 (center ~0.48), matching the value bake's effective coverage
  // behaviour while keeping the PW connectivity/cauliflower structure.
  let base = clamp(pw * 0.9 + 0.18, 0.0, 1.0);

  // G/B/A — IDENTICAL erosion fBm channels to the value bake (so erosion matches).
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
