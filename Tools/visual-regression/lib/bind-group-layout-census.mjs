/**
 * The live bind-group-layout census: what the page's bind group layouts bind
 * per shader stage, and at which group index each labelled layout is used,
 * counted from the layouts the page creates.
 * @purpose Page init source (addInitScript) that wraps GPUDevice.prototype.createBindGroupLayout and createPipelineLayout and records, per layout label, the entries visible to each shader stage (vertex 1, fragment 2, compute 4) by kind (sampled textures, uniform buffers, storage buffers, samplers, storage textures, external textures) and the group index each labelled layout takes in the pipeline layouts created, holding no reference to any layout; the page reader (pageReadBindGroupLayoutCensus), the pure row builder that sets each count against the WebGPU default per-stage limits and the device's own (layoutCensusRows), the Node-side reader (readBindGroupLayoutCensus) and the summary line text (layoutCensusLine).
 * @status ACTIVE
 *
 * WHY. The per-stage binding limits (16 sampled textures, 12 uniform buffers,
 * 8 storage buffers, 16 samplers, 4 storage textures by default) are the
 * limits a layout hits first, and the engine source can only say what a layout
 * is meant to bind. This census says what the page created: the numbers come
 * from the descriptors the browser was handed, never from source text.
 *
 * WHAT IS COUNTED. Each entry of a layout descriptor has a `visibility` bit
 * set (vertex 1, fragment 2, compute 4) and exactly one binding kind: `texture`
 * is a sampled texture, `buffer` a uniform buffer (type `uniform`, or no type)
 * or a storage buffer (`storage`, `read-only-storage`), `sampler` a sampler,
 * `storageTexture` a storage texture, `externalTexture` an external texture. An
 * entry visible to two stages is counted in both. Per label the census keeps
 * the largest count seen per stage and kind over every creation of that label
 * (`created` says how many creations, `variants` how many differed in shape).
 *
 * GROUP INDEX. A pipeline layout names its bind group layouts by position; the
 * census maps each created layout object to its label and records, per label,
 * the positions it took and how many pipeline layouts took it there. Layouts
 * the engine never puts in a pipeline layout (an auto layout read back through
 * `getBindGroupLayout`) show no group.
 *
 * NO REFERENCES ARE HELD. The layout-to-label map is a `WeakMap`; the census
 * object holds numbers and label strings only.
 *
 * LIMITS ARE PER LAYOUT HERE. The WebGPU per-stage limits apply across all the
 * bind groups of a pipeline layout; a row reports each label's own counts
 * against them, so a label near a limit is visible, and the sum across groups is
 * for a reader who knows which layouts one pipeline combines.
 *
 * USAGE.
 *   await page.addInitScript({ content: BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE }); // before goto
 *   ... drive the page ...
 *   const census = await readBindGroupLayoutCensus(page, ["ProceduralClouds BGL"]);
 *
 * @module Tools/visual-regression/lib/bind-group-layout-census
 */

import { WEBGPU_DEFAULT_LIMITS } from "./device-limits-dial.mjs";

/** The shader stages, in the order a row reports them. */
export const LAYOUT_STAGES = Object.freeze(["vertex", "fragment", "compute"]);

/**
 * The binding kinds a count is kept for, each with the per-stage limit key it
 * is held to (null: the specification names no per-stage limit for the kind).
 */
export const LAYOUT_KINDS = Object.freeze({
  sampledTextures: "maxSampledTexturesPerShaderStage",
  uniformBuffers: "maxUniformBuffersPerShaderStage",
  storageBuffers: "maxStorageBuffersPerShaderStage",
  samplers: "maxSamplersPerShaderStage",
  storageTextures: "maxStorageTexturesPerShaderStage",
  externalTextures: null,
});

/**
 * Page-context installer. Self-contained. A page without `GPUDevice` gets an
 * empty census with `installed: false`. Installing twice is a no-op.
 */
export function installBindGroupLayoutCensus() {
  const w = /** @type {any} */ (globalThis);
  if (w.__bindGroupLayoutCensus) {
    return;
  }
  const census = { installed: false, layouts: {}, groups: {}, unlabelled: 0 };
  w.__bindGroupLayoutCensus = census;
  const DeviceProto = w.GPUDevice && w.GPUDevice.prototype;
  if (!DeviceProto || typeof DeviceProto.createBindGroupLayout !== "function") {
    return;
  }
  const STAGES = [
    ["vertex", 1],
    ["fragment", 2],
    ["compute", 4],
  ];
  const KINDS = [
    "sampledTextures",
    "uniformBuffers",
    "storageBuffers",
    "samplers",
    "storageTextures",
    "externalTextures",
  ];
  const kindOf = (entry) => {
    if (entry.buffer !== undefined && entry.buffer !== null) {
      const type = entry.buffer.type;
      return type === "storage" || type === "read-only-storage"
        ? "storageBuffers"
        : "uniformBuffers";
    }
    if (entry.texture !== undefined && entry.texture !== null) {
      return "sampledTextures";
    }
    if (entry.sampler !== undefined && entry.sampler !== null) {
      return "samplers";
    }
    if (entry.storageTexture !== undefined && entry.storageTexture !== null) {
      return "storageTextures";
    }
    if (entry.externalTexture !== undefined && entry.externalTexture !== null) {
      return "externalTextures";
    }
    return null;
  };
  const emptyCounts = () => {
    const counts = {};
    for (const [stage] of STAGES) {
      counts[stage] = {};
      for (const kind of KINDS) {
        counts[stage][kind] = 0;
      }
    }
    return counts;
  };
  const countsOf = (entries) => {
    const counts = emptyCounts();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const kind = kindOf(entry);
      if (kind === null) {
        continue;
      }
      for (const [stage, bit] of STAGES) {
        if ((entry.visibility & bit) !== 0) {
          counts[stage][kind]++;
        }
      }
    }
    return counts;
  };
  const labelOfLayout = new WeakMap();
  const shapes = {};

  const createBindGroupLayout = DeviceProto.createBindGroupLayout;
  DeviceProto.createBindGroupLayout = function (descriptor, ...rest) {
    const layout = createBindGroupLayout.call(this, descriptor, ...rest);
    try {
      const label =
        descriptor && typeof descriptor.label === "string"
          ? descriptor.label
          : null;
      if (label === null) {
        census.unlabelled++;
      } else {
        const entries = Array.from(descriptor.entries ?? []);
        const counts = countsOf(entries);
        let row = census.layouts[label];
        if (!row) {
          row = census.layouts[label] = {
            created: 0,
            variants: 0,
            entries: 0,
            counts: emptyCounts(),
          };
          shapes[label] = new Set();
        }
        row.created++;
        row.entries = Math.max(row.entries, entries.length);
        const signature = JSON.stringify(counts);
        if (!shapes[label].has(signature)) {
          shapes[label].add(signature);
          row.variants = shapes[label].size;
        }
        for (const [stage] of STAGES) {
          for (const kind of KINDS) {
            row.counts[stage][kind] = Math.max(
              row.counts[stage][kind],
              counts[stage][kind],
            );
          }
        }
        if (layout !== null && typeof layout === "object") {
          labelOfLayout.set(layout, label);
        }
      }
    } catch {
      census.unlabelled++;
    }
    return layout;
  };

  const createPipelineLayout = DeviceProto.createPipelineLayout;
  if (typeof createPipelineLayout === "function") {
    DeviceProto.createPipelineLayout = function (descriptor, ...rest) {
      const layout = createPipelineLayout.call(this, descriptor, ...rest);
      try {
        const layouts = Array.from(descriptor?.bindGroupLayouts ?? []);
        layouts.forEach((bindGroupLayout, index) => {
          const label =
            bindGroupLayout !== null && typeof bindGroupLayout === "object"
              ? labelOfLayout.get(bindGroupLayout)
              : undefined;
          if (label !== undefined) {
            const slot = census.groups[label] ?? (census.groups[label] = {});
            slot[index] = (slot[index] ?? 0) + 1;
          }
        });
      } catch {
        // A descriptor the census cannot read is left uncounted.
      }
      return layout;
    };
  }
  census.installed = true;
}

/**
 * The init script, as source text. Pass it as
 * `page.addInitScript({ content: BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE })`.
 */
export const BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE = `(${installBindGroupLayoutCensus.toString()})();`;

/**
 * Page function: the census the page kept and the viewer's device limits for
 * `keys`. Self-contained (it runs in the browser alone).
 *
 * @param {{keys: string[]}} args The limit keys to read.
 * @returns {{installed: boolean, layouts: object, groups: object,
 *   unlabelled: number, device: {found: boolean, limits: Record<string, number>}}}
 */
export function pageReadBindGroupLayoutCensus({ keys }) {
  const w = /** @type {any} */ (globalThis);
  const census = w.__bindGroupLayoutCensus;
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
    installed: !!census && census.installed === true,
    layouts: census ? census.layouts : {},
    groups: census ? census.groups : {},
    unlabelled: census ? census.unlabelled : 0,
    device: { found: !!device, limits },
  };
}

/**
 * One row per requested label from a page's raw census. Pure.
 *
 * Each row: `{label, seen, created, variants, entries, groups, counts,
 * limits, overDefault, overDevice}`. `counts` is stage -> kind -> count;
 * `limits` is kind -> `{default, device}` for the kinds the specification
 * limits per stage (`device` null when the device was not read);
 * `overDefault` and `overDevice` list `stage.kind` for each count above the
 * default or the device's own limit. A label never created reads
 * `seen: false` with null `counts`.
 *
 * @param {object} raw {@link pageReadBindGroupLayoutCensus}' answer.
 * @param {string[]} labels The layout labels to report.
 * @returns {object[]}
 */
export function layoutCensusRows(raw, labels) {
  const limits = {};
  for (const [kind, key] of Object.entries(LAYOUT_KINDS)) {
    if (key !== null) {
      const device = raw?.device?.limits?.[key];
      limits[kind] = {
        default: WEBGPU_DEFAULT_LIMITS[key],
        device: Number.isFinite(device) ? device : null,
      };
    }
  }
  return labels.map((label) => {
    const layout = Object.hasOwn(raw?.layouts ?? {}, label)
      ? raw.layouts[label]
      : null;
    if (layout === null) {
      return {
        label,
        seen: false,
        created: 0,
        variants: 0,
        entries: 0,
        groups: [],
        counts: null,
        limits,
        overDefault: [],
        overDevice: [],
      };
    }
    const overDefault = [];
    const overDevice = [];
    for (const stage of LAYOUT_STAGES) {
      for (const [kind, bound] of Object.entries(limits)) {
        const count = layout.counts?.[stage]?.[kind] ?? 0;
        if (count > bound.default) {
          overDefault.push(`${stage}.${kind}`);
        }
        if (bound.device !== null && count > bound.device) {
          overDevice.push(`${stage}.${kind}`);
        }
      }
    }
    const groupRecord = Object.hasOwn(raw?.groups ?? {}, label)
      ? raw.groups[label]
      : {};
    return {
      label,
      seen: true,
      created: layout.created,
      variants: layout.variants,
      entries: layout.entries,
      groups: Object.keys(groupRecord)
        .map(Number)
        .sort((a, b) => a - b),
      counts: layout.counts,
      limits,
      overDefault,
      overDevice,
    };
  });
}

/**
 * Read the census from a page for `labels`. Node only.
 *
 * @param {object} page A Playwright page.
 * @param {string[]} labels
 * @returns {Promise<{installed: boolean, deviceFound: boolean,
 *   unlabelled: number, rows: object[]}>}
 */
export async function readBindGroupLayoutCensus(page, labels) {
  const raw = await page.evaluate(pageReadBindGroupLayoutCensus, {
    keys: Object.values(LAYOUT_KINDS).filter((key) => key !== null),
  });
  return {
    installed: raw?.installed === true,
    deviceFound: raw?.device?.found === true,
    unlabelled: raw?.unlabelled ?? 0,
    rows: layoutCensusRows(raw, labels),
  };
}

/**
 * The summary line of one census row: label, group indices and the non-zero
 * per-stage counts against the WebGPU defaults (and the device's own limit
 * where it differs). Pure.
 *
 * @param {object} row One {@link layoutCensusRows} row.
 * @returns {string}
 */
export function layoutCensusLine(row) {
  if (!row.seen) {
    return `\`${row.label}\`: not created on the page`;
  }
  const groups =
    row.groups.length > 0 ? `group ${row.groups.join(", ")}` : "no group";
  const stages = [];
  for (const stage of LAYOUT_STAGES) {
    const kinds = [];
    for (const [kind, bound] of Object.entries(row.limits)) {
      const count = row.counts?.[stage]?.[kind] ?? 0;
      if (count > 0) {
        const device =
          bound.device !== null && bound.device !== bound.default
            ? `, device ${bound.device}`
            : "";
        kinds.push(`${kind} ${count}/${bound.default}${device}`);
      }
    }
    const external = row.counts?.[stage]?.externalTextures ?? 0;
    if (external > 0) {
      kinds.push(`externalTextures ${external}`);
    }
    if (kinds.length > 0) {
      stages.push(`${stage} ${kinds.join(", ")}`);
    }
  }
  const over =
    row.overDefault.length > 0
      ? `; above the default limit: ${row.overDefault.join(", ")}`
      : "";
  const overDevice =
    row.overDevice.length > 0
      ? `; above the device limit: ${row.overDevice.join(", ")}`
      : "";
  return `\`${row.label}\`: ${groups}, ${row.entries} entries; ${stages.length > 0 ? stages.join("; ") : "no stage-visible entries"}${over}${overDevice}`;
}
