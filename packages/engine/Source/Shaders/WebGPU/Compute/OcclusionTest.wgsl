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
  // FORK-41 (Batch 291) — log-depth reconciliation. The renderer-wide
  // log-depth buffer stores `log2(eyeDist - near + 1) * logDepthFactor`
  // in the depth attachment, so the Hi-Z pyramid (built from that
  // attachment) is in LOG-DEPTH space. The sphere's nearest depth MUST
  // be encoded the same way or every `sphereNearZ > maxHiZ` test
  // collapses to all-visible (hitRatio=0). `logDepthEnabled` is 1 when
  // the active frustum uses the log-depth buffer (the common case);
  // `logDepthFactor` is `czm_oneOverLog2FarDepthFromNearPlusOne` =
  // 1 / log2((far - near) + 1).
  logDepthEnabled: u32,
  logDepthFactor: f32,
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

  // Reject degenerate spheres (no bounding volume) — always visible so we
  // never drop geometry whose extent we can't reason about.
  if (radius <= 0.0) {
    visibility[commandIndex] = 1u;
    return;
  }

  // Project sphere to screen-space rectangle
  let screenRect = projectSphereToScreen(center, radius);

  // Bounds check — if the projected rect is entirely OFF-screen the sphere
  // is outside the view frustum, which is a FRUSTUM-cull case, NOT an
  // OCCLUSION case. Marking it 0u (occluded) here is a false-cull bug:
  // the CPU frustum culler already removed truly off-screen commands, and
  // a sphere straddling the screen edge still has on-screen, potentially
  // visible portions. Hi-Z occlusion only proves "hidden BEHIND nearer
  // geometry"; off-screen tells us nothing about that. Treat off-screen as
  // VISIBLE (conservative) and let frustum culling own that decision.
  if (screenRect.z < 0.0 || screenRect.x > 1.0 ||
      screenRect.w < 0.0 || screenRect.y > 1.0) {
    visibility[commandIndex] = 1u;
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

  // Maximum Hi-Z depth in the bounding rectangle, in the SAME depth space
  // the depth attachment was written in (log-depth when enabled).
  let maxHiZ = max(max(d00, d10), max(d01, d11));

  // Compute the sphere's NEAREST depth in the depth-buffer space.
  let sphereClip = projectToNDC(center);
  if (sphereClip.w <= 0.0) {
    // Center behind the camera — part of the sphere may still be in front.
    // Conservative: visible.
    visibility[commandIndex] = 1u;
    return;
  }

  var sphereNearZ: f32;
  if (params.logDepthEnabled != 0u) {
    // ── Log-depth space (renderer-wide default) ──
    // The depth attachment stores, per the csm_writeLogDepth contract:
    //   fragDepth = log2((eyeDist - near) + 1.0) * logDepthFactor
    // where `eyeDist` is the positive eye-space distance (perspective w)
    // and `logDepthFactor = 1 / log2((far - near) + 1)`. clipPos.w IS that
    // positive eye distance, so the sphere's nearest eye distance is
    // `w - radius`. Encode it identically so the comparison is apples-to-
    // apples. Clamp `depthFromNearPlusOne` to >= 1 so log2 stays >= 0
    // (matches the near-plane clamp the fragment path relies on).
    let nearestEyeDist = sphereClip.w - radius;
    let depthFromNearPlusOne = max((nearestEyeDist - params.nearPlane) + 1.0, 1.0);
    sphereNearZ = clamp(log2(depthFromNearPlusOne) * params.logDepthFactor, 0.0, 1.0);
  } else {
    // ── Linear NDC space (non-log frustum, e.g. the closest frustum where
    // Cesium disables the log-depth buffer) ──
    // Nearest point on sphere (center - radius along view direction).
    sphereNearZ = (sphereClip.z / sphereClip.w) - (radius / sphereClip.w);
    sphereNearZ = clamp(sphereNearZ, 0.0, 1.0);
  }

  // Occlusion test: if the sphere's NEAREST depth is still BEHIND (greater
  // than) the FARTHEST drawn depth in its screen footprint, every fragment
  // of the sphere is hidden → OCCLUDED. WebGPU/Cesium convention: depth
  // 0 = near, 1 = far; greater = farther.
  if (sphereNearZ > maxHiZ) {
    visibility[commandIndex] = 0u; // OCCLUDED
  } else {
    visibility[commandIndex] = 1u; // VISIBLE
  }
}
