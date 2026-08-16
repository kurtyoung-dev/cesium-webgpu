// @purpose Contract for the C11-90 harness + probe pair: topology expectations, backend/shape authority, watchdog ordering, probe-fleet contract membership.
// @status ACTIVE

import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OUTER_WATCHDOG_GRACE_MS,
  TOPOLOGY_EXPECTATIONS,
  assessBackendAuthority,
  assessShapeAuthority,
  assessTopologyAuthority,
  assessWatchdogOrdering,
  atomicReplace,
  collectFinalRuntimeGateErrors,
  errorLanesAreEmpty,
  isBaseOrigin,
  normalizeProbeBase,
  redactOutputPayload,
} from "./lib/c11-90-primitive-restart-probe.mjs";
import { analyzeProbeSource } from "./lib/probe-fleet-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessHtml = fs.readFileSync(
  path.join(here, "c11-90-primitive-restart-harness.html"),
  "utf8",
);
const harnessModule = fs.readFileSync(
  path.join(here, "c11-90-primitive-restart-harness.mjs"),
  "utf8",
);
const probeEntry = fs.readFileSync(
  path.join(here, "probe-c11-90-primitive-restart-split.mjs"),
  "utf8",
);
const probeImplementation = fs.readFileSync(
  path.join(here, "lib/c11-90-primitive-restart-probe.mjs"),
  "utf8",
);

function webglAuthority() {
  return {
    requestedRenderer: "webgl",
    rendererType: "webgl",
    isWebGL: true,
    isWebGPU: false,
    webgl2: true,
    nativeWebGL2: true,
    nativeDevice: false,
    nativeCanvasContext: false,
    canvasCount: 1,
    canvasWidth: 1000,
    canvasHeight: 760,
  };
}

function webgpuAuthority() {
  return {
    requestedRenderer: "webgpu",
    rendererType: "webgpu",
    isWebGL: false,
    isWebGPU: true,
    webgl2: false,
    nativeWebGL2: false,
    nativeDevice: true,
    nativeCanvasContext: true,
    canvasCount: 1,
    canvasWidth: 1000,
    canvasHeight: 760,
  };
}

function gate(backend) {
  return {
    installed: true,
    requestDeviceCalls: backend === "webgpu" ? 1 : 0,
    armedDevices: backend === "webgpu" ? 1 : 0,
    instrumentationFailures: [],
    webglHookedMethods: ["drawElements", "drawElementsInstanced"],
    gpuPipelineHookedMethods: [
      "createRenderPipeline",
      "createRenderPipelineAsync",
    ],
    webglDrawCalls: [],
    modelPipelineDescriptors: [],
    gpuErrors: [],
    deviceLosses: [],
    unhandledRejections: [],
    windowErrors: [],
  };
}

function model(topologyKey, backend) {
  const expectation = TOPOLOGY_EXPECTATIONS[topologyKey];
  return {
    ready: true,
    show: true,
    activeTopology: topologyKey,
    runtimePrimitiveTypes: [expectation.primitiveType],
    boundingSphere: { radius: 1 },
    nativePrimitives:
      backend === "webgpu"
        ? [
            {
              topology: expectation.webgpuTopology,
              stripIndexFormat: expectation.stripIndexFormat,
              indexFormat: "uint16",
              indexCount: expectation.realizedIndexCount,
              hasIndexBuffer: true,
              hasPipeline: true,
            },
          ]
        : [],
  };
}

function passingTopologyCase(backend, topologyKey) {
  const expectation = TOPOLOGY_EXPECTATIONS[topologyKey];
  const runtimeGate = gate(backend);
  if (backend === "webgl") {
    runtimeGate.webglDrawCalls.push({
      method: "drawElements",
      mode: expectation.webglDrawMode,
      count: expectation.sourceIndexCount,
      type: 0x1403,
    });
  } else {
    runtimeGate.modelPipelineDescriptors.push({
      method: "createRenderPipeline",
      label: "Model PBR [alpha=0,ds=false]",
      topology: expectation.webgpuTopology,
      stripIndexFormat: expectation.stripIndexFormat,
    });
  }
  return {
    backend,
    topologyKey,
    model: model(topologyKey, backend),
    runtimeGate,
  };
}

function assessTopologyCase(value) {
  return assessTopologyAuthority(
    value.backend,
    value.topologyKey,
    value.model,
    value.runtimeGate,
  );
}

function expectSingleMutationRejected(baseline, mutate, expectedFailure) {
  const baselineAssessment = assessTopologyCase(baseline);
  assert.equal(
    baselineAssessment.pass,
    true,
    `baseline must pass before mutation: ${baselineAssessment.failures.join("; ")}`,
  );
  const mutant = structuredClone(baseline);
  mutate(mutant);
  const mutantAssessment = assessTopologyCase(mutant);
  assert.equal(mutantAssessment.pass, false);
  assert.ok(
    mutantAssessment.failures.some((failure) =>
      failure.includes(expectedFailure),
    ),
    `expected ${JSON.stringify(expectedFailure)} in ${JSON.stringify(
      mutantAssessment.failures,
    )}`,
  );
}

function shapeComponent(topologyKey, pixels = 1000) {
  if (topologyKey === "triangle-strips") {
    return {
      pixels,
      bounds: { minimumX: 0, maximumX: 9, minimumY: 0, maximumY: 39 },
      width: 10,
      height: 40,
      verticalAspect: 4,
      elongation: 4,
    };
  }
  return {
    pixels,
    bounds: { minimumX: 0, maximumX: 39, minimumY: 0, maximumY: 37 },
    width: 40,
    height: 38,
    verticalAspect: 0.95,
    elongation: 40 / 38,
  };
}

function passingShapeMetrics(topologyKey) {
  return {
    significantComponentCount: 9,
    significantComponentPixels: 9000,
    significantComponentCoverage: 0.95,
    significantComponents: Array.from({ length: 9 }, () =>
      shapeComponent(topologyKey),
    ),
    componentBalance: 1,
  };
}

function expectShapeMutationRejected(topologyKey, mutate, expectedFailure) {
  const baseline = passingShapeMetrics(topologyKey);
  assert.equal(assessShapeAuthority(topologyKey, baseline).pass, true);
  const mutant = structuredClone(baseline);
  mutate(mutant);
  const assessment = assessShapeAuthority(topologyKey, mutant);
  assert.equal(assessment.pass, false);
  assert.ok(
    assessment.failures.some((failure) => failure.includes(expectedFailure)),
    JSON.stringify(assessment.failures),
  );
}

test("the harness uses isolated strict concrete backends, not Split UI state", () => {
  assert.match(harnessModule, /new Set\(\["webgl", "webgpu"\]\)/);
  assert.match(harnessModule, /renderer,\s*\n\s*strictRenderer: true/);
  assert.match(harnessModule, /Cesium\.Viewer\.createAsync/);
  assert.doesNotMatch(
    `${harnessHtml}\n${harnessModule}\n${probeImplementation}`,
    /bucket-split-label|waitForSplitPanes|standalone\.html/,
  );
  assert.match(probeImplementation, /\?renderer=\$\{backend\}/);
  assert.match(probeImplementation, /canvasCount !== 1/);
});

test("the two shipped triangle fixtures and exact realization counts are frozen", () => {
  assert.deepEqual(Object.keys(TOPOLOGY_EXPECTATIONS), [
    "triangle-strips",
    "triangle-fans",
  ]);
  assert.deepEqual(TOPOLOGY_EXPECTATIONS["triangle-strips"], {
    label: "Triangle Strips",
    primitiveType: 5,
    sourceIndexCount: 98,
    realizedIndexCount: 98,
    webglDrawMode: 5,
    webgpuTopology: "triangle-strip",
    stripIndexFormat: "uint16",
  });
  assert.equal(TOPOLOGY_EXPECTATIONS["triangle-fans"].sourceIndexCount, 98);
  assert.equal(TOPOLOGY_EXPECTATIONS["triangle-fans"].realizedIndexCount, 216);
  assert.match(harnessModule, /primitive-restart-triangle-strip\.glb/);
  assert.match(harnessModule, /primitive-restart-triangle-fan\.glb/);
});

test("backend authority rejects fallback, WebGL1, and vacuous device gates", () => {
  const passingWebglGate = gate("webgl");
  const passingWebgpuGate = gate("webgpu");
  assert.equal(
    assessBackendAuthority("webgl", webglAuthority(), passingWebglGate).pass,
    true,
  );
  assert.equal(
    assessBackendAuthority("webgpu", webgpuAuthority(), passingWebgpuGate).pass,
    true,
  );

  const fallback = webgpuAuthority();
  fallback.rendererType = "webgl";
  fallback.isWebGPU = false;
  fallback.isWebGL = true;
  assert.equal(
    assessBackendAuthority("webgpu", fallback, passingWebgpuGate).pass,
    false,
  );
  const webgl1 = webglAuthority();
  webgl1.webgl2 = false;
  assert.equal(
    assessBackendAuthority("webgl", webgl1, passingWebglGate).pass,
    false,
  );
  const noDevice = gate("webgpu");
  noDevice.requestDeviceCalls = 0;
  noDevice.armedDevices = 0;
  assert.equal(
    assessBackendAuthority("webgpu", webgpuAuthority(), noDevice).pass,
    false,
  );
});

test("WebGL topology authority requires the active exact indexed uint16 draw", async (t) => {
  for (const topologyKey of Object.keys(TOPOLOGY_EXPECTATIONS)) {
    const baseline = passingTopologyCase("webgl", topologyKey);
    assert.equal(assessTopologyCase(baseline).pass, true);
  }

  const mutations = [
    [
      "method",
      (value) => (value.runtimeGate.webglDrawCalls[0].method = "drawArrays"),
    ],
    ["count", (value) => (value.runtimeGate.webglDrawCalls[0].count = 97)],
    ["type", (value) => (value.runtimeGate.webglDrawCalls[0].type = 0x1405)],
    ["mode", (value) => (value.runtimeGate.webglDrawCalls[0].mode = 4)],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(`rejects the ${name} mutant from a passing baseline`, () => {
      expectSingleMutationRejected(
        passingTopologyCase("webgl", "triangle-strips"),
        mutate,
        "indexed WebGL with exactly 98 uint16 indices",
      );
    });
  }
  await t.test("rejects a stale inactive model from a passing baseline", () => {
    expectSingleMutationRejected(
      passingTopologyCase("webgl", "triangle-strips"),
      (value) => (value.model.activeTopology = "triangle-fans"),
      "active requested topology",
    );
  });
});

test("WebGPU strip-format and fan-expansion mutants start from complete passing gates", () => {
  const stripBaseline = passingTopologyCase("webgpu", "triangle-strips");
  expectSingleMutationRejected(
    stripBaseline,
    (value) => (value.model.nativePrimitives[0].stripIndexFormat = null),
    "primitive realization is not exact",
  );

  const fanBaseline = passingTopologyCase("webgpu", "triangle-fans");
  expectSingleMutationRejected(
    fanBaseline,
    (value) => (value.model.nativePrimitives[0].indexCount = 98),
    "primitive realization is not exact",
  );
});

test("late final GPU, loss, promise, and window errors each fail the cumulative verdict", async (t) => {
  const errorKinds = [
    "gpuErrors",
    "deviceLosses",
    "unhandledRejections",
    "windowErrors",
  ];
  for (const errorKind of errorKinds) {
    await t.test(
      `${errorKind} is not hidden by an earlier clean snapshot`,
      () => {
        const baseline = {
          webgl: { gate: gate("webgl") },
          webgpu: { gate: gate("webgpu") },
        };
        assert.deepEqual(collectFinalRuntimeGateErrors(baseline), []);
        assert.equal(errorLanesAreEmpty({ runtimeGateErrors: [] }), true);

        const mutant = structuredClone(baseline);
        mutant.webgpu.gate[errorKind].push(
          errorKind === "deviceLosses"
            ? { reason: "unknown", message: "late failure" }
            : "late failure",
        );
        const runtimeGateErrors = collectFinalRuntimeGateErrors(mutant);
        assert.equal(runtimeGateErrors.length, 1);
        assert.equal(runtimeGateErrors[0].kind, errorKind);
        assert.equal(errorLanesAreEmpty({ runtimeGateErrors }), false);
      },
    );
  }
  assert.match(probeImplementation, /await drainFinalEventTurns\(lanes\)/);
  assert.match(
    probeImplementation,
    /collectFinalRuntimeGateErrors\(finalLaneEvidence\)/,
  );
});

test("shape authority requires exactly nine balanced and covered authored shapes", async (t) => {
  assert.equal(
    assessShapeAuthority(
      "triangle-strips",
      passingShapeMetrics("triangle-strips"),
    ).pass,
    true,
  );
  assert.equal(
    assessShapeAuthority("triangle-fans", passingShapeMetrics("triangle-fans"))
      .pass,
    true,
  );

  const mutations = [
    [
      "count",
      "triangle-strips",
      (value) => (value.significantComponentCount = 8),
      "exactly nine",
    ],
    [
      "coverage",
      "triangle-strips",
      (value) => (value.significantComponentCoverage = 0.5),
      "cover enough",
    ],
    [
      "balance",
      "triangle-strips",
      (value) => (value.componentBalance = 0.4),
      "size-balanced",
    ],
    [
      "strip aspect",
      "triangle-strips",
      (value) => (value.significantComponents[0].verticalAspect = 1),
      "vertically tall",
    ],
    [
      "fan aspect",
      "triangle-fans",
      (value) => (value.significantComponents[0].elongation = 2),
      "near-round",
    ],
  ];
  for (const [name, topologyKey, mutate, expectedFailure] of mutations) {
    await t.test(`rejects the ${name} mutant from a passing baseline`, () => {
      expectShapeMutationRejected(topologyKey, mutate, expectedFailure);
    });
  }
  assert.match(
    probeImplementation,
    /bounds: \{ minimumX, maximumX, minimumY, maximumY \}/,
  );
});

test("the artifact watchdog wins with at least thirty seconds of outer grace", () => {
  const artifactWatchdogMs = 240_000;
  const passingOuter = artifactWatchdogMs + OUTER_WATCHDOG_GRACE_MS;
  assert.equal(OUTER_WATCHDOG_GRACE_MS, 30_000);
  assert.equal(assessWatchdogOrdering(artifactWatchdogMs, passingOuter), true);
  assert.equal(
    assessWatchdogOrdering(artifactWatchdogMs, passingOuter - 1),
    false,
  );
  assert.equal(
    assessWatchdogOrdering(artifactWatchdogMs, artifactWatchdogMs),
    false,
  );
  assert.match(probeEntry, /WATCHDOG_MS \+ OUTER_WATCHDOG_GRACE_MS/);
  assert.doesNotMatch(probeEntry, /}, 240_000\)/);
});

test("runtime stays on the configured origin and every output query value is redacted", () => {
  assert.equal(
    normalizeProbeBase("http://localhost:8080"),
    "http://localhost:8080",
  );
  assert.equal(
    isBaseOrigin("/Source/Cesium.js", "http://localhost:8080"),
    true,
  );
  assert.equal(
    isBaseOrigin(
      "http://localhost:8080/model.glb?token=secret",
      "http://localhost:8080",
    ),
    true,
  );
  assert.equal(
    isBaseOrigin("https://foreign.invalid/success", "http://localhost:8080"),
    false,
  );
  assert.equal(
    isBaseOrigin("http://localhost:8081/success", "http://localhost:8080"),
    false,
  );
  for (const invalidBase of [
    "ftp://localhost:8080",
    "http://user:password@localhost:8080",
    "http://localhost:8080/path",
    "http://localhost:8080?token=secret",
  ]) {
    assert.throws(() => normalizeProbeBase(invalidBase), /STRUCTURAL:/);
  }

  const secretValues = [
    "token-secret",
    "access-secret",
    "signature-secret",
    "encoded-secret",
    "ordinary-secret",
  ];
  const sanitized = redactOutputPayload({
    url: "https://foreign.invalid/asset?token=token-secret&ACCESS_TOKEN=access-secret&sig=signature-secret&se%73sion=encoded-secret&plain=ordinary-secret#fragment",
    diagnostic:
      "request failed https://foreign.invalid/asset?api_key=token-secret&signature=signature-secret",
    location: {
      url: "http://localhost:8080/app.mjs?client_secret=access-secret",
    },
  });
  const serialized = JSON.stringify(sanitized);
  for (const secret of secretValues) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.match(serialized, /token=\[REDACTED\]/);
  assert.match(serialized, /ACCESS_TOKEN=\[REDACTED\]/);
  assert.match(serialized, /sig=\[REDACTED\]/);
  assert.match(serialized, /se%73sion=\[REDACTED\]/);
  assert.match(serialized, /plain=\[REDACTED\]/);
  assert.match(probeImplementation, /page\.route\("\*\*\/\*"/);
  assert.match(probeImplementation, /errors\.nonBaseResponses\.push/);
  assert.match(probeImplementation, /serializeJson\(\{/);
});

test("atomicReplace preserves the canonical and removes its temp after rename failure", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-90-atomic-"));
  const canonical = path.join(directory, "canonical.json");
  fs.writeFileSync(canonical, "old canonical\n");
  let temporary;
  const operations = {
    writeFileSync(filePath, bytes, options) {
      temporary = filePath;
      fs.writeFileSync(filePath, bytes, options);
    },
    renameSync() {
      throw new Error("injected rename failure");
    },
    rmSync: fs.rmSync,
  };
  try {
    assert.throws(
      () => atomicReplace(canonical, "new canonical\n", operations),
      /injected rename failure/,
    );
    assert.equal(fs.readFileSync(canonical, "utf8"), "old canonical\n");
    assert.equal(fs.existsSync(temporary), false);
    assert.deepEqual(fs.readdirSync(directory), ["canonical.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("viewer recreation, provenance, immutable output, and all error lanes fail closed", () => {
  assert.match(harnessModule, /oldViewerDestroyed: oldViewer\.isDestroyed\(\)/);
  assert.match(
    harnessModule,
    /canvasReplaced: oldCanvas !== viewer\.scene\.canvas/,
  );
  assert.match(
    harnessModule,
    /contextReplaced: oldContext !== viewer\.scene\.context/,
  );
  assert.match(probeImplementation, /errorLanesAreEmpty\(errors\)/);
  assert.match(probeImplementation, /collectLocalProvenance/);
  assert.match(probeImplementation, /provenanceStable/);
  assert.match(probeImplementation, /flag: "wx"/);
  assert.match(probeImplementation, /browserControl\.browser\?\.close\(\)/);
  assert.match(
    probeImplementation,
    /pre-existing first-red stayed byte-identical/,
  );
  assert.match(probeImplementation, /canonical artifact is not byte-identical/);
  assert.match(probeEntry, /runPrimitiveRestartProbe/);
});

test("the historical probe entry satisfies the fleet analyzer without an allowlist", () => {
  const analysis = analyzeProbeSource(probeEntry);
  assert.equal(analysis.launchesBrowser, true);
  assert.equal(analysis.hasWatchdog, true);
  assert.equal(analysis.closesBrowser, true);
  assert.equal(analysis.closeInFinally, true);
  assert.deepEqual(analysis.violations, []);
  assert.deepEqual(analysis.verdictExitViolations, []);
});
