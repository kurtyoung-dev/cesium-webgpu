#!/usr/bin/env node
// DIAGNOSTIC (NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY): test whether always-on
// WebGPU auto-exposure crushes the HDR night-sky bright catalog stars. WebGL
// defaults PostProcessStageCollection._autoExposureEnabled=false; WebGPU calls
// addAutoExposure unconditionally (B.14) and WebGPUAutoExposure.enabled
// defaults true, and configure never syncs it down — so WebGPU always
// auto-exposes. On a near-black starfield that pulls bright stars toward the
// frame average (dimming them) while lifting the faint background.
//
// No rebuild: toggles scene._alternateSceneRenderer._postProcess
// .autoExposureEnabled at runtime and captures AE-on vs AE-off.
//
// Usage: node Tools/visual-regression/diag-stars-hdr-autoexposure.mjs

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
const errs = [];
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });

async function settle(n) {
  await page.evaluate(async (frames) => {
    const s = window.viewer.scene;
    for (let i = 0; i < frames; i++)
      await new Promise((r) => {
        s.requestRender();
        s.render();
        requestAnimationFrame(r);
      });
  }, n);
}

function capture(label, aeOff) {
  return page.evaluate(
    async ({ label, aeOff }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2024-01-01T03:00:00Z");
      s.skyAtmosphere.show = false;
      s.fog.enabled = false;
      s.globe.show = false;
      s.highDynamicRange = true;
      if (s.postProcessStages?.bloom) s.postProcessStages.bloom.enabled = true;
      s.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 0, 9_000_000),
        orientation: { heading: 0, pitch: C.Math.toRadians(55), roll: 0 },
      });
      // Toggle auto-exposure on the live pipeline.
      const pp = s._alternateSceneRenderer?._postProcess;
      let aeWas = null;
      if (pp) {
        aeWas = pp.autoExposureEnabled;
        if (aeOff) pp.autoExposureEnabled = false;
      }
      return new Promise((resolve) => {
        const remove = s.postRender.addEventListener(() => {
          remove();
          const c = s.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          const d = cx.getImageData(0, 0, c.width, c.height).data;
          let bright = 0,
            sat = 0,
            maxL = 0,
            sum = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = d[i] + d[i + 1] + d[i + 2];
            sum += l;
            if (l > 120) bright++;
            if (d[i] > 250 || d[i + 1] > 250 || d[i + 2] > 250) sat++;
            if (l > maxL) maxL = l;
          }
          resolve({
            label,
            aeWas,
            png: off.toDataURL("image/png"),
            bright,
            sat,
            maxL,
            meanL: (sum / (c.width * c.height) / 3).toFixed(2),
          });
        });
        s.requestRender();
        s.render();
      });
    },
    { label, aeOff },
  );
}

await settle(60);
const on = await capture("AE-on", false);
await settle(60);
const off = await capture("AE-off", true);
await settle(60);
const off2 = await capture("AE-off-settled", true);

for (const r of [on, off, off2]) {
  writeFileSync(
    join(OUT, `stars-hdr-${r.label}.png`),
    Buffer.from(r.png.split(",")[1], "base64"),
  );
  console.log(
    `${r.label.padEnd(16)} bright(>120)=${r.bright}  saturated=${r.sat}  maxLum=${r.maxL}  meanLum=${r.meanL}  (aeWas=${r.aeWas})`,
  );
}
console.log(`errors=${errs.length}`);
errs.slice(0, 4).forEach((e) => console.log("  ERR:", e.slice(0, 140)));
await browser.close();
