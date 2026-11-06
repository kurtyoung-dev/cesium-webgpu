/**
 * The default-limits device dial: a page init source that makes the page's
 * WebGPU device a default-limits device, and the Node side that reads back what
 * the page asked for, what the device got and whether the two match the
 * WebGPU defaults.
 * @purpose Page init source (addInitScript) that wraps GPUAdapter.prototype.requestDevice so the device is requested without requiredLimits (the WebGPU default limits) while every other descriptor field passes through, recording what the page had asked for; the WEBGPU_DEFAULT_LIMITS table, the page reader of the created device's limits (pageReadDeviceLimits), the pure comparator against the table (compareDeviceLimits), the Node-side reader (readDeviceLimits) and the one-line summary text (deviceLimitsLine).
 * @status ACTIVE
 *
 * WHY. The CesiumViewer page offers no way to pass device limits: the engine's
 * device pool asks the adapter for the limits it wants (`requiredLimits`) and
 * the viewer takes whatever it gets. A cell that must show how the scene lives
 * on a device with only the default per-stage binding limits (16 sampled
 * textures, 12 uniform buffers, ...) cannot ask the page, so the dial strips
 * the field in the one place every page passes through, before the page's
 * scripts run.
 *
 * WHAT IT CHANGES, AND WHAT IT KEEPS. Only `requiredLimits` is removed from the
 * descriptor that reaches the browser's own `requestDevice`; `requiredFeatures`,
 * `label`, `defaultQueue` and anything else pass through unchanged (a copy is
 * passed, the page's object is never modified). What the page asked for is
 * kept in `window.__deviceLimitsDial.requests`, one record per call:
 * `{requiredLimits, requiredFeatures, label}` with the limits as plain numbers.
 *
 * WHAT THE COMPARISON MEANS. A device requested without `requiredLimits`
 * reports exactly the default for every limit, so the comparator names a key
 * whose device value is not the default: that device was not a default-limits
 * device (the dial was not in front of the request, or the page asked for the
 * device some other way). The table lists the WebGPU specification's default
 * values for the keys it names; a key the device does not report is listed as
 * missing, never as differing.
 *
 * USAGE.
 *   await page.addInitScript({ content: DEVICE_LIMITS_DIAL_INIT_SOURCE }); // before goto
 *   ... load the page ...
 *   const limits = await readDeviceLimits(page);
 *
 * @module Tools/visual-regression/lib/device-limits-dial
 */

/**
 * The WebGPU specification's default limit values for the keys the dial
 * compares: the binding limits (per shader stage and per pipeline layout), bind
 * groups, texture dimensions, buffer sizes and alignments, vertex and
 * attachment limits and the compute workgroup limits. Frozen.
 */
export const WEBGPU_DEFAULT_LIMITS = Object.freeze({
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
});

/** The cell field value that installs the dial. */
export const DEVICE_LIMITS_MODE = "webgpu-default";

/**
 * Page-context installer. Self-contained. A page without
 * `GPUAdapter.prototype.requestDevice` gets `installed: false`. Installing
 * twice is a no-op.
 */
export function installDeviceLimitsDial() {
  const w = /** @type {any} */ (globalThis);
  if (w.__deviceLimitsDial) {
    return;
  }
  const dial = { installed: false, requests: [] };
  w.__deviceLimitsDial = dial;
  const AdapterProto = w.GPUAdapter && w.GPUAdapter.prototype;
  if (!AdapterProto || typeof AdapterProto.requestDevice !== "function") {
    return;
  }
  const requestDevice = AdapterProto.requestDevice;
  const numbersOf = (limits) => {
    const out = {};
    if (limits && typeof limits === "object") {
      for (const key of Object.keys(limits)) {
        const value = Number(limits[key]);
        if (Number.isFinite(value)) {
          out[key] = value;
        }
      }
    }
    return out;
  };
  AdapterProto.requestDevice = function (descriptor, ...rest) {
    const given = descriptor !== null && typeof descriptor === "object";
    const features = given ? descriptor.requiredFeatures : undefined;
    dial.requests.push({
      requiredLimits:
        given && descriptor.requiredLimits
          ? numbersOf(descriptor.requiredLimits)
          : null,
      requiredFeatures: features ? Array.from(features, String) : [],
      label:
        given && typeof descriptor.label === "string" ? descriptor.label : null,
    });
    let passed = descriptor;
    if (given && "requiredLimits" in descriptor) {
      passed = { ...descriptor };
      delete passed.requiredLimits;
    }
    return requestDevice.call(this, passed, ...rest);
  };
  dial.installed = true;
}

/**
 * The init script, as source text. Pass it as
 * `page.addInitScript({ content: DEVICE_LIMITS_DIAL_INIT_SOURCE })`.
 */
export const DEVICE_LIMITS_DIAL_INIT_SOURCE = `(${installDeviceLimitsDial.toString()})();`;

/**
 * Page function: what the dial recorded and the limits the viewer's device
 * reports for `keys`. Self-contained (it runs in the browser alone).
 *
 * @param {{keys: string[]}} args The limit keys to read.
 * @returns {{installed: boolean, requests: object[], device: {found: boolean,
 *   limits: Record<string, number>}}}
 */
export function pageReadDeviceLimits({ keys }) {
  const w = /** @type {any} */ (globalThis);
  const dial = w.__deviceLimitsDial;
  const context = w.viewer && w.viewer.scene && w.viewer.scene.context;
  const device = context ? (context.device ?? context._device ?? null) : null;
  const limits = {};
  if (device && device.limits) {
    for (const key of keys) {
      const value = Number(device.limits[key]);
      if (Number.isFinite(value)) {
        limits[key] = value;
      }
    }
  }
  return {
    installed: !!dial && dial.installed === true,
    requests: dial ? dial.requests.slice(0, 20) : [],
    device: { found: !!device, limits },
  };
}

/**
 * Compare a device's limits with a defaults table. Pure.
 *
 * @param {Record<string, number>} deviceLimits What the device reported.
 * @param {Record<string, number>} [defaults]
 * @returns {{equal: boolean, compared: number, differing: Array<{key: string,
 *   device: number, default: number}>, missing: string[]}} `equal` is true
 *   only when at least one key was compared, none differs and none is missing.
 */
export function compareDeviceLimits(
  deviceLimits,
  defaults = WEBGPU_DEFAULT_LIMITS,
) {
  const differing = [];
  const missing = [];
  let compared = 0;
  for (const [key, expected] of Object.entries(defaults)) {
    const value = deviceLimits?.[key];
    if (!Number.isFinite(value)) {
      missing.push(key);
      continue;
    }
    compared++;
    if (value !== expected) {
      differing.push({ key, device: value, default: expected });
    }
  }
  return {
    equal: compared > 0 && differing.length === 0 && missing.length === 0,
    compared,
    differing,
    missing,
  };
}

/**
 * Read the dial's record and the device's limits from a page and compare them
 * with the defaults. Node only.
 *
 * @param {object} page A Playwright page.
 * @returns {Promise<{mode: string, installed: boolean, requested: object[],
 *   device: {found: boolean, limits: Record<string, number>},
 *   comparison: object}>}
 */
export async function readDeviceLimits(page) {
  const raw = await page.evaluate(pageReadDeviceLimits, {
    keys: Object.keys(WEBGPU_DEFAULT_LIMITS),
  });
  return {
    mode: DEVICE_LIMITS_MODE,
    installed: raw?.installed === true,
    requested: Array.isArray(raw?.requests) ? raw.requests : [],
    device: {
      found: raw?.device?.found === true,
      limits: raw?.device?.limits ?? {},
    },
    comparison: compareDeviceLimits(raw?.device?.limits ?? {}),
  };
}

/**
 * The summary line of a page's device-limits record. Pure.
 *
 * @param {object|null|undefined} record {@link readDeviceLimits}' answer.
 * @returns {string}
 */
export function deviceLimitsLine(record) {
  if (!record) {
    return "device limits: not recorded";
  }
  const asked = record.requested?.[0]?.requiredLimits;
  let askedText = "no device request seen";
  if (asked === null) {
    askedText = "the page asked for no limits";
  } else if (asked !== undefined) {
    askedText = `the page asked for ${Object.keys(asked).length} limits`;
  }
  if (!record.installed) {
    return `device limits: dial not installed (${askedText})`;
  }
  if (!record.device?.found) {
    return `device limits: no device found (${askedText})`;
  }
  const { equal, differing, missing, compared } = record.comparison;
  const parts = [
    ...differing.map((d) => `${d.key} ${d.device} (default ${d.default})`),
    ...(missing.length > 0 ? [`${missing.length} keys not reported`] : []),
  ];
  const verdict = equal
    ? `the device reports the WebGPU defaults on ${compared} keys`
    : `the device differs from the WebGPU defaults: ${parts.join(", ")}`;
  return `device limits: ${askedText}; ${verdict}`;
}
