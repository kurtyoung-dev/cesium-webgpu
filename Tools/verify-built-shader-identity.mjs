#!/usr/bin/env node
// @purpose Preflight that fails when the built bundle a probe is about to measure does not embed the shader text currently on disk.
// @status ACTIVE
//
// Run this before any probe whose verdict is about shader behaviour:
//
//   node Tools/verify-built-shader-identity.mjs
//   node Tools/verify-built-shader-identity.mjs --bundle Build/CesiumUnminified/Cesium.js
//   node Tools/verify-built-shader-identity.mjs --shader GlobeTerrain
//
// Exit 0  every shader in the bundle matches its source
//      1  at least one shader DRIFTED — the bundle is stale, rebuild before measuring
//      2  bad usage
//      3  the bundle is absent (STRUCTURAL: nothing was measured, not a pass)
//
// WHY IT IS NOT ENOUGH TO COMPARE md5s. The standing executor preflight asserts
// `served md5 == disk md5`. That proves the dev server is not caching. It cannot
// prove `Build/` was regenerated from the current source, and that is the
// failure that actually occurs: on 2026-09-05 a draped-polyline probe scored a
// FAIL against a bundle whose embedded WGSL predated the fix under test, while
// its own source tree carried the fix. Both md5s agreed the whole time.
//
// A shader asked for BY NAME that is absent from the bundle fails, because "I
// could not find it" is not an answer to "is the shader I am about to measure
// current?" — a check that reports success when it found nothing to check is
// worse than no check. In a whole-tree sweep absence is reported but does not
// fail: a handful of shaders are legitimately absent from any single bundle
// (tree-shaken, or split into a lazily-loaded chunk).

import fs from "node:fs";
import path from "node:path";

import { compareBuiltShaderIdentity } from "./visual-regression/lib/built-shader-identity.mjs";

const DEFAULT_BUNDLE = "Build/CesiumUnminified/Cesium.js";
const SHADER_ROOT = "packages/engine/Source/Shaders/WebGPU";

function parseArgs(argv) {
  const options = { bundle: DEFAULT_BUNDLE, root: process.cwd(), shaders: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bundle") {
      options.bundle = argv[++i];
    } else if (arg === "--root") {
      options.root = argv[++i];
    } else if (arg === "--shader") {
      options.shaders.push(argv[++i]);
    } else {
      console.error(`unknown argument: ${arg}`);
      return null;
    }
  }
  return options.bundle && options.root ? options : null;
}

function collectShaderFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectShaderFiles(full, found);
    } else if (entry.name.endsWith(".wgsl")) {
      found.push(full);
    }
  }
  return found;
}

const options = parseArgs(process.argv.slice(2));
if (options === null) {
  console.error(
    "usage: verify-built-shader-identity.mjs [--bundle <path>] [--root <path>] [--shader <BaseName>]",
  );
  process.exit(2);
}

const bundlePath = path.resolve(options.root, options.bundle);
if (!fs.existsSync(bundlePath)) {
  console.error(
    `STRUCTURAL: no bundle at ${bundlePath} — nothing was verified.`,
  );
  console.error("Build it first (npx gulp build), then re-run.");
  process.exit(3);
}

const shaderRoot = path.resolve(options.root, SHADER_ROOT);
if (!fs.existsSync(shaderRoot)) {
  console.error(`STRUCTURAL: no shader tree at ${shaderRoot}.`);
  process.exit(3);
}

const wanted = new Set(options.shaders);
const shaders = collectShaderFiles(shaderRoot)
  .map((file) => ({ name: path.basename(file, ".wgsl"), file }))
  .filter(({ name }) => wanted.size === 0 || wanted.has(name))
  .map(({ name, file }) => ({ name, source: fs.readFileSync(file, "utf8") }));

if (shaders.length === 0) {
  console.error("STRUCTURAL: no shaders selected — nothing was verified.");
  process.exit(3);
}

const bundleText = fs.readFileSync(bundlePath, "utf8");
const report = compareBuiltShaderIdentity({ bundleText, shaders });

const current = report.results.filter((r) => r.status === "current").length;
console.log(`bundle : ${bundlePath}`);
console.log(
  `shaders: ${shaders.length} checked, ${current} current, ` +
    `${report.drifted.length} drifted, ${report.absent.length} absent`,
);

// A shader the caller NAMED must be present: "I could not find it" is not an
// answer to "is the shader I am about to measure current?". In a whole-tree
// sweep absence is only reported — a handful of shaders are legitimately absent
// from any one bundle (tree-shaken, or split into a lazily-loaded chunk), and
// failing on those would make the sweep useless and train readers to skip it.
const absentIsFailure = wanted.size > 0;

for (const result of report.results) {
  if (result.status === "current") {
    continue;
  }
  if (result.status === "absent") {
    const line = `  ABSENT  ${result.name} — no embedded copy in the bundle`;
    if (absentIsFailure) {
      console.error(line);
    } else {
      console.log(`${line} (not requested by name; reported only)`);
    }
    continue;
  }
  const where = result.firstDifferingLine;
  console.error(`  DRIFTED ${result.name} — the bundle predates the source`);
  if (where) {
    console.error(`    first differing line ${where.line}`);
    console.error(
      `      built : ${JSON.stringify((where.built ?? "").trim().slice(0, 90))}`,
    );
    console.error(
      `      source: ${JSON.stringify((where.source ?? "").trim().slice(0, 90))}`,
    );
  }
}

const failed =
  report.drifted.length > 0 || (absentIsFailure && report.absent.length > 0);
if (failed) {
  console.error(
    "\nThe bundle does not carry the shader source on disk. Any probe measuring it " +
      "is measuring the OLD shader; rebuild before treating a result as a product verdict.",
  );
  process.exit(1);
}
console.log("OK — every checked shader in the bundle matches its source.");
