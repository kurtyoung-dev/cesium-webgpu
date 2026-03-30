/**
 * @module WebGPUCollectionShaders
 *
 * Shader loader for WebGPU collection rendering (PointPrimitive, Billboard, Polyline).
 * Follows the same pattern as WebGPUPrimitiveShaders.js — fetches .wgsl files at init time,
 * caches them, and provides access via key lookup.
 *
 * Shader files live in: Source/Shaders/WebGPU/Collections/
 *
 * @private
 */
import defined from "../../Core/defined.js";

// =========================================================================
// Shader Cache
// =========================================================================

const _shaderCache = {};
let _shadersLoaded = false;
let _shaderBasePath = "Source/Shaders/WebGPU/Collections/";

// Shader file manifest — maps shader key to filename
const SHADER_FILES = {
  // Point primitive shaders
  pointColor: "PointPrimitiveColor.wgsl",
  pointPick: "PointPrimitivePick.wgsl",
  // Billboard shaders
  billboardColor: "BillboardCollection.wgsl",
  billboardPick: "BillboardCollectionPick.wgsl",
  // Polyline shaders
  polylineColor: "PolylineCollection.wgsl",
  polylinePick: "PolylineCollectionPick.wgsl",
  // Polyline material shaders
  polylineArrow: "PolylineArrow.wgsl",
  polylineDash: "PolylineDash.wgsl",
  polylineGlow: "PolylineGlow.wgsl",
  polylineOutline: "PolylineOutline.wgsl",
};

// =========================================================================
// Shader Loading
// =========================================================================

/**
 * Initializes the collection shader cache by fetching all .wgsl files.
 * Must be called once during WebGPU context initialization (from Scene.createAsync()).
 *
 * @param {string} [basePath] - Optional base URL path to the Collections shader directory.
 * @returns {Promise<void>} Resolves when all shaders are loaded and cached.
 * @private
 */
async function initCollectionShaders(basePath) {
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
          `[WebGPUCollectionShaders] Failed to load ${filename}: ${response.status}`,
        );
        return;
      }
      _shaderCache[key] = await response.text();
    } catch (e) {
      console.warn(
        `[WebGPUCollectionShaders] Error loading ${filename}:`,
        e.message,
      );
    }
  });

  await Promise.all(fetchPromises);
  _shadersLoaded = true;
}

/**
 * Returns the cached WGSL source for a collection shader key.
 * @param {string} key - Shader key (e.g., 'pointColor', 'pointPick')
 * @returns {string} WGSL shader source code
 * @private
 */
function getCollectionShaderSource(key) {
  const source = _shaderCache[key];
  if (!defined(source)) {
    if (!_shadersLoaded) {
      throw new Error(
        `[WebGPUCollectionShaders] Shaders not loaded. Call initCollectionShaders() first.`,
      );
    }
    throw new Error(
      `[WebGPUCollectionShaders] Unknown shader key: "${key}". Available: ${Object.keys(_shaderCache).join(", ")}`,
    );
  }
  return source;
}

/**
 * Returns true if the collection shader cache has been populated.
 * @returns {boolean}
 * @private
 */
function areCollectionShadersLoaded() {
  return _shadersLoaded;
}

// =========================================================================
// Exports
// =========================================================================

export {
  initCollectionShaders,
  getCollectionShaderSource,
  areCollectionShadersLoaded,
};

export default {
  initCollectionShaders,
  getCollectionShaderSource,
  areCollectionShadersLoaded,
};
