#!/usr/bin/env node
// Sandcastle WebGPU smoke probe (Batch 242 — CI blind-spot closure).
// @purpose Standing Sandcastle CI blind-spot smoke: three local-resource WebGPU gallery demos gated on non-black, non-uniform, real device, zero errors.
// @status ACTIVE
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
//        node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2
// Env:   PROBE_BASE            (default http://localhost:8134)
//        SANDCASTLE_SETTLE_MS  (default 8000)
//
// The --sandcastle2 mode is a SECOND, wider gate over the Sandcastle2 app and
// its whole gallery, with the backend pinned by URL. See the block at the foot
// of this file.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  errorGateInit,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import {
  EVALUATE_TIMEOUT,
  SWEEPABLE_RENDERERS,
  buildSandcastle2Url,
  enumerateGalleryIds,
  evaluateFrameGate,
  evaluateRendererGate,
  evaluateWithDeadline,
  isNoViewerId,
  readRendererStateInPage,
} from "./lib/sandcastle2-renderer-gate.mjs";

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

// ---------------------------------------------------------------------------
// Sandcastle2 backend sweep
//
// The three demos above are the standing blind-spot gate and they drive the
// LEGACY per-demo gallery pages. This mode drives the Sandcastle2 app itself,
// across every gallery id, with the backend pinned by URL — the mode that
// certifies the runner's own code transform rather than a hand-pinned demo.
//
// It adds ONE assertion the legacy gate does not have and cannot have: the live
// graphics context must report the renderer that was requested. A demo whose
// construction shape the runner fails to rewrite falls back to WebGL and
// renders a perfectly good picture; every pixel and error gate passes, and only
// this check fails.
//
// Usage:
//   node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2
//   node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgl
//   node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --ids=cesium-widget,hello-world
//   node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --standalone --limit=20
//   node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --dry-run
// ---------------------------------------------------------------------------

const GALLERY_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "sandcastle",
  "gallery",
);
const SWEEP_OUTPUT_DIR = path.join(__dirname, "output", "sandcastle2-sweep");
// Deadline for the one read that Playwright cannot bound on its own. Generous,
// because a cold tile/model load can legitimately keep the frame busy; the
// point is that the sweep always finishes, not that it finishes quickly.
const EVALUATE_TIMEOUT_MS =
  parseInt(process.env.SANDCASTLE2_EVAL_TIMEOUT_MS, 10) || 20000;

function parseSweepArgs(argv) {
  const options = {
    renderer: "webgpu",
    standalone: false,
    ids: null,
    limit: 0,
    captureAll: false,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--standalone") {
      options.standalone = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--capture-all") {
      options.captureAll = true;
    } else if (arg.startsWith("--renderer=")) {
      options.renderer = arg.slice("--renderer=".length);
    } else if (arg.startsWith("--ids=")) {
      options.ids = arg
        .slice("--ids=".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--limit=")) {
      options.limit = parseInt(arg.slice("--limit=".length), 10) || 0;
    }
  }
  return options;
}

// The bucket runs the demo in its own iframe, on its own origin. Everything the
// gate reads lives in THAT document, not in the app shell.
function findBucketFrame(page) {
  return (
    page.frames().find((f) => f.url().includes("templates/bucket.html")) ?? null
  );
}

// The deadline helper and its sentinel live in the gate library — it needs only
// a duck-typed `.evaluate()`, so keeping it there is what lets a unit test hand
// it a frame that never answers and prove the sweep still terminates.

async function runSweepDemo(browser, id, options) {
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
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${String(e?.message || e)}`),
  );

  await page.addInitScript(errorGateInit);

  const url = buildSandcastle2Url({
    base: BASE,
    id,
    renderer: options.renderer,
    standalone: options.standalone,
  });
  const pngPath = path.join(
    SWEEP_OUTPUT_DIR,
    `${options.renderer}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`,
  );
  // `timeline` and anything else on the no-viewer list is scored INVERTED, not
  // skipped: it must report no context and no frames, and still load clean.
  const expectNoViewer = isNoViewerId(id);
  const result = {
    id,
    url,
    outcome: "FAIL",
    ok: false,
    timedOut: false,
    expectNoViewer,
    rendererGate: null,
    frameGate: null,
    errors,
    suppressedCount: 0,
    pngPath: null,
  };

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Wait for the demo frame to exist at all. A run where the app never
    // mounts a bucket times out here and is reported as such, rather than
    // being scored against a canvas that was never created.
    await page.waitForFunction(
      () => document.querySelectorAll("iframe").length > 0,
      { timeout: NAV_TIMEOUT_MS },
    );
    await page.waitForTimeout(SETTLE_MS);

    const frame = findBucketFrame(page);
    if (!frame) {
      result.errors.push("probe: no bucket frame on the page");
    } else {
      const state = await evaluateWithDeadline(
        frame,
        readRendererStateInPage,
        EVALUATE_TIMEOUT_MS,
      );
      if (state === EVALUATE_TIMEOUT) {
        result.timedOut = true;
        result.errors.push(
          `probe: the demo frame did not answer within ${EVALUATE_TIMEOUT_MS}ms`,
        );
      } else {
        result.rendererGate = evaluateRendererGate({
          contexts: state.contexts,
          requested: options.renderer,
          expectNoViewer,
        });
        if (state.note) {
          result.rendererGate.reason = `${result.rendererGate.reason} (${state.note})`;
        }
        result.frameGate = evaluateFrameGate(state.frameNumbers, {
          expectNoViewer,
        });
      }

      if (options.captureAll || result.rendererGate?.ok === false) {
        // Capture on failure by default: a full-gallery pass would otherwise
        // write 338 screenshots for a run where nothing is wrong.
        const canvas = await frame.$("canvas");
        if (canvas) {
          const png = await canvas.screenshot({ type: "png" });
          await fs.writeFile(pngPath, png);
          result.pngPath = pngPath;
        }
      }
    }

    await page.waitForTimeout(200);
    const gate = await collectGateErrors(page);
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
    result.ok =
      result.errors.length === 0 &&
      result.rendererGate?.ok === true &&
      result.frameGate?.ok === true;
    // TIMEOUT is reported apart from FAIL: a wedged demo is an unfinished
    // measurement, not a verdict about which backend it ran.
    result.outcome = result.ok ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
  } catch (err) {
    result.errors.push(`probe: ${String(err?.message || err)}`);
    result.outcome = result.timedOut ? "TIMEOUT" : "FAIL";
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
  return result;
}

async function runSandcastle2Sweep(argv) {
  const options = parseSweepArgs(argv);
  if (!SWEEPABLE_RENDERERS.includes(options.renderer)) {
    console.log(
      `FAIL: --renderer=${options.renderer} is not sweepable (expected one of: ${SWEEPABLE_RENDERERS.join(", ")})`,
    );
    return 1;
  }

  let ids = options.ids ?? enumerateGalleryIds(GALLERY_DIR);
  if (options.limit > 0) {
    ids = ids.slice(0, options.limit);
  }

  if (options.dryRun) {
    // No browser: prove the id enumeration and the URLs before spending an hour
    // of GPU time on them.
    console.log(
      `sandcastle2 sweep DRY RUN: ${ids.length} demos, renderer=${options.renderer}, page=${options.standalone ? "standalone" : "index"}`,
    );
    for (const id of ids) {
      console.log(
        buildSandcastle2Url({
          base: BASE,
          id,
          renderer: options.renderer,
          standalone: options.standalone,
        }),
      );
    }
    return 0;
  }

  await fs.mkdir(SWEEP_OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });

  const failures = [];
  const timeouts = [];
  console.log(
    `sandcastle2 sweep: ${ids.length} demos, renderer=${options.renderer}, page=${options.standalone ? "standalone" : "index"}`,
  );
  for (let i = 0; i < ids.length; i++) {
    const r = await runSweepDemo(browser, ids[i], options);
    if (r.outcome === "TIMEOUT") {
      timeouts.push(r);
    } else if (!r.ok) {
      failures.push(r);
    }
    const rendererLine = r.rendererGate
      ? `${r.rendererGate.ok ? "OK" : "FAIL"} ${r.rendererGate.reason}`
      : "FAIL not read";
    const frameLine = r.frameGate
      ? `${r.frameGate.ok ? "OK" : "FAIL"} ${r.frameGate.reason}`
      : "FAIL not read";
    console.log(
      `[${r.outcome}] ${i + 1}/${ids.length} ${r.id}${r.expectNoViewer ? " (no-viewer, inverted)" : ""} — renderer: ${rendererLine} — frames: ${frameLine} — errors: ${r.errors.length}`,
    );
    for (const e of r.errors.slice(0, 4)) {
      console.log(`    ERR: ${e.slice(0, 240)}`);
    }
    if (r.pngPath) {
      console.log(`    capture: ${r.pngPath}`);
    }
  }

  await browser.close();
  const reportPath = path.join(
    SWEEP_OUTPUT_DIR,
    `report-${options.renderer}${options.standalone ? "-standalone" : ""}.json`,
  );
  const passed = ids.length - failures.length - timeouts.length;
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        renderer: options.renderer,
        total: ids.length,
        passed,
        failures,
        timeouts,
      },
      null,
      2,
    ),
  );
  const clean = failures.length === 0 && timeouts.length === 0;
  console.log(
    `\n${clean ? "PASS" : "FAIL"}: sandcastle2 sweep (${passed}/${ids.length} demos on ${options.renderer}, ${failures.length} failed, ${timeouts.length} timed out)`,
  );
  console.log(`report: ${reportPath}`);
  return clean ? 0 : 1;
}

const sweepArgv = process.argv.slice(2);
if (sweepArgv.includes("--sandcastle2")) {
  process.exit(await runSandcastle2Sweep(sweepArgv));
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
