// oit-reach.mjs — which WGSL files WebGPU OIT can be handed, derived from the engine source.
// @purpose Census of the engine sites that give shader text to the WebGPU OIT transform (a draw command's retained `_shaderCode`, calls of `injectOITOutput` and `createOITPipeline`), and the set of tracked WGSL files those sites can reach by static imports, so the comment-only gate scopes the OIT parameter-list reader to shaders the transform can process and refuses every WGSL comment edit while a site is unclassified.
// @status ACTIVE
//
// WHY THIS EXISTS. `WebGPUOIT.injectOITOutput` renames a shader's fragment
// entry point and rebuilds its signature from the entry's parameter list as
// raw text. A comment inside that list is code for a shader the transform
// processes, so the `oit-entry-parameters` reader (`shader-text-readers.mjs`)
// refuses a comment edit there. The reader used to apply to every WGSL file,
// which refused a comment edit inside `Globe/GlobeTerrain.wgsl`'s fragment
// entry, a shader no OIT path can be given. Narrowing the reader to a
// hand-kept list of files would rot, and narrowing it to names the transform
// itself produces (`_oit_base_`) matched no tracked file and left the gate
// inert, so the narrowing is derived from the code instead.
//
// THE REACH. OIT receives shader text from exactly these places:
//   - a draw command that retains `_shaderCode`: the translucent pass hands
//     `cmd._shaderCode` to `createOITPipeline` for any WebGPU draw command that
//     carries it while OIT is on, so a property write of `_shaderCode` is an
//     input;
//   - a direct call of `injectOITOutput`.
// The census finds every such site under the engine source (comments are
// skipped, strings are not) and each must be classified in `OIT_REACH_TABLE`.
// The targets are the WGSL files in the forward static-import closure
// (relative static imports, re-exports and dynamic `import()`) of every file
// that holds a site classified as an input or as the transform, with a
// `Shaders/**/X.js` module that has an `X.wgsl` beside it read as `X.wgsl`
// whether or not the build has written `X.js`, so a built and an unbuilt tree
// give the same targets. The closure is an over-approximation, which is the
// safe side: it can only widen the reader.
//
// FAIL CLOSED. A site the table does not know (a new writer, a `_shaderCode`
// key in an object literal, a string or destructured use of the name, an alias
// of either function) is a model gap: `readerModelGaps` reports it and every
// shader comment edit is refused until the site is classified. So is a census
// that finds no input or no transform host, a census whose target set is
// empty, and an input file whose own imports reach no WGSL file: each would
// leave the reader inert for shaders the transform can be handed.
// `shaderReaderProblems` applies the reader when it is not given a path.
//
// KNOWN LIMITS (also listed in
// `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`). The closure
// follows imports from the files that hold a site. Text a caller hands to a
// writer as a parameter is not followed, and a copy made without naming the
// field (`Object.assign(a, b)`, a spread) is not seen. At the time of writing no
// writer takes tracked WGSL from a parameter and no command is copied onto a
// globe command: the collection writers read `WebGPUCollectionShaders.js`, the
// primitive writer `WebGPUPrimitiveShaders.js`, the model writer composes in
// `WebGPUModelPipelineCache.ts` and the splat source is inline. A new writer
// is caught by the census; a change of data flow inside a classified writer is
// not, which is why a row's key holds the statement's text, so editing the
// statement asks for a new classification.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize } from "./comment-scanner.mjs";

/** The engine source tree the census paths are relative to. */
const SOURCE_ROOT = fileURLToPath(
  new URL("../../../packages/engine/Source/", import.meta.url),
);

/** The repository path of `SOURCE_ROOT`, the prefix of every target. */
export const OIT_REACH_REPO_PREFIX = "packages/engine/Source/";

/** The module that defines `injectOITOutput` and `createOITPipeline`. */
export const OIT_TRANSFORM_HOST = "Renderer/WebGPU/WebGPUOIT.ts";

/** Engine directories that hold no hand-written code that can feed OIT. */
const CENSUS_SKIPPED = /^(?:Shaders|ThirdParty|Assets)\//;

/** The names whose appearance is a site. */
const SITE_NAMES = /\b(?:_shaderCode|injectOITOutput|createOITPipeline)\b/;

/**
 * How each census site is used. Keys are `file|text`, the text being the
 * statement the census reads (see `oitSitesInSource`).
 *
 *   - `oit-input`: stores shader text on a draw command the translucent pass
 *     can hand to the OIT transform. The file's WGSL imports are reach.
 *   - `oit-transform`: defines the transform or calls it with text the file
 *     builds itself. The file's imports are reach.
 *   - `oit-relay`: passes on text it received (a command's `_shaderCode`), so
 *     its imports are not reach. Classify a caller as a relay only after
 *     reading where its text comes from.
 *   - `not-oit-input`: names `_shaderCode` on an object that is not a draw
 *     command (the detail says which), so nothing reaches OIT through it.
 *   - `declaration`: a type or field declaration that stores nothing a draw
 *     command carries.
 */
const OIT_REACH_TABLE = [
  [
    "Renderer/WebGPU/WebGPUBillboardRenderer.js",
    "cache.colorCommand._shaderCode = entry.oitShaderCode",
    "oit-input",
    "the translucent billboard colour command, text from the Collections registry",
  ],
  [
    "Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts",
    "cmd._shaderCode = cache.oitFallbackShaderCode ?? undefined",
    "oit-input",
    "the splat command, text from the inline SPLAT_WGSL template",
  ],
  [
    "Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts",
    'WebGPUOIT.injectOITOutput(baseCode, "fragmentMain")',
    "oit-transform",
    "the direct caller; baseCode is the inline splat template",
  ],
  [
    "Renderer/WebGPU/WebGPUModelRenderer.ts",
    "webgpuCmd._shaderCode = oit.shaderCode",
    "oit-input",
    "the primary translucent model command, text composed by WebGPUModelPipelineCache",
  ],
  [
    "Renderer/WebGPU/WebGPUModelRenderer.ts",
    "translucentCmd._shaderCode = twinOIT.shaderCode",
    "oit-input",
    "the per-feature translucent twin, the same composition with BLEND",
  ],
  [
    "Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js",
    "cache.colorCommand._shaderCode = pipelineEntry.oitShaderCode",
    "oit-input",
    "the point primitive colour command, text from the Collections registry",
  ],
  [
    "Renderer/WebGPU/WebGPUPolylineRenderer.js",
    "cmd._shaderCode = pipelineResult.oitShaderCode",
    "oit-input",
    "the polyline command, text from the Collections registry",
  ],
  [
    "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
    "cmd._shaderCode = cache.oitShaderCode",
    "oit-input",
    "the primitive command, text from the Primitive registry",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    'static injectOITOutput(baseWGSL: string, fragmentEntryPoint: string = "fragmentMain...)',
    "oit-transform",
    "the transform's definition",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "createOITPipeline(device: GPUDevice, shaderCode: string, config: { label?: str...)",
    "oit-transform",
    "the generic path's definition",
  ],
  [
    "Renderer/WebGPU/WebGPUOIT.ts",
    "WebGPUOIT.injectOITOutput(shaderCode, fragEntry)",
    "oit-transform",
    "createOITPipeline's own call of the transform",
  ],
  [
    "Renderer/WebGPU/WebGPUSceneRendererTranslucentPass.ts",
    "host._oit.createOITPipeline(context.device, cmd._shaderCode, pipelineConfig ?? { label: ...)",
    "oit-relay",
    "the only caller of createOITPipeline: it relays the _shaderCode of any WebGPU draw command that retains one, so the writers above are the reach",
  ],
  [
    "Renderer/WebGPU/WebGPUDrawCommand.ts",
    "_shaderCode?: string",
    "declaration",
    "the draw command's optional field; clone() does not copy it",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    '_shaderCode: string = ""',
    "not-oit-input",
    "the globe renderer's own field: a renderer object, not a draw command and not in any command list",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "_shaderCode: string",
    "declaration",
    "the globe shader helper's view of the renderer's field",
  ],
  [
    "Renderer/WebGPU/WebGPUGlobeSurfaceShaders.ts",
    "host._shaderCode = code",
    "not-oit-input",
    "the globe renderer's own field, read back only by the globe's module and pipeline builders",
  ],
];

/** The classification, keyed by site key. */
export const OIT_REACH_USES = Object.freeze(
  Object.fromEntries(
    OIT_REACH_TABLE.map(([file, text, use, detail]) => [
      `${file}|${text}`,
      Object.freeze({ use, detail }),
    ]),
  ),
);

/** The uses whose file's imports are reach. */
const REACH_USES = new Set(["oit-input", "oit-transform"]);

const collapse = (text) => text.replace(/\s+/g, " ").trim();

/**
 * The text of a statement or argument list starting at an offset, up to the
 * end the scan view sees at depth zero.
 *
 * @param {string} scan Text with comments and strings blanked.
 * @param {string} text Text with comments blanked.
 * @param {number} from First offset of the text to read.
 * @param {RegExp} stop Characters that end the text at depth zero.
 * @param {boolean} closing Whether an unmatched `)` ends the text.
 * @returns {string} Collapsed text, at most 240 characters.
 */
function readUntil(scan, text, from, stop, closing) {
  let depth = 0;
  let at = from;
  for (; at < scan.length && at - from < 240; at++) {
    const character = scan[at];
    if (depth === 0 && stop.test(character)) {
      break;
    }
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      if (depth === 0 && closing) {
        break;
      }
      depth -= 1;
      if (depth < 0) {
        break;
      }
    }
  }
  return collapse(text.slice(from, at));
}

/**
 * The census sites one engine source file holds.
 *
 * Comments are skipped. A string that holds one of the names is a site, so
 * `x["_shaderCode"] = ...` cannot hide a write. A property write
 * `a.b._shaderCode = rhs` is keyed by its whole statement; a name that is not
 * a property access (a declaration, an object key, a shorthand, a destructured
 * name) is keyed by the text up to the end of its line or clause; a call or
 * definition of the two functions is keyed by its receiver, name and argument
 * list. A plain read (`x._shaderCode` with no assignment) is not a site.
 *
 * @param {string} file Path under `packages/engine/Source/`.
 * @param {string} source File text.
 * @returns {Array<{key: string, where: string}>} Sites in source order.
 */
export function oitSitesInSource(file, source) {
  if (!SITE_NAMES.test(source)) {
    return [];
  }
  const text = source.replace(/\r\n?/g, "\n");
  const blank = (part) => part.replace(/[^\n]/g, " ");
  let withStrings = "";
  let scan = "";
  const sites = [];
  const where = (offset) =>
    `${file}:${text.slice(0, offset).split("\n").length}`;
  for (const segment of tokenize(text, "js")) {
    const part = text.slice(segment.start, segment.end);
    if (segment.kind === "comment") {
      withStrings += blank(part);
      scan += blank(part);
    } else if (segment.kind === "string") {
      withStrings += part;
      scan += blank(part);
      if (SITE_NAMES.test(part)) {
        sites.push({
          offset: segment.start,
          key: `${file}|string ${collapse(part).slice(0, 80)}`,
        });
      }
    } else {
      withStrings += part;
      scan += part;
    }
  }
  for (const match of scan.matchAll(new RegExp(SITE_NAMES.source, "g"))) {
    const name = match[0];
    const end = match.index + name.length;
    const before = scan.slice(Math.max(0, match.index - 200), match.index);
    const dotted = /\??\.\s*$/.test(before);
    const receiver = dotted
      ? (before.match(/([\w$]+(?:\s*\??\.\s*[\w$]+)*)\s*\??\.\s*$/)?.[1] ?? "")
      : "";
    const prefix = receiver === "" ? "" : `${collapse(receiver)}.`;
    const after = scan.slice(end);
    if (name === "_shaderCode") {
      if (dotted) {
        const assigned = /^\s*(?:\|\||&&|\?\?)?=(?![=>])/.exec(after);
        if (assigned !== null) {
          const rhs = readUntil(
            scan,
            withStrings,
            end + assigned[0].length,
            /[;]/,
            true,
          );
          sites.push({
            offset: match.index,
            key: `${file}|${prefix}_shaderCode = ${rhs}`,
          });
        }
      } else {
        const rest = readUntil(scan, withStrings, end, /[;,\n]/, true);
        sites.push({
          offset: match.index,
          key: `${file}|_shaderCode${rest}`,
        });
      }
      continue;
    }
    // A function name: the definition's parameter list, a call's arguments,
    // or an alias with no call at all.
    const paren = /^\s*\(/.exec(after);
    if (paren === null) {
      sites.push({ offset: match.index, key: `${file}|${prefix}${name}` });
      continue;
    }
    const full = readUntil(
      scan,
      withStrings,
      end + paren[0].length,
      /$^/,
      true,
    );
    const args = full.length > 60 ? `${full.slice(0, 60)}...` : full;
    const modifier = /\bstatic\s+$/.test(before) ? "static " : "";
    sites.push({
      offset: match.index,
      key: `${file}|${modifier}${prefix}${name}(${args})`,
    });
  }
  return sites
    .sort((a, b) => a.offset - b.offset)
    .map((site) => ({ key: site.key, where: where(site.offset) }));
}

/**
 * The engine source tree as one listing, so imports resolve without touching
 * the file system again (a stat per candidate dominates the cost on Windows).
 *
 * @param {string} sourceRoot Absolute engine source root.
 * @returns {{files: Set<string>, read: (file: string) => string}} Every file
 *   under the root, relative to it with forward slashes, and a cached reader.
 */
function sourceTree(sourceRoot) {
  const files = new Set(
    readdirSync(sourceRoot, { recursive: true }).map((entry) =>
      String(entry).split(path.sep).join("/"),
    ),
  );
  const cache = new Map();
  return {
    files,
    read(file) {
      if (!cache.has(file)) {
        cache.set(file, readFileSync(path.join(sourceRoot, file), "utf8"));
      }
      return cache.get(file);
    },
  };
}

/** An import, re-export or dynamic import of a relative module. */
const IMPORT_SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?[\w$*{}\s,]*?\bfrom\s*["'](\.[^"']*)["']|\bimport\s*["'](\.[^"']*)["']|\bimport\(\s*["'](\.[^"']*)["']\s*\)/g;

/**
 * The file a relative import names, if it is in the tree. A shader module
 * under `Shaders/` (`X.js`, generated by the build) stands for its source
 * (`X.wgsl`) whenever that source is in the tree, so the answer does not depend
 * on whether the build has run: tried after `X.js`, a built tree resolved
 * every shader import to the string module and the target set came out empty.
 *
 * @param {Set<string>} files The tree listing.
 * @param {string} from Importing file, relative to the root.
 * @param {string} specifier Relative specifier.
 * @returns {string|undefined} Imported file, relative to the root.
 */
function resolveImport(files, from, specifier) {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier),
  );
  const stem = base.replace(/\.[cm]?js$/, "");
  if (base.startsWith("Shaders/") && files.has(`${stem}.wgsl`)) {
    return `${stem}.wgsl`;
  }
  return [
    base,
    `${stem}.ts`,
    `${stem}.wgsl`,
    `${base}.js`,
    `${base}.ts`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ].find((candidate) => files.has(candidate) && /\.\w+$/.test(candidate));
}

/**
 * The WGSL files in the forward import closure of some modules.
 *
 * @param {{files: Set<string>, read: (file: string) => string}} tree Source tree.
 * @param {string[]} roots Root files, relative to the tree.
 * @returns {string[]} Repo-relative paths of the WGSL files, sorted.
 */
function wgslImportClosure(tree, roots) {
  const seen = new Set();
  const wgsl = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (file.endsWith(".wgsl")) {
      wgsl.add(OIT_REACH_REPO_PREFIX + file);
      continue;
    }
    if (!/\.(?:[cm]?js|ts)$/.test(file) || !tree.files.has(file)) {
      continue;
    }
    for (const match of tree.read(file).matchAll(IMPORT_SPECIFIER)) {
      const target = resolveImport(
        tree.files,
        file,
        match[1] ?? match[2] ?? match[3],
      );
      if (target !== undefined) {
        queue.push(target);
      }
    }
  }
  return [...wgsl].sort();
}

/**
 * The census of one engine source tree.
 *
 * @param {string} [sourceRoot] Absolute engine source root.
 * @returns {{sites: Array<{key: string, wheres: string[], use?: string, detail?: string}>, gaps: string[], roots: string[], targets: string[]}}
 *   Sites merged by key, the model gaps, the files whose imports are reach and
 *   the WGSL files they reach.
 */
export function oitReachCensus(sourceRoot = SOURCE_ROOT) {
  const tree = sourceTree(sourceRoot);
  const byKey = new Map();
  const census = [...tree.files]
    .filter(
      (entry) =>
        /\.(?:[cm]?js|ts)$/.test(entry) &&
        !entry.endsWith(".d.ts") &&
        !CENSUS_SKIPPED.test(entry),
    )
    .sort();
  for (const file of census) {
    for (const site of oitSitesInSource(file, tree.read(file))) {
      const known = byKey.get(site.key);
      if (known === undefined) {
        byKey.set(site.key, {
          key: site.key,
          wheres: [site.where],
          ...OIT_REACH_USES[site.key],
        });
      } else {
        known.wheres.push(site.where);
      }
    }
  }
  const sites = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const gaps = sites
    .filter((site) => site.use === undefined)
    .map(
      (site) =>
        `an unclassified OIT shader-text site ${site.key} (${site.wheres[0]}); classify it in oit-reach.mjs OIT_REACH_TABLE`,
    );
  const reaching = sites.filter((site) => REACH_USES.has(site.use));
  const roots = [
    ...new Set(
      reaching.map((site) => site.key.slice(0, site.key.indexOf("|"))),
    ),
  ].sort();
  if (!reaching.some((site) => site.use === "oit-input")) {
    gaps.push(
      "the OIT reach census finds no site that stores shader text on a draw command, so the set of shaders OIT can be handed would be empty",
    );
  }
  if (
    !reaching.some(
      (site) =>
        site.use === "oit-transform" &&
        site.key.startsWith(`${OIT_TRANSFORM_HOST}|static injectOITOutput(`),
    )
  ) {
    gaps.push(
      `the OIT reach census no longer finds the definition of injectOITOutput in ${OIT_TRANSFORM_HOST}`,
    );
  }
  const inputs = [
    ...new Set(
      reaching
        .filter((site) => site.use === "oit-input")
        .map((site) => site.key.slice(0, site.key.indexOf("|"))),
    ),
  ].sort();
  for (const file of inputs) {
    if (wgslImportClosure(tree, [file]).length === 0) {
      gaps.push(
        `the OIT input ${file} reaches no WGSL file by its imports, so the shaders it hands OIT are not in the derived set`,
      );
    }
  }
  const targets = wgslImportClosure(tree, roots);
  if (targets.length === 0) {
    gaps.push(
      "the OIT reach census derives no WGSL file OIT can be handed, so the oit-entry-parameters reader would apply to no shader",
    );
  }
  return { sites, gaps, roots, targets };
}

let census;

/** The census of the live engine source, computed once. */
function liveCensus() {
  census ??= oitReachCensus();
  return census;
}

/**
 * Why the OIT reach is not known: census sites that are not classified, and a
 * census that cannot find the transform or any input.
 *
 * @returns {string[]} One line per gap.
 */
export function oitReachGaps() {
  return liveCensus().gaps;
}

/**
 * The census sites with their classification.
 *
 * @returns {Array<{key: string, wheres: string[], use?: string, detail?: string}>}
 *   Sites, sorted by key.
 */
export function oitReachSites() {
  return liveCensus().sites;
}

/**
 * The repo-relative WGSL files `WebGPUOIT` can be handed.
 *
 * @returns {string[]} Sorted paths under `packages/engine/Source/`.
 */
export function oitReachTargets() {
  return liveCensus().targets;
}

let targetSet;

/**
 * Whether a file can be given to the OIT transform. A path of the wrong shape
 * (not a string, or not under `packages/engine/Source/` once normalised, such
 * as an absolute path) is in reach, so a caller that cannot say which file it
 * holds gets the reader.
 *
 * @param {unknown} relPath Repo-relative path of the shader.
 * @returns {boolean} Whether the OIT parameter-list reader must be applied.
 */
export function inOitReach(relPath) {
  if (typeof relPath !== "string" || relPath === "") {
    return true;
  }
  const normal = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (!normal.startsWith(OIT_REACH_REPO_PREFIX)) {
    return true;
  }
  targetSet ??= new Set(oitReachTargets());
  return targetSet.has(normal);
}
