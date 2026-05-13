#!/usr/bin/env node
/**
 * Cross-Backend Sandcastle Visual-Regression Runner
 *
 * Loads each Sandcastle gallery demo TWICE — once forced to WebGL and once
 * forced to WebGPU — captures the canvas, pixel-diffs the two captures, and
 * writes a per-demo JSON report + diff PNG.
 *
 * Renderer override: an `addInitScript` shim monkey-patches
 * `Cesium.Viewer` and `Cesium.Viewer.createAsync` to inject
 * `contextOptions.renderer` BEFORE the demo's own script runs. Demos that
 * already pin a specific renderer keep theirs (the shim only adds the field
 * when missing). This means WebGPU-prefixed demos still run as WebGPU
 * regardless of the requested override; the diff for those demos is always
 * "renderer pinned" and is skipped.
 *
 * Usage:
 *   node Tools/visual-regression/cross-backend-sandcastle-runner.mjs
 *   node Tools/visual-regression/cross-backend-sandcastle-runner.mjs --limit 20
 *   node Tools/visual-regression/cross-backend-sandcastle-runner.mjs --filter "3D Tiles"
 *   node Tools/visual-regression/cross-backend-sandcastle-runner.mjs --start 200
 *
 * Output:
 *   Tools/visual-regression/output/cross-backend/<sanitized>.webgl.png
 *   Tools/visual-regression/output/cross-backend/<sanitized>.webgpu.png
 *   Tools/visual-regression/output/cross-backend/<sanitized>.diff.png
 *   Tools/visual-regression/output/cross-backend/report.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CESIUM_REPO_ROOT || "F:/Dev/GH/cesium-webgpu";
const GALLERY_DIR = path.join(REPO_ROOT, "Apps", "Sandcastle", "gallery");
const OUTPUT_DIR = path.join(__dirname, "output", "cross-backend");
const REPORT_PATH = path.join(OUTPUT_DIR, "report.json");
const BASE_URL = process.env.SANDCASTLE_BASE_URL || "http://localhost:8080";

const argv = process.argv.slice(2);
function arg(name, defValue) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : defValue;
}
function multiArg(name) {
  // Collect all occurrences. Lets us write `--include "Hello World" --include "Camera"`
  // OR `--include "Hello World,Camera"` interchangeably.
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) {
      argv[i + 1].split(",").forEach((v) => {
        const t = v.trim();
        if (t.length > 0) out.push(t);
      });
    }
  }
  return out;
}
const LIMIT = parseInt(arg("--limit", "0"), 10);
const FILTER = arg("--filter", "");
const START = parseInt(arg("--start", "0"), 10);
const HEADED = argv.includes("--headed");
const HELP = argv.includes("--help") || argv.includes("-h");

// New selection knobs (Session 63 cont.):
//   --include "Hello World,Camera"  — case-insensitive substring OR-match. A
//     demo is kept if ANY substring matches its filename. Equivalent to
//     repeating --include for each substring.
//   --exclude "3D Tiles,WebGPU "   — case-insensitive substring; demo is
//     dropped if ANY substring matches. Applied after --filter / --include.
//   --exact "Hello World.html"     — exact filename match (one OR many,
//     comma-separated). Bypasses substring matching entirely; useful when
//     "Hello World" would also match "Hello World Tutorial".
//   --list                         — print the selected demos and exit
//     without running anything (sanity-check before a long sweep).
const INCLUDE = multiArg("--include").map((s) => s.toLowerCase());
const EXCLUDE = multiArg("--exclude").map((s) => s.toLowerCase());
const EXACT = multiArg("--exact"); // case-preserving — file names are case-sensitive on Linux
const LIST_ONLY = argv.includes("--list");
const TIMEOUT_PER_DEMO_MS = 60000;
// Bumped from 3000 → 8000 in Session 65: WebGPU's terrain tile loader
// (and the 3D Tiles loader for high-LOD photogrammetry meshes) takes
// noticeably longer than WebGL's at low camera altitudes — the previous
// 3 second wait caught the camera flying in but not the geometry/imagery
// settled, producing screenshots with empty terrain across ~10 ground-
// level demos (Aerometrex SF, 3D Tiles BIM, Bloom, Particle System,
// Lighting, Shadows, etc.). 8 seconds covers Aerometrex SF + most 3D
// Tiles streams in CI; override via SANDCASTLE_SETTLE_MS if a demo
// needs longer (e.g. 15000 covers the slowest first-load cases).
const SETTLE_MS = parseInt(process.env.SANDCASTLE_SETTLE_MS, 10) || 8000;
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

function printUsage() {
  console.log(`
Cross-backend sandcastle runner — runs each demo in WebGL and WebGPU,
captures canvases, and writes report.json + per-demo PNGs.

Selection (combine as needed):
  --filter "X"        Single substring; case-insensitive (legacy)
  --include "A,B,C"   OR-match: keep demos containing any of A, B, or C
                      (repeatable: --include A --include "B,C")
  --exclude "X,Y"     Drop demos matching any of X / Y (applied last)
  --exact "Foo.html"  Exact filename(s); comma-separated. Bypasses substring
                      matching. Use when "Camera" would also match
                      "Camera Tutorial".
  --start N           Skip the first N demos (after include/exclude)
  --limit N           Cap to N demos (after start)

Run-time:
  --headed            Run with a visible browser window
  --list              Print the selected demos and exit (no rendering)

Examples:
  # Re-test the demos affected by a fix
  --include "Hello World,Atmosphere,Globe Materials"

  # Run the full 3D-Tiles batch except Yemen
  --include "3D Tiles" --exclude "Yemen"

  # Pin to one demo (no fuzzy match)
  --exact "Hello World.html"
`);
}

function standaloneUrl(fileName) {
  return `${BASE_URL}/Apps/Sandcastle/gallery/${encodeURIComponent(fileName)}`;
}

function sanitize(name) {
  return name.replace(/\.html$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function listDemos() {
  const entries = await fs.readdir(GALLERY_DIR);
  let demos = entries
    .filter((e) => e.endsWith(".html") && !e.startsWith("development"))
    .sort();

  // --exact short-circuits everything else: explicit filename list, no fuzzy.
  if (EXACT.length > 0) {
    const exactSet = new Set(EXACT);
    const missing = EXACT.filter((name) => !demos.includes(name));
    if (missing.length > 0) {
      console.warn(
        `[runner] --exact: these demos do not exist in ${GALLERY_DIR}:\n  - ` +
          missing.join("\n  - "),
      );
    }
    demos = demos.filter((d) => exactSet.has(d));
  } else {
    if (FILTER) {
      const f = FILTER.toLowerCase();
      demos = demos.filter((d) => d.toLowerCase().includes(f));
    }
    if (INCLUDE.length > 0) {
      demos = demos.filter((d) => {
        const lc = d.toLowerCase();
        return INCLUDE.some((s) => lc.includes(s));
      });
    }
    if (EXCLUDE.length > 0) {
      demos = demos.filter((d) => {
        const lc = d.toLowerCase();
        return !EXCLUDE.some((s) => lc.includes(s));
      });
    }
  }

  if (START > 0) demos = demos.slice(START);
  if (LIMIT > 0) demos = demos.slice(0, LIMIT);
  return demos;
}

const RENDERER_OVERRIDE_SHIM = `
(() => {
  const FORCED_RENDERER = window.__FORCED_RENDERER__;
  if (!FORCED_RENDERER) return;

  window.__capturedViewer = null;
  function captureViewer(v) {
    if (!window.__capturedViewer && v) window.__capturedViewer = v;
    return v;
  }

  function patchOptions(options) {
    if (!options || typeof options !== "object") return options;
    const ctx = options.contextOptions || (options.contextOptions = {});
    if (!ctx.renderer) ctx.renderer = FORCED_RENDERER;
    return options;
  }

  function buildPatchedNamespace(C) {
    if (!C || !C.Viewer) return C;
    const Original = C.Viewer;
    const OriginalCreateAsync = Original.createAsync;

    function PatchedViewer(container, options) {
      const inst = new Original(container, patchOptions(options || {}));
      return captureViewer(inst);
    }
    PatchedViewer.prototype = Original.prototype;
    Object.assign(PatchedViewer, Original);
    PatchedViewer.createAsync = function (container, options) {
      return OriginalCreateAsync.call(
        Original,
        container,
        patchOptions(options || {}),
      ).then(captureViewer);
    };

    // Cesium is a frozen Module Namespace Object — direct property
    // mutation silently fails. Wrap in a Proxy that returns the
    // patched Viewer for every Cesium.Viewer read.
    return new Proxy(C, {
      get(target, prop) {
        if (prop === "Viewer") return PatchedViewer;
        if (prop === "__rendererPatchInstalled") return true;
        return target[prop];
      },
      has(target, prop) {
        if (prop === "Viewer" || prop === "__rendererPatchInstalled") return true;
        return prop in target;
      },
    });
  }

  // Intercept the FIRST window.Cesium assignment from load-cesium-es6.js
  // so the proxy is in place BEFORE any demo script reads Cesium.Viewer.
  let _cesium;
  Object.defineProperty(window, "Cesium", {
    configurable: true,
    enumerable: true,
    get() { return _cesium; },
    set(val) {
      _cesium = buildPatchedNamespace(val);
      Object.defineProperty(window, "Cesium", {
        value: _cesium,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
  });

  if (window.Cesium) {
    const replaced = buildPatchedNamespace(window.Cesium);
    Object.defineProperty(window, "Cesium", {
      value: replaced,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // load-cesium-es6.js does \`window.startup(Cesium)\` passing the
  // ORIGINAL module namespace as a parameter — the demo's local
  // \`Cesium\` is unpatched. Intercept window.startup assignment and
  // wrap so the patched namespace is forwarded instead.
  let _startup;
  let _startupPromise = null;
  Object.defineProperty(window, "startup", {
    configurable: true,
    enumerable: true,
    get() { return _startup; },
    set(val) {
      if (typeof val === "function") {
        _startup = function (_originalCesium, ...rest) {
          // Capture the Promise the first time startup is invoked so
          // Sandcastle.finishedLoading can chain to it (instead of
          // firing while startup is still suspended at its first await).
          const result = val.call(this, window.Cesium, ...rest);
          if (!_startupPromise && result && typeof result.then === "function") {
            _startupPromise = result;
          }
          return result;
        };
      } else {
        _startup = val;
      }
    },
  });

  // Sandcastle.finishedLoading runs defaultAction (the first toolbar-
  // menu option's onselect) IF defaultAction is set. The legacy demo
  // pattern is sync new Viewer(...) so addToolbarMenu has run by the
  // time finishedLoading is called from the bottom of the script tag.
  // Our WebGPU run rewrites that to await createAsync(...) which
  // yields to microtasks. finishedLoading then fires BEFORE startup
  // completes, so defaultAction is undefined and the demo's initial
  // entity / camera setup never runs (visible bug: WebGPU shows the
  // default globe instead of the demo's intended view).
  //
  // Fix: defer Sandcastle.finishedLoading() until window.startup's
  // returned Promise resolves. We override the function once Sandcastle
  // is loaded; if the call comes BEFORE startup is invoked, we queue
  // it; if startup is already running, we chain it to the promise.
  let _finishedLoadingCalled = false;
  let _finishedLoadingPending = false;
  let _origFinishedLoading = null;
  function runFinishedLoading() {
    if (_finishedLoadingCalled || !_origFinishedLoading) return;
    _finishedLoadingCalled = true;
    try {
      _origFinishedLoading.call(window.Sandcastle);
    } catch (e) {
      console.error("[runner] Sandcastle.finishedLoading threw:", e);
    }
  }
  function deferFinishedLoading() {
    if (_finishedLoadingPending || _finishedLoadingCalled) return;
    _finishedLoadingPending = true;
    // Chain to the captured startup promise. If startup hasn't been
    // invoked yet (early call), poll a microtask until it has, then
    // chain. Falls back to a 2-microtask deferral if no startup
    // promise is ever captured (demo doesn't use window.startup).
    function tryChain(remainingPolls) {
      if (_startupPromise) {
        Promise.resolve(_startupPromise)
          .then(() => Promise.resolve())  // one extra round for any nested awaits
          .then(runFinishedLoading)
          .catch(runFinishedLoading);  // run even on demo error
        return;
      }
      if (remainingPolls <= 0) {
        runFinishedLoading();
        return;
      }
      Promise.resolve().then(() => tryChain(remainingPolls - 1));
    }
    tryChain(20);
  }
  function patchSandcastle() {
    const SC = window.Sandcastle;
    if (!SC || _origFinishedLoading) return;
    _origFinishedLoading = SC.finishedLoading;
    // Defer finishedLoading whenever startup is async/pending — the
    // toolbar menu may not be registered yet (demos await
    // Cesium.Viewer.createAsync BEFORE calling addToolbarMenu, so the
    // sequence on WebGPU is finishedLoading() → addToolbarMenu() rather
    // than the WebGL sequence addToolbarMenu() → finishedLoading()).
    //
    // The previous "_hasToolbarMenu" gate fired the original
    // finishedLoading synchronously when the menu hadn't been seen yet,
    // which on WebGPU meant defaultAction was undefined and never ran —
    // so model demos (3D Models, 3D Models Coloring, anything that uses
    // viewer.trackedEntity = entity from a toolbar onselect) showed the
    // default Earth-from-space view instead of the intended close-up.
    //
    // New rule: if startup is pending OR not yet captured, always defer.
    // The deferral resolves after startup's Promise resolves, which
    // gives the demo a chance to register its menu first.
    SC.finishedLoading = function () {
      if (_startupPromise || typeof _startup === "function") {
        // Startup exists / is pending → defer until it resolves.
        deferFinishedLoading();
        return;
      }
      // No startup at all (legacy demos that don't use window.startup)
      // → call original synchronously.
      _origFinishedLoading.call(SC);
      _finishedLoadingCalled = true;
    };
  }
  // Sandcastle is loaded via a sync <script> tag in the page <head>,
  // so it's typically present before our shim runs. Try once
  // immediately, then fall back to a rAF poll if it's somehow late.
  function tryPatch() {
    if (window.Sandcastle) {
      patchSandcastle();
    } else {
      requestAnimationFrame(tryPatch);
    }
  }
  tryPatch();
})();
`;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    console.error("[runner] Playwright not installed:", err.message);
    process.exit(2);
  }
}

const SUPPRESSED_PAGE_ERRORS = [
  /setPointerCapture/,
  /^The above error occurred/,
  /favicon/,
];

// Browser-environment + dev-build noise that isn't a Cesium issue.
// Loaded from `Build/CesiumUnminified` so debug-pragma diagnostics
// are intact — these are correctly stripped in production builds and
// shouldn't count as runtime regressions for the sweep.
const SUPPRESSED_CONSOLE_PATTERNS = [
  /powerPreference option is currently ignored/i,
  // All `[WebGPU:*]`, `[WebGPUPrimitiveCommands]`, `[CesiumJS:*]`
  // diagnostics are debug-pragma-wrapped. They appear here only
  // because the unminified build is used for sandcastle dev — they
  // do NOT appear in production builds. Match anywhere in the
  // message body (Playwright's console.text() does not include
  // the `[warning]` / `[error]` type prefix).
  /\[WebGPU:/,
  /\[WebGPUPrimitiveCommands\]/,
  /\[WebGPU\] Frustum \d+:/,
  /\[CesiumJS:webgpu/,
  /Primitive outlines disable imagery draping/,
  /Failed to load resource: the server responded with a status of (4|5)\d\d/,
  // Known doc'd limitations (not bugs):
  /Model\.customShader is not yet supported on the WebGPU backend/,
  /AUDIT_2026_05_02/,
];

function shouldSuppressError(text) {
  return SUPPRESSED_PAGE_ERRORS.some((re) => re.test(text));
}

function shouldSuppressConsole(text) {
  return SUPPRESSED_CONSOLE_PATTERNS.some((re) => re.test(text));
}

async function captureRenderer(page, demoFile, forcedRenderer) {
  const messages = [];
  const pageErrors = [];

  page.removeAllListeners("console");
  page.removeAllListeners("pageerror");
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      const text = m.text();
      if (!shouldSuppressConsole(text)) {
        messages.push(`[${m.type()}] ${text}`);
      }
    }
  });
  page.on("pageerror", (err) => {
    const msg = String(err?.message || err);
    if (!shouldSuppressError(msg)) pageErrors.push(msg);
  });

  await page.addInitScript((r) => {
    window.__FORCED_RENDERER__ = r;
  }, forcedRenderer);
  await page.addInitScript({ content: RENDERER_OVERRIDE_SHIM });

  // For WebGPU runs, rewrite the demo's HTML on the wire to convert
  // sync `new Cesium.Viewer(...)` into `await Cesium.Viewer.createAsync(...)`.
  // The sync constructor has no WebGPU code path (silently falls back
  // to WebGL even when contextOptions.renderer === "webgpu"); only the
  // async path engages WebGPU. Demo startup() is already async so the
  // injected `await` parses cleanly.
  await page.unroute("**").catch(() => {});
  if (forcedRenderer === "webgpu") {
    await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
      const response = await route.fetch();
      const original = await response.text();
      // Replace `new Cesium.Viewer(` and `new Viewer(` (rare) with
      // `await Cesium.Viewer.createAsync(`. Multiline-safe since we
      // operate on a flat string and the args list is left intact.
      const rewritten = original
        .replace(/new\s+Cesium\.Viewer\s*\(/g, "await Cesium.Viewer.createAsync(")
        .replace(/new\s+Viewer\s*\(/g, "await Cesium.Viewer.createAsync(");
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: rewritten,
      });
    });
  }

  const url = standaloneUrl(demoFile);
  const navStart = Date.now();
  let navError = null;
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_PER_DEMO_MS,
    });
  } catch (err) {
    navError = String(err?.message || err);
  }

  let canvasReady = false;
  let actualRenderer = null;
  if (!navError) {
    try {
      await page.waitForFunction(
        () => {
          const c = document.querySelector(".cesium-widget canvas");
          return c && c.width > 0 && c.height > 0;
        },
        { timeout: TIMEOUT_PER_DEMO_MS },
      );
      canvasReady = true;
    } catch (err) {
      navError = navError || `canvas-wait: ${String(err?.message || err)}`;
    }
  }

  if (canvasReady) {
    await page.waitForTimeout(SETTLE_MS);
    actualRenderer = await page
      .evaluate(() => {
        const v =
          window.__capturedViewer ||
          window.viewer ||
          window.viewer1;
        return v?.scene?.context?.rendererType || null;
      })
      .catch(() => null);
  }

  const elapsedMs = Date.now() - navStart;
  let pngBuffer = null;
  if (canvasReady) {
    try {
      const handle = await page.$(".cesium-widget canvas");
      if (handle) {
        pngBuffer = await handle.screenshot({ type: "png" });
      }
    } catch (err) {
      navError = navError || `screenshot: ${String(err?.message || err)}`;
    }
  }

  return {
    forcedRenderer,
    actualRenderer,
    canvasReady,
    elapsedMs,
    navError,
    consoleErrorCount: messages.length,
    consoleMessages: messages.slice(0, 50), // first 50 console error/warn messages, full text
    pageErrors: pageErrors.slice(0, 10),
    pngBuffer,
  };
}

/**
 * Pixel diff via the browser's `createImageBitmap` + 2D canvas. Avoids
 * pulling in a Node-side PNG decoder. Returns diff stats + the diff
 * RGBA buffer for the optional encode step.
 */
async function pixelDiffInBrowser(page, pngA, pngB) {
  if (!pngA || !pngB) return null;
  const a64 = Buffer.from(pngA).toString("base64");
  const b64 = Buffer.from(pngB).toString("base64");
  return await page.evaluate(
    async ({ aBase, bBase }) => {
      async function decode(b) {
        const blob = await (await fetch(`data:image/png;base64,${b}`)).blob();
        const bm = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bm.width, bm.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(bm, 0, 0);
        return {
          width: bm.width,
          height: bm.height,
          data: ctx.getImageData(0, 0, bm.width, bm.height).data,
        };
      }
      const a = await decode(aBase);
      const b = await decode(bBase);
      if (a.width !== b.width || a.height !== b.height) {
        return {
          mismatch: true,
          sizeMismatch: true,
          aSize: `${a.width}x${a.height}`,
          bSize: `${b.width}x${b.height}`,
        };
      }
      const total = a.width * a.height;
      let bad = 0;
      const tol = 16;
      for (let i = 0; i < a.data.length; i += 4) {
        if (
          Math.abs(a.data[i] - b.data[i]) > tol ||
          Math.abs(a.data[i + 1] - b.data[i + 1]) > tol ||
          Math.abs(a.data[i + 2] - b.data[i + 2]) > tol
        ) {
          bad++;
        }
      }
      return {
        mismatch: bad > 0,
        diffPixels: bad,
        totalPixels: total,
        diffPercent: (bad / total) * 100,
        width: a.width,
        height: a.height,
      };
    },
    { aBase: a64, bBase: b64 },
  );
}

async function runOne(browser, demoFile) {
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT_PER_DEMO_MS);

  const slug = sanitize(demoFile);
  const result = { demo: demoFile, slug };

  try {
    const webgl = await captureRenderer(page, demoFile, "webgl");
    result.webgl = {
      ok: webgl.canvasReady,
      actualRenderer: webgl.actualRenderer,
      elapsedMs: webgl.elapsedMs,
      navError: webgl.navError,
      consoleErrorCount: webgl.consoleErrorCount,
      consoleMessages: webgl.consoleMessages,
      pageErrors: webgl.pageErrors,
    };
    if (webgl.pngBuffer) {
      await fs.writeFile(
        path.join(OUTPUT_DIR, `${slug}.webgl.png`),
        webgl.pngBuffer,
      );
    }

    const webgpu = await captureRenderer(page, demoFile, "webgpu");
    result.webgpu = {
      ok: webgpu.canvasReady,
      actualRenderer: webgpu.actualRenderer,
      elapsedMs: webgpu.elapsedMs,
      navError: webgpu.navError,
      consoleErrorCount: webgpu.consoleErrorCount,
      consoleMessages: webgpu.consoleMessages,
      pageErrors: webgpu.pageErrors,
    };
    if (webgpu.pngBuffer) {
      await fs.writeFile(
        path.join(OUTPUT_DIR, `${slug}.webgpu.png`),
        webgpu.pngBuffer,
      );
    }

    if (webgl.pngBuffer && webgpu.pngBuffer) {
      // Open a fresh blank page to host the browser-side diff so we
      // don't need extra Node deps. about:blank is enough — we just
      // need a page context for `createImageBitmap` + canvas.
      const diffPage = await ctx.newPage();
      await diffPage.goto("about:blank");
      result.diff = await pixelDiffInBrowser(
        diffPage,
        webgl.pngBuffer,
        webgpu.pngBuffer,
      );
      await diffPage.close().catch(() => {});
    }
  } catch (err) {
    result.fatalError = String(err?.message || err);
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }

  return result;
}

async function clearOutputDir() {
  // Wipe leftover screenshots + reports from previous runs so a partial
  // sweep can't leave stale PNGs that the analyzer mistakes for current
  // output. We keep the directory itself (re-created via ensureDir).
  // Subset runs (any selection knob set, or any slicing) only overwrite
  // the demos they intend to render — clearing the whole dir would be
  // destructive. Full sweeps wipe everything.
  let entries;
  try {
    entries = await fs.readdir(OUTPUT_DIR);
  } catch {
    return; // doesn't exist yet — ensureDir handles it
  }
  const isSubset =
    FILTER ||
    INCLUDE.length > 0 ||
    EXCLUDE.length > 0 ||
    EXACT.length > 0 ||
    START > 0 ||
    LIMIT > 0;
  if (isSubset) {
    return;
  }
  let removed = 0;
  for (const name of entries) {
    if (
      name.endsWith(".png") ||
      name === "report.json" ||
      name.endsWith(".diff.png")
    ) {
      await fs.rm(path.join(OUTPUT_DIR, name), { force: true });
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[runner] cleared ${removed} stale files from ${OUTPUT_DIR}`);
  }
}

async function main() {
  if (HELP) {
    printUsage();
    return;
  }
  await ensureDir(OUTPUT_DIR);
  await clearOutputDir();
  const demos = await listDemos();
  console.log(`[runner] ${demos.length} demos to run`);
  if (LIMIT > 0) console.log(`[runner] limited to first ${LIMIT}`);
  if (FILTER) console.log(`[runner] filter: "${FILTER}"`);
  if (INCLUDE.length > 0) console.log(`[runner] include: [${INCLUDE.join(", ")}]`);
  if (EXCLUDE.length > 0) console.log(`[runner] exclude: [${EXCLUDE.join(", ")}]`);
  if (EXACT.length > 0) console.log(`[runner] exact: [${EXACT.join(", ")}]`);
  if (LIST_ONLY) {
    console.log("[runner] --list: selected demos:");
    demos.forEach((d) => console.log(`  - ${d}`));
    return;
  }
  if (demos.length === 0) {
    console.log("[runner] no demos matched the selection. exiting.");
    return;
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: !HEADED,
    channel: "msedge",
  });

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    demoCount: demos.length,
    results: [],
  };

  const t0 = Date.now();
  for (let i = 0; i < demos.length; i++) {
    const demo = demos[i];
    const elapsed = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(
      `[runner] [${i + 1}/${demos.length}] (${elapsed}s) ${demo} ... `,
    );
    const result = await runOne(browser, demo);
    report.results.push(result);
    const wgl = result.webgl?.ok ? "OK" : "FAIL";
    const wgpu = result.webgpu?.ok ? "OK" : "FAIL";
    const diffPct = result.diff?.diffPercent;
    const diffStr =
      diffPct !== undefined ? ` diff=${diffPct.toFixed(2)}%` : "";
    console.log(`webgl=${wgl} webgpu=${wgpu}${diffStr}`);
    // Write report incrementally so a crash mid-run still produces partial data.
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  }

  await browser.close();
  report.completedAt = new Date().toISOString();
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  const summary = report.results.reduce(
    (acc, r) => {
      if (r.webgl?.ok && r.webgpu?.ok) acc.bothOk++;
      else if (r.webgl?.ok && !r.webgpu?.ok) acc.webglOnly++;
      else if (!r.webgl?.ok && r.webgpu?.ok) acc.webgpuOnly++;
      else acc.bothFail++;
      if (r.diff?.diffPercent !== undefined) {
        acc.diffSamples++;
        acc.diffSum += r.diff.diffPercent;
        if (r.diff.diffPercent > 1.0) acc.diffOver1Pct++;
      }
      return acc;
    },
    {
      bothOk: 0,
      webglOnly: 0,
      webgpuOnly: 0,
      bothFail: 0,
      diffSamples: 0,
      diffSum: 0,
      diffOver1Pct: 0,
    },
  );

  console.log("\n=== Summary ===");
  console.log(`  bothOk:       ${summary.bothOk}`);
  console.log(`  webglOnly:    ${summary.webglOnly}`);
  console.log(`  webgpuOnly:   ${summary.webgpuOnly}`);
  console.log(`  bothFail:     ${summary.bothFail}`);
  if (summary.diffSamples > 0) {
    console.log(
      `  mean diff:    ${(summary.diffSum / summary.diffSamples).toFixed(2)}%`,
    );
    console.log(`  diff > 1%:    ${summary.diffOver1Pct}`);
  }
  console.log(`  report:       ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
