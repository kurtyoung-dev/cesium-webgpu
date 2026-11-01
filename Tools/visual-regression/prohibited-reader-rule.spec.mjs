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

// An escaped backtick inside a template nested in another template's `${}`
// used to end the outer template early and read the rest of the file as
// code: a clean source scanned as `parse-error`. Built from char codes so the
// backslash survives every shell and editor on the way here.
const BS = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const NESTED_ESCAPED = `const a = ${BT}x \${ok ? ${BT}in ${BS}${BT} y${BT} : "z"} w${BT};`;

test("a template nested in a substitution, holding an escaped backtick, scans clean", () => {
  assertGreen(`${NESTED_ESCAPED}\nconst b = { c: 1 };`);
  assertGreen(`const a = ${BT}x \${JSON.stringify({ a: 1 })} w${BT};`);
});

test("a reader after a nested escaped-backtick template is still found on its line", () => {
  assertFlagged(
    `${NESTED_ESCAPED}\nctx.drawImage(viewer.scene.canvas, 0, 0);`,
    2,
  );
  // A brace inside the nested template does not close the substitution.
  assertFlagged(
    `const a = ${BT}x \${${BT}a } b${BT}} y${BT};\nctx.drawImage(viewer.scene.canvas, 0, 0);`,
    2,
  );
});

test("inertness: a template scan that ignores substitutions reads the nested escaped backtick as a parse error", async () => {
  const { importMutated } = await import("./lib/import-mutated.mjs");
  const { fileURLToPath } = await import("node:url");
  const mutant = await importMutated(
    fileURLToPath(new URL("./lib/prohibited-reader-rule.mjs", import.meta.url)),
    [
      [
        '} else if (sourceText.startsWith("${", index)) {',
        '} else if (false && sourceText.startsWith("${", index)) {',
      ],
    ],
  );
  assert.equal(
    mutant.analyzeProhibitedReader(`${NESTED_ESCAPED}\nconst b = 1;`)
      .violations[0]?.kind,
    "parse-error",
  );
});
