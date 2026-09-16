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

  // corrected 2026-09-12, C13-N34: "ultra" was documented here as though it
  // worked. It is honoured by neither resolver — `resolveTier`
  // (WebGPUCloudTierPresets) and `resolveCloudQuality`
  // (WebGPUProceduralCloudRenderer) fall anything that is not low/medium/high
  // through to the "auto" altitude bands. It is marked reserved rather than
  // deleted, because the fork is funding it: deleting the string would satisfy
  // the literal wording of C13-N12's acceptance ("no longer documents an
  // unimplemented value") while leaving its deliverable unbuilt.
  // THIS EDIT DISCHARGES NEITHER C13-N12 NOR C13-N41 — it corrects a false
  // claim and nothing more.
  /**
   * Volumetric cloud quality preset. One of <code>"auto"</code>,
   * <code>"low"</code>, <code>"medium"</code> or <code>"high"</code>.
   *
   * <code>"ultra"</code> is accepted but reserved — no resolver honours it yet,
   * so today it falls through to the automatic altitude bands — with row
   * <code>C13-N12</code> (the S4 rung, WebGPU-only by design) and
   * <code>C13-N41</code> (the public two-axis quality surface) owning the work
   * that makes it real.
   *
   * WebGPU only.
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

  // corrected 2026-09-16, C13-N20 (ruling R-2026-09-16-4): this defaulted to
  // "heuristic", and `CloudCollection._resolveVolumetricConfig` spreads this
  // instance verbatim, so the dial reached the renderer as a string on every
  // frame. The renderer's promotion clause consults its altitude default only
  // when the dial is UNSET, so the clause was unreachable through the public
  // API — dead for every caller, and a false premise for any measurement taken
  // "with the promotion active". The unset state is now spelled "auto", the
  // same sentinel `cloudVolumetricQuality` above already uses for "the renderer
  // decides", which keeps the state nameable, settable back and typed {string}.
  // `undefined` still resolves identically, for a duck-typed config that
  // declares no dial at all.
  /**
   * Aerial-perspective mode for distant clouds. One of <code>"auto"</code>,
   * which lets the renderer pick per frame, <code>"heuristic"</code>, the
   * analytic distance term, or <code>"physical"</code>, which samples the baked
   * sky-view and transmittance LUTs.
   *
   * Under <code>"auto"</code> the renderer resolves to <code>"physical"</code>
   * at or above the volumetric disable altitude, where the analytic term is
   * pinned at its cap for every pixel and reads as a flat haze wash, and to
   * <code>"heuristic"</code> below it (<code>C13-N20</code>). An explicit value
   * wins in both directions.
   *
   * WebGPU only.
   * @type {string}
   * @default "auto"
   */
  this.cloudAerialMode = options.cloudAerialMode ?? "auto";

  // corrected 2026-09-12, C13-N34: the alternative was documented as "sky",
  // which no consumer has ever read. The renderer's only test is
  // `cloudAmbientSource === "sky-lut"` (`ambientLutOn`, uniform float 109), the
  // spelling ProceduralClouds.wgsl also names. The dead spelling is recorded
  // here rather than silently swapped, because a caller may have set "sky" and
  // seen nothing happen.
  /**
   * Cloud shadow-side ambient source: <code>"constant"</code>, a fixed ambient
   * term, or <code>"sky-lut"</code>, which samples the baked sky-ambient LUT.
   * WebGPU only.
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
  // corrected 2026-09-12, C13-N34: the @type read {number|undefined}; the value
  // is a string the renderer compares (`=== "perlin-worley"`), and
  // cesium-js-types.d.ts already declared `cloudNoiseMorphology?: string`.
  /**
   * Baked cloud-shape noise morphology. <code>"perlin-worley"</code> selects the
   * separately baked Perlin-Worley shape texture; any other value, including
   * <code>undefined</code>, keeps the value-FBM bake. WebGPU only.
   * @type {string|undefined}
   */
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

  // corrected 2026-09-12, C13-N34: the "e.g." list omitted the "lenticular"
  // alias the renderer honours. The list is now exhaustive — every name here is
  // one the species resolver tests, and it tests no others.
  /**
   * Species name selecting a density-shaping mode: <code>"lenticularis"</code>
   * (alias <code>"lenticular"</code>), <code>"fibratus"</code> or
   * <code>"uncinus"</code>. Case-insensitive. Previously a cast-only globe
   * field. WebGPU only.
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

  // corrected 2026-09-12, C13-N34: the "e.g." list omitted three names the
  // feature resolver honours — the "kelvin-helmholtz"/"kelvinhelmholtz" aliases
  // of fluctus, and "praecipitatio", which shares virga's mode with a denser
  // parameter. The list is now exhaustive.
  /**
   * Feature name selecting a density-shaping mode: <code>"asperitas"</code>,
   * <code>"fluctus"</code> (aliases <code>"kelvin-helmholtz"</code> and
   * <code>"kelvinhelmholtz"</code>), <code>"arcus"</code>,
   * <code>"virga"</code> or <code>"praecipitatio"</code>. Case-insensitive.
   * WebGPU only.
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

  // corrected 2026-09-12, C13-N34: the form names were prose examples, not the
  // set the renderer tests, and the numeric `cloudSpecialShadeMode` companion
  // the packer reads was undeclared while its Strength/Scale/Param siblings
  // were declared. Both are now stated.
  /**
   * Special "shining" high-altitude cloud form, as an iridescent shading tint:
   * <code>"noctilucent"</code> (alias <code>"nlc"</code>) or
   * <code>"nacreous"</code> (aliases <code>"polar-stratospheric"</code> and
   * <code>"psc"</code>). Case-insensitive. This supplies only the shading; the
   * high-altitude deck itself is placed through the multi-deck high bounds.
   * WebGPU only.
   * @type {string|undefined}
   */
  this.cloudSpecial = options.cloudSpecial;
  /**
   * Numeric special-shade mode (0 = off, 1 = noctilucent, 2 = nacreous), the
   * equivalent of naming the form through {@link CloudVolumetrics#cloudSpecial}.
   * A recognized name overrides it; an unrecognized one leaves it standing.
   * WebGPU only.
   * @type {number|undefined}
   */
  this.cloudSpecialShadeMode = options.cloudSpecialShadeMode;
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
