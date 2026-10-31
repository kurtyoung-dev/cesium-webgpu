// probe-runtime-args-kinds.spec.mjs — the runtime's `iso-instant` flag kind and
// the descriptor's `finalize` hook, through `parseProbeArgs`.
// @purpose Pins the runtime flag kind iso-instant (validated, normalized, calendar-checked) and the descriptor finalize hook for dependent defaults, through parseProbeArgs, with inertness mutants run by the lead.
// @status ACTIVE
//
// RUN: node --test Tools/visual-regression/probe-runtime-args-kinds.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { parseProbeArgs } from "./lib/probe-runtime.mjs";

const CLOCK = { flag: "--clock", key: "clock", kind: "iso-instant" };

test("K1: an iso-instant flag is validated and normalized at parse time", () => {
  const parsed = parseProbeArgs(["--clock", "2026-06-21T18:00:00.000Z"], {
    extraOptions: [CLOCK],
  });
  assert.equal(parsed.clock, "2026-06-21T18:00:00Z");
  assert.equal(
    parseProbeArgs(["--clock", "2026-06-21T14:00:00-04:00"], {
      extraOptions: [CLOCK],
    }).clock,
    "2026-06-21T18:00:00Z",
  );
});

test("K2: an instant without a zone, off the calendar, or not an instant is a TypeError naming the flag", () => {
  for (const bad of [
    "noon",
    "2026-06-21T18:00:00",
    "2026-02-30T12:00:00Z",
    "2026-06-21",
  ]) {
    assert.throws(
      () => parseProbeArgs(["--clock", bad], { extraOptions: [CLOCK] }),
      (error) =>
        error instanceof TypeError &&
        /--clock must be an ISO 8601 instant/.test(error.message),
      bad,
    );
  }
  assert.throws(
    () => parseProbeArgs(["--clock"], { extraOptions: [CLOCK] }),
    /--clock requires a value/,
  );
});

test("K3: finalize sees which keys the command line set and may resolve a dependent default", () => {
  const seen = [];
  const finalize = (parsed, { explicit }) => {
    seen.push([...explicit].sort());
    return explicit.has("runs") || parsed.cells !== "identity"
      ? parsed
      : { ...parsed, runs: 2 };
  };
  const args = {
    extraOptions: [{ flag: "--cells", key: "cells", kind: "string" }],
    finalize,
  };
  assert.equal(parseProbeArgs(["--cells", "identity"], args).runs, 2);
  assert.equal(
    parseProbeArgs(["--cells", "identity", "--runs", "1"], args).runs,
    1,
  );
  assert.equal(parseProbeArgs(["--cells", "other"], args).runs, 1);
  assert.deepEqual(seen, [["cells"], ["cells", "runs"], ["cells"]]);
});

test("K4: a finalize that returns no object is a caller error, and governance still applies after it", () => {
  assert.throws(
    () => parseProbeArgs([], { finalize: () => undefined }),
    /finalize must return an object/,
  );
  assert.throws(
    () =>
      parseProbeArgs([], { finalize: (parsed) => ({ ...parsed, port: 8080 }) }),
    (error) => error?.reason === "port-8080-forbidden",
  );
});
