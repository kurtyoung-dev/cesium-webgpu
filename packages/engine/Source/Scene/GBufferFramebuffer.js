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
    this._sampleCount = 1;
    // Single-sample texture (always allocated). Doubles as:
    //   - The compute producer's storage_2d write target.
    //   - AO / SSR / other consumers' sampled-2D read source.
    //   - The MRT-render-pass color attachment when sampleCount === 1.
    //   - The MRT-render-pass resolveTarget when sampleCount > 1.
    this._texture = null;
    this._textureView = null;
    // Multisampled texture (only allocated when sampleCount > 1).
    // Used ONLY as the MRT-render-pass color attachment in MSAA mode.
    // Cannot be bound as storage_2d (WebGPU forbids multisampled
    // storage textures) — that's why we keep the single-sample
    // `_texture` above as the resolve target + producer/consumer
    // backing store.
    this._textureMSAA = null;
    this._textureMSAAView = null;
  }

  /**
   * Allocate / resize the normal+roughness texture to match the
   * current viewport.
   *
   * Slice 5c-B Phase 2 v2 (Batch 115) — supports MSAA via a paired
   * (multisampled, single-sample-resolve) texture allocation. When
   * `numSamples > 1`, both textures are created; the multisampled
   * view is what the MRT render pass binds as its color attachment,
   * and the single-sample view is auto-populated via render-pass
   * resolve at end-of-pass. The compute producer + AO/SSR consumers
   * always operate on the single-sample view, identical to today.
   *
   * When `numSamples === 1`, only the single-sample texture is
   * allocated; the render pass binds it directly with no resolve.
   *
   * @param {WebGPUContext} context
   * @param {BoundingRectangle} viewport
   * @param {boolean} _hdr  Unused — G-buffer is always HALF_FLOAT
   *                         (needed for signed normals without
   *                         octahedral encoding complexity).
   * @param {number} numSamples  Scene-FB MSAA sample count to match.
   *                             1 = no MSAA (single-sample only).
   *                             >1 = paired multisampled +
   *                             single-sample-resolve allocation.
   */
  update(context, viewport, _hdr, numSamples) {
    const width = viewport.width | 0;
    const height = viewport.height | 0;
    const sampleCount = numSamples > 1 ? numSamples : 1;
    if (
      this._texture !== null &&
      this._width === width &&
      this._height === height &&
      this._sampleCount === sampleCount
    ) {
      return;
    }
    if (this._texture !== null) {
      this._texture.destroy();
      this._texture = null;
      this._textureView = null;
    }
    if (this._textureMSAA !== null) {
      this._textureMSAA.destroy();
      this._textureMSAA = null;
      this._textureMSAAView = null;
    }
    const device = context.device;
    if (!device || width <= 0 || height <= 0) {
      return;
    }

    this._width = width;
    this._height = height;
    this._sampleCount = sampleCount;
    // Always allocate the single-sample texture — compute producer and
    // consumers (AO / SSR) read/write this. RENDER_ATTACHMENT lets it
    // serve as resolveTarget (in MSAA mode) OR the direct attachment
    // (in single-sample mode).
    this._texture = device.createTexture({
      label: "Phase8a_GBuffer_NormalRoughness",
      size: { width, height },
      sampleCount: 1,
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        // Phase 2 v2 — required so the scene-FB render pass can bind
        // this either as a direct color attachment (sampleCount=1)
        // or as the resolveTarget of a multisampled attachment (>1).
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._textureView = this._texture.createView({
      label: "Phase8a_GBuffer_NormalRoughness_View",
    });
    // Only allocate the multisampled companion when MSAA is on.
    // Multisampled textures cannot have STORAGE_BINDING — they only
    // serve as render attachments that auto-resolve into `_texture`.
    if (sampleCount > 1) {
      this._textureMSAA = device.createTexture({
        label: `Phase8a_GBuffer_NormalRoughness_MSAA_x${sampleCount}`,
        size: { width, height },
        sampleCount,
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this._textureMSAAView = this._textureMSAA.createView({
        label: `Phase8a_GBuffer_NormalRoughness_MSAA_x${sampleCount}_View`,
      });
    }
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
   * In MSAA mode this is the RESOLVED single-sample view (auto-populated
   * at end of MRT render pass). In single-sample mode this is the same
   * texture the render pass writes to directly.
   *
   * @returns {GPUTextureView | null}
   */
  get normalRoughnessTexture() {
    return this._textureView;
  }

  /**
   * Phase 2 v2 (Batch 115) — view to bind as the MRT render-pass color
   * attachment (slot 1). Returns the multisampled view when MSAA is on;
   * otherwise the single-sample view (identical to `normalRoughnessTexture`).
   * The render pass automatically resolves into `normalRoughnessTexture`
   * at end-of-pass when MSAA is on.
   *
   * @returns {GPUTextureView | null}
   */
  get renderAttachmentView() {
    return this._textureMSAAView ?? this._textureView;
  }

  /**
   * Phase 2 v2 (Batch 115) — resolveTarget view for the MRT render-pass
   * color attachment. Returns the single-sample view when MSAA is on
   * (so the multisampled writes resolve into the storage-bindable
   * texture compute + consumers read). Returns `null` when MSAA is off
   * (no resolve needed; the direct attachment IS the consumer texture).
   *
   * @returns {GPUTextureView | null}
   */
  get resolveTargetView() {
    return this._sampleCount > 1 ? this._textureView : null;
  }

  /**
   * Phase 2 v2 (Batch 115) — current sample count this G-buffer is
   * allocated for. Used by callers building render-pass descriptors
   * to confirm the G-buffer matches the scene-FB sample count.
   *
   * @returns {number}
   */
  get sampleCount() {
    return this._sampleCount;
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
    if (this._textureMSAA !== null) {
      this._textureMSAA.destroy();
      this._textureMSAA = null;
      this._textureMSAAView = null;
    }
    return destroyObject(this);
  }
}

export default GBufferFramebuffer;
