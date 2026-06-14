// ComputeInstanceScaffold.wgsl — engine scaffolding for user-supplied
// compute-instance kernels (NEW-COMPUTE-INSTANCE-SYSTEM, Batch 231;
// df64 precision helpers added Batch 277, NEW-ORBITAL-J2-KERNEL).
//
// This file is deliberately NOT a complete WGSL module.
// `WebGPUComputeInstanceRenderer` composes the final compute module as
//
//     <generated prologue: const FLOATS_PER_INSTANCE = Nu;>
//   + <this file>
//   + <user kernel snippet defining csm_computeInstance>
//
// WGSL module-scope declarations are order-independent, so the entry point
// below can call `csm_computeInstance` before its definition appears in the
// composed source. Composed modules are cached per kernel source (NOT under
// a ShaderSourceId — user strings can't key the sourceId/defines cache).
//
// User-kernel contract (the full contract is documented on
// `ComputeInstanceCollection`):
//
//   fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut
//
//   - `params: array<f32>` — the raw per-instance float lanes uploaded by
//     the collection (re-uploaded only when the catalog is dirty). The lane
//     layout is entirely the USER's business; index it as
//     `params[index * FLOATS_PER_INSTANCE + lane]`.
//   - `FLOATS_PER_INSTANCE: u32` — injected by the engine prologue from the
//     collection's `floatsPerInstance`.
//   - The ENGINE owns the bindings, the dispatch entry point, the bounds
//     check, and the RTE high/low split + output write — user kernels never
//     declare bindings and never touch RTE.
//   - All `csm_`-prefixed identifiers are engine-reserved; user kernels must
//     not redeclare `ComputeInstanceOut`, `params`, or anything `csm_*`.
//
// ── RTE precision: f32 (default) vs df64 (opt-in) ───────────────────────
//
// The output position is stored RTE-split as `positionHigh` + `positionLow`
// (the render shader subtracts the encoded camera on the GPU —
// translateRelativeToEye). A kernel has two ways to fill that:
//
//   (1) f32 (default, back-compatible): set only `out.position` (vec3<f32>).
//       The entry point writes `positionHigh = out.position`, and because
//       `var out: ComputeInstanceOut;` zero-inits, `out.positionLow` stays
//       (0,0,0). This is the original Batch-231 contract — an f32 absolute
//       ECEF position with an always-zero low part (~meter error at
//       planetary radii). Existing kernels need no changes.
//
//   (2) df64 (opt-in, Batch 277): when the kernel does its math in df64
//       (two-float / double-single — see helpers below), it can split each
//       df64 position component into an exact f32 high + f32 low and set
//       BOTH `out.position` (the highs) and `out.positionLow` (the lows).
//       `csm_emitDF64(x, y, z)` packs three df64 components into a fully
//       populated `ComputeInstanceOut` (color/pixelSize still the kernel's
//       to fill). This makes the RTE low part meaningful, removing the
//       "low is always 0" limitation for kernels that opt in — e.g. large
//       `time * meanMotion` angle arguments that lose f32 precision over a
//       long propagation interval.
//
// The buffer layout, render shader, and entry point are IDENTICAL for both
// paths — df64 just fills a slot that f32 leaves zero. No pipeline changes.
//
// ── df64 (two-float / double-single) arithmetic ─────────────────────────
//
// A df64 value is a `vec2<f32>` (hi, lo) representing hi + lo with the
// invariant |lo| <= 0.5 * ulp(hi); it carries ~46 effective mantissa bits
// (vs f32's 24). All helpers are error-free-transformation based
// (Dekker/Knuth two-sum + Dekker two-product); they need no f64 hardware
// and run on any WebGPU device. Reserved-name helpers (engine-owned):
//
//   csm_df64(x)            — promote an f32 to df64 (lo = 0)
//   csm_df64_add(a, b)     — df64 + df64  (two-sum, ~46-bit)
//   csm_df64_add_f32(a, x) — df64 + f32
//   csm_df64_mul(a, b)     — df64 * df64  (Dekker two-product)
//   csm_df64_mul_f32(a, x) — df64 * f32
//   csm_df64_sin(a)        — sin of a df64 angle (df64 range-reduced)
//   csm_df64_cos(a)        — cos of a df64 angle
//   csm_df64_split(a)      — exact f32 hi/lo of a df64 value -> vec2<f32>
//                            (hi = round-to-f32(a), lo = a - hi in f32),
//                            i.e. the RTE high/low of one scalar component.
//
// Contract for kernel authors: accumulate the precision-sensitive angle
// (e.g. mean anomaly M = M0 + n*t for large t) in df64 via csm_df64_mul +
// csm_df64_add, reduce/evaluate with csm_df64_sin/cos, build the position
// component-wise in df64, and emit via csm_emitDF64. Everything that fits
// comfortably in f32 (small inclination/RAAN rotations, color, pixelSize)
// can stay f32 — df64 is opt-in per quantity, not all-or-nothing.

// Returned by the user kernel. `position` is absolute ECEF meters (the RTE
// HIGH part); `positionLow` is the RTE low part (0 for f32 kernels, the
// df64 low for df64 kernels — see the RTE note above). `color` is straight
// (non-premultiplied) RGBA in [0,1]; `pixelSize` is the dot diameter in px.
struct ComputeInstanceOut {
  position: vec3<f32>,
  positionLow: vec3<f32>,
  color: vec4<f32>,
  pixelSize: f32,
};

// ── df64 primitives (Dekker/Knuth error-free transformations) ──

// Promote f32 -> df64.
fn csm_df64(x: f32) -> vec2<f32> {
  return vec2<f32>(x, 0.0);
}

// Knuth two-sum: returns (s, e) with s = round(a+b), e = exact error, so
// a + b == s + e. Branch-free, no ordering assumption on |a| vs |b|.
fn csm_twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  let err = (a - (s - bb)) + (b - bb);
  return vec2<f32>(s, err);
}

// Dekker split of an f32 into two 12-bit halves for the two-product. The
// magic constant is 2^12 + 1 (f32 mantissa is 24 bits -> split at 12).
fn csm_split(a: f32) -> vec2<f32> {
  let c = 4097.0 * a; // (2^12 + 1) * a
  let hi = c - (c - a);
  let lo = a - hi;
  return vec2<f32>(hi, lo);
}

// Dekker two-product: returns (p, e) with p = round(a*b), e = exact error,
// so a * b == p + e.
fn csm_twoProd(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let sa = csm_split(a);
  let sb = csm_split(b);
  let err =
    ((sa.x * sb.x - p) + sa.x * sb.y + sa.y * sb.x) + sa.y * sb.y;
  return vec2<f32>(p, err);
}

// df64 + df64 (Knuth two-sum + secondary correction; ~46-bit result).
fn csm_df64_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = csm_twoSum(a.x, b.x);
  let t = csm_twoSum(a.y, b.y);
  let lo1 = s.y + t.x;
  let v = csm_twoSum(s.x, lo1);
  let lo2 = t.y + v.y;
  return csm_twoSum(v.x, lo2);
}

// df64 + f32.
fn csm_df64_add_f32(a: vec2<f32>, x: f32) -> vec2<f32> {
  let s = csm_twoSum(a.x, x);
  let lo = s.y + a.y;
  return csm_twoSum(s.x, lo);
}

// df64 * df64 (Dekker two-product for the high*high term + cross terms).
fn csm_df64_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = csm_twoProd(a.x, b.x);
  let lo = p.y + (a.x * b.y + a.y * b.x);
  return csm_twoSum(p.x, lo);
}

// df64 * f32.
fn csm_df64_mul_f32(a: vec2<f32>, x: f32) -> vec2<f32> {
  let p = csm_twoProd(a.x, x);
  let lo = p.y + a.y * x;
  return csm_twoSum(p.x, lo);
}

// Reduce a df64 angle to [-pi, pi] in df64 (Cody-Waite style: subtract
// k * 2pi as a df64 so the large multiples of 2pi cancel in extended
// precision, not f32). 2pi as df64 = (TWO_PI_HI, TWO_PI_LO).
fn csm_df64_reducePi(a: vec2<f32>) -> vec2<f32> {
  let TWO_PI_HI = 6.2831855;       // round-to-f32(2*pi)
  let TWO_PI_LO = -1.7484555e-7;   // 2*pi - TWO_PI_HI
  let INV_TWO_PI = 0.15915494;     // 1 / (2*pi)
  // k = nearest integer number of full turns.
  let k = round((a.x + a.y) * INV_TWO_PI);
  // a - k*(2pi) in df64.
  var r = csm_df64_add(a, csm_df64_mul_f32(vec2<f32>(TWO_PI_HI, TWO_PI_LO), -k));
  // r is now in roughly [-pi, pi]; nudge the rare boundary case.
  if (r.x > 3.14159265) {
    r = csm_df64_add(r, csm_df64_mul_f32(vec2<f32>(TWO_PI_HI, TWO_PI_LO), -1.0));
  } else if (r.x < -3.14159265) {
    r = csm_df64_add(r, vec2<f32>(TWO_PI_HI, TWO_PI_LO));
  }
  return r;
}

// sin/cos of a df64 angle. After df64 range reduction the reduced angle's
// HIGH part is in [-pi, pi] and accurate to ~46 bits, so an f32 sin/cos of
// (hi + lo) folded with the derivative correction recovers ~f32-of-a-tiny-
// angle accuracy: sin(hi+lo) ~= sin(hi) + lo*cos(hi); cos(hi+lo) ~=
// cos(hi) - lo*sin(hi). lo is tiny (< 1 ulp of hi) so the first-order term
// is more than enough — the win is that `hi` no longer carries the f32
// rounding of a huge pre-reduction argument.
fn csm_df64_sin(a: vec2<f32>) -> f32 {
  let r = csm_df64_reducePi(a);
  let s = sin(r.x);
  let c = cos(r.x);
  return s + r.y * c;
}

fn csm_df64_cos(a: vec2<f32>) -> f32 {
  let r = csm_df64_reducePi(a);
  let s = sin(r.x);
  let c = cos(r.x);
  return c - r.y * s;
}

// Exact f32 high/low split of a df64 value: hi = round-to-f32(value),
// lo = (value - hi) in f32. This is the per-component RTE encode — feed a
// df64 position component, get back the (positionHigh, positionLow) pair.
fn csm_df64_split(a: vec2<f32>) -> vec2<f32> {
  let hi = a.x;          // a.x already holds the f32-rounded value
  let lo = a.y;          // a.y is the residual in f32
  return vec2<f32>(hi, lo);
}

// Pack three df64 position components into a ComputeInstanceOut with BOTH
// the RTE high and low filled (color/pixelSize remain the kernel's to set).
// This is the df64 emit helper referenced in the RTE note above.
fn csm_emitDF64(x: vec2<f32>, y: vec2<f32>, z: vec2<f32>) -> ComputeInstanceOut {
  var out: ComputeInstanceOut;
  out.position = vec3<f32>(x.x, y.x, z.x);
  out.positionLow = vec3<f32>(x.y, y.y, z.y);
  out.color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
  out.pixelSize = 1.0;
  return out;
}

// GPU-resident per-instance record written by the entry point below and
// vertex-pulled by `ComputeInstanceRender.wgsl` — the two structs MUST stay
// in sync (64 bytes: vec3+pad, vec3+pad, vec4, f32+12 pad).
struct CsmInstanceRecord {
  positionHigh: vec3<f32>,
  positionLow: vec3<f32>,
  color: vec4<f32>,
  pixelSize: f32,
};

struct CsmFrameParams {
  timeSeconds: f32,     // simulation time relative to the collection epoch
  instanceCount: u32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<storage, read> params: array<f32>;
@group(0) @binding(1) var<storage, read_write> csm_instances: array<CsmInstanceRecord>;
@group(0) @binding(2) var<uniform> csm_frame: CsmFrameParams;

// Dispatch: one invocation per instance, workgroup size 64
// (ceil(instanceCount / 64) workgroups).
@compute @workgroup_size(64)
fn computeInstanceMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= csm_frame.instanceCount) {
    return;
  }

  let result = csm_computeInstance(i, csm_frame.timeSeconds);

  // RTE high/low split — engine-owned. f32 kernels leave `positionLow`
  // zero-initialized (the original contract); df64 kernels fill it via
  // csm_emitDF64 so the low part is meaningful (Batch 277).
  csm_instances[i].positionHigh = result.position;
  csm_instances[i].positionLow = result.positionLow;
  csm_instances[i].color = result.color;
  csm_instances[i].pixelSize = result.pixelSize;
}
