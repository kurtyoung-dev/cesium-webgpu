/**
 * Pure-Node coverage for the Sandcastle renderer-mode precedence rules.
 *
 * WHAT IS UNDER TEST. `?renderer=` outranks the stored setting for one page
 * load, an unrecognized value is ignored rather than fatal, and with neither
 * present the product default is what runs. Those three sentences are the whole
 * contract; every assertion below is written against observable output of the
 * resolution function, not against its shape.
 *
 * WHY IT MUTATES ITSELF. A spec written from the same brief as the fix inherits
 * the brief's errors, so group C compiles a copy of the module with the URL
 * branch made unreachable and requires the precedence assertions to go red. A
 * spec that survives its own subject being disabled is testing nothing.
 *
 * Run: npm run test-sandcastle
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, "../src/util/rendererSelection.ts");

async function loadModule(sourceSubstitution) {
  const plugins = [];
  if (sourceSubstitution !== undefined) {
    plugins.push({
      name: "renderer-selection-source-substitution",
      setup(buildApi) {
        buildApi.onLoad({ filter: /rendererSelection\.ts$/ }, (args) => {
          if (resolve(args.path) !== MODULE_PATH) {
            return undefined;
          }
          return {
            contents: sourceSubstitution,
            loader: "ts",
            resolveDir: dirname(args.path),
          };
        });
      },
    });
  }
  const result = await build({
    entryPoints: [MODULE_PATH],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    logLevel: "silent",
    plugins,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    result.outputFiles[0].text,
  ).toString("base64")}`;
  return import(moduleUrl);
}

const mod = await loadModule();
const {
  DEFAULT_RENDERER_MODE,
  RENDERER_MODES,
  RENDERER_URL_PARAM,
  isRendererMode,
  readRendererOverride,
  readRendererParam,
  resolveRendererMode,
} = mod;

// --- Group A: vocabulary ---------------------------------------------------

test("A1 the mode vocabulary is exactly the three the toggle offers", () => {
  assert.deepEqual([...RENDERER_MODES], ["webgl", "webgpu", "split"]);
  assert.equal(RENDERER_URL_PARAM, "renderer");
});

test("A2 the product default is one of the modes", () => {
  assert.ok(RENDERER_MODES.includes(DEFAULT_RENDERER_MODE));
});

test("A3 the guard accepts every mode and rejects everything else", () => {
  for (const mode of RENDERER_MODES) {
    assert.equal(isRendererMode(mode), true, mode);
  }
  for (const bad of [
    "WebGPU",
    "webgpu-compat",
    "auto",
    "",
    " webgl",
    null,
    undefined,
    3,
    {},
    ["webgl"],
  ]) {
    assert.equal(isRendererMode(bad), false, String(bad));
  }
});

// --- Group B: precedence ---------------------------------------------------

test("B1 a URL selection outranks the stored setting", () => {
  assert.equal(resolveRendererMode("webgpu", "webgl"), "webgpu");
  assert.equal(resolveRendererMode("webgl", "webgpu"), "webgl");
  assert.equal(resolveRendererMode("split", "webgl"), "split");
});

test("B2 with no URL value the stored setting is what runs", () => {
  assert.equal(resolveRendererMode(null, "webgpu"), "webgpu");
  assert.equal(resolveRendererMode(undefined, "split"), "split");
  assert.equal(resolveRendererMode("", "webgpu"), "webgpu");
});

test("B3 with neither present the product default is what runs", () => {
  assert.equal(resolveRendererMode(null, null), DEFAULT_RENDERER_MODE);
  assert.equal(
    resolveRendererMode(undefined, undefined),
    DEFAULT_RENDERER_MODE,
  );
});

test("B4 an unrecognized URL value is ignored, reported, and falls through", () => {
  const seen = [];
  assert.equal(
    resolveRendererMode("vulkan", "webgpu", (raw) => seen.push(raw)),
    "webgpu",
  );
  assert.deepEqual(seen, ["vulkan"]);

  // ...and with nothing stored either, it bottoms out at the default rather
  // than throwing or returning the junk value.
  assert.equal(resolveRendererMode("vulkan", null), DEFAULT_RENDERER_MODE);
});

test("B5 an unrecognized STORED value falls back to the default", () => {
  assert.equal(resolveRendererMode(null, "vulkan"), DEFAULT_RENDERER_MODE);
  assert.equal(
    resolveRendererMode(null, "webgpu-compat"),
    DEFAULT_RENDERER_MODE,
  );
});

test("B6 a valid URL value is never reported as invalid", () => {
  let called = 0;
  resolveRendererMode("webgpu", "webgl", () => called++);
  assert.equal(called, 0);
});

// --- Group C: query-string reading ----------------------------------------

test("C1 the parameter is read with or without the leading question mark", () => {
  assert.equal(readRendererParam("?renderer=webgpu"), "webgpu");
  assert.equal(readRendererParam("renderer=webgpu"), "webgpu");
  assert.equal(readRendererParam("?id=hello-world&renderer=split"), "split");
});

test("C2 an absent or empty query string reads as no value", () => {
  assert.equal(readRendererParam(""), null);
  assert.equal(readRendererParam(null), null);
  assert.equal(readRendererParam(undefined), null);
  assert.equal(readRendererParam("?id=hello-world"), null);
});

test("C3 the override reader validates and warns, without throwing", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(readRendererOverride("?renderer=webgpu"), "webgpu");
    assert.equal(warnings.length, 0);

    assert.equal(readRendererOverride("?renderer=vulkan"), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /vulkan/);
    assert.match(warnings[0], /webgl, webgpu, split/);

    assert.equal(readRendererOverride("?id=hello-world"), null);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("C4 an empty value counts as absent, not as an unknown mode", () => {
  // `?renderer=` and a valueless `?renderer` are what a stripped or
  // half-written link looks like. Both readers have to call that ABSENT, or the
  // page warns about a value nobody typed and the two disagree about the same
  // query string.
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    for (const search of ["?renderer=", "?renderer"]) {
      assert.equal(readRendererParam(search), "", search);
      assert.equal(readRendererOverride(search), null, search);
      assert.equal(resolveRendererMode("", "webgpu"), "webgpu", search);
    }
    assert.deepEqual(warnings, [], "an empty value must not be reported");
  } finally {
    console.warn = originalWarn;
  }
});

// --- Group D: inertness mutant --------------------------------------------

test("D1 disabling the URL branch makes the precedence assertions fail", async () => {
  const original = await import("node:fs/promises").then((fs) =>
    fs.readFile(MODULE_PATH, "utf8"),
  );
  const mutated = original.replace(
    '  if (typeof urlValue === "string" && urlValue.length > 0) {',
    '  if (false && typeof urlValue === "string" && urlValue.length > 0) {',
  );
  assert.notEqual(mutated, original, "mutation did not apply");

  const inert = await loadModule(mutated);

  // The subject is now unreachable: the URL can no longer win.
  assert.equal(inert.resolveRendererMode("webgpu", "webgl"), "webgl");
  assert.equal(
    inert.resolveRendererMode("vulkan", "webgpu"),
    "webgpu",
    "an ignored value looks the same either way — this is why B1 carries the signal",
  );

  // Restate B1 against the mutant and require it to be false.
  assert.notEqual(
    inert.resolveRendererMode("webgpu", "webgl"),
    "webgpu",
    "B1 survived the URL branch being made unreachable",
  );
});
