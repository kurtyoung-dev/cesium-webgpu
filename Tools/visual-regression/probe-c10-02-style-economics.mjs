// C10-02-TILES-STYLE-COMMAND-ECONOMICS diagnostic probe.
//
// Answers three questions with runtime evidence on the WebGPU backend:
//   (T-3) Is BatchTexture.translucentFeaturesLength maintained on the WebGPU path
//         when a style makes features translucent?  (highest-risk premise)
//   (GATE) What is model.styleCommandsNeeded for a NEVER-styled b3dm batch-table
//         tile at steady state — undefined or ALL_OPAQUE(0)?  (decides the gate
//         formula polarity for INV-1 / INV-6)
//   (COUNTS) Per-scenario tile-content command counts + Pass.TRANSLUCENT count:
//         unstyled / subset-translucent / all-translucent.
//
// Also renders each scenario to a PNG for the pixel oracle.
//
// Usage: node Tools/visual-regression/probe-c10-02-style-economics.mjs
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TS =
  "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=default"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error") errors.push(t);
  if (t.startsWith("PROBE:")) console.log(t);
});
page.on("pageerror", (e) => errors.push(String(e)));

const renderer = process.env.RENDERER || "webgpu";
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const result = await page.evaluate(
  async ({ TS }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const Pass = C.Pass;
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.BLACK;

    // Hook PVS to snapshot the fully-populated commandList each frame.
    const view = scene._view;
    const origPVS = view.createPotentiallyVisibleSet.bind(view);
    let snap = null;
    view.createPotentiallyVisibleSet = function (s) {
      const cl = scene.frameState.commandList;
      let tileTotal = 0;
      let tileTranslucent = 0;
      let tileOpaque = 0;
      const passHist = {};
      for (const cmd of cl) {
        const owner = cmd && cmd.owner;
        const isModel =
          owner && owner.constructor && owner.constructor.name === "Model";
        if (!isModel) continue;
        tileTotal++;
        const p = cmd.pass;
        passHist[p] = (passHist[p] | 0) + 1;
        if (p === Pass.TRANSLUCENT) tileTranslucent++;
        else tileOpaque++;
      }
      snap = { tileTotal, tileTranslucent, tileOpaque, passHist };
      return origPVS(s);
    };

    async function render(n) {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    const ts = await C.Cesium3DTileset.fromUrl(TS);
    scene.primitives.add(ts);
    await ts.readyPromise?.catch?.(() => {});
    // Frame the tileset.
    const bs = ts.boundingSphere;
    const cart = C.Cartographic.fromCartesian(bs.center);
    v.camera.setView({
      destination: C.Cartesian3.fromRadians(
        cart.longitude,
        cart.latitude,
        cart.height + bs.radius * 3.0,
      ),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
    // Load tiles.
    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (ts.tilesLoaded) break;
    }
    await render(20);

    function collectContent() {
      // Return the first selected tile-content Model + its feature table info.
      const tiles = ts._selectedTiles || [];
      for (const tile of tiles) {
        const content = tile.content;
        const model = content && content._model;
        if (model && model.featureTables && model.featureTables.length) {
          const ftId = model.featureTableId;
          const ft = model.featureTables[ftId];
          return { model, content, ft };
        }
      }
      return null;
    }

    function inspect(label) {
      const info = collectContent();
      let scn = "NO_MODEL";
      let translucentFeaturesLength = null;
      let featuresLength = null;
      if (info) {
        scn = info.model.styleCommandsNeeded;
        // Normalize undefined to a sentinel string so JSON preserves it.
        if (typeof scn === "undefined") scn = "UNDEFINED";
        translucentFeaturesLength =
          info.ft.batchTexture.translucentFeaturesLength;
        featuresLength = info.ft.featuresLength;
      }
      return {
        label,
        styleCommandsNeeded: scn,
        translucentFeaturesLength,
        featuresLength,
        counts: snap ? { ...snap } : null,
      };
    }

    function screenshotSample() {
      const canvas = scene.canvas;
      const c2 = document.createElement("canvas");
      c2.width = canvas.width;
      c2.height = canvas.height;
      const ctx = c2.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const w = canvas.width;
      const h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      let nonBlack = 0;
      let rSum = 0;
      let aSemi = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = data[i] + data[i + 1] + data[i + 2];
        if (lum > 15) nonBlack++;
        rSum += data[i];
      }
      return { w, h, nonBlack, meanR: +(rSum / (w * h)).toFixed(2) };
    }

    // ---- Scenario 1: UNSTYLED (default) ----
    await render(8);
    const unstyled = inspect("unstyled");
    const unstyledPix = screenshotSample();

    // ---- Scenario 2: SUBSET translucent (even features alpha 0.4) ----
    const info = collectContent();
    let applied = "NO_CONTENT";
    if (info) {
      const n = info.ft.featuresLength;
      for (let i = 0; i < n; i++) {
        const f = info.content.getFeature(i);
        if (!f) continue;
        f.color =
          i % 2 === 0
            ? C.Color.fromBytes(255, 0, 0, 102) // alpha 0.4
            : C.Color.fromBytes(255, 255, 255, 255);
      }
      applied = `subset over ${n} features`;
    }
    await render(8);
    const subset = inspect("subset-translucent");
    const subsetPix = screenshotSample();

    // ---- Scenario 3: ALL translucent ----
    if (info) {
      const n = info.ft.featuresLength;
      for (let i = 0; i < n; i++) {
        const f = info.content.getFeature(i);
        if (!f) continue;
        f.color = C.Color.fromBytes(0, 255, 0, 102);
      }
    }
    await render(8);
    const allTrans = inspect("all-translucent");
    const allTransPix = screenshotSample();

    // ---- Scenario 4: CLEAR style back to opaque (INV-4) ----
    if (info) {
      const n = info.ft.featuresLength;
      for (let i = 0; i < n; i++) {
        const f = info.content.getFeature(i);
        if (!f) continue;
        f.color = C.Color.fromBytes(255, 255, 255, 255);
      }
    }
    await render(8);
    const cleared = inspect("cleared-back-to-opaque");

    return {
      renderer: scene.context.rendererType || "unknown",
      isWebGPU: !!scene.context.isWebGPU,
      appliedNote: applied,
      unstyled,
      unstyledPix,
      subset,
      subsetPix,
      allTrans,
      allTransPix,
      cleared,
    };
  },
  { TS },
);

console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log("CONSOLE_ERRORS:", JSON.stringify(errors.slice(0, 8), null, 2));
const buf = await page.screenshot();
fs.writeFileSync(
  `Tools/visual-regression/output/probe-c10-02-${renderer}.png`,
  buf,
);
console.log("PNG bytes:", buf.length);
await browser.close();
