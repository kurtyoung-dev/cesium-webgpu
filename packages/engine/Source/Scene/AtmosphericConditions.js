import Cartesian3 from "../Core/Cartesian3.js";
import CloudRenderMode from "./CloudRenderMode.js";
import defined from "../Core/defined.js";
import {
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
} from "./StarFieldMath.js";

/**
 * Canonical, domain-grouped facade for the atmosphere, fog, cloud, weather and
 * night-lighting state, reached as `scene.globe.atmosphericConditions`.
 *
 * Its getters and setters read and write through to whichever object already
 * owns each value — `Scene.atmosphere`, `Scene.fog`, `Scene.skyAtmosphere`,
 * `Globe`, and a handful of `Scene._weather*` fields. Nothing is copied or
 * migrated: those properties stay the source of truth and the rest of the
 * engine keeps reading them directly, so the existing Cesium APIs continue to
 * work unchanged.
 *
 * State with no such owner — `volumetricFog`, `varyingAtmosphereDensity`, the
 * lighting flags, the cloud volumetrics, `skyAtmosphere.starModulationCurve`
 * and `groundAtmosphere.perFragment` — is stored directly on the facade
 * instead.
 *
 * Leaf objects are plain objects with get/set thunks installed by the
 * constructor via {@link Object.defineProperties}. Sub-facades never close
 * over `this`; they close over the `scene` and `globe` captured at
 * construction time.
 *
 * @alias AtmosphericConditions
 * @constructor
 *
 * @param {Scene} scene The owning Scene. The facade reads `scene.atmosphere`,
 *   `scene.fog`, `scene.skyAtmosphere`, and the weather fields from it.
 * @param {Globe} globe The owning Globe. The facade reads the atmosphere,
 *   cloud, night, and lighting properties from it.
 */
class AtmosphericConditions {
  constructor(scene, globe) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene)) {
      throw new Error("scene is required");
    }
    if (!defined(globe)) {
      throw new Error("globe is required");
    }
    //>>includeEnd('debug');

    this._scene = scene;
    this._globe = globe;

    // Build leaves once. Each leaf is a plain object whose property descriptors
    // close over `scene`/`globe`.
    this._scattering = buildScattering(scene, globe);
    this._lighting = buildLighting(globe);
    this._skyAtmosphere = buildSkyAtmosphere(scene);
    this._groundAtmosphere = buildGroundAtmosphere(globe);
    this._atmosphere = buildAtmosphere(scene);
    this._fog = buildFog(scene);
    this._volumetricFog = buildVolumetricFog();
    this._varyingAtmosphereDensity = buildVaryingAtmosphereDensity();
    this._clouds = buildClouds(globe);
    this._weather = buildWeather(scene, globe);
    this._night = buildNight(globe);
    this._effects = buildEffects();
  }

  /**
   * Returns a JSON-serializable snapshot of the facade state. The snapshot
   * covers the scattering leaf only, and flattens its `Cartesian3` values to
   * plain `{x, y, z}` objects so the result survives `JSON.stringify`.
   * @returns {object} a plain-object snapshot (deep-cloned)
   */
  clone() {
    const snapshot = {
      scattering: {
        rayleighCoefficient: cloneCartesian3(
          this._scattering.rayleighCoefficient,
        ),
        mieCoefficient: cloneCartesian3(this._scattering.mieCoefficient),
        rayleighScaleHeight: this._scattering.rayleighScaleHeight,
        mieScaleHeight: this._scattering.mieScaleHeight,
        mieAnisotropy: this._scattering.mieAnisotropy,
      },
    };
    return JSON.parse(JSON.stringify(snapshot));
  }

  /**
   * Unified scattering coefficients. Setters fan out to `scene.atmosphere`,
   * `scene.skyAtmosphere`, and the `Globe` atmosphere fields so all three
   * consumers stay in lock-step. Getters read from `scene.atmosphere` as the
   * canonical reader.
   * @type {object}
   * @readonly
   */
  get scattering() {
    return this._scattering;
  }

  /**
   * Lighting flags. `lambertDiffuseMultiplier`, `vertexShadowDarkness`,
   * `dynamicAtmosphereLighting` and `dynamicAtmosphereLightingFromSun`
   * delegate to `Globe`; every other property on this leaf is stored on the
   * facade itself.
   *
   * `enableSunLight`, `enableMoonLight`, `enableMoonPhase` and
   * `enableEarthshine` gate the basic light contributions. The moon-appearance
   * toggles `enableLunarBRDF`, `enableOppositionSurge`, `enableMoonSkyWash` and
   * `enableLunarNormalMap` all default on and are implemented on both backends.
   * `enableEclipse` (default on, both backends) gates whether consumers apply
   * `frameState.eclipseState`, and `eclipseAutoExposure` (default off) selects
   * the camera-metering transfer function in place of the human-eye impression.
   *
   * `enableSolarLimbDarkening` and `enableSolarGlareFalloff` are resolved once
   * per frame by `Scene/SunDiscAppearance.js` and published as
   * `frameState.sunDiscAppearance`. `enableEarthshinePhase` and
   * `enableSoftTerminator` are resolved by `Scene/MoonPhaseAppearance.js` and
   * published as `frameState.moonEarthshinePhaseScale` and
   * `frameState.moonTerminatorSoftness`. `enableAngularSolarGlare` is resolved
   * by `Scene/SolarGlareAppearance.js` and published as
   * `frameState.solarGlareAppearance`. All five default on, run on both
   * backends, and take an exact identity position when false: a glare strength
   * of 0, for instance, makes every consumer skip its whole glare block rather
   * than evaluate a near-zero one.
   *
   * Every default named above is the value stored here, which is not the same
   * as the value a globe-less scene sees. `Scene.js` publishes
   * `frameState.atmosphericConditions` as `undefined` when there is no globe —
   * a supported configuration for pure 3D Tiles, CAD and model-viewer scenes —
   * so each resolver's own absent-facade convention decides the effective
   * position, and those conventions differ:
   *   - Read as `!== false`, hence on without a facade:
   *     `enableSolarLimbDarkening` and `enableSolarGlareFalloff`
   *     (`Scene/SunDiscAppearance.js`), `enableTrueSolarDiscSize` and
   *     `enableScreenSpaceSunHalo` (`Scene/SunHaloAppearance.js`),
   *     `enableEclipse` (`Scene.js`).
   *   - Read as `=== true`, hence off without a facade, which leaves such a
   *     scene's lunar appearance unmodified: `enableEarthshinePhase` and
   *     `enableSoftTerminator` (`Scene/MoonPhaseAppearance.js`),
   *     `enableAngularSolarGlare` (`Scene/SolarGlareAppearance.js`), and the
   *     four moon-appearance toggles plus `enableMoonPhase` and
   *     `enableEarthshine` (`Scene/Moon.js`).
   *
   * A globe-less scene therefore renders the shaped sun disc alongside a hard
   * lunar terminator. The two groups match in stored default and in
   * identity-when-false, but not in what happens when the facade is missing.
   * @type {object}
   * @readonly
   */
  get lighting() {
    return this._lighting;
  }

  /**
   * Sky atmosphere facade over `scene.skyAtmosphere`. Also holds the
   * `starModulationCurve` state, which has no backing store elsewhere.
   * @type {object}
   * @readonly
   */
  get skyAtmosphere() {
    return this._skyAtmosphere;
  }

  /**
   * Ground atmosphere facade over the matching `Globe` fields. Adds
   * `perFragment` state, which is stored on the facade itself.
   * @type {object}
   * @readonly
   */
  get groundAtmosphere() {
    return this._groundAtmosphere;
  }

  /**
   * Thin mirror of `scene.atmosphere` (the shared Atmosphere object used
   * by 3D Tiles and models). Exposed here for symmetry and discoverability.
   * @type {object}
   * @readonly
   */
  get atmosphere() {
    return this._atmosphere;
  }

  /**
   * Fog facade over `scene.fog`.
   * @type {object}
   * @readonly
   */
  get fog() {
    return this._fog;
  }

  /**
   * Volumetric fog. Stored on the facade; there is no backing store elsewhere.
   * @type {object}
   * @readonly
   */
  get volumetricFog() {
    return this._volumetricFog;
  }

  /**
   * Varying atmosphere density. Stored on the facade; there is no backing
   * store elsewhere.
   * @type {object}
   * @readonly
   */
  get varyingAtmosphereDensity() {
    return this._varyingAtmosphereDensity;
  }

  /**
   * Clouds facade over the Globe cloud fields. New volumetric cloud state
   * is stored directly on the facade.
   * @type {object}
   * @readonly
   */
  get clouds() {
    return this._clouds;
  }

  /**
   * Weather facade over `scene._enableWeather` / `_weather*` fields. The
   * wind setter additionally fans out to the managed default cloud collection's
   * `volumetric.cloudWindSpeed` / `.cloudWindDirection` (single wind source).
   * @type {object}
   * @readonly
   */
  get weather() {
    return this._weather;
  }

  /**
   * Night lighting facade over Globe night fields.
   * @type {object}
   * @readonly
   */
  get night() {
    return this._night;
  }

  /**
   * Unified atmospheric effects hierarchy. Nests the screen-space and overlay
   * effects (`shimmer`, `groundFog`, `optics`, `precipitation`) that the
   * weather state {@link AtmosphericConditions#weather} drives. The master
   * `auto` flag, when true, makes {@link applyAtmosphericConditions} derive
   * each effect's `enabled` flag and intensity from the conditions
   * (temperature, dew-point spread, precipitation). Off by default, so an
   * existing scene renders unchanged until it opts in. Each effect leaf is
   * plain state with no backing store; a backend such as the WebGPU
   * heat-shimmer post-process reads it through the scene flags the auto-apply
   * pushes.
   * @type {object}
   * @readonly
   */
  get effects() {
    return this._effects;
  }
}

function cloneCartesian3(v) {
  if (!defined(v)) {
    return undefined;
  }
  return { x: v.x, y: v.y, z: v.z };
}

function buildScattering(scene, globe) {
  const leaf = {};
  Object.defineProperties(leaf, {
    rayleighCoefficient: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.rayleighCoefficient;
      },
      set: function (v) {
        scene.atmosphere.rayleighCoefficient = v;
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereRayleighCoefficient = v;
        }
        globe.atmosphereRayleighCoefficient = v;
      },
    },
    mieCoefficient: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.mieCoefficient;
      },
      set: function (v) {
        scene.atmosphere.mieCoefficient = v;
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereMieCoefficient = v;
        }
        globe.atmosphereMieCoefficient = v;
      },
    },
    rayleighScaleHeight: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.rayleighScaleHeight;
      },
      set: function (v) {
        scene.atmosphere.rayleighScaleHeight = v;
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereRayleighScaleHeight = v;
        }
        globe.atmosphereRayleighScaleHeight = v;
      },
    },
    mieScaleHeight: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.mieScaleHeight;
      },
      set: function (v) {
        scene.atmosphere.mieScaleHeight = v;
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereMieScaleHeight = v;
        }
        globe.atmosphereMieScaleHeight = v;
      },
    },
    mieAnisotropy: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.mieAnisotropy;
      },
      set: function (v) {
        scene.atmosphere.mieAnisotropy = v;
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereMieAnisotropy = v;
        }
        globe.atmosphereMieAnisotropy = v;
      },
    },
  });
  return leaf;
}

function buildLighting(globe) {
  // The fields in the literal below are stored on the leaf itself; the four
  // properties installed after it delegate to `Globe`.
  //
  // `enableDualLightAtmosphere` and the `moonIntensity` scale tune the
  // sky-atmosphere shader's dual-light path without a code change. Dual light
  // defaults on: the moon contribution is gated to zero while the moon is below
  // the horizon and is scaled by phase fraction, so the on position is
  // indistinguishable during the day and at new moon.
  //
  // The moon-appearance toggles default on and are implemented on both
  // backends in lockstep, never as a WebGPU-only default-on multiplier:
  //
  //  - enableLunarBRDF: Lommel-Seeliger regolith reflectance in place of
  //    Lambert, so the full moon reads as a flat bright disc.
  //  - enableOppositionSurge: CPU-side Hapke shadow-hiding brightness surge
  //    within a few degrees of opposition.
  //  - enableMoonSkyWash: additive in-scattered sky radiance over the disc
  //    (disc = disc × extinction + inscatter), so the daytime moon reads pale
  //    rather than as a dark cutout. Active only while the sky atmosphere is
  //    visible, and exactly zero from orbit.
  //  - enableLunarNormalMap: routes the LOLA-derived tangent-space relief onto
  //    the disc's lighting normal. Additionally gated by the moon variant:
  //    `Moon.Variant.SMALL` ships no normal map, so the toggle has no effect
  //    there and that variant stays flat-shaded. Visible mainly near the
  //    terminator, where N·L is small and a few degrees of surface tilt
  //    decides lit from unlit, and nearly invisible at full phase where
  //    N·L ≈ 1 and the cosine is flat. Off drives the shader's strength
  //    uniform to exactly 0, an identity perturbation on both backends.
  //
  // The eclipse response is split across separate flags so each part can be
  // probed in isolation:
  //
  //  - enableEclipse gates only whether consumers apply the active logical
  //    view's `frameState.eclipseState.sunVisibleFraction`. The eclipse
  //    geometry is computed unconditionally whenever that view is prepared, so
  //    tooling can read the physics with the effect switched off. With the
  //    flag false every consumer multiplies by exactly 1.0.
  //  - enableEclipseGlobeShadow gates only the per-fragment lunar umbra on the
  //    globe surface, leaving the sun fade and the observer-anchored scene
  //    dimming untouched. On the globe it supersedes the uniform dimming: the
  //    surface dims by G(O_fragment) rather than uniformly by G(O_camera).
  //  - eclipseAutoExposure selects which transfer function
  //    `EclipseState.getEclipseSceneLightFactor` applies to the flux fraction.
  //    Both positions dim; they differ only in the curve.
  //
  //    false (human eye) — the flux fraction is carried through the eye's own
  //      adaptation exponent (CIE L* / Stevens, ~1/3) before it reaches the
  //      lights, because with no auto-exposure in the chain nothing else
  //      performs that adaptation. Totality lands on the ~5-lux twilight floor
  //      (render factor ~0.0368) and the plunge from 99% obscuration is a ~6x
  //      collapse, so the darkness is preserved by construction.
  //
  //    true (camera) — the linear radiometric flux fraction is handed to the
  //      lights and the re-metering is left to the exposure chain, which is
  //      what a camera does. With `scene.highDynamicRange` and the auto-exposure
  //      stage on (`PostProcessStageCollection._autoExposureEnabled`, off by
  //      default), that stage measures the dimmed scene and compensates,
  //      washing the darkness out. With no exposure stage it renders the true
  //      radiometric plunge, which is what a fixed-exposure camera shows.
  //
  // The sun-bake toggles default on, run on both backends, and feed the bake
  // through `Scene/SunDiscAppearance.js`, which reads its numbers from
  // `Scene/SolarDiscModel.js` — one constants source, shared with
  // `computeSolarObscuration.js`:
  //
  //  - enableSolarLimbDarkening: the disc's radiance follows the quadratic law
  //    I(mu) = 0.3 + 0.93*mu - 0.23*mu^2 instead of a binary `step()` flat
  //    disc. Off passes (1, 0, 0), which is the flat disc exactly, not an
  //    approximation of it. At SDR defaults the effect is arithmetically
  //    masked: the bake clamps alpha to 1 and the glare term alone is ~0.73
  //    over the disc. The clamp count is asymmetric — one site in
  //    `SunTextureFS.glsl` (the final `clamp(color, 0, 1)`) against six in the
  //    WebGPU CPU twin `WebGPUEnvironmentRenderer.js`, and that file's 8-bit
  //    branch cannot carry values above 1 at all, so lifting the clamp there
  //    also means forcing the float format.
  //
  //  - enableSolarGlareFalloff: the halo uses a Lorentzian inverse-square
  //    veiling-glare profile that decays as 1/theta^2 and reaches zero only at
  //    the billboard's inscribed circle (11.0 solar radii), in place of
  //    `1 - smoothstep(0, 0.55, r)`, which terminated hard at 8.556 solar
  //    radii. Off selects that earlier expression verbatim. The delta inside 6
  //    solar radii is at most 0.098 in profile units (0.074 in alpha);
  //    `SolarDiscModel.solarGlareProfile`'s JSDoc carries the table.
  //
  // Two more sun toggles default on, run on both backends, and are resolved
  // once per frame by `Scene/SunHaloAppearance.js`:
  //
  //  - enableTrueSolarDiscSize: the baked disc terminates where the Sun's true
  //    angular radius falls rather than at 1/sqrt(2) of it. Both bakes compare
  //    a corner-normalised `radius` against a `radiusTS` expressed as a
  //    fraction of the quad's half-extent, which subtends 0.3767 deg of
  //    diameter instead of 0.5327 deg. Off returns
  //    `0.5 / (1 + 2*glowLengthTS)` bit-for-bit.
  //
  //  - enableScreenSpaceSunHalo: the halo is drawn by the post-process chain
  //    (`SolarHalo.glsl` inside `SunPostProcess` on WebGL, `SunHaloEffect` on
  //    WebGPU) instead of being baked into the billboard, so its veiling-glare
  //    tail decays as 1/theta^2 without the truncation a finite quad forces.
  //    Off keeps the baked halo verbatim and adds no post-process stage.
  //    Exactly one halo source is live at a time by construction: the bake's
  //    gain is derived from this toggle rather than set beside it. The
  //    screen-space halo also requires `scene.sunBloom` (default true) — with
  //    sun bloom off the baked halo is kept, so the Sun does not silently lose
  //    its glow.
  //
  // Two moon-phase toggles default on, run on both backends, and are resolved
  // once per frame by `Scene/MoonPhaseAppearance.js`:
  //
  //  - enableEarthshinePhase: scales earthshine by Earth's illuminated
  //    fraction as seen from the Moon, which is the exact complement of the
  //    Moon's phase seen from Earth. Earthshine therefore peaks at new moon
  //    and is exactly zero at full, where a constant term would be backwards.
  //    Off passes a scale of exactly 1.0, which is that constant.
  //  - enableSoftTerminator: the Sun subtends an angular radius of ~0.2664 deg
  //    (4.649e-3 rad) from the Moon, so the terminator is a penumbra rather
  //    than a step. Replaces `max(N.L, 0)` with the finite-disc irradiance
  //    inside that band, in the Lommel-Seeliger path only; the phong fallbacks
  //    run through shared czm builtins on WebGL and stay hard-clipped on both
  //    backends. Off passes a softness of exactly 0.0, for which the shader
  //    function returns the hard clip. The band is physically real but
  //    sub-pixel at rendered disc sizes: it spans 2*R*w screen pixels at a
  //    face-on terminator, so 0.88 px at a ~190 px zoomed disc and 0.07 px at
  //    the default ~16 px disc. It removes a hard binary edge rather than
  //    producing a visibly wide penumbra — the real Moon's soft-looking
  //    terminator is topography, carried by the lunar normal map, not the
  //    Sun's angular size.
  //
  // enableAngularSolarGlare defaults on, runs on both backends and in both
  // star paths (the cube map and the sprite catalogue), and is resolved once
  // per frame by `Scene/SolarGlareAppearance.js`. It washes stars out as a
  // function of their angular separation from the Sun, using the same
  // pedestal-subtracted Lorentzian (the 1/theta^2 Stiles-Holladay / CIE
  // veiling-glare form) that the sun billboard uses: one curve in
  // `Scene/SolarDiscModel.js`, parameterised over bake radius there and over
  // radians here. Keying the dim to the Sun's elevation instead would dim the
  // whole sky uniformly, including stars 180 deg away, and would do nothing at
  // all in orbit. Off passes a strength of exactly 0.0, which every shader
  // reads as a signal to skip the block. It is not gated by the 111 km
  // atmospheric-column factor that makes the eclipse star modulation inert in
  // orbit: sky glow needs a column, veiling glare needs only an observer, and
  // orbit is the case this exists for. The effect is measurable
  // only near the Sun — at the shipped constants a star loses 3.2% of its
  // radiance at 30 deg separation, 6.6% at 20 deg, 22.8% at 10 deg, 49.8% at
  // 5.477 deg (the half-amplitude angle) and 96.8% at 1 deg, and at or beyond
  // 90 deg the multiplier is exactly 1.0.
  const leaf = {
    enableSunLight: true,
    enableMoonLight: true,
    enableMoonPhase: true,
    enableEarthshine: true,
    enableEarthshinePhase: true,
    enableSoftTerminator: true,
    enableDualLightAtmosphere: true,
    moonIntensity: 0.05,
    enableLunarBRDF: true,
    enableOppositionSurge: true,
    enableMoonSkyWash: true,
    enableLunarNormalMap: true,
    enableEclipse: true,
    eclipseAutoExposure: false,
    enableEclipseGlobeShadow: true,
    enableSolarLimbDarkening: true,
    enableSolarGlareFalloff: true,
    enableTrueSolarDiscSize: true,
    enableScreenSpaceSunHalo: true,
    enableAngularSolarGlare: true,
    // The 360-degree horizon twilight of totality. An observer inside the
    // umbra is surrounded by penumbra: the umbral ground track is only
    // 100-160 km wide, so in every azimuth the still-sunlit atmosphere begins
    // ~50-80 km away and its scattered light arrives as a sunset-coloured band
    // hugging the horizon — the most recognisable totality cue after the
    // corona. The geometry is computed with the flag off as well, so tooling
    // can read the physics either way, and the strength is exactly 0 in every
    // frame that is not a near-total eclipse, which makes the off position an
    // identity rather than merely close to one.
    enableEclipseHorizonTwilight: true,
    // Earth's shadow projected onto the Moon's disc — the umbral bite and the
    // copper of a total lunar eclipse. Defaults on, runs on both backends from
    // one geocentric state (`Scene/LunarEclipseState.js`). The geometry is
    // computed with the flag off as well, so tooling can read it either way;
    // off simply withholds the shadow uniforms, and both shaders then skip
    // the block on a penumbral radius of exactly 0 rather than multiplying
    // through an identity. Inert on every frame outside a lunar eclipse by
    // the same construction.
    enableLunarEclipse: true,
  };
  Object.defineProperties(leaf, {
    lambertDiffuseMultiplier: {
      enumerable: true,
      get: function () {
        return globe.lambertDiffuseMultiplier;
      },
      set: function (v) {
        globe.lambertDiffuseMultiplier = v;
      },
    },
    vertexShadowDarkness: {
      enumerable: true,
      get: function () {
        return globe.vertexShadowDarkness;
      },
      set: function (v) {
        globe.vertexShadowDarkness = v;
      },
    },
    dynamicAtmosphereLighting: {
      enumerable: true,
      get: function () {
        return globe.dynamicAtmosphereLighting;
      },
      set: function (v) {
        globe.dynamicAtmosphereLighting = v;
      },
    },
    dynamicAtmosphereLightingFromSun: {
      enumerable: true,
      get: function () {
        return globe.dynamicAtmosphereLightingFromSun;
      },
      set: function (v) {
        globe.dynamicAtmosphereLightingFromSun = v;
      },
    },
  });
  return leaf;
}

function buildSkyAtmosphere(scene) {
  // `enableStarBrightnessModulation` gates the twilight dim applied to the
  // star field, multiplying star colour by
  //   factor = 1 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))
  // Both backends apply it on the default path: the cube-map panorama shader
  // on WebGPU and `SkyBoxFS.glsl` on WebGL, the latter fed by
  // `u_starModulation` and `u_skyBrightness` from `CubeMapPanorama.js`.
  //
  // The curve only dims where there is an atmosphere to glow.
  // `SkyBrightness.computeSkyBrightness` multiplies by
  // `computeAtmosphericColumnFactor`, which is 0 above the engine's 111 km
  // scattering shell, so an orbital camera on the day side gets a factor of
  // exactly 1.0 and keeps its full star map even with the Sun in frame.
  //
  // The derivation of the two curve constants, the rural-sky anchor they are
  // fitted to, and the measured consequences of moving off that anchor live
  // beside the constants in `StarFieldMath.ts`; the two must not be edited
  // independently, and `eclipse-sky-totality.spec.mjs` pins that they agree.
  // Apps that want a sharper twilight transition override `inflection` and
  // `steepness` directly.
  const leaf = {
    starModulationCurve: {
      inflection: STAR_MODULATION_INFLECTION,
      steepness: STAR_MODULATION_STEEPNESS,
    },
    enableStarBrightnessModulation: true,
    // Reserved and currently unwired: this is the only reference to
    // `enableNightSkyDimming` under `packages/engine/Source`. It is intended
    // for a night-side dim in the sky-atmosphere shader, but no consumer reads
    // it, so setting it has no effect until one exists.
    enableNightSkyDimming: true,
  };
  Object.defineProperties(leaf, {
    show: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere) ? scene.skyAtmosphere.show : false;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.show = v;
        }
      },
    },
    perFragment: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere)
          ? scene.skyAtmosphere.perFragmentAtmosphere
          : false;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.perFragmentAtmosphere = v;
        }
      },
    },
    lightIntensity: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere)
          ? scene.skyAtmosphere.atmosphereLightIntensity
          : 0.0;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.atmosphereLightIntensity = v;
        }
      },
    },
    hueShift: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere)
          ? scene.skyAtmosphere.hueShift
          : 0.0;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.hueShift = v;
        }
      },
    },
    saturationShift: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere)
          ? scene.skyAtmosphere.saturationShift
          : 0.0;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.saturationShift = v;
        }
      },
    },
    brightnessShift: {
      enumerable: true,
      get: function () {
        return defined(scene.skyAtmosphere)
          ? scene.skyAtmosphere.brightnessShift
          : 0.0;
      },
      set: function (v) {
        if (defined(scene.skyAtmosphere)) {
          scene.skyAtmosphere.brightnessShift = v;
        }
      },
    },
  });
  return leaf;
}

function buildGroundAtmosphere(globe) {
  // The per-fragment ground-atmosphere flag has no backing store on `Globe`
  // and is held here.
  const leaf = {
    perFragment: false,
  };
  Object.defineProperties(leaf, {
    enabled: {
      enumerable: true,
      get: function () {
        return globe.showGroundAtmosphere;
      },
      set: function (v) {
        globe.showGroundAtmosphere = v;
      },
    },
    lightIntensity: {
      enumerable: true,
      get: function () {
        return globe.atmosphereLightIntensity;
      },
      set: function (v) {
        globe.atmosphereLightIntensity = v;
      },
    },
    hueShift: {
      enumerable: true,
      get: function () {
        return globe.atmosphereHueShift;
      },
      set: function (v) {
        globe.atmosphereHueShift = v;
      },
    },
    saturationShift: {
      enumerable: true,
      get: function () {
        return globe.atmosphereSaturationShift;
      },
      set: function (v) {
        globe.atmosphereSaturationShift = v;
      },
    },
    brightnessShift: {
      enumerable: true,
      get: function () {
        return globe.atmosphereBrightnessShift;
      },
      set: function (v) {
        globe.atmosphereBrightnessShift = v;
      },
    },
    lightingFadeOut: {
      enumerable: true,
      get: function () {
        return globe.lightingFadeOutDistance;
      },
      set: function (v) {
        globe.lightingFadeOutDistance = v;
      },
    },
    lightingFadeIn: {
      enumerable: true,
      get: function () {
        return globe.lightingFadeInDistance;
      },
      set: function (v) {
        globe.lightingFadeInDistance = v;
      },
    },
    nightFadeOut: {
      enumerable: true,
      get: function () {
        return globe.nightFadeOutDistance;
      },
      set: function (v) {
        globe.nightFadeOutDistance = v;
      },
    },
    nightFadeIn: {
      enumerable: true,
      get: function () {
        return globe.nightFadeInDistance;
      },
      set: function (v) {
        globe.nightFadeInDistance = v;
      },
    },
  });
  return leaf;
}

function buildAtmosphere(scene) {
  const leaf = {};
  Object.defineProperties(leaf, {
    lightIntensity: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.lightIntensity;
      },
      set: function (v) {
        scene.atmosphere.lightIntensity = v;
      },
    },
    hueShift: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.hueShift;
      },
      set: function (v) {
        scene.atmosphere.hueShift = v;
      },
    },
    saturationShift: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.saturationShift;
      },
      set: function (v) {
        scene.atmosphere.saturationShift = v;
      },
    },
    brightnessShift: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.brightnessShift;
      },
      set: function (v) {
        scene.atmosphere.brightnessShift = v;
      },
    },
    dynamicLighting: {
      enumerable: true,
      get: function () {
        return scene.atmosphere.dynamicLighting;
      },
      set: function (v) {
        scene.atmosphere.dynamicLighting = v;
      },
    },
  });
  return leaf;
}

function buildFog(scene) {
  const leaf = {};
  Object.defineProperties(leaf, {
    enabled: {
      enumerable: true,
      get: function () {
        return scene.fog.enabled;
      },
      set: function (v) {
        scene.fog.enabled = v;
      },
    },
    renderable: {
      enumerable: true,
      get: function () {
        return scene.fog.renderable;
      },
      set: function (v) {
        scene.fog.renderable = v;
      },
    },
    density: {
      enumerable: true,
      get: function () {
        return scene.fog.density;
      },
      set: function (v) {
        scene.fog.density = v;
      },
    },
    heightScalar: {
      enumerable: true,
      get: function () {
        return scene.fog.heightScalar;
      },
      set: function (v) {
        scene.fog.heightScalar = v;
      },
    },
    heightFalloff: {
      enumerable: true,
      get: function () {
        return scene.fog.heightFalloff;
      },
      set: function (v) {
        scene.fog.heightFalloff = v;
      },
    },
    maxHeight: {
      enumerable: true,
      get: function () {
        return scene.fog.maxHeight;
      },
      set: function (v) {
        scene.fog.maxHeight = v;
      },
    },
    visualDensityScalar: {
      enumerable: true,
      get: function () {
        return scene.fog.visualDensityScalar;
      },
      set: function (v) {
        scene.fog.visualDensityScalar = v;
      },
    },
    screenSpaceErrorFactor: {
      enumerable: true,
      get: function () {
        return scene.fog.screenSpaceErrorFactor;
      },
      set: function (v) {
        scene.fog.screenSpaceErrorFactor = v;
      },
    },
    minimumBrightness: {
      enumerable: true,
      get: function () {
        return scene.fog.minimumBrightness;
      },
      set: function (v) {
        scene.fog.minimumBrightness = v;
      },
    },
  });
  return leaf;
}

function buildVolumetricFog() {
  // Configuration for the froxel-grid participating-media renderer. The master
  // toggle is off by default so no scene pays for the grid unless it asks:
  //
  //   enabled                — master toggle
  //   quality                — "low" | "medium" | "high" | "auto";
  //                            "auto" picks from a volumetric-path-tracing
  //                            benchmark run at renderer init
  //   maxDistance            — far plane of the froxel grid (m). Past this the
  //                            Nishita atmosphere takes over smoothly.
  //   density                — base fog density multiplier
  //   falloff                — exponential height falloff coefficient (1/m);
  //                            larger means thinner air
  //   fogAnisotropy          — Henyey-Greenstein g parameter (-1..1). +0.3 is
  //                            mild forward scattering, as for water droplets;
  //                            0 is isotropic.
  //   fogAlbedo              — vec3 single-scatter albedo, tinted slightly
  //                            blue to suggest moist air
  //   enableScatteringOcclusion — shadow-aware in-scattering, toggled
  //                            independently; a silent no-op while `enabled`
  //                            is false
  return {
    enabled: false,
    quality: "auto",
    maxDistance: 50000,
    density: 1.0,
    falloff: 0.0001,
    fogAnisotropy: 0.3,
    fogAlbedo: { r: 0.9, g: 0.92, b: 0.95 },
    enableScatteringOcclusion: false,
    // Constant ambient term for the scattering kernel: a soft fill light that
    // keeps shadow volumes from going hard black.
    ambientStrength: 0.05,
    // Opt-in sky-LUT ambient. When true, the scattering kernel replaces the
    // flat `ambientStrength` constant with an altitude- and
    // time-of-day-correct term: a sample of the Bruneton transmittance LUT at
    // `(froxel altitude, view-up)`, tinted by the atmosphere-derived SH-L2
    // irradiance probe in `environmentMapManager._webgpuSHBuffer`. At sunset
    // the fog then picks up warm sky colour low down and cool zenith ambient
    // above, instead of a flat grey. False leaves the constant ambient
    // untouched.
    iblAmbient: false,
    // Opt-in temporal reprojection and blue-noise jitter for the froxel
    // integrate pass. When true, the pass jitters each ray's slice-depth phase
    // by blue noise per frame, reprojects the previous frame's integrated 3D
    // scattering volume through `previousViewProjection`, and exponentially
    // blends (alpha ~0.05) the current march with the neighborhood-clamped
    // reprojected history. Amortizing the integration this way means each
    // frame needs only a fraction of the samples, which is what allows the
    // grazing-ray march cap to be lifted on the temporal path: the jitter and
    // accumulation reconstruct the full march over several frames. Fast camera
    // motion is handled by a neighborhood clamp and a disocclusion reject so
    // the volume does not ghost.
    //
    // The history is a ping-pong pair of 3D froxel textures, allocated only
    // while this flag is set; when it is false a placeholder 1x1 history keeps
    // the bind-group layout from forking and the integrate pass skips the
    // reprojection and blend entirely.
    temporal: false,
    // Opt-in multiple-scattering octaves in the light-scattering (in-scatter
    // source) pass. When true and `msOctaves` is above 1, the kernel sums
    // Frostbite-style multi-octave in-scatter on top of the energy-conserving
    // single-scatter term: each octave scales the contribution, the
    // directional-occlusion bleed and the Henyey-Greenstein phase eccentricity
    // by geometric factors near 0.5, and the sum is normalized by the
    // contribution total, mirroring the procedural cloud renderer's
    // `multiScatterLight`. Dense valley mist then reads as a lit volume,
    // because sunlight bleeds deeper into the core, without blowing out — the
    // normalization caps a thin layer at the single-scatter value, so it
    // cannot over-brighten. At `msOctaves` 1 the loop's single iteration with
    // scale 1 is exactly the single-scatter term, and the kernel skips the
    // loop altogether for `msOctaves` <= 1.
    multiScatter: false,
    // Number of multiple-scattering octaves, clamped to [1, 8] by the
    // renderer. 1 is single-scatter; 2-3 give the lit-volume look for thick
    // mist; beyond about 4 the geometric decay makes further octaves
    // negligible. Read only while `multiScatter` is true.
    msOctaves: 1,
    // Opt-in correction of the base height fog's altitude datum, on WebGPU.
    // Froxel altitude is measured from the ellipsoid's inscribed sphere — the
    // polar radius — so sea level sits 21,385 m above that frame at the
    // equator and 0 m at a pole. `density * exp(-altitude * falloff)`
    // therefore scales the same configured fog by 0.118x at the equator and
    // 1.0x at a pole at the default falloff of 1e-4, an 8.5x
    // latitude-dependent difference. When true, the density pass measures the
    // base fog from the ellipsoid surface along the camera's radial instead,
    // so `falloff` means the same thing at every latitude.
    //
    // It defaults false because turning it on is a visible density change on
    // the master-on path: every scene tuned against the inscribed-sphere datum
    // shifts denser everywhere but the poles. The false path packs a datum of
    // 0.0 and the shader's subtraction is bit-exact, so the default frame is
    // unchanged.
    surfaceRelativeAltitude: false,
  };
}

function buildVaryingAtmosphereDensity() {
  return {
    enabled: false,
    noiseScale: 1.0,
    noiseStrength: 0.1,
  };
}

function buildClouds(globe) {
  // There is one cloud renderer, `WebGPUProceduralCloudRenderer`: a
  // Schneider-style volumetric raymarcher with a Henyey-Greenstein dual lobe,
  // Beer-Powder lighting, a 3D FBM density field and light-ray marching.
  // `enableProcedural` and `enableVolumetric` are therefore aliases onto one
  // master gate, not two render paths. The `volumetricEnableAltitude` and
  // `volumetricDisableAltitude` hysteresis range is what the `auto` quality
  // preset interpolates over, and is also the range a future high-altitude 2D
  // fallback would key off.
  //
  // Every property here proxies to the Scene- and Globe-managed default
  // {@link CloudCollection} at `globe.defaultCloudCollection`, which is the
  // source of truth for the volumetric deck. The master aliases flip that
  // collection's exclusive `renderMode` between `BILLBOARD` and `VOLUMETRIC`
  // together with `volumetric.enabled`; every dial proxies to the collection's
  // `.volumetric` {@link CloudVolumetrics}. WebGPU only — a documented no-op
  // on WebGL.
  const leaf = {
    volumetricEnableAltitude: 50000,
    volumetricDisableAltitude: 100000,
  };
  Object.defineProperties(leaf, {
    enableProcedural: {
      enumerable: true,
      get: function () {
        const coll = globe.defaultCloudCollection;
        return (
          coll.renderMode === CloudRenderMode.VOLUMETRIC &&
          coll.volumetric.enabled === true
        );
      },
      set: function (v) {
        const coll = globe.defaultCloudCollection;
        coll.volumetric.enabled = v === true;
        coll.renderMode = v
          ? CloudRenderMode.VOLUMETRIC
          : CloudRenderMode.BILLBOARD;
      },
    },
    // Alias for `enableProcedural`: both read and write the same master gate.
    enableVolumetric: {
      enumerable: true,
      get: function () {
        const coll = globe.defaultCloudCollection;
        return (
          coll.renderMode === CloudRenderMode.VOLUMETRIC &&
          coll.volumetric.enabled === true
        );
      },
      set: function (v) {
        const coll = globe.defaultCloudCollection;
        coll.volumetric.enabled = v === true;
        coll.renderMode = v
          ? CloudRenderMode.VOLUMETRIC
          : CloudRenderMode.BILLBOARD;
      },
    },
    proceduralCoverage: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudCoverage;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudCoverage = v;
      },
    },
    layerBottom: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudLayerBottom;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudLayerBottom = v;
      },
    },
    layerTop: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudLayerTop;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudLayerTop = v;
      },
    },
    density: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudDensity;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudDensity = v;
      },
    },
    quality: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudQuality;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudQuality = v;
      },
    },
    // Quality dial one level above `clouds.quality`, which is a raw `maxSteps`
    // number. Accepts four string presets:
    //
    //   low    — maxSteps 24, lightSteps 3 (mobile and low-power)
    //   medium — maxSteps 48, lightSteps 4 (desktop default)
    //   high   — maxSteps 96, lightSteps 8 (cinematic)
    //   auto   — chosen by camera altitude: high below
    //            `volumetricEnableAltitude` (default 50 km), low above
    //            `volumetricDisableAltitude` (default 100 km), linearly
    //            blended in between. Reusing those two leaf fields lets a
    //            caller tune the crossfade without also changing the
    //            resolution.
    //
    // A string that is none of the four resolves to "auto", so a typo degrades
    // instead of breaking the render.
    //
    // `clouds.quality` remains an escape hatch: set to anything other than its
    // default of 64, the renderer uses it verbatim and ignores
    // `volumetricQuality`, which allows `maxSteps` to be hand-tuned outside the
    // preset set.
    volumetricQuality: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudVolumetricQuality;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudVolumetricQuality = v;
      },
    },
    // Live appearance dials. Each proxies to the managed collection's
    // `.volumetric` config and re-packs on the next frame without a rebuild.
    // `undefined` selects the renderer's built-in default.
    aerialStrength: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudAerialStrength;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudAerialStrength = v;
      },
    },
    silverLining: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric
          .cloudSilverLiningIntensity;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudSilverLiningIntensity = v;
      },
    },
    phaseForwardG: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudPhaseForwardG;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudPhaseForwardG = v;
      },
    },
    phaseBackG: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudPhaseBackG;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudPhaseBackG = v;
      },
    },
    phaseBlend: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudPhaseBlend;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudPhaseBlend = v;
      },
    },
    ambientIntensity: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudAmbientIntensity;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudAmbientIntensity = v;
      },
    },
    erosionStrength: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudErosionStrength;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudErosionStrength = v;
      },
    },
    puffSize: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudPuffSize;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudPuffSize = v;
      },
    },
    exposure: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudExposure;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudExposure = v;
      },
    },
    msDecayScatter: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudMsDecayScatter;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudMsDecayScatter = v;
      },
    },
    msDecayExtinction: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudMsDecayExtinction;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudMsDecayExtinction = v;
      },
    },
    msDecayPhase: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudMsDecayPhase;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudMsDecayPhase = v;
      },
    },
    // Collection-level WMO genus rather than a `.volumetric` dial: the
    // volumetric deck reads the collection's own `cloudType`.
    cloudType: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.cloudType;
      },
      set: function (v) {
        globe.defaultCloudCollection.cloudType = v;
      },
    },
    // Weather-map and provider ingest surface. Both proxy to the collection's
    // `.volumetric`, so a data provider attached here drives the volumetric
    // deck through the collection.
    weatherMap: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudWeatherMap;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudWeatherMap = v;
      },
    },
    weatherProvider: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.weatherProvider;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.weatherProvider = v;
      },
    },
  });
  return leaf;
}

function buildWeather(scene, globe) {
  // Plain weather scalars consumed by the sky, fog and star shaders. The
  // defaults describe a clear, average atmosphere, so they have no visible
  // effect until an app sets them.
  //   humidity    — 0 is dry desert, 1 is tropical jungle. The default of 0.5
  //                 is the neutral point: consumers map (0.5 + humidity) to a
  //                 multiplier over 0.5..1.5, and 0.5 + 0.5 is 1.0.
  //   airQuality  — 1 is clean, below 1 is dust or haze, above 1 is very
  //                 clean.
  //   temperature — air temperature in °C. Feeds the atmospheric-effects
  //                 mapper {@link AtmosphericEffects}, where cold and dry maps
  //                 to crisp and warm and moist maps to hazy.
  //   dewpoint    — dew point in °C. The temperature minus dew-point spread is
  //                 what drives fog and mist formation in that mapper.
  //   cloudCover  — 0..1, the fraction of sky covered by cloud. Delegates to
  //                 the managed cloud collection so the volumetric renderer
  //                 and the star-occlusion path read one value.
  const leaf = {
    humidity: 0.5,
    airQuality: 1.0,
    temperature: 15.0,
    dewpoint: 5.0,
  };
  Object.defineProperties(leaf, {
    cloudCover: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudCoverage;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudCoverage = v;
      },
    },
    enabled: {
      enumerable: true,
      get: function () {
        return scene.enableWeather;
      },
      set: function (v) {
        scene.enableWeather = v;
      },
    },
    type: {
      enumerable: true,
      get: function () {
        return scene.weatherType;
      },
      set: function (v) {
        scene.weatherType = v;
      },
    },
    intensity: {
      enumerable: true,
      get: function () {
        return scene.weatherIntensity;
      },
      set: function (v) {
        scene.weatherIntensity = v;
      },
    },
    // Unified wind: the setters fan out to the cloud wind fields as well, so a
    // caller has one place to set wind rather than two that can disagree.
    windSpeed: {
      enumerable: true,
      get: function () {
        return scene.weatherWindSpeed;
      },
      set: function (v) {
        scene.weatherWindSpeed = v;
        globe.defaultCloudCollection.volumetric.cloudWindSpeed = v;
      },
    },
    windDirection: {
      enumerable: true,
      get: function () {
        return scene.weatherWindDirection;
      },
      set: function (v) {
        scene.weatherWindDirection = v;
        globe.defaultCloudCollection.volumetric.cloudWindDirection = v;
      },
    },
  });
  return leaf;
}

function buildEffects() {
  // The conditions-to-effects hierarchy. `auto` is the master switch: when
  // true, applyAtmosphericConditions() derives each effect's enabled flag and
  // intensity from the weather conditions; when false the effects hold
  // whatever the app set them to. With `auto` false and every effect off, the
  // facade changes nothing until a caller opts in.
  //
  //   shimmer       — heat-haze screen-space UV warp, gated on high
  //                   temperature.
  //   groundFog     — low-altitude mist, gated on a small temperature minus
  //                   dew-point spread, which is near-surface saturation.
  //   optics        — cold-air ice-crystal sky overlay: 22° halo, sun-dogs and
  //                   pillars, gated on sub-freezing temperatures.
  //   precipitation — rain, snow and hail particles, driven by `weather.type`
  //                   and `weather.intensity`.
  //
  // Two precipitation sub-flags are opt-in and default false, so the precip
  // path is unchanged until one is set. With `dataDriven` true and a
  // `globe.weatherProvider` that reports present weather attached,
  // applyAtmosphericConditions() overrides the precipitation type and
  // intensity from the ingest field's WMO `ww` code and scales density by
  // visibility. `snowAccumulation` time-integrates a ground `snowCover` scalar
  // over 0..1 that ramps under snow and melts otherwise.
  return {
    auto: false,
    shimmer: { enabled: false, intensity: 0.6 },
    groundFog: { enabled: false, intensity: 0.0 },
    optics: { enabled: false, halo: 0.0, sunDogs: 0.0, pillar: 0.0 },
    precipitation: {
      enabled: false,
      type: 0,
      intensity: 0.0,
      dataDriven: false,
      snowAccumulation: false,
      snowCover: 0.0,
    },
  };
}

function buildNight(globe) {
  const leaf = {};
  Object.defineProperties(leaf, {
    enableNightLights: {
      enumerable: true,
      get: function () {
        return globe.enableNightLights;
      },
      set: function (v) {
        globe.enableNightLights = v;
      },
    },
    nightIntensity: {
      enumerable: true,
      get: function () {
        return globe.nightIntensity;
      },
      set: function (v) {
        globe.nightIntensity = v;
      },
    },
  });
  return leaf;
}

// Suppress unused-import lint — Cartesian3 is re-exported here for JSDoc type
// cross-referencing and as a hint to bundlers that this facade participates
// in the Cartesian3 reflection chain used by snapshot/clone.
// eslint-disable-next-line no-unused-vars
const _typeRef = Cartesian3;

export default AtmosphericConditions;
