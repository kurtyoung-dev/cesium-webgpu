import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import Color from "../Core/Color.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import FeatureDetection from "../Core/FeatureDetection.js";
import Geometry from "../Core/Geometry.js";
import GeometryAttribute from "../Core/GeometryAttribute.js";
import GeometryAttributes from "../Core/GeometryAttributes.js";
import GeometryOffsetAttribute from "../Core/GeometryOffsetAttribute.js";
import Intersect from "../Core/Intersect.js";
import Matrix4 from "../Core/Matrix4.js";
import Plane from "../Core/Plane.js";
import subdivideArray from "../Core/subdivideArray.js";
import TaskProcessor from "../Core/TaskProcessor.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import BatchTable from "./BatchTable.js";
import PrimitivePipeline from "./PrimitivePipeline.js";
import PrimitiveState from "./PrimitiveState.js";
import { updateBoundingVolumes } from "./PrimitiveCommandHelpers.js";

/**
 * Geometry loading, batch table creation, and bounding sphere helpers for Primitive.
 *
 * Extracted from Primitive.js to keep the main class under 1000 lines.
 *
 * @private
 */

const scratchGetAttributeCartesian2 = new Cartesian2();
const scratchGetAttributeCartesian3 = new Cartesian3();
const scratchGetAttributeCartesian4 = new Cartesian4();

function getAttributeValue(value) {
  const componentsPerAttribute = value.length;
  if (componentsPerAttribute === 1) {
    return value[0];
  } else if (componentsPerAttribute === 2) {
    return Cartesian2.unpack(value, 0, scratchGetAttributeCartesian2);
  } else if (componentsPerAttribute === 3) {
    return Cartesian3.unpack(value, 0, scratchGetAttributeCartesian3);
  } else if (componentsPerAttribute === 4) {
    return Cartesian4.unpack(value, 0, scratchGetAttributeCartesian4);
  }
}

function getCommonPerInstanceAttributeNames(instances) {
  const length = instances.length;

  const attributesInAllInstances = [];
  const attributes0 = instances[0].attributes;
  let name;

  for (name in attributes0) {
    if (Object.hasOwn(attributes0, name) && defined(attributes0[name])) {
      const attribute = attributes0[name];
      let inAllInstances = true;

      for (let i = 1; i < length; ++i) {
        const otherAttribute = instances[i].attributes[name];

        if (
          !defined(otherAttribute) ||
          attribute.componentDatatype !== otherAttribute.componentDatatype ||
          attribute.componentsPerAttribute !==
            otherAttribute.componentsPerAttribute ||
          attribute.normalize !== otherAttribute.normalize
        ) {
          inAllInstances = false;
          break;
        }
      }

      if (inAllInstances) {
        attributesInAllInstances.push(name);
      }
    }
  }

  return attributesInAllInstances;
}

function createBatchTable(primitive, context) {
  const geometryInstances = primitive.geometryInstances;
  const instances = Array.isArray(geometryInstances)
    ? geometryInstances
    : [geometryInstances];
  const numberOfInstances = instances.length;
  if (numberOfInstances === 0) {
    return;
  }

  const names = getCommonPerInstanceAttributeNames(instances);
  const length = names.length;

  const attributes = [];
  const attributeIndices = {};
  const boundingSphereAttributeIndices = {};
  let offset2DIndex;

  const firstInstance = instances[0];
  let instanceAttributes = firstInstance.attributes;

  let i;
  let name;
  let attribute;

  for (i = 0; i < length; ++i) {
    name = names[i];
    attribute = instanceAttributes[name];

    attributeIndices[name] = i;
    attributes.push({
      functionName: `czm_batchTable_${name}`,
      componentDatatype: attribute.componentDatatype,
      componentsPerAttribute: attribute.componentsPerAttribute,
      normalize: attribute.normalize,
    });
  }

  if (names.includes("distanceDisplayCondition")) {
    attributes.push(
      {
        functionName: "czm_batchTable_boundingSphereCenter3DHigh",
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
      },
      {
        functionName: "czm_batchTable_boundingSphereCenter3DLow",
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
      },
      {
        functionName: "czm_batchTable_boundingSphereCenter2DHigh",
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
      },
      {
        functionName: "czm_batchTable_boundingSphereCenter2DLow",
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
      },
      {
        functionName: "czm_batchTable_boundingSphereRadius",
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
      },
    );
    boundingSphereAttributeIndices.center3DHigh = attributes.length - 5;
    boundingSphereAttributeIndices.center3DLow = attributes.length - 4;
    boundingSphereAttributeIndices.center2DHigh = attributes.length - 3;
    boundingSphereAttributeIndices.center2DLow = attributes.length - 2;
    boundingSphereAttributeIndices.radius = attributes.length - 1;
  }

  if (names.includes("offset")) {
    attributes.push({
      functionName: "czm_batchTable_offset2D",
      componentDatatype: ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
    });
    offset2DIndex = attributes.length - 1;
  }

  attributes.push({
    functionName: "czm_batchTable_pickColor",
    componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
    componentsPerAttribute: 4,
    normalize: true,
  });

  const attributesLength = attributes.length;
  const batchTable = new BatchTable(context, attributes, numberOfInstances);

  for (i = 0; i < numberOfInstances; ++i) {
    const instance = instances[i];
    instanceAttributes = instance.attributes;

    for (let j = 0; j < length; ++j) {
      name = names[j];
      attribute = instanceAttributes[name];
      const value = getAttributeValue(attribute.value);
      const attributeIndex = attributeIndices[name];
      batchTable.setBatchedAttribute(i, attributeIndex, value);
    }

    const pickObject = {
      primitive: instance.pickPrimitive ?? primitive,
    };

    if (defined(instance.id)) {
      pickObject.id = instance.id;
    }

    const pickId = context.createPickId(pickObject);
    primitive._pickIds.push(pickId);

    const pickColor = pickId.color;
    const color = scratchGetAttributeCartesian4;
    color.x = Color.floatToByte(pickColor.red);
    color.y = Color.floatToByte(pickColor.green);
    color.z = Color.floatToByte(pickColor.blue);
    color.w = Color.floatToByte(pickColor.alpha);

    batchTable.setBatchedAttribute(i, attributesLength - 1, color);
  }

  primitive._batchTable = batchTable;
  primitive._batchTableAttributeIndices = attributeIndices;
  primitive._batchTableBoundingSphereAttributeIndices =
    boundingSphereAttributeIndices;
  primitive._batchTableOffsetAttribute2DIndex = offset2DIndex;
}

function cloneAttribute(attribute) {
  let clonedValues;
  if (Array.isArray(attribute.values)) {
    clonedValues = attribute.values.slice(0);
  } else {
    clonedValues = new attribute.values.constructor(attribute.values);
  }
  return new GeometryAttribute({
    componentDatatype: attribute.componentDatatype,
    componentsPerAttribute: attribute.componentsPerAttribute,
    normalize: attribute.normalize,
    values: clonedValues,
  });
}

function cloneGeometry(geometry) {
  const attributes = geometry.attributes;
  const newAttributes = new GeometryAttributes();
  for (const property in attributes) {
    if (Object.hasOwn(attributes, property) && defined(attributes[property])) {
      newAttributes[property] = cloneAttribute(attributes[property]);
    }
  }

  let indices;
  if (defined(geometry.indices)) {
    const sourceValues = geometry.indices;
    if (Array.isArray(sourceValues)) {
      indices = sourceValues.slice(0);
    } else {
      indices = new sourceValues.constructor(sourceValues);
    }
  }

  return new Geometry({
    attributes: newAttributes,
    indices: indices,
    primitiveType: geometry.primitiveType,
    boundingSphere: BoundingSphere.clone(geometry.boundingSphere),
  });
}

function cloneInstance(instance, geometry) {
  return {
    geometry: geometry,
    attributes: instance.attributes,
    modelMatrix: Matrix4.clone(instance.modelMatrix),
    pickPrimitive: instance.pickPrimitive,
    id: instance.id,
  };
}

const numberOfCreationWorkers = Math.max(
  FeatureDetection.hardwareConcurrency - 1,
  1,
);
let createGeometryTaskProcessors;
const combineGeometryTaskProcessor = new TaskProcessor("combineGeometry");

function loadAsynchronous(primitive, frameState) {
  let instances;
  let geometry;
  let i;
  let j;

  const instanceIds = primitive._instanceIds;

  if (primitive._state === PrimitiveState.READY) {
    instances = Array.isArray(primitive.geometryInstances)
      ? primitive.geometryInstances
      : [primitive.geometryInstances];
    const length = (primitive._numberOfInstances = instances.length);

    const promises = [];
    let subTasks = [];
    for (i = 0; i < length; ++i) {
      geometry = instances[i].geometry;
      instanceIds.push(instances[i].id);

      //>>includeStart('debug', pragmas.debug);
      if (
        (defined(geometry._workerName) && defined(geometry._workerPath)) ||
        (!defined(geometry._workerName) && !defined(geometry._workerPath))
      ) {
        throw new DeveloperError(
          "Must define either _workerName or _workerPath for asynchronous geometry.",
        );
      }
      //>>includeEnd('debug');

      subTasks.push({
        moduleName: geometry._workerName,
        modulePath: geometry._workerPath,
        geometry: geometry,
      });
    }

    if (!defined(createGeometryTaskProcessors)) {
      createGeometryTaskProcessors = new Array(numberOfCreationWorkers);
      for (i = 0; i < numberOfCreationWorkers; i++) {
        createGeometryTaskProcessors[i] = new TaskProcessor("createGeometry");
      }
    }

    let subTask;
    subTasks = subdivideArray(subTasks, numberOfCreationWorkers);

    for (i = 0; i < subTasks.length; i++) {
      let packedLength = 0;
      const workerSubTasks = subTasks[i];
      const workerSubTasksLength = workerSubTasks.length;
      for (j = 0; j < workerSubTasksLength; ++j) {
        subTask = workerSubTasks[j];
        geometry = subTask.geometry;
        if (defined(geometry.constructor.pack)) {
          subTask.offset = packedLength;
          packedLength +=
            geometry.constructor.packedLength ?? geometry.packedLength;
        }
      }

      let subTaskTransferableObjects;

      if (packedLength > 0) {
        const array = new Float64Array(packedLength);
        subTaskTransferableObjects = [array.buffer];

        for (j = 0; j < workerSubTasksLength; ++j) {
          subTask = workerSubTasks[j];
          geometry = subTask.geometry;
          if (defined(geometry.constructor.pack)) {
            geometry.constructor.pack(geometry, array, subTask.offset);
            subTask.geometry = array;
          }
        }
      }

      promises.push(
        createGeometryTaskProcessors[i].scheduleTask(
          {
            subTasks: subTasks[i],
          },
          subTaskTransferableObjects,
        ),
      );
    }

    primitive._state = PrimitiveState.CREATING;

    Promise.all(promises)
      .then(function (results) {
        primitive._createGeometryResults = results;
        primitive._state = PrimitiveState.CREATED;
      })
      .catch(function (error) {
        setReady(primitive, frameState, PrimitiveState.FAILED, error);
      });
  } else if (primitive._state === PrimitiveState.CREATED) {
    const transferableObjects = [];
    instances = Array.isArray(primitive.geometryInstances)
      ? primitive.geometryInstances
      : [primitive.geometryInstances];

    const scene3DOnly = frameState.scene3DOnly;
    const projection = frameState.mapProjection;

    const promise = combineGeometryTaskProcessor.scheduleTask(
      PrimitivePipeline.packCombineGeometryParameters(
        {
          createGeometryResults: primitive._createGeometryResults,
          instances: instances,
          ellipsoid: projection.ellipsoid,
          projection: projection,
          elementIndexUintSupported: frameState.context.elementIndexUint,
          scene3DOnly: scene3DOnly,
          vertexCacheOptimize: primitive.vertexCacheOptimize,
          compressVertices: primitive.compressVertices,
          modelMatrix: primitive.modelMatrix,
          createPickOffsets: primitive._createPickOffsets,
        },
        transferableObjects,
      ),
      transferableObjects,
    );

    primitive._createGeometryResults = undefined;
    primitive._state = PrimitiveState.COMBINING;

    Promise.resolve(promise)
      .then(function (packedResult) {
        const result =
          PrimitivePipeline.unpackCombineGeometryResults(packedResult);
        primitive._geometries = result.geometries;
        primitive._attributeLocations = result.attributeLocations;
        primitive.modelMatrix = Matrix4.clone(
          result.modelMatrix,
          primitive.modelMatrix,
        );
        primitive._pickOffsets = result.pickOffsets;
        primitive._offsetInstanceExtend = result.offsetInstanceExtend;
        primitive._instanceBoundingSpheres = result.boundingSpheres;
        primitive._instanceBoundingSpheresCV = result.boundingSpheresCV;

        if (
          defined(primitive._geometries) &&
          primitive._geometries.length > 0
        ) {
          primitive._recomputeBoundingSpheres = true;
          primitive._state = PrimitiveState.COMBINED;
        } else {
          setReady(primitive, frameState, PrimitiveState.FAILED, undefined);
        }
      })
      .catch(function (error) {
        setReady(primitive, frameState, PrimitiveState.FAILED, error);
      });
  }
}

function loadSynchronous(primitive, frameState) {
  const instances = Array.isArray(primitive.geometryInstances)
    ? primitive.geometryInstances
    : [primitive.geometryInstances];
  const length = (primitive._numberOfInstances = instances.length);
  const clonedInstances = new Array(length);
  const instanceIds = primitive._instanceIds;

  let instance;
  let i;

  let geometryIndex = 0;
  for (i = 0; i < length; i++) {
    instance = instances[i];
    const geometry = instance.geometry;

    let createdGeometry;
    if (defined(geometry.attributes) && defined(geometry.primitiveType)) {
      createdGeometry = cloneGeometry(geometry);
    } else {
      createdGeometry = geometry.constructor.createGeometry(geometry);
    }

    clonedInstances[geometryIndex++] = cloneInstance(instance, createdGeometry);
    instanceIds.push(instance.id);
  }

  clonedInstances.length = geometryIndex;

  const scene3DOnly = frameState.scene3DOnly;
  const projection = frameState.mapProjection;

  const result = PrimitivePipeline.combineGeometry({
    instances: clonedInstances,
    ellipsoid: projection.ellipsoid,
    projection: projection,
    elementIndexUintSupported: frameState.context.elementIndexUint,
    scene3DOnly: scene3DOnly,
    vertexCacheOptimize: primitive.vertexCacheOptimize,
    compressVertices: primitive.compressVertices,
    modelMatrix: primitive.modelMatrix,
    createPickOffsets: primitive._createPickOffsets,
  });

  primitive._geometries = result.geometries;
  primitive._attributeLocations = result.attributeLocations;
  primitive.modelMatrix = Matrix4.clone(
    result.modelMatrix,
    primitive.modelMatrix,
  );
  primitive._pickOffsets = result.pickOffsets;
  primitive._offsetInstanceExtend = result.offsetInstanceExtend;
  primitive._instanceBoundingSpheres = result.boundingSpheres;
  primitive._instanceBoundingSpheresCV = result.boundingSpheresCV;

  if (defined(primitive._geometries) && primitive._geometries.length > 0) {
    primitive._recomputeBoundingSpheres = true;
    primitive._state = PrimitiveState.COMBINED;
  } else {
    setReady(primitive, frameState, PrimitiveState.FAILED, undefined);
  }
}

const offsetBoundingSphereScratch1 = new BoundingSphere();
const offsetBoundingSphereScratch2 = new BoundingSphere();

function transformBoundingSphere(boundingSphere, offset, offsetAttribute) {
  if (offsetAttribute === GeometryOffsetAttribute.TOP) {
    const origBS = BoundingSphere.clone(
      boundingSphere,
      offsetBoundingSphereScratch1,
    );
    const offsetBS = BoundingSphere.clone(
      boundingSphere,
      offsetBoundingSphereScratch2,
    );
    offsetBS.center = Cartesian3.add(offsetBS.center, offset, offsetBS.center);
    boundingSphere = BoundingSphere.union(origBS, offsetBS, boundingSphere);
  } else if (offsetAttribute === GeometryOffsetAttribute.ALL) {
    boundingSphere.center = Cartesian3.add(
      boundingSphere.center,
      offset,
      boundingSphere.center,
    );
  }

  return boundingSphere;
}

function recomputeBoundingSpheres(primitive, frameState) {
  const offsetIndex = primitive._batchTableAttributeIndices.offset;
  if (!primitive._recomputeBoundingSpheres || !defined(offsetIndex)) {
    primitive._recomputeBoundingSpheres = false;
    return;
  }

  let i;
  const offsetInstanceExtend = primitive._offsetInstanceExtend;
  const boundingSpheres = primitive._instanceBoundingSpheres;
  const length = boundingSpheres.length;
  let newBoundingSpheres = primitive._tempBoundingSpheres;
  if (!defined(newBoundingSpheres)) {
    newBoundingSpheres = new Array(length);
    for (i = 0; i < length; i++) {
      newBoundingSpheres[i] = new BoundingSphere();
    }
    primitive._tempBoundingSpheres = newBoundingSpheres;
  }
  for (i = 0; i < length; ++i) {
    let newBS = newBoundingSpheres[i];
    const offset = primitive._batchTable.getBatchedAttribute(
      i,
      offsetIndex,
      new Cartesian3(),
    );
    newBS = boundingSpheres[i].clone(newBS);
    transformBoundingSphere(newBS, offset, offsetInstanceExtend[i]);
  }
  const combinedBS = [];
  const combinedWestBS = [];
  const combinedEastBS = [];

  for (i = 0; i < length; ++i) {
    const bs = newBoundingSpheres[i];

    const minX = bs.center.x - bs.radius;
    if (
      minX > 0 ||
      BoundingSphere.intersectPlane(bs, Plane.ORIGIN_ZX_PLANE) !==
        Intersect.INTERSECTING
    ) {
      combinedBS.push(bs);
    } else {
      combinedWestBS.push(bs);
      combinedEastBS.push(bs);
    }
  }

  let resultBS1 = combinedBS[0];
  let resultBS2 = combinedEastBS[0];
  let resultBS3 = combinedWestBS[0];

  for (i = 1; i < combinedBS.length; i++) {
    resultBS1 = BoundingSphere.union(resultBS1, combinedBS[i]);
  }
  for (i = 1; i < combinedEastBS.length; i++) {
    resultBS2 = BoundingSphere.union(resultBS2, combinedEastBS[i]);
  }
  for (i = 1; i < combinedWestBS.length; i++) {
    resultBS3 = BoundingSphere.union(resultBS3, combinedWestBS[i]);
  }
  const result = [];
  if (defined(resultBS1)) {
    result.push(resultBS1);
  }
  if (defined(resultBS2)) {
    result.push(resultBS2);
  }
  if (defined(resultBS3)) {
    result.push(resultBS3);
  }

  for (i = 0; i < result.length; i++) {
    const boundingSphere = result[i].clone(primitive._boundingSpheres[i]);
    primitive._boundingSpheres[i] = boundingSphere;
    primitive._boundingSphereCV[i] = BoundingSphere.projectTo2D(
      boundingSphere,
      frameState.mapProjection,
      primitive._boundingSphereCV[i],
    );
  }

  updateBoundingVolumes(primitive, frameState, primitive.modelMatrix, true);
  primitive._recomputeBoundingSpheres = false;
}

const scratchBoundingSphereCenterEncoded = new EncodedCartesian3();
const scratchBoundingSphereCartographic = new Cartographic();
const scratchBoundingSphereCenter2D = new Cartesian3();
const scratchBoundingSphere = new BoundingSphere();

function updateBatchTableBoundingSpheres(primitive, frameState) {
  const hasDistanceDisplayCondition = defined(
    primitive._batchTableAttributeIndices.distanceDisplayCondition,
  );
  if (
    !hasDistanceDisplayCondition ||
    primitive._batchTableBoundingSpheresUpdated
  ) {
    return;
  }

  const indices = primitive._batchTableBoundingSphereAttributeIndices;
  const center3DHighIndex = indices.center3DHigh;
  const center3DLowIndex = indices.center3DLow;
  const center2DHighIndex = indices.center2DHigh;
  const center2DLowIndex = indices.center2DLow;
  const radiusIndex = indices.radius;

  const projection = frameState.mapProjection;
  const ellipsoid = projection.ellipsoid;

  const batchTable = primitive._batchTable;
  const boundingSpheres = primitive._instanceBoundingSpheres;
  const length = boundingSpheres.length;

  for (let i = 0; i < length; ++i) {
    let boundingSphere = boundingSpheres[i];
    if (!defined(boundingSphere)) {
      continue;
    }

    const modelMatrix = primitive.modelMatrix;
    if (defined(modelMatrix)) {
      boundingSphere = BoundingSphere.transform(
        boundingSphere,
        modelMatrix,
        scratchBoundingSphere,
      );
    }

    const center = boundingSphere.center;
    const radius = boundingSphere.radius;

    let encodedCenter = EncodedCartesian3.fromCartesian(
      center,
      scratchBoundingSphereCenterEncoded,
    );
    batchTable.setBatchedAttribute(i, center3DHighIndex, encodedCenter.high);
    batchTable.setBatchedAttribute(i, center3DLowIndex, encodedCenter.low);

    if (!frameState.scene3DOnly) {
      const cartographic = ellipsoid.cartesianToCartographic(
        center,
        scratchBoundingSphereCartographic,
      );
      const center2D = projection.project(
        cartographic,
        scratchBoundingSphereCenter2D,
      );
      encodedCenter = EncodedCartesian3.fromCartesian(
        center2D,
        scratchBoundingSphereCenterEncoded,
      );
      batchTable.setBatchedAttribute(i, center2DHighIndex, encodedCenter.high);
      batchTable.setBatchedAttribute(i, center2DLowIndex, encodedCenter.low);
    }

    batchTable.setBatchedAttribute(i, radiusIndex, radius);
  }

  primitive._batchTableBoundingSpheresUpdated = true;
}

const offsetScratchCartesian = new Cartesian3();
const offsetCenterScratch = new Cartesian3();

function updateBatchTableOffsets(primitive, frameState) {
  const hasOffset = defined(primitive._batchTableAttributeIndices.offset);
  if (
    !hasOffset ||
    primitive._batchTableOffsetsUpdated ||
    frameState.scene3DOnly
  ) {
    return;
  }

  const index2D = primitive._batchTableOffsetAttribute2DIndex;

  const projection = frameState.mapProjection;
  const ellipsoid = projection.ellipsoid;

  const batchTable = primitive._batchTable;
  const boundingSpheres = primitive._instanceBoundingSpheres;
  const length = boundingSpheres.length;

  for (let i = 0; i < length; ++i) {
    let boundingSphere = boundingSpheres[i];
    if (!defined(boundingSphere)) {
      continue;
    }
    const offset = batchTable.getBatchedAttribute(
      i,
      primitive._batchTableAttributeIndices.offset,
    );
    if (Cartesian3.equals(offset, Cartesian3.ZERO)) {
      batchTable.setBatchedAttribute(i, index2D, Cartesian3.ZERO);
      continue;
    }

    const modelMatrix = primitive.modelMatrix;
    if (defined(modelMatrix)) {
      boundingSphere = BoundingSphere.transform(
        boundingSphere,
        modelMatrix,
        scratchBoundingSphere,
      );
    }

    let center = boundingSphere.center;
    center = ellipsoid.scaleToGeodeticSurface(center, offsetCenterScratch);
    let cartographic = ellipsoid.cartesianToCartographic(
      center,
      scratchBoundingSphereCartographic,
    );
    const center2D = projection.project(
      cartographic,
      scratchBoundingSphereCenter2D,
    );

    const newPoint = Cartesian3.add(offset, center, offsetScratchCartesian);
    cartographic = ellipsoid.cartesianToCartographic(newPoint, cartographic);

    const newPointProjected = projection.project(
      cartographic,
      offsetScratchCartesian,
    );

    const newVector = Cartesian3.subtract(
      newPointProjected,
      center2D,
      offsetScratchCartesian,
    );

    const x = newVector.x;
    newVector.x = newVector.z;
    newVector.z = newVector.y;
    newVector.y = x;

    batchTable.setBatchedAttribute(i, index2D, newVector);
  }

  primitive._batchTableOffsetsUpdated = true;
}

function createVertexArray(primitive, frameState) {
  const attributeLocations = primitive._attributeLocations;
  const geometries = primitive._geometries;
  const scene3DOnly = frameState.scene3DOnly;
  const context = frameState.context;

  // For WebGPU: Save references to geometry data BEFORE VertexArray.fromGeometry runs.
  // VertexArray.fromGeometry reads typed arrays to create WebGL GPU buffers but does NOT
  // mutate or clear them. We save lightweight references (not deep copies) to avoid
  // duplicating potentially large vertex/index arrays (~50% geometry memory savings).
  const primitiveFR = context.getFeatureRenderer(FeatureRendererKey.PRIMITIVE);
  if (primitiveFR) {
    primitive._webgpuGeometryData = [];
    for (let g = 0; g < geometries.length; g++) {
      const geom = geometries[g];
      const savedAttrs = {};
      for (const attrName in geom.attributes) {
        if (
          Object.hasOwn(geom.attributes, attrName) &&
          defined(geom.attributes[attrName])
        ) {
          const attr = geom.attributes[attrName];
          if (defined(attr.values)) {
            savedAttrs[attrName] = {
              values: attr.values,
              componentsPerAttribute: attr.componentsPerAttribute,
              componentDatatype: attr.componentDatatype,
              normalize: attr.normalize,
            };
          }
        }
      }
      primitive._webgpuGeometryData.push({
        attributes: savedAttrs,
        indices: geom.indices,
        primitiveType: geom.primitiveType,
        boundingSphere: defined(geom.boundingSphere)
          ? BoundingSphere.clone(geom.boundingSphere)
          : undefined,
      });
    }
  }

  const va = [];
  const length = geometries.length;
  for (let i = 0; i < length; ++i) {
    const geometry = geometries[i];

    va.push(
      VertexArray.fromGeometry({
        context: context,
        geometry: geometry,
        attributeLocations: attributeLocations,
        bufferUsage: BufferUsage.STATIC_DRAW,
        interleave: primitive._interleave,
      }),
    );

    if (defined(primitive._createBoundingVolumeFunction)) {
      primitive._createBoundingVolumeFunction(frameState, geometry);
    } else {
      primitive._boundingSpheres.push(
        BoundingSphere.clone(geometry.boundingSphere),
      );
      primitive._boundingSphereWC.push(new BoundingSphere());

      if (!scene3DOnly) {
        const center = geometry.boundingSphereCV.center;
        const x = center.x;
        const y = center.y;
        const z = center.z;
        center.x = z;
        center.y = x;
        center.z = y;

        primitive._boundingSphereCV.push(
          BoundingSphere.clone(geometry.boundingSphereCV),
        );
        primitive._boundingSphere2D.push(new BoundingSphere());
        primitive._boundingSphereMorph.push(new BoundingSphere());
      }
    }
  }

  primitive._va = va;
  primitive._primitiveType = geometries[0].primitiveType;

  if (primitive.releaseGeometryInstances) {
    primitive.geometryInstances = undefined;
  }

  // For alternate renderers, preserve raw geometry data to create GPU buffers later.
  // WebGL doesn't need this, so set to undefined to save memory.
  if (!primitiveFR) {
    primitive._geometries = undefined;
  }

  setReady(primitive, frameState, PrimitiveState.COMPLETE, undefined);
}

function setReady(primitive, frameState, state, error) {
  primitive._error = error;
  primitive._state = state;

  frameState.afterRender.push(function () {
    primitive._ready =
      primitive._state === PrimitiveState.COMPLETE ||
      primitive._state === PrimitiveState.FAILED;

    return true;
  });
}

export {
  getAttributeValue,
  createBatchTable,
  loadAsynchronous,
  loadSynchronous,
  recomputeBoundingSpheres,
  updateBatchTableBoundingSpheres,
  updateBatchTableOffsets,
  createVertexArray,
  transformBoundingSphere,
  setReady,
};

// Namespace default export for build system barrel compatibility
const PrimitiveGeometryHelpers = {
  getAttributeValue,
  createBatchTable,
  loadAsynchronous,
  loadSynchronous,
  recomputeBoundingSpheres,
  updateBatchTableBoundingSpheres,
  updateBatchTableOffsets,
  createVertexArray,
  transformBoundingSphere,
  setReady,
};
export default PrimitiveGeometryHelpers;
