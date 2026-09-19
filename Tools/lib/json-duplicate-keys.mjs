// json-duplicate-keys.mjs — object keys repeated inside one JSON object, with both line numbers.
//
// @purpose Reports every key a JSON document repeats within the same object, per object and string-aware, so a manifest whose duplicate `JSON.parse` silently resolves last-key-wins can be refused with the first and the repeating line.
// @status ACTIVE

//
// WHY THIS EXISTS. `JSON.parse` keeps the LAST of two identical keys and says
// nothing, so a manifest can name one npm script twice and every reader — npm,
// the spec-runner census, a gate — agrees on the second one. Two lanes landing
// in the same wave each ADDED a `test-s5` key on a different line; `git apply
// --3way` merged two additions with no textual conflict, and the family runner
// that named ten specs was shadowed by a one-spec entry that ran green. The
// spec that exists to catch exactly that (`s5-runner-home.spec.mjs`) was red at
// the tip and nobody saw it, because its own runner home was the shadowed key.
//
// Nothing in the toolchain reads a JSON document as TEXT, so nothing could see
// the first key at all. This module is that reader.
//
// WHY A TOKENIZER AND NOT A REGEX OVER LINES. A line regex cannot tell a key
// from the same characters sitting inside a string VALUE, and this repository's
// manifest is full of long string values that contain quotes, colons, commas
// and braces — every `node --test …` runner line is one. It also cannot tell
// two objects apart: `"name"` appearing once in each of five workspace objects
// is correct JSON, not a duplicate. So the scan tracks keys PER OPEN OBJECT and
// consumes a string's body as an opaque unit, escapes included.
//
// WHAT IT IS NOT. Not a validator and not a parser: malformed input yields
// whatever the scan saw rather than a syntax error, because the caller's own
// `JSON.parse` is the authority on wellformedness and runs anyway. This answers
// one question — which keys repeat, and where.
//
// @module Tools/lib/json-duplicate-keys

/**
 * A key that appears more than once in the same JSON object.
 *
 * @typedef {object} DuplicateKey
 * @property {string} key The decoded key text, as `JSON.parse` would see it.
 * @property {number} firstLine 1-based line of the occurrence that is shadowed.
 * @property {number} line 1-based line of the occurrence that wins.
 * @property {string} path Path to the containing object plus the key, e.g. `scripts.test-s5` or `workspaces[1].name`.
 */

/** Single-character escapes JSON defines, decoded so two spellings of one key compare equal. */
const SIMPLE_ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const FOUR_HEX = /^[0-9a-fA-F]{4}$/u;

/**
 * Renders a path from the segments collected down the container stack.
 *
 * Object steps join with `.`, array steps with `[n]`, so a reader can find the
 * repeat in the file without counting braces.
 *
 * @param {Array<{type: "key"|"index", value: string|number}>} segments
 * @returns {string}
 */
function renderPath(segments) {
  let out = "";
  for (const segment of segments) {
    if (segment.type === "index") {
      out += `[${segment.value}]`;
    } else {
      out += out.length === 0 ? segment.value : `.${segment.value}`;
    }
  }
  return out;
}

/**
 * Finds every object key that repeats inside the object that holds it.
 *
 * The same key in two DIFFERENT objects is correct JSON and is not reported;
 * only a key repeated among its own siblings is. Keys are compared after escape
 * decoding, so `"a\"b"` and `"a"b"` are one key — which is how `JSON.parse`
 * compares them when it decides which one survives.
 *
 * @param {string} text The JSON document, as text. Line endings may be LF or CRLF; a leading BOM is ignored.
 * @returns {DuplicateKey[]} One entry per repeat, in the order the repeats appear. Empty when no object repeats a key.
 * @throws {TypeError} If `text` is not a string — the whole point is to read the bytes, so an already-parsed object is a caller error.
 */
export function findDuplicateKeys(text) {
  if (typeof text !== "string") {
    throw new TypeError(
      "findDuplicateKeys expects the JSON document as a string, not a parsed value",
    );
  }

  /** @type {DuplicateKey[]} */
  const duplicates = [];
  /**
   * One frame per open container. `keys` is a Map for an object and `null` for
   * an array — that null is what keeps array elements from being read as keys.
   *
   * @type {Array<{keys: Map<string, number>|null, key: string|null, index: number, segment: {type: "key"|"index", value: string|number}|null}>}
   */
  const stack = [];

  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // True only where the next string literal would be a key: just inside `{`,
  // and just after a `,` whose innermost container is an object.
  let expectKey = false;

  /**
   * Consumes one string literal, starting at its opening quote, and returns its
   * decoded text. The body is consumed here and nowhere else — that is what
   * keeps a value's quotes, commas and braces from reaching the scanner.
   *
   * @returns {string}
   */
  const readString = () => {
    let out = "";
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return out;
      }
      if (character === "\\") {
        const escape = text[index + 1];
        if (escape === undefined) {
          index += 1;
          return out;
        }
        if (escape === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (FOUR_HEX.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            index += 6;
            continue;
          }
        }
        if (escape === "\n") {
          line += 1;
        }
        out += SIMPLE_ESCAPES.get(escape) ?? escape;
        index += 2;
        continue;
      }
      if (character === "\n") {
        line += 1;
      }
      out += character;
      index += 1;
    }
    return out;
  };

  /**
   * The segment the container about to be opened occupies in its parent.
   *
   * @returns {{type: "key"|"index", value: string|number}|null}
   */
  const segmentForChild = () => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      return null;
    }
    if (parent.keys === null) {
      return { type: "index", value: parent.index };
    }
    return parent.key === null ? null : { type: "key", value: parent.key };
  };

  while (index < text.length) {
    const character = text[index];

    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    if (character === '"') {
      const startedOnLine = line;
      const key = readString();
      const frame = stack[stack.length - 1];
      if (expectKey && frame !== undefined && frame.keys !== null) {
        const firstLine = frame.keys.get(key);
        if (firstLine === undefined) {
          frame.keys.set(key, startedOnLine);
        } else {
          duplicates.push({
            key,
            firstLine,
            line: startedOnLine,
            path: renderPath([
              ...stack
                .map((entry) => entry.segment)
                .filter((segment) => segment !== null),
              { type: "key", value: key },
            ]),
          });
        }
        frame.key = key;
        expectKey = false;
      }
      continue;
    }

    if (character === "{" || character === "[") {
      const isObject = character === "{";
      stack.push({
        keys: isObject ? new Map() : null,
        key: null,
        index: 0,
        segment: segmentForChild(),
      });
      expectKey = isObject;
      index += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      stack.pop();
      expectKey = false;
      index += 1;
      continue;
    }

    if (character === ",") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined && frame.keys === null) {
        frame.index += 1;
      }
      expectKey = frame !== undefined && frame.keys !== null;
      index += 1;
      continue;
    }

    index += 1;
  }

  return duplicates;
}

export default findDuplicateKeys;
