// upstream-shape-guard.spec.mjs — behaviour spec for UPSTREAM-SYNC-1.145-08.
//
// @purpose Pins the ES6-shape guard's behaviour: it fires on a real class-to-prototype reversion, stays quiet on shapes the file already had, and is not inert.
// @status ACTIVE
//
// WHAT THIS ASSERTS, AND WHY IN THIS SHAPE. The guard's whole value is that it
// fires on a reversion nothing else can see, so the spec is written against the
// observable behaviour — "given this before/after pair, does it report a
// violation" — not against the implementation's internals. Group A is the real
// reversion. Group B is the set of shapes that must NOT fire, and it is the half
// that decides whether anyone will keep the guard: a shape check that fails on
// legitimate code gets disabled within a week.
//
// Group C is the inertness mutant required by CLAUDE.md Principle 10. Deleting
// code is the easy mutation and most specs survive it; this one makes the
// detector UNREACHABLE (`shapeViolations` returns `[]` unconditionally) and
// requires group A to start failing. A spec that greps the guard's source would
// assert text shape, not that the branch is live.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { shapeViolations } from "./upstream-shape-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, "upstream-shape-guard.mjs");

const AS_CLASS = `import defined from "../Core/defined.js";

class Widget {
  constructor(options) {
    this._value = options.value;
  }

  get value() {
    return this._value;
  }

  render(frameState) {
    return defined(frameState);
  }
}

export default Widget;
`;

const AS_PROTOTYPE = `import defined from "../Core/defined.js";

function Widget(options) {
  this._value = options.value;
}

Object.defineProperties(Widget.prototype, {
  value: {
    get: function () {
      return this._value;
    },
  },
});

Widget.prototype.render = function (frameState) {
  return defined(frameState);
};

export default Widget;
`;

const P = "packages/engine/Source/Scene/Widget.js";

test("A1 — a class file reverted to its prototype ancestor is reported", () => {
  const v = shapeViolations([
    { path: P, before: AS_CLASS, after: AS_PROTOTYPE },
  ]);
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.kind).sort(), [
    "CLASS_LOST",
    "PROTOTYPE_REINTRODUCED",
  ]);
  assert.ok(v.every((x) => x.path === P && x.name === "Widget"));
});

test("A2 — the class kept but a prototype method grafted back on is reported", () => {
  const after = `${AS_CLASS}\nWidget.prototype.legacyRender = function () {};\n`;
  const v = shapeViolations([{ path: P, before: AS_CLASS, after }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "PROTOTYPE_REINTRODUCED");
  assert.match(v[0].detail, /0 -> 1/);
});

test("A3 — the report names the file, the kind and the class", () => {
  const [first] = shapeViolations([
    { path: P, before: AS_CLASS, after: AS_PROTOTYPE },
  ]);
  assert.equal(first.path, P);
  assert.equal(first.name, "Widget");
  assert.equal(typeof first.detail, "string");
});

test("B1 — an unchanged class file is clean", () => {
  assert.deepEqual(
    shapeViolations([{ path: P, before: AS_CLASS, after: AS_CLASS }]),
    [],
  );
});

test("B2 — a file that was never a class is out of scope even if it is all prototypes", () => {
  assert.deepEqual(
    shapeViolations([{ path: P, before: AS_PROTOTYPE, after: AS_PROTOTYPE }]),
    [],
  );
});

test("B3 — a prototype assignment the file ALREADY had does not fire (counted against the base, not against zero)", () => {
  const withShim = `${AS_CLASS}\nWidget.prototype.legacyRender = function () {};\n`;
  assert.deepEqual(
    shapeViolations([{ path: P, before: withShim, after: withShim }]),
    [],
    "a class-plus-interop-shim file must not fail merely for keeping what it shipped",
  );
});

test("B4 — but a SECOND assignment on top of that shim does fire", () => {
  const withShim = `${AS_CLASS}\nWidget.prototype.legacyRender = function () {};\n`;
  const after = `${withShim}Widget.prototype.legacyUpdate = function () {};\n`;
  const v = shapeViolations([{ path: P, before: withShim, after }]);
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /1 -> 2/);
});

test("B5 — an indented prototype assignment inside a function body is not a reversion", () => {
  const after = AS_CLASS.replace(
    "export default Widget;",
    `function installLegacy() {\n  Widget.prototype.render = function () {};\n}\n\nexport default Widget;`,
  );
  assert.deepEqual(shapeViolations([{ path: P, before: AS_CLASS, after }]), []);
});

test("B6 — `export default class` and `export class` are both recognised as classes", () => {
  for (const decl of [
    "export default class Widget {}",
    "export class Widget {}",
  ]) {
    assert.deepEqual(
      shapeViolations([{ path: P, before: decl, after: decl }]),
      [],
    );
    const v = shapeViolations([
      {
        path: P,
        before: decl,
        after: "function Widget() {}\nWidget.prototype.x = function () {};\n",
      },
    ]);
    assert.equal(v.length, 2, `both violations expected for: ${decl}`);
  }
});

test("B7 — CRLF and LF sources are judged identically", () => {
  const crlf = (s) => s.replace(/\n/g, "\r\n");
  assert.deepEqual(
    shapeViolations([
      { path: P, before: crlf(AS_CLASS), after: crlf(AS_PROTOTYPE) },
    ]).map((v) => v.kind),
    shapeViolations([{ path: P, before: AS_CLASS, after: AS_PROTOTYPE }]).map(
      (v) => v.kind,
    ),
  );
});

test("C — INERTNESS MUTANT: with the detector unreachable, A1 stops failing", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "shape-guard-mutant-"));
  try {
    const src = readFileSync(GUARD, "utf8");
    const marker = "export function shapeViolations(files) {";
    assert.ok(
      src.includes(marker),
      "the mutant needs the exported entry point to still be named `shapeViolations`",
    );
    const mutated = src.replace(marker, `${marker}\n  if (true) return [];`);
    assert.notEqual(
      mutated,
      src,
      "the mutation must actually change the source",
    );
    const file = resolve(dir, "mutant.mjs");
    writeFileSync(file, mutated);
    const { shapeViolations: inert } = await import(pathToFileURL(file).href);

    assert.deepEqual(
      inert([{ path: P, before: AS_CLASS, after: AS_PROTOTYPE }]),
      [],
      "sanity: the mutant really is inert",
    );
    // The point of the mutant: with the detector dead, A1's assertion must fail.
    assert.throws(() => {
      const v = inert([{ path: P, before: AS_CLASS, after: AS_PROTOTYPE }]);
      assert.equal(v.length, 2);
    }, "A1 survived an inert detector — the spec is certifying its own fixture, not the guard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
