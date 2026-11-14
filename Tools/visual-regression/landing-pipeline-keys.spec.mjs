// landing-pipeline-keys.spec.mjs - the pipeline-keys reader: the cache's variant keys and counters from the page, and the comparison of two arms' lists.
// @purpose Node spec for lib/landing-pipeline-keys.mjs and its registration as the landing probe's `pipeline-keys` reader: the real page function runs in a node:vm world standing in for the page and lists the cache's names, masked keys and counters (wrongModuleHits included) without any pipeline object; two worlds that differ only in object identities read equal stable keys while one differing define mask reads different names and keys; a page without the cache, without the method or whose method throws reads NOT AVAILABLE naming the seam, never an empty list; the comparison pairs a page with the same page of a base report, lists the keys of one family on one side only, tells a family difference from a difference elsewhere and is NOT MEASURED without a base twin; the real probe on the fake browser records the reader on the WebGPU page, NOT AVAILABLE on the WebGL page, and the receipt's pipelineKeys is null without --base-report and a comparison list with one; with inertness mutants for the masking, the family filter, the counters and the seam answer.
// @status ACTIVE
//
// The fake page never answers the quantity under test: every key and counter a
// case reads is one the case put in the stand-in cache.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as keys from "./lib/landing-pipeline-keys.mjs";
import { notAvailable, parseReaders } from "./lib/landing-page-readers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(here, "lib/landing-pipeline-keys.mjs");

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("pipeline-keys-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

// ---------------------------------------------------------------------------
// The stand-in page
// ---------------------------------------------------------------------------

/** A cache key as the pipeline cache writes it: name first, shader identity last. */
function cacheKey(name, { layout, module, definesHi }) {
  return [
    name,
    "pr:triangle-list/none/ccw//0",
    ...(layout === undefined ? [] : [`pl:${layout}`]),
    `sh:${module}.vertexMain/${module}.fragmentMain`,
    `dfn:0.${definesHi}`,
  ].join("|");
}

/**
 * The page's cache: two ProceduralClouds pipelines and a globe one. `ids`
 * moves the object identities; `definesHi` the second cloud pipeline's mask.
 */
function cacheRows({ ids = 0, definesHi = 196624 } = {}) {
  const cloud = (hi, module, layout) => ({
    name: `ProceduralClouds rgba16float:${hi}`,
    key: cacheKey(`ProceduralClouds rgba16float:${hi}`, {
      layout: layout + ids,
      module: module + ids,
      definesHi: hi,
    }),
  });
  return [
    cloud(196608, 41, 7),
    cloud(definesHi, 42, 8),
    {
      name: "GlobeSurface",
      key: cacheKey("GlobeSurface", { module: 9 + ids, definesHi: 0 }),
    },
  ];
}

function worldWithCache({ rows, wrongModuleHits = 2, throws = false }) {
  return {
    viewer: {
      scene: {
        context: {
          webgpuPipelineCache: {
            listPipelineVariants() {
              if (throws) {
                throw new Error("the cache was destroyed");
              }
              return rows.map((row) => ({
                ...row,
                pipeline: { opaque: true },
                created: 1,
                lastAccessed: 2,
              }));
            },
            getStats() {
              return {
                hits: 10,
                misses: 3,
                created: 3,
                pending: 0,
                size: rows.length,
                hitRate: 0.7,
                evicted: 0,
                wrongModuleHits,
                maxSize: 500,
              };
            },
          },
        },
      },
    },
  };
}

/** The page function of `mod`, run as the page runs it: serialised into a world that holds only `world`. */
async function readIn(mod, world) {
  const run = vm.runInContext(
    `(${String(mod.pageReadPipelineKeys)})`,
    vm.createContext({ ...world }),
  );
  const answer = await run();
  return JSON.parse(JSON.stringify(answer));
}

const recordIn = async (mod, world) =>
  mod.buildPipelineKeysRecord(await readIn(mod, world));

// ---------------------------------------------------------------------------
// Cases 1 to 3: the page function and the record
// ---------------------------------------------------------------------------

/** The rows, the families, the counters and the masked keys. */
async function assertRecord(mod) {
  const world = worldWithCache({ rows: cacheRows() });
  const raw = await readIn(mod, world);
  assert.equal(raw.rows.length, 3);
  assert.ok(
    raw.rows.every((row) => Object.keys(row).sort().join() === "key,name"),
    "no pipeline object and no timestamp leaves the page",
  );
  const record = mod.buildPipelineKeysRecord(raw);
  assert.equal(record.available, true);
  assert.equal(record.count, 3);
  assert.deepEqual(record.families.ProceduralClouds, [
    "ProceduralClouds rgba16float:196608",
    "ProceduralClouds rgba16float:196624",
  ]);
  assert.deepEqual(record.families.GlobeSurface, ["GlobeSurface"]);
  assert.equal(
    record.stats.wrongModuleHits,
    2,
    "the counter is the page's own",
  );
  assert.equal(record.stats.hits, 10);
  assert.equal(record.stats.misses, 3);
  assert.equal(record.stats.pending, 0);
  assert.ok(
    record.stableKeys.some((key) =>
      key.includes("|pl:#|sh:#.vertexMain/#.fragmentMain|"),
    ),
    "the identities are masked",
  );
  assert.ok(
    record.stableKeys.every((key) => !/pl:\d|sh:\d|\/\d+\./.test(key)),
    "no identity digit is left",
  );
  assert.ok(
    record.stableKeys.some((key) => key.includes("dfn:0.196624")),
    "the define mask is kept",
  );
}

test("the page function lists the cache's names, masked keys and counters, wrongModuleHits included, and nothing else", async () => {
  await assertRecord(keys);
});

/** Identities do not matter; a define mask does. */
async function assertStable(mod) {
  const a = await recordIn(mod, worldWithCache({ rows: cacheRows() }));
  const b = await recordIn(
    mod,
    worldWithCache({ rows: cacheRows({ ids: 500 }) }),
  );
  assert.deepEqual(a.stableKeys, b.stableKeys, "only the identities differ");
  assert.deepEqual(a.names, b.names);
  const c = await recordIn(
    mod,
    worldWithCache({ rows: cacheRows({ definesHi: 196640 }) }),
  );
  assert.notDeepEqual(a.names, c.names, "one define mask differs");
  assert.notDeepEqual(a.stableKeys, c.stableKeys);
}

test("two worlds differing only in object identities read equal stable keys, one differing define mask reads different names and keys", async () => {
  await assertStable(keys);
});

/** A page that cannot answer says so, naming the seam. */
async function assertNotAvailable(mod) {
  const none = await recordIn(mod, { viewer: { scene: { context: {} } } });
  assert.deepEqual(
    none,
    notAvailable("viewer.scene.context.webgpuPipelineCache"),
    "the shape equals the readers' own NOT AVAILABLE",
  );
  assert.equal(none.names, undefined, "no empty list stands in for it");
  const noViewer = await recordIn(mod, {});
  assert.equal(noViewer.available, false);
  const noMethod = await recordIn(mod, {
    viewer: { scene: { context: { webgpuPipelineCache: { getStats() {} } } } },
  });
  assert.match(noMethod.reason, /webgpuPipelineCache\.listPipelineVariants/);
  const threw = await recordIn(
    mod,
    worldWithCache({ rows: cacheRows(), throws: true }),
  );
  assert.equal(threw.available, false);
  assert.match(threw.reason, /the cache was destroyed/);
  assert.equal(threw.count, undefined);
  assert.equal(mod.buildPipelineKeysRecord(null).available, false);
}

test("a page without the cache, without the method or whose method throws reads NOT AVAILABLE naming the seam, never an empty list", async () => {
  await assertNotAvailable(keys);
});

// ---------------------------------------------------------------------------
// Case 4: the comparison
// ---------------------------------------------------------------------------

const cloudKey = (hi) => `ProceduralClouds rgba16float:${hi}`;

/** A page record carrying a pipelineKeys record built from names (and optional other names). */
async function page({
  renderer = "webgpu",
  run = 0,
  cloud = [],
  other = [],
  wrong = 0,
}) {
  const rows = [
    ...cloud.map((hi) => ({
      name: cloudKey(hi),
      key: cacheKey(cloudKey(hi), { layout: 1, module: 3, definesHi: hi }),
    })),
    ...other.map((name) => ({
      name,
      key: cacheKey(name, { module: 5, definesHi: 0 }),
    })),
  ];
  return {
    cell: "E-G",
    renderer,
    page: "scene",
    run,
    readers: {
      pipelineKeys: await recordIn(
        keys,
        worldWithCache({ rows, wrongModuleHits: wrong }),
      ),
    },
  };
}

/** Same family, one more tip key, a difference outside the family, no twin. */
async function assertComparisons(mod) {
  const base = await page({ cloud: [196608, 196624], other: ["GlobeSurface"] });
  const same = mod.pipelineKeyComparisons(
    [await page({ cloud: [196608, 196624], other: ["GlobeSurface"] })],
    [base],
  );
  assert.equal(same.length, 1);
  assert.equal(same[0].measured, true);
  assert.equal(same[0].family, "ProceduralClouds");
  assert.equal(same[0].same, true);
  assert.equal(same[0].stableKeysSame, true);
  assert.deepEqual(same[0].onlyTip, []);

  const more = mod.pipelineKeyComparisons(
    [
      await page({
        cloud: [196608, 196624, 196640],
        other: ["GlobeSurface"],
        wrong: 4,
      }),
    ],
    [base],
  );
  assert.equal(more[0].same, false);
  assert.deepEqual(more[0].onlyTip, [cloudKey(196640)]);
  assert.deepEqual(more[0].onlyBase, []);
  assert.equal(more[0].stableKeysSame, false);
  assert.deepEqual(more[0].wrongModuleHits, { base: 0, tip: 4 });

  const elsewhere = mod.pipelineKeyComparisons(
    [await page({ cloud: [196608, 196624], other: ["SkyAtmosphere"] })],
    [base],
  );
  assert.equal(elsewhere[0].same, true, "the cloud family is the same");
  assert.equal(elsewhere[0].stableKeysSame, false, "the whole list is not");

  const twinless = mod.pipelineKeyComparisons(
    [await page({ cloud: [196608], run: 1 })],
    [base],
  );
  assert.equal(twinless[0].measured, false);
  assert.match(twinless[0].reason, /base has no page/);

  const unavailable = mod.pipelineKeyComparisons(
    [{ ...base, readers: { pipelineKeys: notAvailable("seam") } }],
    [base],
  );
  assert.equal(unavailable[0].measured, false);
  assert.match(unavailable[0].reason, /tip: NOT AVAILABLE/);

  // A page that did not run the reader is not a comparison.
  assert.deepEqual(
    mod.pipelineKeyComparisons([{ ...base, readers: undefined }], [base]),
    [],
  );
}

test("the comparison pairs a page with its base twin, lists one family's keys on one side only and is NOT MEASURED without a twin", async () => {
  await assertComparisons(keys);
});

// ---------------------------------------------------------------------------
// Case 5: the probe
// ---------------------------------------------------------------------------

test("parseReaders keeps pipeline-keys in registry order beside cloud-stats", () => {
  assert.deepEqual(parseReaders("pipeline-keys,cloud-stats"), [
    "cloud-stats",
    "pipeline-keys",
  ]);
});

/** A world per page: E-D plans the WebGL page first, which has no WebGPU cache. */
function worldsFor(webgpuRows) {
  let pages = 0;
  return () =>
    pages++ % 2 === 0
      ? { viewer: { scene: { context: {} } } }
      : worldWithCache({ rows: webgpuRows });
}

test("the probe records the reader on the WebGPU page and NOT AVAILABLE on the WebGL page, and the receipt's pipelineKeys is null without a base report and a list with one", async () => {
  const baseRun = await p14Run(
    "keys-base",
    ["--cells", "E-D", "--readers", "pipeline-keys"],
    {
      readerWorld: worldsFor([
        {
          name: cloudKey(196608),
          key: cacheKey(cloudKey(196608), {
            layout: 1,
            module: 3,
            definesHi: 196608,
          }),
        },
      ]),
    },
  );
  assert.equal(
    baseRun.report.pipelineKeys,
    null,
    "no base report, no comparison",
  );
  const webgpu = baseRun.report.pages.find((p) => p.renderer === "webgpu");
  const webgl = baseRun.report.pages.find((p) => p.renderer === "webgl");
  assert.equal(webgpu.readers.pipelineKeys.available, true);
  assert.deepEqual(webgpu.readers.pipelineKeys.families.ProceduralClouds, [
    cloudKey(196608),
  ]);
  assert.equal(webgpu.readers.pipelineKeys.stats.wrongModuleHits, 2);
  assert.equal(webgl.readers.pipelineKeys.available, false);
  assert.match(webgl.readers.pipelineKeys.reason, /NOT AVAILABLE/);

  const baseReport = path.join(
    tempRoot,
    "keys-base",
    "out",
    "landing-cells-report.json",
  );
  assert.ok(fs.existsSync(baseReport));
  const tipRun = await p14Run(
    "keys-tip",
    [
      "--cells",
      "E-D",
      "--readers",
      "pipeline-keys",
      "--base-report",
      baseReport,
    ],
    {
      readerWorld: worldsFor(
        [196608, 196624].map((hi) => ({
          name: cloudKey(hi),
          key: cacheKey(cloudKey(hi), { layout: 1, module: 3, definesHi: hi }),
        })),
      ),
    },
  );
  const list = tipRun.report.pipelineKeys;
  assert.ok(Array.isArray(list), "the receipt carries the comparison list");
  const tipGpu = list.find((entry) => entry.renderer === "webgpu");
  assert.equal(tipGpu.measured, true);
  assert.equal(tipGpu.same, false);
  assert.deepEqual(tipGpu.onlyTip, [cloudKey(196624)]);
  const tipGl = list.find((entry) => entry.renderer === "webgl");
  assert.equal(tipGl.measured, false);
});

// ---------------------------------------------------------------------------
// Inertness
// ---------------------------------------------------------------------------

async function assertRed(behaviour, ...mutations) {
  const mutated = await importMutated(KEYS_FILE, mutations);
  await assert.rejects(
    async () => behaviour(mutated),
    (error) => {
      const at = String(error.stack)
        .split(String.fromCharCode(10))
        .find((line) => line.includes(".spec.mjs"));
      console.log(
        `[mutant red] ${String(error.message).slice(0, 100)} ${String(at).trim()}`,
      );
      return error instanceof assert.AssertionError;
    },
  );
}

test("inertness M5-1: the masking made unreachable turns the record and the stability red", async () => {
  const mutations = [
    [
      "if (/^pl:\\d+$/.test(segment)) {",
      "if (false && /^pl:\\d+$/.test(segment)) {",
    ],
    [
      'if (segment.startsWith("sh:")) {',
      'if (false && segment.startsWith("sh:")) {',
    ],
  ];
  await assertRed(assertRecord, ...mutations);
  await assertRed(assertStable, ...mutations);
});

test("inertness M5-2: the family filter made unreachable (every name compared) turns the comparison red", async () => {
  await assertRed(
    assertComparisons,
    [
      "const baseNames = base.families?.[family] ?? [];",
      "const baseNames = base.names ?? [];",
    ],
    [
      "const tipNames = tip.families?.[family] ?? [];",
      "const tipNames = tip.names ?? [];",
    ],
  );
});

test("inertness M5-3: the counters not copied turns the record red", async () => {
  await assertRed(assertRecord, [
    "stats[field] = raw.stats?.[field] ?? null;",
    "stats[field] = null;",
  ]);
});

test("inertness M5-4: the seam answer made unreachable (a missing cache read as no rows) turns the NOT AVAILABLE cases red", async () => {
  await assertRed(assertNotAvailable, [
    'return { seam: "viewer.scene.context.webgpuPipelineCache" };',
    "return { rows: [], stats: {} };",
  ]);
});
