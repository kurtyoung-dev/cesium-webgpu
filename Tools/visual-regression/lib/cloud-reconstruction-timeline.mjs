/**
 * The per-frame record of the cloud reconstruction start-up on a cold page.
 * @purpose Stage mode and reader for the cloud reconstruction start-up: from the first frame of a cold page it turns reconstruction on through the public CesiumDebug.cloudReconstruction switch (retrying until the cloud cache takes it, never throwing for an engine that does not settle), records one row per rendered frame from scene.postRender (the selected march family, the start-up preview, whether the frame emitted, the primary-reuse flag, and the march-pipeline key the half-resolution emit pipeline was built for), and works out on how many emitted frames that key is the selected family's emit variant; the verdicts say only that the timeline was read.
 * @status ACTIVE
 *
 * WHAT A PAGE CAN READ. `requestCloudMarchPipeline` stores every march pipeline
 * in the cloud cache's `marchPipelines` map under `<format>:<definesHi>`, and
 * the half-resolution emit pipeline `cache.halfEmitPipeline` is the object that
 * map holds for the emit request. The key whose map entry is that object names
 * the family the emit pipeline was built for; the pipeline's label
 * (`ProceduralClouds <key>`) is a second reading of the same key. The
 * statistics carry no such field. The selected family is
 * `cache.selectedMarchDefinesHi`, the emit variant adds bit 16, and the primary
 * reuse variant adds bit 2048.
 *
 * WHAT A PAGE CANNOT READ. The primary-reuse march pipeline a frame binds is a
 * local of the frame preparation and no cache field holds it, so the per-frame
 * bound reuse key is NOT AVAILABLE; the reuse keys are checked at the frame each
 * was first requested instead.
 *
 * NOT THE READINESS STEP. `lib/landing-cloud-reconstruction.mjs` throws when its
 * readiness predicate is unmet and requires primary reuse off; this step never
 * throws for an arm that does not settle (its answer says why it stopped), so
 * it runs on a tree that has the emit fix and on one that does not, with
 * primary reuse on or off.
 *
 * @module Tools/visual-regression/lib/cloud-reconstruction-timeline
 */

import { LANDING_CELLS } from "./landing-cell-table.mjs";

/** The limits of one timeline run. */
export const RECONSTRUCTION_TIMELINE_DEFAULTS = Object.freeze({
  deadlineMs: 60_000,
  maxRenders: 600,
  settleReads: 3,
  capFrames: 4000,
});

/**
 * The engine values the record is judged against: the emit and primary-reuse
 * bits of the high define word, the half-resolution target format, and the
 * prefix of a march pipeline's label. The page function restates them.
 */
export const RECONSTRUCTION_TIMELINE_CONSTANTS = Object.freeze({
  emitBit: 16,
  reuseBit: 2048,
  halfFormat: "rgba16float",
  namePrefix: "ProceduralClouds ",
});

/** What the record says about the bound primary-reuse march pipeline. */
export const REUSE_BINDING_NOT_AVAILABLE =
  "NOT AVAILABLE: the bound primary-reuse march pipeline is a local of prepareCloudFrameAndEncodeMask";

/** The most incoherent frames and keys a record lists. */
const LIST_LIMIT = 20;

/**
 * PAGE SIDE. Turn reconstruction on and record every frame until the pipeline
 * cache settles after the activation or a limit is reached. Self-contained.
 *
 * Installs `globalThis.__cloudReconTimeline` and a `scene.postRender` listener
 * before the first render; the listener stays installed until
 * {@link pageReadReconstructionTimeline} removes it, so the frames of the
 * pending-pipeline wait that follows are recorded too.
 *
 * @param {{deadlineMs: number, maxRenders: number, settleReads: number,
 *   capFrames: number}} options
 * @returns {Promise<{installed: boolean, reason?: string, activation?: object,
 *   settled?: boolean, renders?: number}>}
 */
export async function pageRunReconstructionTimeline({
  deadlineMs,
  maxRenders,
  settleReads,
  capFrames,
}) {
  const constants = {
    emitBit: 16,
    reuseBit: 2048,
    halfFormat: "rgba16float",
    namePrefix: "ProceduralClouds ",
  };
  const root = /** @type {any} */ (globalThis);
  const viewer = root.window?.viewer ?? root.viewer;
  const scene = viewer?.scene;
  const context = scene?.context ?? scene?._context;
  const debug = root.window?.CesiumDebug ?? root.CesiumDebug;
  const missing = (seam) => ({
    installed: false,
    reason: `NOT AVAILABLE: ${seam}`,
  });
  if (!scene) {
    return missing("window.viewer.scene");
  }
  if (!context?.isWebGPU) {
    return missing("viewer.scene.context.isWebGPU");
  }
  if (typeof debug?.cloudReconstruction !== "function") {
    return missing("window.CesiumDebug.cloudReconstruction");
  }
  if (typeof scene.postRender?.addEventListener !== "function") {
    return missing("viewer.scene.postRender.addEventListener");
  }
  if (
    typeof scene.render !== "function" ||
    typeof scene.requestRender !== "function"
  ) {
    return missing("viewer.scene.render and requestRender");
  }
  if (typeof root.__cloudReconTimeline?.remove === "function") {
    root.__cloudReconTimeline.remove();
  }

  const rows = {
    frameNumber: [],
    t: [],
    cache: [],
    enabled: [],
    selected: [],
    preview: [],
    emitted: [],
    consumed: [],
    reuse: [],
    emitKey: [],
    emitLabelOk: [],
    halfKey: [],
    added: [],
    pending: [],
  };
  const state = {
    constants,
    rows,
    keys: [],
    keyIndex: {},
    seenKeys: {},
    truncated: 0,
    activation: null,
    remove: null,
  };
  const intern = (key) => {
    if (state.keyIndex[key] === undefined) {
      state.keyIndex[key] = state.keys.length;
      state.keys.push(key);
    }
    return state.keyIndex[key];
  };
  // The key the cache's pipeline map holds `pipeline` under: -1 for no
  // pipeline, -2 for a pipeline the map does not hold.
  const keyOf = (cache, pipeline) => {
    if (pipeline === null || pipeline === undefined) {
      return -1;
    }
    for (const [key, held] of cache.marchPipelines ?? []) {
      if (held === pipeline) {
        return intern(key);
      }
    }
    return -2;
  };
  const pendingNow = () => {
    const stats = context.webgpuPipelineCache?.getStats?.();
    return typeof stats?.pending === "number" ? stats.pending : null;
  };
  const record = () => {
    if (rows.frameNumber.length >= capFrames) {
      state.truncated++;
      return;
    }
    const cache = context._cloudCache;
    const present = !!cache;
    let emitKey = null;
    let emitLabelOk = null;
    let halfKey = null;
    const added = [];
    if (present) {
      emitKey = keyOf(cache, cache.halfEmitPipeline);
      if (emitKey >= 0) {
        emitLabelOk =
          cache.halfEmitPipeline.label ===
          constants.namePrefix + state.keys[emitKey];
      }
      halfKey = keyOf(cache, cache.halfPipeline);
      for (const key of cache.marchPipelines?.keys() ?? []) {
        if (state.seenKeys[key] !== true) {
          state.seenKeys[key] = true;
          added.push(intern(key));
        }
      }
    }
    rows.frameNumber.push(scene.frameState?.frameNumber ?? null);
    rows.t.push(performance.now());
    rows.cache.push(present);
    rows.enabled.push(present ? cache.reconstructionEnabled === true : null);
    rows.selected.push(present ? cache.selectedMarchDefinesHi : null);
    rows.preview.push(present ? cache.usingStartupPreview === true : null);
    rows.emitted.push(
      present ? cache.reconstructionEmittedThisFrame === true : null,
    );
    rows.consumed.push(
      present ? cache.reconstructionConsumedThisFrame === true : null,
    );
    rows.reuse.push(present ? cache.primaryReuseApplied === true : null);
    rows.emitKey.push(emitKey);
    rows.emitLabelOk.push(emitLabelOk);
    rows.halfKey.push(halfKey);
    rows.added.push(added);
    rows.pending.push(pendingNow());
  };
  state.remove = scene.postRender.addEventListener(record);
  root.__cloudReconTimeline = state;

  const deadline = performance.now() + deadlineMs;
  const activation = {
    attempts: 0,
    renderIndex: null,
    rowIndex: null,
    frameNumber: null,
    applied: false,
  };
  state.activation = activation;
  let renders = 0;
  let quietReads = 0;
  let reason = null;
  while (reason === null) {
    if (performance.now() >= deadline) {
      reason = "deadline";
    } else if (renders >= maxRenders) {
      reason = "render-cap";
    } else if (
      viewer.useDefaultRenderLoop !== false ||
      viewer.clock?.shouldAnimate !== false
    ) {
      reason = "clock-ownership-lost";
    }
    if (reason !== null) {
      break;
    }
    if (!activation.applied && context._cloudCache) {
      activation.attempts++;
      const answer = debug.cloudReconstruction(true);
      const cache = context._cloudCache;
      if (
        answer &&
        cache.reconstructionEnabled === true &&
        cache.attachmentsEnabled === true
      ) {
        activation.applied = true;
        activation.renderIndex = renders;
        activation.rowIndex = rows.frameNumber.length;
        activation.frameNumber = scene.frameState?.frameNumber ?? null;
      }
    }
    scene.requestRender();
    scene.render(viewer.clock.currentTime);
    renders++;
    if (activation.applied) {
      quietReads = pendingNow() === 0 ? quietReads + 1 : 0;
      if (quietReads >= settleReads) {
        reason = "pipelines-settled";
      }
    }
    if (reason === null) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
  if (!activation.applied && reason !== "clock-ownership-lost") {
    reason = "activation-not-applied";
  }
  return {
    installed: true,
    activation: { ...activation },
    settled: reason === "pipelines-settled",
    reason,
    renders,
  };
}

/**
 * PAGE SIDE. Remove the timeline's listener and return what it recorded.
 * Self-contained.
 *
 * @returns {object} The recorded state without the remover, or
 *   `{installed: false}` when the timeline was never installed.
 */
export function pageReadReconstructionTimeline() {
  const state = /** @type {any} */ (globalThis).__cloudReconTimeline;
  if (!state) {
    return { installed: false };
  }
  if (typeof state.remove === "function") {
    state.remove();
  }
  const copy = { ...state, installed: true };
  delete copy.remove;
  return JSON.parse(JSON.stringify(copy));
}

/** The page functions of this module, by name (the fake browser routes them). */
export const RECONSTRUCTION_TIMELINE_PAGE_FUNCTIONS = Object.freeze({
  pageRunReconstructionTimeline,
  pageReadReconstructionTimeline,
});

const unsignedOf = (value) => value >>> 0;

/** `<format>:<definesHi>` as `{format, definesHi}`, or null. */
function parseMarchKey(key) {
  const match = /^(.+):(\d+)$/.exec(String(key));
  return match ? { format: match[1], definesHi: Number(match[2]) } : null;
}

/**
 * Whether a march key is the emit variant of the family `selected` names: the
 * emit bit set and every other bit equal to the selected family's. Pure.
 *
 * @param {string|null|undefined} key A `<format>:<definesHi>` key.
 * @param {number|null} selected The selected family's define word.
 * @param {number} emitBit The emit bit.
 * @returns {boolean}
 */
function isEmitVariantOf(key, selected, emitBit) {
  const parsed = parseMarchKey(key);
  if (parsed === null || typeof selected !== "number") {
    return false;
  }
  return (
    (parsed.definesHi & emitBit) === emitBit &&
    unsignedOf(parsed.definesHi & ~emitBit) === unsignedOf(selected)
  );
}

/**
 * The record a page's timeline becomes. Pure.
 *
 * @param {object} raw {@link pageReadReconstructionTimeline}'s answer.
 * @returns {object} `{available: false, reason}` or the record described in
 *   the module header: activation, per-frame columns, and `derived`.
 */
export function buildReconstructionTimelineRecord(raw) {
  if (!raw || raw.installed !== true) {
    return {
      available: false,
      reason:
        "NOT AVAILABLE: the reconstruction timeline was not installed on this page",
    };
  }
  const constants = { ...RECONSTRUCTION_TIMELINE_CONSTANTS, ...raw.constants };
  const { emitBit, reuseBit } = constants;
  const columns = raw.rows;
  const keys = raw.keys ?? [];
  const count = columns.frameNumber.length;
  const activation = raw.activation ?? {
    attempts: 0,
    renderIndex: null,
    rowIndex: null,
    frameNumber: null,
    applied: false,
  };
  const keyAt = (index) =>
    Number.isInteger(index) && index >= 0 ? keys[index] : null;
  const activationT =
    activation.applied &&
    Number.isInteger(activation.rowIndex) &&
    activation.rowIndex < count
      ? columns.t[activation.rowIndex]
      : null;
  const sinceActivation = (row) => ({
    row,
    frameNumber: columns.frameNumber[row],
    msSinceActivation:
      activationT === null ? null : columns.t[row] - activationT,
  });

  let emittedFrames = 0;
  let coherentEmitted = 0;
  let emittedViaReuse = 0;
  let emitPipelineUnkeyed = 0;
  let labelDisagreements = 0;
  let previewRows = 0;
  let halfKeyNotSelected = 0;
  let firstEmitted = null;
  const incoherent = [];
  for (let row = 0; row < count; row++) {
    if (columns.preview[row] === true) {
      previewRows++;
    }
    if (columns.emitKey[row] === -2) {
      emitPipelineUnkeyed++;
    }
    if (columns.emitLabelOk[row] === false) {
      labelDisagreements++;
    }
    const halfParsed = parseMarchKey(keyAt(columns.halfKey[row]));
    if (
      halfParsed !== null &&
      typeof columns.selected[row] === "number" &&
      unsignedOf(halfParsed.definesHi) !== unsignedOf(columns.selected[row])
    ) {
      halfKeyNotSelected++;
    }
    if (columns.emitted[row] !== true) {
      continue;
    }
    firstEmitted ??= sinceActivation(row);
    if (columns.reuse[row] === true) {
      emittedViaReuse++;
      continue;
    }
    emittedFrames++;
    const key = keyAt(columns.emitKey[row]);
    if (isEmitVariantOf(key, columns.selected[row], emitBit)) {
      coherentEmitted++;
    } else if (incoherent.length < LIST_LIMIT) {
      incoherent.push({
        row,
        frameNumber: columns.frameNumber[row],
        selected: columns.selected[row],
        emitDefinesHi: parseMarchKey(key)?.definesHi ?? null,
      });
    }
  }

  let finalSelected = null;
  for (let row = count - 1; row >= 0; row--) {
    if (columns.cache[row] === true) {
      finalSelected = columns.selected[row];
      break;
    }
  }
  let fullFamilyEmitted = null;
  if (typeof finalSelected === "number") {
    for (let row = 0; row < count; row++) {
      const parsed = parseMarchKey(keyAt(columns.emitKey[row]));
      if (
        columns.emitted[row] === true &&
        parsed !== null &&
        (parsed.definesHi & emitBit) === emitBit &&
        unsignedOf(parsed.definesHi & ~emitBit) === unsignedOf(finalSelected)
      ) {
        fullFamilyEmitted = sinceActivation(row);
        break;
      }
    }
  }

  const requestedEmit = { count: 0, coherent: 0, incoherent: [] };
  const reuseKeys = { count: 0, coherent: 0, unexpected: [] };
  for (let row = 0; row < count; row++) {
    for (const index of columns.added[row] ?? []) {
      const key = keyAt(index);
      const parsed = parseMarchKey(key);
      if (parsed === null) {
        continue;
      }
      const word = parsed.definesHi;
      const selected = columns.selected[row];
      if ((word & reuseBit) === reuseBit) {
        reuseKeys.count++;
        if (
          typeof selected === "number" &&
          unsignedOf(word & ~reuseBit & ~emitBit) === unsignedOf(selected)
        ) {
          reuseKeys.coherent++;
        } else if (reuseKeys.unexpected.length < LIST_LIMIT) {
          reuseKeys.unexpected.push({ row, key, selected });
        }
      } else if ((word & emitBit) === emitBit) {
        requestedEmit.count++;
        if (isEmitVariantOf(key, selected, emitBit)) {
          requestedEmit.coherent++;
        } else if (requestedEmit.incoherent.length < LIST_LIMIT) {
          requestedEmit.incoherent.push({ row, key, selected });
        }
      }
    }
  }

  return {
    available: true,
    evidence:
      "CPU cloud-cache mirrors read on scene.postRender after every frame",
    emitFamilyRoute:
      "cache.marchPipelines key of cache.halfEmitPipeline; label cross-check",
    constants: {
      emitBit,
      reuseBit,
      halfFormat: constants.halfFormat,
    },
    activation,
    frames: { count, truncated: raw.truncated ?? 0, keys, columns },
    derived: {
      emittedFrames,
      coherentEmitted,
      incoherentCount: emittedFrames - coherentEmitted,
      incoherent,
      emittedViaReuse,
      emitPipelineUnkeyed,
      labelDisagreements,
      previewRows,
      halfKeyNotSelected,
      firstEmitted,
      finalSelected,
      fullFamilyEmitted,
      requestedEmitKeys: requestedEmit,
      reuseKeys,
      reuseBinding: REUSE_BINDING_NOT_AVAILABLE,
    },
  };
}

/**
 * NODE SIDE. Read the timeline the stage step recorded and remove its
 * listener.
 *
 * @param {{evaluate: Function}} page A Playwright page.
 * @returns {Promise<object>} {@link buildReconstructionTimelineRecord}'s record.
 */
export async function readReconstructionTimeline(page) {
  return buildReconstructionTimelineRecord(
    await page.evaluate(pageReadReconstructionTimeline),
  );
}

/**
 * One verdict per page of a cell that records the timeline: passes when the
 * timeline was read and reconstruction was switched on, and carries the
 * coherence figures; the figures are not judged here, the arms are compared by
 * the Edge job. Pure.
 *
 * @param {object[]} pages The probe's page records.
 * @param {Record<string, object>} [cells] The cell table (defaults to the
 *   landing table).
 * @returns {Array<{id: string, pass: boolean, notRun?: boolean,
 *   reason?: string, emittedFrames?: number, coherentEmitted?: number,
 *   incoherentCount?: number}>}
 */
export function reconstructionTimelineVerdicts(pages, cells = LANDING_CELLS) {
  const verdicts = [];
  for (const page of pages ?? []) {
    if (cells[page.cell]?.reconstructionTimeline !== true) {
      continue;
    }
    const id = `${page.cell}:${page.page}:reconstruction-timeline:${page.renderer}:run${page.run}:measured`;
    const record = page.reconstructionTimeline;
    const run = page.stage?.reconstructionTimeline;
    let reason = null;
    if (typeof page.notRun === "string") {
      reason = page.notRun;
    } else if (!record) {
      reason = "the page has no reconstructionTimeline record";
    } else if (record.available !== true) {
      reason =
        run?.installed === false && typeof run.reason === "string"
          ? run.reason
          : record.reason;
    } else if (record.activation?.applied !== true) {
      reason = `reconstruction was not switched on (${run?.reason ?? "activation-not-applied"})`;
    }
    if (reason !== null) {
      verdicts.push({ id, pass: false, notRun: true, reason });
      continue;
    }
    verdicts.push({
      id,
      pass: true,
      emittedFrames: record.derived.emittedFrames,
      coherentEmitted: record.derived.coherentEmitted,
      incoherentCount: record.derived.incoherentCount,
    });
  }
  return verdicts;
}
