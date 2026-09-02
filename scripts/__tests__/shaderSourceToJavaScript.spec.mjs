// Browser-free contract coverage for the GLSL/WGSL source-to-module boundary.
// @purpose Contract for the shader source-to-JS-module serializer: literal escapes, quotes, CRLF/lone-CR/U+2028 round-trips through real ESM evaluation.
// @status ACTIVE
//
// Run: node --test scripts/__tests__/shaderSourceToJavaScript.spec.mjs

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shaderSourceToJavaScript, wgslModuleContents } from "../build.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const buildPath = path.resolve(directory, "../build.js");
const scriptsRoot = path.resolve(directory, "..");
const thisSpecPath = fileURLToPath(import.meta.url);
const TOOLING_ROOT_RELATIVE_PATHS = Object.freeze(["scripts", "Tools"]);
const TOOLING_SOURCE_EXTENSIONS = Object.freeze([".cjs", ".js", ".mjs", ".ts"]);
const TOOLING_EXCLUDED_DIRECTORY_PATHS = Object.freeze([
  "Tools/visual-regression/output",
  "Tools/readme-screenshots/output",
  "Tools/process-supervisor/target",
  "Tools/moon-albedo-bake/work",
  "Tools/moon-albedo-bake/out",
  "Tools/skybox-bake/work",
  "Tools/skybox-bake/out",
  "Tools/star-catalog-bake/work",
  "Tools/stbn-bake/out",
]);
const toolingRoots = Object.freeze(
  TOOLING_ROOT_RELATIVE_PATHS.map((relativePath) =>
    path.join(repositoryRoot, relativePath),
  ),
);
const NODE_TOOLING_FILE_SYSTEM = Object.freeze({
  readDirectory(directoryPath) {
    return readdir(directoryPath, { withFileTypes: true });
  },
  readTextFile(filePath) {
    return readFile(filePath, "utf8");
  },
});

const WEBGPU_SHADER_ROOT = path.join(
  repositoryRoot,
  "packages",
  "engine",
  "Source",
  "Shaders",
  "WebGPU",
);

const PROTECTED_STANDALONE_WGSL_PATHS = Object.freeze([
  "chunks/functions/csm_atmosphereCommon.wgsl",
  "Model/ModelAtmosphereStage.wgsl",
  "Model/ModelCPUStylingStage.wgsl",
  "Model/ModelPointCloudStylingStage.wgsl",
  "ViewportQuad.wgsl",
  "Classification/ShadowVolume.wgsl",
  "Classification/ShadowVolumeAppearance.wgsl",
  "CloudNoise.wgsl",
  "Classification/Vector3DTileClampedPolylines.wgsl",
  "Classification/Vector3DTilePolylines.wgsl",
  "Classification/VectorTile.wgsl",
  "Classification/PolylineShadowVolume.wgsl",
  "Voxels/VoxelIntersection.wgsl",
  "Voxels/VoxelRayMarch.wgsl",
]);

const FILE_WRITE_CALL =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync)\s*\(|\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync)\s*\(/u;

function repositoryRelativePath(repositoryRootPath, absolutePath) {
  return path.relative(repositoryRootPath, absolutePath).replaceAll("\\", "/");
}

function pathIsAtOrBelow(relativePath, directoryPath) {
  return (
    relativePath === directoryPath ||
    relativePath.startsWith(`${directoryPath}/`)
  );
}

async function collectToolingSources({
  roots,
  repositoryRootPath,
  fileSystem,
  sourceExtensions,
  excludedDirectoryPaths,
  ignoredFilePath,
}) {
  const sources = new Map();

  async function visit(current) {
    const relativeCurrent = repositoryRelativePath(repositoryRootPath, current);
    if (
      excludedDirectoryPaths.some((excludedPath) =>
        pathIsAtOrBelow(relativeCurrent, excludedPath),
      )
    ) {
      return;
    }

    const entries = await fileSystem.readDirectory(current);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (
        absolutePath === ignoredFilePath ||
        !sourceExtensions.includes(path.extname(entry.name))
      ) {
        continue;
      }
      const relativePath = repositoryRelativePath(
        repositoryRootPath,
        absolutePath,
      );
      sources.set(relativePath, await fileSystem.readTextFile(absolutePath));
    }
  }

  for (const root of roots) {
    await visit(root);
  }
  return sources;
}

function collectRepositoryToolingSources() {
  return collectToolingSources({
    roots: toolingRoots,
    repositoryRootPath: repositoryRoot,
    fileSystem: NODE_TOOLING_FILE_SYSTEM,
    sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
    excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
    ignoredFilePath: thisSpecPath,
  });
}

function createMemoryToolingFileSystem(files) {
  const normalizedFiles = new Map(
    [...files].map(([relativePath, source]) => [
      relativePath.replaceAll("\\", "/"),
      source,
    ]),
  );
  const directoryEntries = new Map();

  function addEntry(directoryPath, name, isDirectory) {
    let entries = directoryEntries.get(directoryPath);
    if (!entries) {
      entries = new Map();
      directoryEntries.set(directoryPath, entries);
    }
    entries.set(name, isDirectory);
  }

  for (const relativePath of normalizedFiles.keys()) {
    const parts = relativePath.split("/");
    for (let index = 0; index < parts.length; index++) {
      addEntry(
        parts.slice(0, index).join("/"),
        parts[index],
        index < parts.length - 1,
      );
    }
  }

  const directoryReads = [];
  const fileReads = [];
  return {
    directoryReads,
    fileReads,
    async readDirectory(absolutePath) {
      const relativePath = repositoryRelativePath(repositoryRoot, absolutePath);
      directoryReads.push(relativePath);
      const entries = directoryEntries.get(relativePath);
      if (!entries) {
        const error = new Error(`missing fixture directory: ${relativePath}`);
        error.code = "ENOENT";
        throw error;
      }
      return [...entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, isDirectory]) => ({
          name,
          isDirectory: () => isDirectory,
        }));
    },
    async readTextFile(absolutePath) {
      const relativePath = repositoryRelativePath(repositoryRoot, absolutePath);
      fileReads.push(relativePath);
      if (!normalizedFiles.has(relativePath)) {
        const error = new Error(`missing fixture file: ${relativePath}`);
        error.code = "ENOENT";
        throw error;
      }
      return normalizedFiles.get(relativePath);
    },
  };
}

function protectedPathSpellings(relativePath) {
  return [relativePath, relativePath.replaceAll("/", "\\\\")];
}

function findProtectedWgslWriters(sources) {
  const findings = [];
  for (const [sourcePath, source] of sources) {
    if (!FILE_WRITE_CALL.test(source)) {
      continue;
    }
    const protectedPaths = PROTECTED_STANDALONE_WGSL_PATHS.filter(
      (relativePath) =>
        protectedPathSpellings(relativePath).some((spelling) =>
          source.includes(spelling),
        ),
    );
    if (protectedPaths.length > 0) {
      findings.push({ sourcePath, protectedPaths });
    }
  }
  return findings.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
}

function extractLicenseComments(source) {
  const comments = source.match(
    /\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm,
  );
  return comments ? `${comments.join("\n")}\n` : "";
}

function expectedWgslWrapper(source, minify) {
  const normalized = source.replace(/\r\n/gm, "\n");
  return shaderSourceToJavaScript(
    wgslModuleContents(normalized, minify),
    extractLicenseComments(normalized),
  );
}

function inspectProtectedWrapperFleet(canonicalSources, wrappers) {
  const missingSources = PROTECTED_STANDALONE_WGSL_PATHS.filter(
    (relativePath) => !canonicalSources.has(relativePath),
  );
  if (
    canonicalSources.size !== PROTECTED_STANDALONE_WGSL_PATHS.length ||
    missingSources.length > 0
  ) {
    return {
      valid: false,
      mode: "source-census-invalid",
      missingSources,
      sourceCount: canonicalSources.size,
    };
  }

  const presentPaths = PROTECTED_STANDALONE_WGSL_PATHS.filter((relativePath) =>
    wrappers.has(relativePath),
  );
  if (presentPaths.length === 0) {
    return { valid: true, mode: "absent", presentCount: 0 };
  }
  if (presentPaths.length !== PROTECTED_STANDALONE_WGSL_PATHS.length) {
    return {
      valid: false,
      mode: "partial",
      presentCount: presentPaths.length,
      missingWrappers: PROTECTED_STANDALONE_WGSL_PATHS.filter(
        (relativePath) => !wrappers.has(relativePath),
      ),
    };
  }

  const unminifiedExpected = new Map();
  const minifiedExpected = new Map();
  for (const relativePath of PROTECTED_STANDALONE_WGSL_PATHS) {
    const source = canonicalSources.get(relativePath);
    unminifiedExpected.set(relativePath, expectedWgslWrapper(source, false));
    minifiedExpected.set(relativePath, expectedWgslWrapper(source, true));
  }

  const allUnminified = PROTECTED_STANDALONE_WGSL_PATHS.every(
    (relativePath) =>
      wrappers.get(relativePath) === unminifiedExpected.get(relativePath),
  );
  const allMinified = PROTECTED_STANDALONE_WGSL_PATHS.every(
    (relativePath) =>
      wrappers.get(relativePath) === minifiedExpected.get(relativePath),
  );
  if (allUnminified || allMinified) {
    return {
      valid: true,
      mode: allUnminified ? "unminified" : "minified",
      presentCount: presentPaths.length,
    };
  }

  const nonCanonicalWrappers = PROTECTED_STANDALONE_WGSL_PATHS.filter(
    (relativePath) =>
      wrappers.get(relativePath) !== unminifiedExpected.get(relativePath) &&
      wrappers.get(relativePath) !== minifiedExpected.get(relativePath),
  );
  return {
    valid: false,
    mode: nonCanonicalWrappers.length > 0 ? "non-canonical" : "mixed",
    presentCount: presentPaths.length,
    nonCanonicalWrappers,
  };
}

async function readProtectedWrapperFleet() {
  const canonicalSources = new Map();
  const wrappers = new Map();
  for (const relativePath of PROTECTED_STANDALONE_WGSL_PATHS) {
    const sourcePath = path.join(WEBGPU_SHADER_ROOT, relativePath);
    canonicalSources.set(relativePath, await readFile(sourcePath, "utf8"));
    const wrapperPath = sourcePath.replace(/\.wgsl$/u, ".js");
    try {
      wrappers.set(relativePath, await readFile(wrapperPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return { canonicalSources, wrappers };
}

function makeCanonicalFixtureSources() {
  return new Map(
    PROTECTED_STANDALONE_WGSL_PATHS.map((relativePath, index) => [
      relativePath,
      `// canonical fixture ${index}\nfn fixture_${index}() -> i32 { return ${index}; }\n`,
    ]),
  );
}

function makeCanonicalFixtureWrappers(canonicalSources, minify) {
  return new Map(
    PROTECTED_STANDALONE_WGSL_PATHS.map((relativePath) => [
      relativePath,
      expectedWgslWrapper(canonicalSources.get(relativePath), minify),
    ]),
  );
}

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

test("the standalone WGSL authority boundary is exactly 14 unique source paths", () => {
  assert.equal(PROTECTED_STANDALONE_WGSL_PATHS.length, 14);
  assert.equal(new Set(PROTECTED_STANDALONE_WGSL_PATHS).size, 14);
});

test("tooling census pins both roots and every executable source extension", async () => {
  const expectedPaths = [
    "scripts/census/script-cjs.cjs",
    "scripts/census/script-js.js",
    "scripts/census/script-mjs.mjs",
    "scripts/census/script-ts.ts",
    "Tools/census/tool-cjs.cjs",
    "Tools/census/tool-js.js",
    "Tools/census/tool-mjs.mjs",
    "Tools/census/tool-ts.ts",
  ];
  const ignoredSpecPath = "scripts/__tests__/shaderSourceToJavaScript.spec.mjs";
  const protectedWriter =
    'writeFileSync("Classification/VectorTile.wgsl", "replacement");';
  const fixtureFiles = new Map(
    expectedPaths.map((relativePath) => [
      relativePath,
      `export default ${JSON.stringify(relativePath)};\n`,
    ]),
  );
  fixtureFiles.set(ignoredSpecPath, protectedWriter);

  assert.deepEqual([...TOOLING_ROOT_RELATIVE_PATHS], ["scripts", "Tools"]);
  assert.deepEqual(
    [...TOOLING_SOURCE_EXTENSIONS],
    [".cjs", ".js", ".mjs", ".ts"],
  );

  const baselineFileSystem = createMemoryToolingFileSystem(fixtureFiles);
  const baselineSources = await collectToolingSources({
    roots: toolingRoots,
    repositoryRootPath: repositoryRoot,
    fileSystem: baselineFileSystem,
    sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
    excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
    ignoredFilePath: thisSpecPath,
  });
  assert.deepEqual(
    [...baselineSources.keys()].sort(),
    [...expectedPaths].sort(),
  );
  assert.equal(baselineFileSystem.fileReads.includes(ignoredSpecPath), false);
  assert.deepEqual(findProtectedWgslWriters(baselineSources), []);

  for (const omittedRoot of ["scripts", "Tools"]) {
    const mutantFileSystem = createMemoryToolingFileSystem(fixtureFiles);
    const mutantSources = await collectToolingSources({
      roots: toolingRoots.filter(
        (root) => repositoryRelativePath(repositoryRoot, root) !== omittedRoot,
      ),
      repositoryRootPath: repositoryRoot,
      fileSystem: mutantFileSystem,
      sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
      excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
      ignoredFilePath: thisSpecPath,
    });
    assert.deepEqual(
      [...mutantSources.keys()].sort(),
      expectedPaths
        .filter((relativePath) => !relativePath.startsWith(`${omittedRoot}/`))
        .sort(),
      `omitted root ${omittedRoot}`,
    );
  }

  for (const omittedExtension of [".cjs", ".js", ".mjs", ".ts"]) {
    const mutantFileSystem = createMemoryToolingFileSystem(fixtureFiles);
    const mutantSources = await collectToolingSources({
      roots: toolingRoots,
      repositoryRootPath: repositoryRoot,
      fileSystem: mutantFileSystem,
      sourceExtensions: TOOLING_SOURCE_EXTENSIONS.filter(
        (extension) => extension !== omittedExtension,
      ),
      excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
      ignoredFilePath: thisSpecPath,
    });
    assert.deepEqual(
      [...mutantSources.keys()].sort(),
      expectedPaths
        .filter(
          (relativePath) => path.extname(relativePath) !== omittedExtension,
        )
        .sort(),
      `omitted extension ${omittedExtension}`,
    );
  }

  const ignoredFileMutant = createMemoryToolingFileSystem(fixtureFiles);
  const ignoredFileMutantSources = await collectToolingSources({
    roots: toolingRoots,
    repositoryRootPath: repositoryRoot,
    fileSystem: ignoredFileMutant,
    sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
    excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
    ignoredFilePath: undefined,
  });
  assert.deepEqual(findProtectedWgslWriters(ignoredFileMutantSources), [
    {
      sourcePath: ignoredSpecPath,
      protectedPaths: ["Classification/VectorTile.wgsl"],
    },
  ]);
});

test("tooling census excludes artifact roots before traversal or read", async () => {
  const excludedWriterPaths = [
    "Tools/visual-regression/output/nested/protectedWriter.mjs",
    "Tools/readme-screenshots/output/nested/protectedWriter.mjs",
    "Tools/process-supervisor/target/nested/protectedWriter.mjs",
    "Tools/moon-albedo-bake/work/nested/protectedWriter.mjs",
    "Tools/moon-albedo-bake/out/nested/protectedWriter.mjs",
    "Tools/skybox-bake/work/nested/protectedWriter.mjs",
    "Tools/skybox-bake/out/nested/protectedWriter.mjs",
    "Tools/star-catalog-bake/work/nested/protectedWriter.mjs",
    "Tools/stbn-bake/out/nested/protectedWriter.mjs",
  ];
  const protectedPath = "Classification/VectorTile.wgsl";
  const protectedWriter = `writeFileSync(${JSON.stringify(protectedPath)}, "replacement");`;
  const fixtureFiles = new Map([
    ["scripts/safe.cjs", "export default true;\n"],
    ...excludedWriterPaths.map((relativePath) => [
      relativePath,
      protectedWriter,
    ]),
  ]);

  assert.deepEqual(
    [...TOOLING_EXCLUDED_DIRECTORY_PATHS],
    [
      "Tools/visual-regression/output",
      "Tools/readme-screenshots/output",
      "Tools/process-supervisor/target",
      "Tools/moon-albedo-bake/work",
      "Tools/moon-albedo-bake/out",
      "Tools/skybox-bake/work",
      "Tools/skybox-bake/out",
      "Tools/star-catalog-bake/work",
      "Tools/stbn-bake/out",
    ],
  );

  const baselineFileSystem = createMemoryToolingFileSystem(fixtureFiles);
  const baselineSources = await collectToolingSources({
    roots: toolingRoots,
    repositoryRootPath: repositoryRoot,
    fileSystem: baselineFileSystem,
    sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
    excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS,
    ignoredFilePath: thisSpecPath,
  });
  assert.deepEqual([...baselineSources.keys()], ["scripts/safe.cjs"]);
  assert.deepEqual(findProtectedWgslWriters(baselineSources), []);

  for (const excludedPath of TOOLING_EXCLUDED_DIRECTORY_PATHS) {
    assert.equal(
      baselineFileSystem.directoryReads.some((readPath) =>
        pathIsAtOrBelow(readPath, excludedPath),
      ),
      false,
      `directory read below ${excludedPath}`,
    );
    assert.equal(
      baselineFileSystem.fileReads.some((readPath) =>
        pathIsAtOrBelow(readPath, excludedPath),
      ),
      false,
      `file read below ${excludedPath}`,
    );
  }

  for (const omittedExclusion of [
    "Tools/visual-regression/output",
    "Tools/readme-screenshots/output",
    "Tools/process-supervisor/target",
    "Tools/moon-albedo-bake/work",
    "Tools/moon-albedo-bake/out",
    "Tools/skybox-bake/work",
    "Tools/skybox-bake/out",
    "Tools/star-catalog-bake/work",
    "Tools/stbn-bake/out",
  ]) {
    const mutantFileSystem = createMemoryToolingFileSystem(fixtureFiles);
    const mutantSources = await collectToolingSources({
      roots: toolingRoots,
      repositoryRootPath: repositoryRoot,
      fileSystem: mutantFileSystem,
      sourceExtensions: TOOLING_SOURCE_EXTENSIONS,
      excludedDirectoryPaths: TOOLING_EXCLUDED_DIRECTORY_PATHS.filter(
        (excludedPath) => excludedPath !== omittedExclusion,
      ),
      ignoredFilePath: thisSpecPath,
    });
    const writerPath = `${omittedExclusion}/nested/protectedWriter.mjs`;
    assert.equal(
      mutantFileSystem.directoryReads.includes(omittedExclusion),
      true,
      `omitted exclusion ${omittedExclusion}`,
    );
    assert.equal(
      mutantFileSystem.fileReads.includes(writerPath),
      true,
      `omitted exclusion ${omittedExclusion}`,
    );
    assert.deepEqual(findProtectedWgslWriters(mutantSources), [
      {
        sourcePath: writerPath,
        protectedPaths: [protectedPath],
      },
    ]);
  }
});

test("no script retains write authority over a protected standalone WGSL source", async () => {
  const scriptSources = await collectRepositoryToolingSources();
  const findings = findProtectedWgslWriters(scriptSources);

  assert.deepEqual(
    findings,
    [],
    `protected standalone WGSL writers remain:\n${JSON.stringify(findings, null, 2)}`,
  );
});

test("writer census detects a renamed fleet copy and a one-path writer", () => {
  const renamedCopy = [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const BASE = join("packages", "engine", "Source", "Shaders", "WebGPU");',
    "const files = {};",
    ...PROTECTED_STANDALONE_WGSL_PATHS.map(
      (relativePath) => `files[${JSON.stringify(relativePath)}] = "current";`,
    ),
    'for (const [relativePath, source] of Object.entries(files)) { writeFileSync(join(BASE, relativePath), source, "utf8"); }',
  ].join("\n");
  const renamedFindings = findProtectedWgslWriters(
    new Map([["scripts/renamedStandaloneCopy.js", renamedCopy]]),
  );

  assert.deepEqual(renamedFindings, [
    {
      sourcePath: "scripts/renamedStandaloneCopy.js",
      protectedPaths: [...PROTECTED_STANDALONE_WGSL_PATHS],
    },
  ]);

  assert.deepEqual(
    findProtectedWgslWriters(
      new Map([["Tools/movedStandaloneCopy.ts", renamedCopy]]),
    ),
    [
      {
        sourcePath: "Tools/movedStandaloneCopy.ts",
        protectedPaths: [...PROTECTED_STANDALONE_WGSL_PATHS],
      },
    ],
  );

  const singlePath = "Classification/VectorTile.wgsl";
  const singleWriter =
    'import { writeFileSync } from "node:fs";\n' +
    `writeFileSync(${JSON.stringify(singlePath)}, "replacement", "utf8");\n`;
  assert.deepEqual(
    findProtectedWgslWriters(
      new Map([["scripts/oneProtectedWriter.mjs", singleWriter]]),
    ),
    [
      {
        sourcePath: "scripts/oneProtectedWriter.mjs",
        protectedPaths: [singlePath],
      },
    ],
  );
});

test("writer census preserves the build, Slang output, and read-only Q130 boundaries", async () => {
  const compileSlangSource = await readFile(
    path.join(scriptsRoot, "compileSlang.js"),
    "utf8",
  );
  const buildSource = await readFile(buildPath, "utf8");
  const readOnlyProtectedReference =
    'readFileSync("Classification/VectorTile.wgsl", "utf8");';
  const unrelatedSemanticWriter =
    'writeFileSync("packages/engine/Source/Shaders/WebGPU/Generated/SlangOutput.wgsl", "textureSample(volumeTexture, volumeSampler, uvw)", "utf8");';

  assert.deepEqual(
    findProtectedWgslWriters(
      new Map([
        ["scripts/build.js", buildSource],
        ["scripts/compileSlang.js", compileSlangSource],
        ["scripts/readOnlyReference.mjs", readOnlyProtectedReference],
        ["scripts/generatedSemanticWriter.mjs", unrelatedSemanticWriter],
      ]),
    ),
    [],
  );
});

test("protected wrapper coherence accepts the repository's canonical fleet state", async () => {
  const fleet = await readProtectedWrapperFleet();
  const result = inspectProtectedWrapperFleet(
    fleet.canonicalSources,
    fleet.wrappers,
  );

  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.ok(["absent", "unminified", "minified"].includes(result.mode));
});

test("wrapper coherence is fresh-clone-safe and accepts zero wrappers", () => {
  const canonicalSources = makeCanonicalFixtureSources();

  assert.deepEqual(inspectProtectedWrapperFleet(canonicalSources, new Map()), {
    valid: true,
    mode: "absent",
    presentCount: 0,
  });
});

test("wrapper coherence accepts complete canonical unminified and minified fleets", () => {
  const canonicalSources = makeCanonicalFixtureSources();
  const unminified = inspectProtectedWrapperFleet(
    canonicalSources,
    makeCanonicalFixtureWrappers(canonicalSources, false),
  );
  const minified = inspectProtectedWrapperFleet(
    canonicalSources,
    makeCanonicalFixtureWrappers(canonicalSources, true),
  );

  assert.equal(unminified.valid, true);
  assert.equal(unminified.mode, "unminified");
  assert.equal(minified.valid, true);
  assert.equal(minified.mode, "minified");
});

test("wrapper coherence rejects every partial, stale, invalid, and mixed fleet", () => {
  const canonicalSources = makeCanonicalFixtureSources();
  const unminified = makeCanonicalFixtureWrappers(canonicalSources, false);
  const minified = makeCanonicalFixtureWrappers(canonicalSources, true);
  const firstPath = PROTECTED_STANDALONE_WGSL_PATHS[0];

  for (
    let presentCount = 1;
    presentCount < PROTECTED_STANDALONE_WGSL_PATHS.length;
    presentCount++
  ) {
    const partial = new Map(
      PROTECTED_STANDALONE_WGSL_PATHS.slice(0, presentCount).map(
        (relativePath) => [relativePath, unminified.get(relativePath)],
      ),
    );
    const partialResult = inspectProtectedWrapperFleet(
      canonicalSources,
      partial,
    );
    assert.equal(partialResult.valid, false, `presentCount=${presentCount}`);
    assert.equal(partialResult.mode, "partial", `presentCount=${presentCount}`);
    assert.equal(
      partialResult.presentCount,
      presentCount,
      `presentCount=${presentCount}`,
    );
  }

  const stale = new Map(unminified);
  stale.set(
    firstPath,
    expectedWgslWrapper(
      `${canonicalSources.get(firstPath)}// stale previous revision\n`,
      false,
    ),
  );
  const staleResult = inspectProtectedWrapperFleet(canonicalSources, stale);
  assert.equal(staleResult.valid, false);
  assert.equal(staleResult.mode, "non-canonical");
  assert.deepEqual(staleResult.nonCanonicalWrappers, [firstPath]);

  const invalid = new Map(unminified);
  invalid.set(firstPath, 'export default "invalid";\n');
  const invalidResult = inspectProtectedWrapperFleet(canonicalSources, invalid);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.mode, "non-canonical");
  assert.deepEqual(invalidResult.nonCanonicalWrappers, [firstPath]);

  const mixed = new Map(
    PROTECTED_STANDALONE_WGSL_PATHS.map((relativePath, index) => [
      relativePath,
      (index % 2 === 0 ? unminified : minified).get(relativePath),
    ]),
  );
  const mixedResult = inspectProtectedWrapperFleet(canonicalSources, mixed);
  assert.equal(mixedResult.valid, false);
  assert.equal(mixedResult.mode, "mixed");
  assert.deepEqual(mixedResult.nonCanonicalWrappers, []);
});

test("wrapper coherence follows canonical WGSL source changes", () => {
  const originalSources = makeCanonicalFixtureSources();
  const originalWrappers = makeCanonicalFixtureWrappers(originalSources, false);
  const changedSources = new Map(originalSources);
  const firstPath = PROTECTED_STANDALONE_WGSL_PATHS[0];
  changedSources.set(
    firstPath,
    originalSources.get(firstPath).replace("return 0", "return 1000"),
  );

  const result = inspectProtectedWrapperFleet(changedSources, originalWrappers);
  assert.equal(result.valid, false);
  assert.equal(result.mode, "non-canonical");
  assert.deepEqual(result.nonCanonicalWrappers, [firstPath]);
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
