import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const provenance = JSON.parse(
  fs.readFileSync(
    path.join(here, "fixtures/astronomy-engine-2.1.19-provenance.json"),
    "utf8",
  ),
);
const enginePackage = JSON.parse(
  fs.readFileSync(path.join(root, "packages/engine/package.json"), "utf8"),
);
const resolvedCommonJs = require.resolve("astronomy-engine");
const dependencyRoot = path.dirname(resolvedCommonJs);
const dependencyPackage = JSON.parse(
  fs.readFileSync(path.join(dependencyRoot, "package.json"), "utf8"),
);

function fingerprint(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function listFiles(directory, relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(directory, entryRelative));
    } else {
      files.push(entryRelative.replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function noticeBody(source) {
  const match = source.match(
    /### Astronomy Engine\r?\n([\s\S]*?)\r?\n### tween\.js/,
  );
  assert.ok(match, "Astronomy Engine notice must precede tween.js");
  return match[1].replaceAll("\r\n", "\n");
}

function listRuntimeModuleSources(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(path.join(root, current), {
      withFileTypes: true,
    })) {
      const relative = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(relative);
      } else if (
        /\.(?:[cm]?js|tsx?)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(relative.replaceAll("\\", "/"));
      }
    }
  };
  visit(directory);
  return files.sort();
}

function astronomyEngineImportEdges(metafile) {
  return Object.entries(metafile.inputs)
    .flatMap(([file, input]) =>
      input.imports
        .filter(({ path: importPath }) => importPath === provenance.package)
        .map(({ path: importPath, kind }) => ({
          file: file.replaceAll("\\", "/"),
          path: importPath,
          kind,
        })),
    )
    .sort((left, right) =>
      `${left.file}\0${left.kind}`.localeCompare(
        `${right.file}\0${right.kind}`,
      ),
    );
}

async function parseModuleImportEdges(build, files) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: files,
    outbase: ".",
    outdir: "parsed-import-policy",
    bundle: true,
    external: ["*"],
    format: "esm",
    metafile: true,
    treeShaking: false,
    write: false,
    logLevel: "silent",
  });
  return astronomyEngineImportEdges(result.metafile);
}

async function parseSourceImportEdges(build, source, sourcefile) {
  const result = await build({
    stdin: {
      contents: source,
      sourcefile,
      loader: "js",
    },
    bundle: true,
    external: ["*"],
    format: "esm",
    metafile: true,
    treeShaking: false,
    write: false,
    logLevel: "silent",
  });
  return astronomyEngineImportEdges(result.metafile);
}

function assertNoEagerAstronomyEngineImports(edges, label) {
  assert.deepEqual(
    edges.filter(({ kind }) => kind !== "dynamic-import"),
    [],
    `${label} must not eagerly import the phase-1 dependency`,
  );
}

test("Astronomy Engine is an exact, inert dependency", () => {
  assert.equal(enginePackage.dependencies[provenance.package], "2.1.19");
  assert.equal(dependencyPackage.name, provenance.package);
  assert.equal(dependencyPackage.version, provenance.version);
  assert.equal(dependencyPackage.license, "MIT");
  assert.deepEqual(dependencyPackage.scripts, {});
  assert.equal(Object.hasOwn(dependencyPackage, "dependencies"), false);
  assert.equal(dependencyPackage.sideEffects, false);
  assert.deepEqual(dependencyPackage.exports, {
    ".": {
      require: "./astronomy.js",
      import: "./esm/astronomy.js",
      types: "./astronomy.d.ts",
    },
  });
});

test("installed release files match the frozen registry provenance", () => {
  assert.deepEqual(provenance.registryTarball, {
    url: "https://registry.npmjs.org/astronomy-engine/-/astronomy-engine-2.1.19.tgz",
    byteLength: 493468,
    sha256: "605e9e9ebd0a364f1c5b556f10c1f163e4b8aa63b97ada1ab72e960d73189cdd",
    sha512:
      "f3258a35fed478d6c7e39f21dec009e998008c4e634d7a7f98d3511680b6d23d921f06488c041e12c041d90dee08545a4c208946fdf72b65e1921650317a17eb",
    integrity:
      "sha512-8yWKNf7UeNbH458h3sAJ6ZgAjE5jTXp/mNNRFoC20j2SHwZIjAQeEsBB2Q3uCFRaTCCJRv33K2XhkhZQMXoX6w==",
  });
  assert.deepEqual(
    listFiles(dependencyRoot),
    Object.keys(provenance.installedFiles).sort(),
  );
  for (const [relativePath, expected] of Object.entries(
    provenance.installedFiles,
  )) {
    assert.deepEqual(
      fingerprint(path.join(dependencyRoot, relativePath)),
      expected,
      relativePath,
    );
  }
});

test("both Node resolution branches expose the required pure primitives", async () => {
  const esm = await import("astronomy-engine");
  const commonJs = require("astronomy-engine");
  for (const api of [
    "AstroTime",
    "GeoVector",
    "Rotation_EQJ_EQD",
    "RotateVector",
    "SiderealTime",
    "SearchLocalSolarEclipse",
  ]) {
    assert.equal(typeof esm[api], "function", `ESM ${api}`);
    assert.equal(typeof commonJs[api], "function", `CommonJS ${api}`);
  }

  const time = new esm.AstroTime(0.0);
  for (const body of ["Sun", "Moon"]) {
    const vector = esm.GeoVector(body, time, true);
    assert.ok([vector.x, vector.y, vector.z].every(Number.isFinite), body);
  }
  assert.ok(Number.isFinite(esm.SiderealTime(time)));
});

test("the dependency is browser-bundle resolvable without executing it by default", async () => {
  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents:
        'import { GeoVector } from "astronomy-engine"; export { GeoVector };',
      resolveDir: root,
      sourcefile: "astronomy-engine-browser-smoke.js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.outputFiles.length, 1);
  assert.ok(result.outputFiles[0].contents.byteLength > 1000);
  assert.match(result.outputFiles[0].text, /GeoVector/);
});

test("the lazy-import policy classifies parsed module edges, not source text", async () => {
  const { build } = await import("esbuild");
  const cases = [
    {
      name: "static eager import",
      source:
        'import * as astronomyEngine from "astronomy-engine"; void astronomyEngine;',
      expectedKinds: ["import-statement"],
      allowed: false,
    },
    {
      name: "aliased static eager import",
      source:
        'import { GeoVector as geoVector } from "astronomy-engine"; void geoVector;',
      expectedKinds: ["import-statement"],
      allowed: false,
    },
    {
      name: "CommonJS eager require",
      source: 'const astronomyEngine = require("astronomy-engine");',
      expectedKinds: ["require-call"],
      allowed: false,
    },
    {
      name: "explicit dynamic import",
      source:
        'export const loadAstronomyEngine = () => import("astronomy-engine");',
      expectedKinds: ["dynamic-import"],
      allowed: true,
    },
    {
      name: "string and comment lookalikes",
      source:
        'const example = \'import("astronomy-engine")\'; // import x from "astronomy-engine"',
      expectedKinds: [],
      allowed: true,
    },
    {
      name: "unrelated import with a misleading local alias",
      source:
        'import { helper as astronomyEngine } from "./helper.js"; void astronomyEngine;',
      expectedKinds: [],
      allowed: true,
    },
  ];

  for (const mutant of cases) {
    const edges = await parseSourceImportEdges(
      build,
      mutant.source,
      `${mutant.name.replaceAll(" ", "-")}.js`,
    );
    assert.deepEqual(
      edges.map(({ kind }) => kind),
      mutant.expectedKinds,
      mutant.name,
    );
    if (mutant.allowed) {
      assert.doesNotThrow(() =>
        assertNoEagerAstronomyEngineImports(edges, mutant.name),
      );
    } else {
      assert.throws(
        () => assertNoEagerAstronomyEngineImports(edges, mutant.name),
        /must not eagerly import/,
      );
    }
  }
});

test("the provider keeps the dependency behind an explicit dynamic import", async () => {
  const { build } = await import("esbuild");
  const directories = [
    "packages/engine/Source",
    "packages/sandcastle/gallery/eclipse-explorer",
  ];
  const edges = await parseModuleImportEdges(
    build,
    directories.flatMap(listRuntimeModuleSources),
  );

  for (const directory of directories) {
    assertNoEagerAstronomyEngineImports(
      edges.filter(({ file }) => file.startsWith(`${directory}/`)),
      directory,
    );
  }

  const providerPath =
    "packages/engine/Source/Core/AstronomyEngineEphemerisProvider.js";
  assert.deepEqual(
    edges.filter(({ file }) => file === providerPath),
    [
      {
        file: providerPath,
        path: provenance.package,
        kind: "dynamic-import",
      },
    ],
    "the opt-in provider must retain its literal dynamic import edge",
  );
});

test("third-party manifests and shipped notices are exact and mirrored", () => {
  const extra = JSON.parse(
    fs.readFileSync(path.join(root, "ThirdParty.extra.json"), "utf8"),
  );
  const generated = JSON.parse(
    fs.readFileSync(path.join(root, "ThirdParty.json"), "utf8"),
  );
  assert.deepEqual(
    extra.filter(({ name }) => name === provenance.package),
    [
      {
        name: provenance.package,
        license: ["MIT"],
        notes:
          "Exact 2.1.19 ephemeris dependency for opt-in high-precision eclipse circumstances; Cesium owns local contact solving and the ECEF/time-scale policy.",
      },
    ],
  );
  assert.deepEqual(
    generated.filter(({ name }) => name === provenance.package),
    [
      {
        name: provenance.package,
        license: ["MIT"],
        version: provenance.version,
        url: "https://www.npmjs.com/package/astronomy-engine",
        notes:
          "Exact 2.1.19 ephemeris dependency for opt-in high-precision eclipse circumstances; Cesium owns local contact solving and the ECEF/time-scale policy.",
      },
    ],
  );

  const rootNotice = noticeBody(
    fs.readFileSync(path.join(root, "LICENSE.md"), "utf8"),
  );
  const engineNotice = noticeBody(
    fs.readFileSync(path.join(root, "packages/engine/LICENSE.md"), "utf8"),
  );
  assert.equal(engineNotice, rootNotice);
  assert.equal(
    createHash("sha256").update(rootNotice).digest("hex"),
    provenance.license.noticeSha256,
  );
  assert.match(rootNotice, /Copyright \(c\) 2019-2023 Don Cross/);
  assert.match(rootNotice, /Permission is hereby granted/);
  assert.match(rootNotice, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("the high-precision dependency wave remains Sandcastle2-only", () => {
  const specSource = fs.readFileSync(import.meta.filename, "utf8");
  assert.doesNotMatch(specSource, /Apps[\\/]Sandcastle/);
});
