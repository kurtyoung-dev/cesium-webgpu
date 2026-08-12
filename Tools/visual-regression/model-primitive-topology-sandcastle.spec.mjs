import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEMO_PATH = path.join(
  REPO_ROOT,
  "packages/sandcastle/gallery/khr-mesh-primitive-restart-dev/main.js",
);
const HELPERS_PATH = path.join(REPO_ROOT, "packages/sandcastle/src/Helpers.ts");

const demoSource = readFileSync(DEMO_PATH, "utf8");
const helpersSource = readFileSync(HELPERS_PATH, "utf8");

function applyWebGpuViewerTransform(source) {
  return source.replace(
    /new\s+Cesium\.Viewer\s*\(/g,
    "await Cesium.Viewer.createAsync(",
  );
}

function checkModuleSyntax(source) {
  return spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
  });
}

test("the policy models Sandcastle's live WebGPU Viewer transform", () => {
  assert.ok(
    helpersSource.includes("/new\\s+Cesium\\.Viewer\\s*\\(/g"),
    "the Sandcastle transform matcher changed; update this policy with it",
  );
  assert.ok(
    helpersSource.includes('"await Cesium.Viewer.createAsync("'),
    "the Sandcastle transform replacement changed; update this policy with it",
  );

  const transformed = applyWebGpuViewerTransform(demoSource);
  assert.notEqual(
    transformed,
    demoSource,
    "the demo must exercise the transform",
  );
  assert.equal(
    transformed.match(/await Cesium\.Viewer\.createAsync\(/g)?.length,
    1,
    "the demo must have exactly one transformed Viewer factory",
  );
});

test("the primitive-restart demo remains valid after the WebGPU transform", () => {
  assert.match(demoSource, /async function createViewer\(requestWebgl1\)/);
  assert.equal(
    demoSource.match(/\bcreateViewer\(/g)?.length,
    4,
    "the factory declaration and all three call sites must remain covered",
  );
  assert.equal(
    demoSource.match(/await createViewer\(/g)?.length,
    3,
    "every factory call must settle before model loading uses the viewer",
  );

  const transformed = applyWebGpuViewerTransform(demoSource);
  const result = checkModuleSyntax(transformed);
  assert.equal(result.status, 0, result.stderr);

  const priorBrokenShape = transformed.replace(
    "async function createViewer",
    "function createViewer",
  );
  const negativeControl = checkModuleSyntax(priorBrokenShape);
  assert.notEqual(
    negativeControl.status,
    0,
    "the syntax gate must reject await injected into a non-async factory",
  );
  assert.match(negativeControl.stderr, /Unexpected reserved word/);
});

test("the primitive-restart demo is isolated from optional network imagery", () => {
  assert.equal(
    demoSource.match(/\bbaseLayer:\s*false\b/g)?.length,
    1,
    "the focused topology demo must not request Cesium ion world imagery",
  );
  assert.equal(
    demoSource.match(/\bbaseLayerPicker:\s*false\b/g)?.length,
    1,
    "the focused topology demo must not create imagery-provider UI or sessions",
  );
});
