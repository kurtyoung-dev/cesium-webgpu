/**
 * In-page GPU device census for Playwright probes: estimated bytes of every
 * live texture and buffer, and the time the device spends creating shader
 * modules and pipelines.
 * @purpose Page init source (addInitScript) that wraps GPUDevice texture, buffer, shader-module and pipeline creation and GPUTexture/GPUBuffer/GPUDevice destroy to keep live counts (a device's destruction frees what it still owned) and estimated live bytes (in total and per label) and the synchronous and asynchronous creation times, holding no reference to any resource; and render and compute pipelines by label (created, pending, rejected, released with their device); plus the pure texture-size estimator, the Node-side reader, the empty shape and the owner rows by exact label, prefix:<text> or re:<regex>.
 * @status ACTIVE
 *
 * WHY, BESIDE `lib/gpu-texture-census.mjs`. That census counts textures per
 * label, which is what a lifetime fix needs: did the label's textures get
 * destroyed. The landing program's PF-4 needs BYTES, for buffers as well as
 * textures, and PF-3 needs the compile time the device spent, neither of which
 * it records; changing its page global's shape would move the texture-lifetime
 * probe's receipts. So this is a separate piece with its own global
 * (`__gpuDeviceCensus`). Both may be installed on one page: each wraps what the
 * other left on the prototype, and each counts once.
 *
 * WHAT THE BYTES ARE. A texture is sized from its descriptor by
 * {@link textureByteSize}: texels (or compressed blocks) over the whole mip
 * chain, times array layers (or depth, mip by mip, for a 3D texture), times the
 * sample count. A buffer is its declared `size`. Driver padding and alignment
 * are invisible from here; a format the table does not know is counted in
 * `unknownSize` and its bytes are left out, so an estimate never pretends to be
 * a driver measurement.
 *
 * WHAT THE TIMES ARE. `performance.now()` around each synchronous
 * `createShaderModule`, `createRenderPipeline` and `createComputePipeline`
 * call, and from the call to the settle of each `create*PipelineAsync`
 * promise. `firstCreateAtMs` and `lastSettleAtMs` bound them in page time
 * (milliseconds since navigation start). A browser compiles shader modules
 * lazily, so most of the compile cost lands in the pipeline calls; both are
 * kept so a reader can see where it went.
 *
 * DEVICE DESTRUCTION FREES WHAT THE DEVICE OWNED. `GPUDevice.destroy()`
 * releases every texture and buffer the device still holds, whether or not
 * anything called their `destroy()`. Without counting it the census read such
 * a resource as live forever, so an owner that is cached per device and freed
 * with the device (the bathymetry LUT on the water tip,
 * `WebGPUBathymetryTensorTexture.ts`) read as a leak after a teardown that
 * destroyed the device (Ettenmoors pass 1, D2). Each kind total and each
 * `kind:label` row now carries `freedByDevice` beside `destroyed`
 * (explicit `destroy()` calls), so a reader can tell an owner whose
 * `destroy()` was reached from one released with its device. Per-device
 * tallies live in a `WeakMap` keyed by the device; a second destroy of the
 * same device, and an explicit `destroy()` of a resource whose device is
 * already gone, move nothing.
 *
 * NO REFERENCES ARE HELD. Sizes live in a `WeakMap` keyed by the resource and
 * destroyed resources in a `WeakSet`, so the census does not keep alive what it
 * measures. A resource the page drops without `destroy()` stays live here,
 * which is exactly the residency PF-4 reads.
 *
 * OWNER LABEL FORMS (round 4, F6). {@link liveRowsForLabels} reads a list of
 * owner specs, one per owner, in three forms: a bare label matches that label
 * exactly; `prefix:<text>` matches every label that starts with `<text>`
 * (an owner whose label carries a per-instance key, e.g. the water lane's
 * `Globe <cacheKey>` mask textures); `re:<regex>` matches every label the
 * regular expression (JavaScript syntax, compiled with the `u` flag, so an
 * identity escape such as a backslash before a space is a syntax error and the
 * spec is refused) finds a match in. A label
 * that itself begins with `prefix:` or `re:` is read as the form. A pattern
 * spec yields one row per matching `kind:label` row, each carrying `spec`
 * (the spec as written) beside the label it matched; an exact spec's rows are
 * shaped as before. A spec that matches nothing reads one `seen: false` row
 * under its own text. Census and keep-alive are the same read: the rows before
 * the terminal action show which owners the steps kept alive, the rows after it
 * which were released. The census can only count what it can name, so the
 * lane whose owners are censused must give them stable labels (a fixed label,
 * or a fixed prefix before the per-instance part).
 *
 * PIPELINES (round 5, K5-3). `createRenderPipeline` and
 * `createComputePipeline` and their async forms are censused by label like
 * textures and buffers: `renderPipeline:<label>` and
 * `computePipeline:<label>` rows, with `pending` (async calls not yet
 * settled) and `rejected` (async calls that failed) beside `created`, and
 * totals under `pipelines.render` / `pipelines.compute`. An async pipeline is
 * created when its promise resolves. WebGPU has no pipeline `destroy()`, so a
 * pipeline row's `destroyed` stays 0 and `live` counts the pipelines not yet
 * released with their device (`GPUDevice.destroy()`); one the page drops and
 * the collector reclaims is invisible from here, so a pipeline row that reads
 * live after a teardown that kept the device proves nothing either way
 * ({@link PIPELINE_ROW_KINDS}; the teardown verdict leaves those rows out).
 * The keep-alive reading (the rows before a terminal action) works for
 * pipelines unchanged: `liveRowsForLabels` reads them by the same specs.
 *
 * USAGE.
 *   await page.addInitScript({ content: GPU_DEVICE_CENSUS_INIT_SOURCE }); // before goto
 *   ... drive the page ...
 *   const census = await readGpuDeviceCensus(page);
 *
 * @module Tools/visual-regression/lib/gpu-device-census
 */

/**
 * Estimated bytes of a texture from its descriptor. Pure and self-contained
 * (it is serialised into the page by {@link GPU_DEVICE_CENSUS_INIT_SOURCE}).
 *
 * @param {object} descriptor A `GPUTextureDescriptor`.
 * @returns {{bytes: number|null, format: string|null}} `bytes` null when the
 *   format or the size cannot be read.
 */
export function textureByteSize(descriptor) {
  // Bytes per texel, or [blockBytes, blockWidth, blockHeight] for block formats.
  const FORMAT_BYTES = {
    r8unorm: 1,
    r8snorm: 1,
    r8uint: 1,
    r8sint: 1,
    stencil8: 1,
    r16uint: 2,
    r16sint: 2,
    r16float: 2,
    r16unorm: 2,
    rg8unorm: 2,
    rg8snorm: 2,
    rg8uint: 2,
    rg8sint: 2,
    depth16unorm: 2,
    r32uint: 4,
    r32sint: 4,
    r32float: 4,
    rg16uint: 4,
    rg16sint: 4,
    rg16float: 4,
    rgba8unorm: 4,
    "rgba8unorm-srgb": 4,
    rgba8snorm: 4,
    rgba8uint: 4,
    rgba8sint: 4,
    bgra8unorm: 4,
    "bgra8unorm-srgb": 4,
    rgb9e5ufloat: 4,
    rgb10a2uint: 4,
    rgb10a2unorm: 4,
    rg11b10ufloat: 4,
    depth24plus: 4,
    "depth24plus-stencil8": 4,
    depth32float: 4,
    "depth32float-stencil8": 5,
    rg32uint: 8,
    rg32sint: 8,
    rg32float: 8,
    rgba16uint: 8,
    rgba16sint: 8,
    rgba16float: 8,
    rgba32uint: 16,
    rgba32sint: 16,
    rgba32float: 16,
    "bc1-rgba-unorm": [8, 4, 4],
    "bc1-rgba-unorm-srgb": [8, 4, 4],
    "bc2-rgba-unorm": [16, 4, 4],
    "bc2-rgba-unorm-srgb": [16, 4, 4],
    "bc3-rgba-unorm": [16, 4, 4],
    "bc3-rgba-unorm-srgb": [16, 4, 4],
    "bc4-r-unorm": [8, 4, 4],
    "bc4-r-snorm": [8, 4, 4],
    "bc5-rg-unorm": [16, 4, 4],
    "bc5-rg-snorm": [16, 4, 4],
    "bc6h-rgb-ufloat": [16, 4, 4],
    "bc6h-rgb-float": [16, 4, 4],
    "bc7-rgba-unorm": [16, 4, 4],
    "bc7-rgba-unorm-srgb": [16, 4, 4],
    "etc2-rgb8unorm": [8, 4, 4],
    "etc2-rgb8unorm-srgb": [8, 4, 4],
    "etc2-rgb8a1unorm": [8, 4, 4],
    "etc2-rgb8a1unorm-srgb": [8, 4, 4],
    "etc2-rgba8unorm": [16, 4, 4],
    "etc2-rgba8unorm-srgb": [16, 4, 4],
    "astc-4x4-unorm": [16, 4, 4],
    "astc-4x4-unorm-srgb": [16, 4, 4],
  };
  const format =
    descriptor && typeof descriptor.format === "string"
      ? descriptor.format
      : null;
  const size = descriptor ? descriptor.size : undefined;
  let width;
  let height;
  let depth;
  if (Array.isArray(size) || (size && typeof size.length === "number")) {
    width = size[0];
    height = size.length > 1 ? size[1] : 1;
    depth = size.length > 2 ? size[2] : 1;
  } else if (size && typeof size === "object") {
    width = size.width;
    height = size.height === undefined ? 1 : size.height;
    depth = size.depthOrArrayLayers === undefined ? 1 : size.depthOrArrayLayers;
  }
  const isCount = (n) => Number.isInteger(n) && n > 0;
  const entry = format === null ? undefined : FORMAT_BYTES[format];
  if (
    entry === undefined ||
    !isCount(width) ||
    !isCount(height) ||
    !isCount(depth)
  ) {
    return { bytes: null, format };
  }
  const mips = isCount(descriptor.mipLevelCount) ? descriptor.mipLevelCount : 1;
  const samples = isCount(descriptor.sampleCount) ? descriptor.sampleCount : 1;
  const is3d = descriptor.dimension === "3d";
  let bytes = 0;
  for (let level = 0; level < mips; level++) {
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    const layers = is3d ? Math.max(1, depth >> level) : depth;
    if (Array.isArray(entry)) {
      const [blockBytes, blockWidth, blockHeight] = entry;
      bytes +=
        Math.ceil(w / blockWidth) *
        Math.ceil(h / blockHeight) *
        blockBytes *
        layers;
    } else {
      bytes += w * h * entry * layers;
    }
  }
  return { bytes: bytes * samples, format };
}

/**
 * Page-context installer. Self-contained apart from its one argument, the
 * texture sizer, which {@link GPU_DEVICE_CENSUS_INIT_SOURCE} passes in. A page
 * without WebGPU gets an empty census with `installed: false`. Installing twice
 * is a no-op.
 *
 * @param {(descriptor: object) => {bytes: number|null}} sizeOfTexture
 */
export function installGpuDeviceCensus(sizeOfTexture) {
  const w = /** @type {any} */ (globalThis);
  if (w.__gpuDeviceCensus) {
    return;
  }
  const kind = () => ({
    created: 0,
    destroyed: 0,
    freedByDevice: 0,
    createdBytes: 0,
    liveBytes: 0,
    unknownSize: 0,
  });
  const timing = () => ({ count: 0, syncMs: 0 });
  const asyncTiming = () => ({
    count: 0,
    settled: 0,
    rejected: 0,
    totalSettleMs: 0,
  });
  const pipelineKind = () => ({ ...kind(), pending: 0, rejected: 0 });
  const census = {
    installed: false,
    textures: kind(),
    buffers: kind(),
    pipelines: { render: pipelineKind(), compute: pipelineKind() },
    byLabel: {},
    repeatedDestroys: 0,
    devicesDestroyed: 0,
    compile: {
      shaderModules: timing(),
      renderPipelines: timing(),
      computePipelines: timing(),
      renderPipelinesAsync: asyncTiming(),
      computePipelinesAsync: asyncTiming(),
      firstCreateAtMs: null,
      lastSettleAtMs: null,
    },
  };
  w.__gpuDeviceCensus = census;
  const DeviceProto = w.GPUDevice && w.GPUDevice.prototype;
  const TextureProto = w.GPUTexture && w.GPUTexture.prototype;
  const BufferProto = w.GPUBuffer && w.GPUBuffer.prototype;
  if (!DeviceProto || !TextureProto || !BufferProto) {
    return;
  }
  const now = () => performance.now();
  const record = new WeakMap();
  const destroyed = new WeakSet();
  // device -> {destroyed, rows: {kind:label -> {live, liveBytes}}}; weakly held.
  const devices = new WeakMap();
  const deviceState = (device) => {
    let state = devices.get(device);
    if (!state) {
      state = { destroyed: false, rows: {} };
      devices.set(device, state);
    }
    return state;
  };
  const isPipeline = (kindName) =>
    kindName === "renderPipeline" || kindName === "computePipeline";
  const totalsOf = (kindName) => {
    if (kindName === "texture") {
      return census.textures;
    }
    if (kindName === "buffer") {
      return census.buffers;
    }
    return kindName === "renderPipeline"
      ? census.pipelines.render
      : census.pipelines.compute;
  };
  const labelRow = (label, kindName) => {
    const key = `${kindName}:${label}`;
    if (!census.byLabel[key]) {
      census.byLabel[key] = {
        kind: kindName,
        label,
        created: 0,
        destroyed: 0,
        freedByDevice: 0,
        liveBytes: 0,
        ...(isPipeline(kindName) ? { pending: 0, rejected: 0 } : {}),
      };
    }
    return census.byLabel[key];
  };
  const track = (device, resource, kindName, label, bytes) => {
    const totals = totalsOf(kindName);
    const row = labelRow(label, kindName);
    const state = deviceState(device);
    totals.created++;
    row.created++;
    if (bytes === null) {
      totals.unknownSize++;
    } else {
      totals.createdBytes += bytes;
    }
    if (state.destroyed) {
      // Created on a device already destroyed (an invalid object): it never
      // holds memory, so it is released at birth.
      totals.freedByDevice++;
      row.freedByDevice++;
      record.set(resource, { kindName, label, bytes, state });
      return;
    }
    if (bytes !== null) {
      totals.liveBytes += bytes;
      row.liveBytes += bytes;
    }
    const key = `${kindName}:${label}`;
    const owned =
      state.rows[key] || (state.rows[key] = { live: 0, liveBytes: 0 });
    owned.live++;
    owned.liveBytes += bytes === null ? 0 : bytes;
    record.set(resource, { kindName, label, bytes, state });
  };
  const untrack = (resource) => {
    if (destroyed.has(resource)) {
      census.repeatedDestroys++;
      return;
    }
    const entry = record.get(resource);
    if (!entry) {
      return;
    }
    destroyed.add(resource);
    if (entry.state.destroyed) {
      // Already released with its device; an explicit destroy() moves nothing.
      return;
    }
    const owned = entry.state.rows[`${entry.kindName}:${entry.label}`];
    owned.live--;
    owned.liveBytes -= entry.bytes === null ? 0 : entry.bytes;
    const totals = totalsOf(entry.kindName);
    const row = labelRow(entry.label, entry.kindName);
    totals.destroyed++;
    row.destroyed++;
    if (entry.bytes !== null) {
      totals.liveBytes -= entry.bytes;
      row.liveBytes -= entry.bytes;
    }
  };
  const labelOf = (descriptor) =>
    descriptor && typeof descriptor.label === "string"
      ? descriptor.label
      : "(unlabelled)";
  const markCreate = (at) => {
    if (census.compile.firstCreateAtMs === null) {
      census.compile.firstCreateAtMs = at;
    }
  };

  const createTexture = DeviceProto.createTexture;
  DeviceProto.createTexture = function (descriptor) {
    const texture = createTexture.call(this, descriptor);
    let bytes;
    try {
      bytes = sizeOfTexture(descriptor).bytes;
    } catch {
      bytes = null;
    }
    track(this, texture, "texture", labelOf(descriptor), bytes);
    return texture;
  };
  const createBuffer = DeviceProto.createBuffer;
  DeviceProto.createBuffer = function (descriptor) {
    const buffer = createBuffer.call(this, descriptor);
    const size = descriptor ? descriptor.size : undefined;
    const bytes = Number.isFinite(size) && size >= 0 ? Number(size) : null;
    track(this, buffer, "buffer", labelOf(descriptor), bytes);
    return buffer;
  };
  const destroyTexture = TextureProto.destroy;
  TextureProto.destroy = function () {
    untrack(this);
    return destroyTexture.call(this);
  };
  const destroyBuffer = BufferProto.destroy;
  BufferProto.destroy = function () {
    untrack(this);
    return destroyBuffer.call(this);
  };

  const destroyDevice = DeviceProto.destroy;
  if (typeof destroyDevice === "function") {
    DeviceProto.destroy = function () {
      const state = devices.get(this);
      if (!state || !state.destroyed) {
        census.devicesDestroyed++;
      }
      if (state && !state.destroyed) {
        state.destroyed = true;
        for (const [key, owned] of Object.entries(state.rows)) {
          if (owned.live <= 0) {
            continue;
          }
          const row = census.byLabel[key];
          const totals = totalsOf(row.kind);
          row.freedByDevice += owned.live;
          row.liveBytes -= owned.liveBytes;
          totals.freedByDevice += owned.live;
          totals.liveBytes -= owned.liveBytes;
          owned.live = 0;
          owned.liveBytes = 0;
        }
      } else if (!state) {
        deviceState(this).destroyed = true;
      }
      return destroyDevice.call(this);
    };
  }

  const wrapSync = (name, slot, pipelineKindName) => {
    const original = DeviceProto[name];
    if (typeof original !== "function") {
      return;
    }
    DeviceProto[name] = function (...args) {
      const started = now();
      markCreate(started);
      let created;
      try {
        created = original.apply(this, args);
      } finally {
        const row = census.compile[slot];
        row.count++;
        row.syncMs += now() - started;
      }
      if (pipelineKindName && created && typeof created === "object") {
        track(this, created, pipelineKindName, labelOf(args[0]), 0);
      }
      return created;
    };
  };
  const wrapAsync = (name, slot, pipelineKindName) => {
    const original = DeviceProto[name];
    if (typeof original !== "function") {
      return;
    }
    DeviceProto[name] = function (...args) {
      const started = now();
      markCreate(started);
      const row = census.compile[slot];
      row.count++;
      const device = this;
      const label = labelOf(args[0]);
      const owner = labelRow(label, pipelineKindName);
      const totals = totalsOf(pipelineKindName);
      owner.pending++;
      totals.pending++;
      const settle = (ok, pipeline) => {
        const at = now();
        row.settled++;
        owner.pending--;
        totals.pending--;
        if (!ok) {
          row.rejected++;
          owner.rejected++;
          totals.rejected++;
        } else if (pipeline && typeof pipeline === "object") {
          track(device, pipeline, pipelineKindName, label, 0);
        }
        row.totalSettleMs += at - started;
        if (
          census.compile.lastSettleAtMs === null ||
          at > census.compile.lastSettleAtMs
        ) {
          census.compile.lastSettleAtMs = at;
        }
      };
      const promise = original.apply(this, args);
      Promise.resolve(promise).then(
        (pipeline) => settle(true, pipeline),
        () => settle(false),
      );
      return promise;
    };
  };
  wrapSync("createShaderModule", "shaderModules");
  wrapSync("createRenderPipeline", "renderPipelines", "renderPipeline");
  wrapSync("createComputePipeline", "computePipelines", "computePipeline");
  wrapAsync(
    "createRenderPipelineAsync",
    "renderPipelinesAsync",
    "renderPipeline",
  );
  wrapAsync(
    "createComputePipelineAsync",
    "computePipelinesAsync",
    "computePipeline",
  );
  census.installed = true;
}

/**
 * The init script, as source text: the installer called with the sizer. Pass it
 * as `page.addInitScript({ content: GPU_DEVICE_CENSUS_INIT_SOURCE })`.
 */
export const GPU_DEVICE_CENSUS_INIT_SOURCE = `(${installGpuDeviceCensus.toString()})(${textureByteSize.toString()});`;

/**
 * The shape an uninstalled census reads as, so a reader on a page without the
 * census, or without WebGPU, gets the same keys with nothing counted.
 *
 * @returns {object}
 */
export function emptyGpuDeviceCensus() {
  const kind = () => ({
    created: 0,
    destroyed: 0,
    freedByDevice: 0,
    createdBytes: 0,
    liveBytes: 0,
    unknownSize: 0,
  });
  const pipelineKind = () => ({ ...kind(), pending: 0, rejected: 0 });
  return {
    installed: false,
    textures: kind(),
    buffers: kind(),
    pipelines: { render: pipelineKind(), compute: pipelineKind() },
    byLabel: {},
    repeatedDestroys: 0,
    devicesDestroyed: 0,
    compile: {
      shaderModules: { count: 0, syncMs: 0 },
      renderPipelines: { count: 0, syncMs: 0 },
      computePipelines: { count: 0, syncMs: 0 },
      renderPipelinesAsync: {
        count: 0,
        settled: 0,
        rejected: 0,
        totalSettleMs: 0,
      },
      computePipelinesAsync: {
        count: 0,
        settled: 0,
        rejected: 0,
        totalSettleMs: 0,
      },
      firstCreateAtMs: null,
      lastSettleAtMs: null,
    },
  };
}

/**
 * Read the census from the page, as a plain JSON copy.
 *
 * @param {{evaluate: Function}} page A Playwright page.
 * @returns {Promise<object>} The census, or {@link emptyGpuDeviceCensus} when
 *   the page has none.
 */
export async function readGpuDeviceCensus(page) {
  const census = await page.evaluate(() => {
    const value = /** @type {any} */ (globalThis).__gpuDeviceCensus;
    return value ? JSON.parse(JSON.stringify(value)) : null;
  });
  return census ?? emptyGpuDeviceCensus();
}

/**
 * The row kinds that have no `destroy()` (round 5, K5-3): their `live` falls
 * only when their device is destroyed, so a teardown that keeps the device
 * cannot read them as released (see PIPELINES in the module header).
 */
export const PIPELINE_ROW_KINDS = Object.freeze([
  "renderPipeline",
  "computePipeline",
]);

/** The owner-spec forms {@link parseOwnerLabel} reads. */
export const OWNER_LABEL_FORMS = Object.freeze(["exact", "prefix", "re"]);

/**
 * Read one owner spec: a bare label (exact), `prefix:<text>` or
 * `re:<regex>`. Pure.
 *
 * @param {string} spec
 * @returns {{spec: string, form: "exact"|"prefix"|"re", text: string,
 *   test: (label: string) => boolean}}
 * @throws {TypeError} For an empty spec, an empty prefix or pattern, or a
 *   pattern that is not a valid regular expression.
 */
export function parseOwnerLabel(spec) {
  const text = String(spec ?? "");
  if (text.length === 0) {
    throw new TypeError("an owner label spec is empty");
  }
  if (text.startsWith("prefix:")) {
    const prefix = text.slice("prefix:".length);
    if (prefix.length === 0) {
      throw new TypeError(`owner label spec ${text} has an empty prefix`);
    }
    return {
      spec: text,
      form: "prefix",
      text: prefix,
      test: (label) => typeof label === "string" && label.startsWith(prefix),
    };
  }
  if (text.startsWith("re:")) {
    const source = text.slice("re:".length);
    if (source.length === 0) {
      throw new TypeError(`owner label spec ${text} has an empty pattern`);
    }
    let pattern;
    try {
      pattern = new RegExp(source, "u");
    } catch (error) {
      throw new TypeError(
        `owner label spec ${text} is not a valid regular expression: ${error.message}`,
        { cause: error },
      );
    }
    return {
      spec: text,
      form: "re",
      text: source,
      test: (label) => typeof label === "string" && pattern.test(label),
    };
  }
  return {
    spec: text,
    form: "exact",
    text,
    test: (label) => label === text,
  };
}

/**
 * The live rows of the named owners: `{label, kind, created, destroyed,
 * freedByDevice, live, liveBytes}` per `kind:label` row whose label a spec
 * matches, with `live = created - destroyed - freedByDevice`. A spec the
 * census never matched is listed with zero counts and `seen: false`, so an
 * owner that was never created reads as absent, not as cleanly destroyed.
 * Rows matched by a `prefix:` or `re:` spec also carry `spec` (see the
 * module header, OWNER LABEL FORMS).
 *
 * @param {object} census A {@link readGpuDeviceCensus} result.
 * @param {string[]} labels Owner specs: exact labels as the engine sets them,
 *   `prefix:<text>` or `re:<regex>`.
 * @returns {Array<object>}
 * @throws {TypeError} For a spec {@link parseOwnerLabel} refuses.
 */
export function liveRowsForLabels(census, labels) {
  const rows = [];
  for (const owner of (labels ?? []).map(parseOwnerLabel)) {
    const exact = owner.form === "exact";
    const matches = Object.values(census?.byLabel ?? {}).filter((row) =>
      owner.test(row.label),
    );
    if (matches.length === 0) {
      rows.push({
        label: owner.spec,
        ...(exact ? {} : { spec: owner.spec }),
        kind: null,
        created: 0,
        destroyed: 0,
        freedByDevice: 0,
        live: 0,
        liveBytes: 0,
        seen: false,
      });
      continue;
    }
    for (const row of matches) {
      rows.push({
        label: exact ? owner.spec : row.label,
        ...(exact ? {} : { spec: owner.spec }),
        kind: row.kind,
        created: row.created,
        destroyed: row.destroyed,
        freedByDevice: row.freedByDevice ?? 0,
        live: row.created - row.destroyed - (row.freedByDevice ?? 0),
        liveBytes: row.liveBytes,
        ...(row.pending === undefined
          ? {}
          : { pending: row.pending, rejected: row.rejected ?? 0 }),
        seen: true,
      });
    }
  }
  return rows;
}
