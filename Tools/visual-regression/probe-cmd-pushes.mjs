// Hook frameState.commandList.push to count pushes by pass over the
// course of a test run.
// @purpose Diagnostic: hooks frameState.commandList.push and tallies command pushes by pass over a settle window on the WebGPU viewer.
// @status ACTIVE
//
import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

// Hook commandList specifically via Object.defineProperty
await page.evaluate(() => {
  globalThis.__dbgPassPushes = {};
  globalThis.__dbgTotalPushes = 0;
  globalThis.__dbgAnyPushes = 0;
  const v = window.viewer;
  const fs = v.scene._frameState;
  const arr = fs.commandList;
  // Store ref
  globalThis.__dbgCmdListRef = arr;
  // Override push on the SPECIFIC instance using defineProperty
  // (so defaults to inherited Array.prototype.push initially)
  Object.defineProperty(arr, "push", {
    value: function (...items) {
      globalThis.__dbgAnyPushes += items.length;
      for (const it of items) {
        const p = it?.pass ?? "(undef)";
        globalThis.__dbgPassPushes[p] =
          (globalThis.__dbgPassPushes[p] || 0) + 1;
        globalThis.__dbgTotalPushes++;
      }
      return Array.prototype.push.apply(this, items);
    },
    writable: true,
    configurable: true,
  });
  return true;
});

await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      (function tick() {
        if (n++ > 240) r();
        else requestAnimationFrame(tick);
      })();
    }),
);

const result = await page.evaluate(() => {
  const passNames = [
    "ENVIRONMENT",
    "COMPUTE",
    "GLOBE",
    "TERRAIN_CLASSIFICATION",
    "CESIUM_3D_TILE_EDGES",
    "CESIUM_3D_TILE",
    "CESIUM_3D_TILE_CLASSIFICATION",
    "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
    "OPAQUE",
    "TRANSLUCENT",
    "VOXELS",
    "GAUSSIAN_SPLATS",
    "OVERLAY",
  ];
  const pushes = globalThis.__dbgPassPushes ?? {};
  const named = {};
  for (const k of Object.keys(pushes)) {
    const idx = parseInt(k);
    named[passNames[idx] ?? `pass${k}`] = pushes[k];
  }
  // Inspect the actual items in commandList
  const cmdList = window.viewer.scene._frameState.commandList;
  const _items = cmdList.map((c) => ({
    keys: Object.keys(c).slice(0, 15),
    pass: c.pass,
    passType: typeof c.pass,
    owner: c.owner?.constructor?.name ?? null,
    hasExecute: typeof c.execute === "function",
    hasPipeline: !!c.pipeline,
    hasPipeline_: !!c._pipeline,
  }));
  // Look at views — Cesium has scene._defaultView and scene._views
  const scene = window.viewer.scene;
  const views = scene._views ?? [];
  const viewSummary = views.map((v, i) => ({
    idx: i,
    hasCommandList: !!v.commandList,
    commandListLength: v.commandList?.length ?? -1,
  }));
  return {
    totalPushes: globalThis.__dbgTotalPushes,
    anyPushes: globalThis.__dbgAnyPushes,
    byPass: named,
    actualCommandListLength: cmdList.length,
    isSameRef: cmdList === globalThis.__dbgCmdListRef,
    pushIsCustom: cmdList.push !== Array.prototype.push,
    sceneFrameState_eq_lower: scene.frameState === scene._frameState,
    viewSummary,
    defaultViewCmdLength: scene._defaultView?.commandList?.length,
  };
});

console.log("[probe-cmd-pushes] result:");
console.log(JSON.stringify(result, null, 2));
await browser.close();
