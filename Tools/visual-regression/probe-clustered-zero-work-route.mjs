#!/usr/bin/env node
// probe-clustered-zero-work-route — C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT
// physical API-counter gate (Wave 2 item 32).
// @purpose C9-16 API-counter gate: zero clustered GPU work at defaults on the moving route, with positive control and label-inventory guard.
// @status ACTIVE
//
// Proves, on the shared moving multi-altitude camera route, that at DEFAULTS
// (clustered lighting off) the WebGPU backend allocates, uploads, dispatches,
// and submits ZERO clustered-light work — measured by patching the real GPU
// device API and bucketing every call by its resource/pass LABEL. Clustered
// resources carry stable label prefixes (verified in the dispatcher/renderers):
//   - buffers:  "ClusteredLighting params", "LTC area lights",
//               "ClusterBounds*", "ClusterAssign*"
//   - textures: "LTC LUT*" (Batch 684 — createTexture/writeTexture now watched)
//   - compute:  "ClusterBounds compute pass", "ClusterAssign compute pass"
//
// C9-AUDIT-P1-SWEEP (Batch 684): the gate watched only 4 API surfaces and the
// label regex missed the "LTC LUT" texture family. Added createTexture +
// writeTexture counters and 'LTC LUT' to the regex, plus a source-derived
// label-inventory assertion: every clustered GPU-resource label in the four
// clustered source files MUST match CLUSTER_LABEL_RE, so a rename breaks this
// probe loudly instead of silently escaping the gate.
//
// Phase A (defaults / moving route): NO clustered-prefixed label may appear
//   under createBuffer / createTexture / createBindGroup / writeBuffer /
//   writeTexture / beginComputePass.
// Phase B (positive control): with clusteredLightingEnabled + one point light,
//   the SAME patched counters MUST record clustered-prefixed labels — this
//   guards against a silent label rename greening the gate forever.
//
// Feature default-off is asserted from the engine (scene.clusteredLightingEnabled
// starts false); the FEATURE is never disabled to pass — Phase B re-enables and
// requires the work to appear.
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). Phase A's route
// is the kit's `GLOBE_CAMERA_TRACK`; Phase B's scene is the rig
// `clustered-zero-work-control`, read from `rigs/`. The browser, the origin
// (`--port`, a governed port, never 8080), the served-build preflight, the
// Edge slot and the receipt belong to `lib/probe-runtime.mjs`, which launches
// Edge with this probe's own Vulkan flags (recorded in the runtime receipt).
// Device errors are the shared WebGPU error gate's
// (`Tools/lib/webgpu-error-gate.mjs`), which owns the `onuncapturederror`
// slot this probe used to assign itself and also reports a lost device.
//
// THE REPORT KEEPS ITS FIELDS, NOT ITS FILE NAME. The original wrote
// `output/performance/campaign9-c9-16-clustered-zero-work-api-r1-<date>.json`.
// The same fields (id, kind, generatedAt, base, workload, clusterLabelRegex,
// result, classification, labelInventory and the phase counters) are this
// probe's `probe-owned` receipt, which the runtime writes as
// `output/clustered-zero-work-route/clustered-zero-work-route-report.json`
// beside its own `-runtime.json`. No code reads the dated file; the three
// banked C9 copies stay where they are.
//
// THE LABEL INVENTORY IS ALSO A STANDING GATE NOW. `scanClusteredLabelInventory`
// is pure and exported; `clustered-probe-verdicts.spec.mjs` runs it over the
// four real source files under plain `node --test`, so a clustered label
// renamed out of `CLUSTER_LABEL_RE` turns a Node spec red without a browser.
//
// Usage: node Tools/visual-regression/probe-clustered-zero-work-route.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import { GLOBE_CAMERA_TRACK } from "./lib/globe-camera-track.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import rig from "./rigs/clustered-zero-work-control.mjs";

export const CLUSTER_LABEL_RE =
  "^(ClusterBounds|ClusterAssign|ClusteredLighting|LTC area|LTC LUT)";

/**
 * The four clustered source files whose `label: "..."` strings must all match
 * {@link CLUSTER_LABEL_RE}, repo-relative and POSIX.
 */
export const CLUSTERED_SOURCE_FILES = Object.freeze(
  [
    "WebGPUClusterAssignRenderer.ts",
    "WebGPUClusterBoundsRenderer.ts",
    "WebGPUClusteredLightingDispatcher.ts",
    "WebGPUClusteredLightingBGL.ts",
  ].map((file) => `packages/engine/Source/Renderer/WebGPU/${file}`),
);

/**
 * Every double-quoted `label: "..."` string in the given sources, and the ones
 * that do NOT match {@link CLUSTER_LABEL_RE} (they would escape the zero-work
 * gate). The original's scan, unchanged, as a pure function over text.
 *
 * @param {Array<{file: string, text: string}>} sources
 * @returns {{inventory: string[], escaped: Array<{file: string, label: string}>}}
 */
export function scanClusteredLabelInventory(sources) {
  const clusterRe = new RegExp(CLUSTER_LABEL_RE);
  const inventory = [];
  const escaped = [];
  for (const { file, text } of sources) {
    const LABEL_RE = /label:\s*"([^"]+)"/g; // clustered labels are double-quoted
    let m;
    while ((m = LABEL_RE.exec(text)) !== null) {
      const label = m[1];
      inventory.push(label);
      if (!clusterRe.test(label)) {
        escaped.push({ file: file.split(/[\\/]/).pop(), label });
      }
    }
  }
  return { inventory, escaped };
}

/**
 * Read the four clustered source files from a repository root and scan them.
 *
 * @param {string} repositoryRoot Absolute repository root.
 * @returns {{scannedCount: number, escaped: Array<{file: string, label: string}>, unreadable: string[]}}
 */
export function readClusteredLabelInventory(repositoryRoot) {
  const sources = [];
  const unreadable = [];
  for (const file of CLUSTERED_SOURCE_FILES) {
    try {
      sources.push({
        file,
        text: readFileSync(
          path.join(repositoryRoot, ...file.split("/")),
          "utf8",
        ),
      });
    } catch (error) {
      unreadable.push(`${file}: ${error}`);
    }
  }
  const { inventory, escaped } = scanClusteredLabelInventory(sources);
  return { scannedCount: inventory.length, escaped, unreadable };
}

/**
 * Page side: patch the real device API, fly the route at defaults (Phase A),
 * then enable clustered lighting with one point light (Phase B), bucketing
 * every clustered-labelled call per phase. Unchanged from the in-page
 * original apart from reading the rig, and from leaving `onuncapturederror`
 * to the shared gate.
 *
 * @param {{track: object[], clusterRe: string, camera: object, dials: object}} input
 * @returns {Promise<object>} The phase counters, or `{earlyExitErr}`.
 */
async function pageZeroWork({ track, clusterRe, camera, dials }) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const C = mod;
  const v = window.viewer;
  const scene = v.scene;
  const re = new RegExp(clusterRe);

  const device = scene.context._device;
  if (!device) return { earlyExitErr: "no WebGPU device" };

  // Per-phase label buckets across the measured counters (Batch 684 adds
  // createTexture + writeTexture so the LTC LUT texture family is covered).
  const emptyCounters = () => ({
    createBuffer: Object.create(null),
    createTexture: Object.create(null),
    createBindGroup: Object.create(null),
    writeBuffer: Object.create(null),
    writeTexture: Object.create(null),
    beginComputePass: Object.create(null),
  });
  let current = emptyCounters();
  const bump = (counter, label) => {
    if (typeof label !== "string" || !re.test(label)) return;
    current[counter][label] = (current[counter][label] || 0) + 1;
  };

  // Patch the real device surface. createCommandEncoder is wrapped so the
  // per-encoder beginComputePass can be observed (compute passes are opened
  // on encoders, not the device).
  const origCreateBuffer = device.createBuffer.bind(device);
  device.createBuffer = (desc) => {
    bump("createBuffer", desc?.label);
    return origCreateBuffer(desc);
  };
  const origCreateTexture = device.createTexture.bind(device);
  device.createTexture = (desc) => {
    bump("createTexture", desc?.label);
    return origCreateTexture(desc);
  };
  const origCreateBindGroup = device.createBindGroup.bind(device);
  device.createBindGroup = (desc) => {
    bump("createBindGroup", desc?.label);
    return origCreateBindGroup(desc);
  };
  const origWriteBuffer = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, ...rest) => {
    bump("writeBuffer", buffer?.label);
    return origWriteBuffer(buffer, ...rest);
  };
  const origWriteTexture = device.queue.writeTexture.bind(device.queue);
  device.queue.writeTexture = (destination, ...rest) => {
    // writeTexture(destination, data, dataLayout, size): the label lives on
    // destination.texture (GPUImageCopyTexture).
    bump("writeTexture", destination?.texture?.label);
    return origWriteTexture(destination, ...rest);
  };
  const origCreateEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (desc) => {
    const enc = origCreateEncoder(desc);
    const origBegin = enc.beginComputePass.bind(enc);
    enc.beginComputePass = (cdesc) => {
      bump("beginComputePass", cdesc?.label);
      return origBegin(cdesc);
    };
    return enc;
  };

  const flyRoute = async () => {
    for (const wp of track) {
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
        orientation: {
          heading: C.Math.toRadians(wp.heading),
          pitch: C.Math.toRadians(wp.pitch),
          roll: C.Math.toRadians(wp.roll),
        },
      });
      // A few frames per waypoint to let terrain/effects settle so any
      // effect-driven allocation would occur.
      for (let i = 0; i < dials.framesPerWaypoint; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
  };

  const total = (counters) =>
    Object.values(counters).reduce(
      (sum, bucket) => sum + Object.keys(bucket).length,
      0,
    );

  // ── Phase A — defaults, moving route ──
  const defaultEnabled = scene.clusteredLightingEnabled; // must be false
  current = emptyCounters();
  await flyRoute();
  const phaseA = current;
  const phaseALabelCount = total(phaseA);

  // ── Phase B — positive control: enable + one point light ──
  scene.clusteredLightingEnabled = true;
  const point = dials.pointLight;
  scene.lights.add(
    new C.PointLight({
      position: C.Cartesian3.fromDegrees(point.lon, point.lat, point.height),
      color: C.Color[point.colorName],
      intensity: point.intensity,
      range: point.range,
    }),
  );
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.height,
    ),
    orientation: { pitch: camera.pitch },
  });
  current = emptyCounters();
  for (let i = 0; i < dials.controlFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const phaseB = current;
  const phaseBLabelCount = total(phaseB);

  return {
    defaultEnabled,
    phaseA,
    phaseALabelCount,
    phaseB,
    phaseBLabelCount,
  };
}

/**
 * Classify clustered-prefixed labels into two disjoint classes. Unchanged from
 * the original:
 *   - WORK: the dispatcher's real per-frame allocate/upload/dispatch/submit
 *     resources (ClusterBounds*, ClusterAssign*, real "ClusteredLighting
 *     params", real "LTC area lights") and any clustered compute pass. This
 *     is the "clustered-light work" the zero-work contract forbids at defaults.
 *   - FALLBACK: the shared per-device "*placeholder*" resources the effects
 *     system binds so consumers always have a valid resource at the clustered
 *     slots (the always-bind-something contract). Created ONCE per device,
 *     never per frame; removing them would break the feature, so they are not
 *     a zero-work violation — but they must stay bounded (created at most once
 *     across the whole route, not re-churned per frame).
 *
 * @param {Record<string, Record<string, number>>} counters Per-API label buckets.
 * @returns {{work: object, fallback: object, workTotal: number, computeWork: number, maxFallbackCount: number}}
 */
export function classifyClusteredWork(counters) {
  const isPlaceholder = (label) => /placeholder/i.test(label);
  const work = {};
  const fallback = {};
  let workTotal = 0;
  let computeWork = 0;
  let maxFallbackCount = 0;
  for (const [counter, bucket] of Object.entries(counters)) {
    for (const [label, count] of Object.entries(bucket)) {
      if (isPlaceholder(label)) {
        fallback[`${counter}:${label}`] = count;
        if (count > maxFallbackCount) maxFallbackCount = count;
      } else {
        work[`${counter}:${label}`] = count;
        workTotal += count;
        if (counter === "beginComputePass") computeWork += count;
      }
    }
  }
  return { work, fallback, workTotal, computeWork, maxFallbackCount };
}

/**
 * The original's clauses, per run, with its bars: a WebGPU device exists (its
 * EARLY-EXIT exited 1); every clustered label in the four source files
 * matches the watched regex and every file was readable; clustered lighting
 * starts off; Phase A records zero clustered work and zero clustered compute
 * passes; the shared placeholders are created at most once each in Phase A;
 * Phase B records clustered work AND a clustered compute pass; no uncaptured
 * device error. A lost device is the shared error gate's addition.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateZeroWorkRoute(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.earlyExit === null;
    const not = `not measured: ${cell.earlyExit}`;
    const inv = cell.labelInventory;
    verdicts.push(
      {
        id: `webgpu-device/${suffix}`,
        claim: `a WebGPU device exists${measured ? "" : ` (${cell.earlyExit})`}`,
        pass: measured,
      },
      {
        id: `label-inventory/${suffix}`,
        claim: `label inventory: ${inv.scannedCount} clustered labels scanned across ${CLUSTERED_SOURCE_FILES.length} source files, ${inv.escaped.length} outside ${CLUSTER_LABEL_RE}, ${inv.unreadable.length} unreadable (0 and 0)`,
        pass: inv.escaped.length === 0 && inv.unreadable.length === 0,
        detail: { escaped: inv.escaped, unreadable: inv.unreadable },
      },
    );
    const a = cell.classification?.phaseA;
    const b = cell.classification?.phaseB;
    verdicts.push(
      {
        id: `default-off/${suffix}`,
        claim: measured
          ? `default scene.clusteredLightingEnabled: ${cell.defaultEnabled} (false)`
          : `default scene.clusteredLightingEnabled: ${not}`,
        pass: measured && cell.defaultEnabled === false,
      },
      {
        id: `phase-a-zero-work/${suffix}`,
        claim: measured
          ? `Phase A clustered WORK labels at defaults: ${a.workTotal} (0)`
          : `Phase A clustered WORK labels: ${not}`,
        pass: measured && a.workTotal === 0,
        detail: measured ? { work: a.work } : undefined,
      },
      {
        id: `phase-a-zero-compute/${suffix}`,
        claim: measured
          ? `Phase A clustered compute passes at defaults: ${a.computeWork} (0)`
          : `Phase A clustered compute passes: ${not}`,
        pass: measured && a.computeWork === 0,
      },
      {
        id: `phase-a-placeholders-bounded/${suffix}`,
        claim: measured
          ? `Phase A shared placeholder fallback, max count per label: ${a.maxFallbackCount} (<= 1)`
          : `Phase A shared placeholder fallback: ${not}`,
        pass: measured && a.maxFallbackCount <= 1,
        detail: measured ? { fallback: a.fallback } : undefined,
      },
      {
        id: `phase-b-positive-control/${suffix}`,
        claim: measured
          ? `Phase B (enabled + 1 light) clustered WORK labels ${b.workTotal}, compute passes ${b.computeWork} (both > 0)`
          : `Phase B positive control: ${not}`,
        pass: measured && b.workTotal > 0 && b.computeWork > 0,
        detail: measured ? { work: b.work } : undefined,
      },
      {
        id: `device-errors/${suffix}`,
        claim: `uncaptured device errors: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 10) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `device lost: ${cell.deviceLost ?? "no"}`,
        pass: cell.deviceLost === null,
      },
    );
  }
  return verdicts;
}

/** The rig's page (offline) on the run's origin, on the WebGPU backend. */
function sceneUrl(origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", "webgpu");
  return url.href;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "clustered-zero-work-route",
  title:
    "C9-16 clustered zero-work API-counter gate — nothing at defaults on the route, work when enabled",
  outputSubdirectory: "clustered-zero-work-route",
  // The original banked its own JSON report; its fields are kept as this
  // probe's document, with the runtime's facts in a separate `-runtime.json`.
  receiptEnvelope: "probe-owned",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // The original's own launch flags, kept as a recorded measurement condition.
  launchArgs: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan",
  ],
  async cells({ browser, run, options, origin, repositoryRoot }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the clustered zero-work contract is a WebGPU backend contract, so " +
          `this probe has nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const labelInventory = readClusteredLabelInventory(repositoryRoot);
    const context = await browser.newContext({ viewport: { ...rig.viewport } });
    try {
      const page = await context.newPage();
      await page.addInitScript(errorGateInit);
      await page.goto(sceneUrl(origin), { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);
      const result = await page.evaluate(pageZeroWork, {
        track: GLOBE_CAMERA_TRACK,
        clusterRe: CLUSTER_LABEL_RE,
        camera: rig.camera,
        dials: rig.dials,
      });
      const gate = await collectGateErrors(page);
      const measured = !result.earlyExitErr;
      return [
        {
          run,
          earlyExit: result.earlyExitErr ?? null,
          defaultEnabled: result.defaultEnabled,
          phaseA: result.phaseA,
          phaseALabelCount: result.phaseALabelCount,
          phaseB: result.phaseB,
          phaseBLabelCount: result.phaseBLabelCount,
          classification: measured
            ? {
                phaseA: classifyClusteredWork(result.phaseA),
                phaseB: classifyClusteredWork(result.phaseB),
              }
            : null,
          labelInventory,
          deviceErrors: gate.errors,
          deviceLost: gate.deviceLost,
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateZeroWorkRoute(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    const last = cells.at(-1) ?? {};
    return {
      id: "C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT",
      kind: "clustered-zero-work-api-gate",
      generatedAt: context.generatedAt,
      base: context.origin,
      workload: "moving-camera-altitude-track-3d (GLOBE_CAMERA_TRACK)",
      clusterLabelRegex: CLUSTER_LABEL_RE,
      result: context.verdicts.every((verdict) => verdict.pass === true)
        ? "pass"
        : "fail",
      classification: last.classification ?? null,
      labelInventory: last.labelInventory ?? null,
      defaultEnabled: last.defaultEnabled,
      phaseA: last.phaseA,
      phaseALabelCount: last.phaseALabelCount,
      phaseB: last.phaseB,
      phaseBLabelCount: last.phaseBLabelCount,
      deviceErrors: last.deviceErrors ?? [],
      rig: rig.id,
      cells,
      verdicts: context.verdicts,
    };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
