// comment-scanner.mjs — the one tokenizer both Campaign 16 tools share.
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
 * notice. The canonical form keeps these, so removing one is a code change.
 *
 * Matched against the comment text with leading `/`, `*` and whitespace
 * already stripped.
 */
const SEMANTIC_COMMENT_PATTERNS = Object.freeze([
  // Cesium build pragmas + the fork's WGSL `//>>ifdef` preprocessor.
  /^>>/,
  // Linter / formatter / type-checker directives.
  /^eslint\b/,
  /^eslint-/,
  /^globals?\b/,
  /^prettier-ignore\b/,
  /^@ts-/,
  /^istanbul\s+ignore\b/,
  /^c8\s+ignore\b/,
  /^v8\s+ignore\b/,
  /^jshint\b/,
  /^jslint\b/,
  // Attribution that must survive a "comment-only" rewrite.
  /^@license\b/,
  /^@preserve\b/,
  /^!/,
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
 * Whether a comment carries build, tool, or legal meaning.
 *
 * @param {string} rawText Comment text including its delimiters.
 * @returns {boolean} True when the comment must survive canonicalization.
 */
export function isSemanticComment(rawText) {
  const body = rawText
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .replace(/^\/\//, "")
    .replace(/^[\s*]+/, "");
  const head = body.slice(0, 64);
  return SEMANTIC_COMMENT_PATTERNS.some((pattern) => pattern.test(head));
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
 * @param {string} source File text.
 * @param {("js"|"wgsl"|"glsl")} language Grammar to apply.
 * @returns {string} Canonical code-only form.
 */
export function canonicalizeCode(source, language) {
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
