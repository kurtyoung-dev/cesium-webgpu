// shader-reader-hygiene.spec.mjs — specs read engine shaders through the kit, not their own paths.
// @purpose Pins that no spec under Tools/ outside the shrink-only allowlist names an engine shader path for a raw read, that every allowlist row is still a real (flagged) row with a one-line reason, that the kit reader returns the bytes on disk, and that the scanner flags a migrated spec whose kit call is rewritten back to a raw read (inertness mutant).
// @status ACTIVE
//
// DX-RAW-GLOBETERRAIN-READERS. About forty specs read
// `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` with their own path joins, and one
// restructuring of that shader broke five of them at once. They now read it
// through `lib/engine-shader-source.mjs`; this spec keeps new raw readers from
// accreting. The scan is textual (see `lib/shader-reader-scan.mjs` for what it
// can and cannot see).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENGINE_SOURCE_ROOT,
  engineShaderPath,
  readEngineShader,
} from "./lib/engine-shader-source.mjs";
import { SHADER_READER_ALLOWLIST } from "./lib/shader-reader-allowlist.mjs";
import {
  listToolSpecs,
  rawShaderReferences,
} from "./lib/shader-reader-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const GLOBE = "Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Specs that carry a raw shader path and are not allowlisted. */
function offenders(specs, readSpec, allowlist) {
  return specs.filter(
    (spec) =>
      !Object.hasOwn(allowlist, spec) &&
      rawShaderReferences(readSpec(spec)).length > 0,
  );
}

test("no spec outside the allowlist names an engine shader path for a raw read", () => {
  const specs = listToolSpecs(ROOT);
  assert.ok(
    specs.length > 300,
    `expected the Tools spec census, got ${specs.length}`,
  );
  // This spec quotes raw paths as scanner fixtures; it reads no shader raw.
  const self = path.posix.relative(
    ROOT.replaceAll("\\", "/"),
    fileURLToPath(import.meta.url).replaceAll("\\", "/"),
  );
  const found = offenders(
    specs.filter((spec) => spec !== self),
    read,
    SHADER_READER_ALLOWLIST,
  );
  assert.deepEqual(
    found,
    [],
    `read these shaders through readEngineShader/engineShaderPath (lib/engine-shader-source.mjs):\n${found
      .map((spec) => `  ${spec}: ${rawShaderReferences(read(spec)).join(", ")}`)
      .join("\n")}`,
  );
});

test("the allowlist is a ratchet: every row exists, is still flagged and has a one-line reason", () => {
  for (const [spec, reason] of Object.entries(SHADER_READER_ALLOWLIST)) {
    assert.ok(fs.existsSync(path.join(ROOT, spec)), `${spec} no longer exists`);
    assert.ok(
      rawShaderReferences(read(spec)).length > 0,
      `${spec} no longer names a raw shader path: delete its allowlist row`,
    );
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 0 && !reason.includes("\n"), spec);
  }
});

test("the scanner flags raw shader paths and ignores kit calls and comments", () => {
  const flagged = [
    `fs.readFileSync(path.join(ROOT, "packages/engine/Source/${GLOBE}"), "utf8")`,
    'readShader(path.join("WebGPU", "Globe", "GlobeTerrain.wgsl"))',
    "fs.readFileSync(`${SHADERS}Globe/GlobeTerrain.wgsl`)",
    'fs.readFileSync(new URL("../../x/Foo.wgsl", import.meta.url))',
  ];
  for (const text of flagged) {
    assert.ok(rawShaderReferences(text).length > 0, text);
  }
  const clean = [
    `readEngineShader("${GLOBE}")`,
    `readEngineShader("${GLOBE}", { eol: "native" })`,
    `engineShaderPath("${GLOBE}")`,
    `// reads packages/engine/Source/${GLOBE}`,
    'assert.ok(found, "GlobeTerrain.wgsl must define x")',
  ];
  for (const text of clean) {
    assert.deepEqual(rawShaderReferences(text), [], text);
  }
});

test("INERTNESS MUTANT — a migrated spec rewritten to a raw read turns the gate red", () => {
  const spec = "Tools/visual-regression/globe-daynight-ramp-law.spec.mjs";
  const original = read(spec);
  const kitCall = `readEngineShader("${GLOBE}")`;
  assert.ok(
    original.includes(kitCall),
    `${spec} no longer reads through the kit`,
  );
  const mutated = original.replace(
    kitCall,
    `fs.readFileSync(path.join(ROOT, "packages/engine/Source/${GLOBE}"), "utf8")`,
  );
  const readMutant = (rel) => (rel === spec ? mutated : read(rel));
  assert.deepEqual(offenders([spec], read, SHADER_READER_ALLOWLIST), []);
  assert.deepEqual(offenders([spec], readMutant, SHADER_READER_ALLOWLIST), [
    spec,
  ]);
});

test("the kit reader returns the bytes on disk, LF-normalized by default", () => {
  const disk = fs.readFileSync(path.join(ENGINE_SOURCE_ROOT, GLOBE), "utf8");
  assert.equal(readEngineShader(GLOBE, { eol: "native" }), disk);
  assert.equal(readEngineShader(GLOBE), disk.replace(/\r\n/g, "\n"));
  assert.ok(!readEngineShader(GLOBE).includes("\r"));
  assert.equal(engineShaderPath(GLOBE), path.join(ENGINE_SOURCE_ROOT, GLOBE));
  assert.throws(() => engineShaderPath("../../package.json"), /outside/);
  assert.throws(() => readEngineShader(GLOBE, { eol: "crlf" }), /eol/);
});
