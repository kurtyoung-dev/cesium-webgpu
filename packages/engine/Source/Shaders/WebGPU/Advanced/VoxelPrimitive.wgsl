// Voxel Primitive shader for WebGPU
// Renders volumetric voxel data via ray marching through an octree/megatexture.
// Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldRayOrigin: vec3<f32>,
  @location(1) worldRayDir: vec3<f32>,
  @location(2) localPos: vec3<f32>,
};

struct VoxelUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  inverseModelView: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  voxelDimensions: vec3<f32>,
  stepSize: f32,
  minBounds: vec3<f32>,
  maxSteps: f32,
  maxBounds: vec3<f32>,
  densityThreshold: f32,
  cameraPositionEC: vec3<f32>,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> uniforms: VoxelUniforms;
@group(0) @binding(1) var voxelTexture: texture_3d<f32>;
@group(0) @binding(2) var voxelSampler: sampler;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // RTE positioning
  let posRTE = (input.positionHigh - uniforms.encodedCameraHigh) +
               (input.positionLow - uniforms.encodedCameraLow);

  output.position = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);

  // Compute ray origin and direction in local voxel space
  let eyePos = uniforms.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.worldRayOrigin = uniforms.cameraPositionEC;
  output.worldRayDir = normalize(eyePos.xyz - uniforms.cameraPositionEC);
  output.localPos = posRTE;

  return output;
}

// Intersect ray with AABB, returns (tNear, tFar)
fn intersectAABB(origin: vec3<f32>, invDir: vec3<f32>,
                 boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec2<f32> {
  let t1 = (boxMin - origin) * invDir;
  let t2 = (boxMax - origin) * invDir;
  let tMin = min(t1, t2);
  let tMax = max(t1, t2);
  let tNear = max(max(tMin.x, tMin.y), tMin.z);
  let tFar = min(min(tMax.x, tMax.y), tMax.z);
  return vec2<f32>(tNear, tFar);
}

// Convert world position to voxel UVW coordinates [0,1]
fn worldToVoxelUVW(worldPos: vec3<f32>) -> vec3<f32> {
  return (worldPos - uniforms.minBounds) / (uniforms.maxBounds - uniforms.minBounds);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let rayOrigin = input.worldRayOrigin;
  let rayDir = normalize(input.worldRayDir);
  let invDir = 1.0 / rayDir;

  // Intersect ray with voxel bounds
  let tRange = intersectAABB(rayOrigin, invDir, uniforms.minBounds, uniforms.maxBounds);

  if (tRange.x > tRange.y) {
    discard;
  }

  let tStart = max(tRange.x, 0.0);
  let tEnd = tRange.y;
  let step = uniforms.stepSize;
  let maxIter = i32(uniforms.maxSteps);

  // Ray march through voxel volume
  var accumColor = vec3<f32>(0.0);
  var accumAlpha: f32 = 0.0;

  for (var i = 0; i < maxIter; i = i + 1) {
    let t = tStart + f32(i) * step;
    if (t > tEnd || accumAlpha > 0.99) {
      break;
    }

    let samplePos = rayOrigin + rayDir * t;
    let uvw = worldToVoxelUVW(samplePos);

    // Skip if outside [0,1] range
    if (any(uvw < vec3<f32>(0.0)) || any(uvw > vec3<f32>(1.0))) {
      continue;
    }

    let voxelSample = textureSample(voxelTexture, voxelSampler, uvw);
    let density = voxelSample.a;

    if (density > uniforms.densityThreshold) {
      let sampleColor = voxelSample.rgb;
      let sampleAlpha = density * step;

      // Front-to-back compositing
      accumColor = accumColor + sampleColor * sampleAlpha * (1.0 - accumAlpha);
      accumAlpha = accumAlpha + sampleAlpha * (1.0 - accumAlpha);
    }
  }

  if (accumAlpha < 0.01) {
    discard;
  }

  return vec4<f32>(accumColor, accumAlpha);
}
