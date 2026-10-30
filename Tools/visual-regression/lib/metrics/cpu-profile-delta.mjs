/**
 * Self time from V8 CPU profiles, cropped to a page-time interval, by
 * function, by script and by bundled module, aggregated per arm, and the
 * largest AFTER-minus-BEFORE deltas with every run's value beside them.
 * @purpose Node metric for startup attribution: crops a `.cpuprofile` to a page-time window through the calibration mark of lib/cpu-profile-step.mjs, sums sample self time by function (name @ module, never a bundle line, so two builds line up), by script URL and by bundled module (from esbuild's `// <path>` markers in an unminified bundle) plus V8's pseudo-frames ((idle), (program), (garbage collector)), aggregates repeats per arm (mean and per-run values), and ranks the top AFTER-minus-BEFORE deltas with a sign-consistency count.
 * @status ACTIVE
 *
 * SELF TIME. A sample's time is its `timeDeltas` entry for the NEXT sample
 * (V8 records the delta before each sample; the time a sample stands for is
 * the gap to the following one). The last sample stands for nothing. A sample
 * is inside the window when its own timestamp is.
 *
 * THE WINDOW is page time (`performance.now()`, navigation-relative). The
 * calibration (`{pageStartMs, pageEndMs}` around the mark's spin) is matched to
 * the samples whose stack holds the mark function; the offset is the midpoint
 * of those samples minus the page-time midpoint of the spin. A profile with no
 * mark samples has no offset and is refused (`calibrated: false`), never read
 * against a guessed origin.
 *
 * KEYS. A function key is `name @ module` where module is the bundled module
 * path when the script is a mapped bundle, else the script's path (origin
 * stripped), else `(native)`. Bundle line numbers are deliberately not in the
 * key: an AFTER bundle with more lines would shift every function below a
 * change and nothing would line up.
 *
 * @module Tools/visual-regression/lib/metrics/cpu-profile-delta
 */

/** V8 pseudo-frames, reported as their own categories. */
export const PSEUDO_FRAMES = Object.freeze([
  "(idle)",
  "(program)",
  "(garbage collector)",
  "(root)",
]);

// esbuild writes a module from outside the entry package relative to the
// bundle root (`// ../cesium-webgpu/node_modules/dompurify/...`); the leading
// `../<dir>/` segments are dropped so the key does not depend on the clone's
// name and the module is not folded into the one above it.
const MODULE_MARKER_RE =
  /^\/\/ (?:\.\.\/[^/\s]+\/)*((?:packages|node_modules|Source|Specs)\/\S+)$/;

/**
 * The bundled-module index of an unminified esbuild bundle: every line that is
 * exactly `// <path>` starts that module.
 *
 * @param {string} text The bundle's source.
 * @returns {Array<{line: number, module: string}>} Zero-based start lines,
 *   ascending.
 */
export function bundleModuleIndex(text) {
  const index = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const match = MODULE_MARKER_RE.exec(lines[line]);
    if (match) {
      index.push({ line, module: match[1] });
    }
  }
  return index;
}

/**
 * The module a zero-based bundle line belongs to.
 *
 * @param {Array<{line: number, module: string}>} index
 * @param {number} line
 * @returns {string|null}
 */
export function moduleForLine(index, line) {
  if (!Array.isArray(index) || index.length === 0 || !(line >= 0)) {
    return null;
  }
  let lo = 0;
  let hi = index.length - 1;
  if (line < index[0].line) {
    return "(bundle prelude)";
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index[mid].line <= line) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return index[lo].module;
}

/** The path of a script URL with the origin and query stripped. */
export function scriptPath(url) {
  if (!url) {
    return "(native)";
  }
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+/, "");
  } catch {
    return String(url);
  }
}

/**
 * Absolute sample timestamps (microseconds, the profile's clock).
 *
 * @param {object} profile
 * @returns {number[]}
 */
export function sampleTimes(profile) {
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const times = new Array(deltas.length);
  let at = Number(profile?.startTime) || 0;
  for (let i = 0; i < deltas.length; i++) {
    at += Number.isFinite(deltas[i]) ? deltas[i] : 0;
    times[i] = at;
  }
  return times;
}

function nodeMaps(profile) {
  const byId = new Map();
  const parent = new Map();
  for (const node of profile?.nodes ?? []) {
    byId.set(node.id, node);
  }
  for (const node of profile?.nodes ?? []) {
    for (const child of node.children ?? []) {
      parent.set(child, node.id);
    }
  }
  return { byId, parent };
}

function stackHas(id, name, byId, parent) {
  let current = id;
  let guard = 0;
  while (current !== undefined && guard++ < 10000) {
    if (byId.get(current)?.callFrame?.functionName === name) {
      return true;
    }
    current = parent.get(current);
  }
  return false;
}

/**
 * The offset that maps page time to the profile's clock, from the
 * calibration mark's samples.
 *
 * @param {object} profile
 * @param {{functionName: string, pageStartMs: number, pageEndMs: number}|null} calibration
 * @returns {{calibrated: boolean, offsetUs?: number, markSamples: number,
 *   reason?: string}} `profileUs = pageMs * 1000 + offsetUs`.
 */
export function calibrationOffset(profile, calibration) {
  if (
    !calibration ||
    !Number.isFinite(calibration.pageStartMs) ||
    !Number.isFinite(calibration.pageEndMs)
  ) {
    return { calibrated: false, markSamples: 0, reason: "no calibration" };
  }
  const { byId, parent } = nodeMaps(profile);
  const times = sampleTimes(profile);
  const samples = profile?.samples ?? [];
  const marked = [];
  for (let i = 0; i < samples.length; i++) {
    if (stackHas(samples[i], calibration.functionName, byId, parent)) {
      marked.push(times[i]);
    }
  }
  if (marked.length === 0) {
    return {
      calibrated: false,
      markSamples: 0,
      reason: "no sample inside the calibration mark",
    };
  }
  const profileMid = (marked[0] + marked[marked.length - 1]) / 2;
  const pageMidUs =
    ((calibration.pageStartMs + calibration.pageEndMs) / 2) * 1000;
  return {
    calibrated: true,
    offsetUs: profileMid - pageMidUs,
    markSamples: marked.length,
  };
}

/**
 * Self time inside a page-time window, by function, script, module and
 * pseudo-frame category.
 *
 * @param {object} profile A CDP profile.
 * @param {object} args
 * @param {object|null} args.calibration The step's calibration record.
 * @param {number} args.windowStartMs Page time (inclusive).
 * @param {number} args.windowEndMs Page time (exclusive).
 * @param {Record<string, Array<{line: number, module: string}>>} [args.moduleIndexByPath]
 *   {@link bundleModuleIndex} per script path.
 * @returns {object} `{calibrated, windowMs, totalMs, byFunction, byScript,
 *   byModule, byCategory, samplesInWindow}`; the maps are plain objects of ms.
 */
export function selfTimeInWindow(profile, args) {
  const offset = calibrationOffset(profile, args.calibration);
  if (!offset.calibrated) {
    return { calibrated: false, reason: offset.reason };
  }
  const startUs = args.windowStartMs * 1000 + offset.offsetUs;
  const endUs = args.windowEndMs * 1000 + offset.offsetUs;
  const { byId } = nodeMaps(profile);
  const times = sampleTimes(profile);
  const samples = profile?.samples ?? [];
  const indexes = args.moduleIndexByPath ?? {};
  const byFunction = {};
  const byScript = {};
  const byModule = {};
  const byCategory = {};
  let totalUs = 0;
  let inWindow = 0;
  const add = (map, key, us) => {
    map[key] = (map[key] ?? 0) + us / 1000;
  };
  for (let i = 0; i + 1 < samples.length; i++) {
    const at = times[i];
    if (at < startUs || at >= endUs) {
      continue;
    }
    const us = Math.min(times[i + 1], endUs) - at;
    if (!(us > 0)) {
      continue;
    }
    inWindow++;
    totalUs += us;
    const frame = byId.get(samples[i])?.callFrame ?? {};
    const name = frame.functionName || "(anonymous)";
    if (PSEUDO_FRAMES.includes(name)) {
      add(byCategory, name, us);
      add(byFunction, name, us);
      continue;
    }
    const script = scriptPath(frame.url);
    const index = indexes[script];
    const module = index ? moduleForLine(index, frame.lineNumber) : script;
    add(byCategory, frame.url ? "(script)" : "(native)", us);
    add(byScript, script, us);
    add(byModule, module ?? script, us);
    add(byFunction, `${name} @ ${module ?? script}`, us);
  }
  return {
    calibrated: true,
    offsetUs: offset.offsetUs,
    markSamples: offset.markSamples,
    windowMs: args.windowEndMs - args.windowStartMs,
    totalMs: totalUs / 1000,
    samplesInWindow: inWindow,
    byFunction,
    byScript,
    byModule,
    byCategory,
  };
}

/**
 * Repeats of one arm, one level (`byFunction`, `byModule`, ...): per key the
 * per-run values (0 when a run lacks the key) and their mean.
 *
 * @param {object[]} runs {@link selfTimeInWindow} results.
 * @param {string} level
 * @returns {Record<string, {runs: number[], mean: number}>}
 */
export function aggregateArm(runs, level) {
  const keys = new Set();
  for (const run of runs) {
    for (const key of Object.keys(run?.[level] ?? {})) {
      keys.add(key);
    }
  }
  const out = {};
  for (const key of keys) {
    const values = runs.map((run) => run?.[level]?.[key] ?? 0);
    out[key] = {
      runs: values,
      mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    };
  }
  return out;
}

/**
 * The largest AFTER-minus-BEFORE deltas at one level.
 *
 * @param {{before: object[], after: object[], level: string, limit?: number}} args
 * @returns {Array<{key: string, beforeMs: number, afterMs: number,
 *   deltaMs: number, beforeRuns: number[], afterRuns: number[],
 *   consistent: string}>} Sorted by |delta| descending. `consistent` is
 *   "k/n": how many AFTER runs sit on the delta's side of the BEFORE mean.
 */
export function topDeltas({ before, after, level, limit = 30 }) {
  const b = aggregateArm(before, level);
  const a = aggregateArm(after, level);
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const zero = (n) => ({ runs: new Array(n).fill(0), mean: 0 });
  const rows = [];
  for (const key of keys) {
    const bb = b[key] ?? zero(before.length);
    const aa = a[key] ?? zero(after.length);
    const deltaMs = aa.mean - bb.mean;
    const side = aa.runs.filter((v) =>
      deltaMs >= 0 ? v > bb.mean : v < bb.mean,
    ).length;
    rows.push({
      key,
      beforeMs: bb.mean,
      afterMs: aa.mean,
      deltaMs,
      beforeRuns: bb.runs,
      afterRuns: aa.runs,
      consistent: `${side}/${aa.runs.length}`,
    });
  }
  rows.sort((x, y) => Math.abs(y.deltaMs) - Math.abs(x.deltaMs));
  return rows.slice(0, limit);
}
