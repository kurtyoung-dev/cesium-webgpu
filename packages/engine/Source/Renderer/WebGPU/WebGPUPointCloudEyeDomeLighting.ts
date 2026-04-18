/**
 * WebGPU Point Cloud Eye-Dome Lighting (stub)
 *
 * EDL is a depth-discontinuity post-process that wraps point cloud draw
 * commands inside an offscreen FBO and blends a darkened-edge result back
 * to the main framebuffer. The full WebGL implementation lives in
 * Scene/PointCloudEyeDomeLighting.js (`createCommands` / command hijacking).
 *
 * Porting the hijack pipeline to WebGPU requires:
 *   1. An offscreen color+depth render target sized to drawingBufferWidth/Height
 *   2. Re-issuing every PointCloud draw command into that target with a
 *      shader variant that writes linearized depth into a second color attachment
 *   3. A fullscreen blend pass (WGSL fragment shader in this file, see git history)
 *      that samples the two attachments and applies the EDL response.
 *
 * Until that's wired, this stub no-ops cleanly so PointCloud rendering still
 * works under WebGPU (the underlying WebGPUPointCloudRenderer draws directly
 * to the main framebuffer without EDL enhancement).
 *
 * @module WebGPUPointCloudEyeDomeLighting
 */

// One-shot warning flag — avoids spamming the console every frame when
// an app has EDL enabled but hasn't noticed it's silently no-op on
// WebGPU. The full port is tracked as a follow-up; this warning was
// added to resolve C-P14 (2026-04-16 per-feature review).
let _edlWarned = false;

function updateWebGPUPointCloudEDL(
  _edl: CesiumObjectWithWebGPUCache,
  _frameState: CesiumFrameState,
  _commandsToHijack: CesiumAnyDrawCommand[],
): void {
  if (!_edlWarned) {
    _edlWarned = true;
    console.warn(
      "[CesiumJS:webgpu] PointCloudEyeDomeLighting (EDL) is not yet " +
        "implemented on the WebGPU backend. Point clouds render without " +
        "edge-darkening. Port tracked as C-P14 in the 2026-04-16 " +
        "per-feature review (see migration_doc/).",
    );
  }
  // Intentional no-op — see module header for full port requirements.
}

function destroyWebGPUPointCloudEDLResources(
  _edl: CesiumObjectWithWebGPUCache,
): void {
  // No persistent resources to release in the stub.
}

export { updateWebGPUPointCloudEDL, destroyWebGPUPointCloudEDLResources };
export default {
  updateWebGPUPointCloudEDL,
  destroyWebGPUPointCloudEDLResources,
};
