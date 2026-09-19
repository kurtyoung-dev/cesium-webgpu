// bundleWorkers pragma-strip spec — drives the real `bundleWorkers` through the
// ESM worker branch that produces `Build/<variant>/Workers/`, once with pragma
// removal on and once with it off, and reads the emitted bundle text.
// @purpose Prove a release worker bundle carries no debug-only assertion text while a debug worker bundle keeps it.
// @status ACTIVE
//
// The canary is an assertion *string*, not a `//>>includeStart` marker: esbuild's
// minifier drops the comment markers from both bundles, so a marker grep passes
// whether or not the pragma plugin ran. The string is derived from the source
// file and checked to sit inside a debug pragma block before it is used.
//
// Run with: node --test scripts/__tests__/bundleWorkersPragmas.spec.mjs

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const CANARY_SOURCE = path.join(
  repoRoot,
  "packages",
  "engine",
  "Source",
  "Core",
  "HeightmapTessellator.js",
);
const CANARY = "options.skirtHeight is required.";

const bundleText = async (result) => {
  assert.ok(result.outputFiles, "the build returned no in-memory output files");
  return result.outputFiles.map((file) => file.text).join("\n");
};

test("release worker bundles drop debug assertions that debug bundles keep", async (t) => {
  const source = await readFile(CANARY_SOURCE, "utf8");

  // Self-check: the canary has to live inside a debug pragma block, otherwise
  // its absence would prove nothing about the pragma plugin.
  const blocks = source.match(
    /\/\/>>includeStart\('debug'[\s\S]*?\/\/>>includeEnd\('debug'\);/gu,
  );
  assert.ok(blocks, `no debug pragma block found in ${CANARY_SOURCE}`);
  assert.ok(
    blocks.some((block) => block.includes(CANARY)),
    `"${CANARY}" is no longer inside a debug pragma block; pick a new canary`,
  );

  const outDir = await mkdtemp(path.join(tmpdir(), "bundle-workers-spec-"));
  const cwd = process.cwd();
  process.chdir(repoRoot);
  t.after(async () => {
    process.chdir(cwd);
    await rm(outDir, { force: true, recursive: true });
  });

  const { bundleWorkers } = await import(
    path.posix.join(
      "file:///",
      repoRoot.replace(/\\/gu, "/"),
      "scripts",
      "build.js",
    )
  );

  const bundle = (removePragmas) =>
    bundleWorkers({
      path: outDir,
      iife: false,
      minify: true,
      removePragmas: removePragmas,
      write: false,
    });

  const debugText = await bundleText(await bundle(false));
  const releaseText = await bundleText(await bundle(true));

  assert.ok(
    debugText.includes(CANARY),
    "the debug worker bundle lost its assertions — pragma removal is no longer gated on the option",
  );
  assert.equal(
    releaseText.split(CANARY).length - 1,
    0,
    "the release worker bundle still ships debug assertion text",
  );
  assert.ok(
    releaseText.length < debugText.length,
    `the release bundle (${releaseText.length} bytes) is not smaller than the debug bundle (${debugText.length} bytes)`,
  );
});
