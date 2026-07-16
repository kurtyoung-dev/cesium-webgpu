import Frozen from "../Core/Frozen.js";

const limitDefaults = Object.freeze({
  maximumCombinedTextureImageUnits: 0,
  maximumCubeMapSize: 0,
  maximumFragmentUniformVectors: 0,
  maximumTextureImageUnits: 0,
  maximumRenderbufferSize: 0,
  maximumTextureSize: 0,
  maximum3DTextureSize: 0,
  maximumArrayTextureLayers: 0,
  maximumVaryingVectors: 0,
  maximumVertexAttributes: 0,
  maximumVertexTextureImageUnits: 0,
  maximumVertexUniformVectors: 0,
  minimumAliasedLineWidth: 1,
  maximumAliasedLineWidth: 1,
  minimumAliasedPointSize: 1,
  maximumAliasedPointSize: 1,
  maximumViewportWidth: 0,
  maximumViewportHeight: 0,
  maximumTextureFilterAnisotropy: 1,
  maximumDrawBuffers: 1,
  maximumColorAttachments: 1,
  maximumSamples: 0,
  highpFloatSupported: false,
  highpIntSupported: false,
});

const transcodeTargetNames = Object.freeze([
  "s3tc",
  "pvrtc",
  "astc",
  "etc",
  "etc1",
  "bc7",
]);

/**
 * Creates an immutable KTX2 target-format record with a stable cache key.
 *
 * @param {object} [formats] Supported target flags.
 * @returns {object} Frozen flags plus a stable `cacheKey`.
 */
function createKTX2TranscodeTargets(formats) {
  formats = formats ?? Frozen.EMPTY_OBJECT;
  let mask = 0;
  const result = {};
  for (let i = 0; i < transcodeTargetNames.length; i++) {
    const name = transcodeTargetNames[i];
    const supported = formats[name] === true;
    result[name] = supported;
    if (supported) {
      mask |= 1 << i;
    }
  }
  result.cacheKey = `ktx2-${mask.toString(16)}`;
  return Object.freeze(result);
}

/**
 * Creates the immutable capability record owned by one graphics context.
 * The object is intentionally data-only so JavaScript and TypeScript backends
 * can share it without a mutable singleton or backend imports.
 *
 * @param {object} [options] Numeric limits and feature records.
 * @returns {object} Frozen graphics-capability record.
 */
function createGraphicsCapabilities(options) {
  options = options ?? Frozen.EMPTY_OBJECT;
  const limits = {};
  for (const name of Object.keys(limitDefaults)) {
    limits[name] = options[name] ?? limitDefaults[name];
  }

  const ktx2TranscodeTargets = createKTX2TranscodeTargets(
    options.ktx2TranscodeTargets,
  );

  return Object.freeze({
    ...limits,
    ktx2TranscodeTargets,
    ktx2TranscodeTargetKey: ktx2TranscodeTargets.cacheKey,
    supportsBasis: transcodeTargetNames.some(
      (name) => ktx2TranscodeTargets[name],
    ),
  });
}

/**
 * Builds an immutable capability record from WebGPU device limits and enabled
 * features. A new frozen record may replace the old one after device recovery;
 * no record is mutated in place.
 *
 * @param {GPUDevice|object} device The initialized device.
 * @returns {object} Frozen graphics-capability record.
 */
function createWebGPUGraphicsCapabilities(device) {
  const limits = device.limits;
  const features = device.features;
  const has = (name) => features?.has?.(name) === true;

  return createGraphicsCapabilities({
    maximumTextureSize: limits.maxTextureDimension2D,
    maximumCubeMapSize: limits.maxTextureDimension2D,
    maximumRenderbufferSize: limits.maxTextureDimension2D,
    maximum3DTextureSize: limits.maxTextureDimension3D ?? 2048,
    maximumArrayTextureLayers: limits.maxTextureArrayLayers ?? 256,
    maximumTextureImageUnits: limits.maxSampledTexturesPerShaderStage,
    maximumVertexTextureImageUnits: limits.maxSampledTexturesPerShaderStage,
    maximumCombinedTextureImageUnits:
      limits.maxSampledTexturesPerShaderStage * 2,
    maximumVertexAttributes: limits.maxVertexAttributes,
    maximumViewportWidth: limits.maxTextureDimension2D,
    maximumViewportHeight: limits.maxTextureDimension2D,
    maximumFragmentUniformVectors: 1024,
    maximumVaryingVectors: 31,
    maximumVertexUniformVectors: 1024,
    maximumTextureFilterAnisotropy: 16,
    maximumDrawBuffers: limits.maxColorAttachments ?? 8,
    maximumColorAttachments: limits.maxColorAttachments ?? 8,
    maximumSamples: 4,
    highpFloatSupported: true,
    highpIntSupported: true,
    ktx2TranscodeTargets: {
      s3tc: has("texture-compression-bc"),
      pvrtc: false,
      astc: has("texture-compression-astc"),
      etc: has("texture-compression-etc2"),
      etc1: false,
      bc7: has("texture-compression-bc"),
    },
  });
}

const GraphicsCapabilities = Object.freeze({
  create: createGraphicsCapabilities,
  fromWebGPUDevice: createWebGPUGraphicsCapabilities,
  createKTX2TranscodeTargets,
  EMPTY: createGraphicsCapabilities(),
});

export default GraphicsCapabilities;
