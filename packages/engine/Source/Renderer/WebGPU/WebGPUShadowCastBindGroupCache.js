import defined from "../../Core/defined.js";

/**
 * Resolve a raw GPUBuffer from a WebGPUBuffer wrapper or an already-raw
 * GPUBuffer.
 *
 * @param {object} source Buffer source.
 * @returns {GPUBuffer|undefined} Raw buffer.
 * @private
 */
function resolveShadowCastBuffer(source) {
  if (!defined(source)) {
    return undefined;
  }
  // WebGPUBuffer keeps the raw buffer accessible after destroy(), so reject a
  // destroyed wrapper before unwrapping it. A raw GPUBuffer does not expose an
  // `isDestroyed` property.
  if (source.isDestroyed === true) {
    return undefined;
  }

  // Use property presence rather than `defined(source.buffer)`. A wrapper with
  // an absent/null backing buffer is not itself a valid GPUBuffer and must fail
  // closed instead of being passed to createBindGroup as the resource.
  return "buffer" in source ? source.buffer : source;
}

const cacheProperty = "_shadowCastBindGroupCacheDevices";

/**
 * Finds the terminal weak-cache node for one exact bind-group resource tuple.
 *
 * Weak identity layers prevent a stable model primitive from retaining every
 * obsolete device/layout/buffer tuple after device recovery or resource
 * replacement. Binding numbers use ordinary Maps because they are primitive
 * values; every GPU resource identity remains a WeakMap key.
 *
 * @param {object} host Stable resource host.
 * @param {GPUDevice} device Physical device.
 * @param {GPUBindGroupLayout} layout Exact bind-group layout.
 * @param {GPUBuffer} sharedBuffer Shadow-map/cascade uniform buffer.
 * @param {GPUBindGroupLayoutEntry[]} extraBindings Variant bindings 1..N.
 * @param {string[]} fields Command property names parallel to extraBindings.
 * @param {object} command Current command carrying the resource fields.
 * @returns {object|undefined} Terminal cache node, or undefined when a
 * required resource is absent.
 * @private
 */
function getShadowCastBindGroupCacheNode(
  host,
  device,
  layout,
  sharedBuffer,
  extraBindings,
  fields,
  command,
) {
  let deviceCache = host[cacheProperty];
  if (!defined(deviceCache)) {
    deviceCache = host[cacheProperty] = new WeakMap();
  }

  let layoutCache = deviceCache.get(device);
  if (!defined(layoutCache)) {
    layoutCache = new WeakMap();
    deviceCache.set(device, layoutCache);
  }

  let sharedBufferCache = layoutCache.get(layout);
  if (!defined(sharedBufferCache)) {
    sharedBufferCache = new WeakMap();
    layoutCache.set(layout, sharedBufferCache);
  }

  let node = sharedBufferCache.get(sharedBuffer);
  if (!defined(node)) {
    node = {};
    sharedBufferCache.set(sharedBuffer, node);
  }

  for (let i = 0; i < fields.length; i++) {
    const buffer = resolveShadowCastBuffer(command[fields[i]]);
    if (!defined(buffer)) {
      return undefined;
    }

    let bindingCache = node.bindingCache;
    if (!defined(bindingCache)) {
      bindingCache = node.bindingCache = new Map();
    }

    const binding = extraBindings[i].binding;
    let bufferCache = bindingCache.get(binding);
    if (!defined(bufferCache)) {
      bufferCache = new WeakMap();
      bindingCache.set(binding, bufferCache);
    }

    let nextNode = bufferCache.get(buffer);
    if (!defined(nextNode)) {
      nextNode = {};
      bufferCache.set(buffer, nextNode);
    }
    node = nextNode;
  }

  return node;
}

/**
 * Get or create a shadow-cast bind group on a stable resource host.
 *
 * Commands are often rebuilt every frame, so command-local caching silently
 * degenerates into one bind-group allocation per caster per frame. The host is
 * instead owned by the persistent primitive/node resource record. Cache
 * identity includes the physical device, layout object, shared cast UBO, and
 * every per-command buffer consumed by the selected shader variant.
 *
 * The hit path allocates no descriptors or temporary arrays.
 *
 * @param {GPUDevice} device Physical device.
 * @param {object} host Stable resource host.
 * @param {string} label Debug label for a miss.
 * @param {GPUBindGroupLayout} layout Exact bind-group layout.
 * @param {GPUBuffer} sharedBuffer Shadow-map/cascade uniform buffer.
 * @param {GPUBindGroupLayoutEntry[]} extraBindings Variant bindings 1..N.
 * @param {string[]} fields Command property names parallel to extraBindings.
 * @param {object} command Current command carrying the resource fields.
 * @returns {GPUBindGroup|undefined} Cached/created group, or undefined when a
 * required resource is absent.
 * @private
 */
function getOrCreateShadowCastBindGroup(
  device,
  host,
  label,
  layout,
  sharedBuffer,
  extraBindings,
  fields,
  command,
) {
  if (
    !defined(device) ||
    !defined(host) ||
    !defined(layout) ||
    !defined(sharedBuffer) ||
    !defined(extraBindings) ||
    !defined(fields) ||
    !defined(command) ||
    extraBindings.length !== fields.length
  ) {
    return undefined;
  }

  const cacheNode = getShadowCastBindGroupCacheNode(
    host,
    device,
    layout,
    sharedBuffer,
    extraBindings,
    fields,
    command,
  );
  if (!defined(cacheNode)) {
    return undefined;
  }
  if (defined(cacheNode.bindGroup)) {
    return cacheNode.bindGroup;
  }

  const entries = [
    {
      binding: 0,
      resource: { buffer: sharedBuffer },
    },
  ];
  for (let i = 0; i < fields.length; i++) {
    const buffer = resolveShadowCastBuffer(command[fields[i]]);
    entries.push({
      binding: extraBindings[i].binding,
      resource: { buffer: buffer },
    });
  }

  const bindGroup = device.createBindGroup({
    label: label,
    layout: layout,
    entries: entries,
  });
  cacheNode.bindGroup = bindGroup;
  return bindGroup;
}

export { getOrCreateShadowCastBindGroup, resolveShadowCastBuffer };
export default {
  getOrCreateShadowCastBindGroup,
  resolveShadowCastBuffer,
};
