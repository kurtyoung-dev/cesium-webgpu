/**
 * Which texture a primitive material's texture slot samples on WebGPU, chosen
 * the way the WebGL path chooses it.
 *
 * WebGL's sampler uniform for a material texture always returns
 * `material._textures[uniform]` (`MaterialHelpers.createUniform`). The WebGPU
 * primitive path instead builds its own texture from the raw image
 * `Material.update` mirrors into `material._imageSources`. Two uniform shapes
 * never reach that mirror, because `MaterialHelpers` keeps them only in
 * `_textures`:
 *
 *   - an `HTMLVideoElement`, whose `Texture` `MaterialHelpers` creates on the
 *     first frame with data and refreshes with `copyFrom` on every update;
 *   - a `Texture` the caller supplies directly.
 *
 * For those the slot binds the current view of `_textures[uniform]`, so the
 * per-frame copy WebGL already runs (through the compatibility stub on WebGPU)
 * is the copy WebGPU samples. No second upload of the element is made.
 *
 * The selection is by the uniform's current VALUE, as WebGL's is, not by
 * whatever `_imageSources` happens to hold: that mirror is never cleared, so
 * an image that a video replaced would otherwise keep being drawn.
 *
 * After the uniform leaves those shapes (a video replaced by an image), WebGL
 * keeps sampling the `_textures` entry until `Material.update` adopts the new
 * image, and adopting it is also what changes `_imageSources`. So the slot
 * stays on `_textures` while `_imageSources[uniform]` still holds what it held
 * when the slot was last chosen that way, and returns to the image path from
 * the frame the mirror changes.
 *
 * OWNERSHIP. A `_textures` entry belongs to the `Material` (and its native to
 * the compatibility stub). This module only reads its view; the caller must
 * never destroy it or keep it in a slot it destroys on replacement.
 *
 * @private
 */
/// <reference types="@webgpu/types" />

import { resolveMaterialTextureView } from "./WebGPUGlobeMaterial.js";

/** The material fields the slot choice reads. */
export interface MaterialTextureSourceLike {
  _imageSources?: { [key: string]: unknown };
  _textures?: { [key: string]: unknown };
  uniforms?: { [key: string]: unknown };
}

/**
 * Per-slot state kept in the primitive's texture cache: what the slot's
 * `_imageSources` entry was while the slot was last chosen from `_textures`,
 * and the `_textures` view the current bind group holds.
 */
export interface MaterialSlotTextureState {
  held?: { imageSource: unknown };
  // The `_textures` view the current bind group was built with: a view, null
  // for the placeholder, or undefined when the slot was built from the
  // `_imageSources` path.
  boundView?: GPUTextureView | null;
}

/** A slot's choice: bind `_textures[uniform]`'s view, or keep the image path. */
export type MaterialSlotTextureChoice =
  | { readonly fromTextures: false }
  | { readonly fromTextures: true; readonly view: GPUTextureView | null };

/** The choice for a slot the rule does not reach. */
export const IMAGE_SOURCE_PATH: MaterialSlotTextureChoice = Object.freeze({
  fromTextures: false,
});

// A Cesium `Renderer/Texture.js` instance, duck-typed so this renderer takes no
// static dependency on the WebGL class (the same reason the globe material's
// resolver duck-types it): it keeps its backend handle at `_texture` and
// uploads through `copyFrom`.
function isTextureWrapper(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { _texture?: unknown; copyFrom?: unknown };
  return (
    typeof candidate.copyFrom === "function" &&
    typeof candidate._texture === "object" &&
    candidate._texture !== null
  );
}

/**
 * Whether WebGL samples this uniform value from the `Texture` that
 * `MaterialHelpers` keeps in `_textures` rather than from an image
 * `Material.update` adopts: a video element, or a `Texture` the caller
 * supplied. `HTMLVideoElement` is `typeof`-guarded so the module loads in Node
 * and in a worker, where the class does not exist.
 *
 * @param {unknown} value The uniform's current value.
 * @returns {boolean}
 */
export function uniformSamplesMaterialTextures(value: unknown): boolean {
  if (
    typeof HTMLVideoElement !== "undefined" &&
    value instanceof HTMLVideoElement
  ) {
    return true;
  }
  return isTextureWrapper(value);
}

// Formats the material bind group's `float` texture entry, sampled through a
// filtering sampler, cannot take: binding one would fail validation, so such a
// texture binds the placeholder instead.
function isUnfilterableFormat(format: unknown): boolean {
  return (
    typeof format === "string" &&
    (format.endsWith("32float") ||
      format.endsWith("int") ||
      format.startsWith("depth") ||
      format.startsWith("stencil"))
  );
}

function isDestroyedObject(value: object): boolean {
  const flag = (value as { isDestroyed?: unknown }).isDestroyed;
  if (typeof flag === "function") {
    return (flag as () => unknown).call(value) === true;
  }
  return flag === true;
}

// The native format behind a `_textures` entry: the compatibility stub's
// realization for a `Texture`, or the WebGPU texture itself for the context's
// default texture.
function nativeFormatOf(entry: object): unknown {
  const handle = (entry as { _texture?: unknown })._texture;
  const owner = typeof handle === "object" && handle !== null ? handle : entry;
  const native = (owner as { _webgpuTexture?: { format?: unknown } | null })
    ._webgpuTexture;
  if (native && typeof native === "object") {
    return native.format;
  }
  return (entry as { format?: unknown }).format;
}

/**
 * The current view of a `_textures` entry, or null when the slot must bind the
 * placeholder: no entry, an entry already destroyed (a destroyed stub texture
 * also resolves to no view), or a native format the material sampler cannot
 * take.
 *
 * @param {unknown} entry The `_textures` entry.
 * @returns {GPUTextureView|null}
 */
export function currentMaterialTexturesView(
  entry: unknown,
): GPUTextureView | null {
  if (!entry || typeof entry !== "object" || isDestroyedObject(entry)) {
    return null;
  }
  if (isUnfilterableFormat(nativeFormatOf(entry))) {
    return null;
  }
  return resolveMaterialTextureView(entry);
}

// The elevation-band fabric's two `Texture` uniforms (band heights and
// colours) need more than this choice: its heights texture is a float format
// the material sampler cannot filter, and its shader reads unpacked heights.
// It keeps the image path for both slots.
function fabricKeepsImagePath(shaderType: string): boolean {
  return shaderType.includes("ElevBand");
}

/**
 * Choose what one texture slot of a primitive material binds, and keep the
 * slot's state in `cache[stateKey]`.
 *
 * @param {MaterialTextureSourceLike|undefined} material The material.
 * @param {string} uniformName The slot's texture uniform.
 * @param {string} shaderType The material's shader type.
 * @param {object} cache The primitive's texture cache.
 * @param {string} stateKey The cache field holding this slot's state.
 * @returns {MaterialSlotTextureChoice}
 */
function chooseMaterialSlotTexture(
  material: MaterialTextureSourceLike | undefined,
  uniformName: string,
  shaderType: string,
  cache: { [key: string]: unknown },
  stateKey: string,
): MaterialSlotTextureChoice {
  if (!material || fabricKeepsImagePath(shaderType)) {
    return IMAGE_SOURCE_PATH;
  }
  const state = (cache[stateKey] ??= {}) as MaterialSlotTextureState;
  const imageSource = material._imageSources?.[uniformName];
  const value = material.uniforms?.[uniformName];
  if (uniformSamplesMaterialTextures(value)) {
    state.held = { imageSource };
  } else if (
    state.held === undefined ||
    state.held.imageSource !== imageSource
  ) {
    state.held = undefined;
    return IMAGE_SOURCE_PATH;
  }
  return {
    fromTextures: true,
    view: currentMaterialTexturesView(material._textures?.[uniformName]),
  };
}

/** The cache fields one texture key set gives the two slots' state. */
export interface MaterialTextureSlotKeys {
  primaryTextures: string;
  secondaryTextures: string;
}

/** Both slots' choices, and the `_imageSources` entry each slot uploads. */
export interface MaterialTextureSlotsChoice {
  readonly primary: MaterialSlotTextureChoice;
  readonly secondary: MaterialSlotTextureChoice;
  // The image each slot builds from on the image path; undefined for a slot
  // bound from `_textures`, so the image path's identity check ignores it.
  readonly primarySource: unknown;
  readonly secondarySource: unknown;
}

/**
 * Choose both texture slots of a primitive material.
 *
 * @param {MaterialTextureSourceLike|undefined} material The material.
 * @param {{primary: string, secondary?: string}} slots The slots' uniforms.
 * @param {string} shaderType The material's shader type.
 * @param {object} cache The primitive's texture cache.
 * @param {MaterialTextureSlotKeys} keys The cache fields for the slots' state.
 * @returns {MaterialTextureSlotsChoice}
 */
export function chooseMaterialTextureSlots(
  material: MaterialTextureSourceLike | undefined,
  slots: { primary: string; secondary?: string },
  shaderType: string,
  cache: { [key: string]: unknown },
  keys: MaterialTextureSlotKeys,
): MaterialTextureSlotsChoice {
  const primary = chooseMaterialSlotTexture(
    material,
    slots.primary,
    shaderType,
    cache,
    keys.primaryTextures,
  );
  const secondary =
    slots.secondary === undefined
      ? IMAGE_SOURCE_PATH
      : chooseMaterialSlotTexture(
          material,
          slots.secondary,
          shaderType,
          cache,
          keys.secondaryTextures,
        );
  const imageSources = material?._imageSources;
  return {
    primary,
    secondary,
    primarySource: primary.fromTextures
      ? undefined
      : imageSources?.[slots.primary],
    secondarySource:
      secondary.fromTextures || slots.secondary === undefined
        ? undefined
        : imageSources?.[slots.secondary],
  };
}

function boundViewFor(choice: MaterialSlotTextureChoice) {
  return choice.fromTextures ? choice.view : undefined;
}

/**
 * Whether the bind group in the cache was built with the `_textures` views
 * (or the image path) these choices bind. The image path's own identity check
 * is the caller's.
 *
 * @param {object} cache The primitive's texture cache.
 * @param {MaterialTextureSlotKeys} keys The cache fields for the slots' state.
 * @param {MaterialTextureSlotsChoice} choice This frame's choices.
 * @returns {boolean}
 */
export function areMaterialTextureSlotsBound(
  cache: { [key: string]: unknown },
  keys: MaterialTextureSlotKeys,
  choice: MaterialTextureSlotsChoice,
): boolean {
  const primary = cache[keys.primaryTextures] as
    MaterialSlotTextureState | undefined;
  const secondary = cache[keys.secondaryTextures] as
    MaterialSlotTextureState | undefined;
  return (
    primary?.boundView === boundViewFor(choice.primary) &&
    secondary?.boundView === boundViewFor(choice.secondary)
  );
}

/**
 * Record what a new bind group was built with.
 *
 * @param {object} cache The primitive's texture cache.
 * @param {MaterialTextureSlotKeys} keys The cache fields for the slots' state.
 * @param {MaterialTextureSlotsChoice} choice This frame's choices.
 */
export function recordMaterialTextureSlotsBound(
  cache: { [key: string]: unknown },
  keys: MaterialTextureSlotKeys,
  choice: MaterialTextureSlotsChoice,
): void {
  const primary = (cache[keys.primaryTextures] ??=
    {}) as MaterialSlotTextureState;
  primary.boundView = boundViewFor(choice.primary);
  const secondary = (cache[keys.secondaryTextures] ??=
    {}) as MaterialSlotTextureState;
  secondary.boundView = boundViewFor(choice.secondary);
}

/**
 * Destroy, once, a texture the binding helper created from an image, when its
 * slot moves to a Material-owned `_textures` view. Only a texture the helper
 * created is ever held in such a field.
 *
 * @param {object} cache The primitive's texture cache.
 * @param {string} key The field holding the created texture.
 */
export function releaseCreatedMaterialTexture(
  cache: { [key: string]: unknown },
  key: string,
): void {
  const created = cache[key] as { destroy(): void } | undefined;
  if (created !== undefined && created !== null) {
    cache[key] = undefined;
    created.destroy();
  }
}
