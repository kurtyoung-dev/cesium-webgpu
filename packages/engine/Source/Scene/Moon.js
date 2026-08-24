import buildModuleUrl from "../Core/buildModuleUrl.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import IauOrientationAxes from "../Core/IauOrientationAxes.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import { getSharedMoonDecodedSourceCache } from "../Core/MoonDecodedSourceCache.js";
import Simon1994PlanetaryPositions from "../Core/Simon1994PlanetaryPositions.js";
import Transforms from "../Core/Transforms.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import Texture from "../Renderer/Texture.js";
import {
  computeAtmosphereExtinctionCached,
  createAtmosphereExtinctionCache,
  computeAtmosphereInscatterCached,
  createAtmosphereInscatterCache,
} from "./computeAtmosphereExtinction.js";
import computeLunarOppositionSurge from "./computeLunarOppositionSurge.js";
import EllipsoidPrimitive from "./EllipsoidPrimitive.js";
import Material from "./Material.js";
import {
  createMoonPhaseAppearance,
  readMoonPhaseAppearance,
} from "./MoonPhaseAppearance.js";
import resolveMoonNormalMapStrength from "./resolveMoonNormalMapStrength.js";
import SceneMode from "./SceneMode.js";
import {
  canGenerateWebGLMoonMipmaps,
  configureWebGLMoonTextureMipmaps,
  getWebGLMoonTextureMipLevelCount,
  webGLMoonLinearSampler,
} from "./WebGLMoonTextureMipPolicy.js";
import createWebGLMoonImageMaterial from "./WebGLMoonImageMaterial.js";
import {
  WebGLMoonTextureChannel,
  commitWebGLMoonTextureChannel,
  createWebGLMoonTextureLifecycle,
  createWebGLMoonTexturePairKey,
  getWebGLMoonTextureLifecycleDiagnostics,
  prepareWebGLMoonUploadSource,
  reconcileWebGLMoonTextureChannel,
  releaseWebGLMoonUploadSource,
  retireWebGLMoonPublishedTexture,
  retireWebGLMoonTextureLifecycle,
} from "./WebGLMoonTextureLifecycle.js";

const moonDecodedSourceOptions = Object.freeze({
  imageOrientation: "from-image",
  colorSpaceConversion: "default",
  premultiplyAlpha: "default",
});

const webGLMoonTextureRequestHooks = Object.freeze({
  acquireSource: function (url) {
    return getSharedMoonDecodedSourceCache().acquire(
      url,
      moonDecodedSourceOptions,
    );
  },
  prepareSource: prepareWebGLMoonUploadSource,
  releaseSource: releaseWebGLMoonUploadSource,
  onError: function (error, phase, identity) {
    //>>includeStart('debug', pragmas.debug);
    console.warn(
      `[Moon] ${identity.channel} texture ${phase} failed; using the current fallback:`,
      error && error.message ? error.message : error,
    );
    //>>includeEnd('debug');
  },
});

/**
 * Compute the conservative camera-relative separation used to decide whether
 * the Moon can be nearer than any part of the Earth.
 *
 * All arithmetic is JavaScript `number` (IEEE-754 binary64). Keeping this
 * decision on the CPU avoids deriving a renderer-specific answer from
 * float32/RTE shader state.
 *
 * @param {Cartesian3} cameraPositionWC
 * @param {Cartesian3} moonCenterWC
 * @param {number} moonRadius
 * @param {number} earthRadius
 * @returns {number} Moon-nearest distance minus Earth-farthest distance.
 * @private
 */
function computeMoonPhysicalDepthGap(
  cameraPositionWC,
  moonCenterWC,
  moonRadius,
  earthRadius,
) {
  const moonX = moonCenterWC.x - cameraPositionWC.x;
  const moonY = moonCenterWC.y - cameraPositionWC.y;
  const moonZ = moonCenterWC.z - cameraPositionWC.z;
  const moonCenterDistance = Math.hypot(moonX, moonY, moonZ);
  const moonNear = Math.max(0.0, moonCenterDistance - moonRadius);

  const earthCenterDistance = Math.hypot(
    cameraPositionWC.x,
    cameraPositionWC.y,
    cameraPositionWC.z,
  );
  const earthFar = earthCenterDistance + earthRadius;
  return moonNear - earthFar;
}

/**
 * Apply the physical-depth route's hysteresis law.
 *
 * Entry is exact and conservative: the Moon enters as soon as its nearest
 * surface is no farther than Earth's farthest possible surface. Exit carries
 * one lunar radius of margin so binary64 ephemeris/camera noise cannot make the
 * command bounce between ENVIRONMENT and OPAQUE at the boundary.
 *
 * @param {boolean} wasPhysical
 * @param {number} gap
 * @param {number} moonRadius
 * @returns {boolean}
 * @private
 */
function updateMoonPhysicalDepthDemand(wasPhysical, gap, moonRadius) {
  if (
    !Number.isFinite(gap) ||
    !Number.isFinite(moonRadius) ||
    moonRadius <= 0.0
  ) {
    return false;
  }
  return gap <= (wasPhysical ? moonRadius : 0.0);
}

/**
 * Start lazy backend preparation one lunar radius before exact route entry.
 * This uses the same margin as exit hysteresis, but never changes command
 * ownership by itself.
 *
 * @param {number} gap
 * @param {number} moonRadius
 * @returns {boolean}
 * @private
 */
function shouldPrewarmMoonPhysicalDepth(gap, moonRadius) {
  return (
    Number.isFinite(gap) &&
    Number.isFinite(moonRadius) &&
    moonRadius > 0.0 &&
    gap <= moonRadius
  );
}

function configureWebGLMoonTextureCandidate(texture, context) {
  try {
    configureWebGLMoonTextureMipmaps(texture, context);
    return texture;
  } catch (error) {
    // Candidate publication is transactional. Mip generation and sampler
    // installation happen after Texture.create, so either can fail while the
    // candidate is still unowned by the lifecycle. Retire it here without
    // allowing a synthetic/lost-context destroy failure to mask the cause.
    try {
      destroyWebGLMoonTexture(texture);
    } catch {
      // Preserve the configuration failure.
    }
    throw error;
  }
}

function createWebGLMoonTexture(source, identity) {
  // The async preparation clone bakes in the vertical flip because WebGL
  // ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap. The no-createImageBitmap
  // compatibility path leaves the source unflipped and requests Texture's
  // pixel-store flip instead.
  const texture = Texture.create({
    context: identity.context,
    source: source.uploadSource,
    flipY: source.flipY,
    preMultiplyAlpha: false,
    skipColorSpaceConversion: false,
    sampler: webGLMoonLinearSampler,
  });
  return configureWebGLMoonTextureCandidate(texture, identity.context);
}

function destroyWebGLMoonTexture(texture) {
  if (
    defined(texture) &&
    typeof texture.destroy === "function" &&
    (typeof texture.isDestroyed !== "function" || !texture.isDestroyed())
  ) {
    texture.destroy();
  }
}

function destroyUnadoptedWebGLMoonAlbedo(material, texture) {
  if (defined(texture) && material?._textures?.image !== texture) {
    destroyWebGLMoonTexture(texture);
  }
}

function requestRenderForWebGLMoonTextureLifecycle() {
  return true;
}

/**
 * Draws the Moon in 3D.
 * @alias Moon
 *
 * @param {object} [options] Object with the following properties:
 * @param {boolean} [options.show=true] Determines whether the moon will be rendered.
 * @param {string} [options.textureUrl] The moon texture. Defaults to the albedo
 *        map of {@link Moon.defaultVariant}; pass an explicit URL to override
 *        the bundled maps entirely.
 * @param {string} [options.variant] One of {@link Moon.Variant}, selecting which
 *        bundled albedo map to use. Ignored when <code>textureUrl</code> is given.
 *        Defaults to {@link Moon.defaultVariant}.
 * @param {string} [options.normalMapUrl] A tangent-space (east/north/up) normal
 *        map supplying surface relief. Defaults to the normal map paired with
 *        {@link Moon.defaultVariant} — {@link Moon.Variant.SMALL} has none.
 *        Pass <code>null</code> to force a flat moon.
 * @param {number} [options.normalMapStrength=1.0] Scales the relief. 1.0 is the
 *        true derived geometry; 0.0 is exactly flat.
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.MOON] The moon ellipsoid.
 * @param {boolean} [options.onlySunLighting=true] Use the sun as the only light source.
 *
 *
 * @example
 * scene.moon = new Cesium.Moon();
 *
 * @example
 * // Restore the historical low-resolution albedo map.
 * scene.moon = new Cesium.Moon({ variant: Cesium.Moon.Variant.SMALL });
 *
 * @see Scene#moon
 */
class Moon {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    let url = options.textureUrl;
    if (!defined(url)) {
      url = Moon.getVariantTextureUrl(options.variant);
    }

    // `null` is meaningful here and `undefined` is not: an explicit null
    // requests a flat moon, while an omitted option means "whatever the
    // variant pairs with". `??` collapses both, so the presence of the key
    // is what is tested.
    const normalMapUrl = Object.prototype.hasOwnProperty.call(
      options,
      "normalMapUrl",
    )
      ? (options.normalMapUrl ?? undefined)
      : Moon.getVariantNormalMapUrl(options.variant);

    /**
     * Determines if the moon will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * The moon texture — an equirectangular (plate carrée) albedo map, centred
     * on 0° longitude with east to the right and north at the top of the image.
     * That is the convention {@link czm_ellipsoidTextureCoordinates} and its
     * WGSL twin unwrap to; see `Tools/moon-albedo-bake/lunar-landmarks.mjs`
     * for the checked assertion of it.
     * @type {string}
     * @default the albedo map of {@link Moon.defaultVariant}
     */
    this.textureUrl = url;

    /**
     * A tangent-space normal map supplying the moon's surface relief, in the
     * same equirectangular projection and orientation as
     * {@link Moon#textureUrl}, with x = east, y = north, z = up (the geodetic
     * surface normal) encoded as <code>n * 0.5 + 0.5</code>.
     *
     * Its visible effect is concentrated at the terminator, where N·L is near
     * zero and a few degrees of surface tilt is the difference between a lit
     * and an unlit facet; at full phase the cosine is flat and the relief is
     * nearly invisible. `undefined` renders a geometrically smooth sphere,
     * which is what {@link Moon.Variant.SMALL} selects.
     * @type {string|undefined}
     * @default the normal map of {@link Moon.defaultVariant}
     */
    this.normalMapUrl = normalMapUrl;

    /**
     * Scales {@link Moon#normalMapUrl}'s relief. 1.0 is the true derived
     * geometry — the honest slope of the LOLA surface at the shipped
     * resolution — and 0.0 is exactly flat. Values above 1.0 exaggerate.
     * @type {number}
     * @default 1.0
     */
    this.normalMapStrength = options.normalMapStrength ?? 1.0;

    this._webglMoonTextureLifecycle = undefined;
    this._webglMoonTexturePairAlbedoUrl = undefined;
    this._webglMoonTexturePairNormalUrl = undefined;
    this._webglMoonTexturePairKey = undefined;
    this._webglMoonAlbedoReconcileOptions = {
      context: undefined,
      url: undefined,
      pairKey: undefined,
      demanded: false,
      hooks: webGLMoonTextureRequestHooks,
    };
    this._webglMoonNormalReconcileOptions = {
      context: undefined,
      url: undefined,
      pairKey: undefined,
      demanded: false,
      hooks: webGLMoonTextureRequestHooks,
    };
    this._albedoMapTexture = undefined;
    this._normalMapTexture = undefined;
    this._normalMapTextureUrl = undefined;
    this._normalMapLoading = false;

    this._ellipsoid = options.ellipsoid ?? Ellipsoid.MOON;

    /**
     * Use the sun as the only light source.
     * @type {boolean}
     * @default true
     */
    this.onlySunLighting = options.onlySunLighting ?? true;

    this._ellipsoidPrimitive = new EllipsoidPrimitive({
      radii: this.ellipsoid.radii,
      material: createWebGLMoonImageMaterial(),
      depthTestEnabled: false,
      _owner: this,
    });
    this._ellipsoidPrimitive.material.translucent = false;

    this._axes = new IauOrientationAxes();

    // Per-primitive scalar cache for the shared camera→Moon atmospheric
    // extinction integration. Reused across frames so the 16-sample
    // optical-depth march only recomputes when an exact physical input
    // (camera, Moon position, atmosphere coefficients/scale heights, inner
    // radius, or the enabled gate) changes. Keeps the Moon consistent with
    // the Sun/star extinction, which use the same cached integrator.
    this._atmosphereExtinctionCache = createAtmosphereExtinctionCache();

    // Cache for the additive in-scattering (sky-wash) integral, the
    // extinction's additive twin. Same exact-input caching contract.
    this._atmosphereInscatterCache = createAtmosphereInscatterCache();

    // Reusable result object for the shared moon-phase appearance resolver.
    // Allocated once; never reallocated per frame.
    this._phaseAppearance = createMoonPhaseAppearance();

    // Backend-neutral physical-depth demand and exact command bounding
    // volume.  The demand is intentionally distinct from the route actually
    // emitted by a backend: WebGPU may keep returning the legacy ENVIRONMENT
    // command while its lazy physical pipeline compiles.
    this._physicalDepthDistanceDemand = false;
    this._physicalDepthPrewarmRequested = false;
    this._physicalDepthRequested = false;
    this._physicalDepthActual = false;
    this._physicalDepthClearGlobeDepth = false;
    this._physicalDepthBoundingVolume = new BoundingSphere(
      Cartesian3.ZERO,
      this._ellipsoid.maximumRadius,
    );
  }

  /**
   * Get the ellipsoid that defines the shape of the moon.
   *
   * @type {Ellipsoid}
   * @readonly
   *
   * @default {@link Ellipsoid.MOON}
   */
  get ellipsoid() {
    return this._ellipsoid;
  }

  /**
   * @private
   */
  update(frameState, depthRouteState) {
    if (!this.show) {
      publishMoonPhysicalDepthRoute(this, frameState, false);
      return;
    }

    const ellipsoidPrimitive = this._ellipsoidPrimitive;
    ellipsoidPrimitive.onlySunLighting = this.onlySunLighting;

    const date = frameState.time;
    if (!defined(Transforms.computeIcrfToFixedMatrix(date, icrfToFixed))) {
      Transforms.computeTemeToPseudoFixedMatrix(date, icrfToFixed);
    }

    const rotation = this._axes.evaluate(date, rotationScratch);
    Matrix3.transpose(rotation, rotation);
    Matrix3.multiply(icrfToFixed, rotation, rotation);

    const celestialEphemerisSample = frameState.celestialEphemerisSample;
    let translation;
    if (defined(celestialEphemerisSample)) {
      translation = Cartesian3.clone(
        celestialEphemerisSample.moonPositionWC,
        translationScratch,
      );
    } else {
      // Retain Moon's exact historical Earth-fixed path for bare/private
      // callers and while Scene suppresses its implicit sample for a
      // central-body hook. Unlike UniformState, Moon never honored that hook:
      // it uses ICRF-to-fixed with the TEME pseudo-fixed fallback above.
      translation =
        Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
          date,
          translationScratch,
        );
      Matrix3.multiplyByVector(icrfToFixed, translation, translation);
    }

    // Decide whether the Moon can physically precede the Earth using only
    // shared binary64 scene state, before either backend is selected.
    // Entry is exact; exit carries a one-lunar-radius hysteresis margin.  A
    // screen-overlap predicate is deliberately not used: projection noise or a
    // one-frame-late view would make route ownership pop at the limb.
    const moonRadius = this._ellipsoid.maximumRadius;
    Cartesian3.clone(translation, this._physicalDepthBoundingVolume.center);
    this._physicalDepthBoundingVolume.radius = moonRadius;
    const camera = frameState.camera;
    const earthEllipsoid = frameState.mapProjection?.ellipsoid;
    const earthRadius = defined(earthEllipsoid)
      ? earthEllipsoid.maximumRadius
      : Ellipsoid.default.maximumRadius;
    const physicalDepthGap = defined(camera)
      ? computeMoonPhysicalDepthGap(
          camera.positionWC,
          translation,
          moonRadius,
          earthRadius,
        )
      : Number.POSITIVE_INFINITY;
    this._physicalDepthDistanceDemand = updateMoonPhysicalDepthDemand(
      this._physicalDepthDistanceDemand,
      physicalDepthGap,
      moonRadius,
    );

    const passes = frameState.passes;
    const frustum = camera?.frustum;
    const perspective =
      frustum instanceof PerspectiveFrustum ||
      frustum instanceof PerspectiveOffCenterFrustum;
    const globeTranslucent =
      frameState.globeTranslucencyState?.translucent === true;
    this._physicalDepthClearGlobeDepth =
      depthRouteState?.clearGlobeDepth === true;
    const physicalDepthEligible =
      passes.render === true &&
      passes.pick !== true &&
      passes.pickVoxel !== true &&
      passes.offscreen !== true &&
      frameState.mode === SceneMode.SCENE3D &&
      perspective &&
      frameState.globeVisible === true &&
      !globeTranslucent;
    this._physicalDepthPrewarmRequested =
      physicalDepthEligible &&
      shouldPrewarmMoonPhysicalDepth(physicalDepthGap, moonRadius);
    this._physicalDepthRequested =
      physicalDepthEligible && this._physicalDepthDistanceDemand;

    Matrix4.fromRotationTranslation(
      rotation,
      translation,
      ellipsoidPrimitive.modelMatrix,
    );

    // Publish moon ephemeris onto frameState for renderers (Moon fragment
    // shader, atmosphere, night-side lighting). `translation` is the moon
    // position in world coords (earth-centered fixed frame), so its
    // normalized form is the world-space direction from the earth center
    // toward the moon.
    const moonDirWC = Cartesian3.normalize(translation, scratchMoonDirWC);

    // Pull sun direction (WC) from the per-frame uniform state. Scene.js
    // updates uniformState before calling Moon.update, so this is current.
    let phaseFraction = 1.0;
    const uniformState = defined(frameState.context)
      ? frameState.context.uniformState
      : undefined;
    if (defined(uniformState) && defined(uniformState.sunDirectionWC)) {
      const sunDirWC = uniformState.sunDirectionWC;
      const sunLenSq = Cartesian3.magnitudeSquared(sunDirWC);
      const moonLenSq = Cartesian3.magnitudeSquared(moonDirWC);
      if (sunLenSq > 0.0 && moonLenSq > 0.0) {
        // 0 = new moon (sun and moon in same direction), 0.5 = quarter,
        // 1 = full moon (opposite directions).
        const cosAngle = Cartesian3.dot(moonDirWC, sunDirWC);
        phaseFraction = 0.5 * (1.0 - cosAngle);
      } else {
        phaseFraction = 0.5;
      }
    }

    // Gate on atmospheric-conditions lighting toggle. When disabled or when
    // no globe is attached, fall back to "always full" (1.0) — the simpler
    // flat disc shading.
    const ac = frameState.atmosphericConditions;
    const enableMoonPhase =
      defined(ac) && defined(ac.lighting) ? ac.lighting.enableMoonPhase : false;
    if (!enableMoonPhase) {
      phaseFraction = 1.0;
    }

    frameState.moonDirectionWC = Cartesian3.clone(
      moonDirWC,
      frameState.moonDirectionWC,
    );
    frameState.moonPhaseFraction = phaseFraction;

    // Attenuate and redden the moon by the atmospheric optical path along the
    // view ray. `translation` is the moon position in Earth-centered fixed
    // coordinates; the extinction integrates the Rayleigh/Mie optical depth
    // from the camera to the moon through the atmosphere shell. Gated on the
    // sky atmosphere actually being rendered so the moon is byte-identical
    // when the atmosphere is hidden, and the physics yields exactly
    // Cartesian3.ONE from orbit (ray never crosses the shell) — so the
    // off-gate is byte-identical there too.
    const camPos = defined(frameState.camera)
      ? frameState.camera.positionWC
      : undefined;
    const extinctionEnabled =
      frameState.skyAtmosphereVisible === true &&
      defined(frameState.atmosphere) &&
      defined(camPos);
    // Cached shared integrator. When disabled it returns the exact
    // multiplicative identity (1,1,1), and from orbit the ray never crosses
    // the shell so the physics also yields that identity.
    const extinction = computeAtmosphereExtinctionCached(
      this._atmosphereExtinctionCache,
      scratchExtinction,
      extinctionEnabled,
      camPos,
      translation,
      frameState.atmosphere,
      Ellipsoid.default.maximumRadius,
    );
    frameState.moonAtmosphereExtinction = Cartesian3.clone(
      extinction,
      frameState.moonAtmosphereExtinction,
    );
    // Hand the extinction to the WebGL moon primitive. Undefined disables the
    // shader path (byte-identical) when the atmosphere is hidden.
    ellipsoidPrimitive.atmosphereExtinction =
      frameState.skyAtmosphereVisible === true ? extinction : undefined;

    // Atmospheric in-scattering (sky-wash), the additive half of the transfer
    // the extinction above is the multiplicative half of. The opaque disc is
    // drawn over the sky-atmosphere shell, so without this term the disc
    // loses the sky radiance its neighboring pixels keep and a daytime moon
    // reads as a dark cutout. The CPU integral mirrors the sky shader's own
    // single-scattering model (see computeAtmosphereInscatter) so the disc
    // blends into the rendered sky:
    //     disc = discColor × extinction + inscatter.
    // Gated on the same skyAtmosphereVisible condition as the extinction
    // plus the atmosphericConditions.lighting.enableMoonSkyWash toggle;
    // disabled (or from orbit, where the ray misses the shell) the wash is
    // exactly (0,0,0) — the additive identity, byte-identical.
    const lighting =
      defined(ac) && defined(ac.lighting) ? ac.lighting : undefined;
    const sunDirWCForWash =
      defined(uniformState) && defined(uniformState.sunDirectionWC)
        ? uniformState.sunDirectionWC
        : undefined;
    const washEnabled =
      extinctionEnabled &&
      defined(sunDirWCForWash) &&
      defined(lighting) &&
      lighting.enableMoonSkyWash === true;
    // Display-space matching: with HDR off (the default) the sky FS
    // tonemaps in-shader, so the wash applies the same transform; with HDR
    // on the wash stays linear and rides the post-process tonemap.
    const applyWashTonemap = frameState.useHDR !== true;
    const washGamma =
      defined(uniformState) && defined(uniformState.gamma)
        ? uniformState.gamma
        : 2.2;
    const inscatter = computeAtmosphereInscatterCached(
      this._atmosphereInscatterCache,
      scratchInscatter,
      washEnabled,
      camPos,
      translation,
      sunDirWCForWash,
      frameState.atmosphere,
      Ellipsoid.default.maximumRadius,
      applyWashTonemap,
      washGamma,
    );
    frameState.moonAtmosphereInscatter = Cartesian3.clone(
      inscatter,
      frameState.moonAtmosphereInscatter,
    );
    // Hand the wash to the WebGL moon primitive. Undefined disables the
    // shader path (no define, byte-identical) when the wash is off.
    ellipsoidPrimitive.atmosphereInscatter = washEnabled
      ? inscatter
      : undefined;

    // Lommel-Seeliger lunar reflectance toggle. The shader-side branch (both
    // backends) replaces the Lambert disc law with the lunar regolith law;
    // the flag just routes it. Defaults on through
    // AtmosphericConditions.lighting.enableLunarBRDF.
    const lunarBRDF = defined(lighting) && lighting.enableLunarBRDF === true;
    ellipsoidPrimitive.lunarBRDF = lunarBRDF;

    // Opposition surge: one CPU-side Hapke-SHOE multiplier from the true
    // Sun–Moon–observer phase angle (constant across the distant disc),
    // passed as a single uniform. 1.0 (identity) when disabled or away from
    // opposition.
    const surgeEnabled =
      defined(lighting) && lighting.enableOppositionSurge === true;
    let oppositionSurge = 1.0;
    if (
      surgeEnabled &&
      defined(uniformState) &&
      defined(uniformState.sunPositionWC) &&
      defined(camPos)
    ) {
      const moonToSun = Cartesian3.subtract(
        uniformState.sunPositionWC,
        translation,
        scratchMoonToSun,
      );
      const moonToCamera = Cartesian3.subtract(
        camPos,
        translation,
        scratchMoonToCamera,
      );
      const sunDistance = Cartesian3.magnitude(moonToSun);
      const cameraDistance = Cartesian3.magnitude(moonToCamera);
      if (sunDistance > 0.0 && cameraDistance > 0.0) {
        let cosPhaseAngle =
          Cartesian3.dot(moonToSun, moonToCamera) /
          (sunDistance * cameraDistance);
        cosPhaseAngle = Math.min(Math.max(cosPhaseAngle, -1.0), 1.0);
        oppositionSurge = computeLunarOppositionSurge(Math.acos(cosPhaseAngle));
      }
    }
    frameState.moonOppositionSurge = oppositionSurge;
    ellipsoidPrimitive.oppositionSurge = surgeEnabled
      ? oppositionSurge
      : undefined;

    // The LOLA relief strength is resolved once here, before the backend
    // branch, folding together the three things that can switch it off: the
    // lighting toggle, the variant gate (Moon.Variant.SMALL ships no map),
    // and the user's own dial. Both backends then read this single number, so
    // they cannot disagree about whether relief is on — the failure mode
    // where one backend is subtly rougher than the other is exactly what a
    // per-backend gate produces.
    const normalMapEnabled =
      defined(lighting) && lighting.enableLunarNormalMap === true;
    const normalMapStrength = resolveMoonNormalMapStrength(
      this.normalMapUrl,
      normalMapEnabled,
      this.normalMapStrength,
    );
    const normalMapDemand = normalMapStrength > 0.0;
    frameState.moonNormalMapStrength = normalMapStrength;

    // Both moon-phase appearance terms are resolved once here, before the
    // backend branch, for the same reason the relief strength is: two
    // independently derived gates are how one backend ends up subtly
    // different from the other.
    //
    // The solar angular radius uses the true Sun→Moon distance, which varies
    // ±1.7% over a year with Earth's orbital eccentricity; the mean value is
    // the fallback when the frame carries no sun position.
    const sunPositionWC = defined(uniformState)
      ? uniformState.sunPositionWC
      : undefined;
    const sunDistanceFromMoon = defined(sunPositionWC)
      ? Cartesian3.magnitude(
          Cartesian3.subtract(sunPositionWC, translation, scratchSunFromMoon),
        )
      : undefined;
    const phaseAppearance = readMoonPhaseAppearance(
      lighting,
      enableMoonPhase,
      phaseFraction,
      sunDistanceFromMoon,
      this._phaseAppearance,
    );
    frameState.moonEarthshinePhaseScale = phaseAppearance.earthshinePhaseScale;
    frameState.moonTerminatorSoftness = phaseAppearance.terminatorSoftness;

    // Hand both to the WebGL moon primitive. `undefined` compiles the term
    // out of EllipsoidFS entirely (byte-identical); earthshine additionally
    // rides the existing `enableEarthshine` master toggle, which the WGSL
    // twin reads as its own `enableEarthshine` uniform.
    const earthshineEnabled =
      defined(lighting) && lighting.enableEarthshine === true;
    ellipsoidPrimitive.earthshinePhaseScale = earthshineEnabled
      ? phaseAppearance.earthshinePhaseScale
      : undefined;
    ellipsoidPrimitive.terminatorSoftness = phaseAppearance.softTerminator
      ? phaseAppearance.terminatorSoftness
      : undefined;

    // Backend-specific path — delegate to feature renderer if available
    const context = frameState.context;
    const fr = context.getFeatureRenderer(FeatureRendererKey.MOON);
    if (fr) {
      this._featureRenderer = fr;
      const savedCommandList = frameState.commandList;
      frameState.commandList = scratchCommandList;
      scratchCommandList.length = 0;
      fr.update(this, frameState, scratchCommandList);
      frameState.commandList = savedCommandList;
      return routeMoonCommand(this, frameState, savedCommandList);
    }

    // Only the WebGL fallback consumes the shared decoded-source cache here.
    // Promise callbacks stage sources; this update synchronously realizes and
    // publishes the WebGL textures. The Material uniform is always either a
    // Texture or its default sentinel, never a URL, so the legacy Material
    // loader cannot issue a duplicate request.
    const webGLTexturesPending = this._updateWebGLMoonTextures(
      context,
      normalMapDemand,
    );
    if (
      webGLTexturesPending &&
      defined(frameState.afterRender) &&
      !frameState.afterRender.includes(
        requestRenderForWebGLMoonTextureLifecycle,
      )
    ) {
      // RequestScheduler wakes WebGL after network fetch, but the shared
      // cache may still be decoding/preparing an ImageBitmap. Keep explicit-
      // render scenes awake only while one of the two Moon channels is
      // pending, then stop immediately after frame-owned realization.
      frameState.afterRender.push(requestRenderForWebGLMoonTextureLifecycle);
    }

    // The exact predicate that admitted each texture's mip chain also selects
    // its explicit-gradient shader branch. Keep the channels independent so a
    // custom NPOT normal map cannot make a legal albedo mip chain lose its
    // seam-safe gradient sampling (or vice versa).
    const albedoTexture = this._albedoMapTexture;
    ellipsoidPrimitive.lunarAlbedoExplicitGradients =
      defined(albedoTexture) &&
      canGenerateWebGLMoonMipmaps(
        context,
        albedoTexture.width,
        albedoTexture.height,
      );
    const normalTexture = normalMapDemand ? this._normalMapTexture : undefined;
    ellipsoidPrimitive.lunarNormalExplicitGradients =
      defined(normalTexture) &&
      canGenerateWebGLMoonMipmaps(
        context,
        normalTexture.width,
        normalTexture.height,
      );
    ellipsoidPrimitive.lunarNormalMap = normalMapDemand
      ? this._normalMapTexture
      : undefined;
    ellipsoidPrimitive.lunarNormalStrength = normalMapStrength;

    // WebGL can take the physical route only when a sampleable packed globe
    // depth and fragment-depth writes both exist.  Otherwise the exact legacy
    // ENVIRONMENT command remains the feature-preserving fallback.
    const webGLPhysicalDepth =
      this._physicalDepthRequested &&
      context.depthTexture === true &&
      context.fragmentDepth === true;
    ellipsoidPrimitive._moonPhysicalDepth = webGLPhysicalDepth;
    ellipsoidPrimitive._moonPackedGlobeDepthCompare =
      webGLPhysicalDepth && this._physicalDepthClearGlobeDepth;

    const savedCommandList = frameState.commandList;
    frameState.commandList = scratchCommandList;
    scratchCommandList.length = 0;
    ellipsoidPrimitive.update(frameState);
    frameState.commandList = savedCommandList;
    return routeMoonCommand(this, frameState, savedCommandList);
  }

  /**
   * Reconcile both WebGL Moon texture channels against their exact
   * owner/context/URL/pair identity, then synchronously realize any staged
   * decoded source. Matching normal GPU state remains resident while relief
   * is off, but the caller passes `undefined` to `lunarNormalMap` so the
   * define and sampler disappear.
   *
   * @private
   */
  _updateWebGLMoonTextures(context, normalDemand) {
    let lifecycle = this._webglMoonTextureLifecycle;
    if (!defined(lifecycle) || lifecycle.context !== context) {
      const retired = retireWebGLMoonTextureLifecycle(
        lifecycle,
        "context changed",
      );
      // Material owns an adopted albedo Texture. Publishing the default
      // sentinel lets its next update destroy that old-context realization
      // exactly once. The normal map is Moon-owned and can retire now.
      const material = this._ellipsoidPrimitive.material;
      const retiredAlbedo = retired.albedo ?? this._albedoMapTexture;
      destroyUnadoptedWebGLMoonAlbedo(material, retiredAlbedo);
      this._albedoMapTexture = undefined;
      material.uniforms.image = Material.DefaultImageId;
      const retiredNormal = retired.normal ?? this._normalMapTexture;
      destroyWebGLMoonTexture(retiredNormal);
      this._normalMapTexture = undefined;
      this._normalMapTextureUrl = undefined;
      lifecycle = createWebGLMoonTextureLifecycle(this, context);
    }

    let pairKey = this._webglMoonTexturePairKey;
    if (
      this._webglMoonTexturePairAlbedoUrl !== this.textureUrl ||
      this._webglMoonTexturePairNormalUrl !== this.normalMapUrl
    ) {
      this._webglMoonTexturePairAlbedoUrl = this.textureUrl;
      this._webglMoonTexturePairNormalUrl = this.normalMapUrl;
      pairKey = this._webglMoonTexturePairKey = createWebGLMoonTexturePairKey(
        this.textureUrl,
        this.normalMapUrl,
      );
    }
    const albedoOptions = this._webglMoonAlbedoReconcileOptions;
    albedoOptions.context = context;
    albedoOptions.url = this.textureUrl;
    albedoOptions.pairKey = pairKey;
    albedoOptions.demanded = defined(this.textureUrl);
    const albedoResult = reconcileWebGLMoonTextureChannel(
      lifecycle,
      WebGLMoonTextureChannel.ALBEDO,
      albedoOptions,
    );
    if (albedoResult.retireCurrent) {
      const retirement = retireWebGLMoonPublishedTexture(
        lifecycle,
        WebGLMoonTextureChannel.ALBEDO,
      );
      destroyUnadoptedWebGLMoonAlbedo(
        this._ellipsoidPrimitive.material,
        retirement.previous,
      );
      this._albedoMapTexture = undefined;
    }

    const normalOptions = this._webglMoonNormalReconcileOptions;
    normalOptions.context = context;
    normalOptions.url = this.normalMapUrl;
    normalOptions.pairKey = pairKey;
    normalOptions.demanded = normalDemand;
    const normalResult = reconcileWebGLMoonTextureChannel(
      lifecycle,
      WebGLMoonTextureChannel.NORMAL,
      normalOptions,
    );
    if (normalResult.retireCurrent) {
      const retirement = retireWebGLMoonPublishedTexture(
        lifecycle,
        WebGLMoonTextureChannel.NORMAL,
      );
      destroyWebGLMoonTexture(retirement.previous);
      this._normalMapTexture = undefined;
      this._normalMapTextureUrl = undefined;
    }

    const albedoCommit = commitWebGLMoonTextureChannel(
      lifecycle,
      WebGLMoonTextureChannel.ALBEDO,
      context,
      createWebGLMoonTexture,
      destroyWebGLMoonTexture,
    );
    if (albedoCommit.committed) {
      this._albedoMapTexture = albedoCommit.value;
      // The Material update below adopts the new Texture and destroys its
      // previous adopted realization. Do not destroy albedoCommit.previous
      // here: that would double-retire Material-owned state.
      destroyUnadoptedWebGLMoonAlbedo(
        this._ellipsoidPrimitive.material,
        albedoCommit.previous,
      );
    }

    const normalCommit = commitWebGLMoonTextureChannel(
      lifecycle,
      WebGLMoonTextureChannel.NORMAL,
      context,
      createWebGLMoonTexture,
      destroyWebGLMoonTexture,
    );
    if (normalCommit.committed) {
      this._normalMapTexture = normalCommit.value;
      this._normalMapTextureUrl = normalCommit.identity.exactUrl;
      destroyWebGLMoonTexture(normalCommit.previous);
    }

    const material = this._ellipsoidPrimitive.material;
    material.uniforms.image = this._albedoMapTexture ?? Material.DefaultImageId;
    this._normalMapLoading =
      defined(lifecycle.channels.normal.request) ||
      defined(lifecycle.channels.normal.staged);
    return (
      defined(lifecycle.channels.albedo.request) ||
      defined(lifecycle.channels.albedo.staged) ||
      this._normalMapLoading
    );
  }

  /**
   * Returns a diagnostic snapshot of the moon's current per-frame state.
   * Backend-agnostic dispatch: routes through the registered moon feature
   * renderer's `getStatistics(moon)` entry point so Scene code can call this
   * without importing from `Renderer/WebGPU/`. With no feature renderer
   * registered (the WebGL backend) the equivalent WebGL snapshot is returned
   * instead. Returns `null` when there is no scene context, or when the moon
   * hasn't yet had its first `update()` call.
   *
   * @param {Scene} scene The owning scene; used to obtain the active
   *   GraphicsContext for the feature renderer lookup.
   * @returns {object|null}
   */
  getDebugStatistics(scene) {
    if (!defined(scene) || !defined(scene.context)) {
      return null;
    }
    const fr = scene.context.getFeatureRenderer(FeatureRendererKey.MOON);
    if (!defined(fr) || typeof fr.getStatistics !== "function") {
      const lifecycle = getWebGLMoonTextureLifecycleDiagnostics(
        this._webglMoonTextureLifecycle,
      );
      if (!defined(lifecycle)) {
        return null;
      }
      const albedoMipLevelCount = getWebGLMoonTextureMipLevelCount(
        this._albedoMapTexture,
      );
      const normalMipLevelCount = getWebGLMoonTextureMipLevelCount(
        this._normalMapTexture,
      );
      return Object.freeze({
        backend: "webgl",
        moonTextureWidth: this._albedoMapTexture?.width ?? null,
        moonTextureHeight: this._albedoMapTexture?.height ?? null,
        normalTextureWidth: this._normalMapTexture?.width ?? null,
        normalTextureHeight: this._normalMapTexture?.height ?? null,
        lifecycle,
        sourceCache: getSharedMoonDecodedSourceCache().getDiagnostics(),
        albedoTextureLoaded: lifecycle.albedo.realTexture,
        moonTextureLoaded: lifecycle.albedo.realTexture,
        moonTextureUrl: lifecycle.albedo.currentUrl,
        moonTextureMipLevelCount: albedoMipLevelCount,
        moonTextureMaxLod:
          albedoMipLevelCount === null ? null : albedoMipLevelCount - 1,
        normalTextureLoaded: lifecycle.normal.realTexture,
        normalMapLoaded: lifecycle.normal.realTexture,
        normalMapUrl: lifecycle.normal.currentUrl,
        normalTextureMipLevelCount: normalMipLevelCount,
        normalTextureMaxLod:
          normalMipLevelCount === null ? null : normalMipLevelCount - 1,
        normalTextureBound: defined(this._ellipsoidPrimitive?.lunarNormalMap),
        albedoExplicitGradients:
          this._ellipsoidPrimitive?.lunarAlbedoExplicitGradients === true,
        normalExplicitGradients:
          this._ellipsoidPrimitive?.lunarNormalExplicitGradients === true,
      });
    }
    try {
      return fr.getStatistics(this);
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see Moon#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * moon = moon && moon.destroy();
   *
   * @see Moon#isDestroyed
   */
  destroy() {
    retireWebGLMoonTextureLifecycle(
      this._webglMoonTextureLifecycle,
      "owner destroyed",
    );
    this._webglMoonTextureLifecycle = undefined;
    this._normalMapTexture =
      this._normalMapTexture && this._normalMapTexture.destroy();
    this._normalMapTextureUrl = undefined;
    this._normalMapLoading = false;
    // EllipsoidPrimitive intentionally does not own/destroy its Material.
    // Moon does, and Material owns the adopted WebGL albedo Texture.
    const material = this._ellipsoidPrimitive?.material;
    destroyUnadoptedWebGLMoonAlbedo(material, this._albedoMapTexture);
    this._albedoMapTexture = undefined;
    if (defined(material) && !material.isDestroyed()) {
      material.destroy();
    }
    this._ellipsoidPrimitive =
      this._ellipsoidPrimitive && this._ellipsoidPrimitive.destroy();
    if (
      defined(this._featureRenderer) &&
      defined(this._featureRenderer.destroy)
    ) {
      this._featureRenderer.destroy(this);
    }
    return destroyObject(this);
  }
}

/**
 * Selectable bundled albedo maps for {@link Moon}.
 *
 * Enumerated rather than raw strings so a typo fails loudly in debug builds
 * instead of silently 404-ing the moon into its placeholder. Mirrors
 * {@link SkyBox.Variant}, which does the same for the bundled star maps.
 *
 * Both variants use the same projection — equirectangular, centred on 0°
 * longitude, east right, north at the top of the image — so switching between
 * them changes only resolution and source, never orientation.
 *
 * A variant selects a pairing, not just an albedo: it also decides whether the
 * moon carries LOLA-derived surface relief. See
 * {@link Moon.getVariantNormalMapUrl}.
 *
 * @enum {string}
 * @readonly
 */
Moon.Variant = Object.freeze({
  /**
   * The historical 256×128 `moonSmall.jpg` inherited from upstream Cesium.
   * At the ~190 px disc of a zoomed-in view its visible hemisphere is only
   * 128 texels — 0.67 texels/px, i.e. under-resolved. Retained as the
   * low-bandwidth option (17.8 KB) and as the fallback if an application
   * prefers the historical look.
   */
  SMALL: "SMALL",
  /**
   * NASA/GSFC SVS 4720 "CGI Moon Kit" 2019 colour map at 2048×1024, the
   * default variant. Derived from the LROC Wide Angle Camera "Hapke
   * normalized" mosaic, gamma corrected and white balanced by SVS to
   * approximate human vision. Bundled offline at 550 KB (JPEG q90 4:4:4) by
   * the reproducible pipeline at `Tools/moon-albedo-bake/`. The asset's terms
   * are stated in `LICENSE.md` → Bundled Engine Assets.
   */
  LROC_COLOR_2K: "LROC_COLOR_2K",
});

const moonVariants = {
  [Moon.Variant.SMALL]: "Assets/Textures/moonSmall.jpg",
  [Moon.Variant.LROC_COLOR_2K]: "Assets/Textures/Moon/lroc_color_poles_2k.jpg",
};

/**
 * Normal map paired with each variant. `SMALL` deliberately has none: it is
 * the historical low-bandwidth option, and bolting 664 KB of relief onto a
 * 17.8 KB albedo would defeat its only reason to exist, so selecting it
 * preserves the legacy flat look exactly.
 *
 * The 2K variant pairs with a 1024x512 map rather than a 2048-wide one. At the
 * default ~16 px disc a 2048-wide map pays roughly 64:1 minification from
 * mip 0, so it shimmers the lighting unless the mip chain and the explicit
 * gradients hold up under camera motion. `--width 2048` in
 * `Tools/moon-albedo-bake/bake-lola-normals.mjs` re-bakes at the higher
 * resolution.
 */
const moonNormalMapVariants = {
  [Moon.Variant.SMALL]: undefined,
  [Moon.Variant.LROC_COLOR_2K]: "Assets/Textures/Moon/ldem_normal_1k.png",
};

/**
 * The variant {@link Moon} uses when neither `textureUrl` nor `variant` is
 * passed.
 *
 * `LROC_COLOR_2K` is the default because the historical 256×128 map is
 * under-resolved at any zoomed view. `SMALL` remains bundled and selectable;
 * both are offline.
 *
 * @type {string}
 * @default Moon.Variant.LROC_COLOR_2K
 */
Moon.defaultVariant = Moon.Variant.LROC_COLOR_2K;

/**
 * Resolves a {@link Moon.Variant} to the URL of its bundled albedo map.
 *
 * @param {string} [variant] One of {@link Moon.Variant}. Defaults to
 *        {@link Moon.defaultVariant}.
 * @returns {string} The module-relative URL of the variant's texture.
 */
Moon.getVariantTextureUrl = function (variant) {
  const v = variant ?? Moon.defaultVariant;
  // Own-property lookup only: a bare `moonVariants[v]` resolves inherited
  // Object.prototype keys, so `variant: "constructor"` would sail past the
  // defined() guard and hand buildModuleUrl a function.
  const asset = Object.prototype.hasOwnProperty.call(moonVariants, v)
    ? moonVariants[v]
    : undefined;
  //>>includeStart('debug', pragmas.debug);
  if (!defined(asset)) {
    throw new DeveloperError(
      `Unknown Moon variant "${v}". Valid values are: ${Object.keys(moonVariants).join(", ")}`,
    );
  }
  //>>includeEnd('debug');
  return buildModuleUrl(asset ?? moonVariants[Moon.Variant.LROC_COLOR_2K]);
};

/**
 * Resolves a {@link Moon.Variant} to the URL of its bundled tangent-space
 * normal map, or <code>undefined</code> when the variant ships none.
 *
 * @param {string} [variant] One of {@link Moon.Variant}. Defaults to
 *        {@link Moon.defaultVariant}.
 * @returns {string|undefined} The module-relative URL, or undefined.
 */
Moon.getVariantNormalMapUrl = function (variant) {
  const v = variant ?? Moon.defaultVariant;
  // Own-property lookup only, for the same reason getVariantTextureUrl does
  // it: a bare index would resolve inherited Object.prototype keys.
  const known = Object.prototype.hasOwnProperty.call(moonNormalMapVariants, v);
  //>>includeStart('debug', pragmas.debug);
  if (!known) {
    throw new DeveloperError(
      `Unknown Moon variant "${v}". Valid values are: ${Object.keys(moonVariants).join(", ")}`,
    );
  }
  //>>includeEnd('debug');
  const asset = known ? moonNormalMapVariants[v] : undefined;
  return defined(asset) ? buildModuleUrl(asset) : undefined;
};

/**
 * Publish the route a backend actually emitted.  This is not the distance
 * demand: a lazy WebGPU physical pipeline may still have emitted the legacy
 * environment command for this frame.
 *
 * @private
 */
function publishMoonPhysicalDepthRoute(moon, frameState, physical) {
  const changed = moon._physicalDepthActual !== physical;
  moon._physicalDepthActual = physical;
  if (changed) {
    frameState._moonPhysicalDepthRouteChanged = true;
  }
}

/**
 * Transfer exactly one backend command out of the scratch list.  Physical
 * commands become ordinary scene commands; legacy commands retain the
 * historical `Moon.update` return ownership used by EnvironmentRenderer.
 *
 * @private
 */
function routeMoonCommand(moon, frameState, sceneCommandList) {
  const command =
    scratchCommandList.length === 1 ? scratchCommandList[0] : undefined;
  const physical = command?._moonPhysicalDepthRoute === true;
  publishMoonPhysicalDepthRoute(moon, frameState, physical);
  if (physical) {
    sceneCommandList.push(command);
    return undefined;
  }
  return command;
}

const icrfToFixed = new Matrix3();
const rotationScratch = new Matrix3();
const translationScratch = new Cartesian3();
const scratchMoonDirWC = new Cartesian3();
const scratchExtinction = new Cartesian3();
const scratchInscatter = new Cartesian3();
const scratchMoonToSun = new Cartesian3();
const scratchSunFromMoon = new Cartesian3();
const scratchMoonToCamera = new Cartesian3();
const scratchCommandList = [];

export default Moon;
export {
  computeMoonPhysicalDepthGap,
  configureWebGLMoonTextureCandidate,
  shouldPrewarmMoonPhysicalDepth,
  updateMoonPhysicalDepthDemand,
};
