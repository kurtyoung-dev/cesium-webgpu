import destroyObject from "../Core/destroyObject.js";

/**
 * Phase 8a (Batch 80 — Slice 1, Batch 85 — Slice 2, Batch 86 — Slice 2b)
 * — depth-prepass + normal G-buffer scaffolding.
 *
 * **Slice 2b note (this batch):** rewritten to manage GPU resources
 * directly (raw `GPUTexture` + `GPUTextureView`) instead of through
 * `FramebufferManager`. The Slice 1 design used `FramebufferManager`
 * for consistency with `SceneFramebuffer`, but FramebufferManager
 * creates Cesium `Texture` objects without `STORAGE_BINDING` usage,
 * so the WGSL compute producer (Slice 2) couldn't bind the G-buffer
 * as `texture_storage_2d<rgba16float, write>`. Slice 2b closes that
 * gap by creating the texture with the right usage flags directly.
 *
 * The trade-off: this class is now WebGPU-specific (it builds a
 * `GPUTexture` against `context.device`). That's fine — deferred
 * lighting is a WebGPU-only path. The WebGL backend never instantiates
 * this class through `frameState.useDeferredLighting` because the
 * gate is also WebGPU-only.
 *
 * Allocates a single `rgba16float` color attachment for packed
 * `(normalEye.xyz, roughness)`. Usage flags:
 *   - `STORAGE_BINDING` — required so the compute producer can write
 *     into it (`@group(0) @binding(2) var gBufferOut: texture_storage_2d`).
 *   - `TEXTURE_BINDING` — required so Slice 3+ consumers (SSAO/SSR/etc.)
 *     can sample from it.
 *   - `COPY_DST` — required for the per-frame clear (we don't use a
 *     render-pass clear since this texture is never bound as a render
 *     attachment).
 *
 * The depth side of the prepass is intentionally NOT a separate
 * texture — Slice 2's compute producer samples the SCENE depth
 * attachment (via `context.depthOnlyTextureView`) so we get the depth
 * data "for free" without an extra prepass render. If a future slice
 * needs a separate depth attachment (e.g., for a hardware-accelerated
 * early-Z prepass), it can be added here without breaking existing
 * consumers.
 *
 * @see migration_doc/PHASE_8_SHADER_STRATEGY.md
 * @see migration_doc/WEBGPU_DEBUGGING_LOG.md Batch 80, 85, 86
 * @private
 */
class GBufferFramebuffer {
  constructor() {
    this._width = 0;
    this._height = 0;
    this._texture = null;
    this._textureView = null;
  }

  /**
   * Allocate / resize the normal+roughness texture to match the
   * current viewport. Gated by the caller — `WebGPUContext`'s
   * `updateAndClearFramebuffers` override only invokes this when
   * `frameState.useDeferredLighting === true`. With the flag off,
   * `_texture` stays null and no GPU memory is allocated.
   *
   * @param {WebGPUContext} context
   * @param {BoundingRectangle} viewport
   * @param {boolean} _hdr  Unused — G-buffer is always HALF_FLOAT
   *                         (needed for signed normals without
   *                         octahedral encoding complexity).
   * @param {number} _numSamples  Unused — G-buffer is single-sample;
   *                              MSAA scene depth is resolved to
   *                              `depthOnlyTextureView` before this
   *                              producer reads it.
   */
  update(context, viewport, _hdr, _numSamples) {
    const width = viewport.width | 0;
    const height = viewport.height | 0;
    if (
      this._texture !== null &&
      this._width === width &&
      this._height === height
    ) {
      return;
    }
    if (this._texture !== null) {
      this._texture.destroy();
      this._texture = null;
      this._textureView = null;
    }
    const device = context.device;
    if (!device || width <= 0 || height <= 0) {
      return;
    }

    this._width = width;
    this._height = height;
    this._texture = device.createTexture({
      label: "Phase8a_GBuffer_NormalRoughness",
      size: { width, height },
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
    this._textureView = this._texture.createView({
      label: "Phase8a_GBuffer_NormalRoughness_View",
    });
  }

  /**
   * Clear is handled inside the compute producer (it overwrites every
   * fragment with either a real normal or a (0,0,0,1) sentinel). This
   * method stays for API parity with `SceneFramebuffer.clear` and is
   * a no-op for now; if a future slice needs an explicit pre-pass
   * clear (e.g., for the depth-attachment half), wire it here.
   */
  clear(_context, _passState) {
    // Producer writes every fragment in `GBufferNormalsFromDepth.wgsl`;
    // sky / depth-clear fragments emit a (0,0,0,1) sentinel via the
    // shader's `depth >= 0.99999` early-return. No CPU-side clear
    // command is needed.
  }

  /**
   * The eye-space normal (`.xyz`) + roughness (`.w`) view, ready to
   * bind to compute as a storage texture or to fragment as a sampled
   * texture. Slice 2 producer writes this; Slice 3+ consumers read it.
   *
   * @returns {GPUTextureView | null}
   */
  get normalRoughnessTexture() {
    return this._textureView;
  }

  /**
   * Backwards-compat slot for the probe — used to detect "framebuffer
   * is allocated" without coupling the probe to the raw texture handle.
   * Kept truthy whenever `update()` has run with a non-zero viewport.
   *
   * @returns {boolean}
   */
  get framebuffer() {
    return this._texture !== null;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    if (this._texture !== null) {
      this._texture.destroy();
      this._texture = null;
      this._textureView = null;
    }
    return destroyObject(this);
  }
}

export default GBufferFramebuffer;
