/// <reference types="@webgpu/types" />
/**
 * Atmosphere-LUT resource builder and dispatcher used by
 * `WebGPUPerformanceManager`.
 *
 * Owns the two heavy LUT methods:
 *   - `ensureAtmosphereLUTResources(host, device)` allocates the sun and moon
 *     transmittance/inscatter texture pairs and their parameter UBOs. It
 *     caches the resources on the host and is idempotent.
 *   - `dispatchAtmosphereLUT(host, encoder, device, params, target)` packs
 *     parameters, lazily builds shared layouts and per-target bind groups,
 *     then dispatches the LUT compute entry points through the host's
 *     `dispatchCompute` method.
 *
 * The flag-management methods (`shouldRecomputeAtmosphereLUT`,
 * `invalidateAtmosphereLUT`, and their moon equivalents) stay on the manager
 * because they directly control its invalidation state.
 *
 * References:
 *   - Eric Bruneton and Fabrice Neyret, "Precomputed Atmospheric Scattering",
 *     Computer Graphics Forum 27(4), 1079 (2008) —
 *     {@link https://hal.inria.fr/inria-00288758}. The transmittance and
 *     inscatter table parameterisation the texture pair below is sized and
 *     addressed for.
 *   - Sebastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
 *     Rendering Technique", Computer Graphics Forum 39(4), 13 (2020) —
 *     {@link https://sebh.github.io/publications/egsr2020.pdf}, for the
 *     multiple-scattering term the second dispatch accumulates.
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
  device: GPUDevice;
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
  // Multiple scattering and irradiance are sun-only; the moon path retains
  // transmittance and single scattering.
  multipleScatter: GPUTexture;
  multipleScatterView: GPUTextureView;
  irradiance: GPUTexture;
  irradianceView: GPUTextureView;
  // The sun-relative sky-view LUT (Hillaire 2020) shares the inscatter
  // dimensions but uses a separate relative-azimuth × warped-view-zenith
  // parameterization. Keeping it separate preserves the legacy inscatter
  // LUT's altitude × view-zenith mapping for fog, globe, voxel, splat, and
  // point-cloud consumers. The sky fragment shader samples it only when
  // `skyAtmosphere.useScatteringLut` is enabled; the default inline-march
  // path does not read it.
  skyView: GPUTexture;
  skyViewView: GPUTextureView;
  // Sampler + group-1 bind group for the extended passes (read single-scatter
  // + transmittance as sampled inputs, write multiple-scatter + irradiance).
  extendedSampler: GPUSampler | null;
  extendedBindGroupLayout: GPUBindGroupLayout | null;
  extendedBindGroup: GPUBindGroup | null;
  // The extended compute pipelines need an explicit layout with an empty
  // group 0 and the full extended layout at group 1. An automatic layout is
  // derived separately for each kernel and omits unused storage textures,
  // making it incompatible with the shared `extendedBindGroup` at dispatch.
  emptyGroup0BindGroupLayout: GPUBindGroupLayout | null;
  emptyGroup0BindGroup: GPUBindGroup | null;
  width: number;
  inscatterHeight: number;
  transmittanceHeight: number;
}

function tryDestroyGpuResource(resource: GPUTexture | GPUBuffer): void {
  try {
    resource.destroy();
  } catch {
    // A lost device can reject native teardown; remaining resources still drain.
  }
}

export function destroyAtmosphereLUTResources(
  resources: AtmosphereLUTResources | null,
): void {
  if (!resources) {
    return;
  }

  const ownedResources: (GPUTexture | GPUBuffer)[] = [
    resources.transmittance,
    resources.inscatter,
    resources.moonTransmittance,
    resources.moonInscatter,
    resources.multipleScatter,
    resources.irradiance,
    resources.skyView,
    resources.paramsBuffer,
    resources.moonParamsBuffer,
  ];
  for (const resource of ownedResources) {
    tryDestroyGpuResource(resource);
  }
}

export function shouldRebuildAtmosphereLUTResources(
  cached: Pick<AtmosphereLUTResources, "device"> | null,
  liveDevice: GPUDevice,
): boolean {
  return cached === null || cached.device !== liveDevice;
}

/**
 * Subset of `WebGPUPerformanceManager` reached by the atmosphere LUT helpers.
 * The renderer exposes these members using its underscore-public convention.
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
  // The multiple-scattering view is exposed for the sky fragment shader's
  // opt-in sampling path.
  multipleScatterView: GPUTextureView;
  // The separate sun-relative sky-view LUT is exposed for `useScatteringLut`;
  // the legacy inscatter view remains unchanged.
  skyViewView: GPUTextureView;
} | null {
  const cached = host._atmosphereLutResources;
  if (!shouldRebuildAtmosphereLUTResources(cached, device)) {
    return {
      transmittanceView: cached!.transmittanceView,
      inscatterView: cached!.inscatterView,
      moonTransmittanceView: cached!.moonTransmittanceView,
      moonInscatterView: cached!.moonInscatterView,
      multipleScatterView: cached!.multipleScatterView,
      skyViewView: cached!.skyViewView,
    };
  }
  host._atmosphereLutResources = null;
  destroyAtmosphereLUTResources(cached);

  // Standard LUT dimensions per Bruneton & Neyret / Hillaire conventions.
  // Transmittance is 256×64. Inscatter folds altitude and sun zenith into
  // 256×128.
  const width = 256;
  const transmittanceHeight = 64;
  const inscatterHeight = 128;

  // COPY_SRC lets diagnostics read back the LUTs via `copyTextureToBuffer`.
  // The sun transmittance and inscatter textures also have TEXTURE_BINDING so
  // the extension passes can sample them as inputs. The cost is negligible
  // because these are small precompute targets.
  const usage =
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_SRC;

  // Sun LUT pair.
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

  // Moon LUT pair.
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

  // Full-Bruneton extension targets for the sun.
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
  // The sky-view LUT has the inscatter LUT's dimensions but a separate
  // parameterization. Matching usage flags allow readback and sky sampling.
  const skyView = device.createTexture({
    label: "AtmosphereLUT_Sun_SkyView",
    size: { width, height: inscatterHeight },
    format: "rgba16float",
    usage,
  });

  // The 24-float parameter block stores `ozoneCoefficient: vec3<f32>` and its
  // padding at the next 16-byte boundary after `sunCosZenith` (float offset
  // 20). The uniform buffer remains padded to 256 bytes.
  const paramsData = new Float32Array(24);
  const paramsBuffer = device.createBuffer({
    label: "AtmosphereLUT_Sun_Params",
    size: Math.max(paramsData.byteLength, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const moonParamsData = new Float32Array(24);
  const moonParamsBuffer = device.createBuffer({
    label: "AtmosphereLUT_Moon_Params",
    size: Math.max(moonParamsData.byteLength, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  host._atmosphereLutResources = {
    device,
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
    // Cosine of the sun's zenith angle relative to the observer's local up,
    // `dot(sunDir, normalize(cameraWC))`. `computeSkyView` needs the true
    // observer-relative zenith to place the sun at the correct elevation.
    // Other bakes use a synthetic Y-up frame. Callers that omit this value
    // retain that behavior through the `sunDirection[1]` default.
    sunCosZenith?: number;
    // Ozone Chappuis-band absorption coefficient in inverse metres, as RGB.
    // It is a pure absorber in every Beer-Lambert extinction factor. Omitting
    // it selects `[0, 0, 0]`, whose `exp(-0)` factor is the identity.
    ozoneCoefficient?: [number, number, number];
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
  // `computeSkyView` alone consumes the observer-relative sun-zenith cosine
  // in `_pad2` (`f[19]`). The fallback preserves the synthetic frame used by
  // callers that omit it.
  f[19] =
    params.sunCosZenith !== undefined
      ? params.sunCosZenith
      : params.sunDirection[1];
  // The ozone coefficient begins at float offset 20, the next 16-byte
  // boundary after `sunCosZenith`; `[0, 0, 0]` gives identity extinction.
  // `f[23]` is `_pad3`.
  const ozone = params.ozoneCoefficient;
  f[20] = ozone !== undefined ? ozone[0] : 0.0;
  f[21] = ozone !== undefined ? ozone[1] : 0.0;
  f[22] = ozone !== undefined ? ozone[2] : 0.0;
  f[23] = 0.0;

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

  // Build base LUT pipelines with the explicit group-0 layout. Using
  // `layout: "auto"` derives a different bind-group layout that rejects the
  // sun and moon groups created from `AtmosphereLUT_BGL`.
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
 * Dispatches the two full-Bruneton extension passes
 * (`computeMultipleScattering` and `computeIrradiance`) for the sun LUT pair.
 *
 * Call this after {@link dispatchAtmosphereLUT}(…, "sun") in the same or a
 * later command encoder because the extension passes read the sun
 * transmittance and single-scattering LUTs as sampled inputs. They write the
 * sun multiple-scattering and irradiance targets allocated by
 * {@link ensureAtmosphereLUTResources}.
 *
 * The extension kernels read their parameters from group 1, binding 0.
 * Reusing the packed sun-parameter buffer avoids another `writeBuffer`. Since
 * the kernels never touch group 0, their auto-derived layout contains one
 * group-1 bind group at index 1.
 *
 * @returns True on success, or false when compute or resources are
 *          unavailable.
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
        // Sky-view LUT storage output.
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

  // The empty group-0 layout lets the pipeline use the full extension layout
  // at group 1. An automatic per-kernel layout omits unused storage textures
  // and rejects the shared `extendedBindGroup` at dispatch.
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

  // Both extension kernels bind their resources at group index 1. Group 0 is
  // an empty bind group satisfying the explicit pipeline layout.
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

  // The sun-relative sky-view LUT uses the inscatter-height workgroup grid.
  // It reads transmittance and scattering constants from the shared extension
  // bind group, writes binding 6, and is sampled only when
  // `skyAtmosphere.useScatteringLut` is enabled.
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
