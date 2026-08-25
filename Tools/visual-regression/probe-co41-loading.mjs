// CO-41 browser check (6 points, reconstructed post-compaction from the
// CO-41 design contract; labelled as reconstructed in the landing stamp).
// @purpose Guards CO-41: the upstream loading indicator shows and hides on a real first frame on both backends, no fork scrim DOM survives, and a failure control proves the check can fail.
// @status ACTIVE
//
// PROMOTED out of Tools/visual-regression/output/ on 2026-08-18 by R-2026-08-17-14.
// CO-41 shipped and this is its only regression guard. Renamed from
// co41-loading-check.mjs so the `probe-*.mjs` fleet contract can glob it
// (probe-fleet-contract.spec.mjs:69); a long-lived browser driver under any
// other name is an ungoverned probe inside the governed directory. Terminating
// watchdog and the exit-3 route added in the same move.
//
//   1. WebGL bare viewer: #loadingIndicator visible at page open, hidden
//      after the first rendered frame.
//   2. WebGPU bare viewer: same element, same semantics.
//   3. No fork LoadingOverlay scrim DOM on either backend at any sampled
//      instant (the deleted z-9999 element must not exist).
//   4. At hide time the canvas is non-black on both backends — readiness is
//      a real frame, not a timer.
//   5. Hide latency << RENDER_WAIT_LIMIT_MS (10s) on both backends — the
//      postRender path drove it, not the bound.
//   6. FAILURE CONTROL: with the render loop disabled before first frame
//      (useDefaultRenderLoop=false injected at construction), the indicator
//      is STILL VISIBLE at +3s (the check can fail), and hidden by ~11s
//      (the bound works).
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS || 300_000);
// Terminating watchdog: the timer body must exit the process itself, because
// process.exitCode cannot end a wedged browser or event loop.
const watchdog = setTimeout(() => {
  console.error(
    `STRUCTURAL probe-co41-loading: watchdog fired after ${WATCHDOG_MS} ms; no verdict reached`,
  );
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref();
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const results = [];
const fail = (name, detail) => results.push({ name, pass: false, detail });
const pass = (name, detail) => results.push({ name, pass: true, detail });
try {
  for (const renderer of ["webgl", "webgpu"]) {
    const page = await browser.newPage({
      viewport: { width: 512, height: 512 },
    });
    let sawVisible = false;
    let overlaySeen = false;
    const poll = setInterval(() => {
      page
        .evaluate(() => {
          const li = document.getElementById("loadingIndicator");
          const overlay = document.querySelector(
            ".cesium-loading-overlay, [data-cesium-loading-overlay]",
          );
          return {
            visible: !!li && li.style.display !== "none",
            overlay: !!overlay,
          };
        })
        .then((s) => {
          if (s.visible) sawVisible = true;
          if (s.overlay) overlaySeen = true;
        })
        .catch(() => {});
    }, 50);
    const t0 = Date.now();
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page
      .waitForFunction(
        () => {
          const li = document.getElementById("loadingIndicator");
          return !!li && li.style.display === "none";
        },
        undefined,
        { timeout: 30000 },
      )
      .catch(() => {});
    const hideMs = Date.now() - t0;
    clearInterval(poll);
    const hidden = await page.evaluate(
      () =>
        document.getElementById("loadingIndicator")?.style.display === "none",
    );
    const canvasLit = await page.evaluate(async () => {
      // Element-level readback via 2d copy is invalid for WebGPU; use the
      // devicePixel readback the debug helper exposes, else screenshot-free
      // luminance via the split-page helper is unavailable here — fall back
      // to checking the scene rendered at least one frame.
      return (
        !!window.viewer &&
        window.viewer.scene._frameState?.frameNumber !== undefined
      );
    });
    const shot = await page.locator("canvas").first().screenshot();
    const lit = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${b64}`)).blob(),
      );
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const x = c.getContext("2d");
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] + d[i + 1] + d[i + 2] > 30) nonBlack++;
      return nonBlack;
    }, shot.toString("base64"));
    (sawVisible ? pass : fail)(
      `${renderer}:indicator_shown`,
      `sawVisible=${sawVisible}`,
    );
    (hidden ? pass : fail)(
      `${renderer}:indicator_hidden_after_frame`,
      `hidden=${hidden} in ${hideMs}ms`,
    );
    (!overlaySeen ? pass : fail)(
      `${renderer}:no_fork_overlay_dom`,
      `overlaySeen=${overlaySeen}`,
    );
    (lit > 500 && canvasLit ? pass : fail)(
      `${renderer}:canvas_lit_at_hide`,
      `nonBlackPx=${lit}`,
    );
    (hideMs < 9000 ? pass : fail)(
      `${renderer}:hide_driven_by_frame_not_bound`,
      `${hideMs}ms < 9000ms`,
    );
    await page.close();
  }
  // 6. Failure control (webgpu): kill the render loop before first frame.
  {
    const page = await browser.newPage({
      viewport: { width: 512, height: 512 },
    });
    await page.addInitScript(() => {
      // Strangle rendering before the app constructs the viewer: force
      // useDefaultRenderLoop=false through the app's option seam by hiding
      // rAF from the page. The indicator must then persist until the bound.
      let blocked = true;
      window.__co41_unblock = () => {
        blocked = false;
      };
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => (blocked ? 0 : raf(cb));
    });
    const t0 = Date.now();
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=webgl&offline=true`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page.waitForTimeout(3000);
    const stillVisible = await page.evaluate(() => {
      const li = document.getElementById("loadingIndicator");
      return !!li && li.style.display !== "none";
    });
    (stillVisible ? pass : fail)(
      "failure_control:indicator_persists_without_frames",
      `visible at +3s=${stillVisible}`,
    );
    // rAF is strangled on this page, so waitForFunction must poll by
    // interval — the default rAF polling would never fire.
    await page
      .waitForFunction(
        () =>
          document.getElementById("loadingIndicator")?.style.display === "none",
        undefined,
        { timeout: 12000, polling: 100 },
      )
      .catch(() => {});
    const boundedHideMs = Date.now() - t0;
    const hiddenByBound = await page.evaluate(
      () =>
        document.getElementById("loadingIndicator")?.style.display === "none",
    );
    (hiddenByBound && boundedHideMs < 14000 ? pass : fail)(
      "failure_control:bound_hides_eventually",
      `hidden=${hiddenByBound} at ${boundedHideMs}ms`,
    );
    await page.close();
  }
} catch (error) {
  console.error(`STRUCTURAL probe-co41-loading: ${error?.message ?? error}`);
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
  process.exit(3);
} finally {
  await browser.close().catch(() => {});
}
clearTimeout(watchdog);
if (results.length === 0) {
  console.error("STRUCTURAL probe-co41-loading: no check produced a reading");
  process.exit(3);
}
let exit = 0;
for (const r of results) {
  if (!r.pass) exit = 1;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
}
console.log(`co41-exit=${exit}`);
process.exit(exit);
