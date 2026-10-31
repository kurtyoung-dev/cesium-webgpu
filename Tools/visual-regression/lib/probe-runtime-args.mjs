// probe-runtime-args.mjs — the probe runtime's flag table, defaults and value parsers.
//
// @purpose Companion of probe-runtime.mjs: the REQUIRED_SERVED_ARTIFACTS and RENDERERS constants, the core flag table (CORE_OPTION_SPECS), its defaults (CORE_OPTION_DEFAULTS) and the four value parsers parseProbeArgs applies (optionValue, positiveInteger, nonNegativeNumber, rendererList).
// @status ACTIVE
//
// WHY A PIECE. The table and its parsers moved out of `probe-runtime.mjs`
// when that module passed 1,000 lines (DX-KIT-DECOMPOSE-RUNTIME-WATER). The
// runtime re-exports every public name it exported before, so no importer
// changed. `parseProbeArgs` itself stays in the runtime beside the port-8080
// refusal it raises: the runtime specs mutate that guard in the runtime's own
// source, and the refusal is a governance decision of the composition root
// rather than a parsing detail. The four value parsers are exported here for
// the runtime's use only; the runtime does not re-export them, so its public
// surface is unchanged.

import { DEFAULT_SERVED_BUILD_ARTIFACTS } from "./served-build-preflight.mjs";

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/**
 * The bundles a served-build assertion checks unless a probe narrows it.
 *
 * This is a RE-EXPORT, not a second list. The preflight library owns the set,
 * and a copy here would drift fail-open: if that library ever gained a third
 * bundle, a runtime with its own two-entry copy would let a stale third one
 * through without ever naming it in the refusal.
 */
export const REQUIRED_SERVED_ARTIFACTS = DEFAULT_SERVED_BUILD_ARTIFACTS;

/** Renderer names a probe may be pointed at. */
export const RENDERERS = Object.freeze(["webgl", "webgpu"]);

// ---------------------------------------------------------------------------
// 2. Argument parsing
// ---------------------------------------------------------------------------

/**
 * The flags every probe accepts. A probe adds its own through
 * `descriptor.args.extraOptions`; it never re-implements one of these.
 *
 * `--serve-built` is an ASSERTION, not a server switch: the probe cannot start
 * the server, so what the flag governs is whether the runtime insists that the
 * bytes the origin serves are the bytes on disk. It defaults ON — fail-closed —
 * and `--no-serve-built` is the visible, recorded waiver.
 */
export const CORE_OPTION_SPECS = Object.freeze([
  { flag: "--port", key: "port", kind: "positive-integer" },
  { flag: "--runs", key: "runs", kind: "positive-integer" },
  { flag: "--reverse", key: "reverse", kind: "boolean" },
  { flag: "--headed", key: "headed", kind: "boolean" },
  { flag: "--renderer", key: "renderers", kind: "renderer-list" },
  { flag: "--serve-built", key: "servedBuild", kind: "boolean" },
  { flag: "--no-serve-built", key: "servedBuild", kind: "boolean-false" },
  { flag: "--repository-root", key: "repositoryRoot", kind: "string" },
  { flag: "--output", key: "outputDirectory", kind: "string" },
  { flag: "--timeout-ms", key: "timeoutMs", kind: "positive-integer" },
]);

/** Defaults for the core flags. `port` is a governed Edge port, never 8080. */
export const CORE_OPTION_DEFAULTS = Object.freeze({
  port: 8094,
  runs: 1,
  reverse: false,
  headed: false,
  renderers: RENDERERS,
  servedBuild: true,
  repositoryRoot: null,
  outputDirectory: null,
  timeoutMs: 120000,
});

/**
 * @param {string[]} argv Raw argument list.
 * @param {number} index Index of the flag.
 * @param {string} name The flag, for the error message.
 * @returns {string} The flag's value.
 */
export function optionValue(argv, index, name) {
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return argv[index + 1];
}

/**
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {number} The parsed integer.
 */
export function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {number} The parsed number.
 */
export function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return parsed;
}

/**
 * `--renderer` accepts one backend, both comma-separated, or the word `both`.
 * The result always lists backends in `RENDERERS` order, so a probe's cell
 * order — and therefore its receipt — does not depend on how the flag was
 * spelled.
 *
 * @param {string} value Raw value.
 * @param {string} name The flag, for the error message.
 * @returns {string[]} Selected backends, in canonical order.
 */
export function rendererList(value, name) {
  const requested =
    value === "both"
      ? [...RENDERERS]
      : value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0);
  if (requested.length === 0) {
    throw new TypeError(`${name} requires at least one renderer`);
  }
  for (const entry of requested) {
    if (!RENDERERS.includes(entry)) {
      throw new TypeError(
        `${name} must be one of ${RENDERERS.join(", ")}, both, or a comma-separated subset (got "${entry}")`,
      );
    }
  }
  return RENDERERS.filter((entry) => requested.includes(entry));
}
