// @ts-check

import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import TerrainQuantization from "../Core/TerrainQuantization.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import DerivedCommand from "./DerivedCommand.js";
import VectorCommon from "../Shaders/VectorCommon.js";
import getClippingFunction from "./getClippingFunction.js";
import SceneMode from "./SceneMode.js";

const companionPreparationRetryFrames = 30;
const perFragmentGroundAtmosphereFlag = 1 << 15;

/** @import ClippingPlaneCollection from "./ClippingPlaneCollection.js"; */
/** @import ClippingPolygonCollection from "./ClippingPolygonCollection.js"; */
/** @import Context from "../Renderer/Context.js"; */
/** @import FrameState from "./FrameState.js"; */
/** @import GlobeSurfaceTile from "./GlobeSurfaceTile.js"; */

/**
 * @ignore
 */
class GlobeSurfaceShader {
  /**
   * @param {number} numberOfDayTextures
   * @param {number} flags
   * @param {*} material
   * @param {Context} context
   * @param {*} shaderCache
   * @param {ShaderProgram} shaderProgram
   * @param {number} clippingShaderState
   * @param {number} clippingPolygonShaderState
   */
  constructor(
    numberOfDayTextures,
    flags,
    material,
    context,
    shaderCache,
    shaderProgram,
    clippingShaderState,
    clippingPolygonShaderState,
  ) {
    /** @type {number} */
    this.numberOfDayTextures = numberOfDayTextures;
    this.flags = flags;
    this.material = material;
    this.context = context;
    this.shaderCache = shaderCache;
    /** @type {ShaderProgram | undefined} */
    this.shaderProgram = shaderProgram;
    this.clippingShaderState = clippingShaderState;
    this.clippingPolygonShaderState = clippingPolygonShaderState;
    this.fogCompanionRequestMask = 0;
    this.fogCompanionRequestContext = context;
    this.fogCompanionRequestShaderCache = shaderCache;
    this.fogCompanionRequestMaterial = material;
    this.fogCompanionRequestMaterialGeneration = 0;
    this.fogCompanionRejectedMask = 0;
    this.fogCompanionRetryAfterFrame = 0;
    this.groundAtmosphereCompanionRequestMask = 0;
    this.groundAtmosphereCompanionRequestContext = context;
    this.groundAtmosphereCompanionRequestShaderCache = shaderCache;
    this.groundAtmosphereCompanionRequestMaterial = material;
    this.groundAtmosphereCompanionRequestMaterialGeneration = 0;
    this.groundAtmosphereCompanionRejectedMask = 0;
    this.groundAtmosphereCompanionRetryAfterFrame = 0;
  }
}

/**
 * @typedef {object} GlobeSurfaceShaderSetOptions
 * @property {FrameState} [frameState]
 * @property {GlobeSurfaceTile} [surfaceTile]
 * @property {number} [numberOfDayTextures]
 * @property {boolean} [applyBrightness]
 * @property {boolean} [applyContrast]
 * @property {boolean} [applyHue]
 * @property {boolean} [applySaturation]
 * @property {boolean} [applyGamma]
 * @property {boolean} [applyAlpha]
 * @property {boolean} [applyDayNightAlpha]
 * @property {boolean} [applyNightDarkness]
 * @property {boolean} [applyNightLights]
 * @property {boolean} [applyCelestialWater]
 * @property {boolean} [applySplit]
 * @property {boolean} [hasWaterMask]
 * @property {boolean} [showReflectiveOcean]
 * @property {boolean} [showOceanWaves]
 * @property {boolean} [enableLighting]
 * @property {boolean} [dynamicAtmosphereLighting]
 * @property {boolean} [dynamicAtmosphereLightingFromSun]
 * @property {boolean} [showGroundAtmosphere]
 * @property {boolean} [perFragmentGroundAtmosphere]
 * @property {boolean} [hasVertexNormals]
 * @property {boolean} [useWebMercatorProjection]
 * @property {boolean} [enableFog]
 * @property {boolean} [enableClippingPlanes]
 * @property {ClippingPlaneCollection} [clippingPlanes]
 * @property {boolean} [enableClippingPolygons]
 * @property {ClippingPolygonCollection} [clippingPolygons]
 * @property {boolean} [clippedByBoundaries]
 * @property {boolean} [hasImageryLayerCutout]
 * @property {boolean} [colorCorrect]
 * @property {boolean} [highlightFillTile]
 * @property {boolean} [colorToAlpha]
 * @property {boolean} [hasGeodeticSurfaceNormals]
 * @property {boolean} [hasExaggeration]
 * @property {boolean} [showUndergroundColor]
 * @property {boolean} [translucent]
 * @property {boolean} [enableEclipseGlobeShadow]
 * @property {boolean} [baseColorCorrect]
 * @property {boolean} [fogCompanionEnabled]
 * @property {boolean} [groundAtmosphereCompanionEnabled]
 * @property {boolean} [_skipFogCompanionPrewarm]
 * @property {boolean} [_skipGroundAtmosphereCompanionPrewarm]
 * @private
 */

/**
 * @typedef {object} ShaderCompanionToken
 * @property {*} material
 * @property {Context} context
 * @property {*} shaderCache
 * @property {GlobeSurfaceShaderContextBucket} shaderBucket
 * @property {GlobeSurfaceShader} surfaceShader
 * @property {number} materialGeneration
 * @property {number} numberOfDayTextures
 * @property {number} sourceFlags
 * @property {boolean} completed
 * @property {boolean} prepared
 * @private
 */

/**
 * @typedef {object} GlobeSurfaceShaderContextBucket
 * @property {GlobeSurfaceShader[][]} shadersByTexturesFlags
 * @property {object} preparationOwner
 * @property {Set<*>} shaderCaches
 * @property {boolean} groundAtmosphereCompanionBandActive
 * @property {GlobeSurfaceShader | undefined} groundAtmosphereCompanionBandSource
 * @property {number} groundAtmosphereCompanionBandFinalConfig
 * @property {number} groundAtmosphereCompanionBandMaterialGeneration
 * @private
 */

/**
 * Manages the shaders used to shade the surface of a {@link Globe}.
 *
 * @private
 */
class GlobeSurfaceShaderSet {
  constructor() {
    this.baseVertexShaderSource = undefined;
    this.baseFragmentShaderSource = undefined;

    /** @type {GlobeSurfaceShader[][]} */
    this._shadersByTexturesFlags = [];
    /** @type {Map<Context, GlobeSurfaceShaderContextBucket>} */
    this._shadersByContext = new Map();
    /** @type {Context | undefined} */
    this._activeContext = undefined;
    /** @type {GlobeSurfaceShaderContextBucket | undefined} */
    this._activeShaderBucket = undefined;
    this._pendingFogCompanions = new Map();
    this._pendingGroundAtmosphereCompanions = new Map();
    this._destroyed = false;

    /** @type {*} */
    this._material = undefined;
    this._materialGeneration = 0;
  }

  /** @returns {*} */
  get material() {
    return this._material;
  }

  /** @param {*} value */
  set material(value) {
    if (this._material !== value) {
      this._material = value;
      ++this._materialGeneration;
    }
  }

  /** @param {GlobeSurfaceShaderSetOptions} options */
  getShaderProgram(options) {
    const frameState = options.frameState;
    const context = /** @type {Context} */ (frameState.context);
    const shaderCache = context.shaderCache;
    let shaderBucket = this._activeShaderBucket;
    if (this._activeContext !== context) {
      shaderBucket = this._shadersByContext.get(context);
      if (!defined(shaderBucket)) {
        shaderBucket = createShaderBucket();
        this._shadersByContext.set(context, shaderBucket);
      }
      this._activeContext = context;
      this._activeShaderBucket = shaderBucket;
      this._shadersByTexturesFlags = shaderBucket.shadersByTexturesFlags;
    }
    const shadersByTexturesFlags = shaderBucket.shadersByTexturesFlags;
    updateGroundAtmosphereCompanionBand(
      shaderBucket,
      options.groundAtmosphereCompanionEnabled === true,
      this._materialGeneration,
    );
    const surfaceTile = options.surfaceTile;
    const numberOfDayTextures = options.numberOfDayTextures;
    const applyBrightness = options.applyBrightness;
    const applyContrast = options.applyContrast;
    const applyHue = options.applyHue;
    const applySaturation = options.applySaturation;
    const applyGamma = options.applyGamma;
    const applyAlpha = options.applyAlpha;
    const applyDayNightAlpha = options.applyDayNightAlpha;
    const applyNightDarkness = options.applyNightDarkness;
    const applyNightLights = options.applyNightLights;
    const applyCelestialWater = options.applyCelestialWater;
    const applySplit = options.applySplit;
    const hasWaterMask = options.hasWaterMask;
    const showReflectiveOcean = options.showReflectiveOcean;
    const showOceanWaves = options.showOceanWaves;
    const enableLighting = options.enableLighting;
    const dynamicAtmosphereLighting = options.dynamicAtmosphereLighting;
    const dynamicAtmosphereLightingFromSun =
      options.dynamicAtmosphereLightingFromSun;
    const showGroundAtmosphere = options.showGroundAtmosphere;
    const perFragmentGroundAtmosphere = options.perFragmentGroundAtmosphere;
    const hasVertexNormals = options.hasVertexNormals;
    const useWebMercatorProjection = options.useWebMercatorProjection;
    const enableFog = options.enableFog;
    const enableClippingPlanes = options.enableClippingPlanes;
    const clippingPlanes = options.clippingPlanes;
    const enableClippingPolygons = options.enableClippingPolygons;
    const clippingPolygons = options.clippingPolygons;
    const clippedByBoundaries = options.clippedByBoundaries;
    const hasImageryLayerCutout = options.hasImageryLayerCutout;
    const colorCorrect = options.colorCorrect;
    const highlightFillTile = options.highlightFillTile;
    const colorToAlpha = options.colorToAlpha;
    const hasGeodeticSurfaceNormals = options.hasGeodeticSurfaceNormals;
    const hasExaggeration = options.hasExaggeration;
    const showUndergroundColor = options.showUndergroundColor;
    const translucent = options.translucent;
    const enableEclipseGlobeShadow = options.enableEclipseGlobeShadow;
    const vectorData = surfaceTile.vectorData;
    const hasVectorLayer = vectorData?.show;

    let quantization = 0;
    let quantizationDefine = "";

    const mesh = surfaceTile.renderedMesh;
    const terrainEncoding = mesh.encoding;
    const quantizationMode = terrainEncoding.quantization;
    if (quantizationMode === TerrainQuantization.BITS12) {
      quantization = 1;
      quantizationDefine = "QUANTIZATION_BITS12";
    }

    let cartographicLimitRectangleFlag = 0;
    let cartographicLimitRectangleDefine = "";
    if (clippedByBoundaries) {
      cartographicLimitRectangleFlag = 1;
      cartographicLimitRectangleDefine = "TILE_LIMIT_RECTANGLE";
    }

    let imageryCutoutFlag = 0;
    let imageryCutoutDefine = "";
    if (hasImageryLayerCutout) {
      imageryCutoutFlag = 1;
      imageryCutoutDefine = "APPLY_IMAGERY_CUTOUT";
    }

    const sceneMode = frameState.mode;
    // Bitwise OR uses 32-bit integers; bits 0-31 are packed below.
    // Flags beyond bit 31 use arithmetic to avoid silent wrap-around
    // (x << 32 === x << 0 in JavaScript).
    const flags =
      ((sceneMode |
        (+applyBrightness << 2) |
        (+applyContrast << 3) |
        (+applyHue << 4) |
        (+applySaturation << 5) |
        (+applyGamma << 6) |
        (+applyAlpha << 7) |
        (+hasWaterMask << 8) |
        (+showReflectiveOcean << 9) |
        (+showOceanWaves << 10) |
        (+enableLighting << 11) |
        (+dynamicAtmosphereLighting << 12) |
        (+dynamicAtmosphereLightingFromSun << 13) |
        (+showGroundAtmosphere << 14) |
        (+perFragmentGroundAtmosphere << 15) |
        (+hasVertexNormals << 16) |
        (+useWebMercatorProjection << 17) |
        (+enableFog << 18) |
        (quantization << 19) |
        (+applySplit << 20) |
        (+enableClippingPlanes << 21) |
        (+enableClippingPolygons << 22) |
        (cartographicLimitRectangleFlag << 23) |
        (imageryCutoutFlag << 24) |
        (+colorCorrect << 25) |
        (+highlightFillTile << 26) |
        (+colorToAlpha << 27) |
        (+hasGeodeticSurfaceNormals << 28) |
        (+hasExaggeration << 29) |
        (+showUndergroundColor << 30) |
        (+translucent << 31)) >>>
        0) +
      (applyDayNightAlpha ? 0x100000000 : 0) +
      (enableEclipseGlobeShadow ? 0x200000000 : 0) +
      // Upstream assigned hasVectorLayer 0x200000000; the fork's eclipse flag
      // already owns that bit, so the vector layer takes the next one.
      (hasVectorLayer ? 0x400000000 : 0) +
      (applyNightDarkness ? 0x800000000 : 0) +
      (applyNightLights ? 0x1000000000 : 0) +
      (applyCelestialWater ? 0x2000000000 : 0);

    let currentClippingShaderState = 0;
    if (defined(clippingPlanes) && clippingPlanes.length > 0) {
      currentClippingShaderState = enableClippingPlanes
        ? // @ts-expect-error Missing types.
          clippingPlanes.clippingPlanesState
        : 0;
    }

    let currentClippingPolygonsShaderState = 0;
    if (defined(clippingPolygons) && clippingPolygons.length > 0) {
      currentClippingPolygonsShaderState = enableClippingPolygons
        ? // @ts-expect-error Missing types.
          clippingPolygons.clippingPolygonsState
        : 0;
    }

    let surfaceShader = surfaceTile.surfaceShader;
    if (
      defined(surfaceShader) &&
      defined(surfaceShader.shaderProgram) &&
      surfaceShader.context === context &&
      surfaceShader.shaderCache === shaderCache &&
      surfaceShader.numberOfDayTextures === numberOfDayTextures &&
      surfaceShader.flags === flags &&
      surfaceShader.material === this.material &&
      surfaceShader.clippingShaderState === currentClippingShaderState &&
      surfaceShader.clippingPolygonShaderState ===
        currentClippingPolygonsShaderState
    ) {
      scheduleConfiguredCompanions(
        this,
        surfaceShader,
        shaderBucket,
        options,
        flags,
        currentClippingShaderState,
        currentClippingPolygonsShaderState,
      );
      return surfaceShader.shaderProgram;
    }

    // New tile, or tile changed number of textures, flags, or clipping planes
    let shadersByFlags = shadersByTexturesFlags[numberOfDayTextures];
    if (!defined(shadersByFlags)) {
      shadersByFlags = shadersByTexturesFlags[numberOfDayTextures] = [];
    }

    surfaceShader = shadersByFlags[flags];
    if (
      !defined(surfaceShader) ||
      surfaceShader.context !== context ||
      surfaceShader.shaderCache !== shaderCache ||
      surfaceShader.material !== this.material ||
      surfaceShader.clippingShaderState !== currentClippingShaderState ||
      surfaceShader.clippingPolygonShaderState !==
        currentClippingPolygonsShaderState
    ) {
      // Cache miss - we've never seen this combination of numberOfDayTextures and flags before.
      const displacedSurfaceShader = surfaceShader;
      const vs = this.baseVertexShaderSource.clone();
      const fs = this.baseFragmentShaderSource.clone();

      // Need to go before GlobeFS
      if (currentClippingShaderState !== 0) {
        fs.sources.unshift(getClippingFunction(clippingPlanes, context));
      }

      // Need to go before GlobeFS
      if (currentClippingPolygonsShaderState !== 0) {
        fs.sources.unshift(getPolygonClippingFunction(context));
        vs.sources.unshift(getUnpackClippingFunction(context));
      }

      vs.defines.push(quantizationDefine);
      fs.defines.push(
        `TEXTURE_UNITS ${numberOfDayTextures}`,
        cartographicLimitRectangleDefine,
        imageryCutoutDefine,
      );

      if (applyBrightness) {
        fs.defines.push("APPLY_BRIGHTNESS");
      }
      if (applyContrast) {
        fs.defines.push("APPLY_CONTRAST");
      }
      if (applyHue) {
        fs.defines.push("APPLY_HUE");
      }
      if (applySaturation) {
        fs.defines.push("APPLY_SATURATION");
      }
      if (applyGamma) {
        fs.defines.push("APPLY_GAMMA");
      }
      if (applyAlpha) {
        fs.defines.push("APPLY_ALPHA");
      }
      if (applyDayNightAlpha) {
        fs.defines.push("APPLY_DAY_NIGHT_ALPHA");
      }
      if (applyNightDarkness) {
        fs.defines.push("APPLY_NIGHT_DARKNESS");
      }
      if (applyNightLights) {
        fs.defines.push("APPLY_NIGHT_LIGHTS");
      }
      if (applyCelestialWater) {
        fs.defines.push("APPLY_CELESTIAL_WATER");
      }
      if (hasWaterMask) {
        fs.defines.push("HAS_WATER_MASK");
      }
      if (showReflectiveOcean) {
        fs.defines.push("SHOW_REFLECTIVE_OCEAN");
        vs.defines.push("SHOW_REFLECTIVE_OCEAN");
      }
      if (showOceanWaves) {
        fs.defines.push("SHOW_OCEAN_WAVES");
      }
      if (colorToAlpha) {
        fs.defines.push("APPLY_COLOR_TO_ALPHA");
      }
      if (showUndergroundColor) {
        vs.defines.push("UNDERGROUND_COLOR");
        fs.defines.push("UNDERGROUND_COLOR");
      }
      if (translucent) {
        vs.defines.push("TRANSLUCENT");
        fs.defines.push("TRANSLUCENT");
      }
      if (enableLighting) {
        if (hasVertexNormals) {
          vs.defines.push("ENABLE_VERTEX_LIGHTING");
          fs.defines.push("ENABLE_VERTEX_LIGHTING");
        } else {
          vs.defines.push("ENABLE_DAYNIGHT_SHADING");
          fs.defines.push("ENABLE_DAYNIGHT_SHADING");
        }
      }

      if (dynamicAtmosphereLighting) {
        vs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING");
        fs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING");
        if (dynamicAtmosphereLightingFromSun) {
          vs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN");
          fs.defines.push("DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN");
        }
      }

      if (showGroundAtmosphere) {
        vs.defines.push("GROUND_ATMOSPHERE");
        fs.defines.push("GROUND_ATMOSPHERE");
        if (perFragmentGroundAtmosphere) {
          vs.defines.push("PER_FRAGMENT_GROUND_ATMOSPHERE");
          fs.defines.push("PER_FRAGMENT_GROUND_ATMOSPHERE");
        }
      }

      vs.defines.push("INCLUDE_WEB_MERCATOR_Y");
      fs.defines.push("INCLUDE_WEB_MERCATOR_Y");

      if (enableFog) {
        vs.defines.push("FOG");
        fs.defines.push("FOG");
      }

      if (applySplit) {
        fs.defines.push("APPLY_SPLIT");
      }

      if (enableClippingPlanes) {
        fs.defines.push("ENABLE_CLIPPING_PLANES");
      }

      if (enableClippingPolygons) {
        fs.defines.push("ENABLE_CLIPPING_POLYGONS");
        vs.defines.push("ENABLE_CLIPPING_POLYGONS");

        if (clippingPolygons.inverse) {
          fs.defines.push("CLIPPING_INVERSE");
        }

        fs.defines.push(
          // @ts-expect-error Missing types.
          `CLIPPING_POLYGON_REGIONS_LENGTH ${clippingPolygons.extentsCount}`,
        );
        vs.defines.push(
          // @ts-expect-error Missing types.
          `CLIPPING_POLYGON_REGIONS_LENGTH ${clippingPolygons.extentsCount}`,
        );
      }

      if (colorCorrect) {
        fs.defines.push("COLOR_CORRECT");
      }

      if (highlightFillTile) {
        fs.defines.push("HIGHLIGHT_FILL_TILE");
      }

      if (hasGeodeticSurfaceNormals) {
        vs.defines.push("GEODETIC_SURFACE_NORMALS");
      }

      if (hasExaggeration) {
        vs.defines.push("EXAGGERATION");
      }

      if (enableEclipseGlobeShadow) {
        fs.defines.push("ENABLE_ECLIPSE_GLOBE_SHADOW");
      }

      if (hasVectorLayer) {
        vs.defines.push("HAS_VECTOR_LAYER");
        fs.defines.push("HAS_VECTOR_LAYER");
        fs.sources.unshift(VectorCommon); // before GlobeFS.
      }

      let computeDayColor =
        "\
      vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend)\n\
      {\n\
          vec4 color = initialColor;\n";

      if (hasImageryLayerCutout) {
        computeDayColor +=
          "\
          vec4 cutoutAndColorResult;\n\
          bool texelUnclipped;\n";
      }

      for (let i = 0; i < numberOfDayTextures; ++i) {
        if (hasImageryLayerCutout) {
          computeDayColor += `\
          cutoutAndColorResult = u_dayTextureCutoutRectangles[${i}];\n\
          texelUnclipped = v_textureCoordinates.x < cutoutAndColorResult.x || cutoutAndColorResult.z < v_textureCoordinates.x || v_textureCoordinates.y < cutoutAndColorResult.y || cutoutAndColorResult.w < v_textureCoordinates.y;\n\
          cutoutAndColorResult = sampleAndBlend(\n`;
        } else {
          computeDayColor +=
            "\
          color = sampleAndBlend(\n";
        }
        computeDayColor += `\
              color,\n\
              u_dayTextures[${i}],\n\
              u_dayTextureUseWebMercatorT[${i}] ? textureCoordinates.xz : textureCoordinates.xy,\n\
              u_dayTextureTexCoordsRectangle[${i}],\n\
              u_dayTextureTranslationAndScale[${i}],\n\
              ${applyAlpha ? `u_dayTextureAlpha[${i}]` : "1.0"},\n\
              ${applyDayNightAlpha ? `u_dayTextureNightAlpha[${i}]` : "1.0"},\n\
              ${applyDayNightAlpha ? `u_dayTextureDayAlpha[${i}]` : "1.0"},\n\
              ${applyBrightness ? `u_dayTextureBrightness[${i}]` : "0.0"},\n\
              ${applyContrast ? `u_dayTextureContrast[${i}]` : "0.0"},\n\
              ${applyHue ? `u_dayTextureHue[${i}]` : "0.0"},\n\
              ${applySaturation ? `u_dayTextureSaturation[${i}]` : "0.0"},\n\
              ${applyGamma ? `u_dayTextureOneOverGamma[${i}]` : "0.0"},\n\
              ${applySplit ? `u_dayTextureSplit[${i}]` : "0.0"},\n\
              ${colorToAlpha ? `u_colorsToAlpha[${i}]` : "vec4(0.0)"},\n\
              nightBlend\);\n`;
        if (hasImageryLayerCutout) {
          computeDayColor +=
            "\
          color = czm_branchFreeTernary(texelUnclipped, cutoutAndColorResult, color);\n";
        }
        // Emission is ADDED to the composite, once per layer, immediately
        // after that layer is composited - the same position the WGSL twin
        // occupies in its unrolled loop, and after the cutout ternary so a
        // cutout texel resolves the same way on both backends. The define
        // implies `applyDayNightAlpha`, so the alpha pair the gate reads is
        // always the real per-layer uniform here rather than the 1.0 literal
        // the composite above falls back to.
        if (applyNightLights) {
          computeDayColor += `\
          color.rgb = applyNightLightsEmission(color.rgb, g_nightLightsLayerColor, nightBlend, u_dayTextureNightAlpha[${i}], u_dayTextureDayAlpha[${i}]);\n`;
        }
      }

      computeDayColor +=
        "\
          return color;\n\
      }";

      fs.sources.push(computeDayColor);

      vs.sources.push(getPositionMode(sceneMode));
      vs.sources.push(get2DYPositionFraction(useWebMercatorProjection));

      const shader = ShaderProgram.fromCache({
        context: context,
        vertexShaderSource: vs,
        fragmentShaderSource: fs,
        attributeLocations: terrainEncoding.getAttributeLocations(),
      });

      const replacementSurfaceShader = new GlobeSurfaceShader(
        numberOfDayTextures,
        flags,
        this.material,
        context,
        shaderCache,
        shader,
        currentClippingShaderState,
        currentClippingPolygonsShaderState,
      );

      // Acquire the replacement before releasing the displaced reference. The
      // shader cache may return the same ShaderProgram for equivalent source,
      // in which case this keeps its reference count continuously owned.
      //
      // Every tile using this variant shares the displaced GlobeSurfaceShader
      // wrapper. Poisoning it prevents a culled tile from later fast-returning
      // a released (and eventually final-destroyed) program if the old
      // material or clipping state recurs.
      releaseSurfaceShader(displacedSurfaceShader);
      surfaceShader = shadersByFlags[flags] = replacementSurfaceShader;
    }

    surfaceTile.surfaceShader = surfaceShader;
    scheduleConfiguredCompanions(
      this,
      surfaceShader,
      shaderBucket,
      options,
      flags,
      currentClippingShaderState,
      currentClippingPolygonsShaderState,
    );
    return surfaceShader.shaderProgram;
  }

  destroy() {
    this._destroyed = true;
    this._pendingFogCompanions.clear();
    this._pendingGroundAtmosphereCompanions.clear();

    for (const shaderBucket of this._shadersByContext.values()) {
      retireShaderBucket(shaderBucket);
    }
    this._shadersByContext.clear();
    this._activeContext = undefined;
    this._activeShaderBucket = undefined;
    this._shadersByTexturesFlags = [];

    return destroyObject(this);
  }
}

/**
 * @returns {GlobeSurfaceShaderContextBucket}
 * @private
 */
function createShaderBucket() {
  return {
    shadersByTexturesFlags: [],
    preparationOwner: {},
    shaderCaches: new Set(),
    groundAtmosphereCompanionBandActive: false,
    groundAtmosphereCompanionBandSource: undefined,
    groundAtmosphereCompanionBandFinalConfig: -1,
    groundAtmosphereCompanionBandMaterialGeneration: 0,
  };
}

function retireShaderBucket(
  /** @type {GlobeSurfaceShaderContextBucket} */ shaderBucket,
) {
  for (const shaderCache of shaderBucket.shaderCaches) {
    if (typeof shaderCache?.cancelShaderProgramPreparations === "function") {
      shaderCache.cancelShaderProgramPreparations(
        shaderBucket.preparationOwner,
      );
    }
  }
  shaderBucket.shaderCaches.clear();
  releaseShaderBuckets(shaderBucket.shadersByTexturesFlags);
}

function releaseShaderBuckets(
  /** @type {GlobeSurfaceShader[][]} */ shadersByTexturesFlags,
) {
  for (const textureCount in shadersByTexturesFlags) {
    if (!shadersByTexturesFlags.hasOwnProperty(textureCount)) {
      continue;
    }
    const shadersByFlags = shadersByTexturesFlags[textureCount];
    if (!defined(shadersByFlags)) {
      continue;
    }

    for (const flags in shadersByFlags) {
      if (!shadersByFlags.hasOwnProperty(flags)) {
        continue;
      }
      const shader = shadersByFlags[flags];
      if (defined(shader)) {
        releaseSurfaceShader(shader);
      }
    }
  }
}

function updateGroundAtmosphereCompanionBand(
  /** @type {GlobeSurfaceShaderContextBucket} */ shaderBucket,
  /** @type {boolean} */ active,
  /** @type {number} */ materialGeneration,
) {
  if (!active) {
    if (
      !shaderBucket.groundAtmosphereCompanionBandActive &&
      !defined(shaderBucket.groundAtmosphereCompanionBandSource) &&
      shaderBucket.groundAtmosphereCompanionBandMaterialGeneration ===
        materialGeneration
    ) {
      return;
    }
    shaderBucket.groundAtmosphereCompanionBandActive = false;
    shaderBucket.groundAtmosphereCompanionBandSource = undefined;
    shaderBucket.groundAtmosphereCompanionBandFinalConfig = -1;
    shaderBucket.groundAtmosphereCompanionBandMaterialGeneration =
      materialGeneration;
    return;
  }

  if (
    !shaderBucket.groundAtmosphereCompanionBandActive ||
    shaderBucket.groundAtmosphereCompanionBandMaterialGeneration !==
      materialGeneration
  ) {
    shaderBucket.groundAtmosphereCompanionBandActive = true;
    shaderBucket.groundAtmosphereCompanionBandSource = undefined;
    shaderBucket.groundAtmosphereCompanionBandFinalConfig = -1;
    shaderBucket.groundAtmosphereCompanionBandMaterialGeneration =
      materialGeneration;
  }
}

function scheduleConfiguredCompanions(
  /** @type {GlobeSurfaceShaderSet} */
  shaderSet,
  /** @type {GlobeSurfaceShader} */
  surfaceShader,
  /** @type {GlobeSurfaceShaderContextBucket} */
  shaderBucket,
  /** @type {GlobeSurfaceShaderSetOptions} */
  options,
  /** @type {number} */
  flags,
  /** @type {number} */
  clippingShaderState,
  /** @type {number} */
  clippingPolygonShaderState,
) {
  if (options.frameState.shadowState?.lightShadowsEnabled === true) {
    return;
  }

  if (options.groundAtmosphereCompanionEnabled === true) {
    scheduleGroundAtmosphereCompanion(
      shaderSet,
      surfaceShader,
      shaderBucket,
      options,
      flags,
      clippingShaderState,
      clippingPolygonShaderState,
    );
  }

  // A band crossing owns at most one exact atmosphere cohort. Do not enqueue
  // the orthogonal fog companion in the same crossing; doing so would turn
  // two single-axis policies into a fog × atmosphere fan-out.
  if (
    options.fogCompanionEnabled === true &&
    !defined(shaderBucket.groundAtmosphereCompanionBandSource)
  ) {
    scheduleFogCompanion(
      shaderSet,
      surfaceShader,
      shaderBucket,
      options,
      flags,
      clippingShaderState,
      clippingPolygonShaderState,
    );
  }
}

function scheduleFogCompanion(
  /** @type {GlobeSurfaceShaderSet} */
  shaderSet,
  /** @type {GlobeSurfaceShader} */
  surfaceShader,
  /** @type {GlobeSurfaceShaderContextBucket} */
  shaderBucket,
  /** @type {GlobeSurfaceShaderSetOptions} */
  options,
  /** @type {number} */
  flags,
  /** @type {number} */
  clippingShaderState,
  /** @type {number} */
  clippingPolygonShaderState,
) {
  const shaderBuckets = shaderBucket.shadersByTexturesFlags;
  const frameState = options.frameState;
  const context = /** @type {Context} */ (frameState.context);
  const shaderCache = context.shaderCache;
  const useLogDepth = frameState.useLogDepth === true;
  const highDynamicRange = frameState.highDynamicRange === true;
  const finalConfig =
    +useLogDepth |
    (+highDynamicRange << 1) |
    (+(options.baseColorCorrect === false) << 2);
  const requestBit = 1 << finalConfig;
  if (options._skipFogCompanionPrewarm) {
    return;
  }
  if (
    surfaceShader.fogCompanionRequestContext !== context ||
    surfaceShader.fogCompanionRequestShaderCache !== shaderCache ||
    surfaceShader.fogCompanionRequestMaterial !== shaderSet.material ||
    surfaceShader.fogCompanionRequestMaterialGeneration !==
      shaderSet._materialGeneration
  ) {
    surfaceShader.fogCompanionRequestMask = 0;
    surfaceShader.fogCompanionRejectedMask = 0;
    surfaceShader.fogCompanionRetryAfterFrame = 0;
    surfaceShader.fogCompanionRequestContext = context;
    surfaceShader.fogCompanionRequestShaderCache = shaderCache;
    surfaceShader.fogCompanionRequestMaterial = shaderSet.material;
    surfaceShader.fogCompanionRequestMaterialGeneration =
      shaderSet._materialGeneration;
  }
  if ((surfaceShader.fogCompanionRequestMask & requestBit) !== 0) {
    return;
  }
  const frameNumber = frameState.frameNumber ?? 0;
  if ((surfaceShader.fogCompanionRejectedMask & requestBit) !== 0) {
    if (frameNumber < surfaceShader.fogCompanionRetryAfterFrame) {
      return;
    }
    surfaceShader.fogCompanionRejectedMask &= ~requestBit;
  }
  if (
    options.baseColorCorrect !== false ||
    options.translucent ||
    // @ts-expect-error Missing types.
    !defined(context._parallelShaderCompile) ||
    typeof shaderCache?.scheduleShaderProgramPreparation !== "function"
  ) {
    surfaceShader.fogCompanionRequestMask |= requestBit;
    return;
  }

  const numberOfDayTextures = options.numberOfDayTextures;
  // The measured route proves value for the zero/one-texture terrain cohorts.
  // Keep speculative ownership bounded instead of doubling every rare imagery
  // batching variant that happens to pass through the shader set.
  if (numberOfDayTextures > 1) {
    surfaceShader.fogCompanionRequestMask |= requestBit;
    return;
  }

  const companionFlags = options.enableFog
    ? flags - (1 << 18)
    : flags + (1 << 18);
  const shadersByFlags = shaderBuckets[numberOfDayTextures];
  const companionSurfaceShader = shadersByFlags?.[companionFlags];
  const compatibleCompanionSurfaceShader =
    defined(companionSurfaceShader) &&
    companionSurfaceShader.numberOfDayTextures === numberOfDayTextures &&
    companionSurfaceShader.flags === companionFlags &&
    companionSurfaceShader.context === context &&
    companionSurfaceShader.shaderCache === shaderCache &&
    companionSurfaceShader.material === shaderSet.material &&
    companionSurfaceShader.clippingShaderState === clippingShaderState &&
    companionSurfaceShader.clippingPolygonShaderState ===
      clippingPolygonShaderState
      ? companionSurfaceShader
      : undefined;
  let preparedFinalProgram = compatibleCompanionSurfaceShader?.shaderProgram;
  if (useLogDepth && defined(preparedFinalProgram)) {
    preparedFinalProgram = /** @type {ShaderProgram | undefined} */ (
      shaderCache.getDerivedShaderProgram(preparedFinalProgram, "logDepth")
    );
  }
  if (highDynamicRange && defined(preparedFinalProgram)) {
    preparedFinalProgram = /** @type {ShaderProgram | undefined} */ (
      shaderCache.getDerivedShaderProgram(preparedFinalProgram, "HDR")
    );
  }
  if (
    defined(preparedFinalProgram) &&
    preparedFinalProgram._linkState !== "uninitialized"
  ) {
    surfaceShader.fogCompanionRequestMask |= requestBit;
    return;
  }

  const key = `${numberOfDayTextures}:${companionFlags}:${clippingShaderState}:${clippingPolygonShaderState}:${finalConfig}`;
  const pendingCompanions = shaderSet._pendingFogCompanions;
  const existingToken = findPendingCompanion(
    pendingCompanions,
    key,
    context,
    shaderCache,
    shaderSet.material,
    shaderSet._materialGeneration,
    shaderBucket,
  );
  if (defined(existingToken)) {
    return;
  }

  const token = {
    material: shaderSet.material,
    context: context,
    shaderCache: shaderCache,
    shaderBucket: shaderBucket,
    surfaceShader: surfaceShader,
    materialGeneration: shaderSet._materialGeneration,
    numberOfDayTextures: numberOfDayTextures,
    sourceFlags: flags,
    completed: false,
    prepared: false,
  };
  addPendingCompanion(pendingCompanions, key, token);

  const sourceFrameState = options.frameState;
  const sceneMode = sourceFrameState.mode;
  const companionOptions = {
    ...options,
    frameState: sourceFrameState,
    surfaceTile: /** @type {GlobeSurfaceTile} */ ({
      renderedMesh: {
        encoding: options.surfaceTile.renderedMesh.encoding,
      },
    }),
    enableFog: !options.enableFog,
    colorCorrect: false,
    _skipFogCompanionPrewarm: true,
    _skipGroundAtmosphereCompanionPrewarm: true,
  };
  const clippingPlanes = options.clippingPlanes;
  const clippingPolygons = options.clippingPolygons;

  shaderBucket.shaderCaches.add(shaderCache);
  let accepted = false;
  try {
    accepted = shaderCache.scheduleShaderProgramPreparation(function () {
      let prepared = false;
      try {
        if (!removePendingCompanion(pendingCompanions, key, token)) {
          return undefined;
        }

        if (
          shaderSet._destroyed ||
          sourceFrameState.mode !== sceneMode ||
          sourceFrameState.context !== token.context ||
          token.context.shaderCache !== token.shaderCache ||
          shaderSet._shadersByContext.get(token.context) !==
            token.shaderBucket ||
          shaderSet.material !== token.material ||
          shaderSet._materialGeneration !== token.materialGeneration ||
          token.shaderBucket.shadersByTexturesFlags[
            token.numberOfDayTextures
          ]?.[token.sourceFlags] !== token.surfaceShader ||
          getClippingState(clippingPlanes, options.enableClippingPlanes) !==
            clippingShaderState ||
          getClippingPolygonState(
            clippingPolygons,
            options.enableClippingPolygons,
          ) !== clippingPolygonShaderState
        ) {
          return undefined;
        }

        const baseShaderProgram = shaderSet.getShaderProgram(companionOptions);
        let command = new DrawCommand({
          shaderProgram: baseShaderProgram,
        });
        if (useLogDepth) {
          command = DerivedCommand.createLogDepthCommand(
            command,
            context,
          ).command;
        }
        if (highDynamicRange) {
          command = DerivedCommand.createHdrCommand(command, context).command;
        }
        const finalProgram = command.shaderProgram;
        prepared = defined(finalProgram);
        return finalProgram;
      } finally {
        token.completed = true;
        token.prepared = prepared;
        if (!prepared) {
          clearFogCompanionRequest(token, requestBit);
        }
      }
    }, shaderBucket.preparationOwner);
  } finally {
    if (!accepted) {
      removePendingCompanion(pendingCompanions, key, token);
      clearFogCompanionRequest(token, requestBit);
      surfaceShader.fogCompanionRejectedMask |= requestBit;
      surfaceShader.fogCompanionRetryAfterFrame =
        frameNumber + companionPreparationRetryFrames;
    }
  }
  if (accepted && (!token.completed || token.prepared)) {
    surfaceShader.fogCompanionRejectedMask &= ~requestBit;
    // Treat queued and completed preparation as the same bounded request. This
    // avoids rebuilding the structural string key for every tile while the
    // idle callback is pending. The callback clears the bit on every
    // stale/canceled/failed outcome so a later frame can retry.
    surfaceShader.fogCompanionRequestMask |= requestBit;
  }
}

function scheduleGroundAtmosphereCompanion(
  /** @type {GlobeSurfaceShaderSet} */
  shaderSet,
  /** @type {GlobeSurfaceShader} */
  surfaceShader,
  /** @type {GlobeSurfaceShaderContextBucket} */
  shaderBucket,
  /** @type {GlobeSurfaceShaderSetOptions} */
  options,
  /** @type {number} */
  flags,
  /** @type {number} */
  clippingShaderState,
  /** @type {number} */
  clippingPolygonShaderState,
) {
  if (options._skipGroundAtmosphereCompanionPrewarm) {
    return;
  }

  const frameState = options.frameState;
  const context = /** @type {Context} */ (frameState.context);
  const shaderCache = context.shaderCache;
  const useLogDepth = frameState.useLogDepth === true;
  const highDynamicRange = frameState.highDynamicRange === true;
  const finalConfig = +useLogDepth | (+highDynamicRange << 1);
  const requestBit = 1 << finalConfig;

  if (
    surfaceShader.groundAtmosphereCompanionRequestContext !== context ||
    surfaceShader.groundAtmosphereCompanionRequestShaderCache !== shaderCache ||
    surfaceShader.groundAtmosphereCompanionRequestMaterial !==
      shaderSet.material ||
    surfaceShader.groundAtmosphereCompanionRequestMaterialGeneration !==
      shaderSet._materialGeneration
  ) {
    surfaceShader.groundAtmosphereCompanionRequestMask = 0;
    surfaceShader.groundAtmosphereCompanionRejectedMask = 0;
    surfaceShader.groundAtmosphereCompanionRetryAfterFrame = 0;
    surfaceShader.groundAtmosphereCompanionRequestContext = context;
    surfaceShader.groundAtmosphereCompanionRequestShaderCache = shaderCache;
    surfaceShader.groundAtmosphereCompanionRequestMaterial = shaderSet.material;
    surfaceShader.groundAtmosphereCompanionRequestMaterialGeneration =
      shaderSet._materialGeneration;
  }
  if ((surfaceShader.groundAtmosphereCompanionRequestMask & requestBit) !== 0) {
    return;
  }

  const frameNumber = frameState.frameNumber ?? 0;
  if (
    (surfaceShader.groundAtmosphereCompanionRejectedMask & requestBit) !==
    0
  ) {
    if (frameNumber < surfaceShader.groundAtmosphereCompanionRetryAfterFrame) {
      return;
    }
    surfaceShader.groundAtmosphereCompanionRejectedMask &= ~requestBit;
  }

  const numberOfDayTextures = options.numberOfDayTextures;
  if (
    !shaderBucket.groundAtmosphereCompanionBandActive ||
    frameState.mode !== SceneMode.SCENE3D ||
    options.showGroundAtmosphere !== true ||
    options.baseColorCorrect !== false ||
    options.colorCorrect === true ||
    options.translucent ||
    (numberOfDayTextures !== 0 && numberOfDayTextures !== 1) ||
    context.isWebGPU === true ||
    frameState.shadowState?.lightShadowsEnabled === true ||
    // @ts-expect-error Missing types.
    !defined(context._parallelShaderCompile) ||
    typeof shaderCache?.scheduleShaderProgramPreparation !== "function"
  ) {
    surfaceShader.groundAtmosphereCompanionRequestMask |= requestBit;
    return;
  }

  const selectedSource = shaderBucket.groundAtmosphereCompanionBandSource;
  if (
    defined(selectedSource) &&
    (selectedSource !== surfaceShader ||
      shaderBucket.groundAtmosphereCompanionBandFinalConfig !== finalConfig)
  ) {
    return;
  }
  if (!defined(selectedSource)) {
    shaderBucket.groundAtmosphereCompanionBandSource = surfaceShader;
    shaderBucket.groundAtmosphereCompanionBandFinalConfig = finalConfig;
  }

  const companionFlags = options.perFragmentGroundAtmosphere
    ? flags - perFragmentGroundAtmosphereFlag
    : flags + perFragmentGroundAtmosphereFlag;
  const shaderBuckets = shaderBucket.shadersByTexturesFlags;
  const shadersByFlags = shaderBuckets[numberOfDayTextures];
  const companionSurfaceShader = shadersByFlags?.[companionFlags];
  const compatibleCompanionSurfaceShader =
    defined(companionSurfaceShader) &&
    companionSurfaceShader.numberOfDayTextures === numberOfDayTextures &&
    companionSurfaceShader.flags === companionFlags &&
    companionSurfaceShader.context === context &&
    companionSurfaceShader.shaderCache === shaderCache &&
    companionSurfaceShader.material === shaderSet.material &&
    companionSurfaceShader.clippingShaderState === clippingShaderState &&
    companionSurfaceShader.clippingPolygonShaderState ===
      clippingPolygonShaderState
      ? companionSurfaceShader
      : undefined;
  let preparedFinalProgram = compatibleCompanionSurfaceShader?.shaderProgram;
  if (useLogDepth && defined(preparedFinalProgram)) {
    preparedFinalProgram = /** @type {ShaderProgram | undefined} */ (
      shaderCache.getDerivedShaderProgram(preparedFinalProgram, "logDepth")
    );
  }
  if (highDynamicRange && defined(preparedFinalProgram)) {
    preparedFinalProgram = /** @type {ShaderProgram | undefined} */ (
      shaderCache.getDerivedShaderProgram(preparedFinalProgram, "HDR")
    );
  }
  if (
    defined(preparedFinalProgram) &&
    preparedFinalProgram._linkState !== "uninitialized"
  ) {
    surfaceShader.groundAtmosphereCompanionRequestMask |= requestBit;
    return;
  }

  const key = `${numberOfDayTextures}:${companionFlags}:${clippingShaderState}:${clippingPolygonShaderState}:${finalConfig}`;
  const pendingCompanions = shaderSet._pendingGroundAtmosphereCompanions;
  const existingToken = findPendingCompanion(
    pendingCompanions,
    key,
    context,
    shaderCache,
    shaderSet.material,
    shaderSet._materialGeneration,
    shaderBucket,
  );
  if (defined(existingToken)) {
    return;
  }

  const token = {
    material: shaderSet.material,
    context: context,
    shaderCache: shaderCache,
    shaderBucket: shaderBucket,
    surfaceShader: surfaceShader,
    materialGeneration: shaderSet._materialGeneration,
    numberOfDayTextures: numberOfDayTextures,
    sourceFlags: flags,
    completed: false,
    prepared: false,
  };
  addPendingCompanion(pendingCompanions, key, token);

  const sourceFrameState = options.frameState;
  const sceneMode = sourceFrameState.mode;
  const companionOptions = {
    ...options,
    frameState: sourceFrameState,
    surfaceTile: /** @type {GlobeSurfaceTile} */ ({
      renderedMesh: {
        encoding: options.surfaceTile.renderedMesh.encoding,
      },
    }),
    perFragmentGroundAtmosphere: !options.perFragmentGroundAtmosphere,
    _skipFogCompanionPrewarm: true,
    _skipGroundAtmosphereCompanionPrewarm: true,
  };
  const clippingPlanes = options.clippingPlanes;
  const clippingPolygons = options.clippingPolygons;

  shaderBucket.shaderCaches.add(shaderCache);
  let accepted = false;
  try {
    accepted = shaderCache.scheduleShaderProgramPreparation(function () {
      let prepared = false;
      try {
        if (!removePendingCompanion(pendingCompanions, key, token)) {
          return undefined;
        }

        if (
          shaderSet._destroyed ||
          sourceFrameState.mode !== sceneMode ||
          sourceFrameState.mode !== SceneMode.SCENE3D ||
          sourceFrameState.context !== token.context ||
          token.context.shaderCache !== token.shaderCache ||
          // @ts-expect-error Missing types.
          !defined(token.context._parallelShaderCompile) ||
          sourceFrameState.shadowState?.lightShadowsEnabled === true ||
          shaderSet._shadersByContext.get(token.context) !==
            token.shaderBucket ||
          shaderSet.material !== token.material ||
          shaderSet._materialGeneration !== token.materialGeneration ||
          token.shaderBucket.groundAtmosphereCompanionBandSource !==
            token.surfaceShader ||
          token.shaderBucket.groundAtmosphereCompanionBandFinalConfig !==
            finalConfig ||
          token.shaderBucket.shadersByTexturesFlags[
            token.numberOfDayTextures
          ]?.[token.sourceFlags] !== token.surfaceShader ||
          getClippingState(clippingPlanes, options.enableClippingPlanes) !==
            clippingShaderState ||
          getClippingPolygonState(
            clippingPolygons,
            options.enableClippingPolygons,
          ) !== clippingPolygonShaderState
        ) {
          return undefined;
        }

        const baseShaderProgram = shaderSet.getShaderProgram(companionOptions);
        let command = new DrawCommand({
          shaderProgram: baseShaderProgram,
        });
        if (useLogDepth) {
          command = DerivedCommand.createLogDepthCommand(
            command,
            context,
          ).command;
        }
        if (highDynamicRange) {
          command = DerivedCommand.createHdrCommand(command, context).command;
        }
        const finalProgram = command.shaderProgram;
        prepared = defined(finalProgram);
        return finalProgram;
      } finally {
        token.completed = true;
        token.prepared = prepared;
        if (!prepared) {
          clearGroundAtmosphereCompanionRequest(token, requestBit, true);
        }
      }
    }, shaderBucket.preparationOwner);
  } finally {
    if (!accepted) {
      removePendingCompanion(pendingCompanions, key, token);
      clearGroundAtmosphereCompanionRequest(token, requestBit, false);
      surfaceShader.groundAtmosphereCompanionRejectedMask |= requestBit;
      surfaceShader.groundAtmosphereCompanionRetryAfterFrame =
        frameNumber + companionPreparationRetryFrames;
    }
  }
  if (accepted && (!token.completed || token.prepared)) {
    surfaceShader.groundAtmosphereCompanionRejectedMask &= ~requestBit;
    surfaceShader.groundAtmosphereCompanionRequestMask |= requestBit;
  }
}

function findPendingCompanion(
  /** @type {Map<string, ShaderCompanionToken[]>} */ pendingCompanions,
  /** @type {string} */ key,
  /** @type {Context} */ context,
  /** @type {*} */ shaderCache,
  /** @type {*} */ material,
  /** @type {number} */ materialGeneration,
  /** @type {GlobeSurfaceShaderContextBucket} */ shaderBucket,
) {
  const tokens = pendingCompanions.get(key);
  if (!defined(tokens)) {
    return undefined;
  }

  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (
      token.context === context &&
      token.shaderCache === shaderCache &&
      token.material === material &&
      token.materialGeneration === materialGeneration &&
      token.shaderBucket === shaderBucket
    ) {
      return token;
    }
  }
  return undefined;
}

function addPendingCompanion(
  /** @type {Map<string, ShaderCompanionToken[]>} */ pendingCompanions,
  /** @type {string} */ key,
  /** @type {ShaderCompanionToken} */ token,
) {
  let tokens = pendingCompanions.get(key);
  if (!defined(tokens)) {
    tokens = [];
    pendingCompanions.set(key, tokens);
  }
  tokens.push(token);
}

function removePendingCompanion(
  /** @type {Map<string, ShaderCompanionToken[]>} */ pendingCompanions,
  /** @type {string} */ key,
  /** @type {ShaderCompanionToken} */ token,
) {
  const tokens = pendingCompanions.get(key);
  if (!defined(tokens)) {
    return false;
  }

  const index = tokens.indexOf(token);
  if (index === -1) {
    return false;
  }
  tokens.splice(index, 1);
  if (tokens.length === 0) {
    pendingCompanions.delete(key);
  }
  return true;
}

function clearFogCompanionRequest(
  /** @type {ShaderCompanionToken} */ token,
  /** @type {number} */ requestBit,
) {
  const surfaceShader = token.surfaceShader;
  if (
    surfaceShader.fogCompanionRequestContext === token.context &&
    surfaceShader.fogCompanionRequestShaderCache === token.shaderCache &&
    surfaceShader.fogCompanionRequestMaterial === token.material &&
    surfaceShader.fogCompanionRequestMaterialGeneration ===
      token.materialGeneration
  ) {
    surfaceShader.fogCompanionRequestMask &= ~requestBit;
  }
}

function clearGroundAtmosphereCompanionRequest(
  /** @type {ShaderCompanionToken} */ token,
  /** @type {number} */ requestBit,
  /** @type {boolean} */ releaseBandSelection,
) {
  const surfaceShader = token.surfaceShader;
  if (
    surfaceShader.groundAtmosphereCompanionRequestContext === token.context &&
    surfaceShader.groundAtmosphereCompanionRequestShaderCache ===
      token.shaderCache &&
    surfaceShader.groundAtmosphereCompanionRequestMaterial === token.material &&
    surfaceShader.groundAtmosphereCompanionRequestMaterialGeneration ===
      token.materialGeneration
  ) {
    surfaceShader.groundAtmosphereCompanionRequestMask &= ~requestBit;
  }

  const shaderBucket = token.shaderBucket;
  if (
    releaseBandSelection &&
    shaderBucket.groundAtmosphereCompanionBandSource === token.surfaceShader &&
    shaderBucket.groundAtmosphereCompanionBandMaterialGeneration ===
      token.materialGeneration
  ) {
    shaderBucket.groundAtmosphereCompanionBandSource = undefined;
    shaderBucket.groundAtmosphereCompanionBandFinalConfig = -1;
  }
}

function getClippingState(
  /** @type {ClippingPlaneCollection | undefined} */
  clippingPlanes,
  /** @type {boolean | undefined} */
  enabled,
) {
  return defined(clippingPlanes) && clippingPlanes.length > 0 && enabled
    ? // @ts-expect-error Missing types.
      clippingPlanes.clippingPlanesState
    : 0;
}

function getClippingPolygonState(
  /** @type {ClippingPolygonCollection | undefined} */
  clippingPolygons,
  /** @type {boolean | undefined} */
  enabled,
) {
  return defined(clippingPolygons) && clippingPolygons.length > 0 && enabled
    ? // @ts-expect-error Missing types.
      clippingPolygons.clippingPolygonsState
    : 0;
}

// Releasing through the shared wrapper also invalidates every tile that still
// references it, so no tile can fast-return a program after its cache ownership
// has been released.
// @ts-expect-error Missing types.
function releaseSurfaceShader(surfaceShader) {
  if (!defined(surfaceShader) || !defined(surfaceShader.shaderProgram)) {
    return;
  }

  surfaceShader.shaderProgram = surfaceShader.shaderProgram.destroy();
}

/**
 * @param {SceneMode} sceneMode
 * @ignore
 */
function getPositionMode(sceneMode) {
  const getPosition3DMode =
    "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPosition3DMode(position, height, textureCoordinates); }";
  const getPositionColumbusViewAnd2DMode =
    "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionColumbusViewMode(position, height, textureCoordinates); }";
  const getPositionMorphingMode =
    "vec4 getPosition(vec3 position, float height, vec2 textureCoordinates) { return getPositionMorphingMode(position, height, textureCoordinates); }";

  let positionMode;

  switch (sceneMode) {
    case SceneMode.SCENE3D:
      positionMode = getPosition3DMode;
      break;
    case SceneMode.SCENE2D:
    case SceneMode.COLUMBUS_VIEW:
      positionMode = getPositionColumbusViewAnd2DMode;
      break;
    case SceneMode.MORPHING:
      positionMode = getPositionMorphingMode;
      break;
  }

  return positionMode;
}

/**
 * @param {Context} context
 * @ignore
 */
function getPolygonClippingFunction(context) {
  // return a noop for webgl1
  if (!context.webgl2) {
    return `void clipPolygons(highp sampler2D clippingDistance, int regionsLength, vec2 clippingPosition, int regionIndex) {
    }`;
  }

  return `void clipPolygons(highp sampler2D clippingDistance, int regionsLength, vec2 clippingPosition, int regionIndex) {
    czm_clipPolygons(clippingDistance, regionsLength, clippingPosition, regionIndex);
  }`;
}

/**
 * @param {Context} context
 * @ignore
 */
function getUnpackClippingFunction(context) {
  // return a noop for webgl1
  if (!context.webgl2) {
    return `vec4 unpackClippingExtents(highp sampler2D extentsTexture, int index) {
      return vec4();
    }`;
  }

  return `vec4 unpackClippingExtents(highp sampler2D extentsTexture, int index) {
    return czm_unpackClippingExtents(extentsTexture, index);
  }`;
}

/**
 * @param {boolean} useWebMercatorProjection
 * @returns {string}
 * @ignore
 */
function get2DYPositionFraction(useWebMercatorProjection) {
  const get2DYPositionFractionGeographicProjection =
    "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DGeographicYPositionFraction(textureCoordinates); }";
  const get2DYPositionFractionMercatorProjection =
    "float get2DYPositionFraction(vec2 textureCoordinates) { return get2DMercatorYPositionFraction(textureCoordinates); }";
  return useWebMercatorProjection
    ? get2DYPositionFractionMercatorProjection
    : get2DYPositionFractionGeographicProjection;
}

export default GlobeSurfaceShaderSet;
