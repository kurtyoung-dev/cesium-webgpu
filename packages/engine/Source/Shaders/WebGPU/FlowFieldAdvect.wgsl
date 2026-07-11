// FlowFieldAdvect.wgsl — GPU flow-field particle advection compute pass
// (Campaign 6, C6-FLOWFIELD-WIND). Ping-pong integrator: reads the previous
// particle state, samples a velocity field supplied as an RGBA8 texture
// (R = u/east, G = v/north, normalized against the sidecar min/max), advances
// each particle's geographic position, ages it, and reseeds spawned/expired
// particles with a deterministic hash so density stays uniform.
//
// Technique reference: mapbox/webgl-wind (ISC) fragment ping-pong, ported to
// a WGSL compute kernel; Cesium GPU-wind blog (RaymanNg/3D-Wind-Field, MIT)
// for the globe lon/lat integration. Velocity SAMPLE data (not code) is NOAA
// GFS, US-Government public domain.
//
// Particle state layout (one vec4<f32> per particle, 16 bytes):
//   .x = longitude  (radians, wrapped to [0, 2*PI))
//   .y = latitude   (radians, clamped to [-PI/2, PI/2])
//   .z = age        (seconds since last spawn)
//   .w = speed01    (|velocity| normalized to [0,1] for color ramping)
//
// No RTE math here — geographic state is precision-safe as f32 radians; the
// render pass converts lon/lat → RTE-split ellipsoid position.

const PI: f32 = 3.14159265358979323846;
const TWO_PI: f32 = 6.28318530717958647692;
const HALF_PI: f32 = 1.57079632679489661923;

struct Params {
  // Velocity decode range (m/s) from the sidecar.
  velMin: vec2<f32>,   // (uMin, vMin)
  velMax: vec2<f32>,   // (uMax, vMax)
  // speedScale (radians of longitude advanced per (m/s) per frame at the
  // equator), lifetime (frames before forced respawn), dropRate (per-frame
  // reseed probability in [0,1)), unused.
  dynamics: vec4<f32>,
  // count, frameNumber, unused, unused.
  counters: vec4<u32>,
  speedRef: vec4<f32>, // (maxSpeed for color norm, 0, 0, 0)
};

@group(0) @binding(0) var<storage, read> particlesIn: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> particlesOut: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var velocityTex: texture_2d<f32>;
@group(0) @binding(4) var velocitySampler: sampler;

// Cheap integer hash → f32 in [0,1). PCG-style; deterministic per (id, salt)
// so probe captures are reproducible for a fixed frame number.
fn hash11(v: u32) -> f32 {
  var state = v * 747796405u + 2891336453u;
  var word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word) / 4294967295.0;
}

fn rand2(id: u32, salt: u32) -> vec2<f32> {
  return vec2<f32>(hash11(id * 2u + salt * 9781u), hash11(id * 2u + 1u + salt * 6151u));
}

// Reseed a particle to a fresh area-uniform geographic position so density
// does not clump at the poles (lat = asin(2r-1)).
fn spawn(id: u32, salt: u32) -> vec4<f32> {
  let r = rand2(id, salt);
  let lon = r.x * TWO_PI;
  let lat = asin(clamp(r.y * 2.0 - 1.0, -1.0, 1.0));
  return vec4<f32>(lon, lat, 0.0, 0.0);
}

// lon/lat (radians) → equirect velocity-texture UV. Row 0 = north pole
// (v = 0), lon 0 at u = 0. Wrap addressing in U handles the antimeridian;
// V is clamped by the sampler.
fn lonLatToUV(lon: f32, lat: f32) -> vec2<f32> {
  let u = fract(lon / TWO_PI);
  let vv = (HALF_PI - lat) / PI;
  return vec2<f32>(u, vv);
}

@compute @workgroup_size(64)
fn advectMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  let count = params.counters.x;
  if (id >= count) {
    return;
  }

  let frame = params.counters.y;
  let speedScale = params.dynamics.x;
  let lifetime = params.dynamics.y;
  let dropRate = params.dynamics.z;
  let maxSpeed = max(params.speedRef.x, 1.0e-3);

  var state = particlesIn[id];
  var lon = state.x;
  var lat = state.y;
  var age = state.z;

  // Sample the velocity field with bilinear filtering (level 0).
  let uv = lonLatToUV(lon, lat);
  let texel = textureSampleLevel(velocityTex, velocitySampler, uv, 0.0);
  let u = mix(params.velMin.x, params.velMax.x, texel.r); // m/s east
  let v = mix(params.velMin.y, params.velMax.y, texel.g); // m/s north
  let speed = sqrt(u * u + v * v);

  // Integrate geographic position (frame-stepped). Meridian convergence: a
  // given eastward speed spans more longitude near the poles (÷ cos lat),
  // clamped so the step stays finite as |lat| → 90°.
  let cosLat = max(cos(lat), 0.05);
  let dLon = (u * speedScale) / cosLat;
  let dLat = v * speedScale;
  lon = lon + dLon;
  lat = lat + dLat;
  age = age + 1.0;

  // Wrap longitude, clamp latitude away from the exact poles.
  lon = fract(lon / TWO_PI) * TWO_PI;
  lat = clamp(lat, -HALF_PI + 0.01, HALF_PI - 0.01);

  // Reseed on expiry, near-zero velocity (stagnation), or random drop — the
  // mapbox drop-rate trick that keeps the field from collapsing into
  // attractors. Age offset staggers respawns so the whole field never
  // flashes at once.
  let dropSample = hash11(id + frame * 2654435761u);
  let expired = age > lifetime;
  let stagnant = speed < 0.05;
  let dropped = dropSample < dropRate;
  if (expired || stagnant || dropped) {
    var fresh = spawn(id, frame + 1u);
    // Stagger initial ages so respawns spread across the lifetime.
    fresh.z = hash11(id * 3u + frame) * lifetime;
    fresh.w = 0.0;
    particlesOut[id] = fresh;
    return;
  }

  particlesOut[id] = vec4<f32>(lon, lat, age, clamp(speed / maxSpeed, 0.0, 1.0));
}
