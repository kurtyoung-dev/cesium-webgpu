/// <reference types="@webgpu/types" />
/**
 * The single enforceable home for the generated-chunk CLASS axis of the model
 * pipeline cache key.
 *
 * A model pipeline is identified by more than its material. Two primitives of
 * one model can share an alpha mode, a face orientation and a material define
 * mask and still need different compiled modules, because the chunks prepended
 * to the shader are generated per class: the metadata chunk declares a struct
 * named after the real metadata class with its offsets and scales baked in, and
 * the customShader chunk carries the inlined user body together with its
 * uniform and texture declarations. The shader module cache already separates
 * those variants, folding both class hashes into the module key. The pipeline
 * maps keyed only on the material identity, so the second class to arrive on a
 * model whose material identity already had a pipeline was served the first
 * class's pipeline, and with it the first class's module.
 *
 * That is the aliasing shape this renderer treats as unreportable, because it
 * RAISES the cache hit rate: no counter falls when it happens, and the wrong
 * pipeline is simply served.
 *
 * The axis is folded here, once, rather than at each pipeline map. Every model
 * pipeline map keys through this one function, so a single fold covers the
 * display, depth-write, silhouette, pick, snap, hover, velocity, classification
 * and capture maps together; folding at the maps would repeat the gate at each
 * of them and rely on nobody forgetting one.
 *
 * The fold is gated so that it is BYTE-IDENTICAL for every model carrying
 * neither a metadata class nor a customShader: both hashes read zero and the
 * key is returned exactly as the transport-only form produced it. Every gating
 * bit lives inside the pipeline cache's `MATERIAL_DEFINE_MASK`, so the
 * normalized material defines already carry them and no caller has to supply
 * them separately.
 *
 * One hash is deliberately NOT folded here. The metadata-PICK variant selects a
 * different generated chunk, keyed by the picked property, but the bit that
 * selects it is a render-mode bit held outside `MATERIAL_DEFINE_MASK` and
 * stripped from the normalized defines, so it is not visible at this seam. The
 * metadata-pick map therefore folds its own picked-property hash at its call
 * site, and what this function contributes there is the display class it shares
 * with the rest of the primitive.
 */

import { ShaderDefine } from "./WebGPUShaderDefines.js";

/**
 * The material bits under which a generated METADATA chunk is prepended, and
 * therefore under which the metadata class hash discriminates a module. Kept
 * beside the fold so the gate and the hash it admits cannot drift apart.
 */
export const MODEL_METADATA_CLASS_DEFINE_MASK: number =
  ShaderDefine.MODEL_HAS_METADATA |
  ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES |
  ShaderDefine.MODEL_HAS_PROPERTY_TABLES;

/**
 * The material bits under which a generated CUSTOM SHADER chunk is prepended.
 * The vertex sibling is included because either stage alone changes the chunk.
 */
export const MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK: number =
  ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER |
  ShaderDefine.MODEL_HAS_WGSL_CUSTOM_VERTEX;

/**
 * Folds the generated-chunk class axis into a model pipeline cache key.
 *
 * `slotMode` is the metadata transport mode: mode 2 is the widened MAT3/MAT4
 * transport, whose vertex layout and module differ from plain metadata at the
 * same material identity, and which is discriminated by the historical `:m34`
 * suffix. The class hashes are appended after it, so a MAT-transport key and a
 * plain key carrying the same class remain distinct.
 *
 * @param {number|string} key base pipeline cache key
 * @param {number} md normalized material defines
 * @param {number} slotMode metadata transport mode, 2 for MAT3/MAT4 transport
 * @param {number} metadataClassHash fingerprint of the generated metadata chunk
 * @param {number} customShaderClassHash fingerprint of the customShader chunk
 * @returns {number|string} the key, unchanged when neither class applies
 */
export function buildModelMetadataVariantKey(
  key: number | string,
  md: number,
  slotMode: number,
  metadataClassHash: number,
  customShaderClassHash: number,
): number | string {
  const transportKey = slotMode === 2 ? `${key}:m34` : key;
  const metadataHash =
    (md & MODEL_METADATA_CLASS_DEFINE_MASK) !== 0 ? metadataClassHash >>> 0 : 0;
  const customShaderHash =
    (md & MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK) !== 0
      ? customShaderClassHash >>> 0
      : 0;
  // The byte-identity guarantee. A model with no generated chunk takes this
  // branch and the key is returned exactly as it was before the class axis
  // existed, preserving its NUMBER type where the transport did not stringify.
  if (metadataHash === 0 && customShaderHash === 0) {
    return transportKey;
  }
  return `${transportKey}#${metadataHash}#${customShaderHash}`;
}

export default {
  MODEL_METADATA_CLASS_DEFINE_MASK,
  MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK,
  buildModelMetadataVariantKey,
};
