import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian4 from "../Core/Cartesian4.js";
import CesiumMath from "../Core/Math.js";
import defined from "../Core/defined.js";
import GeographicProjection from "../Core/GeographicProjection.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import Rectangle from "../Core/Rectangle.js";
import TileProviderError from "../Core/TileProviderError.js";
import WebMercatorProjection from "../Core/WebMercatorProjection.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import MipmapHint from "../Renderer/MipmapHint.js";
import Request from "../Core/Request.js";
import RequestState from "../Core/RequestState.js";
import RequestType from "../Core/RequestType.js";
import Sampler from "../Renderer/Sampler.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import Texture from "../Renderer/Texture.js";
import TextureMagnificationFilter from "../Renderer/TextureMagnificationFilter.js";
import TextureMinificationFilter from "../Renderer/TextureMinificationFilter.js";
import TextureWrap from "../Renderer/TextureWrap.js";
import VertexArray from "../Renderer/VertexArray.js";
import ReprojectWebMercatorFS from "../Shaders/ReprojectWebMercatorFS.js";
import ReprojectWebMercatorVS from "../Shaders/ReprojectWebMercatorVS.js";
import ImageryState from "./ImageryState.js";
import TileImagery from "./TileImagery.js";

const imageryBoundsScratch = new Rectangle();
const tileImageryBoundsScratch = new Rectangle();
const clippedRectangleScratch = new Rectangle();
const terrainRectangleScratch = new Rectangle();

/**
 * Create skeletons for the imagery tiles that partially or completely overlap
 * a given terrain tile.
 *
 * @param {ImageryLayer} layer The imagery layer.
 * @param {QuadtreeTile} tile The terrain tile.
 * @param {TerrainProvider|undefined} terrainProvider The terrain provider.
 * @param {number} insertionPoint Position to insert new skeletons.
 * @returns {boolean} true if this layer overlaps any portion of the terrain tile.
 * @private
 */
function createTileImagerySkeletons(
  layer,
  tile,
  terrainProvider,
  insertionPoint,
) {
  const surfaceTile = tile.data;

  if (
    !defined(terrainProvider) ||
    (defined(layer._minimumTerrainLevel) &&
      tile.level < layer._minimumTerrainLevel)
  ) {
    return false;
  }
  if (
    defined(layer._maximumTerrainLevel) &&
    tile.level > layer._maximumTerrainLevel
  ) {
    return false;
  }

  if (!defined(insertionPoint)) {
    insertionPoint = surfaceTile.imagery.length;
  }

  const imageryProvider = layer._imageryProvider;
  if (!layer.ready) {
    layer._skeletonPlaceholder.loadingImagery.addReference();
    surfaceTile.imagery.splice(insertionPoint, 0, layer._skeletonPlaceholder);
    return true;
  }

  const useWebMercatorT =
    imageryProvider.tilingScheme.projection instanceof WebMercatorProjection &&
    tile.rectangle.north < WebMercatorProjection.MaximumLatitude &&
    tile.rectangle.south > -WebMercatorProjection.MaximumLatitude;

  const imageryBounds = Rectangle.intersection(
    imageryProvider.rectangle,
    layer._rectangle,
    imageryBoundsScratch,
  );
  let rectangle = Rectangle.intersection(
    tile.rectangle,
    imageryBounds,
    tileImageryBoundsScratch,
  );

  if (!defined(rectangle)) {
    if (!layer.isBaseLayer()) {
      return false;
    }

    const baseImageryRectangle = imageryBounds;
    const baseTerrainRectangle = tile.rectangle;
    rectangle = tileImageryBoundsScratch;

    if (baseTerrainRectangle.south >= baseImageryRectangle.north) {
      rectangle.north = rectangle.south = baseImageryRectangle.north;
    } else if (baseTerrainRectangle.north <= baseImageryRectangle.south) {
      rectangle.north = rectangle.south = baseImageryRectangle.south;
    } else {
      rectangle.south = Math.max(
        baseTerrainRectangle.south,
        baseImageryRectangle.south,
      );
      rectangle.north = Math.min(
        baseTerrainRectangle.north,
        baseImageryRectangle.north,
      );
    }

    if (baseTerrainRectangle.west >= baseImageryRectangle.east) {
      rectangle.west = rectangle.east = baseImageryRectangle.east;
    } else if (baseTerrainRectangle.east <= baseImageryRectangle.west) {
      rectangle.west = rectangle.east = baseImageryRectangle.west;
    } else {
      rectangle.west = Math.max(
        baseTerrainRectangle.west,
        baseImageryRectangle.west,
      );
      rectangle.east = Math.min(
        baseTerrainRectangle.east,
        baseImageryRectangle.east,
      );
    }
  }

  let latitudeClosestToEquator = 0.0;
  if (rectangle.south > 0.0) {
    latitudeClosestToEquator = rectangle.south;
  } else if (rectangle.north < 0.0) {
    latitudeClosestToEquator = rectangle.north;
  }

  const errorRatio = 1.0;
  const targetGeometricError =
    errorRatio * terrainProvider.getLevelMaximumGeometricError(tile.level);
  let imageryLevel = getLevelWithMaximumTexelSpacing(
    layer,
    targetGeometricError,
    latitudeClosestToEquator,
  );
  imageryLevel = Math.max(0, imageryLevel);
  const maximumLevel = imageryProvider.maximumLevel;
  if (imageryLevel > maximumLevel) {
    imageryLevel = maximumLevel;
  }

  if (defined(imageryProvider.minimumLevel)) {
    const minimumLevel = imageryProvider.minimumLevel;
    if (imageryLevel < minimumLevel) {
      imageryLevel = minimumLevel;
    }
  }

  const imageryTilingScheme = imageryProvider.tilingScheme;
  const northwestTileCoordinates = imageryTilingScheme.positionToTileXY(
    Rectangle.northwest(rectangle),
    imageryLevel,
  );
  const southeastTileCoordinates = imageryTilingScheme.positionToTileXY(
    Rectangle.southeast(rectangle),
    imageryLevel,
  );

  let veryCloseX = tile.rectangle.width / 512.0;
  let veryCloseY = tile.rectangle.height / 512.0;

  const northwestTileRectangle = imageryTilingScheme.tileXYToRectangle(
    northwestTileCoordinates.x,
    northwestTileCoordinates.y,
    imageryLevel,
  );
  if (
    Math.abs(northwestTileRectangle.south - tile.rectangle.north) <
      veryCloseY &&
    northwestTileCoordinates.y < southeastTileCoordinates.y
  ) {
    ++northwestTileCoordinates.y;
  }
  if (
    Math.abs(northwestTileRectangle.east - tile.rectangle.west) < veryCloseX &&
    northwestTileCoordinates.x < southeastTileCoordinates.x
  ) {
    ++northwestTileCoordinates.x;
  }

  const southeastTileRectangle = imageryTilingScheme.tileXYToRectangle(
    southeastTileCoordinates.x,
    southeastTileCoordinates.y,
    imageryLevel,
  );
  if (
    Math.abs(southeastTileRectangle.north - tile.rectangle.south) <
      veryCloseY &&
    southeastTileCoordinates.y > northwestTileCoordinates.y
  ) {
    --southeastTileCoordinates.y;
  }
  if (
    Math.abs(southeastTileRectangle.west - tile.rectangle.east) < veryCloseX &&
    southeastTileCoordinates.x > northwestTileCoordinates.x
  ) {
    --southeastTileCoordinates.x;
  }

  const terrainRectangle = Rectangle.clone(
    tile.rectangle,
    terrainRectangleScratch,
  );
  let imageryRectangle = imageryTilingScheme.tileXYToRectangle(
    northwestTileCoordinates.x,
    northwestTileCoordinates.y,
    imageryLevel,
  );
  let clippedImageryRectangle = Rectangle.intersection(
    imageryRectangle,
    imageryBounds,
    clippedRectangleScratch,
  );

  let imageryTileXYToRectangle;
  if (useWebMercatorT) {
    imageryTilingScheme.rectangleToNativeRectangle(
      terrainRectangle,
      terrainRectangle,
    );
    imageryTilingScheme.rectangleToNativeRectangle(
      imageryRectangle,
      imageryRectangle,
    );
    imageryTilingScheme.rectangleToNativeRectangle(
      clippedImageryRectangle,
      clippedImageryRectangle,
    );
    imageryTilingScheme.rectangleToNativeRectangle(
      imageryBounds,
      imageryBounds,
    );
    imageryTileXYToRectangle =
      imageryTilingScheme.tileXYToNativeRectangle.bind(imageryTilingScheme);
    veryCloseX = terrainRectangle.width / 512.0;
    veryCloseY = terrainRectangle.height / 512.0;
  } else {
    imageryTileXYToRectangle =
      imageryTilingScheme.tileXYToRectangle.bind(imageryTilingScheme);
  }

  let minU;
  let maxU = 0.0;

  let minV = 1.0;
  let maxV;

  if (
    !layer.isBaseLayer() &&
    Math.abs(clippedImageryRectangle.west - terrainRectangle.west) >= veryCloseX
  ) {
    maxU = Math.min(
      1.0,
      (clippedImageryRectangle.west - terrainRectangle.west) /
        terrainRectangle.width,
    );
  }

  if (
    !layer.isBaseLayer() &&
    Math.abs(clippedImageryRectangle.north - terrainRectangle.north) >=
      veryCloseY
  ) {
    minV = Math.max(
      0.0,
      (clippedImageryRectangle.north - terrainRectangle.south) /
        terrainRectangle.height,
    );
  }

  const initialMinV = minV;

  for (
    let i = northwestTileCoordinates.x;
    i <= southeastTileCoordinates.x;
    i++
  ) {
    minU = maxU;

    imageryRectangle = imageryTileXYToRectangle(
      i,
      northwestTileCoordinates.y,
      imageryLevel,
    );
    clippedImageryRectangle = Rectangle.simpleIntersection(
      imageryRectangle,
      imageryBounds,
      clippedRectangleScratch,
    );

    if (!defined(clippedImageryRectangle)) {
      continue;
    }

    maxU = Math.min(
      1.0,
      (clippedImageryRectangle.east - terrainRectangle.west) /
        terrainRectangle.width,
    );

    if (
      i === southeastTileCoordinates.x &&
      (layer.isBaseLayer() ||
        Math.abs(clippedImageryRectangle.east - terrainRectangle.east) <
          veryCloseX)
    ) {
      maxU = 1.0;
    }

    minV = initialMinV;

    for (
      let j = northwestTileCoordinates.y;
      j <= southeastTileCoordinates.y;
      j++
    ) {
      maxV = minV;

      imageryRectangle = imageryTileXYToRectangle(i, j, imageryLevel);
      clippedImageryRectangle = Rectangle.simpleIntersection(
        imageryRectangle,
        imageryBounds,
        clippedRectangleScratch,
      );

      if (!defined(clippedImageryRectangle)) {
        continue;
      }

      minV = Math.max(
        0.0,
        (clippedImageryRectangle.south - terrainRectangle.south) /
          terrainRectangle.height,
      );

      if (
        j === southeastTileCoordinates.y &&
        (layer.isBaseLayer() ||
          Math.abs(clippedImageryRectangle.south - terrainRectangle.south) <
            veryCloseY)
      ) {
        minV = 0.0;
      }

      const texCoordsRectangle = new Cartesian4(minU, minV, maxU, maxV);
      const imagery = layer.getImageryFromCache(i, j, imageryLevel);
      surfaceTile.imagery.splice(
        insertionPoint,
        0,
        new TileImagery(imagery, texCoordsRectangle, useWebMercatorT),
      );
      ++insertionPoint;
    }
  }

  return true;
}

/**
 * Request a particular piece of imagery from the imagery provider.
 * @param {ImageryLayer} layer The imagery layer.
 * @param {Imagery} imagery The imagery to request.
 * @param {GraphicsContext} [context] Context whose immutable KTX2 targets are captured by the request.
 * @private
 */
function requestImagery(layer, imagery, context) {
  const imageryProvider = layer._imageryProvider;

  function success(image) {
    if (!defined(image)) {
      return failure();
    }

    imagery.image = image;
    imagery.state = ImageryState.RECEIVED;
    imagery.request = undefined;

    TileProviderError.reportSuccess(layer._requestImageError);
  }

  function failure(e) {
    if (imagery.request.state === RequestState.CANCELLED) {
      imagery.state = ImageryState.UNLOADED;
      imagery.request = undefined;
      return;
    }

    imagery.state = ImageryState.FAILED;
    imagery.request = undefined;

    const message = `Failed to obtain image tile X: ${imagery.x} Y: ${imagery.y} Level: ${imagery.level}.`;
    layer._requestImageError = TileProviderError.reportError(
      layer._requestImageError,
      imageryProvider,
      imageryProvider.errorEvent,
      message,
      imagery.x,
      imagery.y,
      imagery.level,
      e,
    );
    if (layer._requestImageError.retry) {
      doRequest();
    }
  }

  function doRequest() {
    const request = new Request({
      throttle: false,
      throttleByServer: true,
      type: RequestType.IMAGERY,
    });
    request.ktx2TranscodeTargets =
      context?.graphicsCapabilities?.ktx2TranscodeTargets;
    imagery.request = request;
    imagery.state = ImageryState.TRANSITIONING;
    const imagePromise = imageryProvider.requestImage(
      imagery.x,
      imagery.y,
      imagery.level,
      request,
    );

    if (!defined(imagePromise)) {
      imagery.state = ImageryState.UNLOADED;
      imagery.request = undefined;
      return;
    }

    if (defined(imageryProvider.getTileCredits)) {
      imagery.credits = imageryProvider.getTileCredits(
        imagery.x,
        imagery.y,
        imagery.level,
      );
    }

    imagePromise
      .then(function (image) {
        success(image);
      })
      .catch(function (e) {
        failure(e);
      });
  }

  doRequest();
}

// The four scalar uniforms the per-fragment reproject fragment shader needs.
// `southLatitude` / `northLatitude` are in radians; `southMercatorY` /
// `oneOverMercatorHeight` are the precomputed Mercator-Y bounds for the
// destination imagery tile. Computing Mercator-Y per fragment from these is
// what removes the need for a per-row `webMercatorT` vertex buffer.
const uniformMap = {
  u_textureDimensions: function () {
    return this.textureDimensions;
  },
  u_texture: function () {
    return this.texture;
  },
  u_southLatitude: function () {
    return this.southLatitude;
  },
  u_northLatitude: function () {
    return this.northLatitude;
  },
  u_southMercatorY: function () {
    return this.southMercatorY;
  },
  u_oneOverMercatorHeight: function () {
    return this.oneOverMercatorHeight;
  },

  textureDimensions: new Cartesian2(),
  texture: undefined,
  southLatitude: 0.0,
  northLatitude: 0.0,
  southMercatorY: 0.0,
  oneOverMercatorHeight: 0.0,
};

function reprojectToGeographic(command, context, texture, rectangle) {
  let reproject = context.cache.imageryLayer_reproject;

  if (!defined(reproject)) {
    reproject = context.cache.imageryLayer_reproject = {
      vertexArray: undefined,
      shaderProgram: undefined,
      sampler: undefined,
      destroy: function () {
        if (defined(this.framebuffer)) {
          this.framebuffer.destroy();
        }
        if (defined(this.vertexArray)) {
          this.vertexArray.destroy();
        }
        if (defined(this.shaderProgram)) {
          this.shaderProgram.destroy();
        }
      },
    };

    // A single quad. A multi-row vertex grid is only needed when the
    // rasterizer has to interpolate a per-row Mercator-Y value between rows;
    // the fragment shader computes Mercator-Y itself, so four vertices suffice.
    const positions = new Float32Array([
      0.0,
      0.0, // bottom-left  (south, west)
      1.0,
      0.0, // bottom-right (south, east)
      0.0,
      1.0, // top-left     (north, west)
      1.0,
      1.0, // top-right    (north, east)
    ]);

    const reprojectAttributeIndices = {
      position: 0,
    };

    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    const indexBuffer = Buffer.createIndexBuffer({
      context: context,
      typedArray: indices,
      usage: BufferUsage.STATIC_DRAW,
      indexDatatype: IndexDatatype.UNSIGNED_SHORT,
    });

    reproject.vertexArray = new VertexArray({
      context: context,
      attributes: [
        {
          index: reprojectAttributeIndices.position,
          vertexBuffer: Buffer.createVertexBuffer({
            context: context,
            typedArray: positions,
            usage: BufferUsage.STATIC_DRAW,
          }),
          componentsPerAttribute: 2,
        },
      ],
      indexBuffer: indexBuffer,
    });

    const vs = new ShaderSource({
      sources: [ReprojectWebMercatorVS],
    });

    reproject.shaderProgram = ShaderProgram.fromCache({
      context: context,
      vertexShaderSource: vs,
      fragmentShaderSource: ReprojectWebMercatorFS,
      attributeLocations: reprojectAttributeIndices,
    });

    reproject.sampler = new Sampler({
      wrapS: TextureWrap.CLAMP_TO_EDGE,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
      minificationFilter: TextureMinificationFilter.LINEAR,
      magnificationFilter: TextureMagnificationFilter.LINEAR,
    });
  }

  texture.sampler = reproject.sampler;

  const width = texture.width;
  const height = texture.height;

  uniformMap.textureDimensions.x = width;
  uniformMap.textureDimensions.y = height;
  uniformMap.texture = texture;

  let sinLatitude = Math.sin(rectangle.south);
  const southMercatorY = 0.5 * Math.log((1 + sinLatitude) / (1 - sinLatitude));

  sinLatitude = Math.sin(rectangle.north);
  const northMercatorY = 0.5 * Math.log((1 + sinLatitude) / (1 - sinLatitude));
  const oneOverMercatorHeight = 1.0 / (northMercatorY - southMercatorY);

  uniformMap.southLatitude = rectangle.south;
  uniformMap.northLatitude = rectangle.north;
  uniformMap.southMercatorY = southMercatorY;
  uniformMap.oneOverMercatorHeight = oneOverMercatorHeight;

  const outputTexture = new Texture({
    context: context,
    width: width,
    height: height,
    pixelFormat: texture.pixelFormat,
    pixelDatatype: texture.pixelDatatype,
    preMultiplyAlpha: texture.preMultiplyAlpha,
  });

  if (CesiumMath.isPowerOfTwo(width) && CesiumMath.isPowerOfTwo(height)) {
    outputTexture.generateMipmap(MipmapHint.NICEST);
  }

  command.shaderProgram = reproject.shaderProgram;
  command.outputTexture = outputTexture;
  command.uniformMap = uniformMap;
  command.vertexArray = reproject.vertexArray;
}

function getLevelWithMaximumTexelSpacing(
  layer,
  texelSpacing,
  latitudeClosestToEquator,
) {
  const imageryProvider = layer._imageryProvider;
  const tilingScheme = imageryProvider.tilingScheme;
  const ellipsoid = tilingScheme.ellipsoid;
  const latitudeFactor = !(
    layer._imageryProvider.tilingScheme.projection instanceof
    GeographicProjection
  )
    ? Math.cos(latitudeClosestToEquator)
    : 1.0;
  const tilingSchemeRectangle = tilingScheme.rectangle;
  const levelZeroMaximumTexelSpacing =
    (ellipsoid.maximumRadius * tilingSchemeRectangle.width * latitudeFactor) /
    (imageryProvider.tileWidth * tilingScheme.getNumberOfXTilesAtLevel(0));

  const twoToTheLevelPower = levelZeroMaximumTexelSpacing / texelSpacing;
  const level = Math.log(twoToTheLevelPower) / Math.log(2);
  const rounded = Math.round(level);
  return rounded | 0;
}

function getSamplerKey(
  minificationFilter,
  magnificationFilter,
  maximumAnisotropy,
) {
  return `${minificationFilter}:${magnificationFilter}:${maximumAnisotropy}`;
}

function getImageryCacheKey(x, y, level) {
  return JSON.stringify([x, y, level]);
}

function handleError(errorEvent, error) {
  if (errorEvent.numberOfListeners > 0) {
    errorEvent.raiseEvent(error);
  } else {
    console.error(error);
  }
}

async function handlePromise(instance, promise) {
  let provider;
  try {
    provider = await Promise.resolve(promise);
    if (instance.isDestroyed()) {
      return;
    }
    instance._imageryProvider = provider;
    instance._readyEvent.raiseEvent(provider);
  } catch (error) {
    handleError(instance._errorEvent, error);
  }
}

export {
  createTileImagerySkeletons,
  requestImagery,
  reprojectToGeographic,
  getLevelWithMaximumTexelSpacing,
  getSamplerKey,
  getImageryCacheKey,
  handleError,
  handlePromise,
};

// Namespace default export for build system barrel compatibility
const ImageryLayerHelpers = {
  createTileImagerySkeletons,
  requestImagery,
  reprojectToGeographic,
  getLevelWithMaximumTexelSpacing,
  getSamplerKey,
  getImageryCacheKey,
  handleError,
  handlePromise,
};
export default ImageryLayerHelpers;
