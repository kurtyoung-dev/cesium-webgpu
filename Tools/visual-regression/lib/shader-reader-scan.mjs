/**
 * Finds specs that name an engine shader path instead of reading it through the kit.
 * @purpose Static tripwire for DX-RAW-GLOBETERRAIN-READERS: lists the path-like `.wgsl` string literals a spec carries outside the first argument of readEngineShader/engineShaderPath, so a new spec that joins its own shader path is caught before a shader move breaks it.
 * @status ACTIVE
 *
 * This reads TEXT, so it is a tripwire, not a proof: a literal kept as data (a
 * path list, a map key) is flagged the same as one handed to readFileSync, and
 * a path assembled from fragments is missed. The proof that a migrated spec
 * reads the same bytes is its own before/after run; this only keeps new raw
 * readers from accreting. A literal counts when it ends in `<name>.wgsl` and
 * either contains a `/` or sits inside `path.join(`/`path.resolve(`/`new URL(`.
 */
import { execFileSync } from "node:child_process";

const KIT_CALL =
  /(?:readEngineShader|engineShaderPath)\(\s*(["'`])[^"'`\n]*\1/g;
const WGSL_LITERAL = /(["'`])((?:(?!\1)[^\n])*?[A-Za-z0-9_]\.wgsl)\1/g;

/**
 * @param {string} text A spec's source.
 * @returns {string[]} The distinct raw shader-path literals, in source order.
 */
export function rawShaderReferences(text) {
  const code = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(KIT_CALL, "");
  const hits = new Set();
  for (const match of code.matchAll(WGSL_LITERAL)) {
    const literal = match[2];
    const before = code.slice(Math.max(0, match.index - 80), match.index);
    if (
      literal.includes("/") ||
      /path\.(?:join|resolve)\([^()]*$/.test(before) ||
      /new URL\(\s*$/.test(before)
    ) {
      hits.add(literal);
    }
  }
  return [...hits];
}

/**
 * Every TRACKED spec under Tools/, repo-relative. Untracked files are never
 * listed: a gate must not fail on a maintainer's uncommitted prototype folder
 * in the seat worktree (the 2026-10-30 landing flagged ten such specs).
 * @param {string} root Repository root.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] Environment for git (a seam for specs).
 * @returns {string[]}
 */
export function listToolSpecs(root, { env = process.env } = {}) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--", ":(glob)Tools/**/*.spec.mjs"],
    { cwd: root, encoding: "utf8", windowsHide: true, env },
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
}
