#!/usr/bin/env node
/**
 * Translucent Classification debug harness.
 *
 * Loads the `WebGPU Translucent Classification.html` Sandcastle demo in
 * Edge with WebGPU enabled, captures every console message, prints
 * filtered output grouped by source so the operator can correlate the
 * GPU validation error scope at `[WebGPU:GlobePass]` against the
 * surrounding lifecycle (texture creation, copy invocation, frame
 * render). Useful for debugging this demo specifically; the canonical
 * baseline harness is `sandcastle-batch-66-final-runner.mjs`.
 *
 * Forensic notes from the run that surfaced the
 * `SceneFramebuffer-Color_depth` `COPY_SRC` bug:
 *
 * 1. The default `npm run start` server's chokidar watcher historically
 *    matched only `.js` source files, which meant TypeScript edits
 *    silently failed to invalidate the in-memory esbuild bundle. The
 *    Sandcastle runner would consequently keep loading a stale bundle
 *    even after a successful `npx gulp build`. After fixing this
 *    server.js bug, restarting the dev server is no longer a debugging
 *    requirement, but you may still need to restart it once after
 *    pulling a branch that landed in pre-fix territory.
 * 2. The error scope at `_executeGlobePass` catches GPU validation
 *    asynchronously after the frame ends, so the error string in the
 *    runner's report is whatever validation tripped first that frame —
 *    not necessarily the issue you most recently changed code to
 *    address. When chasing a "the fix is in but the error doesn't
 *    change" symptom, run THIS harness and look at the actual live
 *    error string.
 *
 * Usage:
 *   node Tools/visual-regression/translucent-classification-debug.mjs
 *
 * Requires the dev server running at `http://localhost:8080`.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const URL = `${BASE}/Apps/Sandcastle/gallery/${encodeURIComponent("WebGPU Translucent Classification.html")}`;

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
      "--disable-application-cache",
      "--disk-cache-size=0",
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    bypassCSP: true,
  });
  const page = await ctx.newPage();

  /** [t, type, text] */
  const events = [];
  const start = performance.now();

  page.on("console", (msg) => {
    events.push([performance.now() - start, msg.type(), msg.text()]);
  });
  page.on("pageerror", (e) => {
    events.push([performance.now() - start, "PAGEERROR", e.message]);
  });
  page.on("response", async (resp) => {
    const u = resp.url();
    if (u.endsWith("/Cesium.js") || u.endsWith("/index.js")) {
      events.push([
        performance.now() - start,
        "RESPONSE",
        `${resp.status()} ${u}`,
      ]);
    }
  });

  // Cache-bust every request so a stale Cesium.js bundle can't mask
  // unbuilt source changes.
  await ctx.route("**/*", async (route) => {
    const headers = { ...route.request().headers() };
    headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    headers["Pragma"] = "no-cache";
    await route.continue({ headers });
  });

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(8000);

  console.log(`Total events: ${events.length}`);
  console.log("");

  for (const [t, type, text] of events) {
    if (
      type === "RESPONSE" ||
      text.includes("VALIDATION") ||
      text.includes("CopySrc") ||
      text.includes("aspect") ||
      text.includes("TranslucentTileClass")
    ) {
      console.log(
        `[t=${Math.round(t)}ms ${type.toUpperCase()}] ${text.substring(0, 400)}`,
      );
    }
  }

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
