import BoundingSphere from "../Core/BoundingSphere.js";
import buildModuleUrl from "../Core/buildModuleUrl.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import EllipsoidTerrainProvider from "../Core/EllipsoidTerrainProvider.js";
import Event from "../Core/Event.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import NearFarScalar from "../Core/NearFarScalar.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import Resource from "../Core/Resource.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import Texture from "../Renderer/Texture.js";
import GlobeFS from "../Shaders/GlobeFS.js";
import GlobeVS from "../Shaders/GlobeVS.js";
import AtmosphereCommon from "../Shaders/AtmosphereCommon.js";
import GroundAtmosphere from "../Shaders/GroundAtmosphere.js";
import GlobeSurfaceShaderSet from "./GlobeSurfaceShaderSet.js";
import GlobeSurfaceTileProvider from "./GlobeSurfaceTileProvider.js";
import GlobeTranslucency from "./GlobeTranslucency.js";
import ImageryLayerCollection from "./ImageryLayerCollection.js";
import QuadtreePrimitive from "./QuadtreePrimitive.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import CesiumMath from "../Core/Math.js";

/**
 * The globe rendered in the scene, including its terrain ({@link Globe#terrainProvider})
 * and imagery layers ({@link Globe#imageryLayers}).  Access the globe using {@link Scene#globe}.
 *
 * @alias Globe
 *
 * @param {Ellipsoid} [ellipsoid=Ellipsoid.default] Determines the size and shape of the
 * globe.
 */
class Globe {
  constructor(ellipsoid) {
    ellipsoid = ellipsoid ?? Ellipsoid.default;
    const terrainProvider = new EllipsoidTerrainProvider({
      ellipsoid: ellipsoid,
    });
    const imageryLayerCollection = new ImageryLayerCollection();

    this._ellipsoid = ellipsoid;
    this._imageryLayerCollection = imageryLayerCollection;

    this._surfaceShaderSet = new GlobeSurfaceShaderSet();
    this._material = undefined;

    this._surface = new QuadtreePrimitive({
      tileProvider: new GlobeSurfaceTileProvider({
        terrainProvider: terrainProvider,
        imageryLayers: imageryLayerCollection,
        surfaceShaderSet: this._surfaceShaderSet,
      }),
    });

    this._terrainProvider = terrainProvider;
    this._terrainProviderChanged = new Event();

    this._undergroundColor = Color.clone(Color.BLACK);
    this._undergroundColorAlphaByDistance = new NearFarScalar(
      ellipsoid.maximumRadius / 1000.0,
      0.0,
      ellipsoid.maximumRadius / 5.0,
      1.0,
    );

    this._translucency = new GlobeTranslucency();

    makeShadersDirty(this);

    /**
     * Determines if the globe will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = true;

    this._oceanNormalMapResourceDirty = true;
    this._oceanNormalMapResource = new Resource({
      url: buildModuleUrl("Assets/Textures/waterNormalsSmall.jpg"),
    });

    /**
     * The maximum screen-space error used to drive level-of-detail refinement.  Higher
     * values will provide better performance but lower visual quality.
     *
     * @type {number}
     * @default 2
     */
    this.maximumScreenSpaceError = 2;

    /**
     * The size of the terrain tile cache, expressed as a number of tiles.  Any additional
     * tiles beyond this number will be freed, as long as they aren't needed for rendering
     * this frame.  A larger number will consume more memory but will show detail faster
     * when, for example, zooming out and then back in.
     *
     * @type {number}
     * @default 100
     */
    this.tileCacheSize = 100;

    /**
     * Gets or sets the number of loading descendant tiles that is considered "too many".
     * If a tile has too many loading descendants, that tile will be loaded and rendered before any of
     * its descendants are loaded and rendered. This means more feedback for the user that something
     * is happening at the cost of a longer overall load time. Setting this to 0 will cause each
     * tile level to be loaded successively, significantly increasing load time. Setting it to a large
     * number (e.g. 1000) will minimize the number of tiles that are loaded but tend to make
     * detail appear all at once after a long wait.
     * @type {number}
     * @default 20
     */
    this.loadingDescendantLimit = 20;

    /**
     * Gets or sets a value indicating whether the ancestors of rendered tiles should be preloaded.
     * Setting this to true optimizes the zoom-out experience and provides more detail in
     * newly-exposed areas when panning. The down side is that it requires loading more tiles.
     * @type {boolean}
     * @default true
     */
    this.preloadAncestors = true;

    /**
     * Gets or sets a value indicating whether the siblings of rendered tiles should be preloaded.
     * Setting this to true causes tiles with the same parent as a rendered tile to be loaded, even
     * if they are culled. Setting this to true may provide a better panning experience at the
     * cost of loading more tiles.
     * @type {boolean}
     * @default false
     */
    this.preloadSiblings = false;

    /**
     * The color to use to highlight terrain fill tiles. If undefined, fill tiles are not
     * highlighted at all. The alpha value is used to alpha blend with the tile's
     * actual color. Because terrain fill tiles do not represent the actual terrain surface,
     * it may be useful in some applications to indicate visually that they are not to be trusted.
     * @type {Color}
     * @default undefined
     */
    this.fillHighlightColor = undefined;

    /**
     * Enable lighting the globe with the scene's light source.
     *
     * @type {boolean}
     * @default false
     */
    this.enableLighting = false;

    /**
     * A multiplier to adjust terrain lambert lighting.
     * This number is multiplied by the result of <code>czm_getLambertDiffuse</code> in GlobeFS.glsl.
     * This only takes effect when <code>enableLighting</code> is <code>true</code>.
     *
     * @type {number}
     * @default 0.9
     */
    this.lambertDiffuseMultiplier = 0.9;

    /**
     * Enable dynamic lighting effects on atmosphere and fog. This only takes effect
     * when <code>enableLighting</code> is <code>true</code>.
     *
     * @type {boolean}
     * @default true
     */
    this.dynamicAtmosphereLighting = true;

    /**
     * Whether dynamic atmosphere lighting uses the sun direction instead of the scene's
     * light direction. This only takes effect when <code>enableLighting</code> and
     * <code>dynamicAtmosphereLighting</code> are <code>true</code>.
     *
     * @type {boolean}
     * @default false
     */
    this.dynamicAtmosphereLightingFromSun = false;

    /**
     * Enable the ground atmosphere, which is drawn over the globe when viewed from a distance between <code>lightingFadeInDistance</code> and <code>lightingFadeOutDistance</code>.
     *
     * @type {boolean}
     * @default true when using the WGS84 ellipsoid, false otherwise
     */
    this.showGroundAtmosphere = Ellipsoid.WGS84.equals(ellipsoid);

    /**
     * The intensity of the light that is used for computing the ground atmosphere color.
     *
     * @type {number}
     * @default 10.0
     */
    this.atmosphereLightIntensity = 10.0;

    /**
     * The Rayleigh scattering coefficient used in the atmospheric scattering equations for the ground atmosphere.
     *
     * @type {Cartesian3}
     * @default Cartesian3(5.5e-6, 13.0e-6, 28.4e-6)
     */
    this.atmosphereRayleighCoefficient = new Cartesian3(
      5.5e-6,
      13.0e-6,
      28.4e-6,
    );

    /**
     * The Mie scattering coefficient used in the atmospheric scattering equations for the ground atmosphere.
     *
     * @type {Cartesian3}
     * @default Cartesian3(21e-6, 21e-6, 21e-6)
     */
    this.atmosphereMieCoefficient = new Cartesian3(21e-6, 21e-6, 21e-6);

    /**
     * The Rayleigh scale height used in the atmospheric scattering equations for the ground atmosphere, in meters.
     *
     * @type {number}
     * @default 10000.0
     */
    this.atmosphereRayleighScaleHeight = 10000.0;

    /**
     * The Mie scale height used in the atmospheric scattering equations for the ground atmosphere, in meters.
     *
     * @type {number}
     * @default 3200.0
     */
    this.atmosphereMieScaleHeight = 3200.0;

    /**
     * The anisotropy of the medium to consider for Mie scattering.
     * <p>
     * Valid values are between -1.0 and 1.0.
     * </p>
     * @type {number}
     * @default 0.9
     */
    this.atmosphereMieAnisotropy = 0.9;

    /**
     * The distance where everything becomes lit. This only takes effect
     * when <code>enableLighting</code> or <code>showGroundAtmosphere</code> is <code>true</code>.
     *
     * @type {number}
     * @default 1/2 * pi * ellipsoid.minimumRadius
     */
    this.lightingFadeOutDistance =
      CesiumMath.PI_OVER_TWO * ellipsoid.minimumRadius;

    /**
     * The distance where lighting resumes. This only takes effect
     * when <code>enableLighting</code> or <code>showGroundAtmosphere</code> is <code>true</code>.
     *
     * @type {number}
     * @default pi * ellipsoid.minimumRadius
     */
    this.lightingFadeInDistance = CesiumMath.PI * ellipsoid.minimumRadius;

    /**
     * The distance where the darkness of night from the ground atmosphere fades out to a lit ground atmosphere.
     * This only takes effect when <code>showGroundAtmosphere</code>, <code>enableLighting</code>, and
     * <code>dynamicAtmosphereLighting</code> are <code>true</code>.
     *
     * @type {number}
     * @default 1/2 * pi * ellipsoid.minimumRadius
     */
    this.nightFadeOutDistance =
      CesiumMath.PI_OVER_TWO * ellipsoid.minimumRadius;

    /**
     * The distance where the darkness of night from the ground atmosphere fades in to an unlit ground atmosphere.
     * This only takes effect when <code>showGroundAtmosphere</code>, <code>enableLighting</code>, and
     * <code>dynamicAtmosphereLighting</code> are <code>true</code>.
     *
     * @type {number}
     * @default 5/2 * pi * ellipsoid.minimumRadius
     */
    this.nightFadeInDistance =
      5.0 * CesiumMath.PI_OVER_TWO * ellipsoid.minimumRadius;

    /**
     * True if an animated wave effect should be shown in areas of the globe
     * covered by water; otherwise, false.  This property is ignored if the
     * <code>terrainProvider</code> does not provide a water mask.
     *
     * @type {boolean}
     * @default true
     */
    this.showWaterEffect = true;

    // ═══════════════════════════════════════════════════════════════
    // Enhanced rendering configuration (WebGPU)
    // These properties are opt-in and only take effect in the WebGPU
    // renderer. They have no effect on the WebGL path.
    // ═══════════════════════════════════════════════════════════════

    /**
     * When true, night-side imagery layers with nightAlpha > dayAlpha
     * are treated as emissive city lights, boosted proportional to
     * their luminance. Only active with enableLighting.
     * @type {boolean}
     * @default true
     */
    this.enableNightLights = true;

    /**
     * Multiplier for night-side city light emission brightness.
     * Higher values = brighter city lights. 0 = no emission.
     * @type {number}
     * @default 2.5
     */
    this.nightIntensity = 2.5;

    /**
     * When true, enhanced ocean rendering is active: Fresnel reflection,
     * GGX specular, multi-octave wave normals, foam/whitecaps, subsurface
     * scattering, and deep water color.
     * @type {boolean}
     * @default true
     */
    this.enableEnhancedOcean = true;

    /**
     * Deep ocean water color (RGB). Blended with imagery on water surfaces.
     * @type {object}
     * @default { x: 0.008, y: 0.045, z: 0.12 }
     */
    this.oceanDeepColor = { x: 0.008, y: 0.045, z: 0.12 };

    /**
     * Fresnel exponent controlling how reflective water is at grazing angles.
     * Higher values = more reflective at shallow viewing angles.
     * @type {number}
     * @default 5.0
     */
    this.oceanFresnelPower = 5.0;

    /**
     * Base reflectivity of water at normal incidence (F0).
     * Physical water is 0.02-0.04. Higher for stylized water.
     * @type {number}
     * @default 0.04
     */
    this.oceanReflectivity = 0.04;

    /**
     * Wave steepness threshold for generating foam/whitecaps.
     * Lower values = more foam. Range 0-1.
     * @type {number}
     * @default 0.35
     */
    this.oceanFoamThreshold = 0.35;

    /**
     * How much the water surface darkens imagery beneath it.
     * 1.0 = no darkening, 0.0 = fully dark. Default 0.6.
     * @type {number}
     * @default 0.6
     */
    this.oceanDarkening = 0.6;

    /**
     * When true, renders volumetric procedural clouds using ray marching.
     * WebGPU only. Significant GPU cost — use cloudQuality to control.
     * @type {boolean}
     * @default false
     */
    this.showProceduralClouds = false;

    /**
     * Global cloud coverage factor (0 = clear sky, 1 = fully overcast).
     * @type {number}
     * @default 0.5
     */
    this.cloudCoverage = 0.5;

    /**
     * Bottom altitude of the cloud layer in meters above sea level.
     * @type {number}
     * @default 1500.0
     */
    this.cloudLayerBottom = 1500.0;

    /**
     * Top altitude of the cloud layer in meters above sea level.
     * @type {number}
     * @default 4000.0
     */
    this.cloudLayerTop = 4000.0;

    /**
     * Cloud wind speed in meters per second for animation.
     * @type {number}
     * @default 15.0
     */
    this.cloudWindSpeed = 15.0;

    /**
     * Cloud wind direction as a 2D vector (x=east, y=north).
     * Will be normalized internally.
     * @type {object}
     * @default { x: 0.7, y: 0.3 }
     */
    this.cloudWindDirection = { x: 0.7, y: 0.3 };

    /**
     * Cloud density multiplier. Higher = thicker/more opaque clouds.
     * @type {number}
     * @default 0.3
     */
    this.cloudDensity = 0.3;

    /**
     * Number of ray march steps for cloud rendering (32-128).
     * Higher = better quality but slower. 64 is good for most cases.
     * @type {number}
     * @default 64
     */
    this.cloudQuality = 64;

    /**
     * Volumetric cloud quality preset. WebGPU only. One of
     * `"low" | "medium" | "high" | "auto"`. Phase 6d quality dial —
     * resolves to `(maxSteps, lightSteps)` pairs at render time:
     * low = (24, 3), medium = (48, 4), high = (96, 8), auto picks by
     * camera altitude (high quality below `cloudLayerBottom` km,
     * dropping to low above ~100 km per the Phase 6b altitude
     * crossfade design). When `cloudQuality` is set to a non-default
     * value (anything other than 64) the renderer treats the preset
     * as overridden and uses `cloudQuality` verbatim.
     * @type {string}
     * @default "auto"
     */
    this.cloudVolumetricQuality = "auto";

    /**
     * True if primitives such as billboards, polylines, labels, etc. should be depth-tested
     * against the terrain surface, or false if such primitives should always be drawn on top
     * of terrain unless they're on the opposite side of the globe.  The disadvantage of depth
     * testing primitives against terrain is that slight numerical noise or terrain level-of-detail
     * switched can sometimes make a primitive that should be on the surface disappear underneath it.
     *
     * @type {boolean}
     * @default false
     *
     */
    this.depthTestAgainstTerrain = false;

    /**
     * Determines whether the globe casts or receives shadows from light sources. Setting the globe
     * to cast shadows may impact performance since the terrain is rendered again from the light's perspective.
     * Currently only terrain that is in view casts shadows. By default the globe does not cast shadows.
     *
     * @type {ShadowMode}
     * @default ShadowMode.RECEIVE_ONLY
     */
    this.shadows = ShadowMode.RECEIVE_ONLY;

    /**
     * The hue shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A hue shift of 1.0 indicates a complete rotation of the hues available.
     * @type {number}
     * @default 0.0
     */
    this.atmosphereHueShift = 0.0;

    /**
     * The saturation shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A saturation shift of -1.0 is monochrome.
     * @type {number}
     * @default 0.0
     */
    this.atmosphereSaturationShift = 0.0;

    /**
     * The brightness shift to apply to the atmosphere. Defaults to 0.0 (no shift).
     * A brightness shift of -1.0 is complete darkness, which will let space show through.
     * @type {number}
     * @default 0.0
     */
    this.atmosphereBrightnessShift = 0.0;

    /**
     * Whether to show terrain skirts. Terrain skirts are geometry extending downwards from a tile's edges used to hide seams between neighboring tiles.
     * Skirts are always hidden when the camera is underground or translucency is enabled.
     *
     * @type {boolean}
     * @default true
     */
    this.showSkirts = true;

    /**
     * Whether to cull back-facing terrain. Back faces are not culled when the camera is underground or translucency is enabled.
     *
     * @type {boolean}
     * @default true
     */
    this.backFaceCulling = true;

    this._oceanNormalMap = undefined;
    this._zoomedOutOceanSpecularIntensity = undefined;

    /**
     * Determines the darkness of the vertex shadow.
     * This only takes effect when <code>enableLighting</code> is <code>true</code>.
     *
     * @type {number}
     * @default 0.3
     */
    this.vertexShadowDarkness = 0.3;

    // Phase 0.3 canonical facades — wired by Scene after construction to
    // avoid a circular import (Scene imports AtmosphericConditions/GlobeWater
    // and hangs them here once `scene.atmosphere`, `scene.fog`, and
    // `scene.skyAtmosphere` are all built).
    this._atmosphericConditions = undefined;
    this._water = undefined;
  }

  /**
   * Gets an ellipsoid describing the shape of this globe.
   * @type {Ellipsoid}
   */
  get ellipsoid() {
    return this._ellipsoid;
  }

  /**
   * Canonical facade for atmosphere/fog/cloud/weather/night state.
   * Delegates through to the existing legacy storage — see
   * {@link AtmosphericConditions}. Lazily wired by {@link Scene} during
   * construction; `undefined` if this Globe has not yet been attached to
   * a Scene.
   * @type {AtmosphericConditions}
   * @readonly
   */
  get atmosphericConditions() {
    return this._atmosphericConditions;
  }

  /**
   * Canonical facade for water state. Delegates to the existing Globe
   * water fields — see {@link GlobeWater}.
   * @type {GlobeWater}
   * @readonly
   */
  get water() {
    return this._water;
  }

  /**
   * Gets the collection of image layers that will be rendered on this globe.
   * @type {ImageryLayerCollection}
   */
  get imageryLayers() {
    return this._imageryLayerCollection;
  }

  /**
   * Gets an event that's raised when an imagery layer is added, shown, hidden, moved, or removed.
   *
   * @type {Event}
   * @readonly
   */
  get imageryLayersUpdatedEvent() {
    return this._surface.tileProvider.imageryLayersUpdatedEvent;
  }

  /**
   * Returns <code>true</code> when the tile load queue is empty, <code>false</code> otherwise.  When the load queue is empty,
   * all terrain and imagery for the current view have been loaded.
   * @type {boolean}
   * @readonly
   */
  get tilesLoaded() {
    if (!defined(this._surface)) {
      return true;
    }
    return (
      this._surface._tileLoadQueueHigh.length === 0 &&
      this._surface._tileLoadQueueMedium.length === 0 &&
      this._surface._tileLoadQueueLow.length === 0
    );
  }

  /**
   * Gets or sets the color of the globe when no imagery is available.
   * @type {Color}
   */
  get baseColor() {
    return this._surface.tileProvider.baseColor;
  }

  set baseColor(value) {
    this._surface.tileProvider.baseColor = value;
  }

  /**
   * A property specifying a {@link ClippingPlaneCollection} used to selectively disable rendering on the outside of each plane.
   *
   * @type {ClippingPlaneCollection}
   */
  get clippingPlanes() {
    return this._surface.tileProvider.clippingPlanes;
  }

  set clippingPlanes(value) {
    this._surface.tileProvider.clippingPlanes = value;
  }

  /**
   * A property specifying a {@link ClippingPolygonCollection} used to selectively disable rendering inside or outside a list of polygons.
   *
   * @type {ClippingPolygonCollection}
   */
  get clippingPolygons() {
    return this._surface.tileProvider.clippingPolygons;
  }

  set clippingPolygons(value) {
    this._surface.tileProvider.clippingPolygons = value;
  }

  /**
   * A property specifying a {@link Rectangle} used to limit globe rendering to a cartographic area.
   * Defaults to the maximum extent of cartographic coordinates.
   *
   * @type {Rectangle}
   * @default {@link Rectangle.MAX_VALUE}
   */
  get cartographicLimitRectangle() {
    return this._surface.tileProvider.cartographicLimitRectangle;
  }

  set cartographicLimitRectangle(value) {
    if (!defined(value)) {
      value = Rectangle.clone(Rectangle.MAX_VALUE);
    }
    this._surface.tileProvider.cartographicLimitRectangle = value;
  }

  /**
   * The normal map to use for rendering waves in the ocean.  Setting this property will
   * only have an effect if the configured terrain provider includes a water mask.
   * @type {string}
   * @default buildModuleUrl('Assets/Textures/waterNormalsSmall.jpg')
   */
  get oceanNormalMapUrl() {
    return this._oceanNormalMapResource.url;
  }

  set oceanNormalMapUrl(value) {
    this._oceanNormalMapResource.url = value;
    this._oceanNormalMapResourceDirty = true;
  }

  /**
   * The terrain provider providing surface geometry for this globe.
   * @type {TerrainProvider}
   */
  get terrainProvider() {
    return this._terrainProvider;
  }

  set terrainProvider(value) {
    if (value !== this._terrainProvider) {
      this._terrainProvider = value;
      this._terrainProviderChanged.raiseEvent(value);
      if (defined(this._material)) {
        makeShadersDirty(this);
      }
    }
  }

  /**
   * Gets an event that's raised when the terrain provider is changed
   *
   * @type {Event}
   * @readonly
   */
  get terrainProviderChanged() {
    return this._terrainProviderChanged;
  }

  /**
   * Gets an event that's raised when the length of the tile load queue has changed since the last render frame.  When the load queue is empty,
   * all terrain and imagery for the current view have been loaded.  The event passes the new length of the tile load queue.
   *
   * @type {Event}
   */
  get tileLoadProgressEvent() {
    return this._surface.tileLoadProgressEvent;
  }

  /**
   * Gets or sets the material appearance of the Globe.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
   * {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}.
   * @type {Material | undefined}
   */
  get material() {
    return this._material;
  }

  set material(material) {
    if (this._material !== material) {
      this._material = material;
      makeShadersDirty(this);
    }
  }

  /**
   * The color to render the back side of the globe when the camera is underground or the globe is translucent,
   * blended with the globe color based on the camera's distance.
   * <br /><br />
   * To disable underground coloring, set <code>undergroundColor</code> to <code>undefined</code>.
   *
   * @type {Color}
   * @default {@link Color.BLACK}
   *
   * @see Globe#undergroundColorAlphaByDistance
   */
  get undergroundColor() {
    return this._undergroundColor;
  }

  set undergroundColor(value) {
    this._undergroundColor = Color.clone(value, this._undergroundColor);
  }

  /**
   * Gets or sets the near and far distance for blending {@link Globe#undergroundColor} with the globe color.
   * The alpha will interpolate between the {@link NearFarScalar#nearValue} and
   * {@link NearFarScalar#farValue} while the camera distance falls within the lower and upper bounds
   * of the specified {@link NearFarScalar#near} and {@link NearFarScalar#far}.
   * Outside of these ranges the alpha remains clamped to the nearest bound. If undefined,
   * the underground color will not be blended with the globe color.
   * <br /> <br />
   * When the camera is above the ellipsoid the distance is computed from the nearest
   * point on the ellipsoid instead of the camera's position.
   *
   * @type {NearFarScalar}
   *
   * @see Globe#undergroundColor
   *
   */
  get undergroundColorAlphaByDistance() {
    return this._undergroundColorAlphaByDistance;
  }

  set undergroundColorAlphaByDistance(value) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(value) && value.far < value.near) {
      throw new DeveloperError(
        "far distance must be greater than near distance.",
      );
    }
    //>>includeEnd('debug');
    this._undergroundColorAlphaByDistance = NearFarScalar.clone(
      value,
      this._undergroundColorAlphaByDistance,
    );
  }

  /**
   * Properties for controlling globe translucency.
   *
   * @type {GlobeTranslucency}
   */
  get translucency() {
    return this._translucency;
  }

  /**
   * Find an intersection between a ray and the globe surface that was rendered. The ray must be given in world coordinates.
   *
   * @param {Ray} ray The ray to test for intersection.
   * @param {Scene} scene The scene.
   * @param {boolean} [cullBackFaces=true] Set to true to not pick back faces.
   * @param {Cartesian3} [result] The object onto which to store the result.
   * @returns {Cartesian3|undefined} The intersection or <code>undefined</code> if none was found.  The returned position is in projected coordinates for 2D and Columbus View.
   *
   * @private
   */
  pickWorldCoordinates(ray, scene, cullBackFaces, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(ray)) {
      throw new DeveloperError("ray is required");
    }
    if (!defined(scene)) {
      throw new DeveloperError("scene is required");
    }
    //>>includeEnd('debug');

    cullBackFaces = cullBackFaces ?? true;

    const mode = scene.mode;
    const projection = scene.mapProjection;

    const sphereIntersections = scratchArray;
    sphereIntersections.length = 0;

    for (const tile of this._surface._tilesRenderedThisFrame) {
      const surfaceTile = tile.data;

      if (!defined(surfaceTile)) {
        continue;
      }

      let boundingVolume = surfaceTile.pickBoundingSphere;
      if (mode !== SceneMode.SCENE3D) {
        surfaceTile.pickBoundingSphere = boundingVolume =
          BoundingSphere.fromRectangleWithHeights2D(
            tile.rectangle,
            projection,
            surfaceTile.tileBoundingRegion.minimumHeight,
            surfaceTile.tileBoundingRegion.maximumHeight,
            boundingVolume,
          );
        Cartesian3.fromElements(
          boundingVolume.center.z,
          boundingVolume.center.x,
          boundingVolume.center.y,
          boundingVolume.center,
        );
      } else if (defined(surfaceTile.renderedMesh)) {
        BoundingSphere.clone(
          surfaceTile.tileBoundingRegion.boundingSphere,
          boundingVolume,
        );
      } else {
        // So wait how did we render this thing then? It shouldn't be possible to get here.
        continue;
      }

      const boundingSphereIntersection = IntersectionTests.raySphere(
        ray,
        boundingVolume,
        scratchSphereIntersectionResult,
      );
      if (defined(boundingSphereIntersection)) {
        sphereIntersections.push(surfaceTile);
      }
    }

    sphereIntersections.sort(createComparePickTileFunction(ray.origin));

    let intersection;
    const length = sphereIntersections.length;
    for (let i = 0; i < length; ++i) {
      intersection = sphereIntersections[i].pick(
        ray,
        scene.mode,
        scene.mapProjection,
        cullBackFaces,
        result,
      );
      if (defined(intersection)) {
        break;
      }
    }

    return intersection;
  }

  /**
   * Find an intersection between a ray and the globe surface that was rendered. The ray must be given in world coordinates.
   *
   * @param {Ray} ray The ray to test for intersection.
   * @param {Scene} scene The scene.
   * @param {Cartesian3} [result] The object onto which to store the result.
   * @returns {Cartesian3|undefined} The intersection or <code>undefined</code> if none was found.
   *
   * @example
   * // find intersection of ray through a pixel and the globe
   * const ray = viewer.camera.getPickRay(windowCoordinates);
   * const intersection = globe.pick(ray, scene);
   */
  pick(ray, scene, result) {
    result = this.pickWorldCoordinates(ray, scene, true, result);
    if (defined(result) && scene.mode !== SceneMode.SCENE3D) {
      result = Cartesian3.fromElements(result.y, result.z, result.x, result);
      const carto = scene.mapProjection.unproject(result, cartoScratch);
      result = this._ellipsoid.cartographicToCartesian(carto, result);
    }

    return result;
  }

  /**
   * Get the height of the surface at a given cartographic.
   *
   * @param {Cartographic} cartographic The cartographic for which to find the height.
   * @returns {number|undefined} The height of the cartographic or undefined if it could not be found.
   */
  getHeight(cartographic) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartographic)) {
      throw new DeveloperError("cartographic is required");
    }
    //>>includeEnd('debug');

    const levelZeroTiles = this._surface._levelZeroTiles;
    if (!defined(levelZeroTiles)) {
      return;
    }

    let tile;
    let i;

    const length = levelZeroTiles.length;
    for (i = 0; i < length; ++i) {
      tile = levelZeroTiles[i];
      if (Rectangle.contains(tile.rectangle, cartographic)) {
        break;
      }
    }

    if (i >= length) {
      return undefined;
    }

    let tileWithMesh = tile;

    while (defined(tile)) {
      tile =
        tileIfContainsCartographic(tile._southwestChild, cartographic) ||
        tileIfContainsCartographic(tile._southeastChild, cartographic) ||
        tileIfContainsCartographic(tile._northwestChild, cartographic) ||
        tile._northeastChild;

      if (
        defined(tile) &&
        defined(tile.data) &&
        defined(tile.data.renderedMesh)
      ) {
        tileWithMesh = tile;
      }
    }

    tile = tileWithMesh;

    // This tile was either rendered or culled.
    // It is sometimes useful to get a height from a culled tile,
    // e.g. when we're getting a height in order to place a billboard
    // on terrain, and the camera is looking at that same billboard.
    // The culled tile must have a valid mesh, though.
    if (
      !defined(tile) ||
      !defined(tile.data) ||
      !defined(tile.data.renderedMesh)
    ) {
      // Tile was not rendered (culled).
      return undefined;
    }

    const projection = this._surface._tileProvider.tilingScheme.projection;
    const ellipsoid = this._surface._tileProvider.tilingScheme.ellipsoid;

    //cartesian has to be on the ellipsoid surface for `ellipsoid.geodeticSurfaceNormal`
    const cartesian = Cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      0.0,
      ellipsoid,
      scratchGetHeightCartesian,
    );

    const ray = scratchGetHeightRay;
    const surfaceNormal = ellipsoid.geodeticSurfaceNormal(
      cartesian,
      ray.direction,
    );

    // Try to find the intersection point between the surface normal and z-axis.
    // minimum height (-11500.0) for the terrain set, need to get this information from the terrain provider
    const rayOrigin = ellipsoid.getSurfaceNormalIntersectionWithZAxis(
      cartesian,
      11500.0,
      ray.origin,
    );

    // Theoretically, not with Earth datums, the intersection point can be outside the ellipsoid
    if (!defined(rayOrigin)) {
      // intersection point is outside the ellipsoid, try other value
      // minimum height (-11500.0) for the terrain set, need to get this information from the terrain provider
      let minimumHeight;
      if (defined(tile.data.tileBoundingRegion)) {
        minimumHeight = tile.data.tileBoundingRegion.minimumHeight;
      }
      const magnitude = Math.min(minimumHeight ?? 0.0, -11500.0);

      // multiply by the *positive* value of the magnitude
      const vectorToMinimumPoint = Cartesian3.multiplyByScalar(
        surfaceNormal,
        Math.abs(magnitude) + 1,
        scratchGetHeightIntersection,
      );
      Cartesian3.subtract(cartesian, vectorToMinimumPoint, ray.origin);
    }

    const intersection = tile.data.pick(
      ray,
      // Globe height is the same at a given cartographic regardless of the scene mode,
      // but the ray is constructed via a surface normal (which assumes 3D), so pick in 3D mode.
      SceneMode.SCENE3D,
      projection,
      false,
      scratchGetHeightIntersection,
    );
    if (!defined(intersection)) {
      return undefined;
    }

    return ellipsoid.cartesianToCartographic(
      intersection,
      scratchGetHeightCartographic,
    ).height;
  }

  /**
   * @private
   */
  update(frameState) {
    if (!this.show) {
      return;
    }

    if (frameState.passes.render) {
      this._surface.update(frameState);
    }
  }

  /**
   * @private
   */
  beginFrame(frameState) {
    const surface = this._surface;
    const tileProvider = surface.tileProvider;
    const terrainProvider = this.terrainProvider;
    const hasWaterMask =
      defined(terrainProvider) &&
      terrainProvider.hasWaterMask &&
      terrainProvider.hasWaterMask;

    if (hasWaterMask && this._oceanNormalMapResourceDirty) {
      // url changed, load new normal map asynchronously
      this._oceanNormalMapResourceDirty = false;
      const oceanNormalMapResource = this._oceanNormalMapResource;
      const oceanNormalMapUrl = oceanNormalMapResource.url;
      if (defined(oceanNormalMapUrl)) {
        const that = this;
        oceanNormalMapResource.fetchImage().then(function (image) {
          if (oceanNormalMapUrl !== that._oceanNormalMapResource.url) {
            // url changed while we were loading
            return;
          }

          that._oceanNormalMap =
            that._oceanNormalMap && that._oceanNormalMap.destroy();
          that._oceanNormalMap = new Texture({
            context: frameState.context,
            source: image,
          });
        });
      } else {
        this._oceanNormalMap =
          this._oceanNormalMap && this._oceanNormalMap.destroy();
      }
    }

    const pass = frameState.passes;
    const mode = frameState.mode;

    if (pass.render) {
      if (this.showGroundAtmosphere) {
        this._zoomedOutOceanSpecularIntensity = 0.4;
      } else {
        this._zoomedOutOceanSpecularIntensity = 0.5;
      }

      surface.maximumScreenSpaceError = this.maximumScreenSpaceError;
      surface.tileCacheSize = this.tileCacheSize;
      surface.loadingDescendantLimit = this.loadingDescendantLimit;
      surface.preloadAncestors = this.preloadAncestors;
      surface.preloadSiblings = this.preloadSiblings;

      tileProvider.terrainProvider = this.terrainProvider;
      tileProvider.lightingFadeOutDistance = this.lightingFadeOutDistance;
      tileProvider.lightingFadeInDistance = this.lightingFadeInDistance;
      tileProvider.nightFadeOutDistance = this.nightFadeOutDistance;
      tileProvider.nightFadeInDistance = this.nightFadeInDistance;
      tileProvider.zoomedOutOceanSpecularIntensity =
        mode === SceneMode.SCENE3D
          ? this._zoomedOutOceanSpecularIntensity
          : 0.0;
      tileProvider.hasWaterMask = hasWaterMask;
      tileProvider.showWaterEffect = this.showWaterEffect;
      tileProvider.oceanNormalMap = this._oceanNormalMap;
      tileProvider.enableLighting = this.enableLighting;
      tileProvider.dynamicAtmosphereLighting = this.dynamicAtmosphereLighting;
      tileProvider.dynamicAtmosphereLightingFromSun =
        this.dynamicAtmosphereLightingFromSun;
      tileProvider.showGroundAtmosphere = this.showGroundAtmosphere;
      tileProvider.atmosphereLightIntensity = this.atmosphereLightIntensity;
      tileProvider.atmosphereRayleighCoefficient =
        this.atmosphereRayleighCoefficient;
      tileProvider.atmosphereMieCoefficient = this.atmosphereMieCoefficient;
      tileProvider.atmosphereRayleighScaleHeight =
        this.atmosphereRayleighScaleHeight;
      tileProvider.atmosphereMieScaleHeight = this.atmosphereMieScaleHeight;
      tileProvider.atmosphereMieAnisotropy = this.atmosphereMieAnisotropy;
      tileProvider.shadows = this.shadows;
      tileProvider.hueShift = this.atmosphereHueShift;
      tileProvider.saturationShift = this.atmosphereSaturationShift;
      tileProvider.brightnessShift = this.atmosphereBrightnessShift;
      tileProvider.fillHighlightColor = this.fillHighlightColor;
      tileProvider.showSkirts = this.showSkirts;
      tileProvider.backFaceCulling = this.backFaceCulling;
      tileProvider.vertexShadowDarkness = this.vertexShadowDarkness;
      tileProvider.undergroundColor = this._undergroundColor;
      tileProvider.undergroundColorAlphaByDistance =
        this._undergroundColorAlphaByDistance;
      tileProvider.lambertDiffuseMultiplier = this.lambertDiffuseMultiplier;

      // ── Enhanced WebGPU rendering properties ──
      tileProvider.enableNightLights = this.enableNightLights;
      tileProvider.nightIntensity = this.enableNightLights
        ? this.nightIntensity
        : 0.0;
      tileProvider.enableEnhancedOcean = this.enableEnhancedOcean;
      tileProvider.oceanDeepColor = this.enableEnhancedOcean
        ? this.oceanDeepColor
        : undefined;
      tileProvider.oceanFresnelPower = this.enableEnhancedOcean
        ? this.oceanFresnelPower
        : 0.0;
      tileProvider.oceanReflectivity = this.enableEnhancedOcean
        ? this.oceanReflectivity
        : 0.0;
      tileProvider.oceanFoamThreshold = this.enableEnhancedOcean
        ? this.oceanFoamThreshold
        : 0.0;
      tileProvider.oceanDarkening = this.enableEnhancedOcean
        ? this.oceanDarkening
        : 0.0;

      // ── Procedural cloud properties (WebGPU only) ──
      tileProvider.showProceduralClouds = this.showProceduralClouds;
      if (this.showProceduralClouds) {
        tileProvider.cloudCoverage = this.cloudCoverage;
        tileProvider.cloudLayerBottom = this.cloudLayerBottom;
        tileProvider.cloudLayerTop = this.cloudLayerTop;
        tileProvider.cloudWindSpeed = this.cloudWindSpeed;
        tileProvider.cloudWindDirection = this.cloudWindDirection;
        tileProvider.cloudDensity = this.cloudDensity;
        tileProvider.cloudQuality = this.cloudQuality;
      }

      // Ground atmosphere needs no separate WebGPU pass — it is shaded
      // inside GlobeTerrain.wgsl (csm_computeGroundAtmosphereScattering +
      // WebGPUAtmosphereLUT), with parameters carried by the globe camera
      // and tile uniform buffers. The old separate-pass
      // WebGPUGroundAtmosphereRenderer was retired in Batch 239.

      surface.beginFrame(frameState);
    }
  }

  /**
   * @private
   */
  render(frameState) {
    if (!this.show) {
      return;
    }

    if (defined(this._material)) {
      this._material.update(frameState.context);
    }

    this._surface.render(frameState);
  }

  /**
   * @private
   */
  endFrame(frameState) {
    if (!this.show) {
      return;
    }

    if (frameState.passes.render) {
      this._surface.endFrame(frameState);
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   *
   * @see Globe#destroy
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
   * globe = globe && globe.destroy();
   *
   * @see Globe#isDestroyed
   */
  destroy() {
    this._surfaceShaderSet =
      this._surfaceShaderSet && this._surfaceShaderSet.destroy();
    this._surface = this._surface && this._surface.destroy();
    this._oceanNormalMap =
      this._oceanNormalMap && this._oceanNormalMap.destroy();
    return destroyObject(this);
  }
}

function makeShadersDirty(globe) {
  const defines = [];

  const requireNormals =
    defined(globe._material) &&
    (defined(globe._material.shaderSource.match(/slope/)) ||
      defined(globe._material.shaderSource.match("normalEC")));

  const fragmentSources = [AtmosphereCommon, GroundAtmosphere];
  if (
    defined(globe._material) &&
    (!requireNormals || globe._terrainProvider.hasVertexNormals)
  ) {
    fragmentSources.push(globe._material.shaderSource);
    defines.push("APPLY_MATERIAL");
    globe._surface._tileProvider.materialUniformMap = globe._material._uniforms;
    // Session 65 Cluster 3 — also expose the material itself so the
    // WebGPU GlobeSurfaceRenderer can read `material.wgslShaderSource`
    // and `material.uniforms` directly. WebGL only needs the uniform
    // map because its shader source is already concatenated above.
    globe._surface._tileProvider.material = globe._material;
  } else {
    globe._surface._tileProvider.materialUniformMap = undefined;
    globe._surface._tileProvider.material = undefined;
  }
  fragmentSources.push(GlobeFS);

  globe._surfaceShaderSet.baseVertexShaderSource = new ShaderSource({
    sources: [AtmosphereCommon, GroundAtmosphere, GlobeVS],
    defines: defines,
  });

  globe._surfaceShaderSet.baseFragmentShaderSource = new ShaderSource({
    sources: fragmentSources,
    defines: defines,
  });
  globe._surfaceShaderSet.material = globe._material;
}

function createComparePickTileFunction(rayOrigin) {
  return function (a, b) {
    const aDist = BoundingSphere.distanceSquaredTo(
      a.pickBoundingSphere,
      rayOrigin,
    );
    const bDist = BoundingSphere.distanceSquaredTo(
      b.pickBoundingSphere,
      rayOrigin,
    );

    return aDist - bDist;
  };
}

const scratchArray = [];
const scratchSphereIntersectionResult = {
  start: 0.0,
  stop: 0.0,
};

const cartoScratch = new Cartographic();

const scratchGetHeightCartesian = new Cartesian3();
const scratchGetHeightIntersection = new Cartesian3();
const scratchGetHeightCartographic = new Cartographic();
const scratchGetHeightRay = new Ray();

function tileIfContainsCartographic(tile, cartographic) {
  return defined(tile) && Rectangle.contains(tile.rectangle, cartographic)
    ? tile
    : undefined;
}

export default Globe;
