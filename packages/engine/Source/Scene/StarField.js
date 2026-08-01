import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  computeAtmosphereExtinctionCached,
  createAtmosphereExtinctionCache,
} from "./computeAtmosphereExtinction.js";
import SceneMode from "./SceneMode.js";
import {
  computeStarBrightnessModulation,
  computeStarDayFade,
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
} from "./StarFieldMath.js";

/**
 * A real bright-star catalog starfield (Track V-C, NEW-STARS-BRIGHT-CATALOG).
 *
 * Renders the brightest stars from the Yale Bright Star Catalog
 * ({@link BrightStarCatalog}) as HDR point sprites placed at their actual
 * J2000 right-ascension / declination, sized + colored by visual
 * magnitude (Pogson scale) and B−V color index. On WebGPU the points are
 * drawn additively into the scene framebuffer so the existing bloom
 * post-process makes the brightest stars glow — augmenting the static
 * {@link SkyBox} star cubemap with physically-placed, time-correct stars.
 *
 * This object is backend-agnostic: it owns no GPU resources and never
 * imports from `Renderer/WebGPU/`. All backend-specific work happens in
 * the {@link FeatureRendererKey.STAR_FIELD} feature renderer, accessed
 * through the {@link GraphicsContext} — `WebGPUStarFieldRenderer` (WGSL)
 * on WebGPU and `WebGLStarFieldRenderer` (GLSL) on WebGL, both consuming
 * the same backend-neutral catalog + math (`Scene/StarFieldMath`). On a
 * backend with no STAR_FIELD renderer registered, `update` is a no-op and
 * the static SkyBox cubemap stars remain the only starfield.
 *
 * Typically not constructed directly — {@link SkyBox} owns a StarField
 * instance and drives its update. Toggle via `scene.skyBox.starField.show`.
 *
 * @alias StarField
 * @constructor
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Whether the starfield is drawn.
 * @param {number} [options.intensity=1.0] Global brightness multiplier
 *   applied on top of each star's Pogson intensity.
 *
 * @see SkyBox
 * @see BrightStarCatalog
 * @private
 */
class StarField {
  constructor(options) {
    options = options ?? {};

    /**
     * Determines if the starfield will be shown.
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    // Global intensity multiplier (folded into the per-frame uniform with
    // the daytime fade by the feature renderer).
    this._intensity = options.intensity ?? 1.0;

    // Angular radius of a BASE star point sprite, in radians. 0.0030 rad
    // (~0.172°) — just enough quad to hold the C12-05 PSF core (σ = 0.12
    // of the base quad ≈ 0.6 px at 1920×1080) plus its edge AA window;
    // stars are unresolved point sources, so the core never needs more.
    // Bright stars do NOT get a bigger core: the per-star sizeBoost packed
    // in the instance buffer grows the QUAD as glare-halo extent (C12-06),
    // capped so the total glare diameter stays ≤ 1° — see the derivation
    // in StarFieldMath.buildStarInstanceData, whose MAX_QUAD_SCALE bakes
    // in 2× this value (starfield-psf.spec.mjs cross-checks the pair).
    this._pointAngularSize = 0.003;

    // Floor on the NDC half-extent so faint stars never collapse to a
    // sub-pixel that flickers under MSAA. 0.0022 ≈ a 1.7 px diameter on a
    // 768-tall frame.
    this._minPointSize = 0.0022;

    // Lazily-allocated per-backend resource cache (WebGPU feature renderer
    // stashes its GPU buffers here; the WebGL renderer uses `_webglCache`).
    // Never read by this class directly.
    this._webgpuCache = undefined;

    // Backend-neutral effective scale for the current render update. Keeping
    // this on the primitive lets both renderers consume the exact same daytime
    // gate without repeating the camera/sun calculation.
    this._effectiveIntensityScale = 0.0;
    this._atmosphereExtinctionCache = createAtmosphereExtinctionCache();

    // C7-SUN-STARS-EXTINCTION debug mirror of the per-frame zenith
    // transmittance (undefined when the effect is disabled). Read by the
    // acceptance probe; the renderers use frameState.starZenithTransmittance.
    this._zenithTransmittance = undefined;
    this._zenithTransmittanceStorage = undefined;
    this._frameStateZenithTransmittanceStorage = undefined;
  }

  /**
   * Gets or sets the global brightness multiplier applied on top of each
   * star's Pogson intensity. 1.0 is the catalog-calibrated default.
   * @type {number}
   * @default 1.0
   */
  get intensity() {
    return this._intensity;
  }

  set intensity(value) {
    this._intensity = value;
  }

  /**
   * Called when the scene renders to produce the starfield's draw command.
   * Delegates entirely to the {@link FeatureRendererKey.STAR_FIELD}
   * feature renderer; a no-op on backends that don't register one.
   *
   * Returns the backend draw command (or undefined). The caller routes it
   * to `environmentState.starFieldCommand` so it can be injected/executed
   * AFTER the SkyBox cubemap — the catalog augments (draws on top of) the
   * cubemap rather than being overwritten by its alpha-over pass.
   *
   * Both feature renderers return exactly one reusable environment command.
   * WebGL executes it directly through `EnvironmentRenderer`; WebGPU injects
   * it through `SceneRenderer`. `EnvironmentFrustumDemand` observes this
   * returned command, so WebGPU sky-only views do not need a second binned
   * copy in `frameState.commandList`.
   *
   * @param {FrameState} frameState
   * @returns {object|undefined} The backend draw command, or undefined.
   * @private
   */
  update(frameState) {
    this._effectiveIntensityScale = 0.0;
    const { mode, passes } = frameState;
    // Stars are only meaningful in 3D / morph (like SkyBox). 2D / Columbus
    // View have no celestial sphere.
    if (
      !this.show ||
      (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) ||
      !passes.render
    ) {
      clearPublishedStarExtinction(this, frameState);
      return undefined;
    }

    const context = frameState.context;
    const dayFade = computeStarDayFade(
      context?.uniformState?.sunDirectionWC,
      frameState.camera?.positionWC,
      frameState.camera?.positionCartographic?.height,
    );
    // C12-29 S6 / ruling E3 — ONE reveal law for both star paths.
    //
    // The sprites' own gate (`computeStarDayFade`) is purely geometric: it
    // returns exactly 0 once the sun is ~2.9 deg above the local horizon. That
    // is right for an ordinary day and WRONG during a total eclipse, where the
    // sun is up but its light is gone — a totality frame would have shown the
    // revealed star CUBEMAP with none of the catalogue sprites on top of it.
    //
    // When enabled, the shared modulation REPLACES the legacy geometric fade:
    // both cubemap and catalogue then react identically to daylight, lunar sky
    // brightness, eclipse dimming, and the ellipsoidal-height column ramp.
    // Multiplying by the old fade would double-dim twilight; taking a maximum
    // would leave catalogue sprites at full strength under a full moon while
    // the cubemap falls to ~1.8%. Replacement is the only one-law result.
    //
    // Gated on the same two conditions as the cubemap consumer, so the
    // `enableStarBrightnessModulation = false` position leaves this line
    // returning `dayFade` unchanged — bit-for-bit the historical value.
    const ac = frameState.atmosphericConditions;
    const skyLeaf =
      defined(ac) && defined(ac.skyAtmosphere) ? ac.skyAtmosphere : undefined;
    let reveal = dayFade;
    if (
      defined(skyLeaf) &&
      skyLeaf.enableStarBrightnessModulation === true &&
      frameState.skyAtmosphereVisible === true
    ) {
      const curve = skyLeaf.starModulationCurve;
      const modulation = computeStarBrightnessModulation(
        frameState.skyBrightness ?? 1.0,
        defined(curve) ? curve.inflection : STAR_MODULATION_INFLECTION,
        defined(curve) ? curve.steepness : STAR_MODULATION_STEEPNESS,
      );
      reveal = modulation;
    }
    const effectiveIntensityScale = this._intensity * reveal;
    this._effectiveIntensityScale = effectiveIntensityScale;
    const zeroContribution = effectiveIntensityScale === 0.0;

    // C7-SUN-STARS-EXTINCTION — publish the ZENITH atmospheric transmittance
    // so the backend starfield renderers can extinguish stars per direction.
    // The star extinction is an analytic Bouguer model (see StarFieldVS /
    // StarField.wgsl): each star's slant transmittance is
    // `zenithTransmittance^airmass(elevation)`, so one zenith ray drives the
    // whole field. Gated on the sky atmosphere actually being rendered; the
    // physics returns exactly Cartesian3.ONE from orbit (the zenith ray never
    // crosses the shell), so from-orbit / atmosphere-hidden stays byte-
    // identical (pow(1, x) === 1). This shared helper is the SAME integrator
    // the Moon (B629) and Sun use, keeping all three consistent.
    if (!zeroContribution) {
      // `FrameState.mapProjection` is the backend-neutral owner Scene already
      // publishes for the active ellipsoid. The extinction helper remains a
      // scalar-sphere approximation, but its sphere now follows custom scenes
      // instead of silently retaining WGS84's maximum radius.
      const extinctionEllipsoid =
        frameState.mapProjection?.ellipsoid ?? Ellipsoid.default;
      const camPos = defined(frameState.camera)
        ? frameState.camera.positionWC
        : undefined;
      const extinctionEnabled =
        frameState.skyAtmosphereVisible === true &&
        defined(frameState.atmosphere) &&
        defined(camPos);
      let hasZenithBody = false;
      if (extinctionEnabled) {
        const camLen = Cartesian3.magnitude(camPos);
        if (camLen > 1.0) {
          // Synthesize a far "body" straight up (local zenith) so the shared
          // integrator returns the vertical-column transmittance.
          Cartesian3.divideByScalar(camPos, camLen, scratchZenithDir);
          Cartesian3.multiplyByScalar(
            scratchZenithDir,
            1.0e9,
            scratchZenithBody,
          );
          Cartesian3.add(camPos, scratchZenithBody, scratchZenithBody);
          hasZenithBody = true;
        }
      }
      const t = computeAtmosphereExtinctionCached(
        this._atmosphereExtinctionCache,
        scratchZenithT,
        extinctionEnabled && hasZenithBody,
        camPos,
        hasZenithBody ? scratchZenithBody : undefined,
        frameState.atmosphere,
        extinctionEllipsoid.maximumRadius,
      );
      if (extinctionEnabled && hasZenithBody) {
        if (!defined(this._frameStateZenithTransmittanceStorage)) {
          this._frameStateZenithTransmittanceStorage = new Cartesian3();
        }
        if (!defined(this._zenithTransmittanceStorage)) {
          this._zenithTransmittanceStorage = new Cartesian3();
        }
        Cartesian3.clone(t, this._frameStateZenithTransmittanceStorage);
        Cartesian3.clone(t, this._zenithTransmittanceStorage);
        frameState.starZenithTransmittance =
          this._frameStateZenithTransmittanceStorage;
        // Debug mirror (read by probe-sun-stars-extinction). Not consumed by
        // the renderers — they read frameState.starZenithTransmittance.
        this._zenithTransmittance = this._zenithTransmittanceStorage;
      } else {
        clearPublishedStarExtinction(this, frameState);
      }
    } else {
      clearPublishedStarExtinction(this, frameState);
    }

    if (!defined(context) || typeof context.getFeatureRenderer !== "function") {
      return undefined;
    }
    const fr = context.getFeatureRenderer(FeatureRendererKey.STAR_FIELD);
    if (zeroContribution) {
      if (defined(fr) && typeof fr.prepare === "function") {
        fr.prepare(this, frameState);
      }
      return undefined;
    }
    if (defined(fr) && typeof fr.update === "function") {
      return fr.update(this, frameState);
    }
    return undefined;
  }

  /**
   * Returns a backend diagnostic snapshot, or null when the starfield has
   * not yet rendered on a backend that exposes statistics.
   * @returns {object|null}
   * @private
   */
  getDebugStatistics(frameState) {
    const context = frameState && frameState.context;
    if (!defined(context) || typeof context.getFeatureRenderer !== "function") {
      return null;
    }
    const fr = context.getFeatureRenderer(FeatureRendererKey.STAR_FIELD);
    if (defined(fr) && typeof fr.getStatistics === "function") {
      return fr.getStatistics(this);
    }
    return null;
  }

  /**
   * @returns {boolean} true if this object was destroyed.
   */
  isDestroyed() {
    return false;
  }

  /**
   * Releases backend GPU resources held by the feature renderer for this
   * starfield, then marks the object destroyed.
   */
  destroy() {
    const cache = this._webgpuCache;
    if (defined(cache)) {
      // The feature renderer owns the GPU buffers; ask it to free them via
      // the context if one is reachable. When no context is reachable
      // (already torn down), the GPUDevice destroy reclaims them.
      // SkyBox.destroy() forwards a context-bearing destroy when possible.
      this._webgpuCache = undefined;
    }
    return destroyObject(this);
  }
}

function clearPublishedStarExtinction(starField, frameState) {
  frameState.starZenithTransmittance = undefined;
  starField._zenithTransmittance = undefined;
}

// C7-SUN-STARS-EXTINCTION scratch — zenith direction, synthesized far body,
// and the resulting per-channel zenith transmittance.
const scratchZenithDir = new Cartesian3();
const scratchZenithBody = new Cartesian3();
const scratchZenithT = new Cartesian3();

export default StarField;
