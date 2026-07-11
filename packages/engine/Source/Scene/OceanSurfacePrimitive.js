import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Frozen from "../Core/Frozen.js";
import Matrix4 from "../Core/Matrix4.js";
import Transforms from "../Core/Transforms.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

/**
 * OceanSurfacePrimitive — opt-in GPU FFT spectral ocean surface (Campaign 6/7,
 * C6-FFT-OCEAN). A camera-anchored ENU grid patch is displaced by an animated
 * FFT wave field synthesized on the GPU and shaded with a Fresnel water BRDF +
 * Jacobian foam.
 *
 * WebGPU-only: on WebGL no feature renderer resolves and the primitive renders
 * nothing (documented no-op, Principle 2/10). Default-off at the facade level;
 * this primitive only runs its compute chain while added to the scene and
 * `show === true`.
 *
 * Backend-agnostic scene logic (anchor computation, ENU snapping for world-
 * anchored UVs, sun/parameter packing) runs here BEFORE the backend branch; the
 * WebGPU renderer consumes the packed `_`-prefixed fields (scene-logic-extractor
 * pattern, CLAUDE.md).
 *
 * @alias OceanSurfacePrimitive
 * @constructor
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.show=true] Whether the ocean is drawn.
 * @param {number} [options.patchLength=250] FFT tile length L (meters).
 * @param {number} [options.patchExtent=3000] Rendered patch half-... full extent (meters).
 * @param {number} [options.windSpeed=12] Wind speed U (m/s) — sea maturity.
 * @param {number} [options.windDirection=0] Wind direction (radians, 0 = +east).
 * @param {number} [options.amplitude=4] Phillips spectrum amplitude constant.
 * @param {number} [options.choppiness=1] Horizontal displacement scale (lambda).
 * @param {number} [options.heightScale=1] Vertical displacement gain.
 * @param {Color} [options.deepColor] Deep-water base color.
 * @param {Color} [options.shallowColor] Sky/shallow tint color.
 */
function OceanSurfacePrimitive(options) {
  options = options ?? Frozen.EMPTY_OBJECT;

  /** @type {boolean} Whether the ocean is drawn. */
  this.show = options.show ?? true;

  // ── Renderer-consumed packed fields (scene-logic-extractor outputs). ──
  this._enabled = true;
  this._resolutionN = 256;
  this._patchLength = options.patchLength ?? 250.0;
  this._patchExtent = options.patchExtent ?? 3000.0;
  this._gravity = 9.81;
  const windDir = options.windDirection ?? 0.0;
  this._windDirX = Math.cos(windDir);
  this._windDirZ = Math.sin(windDir);
  this._windSpeed = options.windSpeed ?? 12.0;
  this._amplitude = options.amplitude ?? 1.0;
  this._smallWave = 1.0;
  this._dirDamp = 0.15;
  this._choppiness = options.choppiness ?? 1.0;
  this._heightScale = options.heightScale ?? 1.0;
  this._foamThreshold = 0.6;
  this._foamScale = 1.2;
  this._foamStrength = 1.0;
  this._detailScale = 2.0;
  this._timeSpeed = options.timeSpeed ?? 1.0;

  const deep = options.deepColor ?? new Color(0.02, 0.08, 0.13, 1.0);
  this._deepColor = { x: deep.red, y: deep.green, z: deep.blue };
  const shallow = options.shallowColor ?? new Color(0.05, 0.22, 0.32, 1.0);
  this._shallowColor = { x: shallow.red, y: shallow.green, z: shallow.blue };

  // Per-frame anchor state.
  this._anchor = new Cartesian3();
  this._east = new Cartesian3();
  this._north = new Cartesian3();
  this._up = new Cartesian3();
  this._uvOffsetX = 0.0;
  this._uvOffsetY = 0.0;
  this._sunDirection = new Cartesian3(0.0, 0.0, 1.0);
  this._invRadius = 1.0 / 6371000.0;
  this._paramsDirty = true;

  // Fixed anchor reference (A0) + its ENU basis for world-anchored UVs.
  this._a0 = undefined;
  this._a0East = new Cartesian3();
  this._a0North = new Cartesian3();
  this._a0Up = new Cartesian3();

  this._webgpuCache = undefined;
}

const scratchSubpoint = new Cartesian3();
const scratchEnu = new Matrix4();
const scratchDelta = new Cartesian3();
const scratchTmp = new Cartesian3();

/**
 * Called each frame by the scene's primitive collection. Computes the RTE
 * anchor + ENU frame + world-anchored UV offset, then dispatches to the WebGPU
 * feature renderer.
 * @param {FrameState} frameState The frame state.
 */
OceanSurfacePrimitive.prototype.update = function (frameState) {
  if (!this.show) {
    return;
  }
  const context = frameState.context;
  if (!defined(context) || !context.isWebGPU) {
    return; // WebGPU-only; no-op on WebGL.
  }
  this._lastContext = context;

  const ellipsoid = Ellipsoid.WGS84;
  const cameraPos = frameState.camera.positionWC;
  // Sea-level point under the camera (height 0 datum).
  const subpoint = ellipsoid.scaleToGeodeticSurface(cameraPos, scratchSubpoint);
  if (!defined(subpoint)) {
    return; // camera at the center — nothing to anchor.
  }

  // Establish (or reset) the fixed anchor reference A0 + its ENU basis.
  const patchExtent = this._patchExtent;
  if (!defined(this._a0)) {
    this._a0 = Cartesian3.clone(subpoint, new Cartesian3());
    Transforms.eastNorthUpToFixedFrame(this._a0, ellipsoid, scratchEnu);
    Matrix4.getColumn(scratchEnu, 0, this._a0East);
    Matrix4.getColumn(scratchEnu, 1, this._a0North);
    Matrix4.getColumn(scratchEnu, 2, this._a0Up);
    Cartesian3.normalize(this._a0East, this._a0East);
    Cartesian3.normalize(this._a0North, this._a0North);
    Cartesian3.normalize(this._a0Up, this._a0Up);
  }

  // Offset of the current subpoint from A0, projected onto A0's ENU plane.
  Cartesian3.subtract(subpoint, this._a0, scratchDelta);
  const offE = Cartesian3.dot(scratchDelta, this._a0East);
  const offN = Cartesian3.dot(scratchDelta, this._a0North);
  // If the camera has flown far past the patch, rebase A0.
  if (
    Math.abs(offE) > patchExtent * 4.0 ||
    Math.abs(offN) > patchExtent * 4.0
  ) {
    this._a0 = undefined;
    return; // rebase next frame with the fresh reference.
  }

  const L = this._patchLength;
  const snapE = Math.round(offE / L) * L;
  const snapN = Math.round(offN / L) * L;
  // anchor = A0 + east*snapE + north*snapN (snapped to the wave lattice).
  Cartesian3.multiplyByScalar(this._a0East, snapE, scratchTmp);
  Cartesian3.add(this._a0, scratchTmp, this._anchor);
  Cartesian3.multiplyByScalar(this._a0North, snapN, scratchTmp);
  Cartesian3.add(this._anchor, scratchTmp, this._anchor);
  // Integer UV offset keeps waves world-locked (no swimming on rebase).
  this._uvOffsetX = snapE / L;
  this._uvOffsetY = snapN / L;

  Cartesian3.clone(this._a0East, this._east);
  Cartesian3.clone(this._a0North, this._north);
  Cartesian3.clone(this._a0Up, this._up);

  // Local curvature radius from the geodetic surface radius at the anchor.
  const anchorMag = Cartesian3.magnitude(this._anchor);
  this._invRadius = anchorMag > 1.0 ? 1.0 / anchorMag : 1.0 / 6371000.0;

  // Sun direction (world). Fall back to a high-east sun for a lively specular.
  const us = context.uniformState;
  const sunWC =
    defined(us) && defined(us.sunDirectionWC) ? us.sunDirectionWC : undefined;
  if (defined(sunWC) && Cartesian3.magnitude(sunWC) > 0.5) {
    Cartesian3.clone(sunWC, this._sunDirection);
  } else {
    Cartesian3.multiplyByScalar(this._a0Up, 1.0, this._sunDirection);
    Cartesian3.multiplyByScalar(this._a0East, 0.4, scratchTmp);
    Cartesian3.add(this._sunDirection, scratchTmp, this._sunDirection);
    Cartesian3.normalize(this._sunDirection, this._sunDirection);
  }

  const fr = context.getFeatureRenderer(FeatureRendererKey.FFT_OCEAN);
  if (defined(fr)) {
    fr.update(this, frameState);
  }
};

/**
 * @returns {boolean} true (this object was destroyed).
 */
OceanSurfacePrimitive.prototype.isDestroyed = function () {
  return false;
};

/**
 * Frees GPU resources owned by the ocean feature renderer.
 */
OceanSurfacePrimitive.prototype.destroy = function () {
  if (defined(this._webgpuCache)) {
    const fr =
      defined(this._lastContext) && this._lastContext.isWebGPU
        ? this._lastContext.getFeatureRenderer(FeatureRendererKey.FFT_OCEAN)
        : undefined;
    if (defined(fr) && defined(fr.destroy)) {
      fr.destroy(this);
    }
  }
  return destroyObject(this);
};

export default OceanSurfacePrimitive;
