// onmessage-sentinel.spec.mjs - Pure Node contract spec for lib/onmessage-sentinel.mjs (no browser).
// @purpose Runs the real init script and page reader from their serialised source inside a node:vm fake window and asserts a worker-style module assigning window.onmessage after install is detected (X1), an untouched or page-owned handler is not, the verdict never passes an uninstalled sentinel, and that the identity comparison and the verdict changed clause are live (inertness mutants).
// @status ACTIVE

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { importMutated } from "./lib/import-mutated.mjs";
import * as sentinel from "./lib/onmessage-sentinel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Window shapes. "proto" mirrors a browser (accessor on a prototype), the rest
// are the shapes the sentinel must degrade on without throwing.
const SHAPES = {
  proto: `
    function Window() {}
    var slot = null;
    Object.defineProperty(Window.prototype, "onmessage", {
      configurable: true, enumerable: true,
      get: function () { return slot; },
      set: function (v) { slot = typeof v === "function" ? v : null; },
    });
    var win = new Window();`,
  ownAccessor: `
    var slot = null;
    var win = {};
    Object.defineProperty(win, "onmessage", {
      configurable: true, enumerable: true,
      get: function () { return slot; },
      set: function (v) { slot = v; },
    });`,
  data: `var win = { onmessage: null };`,
  nonConfigurable: `
    var slot = null;
    var win = {};
    Object.defineProperty(win, "onmessage", {
      configurable: false, enumerable: true,
      get: function () { return slot; },
      set: function (v) { slot = v; },
    });`,
};

/** A fresh vm realm holding a fake window of the given shape. */
function makeRealm(shape) {
  const ctx = vm.createContext({});
  vm.runInContext(SHAPES[shape], ctx);
  return ctx;
}

// Run a function from its .toString() source with `globalThis` bound to the
// fake window, the way addInitScript / evaluate run it in a page. Nothing from
// this module's scope is visible inside the realm, which proves the functions
// are self-contained. The result is round-tripped through JSON, which also
// proves it is JSON-safe and strips the foreign realm's prototypes.
function runIn(ctx, fn) {
  const out = vm.runInContext(
    `JSON.stringify((function (globalThis) { return (${fn.toString()})(); })(win))`,
    ctx,
  );
  return out === undefined ? undefined : JSON.parse(out);
}

// Evaluate arbitrary page code with `self` bound to the fake window.
function pageScript(ctx, code) {
  vm.runInContext(`(function (self) { ${code} })(win)`, ctx);
}

function install(ctx, lib = sentinel) {
  runIn(ctx, lib.installOnmessageSentinel);
}

function read(ctx, lib = sentinel) {
  return runIn(ctx, lib.pageReadOnmessageSentinel);
}

const WORKER_MODULE =
  "self.onmessage = function workerHandler(event) { return event; };";

for (const shape of ["proto", "ownAccessor"]) {
  test(`${shape}: nothing assigns after install -> unchanged, verdict passes`, () => {
    const ctx = makeRealm(shape);
    install(ctx);
    const record = read(ctx);
    assert.equal(record.installed, true);
    assert.equal(record.changed, false);
    assert.equal(record.assignments, 0);
    assert.equal(record.before, null);
    const verdict = sentinel.onmessageVerdict("rig", record);
    assert.equal(verdict.id, "rig:onmessage-unchanged");
    assert.equal(verdict.pass, true);
    assert.equal(verdict.notRun, undefined);
  });

  test(`${shape}: a worker module assigning self.onmessage after install is detected with a stack and its name`, () => {
    const ctx = makeRealm(shape);
    install(ctx);
    pageScript(ctx, WORKER_MODULE);
    const record = read(ctx);
    assert.equal(record.changed, true);
    assert.ok(record.assignments >= 1);
    assert.ok(record.stacks.length >= 1);
    assert.ok(record.stacks[0].length <= 600);
    assert.equal(record.after.name, "workerHandler");
    assert.equal(record.after.type, "function");
    assert.match(record.after.source, /workerHandler/);
    const verdict = sentinel.onmessageVerdict("rig", record);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.after.name, "workerHandler");
    assert.ok(verdict.assignments >= 1);
  });

  test(`${shape}: a page handler set before install and left alone is unchanged and described`, () => {
    const ctx = makeRealm(shape);
    pageScript(ctx, "self.onmessage = function pageHandler() {};");
    install(ctx);
    const record = read(ctx);
    assert.equal(record.changed, false);
    assert.equal(record.before.name, "pageHandler");
    assert.equal(record.after.name, "pageHandler");
    assert.equal(sentinel.onmessageVerdict("rig", record).pass, true);
  });

  test(`${shape}: replacing a page handler is detected and forwarded to the real accessor`, () => {
    const ctx = makeRealm(shape);
    pageScript(ctx, "self.onmessage = function pageHandler() {};");
    install(ctx);
    pageScript(ctx, WORKER_MODULE);
    const record = read(ctx);
    assert.equal(record.changed, true);
    assert.equal(record.before.name, "pageHandler");
    assert.equal(record.after.name, "workerHandler");
    // Forwarding: the page itself sees the new handler through the wrapper.
    assert.equal(vm.runInContext("typeof win.onmessage", ctx), "function");
    assert.equal(vm.runInContext("win.onmessage.name", ctx), "workerHandler");
  });
}

test("the same function re-assigned is not a change (identity, not assignment count)", () => {
  const ctx = makeRealm("proto");
  pageScript(
    ctx,
    "self.pageHandler = function pageHandler() {}; self.onmessage = self.pageHandler;",
  );
  install(ctx);
  pageScript(ctx, "self.onmessage = self.pageHandler;");
  const record = read(ctx);
  assert.equal(record.assignments, 1);
  assert.equal(record.changed, false);
  assert.equal(sentinel.onmessageVerdict("rig", record).pass, true);
});

test("a data property cannot be wrapped: reason recorded, identity comparison still detects the change", () => {
  const ctx = makeRealm("data");
  install(ctx);
  assert.equal(read(ctx).changed, false);
  assert.match(read(ctx).reason, /data property/);
  pageScript(ctx, WORKER_MODULE);
  const record = read(ctx);
  assert.equal(record.changed, true);
  assert.equal(record.assignments, 0);
  assert.equal(record.after.name, "workerHandler");
  assert.equal(sentinel.onmessageVerdict("rig", record).pass, false);
});

test("a non-configurable accessor cannot be wrapped: reason recorded, identity comparison still detects the change", () => {
  const ctx = makeRealm("nonConfigurable");
  install(ctx);
  assert.match(read(ctx).reason, /non-configurable/);
  assert.equal(read(ctx).changed, false);
  pageScript(ctx, WORKER_MODULE);
  const record = read(ctx);
  assert.equal(record.changed, true);
  assert.equal(sentinel.onmessageVerdict("rig", record).pass, false);
});

test("install is idempotent and never throws on a hostile window", () => {
  const ctx = makeRealm("proto");
  install(ctx);
  pageScript(ctx, WORKER_MODULE);
  install(ctx); // must not re-record the hijacked value as the original
  assert.equal(read(ctx).changed, true);
  const hostile = vm.createContext({});
  vm.runInContext(
    `var win = Object.freeze({ get onmessage() { throw new Error("boom"); } });`,
    hostile,
  );
  assert.doesNotThrow(() => install(hostile));
  assert.doesNotThrow(() => read(hostile));
});

test("init script did not run -> installed false, verdict notRun and never a pass", () => {
  const ctx = makeRealm("proto");
  const record = read(ctx);
  assert.equal(record.installed, false);
  assert.match(record.reason, /did not run/);
  const verdict = sentinel.onmessageVerdict("rig", record);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
  assert.equal(sentinel.onmessageVerdict("rig", null).notRun, true);
  assert.equal(sentinel.onmessageVerdict("rig", undefined).pass, false);
  assert.equal(
    sentinel.onmessageVerdict("rig", { installed: true }).pass,
    false,
  );
});

test("the verdict suffix constant", () => {
  assert.equal(sentinel.ONMESSAGE_VERDICT, "onmessage-unchanged");
});

test("readOnmessageSentinel evaluates the page reader", async () => {
  const ctx = makeRealm("proto");
  install(ctx);
  const page = { evaluate: async (fn) => runIn(ctx, fn) };
  const record = await sentinel.readOnmessageSentinel(page);
  assert.equal(record.installed, true);
  assert.equal(record.changed, false);
});

const lib = path.join(here, "lib/onmessage-sentinel.mjs");

test("INERTNESS: with the identity comparison unreachable a hijack reads as unchanged, so the detection test would go red", async () => {
  const mutated = await importMutated(lib, [
    [
      "const changed = state.original !== current;",
      "const changed = false && state.original !== current;",
    ],
  ]);
  const ctx = makeRealm("proto");
  install(ctx, mutated);
  pageScript(ctx, WORKER_MODULE);
  const record = read(ctx, mutated);
  // The unmutated module reports changed:true for this exact page.
  assert.equal(record.changed, false);
  assert.equal(mutated.onmessageVerdict("rig", record).pass, true);
  assert.equal(read(ctx).changed, true);
});

test("INERTNESS: with the verdict ignoring changed a hijack passes, so the verdict test would go red", async () => {
  const mutated = await importMutated(lib, [
    ["const pass = record.changed === false;", "const pass = true;"],
  ]);
  const ctx = makeRealm("proto");
  install(ctx);
  pageScript(ctx, WORKER_MODULE);
  const record = read(ctx);
  assert.equal(record.changed, true);
  assert.equal(mutated.onmessageVerdict("rig", record).pass, true);
  assert.equal(sentinel.onmessageVerdict("rig", record).pass, false);
});

// ---- positive control (the sentinel proven live inside a run) ----

function controlRecord(ctx, lib = sentinel) {
  runIn(ctx, lib.pageAssignOnmessagePositiveControl);
  return read(ctx, lib);
}

test("control constants", () => {
  assert.equal(
    sentinel.ONMESSAGE_POSITIVE_CONTROL_VERDICT,
    "onmessage-positive-control",
  );
  assert.equal(
    sentinel.ONMESSAGE_POSITIVE_CONTROL_NAME,
    "onmessagePositiveControlHandler",
  );
});

for (const shape of ["proto", "ownAccessor"]) {
  test(`${shape}: control on a sentinel-installed page -> changed, named, counted, PASS`, () => {
    const ctx = makeRealm(shape);
    install(ctx);
    assert.equal(sentinel.onmessageVerdict("rig", read(ctx)).pass, true);
    const result = runIn(ctx, sentinel.pageAssignOnmessagePositiveControl);
    assert.deepEqual(result, {
      assigned: true,
      name: sentinel.ONMESSAGE_POSITIVE_CONTROL_NAME,
    });
    const record = read(ctx);
    assert.equal(record.changed, true);
    assert.equal(record.assignments, 1);
    assert.ok(record.stacks.length >= 1);
    assert.equal(record.after.name, sentinel.ONMESSAGE_POSITIVE_CONTROL_NAME);
    const verdict = sentinel.onmessagePositiveControlVerdict("rig", record);
    assert.equal(verdict.id, "rig:onmessage-positive-control");
    assert.equal(verdict.pass, true);
    assert.equal(verdict.notRun, undefined);
    // The control makes the ordinary verdict fail, which is the point: it is
    // the proof that verdict could have failed.
    assert.equal(sentinel.onmessageVerdict("rig", record).pass, false);
  });
}

test("data property path: no wrap, reason set -> control passes by identity alone", () => {
  const ctx = makeRealm("data");
  install(ctx);
  const record = controlRecord(ctx);
  assert.match(record.reason, /data property/);
  assert.equal(record.assignments, 0);
  assert.equal(record.changed, true);
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", record).pass,
    true,
  );
});

test("no sentinel installed -> control is NOT RUN, never a pass", () => {
  const ctx = makeRealm("proto");
  const record = controlRecord(ctx);
  assert.equal(record.installed, false);
  const verdict = sentinel.onmessagePositiveControlVerdict("rig", record);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", null).notRun,
    true,
  );
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", undefined).pass,
    false,
  );
});

test("a dead sentinel (reader says unchanged after the control) -> FAIL", () => {
  const ctx = makeRealm("proto");
  install(ctx);
  const dead = { ...controlRecord(ctx), changed: false };
  const verdict = sentinel.onmessagePositiveControlVerdict("rig", dead);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, undefined);
});

test("control verdict fails on a wrong handler name, on a wrapped sentinel that counted nothing, and on a bare record", () => {
  const ctx = makeRealm("proto");
  install(ctx);
  const live = controlRecord(ctx);
  const verdict = (r) => sentinel.onmessagePositiveControlVerdict("rig", r);
  assert.equal(verdict(live).pass, true);
  assert.equal(
    verdict({ ...live, after: { ...live.after, name: "workerHandler" } }).pass,
    false,
  );
  assert.equal(verdict({ ...live, assignments: 0 }).pass, false);
  assert.equal(verdict({ installed: true }).pass, false);
  assert.equal(verdict({ installed: true, changed: true }).pass, false);
});

test("the control page function never throws on a hostile window", () => {
  const hostile = vm.createContext({});
  vm.runInContext(
    `var win = Object.freeze({ set onmessage(v) { throw new Error("boom"); } });`,
    hostile,
  );
  const result = runIn(hostile, sentinel.pageAssignOnmessagePositiveControl);
  assert.equal(result.assigned, false);
  assert.match(result.error, /boom/);
  assert.equal(result.name, sentinel.ONMESSAGE_POSITIVE_CONTROL_NAME);
});

test("runOnmessagePositiveControl assigns, then reads the sentinel a second time", async () => {
  const ctx = makeRealm("proto");
  install(ctx);
  const calls = [];
  const page = {
    evaluate: async (fn) => {
      calls.push(fn.name);
      return runIn(ctx, fn);
    },
  };
  const record = await sentinel.runOnmessagePositiveControl(page);
  assert.deepEqual(calls, [
    "pageAssignOnmessagePositiveControl",
    "pageReadOnmessageSentinel",
  ]);
  assert.equal(record.changed, true);
  assert.equal(record.control.assigned, true);
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", record).pass,
    true,
  );
});

test("INERTNESS: with the assignment of the control skipped the sentinel reads unchanged and the control verdict FAILS", async () => {
  const mutated = await importMutated(lib, [
    ["(globalThis).onmessage =\n", "(globalThis).__controlSkipped =\n"],
  ]);
  const ctx = makeRealm("proto");
  install(ctx);
  const record = controlRecord(ctx, mutated);
  assert.equal(record.changed, false);
  assert.equal(
    mutated.onmessagePositiveControlVerdict("rig", record).pass,
    false,
  );
  // The unmutated module passes the identical scenario.
  const ctx2 = makeRealm("proto");
  install(ctx2);
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", controlRecord(ctx2)).pass,
    true,
  );
});

// Each clause of the control verdict is pinned by a record only that clause
// rejects; making the clause unreachable lets the record pass.
const CLAUSE_CASES = [
  {
    clause: "changed",
    anchor: "const sawChange = record.changed === true;",
    mutant: "const sawChange = true;",
    reject: (live) => ({ ...live, changed: false }),
  },
  {
    clause: "name",
    anchor:
      "const sawName = record.after?.name === ONMESSAGE_POSITIVE_CONTROL_NAME;",
    mutant: "const sawName = true;",
    reject: (live) => ({ ...live, after: { ...live.after, name: "other" } }),
  },
  {
    clause: "assignments",
    anchor: "const sawAssignment = record.reason ? true : assignments >= 1;",
    mutant: "const sawAssignment = true;",
    reject: (live) => ({ ...live, assignments: 0 }),
  },
];

for (const c of CLAUSE_CASES) {
  test(`INERTNESS: with the ${c.clause} clause of the control verdict unreachable the rejecting record passes (the control test would go red)`, async () => {
    const mutated = await importMutated(lib, [[c.anchor, c.mutant]]);
    const ctx = makeRealm("proto");
    install(ctx);
    const rejected = c.reject(controlRecord(ctx));
    assert.equal(
      sentinel.onmessagePositiveControlVerdict("rig", rejected).pass,
      false,
    );
    assert.equal(
      mutated.onmessagePositiveControlVerdict("rig", rejected).pass,
      true,
    );
  });
}

test("INERTNESS: with the identity-only (reason) branch unreachable the data-property control no longer passes", async () => {
  const mutated = await importMutated(lib, [
    [
      "const sawAssignment = record.reason ? true : assignments >= 1;",
      "const sawAssignment = assignments >= 1;",
    ],
  ]);
  const ctx = makeRealm("data");
  install(ctx);
  const record = controlRecord(ctx);
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", record).pass,
    true,
  );
  assert.equal(
    mutated.onmessagePositiveControlVerdict("rig", record).pass,
    false,
  );
});

test("INERTNESS: with the notRun clause of the control verdict unreachable an uninstalled sentinel is not reported notRun", async () => {
  const head =
    "ONMESSAGE_POSITIVE_CONTROL_VERDICT}`;\n  const before = record?.before ?? null;\n  const after = record?.after ?? null;\n  const assignments = record?.assignments ?? 0;\n  if (";
  const mutated = await importMutated(lib, [
    [
      `${head}!record || record.installed !== true) {`,
      `${head}false && (!record || record.installed !== true)) {`,
    ],
  ]);
  const record = controlRecord(makeRealm("proto"));
  assert.equal(
    sentinel.onmessagePositiveControlVerdict("rig", record).notRun,
    true,
  );
  assert.equal(
    mutated.onmessagePositiveControlVerdict("rig", record).notRun,
    undefined,
  );
});
