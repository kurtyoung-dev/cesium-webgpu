// ComputeInstanceScaffold.wgsl — engine scaffolding for user-supplied
// compute-instance kernels (NEW-COMPUTE-INSTANCE-SYSTEM, Batch 231).
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
// RTE precision note: kernels run in f32, so the low part of the output
// position is written as 0 — the slot is the layout contract for a future
// df64 (two-float) kernel upgrade, after which the buffer and render shader
// need no changes. Positions are absolute ECEF meters; the render shader
// subtracts the encoded camera on the GPU (translateRelativeToEye pattern).

// Returned by the user kernel. position is absolute ECEF meters; color is
// straight (non-premultiplied) RGBA in [0,1]; pixelSize is the dot diameter
// in pixels.
struct ComputeInstanceOut {
  position: vec3<f32>,
  color: vec4<f32>,
  pixelSize: f32,
};

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

  // RTE high/low split — engine-owned (see the header note). f32 kernel
  // math means low = 0 for now; the slot is the df64 upgrade contract.
  csm_instances[i].positionHigh = result.position;
  csm_instances[i].positionLow = vec3<f32>(0.0, 0.0, 0.0);
  csm_instances[i].color = result.color;
  csm_instances[i].pixelSize = result.pixelSize;
}
