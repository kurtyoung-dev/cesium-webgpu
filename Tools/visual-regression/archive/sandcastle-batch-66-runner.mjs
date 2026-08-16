#!/usr/bin/env node
/**
 * Sandcastle Batch 66 Test Runner — re-run of Batch 65 after F1/F3 fixes.
 * @purpose Batch-66 rerun of the Batch-65 Sandcastle sweep adding the rendering-error hard-FAIL marker and the viewer-capture init shim.
 * @status INVESTIGATION
 *
 * Improvements over the Batch 65 runner:
 *   1. Treat any console message containing "An error occurred while rendering"
 *      as a hard FAIL regardless of PNG size. Batch 65's heuristic
 *      mis-classified Point Light Shadows as PASS when the rendering-stopped
 *      modal compresses small (~42KB).
 *   2. Use `addInitScript` to install a tiny shim that captures the inline
 *      `viewer` binding from the standalone Sandcastle wrapper (which uses
 *      `var viewer = ...`) onto `window.__capturedViewer`, so probes can read
 *      `rendererType` and `imageryLayers.length` reliably even when the demo
 *      file uses `let viewer` (which would NOT leak to window).
 *
 * Loads each `WebGPU *.html` Sandcastle demo in headless Edge with WebGPU
 * enabled, captures the canvas + console messages, and writes per-demo
 * screenshots + a JSON report.
 *
 * Usage:
 *   node Tools/visual-regression/sandcastle-batch-66-runner.mjs
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CESIUM_REPO_ROOT || "F:/Dev/GH/cesium-webgpu";
const GALLERY_DIR = path.join(REPO_ROOT, "Apps", "Sandcastle", "gallery");
const SCREENSHOT_DIR = path.join(
  __dirname,
  "screenshots",
  "sandcastle-batch-66",
);
const REPORT_PATH = path.join(SCREENSHOT_DIR, "report.json");

const BASE_URL = "http://localhost:8080";

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

async function waitForRender(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      const widget = document.querySelector(".cesium-widget canvas");
      if (!widget) return false;
      return widget.width > 0 && widget.height > 0;
    },
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(2500);
}

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
 * Probe the live viewer for backend confirmation. Tries multiple paths:
 *   - window.viewer (works when the demo uses `var viewer = ...`)
 *   - window.__capturedViewer (set by our injected shim)
 *   - Cesium.ContextRegistry.all() (gives us at least rendererType)
 *   - Walk DOM for a `.cesium-widget` element with `_cesiumWidget`
 */
async function probeViewer(page) {
  return await page.evaluate(() => {
    const v = window.viewer || window.__capturedViewer;
    if (v && v.scene) {
      return {
        via: window.viewer ? "window.viewer" : "window.__capturedViewer",
        rendererType: v.scene.context?.rendererType ?? null,
        imageryLayerCount: v.scene.imageryLayers?.length ?? null,
        hasShadowMap: !!v.shadowMap,
      };
    }
    if (window.Cesium) {
      const reg = window.Cesium.ContextRegistry;
      if (reg && typeof reg.all === "function") {
        const ctxs = reg.all();
        if (ctxs && ctxs.length) {
          const last = ctxs[ctxs.length - 1];
          return {
            via: "ContextRegistry",
            rendererType: last.rendererType,
            contextCount: ctxs.length,
          };
        }
      }
    }
    return { via: "none", rendererType: null };
  });
}

async function clickCenterAndRead(page) {
  return await page.evaluate(async () => {
    const canvas = document.querySelector(".cesium-widget canvas");
    if (!canvas) return { error: "no canvas" };
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
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
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    return { clickedAt: { x: cx, y: cy } };
  });
}

/** "An error occurred while rendering" is the Cesium fatal-error modal text;
 *  it always indicates a hard render-loop crash. */
const RENDERING_STOPPED_MARKER = /An error occurred while rendering/;

function isSignificantConsoleError(text) {
  if (RENDERING_STOPPED_MARKER.test(text)) return true;
  return (
    /WebGPU/i.test(text) ||
    /shader/i.test(text) ||
    /pipeline/i.test(text) ||
    /validation/i.test(text) ||
    /WGSL/i.test(text) ||
    /Cannot read/i.test(text) ||
    /TypeError/i.test(text) ||
    /Class constructor/i.test(text) ||
    /undefined/i.test(text)
  );
}

async function runDemo(browser, fileName) {
  const consoleErrors = [];
  const consoleWarnings = [];
  const consoleLogs = [];
  const pageErrors = [];

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Capture the inline `viewer` from Sandcastle's standalone wrapper before
  // page scripts run. The wrapper does `var viewer = new Cesium.Viewer(...)`
  // at module/script scope which DOES leak to window in non-strict scripts —
  // but some demos use `let viewer` which doesn't. This shim watches
  // `window.viewer` and mirrors it into `__capturedViewer`. Also wraps
  // Cesium.Viewer to capture instances directly.
  await ctx.addInitScript(() => {
    let captured = null;
    Object.defineProperty(window, "__capturedViewer", {
      get() {
        return captured;
      },
      configurable: true,
    });
    // Watch for window.viewer being set
    let _v;
    Object.defineProperty(window, "viewer", {
      configurable: true,
      get() {
        return _v;
      },
      set(value) {
        _v = value;
        if (value && value.scene) captured = value;
      },
    });
    // Also wrap Cesium.Viewer constructor when Cesium loads
    const checkInterval = setInterval(() => {
      if (
        window.Cesium &&
        window.Cesium.Viewer &&
        !window.Cesium.__viewerWrapped
      ) {
        const Original = window.Cesium.Viewer;
        function WrappedViewer(...args) {
          const inst = new Original(...args);
          if (!captured) captured = inst;
          return inst;
        }
        WrappedViewer.prototype = Original.prototype;
        Object.setPrototypeOf(WrappedViewer, Original);
        try {
          window.Cesium.Viewer = WrappedViewer;
          window.Cesium.__viewerWrapped = true;
        } catch (_) {
          /* readonly Cesium namespace - ignore */
        }
        clearInterval(checkInterval);
      }
    }, 50);
    setTimeout(() => clearInterval(checkInterval), 15000);
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
    result.sample = cap;
    result.screenshot = cap.screenshot;
    const probe = await probeViewer(page);
    result.viewer = probe;

    if (cap.likelyBlank) {
      result.status = "FAIL";
      result.notes.push(
        `canvas screenshot is ${cap.pngBytes}B — likely a blank/solid frame`,
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
      const pickShot = path.join(SCREENSHOT_DIR, `${baseName}-after-click.png`);
      await page.screenshot({ path: pickShot, fullPage: false });
      result.pickScreenshot = pickShot;
    }

    if (/Point Light Shadows/.test(fileName)) {
      try {
        await page.evaluate(() => {
          const v = window.viewer || window.__capturedViewer;
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
          const v = window.viewer || window.__capturedViewer;
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

    // Hard-fail on any rendering-stopped marker
    const renderingStopped = consoleErrors.filter((e) =>
      RENDERING_STOPPED_MARKER.test(e),
    );
    if (renderingStopped.length > 0) {
      result.status = "FAIL";
      result.notes.push(
        `${renderingStopped.length} "An error occurred while rendering" event(s) — render loop crashed`,
      );
    }

    if (consoleErrors.length > 0) {
      const realErrors = consoleErrors.filter(isSignificantConsoleError);
      if (realErrors.length > 0 && result.status !== "FAIL") {
        result.status = "FAIL";
        result.notes.push(
          `${realErrors.length} significant console errors (see errors[])`,
        );
      } else if (realErrors.length > 0) {
        // Already FAIL — still note error count
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
      const screenshotPath = path.join(SCREENSHOT_DIR, `${baseName}-error.png`);
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
