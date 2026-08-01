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
 * Serving: by default the tool starts its OWN static server on an
 * ephemeral port rooted at the project directory, so no dev server is
 * required (CI runners depend on this). Pass --url http://localhost:8080
 * to reuse an already-running dev server instead.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "./lib/webgpu-error-gate.mjs";

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
    // When --url is NOT given, the tool starts its own static server on an
    // ephemeral port (see startStaticServer) — no pre-running dev server is
    // required. CI runners rely on this; the backgrounded `npm run start`
    // arrangement died with the step shell and broke the hosted run
    // (NEW-VARIANT-CI follow-up, Batch 243).
    baseUrl: null,
    browser: "msedge",
    // NEW-WEBGPU-DEFAULT-LIMIT-GLOBE-LAYOUT (Batch 246) — when set,
    // forces Chromium's WebGPU adapter selection via
    // `--use-webgpu-adapter=<value>`. `swiftshader` pins the software
    // Vulkan adapter: the deterministic CI configuration (hosted
    // runners have no GPU) AND the local reproduction of the
    // default-limits environment (SwiftShader reports the WebGPU spec
    // floor — maxSampledTexturesPerShaderStage=16 etc.).
    webgpuAdapter: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--headed") args.headless = false;
    else if (a === "--variant") args.variant = argv[++i];
    else if (a === "--url") args.baseUrl = argv[++i];
    else if (a === "--browser") args.browser = argv[++i];
    else if (a === "--webgpu-adapter") args.webgpuAdapter = argv[++i];
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

const STATIC_MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".terrain": "application/octet-stream",
  ".czml": "application/json",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Zero-dependency static file server rooted at `rootDir`, bound to an
 * ephemeral 127.0.0.1 port. Serves the Build/ artifacts + the generated
 * __smoke-*.html so the smoke test is fully self-contained — required on
 * CI runners where no dev server exists.
 */
async function startStaticServer(rootDir) {
  const { createServer } = await import("node:http");
  const { createReadStream } = await import("node:fs");
  const normalizedRoot = path.normalize(rootDir);
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      let filePath = path.normalize(path.join(normalizedRoot, urlPath));
      if (!filePath.startsWith(normalizedRoot)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        stat = await fs.stat(filePath).catch(() => null);
      }
      if (!stat || !stat.isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type":
          STATIC_MIME[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function printHelp() {
  console.log(
    "Usage: node Tools/variant-smoke-test.mjs [--variant NAME] [--url URL (default: self-served ephemeral port)] [--browser msedge|chromium|firefox|webkit] [--webgpu-adapter swiftshader] [--headed]",
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

      // Arm the WebGPU error/crash gate on the freshly-created device BEFORE
      // the render frames below, so attachment-incompat / bad-bind-group
      // validation errors and device-loss during those frames are caught
      // (the FORK-34 class the smoke test previously slept through). No-op
      // for the webgl variant (no _device / installer is a guarded call).
      try {
        window.__armWebGPUDevice?.(
          viewer.scene?.context?._device,
          "smoke:${rendererType}",
        );
      } catch (gateErr) {
        window.__smokeErrors.push("gate-arm: " + String(gateErr));
      }

      // Run the pixel gate synchronously INSIDE scene.postRender — the only
      // timing at which both backends' canvases are readable. A WebGL
      // drawing buffer (preserveDrawingBuffer=false) is cleared after
      // compositing and a WebGPU canvas texture is cleared at present, so a
      // drawImage from a deferred task reads black whenever it loses the
      // race with the compositor. The gate POLLS each completed render
      // (after a 5-frame warmup) until the canvas is non-uniform or the
      // deadline expires — scene content arrives asynchronously (ellipsoid
      // tile meshes come from workers, atmosphere/sky pipelines compile a
      // few frames in), so any fixed frame count is a race. (Batch 242 —
      // previously 5 bare rAF ticks + a deferred read; that failed
      // webgl-only with a "uniform black canvas" false positive.)
      //
      // AUDIT_2026_05_02 C.10 — pixel-verification gate. Before C.10 this
      // script just counted frames and called it ready, so a black canvas
      // (silent fallback to WebGL after WebGPU init failure, missing
      // post-process blit, etc.) passed the smoke test. Sample a handful
      // of canvas pixels and require non-uniform output. We sample 25
      // points in a 5×5 grid (skipping the exact center which on the
      // default viewer can land on the navigation widget).
      try {
        await new Promise(function (resolve, reject) {
          const deadlineMs = 15000;
          const start = performance.now();
          let frames = 0;
          let lastUniquePixel = "<none>";
          const remove = viewer.scene.postRender.addEventListener(
            function () {
              if (++frames < 5) {
                return;
              }
              try {
                const canvas = viewer.scene.canvas || viewer.canvas;
                if (!canvas) {
                  throw new Error("No canvas on viewer");
                }
                const w = canvas.width;
                const h = canvas.height;
                const tmp = document.createElement("canvas");
                tmp.width = w;
                tmp.height = h;
                const ctx2d = tmp.getContext("2d");
                ctx2d.drawImage(canvas, 0, 0);
                const pixels = [];
                for (let i = 1; i <= 5; i++) {
                  for (let j = 1; j <= 5; j++) {
                    if (i === 3 && j === 3) continue; // skip center
                    const x = Math.floor((w * i) / 6);
                    const y = Math.floor((h * j) / 6);
                    const px = ctx2d.getImageData(x, y, 1, 1).data;
                    pixels.push([px[0], px[1], px[2]]);
                  }
                }
                // Non-uniform = at least 2 distinct RGB triplets
                const unique = new Set(pixels.map((p) => p.join(",")));
                if (unique.size >= 2) {
                  window.__smokePixelCount = unique.size;
                  remove();
                  resolve();
                  return;
                }
                lastUniquePixel = Array.from(unique)[0];
                if (performance.now() - start > deadlineMs) {
                  throw new Error(
                    "Canvas stayed uniform for " +
                      deadlineMs +
                      " ms / " +
                      frames +
                      " frames (1 distinct pixel in 24 samples). Likely a " +
                      "black canvas / silent backend fallback / missing " +
                      "post-process blit. Last pixel: " + lastUniquePixel,
                  );
                }
              } catch (innerErr) {
                remove();
                reject(innerErr);
              }
            },
          );
        });
      } catch (pixErr) {
        window.__smokeErrors.push(
          "pixel-verify: " +
            (pixErr && pixErr.stack ? pixErr.stack : String(pixErr)),
        );
        window.__smokeReady = "failed";
        return;
      }

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
      // Chromium ≥136 deprecated the automatic software-WebGL fallback;
      // headless runners (and GPU-less CI boxes) need this opt-in or the
      // webgl variants get NO context at all and the boot never readies.
      "--enable-unsafe-swiftshader",
      // Optional WebGPU adapter pin (Batch 246) — `--webgpu-adapter
      // swiftshader` forces the software Vulkan adapter so the webgpu
      // smokes run identically on GPU-less hosted runners and on dev
      // machines reproducing the default-limits environment.
      ...(args.webgpuAdapter
        ? [`--use-webgpu-adapter=${args.webgpuAdapter}`]
        : []),
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
    // WebGPU error/crash gate — catches validation errors + device-loss that
    // never surface as a thrown JS exception (FORK-34 class). `attachConsoleErrorGate`
    // also flags WebGPU-fault console prints; its array is folded in below.
    const gateConsoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    // Log failed network requests — helps diagnose 404s where the message
    // only says "Request has failed. Status Code: 404" without a URL.
    page.on("requestfailed", (req) => {
      failedRequests.push(
        `${req.failure()?.errorText ?? "failed"}: ${req.url()}`,
      );
    });
    page.on("response", (resp) => {
      if (resp.status() >= 400) {
        failedRequests.push(`${resp.status()}: ${resp.url()}`);
      }
    });

    await page.goto(`${args.baseUrl}/${urlPath}`, { waitUntil: "load" });

    // Wait up to 45s for __smokeReady to flip (boot + the pixel gate's
    // 15s uniform-canvas deadline + CI scheduling slack). A webgpu-only
    // bundle on a machine without GPU support may trip one of the guards;
    // that's a FAIL that we want to see. On timeout, fall through with
    // ready=false so the page errors / failed requests below still get
    // dumped — a bare TimeoutError hides the actual boot failure.
    let ready = false;
    try {
      const readyState = await page.waitForFunction(
        () => window.__smokeReady,
        null,
        { timeout: 45000 },
      );
      ready = await readyState.jsonValue();
    } catch {
      errors.push("timeout: __smokeReady never flipped within 45s");
    }
    const pageErrors = await page.evaluate(() => window.__smokeErrors || []);
    errors.push(...pageErrors);

    // WebGPU error/crash gate collection. Arm any device that appeared after
    // boot (idempotent), let async GPU errors / device-lost rejections flush
    // (onuncapturederror fires after the queue validates submitted work), then
    // fold uncaptured GPU errors + device-loss + WebGPU-fault console prints
    // into the failure set. For a webgpu variant the gate MUST have armed a
    // device — zero armed means the bundle silently fell back to WebGL, which
    // is itself a smoke failure.
    const gateArm = await armWebGPUDevices(page);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    const gate = await collectGateErrors(page);
    errors.push(...gate.errors);
    if (gate.deviceLost) errors.push(gate.deviceLost);
    errors.push(...gateConsoleErrors);
    if (variant.renderer === "webgpu" && gate.armedDevices === 0) {
      errors.push(
        `webgpu-gate: no WebGPU device was armed (armed=${gateArm.armed} found=${gateArm.found}) — likely a silent fallback to WebGL`,
      );
    }
    console.log(
      `  [debug] webgpu-gate armedDevices=${gate.armedDevices} uncaptured=${gate.errors.length} deviceLost=${gate.deviceLost ? "YES" : "no"} faultConsole=${gateConsoleErrors.length}`,
    );
    // AUDIT_2026_05_02 C.10 — pixel-verification result. `__smokePixelCount`
    // is the number of distinct RGB values sampled from a 5×5 grid on the
    // canvas; under 2 means the pixel-verify gate failed (canvas appears
    // uniform → black canvas / silent fallback).
    const pixelCount = await page.evaluate(
      () => window.__smokePixelCount ?? null,
    );
    const debugInfo = await page.evaluate(() => ({
      cesiumBaseUrl:
        typeof window.CESIUM_BASE_URL !== "undefined"
          ? String(window.CESIUM_BASE_URL)
          : "<unset>",
      setBaseUrlCalled: window.__smokeSetBaseUrlCalled ?? "<never>",
      buildModuleUrlAfterSet: window.__smokeBuildModuleUrlAfterSet ?? "<never>",
      buildModuleUrlNow: (() => {
        try {
          return window.Cesium?.buildModuleUrl
            ? window.Cesium.buildModuleUrl("")
            : "<no buildModuleUrl>";
        } catch (e) {
          return "<throw: " + String(e) + ">";
        }
      })(),
      buildModuleUrlAssets: (() => {
        try {
          return window.Cesium?.buildModuleUrl?.(
            "Assets/approximateTerrainHeights.json",
          );
        } catch (e) {
          return "<throw: " + String(e) + ">";
        }
      })(),
      baseResourceUrl: (() => {
        try {
          return window.Cesium?.buildModuleUrl?.getCesiumBaseUrl?.()?.url;
        } catch (e) {
          return "<throw: " + String(e) + ">";
        }
      })(),
      contextType: (() => {
        try {
          const ctx = window.__viewer?.scene?.context;
          return ctx?.rendererType ?? (ctx?.isWebGPU ? "webgpu?" : "webgl?");
        } catch (e) {
          return "<throw: " + String(e) + ">";
        }
      })(),
      webgpuAvailable: typeof navigator !== "undefined" && !!navigator.gpu,
    }));
    console.log(`  [debug] CESIUM_BASE_URL="${debugInfo.cesiumBaseUrl}"`);
    console.log(
      `  [debug] setBaseUrl called with="${debugInfo.setBaseUrlCalled}"`,
    );
    console.log(
      `  [debug] buildModuleUrl("") right after setBaseUrl="${debugInfo.buildModuleUrlAfterSet}"`,
    );
    console.log(
      `  [debug] buildModuleUrl("") now="${debugInfo.buildModuleUrlNow}"`,
    );
    console.log(
      `  [debug] buildModuleUrl(Assets/approximateTerrainHeights.json)="${debugInfo.buildModuleUrlAssets}"`,
    );
    console.log(
      `  [debug] getCesiumBaseUrl().url="${debugInfo.baseResourceUrl}"`,
    );
    console.log(
      `  [debug] context.rendererType="${debugInfo.contextType}" navigator.gpu=${debugInfo.webgpuAvailable}`,
    );
    console.log(
      `  [debug] pixel-verify distinct samples=${pixelCount ?? "<not run>"}`,
    );

    const status = ready === true && errors.length === 0 ? "PASS" : "FAIL";
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

  // Self-serve unless the caller pointed us at an existing server with
  // --url. The ephemeral-port server makes the smoke test runnable on a
  // bare CI runner with zero server orchestration in the workflow.
  let staticServer = null;
  if (!args.baseUrl) {
    staticServer = await startStaticServer(projectRoot);
    args.baseUrl = staticServer.baseUrl;
    console.log(
      `[variant-smoke-test] self-serving ${projectRoot} at ${args.baseUrl}`,
    );
  }

  let anyFail;
  try {
    const results = [];
    for (const variant of targets) {
      const result = await runVariant(browserType, args, variant);
      results.push(result);
    }

    console.log("\n=== Summary ===");
    for (const r of results) {
      console.log(`  ${r.variant.padEnd(15)}  ${r.status}`);
    }

    anyFail = results.some((r) => r.status !== "PASS");
  } finally {
    staticServer?.server.close();
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
