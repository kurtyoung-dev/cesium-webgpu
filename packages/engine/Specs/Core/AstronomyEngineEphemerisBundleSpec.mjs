import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const specDirectory = dirname(fileURLToPath(import.meta.url));
const coreDirectory = resolve(specDirectory, "../../Source/Core");
const astronomyProviderPath = resolve(
  coreDirectory,
  "AstronomyEngineEphemerisProvider.js",
);
const simonProviderPath = resolve(
  coreDirectory,
  "Simon1994EphemerisProvider.js",
);
const timeAdapterPath = resolve(coreDirectory, "AstronomyEngineTimeAdapter.js");

function containsAstronomyEngineInput(output) {
  return Object.keys(output.inputs).some((input) =>
    input.replaceAll("\\", "/").includes("/astronomy-engine/"),
  );
}

function collectEagerOutputNames(outputName, outputs, result) {
  if (result.has(outputName)) {
    return;
  }
  result.add(outputName);
  const output = outputs.get(outputName);
  for (const imported of output.imports) {
    if (imported.kind !== "dynamic-import" && outputs.has(imported.path)) {
      collectEagerOutputNames(imported.path, outputs, result);
    }
  }
}

test("the high-precision dependency has exactly one lazy import and no eager or CommonJS edge", async () => {
  const source = await readFile(astronomyProviderPath, "utf8");
  const dynamicImports = source.match(/import\("astronomy-engine"\)/g) ?? [];

  assert.equal(dynamicImports.length, 1);
  assert.doesNotMatch(source, /^\s*import\s+[^;]*["']astronomy-engine["']/mu);
  assert.doesNotMatch(source, /\brequire\s*\(\s*["']astronomy-engine["']/u);
  assert.doesNotMatch(source, /\bSetDeltaTFunction\s*\(/u);
  assert.match(source, /DeltaT_EspenakMeeus/u);
  assert.match(source, /class PinnedAstronomyEngineTime extends AstroTime/u);
  assert.match(source, /AddDays\(days\)/u);
  assert.match(source, /let astronomyEngineModulePromise;/u);
});

test("the time adapter contains no JavaScript Date conversion", async () => {
  const source = await readFile(timeAdapterPath, "utf8");

  assert.doesNotMatch(source, /\bnew\s+Date\s*\(/u);
  assert.doesNotMatch(source, /\bDate\.(?:UTC|parse|now)\s*\(/u);
  assert.match(source, /new JulianDate\(/u);
  assert.match(source, /JulianDate\.computeTaiMinusUtc/u);
});

test("the vector provider contains no event-specific or radius corrections", async () => {
  const source = await readFile(astronomyProviderPath, "utf8");

  assert.doesNotMatch(
    source,
    /Luarca|Reykjavik|Erie|Torreon|Torre[oó]n|2024-04-08|2026-08-12/u,
  );
  assert.doesNotMatch(source, /695[057]00(?:000)?|1737400/u);
  assert.match(source, /eventSpecificCorrections: false/u);
  assert.match(source, /angularRadiusCorrections: false/u);
});

test("a browser bundle resolves astronomy-engine only in a lazy split chunk", async () => {
  const result = await build({
    entryPoints: [astronomyProviderPath],
    bundle: true,
    format: "esm",
    splitting: true,
    platform: "browser",
    target: "es2022",
    outdir: "out",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  const outputEntries = Object.entries(result.metafile.outputs);
  const outputs = new Map(outputEntries);
  const entryOutput = outputEntries.find(([, output]) =>
    output.entryPoint
      ?.replaceAll("\\", "/")
      .endsWith("/AstronomyEngineEphemerisProvider.js"),
  );
  assert.ok(entryOutput, "browser build must contain an entry output");
  assert.equal(containsAstronomyEngineInput(entryOutput[1]), false);

  const eagerOutputNames = new Set();
  collectEagerOutputNames(entryOutput[0], outputs, eagerOutputNames);
  assert.equal(
    [...eagerOutputNames].some((name) =>
      containsAstronomyEngineInput(outputs.get(name)),
    ),
    false,
    "the provider's static import closure must exclude astronomy-engine",
  );

  const lazyOutputs = outputEntries.filter(([, output]) =>
    containsAstronomyEngineInput(output),
  );
  assert.ok(lazyOutputs.length > 0, "astronomy-engine must resolve in a chunk");
  const dynamicImportTargets = new Set(
    entryOutput[1].imports
      .filter((imported) => imported.kind === "dynamic-import")
      .map((imported) => imported.path),
  );
  assert.ok(
    lazyOutputs.every(([name]) => dynamicImportTargets.has(name)),
    "every astronomy-engine output must be reached through the dynamic edge",
  );
  assert.ok(result.outputFiles.length > 1, "dynamic import must split a chunk");
});

test("the lightweight Simon provider browser graph excludes astronomy-engine", async () => {
  const result = await build({
    entryPoints: [simonProviderPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  assert.equal(
    Object.values(result.metafile.outputs).some(containsAstronomyEngineInput),
    false,
  );
  assert.equal(
    Object.keys(result.metafile.inputs).some((input) =>
      input.replaceAll("\\", "/").includes("/astronomy-engine/"),
    ),
    false,
  );
});
