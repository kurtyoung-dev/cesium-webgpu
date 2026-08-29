// scene-debug-pragma-coverage.spec.mjs
// @purpose Pins which scene diagnostics are stripped from release builds and which must survive, by running the real production strip over the real sources.
// @status ACTIVE
//
// A diagnostic that interpolates a template literal pays for the string on
// every call, whether or not anyone reads the console. The pragma pair removes
// that cost from release builds outright. This spec drives the ACTUAL strip
// used by the production build — `constructRegex` and `pragmas` from
// `scripts/build.js`, the same pair the esbuild plugin applies — so it fails if
// the wrapping stops working, not merely if the comment text changes.
//
// Three things are pinned, and they fail for different reasons:
//
//   - FORK DIAGNOSTICS ARE STRIPPED. Each wrapped diagnostic must be gone from
//     the stripped source.
//   - THEIR CONTROL FLOW SURVIVES. Only the logging statement may be removed.
//     Counters, assignments and loop control around it are load-bearing, and a
//     pragma pair that swallows them is the failure mode this checks for.
//   - REAL ERRORS ARE NOT STRIPPED. A message the user needs in order to
//     report a production bug must reach the console in a release build. These
//     must SURVIVE the strip, so wrapping one later fails here.
//
// Run: node --test Tools/visual-regression/scene-debug-pragma-coverage.spec.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engineSource = path.join(root, "packages/engine/Source");
const readScene = (p) =>
  fs.readFileSync(path.join(engineSource, "Scene", p), "utf8");

// The production strip itself, not a re-typed copy of it.
const buildModule = await import(
  pathToFileURL(path.join(root, "scripts", "build.js")).href
);
const stripDebug = (source) =>
  source.replace(
    buildModule.constructRegex("debug", buildModule.pragmas.debug),
    "",
  );

// Fork-added diagnostics: a marker unique to the message, plus statements next
// to it that must NOT be carried off with it.
const STRIPPED = [
  {
    file: "Scene.js",
    marker: "alternate scene renderer CREATED",
    neighbours: [
      "this._alternateSceneRenderer = new sceneRendererFR.RendererClass();",
      "} else if (context.requiresSceneRenderer) {",
    ],
  },
  {
    // The bracket tag alone is not unique in this file — an unrelated
    // `console.warn` shares it — so the marker names this message.
    file: "SceneRenderer.js",
    marker: "[WebGPU:EnvInject] Injected ",
    neighbours: ["scene._envDiagLogged = true;"],
  },
  {
    file: "GlobeSurfaceTileProviderRendering.js",
    marker: "[WebGPU:TileDraw] PROCEEDING",
    neighbours: ["_webgpuTileDiagCount++;"],
  },
  {
    // Every SKIP diagnostic in this function is throttled by a counter that
    // must outlive the strip, and the messages themselves interpolate.
    file: "GlobeSurfaceTileProviderRendering.js",
    marker: "[WebGPU:TileDraw] SKIP — no mesh data.",
    neighbours: [
      "_webgpuTileDiagCount++;",
      "surfaceTile.fill = new TerrainFillMesh(tile);",
    ],
  },
  {
    file: "GlobeSurfaceTileProviderRendering.js",
    marker: "[WebGPU:TileDraw] SKIP — no device",
    neighbours: ["_webgpuTileDiagCount++;", "const device = context.device;"],
  },
  {
    file: "GlobeSurfaceTileProviderRendering.js",
    marker: "[WebGPU:TileDraw] SKIP — no shader code.",
    neighbours: [
      "_webgpuTileDiagCount++;",
      "const shaderCode = fr.getShaderCode ? fr.getShaderCode() : undefined;",
    ],
  },
  {
    // The sibling EnvInject diagnostic above sets the flag this one reads,
    // and that assignment is itself debug-only: unwrapped, this warning
    // fires on every frame of a release build.
    file: "SceneRenderer.js",
    marker: "skipped: no execute method",
    neighbours: ["return length + 1;"],
  },
  {
    file: "Cesium3DTilesInvalidationFeed.js",
    marker: "[InvalidationFeed] tileset.json refetch requested",
    neighbours: ["this._tilesetJsonRequests++;", "continue;"],
  },
];

// Real-error paths. These report a fault that produces broken output, and the
// user needs them to diagnose a release build.
const MUST_SURVIVE = [
  { file: "Cesium3DTileset.js", marker: "A 3D tile failed to load" },
  { file: "Multiple3DTileContent.js", marker: "A content failed to load" },
  { file: "TimeDynamicPointCloud.js", marker: "A frame failed to load" },
];

test("every wrapped scene diagnostic is removed by the production strip", () => {
  for (const { file, marker } of STRIPPED) {
    const source = readScene(file);
    assert.ok(
      source.includes(marker),
      `${file}: the diagnostic "${marker}" is gone — update this spec or the wrap`,
    );
    assert.ok(
      !stripDebug(source).includes(marker),
      `${file}: "${marker}" survives a release build, so it still costs its ` +
        `interpolated string in production`,
    );
  }
});

test("stripping a diagnostic never carries off the code around it", () => {
  for (const { file, neighbours } of STRIPPED) {
    const stripped = stripDebug(readScene(file));
    for (const neighbour of neighbours) {
      assert.ok(
        stripped.includes(neighbour),
        `${file}: the pragma pair swallowed \`${neighbour}\``,
      );
    }
  }
});

test("stripped scene sources still parse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pragma-parse-"));
  try {
    for (const { file } of STRIPPED) {
      const out = path.join(dir, `${path.basename(file, ".js")}.mjs`);
      fs.writeFileSync(out, stripDebug(readScene(file)));
      // `node --check` parses without executing: a pragma pair that ate a
      // brace shows up here and nowhere else.
      execFileSync(process.execPath, ["--check", out], { stdio: "pipe" });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real-error reporting survives the production strip", () => {
  for (const { file, marker } of MUST_SURVIVE) {
    const source = readScene(file);
    assert.ok(
      source.includes(marker),
      `${file}: expected the error message "${marker}"`,
    );
    assert.ok(
      stripDebug(source).includes(marker),
      `${file}: "${marker}" reports a real fault and must reach the console ` +
        `in a release build — it must not be wrapped in debug pragmas`,
    );
  }
});
