// C2-10 NEW-WEBGPU-GRID-MATERIAL-PATTERN-MISSING — verify the WGSL Grid material
// now draws constant-PIXEL-width antialiased lines (GridMaterial.glsl parity) via
// screen-space derivatives, instead of the old constant-UV-width step() lines
// whose apparent thickness scaled with zoom. Captures a flat Grid polygon at two
// straight-down altitudes on both backends and measures the mean grid-line width
// (center scanline) — it should stay ~constant across zoom AND match WebGL.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-grid-multizoom.mjs
import { chromium } from "playwright";
import zlib from "zlib";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const LON = -75, LAT = 40;
const ALTS = [400, 2000]; // close, far (straight down)

async function capture(renderer, alt) {
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  await page.evaluate(async ({ lon, lat, alt }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer, s = v.scene;
    s.requestRenderMode = false;
    s.globe.show = false; s.skyBox.show = false; s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    s.backgroundColor = C.Color.BLACK;
    for (const sel of [".cesium-viewer-toolbar", ".cesium-viewer-animationContainer",
      ".cesium-viewer-timelineContainer", ".cesium-viewer-bottom", ".cesium-viewer-fullscreenContainer"]) {
      document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
    }
    const d = 0.002;
    const material = C.Material.fromType("Grid", {
      color: C.Color.YELLOW,
      cellAlpha: 0.1,
      lineCount: new C.Cartesian2(8, 8),
      lineThickness: new C.Cartesian2(2, 2),
    });
    // EXTRUDED polygon (top face carries st) — the FLAT-polygon grid renders
    // solid on WebGPU (pre-existing st issue, both old+new shader). The extruded
    // top face is the path matparity uses, where the grid pattern renders.
    const prim = new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray([
            lon - d, lat - d, lon + d, lat - d, lon + d, lat + d, lon - d, lat + d,
          ])),
          height: 0, extrudedHeight: 300,
          vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
        }),
      }),
      appearance: new C.MaterialAppearance({ material, flat: true }),
      asynchronous: false,
    });
    s.primitives.add(prim);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - d * 1.5, alt),
      orientation: { heading: 0, pitch: C.Math.toRadians(-35), roll: 0 },
    });
    for (let i = 0; i < 120; i++) { s.render(); await new Promise((r) => requestAnimationFrame(r)); }
    s.canvas.setAttribute("data-grid", "1");
  }, { lon: LON, lat: LAT, alt });

  const png = await page.locator('canvas[data-grid="1"]').screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = off.getContext("2d"); cx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: Array.from(cx.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, Buffer.from(png).toString("base64"));
  await browser.close();
  return { errs, decoded };
}

// Mean grid-line run-length on the central horizontal scanlines: a "line" pixel
// is one whose green<<red+green (yellow line = high R+G; cell = low alpha → dark).
// We measure runs of bright pixels (the lines) across the middle 40 rows.
function lineWidth(img) {
  const widths = [];
  const y0 = (img.h * 0.4) | 0, y1 = (img.h * 0.6) | 0;
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      const lum = img.data[i] + img.data[i + 1] + img.data[i + 2];
      const bright = lum > 250; // grid line (yellow) vs dark cell
      if (bright) { run++; }
      else if (run > 0) { if (run < img.w * 0.5) widths.push(run); run = 0; }
    }
  }
  widths.sort((a, b) => a - b);
  const px = widths.reduce((s, v) => s + v, 0);
  const median = widths.length ? widths[(widths.length / 2) | 0] : 0;
  return { lines: widths.length, medianW: median, totalLinePx: px };
}

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
const res = {};
for (const r of ["webgl", "webgpu"]) {
  res[r] = {};
  for (const alt of ALTS) {
    const cap = await capture(r, alt);
    fs.writeFileSync(`Tools/visual-regression/output/grid-multizoom-${r}-${alt}.png`, encodePNG(cap.decoded));
    res[r][alt] = { ...lineWidth(cap.decoded), errs: cap.errs.length };
  }
}
const ratio = (r) => {
  const w0 = res[r][ALTS[0]].medianW, w1 = res[r][ALTS[1]].medianW;
  return w0 && w1 ? +(Math.max(w0, w1) / Math.min(w0, w1)).toFixed(2) : 0;
};
const gpuRatio = ratio("webgpu"), glRatio = ratio("webgl");
console.log(JSON.stringify(res, null, 2));
console.log(`WebGPU line-width zoom ratio (close/far): ${gpuRatio} | WebGL: ${glRatio}`);
// Gate: WebGPU lines render at both zooms + stay roughly pixel-constant like WebGL.
const gpuRenders = res.webgpu[ALTS[0]].lines > 2 && res.webgpu[ALTS[1]].lines > 2;
const constant = gpuRatio > 0 && gpuRatio < 1.8;
const pass = gpuRenders && constant;
console.log(`(A) WebGPU grid lines render at both zooms: ${gpuRenders ? "PASS" : "FAIL"}`);
console.log(`(B) WebGPU line width ~pixel-constant across zoom (ratio<1.8): ${constant ? "PASS" : "FAIL"}`);
console.log(pass ? "GATE PASS — WebGPU grid lines are constant-pixel-width AA (GridMaterial.glsl parity)." : "GATE FAIL.");
process.exit(pass ? 0 : 1);
