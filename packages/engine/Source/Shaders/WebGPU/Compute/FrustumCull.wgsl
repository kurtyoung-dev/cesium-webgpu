// FrustumCull.wgsl — GPU compute frustum culling shader
//
// Tests bounding spheres against 6 frustum planes and writes
// visibility results to an output buffer. Optionally writes
// to an indirect draw buffer to enable GPU-driven rendering.
//
// Dispatch: ceil(objectCount / 256) workgroups of 256 threads each.

// Frustum planes: 6 planes × vec4<f32> (normal.xyz + distance.w)
struct FrustumPlanes {
  planes: array<vec4<f32>, 6>,
};

// Per-object bounding sphere: center.xyz + radius.w
struct BoundingSphereData {
  centerAndRadius: vec4<f32>,
};

// Draw call parameters for indexed indirect rendering
struct DrawIndexedIndirect {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
};

// Uniforms: frustum planes + object count
@group(0) @binding(0) var<uniform> frustum: FrustumPlanes;
@group(0) @binding(1) var<uniform> params: vec4<u32>; // x=objectCount, y=mode(0=visibility,1=indirect)

// Input: bounding spheres
@group(0) @binding(2) var<storage, read> boundingSpheres: array<BoundingSphereData>;

// Output: visibility flags (1 = visible, 0 = culled)
@group(0) @binding(3) var<storage, read_write> visibilityFlags: array<u32>;

// Optional output: indirect draw buffer (only written when mode=1)
@group(0) @binding(4) var<storage, read_write> indirectDraws: array<DrawIndexedIndirect>;

// Optional: atomic counter for compacted visible draw count
@group(0) @binding(5) var<storage, read_write> visibleCount: atomic<u32>;

/**
 * Test a bounding sphere against 6 frustum planes.
 * Returns true if the sphere is at least partially inside the frustum.
 */
fn isSphereInFrustum(center: vec3<f32>, radius: f32) -> bool {
  for (var i = 0u; i < 6u; i = i + 1u) {
    let plane = frustum.planes[i];
    let distance = dot(plane.xyz, center) + plane.w;
    if (distance < -radius) {
      return false; // Sphere is entirely behind this plane
    }
  }
  return true;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let objectIndex = globalId.x;
  let objectCount = params.x;
  let mode = params.y;

  if (objectIndex >= objectCount) {
    return;
  }

  let sphere = boundingSpheres[objectIndex];
  let center = sphere.centerAndRadius.xyz;
  let radius = sphere.centerAndRadius.w;

  let visible = isSphereInFrustum(center, radius);

  // Write visibility flag
  if (visible) {
    visibilityFlags[objectIndex] = 1u;
  } else {
    visibilityFlags[objectIndex] = 0u;
  }

  // Mode 1: Also update indirect draw buffer
  if (mode == 1u) {
    if (visible) {
      // Keep the draw call as-is (instanceCount stays > 0)
      // The indirect buffer was pre-filled by the CPU
    } else {
      // Cull by setting instanceCount to 0
      indirectDraws[objectIndex].instanceCount = 0u;
    }
  }

  // Mode 2: Compact visible draws using atomic counter
  if (mode == 2u && visible) {
    atomicAdd(&visibleCount, 1u);
  }
}
