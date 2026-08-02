import Cartesian3 from "../Core/Cartesian3.js";
import CloudRenderMode from "./CloudRenderMode.js";
import defined from "../Core/defined.js";
import {
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
} from "./StarFieldMath.js";

/**
 * AtmosphericConditions — canonical facade (Phase 0.3).
 *
 * Accessed as `scene.globe.atmosphericConditions`. This class is a **facade**:
 * its getters/setters read and write through to the existing legacy storage
 * on `Scene.atmosphere`, `Scene.fog`, `Scene.skyAtmosphere`, and `Globe` (plus
 * a handful of `Scene._weather*` fields). NO data migration occurs. The
 * legacy properties remain the source of truth; internal Cesium code is not
 * rewired in this PR.
 *
 * Pattern rationale (see `migration_doc/WATER_RENDERING_DESIGN.md §5.1`):
 *  - Existing upstream Cesium APIs must keep working unchanged.
 *  - New code (and user code going forward) gets a single canonical home for
 *    atmosphere/fog/cloud/weather/night state, grouped by domain.
 *  - Phase 1+ state that has no legacy backing (volumetricFog,
 *    varyingAtmosphereDensity, the new lighting flags, cloud volumetrics,
 *    skyAtmosphere.starModulationCurve, groundAtmosphere.perFragment) lives
 *    directly on the facade.
 *
 * Leaf objects are all plain objects with get/set thunks installed by the
 * constructor via {@link Object.defineProperties}. Sub-facades never close
 * over `this` — they close over the `scene` and `globe` captured at
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
   * Returns a JSON-serializable snapshot of the facade state. Used by future
   * snapshot/record modes. Implementation is intentionally minimal for now.
   * @returns {object} a plain-object snapshot (deep-cloned)
   */
  clone() {
    // TODO(Phase 2): full structured snapshot including Cartesian3 serialization.
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
   * Unified scattering coefficients (Option A). Setters fan out to
   * `scene.atmosphere`, `scene.skyAtmosphere`, and the `Globe` atmosphere
   * fields so all three legacy consumers stay in lock-step. Getters read
   * from `scene.atmosphere` as the canonical reader.
   * @type {object}
   * @readonly
   */
  get scattering() {
    return this._scattering;
  }

  /**
   * Lighting flags. `lambertDiffuseMultiplier`, `vertexShadowDarkness`,
   * `dynamicAtmosphereLighting`, and `dynamicAtmosphereLightingFromSun`
   * delegate to `Globe`. `enableSunLight`, `enableMoonLight`,
   * `enableMoonPhase`, and `enableEarthshine` are new Phase 1 state stored
   * on the facade. The C12 moon-wave toggles `enableLunarBRDF`,
   * `enableOppositionSurge`, `enableMoonSkyWash`, and `enableLunarNormalMap`
   * (all default ON, both backends) also live here, as do the C12-29 toggles
   * `enableEclipse`
   * (default ON, both backends — gates application of
   * `frameState.eclipseState`) and `eclipseAutoExposure` (default OFF —
   * ruling E2's camera-metering alternative to the human-eye impression).
   * The C12 sun-wave toggles `enableSolarLimbDarkening` (C12-15) and
   * `enableSolarGlareFalloff` (C12-16) are here too — both default ON, both
   * backends, both resolved once per frame by `Scene/SunDiscAppearance.js`
   * and published as `frameState.sunDiscAppearance`, and both with an EXACT
   * identity position when false.
   * @type {object}
   * @readonly
   */
  get lighting() {
    return this._lighting;
  }

  /**
   * Sky atmosphere facade over `scene.skyAtmosphere`. Also holds the new
   * Phase 1 `starModulationCurve` state.
   * @type {object}
   * @readonly
   */
  get skyAtmosphere() {
    return this._skyAtmosphere;
  }

  /**
   * Ground atmosphere facade over the matching `Globe` fields. Adds new
   * `perFragment` state for Phase 1.
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
   * Volumetric fog — Phase 1 state only, no legacy backing.
   * @type {object}
   * @readonly
   */
  get volumetricFog() {
    return this._volumetricFog;
  }

  /**
   * Varying atmosphere density — Phase 1 state only, no legacy backing.
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
   * Unified atmospheric EFFECTS hierarchy (Phase B+). Nests the screen-space /
   * overlay effects (`shimmer`, `groundFog`, `optics`, `precipitation`) that the
   * weather {@link AtmosphericConditions#weather} drives. The master `auto` flag,
   * when true, makes {@link applyAtmosphericConditions} derive each effect's
   * `enabled` + intensity from the conditions (temperature / dew-point spread /
   * precipitation). Off by default so existing scenes are byte-neutral until
   * opted in. Each effect leaf is plain state (no legacy backing); a backend
   * (e.g. the WebGPU heat-shimmer post-process) reads it via the scene flags
   * the auto-apply pushes.
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

// ───────────────────────────── leaf builders ─────────────────────────────

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
  // New Phase 1 state — stored directly on the leaf (no legacy backing).
  // Phase 1.3c adds `enableDualLightAtmosphere` (B12 lock) and the
  // `moonIntensity` scale so the sky atmosphere shader's dual-light
  // path can be tuned without code changes. Defaults: dual-light ON
  // (the moon contribution is gated to zero when the moon is below
  // the horizon AND scaled by phase fraction, so "ON by default" is
  // visually identical to today during the day and at new moon).
  // C12 moon wave (2026-07-24) — three moon-appearance toggles, all
  // default ON and implemented on BOTH backends in lockstep (never a
  // WebGPU-only default-ON multiplier — the C11-176/C12 exit-gate class):
  //  - enableLunarBRDF (C12-20): Lommel-Seeliger regolith reflectance in
  //    place of Lambert, so the full moon is a flat bright disc.
  //  - enableOppositionSurge (C12-23): CPU-side Hapke-SHOE brightness
  //    surge within a few degrees of opposition.
  //  - enableMoonSkyWash (C12-30): additive in-scattered sky radiance over
  //    the disc (disc = disc × extinction + inscatter), so the daytime
  //    moon reads pale/sky-washed instead of a dark cutout. Only active
  //    while the sky atmosphere is visible; exactly zero from orbit.
  //
  // C12-25 (2026-08-02) — `enableLunarNormalMap`, DEFAULT ON. Routes the
  // LOLA-derived tangent-space relief onto the disc's lighting normal. It is
  // additionally gated by the moon VARIANT: `Moon.Variant.SMALL` ships no
  // normal map, so this toggle has no effect there and the legacy flat look
  // is preserved. Visible primarily near the terminator, where N·L is small
  // and a few degrees of surface tilt is the difference between lit and
  // unlit; nearly invisible at full phase, where N·L ≈ 1 and the cosine is
  // flat. Turning it off drives the shader's strength uniform to exactly 0,
  // which is the exact identity perturbation on both backends.
  //
  // C12-29 S5 (2026-07-25) — `enableEclipseGlobeShadow`, DEFAULT ON. Gates
  // only the per-fragment lunar umbra on the globe surface, leaving S1's sun
  // fade and S2's observer-anchored scene dimming untouched. S5 deliberately
  // supersedes S2 on the globe: the surface dims by G(O_fragment), not
  // uniformly by G(O_camera). Turning this sub-effect off preserves the
  // complete S1/S2 contract for isolation and equivalence probes.
  //
  // C12-29 S1 (2026-07-24) — `enableEclipse`, DEFAULT ON by maintainer
  // ruling E1 ("this is the actual simulation that needs to be there",
  // ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md §6a). It gates only whether
  // consumers APPLY the active logical View's
  // `frameState.eclipseState.sunVisibleFraction`; the eclipse geometry itself
  // is computed unconditionally whenever that View is prepared so probes and
  // tooling can read the physics with the effect switched off.
  // With it false, every consumer multiplies by exactly 1.0 and the frame
  // is byte-identical to the pre-C12-29 engine on both backends.
  //
  // C12-29 S2 (2026-07-24) — `eclipseAutoExposure`, DEFAULT OFF by maintainer
  // ruling E2 (ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md §6a): "human-eye
  // impression (preserved darkness) is the DEFAULT; camera-autoexposure
  // compensation becomes a togglable alternative mode". The two modes differ
  // in the TRANSFER FUNCTION `EclipseState.getEclipseSceneLightFactor`
  // applies to the flux fraction, not in whether dimming happens:
  //
  //   false (default, human eye) — the flux fraction is carried through the
  //     eye's own adaptation exponent (CIE L* / Stevens, ~1/3) before it
  //     reaches the lights, because with no auto-exposure in the chain
  //     nothing else will perform that adaptation. Totality lands on the
  //     documented ~5-lux twilight floor (render factor ~0.0368) and the
  //     plunge from 99% obscuration is a ~6x collapse. This is the AE-EXEMPT
  //     state: the darkness is preserved by construction.
  //
  //   true (camera) — the LINEAR radiometric flux fraction is handed to the
  //     lights instead, and the re-metering is left to the exposure chain,
  //     which is precisely what a camera does. With
  //     `scene.highDynamicRange` plus the AutoExposure stage on
  //     (`PostProcessStageCollection._autoExposureEnabled`, off by default),
  //     that stage measures the dimmed scene and compensates it, washing the
  //     darkness out exactly as ruling E2 describes. Without an exposure
  //     stage it renders the true radiometric plunge — which is what a
  //     FIXED-exposure camera shows, and is not a degenerate case.
  //
  // C12-19 SEAM: C12-19's AE lanes have not landed, so there is no
  // eclipse-aware metering window, no AE clamp and no eclipse term in the AE
  // debounce yet. When they land, this flag is the switch they read: the
  // false path must stay exempt from (or clamped in) the new AE lanes, and
  // the true path must feed the eclipse-dimmed luminance into them. The
  // transfer-function split above is the complete, shipped default path;
  // everything C12-19 adds attaches to the `true` branch.
  // C12 sun wave (2026-07-25) — two sun-BAKE toggles, both DEFAULT ON and
  // implemented on BOTH backends in lockstep (the C11-176/C12 exit-gate
  // class: never a WebGPU-only default-ON celestial change). Both feed the
  // bake through `Scene/SunDiscAppearance.js`, which reads the numbers from
  // `Scene/SolarDiscModel.js` — the single constants source the C12-15 row
  // required, shared with `computeSolarObscuration.js`.
  //
  //  - enableSolarLimbDarkening (C12-15): the disc's radiance follows the
  //    quadratic law I(mu) = 0.3 + 0.93*mu - 0.23*mu^2 instead of the
  //    binary `step()` flat disc. Turning it off passes (1, 0, 0), which is
  //    the exact flat disc again — an identity, not an approximation.
  //    HONEST NOTE: at SDR defaults the bake clamps alpha to 1 and the glare
  //    term alone is ~0.73 over the disc, so limb darkening is arithmetically
  //    masked until C12-19 removes that clamp (or C12-18 moves the halo to
  //    the post-process chain). It ships now so C12-19 only has to remove
  //    clamps, not re-derive the law — and the clamp count is ASYMMETRIC:
  //    ONE site in `SunTextureFS.glsl` (the final `clamp(color, 0, 1)`) but
  //    SIX in the WebGPU CPU twin (`WebGPUEnvironmentRenderer.js` — four
  //    `Math.min(1, Math.max(0, …))` calls in the half-float branch plus two
  //    `Math.min(255, …)` in the 8-bit branch, and the 8-bit branch cannot
  //    carry >1 at all, so C12-19 must also force the float format there).
  //
  //  - enableSolarGlareFalloff (C12-16): the halo uses a Lorentzian /
  //    inverse-square veiling-glare profile that decays as 1/theta^2 and
  //    reaches zero only at the billboard's inscribed circle (11.0 solar
  //    radii), replacing `1 - smoothstep(0, 0.55, r)` which terminated hard
  //    at 8.556 solar radii. Turning it off selects the historical
  //    expression verbatim. Measured delta inside 6 solar radii: at most
  //    0.098 in profile units (0.074 in alpha) — the table is in
  //    `SolarDiscModel.solarGlareProfile`'s JSDoc.
  const leaf = {
    enableSunLight: true,
    enableMoonLight: true,
    enableMoonPhase: true,
    enableEarthshine: false,
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
    // C12-29 S6 — the 360-degree horizon twilight. Inside the umbra the
    // observer is surrounded by penumbra: the umbral ground track is only
    // 100-160 km wide, so in EVERY azimuth the still-sunlit atmosphere begins
    // ~50-80 km away and its scattered light arrives as a sunset-coloured band
    // hugging the horizon. It is the most recognisable totality cue after the
    // corona. Default ON per ruling E1's precedent (eclipse-driven effects are
    // "the actual simulation that needs to be there"); the geometry is still
    // computed with it off so tooling can read the physics, and the strength is
    // exactly 0 in every frame that is not a near-total eclipse, so the off
    // position is byte-identical rather than merely close.
    enableEclipseHorizonTwilight: true,
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
  // New Phase 1 state: star modulation curve parameters (plain container).
  // Phase 1.3b adds `enableStarBrightnessModulation`, which gates the cubemap
  // panorama shader's smoothstep dim. The curve parameters use B4-locked
  // defaults — apps that want a sharper twilight transition (clearer dark-sky
  // preset) override `inflection` and `steepness` directly.
  //
  // C11-176 (2026-07-19) — DEFAULT FLIPPED TO FALSE FOR WEBGL PARITY.
  // This shipped `true`, which silently contradicted the consuming renderer:
  // `WebGPUCubeMapPanoramaRenderer.js:539-548` documents the flag as "Default
  // OFF for WebGL parity" and gates on `=== true` as a fail-safe against an
  // ABSENT property — shipping it present-and-true defeated that fail-safe.
  // WebGL's `SkyBoxFS.glsl` is nine lines and applies NO such term, so this was
  // a pure unmatched WebGPU divergence: star colour was multiplied by
  //   factor = 1 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))
  // which at skyBrightness = 1.0 (sun >= ~23.6 deg above the camera's local
  // horizon — i.e. most of the sunlit hemisphere for an orbital camera) equals
  // exactly 0.5, halving the star map.
  //
  // MEASURED (probe-skybox-star-modulation, camera placed along the sun
  // direction so skyBrightness = 1.0): WebGPU/WebGL mean luminance 0.493,
  // contrast (stddev) 0.552, and visible star pixels 21.06% -> 4.01% — five
  // times fewer stars. Forcing this flag false at runtime restored 1.001 /
  // 1.009 / 1.000 respectively, which is what proved causation.
  //
  // The capability is NOT removed — only its default. Setting it back to true
  // re-enables the dim exactly as before (the probe's A/B relies on that).
  //
  // C12-29 S6 / ruling E3 (2026-07-25) — DEFAULT FLIPPED BACK TO TRUE, and the
  // two things that made the C11-176 default WRONG are fixed rather than
  // worked around:
  //
  //   (a) NO WEBGL CONSUMER. C11-176's stated reason was "WebGL's SkyBoxFS.glsl
  //       is nine lines and applies NO such term, so this was a pure unmatched
  //       WebGPU divergence" — correct at the time. `SkyBoxFS.glsl` now carries
  //       the identical expression, fed by `u_starModulation` /
  //       `u_skyBrightness` from `CubeMapPanorama.js`, so the flag is a
  //       both-backend default-path multiplier and satisfies C12 exit-gate
  //       item 2.
  //   (b) THE CURVE ZEROED ORBITAL STARS. The measured C11-176 failure was at
  //       `skyBrightness = 1.0` for a camera "along the sun direction" — an
  //       ORBITAL camera on the day side, where the sky is genuinely black and
  //       the stars are genuinely there. `SkyBrightness.computeSkyBrightness`
  //       now multiplies by `computeAtmosphericColumnFactor`, which is 0 above
  //       the engine's own 111 km scattering shell, so that camera gets factor
  //       1.0 and is byte-identical to today.
  //
  // The curve defaults move from the C11-176 pair {0.5, 1.0} (which merely
  // HALVED the star map at full daylight — neither a correct day sky nor a
  // usable totality reveal) to the derived pair below. The derivation, the
  // rural-sky "countryside" anchor and the measured off-anchor consequences
  // live with the constants in `StarFieldMath.ts`; do not edit one without the
  // other (`eclipse-sky-totality.spec.mjs` pins that they agree).
  const leaf = {
    starModulationCurve: {
      inflection: STAR_MODULATION_INFLECTION,
      steepness: STAR_MODULATION_STEEPNESS,
    },
    enableStarBrightnessModulation: true,
    // NOTE: reserved, currently UNWIRED — this is the only reference to
    // `enableNightSkyDimming` in packages/engine/Source. It was intended for
    // night-sky dimming in the sky-atmosphere shader (see Scene.js:5760-5762
    // "and (later) by night-sky dimming") but no consumer was ever added.
    // Left in place per the scaffolding rule rather than deleted; do not
    // assume it does anything until a reader exists.
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
  // New Phase 1 state: per-fragment ground atmosphere flag.
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
  // Phase 5a — froxel-grid participating media renderer.
  // Defaults from the design doc §4.8 + B-series locks. Off by default
  // (B18) so users see no perf regression. The full set:
  //
  //   enabled                — master toggle (B18: default FALSE)
  //   quality                — "low" | "medium" | "high" | "auto"
  //                            (B7/B17: auto picks via VPT init benchmark)
  //   maxDistance            — far plane of the froxel grid (m). Past
  //                            this, the existing Nishita atmosphere
  //                            takes over smoothly.
  //   density                — base fog density multiplier
  //   falloff                — exponential height falloff coefficient
  //                            (1/m); larger = thinner air
  //   fogAnisotropy          — Henyey-Greenstein g parameter (-1..1).
  //                            +0.3 = mild forward scattering (water
  //                            droplets); 0 = isotropic.
  //   fogAlbedo              — vec3 single-scatter albedo. Slightly
  //                            blue-tinted by default to suggest moist
  //                            air.
  //   enableScatteringOcclusion — independently toggleable shadow-aware
  //                            in-scattering (B20: default FALSE).
  //                            Silent no-op when enabled is false (B9).
  return {
    enabled: false,
    quality: "auto",
    maxDistance: 50000,
    density: 1.0,
    falloff: 0.0001,
    fogAnisotropy: 0.3,
    fogAlbedo: { r: 0.9, g: 0.92, b: 0.95 },
    enableScatteringOcclusion: false,
    // Phase 5c — constant ambient term for the scattering kernel.
    // Soft fill light that prevents shadow volumes from going hard
    // black. Phase 5e (future) can replace this constant with a
    // proper sample of the SkyAtmosphere inscatter LUT at
    // `(altitude, up direction)` for physically motivated ambient.
    ambientStrength: 0.05,
    // Batch 431 (FOG-IBL-AMBIENT, improvement-plan 2.4) — opt-in
    // sky-LUT / IBL-driven fog ambient. When TRUE, the scattering
    // kernel replaces the flat-constant `ambientStrength` ambient with
    // an altitude- + time-of-day-correct ambient: a sample of the
    // Bruneton TRANSMITTANCE LUT at `(froxel altitude, view-up)` tinted
    // by the atmosphere-derived SH-L2 irradiance probe
    // (`environmentMapManager._webgpuSHBuffer`). Result: at sunset the
    // fog picks up warm sky color low + cool zenith ambient instead of
    // a flat grey. DEFAULT FALSE keeps the existing constant ambient
    // byte-identical (B18-style opt-in; no perf/visual regression).
    iblAmbient: false,
    // Batch 435 (FOG-TEMPORAL, improvement-plan 3.5) — opt-in temporal
    // reprojection + blue-noise jitter for the froxel integrate pass. When
    // TRUE, the integrate pass jitters each ray's slice-depth phase by blue
    // noise per frame, reprojects the PREVIOUS frame's integrated 3D
    // scattering volume via `previousViewProjection`, and exponentially
    // blends (alpha ~0.05) the current march with the neighborhood-clamped
    // reprojected history. This amortizes the volume integration across
    // frames — each frame only needs a fraction of the samples — so the
    // grazing-ray march cap (Batch 421) is lifted on the temporal path
    // (the jitter + accumulation reconstruct the full march over N frames).
    // The history is a DOUBLE-BUFFERED (ping-pong) 3D froxel texture pair,
    // allocated ONLY when this flag is set; DEFAULT FALSE skips the
    // reprojection + history blend entirely and leaves the integrate pass
    // BYTE-IDENTICAL to pre-Batch-435 (the placeholder 1×1 history keeps the
    // bind-group layout from forking). Fast camera motion is handled by a
    // neighborhood clamp + disocclusion reject so the volume doesn't ghost.
    temporal: false,
    // Batch 440 (FOG-MS, improvement-plan 4.3) — opt-in MULTIPLE-SCATTERING
    // octaves in the light-scattering (in-scatter source) pass. When TRUE (and
    // `msOctaves` > 1), the scattering kernel sums Frostbite-style multi-octave
    // in-scatter on top of the existing energy-conserving SINGLE-scatter term:
    // each octave scales the contribution, the directional-occlusion bleed, and
    // the Henyey-Greenstein phase eccentricity by geometric factors (a/b/c ~
    // 0.5), summed and NORMALIZED by the contribution total — mirroring the
    // procedural cloud renderer's `multiScatterLight`. A dense valley mist then
    // reads as a LIT VOLUME (the sun light bleeds deeper into the dense core)
    // instead of a flat dark mass — without blowing out (the normalization caps
    // a thin layer at the single-scatter value, so it CANNOT over-brighten).
    // DEFAULT FALSE keeps the existing single-scatter term byte-identical: at
    // `msOctaves` 1 the octave loop's single iteration with a/b/c scale = 1 IS
    // the current single-scatter, and the kernel simply skips the loop when
    // `msOctaves` <= 1 — so the OFF default is byte-identical to pre-Batch-440.
    multiScatter: false,
    // Number of multiple-scattering octaves (Frostbite). Clamped to [1, 8] by
    // the renderer. 1 == single-scatter (parity). 2-3 give the lit-volume look
    // for thick mist; beyond ~4 the geometric decay makes added octaves
    // negligible. Only consumed when `multiScatter` is TRUE.
    msOctaves: 1,
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
  // Phase 1 + Phase 6 state. The Cesium WebGPU fork ships a single
  // Schneider-style volumetric raymarched cloud renderer
  // (`WebGPUProceduralCloudRenderer`) — the legacy "procedural" name is
  // historical; the kernel HAS been volumetric (HG dual-lobe + Beer-
  // Powder lighting + 3D FBM density field + light-ray marching) since
  // it landed. The `enableProcedural` and `enableVolumetric` toggles
  // therefore both route to the same underlying master gate — they are
  // aliases, not separate render paths. Future Phase 6b work may introduce
  // a fast 2D fallback at high altitude (≥`volumetricDisableAltitude`); the
  // existing hysteresis range fields stay so that work is non-breaking.
  //
  // Cloud-unification epic slice 4A — these proxies RE-HOME off the historical
  // `globe.cloud*` / `globe.showProceduralClouds` fields onto the Scene/Globe
  // managed default {@link CloudCollection} (`globe.defaultCloudCollection`).
  // The master `enable*` aliases flip that collection's exclusive
  // `renderMode` (BILLBOARD⇄VOLUMETRIC) + `volumetric.enabled`; every dial
  // proxies to the collection's `.volumetric` {@link CloudVolumetrics} (whose
  // defaults are byte-equal to the old `globe.cloud*` defaults). The env-effects
  // phase reads the collection as the volumetric-deck source of truth, so
  // driving these facade fields turns the WebGPU deck on/off exactly as before —
  // now through the collection. WebGPU only (documented no-op on WebGL).
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
    // Session 65 Batch 43 (Phase 6 wiring) — alias to the same
    // underlying master gate. Pre-Batch-43 this was a plain field
    // that did nothing; now flipping it from JS turns the actual
    // renderer on/off and reading it reflects current state.
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
    // Session 65 Batch 45 — Phase 6d quality dial. Higher-level than
    // `clouds.quality` (a raw `maxSteps` numeric): accepts the four
    // string presets `"low" | "medium" | "high" | "auto"` that the
    // celestial-atmosphere design specs in §6 Phase 6d.
    //
    //   low    — maxSteps 24,  lightSteps 3 (mobile / low-power)
    //   medium — maxSteps 48,  lightSteps 4 (default desktop)
    //   high   — maxSteps 96,  lightSteps 8 (power-user / cinematic)
    //   auto   — pick by camera altitude, mirroring the Phase 6b
    //            crossfade design. Below `volumetricEnableAltitude`
    //            (default 50 km) use high; above
    //            `volumetricDisableAltitude` (default 100 km) use low;
    //            linear blend in between. The existing
    //            volumetricEnable/DisableAltitude leaf-fields already
    //            on this same object are reused so users can tune the
    //            crossfade without changing the resolution.
    //
    // When the renderer can't resolve a preset (string is neither one
    // of the four, e.g. user typed "ultra") it falls back to "auto" so
    // typos degrade gracefully instead of breaking the render.
    //
    // The raw `clouds.quality` field is preserved as an escape hatch
    // — when set to a non-default value (≠ 64) the renderer uses it
    // verbatim and ignores `volumetricQuality`. This lets power users
    // hand-tune `maxSteps` without fighting the preset enum.
    volumetricQuality: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.volumetric.cloudVolumetricQuality;
      },
      set: function (v) {
        globe.defaultCloudCollection.volumetric.cloudVolumetricQuality = v;
      },
    },
    // ── Live appearance dials (weather-configurability surface) ──
    // Each proxies to the managed collection's `.volumetric` config; setting it
    // re-packs next frame (no rebuild). `undefined` means "use the renderer's
    // built-in default".
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
    // Collection-level WMO genus (not a `.volumetric` dial — the volumetric
    // deck reads the collection's own `cloudType`). Re-homed off `globe.cloudType`.
    cloudType: {
      enumerable: true,
      get: function () {
        return globe.defaultCloudCollection.cloudType;
      },
      set: function (v) {
        globe.defaultCloudCollection.cloudType = v;
      },
    },
    // Weather-map / provider ingest surface (cloud-unification slice 4A). These
    // re-home the weather ingest onto the collection's `.volumetric` so a data
    // provider attached here drives the volumetric deck through the collection.
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
  // Phase 1.4 — plain weather state scalars consumed by the sky/fog/star
  // shaders. Defaults match a "clear, average atmosphere" so the change
  // is invisible until an app starts setting them.
  //   humidity   — 0=dry desert, 1=tropical jungle. Default 0.5 = no change
  //                because the consumers map (0.5 + humidity) to a
  //                multiplier (0.5..1.5×) and 0.5+0.5 = 1.0.
  //   airQuality — 1=clean, <1=dust/haze, >1=very clean. Default 1.0.
  //   temperature — air temperature, °C. Default 15 (mild). Feeds the Phase-A
  //                atmospheric-effects mapper (cold-dry = crisp; warm-moist =
  //                hazy) via {@link AtmosphericEffects}.
  //   dewpoint    — dew point, °C. Default 5. The temperature−dewpoint spread
  //                drives fog/mist formation in the mapper.
  //   cloudCover — 0..1, fraction of sky covered by clouds. Delegates to
  //                `globe.cloudCoverage` so the procedural cloud renderer
  //                and the star occlusion path stay in sync (single
  //                source of truth).
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
    // Unified wind: setters fan out to Globe cloud wind fields as well, so
    // there is a single wind source of truth from the user's perspective.
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
  // Phase B+ — the unified conditions→effects hierarchy. `auto` is the master
  // switch: when true, applyAtmosphericConditions() derives each effect's
  // enabled + intensity from the weather conditions; when false the effects are
  // whatever the app set them to. Default auto=false + all effects off → the
  // facade is byte-neutral until a user opts in (Principle: no surprise change).
  //
  //   shimmer       — heat-haze screen-space UV warp (Phase B, SHIPPED). Gated
  //                   on high temperature.
  //   groundFog     — low-altitude mist (Phase C scaffold). Gated on a small
  //                   temperature−dewpoint spread (near-surface saturation).
  //   optics        — cold-air ice-crystal sky overlay: 22° halo / sun-dogs /
  //                   pillars (Phase D scaffold). Gated on sub-freezing temps.
  //   precipitation — rain/snow/hail particles (Phase E scaffold). Driven by
  //                   weather.type / weather.intensity. PRECIP-DATA (Batch 444)
  //                   adds the opt-in `dataDriven` flag: when true AND a
  //                   `globe.weatherProvider` reporting present-weather is
  //                   attached, applyAtmosphericConditions() overrides the precip
  //                   type/intensity from the ingest field's WMO `ww` code (and
  //                   scales density by visibility). `snowAccumulation` (also
  //                   opt-in) time-integrates a ground `snowCover` scalar (0..1)
  //                   that ramps under snow + melts otherwise. Both default
  //                   FALSE so the precip path is byte-identical until opted in.
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
