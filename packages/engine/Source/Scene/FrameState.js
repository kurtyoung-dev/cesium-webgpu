import CelestialEphemerisProvider from "../Core/CelestialEphemerisProvider.js";
import Check from "../Core/Check.js";
import DeveloperError from "../Core/DeveloperError.js";
import JulianDate from "../Core/JulianDate.js";
import RuntimeError from "../Core/RuntimeError.js";
import SceneMode from "./SceneMode.js";

function validateEphemerisDeclaration(
  id,
  revision,
  provenance,
  timePolicy,
  outputAllocationStable,
  thirdPartyTemporaryFree,
) {
  if (typeof id !== "string" || id.length === 0) {
    throw new RuntimeError("The ephemeris provider has an invalid id.");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RuntimeError("The ephemeris provider has an invalid revision.");
  }
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    timePolicy === null ||
    typeof timePolicy !== "object" ||
    !Object.isFrozen(provenance) ||
    !Object.isFrozen(timePolicy)
  ) {
    throw new RuntimeError(
      "The ephemeris provider must publish frozen provenance and a frozen time policy.",
    );
  }
  if (
    typeof outputAllocationStable !== "boolean" ||
    typeof thirdPartyTemporaryFree !== "boolean"
  ) {
    throw new RuntimeError(
      "The ephemeris provider must publish its allocation declarations.",
    );
  }
}

function isFiniteCartesian3(value) {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

/**
 * State information about the current frame.  An instance of this class
 * is provided to update functions.
 *
 * @alias FrameState
 * @private
 */
class FrameState {
  /**
   * @param {Context} context The rendering context
   * @param {CreditDisplay} creditDisplay Handles adding and removing credits from an HTML element
   * @param {JobScheduler} jobScheduler The job scheduler
   */
  constructor(context, creditDisplay, jobScheduler) {
    /**
     * The rendering context.
     *
     * @type {Context}
     */
    this.context = context;

    /**
     * Alias for context as a GraphicsContext instance.
     * Provides access to the full backend-agnostic API including
     * context-aware logging, feature renderer registry, and type queries.
     * Available per the hackathon branch pattern of exposing context via FrameState.
     *
     * @type {GraphicsContext}
     */
    this.graphicsContext = context;

    /**
     * An array of rendering commands.
     *
     * @type {DrawCommand[]}
     */
    this.commandList = [];

    /**
     * An array of panorama rendering commands.
     *
     * @type {DrawCommand[]}
     */
    this.panoramaCommandList = [];

    /**
     * An array of shadow maps.
     * @type {ShadowMap[]}
     */
    this.shadowMaps = [];

    /**
     * The BRDF look up texture generator used for image-based lighting for PBR models
     * @type {BrdfLutGenerator}
     */
    this.brdfLutGenerator = undefined;

    /**
     * The environment map used for image-based lighting for PBR models
     * @type {CubeMap}
     */
    this.environmentMap = undefined;

    /**
     * The spherical harmonic coefficients used for image-based lighting for PBR models.
     * @type {Cartesian3[]}
     */
    this.sphericalHarmonicCoefficients = undefined;

    /**
     * The specular environment atlas used for image-based lighting for PBR models.
     * @type {Texture}
     */
    this.specularEnvironmentMaps = undefined;

    /**
     * The maximum level-of-detail of the specular environment atlas used for image-based lighting for PBR models.
     * @type {number}
     */
    this.specularEnvironmentMapsMaximumLOD = undefined;

    /**
     * The current mode of the scene.
     *
     * @type {SceneMode}
     * @default {@link SceneMode.SCENE3D}
     */
    this.mode = SceneMode.SCENE3D;

    /**
     * The current morph transition time between 2D/Columbus View and 3D,
     * with 0.0 being 2D or Columbus View and 1.0 being 3D.
     *
     * @type {number}
     */
    this.morphTime = SceneMode.getMorphTime(SceneMode.SCENE3D);

    /**
     * The current frame number.
     *
     * @type {number}
     * @default 0
     */
    this.frameNumber = 0;

    /**
     * <code>true</code> if a new frame has been issued and the frame number has been updated.
     *
     * @type {boolean}
     * @default false
     */
    this.newFrame = false;

    /**
     * The scene's current time.
     *
     * @type {JulianDate}
     * @default undefined
     */
    this.time = undefined;

    // One branded, caller-owned sample is retained for the lifetime of this
    // FrameState. Scene publishes it only after a complete synchronous
    // provider evaluation. Consumers copy from its stable Cartesian slots and
    // never own a second ephemeris cache.
    this._celestialEphemerisSample = CelestialEphemerisProvider.createSample();
    this._celestialEphemerisSampleIdentity = this._celestialEphemerisSample;
    this._celestialEphemerisSunIdentity =
      this._celestialEphemerisSample.sunPositionWC;
    this._celestialEphemerisMoonIdentity =
      this._celestialEphemerisSample.moonPositionWC;
    this._celestialEphemerisEvaluationTime = new JulianDate();
    this._celestialEphemerisCacheValid = false;
    this._celestialEphemerisCacheProvider = undefined;
    this._celestialEphemerisCacheCompute = undefined;
    this._celestialEphemerisCacheProviderId = undefined;
    this._celestialEphemerisCacheProviderRevision = undefined;
    this._celestialEphemerisCacheProvenance = undefined;
    this._celestialEphemerisCacheTimePolicy = undefined;
    this._celestialEphemerisCacheOutputAllocationStable = undefined;
    this._celestialEphemerisCacheThirdPartyTemporaryFree = undefined;
    this._celestialEphemerisCacheDayNumber = undefined;
    this._celestialEphemerisCacheSecondsOfDay = undefined;
    this._celestialEphemerisCacheTransformBranch = undefined;
    this._celestialEphemerisCacheSunX = undefined;
    this._celestialEphemerisCacheSunY = undefined;
    this._celestialEphemerisCacheSunZ = undefined;
    this._celestialEphemerisCacheMoonX = undefined;
    this._celestialEphemerisCacheMoonY = undefined;
    this._celestialEphemerisCacheMoonZ = undefined;
    this._celestialEphemerisObservedFrameNumber = this.frameNumber;
    this._celestialEphemerisLogicalFrameToken = 0;
    this._celestialEphemerisPublishedFrameToken = undefined;
    this._celestialEphemerisRejectedFrameToken = undefined;
    this._celestialEphemerisLegacyFrameToken = undefined;
    this._celestialEphemerisLegacyTransform = undefined;
    this._celestialEphemerisGeneration = 0;
    this._celestialEphemerisComputing = false;

    /**
     * The authoritative geocentric Sun/Moon sample for this frame time.
     * Undefined while a provider evaluation is incomplete or failed.
     *
     * @type {CelestialEphemerisProvider.Sample|undefined}
     * @private
     */
    this.celestialEphemerisSample = undefined;

    /**
     * The job scheduler.
     *
     * @type {JobScheduler}
     */
    this.jobScheduler = jobScheduler;

    /**
     * The map projection to use in 2D and Columbus View modes.
     *
     * @type {MapProjection}
     * @default undefined
     */
    this.mapProjection = undefined;

    /**
     * The active logical {@link View}. View-dependent derived state is owned
     * by this object and published on FrameState only for the duration of its
     * update/render path.
     *
     * @type {View}
     * @default undefined
     */
    this.view = undefined;

    /**
     * The current camera.
     *
     * @type {Camera}
     * @default undefined
     */
    this.camera = undefined;

    /**
     * Whether the camera is underground.
     *
     * @type {boolean}
     * @default false
     */
    this.cameraUnderground = false;

    /**
     * Whether native cascaded shadow receiving is requested for this frame.
     * Scene publishes this before primitive updates so WebGPU receivers never
     * infer activity merely from a persistent renderer object left over from a
     * prior frame. Restricted to SCENE3D by Scene.updateFrameState.
     *
     * @type {boolean}
     * @default false
     */
    this.useCascadedShadowMaps = false;

    /**
     * Whether the scene's globe is enabled for this frame. This is published
     * before primitive updates so backend feature renderers can reject retained
     * globe work immediately when the shared Scene has hidden the globe.
     *
     * @type {boolean}
     * @default false
     */
    this.globeVisible = false;

    /**
     * The {@link GlobeTranslucencyState} object used by the scene.
     *
     * @type {GlobeTranslucencyState}
     * @default undefined
     */
    this.globeTranslucencyState = undefined;

    /**
     * The culling volume.
     *
     * @type {CullingVolume}
     * @default undefined
     */
    this.cullingVolume = undefined;

    /**
     * The current occluder.
     *
     * @type {Occluder}
     * @default undefined
     */
    this.occluder = undefined;

    /**
     * The maximum screen-space error used to drive level-of-detail refinement.  Higher
     * values will provide better performance but lower visual quality.
     *
     * @type {number}
     * @default 2
     */
    this.maximumScreenSpaceError = undefined;

    /**
     * Ratio between a pixel and a density-independent pixel. Provides a standard unit of
     * measure for real pixel measurements appropriate to a particular device.
     *
     * @type {number}
     * @default 1.0
     */
    this.pixelRatio = 1.0;

    /**
     * @typedef FrameState.Passes
     * @type {object}
     * @property {boolean} render <code>true</code> if the primitive should update for a render pass, <code>false</code> otherwise.
     * @property {boolean} pick <code>true</code> if the primitive should update for a picking pass, <code>false</code> otherwise.
     * @property {boolean} pickVoxel <code>true</code> if the primitive should update for a voxel picking pass, <code>false</code> otherwise.
     * @property {boolean} snap <code>true</code> if the current picking pass is a snapping pass (see {@link Scene#snap}), <code>false</code> otherwise. Only ever <code>true</code> while <code>pick</code> is also <code>true</code>.
     * @property {boolean} depth <code>true</code> if the primitive should update for a depth only pass, <code>false</code> otherwise.
     * @property {boolean} postProcess <code>true</code> if the primitive should update for a per-feature post-process pass, <code>false</code> otherwise.
     * @property {boolean} offscreen <code>true</code> if the primitive should update for an offscreen pass, <code>false</code> otherwise.
     */

    /**
     * @type {FrameState.Passes}
     */
    this.passes = {
      /**
       * @default false
       */
      render: false,
      /**
       * @default false
       */
      pick: false,
      /**
       * @default false
       */
      pickVoxel: false,
      /**
       * @default false
       */
      snap: false,
      /**
       * @default false
       */
      depth: false,
      /**
       * @default false
       */
      postProcess: false,
      /**
       * @default false
       */
      offscreen: false,
    };

    /**
     * The credit display.
     *
     * @type {CreditDisplay}
     */
    this.creditDisplay = creditDisplay;

    /**
     * An array of functions to be called at the end of the frame.  This array
     * will be cleared after each frame.
     * <p>
     * This allows queueing up events in <code>update</code> functions and
     * firing them at a time when the subscribers are free to change the
     * scene state, e.g., manipulate the camera, instead of firing events
     * directly in <code>update</code> functions.
     * </p>
     * <p>
     * If any function in the array returns <code>true</code>, in request render mode
     * another frame will be rendered.
     * </p>
     *
     * @type {FrameState.AfterRenderCallback[]}
     *
     * @example
     * frameState.afterRender.push(function() {
     *   // take some action, raise an event, etc.
     * });
     */
    this.afterRender = [];

    /**
     * Gets whether or not to optimize for 3D only.
     *
     * @type {boolean}
     * @default false
     */
    this.scene3DOnly = false;

    /**
     * @typedef FrameState.Fog
     * @type {object}
     * @property {boolean} configuredEnabled <code>true</code> if the user-facing fog feature is enabled, even when fog is outside its current render range.
     * @property {boolean} enabled <code>true</code> if fog is enabled, <code>false</code> otherwise. This affects both fog culling and rendering.
     * @property {boolean} renderable <code>true</code> if fog should be rendered, <code>false</code> if not. This flag should be checked in combination with fog.enabled.
     * @property {number | undefined} density A positive number used to mix the color and fog color based on camera distance.
     * @property {number | undefined} visualDensityScalar A positive number to modify how impactful the fog is based off the density
     * @property {number | undefined} sse A scalar used to modify the screen space error of geometry partially in fog.
     * @property {number | undefined} minimumBrightness The minimum brightness of terrain with fog applied.
     */

    /**
     * @type {FrameState.Fog}
     */

    this.fog = {
      configuredEnabled: false,
      /**
       * @default false
       */
      enabled: false,
      renderable: false,
      density: undefined,
      visualDensityScalar: undefined,
      sse: undefined,
      minimumBrightness: undefined,
    };

    /**
     * The current Atmosphere
     * @type {Atmosphere}
     */
    this.atmosphere = undefined;

    /**
     * Whether the sky atmosphere is being rendered this frame. Published by
     * Scene at frame start so celestial-body renderers (Moon) can gate
     * atmospheric extinction on the atmosphere actually being shown.
     * @type {boolean}
     */
    this.skyAtmosphereVisible = false;

    /**
     * Per-frame RGB atmospheric extinction (transmittance) for the Moon —
     * the fraction of moonlight, per channel, that survives the slant path
     * through the atmosphere to the camera. {@link Cartesian3#ONE} when the
     * view ray never crosses the atmosphere (from orbit / atmosphere hidden),
     * making the moon byte-identical in that case. Consumed by the WebGPU
     * moon feature renderer; the WebGL path reads it via the Moon primitive.
     * @type {Cartesian3|undefined}
     */
    this.moonAtmosphereExtinction = undefined;

    /**
     * Per-frame RGB atmospheric IN-SCATTERING (sky-wash) for the Moon —
     * the additive half of the transfer {@link FrameState#moonAtmosphereExtinction}
     * is the multiplicative half of: the sky radiance scattered into the
     * camera→moon path, added over the opaque disc so a daytime moon reads
     * pale/sky-washed instead of a dark cutout (C12-30). Exactly
     * {@link Cartesian3#ZERO} — the additive identity — when disabled, when
     * the atmosphere is hidden, or from orbit. Consumed by the WebGPU moon
     * feature renderer; the WebGL path reads it via the Moon primitive.
     * @type {Cartesian3|undefined}
     */
    this.moonAtmosphereInscatter = undefined;

    /**
     * Per-frame lunar opposition-surge brightness multiplier (C12-23) —
     * the Hapke-SHOE term computed CPU-side from the true Sun–Moon–observer
     * phase angle. 1.0 (identity) when disabled or away from opposition.
     * Consumed by the WebGPU moon feature renderer; the WebGL path reads
     * it via the Moon primitive's uniform.
     * @type {number|undefined}
     */
    this.moonOppositionSurge = undefined;

    /**
     * Per-frame earthshine phase scale (C12-21) — Earth's illuminated
     * fraction as seen FROM the Moon, the exact complement of the Moon's own
     * phase, so earthshine peaks at new moon and is exactly zero at full.
     * Exactly 1.0 — the historical constant term — when the toggle or
     * moon-phase modelling is off. Resolved by
     * {@link readMoonPhaseAppearance}; consumed by the WebGPU moon feature
     * renderer, and by the WebGL path via the Moon primitive's
     * `u_earthshinePhaseScale`.
     * @type {number|undefined}
     */
    this.moonEarthshinePhaseScale = undefined;

    /**
     * Per-frame soft-terminator width (C12-22) — the Sun's angular RADIUS in
     * radians as seen from the Moon (~4.649e-3), measured from the true
     * Sun→Moon distance. Exactly 0.0 when the toggle is off, which selects
     * the legacy `max(N·L, 0)` horizon clip in both shader twins. Resolved by
     * {@link readMoonPhaseAppearance}; consumed by the WebGPU moon feature
     * renderer, and by the WebGL path via the Moon primitive's
     * `u_terminatorSoftness`.
     * @type {number|undefined}
     */
    this.moonTerminatorSoftness = undefined;

    /**
     * Per-frame RGB atmospheric extinction (transmittance) for the Sun —
     * the fraction of sunlight, per channel, that survives the slant path
     * through the atmosphere to the camera along the camera→sun ray.
     * {@link Cartesian3#ONE} when the ray never crosses the atmosphere
     * (from orbit / atmosphere hidden), making the sun byte-identical in
     * that case. Consumed by the WebGPU sun renderer; the WebGL path reads
     * it via the {@link Sun} primitive's uniform. Computed by
     * {@link computeAtmosphereExtinction} (shared with the Moon, B629).
     * @type {Cartesian3|undefined}
     */
    this.sunAtmosphereExtinction = undefined;

    /**
     * Per-frame RGB atmospheric transmittance at the ZENITH for the
     * starfield. The star extinction is a per-direction analytic Bouguer
     * model — each star's slant transmittance is
     * `zenithTransmittance^airmass(elevation)` — so a single zenith ray
     * (integrated by {@link computeAtmosphereExtinction}, shared with the
     * Moon/Sun, B629) drives the whole field. {@link Cartesian3#ONE} from
     * orbit / when the atmosphere is hidden, making every star byte-
     * identical (pow(1, x) === 1). Consumed by the WebGL + WebGPU starfield
     * renderers. Undefined when the effect is disabled.
     * @type {Cartesian3|undefined}
     */
    this.starZenithTransmittance = undefined;

    /**
     * Eclipse / occultation state for the active logical {@link View}
     * (C12-29 S1). Computed unconditionally when that View is prepared from
     * the observer-camera-anchored dual-cone geometry of the solar disc
     * against the Earth limb and the lunar disc, in f64. Carries
     * `sunVisibleFraction` (the
     * limb-darkened surviving flux fraction the sun billboard fades by),
     * `earthOcclusionFraction`, `moonObscuration`, `moonPositionWC` (ECEF,
     * for the S5 per-fragment umbra term) plus angular diagnostics. The
     * `enabled` field mirrors `atmosphericConditions.lighting.enableEclipse`
     * and gates only whether consumers APPLY the fraction — the physics is
     * always available for probes. This is a transient alias to one stable
     * object owned and mutated in place by the active View.
     * @type {object|undefined}
     */
    this.eclipseState = undefined;

    /**
     * Per-frame sun-billboard alpha multiplier derived from
     * `eclipseState.sunVisibleFraction` (C12-29 S1). Exactly 1.0 — the
     * multiplicative identity, hence byte-identical output — whenever the
     * effect is disabled or nothing occults the sun. Published by
     * {@link Sun#update} before the backend branch so the WebGL uniform and
     * the WebGPU uniform buffer read the same scalar.
     * @type {number|undefined}
     */
    this.sunEclipseAlpha = undefined;

    /**
     * Resolved sun-disc bake appearance (C12-15 limb darkening + C12-16
     * glare falloff), published by {@link Sun#update} before the backend
     * branch so the WebGL bake's uniforms and the WebGPU CPU bake read one
     * identical resolution. See `Scene/SunDiscAppearance.js`; the numeric
     * constants live in `Scene/SolarDiscModel.js`, the single source both
     * bakes and `computeSolarObscuration.js` read.
     * @type {object|undefined}
     */
    this.sunDiscAppearance = undefined;

    /**
     * Whether the post-process chain that draws the C12-18 screen-space solar
     * halo will run this frame — `scene.sunBloom` and not WebVR. Published by
     * {@link Scene#updateEnvironment} BEFORE {@link Sun#update}, because the
     * halo-source decision must be made before the backend branch so both
     * bakes agree about whether the halo is still baked.
     * @type {boolean|undefined}
     */
    this.sunBloomActive = undefined;

    /**
     * Resolved sun disc-size + halo-source state (C12-18, absorbing C11-160
     * and C11-115), published by {@link Sun#update} before the backend branch.
     * Carries the bake payload (`discEdge`, `bakeHaloGain`) consumed by
     * `SunTextureFS.glsl` and the WebGPU CPU bake, AND the screen-space
     * payload (`centerX`, `centerY`, `limbPx`, `haloCoreRadii`,
     * `haloIntensity`, `haloColorR/G/B`) consumed by `SolarHalo.glsl` inside
     * {@link SunPostProcess} and by the WebGPU `SunHaloEffect`. See
     * `Scene/SunHaloAppearance.js`; its header states the one invariant —
     * exactly one halo source is live at a time.
     * @type {object|undefined}
     */
    this.sunHalo = undefined;

    /**
     * Resolved angular solar-glare star washout (C12-27), published by
     * {@link Scene#updateEnvironment} BEFORE the star cube map and the star
     * sprite catalogue update, so all four shader consumers (WGSL + GLSL, cube
     * map + sprites) read one identical resolution. Carries the Sun's
     * direction in the TEME / inertial star frame plus the veiling-glare curve
     * parameters from `Scene/SolarDiscModel.js`. `strength` is exactly 0 in
     * the `enableAngularSolarGlare = false` position, which every consumer
     * treats as a whole-block skip — byte-identical, not close. Undefined when
     * the environment is not being drawn at all.
     * @type {object|undefined}
     */
    this.solarGlareAppearance = undefined;

    /**
     * The SAMPLABLE star cube map (C12-14), published by
     * {@link CubeMapPanorama#update} for star maps only — i.e. by
     * {@link SkyBox}, not by generic or Street View panoramas. Carries a
     * backend-neutral descriptor plus the WebGL {@link CubeMap} or the WebGPU
     * `GPUTexture` + `GPUTextureView`; see `Scene/StarCubeMapResource.js` for
     * the frame (TEME, not Earth-fixed), the content caveat (the default
     * variant is diffuse-only), the async availability rule, and the borrowed-
     * ownership rule. **Nothing samples this yet** — it discharges the
     * "samplable STAR cubemap" blocker recorded against `C11-163` (celestial
     * water reflection), which is the intended consumer.
     * @type {object|undefined}
     */
    this.starCubeMap = undefined;

    /**
     * Per-frame multiplier applied to every SUN-DRIVEN scene light and
     * atmosphere intensity during a solar eclipse (C12-29 S2) — the scene
     * light colour (`UniformState`), the sky-atmosphere shell on both
     * backends, the globe's ground atmosphere and its fog (through the one
     * `tileProvider.atmosphereLightIntensity` mirror), and
     * `frameState.skyBrightness`. Derived from
     * `eclipseState.moonObscuration` ONLY — never from `sunVisibleFraction`,
     * whose Earth-limb term saturates through twilight and all night and
     * would black out every sunset. Linear in the limb-darkened flux
     * fraction, floored on the ~5-lux twilight constant and carried through
     * the eye's adaptation exponent unless
     * `atmosphericConditions.lighting.eclipseAutoExposure` is on. Exactly 1.0
     * — the multiplicative identity — in every frame that is not a solar
     * eclipse and in the `enableEclipse = false` position.
     * @type {number|undefined}
     */
    this.eclipseSceneLightFactor = undefined;

    /**
     * Per-fragment Moon-shadow block for the globe (C12-29 S5), owned by the
     * active logical {@link View}. The geocentric body-ray payload is
     * pass-camera-independent; its fit and S2 composition terms remain
     * observer-dependent. `params.x === 0` is the inert shader gate.
     * This FrameState field is only a transient alias to the View-owned block.
     *
     * @type {object|undefined}
     */
    this.eclipseGlobeShadow = undefined;

    /**
     * Internal same-logical-view memo for S5 terrain-bound classification.
     * Each command owner prepares S5 against its exact retained or selected
     * terrain set. A repeated owner call may reuse the already-published block
     * only when both its surface radius and selection revision still match.
     *
     * @type {boolean}
     * @private
     */
    this.eclipseGlobeShadowPrepared = false;

    /**
     * Radius paired with {@link FrameState#eclipseGlobeShadowPrepared}.
     *
     * @type {number|undefined}
     * @private
     */
    this.eclipseGlobeShadowSurfaceRadius = undefined;

    /**
     * Selected-terrain generation paired with the refined S5 classification.
     * A retained mutable quadtree array can keep the same identity while its
     * contents change, so memoization uses the provider's generation instead.
     *
     * @type {number|undefined}
     * @private
     */
    this.eclipseGlobeShadowSelectionRevision = undefined;

    /**
     * Gain on the 360-degree horizon twilight band the sky-atmosphere shell
     * adds during totality (C12-29 S6), as a multiple of the sky's own
     * luminance along the same ray. Inside the umbra the observer is
     * surrounded by penumbra — the umbral track is only 100-160 km wide — so
     * a sunset-coloured glow rims the horizon at EVERY azimuth. Ramps in over
     * the last ~2% of obscuration (an annular eclipse cannot reach the onset,
     * correctly: no umbra, no glow) and fades out above the atmosphere.
     * Exactly 0.0 — hence a byte-identical shell — in every other frame and
     * with either `enableEclipse` or `enableEclipseHorizonTwilight` off.
     * @type {number|undefined}
     */
    this.eclipseHorizonTwilight = undefined;

    /**
     * Canonical atmospheric conditions facade — forwarded once per frame
     * from `scene.globe.atmosphericConditions`. Renderers read B-series
     * toggles (sun/moon lighting, scattering occlusion, star modulation,
     * volumetric fog, varying atmosphere density, cloud volumetrics,
     * weather, night) through this single reference. Phase 1.1 forward.
     * Undefined when no globe is attached to the scene.
     * @type {AtmosphericConditions|undefined}
     */
    this.atmosphericConditions = undefined;

    /**
     * Sky brightness scalar (0..1) computed CPU-side once per render frame
     * from current-frame sun/moon altitudes, eclipse flux and the camera's
     * ellipsoidal height. Published before star-map consumers update.
     * @type {number|undefined}
     */
    this.skyBrightness = undefined;

    /**
     * Sun direction in world coordinates, forwarded from
     * `uniformState.sunDirectionWC` once per frame. Renderers that cannot
     * reach the per-context `UniformState` (feature renderers, backend-
     * agnostic scene code) read the sun direction from here. Phase 1.2.
     * @type {Cartesian3|undefined}
     */
    this.sunDirectionWC = undefined;

    /**
     * Moon direction in world coordinates, computed once per frame from
     * the existing Simon 1994 lunar ephemeris (Moon.js). Phase 1.2 will
     * populate this; Phase 1.1 leaves it undefined.
     * @type {Cartesian3|undefined}
     */
    this.moonDirectionWC = undefined;

    /**
     * Moon phase fraction (0..1, 0 = new moon, 0.5 = full moon, 1 = back
     * to new). Used by `Moon.wgsl` for lit hemisphere shading and
     * earthshine intensity. Phase 1.2 populates; Phase 1.1 leaves undefined.
     * @type {number|undefined}
     */
    this.moonPhaseFraction = undefined;

    /**
     * A scalar used to vertically exaggerate the scene
     * @type {number}
     * @default 1.0
     */
    this.verticalExaggeration = 1.0;

    /**
     * The height relative to which the scene is vertically exaggerated.
     * @type {number}
     * @default 0.0
     */
    this.verticalExaggerationRelativeHeight = 0.0;

    /**
     * @typedef FrameState.ShadowState
     * @type {object}
     * @property {boolean} shadowsEnabled Whether there are any active shadow maps this frame.
     * @property {boolean} lightShadowsEnabled Whether there are any active shadow maps that originate from light sources. Does not include shadow maps that are used for analytical purposes.
     * @property {ShadowMap[]} shadowMaps All shadow maps that are enabled this frame.
     * @property {ShadowMap[]} lightShadowMaps Shadow maps that originate from light sources. Does not include shadow maps that are used for analytical purposes. Only these shadow maps will be used to generate receive shadows shaders.
     * @property {number} nearPlane The near plane of the scene's frustum commands. Used for fitting cascaded shadow maps.
     * @property {number} farPlane The far plane of the scene's frustum commands. Used for fitting cascaded shadow maps.
     * @property {number} closestObjectSize The size of the bounding volume that is closest to the camera. This is used to place more shadow detail near the object.
     * @property {number} lastDirtyTime The time when a shadow map was last dirty
     * @property {boolean} outOfView Whether the shadows maps are out of view this frame
     * @property {DrawCommand[]} prePvsCasterCommands Reusable side channel of
     * active casters captured before optional camera-only octree/Hi-Z filters.
     * View merges missing entries into `casterCommands` without camera-binning
     * them, so shadow correctness does not disable camera visibility work.
     * @property {Set<DrawCommand>} prePvsCasterCommandSet Reusable dedupe
     * scratch for `prePvsCasterCommands`; cleared before publication.
     * @property {DrawCommand[]} [casterCommands] C10-10 — the per-frame shadow-caster sublist collected during {@link View#createPotentiallyVisibleSet} (all `castShadows` commands in a shadowed pass, camera-visible or not). {@link SceneRenderer.executeShadowMapCastCommands} iterates this instead of re-scanning the full command list per shadow map. `undefined` when shadows are disabled this frame.
     */

    /**
     * @type {FrameState.ShadowState}
     */

    this.shadowState = {
      /**
       * @default true
       */
      shadowsEnabled: true,
      shadowMaps: [],
      lightShadowMaps: [],
      /**
       * @default 1.0
       */
      nearPlane: 1.0,
      /**
       * @default 5000.0
       */
      farPlane: 5000.0,
      /**
       * @default 1000.0
       */
      closestObjectSize: 1000.0,
      /**
       * @default 0
       */
      lastDirtyTime: 0,
      /**
       * @default true
       */
      outOfView: true,
      /**
       * C11-184 shadow-only side channel. Persistent and reset by length so
       * optional camera visibility filters never force casters back into the
       * camera command list.
       * @type {DrawCommand[]}
       */
      prePvsCasterCommands: [],
      prePvsCasterCommandSet: new Set(),
      /**
       * C10-10 shadow-caster sublist; populated by the PVS walk when shadows
       * are enabled, `undefined` otherwise.
       * @type {DrawCommand[]|undefined}
       * @default undefined
       */
      casterCommands: undefined,
    };

    /**
     * The position of the splitter to use when rendering different things on either side of a splitter.
     * This value should be between 0.0 and 1.0 with 0 being the far left of the viewport and 1 being the far right of the viewport.
     * @type {number}
     * @default 0.0
     */
    this.splitPosition = 0.0;

    /**
     * Distances to the near and far planes of the camera frustums
     * @type {number[]}
     * @default []
     */
    this.frustumSplits = [];

    /**
     * The current scene background color
     *
     * @type {Color}
     */
    this.backgroundColor = undefined;

    /**
     * The light used to shade the scene.
     *
     * @type {Light}
     */
    this.light = undefined;

    /**
     * The collection of additional light sources. Set by Scene from scene.lights.
     * @type {LightCollection}
     */
    this.lights = undefined;

    /**
     * Track V-A3 (NEW-ATMO-DERIVED-LIGHTING) — atmosphere-derived sky-
     * irradiance ambient colour (linear RGB), published by Scene each frame
     * ONLY when `aerialPerspective` is active (WebGPU). Consumers (the WebGPU
     * model renderer) use it as the ambient floor in place of the flat
     * neutral grey, so models pick up a plausible day/night-aware sky ambient
     * consistent with the atmosphere-derived sun (`frameState.light`).
     * Undefined when aerial perspective is off — consumers fall back to their
     * existing neutral ambient. WebGL ignores it.
     * @type {Cartesian3|undefined}
     */
    this.atmosphereSkyIrradiance = undefined;

    /**
     * The distance from the camera at which to disable the depth test of billboards, labels and points
     * to, for example, prevent clipping against terrain. When set to zero, the depth test should always
     * be applied. When less than zero, the depth test should never be applied.
     * @type {number}
     */
    this.minimumDisableDepthTestDistance = undefined;

    /**
     * When <code>false</code>, 3D Tiles will render normally. When <code>true</code>, classified 3D Tile geometry will render normally and
     * unclassified 3D Tile geometry will render with the color multiplied with {@link FrameState#invertClassificationColor}.
     * @type {boolean}
     * @default false
     */
    this.invertClassification = false;

    /**
     * The highlight color of unclassified 3D Tile geometry when {@link FrameState#invertClassification} is <code>true</code>.
     * @type {Color}
     */
    this.invertClassificationColor = undefined;

    /**
     * Whether or not the scene uses a logarithmic depth buffer.
     *
     * @type {boolean}
     * @default false
     */
    this.useLogDepth = false;

    /**
     * Whether temporal anti-aliasing is enabled this frame. Canonical
     * per-frame mirror of `scene.taaEnabled`, published by
     * `Scene.updateFrameState`. This is THE flag velocity-emission gates
     * read (billboard/label/point/cloud/polyline/model/voxel/splat/...) —
     * renderers must NOT reach back through a scene reference for it.
     * (Batch 234, NEW-COLLECTIONS-TAA-GATE-DORMANT.)
     *
     * @type {boolean}
     * @default false
     */
    this.taaEnabled = false;

    /**
     * The scene's snapshot-mode service for this frame. Canonical
     * per-frame mirror of `scene.snapshotMode`, published by
     * `Scene.updateFrameState`. Renderers that register snapshot
     * freezables (moon, volumetric fog, render bundles) read THIS —
     * never `frameState.scene`, which does not exist at runtime
     * (Batch 244; same dormant-gate family as `taaEnabled` / Batch 234).
     *
     * @type {SnapshotModeService|undefined}
     * @default undefined
     */
    this.snapshotMode = undefined;

    /**
     * Additional state used to update 3D Tilesets.
     *
     * @type {Cesium3DTilePassState}
     */
    this.tilesetPassState = undefined;

    /**
     * The minimum terrain height out of all rendered terrain tiles. Used to improve culling for objects underneath the ellipsoid but above terrain.
     *
     * @type {number}
     * @default 0.0
     */
    this.minimumTerrainHeight = 0.0;

    /**
     * Whether metadata picking is currently in progress.
     *
     * This is set to `true` in the `Picking.pickMetadata` function,
     * immediately before updating and executing the draw commands,
     * and set back to `false` immediately afterwards. It will be
     * used to determine whether the metadata picking draw commands
     * should be executed, in the `Scene.executeCommand` function.
     *
     * @type {boolean}
     * @default false
     */
    this.pickingMetadata = false;

    /**
     * Metadata picking information.
     *
     * This describes the metadata property that is supposed to be picked
     * in a `Picking.pickMetadata` call.
     *
     * This is stored in the frame state and in the metadata picking draw
     * commands. In the `Scene.updateDerivedCommands` call, it will be
     * checked whether the instance that is stored in the frame state
     * is different from the one in the draw command, and if necessary,
     * the derived commands for metadata picking will be updated based
     * on this information.
     *
     * @type {PickedMetadataInfo|undefined}
     */
    this.pickedMetadataInfo = undefined;

    /**
     * Internal toggle indicating that at least one primitive for this frame requested
     * edge visibility rendering (EXT_mesh_primitive_edge_visibility). This allows
     * lazy allocation/activation of the edge MRT without storing a Scene reference
     * on the frame state (avoids passing entire Scene through internal APIs).
     * Set by model pipeline stages when they encounter edge visibility data.
     * Consumed by Scene to flip its _enableEdgeVisibility flag.
     * @type {boolean}
     * @private
     */
    this.edgeVisibilityRequested = false;

    /**
     * Internal toggle indicating that at least one primitive for this frame has
     * the BENTLEY_materials_planar_fill extension present. This allows lazy
     * allocation of the planar fill feature-ID framebuffer.
     * Set by MaterialPipelineStage at draw command build time and renewed
     * per frame by ModelSceneGraph while planar fill primitives render.
     * Consumed by Scene to update its _enablePlanarFillId flag.
     * @type {boolean}
     * @private
     */
    this.planarFillRequested = false;

    /**
     * Phase 8a (Batch 80) — gates the depth-prepass + normal G-buffer
     * scaffolding. Default false; flipped to true by `scene.deferredLighting`
     * once the WebGPU backend supports it AND the scaffolding's downstream
     * consumers (SSAO/SSR/deferred lighting) have been rewired to read
     * from the G-buffer (Slice 2+).
     *
     * Slice 1 wires the flag through to `View.gBufferFramebuffer.update()`
     * so the targets allocate when set; with the flag off the targets stay
     * unallocated and the scaffolding has zero runtime cost.
     *
     * See `migration_doc/PHASE_8_SHADER_STRATEGY.md` and `WEBGPU_DEBUGGING_LOG.md`
     * Batch 80 for the architectural decision and rollout plan.
     * @type {boolean}
     * @private
     */
    this.useDeferredLighting = false;

    /**
     * Phase 8a Slice 2c (Batch 89) — debug-only flag. When true, the
     * WebGPU scene renderer replaces the production post-process chain
     * with `WebGPUDebugGBufferOverlay`, which blits the G-buffer normal
     * texture to the canvas as a normal-map visualization. Activated
     * via `CesiumDebug.showGBufferNormals()` (which also flips
     * `scene.deferredLighting = true` since the overlay requires the
     * producer to have populated the G-buffer this frame).
     * @type {boolean}
     * @private
     */
    this.debugShowGBufferNormals = false;
  }

  /**
   * Publishes the one authoritative Sun/Moon sample for the exact provider,
   * provider revision, simulation time, and transform branch. Repeated
   * logical-View, pick, and offscreen preparations hit this same cache.
   *
   * @param {CelestialEphemerisProvider} provider Ready synchronous provider.
   * @param {JulianDate} time Exact simulation time.
   * @param {boolean} [legacyTransformActive=false] Whether Scene suppressed
   *   its implicit Earth-fixed sample for a documented central-body override.
   * @param {Function} [legacyTransform] Captured central-body override used by
   *   UniformState's legacy fallback for the logical frame. Moon and eclipse
   *   fallbacks retain their established Earth-fixed ICRF/TEME derivations.
   * @returns {CelestialEphemerisProvider.Sample|undefined} The retained
   *   branded sample, or undefined while legacy transformation is active.
   * @private
   */
  _updateCelestialEphemeris(
    provider,
    time,
    legacyTransformActive = false,
    legacyTransform,
  ) {
    if (this._celestialEphemerisComputing) {
      ++this._celestialEphemerisGeneration;
      this._celestialEphemerisCacheValid = false;
      this._celestialEphemerisCacheProvider = undefined;
      this.celestialEphemerisSample = undefined;
      throw new DeveloperError(
        "FrameState celestial ephemeris sampling does not support reentrant calls.",
      );
    }

    Check.defined("provider", provider);
    Check.defined("time", time);

    this._celestialEphemerisComputing = true;
    const generation = ++this._celestialEphemerisGeneration;
    const expectedFrameNumber = this.frameNumber;
    const expectedDayNumber = time.dayNumber;
    const expectedSecondsOfDay = time.secondsOfDay;
    const frameTimeIsCallerTime = this.time === time;
    const sample = this._celestialEphemerisSample;

    if (this._celestialEphemerisObservedFrameNumber !== this.frameNumber) {
      this._celestialEphemerisObservedFrameNumber = this.frameNumber;
      ++this._celestialEphemerisLogicalFrameToken;
    }
    const logicalFrameToken = this._celestialEphemerisLogicalFrameToken;

    try {
      if (this._celestialEphemerisRejectedFrameToken === logicalFrameToken) {
        throw new RuntimeError(
          "The celestial ephemeris changed after publication for this frame.",
        );
      }
      if (legacyTransformActive) {
        if (this._celestialEphemerisPublishedFrameToken === logicalFrameToken) {
          this._celestialEphemerisRejectedFrameToken = logicalFrameToken;
          throw new RuntimeError(
            "The celestial ephemeris transform policy changed after publication for this frame.",
          );
        }
        if (
          this._celestialEphemerisLegacyFrameToken === logicalFrameToken &&
          this._celestialEphemerisLegacyTransform !== legacyTransform
        ) {
          this._celestialEphemerisRejectedFrameToken = logicalFrameToken;
          throw new RuntimeError(
            "The celestial ephemeris transform override changed during this frame.",
          );
        }
        // Validate before mutating. A rejected legacy transform used to leave
        // the frame marked as legacy-consumed with no transform attached, so
        // the caller's retry for the same frame hit the
        // "transform policy changed after legacy consumption" path instead of
        // its own argument error.
        Check.typeOf.func("legacyTransform", legacyTransform);
        this._celestialEphemerisCacheValid = false;
        this._celestialEphemerisCacheProvider = undefined;
        this._celestialEphemerisLegacyFrameToken = logicalFrameToken;
        this.celestialEphemerisSample = undefined;
        this._celestialEphemerisLegacyTransform = legacyTransform;
        return undefined;
      }

      if (this._celestialEphemerisLegacyFrameToken === logicalFrameToken) {
        this._celestialEphemerisRejectedFrameToken = logicalFrameToken;
        throw new RuntimeError(
          "The celestial ephemeris transform policy changed after legacy consumption for this frame.",
        );
      }
      this._celestialEphemerisLegacyTransform = undefined;

      const computeBefore = provider.compute;
      Check.typeOf.func("provider.compute", computeBefore);
      const idBefore = provider.id;
      const revisionBefore = provider.revision;
      const provenanceBefore = provider.provenance;
      const timePolicyBefore = provider.timePolicy;
      const outputAllocationStableBefore = provider.outputAllocationStable;
      const thirdPartyTemporaryFreeBefore = provider.thirdPartyTemporaryFree;
      validateEphemerisDeclaration(
        idBefore,
        revisionBefore,
        provenanceBefore,
        timePolicyBefore,
        outputAllocationStableBefore,
        thirdPartyTemporaryFreeBefore,
      );

      if (generation !== this._celestialEphemerisGeneration) {
        throw new DeveloperError(
          "A reentrant call invalidated the celestial ephemeris sample.",
        );
      }
      if (
        this.frameNumber !== expectedFrameNumber ||
        this._celestialEphemerisObservedFrameNumber !== expectedFrameNumber ||
        this._celestialEphemerisLogicalFrameToken !== logicalFrameToken ||
        time.dayNumber !== expectedDayNumber ||
        time.secondsOfDay !== expectedSecondsOfDay ||
        (frameTimeIsCallerTime && this.time !== time)
      ) {
        throw new RuntimeError(
          "The ephemeris provider mutated the FrameState frame or simulation time.",
        );
      }

      CelestialEphemerisProvider.validateResult(sample);
      // Every cache dimension except the LIVE provider revision. Splitting the
      // revision out lets a mid-frame revision transition be deferred below
      // rather than rejected; the retained sample's own declaration is still
      // pinned to the cached revision, so only the provider getter is free.
      const cacheMatchesExceptProviderRevision =
        this._celestialEphemerisCacheValid &&
        sample === this._celestialEphemerisSampleIdentity &&
        sample.sunPositionWC === this._celestialEphemerisSunIdentity &&
        sample.moonPositionWC === this._celestialEphemerisMoonIdentity &&
        this._celestialEphemerisCacheProvider === provider &&
        this._celestialEphemerisCacheCompute === computeBefore &&
        this._celestialEphemerisCacheProviderId === idBefore &&
        sample.providerRevision ===
          this._celestialEphemerisCacheProviderRevision &&
        this._celestialEphemerisCacheProvenance === provenanceBefore &&
        this._celestialEphemerisCacheTimePolicy === timePolicyBefore &&
        this._celestialEphemerisCacheOutputAllocationStable ===
          outputAllocationStableBefore &&
        this._celestialEphemerisCacheThirdPartyTemporaryFree ===
          thirdPartyTemporaryFreeBefore &&
        this._celestialEphemerisCacheDayNumber === expectedDayNumber &&
        this._celestialEphemerisCacheSecondsOfDay === expectedSecondsOfDay &&
        this._celestialEphemerisCacheTransformBranch ===
          sample.transformBranch &&
        sample.providerId === idBefore &&
        sample.provenance === provenanceBefore &&
        sample.timePolicy === timePolicyBefore &&
        sample.referenceFrame === "ECEF" &&
        sample.units === "metres" &&
        sample.outputAllocationStable === outputAllocationStableBefore &&
        sample.thirdPartyTemporaryFree === thirdPartyTemporaryFreeBefore &&
        typeof sample.transformBranch === "string" &&
        sample.transformBranch.length > 0 &&
        isFiniteCartesian3(sample.sunPositionWC) &&
        isFiniteCartesian3(sample.moonPositionWC) &&
        this._celestialEphemerisCacheSunX === sample.sunPositionWC.x &&
        this._celestialEphemerisCacheSunY === sample.sunPositionWC.y &&
        this._celestialEphemerisCacheSunZ === sample.sunPositionWC.z &&
        this._celestialEphemerisCacheMoonX === sample.moonPositionWC.x &&
        this._celestialEphemerisCacheMoonY === sample.moonPositionWC.y &&
        this._celestialEphemerisCacheMoonZ === sample.moonPositionWC.z;
      const cacheMatches =
        cacheMatchesExceptProviderRevision &&
        this._celestialEphemerisCacheProviderRevision === revisionBefore;

      if (cacheMatches) {
        this._celestialEphemerisPublishedFrameToken = logicalFrameToken;
        this.celestialEphemerisSample = sample;
        return sample;
      }

      // A provider whose revision advances asynchronously — an ICRF data
      // arrival, for example — can transition between the render frame and the
      // pick, snap, or offscreen preparations that reuse the same frame number.
      // Serve the already-published sample and let the transition land on the
      // next frame, matching how Scene defers an asynchronous PROVIDER swap by
      // frame number. Nothing else about the retained sample or the provider
      // may have moved, and the next frame's fresh token recomputes because the
      // cached revision still trails the provider.
      if (
        this._celestialEphemerisPublishedFrameToken === logicalFrameToken &&
        cacheMatchesExceptProviderRevision
      ) {
        this.celestialEphemerisSample = sample;
        return sample;
      }

      // Once any View has consumed this frame's sample, a branch transition or
      // provider-object drift is deferred to the next frame. Recomputing now
      // would mix lineages between the main View and a later pick/offscreen
      // View.
      if (this._celestialEphemerisPublishedFrameToken === logicalFrameToken) {
        this._celestialEphemerisRejectedFrameToken = logicalFrameToken;
        throw new RuntimeError(
          "The celestial ephemeris changed after publication for this frame.",
        );
      }

      // A miss invalidates the prior publication before caller code runs. If
      // the provider throws, returns asynchronously, or re-enters, no consumer
      // can observe a partially overwritten sample as current.
      this._celestialEphemerisCacheValid = false;
      this._celestialEphemerisCacheProvider = undefined;
      this.celestialEphemerisSample = undefined;
      JulianDate.clone(time, this._celestialEphemerisEvaluationTime);

      const returnedSample = computeBefore.call(
        provider,
        this._celestialEphemerisEvaluationTime,
        sample,
      );
      CelestialEphemerisProvider.validateResult(sample);

      // Freeze the complete return boundary into scalar/reference locals
      // before reading any post-compute provider getter. Those getters are
      // caller code and may mutate both the provider and the branded sample.
      // Locals add no successful-path allocation and make the later audit a
      // true time-of-check/time-of-use boundary.
      const sampleAtReturn = sample;
      const sampleSunPositionAtReturn = sample.sunPositionWC;
      const sampleMoonPositionAtReturn = sample.moonPositionWC;
      const sampleSunXAtReturn = sampleSunPositionAtReturn.x;
      const sampleSunYAtReturn = sampleSunPositionAtReturn.y;
      const sampleSunZAtReturn = sampleSunPositionAtReturn.z;
      const sampleMoonXAtReturn = sampleMoonPositionAtReturn.x;
      const sampleMoonYAtReturn = sampleMoonPositionAtReturn.y;
      const sampleMoonZAtReturn = sampleMoonPositionAtReturn.z;
      const sampleProviderIdAtReturn = sample.providerId;
      const sampleProviderRevisionAtReturn = sample.providerRevision;
      const sampleProvenanceAtReturn = sample.provenance;
      const sampleTimePolicyAtReturn = sample.timePolicy;
      const sampleReferenceFrameAtReturn = sample.referenceFrame;
      const sampleUnitsAtReturn = sample.units;
      const sampleTransformBranchAtReturn = sample.transformBranch;
      const sampleOutputAllocationStableAtReturn =
        sample.outputAllocationStable;
      const sampleThirdPartyTemporaryFreeAtReturn =
        sample.thirdPartyTemporaryFree;

      if (generation !== this._celestialEphemerisGeneration) {
        throw new DeveloperError(
          "A reentrant call invalidated the celestial ephemeris sample.",
        );
      }
      if (
        returnedSample !== sampleAtReturn ||
        sampleAtReturn !== this._celestialEphemerisSampleIdentity ||
        this._celestialEphemerisSample !==
          this._celestialEphemerisSampleIdentity ||
        sampleSunPositionAtReturn !== this._celestialEphemerisSunIdentity ||
        sampleMoonPositionAtReturn !== this._celestialEphemerisMoonIdentity
      ) {
        throw new RuntimeError(
          "The ephemeris provider replaced caller-owned sample or vector storage.",
        );
      }
      if (
        this._celestialEphemerisEvaluationTime.dayNumber !==
          expectedDayNumber ||
        this._celestialEphemerisEvaluationTime.secondsOfDay !==
          expectedSecondsOfDay ||
        this.frameNumber !== expectedFrameNumber ||
        this._celestialEphemerisObservedFrameNumber !== expectedFrameNumber ||
        this._celestialEphemerisLogicalFrameToken !== logicalFrameToken ||
        time.dayNumber !== expectedDayNumber ||
        time.secondsOfDay !== expectedSecondsOfDay ||
        (frameTimeIsCallerTime && this.time !== time)
      ) {
        throw new RuntimeError(
          "The ephemeris provider mutated the FrameState frame or simulation time.",
        );
      }
      if (
        !Number.isFinite(sampleSunXAtReturn) ||
        !Number.isFinite(sampleSunYAtReturn) ||
        !Number.isFinite(sampleSunZAtReturn) ||
        !Number.isFinite(sampleMoonXAtReturn) ||
        !Number.isFinite(sampleMoonYAtReturn) ||
        !Number.isFinite(sampleMoonZAtReturn)
      ) {
        throw new RuntimeError(
          "The ephemeris provider produced a non-finite position.",
        );
      }
      // Revision may legitimately transition inside compute (for example when
      // the Simon provider moves from TEME to ICRF). Every other sample
      // declaration is invariant and must already match the pre-call tuple.
      if (
        sampleProviderIdAtReturn !== idBefore ||
        !Number.isInteger(sampleProviderRevisionAtReturn) ||
        sampleProviderRevisionAtReturn < 0 ||
        sampleProvenanceAtReturn !== provenanceBefore ||
        sampleTimePolicyAtReturn !== timePolicyBefore ||
        sampleReferenceFrameAtReturn !== "ECEF" ||
        sampleUnitsAtReturn !== "metres" ||
        typeof sampleTransformBranchAtReturn !== "string" ||
        sampleTransformBranchAtReturn.length === 0 ||
        sampleOutputAllocationStableAtReturn !== outputAllocationStableBefore ||
        sampleThirdPartyTemporaryFreeAtReturn !== thirdPartyTemporaryFreeBefore
      ) {
        throw new RuntimeError(
          "The ephemeris sample does not truthfully match its provider declaration.",
        );
      }

      const idAfter = provider.id;
      const revisionAfter = provider.revision;
      const provenanceAfter = provider.provenance;
      const timePolicyAfter = provider.timePolicy;
      const outputAllocationStableAfter = provider.outputAllocationStable;
      const thirdPartyTemporaryFreeAfter = provider.thirdPartyTemporaryFree;
      const computeAfter = provider.compute;
      Check.typeOf.func("provider.compute", computeAfter);
      validateEphemerisDeclaration(
        idAfter,
        revisionAfter,
        provenanceAfter,
        timePolicyAfter,
        outputAllocationStableAfter,
        thirdPartyTemporaryFreeAfter,
      );
      if (
        idAfter !== idBefore ||
        provenanceAfter !== provenanceBefore ||
        timePolicyAfter !== timePolicyBefore ||
        outputAllocationStableAfter !== outputAllocationStableBefore ||
        thirdPartyTemporaryFreeAfter !== thirdPartyTemporaryFreeBefore ||
        computeAfter !== computeBefore
      ) {
        throw new RuntimeError(
          "The ephemeris provider declaration changed during a frame sample.",
        );
      }
      // Provider declaration getters are caller code too. Recheck the entire
      // payload against the captured return boundary after the last such read
      // so a getter cannot swallow a reentrant call or forge matching provider
      // and sample state between the earlier audit and publication.
      if (generation !== this._celestialEphemerisGeneration) {
        throw new DeveloperError(
          "A reentrant call invalidated the celestial ephemeris sample.",
        );
      }
      CelestialEphemerisProvider.validateResult(sample);
      if (
        sample !== sampleAtReturn ||
        sampleAtReturn !== this._celestialEphemerisSampleIdentity ||
        this._celestialEphemerisSample !==
          this._celestialEphemerisSampleIdentity ||
        sample.sunPositionWC !== sampleSunPositionAtReturn ||
        sample.moonPositionWC !== sampleMoonPositionAtReturn ||
        !Object.is(sample.sunPositionWC.x, sampleSunXAtReturn) ||
        !Object.is(sample.sunPositionWC.y, sampleSunYAtReturn) ||
        !Object.is(sample.sunPositionWC.z, sampleSunZAtReturn) ||
        !Object.is(sample.moonPositionWC.x, sampleMoonXAtReturn) ||
        !Object.is(sample.moonPositionWC.y, sampleMoonYAtReturn) ||
        !Object.is(sample.moonPositionWC.z, sampleMoonZAtReturn) ||
        sample.providerId !== sampleProviderIdAtReturn ||
        !Object.is(sample.providerRevision, sampleProviderRevisionAtReturn) ||
        sample.provenance !== sampleProvenanceAtReturn ||
        sample.timePolicy !== sampleTimePolicyAtReturn ||
        sample.referenceFrame !== sampleReferenceFrameAtReturn ||
        sample.units !== sampleUnitsAtReturn ||
        sample.transformBranch !== sampleTransformBranchAtReturn ||
        sample.outputAllocationStable !==
          sampleOutputAllocationStableAtReturn ||
        sample.thirdPartyTemporaryFree !== sampleThirdPartyTemporaryFreeAtReturn
      ) {
        throw new RuntimeError(
          "The ephemeris sample changed during post-compute provider validation.",
        );
      }
      if (!Object.is(sampleProviderRevisionAtReturn, revisionAfter)) {
        throw new RuntimeError(
          "The ephemeris sample does not truthfully match its provider declaration.",
        );
      }
      if (
        this._celestialEphemerisEvaluationTime.dayNumber !==
          expectedDayNumber ||
        this._celestialEphemerisEvaluationTime.secondsOfDay !==
          expectedSecondsOfDay ||
        this.frameNumber !== expectedFrameNumber ||
        this._celestialEphemerisObservedFrameNumber !== expectedFrameNumber ||
        this._celestialEphemerisLogicalFrameToken !== logicalFrameToken ||
        time.dayNumber !== expectedDayNumber ||
        time.secondsOfDay !== expectedSecondsOfDay ||
        (frameTimeIsCallerTime && this.time !== time)
      ) {
        throw new RuntimeError(
          "The ephemeris provider mutated the FrameState frame or simulation time.",
        );
      }
      this._celestialEphemerisCacheProvider = provider;
      this._celestialEphemerisCacheCompute = computeAfter;
      this._celestialEphemerisCacheProviderId = idAfter;
      this._celestialEphemerisCacheProviderRevision = revisionAfter;
      this._celestialEphemerisCacheProvenance = provenanceAfter;
      this._celestialEphemerisCacheTimePolicy = timePolicyAfter;
      this._celestialEphemerisCacheOutputAllocationStable =
        outputAllocationStableAfter;
      this._celestialEphemerisCacheThirdPartyTemporaryFree =
        thirdPartyTemporaryFreeAfter;
      this._celestialEphemerisCacheDayNumber = expectedDayNumber;
      this._celestialEphemerisCacheSecondsOfDay = expectedSecondsOfDay;
      this._celestialEphemerisCacheTransformBranch =
        sampleTransformBranchAtReturn;
      this._celestialEphemerisCacheSunX = sampleSunXAtReturn;
      this._celestialEphemerisCacheSunY = sampleSunYAtReturn;
      this._celestialEphemerisCacheSunZ = sampleSunZAtReturn;
      this._celestialEphemerisCacheMoonX = sampleMoonXAtReturn;
      this._celestialEphemerisCacheMoonY = sampleMoonYAtReturn;
      this._celestialEphemerisCacheMoonZ = sampleMoonZAtReturn;
      this._celestialEphemerisCacheValid = true;
      this._celestialEphemerisPublishedFrameToken = logicalFrameToken;
      this._celestialEphemerisRejectedFrameToken = undefined;
      this.celestialEphemerisSample = sample;
      return sample;
    } catch (error) {
      this._celestialEphemerisCacheValid = false;
      this._celestialEphemerisCacheProvider = undefined;
      this.celestialEphemerisSample = undefined;
      throw error;
    } finally {
      this._celestialEphemerisComputing = false;
    }
  }
}

/**
 * A function that will be called at the end of the frame.
 *
 * @callback FrameState.AfterRenderCallback
 * @returns {boolean} true if another render should be requested in request render mode
 */
export default FrameState;
