// Browser-free regression coverage for private named-export engine modules.
// @purpose Regression that the generated engine index omits private named-export temporal-history helpers yet still esbuild-bundles cleanly.
// @status ACTIVE
//
// Run: node --test scripts/__tests__/createIndexJs.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { createIndexJs } from "../build.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const engineDirectory = path.resolve(directory, "../../packages/engine");

test("engine index omits private named-export temporal history helpers", async () => {
  const contents = await createIndexJs("engine", { write: false });

  assert.doesNotMatch(contents, /ViewTemporalHistory/u);
  assert.match(
    contents,
    /export \{ default as ViewportQuad \} from '\.\/Source\/Scene\/ViewportQuad\.js';/u,
  );

  await esbuild.build({
    stdin: {
      contents,
      resolveDir: engineDirectory,
      sourcefile: "index.js",
    },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    write: false,
  });
});
