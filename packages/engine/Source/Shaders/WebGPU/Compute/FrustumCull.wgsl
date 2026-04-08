// FrustumCull.wgsl — GPU compute frustum culling shader
//
// Tests bounding spheres against 6 frustum planes and writes
// visibility results to an output buffer. Optionally writes
// to an indirect draw buffer to enable GPU-driven rendering.
//
// Dispatch: ceil(objectCount / 256) workgroups of 256 threads each.
//
// Two entry points:
//   - main          : portable scalar implementation
//   - mainSubgroups : subgroup-accelerated variant — collapses the per-thread
//                     atomicAdd(&visibleCount, 1) (mode 2) into one atomicAdd
//                     per subgroup using subgroupBallot + countOneBits. This
//                     avoids per-thread atomic contention on the shared
//                     counter and is 2-4× faster on GPUs with native subgroup
//                     support (NVIDIA, Intel, modern AMD/Apple). The renderer
//                     selects this entry point at pipeline-creation time when
//                     `device.features.has("subgroups")`.

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

// ─── Subgroup-accelerated variant ────────────────────────────────────────────
// Identical semantics to `main` but uses subgroupBallot + a single per-subgroup
// atomicAdd for mode 2 instead of per-thread atomicAdds. Requires the
// "subgroups" feature on the device — the renderer falls back to `main` when
// unavailable.
//
// IMPORTANT: the `enable subgroups;` directive cannot live here — WGSL requires
// all `enable` directives to precede every global declaration. WebGPUGPUCuller
// preprocesses this source by either prepending the directive (subgroup-capable
// devices) or stripping the entire SUBGROUP_BLOCK between the markers below
// (non-subgroup devices). Do not remove the marker comments.

// __SUBGROUP_BLOCK_START__
@compute @workgroup_size(256)
fn mainSubgroups(@builtin(global_invocation_id) globalId: vec3<u32>,
                 @builtin(subgroup_invocation_id) sgLocalId: u32) {
  let objectIndex = globalId.x;
  let objectCount = params.x;
  let mode = params.y;

  // Out-of-range threads still need to participate in the ballot below so
  // every active subgroup lane votes — but their vote is "not visible".
  var visible = false;
  if (objectIndex < objectCount) {
    let sphere = boundingSpheres[objectIndex];
    visible = isSphereInFrustum(
      sphere.centerAndRadius.xyz,
      sphere.centerAndRadius.w,
    );

    // Per-thread visibility flag (same layout as main)
    visibilityFlags[objectIndex] = select(0u, 1u, visible);

    // Mode 1: zero out culled draws in the indirect buffer
    if (mode == 1u && !visible) {
      indirectDraws[objectIndex].instanceCount = 0u;
    }
  }

  // Mode 2: subgroup-collapsed atomic counter
  if (mode == 2u) {
    let ballot = subgroupBallot(visible);
    // ballot is vec4<u32>; .xy covers up to 64-lane subgroups (AMD, Apple).
    let visibleInSubgroup =
      countOneBits(ballot.x) + countOneBits(ballot.y);
    // Lane 0 of each subgroup performs one atomic add for the whole group.
    if (sgLocalId == 0u && visibleInSubgroup > 0u) {
      atomicAdd(&visibleCount, visibleInSubgroup);
    }
  }
}
// __SUBGROUP_BLOCK_END__
