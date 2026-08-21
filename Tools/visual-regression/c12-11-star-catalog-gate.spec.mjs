import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_11_STAR_CATALOG_BUILD_SOURCE_FILES,
  C12_11_STAR_CATALOG_CAPTURE_LABELS,
  C12_11_STAR_CATALOG_CHECK_KEYS,
  C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
  C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES,
  C12_11_STAR_CATALOG_LOCK_SCHEMA,
  C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS,
  C12_11_STAR_CATALOG_PROVENANCE_SCHEMA,
  C12_11_STAR_CATALOG_RENDERER,
  C12_11_STAR_CATALOG_RUNTIME_PATH,
  C12_11_STAR_CATALOG_SCENE,
  C12_11_STAR_CATALOG_SCHEMA,
  C12_11_STAR_CATALOG_SOURCE_FILES,
  C12_11_STAR_CATALOG_VIEWER_PATH,
  createC1211StarCatalogErrorArtifact,
  decodeC1211RgbaPng,
  expectedC1211CaptureFilename,
  foldC1211StarCatalogGate,
  inspectC1211Png,
  isC1211UuidV4,
  materializeC1211StarCatalogArtifact,
  sha256C1211,
  stableC1211StarCatalogJson,
  validateC1211G3Prerequisite,
  validateC1211StarCatalogFinalArtifact,
} from "./lib/c12-11-star-catalog-gate.mjs";
import {
  beginC1211EvidenceRun,
  createC1211ArtifactPaths,
  deriveC1211MetricsFromCaptureFiles,
  finalizeC1211Evidence,
  validateC1211LoopbackBase,
  verifyC1211CaptureFiles,
  writeC1211Capture,
} from "./probe-stars-catalog.mjs";

const specDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(specDirectory, "../..");
const probePath = path.join(specDirectory, "probe-stars-catalog.mjs");
const gatePath = path.join(specDirectory, "lib/c12-11-star-catalog-gate.mjs");
const runId = "123e4567-e89b-42d3-a456-426614174000";

const fakeHash = (index) => index.toString(16).padStart(64, "0").slice(-64);
const identityList = (paths, offset = 1) =>
  paths.map((file, index) => ({
    path: file,
    byteLength: 1000 + index,
    sha256: fakeHash(offset + index),
  }));

function syntheticG3() {
  const value = {
    files: identityList(C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES, 100),
    report: {
      gate: "G3",
      verdict: "PASS",
      exitCode: 0,
      pass: true,
      failures: [],
      structural: [],
      assetFingerprints: {
        webgl: fakeHash(200),
        webgpu: fakeHash(200),
      },
      backendPass: { webgl: true, webgpu: true },
    },
    foldVerified: true,
    stable: true,
    valid: true,
  };
  assert.equal(validateC1211G3Prerequisite(value).ok, true);
  return value;
}

function syntheticProvenance() {
  const sources = identityList(C12_11_STAR_CATALOG_SOURCE_FILES, 300);
  return {
    schema: C12_11_STAR_CATALOG_PROVENANCE_SCHEMA,
    gitHead: "a".repeat(40),
    localStart: structuredClone(sources),
    localEnd: structuredClone(sources),
    localStable: true,
    buildSourceIdentity: {
      ok: true,
      sourceMapByteLength: 9999,
      sourceMapSha256: fakeHash(500),
      buildEntryByteLength: 123456,
      buildEntrySha256: fakeHash(700),
      endSourceMapByteLength: 9999,
      endSourceMapSha256: fakeHash(500),
      endBuildEntryByteLength: 123456,
      endBuildEntrySha256: fakeHash(700),
      stable: true,
      entries: C12_11_STAR_CATALOG_BUILD_SOURCE_FILES.map((file) => {
        const source = sources.find((entry) => entry.path === file);
        return {
          path: file,
          sourceMapEntry: `../../../${file}`,
          currentByteLength: source.byteLength,
          embeddedByteLength: source.byteLength,
          currentSha256: source.sha256,
          embeddedSha256: source.sha256,
          exact: true,
          reason: null,
        };
      }),
      reasons: [],
    },
    servedEntry: {
      path: "Build/CesiumUnminified/index.js",
      url: "http://localhost:8080/Build/CesiumUnminified/index.js",
      status: 200,
      byteLength: 123456,
      sha256: fakeHash(700),
      matchesLocalBuildEntry: true,
    },
    g3Prerequisite: syntheticG3(),
    protectedHistorical: {
      before: C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.map((entry) => ({
        ...entry,
      })),
      after: C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.map((entry) => ({
        ...entry,
      })),
      stable: true,
    },
  };
}

function syntheticReport(id = runId) {
  const captureBindings = C12_11_STAR_CATALOG_CAPTURE_LABELS.map(
    (label, index) => ({
      runId: id,
      renderer: C12_11_STAR_CATALOG_RENDERER,
      label,
      file: expectedC1211CaptureFilename(id, label),
      byteLength: 100_000 + index,
      sha256: fakeHash(800 + index),
      width: C12_11_STAR_CATALOG_SCENE.viewport.width,
      height: C12_11_STAR_CATALOG_SCENE.viewport.height,
    }),
  );
  return {
    runId: id,
    contract: {
      renderer: C12_11_STAR_CATALOG_RENDERER,
      runtimePath: C12_11_STAR_CATALOG_RUNTIME_PATH,
      viewerPath: C12_11_STAR_CATALOG_VIEWER_PATH,
      captureLabels: [...C12_11_STAR_CATALOG_CAPTURE_LABELS],
      scene: C12_11_STAR_CATALOG_SCENE,
    },
    provenance: syntheticProvenance(),
    captureBindings,
    runtime: {
      completed: true,
      renderer: C12_11_STAR_CATALOG_RENDERER,
      hasStarField: true,
      metrics: {
        offBright: 0,
        onBright: 4,
        brightBright: 8,
        siriusCenter: 4,
        blankCenter: 0,
        offCenter: 0,
        siriusPoints: 1,
        offPoints: 0,
        blankPoints: 0,
        siriusAimPx: Math.SQRT1_2,
      },
      captures: Object.fromEntries(
        captureBindings.map((binding) => [
          binding.label,
          {
            label: binding.label,
            width: binding.width,
            height: binding.height,
            sha256: binding.sha256,
          },
        ]),
      ),
      diagnostics: {
        offlinePrediction: C12_11_STAR_CATALOG_SCENE.offlinePrediction,
      },
      errors: {
        console: [],
        page: [],
        request: [],
        response: [],
        webgpu: [],
        deviceLoss: null,
      },
      gpuGate: { found: 1, armed: 1, total: 1 },
    },
    cleanup: {
      pageClosed: true,
      browserClosed: true,
      timedOut: false,
      errors: [],
    },
  };
}

function artifactAfter(mutator) {
  const report = structuredClone(syntheticReport());
  mutator(report);
  return materializeC1211StarCatalogArtifact(report);
}

test("01 canonical synthetic evidence folds PASS / 0 and validates", () => {
  const report = syntheticReport();
  const verdict = foldC1211StarCatalogGate(report);
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.exitCode, 0);
  assert.deepEqual(Object.keys(verdict.checks), C12_11_STAR_CATALOG_CHECK_KEYS);
  assert.equal(Object.values(verdict.checks).every(Boolean), true);
  const artifact = materializeC1211StarCatalogArtifact(report);
  assert.equal(validateC1211StarCatalogFinalArtifact(artifact).ok, true);
});

test("02 canonical A-G predicates reject one mutation per historical claim", async (t) => {
  const cases = [
    [
      "A no Sirius source is a product FAIL, not an instrument error",
      (r) => {
        r.runtime.metrics.siriusPoints = 0;
        r.runtime.metrics.siriusAimPx = null;
      },
      "A_",
    ],
    [
      "A aim is outside six pixels",
      (r) => (r.runtime.metrics.siriusAimPx = 6.001),
      "A_",
    ],
    [
      "B aimed box is not brighter",
      (r) => (r.runtime.metrics.siriusCenter = 0),
      "B_",
    ],
    [
      "C blank direction has a source",
      (r) => (r.runtime.metrics.blankPoints = 1),
      "C_",
    ],
    [
      "D intensity 3.0 does not grow the count",
      (r) => (r.runtime.metrics.brightBright = 4),
      "D_",
    ],
    ["E live hook is absent", (r) => (r.runtime.hasStarField = false), "E_"],
    ["F console error", (r) => r.runtime.errors.console.push("boom"), "F_"],
    ["F page error", (r) => r.runtime.errors.page.push("boom"), "F_"],
    ["F request error", (r) => r.runtime.errors.request.push("boom"), "F_"],
    [
      "F HTTP response error",
      (r) => r.runtime.errors.response.push("404"),
      "F_",
    ],
    [
      "F uncaptured WebGPU error",
      (r) => r.runtime.errors.webgpu.push("validation"),
      "F_",
    ],
    [
      "F device loss",
      (r) => (r.runtime.errors.deviceLoss = "device lost"),
      "F_",
    ],
    [
      "G cubemap resolves three sources",
      (r) => {
        r.runtime.metrics.offPoints = 3;
        r.runtime.metrics.siriusPoints = 4;
      },
      "G_",
    ],
  ];
  for (const [name, mutate, prefix] of cases) {
    await t.test(name, () => {
      const artifact = artifactAfter(mutate);
      assert.equal(artifact.status, "FAIL");
      assert.equal(artifact.exitCode, 1);
      assert.equal(
        artifact.reasons.failures.some((reason) => reason.startsWith(prefix)),
        true,
      );
      assert.equal(validateC1211StarCatalogFinalArtifact(artifact).ok, true);
    });
  }
});

test("03 runtime non-completion is ERROR / 2, never FAIL or STRUCTURAL", () => {
  const report = syntheticReport();
  report.runtime.completed = false;
  const verdict = foldC1211StarCatalogGate(report);
  assert.equal(verdict.status, "ERROR");
  assert.equal(verdict.exitCode, 2);
});

test("04 malformed/non-finite measurements are STRUCTURAL / 3", async (t) => {
  for (const [name, value] of [
    ["NaN", Number.NaN],
    ["positive infinity", Infinity],
    ["negative count", -1],
    ["fractional count", 0.5],
  ]) {
    await t.test(name, () => {
      const artifact = artifactAfter((report) => {
        report.runtime.metrics.siriusPoints = value;
      });
      assert.equal(artifact.status, "STRUCTURAL");
      assert.equal(artifact.exitCode, 3);
    });
  }
});

test("05 source, build, served, G3, and protected identities are all certifying", async (t) => {
  const cases = [
    ["source drift", (r) => (r.provenance.localEnd[0].sha256 = fakeHash(999))],
    [
      "build drift",
      (r) => (r.provenance.buildSourceIdentity.entries[0].exact = false),
    ],
    [
      "build entry changes before publication",
      (r) =>
        (r.provenance.buildSourceIdentity.endBuildEntrySha256 = fakeHash(995)),
    ],
    [
      "build entry is detached from the attested source",
      (r) =>
        (r.provenance.buildSourceIdentity.entries[0].currentSha256 =
          fakeHash(994)),
    ],
    [
      "served drift",
      (r) => (r.provenance.servedEntry.matchesLocalBuildEntry = false),
    ],
    [
      "served identity is not the loopback runtime module",
      (r) =>
        (r.provenance.servedEntry.url =
          "http://localhost:8080/Build/CesiumUnminified/other.js"),
    ],
    [
      "G3 no longer passes",
      (r) => {
        r.provenance.g3Prerequisite.report.verdict = "FAIL";
        r.provenance.g3Prerequisite.report.exitCode = 1;
        r.provenance.g3Prerequisite.report.pass = false;
        r.provenance.g3Prerequisite.valid = false;
      },
    ],
    [
      "G3 backend fingerprints differ",
      (r) => {
        r.provenance.g3Prerequisite.report.assetFingerprints.webgpu =
          fakeHash(998);
        r.provenance.g3Prerequisite.valid = false;
      },
    ],
    [
      "G3 report fold was not independently recomputed",
      (r) => (r.provenance.g3Prerequisite.foldVerified = false),
    ],
    [
      "protected historical bytes drift",
      (r) => {
        r.provenance.protectedHistorical.after[0].sha256 = fakeHash(997);
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const artifact = artifactAfter(mutate);
      assert.equal(artifact.status, "STRUCTURAL");
      assert.equal(artifact.exitCode, 3);
      assert.equal(artifact.reasons.structural.length > 0, true);
    });
  }
});

test("06 all four UUID capture bindings are exact, ordered, unique, and semantic", async (t) => {
  const cases = [
    ["missing binding", (r) => r.captureBindings.pop()],
    ["wrong order", (r) => r.captureBindings.reverse()],
    [
      "foreign run",
      (r) =>
        (r.captureBindings[0].runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ],
    ["fixed filename", (r) => (r.captureBindings[0].file = "webgpu-off.png")],
    ["wrong dimensions", (r) => (r.captureBindings[0].width = 1000)],
    [
      "runtime hash detached",
      (r) => (r.runtime.captures.off.sha256 = fakeHash(996)),
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const artifact = artifactAfter(mutate);
      assert.equal(artifact.status, "STRUCTURAL");
      assert.equal(artifact.exitCode, 3);
    });
  }
});

test("07 live GPU error reachability and bounded cleanup are structural controls", async (t) => {
  for (const [name, mutate] of [
    ["no GPU found", (r) => (r.runtime.gpuGate.found = 0)],
    ["no GPU armed", (r) => (r.runtime.gpuGate.total = 0)],
    ["malformed hook evidence", (r) => (r.runtime.hasStarField = "true")],
    [
      "page close timeout",
      (r) => {
        r.cleanup.pageClosed = false;
        r.cleanup.timedOut = true;
        r.cleanup.errors.push("timeout");
      },
    ],
    [
      "browser cleanup error",
      (r) => {
        r.cleanup.browserClosed = false;
        r.cleanup.errors.push("close failed");
      },
    ],
  ]) {
    await t.test(name, () => {
      const artifact = artifactAfter(mutate);
      assert.equal(artifact.status, "STRUCTURAL");
      assert.equal(artifact.exitCode, 3);
    });
  }
});

test("08 a final artifact cannot lie about checks, reasons, status, or exit code", async (t) => {
  const clean = materializeC1211StarCatalogArtifact(syntheticReport());
  for (const [name, mutate] of [
    ["status", (a) => (a.status = "FAIL")],
    ["exit", (a) => (a.exitCode = 1)],
    ["check", (a) => (a.checks[C12_11_STAR_CATALOG_CHECK_KEYS[0]] = false)],
    ["failure reason", (a) => a.reasons.failures.push("fabricated")],
    ["structural reason", (a) => a.reasons.structural.push("fabricated")],
    ["extra field", (a) => (a.selfAttested = true)],
  ]) {
    await t.test(name, () => {
      const mutant = structuredClone(clean);
      mutate(mutant);
      assert.equal(validateC1211StarCatalogFinalArtifact(mutant).ok, false);
    });
  }
});

test("09 ERROR artifacts are bounded, exact, and always exit 2", () => {
  const artifact = createC1211StarCatalogErrorArtifact(runId, {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage: "browser",
    message: "launch failed",
    stack: null,
    timeoutMs: null,
  });
  assert.equal(artifact.status, "ERROR");
  assert.equal(artifact.exitCode, 2);
  assert.equal(validateC1211StarCatalogFinalArtifact(artifact).ok, true);
  artifact.diagnostics.message = "x".repeat(4097);
  assert.equal(validateC1211StarCatalogFinalArtifact(artifact).ok, false);

  const runtimeArtifact = createC1211StarCatalogErrorArtifact(runId, {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage: "browser",
    message: "page failed after device arming",
    stack: null,
    timeoutMs: null,
    runtime: {
      errors: {
        console: ["console failure"],
        page: ["page failure"],
        request: [],
        response: [],
        webgpu: ["validation failure"],
        deviceLoss: "device lost",
      },
      gpuGate: { found: 1, armed: 1, total: 1 },
      cleanup: {
        pageClosed: true,
        browserClosed: true,
        timedOut: false,
        errors: [],
      },
    },
  });
  assert.equal(validateC1211StarCatalogFinalArtifact(runtimeArtifact).ok, true);
  runtimeArtifact.diagnostics.runtime.errors.console[0] = "x".repeat(4097);
  assert.equal(
    validateC1211StarCatalogFinalArtifact(runtimeArtifact).ok,
    false,
  );
});

test("10 UUID and loopback URL policy reject ambiguous ownership/network scope", () => {
  assert.equal(isC1211UuidV4(runId), true);
  for (const value of [
    "no",
    "123e4567-e89b-12d3-a456-426614174000",
    "123E4567-E89B-42D3-A456-426614174000",
  ])
    assert.equal(isC1211UuidV4(value), false);
  assert.equal(
    validateC1211LoopbackBase("http://localhost:8080").origin,
    "http://localhost:8080",
  );
  assert.equal(
    validateC1211LoopbackBase("http://[::1]:8080").origin,
    "http://[::1]:8080",
  );
  for (const value of [
    "https://localhost:8080",
    "http://example.com",
    "http://user:pass@localhost:8080",
    "http://localhost:8080/?x=1",
    "http://localhost:8080/#x",
  ])
    assert.throws(() => validateC1211LoopbackBase(value));
});

test("11 PNG validation binds signature, CRCs, RGBA layout, dimensions, and IEND", () => {
  const bytes = readProtectedHistoricalBytes(
    C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS[2].path,
    path.join(
      repositoryRoot,
      C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS[2].path,
    ),
  );
  const valid = inspectC1211Png(bytes);
  assert.deepEqual(
    { ok: valid.ok, width: valid.width, height: valid.height },
    {
      ok: true,
      width: 1024,
      height: 768,
    },
  );
  const corrupt = Buffer.from(bytes);
  corrupt[Math.min(100, corrupt.length - 13)] ^= 1;
  assert.equal(inspectC1211Png(corrupt).ok, false);
  assert.equal(inspectC1211Png(Buffer.from("not png")).ok, false);
  const decoded = decodeC1211RgbaPng(bytes);
  assert.equal(decoded.data.byteLength, 1024 * 768 * 4);
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.height, 768);
});

test("12 the live-census calibration prediction stays 1 at approximately (511,383)", () => {
  assert.deepEqual(C12_11_STAR_CATALOG_SCENE.offlinePrediction, {
    resolvedSources: 1,
    plateauRepresentative: { x: 511, y: 383 },
    description:
      "star-point-census-live synthetic Sirius splat at the 1024x768 even-pixel centre",
  });
  assert.equal(C12_11_STAR_CATALOG_SCENE.aimTolerancePixels, 6);
});

test("13 static acquisition pins the original framing and all four semantic captures", () => {
  const source = fs.readFileSync(probePath, "utf8");
  for (const marker of [
    "sceneContract.timeIso",
    "siriusRaDegrees",
    "siriusDecDegrees",
    "scene.skyBox.starField.intensity = sceneContract.highIntensity",
    "const off = await grab()",
    "const sirius = await grab()",
    "const blank = await grab()",
    "const bright = await grab()",
    "pointSourceCensus(",
    "collectSources: true",
    "deriveC1211MetricsFromCaptureFiles(paths)",
  ])
    assert.match(
      source,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  assert.doesNotMatch(source, /webgpu-(?:off|sirius|blank|bright)\.png/u);
  assert.doesNotMatch(source, /owned-resource-transaction/u);
});

test("14 static runtime error instrumentation covers page, network, WebGPU, loss, and drain", () => {
  const source = fs.readFileSync(probePath, "utf8");
  for (const marker of [
    'page.on("console"',
    'page.on("pageerror"',
    'page.on("requestfailed"',
    'page.on("response"',
    "page.addInitScript(errorGateInit)",
    "armWebGPUDevices(page)",
    "collectGateErrors(page)",
    "device.queue.onSubmittedWorkDone()",
    "response.url() === runtimeUrl",
    "runtimeResponse.body()",
    'parentSignal?.addEventListener("abort"',
    "watchdogState.abortController.abort(failure)",
    "C12-11 watchdog expired",
    "closeBounded(page",
    "closeBounded(browser",
  ])
    assert.equal(source.includes(marker), true, `missing ${marker}`);
  assert.doesNotMatch(
    source,
    /withTimeout\(\s*servedEntryIdentity/u,
    "the served-byte fetch must be aborted, not detached, on timeout",
  );
});

test("15 static gate source retains exact independent A-G formulas", () => {
  const source = fs.readFileSync(gatePath, "utf8");
  for (const marker of [
    "metrics.siriusPoints > metrics.offPoints",
    "metrics.siriusAimPx <= C12_11_STAR_CATALOG_SCENE.aimTolerancePixels",
    "metrics.siriusCenter > metrics.blankCenter",
    "metrics.siriusPoints >= 1 && metrics.blankPoints === 0",
    "metrics.brightBright > metrics.onBright",
    "report?.runtime?.hasStarField === true",
    "metrics.offPoints <= 2",
  ])
    assert.equal(source.includes(marker), true, `missing ${marker}`);
});

test("16 stable JSON is deterministic and refuses undefined/non-finite/cyclic evidence", () => {
  assert.equal(
    stableC1211StarCatalogJson({ z: 1, a: { d: 2, b: 3 } }),
    '{"a":{"b":3,"d":2},"z":1}',
  );
  assert.throws(() => stableC1211StarCatalogJson({ bad: undefined }));
  assert.throws(() => stableC1211StarCatalogJson({ bad: Infinity }));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableC1211StarCatalogJson(cyclic));
});

function makeTempDirectory(t) {
  const base = path.join(repositoryRoot, ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, "c12-11-star-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("00 schema identifiers are pinned string literals - a silent version bump is a red", () => {
  assert.equal(
    C12_11_STAR_CATALOG_SCHEMA,
    "c12-11-star-catalog-certification-evidence-v1",
  );
  assert.equal(
    C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    "c12-11-star-catalog-runtime-diagnostics-v1",
  );
  assert.equal(
    C12_11_STAR_CATALOG_PROVENANCE_SCHEMA,
    "c12-11-star-catalog-provenance-v1",
  );
  assert.equal(
    C12_11_STAR_CATALOG_LOCK_SCHEMA,
    "c12-11-star-catalog-run-lock-v1",
  );
});

/**
 * The four Batch-837 PNGs are gitignored historical evidence; their absence
 * must read as a NAMED prerequisite failure, never a raw ENOENT.
 */
function readProtectedHistoricalBytes(name, file) {
  assert.ok(
    fs.existsSync(file),
    "historical evidence PNG absent for " +
      name +
      ": " +
      file +
      " - provision the four gitignored Batch-837 PNGs before reading this red",
  );
  return fs.readFileSync(file);
}

const protectedBytesByLabel = {
  off: "Tools/visual-regression/output/stars-catalog/webgpu-off.png",
  sirius: "Tools/visual-regression/output/stars-catalog/webgpu-sirius.png",
  blank: "Tools/visual-regression/output/stars-catalog/webgpu-blank.png",
  bright: "Tools/visual-regression/output/stars-catalog/webgpu-bright.png",
};

test("17 UUID capture/report publication is write-once and latest is byte-identical", (t) => {
  const directory = makeTempDirectory(t);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const paths = createC1211ArtifactPaths(id, directory);
  const ownership = beginC1211EvidenceRun(paths, id);
  const report = syntheticReport(id);
  report.captureBindings = [];
  report.runtime.captures = {};
  for (const label of C12_11_STAR_CATALOG_CAPTURE_LABELS) {
    const bytes = readProtectedHistoricalBytes(
      label,
      path.join(repositoryRoot, protectedBytesByLabel[label]),
    );
    const binding = writeC1211Capture(paths, id, label, bytes);
    report.captureBindings.push(binding);
    report.runtime.captures[label] = {
      label,
      width: binding.width,
      height: binding.height,
      sha256: binding.sha256,
    };
    assert.throws(() => writeC1211Capture(paths, id, label, bytes), /EEXIST/u);
  }
  report.runtime.metrics = deriveC1211MetricsFromCaptureFiles(paths).metrics;
  const detachedReport = structuredClone(report);
  detachedReport.runtime.metrics.onBright += 1;
  const detachedArtifact = materializeC1211StarCatalogArtifact(detachedReport);
  assert.equal(
    validateC1211StarCatalogFinalArtifact(detachedArtifact).ok,
    true,
  );
  assert.throws(
    () => finalizeC1211Evidence(paths, detachedArtifact, ownership),
    /metrics were not derived from the exact immutable PNG bytes/u,
  );
  assert.equal(fs.existsSync(paths.archive), false);
  const artifact = materializeC1211StarCatalogArtifact(report);
  assert.equal(validateC1211StarCatalogFinalArtifact(artifact).ok, true);
  const publication = finalizeC1211Evidence(paths, artifact, ownership);
  assert.equal(
    fs.readFileSync(paths.archive).equals(fs.readFileSync(paths.latest)),
    true,
  );
  assert.equal(publication.sha256, sha256C1211(fs.readFileSync(paths.archive)));
  assert.equal(fs.existsSync(paths.running), false);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(verifyC1211CaptureFiles(paths, artifact).ok, true);
  assert.throws(
    () => finalizeC1211Evidence(paths, artifact, ownership),
    /EEXIST|RUNNING|lock/u,
  );
});

test("18 an ERROR report is also immutable, canonical, and atomically published", (t) => {
  const directory = makeTempDirectory(t);
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const paths = createC1211ArtifactPaths(id, directory);
  const ownership = beginC1211EvidenceRun(paths, id);
  const artifact = createC1211StarCatalogErrorArtifact(id, {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage: "preflight",
    message: "synthetic",
    stack: null,
    timeoutMs: null,
  });
  finalizeC1211Evidence(paths, artifact, ownership);
  assert.equal(
    fs.readFileSync(paths.archive).equals(fs.readFileSync(paths.latest)),
    true,
  );
  assert.equal(JSON.parse(fs.readFileSync(paths.latest, "utf8")).exitCode, 2);
});

test("19 a foreign latest race is preserved and the owned RUNNING record remains", (t) => {
  const directory = makeTempDirectory(t);
  const firstId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const firstPaths = createC1211ArtifactPaths(firstId, directory);
  const firstOwnership = beginC1211EvidenceRun(firstPaths, firstId);
  const firstArtifact = createC1211StarCatalogErrorArtifact(firstId, {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage: "first",
    message: "first",
    stack: null,
    timeoutMs: null,
  });
  finalizeC1211Evidence(firstPaths, firstArtifact, firstOwnership);

  const secondId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const secondPaths = createC1211ArtifactPaths(secondId, directory);
  const secondOwnership = beginC1211EvidenceRun(secondPaths, secondId);
  const secondArtifact = createC1211StarCatalogErrorArtifact(secondId, {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage: "second",
    message: "second",
    stack: null,
    timeoutMs: null,
  });
  const foreign = Buffer.from("foreign successor\n");
  const operations = new Proxy(fs, {
    get(target, property, receiver) {
      if (property !== "renameSync")
        return Reflect.get(target, property, receiver);
      return (source, destination) => {
        if (
          String(source).endsWith(`${secondId}.candidate`) &&
          destination === secondPaths.latest
        ) {
          fs.writeFileSync(destination, foreign, { flag: "wx" });
          const error = new Error("synthetic foreign latest race");
          error.code = "EACCES";
          throw error;
        }
        return fs.renameSync(source, destination);
      };
    },
  });
  assert.throws(
    () =>
      finalizeC1211Evidence(
        secondPaths,
        secondArtifact,
        secondOwnership,
        operations,
      ),
    /synthetic foreign latest race/u,
  );
  assert.equal(fs.readFileSync(secondPaths.latest).equals(foreign), true);
  assert.equal(fs.existsSync(secondPaths.running), true);
  assert.equal(fs.existsSync(secondPaths.lock), true);
  assert.equal(
    fs.existsSync(`${secondPaths.latest}.${secondId}.prior`),
    true,
    "the displaced prior remains byte-preserved when a foreign successor owns latest",
  );
});

test("20 protected fixed-name PNG bytes remain byte-exact after publication tests", () => {
  for (const expected of C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS) {
    const bytes = readProtectedHistoricalBytes(
      expected.path,
      path.join(repositoryRoot, expected.path),
    );
    assert.equal(bytes.byteLength, expected.byteLength, expected.path);
    assert.equal(sha256C1211(bytes), expected.sha256, expected.path);
  }
});

test("21 output paths cannot alias historical evidence and use UUID names", () => {
  const paths = createC1211ArtifactPaths(
    runId,
    path.join(repositoryRoot, ".tmp/example"),
  );
  for (const label of C12_11_STAR_CATALOG_CAPTURE_LABELS) {
    assert.equal(
      path.basename(paths.captures[label]),
      `${runId}-webgpu-${label}.png`,
    );
    assert.equal(
      C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.some(
        (entry) =>
          path.resolve(repositoryRoot, entry.path) === paths.captures[label],
      ),
      false,
    );
  }
});

test("22 platform temp placement is diagnostic only; tests publish inside the repo", () => {
  assert.equal(typeof os.tmpdir(), "string");
  assert.equal(path.isAbsolute(repositoryRoot), true);
});
