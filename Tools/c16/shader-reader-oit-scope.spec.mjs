// shader-reader-oit-scope.spec.mjs — the comment-only gate on a comment inside a WGSL fragment entry's parameter list.
// @purpose Pins that a comment edit inside the fragment-entry parameter list of a WGSL shader the WebGPU OIT transform can never be handed is comment-only, that the same edit in a shader it can be handed is flavour-differs (wgsl-runtime, oit-entry-parameters), that a non-comment parameter edit is code-differs in both, that the derived scope is the same in a built and an unbuilt tree (a generated X.js read as its X.wgsl, static and dynamic imports followed), and that the scoping fails closed (no path, an unclassified site that feeds shader text to OIT, an empty target set, an OIT input whose imports reach no WGSL).
// @status ACTIVE
//
// Run: node --test Tools/c16/shader-reader-oit-scope.spec.mjs
//
// THE CLASS. `WebGPUOIT.injectOITOutput` copies the fragment entry's
// parameter list into the signature it builds, so a comment inside that list
// is code for a shader the transform processes, and the gate refuses an edit
// there. The refusal used to apply to every WGSL file, including
// `Globe/GlobeTerrain.wgsl`, whose fragment entry carries a long comment in
// its list and which no OIT path is given. Scoping the refusal has to leave
// the shaders OIT can be handed refused, and has to fail closed when the
// engine feeds OIT from a place the gate has not classified or when the
// derived set comes out empty (a built tree once resolved every shader import
// to the generated `X.js` and emptied it). Everything here
// is asserted through `compareSources` (and `shaderReaderProblems` where the
// question is what the reader does with no path); the scope itself is derived
// from the engine source by `lib/oit-reach.mjs`, never listed here.
//
// Each refusal is checked against a copy of the gate with the mechanism made
// unreachable, which must let the pair through again; each acceptance is
// checked against a copy with the scoping removed, which must refuse it.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { compareSources } from "./comment-only-diff.mjs";
import { shaderReaderProblems } from "./lib/flavour-views.mjs";
import {
  inOitReach,
  oitReachCensus,
  oitReachSites,
  oitReachTargets,
  oitSitesInSource,
} from "./lib/oit-reach.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHADERS = "packages/engine/Source/Shaders/WebGPU/";
const GLOBE = `${SHADERS}Globe/GlobeTerrain.wgsl`;
const BILLBOARD = `${SHADERS}Collections/BillboardCollection.wgsl`;
const ONE_LINE_ENTRY = "fn fragmentMain(input: VertexOutput) -> FragOutput {";
const SPREAD_ENTRY =
  "fn fragmentMain(\n  input: VertexOutput,\n) -> FragOutput {";

/**
 * The data URL of a copy of a module with anchors replaced. Relative imports
 * and `import.meta.url` point at the original files, so the copy loads
 * without writing anything to disk.
 *
 * @param {string} relPath Repo-relative module path.
 * @param {Array<[string, string]>} edits `[anchor, replacement]` pairs; each
 *   anchor must occur exactly once.
 * @param {Record<string, string>} [overrides] Relative import specifiers to
 *   load from another URL instead.
 * @returns {Promise<string>} Data URL.
 */
async function mutantUrl(relPath, edits, overrides = {}) {
  let mutated = (await fs.readFile(path.join(ROOT, relPath), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
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

/**
 * The gate built from copies of the three modules that decide the question.
 *
 * @param {{reach?: Array<[string, string]>, readers?: Array<[string, string]>, views?: Array<[string, string]>}} edits
 *   Edits to `oit-reach.mjs`, `shader-text-readers.mjs` and `flavour-views.mjs`.
 * @returns {Promise<{compareSources: Function, shaderReaderProblems: Function}>}
 *   The copy's public functions.
 */
async function gateWith({ reach = [], readers = [], views = [] }) {
  const reachUrl = await mutantUrl("Tools/c16/lib/oit-reach.mjs", reach);
  const readersUrl = await mutantUrl(
    "Tools/c16/lib/shader-text-readers.mjs",
    readers,
    {
      "./oit-reach.mjs": reachUrl,
    },
  );
  const viewsUrl = await mutantUrl("Tools/c16/lib/flavour-views.mjs", views, {
    "./shader-text-readers.mjs": readersUrl,
  });
  const gate = await import(
    await mutantUrl("Tools/c16/comment-only-diff.mjs", [], {
      "./lib/flavour-views.mjs": viewsUrl,
    })
  );
  const flavourViews = await import(viewsUrl);
  return {
    compareSources: gate.compareSources,
    shaderReaderProblems: flavourViews.shaderReaderProblems,
  };
}

/**
 * Writes files under a directory, creating their folders.
 *
 * @param {string} directory Root of the tree.
 * @param {Record<string, string>} files Text by path relative to the root.
 */
async function writeTree(directory, files) {
  for (const [relPath, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, relPath)), {
      recursive: true,
    });
    await fs.writeFile(path.join(directory, relPath), text);
  }
}

/** Reads a repository file with LF line endings. */
async function readLf(relPath) {
  return (await fs.readFile(path.join(ROOT, relPath), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

/**
 * The fragment entry's parameter list in a shader: from the `(` after
 * `@fragment fn fragmentMain` to the `)` that closes it, which is found past
 * the line comments inside the list (one of them holds a `)`).
 *
 * @param {string} text Shader text.
 * @returns {{open: number, close: number}} Offsets of both parentheses.
 */
function fragmentParameterList(text) {
  const entry = text.indexOf("@fragment\nfn fragmentMain(");
  assert.ok(entry >= 0, "the shader has a fragmentMain entry");
  const open = text.indexOf("(", entry);
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text.startsWith("//", at)) {
      at = text.indexOf("\n", at);
    } else if (text[at] === "(") {
      depth += 1;
    } else if (text[at] === ")" && --depth === 0) {
      return { open, close: at };
    }
  }
  throw new Error("the fragment entry's parameter list does not close");
}

/** The GlobeTerrain edits: reword, add and remove a comment in the list. */
async function globeEdits() {
  const base = await readLf(GLOBE);
  const { open, close } = fragmentParameterList(base);
  const list = base.slice(open, close);
  const note = list.match(/^( *)\/\/ (.+)$/m);
  assert.ok(note, "GlobeTerrain's fragment parameter list holds a comment");
  const edit = (replacement) =>
    base.slice(0, open) +
    list.replace(note[0], replacement) +
    base.slice(close);
  return {
    base,
    reworded: edit(`${note[1]}// ${note[2].replace(/^\S+/, "Reworded")}`),
    added: edit(`${note[1]}// An added note.\n${note[0]}`),
    removed: edit(""),
  };
}

test("derived reach: the shaders OIT is handed, and none of the globe's", () => {
  const targets = oitReachTargets();
  assert.ok(targets.includes(BILLBOARD), "the billboard colour shader");
  assert.ok(
    targets.some((target) => target.startsWith(`${SHADERS}Primitive/`)),
    "the primitive colour shaders",
  );
  assert.deepEqual(
    targets.filter((target) => target.includes("/Globe/")),
    [],
    "no globe shader is reachable by an OIT path",
  );
  assert.equal(inOitReach(BILLBOARD), true);
  assert.equal(inOitReach(GLOBE), false);
  assert.equal(inOitReach(undefined), true, "no path: in reach");
  assert.equal(inOitReach(""), true, "an empty path: in reach");
  assert.equal(
    inOitReach(`./${GLOBE.replace(/\//g, "\\")}`),
    false,
    "the globe's path, spelt with backslashes and a leading ./",
  );
  assert.equal(
    inOitReach(path.join(ROOT, GLOBE)),
    true,
    "an absolute path cannot be placed in the repository: in reach",
  );
  assert.equal(
    inOitReach(`../${GLOBE}`),
    true,
    "a path outside the repository root: in reach",
  );
});

test("the census sees every site the engine uses to feed OIT, and every site is classified", () => {
  const sites = oitReachSites();
  assert.deepEqual(
    sites.filter((site) => site.use === undefined).map((site) => site.key),
    [],
  );
  const writers = sites.filter((site) => site.use === "oit-input");
  assert.equal(writers.length, 7, "the seven draw-command writers");
  assert.ok(
    sites.some(
      (site) =>
        site.use === "oit-relay" &&
        site.key.includes("host._oit.createOITPipeline("),
    ),
    "the translucent pass's relay of a command's text",
  );
  assert.deepEqual(oitReachCensus().gaps, []);
});

test("PASSES: a comment inside the fragment entry's parameter list of a shader OIT cannot be handed", async () => {
  const { base, reworded, added, removed } = await globeEdits();
  for (const [name, after] of Object.entries({ reworded, added, removed })) {
    assert.notEqual(after, base, name);
    assert.deepEqual(
      compareSources(base, after, GLOBE),
      { status: "comment-only" },
      `${name}: the globe fragment entry's comment`,
    );
  }
});

test("REFUSED: the same comment edit in a shader OIT can be handed", async () => {
  const raw = await readLf(BILLBOARD);
  assert.equal(raw.split(ONE_LINE_ENTRY).length, 2, "the billboard entry");
  // The base must already be spread over lines: going from the one-line form
  // is a whitespace change the canonical form sees.
  const base = raw.replace(ONE_LINE_ENTRY, SPREAD_ENTRY);
  for (const [name, after] of Object.entries({
    added: base.replace(
      "fn fragmentMain(\n",
      "fn fragmentMain(\n  // A note.\n",
    ),
    "added after the parameter": base.replace(
      "input: VertexOutput,\n",
      "input: VertexOutput,\n  // A trailing note.\n",
    ),
  })) {
    const result = compareSources(base, after, BILLBOARD);
    assert.equal(result.status, "flavour-differs", name);
    assert.equal(result.flavour, "wgsl-runtime", name);
    assert.match(result.detail, /oit-entry-parameters/, name);
  }
});

test("a non-comment edit to the parameter list is code-differs in a shader OIT can and cannot be handed", async () => {
  for (const [relPath, raw, entry, edits] of [
    [
      BILLBOARD,
      await readLf(BILLBOARD),
      ONE_LINE_ENTRY,
      [
        "fn fragmentMain(frag: VertexOutput) -> FragOutput {",
        "fn fragmentMain(input: VertexOutputB) -> FragOutput {",
        "fn fragmentMain(input: VertexOutput, extra: f32) -> FragOutput {",
      ],
    ],
    [
      GLOBE,
      await readLf(GLOBE),
      "  input: VertexOutput,\n",
      [
        "  frag: VertexOutput,\n",
        "  input: VertexOutputB,\n",
        "  input: VertexOutput,\n  extra: f32,\n",
      ],
    ],
  ]) {
    assert.ok(raw.includes(entry), `${relPath} holds ${entry}`);
    for (const edit of edits) {
      const result = compareSources(raw, raw.replace(entry, edit), relPath);
      assert.equal(result.status, "code-differs", `${relPath}: ${edit}`);
    }
  }
});

test("fails closed: with no path the reader still refuses the edit it would excuse", async () => {
  const { base, reworded } = await globeEdits();
  const names = (problems) => problems.map((problem) => problem.detail).join();
  assert.match(
    names(shaderReaderProblems(base, reworded, "wgsl")),
    /oit-entry-parameters/,
    "no path",
  );
  assert.match(
    names(shaderReaderProblems(base, reworded, "wgsl", "")),
    /oit-entry-parameters/,
    "an empty path",
  );
  assert.deepEqual(
    shaderReaderProblems(base, reworded, "wgsl", GLOBE),
    [],
    "the globe's path",
  );
  const raw = await readLf(BILLBOARD);
  const spread = raw.replace(ONE_LINE_ENTRY, SPREAD_ENTRY);
  assert.match(
    names(
      shaderReaderProblems(
        spread,
        spread.replace(
          "fn fragmentMain(\n",
          "fn fragmentMain(\n  // A note.\n",
        ),
        "wgsl",
      ),
    ),
    /oit-entry-parameters/,
    "an in-set edit with no path",
  );
});

test("fails closed: a site that feeds shader text to OIT and is not classified refuses every WGSL comment edit", async () => {
  const { base, reworded } = await globeEdits();
  assert.equal(compareSources(base, reworded, GLOBE).status, "comment-only");
  // The row that classifies the polyline writer no longer matches its site,
  // which is what a new or reworded writer looks like to the census.
  const gate = await gateWith({
    reach: [
      [
        '"cmd._shaderCode = pipelineResult.oitShaderCode",',
        '"cmd._shaderCode = pipelineResult.oitShaderCodeRenamed",',
      ],
    ],
  });
  const result = gate.compareSources(base, reworded, GLOBE);
  assert.equal(result.status, "flavour-differs");
  assert.equal(result.flavour, "wgsl-runtime");
  assert.match(
    result.detail,
    /unclassified OIT shader-text site Renderer\/WebGPU\/WebGPUPolylineRenderer\.js\|cmd\._shaderCode = pipelineResult\.oitShaderCode/,
  );
  // A comment edit nowhere near a parameter list is refused too.
  const prose = gate.compareSources(base, `// A note.\n${base}`, GLOBE);
  assert.equal(prose.status, "flavour-differs");
});

test("the census reads a source file the way the engine writes to OIT", () => {
  const sites = (source) =>
    oitSitesInSource("Renderer/Subject.js", source).map((site) => site.key);
  assert.deepEqual(sites("const code = cmd._shaderCode;\n"), [], "a read");
  assert.deepEqual(
    sites("// cmd._shaderCode = x;\n/* host._oit.createOITPipeline(a) */\n"),
    [],
    "comments",
  );
  assert.deepEqual(sites("cmd._shaderCode = a ?? b;\n"), [
    "Renderer/Subject.js|cmd._shaderCode = a ?? b",
  ]);
  assert.deepEqual(sites("cmd._shaderCode ||= text;\n"), [
    "Renderer/Subject.js|cmd._shaderCode = text",
  ]);
  assert.equal(sites("cmd._shaderCode == text;\n").length, 0, "a comparison");
  assert.equal(sites('cmd["_shaderCode"] = text;\n').length, 1, "a string key");
  assert.equal(
    sites("const c = { _shaderCode: text };\n").length,
    1,
    "a literal",
  );
  assert.equal(
    sites("const { _shaderCode } = cmd;\n").length,
    1,
    "destructured",
  );
  assert.equal(
    sites("const f = WebGPUOIT.injectOITOutput;\n").length,
    1,
    "an alias of the transform",
  );
  assert.equal(
    sites("oit.createOITPipeline(device, code, config);\n").length,
    1,
    "a call of the generic path",
  );
});

test("the census of a tree with an unclassified writer, or with no OIT at all, has gaps", () =>
  withLaneTmp("oit-reach-", async (directory) => {
    await writeTree(directory, {
      "Renderer/NewWriter.js":
        "export function f(cmd, text) {\n  cmd._shaderCode = text;\n}\n",
    });
    const census = oitReachCensus(directory);
    assert.ok(
      census.gaps.some((gap) =>
        gap.includes("Renderer/NewWriter.js|cmd._shaderCode = text"),
      ),
      census.gaps.join("\n"),
    );
    assert.ok(
      census.gaps.some((gap) =>
        /finds no site that stores shader text/.test(gap),
      ),
      "with no classified writer the reach would be empty, which is a gap",
    );
    assert.ok(
      census.gaps.some((gap) =>
        /no longer finds the definition of injectOITOutput/.test(gap),
      ),
    );
    assert.deepEqual(census.targets, []);
    assert.ok(
      census.gaps.some((gap) => /derives no WGSL file/.test(gap)),
      "an empty target set is a gap",
    );
  }));

// A tree with the real transform host and two classified writers. `built`
// adds the module the build generates beside each shader, which a built
// checkout has and an unbuilt one does not; the targets must not change.
async function writerTree(directory, { built, pointImports }) {
  const collections = "Shaders/WebGPU/Collections/";
  const files = {
    "Renderer/WebGPU/WebGPUOIT.ts": await readLf(
      "packages/engine/Source/Renderer/WebGPU/WebGPUOIT.ts",
    ),
    "Renderer/WebGPU/WebGPUPolylineRenderer.js": [
      `import X from "../../${collections}X.js";`,
      "export function f(cmd, pipelineResult) {",
      "  cmd._shaderCode = pipelineResult.oitShaderCode;",
      "  return X;",
      "}",
      "",
    ].join("\n"),
    "Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js": [
      "export async function f(cache, pipelineEntry) {",
      pointImports
        ? `  const Y = await import("../../${collections}Y.js");`
        : "  const Y = undefined;",
      "  cache.colorCommand._shaderCode = pipelineEntry.oitShaderCode;",
      "  return Y;",
      "}",
      "",
    ].join("\n"),
    [`${collections}X.wgsl`]: "@fragment\nfn fragmentMain() {}\n",
    [`${collections}Y.wgsl`]: "@fragment\nfn fragmentMain() {}\n",
  };
  if (built) {
    for (const name of ["X", "Y"]) {
      files[`${collections}${name}.js`] =
        '//This file is automatically rebuilt by the Cesium build process.\nexport default "@fragment\\n\\\nfn fragmentMain() {}\\n\\\n";\n';
    }
  }
  await writeTree(directory, files);
}

test("built or not: a generated shader module is read as its WGSL source, so the target set does not depend on the build", async () => {
  for (const built of [false, true]) {
    await withLaneTmp("oit-reach-", async (directory) => {
      await writerTree(directory, { built, pointImports: true });
      const census = oitReachCensus(directory);
      assert.deepEqual(census.gaps, [], `built=${built}`);
      assert.deepEqual(
        census.targets,
        [
          "packages/engine/Source/Shaders/WebGPU/Collections/X.wgsl",
          "packages/engine/Source/Shaders/WebGPU/Collections/Y.wgsl",
        ],
        `built=${built}: X by a static import, Y by a dynamic import()`,
      );
    });
  }
});

test("fails closed: an OIT input whose imports reach no WGSL file is a gap, even when another input's do", () =>
  withLaneTmp("oit-reach-", async (directory) => {
    await writerTree(directory, { built: true, pointImports: false });
    const census = oitReachCensus(directory);
    assert.deepEqual(census.targets, [
      "packages/engine/Source/Shaders/WebGPU/Collections/X.wgsl",
    ]);
    assert.deepEqual(census.gaps, [
      "the OIT input Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js reaches no WGSL file by its imports, so the shaders it hands OIT are not in the derived set",
    ]);
  }));

test("the scoping is live: with it removed the globe's comment is refused again, and with it widened the billboard's is excused", async () => {
  const { base, reworded } = await globeEdits();
  const raw = await readLf(BILLBOARD);
  const spread = raw.replace(ONE_LINE_ENTRY, SPREAD_ENTRY);
  const noted = spread.replace(
    "fn fragmentMain(\n",
    "fn fragmentMain(\n  // A note.\n",
  );
  const APPLIES =
    'return reader.scope === "oit-reach" ? inOitReach(relPath) : true;';
  const IN_REACH = "return targetSet.has(normal);";
  const NO_PATH =
    'if (typeof relPath !== "string" || relPath === "") {\n    return true;\n  }';

  for (const [name, mutation] of [
    [
      "the reader applies to every path",
      { readers: [[APPLIES, "return true;"]] },
    ],
    ["every path is in reach", { reach: [[IN_REACH, "return true;"]] }],
  ]) {
    const gate = await gateWith(mutation);
    const result = gate.compareSources(base, reworded, GLOBE);
    assert.equal(result.status, "flavour-differs", name);
    assert.match(result.detail, /oit-entry-parameters/, name);
  }

  // Another OIT reader (the entry signature) also sees this edit, so the
  // question is whether the parameter-list reader is among the refusals.
  const real = compareSources(spread, noted, BILLBOARD);
  assert.match(real.detail, /oit-entry-parameters/, "control: the real gate");
  const none = await gateWith({ reach: [[IN_REACH, "return false;"]] });
  assert.doesNotMatch(
    none.compareSources(spread, noted, BILLBOARD).detail ?? "",
    /oit-entry-parameters/,
    "no path is in reach: the parameter-list reader is gone for the billboard",
  );

  const lenient = await gateWith({
    reach: [
      [
        NO_PATH,
        'if (typeof relPath !== "string" || relPath === "") {\n    return false;\n  }',
      ],
    ],
  });
  assert.doesNotMatch(
    lenient
      .shaderReaderProblems(spread, noted, "wgsl")
      .map((problem) => problem.detail)
      .join(),
    /oit-entry-parameters/,
    "with no path treated as out of reach, the parameter-list reader is skipped",
  );
});
