/**
 * Renderer-agnostic geometry descriptor for glTF model primitives.
 * Extracts vertex attribute metadata and typed arrays from ModelRuntimePrimitive
 * render resources, so both WebGL and WebGPU renderers can consume them.
 *
 * This separates "what geometry data does this primitive have?"
 * (shared logic) from "how do we create GPU buffers for it?"
 * (renderer-specific: WebGL VertexArray vs WebGPU GPUBuffer).
 *
 * @private
 * @module ModelPrimitiveGeometry
 */
import defined from "../../Core/defined.js";

/**
 * Semantic constants for vertex attributes.
 */
const AttributeSemantic = Object.freeze({
  POSITION: "POSITION",
  NORMAL: "NORMAL",
  TANGENT: "TANGENT",
  TEXCOORD_0: "TEXCOORD_0",
  TEXCOORD_1: "TEXCOORD_1",
  COLOR_0: "COLOR_0",
  JOINTS_0: "JOINTS_0",
  WEIGHTS_0: "WEIGHTS_0",
  _FEATURE_ID_0: "_FEATURE_ID_0",
});

const EMPTY_ARRAY = Object.freeze([]);

let primitiveGeometryCache = new WeakMap();
const primitiveGeometryCacheDiagnostics = {
  hitCount: 0,
  missCount: 0,
  invalidationCount: 0,
  descriptorBuildCount: 0,
  attributeConversionCount: 0,
  morphAttributeConversionCount: 0,
  uint8IndexUpcastCount: 0,
  // C9-17 Slice B — positive-path validation attribution. A cache HIT that the
  // loader-owned revision tokens proved without the deep field walk increments
  // `revisionHitCount`; a HIT that still needed the full signature walk (some
  // attribute/index/morph token absent — an uninstrumented producer)
  // increments `walkHitCount`. On settled frames of fully-instrumented glTF
  // primitives, revisionHitCount should climb while walkHitCount stays flat.
  revisionHitCount: 0,
  walkHitCount: 0,
};

function getGeometryRevision(value) {
  if (!defined(value)) {
    return undefined;
  }
  return (
    value._webgpuGeometryRevision ??
    value._geometryRevision ??
    value.geometryRevision ??
    value._webgpuGeneration ??
    value._generation ??
    value.generation
  );
}

/**
 * C9-17 Slice B (FAR-204) — loader-owned monotonic geometry revision token.
 * Producers that REPLACE a primitive attribute's or index accessor's typed
 * array / buffer (GltfLoader's finalize callbacks, PntsLoader's attribute
 * build, and the CESIUM_primitive_outline post-process in PrimitiveLoadPlan)
 * call this after the mutation so the positive-path validation in
 * {@link geometrySignatureMatches} can short-circuit the deep per-field walk
 * when nothing has mutated since the signature was captured.
 *
 * The stamped field name (`_webgpuGeometryRevision`) is centralized here so it
 * can never drift from the {@link getGeometryRevision} probe chain, which reads
 * it first. Monotonic per-object increment (never resets) so equality with a
 * captured value proves "no mutation since capture" without an ABA hazard.
 *
 * @param {object} [target] attribute / indices / accessor source object
 * @private
 */
function bumpGeometryRevision(target) {
  if (!defined(target)) {
    return;
  }
  target._webgpuGeometryRevision = (target._webgpuGeometryRevision ?? 0) + 1;
}

function getAttributeData(attribute) {
  return attribute?.typedArray || attribute?.buffer;
}

function getSourceAttributes(source) {
  return source?.attributes || source?._attributes || EMPTY_ARRAY;
}

function getMorphTargets(primitive) {
  return primitive?.morphTargets || EMPTY_ARRAY;
}

function getTargetAttributes(target) {
  return target?.attributes || EMPTY_ARRAY;
}

function vectorComponent(vector, index) {
  if (!defined(vector)) {
    return undefined;
  }
  if (Array.isArray(vector) || ArrayBuffer.isView(vector)) {
    return vector[index];
  }
  switch (index) {
    case 0:
      return vector.x;
    case 1:
      return vector.y;
    case 2:
      return vector.z;
    case 3:
      return vector.w;
    default:
      return undefined;
  }
}

function captureAttributeSignature(attribute) {
  const data = getAttributeData(attribute);
  const quantization = attribute?.quantization;
  const offset = quantization?.quantizedVolumeOffset;
  const step = quantization?.quantizedVolumeStepSize;
  return {
    attribute,
    attributeRevision: getGeometryRevision(attribute),
    data,
    dataRevision: getGeometryRevision(data),
    semantic: attribute?.semantic,
    name: attribute?.name,
    setIndex: attribute?.setIndex,
    componentDatatype: attribute?.componentDatatype,
    componentsPerAttribute: attribute?.componentsPerAttribute,
    normalized: attribute?.normalized,
    count: attribute?.count,
    byteOffset: attribute?.byteOffset,
    byteStride: attribute?.byteStride,
    quantization,
    quantizationRevision: getGeometryRevision(quantization),
    offset,
    offsetRevision: getGeometryRevision(offset),
    offset0: vectorComponent(offset, 0),
    offset1: vectorComponent(offset, 1),
    offset2: vectorComponent(offset, 2),
    offset3: vectorComponent(offset, 3),
    step,
    stepRevision: getGeometryRevision(step),
    step0: vectorComponent(step, 0),
    step1: vectorComponent(step, 1),
    step2: vectorComponent(step, 2),
    step3: vectorComponent(step, 3),
  };
}

function attributeSignatureMatches(signature, attribute) {
  const data = getAttributeData(attribute);
  const quantization = attribute?.quantization;
  if (
    signature.attribute !== attribute ||
    signature.attributeRevision !== getGeometryRevision(attribute) ||
    signature.data !== data ||
    signature.dataRevision !== getGeometryRevision(data) ||
    signature.semantic !== attribute?.semantic ||
    signature.name !== attribute?.name ||
    signature.setIndex !== attribute?.setIndex ||
    signature.componentDatatype !== attribute?.componentDatatype ||
    signature.componentsPerAttribute !== attribute?.componentsPerAttribute ||
    signature.normalized !== attribute?.normalized ||
    signature.count !== attribute?.count ||
    signature.byteOffset !== attribute?.byteOffset ||
    signature.byteStride !== attribute?.byteStride ||
    signature.quantization !== quantization ||
    signature.quantizationRevision !== getGeometryRevision(quantization)
  ) {
    return false;
  }
  if (!defined(quantization)) {
    return true;
  }

  const offset = quantization.quantizedVolumeOffset;
  const step = quantization.quantizedVolumeStepSize;
  return (
    signature.offset === offset &&
    signature.offsetRevision === getGeometryRevision(offset) &&
    signature.offset0 === vectorComponent(offset, 0) &&
    signature.offset1 === vectorComponent(offset, 1) &&
    signature.offset2 === vectorComponent(offset, 2) &&
    signature.offset3 === vectorComponent(offset, 3) &&
    signature.step === step &&
    signature.stepRevision === getGeometryRevision(step) &&
    signature.step0 === vectorComponent(step, 0) &&
    signature.step1 === vectorComponent(step, 1) &&
    signature.step2 === vectorComponent(step, 2) &&
    signature.step3 === vectorComponent(step, 3)
  );
}

function captureGeometrySignature(runtimePrimitive, source, gltfPrimitive) {
  const attributes = getSourceAttributes(source);
  const attributeSignatures = new Array(attributes.length);
  for (let i = 0; i < attributes.length; i++) {
    attributeSignatures[i] = captureAttributeSignature(attributes[i]);
  }

  const indices = source?.indices;
  const indexData = indices?.typedArray || indices?.buffer;
  const morphTargets = getMorphTargets(gltfPrimitive);
  const morphTargetSignatures = new Array(morphTargets.length);
  for (let i = 0; i < morphTargets.length; i++) {
    const target = morphTargets[i];
    const targetAttributes = getTargetAttributes(target);
    const targetAttributeSignatures = new Array(targetAttributes.length);
    for (let j = 0; j < targetAttributes.length; j++) {
      targetAttributeSignatures[j] = captureAttributeSignature(
        targetAttributes[j],
      );
    }
    morphTargetSignatures[i] = {
      target,
      targetRevision: getGeometryRevision(target),
      attributes: targetAttributes,
      attributeSignatures: targetAttributeSignatures,
    };
  }

  return {
    runtimeRevision: getGeometryRevision(runtimePrimitive),
    source,
    sourceRevision: getGeometryRevision(source),
    gltfPrimitive,
    gltfPrimitiveRevision: getGeometryRevision(gltfPrimitive),
    attributes,
    attributeSignatures,
    indices,
    indicesRevision: getGeometryRevision(indices),
    indexData,
    indexDataRevision: getGeometryRevision(indexData),
    primitiveType: source?.primitiveType,
    fallbackPrimitiveType: gltfPrimitive?.primitiveType,
    morphTargets,
    morphTargetSignatures,
  };
}

/**
 * C9-17 Slice B — positive-path revision check for one attribute signature.
 * A HIT requires the loader to have stamped a DEFINED revision AND the
 * attribute + its data (typed array / buffer) to still have the captured
 * identity. When the revision is absent (an uninstrumented producer) this
 * returns false so the caller falls back to the deep field walk.
 * @private
 */
function attributeRevisionMatches(signature, attribute) {
  const revision = getGeometryRevision(attribute);
  return (
    defined(revision) &&
    signature.attribute === attribute &&
    signature.attributeRevision === revision &&
    signature.data === getAttributeData(attribute)
  );
}

/**
 * C9-17 Slice B — the deep per-field signature walk (attributes + indices +
 * morph targets). Correct for every producer, instrumented or not; this is the
 * O(attributes × fields) fallback and the debug cross-check oracle. Assumes the
 * caller already validated the top-level identities and the attributes-array
 * identity/length.
 * @private
 */
function geometryDeepWalkMatches(signature, source, gltfPrimitive, attributes) {
  for (let i = 0; i < attributes.length; i++) {
    if (
      !attributeSignatureMatches(
        signature.attributeSignatures[i],
        attributes[i],
      )
    ) {
      return false;
    }
  }

  const indices = source?.indices;
  const indexData = indices?.typedArray || indices?.buffer;
  if (
    signature.indices !== indices ||
    signature.indicesRevision !== getGeometryRevision(indices) ||
    signature.indexData !== indexData ||
    signature.indexDataRevision !== getGeometryRevision(indexData)
  ) {
    return false;
  }

  const morphTargets = getMorphTargets(gltfPrimitive);
  if (
    signature.morphTargets !== morphTargets ||
    signature.morphTargetSignatures.length !== morphTargets.length
  ) {
    return false;
  }
  for (let i = 0; i < morphTargets.length; i++) {
    const target = morphTargets[i];
    const targetSignature = signature.morphTargetSignatures[i];
    const targetAttributes = getTargetAttributes(target);
    if (
      targetSignature.target !== target ||
      targetSignature.targetRevision !== getGeometryRevision(target) ||
      targetSignature.attributes !== targetAttributes ||
      targetSignature.attributeSignatures.length !== targetAttributes.length
    ) {
      return false;
    }
    for (let j = 0; j < targetAttributes.length; j++) {
      if (
        !attributeSignatureMatches(
          targetSignature.attributeSignatures[j],
          targetAttributes[j],
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * C9-17 Slice B — O(objects) positive-path fast path. Returns true ONLY when
 * every attribute (base + morph) and the index accessor carry a defined,
 * unchanged loader-owned revision token AND every captured object identity
 * still holds — which provably implies the deep field walk would also match, so
 * the per-field/per-quantization-component comparisons are skipped. Returns
 * false (fall through to the walk) the instant any token is absent or any
 * identity/revision differs — so an uninstrumented producer, or a genuine
 * mutation, is always caught by the walk. Assumes the caller already validated
 * the top-level identities and the attributes-array identity/length.
 * @private
 */
function geometryRevisionFastPathMatches(
  signature,
  source,
  gltfPrimitive,
  attributes,
) {
  for (let i = 0; i < attributes.length; i++) {
    if (
      !attributeRevisionMatches(signature.attributeSignatures[i], attributes[i])
    ) {
      return false;
    }
  }

  const indices = source?.indices;
  if (signature.indices !== indices) {
    return false;
  }
  if (defined(indices)) {
    const indicesRevision = getGeometryRevision(indices);
    if (
      !defined(indicesRevision) ||
      signature.indicesRevision !== indicesRevision ||
      signature.indexData !== (indices.typedArray || indices.buffer)
    ) {
      return false;
    }
  } else if (defined(signature.indexData)) {
    return false;
  }

  const morphTargets = getMorphTargets(gltfPrimitive);
  if (
    signature.morphTargets !== morphTargets ||
    signature.morphTargetSignatures.length !== morphTargets.length
  ) {
    return false;
  }
  for (let i = 0; i < morphTargets.length; i++) {
    const target = morphTargets[i];
    const targetSignature = signature.morphTargetSignatures[i];
    const targetAttributes = getTargetAttributes(target);
    // The MorphTarget wrapper is never re-stamped (only its attributes'
    // typed arrays mutate), so its identity + its attributes' revisions are
    // the invalidation tokens; targetRevision equality stays permissive.
    if (
      targetSignature.target !== target ||
      targetSignature.targetRevision !== getGeometryRevision(target) ||
      targetSignature.attributes !== targetAttributes ||
      targetSignature.attributeSignatures.length !== targetAttributes.length
    ) {
      return false;
    }
    for (let j = 0; j < targetAttributes.length; j++) {
      if (
        !attributeRevisionMatches(
          targetSignature.attributeSignatures[j],
          targetAttributes[j],
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

function geometrySignatureMatches(
  signature,
  runtimePrimitive,
  source,
  gltfPrimitive,
) {
  if (
    signature.runtimeRevision !== getGeometryRevision(runtimePrimitive) ||
    signature.source !== source ||
    signature.sourceRevision !== getGeometryRevision(source) ||
    signature.gltfPrimitive !== gltfPrimitive ||
    signature.gltfPrimitiveRevision !== getGeometryRevision(gltfPrimitive) ||
    signature.primitiveType !== source?.primitiveType ||
    signature.fallbackPrimitiveType !== gltfPrimitive?.primitiveType
  ) {
    return false;
  }

  const attributes = getSourceAttributes(source);
  if (
    signature.attributes !== attributes ||
    signature.attributeSignatures.length !== attributes.length
  ) {
    return false;
  }

  // C9-17 Slice B — positive path: when the loader-owned revision tokens prove
  // the geometry is unchanged, skip the deep per-field walk entirely.
  if (
    geometryRevisionFastPathMatches(
      signature,
      source,
      gltfPrimitive,
      attributes,
    )
  ) {
    //>>includeStart('debug', pragmas.debug);
    // Revision-hit MUST imply signature-match. A divergence here means a
    // geometry mutation site is missing a bumpGeometryRevision stamp — loud in
    // dev, stripped from release.
    if (
      !geometryDeepWalkMatches(signature, source, gltfPrimitive, attributes)
    ) {
      console.error(
        "[CesiumJS:ModelPrimitiveGeometry] revision fast-path reported a HIT but the deep signature walk diverged — a geometry mutation site is missing a bumpGeometryRevision stamp",
      );
    }
    //>>includeEnd('debug');
    primitiveGeometryCacheDiagnostics.revisionHitCount++;
    return true;
  }

  const matches = geometryDeepWalkMatches(
    signature,
    source,
    gltfPrimitive,
    attributes,
  );
  if (matches) {
    primitiveGeometryCacheDiagnostics.walkHitCount++;
  }
  return matches;
}

function convertAttributeToFloat32(data, attribute, components, morph) {
  const converted = ensureFloat32(data, attribute, components);
  if (converted !== data) {
    if (morph) {
      primitiveGeometryCacheDiagnostics.morphAttributeConversionCount++;
    } else {
      primitiveGeometryCacheDiagnostics.attributeConversionCount++;
    }
  }
  return converted;
}

function freezeGeometryDescriptor(geometry) {
  if (!defined(geometry)) {
    return geometry;
  }
  const morphTargets = geometry.morphTargets;
  for (let i = 0; i < morphTargets.length; i++) {
    Object.freeze(morphTargets[i]);
  }
  Object.freeze(morphTargets);
  return Object.freeze(geometry);
}

/**
 * Builds geometry info from a ModelRuntimePrimitive's render resources.
 * Callers should use {@link extractPrimitiveGeometry}, which memoizes this
 * conversion against source identity and revision state.
 *
 * @param {ModelRuntimePrimitive} runtimePrimitive
 * @returns {ModelPrimitiveGeometry|null} Geometry descriptor, or null if no position data
 */
function buildPrimitiveGeometry(runtimePrimitive, source, gltfPrim) {
  // 2026-04-30 — `runtimePrimitive.renderResources` is never assigned
  // anywhere in the codebase (a `PrimitiveRenderResources` is built in
  // `ModelSceneGraph.js:256` but stored on the parent's
  // `nodeRenderResources.primitiveRenderResources[j]`, NOT mirrored back
  // onto the runtime primitive). The original WebGPU model code assumed
  // the slot existed, so this function unconditionally returned null —
  // breaking ALL model rendering on WebGPU (silent: no errors, no
  // command list entries, just an empty `cache.primitives`).
  //
  // Fallback path: read directly from `runtimePrimitive.primitive`
  // (the underlying `ModelComponents.Primitive`), whose `.attributes`
  // and `.indices` carry the same shape downstream code expects (each
  // attribute has `.semantic`, `.typedArray`, `.buffer`,
  // `.componentDatatype`, etc.). This pairs with the
  // `loadTypedArrayForWebGPU` retention added to `GltfLoader.js`
  // (2026-04-30) so the typed arrays are still present when this
  // function runs on WebGPU.
  if (!defined(source)) {
    return null;
  }

  const attrs = source.attributes || source._attributes || [];
  const result = {
    // Typed arrays for each attribute (null if not present)
    positionData: null,
    normalData: null,
    tangentData: null,
    texCoord0Data: null,
    texCoord1Data: null,
    color0Data: null,
    joints0Data: null,
    weights0Data: null,
    // _FEATURE_ID_0 vertex attribute (b3dm `_BATCHID` is renamed to
    // `_FEATURE_ID_0` by the loader). When the primitive carries a
    // FeatureIdAttribute selection, the WebGPU model renderer uploads
    // this typed array as a per-vertex f32 attribute and the FS uses
    // it to index the batch / feature-pick textures. Audit B.2 (Batch
    // 130) — without this the per-feature pick + batch styling paths
    // were stuck on the texture-only branch, which b3dm tilesets never
    // hit (they encode IDs as a vertex attribute, not a texture).
    featureId0Data: null,

    // Metadata
    vertexCount: 0,
    hasNormals: false,
    hasTangents: false,
    hasTexCoord0: false,
    hasTexCoord1: false,
    hasColor0: false,
    hasJoints: false,
    hasFeatureId0: false,
    hasMetadata: false,
    hasPropertyTables: false,
    hasPropertyTextures: false,

    // Per-render annotations are deliberately absent from the immutable base.
    // WebGPUModelRenderer writes these onto a reusable mutable view instead.
    metadataData: null,
    metadataClassHash: 0,
    metadataWGSL: null,
    metadataMatTransport: false,
    propertyTableLayout: null,
    propertyTextureLayout: null,

    // Color component type (for proper conversion)
    color0ComponentType: null, // "FLOAT", "UNSIGNED_BYTE", "UNSIGNED_SHORT"
    color0Normalized: false,

    // Index data
    indexData: null,
    indexCount: 0,
    indexType: null, // "UNSIGNED_SHORT" or "UNSIGNED_INT"

    // GLTF-POINTS-MODE — the glTF primitive draw mode (`PrimitiveType` /
    // WebGL enum: POINTS=0, ..., TRIANGLES=4). WebGL consumes it via
    // `PrimitiveRenderResources.primitiveType` → `DrawCommand.primitiveType`;
    // the WebGPU model renderer maps it to a GPUPrimitiveTopology so
    // mode-0 POINTS primitives build point-list pipelines instead of the
    // hardcoded triangle-list. undefined (→ triangles) when the source
    // doesn't carry it — note POINTS is 0, so use defined() not truthiness.
    primitiveType: defined(source.primitiveType)
      ? source.primitiveType
      : gltfPrim?.primitiveType,

    // Attribute count info
    positionComponentCount: 3,
    normalComponentCount: 3,
    tangentComponentCount: 4,
    texCoord0ComponentCount: 2,
    color0ComponentCount: 4,
  };

  // Extract attributes by semantic
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const semantic = attr.semantic || attr.name || "";
    const data = attr.typedArray || attr.buffer;

    if (!defined(data)) {
      continue;
    }

    switch (semantic) {
      case AttributeSemantic.POSITION:
        result.positionData = convertAttributeToFloat32(data, attr, 3, false);
        // Vertex count derives from the dequantized length so it stays
        // correct even when the raw source is interleaved/strided.
        result.vertexCount = Math.floor(result.positionData.length / 3);
        break;
      case AttributeSemantic.NORMAL:
        result.normalData = convertAttributeToFloat32(data, attr, 3, false);
        result.hasNormals = true;
        break;
      case AttributeSemantic.TANGENT:
        result.tangentData = convertAttributeToFloat32(data, attr, 4, false);
        result.hasTangents = true;
        break;
      case AttributeSemantic.TEXCOORD_0:
      case "TEXCOORD":
        result.texCoord0Data = convertAttributeToFloat32(data, attr, 2, false);
        result.hasTexCoord0 = true;
        break;
      case AttributeSemantic.TEXCOORD_1:
        result.texCoord1Data = convertAttributeToFloat32(data, attr, 2, false);
        result.hasTexCoord1 = true;
        break;
      case AttributeSemantic.COLOR_0:
      case "COLOR":
        result.color0Data = data;
        result.hasColor0 = true;
        result.color0ComponentType = getComponentTypeName(data);
        result.color0Normalized = attr.normalized === true;
        // Determine component count from stride
        if (defined(attr.componentsPerAttribute)) {
          result.color0ComponentCount = attr.componentsPerAttribute;
        }
        break;
      // Cesium's `ModelComponents` stores skinning semantics in their bare
      // `VertexAttributeSemantic` form (`"JOINTS"` / `"WEIGHTS"` with a
      // separate `setIndex`), NOT the combined `"JOINTS_0"` string — the
      // same convention that makes POSITION/NORMAL and the `"TEXCOORD"` /
      // `"COLOR"` aliases above match. Without the bare-form cases the
      // joint/weight buffers were never extracted, so `hasJoints` stayed
      // false, `FLAG_HAS_SKINNING` was never set, and every skinned model
      // rendered frozen in its rest pose on WebGPU (WebGL was unaffected —
      // it uses the GltfLoader vertex-buffer path, not this extractor).
      case AttributeSemantic.JOINTS_0:
      case "JOINTS":
        result.joints0Data = data;
        result.hasJoints = true;
        break;
      case AttributeSemantic.WEIGHTS_0:
      case "WEIGHTS":
        result.weights0Data = convertAttributeToFloat32(data, attr, 4, false);
        break;
      case AttributeSemantic._FEATURE_ID_0:
      case "_FEATURE_ID":
        // The loader stores b3dm's `_BATCHID` as `_FEATURE_ID_0`. Cast
        // to f32 so the FS can read it as a flat varying without an
        // explicit integer-attribute pipeline path.
        result.featureId0Data = convertAttributeToFloat32(data, attr, 1, false);
        result.hasFeatureId0 = true;
        break;
    }
  }

  // Position is required
  if (!defined(result.positionData) || result.vertexCount === 0) {
    return null;
  }

  // Extract morph target data from the glTF primitive
  result.morphTargets = [];
  result.morphTargetCount = 0;
  const prim = gltfPrim;
  if (defined(prim) && defined(prim.morphTargets)) {
    const targets = prim.morphTargets;
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      const targetAttrs = target.attributes || [];
      const morphTarget = {
        positionData: null,
        normalData: null,
        tangentData: null,
      };
      for (let a = 0; a < targetAttrs.length; a++) {
        const tAttr = targetAttrs[a];
        const tSemantic = tAttr.semantic || tAttr.name || "";
        const tData = tAttr.typedArray || tAttr.buffer;
        if (!defined(tData)) {
          continue;
        }
        // Morph target deltas also honor KHR_mesh_quantization when the
        // source accessor carries quantization metadata; otherwise the
        // deltas reconstruct exaggerated (scaled-up integer) values.
        if (tSemantic === "POSITION") {
          morphTarget.positionData = convertAttributeToFloat32(
            tData,
            tAttr,
            3,
            true,
          );
        } else if (tSemantic === "NORMAL") {
          morphTarget.normalData = convertAttributeToFloat32(
            tData,
            tAttr,
            3,
            true,
          );
        } else if (tSemantic === "TANGENT") {
          // C2-4: glTF morph TANGENT deltas are VEC3 (the .w handedness is NOT
          // morphed), so extract 3 components — matches WebGL getMorphedTangent.
          // Without this, a normal-mapped morphed mesh keeps its rest-pose
          // tangent frame and the tangent-space normal drifts as it deforms.
          morphTarget.tangentData = convertAttributeToFloat32(
            tData,
            tAttr,
            3,
            true,
          );
        }
      }
      if (defined(morphTarget.positionData)) {
        result.morphTargets.push(morphTarget);
      }
    }
    result.morphTargetCount = result.morphTargets.length;
  }

  // Extract index data — same fallback as attributes above.
  const indices = source.indices;
  if (defined(indices)) {
    let idxData = indices.typedArray || indices.buffer;
    if (defined(idxData)) {
      // glTF allows UNSIGNED_BYTE indices (componentType 5121), and
      // CZML Model Articulations is one of the few production assets
      // that ships them — the hinge meshes for the cesium_air control
      // surfaces compile down to 18 byte-indices each. WebGPU's
      // `IndexFormat` only accepts "uint16" and "uint32"; there is no
      // uint8 path. Upcast Uint8Array → Uint16Array at extract time so
      // the cache build site (`primCache.indexBuffer`) sizes the GPU
      // buffer at 2 bytes per index instead of 1. Without this, the
      // buffer is sized for `idxData.byteLength` (== count) bytes,
      // padded to a multiple of 4, but the draw command tags the
      // format as uint16 and walks 2 bytes per index — overflowing
      // the buffer on the first draw call. (Symptom pre-fix on the
      // CZML Model Articulations demo: `Index range (first: 0,
      // count: 18, format: Uint16) does not fit in index buffer
      // size (20)` warning every frame, model never renders.)
      // Session 65 Batch 7 (2026-05-12) — NEW-VR-CZML-MODEL-
      // ARTICULATIONS-INDEXCOUNT.
      if (idxData instanceof Uint8Array) {
        const upcast = new Uint16Array(idxData.length);
        for (let i = 0; i < idxData.length; i++) {
          upcast[i] = idxData[i];
        }
        idxData = upcast;
        primitiveGeometryCacheDiagnostics.uint8IndexUpcastCount++;
      }
      result.indexData = idxData;
      result.indexCount = idxData.length;
      result.indexType =
        idxData instanceof Uint32Array ? "UNSIGNED_INT" : "UNSIGNED_SHORT";
    }
  }

  return result;
}

/**
 * Returns a cached immutable base descriptor for a runtime primitive.
 * Validation is allocation-free on cache hits and observes the identities,
 * revisions, conversion metadata, morph sources, and index source that affect
 * the extracted result. Weak keys allow dead model scene graphs to be
 * collected without an explicit cache teardown.
 *
 * @param {ModelRuntimePrimitive} runtimePrimitive
 * @returns {ModelPrimitiveGeometry|null}
 */
function extractPrimitiveGeometry(runtimePrimitive) {
  if (!defined(runtimePrimitive)) {
    return null;
  }

  const gltfPrimitive =
    runtimePrimitive.primitive || runtimePrimitive._primitive;
  const renderResources =
    runtimePrimitive.renderResources || runtimePrimitive._renderResources;
  const source = defined(renderResources) ? renderResources : gltfPrimitive;

  if (
    (typeof runtimePrimitive !== "object" || runtimePrimitive === null) &&
    typeof runtimePrimitive !== "function"
  ) {
    primitiveGeometryCacheDiagnostics.missCount++;
    primitiveGeometryCacheDiagnostics.descriptorBuildCount++;
    return freezeGeometryDescriptor(
      buildPrimitiveGeometry(runtimePrimitive, source, gltfPrimitive),
    );
  }

  const cached = primitiveGeometryCache.get(runtimePrimitive);
  if (
    defined(cached) &&
    geometrySignatureMatches(
      cached.signature,
      runtimePrimitive,
      source,
      gltfPrimitive,
    )
  ) {
    primitiveGeometryCacheDiagnostics.hitCount++;
    return cached.geometry;
  }

  if (defined(cached)) {
    primitiveGeometryCacheDiagnostics.invalidationCount++;
  }
  primitiveGeometryCacheDiagnostics.missCount++;
  primitiveGeometryCacheDiagnostics.descriptorBuildCount++;

  const signature = captureGeometrySignature(
    runtimePrimitive,
    source,
    gltfPrimitive,
  );
  const geometry = freezeGeometryDescriptor(
    buildPrimitiveGeometry(runtimePrimitive, source, gltfPrimitive),
  );
  primitiveGeometryCache.set(runtimePrimitive, { signature, geometry });
  return geometry;
}

/**
 * Creates a mutable renderer view over an immutable cached base. This is a
 * shallow, once-per-source-generation copy: typed arrays and frozen morph
 * descriptors remain shared, while renderer annotations can be replaced.
 *
 * @param {ModelPrimitiveGeometry} baseGeometry
 * @returns {ModelPrimitiveGeometry}
 */
function createPrimitiveGeometryView(baseGeometry) {
  return { ...baseGeometry };
}

/**
 * Clears fields that WebGPUModelRenderer may annotate or synthesize. Reusing
 * the same view avoids a per-frame descriptor copy while ensuring late
 * metadata and implicit feature-ID decisions never contaminate the base.
 *
 * @param {ModelPrimitiveGeometry} view
 * @param {ModelPrimitiveGeometry} baseGeometry
 * @returns {ModelPrimitiveGeometry}
 */
function resetPrimitiveGeometryView(view, baseGeometry) {
  view.indexData = baseGeometry.indexData;
  view.indexCount = baseGeometry.indexCount;
  view.indexType = baseGeometry.indexType;
  view.featureId0Data = baseGeometry.featureId0Data;
  view.hasFeatureId0 = baseGeometry.hasFeatureId0;
  view.metadataData = null;
  view.metadataClassHash = 0;
  view.metadataWGSL = null;
  view.metadataMatTransport = false;
  view.hasMetadata = false;
  view.propertyTableLayout = null;
  view.propertyTextureLayout = null;
  view.hasPropertyTables = false;
  view.hasPropertyTextures = false;
  return view;
}

function getPrimitiveGeometryCacheDiagnostics() {
  return Object.freeze({ ...primitiveGeometryCacheDiagnostics });
}

function resetPrimitiveGeometryCacheForSpecs() {
  primitiveGeometryCache = new WeakMap();
  for (const key in primitiveGeometryCacheDiagnostics) {
    if (Object.hasOwn(primitiveGeometryCacheDiagnostics, key)) {
      primitiveGeometryCacheDiagnostics[key] = 0;
    }
  }
}

/**
 * Converts vertex color data to Float32Array [0..1] range.
 * Handles UNSIGNED_BYTE (0-255), UNSIGNED_SHORT (0-65535), and FLOAT formats.
 *
 * @param {TypedArray} data - Raw color data
 * @param {string} componentType - "FLOAT", "UNSIGNED_BYTE", or "UNSIGNED_SHORT"
 * @param {boolean} normalized
 * @returns {Float32Array}
 */
function normalizeColorData(data, componentType, normalized) {
  if (data instanceof Float32Array) {
    return data;
  }
  if (!normalized) {
    return new Float32Array(data);
  }
  const result = new Float32Array(data.length);
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    const scale = 1.0 / 255.0;
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] * scale;
    }
  } else if (data instanceof Uint16Array) {
    const scale = 1.0 / 65535.0;
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] * scale;
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i];
    }
  }
  return result;
}

/**
 * Divisor for converting normalized integer attribute values back to float.
 * Keyed on the typed-array constructor. glTF's `accessor.normalized = true`
 * means the integer value should be scaled by 1/max so e.g. `UNSIGNED_BYTE
 * 255 → 1.0`. Signed types use 1/(2^N−1) per the glTF spec (so `BYTE -128`
 * clamps to `-1.0` rather than overflowing to `-128/127`).
 * @private
 */
function normalizedDivisor(data) {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return 255.0;
  }
  if (data instanceof Int8Array) {
    return 127.0;
  }
  if (data instanceof Uint16Array) {
    return 65535.0;
  }
  if (data instanceof Int16Array) {
    return 32767.0;
  }
  return 1.0;
}

/**
 * Convert a glTF vertex attribute to Float32Array, honoring:
 *
 *   1. `attribute.quantization` (KHR_mesh_quantization) — applies
 *      per-component `quantizedVolumeOffset + raw * quantizedVolumeStepSize`
 *      to bring positions/normals/tangents back to their authored range.
 *   2. `attribute.normalized` — applies `raw / typeMax` for integer
 *      attributes (bytes/shorts) so the value lands in [-1, 1] or [0, 1]
 *      as the accessor type requires.
 *   3. Raw float data passthrough — returns the Float32Array directly.
 *
 * Without this, casts like `new Float32Array(int16Data)` reinterpret raw
 * integer values as f32, which makes KHR_mesh_quantization assets
 * (near-universal in production tilesets — Google Photorealistic, most
 * commercial pipelines) render fundamentally wrong: positions collapse to
 * the origin, normals light black, texcoords repeat thousands of times.
 *
 * @param {TypedArray} data Raw attribute data
 * @param {object} [attr] The source attribute (optional; carries
 *   `normalized` and `quantization` metadata when available)
 * @param {number} [componentsPerAttribute=1] Element count per vertex
 *   (3 for POSITION/NORMAL, 4 for TANGENT, 2 for TEXCOORD, etc.).
 *   Only used when quantization offsets are per-component vectors.
 * @returns {Float32Array}
 * @private
 */
function ensureFloat32(data, attr, componentsPerAttribute) {
  if (data instanceof Float32Array) {
    return data;
  }

  const quant = attr && attr.quantization;
  const nc = componentsPerAttribute || 1;

  // KHR_mesh_quantization — dequantize with per-component offset + step.
  if (quant) {
    // Quantization fields come through as Cartesian2/3/4 (x/y/z/w) on the
    // Cesium loader path; flatten to a flat Float64 array so the
    // per-component index works uniformly.
    const offset = _flattenVector(quant.quantizedVolumeOffset, nc);
    const step = _flattenVector(quant.quantizedVolumeStepSize, nc);
    if (offset && step) {
      const out = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const comp = i % nc;
        out[i] = offset[comp] + data[i] * step[comp];
      }
      return out;
    }
    // Quantization object without the expected fields — fall through to
    // the normalized / cast path.
  }

  // Normalized integer — spec-correct scale to [-1, 1] or [0, 1].
  if (attr && attr.normalized === true) {
    const divisor = normalizedDivisor(data);
    if (divisor !== 1.0) {
      const out = new Float32Array(data.length);
      const invDiv = 1.0 / divisor;
      // Signed normalized types clamp -N to -1 (i.e., the negative extreme
      // equal to the divisor should become -1, not -divisor/divisor = -1
      // — still correct because divisor for signed types is 2^N−1).
      for (let i = 0; i < data.length; i++) {
        out[i] = data[i] * invDiv;
      }
      return out;
    }
  }

  // Raw cast — last resort. Correct for non-normalized integer attributes
  // that the shader is expected to treat as integer-valued floats (rare
  // for POSITION/NORMAL/TEXCOORD but legitimate for some custom semantics).
  return new Float32Array(data);
}

/**
 * Flatten a Cartesian2/3/4 (or plain array) into a length-nc flat array.
 * Returns null if the input is falsy.
 * @private
 */
function _flattenVector(v, nc) {
  if (!defined(v)) {
    return null;
  }
  if (
    Array.isArray(v) ||
    v instanceof Float32Array ||
    v instanceof Float64Array
  ) {
    return v;
  }
  // Cartesian2 / Cartesian3 / Cartesian4 — read x, y, z, w as available
  if (typeof v === "object" && typeof v.x === "number") {
    const out = new Float64Array(nc);
    out[0] = v.x;
    if (nc >= 2) {
      out[1] = v.y ?? 0;
    }
    if (nc >= 3) {
      out[2] = v.z ?? 0;
    }
    if (nc >= 4) {
      out[3] = v.w ?? 0;
    }
    return out;
  }
  return null;
}

/**
 * Gets component type name from typed array.
 * @private
 */
function getComponentTypeName(data) {
  if (data instanceof Float32Array) {
    return "FLOAT";
  }
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return "UNSIGNED_BYTE";
  }
  if (data instanceof Uint16Array) {
    return "UNSIGNED_SHORT";
  }
  if (data instanceof Int16Array) {
    return "SHORT";
  }
  return "FLOAT";
}

export {
  extractPrimitiveGeometry,
  createPrimitiveGeometryView,
  resetPrimitiveGeometryView,
  getPrimitiveGeometryCacheDiagnostics,
  resetPrimitiveGeometryCacheForSpecs,
  bumpGeometryRevision,
  normalizeColorData,
  ensureFloat32,
  AttributeSemantic,
};
export default {
  extractPrimitiveGeometry,
  createPrimitiveGeometryView,
  resetPrimitiveGeometryView,
  getPrimitiveGeometryCacheDiagnostics,
  normalizeColorData,
  AttributeSemantic,
};
