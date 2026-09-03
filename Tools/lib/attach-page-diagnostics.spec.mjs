// attach-page-diagnostics.spec.mjs — behaviour contract for
// attachPageDiagnostics: array separation, ownership-safe detach, filtering
// and capped overflow counting. Pure Node: no browser.
//
// @purpose Behaviour spec for attachPageDiagnostics — separation, detach
//   ownership, filter and cap/overflow — against a fake EventEmitter-shaped
//   page, no browser.
// @status ACTIVE
//
// The page double is intentionally the same shape used elsewhere in this
// fleet (`Tools/visual-regression/lib/sandcastle2-origin-rewrite.mjs`'s
// spec): a Node `EventEmitter` behind `on`/`off`, plus small helper methods
// to fire fake Playwright `console` / `pageerror` events. Every assertion
// below is about OBSERVABLE behaviour — what ends up in the two arrays, what
// a pre-existing listener still sees, what the overflow counters read — never
// about the shape of the helper's source text.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { attachPageDiagnostics } from "./attach-page-diagnostics.mjs";

/**
 * A fake Playwright `Page`: an `EventEmitter` behind `on`/`off`, with two
 * `emit*` helpers standing in for the real `console` and `pageerror` events.
 */
function makeFakePage() {
  const emitter = new EventEmitter();
  return {
    on: (event, fn) => emitter.on(event, fn),
    off: (event, fn) => emitter.off(event, fn),
    listenerCount: (event) => emitter.listenerCount(event),
    emitConsole(msg) {
      emitter.emit("console", msg);
    },
    emitPageError(err) {
      emitter.emit("pageerror", err);
    },
  };
}

/** A fake Playwright `ConsoleMessage`. `location` omitted means "not exposed". */
function fakeConsoleMessage(type, text, location) {
  return {
    type: () => type,
    text: () => text,
    ...(location === undefined ? {} : { location: () => location }),
  };
}

test("B1 separates console messages and page errors into their own arrays", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page);

  page.emitConsole(fakeConsoleMessage("log", "hello"));
  page.emitConsole(fakeConsoleMessage("error", "boom"));
  page.emitPageError(new Error("uncaught"));

  assert.equal(diag.console.length, 2);
  assert.equal(diag.errors.length, 1);
  assert.deepEqual(
    diag.console.map((r) => r.type),
    ["log", "error"],
  );
  assert.equal(diag.errors[0].type, "pageerror");
  assert.equal(diag.errors[0].text, "uncaught");
  assert.ok(
    diag.console.every((r) => r.type !== "pageerror"),
    "a page error must never land in the console array",
  );
});

test("B2 records carry type/text/location/timestamp; location is null when the event exposes none", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page);
  const before = Date.now();

  page.emitConsole(
    fakeConsoleMessage("warning", "careful", {
      url: "a.js",
      lineNumber: 3,
      columnNumber: 1,
    }),
  );
  page.emitConsole(fakeConsoleMessage("log", "no location exposed"));
  page.emitPageError(new Error("boom"));
  const after = Date.now();

  const [withLocation, withoutLocation] = diag.console;
  assert.deepEqual(withLocation.location, {
    url: "a.js",
    lineNumber: 3,
    columnNumber: 1,
  });
  assert.equal(withoutLocation.location, null);
  assert.equal(diag.errors[0].location, null);

  for (const record of [...diag.console, ...diag.errors]) {
    assert.ok(
      record.timestamp >= before && record.timestamp <= after,
      "timestamp must fall within the window the events were emitted in",
    );
  }
});

test("B3 detach() removes only its own listeners; a pre-existing listener on the same page survives", () => {
  const page = makeFakePage();
  let preExistingCalls = 0;
  const preExistingConsole = () => {
    preExistingCalls += 1;
  };
  const preExistingPageError = () => {
    preExistingCalls += 1;
  };
  page.on("console", preExistingConsole);
  page.on("pageerror", preExistingPageError);
  const before = {
    console: page.listenerCount("console"),
    pageerror: page.listenerCount("pageerror"),
  };

  const diag = attachPageDiagnostics(page);
  assert.equal(page.listenerCount("console"), before.console + 1);
  assert.equal(page.listenerCount("pageerror"), before.pageerror + 1);

  diag.detach();

  assert.equal(
    page.listenerCount("console"),
    before.console,
    "detach must remove exactly the console listener it added",
  );
  assert.equal(
    page.listenerCount("pageerror"),
    before.pageerror,
    "detach must remove exactly the pageerror listener it added",
  );

  page.emitConsole(fakeConsoleMessage("error", "after detach"));
  page.emitPageError(new Error("after detach"));

  assert.equal(
    diag.console.length,
    0,
    "a detached diagnostics handle must not keep collecting",
  );
  assert.equal(
    diag.errors.length,
    0,
    "a detached diagnostics handle must not keep collecting",
  );
  assert.equal(
    preExistingCalls,
    2,
    "the pre-existing listener must still fire after detach()",
  );
});

test("B4 detach() is idempotent: a second call touches the page zero more times and leaves a later handle on the same page untouched", () => {
  const page = makeFakePage();
  // `doesNotThrow` alone is satisfied by an empty `detach(){}` and proves
  // nothing about idempotence. Spy on `page.off` so the assertion is about
  // the one thing "idempotent" actually promises here (see the module's
  // OWNERSHIP comment): a second call performs no further interaction with
  // the page at all, not merely "removes nothing new by coincidence".
  let offCalls = 0;
  const originalOff = page.off;
  page.off = (event, fn) => {
    offCalls += 1;
    return originalOff(event, fn);
  };

  const diagA = attachPageDiagnostics(page);
  diagA.detach();
  assert.equal(
    offCalls,
    2,
    "the first detach() removes exactly the two listeners it added",
  );

  const diagB = attachPageDiagnostics(page);
  assert.doesNotThrow(() => diagA.detach());
  assert.equal(
    offCalls,
    2,
    "a second detach() call must not call page.off() again — including not risking a later handle's listeners",
  );

  page.emitConsole(fakeConsoleMessage("error", "seen by B only"));
  page.emitPageError(new Error("seen by B only"));
  assert.equal(
    diagB.console.length,
    1,
    "B must be unaffected by A's second detach() call",
  );
  assert.equal(
    diagB.errors.length,
    1,
    "B must be unaffected by A's second detach() call",
  );
});

test("B5 a filter predicate decides what is kept, across both streams uniformly", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page, {
    filter: (record) => record.type === "error" || record.type === "pageerror",
  });

  page.emitConsole(fakeConsoleMessage("log", "quiet"));
  page.emitConsole(fakeConsoleMessage("warning", "meh"));
  page.emitConsole(fakeConsoleMessage("error", "loud"));
  page.emitPageError(new Error("crash"));

  assert.deepEqual(
    diag.console.map((r) => r.text),
    ["loud"],
  );
  assert.equal(diag.errors.length, 1);
  assert.equal(diag.errors[0].text, "crash");
});

test("B6 cap limits the console array and counts overflow instead of dropping silently", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page, { cap: 2 });

  for (let i = 0; i < 5; i++) {
    page.emitConsole(fakeConsoleMessage("error", `e${i}`));
  }
  page.emitPageError(new Error("only one"));

  assert.equal(diag.console.length, 2);
  assert.deepEqual(
    diag.console.map((r) => r.text),
    ["e0", "e1"],
  );
  assert.equal(diag.overflow.console, 3);
  assert.equal(diag.errors.length, 1);
  assert.equal(diag.overflow.errors, 0);
});

test("B7 the errors array overflows independently of the console cap", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page, { cap: 1 });

  page.emitPageError(new Error("first"));
  page.emitPageError(new Error("second"));
  page.emitPageError(new Error("third"));

  assert.equal(diag.errors.length, 1);
  assert.equal(diag.overflow.errors, 2);
  assert.equal(diag.overflow.console, 0);
});

test("B8 two independent attachPageDiagnostics calls on the same page each detach only their own listener", () => {
  const page = makeFakePage();
  const diagA = attachPageDiagnostics(page);
  const diagB = attachPageDiagnostics(page);

  page.emitConsole(fakeConsoleMessage("error", "seen by both"));
  assert.equal(diagA.console.length, 1);
  assert.equal(diagB.console.length, 1);

  diagA.detach();
  page.emitConsole(fakeConsoleMessage("error", "only B now"));

  assert.equal(
    diagA.console.length,
    1,
    "A must stop collecting after its own detach",
  );
  assert.equal(diagB.console.length, 2, "B must be unaffected by A's detach");
});

test("B9 a page-error value without a .message falls back to String(err)", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page);
  page.emitPageError("plain string error");
  assert.equal(diag.errors[0].text, "plain string error");
});

test("B10 a console message whose location() throws is still recorded, with location null", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page);
  const msg = {
    type: () => "error",
    text: () => "boom",
    location: () => {
      throw new Error("no location available");
    },
  };
  page.emitConsole(msg);
  assert.equal(diag.console.length, 1);
  assert.equal(diag.console[0].location, null);
});

test("B11 seq is a monotonically increasing arrival-order key shared across both streams, resolving ties timestamp alone cannot", () => {
  const page = makeFakePage();
  const diag = attachPageDiagnostics(page);

  // Synchronous emission in a fast test run typically lands every record in
  // the same Date.now() millisecond — exactly the ambiguity a consumer
  // re-merging by `timestamp` alone cannot resolve (see L2 of the review:
  // `[...console, ...errors].sort by timestamp` inverted a same-ms pair).
  // Interleave the two streams so a naive concat-then-sort would group all
  // console records before all error records regardless of true order.
  page.emitPageError(new Error("first"));
  page.emitConsole(fakeConsoleMessage("error", "second"));
  page.emitPageError(new Error("third"));
  page.emitConsole(fakeConsoleMessage("error", "fourth"));

  const merged = [...diag.console, ...diag.errors].sort(
    (a, b) => a.seq - b.seq,
  );
  assert.deepEqual(
    merged.map((r) => r.text),
    ["first", "second", "third", "fourth"],
    "sorting the concatenation by seq must restore true arrival order across both streams",
  );

  const seqs = merged.map((r) => r.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "seq values must already be sorted once merged in arrival order",
  );
  assert.equal(
    new Set(seqs).size,
    seqs.length,
    "seq values must be unique across both streams",
  );
});
