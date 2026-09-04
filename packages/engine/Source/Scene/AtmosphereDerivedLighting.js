import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import SunLight from "./SunLight.js";

/**
 * AtmosphereDerivedLighting — derive the directional sun light (colour +
 * intensity) and a sky-irradiance ambient term from the atmosphere, so
 * discrete models / tiles are lit consistently with the unified
 * aerial-perspective post-process and the sky shell.
 *
 * This is the light-source half of a "mixed lighting" split: the terrain
 * gets post-process Lambertian aerial-perspective haze, while discrete
 * models get light-source PBR consistently lit by the same sun/sky derived
 * here — no double-lighting, one coherent atmosphere.
 *
 * ── Why analytic, not LUT-sampled ──
 * The Bruneton transmittance + irradiance LUTs exist, but the compute engine
 * that bakes them at runtime is dormant — `ctx.computeEngine` is never
 * instantiated, so the LUT textures are an un-baked placeholder. The
 * aerial-perspective post-process took the same decision: compute the
 * atmosphere analytically in-shader so it is both physically correct and
 * runtime-functional today. This module mirrors that on the CPU — a short
 * Beer-Lambert optical-depth integral along the sun ray (the same Rayleigh +
 * Mie model AtmosphereLUT.wgsl bakes) gives the sun's transmitted colour,
 * and an analytic indirect-sky integral gives the ambient. When the compute
 * engine lands, this module is the seam to swap the analytic terms for
 * direct LUT reads of the transmittance (sun) + irradiance (sky) tables —
 * the public shape (colour + intensity + ambient) stays identical.
 *
 * References:
 *   - Eric Bruneton & Fabrice Neyret, "Precomputed Atmospheric Scattering"
 *     (EGSR 2008) — the transmittance / irradiance model. Technique
 *     reimplemented from the paper, not copied.
 *   - Takram `three-geospatial` (MIT) `SunDirectionalLight` + `SkyLightProbe`
 *     — the atmosphere-derived sun + sky-irradiance light-source structure
 *     (technique only).
 *
 * @module AtmosphereDerivedLighting
 * @private
 */

// Atmosphere coefficients — MUST match WebGPUSkyAtmosphereRenderer.js's
// DEFAULT_* + WebGPUPostProcessStageCollection.ts's AP_* constants so the
// sun colour derived here agrees with the aerial-perspective haze + the sky
// shell. A divergence would light models inconsistently with their haze.
const RAYLEIGH_COEFFICIENT = new Cartesian3(5.5e-6, 13.0e-6, 22.4e-6);
const MIE_COEFFICIENT = new Cartesian3(21e-6, 21e-6, 21e-6);
const RAYLEIGH_SCALE_HEIGHT = 8500.0;
const MIE_SCALE_HEIGHT = 1200.0;
const ATMOSPHERE_THICKNESS = 111e3; // WebGL ATMOSPHERE_THICKNESS.
// WGS84 max radius (metres) — the inner radius the LUT bake + aerial
// perspective key off. Models sit at most a few km above this; the sun-ray
// optical depth is dominated by the lower atmosphere either way.
const WGS84_MAX_RADIUS = 6378137.0;

// Sun-ray optical-depth integration steps. The sun ray climbs from the
// shading point to the top of atmosphere; a coarse march is plenty for a
// smooth, low-frequency extinction term (this runs once per frame on the
// CPU, not per pixel).
const SUN_RAY_STEPS = 16;

const scratchSunDir = new Cartesian3();
const scratchSamplePos = new Cartesian3();
const scratchUp = new Cartesian3();

/**
 * Ray-sphere far intersection distance from `origin` along unit `dir` with a
 * sphere of `radius` centred at the world origin (ECEF ellipsoid centre).
 * Returns the forward (positive) far hit distance, or 0 when there is no
 * forward intersection. Used to find the sun ray's exit through the top of
 * atmosphere.
 *
 * @param {Cartesian3} origin
 * @param {Cartesian3} dir Unit direction.
 * @param {number} radius
 * @returns {number}
 * @private
 */
function raySphereFar(origin, dir, radius) {
  const b = Cartesian3.dot(origin, dir);
  const c = Cartesian3.dot(origin, origin) - radius * radius;
  const disc = b * b - c;
  if (disc < 0.0) {
    return 0.0;
  }
  const s = Math.sqrt(disc);
  const tFar = -b + s;
  return tFar > 0.0 ? tFar : 0.0;
}

/**
 * The result of {@link computeAtmosphereDerivedLighting}. All terms are
 * linear (HDR, pre-tonemap) and physically scaled to the atmosphere's light
 * intensity; consumers clamp/tonemap as usual.
 *
 * @typedef {object} AtmosphereDerivedLightingResult
 * @property {Cartesian3} sunColor Sun colour after atmospheric extinction
 *   (reddens + dims toward the horizon). Normalized so the brightest channel
 *   is ≤ 1 at the zenith; intensity carries the brightness.
 * @property {number} sunIntensity Sun intensity multiplier (dims as the sun
 *   sets / drops below the horizon).
 * @property {Cartesian3} skyIrradiance Indirect sky-irradiance ambient
 *   colour (the blue diffuse hemisphere term). Small; used as the model
 *   ambient floor in place of the flat neutral grey.
 * @private
 */

const result = {
  sunColor: new Cartesian3(1.0, 1.0, 1.0),
  sunIntensity: 2.0,
  skyIrradiance: new Cartesian3(0.2, 0.2, 0.2),
};

/**
 * Compute the atmosphere-derived sun colour/intensity + sky-irradiance
 * ambient for the given sun direction and camera altitude.
 *
 * The sun's transmitted colour is `exp(-(βR·ODr + βM·ODm))` along the sun ray
 * from the shading altitude to the top of atmosphere (Beer-Lambert with the
 * Rayleigh + Mie optical depths the LUT bakes). At the zenith the path is
 * short → near-white; near/below the horizon the path is long → the blue +
 * green channels extinguish first → the warm sunset hue, and the overall
 * intensity drops to ~0 as the sun sinks below the horizon.
 *
 * The sky-irradiance ambient is a cheap analytic stand-in for the Bruneton
 * irradiance LUT: a Rayleigh-tinted hemisphere term scaled by how much of the
 * sun is above the horizon. It gives models a plausible cool ambient that
 * tracks daylight without going pitch-black at night.
 *
 * @param {Cartesian3} sunDirectionWC Sun direction in world coords (unit,
 *   pointing FROM the surface TOWARD the sun).
 * @param {Cartesian3} localUpWC Local up (surface normal) at the shading point
 *   in world coords — typically the camera position direction (ECEF position
 *   normalized). The sun ZENITH that drives the colour/intensity is measured
 *   against THIS up, so it MUST be the up at the viewed site, not the pole
 *   axis. The optical path is rotationally symmetric, so we build the start
 *   point along this up at the shading altitude.
 * @param {number} cameraAltitude Camera altitude above the ellipsoid (metres,
 *   clamped ≥ 0). Stands in for the shading-point altitude — models on the
 *   globe surface sit within a few km, negligible for the sun-ray integral.
 * @param {number} lightIntensity The atmosphere light intensity
 *   (`SkyAtmosphere.atmosphereLightIntensity`, default ~50) that scales the
 *   sky-irradiance term to agree with the aerial-perspective inscatter.
 * @param {number} baseSunIntensity The user's `scene.light.intensity` (the
 *   un-attenuated sun intensity, default 2.0) that the horizon dimming scales.
 * @returns {AtmosphereDerivedLightingResult} A shared, mutated result object
 *   — copy out the fields you need before the next call.
 * @private
 */
function computeAtmosphereDerivedLighting(
  sunDirectionWC,
  localUpWC,
  cameraAltitude,
  lightIntensity,
  baseSunIntensity,
) {
  const sunDir = Cartesian3.normalize(sunDirectionWC, scratchSunDir);

  const innerRadius = WGS84_MAX_RADIUS;
  const outerRadius = innerRadius + ATMOSPHERE_THICKNESS;
  // Shading point: on the LOCAL up axis at the (clamped) camera altitude.
  // For a surface model this is essentially the ellipsoid surface; the
  // sun-ray optical depth is dominated by the dense lower atmosphere so the
  // exact altitude barely matters, but carrying it keeps high-altitude
  // cameras (less atmosphere above) physically reasonable. The optical path
  // is rotationally symmetric about the planet centre, so building the start
  // point along the local up (instead of an arbitrary axis) is what makes the
  // sun-ZENITH — and therefore the colour/intensity — track the VIEWED SITE,
  // not the pole. (A fixed +Z up made the zenith ~constant over a day → the
  // sun colour never changed; this is the fix.)
  const altitude = Math.max(cameraAltitude, 0.0);
  const startRadius = innerRadius + altitude;
  const up = Cartesian3.normalize(localUpWC, scratchUp);
  const samplePos0 = Cartesian3.multiplyByScalar(
    up,
    startRadius,
    scratchSamplePos,
  );

  // cos(sun zenith) at the shading point.
  const cosSunZenith = Cartesian3.dot(up, sunDir);

  // March the sun ray from the shading point to the top of atmosphere,
  // accumulating Rayleigh + Mie optical depth. If the sun is below the
  // horizon the ray immediately re-enters the planet — treated as fully
  // extinguished (night).
  let rOD = 0.0;
  let mOD = 0.0;
  const sunExit = raySphereFar(samplePos0, sunDir, outerRadius);
  if (sunExit > 0.0 && cosSunZenith > -0.15) {
    const stepLen = sunExit / SUN_RAY_STEPS;
    for (let i = 0; i < SUN_RAY_STEPS; i++) {
      const t = (i + 0.5) * stepLen;
      const px = samplePos0.x + sunDir.x * t;
      const py = samplePos0.y + sunDir.y * t;
      const pz = samplePos0.z + sunDir.z * t;
      const h = Math.max(
        Math.sqrt(px * px + py * py + pz * pz) - innerRadius,
        0.0,
      );
      rOD += Math.exp(-h / RAYLEIGH_SCALE_HEIGHT) * stepLen;
      mOD += Math.exp(-h / MIE_SCALE_HEIGHT) * stepLen;
    }
  } else {
    // Sun below the horizon — saturate the optical depth so the transmitted
    // colour goes to ~0 (night). A large constant path is enough; exp() of it
    // underflows to 0 cleanly.
    rOD = 1.0 / Math.max(RAYLEIGH_COEFFICIENT.z, 1e-12);
    mOD = 1.0 / Math.max(MIE_COEFFICIENT.z, 1e-12);
  }

  // Beer-Lambert transmittance of the sun ray (per channel). Blue extinguishes
  // first (largest Rayleigh coefficient) → the warm sunset hue at low sun.
  const tr = Math.exp(
    -(RAYLEIGH_COEFFICIENT.x * rOD + MIE_COEFFICIENT.x * mOD),
  );
  const tg = Math.exp(
    -(RAYLEIGH_COEFFICIENT.y * rOD + MIE_COEFFICIENT.y * mOD),
  );
  const tb = Math.exp(
    -(RAYLEIGH_COEFFICIENT.z * rOD + MIE_COEFFICIENT.z * mOD),
  );

  // Normalize so the brightest channel is the colour's reference (the sun
  // disc colour); the overall brightness is carried by sunIntensity. This
  // keeps the PBR light colour a well-behaved [0,1] hue while the horizon
  // dimming lives in the intensity (matches how SunLight.color/intensity
  // separate hue from brightness).
  const maxT = Math.max(tr, tg, tb, 1e-6);
  result.sunColor.x = tr / maxT;
  result.sunColor.y = tg / maxT;
  result.sunColor.z = tb / maxT;

  // Sun intensity: the user's base intensity dimmed by how bright the sun is
  // after extinction (maxT) and by a soft horizon falloff. Below the horizon
  // it tends to 0.
  const horizonFalloff = Math.max(Math.min(cosSunZenith * 4.0 + 0.2, 1.0), 0.0);
  result.sunIntensity = baseSunIntensity * maxT * horizonFalloff;

  // ── Sky-irradiance ambient (analytic stand-in for the Bruneton irradiance
  // LUT) ──. The indirect sky IS dominated by Rayleigh-scattered (blue) light,
  // but as a per-object AMBIENT FLOOR it must stay a SUBTLE cool fill, not a
  // dominant blue wash — the direct sun (and, for distant pixels, the aerial-
  // perspective inscatter) carries the scene's colour. So we build a mostly-
  // NEUTRAL grey ambient with only a slight cool bias: a fully Rayleigh-tinted
  // probe blended 75% toward neutral grey. Magnitude tracks how much of the
  // sun is above the horizon (day/night aware) and is comparable at midday to
  // the historical flat 0.2 neutral floor, so existing exposure tuning isn't
  // disturbed. (When the compute LUT lands this becomes a direct read of the
  // irradiance table — the cool, desaturated character matches.)
  const skyDay = Math.max(Math.min(cosSunZenith * 2.0 + 0.3, 1.0), 0.04);
  const rMax = Math.max(
    RAYLEIGH_COEFFICIENT.x,
    Math.max(RAYLEIGH_COEFFICIENT.y, RAYLEIGH_COEFFICIENT.z),
  );
  const ambientBase = 0.22 * skyDay;
  // Rayleigh tint direction (blue-heavy), normalized to its max channel.
  const tintR = RAYLEIGH_COEFFICIENT.x / rMax;
  const tintG = RAYLEIGH_COEFFICIENT.y / rMax;
  const tintB = 1.0;
  // Blend 75% toward neutral grey (1,1,1) so the ambient is a soft cool fill,
  // not a saturated blue overlay that fights the direct sun's hue.
  const NEUTRAL_MIX = 0.75;
  const mixR = tintR * (1.0 - NEUTRAL_MIX) + NEUTRAL_MIX;
  const mixG = tintG * (1.0 - NEUTRAL_MIX) + NEUTRAL_MIX;
  const mixB = tintB * (1.0 - NEUTRAL_MIX) + NEUTRAL_MIX;
  result.skyIrradiance.x = ambientBase * mixR + 0.02;
  result.skyIrradiance.y = ambientBase * mixG + 0.02;
  result.skyIrradiance.z = ambientBase * mixB + 0.02;
  // `lightIntensity` is reserved for the LUT-backed irradiance follow-on
  // (it scales the baked irradiance table); touch it so the analytic path
  // and the future LUT path share one signature.
  void lightIntensity;

  return result;
}

const scratchLocalUp = new Cartesian3();

/**
 * Resolve the atmosphere-derived sun light and sky-irradiance ambient for a
 * scene and publish them on its frame state, replacing the plain sun light
 * for this frame only.
 *
 * Deriving model sun and sky lighting from the same atmosphere that supplies
 * post-process extinction and inscatter keeps terrain and models lit by one
 * coherent source. `scene.light` and any custom light the user installed are
 * left untouched; the derived values live only on the private frame-state
 * light and sky-irradiance fields.
 *
 * The sun direction comes from `uniformState`, which the scene has not
 * updated yet when this runs, so it lags by one frame — indistinguishable at
 * any realistic simulation rate.
 *
 * Backends opt in by calling this; it is never invoked from shared scene
 * code, so a backend that does not call it sees `frameState.light` exactly as
 * the scene published it.
 *
 * @param {object} scene The scene whose frame state is being prepared. Reads
 *   `aerialPerspective`, `light`, `camera`, `skyAtmosphere` and the private
 *   `_context`, `_atmosphereDerivedLight` and `_atmosphereSkyIrradiance`
 *   scratch it reuses across frames.
 * @param {object} frameState The frame state to publish onto.
 * @returns {boolean} True when the derived light was applied; false when the
 *   scene is outside the derivation's domain and the frame state was left
 *   untouched.
 * @private
 */
function applySceneAtmosphereDerivedLighting(scene, frameState) {
  if (scene.aerialPerspective !== true) {
    return false;
  }
  const light = scene.light;
  if (!(light instanceof SunLight)) {
    return false;
  }
  const sunDirectionWC = scene._context?.uniformState?.sunDirectionWC;
  const cameraPositionWC = scene.camera?.positionWC;
  if (!defined(sunDirectionWC) || !defined(cameraPositionWC)) {
    return false;
  }

  const altitude = scene.camera?.positionCartographic?.height ?? 0.0;
  const baseIntensity = light.intensity ?? 2.0;
  const lightIntensity = scene.skyAtmosphere?.atmosphereLightIntensity ?? 50.0;
  // The normalized camera position is the local surface normal. Measuring the
  // Sun zenith against it follows the viewed location's time of day instead of
  // the ellipsoid's pole axis.
  const localUp = Cartesian3.normalize(cameraPositionWC, scratchLocalUp);
  const derived = computeAtmosphereDerivedLighting(
    sunDirectionWC,
    localUp,
    altitude,
    lightIntensity,
    baseIntensity,
  );

  const derivedLight = scene._atmosphereDerivedLight;
  derivedLight.color.red = derived.sunColor.x;
  derivedLight.color.green = derived.sunColor.y;
  derivedLight.color.blue = derived.sunColor.z;
  derivedLight.color.alpha = 1.0;
  derivedLight.intensity = derived.sunIntensity;
  frameState.light = derivedLight;
  Cartesian3.clone(derived.skyIrradiance, scene._atmosphereSkyIrradiance);
  frameState.atmosphereSkyIrradiance = scene._atmosphereSkyIrradiance;
  return true;
}

export default computeAtmosphereDerivedLighting;
export {
  applySceneAtmosphereDerivedLighting,
  RAYLEIGH_COEFFICIENT,
  MIE_COEFFICIENT,
  RAYLEIGH_SCALE_HEIGHT,
  MIE_SCALE_HEIGHT,
  ATMOSPHERE_THICKNESS,
  WGS84_MAX_RADIUS,
};
