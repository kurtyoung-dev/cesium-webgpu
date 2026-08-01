#!/usr/bin/env node
// Sandcastle WebGPU smoke probe (Batch 242 — CI blind-spot closure).
//
// WHY THIS EXISTS (the DepthPlane lesson): the DepthPlane MRT bug blanked
// EVERY WebGPU Sandcastle demo for ~115 batches while all automated probes
// stayed green, because every probe drove Apps/CesiumViewer — where the
// depth plane happens to be inactive. Sandcastle was structurally unprobed.
// This probe loads real Sandcastle gallery demos (the same standalone URLs
// a user opens) and fails loudly when any of them goes black or emits
// console / WebGPU-validation errors.
//
// Demo selection — three demos that exercise DIFFERENT engine subsystems,
// all renderer-pinned to WebGPU by their own source and all loadable from
// local resources only (no Ion asset IDs):
//   1. WebGPU Orbital Catalog      — globe + depth plane + compute-instance
//                                    system (ComputeInstanceCollection)
//   2. WebGPU Clustered Lighting   — globe OFF, glTF models + clustered
//                                    point/spot lights (Slice 5d)
//   3. WebGPU Point Light Shadows  — entity geometry + glTF model +
//                                    cube-mapped point-light shadows
//
// Pass criteria, per demo:
//   (A) the Cesium canvas exists and a screenshot of it is substantially
//       non-black (per-demo threshold; thresholds are set at roughly HALF
//       the healthy baseline measured at probe-creation time, so a real
//       regression — blank canvas, dead pass, black MRT — trips them while
//       imagery-tile timing jitter does not),
//   (B) the rendered output is non-uniform (>= MIN_DISTINCT distinct
//       sampled colors — catches a solid-color canvas that is technically
//       "non-black"),
//   (C) at least one WebGPU device was created (proves the demo really ran
//       the WebGPU backend; a silent WebGL fallback is a FAIL),
//   (D) ZERO console errors / page errors / uncaptured WebGPU validation
//       errors / device losses. Debug-pragma diagnostics from the
//       unminified build (`[WebGPU:*]` etc.) and EXTERNAL-network resource
//       failures (ion/imagery CDN flake) are suppressed; anything matching
//       the WebGPU fault regex in Tools/lib/webgpu-error-gate.mjs is always
//       fatal, even if it would otherwise be suppressed.
//
// The WebGPU device is armed automatically by patching
// GPUAdapter.prototype.requestDevice in an init script — Sandcastle demos
// keep their viewer in a local const (no window.viewer), so the
// viewer-global walk used by variant-smoke-test cannot reach the device.
//
// Readback: Playwright element screenshot of the canvas (compositor
// capture — unaffected by WebGPU's present-clears-the-texture behavior),
// decoded in-page via createImageBitmap + OffscreenCanvas, no Node PNG dep.
// If a capture is below threshold the probe retries (settle-time jitter:
// model/tile loads) before declaring failure.
//
// CI note: this probe REQUIRES a WebGPU adapter (headless Edge/Chromium on
// a real GPU). GitHub-hosted runners do not expose one, so this is a
// LOCAL-REQUIRED gate (documented in migration_doc/DEBUGGING_GUIDE.md),
// run before committing anything that touches scene-FB passes, the
// post-process blit chain, or the Sandcastle bootstrap.
//
// Usage: node Tools/visual-regression/sandcastle-smoke.mjs
// Env:   PROBE_BASE            (default http://localhost:8134)
//        SANDCASTLE_SETTLE_MS  (default 8000)

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  errorGateInit,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output", "sandcastle-smoke");
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const SETTLE_MS = parseInt(process.env.SANDCASTLE_SETTLE_MS, 10) || 8000;
const NAV_TIMEOUT_MS = 60000;
const RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 4000;
const MIN_DISTINCT = 8;

// minNonBlackPct: ~half the healthy baseline measured 2026-06-12
// (visually confirmed from the saved captures, not just the numbers):
//   orbital   15.8% — Earth disk + three point shells against space
//   clustered 79.7% — lit trucks + dusk background (globe off)
//   shadows  100.0% — ground plane + terrain imagery fill the frame
const DEMOS = [
  {
    file: "WebGPU Orbital Catalog.html",
    minNonBlackPct: 0.08,
    covers: "globe + depth plane + compute-instance system",
  },
  {
    file: "WebGPU Clustered Lighting.html",
    minNonBlackPct: 0.4,
    covers: "glTF models + clustered lighting (globe off)",
  },
  {
    file: "WebGPU Point Light Shadows.html",
    minNonBlackPct: 0.5,
    covers: "entity geometry + glTF model + point-light shadows",
  },
];

// Debug-pragma diagnostics + environment noise from the UNMINIFIED build.
// These are stripped from production bundles and are not regressions. A
// message matching one of these is STILL fatal if it also matches the
// WebGPU fault regex (the gate listener collects it independently).
const SUPPRESSED_CONSOLE = [
  /\[WebGPU:/,
  /\[WebGPUPrimitiveCommands\]/,
  /\[CesiumJS:webgpu/,
  /powerPreference option is currently ignored/i,
  /favicon/i,
];

function isExternalResourceFailure(text, locationUrl) {
  // Ion / imagery-CDN flake should not fail the smoke; a 404 on OUR
  // server (missing SampleData model, broken Build path) must.
  if (!/Failed to load resource/i.test(text)) {
    return false;
  }
  return typeof locationUrl === "string" && !locationUrl.startsWith(BASE);
}

function demoUrl(file) {
  return `${BASE}/Apps/Sandcastle/gallery/${encodeURIComponent(file)}`;
}

async function captureStats(page, pngPath) {
  const canvas = await page.$(".cesium-widget canvas");
  if (!canvas) {
    return null;
  }
  const png = await canvas.screenshot({ type: "png" });
  // Always persist the latest capture — the artifact a failure
  // investigation starts from.
  await fs.writeFile(pngPath, png);
  return await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bm = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bm.width, bm.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bm, 0, 0);
    const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
    const total = bm.width * bm.height;
    let nonBlack = 0;
    const colors = new Set();
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      if (d[i] > 16 || d[i + 1] > 16 || d[i + 2] > 16) {
        nonBlack++;
      }
      // Sparse color sampling (every 997th pixel, 4-bit quantized) —
      // enough to distinguish "real scene" from "solid color fill".
      if (p % 997 === 0) {
        colors.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
      }
    }
    return {
      w: bm.width,
      h: bm.height,
      total,
      nonBlack,
      nonBlackPct: nonBlack / total,
      distinct: colors.size,
    };
  }, png.toString("base64"));
}

async function runDemo(browser, demo) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const errors = [];
  const suppressed = [];
  // WebGPU fault gate (validation / device-lost / fault-matching console
  // prints) — collected independently of the suppression list below.
  const gateConsoleErrors = attachConsoleErrorGate(page);
  page.on("console", (m) => {
    if (m.type() !== "error") {
      return;
    }
    const text = m.text();
    const locationUrl = m.location()?.url;
    if (
      SUPPRESSED_CONSOLE.some((re) => re.test(text)) ||
      isExternalResourceFailure(text, locationUrl)
    ) {
      suppressed.push(text.slice(0, 160));
      return;
    }
    errors.push(`console.error: ${text}`);
  });

  await page.addInitScript(errorGateInit);
  // Auto-arm every WebGPU device at creation time. Sandcastle demos hold
  // their viewer in a local const, so there is no window global to walk —
  // patching requestDevice is the only hook that reaches the device.
  await page.addInitScript(() => {
    if (typeof GPUAdapter === "undefined") {
      return;
    }
    const original = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await original.apply(this, args);
      try {
        window.__armWebGPUDevice?.(device, "sandcastle-smoke");
      } catch {
        /* arming must never break the demo */
      }
      return device;
    };
  });

  const pngPath = path.join(
    OUTPUT_DIR,
    `${demo.file.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]/g, "_")}.png`,
  );
  const result = {
    demo: demo.file,
    covers: demo.covers,
    ok: false,
    stats: null,
    attempts: 0,
    armedDevices: 0,
    errors,
    suppressedCount: 0,
    pngPath,
  };

  try {
    await page.goto(demoUrl(demo.file), {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => {
        const c = document.querySelector(".cesium-widget canvas");
        return c && c.width > 0 && c.height > 0;
      },
      { timeout: NAV_TIMEOUT_MS },
    );
    await page.waitForTimeout(SETTLE_MS);

    // Retry loop — model/tile loads can straggle past the settle window;
    // a real blank-canvas regression stays blank across every attempt.
    let stats = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      result.attempts = attempt;
      stats = await captureStats(page, pngPath);
      if (
        stats &&
        stats.nonBlackPct >= demo.minNonBlackPct &&
        stats.distinct >= MIN_DISTINCT
      ) {
        break;
      }
      if (attempt < RETRY_ATTEMPTS) {
        await page.waitForTimeout(RETRY_WAIT_MS);
      }
    }
    result.stats = stats;

    // Let async GPU errors flush (onuncapturederror fires after queue
    // validation), then fold the gate state into the failure set.
    await page.waitForTimeout(200);
    const gate = await collectGateErrors(page);
    result.armedDevices = gate.armedDevices;
    const fatal = new Set(errors);
    for (const e of gate.errors) {
      fatal.add(e);
    }
    if (gate.deviceLost) {
      fatal.add(gate.deviceLost);
    }
    for (const e of gateConsoleErrors) {
      fatal.add(e);
    }
    result.errors = [...fatal];
    result.suppressedCount = suppressed.length;

    const pixelsOK =
      stats !== null &&
      stats.nonBlackPct >= demo.minNonBlackPct &&
      stats.distinct >= MIN_DISTINCT;
    const deviceOK = gate.armedDevices >= 1;
    result.ok = pixelsOK && deviceOK && result.errors.length === 0;
    result.pixelsOK = pixelsOK;
    result.deviceOK = deviceOK;
  } catch (err) {
    result.errors.push(`probe: ${String(err?.message || err)}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
  return result;
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

let allOK = true;
for (const demo of DEMOS) {
  const r = await runDemo(browser, demo);
  allOK = allOK && r.ok;
  const s = r.stats;
  const pixelLine = s
    ? `nonBlack=${(s.nonBlackPct * 100).toFixed(1)}% (min ${(demo.minNonBlackPct * 100).toFixed(0)}%) distinct=${s.distinct} (min ${MIN_DISTINCT}) ${s.w}x${s.h} attempts=${r.attempts}`
    : "NO CANVAS CAPTURED";
  console.log(`\n[${r.ok ? "PASS" : "FAIL"}] ${r.demo} — ${r.covers}`);
  console.log(`  pixels:  ${pixelLine} ${r.pixelsOK ? "OK" : "FAIL"}`);
  console.log(
    `  webgpu:  armedDevices=${r.armedDevices} (min 1) ${r.deviceOK ? "OK" : "FAIL"}`,
  );
  console.log(
    `  errors:  ${r.errors.length} fatal, ${r.suppressedCount} suppressed (debug-pragma/external-network) ${r.errors.length === 0 ? "OK" : "FAIL"}`,
  );
  console.log(`  capture: ${r.pngPath}`);
  for (const e of r.errors.slice(0, 8)) {
    console.log(`    ERR: ${e.slice(0, 240)}`);
  }
}

await browser.close();
console.log(
  `\n${allOK ? "PASS" : "FAIL"}: sandcastle-smoke (${DEMOS.length} demos)`,
);
process.exit(allOK ? 0 : 1);
