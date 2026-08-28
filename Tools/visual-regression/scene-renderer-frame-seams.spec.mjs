// scene-renderer-frame-seams.spec.mjs — browser-free guards for three
// frame-entry seams in `WebGPUSceneRenderer.ts`. Pure Node: no browser, no GPU,
// no build.
//
// @purpose Guards the opaque-pass frame-start bookkeeping hoist, the viewport clamp's live-canvas bound, and the indirect run-of-one error report.
// @status ACTIVE
//
// ── WHAT THESE THREE HAVE IN COMMON ─────────────────────────────────────────
//
// Each is a frame-entry seam where an early exit, a stale cache, or a swallowed
// throw made the surrounding code's own stated contract false.
//
// (1) OPAQUE-PASS FRAME-START BOOKKEEPING. `_executeOpaquePass` returned on
//     `count === 0` ABOVE the block that resets `_gpuCullLastInput`, ticks
//     `_statsLastFrameId`, and clears the latched `_hiZConsumedThisFrame`.
//     Those are the only reset sites for those fields anywhere in the tree, and
//     the frustum loop calls this pass unconditionally for every frustum — so a
//     frame whose first-executed frustum had an empty opaque bin skipped all of
//     them, leaving the HiZ latch stuck true from an earlier frame and the
//     `hiZActive` diagnostic reporting a consumption that never happened. Two
//     comments in the file asserted the reset was unconditional; neither was.
//
// (2) VIEWPORT CLAMP BOUND. The clamp's own comment says it bounds the
//     requested rectangle "to canvas ... so a stale rectangle from a previous
//     resize doesn't blow past the texture extents". It bounded against
//     `_width`/`_height`, whose sole writer runs later in the same method — so
//     on the first frame after a resize it clamped against the PREVIOUS extent.
//     After a shrink that bound is LOOSER than the canvas, which is precisely
//     the overrun the clamp exists to prevent.
//
// (3) INDIRECT RUN-OF-ONE REPORTING. `executeBatchIndirect` reports a failed
//     draw through a deduped permanent warn in its non-batchable branch, and
//     swallowed the identical throw in its run-of-one branch — so whether a
//     broken command was reportable depended on whether it happened to merge
//     with a neighbour. This is a real-error path, so the report is permanent
//     (no debug pragma) per the fork's logging rules.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// Nothing here asserts source text. A source-text assertion certifies text, not
// liveness. The real renderer is bundled with esbuild — its dependencies
// stubbed, `Pass.js` bundled for real so the pass indices are the real ones —
// and the real code is driven against fakes it cannot tell from the engine.
// Each group then re-imports through a source mutation and requires the
// behavioural assertion to go RED, in two flavours: ABSENCE (the code is
// deleted) and INERTNESS (the code is still present but unreachable). A guard
// that only survives deletion is proving text presence, not that the branch is
// live. Every mutation goes through a vacuity check that fails loudly if its
// anchor text has moved.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the mutation anchors
// below are matched against the source's own line terminators.
//
// Run: node --test Tools/visual-regression/scene-renderer-frame-seams.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const RENDERER_PATH = resolve(engineWebGPU, "WebGPUSceneRenderer.ts");
const RENDERER_SOURCE = await readFile(RENDERER_PATH, "utf8");

// The real pass indices. `Pass.js` is a dependency-free enum object, so it
// imports directly; the bundle below resolves the same file for real rather
// than stubbing it, so the renderer and this spec agree on `Pass.OPAQUE`.
const { default: Pass } = await import(
  pathToFileURL(resolve(engineWebGPU, "../Pass.js")).href
);

// Each stubbed dependency is generated as a REAL ES module exporting exactly
// the names the renderer imports from it. A CommonJS proxy is not usable here:
// esbuild's interop materialises the namespace by copying the module's OWN
// property names, and a proxy has none to copy, so every named import would
// arrive undefined. Scanning the import statements instead keeps the stub
// honest — a dependency the renderer stops importing stops being stubbed.
const MAKE = [
  "const make = () =>",
  "  new Proxy(function () {}, {",
  "    get: (t, k) => (typeof k === 'symbol' ? undefined : make()),",
  "    apply: () => make(),",
  "    construct: () => make(),",
  "  });",
].join("\n");

/**
 * Maps each imported specifier to the binding names taken from it.
 *
 * @param {string} source The renderer source.
 * @returns {Map<string, {names: Set<string>, hasDefault: boolean}>} The map.
 */
function scanImports(source) {
  const imports = new Map();
  const pattern = /import\b([\s\S]*?)from\s*"([^"]+)"\s*;/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, rawClause, specifier] = match;
    const clause = rawClause.replace(/^\s*type\s+/, "").trim();
    const entry = imports.get(specifier) ?? {
      names: new Set(),
      hasDefault: false,
    };
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part.replace(/^\s*type\s+/, "").trim();
        if (name.length === 0) {
          continue;
        }
        // `{ backToFront as _localName }` exports `backToFront`; the alias is
        // only the local binding, so the stub must declare the ORIGINAL name.
        const exported = name.split(/\s+as\s+/)[0].trim();
        if (exported === "default") {
          entry.hasDefault = true;
        } else {
          entry.names.add(exported);
        }
      }
    }
    const defaultBinding = clause.split("{")[0].replace(/,\s*$/, "").trim();
    if (defaultBinding.length > 0) {
      entry.hasDefault = true;
    }
    imports.set(specifier, entry);
  }
  return imports;
}

const IMPORTS = scanImports(RENDERER_SOURCE);

/**
 * Generates the stub module text for one specifier.
 *
 * @param {string} specifier The import specifier being stubbed.
 * @returns {string} ES module source.
 */
function stubFor(specifier) {
  const entry = IMPORTS.get(specifier) ?? {
    names: new Set(),
    hasDefault: true,
  };
  const lines = [MAKE];
  for (const name of entry.names) {
    lines.push(`export const ${name} = make();`);
  }
  lines.push("export default make();");
  return lines.join("\n");
}

/**
 * Bundles the renderer with every dependency stubbed except the real `Pass`,
 * optionally through a source mutation, and imports the result.
 *
 * @param {(source: string) => string} [mutate] Source rewrite.
 * @param {string} [label] Name used in the did-it-change assertion.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
async function importRenderer(mutate, label) {
  let source = RENDERER_SOURCE;
  if (mutate) {
    source = mutate(RENDERER_SOURCE);
    assert.notEqual(
      source,
      RENDERER_SOURCE,
      `the ${label} mutation changed nothing — its anchor text has moved, so ` +
        `this mutation test would pass vacuously and the result it exists to ` +
        `falsify would be unfalsifiable`,
    );
  }
  const result = await build({
    stdin: {
      contents: source,
      resolveDir: engineWebGPU,
      sourcefile: "WebGPUSceneRenderer.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-dependencies",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") {
              return undefined;
            }
            if (args.path.endsWith("/Pass.js")) {
              return undefined;
            }
            return { path: args.path, namespace: "stub" };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubFor(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const baseline = await importRenderer();

// ───────────────────────── group 1: frame-start bookkeeping ─────────────────

/**
 * Builds the arguments for one opaque pass.
 *
 * @param {number} opaqueCount Commands in the frustum's opaque bin.
 * @returns {object} The frustum commands, the config, and a call log.
 */
function opaquePassFrame(opaqueCount) {
  const commands = [];
  for (let i = 0; i < opaqueCount; i++) {
    commands.push({});
  }
  const frustumCommands = { commands: {}, indices: {} };
  frustumCommands.commands[Pass.OPAQUE] = commands;
  frustumCommands.indices[Pass.OPAQUE] = opaqueCount;
  const updatePassCalls = [];
  return {
    frustumCommands,
    updatePassCalls,
    config: {
      scene: { _view: { frustumCommandsList: [{}, {}] } },
      context: {
        uniformState: {
          updatePass: (pass) => updatePassCalls.push(pass),
        },
      },
      passState: {},
      picking: false,
    },
  };
}

/**
 * Puts a renderer into the state a previous frame would have left behind.
 *
 * @param {object} renderer The renderer under test.
 * @returns {object} The same renderer.
 */
function latchFromPreviousFrame(renderer) {
  renderer._hiZConsumedThisFrame = true;
  renderer._sortConsumeAppliedThisFrame = true;
  renderer._gpuCullLastInput = 7;
  renderer._currentFrustumIndex = 0;
  return renderer;
}

/**
 * Runs one zero-opaque frustum-zero frame and reports the bookkeeping state.
 *
 * @param {Record<string, unknown>} module The imported renderer module.
 * @returns {object} Observed post-frame state.
 */
function runEmptyFrustumZeroFrame(module) {
  const renderer = latchFromPreviousFrame(new module.WebGPUSceneRenderer());
  const before = renderer._statsLastFrameId;
  const { frustumCommands, config, updatePassCalls } = opaquePassFrame(0);
  renderer._executeOpaquePass(frustumCommands, config);
  return {
    hiZLatch: renderer._hiZConsumedThisFrame,
    sortLatch: renderer._sortConsumeAppliedThisFrame,
    cullInput: renderer._gpuCullLastInput,
    frameIdDelta: renderer._statsLastFrameId - before,
    updatePassCalls,
  };
}

test("1a a zero-opaque frustum-zero frame still runs frame-start bookkeeping", () => {
  const observed = runEmptyFrustumZeroFrame(baseline);
  assert.equal(
    observed.hiZLatch,
    false,
    "the HiZ consumption latch must be cleared at frame start; a stuck-true " +
      "latch makes the hiZActive diagnostic report a consumption that the " +
      "frame never performed",
  );
  assert.equal(observed.sortLatch, false, "the sort-consume latch must clear");
  assert.equal(observed.cullInput, 0, "the cull accumulator must reset");
  assert.equal(
    observed.frameIdDelta,
    1,
    "the stats frame id must tick exactly once per frame",
  );
});

test("1b the zero-count early return still returns before pass work", () => {
  const empty = runEmptyFrustumZeroFrame(baseline);
  assert.deepEqual(
    empty.updatePassCalls,
    [],
    "an empty opaque bin must not open the opaque pass",
  );

  const renderer = latchFromPreviousFrame(new baseline.WebGPUSceneRenderer());
  const { frustumCommands, config, updatePassCalls } = opaquePassFrame(1);
  try {
    renderer._executeOpaquePass(frustumCommands, config);
  } catch {
    // Past the early return the pass reaches stubbed GPU machinery. Only the
    // fact that it got there is under test here.
  }
  assert.deepEqual(
    updatePassCalls,
    [Pass.OPAQUE],
    "a non-empty opaque bin must still proceed into the pass",
  );
});

test("1c picking and non-zero frustum indices still skip the bookkeeping", () => {
  const picking = latchFromPreviousFrame(new baseline.WebGPUSceneRenderer());
  const pickFrame = opaquePassFrame(0);
  pickFrame.config.picking = true;
  picking._executeOpaquePass(pickFrame.frustumCommands, pickFrame.config);
  assert.equal(
    picking._hiZConsumedThisFrame,
    true,
    "a pick pass is not a frame start and must not reset render-pass state",
  );

  const later = latchFromPreviousFrame(new baseline.WebGPUSceneRenderer());
  later._currentFrustumIndex = 1;
  const laterFrame = opaquePassFrame(0);
  later._executeOpaquePass(laterFrame.frustumCommands, laterFrame.config);
  assert.equal(
    later._hiZConsumedThisFrame,
    true,
    "only the first-executed frustum starts a frame",
  );
});

const BOOKKEEPING_GATE =
  "    if (!config.picking && this._currentFrustumIndex === 0) {";

test("1d mutation (absence): deleting the hoisted block turns 1a red", async () => {
  const module = await importRenderer((source) => {
    const start = source.indexOf(
      "    // Run frame-start bookkeeping at the top of every opaque pass",
    );
    const gate = source.indexOf(BOOKKEEPING_GATE, start);
    const last = source.indexOf(
      "      trimMap(this._lastCullResultsByFrustum);",
      gate,
    );
    assert.ok(start > 0 && gate > start && last > gate, "anchors moved");
    const close = source.indexOf("    }", last) + "    }".length;
    return source.slice(0, start) + source.slice(close);
  }, "bookkeeping-absence");
  assert.throws(
    () => {
      const observed = runEmptyFrustumZeroFrame(module);
      assert.equal(observed.hiZLatch, false);
      assert.equal(observed.frameIdDelta, 1);
    },
    /AssertionError/,
    "with the bookkeeping deleted the empty-frame assertions must fail",
  );
});

test("1e mutation (inertness): an unreachable hoisted block turns 1a red", async () => {
  const module = await importRenderer(
    (source) =>
      source.replace(
        BOOKKEEPING_GATE,
        "    if (false && !config.picking && this._currentFrustumIndex === 0) {",
      ),
    "bookkeeping-inertness",
  );
  assert.throws(
    () => {
      const observed = runEmptyFrustumZeroFrame(module);
      assert.equal(observed.hiZLatch, false);
      assert.equal(observed.frameIdDelta, 1);
    },
    /AssertionError/,
    "a block that is present but unreachable must not satisfy this guard",
  );
});

// ───────────────────────── group 2: viewport clamp bound ────────────────────

/**
 * Snapshots the viewport for one frame whose canvas has just shrunk while the
 * cached resource extent still holds the pre-resize size.
 *
 * @param {Record<string, unknown>} module The imported renderer module.
 * @param {object|undefined} viewport The requested rectangle, if any.
 * @returns {object} The renderer's viewport snapshot.
 */
function snapshotViewportAfterShrink(module, viewport) {
  const renderer = new module.WebGPUSceneRenderer();
  // The extent `_ensureResources` published on the previous, larger frame.
  renderer._width = 1600;
  renderer._height = 900;
  renderer.executeCommands({
    scene: { _view: { frustumCommandsList: [] }, _frameState: {} },
    // `prepareFrame` has already rebuilt the scene framebuffer at this size.
    context: { _canvas: { width: 800, height: 450 } },
    passState: viewport ? { viewport } : {},
    // A pick pass returns early, after the viewport snapshot at the top.
    picking: true,
  });
  return {
    x: renderer._viewportX,
    y: renderer._viewportY,
    width: renderer._viewportWidth,
    height: renderer._viewportHeight,
  };
}

test("2a a stale requested rectangle is clamped to the live canvas", () => {
  assert.deepEqual(
    snapshotViewportAfterShrink(baseline, {
      x: 0,
      y: 0,
      width: 1600,
      height: 900,
    }),
    { x: 0, y: 0, width: 800, height: 450 },
    "the clamp must bound against the 800x450 canvas the framebuffer was " +
      "just rebuilt at, not the 1600x900 extent still sitting in the cache",
  );
});

test("2b the full-canvas fallback also uses the live canvas", () => {
  assert.deepEqual(
    snapshotViewportAfterShrink(baseline, undefined),
    { x: 0, y: 0, width: 800, height: 450 },
    "with no requested rectangle the viewport must fall back to the live " +
      "canvas, not to the stale cache",
  );
});

test("2c mutation (inertness): computing the bound but not using it turns 2a red", async () => {
  const module = await importRenderer(
    (source) =>
      source
        .replace(
          "        Math.min(clampWidth - this._viewportX, vp.width | 0),",
          "        Math.min(this._width - this._viewportX, vp.width | 0),",
        )
        .replace(
          "        Math.min(clampHeight - this._viewportY, vp.height | 0),",
          "        Math.min(this._height - this._viewportY, vp.height | 0),",
        ),
    "clamp-inertness",
  );
  assert.throws(
    () =>
      assert.deepEqual(
        snapshotViewportAfterShrink(module, {
          x: 0,
          y: 0,
          width: 1600,
          height: 900,
        }),
        { x: 0, y: 0, width: 800, height: 450 },
      ),
    /AssertionError/,
    "a live bound that is computed and then ignored must not satisfy 2a",
  );
});

test("2d mutation (absence): the fallback branch reverted turns 2b red", async () => {
  const module = await importRenderer(
    (source) =>
      source
        .replace(
          "      this._viewportWidth = clampWidth;",
          "      this._viewportWidth = this._width;",
        )
        .replace(
          "      this._viewportHeight = clampHeight;",
          "      this._viewportHeight = this._height;",
        ),
    "clamp-fallback-absence",
  );
  assert.throws(
    () =>
      assert.deepEqual(snapshotViewportAfterShrink(module, undefined), {
        x: 0,
        y: 0,
        width: 800,
        height: 450,
      }),
    /AssertionError/,
    "the fallback must be covered independently of the clamped branch",
  );
});

// ───────────────────────── group 3: run-of-one reporting ────────────────────

class FakePrimitive {}

/**
 * Drives `executeBatchIndirect` over single commands whose draw throws, so the
 * run-of-one branch is the one that has to report it.
 *
 * @param {Record<string, unknown>} module The imported renderer module.
 * @param {string[]} messages One throw message per invocation.
 * @returns {Array<Array<string>>} The level/message pairs logged.
 */
function runFailingSingletonDraws(module, messages) {
  const logged = [];
  const context = {
    currentRenderPassEncoder: {},
    indirectDrawManager: {
      beginFrame() {},
      submitBatch: () => -1,
      flush() {},
    },
    log: (level, message) => logged.push([level, message]),
  };
  for (const message of messages) {
    const command = {
      isWebGPUDrawCommand: true,
      indexBuffer: {},
      indexCount: 3,
      pipeline: {},
      owner: new FakePrimitive(),
      execute() {
        throw new Error(message);
      },
    };
    module.executeBatchIndirect([command], 1, {}, context, {});
  }
  return logged;
}

test("3a a failed run-of-one draw is reported once, permanently, deduped", () => {
  const logged = runFailingSingletonDraws(baseline, [
    "pipeline is not bound",
    "pipeline is not bound",
  ]);
  assert.equal(
    logged.length,
    1,
    "two identical failures must dedupe to a single report, matching the " +
      "sibling branch that already reports this throw",
  );
  assert.equal(logged[0][0], "warn", "a failed draw is a real-error path");
  assert.match(
    logged[0][1],
    /Indirect path command failed \(FakePrimitive\): pipeline is not bound/,
    "the report must carry the owning primitive and the underlying message",
  );
});

test("3b a different failure is still reported", () => {
  const logged = runFailingSingletonDraws(baseline, [
    "pipeline is not bound",
    "index buffer is destroyed",
  ]);
  assert.equal(
    logged.length,
    2,
    "dedupe is per distinct failure, not a one-shot mute",
  );
});

test("3c mutation (absence): restoring the silent catch turns 3a red", async () => {
  const module = await importRenderer((source) => {
    const start = source.indexOf(
      "        // A run of one still failed to draw, so report it through",
    );
    assert.ok(start > 0, "anchor moved");
    const tail = source.indexOf("        }\r\n      }\r\n", start);
    assert.ok(tail > start, "catch-body tail anchor moved");
    return `${source.slice(0, start)}        void e;\r\n${source.slice(tail + "        }\r\n".length)}`;
  }, "report-absence");
  assert.equal(
    runFailingSingletonDraws(module, ["pipeline is not bound"]).length,
    0,
    "this mutation must actually silence the path, or 3c proves nothing",
  );
});

test("3d mutation (inertness): an unreachable report turns 3a red", async () => {
  const module = await importRenderer((source) => {
    // Four sites in this file share this shape. Anchor to the run-of-one
    // report's own comment first, or the mutation lands on an unrelated one
    // and the test passes while proving nothing.
    const start = source.indexOf(
      "        // A run of one still failed to draw, so report it through",
    );
    assert.ok(start > 0, "run-of-one report anchor moved");
    const anchor = "        if (!warned.has(key)) {";
    const at = source.indexOf(anchor, start);
    assert.ok(at > start, "dedupe gate anchor moved");
    return `${source.slice(0, at)}        if (false && !warned.has(key)) {${source.slice(at + anchor.length)}`;
  }, "report-inertness");
  assert.equal(
    runFailingSingletonDraws(module, ["pipeline is not bound"]).length,
    0,
    "a report that is present but unreachable must not satisfy 3a",
  );
});
