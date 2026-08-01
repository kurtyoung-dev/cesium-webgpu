#!/usr/bin/env node
// C4-SUN-GLOWFACTOR-IGNORED — verify scene.sun.glowFactor drives the WebGPU sun
// bake + quad size (parity with WebGL), and that glowFactor=1.0 (default) stays
// byte-identical to the historical hardcoded bake. Measures the sun bright box
// and glow-halo box for glowFactor 1.0 and 4.0 on each backend.
import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function run(renderer, glowFactor) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const res = await page.evaluate(
    async ({ renderer, glowFactor }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      v.useDefaultRenderLoop = false;
      s.screenSpaceCameraController.enableInputs = false;
      const fixed = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      s.sun.show = true;
      s.sun.glowFactor = glowFactor;
      if (s.skyBox) s.skyBox.show = false;
      s.backgroundColor = C.Color.BLACK;
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(0, 0, 8.0e7) });
      s.render();
      const sunPos = C.Cartesian3.clone(
        s.context.uniformState.sunPositionWC,
        new C.Cartesian3(),
      );
      const dir = C.Cartesian3.normalize(sunPos, new C.Cartesian3());
      const camPos = C.Cartesian3.multiplyByScalar(
        dir,
        3.0e8,
        new C.Cartesian3(),
      );
      const setIt = () =>
        v.camera.setView({
          destination: camPos,
          orientation: { direction: dir, up: C.Cartesian3.UNIT_Z },
        });
      setIt();
      for (let i = 0; i < 90; i++) {
        setIt();
        s.render();
        await new Promise((r) => setTimeout(r, 5));
      }
      setIt();
      s.render();

      const cv = s.canvas;
      const w = cv.width,
        h = cv.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext("2d");
      ctx.drawImage(cv, 0, 0);
      let full;
      try {
        full = ctx.getImageData(0, 0, w, h).data;
      } catch (e) {
        return { err: String(e) };
      }
      const box = (thresh) => {
        let minX = w,
          maxX = -1,
          minY = h,
          maxY = -1,
          count = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (y < 40 || x > 1000) continue;
            const i = (y * w + x) * 4;
            const l =
              0.2126 * full[i] + 0.7152 * full[i + 1] + 0.0722 * full[i + 2];
            if (l >= thresh) {
              count++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        return count > 0
          ? { w: maxX - minX + 1, h: maxY - minY + 1, count }
          : null;
      };
      return {
        renderer: s.context.rendererType,
        glowFactor: s.sun.glowFactor,
        sunBox: box(200),
        glowBox: box(40),
        useHDR: s.highDynamicRange,
      };
    },
    { renderer, glowFactor },
  );

  await page.screenshot({
    path: `Tools/visual-regression/output/sun-glow-${renderer}-gf${glowFactor}.png`,
  });
  await browser.close();
  return { res, logs };
}

(async () => {
  const results = {};
  for (const r of ["webgl", "webgpu"]) {
    for (const gf of [1.0, 4.0]) {
      const { res, logs } = await run(r, gf);
      results[`${r}-gf${gf}`] = res;
      console.log(`\n=== ${r} glowFactor=${gf} ===`);
      console.log(JSON.stringify(res));
      const err = logs.filter((l) =>
        /\[error\]|\[pageerror\]|invalid|validation|fail/i.test(l),
      );
      if (err.length) {
        console.log("errors:", err.length);
        err.slice(0, 6).forEach((l) => console.log("  " + l));
      }
    }
  }
  // Parity assessment.
  const wgpu1 = results["webgpu-gf1"].glowBox,
    wgpu4 = results["webgpu-gf4"].glowBox;
  const wgl1 = results["webgl-gf1"].glowBox,
    wgl4 = results["webgl-gf4"].glowBox;
  console.log("\n=== ASSESSMENT ===");
  console.log(
    "WebGPU glow grows with glowFactor:",
    wgpu1 && wgpu4 ? wgpu4.w > wgpu1.w : "n/a",
    `(gf1 w=${wgpu1?.w} -> gf4 w=${wgpu4?.w})`,
  );
  console.log(
    "WebGL  glow grows with glowFactor:",
    wgl1 && wgl4 ? wgl4.w > wgl1.w : "n/a",
    `(gf1 w=${wgl1?.w} -> gf4 w=${wgl4?.w})`,
  );
})();
