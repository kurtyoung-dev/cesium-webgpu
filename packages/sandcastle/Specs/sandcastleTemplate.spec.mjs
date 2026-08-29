/**
 * Coverage for the code the Sandcastle runner actually ships to the bucket:
 * the renderer preamble plus the constructor transform in `Helpers.ts`.
 *
 * WHAT IS UNDER TEST, STATED AS BEHAVIOUR. Whatever renderer Sandcastle has
 * selected is the renderer the demo ends up constructed with — for `Viewer` and
 * for `CesiumWidget`, whether the demo builds them synchronously or through
 * `createAsync`, and whether or not the demo names a renderer of its own.
 *
 * HOW IT AVOIDS CERTIFYING ITSELF. The generated module is not inspected only
 * as text: each case writes it into a throwaway package whose `node_modules`
 * carries a real `cesium` stub, imports it, and reads back what the
 * constructors were actually called with. Nothing is injected into the module's
 * scope — it resolves its own import the way the browser does, so a transform
 * that produces syntactically plausible but semantically wrong code fails here
 * rather than passing.
 *
 * Group E is the inertness mutant: with the CesiumWidget rows removed from the
 * transform table, the CesiumWidget cases must go red.
 *
 * Run: npm run test-sandcastle
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPERS_PATH = resolve(HERE, "../src/Helpers.ts");

async function loadHelpers(sourceSubstitution) {
  const plugins = [];
  if (sourceSubstitution !== undefined) {
    plugins.push({
      name: "helpers-source-substitution",
      setup(buildApi) {
        buildApi.onLoad({ filter: /Helpers\.ts$/ }, (args) => {
          if (resolve(args.path) !== HELPERS_PATH) {
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
    entryPoints: [HELPERS_PATH],
    bundle: true,
    format: "esm",
    platform: "node",
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

const helpers = await loadHelpers();

// A `cesium` package good enough to answer the only question these cases ask:
// which constructor ran, and with which options. Recording goes through a
// global the case reads afterwards, so the demo module keeps the exact shape
// the browser gives it.
const CESIUM_STUB = `
function record(entry) {
  (globalThis.__sandcastleStubCalls ??= []).push(entry);
}
export class Viewer {
  constructor(container, options) {
    record({ ctor: "Viewer", how: "sync", container, options });
    this.scene = { debugShowFramesPerSecond: false };
  }
  static async createAsync(container, options, onProgress) {
    record({
      ctor: "Viewer",
      how: "async",
      container,
      options,
      onProgress: typeof onProgress,
    });
    return { scene: { debugShowFramesPerSecond: false } };
  }
}
export class CesiumWidget {
  constructor(container, options) {
    record({ ctor: "CesiumWidget", how: "sync", container, options });
    this.scene = { debugShowFramesPerSecond: false };
  }
  static async createAsync(container, options, onProgress) {
    record({
      ctor: "CesiumWidget",
      how: "async",
      container,
      options,
      onProgress: typeof onProgress,
    });
    return { scene: { debugShowFramesPerSecond: false } };
  }
}
`;

const SANDCASTLE_STUB = `
export default { finishedLoading() {}, highlight() {}, addToolbarButton() {} };
`;

let caseCounter = 0;

/**
 * Embed a demo body the way the runner does, then actually run it.
 *
 * @param {string} code Demo source.
 * @param {"webgl"|"webgpu"} renderer Selected renderer.
 * @param {boolean} [showFps] Whether the FPS switch is on.
 * @returns {Promise<{calls: object[], body: string}>} Recorded constructions.
 */
async function runEmbedded(code, renderer, showFps = false) {
  const body = helpers.embedInSandcastleTemplate(
    code,
    false,
    renderer,
    showFps,
  );

  const root = await mkdtemp(join(tmpdir(), "sandcastle-template-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "sandcastle-template-case", type: "module" }),
  );
  for (const [name, contents] of [
    ["cesium", CESIUM_STUB],
    ["Sandcastle", SANDCASTLE_STUB],
  ]) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, type: "module", main: "index.js" }),
    );
    await writeFile(join(dir, "index.js"), contents);
  }

  const entry = join(root, `demo-${caseCounter++}.mjs`);
  await writeFile(entry, body);

  globalThis.__sandcastleStubCalls = [];
  globalThis.__sandcastleInstances = [];
  globalThis.window ??= globalThis;
  await import(pathToFileURL(entry).href);
  const calls = globalThis.__sandcastleStubCalls;
  const instances = globalThis.__sandcastleInstances;
  globalThis.__sandcastleStubCalls = [];
  globalThis.__sandcastleInstances = [];
  return { calls, instances, body };
}

const VIEWER_DEMO = `import * as Cesium from "cesium";
const viewer = new Cesium.Viewer("cesiumContainer");
`;

const WIDGET_DEMO = `import * as Cesium from "cesium";
const widget = new Cesium.CesiumWidget("cesiumContainer", {
  shouldAnimate: true,
});
`;

const SELF_PINNED_SYNC_DEMO = `import * as Cesium from "cesium";
const viewer = new Cesium.Viewer("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});
`;

const ASYNC_DEMO = `import * as Cesium from "cesium";
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  shouldAnimate: true,
});
`;

// --- Group A: WebGPU construction -----------------------------------------

test("A1 a synchronous Viewer demo is constructed asynchronously on WebGPU", async () => {
  const { calls } = await runEmbedded(VIEWER_DEMO, "webgpu");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctor, "Viewer");
  assert.equal(calls[0].how, "async");
  assert.equal(calls[0].container, "cesiumContainer");
  assert.equal(calls[0].options.contextOptions.renderer, "webgpu");
});

test("A2 a synchronous CesiumWidget demo is constructed asynchronously on WebGPU", async () => {
  const { calls } = await runEmbedded(WIDGET_DEMO, "webgpu");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctor, "CesiumWidget");
  assert.equal(
    calls[0].how,
    "async",
    "a synchronous CesiumWidget cannot reach WebGPU — the engine throws for any non-WebGL renderer",
  );
  assert.equal(calls[0].options.contextOptions.renderer, "webgpu");
  assert.equal(calls[0].options.shouldAnimate, true, "demo options survive");
});

test("A3 an already-async demo keeps its own options and gains the renderer", async () => {
  const { calls } = await runEmbedded(ASYNC_DEMO, "webgpu");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].how, "async");
  assert.equal(calls[0].options.shouldAnimate, true);
  assert.equal(calls[0].options.contextOptions.renderer, "webgpu");
});

// --- Group B: WebGL construction ------------------------------------------

test("B1 a plain demo stays synchronous on WebGL and is pinned to WebGL", async () => {
  const { calls } = await runEmbedded(VIEWER_DEMO, "webgl");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].how, "sync");
  assert.equal(calls[0].container, "cesiumContainer");
  assert.equal(calls[0].options.contextOptions.renderer, "webgl");
});

test("B2 a demo that pins WebGPU in its own source still runs WebGL in the WebGL pane", async () => {
  const { calls } = await runEmbedded(SELF_PINNED_SYNC_DEMO, "webgl");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].options.contextOptions.renderer,
    "webgl",
    "the demo's own renderer must lose to the selection, or a split comparison shows the same backend twice",
  );
});

test("B3 an async demo with no renderer of its own is pinned to WebGL", async () => {
  const { calls } = await runEmbedded(ASYNC_DEMO, "webgl");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].how, "async");
  assert.equal(
    calls[0].options.contextOptions.renderer,
    "webgl",
    "with no explicit renderer the async path prefers WebGPU — the WebGL pane has to say so",
  );
});

test("B4 a CesiumWidget demo is pinned to WebGL too", async () => {
  const { calls } = await runEmbedded(WIDGET_DEMO, "webgl");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctor, "CesiumWidget");
  assert.equal(calls[0].how, "sync");
  assert.equal(calls[0].options.contextOptions.renderer, "webgl");
});

// --- Group C: FPS + line numbers ------------------------------------------

test("C1 the FPS switch reaches the scene on both renderers", async () => {
  for (const renderer of ["webgl", "webgpu"]) {
    const { body } = await runEmbedded(VIEWER_DEMO, renderer, true);
    assert.match(body, /_showFps = true/, renderer);
    assert.match(body, /debugShowFramesPerSecond = true/, renderer);
  }
});

test("C2 the preamble costs exactly two lines in every mode", () => {
  const counts = new Set();
  for (const renderer of ["webgl", "webgpu"]) {
    for (const showFps of [false, true]) {
      const body = helpers.embedInSandcastleTemplate(
        VIEWER_DEMO,
        false,
        renderer,
        showFps,
      );
      const lines = body.split("\n");
      const end = lines.findIndex((line) =>
        line.includes("End Sandcastle Renderer Preamble"),
      );
      assert.notEqual(end, -1, `${renderer}/${showFps}: no end marker`);
      counts.add(end + 1);
    }
  }
  assert.deepEqual(
    [...counts],
    [2],
    "runtime error line numbers are reported raw, so the offset must not vary by mode",
  );
});

test("C3 the demo body keeps its own line numbering after the preamble", async () => {
  const { body } = await runEmbedded(VIEWER_DEMO, "webgpu");
  const lines = body.split("\n");
  assert.match(lines[2], /^import \* as Cesium from "cesium";$/);
});

test("C4 every construction is published where a probe can find it", async () => {
  // A demo's viewer lives in a local const, so without this there is no handle
  // to ask which backend it actually got — which is the whole assertion the
  // headless certification sweep makes.
  for (const [demo, expected] of [
    [VIEWER_DEMO, 1],
    [WIDGET_DEMO, 1],
  ]) {
    for (const renderer of ["webgl", "webgpu"]) {
      const { instances } = await runEmbedded(demo, renderer);
      assert.equal(instances.length, expected, `${renderer}: instance count`);
      assert.ok(instances[0].scene, `${renderer}: instance exposes its scene`);
    }
  }
});

// --- Group D: what must NOT be rewritten ----------------------------------

test("D1 lookalike constructors are left alone", () => {
  const code = `import * as Cesium from "cesium";
class CustomViewer {}
class CesiumWidgetFactory {}
const a = new CustomViewer();
const b = new CesiumWidgetFactory();
`;
  for (const renderer of ["webgl", "webgpu"]) {
    const body = helpers.embedInSandcastleTemplate(code, false, renderer);
    assert.match(body, /new CustomViewer\(\)/, renderer);
    assert.match(body, /new CesiumWidgetFactory\(\)/, renderer);
  }
});

test("D2 every construction in a multi-viewer demo is rewritten", async () => {
  const code = `import * as Cesium from "cesium";
const left = new Cesium.Viewer("left");
const right = new Cesium.Viewer("right");
`;
  const { calls } = await runEmbedded(code, "webgpu");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.container),
    ["left", "right"],
  );
  for (const call of calls) {
    assert.equal(call.how, "async");
    assert.equal(call.options.contextOptions.renderer, "webgpu");
  }
});

// --- Group E: inertness mutant --------------------------------------------

/**
 * Remove the CesiumWidget rows from the transform table in a copy of the
 * source, leaving a module that still compiles.
 *
 * Entry-level surgery rather than line deletion: the mutant has to be a build
 * where the widget rows are absent and everything else is intact. A copy that
 * merely fails to parse would prove nothing.
 *
 * @param {string} source Helpers.ts source text.
 * @returns {string} The same source with the widget rows dropped.
 */
function dropWidgetConstructors(source) {
  const open = source.indexOf("const CONSTRUCTORS");
  // Skip past the `}[]` in the type annotation to the initializer's own bracket.
  const assignment = source.indexOf("= [", open);
  const arrayStart = source.indexOf("[", assignment);
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }
  assert.ok(
    open >= 0 && assignment > open && arrayEnd > arrayStart,
    "transform table not found",
  );

  const inner = source.slice(arrayStart + 1, arrayEnd);
  const entries = [];
  let braceDepth = 0;
  let start = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "{") {
      if (braceDepth === 0) {
        start = i;
      }
      braceDepth++;
    } else if (inner[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        entries.push(inner.slice(start, i + 1));
      }
    }
  }
  const kept = entries.filter((entry) => !entry.includes("CesiumWidget"));
  assert.equal(
    kept.length,
    entries.length - 2,
    "expected exactly two CesiumWidget rows",
  );

  return `${source.slice(0, arrayStart + 1)}\n  ${kept.join(",\n  ")},\n${source.slice(arrayEnd)}`;
}

test("E1 removing the CesiumWidget rows makes the widget cases fail", async () => {
  const original = await readFile(HELPERS_PATH, "utf8");
  const mutated = dropWidgetConstructors(original);
  assert.notEqual(mutated, original, "mutation did not apply");
  assert.ok(
    !/expression: "(Cesium\.)?CesiumWidget"/.test(mutated),
    "a CesiumWidget transform row survived the mutation",
  );

  const inert = await loadHelpers(mutated);
  const body = inert.embedInSandcastleTemplate(WIDGET_DEMO, false, "webgpu");

  // A2's premise, restated against the mutant and required to be false.
  assert.match(
    body,
    /new Cesium\.CesiumWidget\(/,
    "with the rows gone the widget must be left synchronous",
  );
  assert.ok(
    !body.includes("await Cesium.CesiumWidget.createAsync("),
    "A2 survived the CesiumWidget rows being removed",
  );

  // The Viewer rows are untouched, so the mutation is scoped, not a wipe.
  const viewerBody = inert.embedInSandcastleTemplate(
    VIEWER_DEMO,
    false,
    "webgpu",
  );
  assert.match(viewerBody, /await Cesium\.Viewer\.createAsync\(/);
});
