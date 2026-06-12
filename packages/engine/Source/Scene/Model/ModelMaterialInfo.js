/**
 * Renderer-agnostic material descriptor for glTF models.
 * Extracts material properties from ModelComponents.Material into a flat data
 * object that both WebGL and WebGPU renderers can consume.
 *
 * This separates "what material properties does this glTF primitive have?"
 * (shared logic) from "how do we create GPU resources for those properties?"
 * (renderer-specific).
 *
 * @private
 * @module ModelMaterialInfo
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
  // Bit 13 (8192) is HAS_SKINNING — set by WebGPUModelRenderer, not here
  HAS_MORPH_TARGETS: 16384, // Bit 14 — morph target blending in vertex shader
  // Bit 15 (32768) is HAS_INSTANCING — set by WebGPUModelRenderer, not here
  HAS_FEATURE_ID_TEXTURE: 65536, // Bit 16 — feature IDs from texture (EXT_mesh_features)
  HAS_FEATURE_ID_ATTRIBUTE: 131072, // Bit 17 — feature IDs from vertex attribute
  HAS_BATCH_TABLE: 262144, // Bit 18 — batch texture for per-feature styling
  // C-R4-GLTF-KHR (slices 2-7). One bit per extension enable; the FS
  // skips each extension's lighting contribution when the bit is unset
  // so identity-default values are branch-light. Texture availability
  // for each extension lives in a separate per-extension flags word
  // (extensionTextureFlags), not here.
  HAS_CLEARCOAT: 524288, // Bit 19 — KHR_materials_clearcoat
  HAS_SPECULAR: 1048576, // Bit 20 — KHR_materials_specular
  HAS_ANISOTROPY: 2097152, // Bit 21 — KHR_materials_anisotropy
  HAS_IRIDESCENCE: 4194304, // Bit 22 — KHR_materials_iridescence
  HAS_SHEEN: 8388608, // Bit 23 — KHR_materials_sheen
  HAS_VOLUME: 16777216, // Bit 24 — KHR_materials_volume
  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105) — gates the FS refraction
  // sampling branch. Transmission samples the prior-pass scene color
  // (see refraction MRT scaffolding in WebGPUSceneFramebuffer) at a
  // refracted UV offset. When the bit is unset the transmission
  // factor is 0 and the FS path is dead code.
  HAS_TRANSMISSION: 33554432, // Bit 25 — KHR_materials_transmission
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

    // C-R4-GLTF-KHR (slices 2-7). KHR material extensions: each block is
    // populated only when the asset advertises the corresponding
    // extension; otherwise factors retain identity-default values and
    // the matching `materialFlags` bit stays unset so the FS skips the
    // extension's contribution.
    //
    // KHR_materials_clearcoat (slice 2, Batch 95) — second specular lobe
    // simulating an automotive-grade clear coating over the base
    // material. Independent roughness from the base; uses the standard
    // F0 = 0.04 air-coat fresnel term.
    hasClearcoat: false,
    clearcoatFactor: 0.0,
    clearcoatRoughnessFactor: 0.0,
    clearcoatNormalScale: 1.0,
    clearcoatTextureReader: null,
    clearcoatRoughnessTextureReader: null,
    clearcoatNormalTextureReader: null,
    hasClearcoatTexture: false,
    hasClearcoatRoughnessTexture: false,
    hasClearcoatNormalTexture: false,

    // KHR_materials_specular (slice 3) — overrides the dielectric F0
    // intensity (specularFactor) and tints F0 chromatically (color).
    // Takes precedence over the spec-gloss workflow's per-channel F0.
    hasSpecularExt: false,
    specularExtFactor: 1.0,
    specularExtColorFactor: [1, 1, 1],
    specularExtTextureReader: null,
    specularExtColorTextureReader: null,
    hasSpecularExtTexture: false,
    hasSpecularExtColorTexture: false,

    // KHR_materials_anisotropy (slice 4) — directional roughness for
    // brushed-metal style materials. Strength controls the anisotropy
    // amount; rotation rotates the tangent frame around the geometric
    // normal. The texture (when present) carries (cos, sin, strength)
    // in (R, G, B).
    hasAnisotropy: false,
    anisotropyStrength: 0.0,
    anisotropyRotation: 0.0,
    anisotropyTextureReader: null,
    hasAnisotropyTexture: false,

    // KHR_materials_iridescence (slice 5) — thin-film interference for
    // soap-bubble/oil-slick effects. Modulates F0 by a wavelength-
    // dependent term derived from film thickness × ior.
    hasIridescence: false,
    iridescenceFactor: 0.0,
    iridescenceIor: 1.3,
    iridescenceThicknessMinimum: 100.0,
    iridescenceThicknessMaximum: 400.0,
    iridescenceTextureReader: null,
    iridescenceThicknessTextureReader: null,
    hasIridescenceTexture: false,
    hasIridescenceThicknessTexture: false,

    // KHR_materials_sheen (slice 6) — Charlie BRDF lobe for fabric /
    // velvet retroreflection. Energy-additive on top of the base lit
    // contribution.
    hasSheen: false,
    sheenColorFactor: [0, 0, 0],
    sheenRoughnessFactor: 0.0,
    sheenColorTextureReader: null,
    sheenRoughnessTextureReader: null,
    hasSheenColorTexture: false,
    hasSheenRoughnessTexture: false,

    // KHR_materials_volume (slice 7) — volumetric attenuation through a
    // refractive volume. Pairs with KHR_materials_transmission for the
    // refraction direction; consumed here primarily as Beer-Lambert
    // attenuation against `attenuationColor` over `attenuationDistance`.
    hasVolume: false,
    thicknessFactor: 0.0,
    attenuationDistance: Number.POSITIVE_INFINITY,
    attenuationColor: [1, 1, 1],
    thicknessTextureReader: null,
    hasThicknessTexture: false,

    // KHR_materials_transmission (Batch 105) — light passing through
    // a thin or thick volume. The FS samples a copy of the prior-pass
    // scene color (refraction MRT) at an offset based on the surface
    // normal + IOR, then blends with the diffuse contribution by
    // `transmissionFactor`. transmissionTexture (R) modulates the
    // factor per-pixel.
    hasTransmission: false,
    transmissionFactor: 0.0,
    transmissionTextureReader: null,
    hasTransmissionTexture: false,

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

  // C-R4-GLTF-KHR (slices 2-7). The model loader (`GltfLoader`) sets the
  // matching slot on `material.*` only when the asset declares the
  // corresponding KHR extension; the same slot is populated for both
  // metallic-roughness and spec-gloss workflows. We read identity
  // defaults when an extension is absent (no flag bit set, FS branch
  // is skipped).
  const cc = material.clearcoat;
  if (defined(cc) && cc.clearcoatFactor > 0.0) {
    info.hasClearcoat = true;
    info.clearcoatFactor = cc.clearcoatFactor;
    info.clearcoatRoughnessFactor = cc.clearcoatRoughnessFactor ?? 0.0;
    if (defined(cc.clearcoatTexture)) {
      info.hasClearcoatTexture = true;
      info.clearcoatTextureReader = cc.clearcoatTexture;
    }
    if (defined(cc.clearcoatRoughnessTexture)) {
      info.hasClearcoatRoughnessTexture = true;
      info.clearcoatRoughnessTextureReader = cc.clearcoatRoughnessTexture;
    }
    if (defined(cc.clearcoatNormalTexture)) {
      info.hasClearcoatNormalTexture = true;
      info.clearcoatNormalTextureReader = cc.clearcoatNormalTexture;
      info.clearcoatNormalScale = cc.clearcoatNormalTexture.scale ?? 1.0;
    }
  }

  const spx = material.specular;
  if (defined(spx)) {
    info.hasSpecularExt = true;
    info.specularExtFactor = spx.specularFactor ?? 1.0;
    const sc = spx.specularColorFactor;
    if (defined(sc)) {
      info.specularExtColorFactor = [
        sc.x ?? sc.red ?? sc[0] ?? 1,
        sc.y ?? sc.green ?? sc[1] ?? 1,
        sc.z ?? sc.blue ?? sc[2] ?? 1,
      ];
    }
    if (defined(spx.specularTexture)) {
      info.hasSpecularExtTexture = true;
      info.specularExtTextureReader = spx.specularTexture;
    }
    if (defined(spx.specularColorTexture)) {
      info.hasSpecularExtColorTexture = true;
      info.specularExtColorTextureReader = spx.specularColorTexture;
    }
  }

  const an = material.anisotropy;
  if (defined(an) && an.anisotropyStrength > 0.0) {
    info.hasAnisotropy = true;
    info.anisotropyStrength = an.anisotropyStrength;
    info.anisotropyRotation = an.anisotropyRotation ?? 0.0;
    if (defined(an.anisotropyTexture)) {
      info.hasAnisotropyTexture = true;
      info.anisotropyTextureReader = an.anisotropyTexture;
    }
  }

  const ir = material.iridescence;
  if (defined(ir) && ir.iridescenceFactor > 0.0) {
    info.hasIridescence = true;
    info.iridescenceFactor = ir.iridescenceFactor;
    info.iridescenceIor = ir.iridescenceIor ?? 1.3;
    info.iridescenceThicknessMinimum = ir.iridescenceThicknessMinimum ?? 100.0;
    info.iridescenceThicknessMaximum = ir.iridescenceThicknessMaximum ?? 400.0;
    if (defined(ir.iridescenceTexture)) {
      info.hasIridescenceTexture = true;
      info.iridescenceTextureReader = ir.iridescenceTexture;
    }
    if (defined(ir.iridescenceThicknessTexture)) {
      info.hasIridescenceThicknessTexture = true;
      info.iridescenceThicknessTextureReader = ir.iridescenceThicknessTexture;
    }
  }

  const sh = material.sheen;
  if (defined(sh)) {
    const scf = sh.sheenColorFactor;
    let scfArr = [0, 0, 0];
    if (defined(scf)) {
      scfArr = [
        scf.x ?? scf.red ?? scf[0] ?? 0,
        scf.y ?? scf.green ?? scf[1] ?? 0,
        scf.z ?? scf.blue ?? scf[2] ?? 0,
      ];
    }
    // Skip when fully default (zero color) — sheen is purely additive,
    // so a zero color contributes nothing and the FS branch is wasted.
    if (scfArr[0] > 0.0 || scfArr[1] > 0.0 || scfArr[2] > 0.0) {
      info.hasSheen = true;
      info.sheenColorFactor = scfArr;
      info.sheenRoughnessFactor = sh.sheenRoughnessFactor ?? 0.0;
      if (defined(sh.sheenColorTexture)) {
        info.hasSheenColorTexture = true;
        info.sheenColorTextureReader = sh.sheenColorTexture;
      }
      if (defined(sh.sheenRoughnessTexture)) {
        info.hasSheenRoughnessTexture = true;
        info.sheenRoughnessTextureReader = sh.sheenRoughnessTexture;
      }
    }
  }

  const vol = material.volume;
  if (defined(vol) && vol.thicknessFactor > 0.0) {
    info.hasVolume = true;
    info.thicknessFactor = vol.thicknessFactor;
    info.attenuationDistance =
      vol.attenuationDistance ?? Number.POSITIVE_INFINITY;
    const ac = vol.attenuationColor;
    if (defined(ac)) {
      info.attenuationColor = [
        ac.x ?? ac.red ?? ac[0] ?? 1,
        ac.y ?? ac.green ?? ac[1] ?? 1,
        ac.z ?? ac.blue ?? ac[2] ?? 1,
      ];
    }
    if (defined(vol.thicknessTexture)) {
      info.hasThicknessTexture = true;
      info.thicknessTextureReader = vol.thicknessTexture;
    }
  }

  // C-R4-GLTF-KHR-TRANSMISSION (Batch 105). The loader populates
  // `material.transmission` as a plain object with
  // `{ transmissionFactor, transmissionTexture }`.
  const tr = material.transmission;
  if (defined(tr) && tr.transmissionFactor > 0.0) {
    info.hasTransmission = true;
    info.transmissionFactor = tr.transmissionFactor;
    if (defined(tr.transmissionTexture)) {
      info.hasTransmissionTexture = true;
      info.transmissionTextureReader = tr.transmissionTexture;
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
  if (info.hasClearcoat) {
    flags |= MaterialFlags.HAS_CLEARCOAT;
  }
  if (info.hasSpecularExt) {
    flags |= MaterialFlags.HAS_SPECULAR;
  }
  if (info.hasAnisotropy) {
    flags |= MaterialFlags.HAS_ANISOTROPY;
  }
  if (info.hasIridescence) {
    flags |= MaterialFlags.HAS_IRIDESCENCE;
  }
  if (info.hasSheen) {
    flags |= MaterialFlags.HAS_SHEEN;
  }
  if (info.hasVolume) {
    flags |= MaterialFlags.HAS_VOLUME;
  }
  if (info.hasTransmission) {
    flags |= MaterialFlags.HAS_TRANSMISSION;
  }
  return flags;
}

export { extractMaterialInfo, MaterialFlags, AlphaModes };
export default { extractMaterialInfo, MaterialFlags, AlphaModes };
