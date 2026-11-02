// cloud-march-kernels.spec.mjs — each kernel is defined once in every source a cloud pipeline compiles.
// @purpose Every module-scope WGSL function is defined exactly once in the composed, preprocessed text each cloud pipeline hands to the compiler (the march template under every flag conjunction the enumeration reaches, the compute producers that join the march, the other cloud templates, the standalone cloud modules), so a kernel shared between modules cannot be pasted into two of them; also pins that no cloud reflection field or proxy arrives.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHY THIS EXISTS. The march is not one file: the renderer's
// `PROCEDURAL_CLOUDS_SOURCE` template joins a dozen modules into the one text a
// pipeline compiles. A function copied into two of those modules, or into a
// module that joins the template later, compiles as a redefinition error only
// on the device (a variant a spec never loaded fails silently in a pipeline
// cache), and the standalone resolve and attachment modules carry their own
// copies of the shell helpers on purpose, which is only safe while each stays
// out of the template. This spec composes each source the way the renderer
// does and counts definitions.
//
// WHAT "A SOURCE A PIPELINE COMPILES" MEANS HERE.
//   - the march: `composeRendererTemplate` over `PROCEDURAL_CLOUDS_SOURCE`,
//     preprocessed under the flag subsets described below;
//   - the two compute producers that join the whole march with a kernel
//     module (the density-cache build and the deep-shadow build): the tree's
//     own `cloudDensityComputeProgram`, loaded from its source with its
//     imports stubbed, composes the march template with the kernel text and
//     the producer's fixed defines, and its result is checked. The program
//     itself throws on a repeated function, and a throw is as red as a
//     reported duplicate;
//   - every other template constant in `Renderer/WebGPU/*.ts` that joins a
//     cloud module (the sky cubemap and the volumetric fog compute join the
//     shared density domain);
//   - the density-statistics bake and the spatial-occupancy build, which
//     their renderers join as arrays;
//   - the standalone cloud modules a pipeline preprocesses alone, under their
//     own flags (`Environment/Cloud*.wgsl` and `Compute/Cloud*.wgsl`).
//
// FLAG SUBSETS. A duplicate that exists only under `A && B && !C` is invisible
// to a default + one-flag-at-a-time + all-flags walk. A source naming at most
// EXHAUSTIVE_FLAG_LIMIT flags is checked under every subset of them. A source
// naming more (the march names fourteen at the current tree, 16,384 subsets,
// about eight seconds on a development machine for the march alone) is
// checked under every subset of up to BOUNDED_ORDER flags plus the complement
// of every such subset. That covers any conjunction that names at most
// BOUNDED_ORDER flags positively (the subset of exactly those flags satisfies
// it) and any conjunction that names at most BOUNDED_ORDER flags negatively
// (the complement does), which includes `A && B && !C`. It does not cover a
// conjunction of four or more positive literals and four or more negative
// ones at once.
//
// ONE SPEC, MANY TREES. This file is read unchanged at tips where a producer,
// its kernel module or its owner does not exist yet. A producer or array-join
// entry whose kernel module file is absent from the tree is not composed: it
// is not live, and the K0 census over the module files actually present
// guarantees that a present module is in a checked source, so absence cannot
// hide a module. An entry whose kernel IS present but whose owner wiring
// fails is a failure, never a skip. Nothing here imports a module that may be
// absent, and nothing depends on generated shader modules.
//
// Run: node --test Tools/visual-regression/cloud-march-kernels.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  composeRendererTemplate,
  ENGINE_SOURCE_ROOT,
  engineShaderPath,
  readEngineShader,
} from "./lib/engine-shader-source.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { preprocess, shaderDefines } from "./lib/wgsl-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKSLASH_N = String.fromCharCode(92, 110);
const RENDERER_DIR = "Renderer/WebGPU";
const MARCH_RENDERER = `${RENDERER_DIR}/WebGPUProceduralCloudRenderer.ts`;
const ENVIRONMENT = "Shaders/WebGPU/Environment";

// ─── the checker ─────────────────────────────────────────────────────────────

/** Source with block and line comments removed (WGSL has no string literals). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Names of the functions a source declares, in order, one entry per
 * declaration. WGSL declares functions only at module scope, so every `fn` in
 * comment-free text is a module-scope definition.
 */
function definedFunctions(source) {
  return [...stripComments(source).matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)].map(
    (match) => match[1],
  );
}

/** Names that appear more than once in `names`, sorted. */
function repeated(names) {
  const counts = new Map();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

/**
 * Names declared more than once in `source`, sorted. Comment removal only
 * ever drops declarations, so a source with no repeat before it has none
 * after it, and the comment-free pass runs only for a source that repeats.
 */
function duplicateFunctions(source) {
  const unstripped = [...source.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)].map(
    (match) => match[1],
  );
  if (repeated(unstripped).length === 0) {
    return [];
  }
  return repeated(definedFunctions(source));
}

// ─── variants ────────────────────────────────────────────────────────────────

/**
 * Flag names a source's own `//>>ifdef` lines name, in first-use order.
 * `//>>ifdef` takes one flag, so a conjunction arises only by nesting.
 */
function ifdefFlags(source) {
  const flags = [];
  for (const match of source.matchAll(
    /^\s*\/\/>>\s*ifdef\s+([A-Z_][A-Z0-9_]*)\s*$/gm,
  )) {
    if (!flags.includes(match[1])) {
      flags.push(match[1]);
    }
  }
  return flags;
}

/** The (lo, hi, ext) masks for one flag, from whichever registry holds it. */
function flagMasks(name) {
  const words = [
    ["lo", shaderDefines.ShaderDefine],
    ["hi", shaderDefines.ShaderDefineHi],
    ["ext", shaderDefines.ShaderDefineExt],
  ].filter(([, table]) => table[name] !== undefined);
  assert.equal(words.length, 1, `${name} is registered in exactly one word`);
  const masks = { lo: 0, hi: 0, ext: 0 };
  masks[words[0][0]] = words[0][1][name];
  return masks;
}

// Sources naming at most this many flags are checked under every subset.
const EXHAUSTIVE_FLAG_LIMIT = 10;
// Larger sources are checked under every subset of at most this many flags,
// and under the complement of every such subset.
const BOUNDED_ORDER = 3;

const popcount = (mask) => {
  let count = 0;
  for (let rest = mask; rest > 0; rest >>>= 1) {
    count += rest & 1;
  }
  return count;
};

/** Every bit mask below `1 << count` with at most `order` bits set. */
function masksUpToOrder(count, order) {
  const masks = [];
  const extend = (from, mask, size) => {
    masks.push(mask);
    if (size === order) {
      return;
    }
    for (let bit = from; bit < count; bit++) {
      extend(bit + 1, mask | (1 << bit), size + 1);
    }
  };
  extend(0, 0, 0);
  return masks;
}

/**
 * The flag subsets (bit `i` set = flag `i` on) a source is checked under,
 * smallest first. `strategy` "subsets" is the enumeration described in the
 * header; "singles" is default + each flag alone + all flags, which a control
 * uses to show what that walk would have missed.
 */
function subsetMasks(count, strategy = "subsets") {
  assert.ok(count <= 30, "the flag subsets fit a 31-bit mask");
  const full = (1 << count) - 1;
  let masks;
  if (strategy === "singles") {
    masks = [0, ...Array.from({ length: count }, (_, bit) => 1 << bit), full];
  } else if (count <= EXHAUSTIVE_FLAG_LIMIT) {
    masks = Array.from({ length: full + 1 }, (_, mask) => mask);
  } else {
    const small = masksUpToOrder(count, BOUNDED_ORDER);
    masks = [...small, ...small.map((mask) => full ^ mask)];
  }
  return [...new Set(masks)].sort((a, b) => popcount(a) - popcount(b) || a - b);
}

/** A variant's label: the flags that are on, or "all but" the few that are off. */
function subsetLabel(flags, mask) {
  const on = flags.filter((_, bit) => mask & (1 << bit));
  const off = flags.filter((_, bit) => !(mask & (1 << bit)));
  if (on.length === 0) {
    return "default";
  }
  if (off.length === 0) {
    return "all flags";
  }
  return on.length <= off.length ? on.join(" + ") : `all but ${off.join(", ")}`;
}

/**
 * `[label, text]` for each variant of `source` under the flag subsets (lazily:
 * the march alone is hundreds of 200 KB texts).
 */
function* variantsOf(source, strategy = "subsets") {
  const flags = ifdefFlags(source);
  const perFlag = flags.map(flagMasks);
  for (const mask of subsetMasks(flags.length, strategy)) {
    const on = { lo: 0, hi: 0, ext: 0 };
    perFlag.forEach((masks, bit) => {
      if (mask & (1 << bit)) {
        on.lo |= masks.lo;
        on.hi |= masks.hi;
        on.ext |= masks.ext;
      }
    });
    yield [subsetLabel(flags, mask), preprocess(source, on.lo, on.hi, on.ext)];
  }
}

/** How many variants `variantsOf(source, strategy)` visits. */
function variantCount(source, strategy = "subsets") {
  return subsetMasks(ifdefFlags(source).length, strategy).length;
}

/**
 * One line per distinct set of repeated functions across the variants of
 * `source`: the names, how many variants repeat them, and the first (smallest)
 * variants that do.
 */
function duplicatesAcrossVariants(source, strategy = "subsets") {
  const groups = new Map();
  for (const [label, text] of variantsOf(source, strategy)) {
    const names = duplicateFunctions(text);
    if (names.length === 0) {
      continue;
    }
    const key = names.join(", ");
    const group = groups.get(key) ?? { labels: [], count: 0 };
    group.count++;
    if (group.labels.length < 3) {
      group.labels.push(label);
    }
    groups.set(key, group);
  }
  return [...groups].map(
    ([names, { labels, count }]) =>
      `${names}: ${count} variants, first ${labels.join(" | ")}`,
  );
}

// ─── the sources ─────────────────────────────────────────────────────────────

const COMPUTE = "Shaders/WebGPU/Compute";

const read = (relativePath) => readEngineShader(relativePath);
const exists = (relativePath) => fs.existsSync(engineShaderPath(relativePath));

/** Template constants in `Renderer/WebGPU/*.ts` that join at least one cloud module. */
function cloudTemplates() {
  const found = [];
  const directory = path.join(ENGINE_SOURCE_ROOT, RENDERER_DIR);
  for (const file of fs.readdirSync(directory).sort()) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const text = read(`${RENDERER_DIR}/${file}`);
    for (const match of text.matchAll(
      /^const ([A-Z][A-Z0-9_]*) = `((?:\$\{\w+\}(?:\\n\$\{\w+\})*))`;$/gm,
    )) {
      if (/Cloud/.test(match[2])) {
        found.push({ file: `${RENDERER_DIR}/${file}`, constant: match[1] });
      }
    }
  }
  return found;
}

/** The density-statistics bake, which the renderer joins as an array. */
function densityBakeSource() {
  const owner = read(`${RENDERER_DIR}/WebGPUCloudDensityMoments.ts`);
  const modules = [
    `${ENVIRONMENT}/CloudDensityDomain`,
    `${ENVIRONMENT}/CloudDensityFormation`,
    "Shaders/WebGPU/Compute/CloudDensityMomentsBake",
  ];
  for (const module of modules) {
    assert.ok(
      owner.includes(`"../../${module}.js"`),
      `the density bake owner still imports ${module}`,
    );
  }
  return modules.map((module) => read(`${module}.wgsl`)).join("\n");
}

/**
 * Compute programs an owner joins from several modules as an array (for
 * example `[DomainSource, QuerySource, BuildSource].join(...)`): the owner
 * file and the modules it joins, in order, the last being the kernel. An entry
 * whose kernel file is absent from the tree is not live and is not composed;
 * a live entry's owner must still import every listed module (K8), so a
 * renamed or dropped module fails rather than leaving the entry checking
 * stale text.
 */
const ARRAY_JOINS = [
  {
    label: "spatial occupancy build",
    owner: "WebGPUCloudSpatialOccupancy.ts",
    modules: [
      `${ENVIRONMENT}/CloudDensityDomain`,
      `${ENVIRONMENT}/CloudNoiseBoundsQuery`,
      `${COMPUTE}/CloudSpatialOccupancy`,
    ],
  },
].filter(({ modules }) => exists(`${modules.at(-1)}.wgsl`));

function arrayJoinSource({ modules }) {
  return modules.map((module) => read(`${module}.wgsl`)).join("\n");
}

/** Cloud modules in `Environment/` a pipeline preprocesses and compiles on its own. */
const STANDALONE_ENVIRONMENT = [
  "CloudTemporalResolve",
  "CloudReconstructionAttachments",
  "CloudUpscale",
  "CloudPrimaryComposite",
]
  .map((name) => `${ENVIRONMENT}/${name}`)
  .filter((module) => exists(`${module}.wgsl`));

/**
 * Cloud modules in `Compute/` a pipeline compiles on its own, with the
 * renderer file that imports each. Only those present in the tree are live.
 */
const STANDALONE_COMPUTE = [
  { module: "CloudNoiseBake", owner: "WebGPUCloudNoiseResources.ts" },
  { module: "CloudNoiseMipmap", owner: "WebGPUCloudNoiseResources.ts" },
  { module: "CloudNoiseBounds", owner: "WebGPUCloudNoiseBounds.ts" },
  { module: "CloudDensitySnapshot", owner: "WebGPUCloudDeepShadowCache.ts" },
]
  .map((entry) => ({ ...entry, module: `${COMPUTE}/${entry.module}` }))
  .filter(({ module }) => exists(`${module}.wgsl`));

// ─── the compute producers ───────────────────────────────────────────────────

const PROGRAM_OWNER = `${RENDERER_DIR}/WebGPUCloudDensityCacheProgram.ts`;
const DEEP_SHADOW_DEFINES = [
  "CLOUD_DEEP_SHADOW_CACHE",
  "CLOUD_DENSITY_SAMPLE_CACHE",
];

/**
 * The tree's own `WebGPUCloudDensityCacheProgram.ts`, loaded from its source:
 * the preprocessor and the define registry are the engine's, and the kernel
 * module it imports is the `.wgsl` text read through `readText`, so a mutated
 * reader reaches the program the way it reaches the template.
 */
async function loadProducerProgram(readText = read) {
  const { code } = await transform(readText(PROGRAM_OWNER), {
    loader: "ts",
    format: "cjs",
  });
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    require: (specifier) => {
      if (specifier === "./WebGPUShaderPreprocessor.js") {
        return { preprocess };
      }
      if (specifier === "./WebGPUShaderDefines.js") {
        return { ShaderDefineHi: shaderDefines.ShaderDefineHi };
      }
      const kernel = /^\.\.\/\.\.\/(Shaders\/.+)\.js$/.exec(specifier);
      assert.ok(
        kernel,
        `the program imports an unexpected module ${specifier}`,
      );
      return { __esModule: true, default: readText(`${kernel[1]}.wgsl`) };
    },
  });
  return { ...module.exports };
}

/**
 * The compute producers that join the whole march with a kernel module. Each
 * has the kernel file (live only while it is present in the tree), the entry
 * point, `pins(readText)` (asserts the owner source still builds the producer
 * from that kernel module, entry and defines) and `build(program, march,
 * readText)` (the text the pipeline compiles, from the tree's own program).
 */
const PRODUCERS = [
  {
    label: "density-cache producer",
    module: `${COMPUTE}/CloudDensityCache`,
    get kernel() {
      return `${this.module}.wgsl`;
    },
    entry: "cloudDensityCacheBuildMain",
    pins(readText) {
      const program = readText(PROGRAM_OWNER);
      assert.ok(
        program.includes(
          `import BuildSource from "../../${COMPUTE}/CloudDensityCache.js";`,
        ),
        "the program imports the density-cache kernel module as BuildSource",
      );
      // The program's shape differs across tips (inline, or through the
      // shared cloudDensityComputeProgram), so the pin names what every shape
      // carries: the kernel joined by name and the entry it keeps.
      assert.ok(
        program.split(/\bBuildSource\b/).length > 2,
        "cloudDensityCacheProgram joins the BuildSource kernel it imports",
      );
      assert.ok(
        program.includes(`"${this.entry}"`),
        `cloudDensityCacheProgram keeps the ${this.entry} entry`,
      );
      assert.match(
        readText(MARCH_RENDERER),
        /cloudDensityCacheProgram\(\s*PROCEDURAL_CLOUDS_SOURCE,?\s*\)/,
        "the renderer builds the density-cache producer from the march template",
      );
    },
    build: (program, march) => program.cloudDensityCacheProgram(march),
  },
  {
    label: "deep-shadow producer",
    module: `${COMPUTE}/CloudDeepShadowCache`,
    get kernel() {
      return `${this.module}.wgsl`;
    },
    entry: "cloudDeepShadowBuildMain",
    definesText: "ShaderDefineHi.CLOUD_DEEP_SHADOW_CACHE",
    pins(readText) {
      const renderer = readText(MARCH_RENDERER);
      assert.ok(
        renderer.includes(
          `import DeepShadowBuildWGSL from "../../${COMPUTE}/CloudDeepShadowCache.js";`,
        ),
        "the renderer imports the deep-shadow kernel module as DeepShadowBuildWGSL",
      );
      const body =
        /function getDeepShadowProducerSource\(\): string \{([\s\S]*?)\n\}/.exec(
          renderer,
        );
      assert.ok(body, "the renderer defines getDeepShadowProducerSource");
      const call =
        /cloudDensityComputeProgram\(\s*PROCEDURAL_CLOUDS_SOURCE,\s*DeepShadowBuildWGSL,\s*"cloudDeepShadowBuildMain",([^)]*)\)/.exec(
          body[1],
        );
      assert.ok(
        call,
        "the deep-shadow producer is cloudDensityComputeProgram over the march template, DeepShadowBuildWGSL and cloudDeepShadowBuildMain",
      );
      assert.deepEqual(
        [...call[1].matchAll(/ShaderDefineHi\.(\w+)/g)]
          .map((match) => match[1])
          .sort(),
        DEEP_SHADOW_DEFINES,
        "the deep-shadow producer names exactly its two defines",
      );
      assert.equal(
        call[1].replace(/ShaderDefineHi\.\w+/g, "").replace(/[\s|,]/g, ""),
        "",
        "the deep-shadow defines are ORed together and nothing else",
      );
    },
    build(program, march, readText) {
      return program.cloudDensityComputeProgram(
        march,
        readText(this.kernel),
        this.entry,
        DEEP_SHADOW_DEFINES.reduce(
          (mask, name) => mask | shaderDefines.ShaderDefineHi[name],
          0,
        ),
      );
    },
  },
].filter(({ kernel }) => exists(kernel));

const marchOf = (readText = read) =>
  composeRendererTemplate(MARCH_RENDERER, "PROCEDURAL_CLOUDS_SOURCE", readText);

/** The text a producer's pipeline compiles; throws when the program refuses the sources. */
async function buildProducer(producer, readText = read) {
  return producer.build(
    await loadProducerProgram(readText),
    marchOf(readText),
    readText,
  );
}

/**
 * What is wrong with a producer's composed source: each repeated function,
 * or the program's own refusal (it throws on a repeated function).
 */
async function producerFindings(producer, readText = read) {
  try {
    return duplicateFunctions(await buildProducer(producer, readText)).map(
      (name) => `${name} is defined more than once`,
    );
  } catch (error) {
    return [`the program threw: ${error.message}`];
  }
}

/** The text a producer joins before the program preprocesses and prunes it. */
const producerCensus = (producer) =>
  [marchOf(), read(producer.kernel)].join("\n");

const templates = cloudTemplates();
const composed = templates.map(({ file, constant }) => ({
  label: `${constant} (${file})`,
  source: composeRendererTemplate(file, constant),
}));
const standalone = [
  { label: "density-statistics bake", source: densityBakeSource() },
  ...ARRAY_JOINS.map((entry) => ({
    label: entry.label,
    source: arrayJoinSource(entry),
  })),
  ...[
    ...STANDALONE_ENVIRONMENT,
    ...STANDALONE_COMPUTE.map(({ module }) => module),
  ].map((module) => ({
    label: `${module}.wgsl`,
    source: read(`${module}.wgsl`),
  })),
];

/** The texts the K0 census searches for a module's text. */
const censusTexts = () => [
  ...composed.map((entry) => entry.source),
  ...standalone.map((entry) => entry.source),
  ...PRODUCERS.map(producerCensus),
];

/** The cloud module files below `directory` (`Environment/` or `Compute/`), as paths below the engine source. */
function cloudModuleFiles(directory) {
  return fs
    .readdirSync(path.join(ENGINE_SOURCE_ROOT, directory))
    .filter(
      (file) =>
        file.endsWith(".wgsl") &&
        (file.startsWith("Cloud") ||
          (directory === ENVIRONMENT && file === "ProceduralClouds.wgsl")),
    )
    .map((file) => `${directory}/${file}`);
}

/** The cloud module files in `Environment/` and `Compute/` that none of `texts` contains. */
function uncoveredModules(texts) {
  return [
    ...cloudModuleFiles(ENVIRONMENT),
    ...cloudModuleFiles(COMPUTE),
  ].filter((file) => {
    const text = read(file);
    return !texts.some((source) => source.includes(text));
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("K0 the scan finds the march and what it joins, so the checks below are not vacuous", () => {
  const march = templates.find(
    (t) =>
      t.file === MARCH_RENDERER && t.constant === "PROCEDURAL_CLOUDS_SOURCE",
  );
  assert.ok(march, "PROCEDURAL_CLOUDS_SOURCE is found as a cloud template");
  const source = composed.find((c) => c.label.startsWith("PROCEDURAL_CLOUDS"));
  assert.ok(
    definedFunctions(source.source).length > 100,
    "the composed march defines its kernels",
  );
  const flags = ifdefFlags(source.source);
  for (const flag of [
    "CLOUD_MARCH_EMIT_RECONSTRUCTION",
    "CLOUD_DENSITY_MOMENTS",
    "CLOUD_GEOGRAPHIC_WIND",
    "CLOUD_LIGHTING_PREVIEW",
  ]) {
    assert.ok(flags.includes(flag), `the march template names ${flag}`);
  }
  // The emit variant is one of the variants the kernel check visits.
  const emit = [...variantsOf(source.source, "singles")].find(
    ([label]) => label === "CLOUD_MARCH_EMIT_RECONSTRUCTION",
  );
  assert.ok(emit, "the emit variant is enumerated");
  assert.notEqual(
    emit[1],
    preprocess(source.source, 0, 0, 0),
    "the emit variant is a different text from the default",
  );
});

test("K0 every cloud shader module is part of a composed or standalone source", () => {
  assert.ok(
    cloudModuleFiles(ENVIRONMENT).length >= 12,
    "the Environment cloud modules are listed",
  );
  assert.ok(
    cloudModuleFiles(COMPUTE).length >= 3,
    "the Compute cloud modules are listed",
  );
  assert.deepEqual(
    uncoveredModules(censusTexts()),
    [],
    "each module above is in no source this spec checks: add the pipeline that compiles it",
  );
});

for (const { label, source } of composed) {
  test(`K1 every function is defined once in ${label}, under every variant`, (t) => {
    t.diagnostic(`${variantCount(source)} variants`);
    assert.deepEqual(duplicatesAcrossVariants(source), []);
  });
}

for (const { label, source } of standalone) {
  test(`K2 every function is defined once in ${label}, under every variant`, (t) => {
    t.diagnostic(`${variantCount(source)} variants`);
    assert.deepEqual(duplicatesAcrossVariants(source), []);
  });
}

test("K3 the checker reports a kernel that two modules of the march both define", (t) => {
  const march = composed.find((c) => c.label.startsWith("PROCEDURAL_CLOUDS"));
  assert.deepEqual(duplicateFunctions(preprocess(march.source, 0, 0, 0)), []);

  // One module joined twice, through the same composition the spec uses.
  const doubled = composeRendererTemplate(
    MARCH_RENDERER,
    "PROCEDURAL_CLOUDS_SOURCE",
    (relativePath) => {
      const text = read(relativePath);
      return relativePath === MARCH_RENDERER
        ? text.replace(
            "${CloudMarchSamplingWGSL}",
            "${CloudMarchSamplingWGSL}" +
              BACKSLASH_N +
              "${CloudMarchSamplingWGSL}",
          )
        : text;
    },
  );
  const reported = duplicatesAcrossVariants(doubled);
  assert.ok(reported.length > 0, "a module joined twice is reported");
  const sampled = definedFunctions(
    readEngineShader(`${ENVIRONMENT}/CloudMarchSampling.wgsl`),
  );
  assert.ok(sampled.length > 0);
  assert.deepEqual(
    duplicateFunctions(preprocess(doubled, 0, 0, 0)),
    [...new Set(sampled)].sort(),
    "exactly the functions of the doubled module are reported",
  );

  // A function the march already defines, declared again after it.
  const [first] = definedFunctions(march.source);
  const redefined = `${march.source}\nfn ${first}() {}\n`;
  assert.deepEqual(duplicateFunctions(preprocess(redefined, 0, 0, 0)), [first]);

  // The temporal resolve joined onto the march repeats whatever the two share.
  const resolve = readEngineShader(`${ENVIRONMENT}/CloudTemporalResolve.wgsl`);
  const rawNames = (text) =>
    new Set([...text.matchAll(/^fn (\w+)/gm)].map((m) => m[1]));
  const marchNames = rawNames(march.source);
  const shared = [...rawNames(resolve)].filter((n) => marchNames.has(n)).sort();
  if (shared.length === 0) {
    t.diagnostic("the march and the resolve share no function name any more");
  } else {
    const joined = `${preprocess(march.source, 0, 0, 0)}\n${preprocess(resolve, 0, 0, 0)}`;
    assert.deepEqual(duplicateFunctions(joined), shared);
  }
});

test("K4 composeRendererTemplate refuses a template that adds text of its own", () => {
  const renderer = read(MARCH_RENDERER);
  const withText = renderer.replace(
    "${CloudMarchSamplingWGSL}" + BACKSLASH_N,
    "${CloudMarchSamplingWGSL} ",
  );
  assert.notEqual(withText, renderer);
  assert.throws(
    () =>
      composeRendererTemplate(
        MARCH_RENDERER,
        "PROCEDURAL_CLOUDS_SOURCE",
        (p) => (p === MARCH_RENDERER ? withText : read(p)),
      ),
    /whole modules/,
  );
  assert.throws(
    () => composeRendererTemplate(MARCH_RENDERER, "NO_SUCH_TEMPLATE"),
    /no template constant NO_SUCH_TEMPLATE/,
  );
  const unimported = renderer.replace(
    'import CloudAirLightWGSL from "../../Shaders/WebGPU/Environment/CloudAirLight.js";',
    "",
  );
  assert.notEqual(unimported, renderer);
  assert.throws(
    () =>
      composeRendererTemplate(
        MARCH_RENDERER,
        "PROCEDURAL_CLOUDS_SOURCE",
        (p) => (p === MARCH_RENDERER ? unimported : read(p)),
      ),
    /does not import CloudAirLightWGSL/,
  );
});

test("K5 composeRendererTemplate composes from the reader it is given", () => {
  const marker = "fn markerFromAnotherTree() {}";
  const text = composeRendererTemplate(
    MARCH_RENDERER,
    "PROCEDURAL_CLOUDS_SOURCE",
    (relativePath) =>
      engineShaderPath(relativePath) ===
      engineShaderPath(`${ENVIRONMENT}/CloudAirLight.wgsl`)
        ? marker
        : read(relativePath),
  );
  assert.ok(text.includes(marker));
  assert.ok(!text.includes("\r"), "the result is LF-normalised");
  const sampling = readEngineShader(`${ENVIRONMENT}/CloudMarchSampling.wgsl`);
  assert.ok(
    text.indexOf(sampling) < text.indexOf(marker),
    "modules appear in the template's order",
  );
});

test("K6 inertness: the composition checks go red when made unreachable", async () => {
  const kit = path.join(here, "lib/engine-shader-source.mjs");
  const unwholeTemplate = read(MARCH_RENDERER).replace(
    "${CloudMarchSamplingWGSL}" + BACKSLASH_N,
    "${CloudMarchSamplingWGSL} ",
  );
  const readTemplate = (p) =>
    p === MARCH_RENDERER ? unwholeTemplate : read(p);

  // The kit leaf locates the engine tree from its own URL; a data: copy has
  // none, so the mutant pins that location to the original file.
  const locate = ["fileURLToPath(import.meta.url)", JSON.stringify(kit)];
  const wholeModulesDead = await importMutated(kit, [
    locate,
    ["names.length === 0 ||", "false &&"],
  ]);
  assert.doesNotThrow(
    () =>
      wholeModulesDead.composeRendererTemplate(
        MARCH_RENDERER,
        "PROCEDURAL_CLOUDS_SOURCE",
        readTemplate,
      ),
    "with the whole-modules guard dead the mutant accepts the template, which K4 rejects",
  );

  const readerIgnored = await importMutated(kit, [
    locate,
    [
      "return lf(read(`${imported[1]}.wgsl`));",
      "return lf(readEngineShader(`${imported[1]}.wgsl`));",
    ],
  ]);
  const marker = "fn markerFromAnotherTree() {}";
  const fromOtherTree = readerIgnored.composeRendererTemplate(
    MARCH_RENDERER,
    "PROCEDURAL_CLOUDS_SOURCE",
    (p) => (p.endsWith("CloudAirLight.wgsl") ? marker : read(p)),
  );
  assert.ok(
    !fromOtherTree.includes(marker),
    "with the reader ignored the mutant composes the checkout, which K5 rejects",
  );
});

/** Findings under `root`: files named CloudReflectionProxy*, and cloudReflectionField* functions. */
function reflectionOffenders(root) {
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          visit(full);
        }
        continue;
      }
      if (/^CloudReflectionProxy/i.test(entry.name)) {
        offenders.push(`file ${path.relative(root, full)}`);
      }
      if (/\.(wgsl|ts|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (
          text.includes("cloudReflectionField") &&
          /\bfn\s+cloudReflectionField\w*\s*\(/.test(stripComments(text))
        ) {
          offenders.push(`function in ${path.relative(root, full)}`);
        }
      }
    }
  };
  visit(root);
  return offenders.sort();
}

test("K7 no cloud reflection field or proxy is present in the engine source", () => {
  assert.deepEqual(reflectionOffenders(ENGINE_SOURCE_ROOT), []);
});

// Temp-tree fixture names for K7 (no engine shader is read).
const FIXTURE_FIELD = ["Field", "wgsl"].join(".");
const FIXTURE_CLEAN = ["Clean", "wgsl"].join(".");

test("K7 the reflection census sees a file and a function when one is present", () =>
  withLaneTmp("cloud-march-kernels-reflection-", (directory) => {
    const shaders = path.join(directory, "Shaders");
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, "CloudReflectionProxy.ts"), "");
    fs.writeFileSync(
      path.join(shaders, FIXTURE_FIELD),
      "// fn cloudReflectionFieldCommented(\nfn cloudReflectionFieldSample(p: vec3<f32>) -> f32 { return 0.0; }\n",
    );
    fs.writeFileSync(
      path.join(shaders, FIXTURE_CLEAN),
      "// fn cloudReflectionFieldInAComment(\nfn other() {}\n",
    );
    assert.deepEqual(reflectionOffenders(directory), [
      `file ${path.join("Shaders", "CloudReflectionProxy.ts")}`,
      `function in ${path.join("Shaders", FIXTURE_FIELD)}`,
    ]);
  }));

// ─── owners, compute producers, flag conjunctions ────────────────────────────

/** Each live entry whose owner joins or imports modules the spec composes by name. */
const WIRING = [
  ...ARRAY_JOINS.map(({ label, owner, modules }) => ({
    label,
    owner: `${RENDERER_DIR}/${owner}`,
    modules,
  })),
  ...STANDALONE_COMPUTE.map(({ module, owner }) => ({
    label: `${module}.wgsl`,
    owner: `${RENDERER_DIR}/${owner}`,
    modules: [module],
  })),
];

for (const { label, owner, modules } of WIRING) {
  test(`K8 the owner of ${label} still imports the modules the spec composes for it`, () => {
    const text = read(owner);
    for (const module of modules) {
      assert.ok(
        text.includes(`"../../${module}.js"`),
        `${owner} imports ${module}`,
      );
    }
  });
}

for (const producer of PRODUCERS) {
  test(`K8 the ${producer.label} is still built from its kernel module, entry and defines`, () => {
    producer.pins(read);
  });
}

for (const producer of PRODUCERS) {
  test(`K9 every function is defined once in the ${producer.label}'s composed source`, async () => {
    const text = await buildProducer(producer);
    assert.ok(
      text.includes(`fn ${producer.entry}(`),
      "the composed producer carries its entry point",
    );
    assert.ok(
      definedFunctions(text).length > 3,
      "the composed producer carries the march kernels its entry reaches",
    );
    assert.deepEqual(duplicateFunctions(text), []);
  });
}

test("K10 inertness: a function repeated only under a flag conjunction is reported by the subsets and missed by one flag at a time", (t) => {
  const march = composed.find((c) => c.label.startsWith("PROCEDURAL_CLOUDS"));
  const flags = ifdefFlags(march.source);
  const named = [
    "CLOUD_SPATIAL_OCCUPANCY",
    "CLOUD_DENSITY_SAMPLE_CACHE",
    "CLOUD_LIGHTING_PREVIEW",
  ];
  // The conjunction the current march names, else the first three flags the
  // march at this tree names.
  const [a, b, c] = named.every((flag) => flags.includes(flag))
    ? named
    : flags.slice(0, 3);
  assert.ok(c, "the march names at least three flags");
  const defined = definedFunctions(march.source);
  const target = defined.includes("rayEllipsoidIntersectRTE")
    ? "rayEllipsoidIntersectRTE"
    : defined[0];
  // Defined once more only while `a` and `b` are on and `c` is off.
  const injection = [
    `//>>ifdef ${a}`,
    `//>>ifdef ${b}`,
    `//>>ifdef ${c}`,
    "//>>else",
    `fn ${target}() {}`,
    "//>>endif",
    "//>>endif",
    "//>>endif",
  ].join("\n");
  const module = `${ENVIRONMENT}/ProceduralClouds`;
  const mutated = marchOf((relativePath) =>
    relativePath === `${module}.wgsl`
      ? `${read(relativePath)}\n${injection}\n`
      : read(relativePath),
  );
  assert.ok(mutated.includes(injection), "the read hook reached the module");
  assert.deepEqual(
    duplicatesAcrossVariants(march.source),
    [],
    "the unmutated march is clean under the same enumeration",
  );
  t.diagnostic(`conjunction ${a} && ${b} && !${c} on ${target}`);
  assert.deepEqual(
    duplicatesAcrossVariants(mutated, "singles"),
    [],
    "default, one flag at a time and all flags never reach the conjunction",
  );
  const reported = duplicatesAcrossVariants(mutated);
  assert.equal(reported.length, 1, "the subsets report the repeated function");
  assert.ok(reported[0].startsWith(`${target}: `), reported[0]);
  assert.ok(
    reported[0].includes(
      `first ${flags.filter((flag) => flag === a || flag === b).join(" + ")}`,
    ),
    `the smallest variant that repeats it is the two positive flags: ${reported[0]}`,
  );
});

for (const producer of PRODUCERS) {
  test(`K10 inertness: the ${producer.label} check goes red for a function appended to its kernel module, and its pins for a rename`, async () => {
    assert.ok(
      /^fn cloudShellAxes\(/m.test(marchOf()),
      "the march defines cloudShellAxes",
    );
    assert.deepEqual(
      await producerFindings(producer),
      [],
      "the unmutated producer is clean",
    );

    const repeated = (relativePath) =>
      relativePath === producer.kernel
        ? `${read(relativePath)}\nfn cloudShellAxes() {}\n`
        : read(relativePath);
    assert.ok(repeated(producer.kernel).includes("fn cloudShellAxes() {}"));
    const findings = await producerFindings(producer, repeated);
    assert.ok(
      findings.some((finding) =>
        /defined more than once|Invalid cloud density function boundary/.test(
          finding,
        ),
      ),
      `a repeated function is a finding: ${findings.join("; ")}`,
    );

    // A duplicate the program does not refuse is still reported.
    assert.deepEqual(
      await producerFindings({ build: () => "fn a() {}\nfn a() {}\n" }),
      ["a is defined more than once"],
    );

    // Pins: the entry name, the kernel module path and the defines each
    // changed in the owner sources.
    const kernelName = path.basename(producer.kernel, ".wgsl");
    for (const [from, to] of [
      [`"${producer.entry}"`, `"${producer.entry}Renamed"`],
      [`${COMPUTE}/${kernelName}.js`, `${COMPUTE}/${kernelName}Renamed.js`],
      ...(producer.definesText ? [[producer.definesText, "0"]] : []),
    ]) {
      const reader = (relativePath) => read(relativePath).split(from).join(to);
      assert.notEqual(
        reader(PROGRAM_OWNER) + reader(MARCH_RENDERER),
        read(PROGRAM_OWNER) + read(MARCH_RENDERER),
        `the owner sources name ${from}`,
      );
      assert.throws(
        () => producer.pins(reader),
        assert.AssertionError,
        `the pins notice ${from} changed`,
      );
    }
  });
}

test("K10 inertness: a Compute cloud module left out of every source turns the census red", () => {
  const texts = censusTexts();
  assert.deepEqual(uncoveredModules(texts), []);
  const modules = cloudModuleFiles(COMPUTE);
  assert.ok(modules.length >= 3, "the Compute cloud modules are listed");
  for (const file of modules) {
    const text = read(file);
    const without = texts.filter((source) => !source.includes(text));
    assert.ok(
      without.length < texts.length,
      `${file} is part of a checked source to begin with`,
    );
    assert.ok(
      uncoveredModules(without).includes(file),
      `${file} left out of every source is reported`,
    );
  }
});
