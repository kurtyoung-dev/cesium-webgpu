/// <reference types="@webgpu/types" />
/**
 * Bind-group-layout, pipeline-layout, sampler, and placeholder-texture
 * builders for `WebGPUGlobeSurfaceRenderer`:
 *
 *   - `createBindGroupLayouts(host)` — builds the four bind-group layouts
 *     (camera+tile+eclipse UBs, 16-slot imagery + sampler, water-mask + ocean
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
 * The renderer's `initialize()` calls these four helpers directly.
 *
 * The 12 host fields they write into are public on the renderer, with the
 * underscore prefix retained to mark them as not callable from outside the
 * Renderer package.
 *
 * @module WebGPUGlobeSurfaceLayouts
 */

import {
  getGlobeEffectsBindGroupLayout,
  getGlobePlaceholderEffects,
} from "./WebGPUEffectsBindGroup.js";
import {
  makeBindGroupLayout,
  sampler,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ECLIPSE_UNIFORM_BYTES } from "./WebGPUGlobeEclipseUniforms.js";

/**
 * The renderer surface the layout builders reach into. `_device` is
 * read-only here; the other 11 fields are write-only (the helpers
 * initialize them, the renderer reads them every frame and clears them
 * in `destroy()`).
 */
export interface LayoutsHost {
  readonly _device: GPUDevice | null;
  /**
   * Per-device imagery slot count (16 full / 4 reduced), computed by
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
  _noWaterMaskTexture: GPUTexture | null;
  _noWaterMaskView: GPUTextureView | null;
}

export function createBindGroupLayouts(host: LayoutsHost): void {
  const device = host._device!;

  // Group 0: Camera + Tile + per-View eclipse uniform buffers.
  //
  // All three bindings use dynamic offsets. The bind group is built once over
  // the ring allocator's page buffer (offset 0, size = struct width) and keyed
  // only on the (camera page, tile page, eclipse page/buffer) identities,
  // never on the per-allocation byte offset. The actual slice offset is
  // supplied per draw via
  // `setBindGroup(0, bg0, [camOffset, tileOffset, eclipseOffset])`.
  //
  // The camera and tile UBs are sub-allocated from the per-frame ring
  // allocator, so their byte offset within a page shifts whenever the
  // allocation sequence changes — tile streaming in and out during camera
  // motion. Keying the cache on that offset costs a fresh `createBindGroup`
  // for every tile after the shift point. With dynamic offsets the bind group
  // survives motion: the cache converges to roughly one group-0 entry per ring
  // page and holds a ~100% hit rate while panning.
  //
  // `minBindingSize: 0` keeps camera/tile shape-agnostic; their binding
  // views supply exact struct widths. EclipseUniforms is a fixed four-vec4
  // carrier and pins its minimum size to 64 bytes.
  host._bindGroupLayout0 = makeBindGroupLayout(
    device,
    "Globe terrain uniforms layout (dynamic offset)",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT, { hasDynamicOffset: true }),
      uniformBuffer(1, Stage.VERTEX_FRAGMENT, { hasDynamicOffset: true }),
      uniformBuffer(2, Stage.FRAGMENT, {
        hasDynamicOffset: true,
        minBindingSize: ECLIPSE_UNIFORM_BYTES,
      }),
    ],
  );

  // Group 1: Day imagery textures + shared sampler at binding 16.
  // The slot count is per-device: 16 on adapters whose
  // `maxSampledTexturesPerShaderStage` covers the full 28-texture pipeline
  // layout, 4 on default-limit adapters (spec floor 16, e.g. SwiftShader CI /
  // compat mode) so the whole layout fits exactly 16. The sampler keeps
  // binding 16 in both shapes — WebGPU allows sparse binding indices — so the
  // WGSL `texSampler` declaration and the JS bind-group builder are shared.
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
  // The material slots live here rather than in a group of their own to stay
  // within the WebGPU `maxBindGroups: 4` spec floor. Bindings 4-8 carry the
  // globe-material payload — UBO + image (texture+sampler) + heights
  // (texture+sampler). When `globe.material` is null, bindings 4-8 receive a
  // placeholder UBO and placeholder textures so the layout stays single-shape
  // regardless of material state.
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
      // Sun-view beer shadow map (binding 9) and its linear sampler
      // (binding 10). Bound unconditionally so the layout never forks; the
      // renderer binds the real map when globe.cloudCastShadows is on, else a
      // 1×1 zero placeholder (optical depth 0 → transmittance 1). The WGSL
      // samples it only inside the `cloudShadowControl.x > 0.5` gate.
      texture(9, Stage.FRAGMENT),
      sampler(10, Stage.FRAGMENT),
      // Draped vector-tile polyline lookup (binding 11). A read-only storage
      // buffer rather than the five sampled textures WebGL's
      // `VectorCommon.glsl` uses: group 2 already charges 5 of the 12
      // non-imagery fragment sampled textures
      // (`GLOBE_NON_IMAGERY_FRAGMENT_TEXTURES`), and the reduced 4-slot
      // imagery layout lands on exactly the 16-texture spec floor, so five
      // more would break default-limit adapters outright. Storage buffers draw
      // from a separate budget, so the texture accounting above is unchanged.
      // Bound unconditionally — tiles with no clamped vector data get a
      // 32-byte all-zero placeholder whose gridWidth header word is 0.
      //
      // This is the globe layout's only fragment-stage storage buffer. Current
      // WebGPU default limits guarantee 8 fragment storage buffers in core and
      // 4 in compatibility mode; the compatibility-mode zero applies to the
      // vertex-stage limit. Older implementations may omit the newer per-stage
      // accessor, in which case `maxStorageBuffersPerShaderStage` is the legacy
      // diagnostic. One binding fits every conforming profile.
      storageBuffer(11, Stage.FRAGMENT, { readOnly: true }),
    ],
  );

  // Group 3: Globe effects (shadow receive + clipping planes). Model-only
  // edge and clustered/area-light resources are deliberately absent: the
  // globe WGSL never declares them, and charging them to this pipeline would
  // unnecessarily consume five sampled-texture slots on low-limit adapters.
  host._effectsBGL = getGlobeEffectsBindGroupLayout(device);
  const placeholder = getGlobePlaceholderEffects(device);
  host._placeholderEffectsBG = placeholder.bindGroup;
}

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

export function createSamplers(host: LayoutsHost): void {
  host._sampler = host._device!.createSampler({
    label: "Globe terrain sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    // WebGL imagery samplers use anisotropic filtering at the device maximum
    // (ImageryLayer.js finalizeReprojectTexture:
    // `maximumAnisotropy = min(context.limits.maximumTextureFilterAnisotropy,
    // layer.maximumAnisotropy ?? max)`, typically 16). Without it the WebGPU
    // globe imagery goes visibly blurry at oblique view angles — limb-adjacent
    // terrain at orbit zoom — measured as a broad "GPU brighter" smear over
    // high-contrast snowy terrain. 16 is the WebGPU spec maximum and requires
    // all three filters to be "linear", which they are.
    maxAnisotropy: 16,
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
  // Ocean normal map uses repeating linear filtering for tiled wave patterns.
  // maxAnisotropy 8: the physical-wavelength wave march samples with
  // `textureSampleGrad`, whose footprint is highly elongated at the grazing
  // angles of a low camera looking toward the horizon. Isotropic mip selection
  // (maxAnisotropy 1) picks the long-axis LOD and over-blurs across-track
  // detail into mush; anisotropic filtering takes multiple taps along the long
  // axis at the finer short-axis LOD, keeping the wave streaks crisp. Requires
  // linear min/mag/mipmap, all set. The octave footprint weight is keyed off
  // the shorter axis to match — see
  // GlobeTerrain.wgsl::sampleOceanWaveNormals.
  host._oceanNormalSampler = host._device!.createSampler({
    label: "Globe ocean normal sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
    maxAnisotropy: 8,
  });
}

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

  // Dedicated 1×1 zero water-mask fallback. The shared white placeholder
  // reads as waterMask = 1.0 (all water), which runs the enhanced-ocean
  // shader over entire land tiles whenever a tile's mask is not GPU-resident.
  // Zero (all land) matches WebGL's convention, where an all-land tile simply
  // has no water-mask texture.
  host._noWaterMaskTexture = device.createTexture({
    label: "Globe no-water mask fallback",
    size: [1, 1],
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: host._noWaterMaskTexture },
    new Uint8Array([0]),
    { bytesPerRow: 1 },
    [1, 1],
  );
  host._noWaterMaskView = host._noWaterMaskTexture.createView();
}
