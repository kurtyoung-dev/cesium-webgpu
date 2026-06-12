/**
 * Automatic uniform system for WebGPU rendering — the csm_* equivalent of
 * WebGL's czm_* AutomaticUniforms.js.
 *
 * WebGL uses individual gl.uniform* calls per uniform. WebGPU instead uses
 * explicit uniform buffers with structured layouts. This module bridges the gap
 * by providing:
 *
 * 1. A registry of all csm_* automatic uniforms with WGSL types, byte sizes,
 *    and getValue(uniformState) functions.
 * 2. Predefined "uniform profiles" — named sets of uniforms for common use cases
 *    (camera-only, camera+lighting, full scene, etc.)
 * 3. Functions to compute buffer layouts (with proper GPU alignment) and populate
 *    Float32Array data from UniformState.
 *
 * ALL rendering uses RTE (Relative-To-Eye) emulated 64-bit precision:
 * - csm_encodedCameraPositionMCHigh / csm_encodedCameraPositionMCLow
 * - csm_modelViewProjectionRelativeToEye (translation column zeroed)
 * - csm_modelViewRelativeToEye (translation column zeroed)
 *
 * @private
 * @module WebGPUAutoUniforms
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import defined from "../../Core/defined.js";

// =========================================================================
// WGSL Type Definitions — sizes and alignment requirements
// =========================================================================

/**
 * WGSL type metadata: byte size and alignment for uniform buffer layout.
 * See https://www.w3.org/TR/WGSL/#alignment-and-size
 * @private
 */
const WGSLType = Object.freeze({
  f32: { size: 4, align: 4, components: 1 },
  vec2f: { size: 8, align: 8, components: 2 },
  vec3f: { size: 12, align: 16, components: 3 }, // vec3 aligns to 16!
  vec4f: { size: 16, align: 16, components: 4 },
  mat3x3f: { size: 48, align: 16, components: 12 }, // 3 x vec3 w/ padding
  mat4x4f: { size: 64, align: 16, components: 16 },
  i32: { size: 4, align: 4, components: 1 },
  vec2i: { size: 8, align: 8, components: 2 },
  vec3i: { size: 12, align: 16, components: 3 },
  vec4i: { size: 16, align: 16, components: 4 },
});

// =========================================================================
// Scratch Variables — avoid per-frame allocations
// =========================================================================

const scratchViewerPositionWC = new Cartesian3();

// =========================================================================
// Automatic Uniform Definitions
// =========================================================================

/**
 * Registry of all csm_* automatic uniforms.
 * Each entry defines:
 *   - wgslType: WGSL type info (size, alignment, components)
 *   - getValue: function(uniformState) → value from UniformState
 *   - pack: function(value, float32Array, offset) → writes value into buffer
 *
 * @private
 */
const AutoUniform = {};

// ---------- Helper: pack functions ----------

function packFloat(value, arr, off) {
  arr[off] = value;
}

function packVec2(value, arr, off) {
  arr[off] = value.x;
  arr[off + 1] = value.y;
}

function packVec3(value, arr, off) {
  arr[off] = value.x;
  arr[off + 1] = value.y;
  arr[off + 2] = value.z;
}

function packVec4(value, arr, off) {
  if (defined(value.x)) {
    arr[off] = value.x;
    arr[off + 1] = value.y;
    arr[off + 2] = value.z;
    arr[off + 3] = value.w;
  } else if (defined(value.red)) {
    arr[off] = value.red;
    arr[off + 1] = value.green;
    arr[off + 2] = value.blue;
    arr[off + 3] = value.alpha;
  } else {
    // Cartesian4-like from array
    arr[off] = value[0] ?? 0;
    arr[off + 1] = value[1] ?? 0;
    arr[off + 2] = value[2] ?? 0;
    arr[off + 3] = value[3] ?? 0;
  }
}

function packMat4(value, arr, off) {
  Matrix4.pack(value, arr, off);
}

function packMat3(value, arr, off) {
  // mat3x3 in WGSL is stored as 3 x vec4 (vec3 + 4-byte padding each)
  // Column-major: col0 at [0..2]+pad, col1 at [4..6]+pad, col2 at [8..10]+pad
  arr[off] = value[0];
  arr[off + 1] = value[1];
  arr[off + 2] = value[2];
  arr[off + 3] = 0; // pad
  arr[off + 4] = value[3];
  arr[off + 5] = value[4];
  arr[off + 6] = value[5];
  arr[off + 7] = 0; // pad
  arr[off + 8] = value[6];
  arr[off + 9] = value[7];
  arr[off + 10] = value[8];
  arr[off + 11] = 0; // pad
}

// ---------- Auto-Uniform Definitions ----------

function defineUniform(name, wgslType, getValue, pack) {
  AutoUniform[name] = {
    name: name,
    wgslType: wgslType,
    getValue: getValue,
    pack: pack,
  };
}

// ---- Viewport ----
defineUniform(
  "csm_viewport",
  WGSLType.vec4f,
  (us) => us.viewportCartesian4,
  packVec4,
);

defineUniform(
  "csm_viewportTransformation",
  WGSLType.mat4x4f,
  (us) => us.viewportTransformation,
  packMat4,
);

// ---- View / Projection Matrices ----
defineUniform("csm_view", WGSLType.mat4x4f, (us) => us.view, packMat4);

defineUniform("csm_view3D", WGSLType.mat4x4f, (us) => us.view3D, packMat4);

defineUniform(
  "csm_viewRotation",
  WGSLType.mat3x3f,
  (us) => us.viewRotation,
  packMat3,
);

defineUniform(
  "csm_viewRotation3D",
  WGSLType.mat3x3f,
  (us) => us.viewRotation3D,
  packMat3,
);

defineUniform(
  "csm_inverseView",
  WGSLType.mat4x4f,
  (us) => us.inverseView,
  packMat4,
);

defineUniform(
  "csm_inverseView3D",
  WGSLType.mat4x4f,
  (us) => us.inverseView3D,
  packMat4,
);

defineUniform(
  "csm_inverseViewRotation",
  WGSLType.mat3x3f,
  (us) => us.inverseViewRotation,
  packMat3,
);

defineUniform(
  "csm_projection",
  WGSLType.mat4x4f,
  (us) => us.projection,
  packMat4,
);

defineUniform(
  "csm_inverseProjection",
  WGSLType.mat4x4f,
  (us) => us.inverseProjection,
  packMat4,
);

defineUniform(
  "csm_infiniteProjection",
  WGSLType.mat4x4f,
  (us) => us.infiniteProjection,
  packMat4,
);

// ---- Model Matrices ----
defineUniform("csm_model", WGSLType.mat4x4f, (us) => us.model, packMat4);

defineUniform(
  "csm_inverseModel",
  WGSLType.mat4x4f,
  (us) => us.inverseModel,
  packMat4,
);

// ---- Combined Matrices ----
defineUniform(
  "csm_modelView",
  WGSLType.mat4x4f,
  (us) => us.modelView,
  packMat4,
);

defineUniform(
  "csm_modelView3D",
  WGSLType.mat4x4f,
  (us) => us.modelView3D,
  packMat4,
);

defineUniform(
  "csm_modelViewProjection",
  WGSLType.mat4x4f,
  (us) => us.modelViewProjection,
  packMat4,
);

defineUniform(
  "csm_inverseModelView",
  WGSLType.mat4x4f,
  (us) => us.inverseModelView,
  packMat4,
);

defineUniform(
  "csm_viewProjection",
  WGSLType.mat4x4f,
  (us) => us.viewProjection,
  packMat4,
);

defineUniform(
  "csm_inverseViewProjection",
  WGSLType.mat4x4f,
  (us) => us.inverseViewProjection,
  packMat4,
);

defineUniform(
  "csm_modelViewInfiniteProjection",
  WGSLType.mat4x4f,
  (us) => us.modelViewInfiniteProjection,
  packMat4,
);

// ---- RTE Matrices (CRITICAL for planetary-scale rendering) ----
defineUniform(
  "csm_modelViewRelativeToEye",
  WGSLType.mat4x4f,
  (us) => us.modelViewRelativeToEye,
  packMat4,
);

defineUniform(
  "csm_modelViewProjectionRelativeToEye",
  WGSLType.mat4x4f,
  (us) => us.modelViewProjectionRelativeToEye,
  packMat4,
);

defineUniform(
  "csm_encodedCameraPositionMCHigh",
  WGSLType.vec3f,
  (us) => us.encodedCameraPositionMCHigh,
  packVec3,
);

defineUniform(
  "csm_encodedCameraPositionMCLow",
  WGSLType.vec3f,
  (us) => us.encodedCameraPositionMCLow,
  packVec3,
);

// ---- Normal Matrices ----
defineUniform("csm_normal", WGSLType.mat3x3f, (us) => us.normal, packMat3);

defineUniform("csm_normal3D", WGSLType.mat3x3f, (us) => us.normal3D, packMat3);

defineUniform(
  "csm_inverseNormal",
  WGSLType.mat3x3f,
  (us) => us.inverseNormal,
  packMat3,
);

defineUniform(
  "csm_inverseNormal3D",
  WGSLType.mat3x3f,
  (us) => us.inverseNormal3D,
  packMat3,
);

// ---- Camera / Eye ----
defineUniform(
  "csm_viewerPositionWC",
  WGSLType.vec3f,
  (us) => Matrix4.getTranslation(us.inverseView, scratchViewerPositionWC),
  packVec3,
);

defineUniform("csm_eyeHeight", WGSLType.f32, (us) => us.eyeHeight, packFloat);

defineUniform(
  "csm_eyeHeight2D",
  WGSLType.vec2f,
  (us) => us.eyeHeight2D,
  packVec2,
);

// ---- Frustum ----
defineUniform(
  "csm_entireFrustum",
  WGSLType.vec2f,
  (us) => us.entireFrustum,
  packVec2,
);

defineUniform(
  "csm_currentFrustum",
  WGSLType.vec2f,
  (us) => us.currentFrustum,
  packVec2,
);

defineUniform(
  "csm_frustumPlanes",
  WGSLType.vec4f,
  (us) => us.frustumPlanes,
  packVec4,
);

defineUniform(
  "csm_farDepthFromNearPlusOne",
  WGSLType.f32,
  (us) => us.farDepthFromNearPlusOne,
  packFloat,
);

defineUniform(
  "csm_log2FarDepthFromNearPlusOne",
  WGSLType.f32,
  (us) => us.log2FarDepthFromNearPlusOne,
  packFloat,
);

defineUniform(
  "csm_oneOverLog2FarDepthFromNearPlusOne",
  WGSLType.f32,
  (us) => us.oneOverLog2FarDepthFromNearPlusOne,
  packFloat,
);

// ---- Sun / Moon / Lighting ----
defineUniform(
  "csm_sunPositionWC",
  WGSLType.vec3f,
  (us) => us.sunPositionWC,
  packVec3,
);

defineUniform(
  "csm_sunPositionColumbusView",
  WGSLType.vec3f,
  (us) => us.sunPositionColumbusView,
  packVec3,
);

defineUniform(
  "csm_sunDirectionEC",
  WGSLType.vec3f,
  (us) => us.sunDirectionEC,
  packVec3,
);

defineUniform(
  "csm_sunDirectionWC",
  WGSLType.vec3f,
  (us) => us.sunDirectionWC,
  packVec3,
);

defineUniform(
  "csm_moonDirectionEC",
  WGSLType.vec3f,
  (us) => us.moonDirectionEC,
  packVec3,
);

defineUniform(
  "csm_lightDirectionEC",
  WGSLType.vec3f,
  (us) => us.lightDirectionEC,
  packVec3,
);

defineUniform(
  "csm_lightDirectionWC",
  WGSLType.vec3f,
  (us) => us.lightDirectionWC,
  packVec3,
);

defineUniform(
  "csm_lightColor",
  WGSLType.vec3f,
  (us) => us.lightColor,
  packVec3,
);

defineUniform(
  "csm_lightColorHdr",
  WGSLType.vec3f,
  (us) => us.lightColorHdr,
  packVec3,
);

// ---- Scene State ----
defineUniform(
  "csm_frameNumber",
  WGSLType.f32,
  (us) => us.frameState.frameNumber,
  packFloat,
);

defineUniform(
  "csm_morphTime",
  WGSLType.f32,
  (us) => us.frameState.morphTime,
  packFloat,
);

defineUniform(
  "csm_sceneMode",
  WGSLType.f32,
  (us) => us.frameState.mode,
  packFloat,
);

defineUniform("csm_pass", WGSLType.f32, (us) => us.pass, packFloat);

defineUniform(
  "csm_backgroundColor",
  WGSLType.vec4f,
  (us) => us.backgroundColor,
  packVec4,
);

defineUniform(
  "csm_orthographicIn3D",
  WGSLType.f32,
  (us) => (us.orthographicIn3D ? 1 : 0),
  packFloat,
);

// ---- Fog ----
defineUniform("csm_fogDensity", WGSLType.f32, (us) => us.fogDensity, packFloat);

defineUniform(
  "csm_fogMinimumBrightness",
  WGSLType.f32,
  (us) => us.fogMinimumBrightness,
  packFloat,
);

// OPEN-5 fix: the visual density scalar modulates the fog exponential
// to match the WebGL path's `czm_fog(dist, color, fogColor, scalar)`.
// Without it, WebGPU fog is ~6.7x stronger than WebGL at horizontal
// viewing angles because the scalar (default 0.15) is never applied.
defineUniform(
  "csm_fogVisualDensityScalar",
  WGSLType.f32,
  (us) => us.fogVisualDensityScalar,
  packFloat,
);

// ---- Misc ----
defineUniform("csm_pixelRatio", WGSLType.f32, (us) => us.pixelRatio, packFloat);

defineUniform("csm_gamma", WGSLType.f32, (us) => us.gamma, packFloat);

defineUniform(
  "csm_splitPosition",
  WGSLType.f32,
  (us) => us.splitPosition,
  packFloat,
);

defineUniform(
  "csm_geometricToleranceOverMeter",
  WGSLType.f32,
  (us) => us.geometricToleranceOverMeter,
  packFloat,
);

defineUniform(
  "csm_ellipsoidRadii",
  WGSLType.vec3f,
  (us) => us.ellipsoid.radii,
  packVec3,
);

defineUniform(
  "csm_ellipsoidInverseRadii",
  WGSLType.vec3f,
  (us) => us.ellipsoid.oneOverRadii,
  packVec3,
);

defineUniform(
  "csm_invertClassificationColor",
  WGSLType.vec4f,
  (us) => us.invertClassificationColor,
  packVec4,
);

defineUniform(
  "csm_minimumDisableDepthTestDistance",
  WGSLType.f32,
  (us) => us.minimumDisableDepthTestDistance,
  packFloat,
);

defineUniform(
  "csm_temeToPseudoFixed",
  WGSLType.mat3x3f,
  (us) => us.temeToPseudoFixedMatrix,
  packMat3,
);

// =========================================================================
// Uniform Profiles — predefined sets for common use cases
// =========================================================================

/**
 * Predefined uniform profiles for common rendering scenarios.
 * Each profile lists the csm_* uniform names included in that buffer.
 * @private
 */
const UniformProfiles = Object.freeze({
  /**
   * Camera-only RTE profile: MVP + camera position (flat/unlit rendering)
   * This matches the current Primitive flat shader layout.
   */
  CAMERA_RTE_FLAT: [
    "csm_modelViewProjectionRelativeToEye",
    "csm_encodedCameraPositionMCHigh",
    "csm_encodedCameraPositionMCLow",
  ],

  /**
   * Camera + lighting RTE profile: MVP + MV + normal + camera + light
   * This matches the current Primitive lit shader layout.
   */
  CAMERA_RTE_LIT: [
    "csm_modelViewProjectionRelativeToEye",
    "csm_modelViewRelativeToEye",
    "csm_normal",
    "csm_encodedCameraPositionMCHigh",
    "csm_encodedCameraPositionMCLow",
    "csm_lightDirectionEC",
  ],

  /**
   * Pick profile: MVP + camera + pick color placeholder
   */
  CAMERA_RTE_PICK: [
    "csm_modelViewProjectionRelativeToEye",
    "csm_encodedCameraPositionMCHigh",
    "csm_encodedCameraPositionMCLow",
  ],

  /**
   * Scene-wide uniforms (shared across all draw calls in a frame)
   */
  SCENE: [
    "csm_viewport",
    "csm_view",
    "csm_inverseView",
    "csm_projection",
    "csm_inverseProjection",
    "csm_viewProjection",
    "csm_inverseViewProjection",
    "csm_viewerPositionWC",
    "csm_entireFrustum",
    "csm_currentFrustum",
    "csm_frustumPlanes",
    "csm_sunDirectionEC",
    "csm_sunDirectionWC",
    "csm_lightDirectionEC",
    "csm_lightDirectionWC",
    "csm_lightColor",
    "csm_fogDensity",
    "csm_fogMinimumBrightness",
    "csm_fogVisualDensityScalar",
    "csm_frameNumber",
    "csm_morphTime",
    "csm_sceneMode",
    "csm_pixelRatio",
    "csm_gamma",
    "csm_ellipsoidRadii",
    "csm_ellipsoidInverseRadii",
  ],

  /**
   * Globe-specific uniforms (for terrain rendering)
   */
  GLOBE: [
    "csm_modelViewProjectionRelativeToEye",
    "csm_modelViewRelativeToEye",
    "csm_encodedCameraPositionMCHigh",
    "csm_encodedCameraPositionMCLow",
    "csm_normal3D",
    "csm_viewerPositionWC",
    "csm_sunDirectionEC",
    "csm_lightDirectionEC",
    "csm_lightColor",
    "csm_eyeHeight",
    "csm_fogDensity",
    "csm_fogMinimumBrightness",
    "csm_fogVisualDensityScalar",
  ],
});

// =========================================================================
// Buffer Layout Computation
// =========================================================================

/**
 * Computes a GPU-aligned buffer layout for a list of uniform names.
 * Respects WGSL alignment rules (vec3 aligns to 16, mat3 as 3xvec4, etc.)
 *
 * @param {string[]} uniformNames - Array of csm_* uniform names
 * @returns {{
 *   totalSize: number,
 *   entries: Array<{name: string, offset: number, size: number, type: object}>,
 *   alignedSize: number
 * }}
 * @private
 */
function computeBufferLayout(uniformNames) {
  const entries = [];
  let currentOffset = 0;

  for (let i = 0; i < uniformNames.length; i++) {
    const name = uniformNames[i];
    const uniform = AutoUniform[name];

    if (!defined(uniform)) {
      throw new Error(`Unknown automatic uniform: ${name}`);
    }

    const type = uniform.wgslType;

    // Align to the type's alignment requirement
    const alignment = type.align;
    const remainder = currentOffset % alignment;
    if (remainder !== 0) {
      currentOffset += alignment - remainder;
    }

    let byteSize = type.size;
    // mat3x3f in uniform buffer: stored as 3 columns of vec4 (3 x 16 = 48 bytes)
    if (type === WGSLType.mat3x3f) {
      byteSize = 48;
    }

    entries.push({
      name: name,
      offset: currentOffset,
      size: byteSize,
      floatOffset: currentOffset / 4,
      floatCount: byteSize / 4,
      type: type,
    });

    currentOffset += byteSize;
  }

  // Round up total to 16-byte alignment (WebGPU UBO alignment requirement)
  const remainder = currentOffset % 16;
  const alignedSize =
    remainder === 0 ? currentOffset : currentOffset + (16 - remainder);

  return {
    totalSize: currentOffset,
    alignedSize: alignedSize,
    entries: entries,
  };
}

// Layout cache
const _layoutCache = {};

/**
 * Gets or computes a cached buffer layout for a profile name or uniform list.
 *
 * @param {string|string[]} profileOrNames - Profile name or array of uniform names
 * @returns {object} Buffer layout (see computeBufferLayout)
 * @private
 */
function getBufferLayout(profileOrNames) {
  const key = Array.isArray(profileOrNames)
    ? profileOrNames.join(",")
    : profileOrNames;

  if (!defined(_layoutCache[key])) {
    const names = Array.isArray(profileOrNames)
      ? profileOrNames
      : UniformProfiles[profileOrNames];

    if (!defined(names)) {
      throw new Error(`Unknown uniform profile: ${profileOrNames}`);
    }
    _layoutCache[key] = computeBufferLayout(names);
  }

  return _layoutCache[key];
}

// =========================================================================
// Buffer Population
// =========================================================================

/**
 * Populates a Float32Array with uniform values from UniformState.
 * The layout must have been computed by computeBufferLayout().
 *
 * @param {Float32Array} target - Target array to write uniform data into
 * @param {object} layout - Buffer layout from computeBufferLayout()
 * @param {object} uniformState - CesiumJS UniformState object
 * @private
 */
function populateUniformBuffer(target, layout, uniformState) {
  for (let i = 0; i < layout.entries.length; i++) {
    const entry = layout.entries[i];
    const uniform = AutoUniform[entry.name];
    const value = uniform.getValue(uniformState);

    if (defined(value)) {
      uniform.pack(value, target, entry.floatOffset);
    }
  }
}

/**
 * Creates a new Float32Array sized for a profile and populates it.
 *
 * @param {string|string[]} profileOrNames - Profile name or array of uniform names
 * @param {object} uniformState - CesiumJS UniformState object
 * @returns {{ data: Float32Array, layout: object }}
 * @private
 */
function createUniformData(profileOrNames, uniformState) {
  const layout = getBufferLayout(profileOrNames);
  const data = new Float32Array(layout.alignedSize / 4);
  populateUniformBuffer(data, layout, uniformState);
  return { data, layout };
}

// =========================================================================
// GPU Buffer Helpers
// =========================================================================

/**
 * Creates a GPUBuffer sized for a uniform profile.
 *
 * @param {GPUDevice} device - WebGPU device
 * @param {string|string[]} profileOrNames - Profile name or uniform name array
 * @param {string} [label] - Debug label
 * @returns {{ buffer: GPUBuffer, layout: object }}
 * @private
 */
function createUniformBuffer(device, profileOrNames, label) {
  const layout = getBufferLayout(profileOrNames);
  // Minimum WebGPU UBO alignment is 256 bytes in some implementations
  const bufferSize = Math.max(layout.alignedSize, 256);

  const buffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: label || "AutoUniform Buffer",
  });

  return { buffer, layout };
}

/**
 * Updates a GPUBuffer with current uniform values from UniformState.
 *
 * @param {GPUDevice} device - WebGPU device
 * @param {GPUBuffer} buffer - Target uniform buffer
 * @param {object} layout - Buffer layout from computeBufferLayout()
 * @param {object} uniformState - CesiumJS UniformState
 * @param {Float32Array} [scratchArray] - Optional pre-allocated scratch array
 * @private
 */
function updateUniformBuffer(
  device,
  buffer,
  layout,
  uniformState,
  scratchArray,
) {
  const data = scratchArray || new Float32Array(layout.alignedSize / 4);
  populateUniformBuffer(data, layout, uniformState);
  device.queue.writeBuffer(buffer, 0, data.buffer, 0, layout.alignedSize);
}

// =========================================================================
// WGSL Declaration Generation
// =========================================================================

/**
 * Generates a WGSL struct declaration for a uniform profile.
 * Useful for dynamic shader generation (WGSLShaderBuilder).
 *
 * @param {string} structName - Name for the WGSL struct
 * @param {string|string[]} profileOrNames - Profile name or uniform names
 * @returns {string} WGSL struct code
 * @private
 */
function generateWGSLStruct(structName, profileOrNames) {
  const layout = getBufferLayout(profileOrNames);
  const typeToWGSL = {
    [WGSLType.f32]: "f32",
    [WGSLType.vec2f]: "vec2<f32>",
    [WGSLType.vec3f]: "vec3<f32>",
    [WGSLType.vec4f]: "vec4<f32>",
    [WGSLType.mat3x3f]: "mat3x3<f32>",
    [WGSLType.mat4x4f]: "mat4x4<f32>",
    [WGSLType.i32]: "i32",
    [WGSLType.vec2i]: "vec2<i32>",
    [WGSLType.vec3i]: "vec3<i32>",
    [WGSLType.vec4i]: "vec4<i32>",
  };

  let code = `struct ${structName} {\n`;
  for (let i = 0; i < layout.entries.length; i++) {
    const entry = layout.entries[i];
    const wgslTypeName = typeToWGSL[entry.type] || "f32";
    // Use the name without csm_ prefix as the field name
    const fieldName = entry.name.replace("csm_", "");
    code += `  ${fieldName}: ${wgslTypeName},\n`;
  }
  code += `};\n`;

  return code;
}

// =========================================================================
// Exports
// =========================================================================

const WebGPUAutoUniforms = {
  /**
   * All registered automatic uniforms.
   * @type {Object<string, {name, wgslType, getValue, pack}>}
   */
  AutoUniform,

  /**
   * WGSL type definitions with size/alignment info.
   */
  WGSLType,

  /**
   * Predefined uniform profiles.
   */
  UniformProfiles,

  /**
   * Compute a buffer layout for a set of uniforms.
   */
  computeBufferLayout,

  /**
   * Get or compute a cached buffer layout.
   */
  getBufferLayout,

  /**
   * Populate a Float32Array from UniformState.
   */
  populateUniformBuffer,

  /**
   * Create a Float32Array with uniform data.
   */
  createUniformData,

  /**
   * Create a GPUBuffer for a uniform profile.
   */
  createUniformBuffer,

  /**
   * Update a GPUBuffer with current UniformState values.
   */
  updateUniformBuffer,

  /**
   * Generate WGSL struct code for a profile.
   */
  generateWGSLStruct,

  /**
   * Look up a single automatic uniform by name.
   * @param {string} name - csm_* uniform name
   * @returns {object|undefined} Uniform definition or undefined
   */
  getUniform(name) {
    return AutoUniform[name];
  },

  /**
   * Check if a name is a registered automatic uniform.
   * @param {string} name
   * @returns {boolean}
   */
  isAutomatic(name) {
    return defined(AutoUniform[name]);
  },
};

export default WebGPUAutoUniforms;
export {
  AutoUniform,
  WGSLType,
  UniformProfiles,
  computeBufferLayout,
  getBufferLayout,
  populateUniformBuffer,
  createUniformData,
  createUniformBuffer,
  updateUniformBuffer,
  generateWGSLStruct,
};
