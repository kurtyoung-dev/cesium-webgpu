// OcclusionTest.wgsl — Compute shader for per-command occlusion testing
//
// Tests each command's bounding sphere against the Hi-Z pyramid to determine
// if it's fully occluded by previously-drawn geometry.
//
// Algorithm:
// 1. Project bounding sphere to screen-space rectangle
// 2. Compute the appropriate Hi-Z mip level based on projected size
// 3. Sample Hi-Z at the projected rectangle corners
// 4. If sphere's near Z > max Hi-Z sample → OCCLUDED
// 5. Otherwise → VISIBLE (conservative)
//
// Dispatched once per frame after Hi-Z build, ~0.1ms for 10K commands.
// Each thread tests one command.

struct OcclusionParams {
  viewProjectionMatrix: mat4x4<f32>,
  screenWidth: f32,
  screenHeight: f32,
  nearPlane: f32,
  farPlane: f32,
  hiZMipLevels: u32,
  commandCount: u32,
  _padding0: u32,
  _padding1: u32,
}

// Bounding sphere data in SOA layout (from SOABoundingSphereLayout)
struct BoundingSphereSOA {
  centerX: f32,
  centerY: f32,
  centerZ: f32,
  radius: f32,
}

@group(0) @binding(0) var<uniform> params: OcclusionParams;
@group(0) @binding(1) var hiZTexture: texture_2d<f32>;
@group(0) @binding(2) var hiZSampler: sampler;

// SOA bounding sphere arrays
@group(0) @binding(3) var<storage, read> sphereCenterX: array<f32>;
@group(0) @binding(4) var<storage, read> sphereCenterY: array<f32>;
@group(0) @binding(5) var<storage, read> sphereCenterZ: array<f32>;
@group(0) @binding(6) var<storage, read> sphereRadius: array<f32>;

// Visibility output: 0 = occluded, 1 = visible
@group(0) @binding(7) var<storage, read_write> visibility: array<u32>;

// Projects a point from world space to NDC
fn projectToNDC(worldPos: vec3<f32>) -> vec4<f32> {
  return params.viewProjectionMatrix * vec4<f32>(worldPos, 1.0);
}

// Converts NDC to screen-space UV [0,1]
fn ndcToUV(ndc: vec3<f32>) -> vec2<f32> {
  return vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
}

// Computes the screen-space bounding rectangle of a sphere
fn projectSphereToScreen(
  center: vec3<f32>,
  radius: f32,
) -> vec4<f32> {
  // Project sphere center
  let clipPos = projectToNDC(center);

  // Behind camera — treat as visible (conservative)
  if (clipPos.w <= 0.0) {
    return vec4<f32>(-1.0, -1.0, 2.0, 2.0); // Full screen = always visible
  }

  let ndc = clipPos.xyz / clipPos.w;

  // Compute screen-space radius (approximate)
  // Use the projected size: radius / distance * screenHeight
  let distance = clipPos.w;
  let screenRadius = (radius / distance) * params.screenHeight * 0.5;

  // Convert to UV coordinates
  let centerUV = ndcToUV(ndc);
  let radiusUV = vec2<f32>(
    screenRadius / params.screenWidth,
    screenRadius / params.screenHeight,
  );

  // Return bounding rect: (minU, minV, maxU, maxV)
  return vec4<f32>(
    centerUV.x - radiusUV.x,
    centerUV.y - radiusUV.y,
    centerUV.x + radiusUV.x,
    centerUV.y + radiusUV.y,
  );
}

// Computes the appropriate Hi-Z mip level based on screen-space size
fn computeMipLevel(screenRect: vec4<f32>) -> u32 {
  let rectWidth = (screenRect.z - screenRect.x) * params.screenWidth;
  let rectHeight = (screenRect.w - screenRect.y) * params.screenHeight;
  let maxDim = max(rectWidth, rectHeight);

  // Mip level = log2(maxDim) — sample at a resolution where the rect
  // covers ~1 texel (conservative test)
  let mip = u32(ceil(log2(max(maxDim, 1.0))));
  return min(mip, params.hiZMipLevels - 1u);
}

@compute @workgroup_size(256, 1, 1)
fn computeMain(
  @builtin(global_invocation_id) globalId: vec3<u32>,
) {
  let commandIndex = globalId.x;
  if (commandIndex >= params.commandCount) {
    return;
  }

  // Read bounding sphere from SOA arrays
  let center = vec3<f32>(
    sphereCenterX[commandIndex],
    sphereCenterY[commandIndex],
    sphereCenterZ[commandIndex],
  );
  let radius = sphereRadius[commandIndex];

  // Project sphere to screen-space rectangle
  let screenRect = projectSphereToScreen(center, radius);

  // Bounds check — if rect is outside screen, mark as culled (not occluded)
  if (screenRect.z < 0.0 || screenRect.x > 1.0 ||
      screenRect.w < 0.0 || screenRect.y > 1.0) {
    visibility[commandIndex] = 0u;
    return;
  }

  // Clamp to screen bounds
  let clampedRect = vec4<f32>(
    clamp(screenRect.x, 0.0, 1.0),
    clamp(screenRect.y, 0.0, 1.0),
    clamp(screenRect.z, 0.0, 1.0),
    clamp(screenRect.w, 0.0, 1.0),
  );

  // Compute appropriate mip level
  let mipLevel = computeMipLevel(clampedRect);

  // Sample Hi-Z at the 4 corners of the bounding rect
  let mip = i32(mipLevel);
  let hiZSize = vec2<f32>(textureDimensions(hiZTexture, mip));

  let minCoord = vec2<i32>(vec2<f32>(clampedRect.xy) * hiZSize);
  let maxCoord = vec2<i32>(vec2<f32>(clampedRect.zw) * hiZSize);

  // Sample corners
  let d00 = textureLoad(hiZTexture, clamp(minCoord, vec2<i32>(0), vec2<i32>(hiZSize) - 1), mip).r;
  let d10 = textureLoad(hiZTexture, clamp(vec2<i32>(maxCoord.x, minCoord.y), vec2<i32>(0), vec2<i32>(hiZSize) - 1), mip).r;
  let d01 = textureLoad(hiZTexture, clamp(vec2<i32>(minCoord.x, maxCoord.y), vec2<i32>(0), vec2<i32>(hiZSize) - 1), mip).r;
  let d11 = textureLoad(hiZTexture, clamp(maxCoord, vec2<i32>(0), vec2<i32>(hiZSize) - 1), mip).r;

  // Maximum Hi-Z depth in the bounding rectangle
  let maxHiZ = max(max(d00, d10), max(d01, d11));

  // Compute the sphere's nearest depth (in NDC [0,1])
  let sphereClip = projectToNDC(center);
  var sphereNearZ: f32;
  if (sphereClip.w > 0.0) {
    // Nearest point on sphere (center - radius along view direction)
    sphereNearZ = (sphereClip.z / sphereClip.w) - (radius / sphereClip.w);
    sphereNearZ = clamp(sphereNearZ, 0.0, 1.0);
  } else {
    sphereNearZ = 0.0; // Behind camera — treat as visible
  }

  // Occlusion test: if sphere's near Z is BEHIND the Hi-Z value,
  // the sphere is fully occluded.
  // WebGPU: depth 0 = near, 1 = far. Greater depth = farther.
  if (sphereNearZ > maxHiZ) {
    visibility[commandIndex] = 0u; // OCCLUDED
  } else {
    visibility[commandIndex] = 1u; // VISIBLE
  }
}
