#!/usr/bin/env node
// Probe (Phase-5 WebGL2 demo polish verify): the two compute-instance
// Sandcastle demos — "WebGPU Orbital Catalog" and "WebGPU SGP4 Satellites" —
// must each RENDER and MOVE on BOTH backends, selected by the demo's own
// ?renderer= query param:
//   - ?renderer=webgl  exercises the WebGL2 CPU-kernel fallback (the JS
//     cpuKernel each demo now ships): the engine has no compute shaders there,
//     so the points come purely from the per-frame CPU kernel.
//   - ?renderer=webgpu exercises the unchanged WGSL compute path.
//
// This is the user-facing counterpart to probe-compute-instance-webgl2.mjs
// (which proves the ENGINE fallback via a toy kernel on CesiumViewer): here we
// drive the REAL standalone Sandcastle demo URLs a user opens, with the demo's
// own orbital/SGP4 kernels, on both backends.
//
// Per (demo, renderer):
//   (A) RENDERS — the satellite dots produce a non-trivial bright-pixel count
//       over space (sampled away from the Earth disk's lit limb so the metric
//       is the catalog points, not the globe).
//   (B) MOVES   — the bright-pixel mask changes substantially between two
//       distinct sim times (animation comes from the per-frame time scalar;
//       params upload once). Confirms the kernel actually advances each frame
//       on this backend.
//   (C) the right backend ran — a WebGPU device was armed for ?renderer=webgpu
//       and NOT for ?renderer=webgl (a silent WebGL fallback on the webgpu leg,
//       or a silent WebGPU on the webgl leg, is a FAIL).
//   (D) ZERO fatal console / WebGPU-validation errors on either backend.
//
// Sandcastle demos hold their viewer in a LOCAL const (no window.viewer), so —
// like sandcastle-smoke.mjs — we capture via a compositor canvas screenshot
// (unaffected by WebGPU present-clears-the-texture) and arm the WebGPU device
// by patching GPUAdapter.prototype.requestDevice. Movement is measured across
// two settle windows with the clock animating (shouldAnimate:true in both
// demos), so a non-moving (dead-kernel) leg trips (B).
//
// Usage: node Tools/visual-regression/probe-compute-instance-webgl2-demos.mjs
// Env:   PROBE_BASE            (default http://localhost:8134)
//        SANDCASTLE_SETTLE_MS  (default 7000)

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
const OUTPUT_DIR = path.join(__dirname, "output", "compute-instance-webgl2-demos");
const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const SETTLE_MS = parseInt(process.env.SANDCASTLE_SETTLE_MS, 10) || 7000;
// Both demos animate at clock.multiplier=60, so wall-clock seconds * 60 = sim
// seconds. 12 s wall = ~12 sim-minutes — enough that even the SGP4 LEO shell
// (the closest, smallest-arc case) sweeps a clearly visible arc. The catalog
// (pulled far back) moves much more.
const MOVE_WAIT_MS = 12000;
const NAV_TIMEOUT_MS = 60000;

// Both demos draw bright satellite dots (cyan/yellow/magenta/white/green) on a
// near-black space background. A pixel is "bright" if any channel is well lit;
// the Earth disk is small and dim from the demos' pulled-back cameras, so the
// bright-pixel set is dominated by the catalog points — which is exactly what
// we want to measure for render + move.
// Pass criteria per demo:
//   minBright   — bright (lit) pixel floor at each capture (RENDER).
//   minMovedPx  — ABSOLUTE count of pixels whose bright-state flips between the
//                 two captures (MOVE). Frame-differencing isolates the moving
//                 dots from the STATIC globe (fixed camera, no auto-rotation),
//                 so the SGP4 globe filling the frame does not dilute the
//                 motion signal the way a bright-count-normalized ratio would.
const DEMOS = [
  {
    file: "WebGPU Orbital Catalog.html",
    minBright: 2000, // thousands of dots from a 110 Mm camera; healthy >> this
    minMovedPx: 3000,
    label: "orbital catalog (secular-J2)",
  },
  {
    file: "WebGPU SGP4 Satellites.html",
    minBright: 1000, // ~180 near-earth dots + the lit globe disk
    minMovedPx: 800, // dots sweep a visible arc over ~12 sim-minutes
    label: "SGP4 satellites (real TLEs)",
  },
];

const SUPPRESSED_CONSOLE = [
  /\[WebGPU:/,
  /\[WebGPUPrimitiveCommands\]/,
  /\[CesiumJS:webgpu/,
  /powerPreference option is currently ignored/i,
  /favicon/i,
];

function isExternalResourceFailure(text, locationUrl) {
  if (!/Failed to load resource/i.test(text)) {
    return false;
  }
  return typeof locationUrl === "string" && !locationUrl.startsWith(BASE);
}

function demoUrl(file, renderer) {
  return `${BASE}/Apps/Sandcastle/gallery/${encodeURIComponent(file)}?renderer=${renderer}`;
}

// Capture the canvas and return a bright-pixel mask + count. Bright = a lit
// channel well above the dim space/Earth background.
async function captureBrightMask(page, pngPath) {
  const canvas = await page.$(".cesium-widget canvas");
  if (!canvas) {
    return null;
  }
  const png = await canvas.screenshot({ type: "png" });
  await fs.writeFile(pngPath, png);
  return await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bm = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bm.width, bm.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bm, 0, 0);
    const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
    const total = bm.width * bm.height;
    const mask = new Uint8Array(total);
    let count = 0;
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      // A catalog dot lights at least one channel strongly. Earth's lit limb
      // is broad but the camera is pulled far back so the disk is small; the
      // dots dominate the bright set either way.
      if (d[i] > 170 || d[i + 1] > 170 || d[i + 2] > 170) {
        mask[p] = 1;
        count++;
      }
    }
    return { w: bm.width, h: bm.height, count, mask: Array.from(mask) };
  }, png.toString("base64"));
}

async function runLeg(browser, demo, renderer) {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const errors = [];
  const suppressed = [];
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
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.addInitScript(errorGateInit);
  await page.addInitScript(() => {
    if (typeof GPUAdapter === "undefined") {
      return;
    }
    const original = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await original.apply(this, args);
      try {
        window.__armWebGPUDevice?.(device, "webgl2-demos");
      } catch {
        /* arming must never break the demo */
      }
      return device;
    };
  });

  const tag = `${demo.file.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]/g, "_")}.${renderer}`;
  const result = {
    demo: demo.file,
    renderer,
    label: demo.label,
    ok: false,
    countA: 0,
    countB: 0,
    movedPx: 0,
    armedDevices: 0,
    errors,
    suppressedCount: 0,
  };

  try {
    await page.goto(demoUrl(demo.file, renderer), {
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

    const A = await captureBrightMask(
      page,
      path.join(OUTPUT_DIR, `${tag}.a.png`),
    );
    // Both demos animate (shouldAnimate:true, clock.multiplier=60), so simply
    // waiting advances sim time; the kernel must move the dots.
    await page.waitForTimeout(MOVE_WAIT_MS);
    const B = await captureBrightMask(
      page,
      path.join(OUTPUT_DIR, `${tag}.b.png`),
    );

    let changed = 0;
    if (A && B && A.mask.length === B.mask.length) {
      for (let p = 0; p < A.mask.length; p++) {
        if (A.mask[p] !== B.mask[p]) {
          changed++;
        }
      }
    }
    result.countA = A ? A.count : 0;
    result.countB = B ? B.count : 0;
    result.movedPx = changed;

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

    const rendersOK = result.countA >= demo.minBright && result.countB >= demo.minBright;
    const movesOK = result.movedPx >= demo.minMovedPx;
    // Backend identity: webgpu MUST arm a device; webgl MUST NOT.
    const backendOK =
      renderer === "webgpu" ? gate.armedDevices >= 1 : gate.armedDevices === 0;
    result.rendersOK = rendersOK;
    result.movesOK = movesOK;
    result.backendOK = backendOK;
    result.ok = rendersOK && movesOK && backendOK && result.errors.length === 0;
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
  for (const renderer of ["webgl", "webgpu"]) {
    const r = await runLeg(browser, demo, renderer);
    allOK = allOK && r.ok;
    console.log(
      `\n[${r.ok ? "PASS" : "FAIL"}] ${r.demo} ?renderer=${r.renderer} — ${r.label}`,
    );
    console.log(
      `  (A) renders: bright px A=${r.countA} B=${r.countB} (min ${demo.minBright}) ${r.rendersOK ? "OK" : "FAIL"}`,
    );
    console.log(
      `  (B) moves:   ${r.movedPx} px flipped bright-state (min ${demo.minMovedPx}) ${r.movesOK ? "OK" : "FAIL"}`,
    );
    console.log(
      `  (C) backend: armedDevices=${r.armedDevices} (webgpu>=1, webgl==0) ${r.backendOK ? "OK" : "FAIL"}`,
    );
    console.log(
      `  (D) errors:  ${r.errors.length} fatal, ${r.suppressedCount} suppressed ${r.errors.length === 0 ? "OK" : "FAIL"}`,
    );
    for (const e of r.errors.slice(0, 6)) {
      console.log(`    ERR: ${e.slice(0, 220)}`);
    }
  }
}

await browser.close();
console.log(
  `\n${allOK ? "PASS" : "FAIL"}: probe-compute-instance-webgl2-demos (${DEMOS.length} demos x 2 backends)`,
);
process.exit(allOK ? 0 : 1);
