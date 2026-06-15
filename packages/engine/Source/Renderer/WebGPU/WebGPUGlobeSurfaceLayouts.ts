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
  /**
   * NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — per-device
   * imagery slot count (16 full / 1 reduced), computed by
   * `computeGlobeImagerySlotCount` at renderer init. Group 1 is built
   * with this many texture bindings; the sampler stays at binding 16
   * in both shapes (sparse binding indices are valid in WebGPU).
   */
  readonly _imagerySlotCount: number;
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

  // Group 0: Camera + Tile uniform buffers.
  //
  // NEW-GLOBE-DYNAMIC-OFFSET-UBO (Batch 292) — both bindings use
  // dynamic offsets. The bind group is built ONCE over the ring
  // allocator's page buffer (offset 0, size = struct width) and keyed
  // only on the (camera page, tile page) buffer identities — never on
  // the per-allocation byte offset. The actual slice offset is supplied
  // per-draw via `setBindGroup(0, bg0, [camOffset, tileOffset])`.
  //
  // Why this matters: the camera/tile UBs are sub-allocated from the
  // per-frame ring allocator, so their byte offset within a page shifts
  // whenever the per-frame allocation sequence changes (tile streaming
  // in/out during camera motion). Keying the cache on that offset meant
  // a fresh `createBindGroup` for every tile after the shift point.
  // With dynamic offsets the bind group survives motion: the cache
  // converges to ~pageCount group-0 entries (one per ring page) and
  // stays at ~100% hit-rate while panning.
  //
  // `minBindingSize: 0` keeps the layout shape-agnostic; the camera
  // struct (CAMERA_UNIFORM_BYTES) and the tile struct have different
  // widths and the binding view supplies the exact size at build time.
  host._bindGroupLayout0 = makeBindGroupLayout(
    device,
    "Globe terrain uniforms layout (dynamic offset)",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT, { hasDynamicOffset: true }),
      uniformBuffer(1, Stage.VERTEX_FRAGMENT, { hasDynamicOffset: true }),
    ],
  );

  // Group 1: Day imagery textures + shared sampler at binding 16.
  // Batch 58 (C-R5): bumped from 4 to 16 imagery slots. Batch 246
  // (NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT): the slot count is now
  // per-device — 16 on adapters whose `maxSampledTexturesPerShaderStage`
  // covers the full 31-texture pipeline layout, 1 on default-limit
  // adapters (spec floor 16, e.g. SwiftShader CI / compat mode) so the
  // whole layout fits exactly 16. The sampler keeps binding 16 in both
  // shapes (WebGPU allows sparse binding indices) so the WGSL
  // `texSampler` declaration and the JS bind-group builder are shared.
  const imagerySlots = host._imagerySlotCount;
  const group1Entries: GPUBindGroupLayoutEntry[] = [];
  for (let i = 0; i < imagerySlots; i++) {
    group1Entries.push(texture(i, Stage.FRAGMENT));
  }
  group1Entries.push(sampler(16, Stage.FRAGMENT));
  host._bindGroupLayout1 = makeBindGroupLayout(
    device,
    `Globe terrain textures layout (${imagerySlots} slots)`,
    group1Entries,
  );

  // Group 2: Water mask + Ocean normal map + Material UBO + Material textures.
  // Session 65 Cluster 3 — material slots merged into Group 2 to stay
  // within the WebGPU `maxBindGroups: 4` spec floor. Bindings 4-8 carry
  // the globe-material payload — UBO + image (texture+sampler) +
  // heights (texture+sampler). When `globe.material` is null, bindings
  // 4-8 receive a placeholder UBO + placeholder textures so the layout
  // stays single-shape regardless of material state.
  host._bindGroupLayout2 = makeBindGroupLayout(
    device,
    "Globe water mask + ocean normal + material layout",
    [
      texture(0, Stage.FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      sampler(3, Stage.FRAGMENT),
      uniformBuffer(4, Stage.FRAGMENT),
      texture(5, Stage.FRAGMENT),
      sampler(6, Stage.FRAGMENT),
      texture(7, Stage.FRAGMENT),
      sampler(8, Stage.FRAGMENT),
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
