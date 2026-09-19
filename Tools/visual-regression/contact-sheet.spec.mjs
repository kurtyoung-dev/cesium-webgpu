// Behaviour spec for DX-105 — lib/contact-sheet-page.mjs's pure page model and
// HTML renderer, plus contact-sheet.mjs's thin CLI shell driven entirely
// through injected in-memory dependencies (no disk, no browser).
// @purpose Drive the real sheetModel/renderSheetHtml/sheetIndexEntry and runContactSheet against fixtures, asserting the manifest-validity, no-verdict-token and exit-code-independence output contracts DX-105 owns.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import {
  PAGE_ATTRIBUTE_NAMES,
  PAGE_CHROME_ATTRIBUTES,
  PAGE_CHROME_TEXTS,
  PAGE_CLASS_NAMES,
  PAGE_TAG_NAMES,
  RENDERER_IDS,
  SLOT_IDS,
  VERDICT_TOKENS,
  findVerdictTokens,
  collectClassNames,
  findForeignFigureTokens,
  findForeignPageTokens,
  findUnknownClassNames,
  formatCalendarDate,
  validateManifest,
  validateSheetOptions,
  deriveDateFromGeneratedAt,
  sheetModel,
  renderSheetHtml,
  sheetIndexEntry,
} from "./lib/contact-sheet-page.mjs";
import {
  isRelativePosixPath,
  relativePosixPathViolation,
} from "./lib/relative-path.mjs";
import {
  DEFAULT_OUT_DIR,
  decideContactSheetExit,
  parseContactSheetArgs,
  runContactSheet,
} from "./contact-sheet.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/contact-sheet/manifest-worked-example.json",
    import.meta.url,
  ),
);

function loadWorkedExample() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

// ---------------------------------------------------------------------------
// validateManifest — the §2 hard rules, driven against the real function.
// ---------------------------------------------------------------------------

test("validateManifest: the worked-example fixture is sound", () => {
  assert.deepStrictEqual(validateManifest(loadWorkedExample()), []);
});

test("validateManifest: fails closed on a non-object", () => {
  assert.ok(validateManifest(null).length > 0);
  assert.ok(validateManifest("nope").length > 0);
});

const MANIFEST_VIOLATION_CASES = [
  {
    name: "schemaVersion other than 1",
    mutate: (m) => {
      m.schemaVersion = 2;
    },
    expectSubstring: "schemaVersion",
  },
  {
    name: 'kind other than "capture-manifest"',
    mutate: (m) => {
      m.kind = "something-else";
    },
    expectSubstring: "kind",
  },
  {
    name: "origins.AFTER missing",
    mutate: (m) => {
      delete m.origins.AFTER;
    },
    expectSubstring: "origins",
  },
  {
    name: "servedBuildAssertion outside the vocabulary",
    mutate: (m) => {
      m.servedBuildAssertion = "auto";
    },
    expectSubstring: "servedBuildAssertion",
  },
  {
    name: "a rig carrying a gate field",
    mutate: (m) => {
      m.rigs[1].gate = {
        minChangedFraction: 0.1,
        why: "should never appear here at all",
      };
    },
    expectSubstring: "gate",
  },
  {
    name: "a rig carrying an expectedMismatch field",
    mutate: (m) => {
      m.rigs[1].expectedMismatch = { reason: "no" };
    },
    expectSubstring: "expectedMismatch",
  },
  {
    name: "a MEASURED cell with an absolute image path",
    mutate: (m) => {
      m.rigs[1].cells.webgl.BEFORE.image =
        "/abs/globe-default/webgl/BEFORE.png";
    },
    expectSubstring: "relative POSIX path",
  },
  {
    name: "a MEASURED cell with a backslash image path",
    mutate: (m) => {
      m.rigs[1].cells.webgl.BEFORE.image = "globe-default\\webgl\\BEFORE.png";
    },
    expectSubstring: "relative POSIX path",
  },
  {
    name: "a MEASURED pair.mismatchPct out of [0,100]",
    mutate: (m) => {
      m.rigs[1].pairs.webgl.mismatchPct = 150;
    },
    expectSubstring: "mismatchPct",
  },
  {
    name: "an UNMEASURED cell with a non-null image",
    mutate: (m) => {
      m.rigs[0].cells.webgl.BEFORE.image = "not-null.png";
    },
    expectSubstring: "UNMEASURED cell.image must be null",
  },
  {
    name: "a MEASURED cell.sha256 that is not 64 lowercase hex digits",
    mutate: (m) => {
      m.rigs[1].cells.webgl.BEFORE.sha256 = "not-hex";
    },
    expectSubstring: "sha256",
  },
];

for (const { name, mutate, expectSubstring } of MANIFEST_VIOLATION_CASES) {
  test(`validateManifest: rejects ${name}`, () => {
    const manifest = loadWorkedExample();
    mutate(manifest);
    const violations = validateManifest(manifest);
    assert.ok(violations.length > 0, "expected at least one violation");
    assert.ok(
      violations.some((v) => v.includes(expectSubstring)),
      `expected a violation mentioning "${expectSubstring}", got: ${JSON.stringify(violations)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// validateSheetOptions
// ---------------------------------------------------------------------------

test("validateSheetOptions: a sound option set has no violations", () => {
  assert.deepStrictEqual(
    validateSheetOptions({
      sheetId: "kit-wave-b",
      generatedAt: "2026-09-19T01:24:10.000Z",
    }),
    [],
  );
});

test("validateSheetOptions: rejects a path-unsafe sheetId, a non-ISO generatedAt, and a malformed date", () => {
  assert.ok(
    validateSheetOptions({
      sheetId: "kit/wave",
      generatedAt: "2026-09-19T01:24:10.000Z",
    }).length > 0,
  );
  assert.ok(
    validateSheetOptions({ sheetId: "kit-wave-b", generatedAt: "not-a-date" })
      .length > 0,
  );
  assert.ok(
    validateSheetOptions({
      sheetId: "kit-wave-b",
      generatedAt: "2026-09-19T01:24:10.000Z",
      date: "09-19-2026",
    }).length > 0,
  );
});

// ---------------------------------------------------------------------------
// deriveDateFromGeneratedAt — a pure string slice, no Date object.
// ---------------------------------------------------------------------------

test("deriveDateFromGeneratedAt: slices the ISO date without constructing a Date", () => {
  assert.strictEqual(
    deriveDateFromGeneratedAt("2026-09-19T01:24:10.000Z"),
    "2026-09-19",
  );
});

// ---------------------------------------------------------------------------
// sheetModel — the pure page model.
// ---------------------------------------------------------------------------

test("sheetModel: throws with the violation text on an invalid manifest", () => {
  const manifest = loadWorkedExample();
  manifest.schemaVersion = 99;
  assert.throws(
    () =>
      sheetModel(manifest, {
        sheetId: "x",
        generatedAt: "2026-09-19T00:00:00.000Z",
      }),
    /schemaVersion/,
  );
});

test("sheetModel: throws with the violation text on invalid options", () => {
  assert.throws(
    () =>
      sheetModel(loadWorkedExample(), {
        sheetId: "bad id with spaces",
        generatedAt: "2026-09-19T00:00:00.000Z",
      }),
    /sheetId/,
  );
});

test("sheetModel: derives date, counts cells, and lists every MEASURED image exactly once", () => {
  const model = sheetModel(loadWorkedExample(), {
    sheetId: "kit-wave-b",
    generatedAt: "2026-09-19T01:24:10.000Z",
  });
  assert.strictEqual(model.sheetId, "kit-wave-b");
  assert.strictEqual(model.date, "2026-09-19");
  assert.deepStrictEqual(model.counts, { measured: 4, unmeasured: 4 });
  assert.deepStrictEqual(
    model.imageCopies.slice().sort((a, b) => a.to.localeCompare(b.to)),
    [
      {
        from: "globe-default/webgl/AFTER.png",
        to: "images/globe-default/webgl/AFTER.png",
      },
      {
        from: "globe-default/webgl/BEFORE.png",
        to: "images/globe-default/webgl/BEFORE.png",
      },
      {
        from: "globe-default/webgl/DIFF.png",
        to: "images/globe-default/webgl/DIFF.png",
      },
      {
        from: "globe-default/webgpu/AFTER.png",
        to: "images/globe-default/webgpu/AFTER.png",
      },
      {
        from: "globe-default/webgpu/BEFORE.png",
        to: "images/globe-default/webgpu/BEFORE.png",
      },
      {
        from: "globe-default/webgpu/DIFF.png",
        to: "images/globe-default/webgpu/DIFF.png",
      },
    ],
  );
});

test("sheetModel: rig order is alphabetical by id, never by mismatch magnitude", () => {
  // Alphabetical: [alpha, mu, zeta]. Ascending mismatch: [mu, alpha, zeta].
  // Descending mismatch: [zeta, alpha, mu]. All three disagree, so matching
  // "alphabetical" rules out both mismatch-derived orderings at once.
  const manifest = {
    schemaVersion: 1,
    kind: "capture-manifest",
    generatedAt: "2026-09-19T00:00:00.000Z",
    captureRoot: "fixture/root",
    origins: {
      BEFORE: "http://localhost:9001",
      AFTER: "http://localhost:9002",
    },
    servedBuildAssertion: "enforced",
    receipt: "capture-report.json",
    slots: ["BEFORE", "AFTER"],
    renderers: ["webgl"],
    rigs: ["zeta", "alpha", "mu"].map((id, i) => ({
      id,
      viewport: { width: 2, height: 2 },
      cells: {
        webgl: {
          BEFORE: unmeasuredCell(),
          AFTER: unmeasuredCell(),
        },
      },
      pairs: {
        webgl: {
          state: "MEASURED",
          diffImage: `${id}/webgl/DIFF.png`,
          mismatchPct: [99.9, 50, 0.01][i], // zeta=99.9, alpha=50, mu=0.01
          changedPx: 1,
          bbox: null,
          tolerance: 16,
          metrics: {},
        },
      },
    })),
  };
  const model = sheetModel(manifest, {
    sheetId: "order-check",
    generatedAt: "2026-09-19T00:00:00.000Z",
  });
  assert.deepStrictEqual(
    model.rigs.map((r) => r.id),
    ["alpha", "mu", "zeta"],
  );
});

function unmeasuredCell() {
  return {
    state: "UNMEASURED",
    image: null,
    reason: "fixture cell has no page yet",
    trackedBy: null,
    metrics: null,
  };
}

// ---------------------------------------------------------------------------
// renderSheetHtml — the no-verdict, self-contained, escaped page.
// ---------------------------------------------------------------------------

const WORKED_MODEL = sheetModel(loadWorkedExample(), {
  sheetId: "kit-wave-b",
  generatedAt: "2026-09-19T01:24:10.000Z",
});
const WORKED_HTML = renderSheetHtml(WORKED_MODEL);

test("renderSheetHtml: is a self-contained document with both color schemes and no script/network surface", () => {
  assert.match(WORKED_HTML, /^<!doctype html>/i);
  assert.match(
    WORKED_HTML,
    /<title>kit-wave-b contact sheet — 2026-09-19<\/title>/,
  );
  assert.match(WORKED_HTML, /prefers-color-scheme:\s*dark/);
  assert.doesNotMatch(WORKED_HTML, /<script/i);
  assert.doesNotMatch(WORKED_HTML, /https?:\/\//); // no fetch()/network target of any kind
});

test("renderSheetHtml: carries no verdict token, at every mismatchPct the row names", () => {
  for (const mismatchPct of [0, 0.42, 11.07, 100, null]) {
    const manifest = loadWorkedExample();
    const pair = manifest.rigs[1].pairs.webgpu;
    if (mismatchPct === null) {
      pair.mismatchPct = null;
    } else {
      pair.mismatchPct = mismatchPct;
    }
    const model = sheetModel(manifest, {
      sheetId: "sweep",
      generatedAt: "2026-09-19T00:00:00.000Z",
    });
    const html = renderSheetHtml(model);
    assert.deepStrictEqual(
      findVerdictTokens(html),
      [],
      `mismatchPct=${mismatchPct} introduced a verdict token`,
    );
  }
});

test("findVerdictTokens: word tokens match at boundaries (no false positive on organic English), glyphs match as substrings", () => {
  assert.deepStrictEqual(
    findVerdictTokens("the camera flies past a compass, then a bypass"),
    [],
  );
  assert.deepStrictEqual(findVerdictTokens("a bookmark near the workbook"), []);
  assert.deepStrictEqual(findVerdictTokens("status: OK"), ["OK"]);
  assert.deepStrictEqual(findVerdictTokens("PASS"), ["PASS"]);
  assert.deepStrictEqual(findVerdictTokens("looks great ✅"), ["✅"]);
  assert.ok(VERDICT_TOKENS.includes("REGRESSION"));
});

test("renderSheetHtml: every rig id, description and reason is HTML-escaped", () => {
  const manifest = loadWorkedExample();
  manifest.rigs[0].id = "smoke<script>alert(1)</script>rig";
  manifest.rigs[0].description = 'desc <b>bold</b> & "quoted"';
  manifest.rigs[0].pairs.webgl.reason = "<img src=x onerror=alert(1)>";
  const model = sheetModel(manifest, {
    sheetId: "escape-check",
    generatedAt: "2026-09-19T00:00:00.000Z",
  });
  const html = renderSheetHtml(model);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("renderSheetHtml: an UNMEASURED rig renders placeholders, never an <img>, and is not a failure", () => {
  const manifest = loadWorkedExample();
  const model = sheetModel(manifest, {
    sheetId: "unmeasured-check",
    generatedAt: "2026-09-19T00:00:00.000Z",
  });
  const html = renderSheetHtml(model);
  const auroraSection = html.slice(
    html.indexOf('id="rig-aurora-orbit-limb"'),
    html.indexOf('id="rig-globe-default"'),
  );
  assert.doesNotMatch(auroraSection, /<img/);
  assert.match(auroraSection, /class="cell cell-unmeasured"/);
  assert.match(auroraSection, /class="pair pair-unmeasured"/);
  assert.match(auroraSection, />unmeasured</);
  assert.deepStrictEqual(findVerdictTokens(auroraSection), []);
});

test("renderSheetHtml: every cell and pair figure links the manifest's receipt (keyboard-reachable, file:// safe)", () => {
  const receiptHrefCount = (
    WORKED_HTML.match(/href="capture-report\.json"/g) ?? []
  ).length;
  const expected = WORKED_MODEL.rigs.reduce(
    (sum, rig) =>
      sum +
      rig.renderers.reduce(
        (inner, r) => inner + Object.keys(r.cells).length + (r.pair ? 1 : 0),
        0,
      ),
    0,
  );
  assert.strictEqual(expected, 2 * 2 * (SLOT_IDS.length + 1)); // sanity: 12
  assert.strictEqual(receiptHrefCount, expected);
});

// ---------------------------------------------------------------------------
// sheetIndexEntry
// ---------------------------------------------------------------------------

test("sheetIndexEntry: matches the contract §3.1 shape and computes byteLength from the given html", () => {
  const entry = sheetIndexEntry(WORKED_MODEL, {
    html: WORKED_HTML,
    path: "Tools/visual-regression/output/contact-sheets/2026-09-19/kit-wave-b/index.html",
    md5: "deadbeef00112233445566778899aabb",
  });
  assert.deepStrictEqual(entry, {
    schemaVersion: 1,
    kind: "contact-sheet-index-entry",
    sheetId: "kit-wave-b",
    date: "2026-09-19",
    path: "Tools/visual-regression/output/contact-sheets/2026-09-19/kit-wave-b/index.html",
    md5: "deadbeef00112233445566778899aabb",
    byteLength: Buffer.byteLength(WORKED_HTML, "utf8"),
    rigIds: ["aurora-orbit-limb", "globe-default"],
    renderers: ["webgl", "webgpu"],
    slots: ["BEFORE", "AFTER"],
    cells: { measured: 4, unmeasured: 4 },
    manifest: "capture-manifest.json",
    generatedAt: "2026-09-19T01:24:10.000Z",
  });
});

// ---------------------------------------------------------------------------
// contact-sheet.mjs — parseContactSheetArgs
// ---------------------------------------------------------------------------

test("parseContactSheetArgs: required flags, and out-dir defaults to the gitignored output root", () => {
  const parsed = parseContactSheetArgs([
    "--manifest",
    "m.json",
    "--sheet-id",
    "kit-wave-b",
  ]);
  assert.strictEqual(parsed.argumentError, null);
  assert.strictEqual(parsed.manifestPath, "m.json");
  assert.strictEqual(parsed.sheetId, "kit-wave-b");
  assert.strictEqual(parsed.outDir, DEFAULT_OUT_DIR);
});

test("parseContactSheetArgs: reports a missing --manifest or --sheet-id", () => {
  assert.match(
    parseContactSheetArgs(["--sheet-id", "x"]).argumentError,
    /--manifest/,
  );
  assert.match(
    parseContactSheetArgs(["--manifest", "m.json"]).argumentError,
    /--sheet-id/,
  );
});

// ---------------------------------------------------------------------------
// runContactSheet — the CLI shell, driven end-to-end over an in-memory fake
// filesystem built from fixture PNGs encoded in memory with the shared
// Tools/lib PNG helper (no browser, no disk).
// ---------------------------------------------------------------------------

function makeFakePng(seedByte) {
  const pixels = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = seedByte;
    pixels[i + 1] = seedByte;
    pixels[i + 2] = seedByte;
    pixels[i + 3] = 255;
  }
  return Buffer.from(encodeRgbaPng(pixels, 2, 2));
}

function makeFakeFs(initialFiles) {
  const store = new Map(Object.entries(initialFiles));
  const dirsCreated = new Set();
  return {
    store,
    dirsCreated,
    readFile: async (filePath) => {
      if (!store.has(filePath)) {
        const error = new Error(`ENOENT, no such fake file: ${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
      const value = store.get(filePath);
      return typeof value === "string" ? value : value.toString("utf8");
    },
    writeFile: async (filePath, data) => {
      store.set(filePath, data);
    },
    mkdir: async (dirPath) => {
      dirsCreated.add(dirPath);
    },
    copyFile: async (from, to) => {
      if (!store.has(from)) {
        const error = new Error(`ENOENT, no such fake file: ${from}`);
        error.code = "ENOENT";
        throw error;
      }
      store.set(to, store.get(from));
    },
    clock: () => dateLike("2026-09-19T02:05:00.000Z", [2026, 9, 19]),
  };
}

/**
 * A `Date`-shaped clock whose ISO instant and LOCAL calendar date are stated
 * SEPARATELY.
 *
 * A real `Date` would make every date assertion in this file depend on the
 * machine's timezone — `new Date("2026-09-19T02:05:00.000Z")` is the 19th in
 * UTC and the 18th in New York — and a spec whose expected value changes with
 * `TZ` is a spec that passes for the wrong reason somewhere. Only the three
 * local getters and `toISOString` are read by the tool, so stating both halves
 * is both sufficient and deterministic, and it is what lets the case below
 * assert WHICH of the two the tool used.
 *
 * @param {string} iso What `toISOString()` returns.
 * @param {[number, number, number]} local The local `[year, month, day]`, with
 *   the month 1-based as a human writes it.
 * @returns {object} The clock reading.
 */
function dateLike(iso, [year, month, day]) {
  return {
    toISOString: () => iso,
    getFullYear: () => year,
    getMonth: () => month - 1,
    getDate: () => day,
  };
}

function buildSweepManifest({
  sheetId,
  mismatchPct,
  changedPx = 3,
  tolerance = 16,
  mssim = 0.9,
  rawByteLumaMean = 10,
  nonBlackFraction = 0.5,
}) {
  const rigId = "smoke-rig";
  const cell = (slot, seed) => ({
    state: "MEASURED",
    image: `${rigId}/webgl/${slot}.png`,
    width: 2,
    height: 2,
    byteLength: 0, // not asserted; DX-105 never decodes or measures the copied bytes
    sha256: createHash("sha256")
      .update(`${sheetId}-${slot}-${seed}`)
      .digest("hex"),
    url: `http://localhost:900${slot === "BEFORE" ? 1 : 2}/page.html`,
    capturedAt: "2026-09-19T02:00:01.000Z",
    metrics: {
      rawByteLumaMean,
      nonBlackFraction,
      provenance: "display-bytes; descriptive only, not photometric evidence",
    },
  });
  const pair =
    mismatchPct === null
      ? {
          state: "UNMEASURED",
          diffImage: null,
          mismatchPct: null,
          changedPx: null,
          bbox: null,
          tolerance: null,
          metrics: null,
          reason: "fixture: AFTER is UNMEASURED",
        }
      : {
          state: "MEASURED",
          diffImage: `${rigId}/webgl/DIFF.png`,
          mismatchPct,
          changedPx,
          bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
          tolerance,
          metrics: { mssim, windows: 4 },
        };
  return {
    schemaVersion: 1,
    kind: "capture-manifest",
    generatedAt: "2026-09-19T02:00:00.000Z",
    captureRoot: "fake/capture-root",
    origins: {
      BEFORE: "http://localhost:9001",
      AFTER: "http://localhost:9002",
    },
    servedBuildAssertion: "enforced",
    receipt: "capture-report.json",
    slots: ["BEFORE", "AFTER"],
    renderers: ["webgl"],
    rigs: [
      {
        id: rigId,
        replayKey: "deadbeef",
        description: "a tiny in-memory fixture rig",
        viewport: { width: 2, height: 2 },
        cells: {
          webgl: { BEFORE: cell("BEFORE", "b"), AFTER: cell("AFTER", "a") },
        },
        pairs: { webgl: pair },
      },
    ],
  };
}

function populateFakeCapture(fakeFs, manifest, { withDiff }) {
  fakeFs.store.set(
    "fake/capture-root/capture-manifest.json",
    JSON.stringify(manifest),
  );
  fakeFs.store.set(
    "fake/capture-root/capture-report.json",
    JSON.stringify({ ok: "n/a — see manifest" }),
  );
  fakeFs.store.set(
    "fake/capture-root/smoke-rig/webgl/BEFORE.png",
    makeFakePng(10),
  );
  fakeFs.store.set(
    "fake/capture-root/smoke-rig/webgl/AFTER.png",
    makeFakePng(20),
  );
  if (withDiff) {
    fakeFs.store.set(
      "fake/capture-root/smoke-rig/webgl/DIFF.png",
      makeFakePng(255),
    );
  }
}

test("runContactSheet: writes the full sheet directory, copies image bytes verbatim, and the banked md5 matches the written html", async () => {
  const manifest = buildSweepManifest({
    sheetId: "kit-test",
    mismatchPct: 11.07,
  });
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });

  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "kit-test",
    ],
    fakeFs,
  );

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.error, null);

  const sheetDir = `${DEFAULT_OUT_DIR}/2026-09-19/kit-test`;
  const expectedPaths = [
    `${sheetDir}/images/smoke-rig/webgl/BEFORE.png`,
    `${sheetDir}/images/smoke-rig/webgl/AFTER.png`,
    `${sheetDir}/images/smoke-rig/webgl/DIFF.png`,
    `${sheetDir}/capture-manifest.json`,
    `${sheetDir}/capture-report.json`,
    `${sheetDir}/index.html`,
    `${sheetDir}/sheet-index.json`,
  ];
  for (const path of expectedPaths) {
    assert.ok(fakeFs.store.has(path), `expected ${path} to have been written`);
    assert.ok(
      result.writtenPaths.includes(path),
      `expected writtenPaths to include ${path}`,
    );
  }

  // Copied image bytes are byte-identical to the source (a plain copy, no
  // decode, no re-encode — DX-105 never touches PNG pixels).
  assert.ok(
    fakeFs.store
      .get(`${sheetDir}/images/smoke-rig/webgl/BEFORE.png`)
      .equals(fakeFs.store.get("fake/capture-root/smoke-rig/webgl/BEFORE.png")),
  );
  assert.ok(
    fakeFs.store
      .get(`${sheetDir}/images/smoke-rig/webgl/DIFF.png`)
      .equals(fakeFs.store.get("fake/capture-root/smoke-rig/webgl/DIFF.png")),
  );

  const html = fakeFs.store.get(`${sheetDir}/index.html`);
  assert.deepStrictEqual(findVerdictTokens(html), []);
  const expectedMd5 = createHash("md5").update(html, "utf8").digest("hex");

  const entry = JSON.parse(fakeFs.store.get(`${sheetDir}/sheet-index.json`));
  assert.strictEqual(entry.schemaVersion, 1);
  assert.strictEqual(entry.kind, "contact-sheet-index-entry");
  assert.strictEqual(entry.sheetId, "kit-test");
  assert.strictEqual(entry.date, "2026-09-19");
  assert.strictEqual(entry.path, `${sheetDir}/index.html`);
  assert.strictEqual(entry.md5, expectedMd5);
  assert.strictEqual(entry.byteLength, Buffer.byteLength(html, "utf8"));
  assert.deepStrictEqual(entry.rigIds, ["smoke-rig"]);
  assert.deepStrictEqual(entry.cells, { measured: 2, unmeasured: 0 });
  assert.strictEqual(entry.manifest, "capture-manifest.json");
});

test("runContactSheet: exit code is independent of every mismatch value the row names (0, 0.42, 11.07, 100, null)", async () => {
  const exitCodes = [];
  for (const mismatchPct of [0, 0.42, 11.07, 100, null]) {
    const sheetId = `sweep-${String(mismatchPct)}`;
    const manifest = buildSweepManifest({ sheetId, mismatchPct });
    const fakeFs = makeFakeFs({});
    populateFakeCapture(fakeFs, manifest, { withDiff: mismatchPct !== null });
    const result = await runContactSheet(
      [
        "--manifest",
        "fake/capture-root/capture-manifest.json",
        "--sheet-id",
        sheetId,
      ],
      fakeFs,
    );
    exitCodes.push(result.exitCode);
  }
  assert.deepStrictEqual(exitCodes, [0, 0, 0, 0, 0]);
  assert.strictEqual(
    new Set(exitCodes).size,
    1,
    "exit code must be identical across the whole mismatch sweep",
  );
});

test("runContactSheet: a missing manifest file is a defined failure, not a crash", async () => {
  const fakeFs = makeFakeFs({});
  const result = await runContactSheet(
    ["--manifest", "fake/does-not-exist.json", "--sheet-id", "kit-test"],
    fakeFs,
  );
  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /could not read manifest/);
  assert.deepStrictEqual(result.writtenPaths, []);
});

test("runContactSheet: a missing --sheet-id is a defined argument failure", async () => {
  const fakeFs = makeFakeFs({ "m.json": "{}" });
  const result = await runContactSheet(["--manifest", "m.json"], fakeFs);
  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /--sheet-id/);
});

test("RENDERER_IDS / SLOT_IDS are the two-entry vocabularies the manifest shape assumes", () => {
  assert.deepStrictEqual(RENDERER_IDS, ["webgl", "webgpu"]);
  assert.deepStrictEqual(SLOT_IDS, ["BEFORE", "AFTER"]);
});

test("runContactSheet: a Windows-separator --manifest still resolves its images against the manifest's own directory", async () => {
  // A real Win32 filesystem accepts either separator, so the double does too;
  // what is under test is which DIRECTORY the copies are sourced from. Taking
  // a POSIX dirname of a backslash path yields ".", which would silently
  // resolve a manifest's images against the working directory instead.
  const manifest = buildSweepManifest({ sheetId: "win-path", mismatchPct: 0 });
  const posix = makeFakeFs({});
  populateFakeCapture(posix, manifest, { withDiff: true });
  const eitherSeparator = {
    ...posix,
    readFile: (filePath) =>
      posix.readFile(String(filePath).split("\\").join("/")),
    copyFile: (from, to) =>
      posix.copyFile(String(from).split("\\").join("/"), to),
  };

  const result = await runContactSheet(
    [
      "--manifest",
      String.raw`fake\capture-root\capture-manifest.json`,
      "--sheet-id",
      "win-path",
      "--out-dir",
      String.raw`out\sheets`,
    ],
    eitherSeparator,
  );

  assert.strictEqual(result.error, null);
  assert.strictEqual(result.exitCode, 0);

  const sheetDir = "out/sheets/2026-09-19/win-path";
  assert.ok(
    posix.store
      .get(`${sheetDir}/images/smoke-rig/webgl/BEFORE.png`)
      ?.equals(posix.store.get("fake/capture-root/smoke-rig/webgl/BEFORE.png")),
    "the copied bytes came from the manifest's own directory",
  );
  for (const written of result.writtenPaths) {
    assert.ok(
      !written.includes("\\"),
      `every written path stays POSIX: ${written}`,
    );
  }
  const entry = JSON.parse(posix.store.get(`${sheetDir}/sheet-index.json`));
  assert.strictEqual(entry.path, `${sheetDir}/index.html`);
});

// ---------------------------------------------------------------------------
// The two acceptances the row is NAMED for, asserted as invariants rather than
// as samples. A five-point sweep and a twelve-word text allowlist each leave a
// one-line change that reintroduces a verdict and survives: a threshold inside
// the band the sweep skips, and a judgement spelled as a class name instead of
// as a word. Both are reproduced below, and both red the moment they return.
// ---------------------------------------------------------------------------

/**
 * `mismatch 11.07%` -> `mismatch <value>%`, so only the NUMBER may differ.
 *
 * THE PATTERN MATCHES THE NUMERAL, NEVER "EVERYTHING UP TO THE NEXT `<`".
 * `mismatch [^<]*` blanks the whole remainder of the text node, and that
 * remainder is exactly where a judgement fits: `mismatch 11.07% degraded` and
 * `mismatch 0.42% clean` normalise to the same bytes, so the invariance
 * assertion below — the guard that is supposed to see a judgement by ANY
 * spelling — could not see it at all. The verifier's `MUT-3` (a word) and
 * `MUT-6` (a glyph) are that mutation, and both survived the loose form with
 * `findVerdictTokens` and `findUnknownClassNames` reporting clean.
 */
const METRIC_NUMERAL_LABELS = Object.freeze([
  ["mismatch", "%"],
  ["changed px", ""],
  ["tolerance", ""],
  ["structure similarity", ""],
  ["mean luma", ""],
  ["non-black fraction", ""],
]);

function normaliseMismatchNumerals(html) {
  let out = html;
  for (const [label, unit] of METRIC_NUMERAL_LABELS) {
    out = out.replaceAll(
      new RegExp(`${label} (?:n/a|null|-?\\d+(?:\\.\\d+)?)${unit}`, "g"),
      `${label} <value>${unit}`,
    );
  }
  return out;
}

test("renderSheetHtml: a MEASURED pair's markup is IDENTICAL across the whole mismatch range once the numeral is normalised", () => {
  const values = [0, 0.42, 4.999, 5, 7.5, 10.999, 11.07, 50, 99.999, 100];
  const rendered = values.map((mismatchPct) =>
    renderSheetHtml(
      sheetModel(buildSweepManifest({ sheetId: "invariance", mismatchPct }), {
        sheetId: "invariance",
        generatedAt: "2026-09-19T02:05:00.000Z",
      }),
    ),
  );

  const normalised = rendered.map(normaliseMismatchNumerals);
  for (let index = 1; index < normalised.length; index += 1) {
    assert.strictEqual(
      normalised[index],
      normalised[0],
      `the page at mismatch ${values[index]} differs from the page at ${values[0]} by more than the number itself`,
    );
  }

  // And the normaliser is not hiding the number: the un-normalised pages DO
  // differ, so the assertion above is about markup, not about a blanked page.
  assert.notStrictEqual(rendered[0], rendered[rendered.length - 1]);
});

// EVERY measured value, not only `mismatchPct`. The sweep above holds
// `changedPx`, `tolerance`, `mssim`, `rawByteLumaMean` and
// `nonBlackFraction` FIXED, so a judgement keyed to one of those — in a
// caption the model itself produces, which is the one case
// `findForeignFigureTokens` documents as outside its reach — never moved the
// page and survived all 56 tests. `structure similarity 0.8000 degraded`
// against `structure similarity 0.9900 clean` is that mutant.
test("renderSheetHtml: the markup is IDENTICAL across EVERY measured value once the numerals are normalised", () => {
  const AXES = {
    mismatchPct: [0, 3.21, 100],
    changedPx: [0, 3, 4096],
    tolerance: [0, 16, 255],
    mssim: [0, 0.9, 1],
    rawByteLumaMean: [0, 10, 255],
    nonBlackFraction: [0, 0.5, 1],
  };
  const render = (overrides) =>
    normaliseMismatchNumerals(
      renderSheetHtml(
        sheetModel(
          buildSweepManifest({
            sheetId: "axes",
            mismatchPct: 3.21,
            ...overrides,
          }),
          { sheetId: "axes", generatedAt: "2026-09-19T02:05:00.000Z" },
        ),
      ),
    );
  const baseline = render({});
  for (const [axis, values] of Object.entries(AXES)) {
    for (const value of values) {
      assert.strictEqual(
        render({ [axis]: value }),
        baseline,
        `the page at ${axis}=${value} differs from the baseline by more than the number itself`,
      );
    }
  }
  // The normaliser is not blanking the page: un-normalised, the extremes differ.
  assert.notStrictEqual(
    renderSheetHtml(
      sheetModel(
        buildSweepManifest({ sheetId: "axes", mismatchPct: 3.21, mssim: 0 }),
        {
          sheetId: "axes",
          generatedAt: "2026-09-19T02:05:00.000Z",
        },
      ),
    ),
    renderSheetHtml(
      sheetModel(
        buildSweepManifest({ sheetId: "axes", mismatchPct: 3.21, mssim: 1 }),
        {
          sheetId: "axes",
          generatedAt: "2026-09-19T02:05:00.000Z",
        },
      ),
    ),
  );
});

test("renderSheetHtml: every class token is drawn from the page's closed vocabulary, at every mismatch value", () => {
  assert.deepStrictEqual(findUnknownClassNames(WORKED_HTML), []);
  for (const mismatchPct of [0, 0.42, 5.5, 11.07, 100, null]) {
    const html = renderSheetHtml(
      sheetModel(buildSweepManifest({ sheetId: "vocabulary", mismatchPct }), {
        sheetId: "vocabulary",
        generatedAt: "2026-09-19T02:05:00.000Z",
      }),
    );
    assert.deepStrictEqual(
      findUnknownClassNames(html),
      [],
      `an unknown class token appeared at mismatch ${String(mismatchPct)}`,
    );
  }
  // The guard can actually see one: a judgement class is not in the list.
  assert.deepStrictEqual(
    findUnknownClassNames('<figure class="pair pair-measured pair-bad">'),
    ["pair-bad"],
  );
  assert.ok(collectClassNames(WORKED_HTML).length > 0);
});

test("runContactSheet: the exit code is 0 across 101 evenly spaced mismatch values, including the bands a five-point sweep skips", async () => {
  const values = [];
  for (let step = 0; step <= 100; step += 1) {
    values.push(step);
  }
  values.push(0.42, 5.001, 7.5, 10.999, 11.07, null);

  const exitCodes = new Set();
  for (const mismatchPct of values) {
    const sheetId = "dense-sweep";
    const manifest = buildSweepManifest({ sheetId, mismatchPct });
    const fakeFs = makeFakeFs({});
    populateFakeCapture(fakeFs, manifest, { withDiff: mismatchPct !== null });
    const result = await runContactSheet(
      [
        "--manifest",
        "fake/capture-root/capture-manifest.json",
        "--sheet-id",
        sheetId,
      ],
      fakeFs,
    );
    exitCodes.add(result.exitCode);
  }

  assert.deepStrictEqual(
    [...exitCodes],
    [0],
    "one exit code for every mismatch value there is",
  );
});

test("sheetModel: rig order and rigIds are code-unit order, never the runtime's collation", () => {
  // `localeCompare` reads the runtime's default locale: en and sv disagree on
  // where "a-umlaut" sorts, so a locale-ordered page renders to different
  // bytes — and a different banked md5 — on two machines. The order below is
  // the code-unit one, which every machine agrees on.
  const base = buildSweepManifest({ sheetId: "collation", mismatchPct: 1 });
  const rig = base.rigs[0];
  base.rigs = ["globe-zulu", "globe-ätna", "globe-aurora"].map((id) => ({
    ...structuredClone(rig),
    id,
  }));

  const model = sheetModel(base, {
    sheetId: "collation",
    generatedAt: "2026-09-19T02:05:00.000Z",
  });
  assert.deepStrictEqual(
    model.rigs.map((one) => one.id),
    ["globe-aurora", "globe-zulu", "globe-ätna"],
  );
  assert.deepStrictEqual(
    sheetIndexEntry(model, {
      html: "x",
      path: "p/index.html",
      md5: "a".repeat(32),
    }).rigIds,
    ["globe-aurora", "globe-zulu", "globe-ätna"],
  );
  assert.strictEqual(
    ["globe-zulu", "globe-ätna", "globe-aurora"].sort((a, b) =>
      a.localeCompare(b),
    )[2],
    "globe-zulu",
    "the collation order really is different — otherwise this case proves nothing",
  );
});

// ---------------------------------------------------------------------------
// Path relativity: the sheet directory must stay self-contained and movable.
// ---------------------------------------------------------------------------

test("validateManifest: a `..` segment is refused in an image path, a diff path and the receipt", () => {
  const escapes = [
    {
      name: "a cell image climbing out of the sheet",
      mutate: (m) => {
        m.rigs[1].cells.webgl.BEFORE.image = "../../../ESCAPED/stolen.png";
      },
    },
    {
      name: "a diff image climbing out of the sheet",
      mutate: (m) => {
        m.rigs[1].pairs.webgl.diffImage = "../../../ESCAPED/DIFF.png";
      },
    },
    {
      name: "a receipt climbing out of the sheet",
      mutate: (m) => {
        m.receipt = "../../../ESCAPED/receipt.json";
      },
    },
    {
      name: "an absolute receipt",
      mutate: (m) => {
        m.receipt = "/etc/passwd";
      },
    },
  ];
  for (const escape of escapes) {
    const manifest = loadWorkedExample();
    escape.mutate(manifest);
    assert.ok(
      validateManifest(manifest).length > 0,
      `${escape.name}: expected a violation, got none`,
    );
  }
});

test("runContactSheet: a traversing manifest writes NOTHING and reports it, instead of copying files outside --out-dir", async () => {
  const manifest = buildSweepManifest({ sheetId: "escape", mismatchPct: 1 });
  manifest.rigs[0].cells.webgl.BEFORE.image = "../../ESCAPED/stolen.png";
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });
  const before = new Set(fakeFs.store.keys());

  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "escape",
      "--out-dir",
      "out/sheets",
    ],
    fakeFs,
  );

  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /relative POSIX path/);
  assert.deepStrictEqual(result.writtenPaths, []);
  assert.deepStrictEqual(
    [...fakeFs.store.keys()].filter((key) => !before.has(key)),
    [],
    "not one byte was written anywhere",
  );
});

test("runContactSheet: an I/O failure mid-write is the tool's own exit 1, not an unhandled rejection", async () => {
  const manifest = buildSweepManifest({ sheetId: "io-fail", mismatchPct: 1 });
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });
  // The manifest is sound; the image it names is simply not there.
  fakeFs.store.delete("fake/capture-root/smoke-rig/webgl/AFTER.png");

  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "io-fail",
    ],
    fakeFs,
  );

  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /could not write the sheet/);
  assert.match(result.error, /AFTER\.png/);
});

// ---------------------------------------------------------------------------
// v3 — the guard is STRUCTURAL, not a longer word list
//
// A word list refuses the words someone thought of; a mismatch sweep whose
// normaliser blanks a whole text node cannot see what is in it. The verifier
// put a judgement in plain English immediately after the numeral, inside the
// caption's own span, and all ninety of this lane's tests stayed green with
// `findVerdictTokens` and `findUnknownClassNames` both reporting clean. The
// remedy is to invert the question: every text node and every attribute value
// inside a figure must be one the page MODEL produced, so an extra token is a
// violation by construction whatever it spells. The word lists stay as the
// second line of defence.
// ---------------------------------------------------------------------------

function sweepPage(mismatchPct, sheetId = "structural") {
  const model = sheetModel(buildSweepManifest({ sheetId, mismatchPct }), {
    sheetId,
    generatedAt: "2026-09-19T02:05:00.000Z",
  });
  return { model, html: renderSheetHtml(model) };
}

test("findForeignFigureTokens: the worked example and every mismatch value render only what the model produced", () => {
  assert.deepStrictEqual(
    findForeignFigureTokens(WORKED_HTML, WORKED_MODEL),
    [],
  );
  for (const mismatchPct of [0, 0.42, 5.5, 11.07, 100, null]) {
    const { model, html } = sweepPage(mismatchPct);
    assert.deepStrictEqual(
      findForeignFigureTokens(html, model),
      [],
      `a foreign token appeared at mismatch ${String(mismatchPct)}`,
    );
  }
});

test("findForeignFigureTokens: a judgement WORD after the numeral is a violation — the case both word lists are blind to", () => {
  const clean = sweepPage(0.42, "verdict-word");
  const bad = sweepPage(11.07, "verdict-word");
  const judged = bad.html.replaceAll(
    /mismatch (\d+\.\d+)%/g,
    "mismatch $1% degraded",
  );

  // The demonstration first: the two v2 guards report the page as clean.
  assert.deepStrictEqual(findVerdictTokens(judged), []);
  assert.deepStrictEqual(findUnknownClassNames(judged), []);

  // The structural guard names it, in the figure it sits in.
  const violations = findForeignFigureTokens(judged, bad.model);
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0], /mismatch 11\.07% degraded/);
  assert.match(violations[0], /not one the page model produced/);

  // And with the numeral normaliser fixed, the invariance assertion sees it
  // too: the judged page no longer normalises to the clean page's bytes.
  assert.notStrictEqual(
    normaliseMismatchNumerals(judged),
    normaliseMismatchNumerals(clean.html),
  );
  // The control: WITHOUT the judgement the two pages are byte-identical once
  // normalised, so the assertion above is about the word, not about the value.
  assert.strictEqual(
    normaliseMismatchNumerals(bad.html),
    normaliseMismatchNumerals(clean.html),
  );
});

test("findForeignFigureTokens: a glyph, a title, an inline style, a data- attribute, an extra span and a foreign class are each a violation", () => {
  const { model, html } = sweepPage(11.07, "extra-tokens");
  const cases = [
    {
      name: "a glyph after the numeral",
      mutate: (page) =>
        page.replaceAll(/mismatch (\d+\.\d+)%/g, "mismatch $1% \u26a0"),
      expect:
        /the text "mismatch 11\.07% \u26a0" is not one the page model produced/,
    },
    {
      name: "a title attribute",
      mutate: (page) =>
        page.replace(
          '<figure class="pair pair-measured">',
          '<figure class="pair pair-measured" title="worse than before">',
        ),
      expect:
        /the attribute title="worse than before" is not one a figure may carry/,
    },
    {
      name: "an inline style colour",
      mutate: (page) =>
        page.replace(
          '<figure class="pair pair-measured">',
          '<figure class="pair pair-measured" style="border-color:#c00">',
        ),
      expect: /the attribute style="border-color:#c00"/,
    },
    {
      name: "a data- attribute carrying the rank",
      mutate: (page) =>
        page.replace(
          '<figure class="pair pair-measured">',
          '<figure class="pair pair-measured" data-rank="3">',
        ),
      expect: /the attribute data-rank="3"/,
    },
    {
      name: "an extra span of its own",
      mutate: (page) =>
        page.replace(
          "</figcaption>\n</figure>",
          '<span class="metric">degraded</span>\n  </figcaption>\n</figure>',
        ),
      expect: /the text "degraded" is not one the page model produced/,
    },
    {
      name: "a foreign class token",
      mutate: (page) =>
        page.replace(
          '<figure class="pair pair-measured">',
          '<figure class="pair pair-measured pair-bad">',
        ),
      expect: /the class "pair-bad" is not in the page's vocabulary/,
    },
    {
      name: "an unquoted attribute the page's own tokenizer cannot read",
      mutate: (page) =>
        page.replace(
          '<figure class="pair pair-measured">',
          "<figure class=pair-bad>",
        ),
      expect: /unparsed markup in a text node/,
    },
  ];

  for (const { name, mutate, expect } of cases) {
    const violations = findForeignFigureTokens(mutate(html), model);
    assert.ok(violations.length > 0, `${name} was not reported at all`);
    assert.ok(
      violations.some((violation) => expect.test(violation)),
      `${name} was not reported by name: ${violations.join(" | ")}`,
    );
  }
});

test("findForeignFigureTokens: a removed or duplicated figure is itself a violation", () => {
  const { model, html } = sweepPage(1, "figure-count");
  const pair = html.match(/<figure class="pair[\s\S]*?<\/figure>/)[0];
  assert.match(
    findForeignFigureTokens(html.replace(pair, ""), model).join(" | "),
    /the page renders 2 figures; the model describes 3/,
  );
  assert.match(
    findForeignFigureTokens(html.replace(pair, `${pair}\n${pair}`), model).join(
      " | ",
    ),
    /the page renders 4 figures; the model describes 3/,
  );
});

// ---------------------------------------------------------------------------
// v3 — the exit code is independent of the measurement STRUCTURALLY
//
// A sweep is a sample, and the verifier's surviving mutant was a threshold in
// a band narrower than the sampling gap (`0.1 < worst < 0.4` survived 101
// evenly spaced values). Two assertions replace it: a 2,001-value sweep that
// closes every band wider than 0.05, and — the one no sampling density can
// substitute for — the record the decision is computed from.
// ---------------------------------------------------------------------------

test("runContactSheet: the exit code is 0 across the whole [0,100] range in steps of 0.05, plus the boundaries and null", async () => {
  const values = [];
  for (let step = 0; step <= 2000; step += 1) {
    values.push(Number((step * 0.05).toFixed(2)));
  }
  values.push(null, 0.0001, 0.1, 0.10001, 0.2, 0.39999, 0.4, 99.9999, 100);

  const exitCodes = new Set();
  const sheetId = "very-dense-sweep";
  for (const mismatchPct of values) {
    const manifest = buildSweepManifest({ sheetId, mismatchPct });
    const fakeFs = makeFakeFs({});
    populateFakeCapture(fakeFs, manifest, { withDiff: mismatchPct !== null });
    const result = await runContactSheet(
      [
        "--manifest",
        "fake/capture-root/capture-manifest.json",
        "--sheet-id",
        sheetId,
      ],
      fakeFs,
    );
    exitCodes.add(result.exitCode);
  }

  assert.strictEqual(values.length, 2010);
  assert.deepStrictEqual(
    [...exitCodes],
    [0],
    "one exit code for every mismatch value in the range",
  );
});

test("runContactSheet: the exit decision is handed {pageWritten, ioError} and NOTHING measured", async () => {
  for (const mismatchPct of [0, 0.25, 11.07, 100, null]) {
    const received = [];
    const manifest = buildSweepManifest({ sheetId: "spy", mismatchPct });
    const fakeFs = makeFakeFs({});
    populateFakeCapture(fakeFs, manifest, { withDiff: mismatchPct !== null });
    const result = await runContactSheet(
      [
        "--manifest",
        "fake/capture-root/capture-manifest.json",
        "--sheet-id",
        "spy",
      ],
      {
        ...fakeFs,
        decideExit: (outcome) => {
          received.push(outcome);
          return 7;
        },
      },
    );

    // The sentinel proves the tool returns what the decision returned rather
    // than computing a code of its own beside it.
    assert.strictEqual(result.exitCode, 7);
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(Object.keys(received[0]).sort(), [
      "ioError",
      "pageWritten",
    ]);
    assert.deepStrictEqual(received[0], { pageWritten: true, ioError: null });
  }
});

test("decideContactSheetExit: reads its two fields and would THROW if it read a measured one", () => {
  // Each record is built FRESH: spreading an already-poisoned object would
  // trip the getters in the spec itself rather than in the function.
  const poisoned = (fields) => {
    const record = { ...fields };
    for (const name of ["mismatchPct", "worst", "changedPx", "diffPercent"]) {
      Object.defineProperty(record, name, {
        enumerable: true,
        get() {
          throw new Error(`the exit decision read ${name}`);
        },
      });
    }
    return record;
  };

  assert.strictEqual(
    decideContactSheetExit(poisoned({ pageWritten: true, ioError: null })),
    0,
  );
  assert.strictEqual(
    decideContactSheetExit(
      poisoned({ pageWritten: true, ioError: "copy failed" }),
    ),
    1,
  );
  assert.strictEqual(
    decideContactSheetExit(poisoned({ pageWritten: false, ioError: null })),
    1,
  );
  // The poison really is live: read one and it throws.
  assert.throws(
    () => poisoned({ pageWritten: true, ioError: null }).mismatchPct,
    /the exit decision read mismatchPct/,
  );
});

test("validateManifest: a non-finite or non-numeric mismatchPct is refused rather than rendered", async () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "11.07",
  ]) {
    const manifest = buildSweepManifest({ sheetId: "nan", mismatchPct: 1 });
    manifest.rigs[0].pairs.webgl.mismatchPct = value;
    assert.ok(
      validateManifest(manifest).some((violation) =>
        /mismatchPct must be null or a percent/.test(violation),
      ),
      `mismatchPct ${String(value)} was not refused`,
    );
  }

  // Through the CLI, only the STRING survives the manifest's JSON transport:
  // `JSON.stringify` writes NaN and both infinities as `null`, and a null
  // mismatch is the contract's legitimate "measured, no percentage" value
  // rather than a smuggled one. Asserting a CLI refusal for NaN would be
  // asserting something JSON makes unreachable.
  const manifest = buildSweepManifest({ sheetId: "nan", mismatchPct: 1 });
  manifest.rigs[0].pairs.webgl.mismatchPct = "11.07";
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });
  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "nan",
    ],
    fakeFs,
  );
  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /mismatchPct/);
  assert.deepStrictEqual(result.writtenPaths, []);

  assert.strictEqual(
    JSON.parse(JSON.stringify({ value: Number.NaN })).value,
    null,
    "the premise above: NaN cannot cross JSON as anything but null",
  );
});

// ---------------------------------------------------------------------------
// v3 — one relative-path predicate, and a percent-escape is not a loophole
// ---------------------------------------------------------------------------

test("relativePosixPathViolation: accepts a manifest path and names the reason for every escaping form", () => {
  for (const good of [
    "globe-default/webgl/BEFORE.png",
    "capture-report.json",
    "a/b/c/d.png",
    "images/globe-default%20wide/BEFORE.png",
  ]) {
    assert.strictEqual(relativePosixPathViolation(good), null, good);
    assert.strictEqual(isRelativePosixPath(good), true, good);
  }

  const cases = [
    ["", /non-empty string/],
    [42, /non-empty string/],
    ["a\\b.png", /backslash/],
    ["/abs/x.png", /leading `\/`/],
    ["https://example.test/x.png", /scheme:` or drive prefix/],
    ["C:/ESCAPED/x.png", /scheme:` or drive prefix/],
    ["c:x.png", /scheme:` or drive prefix/],
    ["../../secret.png", /segment `\.\.`/],
    ["images/../../secret.png", /segment `\.\.`/],
    ["images/.../secret.png", /segment `\.\.\.`/],
    ["%2e%2e/%2e%2e/secret.png", /escape `%2e`/],
    ["images%2f..%2f../secret.png", /escape `%2f`/],
    ["images/%2E%2E/secret.png", /escape `%2E`/],
    ["%252e%252e/secret.png", /escape `%25`/],
    ["images/%5c..%5csecret.png", /escape `%5c`/],
    ["images/x.png%", /malformed percent-escape/],
    ["images/x%zz.png", /malformed percent-escape/],
    ["images/x\u0000.png", /control characters/],
  ];
  for (const [value, expected] of cases) {
    const violation = relativePosixPathViolation(value);
    assert.ok(violation !== null, `${String(value)} was accepted`);
    assert.match(violation, expected, String(value));
    assert.strictEqual(isRelativePosixPath(value), false, String(value));
  }
});

test("validateManifest: a percent-encoded traversal is refused in an image path, a diff path and the receipt", () => {
  const fields = [
    (m) => {
      m.rigs[0].cells.webgl.BEFORE.image = "%2e%2e/%2e%2e/outside.png";
    },
    (m) => {
      m.rigs[0].pairs.webgl.diffImage = "images%2f..%2f../outside.png";
    },
    (m) => {
      m.receipt = "%2e%2e/outside.json";
    },
  ];
  for (const mutate of fields) {
    const manifest = buildSweepManifest({ sheetId: "encoded", mismatchPct: 1 });
    mutate(manifest);
    const violations = validateManifest(manifest);
    assert.ok(violations.length > 0, "the encoded traversal was accepted");
    assert.ok(
      violations.some((violation) => /escape `%2/i.test(violation)),
      `the reason was not the escape: ${violations.join(" | ")}`,
    );
  }
});

test("runContactSheet: a percent-encoded traversing manifest writes NOTHING", async () => {
  const manifest = buildSweepManifest({ sheetId: "encoded", mismatchPct: 1 });
  manifest.rigs[0].cells.webgl.AFTER.image = "%2e%2e/%2e%2e/outside.png";
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });
  const before = new Set(fakeFs.store.keys());

  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "encoded",
      "--out-dir",
      "out/sheets",
    ],
    fakeFs,
  );

  assert.strictEqual(result.exitCode, 1);
  assert.match(result.error, /relative POSIX path/);
  assert.deepStrictEqual(result.writtenPaths, []);
  assert.deepStrictEqual(
    [...fakeFs.store.keys()].filter((key) => !before.has(key)),
    [],
  );
});

// ---------------------------------------------------------------------------
// v3 — the sheet's date is the LOCAL calendar date
//
// The Edge leg banked a sheet made at 23:32 EDT into a `2026-09-19` directory
// while every wave-end receipt folder beside it is named for the local date.
// The clock double states its instant and its local date separately, so these
// cases assert WHICH of the two the tool used without depending on `TZ`.
// ---------------------------------------------------------------------------

test("formatCalendarDate: the local calendar date, both sides of midnight, in any timezone", () => {
  assert.strictEqual(
    formatCalendarDate(new Date(2026, 8, 18, 23, 59, 59)),
    "2026-09-18",
  );
  assert.strictEqual(
    formatCalendarDate(new Date(2026, 8, 19, 0, 0, 1)),
    "2026-09-19",
  );
  assert.strictEqual(
    formatCalendarDate(new Date(2026, 0, 1, 0, 0, 0)),
    "2026-01-01",
  );
  assert.strictEqual(
    formatCalendarDate(dateLike("2026-09-19T03:50:00.000Z", [2026, 9, 18])),
    "2026-09-18",
  );
});

test("runContactSheet: the sheet directory is the LOCAL date, not the UTC slice of the same instant", async () => {
  const lateEvening = dateLike("2026-09-19T03:50:00.000Z", [2026, 9, 18]);
  const manifest = buildSweepManifest({
    sheetId: "local-date",
    mismatchPct: 1,
  });
  const fakeFs = makeFakeFs({});
  populateFakeCapture(fakeFs, manifest, { withDiff: true });

  const result = await runContactSheet(
    [
      "--manifest",
      "fake/capture-root/capture-manifest.json",
      "--sheet-id",
      "local-date",
      "--out-dir",
      "out/sheets",
    ],
    { ...fakeFs, clock: () => lateEvening },
  );

  assert.strictEqual(result.exitCode, 0);
  assert.ok(
    result.writtenPaths.includes("out/sheets/2026-09-18/local-date/index.html"),
    `the sheet landed at ${result.writtenPaths.join(", ")}`,
  );
  assert.ok(
    !result.writtenPaths.some((written) => written.includes("2026-09-19")),
    "nothing was written under the UTC date",
  );
  // The instant itself is still the UTC one the clock reported.
  const entry = JSON.parse(
    fakeFs.store.get("out/sheets/2026-09-18/local-date/sheet-index.json"),
  );
  assert.strictEqual(entry.generatedAt, "2026-09-19T03:50:00.000Z");
  assert.strictEqual(entry.date, "2026-09-18");
});

test("runContactSheet: --date overrides, and an explicit --generated-at keeps its documented UTC derivation", async () => {
  const lateEvening = dateLike("2026-09-19T03:50:00.000Z", [2026, 9, 18]);
  const runWith = async (extra) => {
    const manifest = buildSweepManifest({ sheetId: "dates", mismatchPct: 1 });
    const fakeFs = makeFakeFs({});
    populateFakeCapture(fakeFs, manifest, { withDiff: true });
    const result = await runContactSheet(
      [
        "--manifest",
        "fake/capture-root/capture-manifest.json",
        "--sheet-id",
        "dates",
        "--out-dir",
        "out/sheets",
        ...extra,
      ],
      { ...fakeFs, clock: () => lateEvening },
    );
    assert.strictEqual(result.exitCode, 0, result.error ?? "");
    return result.writtenPaths.find((written) =>
      written.endsWith("index.html"),
    );
  };

  assert.strictEqual(
    await runWith(["--date", "2026-01-02"]),
    "out/sheets/2026-01-02/dates/index.html",
  );
  assert.strictEqual(
    await runWith(["--generated-at", "2026-03-04T05:06:07.000Z"]),
    "out/sheets/2026-03-04/dates/index.html",
  );
  assert.strictEqual(
    await runWith([]),
    "out/sheets/2026-09-18/dates/index.html",
  );
});

// ---------------------------------------------------------------------------
// v4 — the closed set covers the WHOLE page, not only the figures
//
// `findForeignFigureTokens` reads `<figure>` blocks only. The verifier's
// `M-HEADER` walked straight past it: `<p class="summary">overall structure
// degraded</p>` in the page header, keyed to a measured value, rendered with
// all three older guards reporting `[]` at 56 of 56. Outside a figure the only
// guard left was a twelve-word list, and a word list refuses only the words
// someone thought of. So the same closed-set rule is applied to the whole
// document: every text node and every attribute value must come from the page
// model or from the two chrome vocabularies the module exports.
// ---------------------------------------------------------------------------

test("findForeignPageTokens: the worked example and every measured value carry only model content and page chrome", () => {
  assert.deepStrictEqual(findForeignPageTokens(WORKED_HTML, WORKED_MODEL), []);
  for (const mismatchPct of [0, 0.42, 5.5, 11.07, 100, null]) {
    const { model, html } = sweepPage(mismatchPct);
    assert.deepStrictEqual(
      findForeignPageTokens(html, model),
      [],
      `a foreign token appeared at mismatch ${String(mismatchPct)}`,
    );
  }
  // Across every OTHER measured axis too, at the extremes of each — the axes
  // the mismatch sweep holds fixed, which is exactly where the four surviving
  // mutants lived.
  for (const [axis, values] of Object.entries({
    changedPx: [0, 4096],
    tolerance: [0, 255],
    mssim: [0, 1],
    rawByteLumaMean: [0, 255],
    nonBlackFraction: [0, 1],
  })) {
    for (const value of values) {
      const model = sheetModel(
        buildSweepManifest({
          sheetId: "page-axes",
          mismatchPct: 3.21,
          [axis]: value,
        }),
        { sheetId: "page-axes", generatedAt: "2026-09-19T02:05:00.000Z" },
      );
      assert.deepStrictEqual(
        findForeignPageTokens(renderSheetHtml(model), model),
        [],
        `a foreign token appeared at ${axis}=${value}`,
      );
    }
  }
});

test("findForeignPageTokens: a judgement OUTSIDE every figure is a violation — the case the figure guard cannot see", () => {
  const { model, html } = sweepPage(3.21, "page-header");
  // `M-HEADER` verbatim: a summary line in the page header, keyed to a
  // measured value, spelled in words no list names.
  const judged = html.replace(
    '<p class="note">',
    '<p class="summary">overall structure degraded</p>\n  <p class="note">',
  );

  // The demonstration first: every OTHER guard reports the page as clean.
  assert.deepStrictEqual(findVerdictTokens(judged), []);
  assert.deepStrictEqual(findUnknownClassNames(judged), []);
  assert.deepStrictEqual(findForeignFigureTokens(judged, model), []);

  // The page-wide guard names it, and says where.
  const violations = findForeignPageTokens(judged, model);
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0], /overall structure degraded/);
  assert.match(
    violations[0],
    /neither content the page model produced nor page chrome/,
  );
  assert.match(violations[0], /^<p>/, "and which element it sits in");

  // The control: the unjudged page is clean, so the case is about the added
  // sentence and not about the guard disliking summary lines.
  assert.deepStrictEqual(findForeignPageTokens(html, model), []);
});

test("findForeignPageTokens: a footer, a legend, the doctype, the stylesheet and every chrome attribute are covered", () => {
  const { model, html } = sweepPage(3.21, "page-chrome");
  const cases = [
    {
      name: "a judging footer appended after main",
      mutate: (page) =>
        page.replace(
          "</main>",
          "</main>\n<footer>reviewed and shipped</footer>",
        ),
      expect: /<footer> is not an element this page may carry/,
    },
    {
      name: "a legend paragraph nobody modelled",
      mutate: (page) =>
        page.replace(
          "<main>",
          '<main>\n<p class="note">green is good, red is bad</p>',
        ),
      expect: /green is good, red is bad/,
    },
    {
      name: "the summary counts replaced by a judgement",
      mutate: (page) =>
        page.replace(
          /1 rigs · \d+ measured cells/,
          "1 rigs · too few measured cells",
        ),
      expect: /too few measured cells/,
    },
    {
      name: "a nav link retargeted off the page",
      mutate: (page) =>
        page.replace('href="#rig-', 'href="http://elsewhere/#rig-'),
      expect: /href="http:\/\/elsewhere\/#rig-[a-z0-9-]+" is neither a value/,
    },
    {
      name: "a judgement in the document title",
      mutate: (page) =>
        page.replace("contact sheet —", "contact sheet degraded —"),
      expect: /contact sheet degraded/,
    },
    {
      name: "a data- attribute on the page heading",
      mutate: (page) => page.replace("<h1>", '<h1 data-verdict="poor">'),
      expect:
        /the attribute data-verdict="poor" is not one this page may carry/,
    },
    {
      name: "a foreign class outside every figure",
      mutate: (page) =>
        page.replace('class="summary"', 'class="summary summary-bad"'),
      expect: /the class "summary-bad" is not in the page's vocabulary/,
    },
    {
      name: "the document language changed",
      mutate: (page) => page.replace('lang="en"', 'lang="en-degraded"'),
      expect: /lang="en-degraded" is neither a value/,
    },
    {
      // The ELEMENT's label, not the stylesheet's selector — `PAGE_CSS`
      // carries `nav[aria-label="rig navigation"]` too, and rewriting that
      // instead reports the stylesheet violation rather than this one.
      name: "the nav's own label rewritten",
      mutate: (page) =>
        page.replace(
          '<nav aria-label="rig navigation">',
          '<nav aria-label="ranked rigs">',
        ),
      expect: /aria-label="ranked rigs" is neither a value/,
    },
    {
      name: "a judgement smuggled into the stylesheet",
      mutate: (page) =>
        page.replace(
          ".state-label { font-weight: 600; }",
          '.state-label { font-weight: 600; }\n.pair-measured figcaption::after { content: " degraded"; }',
        ),
      expect: /<style> block is not this module's own stylesheet/,
    },
    {
      name: "the doctype dropped",
      mutate: (page) => page.replace("<!doctype html>\n", ""),
      expect: /does not open with "<!doctype html>"/,
    },
    {
      name: "the stylesheet removed entirely",
      mutate: (page) => page.replace(/<style>[\s\S]*?<\/style>/, ""),
      expect: /no <style> block this guard can read/,
    },
  ];

  for (const one of cases) {
    const mutated = one.mutate(html);
    assert.notStrictEqual(mutated, html, `${one.name}: the mutation applied`);
    const violations = findForeignPageTokens(mutated, model);
    assert.ok(
      violations.length > 0,
      `${one.name}: expected a violation, got none`,
    );
    assert.ok(
      violations.some((violation) => one.expect.test(violation)),
      `${one.name}: no violation matched ${one.expect} — got ${JSON.stringify(violations)}`,
    );
  }

  // The control, last: the unmutated page reports nothing, so none of the
  // twelve cases above passed because the guard is noisy.
  assert.deepStrictEqual(findForeignPageTokens(html, model), []);
});

test("the page's chrome vocabularies are closed, carry no verdict and are all in use", () => {
  // Nothing in the fixed vocabulary may itself be a judgement.
  for (const text of PAGE_CHROME_TEXTS) {
    assert.deepStrictEqual(
      findVerdictTokens(text),
      [],
      `chrome text carries verdict vocabulary: ${text}`,
    );
  }
  for (const [name, values] of Object.entries(PAGE_CHROME_ATTRIBUTES)) {
    for (const value of values) {
      assert.deepStrictEqual(
        findVerdictTokens(value),
        [],
        `chrome attribute ${name}="${value}" carries verdict vocabulary`,
      );
    }
  }

  // And every entry is actually SPENT by the real page, so the list grants no
  // permission the renderer does not use — a dead entry is a hole waiting for
  // a future judgement to fill it.
  for (const text of PAGE_CHROME_TEXTS) {
    assert.ok(
      WORKED_HTML.includes(text),
      `chrome text is permitted but never rendered: ${text}`,
    );
  }
  for (const [name, values] of Object.entries(PAGE_CHROME_ATTRIBUTES)) {
    for (const value of values) {
      assert.ok(
        WORKED_HTML.includes(`${name}="${value}"`),
        `chrome attribute is permitted but never rendered: ${name}="${value}"`,
      );
    }
  }

  // The element and attribute name lists are sorted and duplicate-free, which
  // is what makes "add yours in review" a readable diff.
  for (const [label, list] of [
    ["PAGE_TAG_NAMES", PAGE_TAG_NAMES],
    ["PAGE_ATTRIBUTE_NAMES", PAGE_ATTRIBUTE_NAMES],
    ["PAGE_CLASS_NAMES", PAGE_CLASS_NAMES],
  ]) {
    assert.deepStrictEqual(
      [...list],
      [...new Set(list)].sort(),
      `${label} is sorted and duplicate-free`,
    );
  }
});
