#!/usr/bin/env node
/**
 * Build-Variant Smoke Test
 *
 * Loads each variant's IIFE bundle in Playwright, waits for the
 * Viewer to initialize, renders a few frames, and asserts that no
 * console errors were logged. This catches the silent-regression
 * class of bugs where a variant BUILDS cleanly but CRASHES at
 * runtime because a code path hits an empty-stub shader or a
 * proxy-throwing WebGPU module.
 *
 * Three variants are verified:
 *   - Build/Cesium            — dual, WebGPU-first default
 *   - Build/CesiumWebGL       — webgl-only
 *   - Build/CesiumWebGPU      — webgpu-only
 *
 * Pass criteria per variant:
 *   1. Page loads without throwing
 *   2. window.Cesium is defined after the IIFE executes
 *   3. Cesium.Viewer(container) constructs without throwing
 *   4. Five render frames complete
 *   5. Zero console.error calls during the whole run
 *
 * Usage:
 *   node Tools/variant-smoke-test.mjs                  # all three variants
 *   node Tools/variant-smoke-test.mjs --variant webgl-only
 *   node Tools/variant-smoke-test.mjs --headed         # show the browser
 *
 * Exit code: 0 = all pass, 1 = any failure, 2 = bad args.
 *
 * Requires `npm run restart` (or equivalent) to be serving the dev
 * server so Build/ artifacts are reachable via HTTP.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const VARIANTS = [
  {
    name: "dual",
    bundlePath: "Build/Cesium/Cesium.js",
    // Dual ships with webgpu-first default. Explicitly pass renderer so the
    // smoke test exercises BOTH backends across the suite.
    renderer: "webgpu",
  },
  {
    name: "webgl-only",
    bundlePath: "Build/CesiumWebGL/Cesium.js",
    renderer: "webgl",
  },
  {
    name: "webgpu-only",
    bundlePath: "Build/CesiumWebGPU/Cesium.js",
    renderer: "webgpu",
  },
];

function parseArgs(argv) {
  const args = {
    variant: null,
    headless: true,
    baseUrl: "http://localhost:8080",
    browser: "msedge",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headless = false;
    else if (a === "--variant") args.variant = argv[++i];
    else if (a === "--url") args.baseUrl = argv[++i];
    else if (a === "--browser") args.browser = argv[++i];
    else if (a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    "Usage: node Tools/variant-smoke-test.mjs [--variant NAME] [--url URL] [--browser msedge|chromium|firefox|webkit] [--headed]",
  );
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error(
      "[variant-smoke-test] Playwright is not installed. Run: npm install --save-dev playwright",
    );
    process.exit(2);
  }
}

/**
 * Generates an ephemeral HTML page that loads the given IIFE bundle
 * and runs a minimal Viewer boot. Kept as a string-template here
 * rather than a file on disk so the test is self-contained — no
 * fixture files to keep in sync with variant paths.
 */
function htmlTemplate(bundlePath, rendererType) {
  // Derive the base URL from the bundle path — Cesium resolves Workers/,
  // Assets/, Widgets/ paths relative to CESIUM_BASE_URL. `bundlePath`
  // starts with "/" (it's an absolute URL path) so
  // stripping the trailing "Cesium.js" gives us the right directory.
  const baseUrl = bundlePath.replace(/Cesium\.js$/, "");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>variant smoke: ${bundlePath}</title>
<link rel="stylesheet" href="${baseUrl}Widgets/widgets.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  #container { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="container"></div>
<script>
  // Cesium auto-detects the base URL from the script tag src, but
  // explicitly setting it avoids edge cases where the detection picks
  // up the wrong script (e.g., a userscript injected by the browser).
  // Compute the fully-qualified base URL at inline-script time so it's
  // locked down before the Cesium bundle's IIFE executes. We tried
  // relative URLs ("Build/Cesium/") and they resolve to origin inside
  // Resource.DEFAULT.getDerivedResource — absolute URL avoids the
  // relative-URL-vs-base interaction entirely.
  window.CESIUM_BASE_URL = new URL(${JSON.stringify(baseUrl)}, window.location.href).href;
  window.__smokeErrors = [];
  window.addEventListener("error", function (ev) {
    window.__smokeErrors.push(String(ev.error ?? ev.message));
  });
  window.addEventListener("unhandledrejection", function (ev) {
    window.__smokeErrors.push("unhandledrejection: " + String(ev.reason));
  });
</script>
<script src="${bundlePath}"></script>
<script>
  (async function boot() {
    try {
      if (!window.Cesium) {
        throw new Error("Cesium global is undefined after bundle load");
      }
      // Re-set the base URL explicitly AFTER the bundle loads. We resolve
      // the relative CESIUM_BASE_URL against the current page URL so the
      // base is a fully-qualified absolute URL — that sidesteps any
      // relative-URL vs Resource.DEFAULT interactions inside Cesium.
      if (Cesium.buildModuleUrl?.setBaseUrl) {
        const absoluteBase = new URL(
          window.CESIUM_BASE_URL,
          window.location.href,
        ).href;
        window.__smokeSetBaseUrlCalled = absoluteBase;
        Cesium.buildModuleUrl._clearBaseResource?.();
        Cesium.buildModuleUrl.setBaseUrl(absoluteBase);
        window.__smokeBuildModuleUrlAfterSet = Cesium.buildModuleUrl("");
      }
      // Disable default imagery + terrain — they trigger network fetches
      // that can log console.error on failures unrelated to the bundle
      // itself. The point of the smoke test is "does the bundle load +
      // Viewer construct + render without throwing", not "is my network
      // working". Terrain gets a plain ellipsoid so there's still a
      // globe to render.
      // WebGPU context creation is async (device.requestAdapter) so the
      // WebGPU path must go through Viewer.createAsync. The sync
      // "new Viewer(...)" path ALWAYS gets a WebGL context — that is a
      // CesiumWidget architectural constraint, not something we can work
      // around from the smoke test.
      const viewerOptions = {
        contextOptions: { renderer: ${JSON.stringify(rendererType)} },
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        infoBox: false,
        selectionIndicator: false,
      };
      const viewer = ${JSON.stringify(rendererType)} === "webgpu"
        ? await Cesium.Viewer.createAsync("container", viewerOptions)
        : new Cesium.Viewer("container", viewerOptions);
      window.__viewer = viewer;

      // Wait for a few frames to render so shader compile / pipeline
      // creation paths exercise.
      await new Promise(function (resolve) {
        let frames = 0;
        function tick() {
          if (++frames >= 5) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        }
        tick();
      });
      window.__smokeReady = true;
    } catch (err) {
      window.__smokeErrors.push("boot: " + (err && err.stack ? err.stack : String(err)));
      window.__smokeReady = "failed";
    }
  })();
</script>
</body>
</html>
`;
}

/**
 * Writes the ephemeral smoke HTML into the variant's output dir so
 * relative script srcs (Build/Cesium/Cesium.js) resolve correctly
 * when served from the project root over HTTP. The file is deleted
 * after the test runs.
 */
async function writeSmokeHtml(variant) {
  const htmlFilename = `__smoke-${variant.name}.html`;
  const htmlPath = path.join(projectRoot, htmlFilename);
  // Use a relative bundle path (no leading slash). The existing demos
  // under Apps/ use this form, and Cesium's buildModuleUrl pipeline treats
  // relative CESIUM_BASE_URL values differently from absolute ones — a
  // leading-slash path was resolving to the origin root instead of the
  // bundle directory in practice. Relative from the HTML at project root
  // means the resolved base URL is `<origin>/Build/<variant>/`.
  const relativeBundle = variant.bundlePath.replace(/\\/g, "/");
  await fs.writeFile(
    htmlPath,
    htmlTemplate(relativeBundle, variant.renderer),
    "utf8",
  );
  return { htmlPath, urlPath: htmlFilename };
}

async function runVariant(browserType, args, variant) {
  console.log(`\n[variant=${variant.name}] booting…`);

  // Verify the bundle actually exists before launching Playwright —
  // gives a clearer error message than the page-level "404".
  const bundleAbs = path.join(projectRoot, variant.bundlePath);
  try {
    await fs.access(bundleAbs);
  } catch {
    console.error(
      `[variant=${variant.name}] MISSING: ${variant.bundlePath} — run \`npx gulp buildAllVariants\` first`,
    );
    return { variant: variant.name, status: "MISSING", errors: [] };
  }

  const { htmlPath, urlPath } = await writeSmokeHtml(variant);

  // Chromium's headless mode disables WebGPU by default. The --enable-features
  // flags mirror what `chrome://flags/#enable-unsafe-webgpu` does interactively.
  // Without these, a webgpu variant silently falls back to WebGL in headless,
  // which is a false-negative for the whole smoke test.
  const browser = await browserType.launch({
    headless: args.headless,
    channel: args.browser === "msedge" ? "msedge" : undefined,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--use-vulkan=swiftshader",
      "--disable-vulkan-surface",
      "--enable-dawn-features=allow_unsafe_apis",
    ],
  });

  const errors = [];
  const failedRequests = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      errors.push(`pageerror: ${err.message}`);
    });
    // Log failed network requests — helps diagnose 404s where the message
    // only says "Request has failed. Status Code: 404" without a URL.
    page.on("requestfailed", (req) => {
      failedRequests.push(`${req.failure()?.errorText ?? "failed"}: ${req.url()}`);
    });
    page.on("response", (resp) => {
      if (resp.status() >= 400) {
        failedRequests.push(`${resp.status()}: ${resp.url()}`);
      }
    });

    await page.goto(`${args.baseUrl}/${urlPath}`, { waitUntil: "load" });

    // Wait up to 20s for __smokeReady to flip. A webgpu-only bundle on a
    // machine without GPU support may trip one of the guards; that's a
    // FAIL that we want to see.
    const readyState = await page.waitForFunction(
      () => window.__smokeReady,
      null,
      { timeout: 20000 },
    );
    const ready = await readyState.jsonValue();
    const pageErrors = await page.evaluate(() => window.__smokeErrors || []);
    errors.push(...pageErrors);
    const debugInfo = await page.evaluate(() => ({
      cesiumBaseUrl: typeof window.CESIUM_BASE_URL !== "undefined" ? String(window.CESIUM_BASE_URL) : "<unset>",
      setBaseUrlCalled: window.__smokeSetBaseUrlCalled ?? "<never>",
      buildModuleUrlAfterSet: window.__smokeBuildModuleUrlAfterSet ?? "<never>",
      buildModuleUrlNow: (() => {
        try {
          return window.Cesium?.buildModuleUrl
            ? window.Cesium.buildModuleUrl("")
            : "<no buildModuleUrl>";
        } catch (e) { return "<throw: " + String(e) + ">"; }
      })(),
      buildModuleUrlAssets: (() => {
        try { return window.Cesium?.buildModuleUrl?.("Assets/approximateTerrainHeights.json"); }
        catch (e) { return "<throw: " + String(e) + ">"; }
      })(),
      baseResourceUrl: (() => {
        try { return window.Cesium?.buildModuleUrl?.getCesiumBaseUrl?.()?.url; }
        catch (e) { return "<throw: " + String(e) + ">"; }
      })(),
      contextType: (() => {
        try {
          const ctx = window.__viewer?.scene?.context;
          return ctx?.rendererType ?? (ctx?.isWebGPU ? "webgpu?" : "webgl?");
        } catch (e) { return "<throw: " + String(e) + ">"; }
      })(),
      webgpuAvailable: typeof navigator !== "undefined" && !!navigator.gpu,
    }));
    console.log(`  [debug] CESIUM_BASE_URL="${debugInfo.cesiumBaseUrl}"`);
    console.log(`  [debug] setBaseUrl called with="${debugInfo.setBaseUrlCalled}"`);
    console.log(`  [debug] buildModuleUrl("") right after setBaseUrl="${debugInfo.buildModuleUrlAfterSet}"`);
    console.log(`  [debug] buildModuleUrl("") now="${debugInfo.buildModuleUrlNow}"`);
    console.log(`  [debug] buildModuleUrl(Assets/approximateTerrainHeights.json)="${debugInfo.buildModuleUrlAssets}"`);
    console.log(`  [debug] getCesiumBaseUrl().url="${debugInfo.baseResourceUrl}"`);
    console.log(`  [debug] context.rendererType="${debugInfo.contextType}" navigator.gpu=${debugInfo.webgpuAvailable}`);

    const status =
      ready === true && errors.length === 0 ? "PASS" : "FAIL";
    console.log(
      `[variant=${variant.name}] ${status} — ${errors.length} error(s)`,
    );
    if (status === "FAIL") {
      for (const e of errors) console.log(`  · ${e}`);
      if (failedRequests.length > 0) {
        console.log(`  failed requests (${failedRequests.length}):`);
        for (const f of failedRequests.slice(0, 20)) console.log(`    · ${f}`);
      }
    }

    return { variant: variant.name, status, errors, failedRequests };
  } finally {
    await browser.close().catch(() => {});
    await fs.unlink(htmlPath).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = args.variant
    ? VARIANTS.filter((v) => v.name === args.variant)
    : VARIANTS;
  if (targets.length === 0) {
    console.error(`No variant matched --variant ${args.variant}`);
    process.exit(2);
  }

  const playwright = await loadPlaywright();
  const browserType =
    args.browser === "firefox"
      ? playwright.firefox
      : args.browser === "webkit"
        ? playwright.webkit
        : playwright.chromium;

  const results = [];
  for (const variant of targets) {
    const result = await runVariant(browserType, args, variant);
    results.push(result);
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`  ${r.variant.padEnd(15)}  ${r.status}`);
  }

  const anyFail = results.some((r) => r.status !== "PASS");
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
