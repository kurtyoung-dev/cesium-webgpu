#!/usr/bin/env node
// @purpose Reproduces the three reported cloud and GodRay demos plus four offline cloud stations with real UI brackets and byte-bound identities.
// @status INVESTIGATION
// @runtime lib/probe-runtime.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";
import { decodePng } from "../lib/png-decode.mjs";
import {
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  compareEvidenceFileSnapshots,
  inspectBuildSourceIdentity,
  snapshotEvidenceFiles,
} from "./lib/build-source-identity.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { fixtureById } from "./lib/cloud-tour-fixtures.mjs";
import {
  CHARACTERIZATION_THRESHOLDS,
  C13_42_CONTRACT_VERSION,
  CONTROLLED_RAY_FIXTURE_OBLIGATION,
  assessC13_42ServedClosure,
  assessC13_42ServedResponseBudget,
  buildC13_42Schedule,
  classifyC13_42ServedArtifact,
  compareC13_42Phases,
  computeC13_42CellMetrics,
  fixtureScheduleHash,
  foldC13_42Verdicts,
  hashC13_42Definition,
  metricDefinitionHash,
  offlineCaptureRequest,
  servedResponseBudgetFor,
  servedResponseBudgetMs,
  validateC13_42Receipt,
} from "./lib/c13-42-reproduction-contract.mjs";
import {
  installC13_42GodRayObserver,
  installC13_42ReproductionHarness,
} from "./lib/c13-42-reproduction-harness.mjs";
import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import { openSandcastle2Url } from "./lib/sandcastle2-renderer-gate.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const NAVIGATION_BUDGET_MS = 60_000;
const READY_BUDGET_MS = 60_000;
const DEVICE_BUDGET_MS = 30_000;
const TRANSITION_BUDGET_MS = 30_000;
const CAPTURE_BUDGET_MS = 30_000;
const FINALIZE_BUDGET_MS = 30_000;
const CONTEXT_BUDGET_MS = 30_000;
const IDENTITY_BUDGET_MS = 60_000;
const RESPONSE_BODY_BUDGET_MS = 30_000;
// THE RESPONSE CAP IS NOT A CONSTANT HERE ANY MORE (Batch 1467, wired C13-42a).
// It used to be `const MAX_SERVED_RESPONSES = 48` in this file, and raising it
// meant editing this file — which is why the raise that landed in the contract
// module sat INERT: nothing in the probe read it. The cap now comes from
// `servedResponseBudgetFor(subject)`, which is keyed on the subject's leg and
// derived from the banked overflow table, and the work budget that pays for
// draining those responses comes from `servedResponseBudgetMs`, which sums the
// per-subject bounds instead of multiplying the largest across every cell.
// Both call sites are named in `DEFERRED_WORK.md` under `C13-42a`.
const MIN_CAPTURE_SIZE = Object.freeze({ width: 1280, height: 720 });
const VIEWPORT = Object.freeze({ width: 1600, height: 1000 });
const OFFLINE_PAGE_ID = "webgpu-fullscreen-sky";

const STATIC_SERVED_ARTIFACTS = Object.freeze([
  "Build/CesiumUnminified/Cesium.js",
  "Build/CesiumUnminified/Widgets/lighter.css",
  "Build/CesiumUnminified/Widgets/widgets.css",
  "Source/Cesium.js",
  "packages/engine/Build/Unminified/index.js",
  "packages/engine/Build/Unminified/index-wgsl.js",
  "packages/widgets/Build/Unminified/index.js",
  "Apps/Sandcastle2/index.html",
  "Apps/Sandcastle2/standalone.html",
  "Apps/Sandcastle2/templates/bucket.html",
  "Apps/Sandcastle2/templates/Sandcastle.js",
  "Apps/Sandcastle2/gallery/atmospheric-conditions/index.html",
  "Apps/Sandcastle2/gallery/atmospheric-conditions/main.js",
  "Apps/Sandcastle2/gallery/webgpu-fullscreen-sky/index.html",
  "Apps/Sandcastle2/gallery/webgpu-fullscreen-sky/main.js",
  "Apps/Sandcastle2/gallery/webgpu-god-rays/index.html",
  "Apps/Sandcastle2/gallery/webgpu-god-rays/main.js",
]);

const SERVED_NAMESPACE_ROOTS = Object.freeze([
  "Build/CesiumUnminified",
  "Apps/Sandcastle2/assets",
  "Apps/Sandcastle2/gallery",
]);

const BUILD_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGodRayEffect.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPostFrustumChain.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.js",
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.js",
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.js",
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.js",
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.js",
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate_f16.js",
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite.js",
  "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite_f16.js",
]);

const EVIDENCE_FILES = Object.freeze({
  descriptor: "Tools/visual-regression/probe-c13-42-reported-demos.mjs",
  contract: "Tools/visual-regression/lib/c13-42-reproduction-contract.mjs",
  contractSpec: "Tools/visual-regression/c13-42-reproduction-contract.spec.mjs",
  harness: "Tools/visual-regression/lib/c13-42-reproduction-harness.mjs",
  harnessSpec: "Tools/visual-regression/c13-42-reproduction-harness.spec.mjs",
  cloudHarness: "Tools/visual-regression/lib/cloud-probe-harness.mjs",
  fixtures: "Tools/visual-regression/lib/cloud-tour-fixtures.mjs",
  cloudMetrics: "Tools/visual-regression/lib/cloud-image-analysis.mjs",
  tourMetrics: "Tools/visual-regression/lib/cloud-tour-metrics.mjs",
  atmosphericSource: "Apps/Sandcastle2/gallery/atmospheric-conditions/main.js",
  atmosphericPage: "Apps/Sandcastle2/gallery/atmospheric-conditions/index.html",
  fullscreenSource: "Apps/Sandcastle2/gallery/webgpu-fullscreen-sky/main.js",
  fullscreenPage: "Apps/Sandcastle2/gallery/webgpu-fullscreen-sky/index.html",
  godRaySource: "Apps/Sandcastle2/gallery/webgpu-god-rays/main.js",
  godRayPage: "Apps/Sandcastle2/gallery/webgpu-god-rays/index.html",
  atmosphericPackageSource:
    "packages/sandcastle/gallery/atmospheric-conditions/main.js",
  atmosphericPackagePage:
    "packages/sandcastle/gallery/atmospheric-conditions/index.html",
  fullscreenPackageSource:
    "packages/sandcastle/gallery/webgpu-fullscreen-sky/main.js",
  fullscreenPackagePage:
    "packages/sandcastle/gallery/webgpu-fullscreen-sky/index.html",
  godRayPackageSource: "packages/sandcastle/gallery/webgpu-god-rays/main.js",
  godRayPackagePage: "packages/sandcastle/gallery/webgpu-god-rays/index.html",
  proceduralCloudSource:
    "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  proceduralCloudGenerated:
    "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.js",
  godRayGenerateSource:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.wgsl",
  godRayGenerateGenerated:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate.js",
  godRayCompositeSource:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite.wgsl",
  godRayCompositeGenerated:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite.js",
  godRayGenerateF16Source:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate_f16.wgsl",
  godRayGenerateF16Generated:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayGenerate_f16.js",
  godRayCompositeF16Source:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite_f16.wgsl",
  godRayCompositeF16Generated:
    "packages/engine/Source/Shaders/WebGPU/PostProcess/GodRayComposite_f16.js",
  cloudDensitySource:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  cloudDensityGenerated:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.js",
  cloudTemporalSource:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl",
  cloudTemporalGenerated:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.js",
  cloudUpscaleSource:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.wgsl",
  cloudUpscaleGenerated:
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudUpscale.js",
  sceneSource: "packages/engine/Source/Scene/Scene.js",
  globeSource: "packages/engine/Source/Scene/Globe.js",
  cloudRenderer:
    "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  godRayEffect: "packages/engine/Source/Renderer/WebGPU/WebGPUGodRayEffect.ts",
  postProcessPipeline:
    "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts",
  postProcessStages:
    "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
  sceneRenderer:
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  postFrustumChain:
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPostFrustumChain.ts",
  packageBuildEntry: "packages/engine/Build/Unminified/index.js",
  packageBuildMap: "packages/engine/Build/Unminified/index.js.map",
  servedDiskEntry: "Build/CesiumUnminified/index.js",
  servedDiskMap: "Build/CesiumUnminified/index.js.map",
  sandcastleAppIndex: "Apps/Sandcastle2/index.html",
  sandcastleBucketTemplate: "Apps/Sandcastle2/templates/bucket.html",
});

const CONTROL_SETS = Object.freeze({
  "R-atmospheric": Object.freeze([
    Object.freeze({
      name: "cloudCover",
      selector: '[data-bind*="value: cloudCover"]',
      property: "value",
      event: "input",
      offValue: 0,
      onValue: 0.4,
    }),
  ]),
  "R-fullscreen-sky": Object.freeze([
    Object.freeze({
      name: "proceduralClouds",
      selector: "#skyPanel .row:nth-child(4) input[type=checkbox]",
      property: "checked",
      event: "change",
      offValue: false,
      onValue: true,
    }),
  ]),
  offline: Object.freeze([
    Object.freeze({
      name: "proceduralClouds",
      selector: "#skyPanel .row:nth-child(4) input[type=checkbox]",
      property: "checked",
      event: "change",
      offValue: false,
      onValue: true,
    }),
  ]),
  "R-god-rays": Object.freeze([
    Object.freeze({
      name: "enabled",
      selector: '[data-bind*="checked: enabled"]',
      property: "checked",
      event: "change",
      offValue: false,
      onValue: true,
    }),
    ...["density", "decay", "weight", "exposure", "sampleCount"].map((name) =>
      Object.freeze({
        name,
        selector: `[data-bind*="value: ${name}"]`,
        property: "value",
        event: "input",
        offValue: name === "sampleCount" ? 64 : undefined,
        onValue: name === "sampleCount" ? 64 : undefined,
      }),
    ),
  ]),
});

function checkedSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function workBudgetMs(options = {}) {
  const renderers = options.renderers ?? ["webgpu"];
  if (
    !Array.isArray(renderers) ||
    renderers.length !== 1 ||
    renderers[0] !== "webgpu"
  ) {
    throw new ProbeRefusal(
      "c13-42-renderer-scope",
      "C13-42 reproduction is defined only for one WebGPU renderer leg",
      { renderers },
    );
  }
  const runs = checkedSafeInteger(options.runs ?? 1, "runs");
  if (runs !== 1) {
    throw new ProbeRefusal(
      "c13-42-single-repeat-contract",
      "C13-42 phase receipts require exactly one repeat",
      { runs },
    );
  }
  const phase = options.phase ?? "baseline";
  if (phase !== "baseline" && phase !== "repair") {
    throw new ProbeRefusal(
      "c13-42-phase",
      "C13-42 phase must be baseline or repair",
      { phase },
    );
  }
  const runId = options.runId ?? "c13-42-characterization";
  if (typeof runId !== "string" || runId.length === 0) {
    throw new ProbeRefusal(
      "c13-42-run-id",
      "C13-42 requires a non-empty run id",
    );
  }
  const port = options.port ?? 8094;
  if (!Number.isSafeInteger(port) || port <= 0 || port >= 65535) {
    throw new ProbeRefusal(
      "c13-42-port-pair",
      "C13-42 requires a served port whose paired bucket port is valid",
      { port },
    );
  }
  if (phase === "repair" && !options.baselineManifest) {
    throw new ProbeRefusal(
      "c13-42-baseline-manifest-required",
      "repair characterization requires --baseline-manifest",
    );
  }
  const cloudNoiseMorphology = options.cloudNoiseMorphology ?? "";
  if (
    cloudNoiseMorphology !== "" &&
    (cloudNoiseMorphology !== "perlin-worley" ||
      options.progressSubject !== "O-above-deck")
  ) {
    throw new ProbeRefusal(
      "c13-42-progress-morphology",
      "the morphology comparison is limited to the above-deck progress subject",
      { cloudNoiseMorphology, progressSubject: options.progressSubject },
    );
  }
  const schedule = buildC13_42Schedule();
  const phaseCount = schedule.coreSubjects.reduce(
    (sum, subject) => sum + subject.bracket.length,
    0,
  );
  const offlinePhaseCount = schedule.coreSubjects.reduce(
    (sum, subject) =>
      sum + (subject.leg === "offline" ? subject.bracket.length : 0),
    0,
  );
  const cellCount = schedule.coreSubjects.length * renderers.length;
  // CAP CALL SITE 2 of 2. The response term is summed PER SUBJECT rather than
  // by multiplying the largest bound across every cell: the global form
  // charged all seven cells the raised bound, which is how raising a cap
  // silently disarms the deadline that was supposed to pay for it.
  const budget =
    IDENTITY_BUDGET_MS +
    cellCount *
      (CONTEXT_BUDGET_MS * 7 +
        NAVIGATION_BUDGET_MS +
        READY_BUDGET_MS * 2 +
        DEVICE_BUDGET_MS +
        FINALIZE_BUDGET_MS) +
    renderers.length *
      servedResponseBudgetMs(RESPONSE_BODY_BUDGET_MS, schedule.coreSubjects) +
    renderers.length *
      (phaseCount * (TRANSITION_BUDGET_MS + CAPTURE_BUDGET_MS) +
        offlinePhaseCount * TRANSITION_BUDGET_MS);
  return checkedSafeInteger(budget, "C13-42 per-repeat work budget");
}

function resolvePageId(subject) {
  return subject.leg === "reported" ? subject.pageId : OFFLINE_PAGE_ID;
}

function controlsFor(subject) {
  return CONTROL_SETS[subject.id] ?? CONTROL_SETS.offline;
}

function requiredServedArtifactsForSubject(subject, dynamicArtifacts) {
  const pageId = resolvePageId(subject);
  return [
    "Source/Cesium.js",
    "packages/engine/Build/Unminified/index.js",
    "packages/engine/Build/Unminified/index-wgsl.js",
    "packages/widgets/Build/Unminified/index.js",
    "Apps/Sandcastle2/index.html",
    "Apps/Sandcastle2/templates/bucket.html",
    "Apps/Sandcastle2/templates/Sandcastle.js",
    `Apps/Sandcastle2/gallery/${pageId}/index.html`,
    `Apps/Sandcastle2/gallery/${pageId}/main.js`,
    ...dynamicArtifacts,
  ];
}

function normalizeGodRayControls(controls) {
  const defaults = {
    density: 0.96,
    decay: 0.95,
    weight: 0.5,
    exposure: 0.15,
    sampleCount: 64,
  };
  return controls.map((control) =>
    control.name in defaults
      ? {
          ...control,
          offValue: defaults[control.name],
          onValue: defaults[control.name],
        }
      : control,
  );
}

function absoluteEvidenceFiles(repositoryRoot) {
  return Object.fromEntries(
    Object.entries(EVIDENCE_FILES).map(([name, file]) => [
      name,
      path.resolve(repositoryRoot, file),
    ]),
  );
}

function requireNoFollowRepositoryPath(
  repositoryRoot,
  relativeTarget,
  expectedKind,
  operations,
) {
  if (typeof relativeTarget !== "string" || path.isAbsolute(relativeTarget)) {
    throw new Error("served closure path must be repository-relative");
  }
  const segments = relativeTarget.split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${relativeTarget} is not a canonical repository path`);
  }

  const absoluteRoot = path.resolve(repositoryRoot);
  const absoluteTarget = path.resolve(absoluteRoot, ...segments);
  if (
    absoluteTarget === absoluteRoot ||
    !insideRoot(absoluteRoot, absoluteTarget)
  ) {
    throw new Error(`${relativeTarget} escapes the repository`);
  }

  const rootStatus = operations.lstatSync(absoluteRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("repository root is not a regular directory");
  }

  let current = absoluteRoot;
  for (let index = 0; index < segments.length; index++) {
    current = path.resolve(current, segments[index]);
    const status = operations.lstatSync(current);
    if (status.isSymbolicLink()) {
      throw new Error(`${relativeTarget} contains a symbolic link`);
    }
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !status.isDirectory()) {
      throw new Error(`${relativeTarget} has a non-directory ancestor`);
    }
    if (
      isLeaf &&
      ((expectedKind === "file" && !status.isFile()) ||
        (expectedKind === "directory" && !status.isDirectory()))
    ) {
      throw new Error(
        `${relativeTarget} is not a regular served ${expectedKind}`,
      );
    }
  }

  const repositoryReal = realpathWith(operations, absoluteRoot);
  const targetReal = realpathWith(operations, absoluteTarget);
  if (
    targetReal === repositoryReal ||
    !insideRoot(repositoryReal, targetReal)
  ) {
    throw new Error(`${relativeTarget} resolves outside the repository`);
  }
  return { absolute: absoluteTarget, repositoryReal };
}

function htmlResourceArtifacts(repositoryRoot, relativeHtml, operations = fs) {
  const { absolute: absoluteHtml } = requireNoFollowRepositoryPath(
    repositoryRoot,
    relativeHtml,
    "file",
    operations,
  );
  const html = operations.readFileSync(absoluteHtml, "utf8");
  const linked = [];
  const scripts = [];
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of html.matchAll(pattern)) {
    const reference = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) continue;
    const withoutSuffix = reference.split(/[?#]/u, 1)[0];
    const absoluteReference = withoutSuffix.startsWith("/")
      ? path.resolve(repositoryRoot, `.${withoutSuffix}`)
      : path.resolve(path.dirname(absoluteHtml), withoutSuffix);
    const relative = path
      .relative(repositoryRoot, absoluteReference)
      .replaceAll("\\", "/");
    const classification = classifyC13_42ServedArtifact(relative);
    if (classification.relevant && !classification.ok) {
      throw new Error(
        `${relativeHtml} has malformed served dependency ${reference}: ${classification.reason}`,
      );
    }
    if (!classification.relevant) continue;
    linked.push(classification.path);
    if (classification.path.endsWith(".js")) {
      scripts.push(classification.path);
    }
  }
  if (scripts.length === 0) {
    throw new Error(`${relativeHtml} has no module script artifact`);
  }
  return {
    linked: [...new Set(linked)].sort(),
    scripts: [...new Set(scripts)].sort(),
  };
}

function realpathWith(operations, value) {
  const operation = operations.realpathSync?.native ?? operations.realpathSync;
  if (typeof operation !== "function") {
    throw new Error("served closure filesystem has no realpathSync operation");
  }
  return path.resolve(operation(value));
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function walkServedNamespace(repositoryRoot, relativeRoot, operations = fs) {
  const { absolute: absoluteRoot } = requireNoFollowRepositoryPath(
    repositoryRoot,
    relativeRoot,
    "directory",
    operations,
  );
  const artifacts = [];
  const visit = (directory) => {
    const entries = operations
      .readdirSync(directory, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        path.basename(entry.name) !== entry.name
      ) {
        throw new Error(`${relativeRoot} contains an invalid directory entry`);
      }
      const absolute = path.resolve(directory, entry.name);
      if (!insideRoot(absoluteRoot, absolute)) {
        throw new Error(`${relativeRoot} contains an escaping directory entry`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${relativeRoot} contains symbolic link ${entry.name}`);
      }
      const relative = path
        .relative(repositoryRoot, absolute)
        .replaceAll("\\", "/");
      if (entry.isDirectory()) {
        requireNoFollowRepositoryPath(
          repositoryRoot,
          relative,
          "directory",
          operations,
        );
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `${relativeRoot} contains non-regular entry ${entry.name}`,
        );
      }
      requireNoFollowRepositoryPath(
        repositoryRoot,
        relative,
        "file",
        operations,
      );
      const classification = classifyC13_42ServedArtifact(relative);
      if (classification.relevant && !classification.ok) {
        throw new Error(
          `${relativeRoot} contains malformed served artifact ${relative}: ${classification.reason}`,
        );
      }
      if (classification.relevant) artifacts.push(classification.path);
    }
  };
  visit(absoluteRoot);
  return artifacts;
}

function requireRegularServedArtifact(
  repositoryRoot,
  relativeArtifact,
  operations,
) {
  return requireNoFollowRepositoryPath(
    repositoryRoot,
    relativeArtifact,
    "file",
    operations,
  ).absolute;
}

export function buildEvidenceClosure(repositoryRoot, operations = fs) {
  const appResources = htmlResourceArtifacts(
    repositoryRoot,
    "Apps/Sandcastle2/standalone.html",
    operations,
  );
  const bucketResources = htmlResourceArtifacts(
    repositoryRoot,
    "Apps/Sandcastle2/templates/bucket.html",
    operations,
  );
  const namespaceArtifacts = SERVED_NAMESPACE_ROOTS.flatMap((relativeRoot) =>
    walkServedNamespace(repositoryRoot, relativeRoot, operations),
  );
  const candidates = [
    ...STATIC_SERVED_ARTIFACTS,
    ...appResources.linked,
    ...bucketResources.linked,
    ...namespaceArtifacts,
  ];
  const allowedServedArtifacts = [];
  for (const candidate of candidates) {
    const classification = classifyC13_42ServedArtifact(candidate);
    if (!classification.relevant || !classification.ok) {
      throw new Error(
        `invalid C13-42 served artifact ${String(candidate)}: ${classification.reason ?? "not relevant"}`,
      );
    }
    allowedServedArtifacts.push(classification.path);
  }
  const allowed = [...new Set(allowedServedArtifacts)].sort();
  const files = absoluteEvidenceFiles(repositoryRoot);
  for (const artifact of allowed) {
    files[`served:${artifact}`] = requireRegularServedArtifact(
      repositoryRoot,
      artifact,
      operations,
    );
  }
  return Object.freeze({
    files: Object.freeze(files),
    dynamicArtifacts: Object.freeze(
      [
        ...new Set([...appResources.scripts, ...bucketResources.scripts]),
      ].sort(),
    ),
    allowedServedArtifacts: Object.freeze(allowed),
    snapshottedArtifacts: Object.freeze([...allowed]),
  });
}

function rawAbsoluteUrlPathname(url) {
  const match = String(url).match(
    /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(\/[^?#]*)?(?:[?#]|$)/iu,
  );
  return match ? (match[1] ?? "/") : String(url);
}

export function classifyC13_42ServedUrl(url, origins) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return classifyC13_42ServedArtifact(url);
  }
  if (!origins.has(parsed.origin)) {
    return { relevant: false, ok: true, path: null, reason: null };
  }
  return classifyC13_42ServedArtifact(rawAbsoluteUrlPathname(url));
}

function relevantServedUrl(url, origins) {
  return classifyC13_42ServedUrl(url, origins).relevant;
}

/**
 * CAP CALL SITE 1 of 2. The bound arrives as an argument so it can be the
 * subject's own (`servedResponseBudgetFor(subject)`) rather than a module
 * constant every subject shares.
 *
 * @param {Array<object>} responses Retained responses.
 * @param {Set<string>} seenUrls Urls already retained.
 * @param {object} response The Playwright response.
 * @param {Set<string>} origins Origins whose responses are relevant.
 * @param {number} cap This subject's response bound.
 * @returns {string|null} The overflowing url, or `null` when retained or irrelevant.
 */
export function appendC13_42ServedResponse(
  responses,
  seenUrls,
  response,
  origins,
  cap,
) {
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new RangeError(
      "appendC13_42ServedResponse requires this subject's positive response bound",
    );
  }
  const url = response.url();
  if (!relevantServedUrl(url, origins) || seenUrls.has(url)) return null;
  if (responses.length >= cap) return url;
  seenUrls.add(url);
  responses.push(response);
  return null;
}

async function drainServedResponses(
  responses,
  origins,
  scope,
  repositoryRoot,
  cap,
) {
  const selected = [];
  const seen = new Set();
  for (const response of responses) {
    const url = response.url();
    const classification = classifyC13_42ServedUrl(url, origins);
    if (!classification.relevant || seen.has(url)) continue;
    seen.add(url);
    selected.push({ response, classification });
  }
  if (selected.length > cap) {
    throw new ProbeRefusal(
      "c13-42-served-closure-over-cap",
      "the served identity closure exceeded its preregistered response cap",
      { count: selected.length, cap },
    );
  }
  const ledger = [];
  for (const { response, classification } of selected) {
    if (!classification.ok) {
      ledger.push({
        url: response.url(),
        status: response.status(),
        relativePath: null,
        canonicalizationError: classification.reason,
        matchesDisk: false,
      });
      continue;
    }
    const bytes = await scope.run(
      `served body ${response.url()}`,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        return await response.body();
      },
    );
    const relativeDiskPath = classification.path;
    const diskPath = path.resolve(repositoryRoot, relativeDiskPath);
    const withinRepository = insideRoot(path.resolve(repositoryRoot), diskPath);
    let disk = null;
    if (withinRepository) {
      try {
        const diskBytes = fs.readFileSync(diskPath);
        disk = {
          relativePath: relativeDiskPath.replaceAll("\\", "/"),
          byteLength: diskBytes.byteLength,
          sha256: sha256(diskBytes),
        };
      } catch (error) {
        disk = {
          relativePath: relativeDiskPath.replaceAll("\\", "/"),
          error:
            error?.code ??
            (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    const servedSha256 = sha256(bytes);
    ledger.push({
      url: response.url(),
      status: response.status(),
      relativePath: relativeDiskPath,
      byteLength: bytes.byteLength,
      sha256: servedSha256,
      disk,
      matchesDisk:
        disk?.byteLength === bytes.byteLength && disk?.sha256 === servedSha256,
    });
  }
  return ledger.sort((left, right) => left.url.localeCompare(right.url));
}

export function requireServedClosure(
  ledger,
  requiredArtifacts,
  allowedArtifacts,
  snapshottedArtifacts,
  subjectId,
) {
  const decision = assessC13_42ServedClosure({
    ledger,
    requiredArtifacts,
    allowedArtifacts,
    snapshottedArtifacts,
  });
  if (!decision.ok) {
    throw new ProbeRefusal(
      "c13-42-served-cell-closure",
      `served/local closure is incomplete for ${subjectId}`,
      { subjectId, ...decision, ledger },
    );
  }
  return { ok: true, requiredArtifacts };
}

function prepareOfflineFixture(
  frame,
  subject,
  scope,
  cloudNoiseMorphology = "",
) {
  if (subject.leg !== "offline") return null;
  const fixture = fixtureById(subject.fixtureId);
  const station = fixture?.stations.find(
    (entry) => entry.id === subject.stationId,
  );
  if (!fixture || !station) {
    throw new ProbeRefusal(
      "c13-42-offline-fixture-missing",
      `offline fixture station ${subject.fixtureId}/${subject.stationId} is absent`,
    );
  }
  const request = offlineCaptureRequest(fixture, "OFF");
  const volumetric = cloudNoiseMorphology
    ? { ...request.volumetric, cloudNoiseMorphology }
    : request.volumetric;
  return scope.run(`configure ${subject.id}`, async (signal) => {
    if (signal.aborted) throw signal.reason;
    return await frame.evaluate(
      async ({ clockIso, volumetric, station: position }) => {
        const C = await import("cesium");
        const viewer = globalThis.__cloudProbe.resolveViewer();
        const truth = globalThis.__cloudProbe.configure({
          viewer,
          requireWebGPU: true,
          enableVolumetric: false,
          volumetric,
        });
        viewer.terrainProvider = new C.EllipsoidTerrainProvider();
        viewer.imageryLayers.removeAll();
        viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            position.lon,
            position.lat,
            position.height,
          ),
          orientation: {
            heading: C.Math.toRadians(position.heading),
            pitch: C.Math.toRadians(position.pitch),
            roll: 0,
          },
        });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        viewer.resize();
        if (viewer.navigationHelpButton?.viewModel) {
          viewer.navigationHelpButton.viewModel.showInstructions = false;
        }
        let settleFrames = 0;
        let tilesToRender = 0;
        while (settleFrames < 120) {
          viewer.scene.render();
          await new Promise(requestAnimationFrame);
          settleFrames++;
          tilesToRender = viewer.scene.globe._surface._tilesToRender.length;
          if (viewer.scene.globe.tilesLoaded && tilesToRender > 0) break;
        }
        if (!viewer.scene.globe.tilesLoaded || tilesToRender === 0) {
          throw new Error(
            `offline globe did not settle after ${settleFrames} frames`,
          );
        }
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = C.JulianDate.fromIso8601(clockIso);
        for (let index = 0; index < 4; index++) {
          viewer.scene.render();
          await new Promise(requestAnimationFrame);
        }
        return {
          truth,
          station: position,
          requestedClockIso: clockIso,
          realizedClockIso: C.JulianDate.toIso8601(viewer.clock.currentTime),
          terrainProvider: viewer.terrainProvider.constructor.name,
          imageryLayerCount: viewer.imageryLayers.length,
          settleFrames,
          tilesToRender,
        };
      },
      {
        clockIso: request.fixtureClockIso,
        volumetric,
        station,
      },
    );
  });
}

function applyOfflineCaptureState(
  frame,
  subject,
  phase,
  scope,
  cloudNoiseMorphology = "",
) {
  if (subject.leg !== "offline") return null;
  const fixture = fixtureById(subject.fixtureId);
  if (!fixture) {
    throw new ProbeRefusal(
      "c13-42-offline-fixture-missing",
      `offline fixture ${subject.fixtureId} is absent`,
    );
  }
  const request = offlineCaptureRequest(fixture, phase);
  const volumetric = cloudNoiseMorphology
    ? { ...request.volumetric, cloudNoiseMorphology }
    : request.volumetric;
  return scope.run(
    `freeze offline capture ${subject.id} ${phase}`,
    async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await frame.evaluate(
        async ({ clockIso, enabled, volumetric }) => {
          const C = await import("cesium");
          const viewer = globalThis.__cloudProbe.resolveViewer();
          const truth = globalThis.__cloudProbe.configure({
            viewer,
            requireWebGPU: true,
            enableVolumetric: enabled,
            volumetric,
          });
          viewer.clock.currentTime = C.JulianDate.fromIso8601(clockIso);
          viewer.clock.shouldAnimate = false;
          viewer.scene.render();
          const realizedClockIso = C.JulianDate.toIso8601(
            viewer.clock.currentTime,
          );
          if (realizedClockIso !== clockIso) {
            throw new Error(
              `offline fixture clock mismatch: ${realizedClockIso}`,
            );
          }
          return {
            enabled,
            requestedClockIso: clockIso,
            realizedClockIso,
            requestedVolumetric: volumetric,
            realizedVolumetric: truth.config,
            realization: globalThis.__cloudProbe.proceduralRealization(viewer),
            statistics: globalThis.__cloudProbe.cloudStatsSnapshot(viewer),
          };
        },
        {
          clockIso: request.fixtureClockIso,
          enabled: request.enabled,
          volumetric,
        },
      );
    },
  );
}

async function armBucketDevice(frame, subjectId, scope) {
  return await scope.run(`arm device ${subjectId}`, async (signal) => {
    if (signal.aborted) throw signal.reason;
    return await frame.evaluate((label) => {
      const candidates = Array.isArray(globalThis.__sandcastleInstances)
        ? globalThis.__sandcastleInstances.filter(
            (candidate) => candidate?.scene?.context?._device,
          )
        : [];
      const unique = candidates.filter(
        (candidate, index) => candidates.indexOf(candidate) === index,
      );
      if (unique.length !== 1) {
        throw new Error(
          `C13-42 expected one bucket viewer, observed ${unique.length}`,
        );
      }
      const viewer = unique[0];
      const context = viewer.scene.context;
      const armed = globalThis.__armWebGPUDevice(context._device, label);
      return {
        armed,
        rendererType: String(context.rendererType),
        adapter: String(
          context._adapterInfo?.description ??
            context._adapterInfo?.device ??
            "unreported",
        ),
      };
    }, subjectId);
  });
}

async function inspectCaptureEnvironment(frame, subjectId, phase, scope) {
  const observed = await scope.run(
    `capture environment ${subjectId} ${phase}`,
    async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await frame.evaluate(() => {
        const viewer = globalThis.__cloudProbe.resolveViewer();
        const scene = viewer.scene;
        const context = scene.context;
        const canvas = scene.canvas;
        const terrainProvider = viewer.terrainProvider;
        const imageryLayers = viewer.imageryLayers;
        return {
          canvas: {
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight,
            width: canvas.width,
            height: canvas.height,
            drawingBufferWidth:
              scene.drawingBufferWidth ?? context.drawingBufferWidth,
            drawingBufferHeight:
              scene.drawingBufferHeight ?? context.drawingBufferHeight,
            devicePixelRatio: globalThis.devicePixelRatio,
            resolutionScale: viewer.resolutionScale,
          },
          content: {
            terrainProvider: terrainProvider?.constructor?.name ?? null,
            terrainReady: terrainProvider?.ready ?? null,
            globeTilesLoaded: scene.globe?.tilesLoaded ?? null,
            globeTilesToRender: Array.isArray(
              scene.globe?._surface?._tilesToRender,
            )
              ? scene.globe._surface._tilesToRender.length
              : null,
            frameCommandCount: scene._frameState?.commandList?.length ?? null,
            globeDepthTextureReady: context._globeDepthTexture != null,
            cloudNoise: {
              requested:
                viewer.scene.globe.defaultCloudCollection.volumetric
                  .cloudNoiseMorphology,
              iblPWActive: context._cloudCache?.iblPWActive ?? null,
              noiseBaked: context._cloudCache?.noiseBaked ?? null,
              perlinWorleyBaked:
                context._cloudCache?.noise?.shapePWSampleView != null,
            },
            imageryLayers: Array.from(
              { length: imageryLayers?.length ?? 0 },
              (_, index) => {
                const provider = imageryLayers.get(index)?.imageryProvider;
                return {
                  provider: provider?.constructor?.name ?? null,
                  ready: provider?.ready ?? null,
                };
              },
            ),
          },
        };
      });
    },
  );
  const dimensions = observed.canvas;
  const validDimensions = [
    [dimensions.clientWidth, MIN_CAPTURE_SIZE.width],
    [dimensions.clientHeight, MIN_CAPTURE_SIZE.height],
    [dimensions.width, MIN_CAPTURE_SIZE.width],
    [dimensions.height, MIN_CAPTURE_SIZE.height],
    [dimensions.drawingBufferWidth, MIN_CAPTURE_SIZE.width],
    [dimensions.drawingBufferHeight, MIN_CAPTURE_SIZE.height],
  ].every(([value, minimum]) => Number.isInteger(value) && value >= minimum);
  if (
    !validDimensions ||
    dimensions.devicePixelRatio !== 1 ||
    dimensions.resolutionScale !== 1
  ) {
    throw new ProbeRefusal(
      "c13-42-capture-dimensions",
      `${subjectId} ${phase} does not provide a native 1280 by 720 canvas`,
      { subjectId, phase, minimum: MIN_CAPTURE_SIZE, observed },
    );
  }
  return observed;
}

function primeCloudRenderer(frame, subject, controls, scope) {
  if (subject.id === "R-god-rays") return null;
  const enabled = controls[0];
  return scope.run(`cloud readiness ${subject.id}`, async (signal) => {
    if (signal.aborted) throw signal.reason;
    return await frame.evaluate(
      async ({ control, timeoutMs }) => {
        const C = await import("cesium");
        const element = document.querySelector(control.selector);
        if (!element) {
          throw new Error(
            `cloud readiness control ${control.selector} is absent`,
          );
        }
        const viewer = globalThis.__cloudProbe.resolveViewer();
        const original = element[control.property];
        element[control.property] = control.onValue;
        element.dispatchEvent(new Event(control.event, { bubbles: true }));
        viewer.scene.render();
        let readiness;
        try {
          readiness = await globalThis.__cloudProbe.awaitProceduralReady({
            viewer,
            featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
            timeoutMs,
          });
        } finally {
          element[control.property] = original;
          element.dispatchEvent(new Event(control.event, { bubbles: true }));
          viewer.scene.render();
        }
        if (!Object.is(element[control.property], original)) {
          throw new Error("cloud readiness control did not restore exactly");
        }
        return { readiness, control: control.name, restored: true };
      },
      { control: enabled, timeoutMs: READY_BUDGET_MS },
    );
  });
}

async function runSubject({
  browser,
  subject,
  run,
  options,
  origin,
  outputDirectory,
  captures,
  scope,
  repositoryRoot,
  dynamicServedArtifacts,
  allowedServedArtifacts,
  snapshottedServedArtifacts,
}) {
  scope.checkpoint();
  const context = await scope.run(`context ${subject.id}`, async (signal) => {
    if (signal.aborted) throw signal.reason;
    return await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });
  });
  let diagnostics;
  let result;
  let failed = false;
  let failure;
  try {
    const page = await scope.run(`page ${subject.id}`, async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await context.newPage();
    });
    diagnostics = attachPageDiagnostics(page, { cap: 256 });
    const gpuConsoleErrors = attachConsoleErrorGate(page);
    const bucketPort = Number(options.port) + 1;
    const outerUrl = new URL(origin);
    const bucketOrigin = `${outerUrl.protocol}//${outerUrl.hostname}:${bucketPort}`;
    const servedOrigins = new Set([outerUrl.origin, bucketOrigin]);
    const responses = [];
    const responseUrls = new Set();
    let responseOverflow = 0;
    const responseOverflowUrls = [];
    // CAP CALL SITE 1 of 2, wired. Read once per cell so the receipt's bound
    // and the listener's bound cannot disagree mid-cell.
    const servedResponseCap = servedResponseBudgetFor(subject);
    page.on("response", (response) => {
      const overflowUrl = appendC13_42ServedResponse(
        responses,
        responseUrls,
        response,
        servedOrigins,
        servedResponseCap,
      );
      if (overflowUrl === null) return;
      responseOverflow++;
      if (
        responseOverflowUrls.length < 4 &&
        !responseOverflowUrls.includes(overflowUrl)
      ) {
        responseOverflowUrls.push(overflowUrl);
      }
    });
    await scope.run(`init ${subject.id}`, async (signal) => {
      if (signal.aborted) throw signal.reason;
      await page.addInitScript(errorGateInit);
      await page.addInitScript(installCloudProbeHarness);
      await page.addInitScript(installC13_42GodRayObserver);
      await page.addInitScript(installC13_42ReproductionHarness);
    });
    const opened = await scope.run(`navigate ${subject.id}`, async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await openSandcastle2Url(
        page,
        {
          base: origin,
          bucketBase: bucketOrigin,
          id: resolvePageId(subject),
          renderer: "webgpu",
          standalone: true,
        },
        {
          timeoutMs: NAVIGATION_BUDGET_MS,
          gotoOptions: { waitUntil: "load", timeout: NAVIGATION_BUDGET_MS },
        },
      );
    });
    const frame = opened.bucketFrame;
    if (!frame) {
      throw new ProbeRefusal(
        "c13-42-bucket-frame-missing",
        `Sandcastle2 bucket frame is missing for ${subject.id}`,
      );
    }
    await scope.run(`viewer ready ${subject.id}`, async (signal) => {
      if (signal.aborted) throw signal.reason;
      await frame.waitForFunction(
        (subjectId) => {
          if (
            !Array.isArray(globalThis.__sandcastleInstances) ||
            globalThis.__sandcastleInstances.length !== 1 ||
            !globalThis.__c13_42ReproductionHarness
          ) {
            return false;
          }
          if (subjectId !== "R-god-rays") return true;
          const scene = globalThis.__sandcastleInstances[0].scene;
          const effect =
            scene?._alternateSceneRenderer?.postProcessPipeline?.godRayEffect;
          return Boolean(
            effect?._generatePipeline &&
            effect?._compositePipeline &&
            effect?._rayView &&
            effect?._outputView,
          );
        },
        subject.id,
        { timeout: READY_BUDGET_MS },
      );
    });
    const device = await armBucketDevice(frame, subject.id, scope);
    if (device.rendererType.toLowerCase() !== "webgpu") {
      throw new ProbeRefusal(
        "c13-42-wrong-renderer",
        `${subject.id} resolved ${device.rendererType}, not WebGPU`,
        { subject: subject.id, device },
      );
    }
    const controls = normalizeGodRayControls(controlsFor(subject));
    const cloudReadiness = await primeCloudRenderer(
      frame,
      subject,
      controls,
      scope,
    );
    const offline = await prepareOfflineFixture(
      frame,
      subject,
      scope,
      options.cloudNoiseMorphology,
    );
    const begun = await scope.run(`begin ${subject.id}`, async (signal) => {
      if (signal.aborted) throw signal.reason;
      return await frame.evaluate(
        ({ kind, controls: specifications }) =>
          globalThis.__c13_42ReproductionHarness.beginCell({
            kind,
            controls: specifications,
            enabledControlName:
              kind === "godRay" ? "enabled" : specifications[0].name,
          }),
        {
          kind: subject.id === "R-god-rays" ? "godRay" : "cloud",
          controls,
        },
      );
    });
    const phaseCaptures = [];
    let finish;
    let bracketFailed = false;
    let bracketFailure;
    let finishFailed = false;
    let finishFailure;
    try {
      for (const scheduledPhase of subject.bracket) {
        const phase = scheduledPhase.toLowerCase();
        const transition = await scope.run(
          `transition ${subject.id} ${phase}`,
          async (signal) => {
            if (signal.aborted) throw signal.reason;
            return await frame.evaluate(
              ({ sessionId, phase: requestedPhase, refreshControlNames }) =>
                globalThis.__c13_42ReproductionHarness.transition(
                  sessionId,
                  requestedPhase,
                  { refreshControlNames },
                ),
              {
                sessionId: begun.sessionId,
                phase,
                refreshControlNames:
                  subject.id === "R-god-rays" && phase === "on"
                    ? ["density", "decay", "weight", "exposure", "sampleCount"]
                    : [],
              },
            );
          },
        );
        const offlineCaptureState = await applyOfflineCaptureState(
          frame,
          subject,
          phase,
          scope,
          options.cloudNoiseMorphology,
        );
        const captureEnvironment = await inspectCaptureEnvironment(
          frame,
          subject.id,
          phase,
          scope,
        );
        const capture = await scope.run(
          `capture ${subject.id} ${phaseCaptures.length + 1}`,
          async (signal) => {
            if (signal.aborted) throw signal.reason;
            return await captureElement({
              page: frame,
              selector: "#cesiumContainer canvas",
              index: 0,
              name: `${subject.id}-${phase}-${phaseCaptures.length + 1}-run${run}`,
              outputDirectory,
              captures,
            });
          },
        );
        const image = decodePng(capture.buffer);
        if (
          image.width < MIN_CAPTURE_SIZE.width ||
          image.height < MIN_CAPTURE_SIZE.height
        ) {
          throw new ProbeRefusal(
            "c13-42-capture-dimensions",
            `${subject.id} ${phase} did not produce a native 1280 by 720 PNG`,
            {
              subjectId: subject.id,
              phase,
              minimum: MIN_CAPTURE_SIZE,
              observed: {
                captureEnvironment,
                png: { width: image.width, height: image.height },
              },
            },
          );
        }
        phaseCaptures.push({
          phase: scheduledPhase,
          transition,
          offlineCaptureState,
          captureEnvironment,
          sha256: capture.sha256 ?? sha256(capture.buffer),
          image,
        });
      }
    } catch (error) {
      bracketFailed = true;
      bracketFailure = error;
    } finally {
      try {
        finish = await scope.run(`finish ${subject.id}`, async (signal) => {
          if (signal.aborted) throw signal.reason;
          return await frame.evaluate(
            (sessionId) =>
              globalThis.__c13_42ReproductionHarness.finishCell(sessionId),
            begun.sessionId,
          );
        });
      } catch (finishError) {
        finishFailed = true;
        finishFailure = finishError;
      }
    }
    if (bracketFailed) throw bracketFailure;
    if (finishFailed) throw finishFailure;
    opened.assertNoOriginBreach();
    const gpuGate = await scope.run(
      `GPU gate ${subject.id}`,
      async (signal) => {
        if (signal.aborted) throw signal.reason;
        return await collectGateErrors(frame);
      },
    );
    const provisionalCell = {
      id: subject.id,
      pageId: subject.pageId,
      fixtureId: subject.fixtureId,
      stationId: subject.stationId,
      leg: subject.leg,
      bracket: subject.bracket,
      offline,
      cloudReadiness,
      captures: phaseCaptures.map(
        ({
          phase,
          sha256: digest,
          transition,
          offlineCaptureState,
          captureEnvironment,
          image,
        }) => ({
          phase,
          sha256: digest,
          transition,
          offlineCaptureState,
          captureEnvironment,
          image: { width: image.width, height: image.height },
        }),
      ),
    };
    // The refusal that actually fires. Its reason now comes from the landed
    // apparatus, so it names the subject's own budget and leg rather than a
    // module constant the reader has to go and look up.
    const responseBudget = assessC13_42ServedResponseBudget({
      subject,
      retained: responses.length,
      overflow: responseOverflow,
    });
    if (!responseBudget.ok) {
      throw new ProbeRefusal(
        "c13-42-served-closure-over-cap",
        responseBudget.reason,
        {
          ...responseBudget,
          retainedUrls: responses.map((response) => response.url()),
          overflowUrls: responseOverflowUrls,
          provisionalCell,
        },
      );
    }
    const served = await drainServedResponses(
      responses,
      servedOrigins,
      scope,
      repositoryRoot,
      servedResponseCap,
    );
    let servedClosure;
    try {
      servedClosure = requireServedClosure(
        served,
        requiredServedArtifactsForSubject(subject, dynamicServedArtifacts),
        allowedServedArtifacts,
        snapshottedServedArtifacts,
        subject.id,
      );
    } catch (error) {
      if (error instanceof ProbeRefusal) {
        error.details = { ...error.details, provisionalCell };
      }
      throw error;
    }
    const firstOff = phaseCaptures.find((entry) => entry.phase === "OFF");
    const firstOn = phaseCaptures.find((entry) => entry.phase === "ON");
    const onCaptures = phaseCaptures.filter((entry) => entry.phase === "ON");
    const repeatOff = phaseCaptures.find(
      (entry, index) =>
        entry.phase === "OFF" && index > phaseCaptures.indexOf(firstOn),
    );
    const metrics = computeC13_42CellMetrics({
      kind: subject.id === "R-god-rays" ? "godRay" : "cloud",
      offImage: firstOff.image,
      onImage: firstOn.image,
      repeatOffImage: repeatOff?.image,
      repeatOnImage: onCaptures[1]?.image,
      frames: phaseCaptures.map((entry) => entry.image.data),
    });
    const transitionReasons = phaseCaptures.flatMap(
      (entry) => entry.transition.reasons ?? [],
    );
    const faults = [
      ...gpuConsoleErrors,
      ...gpuGate.errors,
      ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
      ...diagnostics.errors.map((entry) => entry.text),
    ];
    const status =
      faults.length > 0
        ? "ERROR"
        : transitionReasons.length > 0 ||
            finish?.restored !== true ||
            !metrics.ok
          ? "FAIL"
          : "PASS";
    result = {
      id: subject.id,
      pageId: subject.pageId,
      fixtureId: subject.fixtureId,
      stationId: subject.stationId,
      leg: subject.leg,
      bracket: subject.bracket,
      status,
      rawControls: begun.controls,
      preState: begun.entryState,
      postState: finish,
      metrics,
      pngSha256: firstOn.sha256,
      captures: phaseCaptures.map(
        ({
          phase,
          sha256: digest,
          transition,
          offlineCaptureState,
          captureEnvironment,
          image,
        }) => ({
          phase,
          sha256: digest,
          transition,
          offlineCaptureState,
          captureEnvironment,
          image: { width: image.width, height: image.height },
        }),
      ),
      offline,
      cloudReadiness,
      device,
      diagnostics: {
        console: diagnostics.console,
        errors: diagnostics.errors,
        overflow: diagnostics.overflow,
        gpuConsoleErrors,
        gpuGate,
      },
      served,
      servedClosure,
      environment: {
        browser: browser.version(),
        adapter: device.adapter,
        canvas: {
          width: firstOn.image.width,
          height: firstOn.image.height,
        },
        dpr: 1,
      },
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    diagnostics?.detach();
    try {
      await scope.run(
        `close context ${subject.id}`,
        async () => await context.close(),
      );
    } catch (closeError) {
      if (!failed) {
        failed = true;
        failure = closeError;
      }
    }
  }
  if (failed) throw failure;
  return result;
}

function readBaseline(options) {
  if (options.phase !== "repair") return null;
  if (!options.baselineManifest) {
    throw new ProbeRefusal(
      "c13-42-baseline-manifest-required",
      "repair characterization requires --baseline-manifest",
    );
  }
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(options.baselineManifest), "utf8"),
    );
  } catch (error) {
    throw new ProbeRefusal(
      "c13-42-baseline-manifest-invalid",
      "C13-42 baseline manifest is absent, unreadable, or malformed",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

export const descriptor = {
  name: "c13-42-reported-demos",
  title: "C13-42 reported demos and offline cloud-station characterization",
  outputSubdirectory: "c13-42-reported-demos",
  receiptEnvelope: "runtime",
  servedArtifacts: STATIC_SERVED_ARTIFACTS,
  workBudgetMs,
  args: {
    defaults: { renderers: ["webgpu"], runs: 1 },
    extraOptions: [
      {
        flag: "--phase",
        key: "phase",
        kind: "string",
        default: "baseline",
      },
      {
        flag: "--run-id",
        key: "runId",
        kind: "string",
        default: "c13-42-characterization",
      },
      {
        flag: "--baseline-manifest",
        key: "baselineManifest",
        kind: "string",
        default: "",
      },
      {
        flag: "--progress-subject",
        key: "progressSubject",
        kind: "string",
        default: "",
      },
      {
        flag: "--cloud-noise-morphology",
        key: "cloudNoiseMorphology",
        kind: "string",
        default: "",
      },
    ],
  },
  async cells(context) {
    const {
      browser,
      run,
      options,
      origin,
      outputDirectory,
      repositoryRoot,
      captures,
      scope,
    } = context;
    let evidenceClosure;
    try {
      evidenceClosure = buildEvidenceClosure(repositoryRoot);
    } catch (error) {
      throw new ProbeRefusal(
        "c13-42-sandcastle-entry-identity-unavailable",
        "Sandcastle app or bucket content-addressed entry is absent or unreadable",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    const evidenceFiles = evidenceClosure.files;
    const startSnapshot = snapshotEvidenceFiles(evidenceFiles);
    const readable = compareEvidenceFileSnapshots(startSnapshot, startSnapshot);
    if (!readable.ok) {
      throw new ProbeRefusal(
        "c13-42-evidence-unreadable",
        "local C13-42 evidence closure is absent or unreadable before navigation",
        readable,
      );
    }
    let buildSourceIdentity;
    try {
      buildSourceIdentity = inspectBuildSourceIdentity({
        sourceMapPath: path.resolve(
          repositoryRoot,
          "packages/engine/Build/Unminified/index.js.map",
        ),
        sourceFiles: BUILD_SOURCE_FILES,
        repoRoot: repositoryRoot,
      });
    } catch (error) {
      throw new ProbeRefusal(
        "c13-42-build-source-identity-unavailable",
        "the C13-42 engine build source identity is absent or unreadable",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!buildSourceIdentity.ok) {
      throw new ProbeRefusal(
        "c13-42-build-source-identity",
        "the served engine build is not source-identical for the C13-42 closure",
        buildSourceIdentity,
      );
    }
    const scheduledSubjects = buildC13_42Schedule().coreSubjects;
    const subjects = options.progressSubject
      ? scheduledSubjects.filter(
          (subject) => subject.id === options.progressSubject,
        )
      : scheduledSubjects;
    if (subjects.length !== (options.progressSubject ? 1 : 7)) {
      throw new ProbeRefusal(
        "c13-42-progress-subject",
        "the requested progress subject is not in the frozen C13-42 schedule",
        { progressSubject: options.progressSubject },
      );
    }
    const cells = [];
    for (const subject of subjects) {
      scope.checkpoint();
      cells.push(
        await runSubject({
          browser,
          subject,
          run,
          options,
          origin,
          outputDirectory,
          captures,
          scope,
          repositoryRoot,
          dynamicServedArtifacts: evidenceClosure.dynamicArtifacts,
          allowedServedArtifacts: evidenceClosure.allowedServedArtifacts,
          snapshottedServedArtifacts: evidenceClosure.snapshottedArtifacts,
        }),
      );
    }
    const endSnapshot = snapshotEvidenceFiles(evidenceFiles);
    const stable = compareEvidenceFileSnapshots(startSnapshot, endSnapshot);
    if (!stable.ok) {
      throw new ProbeRefusal(
        "c13-42-evidence-mutated",
        "local C13-42 evidence bytes changed during characterization",
        stable,
      );
    }
    if (options.progressSubject) {
      throw new ProbeRefusal(
        "c13-42-progress-subject-complete",
        "the selected progress subject completed outside the seven-cell receipt",
        { progressSubject: options.progressSubject, cells },
      );
    }
    const sourceDigest = hashC13_42Definition(startSnapshot);
    const buildDigest = hashC13_42Definition(buildSourceIdentity);
    const servedDigest = hashC13_42Definition(
      cells.map((cell) => ({ id: cell.id, served: cell.served })),
    );
    return cells.map((cell) => ({
      ...cell,
      runId: options.runId,
      phase: options.phase,
      identity: {
        source: { sha256: sourceDigest },
        build: { sha256: buildDigest },
        served: { sha256: servedDigest },
        fixtureHash: fixtureScheduleHash(),
        metricHash: metricDefinitionHash({
          contract: startSnapshot.contract,
          cloudImageAnalysis: startSnapshot.cloudMetrics,
          cloudTourMetrics: startSnapshot.tourMetrics,
        }),
      },
    }));
  },
  verdicts(cells, { options }) {
    const core = foldC13_42Verdicts(cells, { phase: options.phase });
    if (core.status === "ERROR") {
      throw new Error(
        `C13-42 characterization error: ${core.worstCells.join(", ")}`,
      );
    }
    if (core.status === "FAIL") {
      return core.worstCells.map((id) => ({
        id,
        pass: false,
        status: "FAIL",
        claim:
          "C13-42 core subject completed its real-work and restoration contract",
      }));
    }
    const receipt = buildReceipt(cells, options);
    const validation = validateC13_42Receipt(receipt);
    if (validation.status !== "PASS") {
      throw new ProbeRefusal(
        "c13-42-receipt-structural",
        "C13-42 characterization did not satisfy its receipt schema",
        { core, validation, receipt },
      );
    }
    const baseline = readBaseline(options);
    const comparison = baseline ? compareC13_42Phases(baseline, receipt) : null;
    if (comparison && comparison.status !== "PASS") {
      throw new ProbeRefusal(
        "c13-42-baseline-repair-incomparable",
        "C13-42 baseline and repair characterization are not comparable",
        { core, comparison, receipt },
      );
    }
    throw new ProbeRefusal(
      "c13-42-controlled-ray-structural",
      CONTROLLED_RAY_FIXTURE_OBLIGATION.reason,
      {
        core,
        validation,
        comparison,
        receipt,
        thresholds: CHARACTERIZATION_THRESHOLDS,
      },
    );
  },
  receipt(cells, { options }) {
    return buildReceipt(cells, options);
  },
};

export function buildReceipt(cells, options = {}) {
  const first = cells[0];
  return {
    contractVersion: C13_42_CONTRACT_VERSION,
    phase: options.phase ?? null,
    runId: options.runId ?? null,
    thresholds: CHARACTERIZATION_THRESHOLDS,
    identity: first?.identity,
    environment: first?.environment,
    cells,
    controlledRay: CONTROLLED_RAY_FIXTURE_OBLIGATION,
    sourceFile: THIS_FILE,
  };
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
