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
import DrawCommand from "../Renderer/DrawCommand.js";
import Pass from "../Renderer/Pass.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import { createEclipseGlobeShadow } from "./EclipseGlobeShadow.js";
import GlobeSurfaceTile from "./GlobeSurfaceTile.js";
import ImageryLayer from "./ImageryLayer.js";
import PerInstanceColorAppearance from "./PerInstanceColorAppearance.js";
import Primitive from "./Primitive.js";
import resolveImageryLayerValue from "./resolveImageryLayerValue.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import TerrainFillMesh from "./TerrainFillMesh.js";
import TileBoundingRegion from "./TileBoundingRegion.js";

// One hoisted `execute` shared by every WebGPU globe tile command, colour and
// pick alike. The body reads only `this.*` fields and closes over nothing, so a
// single module-level function stands in for a per-tile-per-pass
// `execute: function(renderPass){…}` literal, which would allocate one closure
// per command per frame — on the order of 39,000 per frame on a moving-camera
// globe view. Call sites invoke it method-style
// (`command.execute(renderPass)`), so `this` still binds to the command.
function executeWebGPUGlobeTileCommand(renderPass) {
  renderPass.setPipeline(this._pipeline);
  for (let i = 0; i < this._bindGroups.length; i++) {
    // Group 0 carries dynamic offsets (camera + tile + eclipse UB slices in
    // their ring pages); pass them so the bind group resolves to this
    // command's actual UB regions.
    if (i === 0 && this._bindGroup0DynamicOffsets !== undefined) {
      renderPass.setBindGroup(
        0,
        this._bindGroups[0],
        this._bindGroup0DynamicOffsets,
      );
    } else {
      renderPass.setBindGroup(i, this._bindGroups[i]);
    }
  }
  renderPass.setVertexBuffer(0, this._vertexBuffer);
  renderPass.setIndexBuffer(this._indexBuffer, this._indexFormat);
  renderPass.drawIndexed(this._indexCount);
}

/**
 * Apply the backend-agnostic globe shadow contract to a native WebGPU tile
 * command. This deliberately mirrors the WebGL command path: all four
 * ShadowMode values map exactly, and translucent globe commands neither cast
 * nor receive shadows.
 *
 * The cache host is the stable TileGPUResources record supplied by the feature
 * renderer. The command wrapper itself is rebuilt every frame, so caching
 * shadow bind groups on it would pay a createBindGroup miss every frame.
 *
 * @param {object} command Native WebGPU tile command.
 * @param {number} shadowMode Globe ShadowMode.
 * @param {boolean} translucent Whether globe translucency is active.
 * @param {object|undefined} shadowCastBindGroupCacheHost Stable tile resource.
 * @param {GPUPrimitiveTopology} [topology="triangle-list"] Native primitive
 * topology used by the tile command.
 * @param {boolean} [cullEnabled=true] Whether the shadow caster should use
 * WebGL's back-face culling state.
 * @private
 */
function configureWebGPUGlobeShadowCommand(
  command,
  shadowMode,
  translucent,
  shadowCastBindGroupCacheHost,
  topology = "triangle-list",
  cullEnabled = true,
) {
  command.castShadows = !translucent && ShadowMode.castShadows(shadowMode);
  command.receiveShadows =
    !translucent && ShadowMode.receiveShadows(shadowMode);
  command._shadowCastBindGroupCacheHost = shadowCastBindGroupCacheHost;
  command._shadowCastTopology = topology;
  command._shadowCastCullMode = cullEnabled ? "back" : "none";
}

function requestRenderForSceneCapturePublication() {
  return true;
}

/**
 * Publish frame-current globe capture sources without a per-tile object
 * allocation. When publication resumes after startup/recovery/a hidden-globe
 * gap, or selected content changes, request exactly one following frame so the
 * earlier dynamic-environment update can consume the now-current sources.
 *
 * @param {object} context
 * @param {object} globeRenderer
 * @param {object} tileProvider
 * @param {FrameState} frameState
 * @private
 */
function publishWebGPUSceneCaptureSources(
  context,
  globeRenderer,
  tileProvider,
  frameState,
) {
  const frameNumber = frameState.frameNumber;
  const contentRevision = tileProvider._sceneCaptureContentRevision ?? 0;
  let sources = context._webgpuSceneCaptureSources;
  if (
    defined(sources) &&
    Number.isFinite(sources.publicationRevision) &&
    sources.frameNumber === frameNumber &&
    sources.globeRenderer === globeRenderer &&
    sources.tileProvider === tileProvider &&
    sources.contentRevision === contentRevision
  ) {
    return;
  }
  const sourcesWereCurrent =
    defined(sources) &&
    Number.isFinite(sources.publicationRevision) &&
    (sources.frameNumber === frameNumber ||
      sources.frameNumber === frameNumber - 1) &&
    sources.globeRenderer === globeRenderer &&
    sources.tileProvider === tileProvider &&
    sources.contentRevision === contentRevision;

  if (!defined(sources)) {
    sources = {
      publicationRevision: 0,
    };
    context._webgpuSceneCaptureSources = sources;
  }
  if (!sourcesWereCurrent) {
    sources.publicationRevision = (sources.publicationRevision ?? 0) + 1;
  }
  sources.frameNumber = frameNumber;
  sources.globeRenderer = globeRenderer;
  sources.tileProvider = tileProvider;
  sources.contentRevision = contentRevision;

  if (
    !sourcesWereCurrent &&
    !frameState.afterRender.includes(requestRenderForSceneCapturePublication)
  ) {
    frameState.afterRender.push(requestRenderForSceneCapturePublication);
  }
}

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
const groundAtmosphereCompanionMinimumDistanceRatio = 0.75;
const groundAtmosphereCompanionMaximumDistanceRatio = 1.25;

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
  applyNightDarkness: undefined,
  applySplit: undefined,
  showReflectiveOcean: undefined,
  showOceanWaves: undefined,
  enableLighting: undefined,
  dynamicAtmosphereLighting: undefined,
  dynamicAtmosphereLightingFromSun: undefined,
  showGroundAtmosphere: undefined,
  perFragmentGroundAtmosphere: undefined,
  groundAtmosphereCompanionEnabled: undefined,
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
  enableEclipseGlobeShadow: undefined,
};

const scratchClippingPlanesMatrix = new Matrix4();
const scratchInverseTransposeClippingPlanesMatrix = new Matrix4();

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

function isGroundAtmosphereCompanionDistance(cameraDistance, fadeOutDistance) {
  if (!(fadeOutDistance > 0.0)) {
    return false;
  }

  const distanceRatio = cameraDistance / fadeOutDistance;
  return (
    distanceRatio >= groundAtmosphereCompanionMinimumDistanceRatio &&
    distanceRatio <= groundAtmosphereCompanionMaximumDistanceRatio
  );
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

// Immutable fallback for commands produced before a logical view has published
// its eclipse block: the shader gate is closed and the composition reciprocal
// is the identity.
const defaultEclipseGlobeShadow = createEclipseGlobeShadow();

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
    // The command captures the active logical view's persistent block through
    // `properties` rather than lazily following the single mutable FrameState
    // object, so an offscreen or secondary view prepared later in the same tick
    // cannot change this command's eclipse geometry.
    u_eclipseGlobeShadow: function () {
      return this.properties.eclipseGlobeShadow.webglPackedUniform;
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
    u_terminatorGlowStrength: function () {
      return this.properties.terminatorGlowStrength;
    },
    u_nightDarkness: function () {
      return this.properties.nightDarkness;
    },
    u_vectorSegmentTexture: function () {
      return (
        this.properties.vectorSegmentTexture ??
        frameState.context.defaultTexture
      );
    },
    u_vectorWidthTexture: function () {
      return (
        this.properties.vectorWidthTexture ?? frameState.context.defaultTexture
      );
    },
    u_vectorColorTexture: function () {
      return (
        this.properties.vectorColorTexture ?? frameState.context.defaultTexture
      );
    },
    u_vectorSegmentPrimitiveIndicesTexture: function () {
      return (
        this.properties.vectorSegmentPrimitiveIndicesTexture ??
        frameState.context.defaultTexture
      );
    },
    u_vectorGridCellIndicesTexture: function () {
      return (
        this.properties.vectorGridCellIndicesTexture ??
        frameState.context.defaultTexture
      );
    },
    u_vectorPolygonEdgeTexture: function () {
      return (
        this.properties.vectorPolygonEdgeTexture ??
        frameState.context.defaultTexture
      );
    },
    u_vectorPolygonEdgePrimitiveIndicesTexture: function () {
      return (
        this.properties.vectorPolygonEdgePrimitiveIndicesTexture ??
        frameState.context.defaultTexture
      );
    },
    u_vectorPolygonGridCellIndicesTexture: function () {
      return (
        this.properties.vectorPolygonGridCellIndicesTexture ??
        frameState.context.defaultTexture
      );
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
      terminatorGlowStrength: 0.0,
      nightDarkness: 1.0,
      eclipseGlobeShadow: defaultEclipseGlobeShadow,

      vectorSegmentTexture: undefined,
      vectorWidthTexture: undefined,
      vectorColorTexture: undefined,
      vectorSegmentPrimitiveIndicesTexture: undefined,
      vectorGridCellIndicesTexture: undefined,
      vectorPolygonEdgeTexture: undefined,
      vectorPolygonEdgePrimitiveIndicesTexture: undefined,
      vectorPolygonGridCellIndicesTexture: undefined,
    },
  };

  if (defined(globeSurfaceTileProvider.materialUniformMap)) {
    return combine(uniformMap, globeSurfaceTileProvider.materialUniformMap);
  }

  return uniformMap;
}

/**
 * Creates the WebGL command carrier used when a retained globe command is
 * replayed for a pick/offscreen logical View.
 *
 * The ordinary render path deliberately keeps pooling one command and one
 * uniform map per globe draw.  A pick mini-frame cannot mutate that pooled
 * map's eclipse property, however: another logical View may still retain the
 * command and must continue resolving its own View-owned S5 block.  Use a
 * two-object copy-on-write overlay instead.  Every non-eclipse uniform remains
 * live through the pooled carrier while this command owns exactly the eclipse
 * value for the View that requested the replay.
 *
 * @param {DrawCommand} command The retained pooled WebGL globe command.
 * @param {object} eclipseGlobeShadow The requesting View's S5 block.
 * @returns {DrawCommand} A replay command with an isolated eclipse carrier.
 * @private
 */
function createWebGLViewBoundGlobeCommand(command, eclipseGlobeShadow) {
  const pooledUniformMap = command.uniformMap;
  // GlobeTranslucencyState builds its derived uniform map with `combine()`,
  // which copies own enumerable properties only. Preserve every pooled getter
  // as an own descriptor on this rare replay carrier while the backing values
  // below continue to delegate to the pooled properties object.
  const viewUniformMap = Object.create(Object.getPrototypeOf(pooledUniformMap));
  const uniformDescriptors = Object.getOwnPropertyDescriptors(pooledUniformMap);
  delete uniformDescriptors.properties;
  Object.defineProperties(viewUniformMap, uniformDescriptors);
  const viewProperties = Object.create(pooledUniformMap.properties);
  const sourceShadow = eclipseGlobeShadow ?? defaultEclipseGlobeShadow;
  const packedSnapshot = Object.freeze(
    Matrix4.clone(sourceShadow.webglPackedUniform),
  );
  const eclipseSnapshot = Object.freeze({
    webglPackedUniform: packedSnapshot,
  });

  Object.defineProperty(viewProperties, "eclipseGlobeShadow", {
    value: eclipseSnapshot,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(viewUniformMap, "properties", {
    value: viewProperties,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  const viewCommand = DrawCommand.shallowClone(command);
  viewCommand.uniformMap = viewUniformMap;
  return viewCommand;
}

/**
 * Prepares and pushes a WebGL globe command replay for one logical View.
 *
 * Translucent globe commands have a second retained-command graph owned by
 * GlobeTranslucencyState. A newly cloned replay command deliberately starts
 * with an empty derived-command graph, so populate that graph from the
 * View-bound uniform carrier before pushDerivedCommands consumes it.
 *
 * @param {DrawCommand} command The retained pooled WebGL globe command.
 * @param {FrameState} frameState The pick/offscreen View's frame state.
 * @returns {DrawCommand} The ephemeral View-bound replay command.
 * @private
 */
function pushWebGLViewBoundGlobeCommand(command, frameState) {
  const viewCommand = createWebGLViewBoundGlobeCommand(
    command,
    frameState.eclipseGlobeShadow,
  );
  const globeTranslucencyState = frameState.globeTranslucencyState;
  if (globeTranslucencyState.translucent) {
    globeTranslucencyState.updateDerivedCommands(viewCommand, frameState);
  }
  pushCommand(viewCommand, frameState);
  return viewCommand;
}

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

// Per-device globe renderer cache (supports multi-context / split-screen)
const _webgpuGlobeRenderers = new WeakMap();

/**
 * Construct and initialize the per-device WebGPU globe renderer during context
 * init rather than lazily on the first tile draw.
 *
 * <code>initialize</code> runs the two-variant GlobeTerrain shader-module
 * prewarm (<code>initShaderCache</code> — baseline plus
 * <code>GEODETIC_NORMAL|reduced</code>) along with the bind-group layouts,
 * samplers and placeholder texture. Those two Tint compiles of the ~239 KB
 * <code>GlobeTerrain.wgsl</code> dominate the first-frame stall on WebGPU:
 * ~176 ms from renderer-ready to first frame, against ~16 ms on WebGL. Running
 * them in the idle init window lets the first
 * <code>addWebGPUDrawCommandsForTile</code> find an initialized renderer in
 * <code>_webgpuGlobeRenderers</code> and reuse the cached shader modules when
 * it builds its tile-stride-dependent pipeline.
 *
 * The result is byte-identical to the lazy path — same
 * <code>RendererClass</code>, same static <code>getShaderCode()</code> WGSL,
 * same canvas format, same device-keyed WeakMap slot — only the compile moves
 * earlier. Keying off <code>context.device</code> keeps it multi-context safe:
 * a second device prewarms its own renderer. Every failure mode is a no-op that
 * leaves the lazy path intact.
 *
 * @param {GraphicsContext} context The WebGPU context being initialized. A
 *   no-op on WebGL contexts (no `.device`).
 * @private
 */
function warmUpGlobeRenderer(context) {
  const device = context && context.device;
  if (!device) {
    return;
  }
  const fr = context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE);
  if (!fr || !fr.RendererClass || !fr.getShaderCode) {
    return;
  }
  const shaderCode = fr.getShaderCode();
  if (!shaderCode || shaderCode.length === 0) {
    return;
  }
  let renderer = _webgpuGlobeRenderers.get(device);
  if (!renderer || renderer.isDestroyed()) {
    renderer = new fr.RendererClass();
    const fmt =
      context.canvasFormat || navigator.gpu.getPreferredCanvasFormat();
    renderer.initialize(device, shaderCode, fmt);
    _webgpuGlobeRenderers.set(device, renderer);
    //>>includeStart('debug', pragmas.debug);
    console.log(
      `[WebGPU:GlobePrewarm] Globe renderer warmed at init ` +
        `(shaderCode=${shaderCode.length}B, initialized=${renderer.isInitialized})`,
    );
    //>>includeEnd('debug');
  }
}

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
    //>>includeStart('debug', pragmas.debug);
    console.log(
      `[WebGPU:TileDraw] PROCEEDING — level=${tile.level} ` +
        `meshVerts=${mesh.vertices?.byteLength ?? "?"} ` +
        `meshIdx=${mesh.indices?.length ?? "?"}`,
    );
    //>>includeEnd('debug');
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

  // The renderer captures the opt-in counter sink once at construction.
  // Reading that field here avoids a global lookup per tile and guarantees the
  // adapter-command counters use the same sink as the renderer and its
  // resource helpers. Production renderers retain null.
  const logicalCounters = _webgpuGlobeRenderer._logicalCounters;

  // Publish the per-device globe renderer and tile provider so the
  // dynamic-environment-map scene-capture pass can build its own per-face globe
  // commands from the same visible tile set
  // (`tileProvider._quadtree._tilesToRender`). `runSceneCapture` runs in
  // `primitives.update`, ahead of this globe render path, so it reads the
  // previous frame's published references; the renderer instance is
  // frame-stable and the visible tile set barely moves between frames. Gated on
  // the context flag, so the default off state publishes nothing.
  if (context.sceneCaptureReflections === true) {
    publishWebGPUSceneCaptureSources(
      context,
      _webgpuGlobeRenderer,
      tileProvider,
      frameState,
    );
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
    // Empty `cmdDescs` from `createTileCommands` is both the WebGPU "pipeline
    // is still compiling asynchronously" signal and the WebGL "no commands to
    // emit" signal. The wakeup-on-pipeline-ready path lives in
    // `WebGPURenderPipelineCache` → `AsyncResourceMonitor` →
    // `Scene.requestRender()`, so this branch does not push an `afterRender`
    // callback of its own. WebGL has no asynchronous pipeline class, so empty
    // there genuinely means nothing to draw, and re-rendering would not change
    // that.
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
    // In non-3D scene modes the per-command frustum cull must not use the
    // tile's 3D ECEF bounding volume. `tileBR.boundingSphere` /
    // `.boundingVolume` live in 3D ECEF space, centred ~6.4 Mm from the origin,
    // and culling them against the projected 2D or Columbus-view frustum
    // rejects every tile at regional zoom, because that small frustum's planes
    // are nowhere near the ECEF sphere. SCENE3D keeps the 3D volume for its
    // per-command cull.
    //
    // Dropping the bounding volume entirely is not the alternative: a command
    // with no volume forces `View.createPotentiallyVisibleSet` down its
    // worst-case branch, `commandNear = frustum.near` (1 in 2D) and
    // `commandFar = frustum.far` (500 Mm). That collapses the scene near to 1,
    // explodes the 2D multi-frustum split from one to roughly nine uniform
    // frustums, and bins the globe into all of them, since a command with no
    // volume matches every bin in `insertIntoBin`. Colour accumulates across
    // frustums while depth clears per frustum, so the opaque globe in the near
    // frustums overwrites the coplanar translucent billboard, point and label
    // commands that only bin into the far frustums, whose tight bounding
    // volumes sit ~12.76 Mm out.
    //
    // WebGL avoids both by always supplying a bounding volume and relying on
    // `command.cull = false`, rather than a missing volume, to skip the
    // 2D-frustum mismatch: `Scene.isVisible` short-circuits on `!command.cull`
    // before touching the volume. Mirror that here — supply the 2D-projected
    // bounding sphere so the near/far split and frustum count match WebGL's,
    // and set `cull = false` so the projected sphere can never wrongly reject a
    // tile. `addDrawCommandsForTile` in this file carries the reference
    // 2D bounding-sphere computation.
    const non3D = frameState.mode !== SceneMode.SCENE3D;
    let non3DBoundingVolume;
    if (non3D && tileBR) {
      // 2D-projected bounding sphere (same computation WebGL uses): project
      // the tile rectangle into map space at the tile's height range, then
      // swap axes so `center.z` carries the screen-depth component the 2D
      // frustum split reads via `computePlaneDistances`. Fresh allocation per
      // command — these command objects are created per-tile per-frame (not
      // pooled like WebGL's), so a shared scratch would be clobbered by the
      // next tile before this command is consumed downstream.
      non3DBoundingVolume = BoundingSphere.fromRectangleWithHeights2D(
        tile.rectangle,
        frameState.mapProjection,
        tileBR.minimumHeight,
        tileBR.maximumHeight,
        new BoundingSphere(),
      );
      Cartesian3.fromElements(
        non3DBoundingVolume.center.z,
        non3DBoundingVolume.center.x,
        non3DBoundingVolume.center.y,
        non3DBoundingVolume.center,
      );
      if (frameState.mode === SceneMode.MORPHING) {
        // Morphing draws both the 3D and 2D positions; union the spheres so
        // the command's extent covers the in-flight interpolated geometry.
        non3DBoundingVolume = BoundingSphere.union(
          tileBR.boundingSphere,
          non3DBoundingVolume,
          non3DBoundingVolume,
        );
      }
    }
    const command = {
      // This is a native WebGPU command even before a pick variant is attached.
      // Without the tag, Scene.updateDerivedCommands treats the command as a
      // WebGL DrawCommand as soon as `derivedCommands` exists (for example in
      // a pick mini-frame) and allocates incompatible log-depth/depth clones.
      isWebGPUDrawCommand: true,
      pass: Pass.GLOBE,
      owner: tile,
      // `cull = false` in non-3D, mirroring WebGL: the 2D-projected sphere is
      // present only to drive the near/far split and the binning, not to cull.
      // `Scene.isVisible` returns true before inspecting the volume when `cull`
      // is false, so the 2D-frustum mismatch can never reject a tile.
      cull: !non3D,
      enabled: true,
      boundingVolume: non3D
        ? non3DBoundingVolume
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
      // Group 0 (camera UB plus tile UB) uses a dynamic-offset bind-group
      // layout. The bind group is built once over the ring page; this
      // two-element array shifts it to this command's actual UB slice at draw
      // time. Undefined only for descriptors that emit group 0 without dynamic
      // offsets, of which there are currently none.
      _bindGroup0DynamicOffsets: cmdDesc.bindGroup0DynamicOffsets,
      _vertexBuffer: cmdDesc.vertexBuffer,
      _indexBuffer: cmdDesc.indexBuffer,
      _indexCount: cmdDesc.indexCount,
      _indexFormat: cmdDesc.indexFormat,
      // Shadow-cast tags — route the command through the right
      // WebGPUShadowMapRenderer variant when the globe casts shadows. Every
      // globe terrain tile names its layout explicitly:
      //   * quantized tiles (TerrainQuantization.BITS12) → `quantized12`,
      //     which decodes BITS12 in the cast shader.
      //   * uncompressed tiles, whether or not they carry vertex normals,
      //     web-Mercator T or a geodetic surface normal →
      //     `terrainUncompressed`, which reads `position3DAndHeight` as a vec4
      //     at location 0 and is stride-aware, so the variable post-position
      //     bytes do not misalign the GPU's per-vertex walk.
      //
      // Inferring the layout from stride instead sends uncompressed tiles to
      // `rte24`, which reads two vec3s at offsets 0 and 12: the first lands on
      // `position.xyz`, but the second lands on `(height, u, v)` — texture
      // coordinates rather than a positionLow — and the resulting RTE math
      // gives shadow coordinates unrelated to the terrain.
      _shadowCastLayout: cmdDesc.isQuantized
        ? "quantized12"
        : "terrainUncompressed",
      _shadowCastTerrainUB: cmdDesc.shadowCastTerrainUB,
      // Expose the real vertex stride so
      // `_getOrCreateCastPipeline(..., overrideStride)` builds a pipeline whose
      // `arrayStride` matches the vertex buffer. Quantized tiles use stride 16,
      // a single compressed vec4; uncompressed tiles use 24, 28, 32, 36, 40 or
      // 44 depending on hasVertexNormals / hasWebMercatorT /
      // hasGeodeticSurfaceNormals, which `TileGPUResources.strideBytes` already
      // captures.
      vertexStride: cmdDesc.isQuantized ? 16 : (cmdDesc.strideBytes ?? 24),
      execute: executeWebGPUGlobeTileCommand,
    };
    configureWebGPUGlobeShadowCommand(
      command,
      tileProvider.shadows,
      isTranslucent,
      cmdDesc.shadowCastBindGroupCacheHost,
      useWireframe ? "line-list" : "triangle-list",
      tileProvider.backFaceCulling !== false &&
        frameState.cameraUnderground !== true,
    );
    if (logicalCounters) {
      logicalCounters.adapterCommandObjects =
        (logicalCounters.adapterCommandObjects ?? 0) + 1;
    }

    // Globe translucency: create derived commands for translucent globe
    if (translucencyFR && translucencyFR.updateDerivedCommands) {
      translucencyFR.updateDerivedCommands(
        globeTranslucencyState,
        command,
        frameState,
      );
    }

    // Globe terrain pick command, present only on the primary pass, since the
    // renderer sets `cmdDesc.pickPipeline` only when `!isSubsequentPass`. It
    // reuses the colour command's bind groups, vertex buffer, index buffer and
    // dynamic offsets; bind group 0's camera UB carries the pick colour at its
    // tail, zero unless `globe.pickable`, which `Globe.beginFrame` sets.
    // Attaching it to `command.derivedCommands.picking.pickCommand` lets the
    // WebGPU pick pass's `selectCommandVariant` swap to it, writing globe depth
    // and the pick colour into the single-target pick framebuffer.
    // `isWebGPUDrawCommand` makes the pick-pass dispatcher call
    // `execute(pickRenderPass, context)`, and `pickOnly` marks it as a
    // dedicated pick draw whose pipeline targets the single pick attachment.
    // Built only while commands are rebuilt for an actual pick mini-frame, so
    // normal rendering pays no derived-command allocation per tile.
    //
    // The draw happens even when `globe.pickable` is false, where the camera
    // UBO supplies a zero pick colour: terrain stays non-pickable while still
    // contributing depth. ClassificationPrimitive and GroundPrimitive picks
    // need that query-current terrain depth to decide whether their volume
    // covers the sampled surface, so omitting the draw would leave the pick
    // depth cleared and make every terrain classifier discard. WebGL's
    // `updateForPick` re-pushes globe commands for the same reason.
    if (
      cmdDesc.pickPipeline &&
      (frameState.passes.pick || frameState.passes.pickVoxel)
    ) {
      const pickCommand = {
        isWebGPUDrawCommand: true,
        pickOnly: true,
        // Derived terrain executables retain the same selected-tile ownership
        // as their colour command, so visibility and pick attribution agree.
        owner: tile,
        _pipeline: cmdDesc.pickPipeline,
        _bindGroups: cmdDesc.bindGroups,
        _bindGroup0DynamicOffsets: cmdDesc.bindGroup0DynamicOffsets,
        _vertexBuffer: cmdDesc.vertexBuffer,
        _indexBuffer: cmdDesc.indexBuffer,
        _indexCount: cmdDesc.indexCount,
        _indexFormat: cmdDesc.indexFormat,
        execute: executeWebGPUGlobeTileCommand,
      };
      if (logicalCounters) {
        logicalCounters.pickCommandObjects =
          (logicalCounters.pickCommandObjects ?? 0) + 1;
      }
      // Merge onto any existing derivedCommands (e.g. translucency) rather than
      // clobbering — mirrors `attachPickToColorCommand`.
      if (command.derivedCommands) {
        command.derivedCommands.picking = { pickCommand };
      } else {
        command.derivedCommands = { picking: { pickCommand } };
      }
    }

    frameState.commandList.push(command);
  }
}

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

  let maxTextures = context.limits.maximumTextureImageUnits;

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
  const terminatorGlowStrength = tileProvider.terminatorGlowStrength;
  const nightDarkness = tileProvider.nightDarkness ?? 1.0;

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
  const baseColorCorrect = colorCorrect;

  let perFragmentGroundAtmosphere = false;
  let groundAtmosphereCompanionEnabled = false;
  if (showGroundAtmosphere) {
    const cameraDistance = Cartesian3.magnitude(frameState.camera.positionWC);
    const fadeOutDistance = tileProvider.nightFadeOutDistance;
    perFragmentGroundAtmosphere = cameraDistance > fadeOutDistance;
    groundAtmosphereCompanionEnabled = isGroundAtmosphereCompanionDistance(
      cameraDistance,
      fadeOutDistance,
    );
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
  surfaceShaderSetOptions.groundAtmosphereCompanionEnabled =
    groundAtmosphereCompanionEnabled;
  surfaceShaderSetOptions.hasVertexNormals = hasVertexNormals;
  surfaceShaderSetOptions.useWebMercatorProjection = useWebMercatorProjection;
  surfaceShaderSetOptions.clippedByBoundaries = surfaceTile.clippedByBoundaries;
  surfaceShaderSetOptions.hasGeodeticSurfaceNormals = hasGeodeticSurfaceNormals;
  surfaceShaderSetOptions.enableEclipseGlobeShadow =
    frameState.eclipseGlobeShadow?.active === true;
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
    uniformMapProperties.eclipseGlobeShadow =
      frameState.eclipseGlobeShadow ?? defaultEclipseGlobeShadow;
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
    uniformMapProperties.terminatorGlowStrength = terminatorGlowStrength;
    uniformMapProperties.nightDarkness = nightDarkness;

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

    // The callback arguments are the same for every layer on this tile, so
    // the coordinates are built once rather than per property per layer.
    const tileCoordinates = { level: tile.level, x: tile.x, y: tile.y };

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
        resolveImageryLayerValue(
          imageryLayer.alpha,
          1.0,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyAlpha =
        applyAlpha ||
        uniformMapProperties.dayTextureAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.nightAlpha,
          1.0,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyDayNightAlpha =
        applyDayNightAlpha ||
        uniformMapProperties.dayTextureNightAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureDayAlpha[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.dayAlpha,
          1.0,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyDayNightAlpha =
        applyDayNightAlpha ||
        uniformMapProperties.dayTextureDayAlpha[numberOfDayTextures] !== 1.0;

      uniformMapProperties.dayTextureBrightness[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.brightness,
          ImageryLayer.DEFAULT_BRIGHTNESS,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyBrightness =
        applyBrightness ||
        uniformMapProperties.dayTextureBrightness[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_BRIGHTNESS;

      uniformMapProperties.dayTextureContrast[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.contrast,
          ImageryLayer.DEFAULT_CONTRAST,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyContrast =
        applyContrast ||
        uniformMapProperties.dayTextureContrast[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_CONTRAST;

      uniformMapProperties.dayTextureHue[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.hue,
          ImageryLayer.DEFAULT_HUE,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applyHue =
        applyHue ||
        uniformMapProperties.dayTextureHue[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_HUE;

      uniformMapProperties.dayTextureSaturation[numberOfDayTextures] =
        resolveImageryLayerValue(
          imageryLayer.saturation,
          ImageryLayer.DEFAULT_SATURATION,
          frameState,
          imageryLayer,
          tileCoordinates,
        );
      applySaturation =
        applySaturation ||
        uniformMapProperties.dayTextureSaturation[numberOfDayTextures] !==
          ImageryLayer.DEFAULT_SATURATION;

      const gamma = resolveImageryLayerValue(
        imageryLayer.gamma,
        ImageryLayer.DEFAULT_GAMMA,
        frameState,
        imageryLayer,
        tileCoordinates,
      );
      uniformMapProperties.dayTextureOneOverGamma[numberOfDayTextures] =
        1.0 / gamma;
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

    // update vector collections clamped to terrain
    const vectorData = surfaceTile.vectorData;
    if (defined(vectorData)) {
      uniformMapProperties.vectorSegmentTexture =
        vectorData.polylineSegmentTexture;
      uniformMapProperties.vectorWidthTexture = vectorData.widthTexture;
      uniformMapProperties.vectorColorTexture = vectorData.colorTexture;
      uniformMapProperties.vectorSegmentPrimitiveIndicesTexture =
        vectorData.polylineSegmentPrimitiveIndicesTexture;
      uniformMapProperties.vectorGridCellIndicesTexture =
        vectorData.polylineGridCellIndicesTexture;
      uniformMapProperties.vectorPolygonEdgeTexture =
        vectorData.polygonEdgeTexture;
      uniformMapProperties.vectorPolygonEdgePrimitiveIndicesTexture =
        vectorData.polygonEdgePrimitiveIndicesTexture;
      uniformMapProperties.vectorPolygonGridCellIndicesTexture =
        vectorData.polygonGridCellIndicesTexture;
    }

    const clippingPolygons = tileProvider._clippingPolygons;
    const clippingPolygonsEnabled =
      defined(clippingPolygons) &&
      clippingPolygons.enabled &&
      clippingPolygons.length > 0 &&
      tile.isClipped;

    surfaceShaderSetOptions.numberOfDayTextures = numberOfDayTextures;
    surfaceShaderSetOptions.applyBrightness = applyBrightness;
    surfaceShaderSetOptions.applyContrast = applyContrast;
    surfaceShaderSetOptions.applyHue = applyHue;
    surfaceShaderSetOptions.applySaturation = applySaturation;
    surfaceShaderSetOptions.applyGamma = applyGamma;
    surfaceShaderSetOptions.applyAlpha = applyAlpha;
    surfaceShaderSetOptions.applyDayNightAlpha = applyDayNightAlpha;
    // The procedural night fallback is the complement of the layer path: it
    // runs on tiles where nothing is blending a day/night alpha, so the two
    // are mutually exclusive per tile and the night side is darkened once.
    // The WGSL twin conjoins the same two inputs at runtime.
    surfaceShaderSetOptions.applyNightDarkness =
      nightDarkness < 1.0 && !applyDayNightAlpha;
    surfaceShaderSetOptions.applySplit = applySplit;
    surfaceShaderSetOptions.enableFog = applyFog;
    surfaceShaderSetOptions.enableClippingPlanes = clippingPlanesEnabled;
    surfaceShaderSetOptions.clippingPlanes = clippingPlanes;
    surfaceShaderSetOptions.enableClippingPolygons = clippingPolygonsEnabled;
    surfaceShaderSetOptions.clippingPolygons = clippingPolygons;
    surfaceShaderSetOptions.hasImageryLayerCutout = applyCutout;
    surfaceShaderSetOptions.colorCorrect = colorCorrect;
    surfaceShaderSetOptions.baseColorCorrect = baseColorCorrect;
    surfaceShaderSetOptions.fogCompanionEnabled =
      frameState.fog.configuredEnabled &&
      frameState.fog.renderable &&
      !cameraUnderground;
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

    const boundingVolume = command.boundingVolume;
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
        BoundingSphere.union(
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

// Rebuild the WebGPU globe commands for a pick frame.
//
// `QuadtreePrimitive.render` only builds globe draw commands under
// `passes.render`; during a pick pass it calls `tileProvider.updateForPick`,
// which on WebGL re-pushes the cached `_drawCommands` array. The WebGPU globe
// never populates `_drawCommands` — it pushes inline command objects straight
// to `frameState.commandList` from `addWebGPUDrawCommandsForTile` — and its
// camera UB is baked into a per-frame ring buffer at build time, so a
// render-frame command cannot simply be re-pushed in the pick frame: its ring
// slice has already been recycled. Fresh commands are built instead, for the
// already-selected tiles, in the pick frame's ring page;
// `addWebGPUDrawCommandsForTile` attaches the pick command, which writes globe
// depth and the pick-ID colour into the pick framebuffer.
//
// Returns true when the WebGPU path handled the rebuild, so the caller skips
// the WebGL `_drawCommands` re-push, and false on WebGL.
function updateWebGPUForPick(tileProvider, frameState) {
  const context = frameState.context;
  const fr = context.getFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE);
  if (!fr) {
    return false;
  }
  // Always rebuild the selected globe tiles for the pick mini-frame. When
  // `globe.pickable` is false the camera UBO's pick-color tail is zero, so the
  // draw changes only depth; when true it writes both depth and the Globe ID.
  // The depth-only case is required for terrain-classification picking and
  // matches WebGL's unconditional `_drawCommands` re-push below.
  const tilesToRenderByTextureCount = tileProvider._tilesToRenderByTextureCount;
  for (let i = 0; i < tilesToRenderByTextureCount.length; i++) {
    const tilesToRender = tilesToRenderByTextureCount[i];
    if (!defined(tilesToRender)) {
      continue;
    }
    for (let j = 0; j < tilesToRender.length; j++) {
      addWebGPUDrawCommandsForTile(
        tileProvider,
        tilesToRender[j],
        frameState,
        fr,
      );
    }
  }
  return true;
}

export {
  addDrawCommandsForTile,
  configureWebGPUGlobeShadowCommand,
  publishWebGPUSceneCaptureSources,
  updateWebGPUForPick,
  updateTileBoundingRegion,
  createTileUniformMap,
  createWireframeVertexArrayIfNecessary,
  debugDestroyPrimitive,
  getDebugOrientedBoundingBox,
  getDebugBoundingSphere,
  pushCommand,
  createWebGLViewBoundGlobeCommand,
  pushWebGLViewBoundGlobeCommand,
  isUndergroundVisible,
  isGroundAtmosphereCompanionDistance,
  clipRectangleAntimeridian,
  warmUpGlobeRenderer,
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
  createWebGLViewBoundGlobeCommand,
  pushWebGLViewBoundGlobeCommand,
  isUndergroundVisible,
  isGroundAtmosphereCompanionDistance,
  clipRectangleAntimeridian,
  warmUpGlobeRenderer,
};
export default GlobeSurfaceTileProviderRendering;
