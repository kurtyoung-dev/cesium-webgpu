#!/usr/bin/env node
// Probe (WEBGPU-BILLBOARD-POINT-LABEL-NO-RENDER verify): confirm Billboard /
// Point / Label collections render at a CLOSE camera on WebGPU with WebGL
// parity, after the bug-1 (bounding-volume cull) + bug-3 (disableDepthTestDistance
// inverted clip-z) fixes. Close range deliberately avoids bug-2 (surface depth
// precision at far distance / missing WebGPU log-depth), which is a separate
// documented limitation.
//
// Adds one magenta Billboard, one yellow Point, and one lime Label at a fixed
// lon/lat, flies the camera to ~600 m looking straight down, settles, then
// counts the saturated marker pixels and writes a DETERMINISTIC PNG via an
// in-evaluate canvas.toDataURL() (page.screenshot races the render loop).
//
// Usage: node Tools/visual-regression/probe-collections-closeup.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/collcloseup-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

const LON = -75.0;
const LAT = 40.0;
const ALT = 600.0; // close camera — surface depth precision is not a factor here

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ lon, lat, alt }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      const pos = C.Cartesian3.fromDegrees(lon, lat, 0.0);
      const posB = C.Cartesian3.fromDegrees(lon + 0.0015, lat, 0.0);
      const posL = C.Cartesian3.fromDegrees(lon - 0.0015, lat, 0.0);

      const bb = scene.primitives.add(new C.BillboardCollection());
      bb.add({
        position: posB,
        image: (() => {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 24;
          const g = cv.getContext("2d");
          g.fillStyle = "#ff00ff";
          g.fillRect(0, 0, 24, 24);
          return cv;
        })(),
      });

      const pts = scene.primitives.add(new C.PointPrimitiveCollection());
      pts.add({ position: pos, color: C.Color.YELLOW, pixelSize: 28 });

      const lbls = scene.primitives.add(new C.LabelCollection());
      lbls.add({
        position: posL,
        text: "X",
        fillColor: C.Color.LIME,
        font: "48px sans-serif",
      });

      scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, alt),
      });

      for (let i = 0; i < 90; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, alt),
      });
      for (let i = 0; i < 20; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const c = scene.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const data = cx.getImageData(0, 0, c.width, c.height).data;
      let magenta = 0,
        yellow = 0,
        lime = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (r > 180 && b > 180 && g < 120) magenta++;
        else if (r > 180 && g > 180 && b < 120) yellow++;
        else if (g > 180 && r < 160 && b < 120) lime++;
      }
      return {
        mode: scene.mode,
        w: c.width,
        h: c.height,
        magenta,
        yellow,
        lime,
        png: off.toDataURL("image/png"),
      };
    },
    { lon: LON, lat: LAT, alt: ALT },
  );

  const out = path.join(OUT_DIR, `collcloseup-${rendererArg}.png`);
  const b64 = result.png.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  await browser.close();

  console.log(
    `  [${rendererArg}] billboard(magenta)=${result.magenta} point(yellow)=${result.yellow} label(lime)=${result.lime} errs=${errors.length}`,
  );
  errors.slice(0, 4).forEach((e) => console.log(`      ERR: ${e}`));
  return { out, result, errors };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-collections-closeup] webgl");
  const gl = await capture("webgl");
  console.log("[probe-collections-closeup] webgpu");
  const gp = await capture("webgpu");

  const ratio = (a, b) => (a === 0 ? (b === 0 ? "1.0" : "INF") : (b / a).toFixed(2));
  console.log("\n[probe-collections-closeup] SUMMARY (saturated marker px @ close camera, 3D)");
  console.log(`  billboard: GL=${gl.result.magenta} GPU=${gp.result.magenta} ratio=${ratio(gl.result.magenta, gp.result.magenta)}`);
  console.log(`  point:     GL=${gl.result.yellow} GPU=${gp.result.yellow} ratio=${ratio(gl.result.yellow, gp.result.yellow)}`);
  console.log(`  label:     GL=${gl.result.lime} GPU=${gp.result.lime} ratio=${ratio(gl.result.lime, gp.result.lime)}`);
  console.log(`  out: ${gl.out} , ${gp.out}`);
  console.log("[probe-collections-closeup] done");
})();
