import destroyObject from "../Core/destroyObject.js";

/**
 * Owns the WebGPU normal-and-roughness G-buffer attachments.
 *
 * The single-sample `rgba16float` texture stores
 * `(normalEye.xyz, roughness)`. `WebGPUContext` updates it on every non-pick
 * frame; consumer demand does not currently gate allocation or scene-
 * framebuffer MRT topology. Scene passes bind it directly at one sample or use
 * it as the resolve target for a multisampled companion. Compute fallback
 * producers can bind it as storage, and post-process consumers sample it.
 *
 * The multisampled companion is a render attachment only because WebGPU does
 * not permit multisampled storage textures.
 *
 * The G-buffer has no separate depth texture. A depth-derived producer reads
 * the scene framebuffer's sampleable depth view, which avoids another prepass
 * and keeps reconstruction aligned with the depth used to render the scene.
 *
 * @private
 */
class GBufferFramebuffer {
  constructor() {
    this._width = 0;
    this._height = 0;
    this._sampleCount = 1;
    // The single-sample texture is the compute storage target, the sampled
    // consumer view, the direct MRT attachment at one sample, and the resolve
    // target when multisampling is enabled.
    this._texture = null;
    this._textureView = null;
    // The multisampled companion exists only for the MRT color attachment.
    // WebGPU forbids multisampled storage textures, so it resolves into the
    // single-sample producer/consumer texture.
    this._textureMSAA = null;
    this._textureMSAAView = null;
  }

  /**
   * Allocates or resizes the normal-and-roughness attachments to match the
   * viewport and effective scene-framebuffer sample count.
   *
   * With multisampling, the MRT render pass writes the multisampled companion
   * and resolves into the single-sample texture. Compute producers and sampled
   * consumers always use the single-sample view. Without multisampling, the
   * render pass binds the single-sample texture directly.
   *
   * @param {WebGPUContext} context The context whose device owns the textures.
   * @param {BoundingRectangle} viewport The allocation dimensions.
   * @param {boolean} _hdr Unused; the G-buffer always uses `rgba16float`.
   * @param {number} numSamples The effective scene-framebuffer sample count;
   *        values less than two select the single-sample layout.
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
    // A valid update always allocates the single-sample texture. It is the
    // multisample resolve target or the direct attachment, and remains
    // storage- and texture-bindable for producers and consumers.
    this._texture = device.createTexture({
      label: "Phase8a_GBuffer_NormalRoughness",
      size: { width, height },
      sampleCount: 1,
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        // The scene-framebuffer render pass binds this directly at one sample
        // or as the resolve target of the multisampled companion.
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
   * Leaves clearing to the active producer path.
   *
   * The MRT render pass clears the attachment to `(0,0,0,1)`. The compute
   * fallback writes every pixel as either a normal or the same sentinel. This
   * method remains a no-op for API parity with `SceneFramebuffer.clear`.
   */
  clear(_context, _passState) {
    // The render pass or full-screen compute producer initializes every texel
    // before consumers read it.
  }

  /**
   * Returns the single-sample normal-and-roughness view used for storage writes
   * and sampled reads. In multisample mode, the render pass resolves into this
   * view; at one sample it is the direct color attachment.
   *
   * @returns {GPUTextureView | null} The allocated view, or `null` before a
   *          successful update.
   */
  get normalRoughnessTexture() {
    return this._textureView;
  }

  /**
   * Returns the MRT color-attachment view. This is the multisampled companion
   * when MSAA is active and otherwise the single-sample texture.
   *
   * @returns {GPUTextureView | null} The current attachment view, or `null`
   *          before allocation.
   */
  get renderAttachmentView() {
    return this._textureMSAAView ?? this._textureView;
  }

  /**
   * Returns the single-sample MRT resolve target when MSAA is active. At one
   * sample, the render pass writes the consumer texture directly and no resolve
   * target is needed.
   *
   * @returns {GPUTextureView | null} The resolve view, or `null` when no resolve
   *          is required.
   */
  get resolveTargetView() {
    return this._sampleCount > 1 ? this._textureView : null;
  }

  /**
   * Returns the effective sample count used by the G-buffer attachments.
   *
   * @returns {number} The current sample count.
   */
  get sampleCount() {
    return this._sampleCount;
  }

  /**
   * Returns whether the single-sample G-buffer texture is allocated.
   *
   * @returns {boolean} `true` after a successful update.
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
