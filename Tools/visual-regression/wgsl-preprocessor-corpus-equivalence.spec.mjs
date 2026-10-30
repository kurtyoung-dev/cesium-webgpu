// wgsl-preprocessor-corpus-equivalence.spec.mjs — Full-corpus differential equivalence spec for WebGPUShaderPreprocessor.ts.
// @purpose Differential equivalence gate comparing the template-cached WebGPUShaderPreprocessor against the reference line-oriented preprocessor across every .wgsl shader in packages/engine/Source/Shaders/WebGPU/ under all-off, all-on, single-flag, and pairwise flag combinations, plus off-by-one slice mutant Q9.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const gpuDir = path.join(root, "packages/engine/Source/Renderer/WebGPU");
const wgslRoot = path.join(root, "packages/engine/Source/Shaders/WebGPU");
const referencePath = path.join(
  root,
  "Tools/visual-regression/fixtures/shader-preprocessor/line-oriented.ts.txt",
);

async function bundlePreprocessor(overridePreprocessorSource = null) {
  const plugins =
    overridePreprocessorSource !== null
      ? [
          {
            name: "override-preprocessor",
            setup(builder) {
              builder.onLoad(
                { filter: /WebGPUShaderPreprocessor\.ts$/ },
                () => ({
                  contents: overridePreprocessorSource,
                  loader: "ts",
                }),
              );
            },
          },
        ]
      : [];

  const result = await build({
    stdin: {
      contents: [
        'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts";',
        'export * from "./packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts";',
      ].join("\n"),
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins,
  });

  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}

function collectWgslFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectWgslFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".wgsl")) {
      out.push(full);
    }
  }
  out.sort();
  return out;
}

const IFDEF_RE = /^\s*\/\/>>\s*ifdef\s+([A-Z_][A-Z0-9_]*)\s*$/gm;

function extractFlags(source) {
  const flags = [];
  const seen = new Set();
  for (const m of source.matchAll(IFDEF_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      flags.push(m[1]);
    }
  }
  return flags;
}

function maskForFlags(api, names) {
  let lo = 0;
  let hi = 0;
  let ext = 0;
  for (const name of names) {
    if (Object.hasOwn(api.ShaderDefineExt, name)) {
      ext = (ext | api.ShaderDefineExt[name]) >>> 0;
    } else if (Object.hasOwn(api.ShaderDefineHi, name)) {
      hi = (hi | api.ShaderDefineHi[name]) >>> 0;
    } else if (Object.hasOwn(api.ShaderDefine, name)) {
      lo = (lo | api.ShaderDefine[name]) >>> 0;
    } else {
      throw new Error(`Unregistered WGSL flag in corpus: ${name}`);
    }
  }
  return [lo, hi, ext];
}

let currentApi;
let referenceApi;
let wgslCorpus;

before(async () => {
  const refSource = fs.readFileSync(referencePath, "utf8");
  [currentApi, referenceApi] = await Promise.all([
    bundlePreprocessor(null),
    bundlePreprocessor(refSource),
  ]);
  wgslCorpus = collectWgslFiles(wgslRoot).map((absPath) => {
    const relPath = path.relative(wgslRoot, absPath).replaceAll("\\", "/");
    const raw = fs.readFileSync(absPath, "utf8");
    const lf = raw.replaceAll("\r\n", "\n");
    return {
      relPath,
      lf,
      crlf: lf.replaceAll("\n", "\r\n"),
      flags: extractFlags(lf),
    };
  });
});

test("current template-cached preprocessor matches reference line-oriented preprocessor across the entire shipped WGSL corpus (LF and CRLF)", (t) => {
  assert.ok(
    wgslCorpus.length >= 60,
    `expected >= 60 shipped .wgsl files, got ${wgslCorpus.length}`,
  );
  let totalEvaluations = 0;
  let conditionalFiles = 0;

  for (const item of wgslCorpus) {
    const combos = [[0, 0, 0]];
    if (item.flags.length > 0) {
      conditionalFiles++;
      combos.push(maskForFlags(currentApi, item.flags));
      for (let i = 0; i < item.flags.length; i++) {
        combos.push(maskForFlags(currentApi, [item.flags[i]]));
        for (let j = i + 1; j < item.flags.length; j++) {
          combos.push(maskForFlags(currentApi, [item.flags[i], item.flags[j]]));
        }
      }
    }

    for (const [lo, hi, ext] of combos) {
      const actualLf = currentApi.preprocess(item.lf, lo, hi, ext);
      const expectedLf = referenceApi.preprocess(item.lf, lo, hi, ext);
      assert.equal(
        actualLf,
        expectedLf,
        `LF mismatch in ${item.relPath} for masks (${lo}, ${hi}, ${ext})`,
      );

      const actualCrlf = currentApi.preprocess(item.crlf, lo, hi, ext);
      const expectedCrlf = referenceApi.preprocess(item.crlf, lo, hi, ext);
      assert.equal(
        actualCrlf,
        expectedCrlf,
        `CRLF mismatch in ${item.relPath} for masks (${lo}, ${hi}, ${ext})`,
      );
      totalEvaluations += 2;
    }
  }

  assert.ok(
    conditionalFiles >= 10,
    `expected >= 10 conditional .wgsl files, got ${conditionalFiles}`,
  );
  t.diagnostic(
    JSON.stringify({
      wgslFiles: wgslCorpus.length,
      conditionalFiles,
      totalEvaluations,
    }),
  );
});

test("mutant Q9 (off-by-one slice boundary lineStart - 1 -> lineStart) diverges from reference on GlobeTerrain.wgsl", async () => {
  const prepPath = path.join(gpuDir, "WebGPUShaderPreprocessor.ts");
  const prepSource = fs.readFileSync(prepPath, "utf8").replaceAll("\r\n", "\n");
  const target = "slice: source.slice(blockStart, lineStart - 1),";
  assert.equal(
    prepSource.split(target).length - 1,
    1,
    "expected unique Q9 slice anchor in WebGPUShaderPreprocessor.ts",
  );

  const mutatedApi = await bundlePreprocessor(
    prepSource.replace(target, "slice: source.slice(blockStart, lineStart),"),
  );
  const globeTerrain = wgslCorpus.find(
    (item) => item.relPath === "Globe/GlobeTerrain.wgsl",
  );
  assert.ok(globeTerrain, "expected Globe/GlobeTerrain.wgsl in corpus");

  const actualMutated = mutatedApi.preprocess(globeTerrain.lf, 0, 0, 0);
  const expectedRef = referenceApi.preprocess(globeTerrain.lf, 0, 0, 0);
  assert.notEqual(
    actualMutated,
    expectedRef,
    "mutant Q9 must diverge from reference preprocessor on GlobeTerrain.wgsl",
  );
});
