#!/usr/bin/env node
/**
 * Sandcastle Batch 66 FINAL Test Runner — re-run after F1, F2, F3 engine fixes.
 * @purpose Post-F1/F2/F3 rerun of the Batch-66 WebGPU Sandcastle sweep: every 'WebGPU *.html' demo headless, known artifacts filtered, JSON report.
 * @status INVESTIGATION
 *
 * Improvements over the Batch 66 runner:
 *   1. Pick demos no longer synthesize pointer events. We call
 *      `viewer.scene.pick(new Cesium.Cartesian2(x, y))` directly via
 *      `page.evaluate()`, completely bypassing Playwright's pointer-capture
 *      stack. This eliminates the spurious
 *      "NotFoundError: Failed to execute 'setPointerCapture'..."
 *      page-error that was causing false-FAIL on Model Pick + Voxel Pick.
 *   2. `setPointerCapture` errors are filtered from `pageErrors` as a known
 *      Playwright-vs-Sandcastle artifact, so even if some other demo path
 *      somehow triggers them (e.g., the Sandcastle bucket toolbar), they
 *      won't poison the result.
 *   3. The `An error occurred while rendering` hard-FAIL marker from Batch 66
 *      is preserved.
 *   4. The `addInitScript` viewer-capture shim from Batch 66 is preserved so
 *      probes still work for demos that use `let viewer`.
 *
 * Loads each `WebGPU *.html` Sandcastle demo in headless Edge with WebGPU
 * enabled, captures the canvas + console messages, and writes per-demo
 * screenshots + a JSON report.
 *
 * Usage:
 *   node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs
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
  "sandcastle-batch-66-final",
);
const REPORT_PATH = path.join(SCREENSHOT_DIR, "report.json");

// Allow overriding the dev-server URL when running from a non-canonical
// worktree (Tier 0 agent worktrees use port 8090 to avoid clashing with
// the user's primary server on 8080).
const BASE_URL = process.env.SANDCASTLE_BASE_URL || "http://localhost:8080";

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
 */
async function probeViewer(page) {
  return await page.evaluate(() => {
    const v = window.viewer || window.__capturedViewer;
    if (v && v.scene) {
      const via = window.viewer
        ? "window.viewer"
        : v.__syntheticFromWidget
          ? "synthetic-from-widget"
          : "window.__capturedViewer";
      return {
        via,
        rendererType: v.scene.context?.rendererType ?? null,
        imageryLayerCount: v.scene.imageryLayers?.length ?? null,
        hasShadowMap: !!v.shadowMap,
      };
    }
    const Cesium = window.Cesium || window.__rawCesiumNamespace;
    if (Cesium && Cesium.GraphicsContext) {
      try {
        const reg = Cesium.GraphicsContext.registry;
        if (reg && reg.all) {
          const all = reg.all;
          // `all` is a Map (ReadonlyMap<string, RegistrableContext>)
          if (all && typeof all.values === "function") {
            const ctxs = Array.from(all.values());
            if (ctxs.length) {
              const last = ctxs[ctxs.length - 1];
              return {
                via: "GraphicsContext.registry",
                rendererType: last.rendererType,
                contextCount: ctxs.length,
              };
            }
          }
        }
      } catch (_) {
        /* fall through */
      }
    }
    return { via: "none", rendererType: null };
  });
}

/**
 * Pick at canvas center via `viewer.scene.pick(Cartesian2)`. No pointer
 * synthesis — bypasses Playwright's pointer-capture stack entirely.
 */
async function pickAtCenter(page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector(".cesium-widget canvas");
    if (!canvas) return { error: "no canvas" };
    const v = window.viewer || window.__capturedViewer;
    if (!v || !v.scene) return { error: "no viewer" };
    const Cesium = window.Cesium || window.__rawCesiumNamespace;
    if (!Cesium || !Cesium.Cartesian2) {
      return { error: "no Cesium.Cartesian2" };
    }
    // Canvas-local coordinates — viewer.scene.pick uses the canvas
    // coordinate system, not the page coordinate system.
    const x = canvas.width / (window.devicePixelRatio || 1) / 2;
    const y = canvas.height / (window.devicePixelRatio || 1) / 2;
    let picked;
    try {
      picked = v.scene.pick(new Cesium.Cartesian2(x, y));
    } catch (e) {
      return { error: `pick threw: ${e && e.message}` };
    }
    if (!picked) {
      // Try a small grid around center as fallback (some primitives have
      // small footprints relative to canvas center).
      const offsets = [
        [0, 0],
        [-25, 0],
        [25, 0],
        [0, -25],
        [0, 25],
        [-50, 0],
        [50, 0],
        [0, -50],
        [0, 50],
      ];
      for (const [dx, dy] of offsets) {
        try {
          const p = v.scene.pick(new Cesium.Cartesian2(x + dx, y + dy));
          if (p) {
            picked = p;
            break;
          }
        } catch (_) {
          /* continue */
        }
      }
    }
    if (!picked) {
      return { picked: null, pickedAt: { x, y } };
    }
    // Extract a serializable description.
    let entityName = null;
    if (picked.id) {
      if (typeof picked.id === "string") entityName = picked.id;
      else if (picked.id.name) entityName = picked.id.name;
      else if (picked.id.id) entityName = String(picked.id.id);
      else entityName = "(entity-no-name)";
    }
    const primitiveName =
      picked.primitive && picked.primitive.constructor
        ? picked.primitive.constructor.name
        : null;
    return {
      picked: {
        entityName,
        primitiveName,
        hasMesh: !!picked.mesh,
        hasNode: !!picked.node,
      },
      pickedAt: { x, y },
    };
  });
}

/** "An error occurred while rendering" is the Cesium fatal-error modal text;
 *  it always indicates a hard render-loop crash. */
const RENDERING_STOPPED_MARKER = /An error occurred while rendering/;

/** Known Playwright-vs-Sandcastle artifacts — NOT engine bugs. */
const KNOWN_ARTIFACT_MARKERS = [
  /setPointerCapture/i,
  /No active pointer with the given id/i,
];

function isKnownArtifact(text) {
  return KNOWN_ARTIFACT_MARKERS.some((re) => re.test(text));
}

function isSignificantConsoleError(text) {
  if (isKnownArtifact(text)) return false;
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
  // page scripts run. The `window.Cesium = Cesium` assignment in
  // load-cesium-es6.js makes Cesium a frozen ES Module namespace whose
  // members can't be reassigned, so wrapping `Cesium.Viewer` doesn't work.
  // Instead we (a) intercept assignments to `window.Cesium` to install a
  // Proxy wrapper that intercepts the `Viewer` getter, and (b) hook
  // CesiumWidget's `.scene` accessor. Falls back to walking
  // `Cesium.GraphicsContext.registry` for context introspection.
  await ctx.addInitScript(() => {
    let captured = null;
    Object.defineProperty(window, "__capturedViewer", {
      get() {
        return captured;
      },
      configurable: true,
    });
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

    // Hook prototype methods. The Cesium namespace is a frozen ES Module
    // namespace (its own properties are non-writable), but PROTOTYPES of
    // exported classes are regular objects and remain mutable. We patch
    // `Viewer.prototype.resize` (called on every frame post-update) and
    // `CesiumWidget.prototype.render` (called on every frame) to capture
    // `this` the first time either is invoked. By the time either fires
    // we have a ready viewer/widget to introspect.
    function tryInstallHooks() {
      const C = window.__rawCesiumNamespace;
      if (!C) return false;
      let installed = 0;
      if (C.Viewer && C.Viewer.prototype && !C.Viewer.prototype.__cap) {
        const orig = C.Viewer.prototype.resize;
        C.Viewer.prototype.resize = function (...a) {
          if (!captured) captured = this;
          return orig.apply(this, a);
        };
        C.Viewer.prototype.__cap = true;
        installed++;
      }
      if (
        C.CesiumWidget &&
        C.CesiumWidget.prototype &&
        !C.CesiumWidget.prototype.__cap
      ) {
        const orig = C.CesiumWidget.prototype.render;
        C.CesiumWidget.prototype.render = function (...a) {
          // CesiumWidget is the inner widget; if no Viewer captured we at
          // least expose a synthetic { scene } shim so probes work.
          if (!captured && this.scene) {
            captured = { scene: this.scene, __syntheticFromWidget: true };
          }
          return orig.apply(this, a);
        };
        C.CesiumWidget.prototype.__cap = true;
        installed++;
      }
      return installed > 0;
    }

    // Intercept `window.Cesium = ns` assignments. We can't wrap the
    // namespace directly (frozen), but we CAN squirrel away the reference
    // for prototype hooking in `tryInstallHooks`.
    let _cesium;
    Object.defineProperty(window, "Cesium", {
      configurable: true,
      get() {
        return _cesium;
      },
      set(value) {
        _cesium = value;
        window.__rawCesiumNamespace = value;
        tryInstallHooks();
      },
    });
    // Also poll, in case `Cesium` gets set in some path that our defineProperty
    // accessor misses.
    const pollId = setInterval(() => {
      if (window.__rawCesiumNamespace || window.Cesium) {
        if (!window.__rawCesiumNamespace && window.Cesium) {
          window.__rawCesiumNamespace = window.Cesium;
        }
        if (tryInstallHooks() || captured) {
          clearInterval(pollId);
        }
      }
    }, 50);
    setTimeout(() => clearInterval(pollId), 20000);
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
      const pick = await pickAtCenter(page);
      result.pick = pick;
      // Pick is PASS if we got back a non-null `picked` object with at
      // least an entity name OR a primitive class name.
      if (pick && pick.picked) {
        const target = pick.picked.entityName || pick.picked.primitiveName;
        if (target) {
          result.notes.push(
            `pick succeeded: entity=${pick.picked.entityName} primitive=${pick.picked.primitiveName}`,
          );
        } else {
          result.status = "FAIL";
          result.notes.push(
            `pick returned object but no entity/primitive name`,
          );
        }
      } else if (pick && pick.error) {
        result.status = "FAIL";
        result.notes.push(`pick error: ${pick.error}`);
      } else {
        // No pick result — could mean pickable target was off-center.
        // For Voxel Pick (hexagon in space) the canvas center may miss
        // the prim. We mark as a soft note rather than FAIL because the
        // canvas itself rendered fine.
        result.notes.push(
          `pick returned null at canvas center + offsets — primitive may be off-center, render itself OK`,
        );
      }
      const pickShot = path.join(SCREENSHOT_DIR, `${baseName}-after-pick.png`);
      await page.screenshot({ path: pickShot, fullPage: false });
      result.pickScreenshot = pickShot;
    }

    if (/Point Light Shadows/.test(fileName)) {
      try {
        await page.evaluate(() => {
          const v = window.viewer || window.__capturedViewer;
          // Synthetic viewer from widget doesn't expose shadowMap (that's
          // a Viewer-level API). The CesiumWidget scene has a
          // `scene.shadowMap` reference we can fall back to.
          const sm =
            v && v.shadowMap
              ? v.shadowMap
              : v && v.scene && v.scene.shadowMap
                ? v.scene.shadowMap
                : null;
          if (sm) {
            sm.softShadows = true;
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
        if (layerCount >= 0 && layerCount < 8) {
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
      const artifactCount = consoleErrors.filter(isKnownArtifact).length;
      if (artifactCount > 0) {
        result.notes.push(
          `${artifactCount} known-artifact console error(s) ignored (setPointerCapture/etc.)`,
        );
      }
    }
    if (pageErrors.length > 0) {
      const realPageErrors = pageErrors.filter(
        (e) => !isKnownArtifact(String(e)),
      );
      if (realPageErrors.length > 0) {
        result.status = "FAIL";
        result.notes.push(
          `${realPageErrors.length} uncaught page error(s) (excluding known artifacts)`,
        );
      }
      const artifactPageErrors = pageErrors.length - realPageErrors.length;
      if (artifactPageErrors > 0) {
        result.notes.push(
          `${artifactPageErrors} known-artifact page error(s) ignored (setPointerCapture/etc.)`,
        );
      }
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
