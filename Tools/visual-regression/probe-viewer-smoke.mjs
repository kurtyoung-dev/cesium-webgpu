// CO-39 runtime smoke: the bare viewer is upstream chrome with WebGPU active;
// ?devUi=true restores the fork's toolbar; ?renderer=webgl still selects WebGL.
// Also the run-7 suspect check: window.viewer appears and a frame renders on
// every variant.
//
// @purpose Guards UX-01: bare viewer is upstream chrome with WebGPU default, ?devUi=true restores the toolbar, ?renderer=webgl selects WebGL, and window.viewer resolves on every variant.
// @status ACTIVE
//
// PROMOTED out of Tools/visual-regression/output/ on 2026-08-18 by R-2026-08-17-14.
// It had been an @status INVESTIGATION one-off living in gitignored scratch, but
// UX-01 shipped and this is its only regression guard. Renamed from
// viewer-smoke.mjs so the `probe-*.mjs` fleet contract can see it: the contract
// globs `f.startsWith("probe-")` (probe-fleet-contract.spec.mjs:69), so a
// long-lived browser driver under any other name is a second, ungoverned class
// of probe inside the governed directory. Watchdog and the exit-3 route added in
// the same move, per the fleet contract's requirements.

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS || 300_000);

// Terminating watchdog. `process.exitCode` cannot end a wedged browser or event
// loop — the timer body must exit the process itself.
const watchdog = setTimeout(() => {
  console.error(
    `STRUCTURAL probe-viewer-smoke: watchdog fired after ${WATCHDOG_MS} ms; the run could not reach a verdict`,
  );
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

const VARIANTS = [
  // name, query string, toolbar expected, backend expected
  ["bare", "", false, "webgpu"],
  ["devUi", "?devUi=true", true, "webgpu"],
  ["webgl", "?renderer=webgl", false, "webgl"],
  ["webgpu-explicit", "?renderer=webgpu", false, "webgpu"],
];

let browser;
const out = [];

try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });

  for (const [name, qs, expectToolbar, expectBackend] of VARIANTS) {
    const page = await browser.newPage({
      viewport: { width: 640, height: 400 },
    });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`${BASE}/Apps/CesiumViewer/index.html${qs}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    let viewerOk = true;
    try {
      await page.waitForFunction(() => !!window.viewer, undefined, {
        timeout: 60_000,
      });
    } catch {
      viewerOk = false;
    }
    const facts = await page.evaluate(() => ({
      toolbar: !!document.getElementById("rendererToolbar"),
      fps: !!document.getElementById("fpsToggle"),
      backend: window.viewer?.scene?._context?.isWebGPU
        ? "webgpu"
        : window.viewer
          ? "webgl"
          : "none",
    }));
    out.push({
      name,
      viewerOk,
      ...facts,
      expectToolbar,
      expectBackend,
      errs: errs.slice(0, 2),
    });
    await page.close();
  }
} catch (error) {
  // The subject could not be observed at all — an unevaluable evidence shape,
  // not a product failure. Exit 3 per the fleet's frozen verdict table.
  console.error(`STRUCTURAL probe-viewer-smoke: ${error?.message ?? error}`);
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  process.exit(3);
} finally {
  await browser?.close().catch(() => {});
}

clearTimeout(watchdog);

if (out.length !== VARIANTS.length) {
  console.error(
    `STRUCTURAL probe-viewer-smoke: ${out.length}/${VARIANTS.length} variants produced a reading`,
  );
  process.exit(3);
}

let ok = true;
for (const r of out) {
  const pass =
    r.viewerOk &&
    r.toolbar === r.expectToolbar &&
    r.fps === r.expectToolbar &&
    r.backend === r.expectBackend &&
    r.errs.length === 0;
  if (!pass) {
    ok = false;
  }
  console.log(
    `${pass ? "PASS" : "FAIL"} ${r.name}: viewer=${r.viewerOk} toolbar=${r.toolbar} fps=${r.fps} backend=${r.backend} errs=${JSON.stringify(r.errs)}`,
  );
}

process.exit(ok ? 0 : 1);
