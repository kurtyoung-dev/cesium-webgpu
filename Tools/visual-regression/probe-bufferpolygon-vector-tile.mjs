// probe-bufferpolygon-vector-tile.mjs
// NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT verification (Batch 180).
// @purpose Verifies the us-states vector tileset renders through the BufferPolygon WGSL path on both backends: 52 features, matching geometry bytes.
// @status ACTIVE
//
// Loads the sample-us-states vector tileset on WebGL and WebGPU, frames the
// continental US, captures each canvas, computes a pixel-diff, and reports
// whether the BufferPolygon path produced geometry + rendered pixels.
//
//   node Tools/visual-regression/probe-bufferpolygon-vector-tile.mjs
//
// Expected after the fix: both backends load 52 features with identical
// geometryByteLength and 0 device/console errors. WebGPU draws a clean solid
// US-extent fill (depthCompare "less-equal" wins coplanar ties); WebGL shows
// a z-fight "pinwheel" (default depth func LESS loses ties to the globe), so a
// ~25-30% pixel diff is EXPECTED and is not a regression — see the
// WEBGPU_DEBUGGING_LOG entry for this batch.
import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";
const OUT = "Tools/visual-regression/output";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGE: " + e.message.slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR: " + m.text().slice(0, 160));
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  const info = await page.evaluate(async (base) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.fog.enabled = false;
    let ts;
    try {
      ts = await C.Cesium3DTileset.fromUrl(
        `${base}/Apps/SampleData/vector/sample-us-states.tileset.json`,
      );
      s.primitives.add(ts);
    } catch (e) {
      return { loadError: String(e).slice(0, 200) };
    }
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-98, 39, 5000000),
    });
    // Let tiles stream in + render.
    for (let i = 0; i < 300; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const st = ts.statistics ?? {};
    // Walk the command list, count buffer-primitive owners by class name.
    const cl = s.frameState?.commandList ?? [];
    const owners = {};
    for (const c of cl) {
      const n = c?.owner?.constructor?.name ?? "(none)";
      owners[n] = (owners[n] || 0) + 1;
    }
    return {
      numberOfTilesProcessed: st.numberOfTilesProcessed,
      numberOfFeaturesSelected: st.numberOfFeaturesSelected,
      numberOfPointsSelected: st.numberOfPointsSelected,
      geometryByteLength: st.geometryByteLength,
      ownerTypes: owners,
      commandCount: cl.length,
    };
  }, BASE);
  // Screenshot the canvas only (no UI chrome).
  const canvas = await page.$("canvas");
  const buf = await canvas.screenshot();
  fs.writeFileSync(`${OUT}/_bp-${renderer}.png`, buf);
  await browser.close();
  return { info, errs };
}

const webgl = await run("webgl");
const webgpu = await run("webgpu");

console.log("=== WebGL ===");
console.log(JSON.stringify(webgl.info, null, 1));
console.log("errs:", webgl.errs.length, webgl.errs.slice(0, 3));
console.log("=== WebGPU ===");
console.log(JSON.stringify(webgpu.info, null, 1));
console.log("errs:", webgpu.errs.length, webgpu.errs.slice(0, 3));

// Decode both PNGs to RGBA via a headless canvas and diff.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const diff = await page.evaluate(
  async ([a, b]) => {
    async function decode(dataUrl) {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        d: ctx.getImageData(0, 0, cv.width, cv.height).data,
        w: cv.width,
        h: cv.height,
      };
    }
    const A = await decode(a);
    const B = await decode(b);
    const n = Math.min(A.d.length, B.d.length);
    let mism = 0,
      total = 0;
    for (let i = 0; i < n; i += 4) {
      total++;
      const dr = Math.abs(A.d[i] - B.d[i]);
      const dg = Math.abs(A.d[i + 1] - B.d[i + 1]);
      const db = Math.abs(A.d[i + 2] - B.d[i + 2]);
      if (dr + dg + db > 60) mism++;
    }
    return { mismatchPct: ((mism / total) * 100).toFixed(2), w: A.w, h: A.h };
  },
  [
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_bp-webgl.png`).toString("base64"),
    "data:image/png;base64," +
      fs.readFileSync(`${OUT}/_bp-webgpu.png`).toString("base64"),
  ],
);
await browser.close();
console.log("=== DIFF ===");
console.log(JSON.stringify(diff));
