// @purpose Pins the durable Globe source default for night lights: shipped ON, with JSDoc that says so.
// @status ACTIVE
//
// WHAT MOVED, AND WHY THE PIN MOVED WITH IT. This file used to pin the opposite
// default, and the reason it gave was cross-backend parity: emission existed
// only in WGSL, so shipping it on would have made the two backends disagree by
// default. That reason is gone - the emission law now runs on both backends -
// and the default it justified went with it. The pin is inverted here rather
// than deleted, because the property it guards is exactly as load-bearing in
// its new position: a default that silently flips back is the regression.
//
// SCOPE. This file pins one durable source fact. The law itself - the two
// shaders agreeing, the gate, the sentinel, and the term actually being
// reachable at this default - belongs to globe-night-lights-emission.
//
// Run: node --test Tools/visual-regression/globe-night-lights-default.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const globePath = path.join(
  root,
  "packages",
  "engine",
  "Source",
  "Scene",
  "Globe.js",
);

test("Globe.enableNightLights has one true default assignment", () => {
  const source = fs.readFileSync(globePath, "utf8");

  assert.match(source, /this\.enableNightLights\s*=\s*true;/);
  assert.doesNotMatch(source, /this\.enableNightLights\s*=\s*false;/);
  assert.equal(
    source.match(/this\.enableNightLights\s*=/g)?.length ?? 0,
    1,
    "Globe.enableNightLights must have exactly one assignment",
  );

  const assignmentIndex = source.search(/this\.enableNightLights\s*=\s*true;/);
  const jsdocStart = source.lastIndexOf("/**", assignmentIndex);
  const jsdocEnd = source.indexOf("*/", jsdocStart);
  assert.notEqual(jsdocStart, -1, "the assignment must have JSDoc");
  assert.ok(
    jsdocEnd !== -1 && jsdocEnd < assignmentIndex,
    "the assignment must follow a complete JSDoc block",
  );
  assert.equal(
    source.slice(jsdocEnd + 2, assignmentIndex).trim(),
    "",
    "the assignment must immediately follow its JSDoc block",
  );

  const jsdoc = source.slice(jsdocStart, jsdocEnd + 2);
  assert.match(jsdoc, /^\s*\*\s*@default true\s*$/m);
  assert.doesNotMatch(jsdoc, /^\s*\*\s*@default false\s*$/m);
});
