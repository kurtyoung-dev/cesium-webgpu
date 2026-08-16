// Inspect Cesium's frustumCommandsList ALL pass slots and count
// commands per pass. Tells us which Cesium passes have commands
// (sky/sun in ENVIRONMENT, tiles in GLOBE/3D_TILE, etc.) and which
// are empty.
// @purpose Diagnostic: dumps per-pass command counts from frustumCommandsList on WebGPU (which Cesium passes have commands, which are empty)
// @status ACTIVE

import { chromium } from "playwright";

const URL =
  "http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu";

const browser = await chromium.launch({ headless: true, channel: "msedge" });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.viewer, { timeout: 30_000 });
await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      function tick() {
        if (n++ > 240) r();
        else requestAnimationFrame(tick);
      }
      tick();
    }),
);

const result = await page.evaluate(() => {
  const v = window.viewer;
  const view = v.scene._view;
  const fcl = view?.frustumCommandsList ?? [];
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
  const summary = [];
  for (let f = 0; f < fcl.length; f++) {
    const fc = fcl[f];
    if (!fc) continue;
    const counts = {};
    for (let p = 0; p < fc.commands.length; p++) {
      const cnt = fc.indices[p] ?? 0;
      if (cnt > 0) counts[passNames[p] ?? `pass${p}`] = cnt;
    }
    summary.push({ frustumIdx: f, near: fc.near, far: fc.far, counts });
  }
  // Also dump the raw commandList — every command pushed by every
  // module — so we can see what's THERE before insertIntoBin runs.
  const cmdList = v.scene._frameState?.commandList ?? [];
  const passHistogram = {};
  for (const c of cmdList) {
    const p = c?.pass ?? "(undef)";
    const name = passNames[p] ?? `pass${p}`;
    passHistogram[name] = (passHistogram[name] || 0) + 1;
  }
  // Sample globe-pass commands (from cmdList).
  const globeCmds = cmdList.filter((c) => c.pass === 2 /* Pass.GLOBE */);
  const globeSample = globeCmds.slice(0, 3).map((c) => ({
    hasPipeline: !!c._pipeline || !!c.pipeline,
    hasExecute: typeof c.execute === "function",
    hasBoundingVolume: !!c.boundingVolume,
    bvType: c.boundingVolume?.constructor?.name ?? null,
    bvCenter: c.boundingVolume?.center
      ? [
          c.boundingVolume.center.x,
          c.boundingVolume.center.y,
          c.boundingVolume.center.z,
        ]
      : null,
    bvRadius: c.boundingVolume?.radius ?? null,
    enabled: c.enabled,
    cull: c.cull,
    ownerName: c.owner?.constructor?.name ?? null,
  }));
  return {
    cmdListLength: cmdList.length,
    cmdListPassHistogram: passHistogram,
    perFrustum: summary,
    globeCmdsInList: globeCmds.length,
    globeSample,
    cameraPosition: v.scene.camera?.positionWC
      ? {
          x: v.scene.camera.positionWC.x,
          y: v.scene.camera.positionWC.y,
          z: v.scene.camera.positionWC.z,
        }
      : null,
  };
});

console.log("[probe-pass-counts] result:");
console.log(JSON.stringify(result, null, 2));

await browser.close();
