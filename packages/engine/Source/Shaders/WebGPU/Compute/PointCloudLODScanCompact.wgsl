// PointCloudLODScanCompact.wgsl — deterministic-order point-cloud LOD +
// compaction via parallel prefix scan (FEAT-SURVEY-06 consumer).
//
// Replaces the atomicAdd-based global-counter compaction used by
// PointCloudLOD.wgsl with a three-step pipeline:
//
//   1. tagVisible        — per-point visibility test (frustum + LOD +
//                          decimation). Writes 0/1 into `flags[i]`.
//   2. DecoupledScan     — host-scheduled inclusive prefix sum over
//                          `flags`, producing `prefix[i] = sum(flags[0..=i])`.
//   3. compactScanned    — for every visible point, writes `pointIndex`
//                          into `visibleIndices[prefix[i] - 1]`.
//
// The resulting `visibleIndices` buffer is **order-stable** — two frames
// with the same inputs always produce the same output ordering, regardless
// of GPU workgroup-completion timing. That matters for point-cloud picking
// consistency and for any GPU-driven downstream pass that indexes visible
// points by slot (e.g. instanced re-draws, persistent GPU occlusion
// buffers, multi-view selection masks).
//
// Trade-offs vs. the atomic-add variant:
//   + Deterministic output ordering (the whole point).
//   + Scan is single-dispatch via decoupled-lookback → no round-trip cost.
//   - One extra compute pass + two extra storage buffers (flags, prefix).
//   - At low point counts (<10k) the dispatch overhead dominates the
//     scan's asymptotic win; LODProcessor still defaults to the atomic
//     variant and callers opt-in with `useDecoupledScan: true`.
//
// Layout: all three entry points share @group(0). Each entry point only
// reads the subset of bindings it needs — WebGPU is fine with that as
// long as the bind group provided at dispatch time satisfies the
// pipeline layout.

// MUST match `struct LODParams` in PointCloudLOD.wgsl exactly — same
// JS-side writer (`WebGPUPointCloudLODProcessor._writeParams`) produces
// both. Kept inline rather than `#include`d because WebGPU doesn't have
// a module system and we don't want a preprocessor step just for one
// shared struct.
struct LODParams {
  cameraPositionLocal: vec3<f32>,
  _pad0: f32,
  projectionScale: f32,
  targetPixelSpacing: f32,
  geometricError: f32,
  lodFarDistance: f32,
  frustumPlane0: vec4<f32>,
  frustumPlane1: vec4<f32>,
  frustumPlane2: vec4<f32>,
  frustumPlane3: vec4<f32>,
  frustumPlane4: vec4<f32>,
  frustumPlane5: vec4<f32>,
  pointCount: u32,
  maxVisiblePoints: u32,
  _pad2: vec2<f32>,
  modelLinear0: vec4<f32>,
  modelLinear1: vec4<f32>,
  modelLinear2: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: LODParams;
@group(0) @binding(1) var<storage, read> positionsX: array<f32>;
@group(0) @binding(2) var<storage, read> positionsY: array<f32>;
@group(0) @binding(3) var<storage, read> positionsZ: array<f32>;
// flags[i] = 0 or 1. Written by tagVisible, read by compactScanned (and
// by DecoupledScan between the two).
@group(0) @binding(4) var<storage, read_write> flags: array<u32>;
// prefix[i] = inclusive prefix sum of flags[0..=i]. Written by
// DecoupledScan (host-scheduled between tagVisible and compactScanned).
@group(0) @binding(5) var<storage, read> prefix: array<u32>;
// Final compacted list of visible point indices.
@group(0) @binding(6) var<storage, read_write> visibleIndices: array<u32>;
// Exact capped count consumed by drawIndirect. The last prefix lane writes it
// during compactScanned so the uncapped scan total is never exposed.
@group(0) @binding(7) var<storage, read_write> visibleCount: atomic<u32>;

fn frustumTest(pos: vec3<f32>) -> bool {
  let planes = array<vec4<f32>, 6>(
    params.frustumPlane0, params.frustumPlane1, params.frustumPlane2,
    params.frustumPlane3, params.frustumPlane4, params.frustumPlane5,
  );
  for (var i = 0u; i < 6u; i++) {
    let d = dot(planes[i].xyz, pos) + planes[i].w;
    if (d < 0.0) {
      return false;
    }
  }
  return true;
}

fn worldCameraDistance(pos: vec3<f32>) -> f32 {
  let localDelta = pos - params.cameraPositionLocal;
  let worldDelta = vec3<f32>(
    dot(params.modelLinear0.xyz, localDelta),
    dot(params.modelLinear1.xyz, localDelta),
    dot(params.modelLinear2.xyz, localDelta),
  );
  return length(worldDelta);
}

fn projectedSpacing(cameraDistance: f32) -> f32 {
  return params.geometricError * params.projectionScale /
    max(cameraDistance, 1e-4);
}

fn selectLOD(pos: vec3<f32>) -> u32 {
  let cameraDistance = worldCameraDistance(pos);
  if (params.lodFarDistance > 0.0 && cameraDistance > params.lodFarDistance) {
    return 4u;
  }
  let ratio = projectedSpacing(cameraDistance) / max(params.targetPixelSpacing, 0.25);
  if (ratio >= 4.0) { return 0u; }
  if (ratio >= 2.0) { return 1u; }
  if (ratio >= 1.0) { return 2u; }
  return 3u;
}

// Identical to `shouldKeepAtLOD` in PointCloudLOD.wgsl — deterministic
// decimation by pointIndex so LOD boundaries don't flicker between
// frames.
fn shouldKeepAtLOD(pointIndex: u32, lodLevel: u32) -> bool {
  if (lodLevel == 0u) { return true; }
  if (lodLevel == 1u) { return (pointIndex & 3u) == 0u; }
  if (lodLevel == 2u) { return (pointIndex & 15u) == 0u; }
  return (pointIndex & 63u) == 0u;
}

// Tag pass — 1 thread per point. Writes the per-point visibility flag.
// Reads: params, positionsX/Y/Z.  Writes: flags.
@compute @workgroup_size(256)
fn tagVisible(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pointIndex = gid.x;
  if (pointIndex >= params.pointCount) {
    return;
  }

  let pos = vec3<f32>(
    positionsX[pointIndex],
    positionsY[pointIndex],
    positionsZ[pointIndex],
  );

  var isVisible: u32 = 0u;
  if (frustumTest(pos)) {
    let lodLevel = selectLOD(pos);
    if (lodLevel < 4u && shouldKeepAtLOD(pointIndex, lodLevel)) {
      isVisible = 1u;
    }
  }

  flags[pointIndex] = isVisible;
}

// Compact pass — 1 thread per point. Uses the pre-scanned `prefix`
// buffer to place each visible point at its deterministic output slot.
// Reads: params, flags, prefix.  Writes: visibleIndices.
@compute @workgroup_size(256)
fn compactScanned(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pointIndex = gid.x;
  if (pointIndex >= params.pointCount) {
    return;
  }
  if (pointIndex + 1u == params.pointCount) {
    atomicStore(&visibleCount, min(prefix[pointIndex], params.maxVisiblePoints));
  }
  if (flags[pointIndex] == 0u) {
    return;
  }
  // DecoupledScan produces an INCLUSIVE prefix: prefix[i] = #visible in [0..=i].
  // Slot for this point = prefix[i] - 1 (first visible point gets slot 0).
  let slot = prefix[pointIndex] - 1u;
  // Hard cap to the caller's budget. The scan can produce more visible
  // points than the caller wants to render — clamp here so we don't
  // overrun the output buffer.
  if (slot < params.maxVisiblePoints) {
    visibleIndices[slot] = pointIndex;
  }
}
