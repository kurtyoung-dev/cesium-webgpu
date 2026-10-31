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
