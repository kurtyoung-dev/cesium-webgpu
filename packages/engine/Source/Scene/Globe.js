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
import CloudCollection from "./CloudCollection.js";
import GlobeSurfaceShaderSet from "./GlobeSurfaceShaderSet.js";
import LakeWaterClassificationProvider from "./WaterClassificationProvider.js";
import GlobeSurfaceTileProvider from "./GlobeSurfaceTileProvider.js";
import GlobeTranslucency from "./GlobeTranslucency.js";
import ImageryLayerCollection from "./ImageryLayerCollection.js";
import QuadtreePrimitive from "./QuadtreePrimitive.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import CesiumMath from "../Core/Math.js";
import VectorProvider from "../Core/VectorProvider.js";

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
    const vectorProvider = new VectorProvider({
      tilingScheme: terrainProvider.tilingScheme,
    });

    this._ellipsoid = ellipsoid;
    this._imageryLayerCollection = imageryLayerCollection;

    this._surfaceShaderSet = new GlobeSurfaceShaderSet();
    this._material = undefined;

    this._surface = new QuadtreePrimitive({
      tileProvider: new GlobeSurfaceTileProvider({
        terrainProvider: terrainProvider,
        imageryLayers: imageryLayerCollection,
        surfaceShaderSet: this._surfaceShaderSet,
        vectorProvider,
      }),
    });

    this._terrainProvider = terrainProvider;
    this._terrainProviderChanged = new Event();

    this._vectorProvider = vectorProvider;

    this._undergroundColor = Color.clone(Color.BLACK);
    this._undergroundColorAlphaByDistance = new NearFarScalar(
      ellipsoid.maximumRadius / 1000.0,
      0.0,
      ellipsoid.maximumRadius / 5.0,
      1.0,
    );

    this._translucency = new GlobeTranslucency();

    // The globe-owned managed CloudCollection, and the source of truth for the
    // WebGPU environmental-effects volumetric cloud request: the
    // `atmosphericConditions` cloud facade, the AtmosphericEffects genus bias
    // and the weather ingest all write onto this collection's `.volumetric`
    // config, and the environmental-effects and cloud-aware god-ray gates read
    // its `renderMode`. Deliberately not added to the scene primitives — it
    // owns no billboards of its own and the volumetric raymarch runs in the
    // environmental-effects phase — so it is configuration only. A default
    // scene, with `renderMode` BILLBOARD and nothing published, drives no
    // extra rendering on either backend. WebGPU only; inert on WebGL.
    this._defaultCloudCollection = new CloudCollection();

    makeShadersDirty(this);

    /**
     * Determines if the globe will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = true;

    /**
     * When <code>true</code>, the globe surface emits a pick ID so
     * <code>scene.pick</code> over terrain returns this <code>Globe</code>.
     * Default <code>false</code> to match WebGL, where the globe has no pick
     * ID and <code>scene.pick</code> returns <code>undefined</code> over the
     * surface (use <code>scene.pickPosition</code> for the terrain position).
     * <p>
     * Currently honored by the WebGPU backend only; the WebGL globe path has
     * never generated pick IDs. Regardless of this flag, the globe always
     * contributes DEPTH to the WebGPU pick pass so <code>pickPosition</code>
     * works over terrain (matching WebGL's <code>updateForPick</code>).
     * </p>
     *
     * @type {boolean}
     * @default false
     */
    this.pickable = false;

    // Cached pick ID for the globe surface: one ID covers the whole globe.
    // Allocated lazily in `beginFrame` when `pickable` is true; its color is
    // mirrored onto the tile provider so the WebGPU camera UB packer can write
    // it into the pick-color tail. Destroyed in `destroy()`.
    this._pickId = undefined;

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
     * The strength of an optional warm appearance band centered on the
     * geometric day/night terminator. A value of {@code 0.0} disables the
     * effect and leaves physically-derived globe lighting unchanged; a value
     * of {@code 1.0} reproduces the fork's original stylized band. This only
     * takes effect when {@link Globe#enableLighting} is {@code true}.
     * Negative and non-finite values are treated as {@code 0.0} by the
     * renderers.
     *
     * @type {number}
     * @default 0.0
     */
    this.terminatorGlowStrength = 0.0;

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

    // The water classification seam is opt-in through the `lakeWaterMask`
    // accessor, and the provider is fetched lazily on first enable so the
    // default-off path never loads the bundled Natural Earth lake dataset.
    this._lakeWaterMask = false;
    this._lakeWaterClassificationProvider = undefined;
    this._lakeWaterMaskLoadPending = false;

    /**
     * When true, night-side imagery layers with nightAlpha > dayAlpha
     * are treated as emissive city lights, boosted proportional to
     * their luminance. Only active with enableLighting, and only on the WebGPU
     * renderer; the WebGL path ignores it.
     * The default is off for cross-backend parity; set this property to
     * <code>true</code> to opt in.
     * <p>
     * Setting this to <code>false</code> produces zero emission. The enable and
     * {@link Globe#nightIntensity} travel as separate signals precisely so that
     * it can: an off state encoded as <code>nightIntensity = 0.0</code> would
     * collide with the shader's unset sentinel and render as the default 2.5.
     * </p>
     * @type {boolean}
     * @default false
     */
    this.enableNightLights = false;

    /**
     * Multiplier for night-side city light emission brightness.
     * Higher values = brighter city lights. 0 = no emission.
     * <p>
     * <code>0</code> is honoured: {@link Globe#enableNightLights} carries the
     * off state separately, so a zero here is never confused with the shader's
     * unset sentinel and never falls back to the default 2.5.
     * </p>
     * @type {number}
     * @default 2.5
     */
    this.nightIntensity = 2.5;

    /**
     * Selects the WebGPU ocean styling model. This gates how water surfaces are
     * coloured, not the waves: the animated wave-normal march is shared and
     * always runs, under the same default-true {@link Globe#showWaterEffect} as
     * WebGL, so the ocean animates identically either way.
     * <p>
     * When <code>false</code> (the default), WebGPU renders the classic
     * WebGL-parity water look: imagery preserved with wave-diffuse,
     * non-diffuse, and Phong-specular highlights added on top — a faithful
     * port of WebGL's <code>computeWaterColor</code>. This matches WebGL.
     * </p>
     * <p>
     * When <code>true</code>, WebGPU renders its additive enhanced styling:
     * foam/whitecaps layered over the full-strength wave-perturbed
     * highlight composite (with the deep-colour / Fresnel / reflectivity /
     * foam-threshold / darkening dials below). This is a WebGPU-only look with
     * no WebGL equivalent, so it is opt-in.
     * </p>
     * <p>
     * The WebGL backend ignores this flag (it has no enhanced path); its water
     * is always the classic look. A runtime change takes effect on the next
     * frame without a reload.
     * </p>
     * @type {boolean}
     * @default false
     */
    this.enableEnhancedOcean = false;

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

    // The facades are wired by Scene after construction, to avoid a circular
    // import: Scene imports AtmosphericConditions and GlobeWater and hangs
    // them here once `scene.atmosphere`, `scene.fog` and `scene.skyAtmosphere`
    // are all built.
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
   * When true, the terrain provider's per-tile water mask is augmented
   * with Natural Earth 1:10m lake polygons (public domain), so large
   * inland lakes (the Great Lakes, Baikal, Victoria, …) receive the
   * animated water effect that ocean-only provider masks deny them.
   * Only takes effect when the terrain provider supplies a water mask
   * (e.g. Cesium World Terrain with <code>requestWaterMask: true</code>)
   * and {@link Globe#showWaterEffect} is enabled. The bundled lake
   * dataset (~900 KiB) is fetched lazily on first enable.
   *
   * @type {boolean}
   * @default false
   */
  get lakeWaterMask() {
    return this._lakeWaterMask;
  }

  set lakeWaterMask(value) {
    value = value === true;
    if (value === this._lakeWaterMask) {
      return;
    }
    this._lakeWaterMask = value;
    if (
      value &&
      !defined(this._lakeWaterClassificationProvider) &&
      !this._lakeWaterMaskLoadPending
    ) {
      this._lakeWaterMaskLoadPending = true;
      const that = this;
      Resource.fetchArrayBuffer(
        buildModuleUrl("Assets/WaterMask/ne10mLakes.bin"),
      )
        .then(function (buffer) {
          that._lakeWaterClassificationProvider =
            new LakeWaterClassificationProvider(buffer);
          that._lakeWaterMaskLoadPending = false;
          // Tiles that loaded while the dataset was in flight already
          // created their water-mask textures; reload so lake tiles pick
          // up the augmented mask.
          if (that._lakeWaterMask) {
            that._surface.invalidateAllTiles();
          }
        })
        .catch(function (error) {
          that._lakeWaterMaskLoadPending = false;
          console.error(
            `[CesiumJS] Globe.lakeWaterMask: failed to load the bundled lake dataset: ${error}`,
          );
        });
    }
    // Rebuild tiles so toggling takes effect on already-loaded tiles.
    this._surface.invalidateAllTiles();
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
      if (defined(value)) {
        this._vectorProvider.tilingScheme = value.tilingScheme;
      }
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
   * @type {VectorProvider}
   * @readonly
   * @ignore
   */
  get vectorProvider() {
    return this._vectorProvider;
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
  /**
   * The globe-owned managed default {@link CloudCollection} that carries the
   * WebGPU volumetric cloud configuration. Its <code>.volumetric</code>
   * {@link CloudVolumetrics} is the source of truth for the WebGPU
   * environmental-effects volumetric-cloud deck: it is driven by
   * <code>scene.globe.atmosphericConditions.clouds</code>, the atmospheric
   * effects genus bias and the weather ingest, and it is read by the
   * environmental-effects and cloud-aware god-ray gates. WebGPU only, and
   * inert on the WebGL renderer.
   * @memberof Globe.prototype
   * @type {CloudCollection}
   * @readonly
   */
  get defaultCloudCollection() {
    return this._defaultCloudCollection;
  }

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
          // The Texture class does not retain its source image after upload,
          // but the WebGPU globe renderer has to re-upload the ocean normal map
          // into its own GPUTexture cache, in
          // `WebGPUGlobeSurfaceRenderer._createWaterOceanMaterialBindGroupInner`.
          // Retaining the decoded image here is the same `_webgpuSource`
          // handoff the water mask uses in `GlobeSurfaceTile.js`. Without it
          // the WGSL wave sampler binds the 1×1 placeholder and the ocean is
          // flat and unanimated.
          that._oceanNormalMap._webgpuSource = image;
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
      // Mirror the loaded lake provider only while the opt-in flag is on;
      // undefined leaves the default water-mask upload path untouched.
      tileProvider.waterClassificationProvider = this._lakeWaterMask
        ? this._lakeWaterClassificationProvider
        : undefined;
      tileProvider.oceanNormalMap = this._oceanNormalMap;
      tileProvider.enableLighting = this.enableLighting;
      const terminatorGlowStrength = this.terminatorGlowStrength;
      tileProvider.terminatorGlowStrength =
        typeof terminatorGlowStrength === "number" &&
        Number.isFinite(terminatorGlowStrength)
          ? Math.max(terminatorGlowStrength, 0.0)
          : 0.0;
      tileProvider.dynamicAtmosphereLighting = this.dynamicAtmosphereLighting;
      tileProvider.dynamicAtmosphereLightingFromSun =
        this.dynamicAtmosphereLightingFromSun;
      tileProvider.showGroundAtmosphere = this.showGroundAtmosphere;
      // Eclipse dimming of both the ground atmosphere and the globe's fog.
      // This mirror is the single JS source both backends read: WebGL takes it
      // through `u_atmosphereLightIntensity` in
      // `GlobeSurfaceTileProviderRendering`, consumed by
      // `AtmosphereCommon.glsl`'s `computeAtmosphereColor`, whose result is the
      // fog colour in `GlobeFS.glsl`; WebGPU takes it through
      // `WebGPUGlobeSurfaceCameraUB` / `WebGPUGlobeSurfaceTileUB` into
      // `GlobeTerrain.wgsl`. Only this per-frame derived mirror is written —
      // `globe.atmosphereLightIntensity` itself is never mutated — and the
      // `* 1.0` of a non-eclipse frame is bit-exact.
      tileProvider.atmosphereLightIntensity =
        this.atmosphereLightIntensity *
        (frameState.eclipseSceneLightFactor ?? 1.0);
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

      // Globe surface pick ID. When `pickable` is true, allocate a single pick
      // ID for the whole globe — once, then reused across frames — and mirror
      // its color onto the tile provider, where the WebGPU camera UB packer
      // writes it into the pick-color tail that `GlobeTerrain.wgsl`'s
      // `fragmentPickMain` reads. When false, clear the mirror so the tail
      // packs (0,0,0,0) and `scene.pick` stays undefined over the globe, as it
      // is on WebGL. The pick ID stays allocated once created, so toggling the
      // flag does not churn the pick registry. `createPickId` is the
      // backend-agnostic `GraphicsContext` API and works on WebGL too, though
      // the WebGL globe path never references the ID.
      if (this.pickable) {
        if (!defined(this._pickId) && defined(frameState.context)) {
          this._pickId = frameState.context.createPickId({ primitive: this });
        }
        tileProvider._webgpuGlobePickColor = defined(this._pickId)
          ? this._pickId.color
          : undefined;
      } else {
        tileProvider._webgpuGlobePickColor = undefined;
      }
      tileProvider.undergroundColor = this._undergroundColor;
      tileProvider.undergroundColorAlphaByDistance =
        this._undergroundColorAlphaByDistance;
      tileProvider.lambertDiffuseMultiplier = this.lambertDiffuseMultiplier;

      // The enable and the value travel as separate signals, and must keep
      // doing so. Folding them here — `enableNightLights ? nightIntensity : 0`
      // — hands the WebGPU tile UB a zero, which
      // `GlobeTerrain.wgsl`'s `getNightIntensity()` reads as "the CPU
      // configured nothing, use the built-in default of 2.5". The off state
      // then aliases exactly onto default-on, `enableNightLights = false`
      // becomes a visual no-op, and `nightIntensity = 0` — documented on this
      // class as no emission — is swallowed with it. `WebGPUGlobeSurfaceTileUB`
      // owns the encoding through `resolveGlobeTunable` and `GLOBE_UB_UNSET`;
      // nothing here decides what off looks like.
      tileProvider.enableNightLights = this.enableNightLights;
      tileProvider.nightIntensity = this.nightIntensity;
      tileProvider.enableEnhancedOcean = this.enableEnhancedOcean;
      tileProvider.oceanDeepColor = this.oceanDeepColor;
      tileProvider.oceanFresnelPower = this.oceanFresnelPower;
      tileProvider.oceanReflectivity = this.oceanReflectivity;
      tileProvider.oceanFoamThreshold = this.oceanFoamThreshold;
      tileProvider.oceanDarkening = this.oceanDarkening;

      // Ground atmosphere needs no separate WebGPU pass — it is shaded inside
      // GlobeTerrain.wgsl (csm_computeGroundAtmosphereScattering plus
      // WebGPUAtmosphereLUT), with parameters carried by the globe camera and
      // tile uniform buffers.

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
    // Release the globe pick ID's registry slot.
    this._pickId = this._pickId && this._pickId.destroy();
    // Release the managed default cloud collection. It is configuration only
    // and owns no GPU resources unless the volumetric path ran.
    this._defaultCloudCollection =
      this._defaultCloudCollection && this._defaultCloudCollection.destroy();
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
    // Expose the material itself as well, so the WebGPU GlobeSurfaceRenderer
    // can read `material.wgslShaderSource` and `material.uniforms` directly.
    // WebGL needs only the uniform map, because its shader source is already
    // concatenated above.
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
