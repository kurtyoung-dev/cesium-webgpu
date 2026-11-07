/**
 * The opt-in page readers of the landing probe (`--readers`): numbers read
 * from the live page into the page record, never from source.
 * @purpose Page-side functions, init sources, the Node-side readers and the pure record builders for the landing probe's `--readers` list: cloud-stats (the volumetric cloud statistics block, field by field), weather-ticks (calls of the managed deck's weather update per frame), weather-worker (the weather Web Worker's construction and termination, read at capture and after the viewer is destroyed), refresh-counters (the five cloud cache refresh passes' lifetime counts over a window with the camera unchanged when the page publishes them, else NOT AVAILABLE naming the seam, plus whether the march consults the occupancy map) and auto-layouts (pipelines created with an automatic layout and the bindings their shader modules declare); every quantity a page cannot answer reads `{available: false, reason: "NOT AVAILABLE: <seam>"}`, never a zero.
 * @status ACTIVE
 *
 * THE CONTRACT. A reader is off unless named in `--readers`; with every reader
 * off nothing here installs a script or reads the page, so the receipt is the
 * one the probe wrote before the readers existed. A reader that is on puts its
 * record under the page record's `readers` field. A seam the page does not
 * have (a statistic the tree does not publish, a global the page lacks) reads
 * `notAvailable(<seam>)`, naming the seam; a value is only ever the page's own.
 *
 * SELF-CONTAINED PAGE FUNCTIONS. `page.evaluate` serialises a function's
 * source, so every `page*` function and every init installer below closes over
 * nothing. The Node-side builders turn the raw answers into records.
 *
 * @module Tools/visual-regression/lib/landing-page-readers
 */

import { ProbeRefusal } from "./probe-runtime.mjs";

/** The reader names `--readers` accepts, in the order their records are read. */
export const READER_NAMES = Object.freeze([
  "cloud-stats",
  "weather-ticks",
  "weather-worker",
  "refresh-counters",
  "auto-layouts",
]);

/** Frames the weather-ticks reader renders while it counts. */
export const WEATHER_TICK_FRAMES = 12;

/**
 * Frames the refresh-counters reader renders between its two reads, only when
 * the page publishes a lifetime refresh count to difference.
 */
export const REFRESH_COUNTER_FRAMES = 30;

/**
 * The field of `getRendererStatistics().volumetricClouds` the refresh-counters
 * reader reads a lifetime refresh count from: an object keyed by pass label
 * whose values only rise. No tree publishes it yet, so every refresh label
 * reads NOT AVAILABLE; `volumetricClouds.passes` is no substitute, since it is
 * zeroed every frame and never counts the compute refresh passes.
 */
export const REFRESH_LIFETIME_FIELD = "lifetimePasses";

/** The cloud cache refresh pass labels whose counts refresh-counters reports. */
export const REFRESH_PASS_LABELS = Object.freeze([
  "Cloud density cache refresh",
  "Cloud deep-shadow refresh",
  "Cloud occupancy refresh",
  "Cloud occupancy invalidation",
  "Cloud occupancy parent bounds",
]);

/**
 * The shape of a quantity the page cannot answer.
 *
 * @param {string} seam The page seam that was missing, named.
 * @returns {{available: false, reason: string}}
 */
export function notAvailable(seam) {
  return { available: false, reason: `NOT AVAILABLE: ${seam}` };
}

/**
 * The reader names a `--readers` value lists, in registry order. An unknown
 * name is a refusal (exit 3) naming every unknown one, before any browser.
 *
 * @param {string|undefined|null} value The raw `--readers` value.
 * @returns {string[]}
 */
export function parseReaders(value) {
  const listed = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unknown = listed.filter((name) => !READER_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new ProbeRefusal(
      "readers-unknown",
      `--readers names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a reader; the readers are ${READER_NAMES.join(", ")}`,
      { unknown, known: [...READER_NAMES] },
    );
  }
  return READER_NAMES.filter((name) => listed.includes(name));
}

/**
 * The readers an options object turns on.
 *
 * @param {{readers?: string}} [options]
 * @returns {string[]}
 */
export function readersOf(options) {
  return parseReaders(options?.readers);
}

// ---------------------------------------------------------------------------
// cloud-stats
// ---------------------------------------------------------------------------

/**
 * PAGE SIDE. The volumetric cloud statistics, field by field. A missing seam
 * is named; a field the block lacks is simply absent from the answer.
 */
export function pageReadCloudStats() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  if (!context || typeof context.getRendererStatistics !== "function") {
    return { seam: "viewer.scene.context.getRendererStatistics" };
  }
  let stats;
  try {
    stats = context.getRendererStatistics();
  } catch (error) {
    return {
      seam: "getRendererStatistics()",
      error: String(error && error.message ? error.message : error),
    };
  }
  const block = stats && stats.volumetricClouds;
  if (!block || typeof block !== "object") {
    return { seam: "getRendererStatistics().volumetricClouds" };
  }
  if (block.error !== undefined) {
    return {
      seam: "getRendererStatistics().volumetricClouds",
      error: String(block.error),
    };
  }
  const march =
    block.raymarch && typeof block.raymarch === "object" ? block.raymarch : {};
  const copy = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return {
    block: {
      frames: copy(block.frames),
      culledFrames: copy(block.culledFrames),
      raymarch: {
        budgetApplied: copy(march.budgetApplied),
        marchBudget: copy(march.marchBudget),
        marchCost: copy(march.marchCost),
        requestedMarchCost: copy(march.requestedMarchCost),
        budgetRefused: copy(march.budgetRefused),
        halfResActive: copy(march.halfResActive),
        qualityFlags: copy(march.qualityFlags),
        requestedQualityFlags: copy(march.requestedQualityFlags),
      },
    },
  };
}

const CLOUD_STATS_FIELDS = Object.freeze([
  ["frames", "frames"],
  ["culledFrames", "culledFrames"],
]);
const CLOUD_RAYMARCH_FIELDS = Object.freeze([
  "budgetApplied",
  "marchBudget",
  "marchCost",
  "requestedMarchCost",
  "budgetRefused",
  "halfResActive",
  "qualityFlags",
  "requestedQualityFlags",
]);
const CLOUD_BLOCK = "getRendererStatistics().volumetricClouds";

/**
 * The cloud-stats record from the page's raw answer. Each field is the page's
 * value, or `notAvailable(<the field's path>)` when the block lacks it. Pure.
 *
 * @param {object|null|undefined} raw `pageReadCloudStats`'s answer.
 * @returns {object}
 */
export function buildCloudStatsRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageReadCloudStats returned nothing");
  }
  if (raw.block === undefined) {
    const seam = raw.error
      ? `${raw.seam} (threw: ${raw.error})`
      : (raw.seam ?? CLOUD_BLOCK);
    return notAvailable(seam);
  }
  const block = raw.block;
  const record = { available: true };
  for (const [key] of CLOUD_STATS_FIELDS) {
    record[key] =
      block[key] === undefined
        ? notAvailable(`${CLOUD_BLOCK}.${key}`)
        : block[key];
  }
  record.raymarch = {};
  for (const key of CLOUD_RAYMARCH_FIELDS) {
    const value = block.raymarch?.[key];
    record.raymarch[key] =
      value === undefined
        ? notAvailable(`${CLOUD_BLOCK}.raymarch.${key}`)
        : value;
  }
  return record;
}

// ---------------------------------------------------------------------------
// weather-ticks
// ---------------------------------------------------------------------------

/**
 * PAGE SIDE. Counts the calls of the managed deck's `_updateWeather` per
 * frame: the instance method is wrapped, `frames` widget frames are rendered
 * at the frozen clock (`initializeFrame()`, `render()`, one animation frame),
 * and the method is restored whatever happens.
 *
 * @param {{frames: number}} arg
 */
export async function pageReadWeatherTicks({ frames }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const collection =
    viewer &&
    viewer.scene &&
    viewer.scene.globe &&
    viewer.scene.globe.defaultCloudCollection;
  if (!collection) {
    return { seam: "viewer.scene.globe.defaultCloudCollection" };
  }
  if (typeof collection._updateWeather !== "function") {
    return { seam: "CloudCollection#_updateWeather" };
  }
  const original = collection._updateWeather;
  const hadOwn = Object.prototype.hasOwnProperty.call(
    collection,
    "_updateWeather",
  );
  let calls = 0;
  collection._updateWeather = function wrappedUpdateWeather(...args) {
    calls++;
    return original.apply(this, args);
  };
  const perFrame = [];
  let failure = null;
  try {
    for (let i = 0; i < frames; i++) {
      const before = calls;
      viewer.scene.initializeFrame();
      viewer.scene.render(viewer.clock.currentTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      perFrame.push(calls - before);
    }
  } catch (error) {
    failure = String(error && error.message ? error.message : error);
  } finally {
    if (hadOwn) {
      collection._updateWeather = original;
    } else {
      delete collection._updateWeather;
    }
  }
  return { frames, perFrame, failure };
}

/**
 * The weather-ticks record: calls per frame, with their minimum, maximum and
 * total. Pure.
 *
 * @param {object|null|undefined} raw `pageReadWeatherTicks`'s answer.
 * @returns {object}
 */
export function buildWeatherTicksRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageReadWeatherTicks returned nothing");
  }
  if (typeof raw.seam === "string") {
    return notAvailable(raw.seam);
  }
  if (raw.failure) {
    return {
      available: false,
      reason: `the frames did not render: ${raw.failure}`,
      perFrame: raw.perFrame ?? [],
    };
  }
  const perFrame = Array.isArray(raw.perFrame) ? raw.perFrame : [];
  return {
    available: true,
    frames: perFrame.length,
    perFrame,
    min: perFrame.length > 0 ? Math.min(...perFrame) : null,
    max: perFrame.length > 0 ? Math.max(...perFrame) : null,
    total: perFrame.reduce((sum, n) => sum + n, 0),
  };
}

// ---------------------------------------------------------------------------
// weather-worker
// ---------------------------------------------------------------------------

/**
 * Page-context installer (an init script). Replaces `globalThis.Worker` with a
 * subclass that records each construction (the URL it was given, its options'
 * type) and each `terminate()` call, and replaces `Blob` and
 * `URL.createObjectURL` so that a worker built from a blob shim (the embedded
 * and the cross-origin cases of `TaskProcessor`) can be attributed by the
 * shim's own text. `instanceof Blob` keeps answering for native blobs. A page
 * without `Worker` is left alone (`installed` stays false).
 */
export function installWorkerCensus() {
  const w = /** @type {any} */ (globalThis);
  if (w.__landingWorkerCensus) {
    return;
  }
  const census = { installed: false, workers: [], failed: [] };
  const shimTextOfUrl = new Map();
  const textOfBlob = new WeakMap();
  w.__landingWorkerCensus = census;
  w.__landingWorkerCensusRead = () => {
    const named = (text) => /createCloudWeather/.test(String(text ?? ""));
    return {
      installed: census.installed,
      workers: census.workers.map((entry) => {
        const byUrl = named(entry.url);
        const byShim =
          !byUrl && entry.blob && named(shimTextOfUrl.get(entry.url));
        return {
          index: entry.index,
          url: entry.url,
          blob: entry.blob,
          type: entry.type,
          terminateCalls: entry.terminateCalls,
          weather: byUrl || byShim,
          attributedBy: byUrl ? "url" : byShim ? "blob-shim-text" : null,
          shimKnown: entry.blob ? shimTextOfUrl.has(entry.url) : null,
        };
      }),
      failed: census.failed.slice(),
    };
  };
  const OriginalWorker = w.Worker;
  if (typeof OriginalWorker !== "function") {
    return;
  }
  const OriginalBlob = w.Blob;
  if (typeof OriginalBlob === "function") {
    class RecordingBlob extends OriginalBlob {
      constructor(parts, options) {
        super(parts, options);
        try {
          const text = (Array.isArray(parts) ? parts : [])
            .filter((part) => typeof part === "string")
            .join("");
          textOfBlob.set(this, text.slice(0, 4000));
        } catch {
          // A blob whose parts cannot be read is simply not attributable.
        }
      }
      static [Symbol.hasInstance](value) {
        return value instanceof OriginalBlob;
      }
    }
    w.Blob = RecordingBlob;
  }
  if (w.URL && typeof w.URL.createObjectURL === "function") {
    const createObjectURL = w.URL.createObjectURL;
    w.URL.createObjectURL = function recordingCreateObjectURL(object) {
      const url = createObjectURL.call(this, object);
      try {
        if (textOfBlob.has(object)) {
          shimTextOfUrl.set(String(url), textOfBlob.get(object));
        }
      } catch {
        // Attribution is best effort; the URL is returned either way.
      }
      return url;
    };
  }
  class RecordingWorker extends OriginalWorker {
    constructor(url, options) {
      const text = String(url);
      const entry = {
        index: census.workers.length,
        url: text,
        blob: text.startsWith("blob:"),
        type: options && options.type ? String(options.type) : null,
        terminateCalls: 0,
      };
      try {
        super(url, options);
      } catch (error) {
        census.failed.push({
          url: text,
          message: String(error && error.message ? error.message : error),
        });
        throw error;
      }
      census.workers.push(entry);
      this.terminate = function recordingTerminate() {
        entry.terminateCalls++;
        return OriginalWorker.prototype.terminate.call(this);
      };
    }
  }
  w.Worker = RecordingWorker;
  census.installed = true;
}

/** The init source that installs the worker census. */
export const WORKER_CENSUS_INIT_SOURCE = `(${installWorkerCensus.toString()})();`;

/**
 * PAGE SIDE. The recorded workers, attributed to the weather task where the
 * worker's URL or its blob shim's text names `createCloudWeather`.
 */
export function pageReadWorkerCensus() {
  const read = /** @type {any} */ (globalThis).__landingWorkerCensusRead;
  if (typeof read !== "function") {
    return {
      seam: "the Worker census init script (window.__landingWorkerCensusRead)",
    };
  }
  const answer = read();
  if (answer.installed !== true) {
    return { seam: "globalThis.Worker" };
  }
  return answer;
}

/**
 * The weather worker's record from the page's census. `created` and
 * `terminated` count the weather workers (a worker whose URL, or whose blob
 * shim's text, names the weather task); `terminated` counts those on which the
 * page called `terminate()`. A page that built no weather worker says so
 * (`created: 0`); blob workers whose shim text could not be read are counted
 * in `unattributedBlobWorkers`, so a zero is never silently a gap. Pure.
 *
 * @param {object|null|undefined} raw `pageReadWorkerCensus`'s answer.
 * @param {"capture"|"after-destroy"} phase When the census was read.
 * @returns {object}
 */
export function buildWorkerRecord(raw, phase) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageReadWorkerCensus returned nothing");
  }
  if (typeof raw.seam === "string") {
    return notAvailable(raw.seam);
  }
  const workers = Array.isArray(raw.workers) ? raw.workers : [];
  const weather = workers.filter((entry) => entry.weather === true);
  const terminated = weather.filter((entry) => entry.terminateCalls > 0);
  const alive = weather.length - terminated.length > 0;
  const record = {
    available: true,
    phase,
    created: weather.length,
    terminated: terminated.length,
    [phase === "after-destroy" ? "aliveAfterDestroy" : "alive"]: alive,
    workersSeen: workers.length,
    unattributedBlobWorkers: workers.filter(
      (entry) =>
        entry.blob === true &&
        entry.weather !== true &&
        entry.shimKnown !== true,
    ).length,
    constructionFailures: Array.isArray(raw.failed) ? raw.failed.length : 0,
    workers: weather.map((entry) => ({
      url: entry.url,
      attributedBy: entry.attributedBy,
      type: entry.type,
      terminateCalls: entry.terminateCalls,
    })),
    observes: "Worker#terminate calls made by the page thread",
  };
  if (weather.length === 0) {
    record.note = "no weather worker was created on this page";
  }
  return record;
}

// ---------------------------------------------------------------------------
// refresh-counters
// ---------------------------------------------------------------------------

/**
 * PAGE SIDE. The cloud cache refresh passes' lifetime counts
 * (`volumetricClouds[lifetimeField][label]`) at two moments `frames` frames
 * apart with the camera left alone, and whether the occupancy map is consulted
 * by the march (`context._cloudCache.spatialOccupancyActive`, the flag that
 * selects the march variant compiled with the occupancy grid). When the page
 * publishes no lifetime count for any label there is nothing to difference, so
 * no frame is driven and `frames` answers 0.
 *
 * @param {{frames: number, labels: string[], lifetimeField: string}} arg
 */
export async function pageSampleCloudPassCounts({
  frames,
  labels,
  lifetimeField,
}) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  if (!context || typeof context.getRendererStatistics !== "function") {
    return { seam: "viewer.scene.context.getRendererStatistics" };
  }
  const readCounts = () => {
    const stats = context.getRendererStatistics();
    const block = stats && stats.volumetricClouds;
    if (!block || typeof block !== "object" || block.error !== undefined) {
      return null;
    }
    const counts = block[lifetimeField];
    const out = {};
    if (counts && typeof counts === "object") {
      for (const label of labels) {
        if (typeof counts[label] === "number") {
          out[label] = counts[label];
        }
      }
    }
    return out;
  };
  const cameraKey = () => {
    const camera = viewer.camera;
    const p = camera.position;
    const d = camera.direction;
    return [p.x, p.y, p.z, d.x, d.y, d.z].join(",");
  };
  const occupancyOf = () => {
    const cache = context._cloudCache;
    return cache && typeof cache.spatialOccupancyActive === "boolean"
      ? cache.spatialOccupancyActive
      : undefined;
  };
  let before;
  try {
    before = readCounts();
  } catch (error) {
    return {
      seam: "getRendererStatistics().volumetricClouds",
      error: String(error && error.message ? error.message : error),
    };
  }
  if (before === null) {
    return { seam: "getRendererStatistics().volumetricClouds" };
  }
  const counted = Object.keys(before).length > 0;
  const cameraBefore = counted ? cameraKey() : null;
  const occupancyBefore = occupancyOf();
  let driven = 0;
  let failure = null;
  if (counted) {
    try {
      for (let i = 0; i < frames; i++) {
        viewer.scene.initializeFrame();
        viewer.scene.render(viewer.clock.currentTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        driven++;
      }
    } catch (error) {
      failure = String(error && error.message ? error.message : error);
    }
  }
  const after = counted ? readCounts() : before;
  return {
    frames: driven,
    before,
    after,
    cameraUnchanged: counted ? cameraBefore === cameraKey() : null,
    occupancy: { before: occupancyBefore, after: occupancyOf() },
    failure,
  };
}

/** The reason every refresh label gives while no lifetime count is published. */
const REFRESH_UNCOUNTED_REASON =
  "no lifetime refresh counter is published; the compute refresh passes are not recorded by recordCloudPass, and volumetricClouds.passes is reset every frame";

/**
 * The refresh-counters record: per refresh pass label the lifetime count before,
 * after and the delta over the window when the page publishes one (the page's
 * numbers only), else NOT AVAILABLE naming the seam and why the per-frame
 * `passes` cannot stand in; whether the camera stayed put (null when no frame
 * was driven); and the occupancy read. The occupancy read reports whether the
 * march consults the map; how many samples the map skipped has no page seam
 * (the cloud observability block has no march-side counter), so that field is
 * NOT AVAILABLE naming it. Pure.
 *
 * @param {object|null|undefined} raw `pageSampleCloudPassCounts`'s answer.
 * @returns {object}
 */
export function buildRefreshCountersRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageSampleCloudPassCounts returned nothing");
  }
  if (typeof raw.seam === "string") {
    return notAvailable(
      raw.error ? `${raw.seam} (threw: ${raw.error})` : raw.seam,
    );
  }
  if (raw.failure) {
    return {
      available: false,
      reason: `the frames did not render: ${raw.failure}`,
    };
  }
  const labels = {};
  for (const label of REFRESH_PASS_LABELS) {
    const before = raw.before?.[label];
    const after = raw.after?.[label];
    labels[label] =
      typeof before === "number" && typeof after === "number"
        ? { before, after, delta: after - before }
        : notAvailable(
            `${CLOUD_BLOCK}.${REFRESH_LIFETIME_FIELD}["${label}"] (${REFRESH_UNCOUNTED_REASON})`,
          );
  }
  const occupancy = raw.occupancy ?? {};
  const consultedSeam = "scene.context._cloudCache.spatialOccupancyActive";
  return {
    available: true,
    frames: raw.frames,
    cameraUnchanged:
      typeof raw.cameraUnchanged === "boolean" ? raw.cameraUnchanged : null,
    labels,
    occupancyRead:
      typeof occupancy.after === "boolean"
        ? {
            available: true,
            seam: consultedSeam,
            consultedBefore: occupancy.before ?? null,
            consultedAfter: occupancy.after,
            skippedSamples: notAvailable(
              "a march-side counter of samples the occupancy map skipped (none in the cloud observability block)",
            ),
          }
        : notAvailable(consultedSeam),
  };
}

// ---------------------------------------------------------------------------
// auto-layouts
// ---------------------------------------------------------------------------

/**
 * Page-context installer (an init script). Records, per pipeline created, its
 * label, whether it is a compute or a render pipeline, whether its layout is
 * `"auto"` or explicit, the group indices the page read back through
 * `getBindGroupLayout`, and, from the WGSL source of the shader modules the
 * pipeline was created with, the `@group/@binding` declarations per kind. The
 * declarations are an UPPER BOUND on an automatic layout: it keeps only the
 * bindings the entry point statically uses. Holds no reference to any
 * pipeline or module (WeakMaps and plain data).
 */
export function installAutoLayoutCensus() {
  const w = /** @type {any} */ (globalThis);
  if (w.__autoLayoutCensus) {
    return;
  }
  const census = { installed: false, pipelines: [] };
  w.__autoLayoutCensus = census;
  const DeviceProto = w.GPUDevice && w.GPUDevice.prototype;
  if (!DeviceProto || typeof DeviceProto.createShaderModule !== "function") {
    return;
  }
  const KINDS = [
    "sampledTextures",
    "uniformBuffers",
    "storageBuffers",
    "samplers",
    "storageTextures",
    "externalTextures",
  ];
  const kindOfType = (access, type) => {
    if (/^texture_storage/.test(type)) return "storageTextures";
    if (/^texture_external/.test(type)) return "externalTextures";
    if (/^texture_/.test(type)) return "sampledTextures";
    if (/^sampler/.test(type)) return "samplers";
    if (/\buniform\b/.test(access)) return "uniformBuffers";
    if (/\bstorage\b/.test(access)) return "storageBuffers";
    return null;
  };
  // module -> {groups: {"<g>": {kind: n}}, total: {kind: n}}
  const declarationsOf = new WeakMap();
  const declarationsIn = (code) => {
    const text = String(code)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const groups = {};
    const total = {};
    for (const kind of KINDS) total[kind] = 0;
    const pattern =
      /((?:@\s*(?:group|binding)\s*\(\s*\d+\s*\)\s*)+)var\s*(<[^>]*>)?\s*[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const group = /@\s*group\s*\(\s*(\d+)\s*\)/.exec(match[1]);
      if (!group) continue;
      const kind = kindOfType(match[2] ?? "", match[3]);
      if (kind === null) continue;
      groups[group[1]] ??= {};
      groups[group[1]][kind] = (groups[group[1]][kind] ?? 0) + 1;
      total[kind]++;
    }
    return { groups, total };
  };
  const createShaderModule = DeviceProto.createShaderModule;
  DeviceProto.createShaderModule = function autoLayoutCreateShaderModule(
    descriptor,
  ) {
    const module = createShaderModule.call(this, descriptor);
    try {
      declarationsOf.set(module, declarationsIn(descriptor && descriptor.code));
    } catch {
      // A module whose source cannot be read has no declarations to report.
    }
    return module;
  };
  const entryOf = new WeakMap();
  const merge = (modules) => {
    const groups = {};
    const total = {};
    for (const kind of KINDS) total[kind] = 0;
    let known = 0;
    for (const module of modules) {
      const found = module && declarationsOf.get(module);
      if (!found) continue;
      known++;
      for (const [group, kinds] of Object.entries(found.groups)) {
        groups[group] ??= {};
        for (const [kind, count] of Object.entries(kinds)) {
          groups[group][kind] = (groups[group][kind] ?? 0) + count;
        }
      }
      for (const kind of KINDS) total[kind] += found.total[kind];
    }
    return { groups, total, modulesKnown: known, modulesGiven: modules.length };
  };
  const record = (kind, descriptor, pipeline, isAsync) => {
    try {
      const unique = [];
      const add = (stage) => {
        const module = stage && stage.module;
        if (module && !unique.includes(module)) unique.push(module);
      };
      if (kind === "compute") {
        add(descriptor.compute);
      } else {
        add(descriptor.vertex);
        add(descriptor.fragment);
      }
      const entry = {
        label: descriptor && descriptor.label ? String(descriptor.label) : "",
        kind,
        async: isAsync,
        layout:
          descriptor && descriptor.layout === "auto" ? "auto" : "explicit",
        groupsRead: [],
        declared: merge(unique),
      };
      census.pipelines.push(entry);
      if (pipeline && typeof pipeline === "object") {
        entryOf.set(pipeline, entry);
      }
    } catch {
      // A descriptor that cannot be read is not recorded.
    }
  };
  const wrapSync = (proto, name, kind) => {
    const original = proto && proto[name];
    if (typeof original !== "function") return;
    proto[name] = function autoLayoutCreatePipeline(descriptor) {
      const pipeline = original.call(this, descriptor);
      record(kind, descriptor, pipeline, false);
      return pipeline;
    };
  };
  const wrapAsync = (proto, name, kind) => {
    const original = proto && proto[name];
    if (typeof original !== "function") return;
    proto[name] = function autoLayoutCreatePipelineAsync(descriptor) {
      return original.call(this, descriptor).then((pipeline) => {
        record(kind, descriptor, pipeline, true);
        return pipeline;
      });
    };
  };
  wrapSync(DeviceProto, "createComputePipeline", "compute");
  wrapSync(DeviceProto, "createRenderPipeline", "render");
  wrapAsync(DeviceProto, "createComputePipelineAsync", "compute");
  wrapAsync(DeviceProto, "createRenderPipelineAsync", "render");
  for (const ctor of [w.GPUComputePipeline, w.GPURenderPipeline]) {
    const proto = ctor && ctor.prototype;
    const original = proto && proto.getBindGroupLayout;
    if (typeof original !== "function") continue;
    proto.getBindGroupLayout = function autoLayoutGetBindGroupLayout(index) {
      const entry = entryOf.get(this);
      if (entry && !entry.groupsRead.includes(index)) {
        entry.groupsRead.push(index);
      }
      return original.call(this, index);
    };
  }
  census.installed = true;
}

/** The init source that installs the automatic-layout census. */
export const AUTO_LAYOUT_INIT_SOURCE = `(${installAutoLayoutCensus.toString()})();`;

/** PAGE SIDE. The automatic-layout census as plain data. */
export function pageReadAutoLayouts() {
  const census = /** @type {any} */ (globalThis).__autoLayoutCensus;
  if (!census) {
    return {
      seam: "the automatic-layout census init script (window.__autoLayoutCensus)",
    };
  }
  if (census.installed !== true) {
    return { seam: "GPUDevice.prototype.createShaderModule" };
  }
  return JSON.parse(JSON.stringify({ pipelines: census.pipelines }));
}

const AUTO_LAYOUT_BOUND_NOTE =
  "declared is the count of @group/@binding variables in the pipeline's shader modules, an UPPER BOUND on an automatic layout, which keeps only the bindings the entry point statically uses";

/**
 * The auto-layouts record: pipelines grouped by label, kind and layout kind,
 * each with how many were created, the group indices the page read back
 * through `getBindGroupLayout`, and the declared bindings per kind (the
 * largest over the group, as an upper bound). Pure.
 *
 * @param {object|null|undefined} raw `pageReadAutoLayouts`'s answer.
 * @returns {object}
 */
export function buildAutoLayoutsRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageReadAutoLayouts returned nothing");
  }
  if (typeof raw.seam === "string") {
    return notAvailable(raw.seam);
  }
  const pipelines = Array.isArray(raw.pipelines) ? raw.pipelines : [];
  const rows = new Map();
  for (const pipeline of pipelines) {
    const key = [pipeline.label, pipeline.kind, pipeline.layout].join("\u0000");
    let row = rows.get(key);
    if (!row) {
      row = {
        label: pipeline.label,
        kind: pipeline.kind,
        layout: pipeline.layout,
        created: 0,
        groupsRead: [],
        declaredGroups: [],
        declaredUpperBound: {},
        modulesKnown: 0,
        modulesGiven: 0,
      };
      rows.set(key, row);
    }
    row.created++;
    for (const index of pipeline.groupsRead ?? []) {
      if (!row.groupsRead.includes(index)) row.groupsRead.push(index);
    }
    const declared = pipeline.declared ?? {};
    for (const group of Object.keys(declared.groups ?? {})) {
      const index = Number(group);
      if (!row.declaredGroups.includes(index)) row.declaredGroups.push(index);
    }
    for (const [kind, count] of Object.entries(declared.total ?? {})) {
      row.declaredUpperBound[kind] = Math.max(
        row.declaredUpperBound[kind] ?? 0,
        count,
      );
    }
    row.modulesKnown = Math.max(row.modulesKnown, declared.modulesKnown ?? 0);
    row.modulesGiven = Math.max(row.modulesGiven, declared.modulesGiven ?? 0);
  }
  const sorted = [...rows.values()].map((row) => ({
    ...row,
    groupsRead: row.groupsRead.sort((a, b) => a - b),
    declaredGroups: row.declaredGroups.sort((a, b) => a - b),
  }));
  return {
    available: true,
    note: AUTO_LAYOUT_BOUND_NOTE,
    pipelines: pipelines.length,
    auto: pipelines.filter((p) => p.layout === "auto").length,
    explicit: pipelines.filter((p) => p.layout !== "auto").length,
    compute: pipelines.filter((p) => p.kind === "compute").length,
    render: pipelines.filter((p) => p.kind === "render").length,
    rows: sorted,
  };
}

// ---------------------------------------------------------------------------
// The probe-facing seams
// ---------------------------------------------------------------------------

/** Every page function a reader evaluates, by name (the fake browser's keys). */
export const READER_PAGE_FUNCTIONS = Object.freeze({
  pageReadCloudStats,
  pageReadWeatherTicks,
  pageReadWorkerCensus,
  pageSampleCloudPassCounts,
  pageReadAutoLayouts,
});

/**
 * The init sources the named readers need before the page loads.
 *
 * @param {string[]} readers
 * @returns {string[]}
 */
export function readerInitSources(readers) {
  const sources = [];
  if (readers.includes("weather-worker")) {
    sources.push(WORKER_CENSUS_INIT_SOURCE);
  }
  if (readers.includes("auto-layouts")) {
    sources.push(AUTO_LAYOUT_INIT_SOURCE);
  }
  return sources;
}

/**
 * Read the named readers at capture time. Node side; order follows
 * {@link READER_NAMES}.
 *
 * @param {object} page A Playwright page.
 * @param {string[]} readers
 * @returns {Promise<object>} The `readers` record fields.
 */
export async function readCaptureReaders(page, readers) {
  const out = {};
  if (readers.includes("cloud-stats")) {
    out.cloudStats = buildCloudStatsRecord(
      await page.evaluate(pageReadCloudStats),
    );
  }
  if (readers.includes("weather-ticks")) {
    out.weatherTicks = buildWeatherTicksRecord(
      await page.evaluate(pageReadWeatherTicks, {
        frames: WEATHER_TICK_FRAMES,
      }),
    );
  }
  if (readers.includes("weather-worker")) {
    out.weatherWorker = buildWorkerRecord(
      await page.evaluate(pageReadWorkerCensus),
      "capture",
    );
  }
  if (readers.includes("refresh-counters")) {
    out.refreshCounters = buildRefreshCountersRecord(
      await page.evaluate(pageSampleCloudPassCounts, {
        frames: REFRESH_COUNTER_FRAMES,
        labels: [...REFRESH_PASS_LABELS],
        lifetimeField: REFRESH_LIFETIME_FIELD,
      }),
    );
  }
  if (readers.includes("auto-layouts")) {
    out.autoLayouts = buildAutoLayoutsRecord(
      await page.evaluate(pageReadAutoLayouts),
    );
  }
  return out;
}

/**
 * The reads that follow a viewer's destruction: the weather worker's state.
 * Node side. The read is taken and labelled after-destroy only when the page's
 * terminal action was `viewer.destroy`: a caller that passes
 * `record.deviceLoss.terminal.action` as `terminalAction` gets NOT AVAILABLE,
 * naming the action, for a page whose provoking steps ended the run or whose
 * terminal action was a device loss, since its viewer was not destroyed. A
 * caller that passes no `terminalAction` is not gated.
 *
 * @param {object} page A Playwright page whose viewer was destroyed.
 * @param {string[]} readers
 * @param {{terminalAction?: string|null}} [terminal] The page's terminal action.
 * @returns {Promise<object>} The `readers` record fields (empty when none).
 */
export async function readTeardownReaders(page, readers, terminal = {}) {
  const out = {};
  if (readers.includes("weather-worker")) {
    if (
      Object.hasOwn(terminal, "terminalAction") &&
      terminal.terminalAction !== "viewer.destroy"
    ) {
      out.weatherWorkerAfterDestroy = notAvailable(
        `the viewer was not destroyed on this page (record.deviceLoss.terminal.action was ${JSON.stringify(terminal.terminalAction ?? null)}, not "viewer.destroy")`,
      );
    } else {
      out.weatherWorkerAfterDestroy = buildWorkerRecord(
        await page.evaluate(pageReadWorkerCensus),
        "after-destroy",
      );
    }
  }
  return out;
}
