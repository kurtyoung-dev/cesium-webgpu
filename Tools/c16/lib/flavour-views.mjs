// flavour-views.mjs — what each build flavour and comment reader does to comment text.
// @purpose Per-reader views for the comment-only gate: the release pragma strip (scripts and generated shader modules), the minify-time WGSL comment strip, the runtime GLSL doc-comment strip, the engine code that reads shader source text, the debug-pragma lint and next-line directives, so a comment edit that changes a shipped artifact or a gate's verdict is refused.
// @status ACTIVE
//
// WHY THIS EXISTS. `canonicalizeCode` proves that the source token stream is
// unchanged. Several readers in this repository act on comment TEXT or on
// where a comment sits, so an edit that is comment-only to the tokenizer can
// still change what ships, what runs, or what a landing gate decides:
//
//   - The release build removes `//>>includeStart('debug', pragmas.debug)` ...
//     `//>>includeEnd('debug')` regions with a regex that has no line anchor
//     (`constructRegex`, `scripts/build.js`). Prose that quotes the pragma
//     opens a strip region, and the release bundle loses the code up to the
//     next `includeEnd`. The same plugin also runs over the generated shader
//     modules, where the GLSL comments are still present.
//   - The minified build removes WGSL comments with a strip that tracks block
//     comments with one boolean (`stripWgslComments`, `scripts/build.js`).
//     WGSL block comments nest, so a comment holding `/**/` — a glob such as
//     `Shaders/WebGPU/**/*.wgsl` is enough — leaves its tail in the minified
//     module as code, and only that flavour fails to compile.
//   - `ShaderSource` removes GLSL `//` comments and then `/** */` blocks at
//     runtime in every unminified build, and harvests `czm_` dependencies from
//     what is left (`removeComments`, `Renderer/ShaderSource.js`). A one-line
//     `/** */` makes it throw, a `//` on a doc block's closing line makes it
//     swallow the next function, and a `/**` demoted to `/*` turns every
//     `czm_` name in the block into a dependency.
//   - A `--minify` build removes GLSL comments with `glsl-strip-comments`,
//     whose tokenizer continues a `//` comment past a trailing backslash,
//     closes a block comment at `/*` + `/`, and keeps a comment that follows
//     a `#` directive on its line, where the runtime readers then read it.
//   - Scene and renderer code reads shader source text at runtime, mostly
//     without skipping comments: the subgroup sentinels a device without
//     subgroups strips, the chunk markers that prepend a shared chunk, the
//     first "void main" `BatchTable` splices before, the "out_FragData" test
//     that switches a pick shader's output, the first storage-texture format a
//     pipeline swaps, the first `#import` line a renderer expands, and more.
//     Prose that spells one of those out moves or adds a match
//     (`shader-text-readers.mjs` harvests and classifies them).
//   - `Tools/lint-debug-pragmas.mjs` reads console calls on any non-comment
//     line and honours `// lint-debug-pragmas-allow` only on the line
//     directly above the call.
//   - `eslint-disable-next-line`, `@ts-expect-error` and `@ts-ignore` bind to
//     the line after them, so a line inserted between a directive and its
//     code un-binds it.
//
// THE CONTRACT. A file passes a flavour when that flavour's output of the text
// is exactly what the tokenizer says the source is:
//
//   - JS/TS (the files the release pragma plugin loads): every release-strip
//     match in the new text starts and ends on a `//>>` line comment that opens
//     its line. The two release-stripped texts are compared as well, even when
//     the old text holds a malformed anchor.
//   - WGSL: the canonical form of the minify-stripped text equals the canonical
//     form of the source.
//   - GLSL: `removeComments` does not throw, the code it leaves equals the
//     tokenizer's code, and the `czm_` names it leaves equal the names in that
//     code; the canonical form of the `--minify` module text equals the
//     tokenizer's code, and the comment text that module keeps is the same in
//     the old and the new text.
//   - GLSL and WGSL: the release strip removes nothing from the generated
//     module, in each minify setting the build uses for that language.
//   - GLSL and WGSL, shader-text readers: each reader that is not exempt
//     matches as many times in the new text as in the old, in the view it
//     reads, and each match starts and ends in the same kind of region (code
//     or comment) and reads the same text. While the reader model has a gap
//     (an unclassified runtime-built regex, or a hand-written reader whose
//     source text is gone), every shader comment edit is refused.
//   - JS/TS, lint reader: `findOffenders` reports the same console calls for
//     the old and the new text.
//   - JS/TS, next-line directives: the lines between each directive and the
//     next code line are the same sequence of blank and comment lines.
//
// The single-text checks run on the NEW text. The tokenizer view has already
// proved the new source equal to the old, so every flavour of the new text
// then agrees with the old source. An edit that repairs an old disagreement
// passes only when it leaves the release output unchanged, because repairing a
// malformed anchor moves what the release build strips; an edit that
// introduces a disagreement is refused. The shader-text readers, the
// kept minified GLSL comments, the lint and the next-line directives compare
// the old text with the new, because what they read is a position, a count or
// a kept comment rather than a transform's output.
//
// WHERE THE TRANSFORMS COME FROM. The release regex, its pragma table, the
// WGSL strip and the shader module writer are imported from
// `scripts/build.js`, the GLSL minify strip is the package the build imports,
// resolved from the build script, and the lint comes from its own module, so
// they cannot drift.
// The shader-text readers are harvested from the engine source each run, so a
// new one is checked without being listed. `removeComments` is private to the
// engine module that uses it and that module imports the engine, so it is
// copied here byte for byte, as are `WGSLShaderPreprocessor.removeComments`
// (a TypeScript method) and the build's license-block pattern, which is inline
// in the build; the specs fail when a source copy changes.

import {
  constructRegex,
  pragmas,
  shaderSourceToJavaScript,
  stripWgslComments,
  wgslModuleContents,
} from "../../../scripts/build.js";
import { createRequire } from "node:module";

import {
  canonicalizeCode,
  classifySemanticComment,
  extractComments,
  lineOf,
  lineStarts,
  tokenize,
} from "./comment-scanner.mjs";
import {
  readerAppliesToPath,
  readerElements,
  readerModelGaps,
  shaderTextReaders,
} from "./shader-text-readers.mjs";
import { findOffenders } from "../../lint-debug-pragmas.mjs";

/** The GLSL comment strip the build imports, resolved as the build does. */
const glslStripComments = createRequire(
  new URL("../../../scripts/build.js", import.meta.url),
)("glsl-strip-comments");

/** The build's license-block extraction for shader modules, byte-pinned. */
export const SHADER_LICENSE_BLOCK_PATTERN =
  /\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm;

/** The file filter of the release pragma plugin in `scripts/build.js`. */
export const RELEASE_PRAGMA_FILTER = /\.[jt]sx?$/;

/** The dependency harvest `ShaderSource` runs over `removeComments` output. */
export const CZM_TOKEN_PATTERN = /\bczm_[a-zA-Z0-9_]*/g;

function removeComments(source) {
  // remove inline comments
  source = source.replace(/\/\/.*/g, "");
  // remove multiline comment block
  return source.replace(/\/\*\*[\s\S]*?\*\//gm, function (match) {
    // preserve the number of lines in the comment block so the line numbers will be correct when debugging shaders
    const numberOfLines = match.match(/\n/gm).length;
    let replacement = "";
    for (let lineNumber = 0; lineNumber < numberOfLines; ++lineNumber) {
      replacement += "\n";
    }
    return replacement;
  });
}

/** The vendored runtime GLSL comment strip, exported for the byte pin. */
export const glslRuntimeCommentStrip = removeComments;

/**
 * The text the release pragma plugin hands to esbuild.
 *
 * @param {string} source JS or TS source.
 * @returns {string} Source with every release pragma region removed.
 */
export function releasePragmaView(source) {
  let text = source.replace(/\r\n?/g, "\n");
  for (const key of Object.keys(pragmas)) {
    text = text.replace(constructRegex(key, pragmas[key]), "");
  }
  return text;
}

/**
 * Release-strip anchors that are not a `//>>` line comment opening its line.
 *
 * Each match of the release regex is anchored at its first `//>>` and ends at
 * its last. Both must be the start of a line comment preceded on its line by
 * nothing but indentation; anything else is pragma text inside prose, a
 * string, or a trailing comment, and the strip region it opens or closes is
 * not the one the source shows.
 *
 * @param {string} source JS or TS source.
 * @returns {Array<{line: number, anchor: string, text: string}>} Offending
 *   anchors, in source order.
 */
export function prosePragmaAnchors(source) {
  const text = source.replace(/\r\n?/g, "\n");
  const starts = lineStarts(text);
  const lineComments = new Set(
    tokenize(text, "js")
      .filter((segment) => segment.kind === "comment" && !segment.block)
      .map((segment) => segment.start),
  );
  const opensItsLine = (offset) => {
    const lineStart = starts[lineOf(starts, offset) - 1];
    return (
      lineComments.has(offset) && /^[\t ]*$/.test(text.slice(lineStart, offset))
    );
  };
  const found = [];
  for (const key of Object.keys(pragmas)) {
    const pattern = constructRegex(key, pragmas[key]);
    let match;
    let guard = 0;
    while ((match = pattern.exec(text)) !== null && guard++ < text.length) {
      const anchors = [
        ["start", match.index + match[0].indexOf("//>>")],
        ["end", match.index + match[0].lastIndexOf("//>>")],
      ];
      for (const [anchor, offset] of anchors) {
        if (!opensItsLine(offset)) {
          const line = lineOf(starts, offset);
          const lineEnd = text.indexOf("\n", offset);
          found.push({
            line,
            anchor,
            text: text
              .slice(starts[line - 1], lineEnd < 0 ? text.length : lineEnd)
              .trim(),
          });
        }
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * WGSL block comments that contain another block-comment opener.
 *
 * @param {string} source WGSL source.
 * @returns {number[]} 1-based lines where such comments open.
 */
export function nestedWgslBlockComments(source) {
  return extractComments(source.replace(/\r\n?/g, "\n"), "wgsl")
    .filter((comment) => comment.block && comment.text.slice(2).includes("/*"))
    .map((comment) => comment.line);
}

/**
 * Sorted, de-duplicated `czm_` names in a text.
 *
 * @param {string} text GLSL text.
 * @returns {string[]} Names.
 */
export function czmTokens(text) {
  return [...new Set(text.match(CZM_TOKEN_PATTERN) ?? [])].sort();
}

/**
 * The 1-based canonical line where two canonical forms first differ.
 *
 * @param {string} left Canonical form.
 * @param {string} right Canonical form.
 * @returns {number} Line number.
 */
function firstDifferenceLine(left, right) {
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) {
    i += 1;
  }
  return left.slice(0, i).split("\n").length;
}

/**
 * Release-strip matches in the modules the build generates from a shader.
 *
 * The release pragma plugin loads every generated `.js` shader module, and an
 * unminified GLSL module still carries the shader's comments, as does an
 * unminified WGSL module. No shader carries a live debug pragma, so any match
 * is prose the strip would cut the shader at.
 *
 * @param {string} source Shader source.
 * @param {("wgsl-minify"|"glsl-runtime")} flavour The shader's flavour.
 * @returns {Array<{flavour: string, detail: string}>} Problems.
 */
export function shaderReleaseProblems(source, flavour) {
  const text = source.replace(/\r\n/g, "\n");
  const headers = text.match(SHADER_LICENSE_BLOCK_PATTERN);
  const copyright = headers ? `${headers.join("\n")}\n` : "";
  const settings = flavour === "wgsl-minify" ? [false, true] : [false];
  const problems = [];
  for (const minify of settings) {
    const contents =
      flavour === "wgsl-minify" ? wgslModuleContents(text, minify) : text;
    const moduleText = shaderSourceToJavaScript(contents, copyright);
    if (releasePragmaView(moduleText) !== moduleText) {
      problems.push({
        flavour: "release-pragma",
        detail: `the release strip removes text from the generated ${minify ? "minified" : "unminified"} shader module`,
      });
    }
  }
  return problems;
}

function removeWgslPreprocessorComments(source) {
  // Remove single-line comments
  source = source.replace(/\/\/.*/g, "");
  // Remove multi-line comments (block comments)
  source = source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Preserve line count for debugging
    const lineCount = (match.match(/\n/g) || []).length;
    return "\n".repeat(lineCount);
  });
  return source;
}

/**
 * The vendored `WGSLShaderPreprocessor.removeComments`, exported for the byte
 * pin. Its `csm_` and struct-name harvests read its output.
 */
export const wgslPreprocessorCommentStrip = removeWgslPreprocessorComments;

/** The language each stripped view exists in. */
const VIEW_LANGUAGE = Object.freeze({
  "glsl-strip": "glsl",
  "wgsl-preprocessor-strip": "wgsl",
});

/**
 * The text a shader-text reader is applied to, per the view it names.
 *
 * `ShaderSource` strips a GLSL source after appending it to the combined
 * shader behind a `#line 0` line, so the stripped view starts on a new line,
 * as the reader sees it.
 *
 * @param {string} view `raw`, `glsl-strip` or `wgsl-preprocessor-strip`.
 * @param {string} text Shader text, with LF line endings.
 * @returns {string} The view's text; the raw text when the strip throws,
 *   which the GLSL flavour check reports on its own.
 */
function readerView(view, text) {
  try {
    if (view === "glsl-strip") {
      return `\n${removeComments(text)}`;
    }
    if (view === "wgsl-preprocessor-strip") {
      return removeWgslPreprocessorComments(text);
    }
  } catch {
    return text;
  }
  return text;
}

/**
 * Shortens a reader element for a message.
 *
 * @param {string|undefined} element Element.
 * @returns {string} Quoted, at most 80 characters of text.
 */
function quoteElement(element) {
  const text = element ?? "";
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

/**
 * Where the engine's shader-text readers read the old and the new text
 * differently (`shader-text-readers.mjs` harvests and classifies them).
 *
 * For each reader that is not exempt, the matches in the old and the new text
 * must be as many, and each must start and end in the same kind of region and
 * read the same text. The count catches a needle gained or lost in prose; the
 * elements catch a first match that moved into a comment, and comment text a
 * match reads at its ends.
 *
 * @param {string} before Old shader text.
 * @param {string} after New shader text.
 * @param {("wgsl"|"glsl")} language Grammar of both texts.
 * @param {string} [relPath] Repo-relative path of the shader. A reader scoped
 *   to some shaders (the OIT parameter-list reader) is skipped only when this
 *   is given and names a shader outside its scope; without it every reader
 *   applies.
 * @returns {Array<{flavour: string, detail: string}>} Problems.
 */
export function shaderReaderProblems(before, after, language, relPath) {
  const oldText = before.replace(/\r\n?/g, "\n");
  const newText = after.replace(/\r\n?/g, "\n");
  const flavour = language === "wgsl" ? "wgsl-runtime" : "glsl-runtime";
  // A reader the model cannot account for could read any comment, so no
  // shader comment edit is certified until it is classified.
  const problems = readerModelGaps().map((gap) => ({
    flavour,
    detail: `the shader text reader model is incomplete: ${gap}`,
  }));
  for (const reader of shaderTextReaders()) {
    const viewLanguage = VIEW_LANGUAGE[reader.view] ?? reader.language;
    if (
      reader.use === "exempt" ||
      (viewLanguage !== undefined && viewLanguage !== language) ||
      !readerAppliesToPath(reader, relPath)
    ) {
      continue;
    }
    const oldElements = readerElements(
      reader,
      readerView(reader.view, oldText),
      language,
    );
    const newElements = readerElements(
      reader,
      readerView(reader.view, newText),
      language,
    );
    const where = reader.wheres[0];
    if (oldElements.length !== newElements.length) {
      problems.push({
        flavour,
        detail: `the shader text reader ${reader.key} (${where}) matches ${oldElements.length} time(s) in the old text and ${newElements.length} in the new`,
      });
      continue;
    }
    const at = oldElements.findIndex(
      (element, index) => element !== newElements[index],
    );
    if (at >= 0) {
      problems.push({
        flavour,
        detail: `the shader text reader ${reader.key} (${where}) reads different text at match ${at + 1}: ${quoteElement(oldElements[at])} -> ${quoteElement(newElements[at])}`,
      });
    }
  }
  return problems;
}

/**
 * Where `Tools/lint-debug-pragmas.mjs` answers the old and the new text
 * differently. The lint is imported, not modelled, so the comparison is exact
 * for every shape it reads: the allow marker's position, console calls named
 * in trailing comments, and pragma text in prose.
 *
 * @param {string} before Old text.
 * @param {string} after New text.
 * @param {string} relPath Repo-relative path.
 * @returns {Array<{flavour: string, detail: string}>} Problems.
 */
export function lintReaderProblems(before, after, relPath) {
  const unmatched = findOffenders(before, relPath).map((o) => o.text);
  const added = findOffenders(after, relPath).filter((offender) => {
    const at = unmatched.indexOf(offender.text);
    if (at < 0) {
      return true;
    }
    unmatched.splice(at, 1);
    return false;
  });
  const problems = added.map((offender) => ({
    flavour: "lint-debug-pragmas",
    detail: `the debug-pragma lint reports a console call it did not before, at line ${offender.line}: ${offender.text}`,
  }));
  for (const text of unmatched) {
    problems.push({
      flavour: "lint-debug-pragmas",
      detail: `the debug-pragma lint no longer reports a console call it reported before: ${text}`,
    });
  }
  return problems;
}

/**
 * Whether a comment binds the line after it.
 *
 * @param {string} text Comment text including its delimiters.
 * @returns {boolean} True for `eslint-disable-next-line`, `@ts-expect-error`,
 *   `@ts-ignore` and `lint-debug-pragmas-allow`.
 */
function bindsNextLine(text) {
  const id = classifySemanticComment(text);
  if (id === "eslint-toggle") {
    return /eslint-disable-next-line\b/.test(text);
  }
  if (
    id === "typescript-directive" ||
    id === "typescript-directive-last-line"
  ) {
    return /@ts-(?:expect-error|ignore)/.test(text);
  }
  return id === "lint-debug-pragmas-allow";
}

/**
 * For each next-line directive, in order, the lines between it and the next
 * line that holds code: `b` for a blank line, `s` for a line that opens with
 * `//`, `c` for any other comment line, and `$` when the file ends first.
 * TypeScript's look-back from an error to its suppression skips blank lines
 * and lines that open with `//`, and stops at any other line, so `s` and `c`
 * bind differently. Lines are split on every JavaScript line terminator, as
 * ESLint and TypeScript split them.
 *
 * @param {string} source JS or TS text.
 * @returns {string[]} One descriptor per directive.
 */
export function nextLineBindings(source) {
  const text = source.replace(/\r\n?/g, "\n");
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" || text[i] === "\u2028" || text[i] === "\u2029") {
      starts.push(i + 1);
    }
  }
  const lineCount = starts.length;
  const hasCode = new Array(lineCount + 1).fill(false);
  const hasComment = new Array(lineCount + 1).fill(false);
  const directives = [];
  for (const segment of tokenize(text, "js")) {
    const first = lineOf(starts, segment.start);
    const last = lineOf(starts, Math.max(segment.start, segment.end - 1));
    if (segment.kind === "comment") {
      for (let line = first; line <= last; line++) {
        hasComment[line] = true;
      }
      if (bindsNextLine(text.slice(segment.start, segment.end))) {
        directives.push(last);
      }
      continue;
    }
    if (segment.kind === "string") {
      for (let line = first; line <= last; line++) {
        hasCode[line] = true;
      }
      continue;
    }
    for (let offset = segment.start; offset < segment.end; offset++) {
      if (!/\s/.test(text[offset])) {
        hasCode[lineOf(starts, offset)] = true;
      }
    }
  }
  return directives.map((line) => {
    let descriptor = "";
    let next = line + 1;
    while (next <= lineCount && !hasCode[next]) {
      const lineEnd = next < lineCount ? starts[next] - 1 : text.length;
      const opensWithSlashes = text
        .slice(starts[next - 1], lineEnd)
        .trim()
        .startsWith("//");
      descriptor += !hasComment[next] ? "b" : opensWithSlashes ? "s" : "c";
      next += 1;
    }
    return next > lineCount ? `${descriptor}$` : descriptor;
  });
}

/**
 * Where a next-line directive binds differently in the old and the new text.
 *
 * @param {string} before Old JS or TS text.
 * @param {string} after New JS or TS text.
 * @returns {Array<{flavour: string, detail: string}>} Problems.
 */
export function nextLineBindingProblems(before, after) {
  const oldBindings = nextLineBindings(before);
  const newBindings = nextLineBindings(after);
  if (oldBindings.join("|") === newBindings.join("|")) {
    return [];
  }
  return [
    {
      flavour: "next-line-directive",
      detail: `a directive that binds the next line is followed by different blank or comment lines: [${oldBindings.join(", ")}] -> [${newBindings.join(", ")}]`,
    },
  ];
}

/**
 * The flavour a path is built in, or null when no comment-reading transform
 * applies to it.
 *
 * @param {string} relPath Repo-relative path.
 * @returns {("release-pragma"|"wgsl-minify"|"glsl-runtime"|null)} Flavour.
 */
export function flavourForPath(relPath) {
  const lower = String(relPath).toLowerCase();
  if (lower.endsWith(".wgsl")) {
    return "wgsl-minify";
  }
  if (lower.endsWith(".glsl")) {
    return "glsl-runtime";
  }
  if (RELEASE_PRAGMA_FILTER.test(lower)) {
    return "release-pragma";
  }
  return null;
}

/**
 * Every way one text disagrees with its flavour's transform.
 *
 * @param {string} source File text.
 * @param {string} relPath Repo-relative path, used to pick the flavour.
 * @returns {Array<{flavour: string, detail: string}>} Problems; empty when the
 *   flavour's output is exactly what the tokenizer says the source is.
 */
export function flavourProblems(source, relPath) {
  const flavour = flavourForPath(relPath);
  if (flavour === "wgsl-minify" || flavour === "glsl-runtime") {
    const cut = shaderReleaseProblems(source, flavour);
    if (cut.length > 0) {
      return cut;
    }
  }
  if (flavour === "release-pragma") {
    return prosePragmaAnchors(source).map((anchor) => ({
      flavour,
      detail: `line ${anchor.line}: the release strip region ${anchor.anchor}s on pragma text that is not a line-opening //>> comment: ${anchor.text}`,
    }));
  }
  if (flavour === "wgsl-minify") {
    const viaSource = canonicalizeCode(source, "wgsl");
    const viaStrip = canonicalizeCode(stripWgslComments(source), "wgsl");
    if (viaSource === viaStrip) {
      return [];
    }
    const nested = nestedWgslBlockComments(source);
    return [
      {
        flavour,
        detail:
          `the minify-time WGSL comment strip disagrees with the source at canonical line ${firstDifferenceLine(viaSource, viaStrip)}` +
          (nested.length > 0
            ? `; nested block comment(s) at line(s) ${nested.join(", ")}`
            : ""),
      },
    ];
  }
  if (flavour === "glsl-runtime") {
    let view;
    try {
      view = removeComments(source.replace(/\r\n?/g, "\n"));
    } catch (error) {
      return [
        {
          flavour,
          detail: `the runtime GLSL comment strip throws: ${error?.message ?? String(error)}`,
        },
      ];
    }
    const code = canonicalizeCode(source, "glsl", { keepSemantic: false });
    const viaStrip = canonicalizeCode(view, "glsl", { keepSemantic: false });
    const problems = [];
    if (code !== viaStrip) {
      problems.push({
        flavour,
        detail: `the runtime GLSL comment strip leaves different code at canonical line ${firstDifferenceLine(code, viaStrip)}`,
      });
    }
    const inCode = czmTokens(code);
    const inView = czmTokens(view);
    const gained = inView.filter((name) => !inCode.includes(name));
    const lost = inCode.filter((name) => !inView.includes(name));
    if (gained.length > 0 || lost.length > 0) {
      problems.push({
        flavour,
        detail: `the runtime GLSL czm_ dependency harvest differs from the code: gained [${gained.join(", ")}], lost [${lost.join(", ")}]`,
      });
    }
    const viaMinify = canonicalizeCode(glslMinifyView(source), "glsl", {
      keepSemantic: false,
    });
    if (code !== viaMinify) {
      problems.push({
        flavour: "glsl-minify",
        detail: `the minify-time GLSL comment strip leaves different code at canonical line ${firstDifferenceLine(code, viaMinify)}`,
      });
    }
    return problems;
  }
  return [];
}

/**
 * The GLSL text a `--minify` build writes into a shader module: the build
 * strips comments with `glsl-strip-comments`, whose tokenizer continues a
 * `//` comment past a trailing backslash, closes a block comment at `/*` +
 * `/`, reads a comment opener on a `#` line as part of the directive, and
 * joins the tokens on either side of a comment; then it trims every line and
 * drops blank ones (`glslToJavaScript`, `scripts/build.js`).
 *
 * @param {string} source GLSL source.
 * @returns {string} The minified module's shader text.
 */
export function glslMinifyView(source) {
  return `${glslStripComments(source.replace(/\r\n/gm, "\n"))
    .replace(/\s+$/gm, "")
    .replace(/^\s+/gm, "")
    .replace(/\n+/gm, "\n")}\n`;
}

/**
 * Where the comment text a `--minify` build leaves in a GLSL module differs
 * between the old and the new text. The build's tokenizer keeps a comment
 * that follows a `#` directive on its line (`#endif // unlit`), and the
 * runtime readers then read that text as they read any comment, so an edit
 * to such a comment, or one that adds or removes one, is refused.
 *
 * @param {string} before Old GLSL text.
 * @param {string} after New GLSL text.
 * @returns {Array<{flavour: string, detail: string}>} Problems.
 */
export function glslMinifyCommentProblems(before, after) {
  const kept = (text) =>
    extractComments(glslMinifyView(text), "glsl").map(
      (comment) => comment.text,
    );
  const oldKept = kept(before);
  const newKept = kept(after);
  if (oldKept.join("\n") === newKept.join("\n")) {
    return [];
  }
  return [
    {
      flavour: "glsl-minify",
      detail:
        `the minify-time GLSL comment strip keeps different comment text in the module: ${JSON.stringify(oldKept)} -> ${JSON.stringify(newKept)}`.slice(
          0,
          400,
        ),
    },
  ];
}

/**
 * The flavour half of a comment-only comparison.
 *
 * @param {string} before Old text.
 * @param {string} after New text.
 * @param {string} relPath Repo-relative path.
 * @returns {{status: string, flavour: string, detail: string}|null} A
 *   `flavour-differs` result, or null when every flavour agrees.
 */
export function compareFlavours(before, after, relPath) {
  const problems = flavourProblems(after, relPath);
  if (problems.length > 0) {
    return {
      status: "flavour-differs",
      flavour: problems[0].flavour,
      detail: problems.map((problem) => problem.detail).join("; "),
    };
  }
  const pairedFlavour = flavourForPath(relPath);
  const paired = [];
  if (pairedFlavour === "release-pragma") {
    paired.push(...lintReaderProblems(before, after, relPath));
    paired.push(...nextLineBindingProblems(before, after));
  }
  if (pairedFlavour === "wgsl-minify") {
    paired.push(...shaderReaderProblems(before, after, "wgsl", relPath));
  }
  if (pairedFlavour === "glsl-runtime") {
    paired.push(...glslMinifyCommentProblems(before, after));
    paired.push(...shaderReaderProblems(before, after, "glsl"));
  }
  if (paired.length > 0) {
    return {
      status: "flavour-differs",
      flavour: paired[0].flavour,
      detail: paired.map((problem) => problem.detail).join("; "),
    };
  }
  if (flavourForPath(relPath) === "release-pragma") {
    const releaseBefore = canonicalizeCode(releasePragmaView(before), "js");
    const releaseAfter = canonicalizeCode(releasePragmaView(after), "js");
    if (releaseBefore !== releaseAfter) {
      return {
        status: "flavour-differs",
        flavour: "release-pragma",
        detail: `the release-stripped text differs at canonical line ${firstDifferenceLine(releaseBefore, releaseAfter)}`,
      };
    }
  }
  return null;
}
