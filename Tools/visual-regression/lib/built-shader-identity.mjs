// @purpose Decides whether a BUILT bundle embeds the shader text currently on disk, so a probe cannot score a stale build as a product verdict.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// A probe measures the bundle the dev server hands the browser, not the source
// tree. Those two drift whenever a shader is edited and the bundle is not
// rebuilt, and the drift is SILENT: the page loads, every gate runs, and the
// numbers describe the old shader.
//
// The existing preflight — "served md5 == disk md5" — cannot see it. That
// assertion proves the server is not caching, i.e. that the bytes on the wire
// are the bytes in `Build/`. It says nothing about whether `Build/` was
// regenerated from the current source, which is the failure that actually
// happens.
//
// Nor can a shader-math spec see it. A spec that evaluates the two width
// functions on the same inputs is a statement about SOURCE text; a stale bundle
// leaves every such spec green because the source is right — only the artifact
// under the browser is wrong. The seam has to be checked where it breaks:
// between the source file and the built artifact.
//
// HOW
// ---
// `gulp build` turns `X.wgsl` into a module whose default export is the shader
// text, and esbuild inlines that into the unminified bundle as a single quoted
// string literal assigned to `<X>_default` (or `<X>_defaultN` when basenames
// collide, in either quote style — see the two functions below). So the bundle
// carries a verbatim, recoverable copy of the shader: locate the literal, decode
// it, and compare it to the file on disk. The comparison is EXACT — a whole-text
// equality, not a sampled one.
//
// Sampling was tried first and is unsound: twelve witness lines spread over a
// 5,900-line shader all landed outside a ~60-line edit, so a genuinely stale
// bundle read as current. Anything short of the whole text can miss the change
// that matters, because the change that matters is usually small.
//
// SCOPE. The UNMINIFIED bundle only. A minified build mangles `<X>_default`
// beyond recovery, and it is the unminified bundle the dev server serves and
// probes load, so that is the artifact worth pinning.

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);

const SIMPLE_ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["0", "\0"],
  [QUOTE, QUOTE],
  ["'", "'"],
  [BACKSLASH, BACKSLASH],
  ["\n", ""],
]);

/**
 * Decode the quoted JavaScript string literal that starts at `open`.
 *
 * BOTH quote styles are handled, and that is load-bearing rather than
 * defensive: esbuild picks whichever quote costs fewer escapes for the content,
 * so in the real bundle the GLSL copy of a shader is double-quoted while the
 * WGSL twin of the SAME basename is single-quoted. A decoder that understood
 * only `"` silently skipped every WGSL post-process shader and reported it as
 * drifted against its GLSL namesake.
 *
 * `JSON.parse` is not usable here and the reason is not cosmetic either:
 * esbuild emits `\xNN` for non-ASCII bytes (the real bundle carries `\xD7`
 * inside a shader comment), and JSON has no `\x` escape, so `JSON.parse` throws
 * on a literal that is perfectly valid JavaScript.
 *
 * @param {string} text Source containing the literal.
 * @param {number} open Index of the opening quote.
 * @returns {{value: string, end: number}|null} Decoded value and the index of
 *   the closing quote, or null when the literal is unterminated.
 */
export function decodeJsStringLiteral(text, open) {
  const quote = text[open];
  if (quote !== QUOTE && quote !== "'") {
    return null;
  }
  let value = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) {
      return { value, end: i };
    }
    if (c !== BACKSLASH) {
      value += c;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      return null;
    }
    if (next === "x") {
      value += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
      i += 3;
      continue;
    }
    if (next === "u") {
      if (text[i + 2] === "{") {
        const close = text.indexOf("}", i + 3);
        if (close === -1) {
          return null;
        }
        value += String.fromCodePoint(parseInt(text.slice(i + 3, close), 16));
        i = close;
        continue;
      }
      value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    const simple = SIMPLE_ESCAPES.get(next);
    value += simple ?? next;
    i += 1;
  }
  return null;
}

/**
 * Every embedded copy of one shader module found in a bundle.
 *
 * The name is matched as `<base>_default` with an OPTIONAL numeric suffix,
 * because esbuild disambiguates colliding basenames by appending a digit. That
 * collision is routine here rather than exotic: a dozen shaders exist as both
 * `X.glsl` and `X.wgsl`, so the bundle carries `X_default` and `X_default2` and
 * there is no way to tell from the name which language each holds. Matching the
 * bare name alone found the GLSL copy for those and reported the WGSL as
 * drifted — a false alarm, and the kind that trains readers to ignore the check.
 *
 * Several copies are therefore normal, and callers accept the shader as current
 * when ANY copy matches, reporting drift only when none does.
 *
 * @param {string} bundleText
 * @param {string} baseName Module base name, e.g. `GlobeTerrain`.
 * @returns {string[]}
 */
export function extractEmbeddedShaders(bundleText, baseName) {
  const found = [];
  const pattern = new RegExp(
    `\\b${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_default\\d* = ['${QUOTE}]`,
    "g",
  );
  for (;;) {
    const match = pattern.exec(bundleText);
    if (match === null) {
      return found;
    }
    const open = match.index + match[0].length - 1;
    const decoded = decodeJsStringLiteral(bundleText, open);
    if (decoded === null) {
      // Skip this occurrence rather than abandoning the scan: giving up here
      // would hide every LATER copy, and the later copy is often the WGSL one.
      pattern.lastIndex = open + 1;
      continue;
    }
    found.push(decoded.value);
    pattern.lastIndex = decoded.end + 1;
  }
}

/** Line endings and a trailing newline are build-pipeline noise, not drift. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Compare a built bundle's embedded shaders against the sources on disk.
 *
 * @param {object} options
 * @param {string} options.bundleText
 * @param {{name: string, source: string}[]} options.shaders
 * @returns {{ok: boolean, results: object[], drifted: string[], absent: string[]}}
 */
export function compareBuiltShaderIdentity({ bundleText, shaders }) {
  const results = shaders.map(({ name, source }) => {
    const embedded = extractEmbeddedShaders(bundleText, name);
    const wanted = normalize(source);
    if (embedded.length === 0) {
      return { name, status: "absent", copies: 0 };
    }
    if (embedded.some((copy) => normalize(copy) === wanted)) {
      return { name, status: "current", copies: embedded.length };
    }
    const got = normalize(embedded[0]).split("\n");
    const want = wanted.split("\n");
    let firstDifferingLine = null;
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (got[i] !== want[i]) {
        firstDifferingLine = {
          line: i + 1,
          built: got[i] ?? null,
          source: want[i] ?? null,
        };
        break;
      }
    }
    return {
      name,
      status: "drifted",
      copies: embedded.length,
      firstDifferingLine,
    };
  });

  const drifted = results
    .filter((r) => r.status === "drifted")
    .map((r) => r.name);
  const absent = results
    .filter((r) => r.status === "absent")
    .map((r) => r.name);
  return {
    ok: drifted.length === 0 && absent.length === 0,
    results,
    drifted,
    absent,
  };
}
