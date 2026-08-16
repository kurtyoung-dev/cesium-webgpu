#!/usr/bin/env node
// Probe (FQ-3): the JSDoc codemod (Batch 243) silently deleted the `credits`
// and `waterMask` prototype getters from Cesium3DTilesTerrainData while the
// constructor still populates this._credits / this._waterMask. GlobeSurfaceTile
// reads terrainData.waterMask (water-mask texture creation) and
// GlobeSurfaceTileProviderRendering reads terrainData.credits (per-tile terrain
// attribution). Dropping the getters made both read `undefined`, silently
// breaking water rendering for quantized-mesh-as-3D-Tiles terrain and dropping
// legal attribution.
// @purpose Guards the credits/waterMask getters on Cesium3DTilesTerrainData that the B243 JSDoc codemod deleted (water + attribution breakage).
// @status ACTIVE
//
// What it asserts (against the BUILT bundle, in Edge):
//  1. Cesium3DTilesTerrainData.prototype has an own `waterMask` getter.
//  2. Cesium3DTilesTerrainData.prototype has an own `credits` getter.
//  3. HeightmapTerrainData.prototype has both (sanity: the codemod left these
//     alone, so they prove the test methodology is correct).
//  4. A live instance round-trips: constructing with credits/waterMask and
//     reading them back through the public getters returns the stored values.
//
// Usage: node Tools/visual-regression/probe-terraindata-getters.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");

  function getterExists(ctor, name) {
    const d = Object.getOwnPropertyDescriptor(ctor.prototype, name);
    return !!(d && typeof d.get === "function");
  }

  const result = {
    c3dtWaterMaskGetter: getterExists(C.Cesium3DTilesTerrainData, "waterMask"),
    c3dtCreditsGetter: getterExists(C.Cesium3DTilesTerrainData, "credits"),
    heightmapWaterMaskGetter: getterExists(C.HeightmapTerrainData, "waterMask"),
    heightmapCreditsGetter: getterExists(C.HeightmapTerrainData, "credits"),
    roundTrip: null,
  };

  // Live round-trip: a bare instance (no mesh/gltf) — we only read the getters,
  // not createMesh, so the lack of real terrain data is fine. We poke the
  // private fields directly to avoid the heavy gltf-parsing constructor path,
  // then confirm the public getters surface them.
  try {
    const fakeInstance = Object.create(C.Cesium3DTilesTerrainData.prototype);
    const fakeWaterMask = new Uint8Array([255, 0, 128, 64]);
    const fakeCredits = ["credit-a", "credit-b"];
    fakeInstance._waterMask = fakeWaterMask;
    fakeInstance._credits = fakeCredits;
    result.roundTrip =
      fakeInstance.waterMask === fakeWaterMask &&
      fakeInstance.credits === fakeCredits;
  } catch (e) {
    result.roundTrip = `ERROR: ${e.message}`;
  }

  return result;
});

await browser.close();

const checks = [
  ["c3dt waterMask getter exists", out.c3dtWaterMaskGetter === true],
  ["c3dt credits getter exists", out.c3dtCreditsGetter === true],
  [
    "heightmap waterMask getter exists (methodology sanity)",
    out.heightmapWaterMaskGetter === true,
  ],
  [
    "heightmap credits getter exists (methodology sanity)",
    out.heightmapCreditsGetter === true,
  ],
  ["live round-trip through public getters", out.roundTrip === true],
  ["zero console errors", errors.length === 0],
];

let failed = 0;
console.log("FQ-3 terrain-data getter probe");
console.log("==============================");
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log("--- raw ---");
console.log(JSON.stringify(out, null, 2));
if (errors.length) {
  console.log("--- console errors ---");
  for (const e of errors) console.log(e);
}

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
process.exit(0);
