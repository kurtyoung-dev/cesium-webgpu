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

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { GLOBE_CAMERA_TRACK } from "./lib/globe-camera-track.mjs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(
  __dirname,
  "output",
  "performance",
  `campaign9-c9-16-clustered-zero-work-api-r1-${new Date()
    .toISOString()
    .slice(0, 10)}.json`,
);

const CLUSTER_LABEL_RE =
  "^(ClusterBounds|ClusterAssign|ClusteredLighting|LTC area|LTC LUT)";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1000 },
  });
  page.on("pageerror", () => {});
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ track, clusterRe }) => {
      const mod = await import("/Build/CesiumUnminified/index.js");
      const C = mod;
      const v = window.viewer;
      const scene = v.scene;
      const re = new RegExp(clusterRe);

      const errors = [];
      const device = scene.context._device;
      if (!device) return { earlyExitErr: "no WebGPU device" };
      device.onuncapturederror = (ev) =>
        errors.push(ev?.error?.message ?? "unknown");

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
          for (let i = 0; i < 4; i++) {
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
      scene.lights.add(
        new C.PointLight({
          position: C.Cartesian3.fromDegrees(86.925, 27.99, 200),
          color: C.Color.YELLOW,
          intensity: 5,
          range: 500,
        }),
      );
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(86.925, 27.985, 600),
        orientation: { pitch: C.Math.toRadians(-20) },
      });
      current = emptyCounters();
      for (let i = 0; i < 20; i++) {
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
        deviceErrors: errors,
      };
    },
    { track: GLOBE_CAMERA_TRACK, clusterRe: CLUSTER_LABEL_RE },
  );

  await browser.close();

  if (result.earlyExitErr) {
    console.log(`EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }

  let pass = true;
  const fail = (msg) => {
    console.log(`FAIL: ${msg}`);
    pass = false;
  };

  // Classify clustered-prefixed labels into two disjoint classes:
  //   - WORK: the dispatcher's real per-frame allocate/upload/dispatch/submit
  //     resources (ClusterBounds*, ClusterAssign*, real "ClusteredLighting
  //     params", real "LTC area lights") and any clustered compute pass. This
  //     is the "clustered-light work" the zero-work contract forbids at defaults.
  //   - FALLBACK: the shared per-device "*placeholder*" resources the effects
  //     system binds so consumers always have a valid resource at the clustered
  //     slots (the always-bind-something contract). Created ONCE per device,
  //     never per frame; removing them would break the feature, so they are not
  //     a zero-work violation — but they must stay bounded (created at most once
  //     across the whole route, not re-churned per frame).
  const isPlaceholder = (label) => /placeholder/i.test(label);
  const classify = (counters) => {
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
  };

  const a = classify(result.phaseA);
  const b = classify(result.phaseB);

  // ── Label-inventory assertion (Batch 684) ──
  // The counters only bucket labels that match CLUSTER_LABEL_RE, so a clustered
  // GPU-resource label renamed OUT of the regex would silently escape the gate.
  // Grep the four clustered source files for every `label: "..."` string and
  // assert each still matches the watched regex — a rename breaks THIS probe
  // loudly instead of greening the gate forever. If an escape is found it is a
  // REAL finding (either the regex or the source drifted); do not weaken it.
  const CLUSTERED_SOURCE_FILES = [
    "WebGPUClusterAssignRenderer.ts",
    "WebGPUClusterBoundsRenderer.ts",
    "WebGPUClusteredLightingDispatcher.ts",
    "WebGPUClusteredLightingBGL.ts",
  ].map((f) =>
    resolve(
      __dirname,
      "..",
      "..",
      "packages",
      "engine",
      "Source",
      "Renderer",
      "WebGPU",
      f,
    ),
  );
  const clusterRe = new RegExp(CLUSTER_LABEL_RE);
  const LABEL_RE = /label:\s*"([^"]+)"/g; // clustered labels are double-quoted
  const inventory = [];
  const escapedLabels = [];
  for (const file of CLUSTERED_SOURCE_FILES) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch (e) {
      fail(`label-inventory: cannot read ${file}: ${e}`);
      continue;
    }
    let m;
    while ((m = LABEL_RE.exec(src)) !== null) {
      const label = m[1];
      inventory.push(label);
      if (!clusterRe.test(label)) {
        escapedLabels.push({ file: file.split(/[\\/]/).pop(), label });
      }
    }
  }
  console.log(
    `  label inventory: ${inventory.length} clustered labels scanned across ${CLUSTERED_SOURCE_FILES.length} source files`,
  );
  if (escapedLabels.length > 0) {
    fail(
      `label-inventory: ${escapedLabels.length} clustered GPU-resource label(s) do NOT match ` +
        `CLUSTER_LABEL_RE (${CLUSTER_LABEL_RE}) — they would ESCAPE the zero-work gate: ` +
        JSON.stringify(escapedLabels),
    );
  }

  console.log("[probe-clustered-zero-work-route]");
  console.log(
    `  default scene.clusteredLightingEnabled: ${result.defaultEnabled}`,
  );
  console.log("  --- Phase A (defaults / moving route) ---");
  console.log(`    clustered WORK labels (must be ZERO): ${a.workTotal}`);
  console.log(`    clustered compute passes (must be ZERO): ${a.computeWork}`);
  console.log(JSON.stringify(a.work, null, 4));
  console.log(
    `    shared placeholder fallback (bounded, created once, max count ${a.maxFallbackCount}):`,
  );
  console.log(JSON.stringify(a.fallback, null, 4));
  console.log("  --- Phase B (positive control: enabled + 1 light) ---");
  console.log(`    clustered WORK labels (must be > 0): ${b.workTotal}`);
  console.log(`    clustered compute passes (must be > 0): ${b.computeWork}`);
  console.log(JSON.stringify(b.work, null, 4));
  console.log(`  device errors: ${result.deviceErrors.length}`);

  if (result.defaultEnabled !== false) {
    fail(
      `clustered lighting is not default-off (scene.clusteredLightingEnabled=${result.defaultEnabled})`,
    );
  }
  if (a.workTotal !== 0) {
    fail(
      "Phase A recorded real clustered dispatcher WORK at defaults (expected ZERO alloc/upload/dispatch/submit)",
    );
  }
  if (a.computeWork !== 0) {
    fail(
      `Phase A ran ${a.computeWork} clustered compute passes at defaults (expected ZERO)`,
    );
  }
  if (a.maxFallbackCount > 1) {
    fail(
      `Phase A shared placeholder fallback was churned per-frame (max count ${a.maxFallbackCount} > 1) — expected one-time per-device creation`,
    );
  }
  if (b.workTotal === 0 || b.computeWork === 0) {
    fail(
      "Phase B positive control recorded NO clustered dispatcher work — the gate would false-pass (label rename?)",
    );
  }
  if (result.deviceErrors.length !== 0) {
    fail(`${result.deviceErrors.length} device errors`);
  }

  const report = {
    id: "C9-16-CLUSTERED-LIGHT-ZERO-WORK-CONTRACT",
    kind: "clustered-zero-work-api-gate",
    generatedAt: new Date().toISOString(),
    base: BASE,
    workload: "moving-camera-altitude-track-3d (GLOBE_CAMERA_TRACK)",
    clusterLabelRegex: CLUSTER_LABEL_RE,
    result: pass ? "pass" : "fail",
    classification: { phaseA: a, phaseB: b },
    labelInventory: {
      scannedCount: inventory.length,
      escaped: escapedLabels,
    },
    ...result,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${OUT}`);

  if (pass) {
    console.log(
      "\nPASS: zero clustered-light API work at defaults across the moving route; positive control confirms the counters fire when enabled",
    );
  }
  process.exit(pass ? 0 : 1);
})();
