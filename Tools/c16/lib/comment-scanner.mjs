// comment-scanner.mjs — the one tokenizer both Campaign 16 tools share.
// @purpose The one tokenizer both C16 instruments share (JS/TS/WGSL/GLSL comment vs code vs string), fail-closed, with semantic-comment retention rules.
// @status ACTIVE
//
// WHY ONE TOKENIZER. The comment standard is enforced by two instruments that
// must agree on what a comment IS: the marker guard (which reads comment text
// and must never read a string literal as a comment) and the comment-only-diff
// verifier (which strips comments and must never drop a byte of code). If the
// two disagreed, a rewrite could pass the verifier while the guard still saw a
// marker, or — far worse — a code edit could hide inside a region one tool
// classified as a comment and the other did not. They share this module so
// that class of disagreement cannot exist.
//
// FAIL-CLOSED DIRECTION. Where a construct is genuinely ambiguous the scanner
// prefers the reading that produces a LOUD failure over the one that produces
// a silent pass:
//   - An unterminated block comment ends at end-of-file rather than being
//     re-read as code.
//   - A backslash at the end of a `//` line in GLSL does NOT continue the
//     comment onto the next line. C's preprocessor says it does; honouring it
//     would let the scanner swallow a real code line as comment text, and a
//     swallowed code line is exactly what the verifier exists to catch. The
//     cost of not honouring it is a false verifier failure, which a human
//     sees; the cost of honouring it is a masked code change, which nobody
//     sees.
//   - Strings and regular-expression literals are emitted VERBATIM, never
//     whitespace-normalised, so any byte change inside one is still visible to
//     the verifier even if the scanner misjudged where the literal began.
//
// SEMANTIC COMMENTS ARE CODE. Some comments change what the build produces:
// Cesium's `//>>includeStart('debug', pragmas.debug)` pragmas, the WGSL
// `//>>ifdef` preprocessor directives, ESLint/TypeScript/Prettier directives,
// and `/*!` license banners. Deleting one of those is a behavioural or legal
// change wearing a comment's clothes. The canonical form therefore RETAINS
// them, so "I only touched comments" cannot be used to drop a debug pragma or
// an attribution banner.
//
// ...WHICH MAKES "WHAT COUNTS AS A DIRECTIVE" A LOAD-BEARING QUESTION IN BOTH
// DIRECTIONS. Retaining a directive protects it, and protection is the same
// thing as immobility: a comment the canonical form keeps cannot be reworded,
// because rewording it reports as a code change. Classifying by leading word
// alone therefore freezes ordinary prose. `// global barrier pass.` is the
// tail of a wrapped sentence, not an ESLint globals declaration, and the same
// goes for a line that happens to wrap onto `// !translucent\` is false (...`.
// Both read as directives under a bare `/^globals?\b/` or `/^!/` test, and
// both then become permanently un-editable — which is how a rewrite worker
// meets this file: not as a false alarm they can dismiss, but as a sentence
// they are forbidden to finish.
//
// Classification is therefore by SHAPE as well as by token: each rule below
// declares the comment forms the owning tool actually honours, and the ones
// whose leading token is an English word are recognised only in the form that
// tool reads. ESLint reads `/* global A, B */` and `/* globals A, B */` as
// block comments only — `// global ...` is prose to ESLint, so it is prose
// here. The `/*!` banner convention is likewise a property of the opening
// delimiter, not of the first body character, so the rule matches the raw
// text. `eslint` is narrowed to its closed directive vocabulary
// (`eslint-disable` / `-enable` / `-env`, plus block-form inline rule
// config), so a sentence that merely begins by naming the linter stays
// editable while `// eslint-disable-next-line no-console` — which ESLint
// really does obey in line form — stays protected.
//
// Every rule carries its own examples and counter-examples, and
// `selfTestSemanticRules` runs them. A rule table that stopped matching its
// own directives would quietly unprotect them while still reporting a green
// gate, so callers check it before they trust a comparison.

/** Extensions this scanner is willing to reason about, mapped to a grammar. */
const EXTENSION_LANGUAGE = new Map([
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".ts", "js"],
  [".wgsl", "wgsl"],
  [".glsl", "glsl"],
  [".vert", "glsl"],
  [".frag", "glsl"],
]);

/** Every extension `languageForPath` will resolve. */
export const SUPPORTED_EXTENSIONS = Object.freeze([
  ...EXTENSION_LANGUAGE.keys(),
]);

/**
 * Line terminators recognised when collapsing whitespace. U+2028 and U+2029
 * are line terminators in JavaScript, so a run containing one must collapse
 * the same way a run containing `\n` does.
 */
const LINE_BREAK_CHARS = Object.freeze(["\n", "\r", "\u2028", "\u2029"]);

/**
 * Comments whose presence changes build output, tool behaviour, or legal
 * notice. The canonical form keeps these, so removing one is a code change —
 * and, as the header says, so is rewording one.
 *
 * Each rule declares:
 *   - `id`       a stable name, reported by `classifySemanticComment`;
 *   - `shape`    `"line"` for `//`, `"block"` for `/* *\/`, `"any"` for both.
 *                This is the field that keeps prose editable: it is set to
 *                the form the owning tool actually reads, so a directive word
 *                appearing in the OTHER form is treated as the ordinary
 *                English it almost always is;
 *   - `body`     tested against the comment body (delimiters, JSDoc asterisks
 *                and surrounding whitespace removed), or
 *   - `raw`      tested against the untouched comment text, for conventions
 *                that live in the delimiter itself;
 *   - `examples` / `counterExamples`  the rule's own negative control, run by
 *                `selfTestSemanticRules`. Counter-examples are drawn from real
 *                comments in this repository wherever one exists.
 *
 * Order matters only for the reported id: the first matching rule names the
 * result, and every example below is written to match exactly one rule.
 */
export const SEMANTIC_COMMENT_RULES = Object.freeze([
  {
    // Cesium's debug-strip pragmas and the fork's WGSL preprocessor. `>>`
    // cannot begin an English sentence, so no shape restriction is needed.
    id: "build-pragma",
    shape: "any",
    body: /^>>/,
    examples: [
      "//>>includeStart('debug', pragmas.debug);",
      '//>>includeEnd("debug");',
      "//>>ifdef LOG_DEPTH",
      "//>>else",
      "//>>endif",
    ],
    counterExamples: [],
  },
  {
    // ESLint honours these in line form as well as block form, so both are
    // protected. The vocabulary is closed, which is what separates the
    // directive from a sentence that merely names the linter.
    id: "eslint-toggle",
    shape: "any",
    body: /^eslint-(disable|enable|env)\b/,
    examples: [
      "// eslint-disable-next-line no-console",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "// eslint-disable-line",
      "//eslint-disable-next-line no-self-assign",
      "/* eslint-disable new-cap */",
      "/*eslint-disable guard-for-in*/",
      "/*eslint-enable guard-for-in*/",
      "/* eslint-disable-next-line prefer-const */",
    ],
    counterExamples: [
      "// eslint has no WGSL or GLSL grammar, so the guard is a Node script.",
      "// eslint-style rule ids key the banned-vocabulary table.",
    ],
  },
  {
    // Inline rule configuration — `/* eslint quotes: ["error", "double"] */`.
    // ESLint reads this in block form only.
    id: "eslint-inline-config",
    shape: "block",
    body: /^eslint\s+[\w@$/-]+\s*:/,
    examples: ['/* eslint quotes: ["error", "double"] */'],
    counterExamples: [
      '// eslint quotes: ["error", "double"] is set in the root config.',
    ],
  },
  {
    // `/* global A, B */`, `/* globals A, B */`, `/* exported name */`. ESLint
    // reads all three in block form ONLY; the line form is prose, and prose
    // beginning with the word "global" is common enough in this repository
    // that the counter-examples below are quoted from it verbatim.
    id: "eslint-globals",
    shape: "block",
    body: /^(globals?|exported)\b/,
    examples: [
      "/* global CESIUM_VERSION */",
      "/*global CESIUM_BASE_URL,define,require*/",
      "/* globals window, document */",
      "/* exported handler */",
    ],
    counterExamples: [
      "// global-scale views and is what the ground-primitive vertex shader",
      "// global field this is the identity, so the expression below is still the",
      "// global barrier pass.",
    ],
  },
  {
    // Pre-ESLint linter configuration. Both tools read block comments only.
    id: "legacy-linter-config",
    shape: "block",
    body: /^(jshint|jslint)\b/,
    examples: ["/*jshint esversion: 6 */", "/* jslint node: true */"],
    counterExamples: ["// jshint and jslint were retired upstream long ago."],
  },
  {
    // Prettier's suppression is the WHOLE comment in every form it takes, so
    // this rule can require exactly that and leave every sentence about the
    // formatter editable.
    id: "prettier-ignore",
    shape: "any",
    body: /^prettier-ignore(-(start|end|attribute))?$/,
    examples: [
      "// prettier-ignore",
      "//prettier-ignore",
      "/* prettier-ignore */",
    ],
    counterExamples: [
      "// prettier-ignore is deliberately absent: the table reflows cleanly.",
    ],
  },
  {
    // TypeScript's four suppression comments. `@ts-expect-error` and
    // `@ts-ignore` carry a free-text explanation after the token, so this is a
    // prefix rule; the closed vocabulary keeps `@ts-`-prefixed prose editable.
    id: "typescript-directive",
    shape: "any",
    body: /^@ts-(check|nocheck|ignore|expect-error)\b/,
    examples: [
      "// @ts-check",
      "// @ts-expect-error Missing types.",
      "// @ts-nocheck",
      "/* @ts-ignore */",
    ],
    counterExamples: [
      "// @ts-migrate annotations from the codemod have all been removed.",
      "// @typescript-eslint rules are configured at the repository root.",
    ],
  },
  {
    // Coverage-tool suppressions. istanbul, c8 and v8 all read both forms.
    id: "coverage-ignore",
    shape: "any",
    body: /^(istanbul|c8|v8)\s+ignore\b/,
    examples: [
      "/* istanbul ignore next */",
      "// c8 ignore next 3",
      "/* v8 ignore start */",
    ],
    counterExamples: [
      "// c8 and v8 spell their suppressions almost, but not quite, alike.",
    ],
  },
  {
    // Attribution that must survive a "comment-only" rewrite. Both tags are
    // JSDoc-shaped and appear in block comments; minifiers read them there.
    id: "license-tag",
    shape: "block",
    body: /^@(license|preserve)\b/,
    examples: [
      "/**\n * @license\n * Copyright (c) 2014 Some Author\n */",
      "/* @preserve build banner */",
    ],
    counterExamples: [
      "// @license and @preserve are the two tags minifiers honour.",
    ],
  },
  {
    // The `/*!` banner convention. It is a property of the OPENING DELIMITER,
    // so the rule reads the raw text: a body that merely starts with `!` is
    // almost always a negated expression quoted in prose, and three of the
    // counter-examples below are exactly that, quoted from this repository.
    id: "license-banner",
    shape: "block",
    raw: /^\/\*+!/,
    examples: ["/*! Copyright (c) 2008 Some Author. MIT licensed. */"],
    counterExamples: [
      "// !gl_FrontFacing doesn't work as expected on Mac/Intel so use the more verbose form instead.",
      "// !translucent` is false (GlobeSurfaceTileProviderRendering.js:1395-1396,",
      "// !exitFromInside && !enterFromOutside",
    ],
  },
]);

/**
 * The grammar to apply to a file, or `null` when the scanner refuses it.
 *
 * `.tsx` is deliberately absent: JSX text can contain a bare `//` that is
 * neither a comment nor a string, and no engine or widgets source file is
 * `.tsx`. Returning `null` makes callers fail loudly rather than mis-scan.
 *
 * @param {string} filePath Any path; only the extension is read.
 * @returns {("js"|"wgsl"|"glsl"|null)} Grammar name, or null when unsupported.
 */
export function languageForPath(filePath) {
  const normalized = String(filePath).split(/[\\/]/).pop() ?? "";
  const dot = normalized.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return EXTENSION_LANGUAGE.get(normalized.slice(dot).toLowerCase()) ?? null;
}

/**
 * A comment's text with its delimiters, JSDoc asterisks and surrounding
 * whitespace removed.
 *
 * @param {string} rawText Comment text including its delimiters.
 * @returns {string} The body a `body` rule is matched against.
 */
function commentBody(rawText) {
  return rawText
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .replace(/^\/\//, "")
    .replace(/^[\s*]+/, "")
    .replace(/\s+$/, "");
}

/**
 * Which semantic rule a comment matches, if any.
 *
 * The comment's SHAPE is read from its opening delimiter and checked against
 * the rule's declared shape before the pattern runs. That check is the whole
 * fix for prose misclassification: `/* global A *\/` is an ESLint declaration
 * and `// global barrier pass.` is the end of a wrapped sentence, and nothing
 * about their leading words tells them apart — only the form does.
 *
 * @param {string} rawText Comment text including its delimiters.
 * @returns {string|null} The matching rule's id, or null when the comment is
 *   ordinary prose.
 */
export function classifySemanticComment(rawText) {
  const raw = String(rawText);
  const shape = raw.startsWith("/*") ? "block" : "line";
  const body = commentBody(raw);
  for (const rule of SEMANTIC_COMMENT_RULES) {
    if (rule.shape !== "any" && rule.shape !== shape) {
      continue;
    }
    if (rule.raw !== undefined) {
      if (rule.raw.test(raw)) {
        return rule.id;
      }
      continue;
    }
    if (rule.body.test(body)) {
      return rule.id;
    }
  }
  return null;
}

/**
 * Whether a comment carries build, tool, or legal meaning.
 *
 * @param {string} rawText Comment text including its delimiters.
 * @returns {boolean} True when the comment must survive canonicalization.
 */
export function isSemanticComment(rawText) {
  return classifySemanticComment(rawText) !== null;
}

/**
 * Negative control for the rule table.
 *
 * A rule that stopped matching its own directives would unprotect them while
 * the gate still reported green — the exact failure a comment-only claim is
 * supposed to be unable to hide behind. A rule that started matching its own
 * counter-examples would re-freeze the prose this table exists to release.
 * Callers run this before trusting a comparison.
 *
 * @returns {string[]} One message per broken expectation; empty when healthy.
 */
export function selfTestSemanticRules() {
  const broken = [];
  for (const rule of SEMANTIC_COMMENT_RULES) {
    for (const example of rule.examples) {
      const got = classifySemanticComment(example);
      if (got !== rule.id) {
        broken.push(
          `${rule.id}: directive classified as ${got ?? "prose"} — ${JSON.stringify(example)}`,
        );
      }
    }
    for (const counter of rule.counterExamples) {
      const got = classifySemanticComment(counter);
      if (got !== null) {
        broken.push(
          `${rule.id}: prose classified as ${got} — ${JSON.stringify(counter)}`,
        );
      }
    }
  }
  return broken;
}

/** Characters after which a `/` starts a regular-expression literal. */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "\n",
]);

/** Keywords after which a `/` starts a regular-expression literal. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Whether the `/` at `index` opens a regex rather than a division.
 *
 * The heuristic is the conventional one (previous significant token). It can
 * be fooled, but only in the safe direction: literals are emitted verbatim, so
 * a misclassified span still compares byte-for-byte.
 *
 * @param {string} source Full source text.
 * @param {number} index Offset of the `/`.
 * @returns {boolean} True when a regex literal starts here.
 */
function regexAllowedAt(source, index) {
  let i = index - 1;
  while (i >= 0 && /[ \t\r]/.test(source[i])) {
    i -= 1;
  }
  if (i < 0) {
    return true;
  }
  const previous = source[i];
  if (REGEX_PRECEDING_PUNCTUATION.has(previous)) {
    return true;
  }
  if (/[\w$]/.test(previous)) {
    let start = i;
    while (start >= 0 && /[\w$]/.test(source[start])) {
      start -= 1;
    }
    return REGEX_PRECEDING_KEYWORDS.has(source.slice(start + 1, i + 1));
  }
  return false;
}

/**
 * Split `source` into non-overlapping, gap-free segments.
 *
 * Every byte of the input belongs to exactly one segment, so callers can
 * reassemble the file from the segment list. Segment kinds are `"code"`,
 * `"string"` (string, template, and regex literals) and `"comment"`.
 *
 * @param {string} source File text.
 * @param {("js"|"wgsl"|"glsl")} language Grammar to apply.
 * @returns {Array<{kind: string, start: number, end: number, block?: boolean}>} Segments.
 */
export function tokenize(source, language) {
  if (language === "js") {
    return tokenizeJs(source);
  }
  if (language === "wgsl" || language === "glsl") {
    return tokenizeShader(source, language === "wgsl");
  }
  throw new Error(`comment-scanner: unsupported language "${language}"`);
}

/**
 * Tokenize JavaScript / TypeScript, including template literals whose `${}`
 * substitutions contain arbitrary code.
 *
 * @param {string} source File text.
 * @returns {Array<{kind: string, start: number, end: number, block?: boolean}>} Segments.
 */
function tokenizeJs(source) {
  const segments = [];
  const n = source.length;
  let i = 0;
  let codeStart = 0;
  // Nesting of template literals and the `${ }` substitutions inside them.
  // `braceDepth` counts plain `{` seen since the substitution opened, so the
  // `}` that closes the substitution can be told apart from ordinary blocks.
  const templateStack = [];
  let braceDepth = 0;
  let guard = 0;
  const limit = n + 1;

  const flushCode = (end) => {
    if (end > codeStart) {
      segments.push({ kind: "code", start: codeStart, end });
    }
  };

  while (i < n && guard++ < limit) {
    const c = source[i];
    const d = source[i + 1];

    if (c === "/" && d === "/") {
      flushCode(i);
      let j = i + 2;
      while (j < n && source[j] !== "\n") {
        j += 1;
      }
      segments.push({ kind: "comment", start: i, end: j, block: false });
      i = j;
      codeStart = i;
      continue;
    }

    if (c === "/" && d === "*") {
      flushCode(i);
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) {
        j += 1;
      }
      const end = j >= n ? n : j + 2;
      segments.push({ kind: "comment", start: i, end, block: true });
      i = end;
      codeStart = i;
      continue;
    }

    if (c === '"' || c === "'") {
      flushCode(i);
      const end = scanQuoted(source, i, c);
      segments.push({ kind: "string", start: i, end });
      i = end;
      codeStart = i;
      continue;
    }

    if (c === "`") {
      flushCode(i);
      templateStack.push(braceDepth);
      braceDepth = 0;
      const end = scanTemplateChunk(source, i + 1);
      segments.push({ kind: "string", start: i, end });
      i = end;
      codeStart = i;
      // `scanTemplateChunk` stops either after the closing backtick (template
      // finished) or after a `${` (code resumes).
      if (source.slice(end - 2, end) !== "${") {
        braceDepth = templateStack.pop() ?? 0;
      }
      continue;
    }

    if (c === "}" && templateStack.length > 0 && braceDepth === 0) {
      // Closes a `${ }` substitution: the template's raw text resumes.
      flushCode(i);
      const end = scanTemplateChunk(source, i + 1);
      segments.push({ kind: "string", start: i, end });
      i = end;
      codeStart = i;
      if (source.slice(end - 2, end) !== "${") {
        braceDepth = templateStack.pop() ?? 0;
      }
      continue;
    }

    if (c === "{") {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i += 1;
      continue;
    }

    if (c === "/" && regexAllowedAt(source, i)) {
      const end = scanRegex(source, i);
      if (end > i + 1) {
        flushCode(i);
        segments.push({ kind: "string", start: i, end });
        i = end;
        codeStart = i;
        continue;
      }
    }

    i += 1;
  }
  flushCode(n);
  return segments;
}

/**
 * End offset (exclusive) of a `'`/`"` string starting at `start`.
 *
 * @param {string} source File text.
 * @param {number} start Offset of the opening quote.
 * @param {string} quote The quote character.
 * @returns {number} Offset just past the closing quote.
 */
function scanQuoted(source, start, quote) {
  const n = source.length;
  let i = start + 1;
  let guard = 0;
  while (i < n && guard++ < n + 1) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      return i + 1;
    }
    // An unterminated single-line string is a syntax error upstream; ending it
    // at the newline keeps the rest of the file readable instead of swallowing
    // it.
    if (c === "\n") {
      return i;
    }
    i += 1;
  }
  return n;
}

/**
 * End offset (exclusive) of one raw chunk of a template literal: everything up
 * to and including either the closing backtick or the next `${`.
 *
 * @param {string} source File text.
 * @param {number} start Offset just past the opening backtick or `}`.
 * @returns {number} Offset just past the chunk terminator.
 */
function scanTemplateChunk(source, start) {
  const n = source.length;
  let i = start;
  let guard = 0;
  while (i < n && guard++ < n + 1) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      return i + 1;
    }
    if (c === "$" && source[i + 1] === "{") {
      return i + 2;
    }
    i += 1;
  }
  return n;
}

/**
 * End offset (exclusive) of a regex literal starting at `start`, or `start + 1`
 * when the span does not close on the same line (in which case the caller
 * treats the `/` as ordinary code).
 *
 * @param {string} source File text.
 * @param {number} start Offset of the opening `/`.
 * @returns {number} Offset just past the flags, or `start + 1`.
 */
function scanRegex(source, start) {
  const n = source.length;
  let i = start + 1;
  let inClass = false;
  let guard = 0;
  while (i < n && guard++ < n + 1) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") {
      return start + 1;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "]") {
      inClass = false;
    } else if (c === "/" && !inClass) {
      i += 1;
      while (i < n && /[a-z]/i.test(source[i])) {
        i += 1;
      }
      return i;
    }
    i += 1;
  }
  return start + 1;
}

/**
 * Tokenize WGSL or GLSL. Neither language has string literals; WGSL block
 * comments nest, GLSL's do not.
 *
 * @param {string} source File text.
 * @param {boolean} nestingBlockComments True for WGSL.
 * @returns {Array<{kind: string, start: number, end: number, block?: boolean}>} Segments.
 */
function tokenizeShader(source, nestingBlockComments) {
  const segments = [];
  const n = source.length;
  let i = 0;
  let codeStart = 0;
  let guard = 0;

  const flushCode = (end) => {
    if (end > codeStart) {
      segments.push({ kind: "code", start: codeStart, end });
    }
  };

  while (i < n && guard++ < n + 1) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      flushCode(i);
      let j = i + 2;
      while (j < n && source[j] !== "\n") {
        j += 1;
      }
      segments.push({ kind: "comment", start: i, end: j, block: false });
      i = j;
      codeStart = i;
      continue;
    }
    if (c === "/" && d === "*") {
      flushCode(i);
      let depth = 1;
      let j = i + 2;
      let inner = 0;
      while (j < n && depth > 0 && inner++ < n + 1) {
        if (source[j] === "*" && source[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        if (
          nestingBlockComments &&
          source[j] === "/" &&
          source[j + 1] === "*"
        ) {
          depth += 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      const end = Math.min(j, n);
      segments.push({ kind: "comment", start: i, end, block: true });
      i = end;
      codeStart = i;
      continue;
    }
    i += 1;
  }
  flushCode(n);
  return segments;
}

/**
 * Offsets of every line start, for O(log n) offset-to-line lookups.
 *
 * @param {string} source File text.
 * @returns {number[]} Ascending line-start offsets.
 */
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * 1-based line number of `offset`.
 *
 * @param {number[]} starts Result of `lineStarts`.
 * @param {number} offset Character offset.
 * @returns {number} Line number, 1-based.
 */
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

/**
 * Every comment in `source`, with position, text and semantic classification.
 *
 * @param {string} source File text.
 * @param {("js"|"wgsl"|"glsl")} language Grammar to apply.
 * @returns {Array<{start: number, end: number, line: number, endLine: number, text: string, block: boolean, semantic: boolean}>} Comments in source order.
 */
export function extractComments(source, language) {
  const starts = lineStarts(source);
  return tokenize(source, language)
    .filter((segment) => segment.kind === "comment")
    .map((segment) => {
      const text = source.slice(segment.start, segment.end);
      return {
        start: segment.start,
        end: segment.end,
        line: lineOf(starts, segment.start),
        endLine: lineOf(starts, Math.max(segment.start, segment.end - 1)),
        text,
        block: segment.block === true,
        semantic: isSemanticComment(text),
      };
    });
}

/**
 * The comparison form used by the comment-only-diff verifier.
 *
 * Construction, and why each rule is what it is:
 *   - Non-semantic comments are replaced by a single space. A space, not
 *     nothing: a block comment sitting between two identifiers must not let
 *     them merge into one token, which would make a genuine change invisible.
 *   - Semantic comments (build pragmas, tool directives, license banners) are
 *     kept, so deleting one is reported as a code change.
 *   - String, template and regex literals are copied VERBATIM — never
 *     whitespace-normalised — so a byte changed inside a shader string or a
 *     user-visible message is always caught.
 *   - Every other whitespace run collapses to a single `\n` if it contained a
 *     line break, otherwise to a single space. Collapsing to `\n` rather than
 *     to a space is deliberate: it absorbs the blank lines left behind when a
 *     six-line comment becomes a two-line one, while still distinguishing
 *     `return\nx` from `return x`, which differ under automatic semicolon
 *     insertion.
 *   - CRLF and LF therefore compare equal, which matters because the working
 *     tree is CRLF and git blobs are LF.
 *
 * That last rule needs one more step to actually hold. Whitespace collapsing
 * reaches only the code between literals, so a multi-line template literal —
 * an embedded WGSL shader, say — is compared byte for byte, and its interior
 * newlines are CRLF on the working-tree side and LF on the git-blob side. Any
 * file carrying one would fail the verifier on line endings alone, whatever
 * its author changed. Line terminators are therefore normalised across the
 * whole input before tokenizing. Nothing is lost by it: git stores blobs with
 * LF under this repository's `text=auto`, so a line-ending difference inside a
 * literal is not a change the repository can even represent, and every other
 * byte of every literal is still compared exactly.
 *
 * @param {string} source File text.
 * @param {("js"|"wgsl"|"glsl")} language Grammar to apply.
 * @returns {string} Canonical code-only form.
 */
export function canonicalizeCode(rawSource, language) {
  const source = rawSource.replace(/\r\n?/g, "\n");
  const segments = tokenize(source, language);
  const pieces = [];
  for (const segment of segments) {
    const raw = source.slice(segment.start, segment.end);
    if (segment.kind === "string") {
      pieces.push({ verbatim: true, text: raw });
      continue;
    }
    if (segment.kind === "comment") {
      if (isSemanticComment(raw)) {
        pieces.push({ verbatim: false, text: raw });
      } else {
        pieces.push({ verbatim: false, text: " " });
      }
      continue;
    }
    pieces.push({ verbatim: false, text: raw });
  }

  // Collapse whitespace across piece boundaries: a run that straddles a
  // dropped comment must collapse as one run, or `foo();\n// c\nbar();` and
  // `foo();\nbar();` would not agree.
  let out = "";
  let pendingWhitespace = "";
  const flushWhitespace = () => {
    if (pendingWhitespace === "") {
      return;
    }
    out += LINE_BREAK_CHARS.some((ch) => pendingWhitespace.includes(ch))
      ? "\n"
      : " ";
    pendingWhitespace = "";
  };

  for (const piece of pieces) {
    if (piece.verbatim) {
      flushWhitespace();
      out += piece.text;
      continue;
    }
    for (const ch of piece.text) {
      if (/\s/.test(ch)) {
        pendingWhitespace += ch;
      } else {
        flushWhitespace();
        out += ch;
      }
    }
  }
  return out.replace(/^\s+/, "").replace(/\s+$/, "");
}
