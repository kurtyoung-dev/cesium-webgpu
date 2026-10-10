// Pure-Node spec for the probe-kit inventory generator, over a fixture tree
// built in lane temp space: three lib pieces, four rigs, a probe on the
// runtime, a direct launcher, a probe that only MENTIONS the runtime, a spec
// that reaches the runtime probe through a fixtures/ helper, and one archived
// probe.
//
// @purpose Pins probe-kit-inventory.mjs's table rows, exports (destructured ones included) and importer counts, its runtime/direct classification through the fleet contract's detectors, its four rig-link rules and fixtures/ spec hop, and --check red on a mutated region and green on the generated one.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/probe-kit-inventory.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  REGION_BEGIN,
  REGION_END,
  collectInventory,
  extractRegion,
  main,
  readExports,
  readImportSpecifiers,
  regionDiff,
  renderInventory,
  replaceRegion,
} from "./probe-kit-inventory.mjs";

const FILES = {
  "lib/alpha.mjs": [
    "// alpha.mjs — fixture piece.",
    "// @purpose Alpha fixture piece that imports beta.",
    "// @status ACTIVE",
    'import { b1 } from "./beta.mjs";',
    '// import { nothing } from "./metrics/gamma.mjs";',
    "export const ALPHA = 1;",
    "export async function alphaFn() {",
    "  return b1;",
    "}",
    "",
  ],
  "lib/beta.mjs": [
    "// @purpose Beta fixture piece with a renamed export.",
    "// @status INVESTIGATION",
    "const b1 = 1;",
    "const b2 = 2;",
    "export { b1, b2 as beta2 };",
    "export class Gamma {}",
    "",
  ],
  "lib/metrics/gamma.mjs": [
    "/**",
    " * @purpose Gamma fixture metric.",
    " * @status ACTIVE",
    " */",
    "export function gammaMetric() {",
    "  return 0;",
    "}",
    "",
  ],
  "rigs/fixture-one.mjs": rig("fixture-one", ["globe"], {
    page: "Apps/CesiumViewer/index.html",
  }),
  "rigs/fixture-two.mjs": rig("fixture-two", ["cloud"], {
    page: null,
    declaredBy: "probe-fixture-runtime",
  }),
  "rigs/fixture-runtime-a.mjs": rig("fixture-runtime-a", ["globe"], {
    page: "Apps/CesiumViewer/index.html",
  }),
  "rigs/fixture-runtime-wave.mjs": rig("fixture-runtime-wave", ["wave-end"], {
    url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  }),
  "probe-fixture-runtime.mjs": [
    "// @purpose Fixture probe on the runtime.",
    "// @status ACTIVE",
    'import { isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";',
    'import { alphaFn } from "./lib/alpha.mjs";',
    'const RIG = "fixture-one";',
    "if (isEntryPoint(import.meta.url)) {",
    "  process.exitCode = await runProbe({ name: RIG, cells: async () => [await alphaFn()] });",
    "}",
    "",
  ],
  "probe-fixture-direct.mjs": [
    "// @purpose Fixture probe that launches its own browser.",
    "// @status ACTIVE",
    'import { chromium } from "playwright";',
    'import { gammaMetric } from "./lib/metrics/gamma.mjs";',
    "const browser = await chromium.launch();",
    "try {",
    "  gammaMetric();",
    "} finally {",
    "  await browser.close();",
    "}",
    "",
  ],
  "probe-fixture-mention.mjs": [
    "// @purpose Fixture probe that only mentions runProbe( in a comment.",
    "// @status ACTIVE",
    'import { parseProbeArgs } from "./lib/probe-runtime.mjs";',
    "// a future version will call runProbe(descriptor) here",
    "parseProbeArgs([]);",
    "",
  ],
  "fixtures/stub.mjs": [
    'import { descriptor } from "../probe-fixture-runtime.mjs";',
    'import { ALPHA } from "../lib/alpha.mjs";',
    "export const STUB = [descriptor, ALPHA];",
    "",
  ],
  "fixture-routing.spec.mjs": [
    'import { STUB } from "./fixtures/stub.mjs";',
    'import { beta2 } from "./lib/beta.mjs";',
    "void STUB;",
    "void beta2;",
    "",
  ],
  "archive/probe-fixture-old.mjs": [
    "// @purpose An archived fixture probe.",
    "// @status ARCHIVED-CANDIDATE",
    "",
  ],
};

function rig(id, tags, extra) {
  const fields = {
    id,
    tags,
    ...("url" in extra ? { url: extra.url } : { page: extra.page }),
    renderers: ["webgl", "webgpu"],
    description: `fixture rig ${id}`,
    ...(extra.declaredBy ? { declaredBy: extra.declaredBy } : {}),
    camera: null,
    clock: null,
    viewport: { width: 64, height: 32 },
    readiness: { kind: "settleFrames", frames: 2 },
  };
  return [
    `// @purpose Fixture rig ${id}.`,
    "// @status ACTIVE",
    `export default Object.freeze(${JSON.stringify(fields)});`,
    "",
  ];
}

function buildFixture() {
  const root = mkLaneTmp("probe-kit-inventory-");
  for (const [rel, lines] of Object.entries(FILES)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n"));
  }
  return root;
}

async function withFixture(body) {
  const root = buildFixture();
  try {
    return await body(root);
  } finally {
    removeLaneTmp(root);
  }
}

test("exports are read from code: declarations, renamed braces, classes; comments are not exports", () => {
  assert.deepEqual(readExports(FILES["lib/alpha.mjs"].join("\n")), [
    "ALPHA",
    "alphaFn",
  ]);
  assert.deepEqual(readExports(FILES["lib/beta.mjs"].join("\n")), [
    "b1",
    "beta2",
    "Gamma",
  ]);
  assert.deepEqual(
    readExports('export * from "./x.mjs";\nexport default 1;\n'),
    ["*", "default"],
  );
});

test("exports bound through a destructuring pattern are read, nested, renamed, defaulted and rest", () => {
  const source = [
    "export const first = 0;",
    "export const {",
    "  Plain,",
    "  key: Renamed, // a comment: not a binding",
    '  Defaulted = cond ? "a: b" : { c: 1 },',
    "  nested: { Inner, deep: [Deeper] },",
    "  ...Rest",
    "} = await import(`data:${x}`);",
    "export let [Head, , Third = f(1, 2), ...Tail] = list;",
    "export const last = 1;",
    "",
  ].join("\n");
  assert.deepEqual(readExports(source), [
    "first",
    "Plain",
    "Renamed",
    "Defaulted",
    "Inner",
    "Deeper",
    "Rest",
    "Head",
    "Third",
    "Tail",
    "last",
  ]);
});

test("import specifiers are read from code, never from a comment", () => {
  assert.deepEqual(readImportSpecifiers(FILES["lib/alpha.mjs"].join("\n")), [
    "./beta.mjs",
  ]);
  assert.deepEqual(
    readImportSpecifiers(
      'import "./a.mjs";\nexport { x } from "./b.mjs";\nconst m = await import("./c.mjs");\n',
    ),
    ["./a.mjs", "./b.mjs", "./c.mjs"],
  );
});

test("the inventory lists every piece with its purpose, exports and importer counts", async () => {
  await withFixture(async (root) => {
    const inventory = await collectInventory({ root });
    assert.deepEqual(
      inventory.lib.map((row) => [
        row.path,
        row.purpose,
        row.status,
        row.exports,
        row.importers,
      ]),
      [
        [
          "lib/alpha.mjs",
          "Alpha fixture piece that imports beta.",
          "ACTIVE",
          ["ALPHA", "alphaFn"],
          { scripts: 1, specs: 1, lib: 0 },
        ],
        [
          "lib/beta.mjs",
          "Beta fixture piece with a renamed export.",
          "INVESTIGATION",
          ["b1", "beta2", "Gamma"],
          { scripts: 0, specs: 1, lib: 1 },
        ],
      ],
    );
    assert.deepEqual(
      inventory.metrics.map((row) => [
        row.path,
        row.purpose,
        row.exports,
        row.importers,
      ]),
      [
        [
          "lib/metrics/gamma.mjs",
          "Gamma fixture metric.",
          ["gammaMetric"],
          { scripts: 1, specs: 0, lib: 0 },
        ],
      ],
    );
    assert.deepEqual(
      inventory.rigs.map((r) => [r.id, r.tags, r.page, r.pageKind]),
      [
        ["fixture-one", ["globe"], "Apps/CesiumViewer/index.html", "page"],
        [
          "fixture-runtime-a",
          ["globe"],
          "Apps/CesiumViewer/index.html",
          "page",
        ],
        [
          "fixture-runtime-wave",
          ["wave-end"],
          "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
          "url",
        ],
        ["fixture-two", ["cloud"], null, "page"],
      ],
    );
    assert.deepEqual(inventory.archive, [
      {
        path: "archive/probe-fixture-old.mjs",
        family: "fixture",
        status: "ARCHIVED-CANDIDATE",
      },
    ]);
  });
});

test("probes are classified by the fleet contract's detectors, and rigs and specs are linked by the stated rules", async () => {
  await withFixture(async (root) => {
    const { probes } = await collectInventory({ root });
    assert.equal(probes.topLevelNamed, 3);
    assert.deepEqual(probes.runtime, [
      {
        path: "probe-fixture-runtime.mjs",
        family: "fixture",
        purpose: "Fixture probe on the runtime.",
        status: "ACTIVE",
        // fixture-one: a string literal; fixture-two: declaredBy; fixture-runtime-a:
        // the stem rule. fixture-runtime-wave matches the stem but is wave-end.
        rigs: ["fixture-one", "fixture-runtime-a", "fixture-two"],
        // Reached only through fixtures/stub.mjs.
        specs: ["fixture-routing.spec.mjs"],
      },
    ]);
    assert.deepEqual(probes.direct, [
      { path: "probe-fixture-direct.mjs", family: "fixture" },
    ]);
    assert.deepEqual(probes.unlaunched, [
      {
        path: "probe-fixture-mention.mjs",
        reason: "no browser launch detected",
      },
    ]);
  });
});

test("the rendered region carries the rows a reader looks up", async () => {
  await withFixture(async (root) => {
    const body = renderInventory(await collectInventory({ root }));
    const lines = body.split("\n");
    for (const expected of [
      "| kit pieces under `lib/` (outside `lib/metrics/`) | 2 |",
      "| top-level scripts on the runtime (`runProbe`) | 1 |",
      "| top-level scripts launching a browser directly | 1 |",
      "| `lib/alpha.mjs` | Alpha fixture piece that imports beta. | `ALPHA`, `alphaFn` | 1 | 1 | 0 |",
      "| `lib/beta.mjs` | Beta fixture piece with a renamed export. (`@status INVESTIGATION`) | `b1`, `beta2`, `Gamma` | 0 | 1 | 1 |",
      "| `lib/metrics/gamma.mjs` | Gamma fixture metric. | `gammaMetric` | 1 | 0 | 0 |",
      "#### `globe` (2)",
      "| `fixture-two` | webgl, webgpu | none (`page: null`) | Fixture rig fixture-two. |",
      "| `fixture-runtime-wave` | webgl, webgpu | url `http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html` | Fixture rig fixture-runtime-wave. |",
      "| `probe-fixture-runtime.mjs` | fixture | Fixture probe on the runtime. | `fixture-one`, `fixture-runtime-a`, `fixture-two` | `fixture-routing.spec.mjs` |",
      "| 1 other families, fewer than 5 each | 1 |",
      "| `probe-fixture-mention.mjs` | no browser launch detected |",
      "| fixture | 1 | 1 |",
    ]) {
      assert.ok(lines.includes(expected), `missing row: ${expected}`);
    }
  });
});

test("--check is green on the generated region, red with a diff on a mutated row, and --write repairs it", async () => {
  await withFixture(async (root) => {
    const guide = path.join(root, "GUIDE.md");
    fs.writeFileSync(
      guide,
      `# Guide\r\n\r\n${REGION_BEGIN}\r\nstale\r\n${REGION_END}\r\n\r\nAfter.\r\n`,
    );
    const io = () => {
      const out = { stdout: "", stderr: "" };
      return [
        out,
        { stdout: (t) => (out.stdout += t), stderr: (t) => (out.stderr += t) },
      ];
    };

    let [out, sinks] = io();
    assert.equal(
      await main(["--root", root, "--check", guide], sinks),
      1,
      "a stale region must fail --check",
    );
    assert.match(out.stderr, /has drifted from the tree/);
    assert.match(out.stderr, /^- stale$/m);

    [out, sinks] = io();
    assert.equal(await main(["--root", root, "--write", guide], sinks), 0);
    assert.match(out.stdout, /inventory region written/);
    const written = fs.readFileSync(guide, "utf8");
    assert.ok(
      written.startsWith("# Guide\r\n\r\n"),
      "text before the region is kept byte-for-byte",
    );
    assert.ok(
      written.endsWith(`${REGION_END}\r\n\r\nAfter.\r\n`),
      "text after the region is kept byte-for-byte",
    );
    assert.ok(
      !/[^\r]\n/.test(written),
      "the region is written in the file's own CRLF style",
    );

    [out, sinks] = io();
    assert.equal(
      await main(["--root", root, "--check", guide], sinks),
      0,
      out.stderr,
    );

    const mutated = written.replace("| 1 | 1 | 0 |", "| 9 | 1 | 0 |");
    assert.notEqual(mutated, written);
    fs.writeFileSync(guide, mutated);
    [out, sinks] = io();
    assert.equal(await main(["--root", root, "--check", guide], sinks), 1);
    assert.match(out.stderr, /^- \| `lib\/alpha\.mjs` .*\| 9 \| 1 \| 0 \|$/m);
    assert.match(out.stderr, /^\+ \| `lib\/alpha\.mjs` .*\| 1 \| 1 \| 0 \|$/m);
  });
});

test("--list-direct prints the direct launchers; a guide without both markers is a usage error", async () => {
  await withFixture(async (root) => {
    let stdout = "";
    let stderr = "";
    const sinks = {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    };
    assert.equal(await main(["--root", root, "--list-direct"], sinks), 0);
    assert.equal(stdout, "probe-fixture-direct.mjs\n");

    const guide = path.join(root, "NO-MARKERS.md");
    fs.writeFileSync(guide, `# Guide\n${REGION_BEGIN}\n`);
    assert.equal(await main(["--root", root, "--check", guide], sinks), 2);
    assert.equal(await main(["--root", root, "--frobnicate"], sinks), 2);
  });
});

test("region helpers: extraction, replacement and the diff respect multiplicity", () => {
  const guide = `a\n${REGION_BEGIN}\nx\ny\n${REGION_END}\nb\n`;
  assert.equal(extractRegion(guide), "x\ny\n");
  assert.equal(extractRegion(`${guide}${REGION_BEGIN}`), null);
  assert.equal(
    replaceRegion(guide, "z\n"),
    `a\n${REGION_BEGIN}\nz\n${REGION_END}\nb\n`,
  );
  assert.deepEqual(regionDiff("x\nx\ny\n", "x\ny\ny\n"), ["- x", "+ y"]);
  assert.deepEqual(regionDiff("x\ny\n", "y\nx\n"), [
    "  (same lines, different order)",
  ]);
  assert.deepEqual(regionDiff("x\ny\n", "x\ny\n"), []);
});
