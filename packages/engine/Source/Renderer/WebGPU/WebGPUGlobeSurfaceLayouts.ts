/// <reference types="@webgpu/types" />
/**
 * Bind-group-layout, pipeline-layout, sampler, and placeholder-texture
 * builders extracted from `WebGPUGlobeSurfaceRenderer`.
 *
 * Batch 147 of the audit-recommended decomposition (third slice of the
 * GlobeSurface decomposition arc — see
 * `migration_doc/BATCH_145_PLAN_GLOBE_SURFACE_DECOMPOSITION.md`).
 *
 * Moves the four `_create*` init helpers off the renderer class:
 *
 *   - `createBindGroupLayouts(host)` — builds the four bind-group layouts
 *     (camera+tile UBs, 16-slot imagery + sampler, water-mask + ocean
 *     normal map, effects) and writes them into the host. Pulls the
 *     placeholder effects bind-group from the shared cache.
 *   - `createPipelineLayout(host)` — composes the four bind-group layouts
 *     into a single `GPUPipelineLayout`.
 *   - `createSamplers(host)` — creates the three samplers used by globe
 *     terrain rendering: trilinear clamp-to-edge for imagery, bilinear
 *     clamp for water masks (so the WGSL `smoothstep` transition
 *     produces smooth coastlines), and trilinear repeat for ocean normal
 *     maps.
 *   - `createPlaceholderTexture(host)` — allocates the 1×1 white texture
 *     + view used to fill empty imagery slots in tiles with fewer than
 *     16 layers.
 *
 * The renderer's `initialize()` calls these four helpers directly. The
 * old `_create*` private methods are removed entirely (each had a
 * single caller).
 *
 * The 12 host fields these helpers write into are flipped from `private`
 * to `public` on the renderer (with the underscore prefix preserved as
 * the "do-not-call-from-outside-the-Renderer-package" marker per the
 * convention used in Batches 142–146).
 *
 * @module WebGPUGlobeSurfaceLayouts
 */

import {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * The renderer surface the layout builders reach into. `_device` is
 * read-only here; the other 11 fields are write-only (the helpers
 * initialize them, the renderer reads them every frame and clears them
 * in `destroy()`).
 */
export interface LayoutsHost {
  readonly _device: GPUDevice | null;
  _bindGroupLayout0: GPUBindGroupLayout | null;
  _bindGroupLayout1: GPUBindGroupLayout | null;
  _bindGroupLayout2: GPUBindGroupLayout | null;
  _effectsBGL: GPUBindGroupLayout | null;
  _placeholderEffectsBG: GPUBindGroup | null;
  _pipelineLayout: GPUPipelineLayout | null;
  _sampler: GPUSampler | null;
  _waterMaskSampler: GPUSampler | null;
  _oceanNormalSampler: GPUSampler | null;
  _placeholderTexture: GPUTexture | null;
  _placeholderView: GPUTextureView | null;
}

// ─── Bind Group Layouts ───
export function createBindGroupLayouts(host: LayoutsHost): void {
  const device = host._device!;

  // Group 0: Camera + Tile uniform buffers
  host._bindGroupLayout0 = makeBindGroupLayout(
    device,
    "Globe terrain uniforms layout",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      uniformBuffer(1, Stage.VERTEX_FRAGMENT),
    ],
  );

  // Group 1: Day imagery textures (16) + shared sampler at binding 16.
  // Batch 58 (C-R5): bumped from 4 to 16 — WebGPU's minimum-guaranteed
  // `maxSampledTexturesPerShaderStage` is 16 so this is safe across all
  // compliant devices without probing limits.
  host._bindGroupLayout1 = makeBindGroupLayout(
    device,
    "Globe terrain textures layout",
    [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
      texture(5, Stage.FRAGMENT),
      texture(6, Stage.FRAGMENT),
      texture(7, Stage.FRAGMENT),
      texture(8, Stage.FRAGMENT),
      texture(9, Stage.FRAGMENT),
      texture(10, Stage.FRAGMENT),
      texture(11, Stage.FRAGMENT),
      texture(12, Stage.FRAGMENT),
      texture(13, Stage.FRAGMENT),
      texture(14, Stage.FRAGMENT),
      texture(15, Stage.FRAGMENT),
      sampler(16, Stage.FRAGMENT),
    ],
  );

  // Group 2: Water mask + Ocean normal map (merged to stay within 4 bind groups)
  host._bindGroupLayout2 = makeBindGroupLayout(
    device,
    "Globe water mask + ocean normal layout",
    [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      sampler(3, Stage.FRAGMENT),
    ],
  );

  // Group 3: Effects (shadow receive + clipping planes) — shared layout
  host._effectsBGL = getEffectsBindGroupLayout(device);
  const placeholder = getPlaceholderEffects(device);
  host._placeholderEffectsBG = placeholder.bindGroup;
}

// ─── Pipeline Layout ───
export function createPipelineLayout(host: LayoutsHost): void {
  host._pipelineLayout = host._device!.createPipelineLayout({
    label: "Globe terrain pipeline layout",
    bindGroupLayouts: [
      host._bindGroupLayout0!,
      host._bindGroupLayout1!,
      host._bindGroupLayout2!,
      host._effectsBGL!,
    ],
  });
}

// ─── Samplers ───
export function createSamplers(host: LayoutsHost): void {
  host._sampler = host._device!.createSampler({
    label: "Globe terrain sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  // Water mask uses linear filtering to match WebGL — matches the WGSL's
  // `smoothstep(0.3, 0.7, waterMask)` transition, which can't smooth a
  // purely binary (nearest-sampled) value. Nearest filtering produces
  // jagged staircase coastlines at any zoom level.
  host._waterMaskSampler = host._device!.createSampler({
    label: "Globe water mask sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  // Ocean normal map uses repeating linear filtering for tiled wave patterns
  host._oceanNormalSampler = host._device!.createSampler({
    label: "Globe ocean normal sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });
}

// ─── Placeholder 1×1 white texture ───
export function createPlaceholderTexture(host: LayoutsHost): void {
  const device = host._device!;
  host._placeholderTexture = device.createTexture({
    label: "Globe placeholder texture",
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: host._placeholderTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  host._placeholderView = host._placeholderTexture.createView();
}
