import BoundingSphere from "../Core/BoundingSphere.js";
import BoxOutlineGeometry from "../Core/BoxOutlineGeometry.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import Color from "../Core/Color.js";
import ColorGeometryInstanceAttribute from "../Core/ColorGeometryInstanceAttribute.js";
import combine from "../Core/combine.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import GeometryInstance from "../Core/GeometryInstance.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import NearFarScalar from "../Core/NearFarScalar.js";
import OrientedBoundingBox from "../Core/OrientedBoundingBox.js";
import PrimitiveType from "../Core/PrimitiveType.js";
import Rectangle from "../Core/Rectangle.js";
import SphereOutlineGeometry from "../Core/SphereOutlineGeometry.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import TerrainQuantization from "../Core/TerrainQuantization.js";
import WebMercatorProjection from "../Core/WebMercatorProjection.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import ContextLimits from "../Renderer/ContextLimits.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import GlobeSurfaceTile from "./GlobeSurfaceTile.js";
import ImageryLayer from "./ImageryLayer.js";
import PerInstanceColorAppearance from "./PerInstanceColorAppearance.js";
import Primitive from "./Primitive.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import TerrainFillMesh from "./TerrainFillMesh.js";
import TileBoundingRegion from "./TileBoundingRegion.js";

// ═══════════════════════════════════════════════════════════════════════════
// Scratch variables for rendering
// ═══════════════════════════════════════════════════════════════════════════

const modifiedModelViewScratch = new Matrix4();
const modifiedModelViewProjectionScratch = new Matrix4();
const tileRectangleScratch = new Cartesian4();
const localizedCartographicLimitRectangleScratch = new Cartesian4();
const localizedTranslucencyRectangleScratch = new Cartesian4();
const rtcScratch = new Cartesian3();
const centerEyeScratch = new Cartesian3();
const southwestScratch = new Cartesian3();
const northeastScratch = new Cartesian3();

const cornerPositionsScratch = [
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
];

const otherPassesInitialColor = new Cartesian4(0.0, 0.0, 0.0, 0.0);

const defaultUndergroundColor = Color.TRANSPARENT;
const defaultUndergroundColorAlphaByDistance = new NearFarScalar();

const surfaceShaderSetOptionsScratch = {
  frameState: undefined,
  surfaceTile: undefined,
  numberOfDayTextures: undefined,
  applyBrightness: undefined,
  applyContrast: undefined,
  applyHue: undefined,
  applySaturation: undefined,
  applyGamma: undefined,
  applyAlpha: undefined,
  applyDayNightAlpha: undefined,
  applySplit: undefined,
  showReflectiveOcean: undefined,
  showOceanWaves: undefined,
  enableLighting: undefined,
  dynamicAtmosphereLighting: undefined,
  dynamicAtmosphereLightingFromSun: undefined,
  showGroundAtmosphere: undefined,
  perFragmentGroundAtmosphere: undefined,
  hasVertexNormals: undefined,
  useWebMercatorProjection: undefined,
  enableFog: undefined,
  enableClippingPlanes: undefined,
  clippingPlanes: undefined,
  enableClippingPolygons: undefined,
  clippingPolygons: undefined,
  clippedByBoundaries: undefined,
  hasImageryLayerCutout: undefined,
  colorCorrect: undefined,
  colorToAlpha: undefined,
  hasGeodeticSurfaceNormals: undefined,
  hasExaggeration: undefined,
};

const scratchClippingPlanesMatrix = new Matrix4();
const scratchInverseTransposeClippingPlanesMatrix = new Matrix4();

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

function isUndergroundVisible(tileProvider, frameState) {
  if (frameState.cameraUnderground) {
    return true;
  }

  if (frameState.globeTranslucencyState.translucent) {
    return true;
  }

  if (tileProvider.backFaceCulling) {
    return false;
  }

  const clippingPlanes = tileProvider._clippingPlanes;
  if (defined(clippingPlanes) && clippingPlanes.enabled) {
    return true;
  }

  const clippingPolygons = tileProvider._clippingPolygons;
  if (defined(clippingPolygons) && clippingPolygons.enabled) {
    return true;
  }

  if (
    !Rectangle.equals(
      tileProvider.cartographicLimitRectangle,
      Rectangle.MAX_VALUE,
    )
  ) {
    return true;
  }

  return false;
}

function pushCommand(command, frameState) {
  const globeTranslucencyState = frameState.globeTranslucencyState;
  if (globeTranslucencyState.translucent) {
    const isBlendCommand = command.renderState.blending.enabled;
    globeTranslucencyState.pushDerivedCommands(
      command,
      isBlendCommand,
      frameState,
    );
  } else {
    frameState.commandList.push(command);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bounding region & occludee point computation
// ═══════════════════════════════════════════════════════════════════════════

function computeOccludeePoint(
  tileProvider,
  center,
  rectangle,
  minimumHeight,
  maximumHeight,
  result,
) {
  const ellipsoidalOccluder = tileProvider.quadtree._occluders.ellipsoid;
  const ellipsoid = ellipsoidalOccluder.ellipsoid;

  const cornerPositions = cornerPositionsScratch;
  Cartesian3.fromRadians(
    rectangle.west,
    rectangle.south,
    maximumHeight,
    ellipsoid,
    cornerPositions[0],
  );
  Cartesian3.fromRadians(
    rectangle.east,
    rectangle.south,
    maximumHeight,
    ellipsoid,
    cornerPositions[1],
  );
  Cartesian3.fromRadians(
    rectangle.west,
    rectangle.north,
    maximumHeight,
    ellipsoid,
    cornerPositions[2],
  );
  Cartesian3.fromRadians(
    rectangle.east,
    rectangle.north,
    maximumHeight,
    ellipsoid,
    cornerPositions[3],
  );

  return ellipsoidalOccluder.computeHorizonCullingPointPossiblyUnderEllipsoid(
    center,
    cornerPositions,
    minimumHeight,
    result,
  );
}

function updateTileBoundingRegion(tile, tileProvider, frameState) {
  let surfaceTile = tile.data;
  if (surfaceTile === undefined) {
    surfaceTile = tile.data = new GlobeSurfaceTile();
  }

  const ellipsoid = tile.tilingScheme.ellipsoid;
  if (surfaceTile.tileBoundingRegion === undefined) {
    surfaceTile.tileBoundingRegion = new TileBoundingRegion({
      computeBoundingVolumes: false,
      rectangle: tile.rectangle,
      ellipsoid: ellipsoid,
      minimumHeight: 0.0,
      maximumHeight: 0.0,
    });
  }

  const tileBoundingRegion = surfaceTile.tileBoundingRegion;
  const oldMinimumHeight = tileBoundingRegion.minimumHeight;
  const oldMaximumHeight = tileBoundingRegion.maximumHeight;
  let hasBoundingVolumesFromMesh = false;
  let sourceTile = tile;

  const mesh = surfaceTile.mesh;
  const terrainData = surfaceTile.terrainData;
  if (
    mesh !== undefined &&
    mesh.minimumHeight !== undefined &&
    mesh.maximumHeight !== undefined
  ) {
    tileBoundingRegion.minimumHeight = mesh.minimumHeight;
    tileBoundingRegion.maximumHeight = mesh.maximumHeight;
    hasBoundingVolumesFromMesh = true;
  } else if (
    terrainData !== undefined &&
    terrainData._minimumHeight !== undefined &&
    terrainData._maximumHeight !== undefined
  ) {
    tileBoundingRegion.minimumHeight = terrainData._minimumHeight;
    tileBoundingRegion.maximumHeight = terrainData._maximumHeight;
  } else {
    tileBoundingRegion.minimumHeight = Number.NaN;
    tileBoundingRegion.maximumHeight = Number.NaN;

    let ancestorTile = tile.parent;
    while (ancestorTile !== undefined) {
      const ancestorSurfaceTile = ancestorTile.data;
      if (ancestorSurfaceTile !== undefined) {
        const ancestorMesh = ancestorSurfaceTile.mesh;
        const ancestorTerrainData = ancestorSurfaceTile.terrainData;
        if (
          ancestorMesh !== undefined &&
          ancestorMesh.minimumHeight !== undefined &&
          ancestorMesh.maximumHeight !== undefined
        ) {
          tileBoundingRegion.minimumHeight = ancestorMesh.minimumHeight;
          tileBoundingRegion.maximumHeight = ancestorMesh.maximumHeight;
          break;
        } else if (
          ancestorTerrainData !== undefined &&
          ancestorTerrainData._minimumHeight !== undefined &&
          ancestorTerrainData._maximumHeight !== undefined
        ) {
          tileBoundingRegion.minimumHeight = ancestorTerrainData._minimumHeight;
          tileBoundingRegion.maximumHeight = ancestorTerrainData._maximumHeight;
          break;
        }
      }
      ancestorTile = ancestorTile.parent;
    }
    sourceTile = ancestorTile;
  }

  if (sourceTile !== undefined) {
    const exaggeration = frameState.verticalExaggeration;
    const exaggerationRelativeHeight =
      frameState.verticalExaggerationRelativeHeight;
    const hasExaggeration = exaggeration !== 1.0;
    if (hasExaggeration) {
      hasBoundingVolumesFromMesh = false;
      tileBoundingRegion.minimumHeight = VerticalExaggeration.getHeight(
        tileBoundingRegion.minimumHeight,
        exaggeration,
        exaggerationRelativeHeight,
      );
      tileBoundingRegion.maximumHeight = VerticalExaggeration.getHeight(
        tileBoundingRegion.maximumHeight,
        exaggeration,
        exaggerationRelativeHeight,
      );
    }

    if (hasBoundingVolumesFromMesh) {
      if (!surfaceTile.boundingVolumeIsFromMesh) {
        tileBoundingRegion._orientedBoundingBox = OrientedBoundingBox.clone(
          mesh.orientedBoundingBox,
          tileBoundingRegion._orientedBoundingBox,
        );
        tileBoundingRegion._boundingSphere = BoundingSphere.clone(
          mesh.boundingSphere3D,
          tileBoundingRegion._boundingSphere,
        );
        surfaceTile.occludeePointInScaledSpace = Cartesian3.clone(
          mesh.occludeePointInScaledSpace,
          surfaceTile.occludeePointInScaledSpace,
        );

        if (!defined(surfaceTile.occludeePointInScaledSpace)) {
          surfaceTile.occludeePointInScaledSpace = computeOccludeePoint(
            tileProvider,
            tileBoundingRegion._orientedBoundingBox.center,
            tile.rectangle,
            tileBoundingRegion.minimumHeight,
            tileBoundingRegion.maximumHeight,
            surfaceTile.occludeePointInScaledSpace,
          );
        }
      }
    } else {
      const needsBounds =
        tileBoundingRegion._orientedBoundingBox === undefined ||
        tileBoundingRegion._boundingSphere === undefined;
      const heightChanged =
        tileBoundingRegion.minimumHeight !== oldMinimumHeight ||
        tileBoundingRegion.maximumHeight !== oldMaximumHeight;
      if (heightChanged || needsBounds) {
        tileBoundingRegion.computeBoundingVolumes(ellipsoid);
        surfaceTile.occludeePointInScaledSpace = computeOccludeePoint(
          tileProvider,
          tileBoundingRegion._orientedBoundingBox.center,
          tile.rectangle,
          tileBoundingRegion.minimumHeight,
          tileBoundingRegion.maximumHeight,
          surfaceTile.occludeePointInScaledSpace,
        );
      }
    }
    surfaceTile.boundingVolumeSourceTile = sourceTile;
    surfaceTile.boundingVolumeIsFromMesh = hasBoundingVolumesFromMesh;
  } else {
    surfaceTile.boundingVolumeSourceTile = undefined;
    surfaceTile.boundingVolumeIsFromMesh = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Uniform map creation
// ═══════════════════════════════════════════════════════════════════════════

function createTileUniformMap(frameState, globeSurfaceTileProvider) {
  const uniformMap = {
    u_initialColor: function () {
      return this.properties.initialColor;
    },
    u_fillHighlightColor: function () {
      return this.properties.fillHighlightColor;
    },
    u_zoomedOutOceanSpecularIntensity: function () {
      return this.properties.zoomedOutOceanSpecularIntensity;
    },
    u_oceanNormalMap: function () {
      return this.properties.oceanNormalMap;
    },
    u_atmosphereLightIntensity: function () {
      return this.properties.atmosphereLightIntensity;
    },
    u_atmosphereRayleighCoefficient: function () {
      return this.properties.atmosphereRayleighCoefficient;
    },
    u_atmosphereMieCoefficient: function () {
      return this.properties.atmosphereMieCoefficient;
    },
    u_atmosphereRayleighScaleHeight: function () {
      return this.properties.atmosphereRayleighScaleHeight;
    },
    u_atmosphereMieScaleHeight: function () {
      return this.properties.atmosphereMieScaleHeight;
    },
    u_atmosphereMieAnisotropy: function () {
      return this.properties.atmosphereMieAnisotropy;
    },
    u_lightingFadeDistance: function () {
      return this.properties.lightingFadeDistance;
    },
    u_nightFadeDistance: function () {
      return this.properties.nightFadeDistance;
    },
    u_center3D: function () {
      return this.properties.center3D;
    },
    u_verticalExaggerationAndRelativeHeight: function () {
      return this.properties.verticalExaggerationAndRelativeHeight;
    },
    u_tileRectangle: function () {
      return this.properties.tileRectangle;
    },
    u_modifiedModelView: function () {
      const viewMatrix = frameState.context.uniformState.view;
      const centerEye = Matrix4.multiplyByPoint(
        viewMatrix,
        this.properties.rtc,
        centerEyeScratch,
      );
      Matrix4.setTranslation(viewMatrix, centerEye, modifiedModelViewScratch);
      return modifiedModelViewScratch;
    },
    u_modifiedModelViewProjection: function () {
      const viewMatrix = frameState.context.uniformState.view;
      const projectionMatrix = frameState.context.uniformState.projection;
      const centerEye = Matrix4.multiplyByPoint(
        viewMatrix,
        this.properties.rtc,
        centerEyeScratch,
      );
      Matrix4.setTranslation(
        viewMatrix,
        centerEye,
        modifiedModelViewProjectionScratch,
      );
      Matrix4.multiply(
        projectionMatrix,
        modifiedModelViewProjectionScratch,
        modifiedModelViewProjectionScratch,
      );
      return modifiedModelViewProjectionScratch;
    },
    u_dayTextures: function () {
      return this.properties.dayTextures;
    },
    u_dayTextureTranslationAndScale: function () {
      return this.properties.dayTextureTranslationAndScale;
    },
    u_dayTextureTexCoordsRectangle: function () {
      return this.properties.dayTextureTexCoordsRectangle;
    },
    u_dayTextureUseWebMercatorT: function () {
      return this.properties.dayTextureUseWebMercatorT;
    },
    u_dayTextureAlpha: function () {
      return this.properties.dayTextureAlpha;
    },
    u_dayTextureNightAlpha: function () {
      return this.properties.dayTextureNightAlpha;
    },
    u_dayTextureDayAlpha: function () {
      return this.properties.dayTextureDayAlpha;
    },
    u_dayTextureBrightness: function () {
      return this.properties.dayTextureBrightness;
    },
    u_dayTextureContrast: function () {
      return this.properties.dayTextureContrast;
    },
    u_dayTextureHue: function () {
      return this.properties.dayTextureHue;
    },
    u_dayTextureSaturation: function () {
      return this.properties.dayTextureSaturation;
    },
    u_dayTextureOneOverGamma: function () {
      return this.properties.dayTextureOneOverGamma;
    },
    u_dayIntensity: function () {
      return this.properties.dayIntensity;
    },
    u_southAndNorthLatitude: function () {
      return this.properties.southAndNorthLatitude;
    },
    u_southMercatorYAndOneOverHeight: function () {
      return this.properties.southMercatorYAndOneOverHeight;
    },
    u_waterMask: function () {
      return this.properties.waterMask;
    },
    u_waterMaskTranslationAndScale: function () {
      return this.properties.waterMaskTranslationAndScale;
    },
    u_minMaxHeight: function () {
      return this.properties.minMaxHeight;
    },
    u_scaleAndBias: function () {
      return this.properties.scaleAndBias;
    },
    u_dayTextureSplit: function () {
      return this.properties.dayTextureSplit;
    },
    u_dayTextureCutoutRectangles: function () {
      return this.properties.dayTextureCutoutRectangles;
    },
    u_clippingPlanes: function () {
      const clippingPlanes = globeSurfaceTileProvider._clippingPlanes;
      if (defined(clippingPlanes) && defined(clippingPlanes.texture)) {
        return clippingPlanes.texture;
      }
      return frameState.context.defaultTexture;
    },
    u_cartographicLimitRectangle: function () {
      return this.properties.localizedCartographicLimitRectangle;
    },
    u_clippingPlanesMatrix: function () {
      const clippingPlanes = globeSurfaceTileProvider._clippingPlanes;
      const transform = defined(clippingPlanes)
        ? Matrix4.multiply(
            frameState.context.uniformState.view,
            clippingPlanes.modelMatrix,
            scratchClippingPlanesMatrix,
          )
        : Matrix4.IDENTITY;

      return Matrix4.inverseTranspose(
        transform,
        scratchInverseTransposeClippingPlanesMatrix,
      );
    },
    u_clippingPlanesEdgeStyle: function () {
      const style = this.properties.clippingPlanesEdgeColor;
      style.alpha = this.properties.clippingPlanesEdgeWidth;
      return style;
    },
    u_clippingDistance: function () {
      const texture =
        globeSurfaceTileProvider._clippingPolygons.clippingTexture;
      if (defined(texture)) {
        return texture;
      }
      return frameState.context.defaultTexture;
    },
    u_clippingExtents: function () {
      const texture = globeSurfaceTileProvider._clippingPolygons.extentsTexture;
      if (defined(texture)) {
        return texture;
      }
      return frameState.context.defaultTexture;
    },
    u_minimumBrightness: function () {
      return frameState.fog.minimumBrightness;
    },
    u_hsbShift: function () {
      return this.properties.hsbShift;
    },
    u_colorsToAlpha: function () {
      return this.properties.colorsToAlpha;
    },
    u_frontFaceAlphaByDistance: function () {
      return this.properties.frontFaceAlphaByDistance;
    },
    u_backFaceAlphaByDistance: function () {
      return this.properties.backFaceAlphaByDistance;
    },
    u_translucencyRectangle: function () {
      return this.properties.localizedTranslucencyRectangle;
    },
    u_undergroundColor: function () {
      return this.properties.undergroundColor;
    },
    u_undergroundColorAlphaByDistance: function () {
      return this.properties.undergroundColorAlphaByDistance;
    },
    u_lambertDiffuseMultiplier: function () {
      return this.properties.lambertDiffuseMultiplier;
    },
    u_vertexShadowDarkness: function () {
      return this.properties.vertexShadowDarkness;
    },

    properties: {
      initialColor: new Cartesian4(0.0, 0.0, 0.5, 1.0),
      fillHighlightColor: new Color(0.0, 0.0, 0.0, 0.0),
      zoomedOutOceanSpecularIntensity: 0.5,
      oceanNormalMap: undefined,
      lightingFadeDistance: new Cartesian2(6500000.0, 9000000.0),
      nightFadeDistance: new Cartesian2(10000000.0, 40000000.0),
      atmosphereLightIntensity: 10.0,
      atmosphereRayleighCoefficient: new Cartesian3(5.5e-6, 13.0e-6, 28.4e-6),
      atmosphereMieCoefficient: new Cartesian3(21e-6, 21e-6, 21e-6),
      atmosphereRayleighScaleHeight: 10000.0,
      atmosphereMieScaleHeight: 3200.0,
      atmosphereMieAnisotropy: 0.9,
      hsbShift: new Cartesian3(),
      center3D: undefined,
      rtc: new Cartesian3(),
      modifiedModelView: new Matrix4(),
      tileRectangle: new Cartesian4(),
      verticalExaggerationAndRelativeHeight: new Cartesian2(1.0, 0.0),
      dayTextures: [],
      dayTextureTranslationAndScale: [],
      dayTextureTexCoordsRectangle: [],
      dayTextureUseWebMercatorT: [],
      dayTextureAlpha: [],
      dayTextureNightAlpha: [],
      dayTextureDayAlpha: [],
      dayTextureBrightness: [],
      dayTextureContrast: [],
      dayTextureHue: [],
      dayTextureSaturation: [],
      dayTextureOneOverGamma: [],
      dayTextureSplit: [],
      dayTextureCutoutRectangles: [],
      dayIntensity: 0.0,
      colorsToAlpha: [],
      southAndNorthLatitude: new Cartesian2(),
      southMercatorYAndOneOverHeight: new Cartesian2(),
      waterMask: undefined,
      waterMaskTranslationAndScale: new Cartesian4(),
      minMaxHeight: new Cartesian2(),
      scaleAndBias: new Matrix4(),
      clippingPlanesEdgeColor: Color.clone(Color.WHITE),
      clippingPlanesEdgeWidth: 0.0,
      localizedCartographicLimitRectangle: new Cartesian4(),
      frontFaceAlphaByDistance: new Cartesian4(),
      backFaceAlphaByDistance: new Cartesian4(),
      localizedTranslucencyRectangle: new Cartesian4(),
      undergroundColor: Color.clone(Color.TRANSPARENT),
      undergroundColorAlphaByDistance: new Cartesian4(),
      lambertDiffuseMultiplier: 0.0,
      vertexShadowDarkness: 0.0,
    },
  };

  if (defined(globeSurfaceTileProvider.materialUniformMap)) {
    return combine(uniformMap, globeSurfaceTileProvider.materialUniformMap);
  }

  return uniformMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wireframe & debug
// ═══════════════════════════════════════════════════════════════════════════

function createWireframeVertexArrayIfNecessary(context, provider, tile) {
  const surfaceTile = tile.data;

  let mesh;
  let vertexArray;

  if (defined(surfaceTile.vertexArray)) {
    mesh = surfaceTile.mesh;
    vertexArray = surfaceTile.vertexArray;
  } else if (
    defined(surfaceTile.fill) &&
    defined(surfaceTile.fill.vertexArray)
  ) {
    mesh = surfaceTile.fill.mesh;
    vertexArray = surfaceTile.fill.vertexArray;
  }

  if (!defined(mesh) || !defined(vertexArray)) {
    return;
  }

  if (defined(surfaceTile.wireframeVertexArray)) {
    if (surfaceTile.wireframeVertexArray.mesh === mesh) {
      return;
    }

    surfaceTile.wireframeVertexArray.destroy();
    surfaceTile.wireframeVertexArray = undefined;
  }

  surfaceTile.wireframeVertexArray = createWireframeVertexArray(
    context,
    vertexArray,
    mesh,
  );
  surfaceTile.wireframeVertexArray.mesh = mesh;
}

function createWireframeVertexArray(context, vertexArray, terrainMesh) {
  const indices = terrainMesh.indices;

  const geometry = {
    indices: indices,
    primitiveType: PrimitiveType.TRIANGLES,
  };

  GeometryPipeline.toWireframe(geometry);

  const wireframeIndices = geometry.indices;
  const wireframeIndexBuffer = Buffer.createIndexBuffer({
    context: context,
    typedArray: wireframeIndices,
    usage: BufferUsage.STATIC_DRAW,
    indexDatatype: IndexDatatype.fromSizeInBytes(
      wireframeIndices.BYTES_PER_ELEMENT,
    ),
  });
  return new VertexArray({
    context: context,
    attributes: vertexArray._attributes,
    indexBuffer: wireframeIndexBuffer,
  });
}

let getDebugOrientedBoundingBox;
let getDebugBoundingSphere;
let debugDestroyPrimitive;

(function () {
  const instanceOBB = new GeometryInstance({
    geometry: BoxOutlineGeometry.fromDimensions({
      dimensions: new Cartesian3(2.0, 2.0, 2.0),
    }),
  });
  const instanceSphere = new GeometryInstance({
    geometry: new SphereOutlineGeometry({ radius: 1.0 }),
  });
  let modelMatrix = new Matrix4();
  let previousVolume;
  let primitive;

  function createDebugPrimitive(instance) {
    return new Primitive({
      geometryInstances: instance,
      appearance: new PerInstanceColorAppearance({
        translucent: false,
        flat: true,
      }),
      asynchronous: false,
    });
  }

  getDebugOrientedBoundingBox = function (obb, color) {
    if (obb === previousVolume) {
      return primitive;
    }
    debugDestroyPrimitive();

    previousVolume = obb;
    modelMatrix = Matrix4.fromRotationTranslation(
      obb.halfAxes,
      obb.center,
      modelMatrix,
    );

    instanceOBB.modelMatrix = modelMatrix;
    instanceOBB.attributes.color =
      ColorGeometryInstanceAttribute.fromColor(color);

    primitive = createDebugPrimitive(instanceOBB);
    return primitive;
  };

  getDebugBoundingSphere = function (sphere, color) {
    if (sphere === previousVolume) {
      return primitive;
    }
    debugDestroyPrimitive();

    previousVolume = sphere;
    modelMatrix = Matrix4.fromTranslation(sphere.center, modelMatrix);
    modelMatrix = Matrix4.multiplyByUniformScale(
      modelMatrix,
      sphere.radius,
      modelMatrix,
    );

    instanceSphere.modelMatrix = modelMatrix;
    instanceSphere.attributes.color =
      ColorGeometryInstanceAttribute.fromColor(color);

    primitive = createDebugPrimitive(instanceSphere);
    return primitive;
  };

  debugDestroyPrimitive = function () {
    if (defined(primitive)) {
      primitive.destroy();
      primitive = undefined;
      previousVolume = undefined;
    }
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// WebGPU Globe Terrain Rendering
// ═══════════════════════════════════════════════════════════════════════════

// Per-device globe renderer cache (supports multi-context / split-screen)
const _webgpuGlobeRenderers = new WeakMap();

let _webgpuTileDiagCount = 0;
function addWebGPUDrawCommandsForTile(tileProvider, tile, frameState, fr) {
  const surfaceTile = tile.data;
  const shouldLog = _webgpuTileDiagCount < 5;

  // Create fill mesh for tiles without loaded terrain (mirrors WebGL path).
  // WebGPU reads fill.mesh.vertices/indices directly — no WebGL VA needed.
  if (!defined(surfaceTile.mesh) && !defined(surfaceTile.vertexArray)) {
    if (surfaceTile.fill === undefined) {
      surfaceTile.fill = new TerrainFillMesh(tile);
    }
    surfaceTile.fill.update(tileProvider, frameState);
  }

  const mesh = surfaceTile.renderedMesh || surfaceTile.mesh;
  if (!mesh || !mesh.vertices || !mesh.indices) {
    if (shouldLog) {
      _webgpuTileDiagCount++;
      console.warn(
        `[WebGPU:TileDraw] SKIP — no mesh data. ` +
          `hasSurfaceTile=${!!surfaceTile} ` +
          `hasRenderedMesh=${!!surfaceTile.renderedMesh} ` +
          `hasMesh=${!!surfaceTile.mesh} ` +
          `hasVertexArray=${!!surfaceTile.vertexArray} ` +
          `hasFill=${!!surfaceTile.fill} ` +
          `fillMesh=${!!surfaceTile.fill?.mesh} ` +
          `meshVertices=${!!mesh?.vertices} ` +
          `meshIndices=${!!mesh?.indices} ` +
          `level=${tile.level}`,
      );
    }
    return;
  }

  const context = frameState.context;
  const device = context.device;
  if (!device) {
    if (shouldLog) {
      _webgpuTileDiagCount++;
      console.warn("[WebGPU:TileDraw] SKIP — no device");
    }
    return;
  }

  // Get shader code from the feature renderer (avoids direct WebGPU imports)
  const shaderCode = fr.getShaderCode ? fr.getShaderCode() : undefined;
  if (!shaderCode || shaderCode.length === 0) {
    if (shouldLog) {
      _webgpuTileDiagCount++;
      console.warn(
        `[WebGPU:TileDraw] SKIP — no shader code. ` +
          `hasGetShaderCode=${typeof fr.getShaderCode} code=${typeof shaderCode} ` +
          `len=${shaderCode?.length}`,
      );
    }
    return;
  }

  if (shouldLog) {
    _webgpuTileDiagCount++;
    console.log(
      `[WebGPU:TileDraw] PROCEEDING — level=${tile.level} ` +
        `meshVerts=${mesh.vertices?.byteLength ?? "?"} ` +
        `meshIdx=${mesh.indices?.length ?? "?"}`,
    );
  }

  // Per-device renderer: avoids device mismatch in multi-context (split-screen)
  let _webgpuGlobeRenderer = _webgpuGlobeRenderers.get(device);
  if (!_webgpuGlobeRenderer || _webgpuGlobeRenderer.isDestroyed()) {
    _webgpuGlobeRenderer = new fr.RendererClass();
    const fmt =
      context.canvasFormat || navigator.gpu.getPreferredCanvasFormat();
    _webgpuGlobeRenderer.initialize(device, shaderCode, fmt);
    _webgpuGlobeRenderers.set(device, _webgpuGlobeRenderer);
  }

  const uniformState = context.uniformState;

  // Wireframe debug mode uses line-list topology pipelines
  const useWireframe = tileProvider._debug && tileProvider._debug.wireframe;
  const cmdDescs = useWireframe
    ? _webgpuGlobeRenderer.createWireframeTileCommands(
        tile,
        surfaceTile,
        tileProvider,
        frameState,
        uniformState,
      )
    : _webgpuGlobeRenderer.createTileCommands(
        tile,
        surfaceTile,
        tileProvider,
        frameState,
        uniformState,
      );
  if (!cmdDescs || cmdDescs.length === 0) {
    // Empty `cmdDescs` from `createTileCommands` is the WebGPU "pipeline
    // still cooking async" signal AND the WebGL "no commands to emit"
    // signal. The wakeup-on-pipeline-ready path is now centralized in
    // `WebGPURenderPipelineCache` → `AsyncResourceMonitor` →
    // `Scene.requestRender()` (see NEW-WEBGPU-PIPELINE-READY-SIGNAL),
    // so this branch no longer needs to push an `afterRender` callback
    // by hand. WebGL paths fall through correctly because there is no
    // async-pipeline class on WebGL — empty here genuinely means
    // "nothing to draw" and re-rendering wouldn't change that.
    return;
  }

  const tileBR = surfaceTile.tileBoundingRegion;
  const globeTranslucencyState = frameState.globeTranslucencyState;
  const isTranslucent =
    globeTranslucencyState && globeTranslucencyState.translucent;

  // Check if we have a translucency feature renderer
  const translucencyFR = isTranslucent
    ? context.getFeatureRenderer(FeatureRendererKey.GLOBE_TRANSLUCENCY)
    : null;

  for (let p = 0; p < cmdDescs.length; p++) {
    const cmdDesc = cmdDescs[p];
    // NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM (Batch 167) — in non-3D scene modes
    // the per-command frustum cull must NOT use the tile's 3D-ECEF bounding
    // volume. `tileBR.boundingSphere` / `.boundingVolume` live in 3D ECEF
    // space (centered ~6.4 Mm from the origin); culling them against the
    // 2D / Columbus PROJECTED frustum rejected EVERY tile at regional zoom
    // (the small frustum's planes are nowhere near the ECEF sphere), so the
    // WebGPU globe rendered blank when zoomed in — it survived only at
    // full-globe zoom where the frustum is huge enough to straddle the sphere
    // by coincidence. The QuadtreePrimitive already performs the
    // authoritative, mode-correct visibility cull when it selects the tiles
    // to render, so dropping the redundant 3D bounding volume here is safe:
    // the tiles drawn are exactly the visible ones. SCENE3D keeps the 3D
    // volume for its per-command cull optimization.
    const non3D = frameState.mode !== SceneMode.SCENE3D;
    const command = {
      pass: Pass.GLOBE,
      owner: tile,
      cull: !non3D,
      enabled: true,
      boundingVolume: non3D
        ? undefined
        : tileBR
          ? tileBR.boundingSphere
          : undefined,
      orientedBoundingBox: non3D
        ? undefined
        : tileBR
          ? tileBR.boundingVolume
          : undefined,
      _pipeline: cmdDesc.pipeline,
      _bindGroups: cmdDesc.bindGroups,
      _vertexBuffer: cmdDesc.vertexBuffer,
      _indexBuffer: cmdDesc.indexBuffer,
      _indexCount: cmdDesc.indexCount,
      _indexFormat: cmdDesc.indexFormat,
      // Shadow-cast tags — routes the command through the right
      // WebGPUShadowMapRenderer variant when the globe casts shadows.
      //
      // Batch 24 — every globe terrain tile now uses an explicit
      // shadow-cast layout:
      //   * quantized tiles (TerrainQuantization.BITS12) → `quantized12`
      //     (BITS12 decode in the cast shader).
      //   * uncompressed tiles, regardless of whether they carry vertex
      //     normals / webMercT / geodetic surface normal (DP-H25) →
      //     `terrainUncompressed` (reads `position3DAndHeight` as vec4
      //     at location 0, stride-aware so the variable post-position
      //     bytes don't misalign the GPU's per-vertex walk).
      //
      // Before Batch 24 uncompressed tiles fell through to the `rte24`
      // variant via stride inference. `rte24` reads two vec3s at
      // offsets 0 and 12 — the first hits `position.xyz` correctly but
      // the second hits `(height, u, v)`, which is tex-coord garbage,
      // not a positionLow. The resulting RTE math produced shadow
      // coordinates unrelated to the actual terrain, so shadows
      // visibly missed the surface. The new `terrainUncompressed`
      // variant fixes that at the source.
      //
      // DP-H25 geodetic-terrain shadow cast — the `__skip_geodetic_terrain`
      // sentinel from Batch 19 is removed: geodetic tiles have their
      // stride reported correctly via `vertexStride` below, and the
      // stride-aware pipeline registry (Batch 24) handles it.
      _shadowCastLayout: cmdDesc.isQuantized
        ? "quantized12"
        : "terrainUncompressed",
      _shadowCastTerrainUB: cmdDesc.shadowCastTerrainUB,
      // Expose the ACTUAL vertex stride so
      // `_getOrCreateCastPipeline(..., overrideStride)` builds a
      // pipeline whose `arrayStride` matches the VB. Quantized tiles
      // use stride 16 (a single compressed vec4); uncompressed tiles
      // use 24 / 28 / 32 / 36 / 40 / 44 depending on hasVertexNormals /
      // hasWebMercatorT / hasGeodeticSurfaceNormals — Batch 19's
      // TileGPUResources.strideBytes already captures the right value.
      vertexStride: cmdDesc.isQuantized ? 16 : (cmdDesc.strideBytes ?? 24),
      execute: function (renderPass) {
        renderPass.setPipeline(this._pipeline);
        for (let i = 0; i < this._bindGroups.length; i++) {
          renderPass.setBindGroup(i, this._bindGroups[i]);
        }
        renderPass.setVertexBuffer(0, this._vertexBuffer);
        renderPass.setIndexBuffer(this._indexBuffer, this._indexFormat);
        renderPass.drawIndexed(this._indexCount);
      },
    };

    // Globe translucency: create derived commands for translucent globe
    if (translucencyFR && translucencyFR.updateDerivedCommands) {
      translucencyFR.updateDerivedCommands(
        globeTranslucencyState,
        command,
        frameState,
      );
    }

    frameState.commandList.push(command);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main draw command creation
// ═══════════════════════════════════════════════════════════════════════════

function addDrawCommandsForTile(tileProvider, tile, frameState) {
  const surfaceTile = tile.data;

  // Backend-specific rendering path
  const context = frameState.context;
  const fr = context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE);
  if (fr) {
    addWebGPUDrawCommandsForTile(tileProvider, tile, frameState, fr);
    return;
  }

  if (!defined(surfaceTile.vertexArray)) {
    if (surfaceTile.fill === undefined) {
      surfaceTile.fill = new TerrainFillMesh(tile);
    }
    surfaceTile.fill.update(tileProvider, frameState);
  }

  const creditDisplay = frameState.creditDisplay;

  const terrainData = surfaceTile.terrainData;
  if (defined(terrainData) && defined(terrainData.credits)) {
    const tileCredits = terrainData.credits;
    for (
      let tileCreditIndex = 0, tileCreditLength = tileCredits.length;
      tileCreditIndex < tileCreditLength;
      ++tileCreditIndex
    ) {
      creditDisplay.addCreditToNextFrame(tileCredits[tileCreditIndex]);
    }
  }

  let maxTextures = ContextLimits.maximumTextureImageUnits;

  let waterMaskTexture = surfaceTile.waterMaskTexture;
  let waterMaskTranslationAndScale = surfaceTile.waterMaskTranslationAndScale;
  if (!defined(waterMaskTexture) && defined(surfaceTile.fill)) {
    waterMaskTexture = surfaceTile.fill.waterMaskTexture;
    waterMaskTranslationAndScale =
      surfaceTile.fill.waterMaskTranslationAndScale;
  }

  const cameraUnderground = frameState.cameraUnderground;

  const globeTranslucencyState = frameState.globeTranslucencyState;
  const translucent = globeTranslucencyState.translucent;
  const frontFaceAlphaByDistance =
    globeTranslucencyState.frontFaceAlphaByDistance;
  const backFaceAlphaByDistance =
    globeTranslucencyState.backFaceAlphaByDistance;
  const translucencyRectangle = globeTranslucencyState.rectangle;

  const undergroundColor =
    tileProvider.undergroundColor ?? defaultUndergroundColor;
  const undergroundColorAlphaByDistance =
    tileProvider.undergroundColorAlphaByDistance ??
    defaultUndergroundColorAlphaByDistance;
  const showUndergroundColor =
    isUndergroundVisible(tileProvider, frameState) &&
    frameState.mode === SceneMode.SCENE3D &&
    undergroundColor.alpha > 0.0 &&
    (undergroundColorAlphaByDistance.nearValue > 0.0 ||
      undergroundColorAlphaByDistance.farValue > 0.0);

  const lambertDiffuseMultiplier = tileProvider.lambertDiffuseMultiplier;
  const vertexShadowDarkness = tileProvider.vertexShadowDarkness;

  const hasWaterMask = tileProvider.hasWaterMask && defined(waterMaskTexture);
  const showReflectiveOcean = hasWaterMask && tileProvider.showWaterEffect;
  const oceanNormalMap = tileProvider.oceanNormalMap;
  const showOceanWaves = showReflectiveOcean && defined(oceanNormalMap);
  const terrainProvider = tileProvider.terrainProvider;
  const hasVertexNormals =
    defined(terrainProvider) && tileProvider.terrainProvider.hasVertexNormals;
  const enableFog =
    frameState.fog.enabled && frameState.fog.renderable && !cameraUnderground;
  const showGroundAtmosphere =
    tileProvider.showGroundAtmosphere && frameState.mode === SceneMode.SCENE3D;
  const castShadows =
    ShadowMode.castShadows(tileProvider.shadows) && !translucent;
  const receiveShadows =
    ShadowMode.receiveShadows(tileProvider.shadows) && !translucent;

  const hueShift = tileProvider.hueShift;
  const saturationShift = tileProvider.saturationShift;
  const brightnessShift = tileProvider.brightnessShift;

  let colorCorrect = !(
    CesiumMath.equalsEpsilon(hueShift, 0.0, CesiumMath.EPSILON7) &&
    CesiumMath.equalsEpsilon(saturationShift, 0.0, CesiumMath.EPSILON7) &&
    CesiumMath.equalsEpsilon(brightnessShift, 0.0, CesiumMath.EPSILON7)
  );

  let perFragmentGroundAtmosphere = false;
  if (showGroundAtmosphere) {
    const cameraDistance = Cartesian3.magnitude(frameState.camera.positionWC);
    const fadeOutDistance = tileProvider.nightFadeOutDistance;
    perFragmentGroundAtmosphere = cameraDistance > fadeOutDistance;
  }

  if (hasWaterMask) {
    --maxTextures;
  }
  if (showOceanWaves) {
    --maxTextures;
  }
  if (
    defined(frameState.shadowState) &&
    frameState.shadowState.shadowsEnabled
  ) {
    --maxTextures;
  }
  if (
    defined(tileProvider.clippingPlanes) &&
    tileProvider.clippingPlanes.enabled
  ) {
    --maxTextures;
  }
  if (
    defined(tileProvider.clippingPolygons) &&
    tileProvider.clippingPolygons.enabled
  ) {
    --maxTextures;
    --maxTextures;
  }

  maxTextures -= globeTranslucencyState.numberOfTextureUniforms;

  const mesh = surfaceTile.renderedMesh;
  let rtc = mesh.center;
  const encoding = mesh.encoding;
  const tileBoundingRegion = surfaceTile.tileBoundingRegion;

  const exaggeration = frameState.verticalExaggeration;
  const exaggerationRelativeHeight =
    frameState.verticalExaggerationRelativeHeight;
  const hasExaggeration = exaggeration !== 1.0;
  const hasGeodeticSurfaceNormals = encoding.hasGeodeticSurfaceNormals;

  const tileRectangle = tileRectangleScratch;

  let southLatitude = 0.0;
  let northLatitude = 0.0;
  let southMercatorY = 0.0;
  let oneOverMercatorHeight = 0.0;

  let useWebMercatorProjection = false;

  if (frameState.mode !== SceneMode.SCENE3D) {
    const projection = frameState.mapProjection;
    const southwest = projection.project(
      Rectangle.southwest(tile.rectangle),
      southwestScratch,
    );
    const northeast = projection.project(
      Rectangle.northeast(tile.rectangle),
      northeastScratch,
    );

    tileRectangle.x = southwest.x;
    tileRectangle.y = southwest.y;
    tileRectangle.z = northeast.x;
    tileRectangle.w = northeast.y;

    if (frameState.mode !== SceneMode.MORPHING) {
      rtc = rtcScratch;
      rtc.x = 0.0;
      rtc.y = (tileRectangle.z + tileRectangle.x) * 0.5;
      rtc.z = (tileRectangle.w + tileRectangle.y) * 0.5;
      tileRectangle.x -= rtc.y;
      tileRectangle.y -= rtc.z;
      tileRectangle.z -= rtc.y;
      tileRectangle.w -= rtc.z;
    }

    if (
      frameState.mode === SceneMode.SCENE2D &&
      encoding.quantization === TerrainQuantization.BITS12
    ) {
      const epsilon = (1.0 / (Math.pow(2.0, 12.0) - 1.0)) * 0.5;
      const widthEpsilon = (tileRectangle.z - tileRectangle.x) * epsilon;
      const heightEpsilon = (tileRectangle.w - tileRectangle.y) * epsilon;
      tileRectangle.x -= widthEpsilon;
      tileRectangle.y -= heightEpsilon;
      tileRectangle.z += widthEpsilon;
      tileRectangle.w += heightEpsilon;
    }

    if (projection instanceof WebMercatorProjection) {
      southLatitude = tile.rectangle.south;
      northLatitude = tile.rectangle.north;

      southMercatorY =
        WebMercatorProjection.geodeticLatitudeToMercatorAngle(southLatitude);

      oneOverMercatorHeight =
        1.0 /
        (WebMercatorProjection.geodeticLatitudeToMercatorAngle(northLatitude) -
          southMercatorY);

      useWebMercatorProjection = true;
    }
  }

  const surfaceShaderSetOptions = surfaceShaderSetOptionsScratch;
  surfaceShaderSetOptions.frameState = frameState;
  surfaceShaderSetOptions.surfaceTile = surfaceTile;
  surfaceShaderSetOptions.hasWaterMask = hasWaterMask;
  surfaceShaderSetOptions.showReflectiveOcean = showReflectiveOcean;
  surfaceShaderSetOptions.showOceanWaves = showOceanWaves;
  surfaceShaderSetOptions.enableLighting = tileProvider.enableLighting;
  surfaceShaderSetOptions.dynamicAtmosphereLighting =
    tileProvider.dynamicAtmosphereLighting;
  surfaceShaderSetOptions.dynamicAtmosphereLightingFromSun =
    tileProvider.dynamicAtmosphereLightingFromSun;
  surfaceShaderSetOptions.showGroundAtmosphere = showGroundAtmosphere;
  surfaceShaderSetOptions.atmosphereLightIntensity =
    tileProvider.atmosphereLightIntensity;
  surfaceShaderSetOptions.atmosphereRayleighCoefficient =
    tileProvider.atmosphereRayleighCoefficient;
  surfaceShaderSetOptions.atmosphereMieCoefficient =
    tileProvider.atmosphereMieCoefficient;
  surfaceShaderSetOptions.atmosphereRayleighScaleHeight =
    tileProvider.atmosphereRayleighScaleHeight;
  surfaceShaderSetOptions.atmosphereMieScaleHeight =
    tileProvider.atmosphereMieScaleHeight;
  surfaceShaderSetOptions.atmosphereMieAnisotropy =
    tileProvider.atmosphereMieAnisotropy;
  surfaceShaderSetOptions.perFragmentGroundAtmosphere =
    perFragmentGroundAtmosphere;
  surfaceShaderSetOptions.hasVertexNormals = hasVertexNormals;
  surfaceShaderSetOptions.useWebMercatorProjection = useWebMercatorProjection;
  surfaceShaderSetOptions.clippedByBoundaries = surfaceTile.clippedByBoundaries;
  surfaceShaderSetOptions.hasGeodeticSurfaceNormals = hasGeodeticSurfaceNormals;
  surfaceShaderSetOptions.hasExaggeration = hasExaggeration;

  const tileImageryCollection = surfaceTile.imagery;
  let imageryIndex = 0;
  const imageryLen = tileImageryCollection.length;

  const showSkirts =
    tileProvider.showSkirts && !cameraUnderground && !translucent;
  const backFaceCulling =
    tileProvider.backFaceCulling && !cameraUnderground && !translucent;
  const firstPassRenderState = backFaceCulling
    ? tileProvider._renderState
    : tileProvider._disableCullingRenderState;
  const otherPassesRenderState = backFaceCulling
    ? tileProvider._blendRenderState
    : tileProvider._disableCullingBlendRenderState;
  let renderState = firstPassRenderState;

  let initialColor = tileProvider._firstPassInitialColor;

  if (!defined(tileProvider._debug.boundingSphereTile)) {
    debugDestroyPrimitive();
  }

  const materialUniformMapChanged =
    tileProvider._materialUniformMap !== tileProvider.materialUniformMap;
  if (materialUniformMapChanged) {
    tileProvider._materialUniformMap = tileProvider.materialUniformMap;
    const drawCommandsLength = tileProvider._drawCommands.length;
    for (let i = 0; i < drawCommandsLength; ++i) {
      tileProvider._uniformMaps[i] = createTileUniformMap(
        frameState,
        tileProvider,
      );
    }
  }

  do {
    let numberOfDayTextures = 0;

    let command;
    let uniformMap;

    if (tileProvider._drawCommands.length <= tileProvider._usedDrawCommands) {
      command = new DrawCommand();
      command.owner = tile;
      command.cull = false;
      command.boundingVolume = new BoundingSphere();
      command.orientedBoundingBox = undefined;

      uniformMap = createTileUniformMap(frameState, tileProvider);

      tileProvider._drawCommands.push(command);
      tileProvider._uniformMaps.push(uniformMap);
    } else {
      command = tileProvider._drawCommands[tileProvider._usedDrawCommands];
      uniformMap = tileProvider._uniformMaps[tileProvider._usedDrawCommands];
    }

    command.owner = tile;

    ++tileProvider._usedDrawCommands;

    if (tile === tileProvider._debug.boundingSphereTile) {
      const obb = tileBoundingRegion.boundingVolume;
      const boundingSphere = tileBoundingRegion.boundingSphere;
      if (defined(obb)) {
        getDebugOrientedBoundingBox(obb, Color.RED).update(frameState);
      } else if (defined(boundingSphere)) {
        getDebugBoundingSphere(boundingSphere, Color.RED).update(frameState);
      }
    }

    const uniformMapProperties = uniformMap.properties;
    Cartesian4.clone(initialColor, uniformMapProperties.initialColor);
    uniformMapProperties.oceanNormalMap = oceanNormalMap;
    uniformMapProperties.lightingFadeDistance.x =
      tileProvider.lightingFadeOutDistance;
    uniformMapProperties.lightingFadeDistance.y =
      tileProvider.lightingFadeInDistance;
    uniformMapProperties.nightFadeDistance.x =
      tileProvider.nightFadeOutDistance;
    uniformMapProperties.nightFadeDistance.y = tileProvider.nightFadeInDistance;
    uniformMapProperties.atmosphereLightIntensity =
      tileProvider.atmosphereLightIntensity;
    uniformMapProperties.atmosphereRayleighCoefficient =
      tileProvider.atmosphereRayleighCoefficient;
    uniformMapProperties.atmosphereMieCoefficient =
      tileProvider.atmosphereMieCoefficient;
    uniformMapProperties.atmosphereRayleighScaleHeight =
      tileProvider.atmosphereRayleighScaleHeight;
    uniformMapProperties.atmosphereMieScaleHeight =
      tileProvider.atmosphereMieScaleHeight;
    uniformMapProperties.atmosphereMieAnisotropy =
      tileProvider.atmosphereMieAnisotropy;
    uniformMapProperties.zoomedOutOceanSpecularIntensity =
      tileProvider.zoomedOutOceanSpecularIntensity;

    const frontFaceAlphaByDistanceFinal = cameraUnderground
      ? backFaceAlphaByDistance
      : frontFaceAlphaByDistance;
    const backFaceAlphaByDistanceFinal = cameraUnderground
      ? frontFaceAlphaByDistance
      : backFaceAlphaByDistance;

    if (defined(frontFaceAlphaByDistanceFinal)) {
      Cartesian4.fromElements(
        frontFaceAlphaByDistanceFinal.near,
        frontFaceAlphaByDistanceFinal.nearValue,
        frontFaceAlphaByDistanceFinal.far,
        frontFaceAlphaByDistanceFinal.farValue,
        uniformMapProperties.frontFaceAlphaByDistance,
      );
      Cartesian4.fromElements(
        backFaceAlphaByDistanceFinal.near,
        backFaceAlphaByDistanceFinal.nearValue,
        backFaceAlphaByDistanceFinal.far,
        backFaceAlphaByDistanceFinal.farValue,
        uniformMapProperties.backFaceAlphaByDistance,
      );
    }

    Cartesian4.fromElements(
      undergroundColorAlphaByDistance.near,
      undergroundColorAlphaByDistance.nearValue,
      undergroundColorAlphaByDistance.far,
      undergroundColorAlphaByDistance.farValue,
      uniformMapProperties.undergroundColorAlphaByDistance,
    );
    Color.clone(undergroundColor, uniformMapProperties.undergroundColor);

    uniformMapProperties.lambertDiffuseMultiplier = lambertDiffuseMultiplier;
    uniformMapProperties.vertexShadowDarkness = vertexShadowDarkness;

    const highlightFillTile =
      !defined(surfaceTile.vertexArray) &&
      defined(tileProvider.fillHighlightColor) &&
      tileProvider.fillHighlightColor.alpha > 0.0;
    if (highlightFillTile) {
      Color.clone(
        tileProvider.fillHighlightColor,
        uniformMapProperties.fillHighlightColor,
      );
    }

    uniformMapProperties.verticalExaggerationAndRelativeHeight.x = exaggeration;
    uniformMapProperties.verticalExaggerationAndRelativeHeight.y =
      exaggerationRelativeHeight;

    uniformMapProperties.center3D = mesh.center;
    Cartesian3.clone(rtc, uniformMapProperties.rtc);

    Cartesian4.clone(tileRectangle, uniformMapProperties.tileRectangle);
    uniformMapProperties.southAndNorthLatitude.x = southLatitude;
    uniformMapProperties.southAndNorthLatitude.y = northLatitude;
    uniformMapProperties.southMercatorYAndOneOverHeight.x = southMercatorY;
    uniformMapProperties.southMercatorYAndOneOverHeight.y =
      oneOverMercatorHeight;

    const localizedCartographicLimitRectangle =
      localizedCartographicLimitRectangleScratch;
    const cartographicLimitRectangle = clipRectangleAntimeridian(
      tile.rectangle,
      tileProvider.cartographicLimitRectangle,
    );

    const localizedTranslucencyRectangle =
      localizedTranslucencyRectangleScratch;
    const clippedTranslucencyRectangle = clipRectangleAntimeridian(
      tile.rectangle,
      translucencyRectangle,
    );

    Cartesian3.fromElements(
      hueShift,
      saturationShift,
      brightnessShift,
      uniformMapProperties.hsbShift,
    );

    const cartographicTileRectangle = tile.rectangle;
    const inverseTileWidth = 1.0 / cartographicTileRectangle.width;
    const inverseTileHeight = 1.0 / cartographicTileRectangle.height;
    localizedCartographicLimitRectangle.x =
      (cartographicLimitRectangle.west - cartographicTileRectangle.west) *
      inverseTileWidth;
    localizedCartographicLimitRectangle.y =
      (cartographicLimitRectangle.south - cartographicTileRectangle.south) *
      inverseTileHeight;
    localizedCartographicLimitRectangle.z =
      (cartographicLimitRectangle.east - cartographicTileRectangle.west) *
      inverseTileWidth;
    localizedCartographicLimitRectangle.w =
      (cartographicLimitRectangle.north - cartographicTileRectangle.south) *
      inverseTileHeight;

    Cartesian4.clone(
      localizedCartographicLimitRectangle,
      uniformMapProperties.localizedCartographicLimitRectangle,
    );

    localizedTranslucencyRectangle.x =
      (clippedTranslucencyRectangle.west - cartographicTileRectangle.west) *
      inverseTileWidth;
    localizedTranslucencyRectangle.y =
      (clippedTranslucencyRectangle.south - cartographicTileRectangle.south) *
      inverseTileHeight;
    localizedTranslucencyRectangle.z =
      (clippedTranslucencyRectangle.east - cartographicTileRectangle.west) *
      inverseTileWidth;
    localizedTranslucencyRectangle.w =
      (clippedTranslucencyRectangle.north - cartographicTileRectangle.south) *
      inverseTileHeight;

    Cartesian4.clone(
      localizedTranslucencyRectangle,
      uniformMapProperties.localizedTranslucencyRectangle,
    );

    const applyFog =
      enableFog &&
      CesiumMath.fog(tile._distance, frameState.fog.density) >
        CesiumMath.EPSILON3;
    colorCorrect = colorCorrect && (applyFog || showGroundAtmosphere);

    let applyBrightness = false;
    let applyContrast = false;
    let applyHue = false;
    let applySaturation = false;
    let applyGamma = false;
    let applyAlpha = false;
    let applyDayNightAlpha = false;
    let applySplit = false;
    let applyCutout = false;
    let applyColorToAlpha = false;

    while (numberOfDayTextures < maxTextures && imageryIndex < imageryLen) {
      const tileImagery = tileImageryCollection[imageryIndex];
      const imagery = tileImagery.readyImagery;
      ++imageryIndex;

      if (!defined(imagery) || imagery.imageryLayer.alpha === 0.0) {
        continue;
      }

      const texture = tileImagery.useWebMercatorT
        ? imagery.textureWebMercator
        : imagery.texture;

      //>>includeStart('debug', pragmas.debug);
      if (!defined(texture)) {
        throw new DeveloperError("readyImagery is not actually ready!");
      }
      //>>includeEnd('debug');

      const imageryLayer = imagery.imageryLayer;

      if (!defined(tileImagery.textureTranslationAndScale)) {
        tileImagery.textureTranslationAndScale =
          imageryLayer._calculateTextureTranslationAndScale(tile, tileImagery);
      }

      uniformMapProperties.dayTextures[numberOfDayTextures] = texture;
      uniformMapProperties.dayTextureTranslationAndScale[numberOfDayTextures] =
        tileImagery.textureTranslationAndScale;
      uniformMapProperties.dayTextureTexCoordsRectangle[numberOfDayTextures] =
        tileImagery.textureCoordinateRectangle;
      uniformMapProperties.dayTextureUseWebMercatorT[numberOfDayTextures] =
        tileImagery.useWebMercatorT;

      uniformMapProperties.dayTextureAlpha[numberOfDayTextures] =
        imageryLayer.alpha;
      applyAlpha =
        applyAlpha ||
        uniformMapProperties.dayTextureAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] =
        imageryLayer.nightAlpha;
      applyDayNightAlpha =
        applyDayNightAlpha ||
        uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureDayAlpha[numberOfDayTextures] =
        imageryLayer.dayAlpha;
      applyDayNightAlpha =
        applyDayNightAlpha ||
        uniformMapProperties.dayTextureDayAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureBrightness[numberOfDayTextures] =
        imageryLayer.brightness;
      applyBrightness =
        applyBrightness ||
        uniformMapProperties.dayTextureBrightness[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_BRIGHTNESS;

      uniformMapProperties.dayTextureContrast[numberOfDayTextures] =
        imageryLayer.contrast;
      applyContrast =
        applyContrast ||
        uniformMapProperties.dayTextureContrast[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_CONTRAST;

      uniformMapProperties.dayTextureHue[numberOfDayTextures] =
        imageryLayer.hue;
      applyHue =
        applyHue ||
        uniformMapProperties.dayTextureHue[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_HUE;

      uniformMapProperties.dayTextureSaturation[numberOfDayTextures] =
        imageryLayer.saturation;
      applySaturation =
        applySaturation ||
        uniformMapProperties.dayTextureSaturation[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_SATURATION;

      uniformMapProperties.dayTextureOneOverGamma[numberOfDayTextures] =
        1.0 / imageryLayer.gamma;
      applyGamma =
        applyGamma ||
        uniformMapProperties.dayTextureOneOverGamma[numberOfDayTextures] !==
          1.0 / ImageryLayer.DEFAULT_GAMMA;

      uniformMapProperties.dayTextureSplit[numberOfDayTextures] =
        imageryLayer.splitDirection;
      applySplit =
        applySplit ||
        uniformMapProperties.dayTextureSplit[numberOfDayTextures] !== 0.0;

      let dayTextureCutoutRectangle =
        uniformMapProperties.dayTextureCutoutRectangles[numberOfDayTextures];
      if (!defined(dayTextureCutoutRectangle)) {
        dayTextureCutoutRectangle =
          uniformMapProperties.dayTextureCutoutRectangles[numberOfDayTextures] =
            new Cartesian4();
      }

      Cartesian4.clone(Cartesian4.ZERO, dayTextureCutoutRectangle);
      if (defined(imageryLayer.cutoutRectangle)) {
        const cutoutRectangle = clipRectangleAntimeridian(
          cartographicTileRectangle,
          imageryLayer.cutoutRectangle,
        );
        const intersection = Rectangle.simpleIntersection(
          cutoutRectangle,
          cartographicTileRectangle,
          rectangleIntersectionScratch,
        );
        applyCutout = defined(intersection) || applyCutout;

        dayTextureCutoutRectangle.x =
          (cutoutRectangle.west - cartographicTileRectangle.west) *
          inverseTileWidth;
        dayTextureCutoutRectangle.y =
          (cutoutRectangle.south - cartographicTileRectangle.south) *
          inverseTileHeight;
        dayTextureCutoutRectangle.z =
          (cutoutRectangle.east - cartographicTileRectangle.west) *
          inverseTileWidth;
        dayTextureCutoutRectangle.w =
          (cutoutRectangle.north - cartographicTileRectangle.south) *
          inverseTileHeight;
      }

      let colorToAlpha =
        uniformMapProperties.colorsToAlpha[numberOfDayTextures];
      if (!defined(colorToAlpha)) {
        colorToAlpha = uniformMapProperties.colorsToAlpha[numberOfDayTextures] =
          new Cartesian4();
      }

      const hasColorToAlpha =
        defined(imageryLayer.colorToAlpha) &&
        imageryLayer.colorToAlphaThreshold > 0.0;
      applyColorToAlpha = applyColorToAlpha || hasColorToAlpha;

      if (hasColorToAlpha) {
        const color = imageryLayer.colorToAlpha;
        colorToAlpha.x = color.red;
        colorToAlpha.y = color.green;
        colorToAlpha.z = color.blue;
        colorToAlpha.w = imageryLayer.colorToAlphaThreshold;
      } else {
        colorToAlpha.w = -1.0;
      }

      if (defined(imagery.credits)) {
        const credits = imagery.credits;
        for (
          let creditIndex = 0, creditLength = credits.length;
          creditIndex < creditLength;
          ++creditIndex
        ) {
          creditDisplay.addCreditToNextFrame(credits[creditIndex]);
        }
      }

      ++numberOfDayTextures;
    }

    uniformMapProperties.dayTextures.length = numberOfDayTextures;
    uniformMapProperties.waterMask = waterMaskTexture;
    Cartesian4.clone(
      waterMaskTranslationAndScale,
      uniformMapProperties.waterMaskTranslationAndScale,
    );

    uniformMapProperties.minMaxHeight.x = encoding.minimumHeight;
    uniformMapProperties.minMaxHeight.y = encoding.maximumHeight;
    Matrix4.clone(encoding.matrix, uniformMapProperties.scaleAndBias);

    const clippingPlanes = tileProvider._clippingPlanes;
    const clippingPlanesEnabled =
      defined(clippingPlanes) && clippingPlanes.enabled && tile.isClipped;
    if (clippingPlanesEnabled) {
      uniformMapProperties.clippingPlanesEdgeColor = Color.clone(
        clippingPlanes.edgeColor,
        uniformMapProperties.clippingPlanesEdgeColor,
      );
      uniformMapProperties.clippingPlanesEdgeWidth = clippingPlanes.edgeWidth;
    }

    const clippingPolygons = tileProvider._clippingPolygons;
    const clippingPolygonsEnabled =
      defined(clippingPolygons) && clippingPolygons.enabled && tile.isClipped;

    surfaceShaderSetOptions.numberOfDayTextures = numberOfDayTextures;
    surfaceShaderSetOptions.applyBrightness = applyBrightness;
    surfaceShaderSetOptions.applyContrast = applyContrast;
    surfaceShaderSetOptions.applyHue = applyHue;
    surfaceShaderSetOptions.applySaturation = applySaturation;
    surfaceShaderSetOptions.applyGamma = applyGamma;
    surfaceShaderSetOptions.applyAlpha = applyAlpha;
    surfaceShaderSetOptions.applyDayNightAlpha = applyDayNightAlpha;
    surfaceShaderSetOptions.applySplit = applySplit;
    surfaceShaderSetOptions.enableFog = applyFog;
    surfaceShaderSetOptions.enableClippingPlanes = clippingPlanesEnabled;
    surfaceShaderSetOptions.clippingPlanes = clippingPlanes;
    surfaceShaderSetOptions.enableClippingPolygons = clippingPolygonsEnabled;
    surfaceShaderSetOptions.clippingPolygons = clippingPolygons;
    surfaceShaderSetOptions.hasImageryLayerCutout = applyCutout;
    surfaceShaderSetOptions.colorCorrect = colorCorrect;
    surfaceShaderSetOptions.highlightFillTile = highlightFillTile;
    surfaceShaderSetOptions.colorToAlpha = applyColorToAlpha;
    surfaceShaderSetOptions.showUndergroundColor = showUndergroundColor;
    surfaceShaderSetOptions.translucent = translucent;

    let count = surfaceTile.renderedMesh.indices.length;
    if (!showSkirts) {
      count = surfaceTile.renderedMesh.indexCountWithoutSkirts;
    }

    command.shaderProgram = tileProvider._surfaceShaderSet.getShaderProgram(
      surfaceShaderSetOptions,
    );
    command.castShadows = castShadows;
    command.receiveShadows = receiveShadows;
    command.renderState = renderState;
    command.primitiveType = PrimitiveType.TRIANGLES;
    command.vertexArray =
      surfaceTile.vertexArray || surfaceTile.fill.vertexArray;
    command.count = count;
    command.uniformMap = uniformMap;
    command.pass = Pass.GLOBE;

    if (tileProvider._debug.wireframe) {
      createWireframeVertexArrayIfNecessary(context, tileProvider, tile);
      if (defined(surfaceTile.wireframeVertexArray)) {
        command.vertexArray = surfaceTile.wireframeVertexArray;
        command.primitiveType = PrimitiveType.LINES;
        command.count = count * 2;
      }
    }

    let boundingVolume = command.boundingVolume;
    const orientedBoundingBox = command.orientedBoundingBox;

    if (frameState.mode !== SceneMode.SCENE3D) {
      BoundingSphere.fromRectangleWithHeights2D(
        tile.rectangle,
        frameState.mapProjection,
        tileBoundingRegion.minimumHeight,
        tileBoundingRegion.maximumHeight,
        boundingVolume,
      );
      Cartesian3.fromElements(
        boundingVolume.center.z,
        boundingVolume.center.x,
        boundingVolume.center.y,
        boundingVolume.center,
      );

      if (frameState.mode === SceneMode.MORPHING) {
        boundingVolume = BoundingSphere.union(
          tileBoundingRegion.boundingSphere,
          boundingVolume,
          boundingVolume,
        );
      }
    } else {
      command.boundingVolume = BoundingSphere.clone(
        tileBoundingRegion.boundingSphere,
        boundingVolume,
      );
      command.orientedBoundingBox = OrientedBoundingBox.clone(
        tileBoundingRegion.boundingVolume,
        orientedBoundingBox,
      );
    }

    command.dirty = true;

    if (translucent) {
      globeTranslucencyState.updateDerivedCommands(command, frameState);
    }

    pushCommand(command, frameState);

    renderState = otherPassesRenderState;
    initialColor = otherPassesInitialColor;
  } while (imageryIndex < imageryLen);
}

// Need a scratch Rectangle for cutout intersection inside addDrawCommandsForTile
const rectangleIntersectionScratch = new Rectangle();
const splitCartographicLimitRectangleScratch = new Rectangle();
const rectangleCenterScratch = new Cartographic();

function clipRectangleAntimeridian(tileRectangle, cartographicLimitRectangle) {
  if (cartographicLimitRectangle.west < cartographicLimitRectangle.east) {
    return cartographicLimitRectangle;
  }
  const splitRectangle = Rectangle.clone(
    cartographicLimitRectangle,
    splitCartographicLimitRectangleScratch,
  );
  const tileCenter = Rectangle.center(tileRectangle, rectangleCenterScratch);
  if (tileCenter.longitude > 0.0) {
    splitRectangle.east = CesiumMath.PI;
  } else {
    splitRectangle.west = -CesiumMath.PI;
  }
  return splitRectangle;
}

export {
  addDrawCommandsForTile,
  updateTileBoundingRegion,
  createTileUniformMap,
  createWireframeVertexArrayIfNecessary,
  debugDestroyPrimitive,
  getDebugOrientedBoundingBox,
  getDebugBoundingSphere,
  pushCommand,
  isUndergroundVisible,
  clipRectangleAntimeridian,
};

// Namespace default export for build system barrel compatibility
const GlobeSurfaceTileProviderRendering = {
  addDrawCommandsForTile,
  updateTileBoundingRegion,
  createTileUniformMap,
  createWireframeVertexArrayIfNecessary,
  debugDestroyPrimitive,
  getDebugOrientedBoundingBox,
  getDebugBoundingSphere,
  pushCommand,
  isUndergroundVisible,
  clipRectangleAntimeridian,
};
export default GlobeSurfaceTileProviderRendering;
