/**
 * @module ModelMaterialInfo
 *
 * Renderer-agnostic material descriptor for glTF models.
 * Extracts material properties from ModelComponents.Material into a flat data
 * object that both WebGL and WebGPU renderers can consume.
 *
 * This separates "what material properties does this glTF primitive have?"
 * (shared logic) from "how do we create GPU resources for those properties?"
 * (renderer-specific).
 *
 * @private
 */
import defined from "../../Core/defined.js";

/**
 * Material flag constants matching the WGSL shader bitfield.
 * Used by both WebGL and WebGPU renderers.
 */
const MaterialFlags = Object.freeze({
  HAS_BASE_COLOR_TEXTURE: 1,
  HAS_NORMAL_TEXTURE: 2,
  HAS_METALLIC_ROUGHNESS_TEXTURE: 4,
  HAS_EMISSIVE_TEXTURE: 8,
  HAS_OCCLUSION_TEXTURE: 16,
  HAS_VERTEX_COLORS: 32,
  ALPHA_MODE_MASK: 64,
  ALPHA_MODE_BLEND: 128,
  IS_DOUBLE_SIDED: 256,
  IS_UNLIT: 512,
  USE_SPECULAR_GLOSSINESS: 1024,
  HAS_SPECGLOSS_TEXTURE: 2048,
  HAS_DIFFUSE_TEXTURE: 4096,
});

/**
 * Alpha mode constants matching glTF spec.
 */
const AlphaModes = Object.freeze({
  OPAQUE: 0,
  MASK: 1,
  BLEND: 2,
});

/**
 * Extracts a renderer-agnostic material descriptor from a ModelComponents.Material.
 *
 * @param {ModelComponents.Material} material - The parsed glTF material
 * @param {boolean} hasVertexColors - Whether the primitive has COLOR_0 attribute
 * @param {boolean} hasNormals - Whether the primitive has NORMAL attribute
 * @returns {ModelMaterialInfo} Flat material descriptor
 */
function extractMaterialInfo(material, hasVertexColors, hasNormals) {
  const info = {
    // Material type
    isUnlit: material.unlit === true,
    isSpecularGlossiness: defined(material.specularGlossiness),
    isDoubleSided: material.doubleSided === true,

    // Alpha
    alphaMode: AlphaModes.OPAQUE,
    alphaCutoff: 0.5,

    // Metallic-Roughness factors
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 1.0,
    roughnessFactor: 1.0,

    // Emissive
    emissiveFactor: [0, 0, 0],

    // Normal / Occlusion
    normalScale: 1.0,
    occlusionStrength: 1.0,

    // Specular-Glossiness factors (if applicable)
    specularFactor: [1, 1, 1],
    glossinessFactor: 1.0,
    diffuseFactor: [1, 1, 1, 1],

    // Texture availability
    hasBaseColorTexture: false,
    hasNormalTexture: false,
    hasMetallicRoughnessTexture: false,
    hasEmissiveTexture: false,
    hasOcclusionTexture: false,
    hasSpecGlossTexture: false,
    hasDiffuseTexture: false,
    hasVertexColors: hasVertexColors === true,

    // Texture readers (for accessing image sources)
    baseColorTextureReader: null,
    normalTextureReader: null,
    metallicRoughnessTextureReader: null,
    emissiveTextureReader: null,
    occlusionTextureReader: null,
    specGlossTextureReader: null,
    diffuseTextureReader: null,

    // Computed flags bitfield (for shader uniform)
    materialFlags: 0,
  };

  if (!defined(material)) {
    info.materialFlags = computeFlags(info);
    return info;
  }

  // Alpha mode
  const alphaMode = material.alphaMode;
  if (alphaMode === "MASK" || alphaMode === 1) {
    info.alphaMode = AlphaModes.MASK;
    info.alphaCutoff = material.alphaCutoff ?? 0.5;
  } else if (alphaMode === "BLEND" || alphaMode === 2) {
    info.alphaMode = AlphaModes.BLEND;
  }

  // Emissive
  const ef = material.emissiveFactor;
  if (defined(ef)) {
    info.emissiveFactor = [
      ef.x ?? ef[0] ?? 0,
      ef.y ?? ef[1] ?? 0,
      ef.z ?? ef[2] ?? 0,
    ];
  }
  if (defined(material.emissiveTexture)) {
    info.hasEmissiveTexture = true;
    info.emissiveTextureReader = material.emissiveTexture;
  }

  // Normal texture
  if (defined(material.normalTexture) && hasNormals) {
    info.hasNormalTexture = true;
    info.normalTextureReader = material.normalTexture;
    info.normalScale = material.normalTexture.scale ?? 1.0;
  }

  // Occlusion texture
  if (defined(material.occlusionTexture)) {
    info.hasOcclusionTexture = true;
    info.occlusionTextureReader = material.occlusionTexture;
    info.occlusionStrength = material.occlusionTexture.strength ?? 1.0;
  }

  // Specular-Glossiness path
  if (info.isSpecularGlossiness) {
    const sg = material.specularGlossiness;
    const df = sg.diffuseFactor;
    if (defined(df)) {
      info.diffuseFactor = [
        df.x ?? df.red ?? df[0] ?? 1,
        df.y ?? df.green ?? df[1] ?? 1,
        df.z ?? df.blue ?? df[2] ?? 1,
        df.w ?? df.alpha ?? df[3] ?? 1,
      ];
    }
    const sf = sg.specularFactor;
    if (defined(sf)) {
      info.specularFactor = [
        sf.x ?? sf[0] ?? 1,
        sf.y ?? sf[1] ?? 1,
        sf.z ?? sf[2] ?? 1,
      ];
    }
    info.glossinessFactor = sg.glossinessFactor ?? 1.0;

    if (defined(sg.diffuseTexture)) {
      info.hasDiffuseTexture = true;
      info.diffuseTextureReader = sg.diffuseTexture;
    }
    if (defined(sg.specularGlossinessTexture)) {
      info.hasSpecGlossTexture = true;
      info.specGlossTextureReader = sg.specularGlossinessTexture;
    }
  } else {
    // Metallic-Roughness path
    const mr = material.metallicRoughness;
    if (defined(mr)) {
      const bc = mr.baseColorFactor;
      if (defined(bc)) {
        info.baseColorFactor = [
          bc.x ?? bc.red ?? bc[0] ?? 1,
          bc.y ?? bc.green ?? bc[1] ?? 1,
          bc.z ?? bc.blue ?? bc[2] ?? 1,
          bc.w ?? bc.alpha ?? bc[3] ?? 1,
        ];
      }
      info.metallicFactor = mr.metallicFactor ?? 1.0;
      info.roughnessFactor = mr.roughnessFactor ?? 1.0;

      if (defined(mr.baseColorTexture)) {
        info.hasBaseColorTexture = true;
        info.baseColorTextureReader = mr.baseColorTexture;
      }
      if (defined(mr.metallicRoughnessTexture)) {
        info.hasMetallicRoughnessTexture = true;
        info.metallicRoughnessTextureReader = mr.metallicRoughnessTexture;
      }
    }
  }

  info.materialFlags = computeFlags(info);
  return info;
}

/**
 * Computes the materialFlags bitfield from the material info.
 * @param {object} info
 * @returns {number}
 */
function computeFlags(info) {
  let flags = 0;
  if (info.hasBaseColorTexture || info.hasDiffuseTexture) {
    flags |= MaterialFlags.HAS_BASE_COLOR_TEXTURE;
  }
  if (info.hasNormalTexture) {
    flags |= MaterialFlags.HAS_NORMAL_TEXTURE;
  }
  if (info.hasMetallicRoughnessTexture) {
    flags |= MaterialFlags.HAS_METALLIC_ROUGHNESS_TEXTURE;
  }
  if (info.hasEmissiveTexture) {
    flags |= MaterialFlags.HAS_EMISSIVE_TEXTURE;
  }
  if (info.hasOcclusionTexture) {
    flags |= MaterialFlags.HAS_OCCLUSION_TEXTURE;
  }
  if (info.hasVertexColors) {
    flags |= MaterialFlags.HAS_VERTEX_COLORS;
  }
  if (info.alphaMode === AlphaModes.MASK) {
    flags |= MaterialFlags.ALPHA_MODE_MASK;
  }
  if (info.alphaMode === AlphaModes.BLEND) {
    flags |= MaterialFlags.ALPHA_MODE_BLEND;
  }
  if (info.isDoubleSided) {
    flags |= MaterialFlags.IS_DOUBLE_SIDED;
  }
  if (info.isUnlit) {
    flags |= MaterialFlags.IS_UNLIT;
  }
  if (info.isSpecularGlossiness) {
    flags |= MaterialFlags.USE_SPECULAR_GLOSSINESS;
  }
  if (info.hasSpecGlossTexture) {
    flags |= MaterialFlags.HAS_SPECGLOSS_TEXTURE;
  }
  if (info.hasDiffuseTexture) {
    flags |= MaterialFlags.HAS_DIFFUSE_TEXTURE;
  }
  return flags;
}

export { extractMaterialInfo, MaterialFlags, AlphaModes };
export default { extractMaterialInfo, MaterialFlags, AlphaModes };
