// Browser-free contract coverage for the GLSL/WGSL source-to-module boundary.
// Run: node --test scripts/__tests__/shaderSourceToJavaScript.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shaderSourceToJavaScript } from "../build.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const buildPath = path.resolve(directory, "../build.js");

async function evaluateModule(moduleSource) {
  const url = `data:text/javascript;base64,${Buffer.from(moduleSource).toString(
    "base64",
  )}`;
  return import(url);
}

test("shader serialization preserves literal escapes, quotes, and LF bytes", async () => {
  const license = "/**\n * @license serialization fixture\n */\n";
  const source = `${license.replaceAll(
    "\n",
    "\r\n",
  )}// literal unicode escape: \\u2014; literal newline escape: \\n; "quoted"\r\nnext line\r\n`;
  const normalized = source.replace(/\r\n/g, "\n");

  const moduleSource = shaderSourceToJavaScript(source, license);
  const evaluated = await evaluateModule(moduleSource);

  assert.equal(evaluated.default, normalized);
  assert.equal(evaluated.default.includes("\\u2014"), true);
  assert.equal(evaluated.default.includes("\\n"), true);
  assert.equal(evaluated.default.includes('"quoted"'), true);
  assert.equal(evaluated.default.includes("\r"), false);
  assert.equal(evaluated.default.startsWith(license), true);
  assert.equal(moduleSource.startsWith(license), true);
});

test("post-minify non-comment backslashes round-trip through ESM evaluation", async () => {
  // This represents source after either generator's minifier has removed its
  // comments. The serializer must not depend on the current affected escapes
  // living only in comments.
  const minifiedSource = "const marker = C:\\shader\\u2014\\n;\n";
  const evaluated = await evaluateModule(
    shaderSourceToJavaScript(minifiedSource),
  );

  assert.equal(evaluated.default, minifiedSource);
});

test("lone CR and Unicode line separators round-trip through ESM evaluation", async () => {
  const source =
    "literal slash-r: \\r; before lone CR\rafter CR\u2028after LS\u2029after PS";
  const loneCrIndex = source.indexOf("\r");
  const moduleSource = shaderSourceToJavaScript(source);
  const evaluated = await evaluateModule(moduleSource);

  assert.notEqual(loneCrIndex, -1);
  assert.equal(evaluated.default, source);
  assert.equal(evaluated.default.charCodeAt(loneCrIndex), 0x0d);
  assert.equal(evaluated.default.includes("\u2028"), true);
  assert.equal(evaluated.default.includes("\u2029"), true);
  assert.equal(moduleSource.includes("literal slash-r: \\\\r"), true);
  assert.equal(moduleSource.includes("lone CR\\rafter CR"), true);
});

test("GLSL and WGSL generators are both pinned to the shared serializer", async () => {
  const source = await readFile(buildPath, "utf8");
  const glslStart = source.indexOf("export async function glslToJavaScript");
  const wgslStart = source.indexOf("export async function wgslToJavaScript");
  const nextExport = source.indexOf(
    "export async function copyFiles",
    wgslStart,
  );
  const glslGenerator = source.slice(glslStart, wgslStart);
  const wgslGenerator = source.slice(wgslStart, nextExport);
  const sharedCall =
    /shaderSourceToJavaScript\(contents, copyrightComments\)/gu;
  const normalizesCrLf = 'contents = contents.replace(/\\r\\n/gm, "\\n");';

  assert.ok(glslStart >= 0 && wgslStart > glslStart && nextExport > wgslStart);
  assert.equal((glslGenerator.match(sharedCall) ?? []).length, 1);
  assert.equal((wgslGenerator.match(sharedCall) ?? []).length, 1);
  assert.equal(glslGenerator.includes(normalizesCrLf), true);
  assert.equal(wgslGenerator.includes(normalizesCrLf), true);
  assert.doesNotMatch(
    `${glslGenerator}\n${wgslGenerator}`,
    /contents = contents\.split\('"'\)\.join\('\\\\"'\)/u,
  );
});
