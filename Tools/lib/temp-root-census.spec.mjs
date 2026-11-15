// temp-root-census.spec.mjs — no tracked tool or spec builds a new path
// directly under the system temp root.
// @purpose Pins that every tracked file under Tools/, scripts/, Specs/ and packages/*/Specs that builds a path directly under os.tmpdir() is on the shrink-only temp-root allow-list with its exact site count and a one-line reason, that no row names a gone or clean file, that each spelling found in the tree is caught and the near-misses are not, and that inertness mutants of the detector and of the list turn it red.
// @status ACTIVE
//
// Run: node --test Tools/lib/temp-root-census.spec.mjs
//
// A sandbox made with `mkdtempSync(path.join(os.tmpdir(), prefix))` is left
// loose at the temp root when its run is killed, where no sweep can tell it
// from another program's folder; `Tools/lib/lane-tmp.mjs` puts it under one
// root per lane instead. The census reads TRACKED files only, so an untracked
// or ignored file never fails it.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importMutated } from "../visual-regression/lib/import-mutated.mjs";
import {
  LANE_TMP_MODULE,
  compareWithAllowlist,
  describeDisagreement,
  findTempRootSites,
  listCensusFiles,
  runTempRootCensus,
} from "./temp-root-census.mjs";
import { TEMP_ROOT_ALLOWLIST } from "./temp-root-allowlist.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const CENSUS_MODULE = path.join(here, "temp-root-census.mjs");
// A mutated copy is imported from a `data:` URL, which cannot resolve a bare
// package name; the TypeScript import is pointed at the installed file.
const TYPESCRIPT_URL = pathToFileURL(
  createRequire(import.meta.url).resolve("typescript"),
).href;

/** Throw an assertion naming every disagreement between a census and a list. */
function assertCensusAgrees(census, allowlist, isTracked) {
  const message = describeDisagreement(
    compareWithAllowlist(census, allowlist, { isTracked }),
  );
  assert.equal(message, "", `\n${message}`);
}

let realTree = null;
/** The census of this checkout's tracked files, taken once per run. */
function realCensus() {
  if (realTree === null) {
    const files = listCensusFiles(ROOT);
    const tracked = new Set(files);
    realTree = {
      files,
      census: runTempRootCensus({ root: ROOT, files }),
      isTracked: (file) =>
        tracked.has(file) && fs.existsSync(path.join(ROOT, file)),
    };
  }
  return realTree;
}

test("every tracked tool and spec that builds a path directly under the temp root has a row with its exact site count, and every row is live", (t) => {
  const { files, census, isTracked } = realCensus();
  assert.ok(files.length > 1000, `expected the census, read ${files.length}`);
  const sites = census.reduce((sum, entry) => sum + entry.sites.length, 0);
  t.diagnostic(
    `census: ${files.length} tracked files read, ${census.length} build under the temp root (${sites} sites); allow-list rows ${Object.keys(TEMP_ROOT_ALLOWLIST).length}`,
  );
  assertCensusAgrees(census, TEMP_ROOT_ALLOWLIST, isTracked);
});

// Each spelling the tree used when the census was taken, plus the template and
// concatenation forms an mkdtemp prefix can take. `kinds` is what the census
// must report for the fixture, in source order.
const NODE_IMPORTS = [
  'import fs from "node:fs";',
  'import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";',
  'import { mkdtemp } from "node:fs/promises";',
  'import os, { tmpdir } from "node:os";',
  'import path, { join, resolve } from "node:path";',
].join("\n");

// Inside an mkdtemp there is no exemption: a prefix that contains the temp root
// anywhere in its expression is a site, one per call, wherever its sandbox lands.
// The outermost form names the kind. These are the forms the reviews found, the
// root not first in each form, a wrapped prefix, a conditional, an array join, a
// method called on the root, and every spelling of a sandbox inside the lane
// namespace (which the lane helper makes, and a hand-made one is a site too).
const MKDTEMP_FORMS = [
  // pass 3: the namespace as the whole prefix, a computed part, a climb
  ['path.join(os.tmpdir(), "cesium-lane")', "mkdtemp-join"],
  ["path.join(os.tmpdir(), LANE_TMP_NAMESPACE)", "mkdtemp-join"],
  ['os.tmpdir() + "/cesium-lane"', "mkdtemp-concat"],
  ["`${os.tmpdir()}/cesium-lane`", "mkdtemp-template"],
  ["`${os.tmpdir()}/${LANE_TMP_NAMESPACE}`", "mkdtemp-template"],
  ["os.tmpdir() + path.sep + LANE_TMP_NAMESPACE", "mkdtemp-concat"],
  ["`${os.tmpdir()}/cesium-lane${x}-`", "mkdtemp-template"],
  ['os.tmpdir() + "/cesium-lane" + x', "mkdtemp-concat"],
  ['path.join(os.tmpdir(), `cesium-lane${x}`, "y-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane", "..", "y-")', "mkdtemp-join"],
  ['os.tmpdir() + "/cesium-lane/../y-"', "mkdtemp-concat"],
  ["`${os.tmpdir()}/cesium-lane/../y-`", "mkdtemp-template"],
  ['os.tmpdir() + "\\\\cesium-lane"', "mkdtemp-concat"],
  ['os.tmpdir() + "/cesium-lane\\\\..\\\\y-"', "mkdtemp-concat"],
  ['path.join(os.tmpdir(), "cesium-lane/", "../", "y-")', "mkdtemp-join"],
  // pass 4: a resolve with an absolute argument, a root that is not first, a wrapped prefix
  ['path.resolve(os.tmpdir(), "cesium-lane", "/x-")', "mkdtemp-join"],
  ['path.resolve(os.tmpdir(), "cesium-lane", "C:\\\\x-")', "mkdtemp-join"],
  ['path.resolve(os.tmpdir(), "cesium-lane", "\\\\x-")', "mkdtemp-join"],
  ['path.resolve(base, os.tmpdir(), "x-")', "mkdtemp-join"],
  ['path.resolve(base, os.tmpdir(), "cesium-lane")', "mkdtemp-join"],
  ['path.normalize(os.tmpdir() + "/cesium-lane")', "mkdtemp-other"],
  ['path.normalize(path.join(os.tmpdir(), "/"))', "mkdtemp-other"],
  ['path.normalize(path.join(os.tmpdir(), "cesium-lane"))', "mkdtemp-other"],
  ['path.resolve(os.tmpdir() + "/cesium-lane")', "mkdtemp-join"],
  ['realpathSync(path.join(os.tmpdir(), "cesium-lane"))', "mkdtemp-other"],
  // the root not first, in each form
  ['path.join(base, os.tmpdir(), "x-")', "mkdtemp-join"],
  ['"" + os.tmpdir() + "/cesium-lane"', "mkdtemp-concat"],
  ['empty + os.tmpdir() + "/cesium-lane"', "mkdtemp-concat"],
  ["`${empty}${os.tmpdir()}/cesium-lane`", "mkdtemp-template"],
  [
    'path.join(base, "a", os.tmpdir(), "cesium-lane", lane, "x-")',
    "mkdtemp-join",
  ],
  // the prefix wrapped, a conditional, an array join, a method on the root
  ['path.normalize(path.join(os.tmpdir(), "x-"))', "mkdtemp-other"],
  ['path.resolve(path.join(os.tmpdir(), "x-"))', "mkdtemp-join"],
  ["fs.realpathSync(`${os.tmpdir()}/x-`)", "mkdtemp-other"],
  [
    'flag ? path.join(os.tmpdir(), "x-") : path.join(dir, "y-")',
    "mkdtemp-other",
  ],
  ['flag ? os.tmpdir() : "x-"', "mkdtemp-other"],
  ['(flag ? "a-" : "b-") + os.tmpdir()', "mkdtemp-concat"],
  ['[os.tmpdir(), "x-"].join(path.sep)', "mkdtemp-join"],
  ['os.tmpdir().concat("/x-")', "mkdtemp-other"],
  ['os.tmpdir().replace("a", "b")', "mkdtemp-other"],
  ["(os.tmpdir())", "mkdtemp-bare-root"],
  // every spelling of a sandbox inside the lane namespace
  ['path.join(os.tmpdir(), "cesium-lane", "x-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane", "seat", "y-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane/", "x-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane/")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "./cesium-lane", "x-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "/", LANE_TMP_NAMESPACE, "x-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), LANE_TMP_NAMESPACE, lane, "y-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane", lane)', "mkdtemp-join"],
  ['path.join(os.tmpdir(), "cesium-lane\\\\seat\\\\y-")', "mkdtemp-join"],
  ['path.join(os.tmpdir(), `cesium-lane/${lane}`, "y-")', "mkdtemp-join"],
  ['path.resolve(os.tmpdir(), "cesium-lane", "x-")', "mkdtemp-join"],
  ['os.tmpdir() + "/cesium-lane/x-"', "mkdtemp-concat"],
  ['os.tmpdir() + "/./cesium-lane/x-"', "mkdtemp-concat"],
  ['os.tmpdir() + "\\\\cesium-lane\\\\seat\\\\y-"', "mkdtemp-concat"],
  [
    "os.tmpdir() + path.sep + LANE_TMP_NAMESPACE + path.sep + 'x-'",
    "mkdtemp-concat",
  ],
  ['os.tmpdir() + "/cesium-lane/" + lane + "/y-"', "mkdtemp-concat"],
  ['os.tmpdir() + "/cesium-lane/" + lane', "mkdtemp-concat"],
  ["`${os.tmpdir()}/cesium-lane/x-`", "mkdtemp-template"],
  ["`${os.tmpdir()}/cesium-lane/seat/y-`", "mkdtemp-template"],
  ["`${os.tmpdir()}\\\\cesium-lane\\\\x-`", "mkdtemp-template"],
  ["`${os.tmpdir()}/${LANE_TMP_NAMESPACE}/x-`", "mkdtemp-template"],
  ["`${os.tmpdir()}/./${LANE_TMP_NAMESPACE}/${lane}/y-`", "mkdtemp-template"],
  ["`${os.tmpdir()}/cesium-lane/${lane}-`", "mkdtemp-template"],
];

const SPELLINGS = [
  {
    name: "fs.mkdtempSync(path.join(os.tmpdir(), prefix))",
    source: "const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));",
    kinds: ["mkdtemp-join"],
  },
  {
    name: "named imports: mkdtempSync(join(tmpdir(), literal))",
    source: 'const d = mkdtempSync(join(tmpdir(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "promise form: await mkdtemp(path.join(tmpdir(), literal))",
    source: 'const d = await mkdtemp(path.join(tmpdir(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "fs/promises namespace: await fsp.mkdtemp(path.join(os.tmpdir(), literal))",
    source:
      'import fsp from "node:fs/promises";\nconst d = await fsp.mkdtemp(path.join(os.tmpdir(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "resolve spelling: mkdtempSync(resolve(tmpdir(), literal))",
    source: 'const d = mkdtempSync(resolve(tmpdir(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "multi-line call with a template prefix",
    source:
      "const d = fs.mkdtempSync(\n  path.join(os.tmpdir(), `c1229-svs-${name}-`),\n);",
    kinds: ["mkdtemp-join"],
  },
  {
    name: "alias through realpathSync",
    source:
      'const TMP_ROOT = realpathSync(os.tmpdir());\nconst d = mkdtempSync(path.join(TMP_ROOT, "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "alias through fs.realpathSync, used inside a function",
    source:
      'const tempRoot = fs.realpathSync(os.tmpdir());\nfunction make() {\n  return fs.mkdtempSync(path.join(tempRoot, "x-"));\n}',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "alias of an alias",
    source:
      'const base = os.tmpdir();\nconst real = realpathSync(base);\nconst d = mkdtempSync(join(real, "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "a fixed folder made with mkdirSync",
    source:
      'const mutantRoot = join(tmpdir(), "collection-previous-frame-rte", "mutants");\nmkdirSync(mutantRoot, { recursive: true });',
    kinds: ["join-fixed"],
  },
  {
    name: "a loose file named by a template",
    source:
      "const file = path.join(\n  os.tmpdir(),\n  `probe-edge-${process.pid}.mjs`,\n);\nwriteFileSync(file, text);",
    kinds: ["join-fixed"],
  },
  {
    name: "a computed name under an alias",
    source:
      "const tmp = os.tmpdir();\nfor (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true });",
    kinds: ["join-computed"],
  },
  {
    name: "a path inside a launcher flag",
    source:
      "const flag = `--user-data-dir=${os.tmpdir()}\\\\karma-edge-${Date.now()}`;",
    kinds: ["template-path"],
  },
  {
    name: "an mkdtemp prefix written as a template",
    source: "const d = mkdtempSync(`${os.tmpdir()}/x-`);",
    kinds: ["mkdtemp-template"],
  },
  {
    name: "an mkdtemp prefix written as a concatenation",
    source: 'const d = mkdtempSync(os.tmpdir() + path.sep + "x-");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and path.sep, by concatenation",
    source: "const d = mkdtempSync(os.tmpdir() + path.sep);",
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and a literal slash, by concatenation",
    source: 'const d = fs.mkdtempSync(os.tmpdir() + "/");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is a wrapped temp root and a literal backslash",
    source: 'const d = mkdtempSync(realpathSync(tmpdir()) + "\\\\");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and path.sep in a template",
    source: "const d = mkdtempSync(`${os.tmpdir()}${path.sep}`);",
    kinds: ["mkdtemp-template"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and a template slash",
    source: "const d = await mkdtemp(`${tmpdir()}/`);",
    kinds: ["mkdtemp-template"],
  },
  // Inside an mkdtemp every prefix built on the temp root is a site unless its
  // first named segment below the root is the lane namespace: a join whose rest
  // names nothing, a rest of separators and dots, and the bare root.
  ...[
    ["a literal slash", '"/"'],
    ["a literal backslash", '"\\\\"'],
    ["dot slash", '"./"'],
    ["a dot", '"."'],
    ["an empty string", '""'],
    ["path.sep", "path.sep"],
  ].map(([what, argument]) => ({
    name: `an mkdtemp prefix that is a join of the temp root and ${what}`,
    source: `const d = mkdtempSync(path.join(os.tmpdir(), ${argument}));`,
    kinds: ["mkdtemp-join"],
  })),
  {
    name: "an mkdtemp prefix that is a resolve of the temp root and an empty string",
    source: 'const d = mkdtempSync(resolve(tmpdir(), ""));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp prefix that is a join of the temp root, dot slash and a name",
    source: 'const d = mkdtempSync(path.join(os.tmpdir(), "./", "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp prefix that is a join of the temp root and a parent segment",
    source: 'const d = mkdtempSync(path.join(os.tmpdir(), "..", "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp prefix that is a join of the temp root alone",
    source: "const d = mkdtempSync(path.join(os.tmpdir()));",
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and slash dot, by concatenation",
    source: 'const d = mkdtempSync(os.tmpdir() + "/.");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and slash dot slash, by concatenation",
    source: 'const d = mkdtempSync(os.tmpdir() + "/./");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and slash dot, by template",
    source: "const d = mkdtempSync(`${os.tmpdir()}/.`);",
    kinds: ["mkdtemp-template"],
  },
  {
    name: "an mkdtemp prefix that is the temp root and slash dot slash, by template",
    source: "const d = mkdtempSync(`${os.tmpdir()}/./`);",
    kinds: ["mkdtemp-template"],
  },
  {
    name: "an mkdtemp prefix that is a name attached to the temp root, by concatenation",
    source: 'const d = mkdtempSync(os.tmpdir() + "x-");',
    kinds: ["mkdtemp-concat"],
  },
  {
    name: "the bare temp root as an mkdtemp prefix",
    source: "const d = fs.mkdtempSync(os.tmpdir());",
    kinds: ["mkdtemp-bare-root"],
  },
  {
    name: "the bare temp root, named import and promise form",
    source: "const d = await mkdtemp(tmpdir());",
    kinds: ["mkdtemp-bare-root"],
  },
  {
    name: "the bare temp root, wrapped",
    source: "const d = mkdtempSync(realpathSync(os.tmpdir()));",
    kinds: ["mkdtemp-bare-root"],
  },
  {
    name: "the bare temp root through a name",
    source: "const base = os.tmpdir();\nconst d = mkdtempSync(base);",
    kinds: ["mkdtemp-bare-root"],
  },
  {
    name: "the temp root alone in a template, and with an empty string in a concatenation: the outermost form names the kind",
    source:
      'const a = mkdtempSync(`${os.tmpdir()}`);\nconst b = mkdtempSync(os.tmpdir() + "");',
    kinds: ["mkdtemp-template", "mkdtemp-concat"],
  },
  ...MKDTEMP_FORMS.map(([expression, kind]) => ({
    name: `an mkdtemp whose prefix contains the temp root: ${expression}`,
    source: `const d = mkdtempSync(${expression});`,
    kinds: [kind],
  })),
  {
    name: "the same paths outside an mkdtemp keep the kinds they have",
    source:
      'const a = path.join(os.tmpdir(), "x-");\nconst b = os.tmpdir() + "/x-";\nconst c = `${os.tmpdir()}/x-`;\nconst d = path.join(os.tmpdir(), name);',
    kinds: ["join-fixed", "concat-path", "template-path", "join-computed"],
  },
  {
    name: "a shorthand property is a reference to the root variable",
    source:
      "const root = os.tmpdir();\nconst d = mkdtempSync(pick({ root }, base));",
    kinds: ["mkdtemp-other"],
  },
  {
    name: "a reference to the root variable after a computed member of another object",
    source:
      'const root = os.tmpdir();\nconst d = mkdtempSync(path.join(opts.root, root, "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp inside an mkdtemp's prefix is its own site, and the outer call is none",
    source:
      'const d = mkdtempSync(path.join(mkdtempSync(path.join(os.tmpdir(), "a-")), "b-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "an mkdtemp inside an mkdtemp's prefix, and a root outside it: two sites",
    source:
      'const d = mkdtempSync(path.join(os.tmpdir(), mkdtempSync(path.join(os.tmpdir(), "a-"))));',
    kinds: ["mkdtemp-join", "mkdtemp-join"],
  },
  {
    name: "the disposable mkdtemp, synchronous",
    source: 'const d = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "the disposable mkdtemp, promise form",
    source:
      'const d = await fs.promises.mkdtempDisposable(path.join(os.tmpdir(), "y-"));',
    kinds: ["mkdtemp-join"],
  },
  {
    name: "a loose file written by concatenation",
    source: 'writeFileSync(os.tmpdir() + "/loose.txt", "x");',
    kinds: ["concat-path"],
  },
  {
    name: "tmpdir under an import alias",
    source:
      'import { tmpdir as osTmp } from "node:os";\nconst d = mkdtempSync(join(osTmp(), "x-"));',
    kinds: ["mkdtemp-join"],
  },
];

const NEAR_MISSES = [
  {
    name: "a comment that spells the call",
    source: '// const d = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));',
  },
  {
    name: "a string that spells the call",
    source: "const text = \"fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))\";",
  },
  {
    name: "the lane helper's own calls",
    source:
      'import { mkLaneTmp, withLaneTmp } from "./lane-tmp.mjs";\nconst d = mkLaneTmp("x-");\nwithLaneTmp("y-", (dir) => fs.mkdtempSync(path.join(dir, "z-")));',
  },
  {
    name: "paths inside the lane namespace outside an mkdtemp, by literal and by the export",
    source:
      'fs.mkdirSync(path.join(os.tmpdir(), "cesium-lane", "landing"), { recursive: true });\nconst r = path.join(path.resolve(os.tmpdir()), LANE_TMP_NAMESPACE, LANE);\nconst s = path.resolve(tmpdir(), "cesium-lane/brownlands");',
  },
  {
    name: "the temp root itself, compared or related",
    source:
      'const root = path.resolve(os.tmpdir());\nconst inside = dir.startsWith(path.resolve(os.tmpdir()) + path.sep);\nconst rel = path.relative(tmpdir(), dir);\nconst up = path.join(os.tmpdir(), "..");',
  },
  {
    name: "a bare separator after the temp root outside an mkdtemp",
    source:
      'const withSep = os.tmpdir() + path.sep;\nconst slash = `${os.tmpdir()}/`;\nconst back = tmpdir() + "\\\\";',
  },
  {
    name: "the same separator and dot texts outside an mkdtemp",
    source:
      'const a = path.join(os.tmpdir(), "/");\nconst b = path.join(os.tmpdir(), "\\\\");\nconst c = path.join(os.tmpdir(), "./");\nconst d = path.join(tmpdir(), ".");\nconst e = path.join(os.tmpdir(), "");\nconst f = os.tmpdir() + "/.";\nconst g = `${os.tmpdir()}/.`;\nconst h = os.tmpdir() + "/./";\nconst root = os.tmpdir();\nconst i = path.relative(root, dir);',
  },
  {
    name: "an mkdtemp prefix that does not contain the temp root in its own text: a variable, the lane helper's result, a join on such a variable",
    source:
      'const laneRoot = mkLaneTmp("x-");\nconst a = fs.mkdtempSync(path.join(laneRoot, "y-"));\nconst b = fs.mkdtempSync(prefix);\nconst c = mkdtempSync(laneRoot + "/z-");\nconst d = mkdtempSync(mkLaneTmp("w-"));\nconst e = mkdtempSync(path.join(dir, "cesium-lane", "q-"));\nconst f = mkdtempSync(`${laneRoot}/v-`);',
  },
  {
    name: "a property name, an object key, a declared name and a label that spell the root variable's name are not the root",
    source:
      'const root = os.tmpdir();\nconst a = mkdtempSync(path.join(opts.root, "x-"));\nconst b = mkdtempSync(pick({ root: 1 }, base));\nconst c = mkdtempSync(pick((root) => 1, base));\nconst d = mkdtempSync(pick(() => { root: for (;;) { break root; } }, base));\nconst e = mkdtempSync(pick(class { root = 1; }, base));',
  },
  ...[
    ["type root = string;", 'path.join(dir as root, "x-")', "a type reference"],
    ["type root = string;", "pick<root>(dir)", "a type argument"],
    ["", 'path.join(dir as typeof root, "x-")', "a type query"],
    [
      "",
      'path.join(dir as ns.root, "x-")',
      "the right-hand name of a qualified type name",
    ],
    [
      "",
      "pick(dir satisfies Record<string, typeof root>)",
      "a type nested in a type argument",
    ],
  ].map(([declaration, expression, what]) => ({
    name: `in a TypeScript file, ${what} that spells the root variable's name is not the root`,
    fileName: "typed.ts",
    source: `const root = os.tmpdir();\n${declaration}\nconst d = mkdtempSync(${expression});`,
  })),
  {
    name: "a destructuring key that spells the root variable's name is not the root",
    source:
      "const root = os.tmpdir();\nconst d = mkdtempSync(pick(({ root: r }) => r, base));",
  },
  {
    name: "a fallback is not the temp root",
    source:
      'const temp = path.resolve(options.temp ?? os.tmpdir());\nconst keep = path.join(temp, "node-compile-cache");',
  },
  {
    name: "the temp root inside a message",
    source:
      "log.refused = `not the temp directory (tmpdir ${path.resolve(os.tmpdir())})`;",
  },
  {
    name: "a name bound to the temp root in one scope and to a lane folder in another",
    source:
      'function a() {\n  const root = os.tmpdir();\n  return root;\n}\nfunction b() {\n  const root = mkLaneTmp("x-");\n  return path.join(root, "child");\n}',
  },
  {
    name: "a sandbox under a lane folder",
    source:
      'let runDir;\nrunDir ??= mkLaneTmp("smoke-");\nconst d = fs.mkdtempSync(path.join(runDir, "x-"));',
  },
];

/** Every spelling is caught with its kind, and every near miss is not. */
function assertSpellings(find) {
  for (const spelling of SPELLINGS) {
    const sites = find(
      `${NODE_IMPORTS}\n${spelling.source}\n`,
      spelling.fileName ?? "fixture.mjs",
    );
    assert.deepEqual(
      sites.map((site) => site.kind),
      spelling.kinds,
      `spelling not caught as ${spelling.kinds.join(", ")}: ${spelling.name}`,
    );
  }
  for (const nearMiss of NEAR_MISSES) {
    const sites = find(
      `${NODE_IMPORTS}\n${nearMiss.source}\n`,
      nearMiss.fileName ?? "fixture.mjs",
    );
    assert.deepEqual(
      sites.map((site) => `${site.line} ${site.kind}`),
      [],
      `near miss counted as a site: ${nearMiss.name}`,
    );
  }
}

test("each spelling is caught with its kind, and the near misses are not", () => {
  assertSpellings(findTempRootSites);
});

/** Every form is exactly one site of its kind, at the mkdtemp call. */
function assertMkdtempForms(find) {
  assert.ok(MKDTEMP_FORMS.length > 60, `forms: ${MKDTEMP_FORMS.length}`);
  for (const [expression, kind] of MKDTEMP_FORMS) {
    const sites = find(
      `${NODE_IMPORTS}\nconst d = mkdtempSync(${expression});\n`,
      "forms.mjs",
    );
    assert.deepEqual(
      sites.map((site) => site.kind),
      [kind],
      `an mkdtemp whose prefix contains the temp root is one site of kind ${kind}: ${expression}`,
    );
  }
}

test("every mkdtemp whose prefix contains the temp root is exactly one site, whatever the form", () => {
  assertMkdtempForms(findTempRootSites);
});

test("a site is reported with its own line, also in a TypeScript file", () => {
  const source = [
    'import os from "node:os";',
    'import path from "node:path";',
    "",
    "const sandbox: string = fs.mkdtempSync(",
    '  path.join(os.tmpdir(), "x-"),',
    ");",
  ].join("\n");
  assert.deepEqual(
    findTempRootSites(source, "fixture.ts").map(
      (site) => `${site.line} ${site.kind}`,
    ),
    ["4 mkdtemp-join"],
  );
});

const OFFENDING =
  'import os from "node:os";\nimport path from "node:path";\nconst d = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));\n';

test("the lane helper is the one file exempt by name", () => {
  const files = [LANE_TMP_MODULE, "Tools/lib/other.mjs"];
  const census = runTempRootCensus({
    root: ROOT,
    files,
    readFile: () => OFFENDING,
  });
  assert.deepEqual(
    census.map((entry) => entry.file),
    ["Tools/lib/other.mjs"],
  );
});

test("MUTANT — one row removed turns the census red, naming that file", () => {
  const { census, isTracked } = realCensus();
  const [removed] = Object.keys(TEMP_ROOT_ALLOWLIST);
  const shrunk = { ...TEMP_ROOT_ALLOWLIST };
  delete shrunk[removed];
  assert.throws(
    () => assertCensusAgrees(census, shrunk, isTracked),
    (error) =>
      /has no allow-list row/u.test(error.message) &&
      error.message.includes(`${removed}:`),
  );
});

test("MUTANT — a stale row turns the census red: a gone file, a clean file, a wrong count, a missing reason", () => {
  const { census, isTracked } = realCensus();
  const [counted] = Object.keys(TEMP_ROOT_ALLOWLIST);
  const cases = [
    [
      { "Tools/no-such-tool.mjs": { sites: 1, reason: "gone" } },
      /names a file that is gone:\n {2}Tools\/no-such-tool\.mjs/u,
    ],
    [
      { "Tools/lib/png-rgba.mjs": { sites: 1, reason: "clean" } },
      /no longer does it:\n {2}Tools\/lib\/png-rgba\.mjs/u,
    ],
    [
      {
        [counted]: {
          ...TEMP_ROOT_ALLOWLIST[counted],
          sites: TEMP_ROOT_ALLOWLIST[counted].sites + 1,
        },
      },
      /site count is not the file's/u,
    ],
    [
      { [counted]: { sites: TEMP_ROOT_ALLOWLIST[counted].sites, reason: "" } },
      /malformed allow-list row/u,
    ],
    [
      { [LANE_TMP_MODULE]: { sites: 1, reason: "exempt" } },
      /the lane helper needs no row/u,
    ],
  ];
  for (const [rows, pattern] of cases) {
    assert.throws(
      () =>
        assertCensusAgrees(
          census,
          { ...TEMP_ROOT_ALLOWLIST, ...rows },
          isTracked,
        ),
      pattern,
    );
  }
});

/** The census module with `[anchor, replacement]` applied. */
function mutatedCensus(anchor, replacement) {
  return importMutated(CENSUS_MODULE, [
    ['from "typescript"', `from "${TYPESCRIPT_URL}"`],
    [anchor, replacement],
  ]);
}

test("INERTNESS MUTANT — with aliases never recorded, the alias spellings are missed", async () => {
  const mutant = await mutatedCensus(
    "if (isTempRoot(declaration.initializer)) {",
    "if (false && isTempRoot(declaration.initializer)) {",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /spelling not caught as mkdtemp-join: alias through realpathSync/u,
  );
});

test("INERTNESS MUTANT — with the mkdtemp rule unreachable, sandboxes lose their kind or go unseen", async () => {
  const mutant = await mutatedCensus(
    "      if (isMkdtempCall(node)) {",
    "      if (false && isMkdtempCall(node)) {",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /spelling not caught as mkdtemp-join/u,
  );
});

test("INERTNESS MUTANT — with the mkdtemp rule unreachable, no form on the temp root is a site", async () => {
  const mutant = await mutatedCensus(
    "    if (!containsTempRoot(prefix)) return null;",
    "    if (true || !containsTempRoot(prefix)) return null;",
  );
  assert.throws(
    () => assertMkdtempForms(mutant.findTempRootSites),
    /an mkdtemp whose prefix contains the temp root is one site of kind mkdtemp-join: path\.join\(os\.tmpdir\(\), "cesium-lane"\)/u,
  );
});

test("INERTNESS MUTANT — with the rule narrowed to the root as first argument, a root that is not first goes unseen", async () => {
  const mutant = await mutatedCensus(
    "    if (!containsTempRoot(prefix)) return null;",
    "    if (!(ts.isCallExpression(prefix) && prefix.arguments.length > 0 && isTempRoot(prefix.arguments[0])) && !isTempRoot(prefix)) return null;",
  );
  assert.throws(
    () => assertMkdtempForms(mutant.findTempRootSites),
    /an mkdtemp whose prefix contains the temp root is one site of kind mkdtemp-concat: os\.tmpdir\(\) \+ "\/cesium-lane"/u,
  );
});

test("INERTNESS MUTANT — with the inside of a counted prefix counted again, a wrapped prefix is two sites", async () => {
  const mutant = await mutatedCensus(
    "markConsumed(node.arguments[0]);",
    "consumed.add(prefix);",
  );
  assert.throws(
    () => assertMkdtempForms(mutant.findTempRootSites),
    /is one site of kind mkdtemp-other: path\.normalize\(os\.tmpdir\(\) \+ "\/cesium-lane"\)|is one site of kind mkdtemp-other: path\.normalize\(path\.join/u,
  );
});

test("INERTNESS MUTANT — with names that are not references counted, a property name and an object key are the root", async () => {
  const mutant = await mutatedCensus(
    "if (ts.isIdentifier(node) && isNotReference(node)) return false;",
    "if (false && ts.isIdentifier(node) && isNotReference(node)) return false;",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /near miss counted as a site: a property name, an object key/u,
  );
});

test("INERTNESS MUTANT — with a nested mkdtemp consumed by the outer call, the inner call is no site", async () => {
  const mutant = await mutatedCensus(
    "    if (isMkdtempCall(node)) return;\n    consumed.add(node);",
    "    consumed.add(node);",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /spelling not caught as mkdtemp-join(, mkdtemp-join)?: an mkdtemp inside an mkdtemp's prefix/u,
  );
});

test("INERTNESS MUTANT — with a nested mkdtemp looked into by the outer call, the outer call is a site too", async () => {
  const mutant = await mutatedCensus(
    "    if (isMkdtempCall(node)) return false;\n",
    "",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /spelling not caught as mkdtemp-join: an mkdtemp inside an mkdtemp's prefix is its own site, and the outer call is none/u,
  );
});

test("INERTNESS MUTANT — with the disposable names not read, their sandboxes go unseen", async () => {
  const mutant = await mutatedCensus('  "mkdtempDisposableSync",\n', "");
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /spelling not caught as mkdtemp-join: the disposable mkdtemp, synchronous/u,
  );
});

test("INERTNESS MUTANT — with the type-node skip unreachable, a type that spells the root variable's name counts as the root", async () => {
  const mutant = await mutatedCensus(
    "  const isTypeOnly = (node) =>\n    ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);",
    "  const isTypeOnly = () => false;",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /near miss counted as a site: in a TypeScript file, a type reference/u,
  );
});

test("INERTNESS MUTANT — with the lane-namespace exemption unreachable, a path inside the lane root counts", async () => {
  const mutant = await mutatedCensus(
    "segment !== LANE_TMP_NAMESPACE",
    "(false || true)",
  );
  assert.throws(
    () => assertSpellings(mutant.findTempRootSites),
    /near miss counted as a site: paths inside the lane namespace/u,
  );
});

test("INERTNESS MUTANT — with the exemption by name unreachable, the lane helper would be listed", async () => {
  const mutant = await mutatedCensus(
    "if (file === LANE_TMP_MODULE) continue;",
    "if (false && file === LANE_TMP_MODULE) continue;",
  );
  const census = mutant.runTempRootCensus({
    root: ROOT,
    files: [LANE_TMP_MODULE],
    readFile: () => OFFENDING,
  });
  assert.deepEqual(
    census.map((entry) => entry.file),
    [LANE_TMP_MODULE],
  );
});
