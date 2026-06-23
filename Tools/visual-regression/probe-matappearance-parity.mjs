// NEW-MATAPPEARANCE-DIFFUSE-PARITY verification.
//
// Renders a LIT MaterialAppearance extruded polygon (top face + side walls →
// varied normals) on WebGL and WebGPU with the globe/sky hidden + sun ON, and
// compares brightness over the primitive pixels. The fork's WGSL *Lit shaders
// used an ad-hoc lighting block (scalar ambient 0.15 + actual-sun-dir diffuse)
// instead of WebGL czm_phong (material.diffuse*0.5 ambient + diffuse from FIXED
// eye-space dirs (0,0,1)+(0,1,0)), so WebGPU rendered noticeably darker.
//
// Gate (FLAT Color material — a clean test of the czm_phong LIGHTING fix):
// WebGPU mean luminance over the primitive matches WebGL within 12%, AND the
// top-vs-bottom brightness ratio matches (the directional-diffuse fix —
// czm_phong's fixed top-down light shades top vs side faces the same way on
// both backends). Grid is captured INFORMATIONALLY only: its grid LINES don't
// render on WebGPU (a SEPARATE pre-existing material-pattern bug — the
// pattern, not the lighting — so it would confound a lighting gate). One fresh
// page per capture (WebGPU swapchain detaches the canvas across in-page reads).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-matappearance-parity.mjs
import { chromium } from "playwright";
import zlib from "zlib";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function capture(renderer, materialType) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ materialType }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;

      // Isolate the primitive: hide globe + sky, black background.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.sun.show = false;
      scene.backgroundColor = C.Color.BLACK;
      for (const sel of [
        ".cesium-viewer-toolbar", ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer", ".cesium-viewer-bottom",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
      }

      const lon = -75, lat = 40;
      // Extruded polygon → a bright top face (normal up) + darker side walls
      // (horizontal normals). The directional-diffuse difference shows here.
      const prim = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              C.Cartesian3.fromDegreesArray([
                lon - 0.002, lat - 0.002, lon + 0.002, lat - 0.002,
                lon + 0.002, lat + 0.002, lon - 0.002, lat + 0.002,
              ]),
            ),
            height: 0, extrudedHeight: 400,
            vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType(materialType),
          translucent: false,
          // flat defaults to false → czm_phong lighting (the path under test).
        }),
        asynchronous: false,
      });
      scene.primitives.add(prim);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat - 0.006, 700),
        orientation: { heading: 0, pitch: C.Math.toRadians(-35), roll: 0 },
      });

      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-mat", "1");
      return { rendererType: scene.context.rendererType };
    },
    { materialType },
  );

  const png = await page.locator('canvas[data-mat="1"]').screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return { rendererType: info.rendererType, consoleErrors, png, decoded };
}

// Mean luminance over the lit (non-black) primitive pixels.
function stats(img) {
  let sum = 0, n = 0, topSum = 0, topN = 0, botSum = 0, botN = 0;
  const half = (img.h / 2) | 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (lum <= 12) continue;
      sum += lum; n++;
      if (y < half) { topSum += lum; topN++; } else { botSum += lum; botN++; }
    }
  }
  return {
    primPx: n,
    meanLum: n ? +(sum / n).toFixed(2) : 0,
    topMean: topN ? +(topSum / topN).toFixed(2) : 0,
    botMean: botN ? +(botSum / botN).toFixed(2) : 0,
  };
}

// ── PNG encoder (zlib stored deflate) — zero external dep ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function encodePNG({ w, h, data }) {
  const bpr = w * 4, raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (bpr + 1)] = 0; Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(raw, y * (bpr + 1) + 1); }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0); const tb = Buffer.from(type, "ascii"); const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0); return Buffer.concat([len, tb, body, cb]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

const MATERIALS = [
  { type: "Color", gate: true }, // flat → clean lighting test (GATED)
  { type: "Grid", gate: false }, // patterned → grid lines don't render on WebGPU (separate bug), informational
];
const report = {};
let pass = true;
for (const m of MATERIALS) {
  const mat = m.type;
  const wgpu = await capture("webgpu", mat);
  const wgl = await capture("webgl", mat);
  fs.writeFileSync(`Tools/visual-regression/output/matparity-${mat}-webgpu.png`, encodePNG(wgpu.decoded));
  fs.writeFileSync(`Tools/visual-regression/output/matparity-${mat}-webgl.png`, encodePNG(wgl.decoded));
  const sgpu = stats(wgpu.decoded), sgl = stats(wgl.decoded);
  const lumPct = sgl.meanLum ? +((100 * (sgpu.meanLum - sgl.meanLum)) / sgl.meanLum).toFixed(2) : null;
  const gpuTopBot = sgpu.botMean ? +(sgpu.topMean / sgpu.botMean).toFixed(3) : 0;
  const glTopBot = sgl.botMean ? +(sgl.topMean / sgl.botMean).toFixed(3) : 0;
  const within = lumPct !== null && Math.abs(lumPct) < 12 &&
    Math.abs(gpuTopBot - glTopBot) < 0.15 && wgpu.consoleErrors.length === 0;
  if (m.gate && !within) pass = false;
  report[mat] = {
    gated: m.gate, webgpu: sgpu, webgl: sgl, lumPct,
    topBotRatio: { webgpu: gpuTopBot, webgl: glTopBot },
    gpuConsoleErrors: wgpu.consoleErrors.slice(0, 3),
  };
}

console.log(JSON.stringify(report, null, 2));
console.log("NOTE: Grid is informational — its grid LINES don't render on WebGPU (separate pre-existing material-pattern bug, not the lighting fix).");
console.log(pass ? "GATE PASS — WebGPU lit MaterialAppearance (flat Color) brightness + directional shading match WebGL" : "GATE FAIL — WebGPU lit MaterialAppearance brightness diverges from WebGL");
process.exit(pass ? 0 : 1);
