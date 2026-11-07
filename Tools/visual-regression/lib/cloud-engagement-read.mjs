/**
 * The engine's own "did this feature engage" flags for the weather-dial cells.
 * @purpose Page-side function (pageReadCloudEngagement) and Node-side reader (readCloudEngagement) that read named engagement flags the engine keeps while it renders the volumetric clouds: the populations-requested and vertical-requested flags of the WebGPU cloud cache (context._cloudCache) and whether the collection's owned weather provider uses workers; each answers {available: true, value} or {available: false, reason: "NOT AVAILABLE: <seam>"} naming the missing seam, never a default; plus the pure expectation (engagementExpectation) a cell's page must show and the pure verdict over a page's flags (judgeEngagement).
 * @status ACTIVE
 *
 * WHY THIS EXISTS. A dial read back applied from the instance says the dial was
 * set; a rendered frame says something was drawn. Neither says the engine ran
 * the feature the dial asks for: with the dial on and no packed layers the
 * renderer still marches its generic decks, and the frame still has cloud in
 * it. The flags read here are the engine's own record of whether the feature
 * was requested of the march (`weatherPopulationsRequested`,
 * `weatherVerticalRequested`) and whether the owned provider was told to
 * generate its weather on workers (`useWorkers`, the `cloudWeatherWorkers`
 * dial copied on each update; a worker that fails falls back to the main
 * thread without clearing it, so a created worker is read by the
 * weather-worker reader, not here).
 *
 * OPT-IN. A cell names the flags it wants in its `engagement` field
 * (`lib/landing-cell-table.mjs`); `lib/landing-init-scripts.mjs`
 * `readCellInitRecords` reads them at capture into the page record's
 * `engagement`, and a cell without the field gets no such record field.
 *
 * WHAT A FLAG DOES NOT SAY. `populationsRequested` is the engine's request
 * flag, set when the dial is on, the weather map is on and valid packed
 * layers are held. It is not a pixel measure and not a proof that the march
 * wrote colour; the cell's pixel floors stay the second condition. The page
 * also holds the selected march defines (`selectedMarchDefinesHi`); the
 * populations bit is an engine-internal enum value the page cannot name, so it
 * is not read here.
 *
 * @module Tools/visual-regression/lib/cloud-engagement-read
 */

import { notAvailable } from "./landing-page-readers.mjs";

/** The page function's name; the fake browser answers it by this name. */
export const ENGAGEMENT_PAGE_FUNCTION = "pageReadCloudEngagement";

/**
 * The flags, by name: where each is read from on the page, as a path through
 * `viewer` that the page function walks, and the seam text a missing path is
 * reported with. Frozen data, handed to the page function as its argument.
 */
export const ENGAGEMENT_FLAGS = Object.freeze({
  populationsRequested: Object.freeze({
    path: Object.freeze([
      "scene",
      "context",
      "_cloudCache",
      "weatherPopulationsRequested",
    ]),
    seam: "viewer.scene.context._cloudCache.weatherPopulationsRequested",
  }),
  verticalRequested: Object.freeze({
    path: Object.freeze([
      "scene",
      "context",
      "_cloudCache",
      "weatherVerticalRequested",
    ]),
    seam: "viewer.scene.context._cloudCache.weatherVerticalRequested",
  }),
  workersEnabled: Object.freeze({
    path: Object.freeze([
      "scene",
      "globe",
      "defaultCloudCollection",
      "_weatherState",
      "_owned",
      "useWorkers",
    ]),
    seam: "viewer.scene.globe.defaultCloudCollection._weatherState._owned.useWorkers",
  }),
});

/** The flag names, in table order. */
export const ENGAGEMENT_FLAG_NAMES = Object.freeze(
  Object.keys(ENGAGEMENT_FLAGS),
);

/**
 * PAGE SIDE. Walks each flag's path from `globalThis.viewer` and answers
 * `{[name]: {value}}` for a boolean found at the end of the path, or
 * `{[name]: {missing}}` saying which step was not an object, or that the end
 * was not a boolean. Nothing is defaulted.
 *
 * @param {{flags: Array<{name: string, path: string[]}>}} arg
 */
export function pageReadCloudEngagement({ flags }) {
  const out = {};
  for (const { name, path } of flags) {
    let at = /** @type {any} */ (globalThis).viewer;
    let walked = "viewer";
    let missing = null;
    for (const step of path) {
      if (at === null || at === undefined || typeof at !== "object") {
        missing = `${walked} is not an object`;
        break;
      }
      walked += `.${step}`;
      at = at[step];
    }
    if (missing === null && typeof at !== "boolean") {
      missing = `${walked} is not a boolean`;
    }
    out[name] = missing === null ? { value: at } : { missing };
  }
  return out;
}

/**
 * The page record's `engagement` from the page's raw answer. Pure.
 *
 * @param {object|null|undefined} raw `pageReadCloudEngagement`'s answer.
 * @param {string[]} names The flags asked for.
 * @returns {Record<string, {available: true, value: boolean} |
 *   {available: false, reason: string}>}
 */
export function buildEngagementRecord(raw, names) {
  const record = {};
  for (const name of names) {
    const flag = ENGAGEMENT_FLAGS[name];
    const answer = raw && typeof raw === "object" ? raw[name] : undefined;
    if (!flag) {
      record[name] = notAvailable(`an unknown engagement flag (${name})`);
    } else if (!answer || typeof answer !== "object") {
      record[name] = notAvailable(
        `${flag.seam} (pageReadCloudEngagement returned nothing)`,
      );
    } else if (typeof answer.value === "boolean") {
      record[name] = { available: true, value: answer.value };
    } else {
      record[name] = notAvailable(
        `${flag.seam} (${typeof answer.missing === "string" ? answer.missing : "no value"})`,
      );
    }
  }
  return record;
}

/**
 * Read the named flags from a page. Node side.
 *
 * @param {object} page A Playwright page.
 * @param {string[]} names The flags asked for.
 * @returns {Promise<ReturnType<typeof buildEngagementRecord>>}
 */
export async function readCloudEngagement(page, names) {
  const flags = names
    .filter((name) => ENGAGEMENT_FLAGS[name] !== undefined)
    .map((name) => ({ name, path: [...ENGAGEMENT_FLAGS[name].path] }));
  let raw;
  try {
    raw = await page.evaluate(pageReadCloudEngagement, { flags });
  } catch (error) {
    const text = String(error?.message ?? error);
    return Object.fromEntries(
      names.map((name) => [
        name,
        notAvailable(
          `${ENGAGEMENT_FLAGS[name]?.seam ?? name} (the read threw: ${text})`,
        ),
      ]),
    );
  }
  return buildEngagementRecord(raw, names);
}

/**
 * Whether a cell asks for engagement reads.
 *
 * @param {object} cell A landing cell table entry.
 * @returns {boolean}
 */
export function wantsEngagement(cell) {
  return Array.isArray(cell?.engagement) && cell.engagement.length > 0;
}

/**
 * The value a flag must show on a named page of a cell, or `undefined` when
 * the flag is not judged on that page. `populationsRequested` is read against
 * the cell's `populationsCoverage` pair: true on the `on` page, false on the
 * `off` page. The other flags must be true on every page they are judged on
 * (the caller judges WebGPU pages only).
 *
 * @param {object} cell A landing cell table entry.
 * @param {string} flag A flag name.
 * @param {string} pageName The page's variant name.
 * @returns {boolean|undefined}
 */
export function engagementExpectation(cell, flag, pageName) {
  if (flag === "populationsRequested") {
    const pair = cell?.populationsCoverage;
    if (pair?.on === pageName) {
      return true;
    }
    if (pair?.off === pageName) {
      return false;
    }
    return undefined;
  }
  return true;
}

const WHAT_FAILED = Object.freeze({
  populationsRequested: Object.freeze({
    true: "the population march did not run (the engine did not request it)",
    false: "the population march ran on the single-layer page",
  }),
  verticalRequested: Object.freeze({
    true: "the vertical weather march did not run (the engine did not request it)",
  }),
  workersEnabled: Object.freeze({
    true: "the owned weather provider does not use workers",
  }),
});

/**
 * The verdict of one page's engagement flags against what the cell expects.
 * Pure. A flag that is expected nowhere on this page is skipped.
 *
 * - `FAIL`: some judged flag is available and differs from its expectation.
 *   A measured red outranks a missing read.
 * - `NOT AVAILABLE`: no judged flag differs, and at least one cannot be read
 *   (or the page record carries no `engagement` at all); the reasons name the
 *   seams.
 * - `PASS`: every judged flag is available and as expected.
 *
 * @param {object} cell A landing cell table entry.
 * @param {string} pageName The page's variant name.
 * @param {object|undefined} engagement The page record's `engagement`.
 * @returns {{outcome: "PASS"|"FAIL"|"NOT AVAILABLE", reasons: string[],
 *   flags: Record<string, {expected: boolean, value: boolean|null}>}}
 */
export function judgeEngagement(cell, pageName, engagement) {
  const failures = [];
  const unavailable = [];
  const flags = {};
  for (const flag of cell?.engagement ?? []) {
    const expected = engagementExpectation(cell, flag, pageName);
    if (expected === undefined) {
      continue;
    }
    const read = engagement?.[flag];
    if (!read || read.available !== true) {
      flags[flag] = { expected, value: null };
      unavailable.push(
        read?.reason ??
          `NOT AVAILABLE: ${ENGAGEMENT_FLAGS[flag]?.seam ?? flag} (the page record carries no engagement read)`,
      );
      continue;
    }
    flags[flag] = { expected, value: read.value };
    if (read.value !== expected) {
      failures.push(
        `${WHAT_FAILED[flag]?.[String(expected)] ?? `${flag} is ${read.value}, expected ${expected}`} (${ENGAGEMENT_FLAGS[flag]?.seam ?? flag} is ${read.value} on the ${pageName} page)`,
      );
    }
  }
  if (failures.length > 0) {
    return { outcome: "FAIL", reasons: failures, flags };
  }
  if (unavailable.length > 0) {
    return { outcome: "NOT AVAILABLE", reasons: unavailable, flags };
  }
  return { outcome: "PASS", reasons: [], flags };
}

/**
 * Fold several pages' engagement judgements into one. Pure. `FAIL` when any
 * page failed, else `NOT AVAILABLE` when any could not be read, else `PASS`;
 * the reasons list every failure first, then every unread flag, so a measured
 * red is never hidden behind a missing read.
 *
 * @param {Array<ReturnType<typeof judgeEngagement>>} judgements
 * @returns {{outcome: "PASS"|"FAIL"|"NOT AVAILABLE", reasons: string[]}}
 */
export function foldEngagement(judgements) {
  const failures = judgements
    .filter((judgement) => judgement.outcome === "FAIL")
    .flatMap((judgement) => judgement.reasons);
  const unread = judgements
    .filter((judgement) => judgement.outcome === "NOT AVAILABLE")
    .flatMap((judgement) => judgement.reasons);
  const outcome =
    failures.length > 0 ? "FAIL" : unread.length > 0 ? "NOT AVAILABLE" : "PASS";
  return { outcome, reasons: [...failures, ...unread] };
}
