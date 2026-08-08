import CloudType from "./CloudType.js";
import Frozen from "../Core/Frozen.js";

/**
 * A backend-neutral, plain data holder for the configuration of a WebGPU
 * volumetric (ray-marched) cloud deck driven through a {@link CloudCollection}.
 *
 * <p><b>WebGPU only.</b> Every field on this object is consumed exclusively by
 * the WebGPU procedural / volumetric cloud renderer. On the WebGL renderer these
 * fields are inert stores with no rendering effect and never throw — the
 * collection's billboard path ignores them entirely. This follows the fork's
 * opt-in, default-off, graceful-no-op convention, so a scene authored for both
 * backends renders byte-identically on WebGL.</p>
 *
 * <p>The field names match the <code>globe.cloud*</code> fields the volumetric
 * renderer reads (<code>cloudCoverage</code>,
 * <code>cloudLayerBottom</code>/<code>Top</code>, <code>cloudDensity</code>,
 * <code>cloudWindSpeed</code>, …) exactly. A <code>CloudVolumetrics</code>
 * instance is therefore structurally interchangeable with the globe as a config
 * source, which is what lets the byte-locked 136-float
 * <code>CloudUniforms</code> packer and its roughly 50 read sites stay
 * unchanged.</p>
 *
 * <p>It also gives public, documented homes to three fields the renderer
 * otherwise reaches only through <code>globe as unknown as {…}</code> casts:
 * <code>cloudMultiDeck</code>, <code>cloudHighPrecision</code>, and the
 * <code>cloudSpecies*</code> family.</p>
 *
 * <p>Instances are created lazily by {@link CloudCollection} and exposed as
 * <code>collection.volumetric</code>.</p>
 *
 * @alias CloudVolumetrics
 * @constructor
 *
 * @param {object} [options] Object with overrides for any of the fields below.
 *
 * @see CloudCollection
 * @see CloudType
 * @see CloudTypeProfile
 */
function CloudVolumetrics(options) {
  options = options ?? Frozen.EMPTY_OBJECT;

  /**
   * Master gate. When <code>true</code> and using the WebGPU renderer, the
   * owning {@link CloudCollection} additionally drives a volumetric ray-marched
   * cloud deck. Has no effect on the WebGL path.
   * @type {boolean}
   * @default false
   */
  this.enabled = options.enabled ?? false;

  // ── Shell / coverage / wind (globe.cloud* parity defaults) ──

  /**
   * Global cloud coverage factor (0 = clear sky, 1 = fully overcast). WebGPU only.
   * @type {number}
   * @default 0.5
   */
  this.cloudCoverage = options.cloudCoverage ?? 0.5;

  /**
   * Bottom altitude of the cloud layer in meters above sea level. WebGPU only.
   * @type {number}
   * @default 1500.0
   */
  this.cloudLayerBottom = options.cloudLayerBottom ?? 1500.0;

  /**
   * Top altitude of the cloud layer in meters above sea level. WebGPU only.
   * @type {number}
   * @default 4000.0
   */
  this.cloudLayerTop = options.cloudLayerTop ?? 4000.0;

  /**
   * Wind advection speed for the cloud field. WebGPU only.
   * @type {number}
   * @default 15.0
   */
  this.cloudWindSpeed = options.cloudWindSpeed ?? 15.0;

  /**
   * Horizontal wind direction (a 2D <code>{x, y}</code> vector) for cloud
   * advection. WebGPU only.
   * @type {object}
   * @default {x: 0.7, y: 0.3}
   */
  this.cloudWindDirection = cloneXY(
    options.cloudWindDirection ?? { x: 0.7, y: 0.3 },
  );

  /**
   * Cloud density multiplier. Higher = thicker / more opaque clouds. WebGPU only.
   * @type {number}
   * @default 0.3
   */
  this.cloudDensity = options.cloudDensity ?? 0.3;

  /**
   * Aerial-perspective strength for distant procedural clouds. WebGPU only.
   * @type {number}
   * @default 1.0
   */
  this.cloudAerialStrength = options.cloudAerialStrength ?? 1.0;

  /**
   * When <code>true</code>, the procedural cloud renderer rasterizes the cloud
   * layer's optical depth into a shadow field. WebGPU only.
   * @type {boolean}
   * @default false
   */
  this.cloudCastShadows = options.cloudCastShadows ?? false;

  /**
   * When <code>true</code> (and {@link CloudVolumetrics#cloudCastShadows} is
   * on), the cloud beer-shadow-map is rendered as THREE cascades (near / mid /
   * far, reusing the terrain-CSM geometric split scheme) into a stacked atlas,
   * with progressively fewer light-march steps per cascade. The globe terrain
   * samples the finest cascade whose footprint contains the fragment — crisp
   * near cloud shadows without losing the cheap far coverage. Opt-in quality
   * tier; when off the single beer-shadow-map is byte-identical. WebGPU only.
   * @type {boolean}
   * @default false
   */
  this.cloudShadowCascades = options.cloudShadowCascades ?? false;

  /**
   * When <code>true</code>, the dynamic environment map folds the procedural
   * cloud cover into its IBL. WebGPU only.
   * @type {boolean}
   * @default false
   */
  this.cloudContributesIBL = options.cloudContributesIBL ?? false;

  /**
   * When <code>true</code>, the procedural cloud renderer marches one cloud
   * shell per active deck (multi-deck). Previously a cast-only globe field.
   * WebGPU only.
   * @type {boolean}
   * @default false
   */
  this.cloudMultiDeck = options.cloudMultiDeck ?? false;

  /**
   * When <code>true</code>, the raymarch encodes the camera world position as a
   * high/low f32 pair (RTE cancellation reduction). Planetary precision is on by
   * default; setting this to <code>false</code> retains the explicit legacy A/B
   * path. Previously a cast-only globe field. WebGPU only.
   * @type {boolean}
   * @default true
   */
  this.cloudHighPrecision = options.cloudHighPrecision ?? true;

  // ── Quality ──

  /**
   * Number of ray-march steps for cloud rendering (32-128). WebGPU only.
   * @type {number}
   * @default 64
   */
  this.cloudQuality = options.cloudQuality ?? 64;

  /**
   * Volumetric cloud quality preset. One of <code>"auto"</code>,
   * <code>"low"</code>, <code>"medium"</code>, <code>"high"</code>,
   * <code>"ultra"</code>. WebGPU only.
   * @type {string}
   * @default "auto"
   */
  this.cloudVolumetricQuality = options.cloudVolumetricQuality ?? "auto";

  // ── Genus (WMO) ──

  /**
   * Collection-level cloud genus selecting the altitude deck +
   * {@link CloudTypeProfile}. When <code>undefined</code> the renderer applies
   * its own default profile. WebGPU only.
   * @type {CloudType|undefined}
   * @default undefined
   */
  this.cloudType = options.cloudType;

  // ── Aerial / ambient modes ──

  /**
   * Aerial-perspective mode for distant clouds: <code>"heuristic"</code> or
   * <code>"physical"</code>. WebGPU only.
   * @type {string}
   * @default "heuristic"
   */
  this.cloudAerialMode = options.cloudAerialMode ?? "heuristic";

  /**
   * Cloud shadow-side ambient source: <code>"constant"</code> or
   * <code>"sky"</code>. WebGPU only.
   * @type {string}
   * @default "constant"
   */
  this.cloudAmbientSource = options.cloudAmbientSource ?? "constant";

  // ── Live-tweakable appearance dials (renderer supplies its own default when
  //    left undefined — mirrors globe.cloud* which are undefined by default) ──

  /** Silver-lining rim intensity. WebGPU only. @type {number|undefined} */
  this.cloudSilverLiningIntensity = options.cloudSilverLiningIntensity;
  /** Henyey-Greenstein forward scattering g. WebGPU only. @type {number|undefined} */
  this.cloudPhaseForwardG = options.cloudPhaseForwardG;
  /** Henyey-Greenstein back scattering g. WebGPU only. @type {number|undefined} */
  this.cloudPhaseBackG = options.cloudPhaseBackG;
  /** Forward/back phase blend. WebGPU only. @type {number|undefined} */
  this.cloudPhaseBlend = options.cloudPhaseBlend;
  /** Ambient lighting intensity. WebGPU only. @type {number|undefined} */
  this.cloudAmbientIntensity = options.cloudAmbientIntensity;
  /** Edge erosion strength. WebGPU only. @type {number|undefined} */
  this.cloudErosionStrength = options.cloudErosionStrength;
  /** Curl-noise swirl amplitude. WebGPU only. @type {number|undefined} */
  this.cloudCurlAmplitude = options.cloudCurlAmplitude;
  /** Curl-noise swirl wavelength. WebGPU only. @type {number|undefined} */
  this.cloudCurlFrequency = options.cloudCurlFrequency;
  /** Baked cloud-shape noise morphology. WebGPU only. @type {number|undefined} */
  this.cloudNoiseMorphology = options.cloudNoiseMorphology;
  /** Baked puff size. WebGPU only. @type {number|undefined} */
  this.cloudPuffSize = options.cloudPuffSize;
  /** Reinhard tone-map exposure at the cloud composite. WebGPU only. @type {number|undefined} */
  this.cloudExposure = options.cloudExposure;
  /** Multiple-scattering scatter decay. WebGPU only. @type {number|undefined} */
  this.cloudMsDecayScatter = options.cloudMsDecayScatter;
  /** Multiple-scattering extinction decay. WebGPU only. @type {number|undefined} */
  this.cloudMsDecayExtinction = options.cloudMsDecayExtinction;
  /** Multiple-scattering phase decay. WebGPU only. @type {number|undefined} */
  this.cloudMsDecayPhase = options.cloudMsDecayPhase;

  // ── Weather map / provider ──

  /**
   * Enables the data-driven weather map for the procedural volumetric clouds.
   * WebGPU only.
   * @type {boolean}
   * @default false
   */
  this.cloudWeatherMap = options.cloudWeatherMap ?? false;

  /**
   * How strongly the weather map's G/B/A channels modulate the clouds. WebGPU only.
   * @type {number|undefined}
   */
  this.cloudWeatherChannelStrength = options.cloudWeatherChannelStrength;

  /**
   * A {@link WeatherProvider} that fetches a cloud-cover field from an open data
   * source and bakes it into the weather map. WebGPU only.
   * @type {object|undefined}
   */
  this.weatherProvider = options.weatherProvider;

  // ── Exotic E2: mammatus (already-shipped uniform slots 128-131) ──

  /** Mammatus (pendulous pouches) strength. WebGPU only. @type {number|undefined} */
  this.cloudMammatusStrength = options.cloudMammatusStrength;
  /** Mammatus lobe scale. WebGPU only. @type {number|undefined} */
  this.cloudMammatusScale = options.cloudMammatusScale;
  /** Mammatus pouch depth. WebGPU only. @type {number|undefined} */
  this.cloudMammatusDepth = options.cloudMammatusDepth;

  // ── Exotic E1: species / varieties (uniform slots 132-135) ──

  /**
   * Species name (e.g. <code>"lenticularis"</code>, <code>"fibratus"</code>,
   * <code>"uncinus"</code>) selecting a density-shaping mode. Previously a
   * cast-only globe field. WebGPU only.
   * @type {string|undefined}
   */
  this.cloudSpecies = options.cloudSpecies;
  /** Numeric species mode (0 = off). WebGPU only. @type {number|undefined} */
  this.cloudSpeciesMode = options.cloudSpeciesMode;
  /** Species density-shaping strength. WebGPU only. @type {number|undefined} */
  this.cloudSpeciesStrength = options.cloudSpeciesStrength;
  /** Species pattern scale. WebGPU only. @type {number|undefined} */
  this.cloudSpeciesScale = options.cloudSpeciesScale;
  /** Species mode-specific extra parameter. WebGPU only. @type {number|undefined} */
  this.cloudSpeciesParam = options.cloudSpeciesParam;

  // ── Exotic E2 remaining: supplementary features (uniform slots 136-139) ──

  /**
   * Feature name (e.g. <code>"asperitas"</code>, <code>"fluctus"</code>,
   * <code>"arcus"</code>, <code>"virga"</code>) selecting a density-shaping
   * mode. WebGPU only.
   * @type {string|undefined}
   */
  this.cloudFeature = options.cloudFeature;
  /** Numeric feature mode (0 = off). WebGPU only. @type {number|undefined} */
  this.cloudFeatureMode = options.cloudFeatureMode;
  /** Feature density-shaping strength. WebGPU only. @type {number|undefined} */
  this.cloudFeatureStrength = options.cloudFeatureStrength;
  /** Feature pattern scale. WebGPU only. @type {number|undefined} */
  this.cloudFeatureScale = options.cloudFeatureScale;
  /** Feature mode-specific extra parameter. WebGPU only. @type {number|undefined} */
  this.cloudFeatureParam = options.cloudFeatureParam;

  // ── Exotic E3: special luminous forms (iridescent color tint) ──

  /**
   * Special "shining" high-altitude cloud form (e.g. noctilucent, nacreous).
   * WebGPU only.
   * @type {string|undefined}
   */
  this.cloudSpecial = options.cloudSpecial;
  /** Iridescent tint blend depth. WebGPU only. @type {number|undefined} */
  this.cloudSpecialShadeStrength = options.cloudSpecialShadeStrength;
  /** Iridescence scale. WebGPU only. @type {number|undefined} */
  this.cloudSpecialShadeScale = options.cloudSpecialShadeScale;
  /** Mode-specific iridescence parameter. WebGPU only. @type {number|undefined} */
  this.cloudSpecialShadeParam = options.cloudSpecialShadeParam;

  // LOD dials that bound the march cost from orbit.

  /**
   * Geometric growth of the view-ray march step per fine step. <code>1.0</code>
   * (default/undefined) is a no-op — the march comb is uniform and the render is
   * byte-identical. Values in <code>(1.0, 1.1]</code> grow the step with distance
   * so near cloud samples stay crisp while far shell samples (which read as 1-2 px)
   * coarsen, cutting far-shell march cost. WebGPU only.
   * @type {number|undefined}
   */
  this.cloudMarchStepGrowth = options.cloudMarchStepGrowth;
  /**
   * Far cap on the view-ray cloud march, in meters. <code>0</code>
   * (default/undefined) is a no-op — the march runs to the full shell exit. A
   * positive value stops the march past that distance, where the cloud shell is
   * sub-pixel and pays full march budget for negligible return. WebGPU only.
   * @type {number|undefined}
   */
  this.cloudMaxRayDistance = options.cloudMaxRayDistance;
}

function cloneXY(v) {
  return { x: v.x ?? 0.0, y: v.y ?? 0.0 };
}

// Re-export the genus default so callers can reference it without a second
// import when constructing a CloudVolumetrics directly.
CloudVolumetrics.DEFAULT_CLOUD_TYPE = CloudType.CUMULUS;

export default CloudVolumetrics;
