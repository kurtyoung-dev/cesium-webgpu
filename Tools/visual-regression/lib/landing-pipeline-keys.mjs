/**
 * The pipeline cache's variant key list, read from the live page, and the
 * comparison of two arms' lists.
 * @purpose Page reader `pipeline-keys` of the landing probe: the page-side read of the WebGPU render pipeline cache's own contents (`listPipelineVariants()` rows - key and descriptor name - and `getStats()` counters including `wrongModuleHits`, read after the capture), the pure masking of the per-page object identities out of a key (`pl:<n>` and the shader module ids of the `sh:` segment) so two pages' keys compare, the pure record (sorted names, sorted stable keys, names by family, counters), and the comparison of a page's list with the same page of a base report (`pipelineKeyComparisons`: the keys of one family only on one side, and whether the whole stable list is equal); a page without the cache reads `{available: false, reason: "NOT AVAILABLE: <seam>"}`, never an empty list.
 * @status ACTIVE
 *
 * WHY NAMES AND STABLE KEYS. A cache key starts with the descriptor name (for a
 * cloud march pipeline `ProceduralClouds <format>:<definesHi>`, the family and
 * the shader define mask in one string) and ends with the shader identity, a
 * page-global counter that differs between pages and arms for the same
 * pipeline. The names are therefore comparable as they are, and the keys once
 * the counters are masked.
 *
 * NOT A VERDICT. A key set is expected to differ between arms on a cell that
 * carries the change under test; the comparison is reported in the receipt for
 * the reader of the two reports.
 *
 * @module Tools/visual-regression/lib/landing-pipeline-keys
 */

/** The reader's name in `--readers`. */
export const PIPELINE_KEYS_READER = "pipeline-keys";

/**
 * PAGE SIDE. The pipeline cache's rows and counters. A missing seam is named;
 * no pipeline object and no timestamp leaves the page.
 */
export function pageReadPipelineKeys() {
  const viewer = /** @type {any} */ (globalThis).viewer;
  const context = viewer && viewer.scene && viewer.scene.context;
  const cache = context && context.webgpuPipelineCache;
  if (!cache) {
    return { seam: "viewer.scene.context.webgpuPipelineCache" };
  }
  if (typeof cache.listPipelineVariants !== "function") {
    return { seam: "webgpuPipelineCache.listPipelineVariants" };
  }
  if (typeof cache.getStats !== "function") {
    return { seam: "webgpuPipelineCache.getStats" };
  }
  try {
    const rows = cache.listPipelineVariants().map((row) => ({
      key: String(row.key),
      name: String(row.name),
    }));
    const stats = cache.getStats();
    const counter = (value) => (typeof value === "number" ? value : null);
    return {
      rows,
      stats: {
        created: counter(stats.created),
        size: counter(stats.size),
        pending: counter(stats.pending),
        hits: counter(stats.hits),
        misses: counter(stats.misses),
        evicted: counter(stats.evicted),
        wrongModuleHits: counter(stats.wrongModuleHits),
      },
    };
  } catch (error) {
    return {
      seam: "webgpuPipelineCache.listPipelineVariants()",
      error: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * A pipeline cache key with the per-page object identities masked: `pl:<n>`
 * becomes `pl:#` and each module id of the `sh:` segment (`sh:12.vertexMain/
 * 12.fragmentMain`) becomes `#`. The identities come from a page-global
 * counter, so they differ between pages for the same pipeline; every other
 * segment is structural and is kept. The first segment is the descriptor name
 * and is never touched. Pure.
 *
 * @param {string} key
 * @returns {string}
 */
export function stablePipelineKey(key) {
  return String(key)
    .split("|")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }
      if (/^pl:\d+$/.test(segment)) {
        return "pl:#";
      }
      if (segment.startsWith("sh:")) {
        return segment.replace(/(^sh:|\/)\d+\./g, "$1#.");
      }
      return segment;
    })
    .join("|");
}

const STATS_FIELDS = Object.freeze([
  "created",
  "size",
  "pending",
  "hits",
  "misses",
  "evicted",
  "wrongModuleHits",
]);

/** The shape of a quantity the page cannot answer. */
function notAvailable(seam) {
  return { available: false, reason: `NOT AVAILABLE: ${seam}` };
}

const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * The pipeline-keys record from the page's raw answer. Pure.
 *
 * @param {object|null|undefined} raw {@link pageReadPipelineKeys}' answer.
 * @returns {object}
 */
export function buildPipelineKeysRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return notAvailable("pageReadPipelineKeys returned nothing");
  }
  if (!Array.isArray(raw.rows)) {
    return notAvailable(
      raw.error
        ? `${raw.seam} (threw: ${raw.error})`
        : (raw.seam ?? "viewer.scene.context.webgpuPipelineCache"),
    );
  }
  const families = {};
  for (const row of raw.rows) {
    const family = String(row.name).split(/\s+/)[0];
    (families[family] ??= []).push(row.name);
  }
  for (const family of Object.keys(families)) {
    families[family] = sortedUnique(families[family]);
  }
  const stats = {};
  for (const field of STATS_FIELDS) {
    stats[field] = raw.stats?.[field] ?? null;
  }
  return {
    available: true,
    evidence:
      "webgpuPipelineCache.listPipelineVariants() and getStats(), read after the capture",
    count: raw.rows.length,
    names: sortedUnique(raw.rows.map((row) => row.name)),
    stableKeys: raw.rows.map((row) => stablePipelineKey(row.key)).sort(),
    families,
    stats,
  };
}

/** The base page of the same cell, renderer, page and run, if any. */
function twinOf(page, basePages) {
  return basePages.find(
    (other) =>
      other?.cell === page.cell &&
      other?.renderer === page.renderer &&
      other?.page === page.page &&
      other?.run === page.run,
  );
}

const sameList = (a, b) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Each page that carries `readers.pipelineKeys` against the same page of a base
 * report: the keys of one family on one side only, whether the family's names
 * are equal, whether the whole stable key list is equal, and the two sides'
 * `wrongModuleHits`. Pure.
 *
 * @param {object[]} pages This run's page records.
 * @param {object[]} basePages The base report's page records.
 * @param {{family?: string}} [options]
 * @returns {Array<{cell: string, renderer: string, page: string, run: number,
 *   family: string, measured: boolean, reason?: string, same?: boolean,
 *   onlyBase?: string[], onlyTip?: string[], stableKeysSame?: boolean,
 *   wrongModuleHits?: {base: number|null, tip: number|null}}>}
 */
export function pipelineKeyComparisons(
  pages,
  basePages,
  { family = "ProceduralClouds" } = {},
) {
  const out = [];
  for (const page of pages ?? []) {
    const tip = page?.readers?.pipelineKeys;
    if (tip === undefined) {
      continue;
    }
    const entry = {
      cell: page.cell,
      renderer: page.renderer,
      page: page.page,
      run: page.run,
      family,
    };
    const twin = twinOf(page, basePages ?? []);
    const base = twin?.readers?.pipelineKeys;
    const lacking = [
      twin === undefined
        ? "base has no page of this cell, renderer, page and run"
        : null,
      twin !== undefined && base === undefined
        ? "base page carries no pipelineKeys (run it with --readers pipeline-keys)"
        : null,
      base?.available === false ? `base: ${base.reason}` : null,
      tip?.available === false ? `tip: ${tip.reason}` : null,
    ].filter(Boolean);
    if (lacking.length > 0) {
      out.push({ ...entry, measured: false, reason: lacking.join("; ") });
      continue;
    }
    const baseNames = base.families?.[family] ?? [];
    const tipNames = tip.families?.[family] ?? [];
    out.push({
      ...entry,
      measured: true,
      same: sameList(baseNames, tipNames),
      onlyBase: baseNames.filter((name) => !tipNames.includes(name)),
      onlyTip: tipNames.filter((name) => !baseNames.includes(name)),
      stableKeysSame: sameList(base.stableKeys ?? [], tip.stableKeys ?? []),
      wrongModuleHits: {
        base: base.stats?.wrongModuleHits ?? null,
        tip: tip.stats?.wrongModuleHits ?? null,
      },
    });
  }
  return out;
}
