#!/usr/bin/env node
// Diagnostic: is the billboard's CV failure a STEADY-state gap (instant morph,
// SceneMode.MORPHING never entered) or a morph-transition gap? Render a single
// LARGE magenta billboard at 50km, globe OFF, in steady 3D / 2D / CV (instant
// morphs), and report magenta coverage. If CV is 0 here, it's the Slice-2b
// steady billboard-in-CV gap, NOT a morph-blend gap.
// @purpose Reproducer measuring magenta billboard coverage in steady 3D/2D/CV, globe off — bisects the billboard quad-size parity defect vs morph gaps.
// @status ACTIVE
//
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0,
  LAT = 40.0,
  H = 50000.0;

async function run(rendererArg, modeName, modeFn) {
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

  const out = await page.evaluate(
    async ({ modeName, lon, lat, h }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.requestRenderMode = false;
      scene.globe.show = false;

      // LARGE billboard (64px) so detection is robust.
      const bb = scene.primitives.add(new C.BillboardCollection());
      bb.add({
        position: C.Cartesian3.fromDegrees(lon, lat, h),
        image: (() => {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 64;
          const g = cv.getContext("2d");
          g.fillStyle = "#ff00ff";
          g.fillRect(0, 0, 64, 64);
          return cv;
        })(),
      });

      if (modeName === "2d") scene.morphTo2D(0);
      else if (modeName === "cv") scene.morphToColumbusView(0);
      else scene.morphTo3D(0);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 8000000.0),
      });
      for (let i = 0; i < 90; i++) {
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
      let magenta = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] > 180 && data[i + 2] > 180 && data[i + 1] < 120) magenta++;
      return { magenta, mode: scene.mode };
    },
    { modeName, lon: LON, lat: LAT, h: H },
  );

  await browser.close();
  console.log(
    `  ${rendererArg}/${modeName} -> magenta=${out.magenta} (mode=${out.mode}) errs=${errors.length}`,
  );
  return out.magenta;
}

console.log("Large billboard @ 50km, globe OFF, steady modes (instant morph):");
for (const m of ["3d", "2d", "cv"]) {
  await run("webgl", m);
  await run("webgpu", m);
}
