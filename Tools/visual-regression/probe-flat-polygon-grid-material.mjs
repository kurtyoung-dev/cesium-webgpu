// Q4 C4-FLAT-MATAPPEARANCE-POLYGON-SOLID — a flat (height-0, non-extruded)
// PolygonGeometry with a MaterialAppearance Grid material must render the GRID
// PATTERN on WebGPU, matching WebGL. The reported bug: WebGPU renders a SOLID
// fill (st/texcoord never generated → grid math degenerates to a constant).
//
// The probe captures two primitives per backend:
//   (A) a FLAT polygon (height 0, no extrudedHeight) with a Grid material
//   (B) an EXTRUDED polygon (extrudedHeight) with a Grid material — top face
//       must STAY green (off-gate: don't regress the extruded path).
// It measures a "pattern score" = stddev of per-pixel luminance across the
// filled region. A grid pattern has HIGH stddev; a solid fill has ~0 stddev.
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-flat-polygon-grid-material.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function capture(renderer, extruded) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  await page.evaluate(
    async ({ extruded }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.requestRenderMode = false;
      s.globe.show = false;
      s.skyBox.show = false;
      s.skyAtmosphere.show = false;
      if (s.sun) s.sun.show = false;
      s.backgroundColor = C.Color.BLACK;
      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document
          .querySelectorAll(sel)
          .forEach((e) => (e.style.display = "none"));
      }
      const rect = C.Rectangle.fromDegrees(-30, -30, 30, 30);
      const appearance = new C.MaterialAppearance({
        material: C.Material.fromType("Grid", {
          color: C.Color.YELLOW,
          cellAlpha: 0.1,
          lineCount: new C.Cartesian2(8, 8),
          lineThickness: new C.Cartesian2(2.0, 2.0),
        }),
        flat: true,
      });
      const geomOpts = {
        polygonHierarchy: new C.PolygonHierarchy(
          C.Cartesian3.fromDegreesArray([-30, -30, 30, -30, 30, 30, -30, 30]),
        ),
        vertexFormat: appearance.vertexFormat,
      };
      if (extruded) {
        geomOpts.extrudedHeight = 500000.0;
        geomOpts.height = 0.0;
      }
      const instance = new C.GeometryInstance({
        geometry: new C.PolygonGeometry(geomOpts),
      });
      const prim = new C.Primitive({
        geometryInstances: instance,
        appearance,
        asynchronous: false,
      });
      s.primitives.add(prim);
      v.camera.setView({ destination: rect });
      for (let i = 0; i < 120; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { extruded },
  );

  const decoded = await page.evaluate(async () => {
    const v = window.viewer;
    const b64 = await new Promise((res) => {
      const rm = v.scene.postRender.addEventListener(() => {
        rm();
        try {
          res(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          res(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = off.getContext("2d");
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d), b64 };
  });
  await browser.close();
  return { errs, decoded };
}

function patternScore(img) {
  // Luminance stddev across the non-black (filled) region. A grid pattern has
  // real spatial variation (lines vs cells → high stddev); a solid fill is ~0.
  const lum = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const R = img.data[i],
      G = img.data[i + 1],
      B = img.data[i + 2];
    if (R + G + B <= 24) continue;
    lum.push(0.299 * R + 0.587 * G + 0.114 * B);
  }
  const n = lum.length;
  if (n === 0) return { px: 0, mean: 0, std: 0 };
  const mean = lum.reduce((a, b) => a + b, 0) / n;
  const varr = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { px: n, mean: +mean.toFixed(1), std: +Math.sqrt(varr).toFixed(2) };
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

const results = {};
for (const [label, extruded] of [
  ["flat", false],
  ["extruded", true],
]) {
  const wgpu = await capture("webgpu", extruded);
  const wgl = await capture("webgl", extruded);
  if (wgpu.decoded?.b64)
    fs.writeFileSync(
      `Tools/visual-regression/output/flatgrid-${label}-webgpu.png`,
      Buffer.from(wgpu.decoded.b64, "base64"),
    );
  if (wgl.decoded?.b64)
    fs.writeFileSync(
      `Tools/visual-regression/output/flatgrid-${label}-webgl.png`,
      Buffer.from(wgl.decoded.b64, "base64"),
    );
  results[label] = {
    webgpu: { ...patternScore(wgpu.decoded), errs: wgpu.errs.slice(0, 3) },
    webgl: patternScore(wgl.decoded),
  };
}

console.log(JSON.stringify(results, null, 2));

// A grid pattern renders lines → luminance stddev well above a solid fill.
// WebGL is the reference; WebGPU must be within ~40% of the WebGL stddev AND
// clearly non-solid (std > 6). A solid WebGPU fill collapses std toward 0.
const flatGl = results.flat.webgl.std;
const flatGpu = results.flat.webgpu.std;
const extGl = results.extruded.webgl.std;
const extGpu = results.extruded.webgpu.std;

const flatRendersPattern = flatGpu > 6 && flatGpu > flatGl * 0.5;
const extRendersPattern = extGpu > 6 && extGpu > extGl * 0.5;
const noErrs =
  results.flat.webgpu.errs.length === 0 &&
  results.extruded.webgpu.errs.length === 0;

console.log(
  `(A) FLAT polygon renders grid pattern on WebGPU (std ${flatGpu} vs WebGL ${flatGl}): ${flatRendersPattern ? "PASS" : "FAIL"}`,
);
console.log(
  `(B) EXTRUDED polygon still renders grid pattern (std ${extGpu} vs WebGL ${extGl}): ${extRendersPattern ? "PASS" : "FAIL"}`,
);
console.log(`(C) no WebGPU device errors: ${noErrs ? "PASS" : "FAIL"}`);
const pass = flatRendersPattern && extRendersPattern && noErrs;
console.log(pass ? "GATE PASS" : "GATE FAIL");
process.exit(pass ? 0 : 1);
