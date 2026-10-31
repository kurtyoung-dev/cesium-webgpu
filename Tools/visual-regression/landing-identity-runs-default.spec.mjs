// landing-identity-runs-default.spec.mjs — a landing run that includes an identity
// cell defaults to two runs, through the real flag parser.
//
// @purpose Asserts that probe-landing-cells takes --runs 2 when --cells includes an identity cell (E-D, E-D-HDR, E-ID-2d, E-ID-cv) and --runs was not given, that an explicit --runs always wins, that cells with no identity flag keep one run, that the default cells (which include E-D) therefore take two, and that the lifecycle deadline and the planned work read the final run count.
// @status ACTIVE
//
// Written from the observable contract: `parseProbeArgs(argv, descriptor.args)`
// is the runtime's own parser, and the deadline comes from the runtime's own
// `deriveLifecycleDeadline` over the parsed options. The identity set is read
// from the cell table's `identity` flag, so a cell added there is covered here.
//
// RUN: node --test Tools/visual-regression/landing-identity-runs-default.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { LANDING_CELLS } from "./lib/landing-cell-table.mjs";
import { deriveLifecycleDeadline } from "./lib/probe-lifecycle-run.mjs";
import { parseProbeArgs } from "./lib/probe-runtime.mjs";
import { descriptor } from "./probe-landing-cells.mjs";

const parse = (...argv) => parseProbeArgs(argv, descriptor.args);

const IDENTITY_CELLS = Object.entries(LANDING_CELLS)
  .filter(([, cell]) => cell.identity === true)
  .map(([name]) => name);

test("I1: the identity cells are the four the brief names", () => {
  assert.deepEqual([...IDENTITY_CELLS].sort(), [
    "E-D",
    "E-D-HDR",
    "E-ID-2d",
    "E-ID-cv",
  ]);
});

test("I2: each identity cell alone, without --runs, takes two runs", () => {
  for (const cell of IDENTITY_CELLS) {
    assert.equal(parse("--cells", cell).runs, 2, cell);
  }
});

test("I3: an explicit --runs always wins, up or down", () => {
  for (const cell of IDENTITY_CELLS) {
    assert.equal(parse("--cells", cell, "--runs", "1").runs, 1, cell);
    assert.equal(parse("--cells", cell, "--runs", "3").runs, 3, cell);
  }
  assert.equal(parse("--runs", "1", "--cells", "E-D").runs, 1);
});

test("I4: cells with no identity flag keep one run", () => {
  const others = Object.keys(LANDING_CELLS).filter(
    (cell) => !IDENTITY_CELLS.includes(cell),
  );
  assert.ok(others.length > 0);
  for (const cell of others) {
    assert.equal(parse("--cells", cell).runs, 1, cell);
  }
  assert.equal(parse("--cells", "E-O,E-F").runs, 1);
});

test("I5: one identity cell among others is enough", () => {
  assert.equal(parse("--cells", "E-O,E-ID-cv").runs, 2);
  assert.equal(parse("--cells", "E-T-water, E-D-HDR").runs, 2);
});

test("I6: with no --cells the default cells apply, and they include E-D, so the run takes two", () => {
  assert.equal(parse().runs, 2);
  assert.equal(parse("--perf").runs, 2);
  assert.equal(parse("--runs", "1").runs, 1);
});

test("I7: an unknown cell name is not an identity cell (planning refuses it later)", () => {
  assert.equal(parse("--cells", "E-nope").runs, 1);
  assert.equal(parse("--cells", "").runs, 1);
});

test("I8: the other options are untouched by the default", () => {
  const withDefault = parse("--cells", "E-D", "--frames", "7");
  const explicit = parse("--cells", "E-D", "--frames", "7", "--runs", "2");
  assert.deepEqual(withDefault, explicit);
});

test("I9: the lifecycle deadline reads the final run count", () => {
  const identity = deriveLifecycleDeadline(parse("--cells", "E-D"), descriptor);
  const identityTwice = deriveLifecycleDeadline(
    parse("--cells", "E-D", "--runs", "2"),
    descriptor,
  );
  const identityOnce = deriveLifecycleDeadline(
    parse("--cells", "E-D", "--runs", "1"),
    descriptor,
  );
  assert.equal(identity, identityTwice);
  assert.ok(identity > identityOnce);
});
