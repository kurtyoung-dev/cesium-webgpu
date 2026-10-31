// landing-capture-manifest.spec.mjs - Behaviour spec for lib/landing-capture-manifest.mjs (no browser).
// @purpose Builds a manifest from synthetic landing runs made of real tiny PNGs in a lane temp directory and asserts lib/capture.mjs's validateManifest and the contact sheet's own validator accept it (with and without a base report, a NOT RUN page, variant pages, old base records), that a base capture whose digest changed or whose file is gone is an UNMEASURED BEFORE, that the writer puts the manifest and its images beside the report or refuses and removes a stale manifest, and that the writer, the BEFORE copy, the digest check and the refusal are live (inertness mutants).
// @status ACTIVE

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runContactSheet } from "./contact-sheet.mjs";
import { sheetModel } from "./lib/contact-sheet-page.mjs";
import { validateManifest } from "./lib/capture.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import * as lib from "./lib/landing-capture-manifest.mjs";
import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const libFile = path.join(here, "lib/landing-capture-manifest.mjs");

const GENERATED_AT = "2026-10-31T07:00:00.000Z";
const BASE_GENERATED_AT = "2026-10-30T22:00:00.000Z";
const CAPTURED_AT = "2026-10-31T06:59:00.000Z";

const rig = (id) => ({
  id,
  tags: ["landing"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description: `The synthetic ${id} rig.`,
  camera: null,
  clock: "2026-06-21T12:00:00Z",
  dials: { cloudsEnabled: false },
  viewport: { width: 4, height: 3 },
  readiness: { kind: "settleFrames", frames: 2 },
});

const RIGS = new Map([
  ["default-3d-pinned", rig("default-3d-pinned")],
  ["ocean-fft-patch-rebase", rig("ocean-fft-patch-rebase")],
]);

/** A real `w` by `h` PNG whose every pixel is `rgb`, optionally with one pixel changed. */
function solidPng(rgb, { width = 4, height = 3, changeFirst = null } = {}) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  if (changeFirst) {
    pixels.set([...changeFirst, 255], 0);
  }
  return Buffer.from(encodeRgbaPng(pixels, width, height));
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Write a PNG into `dir` and return the capture record a landing page would carry. */
function banked(dir, name, bytes, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, bytes);
  return {
    name,
    path: path.resolve(file),
    sha256: sha(bytes),
    width: 4,
    height: 3,
    ...extra,
  };
}

const withUrl = {
  url: "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu",
  capturedAt: CAPTURED_AT,
};

function page({
  cell = "E-D",
  renderer,
  name = "scene",
  capture,
  notRun = null,
}) {
  return {
    run: 0,
    cell,
    rig: cell === "E-FFT-ifft" ? "ocean-fft-patch-rebase" : "default-3d-pinned",
    kind: "capture",
    renderer,
    page: name,
    notRun,
    ...(capture ? { capture } : {}),
  };
}

const readFromDisk = (absolute) => {
  try {
    return fs.readFileSync(absolute);
  } catch {
    return null;
  }
};

function build(module, overrides) {
  return module.buildLandingCaptureManifest({
    rigsById: RIGS,
    origins: { AFTER: "http://localhost:8081" },
    generatedAt: GENERATED_AT,
    servedBuildAssertion: "enforced",
    receipt: "landing-cells-report.json",
    readBytes: readFromDisk,
    ...overrides,
  });
}

function cellOf(manifest, id, renderer, slot) {
  return manifest.rigs.find((r) => r.id === id).cells[renderer][slot];
}
function pairOf(manifest, id, renderer) {
  return manifest.rigs.find((r) => r.id === id).pairs[renderer];
}

/** A tip run and a base run of E-D scene on both renderers in two directories. */
function twoArmRun(root, { webgpuDiffers = true } = {}) {
  const tipDir = path.join(root, "tip");
  const baseDir = path.join(root, "base");
  const tip = [];
  const base = [];
  for (const renderer of ["webgl", "webgpu"]) {
    const tipBytes = solidPng(
      renderer === "webgl" ? [10, 20, 30] : [90, 80, 70],
      {
        changeFirst:
          renderer === "webgpu" && webgpuDiffers ? [250, 0, 0] : null,
      },
    );
    const baseBytes = solidPng(
      renderer === "webgl" ? [10, 20, 30] : [90, 80, 70],
    );
    tip.push(
      page({
        renderer,
        capture: banked(tipDir, `E-D-${renderer}-run0`, tipBytes, withUrl),
      }),
    );
    base.push(
      page({
        renderer,
        capture: banked(baseDir, `E-D-${renderer}-run0`, baseBytes, withUrl),
      }),
    );
  }
  return {
    tipDir,
    baseDir,
    tip,
    baseReport: { generatedAt: BASE_GENERATED_AT, pages: base },
  };
}

test("tip and base on both renderers: validates with both validators and the sheet model accepts it", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const result = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(validateManifest(result.manifest), []);
    const model = sheetModel(result.manifest, {
      sheetId: "landing-run",
      generatedAt: GENERATED_AT,
    });
    assert.equal(model.rigs.length, 1);
    assert.deepEqual(model.renderers, ["webgl", "webgpu"]);
    assert.equal(model.counts.measured, 4);
    assert.equal(model.counts.unmeasured, 0);
    assert.equal(result.manifest.rigs[0].id, "E-D:scene");
    assert.match(result.manifest.rigs[0].replayKey, /^[0-9a-f]{8}$/);
    assert.equal(result.manifest.origins.AFTER, "http://localhost:8081");
    assert.equal(result.manifest.receipt, "landing-cells-report.json");
  });
});

test("BEFORE is the base capture copied beside the manifest and AFTER stays where it is; the pair is measured at the landing band tolerance", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const { manifest, files } = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    const before = cellOf(manifest, "E-D:scene", "webgpu", "BEFORE");
    const after = cellOf(manifest, "E-D:scene", "webgpu", "AFTER");
    assert.equal(before.state, "MEASURED");
    assert.equal(before.image, "manifest-images/E-D-scene/webgpu/BEFORE.png");
    assert.equal(after.image, "E-D-webgpu-run0.png");
    const copy = files.find((f) => f.path === before.image);
    assert.ok(copy, "the BEFORE copy is among the files to write");
    assert.equal(sha(copy.bytes), before.sha256);
    assert.equal(before.capturedAt, CAPTURED_AT);
    assert.match(before.url, /renderer=webgpu/);
    assert.equal(before.fallbackFields, undefined);
    // The identical webgl pair has no changed pixel; the webgpu pair has one.
    assert.equal(pairOf(manifest, "E-D:scene", "webgl").changedPx, 0);
    const pair = pairOf(manifest, "E-D:scene", "webgpu");
    assert.equal(pair.state, "MEASURED");
    assert.equal(pair.changedPx, 1);
    assert.equal(pair.tolerance, 0);
    assert.ok(files.some((f) => f.path === pair.diffImage));
  });
});

test("no base report: every BEFORE is UNMEASURED saying so and every pair follows", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const { manifest, violations } = build(lib, {
      pages: run.tip,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    for (const renderer of ["webgl", "webgpu"]) {
      const before = cellOf(manifest, "E-D:scene", renderer, "BEFORE");
      assert.equal(before.state, "UNMEASURED");
      assert.equal(before.reason, "no --base-report");
      assert.equal(
        cellOf(manifest, "E-D:scene", renderer, "AFTER").state,
        "MEASURED",
      );
      const pair = pairOf(manifest, "E-D:scene", renderer);
      assert.equal(pair.state, "UNMEASURED");
      assert.match(pair.reason, /BEFORE is UNMEASURED \(no --base-report\)/);
    }
    assert.equal(manifest.origins.BEFORE, lib.UNRECORDED_ORIGIN);
  });
});

test("a NOT RUN page is an UNMEASURED AFTER with the stage reason and still validates", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const tip = run.tip.map((record) =>
      record.renderer === "webgpu"
        ? page({
            renderer: "webgpu",
            notRun: "the stage did not apply cloudsEnabled",
          })
        : record,
    );
    const { manifest, violations } = build(lib, {
      pages: tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    const after = cellOf(manifest, "E-D:scene", "webgpu", "AFTER");
    assert.equal(after.state, "UNMEASURED");
    assert.equal(
      after.reason,
      "NOT RUN: the stage did not apply cloudsEnabled",
    );
    assert.equal(
      cellOf(manifest, "E-D:scene", "webgpu", "BEFORE").state,
      "MEASURED",
    );
    assert.equal(pairOf(manifest, "E-D:scene", "webgpu").state, "UNMEASURED");
    assert.equal(pairOf(manifest, "E-D:scene", "webgl").state, "MEASURED");
  });
});

test("a base capture whose file changed, or is gone, is an UNMEASURED BEFORE with the reason", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const [webglBase, webgpuBase] = run.baseReport.pages.map(
      (p) => p.capture.path,
    );
    fs.writeFileSync(webglBase, solidPng([1, 2, 3]));
    fs.rmSync(webgpuBase);
    const { manifest, violations } = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    const changed = cellOf(manifest, "E-D:scene", "webgl", "BEFORE");
    assert.equal(changed.state, "UNMEASURED");
    assert.match(changed.reason, /changed after the run/);
    const gone = cellOf(manifest, "E-D:scene", "webgpu", "BEFORE");
    assert.equal(gone.state, "UNMEASURED");
    assert.match(gone.reason, /could not be read/);
    assert.equal(pairOf(manifest, "E-D:scene", "webgl").state, "UNMEASURED");
  });
});

test("variant pages are separate entries with their own replay keys", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const dir = path.join(root, "tip");
    const tip = [];
    for (const renderer of ["webgl", "webgpu"]) {
      for (const [name, rgb] of [
        ["stockham", [40, 40, 40]],
        ["pingpong", [41, 41, 41]],
      ]) {
        tip.push(
          page({
            cell: "E-FFT-ifft",
            renderer,
            name,
            capture: banked(
              dir,
              `E-FFT-ifft-${renderer}-run0-${name}`,
              solidPng(rgb),
              withUrl,
            ),
          }),
        );
      }
    }
    const { manifest, violations } = build(lib, {
      pages: tip,
      outputDirectory: dir,
    });
    assert.deepEqual(violations, []);
    assert.deepEqual(manifest.rigs.map((r) => r.id).sort(), [
      "E-FFT-ifft:pingpong",
      "E-FFT-ifft:stockham",
    ]);
    const [a, b] = manifest.rigs;
    assert.notEqual(a.replayKey, b.replayKey);
    sheetModel(manifest, { sheetId: "variants", generatedAt: GENERATED_AT });
  });
});

test("a cell run on one renderer only gets an UNMEASURED cell for the other, and the sheet accepts it", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const tip = run.tip.concat(
      page({
        cell: "E-O",
        renderer: "webgpu",
        capture: banked(
          run.tipDir,
          "E-O-webgpu-run0",
          solidPng([5, 5, 5]),
          withUrl,
        ),
      }),
    );
    const rigs = new Map(RIGS).set(
      "orbital-fulldisc-6608km-msaa4-single-deck",
      rig("orbital-fulldisc-6608km-msaa4-single-deck"),
    );
    const eo = tip[tip.length - 1];
    eo.rig = "orbital-fulldisc-6608km-msaa4-single-deck";
    const { manifest, violations } = build(lib, {
      pages: tip,
      rigsById: rigs,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    const missing = cellOf(manifest, "E-O:scene", "webgl", "AFTER");
    assert.equal(missing.state, "UNMEASURED");
    assert.match(missing.reason, /was not run on webgl/);
    sheetModel(manifest, { sheetId: "partial", generatedAt: GENERATED_AT });
  });
});

test("old base records without url or capturedAt take stated stand-ins and name them", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    for (const record of run.baseReport.pages) {
      delete record.capture.url;
      delete record.capture.capturedAt;
    }
    const { manifest, violations } = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      origins: {
        AFTER: "http://localhost:8081",
        BEFORE: "http://localhost:8080",
      },
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    const before = cellOf(manifest, "E-D:scene", "webgl", "BEFORE");
    assert.deepEqual(before.fallbackFields, ["url", "capturedAt"]);
    assert.equal(
      before.url,
      "http://localhost:8080/Apps/CesiumViewer/index.html",
    );
    assert.equal(before.capturedAt, BASE_GENERATED_AT);
    assert.equal(
      cellOf(manifest, "E-D:scene", "webgl", "AFTER").fallbackFields,
      undefined,
    );
  });
});

test("two sizes cannot be diffed: the pair is UNMEASURED with the sizes", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const big = solidPng([10, 20, 30], { width: 5, height: 3 });
    run.baseReport.pages[0].capture = banked(
      path.join(root, "base"),
      "E-D-webgl-big",
      big,
      withUrl,
    );
    const { manifest, violations } = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    assert.deepEqual(violations, []);
    assert.match(
      pairOf(manifest, "E-D:scene", "webgl").reason,
      /BEFORE is 5x3 and AFTER is 4x3/,
    );
  });
});

test("an AFTER capture outside the output directory is copied beside the manifest", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const elsewhere = path.join(root, "elsewhere");
    const { manifest, files } = build(lib, {
      pages: run.tip,
      outputDirectory: elsewhere,
    });
    const after = cellOf(manifest, "E-D:scene", "webgl", "AFTER");
    assert.equal(after.image, "manifest-images/E-D-scene/webgl/AFTER.png");
    assert.ok(files.some((f) => f.path === after.image));
  });
});

test("a page that names an unknown rig is a TypeError, not a silent gap", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    assert.throws(
      () =>
        build(lib, {
          pages: run.tip,
          rigsById: new Map(),
          outputDirectory: run.tipDir,
        }),
      /does not hold/,
    );
  });
});

/** Run the real writer on real files; returns what it left behind. */
function writeScenario(
  module,
  { staleManifest = false, servedBuildAssertion } = {},
) {
  return withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const manifestFile = path.join(run.tipDir, "capture-manifest.json");
    if (staleManifest) {
      fs.writeFileSync(manifestFile, '{"stale":true}');
    }
    const result = module.writeLandingCaptureManifest({
      pages: run.tip,
      baseReport: run.baseReport,
      rigsById: RIGS,
      origins: { AFTER: "http://localhost:8081" },
      generatedAt: GENERATED_AT,
      servedBuildAssertion: servedBuildAssertion ?? "enforced",
      receipt: "landing-cells-report.json",
      outputDirectory: run.tipDir,
    });
    const exists = fs.existsSync(manifestFile);
    const text = exists ? fs.readFileSync(manifestFile, "utf8") : null;
    return {
      result,
      exists,
      text,
      beforeCopyExists: fs.existsSync(
        path.join(run.tipDir, "manifest-images/E-D-scene/webgpu/BEFORE.png"),
      ),
      diffExists: fs.existsSync(
        path.join(run.tipDir, "manifest-images/E-D-scene/webgpu/DIFF.png"),
      ),
    };
  });
}

test("the writer puts the manifest and its images beside the report, and the stored manifest validates", () => {
  const seen = writeScenario(lib);
  assert.equal(seen.result.written, true);
  assert.deepEqual(seen.result.violations, []);
  assert.ok(seen.exists);
  assert.ok(seen.beforeCopyExists);
  assert.ok(seen.diffExists);
  const manifest = JSON.parse(seen.text);
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(path.basename(seen.result.path), lib.LANDING_MANIFEST_FILE);
});

test("contact-sheet.mjs, run in process on the written manifest, writes a sheet", async () => {
  await withLaneTmp("landing-manifest-", async (root) => {
    const run = twoArmRun(root);
    const written = lib.writeLandingCaptureManifest({
      pages: run.tip,
      baseReport: run.baseReport,
      rigsById: RIGS,
      origins: { AFTER: "http://localhost:8081" },
      generatedAt: GENERATED_AT,
      servedBuildAssertion: "enforced",
      receipt: "landing-cells-report.json",
      outputDirectory: run.tipDir,
    });
    fs.writeFileSync(path.join(run.tipDir, "landing-cells-report.json"), "{}");
    const outDir = path.join(root, "sheets").split(path.sep).join("/");
    const result = await runContactSheet([
      "--manifest",
      written.path,
      "--sheet-id",
      "landing-run",
      "--out-dir",
      outDir,
      "--generated-at",
      GENERATED_AT,
      "--date",
      "2026-10-31",
    ]);
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    assert.ok(
      fs.existsSync(`${outDir}/2026-10-31/landing-run/index.html`),
      "the sheet page exists",
    );
  });
});

test("the writer refuses a manifest that does not validate: nothing written, a stale manifest removed, violations returned", () => {
  const seen = writeScenario(lib, {
    staleManifest: true,
    servedBuildAssertion: "bogus",
  });
  assert.equal(seen.result.written, false);
  assert.equal(seen.result.path, null);
  assert.ok(seen.result.violations.length > 0);
  assert.match(seen.result.violations.join("\n"), /servedBuildAssertion/);
  assert.equal(seen.exists, false);
  assert.equal(seen.beforeCopyExists, false);
});

test("the writer takes injected I/O and touches no disk", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const writes = new Map();
    const result = lib.writeLandingCaptureManifest({
      fs: {
        readFileSync: (file) => fs.readFileSync(file),
        writeFileSync: (file, data) => writes.set(path.resolve(file), data),
        mkdirSync: () => {},
        rmSync: () => {},
      },
      pages: run.tip,
      baseReport: run.baseReport,
      rigsById: RIGS,
      origins: { AFTER: "http://localhost:8081" },
      generatedAt: GENERATED_AT,
      servedBuildAssertion: "enforced",
      receipt: "landing-cells-report.json",
      outputDirectory: run.tipDir,
    });
    assert.equal(result.written, true);
    assert.ok(writes.has(path.resolve(result.path)));
    assert.equal(
      fs.existsSync(path.join(run.tipDir, "capture-manifest.json")),
      false,
    );
  });
});

test("no verdict vocabulary reaches the manifest", () => {
  withLaneTmp("landing-manifest-", (root) => {
    const run = twoArmRun(root);
    const { manifest } = build(lib, {
      pages: run.tip,
      baseReport: run.baseReport,
      outputDirectory: run.tipDir,
    });
    const text = JSON.stringify(manifest);
    assert.doesNotMatch(
      text,
      /"gate"|"expectedMismatch"|"thresholds"|"PASS"|"FAIL"/,
    );
  });
});

// ---- inertness mutants: each clause made unreachable must change the observation ----

test("INERTNESS: with the manifest write unreachable the stored manifest is absent", async () => {
  const mutated = await importMutated(libFile, [
    ["io.writeFileSync(manifestPath, ", "(() => {})(manifestPath, "],
  ]);
  assert.equal(writeScenario(lib).exists, true);
  const seen = writeScenario(mutated);
  assert.equal(seen.exists, false);
});

test("INERTNESS: with the BEFORE copy skipped the copy is not on disk", async () => {
  const mutated = await importMutated(libFile, [
    [
      "inPlace === null ? [{ path: imagePath, bytes: Buffer.from(bytes) }] : []",
      "[]",
    ],
  ]);
  assert.equal(writeScenario(lib).beforeCopyExists, true);
  assert.equal(writeScenario(mutated).beforeCopyExists, false);
});

test("INERTNESS: with the digest check unreachable a changed base file is shown as BEFORE", async () => {
  const mutated = await importMutated(libFile, [
    [
      "if (record.sha256 !== undefined && digest !== record.sha256) {",
      "if (false && record.sha256 !== undefined && digest !== record.sha256) {",
    ],
  ]);
  const observe = (module) =>
    withLaneTmp("landing-manifest-", (root) => {
      const run = twoArmRun(root);
      fs.writeFileSync(
        run.baseReport.pages[0].capture.path,
        solidPng([1, 2, 3]),
      );
      const { manifest } = build(module, {
        pages: run.tip,
        baseReport: run.baseReport,
        outputDirectory: run.tipDir,
      });
      return cellOf(manifest, "E-D:scene", "webgl", "BEFORE").state;
    });
  assert.equal(observe(lib), "UNMEASURED");
  assert.equal(observe(mutated), "MEASURED");
});

test("INERTNESS: with the refusal unreachable an invalid manifest is written", async () => {
  const mutated = await importMutated(libFile, [
    [
      "if (violations.length > 0) {\n    io.rmSync",
      "if (false && violations.length > 0) {\n    io.rmSync",
    ],
  ]);
  const options = { servedBuildAssertion: "bogus" };
  assert.equal(writeScenario(lib, options).exists, false);
  assert.equal(writeScenario(mutated, options).exists, true);
});

test("INERTNESS: with the stale-manifest removal skipped a stale manifest survives a refusal", async () => {
  const mutated = await importMutated(libFile, [
    ["io.rmSync(manifestPath, { force: true });", "void manifestPath;"],
  ]);
  const options = { servedBuildAssertion: "bogus", staleManifest: true };
  assert.equal(writeScenario(lib, options).exists, false);
  assert.equal(writeScenario(mutated, options).exists, true);
});
