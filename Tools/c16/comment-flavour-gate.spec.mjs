// comment-flavour-gate.spec.mjs — the comment-only gate in every build flavour.
// @purpose Pins that comment-only-diff refuses comment edits that change a shipped or run artifact (release pragma strip, minified WGSL, runtime GLSL strip, bundler annotations, lint and reference directives, ASI), still passes true comment-only edits, and keeps its vendored transforms pinned to their sources.
// @status ACTIVE
//
// Run: node --test Tools/c16/comment-flavour-gate.spec.mjs
//
// THE CLASS. Each refusal below is a before/after pair that differs only in
// comment text or comment position, while the release bundle, a generated
// shader module, the minified WGSL module, the runtime GLSL program, the
// engine code that reads shader source text, a downstream bundler, a lint
// script or a next-line directive sees a different file. Each pair is asserted in
// three ways: the gate refuses it; the refusal comes from the mechanism named
// (the tokenizer view alone is blind to the flavour pairs); and a copy of the
// module with that mechanism made unreachable lets the pair through again.
// The last step is what shows the refusal is live rather than incidental.
//
// Every refusal is paired with the nearest legitimate edit, which must pass.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareSources } from "./comment-only-diff.mjs";
import {
  canonicalizeCode,
  classifySemanticComment,
  extractComments,
  languageForPath,
} from "./lib/comment-scanner.mjs";
import {
  CZM_TOKEN_PATTERN,
  RELEASE_PRAGMA_FILTER,
  SHADER_LICENSE_BLOCK_PATTERN,
  compareFlavours,
  glslRuntimeCommentStrip,
  wgslPreprocessorCommentStrip,
} from "./lib/flavour-views.mjs";
import { findMarkers, selfTestRules } from "./lib/marker-grammar.mjs";
import {
  RUNTIME_REGEX_USES,
  UNHARVESTED_READER_IDS,
  readerModelGaps,
  readerSpans,
  readersInSource,
  runtimeRegexSitesInSource,
  shaderTextReaders,
} from "./lib/shader-text-readers.mjs";
import { collectScopeFiles, scanSource } from "./comment-marker-guard.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const JS = "packages/engine/Source/Scene/WasmSubject.js";
const TS = "packages/engine/Source/Renderer/WebGPU/Subject.ts";
const GLSL = "packages/engine/Source/Shaders/Builtin/Functions/subject.glsl";
const WGSL = "packages/engine/Source/Shaders/WebGPU/Subject.wgsl";
const GLSL_VS = "packages/engine/Source/Shaders/Appearances/SubjectVS.glsl";
const GLSL_FS = "packages/engine/Source/Shaders/Appearances/SubjectFS.glsl";

/** An appearance vertex shader shaped like the per-instance-colour one. */
const APPEARANCE_VS =
  "in vec3 position3DHigh;\nin vec3 position3DLow;\nin vec4 color;\nin float batchId;\n\nout vec4 v_color;\n\nvoid main()\n{\n    vec4 p = czm_computePosition();\n    v_color = color;\n    gl_Position = czm_modelViewProjectionRelativeToEye * p;\n}\n";

/** An appearance fragment shader shaped like the per-instance-colour one. */
const APPEARANCE_FS =
  "in vec4 v_color;\n\nvoid main()\n{\n    out_FragColor = czm_gammaCorrect(v_color);\n}\n";

/**
 * Read a repository file with line endings folded to LF.
 *
 * @param {string} relPath Repo-relative path.
 * @returns {Promise<string>} File text.
 */
async function readLf(relPath) {
  return (await fs.readFile(path.join(ROOT, relPath), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

/**
 * Load a copy of a module with anchors replaced. Relative imports, and
 * `import.meta.url`, are rewritten to the original file's URLs so the copy
 * loads from a data URL without writing anything to disk.
 *
 * @param {string} relPath Repo-relative module path.
 * @param {Array<[string, string]>} edits `[anchor, replacement]` pairs; each
 *   anchor must occur exactly once.
 * @param {Record<string, string>} [overrides] Relative import specifiers to
 *   load from another URL instead, such as a mutant of a dependency.
 * @returns {Promise<Record<string, unknown>>} The mutant module's exports.
 */
async function loadMutant(relPath, edits, overrides = {}) {
  return import(await mutantUrl(relPath, edits, overrides));
}

/**
 * The data URL of a mutant module, for `loadMutant` or for an override.
 *
 * @param {string} relPath Repo-relative module path.
 * @param {Array<[string, string]>} edits `[anchor, replacement]` pairs.
 * @param {Record<string, string>} [overrides] Import specifier overrides.
 * @returns {Promise<string>} Data URL.
 */
async function mutantUrl(relPath, edits, overrides = {}) {
  let mutated = await readLf(relPath);
  for (const [anchor, replacement] of edits) {
    assert.equal(
      mutated.split(anchor).length,
      2,
      `mutation anchor must occur exactly once in ${relPath}: ${anchor}`,
    );
    mutated = mutated.replace(anchor, replacement);
  }
  const directory = path.dirname(path.join(ROOT, relPath));
  mutated = mutated
    .replace(
      /from "(\.{1,2}\/[^"]+)"/g,
      (_, specifier) =>
        `from "${overrides[specifier] ?? pathToFileURL(path.resolve(directory, specifier)).href}"`,
    )
    .replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(path.join(ROOT, relPath)).href),
    );
  return `data:text/javascript;base64,${Buffer.from(mutated, "utf8").toString("base64")}`;
}

const pragmaFile = (lead) => `export function check(v) {
${lead}
  if (v === undefined) {
    console.error("missing");
  }
  //>>includeStart('debug', pragmas.debug);
  console.log("debug", v);
  //>>includeEnd('debug');
  return v;
}
`;

/** A subgroup-sentinel section shaped like the compute shaders'. */
const SUBGROUP_BLOCK =
  "// __SUBGROUP_BLOCK_START__\nfn mainSubgroups() {\n  let x = 1u;\n}\n// __SUBGROUP_BLOCK_END__\n";

/** Line terminators other than `\n`, built without writing them literally. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const VERTICAL_TAB = String.fromCharCode(0x0b);

/**
 * A mutation that makes an exported view function return no problems, so the
 * check it performs is unreachable while every other check still runs.
 *
 * @param {string} signature The function's name and parameter list.
 * @returns {[string, string]} Anchor and replacement for `loadMutant`.
 */
function disableFunction(signature) {
  const anchor = `export function ${signature} {`;
  return [anchor, `${anchor}\n  if (true) {\n    return [];\n  }`];
}

/** Makes the shader-text reader check unreachable. */
const READERS_OFF = disableFunction(
  "shaderReaderProblems(before, after, language)",
);

/** Leaves the hand-written readers out of the reader list. */
const UNHARVESTED_OFF = [
  "    ...UNHARVESTED_READERS.map((reader) => ({",
  "    ...[].map((reader) => ({",
];

/** Makes the minify-time GLSL code comparison unreachable. */
const MINIFY_CODE_OFF = [
  "    if (code !== viaMinify) {",
  "    if (false && code !== viaMinify) {",
];

/** A backslash, built without writing one into a string literal. */
const BACKSLASH = String.fromCharCode(92);

/** The head of a fabric material function, up to its body. */
const MATERIAL_BODY =
  "czm_material czm_getMaterial(czm_materialInput materialInput)\n{\n";

/** A struct-returning WGSL fragment entry point, as WebGPU OIT rewrites it. */
const OIT_ENTRY =
  "struct FragOutput {\n    @location(0) color: vec4<f32>,\n};\n\n@fragment\nfn fragmentMain(input: VertexOutput) -> FragOutput {\n    var out: FragOutput;\n    return out;\n}\n";

/** Makes the single-text GLSL flavour check unreachable. */
const GLSL_BRANCH_OFF = [
  'if (flavour === "glsl-runtime") {',
  'if (false && flavour === "glsl-runtime") {',
];

/**
 * Before/after pairs whose source token stream is unchanged while a
 * transform that reads comment text sees a different file.
 */
const FLAVOUR_FIXTURES = [
  {
    id: "GLSL doc block demoted from /** to /*",
    path: GLSL,
    flavour: "glsl-runtime",
    before:
      "/**\n * Delegates the light term to czm_computeAtmosphereColor.\n */\nvec3 czm_subject(vec3 v) {\n    return v;\n}\n",
    after:
      "/*\n * Delegates the light term to czm_computeAtmosphereColor.\n */\nvec3 czm_subject(vec3 v) {\n    return v;\n}\n",
    detail: /gained \[czm_computeAtmosphereColor\]/,
    mutations: [GLSL_BRANCH_OFF, READERS_OFF],
  },
  {
    id: "GLSL URL moved onto a doc block's closing line",
    path: GLSL,
    flavour: "glsl-runtime",
    before:
      "/**\n * Reference: https://example.com/paper\n */\nvec3 czm_subject(vec3 v) {\n    return v;\n}\n/**\n * Second.\n */\nfloat czm_other() {\n    return 1.0;\n}\n",
    after:
      "/**\n * Reference: https://example.com/paper */\nvec3 czm_subject(vec3 v) {\n    return v;\n}\n/**\n * Second.\n */\nfloat czm_other() {\n    return 1.0;\n}\n",
    detail: /leaves different code/,
    mutations: [GLSL_BRANCH_OFF, READERS_OFF],
  },
  {
    id: "GLSL doc block collapsed to one line",
    path: GLSL,
    flavour: "glsl-runtime",
    before:
      "/**\n * Selects the natural-sky light direction.\n */\nvec3 czm_subject() {\n    return vec3(0.0);\n}\n",
    after:
      "/** Selects the natural-sky light direction. */\nvec3 czm_subject() {\n    return vec3(0.0);\n}\n",
    detail: /throws/,
  },
  {
    id: "WGSL block comment carrying a glob",
    path: WGSL,
    flavour: "wgsl-minify",
    before: "// Shaders under this directory only.\nfn main() {}\n",
    after: "/* Shaders under Shaders/WebGPU/**/*.wgsl only. */\nfn main() {}\n",
    detail: /nested block comment\(s\) at line\(s\) 1/,
  },
  {
    id: "JS prose quoting the debug pragma",
    path: TS,
    flavour: "release-pragma",
    before: pragmaFile(
      "  // Deliberately outside the debug pragma so release builds keep it.",
    ),
    after: pragmaFile(
      "  // Deliberately outside `//>>includeStart('debug', pragmas.debug)` so release builds keep it.",
    ),
    detail: /line 2: the release strip region starts/,
  },
  {
    id: "GLSL prose quoting both debug pragmas",
    path: GLSL,
    flavour: "release-pragma",
    before:
      "/**\n * Converts RGB to XYZ.\n */\nvec3 czm_subject(vec3 rgb)\n{\n    return rgb;\n}\n// End of the builtin.\n",
    after:
      "/**\n * Converts RGB to XYZ. Quoting `//>>includeStart('debug', pragmas.debug)`; every line ships.\n */\nvec3 czm_subject(vec3 rgb)\n{\n    return rgb;\n}\n// Closed by `//>>includeEnd('debug')`.\n",
    detail: /removes text from the generated unminified shader module/,
    mutations: [disableFunction("shaderReleaseProblems(source, flavour)")],
  },
  {
    id: "WGSL prose spelling out the subgroup sentinels",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: `// The sentinels below are matched by the host.\nfn main() {}\n${SUBGROUP_BLOCK}`,
    after: `// The \`// __SUBGROUP_BLOCK_START__\` / \`// __SUBGROUP_BLOCK_END__\` pair below is matched by the host.\nfn main() {}\n${SUBGROUP_BLOCK}`,
    detail:
      /__SUBGROUP_BLOCK_START__.*matches 1 time\(s\) in the old text and 2 in the new/,
    mutations: [READERS_OFF],
  },
  {
    // The count stays at one: the lazy match now opens at the prose and runs
    // to the real closing sentinel, so it reads code the old match did not.
    id: "WGSL prose spelling only the opening sentinel",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: `// The section below is removed by the host.\nfn main() {}\n${SUBGROUP_BLOCK}`,
    after: `// The \`// __SUBGROUP_BLOCK_START__\` line opens the section below.\nfn main() {}\n${SUBGROUP_BLOCK}`,
    detail: /__SUBGROUP_BLOCK_START__.*reads different text at match 1/,
    mutations: [
      [
        "const at = oldElements.findIndex(",
        "const at = -1;\n    void oldElements.findIndex(",
      ],
    ],
  },
  {
    id: "WGSL prose naming a chunk marker",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: "// These helpers stay local to this shader.\nfn main() {}\n",
    after:
      "// These helpers stay local: this shader does not opt into `@chunk functions/csm_polylineCommon`.\nfn main() {}\n",
    detail:
      /csm_polylineCommon.*matches 0 time\(s\) in the old text and 1 in the new/,
    mutations: [READERS_OFF],
  },
  {
    id: "a trailing comment naming console.warn() after code",
    path: TS,
    flavour: "lint-debug-pragmas",
    before:
      "export function recover(device) {\n  setupHandler(device); // failures surface on the console\n}\n",
    after:
      "export function recover(device) {\n  setupHandler(device); // failures surface via console.warn()\n}\n",
    detail: /reports a console call it did not before, at line 2/,
    mutations: [disableFunction("lintReaderProblems(before, after, relPath)")],
  },
  {
    // The lint's pragma test has no line anchor either, so prose quoting the
    // opening pragma hides the unguarded call below it from the lint.
    id: "prose quoting the opening pragma above an unguarded console call",
    path: TS,
    flavour: "lint-debug-pragmas",
    before:
      'export function f() {\n  // Logged while the device is probed.\n  console.log("x");\n}\n',
    after:
      "export function f() {\n  // Guard with `//>>includeStart('debug', pragmas.debug)` before this ships.\n  console.log(\"x\");\n}\n",
    detail: /no longer reports a console call it reported before/,
    mutations: [
      ["for (const text of unmatched) {", "for (const text of []) {"],
    ],
  },
  {
    id: "a lint-debug-pragmas-allow reason wrapped onto a second line",
    path: TS,
    flavour: "lint-debug-pragmas",
    before:
      'export function warn() {\n  // lint-debug-pragmas-allow: permanent sentinel (the fork rules).\n  console.warn("x");\n}\n',
    after:
      'export function warn() {\n  // lint-debug-pragmas-allow: a broken frame must reach the\n  // console in every build.\n  console.warn("x");\n}\n',
    detail: /reports a console call it did not before, at line 4/,
    // The wrap also moves the directive off the line above its call, so both
    // readers have to go for the pair to pass again.
    mutations: [
      disableFunction("lintReaderProblems(before, after, relPath)"),
      disableFunction("nextLineBindingProblems(before, after)"),
    ],
  },
  {
    id: "a comment line inserted under eslint-disable-next-line",
    path: TS,
    flavour: "next-line-directive",
    before:
      "export function wrap(x: unknown) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  (x as any).y = 1;\n}\n",
    after:
      "export function wrap(x: unknown) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  // The cast is the documented escape hatch.\n  (x as any).y = 1;\n}\n",
    detail: /\[\] -> \[s\]/,
    mutations: [disableFunction("nextLineBindingProblems(before, after)")],
  },
  {
    id: "a blank line inserted under eslint-disable-next-line",
    path: TS,
    flavour: "next-line-directive",
    before:
      "export function wrap(x: unknown) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  (x as any).y = 1;\n}\n",
    after:
      "export function wrap(x: unknown) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n\n  (x as any).y = 1;\n}\n",
    detail: /\[\] -> \[b\]/,
    mutations: [disableFunction("nextLineBindingProblems(before, after)")],
  },
  {
    id: "a block comment line between @ts-expect-error and its code",
    path: TS,
    flavour: "next-line-directive",
    before:
      "// @ts-expect-error The fixture is deliberately mistyped.\nexport const n: number = 's';\n",
    after:
      "// @ts-expect-error The fixture is deliberately mistyped.\n/* Kept as a fixture. */\nexport const n: number = 's';\n",
    detail: /\[\] -> \[c\]/,
    mutations: [disableFunction("nextLineBindingProblems(before, after)")],
  },
  {
    // TypeScript's look-back skips a `//` line but stops at a block comment
    // line, so the suppression no longer reaches the code.
    id: "a // line under @ts-expect-error rewritten as a block comment",
    path: TS,
    flavour: "next-line-directive",
    before:
      "// @ts-expect-error The fixture is mistyped.\n// A string on purpose.\nexport const n: number = 's';\n",
    after:
      "// @ts-expect-error The fixture is mistyped.\n/* A string on purpose. */\nexport const n: number = 's';\n",
    detail: /\[s\] -> \[c\]/,
    mutations: [
      [
        'descriptor += !hasComment[next] ? "b" : opensWithSlashes ? "s" : "c";',
        'descriptor += !hasComment[next] ? "b" : "c";',
      ],
    ],
  },
  {
    // BatchTable splices its GLSL in before the first "void main" it finds.
    id: "GLSL prose naming void main above the real one",
    path: GLSL_VS,
    flavour: "glsl-runtime",
    before: `// Per-instance colour.\n${APPEARANCE_VS}`,
    after: `// Per-instance colour: void main forwards each instance's colour.\n${APPEARANCE_VS}`,
    detail:
      /Scene\/BatchTable\.js\|"void main".*matches 1 time\(s\) in the old text and 2 in the new/,
    mutations: [READERS_OFF],
  },
  {
    // DerivedCommand switches every pick shader to out_FragData_0 when the
    // text "out_FragData" occurs anywhere in a fragment source.
    id: "GLSL prose naming out_FragData in a fragment shader",
    path: GLSL_FS,
    flavour: "glsl-runtime",
    before: `// One colour target.\n${APPEARANCE_FS}`,
    after: `// One colour target: this writes out_FragColor, not out_FragData.\n${APPEARANCE_FS}`,
    detail:
      /Scene\/DerivedCommand\.js\|"out_FragData".*matches 0 time\(s\) in the old text and 1 in the new/,
    mutations: [READERS_OFF],
  },
  {
    // The buffer-primitive renderer expands the first `#import` line it
    // finds, block comment or not, and drops the later one as a duplicate.
    id: "WGSL #import line inside a block comment above the real one",
    path: WGSL,
    flavour: "wgsl-runtime",
    before:
      "// Point material.\n// Imports the camera block.\n#import CameraUniforms;\nfn main() {}\n",
    after:
      "/* Point material.\n#import CameraUniforms;\n*/\n#import CameraUniforms;\nfn main() {}\n",
    detail:
      /WebGPUBufferPrimitiveRenderer\.ts.*matches 1 time\(s\) in the old text and 2 in the new/,
    mutations: [READERS_OFF],
  },
  {
    // The IBL pipeline swaps the first storage-texture format it finds.
    id: "WGSL prose spelling out the storage-texture format a pipeline swaps",
    path: WGSL,
    flavour: "wgsl-runtime",
    before:
      "// Format-agnostic: the host picks the destination format.\n@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;\n",
    after:
      "// Format-agnostic: dstTex is declared texture_storage_2d_array<rgba16float, write>\n@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;\n",
    detail:
      /WebGPUIBLPipeline\.ts\|"texture_storage_2d_array<rgba16float, write>".*matches 1 time\(s\) in the old text and 2 in the new/,
    mutations: [READERS_OFF],
  },
  {
    // The capture group of an import reader names the chunk it pulls in.
    id: "the chunk a commented #import names is changed",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: '// #import "functions/csm_constants"\nfn main() {}\n',
    after: '// #import "functions/csm_constant"\nfn main() {}\n',
    detail: /#import.*reads different text at match 1/,
    mutations: [READERS_OFF],
  },
  {
    // The preprocessor applies its directive pattern to one trimmed line at a
    // time; over the whole text its `^` and `$` would never match.
    id: "a // #endif directive line added to WGSL",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: "// Plain note.\nfn main() {}\n",
    after: "// #endif\nfn main() {}\n",
    detail:
      /WGSLShaderPreprocessor\.ts\|\/\^.*#\(ifdef.*matches 0 time\(s\) in the old text and 1 in the new/,
    readerMutations: [
      [
        'perLine: body.startsWith("^") && !flags.includes("m"),',
        "perLine: false,",
      ],
    ],
  },
  {
    // `MaterialHelpers` declares a fabric uniform only when a regex built
    // from its type and name finds no declaration in the raw source, so
    // prose quoting one suppresses the real declaration.
    id: "GLSL material prose quoting a uniform declaration",
    path: GLSL,
    flavour: "glsl-runtime",
    before: `${MATERIAL_BODY}    float w = float(imageSize.x);\n    return w;\n}\n`,
    after: `${MATERIAL_BODY}    // Material.js prepends \`uniform ivec3 imageSize;\` for this.\n    float w = float(imageSize.x);\n    return w;\n}\n`,
    detail:
      /unharvested:material-uniform-declaration.*matches 0 time\(s\) in the old text and 1 in the new/,
    readerMutations: [
      [
        "    matcher: /uniform\\s+\\w+\\s+\\w+\\s*;/g,",
        "    matcher: /(?!)/g,",
      ],
    ],
  },
  {
    // A shadow receiver takes the first position varying name `ShaderSource`
    // finds anywhere in the source, comments included.
    id: "GLSL prose naming v_positionEC in a flat fragment shader",
    path: GLSL_FS,
    flavour: "glsl-runtime",
    before: `// Flat shading.\n${APPEARANCE_FS}`,
    after: `// Flat shading: no v_positionEC varying here.\n${APPEARANCE_FS}`,
    detail:
      /unharvested:shader-source-position-varying.*matches 0 time\(s\) in the old text and 1 in the new/,
    readerMutations: [
      ["    matcher: /v_positionEC/g,", "    matcher: /(?!)/g,"],
    ],
  },
  {
    // WebGPU OIT renames the entry point with regexes built from its name
    // that need `@fragment` and `fn` with only whitespace between.
    id: "a WGSL comment line between @fragment and fn",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: OIT_ENTRY.replace("@fragment\n", "// Lit output.\n@fragment\n"),
    after: OIT_ENTRY.replace("@fragment\n", "@fragment\n// Lit output.\n"),
    detail:
      /unharvested:oit-entry \(.*matches 1 time\(s\) in the old text and 0 in the new/,
    readerMutations: [UNHARVESTED_OFF],
  },
  {
    // WebGPU OIT takes a struct body from its `{` to the first `}` after it.
    id: "a WGSL comment holding braces inside a struct body",
    path: WGSL,
    flavour: "wgsl-runtime",
    before: OIT_ENTRY.replace(
      "struct FragOutput {\n",
      "struct FragOutput {\n    // One entry per render target.\n",
    ),
    after: OIT_ENTRY.replace(
      "struct FragOutput {\n",
      "struct FragOutput {\n    // One entry per render target: {color}.\n",
    ),
    detail:
      /unharvested:oit-struct-braces.*matches 4 time\(s\) in the old text and 6 in the new/,
    readerMutations: [UNHARVESTED_OFF],
  },
  {
    // The --minify build's GLSL tokenizer continues a `//` comment past a
    // trailing backslash, so the next line leaves the minified module.
    id: "a GLSL line comment ending in a backslash",
    path: GLSL,
    flavour: "glsl-minify",
    before:
      "vec3 f(vec3 c)\n{\n    // A diagram.\n    c.x = 1.0;\n    return c;\n}\n",
    after: `vec3 f(vec3 c)\n{\n    // A diagram: /${BACKSLASH}\n    c.x = 1.0;\n    return c;\n}\n`,
    detail: /minify-time GLSL comment strip leaves different code/,
    mutations: [MINIFY_CODE_OFF],
  },
  {
    // The same tokenizer closes a block comment at `/*` + `/`.
    id: "a GLSL block comment opened as /*/",
    path: GLSL,
    flavour: "glsl-minify",
    before: "vec3 f(vec3 c)\n{\n    /* Keeps black. */\n    return c;\n}\n",
    after: "vec3 f(vec3 c)\n{\n    /*/ Keeps black. */\n    return c;\n}\n",
    detail: /minify-time GLSL comment strip leaves different code/,
    mutations: [MINIFY_CODE_OFF],
  },
  {
    // It also keeps a comment on a `#` line in the minified module, where
    // the runtime readers read it.
    id: "a GLSL comment added on a directive line",
    path: GLSL,
    flavour: "glsl-minify",
    before: "#ifdef HDR\nfloat a = 1.0;\n#endif\n",
    after: "#ifdef HDR\nfloat a = 1.0;\n#endif // HDR only.\n",
    detail: /keeps different comment text in the module/,
    mutations: [
      disableFunction("glslMinifyCommentProblems(before, after)"),
      ['paired.push(...shaderReaderProblems(before, after, "glsl"));', ""],
    ],
  },
];

/** The branch in `flavourProblems` that owns each flavour. */
const FLAVOUR_BRANCH = {
  "glsl-runtime": 'if (flavour === "glsl-runtime") {',
  "wgsl-minify": 'if (flavour === "wgsl-minify") {',
  "release-pragma": 'if (flavour === "release-pragma") {',
};

for (const fixture of FLAVOUR_FIXTURES) {
  test(`REFUSED: ${fixture.id}`, async () => {
    const language = fixture.path.endsWith(".wgsl")
      ? "wgsl"
      : fixture.path.endsWith(".glsl")
        ? "glsl"
        : "js";
    assert.equal(
      canonicalizeCode(fixture.before, language),
      canonicalizeCode(fixture.after, language),
      "control: the tokenizer view alone calls this pair comment-only",
    );
    const result = compareSources(fixture.before, fixture.after, fixture.path);
    assert.equal(result.status, "flavour-differs");
    assert.equal(result.flavour, fixture.flavour);
    assert.match(result.detail, fixture.detail);

    let edits = fixture.mutations;
    if (edits === undefined && fixture.readerMutations === undefined) {
      const branch = FLAVOUR_BRANCH[fixture.flavour];
      edits = [[branch, branch.replace("if (", "if (false && ")]];
      if (fixture.flavour === "release-pragma") {
        // The release flavour is also compared before-against-after, so both
        // of its checks have to go for the pair to pass again.
        const comparison = 'flavourForPath(relPath) === "release-pragma" &&';
        edits.push([comparison, `false && ${comparison}`]);
      }
    }
    const overrides = {};
    if (fixture.readerMutations !== undefined) {
      edits = [];
      overrides["./shader-text-readers.mjs"] = await mutantUrl(
        "Tools/c16/lib/shader-text-readers.mjs",
        fixture.readerMutations,
      );
    }
    const mutant = await loadMutant(
      "Tools/c16/lib/flavour-views.mjs",
      edits,
      overrides,
    );
    assert.equal(
      mutant.compareFlavours(fixture.before, fixture.after, fixture.path),
      null,
      "with the flavour check unreachable the pair passes again",
    );
  });
}

/**
 * Pairs the source view refuses because a comment is read as code. The
 * mutation names the scanner text that makes it so.
 */
const SOURCE_FIXTURES = [
  {
    id: "own-line webpackIgnore deleted from an import()",
    path: JS,
    before:
      "export function load(resolveUrl) {\n  return import(\n    /* webpackIgnore: true */\n    resolveUrl()\n  );\n}\n",
    after:
      "export function load(resolveUrl) {\n  return import(\n    resolveUrl()\n  );\n}\n",
    anchor: 'id: "bundler-magic-comment",\n    shape: "any",',
    replacement: 'id: "bundler-magic-comment",\n    shape: "none",',
  },
  {
    id: "inline webpackIgnore replaced by prose",
    path: JS,
    before:
      "export const p = import(/* webpackIgnore: true */ resolveUrl());\n",
    after:
      "export const p = import(/* keep the glue external */ resolveUrl());\n",
    anchor: 'id: "bundler-magic-comment",\n    shape: "any",',
    replacement: 'id: "bundler-magic-comment",\n    shape: "none",',
  },
  {
    id: "multi-line block comment after return collapsed onto one line",
    path: JS,
    before:
      "export function f(x) {\n  return /* the value\n     below */ x;\n}\n",
    after: "export function f(x) {\n  return /* the value below */ x;\n}\n",
    anchor: "} else if (LINE_BREAK_CHARS.some((ch) => raw.includes(ch))) {",
    replacement:
      "} else if (false && LINE_BREAK_CHARS.some((ch) => raw.includes(ch))) {",
  },
  {
    id: "lint-debug-pragmas-allow prefix stripped",
    path: TS,
    before:
      'export function warn() {\n  // lint-debug-pragmas-allow: permanent sentinel for a broken frame.\n  console.warn("x");\n}\n',
    after:
      'export function warn() {\n  // Permanent sentinel for a broken frame.\n  console.warn("x");\n}\n',
    anchor: 'id: "lint-debug-pragmas-allow",\n    shape: "line",',
    replacement: 'id: "lint-debug-pragmas-allow",\n    shape: "none",',
  },
  {
    id: "/// <reference> directive removed",
    path: TS,
    before: '/// <reference types="@webgpu/types" />\nexport const x = 1;\n',
    after: "export const x = 1;\n",
    anchor: 'id: "typescript-reference",\n    shape: "line",',
    replacement: 'id: "typescript-reference",\n    shape: "none",',
  },
  {
    id: "a line separator inside a JS line comment ends it",
    path: JS,
    before: "export function f() {\n  // note\n  return 2;\n}\n",
    after: `export function f() {\n  // note${LINE_SEPARATOR}  return 1;\n  return 2;\n}\n`,
    anchor: "while (j < n && !LINE_COMMENT_ENDS.js.has(source[j])) {",
    replacement: 'while (j < n && source[j] !== "\\n") {',
  },
  {
    id: "a vertical tab inside a WGSL line comment ends it",
    path: WGSL,
    before:
      "fn main() {\n  let v = 1u;\n  // Write visibility flag\n  out = v;\n}\n",
    after: `fn main() {\n  let v = 1u;\n  // Write visibility flag${VERTICAL_TAB}return;\n  out = v;\n}\n`,
    anchor: "while (j < n && !lineCommentEnds.has(source[j])) {",
    replacement: 'while (j < n && source[j] !== "\\n") {',
  },
  {
    id: "@license added inside a JSDoc block",
    path: JS,
    before:
      "/**\n * Returns the sum.\n */\nexport function add(a, b) {\n  return a + b;\n}\n",
    after:
      "/**\n * Returns the sum. Not an @license header; see LICENSE.md.\n */\nexport function add(a, b) {\n  return a + b;\n}\n",
    anchor: 'id: "legal-comment",\n    shape: "any",',
    replacement: 'id: "legal-comment",\n    shape: "none",',
  },
  {
    id: "a //! line added",
    path: JS,
    before: "export function add(a, b) {\n  return a + b;\n}\n",
    after:
      "//! Returns the sum.\nexport function add(a, b) {\n  return a + b;\n}\n",
    anchor: 'id: "legal-comment",\n    shape: "any",',
    replacement: 'id: "legal-comment",\n    shape: "none",',
  },
  {
    id: "@license added inside a GLSL doc block",
    path: GLSL,
    before:
      "/**\n * Converts RGB to XYZ.\n */\nvec3 czm_subject(vec3 rgb)\n{\n    return rgb;\n}\n",
    after:
      "/**\n * Converts RGB to XYZ. No separate @license applies.\n */\nvec3 czm_subject(vec3 rgb)\n{\n    return rgb;\n}\n",
    anchor: 'id: "legal-comment",\n    shape: "any",',
    replacement: 'id: "legal-comment",\n    shape: "none",',
  },
  {
    id: "a source-map reference added",
    path: JS,
    before: "export const x = 1;\n",
    after: "export const x = 1;\n//# sourceMappingURL=subject.js.map\n",
    anchor: 'id: "source-map-comment",\n    shape: "any",',
    replacement: 'id: "source-map-comment",\n    shape: "none",',
  },
  {
    id: "/// @ts-expect-error added",
    path: TS,
    before: "export const n: number = 1;\n",
    after: "/// @ts-expect-error\nexport const n: number = 1;\n",
    anchor: "body: /^\\/?\\s*@(?:",
    replacement: "body: /^\\s*@(?:",
  },
  {
    // TypeScript lower-cases pragma names, so this turns checking off.
    id: "@TS-NOCHECK added in upper case",
    path: TS,
    before: "// Subject header.\nexport const s: string = 1;\n",
    after: "// Subject header.\n// @TS-NOCHECK\nexport const s: string = 1;\n",
    anchor: "[Tt][Ss]-(?:[Nn][Oo])?[Cc][Hh][Ee][Cc][Kk\\u212A](?!\\w)",
    replacement: "ts-(?:no)?check(?!\\w)",
  },
  {
    // Its lower-casing is the full Unicode mapping, under which the Kelvin
    // sign becomes an ASCII k.
    id: "@ts-nocheck added with a Kelvin sign for its last letter",
    path: TS,
    before: "// Subject header.\nexport const s: string = 1;\n",
    after: `// Subject header.\n// @ts-nochec${String.fromCharCode(0x212a)}\nexport const s: string = 1;\n`,
    anchor: "[Kk\\u212A](?!\\w)",
    replacement: "[Kk](?!\\w)",
  },
  {
    id: "an upper-case /// <REFERENCE> tag removed",
    path: TS,
    before: '/// <REFERENCE types="@webgpu/types" />\nexport const x = 1;\n',
    after: "export const x = 1;\n",
    anchor:
      "raw: /^\\/\\/\\/\\s*<(?:reference|amd-module|amd-dependency)\\b/i,",
    replacement:
      "raw: /^\\/\\/\\/\\s*<(?:reference|amd-module|amd-dependency)\\b/,",
  },
  {
    // After `default` a slash opens a regex; read as division, the
    // whitespace inside it would be normalised away.
    id: "whitespace inside a regex after export default",
    path: JS,
    before: "export default /a b/;\n",
    after: "export default /a  b/;\n",
    anchor: '  "default",\n',
    replacement: "",
  },
  {
    id: "@ts-ignored added (no word boundary after the suppression)",
    path: TS,
    before: "export const n: number = 1;\n",
    after:
      "// @ts-ignored until the typings land.\nexport const n: number = 1;\n",
    anchor: "|ts-ignore|ts-expect-error)/,",
    replacement: "|ts-ignore\\b|ts-expect-error\\b)/,",
  },
  {
    id: "@ts-ignore added on a doc block's last line",
    path: TS,
    before: "/**\n * Legacy overload.\n */\nexport const n: number = 1;\n",
    after:
      "/**\n * Legacy overload.\n * @ts-ignore */\nexport const n: number = 1;\n",
    anchor: 'id: "typescript-directive-last-line",\n    shape: "block",',
    replacement: 'id: "typescript-directive-last-line",\n    shape: "none",',
  },
];

for (const fixture of SOURCE_FIXTURES) {
  test(`REFUSED: ${fixture.id}`, async () => {
    const result = compareSources(fixture.before, fixture.after, fixture.path);
    assert.equal(result.status, "code-differs", JSON.stringify(result));
    const language = languageForPath(fixture.path);
    const mutant = await loadMutant("Tools/c16/lib/comment-scanner.mjs", [
      [fixture.anchor, fixture.replacement],
    ]);
    assert.equal(
      mutant.canonicalizeCode(fixture.before, language),
      mutant.canonicalizeCode(fixture.after, language),
      "with the rule made unreachable the pair reads comment-only again",
    );
  });
}

// ---------------------------------------------------------------------------
// The legitimate edits next to each refusal. A gate that refused everything
// would pass every test above.
// ---------------------------------------------------------------------------

test("PASSES: prose beside a live debug pragma is reworded", () => {
  const before = pragmaFile("  // Kept in release builds.");
  const after = pragmaFile(
    "  // A permanent sentinel: release builds keep this branch.",
  );
  assert.deepEqual(compareSources(before, after, TS), {
    status: "comment-only",
  });
});

test("PASSES: the reason after lint-debug-pragmas-allow is reworded", async () => {
  const before =
    'export function warn() {\n  // lint-debug-pragmas-allow: permanent sentinel (the fork rules).\n  console.warn("x");\n}\n';
  const after =
    'export function warn() {\n  // lint-debug-pragmas-allow: a broken frame must reach the console.\n  console.warn("x");\n}\n';
  assert.deepEqual(compareSources(before, after, TS), {
    status: "comment-only",
  });

  // Whole-comment retention would freeze the reason. Remove the prefix rule's
  // `retain` and require the freeze to come back.
  const mutant = await loadMutant("Tools/c16/lib/comment-scanner.mjs", [
    ["    retain: /^\\/\\/\\s*lint-debug-pragmas-allow\\b/,\n", ""],
  ]);
  assert.notEqual(
    mutant.canonicalizeCode(before, "js"),
    mutant.canonicalizeCode(after, "js"),
    "without prefix-only retention the reason text is frozen",
  );
});

test("PASSES: prose after a reference tag and prose naming webpackIgnore", () => {
  assert.deepEqual(
    compareSources(
      '/// <reference types="@webgpu/types" /> ambient GPU types\nexport const x = 1;\n',
      '/// <reference types="@webgpu/types" /> for the GPU* ambient types\nexport const x = 1;\n',
      TS,
    ),
    { status: "comment-only" },
  );
  assert.deepEqual(
    compareSources(
      "// Kept external (webpackIgnore) for bundler consumers.\nexport const p = import(/* webpackIgnore: true */ u());\n",
      "// External so bundlers do not inline the glue.\nexport const p = import(/* webpackIgnore: true */ u());\n",
      JS,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: a multi-line comment between statements is collapsed", () => {
  assert.deepEqual(
    compareSources(
      "const a = 1;\n/* Two lines\n   of prose. */\nconst b = 2;\n",
      "const a = 1;\n/* One line of prose. */\nconst b = 2;\n",
      JS,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: a GLSL doc block is reworded and stays multi-line", () => {
  assert.deepEqual(
    compareSources(
      "/**\n * Uses czm_computeAtmosphereColor.\n * @param {vec3} v The input.\n */\nvec3 czm_subject(vec3 v) {\n    return czm_computeAtmosphereColor(v);\n}\n// Batch 5 note\n",
      "/**\n * Returns the atmosphere colour of the input direction via\n * czm_computeAtmosphereColor.\n */\nvec3 czm_subject(vec3 v) {\n    return czm_computeAtmosphereColor(v);\n}\n// Output is linear.\n",
      GLSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: a WGSL block comment without nesting is reworded", () => {
  assert.deepEqual(
    compareSources(
      "/* Old wording. */\nfn main() {}\n",
      "/* Shaders under Shaders/WebGPU only.\n   Two lines. */\nfn main() {}\n",
      WGSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: prose above a next-line directive, and a comment line under a TS suppression, reworded", () => {
  assert.deepEqual(
    compareSources(
      "// Why the cast.\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst y = (x as any).y;\n",
      "// The cast is the documented escape hatch,\n// and it is scoped to one line.\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst y = (x as any).y;\n",
      TS,
    ),
    { status: "comment-only" },
  );
  assert.deepEqual(
    compareSources(
      "// @ts-expect-error The fixture is mistyped.\n// Old reason.\nexport const n: number = 's';\n",
      "// @ts-expect-error The fixture is mistyped.\n// A string on purpose.\nexport const n: number = 's';\n",
      TS,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: prose inside a subgroup section, and prose naming the sentinels without their spelling", () => {
  const block = (inner) =>
    `// __SUBGROUP_BLOCK_START__\n${inner}\nfn mainSubgroups() {}\n// __SUBGROUP_BLOCK_END__\n`;
  assert.deepEqual(
    compareSources(
      `// The section below is stripped on devices without subgroups.\nfn main() {}\n${block("// Old wording.")}`,
      `// The subgroup sentinel pair below is removed on devices without the feature.\nfn main() {}\n${block("// Ballot the visible lanes.")}`,
      WGSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: prose that already names a reader's needle is reworded around it", () => {
  assert.deepEqual(
    compareSources(
      `// The two halves differ. This file is a single \`void main()\`.\n${APPEARANCE_VS}`,
      `// The halves are shaped differently; this file is one \`void main()\`\n// with variants.\n${APPEARANCE_VS}`,
      GLSL_VS,
    ),
    { status: "comment-only" },
  );
  assert.deepEqual(
    compareSources(
      "// Old wording.\n@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;\n",
      "// The host picks the destination format at pipeline creation.\n@group(0) @binding(1) var dstTex: texture_storage_2d_array<rgba16float, write>;\n",
      WGSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: a first-line comment above a declaration, as the combined shader reads it", () => {
  // The stripped view starts on a new line, as ShaderSource's combined text
  // does, so a reader anchored on a preceding newline sees the same matches.
  assert.deepEqual(
    compareSources(
      APPEARANCE_VS,
      `// Per-instance colour.\n${APPEARANCE_VS}`,
      GLSL_VS,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: a WGSL line comment naming a czm_ function becomes a block comment", () => {
  // The czm_ harvest reads GLSL only; WGSL comments never reach it.
  assert.deepEqual(
    compareSources(
      "// Mirrors czm_computePosition.\nfn main() {}\n",
      "/* Mirrors czm_computePosition. */\nfn main() {}\n",
      WGSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: GLSL prose naming color more often, which a global rename only rewrites", () => {
  assert.deepEqual(
    compareSources(
      `// Output colour.\n${APPEARANCE_VS}`,
      `// Output color: the per-instance color, then the batch color.\n${APPEARANCE_VS}`,
      GLSL_VS,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: prose naming a word that only an exempt reader matches", () => {
  // `WebGPURenderTarget` tests a texture format name for "stencil"; prose
  // about stencils in a shader is not read by it.
  assert.deepEqual(
    compareSources(
      "// Depth only.\nfn main() {}\n",
      "// Depth only; the stencil aspect is cleared by the host.\nfn main() {}\n",
      WGSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: GLSL prose with braces, which only a WebGPU reader would read", () => {
  // The OIT struct-body scan runs on WGSL only.
  assert.deepEqual(
    compareSources(
      "// Tints the colour.\nfloat f;\n",
      "// Tints the colour: {r, g, b} scaled by the tint.\nfloat f;\n",
      GLSL,
    ),
    { status: "comment-only" },
  );
});

test("PASSES: WGSL prose about a struct's layout, which names no struct", () => {
  assert.deepEqual(
    compareSources(
      "// Host-packed.\nfn main() {}\n",
      "// Host-packed: the struct layout matches the uniform buffer.\nfn main() {}\n",
      WGSL,
    ),
    { status: "comment-only" },
  );
});

// ---------------------------------------------------------------------------
// The harvest reads a reader's meaning, not its spelling.
// ---------------------------------------------------------------------------

test("a comment reader spelled with [/][/] is harvested like one spelled with an escape", async () => {
  const respelled =
    "const MARKER = /^\\s*[/][/].*@chunk\\s+csm_samplePointShadow\\b/m;\n";
  const escaped =
    "const MARKER = /^\\s*\\/\\/.*@chunk\\s+csm_samplePointShadow\\b/m;\n";
  const prose =
    "// Opts into `@chunk csm_samplePointShadow` for the lit variant.\n";
  for (const source of [respelled, escaped]) {
    const readers = readersInSource("Renderer/WebGPU/Subject.js", source);
    assert.equal(readers.length, 1, source);
    assert.equal(readerSpans(readers[0], prose).length, 1, source);
  }
  const live = shaderTextReaders().find((reader) =>
    reader.key.includes("@chunk\\s+csm_samplePointShadow"),
  );
  assert.equal(live?.use, "decides", "the live marker reader is classified");

  // A harvest that looked for the escaped spelling would lose the reader.
  const mutant = await loadMutant("Tools/c16/lib/shader-text-readers.mjs", [
    [
      "if (literalWords(body).length === 0) {",
      'if (literalWords(body).length === 0 || !body.includes("\\\\/\\\\/")) {',
    ],
  ]);
  assert.equal(
    mutant.readersInSource("Renderer/WebGPU/Subject.js", respelled).length,
    0,
    "with a spelling-based harvest the respelled reader is lost",
  );
  assert.equal(
    mutant.readersInSource("Renderer/WebGPU/Subject.js", escaped).length,
    1,
  );
});

test("a needle held in a const, or behind a comment, is harvested as its literal is", async () => {
  const subject = "Renderer/WebGPU/Subject.js";
  const needle = '"@chunk functions/csm_polylineCommon"';
  const literal = `if (line.includes(${needle})) {}\n`;
  const viaConst = `const MARKER = ${needle};\nif (line.includes(MARKER)) {}\n`;
  const viaComment = `if (line.includes(/* the marker */ ${needle})) {}\n`;
  const keys = (source) =>
    readersInSource(subject, source).map((reader) => reader.key);
  assert.equal(keys(literal).length, 1);
  assert.deepEqual(keys(viaConst), keys(literal));
  assert.deepEqual(keys(viaComment), keys(literal));
  assert.deepEqual(
    keys(`const PART = "@chunk " + "functions";\nline.includes(PART);\n`),
    [],
    "a const built by concatenation is not a literal needle",
  );

  const noConst = await loadMutant("Tools/c16/lib/shader-text-readers.mjs", [
    [
      "    constants.set(declared[1], unescapeLiteral(literal.slice(1, -1)));",
      "    void declared;",
    ],
  ]);
  assert.equal(noConst.readersInSource(subject, viaConst).length, 0);
  const noSkip = await loadMutant("Tools/c16/lib/shader-text-readers.mjs", [
    ["    while (\n      before >= 0 &&", "    while (\n      false &&"],
  ]);
  assert.equal(noSkip.readersInSource(subject, viaComment).length, 0);
});

/** A WGSL and a GLSL comment edit no reader reads. */
const PLAIN_EDITS = [
  [
    WGSL,
    "// Plain note.\nfn main() {}\n",
    "// A plainer note.\nfn main() {}\n",
  ],
  [GLSL, "// Plain note.\nfloat f;\n", "// A plainer note.\nfloat f;\n"],
];

test("a regex built at runtime is a site the model must classify, or no shader comment edit passes", async () => {
  const subject = "Renderer/WebGPU/Subject.js";
  for (const source of [
    'const R = new RegExp("^.*@chunk functions/csm_polylineCommon", "m");\n',
    'const C = "functions/csm_polylineCommon";\nconst R = new RegExp(`^.*@chunk ${C}`, "m");\n',
  ]) {
    const sites = runtimeRegexSitesInSource(subject, source);
    assert.equal(sites.length, 1, source);
    assert.equal(RUNTIME_REGEX_USES[sites[0].key], undefined, source);
  }
  assert.deepEqual(readerModelGaps(), [], "the live model is complete");
  for (const [relPath, before, after] of PLAIN_EDITS) {
    assert.equal(compareFlavours(before, after, relPath), null, relPath);
  }

  // A live site whose row no longer matches it is unclassified.
  const readers = await mutantUrl("Tools/c16/lib/shader-text-readers.mjs", [
    ['"RegExp(pattern, flags)",', '"RegExp(pattern)",'],
  ]);
  const views = await loadMutant("Tools/c16/lib/flavour-views.mjs", [], {
    "./shader-text-readers.mjs": readers,
  });
  for (const [relPath, before, after] of PLAIN_EDITS) {
    const result = views.compareFlavours(before, after, relPath);
    assert.equal(result?.status, "flavour-differs", relPath);
    assert.match(
      result.detail,
      /unclassified runtime-built reader Scene\/Expression\.js\|RegExp\(pattern, flags\)/,
    );
  }
  const unguarded = await loadMutant(
    "Tools/c16/lib/flavour-views.mjs",
    [
      [
        "  const problems = readerModelGaps().map((gap) => ({",
        "  const problems = [].map((gap) => ({",
      ],
    ],
    { "./shader-text-readers.mjs": readers },
  );
  for (const [relPath, before, after] of PLAIN_EDITS) {
    assert.equal(unguarded.compareFlavours(before, after, relPath), null);
  }
});

test("a hand-written reader whose source text is gone refuses every shader comment edit", async () => {
  const pin = 'const positionVaryingNames = ["v_positionEC"];';
  const moved = [pin, 'const positionVaryingNames = ["v_positionEC", "v_x"];'];
  const readers = await loadMutant("Tools/c16/lib/shader-text-readers.mjs", [
    moved,
  ]);
  assert.match(
    readers.readerModelGaps().join("\n"),
    /shader-source-position-varying no longer finds its source text/,
  );
  const views = await loadMutant("Tools/c16/lib/flavour-views.mjs", [], {
    "./shader-text-readers.mjs": await mutantUrl(
      "Tools/c16/lib/shader-text-readers.mjs",
      [moved],
    ),
  });
  const [relPath, before, after] = PLAIN_EDITS[1];
  assert.equal(
    views.compareFlavours(before, after, relPath)?.status,
    "flavour-differs",
  );
  const unpinned = await loadMutant("Tools/c16/lib/shader-text-readers.mjs", [
    moved,
    [
      "missingPins = UNHARVESTED_READERS.flatMap((reader) =>",
      "missingPins = [].flatMap((reader) =>",
    ],
  ]);
  assert.deepEqual(unpinned.readerModelGaps(), []);
});

test("every hand-written reader is tied to its source, and every modelled site names one", () => {
  const ids = new Set(UNHARVESTED_READER_IDS);
  const named = new Set();
  for (const [key, entry] of Object.entries(RUNTIME_REGEX_USES)) {
    assert.ok(
      ["modelled", "benign", "unrelated"].includes(entry.use),
      `${key}: ${entry.use}`,
    );
    assert.ok(entry.detail?.length > 0, `${key} has no detail`);
    if (entry.use === "modelled") {
      assert.ok(ids.has(entry.detail), `${key} names ${entry.detail}`);
      named.add(entry.detail);
    }
  }
  for (const reader of shaderTextReaders().filter((r) => r.unharvested)) {
    const id = reader.key.split("|unharvested:")[1];
    assert.ok(
      named.has(id) || reader.pinned,
      `${id} is tied to no site and no pin`,
    );
    assert.ok(["glsl", "wgsl"].includes(reader.language), id);
  }
});

// ---------------------------------------------------------------------------
// The vendored and mirrored transforms stay pinned to their sources.
// ---------------------------------------------------------------------------

test("the shader license-block pattern is byte-equal to the build's", async () => {
  const build = await readLf("scripts/build.js");
  assert.equal(
    build.split(
      `contents.match(\n        ${SHADER_LICENSE_BLOCK_PATTERN},\n      )`,
    ).length - 1,
    2,
    "the GLSL and WGSL module writers no longer both extract license blocks with this pattern",
  );
});

test("the vendored GLSL comment strip is byte-equal to ShaderSource's", async () => {
  const engine = await readLf(
    "packages/engine/Source/Renderer/ShaderSource.js",
  );
  const start = engine.indexOf("function removeComments(source) {");
  assert.ok(start >= 0, "ShaderSource no longer declares removeComments");
  const end = engine.indexOf("\n}\n", start);
  const engineCopy = engine.slice(start, end + 2);
  assert.equal(
    glslRuntimeCommentStrip.toString().replace(/\r\n/g, "\n"),
    engineCopy,
    "the engine's removeComments changed; re-vendor it and re-run the corpus spec",
  );
  assert.ok(
    engine.includes(`.glslSource.match(${CZM_TOKEN_PATTERN.toString()});`),
    "the engine's czm_ dependency harvest changed",
  );
});

test("the vendored WGSL preprocessor comment strip equals the engine's as trimmed non-blank lines", async () => {
  const engine = await readLf(
    "packages/engine/Source/Renderer/WebGPU/WGSLShaderPreprocessor.ts",
  );
  const header = "  static removeComments(source: string): string {\n";
  const start = engine.indexOf(header);
  assert.ok(
    start >= 0,
    "WGSLShaderPreprocessor no longer declares removeComments",
  );
  const end = engine.indexOf("\n  }\n", start);
  const body = (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n");
  const engineBody = body(engine.slice(start + header.length, end));
  const vendored = wgslPreprocessorCommentStrip
    .toString()
    .replace(/\r\n/g, "\n");
  const vendoredBody = body(
    vendored.slice(vendored.indexOf("{") + 1, vendored.lastIndexOf("}")),
  );
  assert.equal(
    vendoredBody,
    engineBody,
    "the engine's WGSL preprocessor removeComments changed; re-vendor it",
  );
});

test("the release pragma view mirrors the build's plugin", async () => {
  const build = await readLf("scripts/build.js");
  assert.ok(
    build.includes(`build.onLoad({ filter: ${RELEASE_PRAGMA_FILTER} }`),
    "the release pragma plugin's file filter changed",
  );
  assert.ok(
    build.includes(
      'source = source.replace(constructRegex(key, pragmas[key]), "");',
    ),
    "the release pragma plugin no longer applies constructRegex over pragmas",
  );
});

test("the view reports nothing for an unaffected extension", () => {
  assert.equal(
    compareFlavours("// a\nx();\n", "// b\nx();\n", "Tools/x.mjs"),
    null,
  );
});

// ---------------------------------------------------------------------------
// Bundler annotations in the corpus: every one is protected, and the set of
// annotation kinds the corpus uses is pinned so a new kind is noticed.
// ---------------------------------------------------------------------------

test("every bundler annotation in scope is retained, and the kinds are pinned", async () => {
  const files = await collectScopeFiles();
  const kinds = new Set();
  const unprotected = [];
  let count = 0;
  for (const relPath of files) {
    if (!/\.[jt]s$/.test(relPath)) {
      continue;
    }
    const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
    for (const comment of extractComments(source, "js")) {
      const token = comment.text.match(
        /webpack[A-Z][A-Za-z]*(?=\s*:)|@vite-ignore|[@#]__(?:PURE|NO_SIDE_EFFECTS)__/,
      );
      if (token === null || !comment.block) {
        continue;
      }
      const body = comment.text.slice(2, -2).trim();
      if (!body.startsWith(token[0])) {
        continue;
      }
      count += 1;
      kinds.add(token[0]);
      if (classifySemanticComment(comment.text) !== "bundler-magic-comment") {
        unprotected.push(`${relPath}:${comment.line}`);
      }
    }
  }
  assert.deepEqual(unprotected, []);
  assert.deepEqual(
    [...kinds].sort(),
    ["@vite-ignore", "webpackIgnore"],
    "a new annotation kind appeared; confirm the rule covers what it means",
  );
  assert.ok(count >= 9, `expected the known annotations, found ${count}`);
});

// ---------------------------------------------------------------------------
// The marker grammar reads no label inside a link target.
// ---------------------------------------------------------------------------

test("a label-shaped token inside a URL is not a finding; one outside still is", async () => {
  const relPath = "packages/engine/Source/Core/IonSnapMode.js";
  const source = await fs.readFile(path.join(ROOT, relPath), "utf8");
  assert.match(source, /GUID-77D54C0B-D6FF-13DA-5EC8-3196330F5244/);
  assert.deepEqual(scanSource(relPath, source), []);

  const mixed =
    "// See {@link https://docs.example.com/GUID-AAAA-BBBB-CCCC.html|docs}; POINT-SPRITE-SHAPE owns this.";
  assert.deepEqual(
    findMarkers(mixed).map((finding) => finding.match),
    ["POINT-SPRITE-SHAPE"],
  );
  assert.deepEqual(
    findMarkers("// https://example.com/ and then POINT-SPRITE-SHAPE").map(
      (finding) => finding.match,
    ),
    ["POINT-SPRITE-SHAPE"],
    "the URL ends at whitespace; a label after it is still read",
  );
  assert.deepEqual(
    findMarkers(
      "// (https://example.com/a)POINT-SPRITE-SHAPE, https://example.com/b,FEAT-GLOBE-FOG",
    ).map((finding) => finding.match),
    ["POINT-SPRITE-SHAPE", "FEAT-GLOBE-FOG"],
    "a label joined to a URL by a parenthesis or a comma is still read",
  );

  const mutant = await loadMutant("Tools/c16/lib/marker-grammar.mjs", [
    [
      "rule.skipInsideUrl === true ? urlSpans(text) : []",
      "false && rule.skipInsideUrl === true ? urlSpans(text) : []",
    ],
  ]);
  assert.deepEqual(
    mutant.findMarkers(source).map((finding) => finding.ruleId),
    ["all-caps-fix-label"],
    "without the URL skip the upstream GUID is flagged again",
  );
  assert.ok(
    mutant.selfTestRules().includes("all-caps-fix-label"),
    "and the rule's own counter-examples report it",
  );
});

test("a counter-example that matches breaks the self-test", () => {
  assert.deepEqual(
    selfTestRules([
      {
        id: "overmatch",
        pattern: /[A-Z]+-[A-Z]+-[A-Z]+/g,
        example: "POINT-SPRITE-SHAPE",
        counterExamples: ["https://example.com/GUID-ABC-DEF"],
      },
    ]),
    ["overmatch"],
    "no skipInsideUrl, so the counter-example is a finding",
  );
  assert.deepEqual(
    selfTestRules([
      {
        id: "narrowed",
        pattern: /[A-Z]+-[A-Z]+-[A-Z]+/g,
        example: "POINT-SPRITE-SHAPE",
        skipInsideUrl: true,
        counterExamples: ["https://example.com/GUID-ABC-DEF"],
      },
    ]),
    [],
  );
});
