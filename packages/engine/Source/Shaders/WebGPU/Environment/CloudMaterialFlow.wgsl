//>>ifdef CLOUD_GEOGRAPHIC_WIND
struct CloudMaterialFlowNode {
  displacement: vec4<f32>,
  velocity: vec4<f32>,
}
struct CloudMaterialFlowField {
  grid: vec4<u32>,
  nodes: array<CloudMaterialFlowNode>,
}
@group(0) @binding(15) var<storage, read> cloudMaterialFlow: CloudMaterialFlowField;

const cloudMaterialWindEnabled: bool = true;
fn cloudMaterialFlowEnabled() -> bool { return cloudMaterialWindEnabled && cloudMaterialFlow.grid.z > 0u; }

fn cloudMaterialFlowRow(x: f32, row: i32, velocity: bool, level: u32) -> vec3<f32> {
  let width = i32(cloudMaterialFlow.grid.x);
  let height = i32(cloudMaterialFlow.grid.y);
  var xx = x;
  var yy = row;
  // Reflect across a pole, including the half-cell turn on odd-width grids.
  if (yy < 0) { yy = -yy - 1; xx += f32(width) * 0.5; }
  if (yy >= height) { yy = 2 * height - yy - 1; xx += f32(width) * 0.5; }
  let ix = i32(floor(xx));
  let left = ((ix % width) + width) % width;
  let offset = level * (cloudMaterialFlow.grid.z + 2u);
  let first = offset + u32(yy * width + left);
  let second = offset + u32(yy * width + (left + 1) % width);
  if (velocity) {
    return mix(cloudMaterialFlow.nodes[first].velocity.xyz, cloudMaterialFlow.nodes[second].velocity.xyz, fract(xx));
  }
  let a = cloudMaterialFlow.nodes[first].displacement.xyz;
  let b = cloudMaterialFlow.nodes[second].displacement.xyz;
  return mix(a, b, fract(xx));
}

fn cloudMaterialSampleLevel(direction: vec3<f32>, velocity: bool, level: u32) -> vec3<f32> {
  if (!cloudMaterialFlowEnabled()) { return vec3<f32>(0.0); }
  let pole = level * (cloudMaterialFlow.grid.z + 2u) + cloudMaterialFlow.grid.z;
  let lon = atan2(direction.y, direction.x);
  let lat = atan2(direction.z, length(direction.xy));
  let x = (lon + 3.141592653589793) / 6.283185307179586 * f32(cloudMaterialFlow.grid.x) - 0.5;
  let y = (0.5 - lat / 3.141592653589793) * f32(cloudMaterialFlow.grid.y) - 0.5;
  if (y < 0.0) {
    let value = select(cloudMaterialFlow.nodes[pole].displacement.xyz, cloudMaterialFlow.nodes[pole].velocity.xyz, velocity);
    return mix(value,
      cloudMaterialFlowRow(x, 0, velocity, level), clamp(2.0 * y + 1.0, 0.0, 1.0));
  }
  let last = f32(cloudMaterialFlow.grid.y - 1u);
  if (y > last) {
    let value = select(cloudMaterialFlow.nodes[pole + 1u].displacement.xyz, cloudMaterialFlow.nodes[pole + 1u].velocity.xyz, velocity);
    return mix(value,
      cloudMaterialFlowRow(x, i32(last), velocity, level), clamp(1.0 - 2.0 * (y - last), 0.0, 1.0));
  }
  let row = i32(floor(y));
  return mix(cloudMaterialFlowRow(x, row, velocity, level), cloudMaterialFlowRow(x, row + 1, velocity, level), fract(y));
}

fn cloudMaterialSampleAt(direction: vec3<f32>, velocity: bool, altitude: f32) -> vec3<f32> {
  if (!cloudMaterialWindEnabled) { return vec3<f32>(0.0); }
  var lower = 0u;
  var upper = 0u;
  var weight = 0.0;
  let layered = cloudMaterialFlow.grid.w >= 2u;
  if (layered) {
    let stride = cloudMaterialFlow.grid.z + 2u;
    upper = 1u;
    loop {
      if (upper >= cloudMaterialFlow.grid.w - 1u || altitude <= cloudMaterialFlow.nodes[upper * stride + cloudMaterialFlow.grid.z].displacement.w) { break; }
      upper += 1u;
    }
    lower = upper - 1u;
    let a = cloudMaterialFlow.nodes[lower * stride + cloudMaterialFlow.grid.z].displacement.w;
    let b = cloudMaterialFlow.nodes[upper * stride + cloudMaterialFlow.grid.z].displacement.w;
    weight = clamp((altitude - a) / (b - a), 0.0, 1.0);
  }
  var first = vec3<f32>(0.0);
  var second = vec3<f32>(0.0);
  // A uniform loop shares the geographic lookup between the bracketing levels.
  let count = select(1u, 2u, layered);
  for (var i = 0u; i < count; i++) {
    let value = cloudMaterialSampleLevel(direction, velocity, select(lower, upper, i > 0u));
    if (i == 0u) { first = value; } else { second = value; }
  }
  if (!layered) { return first; }
  return mix(first, second, weight);
}

fn cloudMaterialSample(direction: vec3<f32>, velocity: bool) -> vec3<f32> {
  return cloudMaterialSampleAt(direction, velocity, 0.0);
}

fn cloudMaterialAltitude(direction: vec3<f32>) -> f32 {
  // Direction retains distance in units of the mean Earth radius. A radial
  // height above WGS84 is sufficient for kilometre-spaced wind levels; using
  // a spherical height here would misclassify the polar cloud layers.
  let scaled = direction * vec3<f32>(6371008.8 / 6378137.0, 6371008.8 / 6378137.0, 6371008.8 / 6356752.314245);
  return max(0.0, 6371008.8 * length(direction) * (1.0 - 1.0 / max(length(scaled), 0.000001)));
}

fn cloudMaterialSine(angle: f32) -> f32 {
  // The snapshot horizon bounds angles to about one radian. This expansion
  // preserves subframe motion when native trigonometry loses tiny arguments.
  let squared = angle * angle;
  return angle * (1.0 + squared * (-1.0 / 6.0 + squared * (1.0 / 120.0 +
    squared * (-1.0 / 5040.0 + squared * (1.0 / 362880.0 - squared / 39916800.0)))));
}

fn cloudMaterialBacktraceOffsetAt(direction: vec3<f32>, age: f32, altitude: f32) -> vec3<f32> {
  if (!cloudMaterialFlowEnabled() || age == 0.0) { return vec3<f32>(0.0); }
  let p = normalize(direction);
  let wind = cloudMaterialSampleAt(p, true, altitude);
  return cloudMaterialBacktraceFromVelocity(p, wind, age);
}

fn cloudMaterialBacktraceFromVelocity(p: vec3<f32>, wind: vec3<f32>, age: f32) -> vec3<f32> {
  let tangent = wind - p * dot(wind, p);
  let speed = length(tangent);
  let angle = speed * age / 6371008.8;
  // This chord form retains sub-metre displacements without subtracting two
  // nearly equal planet-scale positions.
  let halfSine = cloudMaterialSine(angle * 0.5);
  return -6371008.8 * (2.0 * halfSine * halfSine * p + cloudMaterialSine(angle) * tangent / max(speed, 0.000001));
}

fn cloudMaterialOffsetAt(direction: vec3<f32>, age: f32, altitude: f32) -> vec3<f32> {
  if (!cloudMaterialFlowEnabled()) { return vec3<f32>(0.0); }
  var p = direction;
  var sampleDirection = direction;
  var step = vec3<f32>(0.0);
  if (age != 0.0) {
    p = normalize(direction);
    sampleDirection = normalize(p);
  }
  // Velocity and displacement use different coordinates but share the same
  // geographic interpolation code. Keep one lookup site for both phases.
  for (var phase = 0u; phase < 2u; phase++) {
    if (phase == 0u && age == 0.0) { continue; }
    let value = cloudMaterialSampleAt(sampleDirection, phase == 0u, altitude);
    if (phase == 0u) {
      step = cloudMaterialBacktraceFromVelocity(sampleDirection, value, age);
      sampleDirection = p + step / 6371008.8;
    } else {
      return step + value;
    }
  }
  return step;
}

fn cloudMaterialOffset(direction: vec3<f32>, age: f32) -> vec3<f32> {
  return cloudMaterialOffsetAt(direction, age, 0.0);
}

fn cloudMaterialDirection(relative: vec3<f32>, high: vec3<f32>, low: vec3<f32>) -> vec3<f32> {
  return high / 6371008.8 + (low / 6371008.8 + relative / 6371008.8);
}

fn cloudMaterialNoiseOffset(worldPosition: vec3<f32>) -> vec3<f32> {
  if (cloud.materialFlowEnabled < 0.5) { return vec3<f32>(0.0); }
  let direction = worldPosition / 6371008.8;
  let altitude = select(0.0, cloudMaterialAltitude(direction), cloudMaterialFlow.grid.w > 1u);
  return cloudMaterialOffsetAt(direction, cloud.materialFlowAge, altitude) * CLOUD_DENSITY_WORLD_TO_NOISE;
}
//>>else
//>>endif
