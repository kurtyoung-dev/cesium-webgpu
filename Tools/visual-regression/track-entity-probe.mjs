#!/usr/bin/env node
/**
 * Probe `viewer.trackedEntity` behavior on WebGPU vs WebGL using the
 * cross-backend runner's exact patching strategy + HTML rewrite for
 * WebGPU (sync `new Viewer` -> `await Viewer.createAsync`).
 *
 * Reports model load state, camera position, and trackedEntity state
 * at multiple time points to diagnose why the camera doesn't fly.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const URL = `${BASE}/Apps/Sandcastle/gallery/3D%20Models.html`;

const SHIM = `(function() {
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
    if (typeof OriginalCreateAsync === "function") {
      PatchedViewer.createAsync = function (container, options) {
        return OriginalCreateAsync.call(Original, container, patchOptions(options || {})).then(captureViewer);
      };
    }
    return new Proxy(C, {
      get(target, prop) {
        if (prop === "Viewer") return PatchedViewer;
        if (prop === "__rendererPatchInstalled") return true;
        return target[prop];
      },
    });
  }
  let _cesium;
  Object.defineProperty(window, "Cesium", {
    configurable: true, enumerable: true,
    get() { return _cesium; },
    set(val) {
      _cesium = buildPatchedNamespace(val);
      Object.defineProperty(window, "Cesium", {
        value: _cesium, writable: true, configurable: true, enumerable: true,
      });
    },
  });
  let _startup, _startupPromise = null;
  Object.defineProperty(window, "startup", {
    configurable: true, enumerable: true,
    get() { return _startup; },
    set(val) {
      if (typeof val === "function") {
        _startup = function (_origC, ...rest) {
          const result = val.call(this, window.Cesium, ...rest);
          if (!_startupPromise && result && typeof result.then === "function") {
            _startupPromise = result;
          }
          return result;
        };
      } else { _startup = val; }
    },
  });
  // Defer Sandcastle.finishedLoading until startup resolves (matches the
  // cross-backend runner). Without this, async startup (WebGPU's
  // createAsync) loses its defaultAction.
  let _finishedLoadingCalled = false, _finishedLoadingPending = false, _origFinishedLoading = null;
  function runFinishedLoading() {
    if (_finishedLoadingCalled || !_origFinishedLoading) return;
    _finishedLoadingCalled = true;
    try { _origFinishedLoading.call(window.Sandcastle); } catch (e) {}
  }
  function deferFinishedLoading() {
    if (_finishedLoadingPending || _finishedLoadingCalled) return;
    _finishedLoadingPending = true;
    function tryChain(remaining) {
      if (_startupPromise) {
        Promise.resolve(_startupPromise).then(() => Promise.resolve()).then(runFinishedLoading).catch(runFinishedLoading);
        return;
      }
      if (remaining <= 0) { runFinishedLoading(); return; }
      Promise.resolve().then(() => tryChain(remaining - 1));
    }
    tryChain(20);
  }
  function patchSandcastle() {
    const SC = window.Sandcastle;
    if (!SC || _origFinishedLoading) return;
    console.log("[probe] patchSandcastle running");
    _origFinishedLoading = SC.finishedLoading;
    SC.finishedLoading = function () {
      console.log("[probe] finishedLoading called, hasStartup=" + (!!_startup) + " hasStartupPromise=" + (!!_startupPromise));
      if (_startupPromise || typeof _startup === "function") {
        deferFinishedLoading();
        return;
      }
      _origFinishedLoading.call(SC);
      _finishedLoadingCalled = true;
    };
  }
  function tryPatch() {
    if (window.Sandcastle) patchSandcastle();
    else requestAnimationFrame(tryPatch);
  }
  tryPatch();
})();`;

async function probe(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.text().startsWith("[probe]")) console.log(`  [${renderer}] ${m.text()}`);
  });

  await page.addInitScript((r) => { window.__FORCED_RENDERER__ = r; }, renderer);
  await page.addInitScript({ content: SHIM });

  // For WebGPU runs, rewrite the demo's HTML on the wire
  if (renderer === "webgpu") {
    await page.route("**/Apps/Sandcastle/gallery/**.html", async (route) => {
      const response = await route.fetch();
      const original = await response.text();
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

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".cesium-widget canvas");
      return c && c.width > 0 && c.height > 0;
    },
    { timeout: 60_000 },
  );

  // Snapshot every 2 seconds for 12 seconds
  const snapshots = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => {
      const v = window.__capturedViewer;
      if (!v) return {
        error: "no viewer",
        hasGlobalCesium: typeof window.Cesium !== "undefined",
        hasGlobalViewer: typeof window.viewer !== "undefined",
        hasGlobalStartup: typeof window.startup === "function",
        startupCalled: !!window.startupCalled,
      };
      const cam = v.scene.camera;
      const ent = v.trackedEntity;
      let bsState = null;
      if (ent) {
        try {
          const ds = v._cesiumWidget._dataSourceDisplay;
          const sphere = new Cesium.BoundingSphere();
          bsState = ds.getBoundingSphere(ent, false, sphere);
        } catch (e) {}
      }
      return {
        rendererType: v.scene.context?.rendererType,
        entityCount: v.entities.values.length,
        hasTrackedEntity: !!ent,
        trackedEntityName: ent?.name,
        bsState,
        cameraHeight: cam.positionCartographic?.height?.toFixed(0),
        cameraPos: `(${cam.position.x.toFixed(0)}, ${cam.position.y.toFixed(0)}, ${cam.position.z.toFixed(0)})`,
        needTrackedEntityUpdate: v._cesiumWidget._needTrackedEntityUpdate,
      };
    });
    snapshots.push({ t: 2 * (i + 1), state: s });
  }

  await browser.close();
  return { renderer, snapshots, errors };
}

const wg = await probe("webgl");
const wp = await probe("webgpu");

for (const r of [wg, wp]) {
  console.log(`\n=== ${r.renderer} ===`);
  for (const snap of r.snapshots) {
    console.log(`  t=${snap.t}s:`, JSON.stringify(snap.state));
  }
  if (r.errors.length > 0) {
    console.log(`  errors (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 6)) console.log(`    ${e.substring(0, 200)}`);
  }
}
