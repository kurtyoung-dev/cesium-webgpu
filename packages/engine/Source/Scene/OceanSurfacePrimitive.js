import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Frozen from "../Core/Frozen.js";
import GeoidUndulationGrid from "../Core/GeoidUndulationGrid.js";
import Matrix4 from "../Core/Matrix4.js";
import TideModel from "../Core/TideModel.js";
import Transforms from "../Core/Transforms.js";
import VerticalDatum from "../Core/VerticalDatum.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
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
 * anchored UVs, vertical-datum + tide offset, sun/parameter packing) runs here
 * BEFORE the backend branch; the WebGPU renderer consumes the packed
 * `_`-prefixed fields (scene-logic-extractor pattern, CLAUDE.md). Because the
 * datum/tide offset moves the ANCHOR — which the renderer already splits
 * high/low into `OceanUniforms.anchorHigh/anchorLow` — RTE absorbs it and no
 * WGSL changes; a WebGL2 FFT fallback would inherit the offset for free.
 *
 * VERTICAL DATUM + TIDE (C6-FFT-OCEAN-TIDE-DATUM, rulings T1/T2/T3/T6). The
 * patch used to anchor at `scaleToGeodeticSurface(camera)` — ELLIPSOIDAL height
 * 0 — while real terrain publishes ORTHOMETRIC heights, so Cesium World
 * Terrain's baked sea sits on the geoid. `probe-ocean-datum.mjs` measured the
 * disagreement at 101.64 m at the Sri Lanka coast (patch floating above the
 * baked sea as a raised water plateau). The anchor is now displaced along
 * `_a0Up` by
 *
 *     h  = geoidUndulation(anchor)          // 0 when the datum is ELLIPSOID
 *        + tideHeight(time, anchor) * tideExaggeration
 *     h' = (h - relativeHeight) * verticalExaggeration + relativeHeight
 *
 * in that order. The exaggeration map is applied LAST because the ocean lid is
 * itself displaced by it — measured, Batch 759 lane 3: the India site's lid
 * moves -104 m -> -313 m at exaggeration 3.0, exactly `(h-0)*3`. Composing the
 * other way would leave the patch behind at high exaggeration.
 *
 * OFF-CONTRACT. With `verticalDatum` resolving to ELLIPSOID and the tide term
 * 0, `h` is exactly 0 and — at the default exaggeration (1.0, relative height
 * 0) — `h'` is exactly 0, so the anchor is bit-for-bit what it was before this
 * feature existed.
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
 * @param {string} [options.verticalDatum=VerticalDatum.AUTO] Sea-level datum,
 *   one of {@link VerticalDatum}. `AUTO` derives it from `options.globe`'s
 *   terrain provider.
 * @param {boolean} [options.tideEnabled=true] Whether the tide term is added.
 *   `false` makes it exactly 0.
 * @param {number} [options.tideExaggeration=1] Multiplier on the tide term.
 *   1.0 is true scale (ruling T3); above 1 is explicitly stylised.
 * @param {Function} [options.tideCallback] `(positionWC, time) => metres`,
 *   replacing the built-in {@link TideModel}.
 * @param {Globe} [options.globe] Owning globe, read ONLY for its
 *   `terrainProvider` when the datum is `AUTO`.
 */
function OceanSurfacePrimitive(options) {
  options = options ?? Frozen.EMPTY_OBJECT;

  /**
   * Whether the ocean is drawn.
   * @type {boolean}
   */
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

  // ── Vertical datum + tide (C6-FFT-OCEAN-TIDE-DATUM). ──
  this._verticalDatum = options.verticalDatum ?? VerticalDatum.AUTO;
  this._tideEnabled = options.tideEnabled ?? true;
  this._tideExaggeration = options.tideExaggeration ?? 1.0;
  this._tideCallback = options.tideCallback;
  /** Owning globe; read only for `terrainProvider` under `AUTO`. */
  this._globe = options.globe;
  this._geoidRequested = false;
  // Published per-frame diagnostics — the acceptance probe reads these, and
  // they are the only way to see the split between the two offset terms.
  this._resolvedVerticalDatum = VerticalDatum.ELLIPSOID;
  this._geoidUndulationM = 0.0;
  this._tideHeightM = 0.0;
  this._anchorHeightM = 0.0;

  this._webgpuCache = undefined;
}

const scratchSubpoint = new Cartesian3();
const scratchEnu = new Matrix4();
const scratchDelta = new Cartesian3();
const scratchTmp = new Cartesian3();
const scratchCarto = new Cartographic();

/**
 * Resolve the sea-level offset (metres along the local up) for this frame and
 * publish its components on the primitive.
 *
 * Extracted from `update` so the composition order — geoid, then tide, then
 * the vertical-exaggeration map — is stated once, in one place, and can be
 * pinned by a node spec without standing up a scene.
 *
 * @param {OceanSurfacePrimitive} primitive The primitive.
 * @param {Cartesian3} anchor The un-offset anchor (on the ellipsoid surface).
 * @param {FrameState} frameState The frame state.
 * @param {Ellipsoid} ellipsoid The ellipsoid.
 * @returns {number} Metres to displace the anchor along `_a0Up`. Exactly 0
 *   when both terms are 0 and the exaggeration is identity.
 * @private
 */
function computeSeaLevelOffset(primitive, anchor, frameState, ellipsoid) {
  // ── Datum term ──
  const datum = VerticalDatum.resolve(
    primitive._verticalDatum,
    defined(primitive._globe) ? primitive._globe.terrainProvider : undefined,
  );
  primitive._resolvedVerticalDatum = datum;

  let undulation = 0.0;
  if (datum === VerticalDatum.GEOID) {
    const grid = GeoidUndulationGrid.getEgm2008();
    if (defined(grid)) {
      const carto = ellipsoid.cartesianToCartographic(anchor, scratchCarto);
      if (defined(carto)) {
        undulation = grid.sample(carto.longitude, carto.latitude);
      }
    } else if (!primitive._geoidRequested) {
      // Lazy one-shot fetch of the ~508 KiB bundled grid. Until it lands the
      // undulation stays 0, i.e. the pre-fix behaviour; `GlobeWaterOcean`
      // kicks the same load on enable so the common path never sees it.
      primitive._geoidRequested = true;
      GeoidUndulationGrid.loadEgm2008Async();
    }
  }
  if (!Number.isFinite(undulation)) {
    undulation = 0.0;
  }
  primitive._geoidUndulationM = undulation;

  // ── Tide term ──
  let tide = 0.0;
  if (primitive._tideEnabled === true) {
    const callback = primitive._tideCallback;
    tide = defined(callback)
      ? callback(anchor, frameState.time)
      : TideModel.equilibriumHeight(frameState.time, anchor);
    if (!Number.isFinite(tide)) {
      tide = 0.0;
    }
    const exaggeration = primitive._tideExaggeration;
    tide *= Number.isFinite(exaggeration) ? exaggeration : 1.0;
  }
  primitive._tideHeightM = tide;

  // ── Compose with scene.verticalExaggeration (measured: it DOES displace the
  // terrain's ocean lid, Batch 759 lane 3), so the patch tracks the lid. ──
  let height = undulation + tide;
  let scale = frameState.verticalExaggeration;
  let relative = frameState.verticalExaggerationRelativeHeight;
  scale = Number.isFinite(scale) ? scale : 1.0;
  relative = Number.isFinite(relative) ? relative : 0.0;
  if (height !== 0.0 || scale !== 1.0) {
    height = VerticalExaggeration.getHeight(height, scale, relative);
  }
  if (!Number.isFinite(height)) {
    height = 0.0;
  }
  primitive._anchorHeightM = height;
  return height;
}

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

  // Sea-level datum + tide. Applied along `_a0Up` — the patch's own vertical
  // axis — so the whole cap translates rather than tilting. Evaluated at the
  // UN-offset anchor: displacing along the surface normal does not change the
  // anchor's longitude/latitude, so there is no circularity.
  const seaLevelOffset = computeSeaLevelOffset(
    this,
    this._anchor,
    frameState,
    ellipsoid,
  );
  if (seaLevelOffset !== 0.0) {
    Cartesian3.multiplyByScalar(this._a0Up, seaLevelOffset, scratchTmp);
    Cartesian3.add(this._anchor, scratchTmp, this._anchor);
  }

  Cartesian3.clone(this._a0East, this._east);
  Cartesian3.clone(this._a0North, this._north);
  Cartesian3.clone(this._a0Up, this._up);

  // Local curvature radius from the geodetic surface radius at the anchor.
  // Taken AFTER the sea-level offset so the spherical cap is the sphere the
  // patch actually sits on.
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

// Named side export so `Tools/visual-regression/ocean-tide-datum.spec.mjs` can
// pin the composition ORDER (geoid -> tide*exaggeration -> the vertical
// exaggeration map) and the exact-zero off-contract without standing up a
// WebGPU context. The off-contract claim is the kind that must be proven, not
// asserted; `@internal`, not public API.
export { computeSeaLevelOffset };
export default OceanSurfacePrimitive;
