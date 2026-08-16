// C11-13 — browser-free policy and mutant suite for the physical Edge probe.
// @purpose Browser-free policy + mutant suite for the physical Edge inside-camera voxel probe: waypoint sequence, pixel/command evidence, watchdog ordering.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-13-voxel-inside-camera-probe.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BACKENDS,
  COMMAND_NAMES,
  ERROR_LANE_NAMES,
  OUTER_WATCHDOG_GRACE_MS,
  PIXEL_TOLERANCES,
  WAYPOINTS,
  assessBackendAuthority,
  assessBuildProvenance,
  assessCommandSnapshot,
  assessCrossBackendEvidence,
  assessOutsideReturn,
  assessPixelEvidence,
  assessProviderEvidence,
  assessWatchdogOrdering,
  assessWaypointSequence,
  atomicReplace,
  classifyExpectedConsoleWarning,
  compareBackendCaptures,
  createImmutable,
  decodeCanvasPngDataUrl,
  errorLanesAreEmpty,
  expectedConsoleWarningsAreValid,
  isBaseOrigin,
  normalizeCanvasClip,
  normalizeProbeBase,
  preserveFirstRed,
  provenanceStable,
  recordConsoleWarning,
  redactOutputPayload,
  withWatchdog,
} from "./lib/c11-13-voxel-inside-camera-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = {
  html: fs.readFileSync(
    path.join(here, "c11-13-voxel-inside-camera-harness.html"),
    "utf8",
  ),
  harness: fs.readFileSync(
    path.join(here, "c11-13-voxel-inside-camera-harness.mjs"),
    "utf8",
  ),
  implementation: fs.readFileSync(
    path.join(here, "lib/c11-13-voxel-inside-camera-probe.mjs"),
    "utf8",
  ),
  entry: fs.readFileSync(
    path.join(here, "probe-c11-13-voxel-inside-camera.mjs"),
    "utf8",
  ),
  sceneRenderer: fs
    .readFileSync(
      path.resolve(
        "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
      ),
      "utf8",
    )
    .replaceAll("\r\n", "\n"),
  scenePassRedirect: fs
    .readFileSync(
      path.resolve(
        "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPassRedirect.ts",
      ),
      "utf8",
    )
    .replaceAll("\r\n", "\n"),
};

const EXPECTED_WAYPOINTS = [
  ["outside-positive-initial", "1.05", false],
  ["inside-positive-near", "0.9", true],
  ["inside-positive-deep", "0.55", true],
  ["inside-negative-deep", "-0.55", true],
  ["inside-negative-near", "-0.9", true],
  ["outside-negative", "-1.05", false],
  ["outside-positive-return", "1.05", false],
];

function assessPhysicalProbePolicy(candidate) {
  const failures = [];
  function requirePattern(name, text, pattern) {
    if (!pattern.test(text)) failures.push(name);
  }

  requirePattern(
    "HTML must use the isolated harness module",
    candidate.html,
    /c11-13-voxel-inside-camera-harness\.mjs/u,
  );
  requirePattern(
    "HTML must suppress favicon requests",
    candidate.html,
    /rel="icon" href="data:,"/u,
  );
  requirePattern(
    "HTML must import the unminified engine build",
    candidate.html,
    /packages\/engine\/Build\/Unminified\/index\.js/u,
  );
  requirePattern(
    "harness must import the in-tree L3 fixture",
    candidate.harness,
    /from "\.\/fixtures\/voxel-octree-l3\.mjs"/u,
  );
  requirePattern(
    "harness must instantiate the exact fixture",
    candidate.harness,
    /provider = createVoxelOctreeL3Provider\(Cesium, EARTH_RADIUS\)/u,
  );
  requirePattern(
    "harness must preserve three advertised levels",
    candidate.harness,
    /availableLevelsConstant: AVAILABLE_LEVELS/u,
  );
  requirePattern(
    "harness must disable the default render loop",
    candidate.harness,
    /useDefaultRenderLoop: false/u,
  );
  requirePattern(
    "harness must fix octree SSE for deterministic root data",
    candidate.harness,
    /PROBE_SCREEN_SPACE_ERROR = 1\.0e12/u,
  );
  requirePattern(
    "harness must carry GLSL and WGSL voxel shaders",
    candidate.harness,
    /fragmentShaderText: GLSL_FRAGMENT,[\s\S]*wgslFragmentShaderText: WGSL_FRAGMENT/u,
  );
  requirePattern(
    "harness must enable TAA to materialize velocity",
    candidate.harness,
    /scene\.taaEnabled = renderer === "webgpu"/u,
  );
  requirePattern(
    "harness must disable TAA before deterministic pixels",
    candidate.harness,
    /scene\.taaEnabled = false;[\s\S]*await renderFrames\(16\)/u,
  );
  requirePattern(
    "harness must render and freeze its PNG in the same task",
    candidate.harness,
    /viewer\.scene\.render\(\);\s*const canvas = viewer\.scene\.canvas;[\s\S]{0,500}canvas\.toDataURL\("image\/png"\)/u,
  );
  requirePattern(
    "harness must report native WebGL drawing-buffer dimensions",
    candidate.harness,
    /nativeDrawingBufferWidth: gl\?\.drawingBufferWidth \?\? canvas\.width,[\s\S]{0,100}nativeDrawingBufferHeight: gl\?\.drawingBufferHeight \?\? canvas\.height/u,
  );
  const captureFunctionIndex = candidate.harness.indexOf(
    "async function capturePixels",
  );
  const finalRenderIndex = candidate.harness.indexOf(
    "viewer.scene.render();",
    captureFunctionIndex,
  );
  const snapshotIndex = candidate.harness.indexOf(
    'canvas.toDataURL("image/png")',
    finalRenderIndex,
  );
  if (
    captureFunctionIndex < 0 ||
    finalRenderIndex < 0 ||
    snapshotIndex < 0 ||
    /\bawait\b/u.test(candidate.harness.slice(finalRenderIndex, snapshotIndex))
  ) {
    failures.push("harness yielded between the final render and PNG snapshot");
  }
  for (const token of [
    "color: commandEvidence(color)",
    "objectPick: commandEvidence(objectPick)",
    "cellPick: commandEvidence(cellPick)",
    "velocity: commandEvidence(velocity)",
    "objectPickAttached",
    "cellPickAttached",
    "velocityAttached",
  ]) {
    if (!candidate.harness.includes(token)) {
      failures.push(`harness lost command evidence: ${token}`);
    }
  }
  for (const [sourceName, text] of [
    ["harness", candidate.harness],
    ["implementation", candidate.implementation],
  ]) {
    let cursor = -1;
    for (const [id, factor, inside] of EXPECTED_WAYPOINTS) {
      const snippet = `id: "${id}", factor: ${factor}, inside: ${inside}`;
      const pattern = new RegExp(
        `id: "${id}",[\\s\\S]{0,80}factor: ${factor.replace(".", "\\.")},[\\s\\S]{0,40}inside: ${inside}`,
        "u",
      );
      const relativeNext = text.slice(cursor + 1).search(pattern);
      const next = relativeNext < 0 ? -1 : cursor + 1 + relativeNext;
      if (next <= cursor) {
        failures.push(`${sourceName} lost ordered waypoint ${snippet}`);
        break;
      }
      cursor = next;
    }
  }

  for (const token of [
    "assessPixelEvidence",
    "assessCrossBackendEvidence",
    "bothNonVacuous",
    "footprintIou",
    "meanColorL1",
    "minimumCenterPatchNonBlackPixels",
    "assessCommandSnapshot",
    "for (const name of COMMAND_NAMES)",
    'command.indexFormat !== "uint16"',
    "assessOutsideReturn",
    "rawSha256 !== returned?.metrics?.rawSha256",
    'writeFileSync(filePath, bytes, { flag: "wx" })',
    "preserveFirstRed",
    "Promise.race",
    'page.route("**/*"',
    "nonBaseRequests",
    "gpuErrors",
    "deviceLosses",
    "rendererSource",
    "engineBundle",
    "providerFixture",
    "runtimeResponses",
    "STABILITY_STREAK = 3",
    "createImmutable(runArtifact, artifactBytes)",
    "atomicReplace(CANONICAL_ARTIFACT, artifactBytes)",
    "preserveFirstRed(FIRST_RED_ARTIFACT, artifactBytes)",
    "await context.close()",
    "await browser.close()",
    "cleanupErrors",
    "const settledProbe = await observedTask",
    "normalizeCanvasClip",
    "__c1113VoxelInsideHarness.capturePixels(frameCount)",
    "!captured?.capture || !captured?.evidence",
    "capture.nativeDrawingBufferWidth !== capture.drawingBufferWidth",
    "capture.nativeDrawingBufferHeight !== capture.drawingBufferHeight",
    "analyzed.metrics.width !== capture.drawingBufferWidth",
    "analyzed.metrics.height !== capture.drawingBufferHeight",
    "decodeCanvasPngDataUrl",
    "browserControl.probeTaskDrained = true",
    "expectedConsoleWarningsAreValid(diagnostics.allowedConsoleWarnings)",
    "classifyExpectedConsoleWarning(record, baseOrigin)",
    "warningCheck.pass = expectedConsoleWarningsAreValid",
    "recordConsoleWarning(record, errors, diagnostics)",
  ]) {
    if (!candidate.implementation.includes(token)) {
      failures.push(`probe implementation lost fail-closed token: ${token}`);
    }
  }
  for (const token of [
    'channel: "msedge"',
    '"--enable-unsafe-webgpu"',
    '"--use-vulkan"',
    "OUTER_WATCHDOG_GRACE_MS",
    "clearTimeout(watchdog)",
    "await browser.close()",
  ]) {
    if (!candidate.entry.includes(token)) {
      failures.push(`entry lost Edge/watchdog cleanup token: ${token}`);
    }
  }
  for (const [name, text, token] of [
    [
      "executeCommands diagnostic must stay informational",
      candidate.sceneRenderer,
      "console.log(\n        `[WebGPU:SceneRenderer] executeCommands called — `",
    ],
    [
      "post-init diagnostic must stay informational",
      candidate.sceneRenderer,
      "console.log(\n        `[WebGPU:SceneRenderer] POST-INIT state — `",
    ],
    [
      "successful render-pass redirect must stay informational",
      candidate.scenePassRedirect,
      "console.log(\n          `[WebGPU:SceneRenderer] RENDER PASS REDIRECT — `",
    ],
    [
      "failed render-pass redirect must stay an error",
      candidate.scenePassRedirect,
      "console.error(\n        `[WebGPU:SceneRenderer] RENDER PASS REDIRECT FAILED — `",
    ],
  ]) {
    if (!text.includes(token)) failures.push(name);
  }
  return failures;
}

function passingAuthority(backend) {
  return {
    requestedRenderer: backend,
    rendererType: backend,
    isWebGL: backend === "webgl",
    isWebGPU: backend === "webgpu",
    webgl2: backend === "webgl",
    nativeWebGL2: backend === "webgl",
    nativeDevice: backend === "webgpu",
    nativeCanvasContext: backend === "webgpu",
    canvasCount: 1,
    canvasWidth: 960,
    canvasHeight: 720,
  };
}

function passingGate(backend) {
  return {
    installed: true,
    requestDeviceCalls: backend === "webgpu" ? 1 : 0,
    armedDevices: backend === "webgpu" ? 1 : 0,
    webglDrawCalls: backend === "webgl" ? 10 : 0,
    instrumentationFailures: [],
  };
}

function passingProvider() {
  return {
    fixture: "voxel-octree-l3",
    availableLevelsConstant: 3,
    availableLevels: 3,
    tileConstant: 4,
    dimensions: [4, 4, 4],
    names: ["color"],
    types: ["VEC4"],
    componentTypes: ["FLOAT32"],
    shape: "BOX",
    metadataOrder: 1,
    earthRadius: 6378137.0,
  };
}

function passingPrimitive() {
  return {
    ready: true,
    show: true,
    nearestSampling: true,
    screenSpaceError: 1.0e12,
    customShaderHasGlsl: true,
    customShaderHasWgsl: true,
  };
}

function passingCommandSnapshot(firstIndex) {
  return {
    commands: Object.fromEntries(
      COMMAND_NAMES.map((name) => [
        name,
        {
          present: true,
          firstIndex,
          indexCount: 36,
          indexFormat: "uint16",
          indexed: true,
        },
      ]),
    ),
    allMaterialized: true,
    objectPickAttached: true,
    cellPickAttached: true,
    velocityAttached: true,
    usingRealData: true,
    uploadPhase: "done",
    colorDescriptorName: "Voxel color pipeline (userCustomShader#1234)",
    materializationFrames: 10,
  };
}

function passingMetrics(hash = "A".repeat(64)) {
  return {
    width: 960,
    height: 720,
    pixelCount: 960 * 720,
    rawSha256: hash,
    nonBlackPixels: 20_000,
    nonBlackFraction: 20_000 / (960 * 720),
    interiorNonBlackPixels: 15_000,
    centerPatchNonBlackPixels: 40,
    centerPixelMaximum: 180,
    meanRgb: [45, 155, 65],
    greenDominance: 90,
    boundingBox: { width: 400, height: 360 },
  };
}

function passingComparison() {
  return {
    comparable: true,
    bothNonVacuous: true,
    footprintIou: 0.8,
    footprintRatio: 1.0,
    boundingBoxWidthRatio: 1.0,
    boundingBoxHeightRatio: 1.0,
    meanColorL1: 10,
  };
}

function passingWaypointResults() {
  return Object.fromEntries(
    WAYPOINTS.map((waypoint) => {
      const expectedFirstIndex = waypoint.inside ? 36 : 0;
      const waypointEvidence = {
        id: waypoint.id,
        factor: waypoint.factor,
        inside: waypoint.inside,
        expectedFirstIndex,
      };
      return [
        waypoint.id,
        {
          backends: {
            webgl: {
              metrics: passingMetrics(),
              evidence: {
                waypoint: { ...waypointEvidence, commandSnapshot: null },
              },
            },
            webgpu: {
              metrics: passingMetrics(),
              evidence: {
                waypoint: {
                  ...waypointEvidence,
                  commandSnapshot: passingCommandSnapshot(expectedFirstIndex),
                },
              },
            },
          },
        },
      ];
    }),
  );
}

test("physical probe source policy is complete and static mutants are rejected", () => {
  assert.deepEqual(assessPhysicalProbePolicy(sources), []);
  const mutants = [
    ["harness", "./fixtures/voxel-octree-l3.mjs", "./fixtures/wrong.mjs"],
    ["harness", "useDefaultRenderLoop: false", "useDefaultRenderLoop: true"],
    ["harness", "velocity: commandEvidence(velocity)", "velocity: null"],
    ["harness", "scene.taaEnabled = false", "scene.taaEnabled = true"],
    [
      "harness",
      "viewer.scene.render();\n  const canvas = viewer.scene.canvas;",
      "await nextEventTurn();\n  const canvas = viewer.scene.canvas;",
    ],
    ["harness", 'canvas.toDataURL("image/png")', '"data:image/png;base64,"'],
    [
      "harness",
      "const rectangle = canvas.getBoundingClientRect();",
      "await nextEventTurn();\n  const rectangle = canvas.getBoundingClientRect();",
    ],
    ["implementation", "bothNonVacuous", "bothCouldBeBlack"],
    ["implementation", "assessCommandSnapshot", "skipCommandSnapshot"],
    ["implementation", '{ flag: "wx" }', '{ flag: "w" }'],
    [
      "implementation",
      "createImmutable(runArtifact, artifactBytes)",
      "atomicReplace(runArtifact, artifactBytes)",
    ],
    ["implementation", "await context.close()", "void context.close()"],
    [
      "implementation",
      "const settledProbe = await observedTask",
      "const settledProbe = observedTask",
    ],
    ["implementation", 'page.route("**/*"', 'page.route("external-only"'],
    ["implementation", "!captured?.capture || !captured?.evidence", "false"],
    [
      "implementation",
      "capture.nativeDrawingBufferWidth !== capture.drawingBufferWidth",
      "false",
    ],
    [
      "implementation",
      "capture.nativeDrawingBufferHeight !== capture.drawingBufferHeight",
      "false",
    ],
    [
      "implementation",
      "analyzed.metrics.width !== capture.drawingBufferWidth",
      "false",
    ],
    [
      "implementation",
      "analyzed.metrics.height !== capture.drawingBufferHeight",
      "false",
    ],
    [
      "implementation",
      "warningCheck.pass = expectedConsoleWarningsAreValid",
      "warningCheck.pass = true || expectedConsoleWarningsAreValid",
    ],
    [
      "implementation",
      "recordConsoleWarning(record, errors, diagnostics)",
      "void record",
    ],
    ["entry", 'channel: "msedge"', 'channel: "chromium"'],
    ["entry", '"--use-vulkan"', '"--disable-vulkan"'],
    [
      "sceneRenderer",
      "console.log(\n        `[WebGPU:SceneRenderer] executeCommands called — `",
      "console.warn(\n        `[WebGPU:SceneRenderer] executeCommands called — `",
    ],
    [
      "sceneRenderer",
      "console.log(\n        `[WebGPU:SceneRenderer] POST-INIT state — `",
      "console.warn(\n        `[WebGPU:SceneRenderer] POST-INIT state — `",
    ],
    [
      "scenePassRedirect",
      "console.log(\n          `[WebGPU:SceneRenderer] RENDER PASS REDIRECT — `",
      "console.warn(\n          `[WebGPU:SceneRenderer] RENDER PASS REDIRECT — `",
    ],
    [
      "scenePassRedirect",
      "console.error(\n        `[WebGPU:SceneRenderer] RENDER PASS REDIRECT FAILED — `",
      "console.log(\n        `[WebGPU:SceneRenderer] RENDER PASS REDIRECT FAILED — `",
    ],
  ];
  for (const [file, before, after] of mutants) {
    const mutant = {
      ...sources,
      [file]: sources[file].replaceAll(before, after),
    };
    assert.notEqual(
      mutant[file],
      sources[file],
      `${file} mutant ${before} must change the source`,
    );
    assert.notDeepEqual(
      assessPhysicalProbePolicy(mutant),
      [],
      `${file} mutant ${before} must be rejected`,
    );
  }
});

test("canvas capture freezes the final render in-task and validates exact dimensions", () => {
  assert.deepEqual(
    normalizeCanvasClip(
      { x: 0, y: 0, width: 960, height: 720 },
      { width: 960, height: 720 },
    ),
    { x: 0, y: 0, width: 960, height: 720 },
  );
  for (const invalid of [
    undefined,
    {},
    { x: -1, y: 0, width: 960, height: 720 },
    { x: 0, y: 0, width: 0, height: 720 },
    { x: 0, y: 0, width: 960, height: Number.NaN },
    { x: 1, y: 0, width: 960, height: 720 },
  ]) {
    assert.throws(
      () => normalizeCanvasClip(invalid, { width: 960, height: 720 }),
      /STRUCTURAL/,
    );
  }
  assert.doesNotMatch(
    sources.implementation,
    /\.(?:screenshot)\(/u,
    "Playwright/Chrome screenshot capture hangs on this active GPU canvas",
  );
  assert.match(
    sources.harness,
    /viewer\.scene\.render\(\);\s*const canvas = viewer\.scene\.canvas;[\s\S]{0,500}canvas\.toDataURL\("image\/png"\)/u,
  );
  assert.doesNotMatch(
    sources.implementation,
    /await createImageBitmap|new OffscreenCanvas|context2d\.drawImage|output\.convertToBlob/u,
    "the probe must consume the immutable same-task PNG rather than reread the GPU canvas",
  );
  assert.doesNotMatch(
    sources.implementation,
    /rectangle\.(?:left|top) \+ globalThis\.scroll/u,
    "Playwright page clips use viewport coordinates, not document coordinates",
  );
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("payload"),
  ]);
  assert.deepEqual(
    decodeCanvasPngDataUrl(`data:image/png;base64,${png.toString("base64")}`),
    png,
  );
  for (const invalid of [
    undefined,
    "data:text/plain;base64,AA==",
    "data:image/png;base64,AA==",
  ]) {
    assert.throws(() => decodeCanvasPngDataUrl(invalid), /STRUCTURAL/);
  }
});

test("backend and L3 provider authority fail closed", () => {
  for (const backend of BACKENDS) {
    assert.equal(
      assessBackendAuthority(
        backend,
        passingAuthority(backend),
        passingGate(backend),
      ).pass,
      true,
    );
  }
  const fallback = passingAuthority("webgpu");
  fallback.rendererType = "webgl";
  assert.equal(
    assessBackendAuthority("webgpu", fallback, passingGate("webgpu")).pass,
    false,
  );
  const unarmed = passingGate("webgpu");
  unarmed.armedDevices = 0;
  assert.equal(
    assessBackendAuthority("webgpu", passingAuthority("webgpu"), unarmed).pass,
    false,
  );

  assert.equal(
    assessProviderEvidence(passingProvider(), passingPrimitive()).pass,
    true,
  );
  for (const mutate of [
    (provider) => (provider.availableLevels = 2),
    (provider) => (provider.dimensions = [1, 1, 1]),
    (provider) => (provider.shape = "ELLIPSOID"),
    (provider) => (provider.metadataOrder = 0),
    (provider) => (provider.earthRadius = 1),
    (_provider, primitive) => (primitive.ready = false),
    (_provider, primitive) => (primitive.customShaderHasWgsl = false),
  ]) {
    const provider = passingProvider();
    const primitive = passingPrimitive();
    mutate(provider, primitive);
    assert.equal(assessProviderEvidence(provider, primitive).pass, false);
  }
});

test("all four WebGPU commands are mandatory and exact at 0/36", () => {
  for (const expected of [0, 36]) {
    assert.equal(
      assessCommandSnapshot(passingCommandSnapshot(expected), expected).pass,
      true,
    );
    for (const name of COMMAND_NAMES) {
      const missing = passingCommandSnapshot(expected);
      missing.commands[name] = null;
      assert.equal(
        assessCommandSnapshot(missing, expected).pass,
        false,
        `${name} missing mutant must fail`,
      );
      const wrongRange = passingCommandSnapshot(expected);
      wrongRange.commands[name].firstIndex = expected === 0 ? 36 : 0;
      assert.equal(assessCommandSnapshot(wrongRange, expected).pass, false);
      const wrongFormat = passingCommandSnapshot(expected);
      wrongFormat.commands[name].indexFormat = "uint32";
      assert.equal(assessCommandSnapshot(wrongFormat, expected).pass, false);
    }
  }
  const lazy = passingCommandSnapshot(36);
  lazy.velocityAttached = false;
  assert.equal(assessCommandSnapshot(lazy, 36).pass, false);
});

test("pixel authority rejects black-black, missing interior/center, and wrong color", () => {
  assert.equal(assessPixelEvidence(passingMetrics()).pass, true);
  const mutants = [
    { nonBlackPixels: 0, nonBlackFraction: 0 },
    { interiorNonBlackPixels: 0 },
    { centerPatchNonBlackPixels: 0, centerPixelMaximum: 0 },
    { greenDominance: 0 },
    { rawSha256: null },
    { boundingBox: { width: 1, height: 1 } },
  ];
  for (const mutation of mutants) {
    assert.equal(
      assessPixelEvidence({ ...passingMetrics(), ...mutation }).pass,
      false,
      `pixel mutant ${JSON.stringify(mutation)} must fail`,
    );
  }

  assert.equal(assessCrossBackendEvidence(passingComparison()).pass, true);
  for (const mutation of [
    { bothNonVacuous: false, footprintIou: 1 },
    { footprintIou: 0 },
    { footprintRatio: 0 },
    { boundingBoxWidthRatio: 2 },
    { meanColorL1: PIXEL_TOLERANCES.maximumMeanColorL1 + 1 },
  ]) {
    assert.equal(
      assessCrossBackendEvidence({ ...passingComparison(), ...mutation }).pass,
      false,
      `cross-backend mutant ${JSON.stringify(mutation)} must fail`,
    );
  }
});

test("raw mask comparison cannot pass two empty masks", () => {
  const empty = {
    metrics: {
      ...passingMetrics(),
      nonBlackPixels: 0,
      boundingBox: null,
      meanRgb: [0, 0, 0],
    },
    mask: new Uint8Array(32),
  };
  const blackBlack = compareBackendCaptures(empty, structuredClone(empty));
  assert.equal(blackBlack.comparable, true);
  assert.equal(blackBlack.bothNonVacuous, false);
  assert.equal(blackBlack.footprintIou, 0);
  assert.equal(assessCrossBackendEvidence(blackBlack).pass, false);
});

test("waypoint ladder and outside-return identity require a real 0→36→0 transition", () => {
  const baseline = passingWaypointResults();
  assert.equal(assessWaypointSequence(baseline).pass, true);
  for (const backend of BACKENDS) {
    assert.equal(assessOutsideReturn(baseline, backend).pass, true);
  }

  const missing = structuredClone(baseline);
  delete missing["inside-positive-deep"];
  assert.equal(assessWaypointSequence(missing).pass, false);

  const wrongInside = structuredClone(baseline);
  wrongInside["inside-negative-near"].backends.webgpu.evidence.waypoint.inside =
    false;
  assert.equal(assessWaypointSequence(wrongInside).pass, false);

  const wrongReturnPixels = structuredClone(baseline);
  wrongReturnPixels[
    "outside-positive-return"
  ].backends.webgpu.metrics.rawSha256 = "B".repeat(64);
  assert.equal(assessOutsideReturn(wrongReturnPixels, "webgpu").pass, false);

  const wrongReturnCommand = structuredClone(baseline);
  wrongReturnCommand[
    "outside-positive-return"
  ].backends.webgpu.evidence.waypoint.commandSnapshot.commands.color.firstIndex =
    36;
  assert.equal(assessOutsideReturn(wrongReturnCommand, "webgpu").pass, false);
});

test("source/build/probe/provider provenance is exact, stable, and fresh", () => {
  const sentinels = [
    "VOXEL_PROXY_REVERSED_FIRST_INDEX",
    "computeVoxelProxyFirstIndex",
    "updateVoxelProxyCommandFirstIndices",
    'indexFormat: "uint16"',
  ].join("\n");
  const provenance = {
    rendererSource: {
      exists: true,
      bytes: 10,
      sha256: "A".repeat(64),
      mtimeMs: 10,
    },
    sceneRendererSource: {
      exists: true,
      bytes: 10,
      sha256: "D".repeat(64),
      mtimeMs: 10,
    },
    scenePassRedirectSource: {
      exists: true,
      bytes: 10,
      sha256: "E".repeat(64),
      mtimeMs: 10,
    },
    engineBundle: {
      exists: true,
      bytes: 10,
      sha256: "B".repeat(64),
      mtimeMs: 11,
    },
    providerFixture: {
      exists: true,
      bytes: 10,
      sha256: "C".repeat(64),
      mtimeMs: 9,
    },
  };
  assert.equal(
    assessBuildProvenance(provenance, sentinels, sentinels).pass,
    true,
  );
  assert.equal(provenanceStable(provenance, structuredClone(provenance)), true);
  const stale = structuredClone(provenance);
  stale.scenePassRedirectSource.mtimeMs = 12;
  assert.equal(assessBuildProvenance(stale, sentinels, sentinels).pass, false);
  const staleSceneRenderer = structuredClone(provenance);
  staleSceneRenderer.sceneRendererSource.mtimeMs = 12;
  assert.equal(
    assessBuildProvenance(staleSceneRenderer, sentinels, sentinels).pass,
    false,
  );
  const changed = structuredClone(provenance);
  changed.providerFixture.sha256 = "D".repeat(64);
  assert.equal(provenanceStable(provenance, changed), false);
  assert.equal(
    assessBuildProvenance(
      provenance,
      sentinels,
      sentinels.replace("computeVoxelProxyFirstIndex", "missing"),
    ).pass,
    false,
  );
});

test("artifact lifecycle is atomic, immutable, first-red write-once, and redacted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c11-13-probe-"));
  try {
    const canonical = path.join(directory, "canonical.json");
    fs.writeFileSync(canonical, "old");
    atomicReplace(canonical, "new");
    assert.equal(fs.readFileSync(canonical, "utf8"), "new");

    const firstRed = path.join(directory, "first-red.json");
    assert.equal(preserveFirstRed(firstRed, "first").written, true);
    assert.equal(preserveFirstRed(firstRed, "second").written, false);
    assert.equal(fs.readFileSync(firstRed, "utf8"), "first");

    const runArtifact = path.join(directory, "immutable-run.json");
    createImmutable(runArtifact, "only");
    assert.throws(
      () => createImmutable(runArtifact, "overwrite"),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(fs.readFileSync(runArtifact, "utf8"), "only");

    const redacted = redactOutputPayload({
      route: "http://localhost:8080/harness?renderer=webgpu&token=secret",
    });
    assert.equal(
      redacted.route,
      "http://localhost:8080/harness?renderer=[REDACTED]&token=[REDACTED]",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("origin, watchdog, and all error lanes are fail-closed", () => {
  assert.equal(
    normalizeProbeBase("http://localhost:8080"),
    "http://localhost:8080",
  );
  for (const invalid of [
    "file:///tmp",
    "http://user@localhost:8080",
    "http://localhost:8080/path",
    "http://localhost:8080/?token=secret",
  ]) {
    assert.throws(() => normalizeProbeBase(invalid), /STRUCTURAL:/u);
  }
  assert.equal(
    isBaseOrigin("/Source/Cesium.js", "http://localhost:8080"),
    true,
  );
  assert.equal(
    isBaseOrigin("https://example.com/x", "http://localhost:8080"),
    false,
  );
  assert.equal(
    assessWatchdogOrdering(10_000, 10_000 + OUTER_WATCHDOG_GRACE_MS),
    true,
  );
  assert.equal(assessWatchdogOrdering(10_000, 10_001), false);

  const errors = Object.fromEntries(ERROR_LANE_NAMES.map((name) => [name, []]));
  assert.equal(errorLanesAreEmpty(errors), true);
  errors.gpuErrors.push("validation");
  assert.equal(errorLanesAreEmpty(errors), false);
  assert.equal(errorLanesAreEmpty(undefined), false);
  assert.equal(errorLanesAreEmpty({}), false);
  const missingLane = Object.fromEntries(
    ERROR_LANE_NAMES.slice(1).map((name) => [name, []]),
  );
  assert.equal(errorLanesAreEmpty(missingLane), false);
  const wrongType = Object.fromEntries(
    ERROR_LANE_NAMES.map((name) => [name, []]),
  );
  wrongType.consoleErrors = null;
  assert.equal(errorLanesAreEmpty(wrongType), false);
  const extraLane = Object.fromEntries(
    ERROR_LANE_NAMES.map((name) => [name, []]),
  );
  extraLane.unknown = [];
  assert.equal(errorLanesAreEmpty(extraLane), false);
});

test("only exact bounded WebGPU debug-build and Chromium warnings are diagnostic", () => {
  const bundleUrl =
    "http://localhost:8080/packages/engine/Build/Unminified/index.js";
  const make = (text, overrides = {}) => ({
    backend: "webgpu",
    type: "warning",
    text,
    location: { url: bundleUrl },
    ...overrides,
  });
  const records = [
    make(
      "The powerPreference option is currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127",
    ),
  ].map((record) => ({
    ...record,
    classification: classifyExpectedConsoleWarning(
      record,
      "http://localhost:8080",
    ),
  }));
  assert.deepEqual(
    records.map(({ classification }) => classification),
    ["chromium-windows-power-preference"],
  );
  assert.equal(
    expectedConsoleWarningsAreValid(records, "http://localhost:8080"),
    true,
  );
  assert.equal(
    expectedConsoleWarningsAreValid([], "http://localhost:8080"),
    true,
  );
  assert.equal(
    expectedConsoleWarningsAreValid(
      [...records, structuredClone(records[0])],
      "http://localhost:8080",
    ),
    false,
  );
  assert.equal(
    expectedConsoleWarningsAreValid(
      [{ classification: "chromium-windows-power-preference" }],
      "http://localhost:8080",
    ),
    false,
  );

  const errors = { consoleWarnings: [] };
  const diagnostics = { allowedConsoleWarnings: [] };
  assert.equal(
    recordConsoleWarning(
      records[0],
      errors,
      diagnostics,
      "http://localhost:8080",
    ),
    true,
  );
  assert.equal(
    recordConsoleWarning(
      records[0],
      errors,
      diagnostics,
      "http://localhost:8080",
    ),
    false,
  );
  assert.equal(diagnostics.allowedConsoleWarnings.length, 1);
  assert.equal(errors.consoleWarnings.length, 1);

  for (const mutant of [
    make("[WebGPU:SceneRenderer] executeCommands called — healthy debug log"),
    make(`${records[0].text}.`),
    make(records[0].text, { type: "log" }),
    make(records[0].text, { backend: "webgl" }),
    make(records[0].text, {
      location: {
        url: "http://localhost:8080/Tools/visual-regression/fake.js",
      },
    }),
    make(records[0].text, {
      location: {
        url: "https://example.com/packages/engine/Build/Unminified/index.js",
      },
    }),
    make(records[0].text, {
      location: { url: `${bundleUrl}?cache=variant` },
    }),
    make(records[0].text, {
      location: { url: `${bundleUrl}#fragment` },
    }),
    make(records[0].text, {
      location: {
        url: "http://user:password@localhost:8080/packages/engine/Build/Unminified/index.js",
      },
    }),
  ]) {
    assert.equal(
      classifyExpectedConsoleWarning(mutant, "http://localhost:8080"),
      null,
    );
  }
});

test("artifact watchdog awaits the losing probe cleanup before rejecting", async () => {
  const order = [];
  let rejectProbe;
  const probeTask = (async () => {
    try {
      await new Promise((_resolve, reject) => {
        rejectProbe = reject;
      });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("probe-cleanup-complete");
    }
  })();
  const browserControl = {
    browser: {
      close: async () => {
        order.push("browser-close-start");
        rejectProbe(new Error("browser closed"));
        await Promise.resolve();
        order.push("browser-close-complete");
      },
    },
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    watchdogBrowserClosed: false,
    probeTaskDrained: false,
    watchdogCleanupErrors: [],
  };

  await assert.rejects(
    withWatchdog(probeTask, browserControl, 5),
    /WATCHDOG: exceeded 5 ms/u,
  );
  assert.deepEqual(order, [
    "browser-close-start",
    "browser-close-complete",
    "probe-cleanup-complete",
  ]);
  assert.equal(browserControl.watchdogTimedOut, true);
  assert.equal(browserControl.watchdogCloseAttempted, true);
  assert.equal(browserControl.watchdogBrowserClosed, true);
  assert.equal(browserControl.probeTaskDrained, true);
  assert.deepEqual(browserControl.watchdogCleanupErrors, []);
});

test("artifact watchdog records a close failure and still drains probe cleanup", async () => {
  let rejectProbe;
  let cleanupComplete = false;
  const probeTask = (async () => {
    try {
      await new Promise((_resolve, reject) => {
        rejectProbe = reject;
      });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2));
      cleanupComplete = true;
    }
  })();
  const browserControl = {
    browser: {
      close: async () => {
        rejectProbe(new Error("browser close initiated"));
        throw new Error("driver refused close");
      },
    },
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    watchdogBrowserClosed: false,
    probeTaskDrained: false,
    watchdogCleanupErrors: [],
  };

  await assert.rejects(
    withWatchdog(probeTask, browserControl, 5),
    /WATCHDOG: exceeded 5 ms/u,
  );
  assert.equal(cleanupComplete, true);
  assert.equal(browserControl.watchdogBrowserClosed, false);
  assert.equal(browserControl.probeTaskDrained, true);
  assert.deepEqual(browserControl.watchdogCleanupErrors, [
    { resource: "browser", message: "driver refused close" },
  ]);
});
