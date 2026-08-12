/**
 * Exact device-generation and retained-content ownership for one WebGPU voxel
 * primitive. Kept separate from the renderer so the asynchronous publication
 * rules can be exercised without constructing a browser GPUDevice.
 *
 * @module WebGPUVoxelResourceLifecycle
 */

// Kept as a compatibility export for focused probes written against the old
// quarantine model. Pick safety is identity-based now, so there is no timed
// guard and a matching first readback is immediately usable.
const VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES = 0;

function nextSafeGeneration(value) {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("WebGPU voxel resource generation space exhausted");
  }
  return value + 1;
}

function createVoxelResourceLifecycle(
  device,
  resourceGeneration,
  slotCapacity = 1,
) {
  const capacity = Math.max(1, Math.floor(slotCapacity));
  return {
    device,
    resourceGeneration,
    epoch: 1,
    detached: false,
    contentRefCounts: new Map(),
    disposedContents: new WeakSet(),
    // Float64Array keeps integer identity exact through Number.MAX_SAFE_INTEGER.
    // The previous Uint32Array wrapped after 2^32 reuses, reopening an ABA
    // window where a very old asynchronous pick could match a new occupant.
    slotGenerations: new Float64Array(capacity),
    // Changes only when a slot with a prior occupant is assigned again. The
    // framebuffer captures this owner-wide epoch with each voxel readback.
    atlasReuseEpoch: 0,
    // Changes for every atlas topology/content publication or retirement.
    // Unlike atlasReuseEpoch, this also covers first-time refinement uploads,
    // which can change the tile/sample selected by an otherwise identical ray.
    contentRevision: 0,
  };
}

function ensureVoxelAtlasSlotCapacity(lifecycle, slotCapacity) {
  const capacity = Math.max(1, Math.floor(slotCapacity));
  if (capacity <= lifecycle.slotGenerations.length) {
    return;
  }
  const generations = new Float64Array(capacity);
  generations.set(lifecycle.slotGenerations);
  lifecycle.slotGenerations = generations;
}

function isVoxelResourceLifecycleCurrent(
  lifecycle,
  device,
  resourceGeneration,
) {
  return (
    !lifecycle.detached &&
    lifecycle.device === device &&
    lifecycle.resourceGeneration === resourceGeneration
  );
}

function captureVoxelResourceLifecycleToken(lifecycle) {
  return lifecycle.epoch;
}

function isVoxelResourceLifecycleTokenCurrent(lifecycle, token) {
  return !lifecycle.detached && lifecycle.epoch === token;
}

function createVoxelAsyncFailureState() {
  return { error: null, reported: false };
}

function recordVoxelAsyncFailure(lifecycle, token, state, reason) {
  if (state.error || !isVoxelResourceLifecycleTokenCurrent(lifecycle, token)) {
    return null;
  }
  let error;
  if (reason instanceof Error) {
    error = reason;
  } else {
    error = new Error(
      typeof reason === "string"
        ? reason
        : "Unknown WebGPU voxel asynchronous failure",
    );
    error.cause = reason;
  }
  state.error = error;
  state.reported = false;
  return error;
}

function takeVoxelAsyncFailure(state) {
  if (!state.error || state.reported) {
    return null;
  }
  state.reported = true;
  return state.error;
}

function resetVoxelAsyncFailure(state) {
  state.error = null;
  state.reported = false;
}

function detachVoxelResourceLifecycle(lifecycle) {
  if (lifecycle.detached) {
    return;
  }
  lifecycle.detached = true;
  lifecycle.epoch = nextSafeGeneration(lifecycle.epoch);
}

function isContentObject(content) {
  return (
    (typeof content === "object" && content !== null) ||
    typeof content === "function"
  );
}

function disposeVoxelContentOnce(lifecycle, content) {
  if (!isContentObject(content) || lifecycle.disposedContents.has(content)) {
    return;
  }
  lifecycle.disposedContents.add(content);

  try {
    const isDestroyed = content.isDestroyed;
    if (typeof isDestroyed === "function" && isDestroyed.call(content)) {
      return;
    }
  } catch {
    // Cleanup is best-effort. A broken status hook must not prevent attempting
    // the destroy hook or draining the remaining detached content owners.
  }

  try {
    const destroy = content.destroy;
    if (typeof destroy === "function") {
      destroy.call(content);
    }
  } catch {
    // Resource cleanup must never replace the original asynchronous failure or
    // interrupt sibling disposal during device-loss and generation teardown.
  }
}

function disposeUnpublishedVoxelContent(lifecycle, content) {
  if ((lifecycle.contentRefCounts.get(content) ?? 0) > 0) {
    return;
  }
  disposeVoxelContentOnce(lifecycle, content);
}

function retainVoxelContent(lifecycle, content) {
  if (lifecycle.detached) {
    disposeUnpublishedVoxelContent(lifecycle, content);
    return false;
  }
  const previous = lifecycle.contentRefCounts.get(content) ?? 0;
  lifecycle.contentRefCounts.set(content, previous + 1);
  return true;
}

function tryRetainVoxelContentForToken(lifecycle, token, content) {
  if (!isVoxelResourceLifecycleTokenCurrent(lifecycle, token)) {
    disposeUnpublishedVoxelContent(lifecycle, content);
    return false;
  }
  return retainVoxelContent(lifecycle, content);
}

function releaseVoxelContent(lifecycle, content) {
  if (!isContentObject(content)) {
    return;
  }
  const previous = lifecycle.contentRefCounts.get(content) ?? 0;
  if (previous > 1) {
    lifecycle.contentRefCounts.set(content, previous - 1);
    return;
  }
  if (previous === 1) {
    lifecycle.contentRefCounts.delete(content);
  }
  disposeVoxelContentOnce(lifecycle, content);
}

function disposeAllVoxelContents(lifecycle) {
  const retained = Array.from(lifecycle.contentRefCounts.keys());
  // Drop every strong reference before invoking user/resource-loader destroy
  // hooks. A hook cannot observe a half-retired ownership table, and a late
  // promise completion is handled solely by the weak exact-once set.
  lifecycle.contentRefCounts.clear();
  for (const content of retained) {
    disposeVoxelContentOnce(lifecycle, content);
  }
}

function publishVoxelAtlasSlot(lifecycle, slot) {
  if (slot < 0 || slot >= lifecycle.slotGenerations.length) {
    return 0;
  }
  const previous = lifecycle.slotGenerations[slot];
  const generation = nextSafeGeneration(previous);
  lifecycle.contentRevision = nextSafeGeneration(lifecycle.contentRevision);
  if (previous !== 0) {
    lifecycle.atlasReuseEpoch = nextSafeGeneration(lifecycle.atlasReuseEpoch);
  }
  lifecycle.slotGenerations[slot] = generation;
  return generation;
}

function retireVoxelAtlasSlot(lifecycle, slot, generation) {
  if (!isVoxelAtlasSlotCurrent(lifecycle, slot, generation)) {
    return false;
  }
  lifecycle.slotGenerations[slot] = nextSafeGeneration(generation);
  lifecycle.contentRevision = nextSafeGeneration(lifecycle.contentRevision);
  return true;
}

function stampVoxelAtlasDemandFrame(
  states,
  demandLevel,
  demandMask,
  frameIndex,
) {
  if (demandLevel < 2 || demandMask === null) {
    return 0;
  }
  let demandCount = 0;
  const length = Math.min(states.length, demandMask.length);
  for (let i = 0; i < length; i++) {
    if (demandMask[i] !== 0) {
      states[i].lastDemandFrame = frameIndex;
      demandCount++;
    }
  }
  return demandCount;
}

function selectVoxelAtlasLruVictim(slots, states, frameIndex) {
  let victim = -1;
  let oldest = Infinity;
  const length = Math.min(slots.length, states.length);
  for (let i = 0; i < length; i++) {
    if (slots[i] < 0) {
      continue;
    }
    const lastDemandFrame = states[i].lastDemandFrame;
    if (lastDemandFrame >= frameIndex) {
      continue;
    }
    if (lastDemandFrame < oldest) {
      oldest = lastDemandFrame;
      victim = i;
    }
  }
  return victim;
}

function isVoxelAtlasSlotCurrent(lifecycle, slot, generation) {
  return (
    !lifecycle.detached &&
    generation !== 0 &&
    slot >= 0 &&
    slot < lifecycle.slotGenerations.length &&
    lifecycle.slotGenerations[slot] === generation
  );
}

function isVoxelAtlasSlotPickSafe(lifecycle, slot, generation) {
  return isVoxelAtlasSlotCurrent(lifecycle, slot, generation);
}

const WebGPUVoxelResourceLifecycle = {
  VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES,
  captureVoxelResourceLifecycleToken,
  createVoxelAsyncFailureState,
  createVoxelResourceLifecycle,
  detachVoxelResourceLifecycle,
  disposeAllVoxelContents,
  disposeUnpublishedVoxelContent,
  disposeVoxelContentOnce,
  ensureVoxelAtlasSlotCapacity,
  isVoxelAtlasSlotCurrent,
  isVoxelAtlasSlotPickSafe,
  isVoxelResourceLifecycleCurrent,
  isVoxelResourceLifecycleTokenCurrent,
  publishVoxelAtlasSlot,
  recordVoxelAsyncFailure,
  releaseVoxelContent,
  retireVoxelAtlasSlot,
  resetVoxelAsyncFailure,
  retainVoxelContent,
  selectVoxelAtlasLruVictim,
  stampVoxelAtlasDemandFrame,
  takeVoxelAsyncFailure,
  tryRetainVoxelContentForToken,
};

export {
  VOXEL_PICK_SLOT_REUSE_GUARD_FRAMES,
  captureVoxelResourceLifecycleToken,
  createVoxelAsyncFailureState,
  createVoxelResourceLifecycle,
  detachVoxelResourceLifecycle,
  disposeAllVoxelContents,
  disposeUnpublishedVoxelContent,
  disposeVoxelContentOnce,
  ensureVoxelAtlasSlotCapacity,
  isVoxelAtlasSlotCurrent,
  isVoxelAtlasSlotPickSafe,
  isVoxelResourceLifecycleCurrent,
  isVoxelResourceLifecycleTokenCurrent,
  publishVoxelAtlasSlot,
  recordVoxelAsyncFailure,
  releaseVoxelContent,
  retireVoxelAtlasSlot,
  resetVoxelAsyncFailure,
  retainVoxelContent,
  selectVoxelAtlasLruVictim,
  stampVoxelAtlasDemandFrame,
  takeVoxelAsyncFailure,
  tryRetainVoxelContentForToken,
};
export default WebGPUVoxelResourceLifecycle;
