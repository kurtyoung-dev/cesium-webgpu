// C10-02 pixel + drillPick oracle.
// Loads BatchedWithBatchTable, frames it tightly (globe off, black bg), and
// per mode captures a cropped PNG of the building region + pixel stats.
//   RENDERER=webgpu|webgl   MODE=unstyled|subset|all   TAG=<suffix>
// For MODE=subset/all it also runs a drillPick at the building center and
// reports the resolved feature (INV-5).
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.RENDERER || "webgpu";
const MODE = process.env.MODE || "unstyled";
const TAG = process.env.TAG || `${RENDERER}-${MODE}`;
const TS =
  "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=default"],
});
const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const GLOBE = process.env.GLOBE === "1";
const result = await page.evaluate(
  async ({ TS, MODE, GLOBE }) => {
    if (GLOBE) globalThis.__C10_GLOBE_ON__ = true;
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const GLOBE_ON = globalThis.__C10_GLOBE_ON__ === true;
    scene.globe.show = GLOBE_ON;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.BLACK;
    // Force eager rendering so the pick pass always has a fresh depth/pick FBO.
    scene.requestRenderMode = false;

    async function render(n) {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    const ts = await C.Cesium3DTileset.fromUrl(TS);
    scene.primitives.add(ts);
    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (ts.tilesLoaded) break;
    }
    // Frame the building centered and large via an offset from the bounding
    // sphere (pitch -25 so faces are visible, close in for a big footprint).
    const bs = ts.boundingSphere;
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0, -C.Math.toRadians(25), bs.radius * 2.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (ts.tilesLoaded) break;
    }
    await render(25);

    // Apply style.
    function content() {
      for (const tile of ts._selectedTiles || []) {
        const m = tile.content && tile.content._model;
        if (m && m.featureTables && m.featureTables.length)
          return tile.content;
      }
      return null;
    }
    const ct = content();
    const n = ct ? ct.featuresLength : 0;
    if (ct && MODE === "subset") {
      for (let i = 0; i < n; i++) {
        const f = ct.getFeature(i);
        if (f)
          f.color =
            i % 2 === 0
              ? C.Color.fromBytes(255, 0, 0, 102)
              : C.Color.fromBytes(255, 255, 255, 255);
      }
    } else if (ct && MODE === "all") {
      for (let i = 0; i < n; i++) {
        const f = ct.getFeature(i);
        if (f) f.color = C.Color.fromBytes(0, 255, 0, 102);
      }
    }
    await render(20);

    // Pixel stats over the whole canvas.
    const canvas = scene.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let nonBlack = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let redPix = 0;
    let greenPix = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r + g + b > 20) {
        nonBlack++;
        rSum += r;
        gSum += g;
        bSum += b;
        if (r > g + 30 && r > b + 30) redPix++;
        if (g > r + 30 && g > b + 30) greenPix++;
      }
    }

    // drillPick (INV-5): scan CSS-pixel grid across the frame for a building.
    let drill = null;
    {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || w / dpr;
      const cssH = canvas.clientHeight || h / dpr;
      let hit = null;
      for (let yy = 0.15; yy <= 0.85 && !hit; yy += 0.025) {
        for (let xx = 0.15; xx <= 0.85 && !hit; xx += 0.025) {
          const p = new C.Cartesian2(cssW * xx, cssH * yy);
          const picked = scene.pick(p);
          if (picked) hit = { p: { x: p.x, y: p.y }, picked };
        }
      }
      if (hit) {
        const picks = scene.drillPick(new C.Cartesian2(hit.p.x, hit.p.y));
        drill = {
          pickPos: [Math.round(hit.p.x), Math.round(hit.p.y)],
          pickedType: hit.picked?.constructor?.name || null,
          pickedIsFeature: (hit.picked?.constructor?.name || "").includes(
            "Feature",
          ),
          drillCount: picks.length,
          drillTypes: picks.map((p) => p?.constructor?.name || null),
          featureIds: picks.map((p) =>
            typeof p?.featureId === "number" ? p.featureId : null,
          ),
        };
      } else {
        drill = { note: "no building pixel found under scan grid" };
      }
    }

    return {
      mode: MODE,
      renderer: scene.context.rendererType,
      w,
      h,
      nonBlack,
      meanR: nonBlack ? +(rSum / nonBlack).toFixed(1) : 0,
      meanG: nonBlack ? +(gSum / nonBlack).toFixed(1) : 0,
      meanB: nonBlack ? +(bSum / nonBlack).toFixed(1) : 0,
      redPix,
      greenPix,
      featuresLength: n,
      drill,
    };
  },
  { TS, MODE, GLOBE },
);

console.log(JSON.stringify(result, null, 2));
if (errors.length)
  console.log("ERRORS:", JSON.stringify(errors.slice(0, 6), null, 2));
const buf = await page.screenshot();
fs.writeFileSync(`Tools/visual-regression/output/probe-c10-02-${TAG}.png`, buf);
console.log(`PNG: probe-c10-02-${TAG}.png (${buf.length} bytes)`);
await browser.close();
