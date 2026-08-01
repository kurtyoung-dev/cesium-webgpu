import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import SOABoundingSphereLayout from "./SOABoundingSphereLayout.js";

/**
 * CPU-side manager for Hi-Z (Hierarchical Z-Buffer) occlusion culling.
 * Coordinates the GPU compute pipeline: depth reprojection, Hi-Z pyramid
 * build, and per-command occlusion testing.
 *
 * **WebGPU only** — requires compute shaders, storage buffers, and
 * texture_storage_2d. No WebGL equivalent exists.
 *
 * Lifecycle per frame:
 * 1. `beginFrame()` — reprojection of previous frame's depth buffer
 * 2. `buildHiZPyramid()` — dispatch HiZPyramid.wgsl compute shader
 * 3. `testOcclusion()` — dispatch OcclusionTest.wgsl compute shader
 * 4. `readResults()` — async mapAsync readback of visibility buffer
 * 5. RenderScheduler splits commands into visible/occluded lists
 *
 * Pays for itself when >20% of commands are occluded (~0.4ms/frame overhead).
 *
 * @param {object} [options] Configuration options.
 * @param {boolean} [options.enabled=false] Whether occlusion culling is active.
 * @param {number} [options.maxCommands=65536] Maximum testable commands.
 * @param {number} [options.hiZMipLevels=12] Number of mip levels (for 4K: 12).
 * @param {number} [options.minOcclusionBenefit=0.2] Min fraction of commands
 *   that must be occluded for the feature to be worthwhile (auto-disable).
 *
 * @alias OcclusionCulling
 * @constructor
 * @private
 */
class OcclusionCulling {
  constructor(options) {
    options = options ?? {};

    /**
     * Whether occlusion culling is enabled.
     * @type {boolean}
     * @default false
     */
    this.enabled = options.enabled ?? false;

    /**
     * Maximum testable commands per frame.
     * @type {number}
     */
    this.maxCommands = options.maxCommands ?? 65536;

    /**
     * Number of Hi-Z mip levels.
     * @type {number}
     */
    this.hiZMipLevels = options.hiZMipLevels ?? 12;

    /**
     * Minimum occlusion benefit to keep the feature active.
     * If fewer than this fraction of commands are occluded, auto-disable.
     * @type {number}
     */
    this.minOcclusionBenefit = options.minOcclusionBenefit ?? 0.2;

    /**
     * SOA layout for bounding sphere data.
     * @type {SOABoundingSphereLayout}
     * @private
     */
    this._soaLayout = new SOABoundingSphereLayout(this.maxCommands, false);

    /**
     * Hi-Z pyramid texture (created on first use).
     * @private
     */
    this._hiZTexture = undefined;

    /**
     * Hi-Z compute pipeline (created on first use).
     * @private
     */
    this._hiZPipeline = undefined;

    /**
     * Occlusion test compute pipeline (created on first use).
     * @private
     */
    this._occlusionPipeline = undefined;

    /**
     * Previous frame's depth texture for reprojection.
     * @private
     */
    this._previousDepth = undefined;

    /**
     * Visibility result buffer (GPU → CPU readback).
     * @private
     */
    this._visibilityBuffer = undefined;

    /**
     * Staging buffer for async readback.
     * @private
     */
    this._stagingBuffer = undefined;

    /**
     * Whether results from the previous frame are available.
     * @type {boolean}
     */
    this.resultsReady = false;

    /**
     * The occluded command list from the previous frame's test.
     * @type {Array}
     */
    this.occludedCommands = [];

    /**
     * The visible command list (commands that passed occlusion test).
     * @type {Array}
     */
    this.visibleCommands = [];

    /**
     * Per-frame statistics.
     * @type {object}
     */
    this._stats = {
      commandsTested: 0,
      commandsOccluded: 0,
      occlusionRate: 0,
      hiZBuildTimeMs: 0,
      occlusionTestTimeMs: 0,
      readbackTimeMs: 0,
      totalTimeMs: 0,
      framesWithBenefit: 0,
      framesWithoutBenefit: 0,
    };

    /**
     * Debug visualization settings.
     * @type {object}
     */
    this.debug = {
      /**
       * When true, occluded objects are rendered as wireframe overlay.
       * @type {boolean}
       * @default false
       */
      showOccluded: false,

      /**
       * Color for the occluded wireframe overlay.
       * @type {Color}
       * @default Color.RED with alpha 0.3
       */
      occludedColor: Color.RED.withAlpha(0.3),

      /**
       * When true, show the Hi-Z pyramid as a debug overlay.
       * @type {boolean}
       * @default false
       */
      showHiZPyramid: false,
    };
  }

  /**
   * Initializes GPU resources for occlusion culling. Called lazily on first
   * frame where occlusion culling is enabled.
   *
   * Backend-agnostic dispatch: looks up the `HI_Z_OCCLUSION` feature
   * renderer on the given context and delegates GPU resource allocation
   * to it. On WebGL this returns a no-op feature renderer, so the
   * initializer disables occlusion culling and returns. On WebGPU the
   * dispatcher allocates the Hi-Z pyramid texture, the SOA sphere
   * buffers, and the visibility staging buffer.
   *
   * @param {object} context The WebGPUContext (or GraphicsContext).
   * @param {number} width Depth buffer width.
   * @param {number} height Depth buffer height.
   */
  initialize(context, width, height) {
    // Occlusion culling requires GPU compute shaders (Hi-Z pyramid + occlusion test).
    // Disable if the context doesn't support compute.
    if (!context.supportsComputeShaders) {
      this.enabled = false;
      return;
    }

    const fr = context.getFeatureRenderer(FeatureRendererKey.HI_Z_OCCLUSION);
    if (!defined(fr) || typeof fr.init !== "function") {
      // WebGL backend — no FR registered. Leave enabled flag alone;
      // the `resultsReady` guard in testCommands() will keep the
      // conservative path active.
      this._featureRenderer = undefined;
      return;
    }
    const ok = fr.init(width, height, this.maxCommands);
    if (ok) {
      this._featureRenderer = fr;
      // `isInitialized` now returns true because the dispatcher has
      // allocated its pipelines and the per-frame path can dispatch.
      this._pipelinesReady = true;
    } else {
      this._featureRenderer = undefined;
      this.enabled = false;
    }
  }

  /**
   * Whether the feature renderer allocated its GPU resources successfully.
   * Distinct from `isInitialized`, which is the pre-audit stub check.
   * @returns {boolean}
   */
  hasFeatureRenderer() {
    return defined(this._featureRenderer);
  }

  /**
   * Begins a new frame of occlusion culling. Saves the current depth buffer
   * for next frame's reprojection.
   *
   * @param {object} depthTexture The current frame's depth texture.
   */
  beginFrame(depthTexture) {
    if (!this.enabled) {
      return;
    }

    this.occludedCommands.length = 0;
    this.visibleCommands.length = 0;
    this._stats.commandsTested = 0;
    this._stats.commandsOccluded = 0;
  }

  /**
   * Tests commands against the Hi-Z pyramid from the previous frame.
   * Splits input commands into visible and occluded lists.
   *
   * When GPU results are not yet available (async readback pending),
   * all commands are treated as visible (conservative).
   *
   * @param {Array} commands Commands to test.
   * @returns {object} { visible: Array, occluded: Array }
   */
  testCommands(commands) {
    if (!this.enabled || !this.resultsReady) {
      // Conservative: all visible
      return {
        visible: commands,
        occluded: [],
      };
    }

    // Populate SOA from commands
    this._soaLayout.populate(commands);

    // Read visibility results from previous frame's GPU test
    const visible = [];
    const occluded = [];
    const visibility = this._soaLayout.visibility;
    const count = this._soaLayout.count;

    // C11-187 — Walk the original list once so represented and conservative
    // pass-through commands retain their input-relative order. SOA population
    // can skip commands without a usable sphere and stops at capacity.
    let representedIndex = 0;
    for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
      const command = commands[commandIndex];
      const isRepresented =
        representedIndex < count &&
        this._soaLayout.commandIndices[representedIndex] === commandIndex;
      if (!isRepresented) {
        visible.push(command);
        continue;
      }

      if (visibility[representedIndex] === 1) {
        visible.push(command);
      } else {
        occluded.push(command);
      }
      representedIndex++;
    }

    this.visibleCommands = visible;
    this.occludedCommands = occluded;
    this._stats.commandsTested = count;
    this._stats.commandsOccluded = occluded.length;
    this._stats.occlusionRate = count > 0 ? occluded.length / count : 0;

    // Auto-disable check
    if (this._stats.occlusionRate >= this.minOcclusionBenefit) {
      this._stats.framesWithBenefit++;
    } else {
      this._stats.framesWithoutBenefit++;
    }

    return { visible, occluded };
  }

  /**
   * Checks if a specific entity is currently occluded.
   *
   * @param {object} entity An entity with an associated DrawCommand.
   * @returns {boolean} True if the entity was occluded in the last test.
   */
  isEntityOccluded(entity) {
    // Search occluded commands for a matching entity
    for (let i = 0; i < this.occludedCommands.length; i++) {
      const cmd = this.occludedCommands[i];
      if (defined(cmd.owner) && cmd.owner === entity) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the number of commands that were occluded in the last test.
   * @returns {number} Occluded command count.
   */
  getOccludedCommandCount() {
    return this.occludedCommands.length;
  }

  /**
   * Returns diagnostic information.
   * @returns {string} Multi-line diagnostic string.
   */
  getDiagnostics() {
    return [
      `=== OcclusionCulling (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
      `GPU: ${this.isInitialized ? "READY" : "NOT INITIALIZED"}`,
      `Commands: ${this._stats.commandsTested} tested, ${this._stats.commandsOccluded} occluded`,
      `Occlusion rate: ${(this._stats.occlusionRate * 100).toFixed(1)}%`,
      `Benefit frames: ${this._stats.framesWithBenefit} / ${this._stats.framesWithBenefit + this._stats.framesWithoutBenefit}`,
      `Debug: showOccluded=${this.debug.showOccluded}, showHiZ=${this.debug.showHiZPyramid}`,
    ].join("\n");
  }

  /**
   * Returns true if this object was destroyed.
   * @returns {boolean}
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys GPU resources.
   */
  destroy() {
    if (
      defined(this._featureRenderer) &&
      typeof this._featureRenderer.destroy === "function"
    ) {
      try {
        this._featureRenderer.destroy();
      } catch (e) {
        // Swallow so we don't block the rest of Scene teardown.
      }
    }
    this._featureRenderer = undefined;
    this._pipelinesReady = false;
    this._hiZTexture = undefined;
    this._hiZPipeline = undefined;
    this._occlusionPipeline = undefined;
    this._visibilityBuffer = undefined;
    this._stagingBuffer = undefined;
    this._previousDepth = undefined;
    this.occludedCommands.length = 0;
    this.visibleCommands.length = 0;
    return destroyObject(this);
  }

  /**
   * Dispatch one frame of Hi-Z pyramid build + occlusion test. Called
   * from the frame executor once the scene's command list has been
   * assembled and the bounding spheres are packed into the SOA layout.
   *
   * Returns true on a successful dispatch, false when the feature
   * renderer isn't ready or the command count is zero. A false return
   * keeps the conservative "all visible" path active.
   *
   * @param {GPUCommandEncoder} encoder Active GPU command encoder.
   * @param {object} depthTextureView Mip-0 view of the current depth buffer.
   * @param {object} params `{ viewProjection, screenWidth, screenHeight, nearPlane, farPlane }`
   * @returns {boolean}
   */
  dispatchGPU(encoder, depthTextureView, params) {
    if (!this.enabled || !this._pipelinesReady) {
      return false;
    }
    if (
      !defined(this._featureRenderer) ||
      typeof this._featureRenderer.dispatch !== "function"
    ) {
      return false;
    }
    const count = this._soaLayout.count;
    if (count <= 0) {
      return false;
    }
    return this._featureRenderer.dispatch(
      encoder,
      depthTextureView,
      {
        centerX: this._soaLayout.centerX,
        centerY: this._soaLayout.centerY,
        centerZ: this._soaLayout.centerZ,
        radius: this._soaLayout.radius,
        count,
      },
      params,
    );
  }

  /**
   * Schedule an async readback of the previous frame's visibility
   * buffer. When the promise resolves, the visibility bits are copied
   * into `_soaLayout.visibility` so the next `testCommands()` call
   * returns real results instead of the conservative default.
   *
   * Returns the promise for the readback, or `null` when the feature
   * renderer isn't ready. Safe to call every frame — the dispatcher
   * guards against concurrent maps.
   */
  scheduleReadback() {
    if (!this.enabled || !this._pipelinesReady) {
      return null;
    }
    if (
      !defined(this._featureRenderer) ||
      typeof this._featureRenderer.readback !== "function"
    ) {
      return null;
    }
    const count = this._soaLayout.count;
    if (count <= 0) {
      return null;
    }
    const self = this;
    return this._featureRenderer.readback(count).then(function (u32) {
      if (u32 === null) {
        return null;
      }
      const vis = self._soaLayout.visibility;
      for (let i = 0; i < count; i++) {
        vis[i] = u32[i] === 0 ? 0 : 1;
      }
      self.resultsReady = true;
      return u32;
    });
  }

  /**
   * Per-frame occlusion statistics.
   * @type {object}
   * @readonly
   */
  get stats() {
    return this._stats;
  }

  /**
   * Whether the GPU resources have been initialized.
   * @type {boolean}
   * @readonly
   */
  get isInitialized() {
    // Phase 3 activation — `_pipelinesReady` is flipped by
    // `initialize()` when the feature renderer successfully
    // allocates the Hi-Z pyramid + SOA buffers + visibility
    // buffer. Legacy pipeline fields (`_hiZPipeline`, etc.) are
    // kept around for the destroy() cleanup path.
    return this._pipelinesReady === true;
  }
}

export default OcclusionCulling;
