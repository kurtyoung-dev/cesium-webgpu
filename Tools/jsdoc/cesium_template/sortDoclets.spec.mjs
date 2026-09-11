import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { before } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const helperPath = fileURLToPath(new URL("./sortDoclets.js", import.meta.url));

function loadSortDoclets() {
  const module = { exports: {} };
  const source = readFileSync(helperPath, "utf8");
  const wrapper = new vm.Script(
    `(function (exports, require, module, __filename, __dirname) {${source}\n})`,
    { filename: helperPath },
  ).runInThisContext();

  wrapper(
    module.exports,
    createRequire(helperPath),
    module,
    helperPath,
    path.dirname(helperPath),
  );
  return module.exports;
}

let sortDoclets;

before(() => {
  sortDoclets = loadSortDoclets();
});

function ids(items) {
  return items.map((item) => item.id);
}

test("restores logical numeric and dotted longname ordering", () => {
  const doclets = [
    { id: "ten", longname: "A10" },
    { id: "two", longname: "A2" },
    { id: "dot-five", longname: "Tile1.5" },
    { id: "dot-ten", longname: "Tile1.10" },
  ];

  assert.strictEqual(sortDoclets(doclets), doclets);
  assert.deepEqual(ids(doclets), ["two", "ten", "dot-ten", "dot-five"]);
});

test("keeps mixed-case and equal-longname ties stable", () => {
  const doclets = [
    { id: "alpha-upper", longname: "Alpha", version: "9", since: "9" },
    { id: "alpha-lower", longname: "alpha", version: "1", since: "1" },
    { id: "same-new", longname: "Same", version: "2", since: "new" },
    { id: "same-old", longname: "Same", version: "1", since: "old" },
  ];

  sortDoclets(doclets);
  assert.deepEqual(ids(doclets), [
    "alpha-upper",
    "alpha-lower",
    "same-new",
    "same-old",
  ]);
});

test("matches historical null, undefined, and missing-key stringification", () => {
  const missing = { id: "missing" };
  const explicitUndefined = { id: "explicit", longname: undefined };
  const doclets = [
    missing,
    { id: "null", longname: null },
    explicitUndefined,
    { id: "alpha", longname: "Alpha" },
  ];

  sortDoclets(doclets);
  assert.deepEqual(ids(doclets), ["alpha", "null", "missing", "explicit"]);
});

test("retains Cesium packedLength before UNIT_X", () => {
  const doclets = [
    { id: "unit", longname: "Cartesian3.UNIT_X" },
    { id: "packed", longname: "Cartesian3.packedLength" },
  ];

  sortDoclets(doclets);
  assert.deepEqual(ids(doclets), ["packed", "unit"]);
});

test("rejects a direct lexical-sort mutant", () => {
  const input = [
    { id: "unit", longname: "Cartesian3.UNIT_X" },
    { id: "packed", longname: "Cartesian3.packedLength" },
    { id: "ten", longname: "A10" },
    { id: "two", longname: "A2" },
  ];
  const expected = ids(sortDoclets(input.map((item) => ({ ...item }))));
  const lexical = ids(
    input
      .slice()
      .sort((a, b) =>
        a.longname < b.longname ? -1 : a.longname > b.longname ? 1 : 0,
      ),
  );

  assert.deepEqual(expected, ["two", "ten", "packed", "unit"]);
  assert.notDeepEqual(lexical, expected);
});

test("preserves Salty query and object semantics after reconstruction", () => {
  const { taffy } = require("@jsdoc/salty");
  const classDoclet = { id: "class", kind: "class", longname: "Thing10" };
  const ignoredDoclet = {
    id: "ignored",
    ignore: true,
    kind: "member",
    longname: "Thing2",
  };
  const memberDoclet = {
    id: "member",
    kind: "member",
    longname: "Thing1",
  };
  const doclets = [classDoclet, ignoredDoclet, memberDoclet];

  sortDoclets(doclets);
  const data = taffy(doclets);
  assert.deepEqual(ids(data().get()), ["member", "ignored", "class"]);
  assert.strictEqual(data({ kind: "class" }).get()[0], classDoclet);

  data().each((doclet) => {
    doclet.visited = true;
  });
  assert.equal(data({ visited: true }).get().length, 3);
  assert.equal(data({ ignore: true }).remove(), 1);
  assert.deepEqual(ids(data().get()), ["member", "class"]);
  assert.strictEqual(data({ id: "member" }).get()[0], memberDoclet);
});
