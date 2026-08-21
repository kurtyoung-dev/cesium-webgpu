import assert from "node:assert/strict";
import test from "node:test";

import { analyzeProhibitedReader } from "./lib/prohibited-reader-rule.mjs";

const assertFlagged = (sourceText, expectedLine) => {
  const { violations } = analyzeProhibitedReader(sourceText);
  assert.deepEqual(violations, [
    {
      kind: "prohibited-live-canvas-reader",
      line: expectedLine,
    },
  ]);
};

const assertGreen = (sourceText) => {
  assert.deepEqual(analyzeProhibitedReader(sourceText), { violations: [] });
};

test("flags a live scene canvas passed to drawImage", () => {
  assertFlagged(
    `const copy = document.createElement("canvas").getContext("2d");
copy.drawImage(scene.canvas, 0, 0);
copy.getImageData(0, 0, 1, 1);`,
    2,
  );
});

test("flags a live canvas passed through aliases", () => {
  assertFlagged(
    `const canvas = scene.canvas;
const aliasedCanvas = canvas;
ctx.drawImage(aliasedCanvas, 0, 0);`,
    3,
  );
});

test("flags an inline viewer canvas argument", () => {
  assertFlagged(`ctx.drawImage(viewer.canvas, 0, 0);`, 1);
});

test("flags a canvas returned by document.querySelector", () => {
  assertFlagged(
    `const canvas = document.querySelector(".cesium-widget canvas");
ctx.drawImage(canvas, 0, 0);`,
    2,
  );
});

test("flags a canvas returned by document.getElementById", () => {
  assertFlagged(
    `ctx.drawImage(document.getElementById("renderCanvas"), 0, 0);`,
    1,
  );
});

test("flags an indexed document.getElementsByTagName result", () => {
  assertFlagged(
    `const canvas = document.getElementsByTagName("canvas")[0];
ctx.drawImage(canvas, 0, 0);`,
    2,
  );
});

test("flags a nested DOM querySelector result", () => {
  assertFlagged(
    `const canvas = document
  .getElementById("cesiumContainer")
  ?.querySelector("canvas");
ctx.drawImage(canvas, 0, 0);`,
    4,
  );
});

test("flags executable source stored in a template literal", () => {
  assertFlagged(
    [
      "const prelude = `",
      "const scene = viewer.scene;",
      "ctx.drawImage(scene.canvas, 0, 0);",
      "`;",
    ].join("\n"),
    3,
  );
});

test("allows a decoded frozen PNG", () => {
  assertGreen(`const img = new Image();
img.src = dataUrl;
ctx.drawImage(img, 0, 0);
ctx.getImageData(0, 0, width, height);`);
});

test("allows getImageData on an untouched scratch context", () => {
  assertGreen(`const scratch = document.createElement("canvas");
const ctx = scratch.getContext("2d");
ctx.getImageData(0, 0, width, height);`);
});

test("allows an unrelated OffscreenCanvas source", () => {
  assertGreen(`const frozen = new OffscreenCanvas(width, height);
ctx.drawImage(frozen, 0, 0);
ctx.getImageData(0, 0, width, height);`);
});

test("allows sanctioned toDataURL capture of a live canvas", () => {
  assertGreen(`const canvas = document.querySelector("canvas");
const png = canvas.toDataURL("image/png");`);
});
