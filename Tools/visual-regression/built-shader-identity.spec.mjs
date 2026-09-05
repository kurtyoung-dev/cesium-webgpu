// built-shader-identity.spec.mjs
// @purpose Pins that a stale built bundle is DETECTED — the seam a shader-math spec structurally cannot see, and the one that turned a correct fix into a red gate.
// @status ACTIVE
//
// THE FAILURE THIS EXISTS FOR, STATED WITHOUT REFERENCE TO ANY IMPLEMENTATION.
//
//   A probe measures the bundle the browser loads. A spec measures the source
//   on disk. When the bundle is not rebuilt after a shader changes, those two
//   describe different shaders and NOTHING in the tree says so: the page loads,
//   every gate runs, and the numbers are a faithful measurement of the old code.
//
// This is not hypothetical. On 2026-09-05 the draped-polyline probe scored gate
// B as FAIL (count ratio 1.858 against a [0.6, 1.67] band) and the reading was
// filed against the shader fix that had landed hours earlier. The fix was
// correct. The bundle under the browser still held the PRE-fix WGSL — the
// build predated the shader module it was supposed to embed — and 1.858 is what
// the pre-fix shader measures, because it tested `distance < lineWidth` instead
// of `< lineWidth * 0.5` and drew every line at exactly twice its half width.
//
// WHY THE EXISTING CHECKS COULD NOT SEE IT.
//
//   * `served md5 == disk md5` — the standing executor preflight — proves the
//     dev server is not caching. It compares the artifact to ITSELF. It says
//     nothing about whether the artifact was rebuilt from current source.
//   * A shader-math spec (`vector-layer-draping.spec.mjs`) evaluates the two
//     width functions on the same inputs. Both sides read the SOURCE, so a
//     stale bundle leaves it green — correctly, because the source is right.
//     The defect is not in any source file, so no spec over source files can
//     find it. It has to be checked where it breaks: source vs built artifact.
//
// WHAT IS PINNED HERE. Section A is the decoder and extractor, on fixtures.
// Section B is the comparison's verdicts. Section C is the INERTNESS mutant.
// Section D runs the real artifacts on disk when they exist — including the
// exact stale bundle the probe ran against, which must read DRIFTED.
//
// Run: node --test Tools/visual-regression/built-shader-identity.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareBuiltShaderIdentity,
  decodeJsStringLiteral,
  extractEmbeddedShaders,
} from "./lib/built-shader-identity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);

/** Build a bundle-shaped fragment assigning `text` to `<name>_default`. */
function bundleWith(name, text, { quote = QUOTE, suffix = "" } = {}) {
  const escaped = text
    .split(BACKSLASH)
    .join(BACKSLASH + BACKSLASH)
    .split(quote)
    .join(BACKSLASH + quote)
    .split("\n")
    .join(BACKSLASH + "n");
  return `  var ${name}_default${suffix} = ${quote}${escaped}${quote};\n`;
}

// ─── A. the decoder and the extractor ────────────────────────────────────────

test("A1 — a double-quoted literal decodes, escapes and all", () => {
  const text = `${QUOTE}a${BACKSLASH}nb${QUOTE}`;
  const decoded = decodeJsStringLiteral(text, 0);
  assert.equal(decoded.value, "a\nb");
  assert.equal(decoded.end, text.length - 1);
});

test("A2 — a SINGLE-quoted literal decodes too", () => {
  // Not a nicety: esbuild picks the quote that costs fewer escapes, so the WGSL
  // twin of a shader whose GLSL namesake is double-quoted comes out single-
  // quoted. A double-quote-only decoder skips every one of them.
  const text = `'a${BACKSLASH}nb'`;
  assert.equal(decodeJsStringLiteral(text, 0).value, "a\nb");
});

test("A3 — a \\xNN escape decodes, which is why JSON.parse cannot be used", () => {
  const literal = `${QUOTE}mix${BACKSLASH}xD7five${QUOTE}`;
  assert.equal(decodeJsStringLiteral(literal, 0).value, "mix×five");
  assert.throws(
    () => JSON.parse(literal),
    "JSON.parse must still reject it — if it ever accepts \\x, this rationale is stale",
  );
});

test("A4 — an unterminated literal returns null rather than a truncated value", () => {
  assert.equal(decodeJsStringLiteral(`${QUOTE}no end`, 0), null);
});

test("A5 — every copy is found, including a digit-suffixed one", () => {
  // `X.glsl` and `X.wgsl` both become `X.js`, so esbuild emits `X_default` and
  // `X_default2`. Matching only the bare name finds the GLSL and calls the WGSL
  // drifted.
  const bundle =
    bundleWith("Shader", "glsl body") +
    bundleWith("Shader", "wgsl body", { quote: "'", suffix: "2" });
  assert.deepEqual(extractEmbeddedShaders(bundle, "Shader"), [
    "glsl body",
    "wgsl body",
  ]);
});

// ─── B. the verdicts ─────────────────────────────────────────────────────────

const SOURCE = "fn main() {\n  let halfWidth = w * 0.5;\n}\n";

test("B1 — a bundle embedding the current text reads CURRENT", () => {
  const report = compareBuiltShaderIdentity({
    bundleText: bundleWith("Globe", SOURCE),
    shaders: [{ name: "Globe", source: SOURCE }],
  });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].status, "current");
});

test("B2 — a bundle embedding OLDER text reads DRIFTED, and names the line", () => {
  const stale = SOURCE.replace("w * 0.5", "w");
  const report = compareBuiltShaderIdentity({
    bundleText: bundleWith("Globe", stale),
    shaders: [{ name: "Globe", source: SOURCE }],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.drifted, ["Globe"]);
  assert.equal(report.results[0].firstDifferingLine.line, 2);
  assert.match(
    report.results[0].firstDifferingLine.built,
    /let halfWidth = w;/,
  );
  assert.match(report.results[0].firstDifferingLine.source, /w \* 0\.5/);
});

test("B3 — CURRENT when ANY copy matches, so a GLSL namesake cannot mask the twin", () => {
  const bundle =
    bundleWith("Globe", "unrelated glsl") +
    bundleWith("Globe", SOURCE, { quote: "'", suffix: "2" });
  const report = compareBuiltShaderIdentity({
    bundleText: bundle,
    shaders: [{ name: "Globe", source: SOURCE }],
  });
  assert.equal(report.results[0].status, "current");
  assert.equal(report.results[0].copies, 2);
});

test("B4 — a shader with no embedded copy is ABSENT, never silently OK", () => {
  const report = compareBuiltShaderIdentity({
    bundleText: "var Other_default = 'x';",
    shaders: [{ name: "Globe", source: SOURCE }],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.absent, ["Globe"]);
});

test("B5 — CRLF and a trailing newline are build noise, not drift", () => {
  const report = compareBuiltShaderIdentity({
    bundleText: bundleWith("Globe", SOURCE),
    shaders: [{ name: "Globe", source: SOURCE.replace(/\n/g, "\r\n") + "\n" }],
  });
  assert.equal(report.results[0].status, "current");
});

// ─── C. inertness ────────────────────────────────────────────────────────────

test("C1 — a comparison that ignores the embedded text cannot tell the two apart", () => {
  // The mutant keeps the whole shape — it still extracts, still counts copies,
  // still returns a verdict — and only stops COMPARING. Every fixture above
  // that asserts `current` still passes under it; the two that must fail are
  // the drift verdicts, which is exactly what a stale bundle looks like.
  const inert = ({ bundleText, shaders }) => ({
    ok: true,
    results: shaders.map(({ name }) => ({
      name,
      status:
        extractEmbeddedShaders(bundleText, name).length > 0
          ? "current"
          : "absent",
      copies: extractEmbeddedShaders(bundleText, name).length,
    })),
    drifted: [],
    absent: [],
  });

  const stale = SOURCE.replace("w * 0.5", "w");
  const real = compareBuiltShaderIdentity({
    bundleText: bundleWith("Globe", stale),
    shaders: [{ name: "Globe", source: SOURCE }],
  });
  const mutated = inert({
    bundleText: bundleWith("Globe", stale),
    shaders: [{ name: "Globe", source: SOURCE }],
  });

  assert.equal(
    real.ok,
    false,
    "the real comparison must catch the stale bundle",
  );
  assert.equal(
    mutated.ok,
    true,
    "the mutant must NOT — otherwise it is not inert",
  );
  assert.notDeepEqual(
    real.results[0].status,
    mutated.results[0].status,
    "the mutant must be distinguishable from the real comparison",
  );
});

// ─── D. the real artifacts ───────────────────────────────────────────────────

test("D1 — this checkout's own bundle, when one has been built, carries its shaders", (t) => {
  const bundlePath = path.join(root, "Build/CesiumUnminified/Cesium.js");
  const shaderPath = path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  );
  if (!fs.existsSync(bundlePath)) {
    t.skip("no Build/CesiumUnminified — nothing to verify");
    return;
  }
  const report = compareBuiltShaderIdentity({
    bundleText: fs.readFileSync(bundlePath, "utf8"),
    shaders: [
      { name: "GlobeTerrain", source: fs.readFileSync(shaderPath, "utf8") },
    ],
  });
  const status = report.results[0].status;
  assert.equal(
    status,
    "current",
    status === "drifted"
      ? `Build/ is STALE for GlobeTerrain (first differing line ` +
          `${report.results[0].firstDifferingLine?.line}) — rebuild before trusting any probe`
      : "GlobeTerrain is not embedded in the bundle at all",
  );
});
