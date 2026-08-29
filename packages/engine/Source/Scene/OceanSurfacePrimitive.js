import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Frozen from "../Core/Frozen.js";
import GeoidUndulationGrid from "../Core/GeoidUndulationGrid.js";
import JulianDate from "../Core/JulianDate.js";
import Matrix4 from "../Core/Matrix4.js";
import TideModel from "../Core/TideModel.js";
import Transforms from "../Core/Transforms.js";
import VerticalDatum from "../Core/VerticalDatum.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  CELESTIAL_DEFAULT_MOON_INTENSITY,
  CELESTIAL_DEFAULT_ROUGHNESS,
  CELESTIAL_DEFAULT_SUN_INTENSITY,
  resolveCelestialWaterTail,
} from "./CelestialWaterReflection.js";

/**
 * An opt-in GPU FFT spectral ocean surface. A camera-anchored ENU grid patch is
 * displaced by an animated FFT wave field synthesized on the GPU, then shaded
 * with a Fresnel water BRDF and Jacobian foam.
 *
 * WebGPU only: on WebGL no feature renderer resolves and the primitive renders
 * nothing. It is off by default at the facade level, and runs its compute chain
 * only while it is in the scene with <code>show === true</code>.
 *
 * The backend-agnostic scene logic — anchor computation, ENU snapping for
 * world-anchored UVs, vertical-datum and tide offset, sun and parameter
 * packing — runs here, ahead of the backend branch, and the WebGPU renderer
 * consumes the packed <code>_</code>-prefixed fields. Because the datum and
 * tide offset moves the anchor, which the renderer already splits high/low into
 * <code>OceanUniforms.anchorHigh</code> / <code>anchorLow</code>, the relative-
 * to-eye encoding absorbs it and no WGSL changes; a WebGL2 FFT fallback would
 * inherit the offset for free.
 *
 * Vertical datum and tide. Anchoring at
 * <code>scaleToGeodeticSurface(camera)</code> puts the patch at ellipsoidal
 * height 0, while real terrain publishes orthometric heights, so Cesium World
 * Terrain's baked sea sits on the geoid — a disagreement of 101.64 m at the Sri
 * Lanka coast, where the patch floats above the baked sea as a raised water
 * plateau. The anchor is therefore displaced along <code>_a0Up</code> by
 *
 *     h  = geoidUndulation(anchor)          // 0 when the datum is ELLIPSOID
 *        + tideHeight(time, anchor) * tideExaggeration
 *     h' = (h - relativeHeight) * verticalExaggeration + relativeHeight
 *
 * in that order. The exaggeration map is applied last because the ocean lid is
 * itself displaced by it: at exaggeration 3.0 an Indian-coast lid moves from
 * -104 m to -313 m, exactly <code>(h - 0) * 3</code>. Composing the other way
 * leaves the patch behind at high exaggeration.
 *
 * With <code>verticalDatum</code> resolving to ELLIPSOID and the tide term 0,
 * <code>h</code> is exactly 0, and at the default exaggeration (1.0, relative
 * height 0) so is <code>h'</code>, leaving the anchor bit-for-bit where it
 * would be without this feature.
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
 *   1.0 is true scale; above 1 is explicitly stylised.
 * @param {Function} [options.tideCallback] `(positionWC, time) => metres`,
 *   replacing the built-in {@link TideModel}.
 * @param {Globe} [options.globe] Owning globe, read only for its
 *   `terrainProvider` when the datum is `AUTO`.
 * @param {boolean} [options.celestialReflection=false] Whether the water
 *   reflects the sky's light sources through a microfacet lobe instead of
 *   the historical Blinn-Phong highlight. Off writes a zeroed uniform tail
 *   and leaves the shader on its historical branch.
 * @param {number} [options.celestialRoughness=0.06] Base microfacet
 *   roughness of the water at the near patch, clamped to [0.02, 1]. Larger
 *   values spread the glitter path; the shader raises it further with
 *   distance as the wave slope stops being resolvable.
 * @param {number} [options.celestialSunIntensity=1] Multiplier on the
 *   reflected solar disc. Only read while `celestialReflection` is true.
 * @param {number} [options.celestialMoonIntensity=0.35] Multiplier on the
 *   reflected lunar disc, before the illuminated fraction and the night
 *   ramp. An appearance dial, not a photometric ratio.
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
  this._celestialReflection = options.celestialReflection === true;
  this._celestialRoughness =
    options.celestialRoughness ?? CELESTIAL_DEFAULT_ROUGHNESS;
  this._celestialSunIntensity =
    options.celestialSunIntensity ?? CELESTIAL_DEFAULT_SUN_INTENSITY;
  this._celestialMoonIntensity =
    options.celestialMoonIntensity ?? CELESTIAL_DEFAULT_MOON_INTENSITY;
  this._celestialEnable = 0.0;
  this._celestialResolvedRoughness = 0.0;
  this._celestialResolvedSunIntensity = 0.0;
  this._celestialSinAngularRadius = 0.0;
  this._celestialMoonDirection = { x: 0.0, y: 0.0, z: 0.0 };
  this._celestialMoonPhase = 0.0;
  this._celestialResolvedMoonIntensity = 0.0;
  this._celestialMoonSinAngularRadius = 0.0;
  this._paramsDirty = true;

  // Fixed anchor reference (A0) + its ENU basis for world-anchored UVs.
  this._a0 = undefined;
  this._a0East = new Cartesian3();
  this._a0North = new Cartesian3();
  this._a0Up = new Cartesian3();

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
  // Simulation epoch. Undefined means "adopt the first frame's scene time",
  // which gives a freshly enabled ocean a repeatable phase origin instead of
  // whatever offset the clock happens to be at. It is an origin, not a calm:
  // the spectrum is fully developed at phase zero. A caller may pin it — a
  // capture that has to reproduce one surface across two pages does exactly
  // that — and clearing it re-adopts on the next frame.
  this._simulationEpoch = cloneSimulationEpoch(options.simulationEpoch);
}

/**
 * Copy an epoch a caller supplied, so this surface owns it.
 *
 * The obvious things to pin an epoch to are `viewer.clock.currentTime` and
 * `frameState.time`, and the engine rewrites BOTH of those in place rather
 * than replacing them. An epoch holding either reference would advance with the
 * clock, the elapsed time would stay at zero, and the surface would freeze —
 * the same failure the adoption path clones to avoid, arriving through the door
 * marked "pinned". Copying here makes the pin mean what it says.
 *
 * @param {object} [epoch] The caller's instant, or undefined to re-adopt.
 * @returns {object|undefined} An instant this surface owns.
 * @private
 */
function cloneSimulationEpoch(epoch) {
  return defined(epoch) ? JulianDate.clone(epoch) : undefined;
}

/**
 * Seconds of SCENE time elapsed since this surface's simulation epoch.
 *
 * The FFT surface is a simulation, so its phase belongs to the clock the scene
 * is showing, not to how many times the renderer has been called. Driving it
 * from a frame counter divided by an assumed sixty hertz made the surface
 * frame-rate dependent, unpinnable — a paused clock still evolved it — and
 * decoupled from every other time-dependent thing in the scene. It also made
 * any capture that was not frame-locked meaningless, because two pages that
 * had rendered a different number of frames were showing different seas.
 *
 * The epoch is adopted from the first frame that carries a time and then kept,
 * so the returned value starts at zero and advances with the clock: a pinned
 * clock returns the same number every frame and a running one advances at real
 * rate. Adoption clones once; every later frame is a subtraction and allocates
 * nothing.
 *
 * @param {{_simulationEpoch?: object}} primitive The surface, or anything
 *   carrying its epoch field: the law reads and writes nothing else. The field
 *   holds a {@link JulianDate}, typed structurally so the WebGPU renderer's own
 *   view of the surface satisfies it without importing the class, and marked
 *   optional because a surface that has not adopted an epoch yet is the
 *   ordinary first-frame case rather than an error.
 * @param {FrameState} [frameState] The frame state.
 * @returns {number|undefined} Elapsed scene seconds, or <code>undefined</code>
 *   when the frame carries no time — the caller's signal to take its own
 *   fallback rather than to guess an epoch.
 * @private
 */
function resolveOceanSimulationSeconds(primitive, frameState) {
  const now = frameState?.time;
  if (!defined(now)) {
    return undefined;
  }
  let epoch = primitive._simulationEpoch;
  if (!defined(epoch)) {
    epoch = JulianDate.clone(now);
    primitive._simulationEpoch = epoch;
    return 0.0;
  }
  return JulianDate.secondsDifference(now, epoch);
}

/**
 * Resolve the celestial-reflection tail of the ocean uniform buffer.
 *
 * Returns the tail's values in packing order. Every one of them is exactly 0
 * while the feature is off -- not merely small. Nothing the shader reads
 * therefore differs from what it read before the tail existed, and the fragment
 * stays on the historical highlight it has always drawn.
 *
 * The law itself lives in {@link module:CelestialWaterReflection}, shared with
 * the globe's own water-mask ocean, which packs the same eight values into its
 * camera uniform buffer. This function is the FFT surface's adapter onto it:
 * it names which properties carry the controls and supplies the Moon in WORLD
 * coordinates, which is the frame `OceanSurface.wgsl` evaluates in.
 *
 * Extracted from `update` and exported by name so the off contract can be
 * executed by a node spec rather than asserted, without standing up a WebGPU
 * context -- the same split `computeSeaLevelOffset` already makes.
 *
 * @param {OceanSurfacePrimitive} primitive The primitive.
 * @param {FrameState} [frameState] The frame state, read for the Moon's
 *   direction and illuminated fraction. Absent means no Moon.
 * @returns {{enable: number, roughness: number, sunIntensity: number, sinAngularRadius: number, moonDirection: object, moonPhase: number, moonIntensity: number, moonSinAngularRadius: number}}
 *   The packed tail.
 * @private
 */
function resolveCelestialReflection(primitive, frameState) {
  return resolveCelestialWaterTail(
    {
      enabled: primitive._celestialReflection === true,
      roughness: primitive._celestialRoughness,
      sunIntensity: primitive._celestialSunIntensity,
      moonIntensity: primitive._celestialMoonIntensity,
    },
    frameState?.moonDirectionWC,
    frameState?.moonPhaseFraction,
  );
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

  // Compose with scene.verticalExaggeration so the patch tracks the terrain's
  // ocean lid, which that exaggeration displaces.
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
  // Taken after the sea-level offset, so the spherical cap is the sphere the
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

  const celestial = resolveCelestialReflection(this, frameState);
  this._celestialEnable = celestial.enable;
  this._celestialResolvedRoughness = celestial.roughness;
  this._celestialResolvedSunIntensity = celestial.sunIntensity;
  this._celestialSinAngularRadius = celestial.sinAngularRadius;
  this._celestialMoonDirection = celestial.moonDirection;
  this._celestialMoonPhase = celestial.moonPhase;
  this._celestialResolvedMoonIntensity = celestial.moonIntensity;
  this._celestialMoonSinAngularRadius = celestial.moonSinAngularRadius;

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

// Named side exports so node specs can execute three laws without standing up
// a WebGPU context: the composition ORDER of the sea-level offset (geoid ->
// tide*exaggeration -> the vertical exaggeration map), the exact-zero
// off-contract of the celestial-reflection tail, and the simulation clock the
// wave phase advances on. All three are the kind of claim that must be proven
// rather than asserted, and the third is additionally the renderer's own
// dependency — it imports the clock from here rather than carrying a copy.
// `@internal`, not public API.
export {
  cloneSimulationEpoch,
  computeSeaLevelOffset,
  resolveCelestialReflection,
  resolveOceanSimulationSeconds,
};
export default OceanSurfacePrimitive;
