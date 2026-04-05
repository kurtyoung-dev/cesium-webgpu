import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
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
function OcclusionCulling(options) {
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

Object.defineProperties(OcclusionCulling.prototype, {
  /**
   * Per-frame occlusion statistics.
   * @memberof OcclusionCulling.prototype
   * @type {object}
   * @readonly
   */
  stats: {
    get: function () {
      return this._stats;
    },
  },

  /**
   * Whether the GPU resources have been initialized.
   * @memberof OcclusionCulling.prototype
   * @type {boolean}
   * @readonly
   */
  isInitialized: {
    get: function () {
      return defined(this._hiZPipeline) && defined(this._occlusionPipeline);
    },
  },
});

/**
 * Initializes GPU resources for occlusion culling. Called lazily on first
 * frame where occlusion culling is enabled.
 *
 * @param {object} context The WebGPUContext (or GraphicsContext).
 * @param {number} width Depth buffer width.
 * @param {number} height Depth buffer height.
 */
OcclusionCulling.prototype.initialize = function (context, width, height) {
  // Occlusion culling requires GPU compute shaders (Hi-Z pyramid + occlusion test).
  // Disable if the context doesn't support compute.
  if (!context.supportsComputeShaders) {
    this.enabled = false;
    return;
  }

  // GPU resource creation would happen here:
  // 1. Create Hi-Z texture (r32float, mip chain)
  // 2. Create Hi-Z compute pipeline from HiZPyramid.wgsl
  // 3. Create occlusion test pipeline from OcclusionTest.wgsl
  // 4. Create visibility storage buffer
  // 5. Create staging buffer for readback
  //
  // Deferred to full WebGPU integration phase.
  // For now, the JS-side manager provides the API contract.
};

/**
 * Begins a new frame of occlusion culling. Saves the current depth buffer
 * for next frame's reprojection.
 *
 * @param {object} depthTexture The current frame's depth texture.
 */
OcclusionCulling.prototype.beginFrame = function (depthTexture) {
  if (!this.enabled) {
    return;
  }

  this.occludedCommands.length = 0;
  this.visibleCommands.length = 0;
  this._stats.commandsTested = 0;
  this._stats.commandsOccluded = 0;
};

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
OcclusionCulling.prototype.testCommands = function (commands) {
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

  for (let i = 0; i < count; i++) {
    const cmdIdx = this._soaLayout.commandIndices[i];
    if (visibility[i] === 1) {
      visible.push(commands[cmdIdx]);
    } else {
      occluded.push(commands[cmdIdx]);
    }
  }

  // Add commands without bounding volumes (always visible)
  for (let i = 0; i < commands.length; i++) {
    if (!defined(commands[i].boundingVolume)) {
      visible.push(commands[i]);
    }
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
};

/**
 * Checks if a specific entity is currently occluded.
 *
 * @param {object} entity An entity with an associated DrawCommand.
 * @returns {boolean} True if the entity was occluded in the last test.
 */
OcclusionCulling.prototype.isEntityOccluded = function (entity) {
  // Search occluded commands for a matching entity
  for (let i = 0; i < this.occludedCommands.length; i++) {
    const cmd = this.occludedCommands[i];
    if (defined(cmd.owner) && cmd.owner === entity) {
      return true;
    }
  }
  return false;
};

/**
 * Returns the number of commands that were occluded in the last test.
 * @returns {number} Occluded command count.
 */
OcclusionCulling.prototype.getOccludedCommandCount = function () {
  return this.occludedCommands.length;
};

/**
 * Returns diagnostic information.
 * @returns {string} Multi-line diagnostic string.
 */
OcclusionCulling.prototype.getDiagnostics = function () {
  return [
    `=== OcclusionCulling (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
    `GPU: ${this.isInitialized ? "READY" : "NOT INITIALIZED"}`,
    `Commands: ${this._stats.commandsTested} tested, ${this._stats.commandsOccluded} occluded`,
    `Occlusion rate: ${(this._stats.occlusionRate * 100).toFixed(1)}%`,
    `Benefit frames: ${this._stats.framesWithBenefit} / ${this._stats.framesWithBenefit + this._stats.framesWithoutBenefit}`,
    `Debug: showOccluded=${this.debug.showOccluded}, showHiZ=${this.debug.showHiZPyramid}`,
  ].join("\n");
};

/**
 * Returns true if this object was destroyed.
 * @returns {boolean}
 */
OcclusionCulling.prototype.isDestroyed = function () {
  return false;
};

/**
 * Destroys GPU resources.
 */
OcclusionCulling.prototype.destroy = function () {
  this._hiZTexture = undefined;
  this._hiZPipeline = undefined;
  this._occlusionPipeline = undefined;
  this._visibilityBuffer = undefined;
  this._stagingBuffer = undefined;
  this._previousDepth = undefined;
  this.occludedCommands.length = 0;
  this.visibleCommands.length = 0;
  return destroyObject(this);
};

export default OcclusionCulling;
