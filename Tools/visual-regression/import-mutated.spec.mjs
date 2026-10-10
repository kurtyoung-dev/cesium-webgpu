// import-mutated.spec.mjs — the shared mutant loader, on fixture modules.
// @purpose Pins lib/import-mutated.mjs: a replacement changes what the module does, relative imports still reach the original files, an anchor found zero or two times is refused, a replacement is literal, and a CRLF source matches an LF anchor.
// @status ACTIVE
//
// Pure Node. Each case writes two or three tiny modules under the lane's temp
// root and imports them through the loader; nothing here reads a probe.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

/** Write `files` ({relative path: source}) under `root`; return `root`. */
function writeTree(root, files) {
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

const GATED = [
  'import { VALUE } from "./dep.mjs";',
  'import { PARENT } from "../parent.mjs";',
  "export function gated(x) {",
  "  if (x > 1) {",
  "    return VALUE + PARENT;",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");

test("a replacement makes the pinned branch unreachable, and the relative imports still reach the original files", () =>
  withLaneTmp("import-mutated-", async (root) => {
    writeTree(root, {
      "parent.mjs": "export const PARENT = 40;\n",
      "sub/dep.mjs": "export const VALUE = 2;\n",
      "sub/mod.mjs": GATED,
    });
    const file = path.join(root, "sub", "mod.mjs");
    const original = await import(pathToFileURL(file).href);
    assert.equal(original.gated(5), 42);
    const unchanged = await importMutated(file, []);
    assert.equal(unchanged.gated(5), 42, "./ and ../ both resolved");
    const mutated = await importMutated(file, [
      ["if (x > 1) {", "if (false && x > 1) {"],
    ]);
    assert.equal(mutated.gated(5), 0);
  }));

test("an anchor that occurs zero times or twice is refused, naming the count", () =>
  withLaneTmp("import-mutated-", async (root) => {
    writeTree(root, {
      "twice.mjs": "export const a = 1;\nexport const b = 1;\n",
    });
    const file = path.join(root, "twice.mjs");
    await assert.rejects(
      importMutated(file, [["no such text", ""]]),
      /exactly once .* found 0/,
    );
    await assert.rejects(
      importMutated(file, [[" = 1;", " = 2;"]]),
      /exactly once .* found 2/,
    );
  }));

test("a replacement is literal: $& and a template literal land byte for byte", () =>
  withLaneTmp("import-mutated-", async (root) => {
    writeTree(root, {
      "lit.mjs": 'export function label() {\n  return "plain";\n}\n',
    });
    const mutated = await importMutated(path.join(root, "lit.mjs"), [
      ['return "plain";', "return `$&${1 + 1}$'`;"],
    ]);
    assert.equal(mutated.label(), "$&2$'");
  }));

test("a CRLF source matches an anchor written with LF", () =>
  withLaneTmp("import-mutated-", async (root) => {
    writeTree(root, {
      "crlf.mjs":
        "export function pick(x) {\r\n  if (x) {\r\n    return 1;\r\n  }\r\n  return 2;\r\n}\r\n",
    });
    const mutated = await importMutated(path.join(root, "crlf.mjs"), [
      ["  if (x) {\n    return 1;", "  if (false) {\n    return 1;"],
    ]);
    assert.equal(mutated.pick(true), 2);
  }));
