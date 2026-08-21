// @purpose Verifies that durable Globe source defaults night lights to an opt-in feature.
// @status ACTIVE

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

test("Globe.enableNightLights has one false default assignment", () => {
  const source = fs.readFileSync(globePath, "utf8");

  assert.match(source, /this\.enableNightLights\s*=\s*false;/);
  assert.doesNotMatch(source, /this\.enableNightLights\s*=\s*true;/);
  assert.equal(
    source.match(/this\.enableNightLights\s*=/g)?.length ?? 0,
    1,
    "Globe.enableNightLights must have exactly one assignment",
  );

  const assignmentIndex = source.search(/this\.enableNightLights\s*=\s*false;/);
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
  assert.match(jsdoc, /^\s*\*\s*@default false\s*$/m);
  assert.doesNotMatch(jsdoc, /^\s*\*\s*@default true\s*$/m);
});
