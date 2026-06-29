/// <reference types="@webgpu/types" />
/**
 * Atmosphere-LUT resource builder + dispatcher extracted from
 * `WebGPUPerformanceManager` (Batch 161 of the maintainability sweep).
 *
 * Owns the two heavy LUT methods:
 *   - `ensureAtmosphereLUTResources(host, device)` — allocates the sun
 *     + moon transmittance/inscatter texture pairs and matching params
 *     UBOs. Idempotent; cached on the host.
 *   - `dispatchAtmosphereLUT(host, encoder, device, params, target)` —
 *     packs params, lazily builds the shared BGL + per-target bind
 *     groups, then dispatches the two LUT compute entry points
 *     (`computeTransmittance`, `computeInscatter`) via the host's
 *     `dispatchCompute` method.
 *
 * The 4 small flag-management methods (`shouldRecomputeAtmosphereLUT`,
 * `invalidateAtmosphereLUT`, and their moon equivalents) stay on the
 * class — they're 3-10 LOC each, no extraction value.
 *
 * @module WebGPUAtmosphereLUT
 */

import {
  makeBindGroupLayout,
  uniformBuffer,
  storageTexture,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ComputeTaskType } from "./WebGPUPerformanceManager.js";
import type { ComputeTaskTypeValue } from "./WebGPUPerformanceManager.js";

/**
 * Cached per-LUT resources. Sun + moon use parallel slots so direction
 * changes for one don't churn the other.
 */
export interface AtmosphereLUTResources {
  transmittance: GPUTexture;
  transmittanceView: GPUTextureView;
  inscatter: GPUTexture;
  inscatterView: GPUTextureView;
  paramsBuffer: GPUBuffer;
  paramsData: Float32Array;
  bindGroup: GPUBindGroup | null;
  moonTransmittance: GPUTexture;
  moonTransmittanceView: GPUTextureView;
  moonInscatter: GPUTexture;
  moonInscatterView: GPUTextureView;
  moonParamsBuffer: GPUBuffer;
  moonParamsData: Float32Array;
  moonBindGroup: GPUBindGroup | null;
  bindGroupLayout: GPUBindGroupLayout | null;
  // ── Track V-A1: full-Bruneton extension (multiple-scattering + irradiance) ──
  // Sun-only for now (the moon path keeps transmittance + single scatter).
  // multipleScatter shares the inscatter (256×128) parameterization;
  // irradiance shares the transmittance (256×64) parameterization.
  multipleScatter: GPUTexture;
  multipleScatterView: GPUTextureView;
  irradiance: GPUTexture;
  irradianceView: GPUTextureView;
  // ── Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) ──
  // Sun-relative sky-view LUT (Hillaire 2020). Shares the inscatter (256×128)
  // dimensions but a DIFFERENT parameterization (relative-azimuth × warped
  // view-zenith) so it can represent sky color at any view azimuth relative to
  // the sun. Written by AtmosphereLUT.wgsl::computeSkyView, sampled by the sky
  // fragment shader only when `skyAtmosphere.useScatteringLut` is on (opt-in;
  // default off keeps the inline march, byte-identical to today).
  skyView: GPUTexture;
  skyViewView: GPUTextureView;
  // Sampler + group-1 bind group for the extended passes (read single-scatter
  // + transmittance as sampled inputs, write multiple-scatter + irradiance).
  extendedSampler: GPUSampler | null;
  extendedBindGroupLayout: GPUBindGroupLayout | null;
  extendedBindGroup: GPUBindGroup | null;
  // V0 — explicit EMPTY group-0 layout + bind group. The extended compute
  // pipelines must use an explicit pipeline layout (group 0 empty, group 1 = the
  // full 6-binding extended layout) instead of layout:"auto": auto derives a
  // SUBSET group-1 layout per kernel (each kernel writes only one of the two
  // storage textures), which is incompatible with the full 6-binding
  // extendedBindGroup → the "SkyAtmosphere LUT dispatch" invalid-command-buffer
  // device error. Providing the explicit layout makes the 6-binding group valid.
  emptyGroup0BindGroupLayout: GPUBindGroupLayout | null;
  emptyGroup0BindGroup: GPUBindGroup | null;
  width: number;
  inscatterHeight: number;
  transmittanceHeight: number;
}

/**
 * Subset of `WebGPUPerformanceManager` reached by the atmosphere LUT
 * helpers. The renderer satisfies this via the underscore-public
 * convention (Batch 161 flips two fields).
 */
export interface AtmosphereLUTHost {
  _atmosphereLutResources: AtmosphereLUTResources | null;
  readonly _context: { supportsComputeShaders: boolean };
  /**
   * Dispatches a compute task through the manager's pre-cached compute
   * pipelines. Used by `dispatchAtmosphereLUT` to fire the two LUT entry
   * points without duplicating the pipeline-cache logic.
   */
  dispatchCompute(
    encoder: GPUCommandEncoder,
    taskType: ComputeTaskTypeValue,
    bindGroups: { index: number; bindGroup: GPUBindGroup }[],
    workgroupCountX: number,
    workgroupCountY: number,
    workgroupCountZ: number,
    entryPoint?: string,
    bindGroupLayouts?: GPUBindGroupLayout[],
  ): void;
}

export function ensureAtmosphereLUTResources(
  host: AtmosphereLUTHost,
  device: GPUDevice,
): {
  transmittanceView: GPUTextureView;
  inscatterView: GPUTextureView;
  moonTransmittanceView: GPUTextureView;
  moonInscatterView: GPUTextureView;
  // Batch 427 (SKY-MS) — the multiple-scattering view produced by
  // dispatchAtmosphereExtendedLUT's computeMultipleScattering pass, surfaced
  // so the sky fragment shader can sample it (opt-in, default off).
  multipleScatterView: GPUTextureView;
  // Batch 428 (A-LUT-REPARAM) — sun-relative sky-view LUT view, surfaced so
  // the sky fragment shader can sample it when `useScatteringLut` is on.
  skyViewView: GPUTextureView;
} | null {
  if (host._atmosphereLutResources) {
    return {
      transmittanceView: host._atmosphereLutResources.transmittanceView,
      inscatterView: host._atmosphereLutResources.inscatterView,
      moonTransmittanceView: host._atmosphereLutResources.moonTransmittanceView,
      moonInscatterView: host._atmosphereLutResources.moonInscatterView,
      multipleScatterView: host._atmosphereLutResources.multipleScatterView,
      skyViewView: host._atmosphereLutResources.skyViewView,
    };
  }

  // Standard LUT dimensions per Bruneton & Neyret / Hillaire conventions.
  // Transmittance is 256×64; inscatter folds altitude+sun zenith into 256×128.
  const width = 256;
  const transmittanceHeight = 64;
  const inscatterHeight = 128;

  // COPY_SRC lets diagnostics/probes read back the LUTs via
  // copyTextureToBuffer (Track V-A1 probe-atmo-luts). The sun
  // transmittance + inscatter textures also gain TEXTURE_BINDING so the
  // extended passes can sample them as inputs (already implied below, but
  // explicit here). The cost is nil — these are tiny precompute targets.
  const usage =
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_SRC;

  // ── Sun LUT pair ──
  const transmittance = device.createTexture({
    label: "AtmosphereLUT_Sun_Transmittance",
    size: { width, height: transmittanceHeight },
    format: "rgba16float",
    usage,
  });
  const inscatter = device.createTexture({
    label: "AtmosphereLUT_Sun_Inscatter",
    size: { width, height: inscatterHeight },
    format: "rgba16float",
    usage,
  });

  // ── Moon LUT pair (Phase 1.3c) ──
  const moonTransmittance = device.createTexture({
    label: "AtmosphereLUT_Moon_Transmittance",
    size: { width, height: transmittanceHeight },
    format: "rgba16float",
    usage,
  });
  const moonInscatter = device.createTexture({
    label: "AtmosphereLUT_Moon_Inscatter",
    size: { width, height: inscatterHeight },
    format: "rgba16float",
    usage,
  });

  // ── Track V-A1: full-Bruneton extension targets (sun only) ──
  const multipleScatter = device.createTexture({
    label: "AtmosphereLUT_Sun_MultipleScatter",
    size: { width, height: inscatterHeight },
    format: "rgba16float",
    usage,
  });
  const irradiance = device.createTexture({
    label: "AtmosphereLUT_Sun_Irradiance",
    size: { width, height: transmittanceHeight },
    format: "rgba16float",
    usage,
  });
  // Batch 428 (A-LUT-REPARAM) — sun-relative sky-view LUT (same 256×128 dims as
  // the inscatter LUT, different parameterization). Same usage flags so probes
  // can read it back and the sky shader can sample it.
  const skyView = device.createTexture({
    label: "AtmosphereLUT_Sun_SkyView",
    size: { width, height: inscatterHeight },
    format: "rgba16float",
    usage,
  });

  const paramsData = new Float32Array(20);
  const paramsBuffer = device.createBuffer({
    label: "AtmosphereLUT_Sun_Params",
    size: Math.max(paramsData.byteLength, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const moonParamsData = new Float32Array(20);
  const moonParamsBuffer = device.createBuffer({
    label: "AtmosphereLUT_Moon_Params",
    size: Math.max(moonParamsData.byteLength, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  host._atmosphereLutResources = {
    transmittance,
    transmittanceView: transmittance.createView(),
    inscatter,
    inscatterView: inscatter.createView(),
    paramsBuffer,
    paramsData,
    bindGroup: null,
    moonTransmittance,
    moonTransmittanceView: moonTransmittance.createView(),
    moonInscatter,
    moonInscatterView: moonInscatter.createView(),
    moonParamsBuffer,
    moonParamsData,
    moonBindGroup: null,
    bindGroupLayout: null,
    multipleScatter,
    multipleScatterView: multipleScatter.createView(),
    irradiance,
    irradianceView: irradiance.createView(),
    skyView,
    skyViewView: skyView.createView(),
    extendedSampler: null,
    extendedBindGroupLayout: null,
    extendedBindGroup: null,
    emptyGroup0BindGroupLayout: null,
    emptyGroup0BindGroup: null,
    width,
    transmittanceHeight,
    inscatterHeight,
  };

  return {
    transmittanceView: host._atmosphereLutResources.transmittanceView,
    inscatterView: host._atmosphereLutResources.inscatterView,
    moonTransmittanceView: host._atmosphereLutResources.moonTransmittanceView,
    moonInscatterView: host._atmosphereLutResources.moonInscatterView,
    multipleScatterView: host._atmosphereLutResources.multipleScatterView,
    skyViewView: host._atmosphereLutResources.skyViewView,
  };
}

export function dispatchAtmosphereLUT(
  host: AtmosphereLUTHost,
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  params: {
    innerRadius: number;
    outerRadius: number;
    rayleighScaleHeight: number;
    mieScaleHeight: number;
    mieAnisotropy: number;
    intensity: number;
    rayleighCoefficient: [number, number, number];
    mieCoefficient: [number, number, number];
    sunDirection: [number, number, number];
    // Batch 428 (A-LUT-REPARAM) — cosine of the sun's zenith angle relative to
    // the OBSERVER's local up (dot(sunDir, normalize(cameraWC))). The
    // single-scatter/MS/irradiance bakes use the synthetic Y-up frame where the
    // sun's elevation is implicit; the sky-view bake (computeSkyView) needs the
    // true observer-relative sun zenith to place the sun on its canonical
    // meridian at the correct elevation. Optional — defaults to sunDirection[1]
    // (the legacy synthetic-frame behavior) for callers that don't supply it.
    sunCosZenith?: number;
  },
  target: "sun" | "moon" = "sun",
): boolean {
  if (!host._context.supportsComputeShaders) return false;
  const res = ensureAtmosphereLUTResources(host, device);
  if (!res || !host._atmosphereLutResources) return false;
  const lut = host._atmosphereLutResources;

  const isMoon = target === "moon";
  const f = isMoon ? lut.moonParamsData : lut.paramsData;
  const paramsBuffer = isMoon ? lut.moonParamsBuffer : lut.paramsBuffer;
  const transmittanceView = isMoon
    ? lut.moonTransmittanceView
    : lut.transmittanceView;
  const inscatterView = isMoon ? lut.moonInscatterView : lut.inscatterView;

  f[0] = params.innerRadius;
  f[1] = params.outerRadius;
  f[2] = params.rayleighScaleHeight;
  f[3] = params.mieScaleHeight;
  f[4] = params.mieAnisotropy;
  f[5] = params.intensity;
  const u32 = new Uint32Array(f.buffer, f.byteOffset, f.length);
  u32[6] = lut.width;
  u32[7] = lut.transmittanceHeight;
  f[8] = params.rayleighCoefficient[0];
  f[9] = params.rayleighCoefficient[1];
  f[10] = params.rayleighCoefficient[2];
  f[12] = params.mieCoefficient[0];
  f[13] = params.mieCoefficient[1];
  f[14] = params.mieCoefficient[2];
  f[16] = params.sunDirection[0];
  f[17] = params.sunDirection[1];
  f[18] = params.sunDirection[2];
  // Batch 428 (A-LUT-REPARAM) — observer-relative sun zenith cosine in the
  // _pad2 slot (f[19]). Consumed only by computeSkyView; the other kernels
  // ignore it. Default to sunDirection[1] (synthetic-frame .y) when omitted.
  f[19] =
    params.sunCosZenith !== undefined
      ? params.sunCosZenith
      : params.sunDirection[1];

  device.queue.writeBuffer(
    paramsBuffer,
    0,
    f.buffer,
    f.byteOffset,
    f.byteLength,
  );

  if (!lut.bindGroupLayout) {
    lut.bindGroupLayout = makeBindGroupLayout(device, "AtmosphereLUT_BGL", [
      uniformBuffer(0, Stage.COMPUTE),
      storageTexture(1, Stage.COMPUTE, "rgba16float"),
      storageTexture(2, Stage.COMPUTE, "rgba16float"),
    ]);
  }

  let targetBindGroup: GPUBindGroup | null;
  if (isMoon) {
    if (!lut.moonBindGroup) {
      lut.moonBindGroup = device.createBindGroup({
        label: "AtmosphereLUT_BG_Moon",
        layout: lut.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: transmittanceView },
          { binding: 2, resource: inscatterView },
        ],
      });
    }
    targetBindGroup = lut.moonBindGroup;
  } else {
    if (!lut.bindGroup) {
      lut.bindGroup = device.createBindGroup({
        label: "AtmosphereLUT_BG_Sun",
        layout: lut.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: transmittanceView },
          { binding: 2, resource: inscatterView },
        ],
      });
    }
    targetBindGroup = lut.bindGroup;
  }

  const wgsX = Math.ceil(lut.width / 16);
  const wgsT = Math.ceil(lut.transmittanceHeight / 16);
  const wgsI = Math.ceil(lut.inscatterHeight / 16);

  // V0 — build the base LUT pipelines with the EXPLICIT group-0 layout instead of
  // layout:"auto". The sun/moon bind groups are created from `AtmosphereLUT_BGL`;
  // an auto-layout pipeline derives its own (different) BGL and rejects them
  // ("bind group ... was not created by the pipeline" → invalid command buffer).
  const baseLayouts = [lut.bindGroupLayout];
  host.dispatchCompute(
    encoder,
    ComputeTaskType.ATMOSPHERE_LUT,
    [{ index: 0, bindGroup: targetBindGroup }],
    wgsX,
    wgsT,
    1,
    "computeTransmittance",
    baseLayouts,
  );
  host.dispatchCompute(
    encoder,
    ComputeTaskType.ATMOSPHERE_LUT,
    [{ index: 0, bindGroup: targetBindGroup }],
    wgsX,
    wgsI,
    1,
    "computeInscatter",
    baseLayouts,
  );

  return true;
}

/**
 * Track V-A1 — dispatch the two full-Bruneton extension passes
 * (`computeMultipleScattering`, `computeIrradiance`) for the SUN LUT pair.
 *
 * MUST be called AFTER {@link dispatchAtmosphereLUT}(…, "sun") in the same
 * (or a later) command encoder: the extended passes read the sun
 * transmittance + single-scattering LUTs as sampled inputs. They write the
 * sun multiple-scattering + irradiance targets allocated by
 * {@link ensureAtmosphereLUTResources}.
 *
 * The extended kernels read their params from a SECOND uniform binding
 * (group 1, binding 0) — we reuse the already-packed sun params buffer, so
 * no extra `writeBuffer` is needed. The kernels never touch group 0, so the
 * auto-derived pipeline layout is a single group-1 bind group bound at
 * index 1.
 *
 * @returns true on success, false if compute is unavailable / resources missing.
 */
export function dispatchAtmosphereExtendedLUT(
  host: AtmosphereLUTHost,
  encoder: GPUCommandEncoder,
  device: GPUDevice,
): boolean {
  if (!host._context.supportsComputeShaders) return false;
  if (!host._atmosphereLutResources) return false;
  const lut = host._atmosphereLutResources;

  if (!lut.extendedSampler) {
    lut.extendedSampler = device.createSampler({
      label: "AtmosphereLUT_Extended_Sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  if (!lut.extendedBindGroupLayout) {
    lut.extendedBindGroupLayout = makeBindGroupLayout(
      device,
      "AtmosphereLUT_Extended_BGL",
      [
        uniformBuffer(0, Stage.COMPUTE),
        sampler(1, Stage.COMPUTE, "filtering"),
        texture(2, Stage.COMPUTE),
        texture(3, Stage.COMPUTE),
        storageTexture(4, Stage.COMPUTE, "rgba16float"),
        storageTexture(5, Stage.COMPUTE, "rgba16float"),
        // Batch 428 (A-LUT-REPARAM) — sky-view LUT storage output.
        storageTexture(6, Stage.COMPUTE, "rgba16float"),
      ],
    );
  }

  if (!lut.extendedBindGroup) {
    lut.extendedBindGroup = device.createBindGroup({
      label: "AtmosphereLUT_Extended_BG",
      layout: lut.extendedBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: lut.paramsBuffer } },
        { binding: 1, resource: lut.extendedSampler },
        { binding: 2, resource: lut.transmittanceView },
        { binding: 3, resource: lut.inscatterView },
        { binding: 4, resource: lut.multipleScatterView },
        { binding: 5, resource: lut.irradianceView },
        { binding: 6, resource: lut.skyViewView },
      ],
    });
  }

  // V0 — empty group-0 layout + bind group so the pipeline can be built with an
  // EXPLICIT layout [emptyGroup0, extended] (group 1 = the full 6-binding
  // extended layout). Without this the kernels build layout:"auto", which derives
  // a per-kernel SUBSET group-1 layout (each writes only one storage texture) and
  // rejects the full 6-binding extendedBindGroup at dispatch.
  if (!lut.emptyGroup0BindGroupLayout) {
    lut.emptyGroup0BindGroupLayout = device.createBindGroupLayout({
      label: "AtmosphereLUT_EmptyGroup0_BGL",
      entries: [],
    });
  }
  if (!lut.emptyGroup0BindGroup) {
    lut.emptyGroup0BindGroup = device.createBindGroup({
      label: "AtmosphereLUT_EmptyGroup0_BG",
      layout: lut.emptyGroup0BindGroupLayout,
      entries: [],
    });
  }

  const wgsX = Math.ceil(lut.width / 16);
  const wgsMS = Math.ceil(lut.inscatterHeight / 16);
  const wgsIrr = Math.ceil(lut.transmittanceHeight / 16);

  // Both extended kernels bind their resources at group index 1; group 0 is an
  // empty bind group satisfying the explicit pipeline layout.
  const extendedLayouts = [
    lut.emptyGroup0BindGroupLayout,
    lut.extendedBindGroupLayout,
  ];
  const extendedGroups = [
    { index: 0, bindGroup: lut.emptyGroup0BindGroup },
    { index: 1, bindGroup: lut.extendedBindGroup },
  ];
  host.dispatchCompute(
    encoder,
    ComputeTaskType.ATMOSPHERE_LUT,
    extendedGroups,
    wgsX,
    wgsMS,
    1,
    "computeMultipleScattering",
    extendedLayouts,
  );
  host.dispatchCompute(
    encoder,
    ComputeTaskType.ATMOSPHERE_LUT,
    extendedGroups,
    wgsX,
    wgsIrr,
    1,
    "computeIrradiance",
    extendedLayouts,
  );

  // Batch 428 (A-LUT-REPARAM / NEW-ATMOSPHERE-LUT-SUN-RELATIVE) — sun-relative
  // sky-view LUT (Hillaire 2020). Same 256×128 dims as the inscatter LUT, so it
  // dispatches over the inscatter-height workgroup grid. Reads the transmittance
  // LUT + scattering constants from the shared group-1 extended bind group;
  // writes binding 6. Opt-in consumer (`skyAtmosphere.useScatteringLut`) — the
  // bake runs whenever the extended pass runs but is visually inert until the
  // sky shader's flag is on.
  host.dispatchCompute(
    encoder,
    ComputeTaskType.ATMOSPHERE_LUT,
    extendedGroups,
    wgsX,
    wgsMS,
    1,
    "computeSkyView",
    extendedLayouts,
  );

  return true;
}
