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
const gpu = "packages/engine/Source/Renderer/WebGPU/";
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
async function compiler(source, inspect = false) {
  const result = await build({
    stdin: {
      contents:
        source +
        '\nexport {ShaderDefine,ShaderDefineHi,ShaderDefineExt} from "./WebGPUShaderDefines.js";' +
        (inspect
          ? "\nexport {getParsedTemplate as inspectTemplate,_templateCache as inspectCache};"
          : ""),
      resolveDir: path.join(root, gpu),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}
const current = {},
  legacy = {},
  main = {};
let L, H, E, words;
before(async () => {
  Object.assign(
    current,
    await compiler(read(gpu + "WebGPUShaderPreprocessor.ts"), true),
  );
  Object.assign(
    legacy,
    await compiler(
      read(
        "Tools/visual-regression/fixtures/shader-preprocessor/line-oriented.ts.txt",
      ),
    ),
  );
  Object.assign(
    main,
    await compiler(
      read(
        "Tools/visual-regression/fixtures/shader-preprocessor/main-template-cache.ts.txt",
      ),
    ),
  );
  L = current.ShaderDefine;
  H = current.ShaderDefineHi;
  E = current.ShaderDefineExt;
  words = maskWords();
});
function same(actual, expected, label) {
  if (actual === expected) return;
  let i = 0;
  while (
    i < Math.min(actual.length, expected.length) &&
    actual[i] === expected[i]
  )
    i++;
  assert.fail(
    label +
      " differs at " +
      i +
      ": " +
      JSON.stringify({
        actual: actual.slice(Math.max(0, i - 30), i + 100),
        expected: expected.slice(Math.max(0, i - 30), i + 100),
      }),
  );
}
function message(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error.message;
  }
}
function maskWords() {
  return [
    [0, 0, 0],
    [0x7fffffff, 0, 0],
    [0, 0x7fffffff, 0],
    [0, 0, 31],
    [0x7fffffff, 0x7fffffff, 31],
    [L.GEODETIC_NORMAL, H.UNDERWATER_OPTICS, E.CLOUD_WEATHER_MATERIAL],
    [0, H.CLOUD_WEATHER_VERTICAL | H.CLOUD_WEATHER_POPULATIONS, 16],
    [L.GEODETIC_NORMAL, H.CLOUD_GEOGRAPHIC_WIND | H.CLOUD_SINGLE_LEVEL_WIND, 7],
    [0x55555555, 0x2aaaaaaa, 21],
    [0x2aaaaaaa, 0x55555555, 10],
    [
      0,
      H.CLOUD_SPATIAL_PROXY | H.CLOUD_MATERIAL_REPROJECTION,
      E.CLOUD_SPATIAL_PROXY_PAGES,
    ],
    [0x7fffffff, H.CLOUD_PRIMARY_REUSE | H.CLOUD_WEATHER_TRANSITION, 0],
  ];
}
test("nested branches, blank lines, Unicode and EOF remain byte-identical to the line-oriented implementation", () => {
  const lines = [
    "",
    "// unicode \u{1f30e}",
    "//>>ifdef GEODETIC_NORMAL",
    "lo",
    "//>>ifdef UNDERWATER_OPTICS",
    "water",
    "//>>else",
    "surface",
    "//>>endif",
    "//>>else",
    "base",
    "//>>endif",
    "//>>ifdef CLOUD_SPATIAL_PROFILES",
    "profile",
    "//>>else",
    "column",
    "//>>endif",
    "",
    "fn text() {} //>>endif",
  ];
  let comparisons = 0;
  for (const newline of ["\n", "\r\n"])
    for (const ending of ["", newline, newline + newline])
      for (const prefix of ["", "prefix" + newline, newline]) {
        const source = prefix + lines.join(newline) + ending;
        for (const flags of words) {
          same(
            current.preprocess(source, ...flags),
            legacy.preprocess(source, ...flags),
            "nested",
          );
          comparisons++;
        }
      }
  assert.equal(comparisons, 216);
});
test("the merged processor preserves main lo/hi template behavior and the published underwater slot", () => {
  const source =
    "//>>ifdef GEODETIC_NORMAL\nnormal\n//>>else\nbase\n//>>endif\n" +
    "//>>ifdef UNDERWATER_OPTICS\nwater\n//>>else\nsurface\n//>>endif\n";
  assert.equal(H.UNDERWATER_OPTICS, 64);
  for (const lo of [0, L.GEODETIC_NORMAL])
    for (const hi of [0, H.UNDERWATER_OPTICS, H.CLOUD_WEATHER_VERTICAL]) {
      same(
        current.preprocess(source, lo, hi),
        main.preprocess(source, lo, hi),
        "main",
      );
    }
});
test("all three flag words stay independent through repeated cached selections", () => {
  const source =
    "//>>ifdef GEODETIC_NORMAL\nlo\n//>>else\nnoLo\n//>>endif\n" +
    "//>>ifdef UNDERWATER_OPTICS\nhi\n//>>else\nnoHi\n//>>endif\n" +
    "//>>ifdef CLOUD_SPATIAL_PROFILES\next\n//>>else\nnoExt\n//>>endif";
  for (let pass = 0; pass < 2; pass++)
    for (const lo of [0, L.GEODETIC_NORMAL])
      for (const hi of [0, H.UNDERWATER_OPTICS])
        for (const ext of [0, E.CLOUD_SPATIAL_PROFILES]) {
          assert.equal(
            current.preprocess(source, lo, hi, ext),
            [
              lo ? "lo" : "noLo",
              hi ? "hi" : "noHi",
              ext ? "ext" : "noExt",
            ].join("\n"),
          );
        }
  assert.equal(
    current.preprocess(source, 0),
    current.preprocess(source, 0, 0, 0),
  );
});
test("cached invalid and inactive branches retain exact diagnostics and line numbers", () => {
  const cases = [
    "//>>ifdef",
    "//>>else",
    "//>>endif",
    "// unicode \u{1f30e}\n\n//>>ifdef GEODETIC_NORMAL\nbody",
    "//>>ifdef GEODETIC_NORMAL\n//>>else\n//>>else\n//>>endif",
    "//>>ifdef UNKNOWN_SHADER_FLAG\nbad\n//>>endif",
    "//>>ifdef GEODETIC_NORMAL\n//>>ifdef UNKNOWN_SHADER_FLAG\nbad\n//>>endif\n//>>endif",
    "//>>ifdef CLOUD_SPATIAL_PROFILES\n//>>else\n//>>else\n//>>endif",
  ];
  for (const raw of cases)
    for (const newline of ["\n", "\r\n"]) {
      const source = raw.replace(/\n/g, newline);
      for (const flags of words)
        for (let pass = 0; pass < 2; pass++) {
          const expected = message(() => legacy.preprocess(source, ...flags));
          assert(expected, "invalid fixture must throw");
          assert.equal(
            message(() => current.preprocess(source, ...flags)),
            expected,
          );
        }
    }
});
test("template identity depends on source, bounded eviction never changes selected output", () => {
  current.inspectCache.clear();
  const source =
    "//>>ifdef CLOUD_SPATIAL_PROFILES\nprofile\n//>>else\ncolumn\n//>>endif";
  const first = current.inspectTemplate(source);
  for (const ext of [0, 16, 0, 16]) {
    current.preprocess(source, 0, 0, ext);
    assert.equal(current.inspectTemplate(source), first);
  }
  const changed = source.replace("column", "other");
  assert.notEqual(current.inspectTemplate(changed), first);
  for (let i = 0; i < 20; i++)
    current.preprocess("// source " + i + "\n" + source, 0, 0, i % 2 ? 16 : 0);
  assert.equal(current.inspectCache.size, 16);
  assert(!current.inspectCache.has(source));
  same(
    current.preprocess(source, 0, 0, 16),
    legacy.preprocess(source, 0, 0, 16),
    "evicted",
  );
  assert.notEqual(current.inspectTemplate(source), first);
  assert.equal(current.inspectCache.size, 16);
});
function shaderFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    return item.isDirectory()
      ? shaderFiles(file)
      : file.endsWith(".wgsl")
        ? [file]
        : [];
  });
}
test("real WGSL corpus retains exact emitted bytes and zero-ext water behavior", (t) => {
  const files = shaderFiles(
    path.join(root, "packages/engine/Source/Shaders/WebGPU"),
  );
  let comparisons = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const flags of words) {
      same(
        current.preprocess(source, ...flags),
        legacy.preprocess(source, ...flags),
        path.relative(root, file),
      );
      same(
        current.preprocess(source, flags[0], flags[1], 0),
        main.preprocess(source, flags[0], flags[1]),
        path.relative(root, file) + " water default path",
      );
      comparisons++;
    }
  }
  assert(files.length > 100);
  assert.equal(comparisons, files.length * words.length);
  t.diagnostic(
    JSON.stringify({
      shaderFiles: files.length,
      maskRecipes: words.length,
      comparisons,
    }),
  );
});
