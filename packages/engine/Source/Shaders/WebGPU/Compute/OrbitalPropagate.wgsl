// OrbitalPropagate.wgsl — GPU orbital catalog propagation (circular-orbit MVP)
//
// Phase 3 of the Large Dynamic Objects roadmap (NEW-ORBITAL-GPU-RESIDENT-
// RENDERER / NEW-ORBITAL-J2-KERNEL precursor). Propagates N catalog objects
// per frame entirely on the GPU: the element catalog is uploaded ONCE to a
// read-only storage buffer, this kernel evaluates each object's closed-form
// circular orbit at the current simulation time, and writes the resulting
// position into an output storage buffer that the instanced render pass
// (`OrbitalCatalogRender.wgsl`) vertex-pulls by `instance_index`. Positions
// never round-trip through the CPU — the per-frame upload is ONE scalar
// (timeSeconds).
//
// MVP scope (deliberate — see LARGE_DYNAMIC_OBJECTS_DESIGN.md §5):
//   - CIRCULAR orbits only: angle = phase + meanMotion * (t - epochOffset),
//     radius = semiMajorAxis. No eccentricity, no Kepler solver.
//   - Frame: in-plane position rotated by inclination (about +X) then RAAN
//     (about +Z) gives an ECI-style position that we treat as ECEF directly
//     (Earth rotation / GMST is skipped). Follow-up: apply Earth rotation
//     angle so RAAN is a true inertial node (NEW-ORBITAL-J2-KERNEL).
//   - Secular J2 / SGP4 are tracked follow-ups (NEW-ORBITAL-J2-KERNEL,
//     NEW-ORBITAL-SGP4-KERNEL). Do not grow this kernel ad hoc.
//
// RTE precision contract — output is EncodedCartesian3-style high/low:
//   high = the f32-rounded position, low = the residual. All math here is
//   f32, so `low` is currently always zero — the layout exists so the
//   render shader's RTE camera-subtract path and any future df64 (two-float)
//   kernel upgrade need no buffer or shader changes. f32-only error budget:
//   ~2.5 m absolute at GEO radius (4.2e7 * 2^-24) and an angle drift of
//   ~6e-8 * |meanMotion * t| radians — invisible for catalog-scale point
//   rendering, NOT acceptable for conjunction analysis. The df64 angle +
//   trig upgrade is part of NEW-ORBITAL-J2-KERNEL.
//
// Element layout (32 bytes, matches WebGPUOrbitalCatalogRenderer packing):
//   semiMajorAxis_m, inclination_rad, raan_rad, phase_rad,
//   meanMotion_rad_per_s, epochOffset_s, packedColor (RGBA8 u32), pixelSize
//
// Dispatch: one invocation per object, workgroup size 64
// (ceil(objectCount / 64) workgroups).

struct OrbitalElement {
  semiMajorAxis: f32,   // meters
  inclination: f32,     // radians
  raan: f32,            // radians (right ascension of ascending node)
  phase: f32,           // radians (argument of latitude at epoch)
  meanMotion: f32,      // radians / second
  epochOffset: f32,     // seconds (per-object epoch offset from catalog epoch)
  packedColor: u32,     // RGBA8 (r in the low byte, matches unpack4x8unorm)
  pixelSize: f32,       // point sprite diameter in pixels
};

// EncodedCartesian3-style high/low split. vec3 fields align to 16 bytes,
// so the struct is 32 bytes with implicit padding after each vec3.
struct PositionHL {
  high: vec3<f32>,
  low: vec3<f32>,
};

struct PropagateParams {
  timeSeconds: f32,     // simulation time relative to the catalog epoch
  objectCount: u32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<storage, read> elements: array<OrbitalElement>;
@group(0) @binding(1) var<storage, read_write> positions: array<PositionHL>;
@group(0) @binding(2) var<uniform> params: PropagateParams;

@compute @workgroup_size(64)
fn propagate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.objectCount) {
    return;
  }

  let e = elements[i];

  // Circular orbit: uniform angular motion in the orbital plane.
  let t = params.timeSeconds - e.epochOffset;
  let angle = e.phase + e.meanMotion * t;

  let r = e.semiMajorAxis;
  let xp = r * cos(angle);
  let yp = r * sin(angle);

  // Rotate the in-plane position (xp, yp, 0) by inclination about +X,
  // then by RAAN about +Z:  r_out = Rz(raan) * Rx(inc) * r_plane.
  // With Cesium's ECEF convention (+Z = polar axis), inclination 0 keeps
  // the orbit in the equatorial plane.
  let ci = cos(e.inclination);
  let si = sin(e.inclination);
  let co = cos(e.raan);
  let so = sin(e.raan);

  let pos = vec3<f32>(
    xp * co - yp * ci * so,
    xp * so + yp * ci * co,
    yp * si,
  );

  // RTE high/low split — see the header note. f32 math means low = 0 for
  // now; the slot is the contract for the df64 kernel upgrade.
  positions[i].high = pos;
  positions[i].low = vec3<f32>(0.0, 0.0, 0.0);
}
