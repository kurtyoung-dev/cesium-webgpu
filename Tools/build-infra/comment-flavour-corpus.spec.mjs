// comment-flavour-corpus.spec.mjs — every tracked shader and script agrees with the transforms that read its comments.
// @purpose Whole-corpus agreement between the source and the comment-reading transforms: minify-time WGSL strip vs the scanner, runtime GLSL doc-comment strip (no throw, same code, same czm_ set), no release-pragma anchor inside prose or inside a generated shader module, and a census of the engine code that reads shader source text, pinned to its classification.
// @status ACTIVE
//
// WHAT THIS GUARDS. Three transforms read comment TEXT, and each can make one
// build flavour ship something the source does not say:
//
//   - the minify-time WGSL strip does not nest block comments, while WGSL and
//     the comment scanner do, so a nested or glob-bearing block comment leaves
//     its tail in the minified module as code;
//   - the runtime GLSL strip in `ShaderSource` throws on a one-line `/** */`,
//     swallows the next function when a `//` sits on a doc block's closing
//     line, and harvests `czm_` dependencies from single-star comments it
//     leaves in place;
//   - the release pragma strip has no line anchor, so prose that quotes
//     `//>>includeStart('debug', pragmas.debug)` opens a strip region, in a
//     script or in the module the build generates from a shader.
//
// Scene and renderer code also reads shader source text directly. The census
// test pins every such reader that matches tracked shader text to its
// classification in `Tools/c16/lib/shader-text-readers.mjs`, so a reader that
// is added, moved or respelled fails here until it is classified. A second
// census pins every `RegExp(...)` call under the same directories to its
// classification there, because a regex built at runtime is invisible to the
// literal harvest; while one is unclassified the gate refuses every shader
// comment edit, and this census names it.
//
// Every tracked file in the shipping trees is checked with the same views
// the comment-only gate applies to an edited file (`Tools/c16/lib/flavour-views.mjs`),
// so a file that already disagrees is found here rather than at the next
// comment edit. Each corpus test also injects the defect it guards into a real
// file and requires the check to report it, so a check that has gone blind
// fails instead of reading as a clean corpus.
//
// WHY `git ls-files`. The shipping trees also hold gitignored build output
// when a build has run; "tracked" keeps the corpus the same on a built and an
// unbuilt checkout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  flavourForPath,
  flavourProblems,
  prosePragmaAnchors,
  shaderReaderProblems,
} from "../c16/lib/flavour-views.mjs";
import {
  READER_USES,
  RUNTIME_REGEX_USES,
  readerModelGaps,
  readerSpans,
  runtimeRegexSites,
  shaderTextReaders,
} from "../c16/lib/shader-text-readers.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHIPPING_TREES = ["packages/engine/Source", "packages/widgets/Source"];

/**
 * Tracked files under the shipping trees that a flavour applies to.
 *
 * @param {string} flavour Flavour name from `flavourForPath`.
 * @returns {string[]} Repo-relative paths.
 */
function trackedFiles(flavour) {
  return execFileSync("git", ["ls-files", "-z", "--", ...SHIPPING_TREES], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1e9,
  })
    .split("\0")
    .filter((relPath) => relPath !== "" && flavourForPath(relPath) === flavour);
}

/**
 * Every file of a flavour whose view disagrees with its source.
 *
 * @param {string} flavour Flavour name.
 * @param {number} minimum Smallest believable corpus size.
 * @returns {string[]} One line per problem.
 */
function corpusProblems(flavour, minimum) {
  const files = trackedFiles(flavour);
  assert.ok(
    files.length >= minimum,
    `expected at least ${minimum} tracked ${flavour} files, found ${files.length}`,
  );
  const problems = [];
  for (const relPath of files) {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    for (const problem of flavourProblems(source, relPath)) {
      problems.push(`${relPath}: ${problem.detail}`);
    }
  }
  return problems;
}

/**
 * A tracked file's text, line endings folded to LF.
 *
 * @param {string} relPath Repo-relative path.
 * @returns {string} File text.
 */
function readTracked(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

test("every tracked WGSL file reads the same to the minify strip and the scanner", () => {
  assert.deepEqual(corpusProblems("wgsl-minify", 300), []);

  const relPath =
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
  const source = readTracked(relPath);
  assert.deepEqual(flavourProblems(source, relPath), [], "control");
  const injected = `/* Shaders under Shaders/WebGPU/**/*.wgsl only. */\n${source}`;
  assert.match(
    flavourProblems(injected, relPath)[0]?.detail ?? "",
    /nested block comment\(s\) at line\(s\) 1\b/,
    "a nested block comment injected into a real shader must be reported",
  );
});

test("every tracked GLSL file survives the runtime comment strip unchanged", () => {
  assert.deepEqual(corpusProblems("glsl-runtime", 300), []);

  const relPath =
    "packages/engine/Source/Shaders/Builtin/Functions/getSkyAtmosphereLightDirection.glsl";
  const source = readTracked(relPath);
  assert.deepEqual(flavourProblems(source, relPath), [], "control");
  assert.ok(
    source.startsWith("/**"),
    "the builtin no longer opens with a doc block; pick another subject",
  );
  const demoted = `/*${source.slice(3)}`;
  assert.match(
    flavourProblems(demoted, relPath)
      .map((problem) => problem.detail)
      .join("; "),
    /gained \[czm_/,
    "a doc block demoted to /* must surface its czm_ names as dependencies",
  );
  const oneLine = `/** One line. */\n${source}`;
  assert.match(
    flavourProblems(oneLine, relPath)[0]?.detail ?? "",
    /throws/,
    "a one-line doc block must be reported as a throw",
  );
});

test("no tracked script opens or closes a release strip region from prose", () => {
  assert.deepEqual(corpusProblems("release-pragma", 1000), []);

  const relPath = "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts";
  const source = readTracked(relPath);
  const pair = "//>>includeStart('debug', pragmas.debug);";
  const at = source.indexOf(pair);
  assert.ok(at > 0, "the subject no longer carries a debug pragma pair");
  assert.deepEqual(prosePragmaAnchors(source), [], "control");
  const lineStart = source.lastIndexOf("\n", at) + 1;
  const injected = `${source.slice(0, lineStart)}// Kept outside \`${pair}\` on purpose.\n${source.slice(lineStart)}`;
  const anchors = prosePragmaAnchors(injected);
  assert.equal(anchors.length, 1, JSON.stringify(anchors));
  assert.equal(anchors[0].anchor, "start");
});

test("no generated shader module is cut by the release strip", () => {
  // The two corpus tests above already run this check on every tracked
  // shader; this one proves it can see a real file's module being cut.
  const relPath =
    "packages/engine/Source/Shaders/Builtin/Functions/RGBToXYZ.glsl";
  const source = readTracked(relPath);
  assert.deepEqual(flavourProblems(source, relPath), [], "control");
  const injected = `// Quoting \`//>>includeStart('debug', pragmas.debug)\` here.\n${source}// Closed by \`//>>includeEnd('debug')\`.\n`;
  assert.match(
    flavourProblems(injected, relPath)[0]?.detail ?? "",
    /release strip removes text from the generated unminified shader module/,
  );
});

/**
 * Harvested readers that match at least one tracked shader, by key, and the
 * table's keys that none of them carries.
 *
 * @param {{shaderTextReaders: Function, readerSpans: Function, READER_USES: object}} readers
 *   The reader module.
 * @returns {{unclassified: string[], stale: string[]}} Mismatches.
 */
function censusMismatch(readers) {
  const shaders = execFileSync(
    "git",
    ["ls-files", "-z", "--", "packages/engine/Source"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1e9 },
  )
    .split("\0")
    .filter((relPath) => /\.(?:glsl|wgsl)$/.test(relPath))
    .map((relPath) => readTracked(relPath));
  assert.ok(shaders.length >= 600, `found ${shaders.length} tracked shaders`);
  const reading = readers
    .shaderTextReaders()
    .filter((reader) => !reader.unharvested)
    .filter((reader) =>
      shaders.some((text) => readers.readerSpans(reader, text).length > 0),
    )
    .map((reader) => reader.key);
  const table = Object.keys(readers.READER_USES);
  return {
    unclassified: reading.filter((key) => !table.includes(key)),
    stale: table.filter((key) => !reading.includes(key)),
  };
}

test("every engine reader of shader text is classified, and the table names no other", async () => {
  assert.deepEqual(
    censusMismatch({ shaderTextReaders, readerSpans, READER_USES }),
    { unclassified: [], stale: [] },
    "a reader was added, moved or respelled: classify it in shader-text-readers.mjs",
  );
  for (const [key, entry] of Object.entries(READER_USES)) {
    if (entry.use === "exempt") {
      assert.ok(entry.reason?.length > 0, `${key} is exempt without a reason`);
    }
  }
  const known = shaderTextReaders().filter(
    (reader) => READER_USES[reader.key] !== undefined,
  );
  for (const reader of known) {
    if (reader.use === "rewrites") {
      assert.ok(
        reader.matcher.global && !reader.perLine,
        `${reader.key} rewrites in place but is not a global replace pattern`,
      );
    }
  }

  // A reader dropped from the table must surface as unclassified.
  const modulePath = path.join(ROOT, "Tools/c16/lib/shader-text-readers.mjs");
  const row = '  ["Scene/BatchTable.js", "void main", "decides"],\n';
  const source = readTracked("Tools/c16/lib/shader-text-readers.mjs");
  assert.equal(source.split(row).length, 2, "the BatchTable row moved");
  const mutated = source
    .replace(row, "")
    .replace(
      /from "(\.{1,2}\/[^"]+)"/g,
      (_, specifier) =>
        `from "${pathToFileURL(path.resolve(path.dirname(modulePath), specifier)).href}"`,
    )
    .replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(modulePath).href),
    );
  const mutant = await import(
    `data:text/javascript;base64,${Buffer.from(mutated, "utf8").toString("base64")}`
  );
  assert.deepEqual(censusMismatch(mutant), {
    unclassified: ['Scene/BatchTable.js|"void main"'],
    stale: [],
  });
});

/**
 * A real shader with one line of prose added above its first line, checked by
 * the shader-text readers against the unedited file.
 *
 * @param {string} relPath Repo-relative shader path.
 * @param {string} prose The comment line to add.
 * @returns {string} The first problem's detail, or "".
 */
function readerDetailForProse(relPath, prose) {
  const language = relPath.endsWith(".wgsl") ? "wgsl" : "glsl";
  const source = readTracked(relPath);
  assert.deepEqual(
    shaderReaderProblems(source, source, language),
    [],
    `control: ${relPath}`,
  );
  return (
    shaderReaderProblems(source, `${prose}\n${source}`, language)[0]?.detail ??
    ""
  );
}

test("prose that spells out what a shader-text reader matches is caught in real shaders", () => {
  assert.match(
    readerDetailForProse(
      "packages/engine/Source/Shaders/Appearances/PerInstanceColorAppearanceVS.glsl",
      "// Per-instance colour: void main forwards each instance's colour and eye-space normal.",
    ),
    /Scene\/BatchTable\.js\|"void main".*matches 1 time\(s\) in the old text and 2 in the new/,
  );
  assert.match(
    readerDetailForProse(
      "packages/engine/Source/Shaders/Appearances/PerInstanceColorAppearanceFS.glsl",
      "// One colour target: this writes out_FragColor, not out_FragData.",
    ),
    /Scene\/DerivedCommand\.js\|"out_FragData".*matches 0 time\(s\) in the old text and 1 in the new/,
  );
  assert.match(
    readerDetailForProse(
      "packages/engine/Source/Shaders/WebGPU/Compute/EnvCubeMipDownsample.wgsl",
      "// Format-agnostic: dstTex is declared texture_storage_2d_array<rgba16float, write>",
    ),
    /texture_storage_2d_array<rgba16float, write>.*matches 1 time\(s\) in the old text and 2 in the new/,
  );

  const pointMaterial =
    "packages/engine/Source/Shaders/WebGPU/Collections/BufferPointMaterial.wgsl";
  const points = readTracked(pointMaterial);
  const importLine = points.match(/^[ \t]*#import\s+\w+\s*;?/m)?.[0];
  assert.ok(importLine !== undefined, "the subject no longer imports a chunk");
  assert.match(
    shaderReaderProblems(
      points,
      `/* Point material.\n${importLine.trim()}\n*/\n${points}`,
      "wgsl",
    )[0]?.detail ?? "",
    /WebGPUBufferPrimitiveRenderer\.ts.*matches \d+ time\(s\) in the old text and \d+ in the new/,
  );

  const relPath =
    "packages/engine/Source/Shaders/WebGPU/Compute/FrustumCull.wgsl";
  const source = readTracked(relPath);
  const prose = "// `// __SUBGROUP_BLOCK_*__` text still inside the line.";
  assert.ok(source.includes(prose), "the subject's prose line moved");
  const spelled = source.replace(
    prose,
    "// `// __SUBGROUP_BLOCK_START__` / `// __SUBGROUP_BLOCK_END__` text still\n// inside the line.",
  );
  assert.match(
    shaderReaderProblems(source, spelled, "wgsl")[0]?.detail ?? "",
    /__SUBGROUP_BLOCK_START__.*matches 1 time\(s\) in the old text and 2 in the new/,
  );
  const sentinelSites = shaderTextReaders().filter((reader) =>
    reader.key.includes("__SUBGROUP_BLOCK_START__"),
  );
  assert.equal(sentinelSites.length, 3, JSON.stringify(sentinelSites));
});

test("every runtime-built regex in the reader roots is classified, and the model is complete", () => {
  const sites = runtimeRegexSites().map((site) => site.key);
  const table = Object.keys(RUNTIME_REGEX_USES);
  assert.deepEqual(
    {
      unclassified: sites.filter((key) => !table.includes(key)),
      stale: table.filter((key) => !sites.includes(key)),
    },
    { unclassified: [], stale: [] },
    "a RegExp(...) call was added, moved or changed: classify it in shader-text-readers.mjs RUNTIME_REGEX_TABLE",
  );
  assert.deepEqual(readerModelGaps(), []);
});

/**
 * The first shader-text reader problem after one exact edit of a real shader.
 *
 * @param {string} relPath Repo-relative shader path.
 * @param {string} anchor Text that occurs once in the shader.
 * @param {string} replacement Its replacement.
 * @returns {string} Every problem's detail, joined.
 */
function readerDetailForEdit(relPath, anchor, replacement) {
  const language = relPath.endsWith(".wgsl") ? "wgsl" : "glsl";
  const source = readTracked(relPath);
  assert.equal(
    source.split(anchor).length,
    2,
    `the anchor moved in ${relPath}`,
  );
  assert.deepEqual(shaderReaderProblems(source, source, language), []);
  return shaderReaderProblems(
    source,
    source.replace(anchor, replacement),
    language,
  )
    .map((problem) => problem.detail)
    .join("; ");
}

test("prose that a runtime-built or array-needle reader reads is caught in real shaders", () => {
  const imageWidth = "    float imageWidth = float(imageDimensions.x);\n";
  assert.match(
    readerDetailForEdit(
      "packages/engine/Source/Shaders/Materials/BumpMapMaterial.glsl",
      imageWidth,
      "    // imageDimensions is not declared above: Material.js prepends\n    // `uniform ivec3 imageDimensions;` because WebGL cannot query a texture's size.\n" +
        imageWidth,
    ),
    /unharvested:material-uniform-declaration.*matches \d+ time\(s\) in the old text and \d+ in the new/,
  );
  assert.match(
    readerDetailForEdit(
      "packages/engine/Source/Shaders/Appearances/PerInstanceFlatColorAppearanceFS.glsl",
      "in vec4 v_color;\n",
      "// Flat shading: this shader declares no v_positionEC varying, so a shadow receiver\n// reconstructs the eye-space position from depth.\nin vec4 v_color;\n",
    ),
    /unharvested:shader-source-position-varying.*matches 0 time\(s\) in the old text and 1 in the new/,
  );
  const lit =
    "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatColorLit.wgsl";
  assert.match(
    readerDetailForEdit(
      lit,
      "@fragment\nfn fragmentMain(",
      "@fragment\n// Lit output: the shaded colour and the packed normal and roughness.\nfn fragmentMain(",
    ),
    /unharvested:oit-entry \(.*matches 1 time\(s\) in the old text and 0 in the new/,
  );
  assert.match(
    readerDetailForEdit(
      lit,
      "struct FragOutput {\n",
      "struct FragOutput {\n    // One entry per render target: {color, normalRoughness}.\n",
    ),
    /unharvested:oit-struct-braces/,
  );
});

test("a comment the minified GLSL module reads differently is caught in a real shader", () => {
  const relPath =
    "packages/engine/Source/Shaders/Builtin/Functions/RGBToXYZ.glsl";
  const source = readTracked(relPath);
  const anchor =
    "    // light. Every non-black input is bit-for-bit unchanged.\n";
  assert.equal(
    source.split(anchor).length,
    2,
    "the subject's prose line moved",
  );
  const backslash = String.fromCharCode(92);
  const diagram = `${anchor}    // In gamut:  /${backslash}\n    //           /  ${backslash}\n`;
  assert.match(
    flavourProblems(source.replace(anchor, diagram), relPath)
      .map((problem) => problem.detail)
      .join("; "),
    /minify-time GLSL comment strip leaves different code/,
  );
});
