#!/usr/bin/env node
/**
 * Sandcastle Batch 65 Test Runner
 *
 * Loads each `WebGPU *.html` Sandcastle demo in headless Edge with WebGPU
 * enabled, captures the canvas + console messages, and writes per-demo
 * screenshots + a JSON report.
 *
 * Usage:
 *   node Tools/visual-regression/sandcastle-batch-65-runner.mjs
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// We run inside the worktree but the dev server + the demo files being
// authored live in the main checkout. Resolve gallery from there so we
// pick up the parallel agent's work-in-progress.
const REPO_ROOT = process.env.CESIUM_REPO_ROOT || "F:/Dev/GH/cesium-webgpu";
const GALLERY_DIR = path.join(REPO_ROOT, "Apps", "Sandcastle", "gallery");
const SCREENSHOT_DIR = path.join(__dirname, "screenshots", "sandcastle-batch-65");
const REPORT_PATH = path.join(SCREENSHOT_DIR, "report.json");

const BASE_URL = "http://localhost:8080";
// Sandcastle uses `?src=<gallery-file>&label=showcases` style URLs.
function demoUrl(fileName) {
  return `${BASE_URL}/Apps/Sandcastle/index.html?src=${encodeURIComponent(fileName)}`;
}
// Demos are wrapped in an iframe (`bucket-requirejs.html`); the actual viewer
// page runs inside that iframe. Direct navigation to `gallery/<demo>.html`
// boots the demo standalone via `Sandcastle-header.js`.
function standaloneUrl(fileName) {
  return `${BASE_URL}/Apps/Sandcastle/gallery/${encodeURIComponent(fileName)}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function listDemos() {
  const entries = await fs.readdir(GALLERY_DIR);
  return entries.filter((e) => e.startsWith("WebGPU ") && e.endsWith(".html"));
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    console.error("[runner] Playwright is not installed:", err.message);
    process.exit(2);
  }
}

/**
 * Wait for the Cesium viewer to mount + render at least one frame.
 * Sandcastle exposes the viewer via `Sandcastle.declare` -> the `viewer`
 * variable inside the inline script becomes a window-scoped binding only
 * inside the iframe. Standalone gallery files do NOT expose `window.viewer`
 * automatically, so we hook into Cesium's `scene.postRender` instead.
 */
async function waitForRender(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      if (!c) return false;
      // Look for the Cesium widget container and its rendered canvas.
      const widget = document.querySelector(".cesium-widget canvas");
      if (!widget) return false;
      // Confirm canvas has non-zero size — the WebGPU surface needs a
      // valid backing texture before we sample pixels.
      return widget.width > 0 && widget.height > 0;
    },
    { timeout: timeoutMs },
  );
  // Allow a few additional frames for first-frame WebGPU setup
  // (pipeline compile, naga transpile, atmosphere LUT bake, etc.).
  await page.waitForTimeout(2500);
}

/**
 * Take a screenshot via Playwright (CDP-level capture, works regardless of
 * the canvas backend) clipped to the cesium-widget canvas. Reading the WebGPU
 * canvas through `OffscreenCanvas + drawImage + getImageData` returns zeros
 * on Chromium/Edge because the WebGPU surface is presented and cleared
 * before the JS read; Playwright's screenshot uses the compositor's
 * already-presented surface and is the source of truth.
 *
 * Returns the screenshot path + raw size on disk. Anything <2KB on a
 * 1280x720 canvas-clip is effectively a uniform-color blank image (PNG
 * compresses solid color to ~hundreds of bytes).
 */
async function captureCanvasAnalysis(page, baseName) {
  const screenshotPath = path.join(SCREENSHOT_DIR, `${baseName}.png`);
  const canvas = await page.$(".cesium-widget canvas");
  let captured = false;
  let size = 0;
  if (canvas) {
    try {
      await canvas.screenshot({ path: screenshotPath });
      captured = true;
    } catch (_) {
      /* fall through */
    }
  }
  if (!captured) {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }
  try {
    const stat = await fs.stat(screenshotPath);
    size = stat.size;
  } catch (_) {
    /* swallow */
  }
  return {
    screenshot: screenshotPath,
    pngBytes: size,
    likelyBlank: size < 4 * 1024,
  };
}

/**
 * Probe the live viewer for backend confirmation: is `rendererType` actually
 * 'webgpu', and how many imagery layers are present? This separates "demo
 * is broken" from "demo's webgpu backend wasn't selected".
 */
async function probeViewer(page) {
  return await page.evaluate(() => {
    const widget = document.querySelector(".cesium-widget");
    let v = window.viewer;
    // Sandcastle scopes `viewer` inside the inline script so it isn't
    // necessarily on window — try Cesium's ContextRegistry as fallback.
    if (!v && window.Cesium) {
      const reg = window.Cesium.ContextRegistry;
      if (reg && reg.all) {
        const ctxs = reg.all();
        if (ctxs && ctxs.length) {
          // No direct path from Context -> Viewer, but we can still report
          // backend type from the latest context.
          return {
            via: "ContextRegistry",
            rendererType: ctxs[ctxs.length - 1].rendererType,
            contextCount: ctxs.length,
          };
        }
      }
    }
    if (!v) return { via: "none", rendererType: null };
    return {
      via: "window.viewer",
      rendererType: v.scene?.context?.rendererType ?? null,
      imageryLayerCount: v.scene?.imageryLayers?.length ?? null,
      hasShadowMap: !!v.shadowMap,
    };
  });
}

/**
 * Click the canvas at its center to trigger Sandcastle pick handlers, then
 * read whatever the demo logged via console.log. Most pick demos log the
 * picked entity name immediately on click.
 */
async function clickCenterAndRead(page) {
  return await page.evaluate(async () => {
    const canvas = document.querySelector(".cesium-widget canvas");
    if (!canvas) return { error: "no canvas" };
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Synthesize a left-click at center. Cesium uses the `pointerdown` +
    // `pointerup` pair (via ScreenSpaceEventHandler).
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
      button: 0,
      pointerType: "mouse",
    };
    canvas.dispatchEvent(new PointerEvent("pointerdown", opts));
    canvas.dispatchEvent(new PointerEvent("pointerup", opts));
    canvas.dispatchEvent(new MouseEvent("click", opts));
    // Give the pick callback a frame
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    return { clickedAt: { x: cx, y: cy } };
  });
}

async function runDemo(browser, fileName) {
  const consoleErrors = [];
  const consoleWarnings = [];
  const consoleLogs = [];
  const pageErrors = [];

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === "error") consoleErrors.push(text);
    else if (type === "warning") consoleWarnings.push(text);
    else consoleLogs.push(`[${type}] ${text}`);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const url = standaloneUrl(fileName);
  const result = {
    file: fileName,
    url,
    status: "PASS",
    errors: consoleErrors,
    warnings: consoleWarnings,
    pageErrors,
    notes: [],
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForRender(page, 30000);
    const baseName = fileName.replace(/\.html$/, "");
    const cap = await captureCanvasAnalysis(page, baseName);
    const sample = cap;
    result.sample = sample;
    result.screenshot = cap.screenshot;
    const probe = await probeViewer(page);
    result.viewer = probe;

    if (sample.likelyBlank) {
      result.status = "FAIL";
      result.notes.push(
        `canvas screenshot is ${sample.pngBytes}B — likely a blank/solid frame`,
      );
    }
    if (probe.rendererType && probe.rendererType !== "webgpu") {
      result.notes.push(
        `viewer is using ${probe.rendererType} backend (expected webgpu)`,
      );
    }

    // Demo-specific extras
    if (/Pick/.test(fileName)) {
      const pick = await clickCenterAndRead(page);
      result.pick = pick;
      // Capture post-click screenshot to verify highlight or selection
      const pickShot = path.join(SCREENSHOT_DIR, `${baseName}-after-click.png`);
      await page.screenshot({ path: pickShot, fullPage: false });
      result.pickScreenshot = pickShot;
    }

    if (/Point Light Shadows/.test(fileName)) {
      // Toggle softShadows + capture again
      try {
        await page.evaluate(() => {
          // Sandcastle's standalone bucket leaks `viewer` to window when
          // declared with `var` or `const` at the top of the inline script.
          // If the demo authors used `let`, fall back to scanning Cesium's
          // ContextRegistry for the active viewer.
          const v =
            window.viewer ||
            (window.Cesium &&
              Array.from(document.querySelectorAll(".cesium-widget"))
                .map((el) => el._cesiumViewer)
                .find(Boolean));
          if (v && v.shadowMap) {
            v.shadowMap.softShadows = true;
          }
        });
        await page.waitForTimeout(1500);
        const shotSoft = path.join(SCREENSHOT_DIR, `${baseName}-soft.png`);
        await page.screenshot({ path: shotSoft, fullPage: false });
        result.softShadowsScreenshot = shotSoft;
      } catch (e) {
        result.notes.push(`softShadows toggle failed: ${e.message}`);
      }
    }

    if (/Many Imagery Layers/.test(fileName)) {
      try {
        const layerCount = await page.evaluate(() => {
          const v =
            window.viewer ||
            (window.Cesium &&
              Array.from(document.querySelectorAll(".cesium-widget"))
                .map((el) => el._cesiumViewer)
                .find(Boolean));
          return v?.scene?.imageryLayers?.length ?? -1;
        });
        result.imageryLayerCount = layerCount;
        if (layerCount < 8) {
          result.notes.push(
            `imagery layer count = ${layerCount}, expected >=8`,
          );
        }
      } catch (e) {
        result.notes.push(`layer-count probe failed: ${e.message}`);
      }
    }

    if (consoleErrors.length > 0) {
      // Filter out noise: 404s for tilesets we don't have, etc. — keep
      // anything that looks like a WebGPU validation error or shader fail.
      const realErrors = consoleErrors.filter(
        (e) =>
          /WebGPU/i.test(e) ||
          /shader/i.test(e) ||
          /pipeline/i.test(e) ||
          /validation/i.test(e) ||
          /WGSL/i.test(e) ||
          /Cannot read/i.test(e) ||
          /undefined/i.test(e),
      );
      if (realErrors.length > 0) {
        result.status = "FAIL";
        result.notes.push(
          `${realErrors.length} significant console errors (see errors[])`,
        );
      }
    }
    if (pageErrors.length > 0) {
      result.status = "FAIL";
      result.notes.push(`${pageErrors.length} uncaught page errors`);
    }
  } catch (err) {
    result.status = "FAIL";
    result.notes.push(`runner exception: ${err.message}`);
    try {
      const baseName = fileName.replace(/\.html$/, "");
      const screenshotPath = path.join(
        SCREENSHOT_DIR,
        `${baseName}-error.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: false });
      result.screenshot = screenshotPath;
    } catch (_) {
      /* swallow */
    }
  } finally {
    await ctx.close();
  }
  return result;
}

async function main() {
  await ensureDir(SCREENSHOT_DIR);
  const demos = await listDemos();
  console.log(`[runner] found ${demos.length} WebGPU demo(s):`);
  demos.forEach((d) => console.log(`   - ${d}`));
  if (demos.length === 0) {
    console.error("[runner] no demos to test — exiting");
    process.exit(0);
  }

  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: true,
    channel: "msedge",
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });

  const results = [];
  for (const demo of demos) {
    console.log(`[runner] testing: ${demo}`);
    const r = await runDemo(browser, demo);
    console.log(`  status: ${r.status}`);
    if (r.notes.length) {
      r.notes.forEach((n) => console.log(`    note: ${n}`));
    }
    if (r.errors.length) {
      console.log(`    ${r.errors.length} console errors`);
    }
    results.push(r);
  }

  await browser.close();

  const summary = {
    runAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    skipped: results.filter((r) => r.status === "SKIP").length,
    results,
  };
  await fs.writeFile(REPORT_PATH, JSON.stringify(summary, null, 2));
  console.log(`[runner] wrote ${REPORT_PATH}`);
  console.log(
    `[runner] PASS=${summary.passed}  FAIL=${summary.failed}  SKIP=${summary.skipped}`,
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
