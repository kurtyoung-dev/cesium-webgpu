#!/usr/bin/env node
// Probe (MORPH-COLLECTIONS-AUDIT, disambiguation): does WebGPU render
// billboard / point / label via the ENTITY API (the normal user path) in 3D /
// 2D / CV? The raw-primitive-collection probe (probe-collections-2dcv-morph.mjs)
// showed them missing even in 3D on WebGPU while WebGL shows them — this isolates
// whether that is a real renderer gap or specific to dynamically-added raw
// collections. Uses viewer.entities (the viewer's own DataSourceDisplay, same
// module instance) so there is no dual-module ambiguity.
// @purpose Disambiguation probe: do markers render via the entity API where dynamically-added raw collections did not, per mode and backend.
// @status INVESTIGATION
//
// Out: output/collent-{3d,2d,cv}-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const MODES = [
  { name: "3d", id: 3 },
  { name: "2d", id: 2 },
  { name: "cv", id: 1 },
];
const LON = -75.0;
const LAT = 40.0;

async function capture(rendererArg, mode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  const stats = await page.evaluate(
    async ({ modeId, lon, lat }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const img = (() => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 24;
        const g = cv.getContext("2d");
        g.fillStyle = "#ff00ff";
        g.fillRect(0, 0, 24, 24);
        return cv.toDataURL();
      })();
      // ENTITY API — the viewer's DataSourceDisplay builds the billboard/point/
      // label collections internally with the correct module/context.
      v.entities.add({
        position: C.Cartesian3.fromDegrees(lon, lat + 0.25, 0),
        billboard: { image: img, scale: 1.0 },
      });
      v.entities.add({
        position: C.Cartesian3.fromDegrees(lon + 0.25, lat, 0),
        point: { pixelSize: 24, color: C.Color.YELLOW },
      });
      v.entities.add({
        position: C.Cartesian3.fromDegrees(lon, lat - 0.35, 0),
        label: {
          text: "TEST",
          fillColor: C.Color.LIME,
          font: "32px sans-serif",
        },
      });

      if (modeId === 1) scene.morphToColumbusView(0);
      else if (modeId === 2) scene.morphTo2D(0);
      else scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 1200000.0),
      });
      for (let i = 0; i < 150; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 1200000.0),
      });
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const c = scene.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let magenta = 0,
        yellow = 0,
        lime = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        if (r > 180 && b > 180 && g < 120) magenta++;
        else if (r > 180 && g > 180 && b < 120) yellow++;
        else if (g > 180 && r < 160 && b < 120) lime++;
      }
      return {
        mode: scene.mode,
        magenta,
        yellow,
        lime,
        dataUrl: c.toDataURL("image/png"),
      };
    },
    { modeId: mode.id, lon: LON, lat: LAT },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `collent-${mode.name}-${rendererArg}.png`);
  fs.writeFileSync(out, Buffer.from(stats.dataUrl.split(",")[1], "base64"));
  await browser.close();
  console.log(
    `  [${rendererArg}/${mode.name}] bb=${stats.magenta} pt=${stats.yellow} lbl=${stats.lime} errs=${errors.length}`,
  );
  errors.slice(0, 3).forEach((e) => console.log(`     ERR: ${e}`));
  return stats;
}

(async () => {
  for (const mode of MODES) {
    for (const r of ["webgl", "webgpu"]) await capture(r, mode);
  }
  console.log(
    "[probe-collections-entity] done — READ the PNGs (collent-*.png)",
  );
})();
