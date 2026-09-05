/** WebGL's StencilConstants.CESIUM_3D_TILE_MASK. */
const POINT_CLOUD_EDL_TILE_STENCIL_MASK = 0x80;

/** WebGPU's maximum required dynamic-uniform-offset alignment. */
const POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES = 256;

/**
 * Reset the scalar candidate gate for a new command-list frame. No command
 * bucket is retained here: the bit mask only says whether a compatible EDL
 * source was actually tagged for a pass in this exact frame.
 */
function beginWebGPUPointCloudEDLCandidateFrame(contextState, frameNumber) {
  if (contextState._pointCloudEDLCandidateFrame !== frameNumber) {
    contextState._pointCloudEDLCandidateFrame = frameNumber;
    contextState._pointCloudEDLCandidatePassMask = 0;
  }
}

/** Mark one pass as containing at least one current, compatible EDL source. */
function markWebGPUPointCloudEDLCandidate(contextState, frameNumber, pass) {
  beginWebGPUPointCloudEDLCandidateFrame(contextState, frameNumber);
  if (Number.isInteger(pass) && pass >= 0 && pass < 31) {
    contextState._pointCloudEDLCandidatePassMask |= 1 << pass;
  }
}

/** O(1) gate used before any pass-bucket scan. */
function hasCurrentWebGPUPointCloudEDLCandidate(
  contextState,
  frameNumber,
  pass,
) {
  return (
    contextState._pointCloudEDLCandidateFrame === frameNumber &&
    Number.isInteger(pass) &&
    pass >= 0 &&
    pass < 31 &&
    ((contextState._pointCloudEDLCandidatePassMask ?? 0) & (1 << pass)) !== 0
  );
}

/**
 * Stage one composite's uniforms in the context's bounded page-pooled ring.
 * `allocateAndWrite` owns the submit-safe cursor: standalone pick/capture
 * encoders advance its allocation epoch independently of the scene's logical
 * frame number, so two encoded composites can never rewrite one slot before
 * submit. Returning null is the fail-open signal for a missing/exhausted ring.
 */
function acquireWebGPUPointCloudEDLUniformSlice(allocator, data) {
  if (!allocator || typeof allocator.allocateAndWrite !== "function") {
    return null;
  }
  try {
    const allocation = allocator.allocateAndWrite(
      data,
      POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES,
    );
    if (
      !allocation ||
      allocation.offset % POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES !== 0
    ) {
      return null;
    }
    return allocation;
  } catch {
    // The ring has a hard maxPageCount circuit breaker. Exhaustion must keep
    // the original point draw visible instead of invalidating the frame.
    return null;
  }
}

/** Exact ownership test used before any cached EDL handle is reused. */
function isWebGPUPointCloudEDLCacheCurrent(cache, device, resourceGeneration) {
  return (
    cache !== null &&
    cache !== undefined &&
    cache.device === device &&
    cache.resourceGeneration === resourceGeneration
  );
}

/** Stable composite-pipeline identity for the concrete destination shape. */
function getWebGPUPointCloudEDLBlendPipelineKey(
  targetKind,
  colorFormat,
  sampleCount,
  targetCount,
) {
  return `${targetKind}|${colorFormat}|${sampleCount}|${targetCount}`;
}

/**
 * Assign a deterministic processor order once per exact context and scene
 * frame. The context state is intentionally scalar: no per-frame
 * processor/cloud list exists.
 */
function beginWebGPUPointCloudEDLProcessorUpdate(
  contextState,
  processor,
  frameNumber,
) {
  if (contextState._pointCloudEDLUpdateFrame !== frameNumber) {
    contextState._pointCloudEDLUpdateFrame = frameNumber;
    contextState._pointCloudEDLNextUpdateOrder = 0;
  }
  if (
    processor._webgpuEDLUpdateContext !== contextState ||
    processor._webgpuEDLUpdateFrame !== frameNumber
  ) {
    processor._webgpuEDLUpdateContext = contextState;
    processor._webgpuEDLUpdateFrame = frameNumber;
    processor._webgpuEDLUpdateOrder =
      contextState._pointCloudEDLNextUpdateOrder ?? 0;
    contextState._pointCloudEDLNextUpdateOrder =
      (contextState._pointCloudEDLNextUpdateOrder ?? 0) + 1;
  }
  return processor._webgpuEDLUpdateOrder ?? 0;
}

/** Exact command-metadata ownership test for one frustum target slice. */
function isWebGPUPointCloudEDLMetadataForSlice(
  metadata,
  frameNumber,
  pass,
  frustumSlice,
  targetKind,
  targetIdentity,
) {
  return (
    metadata !== null &&
    metadata !== undefined &&
    metadata.frameNumber === frameNumber &&
    metadata.pass === pass &&
    metadata.interceptFrame === frameNumber &&
    metadata.interceptSlice === frustumSlice &&
    metadata.targetKind === targetKind &&
    metadata.targetIdentity === targetIdentity
  );
}

/**
 * Find the next processor directly in a disabled pass bucket. This preserves
 * update order without allocating a transient processor-group array.
 */
function findNextWebGPUPointCloudEDLProcessor(
  commands,
  count,
  frameNumber,
  pass,
  frustumSlice,
  targetKind,
  targetIdentity,
  afterOrder,
) {
  let nextMetadata = null;
  let nextOrder = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const command = commands[i];
    const metadata = command?._webgpuPointCloudEDL;
    if (
      command?.enabled !== false ||
      !isWebGPUPointCloudEDLMetadataForSlice(
        metadata,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
      )
    ) {
      continue;
    }
    if (metadata.updateOrder > afterOrder && metadata.updateOrder < nextOrder) {
      nextMetadata = metadata;
      nextOrder = metadata.updateOrder;
    }
  }
  return nextMetadata === null
    ? null
    : {
        processor: nextMetadata.processor,
        updateOrder: nextMetadata.updateOrder,
      };
}

/** Mark one already-preflighted command for a concrete target slice. */
function interceptWebGPUPointCloudEDLCommand(
  command,
  metadata,
  frameNumber,
  frustumSlice,
  targetKind,
  targetIdentity,
) {
  metadata.interceptFrame = frameNumber;
  metadata.interceptSlice = frustumSlice;
  metadata.targetKind = targetKind;
  metadata.targetIdentity = targetIdentity;
  command.enabled = false;
}

/** Restore the original command after either composite or fail-open fallback. */
function restoreWebGPUPointCloudEDLCommand(command, metadata) {
  command.enabled = true;
  metadata.interceptFrame = -1;
  metadata.interceptSlice = -1;
  metadata.targetKind = null;
  metadata.targetIdentity = null;
}

/** Remove exactly one processor and report whether the shared cache is empty. */
function releaseWebGPUPointCloudEDLOwner(owners, processor) {
  owners.delete(processor);
  return owners.size === 0;
}

/** Full-resolution targets are idle unless a group rendered this frame. */
function shouldReleaseWebGPUPointCloudEDLTargets(cache, frameNumber) {
  return (
    cache.lastActiveFrame !== frameNumber &&
    cache.colorTexture !== null &&
    cache.colorTexture !== undefined
  );
}

/**
 * Keep the original point draw available when synchronous EDL work fails.
 *
 * @template T
 * @param {function(): T} attempt
 * @param {Object} handlers Callbacks: `report(error)` records the failure and
 *   `restore(error)` re-enables the original point draw.
 * @returns {T | false}
 */
function withWebGPUPointCloudEDLFailOpen(attempt, handlers) {
  try {
    return attempt();
  } catch (error) {
    handlers.report(error);
    handlers.restore(error);
    return false;
  }
}

/**
 * Depth/stencil contract for the EDL composite into the live scene pass.
 * The fragment shader emits the captured point device depth. A passing point
 * therefore updates both scene depth and Cesium's 3D-Tile stencil bit, exactly
 * like PointCloudEyeDomeLighting's WebGL blend render state.
 *
 * Kept as an executable descriptor helper so recovery/unit tests validate the
 * object supplied to WebGPU rather than relying on a source-text assertion.
 *
 * @returns {GPUDepthStencilState}
 */
function createWebGPUPointCloudEDLCompositeDepthStencilState() {
  const stencilFace = {
    compare: "always",
    failOp: "keep",
    depthFailOp: "keep",
    passOp: "replace",
  };
  return {
    format: "depth24plus-stencil8",
    depthWriteEnabled: true,
    depthCompare: "less-equal",
    stencilFront: stencilFace,
    stencilBack: stencilFace,
    stencilReadMask: POINT_CLOUD_EDL_TILE_STENCIL_MASK,
    stencilWriteMask: POINT_CLOUD_EDL_TILE_STENCIL_MASK,
  };
}

export {
  POINT_CLOUD_EDL_TILE_STENCIL_MASK,
  POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES,
  acquireWebGPUPointCloudEDLUniformSlice,
  beginWebGPUPointCloudEDLCandidateFrame,
  beginWebGPUPointCloudEDLProcessorUpdate,
  createWebGPUPointCloudEDLCompositeDepthStencilState,
  findNextWebGPUPointCloudEDLProcessor,
  getWebGPUPointCloudEDLBlendPipelineKey,
  hasCurrentWebGPUPointCloudEDLCandidate,
  interceptWebGPUPointCloudEDLCommand,
  isWebGPUPointCloudEDLCacheCurrent,
  isWebGPUPointCloudEDLMetadataForSlice,
  markWebGPUPointCloudEDLCandidate,
  releaseWebGPUPointCloudEDLOwner,
  restoreWebGPUPointCloudEDLCommand,
  shouldReleaseWebGPUPointCloudEDLTargets,
  withWebGPUPointCloudEDLFailOpen,
};

export default {
  POINT_CLOUD_EDL_TILE_STENCIL_MASK,
  POINT_CLOUD_EDL_UNIFORM_SLOT_BYTES,
  acquireWebGPUPointCloudEDLUniformSlice,
  beginWebGPUPointCloudEDLCandidateFrame,
  beginWebGPUPointCloudEDLProcessorUpdate,
  createWebGPUPointCloudEDLCompositeDepthStencilState,
  findNextWebGPUPointCloudEDLProcessor,
  getWebGPUPointCloudEDLBlendPipelineKey,
  hasCurrentWebGPUPointCloudEDLCandidate,
  interceptWebGPUPointCloudEDLCommand,
  isWebGPUPointCloudEDLCacheCurrent,
  isWebGPUPointCloudEDLMetadataForSlice,
  markWebGPUPointCloudEDLCandidate,
  releaseWebGPUPointCloudEDLOwner,
  restoreWebGPUPointCloudEDLCommand,
  shouldReleaseWebGPUPointCloudEDLTargets,
  withWebGPUPointCloudEDLFailOpen,
};
