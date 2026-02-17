/**
 * @module WebGPUPrimitiveShaders
 *
 * Shader selection logic, vertex layout configuration, and uniform buffer sizing
 * for the WebGPU Primitive rendering pipeline.
 *
 * All WGSL shader source code lives in `.wgsl` files under:
 *   Source/Shaders/WebGPU/Primitive/
 *
 * This module is a thin orchestrator that:
 * - Loads and caches WGSL shader source from .wgsl files at init time
 * - Provides shader selection based on geometry attributes and material type
 * - Defines vertex buffer layouts and uniform buffer sizes
 *
 * Shader categories:
 * - Per-instance color:  basic, phong, basicTextured, phongTextured
 * - Material:            matColorFlat/Lit, matImageFlat/Lit, matCheckerFlat/Lit, matGridFlat, matStripeFlat
 * - PBR:                 pbrSimple, pbrTextured
 * - Pick:                pickBasic/Phong/BasicTextured/PhongTextured/MatFlat/MatLit
 *
 * @private
 */
import defined from "../../Core/defined.js";

// =========================================================================
// Shader Cache — populated by initPrimitiveShaders()
// =========================================================================

const _shaderCache = {};
let _shadersLoaded = false;

/**
 * Base path for primitive WGSL shader files.
 * Adjusted at init time based on the runtime environment.
 * @type {string}
 * @private
 */
let _shaderBasePath = "Source/Shaders/WebGPU/Primitive/";

// Shader file manifest — maps shader key to filename
const SHADER_FILES = {
  // Per-instance color shaders
  basic: "PrimitiveBasicColor.wgsl",
  phong: "PrimitivePhongColor.wgsl",
  basicTextured: "PrimitiveBasicTexturedColor.wgsl",
  phongTextured: "PrimitivePhongTexturedColor.wgsl",
  // Pick shaders (per-instance color layouts)
  pickBasic: "PrimitivePickBasic.wgsl",
  pickPhong: "PrimitivePickPhong.wgsl",
  pickBasicTextured: "PrimitivePickBasicTextured.wgsl",
  pickPhongTextured: "PrimitivePickPhongTextured.wgsl",
  // Material shaders
  matColorFlat: "PrimitiveMatColorFlat.wgsl",
  matColorLit: "PrimitiveMatColorLit.wgsl",
  matImageFlat: "PrimitiveMatImageFlat.wgsl",
  matImageLit: "PrimitiveMatImageLit.wgsl",
  matCheckerFlat: "PrimitiveMatCheckerFlat.wgsl",
  matCheckerLit: "PrimitiveMatCheckerLit.wgsl",
  matGridFlat: "PrimitiveMatGridFlat.wgsl",
  matStripeFlat: "PrimitiveMatStripeFlat.wgsl",
  // Pick shaders (material layouts)
  pickMatFlat: "PrimitivePickMatFlat.wgsl",
  pickMatLit: "PrimitivePickMatLit.wgsl",
  // PBR shaders
  pbrSimple: "PrimitivePBRSimple.wgsl",
  pbrTextured: "PrimitivePBRTextured.wgsl",
};

// =========================================================================
// Shader Loading
// =========================================================================

/**
 * Initializes the primitive shader cache by fetching all .wgsl files.
 * Must be called once during WebGPU context initialization (e.g., from Scene.createAsync()).
 *
 * @param {string} [basePath] - Optional base URL path to the Shaders directory.
 *   Defaults to "Source/Shaders/WebGPU/Primitive/".
 * @returns {Promise<void>} Resolves when all shaders are loaded and cached.
 * @private
 */
async function initPrimitiveShaders(basePath) {
  if (_shadersLoaded) {
    return;
  }

  if (defined(basePath)) {
    _shaderBasePath = basePath;
  }

  const entries = Object.entries(SHADER_FILES);
  const fetchPromises = entries.map(async ([key, filename]) => {
    try {
      const url = `${_shaderBasePath}${filename}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[WebGPUPrimitiveShaders] Failed to load ${filename}: ${response.status}`,
        );
        return;
      }
      _shaderCache[key] = await response.text();
    } catch (e) {
      console.warn(
        `[WebGPUPrimitiveShaders] Error loading ${filename}:`,
        e.message,
      );
    }
  });

  await Promise.all(fetchPromises);
  _shadersLoaded = true;
}

/**
 * Returns the cached WGSL source for a shader key.
 * Throws if shaders haven't been initialized yet.
 *
 * @param {string} key - Shader key (e.g., 'basic', 'phong', 'matColorFlat', 'pbrSimple')
 * @returns {string} WGSL shader source code
 * @private
 */
function getShaderSource(key) {
  const source = _shaderCache[key];
  if (!defined(source)) {
    // If shaders aren't loaded yet, provide a helpful error
    if (!_shadersLoaded) {
      throw new Error(
        `[WebGPUPrimitiveShaders] Shaders not loaded. Call initPrimitiveShaders() first.`,
      );
    }
    throw new Error(
      `[WebGPUPrimitiveShaders] Unknown shader key: "${key}". Available: ${Object.keys(_shaderCache).join(", ")}`,
    );
  }
  return source;
}

/**
 * Returns true if the shader cache has been populated.
 * @returns {boolean}
 * @private
 */
function areShadersLoaded() {
  return _shadersLoaded;
}

// =========================================================================
// Per-Instance Color Shader Selection
// =========================================================================

/**
 * Determines which WGSL shader to use based on available geometry attributes.
 * Shader selection hierarchy:
 * - phongTextured: position + normal + st → Phong lighting + texture sampling
 * - basicTextured: position + st → Texture sampling + color
 * - phong: position + normal → Phong lighting + color
 * - basic: position → Color only
 *
 * @param {object} attributes - Geometry attributes
 * @returns {{ type: string, code: string, hasUV: boolean }} Shader type, WGSL code, and UV flag
 * @private
 */
function selectWebGPUShader(attributes) {
  const hasNormals =
    defined(attributes.normal) && defined(attributes.normal.values);
  const hasST = defined(attributes.st) && defined(attributes.st.values);

  if (hasNormals && hasST) {
    return {
      type: "phongTextured",
      code: getShaderSource("phongTextured"),
      hasUV: true,
    };
  }
  if (hasST) {
    return {
      type: "basicTextured",
      code: getShaderSource("basicTextured"),
      hasUV: true,
    };
  }
  if (hasNormals) {
    return { type: "phong", code: getShaderSource("phong"), hasUV: false };
  }
  return { type: "basic", code: getShaderSource("basic"), hasUV: false };
}

// =========================================================================
// Vertex Layout Configurations
// =========================================================================

/**
 * Returns the vertex buffer layout descriptor for a given shader type.
 *
 * @param {string} shaderType - Shader type identifier
 * @returns {{ floatsPerVertex: number, stride: number, layout: GPUVertexBufferLayout }}
 * @private
 */
function getVertexLayoutForShader(shaderType) {
  if (shaderType === "phongTextured") {
    // position(3) + normal(3) + uv(2) + color(4) = 12 floats = 48 bytes
    return {
      floatsPerVertex: 12,
      stride: 48,
      layout: {
        arrayStride: 48,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
          { shaderLocation: 2, offset: 24, format: "float32x2" },
          { shaderLocation: 3, offset: 32, format: "float32x4" },
        ],
      },
    };
  }
  if (shaderType === "basicTextured") {
    // position(3) + uv(2) + color(4) = 9 floats = 36 bytes
    return {
      floatsPerVertex: 9,
      stride: 36,
      layout: {
        arrayStride: 36,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x2" },
          { shaderLocation: 2, offset: 20, format: "float32x4" },
        ],
      },
    };
  }
  if (shaderType === "phong") {
    // position(3) + normal(3) + color(4) = 10 floats = 40 bytes
    return {
      floatsPerVertex: 10,
      stride: 40,
      layout: {
        arrayStride: 40,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
          { shaderLocation: 2, offset: 24, format: "float32x4" },
        ],
      },
    };
  }
  // basic: position(3) + color(4) = 7 floats = 28 bytes
  return {
    floatsPerVertex: 7,
    stride: 28,
    layout: {
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x4" },
      ],
    },
  };
}

/**
 * Returns the uniform buffer size for a given shader type (256-byte aligned).
 * @param {string} shaderType
 * @returns {number}
 * @private
 */
function getUniformSizeForShader(shaderType) {
  // All shader types use 256-byte uniform buffers
  return 256;
}

/**
 * Returns true if the shader type uses Phong lighting (needs normal matrix uniforms).
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isPhongShader(shaderType) {
  return shaderType === "phong" || shaderType === "phongTextured";
}

/**
 * Returns true if the shader type needs a texture bind group (group 1).
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isTexturedShader(shaderType) {
  return shaderType === "basicTextured" || shaderType === "phongTextured";
}

// =========================================================================
// Pick Shader Selection
// =========================================================================

/**
 * Returns the WGSL pick shader code for a given color shader type.
 * @param {string} shaderType - Color shader type
 * @returns {string} WGSL pick shader source
 * @private
 */
function getPickShaderForType(shaderType) {
  if (shaderType === "phongTextured") {
    return getShaderSource("pickPhongTextured");
  }
  if (shaderType === "basicTextured") {
    return getShaderSource("pickBasicTextured");
  }
  if (shaderType === "phong") {
    return getShaderSource("pickPhong");
  }
  return getShaderSource("pickBasic");
}

/**
 * Returns the WGSL pick shader code for a material shader type.
 * @param {string} shaderType - Material shader type
 * @returns {string} WGSL pick shader source
 * @private
 */
function getMaterialPickShaderForType(shaderType) {
  if (isMaterialLitShader(shaderType) || isPBRShader(shaderType)) {
    return getShaderSource("pickMatLit");
  }
  return getShaderSource("pickMatFlat");
}

/**
 * Returns the uniform buffer size for pick shaders (256-byte aligned).
 * @returns {number}
 * @private
 */
function getPickUniformSize() {
  return 256;
}

// =========================================================================
// Material Shader Selection
// =========================================================================

/**
 * Determines which WGSL material shader to use based on material type and geometry attributes.
 *
 * @param {object} material - The CesiumJS Material object
 * @param {boolean} isFlat - Whether the appearance uses flat shading
 * @param {boolean} hasNormals - Whether the geometry has normals
 * @param {boolean} hasST - Whether the geometry has texture coordinates
 * @returns {{ type: string, code: string, needsTexture: boolean }} Shader info
 * @private
 */
function selectMaterialShader(material, isFlat, hasNormals, hasST) {
  const materialType = defined(material) ? material.type : "Color";
  const useLighting = hasNormals && !isFlat;

  if (materialType === "Image" || materialType === "DiffuseMap") {
    if (useLighting && hasST) {
      return {
        type: "matImageLit",
        code: getShaderSource("matImageLit"),
        needsTexture: true,
      };
    }
    return {
      type: "matImageFlat",
      code: getShaderSource("matImageFlat"),
      needsTexture: true,
    };
  }

  if (materialType === "Checkerboard") {
    if (useLighting && hasST) {
      return {
        type: "matCheckerLit",
        code: getShaderSource("matCheckerLit"),
        needsTexture: false,
      };
    }
    return {
      type: "matCheckerFlat",
      code: getShaderSource("matCheckerFlat"),
      needsTexture: false,
    };
  }

  if (materialType === "Grid") {
    return {
      type: "matGridFlat",
      code: getShaderSource("matGridFlat"),
      needsTexture: false,
    };
  }

  if (materialType === "Stripe") {
    return {
      type: "matStripeFlat",
      code: getShaderSource("matStripeFlat"),
      needsTexture: false,
    };
  }

  // Color material (default)
  if (useLighting && hasST) {
    return {
      type: "matColorLit",
      code: getShaderSource("matColorLit"),
      needsTexture: false,
    };
  }
  return {
    type: "matColorFlat",
    code: getShaderSource("matColorFlat"),
    needsTexture: false,
  };
}

/**
 * Returns the vertex buffer layout for material shaders (no per-vertex color).
 * @param {string} shaderType - Material shader type
 * @returns {{ floatsPerVertex: number, stride: number, layout: GPUVertexBufferLayout }}
 * @private
 */
function getMaterialVertexLayout(shaderType) {
  if (isMaterialLitShader(shaderType) || isPBRShader(shaderType)) {
    // position(3) + normal(3) + st(2) = 8 floats = 32 bytes
    return {
      floatsPerVertex: 8,
      stride: 32,
      layout: {
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
          { shaderLocation: 2, offset: 24, format: "float32x2" },
        ],
      },
    };
  }

  // Flat variants: position(3) + st(2) = 5 floats = 20 bytes
  return {
    floatsPerVertex: 5,
    stride: 20,
    layout: {
      arrayStride: 20,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x2" },
      ],
    },
  };
}

/**
 * Returns the uniform buffer size for material shaders (256-byte aligned).
 * @param {string} shaderType
 * @returns {number}
 * @private
 */
function getMaterialUniformSize(shaderType) {
  return 256;
}

/**
 * Returns true if a material shader type uses Phong lighting.
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialLitShader(shaderType) {
  return defined(shaderType) && shaderType.endsWith("Lit");
}

/**
 * Returns true if a shader type is a material shader (starts with "mat").
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialShader(shaderType) {
  return defined(shaderType) && shaderType.startsWith("mat");
}

/**
 * Returns true if a material shader needs a texture bind group (group 1).
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isMaterialTexturedShader(shaderType) {
  return shaderType === "matImageFlat" || shaderType === "matImageLit";
}

// =========================================================================
// PBR Shader Selection
// =========================================================================

/**
 * Returns true if a shader type is a PBR shader.
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isPBRShader(shaderType) {
  return shaderType === "pbrSimple" || shaderType === "pbrTextured";
}

/**
 * Returns true if a PBR shader needs a texture bind group (group 1).
 * @param {string} shaderType
 * @returns {boolean}
 * @private
 */
function isPBRTexturedShader(shaderType) {
  return shaderType === "pbrTextured";
}

/**
 * Selects the appropriate PBR shader.
 * @param {boolean} hasBaseColorTexture - Whether a base color texture is available
 * @returns {{ type: string, code: string, needsTexture: boolean }}
 * @private
 */
function selectPBRShader(hasBaseColorTexture) {
  if (hasBaseColorTexture) {
    return {
      type: "pbrTextured",
      code: getShaderSource("pbrTextured"),
      needsTexture: true,
    };
  }
  return {
    type: "pbrSimple",
    code: getShaderSource("pbrSimple"),
    needsTexture: false,
  };
}

// =========================================================================
// Exports
// =========================================================================

const WebGPUPrimitiveShaders = {
  // Initialization
  initPrimitiveShaders,
  areShadersLoaded,
  getShaderSource,
  // Per-instance color
  selectWebGPUShader,
  getVertexLayoutForShader,
  getUniformSizeForShader,
  isPhongShader,
  isTexturedShader,
  // Pick
  getPickShaderForType,
  getMaterialPickShaderForType,
  getPickUniformSize,
  // Material
  selectMaterialShader,
  getMaterialVertexLayout,
  getMaterialUniformSize,
  isMaterialLitShader,
  isMaterialShader,
  isMaterialTexturedShader,
  // PBR
  isPBRShader,
  isPBRTexturedShader,
  selectPBRShader,
};

export default WebGPUPrimitiveShaders;
export {
  initPrimitiveShaders,
  areShadersLoaded,
  getShaderSource,
  selectWebGPUShader,
  getVertexLayoutForShader,
  getUniformSizeForShader,
  isPhongShader,
  isTexturedShader,
  getPickShaderForType,
  getMaterialPickShaderForType,
  getPickUniformSize,
  selectMaterialShader,
  getMaterialVertexLayout,
  getMaterialUniformSize,
  isMaterialLitShader,
  isMaterialShader,
  isMaterialTexturedShader,
  isPBRShader,
  isPBRTexturedShader,
  selectPBRShader,
};
